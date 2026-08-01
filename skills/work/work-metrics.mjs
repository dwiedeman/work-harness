#!/usr/bin/env node
// work-metrics.mjs — run-quality metrics report over /work run ledgers (DER-2007 / T2.2, 2026-07-19).
//
// Reads events.jsonl (+ usage.json when present) for one run, or every run under a runs-root, and
// reports SRE-style run-quality signals: merged PRs/issues, kickback volume + deep-tail PRs, timing
// (spawn -> first handoff -> merge), and token spend. Standalone by design — reads the JSONL
// directly and imports nothing from work-runner.mjs, so it can be dropped into a fresh checkout on
// its own. Plain Node >=20 ESM, no dependencies outside node builtins.
//
// state.json is NEVER read here: every historical run's state.json reports status "running" even
// once the run is long merged and closed out, so it cannot be trusted for completion. Everything
// below is derived from events.jsonl, with usage.json used only as a cross-check on token totals.
//
// Out of scope (needs the T2.1 provenance/decision events that don't exist in ledgers yet): review
// false-positive rate, and splitting kickbacks into mechanical vs. substantive.
//
// PHASE 5 (2026-07-31 close-out, DER harness-upgrades plan): `kickbacks/merged-PR` was measuring
// REVIEWER AVAILABILITY, not review quality — the source run's Codex bot died 3h47m in, and the
// blended rate over the whole run (1.17) read as a 44% improvement over baseline while the
// bot-reviewed slice alone (2.50/PR) was actually WORSE than both baselines. `computeMetricsFromEvents`
// stays pure/no-I/O per the contract above: the CLI wrapper (`main`) fetches per-PR bot-review
// coverage over `gh api …/pulls/<n>/reviews` and hands it in via the `coverageByPr` option, and the
// fold refuses to blend kickback rate / tokens-per-PR across a partial-coverage run — see
// `classifyGateCoverage` and the "Gate coverage" section of `renderRunMarkdown`. Separately,
// `review_findings` (the PRE-PR gate) is now folded and reported distinct from kickbacks (POST-PR):
// during that same run the pre-PR gate never went dark, only the post-PR bot did, and a report that
// says "the gate was down" without that split is wrong about which gate.
//
// Usage:
//   node work-metrics.mjs --run <run-dir> [--json] [--out <file>]
//                          [--repo <owner/repo>] [--bot-login <login>] [--no-coverage]
//   node work-metrics.mjs --all --runs-root <dir> [--json] [--out <file>]
//                          [--repo <owner/repo>] [--bot-login <login>] [--no-coverage]

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { json: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--run") o.run = argv[++i];
    else if (a === "--all") o.all = true;
    else if (a === "--runs-root") o.runsRoot = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--repo") o.repo = argv[++i];
    else if (a === "--bot-login") o.botLogin = argv[++i];
    else if (a === "--no-coverage") o.noCoverage = true;
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Ledger reading — tolerant of blank lines, malformed JSON, and events with no
// recognized `type` (unknown event types from newer harness versions are just
// ignored rather than raising).
// ---------------------------------------------------------------------------

// What "a bad line" MEANS. MUST stay behaviourally identical to work-runner.mjs's `classifyLedgerLine`
// (DER-2738): the runner now QUARANTINES the lines it cannot fold instead of throwing on them, and if the
// two readers disagreed about which lines those are they would report different histories for one ledger —
// the DER-2581 defect class, measured once already (a duplicated `token_usage` reported 165 tokens here
// against the runner's correct 110).
//
// Deliberately DUPLICATED rather than imported: this module's contract (see the header) is that it is
// standalone and imports nothing from work-runner.mjs. The duplication is made safe by the agreement test
// in work-metrics.test.mjs, which runs BOTH implementations over one table of lines and ledgers — including
// a truncated tail line and a malformed complete record — and asserts identical output. Drift fails CI.
//
// A `no_type` object is a bad line, not a kept one: it can never fold into a run's state or metrics.
export function classifyLedgerLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return { ok: false, reason: "blank" };
  let d;
  try {
    d = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, reason: "malformed_json", detail: String(err?.message ?? err).slice(0, 200) };
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false, reason: "not_an_object" };
  if (!d.type) return { ok: false, reason: "no_type" };
  return { ok: true, event: d };
}

// Tolerant read: a torn tail line (a writer killed mid-append) or one malformed record must not fail the
// whole report. The runner's `readEvents` additionally QUARANTINES what it skipped, with the raw bytes, so
// the drop is visible to an operator (`state.ledger`, `<runDir>/ledger-quarantine.jsonl`). This reader
// stays read-only by design — it is a reporting tool that may run over archived runs — so it skips the
// same lines and reports the count on the metrics record instead.
export function readEvents(runDir) {
  const file = join(runDir, "events.jsonl");
  const raw = readFileSync(file, "utf8");
  const events = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue; // a trailing newline is not damage
    const v = classifyLedgerLine(line);
    if (!v.ok) {
      skipped += 1;
      continue;
    }
    events.push(v.event);
  }
  LAST_READ_SKIPPED.set(file, skipped);
  return dedupeLedgerEvents(events);
}

// Lines the last read of a given ledger could not fold. Read by computeRunMetrics so a damaged ledger
// cannot report as a complete history — a metrics report over a ledger with holes in it must say so.
const LAST_READ_SKIPPED = new Map();
export function lastReadSkipped(runDir) {
  return LAST_READ_SKIPPED.get(join(runDir, "events.jsonl")) ?? 0;
}

// Exactly-once read (DER-2748). MUST stay behaviourally identical to work-runner.mjs's
// `dedupeLedgerEvents`: two instruments that disagree about the same ledger is the DER-2581 defect class,
// and this one disagreeing was measured — one duplicated `token_usage` line reported 165 tokens here
// against the runner's correct 110, because a relayed replay was folded twice.
//
// Deliberately DUPLICATED rather than imported: this module's contract (see the header) is that it is
// standalone and imports nothing from work-runner.mjs, so it can be dropped into a fresh checkout alone.
// The duplication is made safe by an agreement test in work-metrics.test.mjs that runs both
// implementations over one table of ledgers and asserts identical output — drift fails CI.
//
// Drops a line only on EXACT IDENTITY collision: an `event_id` already seen, or a `(source_id, seq)`
// pair already seen. Legacy lines (pre-0.2.0) carry neither and are NEVER dropped — that is the live
// shape for the two SessionEnd hooks, not merely an archived one. A lower-but-unseen `seq` is a late
// arrival, not a duplicate: `readEvents` order can put a backwards-clock source at 1,3,2, and discarding
// seq 2 there would delete a real event permanently.
export function dedupeLedgerEvents(events = []) {
  const seenIds = new Set();
  const seenSourceSeq = new Set();
  const out = [];
  for (const e of events) {
    const id = e && typeof e.event_id === "string" && e.event_id ? e.event_id : null;
    const src = e && typeof e.source_id === "string" && e.source_id ? e.source_id : null;
    const pair = src && Number.isFinite(e.seq) ? `${src}#${e.seq}` : null;
    if ((id && seenIds.has(id)) || (pair && seenSourceSeq.has(pair))) continue;
    if (id) seenIds.add(id);
    if (pair) seenSourceSeq.add(pair);
    out.push(e);
  }
  return out;
}

export function loadUsageJson(runDir) {
  const p = join(runDir, "usage.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function findRunDirs(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    // Dirent.isDirectory() reflects the entry's own type and does NOT follow symlinks — a
    // symlinked-in run dir would silently vanish from --all. statSync follows the link.
    const full = join(root, e.name);
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false; // dangling symlink
      }
    }
    if (!isDir) continue;
    if (existsSync(join(full, "events.jsonl"))) dirs.push(full);
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function normalizePr(pr) {
  if (pr === undefined || pr === null) return null;
  if (typeof pr === "number" && Number.isFinite(pr)) return pr;
  if (typeof pr === "string" && pr.trim() !== "" && Number.isFinite(Number(pr))) return Number(pr);
  return null;
}

function parseTs(ts) {
  if (typeof ts !== "string") return NaN;
  return Date.parse(ts);
}

function round1(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
}

function round2(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
}

// Linear-interpolation percentile over a pre-sorted numeric array.
export function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const frac = idx - lo;
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * frac;
}

export function statsFor(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return { median: null, p90: null, max: null, n: 0 };
  return {
    median: round1(percentile(clean, 50)),
    p90: round1(percentile(clean, 90)),
    max: round1(clean[clean.length - 1]),
    n: clean.length,
  };
}

// ---------------------------------------------------------------------------
// Token folding — mirrors the semantics of `aggregateTokenUsage` in
// work-runner.mjs (the existing `usage` subcommand) so numbers agree with the
// end-of-run usage.md report, but reimplemented standalone: token_usage
// reports are CUMULATIVE per session (each re-post re-reads the whole
// transcript) and share a stable `report_id`, so events with the same
// report_id collapse to the single latest/largest one instead of summing
// every re-post. Events without `by_model` are skipped (no per-model data to
// fold). Naively summing every token_usage event instead of deduping by
// report_id overcounts badly — 121 raw events / 44 distinct report_ids on the
// 2026-07-18 gold-standard run, a ~2.75x inflation.
// ---------------------------------------------------------------------------

const TOKEN_FIELDS = ["input", "output", "cache_creation", "cache_read"];
const zeroTokens = () => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0 });
const addTokens = (acc, u) => {
  for (const f of TOKEN_FIELDS) acc[f] += Number(u?.[f] ?? 0) || 0;
};
const sumTokens = (u) => TOKEN_FIELDS.reduce((s, f) => s + u[f], 0);

function resolveRole(e) {
  if (e.role) return e.role;
  const actor = String(e.actor ?? "");
  return actor.startsWith("lead") ? "lead" : actor || "unknown";
}

export function foldTokenUsage(events) {
  const byReport = new Map();
  const counted = [];
  for (const e of events) {
    if (!e || e.type !== "token_usage" || !e.by_model || typeof e.by_model !== "object") continue;
    if (!e.report_id) {
      counted.push(e);
      continue;
    }
    const prev = byReport.get(e.report_id);
    const eTotal = Number(e.total_tokens ?? 0) || 0;
    const prevTotal = prev ? Number(prev.total_tokens ?? 0) || 0 : -1;
    const better = !prev || eTotal > prevTotal || (eTotal === prevTotal && String(e.ts ?? "") > String(prev.ts ?? ""));
    if (better) byReport.set(e.report_id, e);
  }
  counted.push(...byReport.values());

  const byRoleModel = new Map(); // role -> Map(model -> totals)
  const total = zeroTokens();
  let reports = 0;
  for (const e of counted) {
    reports += 1;
    const role = resolveRole(e);
    if (!byRoleModel.has(role)) byRoleModel.set(role, new Map());
    const modelMap = byRoleModel.get(role);
    for (const [m, u] of Object.entries(e.by_model)) {
      if (!modelMap.has(m)) modelMap.set(m, zeroTokens());
      addTokens(modelMap.get(m), u);
      addTokens(total, u);
    }
  }
  return { reports, total, totalTokens: sumTokens(total), byRoleModel };
}

function byRoleModelToPlain(byRoleModel) {
  const out = {};
  for (const [role, models] of byRoleModel.entries()) {
    out[role] = {};
    for (const [model, u] of models.entries()) {
      out[role][model] = { ...u, total: sumTokens(u) };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gate coverage (5.1) — classifies each merged PR's bot-review status and decides whether the run's
// kickback rate / tokens-per-PR can be reported as ONE blended number. Pure: takes the coverage map
// the CLI wrapper measured (`{12: true, 13: false}`, see `fetchBotReviewCoverage` below) and never
// touches the network itself, so this half of the fix is unit-testable without `gh` or a live repo.
//
// The defect this exists to kill, measured on the 2026-07-31 source run: splitting kickbacks on the
// exact minute the Codex bot died (03:21:46Z, #1169) gave 2.50 kickbacks/PR on the 8 PRs it still
// reviewed vs 0.78/PR on the 9 after — a 3.2x gap, with 19 of the 20 reviewed-slice kickbacks citing a
// Codex finding by name. Blended over all 17, that reads as 1.17/PR — a 44% *improvement* over the
// 07-26 (2.09) and 07-27 (1.50) baselines, when the reviewed slice alone was actually WORSE than both.
// The orchestrator reported the blended "improvement" before the operator caught it. A coverage-aware
// fold cannot make that mistake, because it refuses to produce the single number that made it.
// ---------------------------------------------------------------------------

const DEFAULT_REVIEW_BOT_LOGIN = "chatgpt-codex-connector[bot]"; // same login `ready` gates on in work-runner.mjs

function coverageFor(coverageByPr, pr) {
  if (!coverageByPr) return undefined;
  if (coverageByPr instanceof Map) return coverageByPr.get(pr);
  return coverageByPr[pr];
}

// A PR absent from `coverageByPr` is UNKNOWN, not "not covered" — a gh lookup that failed (rate
// limit, PAT scope, PR force-deleted) must never collapse into the same bucket as a PR the bot
// genuinely never reviewed. Collapsing "unknown" into "no" is exactly the UNKNOWN-vs-ABSENT confusion
// this repo already refuses elsewhere (`review-fidelity`'s UNMEASURABLE, `readEvents`'s ledgerSkipped).
export function classifyGateCoverage(prRecords, coverageByPr) {
  if (!prRecords.length) return { status: "no_merged_prs", coveredRecords: [], uncoveredRecords: [], unmeasuredPrs: [] };
  const coveredRecords = [];
  const uncoveredRecords = [];
  const unmeasuredPrs = [];
  for (const r of prRecords) {
    const v = coverageFor(coverageByPr, r.pr);
    if (v === true) coveredRecords.push(r);
    else if (v === false) uncoveredRecords.push(r);
    else unmeasuredPrs.push(r.pr);
  }
  let status;
  if (!coveredRecords.length && !uncoveredRecords.length) status = "unmeasured";
  else if (!uncoveredRecords.length && !unmeasuredPrs.length) status = "uniform_covered";
  else if (!coveredRecords.length && !unmeasuredPrs.length) status = "uniform_uncovered";
  else status = "partial"; // mixed covered/uncovered, or a known slice mixed with unmeasured PRs — either
  // way NOT provably one population, so it gets the same refusal as a clean covered/uncovered split.
  return { status, coveredRecords, uncoveredRecords, unmeasuredPrs };
}

// ---------------------------------------------------------------------------
// Core fold: one run's events -> the full metrics object. Pure (no I/O) so
// tests can exercise it against small synthetic ledgers directly.
// ---------------------------------------------------------------------------

// Lead-type head-to-head (CLIProxyAPI comparison, 2026-07-23). Groups the run's delivery outcomes by the
// model family that led each issue — from the `leadType` tag on lead_spawned events (absent ⇒ "claude",
// the default). Complements the token/cost fold (foldTokenUsage), which is per-model spend: this is
// per-lead-type delivery (issues attempted, lead spawns incl. re-spawns, kickback rounds, merged issues).
// Pure. Identity is the primary issue id; a PR is mapped to its issue via any event carrying both.
export function computeLeadTypeBreakdown(events) {
  const issueLeadType = new Map(); // issue -> leadType (last lead_spawned wins; re-spawns keep the type)
  const prIssue = new Map();       // pr -> issue (first seen wins)
  for (const e of events) {
    const pr = normalizePr(e.pr);
    if (pr !== null && e.issue && !prIssue.has(pr)) prIssue.set(pr, e.issue);
    if (e.type === "lead_spawned" && e.issue) issueLeadType.set(e.issue, e.leadType || "claude");
  }
  const acc = new Map();
  const bucket = (lt) => {
    if (!acc.has(lt)) acc.set(lt, { attempts: 0, issues: new Set(), kickbacks: 0, mergedIssues: new Set() });
    return acc.get(lt);
  };
  const ltOfPr = (pr) => { const iss = prIssue.get(normalizePr(pr)); return iss ? (issueLeadType.get(iss) || "claude") : null; };
  for (const e of events) {
    if (e.type === "lead_spawned" && e.issue) {
      const b = bucket(e.leadType || "claude");
      b.attempts += 1;
      b.issues.add(e.issue);
    } else if (e.type === "kickback" && e.pr != null) {
      const lt = ltOfPr(e.pr);
      if (lt) bucket(lt).kickbacks += 1;
    } else if (e.type === "pr_merged" && e.pr != null) {
      const lt = ltOfPr(e.pr);
      const iss = prIssue.get(normalizePr(e.pr));
      if (lt && iss) bucket(lt).mergedIssues.add(iss);
    }
  }
  return [...acc.entries()]
    .map(([leadType, b]) => ({ leadType, issues: b.issues.size, attempts: b.attempts, kickbacks: b.kickbacks, merged: b.mergedIssues.size }))
    .sort((a, b) => (a.leadType === "claude" ? -1 : b.leadType === "claude" ? 1 : a.leadType.localeCompare(b.leadType)));
}

export function computeMetricsFromEvents(
  events,
  {
    run,
    runDir = null,
    usageJson = null,
    ledgerSkipped = 0,
    coverageByPr = null,
    coverageUnmeasuredReason = null,
    coverageBotLogin = null,
  } = {},
) {
  let runStartedTs = null;
  // Spec mode (2026-07-29): recorded so a spec-mode run and an issue-mode run can be compared on the
  // SAME metrics. Without it the two modes are indistinguishable in the trend table and the A/B this
  // mode was added to answer — does carving units in a plan beat filing Linear children? — is unaskable.
  let runMode = null;
  let runTracking = null;
  const prToIssue = new Map(); // pr -> primary issue (first seen wins)
  const issuesByPr = new Map(); // pr -> Set(issue)
  const mergeTsByPr = new Map(); // pr -> earliest pr_merged ts (ms)
  const handoffTsByPr = new Map(); // pr -> earliest handed_off ts (ms)
  const kickbacksByPr = new Map(); // pr -> [{ts, round}]
  const leadSpawnedTsByIssue = new Map(); // issue -> earliest lead_spawned ts (ms)
  const prOpenedTsByPr = new Map();
  const prOpenedTsByIssue = new Map();
  let leadSpawnedCount = 0;
  let handedOffCount = 0;
  let kickbackCount = 0;
  // 5.2: `review_findings` is the PRE-PR gate (codex or a `review-swap` substitute); a kickback is
  // POST-hand-off (every kickback event carries a `pr` — see the `kickback` case below, which never
  // does for review_findings). Folded separately because during the 2026-07-31 source run the pre-PR
  // gate ran the whole 20h with zero gaps (40+ review_findings, substituted with Claude whenever the
  // bot itself was unreachable) while only the POST-PR bot died 3h47m in — a report that collapses the
  // two into one "review gate" figure would have called the pre-PR gate down when it never was.
  let reviewFindingsCount = 0;
  let reviewFindingsSubstituteCount = 0;
  const reviewFindingsByIssue = new Map(); // issue -> {total, substitute}

  for (const e of events) {
    const ts = parseTs(e.ts);
    const pr = normalizePr(e.pr);

    switch (e.type) {
      case "run_started":
        if (!Number.isNaN(ts)) runStartedTs = ts;
        if (e.mode) runMode = e.mode;
        if (e.tracking) runTracking = e.tracking;
        break;
      case "lead_spawned":
        leadSpawnedCount += 1;
        if (e.issue && !Number.isNaN(ts)) {
          const cur = leadSpawnedTsByIssue.get(e.issue);
          if (cur === undefined || ts < cur) leadSpawnedTsByIssue.set(e.issue, ts);
        }
        break;
      case "handed_off":
        handedOffCount += 1;
        if (pr !== null && !Number.isNaN(ts)) {
          const cur = handoffTsByPr.get(pr);
          if (cur === undefined || ts < cur) handoffTsByPr.set(pr, ts);
        }
        break;
      case "kickback":
        kickbackCount += 1;
        if (pr !== null) {
          if (!kickbacksByPr.has(pr)) kickbacksByPr.set(pr, []);
          kickbacksByPr.get(pr).push({ ts: Number.isNaN(ts) ? null : ts, round: typeof e.round === "number" ? e.round : null });
        }
        break;
      case "review_findings":
        // Pre-PR gate event (codex or `review-swap`'s recorded substitute). `substitute: true` marks a
        // round where codex itself was unreachable and a Claude panel stood in — see PHASE 1 of the
        // 2026-07-31 plan. Counted per-issue too so a report can show which issues actually got a
        // substituted (non-codex) pre-PR review, not just a run-wide total.
        reviewFindingsCount += 1;
        if (e.substitute === true) reviewFindingsSubstituteCount += 1;
        if (e.issue) {
          const cur = reviewFindingsByIssue.get(e.issue) || { total: 0, substitute: 0 };
          cur.total += 1;
          if (e.substitute === true) cur.substitute += 1;
          reviewFindingsByIssue.set(e.issue, cur);
        }
        break;
      case "pr_opened":
        if (pr !== null && !Number.isNaN(ts)) {
          const cur = prOpenedTsByPr.get(pr);
          if (cur === undefined || ts < cur) prOpenedTsByPr.set(pr, ts);
        }
        if (e.issue && !Number.isNaN(ts)) {
          const cur = prOpenedTsByIssue.get(e.issue);
          if (cur === undefined || ts < cur) prOpenedTsByIssue.set(e.issue, ts);
        }
        break;
      case "pr_merged":
        // pr_merged is genuinely double-written in real ledgers — a "reconcile" actor event
        // and a "shepherd" actor event for the same real merge (12 distinct PRs / 23 raw
        // pr_merged lines on the 2026-07-18 gold-standard run). Identity is the PR number
        // alone; take the earliest timestamp seen for it.
        if (pr !== null && !Number.isNaN(ts)) {
          const cur = mergeTsByPr.get(pr);
          if (cur === undefined || ts < cur) mergeTsByPr.set(pr, ts);
        }
        break;
      default:
        break; // unknown/irrelevant event type — ignored, not an error
    }

    // Cross-cutting: link pr<->issue and collect every issue id ever associated with a PR,
    // from whichever field this event happened to carry (`issue`, `issues[]`, or `bundle[]` —
    // different writers use different fields across runs).
    if (pr !== null) {
      if (e.issue && !prToIssue.has(pr)) prToIssue.set(pr, e.issue);
      let set = issuesByPr.get(pr);
      if (!set) {
        set = new Set();
        issuesByPr.set(pr, set);
      }
      if (e.issue) set.add(e.issue);
      if (Array.isArray(e.issues)) for (const i of e.issues) if (i) set.add(i);
      if (Array.isArray(e.bundle)) for (const i of e.bundle) if (i) set.add(i);
    }
  }

  // Per-merged-PR records: rounds + the spawn -> handoff -> merge timing chain.
  const mergedPrs = [...mergeTsByPr.keys()];
  const prRecords = mergedPrs.map((pr) => {
    const issueSet = issuesByPr.get(pr) || new Set();
    const issue = prToIssue.get(pr) || [...issueSet][0] || null;
    const mergeTs = mergeTsByPr.get(pr);
    const handoffTs = handoffTsByPr.has(pr) ? handoffTsByPr.get(pr) : null;

    let startTs = null;
    if (issue && leadSpawnedTsByIssue.has(issue)) startTs = leadSpawnedTsByIssue.get(issue);
    else if (prOpenedTsByPr.has(pr)) startTs = prOpenedTsByPr.get(pr);
    else if (issue && prOpenedTsByIssue.has(issue)) startTs = prOpenedTsByIssue.get(issue);

    const timeToFirstHandoffHours =
      startTs !== null && handoffTs !== null ? round1((handoffTs - startTs) / 3_600_000) : null;
    const timeToMergeHours = handoffTs !== null ? round1((mergeTs - handoffTs) / 3_600_000) : null;

    const kicks = kickbacksByPr.get(pr) || [];

    return {
      pr,
      issue,
      issues: [...issueSet].sort(),
      rounds: kicks.length,
      timeToFirstHandoffHours,
      timeToMergeHours,
    };
  });

  const issuesClosedSet = new Set();
  for (const r of prRecords) for (const i of r.issues) issuesClosedSet.add(i);

  const deepTail = prRecords
    .filter((r) => r.rounds >= 3)
    .sort((a, b) => b.rounds - a.rounds || a.pr - b.pr)
    .map((r) => ({ pr: r.pr, issue: r.issue, rounds: r.rounds }));

  const kickbackRate = mergedPrs.length ? round2(kickbackCount / mergedPrs.length) : null;

  const timeToFirstHandoff = statsFor(prRecords.map((r) => r.timeToFirstHandoffHours));
  const timeToMerge = statsFor(prRecords.map((r) => r.timeToMergeHours));

  const outliers = prRecords
    .filter((r) => {
      const deep = r.rounds >= 3;
      const slow =
        timeToMerge.median !== null && typeof r.timeToMergeHours === "number" && r.timeToMergeHours > 3 * timeToMerge.median;
      return deep || slow;
    })
    .map((r) => {
      const reasons = [];
      if (r.rounds >= 3) reasons.push(`${r.rounds} kickback rounds`);
      if (timeToMerge.median !== null && typeof r.timeToMergeHours === "number" && r.timeToMergeHours > 3 * timeToMerge.median) {
        reasons.push(`time-to-merge ${r.timeToMergeHours}h > 3x median ${timeToMerge.median}h`);
      }
      return { pr: r.pr, issue: r.issue, rounds: r.rounds, timeToMergeHours: r.timeToMergeHours, reasons };
    })
    .sort((a, b) => b.rounds - a.rounds || a.pr - b.pr);

  const tokenFold = foldTokenUsage(events);
  const tokensPerMergedPr = mergedPrs.length ? Math.round(tokenFold.totalTokens / mergedPrs.length) : null;

  let tokenDiscrepancyNote = null;
  if (usageJson && typeof usageJson.total_tokens === "number" && usageJson.total_tokens > 0) {
    const diff = Math.abs(usageJson.total_tokens - tokenFold.totalTokens);
    const rel = diff / usageJson.total_tokens;
    if (rel > 0.1) {
      tokenDiscrepancyNote = `ledger fold totals ${tokenFold.totalTokens} tokens vs usage.json ${usageJson.total_tokens} tokens (${(rel * 100).toFixed(1)}% difference) — usage.json may include reports not captured in this events.jsonl`;
    }
  }

  const leadsSpawnedDistinctIssues = leadSpawnedTsByIssue.size;

  // 5.1 — bot-review coverage slices. `sliceStats` reproduces the SAME 2.50-vs-0.78 split measured on
  // the 2026-07-31 source run: per-slice kickback rate AND per-slice tokens/PR, because tokens/PR
  // carries identical contamination (fewer review rounds a bot never triggered ⇒ fewer tokens spent
  // fixing them) — a slice split that only covered kickbacks would leave tokens/PR free to keep lying.
  // token_usage events carry `pr` (see the `kickback`-style identity note above `annotateShaAncestry`
  // in work-runner.mjs), so the same fold `foldTokenUsage` already uses is reused per-slice rather than
  // re-derived.
  const gc = classifyGateCoverage(prRecords, coverageByPr);
  const sliceStats = (recs) => {
    const prs = recs.length;
    const kickbacks = recs.reduce((s, r) => s + r.rounds, 0);
    const prSet = new Set(recs.map((r) => r.pr));
    const sliceTok = foldTokenUsage(events.filter((e) => e && e.type === "token_usage" && prSet.has(normalizePr(e.pr))));
    return {
      prs,
      kickbacks,
      ratePerPr: prs ? round2(kickbacks / prs) : null,
      tokensTotal: sliceTok.totalTokens,
      tokensPerPr: prs ? Math.round(sliceTok.totalTokens / prs) : null,
    };
  };
  const gateCoverage = {
    status: gc.status, // no_merged_prs | unmeasured | uniform_covered | uniform_uncovered | partial
    botLogin: coverageBotLogin, // set by the CLI wrapper when it actually measured coverage — see fetchBotReviewCoverage
    reason: gc.status === "unmeasured" ? (coverageUnmeasuredReason || "bot-review coverage not measured for this run") : null,
    covered: sliceStats(gc.coveredRecords),
    uncovered: sliceStats(gc.uncoveredRecords),
    unmeasuredPrs: gc.unmeasuredPrs,
  };

  return {
    run: run ?? (runDir ? basename(runDir) : "run"),
    runDir,
    runStartedTs,
    runStartedIso: runStartedTs !== null ? new Date(runStartedTs).toISOString() : null,
    mode: runMode,
    tracking: runTracking,
    eventCount: events.length,
    // DER-2738: lines the reader could not fold. A metrics report over a ledger with holes in it must say
    // so — every number below is computed over `eventCount` events out of `eventCount + ledgerSkipped`
    // lines, and a silent skip is the difference between "this run was cheap" and "we lost the receipts".
    ledgerSkipped,
    prsMerged: mergedPrs.length,
    issuesClosed: issuesClosedSet.size,
    issuesClosedList: [...issuesClosedSet].sort(),
    leadsSpawned: leadSpawnedCount,
    leadsSpawnedDistinctIssues,
    handoffs: handedOffCount,
    kickbacks: { total: kickbackCount, ratePerMergedPr: kickbackRate, deepTail },
    // 5.1: `ratePerMergedPr` above is the blended figure — kept for callers that already read it, but
    // `renderRunMarkdown` refuses to PRINT it standalone except at uniform coverage (see gateCoverage).
    gateCoverage,
    // 5.2: pre-PR gate (`review_findings`), reported distinct from kickbacks (post-PR, above) — see the
    // comment at the `review_findings` case in the fold loop for why the two must never be one number.
    reviewFindings: {
      total: reviewFindingsCount,
      substitute: reviewFindingsSubstituteCount,
      byIssue: [...reviewFindingsByIssue.entries()]
        .map(([issue, v]) => ({ issue, total: v.total, substitute: v.substitute }))
        .sort((a, b) => a.issue.localeCompare(b.issue)),
    },
    timing: { timeToFirstHandoffHours: timeToFirstHandoff, timeToMergeHours: timeToMerge },
    tokens: {
      reports: tokenFold.reports,
      total: tokenFold.totalTokens,
      perMergedPr: tokensPerMergedPr,
      byRoleModel: byRoleModelToPlain(tokenFold.byRoleModel),
      discrepancyNote: tokenDiscrepancyNote,
    },
    outliers,
    prRecords,
    leadTypes: computeLeadTypeBreakdown(events),
  };
}

export function computeRunMetrics(runDir) {
  const events = readEvents(runDir);
  const usageJson = loadUsageJson(runDir);
  return computeMetricsFromEvents(events, { run: basename(runDir), runDir, usageJson, ledgerSkipped: lastReadSkipped(runDir) });
}

// ---------------------------------------------------------------------------
// Cross-run sort key: run_started ts when known, else the YYYYMMDDTHHMMSSZ
// prefix baked into the run directory name, else last (Infinity).
// ---------------------------------------------------------------------------

export function runSortKey(m) {
  if (typeof m.runStartedTs === "number") return m.runStartedTs;
  const match = /^(\d{8})T(\d{6})Z/.exec(m.run);
  if (match) {
    const [, d, t] = match;
    const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Infinity;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function mdTable(headers, rows) {
  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.map((r) => `| ${r.join(" | ")} |`);
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

const fmtN = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "n/a");
const fmtH = (v) => (v === null || v === undefined ? "n/a" : `${v.toFixed(1)}h`);
const fmtRate = (v) => (v === null || v === undefined ? "n/a" : String(v));

// 5.1: the Summary table's Kickback-rate / Tokens-per-PR cells route through this instead of printing
// the blended number directly. `no_merged_prs` and `unmeasured` both fall through to plain formatting
// only for the FIRST (blended value itself already "n/a"/reason-carrying); the whole point is that
// "partial" NEVER reaches a bare number here — see classifyGateCoverage for why a mixed or
// partly-unmeasured slice can't be assumed to be one population.
function gatedSummaryValue(gateCoverage, blended, fmt) {
  if (blended === null || blended === undefined) return "n/a";
  if (!gateCoverage || gateCoverage.status === "no_merged_prs") return fmt(blended);
  switch (gateCoverage.status) {
    case "unmeasured":
      return `UNMEASURED (${gateCoverage.reason})`;
    case "partial":
      return "SPLIT — see 'Gate coverage' below (blended figure refused, DER-2007 5.1)";
    case "uniform_covered":
      return `${fmt(blended)} (uniform: bot reviewed all ${gateCoverage.covered.prs} merged PR${gateCoverage.covered.prs === 1 ? "" : "s"})`;
    case "uniform_uncovered":
      return `${fmt(blended)} (uniform: bot reviewed none of ${gateCoverage.uncovered.prs} merged PR${gateCoverage.uncovered.prs === 1 ? "" : "s"})`;
    default:
      return fmt(blended);
  }
}

// Cross-run trend table label (5.1) — terse by necessity (one cell in a multi-run table), but enough
// to stop a reader from comparing a partial-coverage run's blended rate against a uniform one's: "Runs
// are only comparable at equal coverage" (2026-07-31 plan, PHASE 5.1).
function gateCoverageLabel(gc) {
  if (!gc || gc.status === "no_merged_prs") return "n/a";
  switch (gc.status) {
    case "unmeasured":
      return "UNMEASURED";
    case "uniform_covered":
      return `uniform (${gc.covered.prs} covered)`;
    case "uniform_uncovered":
      return `uniform (${gc.uncovered.prs} uncovered)`;
    case "partial":
      return `${gc.covered.prs} covered / ${gc.uncovered.prs} uncovered`;
    default:
      return "n/a";
  }
}

export function renderRunMarkdown(m) {
  const lines = [];
  lines.push(`# Run-quality report: ${m.run}`);
  if (m.runStartedIso) lines.push(`Run started: ${m.runStartedIso}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    mdTable(
      ["Metric", "Value"],
      [
        ["PRs merged", String(m.prsMerged)],
        ["Issues closed", String(m.issuesClosed)],
        ["Leads spawned (lead_spawned events)", `${m.leadsSpawned} (${m.leadsSpawnedDistinctIssues} distinct issues)`],
        ["Hand-offs (handed_off events)", String(m.handoffs)],
        ["Kickbacks total", String(m.kickbacks.total)],
        ["Kickback rate (per merged PR)", gatedSummaryValue(m.gateCoverage, m.kickbacks.ratePerMergedPr, fmtRate)],
        ["Total tokens (ledger fold)", fmtN(m.tokens.total)],
        // tokens/PR carries the SAME reviewer-availability contamination as kickback rate (fewer bot
        // review rounds a PR never got ⇒ fewer tokens spent responding to them) — annotated identically,
        // not just kickback rate, or this row would keep lying after the one above stopped (5.1).
        ["Tokens / merged PR", gatedSummaryValue(m.gateCoverage, m.tokens.perMergedPr, fmtN)],
        ["Pre-PR gate events (review_findings)", `${m.reviewFindings.total} (${m.reviewFindings.substitute} substitute)`],
      ],
    ),
  );
  lines.push("");
  lines.push("## Gate coverage (bot-review availability)");
  lines.push("");
  lines.push(
    "Whether the kickback rate and tokens/PR above mean anything at all depends on whether the review " +
      "bot was actually reviewing: a PR it never touched has structurally fewer kickback rounds " +
      "(nothing to kick back on) and fewer review-fix tokens — that is reviewer ABSENCE, not review " +
      "QUALITY. Measured on the 2026-07-31 source run: 2.50 kickbacks/PR on the 8 PRs the bot reviewed " +
      "vs 0.78/PR on the 9 after it died — blended, that read as 1.17/PR, a 44% *improvement* the " +
      "orchestrator reported before being corrected. Runs are only comparable at equal coverage.",
  );
  lines.push("");
  if (m.gateCoverage.status === "no_merged_prs") {
    lines.push("No merged PRs this run.");
  } else if (m.gateCoverage.status === "unmeasured") {
    lines.push(
      `UNMEASURED — ${m.gateCoverage.reason}. Reported as UNMEASURED, never as 0 and never blended: an ` +
        "unmeasured run could be hiding the exact same gap the source run had.",
    );
  } else {
    lines.push(
      mdTable(
        ["Slice", "PRs", "Kickbacks", "Kickback rate", "Tokens", "Tokens/PR"],
        [
          [
            "Bot-reviewed",
            String(m.gateCoverage.covered.prs),
            String(m.gateCoverage.covered.kickbacks),
            fmtRate(m.gateCoverage.covered.ratePerPr),
            fmtN(m.gateCoverage.covered.tokensTotal),
            m.gateCoverage.covered.tokensPerPr === null ? "n/a" : fmtN(m.gateCoverage.covered.tokensPerPr),
          ],
          [
            "No bot review",
            String(m.gateCoverage.uncovered.prs),
            String(m.gateCoverage.uncovered.kickbacks),
            fmtRate(m.gateCoverage.uncovered.ratePerPr),
            fmtN(m.gateCoverage.uncovered.tokensTotal),
            m.gateCoverage.uncovered.tokensPerPr === null ? "n/a" : fmtN(m.gateCoverage.uncovered.tokensPerPr),
          ],
        ],
      ),
    );
    lines.push("");
    if (m.gateCoverage.status === "uniform_covered") {
      lines.push("Uniform coverage: every merged PR had at least one bot review — the blended Summary figures above are one population and safe to read as-is.");
    } else if (m.gateCoverage.status === "uniform_uncovered") {
      lines.push("Uniform coverage: no merged PR had a bot review — the blended Summary figures above are one population, but are NOT comparable to a bot-reviewed run's numbers.");
    } else {
      lines.push("PARTIAL coverage: the blended Summary figures are refused above on purpose — compare the two slices, never the blend.");
    }
    if (m.gateCoverage.unmeasuredPrs.length) {
      lines.push("");
      lines.push(
        `${m.gateCoverage.unmeasuredPrs.length} merged PR(s) with UNKNOWN coverage (gh lookup failed or was ` +
          `skipped), excluded from both slices above: ${m.gateCoverage.unmeasuredPrs.join(", ")}.`,
      );
    }
  }
  lines.push("");
  lines.push("## Pre-PR vs post-PR review");
  lines.push("");
  lines.push(
    "Kickbacks are POST-hand-off — every kickback event carries a `pr`. The pre-PR gate emits " +
      "`review_findings` instead (codex, or a recorded `review-swap` substitute) and is counted " +
      "separately here: a report that folds the two into one 'review gate' number reads as \"the gate " +
      "was down\" whenever POST-PR bot review dies, even on a run where the PRE-PR gate never went dark " +
      "(the 2026-07-31 source run: 40+ review_findings with real blockers, substituted with Claude when " +
      "needed, while only the post-PR Codex bot went dark 3h47m into a 20h run).",
  );
  lines.push("");
  lines.push(
    mdTable(
      ["Stage", "Events", "Distinct issues", "Substitute (non-bot engine)"],
      [
        ["Pre-PR gate (review_findings)", String(m.reviewFindings.total), String(m.reviewFindings.byIssue.length), String(m.reviewFindings.substitute)],
        ["Post-PR (kickback rounds)", String(m.kickbacks.total), String(new Set(m.prRecords.filter((r) => r.rounds > 0).map((r) => r.issue).filter(Boolean)).size), "n/a"],
      ],
    ),
  );
  lines.push("");
  if (m.leadTypes && m.leadTypes.some((l) => l.leadType !== "claude")) {
    lines.push("## Lead-type head-to-head (CLIProxyAPI comparison)");
    lines.push("");
    lines.push(
      mdTable(
        ["Lead type", "Issues", "Lead spawns", "Kickbacks", "Merged"],
        m.leadTypes.map((l) => [l.leadType, String(l.issues), String(l.attempts), String(l.kickbacks), String(l.merged)]),
      ),
    );
    lines.push("");
    lines.push("> Token/cost per model is in the 'Tokens by role x model' table below (kimi-*/gpt-*/claude-* rows).");
    lines.push("");
  }
  // 5.1 (do-not-change note): median and p90 are reported SEPARATELY here on purpose — do not collapse
  // this back to one number. On the 2026-07-31 source run the hand-off->merge median (1.6h) beat both
  // prior baselines while the SAME run's p90 (13.2h) was the worst in the whole trend table; the p90
  // was an 8.5h orchestrator blackout (availability), not a review-quality regression. One number would
  // have hidden whichever of the two it wasn't — the same blending mistake gate coverage exists to stop
  // one section up, just on the timing axis instead of the review-rate axis.
  lines.push("## Timing (hours, wall-clock)");
  lines.push("");
  lines.push(
    mdTable(
      ["Segment", "Median", "p90", "Max", "n"],
      [
        [
          "Spawn -> first hand-off",
          fmtH(m.timing.timeToFirstHandoffHours.median),
          fmtH(m.timing.timeToFirstHandoffHours.p90),
          fmtH(m.timing.timeToFirstHandoffHours.max),
          String(m.timing.timeToFirstHandoffHours.n),
        ],
        [
          "Hand-off -> merge",
          fmtH(m.timing.timeToMergeHours.median),
          fmtH(m.timing.timeToMergeHours.p90),
          fmtH(m.timing.timeToMergeHours.max),
          String(m.timing.timeToMergeHours.n),
        ],
      ],
    ),
  );
  lines.push("");
  lines.push("## Deep-tail PRs (>= 3 kickback rounds)");
  lines.push("");
  lines.push(
    m.kickbacks.deepTail.length
      ? mdTable(["PR", "Issue", "Rounds"], m.kickbacks.deepTail.map((d) => [String(d.pr), d.issue || "n/a", String(d.rounds)]))
      : "None.",
  );
  lines.push("");
  lines.push("## Outliers (deep-tail rounds, or time-to-merge > 3x run median)");
  lines.push("");
  lines.push(
    m.outliers.length
      ? mdTable(
          ["PR", "Issue", "Rounds", "Time to merge", "Reasons"],
          m.outliers.map((o) => [String(o.pr), o.issue || "n/a", String(o.rounds), fmtH(o.timeToMergeHours), o.reasons.join("; ")]),
        )
      : "None.",
  );
  lines.push("");
  lines.push("## Tokens by role x model");
  lines.push("");
  const tokenRows = [];
  for (const [role, models] of Object.entries(m.tokens.byRoleModel)) {
    for (const [model, u] of Object.entries(models)) {
      tokenRows.push([role, model, fmtN(u.input), fmtN(u.output), fmtN(u.cache_creation), fmtN(u.cache_read), fmtN(u.total)]);
    }
  }
  lines.push(
    tokenRows.length
      ? mdTable(["Role", "Model", "Input", "Output", "Cache write", "Cache read", "Total"], tokenRows)
      : "No token_usage events in this ledger.",
  );
  if (m.tokens.discrepancyNote) {
    lines.push("");
    lines.push(`> Data-quality note: ${m.tokens.discrepancyNote}`);
  }
  // DER-2738: a report over a ledger with unreadable lines must SAY it had holes. Silently reporting
  // fewer merges / fewer tokens is exactly the invisible data loss the tolerance is not allowed to cause.
  if (m.ledgerSkipped) {
    lines.push("");
    lines.push(
      `> LEDGER DAMAGE: ${m.ledgerSkipped} line(s) of this run's events.jsonl could not be read (torn or ` +
      `malformed) and are NOT counted above. The runner quarantines their raw bytes in ` +
      `\`<runDir>/ledger-quarantine.jsonl\` — treat every number in this report as a lower bound.`,
    );
  }
  return lines.join("\n");
}

export function buildSummaryRow(m) {
  return [
    m.run,
    m.runStartedIso ? m.runStartedIso.slice(0, 10) : "n/a",
    m.mode ?? "n/a",
    String(m.prsMerged),
    String(m.issuesClosed),
    String(m.leadsSpawned),
    String(m.handoffs),
    String(m.kickbacks.total),
    m.kickbacks.ratePerMergedPr === null ? "n/a" : String(m.kickbacks.ratePerMergedPr),
    String(m.kickbacks.deepTail.length),
    fmtH(m.timing.timeToFirstHandoffHours.median),
    fmtH(m.timing.timeToMergeHours.median),
    fmtH(m.timing.timeToMergeHours.p90),
    fmtN(m.tokens.total),
    m.tokens.perMergedPr === null ? "n/a" : fmtN(m.tokens.perMergedPr),
  ];
}

export function buildTrendRow(m) {
  return [
    m.runStartedIso ? m.runStartedIso.slice(0, 10) : "n/a",
    m.run,
    String(m.prsMerged),
    String(m.kickbacks.total),
    m.kickbacks.ratePerMergedPr === null ? "n/a" : String(m.kickbacks.ratePerMergedPr),
    // 5.1: the blended kickback rate two columns back stays as-is here (a dense multi-run table can't
    // show the full covered/uncovered split per row) — this column is what makes it SAFE to read: two
    // runs are only comparable side by side when this cell reads the same for both. "Runs are only
    // comparable at equal coverage" (2026-07-31 plan, PHASE 5.1).
    gateCoverageLabel(m.gateCoverage),
    fmtH(m.timing.timeToMergeHours.median),
    fmtN(m.tokens.total),
    m.tokens.perMergedPr === null ? "n/a" : fmtN(m.tokens.perMergedPr),
  ];
}

export function renderAllMarkdown(allMetrics) {
  const sorted = [...allMetrics].sort((a, b) => runSortKey(a) - runSortKey(b));
  const lines = [];
  lines.push("# Run-quality trend report");
  lines.push("");
  lines.push("## Per-run summary");
  lines.push("");
  lines.push(
    mdTable(
      [
        "Run",
        "Started",
        "Mode",
        "PRs merged",
        "Issues closed",
        "Leads spawned",
        "Hand-offs",
        "Kickbacks",
        "Kickback rate",
        "Deep tails",
        "Median TTFH",
        "Median TTM",
        "p90 TTM",
        "Total tokens",
        "Tokens/PR",
      ],
      sorted.map(buildSummaryRow),
    ),
  );
  lines.push("");
  lines.push("## Cross-run trend");
  lines.push("");
  lines.push(
    mdTable(
      ["Date", "Run", "Merged PRs", "Kickbacks", "Kickback rate", "Gate coverage", "Median time-to-merge", "Total tokens", "Tokens/PR"],
      sorted.map(buildTrendRow),
    ),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI — gh I/O lives ONLY here (5.1). `computeMetricsFromEvents` stays pure per the module contract;
// everything below just measures a `coverageByPr` map and hands it in through the options bag, exactly
// the shape classifyGateCoverage already expects. Mirrors work-runner.mjs's `runCommand` (never throws,
// a missing/erroring binary resolves as an exit code rather than an exception) and its
// `{ run = runCommand }` injection pattern (`deliveredVsAssigned`, `shaDescendsFrom`), so both the fetch
// itself and the two things that can go wrong with it (no slug, gh failing) are testable without a live
// `gh` or network.
// ---------------------------------------------------------------------------

function runCommand({ command, args, cwd, timeoutMs = 30000 }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs).unref?.();
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ exitCode: 127, stdout, stderr: stderr + e.message });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export async function resolveRepoSlug({ cwd = process.cwd(), run = runCommand } = {}) {
  const res = await run({ command: "gh", args: ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd });
  if (res.exitCode !== 0) return null;
  const slug = String(res.stdout || "").trim();
  return slug || null;
}

// The actual measurement behind 5.1. One `gh api` call per merged PR, filtered to `botLogin` server-side
// (jq in `-q`, same pattern `ready`'s codex-on-head check uses in work-runner.mjs) so this is a length
// check, not a body parse. A PR whose call fails is left OUT of `coverageByPr` entirely — never written
// as `false` — because classifyGateCoverage treats "absent" as UNKNOWN and "false" as a measured "the
// bot reviewed nothing here", and those are different facts (2.1's shim-fake-hang lesson, one level up:
// a probe that can't tell "no" from "couldn't ask" will eventually report the wrong one with confidence).
export async function fetchBotReviewCoverage({ prNumbers, repoSlug, botLogin = DEFAULT_REVIEW_BOT_LOGIN, cwd = process.cwd(), run = runCommand }) {
  if (!prNumbers.length) return { coverageByPr: {}, reason: null };
  if (!repoSlug) return { coverageByPr: null, reason: "no repo slug (gh repo view failed, and --repo was not given)" };
  const coverageByPr = {};
  let anyOk = false;
  for (const n of prNumbers) {
    const res = await run({
      command: "gh",
      args: ["api", `repos/${repoSlug}/pulls/${n}/reviews`, "--paginate", "-q", `[.[]|select(.user.login=="${botLogin}")]|length`],
      cwd,
    });
    if (res.exitCode !== 0) continue; // this PR's coverage is UNKNOWN — see the note above; not "uncovered"
    const v = String(res.stdout || "").trim();
    if (!/^\d+$/.test(v)) continue;
    coverageByPr[n] = Number(v) > 0;
    anyOk = true;
  }
  if (!anyOk) return { coverageByPr: null, reason: "gh api failed for every merged PR (no gh on PATH, auth, or rate-limit)" };
  return { coverageByPr, reason: null };
}

async function resolveCoverageForRun({ prNumbers, repo, botLogin, noCoverage }) {
  const login = botLogin || DEFAULT_REVIEW_BOT_LOGIN;
  if (noCoverage) return { coverageByPr: null, reason: "coverage fetch skipped (--no-coverage)", botLogin: login };
  if (!prNumbers.length) return { coverageByPr: {}, reason: null, botLogin: login };
  const slug = repo || (await resolveRepoSlug());
  const fetched = await fetchBotReviewCoverage({ prNumbers, repoSlug: slug, botLogin: login });
  return { ...fetched, botLogin: login };
}

async function computeRunMetricsCli(runDir, opts) {
  const events = readEvents(runDir);
  const usageJson = loadUsageJson(runDir);
  const base = { run: basename(runDir), runDir, usageJson, ledgerSkipped: lastReadSkipped(runDir) };
  const prelim = computeMetricsFromEvents(events, base);
  const coverage = await resolveCoverageForRun({ prNumbers: prelim.prRecords.map((r) => r.pr), ...opts });
  return computeMetricsFromEvents(events, {
    ...base,
    coverageByPr: coverage.coverageByPr,
    coverageUnmeasuredReason: coverage.reason,
    coverageBotLogin: coverage.botLogin,
  });
}

function usage() {
  return [
    "Usage:",
    "  node work-metrics.mjs --run <run-dir> [--json] [--out <file>]",
    "                         [--repo <owner/repo>] [--bot-login <login>] [--no-coverage]",
    "  node work-metrics.mjs --all --runs-root <dir> [--json] [--out <file>]",
    "                         [--repo <owner/repo>] [--bot-login <login>] [--no-coverage]",
  ].join("\n");
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.run && !args.all)) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  let markdown;
  let jsonOut;
  const coverageOpts = { repo: args.repo, botLogin: args.botLogin, noCoverage: args.noCoverage };

  if (args.run) {
    if (!existsSync(join(args.run, "events.jsonl"))) {
      process.stderr.write(`No events.jsonl found under ${args.run}\n`);
      process.exitCode = 1;
      return;
    }
    const metrics = await computeRunMetricsCli(args.run, coverageOpts);
    markdown = renderRunMarkdown(metrics);
    jsonOut = metrics;
  } else {
    const root = args.runsRoot || process.cwd();
    if (!existsSync(root)) {
      process.stderr.write(`Runs root not found: ${root}\n`);
      process.exitCode = 1;
      return;
    }
    const dirs = findRunDirs(root);
    const allMetrics = [];
    for (const d of dirs) allMetrics.push(await computeRunMetricsCli(d, coverageOpts));
    allMetrics.sort((a, b) => runSortKey(a) - runSortKey(b));
    markdown = renderAllMarkdown(allMetrics);
    jsonOut = { runs: allMetrics };
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(jsonOut, null, 2)}\n`);
  } else {
    process.stdout.write(`${markdown}\n`);
  }
  if (args.out) {
    writeFileSync(args.out, `${markdown}\n`, "utf8");
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || err}\n`);
    process.exitCode = 1;
  });
}
