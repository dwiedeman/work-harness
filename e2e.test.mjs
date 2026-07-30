// FAULT-INJECTION E2E SUITE (DER-2830)
//
// WHY THIS EXISTS, AND WHY IT IS NOT THE UNIT SUITE
//
// Almost every fix in this harness since 0.1.0 is a FAILURE HANDLER: "a red CI no longer parses as no
// checks", "a torn tail is held for retry instead of consumed", "blockers must block", "`reap` no longer
// claims a teardown it did not achieve". A happy-path run — green CI, intact ledger, clean spawn, clean
// reap — exercises NONE of them and returns green. That is the trap this file avoids: it INDUCES each
// fault and asserts the harness now survives it.
//
// It is end-to-end in the sense that matters here: every case drives `work-runner.mjs` as a REAL
// SUBPROCESS, so it covers argv parsing, exit codes, and the refusal TEXT an operator actually reads —
// none of which the in-process unit suite touches. The unit suite proves the predicates; this proves the
// program.
//
// TWO TIERS
//   A (default, hermetic) — filesystem + subprocess only. No network, no model calls, no `gh`. Runs in
//     CI on every PR.
//   B (opt-in, `WORK_E2E_LIVE=1`) — real model calls and real GitHub. Never in PR CI: it costs money and
//     needs credentials. For adopters validating their own install, and for pre-release verification.
//
// DEFECT PINS — read before "fixing" a failure in this file
//
// Four fold defects are PROVEN LIVE (DER-2323, DER-2602, DER-2824, DER-2810). The pins below assert the
// CURRENT BROKEN behavior on purpose. When the matching issue lands, the pin goes RED and must be
// INVERTED — that redness is the intended signal, not a regression. Without the pins, an all-green E2E
// while four defects are live would manufacture exactly the false confidence this repo's rules exist to
// prevent: a check that cannot fail is not evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, readFile, rm, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(REPO, "skills/work/work-runner.mjs");
const LIVE = process.env.WORK_E2E_LIVE === "1";

// The CLI as a real subprocess. TIMEOUT is reported separately from FAILURE on purpose (DER-2829): a
// killed process and a refusing process are different facts, and collapsing them is how a false RED
// teaches an operator to stop trusting the gate.
function cli(args, { timeoutMs = 30000, cwd = REPO } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [RUNNER, ...args], { timeout: timeoutMs, cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      const timedOut = !!(err && (err.killed || err.signal === "SIGTERM"));
      resolve({
        code: timedOut ? null : (err?.code ?? 0), // null === UNKNOWN, never conflated with a refusal
        timedOut,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        out: `${stdout ?? ""}${stderr ?? ""}`,
      });
    });
  });
}

const refused = (r) => {
  assert.equal(r.timedOut, false, "the command TIMED OUT — that is UNKNOWN, not a refusal; do not read it as a pass");
  assert.equal(r.code, 1, `expected a refusal (exit 1), got exit ${r.code}\n${r.out}`);
};
const succeeded = (r) => {
  assert.equal(r.timedOut, false, "the command TIMED OUT — that is UNKNOWN, not a success");
  assert.equal(r.code, 0, `expected success (exit 0), got exit ${r.code}\n${r.out}`);
};

// A real run dir, created by the real `init-run`. Fixtures are never hand-built: a hand-built ledger
// tests a shape production never writes.
async function newRun(t) {
  const root = await mkdtemp(join(tmpdir(), "wh-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const r = await cli(["init-run", "--project", "sandbox", "--runs-root", root]);
  succeeded(r);
  const runId = r.stdout.trim().split("\n").filter(Boolean).pop();
  assert.match(runId, /^\d{8}T\d{6}Z/, `init-run did not print a run id: ${JSON.stringify(r.out)}`);
  const ledger = join(root, runId, "events.jsonl");
  const run = (args, o) => cli([...args, "--runs-root", root], o);
  return {
    root, runId, ledger, run,
    // STAMPED append — the real `append` subcommand, which is what production uses. Use this for every
    // ordinary fixture event.
    //
    // Writing lines to events.jsonl by hand instead LOOKS equivalent and is not: it bypasses stampEvent,
    // so the line carries no `harness_version` and folds as `unknown`. The run then reads as a
    // MIXED-VERSION ledger and every dispatch gate refuses — the version attestation (DER-2779) doing
    // exactly its job on a fixture that lied about its provenance. Cost an hour the first time.
    append: async (ev) => {
      const r = await run(["append", "--run", runId, JSON.stringify(ev)]);
      succeeded(r);
      return r;
    },
    // RAW append — deliberately bypasses stamping. Correct ONLY for fixtures that must be malformed
    // (a torn tail) or must carry a backdated `ts` (a backfilled historical event). Never for ordinary
    // events; see above.
    appendRaw: (line) => appendFile(ledger, line, "utf8"),
    events: async () => (await readFile(ledger, "utf8")).split("\n").filter(Boolean),
    state: async () => {
      const s = await run(["state", "--run", runId]);
      succeeded(s);
      return JSON.parse(s.stdout);
    },
  };
}

// A minimal one-unit lifecycle, stamped. Returns at `pr_open`.
async function seedUnit(R, id = "DER-1", pr = 1) {
  await R.append({ actor: "orch", type: "lead_spawned", issue: id, worktree: `/wt/${id}` });
  await R.append({ actor: `lead:${id}`, type: "pr_opened", issue: id, pr });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// TIER A — hermetic fault injection
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("E2E baseline: init-run produces a real, readable ledger (the fixture itself must be honest)", async (t) => {
  const R = await newRun(t);
  succeeded(await R.run(["state", "--run", R.runId]));
  const lines = await R.events();
  assert.ok(lines.length >= 1, `a fresh run must have at least a run_started event, got ${lines.length}`);
  for (const l of lines) JSON.parse(l); // every line parses — if this fails, later "damage" cases prove nothing
  console.log(`    [baseline] ledger lines checked: ${lines.length} of ${lines.length}`);
});

test("FAULT torn ledger tail: a truncated line does not crash any consumer, and is quarantined (DER-2738, DER-2776)", async (t) => {
  const R = await newRun(t);
  // CONTROL: healthy first. Without this, the post-tear reading proves nothing — it could always say
  // that. Assert on the STRUCTURED verdict, not a regex over prose: `state` prints a `ledger` object
  // whose FIELD NAMES include "quarantined", so /quarantin/i matches a perfectly healthy ledger. (The
  // first draft of this test did exactly that, and its control caught it.)
  const before = await R.state();
  assert.equal(before.ledger.ok, true, "the control must be a CLEAN ledger, or the post-tear assertion is meaningless");
  assert.equal(before.ledger.torn_tail, 0);
  assert.deepEqual(before.ledger.reasons, []);

  await R.appendRaw('{"actor":"orch","type":"note"'); // torn: no closing brace, no newline

  const after = await R.run(["state", "--run", R.runId]);
  assert.equal(after.timedOut, false, "state TIMED OUT on a torn ledger — UNKNOWN, not a pass");
  assert.equal(after.code, 0, `a torn tail must NOT crash the reader (DER-2738); exit ${after.code}\n${after.out}`);
  const led = JSON.parse(after.stdout).ledger;
  assert.equal(led.ok, false, "the tear must be SURFACED, not silently swallowed");
  assert.equal(led.torn_tail, 1, "the torn line must be COUNTED");
  assert.ok(led.reasons.includes("torn_tail"), `reasons must name the damage, got ${JSON.stringify(led.reasons)}`);
  assert.equal(typeof led.first_bad_offset, "number", "the offset must be recorded so the tail can be retried, not discarded");
  assert.equal(led.quarantined_recorded, 1, "the raw bytes must be preserved to a quarantine sidecar (DER-2776)");
});

test("FAULT reap an id that is not a unit of the run: refused, nothing appended (DER-2775)", async (t) => {
  const R = await newRun(t);
  const beforeLines = (await R.events()).length;
  const r = await R.run(["reap", "--run", R.runId, "DER-NOPE"]);
  refused(r);
  assert.match(r.out, /not a unit in run|refusing/i, "the refusal must NAME why");
  assert.equal((await R.events()).length, beforeLines, "a refused reap must append NOTHING");
  // --abandon must not be an escape hatch for a phantom id.
  const forced = await R.run(["reap", "--run", R.runId, "DER-NOPE", "--abandon"]);
  refused(forced);
  assert.equal((await R.events()).length, beforeLines, "--abandon must not override the unknown-id refusal");
});

test("FAULT complete-run on an empty run: refused as vacuous, and the refusal names the gate (DER-2781)", async (t) => {
  const R = await newRun(t);
  const r = await R.run(["complete-run", "--run", R.runId]);
  refused(r);
  assert.match(r.out, /units_tracked/, "the refusal must name the CHECK that produced it, not just say no");
  assert.match(r.out, /NOTHING was appended/i);
  assert.match(r.out, /no --force/i, "a completion gate with a --force is not a gate");
});

test("FAULT complete-run with a non-terminal unit: refused; and the SAME run completes once it is terminal (DER-2781)", async (t) => {
  const R = await newRun(t);
  await seedUnit(R);

  const blocked = await R.run(["complete-run", "--run", R.runId]);
  refused(blocked);
  assert.match(blocked.out, /units_terminal/, "must name the terminal-state gate");

  // CONTROL — the same run, once the unit reaches a terminal state, MUST complete. A gate that refuses
  // everything is not a gate, and this pair is what proves it discriminates.
  await R.append({ actor: "orch", type: "pr_merged", issue: "DER-1", pr: 1 });
  await R.append({ actor: "orch", type: "reaped", issue: "DER-1" });
  succeeded(await R.run(["complete-run", "--run", R.runId]));
});

test("FAULT version skew: a second harness_version in one ledger blocks dispatch; --allow-version-skew is the documented escape (DER-2748, DER-2779)", async (t) => {
  const R = await newRun(t);
  await seedUnit(R);
  await R.append({ actor: "orch", type: "pr_merged", issue: "DER-1", pr: 1 });
  await R.append({ actor: "orch", type: "reaped", issue: "DER-1" });
  // CONTROL: completes cleanly before any skew is introduced.
  succeeded(await R.run(["complete-run", "--run", R.runId, "--dry-run"]));

  // A skewed version can only ARRIVE by relay — `stampEvent` treats an event carrying an `event_id` as
  // minted elsewhere (a mini's local ledger, a successor's replay) and preserves its `harness_version` /
  // `schema_version`. Without the id it is re-stamped with THIS build's version and no skew exists, which
  // is the correct behaviour and makes the naive fixture silently untestable.
  await R.append({ actor: "orch", type: "host_heartbeat", host: "other-host", harness_version: "9.9.9", schema_version: 1, event_id: "0197e000-0000-7000-8000-00000000e2e1" });
  const skewed = await R.run(["complete-run", "--run", R.runId, "--dry-run"]);
  refused(skewed);
  assert.match(skewed.out, /mixed harness version/i, "the refusal must name the protocol/version gate");
  // The escape exists and is scoped: a deliberate mid-run host upgrade is acknowledgeable.
  succeeded(await R.run(["complete-run", "--run", R.runId, "--dry-run", "--allow-version-skew"]));
});

test("FAULT foreign schema_version: NEVER overridable, even with --allow-version-skew (DER-2748)", async (t) => {
  const R = await newRun(t);
  await seedUnit(R);
  await R.append({ actor: "orch", type: "pr_merged", issue: "DER-1", pr: 1 });
  await R.append({ actor: "orch", type: "reaped", issue: "DER-1" });
  // Relayed (carries an event_id) so the foreign wire version survives stamping — see the skew test above.
  await R.append({ actor: "orch", type: "note", schema_version: 99, event_id: "0197e000-0000-7000-8000-00000000e2e2" });

  const plain = await R.run(["complete-run", "--run", R.runId, "--dry-run"]);
  refused(plain);
  const forced = await R.run(["complete-run", "--run", R.runId, "--dry-run", "--allow-version-skew"]);
  refused(forced);
  assert.match(forced.out, /foreign schema_version/i,
    "the skew flag must NOT waive a wire version this build cannot parse — there is no degraded mode for unparseable lines");
});

test("ORDERING: the fold reads EVENT time, not file order — a backfilled historical event does not walk a terminal unit backwards", async (t) => {
  // readEvents returns dedupeLedgerEvents(sortEventsByTs(...)). Any "late event" claim tested against a
  // hand-ordered array tests a shape production never folds. This case pins the real behavior so a future
  // change to the read path cannot silently invalidate every ordering assumption in this file.
  const R = await newRun(t);
  await seedUnit(R);
  await R.append({ actor: "orch", type: "pr_merged", issue: "DER-1", pr: 1 });
  // Written at the TAIL of the file, but carrying an EARLIER timestamp — the DER-2520 backfill shape.
  await appendFile(R.ledger, `${JSON.stringify({ ts: "2026-07-30T11:00:00.000Z", actor: "orch", type: "pr_opened", issue: "DER-1", pr: 1 })}\n`, "utf8");

  const s = await R.run(["state", "--run", R.runId]);
  succeeded(s);
  const st = JSON.parse(s.stdout);
  assert.equal(st.issues["DER-1"].status, "merged",
    "a backfilled historical pr_opened sorts BEFORE the merge and must not regress the unit");
});

// A gate event whose `blockers` count agrees with its own findings list. The count is what authorizes a
// merge, so every fixture below deviates from this ONE honest shape in exactly one way.
const GATE_P1 = { title: "Tenant filter dropped", priority: 1, file: "b.ts", line_start: 3, line_end: 3 };
const GATE_P3 = { title: "nit: rename this", priority: 3, file: "c.ts", line_start: 1, line_end: 1 };
const gateEvent = (over = {}) => ({ actor: "lead:DER-1", type: "review_findings", issue: "DER-1", reviewer: "codex", round: 1, sha: "c0ffee1234".repeat(4), blockers: 1, findings: [GATE_P1, GATE_P3], ...over });

test("FAULT a gate event that UNDER-reports its own blockers: refused at the write boundary (DER-2837)", async (t) => {
  const R = await newRun(t);
  await seedUnit(R);
  const gateLines = async () => (await R.events()).filter((l) => l.includes('"review_findings"'));

  // The exploit shape: a live P1 in `findings`, `blockers: 0` in the count that `ready` reads.
  const lying = await R.run(["append", "--run", R.runId, JSON.stringify(gateEvent({ blockers: 0 }))]);
  refused(lying);
  assert.match(lying.out, /records 0 blocker\(s\) but its findings list holds 1/, "the refusal must print BOTH numbers, or the operator cannot tell what to re-run");
  assert.match(lying.out, /UNDER-count/, "…and name the direction, since only one direction ships a blocker");
  assert.equal((await gateLines()).length, 0, "a refused gate event must leave NOTHING behind");

  // The over-count and the non-count are refused too — one rule, both directions.
  refused(await R.run(["append", "--run", R.runId, JSON.stringify(gateEvent({ blockers: 4 }))]));
  refused(await R.run(["append", "--run", R.runId, JSON.stringify(gateEvent({ blockers: "1" }))]));
  assert.equal((await gateLines()).length, 0);

  // CONTROL — the HONEST event is accepted, and so is a genuinely clean one. Without this pair the
  // refusals above would be indistinguishable from an `append` that refuses every gate event.
  succeeded(await R.run(["append", "--run", R.runId, JSON.stringify(gateEvent())]));
  succeeded(await R.run(["append", "--run", R.runId, JSON.stringify(gateEvent({ blockers: 0, findings: [GATE_P3] }))]));
  assert.equal((await gateLines()).length, 2, "the write gate must discriminate, not just refuse");
});

test("FAULT a FORGED under-counted gate event that bypasses `append`: the READ side still refuses it (DER-2837)", async (t) => {
  const R = await newRun(t);
  await seedUnit(R);
  // CONTROL FIRST — an honest CLEAN gate leaves the unit off the blocked banner. Without it, the
  // post-forgery reading proves nothing: the banner could always be non-empty.
  await R.append(gateEvent({ blockers: 0, findings: [GATE_P3] }));
  assert.deepEqual((await R.state()).gate_blocked, [], "the control must be a CLEAN board, or the assertion below is meaningless");

  // appendRaw, and carrying an `event_id` so it reads as RELAYED: both are the real bypass routes. A
  // relay deliberately skips write validation (refusing it would fork the ledger between hosts), and
  // anyone who can write events.jsonl never needed the subcommand at all. This is precisely why the
  // write check is an affordance and the READ is the enforcement.
  await R.appendRaw(`${JSON.stringify({ ...gateEvent({ blockers: 0 }), event_id: "0197e000-0000-7000-8000-00000000e2e7", source_id: "mini", seq: 7, schema_version: 1, ts: new Date().toISOString() })}\n`);

  const st = await R.state();
  assert.deepEqual(st.gate_blocked.map((g) => [g.issue, g.blockers]), [["DER-1", "INCONSISTENT"]],
    "a forged under-counted gate event must reach the board as INCONSISTENT — it authorized a merge at c477ee9");
  assert.match(st.issues["DER-1"].gate_blockers_inconsistent, /records 0 blocker\(s\) but its findings list holds 1/);
  assert.match(st.gate_blocked[0].note, /INCONSISTENT WITH ITSELF/, "the board must say what to do about it, not just flag it");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEFECT PINS — assert what is BROKEN today. RED here means the defect was fixed: invert the pin.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("PIN DER-2824: a derived event still walks a REAPED unit backwards — INVERT THIS WHEN DER-2824 LANDS", async (t) => {
  const R = await newRun(t);
  await seedUnit(R);
  await R.append({ actor: "orch", type: "reaped", issue: "DER-1" });
  await R.append({ actor: "orch", type: "handed_off", issue: "DER-1", pr: 1, sha: "NEW", sha_descends: true });

  const s = await R.run(["state", "--run", R.runId]);
  succeeded(s);
  const status = JSON.parse(s.stdout).issues["DER-1"].status;
  assert.equal(status, "pr_open",
    "DEFECT PIN: a later derived handed_off currently walks `reaped` back to `pr_open`, which blocks " +
    "complete-run's units_terminal gate. If this now reads `reaped`, DER-2824 has landed — INVERT this " +
    "assertion to expect `reaped` and delete this pin.");
});

test("PIN DER-2602: unknown sha ancestry still fails OPEN and clears a live kickback — INVERT THIS WHEN DER-2602 LANDS", async (t) => {
  const R = await newRun(t);
  await seedUnit(R);
  await R.append({ actor: "shepherd", type: "kickback", issue: "DER-1", pr: 1, sha: "KB", round: 1 });
  // No `sha_descends` — the shape every reconcile cycle emits for a unit not currently in `kickback` status.
  await R.append({ actor: "orch", type: "handed_off", issue: "DER-1", pr: 1, sha: "NEW" });

  const s = await R.run(["state", "--run", R.runId]);
  succeeded(s);
  const st = JSON.parse(s.stdout);
  assert.equal(!!st.issues["DER-1"].kickback_unactioned, false,
    "DEFECT PIN: an UNSTAMPED hand-off currently clears an un-actioned kickback (fail-open on unknown). " +
    "If the kickback now stays pending, DER-2602 has landed — INVERT this pin.");

  // CONTROL — proves the pin is not vacuous: an explicitly-BACKWARDS sha is already refused today.
  const R2 = await newRun(t);
  await seedUnit(R2);
  await R2.append({ actor: "shepherd", type: "kickback", issue: "DER-1", pr: 1, sha: "KB", round: 1 });
  await R2.append({ actor: "orch", type: "handed_off", issue: "DER-1", pr: 1, sha: "OLD", sha_descends: false });
  const s2 = await R2.run(["state", "--run", R2.runId]);
  succeeded(s2);
  assert.equal(!!JSON.parse(s2.stdout).issues["DER-1"].kickback_unactioned, true,
    "CONTROL: a proven-backwards sha must still hold the kickback — if this fails the pin above is meaningless");
});

test("PIN DER-2323: a descendant-sha hand-off still clears a kickback with NO delivery receipt — INVERT THIS WHEN DER-2323 LANDS", async (t) => {
  const R = await newRun(t);
  await seedUnit(R);
  await R.append({ actor: "shepherd", type: "kickback", issue: "DER-1", pr: 1, sha: "KB", round: 1 });
  // A head move with NO lead_spawned re-spawn and NO kickback_relayed — nobody was told about the findings.
  await R.append({ actor: "orch", type: "handed_off", issue: "DER-1", pr: 1, sha: "NEW", sha_descends: true });

  const s = await R.run(["state", "--run", R.runId]);
  succeeded(s);
  const st = JSON.parse(s.stdout);
  assert.equal(!!st.issues["DER-1"].kickback_unactioned, false,
    "DEFECT PIN: a head move currently counts as delivery. If the kickback now stays pending, DER-2323 " +
    "has landed — INVERT this pin. NOTE: DER-2323 is gated on DER-2823's measurement; do not 'fix' it here.");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DER-2836 — THE EVIDENCE SANDBOX CANNOT BE MADE TO DELETE A FILE
//
// This is the fault-injection case the unit suite structurally cannot make: the unit tests call the
// validator, which is a PREDICATE — it returns strings and never spawns, so a unit test asserting "this
// is refused" would stay green even if the runner executed every payload it refused. The gap between
// "the validator said no" and "nothing ran" is exactly where this P0 lived, and only a real subprocess
// against a real filesystem can close it.
//
// So each case plants a CANARY FILE and asserts it SURVIVES. That assertion, not the exit code, is the
// one that fails on the parent commit: there `find . $(printf -- -delete)` passed the validator, reached
// `spawnSync(…, {shell: true})`, and the shell expanded the substitution into find's `-delete` — the
// canary was gone and the gate reported nothing wrong.
//
// ALL SIX WERE OBSERVED RED ON THE PARENT COMMIT, BUT NOT ALL IN THE SAME WAY, AND THE DIFFERENCE IS
// STATED RATHER THAN AVERAGED OVER:
//   • the five expansion cases (substitution, backtick, alternate generator, quoted, `$'…'`) each RED on
//     the CANARY assertion — the file was actually deleted;
//   • the glob case RED on the REFUSAL assertion — the validator passed it and the payload ran, but BSD
//     `find` rejects `find . -delete canary.txt plan.json` on its own argument grammar before deleting
//     anything. Whether pathname expansion reaches a deletion is a property of the local `find`, not of
//     the harness; what this suite pins is that the query is refused BEFORE that question can be asked.
// Both are real REDs. Claiming six deletions when the sixth was an execution would be the overclaim this
// repo's review rules exist to catch.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PREP = join(REPO, "skills/prep-for-work/prep-runner.mjs");

function prep(args, { timeoutMs = 30000, cwd = REPO } = {}) {
  return new Promise((res) => {
    execFile(process.execPath, [PREP, ...args], { timeout: timeoutMs, cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      const timedOut = !!(err && (err.killed || err.signal === "SIGTERM"));
      res({ code: timedOut ? null : (err?.code ?? 0), timedOut, stdout: stdout ?? "", stderr: stderr ?? "", out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

// A throwaway repo holding one canary file, plus a plan whose single evidence query is `query`.
//
// `plantDashDelete` writes a file literally NAMED `-delete`. That is what makes the glob case a real
// deletion rather than a refusal-only assertion: pathname expansion can only synthesize an option if a
// file with that name exists to be matched, so without it `find . *` is harmless and the case would prove
// nothing about the payload — only about the refusal. A repository is semi-trusted input here, and a
// committed file named `-delete` is the supply-chain shape of this bug.
async function sandboxWithQuery(t, query, { plantDashDelete = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wh-e2e-q-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canary = join(root, "canary.txt");
  await writeFile(canary, "if this file is gone, the evidence sandbox executed a payload\n", "utf8");
  if (plantDashDelete) await writeFile(join(root, "-delete"), "an adversarially-named file\n", "utf8");
  const planPath = join(root, "plan.json");
  await writeFile(planPath, JSON.stringify({
    evidenceQueries: [{ name: "injected", query, window: "n/a", expectAtLeast: 1 }],
  }, null, 2), "utf8");
  return { root, canary, planPath, run: () => prep(["query-check", planPath, "--repo-root", root], { cwd: root }) };
}

// Every payload here is a DIFFERENT generator or a DIFFERENT expansion mechanism. A fix that string-
// matched `printf`, or that only modelled `$(…)`, leaves most of this list green-on-the-wrong-answer.
for (const [mechanism, query, opts] of [
  ["$(…) substitution", `find . $(printf -- -delete)`, {}],
  ["backtick substitution", "find . `printf -- -delete`", {}],
  ["a different generator (echo)", `find . $(echo -delete)`, {}],
  ["a quoted substitution", `find . "$(printf -- -delete)"`, {}],
  ["ANSI-C quoting, no substitution at all", `find . $'-delete'`, {}],
  ["an unquoted glob", `find . *`, { plantDashDelete: true }],
]) {
  test(`query-check refuses ${mechanism} AND the canary file survives (DER-2836)`, async (t) => {
    const S = await sandboxWithQuery(t, query, opts);
    const r = await S.run();

    // 1. THE ASSERTION THAT FAILS ON THE PARENT COMMIT. Checked FIRST and independently of the exit
    //    code: a gate that refused loudly while the payload had already run would still be the bug.
    await access(S.canary); // throws if the payload deleted it

    // 2. And it is refused, rather than run-and-found-harmless.
    assert.equal(r.timedOut, false, "query-check TIMED OUT — UNKNOWN, not a refusal");
    assert.equal(r.code, 1, `expected a refusal (exit 1), got ${r.code}\n${r.out}`);
    assert.match(r.out, /expansion|substitut|glob/i, `the refusal must name the mechanism:\n${r.out}`);
  });
}

// The control that stops the six cases above from being satisfied by a validator that refuses
// everything: a real read-only pipeline still RUNS, and returns a real count off the real filesystem.
test("query-check still RUNS a legitimate read-only query after the DER-2836 fix", async (t) => {
  const S = await sandboxWithQuery(t, `find . -name 'canary.txt'`);
  const r = await S.run();
  await access(S.canary);
  assert.equal(r.code, 0, `a legitimate query must still run and pass:\n${r.out}`);
  assert.match(r.out, /ok\s+plan evidenceQueries\[0\]/, `expected a passing row:\n${r.out}`);
});

// Pipelines are the documented feature and they are now stitched in JS rather than by a shell. If the
// hand-rolled piping regressed, this is the case that catches it — two stages, the second consuming the
// first, counted numerically.
test("query-check pipes stage-to-stage without a shell (DER-2836)", async (t) => {
  const S = await sandboxWithQuery(t, `find . -name 'canary.txt' | grep -c canary`);
  const r = await S.run();
  assert.equal(r.code, 0, `a two-stage pipeline must still run:\n${r.out}`);
  assert.match(r.out, /1 ≥ 1/, `the second stage must have consumed the first's output:\n${r.out}`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// TIER B — LIVE. Opt in with WORK_E2E_LIVE=1. Real model calls, real GitHub, real cost.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("LIVE: preflight reports a usable environment before any run is dispatched", { skip: LIVE ? false : "set WORK_E2E_LIVE=1 to run the live tier" }, async () => {
  const r = await cli(["preflight"], { timeoutMs: 300000 });
  assert.equal(r.timedOut, false, "preflight TIMED OUT — UNKNOWN, not a failure (see DER-2829)");
  assert.match(r.out, /PREFLIGHT (GREEN|RED)/, "preflight must render a verdict line");
  assert.match(r.out, /PREFLIGHT GREEN/,
    `preflight is RED — the environment is not fit for a live run. Fix the named checks first:\n${r.out}`);
});
