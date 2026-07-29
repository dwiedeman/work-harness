#!/usr/bin/env node
// context-wrap-nudge.mjs — UserPromptSubmit hook (DER-1994).
// Estimates session context utilization from the transcript's most recent assistant usage
// record and, past a gentle/strong band, injects additionalContext so Claude proactively
// suggests /wrap (or the /work role's mid-run handoff) at the next natural task boundary.
// Rationale (2026-07-17 research): event-triggered handoff beats percentage triggers, so this
// nudge asks Claude to pick the boundary — the percentage only arms it. Fails open: any
// error → no output, exit 0. Disable with WRAP_NUDGE_DISABLE=1.
//
// Bands scale with the window: on ≥1M-token windows quality degrades well before high
// utilization (effective context ≈ 300–450K), so the bands sit lower there.
// Overrides: WRAP_NUDGE_WINDOW (tokens), WRAP_NUDGE_GENTLE / WRAP_NUDGE_STRONG (percent).

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

function settingsModel() {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    return String(s.model || "");
  } catch {
    return "";
  }
}

// DER-2581 — this banner over-read orch/shepherd sessions ~1.8x against `state.session_context`, and the
// standing advice became "trust the ledger, NOT the banner". Two readers of the same transcript should
// never need that advice; the arithmetic was identical, so the divergence was here, in the WINDOW.
// Aligned with work-runner's resolveContextWindow (DER-2547): the observed model id carries the `[1m]`
// opt-in when the session actually has it, and that beats a settings.json read, which can describe a
// different host or a since-changed setting.
function contextWindowFor(transcriptModel) {
  if (process.env.WRAP_NUDGE_WINDOW) return Number(process.env.WRAP_NUDGE_WINDOW);
  const m = String(transcriptModel || "");
  if (m.includes("[1m]")) return 1_000_000; // the running session's own id — strongest evidence
  if (/sonnet-5/.test(m)) return 1_000_000; // native 1M
  // [1m] extended-context opt-in also lives in settings, for ids that don't carry the marker
  if (settingsModel().includes("[1m]")) return 1_000_000;
  return 200_000;
}

function bandsFor(windowTokens) {
  const gentle = Number(process.env.WRAP_NUDGE_GENTLE || (windowTokens >= 1_000_000 ? 30 : 60));
  const strong = Number(process.env.WRAP_NUDGE_STRONG || (windowTokens >= 1_000_000 ? 45 : 80));
  return [
    { pct: strong, key: "strong" },
    { pct: gentle, key: "gentle" },
  ];
}

try {
  if (process.env.WRAP_NUDGE_DISABLE === "1") process.exit(0);
  const input = JSON.parse(readFileSync(0, "utf8"));
  const tp = input.transcript_path;
  if (!tp || !existsSync(tp)) process.exit(0);

  const lines = readFileSync(tp, "utf8").split("\n");
  let usage = null;
  let model = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const e = JSON.parse(lines[i]);
      const u = e?.message?.usage;
      if (u && u.input_tokens != null) {
        // Skip `<synthetic>` turns (API-error records). They carry a usage block but no real model id,
        // so the window resolves off the wrong evidence — the other two readers of this transcript
        // (work-runner's readContextUsage, session-context-report) already skip them. This asymmetry is
        // the remaining half of DER-2581's banner-vs-ledger divergence.
        if ((e.message.model || "") === "<synthetic>") continue;
        usage = u;
        model = e.message.model || "";
        break;
      }
    } catch {
      // unparsable line — keep scanning
    }
  }
  if (!usage) process.exit(0);

  const used =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  const windowTokens = contextWindowFor(model);
  const pct = Math.round((used / windowTokens) * 100);
  const band = bandsFor(windowTokens).find((b) => pct >= b.pct);
  if (!band) process.exit(0);

  // Fire once per band per session.
  const stateDir = join(tmpdir(), "claude-wrap-nudge");
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, `${input.session_id || "unknown"}-${band.key}.done`);
  if (existsSync(stateFile)) process.exit(0);
  writeFileSync(stateFile, `${pct}% of ${windowTokens}`);

  const role = (process.env.WORK_ROLE ?? process.env.ROST_WORK_ROLE);
  const ask =
    role === "shepherd"
      ? `this is a /work shepherd session — follow the skill's mid-run handoff: refresh shepherd-notes.md from gh + the ledger, append a rotate_requested event + nudge the run, then KEEP working until the orchestrator rotates you`
      : role === "orch"
        ? `this is a /work orchestrator session — follow the skill's rotation (§4): refresh orch-handoff.md from ground truth (ledger/gh/Linear), spawn-orch a successor (/work resume), confirm its orch_resumed event, then stand down`
        : role === "lead"
          ? `this is a /work LEAD session — follow the /work-lead skill's "Context rotation" section: (1) commit your WIP (rotation preserves only what is COMMITTED), (2) write the handoff note to $WORK_RUN_DIR/handoffs/<ID>.rot<n>.md — disposition CLOSEOUT|CONTINUE, state of work, verification already run, traps/dead-ends you already ruled out, open threads — keep it under ~2KB, (3) append {"actor":"lead","type":"rotate_requested","issue":"<ID>","pct":<pct>,"disposition":"<CLOSEOUT|CONTINUE>"} to the ledger, (4) nudge the run, then (5) KEEP WORKING until the orchestrator closes you — never idle-wait on the rotation`
          : role
            ? `this is a /work ${role} session — follow the skill's mid-run handoff: refresh the handoff file from ground truth (ledger/gh/Linear), then hand the run to a fresh session`
            : `recommend running /wrap so the session hands off cleanly (docs sync, commit, turnover message) instead of degrading`;
  const urgency =
    band.key === "strong"
      ? "Context is deep enough that quality degradation is likely — finish the current step, then wrap; do not start new multi-step work in this session."
      : "Do not interrupt mid-task, but raise it at the next natural boundary (current task finished or about to switch topics).";
  const msg =
    `[context-wrap-nudge] Session context ≈ ${pct}% of the ${Math.round(windowTokens / 1000)}K-token window ` +
    `(~${Math.round(used / 1000)}K tokens, from transcript usage). ${urgency} ` +
    `When you do: ${ask}. Surface this to the user explicitly — they asked to be prompted rather than having to remember.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: msg },
    })
  );
  process.exit(0);
} catch {
  process.exit(0);
}
