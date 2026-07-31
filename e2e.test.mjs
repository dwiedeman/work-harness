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
// THREE fold defects are PROVEN LIVE (DER-2323, DER-2602, DER-2824) and each has a pin below. The pins
// assert the CURRENT BROKEN behavior on purpose. When the matching issue lands, the pin goes RED and must
// be INVERTED — that redness is the intended signal, not a regression. Without the pins, an all-green E2E
// while three defects are live would manufacture exactly the false confidence this repo's rules exist to
// prevent: a check that cannot fail is not evidence.
//
// This paragraph used to say FOUR and list DER-2810 — which never had a pin, so the count was one more
// than the file could back up, and the sentence "the pins below" was doing the vouching. DER-2810 is now
// FIXED (see the evidence-query cases at the end of this file), so it belongs in neither list. Cited
// because it is this file's own rule turned on itself: a claim about coverage is only worth what an
// actual check behind it is worth, and this one had none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, access, chmod } from "node:fs/promises";
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
function cli(args, { timeoutMs = 30000, cwd = REPO, env = null } = {}) {
  return new Promise((resolve) => {
    // `env` plays a host on a DIFFERENT BUILD (WORK_HARNESS_VERSION) without a second checkout — the
    // subprocess analogue of the unit suite's withHarnessVersion. Merged onto the parent env, never
    // replacing it: a bare env loses PATH and the child fails for a reason that has nothing to do with
    // the case under test.
    const opts = { timeout: timeoutMs, cwd, encoding: "utf8", ...(env ? { env: { ...process.env, ...env } } : {}) };
    execFile(process.execPath, [RUNNER, ...args], opts, (err, stdout, stderr) => {
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

  // DER-2838 — and the marker it wrote carries the receipt the fold requires. Asserted on the LINE ON
  // DISK rather than on the command's own report: "complete-run said it completed" is the claim under
  // test, not the evidence for it.
  const marker = (await R.events()).map((l) => JSON.parse(l)).find((e) => e.type === "run_completed");
  assert.ok(marker, "complete-run must have appended a run_completed");
  assert.equal(marker.completion_receipt?.receipt_version, 1, `the marker must carry a versioned receipt: ${JSON.stringify(marker)}`);
  assert.deepEqual(marker.completion_receipt.units, ["DER-1"], "…naming the units the gate vouched for");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DER-2838 — A RUN'S TERMINAL STATE CANNOT BE CLAIMED BY WRITING TO THE FILE
//
// The fold used to accept the FIRST `run_completed` unconditionally, and the generic `append` relay
// reserved only `gate_adjudication`. So a hand-written line ended the run and every DER-2781 check was
// moot. This is the case the unit suite structurally cannot make on its own: the receipt has to be
// rejected by the REAL reader, reading a REAL ledger, from a line written the way an attacker writes one.
//
// THE TRAP THIS CASE IS BUILT TO AVOID: a hand-written line normally folds as `unknown` because it skips
// `stampEvent` (see appendRaw above), so a forgery test can go green for a reason that has nothing to do
// with the receipt. Every forged line below is therefore stamped with the SAME field set a real
// `appendEvent` writes — copied off a real event in the same ledger, and asserted to be complete — and
// cases (b) and (c) differ from each other in EXACTLY ONE FIELD: `completion_receipt`. That pair is the
// proof that the receipt, and nothing else, is what refuses.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// The stamp `appendEvent` puts on every origin line. Named here so the forgeries can be held to it.
const STAMP_FIELDS = ["ts", "event_id", "source_id", "seq", "schema_version", "received_at"];

// A `run_completed` line written the way an attacker writes one: straight into events.jsonl, but
// indistinguishable from a stamped line. `donor` is a real event from the same ledger, so the forgery
// inherits that ledger's real `source_id`/`schema_version` instead of a guess.
function forgedCompletion(donor, { runId, units, receipt = null, seq = 9001, ts = "2126-07-30T23:59:00.000Z" }) {
  for (const k of STAMP_FIELDS) {
    assert.notEqual(donor[k], undefined, `the donor event is missing ${k} — the forgery would then be under-stamped and could be refused for the wrong reason`);
  }
  return `${JSON.stringify({
    ts, received_at: ts,
    event_id: `0197e000-0000-7000-8000-00000000f${String(seq).slice(-3)}`,
    source_id: donor.source_id, seq, schema_version: donor.schema_version,
    actor: "orch", type: "run_completed", run_id: runId, units, unit_count: units.length,
    ...(receipt ? { completion_receipt: receipt } : {}),
  })}\n`;
}

const validReceipt = (runId, units) => ({
  receipt_version: 1, run_id: runId, units: [...units].sort(), unit_count: units.length,
  checks_passed: ["kickbacks_pending", "ledger_health", "ledger_held_fragments", "ledger_quarantine", "protocol", "units_terminal", "units_tracked"],
  harness_version: "0.2.0", allow_version_skew: false, minted_by: "e2e:0:00",
});

test("FAULT forged run_completed: a hand-appended terminal marker does NOT end the run (DER-2838 #5)", async (t) => {
  const R = await newRun(t);
  await seedUnit(R); // DER-1 is at pr_open — ACTIVE
  const donor = (await R.events()).map((l) => JSON.parse(l)).find((e) => e.type === "pr_opened");

  // (a) THE ATTACK: an ACTIVE run, marked complete by a line nobody gated. On the parent commit this
  //     reads `completed` and all seven DER-2781 checks are bypassed.
  await R.appendRaw(forgedCompletion(donor, { runId: R.runId, units: ["DER-1"], seq: 9001 }));
  const active = await R.state();
  assert.equal(active.status, "running", "a forged marker must not end a run with a live unit");
  assert.ok((active.run_completion_rejected ?? []).length >= 1, "…and the rejection must be VISIBLE, not silent");

  // (a2) THE SAME ATTACK WITH A WELL-FORMED RECEIPT. Case (a) alone is refused for MISSING a receipt, so
  //      on its own it says nothing about the cross-check — measured: with the ledger cross-check
  //      neutered, (a) stayed green. This is the case that fails there. A forger who writes a perfect
  //      receipt still cannot complete a run holding a `pr_open` unit, because the fold derives
  //      terminality from the ledger and no receipt field moves it.
  await R.appendRaw(forgedCompletion(donor, { runId: R.runId, units: ["DER-1"], seq: 9004, ts: "2126-07-30T23:59:30.000Z", receipt: validReceipt(R.runId, ["DER-1"]) }));
  const receiptedForgery = await R.state();
  assert.equal(receiptedForgery.status, "running", "a well-formed receipt must not complete a run with a live unit");
  assert.match(String(receiptedForgery.run_completion_rejected?.at(-1)?.reason ?? ""), /NOT terminal/,
    "…and the rejection must name the ledger fact that refused it, not the receipt's shape");

  // (b) THE SAME FORGERY over an ALL-TERMINAL run: still refused. Terminality alone is not the receipt.
  const R2 = await newRun(t);
  await seedUnit(R2);
  await R2.append({ actor: "orch", type: "pr_merged", issue: "DER-1", pr: 1 });
  await R2.append({ actor: "orch", type: "reaped", issue: "DER-1" });
  const donor2 = (await R2.events()).map((l) => JSON.parse(l)).find((e) => e.type === "reaped");
  await R2.appendRaw(forgedCompletion(donor2, { runId: R2.runId, units: ["DER-1"], seq: 9002 }));
  const unreceipted = await R2.state();
  assert.equal(unreceipted.status, "running", "an unreceipted marker is not a completion even when the units really are terminal");
  assert.match(String(unreceipted.run_completion_rejected?.[0]?.reason ?? ""), /receipt/i,
    "the reason must be the RECEIPT — if it names the stamp or the version, this case proves nothing about DER-2838");

  // (c) CONTROL, and the discriminator: the SAME line as (b), same run, same raw write, same stamp —
  //     plus a valid receipt. It completes. So (b) was refused by the receipt check and by nothing else.
  const R3 = await newRun(t);
  await seedUnit(R3);
  await R3.append({ actor: "orch", type: "pr_merged", issue: "DER-1", pr: 1 });
  await R3.append({ actor: "orch", type: "reaped", issue: "DER-1" });
  const donor3 = (await R3.events()).map((l) => JSON.parse(l)).find((e) => e.type === "reaped");
  await R3.appendRaw(forgedCompletion(donor3, { runId: R3.runId, units: ["DER-1"], seq: 9003, receipt: validReceipt(R3.runId, ["DER-1"]) }));
  const receipted = await R3.state();
  assert.equal(receipted.status, "completed",
    "a receipted marker over an all-terminal run MUST complete it — otherwise the fix broke completion instead of gating it");
  assert.deepEqual(receipted.run_completion_rejected, []);
});

test("FAULT `append` refuses a run_completed — the write-time reservation (DER-2838 #5)", async (t) => {
  const R = await newRun(t);
  await seedUnit(R);
  await R.append({ actor: "orch", type: "pr_merged", issue: "DER-1", pr: 1 });
  await R.append({ actor: "orch", type: "reaped", issue: "DER-1" });
  const before = (await R.events()).length;

  const r = await R.run(["append", "--run", R.runId, JSON.stringify({ actor: "orch", type: "run_completed", run_id: R.runId, units: ["DER-1"], unit_count: 1 })]);
  refused(r);
  assert.match(r.out, /run_completed/, "the refusal must name the reserved type");
  assert.match(r.out, /complete-run/, "…and point at the subcommand that owns it");
  assert.equal((await R.events()).length, before, "a refused append must write NOTHING");

  // CONTROL — `append` still relays everything else. Without it, this case is satisfied by an `append`
  // that refuses its whole input.
  succeeded(await R.run(["append", "--run", R.runId, JSON.stringify({ actor: "orch", type: "note", note: "ok" })]));
  assert.equal((await R.events()).length, before + 1);

  // …and the reserved path still works: the real subcommand completes the same run.
  succeeded(await R.run(["complete-run", "--run", R.runId]));
});

test("FAULT complete-run from a DIFFERENT harness build is refused (DER-2838 #8)", async (t) => {
  // DER-2779 gave dispatch the missing half — the ACTING process's own version is one of the versions
  // compared. `complete-run` never got it, so a caller on another build passed the protocol check and
  // then auto-attested its version during the append, leaving the completed run mixed.
  const R = await newRun(t);
  await seedUnit(R);
  await R.append({ actor: "orch", type: "pr_merged", issue: "DER-1", pr: 1 });
  await R.append({ actor: "orch", type: "reaped", issue: "DER-1" });

  const skewed = await R.run(["complete-run", "--run", R.runId], { env: { WORK_HARNESS_VERSION: "9.9.9" } });
  refused(skewed);
  assert.match(skewed.out, /mixed harness version/i, "the refusal must name the protocol finding");
  assert.match(skewed.out, /9\.9\.9/, "…and the version THIS process is running");
  assert.equal((await R.state()).status, "running", "nothing was appended and the run is still open");

  // CONTROL 1 — the documented escape reaches this refusal too, or a mid-run-upgraded host could never
  // close the run it is holding.
  succeeded(await R.run(["complete-run", "--run", R.runId, "--dry-run", "--allow-version-skew"], { env: { WORK_HARNESS_VERSION: "9.9.9" } }));
  // CONTROL 2 — a same-version caller still completes. Proves the gate discriminates on the version
  // rather than refusing every completion.
  succeeded(await R.run(["complete-run", "--run", R.runId]));
  assert.equal((await R.state()).status, "completed");
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
// DER-2839 — a remote read that FAILED must not be reported as a remote that was EMPTY
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// The remote tail used to end in `2>/dev/null || true`. That suffix collapses three different remote
// answers — "the file is missing", "I am not allowed to read it", "the read failed" — into the single
// answer "it read fine and there was nothing there". The empty-body path then calls recordHeldFragment
// with a null fragment, which DELETES the held-fragment record: the completion-blocking damage signal
// DER-2776 exists to preserve is erased by a read that never happened.
//
// This is the inversion DER-2776 was written to prevent, arriving through the shell instead of the
// parser: uncertainty laundered into a clean receipt. The harness already draws the distinction it
// needed here — classifyKillProbe's "'I could not look' and 'it is dead' are different facts" — so the
// fix is to let the read FAIL (propagate tail's exit status) and preserve both the cursor and the hold.
//
// The fixture is a real `pull-host` subprocess against a real ssh stub that runs the remote command
// locally with a real `tail`, so what is under test is the command the harness actually builds.

// A run whose config declares a `mini` host, plus a stub `ssh` that executes the remote command against
// a local directory standing in for the remote ledger root.
// `remoteDirName` puts the ledger root in a SUBDIRECTORY of that name — the seam for exercising a path
// that needs shell quoting (a space, a metacharacter) without weakening the default fixture.
async function newPullHostRun(t, { remoteDirName = null } = {}) {
  const runsRoot = await mkdtemp(join(tmpdir(), "wh-e2e-ph-runs-"));
  const repoRoot = await mkdtemp(join(tmpdir(), "wh-e2e-ph-repo-"));
  const remoteBase = await mkdtemp(join(tmpdir(), "wh-e2e-ph-remote-"));
  const remoteRoot = remoteDirName ? join(remoteBase, remoteDirName) : remoteBase;
  if (remoteDirName) await mkdir(remoteRoot, { recursive: true });
  t.after(() => Promise.all([runsRoot, repoRoot, remoteBase].map((d) => rm(d, { recursive: true, force: true }))));

  await mkdir(join(repoRoot, ".claude"), { recursive: true });
  await writeFile(join(repoRoot, ".claude", "work.config.json"), JSON.stringify({
    hosts: {
      local: { cap: 2 },
      mini: { enabled: true, cap: 2, ssh: "example-mini-host", ledgerRoot: remoteRoot },
    },
  }), "utf8");

  // `ssh <host> <command>` → run <command> locally. Real /bin/sh, real tail, real exit codes: the point
  // of this fixture is that the harness's own command string is what decides the outcome. The command is
  // also LOGGED verbatim, so a test can compare what executed against what `--dry-run` printed.
  // The stub lives OUTSIDE the ledger root, so a ledger root with a space in it does not put a space in
  // PATH — which would break the fixture for a reason unrelated to the case under test.
  const bin = join(remoteBase, "bin");
  await mkdir(bin, { recursive: true });
  const sshStub = join(bin, "ssh");
  const sshLog = join(remoteBase, "ssh.log");
  await writeFile(sshStub, `#!/bin/sh\nprintf '%s\\n' "$2" >> ${JSON.stringify(sshLog)}\nexec /bin/sh -c "$2"\n`, "utf8");
  await chmod(sshStub, 0o755);

  const env = { PATH: `${bin}:${process.env.PATH}` };
  const init = await cli(["init-run", "--project", "sandbox", "--runs-root", runsRoot, "--repo-root", repoRoot], { env });
  succeeded(init);
  const runId = init.stdout.trim().split("\n").filter(Boolean).pop();
  const runDir = join(runsRoot, runId);
  const remoteDir = join(remoteRoot, runId);
  await mkdir(remoteDir, { recursive: true });
  const remoteLedger = join(remoteDir, "events.jsonl");
  const heldPath = join(runDir, "sync-held.mini.json");

  return {
    runId, runDir, remoteLedger, heldPath,
    writeRemote: (text) => writeFile(remoteLedger, text, "utf8"),
    pull: (extra = []) => cli(
      ["pull-host", "--run", runId, "--host", "mini", "--repo-root", repoRoot, "--runs-root", runsRoot, ...extra],
      { env },
    ),
    cursor: async () => Number.parseInt(await readFile(join(runDir, "sync-cursor.mini"), "utf8").catch(() => "0"), 10) || 0,
    // Tolerant: a missing hold file must fail as an ASSERTION about behaviour, not as an ENOENT. A test
    // that crashes on the parent proves nothing about what the parent does.
    held: async () => JSON.parse(await readFile(heldPath, "utf8").catch(() => "null")),
    sshCommands: async () => (await readFile(sshLog, "utf8").catch(() => "")).split("\n").filter(Boolean),
    // The unattended consumer: `watch` folds the per-host pull into its poll cycle. A short timeout is
    // enough — the pull runs immediately on entry, before the first wait.
    watch: () => cli(
      ["watch", "--run", runId, "--runs-root", runsRoot, "--repo-root", repoRoot, "--pull-hosts", "mini", "--timeout", "1"],
      { env },
    ),
    append: (ev) => cli(["append", "--run", runId, "--runs-root", runsRoot, JSON.stringify(ev)], { env }),
  };
}

const PH_LINE1 = `${JSON.stringify({ actor: "lead:DER-9", type: "lead_spawned", issue: "DER-9", ts: "2026-07-30T10:00:00.000Z" })}\n`;
const PH_TORN = '{"actor":"lead:DER-9","type":"pr_opened","issue":"DER-9","pr":';

// Two ways for the remote read to fail. Both used to exit 0 with empty stdout, and both therefore looked
// identical to a clean pull that found nothing new. Parameterised because a fix that only handles the
// missing file leaves the unreadable one laundered — the "incomplete change across a family" shape.
for (const [mode, breakRemote] of [
  ["the remote ledger is MISSING", async (R) => rm(R.remoteLedger, { force: true })],
  ["the remote ledger is UNREADABLE", async (R) => chmod(R.remoteLedger, 0o000)],
]) {
  test(`FAULT ${mode}: the pull FAILS, and does not clear the held fragment or move the cursor (DER-2839)`, async (t) => {
    const R = await newPullHostRun(t);

    // Set the scene with a real torn tail, so there is a hold worth destroying.
    await R.writeRemote(`${PH_LINE1}${PH_TORN}`);
    succeeded(await R.pull());
    const before = await R.held();
    assert.ok(before?.first_seen_at,
      `CONTROL: the fixture must actually produce a hold, or the assertion below is vacuous — got ${JSON.stringify(before)}`);
    assert.equal(await R.cursor(), 1, "CONTROL: the one complete line was merged");

    await breakRemote(R);
    const r = await R.pull();

    // 1. THE ASSERTION THAT FAILS ON THE PARENT COMMIT. On the parent the hold file was deleted here, by
    //    a pull that read nothing at all.
    const after = await R.held();
    assert.ok(after?.first_seen_at,
      `a read that FAILED must not clear the held fragment — the hold is gone, got ${JSON.stringify(after)}`);
    assert.equal(after.first_seen_at, before.first_seen_at, "…and must not restart the hold's age clock");

    // 2. And the failure is REPORTED as a failure, not as a clean empty pull.
    assert.equal(r.timedOut, false, "pull-host TIMED OUT — UNKNOWN, not a failure");
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.pull_failed, true, `a failed read must say so rather than reporting a clean zero:\n${r.out}`);
    assert.equal(rep.pulled, 0);
    assert.equal(await R.cursor(), 1, "a pull that read nothing must not move the cursor");

    // 3. The RESPONSE CONTRACT, not just the on-disk state. Without these, an implementation that kept
    //    the hold on disk but reported `held: null` with no reason would pass everything above — and
    //    `held: null` is precisely the "nothing is held" laundering this fix exists to remove, one layer
    //    up from the shell. (Codex review of this change, #3.)
    assert.equal(rep.held?.first_seen_at, before.first_seen_at,
      `the failure response must REPORT the hold it preserved, got ${JSON.stringify(rep.held)}`);
    assert.ok(typeof rep.pull_error === "string" && rep.pull_error.trim(),
      `the failure must carry a reason, got ${JSON.stringify(rep.pull_error)}`);
    // The reason must be the REMOTE'S OWN stderr, which is the whole point of dropping `2>/dev/null`.
    // The first draft of this assertion listed `exit \d+` as an accepted match — the generic fallback
    // used when there is no stderr at all, i.e. it accepted the very placeholder its message forbade,
    // and would have stayed green if the suppression came back. (Codex round 2, #4.)
    assert.doesNotMatch(rep.pull_error, /^exit \d+$/,
      `"${rep.pull_error}" is the no-stderr fallback, not a reason — the remote's stderr was discarded`);
    assert.match(rep.pull_error, /No such file|not permitted|Permission denied|cannot open/i,
      `the reason must describe the ACTUAL failure: ${JSON.stringify(rep.pull_error)}`);
  });
}

// A hold that EXISTS but cannot be vouched for is not an absent hold. `readHeldFragments` already states
// this rule for the whole family ("a hold we cannot age is one we cannot vouch for, so it counts as stale
// rather than silently disappearing"); the failure path must not disagree with its own sibling.
// (Codex review of this change, #2 — the first draft returned a bare null here.)
test("FAULT an UNREADABLE hold record reports as unknown, never as 'nothing held' (DER-2839)", async (t) => {
  const R = await newPullHostRun(t);
  await R.writeRemote(`${PH_LINE1}${PH_TORN}`);
  succeeded(await R.pull());
  assert.ok((await R.held())?.first_seen_at, "CONTROL: a real hold exists before it is corrupted");

  await writeFile(R.heldPath, "{ this is not json", "utf8"); // the hold is there; it cannot be read
  await rm(R.remoteLedger, { force: true });                 // …and the remote read fails too
  const rep = JSON.parse((await R.pull()).stdout);

  assert.equal(rep.pull_failed, true);
  assert.notEqual(rep.held, null,
    `an unreadable hold must not be reported as no hold at all, got ${JSON.stringify(rep.held)}`);
  assert.equal(rep.held?.unreadable, true, `…it must say it is unvouchable: ${JSON.stringify(rep.held)}`);
  assert.equal(rep.held?.stale, true, "…and count as stale, matching readHeldFragments' stated rule");
});

// PARSING is not the bar — AGEING is. `{}` is valid JSON and a valid object, so it slipped past the first
// draft's structural check and reported as a hold in good standing with a null age. The family rule is
// `readHeldFragments`': a record it cannot date is stale. (Codex round 2, #3.)
test("FAULT a hold record that PARSES but cannot be aged is still unvouchable (DER-2839)", async (t) => {
  const R = await newPullHostRun(t);
  await R.writeRemote(`${PH_LINE1}${PH_TORN}`);
  succeeded(await R.pull());
  assert.ok((await R.held())?.first_seen_at, "CONTROL: a real, ageable hold exists first");

  await writeFile(R.heldPath, "{}", "utf8"); // parses; carries no first_seen_at
  await rm(R.remoteLedger, { force: true });
  const rep = JSON.parse((await R.pull()).stdout);
  assert.equal(rep.held?.unreadable, true,
    `a hold with no ageable first_seen_at must not read as one in good standing, got ${JSON.stringify(rep.held)}`);

  // CONTROL: a record that parses AND dates is still accepted — the check must not reject every hold.
  await writeFile(R.heldPath, JSON.stringify({ host: "mini", cursor: 1, first_seen_at: "2026-07-30T10:00:00.000Z", bytes: 12 }), "utf8");
  const ok = JSON.parse((await R.pull()).stdout);
  assert.equal(ok.held?.unreadable, undefined, `a well-formed hold must still be vouched for, got ${JSON.stringify(ok.held)}`);
  assert.equal(ok.held?.first_seen_at, "2026-07-30T10:00:00.000Z");
});

// THE CONTROL that stops the two cases above from being satisfied by a fix that simply calls every pull a
// failure — which would wedge the mini lane while looking like a security improvement.
test("a genuinely empty-but-successful remote read still succeeds and holds nothing (DER-2839 control)", async (t) => {
  const R = await newPullHostRun(t);
  await R.writeRemote(PH_LINE1); // one complete line, no tear
  succeeded(await R.pull());
  assert.equal(await R.cursor(), 1);
  assert.equal(await R.held(), null, "a clean pull holds nothing");

  const r = await R.pull(); // nothing new past the cursor: a real, successful, empty read
  succeeded(r);
  const rep = JSON.parse(r.stdout);
  assert.notEqual(rep.pull_failed, true, `an empty-but-successful read is NOT a failure:\n${r.out}`);
  assert.equal(rep.pulled, 0);
  assert.equal(await R.cursor(), 1, "…and it does not move the cursor either");
});

// The second site. `pull-host --dry-run` PRINTS the command instead of running it, and printed a
// separately-written copy of the same string — so the operator's preview could drift from what executes.
// Asserting they are the same string is what makes one builder the only way to keep this green.
test("the dry-run preview prints the SAME command the pull executes, with no `|| true` (DER-2839)", async (t) => {
  const R = await newPullHostRun(t);
  await R.writeRemote(PH_LINE1);

  // The strong form: capture what the ssh stub was ACTUALLY handed, and compare the preview against it.
  // Asserting only that the preview lacks `|| true` would stay green if production drifted to a
  // different path, cursor, or separately-built command — which is the whole failure mode a preview has.
  // (Codex review of this change, #4.)
  //
  // ORDER MATTERS, and the first draft of this test got it wrong: a successful pull ADVANCES the cursor,
  // so a preview taken afterwards correctly prints `tail -n +2` against an executed `tail -n +1` and the
  // comparison fails on a real difference that is not drift. Both must be observed at the SAME cursor —
  // the dry-run first (it advances nothing), then the pull.
  const r = await R.pull(["--dry-run"]);
  succeeded(r);
  succeeded(await R.pull());
  const executed = await R.sshCommands();
  assert.equal(executed.length, 1, `expected exactly one ssh command, saw ${executed.length}`);
  // The preview prints `ssh <host> <shell-quoted command>`; unwrap it back to the command itself.
  const printed = r.stdout.trim();
  const m = printed.match(/^ssh \S+ (.*)$/s);
  assert.ok(m, `the preview must print an ssh invocation, got ${JSON.stringify(printed)}`);
  const preview = m[1].startsWith("'") && m[1].endsWith("'")
    ? m[1].slice(1, -1).replace(/'\\''/g, "'")
    : m[1];
  assert.equal(preview, executed[0],
    `the preview must be the command that runs.\n  preview:  ${preview}\n  executed: ${executed[0]}`);

  // …and neither carries the laundering, stated on the executed string so this cannot pass on a preview
  // that merely looks clean.
  assert.doesNotMatch(executed[0], /\|\|\s*true/, `the executed command still masks its exit status: ${executed[0]}`);
  assert.doesNotMatch(executed[0], /2>\s*\/dev\/null/, `the executed command still discards the reason: ${executed[0]}`);
});

// `pull-host` is the operator's manual call; `watch --pull-hosts` is the one that runs UNATTENDED, and it
// awaited the pull and discarded the result. So a mini whose ledger is permanently unreadable stopped
// ingesting events indefinitely while the operator saw routine watch output — the failure signal this fix
// introduces, thrown away by its own primary consumer. (Codex review of this change, #1.)
test("FAULT `watch --pull-hosts` SURFACES a failed remote read instead of swallowing it (DER-2839)", async (t) => {
  const R = await newPullHostRun(t);
  await R.writeRemote(PH_LINE1);

  // CONTROL FIRST: a healthy host reports NO pull failure. Without this, the assertion below passes on an
  // implementation that reports every host as failing, forever.
  const healthy = await R.watch();
  succeeded(healthy);
  assert.deepEqual(JSON.parse(healthy.stdout).pending.pull_failed, [],
    `a healthy host must not be reported as failing:\n${healthy.out}`);

  await rm(R.remoteLedger, { force: true });
  const broken = await R.watch();
  succeeded(broken);
  const failures = JSON.parse(broken.stdout).pending.pull_failed;
  assert.equal(failures.length, 1, `the unreadable host must surface on the wake, got ${JSON.stringify(failures)}`);
  assert.equal(failures[0].host, "mini", "…named");
  assert.match(failures[0].why, /No such file|cannot open/i,
    `…and carrying the remote's own reason, got ${JSON.stringify(failures[0].why)}`);
});

// The other half of that signal: a host the run has NEVER read from and NEVER dispatched to has no ledger
// because nothing has run there. Reporting it every wake would put a permanent banner on a healthy run —
// and a banner that is always on is one operators learn to skim, which destroys the signal above rather
// than adding to it. (Codex round 2, #2.)
test("`watch --pull-hosts` stays SILENT about a host the run never used (DER-2839)", async (t) => {
  const R = await newPullHostRun(t);
  await rm(R.remoteLedger, { force: true }); // never written: nothing was ever dispatched to mini

  const r = await R.watch();
  succeeded(r);
  assert.deepEqual(JSON.parse(r.stdout).pending.pull_failed, [],
    `a host that never started is not a failure to report:\n${r.out}`);

  // …but the silence is EVIDENCE-BASED, not blanket. Dispatch a lead there and the same unreadable
  // ledger becomes news. Without this control the test above would also pass on a fix that simply
  // deleted the signal.
  succeeded(await R.append({ actor: "orch", type: "lead_spawned", issue: "DER-9", host: "mini", worktree: "/wt/DER-9" }));
  const after = await R.watch();
  succeeded(after);
  const failures = JSON.parse(after.stdout).pending.pull_failed;
  assert.equal(failures.length, 1,
    `once the run dispatched to that host, an unreadable ledger IS news, got ${JSON.stringify(failures)}`);
  assert.equal(failures[0].host, "mini");

  // …and it CLEARS on the next successful pull. Without this the latch could be write-only: a signal that
  // arrives correctly and then never goes away is a permanent banner by another route. (Codex round 3, #4
  // — an earlier draft of the CHANGELOG claimed this was covered when it was not.)
  await R.writeRemote(PH_LINE1);
  const healed = await R.watch();
  succeeded(healed);
  assert.deepEqual(JSON.parse(healed.stdout).pending.pull_failed, [],
    `a successful pull must clear the latch, got ${healed.stdout}`);
});

// The path is interpolated into a string the REMOTE SHELL evaluates. A `ledgerRoot` containing a space is
// valid configuration and used to split into two operands, failing every pull. (Codex review, #5 —
// pre-existing on main, closed here because the shared builder is now the only site that constructs it.)
test("a remote ledger path containing a space still pulls (DER-2839, shell-quoting)", async (t) => {
  const R = await newPullHostRun(t, { remoteDirName: "Work Ledger" });
  await R.writeRemote(PH_LINE1);
  const r = await R.pull();
  succeeded(r);
  const rep = JSON.parse(r.stdout);
  assert.notEqual(rep.pull_failed, true, `a space in ledgerRoot must not fail the pull:\n${r.out}`);
  assert.equal(rep.pulled, 1, `the line must actually be merged, got ${JSON.stringify(rep)}`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DER-2841 / DER-2810 / DER-2808 — an evidence query must not be able to buy a pass it did not earn
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// DER-2783 established the rule these three defeat from different directions: a run that did not exit 0
// is a FAILED run, not a count. Each of these is a way to be stamped `ok N ≥ 1` while having measured
// nothing, and all three are shaped like something an author would plausibly write.
//
//   DER-2841  `grep -c PATTERN a.txt b.txt` prints `path:count` ROWS. Numeric mode declines a non-scalar,
//             and the line-counting fallback then counted the ROWS — i.e. the number of files SEARCHED.
//             Files matching zero times counted as matches. The wider the search, the bigger the lie.
//   DER-2810  `… || true` / `… ; true` / `… | cat` each exit 0 with stdout `0` and move the counting
//             command off the end of the pipeline, so the single line `0` is line-counted as 1.
//   DER-2808  a query beginning with a bare separator silently lost its leading segment in the parse.
//
// Driven through the real `prep-runner.mjs` subprocess against a real filesystem, because the defect is
// in what an author READS at the surface, not in a predicate's return value.

// A repo with two files and a plan whose single evidence query is `query`.
async function planWithQuery(t, query, { expectAtLeast = 1, files = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wh-e2e-ev-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body, "utf8");
  const planPath = join(root, "plan.json");
  await writeFile(planPath, JSON.stringify({
    evidenceQueries: [{ name: "claim", query, window: "n/a", expectAtLeast }],
  }, null, 2), "utf8");
  return { root, run: () => prep(["query-check", planPath, "--repo-root", root], { cwd: root }) };
}

const TWO_EMPTY = { "a.txt": "nothing here\n", "b.txt": "nor here\n" };

// ONE real match plus TWO zero-count files — the fixture the issue names, and the only shape that reaches
// this defect end to end. It matters that at least one file matches: with NO matches anywhere `grep -c`
// exits 1 and DER-2783's exit-status gate refuses the query before its output is ever read, so an
// all-zero fixture is refused on both the parent and the fix and proves nothing. Here grep exits 0, and
// the three rows were counted as three matches.
const ONE_MATCH_TWO_ZEROS = { "a.txt": "x\n", "b.txt": "nothing\n", "c.txt": "nothing\n" };

test("FAULT multi-file `grep -c`: one real match is not three (DER-2841)", async (t) => {
  // THE ASSERTION THAT FAILS ON THE PARENT. There, stdout is "a.txt:1\nb.txt:0\nc.txt:0", the fallback
  // counted three ROWS, and `3 >= 3` stamped a single match as three. The inflation is exactly the number
  // of files searched, so widening the search makes the fabricated count grow.
  const S = await planWithQuery(t, `grep -c 'x' a.txt b.txt c.txt`, { expectAtLeast: 3, files: ONE_MATCH_TWO_ZEROS });
  const r = await S.run();
  assert.equal(r.timedOut, false, "query-check TIMED OUT — UNKNOWN, not a refusal");
  assert.equal(r.code, 1, `one match must not satisfy a floor of three:\n${r.out}`);
  assert.match(r.out, /PER-FILE counts across 3 files/, `and it must say WHY, not just fail a floor:\n${r.out}`);
  assert.match(r.out, /number of files SEARCHED/, `naming the wrong number the old fallback reported:\n${r.out}`);
  assert.doesNotMatch(r.out, /\bok\s+plan evidenceQueries\[0\]/, `it must not be stamped ok:\n${r.out}`);
});

// The SAME fallback was wrong in the other direction too, which only came out while building the
// over-refusal guard for it (Codex review of this change). `-H` forces the path prefix on a SINGLE file,
// so stdout is `a.txt:2` — one unambiguous count. The old fallback line-counted it to **1** and failed a
// floor of 2, so a legitimate query UNDER-reported; the first version of this fix then refused it
// outright, telling the author to narrow a query that was already narrow.
//
// So this is a third defect, not a control: row-counting over-reported across many files and
// under-reported on one prefixed file, and only a scalar ever gave the right answer. One row is now read
// as the number it is. The real both-sides control is the "legitimate evidence queries" case below.
test("FAULT a single-file `grep -Hc` under-reported its own count (DER-2841)", async (t) => {
  const S = await planWithQuery(t, `grep -Hc 'x' a.txt`, { expectAtLeast: 2, files: { "a.txt": "x\nx\n" } });
  const r = await S.run();
  assert.equal(r.code, 0, `one prefixed row is a count, not a per-file breakdown:\n${r.out}`);
  assert.match(r.out, /2 ≥ 2/, `and it must read the NUMBER (parent read the ROW, and answered 1):\n${r.out}`);
});

// DER-2810, stated as MEASURED rather than as filed. The issue predicts that all three suffixes are
// stamped `ok 1 ≥ 1`. Only ONE of them is, and the difference is worth recording because it changes what
// each test proves:
//
//   `| cat`      grep's `0` is PIPED through cat, so stdout is the line "0", the counting command is no
//                longer last (numeric mode off), and one line clears a floor of 1. Measured on the
//                parent: exit 0, `ok 1 ≥ 1`. A REAL false pass.
//   `|| true`    the trailing `true` is joined by `||`/`;`, not a pipe, so ITS stdout — empty — is what
//   `; true`     gets evaluated. Count 0, floor 1, refused. Measured on the parent: exit 1,
//                `returned 0 < 1`. They mask the exit status but did NOT buy a pass in this executor.
//
// All three are still refused, because masking DER-2783's exit-status signal is the thing being closed
// and `|| true` is one keystroke from a form that does pass (`|| echo 1`). But only the `| cat` case is
// evidence of a closed FALSE PASS; the other two are evidence that the validator now refuses the shape.
for (const [mechanism, suffix, provesFalsePass] of [
  ["a trailing pipe into `cat`", "| cat", true],
  ["`|| true`", "|| true", false],
  ["`; true`", "; true", false],
]) {
  const what = provesFalsePass ? "cannot launder a zero-match query into a pass" : "is refused (it masks the exit status)";
  test(`FAULT ${mechanism} ${what} (DER-2810)`, async (t) => {
    const S = await planWithQuery(t, `grep -c 'ZZZ' a.txt ${suffix}`, { files: TWO_EMPTY });
    const r = await S.run();
    assert.equal(r.timedOut, false);
    assert.equal(r.code, 1, `the suffix must not buy a pass:\n${r.out}`);
    assert.match(r.out, /suppresses the exit status|pass-through/, `the refusal must name the mechanism:\n${r.out}`);
    if (provesFalsePass) {
      // Only this case can carry the claim, so only this case asserts it: on the parent this exact query
      // printed `ok  plan evidenceQueries[0] "claim": 1 ≥ 1`.
      assert.doesNotMatch(r.out, /1 ≥ 1/, `the parent stamped this ok 1 ≥ 1 — that must be gone:\n${r.out}`);
    }
  });
}

test("FAULT a query beginning with a bare separator is refused, naming the operator (DER-2808)", async (t) => {
  const S = await planWithQuery(t, `| wc -l`, { files: TWO_EMPTY });
  const r = await S.run();
  assert.equal(r.code, 1, `a query with no leading command must be refused:\n${r.out}`);
  assert.match(r.out, /begins with the separator/, `and name the operator:\n${r.out}`);
});

// THE CONTROLS. Without these, every case above is satisfied by a validator that refuses everything —
// which would take the whole evidence gate offline while reading as a security improvement.
test("legitimate evidence queries still RUN and still pass after DER-2841/2810/2808", async (t) => {
  // Single file, bare integer: the documented numeric-mode shape, and the one DER-2783 exists to serve.
  const single = await planWithQuery(t, `grep -c 'x' a.txt`, { expectAtLeast: 3, files: { "a.txt": "x\nx\nx\n" } });
  const r1 = await single.run();
  assert.equal(r1.code, 0, `a single-file counting query must still pass:\n${r1.out}`);
  assert.match(r1.out, /3 ≥ 3/, `and read the NUMBER, not the line:\n${r1.out}`);

  // A multi-file search ending in `| wc -l` — the remedy the refusal message actually recommends. If this
  // failed, the message would be sending authors somewhere that does not work.
  const piped = await planWithQuery(t, `grep -c 'x' a.txt b.txt | wc -l`, { expectAtLeast: 2, files: { "a.txt": "x\n", "b.txt": "x\nx\n" } });
  const r2 = await piped.run();
  assert.equal(r2.code, 0, `the remedy the refusal recommends must itself work:\n${r2.out}`);

  // A non-counting pipeline is untouched by all of this.
  const lines = await planWithQuery(t, `grep -rn 'x' a.txt`, { expectAtLeast: 2, files: { "a.txt": "x\nx\n" } });
  assert.equal((await lines.run()).code, 0, "line-counting queries are unaffected");
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
