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
  // A lead's cwd is its worktree, named after the issue — attribute the spend to it.
  const issue = (cwd.match(/\b([A-Z]{2,6}-\d+)\b/) ?? [])[1];
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
