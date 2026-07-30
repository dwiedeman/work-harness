#!/usr/bin/env node
// PostToolUse hook (throttled) — continuous context reporting for EVERY /work session (operator ask
// 2026-07-26: "make sure ALL sessions are reporting context — cloud, leads, lead subagents,
// shepherds, orchestrators, originals after rotation").
//
// The pull-based probe (`lead-context`) reads lead transcripts by WORKTREE, so it structurally
// cannot see the orchestrator or the shepherd (both live in the repo root, sharing one project dir),
// and it reads nothing between probes. This hook is the push side: each session reports its OWN
// utilization from its OWN transcript (the hook input carries the exact transcript_path — no
// newest-file guessing, the trap that made nonce-matching necessary). Coverage matrix after this:
//   local/mini leads … lead-context probe (pull) + this hook (push)
//   lead subagents  … lead-context subagent scan (pull)
//   orch/shepherd   … this hook (push) — previously ZERO coverage
//   rotated-out originals … this hook keeps firing until the workspace closes
//   cloud leads     … self-reported pct via WORK-EVENT comments + head-age (H9) — no disk here
//
// Throttle: at most one report per session per 5 minutes (marker file mtime). Scope-guarded by
// WORK_ROLE/RUN_DIR like the SessionEnd hook; all failures exit 0 silently.

import { readFileSync, writeFileSync, appendFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const THROTTLE_MS = 5 * 60 * 1000;

// DER-2581, third instrument. Deliberately DUPLICATED from work-runner.mjs's `is1MWindow` rather than
// imported: this is a PostToolUse hook, so it is spawned on every tool call, and importing a 4,900-line
// module to answer one predicate would put that parse on the critical path of every tool use. The
// duplication is pinned by a test that asserts all three copies (here, work-runner, context-wrap-nudge)
// agree across a shared table of model ids — so drift fails CI instead of silently reappearing here.
const NATIVE_1M_MODELS = /sonnet-5|opus-5|fable-5|opus-4-[678]/;
export function is1MWindow(model) {
  const m = String(model || "");
  return m.length > 0 && (m.includes("[1m]") || NATIVE_1M_MODELS.test(m));
}

function main() {
try {
  const role = (process.env.WORK_ROLE ?? process.env.ROST_WORK_ROLE);
  const runDir = (process.env.WORK_RUN_DIR ?? process.env.ROST_WORK_RUN_DIR);
  if (!role || !runDir || !existsSync(runDir)) process.exit(0);

  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
  const transcript = input.transcript_path;
  const sessionId = input.session_id ?? "unknown";
  if (!transcript || !existsSync(transcript)) process.exit(0);

  const marker = join(runDir, `.ctx-${sessionId.slice(0, 12)}`);
  try {
    if (Date.now() - statSync(marker).mtimeMs < THROTTLE_MS) process.exit(0);
  } catch { /* first report */ }

  // Read the transcript TAIL only (a long session's file is tens of MB).
  const size = statSync(transcript).size;
  const span = Math.min(size, 256 * 1024);
  const fd = openSync(transcript, "r");
  const buf = Buffer.alloc(span);
  readSync(fd, buf, 0, span, size - span);
  closeSync(fd);
  const lines = buf.toString("utf8").split("\n").filter((l) => l.includes('"usage"'));
  let used = null;
  let model = null;
  for (let i = lines.length - 1; i >= 0 && used == null; i -= 1) {
    try {
      const e = JSON.parse(lines[i]);
      const u = e?.message?.usage;
      if (!u) continue;
      used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      model = e?.message?.model ?? null;
    } catch { /* torn tail line — try the previous one */ }
  }
  if (used == null) process.exit(0);

  // Window: ONLY claimed for orch/shepherd, which inherit the operator's settings model — a lead is
  // launched with its own --model/lead-type and its true window lives in the lead-type config the
  // pull probe (`lead-context`) already resolves. Guessing here is the exact lying-instrument bug
  // this run kept finding (a 270K-window lead once read as 28% because a hook believed 1M): when we
  // don't KNOW the window, report window:null and no pct — `used` alone is still a real signal.
  let window = null;
  if (role === "orch" || role === "shepherd") {
    try {
      const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
      const m = String(s?.model ?? "");
      // Marker-only used to mean a natively-1M orch/shepherd reported 200K here while `lead-context`
      // reported 1M for the same session — the two instruments disagreeing is exactly DER-2581.
      if (m) window = is1MWindow(m) ? 1_000_000 : 200_000;
    } catch { /* stays null */ }
  }
  const issue = (String(input.cwd ?? "").match(/\b([A-Z]{2,6}-\d+)\b/) ?? [])[1] ?? null;

  const event = {
    actor: issue && role === "lead" ? `lead:${issue}` : role,
    type: "context_report",
    role,
    used,
    window,
    pct: window ? Math.round((used / window) * 100) : null,
    model,
    session: sessionId.slice(0, 12),
    ts: new Date().toISOString(),
  };
  if (issue && role === "lead") event.issue = issue;
  appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  writeFileSync(marker, String(Date.now()), "utf8");
} catch {
  // Context telemetry must never break a tool call.
}
process.exit(0);
}

// Only run as a hook, never on import: the body above exits the process on every early-out path, so an
// unguarded import kills whatever imported it — which is how a test file for this logic would silently
// pass having asserted nothing (DER-2747's second defect, same shape, third file).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
