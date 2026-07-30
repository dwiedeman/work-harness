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
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveUnitId } from "./session-end-telemetry.mjs";

const HOOK_PATH = fileURLToPath(new URL("./session-end-telemetry.mjs", import.meta.url));

// Stub for `<worktree>/scripts/session-token-report.mjs` — the real script lives in the CONSUMING
// repo, not this one, so the hook's contract with it (read `--issues <id>` if present, print a line
// starting with `WORK-EVENT ` + a JSON token_usage event) is stood up here to exercise the hook itself
// end-to-end, exactly as Claude Code's SessionEnd trigger would invoke it.
const STUB_REPORT_SCRIPT = `#!/usr/bin/env node
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
console.log("WORK-EVENT " + JSON.stringify({
  type: "token_usage",
  role: at("--role"),
  issue: at("--issues"),
}));
`;

// Spawns the REAL shipped session-end-telemetry.mjs as a child process (as Claude Code's SessionEnd
// hook actually does), with a crafted stdin payload, and returns the token_usage event it appended to
// the run ledger's events.jsonl — or null if it appended nothing.
async function runHook({ role, worktreeName }) {
  const runDir = await mkdtemp(join(tmpdir(), "der-2747-rundir-"));
  const worktreesRoot = await mkdtemp(join(tmpdir(), "der-2747-worktrees-"));
  const cwd = join(worktreesRoot, "20260729T000000Z-demo", worktreeName);
  await mkdir(join(cwd, "scripts"), { recursive: true });
  await writeFile(join(cwd, "scripts", "session-token-report.mjs"), STUB_REPORT_SCRIPT, "utf8");

  execFileSync("node", [HOOK_PATH], {
    cwd,
    env: { ...process.env, WORK_ROLE: role, WORK_RUN_DIR: runDir },
    input: JSON.stringify({ session_id: "sess-1", cwd }),
    encoding: "utf8",
  });

  let raw = "";
  try { raw = await readFile(join(runDir, "events.jsonl"), "utf8"); } catch { /* nothing appended */ }
  const lines = raw.split("\n").filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

test("integration: the REAL hook process attributes a SPEC-mode unit worktree's token_usage to its unit id (DER-2747)", async () => {
  const event = await runHook({ role: "lead", worktreeName: "SPEC-demo-U1" });
  assert.ok(event, "hook should have appended a token_usage event");
  assert.equal(event.issue, "SPEC-demo-U1");
});

test("integration: the REAL hook process still attributes a classic Linear issue worktree (control)", async () => {
  const event = await runHook({ role: "lead", worktreeName: "DER-1234" });
  assert.ok(event, "hook should have appended a token_usage event");
  assert.equal(event.issue, "DER-1234");
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
