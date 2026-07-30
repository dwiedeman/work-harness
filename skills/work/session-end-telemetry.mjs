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
// Never blocks a session from exiting — but never exits SILENTLY either (DER-2745). It used to resolve
// its reporter at `<cwd>/scripts/session-token-report.mjs` (a path in the CONSUMING repo), and
// `if (!existsSync(script)) process.exit(0)`. This harness ships no `scripts/` dir and neither does a
// fresh adopter, so outside the one repo that happened to have its own copy the hook found nothing, said
// nothing, and appended nothing — and "no token_usage event" is byte-for-byte what a session that spent
// zero looks like. Every downstream number (`usage`, `work-metrics`, per-unit budget accounting, the
// budget circuit breaker) was then an undercount with no signal that anything was missing.
//
// Two-part fix:
//   1. the harness now SHIPS `session-token-report.mjs` beside this hook, so a fresh install measures
//      real spend; a consumer repo's own `scripts/session-token-report.mjs` still WINS when present
//      (that is the path every brief names, and adopters like ROST already have one), and
//      `WORK_TOKEN_REPORT` overrides both;
//   2. every remaining way this can produce no number — unresolvable reporter, crashing reporter,
//      unparseable output, wrong event type, an event the fold cannot use — appends a durable
//      `telemetry_gap` event to the run ledger and writes one line to stderr. LOUD means recorded: the
//      hook still exits 0, because a SessionEnd hook that throws would take the session with it.
//
// The rule underneath both: an ABSENT measurement must never render as a measured zero.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { UNIT_ID_RE } from "./work-runner.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const HOOK_DIR = dirname(THIS_FILE);

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

// Where the token reporter is, in trust order — and, when it is nowhere, a clearly-marked unresolved
// answer that NAMES every path it looked at, so the gap event can say what was missing instead of just
// "no telemetry" (DER-2745). Pure: `exists` is injected so resolution order is testable without a
// filesystem.
//
//   1. `WORK_TOKEN_REPORT` — an explicit operator override. If it is set and missing, resolution STOPS:
//      falling through to another candidate would silently ignore a deliberate configuration, and the
//      operator would never learn that the reporter they pointed at isn't there.
//   2. `<cwd>/scripts/session-token-report.mjs` — the CONSUMER repo's own copy. First because it is the
//      path every brief and SKILL.md recipe names, and a repo that ships one may compute spend its own
//      way (extra models, a private price table). Shipping ours must not hijack theirs.
//   3. `<this hook's dir>/session-token-report.mjs` — the copy the harness now SHIPS. Resolved relative
//      to this module, not to the session's cwd, so it is found from any worktree and wherever
//      install.sh put the skill.
export function resolveReporter({ cwd, hookDir = HOOK_DIR, env = process.env, exists = existsSync } = {}) {
  const override = env.WORK_TOKEN_REPORT ?? env.ROST_WORK_TOKEN_REPORT;
  if (override) {
    return exists(override)
      ? { path: override, source: "override", searched: [override] }
      : { path: null, source: "override_missing", searched: [override] };
  }
  const searched = [];
  const repoCopy = join(cwd ?? ".", "scripts", "session-token-report.mjs");
  searched.push(repoCopy);
  if (exists(repoCopy)) return { path: repoCopy, source: "repo", searched };
  const shipped = join(hookDir, "session-token-report.mjs");
  searched.push(shipped);
  if (exists(shipped)) return { path: shipped, source: "shipped", searched };
  return { path: null, source: "unresolved", searched };
}

const oneLine = (s, max = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// The LOUD half of the fix. A missing measurement becomes a durable ledger record — greppable, foldable,
// and impossible to confuse with a measured zero — plus one stderr line for the hook log. Both are
// wrapped: a telemetry gap must not become a session-ending exception.
function recordGap(runDir, fields) {
  const event = {
    actor: fields.issue && fields.role === "lead" ? `lead:${fields.issue}` : (fields.role ?? "unknown"),
    type: "telemetry_gap",
    signal: "token_usage_missing",
    ts: new Date().toISOString(),
    ...fields,
    detail: oneLine(fields.detail),
  };
  try {
    appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  } catch { /* the ledger itself is unwritable — stderr below is all that is left */ }
  try {
    process.stderr.write(
      `session-end-telemetry: NO token report recorded (${event.reason}) — reporter=${event.reporter ?? "none"} — ${event.detail}\n`,
    );
  } catch { /* nothing more to try */ }
}

// Guarded exactly like work-runner.mjs's own CLI entrypoint: run the hook body only when this file is
// executed directly (as Claude Code's SessionEnd hook does), never on `import` — otherwise every one
// of the `process.exit(0)` early-outs below would kill the process the instant a test imported this
// module for `deriveUnitId`, before any assertion ever ran.
function main() {
  try {
    const role = (process.env.WORK_ROLE ?? process.env.ROST_WORK_ROLE);
    const runDir = (process.env.WORK_RUN_DIR ?? process.env.ROST_WORK_RUN_DIR);
    // Scope guard, NOT a failure path: a session with no WORK_ROLE/WORK_RUN_DIR is somebody's ordinary
    // Claude session and owes this harness nothing. There is no ledger to be loud in, either.
    if (!role || !runDir || !existsSync(runDir)) process.exit(0);

    let input = {};
    try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
    const sessionId = input.session_id;
    const cwd = input.cwd || process.cwd();
    if (!sessionId) process.exit(0);

    // A lead's cwd is its worktree, named after the unit id — attribute the spend to it (DER-2747:
    // this must recognize spec-mode unit ids too, not just classic Linear ids — see deriveUnitId above).
    const issue = deriveUnitId(cwd);
    const gap = (reason, detail, reporter = null) => recordGap(runDir, {
      role,
      issue: issue && role === "lead" ? issue : undefined,
      session: String(sessionId).slice(0, 12),
      reason,
      reporter,
      detail,
    });

    const reporter = resolveReporter({ cwd });
    if (!reporter.path) {
      gap(
        reporter.source === "override_missing" ? "reporter_override_missing" : "reporter_unresolved",
        `no session-token-report.mjs at any of: ${reporter.searched.join(", ")}. This session's token spend is UNKNOWN, not zero.`,
        reporter.searched[0] ?? null,
      );
      process.exit(0);
    }

    const args = [reporter.path, "--role", role, "--session-id", sessionId, "--format", "event"];
    if (issue && role === "lead") args.push("--issues", issue);
    // Claude Code hands SessionEnd the exact transcript path, which beats resolving it by session id —
    // but only the reporter WE ship is known to accept `--transcript`. A consumer's copy (or an operator
    // override) has its own CLI, so it keeps getting exactly the flags it always got; passing a flag an
    // unknown script doesn't know would turn a working reporter into a crashing one.
    if (reporter.source === "shipped" && input.transcript_path && existsSync(input.transcript_path)) {
      args.push("--transcript", input.transcript_path);
    }

    let out = "";
    try {
      out = execFileSync("node", args, {
        cwd,
        timeout: 30000,
        encoding: "utf8",
        // stdin is /dev/null: this process already consumed fd 0, and a child inheriting it would hang
        // the session's exit. stderr is captured so a crashing reporter's own words reach the ledger.
        stdio: ["ignore", "pipe", "pipe"],
      }) ?? "";
    } catch (err) {
      const why = oneLine(err?.stderr) || oneLine(err?.message) || "no diagnostic";
      gap("reporter_failed", `reporter exited ${err?.status ?? "abnormally"}${err?.signal ? ` (signal ${err.signal})` : ""}: ${why}`, reporter.path);
      process.exit(0);
    }

    // Take the LAST marker line (a human-formatted reporter prints a summary after it); fall back to the
    // last non-empty line so an older reporter that omits the marker still folds.
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const line = lines.filter((l) => l.startsWith("WORK-EVENT")).pop() ?? lines.pop() ?? "";
    let event = null;
    try { event = JSON.parse(line.replace(/^WORK-EVENT\s*/, "")); } catch { /* handled below */ }
    if (!event || typeof event !== "object" || !event.type) {
      gap("reporter_output_invalid", `reporter printed no parseable WORK-EVENT: ${oneLine(out) || "(no output at all)"}`, reporter.path);
      process.exit(0);
    }
    if (event.type !== "token_usage") {
      gap("reporter_wrong_event_type", `reporter emitted type "${event.type}" where token_usage was required`, reporter.path);
      process.exit(0);
    }

    if (!event.ts) event.ts = new Date().toISOString();
    // Attribution belt-and-braces: `materializeState` drops any event without `issue`, so a reporter
    // that ignored `--issues` would cost this unit its entire per-unit accounting.
    if (issue && role === "lead" && !event.issue) event.issue = issue;
    // Provenance, for the next person debugging an undercount: which of the three reporters produced it.
    if (!event.reporter_source) event.reporter_source = reporter.source;
    appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");

    // A `token_usage` with no `by_model` is folded by NOTHING (`aggregateTokenUsage` and
    // `foldTokenUsage` both skip it) — it reads as a report that was made and counted while contributing
    // zero. Keep the reporter's word in the ledger AND book the gap.
    if (!event.by_model || typeof event.by_model !== "object" || !Object.keys(event.by_model).length) {
      gap("reporter_event_unfoldable", `reporter emitted a token_usage with no by_model — the usage fold skips it, so this session contributes 0`, reporter.path);
    }
  } catch (err) {
    // Absolute last resort. Telemetry must never block a session from exiting, but it must not vanish
    // without a trace either — stderr only, because whatever just failed may be the ledger write itself.
    try { process.stderr.write(`session-end-telemetry: hook failed: ${oneLine(err?.stack ?? err)}\n`); } catch { /* nothing left */ }
  }
  process.exit(0);
}

if (process.argv[1] === THIS_FILE) {
  main();
}
