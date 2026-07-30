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
import { fileURLToPath } from "node:url";

function settingsModel() {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    return String(s.model || "");
  } catch {
    return "";
  }
}

// DER-2581 — models whose context window is 1,000,000 tokens NATIVELY (no `[1m]` opt-in needed): the
// Sonnet 5 / Opus 5 / Fable 5 generation, and Opus 4.6-4.8. This is an explicit allow-list, not a loose
// substring test — SKILL.md already records the INVERSE error (a 270K `gpt-5.6-sol` lead once misread
// as a 1M window, masking a lead sitting at 102% of its real capacity), and a pattern that drifts wide
// reproduces that failure in the other direction. `\b` boundaries keep `sonnet-4-5` (Sonnet 4.5, 200K)
// from matching as `sonnet-5`.
const NATIVE_1M_MODELS = /\b(?:opus|sonnet|fable)-5\b|\bopus-4-[678]\b/;

export function is1MWindow(modelStr) {
  const m = String(modelStr || "");
  if (!m) return false;
  return m.includes("[1m]") || NATIVE_1M_MODELS.test(m);
}

// DER-2581 — this banner over-read orch/shepherd sessions vs `state.session_context`: the observed
// model on the LAST usage-bearing transcript line is not always the session's own — a background
// subagent's usage record can be the most recent "usage" line in the same transcript file, and its
// model tells you nothing about the parent session's window. When that line's model doesn't resolve,
// the OLD fallback re-tested `settingsModel()` for the "[1m]" MARKER ONLY, never for a model that is
// natively 1M with no marker — so a session whose own settings.json correctly said `claude-sonnet-5`
// still fell through to the 200K default (164K tokens read as 82% instead of ~16%, from tonight's log).
// Both signals now run through the identical classifier, aligned with work-runner's
// resolveContextWindow (DER-2547): the observed model id is the strongest evidence there is, and the
// settings.json read is the fallback for when it doesn't resolve — never a WEAKER test than the primary.
export function contextWindowFor(transcriptModel, settingsModelStr) {
  if (process.env.WRAP_NUDGE_WINDOW) return Number(process.env.WRAP_NUDGE_WINDOW);
  if (is1MWindow(transcriptModel)) return 1_000_000; // the running session's own id — strongest evidence
  if (is1MWindow(settingsModelStr ?? settingsModel())) return 1_000_000; // same test, same evidence class
  return 200_000;
}

export function bandsFor(windowTokens) {
  const gentle = Number(process.env.WRAP_NUDGE_GENTLE || (windowTokens >= 1_000_000 ? 30 : 60));
  const strong = Number(process.env.WRAP_NUDGE_STRONG || (windowTokens >= 1_000_000 ? 45 : 80));
  return [
    { pct: strong, key: "strong" },
    { pct: gentle, key: "gentle" },
  ];
}

function main() {
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
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main();
}
