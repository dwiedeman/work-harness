// Unit tests for skills/work/session-end-telemetry.mjs — run with:
//   node --test skills/work/session-end-telemetry.test.mjs
//
// DER-2747 — the SessionEnd hook derived a lead's issue attribution from its cwd with the ad hoc
// `\b([A-Z]{2,6}-\d+)\b`, which only matches classic `ABC-123` Linear ids. A spec-mode worktree is
// named for a unit id `SPEC-<slug>-U<n>` (e.g. `SPEC-demo-U1`) — no bare "letters-digits" run
// immediately after the prefix — so the old regex matched nothing and the emitted `token_usage` event
// carried no `issue`, which `materializeState` then silently drops (`if (!e.issue) continue`) before
// per-unit budget accounting. Spec-mode runs therefore lost ALL per-unit token attribution.
//
// The fix factors id-parsing into `deriveUnitId`, an exported pure function in the hook itself, built
// on the SAME `UNIT_ID_RE` grammar work-runner.mjs already uses to build/validate unit ids — imported,
// not re-derived — so the hook and the runner cannot drift. It also matches only the cwd's BASENAME
// (a lead's cwd IS its worktree, named exactly `<worktreeRoot>/<runId>/<unitId>` with no slug/suffix —
// confirmed against work-runner.mjs's `wt = join(worktreeRoot, runId, issueId)`), rather than searching
// the whole cwd string, which could previously misattribute spend to an id-shaped segment earlier in
// the path.
// DER-2745 — the same silent-nothing shape, one layer out: the hook resolved its reporter ONLY at
// `<cwd>/scripts/session-token-report.mjs` (a path in the CONSUMING repo) and did
// `if (!existsSync(script)) process.exit(0)`. This repo ships no `scripts/` dir, so on a fresh install
// the SessionEnd hook found nothing, exited 0, and recorded NOTHING — indistinguishable from "this
// session spent no tokens". Every downstream number (`usage`, `work-metrics`, per-unit budget
// accounting, the budget circuit breaker) was then an undercount by omission with no signal anywhere.
// Fixed both ways: the harness now SHIPS `session-token-report.mjs` next to the hook (so a fresh
// install reports for real), the consumer repo's own copy still wins when present (ROST compat), and
// EVERY remaining failure path — unresolvable reporter, crashing reporter, unparseable output, wrong
// event type — appends a durable `telemetry_gap` event instead of exiting 0 in silence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveUnitId, resolveReporter } from "./session-end-telemetry.mjs";

const HOOK_PATH = fileURLToPath(new URL("./session-end-telemetry.mjs", import.meta.url));
const REPORTER_PATH = fileURLToPath(new URL("./session-token-report.mjs", import.meta.url));

// Stub for `<worktree>/scripts/session-token-report.mjs` — the CONSUMER-repo copy, which still takes
// precedence over the shipped one. The hook's contract with it (read `--issues <id>` if present, print
// a line starting with `WORK-EVENT ` + a JSON token_usage event) is stood up here to exercise the hook
// itself end-to-end, exactly as Claude Code's SessionEnd trigger would invoke it.
const STUB_REPORT_SCRIPT = `#!/usr/bin/env node
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
console.log("WORK-EVENT " + JSON.stringify({
  type: "token_usage",
  role: at("--role"),
  issue: at("--issues"),
  by_model: { "stub-model": { input: 1, output: 1, cache_creation: 0, cache_read: 0 } },
  source: "consumer-repo-stub",
}));
`;

// The three ways a reporter that EXISTS still yields no usable event. Each one used to be a silent
// exit 0 — the shape DER-2745 is about — and each must now leave a `telemetry_gap` in the ledger.
const BROKEN_REPORTERS = {
  exit_nonzero: `#!/usr/bin/env node\nconsole.error("boom: no transcript for that session id");\nprocess.exit(3);\n`,
  invalid_json: `#!/usr/bin/env node\nconsole.log("WORK-EVENT {not json at all");\n`,
  wrong_type: `#!/usr/bin/env node\nconsole.log("WORK-EVENT " + JSON.stringify({ type: "context_report", used: 5 }));\n`,
  no_output: `#!/usr/bin/env node\nprocess.exit(0);\n`,
  // A token_usage the usage fold SKIPS (both `aggregateTokenUsage` and `foldTokenUsage` require
  // `by_model`) — a report that looks made and counts as nothing.
  unfoldable: `#!/usr/bin/env node\nconsole.log("WORK-EVENT " + JSON.stringify({ type: "token_usage", role: "lead" }));\n`,
};

// A synthetic Claude Code transcript: two assistant turns on one model (the second line a verbatim
// REPLAY of the first — same message id — which must be counted once, not twice), one sidechain
// (subagent) turn on another model, plus non-usage and torn lines the reader must skip.
const TRANSCRIPT_LINES = [
  JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
  JSON.stringify({ type: "assistant", requestId: "req_1", message: { id: "msg_1", model: "claude-opus-4-6", usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 } } }),
  JSON.stringify({ type: "assistant", requestId: "req_1", message: { id: "msg_1", model: "claude-opus-4-6", usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 } } }),
  JSON.stringify({ type: "assistant", requestId: "req_2", message: { id: "msg_2", model: "claude-opus-4-6", usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 200 } } }),
  JSON.stringify({ type: "assistant", isSidechain: true, requestId: "req_3", message: { id: "msg_3", model: "claude-sonnet-4-5", usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } }),
  '{"type":"assistant","message":{"usage":{"input_tokens": 9', // torn tail line
].join("\n") + "\n";

const EXPECTED_BY_MODEL = {
  "claude-opus-4-6": { input: 105, output: 57, cache_creation: 10, cache_read: 1200 },
  "claude-sonnet-4-5": { input: 1, output: 2, cache_creation: 3, cache_read: 4 },
};
const EXPECTED_TOTAL_TOKENS = 105 + 57 + 10 + 1200 + 1 + 2 + 3 + 4;

// Spawns the REAL shipped session-end-telemetry.mjs as a child process (as Claude Code's SessionEnd
// hook actually does), with a crafted stdin payload. `reporter` selects what the CONSUMER repo
// provides: "stub" (a working repo-local copy), "none" (a fresh install — no scripts/ dir at all,
// which is this repo and every adopter's repo), or one of BROKEN_REPORTERS.
async function runHook({
  role,
  worktreeName,
  reporter = "stub",
  withTranscript = true,
  env: extraEnv = {},
} = {}) {
  const runDir = await mkdtemp(join(tmpdir(), "der-2745-rundir-"));
  const worktreesRoot = await mkdtemp(join(tmpdir(), "der-2745-worktrees-"));
  const cwd = join(worktreesRoot, "20260729T000000Z-demo", worktreeName);
  await mkdir(cwd, { recursive: true });

  if (reporter !== "none") {
    const body = reporter === "stub" ? STUB_REPORT_SCRIPT : BROKEN_REPORTERS[reporter];
    assert.ok(body, `unknown reporter fixture "${reporter}"`);
    await mkdir(join(cwd, "scripts"), { recursive: true });
    await writeFile(join(cwd, "scripts", "session-token-report.mjs"), body, "utf8");
  }

  // Claude Code's SessionEnd payload carries the exact transcript path — no newest-file guessing.
  const input = { session_id: "sess-abcdef123456", cwd };
  if (withTranscript) {
    const transcript = join(runDir, "transcript.jsonl");
    await writeFile(transcript, TRANSCRIPT_LINES, "utf8");
    input.transcript_path = transcript;
  }

  // A hermetic, EMPTY projects root, so the shipped reporter can never fall back onto the real
  // operator's ~/.claude transcripts and make a test pass for the wrong reason.
  const configDir = await mkdtemp(join(tmpdir(), "der-2745-claude-"));
  await mkdir(join(configDir, "projects"), { recursive: true });

  const res = spawnSync("node", [HOOK_PATH], {
    cwd,
    env: {
      ...process.env,
      WORK_ROLE: role,
      WORK_RUN_DIR: runDir,
      CLAUDE_CONFIG_DIR: configDir,
      ...extraEnv,
    },
    input: JSON.stringify(input),
    encoding: "utf8",
  });

  let raw = "";
  try { raw = await readFile(join(runDir, "events.jsonl"), "utf8"); } catch { /* nothing appended */ }
  const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { events, last: events.length ? events[events.length - 1] : null, res };
}

// ---------------------------------------------------------------------------
// DER-2745 — the reporter the harness never shipped
// ---------------------------------------------------------------------------

test("integration: a FRESH INSTALL with no consumer-repo scripts/ dir still records real token spend (DER-2745)", async () => {
  // This is the defect verbatim: nothing at `<cwd>/scripts/session-token-report.mjs`, because no repo
  // in this harness's world ships one. Pre-fix the hook exited 0 having written nothing at all — a
  // zero that looks exactly like a session that spent nothing.
  const { events, last, res } = await runHook({ role: "lead", worktreeName: "DER-1234", reporter: "none" });
  assert.equal(res.status, 0, "the SessionEnd hook must never fail a session");
  assert.ok(events.length, "a fresh install recorded NOTHING — the silent undercount DER-2745 is about");
  assert.equal(last.type, "token_usage");
  assert.equal(last.role, "lead");
  assert.equal(last.issue, "DER-1234");
  assert.deepEqual(last.by_model, EXPECTED_BY_MODEL);
  assert.equal(last.total_tokens, EXPECTED_TOTAL_TOKENS);
});

test("integration: an unresolvable reporter records a LOUD telemetry_gap, never a silent nothing (DER-2745)", async () => {
  // An explicitly-configured reporter that does not exist must NOT fall through to another candidate —
  // it is a misconfiguration, and the ledger has to say so.
  const { events, last, res } = await runHook({
    role: "orch",
    worktreeName: "repo-root",
    reporter: "none",
    env: { WORK_TOKEN_REPORT: join(tmpdir(), "der-2745-does-not-exist", "session-token-report.mjs") },
  });
  assert.equal(res.status, 0, "the SessionEnd hook must never fail a session");
  assert.ok(events.length, "the hook exited 0 in SILENCE — no token event and no complaint");
  assert.equal(last.type, "telemetry_gap");
  assert.equal(last.signal, "token_usage_missing");
  assert.equal(last.reason, "reporter_override_missing");
  assert.equal(last.role, "orch");
  assert.match(String(last.reporter), /der-2745-does-not-exist/);
  assert.match(res.stderr, /session-end-telemetry/, "and it must say so on stderr for the hook log too");
});

test("integration: a reporter that CRASHES records a telemetry_gap carrying its stderr (DER-2745)", async () => {
  const { last } = await runHook({ role: "lead", worktreeName: "DER-1234", reporter: "exit_nonzero" });
  assert.equal(last.type, "telemetry_gap");
  assert.equal(last.reason, "reporter_failed");
  assert.equal(last.issue, "DER-1234");
  assert.match(String(last.detail), /no transcript for that session id/);
});

test("integration: a reporter emitting INVALID JSON records a telemetry_gap (DER-2745)", async () => {
  const { last } = await runHook({ role: "lead", worktreeName: "DER-1234", reporter: "invalid_json" });
  assert.equal(last.type, "telemetry_gap");
  assert.equal(last.reason, "reporter_output_invalid");
});

test("integration: a reporter emitting the WRONG event type records a telemetry_gap (DER-2745)", async () => {
  const { last } = await runHook({ role: "lead", worktreeName: "DER-1234", reporter: "wrong_type" });
  assert.equal(last.type, "telemetry_gap");
  assert.equal(last.reason, "reporter_wrong_event_type");
  assert.match(String(last.detail), /context_report/);
});

test("integration: a reporter that prints NOTHING records a telemetry_gap (DER-2745)", async () => {
  const { last } = await runHook({ role: "lead", worktreeName: "DER-1234", reporter: "no_output" });
  assert.equal(last.type, "telemetry_gap");
  assert.equal(last.reason, "reporter_output_invalid");
});

test("integration: a token_usage with no by_model is KEPT and ALSO booked as a gap (DER-2745)", async () => {
  // The fold skips a by_model-less token_usage, so on its own it is a report that contributes zero while
  // reading as coverage. Keep the reporter's word, and say that nothing foldable came of it.
  const { events, last } = await runHook({ role: "lead", worktreeName: "DER-1234", reporter: "unfoldable" });
  assert.equal(events.length, 2, "the reporter's event must not be thrown away, and the gap must be recorded");
  assert.equal(events[0].type, "token_usage");
  assert.equal(last.type, "telemetry_gap");
  assert.equal(last.reason, "reporter_event_unfoldable");
});

test("integration: no resolvable TRANSCRIPT is a recorded gap, not a reported zero (DER-2745)", async () => {
  // The failure mode the hook's own header laments ("silently reported NOTHING when transcript
  // persistence was off"). The shipped reporter refuses to invent a zero: it exits nonzero, and the
  // hook books the absence.
  const { last } = await runHook({
    role: "shepherd",
    worktreeName: "repo-root",
    reporter: "none",
    withTranscript: false,
  });
  assert.equal(last.type, "telemetry_gap");
  assert.equal(last.reason, "reporter_failed");
  assert.match(String(last.detail), /transcript/i);
});

test("integration: the CONSUMER repo's own scripts/session-token-report.mjs still wins (compat control)", async () => {
  // ROST ships its own reporter and every brief tells leads to run `node scripts/session-token-report.mjs`.
  // Shipping ours must not hijack a repo that already has one.
  const { last } = await runHook({ role: "lead", worktreeName: "DER-1234", reporter: "stub" });
  assert.equal(last.type, "token_usage");
  assert.equal(last.source, "consumer-repo-stub");
});

test("resolveReporter prefers the consumer repo's copy, then the shipped sibling (DER-2745)", () => {
  const exists = (p) => [
    "/repo/scripts/session-token-report.mjs",
    "/hook/session-token-report.mjs",
  ].includes(p);
  assert.deepEqual(
    resolveReporter({ cwd: "/repo", hookDir: "/hook", env: {}, exists }),
    { path: "/repo/scripts/session-token-report.mjs", source: "repo", searched: ["/repo/scripts/session-token-report.mjs"] },
  );
  // Fresh install: no consumer copy, the shipped sibling answers — the DER-2745 fix.
  const shippedOnly = (p) => p === "/hook/session-token-report.mjs";
  const r = resolveReporter({ cwd: "/repo", hookDir: "/hook", env: {}, exists: shippedOnly });
  assert.equal(r.path, "/hook/session-token-report.mjs");
  assert.equal(r.source, "shipped");
  // Nothing anywhere: a clearly-marked unresolved answer that names everything it looked at, never a
  // bare null the caller can mistake for "fine".
  const none = resolveReporter({ cwd: "/repo", hookDir: "/hook", env: {}, exists: () => false });
  assert.equal(none.path, null);
  assert.equal(none.source, "unresolved");
  assert.deepEqual(none.searched, ["/repo/scripts/session-token-report.mjs", "/hook/session-token-report.mjs"]);
});

test("resolveReporter honours WORK_TOKEN_REPORT and does NOT fall through when it is missing (DER-2745)", () => {
  const env = { WORK_TOKEN_REPORT: "/opt/custom-report.mjs" };
  assert.equal(
    resolveReporter({ cwd: "/repo", hookDir: "/hook", env, exists: () => true }).path,
    "/opt/custom-report.mjs",
  );
  const missing = resolveReporter({ cwd: "/repo", hookDir: "/hook", env, exists: (p) => p !== "/opt/custom-report.mjs" });
  assert.equal(missing.path, null);
  assert.equal(missing.source, "override_missing");
  assert.deepEqual(missing.searched, ["/opt/custom-report.mjs"]);
});

// ---------------------------------------------------------------------------
// DER-2745 — the shipped reporter itself (skills/work/session-token-report.mjs)
// ---------------------------------------------------------------------------
// Shipping a reporter that silently reports nothing would just move the defect, so the shipped script
// is exercised directly here rather than only through the hook. It lives in this suite (not a new test
// file) because install.sh and ci.yml enumerate suites by name and only the orchestrator may wire a new
// one — repo-contract.test.mjs fails on an unwired suite.

async function writeTranscript(name = "transcript.jsonl") {
  const dir = await mkdtemp(join(tmpdir(), "der-2745-transcript-"));
  const path = join(dir, name);
  await writeFile(path, TRANSCRIPT_LINES, "utf8");
  return { dir, path };
}

function runReporter(args, { env: extraEnv = {}, cwd } = {}) {
  return spawnSync("node", [REPORTER_PATH, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
}

function parseWorkEvent(stdout) {
  const line = stdout.split("\n").filter(Boolean).find((l) => l.startsWith("WORK-EVENT "));
  assert.ok(line, `reporter printed no WORK-EVENT line:\n${stdout}`);
  return JSON.parse(line.slice("WORK-EVENT ".length));
}

test("shipped reporter: sums a transcript by model, deduping replayed message ids and counting subagents (DER-2745)", async () => {
  const { path } = await writeTranscript();
  const res = runReporter(["--role", "lead", "--issues", "DER-1234", "--transcript", path, "--format", "event"]);
  assert.equal(res.status, 0, res.stderr);
  const ev = parseWorkEvent(res.stdout);
  assert.equal(ev.type, "token_usage");
  assert.equal(ev.role, "lead");
  assert.equal(ev.issue, "DER-1234");
  assert.deepEqual(ev.by_model, EXPECTED_BY_MODEL);
  assert.equal(ev.total_tokens, EXPECTED_TOTAL_TOKENS);
  assert.deepEqual(ev.tokens, { input: 106, output: 59, cache_creation: 13, cache_read: 1204 });
  assert.ok(ev.ts, "the fold dedups per emission on ts");
});

test("shipped reporter: report_id is a stable one-way hash of the session id, never the raw id (DER-2745)", async () => {
  const { path } = await writeTranscript();
  const args = ["--role", "orch", "--session-id", "sess-abcdef123456", "--transcript", path, "--format", "event"];
  const a = parseWorkEvent(runReporter(args).stdout);
  const b = parseWorkEvent(runReporter(args).stdout);
  assert.equal(a.report_id, b.report_id, "re-reporting the same session must collapse in the fold");
  assert.match(a.report_id, /^[0-9a-f]{12}$/);
  const blob = JSON.stringify(a);
  assert.ok(!blob.includes("sess-abcdef123456"), `the raw session id must never leave the box: ${blob}`);
});

test("shipped reporter: resolves a transcript by --session-id under the projects root (DER-2745)", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "der-2745-claude-"));
  const projectDir = join(configDir, "projects", "-Users-lead-worktrees-DER-1234");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "sess-abcdef123456.jsonl"), TRANSCRIPT_LINES, "utf8");
  const res = runReporter(["--role", "lead", "--session-id", "sess-abcdef123456", "--format", "event"], {
    env: { CLAUDE_CONFIG_DIR: configDir },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(parseWorkEvent(res.stdout).total_tokens, EXPECTED_TOTAL_TOKENS);
});

test("shipped reporter: REFUSES to print a zero event when no transcript can be found (DER-2745)", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "der-2745-claude-empty-"));
  await mkdir(join(configDir, "projects"), { recursive: true });
  const res = runReporter(["--role", "lead", "--session-id", "sess-nope", "--format", "event"], {
    env: { CLAUDE_CONFIG_DIR: configDir },
  });
  assert.notEqual(res.status, 0, "an unknown spend must exit nonzero, not report 0 tokens");
  assert.ok(!res.stdout.includes("WORK-EVENT"), `it must not emit a fabricated zero:\n${res.stdout}`);
  assert.match(res.stderr, /transcript/i);
});

test("shipped reporter: REFUSES to print a zero event for a transcript with no usage at all (DER-2745)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "der-2745-empty-transcript-"));
  const path = join(dir, "empty.jsonl");
  await writeFile(path, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n", "utf8");
  const res = runReporter(["--role", "lead", "--transcript", path, "--format", "event"]);
  assert.notEqual(res.status, 0);
  assert.ok(!res.stdout.includes("WORK-EVENT"));
});

test("shipped reporter: default (PR-comment) output STARTS with the WORK-EVENT marker the fold requires (DER-2745)", async () => {
  // The cloud brief posts this output verbatim as a PR comment body, and parsePrEventComments only
  // accepts a body that STARTS with the marker and parses the FIRST line after it.
  const { path } = await writeTranscript();
  const res = runReporter(["--role", "lead", "--issues", "DER-1,DER-2", "--pr", "42", "--host", "cloud", "--transcript", path]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.startsWith("WORK-EVENT "), `body must start with the marker:\n${res.stdout}`);
  const ev = JSON.parse(res.stdout.slice("WORK-EVENT ".length).split("\n")[0]);
  assert.equal(ev.type, "token_usage");
  assert.deepEqual(ev.issues, ["DER-1", "DER-2"]);
  assert.equal(ev.issue, "DER-1", "the PRIMARY id keys the unit; materializeState drops an event with no `issue`");
  assert.equal(ev.pr, 42);
  assert.equal(ev.host, "cloud");
});

test("shipped reporter: the event it emits folds through aggregateTokenUsage unchanged (DER-2745)", async () => {
  const { aggregateTokenUsage } = await import("./work-runner.mjs");
  const { path } = await writeTranscript();
  const ev = parseWorkEvent(runReporter(["--role", "lead", "--issues", "DER-1234", "--transcript", path, "--format", "event"]).stdout);
  // Two identical re-reports of one session must NOT double-count — that is what report_id is for.
  const agg = aggregateTokenUsage([ev, { ...ev, ts: new Date().toISOString() }]);
  assert.equal(agg.reports, 1);
  assert.equal(agg.total_tokens, EXPECTED_TOTAL_TOKENS);
  assert.equal(agg.by_role.lead.total.cache_read, 1204);
});

test("shipped reporter: is import-safe — importing it must not exit the process (DER-2745)", async () => {
  const mod = await import("./session-token-report.mjs");
  assert.equal(typeof mod.sumTranscriptUsage, "function");
  assert.equal(typeof mod.buildTokenUsageEvent, "function");
  const summed = mod.sumTranscriptUsage(TRANSCRIPT_LINES);
  assert.deepEqual(summed.by_model, EXPECTED_BY_MODEL);
  assert.equal(summed.entries, 3, "one replayed line deduped, non-usage and torn lines skipped");
});

// ---------------------------------------------------------------------------
// DER-2747 — unit-id attribution (pre-existing)
// ---------------------------------------------------------------------------

test("integration: the REAL hook process attributes a SPEC-mode unit worktree's token_usage to its unit id (DER-2747)", async () => {
  const { last } = await runHook({ role: "lead", worktreeName: "SPEC-demo-U1" });
  assert.ok(last, "hook should have appended a token_usage event");
  assert.equal(last.type, "token_usage");
  assert.equal(last.issue, "SPEC-demo-U1");
});

test("integration: the REAL hook process still attributes a classic Linear issue worktree (control)", async () => {
  const { last } = await runHook({ role: "lead", worktreeName: "DER-1234" });
  assert.ok(last, "hook should have appended a token_usage event");
  assert.equal(last.type, "token_usage");
  assert.equal(last.issue, "DER-1234");
});

test("deriveUnitId recognizes a spec-mode unit worktree (SPEC-<slug>-U<n>) — the DER-2747 defect", () => {
  const cwd = "/Users/lead/worktrees/20260729T000000Z-demo/SPEC-demo-U1";
  assert.equal(deriveUnitId(cwd), "SPEC-demo-U1");
});

test("deriveUnitId still recognizes a classic Linear issue id (control)", () => {
  const cwd = "/Users/lead/worktrees/20260729T000000Z-demo/DER-1234";
  assert.equal(deriveUnitId(cwd), "DER-1234");
});

test("deriveUnitId returns null (clearly-marked unknown) for an unrecognized dir, never a wrong id (control)", () => {
  // A path that contains an id-shaped segment EARLIER than the trailing (real) directory — the old
  // whole-string regex would have matched "DER-9999" here, misattributing spend to the wrong issue.
  const cwd = "/Users/lead/worktrees/DER-9999/runs/some-other-dir";
  assert.equal(deriveUnitId(cwd), null);
});

test("deriveUnitId returns null for an empty/undefined cwd", () => {
  assert.equal(deriveUnitId(""), null);
  assert.equal(deriveUnitId(undefined), null);
});

test("deriveUnitId accepts a lower-cased spec unit id (grammar is case-tolerant on input, mirrors UNIT_ID_RE)", () => {
  const cwd = "/Users/lead/worktrees/run/spec-demo-u1";
  assert.equal(deriveUnitId(cwd), "spec-demo-u1");
});
