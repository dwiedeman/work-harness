#!/usr/bin/env node
// Session token reporter — the script every /work role's token telemetry actually comes from
// (DER-2745, 2026-07-29).
//
// Why this file exists AT ALL: the SessionEnd hook (session-end-telemetry.mjs) shelled out to
// `<cwd>/scripts/session-token-report.mjs` — a path in the CONSUMING repo — and exited 0 when it was
// absent. This harness shipped no such script, and neither does any repo that installs it fresh, so on
// every install outside the one repo that happened to have its own copy the hook found nothing, said
// nothing, and recorded nothing. `usage`, `work-metrics`, per-unit budget accounting and the budget
// circuit breaker then all read a session that spent 4M tokens as a session that spent zero — an
// undercount by omission that is indistinguishable from a cheap run. Shipping the reporter next to the
// hook makes a fresh install report for real; a consumer repo's own `scripts/session-token-report.mjs`
// still takes precedence (see `resolveReporter` in the hook) so an adopter that already has one keeps it.
//
// THE CENTRAL RULE HERE: this script never prints a number it did not measure. If the transcript cannot
// be found, or carries no usage, it exits NONZERO with a diagnostic on stderr and prints no event at
// all — because a fabricated `0` is the very defect the whole file is a fix for. The hook turns that
// nonzero exit into a durable `telemetry_gap` in the run ledger.
//
// Usage:
//   node session-token-report.mjs --role <orch|shepherd|lead|reviewer> [--session-id <id>]
//        [--transcript <path>] [--match <nonce>] [--issues DER-1,DER-2]
//        [--pr <n>] [--host <cloud|local|mini>] [--kickback <n>] [--rotation <n>] [--format event]
//
//   --format event   print ONLY the `WORK-EVENT {…}` line (what the SessionEnd hook consumes)
//   (default)        the same line FIRST, then a human summary — this whole stdout is what the cloud
//                    brief posts as a PR comment body, and `parsePrEventComments` only accepts a body
//                    that STARTS with the marker and parses the first line after it.
//
// Transcript resolution, most trustworthy first: an explicit `--transcript` (Claude Code hands the
// SessionEnd hook the exact path, so no guessing is needed on the hook path) → `<config>/projects/*/
// <session-id>.jsonl` → the newest transcript containing `--match <nonce>` (the manual fallback recipe
// in SKILL.md). "Newest file" is never used on its own: guessing which transcript belongs to a session
// is what made the nonce recipe necessary in the first place.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const EVENT_MARKER = "WORK-EVENT";

const TOKEN_FIELDS = ["input", "output", "cache_creation", "cache_read"];
const zeroTokens = () => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0 });
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// `cache_creation_input_tokens` is the flat field; newer API responses ALSO carry a `cache_creation`
// object broken out by TTL (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`). Reading only the
// flat one would silently drop every cache write on a session that used the newer shape — the same
// undercount-by-omission this file exists to stop, one field deep. Prefer the flat number when present
// (they describe the same tokens; summing both would double-count), else sum the breakdown.
function cacheCreation(u) {
  if (u.cache_creation_input_tokens != null) return num(u.cache_creation_input_tokens);
  const c = u.cache_creation;
  if (c && typeof c === "object") return Object.values(c).reduce((s, v) => s + num(v), 0);
  return 0;
}

// Streaming, memory-bounded accumulator over transcript lines.
//
// Dedup by `message.id`: one API response is written to the transcript as SEVERAL lines when it carries
// several content blocks (text + tool_use), and every one of those lines repeats the SAME `usage`
// object. Summing lines instead of responses inflates a session's spend by whatever fraction of its
// turns used tools — i.e. most of them. Falls back to `requestId`/`uuid`, and counts a line with no
// identity at all rather than dropping it (an unknown-identity line is real spend).
export function createUsageAccumulator() {
  const by_model = {};
  const seen = new Set();
  let entries = 0;
  let skipped = 0;
  return {
    addLine(line) {
      const s = typeof line === "string" ? line.trim() : "";
      // Cheap prefilter: only assistant lines carry `"usage"`, and a transcript is mostly other lines.
      if (!s || !s.includes('"usage"')) return;
      let e;
      try { e = JSON.parse(s); } catch { skipped += 1; return; } // torn tail line / partial write
      const u = e?.message?.usage;
      if (!u || typeof u !== "object") return;
      const id = e?.message?.id ?? e?.requestId ?? e?.uuid ?? null;
      if (id != null) {
        if (seen.has(id)) return;
        seen.add(id);
      }
      // Sidechain (subagent) turns are counted: they are spend this session incurred, and leaving them
      // out is how a lead that did all its work through subagents reported almost nothing.
      const model = String(e?.message?.model ?? "unknown");
      if (!by_model[model]) by_model[model] = zeroTokens();
      const t = by_model[model];
      t.input += num(u.input_tokens);
      t.output += num(u.output_tokens);
      t.cache_creation += cacheCreation(u);
      t.cache_read += num(u.cache_read_input_tokens);
      entries += 1;
    },
    result() {
      const tokens = zeroTokens();
      for (const u of Object.values(by_model)) for (const f of TOKEN_FIELDS) tokens[f] += u[f];
      return {
        by_model,
        tokens,
        total_tokens: TOKEN_FIELDS.reduce((s, f) => s + tokens[f], 0),
        models: Object.keys(by_model).sort(),
        entries,
        skipped_lines: skipped,
      };
    },
  };
}

// Whole-text convenience (tests, small transcripts). The CLI streams instead — a long lead session's
// transcript is tens of MB and `readFileSync` on it would be the hook's peak memory.
export function sumTranscriptUsage(text) {
  const acc = createUsageAccumulator();
  for (const line of String(text ?? "").split("\n")) acc.addLine(line);
  return acc.result();
}

export async function sumTranscriptFile(path) {
  const acc = createUsageAccumulator();
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) acc.addLine(line);
  return acc.result();
}

export function projectsRoot(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(base, "projects");
}

function listTranscripts(root) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) out.push(join(dir, f));
  }
  return out;
}

// A session id names its transcript file exactly, so this is a lookup, not a search.
export function findTranscriptBySessionId(sessionId, { root = projectsRoot() } = {}) {
  const id = String(sessionId ?? "");
  if (!id) return null;
  for (const p of listTranscripts(root)) {
    if (p.endsWith(`${id}.jsonl`)) return p;
  }
  return null;
}

// The `--match <nonce>` fallback: the operator echoed a nonce into the session, so the transcript that
// CONTAINS it is the session's own. Newest wins only among files that actually match.
export function findTranscriptByMatch(nonce, { root = projectsRoot(), maxBytes = 256 * 1024 * 1024 } = {}) {
  const needle = String(nonce ?? "");
  if (!needle) return null;
  const candidates = [];
  for (const p of listTranscripts(root)) {
    try {
      const st = statSync(p);
      if (st.size > maxBytes) continue;
      if (readFileSync(p, "utf8").includes(needle)) candidates.push({ p, mtime: st.mtimeMs });
    } catch { /* unreadable — not a candidate */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? candidates[0].p : null;
}

// The ledger event. Deliberately WITHOUT `cost_usd_estimate`: prices live in `work.config.json`
// (`modelPrices`), `aggregateTokenUsage` derives cost from them and books what it cannot price into a
// VISIBLE unpriced-spend gap. A price table hard-coded here would either go stale silently or invent a
// number — and `null` cost with real tokens is an honest input to that fold.
//
// `report_id` is a one-way hash of the session id, never the raw id (a session id is a credential-ish
// identifier and this output is posted to PUBLIC PR comments). Its job is idempotence: these reports are
// CUMULATIVE — every re-report re-reads the whole transcript — so the fold collapses same-report_id
// events to the largest/latest instead of summing a session two or three times.
export function buildTokenUsageEvent({
  role,
  issues = [],
  sessionId = null,
  transcript = null,
  usage,
  pr = null,
  host = null,
  kickback = null,
  rotation = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!usage || !usage.by_model) throw new Error("buildTokenUsageEvent: no measured usage to report");
  const ids = issues.filter(Boolean);
  const primary = ids[0] ?? null;
  const r = role || "unknown";
  const ev = {
    actor: r === "lead" && primary ? `lead:${primary}` : r,
    type: "token_usage",
    role: r,
    by_model: usage.by_model,
    tokens: usage.tokens,
    total_tokens: usage.total_tokens,
    // Only claimed when the session genuinely ran on ONE model. `by_model` is authoritative; a
    // "dominant model" guess on a mixed session is exactly the kind of confident-but-wrong field that
    // made other instruments in this harness lie.
    model: usage.models.length === 1 ? usage.models[0] : null,
    ts: now(),
    report_id: createHash("sha256").update(String(sessionId ?? transcript ?? "unknown")).digest("hex").slice(0, 12),
  };
  // BOTH shapes: `issues` is what the cloud brief has always emitted, and `issue` is what
  // `materializeState` keys on — it drops any event without it, which is how per-unit attribution
  // silently vanished before. The PRIMARY id keys the unit.
  if (primary) {
    ev.issue = primary;
    ev.issues = ids;
  }
  if (pr != null) ev.pr = pr;
  if (host) ev.host = host;
  if (kickback != null) ev.kickback = kickback;
  if (rotation != null) ev.rotation = rotation;
  return ev;
}

export function renderReport(ev, usage, { format = "human" } = {}) {
  const line = `${EVENT_MARKER} ${JSON.stringify(ev)}`;
  if (format === "event") return line;
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const rows = Object.entries(usage.by_model)
    .sort((a, b) => TOKEN_FIELDS.reduce((s, f) => s + b[1][f], 0) - TOKEN_FIELDS.reduce((s, f) => s + a[1][f], 0))
    .map(([m, u]) => `- \`${m}\`: ${fmt(TOKEN_FIELDS.reduce((s, f) => s + u[f], 0))} (in ${fmt(u.input)} · out ${fmt(u.output)} · cache-write ${fmt(u.cache_creation)} · cache-read ${fmt(u.cache_read)})`);
  return [
    line,
    ``,
    `**Token usage — role \`${ev.role}\`${ev.issue ? ` · ${ev.issues.join(", ")}` : ""}**`,
    `Total: **${fmt(usage.total_tokens)}** tokens across ${usage.entries} assistant turn(s).`,
    ...rows,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const int = (flag) => {
    const v = at(flag);
    return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  return {
    role: at("--role"),
    sessionId: at("--session-id"),
    transcript: at("--transcript"),
    match: at("--match"),
    issues: (at("--issues") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    pr: int("--pr"),
    host: at("--host"),
    kickback: int("--kickback"),
    rotation: int("--rotation"),
    format: at("--format") === "event" ? "event" : "human",
  };
}

// Every exit path that cannot produce a MEASURED report ends here: nonzero, diagnostic on stderr, and
// nothing on stdout. The caller (the SessionEnd hook, or an operator) must be able to tell "I don't
// know" apart from "zero" — that distinction is the entire point of this file.
function fail(msg) {
  process.stderr.write(`session-token-report: ${msg}\n`);
  process.exit(2);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.role) fail("--role is required (orch|shepherd|lead|reviewer) — an unattributed report cannot be folded");

  const root = projectsRoot();
  let transcript = null;
  const tried = [];
  if (opts.transcript) {
    tried.push(`--transcript ${opts.transcript}`);
    if (existsSync(opts.transcript)) transcript = opts.transcript;
  } else if (opts.sessionId) {
    tried.push(`${root}/*/${opts.sessionId}.jsonl`);
    transcript = findTranscriptBySessionId(opts.sessionId, { root });
  }
  if (!transcript && opts.match) {
    tried.push(`newest transcript under ${root} containing "${opts.match}"`);
    transcript = findTranscriptByMatch(opts.match, { root });
  }
  if (!transcript) {
    fail(
      `no transcript found — refusing to report a fabricated zero. Looked for: ${tried.length ? tried.join("; ") : "(nothing to look for: pass --transcript, --session-id or --match)"}. ` +
      `If transcript persistence is off for this session, its spend is UNKNOWN, not 0.`,
    );
  }

  let usage;
  try {
    usage = await sumTranscriptFile(transcript);
  } catch (err) {
    fail(`could not read transcript ${transcript}: ${err?.message ?? err}`);
  }
  if (!usage.entries) {
    fail(`transcript ${transcript} carries no assistant token usage (${usage.skipped_lines} unparseable line(s)) — reporting 0 would be a guess, not a measurement`);
  }

  const ev = buildTokenUsageEvent({
    role: opts.role,
    issues: opts.issues,
    sessionId: opts.sessionId,
    transcript,
    usage,
    pr: opts.pr,
    host: opts.host,
    kickback: opts.kickback,
    rotation: opts.rotation,
  });
  process.stdout.write(`${renderReport(ev, usage, { format: opts.format })}\n`);
}

// Import-safe: the body above exits the process on every early-out, so an unguarded module body would
// kill whatever imported it — the failure shape that let a test file "pass" having asserted nothing
// (DER-2747). Same guard as session-end-telemetry.mjs and work-runner.mjs.
const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] === THIS_FILE) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`session-token-report: unexpected failure: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
