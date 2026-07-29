// Unit tests for prep-runner.mjs — run with: node --test prep-runner.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PLAN_BUDGET, SURFACES, CORE_UNIT, RISK_LANES, HIGH_RISK_LANES,
  sizeIssue, expectedRounds, suggestSplit, verifySurfacePaths,
  validatePlan, budgetFor, renderPlanMd, scaffoldPlan, calibrate,
  parseArgs, runSubcommand, usage,
  planReviewPrompt, planReviewAccepted, applyPlanReview, PLAN_REVIEW_SCHEMA,
  CALIBRATION, applyCalibration,
  LINEAR_ID_RE, SPEC_UNIT_RE,
} from "./prep-runner.mjs";

// ---- sizing ----

test("sizeIssue: pure-logic issue is a one-PR unit", () => {
  const est = sizeIssue({ surfaces: [], coreUnits: 1 });
  assert.equal(est.expectedFiles, CORE_UNIT.files);
  assert.equal(est.expectedAdditions, CORE_UNIT.additions);
  assert.equal(est.overBudget, false);
  assert.equal(est.splitInto, 1);
});

test("sizeIssue: a command drags its 7 lockstep files with it", () => {
  const est = sizeIssue({ surfaces: ["command"], coreUnits: 1 });
  assert.equal(est.expectedFiles, CORE_UNIT.files + SURFACES.command.files);
  assert.equal(est.expectedAdditions, CORE_UNIT.additions + SURFACES.command.additions);
  assert.deepEqual(est.versionAxes, ["reference-guide"]);
  // 10 files / 500 additions — the shape of the 0.18-kickback run's PRs, still under budget.
  assert.equal(est.overBudget, false);
});

test("sizeIssue: migration flags the docker requirement and the number axis", () => {
  const est = sizeIssue({ surfaces: ["migration"], coreUnits: 1 });
  assert.equal(est.needsDocker, true);
  assert.deepEqual(est.versionAxes, ["migration-number"]);
});

test("sizeIssue: a U3-shaped issue busts the budget and gets a surface-lane split", () => {
  // "external operator authentication and execution" — command + mcp + ui + api + protocol at once.
  const est = sizeIssue({ surfaces: ["command", "mcp-tool", "ui", "api-route", "protocol"], coreUnits: 5 });
  assert.equal(est.overBudget, true);
  assert.ok(est.expectedFiles > PLAN_BUDGET.files);
  assert.ok(est.expectedAdditions > PLAN_BUDGET.additions);
  assert.ok(est.splitInto >= 3, `expected >=3 children, got ${est.splitInto}`);
  assert.equal(est.split.axis, "surface");
  assert.ok(est.split.groups.length >= 2);
});

test("sizeIssue: single-lane overflow has no surface seam, says so", () => {
  const est = sizeIssue({ surfaces: ["ui"], coreUnits: 6 });
  assert.equal(est.overBudget, true);
  assert.equal(est.split.axis, "stage-or-class");
  assert.match(est.split.how, /class-member group/);
});

test("sizeIssue: dedupes surfaces and rejects unknown ones", () => {
  const est = sizeIssue({ surfaces: ["ui", "ui"], coreUnits: 0 });
  assert.equal(est.expectedFiles, SURFACES.ui.files);
  assert.throws(() => sizeIssue({ surfaces: ["nope"] }), /unknown surface/);
});

test("sizeIssue: extras are additive; coreUnits 0 is allowed", () => {
  const est = sizeIssue({ surfaces: [], coreUnits: 0, extraFiles: 3, extraAdditions: 90 });
  assert.equal(est.expectedFiles, 3);
  assert.equal(est.expectedAdditions, 90);
});

test("expectedRounds: the measured dose-response buckets", () => {
  assert.equal(expectedRounds(500), 1.25);
  assert.equal(expectedRounds(2000), 2.7);
  assert.equal(expectedRounds(4000), 3.38);
  assert.equal(expectedRounds(11537), 5.67); // the 98-file PR that never merged
});

test("suggestSplit: groups surfaces into lanes", () => {
  const s = suggestSplit(["migration", "ui"], 2);
  assert.equal(s.axis, "surface");
  assert.deepEqual(s.groups.map((g) => g.lane).sort(), ["data", "web"]);
});

// ---- the fan-out table must match the real repo ----

test("verifySurfacePaths: reports missing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prep-"));
  try {
    const v = await verifySurfacePaths(dir);
    assert.equal(v.ok, false);
    assert.ok(v.missing.length > 0);
    await mkdir(join(dir, "docs"), { recursive: true });
    const v2 = await verifySurfacePaths(dir);
    assert.ok(v2.results.some((r) => r.path === "docs" && r.ok));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- plan validation ----

const goodIssue = (over = {}) => ({
  id: "DER-1000",
  budget: { files: 9, additions: 500 },
  surfaces: ["command"],
  riskLane: "mechanical",
  leadType: "claude",
  versionAxes: [],
  dependsOn: [],
  bundleWith: [],
  // The plan-review gate is MANDATORY (2026-07-29), so a dispatchable fixture carries one. Kept in the
  // shared fixture on purpose: every existing test then runs with the gate ON, rather than opting out.
  planReview: { verdict: "plan is sound", commands: 14, reviewedAt: "2026-07-29T00:00:00.000Z", model: "codex" },
  watchOuts: [],
  ...over,
});
const goodPlan = (issues, over = {}) => ({
  issues,
  serialization: [],
  decisions: [{ q: "any founder gates?", a: "none", by: "operator", at: "2026-07-25" }],
  ...over,
});

test("validatePlan: a well-formed plan is dispatchable", () => {
  const res = validatePlan(goodPlan([goodIssue()]));
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.deepEqual(res.errors, []);
});

test("validatePlan: rejects a non-plan / empty issues", () => {
  assert.equal(validatePlan(null).ok, false);
  assert.equal(validatePlan({}).ok, false);
  assert.equal(validatePlan({ issues: [] }).ok, false);
});

test("validatePlan: an over-budget unit is an error, with the split count", () => {
  const res = validatePlan(goodPlan([goodIssue({ budget: { files: 98, additions: 11537 } })]));
  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /exceeds the cap/);
  assert.match(res.errors.join("\n"), /split it into ~15/);
});

test("validatePlan: a missing budget is an error — an un-budgeted unit is unbounded", () => {
  const res = validatePlan(goodPlan([goodIssue({ budget: undefined })]));
  assert.match(res.errors.join("\n"), /no assigned budget/);
});

test("validatePlan: high-risk lane must not first-pass on dsv4", () => {
  for (const lane of HIGH_RISK_LANES) {
    const res = validatePlan(goodPlan([goodIssue({ riskLane: lane, leadType: "dsv4" })]));
    assert.equal(res.ok, false, `${lane} should reject dsv4`);
    assert.match(res.errors.join("\n"), /must not first-pass/);
  }
  const flash = validatePlan(goodPlan([goodIssue({ riskLane: "security", leadType: "dsv4-flash" })]));
  assert.equal(flash.ok, false);
});

test("validatePlan: kimi/gpt on a high-risk lane warns but passes", () => {
  const res = validatePlan(goodPlan([goodIssue({ riskLane: "governance", leadType: "kimi" })]));
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.match(res.warnings.join("\n"), /one-round rule/);
});

test("validatePlan: mechanical lanes accept any lead type", () => {
  for (const lt of ["dsv4", "dsv4-flash", "kimi", "gpt", "claude"]) {
    const res = validatePlan(goodPlan([goodIssue({ riskLane: "mechanical", leadType: lt })]));
    assert.equal(res.ok, true, `${lt}: ${res.errors.join("; ")}`);
  }
});

test("validatePlan: unknown surface / bad risk lane / missing lead are errors", () => {
  const res = validatePlan(goodPlan([goodIssue({ surfaces: ["bogus"], riskLane: "vibes", leadType: undefined })]));
  assert.match(res.errors.join("\n"), /unknown surface "bogus"/);
  assert.match(res.errors.join("\n"), /riskLane must be one of/);
  assert.match(res.errors.join("\n"), /no leadType assigned/);
});

test("validatePlan: an unresolved gate holds the issue out of the run", () => {
  const open = validatePlan(goodPlan([goodIssue({ gate: { q: "auto-merge on the runner lane?" } })]));
  assert.equal(open.ok, false);
  assert.match(open.errors.join("\n"), /unresolved gate/);
  const answered = validatePlan(goodPlan([goodIssue({ gate: { q: "auto-merge?", answer: "yes, policy-gated" } })]));
  assert.equal(answered.ok, true, answered.errors.join("; "));
});

test("validatePlan: two holders of one version axis must be serialized or bundled", () => {
  const issues = [
    goodIssue({ id: "DER-1001", versionAxes: ["reference-guide:cli"] }),
    goodIssue({ id: "DER-1002", versionAxes: ["reference-guide:cli"] }),
  ];
  const clash = validatePlan(goodPlan(issues));
  assert.equal(clash.ok, false);
  assert.match(clash.errors.join("\n"), /all hold version axis/);

  const serialized = validatePlan(goodPlan(issues, { serialization: [["DER-1001", "DER-1002"]] }));
  assert.equal(serialized.ok, true, serialized.errors.join("; "));
});

test("validatePlan: distinct pre-allocated migration numbers do not collide", () => {
  const res = validatePlan(goodPlan([
    goodIssue({ id: "DER-1001", versionAxes: ["migration:0138"] }),
    goodIssue({ id: "DER-1002", versionAxes: ["migration:0139"] }),
  ]));
  assert.equal(res.ok, true, res.errors.join("; "));
});

test("validatePlan: dependsOn must resolve, and wants the contract named", () => {
  const missing = validatePlan(goodPlan([goodIssue({ dependsOn: ["DER-9999"] })]));
  assert.match(missing.errors.join("\n"), /is not in this plan/);

  const unnamed = validatePlan(goodPlan([
    goodIssue({ id: "DER-1001" }),
    goodIssue({ id: "DER-1002", dependsOn: ["DER-1001"] }),
  ]));
  assert.equal(unnamed.ok, true, unnamed.errors.join("; "));
  assert.match(unnamed.warnings.join("\n"), /must NAME the merged contract/);

  const named = validatePlan(goodPlan([
    goodIssue({ id: "DER-1001" }),
    goodIssue({ id: "DER-1002", dependsOn: ["DER-1001"], notes: "build ON DER-1001's merged registry shape" }),
  ]));
  assert.equal(named.warnings.filter((w) => /NAME the merged contract/.test(w)).length, 0);
});

test("validatePlan: dependency cycles are caught", () => {
  const res = validatePlan(goodPlan([
    goodIssue({ id: "DER-1001", dependsOn: ["DER-1002"], notes: "x" }),
    goodIssue({ id: "DER-1002", dependsOn: ["DER-1001"], notes: "y" }),
  ]));
  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /dependency cycle/);
});

test("validatePlan: bundling that busts the combined budget is an error", () => {
  const res = validatePlan(goodPlan([
    goodIssue({ id: "DER-1001", budget: { files: 8, additions: 600 }, bundleWith: ["DER-1002"] }),
    goodIssue({ id: "DER-1002", budget: { files: 8, additions: 600 } }),
  ]));
  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /COMBINED unit/);
});

test("validatePlan: never bundle a risk-lane issue", () => {
  const res = validatePlan(goodPlan([
    goodIssue({ id: "DER-1001", budget: { files: 4, additions: 200 }, bundleWith: ["DER-1002"] }),
    goodIssue({ id: "DER-1002", budget: { files: 4, additions: 200 }, riskLane: "security" }),
  ]));
  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /risk lane — bundle only mechanical work/);
});

test("validatePlan: a small mechanical bundle passes", () => {
  const res = validatePlan(goodPlan([
    goodIssue({ id: "DER-1001", budget: { files: 5, additions: 300 }, bundleWith: ["DER-1002"] }),
    goodIssue({ id: "DER-1002", budget: { files: 5, additions: 300 } }),
  ]));
  assert.equal(res.ok, true, res.errors.join("; "));
});

test("validatePlan: an undecided decision is an error; no decisions is a warning", () => {
  const undecided = validatePlan(goodPlan([goodIssue()], { decisions: [{ q: "ship the ceiling raise?" }] }));
  assert.equal(undecided.ok, false);
  assert.match(undecided.errors.join("\n"), /has no recorded answer/);

  const none = validatePlan({ issues: [goodIssue()] });
  assert.equal(none.ok, true);
  assert.match(none.warnings.join("\n"), /no decisions recorded/);
});

test("validatePlan: duplicate ids and malformed ids are errors", () => {
  const dup = validatePlan(goodPlan([goodIssue(), goodIssue()]));
  assert.match(dup.errors.join("\n"), /listed twice/);
  const bad = validatePlan(goodPlan([{ id: "nope" }]));
  assert.match(bad.errors.join("\n"), /either a Linear id like DER-1234, or a spec unit/);
});

// ---- assigned budget lookup (what write-brief stamps) ----

test("budgetFor: returns the unit's assigned budget", () => {
  const plan = goodPlan([goodIssue({ id: "DER-1001", versionAxes: ["reference-guide"] })]);
  const b = budgetFor(plan, "DER-1001");
  assert.equal(b.files, 9);
  assert.equal(b.additions, 500);
  assert.deepEqual(b.issues, ["DER-1001"]);
  assert.deepEqual(b.surfaces, ["command"]);
  assert.equal(b.leadType, "claude");
});

test("budgetFor: a bundle ships as ONE PR, so its budget is the sum", () => {
  const plan = goodPlan([
    goodIssue({ id: "DER-1001", budget: { files: 5, additions: 300 }, bundleWith: ["DER-1002"] }),
    goodIssue({ id: "DER-1002", budget: { files: 4, additions: 250 }, surfaces: ["ui"] }),
  ]);
  const b = budgetFor(plan, "DER-1001");
  assert.equal(b.files, 9);
  assert.equal(b.additions, 550);
  assert.deepEqual(b.issues, ["DER-1001", "DER-1002"]);
  assert.deepEqual(b.surfaces.sort(), ["command", "ui"]);
});

test("budgetFor: a bundled EXTRA id resolves to its primary's unit budget", () => {
  const plan = goodPlan([
    goodIssue({ id: "DER-1001", budget: { files: 5, additions: 300 }, bundleWith: ["DER-1002"] }),
    goodIssue({ id: "DER-1002", budget: { files: 4, additions: 250 } }),
  ]);
  assert.deepEqual(budgetFor(plan, "DER-1002").issues, ["DER-1001", "DER-1002"]);
});

test("budgetFor: unknown id → null", () => {
  assert.equal(budgetFor(goodPlan([goodIssue()]), "DER-4242"), null);
});

// ---- rendering / scaffolding / calibration ----

test("renderPlanMd: table, splits, serialization, held-out and decisions", () => {
  const md = renderPlanMd({
    label: "overnight wave",
    date: "2026-07-25",
    issues: [
      goodIssue({ id: "DER-1001", splitFrom: "DER-2161" }),
      goodIssue({ id: "DER-1002", splitFrom: "DER-2161", versionAxes: ["reference-guide"] }),
    ],
    serialization: [["DER-1001", "DER-1002"]],
    heldOut: [{ id: "DER-1003", why: "founder gate unresolved" }],
    decisions: [{ q: "bundle to save CI?", a: "no — loses 3–7×", by: "operator", at: "2026-07-25" }],
  });
  assert.match(md, /# Run plan — overnight wave \(2026-07-25\)/);
  assert.match(md, /\| DER-1001 \| 9 \/ 500 \|/);
  assert.match(md, /\*\*DER-2161\*\* → DER-1001, DER-1002/);
  assert.match(md, /DER-1001 → DER-1002/);
  assert.match(md, /Held OUT of this run/);
  assert.match(md, /loses 3–7×/);
});

test("scaffoldPlan: skeleton has one entry per issue and validates as NOT dispatchable", () => {
  const plan = scaffoldPlan({ issues: ["DER-1", "DER-2"], label: "x" });
  assert.equal(plan.issues.length, 2);
  assert.equal(validatePlan(plan).ok, false); // budgets are null until the session fills them in
});

test("calibrate: ratios + median suggestion", () => {
  const plan = goodPlan([
    goodIssue({ id: "DER-1001", budget: { files: 10, additions: 500 } }),
    goodIssue({ id: "DER-1002", budget: { files: 10, additions: 500 } }),
    goodIssue({ id: "DER-1003", budget: { files: 10, additions: 500 } }),
  ]);
  const c = calibrate(plan, [
    { id: "DER-1001", files: 20, additions: 1000 },
    { id: "DER-1002", files: 10, additions: 750 },
    { id: "DER-1003", files: 15, additions: 1000 },
  ]);
  assert.equal(c.n, 3);
  assert.equal(c.medianFileRatio, 1.5);
  assert.equal(c.medianAdditionRatio, 2);
  assert.match(c.suggestion, /Multiply the sizing table/);
});

test("calibrate: too few points refuses to move the table", () => {
  const c = calibrate(goodPlan([goodIssue({ id: "DER-1001" })]), [{ id: "DER-1001", files: 12, additions: 600 }]);
  assert.match(c.suggestion, /collect more/);
});

// ---- CLI ----

test("parseArgs: subcommand + flags", () => {
  const o = parseArgs(["size", "--surfaces", "command,ui", "--core", "2", "--json"]);
  assert.equal(o.subcommand, "size");
  assert.equal(o.surfaces, "command,ui");
  assert.equal(o.core, 2);
  assert.equal(o.json, true);
});

test("CLI size: exits 2 when over budget, 0 when under", async () => {
  const under = await runSubcommand(["size", "--surfaces", "command", "--core", "1"]);
  assert.equal(under.exitCode, 0);
  assert.match(under.stdout, /within budget/);

  const over = await runSubcommand(["size", "--surfaces", "command,ui,migration", "--core", "4"]);
  assert.equal(over.exitCode, 2);
  assert.match(over.stdout, /OVER BUDGET/);
});

test("CLI: scaffold → validate → budget-for → render round-trips through disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prep-cli-"));
  try {
    const planPath = join(dir, "plan.json");
    await runSubcommand(["scaffold", "--issues", "DER-1001,DER-1002", "--label", "t", "--out", planPath]);

    const bad = await runSubcommand(["validate", planPath]);
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stdout, /NOT dispatchable/);

    const plan = goodPlan([
      goodIssue({ id: "DER-1001" }),
      goodIssue({ id: "DER-1002", budget: { files: 4, additions: 250 }, surfaces: ["ui"], riskLane: "ui", leadType: "dsv4-flash" }),
    ]);
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

    const ok = await runSubcommand(["validate", planPath]);
    assert.equal(ok.exitCode, 0, ok.stdout);
    assert.match(ok.stdout, /dispatchable/);

    const b = await runSubcommand(["budget-for", planPath, "DER-1002"]);
    assert.match(b.stdout, /"files": 4/);

    const mdPath = join(dir, "plan.md");
    await runSubcommand(["render", planPath, "--out", mdPath]);
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(mdPath, "utf8"), /# Run plan/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI: surfaces --verify fails on a repo missing the lockstep files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prep-verify-"));
  try {
    const res = await runSubcommand(["surfaces", "--verify", "--repo-root", dir]);
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /rotted table under-sizes silently/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI: calibrate reads actuals from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prep-cal-"));
  try {
    const planPath = join(dir, "plan.json");
    const actPath = join(dir, "actuals.json");
    await writeFile(planPath, JSON.stringify(goodPlan([goodIssue({ id: "DER-1001", budget: { files: 10, additions: 500 } })])), "utf8");
    await writeFile(actPath, JSON.stringify([{ id: "DER-1001", files: 20, additions: 1000 }]), "utf8");
    const res = await runSubcommand(["calibrate", planPath, "--actuals", actPath]);
    assert.match(res.stdout, /DER-1001.*2×/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("usage lists every surface and risk lane", () => {
  const u = usage();
  for (const k of Object.keys(SURFACES)) assert.ok(u.includes(k), `usage missing surface ${k}`);
  for (const l of RISK_LANES) assert.ok(u.includes(l), `usage missing lane ${l}`);
});

// ---- Mandatory plan review (2026-07-29) ----
// The gate exists because review rounds were the 2026-07-27 run's dominant recycle cost (36 kickbacks
// across 24 PRs). Reviewing the PLAN is the cheapest moment to delete a finding: a plan edit costs one
// re-brief; the same finding on a PR costs a round.

test("validatePlan: a missing plan review is an ERROR; a WRITTEN skip is allowed", () => {
  const missing = validatePlan(goodPlan([goodIssue({ planReview: undefined })]));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /no plan review recorded/);
  // A deliberate skip must carry a reason — an unexplained skip is indistinguishable from a forgotten one.
  const bareSkip = validatePlan(goodPlan([goodIssue({ planReview: undefined, planReviewSkipped: {} })]));
  assert.equal(bareSkip.ok, false);
  assert.match(bareSkip.errors.join("\n"), /needs a `why`/);
  const written = validatePlan(goodPlan([goodIssue({ planReview: undefined, planReviewSkipped: { why: "codex has no credential on this host" } })]));
  assert.equal(written.ok, true, written.errors.join("; "));
});

test("validatePlan: a plan review that never searched the repo does NOT satisfy the gate", () => {
  // DER-2504: `codex exec` can complete with command_execution=0 and return fabricated findings. A plan
  // review is exactly where that is undetectable, because there is no diff to sanity-check it against.
  const fabricated = validatePlan(goodPlan([goodIssue({ planReview: { verdict: "plan is sound", commands: 0 } })]));
  assert.equal(fabricated.ok, false);
  assert.match(fabricated.errors.join("\n"), /0 repository commands/);
  // Control: the same verdict WITH real repo commands passes.
  assert.equal(validatePlan(goodPlan([goodIssue({ planReview: { verdict: "plan is sound", commands: 3 } })])).ok, true);
  // A "plan is wrong" verdict blocks dispatch outright.
  const wrong = validatePlan(goodPlan([goodIssue({ planReview: { verdict: "plan is wrong", commands: 9 } })]));
  assert.equal(wrong.ok, false);
  assert.match(wrong.errors.join("\n"), /rewrite the plan entry/);
});

test("planReviewAccepted: refuses a dead gate and a blind gate; accepts a real one", () => {
  const real = [
    JSON.stringify({ type: "command_execution", command: "rg foo" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  const ok = planReviewAccepted(real);
  assert.equal(ok.accepted, true);
  assert.equal(ok.commands, 2);
  // FAILING answer 1 — the gate DIED. It exits 0 when it does, so exit code proves nothing.
  const dead = planReviewAccepted(`${JSON.stringify({ type: "command_execution" })}\n`);
  assert.equal(dead.accepted, false);
  assert.match(dead.reasons.join(" "), /turn\.completed/);
  // FAILING answer 2 — completed but never opened the repo: the DER-2504 fabrication signature.
  const blind = planReviewAccepted(JSON.stringify({ type: "turn.completed" }));
  assert.equal(blind.accepted, false);
  assert.match(blind.reasons.join(" "), /never searched the repo/);
  // Garbage in is not silently a pass.
  assert.equal(planReviewAccepted("").accepted, false);
  assert.equal(planReviewAccepted(null).accepted, false);
});

test("planReviewPrompt: carries the issue's real budget, surfaces and named dependencies", () => {
  const p = planReviewPrompt({
    id: "DER-2505", title: "bind a completion assertion to the receipt it authorizes",
    budget: { files: 6, additions: 400 }, surfaces: ["command", "migration"],
    riskLane: "governance", dependsOn: ["DER-2504"], notes: "class members: a.ts, b.ts",
  }, { repoRoot: "/repo", corpus: ["instrument blindness — checks that cannot fail"] });
  assert.match(p, /DER-2505/);
  assert.match(p, /6 files \/ ~400 additions/);
  assert.match(p, /command, migration/);
  assert.match(p, /build ON their merged shape.*DER-2504/s, "an unnamed dependency is how a lead invents its own shape");
  assert.match(p, /SEARCH it/, "the mandate to grep is what separates a real pass from a fabricated one");
  assert.match(p, /instrument blindness/, "last run's kickback classes steer this run's review");
  // It must NOT reach for the diff-local subcommand: there is no diff at plan time.
  assert.doesNotMatch(p, /review --base/);
});

test("applyPlanReview: watch-outs land in `notes`, which is the field the brief carries verbatim", () => {
  const issue = { id: "DER-1", notes: "class members: a.ts" };
  applyPlanReview(issue, {
    verdict: "plan has gaps",
    watch_outs: [{ class: "incomplete family edit", instruction: "enumerate all 7 registry files", severity: "blocker" }],
    missing_from_plan: ["a must-fail control"],
    size_challenge: "the command surface drags 7 lockstep files; 400 additions is optimistic",
  }, { commands: 21 });
  assert.equal(issue.planReview.verdict, "plan has gaps");
  assert.equal(issue.planReview.commands, 21);
  assert.equal(issue.watchOuts.length, 1);
  assert.match(issue.notes, /class members: a\.ts/, "existing notes are preserved, never overwritten");
  assert.match(issue.notes, /incomplete family edit → enumerate all 7 registry files/);
  // A size challenge on an unsplit issue is surfaced by the validator.
  const res = validatePlan(goodPlan([goodIssue({ ...issue, budget: { files: 9, additions: 500 }, riskLane: "mechanical", leadType: "claude" })]));
  assert.match(res.warnings.join("\n"), /challenged the size/);
});

test("PLAN_REVIEW_SCHEMA: forces a verdict and watch-outs, and forbids free-form extras", () => {
  assert.deepEqual(PLAN_REVIEW_SCHEMA.required, ["verdict", "watch_outs"]);
  assert.equal(PLAN_REVIEW_SCHEMA.additionalProperties, false);
  assert.deepEqual(PLAN_REVIEW_SCHEMA.properties.verdict.enum, ["plan is sound", "plan has gaps", "plan is wrong"]);
  assert.deepEqual(PLAN_REVIEW_SCHEMA.properties.watch_outs.items.required, ["class", "instruction"]);
});

test("calibrate: a measurement cannot CONFIRM ITSELF — the two-run rule is enforced, not just stated", () => {
  const plan = { issues: [
    goodIssue({ id: "DER-1", budget: { files: 6, additions: 400 } }),
    goodIssue({ id: "DER-2", budget: { files: 6, additions: 400 } }),
    goodIssue({ id: "DER-3", budget: { files: 6, additions: 400 } }),
  ] };
  // Ratios deliberately matching the stored 4.79x/1.44x measurement.
  const actuals = [
    { id: "DER-1", files: 9, additions: 1916 },
    { id: "DER-2", files: 9, additions: 1916 },
    { id: "DER-3", files: 9, additions: 1916 },
  ];
  // FAILING answer 1 — same run as the stored measurement. Numbers agree; the claim is still refused.
  const self = calibrate(plan, actuals, { run: "20260727T004346Z" });
  assert.equal(self.confirmsPrior.agree, null, "self-confirmation must not read as agreement");
  assert.match(self.confirmsPrior.note, /REFUSING to confirm/);
  // FAILING answer 2 — no run id at all. Silence is not a confirmation either.
  assert.equal(calibrate(plan, actuals).confirmsPrior.agree, null);
  // CONTROL — a genuinely different run with matching ratios DOES confirm, so this can return "yes".
  const second = calibrate(plan, actuals, { run: "20260801T000000Z" });
  assert.equal(second.confirmsPrior.agree, true);
  assert.match(second.confirmsPrior.note, /CONFIRMS/);
  // CONTROL — a different run with DIFFERENT ratios reports disagreement, not agreement.
  const diverging = calibrate(plan, [
    { id: "DER-1", files: 6, additions: 420 },
    { id: "DER-2", files: 6, additions: 420 },
    { id: "DER-3", files: 6, additions: 420 },
  ], { run: "20260801T000000Z" });
  assert.equal(diverging.confirmsPrior.agree, false);
  assert.match(diverging.confirmsPrior.note, /do NOT move the table/);
});

test("applyCalibration: identity by default; scales both axes when set", () => {
  const est = { expectedFiles: 10, expectedAdditions: 500 };
  assert.deepEqual(applyCalibration(est), est, "an unconfirmed calibration must not silently resize anything");
  const scaled = applyCalibration(est, { additions: 4.79, files: 1.44 });
  assert.equal(scaled.expectedAdditions, 2395);
  assert.equal(scaled.expectedFiles, 14);
  assert.deepEqual(scaled.calibrated, { additions: 4.79, files: 1.44 });
});

// ---- Spec mode (2026-07-29): one spec, one tracking issue, units carved in the plan ----

test("validatePlan: spec mode accepts SPEC unit ids and REQUIRES specRef + a tracking issue", () => {
  const unit = (over = {}) => goodIssue({ id: "SPEC-DEMO-U1", ...over });
  // A spec plan with both anchors is dispatchable.
  const ok = validatePlan({
    specRef: "docs/specs/2026-07-29-demo.md", tracking: "DER-2700",
    issues: [unit(), unit({ id: "SPEC-DEMO-U2" })],
    serialization: [], decisions: [{ q: "gates?", a: "none", by: "operator", at: "2026-07-29" }],
  });
  assert.equal(ok.ok, true, ok.errors.join("; "));
  // FAILING answer 1 — spec units with no tracking issue. The run would be invisible outside the plan.
  const noTracking = validatePlan({
    specRef: "docs/specs/x.md", issues: [unit()],
    serialization: [], decisions: [{ q: "gates?", a: "none", by: "operator", at: "2026-07-29" }],
  });
  assert.equal(noTracking.ok, false);
  assert.match(noTracking.errors.join("\n"), /needs "tracking"/);
  // FAILING answer 2 — spec units with no spec document to implement.
  const noRef = validatePlan({
    tracking: "DER-2700", issues: [unit()],
    serialization: [], decisions: [{ q: "gates?", a: "none", by: "operator", at: "2026-07-29" }],
  });
  assert.equal(noRef.ok, false);
  assert.match(noRef.errors.join("\n"), /needs "specRef"/);
});

test("validatePlan: spec mode does NOT relax the budget — the one lever with a measured effect", () => {
  // 0.17 kickbacks/PR inside budget vs 1.6-2.5 outside it (run 20260727T004346Z). If spec mode dropped
  // this, it would look better in prep and lose in the run.
  const over = validatePlan({
    specRef: "docs/specs/x.md", tracking: "DER-2700",
    issues: [goodIssue({ id: "SPEC-DEMO-U1", budget: { files: 98, additions: 11537 } })],
    serialization: [], decisions: [{ q: "gates?", a: "none", by: "operator", at: "2026-07-29" }],
  });
  assert.equal(over.ok, false);
  assert.match(over.errors.join("\n"), /exceeds the cap/);
  // The plan-review gate is likewise unchanged in spec mode.
  const noReview = validatePlan({
    specRef: "docs/specs/x.md", tracking: "DER-2700",
    issues: [goodIssue({ id: "SPEC-DEMO-U1", planReview: undefined })],
    serialization: [], decisions: [{ q: "gates?", a: "none", by: "operator", at: "2026-07-29" }],
  });
  assert.match(noReview.errors.join("\n"), /no plan review recorded/);
});

test("unit id shapes: SPEC units and Linear ids are distinguishable and neither matches junk", () => {
  assert.ok(LINEAR_ID_RE.test("DER-1234"));
  assert.ok(SPEC_UNIT_RE.test("SPEC-DEMO-U1"));
  assert.ok(SPEC_UNIT_RE.test("SPEC-COLD-EYES-ONBOARDING-U12"));
  assert.ok(!SPEC_UNIT_RE.test("DER-1234"));
  assert.ok(!LINEAR_ID_RE.test("SPEC-DEMO-U1"));
  for (const junk of ["nope", "SPEC-U1", "SPEC-DEMO", "SPEC-DEMO-U", "-U1", "der-1234"]) {
    assert.ok(!LINEAR_ID_RE.test(junk) && !SPEC_UNIT_RE.test(junk), `${junk} must not be a valid unit id`);
  }
});

test("scaffoldPlan: --spec-ref/--tracking/--units scaffolds SPEC units with the SAME entry shape", () => {
  const plan = scaffoldPlan({ label: "cold-eyes", specRef: "docs/specs/x.md", tracking: "DER-2700", units: 3 });
  assert.equal(plan.specRef, "docs/specs/x.md");
  assert.equal(plan.tracking, "DER-2700");
  assert.deepEqual(plan.issues.map((i) => i.id), ["SPEC-COLDEYES-U1", "SPEC-COLDEYES-U2", "SPEC-COLDEYES-U3"]);
  // Identical entry shape to issue mode — only the naming differs.
  assert.deepEqual(Object.keys(plan.issues[0]).sort(), Object.keys(scaffoldPlan({ issues: ["DER-1"] }).issues[0]).sort());
  // Control: without a specRef it stays issue mode.
  assert.equal(scaffoldPlan({ issues: ["DER-1"] }).specRef, undefined);
});
