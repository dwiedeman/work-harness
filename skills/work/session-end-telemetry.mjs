#!/usr/bin/env node
// SessionEnd hook — /work token telemetry that CANNOT be forgotten (H10-detail, 2026-07-26).
//
// Why: the §7 nonce recipe required each orch/shepherd to remember to self-report, raced transcript
// flushes, and silently reported NOTHING when transcript persistence was off — three orchestrators
// and four shepherds across two runs recorded ZERO spend, so every run total is a floor. This hook
// fires when the session ends, keys on `--session-id` (no nonce, no race), and appends the
// token_usage event straight to the run ledger the session belonged to.
//
// Scope guard: does nothing unless the session carries WORK_ROLE + WORK_RUN_DIR (injected
// by work-runner's launch prefixes for orch/shepherd/leads). Every other Claude session exits in <5ms.
// Leads also emit at hand-off per their brief; the aggregator dedups by report_id (MAX per id), so
// the double report is safe — this catches the lead that DIES before reporting.
//
// Never blocks session exit: every failure path exits 0 silently. The run-end `usage --run` pass is
// where absence gets noticed (orch rows == 0 → this hook is broken or unregistered — check
// `preflight`'s telemetry-hooks line).

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { UNIT_ID_RE } from "./work-runner.mjs";

// DER-2747 — a lead's cwd IS its worktree, named exactly `<worktreeRoot>/<runId>/<unitId>` (see
// work-runner.mjs's `wt = join(worktreeRoot, runId, issueId)` — no slug/suffix is ever appended, for
// any lead type: plain issue, bundled, spec-mode unit, or a rotated/kicked-back lead reusing its
// original worktree). The trailing path segment is therefore the canonical unit id, verbatim.
//
// Matching it against `UNIT_ID_RE` — imported from work-runner.mjs rather than re-derived here — is
// the fix: that grammar already accepts BOTH classic Linear ids (`DER-1234`) and spec-mode unit ids
// (`SPEC-<slug>-U<n>`), and importing it (instead of hand-rolling a second regex) means the hook and
// the runner cannot drift apart. The previous ad hoc `\b([A-Z]{2,6}-\d+)\b`:
//   (a) only matched classic `ABC-123` ids, so every `SPEC-<slug>-U<n>` spec-mode worktree matched
//       NOTHING — the emitted `token_usage` event carried no `issue`, and `materializeState` silently
//       drops any event with `!e.issue` before per-unit budget accounting, so spec-mode runs lost ALL
//       per-unit token attribution; and
//   (b) searched the WHOLE cwd string (not just the basename it actually names the unit with), so a
//       path that happened to contain an id-shaped segment earlier on (e.g. `.../DER-9999/runs/...`)
//       could misattribute spend to the wrong issue entirely.
//
// A bundled lead's worktree path is still just the PRIMARY issue id (bundle membership lives in the
// `worktree_created` event's `bundle` array, not the path), so it needs no separate branch here — it's
// already covered by the plain-issue case. An unrecognized basename (any non-lead workspace, or a
// malformed/foreign directory) comes back `null` — a clearly-marked "no attribution", never a guess.
export function deriveUnitId(cwd) {
  const segments = String(cwd ?? "").split(/[\\/]+/).filter(Boolean);
  const base = segments[segments.length - 1] ?? "";
  return UNIT_ID_RE.test(base) ? base : null;
}

// Guarded exactly like work-runner.mjs's own CLI entrypoint: run the hook body only when this file is
// executed directly (as Claude Code's SessionEnd hook does), never on `import` — otherwise every one
// of the `process.exit(0)` early-outs below would kill the process the instant a test imported this
// module for `deriveUnitId`, before any assertion ever ran.
function main() {
  try {
    const role = (process.env.WORK_ROLE ?? process.env.ROST_WORK_ROLE);
    const runDir = (process.env.WORK_RUN_DIR ?? process.env.ROST_WORK_RUN_DIR);
    if (!role || !runDir || !existsSync(runDir)) process.exit(0);

    let input = {};
    try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
    const sessionId = input.session_id;
    const cwd = input.cwd || process.cwd();
    if (!sessionId) process.exit(0);

    const script = join(cwd, "scripts", "session-token-report.mjs");
    if (!existsSync(script)) process.exit(0);

    const args = [script, "--role", role, "--session-id", sessionId, "--format", "event"];
    // A lead's cwd is its worktree, named after the unit id — attribute the spend to it (DER-2747:
    // this must recognize spec-mode unit ids too, not just classic Linear ids — see deriveUnitId above).
    const issue = deriveUnitId(cwd);
    if (issue && role === "lead") args.push("--issues", issue);

    const out = execFileSync("node", args, { cwd, timeout: 30000, encoding: "utf8" }).trim();
    const line = out.split("\n").filter(Boolean).pop() ?? "";
    const event = JSON.parse(line.replace(/^WORK-EVENT\s*/, ""));
    if (!event || event.type !== "token_usage") process.exit(0);
    if (!event.ts) event.ts = new Date().toISOString();
    appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Telemetry must never block a session from exiting.
  }
  process.exit(0);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main();
}
