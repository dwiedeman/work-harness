// work-metrics.test.mjs — unit tests for the standalone run-quality metrics report (DER-2007 / T2.2).
// Run: node --test work-metrics.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildSummaryRow,
  buildTrendRow,
  computeLeadTypeBreakdown,
  computeMetricsFromEvents,
  computeRunMetrics,
  findRunDirs,
  foldTokenUsage,
  percentile,
  readEvents,
  renderRunMarkdown,
  runSortKey,
  statsFor,
} from "./work-metrics.mjs";

function ev(overrides) {
  return { actor: "test", ...overrides };
}

function withTmpRun(events, fn) {
  const dir = mkdtempSync(join(tmpdir(), "work-metrics-test-"));
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(dir, "events.jsonl"), `${body}\n`, "utf8");
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// percentile / statsFor
// ---------------------------------------------------------------------------

test("percentile: empty array is null", () => {
  assert.equal(percentile([], 50), null);
});

test("percentile: single value returns itself at any p", () => {
  assert.equal(percentile([7], 0), 7);
  assert.equal(percentile([7], 90), 7);
});

test("percentile: median/p90 on a known small set", () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(arr, 50), 5.5);
  assert.equal(Math.round(percentile(arr, 90) * 10) / 10, 9.1);
});

test("statsFor: filters non-numeric/non-finite and reports n", () => {
  const s = statsFor([1, null, 2, undefined, Number.NaN, 3]);
  assert.equal(s.n, 3);
  assert.equal(s.median, 2);
  assert.equal(s.max, 3);
});

test("statsFor: empty input yields all-null stats", () => {
  const s = statsFor([]);
  assert.deepEqual(s, { median: null, p90: null, max: null, n: 0 });
});

// ---------------------------------------------------------------------------
// event folding — merged counts, kickback rounds, timing chain
// ---------------------------------------------------------------------------

test("computeMetricsFromEvents: dedupes pr_merged by pr number (reconcile+shepherd double-write)", () => {
  const events = [
    ev({ type: "run_started", ts: "2026-01-01T00:00:00.000Z" }),
    ev({ type: "lead_spawned", issue: "DER-1", bundle: [], ts: "2026-01-01T00:00:00.000Z" }),
    ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" }),
    ev({ actor: "reconcile", type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T02:00:00.000Z" }),
    ev({ actor: "shepherd", type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T02:05:00.000Z" }),
  ];
  const m = computeMetricsFromEvents(events, { run: "synthetic" });
  assert.equal(m.prsMerged, 1);
  assert.equal(m.issuesClosed, 1);
  // merge ts should be the EARLIEST of the two duplicate pr_merged events (02:00, not 02:05)
  assert.equal(m.prRecords[0].timeToMergeHours, 1); // 02:00 - 01:00 = 1h
});

test("computeLeadTypeBreakdown: groups issues/attempts/kickbacks/merged by lead type; claude sorts first", () => {
  const events = [
    ev({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T00:00:00.000Z" }), // claude (untagged)
    ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" }),
    ev({ type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T02:00:00.000Z" }),
    ev({ type: "lead_spawned", issue: "DER-2", leadType: "kimi", ts: "2026-01-01T00:00:00.000Z" }),
    ev({ type: "kickback", pr: 2, issue: "DER-2", ts: "2026-01-01T01:10:00.000Z" }),
    ev({ type: "lead_spawned", issue: "DER-2", leadType: "kimi", kickback: 1, ts: "2026-01-01T01:20:00.000Z" }), // re-spawn, same type
    ev({ type: "pr_merged", pr: 2, issue: "DER-2", ts: "2026-01-01T02:00:00.000Z" }),
    ev({ type: "lead_spawned", issue: "DER-3", leadType: "gpt", ts: "2026-01-01T00:00:00.000Z" }), // not merged
  ];
  const by = Object.fromEntries(computeLeadTypeBreakdown(events).map((x) => [x.leadType, x]));
  assert.equal(by.claude.issues, 1);
  assert.equal(by.claude.merged, 1);
  assert.equal(by.kimi.attempts, 2, "initial spawn + re-spawn both count");
  assert.equal(by.kimi.issues, 1, "but only one distinct issue");
  assert.equal(by.kimi.kickbacks, 1);
  assert.equal(by.kimi.merged, 1);
  assert.equal(by.gpt.issues, 1);
  assert.equal(by.gpt.merged, 0);
  assert.equal(computeLeadTypeBreakdown(events)[0].leadType, "claude", "claude default sorts first");
});

test("computeMetricsFromEvents: kickback rounds per PR and deep-tail threshold", () => {
  const events = [
    ev({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T00:00:00.000Z" }),
    ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" }),
    ev({ type: "kickback", pr: 1, issue: "DER-1", ts: "2026-01-01T01:10:00.000Z" }),
    ev({ type: "kickback", pr: 1, issue: "DER-1", ts: "2026-01-01T01:20:00.000Z" }),
    ev({ type: "kickback", pr: 1, issue: "DER-1", ts: "2026-01-01T01:30:00.000Z", round: 3 }),
    ev({ type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T02:00:00.000Z" }),
    // a second PR with only 1 kickback — should NOT show up in the deep tail
    ev({ type: "lead_spawned", issue: "DER-2", ts: "2026-01-01T00:00:00.000Z" }),
    ev({ type: "handed_off", pr: 2, issue: "DER-2", ts: "2026-01-01T01:00:00.000Z" }),
    ev({ type: "kickback", pr: 2, issue: "DER-2", ts: "2026-01-01T01:10:00.000Z" }),
    ev({ type: "pr_merged", pr: 2, issue: "DER-2", ts: "2026-01-01T01:30:00.000Z" }),
  ];
  const m = computeMetricsFromEvents(events, { run: "synthetic" });
  assert.equal(m.prsMerged, 2);
  assert.equal(m.kickbacks.total, 4);
  assert.equal(m.kickbacks.ratePerMergedPr, 2); // 4 kickbacks / 2 merged PRs
  assert.equal(m.kickbacks.deepTail.length, 1);
  assert.equal(m.kickbacks.deepTail[0].pr, 1);
  assert.equal(m.kickbacks.deepTail[0].rounds, 3);
  // PR 1 should also surface as an outlier (deep tail)
  assert.ok(m.outliers.some((o) => o.pr === 1));
  assert.ok(!m.outliers.some((o) => o.pr === 2));
});

test("computeMetricsFromEvents: first lead_spawned wins across kickback respawns for the same issue", () => {
  const events = [
    ev({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T00:00:00.000Z" }),
    ev({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T00:30:00.000Z" }), // respawn after kickback
    ev({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" }), // another respawn
    ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T01:30:00.000Z" }),
    ev({ type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T02:00:00.000Z" }),
  ];
  const m = computeMetricsFromEvents(events, { run: "synthetic" });
  assert.equal(m.leadsSpawned, 3);
  assert.equal(m.leadsSpawnedDistinctIssues, 1);
  // time-to-first-handoff must use the EARLIEST spawn (00:00), not the latest respawn
  assert.equal(m.prRecords[0].timeToFirstHandoffHours, 1.5);
});

test("computeMetricsFromEvents: handed_off missing `issue` on later rounds still groups by pr", () => {
  // Real ledgers only carry `issue` on the FIRST handed_off for a pr; later re-hand-offs after a
  // kickback fix carry only `pr`. Grouping must be purely by pr, not require `issue` every time.
  const events = [
    ev({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T00:00:00.000Z" }),
    ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" }),
    ev({ type: "kickback", pr: 1, issue: "DER-1", ts: "2026-01-01T01:10:00.000Z" }),
    ev({ type: "handed_off", pr: 1, ts: "2026-01-01T01:20:00.000Z" }), // no `issue` field
    ev({ type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T02:00:00.000Z" }),
  ];
  const m = computeMetricsFromEvents(events, { run: "synthetic" });
  assert.equal(m.prsMerged, 1);
  // first (earliest) handed_off is 01:00, so time-to-first-handoff is 1h and time-to-merge is 1h
  assert.equal(m.prRecords[0].timeToFirstHandoffHours, 1);
  assert.equal(m.prRecords[0].timeToMergeHours, 1);
});

test("computeMetricsFromEvents: missing lead_spawned falls back to pr_opened for the start timestamp", () => {
  const events = [
    ev({ type: "pr_opened", pr: 1, issue: "DER-1", ts: "2026-01-01T00:00:00.000Z" }),
    ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T00:45:00.000Z" }),
    ev({ type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" }),
  ];
  const m = computeMetricsFromEvents(events, { run: "synthetic" });
  // 45 minutes = 0.75h, which round1 (round-half-up to 1 decimal) renders as 0.8
  assert.equal(m.prRecords[0].timeToFirstHandoffHours, 0.8);
});

test("computeMetricsFromEvents: no lead_spawned and no pr_opened yields null timing, not a crash", () => {
  const events = [
    ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T00:45:00.000Z" }),
    ev({ type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" }),
  ];
  const m = computeMetricsFromEvents(events, { run: "synthetic" });
  assert.equal(m.prRecords[0].timeToFirstHandoffHours, null);
  // 15 minutes = 0.25h, which round1 (round-half-up to 1 decimal) renders as 0.3
  assert.equal(m.prRecords[0].timeToMergeHours, 0.3);
});

test("computeMetricsFromEvents: issues closed unions issue + issues[] + bundle[] across events", () => {
  const events = [
    ev({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T00:00:00.000Z" }),
    ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" }),
    ev({ actor: "reconcile", type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T02:00:00.000Z" }),
    ev({
      actor: "shepherd",
      type: "pr_merged",
      pr: 1,
      issue: "DER-1",
      issues: ["DER-1", "DER-2", "DER-3"],
      ts: "2026-01-01T02:05:00.000Z",
    }),
  ];
  const m = computeMetricsFromEvents(events, { run: "synthetic" });
  assert.equal(m.issuesClosed, 3);
  assert.deepEqual(m.issuesClosedList, ["DER-1", "DER-2", "DER-3"]);
});

// ---------------------------------------------------------------------------
// token folding — by_model dedup by report_id
// ---------------------------------------------------------------------------

test("foldTokenUsage: collapses repeated report_id to the latest/largest cumulative report", () => {
  const events = [
    ev({
      type: "token_usage",
      role: "lead",
      report_id: "abc",
      model: "claude-opus-4-8",
      by_model: { "claude-opus-4-8": { input: 10, output: 100, cache_creation: 5, cache_read: 5 } },
      total_tokens: 120,
      ts: "2026-01-01T00:00:00.000Z",
    }),
    ev({
      // same report_id, later re-post with a bigger cumulative total — should WIN, not be summed
      type: "token_usage",
      role: "lead",
      report_id: "abc",
      model: "claude-opus-4-8",
      by_model: { "claude-opus-4-8": { input: 20, output: 200, cache_creation: 10, cache_read: 10 } },
      total_tokens: 240,
      ts: "2026-01-01T00:05:00.000Z",
    }),
  ];
  const fold = foldTokenUsage(events);
  assert.equal(fold.reports, 1);
  assert.equal(fold.totalTokens, 240);
  assert.equal(fold.total.input, 20);
});

test("foldTokenUsage: events without report_id are all counted (legacy every-event path)", () => {
  const events = [
    ev({
      type: "token_usage",
      role: "shepherd",
      model: "claude-opus-4-8",
      by_model: { "claude-opus-4-8": { input: 1, output: 1, cache_creation: 0, cache_read: 0 } },
      ts: "2026-01-01T00:00:00.000Z",
    }),
    ev({
      type: "token_usage",
      role: "shepherd",
      model: "claude-opus-4-8",
      by_model: { "claude-opus-4-8": { input: 1, output: 1, cache_creation: 0, cache_read: 0 } },
      ts: "2026-01-01T00:01:00.000Z",
    }),
  ];
  const fold = foldTokenUsage(events);
  assert.equal(fold.reports, 2);
  assert.equal(fold.totalTokens, 4);
});

test("foldTokenUsage: skips token_usage events without by_model", () => {
  const events = [ev({ type: "token_usage", role: "lead", model: "claude-opus-4-8", input: 5, output: 5, ts: "2026-01-01T00:00:00.000Z" })];
  const fold = foldTokenUsage(events);
  assert.equal(fold.reports, 0);
  assert.equal(fold.totalTokens, 0);
});

test("foldTokenUsage: a single report can attribute tokens to multiple models under one role", () => {
  const events = [
    ev({
      type: "token_usage",
      role: "lead",
      report_id: "multi",
      by_model: {
        "claude-opus-4-8": { input: 10, output: 10, cache_creation: 0, cache_read: 0 },
        "claude-sonnet-5": { input: 5, output: 5, cache_creation: 0, cache_read: 0 },
      },
      total_tokens: 30,
      ts: "2026-01-01T00:00:00.000Z",
    }),
  ];
  const m = computeMetricsFromEvents(events, { run: "synthetic" });
  assert.equal(m.tokens.total, 30);
  assert.equal(Object.keys(m.tokens.byRoleModel.lead).length, 2);
});

// ---------------------------------------------------------------------------
// malformed-line tolerance (via readEvents on a real temp file)
// ---------------------------------------------------------------------------

test("readEvents: tolerates blank lines, invalid JSON, and objects with no `type`", () => {
  withTmpRun(
    [
      { type: "run_started", ts: "2026-01-01T00:00:00.000Z" },
    ],
    (dir) => {
      // hand-write a ledger with junk interleaved, bypassing the withTmpRun JSON.stringify path
      const path = join(dir, "events.jsonl");
      const lines = [
        JSON.stringify({ type: "run_started", ts: "2026-01-01T00:00:00.000Z" }),
        "",
        "   ",
        "{not valid json",
        JSON.stringify({ actor: "noop", ts: "2026-01-01T00:01:00.000Z" }), // no `type` field
        JSON.stringify({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T00:02:00.000Z" }),
      ];
      writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
      const events = readEvents(dir);
      assert.equal(events.length, 2); // run_started + lead_spawned only
      assert.deepEqual(
        events.map((e) => e.type),
        ["run_started", "lead_spawned"],
      );
    },
  );
});

test("computeRunMetrics: end-to-end over a real temp run dir with malformed lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-metrics-test-"));
  try {
    const lines = [
      JSON.stringify(ev({ type: "run_started", ts: "2026-01-01T00:00:00.000Z" })),
      "not json at all",
      JSON.stringify(ev({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T00:00:00.000Z" })),
      JSON.stringify(ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" })),
      JSON.stringify(ev({ type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T01:30:00.000Z" })),
    ];
    writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
    const m = computeRunMetrics(dir);
    assert.equal(m.prsMerged, 1);
    assert.equal(m.run, dir.split("/").pop());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// trend-table row shape
// ---------------------------------------------------------------------------

test("buildSummaryRow: fixed column count and order", () => {
  const m = computeMetricsFromEvents(
    [
      ev({ type: "run_started", ts: "2026-01-01T00:00:00.000Z" }),
      ev({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T00:00:00.000Z" }),
      ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" }),
      ev({ type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T02:00:00.000Z" }),
    ],
    { run: "run-a" },
  );
  const row = buildSummaryRow(m);
  assert.equal(row.length, 15);
  assert.equal(row[0], "run-a");
  assert.equal(row[2], "n/a"); // Mode — absent on this fixture's run_started
  assert.equal(row[3], "1"); // PRs merged
});

test("buildSummaryRow: reports the run MODE, so spec-mode and issue-mode runs are comparable", () => {
  const spec = computeMetricsFromEvents(
    [
      ev({ type: "run_started", ts: "2026-01-01T00:00:00.000Z", mode: "spec", tracking: "DER-2700", specRef: "docs/specs/foo.md" }),
      ev({ type: "lead_spawned", issue: "SPEC-FOO-U1", ts: "2026-01-01T00:00:00.000Z" }),
      ev({ type: "handed_off", pr: 1, issue: "SPEC-FOO-U1", ts: "2026-01-01T01:00:00.000Z" }),
      ev({ type: "pr_merged", pr: 1, issue: "SPEC-FOO-U1", ts: "2026-01-01T02:00:00.000Z" }),
    ],
    { run: "run-spec" },
  );
  assert.equal(spec.mode, "spec");
  assert.equal(spec.tracking, "DER-2700");
  assert.equal(buildSummaryRow(spec)[2], "spec");
  assert.equal(spec.prsMerged, 1, "a spec unit id keys the ledger exactly as a Linear id does");
  // Control — an issue-list run reports its own mode, so the column can distinguish them.
  const issues = computeMetricsFromEvents(
    [ev({ type: "run_started", ts: "2026-01-01T00:00:00.000Z", mode: "issue-list" })],
    { run: "run-issues" },
  );
  assert.equal(buildSummaryRow(issues)[2], "issue-list");
});

test("buildTrendRow: fixed column count, order, and content matches the spec'd trend columns", () => {
  const m = computeMetricsFromEvents(
    [
      ev({ type: "run_started", ts: "2026-01-02T00:00:00.000Z" }),
      ev({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-02T00:00:00.000Z" }),
      ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-02T01:00:00.000Z" }),
      ev({ type: "kickback", pr: 1, issue: "DER-1", ts: "2026-01-02T01:15:00.000Z" }),
      ev({ type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-02T03:00:00.000Z" }),
    ],
    { run: "run-b" },
  );
  const row = buildTrendRow(m);
  assert.deepEqual(row, ["2026-01-02", "run-b", "1", "1", "1", "2.0h", "0", "0"]);
});

test("runSortKey: falls back to the run-dir timestamp prefix when run_started is absent", () => {
  const m = computeMetricsFromEvents([], { run: "20260715T003745Z-issue-wave" });
  const key = runSortKey(m);
  assert.equal(key, Date.parse("2026-07-15T00:37:45Z"));
});

test("runSortKey: unparseable run name sorts last (Infinity)", () => {
  const m = computeMetricsFromEvents([], { run: "not-a-timestamped-name" });
  assert.equal(runSortKey(m), Infinity);
});

// ---------------------------------------------------------------------------
// findRunDirs — must follow symlinked run dirs, not just real directories
// ---------------------------------------------------------------------------

test("findRunDirs: skips files and non-run dirs, includes a symlinked-in run dir", () => {
  const root = mkdtempSync(join(tmpdir(), "work-metrics-root-"));
  const realRun = mkdtempSync(join(tmpdir(), "work-metrics-realrun-"));
  try {
    writeFileSync(join(realRun, "events.jsonl"), `${JSON.stringify(ev({ type: "run_started", ts: "2026-01-01T00:00:00.000Z" }))}\n`, "utf8");

    // a plain (non-run) subdirectory with no events.jsonl — must be skipped
    const notARun = join(root, "worktrees");
    mkdtempSync(join(root, "worktrees-"));
    // a stray file at the root — must be skipped without throwing
    writeFileSync(join(root, ".DS_Store"), "junk", "utf8");
    // a symlink pointing at the real run dir — Dirent.isDirectory() does not follow symlinks,
    // so this only shows up if findRunDirs falls back to statSync on symbolic links
    symlinkSync(realRun, join(root, "linked-run"));

    const dirs = findRunDirs(root);
    assert.ok(dirs.some((d) => d === join(root, "linked-run")), `expected the symlinked run dir in ${JSON.stringify(dirs)}`);
    assert.ok(!dirs.includes(notARun));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(realRun, { recursive: true, force: true });
  }
});

// ---- DER-2748: this reader must agree with the runner's about one ledger --------------------------
// Measured before the fix: a single duplicated `token_usage` line reported 165 tokens here against the
// runner's correct 110, because a relayed replay was folded twice. Two instruments disagreeing about one
// ledger is the DER-2581 defect class, so the dedup rule is duplicated (this module is standalone by
// contract) and pinned by the agreement test below.
import { readEvents as wmReadEvents, dedupeLedgerEvents as wmDedupe } from "./work-metrics.mjs";
import { dedupeLedgerEvents as runnerDedupe } from "./work-runner.mjs";

const stamped = (over = {}) => ({
  actor: "lead:DER-1", type: "token_usage", role: "lead",
  by_model: { "claude-opus-5": { input: 10, output: 10 } }, total_tokens: 55,
  event_id: "0193aaa-1", source_id: "hostA:11:n1", seq: 1, schema_version: 1,
  ts: "2026-07-29T01:00:00.000Z", ...over,
});

function ledgerDir(events) {
  const dir = mkdtempSync(join(tmpdir(), "wm-dedupe-"));
  writeFileSync(join(dir, "events.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  return dir;
}

test("DER-2748: a duplicated ledger line is folded ONCE, matching the runner's total", () => {
  const dup = stamped();
  const distinct = stamped({ event_id: "0193aaa-2", seq: 2 });
  const dir = ledgerDir([dup, dup, distinct]);
  try {
    const events = wmReadEvents(dir);
    const total = events.filter((e) => e.type === "token_usage").reduce((a, e) => a + e.total_tokens, 0);
    assert.equal(events.length, 2, "the replayed line must not appear twice");
    assert.equal(total, 110, "a replay must not inflate reported spend (was 165 — the measured bug)");
    // CONTROL: the two DISTINCT events are both kept — dedup must not eat real events.
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DER-2748 CONTROL: a LEGACY ledger (no event_id, no source_id) loses nothing", () => {
  // The two SessionEnd hooks still append unstamped lines, so this is the LIVE shape, not just history.
  // A dedup rule that keyed on absent fields would silently collapse them into one.
  const legacy = { actor: "lead:DER-9", type: "token_usage", role: "lead", by_model: { m: { input: 1 } }, total_tokens: 7 };
  const dir = ledgerDir([legacy, legacy, legacy]);
  try {
    assert.equal(wmReadEvents(dir).length, 3, "legacy lines carry no identity and must never be dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DER-2748: work-metrics' dedup rule AGREES with work-runner's, ledger for ledger", () => {
  // This test is what makes duplicating the rule safe instead of reckless. If either copy drifts, it fails.
  const a = stamped();
  const b = stamped({ event_id: "0193aaa-2", seq: 2 });
  const idOnly = stamped({ event_id: "0193aaa-3", source_id: undefined, seq: undefined });
  const pairOnly = stamped({ event_id: undefined, source_id: "hostB:22:n2", seq: 5 });
  const legacy = { type: "reaped", issue: "DER-3" };
  const ledgers = [
    [a, a, b],                               // id replay
    [pairOnly, { ...pairOnly, event_id: "regenerated" }], // same (source,seq), new id
    [idOnly, idOnly, b],                     // id-only identity
    [legacy, legacy],                        // no identity at all
    [a, b, pairOnly, idOnly, legacy],        // mixed
    [],                                      // empty
  ];
  for (const [i, ledger] of ledgers.entries()) {
    assert.deepEqual(
      wmDedupe(ledger), runnerDedupe(ledger),
      `ledger ${i}: work-metrics and work-runner must fold identically`,
    );
  }
});

// ---- DER-2738: the two readers must also agree about what a BAD LINE is --------------------------
// The runner no longer throws on a line it cannot parse — it skips and QUARANTINES it. That makes "which
// lines are bad" a shared rule, and this reader's copy of it (`classifyLedgerLine`, duplicated because
// this module is standalone by contract) has to match line for line. If they drifted, one instrument would
// report a run's history over a different set of lines than the other — the DER-2581 defect class.
import { classifyLedgerLine as wmClassify, lastReadSkipped } from "./work-metrics.mjs";
import { classifyLedgerLine as runnerClassify, readEvents as runnerReadEvents } from "./work-runner.mjs";

const LINE_TABLE = [
  JSON.stringify({ type: "run_started", ts: "2026-01-01T00:00:00.000Z" }), // healthy
  JSON.stringify(stamped()),                                              // healthy, stamped
  "",                                                                     // blank
  "   ",                                                                  // whitespace
  "{not valid json",                                                      // malformed, complete
  '{"type":"kickback",,,}',                                               // malformed, complete
  '{"type":"pr_opened","issue":"DER-1","pr":',                            // TRUNCATED mid-JSON (the crash shape)
  '{"actor":"noop","ts":"2026-01-01T00:01:00.000Z"}',                     // valid JSON, no `type`
  "42",                                                                   // valid JSON, not an object
  '"a string"',                                                           // valid JSON, not an object
  "null",                                                                 // valid JSON, not an object
  '[{"type":"run_started"}]',                                             // an ARRAY is not an event
  JSON.stringify({ type: "reaped", issue: "DER-3" }),                     // legacy (no protocol fields)
];

test("DER-2738: work-metrics and work-runner agree, line for line, on what a bad ledger line is", () => {
  for (const line of LINE_TABLE) {
    assert.deepEqual(
      wmClassify(line), runnerClassify(line),
      `line ${JSON.stringify(line)}: the two readers must classify it identically`,
    );
  }
  // ANTI-VACUITY: the table must actually exercise BOTH verdicts and every reason, or this agrees about
  // nothing. (A table that had become all-healthy would still pass the loop above.)
  const reasons = new Set(LINE_TABLE.map((l) => wmClassify(l).reason ?? "ok"));
  assert.deepEqual(
    [...reasons].sort(),
    ["blank", "malformed_json", "no_type", "not_an_object", "ok"],
    "the agreement table must cover every classification, healthy included",
  );
});

test("DER-2738: both readers fold the SAME events out of one DAMAGED ledger (torn tail + malformed record)", async () => {
  // Byte-exact ledger, deliberately NOT newline-terminated: the last line is a writer killed mid-append.
  const good1 = JSON.stringify({ type: "run_started", ts: "2026-01-01T00:00:00.000Z" });
  const good2 = JSON.stringify({ type: "lead_spawned", issue: "DER-1", ts: "2026-01-01T00:01:00.000Z" });
  const good3 = JSON.stringify({ type: "pr_merged", issue: "DER-1", pr: 5, ts: "2026-01-01T02:00:00.000Z" });
  const bodies = [
    `${good1}\n{"type":"kickback",,,}\n${good2}\n${good3}\n{"type":"pr_opened","pr":`, // malformed + torn tail
    `${good1}\n\n   \n${good2}\n`,                                                      // blanks only (healthy)
    `${good1}\n42\n{"actor":"noop"}\n${good3}\n`,                                       // non-object + no type
    `${good1}\n${good2}\n${good3}`,                                                     // unterminated but VALID last line
  ];
  for (const [i, body] of bodies.entries()) {
    const dir = mkdtempSync(join(tmpdir(), "wm-agree-damaged-"));
    try {
      writeFileSync(join(dir, "events.jsonl"), body, "utf8");
      const norm = (evs) => evs.map((e) => JSON.stringify(e)).sort();
      const mine = wmReadEvents(dir);
      const theirs = await runnerReadEvents(dir);
      assert.deepEqual(norm(mine), norm(theirs), `ledger ${i}: the two readers accepted different lines`);
      // Neither reader may throw, and both must keep the intact events.
      assert.ok(mine.some((e) => e.type === "run_started"), `ledger ${i}: the valid prefix must survive`);
      // The skip count is this reader's visibility channel — it must match what it actually dropped.
      const lineCount = body.split("\n").filter((l) => l.trim()).length;
      assert.equal(lastReadSkipped(dir), lineCount - mine.length, `ledger ${i}: skipped lines must be counted, not swallowed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("DER-2738: a damaged ledger's metrics report SAYS it had holes (a lower bound, not a total)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-damaged-report-"));
  try {
    const lines = [
      JSON.stringify(ev({ type: "run_started", ts: "2026-01-01T00:00:00.000Z" })),
      JSON.stringify(ev({ type: "handed_off", pr: 1, issue: "DER-1", ts: "2026-01-01T01:00:00.000Z" })),
      '{"type":"pr_merged","pr":1,"issue":"DER-1","ts":', // torn mid-append: a MERGE we cannot count
    ];
    writeFileSync(join(dir, "events.jsonl"), lines.join("\n"), "utf8");
    const m = computeRunMetrics(dir);
    assert.equal(m.prsMerged, 0, "the torn line's merge genuinely cannot be counted");
    assert.equal(m.ledgerSkipped, 1, "…so the report must carry the fact that a line was skipped");
    assert.match(renderRunMarkdown(m), /LEDGER DAMAGE: 1 line\(s\)/, "and an operator reading the report must SEE it");
    // CONTROL: the same report over an INTACT ledger carries no damage note (an always-on warning is not
    // a warning) and counts the merge.
    writeFileSync(join(dir, "events.jsonl"), `${lines[0]}\n${lines[1]}\n${JSON.stringify(ev({ type: "pr_merged", pr: 1, issue: "DER-1", ts: "2026-01-01T01:30:00.000Z" }))}\n`, "utf8");
    const clean = computeRunMetrics(dir);
    assert.equal(clean.prsMerged, 1);
    assert.equal(clean.ledgerSkipped, 0);
    assert.ok(!/LEDGER DAMAGE/.test(renderRunMarkdown(clean)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
