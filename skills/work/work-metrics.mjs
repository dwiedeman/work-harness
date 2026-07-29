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
// Usage:
//   node work-metrics.mjs --run <run-dir> [--json] [--out <file>]
//   node work-metrics.mjs --all --runs-root <dir> [--json] [--out <file>]

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
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Ledger reading — tolerant of blank lines, malformed JSON, and events with no
// recognized `type` (unknown event types from newer harness versions are just
// ignored rather than raising).
// ---------------------------------------------------------------------------

export function readEvents(runDir) {
  const file = join(runDir, "events.jsonl");
  const raw = readFileSync(file, "utf8");
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let d;
    try {
      d = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip, don't fail the whole report
    }
    if (!d || typeof d !== "object" || !d.type) continue;
    events.push(d);
  }
  return events;
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

export function computeMetricsFromEvents(events, { run, runDir = null, usageJson = null } = {}) {
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

  return {
    run: run ?? (runDir ? basename(runDir) : "run"),
    runDir,
    runStartedTs,
    runStartedIso: runStartedTs !== null ? new Date(runStartedTs).toISOString() : null,
    mode: runMode,
    tracking: runTracking,
    eventCount: events.length,
    prsMerged: mergedPrs.length,
    issuesClosed: issuesClosedSet.size,
    issuesClosedList: [...issuesClosedSet].sort(),
    leadsSpawned: leadSpawnedCount,
    leadsSpawnedDistinctIssues,
    handoffs: handedOffCount,
    kickbacks: { total: kickbackCount, ratePerMergedPr: kickbackRate, deepTail },
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
  return computeMetricsFromEvents(events, { run: basename(runDir), runDir, usageJson });
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
        ["Kickback rate (per merged PR)", m.kickbacks.ratePerMergedPr === null ? "n/a" : String(m.kickbacks.ratePerMergedPr)],
        ["Total tokens (ledger fold)", fmtN(m.tokens.total)],
        ["Tokens / merged PR", m.tokens.perMergedPr === null ? "n/a" : fmtN(m.tokens.perMergedPr)],
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
      ["Date", "Run", "Merged PRs", "Kickbacks", "Kickback rate", "Median time-to-merge", "Total tokens", "Tokens/PR"],
      sorted.map(buildTrendRow),
    ),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    "Usage:",
    "  node work-metrics.mjs --run <run-dir> [--json] [--out <file>]",
    "  node work-metrics.mjs --all --runs-root <dir> [--json] [--out <file>]",
  ].join("\n");
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.run && !args.all)) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  let markdown;
  let jsonOut;

  if (args.run) {
    if (!existsSync(join(args.run, "events.jsonl"))) {
      process.stderr.write(`No events.jsonl found under ${args.run}\n`);
      process.exitCode = 1;
      return;
    }
    const metrics = computeRunMetrics(args.run);
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
    const allMetrics = dirs.map((d) => computeRunMetrics(d)).sort((a, b) => runSortKey(a) - runSortKey(b));
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
  main(process.argv.slice(2));
}
