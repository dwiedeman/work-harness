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
// Pure functions + a thin CLI. No network, no Linear, no git. Run: node prep-runner.mjs <subcommand>

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
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
// CLI
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const o = { rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--json") o.json = true;
    else if (a === "--verify") o.verify = true;
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
