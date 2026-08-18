#!/usr/bin/env node
// work-runner.mjs — deterministic plumbing for the /work local project-delivery orchestrator.
//
// The Claude `/work` session is the BRAIN; this CLI is dumb, testable plumbing it shells out to:
// run ledger, worktree ops, `cmux` workspace spawn, and the eligibility/collision rules that decide
// which issues may run in parallel. CMUX is a visible cockpit only; `gh`/Linear are the source of
// truth for merge-readiness. Node built-ins only (mirrors your repo's own workflow scripts). See
// the design notes in the repository README.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Arg parsing + ids
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { rest: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--run") o.runId = argv[++i];
    else if (a === "--project") o.project = argv[++i];
    else if (a === "--worktree") o.worktree = argv[++i];
    else if (a === "--worktree-root") o.worktreeRoot = argv[++i];
    else if (a === "--runs-root") o.runsRoot = argv[++i];
    else if (a === "--ledger-runs-root") o.ledgerRunsRoot = argv[++i];
    else if (a === "--runner-cmd") o.runnerCmd = argv[++i];
    else if (a === "--repo-root") o.repoRoot = argv[++i];
    // The sha/tree a review covered (review-usage). Defaults to the worktree HEAD when omitted.
    else if (a === "--sha") o.sha = argv[++i];
    // `review-swap --lens X --lens Y --lens Z` (1.1) — REPEATABLE, and it must accumulate rather than
    // last-wins: the whole point of the panel is that the lenses are distinct, so a parser that kept only
    // the final one would silently record a 3-lens gate as a 1-lens gate. That is the exact 1-of-3-reads-
    // as-a-full-swap failure the command refuses at every other layer.
    else if (a === "--lens") (o.lens ??= []).push(argv[++i]);
    // `review-panel --lens-file correctness=/tmp/c.json` (DER-2360) — REPEATABLE for exactly the reason
    // `--lens` is. The `lens=path` form binds each file to the lens that PRODUCED it; positional order
    // would silently mislabel a panel whose lenses finished out of order, and a mislabelled lens is a
    // gate that cannot be audited for redundancy.
    else if (a === "--lens-file") (o.lensFile ??= []).push(argv[++i]);
    else if (a === "--diff") o.diff = argv[++i];
    else if (a === "--union") o.union = argv[++i];
    else if (a === "--verify-file") o.verifyFile = argv[++i];
    else if (a === "--falsify") o.falsify = argv[++i];
    // DER-3011 — the round-1 cross-vendor codex pass, attested on the panel receipt. Explicit branches
    // because the `--xxx <value>` catch-all below would key them as `codex-log`/`codex-review`, which no
    // caller reads — a flag that silently lands nowhere is the same shape as a gate that cannot fail.
    else if (a === "--codex-review") o.codexReview = argv[++i];
    else if (a === "--codex-log") o.codexLog = argv[++i];
    else if (a === "--codex-waived") o.codexWaived = argv[++i];
    // Boolean: as a catch-all it would swallow the following token as its value.
    else if (a === "--print-bin") o.printBin = true;
    else if (a === "--base") o.base = argv[++i];
    // `staleness-check --symbol X --symbol Y` (2.7) — repeatable for the same reason --lens is.
    else if (a === "--symbol") (o.symbol ??= []).push(argv[++i]);
    else if (a === "--verdicts") o.verdicts = argv[++i];
    else if (a === "--engine") o.engine = argv[++i];
    else if (a === "--substitute-reason") o.substituteReason = argv[++i];
    // `waive-codex-gate` (1.3). `--until` is required by the command, not merely accepted here.
    else if (a === "--until") o.until = argv[++i];
    else if (a === "--reason") o.reason = argv[++i];
    // Re-score an already-scored (pr, round) in review-fidelity instead of returning the prior result.
    // On `reap` it is the DESTRUCTIVE escape hatch (a synonym of --abandon) — see reapRefusal.
    else if (a === "--force") o.force = true;
    // `reap --abandon`: deliberately destroy a unit that is still ACTIVE (kill its lead, remove its
    // worktree with any uncommitted work in it). Needs its own explicit branch — as a bare boolean the
    // `--xxx <value>` catch-all at the bottom would swallow the following DER-id as its value.
    else if (a === "--abandon") o.abandon = true;
    else if (a === "--branch") o.branch = argv[++i];
    else if (a === "--slug") o.slug = argv[++i];
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--lead-type") o.leadType = argv[++i];
    else if (a === "--file") o.file = argv[++i];
    // `--issue DER-x` is an explicit alias for the positional id — review-usage reads better with it,
    // and a lead pasting a long shell block is less likely to drop a flagged value than a bare token.
    else if (a === "--issue") o.issueIdFlag = argv[++i];
    else if (a === "--round") { o.roundRaw = argv[++i]; o.round = Number(o.roundRaw); }
    else if (a === "--host") o.host = argv[++i];
    else if (a === "--prefer") o.prefer = argv[++i];
    else if (a === "--title") o.title = argv[++i];
    else if (a === "--acceptance") o.acceptance = argv[++i];
    else if (a === "--findings") o.findings = argv[++i];
    else if (a === "--kickback") o.kickback = Number.parseInt(argv[++i], 10);
    else if (a === "--issues") o.issues = argv[++i];
    else if (a === "--bundle") o.bundle = argv[++i];
    // Run plan from /prep-for-work (2026-07-25). `--plan <path>` on init-run records it for the whole
    // run; on write-brief it stamps the issue's ASSIGNED budget into the brief. The explicit
    // --budget-files/--budget-additions pair overrides it for a one-off (e.g. a mid-run split).
    else if (a === "--plan") o.plan = argv[++i];
    else if (a === "--budget-files") o.budgetFiles = Number.parseInt(argv[++i], 10);
    else if (a === "--budget-additions") o.budgetAdditions = Number.parseInt(argv[++i], 10);
    else if (a === "--only") o.only = argv[++i];
    else if (a === "--spec") o.spec = argv[++i];
    else if (a === "--tracking") o.tracking = argv[++i];
    else if (a === "--include-backlog") o.includeBacklog = true;
    else if (a === "--wake-on") o.wakeOn = argv[++i];
    else if (a === "--pull-hosts") o.pullHosts = argv[++i];
    else if (a === "--reconcile-merged") o.reconcileMerged = true;
    else if (a === "--reconcile-pr-events") o.reconcilePrEvents = true;
    // DER-2748: proceed DELIBERATELY on a ledger whose hosts report different harness versions (a
    // mid-run upgrade of one host). Never overrides a FOREIGN schema_version — there is no degraded
    // mode for lines this build cannot parse.
    else if (a === "--allow-version-skew") o.allowVersionSkew = true;
    else if (a === "--all") o.all = true;
    // Context rotation (2026-07-25). These need explicit entries: the `--xxx <value>` catch-all below
    // would eat the NEXT argument as a boolean flag's value.
    else if (a === "--emit") o.emit = true;
    else if (a === "--json") o.json = true;
    else if (a === "--skip-probes") o.skipProbes = true;
    else if (a === "--window") o.window = Number.parseInt(argv[++i], 10);
    else if (a === "--rotation") o.rotation = Number.parseInt(argv[++i], 10);
    // Cloud dispatch (2026-08-18). `--push` is a BOOLEAN: through the `--xxx <value>` catch-all it would
    // eat the following token (a `--worktree` path, say) as its value and then never be read — the same
    // "a flag that silently lands nowhere" shape the --codex-* branches above exist to avoid.
    else if (a === "--push") o.push = true;
    else if (a === "--timeout-ms") o.timeoutMs = Number.parseInt(argv[++i], 10);
    else if (a === "--session") o.session = argv[++i];
    else if (a === "--message") o.message = argv[++i];
    // The catch-all would key this as `claude-bin`, which no caller reads — the same dead-flag shape the
    // --codex-* branches call out.
    else if (a === "--claude-bin") o.claudeBin = argv[++i];
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
    else if (!o.subcommand) o.subcommand = a;
    else o.rest.push(a);
  }
  o.issueId = o.issueIdFlag ?? o.rest.find((t) => /^[A-Za-z]+-\d+$/.test(t)) ?? o.rest[0];
  return o;
}

export function slugify(text, maxWords = 3) {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean);
  return words.slice(0, maxWords).join("-");
}

export function buildRunId(now, project) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${slugify(project, 4) || "work"}`;
}

// Parse an explicit `/work DER-1,DER-2` issue list — comma/space separated. Keeps only Linear-id-shaped
// tokens (`ABC-123`), normalizes the team prefix to upper-case, and dedups while preserving order.
// An explicit list is a deliberate operator override (see the issue-list mode in SKILL.md §2): its
// members are dispatched regardless of Todo/Backlog status, so this is the gate that rejects junk tokens.
// ---------------------------------------------------------------------------
// Wire protocol markers
// ---------------------------------------------------------------------------
// A cloud lead has no ledger access, so it reports by posting PR comments that start with a marker
// token; the orchestrator's reconcile folds them back into the run ledger. Renamed from the
// a project-branded token to the neutral `WORK-*` form (2026-07-29) as part of making this harness
// repo-agnostic.
//
// WRITE the canonical marker; READ both. The legacy token is not dead weight: a cloud lead spawned
// before the rename is still running with the old brief in its context and will keep emitting it for
// the rest of its life. A reader that only accepted the new token would silently drop that lead's
// entire hand-off — and "silently drops a hand-off" is the failure class this harness has paid for
// repeatedly. Drop the legacy entries only once no run predating the rename can still be in flight.
export const EVENT_MARKER = "WORK-EVENT";
export const HANDOFF_MARKER = "WORK-HANDOFF";

// A repo that renamed its markers can keep reading the old ones by setting `legacyEventMarker` /
// `legacyHandoffMarker` in `.claude/work.config.json`. Absent (the default, and the right setting for a
// fresh install) ⇒ only the canonical markers are accepted. Keeping the legacy token in CONFIG rather
// than in this file is what lets the harness ship without naming anyone's project.
let LEGACY_EVENT_MARKER = null;
let LEGACY_HANDOFF_MARKER = null;
export function getEventMarkers() { return LEGACY_EVENT_MARKER ? [EVENT_MARKER, LEGACY_EVENT_MARKER] : [EVENT_MARKER]; }
export function getHandoffMarkers() { return LEGACY_HANDOFF_MARKER ? [HANDOFF_MARKER, LEGACY_HANDOFF_MARKER] : [HANDOFF_MARKER]; }
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function handoffMarkerRe() {
  return new RegExp(`^\\s*(?:${getHandoffMarkers().map(escapeRe).join("|")})\\s*`);
}

// SPEC MODE (2026-07-29) — a unit id does not have to be a Linear id.
//
// In spec mode the run implements ONE spec, tracked by ONE Linear issue, and its work units are carved
// in the plan rather than filed as child issues. A unit is then `SPEC-<slug>-U<n>` and keys the ledger
// exactly as a `DER-1234` does — every event, worktree, workspace, brief and budget is unchanged. The
// point of accepting both shapes here, rather than branching downstream, is that the rest of the harness
// stays literally the same code path: spec mode is a different way of NAMING units, not of running them.
//
// Deliberately strict: `SPEC-` prefix, a slug, and a `U<n>` suffix. A loose "any token with a dash"
// rule would let junk through, and this function is the gate that rejects junk for issue-list mode.
// Case-tolerant on input and normalizing on output, exactly as the Linear-id branch already is: this
// function parses OPERATOR input, where `der-1234` has always been accepted and upper-cased. The plan
// file's own validator (prep-runner's SPEC_UNIT_RE) stays strict, because that reads the canonical
// stored form rather than something a human typed.
export const UNIT_ID_RE = /^(?:[A-Za-z]+-\d+|[Ss][Pp][Ee][Cc]-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[Uu]\d+)$/;

export function isSpecUnitId(id) {
  return /^SPEC-/i.test(String(id ?? ""));
}

export function parseIssueList(spec) {
  const ids = String(spec ?? "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => UNIT_ID_RE.test(t))
    // A spec unit id normalizes to FULL upper case — that is the single canonical form, generated by
    // `prep-runner scaffold` and required by its validator, so an operator typing `spec-demo-u1` keys
    // the same ledger unit the plan named `SPEC-DEMO-U1`. Half-normalizing (prefix only) would produce
    // `SPEC-demo-U1`, which matches no plan entry and silently starts a second unit.
    .map((t) => (isSpecUnitId(t)
      ? t.toUpperCase()
      : t.replace(/^([A-Za-z]+)-/, (_, p) => `${p.toUpperCase()}-`)));
  return [...new Set(ids)];
}

// Bundle = several issues shipped by ONE lead in ONE worktree/branch/PR (SKILL.md §2 "Bundling") to
// cut per-PR CI + shepherd overhead. The PRIMARY id keys every ledger event / worktree / workspace;
// `--bundle DER-x,DER-y` names the OTHER members. Returns the full ordered unique list, primary first
// (empty primary → just the parsed list). Pure.
export function bundleList(primaryId, bundleSpec) {
  const rest = parseIssueList(bundleSpec).filter((id) => id !== primaryId);
  return primaryId ? [primaryId, ...rest] : rest;
}

// ---------------------------------------------------------------------------
// Workspace naming, briefs, boot commands
// ---------------------------------------------------------------------------

export function workspaceName(role, { project, issueId, slug, kickback, rotation, bundleCount = 0 } = {}) {
  switch (role) {
    case "orch":
      return `🧭 orch · ${project}`;
    case "shepherd":
      return `🚦 shepherd · ${project}`;
    case "lead": {
      // A bundled lead shows `DER-1+2` = primary + 2 more issues in the same branch/PR.
      const id = bundleCount > 0 ? `${issueId}+${bundleCount}` : issueId;
      // A rotation gets its own glyph so the cockpit distinguishes "fresh context, same work" from a
      // kickback ("review found problems") at a glance — they are different failures with different fixes.
      if (rotation) return `♻️ ${id} · ${slug} · r${rotation}`;
      return kickback ? `🔧 ${id} · ${slug} · kb${kickback}` : `🔨 ${id} · ${slug}`;
    }
    default:
      throw new Error(`unknown role "${role}"`);
  }
}

// Prior-rounds dossier for kickback briefs (2026-07-16 run): every kickback re-spawn is a FRESH lead
// with no memory of earlier rounds — one 16-round PR was worked by ~17 different leads, each
// rebuilding context, which drove one-edge-per-round convergence, accidental re-breaking of earlier
// fixes, and wasted rounds re-litigating Codex's re-anchored stale reposts. Collect every kickback's
// findings for the issue (oldest first) so write-brief hands the new lead the full history. Pure.
export function kickbackDossier(events = [], issueId) {
  return events
    .filter((e) => e && e.type === "kickback" && e.issue === issueId && e.findings)
    .map((e) => ({ ts: e.ts ?? null, findings: e.findings }));
}

// DER-2102 — every UN-DELIVERED kickback's findings, not just the latest one.
//
// The orchestrator and the shepherd both review, and both append `kickback` events. When they fire for
// the same round (measured 60s apart on 2026-07-16), the brief carried only whatever text the operator
// happened to pass on `--findings` — silently dropping the other reviewer's findings, which then came
// back as the NEXT round. The fold already dedups the round COUNT for this exact double-fire; the brief
// has to do the opposite and UNION the content.
//
// "Un-delivered" = appended after the last delivery marker, using the same delivery definition the fold
// uses (a kickback re-spawn, an explicit relay, or a proven-forward hand-off — never a bare head move).
export function pendingKickbackFindings(events = [], issueId) {
  let pending = [];
  for (const e of events) {
    if (!e || e.issue !== issueId) continue;
    if (e.type === "kickback" && e.findings) {
      if (!pending.includes(e.findings)) pending.push(e.findings);
      continue;
    }
    const delivered = (e.type === "lead_spawned" && e.kickback)
      || e.type === "kickback_relayed"
      || (e.type === "handed_off" && e.sha && e.sha_descends !== false);
    if (delivered) pending = [];
  }
  return pending;
}

// Already-adjudicated carve-outs (H8, 2026-07-26). A round-4 brief demanded enforcement that the
// round-3 ruling IN THE SAME BRIEF had already split to another issue — only a lead that read both
// halves caught the contradiction; an obedient one would have folded four subsystems into a closeout
// round. Extract every issue id the findings/dossier text records as split/carved/deferred, so the
// brief can carry an explicit DO-NOT-WORK block and a contradicting AC is visible at compose time.
export function carvedOutIds(texts = []) {
  const ids = [];
  const re = /\b(?:split|carv\w*|defer\w*|follow-?up|moved)\b[^.\n]{0,100}?\b([A-Z]{2,6}-\d+)\b|\b([A-Z]{2,6}-\d+)\b\s*\((?:split|carve[d-]?out|deferred)\)/gi;
  for (const t of texts) {
    if (!t) continue;
    let m;
    while ((m = re.exec(String(t))) !== null) {
      const id = (m[1] ?? m[2] ?? "").toUpperCase();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

// Shared kickback-brief lines (local + cloud renderers): the fix-the-class rule and the dossier.
// At round ≥ 2 (DER-2219 P3) this AUTO-ESCALATES the brief to a comprehensive enumerate-the-class
// directive — the manual round-14 fix from the 2026-07-16 16-round PR, made mechanical so it lands
// at round 2 without the orchestrator remembering to compose it.
function kickbackSharedLines({ findings, priorRounds, kickback, isCloud = false, repo = null, issueId = null }) {
  // The ack instruction MUST match the channel the reader actually has. A cloud lead has no ledger access
  // at all — it reports by WORK-EVENT PR comment — so the `append` form below pointed it at a command that
  // does not exist in its brief, which made the ack unreachable for exactly the lane whose delivery is
  // hardest to prove (a steered cloud round queues behind the in-flight turn). `kickback_ack` is already
  // on the cloud-reportable allowlist, so the fix is the right comment, not a new event type.
  const ackLine = isCloud
    ? `**FIRST, acknowledge receipt** (a message can queue unseen — the ledger, not the send, is the delivery record): \`gh api repos/${repo ?? "<owner>/<repo>"}/issues/<PR>/comments -f body='WORK-EVENT {"type":"kickback_ack","issues":${JSON.stringify([issueId ?? "<id>"])},"pr":<PR>,"round":${kickback ?? 1}}'\`. The orchestrator treats a missing ack as an undelivered round and will replace this session.`
    : `**FIRST, acknowledge receipt** (messages between sessions can queue unseen — the ledger, not the message, is the delivery record): \`… append … '{"actor":"lead:<id>","type":"kickback_ack","issue":"<id>","round":${kickback ?? 1}}'\` using the exact append command from your original brief. The orchestrator respawns this round if no ack lands in ~10 min.`;
  const lines = [
    ``,
    `### Findings`,
    ``,
    findings || "(see the PR review threads)",
    ``,
    ackLine,
    ``,
    `**Fix the CLASS, not the instance:** when a finding is one instance of a pattern — one of N data sources missing a filter, one of N entry points missing a guard, one of N completion/release paths missing a hook — enumerate and fix EVERY sibling in this same round (grep for the pattern) and say so in the PR. One-instance fixes cost 8+ extra review rounds on 2026-07-16 (the reviewer finds the siblings one round at a time).`,
  ];
  // H8: surface every id the findings/dossier already adjudicated AWAY from this PR. An AC that
  // contradicts one of these is a brief-composition bug — say so and do NOT work the carved class.
  const carved = carvedOutIds([findings, ...(priorRounds ?? []).map((r) => r?.findings)]);
  if (carved.length) {
    lines.push(
      ``,
      `### ⛔ Already carved out — DO NOT WORK THESE`,
      ``,
      `Prior rounds split these classes into their own issues: **${carved.join(", ")}**. They are OTHER issues' scope now. If an acceptance criterion in this brief demands work that belongs to one of them, the brief contradicts its own rulings — state the contradiction in the PR body, honor the CARVE-OUT (not the criterion), and append a ledger note.`,
    );
  }
  if ((kickback ?? 0) >= 2) {
    lines.push(
      ``,
      `### ⚠ Round ${kickback} — COMPREHENSIVE-PASS DIRECTIVE (stop drip-feeding)`,
      ``,
      `This PR has now been kicked back ${kickback} times — the one-edge-per-round pattern is how a PR eats 16 rounds. Do NOT fix only the latest finding. Instead:`,
      `1. **Name the class.** State the invariant/contract these findings share (e.g. "every release path must write a decision", "every data source must apply the tenant filter").`,
      `2. **Enumerate every member** by grep — every release path / entry point / data source / waive-decline / crash-replay / re-seat / occupancy-change / sibling call site the feature touches — and CONSOLIDATE all open + predicted-sibling findings into ONE list.`,
      `3. **Fix them together this round**, and prove it with a **completeness table in the PR body**: one row per path/source/entry-point → \`covered?\` (yes + how). The 2026-07-16 16-round PR converged in 2 rounds the moment this directive arrived at round 14 — it belongs here, at round 2.`,
    );
  }
  const prior = (priorRounds ?? []).filter((r) => r && r.findings && r.findings !== findings);
  if (prior.length) {
    lines.push(
      ``,
      `### Prior rounds — dossier (oldest first; do NOT re-litigate, build on top)`,
      ``,
      `You are a FRESH session with no memory of this PR's history. Earlier rounds already addressed the items below — verify they are STILL fixed on HEAD (the Codex bot re-posts already-fixed findings re-anchored to new lines; check against HEAD before "re-fixing" anything) and make sure your changes do not undo them.`,
      ``,
      ...prior.map((r, i) => `${i + 1}. _(${r.ts ?? "?"})_ ${r.findings}`),
    );
  }
  return lines;
}

// Resumption brief for a ROTATED lead (2026-07-25). Purpose-built, and the discipline it encodes is
// the load-bearing lesson from the first hand-rolled rotation: `write-brief --kickback n` re-injects
// the FULL prior-rounds dossier — 44KB in the observed case — which spends the successor's context on
// precisely the axis that killed its predecessor. This renders a tight header + the predecessor's own
// note + the LATEST round's findings only. It must never call kickbackDossier(); the unit test asserts
// the dossier heading is absent. Target ~6–8KB.
export function renderRotationBrief({
  issueId, title, worktree, branch, runId, runDir, runsRoot, ledgerRunsRoot, runnerCmd,
  rotation = 1, pr = null, note = null, noteSynthesized = false, disposition = "CLOSEOUT",
  latestFindings = null, bundle, leadType, leadTypeCfg, acceptance, nonIssues = null,
} = {}) {
  const runner = runnerCmd ?? "node scripts/work-runner.mjs";
  const appendRunsRoot = ledgerRunsRoot ?? runsRoot ?? "<runs-root>";
  const ledger = (json) => `${runner} append --run ${runId ?? "<run>"} --runs-root ${appendRunsRoot} '${json}'`;
  const bundleRest = (bundle ?? []).filter((id) => id !== issueId);
  const allIds = [issueId, ...bundleRest];
  const ltCfg = leadTypeCfg ?? {};
  const disp = String(disposition || "CLOSEOUT").toUpperCase() === "CONTINUE" ? "CONTINUE" : "CLOSEOUT";
  const remaining = ROTATION_CAP - rotation;
  const lines = [
    `# Rotation brief — ${issueId}${bundleRest.length ? ` (+${bundleRest.join(", ")})` : ""}${title ? `: ${title}` : ""}`,
    ``,
    `- **Issue${bundleRest.length ? "s" : ""}:** ${allIds.join(", ")}${bundleRest.length ? `  (primary: ${issueId})` : ""}`,
    `- **Worktree:** ${worktree ?? "?"}  ·  **Branch:** ${branch ?? "?"}${pr ? `  ·  **PR:** #${pr}` : ""}`,
    `- **Run:** ${runId ?? "?"}  ·  **Run dir:** ${runDir ?? "?"}`,
    `- **Rotation ${rotation} of ${ROTATION_CAP}**${remaining > 0 ? ` — ${remaining} left before this unit becomes a split decision.` : ` — this is the LAST one; there is no rotation ${rotation + 1}.`}`,
    ...(leadType && leadType !== "claude"
      ? [`- **Lead type:** \`${leadType}\` — you are **${ltCfg.leadModel ?? "?"}**; \`sonnet\` subagents are **${ltCfg.subagentModel ?? "?"}**, \`haiku\` are **${ltCfg.researchModel ?? ltCfg.subagentModel ?? "?"}**, the single \`opus\` slot is **${ltCfg.reviewerModel ?? "?"}**.`]
      : []),
    ``,
    `## Why you are here`,
    ``,
    `Your predecessor ran out of **context**, not out of correctness. The work in this worktree is sound`,
    `unless the note below says otherwise — this is a routine rotation (the orchestrator and the shepherd`,
    `do the same thing), not a kickback and not a rescue.`,
    ``,
    `**The worktree is intact and its WIP is committed.** Start from \`git log origin/main..HEAD\` and`,
    `\`git diff origin/main...HEAD\` — that is the real state of the work, and it is cheaper to read than`,
    `to re-derive. You are deliberately NOT given the prior-rounds dossier: re-reading the full history is`,
    `what exhausted your predecessor's context, and re-spending it on the same axis would end the same way.`,
    ``,
  ];

  lines.push(
    noteSynthesized
      ? `## ⚠ Handoff note — SYNTHESIZED (no lead-authored note)`
      : `## Handoff note — written by your predecessor`,
    ``,
  );
  if (noteSynthesized) {
    lines.push(
      `Your predecessor did not leave a note (it was closed before it could write one). The summary below`,
      `was reconstructed from the ledger and git — treat it as evidence, not testimony, and verify before`,
      `relying on any of it.`,
      ``,
    );
  }
  lines.push(note || "_(no note and no reconstruction available — derive state from git + the PR)_", ``);

  lines.push(
    `## Your disposition: **${disp}**`,
    ``,
    ...(disp === "CLOSEOUT"
      ? [
          `**Land what exists. Do not start new implementation.**`,
          ``,
          `1. Verify the current state against the acceptance criteria below — run the targeted checks, not full CI.`,
          `2. Run the final adversarial review gate exactly once, and fix what it finds.`,
          `3. Hand off the PR.`,
          `4. Anything genuinely unfinished: state it **precisely** in the PR body under "Not included", and`,
          `   append a ledger note. The orchestrator carves the remainder into a new Linear issue — that is`,
          `   the normal, expected outcome of a CLOSEOUT rotation, not a failure.`,
          ``,
          `Do NOT expand scope to "finish it properly". A bounded PR that merges beats a complete one that doesn't.`,
        ]
      : [
          `**Execute the remaining steps in the note above — exactly those.**`,
          ``,
          `1. Do not re-plan, do not re-explore the codebase, and do not re-litigate your predecessor's decisions.`,
          `2. If the remaining work turns out to be materially larger than the note claims, **STOP and say so**`,
          `   in a ledger note — that is a split signal, not a reason to push on.`,
          `3. Then verify, run the review gate, and hand off as normal.`,
        ]),
    ``,
    // H7: this pointer only renders over a REAL predecessor note. Pointing "read the traps FIRST"
    // at a synthesized reconstruction (which by definition has none) destroyed two handoffs.
    ...(noteSynthesized || !note
      ? []
      : [
          `**Read the traps / dead-ends in the note FIRST.** Re-walking a path your predecessor already ruled`,
          `out is the specific way a rotation burns more context than it saves.`,
          ``,
        ]),
  );

  if (acceptance) lines.push(`## Acceptance criteria${bundleRest.length ? " (all bundled issues)" : ""}`, ``, acceptance, ``);
  if (latestFindings) {
    lines.push(
      `## Open review findings — LATEST ROUND ONLY`,
      ``,
      latestFindings,
      ``,
      `Earlier rounds are deliberately omitted. Verify these against **HEAD** before fixing anything — the`,
      `Codex bot re-posts already-fixed findings re-anchored to new lines.`,
      ``,
    );
  }

  lines.push(
    `## Hand-off mechanics (unchanged)`,
    ``,
    pr
      ? `- The PR already exists (#${pr}). When ready, mark it ready / push, then record the hand-off:\n  \`${ledger(`{"actor":"lead:${issueId}","type":"handed_off","issue":"${issueId}","pr":${pr}}`)}\``
      : `- Open the PR (Linear \`gitBranchName\`, mention ${allIds.join(" + ")}), then record it:\n  \`${ledger(`{"actor":"lead:${issueId}","type":"pr_opened","issue":"${issueId}","pr":123}`)}\``,
    `- Move Linear → In Review${bundleRest.length ? " (ALL bundled issues)" : ""}.`,
    `- **Token telemetry at hand-off:** \`${runner} append --run ${runId ?? "<run>"} --runs-root ${appendRunsRoot} "$(node scripts/session-token-report.mjs --role lead --issues ${allIds.join(",")} --rotation ${rotation} --format event)"\``,
    `- Done = clean PR handed off (NOT merged). \`/goal complete\`. Do not wait on CI or the Codex bot.`,
    ``,
    `## You rotate the same way`,
    ``,
    remaining > 0
      ? `If YOU reach your own arm band, do exactly what your predecessor did — commit WIP, write \`${runDir ?? "<run-dir>"}/handoffs/${issueId}.rot${rotation + 1}.md\` (disposition, state of work, verification already run, traps/dead-ends, open threads; **under ~2KB**), append the request below, \`nudge\`, then KEEP WORKING until the orchestrator closes you.`
      : `You are the last rotation — there is no successor. If you reach your arm band, do NOT expect another respawn: finalize a note anyway (so the split inherits it), append the request below, and drive to a hand-off of whatever is green.`,
    `  \`${ledger(`{"actor":"lead:${issueId}","type":"rotate_requested","issue":"${issueId}","pct":72,"disposition":"CLOSEOUT"}`)}\``,
    ``,
    `## Subagent contract (MANDATORY)`,
    ``,
    `Every subagent you dispatch writes findings to \`${runDir ?? "<run-dir>"}/subagent-notes/${issueId}/<label>.md\` **as it goes**,`,
    `and returns **≤500 words + that path** — never a dump. A subagent that dies mid-flight then costs you`,
    `nothing, and your own context stops absorbing 10–20K-token reports. Measured on the run that produced`,
    `this mechanism: one subagent reached 134% of its window and another died with its findings unrecoverable.`,
    ``,
    `## Guardrails`,
    ``,
    `- Never touch \`docs/STATE.md\`; never run \`git worktree\` (the orchestrator owns it).`,
    `- No secrets in code, logs, or ledger. Never \`git add -A\` — stage explicit paths.`,
    `- Record every deviation from this brief in a deviation log in the PR body.`,
  );
  if (nonIssues) lines.push(``, `## Known non-issues (do not re-report)`, ``, nonIssues.trim());
  return `${lines.join("\n")}\n`;
}

export function renderBrief({ issueId, title, worktree, branch, runId, runDir, runsRoot, ledgerRunsRoot, runnerCmd, acceptance, kickback, findings, bundle, priorRounds, leadType, leadTypeCfg, assignedBudget } = {}) {
  // A lead's cwd is its own worktree, off origin/main, which may not contain this runner yet — so
  // ledger commands use the ABSOLUTE runner path + the absolute --runs-root (orchestrator's run dir).
  // For a REMOTE (mini) lead the orchestrator overrides both: runnerCmd → the mini's runner path,
  // ledgerRunsRoot → the mini-LOCAL ledger the orchestrator later pulls (§3.4).
  const runner = runnerCmd ?? "node scripts/work-runner.mjs";
  const appendRunsRoot = ledgerRunsRoot ?? runsRoot ?? "<runs-root>";
  const ledger = (json) => `${runner} append --run ${runId ?? "<run>"} --runs-root ${appendRunsRoot} '${json}'`;
  const bundleRest = (bundle ?? []).filter((id) => id !== issueId);
  const allIds = [issueId, ...bundleRest];
  // Lead-type awareness (2026-07-24): when the reviewer slot is a DIFFERENT vendor than the lead model
  // (dsv4: deepseek implements, anthropic/claude-opus-5 reviews), the single final review stops being a
  // self-review and becomes the PR's external quality floor — so the brief spells the gate out and the
  // shepherd can audit it. Same-vendor types render exactly as before.
  const ltCfg = leadTypeCfg ?? {};
  const externalReviewer = hasExternalReviewer(ltCfg);
  const subscriptionReview = ltCfg.reviewerBilling === "subscription";
  // The adversarial panel (DER-2360) is a shell-out on the Claude subscription for EVERY lead type, so
  // the model here is always a CLI alias (`opus` auto-resolves to the latest Opus the installed CLI
  // knows — harness-wide policy, spec §3.7), never a provider-qualified id. Read from config rather
  // than hardcoded; see `panelReviewerModel` for why a proxy `reviewerModel` must not leak into it.
  const panelModel = panelReviewerModel(ltCfg);
  const reviewerModel = ltCfg.reviewerModel;
  // DER-3011 — which REVIEW round this brief is for. A kickback is by definition not the first review of
  // the change, so kickback N is review round N+1. It matters because the cross-vendor codex pass is
  // mandatory on round 1 and forbidden after it; before this the block hardcoded `--round 1` on every
  // brief, which would have made "round 1 only" mean "every round".
  const panelRound = Number.isFinite(Number(kickback)) && Number(kickback) > 0 ? Number(kickback) + 1 : 1;
  const firstReviewRound = panelRound <= CROSS_VENDOR_ROUND;
  const lines = [
    `# Lead brief — ${issueId}${bundleRest.length ? ` (+${bundleRest.join(", ")})` : ""}${title ? `: ${title}` : ""}`,
    ``,
    `- **Issue${bundleRest.length ? "s" : ""}:** ${allIds.join(", ")}${bundleRest.length ? `  (primary: ${issueId})` : ""}`,
    `- **Worktree:** ${worktree ?? "(orchestrator-created)"}`,
    `- **Branch:** ${branch ?? "(from Linear gitBranchName)"}`,
    `- **Run:** ${runId ?? "?"}  ·  **Run dir:** ${runDir ?? "?"}`,
    ...(leadType && leadType !== "claude"
      ? [`- **Lead type:** \`${leadType}\` — you are **${ltCfg.leadModel ?? "?"}**; your \`sonnet\` subagents are **${ltCfg.subagentModel ?? ltCfg.leadModel ?? "?"}**, \`haiku\` are **${ltCfg.researchModel ?? ltCfg.subagentModel ?? "?"}**, and the single \`opus\` slot is **${reviewerModel ?? ltCfg.leadModel ?? "?"}**. The aliases in this brief are LITERAL — dispatch with \`sonnet\`/\`haiku\`/\`opus\` and the harness routes them.`]
      : []),
    ``,
    ...renderAssignedBudget(assignedBudget, { ledgerLine: true }),
  ];
  if (bundleRest.length) {
    lines.push(
      `## Bundle — ${allIds.length} issues, ONE branch, ONE PR`,
      ``,
      `This brief covers ${allIds.length} bundled issues: ${allIds.join(", ")}. You own ALL of them in this one worktree:`,
      ``,
      `- Implement every issue; sequence commits per-issue (conventional messages, each mentioning its DER-id).`,
      `- Verify the UNION of all acceptance criteria before handing off.`,
      `- Open exactly ONE PR: title mentions ${issueId}; the body lists every id (${allIds.join(", ")}) so Linear attaches to all.`,
      `- Ledger events use the PRIMARY id (${issueId}) only — exactly as printed in the playbook below.`,
      `- Move EVERY bundled issue → In Review at hand-off (not just the primary).`,
      `- If one bundled issue turns out unexpectedly large or contentious: finish the others, hand off the PR without it, and say so in your handoff + a ledger note — the orchestrator re-queues it solo. Never hold the bundle hostage.`,
      ``,
    );
  }
  lines.push(
    `## Acceptance criteria${bundleRest.length ? " (all bundled issues)" : ""}`,
    ``,
    acceptance || `(see the Linear issue${bundleRest.length ? "s" : ""})`,
    ``,
  );
  lines.push(
    `## Playbook (you are a /work-lead — Opus, in your own CMUX workspace)`,
    ``,
    `1. Read AGENTS.md + relevant specs + invariants for the area you touch — **including the \`## Code Review Rules\` section of the root AGENTS.md and of every package you touch.** Those are not just review criteria; they are the defect classes this repo actually ships, so write TO them from the first line. The five that cost the most rounds: (a) **fix the class, not the call site** — when you change one member of a family (a table/registry/enum/switch entry, one branch of a guard, one of several parallel implementations), change every sibling or say in the PR body why not; (b) never **silently drop explicit input** — an early return or merge helper that discards a caller's value, where the default that replaces it is more permissive; (c) put the **authority check before** any error whose message reveals data the caller isn't entitled to; (d) make sure time/threshold **predicates compare the operands their names claim**; (e) if you add a doc, spec, comment, or config, make the code in the SAME diff match it, including anything the text says not to do yet. Each of those is a real kickback from this repo's ledger. If the brief doesn't name a **reference-as-map** (analogous existing implementation — file/PR/package), find one before coding, or note "no analog exists" in the PR body.`,
    `2. **Plan if not trivially clear:** run \`/superpowers:writing-plans\` for THIS issue → save under \`docs/superpowers/plans/\`; then declare the plan's file-scope. **This is MANDATORY and it is a BUDGET, not a note — emit it BEFORE your first commit:**`,
    `   \`${ledger(`{"actor":"lead:${issueId}","type":"plan_scope","issue":"${issueId}","fileScope":["path/a.ts","path/b.ts"],"expectedAdditions":600}`)}\``,
    `   **PR size target — under ${PR_ADDITIONS_TARGET.toLocaleString()} additions (advisory, DER-2360).** Round count tracks ADDITIONS, not risk: a small change to frightening code reviews in one round; a large change to boring code does not. ${assignedBudget ? `Your assigned budget above (~${assignedBudget.additions} additions) is the BINDING number; this is the ceiling it sits under.` : `Nothing enforces this — but a unit that will obviously cross it should be SPLIT before it is written, not after it is reviewed.`}`,
    `   **Scope contract (2026-07-25):** the declared \`fileScope\` bounds this PR. If the real change needs **more than 1.5× the declared file count**, STOP and say so in a \`plan_scope\` re-emission plus a note to the orchestrator — do not silently grow. ${assignedBudget ? `Your **assigned budget is ${assignedBudget.files} files / ~${assignedBudget.additions} additions** (see above) — declare against it, do not raise it.` : `Aim for **≤ ~${PR_ADDITIONS_TARGET.toLocaleString()} additions / ≤ ~12 files**`}; a PR that outgrows that should be split. Measured 2026-07-25: review rounds scale directly with diff size (<1k additions → 1.25 rounds; >7k → 5.67), and the run whose PRs averaged 3,754 additions took 8 kickbacks per merged PR versus 0.18 when they averaged 541. A PR with NO declared scope is the worst case of all — the one that shipped 98 files and +11,537 lines took 5 rounds and never merged.`,
    externalReviewer
      ? `3. **Build by DELEGATING — on this lead type that is an instruction, not a style preference.** (Measured 2026-07-24: a lead on this tier made 220 model calls and ZERO Agent calls, implementing every line itself — and a lead that never dispatches a subagent also never runs step 5's review gate.) Decompose into 2–4 chunks and dispatch each with the **Agent tool**, \`model: "sonnet"\` (routes to ${ltCfg.subagentModel ?? "your subagent tier"}); research/codebase-mapping goes to \`"haiku"\` (${ltCfg.researchModel ?? ltCfg.subagentModel ?? "same"}). You plan, adversarially review each returned diff, and integrate — you do not write the bulk of the implementation yourself. Run subagents in the FOREGROUND. Read-only work fans out freely; parallel EDITS only on disjoint files via Agent \`isolation:"worktree"\`, then integrate onto the issue branch. NEVER dispatch model-less (it inherits YOUR tier); reserve \`opus\` for step 5's single final reviewer.`
      : `3. Build in bite-size chunks with in-process subagents (Sonnet 5 / Haiku). **Model discipline:** dispatch EVERY subagent with an explicit model alias — \`sonnet\` for implementation, \`haiku\` for research; NEVER model-less (a model-less subagent inherits your lead-tier model) and reserve \`opus\` for step 5's single final reviewer. Run subagents in the FOREGROUND (background task handles are unreliable on proxy-backed leads). Read-only work fans out freely; parallel EDITS only on disjoint files via Agent \`isolation:"worktree"\`, then integrate diffs onto the issue branch.`,
    `4. Targeted local verify: typecheck + lint the changed package + touched test files (+ one \`*.db.test.ts\` if you touched DB/RLS). NOT full remote CI. **EXCEPTION — deterministic guards are YOUR gate:** if the diff adds/changes a command, MCP tool, or reference guide, or touches \`packages/commands\`/\`packages/reference\`/\`apps/cli\`, also run \`pnpm check:manifest && pnpm check:cli-version && pnpm check:docs-version && pnpm docs:check\` + the registry tests (ui-surface-parity, command-tools, inventory, agent-how-tos) before handing off — seconds each; every skipped one is a guaranteed kickback round.`,
    // ONE branch on purpose. Before 2026-08-12 this was a ternary on `firstReviewRound` because the
    // reviewer genuinely differed by round (codex on 1, panel afterwards). Now codex runs on every
    // round, so `firstReviewRound` is true for every reachable round and a second branch would be
    // unreachable text asserting a policy that no longer exists.
    `5. **Review gate — ONE reviewer: \`codex exec\` on ${CROSS_VENDOR_MODEL} at ${CROSS_VENDOR_EFFORT} effort (see "${CROSS_VENDOR_HEADING}").** This is round ${panelRound}, and **codex runs on every round** — it rides a separate subscription, so a re-run costs no Claude budget and a verdict on a tree you have since changed is not a gate. **Do NOT also run the 3-lens Claude panel** — that is the FALLBACK, and it runs only when \`codex-probe\` says codex is unavailable. The cloud bot's auto-review is OFF, so NOTHING reviews this PR after you hand it off: run the block VERBATIM, address every finding, and re-run it on the new head BEFORE hand-off.`,
    `6. Open the PR (Linear \`gitBranchName\`, mention ${allIds.join(" + ")}); record it, then move Linear → In Review${bundleRest.length ? " (ALL bundled issues)" : ""} and hand off:`,
    `   \`${ledger(`{"actor":"lead:${issueId}","type":"pr_opened","issue":"${issueId}","pr":123${bundleRest.length ? `,"bundle":${JSON.stringify(allIds)}` : ""}}`)}\``,
    `   **Token telemetry (at hand-off, from the worktree):** \`${runner} append --run ${runId ?? "<run>"} --runs-root ${appendRunsRoot} "$(node scripts/session-token-report.mjs --role lead --issues ${allIds.join(",")}${kickback ? ` --kickback ${kickback}` : ""} --format event)"\` — reads your own session transcripts, reports tokens by model for fleet analysis.`,
    `7. Done = clean PR handed off (NOT merged). Run the \`/goal\` completion audit → \`/goal complete\`. Do NOT wait on remote CI or the Codex bot.`,
    ``,
    `## Context rotation (2026-07-25) — hand yourself off before you degrade`,
    ``,
    `Rotating out is the NORMAL path, not an emergency — the orchestrator and shepherd already do it. A \`[context-wrap-nudge]\` will fire at your **arm band**. At the next natural boundary (never mid-edit):`,
    `1. **Commit your WIP** — rotation preserves only what is COMMITTED.`,
    `2. Write \`${runDir ?? "<run-dir>"}/handoffs/${issueId}.rot1.md\`, **under ~2KB**: \`disposition:\` CLOSEOUT|CONTINUE · state of work · committed vs not · verification already run · **traps / dead ends you already ruled out** · open review threads · subagent-note paths. Default CLOSEOUT.`,
    `3. \`${ledger(`{"actor":"lead:${issueId}","type":"rotate_requested","issue":"${issueId}","pct":72,"disposition":"CLOSEOUT"}`)}\``,
    `4. \`${runner} nudge --run ${runId ?? "<run>"} --runs-root ${appendRunsRoot}\``,
    `5. **KEEP WORKING until the orchestrator closes you** — never idle-wait to be rotated.`,
    ``,
    `At most **${ROTATION_CAP} rotations**; a third request is a budget trip (split / re-scope / park). A well-scoped round should never reach the arm band — if you arm early, your unit is too big, and the note is where you say so.`,
    ``,
    `## Subagent contract — MANDATORY on every Agent dispatch`,
    ``,
    `Append this to every subagent prompt, verbatim:`,
    ``,
    `> **VERDICT FIRST.** Open your reply with your conclusion in one line — for a reviewer, \`refuted: true|false\` plus a one-line reason; for anything else, the answer itself. Detail comes AFTER, so a truncated return still carries a usable answer.`,
    `>`,
    `> **End with exactly one of \`COMPLETE\` / \`INCOMPLETE\` / \`REFUSED\` — never silence.** If you cannot finish, return \`INCOMPLETE\` naming what is missing. A subagent that returns nothing is indistinguishable from one still working.`,
    `>`,
    `> Write your findings to \`${runDir ?? "<run-dir>"}/subagent-notes/${issueId}/<label>.md\` **as you go**, not at the end. Return **≤500 words + that path** — never a dump; cite \`file:line\` instead of pasting code. If you approach your context limit: finalize the file, then return \`done\` or \`partial\` plus exactly what remains.`,
    ``,
    `**SILENT is not WEDGED, and they need OPPOSITE responses (2026-07-31).** Two of three reviewer subagents went silent TWICE, then delivered in full on an explicit ultimatum: *"send your findings now, or send INCOMPLETE."* They were not dead — 136k and 158k tokens each. Re-pinging did nothing; the ultimatum worked immediately. For a subagent that returned NOTHING, send the ultimatum FIRST; reserve close-and-respawn for one that is provably WEDGED (0% CPU, ignoring a delivered specific poke for ~8 min). Respawning a silent-but-working agent throws away everything it has done.`, ``,
    `**A subagent cannot rotate** — it never receives a user prompt, so no nudge can reach it, and when it dies it leaves NOTHING. The file is the handoff. Measured 2026-07-25: one \`implementer\` subagent hit 134% of the window and an \`Explore\` subagent DIED at 101% with its findings unrecoverable. The bigger win is your own context: a subagent's return value is injected verbatim into you, so a 20K-token report costs YOU 20K. When one returns \`partial\` or dies, read its notes file and **re-dispatch narrowed** — never re-run the same unbounded prompt.`,
    ``,
    `## Guardrails`,
    ``,
    `- Never touch \`docs/STATE.md\`; observe version-bump discipline; never run \`git worktree\` (the orchestrator owns it).`,
    `- No secrets in code, logs, or ledger. Never \`git add -A\` — stage explicit paths.`,
    `- Record EVERY deviation from this brief in a **deviation log** in the PR body ("none" if none) — the shepherd checks it before enqueue.`,
    `- **The ONLY runner is the one this brief's commands name.** If an append is rejected with a schema error, YOUR COPY of the runner is stale (side-copies exist in \`scripts/codex-work/\` and \`~/.codex/work/bin/\` — never use them, and never conclude "the harness is broken" from one). NEVER write to \`events.jsonl\` directly — with concurrent leads a torn line corrupts state for everyone.`,
    `- **CI failure you cannot reproduce locally? Check how far behind main you are FIRST:** \`git fetch origin main && git rev-list --count HEAD..origin/main\`. **CI tests the MERGE tree** (\`refs/pull/<n>/merge\`), so a branch behind main can fail on a file your branch has never contained — local greens are then meaningless. Merge \`origin/main\` into the branch before debugging any CI-only failure, and name the ref you probed in any evidence you cite (branch-only probes are blind instruments — H11).`,
  );
  // The panel is rendered into its own array and appended AFTER the codex block, so the brief reads in
  // policy order: the gate you run, then the fallback you run only if the gate is unavailable. A lead
  // reading top-to-bottom must hit the mandatory reviewer first.
  const panelLines = [];
  panelLines.push(
    ``,
    `## ${PANEL_GATE_HEADING}`,
    ``,
    `🔴 **DO NOT RUN THIS unless \`codex-probe\` came back UNAVAILABLE.** The pre-PR gate is the \`codex exec\` block above, alone. This panel is the fallback for exactly one situation: codex is walled, 401'd, or unresolvable, and the change still needs a reviewer.`,
    ``,
    `**Why it is no longer the default (measured 2026-08-10, PR #1293):** codex found the panel's ONLY P1 — a filter that excludes \`actionable === false\` while its sole production caller passes items carrying liveness in a different field, so an expired row was counted as live. All three Claude lenses examined that exact function, all three reported the same line number, and none reached the production shape. The three lenses cost **$17.25 and 36.5 minutes**; the leg that found the defect cost 5.4 minutes on a separate subscription. In the same round, 22 findings from 4 reviewers collapsed to ~10 distinct defects — the panel's marginal yield was breadth, not depth.`,
    ``,
    `The GitHub Codex bot's per-PR AUTO-review is OFF (operator decision, 2026-08-01), so nothing downstream catches what the gate misses — a PR with zero bot reviews is normal now.`,
    ``,
    `Its history is still good — across PRs #1074–#1197 it found 12 of 15 findings head-to-head with the GitHub bot on #1185 — which is why it remains the fallback rather than being deleted.`,
    ``,
    `**Three lenses, three SEPARATE processes, each prompted to REFUTE your change** — \`${PANEL_LENS_IDS.join("\` / \`")}\`. They are distinct on purpose: redundant reviewers CONCUR, and concurrence is not corroboration. On #1183 the repro lens refuted the security lens and was RIGHT; three copies of one lens would have agreed and deleted live code.`,
    ``,
    `> **⚠ Every lens is a SHELL-OUT, never an Agent/Task subagent.** A subagent inherits THIS process's endpoint and model aliases, so an in-process "opus" reviewer silently runs on your own tier — measured 2026-07-24: a lead dispatched \`model: "opus"\` with a perfect review prompt and got 19/19 calls on the flash tier while its PR was about to claim an Opus review. The block below unsets the provider env so each lens is its own process on the **Claude subscription**${subscriptionReview ? `, which does **not** spend your lead budget (your implementation tier is cheap; your reviewer is not — the deal is: you write, it attacks, you fix)` : ""}. This panel runs on **${panelModel}**.`,
    ``,
    `**Run it from your worktree** — the lenses need \`node_modules\` present, and on a bare checkout the repro lens cannot execute anything and goes blind (measured: 0 findings against 2 real ones). Run it after targeted verify is green and BEFORE \`gh pr create\`:`,
    ``,
    "```bash",
    panelReviewCommands({ issueId, model: panelModel, runner, runId: runId ?? "<run>", runsRoot: appendRunsRoot, round: panelRound }),
    "```",
    ``,
    `1. **The diff SEEDS the search; it does not BOUND it.** The prompts are rendered by \`panel-prompt\`, which path-routes this repo's own checklists (tenant isolation, authorization precedence, command-surface parity, prompt/schema drift, SQL-vs-Zod divergence) onto the lenses by what your diff actually touches — and every lens is told to grep call sites, siblings, specs and dependent prose the diff does NOT touch. That instruction is the whole gate: measured 2026-07-25, a diff-local reviewer ran 2 commands and found 0 issues on a PR where a searching reviewer ran 21 and found 6, including two P1s the bot never posted.`,
    `2. **Union, then verify — and the verification pass cannot erase.** Step 2 unions every unique finding across the lenses (a 1-of-3 finding is the NORMAL shape of what makes a panel worth running, never a weak signal to be voted down) and then attacks each one by EXECUTION on a fresh context. Majority prioritizes; it never erases. A blocker-class finding (P0/P1, auth, tenant isolation, secrets, money) dies only by **positive falsification** — a command that was run and what it returned, which \`review-panel\` checks rather than trusts — or by an explicit \`gate_adjudication\`. Dissent between lenses is recorded in the receipt, not resolved by vote.`,
    `2a. **Dedupe before you verify.** Fold every reviewer's findings on \`file:line_start\` first. Measured on #1293: 22 findings from 4 reviewers were ~10 distinct defects, and the top two were reported by 3–4 of 4. **Convergence of ≥3 reviewers on one \`file:line_start\` is CONFIRMED — skip the adversarial verify round for it entirely** and spend the whole verify budget on the findings only ONE reviewer raised. Those uniques are where a panel earns its cost.`,
    `3. **Address, don't relay.** Fix every blocker and major, then **RE-RUN the panel on the new head**. \`ready\` blocks a PR whose latest gate covers its head and still records \`blockers > 0\`, and the recorded count must EXACTLY equal the number of priority-≤1 entries in that same event's findings list (DER-2837) — so hand-writing the event buys nothing; \`review-panel\` derives the count from the findings. If you believe a blocker is WRONG, either falsify it with an executed counterexample (step 2) or say so in the PR body and ask the orchestrator to record a \`gate_adjudication\`: ${GATE_ADJUDICATION_AUTHORITY} Appending one yourself is the offense, not a shortcut.`,
    `4. **Round cap — 3, then stop.** Re-run the panel after substantial fixes. If **blocker-class findings are still unresolved after round 3**, the PR is not converging: STOP, say so in a note to the orchestrator, and re-scope or split it rather than grinding a fourth round. Only NON-blocking residue may be deferred — list it in the PR body under "Deferred minors" (finding + file:line) for the shepherd's review-debt pass; do NOT file your own Linear issue.`,
    `5. **Evidence in the PR body (the shepherd checks this):** a line reading \`Adversarial panel: ${PANEL_LENS_IDS.join("/")}, <model>, round N, 0 open blockers\`. The prose line alone is not evidence — the \`review_findings\` event \`review-panel\` appends is, and a missing event or an unresolved blocker list is an automatic kickback.`,
    ``,
    `⚠ It takes ~30–40 minutes wall-clock on a 16 GB box — the lenses run SEQUENTIALLY behind a memory gate, not in parallel (measured 2026-08-10: 36.5 min, three lenses, 57 MB free RAM at the worst moment). Budget for that before choosing this path. **Do not ask for \`@codex review\`** — the shepherd decides whether this PR's lane warrants that backstop.`,
  );
  // The cross-vendor pass. Since 2026-08-12 this is THE gate, on every round, and it is rendered
  // unconditionally — the old `firstReviewRound` guard existed when codex was a round-1-only companion
  // to the panel. Ordering matters: this block is pushed BEFORE `panelLines`, so a lead reading the
  // brief top-to-bottom meets the reviewer it must run before the one it must not.
  {
    lines.push(
      ``,
      `## ${CROSS_VENDOR_HEADING}`,
      ``,
      `**This is the review gate. It is the ONLY reviewer you run, and you run it on EVERY round.** Do not also run the 3-lens Claude panel — see the fallback section below for the one case that calls for it.`,
      ``,
      `It is pinned to **${CROSS_VENDOR_MODEL}** at **${CROSS_VENDOR_EFFORT}** reasoning effort on the command itself, never inherited from \`~/.codex/config.toml\` (whose default is \`medium\`). A gate that silently reviewed at a lower effort because someone edited a personal config would still produce a receipt saying the gate ran.`,
      ``,
      `**Why it is the gate, measured on PR #1293:** it found the round's ONLY P1 in 5.4 minutes while three Opus lenses spent $17.25 and 36.5 minutes and read past it — all three examined the same function and reported the same line without reaching the production item shape. It overlaps the Claude lenses by only ~33%, and it rides a SEPARATE subscription pool: no Claude budget, no Claude weekly quota, zero CI rounds.`,
      ``,
      "```bash",
      crossVendorPassCommands({ issueId, runner }),
      "```",
      ``,
      `1. **Record it with \`review-usage --reviewer codex --file <review.json> --log <review.jsonl>\`.** One gate, one sha, one blocker count. A codex P0/P1 is a blocker: \`ready\` holds the PR until you fix it or falsify it with an executed counterexample. Never hand-write the event — the recorder derives the blocker count from the findings.`,
      `2. **Four measured conditions decide whether it works at all.** (a) plain \`codex exec\`, NEVER \`codex exec review --base\` — that form is diff-local (2 shell commands, 0 findings where a searching pass found 6) and it REFUSES a custom prompt outright; (b) the prompt MUST mandate searching, which is why \`panel-prompt\` renders it rather than you writing one; (c) run it from the WORKTREE, because without \`node_modules\` it cannot execute anything and goes blind; (d) it obeys the \`## Code Review Rules\` in AGENTS.md, so the repo's own defect corpus steers it for free.`,
      `3. **A sandbox denial is NOT a failed run — read the verdict, not the excuse.** Codex under \`--sandbox read-only\` often reports it could not run the test suite (a temp-directory write is denied) and then proves its findings with direct executable counterexamples anyway. That exact run carried the only P1 on #1293. The rule is **directional**: a denial-bearing run returning \`"patch is correct"\` is a FALSE GREEN and is refused; the same run returning findings with executed counterexamples is valid evidence and is recorded. \`review-usage\` enforces this — do not second-guess it by grepping the explanation yourself.`,
      `4. **Walled, 401'd, or unresolvable? Waive it and fall back to the panel — it must NEVER block you.** Codex availability swings: this harness has watched it die for a day and a half, sit behind a usage wall, and come back live inside one week. A probe that comes back unavailable is an expected path, not an incident — \`codex-probe\` prints the exact \`--codex-waived "<reason>"\` line, and the 3-lens panel below then becomes the gate for this round. What is NOT acceptable is a receipt SILENT about whether codex ever looked.`,
      `5. **Judge the probe by its TEXT, never by CPU% and never by \`codex login status\`.** \`login status\` reports "Logged in using ChatGPT" while every call 401s. A real wall SAYS so and names a date; ~0% CPU with ~0 bytes is a wall or a broken wrapper, never work in progress; and no output at all is UNKNOWN, not "codex is down". Closed stdin is load-bearing in the probe — without \`< /dev/null\` codex waits on "Reading additional input from stdin..." forever, at 0% CPU.`,
      `6. **Re-run it on the NEW head after every fix round.** Codex is cheap and unwalled, so there is no reason to carry a stale answer forward: a verdict on a tree you have since changed is not a gate. Re-running produces a fresh receipt bound to the current sha, which is what \`ready\` checks.`,
      `7. **If you are a CLOUD lead on a codex-provisioned environment, you HAVE codex — run this gate yourself.** \`command -v codex\` resolves to \`/opt/node22/bin/codex\` (0.147.0); auth is materialized at session start by a \`SessionStart\` hook and effort is pinned to \`high\`. Verified 2026-08-18 by real \`turn.completed\` events in \`session_01HkfM3t5kg96ppBoRjxJghL\` (web) and \`session_01FWCKuvj9ga9NMbTb2Ude2R\` (CLI dispatch). Two cloud-specific traps beyond the four above: the auto-mode **classifier** will deny bash that reads or executes credential material, and **three consecutive denials halt the session waiting on a human** — \`codex exec\` itself is not denied, so do not route the gate through any wrapper script that touches auth. **Only if \`command -v codex\` is genuinely empty** — a non-provisioned environment — does the old carve-out apply: say so in your hand-off note immediately so the orchestrator supplies the gate leg locally. Either way, do NOT substitute the panel silently and do NOT hand off ungated.`,
      ``,
      `### 🔴 QUIESCE — stop pushing once you mark ready`,
      ``,
      `**Push the whole round, THEN mark ready, THEN stop touching the branch until the gate reports.** A gate reviews one sha; a push during it produces a verdict that covers a tree nobody reviewed. This is not hypothetical and it is not rare: **four head-moves under a running gate in a single night** (#1292 twice, #1282 twice), and on #1292 r2 the push landed **102 seconds** into a 12-minute, $6.11 review, touching the exact file under review. The one lead that did quiesce had its gate come back valid on the first try — that contrast is the whole evidence.`,
      ``,
      `If you MUST push during a gate (a genuine emergency, not a nicer comment), say so in the hand-off note naming the new sha. The launcher re-reads \`headRefOid\` before it accepts any verdict and stamps \`{"verdict":"stale"}\` on a mismatch, so a silent push does not sneak a stale gate through — it just burns the round and you pay for it twice.`,
    );
  }
  lines.push(...panelLines);
  if (externalReviewer && !subscriptionReview) {
    lines.push(
      ``,
      `Note for this lead type: your in-process \`opus\` slot resolves to **${reviewerModel}**. That slot is for step 3's integration review of a subagent's diff — it is NOT this gate, and it cannot be: an in-process reviewer inherits your aliases. The \`codex exec\` block above is the gate.`,
    );
  }

  if (kickback) {
    lines.push(
      ``,
      `## ⚠ Kickback (round ${kickback})`,
      ``,
      `The shepherd judged the PR's findings substantial. The branch/worktree already exist — load their state, address the findings below, re-verify, re-push, and re-hand-off.`,
      ...kickbackSharedLines({ findings, priorRounds, kickback }),
    );
  }
  return lines.join("\n") + "\n";
}

// Cloud-lead brief (DER-1834, validated 2026-07-15 via DER-1835/PR #808). A cloud lead is a Claude
// Code cloud session (Anthropic-managed VM): no worktree, no cmux. Since 2026-08-18 it is spawned by
// `spawn-cloud` (a `claude --cloud` session; the pre-migration path was the orchestrator's own
// RemoteTrigger routine, which work-runner could not drive because it cannot auth to claude.ai). THE
// BRIEF IS THE ARGV: the whole text below is passed as one argument, so it is also the only channel into
// the session. Ledger reporting is still a WORK-EVENT PR comment folded by `reconcile-pr-events`.
//
// Three things about the branch, all MEASURED on 2026-08-18 rather than inferred, and the third one
// reversed a decision made earlier the same day:
//   - the session starts at the COMMIT checked out in the orchestrator's worktree (session
//     01LRYXDrwTXU4YbijJGdRNKH: its HEAD was the worktree's tip, a commit that was NOT on main), so the
//     lead does start from the right code;
//   - it works on its own `claude/<session-title-slug>-<hash>` branch, NOT the issue branch; and
//   - THAT BINDING IS IN ITS SYSTEM PROMPT, not a default it can be talked out of. Session
//     01N39r4cc3n968amqFoMxcYc was handed the earlier version of step 1b — check out the issue branch —
//     and REFUSED it as an in-task attempt to override "NEVER push to a different branch without explicit
//     permission", which is precisely the right call for a zero-context session reading untrusted text.
// So the playbook does NOT move the lead's branch. The issue id rides the PR TITLE instead, which is what
// `deriveCloudPrEvents` already matches on (`headRefName + " " + title`). DER-4036 tracks the rest.
//
// Repo identity comes from `.claude/work.config.json` `repo` (see REPO_IDENTITY), NOT from literals in
// this file — the slug, the owner's login and the commit-author line were all hardcoded here, which is
// what made this harness un-shareable. `dbImageAssetId` is optional: a release-asset Postgres image, so
// a cloud lead can run real-Postgres tests where registry blob CDNs are sandbox-blocked. Omit it and
// the image-load step is simply not rendered.
export function renderCloudBrief({ issueId, title, branch, runId, acceptance, kickback, findings, bundle, priorRounds, assignedBudget,
  repo = null, dbImageAssetId = null, owner = null, commitAuthor = null } = {}) {
  const ident = getRepoIdentity();
  repo = repo ?? ident.repoSlug ?? "<owner>/<repo>";
  owner = owner ?? ident.ownerLogin ?? "the repository owner";
  dbImageAssetId = dbImageAssetId ?? ident.dbImageAssetId ?? null;
  const bundleRest = (bundle ?? []).filter((id) => id !== issueId);
  const allIds = [issueId, ...bundleRest];
  const L = [];
  const p = (...xs) => L.push(...xs);
  p(`# Cloud /work lead — ${allIds.join(", ")}${title ? `: ${title}` : ""}`, ``);
  p(`## Provenance & authorization`, ``);
  p(`Scheduled by **${owner}**, the repository owner, from their own Claude account and their own cloud environment. The env's \`GH_TOKEN\` secret and its codex reviewer grant were configured by them for this. The commit-author convention below is the repo's own — verify it in the repo's agent instructions. You are a delivery lead for \`${repo}\`: take ${allIds.join(" + ")} to a clean PR and hand off (do NOT merge).`, ``);
  p(`## Session preamble (run FIRST)`, ``, "```bash",
    ...(commitAuthor ? [`git config user.name ${JSON.stringify(commitAuthor.name)} && git config user.email ${JSON.stringify(commitAuthor.email)}`] : []),
    `export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"`,
    `[ -d node_modules ] || pnpm install --frozen-lockfile`, "```", ``);
  p(`## Issue${bundleRest.length ? "s" : ""} & acceptance`, ``, `- **Branch:** ${branch ?? "(from Linear gitBranchName)"}`);
  if (bundleRest.length) p(`- **Bundle:** implement ALL of ${allIds.join(", ")} in ONE branch/PR; verify the union of ACs; PR body lists every id.`);
  p(``, acceptance || `(see the Linear issue${bundleRest.length ? "s" : ""})`, ``);
  p(...renderAssignedBudget(assignedBudget));
  // Rendered only when the repo configured a prebuilt DB image asset. Registry blob CDNs are blocked in
  // the cloud sandbox, so the image arrives as a GitHub release asset instead of a registry pull.
  if (dbImageAssetId) {
    p(`## DB-lane only (skip if this issue touches no \`*.db.test.ts\` / migrations)`, ``, "```bash",
      `docker info >/dev/null 2>&1 || { dockerd >/tmp/dockerd.log 2>&1 & sleep 8; }`,
      `curl -fL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/octet-stream" \\`,
      `  https://api.github.com/repos/${repo}/releases/assets/${dbImageAssetId} -o /tmp/pg.tar.gz && docker load -i /tmp/pg.tar.gz && rm -f /tmp/pg.tar.gz`, "```", ``);
  }
  p(`## Playbook (draft-PR-first lifecycle — this is how the orchestrator sees + monitors you)`, ``,
    `1. **FIRST, before doing the work — register yourself by opening a DRAFT PR.** This is the orchestrator's liveness + handle signal, so do it EARLY:`,
    `   a. Confirm git identity (the preamble set it): \`git log -1\` must show the repo's required commit author.`,
    `   b. **Stay on the branch you are bound to — do NOT switch branches.** Your session is bound by its own configuration to a \`claude/…\` branch, and that is where your work belongs. An earlier version of this brief told cloud leads to check out the Linear issue branch instead; a lead correctly REFUSED that as an in-task attempt to override its binding, and it was right to (DER-4036). So: \`git rev-parse --abbrev-ref HEAD\` — whatever it prints is your branch. Report it in the PR body so the orchestrator can find your work. Then an empty WIP commit so a PR can open with no code yet: \`git commit --allow-empty -m "wip(${issueId}): cloud lead started"\` and \`git push -u origin HEAD\`.`,
    `   c. **Open a DRAFT PR via the GitHub MCP tools** (\`mcp__github__create_pull_request\`, draft:true, base main; authored by the configured commit author). A draft runs NO CI and NO Codex review — it's a placeholder. **The TITLE MUST contain ${allIds.join(" + ")} — this is load-bearing, not cosmetic:** the orchestrator matches your PR to its unit on branch-name-or-title, and your \`claude/…\` branch name does not carry the id, so a title without it makes your PR invisible to the harness and you read as a lead that never started. Body: one line noting it's a cloud lead in progress, plus the branch name from step 1b.`,
    `2. Read AGENTS.md + the area's invariants. **If the change isn't trivially clear, write a short plan FIRST, inline** — the \`/superpowers:*\` plugins (writing-plans, brainstorming, …) are NOT installed in cloud sessions (they're user-global, not repo-committed), so do not call them; instead jot: goal · exact files to touch · steps · definition-of-done · **reference-as-map** (the analogous existing implementation you're following, or "no analog exists"), then implement against it. (Repo-committed skills under \`.claude/skills\` and the built-in Skill tool ARE available.)`,
    `2b. **Declare your file scope BEFORE your first commit — MANDATORY (2026-07-25).** You have no ledger access, so emit it as a PR comment exactly like the token report in step 6:\n   \`gh api repos/${repo}/issues/<PR>/comments -f body='WORK-EVENT {"type":"plan_scope","issues":["${allIds.join('","')}"],"fileScope":["path/a.ts","path/b.ts"],"expectedAdditions":600}'\`\n   **This is a BUDGET, not a note.** The declared \`fileScope\` bounds this PR: if the real change needs **more than 1.5× the declared file count**, STOP, re-emit an updated \`plan_scope\`, and say so in the PR body — do not silently grow. ${assignedBudget ? `Your **assigned budget is ${assignedBudget.files} files / ~${assignedBudget.additions} additions** (see "Assigned budget" above) — declare against it, do not raise it.` : "Aim for **≤ ~800 additions / ≤ ~12 files**."} Measured 2026-07-25: review rounds scale directly with diff size (<1k additions → 1.25 rounds; >7k → 5.67), and cloud briefs previously never asked for this at all — the PR that shipped 98 files / +11,537 lines with no declared scope took 5 rounds and never merged.`,
    `3. **Build via subagent delegation — MANDATORY, not optional.** Decompose the change into 2–4 implementation chunks and dispatch each to a Sonnet 5 subagent via the Agent tool (\`model: "claude-sonnet-5"\`); research/codebase-mapping goes to Haiku. Run chunks IN PARALLEL whenever their file scopes are disjoint (one message, multiple Agent calls). You (the lead) plan, adversarially review each subagent's diff, integrate, and own the PR — you do NOT write implementation code yourself (sole exception: integration glue under ~20 lines). Work directly in the checkout — there is NO worktree here. Commit (conventional, mention ${allIds.join(" + ")}) and push to the SAME branch as you go (each push is your progress signal).`,
    `4. Targeted verify (typecheck + lint the changed package + touched tests; one \`*.db.test.ts\` if DB-touched). CI remains the gate for the HEAVY suites (db-suite, e2e, route-health) — do not run those locally. **EXCEPTION — the cheap deterministic guards are YOUR gate, not CI's.** If your diff adds/changes a command, an MCP tool, or a reference guide, or touches \`packages/commands\`, \`packages/reference\`, or \`apps/cli\`, run and pass ALL of these locally BEFORE marking ready (seconds each; every skipped one cost a kickback round on 2026-07-16): \`pnpm check:manifest && pnpm check:cli-version && pnpm check:docs-version && pnpm docs:check\`, plus the registry tests (ui-surface-parity, command-tools, inventory, agent-how-tos). A NEW command trips ~6 registry surfaces: §17.8 classification in \`docs/specs/agent-native-command-surface.md\`, MCP guide rows (tool names in the GENERATED-from-title form), command inventories + counts, a reference-guide entry, the changed guide's \`version:\` bumped ABOVE \`git show origin/main:<file>\`, and the regenerated CLI manifest (\`pnpm --filter <your-cli-package> generate:manifest\`) + \`pnpm fix:cli-version\` strictly above origin/main (this makes the PR a VERSION-HOLDER — it serializes in the merge queue).`,
    `5. Layer-1 adversarial self-review (correctness / security / tests) — verify EVERY acceptance-criteria bullet explicitly; fix findings. The PR body MUST carry an "AC → evidence" checklist (one row per AC bullet), a one-line note of the subagent breakdown used, and a **deviation log** (every departure from this brief; "none" if none — the shepherd checks it before enqueue).`,
    `6. **Pre-PR codex gate — MANDATORY, and YOU run it (ADR-0027 §2, amended 2026-08-18).** This environment is codex-provisioned: \`command -v codex\` resolves to \`/opt/node22/bin/codex\` (0.147.0), the OAuth grant is materialized at session start by a \`SessionStart\` hook, and effort is pinned to \`high\`. Run it from the repo root, after step 4 is green and BEFORE you mark ready:\n   \`codex exec --json --sandbox read-only -m ${CROSS_VENDOR_MODEL} -c model_reasoning_effort="${CROSS_VENDOR_EFFORT}" '<search-mandating review prompt>' < /dev/null\`\n   Fix every P0/P1 it returns, then **re-run it on the NEW head** — a verdict on a tree you have since changed is not a gate. **Judge the run by a positive \`turn.completed\` in the JSONL**, never by \`codex login status\` (it returns an EOF parse error even when auth is perfectly healthy) and never by absence of complaint. Three ways it fails SILENTLY: omit \`< /dev/null\` and it hangs to timeout on "Reading additional input from stdin…" at ~0% CPU, byte-identical to a quota wall; run it outside the repo and it refuses the trusted-directory check; and the auto-mode **classifier** denies bash that reads or executes credential material, where **three consecutive denials stop your session waiting for a human** — so run \`codex exec\` directly and never wrap it in a script that touches auth. If \`command -v codex\` is genuinely EMPTY you are on a non-provisioned environment: say so explicitly in your hand-off note so the orchestrator supplies the gate leg locally, and do NOT substitute the Claude panel silently or hand off ungated.`,
    `7. **Token telemetry — post your usage IMMEDIATELY BEFORE marking ready** (fleet performance analysis; the orchestrator folds it from the PR comment). Run the repo script and post its one-line output as a PR comment via gh api REST:\n   \`gh api repos/${repo}/issues/<PR>/comments -f body="$(node scripts/session-token-report.mjs --role lead --issues ${allIds.join(",")} --pr <PR> --host cloud${kickback ? ` --kickback ${kickback}` : ""})"\`\n   It reads your OWN session transcripts locally and reports tokens by model — no secrets, no session/env identifiers.`,
    `8. **Hand off = mark the PR ready_for_review via the GitHub MCP tools.** This transition (draft → ready) IS your hand-off — it triggers CI + Codex and tells the shepherd to take over. Do NOT merge. Do NOT mark ready until targeted verify is green AND the step-6 codex gate has returned a \`turn.completed\` on the head you are handing off.`, ``);
  p(`## How the orchestrator tracks you (no action needed beyond the above)`, ``,
    `- Your **draft PR** appearing = you booted and are alive; its footer carries your session handle (\`claude.ai/code/session_01…\`) so the owner can attach a read-only monitor. If no draft PR appears within the deadline, the orchestrator presumes you failed to start and re-spawns.`,
    `- Your **pushed commits** = progress.`,
    `- **draft → ready** = hand-off.`,
    `- (Optional, belt-and-suspenders) when you mark ready you MAY also capture \`SHA=$(git rev-parse HEAD)\` and post \`gh api repos/${repo}/issues/<PR>/comments -f body='WORK-EVENT {"type":"handed_off","issues":${JSON.stringify(allIds)},"pr":<PR>,"host":"cloud","sha":"'"$SHA"'"}'\` — the fold reads \`sha\` as deterministic evidence of a real pushed fix; the draft→ready transition is still the primary signal.`, ``);
  p(`## Context rotation (2026-07-25) — you are REQUEST-ONLY here`, ``,
    `A cloud session's transcript is not readable from the orchestrator, so nothing can detect your context depth for you — a local or mini lead gets polled every wake, and **you do not**. If you notice you are running deep (long session, many subagent returns, repeated re-reads of the same files), you must say so yourself:`,
    ``,
    `1. **Commit and push your WIP** — a rotation preserves only what is pushed, and your branch is the only thing that survives you.`,
    `2. Post your handoff note as a PR comment, prefixed exactly \`WORK-HANDOFF\` (the orchestrator reads it verbatim into your successor's brief). **Under ~2KB:** \`disposition:\` CLOSEOUT|CONTINUE · state of work · committed vs not · verification already run · **traps / dead ends you already ruled out** · open review threads.`,
    `   \`gh api repos/${repo}/issues/<PR>/comments -f body='WORK-HANDOFF\\ndisposition: CLOSEOUT\\n…'\``,
    `3. Request the rotation:`,
    `   \`gh api repos/${repo}/issues/<PR>/comments -f body='WORK-EVENT {"type":"rotate_requested","issues":${JSON.stringify(allIds)},"pr":<PR>,"host":"cloud","disposition":"CLOSEOUT"}'\``,
    `4. **KEEP WORKING until you are closed** — never idle-wait to be rotated.`,
    ``,
    `Default to \`CLOSEOUT\` (your successor lands what exists; the orchestrator splits the remainder into a new issue). At most **${ROTATION_CAP} rotations** per unit — a third request becomes a split decision, not another session.`, ``);
  p(`## Subagent contract — MANDATORY on every Agent dispatch`, ``,
    `Append this to every subagent prompt, verbatim:`, ``,
    // DER-2580: this used to say "and commit that file with your work". `tmp/` is gitignored, so leads
    // were force-adding gitignored scratch into the PR — three such files reached `main` before anyone
    // noticed, and the leads were COMPLYING with the brief, not misbehaving. Notes are scratch: write
    // them, read them, never commit them.
    `> **VERDICT FIRST.** Open your reply with your conclusion in one line — for a reviewer, \`refuted: true|false\` plus a one-line reason; for anything else, the answer itself. Detail comes AFTER, so a truncated return still carries a usable answer.`,
    `>`,
    `> **End with exactly one of \`COMPLETE\` / \`INCOMPLETE\` / \`REFUSED\` — never silence.** If you cannot finish, return \`INCOMPLETE\` naming what is missing. A subagent that returns nothing is indistinguishable from one still working.`,
    `>`,
    `> Write your findings to \`tmp/subagent-notes/${issueId}/<label>.md\` **as you go**, not at the end. That path is gitignored scratch — **do NOT commit it** and never \`git add -f\` it. Return **≤500 words + that path** — never a dump; cite \`file:line\` instead of pasting code. If you approach your context limit: finalize the file, then return \`done\` or \`partial\` plus exactly what remains.`, ``,
    `**SILENT is not WEDGED, and they need OPPOSITE responses (2026-07-31).** Two of three reviewer subagents went silent TWICE, then delivered in full on an explicit ultimatum: *"send your findings now, or send INCOMPLETE."* They were not dead — 136k and 158k tokens each. Re-pinging did nothing; the ultimatum worked immediately. For a subagent that returned NOTHING, send the ultimatum FIRST; reserve close-and-respawn for one that is provably WEDGED (0% CPU, ignoring a delivered specific poke for ~8 min). Respawning a silent-but-working agent throws away everything it has done.`, ``,
    `**A subagent cannot rotate** — it never receives a user prompt, so no nudge can reach it, and when it dies it leaves NOTHING. Measured 2026-07-25: one \`implementer\` subagent reached 134% of its window and an \`Explore\` subagent DIED at 101% with its findings unrecoverable. The bigger win is your own context: a subagent's return value is injected verbatim into you, so a 20K-token report costs YOU 20K. When one returns \`partial\` or dies, read its notes file and **re-dispatch narrowed** — never re-run the same unbounded prompt.`, ``);
  p(`## Guardrails`, ``, `Do NOT merge. Do NOT enumerate/report environment or session identifiers into comments (opening the draft PR is enough — its footer has your handle). Stage explicit paths only (never \`git add -A\`). No secrets anywhere; redact presigned-URL query strings. Never modify the /work harness.`);
  if (kickback) {
    p(``, `## ⚠ Kickback (round ${kickback})`, ``,
      `The branch and its PR already exist — the shepherd **converted the PR back to draft** when kicking it back, so it runs no CI while you fix. Load the branch state, address the findings below, re-verify (targeted), and push to the SAME branch. Then **mark the PR \`ready_for_review\` again** via the GitHub MCP tools — that draft→ready transition IS your re-hand-off (it re-fires CI + Codex and hands you back to the shepherd, exactly like your first hand-off, and the orchestrator derives it as a fresh \`handed_off\`). Do NOT open a new PR; do NOT merge. **NEVER mark ready without having pushed a fix** — a ready flip at the unchanged head SHA is a flap the harness now ignores, and it wastes the round.`,
      ...kickbackSharedLines({ findings, priorRounds, kickback, isCloud: true, repo, issueId }));
  }
  return L.join("\n") + "\n";
}

// The role env MUST be set on the workspace (inherited by the launched `claude` process and its
// SessionEnd learnings hook). A bash `export` inside the session runs in a transient subshell and
// never reaches the hook, so the role-gate would silently never fire.
function roleEnvArgs(role, runDir) {
  const args = ["--env", `WORK_ROLE=${role}`];
  if (runDir) args.push("--env", `WORK_RUN_DIR=${runDir}`);
  return args;
}

// Launch prefix for every /work session: (1) drop ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN so it runs
// on the Claude subscription (OAuth), never the metered API — the env key otherwise takes precedence
// over the claude.ai login; (2) --dangerously-skip-permissions so autonomous sessions never wait on a
// permission prompt. In-process Agent-tool subagents INHERIT the parent's bypass mode, so launching
// the orchestrator/leads/shepherd this way covers all their subagents too.
// (3) CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 — WITHOUT THIS THE SESSION WRITES NO TRANSCRIPT
// (2026-07-26). CMUX launches these as child processes, so they inherit a `CLAUDE_CODE_CHILD_SESSION`
// marker from whatever spawned them and Claude Code disables transcript persistence for the whole
// session. That silently breaks ALL token telemetry for the role: `session-token-report.mjs` reads
// the transcript, so `--match <nonce>` can never find it and `--session-id` ENOENTs. Measured this
// run: zero `.jsonl` newer than a 6-hour-old file across all 152 project dirs, while the orchestrator,
// the shepherd and 8 leads were continuously active — and `usage --run` reported orch spend as ZERO
// across three orchestrators. The failure is invisible: nothing errors, the run just under-reports.
// The session's own status line says it plainly ("Transcript saving is off — inherited
// CLAUDE_CODE_CHILD_SESSION marker"), which is the only place it surfaces.
const FORCE_TRANSCRIPTS = "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1";

// DER-2744 — the persistence var was OMITTABLE, and it was omitted. Both lead boot builders branched on
// `proxyEnv` and only the direct-Claude branch carried it, so every kimi/gpt (CLIProxyAPI) and deepseek
// (OpenRouter) lead ran with transcript persistence off. Nothing errored: those lanes simply produced no
// transcript, and a lane with no transcript is INDISTINGUISHABLE from a lane whose lead died — `usage`
// under-reports it, `lead-context` can't read it, the rotation bands never fire for it, and there is no
// crash-recovery evidence. Exactly the alt-model lanes that are hardest to observe by eye.
//
// The fix is structural, mirroring REMOTE_PATH_PRELUDE: ONE function builds the env prefix for EVERY
// claude launch, so a branch cannot forget the var — the only thing a caller varies is the key clause
// (which differs per provider) and whatever provider env follows. `assertForcesTranscripts` is the belt
// to that braces: every builder runs its FINISHED launch string through it, so a future builder (or a
// future branch) that side-steps this helper fails loudly at build time instead of quietly at telemetry
// time. See launchForcesTranscripts for why position matters.
function claudeEnvPrefix({ keyClause = "-u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN", extra = [] } = {}) {
  return ["env", keyClause, FORCE_TRANSCRIPTS, ...extra].filter((p) => p !== null && p !== undefined && p !== "").join(" ");
}

// Does this launch string actually force session persistence? POSITION IS THE WHOLE POINT: `env` applies
// assignments that PRECEDE the binary, so `claude … CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` is not an
// env assignment at all — it is an argv word claude ignores. A substring check alone would pass that and
// be a check that cannot fail. Pure and exported so the guarantee is a unit test, not a live spawn.
export function launchForcesTranscripts(launch) {
  const s = String(launch ?? "");
  const at = s.indexOf(FORCE_TRANSCRIPTS);
  if (at < 0) return false;
  const bin = s.search(/\bclaude\s+--/);
  return bin < 0 ? true : at < bin;
}

// The gate itself. Returns the launch so it can wrap an expression; throws otherwise. `label` names the
// builder, because "some launch is missing a var" is not a debuggable message.
export function assertForcesTranscripts(launch, label = "launch") {
  if (launchForcesTranscripts(launch)) return launch;
  throw new Error(
    `${label}: REFUSING to build a launch without ${FORCE_TRANSCRIPTS} in its env prefix (DER-2744).\n` +
      "  A session launched by CMUX inherits a CLAUDE_CODE_CHILD_SESSION marker and writes NO transcript,\n" +
      "  so session-token-report, lead-context, the rotation bands and crash-recovery evidence all go\n" +
      "  silently blank for this lane — which then looks identical to a lane whose lead died.\n" +
      "  Build the env prefix with claudeEnvPrefix() instead of assembling `env …` by hand.\n" +
      `  launch was: ${String(launch ?? "").slice(0, 300)}`,
  );
}

const CLAUDE_LAUNCH = `${claudeEnvPrefix()} claude --dangerously-skip-permissions`;

// --dangerously-skip-permissions is refused by Claude Code under root/sudo, so a root spawn would
// create a CMUX workspace + ledger event while the claude process exits immediately (a phantom
// lead). Refuse to spawn as root with a clear error instead. (Codex, PR #618.)
function assertNotRoot(action) {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error(
      `refusing to ${action} as root — the session launches with --dangerously-skip-permissions, ` +
        "which Claude Code refuses under root/sudo (the claude process would exit and orphan the " +
        "workspace). Run /work as a normal user.",
    );
  }
}

// CLIProxyAPI gateway (localhost only) that proxy-backed lead types (kimi/gpt/…) route through. The auth
// token is read from the chmod-600 proxy config at RUNTIME via command substitution, so the raw token
// never appears in a ledger event, a logged command line, or a --dry-run preview. Override the URL per
// lead type with a `proxyUrl` key. See the README's lead-types section.
const PROXY_URL = "http://127.0.0.1:8317";
const PROXY_KEY_EXPR = `$(sed -n 's/^[[:space:]]*-[[:space:]]*"\\(.*\\)"/\\1/p' "$HOME/.cli-proxy-api/config.yaml" | head -1)`;

// Non-CLIProxyAPI providers (`provider` key on the lead type) get their own runtime token expression —
// same discipline: a `$(…)` the SHELL resolves at launch, so the raw key never reaches a ledger event,
// a logged command line, or a --dry-run preview. The env file is read by ABSOLUTE path because a lead's
// cwd is its WORKTREE, not the repo root — a relative path silently reads nothing and the lead 401s.
//
// The path comes from `.claude/work.config.json` `repo.repoPath` + `repo.envFile`; it used to be the
// literal `<repo.repoPath>/<repo.envFile>`, which is the single most obviously un-shareable line
// in this file. Config absent ⇒ fall back to the ENV VAR already in the launching shell, which is the
// portable default and still never lands in a log (the shell expands it at launch).
function providerKeyExpr(varName, repoRoot = null) {
  const ident = getRepoIdentity();
  const base = repoRoot ?? ident.repoPath;
  if (!base) return `\${${varName}}`;
  const envPath = `${base.replace(/\/$/, "")}/${ident.envFile ?? ".env"}`;
  return `$(grep '^${varName}=' ${JSON.stringify(envPath)} | head -1 | cut -d= -f2-)`;
}
const PROVIDER_KEY_VARS = { openrouter: "OPENROUTER_API_KEY" };

// Model "family" = the vendor half of an id: `deepseek/deepseek-v4-pro` → deepseek, `anthropic/claude-opus-5`
// → anthropic, `kimi-k3` → kimi, `gpt-5.6-sol` → gpt. Used to detect an EXTERNAL reviewer (a final-review
// slot from a different vendor than the implementer), which is what earns the mandatory review gate in a brief.
export function modelFamily(id) {
  const s = String(id ?? "");
  return s.includes("/") ? s.split("/")[0] : s.split("-")[0];
}

// DER-2360 retired two brief headings that lived here: "⚑ Mandatory Codex review (pre-PR gate — every
// lead type)" (DER-2375) and "⚑ Mandatory external adversarial review (pre-hand-off gate)". Both are
// superseded by `PANEL_GATE_HEADING` — the panel is a subscription shell-out on every lead type, so
// rendering the external-reviewer block alongside it would have told a `dsv4` lead to run a FOURTH
// Opus review after the three-lens panel had already run on the same subscription. Deleted rather than
// left dangling: an unused heading is the seed of a second gate nobody maintains.

// A lead type has an external quality floor when the final review is either (a) billed to the Claude
// subscription via a headless shell-out — a different process, different auth, different model — or
// (b) an in-process slot from a DIFFERENT vendor than the lead model. Same-vendor, same-process
// reviewers (kimi→kimi, gpt→gpt, claude→claude) are self-review and get the ordinary step-5 language.
export function hasExternalReviewer(cfg = {}) {
  if (cfg.reviewerBilling === "subscription") return true;
  return Boolean(cfg.reviewerModel && cfg.leadModel && modelFamily(cfg.reviewerModel) !== modelFamily(cfg.leadModel));
}

// The review shell-out. The provider env is UNSET so the CLI falls back to the machine's Claude OAuth
// login: a separate process with its own auth AND its own model, which is what makes it immune to the
// alias remapping that silently downgraded the in-process reviewer to the cheap tier (2026-07-24).
// ANTHROPIC_API_KEY is unset too — on an OpenRouter lead it is set-but-EMPTY, and empty still counts as
// "an auth source is set", which would suppress the subscription path.
// The prompt goes in on STDIN, never as a trailing argument: `--allowedTools` is VARIADIC and silently
// swallows the next positional, so `--allowedTools Read,Grep,Glob "$(cat prompt)"` runs with an empty
// prompt and writes a zero-byte output file (caught end-to-end 2026-07-24; same gotcha as the cloud2
// headless spawn). Redirecting stdin also keeps a large diff-shaped prompt off the command line.
// `Bash` is in the tool list on purpose (DER-2375): the reviewer's highest-value move is EXECUTING the
// changed code to produce a counterexample rather than reasoning about it — measured 2026-07-25, the
// pass that ran the changed pricing function found a silent prefix-match bug that a read-only pass,
// and the GitHub Codex bot, both missed. Read/Grep/Glob alone cannot do that. The reviewer never
// commits (it has no write tools and the gate runs pre-`gh pr create`), so the blast radius is the
// worktree it was already reading.
export function reviewShellCommand({ model = "opus", promptFile = "<prompt.md>", outFile = "<review.json>" } = {}) {
  return `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY claude -p --output-format json --model ${model} --allowedTools Read,Grep,Glob,Bash < ${promptFile} > ${outFile}`;
}

// ── DER-2360 — the 3-lens adversarial PANEL, the PRIMARY pre-PR review gate ─────────────────────
// Supersedes the Codex block as the gate every brief renders. The decision is measured, not stylistic:
// mining PRs #1074–#1197 (2026-08-01), 65.4% of commits on bot-reviewed PRs landed AFTER the first bot
// review, size-matched cohorts merged 1.4–2.7× FASTER without the bot at near-identical commit churn,
// and head-to-head on #1185 the local panel found 12 of 15 findings while the bot added 2 unique.
// The operator disabled cloud auto-review on 2026-08-01, so a PR with zero bot reviews is now NORMAL —
// `@codex review` remains as an explicit, on-demand backstop for risk lanes and for calibration.
//
// Three properties carried over from the substitute gate (`review-swap`, Phase 1) because each one was
// bought with a real failure:
//   * SHELL-OUT, never an in-process Agent subagent. A subagent inherits this process's endpoint and
//     model aliases — measured 2026-07-24, a lead dispatched `model: "opus"` and got 19/19 calls on the
//     flash tier while its PR was about to claim an Opus review.
//   * A SILENT LENS IS INCOMPLETE, NEVER CLEAN. A gate that dies exits 0; recording it would
//     manufacture 0-finding "proof" of a clean PR.
//   * DISTINCT lenses. On #1183 the repro lens REFUTED the security lens and was right — three
//     redundant reviewers would have concurred and deleted live code.
export const PANEL_GATE_HEADING = "⚑ FALLBACK reviewer — the 3-lens adversarial panel (run ONLY if the codex gate is unavailable)";

// The advisory PR size ceiling, surfaced in every brief next to `plan_scope` (DER-2360 scope 4).
// ADVISORY on purpose: nothing refuses a PR for crossing it. Round count tracks additions rather than
// risk — measured across 25 PRs, <1k additions merged in 1.25 rounds, 2.6k–5k in 3.38, >7k in 5.67 —
// so the number is worth stating at plan time, when splitting is still cheap, and worth nothing as a
// hard gate at hand-off time, when the only remaining move is to review it anyway.
export const PR_ADDITIONS_TARGET = 1000;

// The discovery lenses. Each is prompted to REFUTE the change, and each defaults to `refuted: true`
// under uncertainty — a lens that cannot establish the change is sound has not cleared it.
export const PANEL_LENSES = [
  {
    id: "correctness",
    title: "correctness",
    mandate: [
      "Refute the claim that this change is CORRECT. Assume it is wrong and find where.",
      "  - logic errors, off-by-one, wrong operand order, unhandled null/empty/error branches;",
      "  - INCOMPLETE CHANGE ACROSS A FAMILY: when the diff edits ONE member of a set the codebase",
      "    treats uniformly (a registry/enum/switch/table entry, one branch of a guard, one of several",
      "    parallel implementations, call sites of a changed helper), ENUMERATE the whole family and",
      "    check each member. Report the CLASS, not the one call site;",
      "  - SILENT LOSS OF EXPLICIT INPUT: an early return, merge helper, or default applied after the",
      "    caller already set the field — worst when the default that replaces it is MORE permissive;",
      "  - PREDICATES THAT COMPARE THE WRONG OPERAND: a freshness value against a staleness cutoff, a",
      "    start against a deadline, inclusive where exclusive was meant. Name the concrete input that",
      "    produces the wrong answer;",
      "  - CLAIMS THE DIFF DOES NOT KEEP: a doc, spec, comment, or config added in this diff that the",
      "    code in the SAME diff contradicts — including anything the text says NOT to do yet;",
      "  - COPY ELSEWHERE THAT THIS DIFF FALSIFIED: if the change alters a command's authorization",
      "    scope, its transport exposure, a channel/kind guard, a query's ownership scoping, or a gate's",
      "    decision predicate, grep the repo for help/remediation/disclosure/example prose asserting the",
      "    OLD behavior — in files this diff does not touch. Stale copy is a finding this diff introduced.",
    ].join("\n"),
  },
  {
    id: "security",
    title: "security / trust boundary",
    mandate: [
      "Refute the claim that this change is SAFE. Name the principal, the boundary, and the crossing.",
      "  - who can reach the new code, with what authority, and what stops a caller without it;",
      "  - TENANT ISOLATION: any new table/query/route reachable without a server-side tenant scope;",
      "    tenant context must come from the server-side session, never from client input;",
      "  - ERROR PRECEDENCE: an authorization or ownership failure must be reported BEFORE any check",
      "    whose message reveals the existence, name, or shape of data the caller is not entitled to;",
      "  - SECRETS: material (not a reference) reaching logs, model context, error messages, or an",
      "    argument summary; a credential minted, widened, or logged;",
      "  - INJECTION AND DESERIALIZATION at every boundary the diff adds or widens;",
      "  - A GUARD THAT CANNOT FAIL: if the diff adds a check, construct the input that should trip it",
      "    and confirm it actually does. A check incapable of returning the failing answer is not a check.",
    ].join("\n"),
  },
  {
    id: "repro",
    title: "does-it-reproduce",
    mandate: [
      "Refute by EXECUTION, not by reading. You have Bash — an executed counterexample is a finding,",
      "a hunch is not. This lens exists to REFUTE the other two as much as to add findings of its own:",
      "on #1183 it proved a branch the security lens had called redundant was load-bearing, and was right.",
      "  - run the touched tests; run the changed function directly (node -e, a REPL, the test runner);",
      "  - for every behavioral claim the diff or its tests make, construct the input that would falsify",
      "    it and RUN it. Report which claims survived and which did not;",
      "  - A TEST THAT BINDS TO A SYMBOL WHILE PRODUCTION BINDS TO A CALL SITE: confirm the production",
      "    path actually reaches the function the test imports — not merely that a same-named symbol is",
      "    exported. Follow the runtime path to the call site and say which function it lands on;",
      "  - a new test must be able to FAIL: revert the fix (or mutate the guard) and confirm the test",
      "    goes red. A test that passes against the unfixed code is not coverage;",
      "  - `git log` / `git blame` for why the surrounding code looks the way it does.",
    ].join("\n"),
  },
];

export const PANEL_LENS_IDS = PANEL_LENSES.map((l) => l.id);
// The panel needs at least two DISTINCT lenses for the same reason `review-swap` does: redundant
// reviewers concur, and concurrence is not corroboration.
export const PANEL_MIN_LENSES = 2;

// ── Path-routed repo-specific checklists ────────────────────────────────────────────────────────
// The three lenses above are generic. These bind them to THIS repo's actual defect classes, routed by
// the paths the diff touches, so a lens reviewing a migration is asked about RLS and a lens reviewing
// a command is asked about surface parity — without either question diluting the other's prompt.
//
// `lens: "*"` routes to every lens. Routing is on the diff's file list, which SEEDS the review; it
// never bounds it (the mandate above sends each lens into callers, siblings and specs the diff does
// not touch).
export const PANEL_PATH_CHECKLISTS = [
  {
    id: "tenant-isolation",
    lens: "security",
    match: /(^|\/)packages\/db\/|\.sql$|(^|\/)migrations?\/|(^|\/)supabase\//,
    bullets: [
      "Every tenant-scoped table carries `tenant_id` + RLS, and a NEW table ships a cross-tenant penetration test. A table added without both is a blocker.",
      "The `events` log is append-only: any UPDATE or DELETE against it is a blocker, corrections are new rows.",
      "A foreign key between two tenant-scoped tables is composite `(tenant_id, id)`, never id-only.",
    ],
  },
  {
    id: "sql-zod-divergence",
    lens: "correctness",
    match: /(^|\/)packages\/db\/|\.sql$/,
    bullets: [
      "A SQL predicate that mirrors a Zod/TypeScript validator is DRIFT BY DEFAULT — check it clause by clause against the validator, and name the concrete value the schema rejects and the SQL accepts. The SQL copy is normally the looser one, and each field it forgets is a check it silently does not perform. A comment claiming it is fail-closed is a claim to verify, never evidence.",
    ],
  },
  {
    id: "command-surface-parity",
    lens: "*",
    match: /(^|\/)packages\/commands\/|(^|\/)apps\/cli\/|(^|\/)packages\/reference\//,
    bullets: [
      "Tri-surface parity: an operation added as a command exists on every surface the repo expects (command / CLI / UI), and the parity guard covers it.",
      "If the diff changes a command's `requiredScope`, its `exposeOverMcp`/transport exposure, or a transport guard, grep for help text, CLI examples, remediation and disclosure copy asserting the OLD behavior — including files this diff does not touch.",
    ],
  },
  {
    id: "prompt-schema-drift",
    lens: "correctness",
    match: /(^|\/)packages\/prompts\/|(^|\/)packages\/protocol\//,
    bullets: [
      "Prompts are versioned files with frontmatter and eval fixtures — never inlined into app code; a prompt change runs evals.",
      "Zod validation at every boundary, and one Zod major across the workspace (a major split typechecks fine and throws at `.parse()` across packages).",
    ],
  },
  {
    id: "authorization-precedence",
    lens: "security",
    match: /auth|guard|permission|entitle|manifest|principal|scope/i,
    bullets: [
      "Tool selection is never authorization: every agent tool call passes a server-side guard against the seat's permission manifest and writes a `tool_calls` row carrying the guard result.",
      "Agents recommend; humans decide. A durable change from an agent goes through draft-and-confirm, and `decisions.decided_by` is always a human — including under a standing authorization.",
    ],
  },
  {
    id: "money-and-metering",
    lens: "security",
    match: /billing|stripe|price|pricing|entitlement|metering|quota|spend/i,
    bullets: [
      "Any limitable capability is wired to an entitlement + metering hook, even when the limit is 'unlimited' today.",
      "A spend path, a credential mint, and a cross-tenant action are hard-floor blockers regardless of authorization mode.",
    ],
  },
  {
    id: "route-errors",
    lens: "correctness",
    match: /(^|\/)apps\/web\/src\/app\/api\/|route\.ts$|(^|\/)inngest\//,
    bullets: [
      "Errors are never swallowed: the route is wrapped (`withRouteErrors`), the failure reaches `error_logs`, and the tenant id comes from the server-side session.",
      "Background jobs are idempotent and safe to retry.",
    ],
  },
  {
    id: "docs-claims",
    lens: "correctness",
    match: /\.mdx?$|(^|\/)docs\//,
    bullets: [
      "Verify the code in the SAME diff matches every claim this prose makes, including anything it says not to do yet. Two sections of one document contradicting each other is a finding.",
    ],
  },
];

// Which checklists a given lens gets for a given file list. Pure so the routing is unit-testable
// without a repo. Order is stable (declaration order), and a checklist matches at most once no matter
// how many paths hit it.
export function pathRoutedChecklists({ paths = [], lens = null } = {}) {
  const list = (Array.isArray(paths) ? paths : []).map((p) => String(p ?? "")).filter(Boolean);
  const out = [];
  for (const entry of PANEL_PATH_CHECKLISTS) {
    if (lens && entry.lens !== "*" && entry.lens !== lens) continue;
    if (!list.some((p) => entry.match.test(p))) continue;
    out.push({ id: entry.id, bullets: entry.bullets });
  }
  return out;
}

// The file list a unified diff touches, read from the diff ITSELF rather than from `git diff
// --name-only`. Deliberate: the diff file is exactly what the lens is given, so routing derived from
// it can never describe a different tree than the one under review — and it needs no git, so a lens
// prompt renders identically in a test.
export function parseDiffPaths(diffText) {
  const paths = new Set();
  for (const line of String(diffText ?? "").split("\n")) {
    // `diff --git a/<old> b/<new>`. Take the b-side: a rename's review belongs to where the file now
    // lives. Quoted paths (spaces, unicode) are emitted by git as `"a/x y.ts"`, hence the optional quote.
    const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
    if (m) { paths.add(m[2]); continue; }
    const p = /^\+\+\+ "?b\/(.+?)"?$/.exec(line);
    if (p && p[1] !== "dev/null") paths.add(p[1]);
  }
  return [...paths];
}

// Numeric coercion for a finding's `priority` / `confidence` / line numbers, shared by BOTH review
// parsers so they cannot answer differently about one input (DER-3011 remediation — they did: the
// codex side rejected the string `"1"` and dropped a P1 out of the blocker count).
//
// Stricter than a bare `Number()` on purpose: `Number(null)`, `Number("")` and `Number([])` are all
// `0`, so a coercion written the obvious way promotes a MISSING priority to P0 — inventing a
// ship-stopping blocker out of an absent field. Only a real number, or a non-empty numeric string,
// counts as a value.
export function findingNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// The exact JSON a lens must return. Stated as a schema in the prompt AND parsed fail-closed on the
// way back in: a lens whose verdict cannot be read is INCOMPLETE, never clean.
const PANEL_OUTPUT_CONTRACT = [
  "OUTPUT — VERDICT FIRST, then a single fenced JSON block and nothing after it. A truncated reply must",
  "still carry a usable answer, so the first line is the verdict in plain text:",
  "",
  "    refuted: true|false — <one line>",
  "",
  "Then, in one ```json fence:",
  "",
  '    {"verdict": "findings" | "clean",',
  '     "summary": "<one or two sentences>",',
  '     "findings": [',
  '       {"title": "<what is wrong, not where you looked>",',
  '        "priority": 0 | 1 | 2 | 3,',
  '        "confidence": 0.0-1.0,',
  '        "file": "path/from/repo/root.ts",',
  '        "line_start": 123, "line_end": 130,',
  '        "evidence": "<the command you ran and what it returned, or the exact lines that prove it>"}',
  "     ]}",
  "",
  "priority 0 = ship-stopping, 1 = blocker (P0/P1 are the blocker class: correctness-breaking, auth,",
  "tenant isolation, secrets, money), 2 = major, 3 = minor. DEFAULT TO refuted: true UNDER UNCERTAINTY —",
  "if you could not establish the change is sound, say so rather than returning clean. An empty",
  '`findings` array with `"verdict": "clean"` is a positive claim that you searched and found nothing.',
].join("\n");

// The prompt for one lens. Pure — the brief shells out to `panel-prompt`, so this text is TESTED code
// rather than prose pasted into a brief that nothing verifies.
export function panelLensPrompt({ lens, issueId = null, diffFile = "<diff>", paths = [], acceptance = null, base = "origin/main" } = {}) {
  const def = PANEL_LENSES.find((l) => l.id === lens);
  if (!def) {
    throw new Error(`panel-prompt: unknown lens ${JSON.stringify(lens)} — known lenses: ${PANEL_LENS_IDS.join(", ")}`);
  }
  const routed = pathRoutedChecklists({ paths, lens });
  const lines = [
    `You are the **${def.title}** lens of a 3-lens adversarial review panel${issueId ? ` on ${issueId}` : ""}.`,
    "This is a GATE, not a suggestion. Two other lenses are reviewing the same change independently;",
    "your job is to find what they will not.",
    "",
    def.mandate,
    "",
    "## The diff SEEDS your search — it does not BOUND it",
    "",
    `The branch diff is at ${diffFile} (\`git diff ${base}...HEAD\`). The expensive defects are only`,
    "visible in code the diff does NOT touch, so before you finalize:",
    "  - grep every call site, sibling, and consumer of anything the diff changes, and say whether the",
    "    change is complete across all of them;",
    "  - read the per-package AGENTS.md of every package the diff touches, INCLUDING its",
    '    "## Code Review Rules" section — those are binding for this review;',
    "  - prefer EXECUTING the changed code over reasoning about it. You have Bash.",
    "",
    "Do NOT report anything in the root AGENTS.md Code Review Rules' \"Do not flag\" list, and do not",
    "report what a `pnpm check:*` script or guard test already enforces mechanically — both cost a round",
    "without adding signal.",
  ];
  if (routed.length) {
    lines.push(
      "",
      "## Repo-specific checks routed to this lens by the paths this diff touches",
      "",
      ...routed.flatMap((c) => [`**${c.id}**`, ...c.bullets.map((b) => `  - ${b}`), ""]),
    );
  }
  if (acceptance && String(acceptance).trim()) {
    lines.push("", "## Acceptance criteria this change must meet", "", String(acceptance).trim());
  }
  lines.push("", PANEL_OUTPUT_CONTRACT, "");
  return lines.join("\n");
}

// The VERIFICATION prompt (phase 2). The panel's discovery pass produces a UNION of unique findings;
// this pass tries to FALSIFY each one by execution. It is a separate context on purpose — a lens
// grading its own findings is the self-review this whole gate exists to replace.
export function panelVerifyPrompt({ issueId = null, unionFile = "<union.json>", diffFile = "<diff>" } = {}) {
  return [
    `You are the VERIFICATION pass of a 3-lens adversarial review panel${issueId ? ` on ${issueId}` : ""}.`,
    "",
    `Three lenses have already searched. Their UNIONED findings are at ${unionFile}; the branch diff is`,
    `at ${diffFile}. You are NOT here to find new defects and NOT here to re-rank these ones.`,
    "",
    "For each finding, attempt to FALSIFY it — construct and RUN the case that would prove it wrong.",
    "The asymmetry is deliberate and it is the whole contract:",
    "",
    "  - A finding is FALSIFIED only by POSITIVE EVIDENCE: a command you ran whose output proves the",
    "    reported behavior does not occur. Reading the code and disagreeing is not falsification.",
    "  - A finding you could not falsify STANDS. 'I could not reproduce it' is not falsification either —",
    "    it is an unverified finding, and it stays in the set.",
    "  - A BLOCKER-CLASS finding (priority ≤ 1, or anything touching authorization, tenant isolation,",
    "    secrets, or money) dies ONLY by positive falsification or by an explicit human acceptance",
    "    recorded elsewhere. You cannot downgrade one. You cannot drop one for being low-confidence.",
    "  - Where the lenses DISAGREED, say which one the evidence supports and why. A disagreement",
    "    resolved by execution is the most valuable thing this pass produces — on #1183 the repro lens",
    "    refuted the security lens and was right; concurring would have deleted live code.",
    "",
    "OUTPUT — verdict first, then one ```json fence and nothing after it:",
    "",
    "    falsified: <n> of <total> — <one line>",
    "",
    '    {"falsified": [',
    '       {"ref": "<the finding\'s exact title, or #N from the union file>",',
    '        "evidence": "<the command you ran and its output that proves the finding wrong>"}',
    "     ],",
    '     "confirmed": [{"ref": "…", "evidence": "<what you ran that reproduced it>"}],',
    '     "unverified": [{"ref": "…", "why": "<what you could not run and why>"}]}',
    "",
    "An entry in `falsified` with empty or hand-waving evidence will be REFUSED at record time. If you",
    "have no executed proof, it belongs in `unverified`.",
    "",
  ].join("\n");
}

// Which model the panel shells out to for a given lead type. Read from `.claude/work.config.json`
// rather than hardcoded (DER-2360 scope 2), with a deliberate ordering:
//   1. `panelModel` — the explicit per-type override for THIS gate;
//   2. `reviewerModel`, but ONLY under `reviewerBilling: "subscription"`, where it already names a
//      Claude CLI alias (dsv4/dsv4-flash carry `"opus"` there and keep working unchanged);
//   3. `opus`.
// Step 2's guard is load-bearing. On the `kimi` and `gpt` types `reviewerModel` is a PROXY model id
// (`kimi-k3`, `gpt-5.6-sol`) naming the in-process same-vendor reviewer slot — passing either to
// `claude -p --model` names a model that does not exist on the subscription and the call errors out.
export function panelReviewerModel(cfg = {}) {
  if (cfg?.panelModel) return String(cfg.panelModel);
  if (cfg?.reviewerBilling === "subscription" && cfg?.reviewerModel) return String(cfg.reviewerModel);
  return "opus";
}

// ── Reading a lens back ─────────────────────────────────────────────────────────────────────────
// Input is one `claude -p --output-format json` envelope. Every refusal below is a case that has
// actually been observed, and each one fails CLOSED — a lens that cannot be read is INCOMPLETE.
//
// Shared by the discovery lenses and the verification pass, because the ways a shell-out can come back
// unusable are a property of the shell-out, not of what it was asked to do. Splitting it in two is how
// one of them ends up with three of the four checks.
export function readClaudeEnvelope({ raw = null, label = "lens" } = {}) {
  const bad = (refusal) => ({ ok: false, refusal, result: null, models: [], providers: [] });
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    // The zero-byte file. `--allowedTools` is VARIADIC and swallows a trailing positional, so a prompt
    // passed as an argument instead of on STDIN runs the reviewer with an EMPTY prompt and writes
    // nothing. Observed end-to-end 2026-07-24.
    return bad(`panel ${label}: the output file is EMPTY. The reviewer never ran, or the prompt was passed as an argument instead of on STDIN (\`--allowedTools\` is variadic and swallows a trailing positional). Re-run it.`);
  }
  let envelope;
  try { envelope = JSON.parse(text); }
  catch (err) { return bad(`panel ${label}: output is not the JSON envelope from \`claude -p --output-format json\` (${err instanceof Error ? err.message : String(err)}). A prose reply cannot be recorded as a gate.`); }
  if (envelope?.is_error || (envelope?.subtype && envelope.subtype !== "success")) {
    return bad(`panel ${label}: the run FAILED (subtype=${envelope?.subtype ?? "?"}, api_error_status=${envelope?.api_error_status ?? "none"}) — a failed pass is INCOMPLETE, never clean. Re-run it.`);
  }
  const result = typeof envelope?.result === "string" ? envelope.result.trim() : "";
  if (!result) return bad(`panel ${label}: the run succeeded but returned an EMPTY result. Silence is INCOMPLETE, never clean — send it the ultimatum ("findings or INCOMPLETE") and re-run.`);

  const models = [];
  const providers = [];
  const mu = envelope?.modelUsage;
  if (mu && typeof mu === "object") {
    for (const [model, u] of Object.entries(mu)) {
      models.push(model);
      if (u?.provider) providers.push(String(u.provider));
    }
  }
  return { ok: true, refusal: null, result, models, providers };
}

export function parsePanelLensOutput({ raw = null, lens = null } = {}) {
  const label = `lens ${lens ?? "?"}`;
  const env = readClaudeEnvelope({ raw, label });
  const bad = (refusal) => ({ ok: false, refusal, verdict: null, summary: null, findings: [], models: env.models, providers: env.providers });
  if (!env.ok) return { ...bad(env.refusal), models: [], providers: [] };
  const { models, providers, result } = env;

  const parsed = extractJsonObject(result);
  if (!parsed) {
    return bad(`panel ${label}: no JSON verdict block in the reply — the lens answered in prose, so its verdict cannot be read. A verdict that cannot be read is INCOMPLETE, never clean.`);
  }
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = rawFindings.map((f) => ({
    title: typeof f?.title === "string" ? f.title : null,
    priority: findingNumber(f?.priority),
    confidence: findingNumber(f?.confidence),
    file: typeof f?.file === "string" ? f.file : null,
    line_start: findingNumber(f?.line_start),
    line_end: findingNumber(f?.line_end),
    evidence: typeof f?.evidence === "string" ? f.evidence : null,
  }));
  // A finding with no title cannot be referenced, adjudicated, or falsified — and an untitled entry in
  // a blocker count is a number nobody can act on.
  if (findings.some((f) => !f.title)) {
    return bad(`panel ${label}: a finding has no \`title\`. Every finding must be referenceable by title — that is how it is later falsified or adjudicated.`);
  }
  const verdict = typeof parsed.verdict === "string" && parsed.verdict.trim()
    ? parsed.verdict.trim()
    : (findings.length ? "findings" : null);
  if (!verdict) {
    return bad(`panel ${label}: no \`verdict\` field and no findings to infer one from.`);
  }
  return {
    ok: true,
    refusal: null,
    verdict,
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
    findings,
    models,
    providers,
  };
}

// The verification pass reads back through the SAME envelope checks and then a different body: it
// returns falsifications, not findings. Kept separate from `parsePanelLensOutput` rather than
// overloaded onto it, because a verify reply carrying a `findings` array is a verify pass that did the
// wrong job, and silently accepting one would let phase 2 quietly re-open discovery on itself.
export function parsePanelVerifyOutput({ raw = null } = {}) {
  const env = readClaudeEnvelope({ raw, label: "verification pass" });
  const bad = (refusal) => ({ ok: false, refusal, falsified: [], confirmed: [], unverified: [], models: env.models ?? [], providers: env.providers ?? [] });
  if (!env.ok) return { ...bad(env.refusal), models: [], providers: [] };
  const parsed = extractJsonObject(env.result);
  if (!parsed) {
    return bad("panel verification pass: no JSON block in the reply. A verification pass that cannot be read clears NOTHING — re-run it, or record the gate without it, in which case every discovered finding stands.");
  }
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    ok: true,
    refusal: null,
    falsified: arr(parsed.falsified),
    confirmed: arr(parsed.confirmed),
    unverified: arr(parsed.unverified),
    models: env.models,
    providers: env.providers,
  };
}

// Pull the verdict object out of a reply. Tries, in order: the whole reply as JSON, the LAST ```json
// fence (models often narrate first and answer last), then the last balanced brace run. Returns null
// rather than guessing — the caller treats null as INCOMPLETE.
function extractJsonObject(text) {
  const s = String(text ?? "");
  const attempt = (candidate) => {
    try {
      const v = JSON.parse(candidate);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch { return null; }
  };
  const whole = attempt(s.trim());
  if (whole) return whole;
  const fences = [...s.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const v = attempt(fences[i].trim());
    if (v) return v;
  }
  // Last resort: scan for a balanced object. Brace-counting rather than a regex, because findings
  // strings routinely contain braces.
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const v = attempt(s.slice(start, i + 1));
          if (v) return v;
          break;
        }
      }
    }
  }
  return null;
}

// ── The union, and why it is a union ────────────────────────────────────────────────────────────
// MAJORITY PRIORITIZES, NEVER ERASES. A finding raised by ONE lens is still a finding: the panel's
// value comes from lenses that fail differently, so a 1-of-3 finding is the normal shape of the thing
// that makes the panel worth running, not a weak signal to be voted down. Concurrence is not
// corroboration — three reviewers that agree may simply share a blind spot.
//
// Priority: the MODE of the priorities the lenses assigned, EXCEPT that the blocker class is sticky —
// if any lens called it priority ≤ 1, it stays ≤ 1. Otherwise a 2-vs-1 majority could downgrade a P1
// to a P3 and delete it from the blocker count without ever falsifying it, which is erasure wearing
// prioritization's clothes.
export function unionPanelFindings(perLens = {}) {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const byKey = new Map();
  for (const [lens, findings] of Object.entries(perLens)) {
    for (const f of Array.isArray(findings) ? findings : []) {
      // Same file + same line + same normalized title = the same defect seen twice. File+line alone
      // would merge two unrelated defects on one line; the title alone would split one defect two
      // lenses worded differently. Both is the compromise, and it errs toward SPLITTING — a duplicate
      // in the set costs a reader a moment, a merged pair loses one lens's evidence.
      const key = `${norm(f?.file)}::${f?.line_start ?? ""}::${norm(f?.title)}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          title: f?.title ?? null,
          priority: f?.priority ?? null,
          confidence: f?.confidence ?? null,
          file: f?.file ?? null,
          line_start: f?.line_start ?? null,
          line_end: f?.line_end ?? null,
          evidence: f?.evidence ?? null,
          lenses: [lens],
          priorities: { [lens]: f?.priority ?? null },
        });
        continue;
      }
      existing.lenses.push(lens);
      existing.priorities[lens] = f?.priority ?? null;
      if (!existing.evidence && f?.evidence) existing.evidence = f.evidence;
      if (existing.confidence == null || (f?.confidence != null && f.confidence > existing.confidence)) {
        existing.confidence = f?.confidence ?? existing.confidence;
      }
    }
  }
  const findings = [];
  const dissent = [];
  for (const entry of byKey.values()) {
    const votes = Object.values(entry.priorities).filter((p) => Number.isFinite(Number(p))).map(Number);
    let priority = entry.priority ?? null;
    if (votes.length) {
      const counts = new Map();
      for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
      let best = votes[0];
      for (const [v, n] of counts) {
        const bn = counts.get(best) ?? 0;
        // Tie goes to the MORE severe priority (the lower number) — the same fail-closed direction as
        // the sticky-blocker rule below.
        if (n > bn || (n === bn && v < best)) best = v;
      }
      priority = best;
      const min = Math.min(...votes);
      if (min <= 1 && priority > 1) priority = min;
      if (new Set(votes).size > 1) {
        dissent.push({ title: entry.title, file: entry.file, line_start: entry.line_start, priorities: { ...entry.priorities }, resolved_to: priority });
      }
    }
    findings.push({
      title: entry.title,
      priority,
      confidence: entry.confidence,
      file: entry.file,
      line_start: entry.line_start,
      line_end: entry.line_end,
      evidence: entry.evidence,
      lenses: [...entry.lenses],
      agreement: entry.lenses.length,
    });
  }
  // Most severe first, so a truncated read still shows the blockers.
  findings.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || String(a.file ?? "").localeCompare(String(b.file ?? "")));
  return { findings, dissent };
}

// ── Falsification (phase 2) ─────────────────────────────────────────────────────────────────────
// The ONLY way a discovered finding leaves the set without being fixed, other than a `gate_adjudication`
// recorded by the orchestrator or the human operator. It requires POSITIVE evidence, checked here
// rather than trusted: an entry whose evidence is empty or trivially short is refused, because
// "falsified: true" with no proof is exactly the shape of a gate that grades itself clean.
export const FALSIFY_MIN_EVIDENCE = 40;

export function applyFalsifications({ findings = [], falsify = [] } = {}) {
  const list = Array.isArray(findings) ? [...findings] : [];
  const entries = Array.isArray(falsify) ? falsify : [];
  if (!entries.length) return { ok: true, refusal: null, findings: list, falsified: [] };
  const kept = [...list];
  const falsified = [];
  for (const entry of entries) {
    const ref = entry?.ref ?? entry?.title ?? null;
    const evidence = typeof entry?.evidence === "string" ? entry.evidence.trim() : "";
    if (!evidence) {
      return { ok: false, refusal: `review-panel --falsify: the entry for ${JSON.stringify(ref)} carries NO evidence. A finding dies only by POSITIVE falsification — a command that was run and what it returned. With no proof it belongs in \`unverified\`, and it stays in the set.`, findings: list, falsified: [] };
    }
    if (evidence.length < FALSIFY_MIN_EVIDENCE) {
      return { ok: false, refusal: `review-panel --falsify: the evidence for ${JSON.stringify(ref)} is ${evidence.length} characters (${JSON.stringify(evidence)}). Positive falsification means naming the command you ran and what it returned; a ${FALSIFY_MIN_EVIDENCE}-character floor is the crudest possible check that something was actually run, and this does not clear it.`, findings: list, falsified: [] };
    }
    const idx = resolveGateFindingRef(ref, kept);
    if (idx === -1) {
      return { ok: false, refusal: `review-panel --falsify: ${JSON.stringify(ref)} matches no finding in the union. Reference a finding by its exact title or by #N (1-based) from the union file — a falsification that resolves to nothing would silently record as applied.`, findings: list, falsified: [] };
    }
    const [removed] = kept.splice(idx, 1);
    falsified.push({ ...removed, falsified_by: entry?.by ?? null, evidence });
  }
  return { ok: true, refusal: null, findings: kept, falsified };
}

// The panel's `review_findings` event. Deliberately the SAME event type the codex gate writes, so
// `ready`, `gateEvidenceLookup` and `gateBlockerCountVerdict` all apply unchanged — plus first-class
// provenance, because "which model actually reviewed this" is the exact question DER-2293 was filed
// about after an agent reported a review that had happened on the wrong model.
export function reviewPanelEvent({
  issueId, pr = null, sha, base = null, files = null, engine = "claude", model = null,
  modelsObserved = [], providers = [], lensesRequested = [], lensesReturned = [], verdictPerLens = {},
  findings = [], falsified = [], dissent = [], round = 1, actor = null, verified = false,
  crossVendor = null,
} = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const blockers = gateBlockerFindings({ findings: list }).length;
  const ev = {
    actor: actor ?? (issueId ? `lead:${issueId}` : "lead"),
    type: "review_findings",
    role: "reviewer",
    reviewer: `panel:${engine}${model ? `/${model}` : ""}`,
    gate_kind: "panel",
    engine,
    model,
    // The models the runs ACTUALLY used, read from each lens's own `modelUsage`. The requested alias is
    // a request; this is the measurement, and they have diverged in production.
    models_observed: [...new Set(modelsObserved.filter(Boolean))],
    providers: [...new Set(providers.filter(Boolean))],
    // A panel is the PRIMARY gate now, not a stand-in for a bot that was down. `substitute` stays on the
    // event as an explicit false so every existing reader (`gateProvenance`, `ready`, the board) keeps
    // reading one field rather than inferring from the absence of one.
    substitute: false,
    lenses: lensesReturned,
    lenses_requested: lensesRequested,
    lenses_returned: lensesReturned,
    verdict_per_lens: verdictPerLens,
    // Derived, never asserted: clean means every lens returned AND no blocker survived verification.
    verdict: blockers > 0 ? "blockers" : "clean",
    confidence: null,
    findings_total: list.length,
    blockers,
    findings: list,
    falsified,
    dissent,
    verified: verified === true,
    tokens_total: null,
    sha,
    base_sha: base ?? null,
    files_reviewed: Array.isArray(files) ? files.length : null,
    file_set: Array.isArray(files) ? files : null,
    pr: pr == null ? null : Number(pr),
    round,
    // DER-3011 — the round-1 cross-vendor attestation. Always present (never omitted on absence): the
    // difference between "codex ran", "codex was walled and we said so" and "nobody recorded either" is
    // exactly what a reader six hours later needs, and an absent field would collapse all three into the
    // one that reads as fine.
    cross_vendor: crossVendor ?? null,
    ts: new Date().toISOString(),
  };
  if (issueId) ev.issue = issueId;
  return ev;
}

// The copy-pasteable panel block for a brief. Kept here rather than inline in `renderBrief` so the
// shell the lead actually runs is covered by the same tests as the rest of the gate.
//
// DER-3011 — `round` is now RENDERED rather than hardcoded to 1. It used to print `--round 1` on every
// brief including a kickback's, so the receipt's own round number said "first review" on a third one.
// That was cosmetic until the cross-vendor pass keyed on it; it is load-bearing now, because "round 1
// only" is meaningless if every round records itself as round 1.
export function panelReviewCommands({ issueId = "<ISSUE>", model = "opus", runner = "node scripts/work-runner.mjs", runId = "<run>", runsRoot = "<runs-root>", base = "origin/main", round = 1 } = {}) {
  const t = (name) => `/tmp/${issueId}-panel-${name}`;
  const r = Number.isFinite(Number(round)) && Number(round) > 0 ? Number(round) : 1;
  const firstRound = r <= CROSS_VENDOR_ROUND;
  return [
    `git diff ${base}...HEAD > ${t("diff")}`,
    `SHA=$(git rev-parse HEAD)`,
    ``,
    `# 1. DISCOVERY — three lenses, three SEPARATE processes on the Claude subscription.`,
    `#    Each prompt is rendered by the runner (path-routed to what this diff touches), so it is`,
    `#    tested code rather than prose. Run them in the background together; they are independent.`,
    `for LENS in ${PANEL_LENS_IDS.join(" ")}; do`,
    `  ${runner} panel-prompt --issue ${issueId} --lens "$LENS" --diff ${t("diff")} > ${t('"$LENS".md')}`,
    `  ${reviewShellCommand({ model, promptFile: t('"$LENS".md'), outFile: t('"$LENS".json') })} &`,
    `done; wait`,
    ...(firstRound
      ? [
        ``,
        `# 1b. ROUND 1 — the codex gate (the DEFAULT reviewer here) runs ALONGSIDE the three lenses above.`,
        `#     Start it BEFORE the \`wait\`, or run it now; either way its result is an INPUT to step 2.`,
        `#     Full block: "${CROSS_VENDOR_HEADING}" below.`,
        `#`,
        `#     ⚠ IF CODEX IS WALLED / 401'd / UNRESOLVABLE (\`codex-probe\` exits nonzero): DELETE the`,
        `#       --codex-review/--codex-log line from BOTH commands below, and add to step 3 only:`,
        `#           --codex-waived "<the reason codex-probe printed>"`,
        `#       The panel above then stands as the SOLE gate and the waiver is recorded on the receipt.`,
        `#       This never blocks you, and it is never a reason to skip the panel.`,
      ]
      : [
        ``,
        `# (Round ${r} is a REVISION: the panel is the whole gate here. Do NOT re-run the round-1 codex`,
        `#  gate — its P1 yield decays 53% → 24% → 31% → 11% → 0% by round, so it is spent on the first`,
        `#  complete diff. The receipt below carries round 1's answer forward automatically.)`,
      ]),
    ``,
    `# 2. UNION + VERIFY — record the discovery pass, then falsify by EXECUTION on a fresh context.`,
    `#    \`--dry-run\` prints the union without writing an event, which is what the verify pass reads.`,
    `${runner} review-panel --run ${runId} --runs-root ${runsRoot} --issue ${issueId} --sha $SHA --dry-run \\`,
    `  ${PANEL_LENS_IDS.map((l) => `--lens-file ${l}=${t(`${l}.json`)}`).join(" \\\n  ")}${firstRound ? ` \\\n  --codex-review ${t("codex.json")} --codex-log ${t("codex.jsonl")}` : ""} > ${t("union.json")}`,
    `${runner} panel-prompt --issue ${issueId} --lens verify --union ${t("union.json")} --diff ${t("diff")} > ${t("verify.md")}`,
    reviewShellCommand({ model, promptFile: t("verify.md"), outFile: t("verify.json") }),
    ``,
    `# 3. RECORD the gate. This is the event the shepherd audits; without it \`ready\` blocks.`,
    `${runner} review-panel --run ${runId} --runs-root ${runsRoot} --issue ${issueId} --sha $SHA --round ${r} \\`,
    `  ${PANEL_LENS_IDS.map((l) => `--lens-file ${l}=${t(`${l}.json`)}`).join(" \\\n  ")} \\`,
    ...(firstRound
      ? [
        `  --codex-review ${t("codex.json")} --codex-log ${t("codex.jsonl")} \\`,
        `  --verify-file ${t("verify.json")}`,
      ]
      : [`  --verify-file ${t("verify.json")}`]),
  ].join("\n");
}

// ── Codex review gate (DER-2375) ────────────────────────────────────────────────────────────────
// The SECOND reviewer in the gate, and on most lanes the first one to run. Measured 2026-07-25:
//   * `codex exec review --base <ref>` is the WRONG entry point — it is diff-local (2 shell commands,
//     0 findings on a PR where the cloud bot posted 4) and it REFUSES a custom prompt
//     ("the argument '--base <BRANCH>' cannot be used with '[PROMPT]'").
//   * plain `codex exec` in the checkout, with a prompt that MANDATES searching, ran 21+ commands and
//     returned 6 findings including two P1s the GitHub Codex bot never posted.
// So the gate shells out to plain `codex exec`, read-only, with a JSON schema so the findings are
// machine-checkable instead of prose. It rides the ChatGPT subscription (`codex login status` →
// "Logged in using ChatGPT"), NOT the Anthropic one — which is why its usage is recorded as its own
// `review_findings` event rather than folded into the Anthropic role × model cost table.
// The reviewer needs a checkout with node_modules present: on a bare worktree it skips the test run
// and goes blind (measured — 0 findings against 2 real ones).
// `--json` is LOAD-BEARING, not cosmetic (DER-2518, fixed 2026-07-26 mid-run). `codexRunCompleted`
// parses the JSONL event stream and accepts completion only from an exact producer
// `{type:"turn.completed"}` record. Command events are separate coverage evidence and may be
// suppressed by a healthy read-only client, so their absence is not completion failure.
// Stderr is kept separate: mixing diagnostics into the JSONL destroys its typed evidence contract.
// Verified live on codex-cli 0.144.4 before this edit: `--json` composes with `--output-schema` and
// `--output-last-message` (exit 0, turn.completed=true, command_execution=2, out.json well-formed).
// ── 2.1 — never invoke a bare `codex` ────────────────────────────────────────────────────────────
// On 2026-07-31 both an orchestrator and a shepherd independently lost ~40 minutes to a WRONG ROOT
// CAUSE because `which -a codex` resolved to a cmux CLI shim ahead of the real binary. That shim
// generation invoked `timeout`, which does not exist on macOS, so it printed `command not found` and
// then hung at 0.0% CPU with ~37 bytes of output — BYTE-IDENTICAL to the quota-wall signature the skill
// teaches an operator to trust. Two agents hit it separately, so it is environmental, not a one-off.
//
// Re-measured on this host 2026-07-31 before implementing, per the plan's own re-verification rule, and
// the finding did NOT hold as written: `codex` here IS the real `@openai/codex` CLI, `~/bin/codex` does
// not exist at all, and the shims present never call `timeout` (they exec a cmux wrapper, or strip their
// own directory out of PATH and exec the real binary). The plan prescribed hardcoding `~/bin/codex`;
// doing that literally would have broken every codex call on this machine.
//
// So the durable rule is kept and the brittle path is not: resolve explicitly, refuse to accept a shim
// directory as the answer, and let an operator override. The audit the plan also asked for came back
// clean — there is no bare `timeout` anywhere in skills/**, hooks/** or install.sh.
// Conventional shell encoding of "killed by signal N" (2.2). Kept as a named constant so the exit code
// a killed `watch` reports is a stated contract rather than a magic number a caller has to guess.
export const SIGNAL_EXIT_BASE = 128;

export const CODEX_SHIM_MARKERS = ["cmux-cli-shims"];

// Pure resolver so both outcomes are unit-testable without a filesystem. `exists` is injected; the
// async wrapper below supplies the real check.
//
// Returning `null` for "not found" is deliberate and load-bearing: an absent codex is UNKNOWN, never a
// verdict. Every caller must treat null as "could not measure", because the entire point of 2.1 is that
// a probe which cannot run must not be rendered as a probe that ran and failed.
export function resolveCodexBinFrom({ pathEnv = "", override = null, home = "", exists = () => false } = {}) {
  const skipped = [];
  if (override) {
    return exists(override)
      ? { bin: override, source: "WORK_CODEX_BIN", skipped }
      : { bin: null, source: "WORK_CODEX_BIN", skipped, why: `WORK_CODEX_BIN=${override} does not exist` };
  }
  for (const dir of String(pathEnv).split(":").filter(Boolean)) {
    const candidate = `${dir.replace(/\/$/, "")}/codex`;
    if (!exists(candidate)) continue;
    // A shim is not "a codex that might work" — it is the thing whose failure mode is indistinguishable
    // from a quota wall. Skip it and keep walking; record it so the operator learns WHY.
    if (CODEX_SHIM_MARKERS.some((m) => candidate.includes(m))) { skipped.push(candidate); continue; }
    return { bin: candidate, source: "PATH", skipped };
  }
  const fallback = `${home.replace(/\/$/, "")}/bin/codex`;
  if (home && exists(fallback)) return { bin: fallback, source: "~/bin", skipped };
  return {
    bin: null, source: null, skipped,
    why: skipped.length
      ? `the only codex on PATH is a shim (${skipped.join(", ")}) and no real binary was found — a shim's hang is byte-identical to a quota wall, so this is UNKNOWN, not "codex is down"`
      : "no codex found on PATH or at ~/bin/codex",
  };
}

export function resolveCodexBin({ pathEnv = process.env.PATH ?? "", override = process.env.WORK_CODEX_BIN ?? null, home = homedir() } = {}) {
  return resolveCodexBinFrom({ pathEnv, override, home, exists: (p) => existsSync(p) });
}

// The reviewer model and reasoning effort are PINNED on the command, never inherited from
// `~/.codex/config.toml`. Two reasons, both measured:
//   * The host config is `model_reasoning_effort = "medium"`. A gate that silently reviews at medium
//     because someone edited their personal config is the "green from an adjacent question" shape —
//     the receipt would say the gate ran, and it did, at an effort nobody chose.
//   * The receipt records what was pinned, so a later archaeology can tell a high-effort verdict from
//     a medium-effort one. An unpinned run is unattributable after the fact.
// Overridable for hosts on a different codex build: WORK_CODEX_MODEL / WORK_CODEX_EFFORT.
export const CROSS_VENDOR_MODEL = process.env.WORK_CODEX_MODEL || "gpt-5.6-sol";
export const CROSS_VENDOR_EFFORT = process.env.WORK_CODEX_EFFORT || "high";

export function codexReviewCommand({ promptFile = "<prompt.md>", outFile = "<review.json>", logFile = "<review.jsonl>", errorFile = "<review.stderr.log>", schemaFile = "~/.claude/skills/work/codex-review-schema.json", bin = null, model = CROSS_VENDOR_MODEL, effort = CROSS_VENDOR_EFFORT } = {}) {
  // Resolved, never bare. Falling back to the literal `codex` when nothing resolves keeps the command
  // renderable for briefs and tests; the PROBE is what refuses to turn an unresolvable binary into a
  // verdict, and it runs before any gate depends on this.
  const codex = bin ?? resolveCodexBin().bin ?? "codex";
  return `${codex} exec --json --sandbox read-only -m ${model} -c model_reasoning_effort="${effort}" --output-schema ${schemaFile} --output-last-message ${outFile} - < ${promptFile} > ${logFile} 2> ${errorFile}`;
}

// Token total for the gate run. Two log shapes, because the flag above changed which one we get:
//   * `--json` (current): the trailing `turn.completed` event carries `usage:{input_tokens,
//     cached_input_tokens, output_tokens, reasoning_output_tokens}`. Measured on 0.144.4.
//   * pre-`--json` (historical logs): a trailing `tokens used\n<N>` pair on the human transcript.
// Try the structured form first, fall back to the scrape so old logs still score. Return null rather
// than invent a number — a fake zero would read as "the gate was free" in the metrics.
// `cached_input_tokens` is NOT added: it is a subset of `input_tokens`, so summing it double-counts.
export function codexTokensFromLog(logText) {
  if (typeof logText !== "string") return null;
  let last = null;
  for (const line of logText.split("\n")) {
    if (!line.includes('"turn.completed"')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === "turn.completed" && ev.usage) last = ev.usage;
    } catch {
      /* a partial or interleaved line is not evidence — keep looking */
    }
  }
  if (last) {
    const n = (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0) + (Number(last.reasoning_output_tokens) || 0);
    if (n > 0) return n;
  }
  const m = /tokens used\s*\n\s*([\d,]+)/i.exec(logText);
  if (!m) return null;
  const n = Number.parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// ── The codex false-green refusal, and why the obvious version of this rule is WRONG ──────────────
//
// Under `--sandbox read-only` codex routinely reports it could not run the test suite: vitest attempts
// a temp-directory write and is denied. The tempting rule — "grep the explanation for `could not run`
// and treat the review as failed" — was written into this harness's learnings file as bullet 11, and it
// is BACKWARDS. Measured on PR #1293: the codex run whose own `overall_explanation` reads
//
//   "Vitest could not collect in the read-only sandbox because it attempted a temporary-directory
//    write, but direct executable counterexamples confirmed the principal failures"
//
// is the run that carried the panel's ONLY P1 — a defect all three Claude lenses read past. Discarding
// it on the denial string would have thrown away the single most valuable finding of the round.
//
// The rule is DIRECTIONAL. A sandbox denial only invalidates a verdict in the direction the denial can
// manufacture, which is CLEAN:
//   * verdict "patch is correct" + a denial  ⇒ FALSE GREEN. Codex is reporting no problems partly
//     because it could not execute the thing that would have shown them. Refuse it.
//   * verdict "patch is correct" + no denial ⇒ a real clean verdict. Record it.
//   * ANY findings returned                  ⇒ VALID regardless of the denial. Findings are positive
//     evidence; a run that produced them demonstrably did work, and codex proves them with direct
//     executable counterexamples precisely because the suite was unavailable.
//
// Deliberately narrow: it matches denial phrasings tied to the SANDBOX, not the word "sandbox" alone
// (which appears in innocuous prose like "run in a sandbox"), and never fires when findings exist.
// Every alternative requires a DENIAL VERB. An earlier draft accepted bare "read-only sandbox", and its
// own negative control caught it: "Reviewed in a read-only sandbox workspace. Executed the changed
// function directly" would have been refused as a false green — i.e. the guard would have rejected a
// genuine, thorough clean verdict for describing where it ran. A gate that refuses good input gets
// waived by habit, which is worse than no gate.
const CODEX_SANDBOX_DENIAL = /((could ?n[o']t|could not|unable to|failed to)\s+(run|collect|execute|install|start|spawn|write)|permission denied|(denied|blocked|prevented)\s+by\s+the\s+sandbox|sandbox\s+(denied|blocked|prevented)|read-only[^.\n]{0,30}(prevented|blocked|denied))/i;

export function codexFalseGreenRefusal({ verdict, explanation, findings } = {}) {
  const n = Array.isArray(findings) ? findings.length : 0;
  // Findings are positive evidence of work. A denial cannot manufacture them, so it cannot invalidate them.
  if (n > 0) return null;
  if (String(verdict ?? "") !== "patch is correct") return null;
  const text = String(explanation ?? "");
  const hit = CODEX_SANDBOX_DENIAL.exec(text);
  if (!hit) return null;
  return (
    `codex gate: REFUSING to record a CLEAN verdict from a run that also reports a sandbox denial (${JSON.stringify(hit[0])}). ` +
    `"patch is correct" with zero findings, from a run that could not execute, is indistinguishable from a review that never looked — ` +
    `which is the 0-finding-reads-as-CLEAN shape every other refusal in this gate exists to prevent. ` +
    `Re-run the gate from the WORKTREE (with node_modules present) so codex can execute, or record the round as waived with the reason. ` +
    `NOTE the asymmetry, and do not "fix" it by loosening: the SAME denial string on a run that RETURNED FINDINGS is valid evidence and is recorded — ` +
    `measured on #1293, that exact run carried the only P1 of the round.`
  );
}

// Normalize the schema'd codex payload into the shape the ledger and the fidelity scorer both use.
// `absolute_file_path` is absolute inside whatever worktree the review ran in, so it is relativized
// against `repoRoot` — otherwise a finding recorded in one worktree can never be matched to a cloud
// finding, which is keyed on the repo-relative path.
export function parseCodexReview(payload, { repoRoot } = {}) {
  if (!payload || typeof payload !== "object") throw new Error("codex review: expected the JSON object written by --output-last-message");
  if (!Array.isArray(payload.findings)) throw new Error("codex review: payload has no findings[] — did the run fail, or was --output-schema omitted?");
  const rel = (p) => {
    const s = String(p ?? "");
    if (!repoRoot) return s.replace(/^.*?\/(apps|packages|docs|scripts|\.github|\.claude)\//, "$1/");
    return s.startsWith(repoRoot) ? s.slice(repoRoot.length).replace(/^\/+/, "") : s;
  };
  return {
    verdict: payload.overall_correctness ?? null,
    explanation: payload.overall_explanation ?? "",
    confidence: payload.overall_confidence_score ?? null,
    findings: payload.findings.map((f) => ({
      title: String(f?.title ?? "").trim(),
      body: String(f?.body ?? "").trim(),
      // Shared with the Claude lens parser (DER-3011 remediation). This side used a BARE
      // `Number.isFinite(f.priority)` with no coercion, so codex returning the schema-legal string
      // `"1"` produced `null` — a P1 that vanished from the blocker count, which is the under-counting
      // direction that ships an open blocker. The other parser coerced. Same input, two answers.
      priority: findingNumber(f?.priority),
      confidence: findingNumber(f?.confidence_score),
      file: rel(f?.code_location?.absolute_file_path),
      line_start: Number(f?.code_location?.line_range?.start ?? 0) || null,
      line_end: Number(f?.code_location?.line_range?.end ?? 0) || null,
    })),
  };
}

// The gate's evidence event. Deliberately NOT a `token_usage` record: codex rides a different
// subscription, and stuffing it into by_model would corrupt the Anthropic cost table with a model id
// that never billed there. The shepherd checks for THIS event (reviewer + round + no open blockers),
// and `review-fidelity` later scores it against what the cloud bot actually posted.
// `sha` (2026-07-25) is the tree/commit the review actually covered, and it is load-bearing rather
// than decorative: a working-tree gate's verdict is a statement about ONE INSTANT, so without it a
// later reader mistakes the event for a statement about the merged commit, and `review-fidelity`
// cannot tell which cloud comments the gate even had a chance to pre-empt. Recorded on the event
// because that is the only place that survives the session.
export function reviewFindingsEvent(review, { issueId, round = 1, reviewer, actor, tokensTotal = null, sha = null } = {}) {
  if (!review || !Array.isArray(review.findings)) throw new Error("review-findings: expected a parsed review with findings[]");
  // DER-2837 — the count is DERIVED from the findings this event is about to carry, through the same
  // `gateBlockerFindings` every reader uses. It used to be a second inline predicate applied to the
  // UNMAPPED review, which is a drift waiting to happen between two lists that are not the same list:
  // the readers count over `ev.findings`, so that is what the producer must count over. An event whose
  // count disagrees with its own findings is now refused at every read, so a producer that could emit
  // one would be a producer that can brick its own gate.
  const findings = review.findings.map(({ title, priority, confidence, file, line_start, line_end }) => ({ title, priority, confidence, file, line_start, line_end }));
  const blockers = gateBlockerFindings({ findings }).length;
  const ev = {
    actor: actor ?? (issueId ? `lead:${issueId}` : "lead"),
    type: "review_findings",
    role: "reviewer",
    reviewer: reviewer ?? "codex",
    verdict: review.verdict,
    confidence: review.confidence,
    findings_total: review.findings.length,
    blockers,
    findings,
    tokens_total: tokensTotal,
    sha: sha ?? null,
    round,
    ts: new Date().toISOString(),
  };
  if (issueId) ev.issue = issueId;
  return ev;
}

// A codex gate run that died — OOM, expired credentials, a context wall — EXITS 0 and writes no
// final message. Recording that as a review would append a `review_findings` event with 0 findings,
// which IS the shepherd's pre-enqueue evidence check (work-shepherd SKILL.md) — so a dead gate would
// MANUFACTURE the machine-checkable proof that the PR is clean. Strictly worse than not running it,
// because a blind run at least leaves no event. Positive evidence only: an exact producer-controlled
// completed-turn JSON event. Command execution records measure repository-search coverage but are
// not completion provenance. Measured 2026-07-25: two runs died at 5-8 commands with no error, and
// one 401'd before its first turn while `codex login status` still reported "Logged in using ChatGPT".
export function codexRunCompleted(logText) {
  const { turnCompleted, commands } = parseCodexRun(logText);
  return { turnCompleted, commands };
}

// The events this gate CONSUMES, as one predicate. `codexRunCompleted`'s completion rule, the run's
// commands count, and the attestation's identity all read the same set — a second enumeration would
// drift, and the looser copy is always the one that ends up on the receipt.
//
// `thread.started` is retained even though no verdict reads it: it carries the producer's own identity
// for the run, so a replayed log brings it along unchanged and a fresh one cannot borrow it.
function codexRunEvidenceEvent(event) {
  if (event?.type === "turn.completed" || event?.type === "thread.started") return true;
  if (event?.type === "command_execution") return true;
  if (event?.type === "item.completed" && event?.item?.type === "command_execution") return true;
  return false;
}

// Deterministic serialization: keys sorted at every depth, so two encodings of one event hash alike.
// Only used to build a digest — never written anywhere a human reads.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

// One pass over the codex `--json` stream, and the ONE definition of what the gate read out of it.
//
// ── The digest is over the CANONICAL run, not the raw bytes (remediation round 1) ────────────────
// `log_sha256` used to be sha256 over the JSONL TEXT, which made the replay check a claim about a FILE
// rather than about a RUN. Executed by a reviewer: the same log plus ONE BLANK LINE — or plus a JSON
// line of a type the parser skips — hashed differently, missed the prior attestation entirely, and was
// recorded `ran` against a tree and a unit that codex never saw. Padding is free; the identity it
// defeated is the only thing standing between a receipt and a replayed second opinion.
//
// So the identity is derived from the events the gate consumes, re-serialized deterministically:
// whitespace, blank lines, key order and any event outside that set cannot move it, while the run's
// own content (its thread id, its commands, its completion usage) still separates two real runs.
//
// KNOWN LIMIT, stated rather than implied: this resists ADDING content the gate does not read, and any
// re-encoding of the content it does. It cannot resist a hand-edit of the retained events themselves —
// codex signs nothing, so no content hash can. That is why the tree/unit binding below is a SECOND and
// independent control rather than a restatement of this one: defeating the identity still leaves a
// receipt whose `covered_sha` and first-attested unit have to be made to agree with the tree in hand.
//
// The RAW digest is still recorded as `log_sha256_raw` — it is the weaker property (equal bytes imply an
// equal canonical form, never the reverse), kept because attestations written before this change
// recorded it as their identity and must stay findable for exact-byte replays.
//
// Shapes measured against codex-cli 0.144.6 (`codex exec --json`, 2026-08-01) rather than assumed — a
// fixture that invents event names proves only that the parser handles a format codex does not emit:
//   {"type":"thread.started","thread_id":"019fbed0-5d6b-7f42-9219-026ee1a09438"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"OK"}}
//   {"type":"turn.completed","usage":{"input_tokens":25514,"cached_input_tokens":9984,…}}
// `command_execution` arrives as an `item.completed` item type once a run actually searches the repo.
//
// `thread_id` is RECORDED (as `codex_thread_id`, never `run_id` — that name already means the WORK RUN
// throughout this ledger) and deliberately NOT matched on: `codex exec resume` continues an existing
// thread, so two genuinely different runs can share one thread id, and matching would report a real
// fresh run as a replay. It is provenance a human can follow, not a predicate.
export function parseCodexRun(logText) {
  let turnCompleted = false;
  let commands = 0;
  let threadId = null;
  const retained = [];
  for (const line of String(logText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (event.type === "turn.completed") turnCompleted = true;
    if (
      event.type === "command_execution"
      || (event.type === "item.completed" && event.item?.type === "command_execution")
    ) {
      commands += 1;
    }
    if (threadId == null && event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
      threadId = event.thread_id;
    }
    if (codexRunEvidenceEvent(event)) retained.push(stableJson(event));
  }
  // An empty canonical form would hash to one constant for every evidence-free log. It is unreachable
  // from either caller — both refuse before the digest is taken unless `turn.completed` was seen, and
  // that event is itself retained — so `retained` is never empty on anything that gets an identity.
  const canonical = retained.join("\n");
  return {
    turnCompleted,
    commands,
    threadId,
    retained: retained.length,
    digest: createHash("sha256").update(canonical).digest("hex"),
    rawDigest: createHash("sha256").update(String(logText ?? "")).digest("hex"),
  };
}

// ── DER-3011 — the ROUND-1 codex gate ───────────────────────────────────────────────────────────
// DER-2360 dropped `codex exec` out of every brief when the panel became the primary gate. This puts
// it back as the DEFAULT reviewer of the first complete diff. The standing division of labour:
//
//   ROUND 1        `codex exec` is the default gate; the 3-lens Claude panel runs ALONGSIDE it.
//   REVISIONS      the panel alone — it is the backup, and on every later round it is the whole gate.
//   CODEX ABSENT   the panel alone, with the waiver recorded on the receipt. Never a stall.
//
// Why round 1 and not "every round" (which is what DER-2375 did, and what cost the rounds):
//   * OVERLAP ~33% with what the Claude lenses find. A reviewer that agreed would be redundant; one
//     that disagrees two thirds of the time is a genuinely different instrument — which is also why the
//     panel beside it is a real backup rather than a duplicate.
//   * P1 YIELD DECAYS BY ROUND — 53% → 24% → 31% → 11% → 0%. Nearly all of the value is in the first
//     pass over a complete diff; by round 3 a second vendor is paying ~8 minutes to find nothing.
//   * It rides a SEPARATE subscription pool, so it costs no Claude budget and adds zero CI rounds.
//
// Why it can never block: codex availability is BIMODAL. This harness has watched it die for a day and
// a half, sit behind a usage wall, and come back live — all inside one week. A gate that swings like
// that must degrade to a RECORDED WAIVER rather than to a stall, whichever way it happens to be
// pointing on any given day; that is the reasoning behind `waive-codex-gate`, applied one layer down.
// Nothing here should ever be written to assert which way it is pointing NOW — the probe answers that
// at the moment of use, and a hardcoded claim about it is stale the day after it is written.
// The waiver is one flag, and every refusal below names it.
export const CROSS_VENDOR_REVIEWER = "codex";
// The union lens name codex's findings enter under. It is a LENS of the panel's receipt, not a separate
// event — even though on round 1 codex is the DEFAULT reviewer and the panel is the backup. Recording is
// not a ranking: a second event would become `latestGateEvent`, and two blocker counts for one sha with
// nothing saying which `ready` must believe is how an unaddressed P1 ships. One gate, one sha, one count.
export const CROSS_VENDOR_LENS = "codex";
// The last round on which the codex gate is mandatory.
//
// ── 2026-08-12: codex is now the gate on EVERY round, and the 3-lens Claude panel is the FALLBACK ──
// This was `1` (codex on round 1, panel-only afterward). The measurement that flipped it, from the
// 2026-08-10 run's own panel on PR #1293: codex found the panel's ONLY P1 — `projectActionableDecisions`
// filters `actionable === false`, but its sole production caller passes `ApprovalsItem[]`, which carries
// liveness in `status`/`implementationRunLive`, so a DEAD confirmation still counts. All three Claude
// lenses examined that exact function, all three reported the same line, and none reached the production
// item shape. Cost of the leg that found it: 5.4 min on a separate subscription. Cost of the three that
// did not: $17.25 and 36.5 min. Panel redundancy was measured in the same round — 22 findings from 4
// reviewers collapsed to ~10 distinct defects on a `file:line_start` key.
// Codex is free of the Claude weekly quota (it wound the 2026-08-10 run down mid-panel) and cheap enough
// to run every round, which is what makes "every round" affordable where three Opus lenses were not.
export const CROSS_VENDOR_ROUND = 99;
// A waiver reason must NAME something. The floor is the crudest possible check that "n/a", "skip" and
// "-" do not pass — the same shape as FALSIFY_MIN_EVIDENCE, and for the same reason: an unexplained
// waiver is indistinguishable from a forgotten one (`waive-codex-gate` learned this first).
export const CROSS_VENDOR_WAIVER_MIN_REASON = 12;

export const CROSS_VENDOR_HEADING = `⚑ The pre-PR review gate — \`codex exec\` on ${CROSS_VENDOR_MODEL} at ${CROSS_VENDOR_EFFORT} effort`;

// The probe verdict, as a pure function over what the probe printed.
//
// THREE properties, each bought with a measured failure:
//   * STDIN MUST BE CLOSED. Without `< /dev/null` (here: `stdio:["ignore",…]`) `codex exec` sits on
//     "Reading additional input from stdin..." at 0% CPU forever, which reads exactly like a wall.
//   * JUDGE THE TEXT, NEVER THE CPU AND NEVER `codex login status`. `login status` reports "Logged in
//     using ChatGPT" while every call 401s. A real wall SAYS so and names a date.
//   * FAILURE SIGNATURES ARE CHECKED FIRST. `\bOK\b` is a loose marker that an error message can
//     contain ("OK, something went wrong"), so a success test placed first would read a 401 as healthy.
//     Ordering the checks fail-closed costs nothing and removes the whole class.
// NO OUTPUT is `unknown`, never `down`: a probe that could not measure must not become a verdict (2.1).
export function classifyCodexProbe({ output = "", exitCode = null, bin = null, why = null, skipped = [] } = {}) {
  const where = bin ? ` (${bin})${skipped?.length ? ` [skipped shim: ${skipped.join(", ")}]` : ""}` : "";
  if (!bin) {
    return {
      status: "unknown", ok: false,
      detail: `${why ?? "no codex binary resolved"} — UNKNOWN, not "codex is down". A shim's hang is byte-identical to a quota wall, so this is not a measurement.`,
      waiverReason: `codex UNRESOLVABLE on this host: ${why ?? "no binary found"} — no measurement was possible, proceeding panel-only`,
    };
  }
  const text = String(output ?? "");
  if (/\b401\b|invalid_refresh_token|unauthoriz/i.test(text)) {
    return {
      status: "unauthenticated", ok: false,
      detail: `401 — the credential is expired${where}. \`codex login status\` LIES about this; re-login to restore the pass.`,
      waiverReason: `codex credential expired (401 invalid_refresh_token) — probe output: ${text.trim().slice(-160)}`,
    };
  }
  if (/usage limit|rate limit|quota|too many requests/i.test(text)) {
    return {
      status: "walled", ok: false,
      detail: `usage wall${where}: ${text.trim().slice(-160)}`,
      waiverReason: `codex quota wall — probe output: ${text.trim().slice(-160)}`,
    };
  }
  // ── A NONZERO EXIT IS NEVER HEALTHY (remediation round 1) ─────────────────────────────────────
  // The first version spawned without `--json`, so `turn.completed` was unreachable and `\bOK\b`
  // decided success ALONE — over a prompt that is literally "reply OK". A reviewer got HEALTHY for
  // five broken shapes, every one of them exit 1: OK followed by a 500 stream error, OK followed by
  // model-not-found, an error message containing the words "OK button", the 120s SIGKILL path, and
  // plain "OK" at exit 1 (identical to exit 0). The exit code is the cheapest discriminator available
  // and it was being ignored, so it is checked BEFORE either success marker — after the wall/401
  // signatures above, which are real verdicts that also exit nonzero.
  if (exitCode != null && exitCode !== 0) {
    return {
      status: "failed", ok: false,
      detail: `exited ${exitCode}${where}${text.trim() ? `: ${text.trim().slice(-160)}` : " with no diagnostic"}. A nonzero exit is never a healthy probe, whatever the output says — "OK" appears in error text too.`,
      waiverReason: `codex probe exited ${exitCode}${where}: ${text.trim().slice(-160) || "no output"}`,
    };
  }
  // `turn.completed` is the PRODUCER's own completion record and the strongest evidence here — the same
  // event `codexRunCompleted` gates the gate itself on. `\bOK\b` survives only as a secondary marker,
  // and only under a clean exit.
  //
  // The verdict NAMES which of the two decided it. They are not equally good, and an instrument that
  // reports one answer for both cannot tell an operator that `--json` stopped taking effect on their
  // host — at which point the probe would be silently back on the weak marker this remediation removed.
  if (/turn\.completed/.test(text)) {
    return { status: "ok", ok: true, detail: `turn.completed seen${where}`, waiverReason: null };
  }
  if (/\bOK\b/.test(text) && exitCode === 0) {
    return {
      status: "ok", ok: true,
      detail: `exit 0 and the reply contains OK, but NO turn.completed in the stream${where} — weaker evidence than a completed turn; check that this codex build still honours \`--json\``,
      waiverReason: null,
    };
  }
  if (!text.trim()) {
    return {
      status: "unknown", ok: false,
      detail: `NO OUTPUT${where} — UNKNOWN, not a dead gate. A real wall prints a message and a date; a real hang BURNS CPU. ~0% CPU with ~0 bytes is a wall or a broken wrapper, never work in progress. Re-probe by hand with stdin closed before concluding anything.`,
      waiverReason: `codex probe returned NO OUTPUT${where} — unmeasurable, treated as unavailable and proceeding panel-only`,
    };
  }
  return {
    status: "failed", ok: false,
    detail: `${text.trim().slice(-160)}${where}${exitCode == null ? "" : ` (exit ${exitCode})`}`,
    waiverReason: `codex probe failed${where}: ${text.trim().slice(-160)}`,
  };
}

// The prompt the cross-vendor pass runs. Deliberately NOT one of the three lens prompts: codex is ONE
// process against three, so splitting the mandate would hand it a third of the review. It gets the
// union of all three mandates and every path-routed checklist the diff triggers.
//
// The OUTPUT contract differs from the panel's on purpose — codex is invoked with `--output-schema`
// (`codex-review-schema.json`), so it answers in the schema's shape and `parseCodexReview` reads it.
// Describing the shape here anyway is not redundancy: the schema constrains the FIELDS, it says nothing
// about what `priority` MEANS, and a reviewer that grades everything P3 contributes no blockers.
export function panelCrossVendorPrompt({ issueId = null, diffFile = "<diff>", paths = [], acceptance = null, base = "origin/main" } = {}) {
  const routed = pathRoutedChecklists({ paths });
  const lines = [
    `You are the CROSS-VENDOR lens of an adversarial review panel${issueId ? ` on ${issueId}` : ""}.`,
    "Three other lenses — correctness, security/trust-boundary, and does-it-reproduce — are reviewing",
    "this same change independently, on a DIFFERENT vendor's model. Measured overlap between you and",
    "them is about a third, so your value is the two thirds they systematically do not see. Do not try",
    "to guess what they will report; review the change on its own terms and report everything you find.",
    "This is a GATE, not a suggestion.",
    "",
    ...PANEL_LENSES.map((l) => `## ${l.title}\n\n${l.mandate}`),
    "",
    "## The diff SEEDS your search — it does not BOUND it",
    "",
    `The branch diff is at ${diffFile} (\`git diff ${base}...HEAD\`). This is the single most important`,
    "instruction in this prompt: measured 2026-07-25, a diff-local pass ran 2 shell commands and found 0",
    "issues on a PR where a searching pass ran 21 and found 6, including two P1s. So before you finalize:",
    "  - grep EVERY call site, sibling, and consumer of anything the diff changes, and say whether the",
    "    change is complete across all of them — report the CLASS, not the one call site;",
    "  - read the per-package AGENTS.md of every package the diff touches, INCLUDING its",
    '    "## Code Review Rules" section — those are binding for this review;',
    "  - prefer EXECUTING the changed code over reasoning about it: run the touched tests, run the",
    "    changed function directly, and construct the input that would falsify each behavioral claim.",
    "",
    "Do NOT report anything in the root AGENTS.md Code Review Rules' \"Do not flag\" list, and do not",
    "report what a `pnpm check:*` script or guard test already enforces mechanically — both cost a round",
    "without adding signal.",
  ];
  if (routed.length) {
    lines.push(
      "",
      "## Repo-specific checks routed by the paths this diff touches",
      "",
      ...routed.flatMap((c) => [`**${c.id}**`, ...c.bullets.map((b) => `  - ${b}`), ""]),
    );
  }
  if (acceptance && String(acceptance).trim()) {
    lines.push("", "## Acceptance criteria this change must meet", "", String(acceptance).trim());
  }
  lines.push(
    "",
    "## OUTPUT",
    "",
    "Answer in the JSON object the provided output schema defines. `priority` is an INTEGER and it is",
    "the field that decides whether anything happens: 0 = ship-stopping, 1 = blocker (correctness-",
    "breaking, authorization, tenant isolation, secrets, money), 2 = major, 3 = minor. Only priority 0",
    "and 1 block the PR, so do not park a real blocker at 2 to be polite — and do not inflate a nit to 1.",
    "`overall_correctness` is \"patch is incorrect\" if ANY priority-≤1 finding stands. Set",
    "`absolute_file_path` to a real path in this checkout and `line_range` to the lines you actually read.",
    "",
  );
  return lines.join("\n");
}

// The copy-pasteable cross-vendor block for a brief. Same reasoning as `panelReviewCommands`: the shell
// a lead actually pastes is covered by the same tests as the gate it feeds.
//
// `$CODEX` rather than a baked-in path: `codexReviewCommand` resolves the binary on the machine that
// RENDERS the brief, and a brief rendered by the orchestrator is frequently run on another host. A path
// that exists only on the renderer's machine is worse than none — it fails as "command not found",
// which the lead has no reason to read as "wrong host". `codex-probe --print-bin` resolves it where it
// runs, and refuses a shim rather than returning one.
export function crossVendorPassCommands({ issueId = "<ISSUE>", runner = "node scripts/work-runner.mjs", base = "origin/main", schemaFile = "~/.claude/skills/work/codex-review-schema.json" } = {}) {
  const t = (name) => `/tmp/${issueId}-panel-${name}`;
  return [
    `# 0. PROBE FIRST — is codex actually reachable? Judge the TEXT, never the CPU, never \`login status\`.`,
    `#    \`codex-probe\` runs the stdin-closed form; WITHOUT closed stdin codex hangs at 0% CPU on`,
    `#    "Reading additional input from stdin...", which is byte-identical to a quota wall.`,
    `${runner} codex-probe --issue ${issueId}      # exit 0 = reachable; nonzero PRINTS the waiver reason to paste`,
    ``,
    `# 1. Resolve the binary ON THIS HOST (never a bare \`codex\`: a cmux shim ahead of it on PATH hangs`,
    `#    indistinguishably from a wall) and render the prompt. The SEARCH MANDATE is the load-bearing`,
    `#    part — 2 commands/0 findings diff-local vs 21 commands/6 findings with it.`,
    `CODEX="$(${runner} codex-probe --print-bin)"`,
    `${runner} panel-prompt --issue ${issueId} --lens ${CROSS_VENDOR_LENS} --diff ${t("diff")} > ${t("codex.md")}`,
    ``,
    `# 2. Run it — plain \`codex exec\`, NEVER \`codex exec review --base\` (that form is diff-local and`,
    `#    REFUSES a custom prompt). Prompt on STDIN; stdout is PURE JSONL; stderr is a SEPARATE file`,
    `#    (mixing diagnostics into the JSONL destroys the completion evidence \`review-panel\` reads).`,
    `#    Run it from the WORKTREE: without node_modules it cannot execute anything and goes blind.`,
    codexReviewCommand({
      bin: '"$CODEX"',
      schemaFile,
      promptFile: t("codex.md"),
      outFile: t("codex.json"),
      logFile: t("codex.jsonl"),
      errorFile: t("codex.stderr.log"),
    }),
    ``,
    `# 3. It is recorded by step 3 of the panel block — \`--codex-review ${t("codex.json")}\``,
    `#    \`--codex-log ${t("codex.jsonl")}\`. Its findings join the panel UNION (lens \`${CROSS_VENDOR_LENS}\`), so a`,
    `#    codex P1 is a panel blocker and \`ready\` holds until it is fixed or falsified. There is no`,
    `#    separate command and no second event to remember.`,
    `#`,
    `# WALLED / 401 / unresolvable? Do NOT stall and do NOT skip the receipt. Paste the probe's own`,
    `# waiver line instead:  --codex-waived "<probe output>"  — the panel stands alone, the waiver is on`,
    `# the receipt, and \`ready\` prints it so the shepherd can audit that this PR got one reviewer, not two.`,
  ].join("\n");
}

// The attestation stamped on the panel receipt: did the round-1 cross-vendor pass RUN, or was it WAIVED?
//
// This is the whole audit surface for scope 3. It is a pure function so every refusal is unit-testable,
// and it is deliberately the ONLY producer of the field — `ready`, the board and the shepherd all read
// what it wrote rather than re-deriving it from flags nobody else can see.
//
// The must-fail control it exists for: `--codex-review` WITHOUT `--codex-log`. Findings with no JSONL
// are not provenance. A codex run that dies — OOM, expired credential, a context wall — EXITS 0 and
// writes no final message, so a receipt could otherwise claim a cross-vendor pass that never happened,
// and claim it in the one direction nobody audits (a clean second opinion). `codexRunCompleted` is the
// same function `review-usage` gates on; this shares it rather than re-implementing the predicate,
// because two copies of one rule drift and the looser copy is always the one on the receipt.
//
// ── The artifacts are bound to a TREE and a UNIT (remediation round 1, DER-3011) ─────────────────
// The first version recorded only `log: <path>`, which made the attestation a claim about a FILENAME.
// A reviewer replayed ONE codex run's artifacts through the real CLI and was accepted at a different
// sha AND under a different issue, both printing "CODEX RAN". A path is not evidence: `/tmp/X.jsonl`
// is whatever was last written there.
//
// So the attestation now carries `covered_sha` (the tree the receipt is for) and `log_sha256` (the
// content of the JSONL that proved the run). Re-attesting the SAME digest against a different sha, or
// under a different unit, records `status: "stale"` naming the tree it actually covered — never "ran".
// The findings still enter the union: a finding from an older tree usually still applies, and dropping
// them would REMOVE blockers, which is the one direction that ships a defect. What changes is the
// claim on the receipt, because "codex reviewed this tree" and "codex reviewed an older tree" are
// different sentences and only one of them was true.
export function crossVendorAttestation({
  round = 1, sha = null, logPath = null, logText = null, findings = null, waivedReason = null,
  priorEvents = [], issueId = null, now = null, requireAttestation = true,
} = {}) {
  const r = Number.isFinite(Number(round)) && Number(round) > 0 ? Number(round) : 1;
  const ts = (now instanceof Date ? now : new Date()).toISOString();
  const bad = (refusal) => ({ ok: false, refusal, attestation: null });
  const claimsRan = logPath != null || findings != null;
  const reason = typeof waivedReason === "string" ? waivedReason.trim() : "";
  const claimsWaived = reason !== "";
  const coveredSha = typeof sha === "string" && sha.trim() ? sha.trim() : null;

  if (claimsRan && claimsWaived) {
    return bad(
      "review-panel: --codex-waived was given ALONGSIDE --codex-review/--codex-log. A cross-vendor pass either ran or it did not; " +
      "recording both would put a waiver and its own refutation on one receipt. Drop the waiver if it ran.",
    );
  }
  if (claimsRan) {
    if (!logPath) {
      return bad(
        "review-panel: --codex-review without --codex-log. Findings are not provenance — a codex run that dies EXITS 0 and writes no " +
        "final message, so a payload alone cannot distinguish `it reviewed and found nothing` from `it never ran`, and the second " +
        "reads as a clean second opinion. Pass the JSONL (`--json ... > review.jsonl`), or record the waiver with --codex-waived.",
      );
    }
    if (!findings) {
      return bad(
        "review-panel: --codex-log without --codex-review. A completed run whose findings are not recorded contributes nothing to the " +
        "union, so the receipt would attest a review whose result no reader can see. Pass the `--output-last-message` JSON too.",
      );
    }
    const run = parseCodexRun(logText ?? "");
    const { turnCompleted, commands } = run;
    if (!turnCompleted) {
      return bad(
        `review-panel: the codex JSONL has no exact producer turn.completed event (command_execution=${commands}). ` +
        "A gate that dies exits 0, so recording this would attest a cross-vendor pass that never completed. Re-run it, or waive it with " +
        "--codex-waived. Common causes: expired credentials (`codex login status` LIES — read the SEPARATE stderr log for 401 " +
        "invalid_refresh_token), a bare checkout with no node_modules, or the run being killed under memory pressure.",
      );
    }
    const list = Array.isArray(findings) ? findings : [];
    const digest = run.digest;
    // Searched across EVERY unit, not just this one: the reviewer's replay crossed issues as well as
    // shas, and a digest scoped to the unit it is being replayed INTO can never see that.
    const prior = priorAttestationByDigest(priorEvents, { digest, rawDigest: run.rawDigest });
    // ── The first-attested TREE and UNIT are properties of the EVIDENCE, not of the receipt ────────
    // Both were previously re-derived from whatever the freshest matching record happened to carry,
    // and a `stale` record carries its own enclosing receipt's issue — so the identity walked. The
    // reviewer executed it: a log that ran for DER-A@SHA1, was marked stale for DER-B@SHA2, was then
    // accepted as `ran` for DER-B@SHA1. Nothing in that chain re-ran codex; the intermediate stale
    // event alone rewrote which unit the evidence belonged to, and the third receipt read as a clean
    // first-party pass. So each record now CARRIES the first attestation's identity forward
    // explicitly, and every later record reads it from the prior record rather than from itself.
    //
    // `priorAttestationByDigest` is the ONE place that resolves the evidence's identity out of a record
    // — including the upgrade path for records written before this change. Re-deriving any of it here
    // as well would mean two definitions of one fact, and would make neither individually testable: a
    // mutation of either would be masked by the other while the behaviour stayed correct by accident.
    const firstIssue = prior ? prior.issue : (issueId ?? null);
    const firstRound = prior ? prior.first_attested_round : r;
    // `covered_sha` is non-null on every attestation the CLI can record — `review-panel` runs
    // `gateShaRefusal(o.sha, { required: true })` before reaching here — so this comparison is live in
    // production rather than quietly disabled by a null.
    const firstSha = prior ? (prior.covered_sha ?? null) : coveredSha;
    const movedTree = Boolean(firstSha && coveredSha && firstSha !== coveredSha);
    // An UNRESOLVED unit is not a matching one. `firstIssue !== issueId` on a null reads as "no move",
    // so an identity nobody can name would otherwise pass the check by being absent from it — the
    // permissive answer, on the one input where less is known than usual.
    const movedUnit = Boolean(prior?.unit_unresolved)
      || Boolean(firstIssue && issueId && firstIssue !== issueId);
    const common = {
      reviewer: CROSS_VENDOR_REVIEWER, round: r, log: logPath, log_sha256: digest,
      // The weaker, byte-exact identity this field used to hold alone. Recorded so a pre-remediation
      // attestation stays findable, and so an auditor can see the log was not merely re-encoded.
      // NOT `run_id`: that name already means the WORK RUN throughout this ledger, and two meanings for
      // one key is a misreading waiting to happen. This is codex's own thread identifier.
      log_sha256_raw: run.rawDigest, codex_thread_id: run.threadId ?? null,
      commands, findings_total: list.length, blockers: gateBlockerFindings({ findings: list }).length, ts,
    };
    if (prior && (movedTree || movedUnit)) {
      return {
        ok: true, refusal: null,
        attestation: {
          ...common, status: "stale",
          // `covered_sha` stays the tree codex REALLY looked at, so a chain of replays cannot walk it
          // forward one receipt at a time; `receipt_sha` is the tree this receipt is about.
          covered_sha: firstSha,
          receipt_sha: coveredSha,
          first_attested_round: firstRound,
          first_attested_issue: firstIssue,
        },
      };
    }
    return {
      ok: true, refusal: null,
      attestation: {
        ...common, status: "ran", covered_sha: coveredSha,
        // Stamped on the FIRST record too. Leaving it off is what forced the lookup to fall back to the
        // enclosing receipt in the first place, and a fallback is only ever as trustworthy as the least
        // trustworthy record it can land on.
        first_attested_round: firstRound, first_attested_issue: firstIssue,
      },
    };
  }
  if (claimsWaived) {
    if (reason.length < CROSS_VENDOR_WAIVER_MIN_REASON) {
      return bad(
        `review-panel: --codex-waived ${JSON.stringify(reason)} is ${reason.length} characters. An unexplained waiver is indistinguishable ` +
        `from a forgotten one, so it must NAME what happened — paste the probe's own output (\`codex-probe\` prints a ready-made line). ` +
        `${CROSS_VENDOR_WAIVER_MIN_REASON} characters is the crudest possible check that a reason was actually given.`,
      );
    }
    return { ok: true, refusal: null, attestation: { reviewer: CROSS_VENDOR_REVIEWER, status: "waived", round: r, reason, covered_sha: coveredSha, ts } };
  }
  // No flags. Carry this unit's earlier answer forward so `ready` — which reads only the LATEST gate
  // event — can still say whether codex ever looked. Re-deriving it at read time would mean every
  // reader walks the ledger, and the readers that do not would each invent their own answer.
  //
  // This runs BEFORE the round-1 refusal on purpose. A pre-PR fix loop re-runs the PANEL at a new head
  // while still on round 1, and refusing that would leave a lead two bad options: re-submit the stale
  // codex artifacts (a false "RAN" on a tree codex never saw) or waive a gate that actually ran. It
  // inherits instead — and if the inherited run covered a DIFFERENT tree than this receipt, what is
  // carried forward is `stale`, never `ran`.
  const prior = latestCrossVendorAttestation(priorEvents, issueId);
  if (prior) {
    const priorSha = prior.covered_sha ?? null;
    const movedTree = Boolean(prior.status === "ran" && priorSha && coveredSha && priorSha !== coveredSha);
    return {
      ok: true, refusal: null,
      attestation: {
        reviewer: CROSS_VENDOR_REVIEWER, status: "inherited", round: r,
        from_round: prior.round ?? null,
        inherited_status: movedTree ? "stale" : (prior.status ?? null),
        reason: prior.reason ?? null,
        covered_sha: priorSha, receipt_sha: coveredSha, ts,
      },
    };
  }
  // Round 1 gets the "you never ran it" message; a revision round gets the sharper "nothing has EVER
  // attested this unit" one below. The selector is `r <= 1`, NOT `r <= CROSS_VENDOR_ROUND`: since
  // CROSS_VENDOR_ROUND became 99 (codex on every round) that comparison is true for every reachable
  // round, which would have made the revision-round branch dead code and silently deleted the more
  // informative refusal. A message that can never be emitted is the documentation equivalent of a
  // check that cannot fail.
  if (requireAttestation && r <= 1) {
    return bad(
      `review-panel: round ${r} — the \`codex exec\` gate is THE reviewer on every round (2026-08-12), and this receipt attests neither a run nor a waiver. ` +
      "Pass BOTH --codex-review <out.json> and --codex-log <run.jsonl>, or --codex-waived \"<why not>\". " +
      "Run `codex-probe` first: it prints the ready-to-paste waiver line whenever codex is walled, 401'd or unresolvable. " +
      "Recording a PANEL at all implies codex was unavailable — so the waiver is the expected companion to this command, not an exception. " +
      "What is refused here is a receipt that is SILENT about whether codex ever looked.",
    );
  }
  if (requireAttestation) {
    // A REVISION round with nothing to inherit. Silence here used to record `status: "none"` and pass,
    // which made "the codex gate was skipped for this whole unit" indistinguishable from "the harness
    // had nothing to say" — and it was reachable by simply recording round 2 first. Refusing turns a
    // silent skip into a recorded choice. It still never blocks: the waiver is one flag away.
    return bad(
      `review-panel: round ${r} is a revision round, and NOTHING has ever attested the codex gate for ${issueId ?? "this unit"} — ` +
      "so there is no round-1 answer to carry forward. Record the choice rather than leaving the receipt silent: `--codex-waived \"<why codex never ran on this unit>\"`, " +
      "or run the gate now and pass --codex-review + --codex-log. (`codex-probe` prints the waiver line.)",
    );
  }
  return {
    ok: true, refusal: null,
    attestation: {
      reviewer: CROSS_VENDOR_REVIEWER, status: "none", round: r, covered_sha: coveredSha, ts,
      note: "no codex gate was ever recorded for this unit — round 1 either predates DER-3011 or was recorded as a later round",
    },
  };
}

// The freshest attestation for a given LOG DIGEST, across every unit in the run. Deliberately NOT
// filtered by issue: the replay this closes crossed units as well as trees, and a lookup scoped to the
// unit being replayed INTO is structurally unable to see that. Returns the attestation with its own
// issue attached, so the caller can say which unit really ran it.
export function priorAttestationByDigest(events = [], digest = null) {
  // Accepts the canonical digest alone (the historical signature, still used by tests) or
  // `{ digest, rawDigest }`. The raw form is checked only against records whose identity WAS the raw
  // digest — pre-remediation attestations. It can never widen the match wrongly: equal bytes imply an
  // equal canonical form, so anything the raw comparison finds the canonical one would have found had
  // the record been written after the change.
  const canonical = typeof digest === "string" ? digest : (digest?.digest ?? null);
  const raw = typeof digest === "string" ? null : (digest?.rawDigest ?? null);
  if (!canonical && !raw) return null;
  let latest = null;
  let origin = null;
  for (const e of events ?? []) {
    if (e?.type !== "review_findings") continue;
    const xv = e.cross_vendor;
    if (!xv || typeof xv !== "object") continue;
    const hit = (canonical && xv.log_sha256 === canonical)
      || (raw && xv.log_sha256_raw === undefined && xv.log_sha256 === raw);
    if (!hit) continue;
    if (xv.status !== "ran" && xv.status !== "stale") continue;
    // The ORIGIN is the FIRST `ran` for this digest, and only a `ran` may be one. Two reasons it is the
    // first rather than the freshest: identity is fixed at the first attestation by definition, and a
    // ledger written by the pre-remediation code can already CONTAIN a laundered `ran` — reading the
    // freshest would adopt that record's stolen unit as the truth it is being compared against.
    if (xv.status === "ran" && !origin) origin = { xv, receiptIssue: e.issue ?? null };
    latest = { xv, receiptIssue: e.issue ?? null };
  }
  if (!latest) return null;
  // The evidence's OWN identity, resolved here and ONLY here.
  //
  // The enclosing receipt (`e.issue`) is consulted for a `ran` record and NEVER for a `stale` one. That
  // asymmetry is the whole fix: a `ran` receipt names the unit that really ran it, so it is a correct
  // last-resort reading for a pre-remediation record that recorded no `first_attested_issue`. A `stale`
  // receipt names the unit the evidence was replayed INTO — reading it was how a legacy chain
  // (RAN for DER-A, then STALE enclosed by DER-B) handed a later replay at DER-B a first-party `ran`.
  const src = origin ?? latest;
  const issue = origin
    ? (origin.xv.first_attested_issue ?? origin.xv.issue ?? origin.receiptIssue ?? null)
    : (latest.xv.first_attested_issue ?? latest.xv.issue ?? null);
  return {
    ...latest.xv,
    issue,
    // A `stale`-only match with no recorded first-attested unit leaves the identity GENUINELY unknown —
    // and an unknown unit compared with `!==` matches everything, i.e. silently disables the check. The
    // caller fails closed on this instead: the evidence has been seen before under a unit nobody can
    // name, and "this is a fresh first-party pass" is the one reading that is certainly wrong.
    unit_unresolved: issue == null,
    first_attested_round: src.xv.first_attested_round ?? (origin ? origin.xv.round : null) ?? null,
    covered_sha: src.xv.covered_sha ?? latest.xv.covered_sha ?? null,
  };
}

// The freshest attestation that actually asserts something (`ran` / `waived`), walking the ledger in
// order. `inherited` and `none` are skipped deliberately: inheriting an inheritance would let the
// original round number and waiver reason decay to null a round at a time, and the point of carrying it
// forward is that the ORIGINAL answer stays legible on the last receipt.
export function latestCrossVendorAttestation(events = [], issueId = null) {
  let out = null;
  for (const e of events ?? []) {
    if (e?.type !== "review_findings") continue;
    if (issueId && e.issue !== issueId) continue;
    const xv = e.cross_vendor;
    if (!xv || typeof xv !== "object") continue;
    // `stale` asserts something too — codex ran, on a tree that is no longer this one — so it is
    // inheritable. Leaving it out would make a stale run indistinguishable from no run at all on the
    // next receipt, which is the direction that over-claims.
    if (xv.status === "ran" || xv.status === "waived" || xv.status === "stale") out = xv;
  }
  return out;
}

// One line for `ready`, the board and `review-panel`'s own stdout. Kept in one place because these are
// three readers of one fact, and a fact rendered three ways is a fact that will be described three ways.
export function crossVendorLabel(xv = null) {
  if (!xv || typeof xv !== "object") {
    // Deliberately not "predates DER-3011": a receipt can lack the field for more than one reason, and a
    // label that names a cause it cannot know is the same class of confident-wrong answer this whole
    // attestation exists to remove. It states what is true — nothing attested one — and nothing more.
    return "xvendor=UNRECORDED (this receipt carries no cross-vendor attestation)";
  }
  const who = String(xv.reviewer ?? CROSS_VENDOR_REVIEWER).toUpperCase();
  const at = (s) => (typeof s === "string" && s ? s.slice(0, 10) : "?");
  switch (xv.status) {
    case "ran":
      return `xvendor=${who} RAN (round ${xv.round ?? "?"}, ${xv.findings_total ?? 0} finding(s), ${xv.blockers ?? 0} blocker(s), ${xv.commands ?? 0} repo command(s))`;
    // STALE says the quiet part out loud: codex ran, but on a tree this receipt is not about. It reads
    // as NOT-covered rather than as a weaker RAN, because the whole failure it closes was a replayed
    // run rendering identically to a fresh one.
    case "stale":
      return `xvendor=${who} STALE — this run covered ${at(xv.covered_sha)}${xv.first_attested_issue ? ` (unit ${xv.first_attested_issue})` : ""}, NOT this tree (${at(xv.receipt_sha)}); re-run codex or carry it forward as stale`;
    case "waived":
      return `xvendor=${who} WAIVED at round ${xv.round ?? "?"} — ${xv.reason ?? "no reason recorded"}`;
    case "inherited": {
      if (String(xv.inherited_status) === "stale") {
        return `xvendor=${who} STALE (carried forward from round ${xv.from_round ?? "?"}; that run covered ${at(xv.covered_sha)}, not this tree)`;
      }
      // An inherited WAIVED must be as informative as the direct waived render above — "no reason
      // recorded" is itself information, and dropping it only on the inherited path made the carried
      // copy quieter than the thing it carried.
      const tail = String(xv.inherited_status) === "waived"
        ? ` — ${xv.reason ?? "no reason recorded"}`
        : xv.reason ? ` — ${xv.reason}` : "";
      return `xvendor=${who} ${String(xv.inherited_status ?? "?").toUpperCase()} at round ${xv.from_round ?? "?"} (carried forward${tail})`;
    }
    default:
      return `xvendor=NONE — no codex gate recorded for this unit`;
  }
}

// ── Fidelity scoring (DER-2375) ─────────────────────────────────────────────────────────────────
// The point of the whole gate is an empirical question we could not answer from one sample: how much
// of what the CLOUD bot posts does the LOCAL pass catch first? Measured both ways during the design —
// ~33% loose overlap on a blind 4-PR replay, but 3-of-4 pre-empted on PR #1027 with the diff's own
// context. Those disagree by 2x, so the gate ships with its own scorer instead of a claim.
// Matching is deliberately generous and transparent: same file + line windows that overlap or sit
// within `slack` lines. Both raw lists are recorded so a better scorer can re-score history.
// --- `ready` gate helpers (H5, promoted from the run-dir ready.sh) ----------------------------
// A CLEAN Codex verdict is an ISSUE COMMENT carrying `Reviewed commit: <ABBREVIATED sha>` and leaves
// NO review row — so codex-on-head must read BOTH surfaces, author-filtered, and compare by PREFIX
// (the abbreviated form is shorter than the 40-char head). A reviews-only probe returns STALE exactly
// when the PR is clean, failing in the merge-BLOCKING direction; an unfiltered probe reads ON-HEAD
// whenever the LEAD reviewed the head while Codex is behind — both silent. (Fixes 5 + 7, 2026-07-26.)
export function codexCommentSha(body = "") {
  const m = String(body).match(/reviewed commit:[^0-9a-f]*([0-9a-f]{7,40})/i);
  return m ? m[1] : null;
}
export function codexOnHead({ head = "", reviewSha = null, commentSha = null } = {}) {
  if (!head) return false;
  if (reviewSha && head.startsWith(reviewSha)) return true;
  if (commentSha && head.startsWith(commentSha)) return true;
  return false;
}
// Parse the checks probe ONCE and answer from the captured result (fix 3: three separate calls
// observed three CI states and printed an arithmetically impossible shard count).
//
// DER-2774 — `gh pr checks` is a TRI-STATE instrument and the pre-fix parser collapsed three
// different worlds onto one answer. It read the human TSV, looked for a row literally NAMED `checks`
// (the single required context on the repo this harness grew up on), and returned `checks: null` when
// it found none. `null` therefore meant, simultaneously: the probe died, the repo has no CI at all,
// and — on ANY repo whose required job is not called `checks` — the CI is RED. This repo is the third
// case: its jobs are `tests (node 20|22|24)`, `static checks`, `public-comment security regression`.
// Measured on PR #2 of this repo, a genuinely red tree: every row parsed, no row named `checks`,
// result `checks: null`. Paired with `repo.allowMergeWithoutChecks: true` — the loosening the SHIPPED
// example config hands adopters alongside `"mergeMode": "direct"` — `readyVerdict` waived that null
// and `ready` printed the merge go-ahead on red.
//
// Ground truth for `gh pr checks --json`, measured against gh 2.76.2 and 2.86.0. The exit-code lore
// from the human TSV mode does NOT carry over: TSV exits 1 on a failing check, `--json` exits 0,
// because the JSON exporter writes and returns before the exit-code logic runs.
//   - any checks exist        → exit 0 + a JSON array on stdout. Failing AND pending both exit 0.
//   - zero checks on the branch → exit 1, EMPTY stdout, stderr `no checks reported on the '<b>' branch`
//   - anything else (auth, 404, throttle, SIGKILL timeout, gh missing) → exit ≠ 0, other/empty stderr
// So exit 0 is never itself read as "pass" (the buckets decide), and a nonzero exit is ABSENT only
// when gh said exactly that. Everything else is UNKNOWN — and UNKNOWN is never waivable.
//
// The exact zero-checks sentence, recorded verbatim from gh 2.76.2 and 2.86.0 against PR #1 of this
// repo. Pinned so a future gh rewording is a deliberate edit here rather than a silent absent→unknown
// reclassification, which would dead-end every no-CI adopter and regress DER-2753. Its LIMIT, stated
// rather than implied: this pins OUR matcher against a RECORDED sample — nothing here re-invokes gh,
// so a wording change surfaces the next time someone runs the probe, not from CI.
export const GH_NO_CHECKS_SAMPLE_STDERR = "no checks reported on the 'wh/der-2743-installer' branch\n";
// The matcher is DERIVED from that sample's invariant prefix — everything before the branch name —
// so the constant is load-bearing rather than a fixture sitting beside a hand-written duplicate: edit
// the sentence and production changes with it. Deliberately does NOT include the branch clause, so a
// gh change to how the branch is quoted cannot turn ABSENT into UNKNOWN. If the ` on the ` marker ever
// disappears the derived matcher becomes the whole sentence, i.e. STRICTER — it fails closed (more
// reads become UNKNOWN and block), never open. It also does not match gh's sibling `--required`
// message ("no REQUIRED checks reported"), which `ready` never triggers and which would mean
// something different if it did. The prefix is regex-ESCAPED before compiling, so editing the sample
// can never throw at import time (which would take the whole harness down over a docs change) — it
// is always matched as a literal substring.
const GH_NO_CHECKS_RE = new RegExp(
  GH_NO_CHECKS_SAMPLE_STDERR.split(" on the ")[0].trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "i",
);
// gh's own bucket vocabulary. `cancel` counts as failing: a cancelled check did not pass, and the
// `ready` caller already resolves the run's real status into the note (`← CANCELLED, NOT a failure`),
// so the operator gets the distinction without the gate opening. A bucket string gh grows later that
// is not in this set reads UNKNOWN rather than being silently ignored on the way to "pass".
const CHECK_BUCKETS_FAILING = new Set(["fail", "cancel"]);
const CHECK_BUCKETS_KNOWN = new Set(["pass", "fail", "pending", "skipping", "cancel"]);
const firstStderrLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

export function parseChecksOutput({ exitCode, stdout = "", stderr = "" } = {}) {
  const base = { checks: "unknown", shardsPass: 0, shardsTotal: 0, firstFailUrl: null, checksNote: null };
  if (exitCode !== 0) {
    if (GH_NO_CHECKS_RE.test(String(stderr ?? ""))) {
      return { ...base, checks: "absent", checksNote: "gh reports no checks at all on this branch" };
    }
    return { ...base, checksNote: `gh pr checks exited ${exitCode ?? "?"}: ${firstStderrLine(stderr) || "no stderr"}` };
  }
  let rows;
  try {
    rows = JSON.parse(String(stdout ?? ""));
  } catch {
    // Includes the pre-DER-2774 TSV capture: refuse it loudly instead of half-reading it.
    return { ...base, checksNote: "gh pr checks --json emitted output that is not JSON (probe called without --json?)" };
  }
  if (!Array.isArray(rows)) return { ...base, checksNote: "gh pr checks --json did not emit an array" };
  const shardRows = rows.filter((c) => /^db-suite \(\d+\)/.test(String(c?.name ?? "")));
  const out = {
    ...base,
    shardsPass: shardRows.filter((c) => c?.bucket === "pass").length,
    shardsTotal: shardRows.length,
    firstFailUrl: rows.find((c) => CHECK_BUCKETS_FAILING.has(String(c?.bucket ?? "")))?.link ?? null,
  };
  // gh errors out before the exporter when a branch has zero checks, so an empty array should be
  // unreachable — but if a future gh returns one, exit 0 means gh ANSWERED, and its answer is "none".
  // Reading that as UNKNOWN instead would permanently dead-end the no-CI adopters DER-2753 exists for.
  if (!rows.length) return { ...out, checks: "absent", checksNote: "gh pr checks --json returned an empty check list" };
  const buckets = rows.map((c) => String(c?.bucket ?? ""));
  if (buckets.some((b) => CHECK_BUCKETS_FAILING.has(b))) {
    const cancelled = buckets.filter((b) => b === "cancel").length;
    return { ...out, checks: "fail", checksNote: cancelled ? `${cancelled} cancelled check(s) counted as failing` : null };
  }
  const strange = [...new Set(buckets.filter((b) => !CHECK_BUCKETS_KNOWN.has(b)))];
  if (strange.length) {
    return { ...out, checks: "unknown", checksNote: `gh returned unrecognised check bucket(s): ${strange.join(", ")}` };
  }
  if (buckets.includes("pending")) return { ...out, checks: "pending" };
  const skipped = buckets.filter((b) => b === "skipping").length;
  return { ...out, checks: "pass", checksNote: skipped ? `${skipped} check(s) skipped (path-gated)` : null };
}
// The gate verdict, pure (control-tested): enqueueable ONLY when every input is the PASSING answer —
// an UNKNOWN thread count (throttled null) is never 0 (fix 6).
// DER-2588 / DER-2585 / DER-2551 / DER-2559 are ONE defect, named by ORCH#9 on 2026-07-27: the harness
// reads an artifact the lead emits MID-FLIGHT as though it described the SHIPPED state. The convention
// that fixes all four is *evidence must NAME the head it covers, and the consumer must compare against
// that head*. `review-usage --sha` already stamps it; this is the consumer that reads it.
//
// The pre-enqueue gate used to verify only that a `review_findings` event EXISTED. That check is
// unsatisfiable-as-intended, because leads gate BEFORE their final commits — so the last recorded round
// is systematically not the one that ships. DER-2513 shipped two commits past a gate event that still
// read `blockers: 1`; the blocker was genuinely fixed at head, but nothing in the harness could tell
// that from the case where it was not.
//
// Precision matters here, or this becomes noise everyone learns to wave past:
//   - gate sha == head, blockers == 0     → CURRENT. The evidence describes what ships, and it is clean.
//   - gate sha == head, blockers > 0      → CURRENT-DIRTY. BLOCK (DER-2782, below).
//   - gate sha == head, blockers > 0,
//     with a matching gate_adjudication   → ADJUDICATED. Do not block — and say so LOUDLY.
//   - gate sha != head, blockers == 0     → STALE-CLEAN. Report it; do not block. The clean verdict
//                                            can only have been invalidated by the new commits, which
//                                            the cloud bot reviews on head anyway.
//   - gate sha != head, blockers > 0      → STALE-DIRTY. BLOCK. The only record of this PR's local gate
//                                            says it had open blockers, and no evidence covers the tree
//                                            that would merge. This is exactly DER-2513's shape.
//   - blockers != the event's own count
//     of priority-≤1 findings             → INCONSISTENT. BLOCK (DER-2837, gateBlockerCountVerdict) —
//                                            and checked BEFORE every branch above, because an
//                                            under-count reads clean on all three passing ones.
//   - no gate event at all                → MISSING. BLOCK (DER-2603, below).
//
// DER-2782 — CURRENT used to mean `blocks: false` on `sha === head` with NO blockers check at all; the
// `blockers > 0` branch was reachable only down the STALE path. So the gate that shipped enforced
// "evidence must cover head" and not "the findings must be dealt with", while the shepherd's SKILL.md
// promised "unresolved blockers = automatic kickback" in prose that nothing executed.
//
// That is not merely a missing check — it inverted the incentive the gate exists to create. FIXING
// findings pushes commits, which moves the sha off head, which turns the gate STALE-DIRTY and BLOCKS.
// IGNORING them leaves sha == head, which read CURRENT and PASSED. The lead who ignored its own
// reviewer got the STRONGER gate state, and the only way to be punished by this instrument was to do
// the right thing. (The fix does not remove that asymmetry by loosening STALE-DIRTY: the correct
// sequence is fix → re-run the gate at the new head → CURRENT with blockers 0.)
//
// The "or reject it in writing" escape hatch is real — some P1s genuinely are wrong — so it survives as
// a MACHINE-READABLE event rather than a paragraph in a PR body that nothing parses. See
// gateAdjudicationVerdict for the contract and for why the control is audit surfacing, not enforcement.
//
// DER-2603 (three PRs in one shift, #1081 MERGED): ABSENT used to be `blocks: false` — "report; the cloud
// bot is the gate of record". That made the ONE documented pre-enqueue check unable to return the failing
// answer, so `ready` printed the go-ahead word on PRs nothing established had ever been locally reviewed.
// Both the shepherd and the orchestrator read that instrument and both acted on it, which is why this is a
// harness defect rather than either role's mistake. A missing gate now BLOCKS, in BOTH merge modes — a
// direct merge that skipped the gate is strictly worse than an enqueue that did, since no queue catches it.
//
// UNKNOWN vs ABSENT is the distinction that keeps this gate switched on. "You skipped it" and "I could not
// tell" both fail closed, but they oblige the operator to do DIFFERENT things (run the gate vs. make the
// evidence readable), and a gate that cannot say which one it means is a gate operators learn to wave past.
// `unknown` carries the reason; see gateEvidenceLookup for the four cases that produce it.
// 1.4 — the verdict carries PROVENANCE on every branch, not just a pass/block.
//
// `gate_seen` was a boolean, so state could not express "gated by a substitute" at all. With posture C
// now a first-class path, the difference between a codex run and a 3-lens Claude panel is exactly what a
// reader needs six hours later — and attributing one to the other is not hypothetical: shepherd #5 had
// to correct the record because the #1183 3-lens gate was shepherd #4's work, and that error had already
// propagated into a run report and a learnings entry before anyone caught it.
//
// Wrapped rather than threaded through each of the nine returns below: every branch gets the same
// provenance by construction, so a future branch cannot forget to carry it.
export function gateProvenance(gate) {
  if (!gate) return { substitute: false, gate_kind: null, engine: null, model: null, lenses: null, lenses_requested: null, sha: null, reviewer: null, cross_vendor: null };
  return {
    // DER-3011 — WHETHER A SECOND VENDOR EVER LOOKED is provenance, in the same sense `substitute` is:
    // a panel that ran alone and a panel that ran beside a codex pass are different evidence, and the
    // waiver reason is the only place the difference is explained.
    cross_vendor: gate.cross_vendor ?? null,
    substitute: gate.substitute === true,
    // DER-2360 — `panel` (the primary gate), `codex`, or whatever a producer stamped. Derived only when
    // absent, and never guessed from `substitute`: a reader that infers "not a substitute ⇒ codex" would
    // relabel every panel receipt as a bot review, which is the exact misattribution 1.4 was written for.
    gate_kind: gate.gate_kind ?? (Array.isArray(gate.lenses) && gate.lenses.length ? (gate.substitute === true ? "substitute" : "panel") : null),
    engine: gate.engine ?? null,
    model: gate.model ?? null,
    lenses: Array.isArray(gate.lenses) ? gate.lenses : null,
    lenses_requested: Array.isArray(gate.lenses_requested) ? gate.lenses_requested : null,
    sha: gate.sha ?? null,
    reviewer: gate.reviewer ?? null,
  };
}

export function gateEvidenceVerdict(args = {}) {
  return { ...gateEvidenceVerdictCore(args), ...gateProvenance(args.gate) };
}

// ── DER-2360 — which verdict states mean "the gate looked at THIS tree" ─────────────────────────
// The three states below are exactly the ones `gateEvidenceVerdictCore` reaches after establishing
// `sha === head`. Deriving the answer from the STATE rather than re-comparing shas is deliberate:
// `readyVerdict` is a pure function that never receives `head`, and threading it in just to redo a
// comparison the verdict already made is how the two copies drift apart (the SQL-mirrors-a-validator
// defect class, in JavaScript). `unstamped` and `stale-clean` are absent on purpose — an unstamped
// receipt covers no tree at all, and a stale-clean one covers a tree that is no longer shipping.
export const GATE_STATES_AT_HEAD = new Set(["current", "current-dirty", "adjudicated"]);

export function gateCoversHead(gate = null) {
  return GATE_STATES_AT_HEAD.has(gate?.state);
}

function gateEvidenceVerdictCore({ head, gate, adjudication = null, adjudicationRejected = null, unknown = null } = {}) {
  if (unknown) return { state: "unknown", blocks: true, label: `gate=UNKNOWN (${unknown})` };
  if (!gate) {
    return {
      state: "absent",
      blocks: true,
      label: "gate=MISSING (no review_findings event — the pre-PR review gate never ran for this PR)",
    };
  }
  const sha = gate.sha ?? null;
  const count = gateBlockerCountVerdict(gate);
  const blockers = count.recorded ?? 0;
  // DER-2782 — an UNREADABLE count is not a zero count. `blockers > 0` is false for NaN, so a corrupt or
  // hand-written event carrying `blockers: "two"` used to read as a clean gate down every branch below.
  // That is the same fail-open shape as UNKNOWN-vs-ABSENT above, and it gets the same answer: block, and
  // say which of the two it is. `reviewFindingsEvent` always writes a number, so this can only fire on
  // evidence nothing in this harness produced — which is exactly when trusting it is worst.
  if (count.kind === "unreadable") {
    return { state: "unreadable", blocks: true, label: `gate=UNREADABLE (${count.reason} — re-run the gate)` };
  }
  // DER-2837 — a READABLE count that contradicts the event's own findings is not evidence either, and it
  // is checked HERE, ahead of every branch below, because three of those branches return `blocks: false`.
  // `unstamped` and `stale-clean` both pass on a zero count, so a check placed after the sha comparison
  // would leave two more doors open on the same lie. Measured at c477ee9: the same under-counted event
  // read `current` on head, `stale-clean` off head, and `unstamped` with no sha — three passes.
  if (!count.ok) {
    return {
      state: "inconsistent",
      blocks: true,
      label: `gate=INCONSISTENT (the review_findings event ${count.reason}) — its own count ${count.kind === "under" ? "UNDER" : "OVER"}-reports its own findings, so it is not evidence; re-run the gate`,
    };
  }
  if (!sha) return { state: "unstamped", blocks: false, label: "gate=UNSTAMPED (older review-usage — re-run to stamp a sha)" };
  if (head && sha === head) {
    if (blockers > 0) {
      // The waiver clears the block only for the tree it NAMES. An adjudication carried over from an
      // earlier round describes findings on a tree that is no longer shipping — the same reasoning that
      // makes STALE-DIRTY block, applied to the waiver instead of the review.
      if (adjudication && adjudication.sha === sha) {
        const waived = Array.isArray(adjudication.findings) ? adjudication.findings.length : 0;
        // An adjudication is vetted upstream (gateEvidenceLookup / the materializeState fold), so these
        // fields are normally present. Rendered defensively anyway: a waiver whose author is unreadable
        // must still PRINT — reading it as a plain pass is the silent-pass failure this closes.
        const by = String(adjudication.adjudicated_by ?? "").trim() || "UNNAMED";
        const why = String(adjudication.rationale ?? "").trim();
        return {
          state: "adjudicated",
          blocks: false,
          label: `⚠ gate=ADJUDICATED (${waived} finding${waived === 1 ? "" : "s"} waived by ${by} at ${sha.slice(0, 10)}${why ? ` — "${why}"` : ""})`,
        };
      }
      // A REJECTED waiver is named in the label. Otherwise the operator who just recorded one sees the
      // gate still blocking with no way to tell whether it was ignored, mis-typed, or never arrived.
      const tail = adjudicationRejected ? ` [a gate_adjudication was recorded and IGNORED: ${adjudicationRejected}]` : "";
      return {
        state: "current-dirty",
        blocks: true,
        label: `gate=CURRENT (${sha.slice(0, 10)}) with ${blockers} OPEN blocker(s) — fix them and re-run the gate, or have the ORCHESTRATOR record a gate_adjudication naming every one${tail}`,
      };
    }
    return { state: "current", blocks: false, label: `gate=CURRENT (${sha.slice(0, 10)}, blockers=${blockers})` };
  }
  if (blockers > 0) {
    return { state: "stale-dirty", blocks: true, label: `gate=STALE with ${blockers} open blocker(s) at ${sha.slice(0, 10)} ≠ head` };
  }
  return { state: "stale-clean", blocks: false, label: `gate=stale-clean (${sha.slice(0, 10)} ≠ head, blockers=0)` };
}

// Latest `review_findings` for an issue, in ledger order. Pure.
export function latestGateEvent(events, issueId) {
  let out = null;
  for (const e of events ?? []) {
    if (e?.type !== "review_findings") continue;
    if (issueId && e.issue !== issueId) continue;
    out = e;
  }
  return out;
}

// ── 2.4 — a gate sha must be 40 chars, enforced at WRITE time ───────────────────────────────────
// Measured on #1180 across three recordings / 95s: a 9-char and a 10-char sha both read `stale-clean`;
// only the full 40 reads `CURRENT`. Today that fails SAFE — a short sha under-claims coverage — but a
// blocker-carrying gate recorded short would block on FALSE STALENESS, and an operator chasing a
// phantom stale gate is how a real one gets waved through. Enforce at every producer.
// `required` is FALSE for `review-usage` and true for `review-swap`, deliberately.
//
// An ABSENT sha is a pre-existing, separately-tracked shape: it folds to `gate=UNSTAMPED`, which older
// ledgers rely on and which `review-usage` produces legitimately when `git rev-parse HEAD` cannot run
// (a bare checkout, a non-git cwd). Making absence fatal here would retroactively refuse those, which is
// scope this item did not ask for — 2.4 is about a sha that is PRESENT but TRUNCATED, because that is
// the form that reads `stale-clean` while looking like real coverage. `review-swap` is a new command
// with no legacy to protect, so it requires the full sha outright.
export const GATE_SHA_LENGTH = 40;
export function gateShaRefusal(sha, { command = "review-usage", required = false } = {}) {
  const s = String(sha ?? "");
  if (!s) {
    return required
      ? `${command}: --sha is required — a gate event with no sha covers no tree, and every reader treats it as UNSTAMPED, which does NOT block.`
      : null;
  }
  if (!/^[0-9a-f]{40}$/i.test(s)) {
    return `${command}: --sha must be the full 40-char commit sha, got ${JSON.stringify(s)} (${s.length} chars). ` +
      "An abbreviated sha reads as `stale-clean` at every gate check — measured on #1180 — so a blocker-carrying " +
      "gate recorded short would block on FALSE staleness. Use `git rev-parse HEAD` or the PR's headRefOid.";
  }
  return null;
}

// ── 1.1 — `review-swap`: the substitute gate as a supported command ─────────────────────────────
// THREE review postures exist, not two:
//   A. normal            — codex bot on the PR + local `codex exec`
//   B. cloud down        — local `codex exec` only
//   C. BOTH down         — a local adversarial Claude panel        ← whenever the codex probe says so
//
// Posture C had zero harness support. `review-usage` REFUSES a findings-shaped payload without a codex
// JSONL carrying `turn.completed` — correctly, because a gate that dies exits 0 and recording it would
// manufacture 0-finding "proof" of a clean PR. But that refusal also meant the substitute gate could not
// be recorded through ANY supported path, so shepherd #4 hand-rolled it, shepherd #5 inherited it as
// undocumented tribal knowledge, and the ledger carried no first-class record of how #1183 was gated.
//
// So: a separate command with its OWN fail-closed rules, rather than a loosening of codex's.
//
// It fails closed in the same shape codex does, for the same reason. A silent lens is INCOMPLETE, never
// clean — and `lenses_requested` vs `lenses_returned` are both recorded so a 1-of-3 gate is *visible as*
// 1-of-3 and can never render as a full swap.
export const REVIEW_SWAP_MIN_LENSES = 2;

// The distinct-lens requirement is not bureaucracy. On #1183 the *repro* lens REFUTED the *security*
// lens — security had called a `size_bytes` branch redundant with the checksum, and repro proved it was
// not — and was right. Three redundant reviewers would have concurred and deleted live code.
export const REVIEW_SWAP_SUGGESTED_LENSES = ["correctness", "security", "repro"];

// Parse + validate the panel's verdicts. Pure, so every refusal is unit-testable.
// Shape: { "<lens>": { verdict: "clean"|"findings"|"INCOMPLETE"|…, findings: [...], summary } }
export function parseLensVerdicts({ raw = null, lensesRequested = [] } = {}) {
  const requested = [...new Set(lensesRequested.filter(Boolean))];
  const fail = (refusal) => ({ ok: false, refusal, requested, returned: [], missing: [], empty: [], findings: [], verdictPerLens: {} });
  if (!requested.length) return fail("review-swap: name the lenses with --lens (repeatable). An unnamed panel cannot be audited for redundancy, and redundant reviewers concur — on #1183 the repro lens refuted the security lens and was right.");
  if (requested.length < REVIEW_SWAP_MIN_LENSES) {
    return fail(`review-swap: ${requested.length} lens requested; a substitute gate needs at least ${REVIEW_SWAP_MIN_LENSES} DISTINCT lenses (suggested: ${REVIEW_SWAP_SUGGESTED_LENSES.join(", ")}).`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("review-swap: --verdicts must be a JSON object keyed by lens name.");

  const verdictPerLens = {};
  const returned = [];
  const missing = [];
  const empty = [];
  const findings = [];
  for (const lens of requested) {
    const entry = raw[lens];
    if (entry == null) { missing.push(lens); continue; }
    // A lens that returned nothing usable is INCOMPLETE, never clean. This is the whole point: a
    // reviewer that goes silent is indistinguishable from one that found nothing, and two of three
    // reviewers DID go silent twice on 2026-07-31 before delivering in full on an explicit ultimatum.
    const verdict = typeof entry === "string" ? entry : entry.verdict;
    if (verdict == null || String(verdict).trim() === "") { empty.push(lens); continue; }
    const lensFindings = Array.isArray(entry?.findings) ? entry.findings : [];
    verdictPerLens[lens] = {
      verdict: String(verdict).trim(),
      findings: lensFindings.length,
      summary: typeof entry?.summary === "string" ? entry.summary : null,
    };
    returned.push(lens);
    for (const f of lensFindings) {
      findings.push({
        title: f?.title ?? null, priority: f?.priority ?? null, confidence: f?.confidence ?? null,
        file: f?.file ?? null, line_start: f?.line_start ?? null, line_end: f?.line_end ?? null,
        lens,
      });
    }
  }
  if (missing.length || empty.length) {
    const parts = [];
    if (missing.length) parts.push(`no entry for ${missing.join(", ")}`);
    if (empty.length) parts.push(`no verdict from ${empty.join(", ")}`);
    return {
      ok: false, requested, returned, missing, empty, findings: [], verdictPerLens,
      refusal: `review-swap: REFUSING to record — ${parts.join("; ")}. A silent lens is INCOMPLETE, never clean. ` +
        `Recording ${returned.length}/${requested.length} as a full swap is exactly the 0-finding-reads-as-CLEAN failure ` +
        "the codex gate's own refusal exists to prevent. Send the lens its ultimatum (\"findings or INCOMPLETE\") and re-record; " +
        "a silent subagent is usually alive and truncating, not dead — prefer the ultimatum to a respawn.",
    };
  }
  if (returned.length < REVIEW_SWAP_MIN_LENSES) {
    return { ok: false, requested, returned, missing, empty, findings: [], verdictPerLens,
      refusal: `review-swap: only ${returned.length} lens returned; at least ${REVIEW_SWAP_MIN_LENSES} are required.` };
  }
  return { ok: true, refusal: null, requested, returned, missing, empty, findings, verdictPerLens };
}

// The ONE event a substitute gate writes. Same `review_findings` type every reader already understands
// — so `ready`, the gate-evidence lookup and the blocker-count check all apply unchanged — plus
// first-class provenance so a substitute can never be mistaken for a codex run.
export function reviewSwapEvent({ issueId, pr = null, sha, engine = "claude", model = null, lenses = null, substituteReason = null, round = 1, actor = "shepherd" } = {}) {
  if (!lenses?.ok) throw new Error("reviewSwapEvent: refusing to build an event from an invalid lens panel");
  const blockers = gateBlockerFindings({ findings: lenses.findings }).length;
  const ev = {
    actor, type: "review_findings", role: "reviewer",
    reviewer: `${engine}${model ? `:${model}` : ""}`,
    engine, model,
    substitute: true,
    substitute_reason: substituteReason ?? null,
    lenses: lenses.returned,
    lenses_requested: lenses.requested,
    lenses_returned: lenses.returned,
    verdict_per_lens: lenses.verdictPerLens,
    // A panel is "clean" only if every lens came back with no blocker. Derived, never asserted.
    verdict: blockers > 0 ? "blockers" : "clean",
    confidence: null,
    findings_total: lenses.findings.length,
    blockers,
    findings: lenses.findings,
    tokens_total: null,
    sha,
    pr: pr == null ? null : Number(pr),
    round,
    // DER-3011 — a substitute IS posture C: it is recorded precisely because codex could not review.
    // Stamping the waiver here rather than leaving the field null keeps `ready`'s line true (a fresh
    // substitute is not an unattested receipt, it is an explicitly codex-less one) and keeps this event
    // from reading as "nobody thought about the cross-vendor pass".
    // The REASON is whatever the recorder gave, and NOTHING when they gave nothing. The default this
    // used to synthesize ("codex was unavailable as both a bot and a local `codex exec`") is a factual
    // claim about the world that no step here measured — manufactured evidence, propagated onto the
    // final receipt and rendered as though someone had established it. `crossVendorLabel` already
    // prints "no reason recorded" for null, which is the true sentence.
    cross_vendor: {
      reviewer: CROSS_VENDOR_REVIEWER, status: "waived", round,
      reason: substituteReason ?? null,
      ts: new Date().toISOString(),
    },
    ts: new Date().toISOString(),
  };
  if (issueId) ev.issue = issueId;
  return ev;
}

// ── 1.3 — a run-level codex waiver that lives in STATE, not in prose ────────────────────────────
// `ready` prints `hold (codex not on head)` forever when codex is dead. On 2026-07-31 the waiver
// existed ONLY as ledger prose, so every single `ready` call required a human to remember it, and the
// successor orchestrator had to be *told*. That is not a waiver, it is a rumour.
//
// The two properties that make this safe:
//   * `--until` is REQUIRED, so it expires by construction. An indefinite waiver is how a run silently
//     stops reviewing.
//   * IT DOES NOT WAIVE EVIDENCE. With a waiver active, `ready` still blocks unless a `review_findings`
//     event — codex OR substitute — covers the head. It converts "must be codex" into "must be SOME
//     recorded adversarial review", never into "no review".
export function codexWaiverFrom(events = [], { now = null } = {}) {
  let latest = null;
  for (const e of events ?? []) if (e?.type === "codex_gate_waived") latest = e;
  if (!latest) return { active: false, reason: null, until: null, expired: false, waived_at: null };
  const nowMs = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Date.parse(now));
  const untilMs = Date.parse(latest.until ?? "");
  // An unparseable `--until` is treated as EXPIRED, not as forever. Fail closed: the failure mode of the
  // other choice is a waiver that never ends because its expiry was a typo.
  const expired = !Number.isFinite(untilMs) || untilMs <= nowMs;
  return {
    active: !expired,
    expired,
    reason: latest.reason ?? null,
    until: latest.until ?? null,
    waived_at: latest.ts ?? null,
    why: expired
      ? `codex waiver EXPIRED at ${latest.until ?? "an unparseable timestamp"} — re-issue it with waive-codex-gate --until <iso8601> or restore the codex gate`
      : `codex gate WAIVED until ${latest.until} — ${latest.reason ?? "no reason recorded"}`,
  };
}

// ── Gate adjudication (DER-2782) ────────────────────────────────────────────────────────────────
// The written-rejection escape hatch, as an event the harness can read:
//   { type: "gate_adjudication", issue, sha, findings: [...], rationale, adjudicated_by }
//
// AUTHORITY, stated plainly because the alternative is pretending. This rides `append`, which anyone
// with filesystem access to the run dir can run — INCLUDING the lead whose blockers are being waived.
// There is no hard enforcement available at that trust boundary (an actor who can write events.jsonl
// never needed a subcommand), so the control is AUDIT SURFACING: only the orchestrator or the human
// operator may adjudicate, a lead adjudicating its own gate is a kickback offense, and every waiver is
// printed — at `append`, on the `ready` line, on the board (`state.gate_adjudicated`) and on every
// `watch` wake. Trading "ignoring findings wins" for "self-adjudicating wins" would be no fix at all;
// what makes this different from the prose it replaces is that a waiver can no longer be INVISIBLE.
export const GATE_ADJUDICATION_AUTHORITY =
  "AUTHORITY: only the ORCHESTRATOR or the human operator may record a gate_adjudication. A lead that adjudicates its own gate is a kickback offense.";

// A gate finding is a BLOCKER at priority ≤ 1 — the same predicate `reviewFindingsEvent` DERIVES its
// `blockers` count from (DER-2837 made that literally true; it used to be a second inline predicate that
// merely agreed), kept in one place so the count and the list cannot drift apart.
export function gateBlockerFindings(gate) {
  const findings = Array.isArray(gate?.findings) ? gate.findings : [];
  return findings.filter((f) => f?.priority != null && Number(f.priority) <= 1);
}

// ── DER-2837: is a gate event's `blockers` count TRUE? ──────────────────────────────────────────
// DER-2782 made a recorded `blockers > 0` block. It never asked whether the recorded number described
// the event's own findings list, and the one place that did ask — `gateAdjudicationVerdict` — compared
// `recorded > actual`, catching only an OVER-count. So a `review_findings` event carrying a live P1
// while recording `blockers: 0` read `{state:"current", blocks:false}`: MERGEABLE, with the blocker
// attached to the very event that authorized the merge.
//
// The two directions are not symmetric, and that is the whole reason this is a P1:
//   - OVER-count → holds work that should ship. Loud, self-correcting, and someone chases it.
//   - UNDER-count → ships an open blocker, and is INDISTINGUISHABLE from a clean gate. Nobody chases it.
// A one-directional check is therefore the wrong shape even where the wrong direction is harmless: it is
// the shape that lets the harmful direction through. The rule is EQUALITY, checked at every read and
// enforced at every write.
//
// This does NOT require the event to be forged. Two predicates over the same findings (which is what
// shipped: `reviewFindingsEvent` counted over the unmapped review, every reader counted over the mapped
// event) drift on their own, and a hand-written or relayed event has no producer at all.
//
// UNREADABLE is kept distinct from INCONSISTENT on purpose — the same UNKNOWN-vs-ABSENT distinction the
// gate verdict already draws. "Your count is not a number" and "your count contradicts your own findings"
// are both fail-closed, but they oblige the operator to look at different things.
//
// The count must be a NUMBER, not a numeric string: `"0"` is not 0. `reviewFindingsEvent` writes a real
// number and JSON round-trips it as one, so a string count can only come from something that hand-built
// the event — exactly when guessing at its intent is worst. An ABSENT count is still the legacy zero (a
// pre-`findings` ledger records nothing to contradict, and blocking those would strand every old run).
export function gateBlockerCountVerdict(gate = null) {
  const raw = gate?.blockers ?? null;
  const actual = gateBlockerFindings(gate).length;
  const unreadable = (reason) => ({ ok: false, kind: "unreadable", recorded: null, actual, reason });
  if (raw !== null && typeof raw !== "number") return unreadable(`the review_findings event's blockers field is ${JSON.stringify(raw)}, not a count`);
  const recorded = raw ?? 0;
  if (!Number.isInteger(recorded) || recorded < 0) return unreadable(`the review_findings event's blockers field is ${JSON.stringify(raw)}, not a count`);
  if (recorded !== actual) {
    return {
      ok: false,
      kind: recorded < actual ? "under" : "over",
      recorded,
      actual,
      reason: `records ${recorded} blocker(s) but its findings list holds ${actual} at priority ≤ 1`,
    };
  }
  return { ok: true, kind: null, recorded, actual, reason: null };
}

// Findings carry no id — `reviewFindingsEvent` records {title, priority, confidence, file, line_start,
// line_end} — so a reference resolves against what the adjudicator actually has in front of them: the
// 1-based position `review-usage` prints, or the finding's exact title. Returns the 0-based index, or
// -1 for anything that does not resolve. Pure.
export function resolveGateFindingRef(ref, findings = []) {
  const list = Array.isArray(findings) ? findings : [];
  if (typeof ref === "number") return Number.isInteger(ref) && ref >= 1 && ref <= list.length ? ref - 1 : -1;
  if (typeof ref !== "string") return -1; // an object/array ref is not a reference; fail closed
  const raw = ref.trim();
  if (!raw) return -1;
  const m = raw.match(/^#?(\d+)$/);
  if (m) {
    const i = Number(m[1]) - 1;
    return i >= 0 && i < list.length ? i : -1;
  }
  const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const want = norm(raw);
  return want ? list.findIndex((f) => norm(f?.title) === want) : -1;
}

// Is this adjudication one the harness may honour? Pure, and the SINGLE definition of the contract:
// `append` calls it to refuse a malformed one at WRITE time (so the operator learns immediately rather
// than watching `ready` keep blocking with no explanation), and `gateEvidenceLookup` + the
// `materializeState` fold both call it at READ time. The read is the enforcement — an adjudication that
// reached the ledger some other way (a hand-edited file, a relay) is still ignored here.
//
// Every clause closes a way to turn a waiver into a blanket pass. Returns `{ ok, reason }`, and the
// reason is surfaced rather than swallowed: an adjudication that is silently dropped is only marginally
// better than one that silently passes.
//   - it must NAME THE TREE, and that tree must be the one the gate evidence covers.
//   - it must NAME A HUMAN. `adjudicated_by` is the entire audit trail.
//   - it must give a REASON. "Waived", unexplained, is indistinguishable from ignoring the gate.
//   - `findings` must be NON-EMPTY and every entry must resolve to a finding on that gate event — an
//     adjudication that references nothing is a blanket waiver, which is the hole, not the feature.
//   - it must cover EVERY open blocker. This is the easiest clause to leave out, because a partial
//     waiver still looks like a deliberate act: waiving 1 of 2 blockers would clear the whole gate.
//   - the gate event must be SELF-CONSISTENT (its findings list must hold EXACTLY as many priority-≤1
//     entries as its `blockers` count claims), or the coverage check above is checking nothing. DER-2837
//     made that clause an equality: as `>` it caught only an over-count, and an UNDER-counted event —
//     the one that authorizes a merge over an open blocker — was waivable.
export function gateAdjudicationVerdict({ gate = null, adjudication = null } = {}) {
  const bad = (reason) => ({ ok: false, reason, waived: [], sha: null, by: null, rationale: null });
  if (!adjudication) return { ok: false, reason: null, waived: [], sha: null, by: null, rationale: null };
  if (!gate) return bad("there is no review_findings event for this unit — run the gate first; there is nothing to adjudicate");
  const gateSha = gate.sha ?? null;
  if (!gateSha) return bad("the gate event carries no `sha` (an older `review-usage`) — re-run the gate so the evidence names the tree it covers");
  const sha = String(adjudication.sha ?? "").trim();
  if (!sha) return bad("no `sha` — an adjudication must name the tree whose findings it waives");
  if (sha !== gateSha) return bad(`it covers ${sha.slice(0, 10)} and the gate evidence covers ${gateSha.slice(0, 10)} — re-run the gate on the current head, then adjudicate what THAT finds`);
  const by = String(adjudication.adjudicated_by ?? "").trim();
  if (!by) return bad("no `adjudicated_by` — an unattributed waiver is not an audit trail");
  const rationale = String(adjudication.rationale ?? "").trim();
  if (!rationale) return bad("no `rationale` — a waiver with no stated reason is indistinguishable from ignoring the gate");
  const refs = Array.isArray(adjudication.findings) ? adjudication.findings : null;
  if (!refs || !refs.length) return bad("`findings` is empty — name each finding you are waiving; a blanket waiver is exactly the hole this event exists to close");
  const findings = Array.isArray(gate.findings) ? gate.findings : [];
  const blockers = gateBlockerFindings(gate);
  // DER-2837 — EQUALITY, not `recorded > blockers.length`. The original clause caught only an over-count,
  // so an event recording 0 blockers while carrying 2 could be "waived" by a waiver naming only what the
  // count admitted to — and the coverage clause below was then checking references against a list the
  // count itself disagreed with.
  const count = gateBlockerCountVerdict(gate);
  if (!count.ok) {
    const what = count.kind === "unreadable" ? count.reason : `the gate event ${count.reason}`;
    return bad(`${what} — that evidence is inconsistent with itself, so nothing can be verifiably waived; re-run the gate`);
  }
  const resolved = [];
  const unresolved = [];
  for (const r of refs) {
    const i = resolveGateFindingRef(r, findings);
    if (i < 0) unresolved.push(typeof r === "string" || typeof r === "number" ? String(r) : JSON.stringify(r));
    else resolved.push(i);
  }
  if (unresolved.length) {
    return bad(`it names ${unresolved.length} finding(s) that are not on the gate event (${unresolved.slice(0, 3).join(", ")}) — reference each by its 1-based index or its exact title`);
  }
  const covered = new Set(resolved);
  const missed = blockers.map((f) => findings.indexOf(f)).filter((i) => !covered.has(i));
  if (missed.length) {
    const named = missed.slice(0, 3).map((i) => `#${i + 1} ${findings[i]?.title ?? ""}`.trim()).join("; ");
    return bad(`it leaves ${missed.length} of ${blockers.length} open blocker(s) un-named (${named}) — a partial waiver is not a clean gate`);
  }
  return {
    ok: true,
    reason: null,
    sha: gateSha,
    by,
    rationale,
    waived: [...covered].sort((a, b) => a - b).map((i) => findings[i]?.title || `#${i + 1}`),
  };
}

// Latest `gate_adjudication` for an issue, in ledger order — preferring one that names `sha`, so an
// out-of-order or superseded append cannot mask the waiver that actually covers this round. Pure, and
// carrying `latestGateEvent`'s issue filter for the same reason: an adjudication belongs to ONE unit
// and must never be attributed to a sibling's gate.
export function latestGateAdjudication(events, issueId, { sha = null } = {}) {
  let latest = null;
  let matching = null;
  for (const e of events ?? []) {
    if (e?.type !== "gate_adjudication") continue;
    if (issueId && e.issue !== issueId) continue;
    latest = e;
    if (sha && e.sha === sha) matching = e;
  }
  return matching ?? latest;
}

// DER-2603 — what the ledger LETS US SAY about one PR's pre-PR gate, separated from what the gate said.
// Pure. Returns `{ gate, unknown }`: `unknown` non-null means the evidence is unreadable, NOT absent.
//
// The four unknown cases, each a real read this instrument can hit at 3am:
//   1. no ledger was read at all — `ready` invoked without `--run`; there is nothing to attribute.
//   2. the PR maps to no issue in this run's state. This one was also a live BUG: the caller passed the
//      un-mapped `undefined` straight to latestGateEvent, whose `if (issueId && …)` filter then MATCHES
//      EVERY ISSUE — so an untracked PR could read `gate=CURRENT` off a SIBLING's evidence and enqueue.
//   3. the ledger predates the DER-2748 version stamp: with no `harness_version` on `run_started` we
//      cannot tell "the lead skipped the gate" from "this run's runner never recorded gates at all".
//   4. no `run_started` at all — a partial fold; the same reasoning as 3.
// Anything else with no `review_findings` for the issue is genuinely ABSENT: the run COULD have recorded
// one, this unit is tracked, and it did not. That is "you skipped it", and it is a different sentence.
//
// DER-2782 — it also reads the unit's `gate_adjudication`, VETTED here rather than by the caller. That
// is deliberate: `ready`'s single production call site spreads this result straight into
// gateEvidenceVerdict, so the waiver and the review it waives are read by ONE function and cannot be
// threaded apart. A candidate that fails the contract comes back as `adjudicationRejected` (a reason
// the verdict prints) and never as `adjudication`.
export function gateEvidenceLookup({ events = null, issueId = null, ledgerRead = true } = {}) {
  const none = { gate: null, adjudication: null, adjudicationRejected: null };
  if (!ledgerRead) {
    return { ...none, unknown: "`ready` ran without --run <id> — no ledger to attribute gate evidence from" };
  }
  const evs = Array.isArray(events) ? events : [];
  if (!issueId) {
    return { ...none, unknown: "PR not tracked by this run's ledger — no unit owns it, so no unit's gate evidence may be attributed to it" };
  }
  const gate = latestGateEvent(evs, issueId);
  if (gate) {
    const candidate = latestGateAdjudication(evs, issueId, { sha: gate.sha ?? null });
    const adj = gateAdjudicationVerdict({ gate, adjudication: candidate });
    return { gate, adjudication: adj.ok ? candidate : null, adjudicationRejected: adj.reason, unknown: null };
  }
  const runStarted = evs.find((e) => e?.type === "run_started") ?? null;
  if (!runStarted) {
    return { ...none, unknown: `no run_started in this ledger — whether the run could record a gate for ${issueId} is unreadable` };
  }
  if (!runStarted.harness_version) {
    return { ...none, unknown: "pre-stamp ledger (no harness_version on run_started) — a missing gate event is indistinguishable from a runner that never recorded one" };
  }
  return { ...none, unknown: null }; // genuinely ABSENT — the run could have recorded one and did not
}

// DER-2753 `allowMergeWithoutChecks`: a PUBLIC adopter repo often has NO required checks at all, so
// `gh pr checks` reports nothing, and this verdict never passes — which in direct-merge mode means
// the shepherd can never merge anything. The opt-in loosens EXACTLY one case and nothing else.
//
// DER-2774 — that "one case" was not the case it tested for. The waiver keyed on `checks == null`,
// and `parseChecksOutput` returned null for a DEAD PROBE and for a RED CI on any repo without a job
// named `checks`, as well as for a genuinely check-free repo. So on most adopter repos the loosening
// an owner enabled to mean "I have no CI" silently also meant "ignore CI". The waiver now keys on the
// VERIFIED-ABSENT answer — gh answered, and its answer was "no checks" — so `fail`, `pending` and
// `unknown` all still block with the flag on. UNKNOWN vs ABSENT is the same distinction the gate
// evidence above already draws, for the same reason: "there is nothing to wait for" and "I could not
// tell" oblige the operator to do different things, and a gate that cannot say which one it means is
// a gate operators learn to wave past. Default false — the loosening is the adopter's explicit,
// written decision, and the verdict names it so it stays auditable in the run log.
function checksHold(checks, allowMergeWithoutChecks) {
  if (checks === "absent") {
    return "checks=ABSENT (gh reports no checks on this branch — set repo.allowMergeWithoutChecks:true only if this repo genuinely has no CI)";
  }
  if (checks === "unknown" || checks == null || checks === "") {
    const tail = allowMergeWithoutChecks === true
      ? " — allowMergeWithoutChecks waives a VERIFIED-ABSENT check surface, never an unreadable probe"
      : "";
    return `checks=UNKNOWN (the checks probe could not be read${tail})`;
  }
  return `checks=${checks}`;
}
export function readyVerdict({ draft, threads, onHead, checks, shardsPass, shardsTotal, gate, allowMergeWithoutChecks = false, codexWaiver = null } = {}) {
  if (draft !== false) return { ready: false, why: "draft" };
  if (threads !== 0) return { ready: false, why: threads == null || Number.isNaN(threads) ? "threads UNKNOWN (throttled — never treat as 0)" : `${threads} unresolved thread(s)` };
  // 1.3 — a waiver clears THIS hold and nothing else. When codex is dead the bot will never post on any
  // head, so this hold can never clear on its own and the run stalls on a condition no action satisfies.
  // The waiver converts "must be codex" into "must be some recorded adversarial review": the `gate`
  // check below is untouched and still refuses without a review_findings event covering the head, so a
  // waived run reviews exactly as hard — it just stops requiring that the reviewer be codex.
  //
  // DER-2360 — a RECEIPT AT HEAD clears it too, and this is now the ordinary path rather than the
  // exception. The bot's per-PR auto-review was switched off on 2026-08-01, so `onHead` (which asks
  // whether a codex COMMENT sits on the current head) is false on essentially every PR and stays false
  // no matter what anyone does. That is the same shape as the codex-is-dead stall this hold already
  // learned about, arriving through a different door: a condition no action satisfies is not a gate,
  // it is a wedge, and an operator who meets one learns to route around the instrument that printed it.
  //
  // What replaces it is strictly narrower than a waiver, not looser: the local panel must have reviewed
  // THIS EXACT TREE. A receipt one commit behind head does NOT clear it — `gateCoversHead` is false for
  // `stale-clean`, so the ordinary "fix findings, push, forget to re-run" sequence still holds here, and
  // holds with the specific reason rather than this generic one. `current-dirty` is included so the
  // block below can name the open blockers instead of this line blaming an absent bot for them.
  if (!onHead && !codexWaiver?.active && !gateCoversHead(gate)) {
    return {
      ready: false,
      why: gate?.sha
        ? `no review covering head (the recorded gate is at ${String(gate.sha).slice(0, 10)}, not this PR's head — re-run the adversarial panel on the current tree)`
        : "no review covering head (no codex review on this head, and no adversarial-panel receipt for this tree — run the panel, or record one with `review-panel`)",
    };
  }
  const checksWaived = checks === "absent" && allowMergeWithoutChecks === true;
  if (checks !== "pass" && !checksWaived) return { ready: false, why: checksHold(checks, allowMergeWithoutChecks) };
  if (shardsTotal > 0 && shardsPass !== shardsTotal) return { ready: false, why: `db shards ${shardsPass}/${shardsTotal}` };
  if (shardsPass > shardsTotal) return { ready: false, why: "INCONSISTENT shard read — re-run" };
  // DER-2603 — a caller that never COMPUTED a gate verdict must not pass either. `gate` was optional, so
  // omitting it was indistinguishable from a passing gate, and that is the same class of hole as reading a
  // throttled thread count as 0. `ready` computes this from the ledger via gateEvidenceLookup.
  if (!gate) return { ready: false, why: "gate UNKNOWN (no pre-PR review evidence was read for this PR — `ready` derives it from the run ledger; pass --run <id>)" };
  if (gate.blocks) return { ready: false, why: gate.label };
  // The gate PASSED. Say how it was gated, rather than printing an undifferentiated "all gates pass" —
  // a substitute panel and a codex run are not the same evidence, and a reader six hours later (or a
  // successor orchestrator) must be able to tell which one authorized the merge without re-reading the
  // ledger by hand. This is the line that used to be an unclearable `hold (codex not on head)`.
  const notes = [];
  if (checksWaived) notes.push("checks ABSENT — WAIVED by repo.allowMergeWithoutChecks");
  if (!onHead && codexWaiver?.active) {
    notes.push(`gate=WAIVED (${codexWaiver.reason ?? "no reason recorded"}, expires ${codexWaiver.until})`);
  }
  // DER-2360 — a PANEL and a SUBSTITUTE are different claims and the line must not conflate them. A
  // substitute stood in for a codex run that could not happen; a panel IS the gate of record. Both are
  // lens-shaped, so keying the label on `substitute` rather than on the presence of lenses is what keeps
  // "the bot was down" from being printed over a run where the bot was simply not the reviewer.
  if (Array.isArray(gate.lenses) && gate.lenses.length) {
    const kind = gate.substitute ? "SUBSTITUTE" : "PANEL";
    notes.push(`gate=${kind} (${gate.engine ?? "?"}${gate.model ? `/${gate.model}` : ""}` +
      `, ${gate.lenses.length} lens${gate.lenses.length === 1 ? "" : "es"}: ${gate.lenses.join("/")}` +
      `${gate.sha ? `, sha ${String(gate.sha).slice(0, 9)}` : ""})`);
  } else if (gate.substitute) {
    notes.push(`gate=SUBSTITUTE (${gate.engine ?? "?"}${gate.model ? `/${gate.model}` : ""}${gate.sha ? `, sha ${String(gate.sha).slice(0, 9)}` : ""})`);
  }
  // DER-3011 — the round-1 codex gate is REPORTED here and never gated on. Codex availability swings
  // (dead for a day and a half, walled, then live again, all inside one week), so a hold on it would be
  // a condition no action satisfies whenever it happens to be down — the same wedge the codex-on-head
  // hold above already became. What the receipt owes a reader is an ANSWER (ran / waived-with-a-reason
  // / never recorded), not a veto.
  // Printed on every lens-shaped gate, including the legacy case, because an absent field silently
  // reading as "fine" is the failure this whole attestation exists to close.
  if (Array.isArray(gate.lenses) && gate.lenses.length) notes.push(crossVendorLabel(gate.cross_vendor));
  return { ready: true, why: notes.length ? `all gates pass (${notes.join("; ")})` : "all gates pass" };
}

// ── Merge mode: queue vs direct (DER-2753) ──────────────────────────────────────────────────────
// The harness grew up on a repo with a native GitHub merge queue, and the queue is what ENFORCED
// "don't merge until green + threads resolved" — the harness only had to arm `gh pr merge --auto`
// and let the queue own the strategy. MOST public adopters have no queue, so `--auto` either means
// something different or there is no enqueue→merge loop to drive at all. That is why `/work` could
// not shepherd this very repo. Direct mode moves the queue's protection client-side: the SAME
// `readyVerdict` is the only thing that authorizes a merge, and the argv is produced by a pure
// function so a test can assert the exact call instead of trusting prose in a SKILL.
const MERGE_STRATEGIES = new Set(["squash", "merge", "rebase"]);
const MERGE_MODES = new Set(["queue", "direct"]);

// GraphQL `repository.mergeQueue(branch:)` is non-null exactly when a queue is configured for that
// branch. A FAILED probe (no auth, throttled, older gh) is UNKNOWN — never "no queue", because
// "no queue" is the answer that unlocks a real merge.
export function parseMergeQueueProbe({ exitCode, stdout } = {}) {
  if (exitCode !== 0) return null;
  const v = String(stdout ?? "").trim();
  if (!v || v === "null") return false;
  return true;
}

// Config wins; otherwise the probe decides. An unresolvable mode stays NULL and mergeAction holds —
// defaulting to `direct` here would merge on a repo whose queue we merely failed to see, and
// defaulting to `queue` would arm `--auto` on a repo that has no queue to catch it.
export function resolveMergeMode({ configured = null, queueDetected = null } = {}) {
  if (configured != null && configured !== "") {
    if (MERGE_MODES.has(configured)) return { mode: configured, source: "config", why: `repo.mergeMode=${configured}` };
    return { mode: null, source: "config", why: `repo.mergeMode=${JSON.stringify(configured)} is not "queue" or "direct" — fix .claude/work.config.json` };
  }
  if (queueDetected === true) return { mode: "queue", source: "detected", why: "a merge queue is configured on the default branch" };
  if (queueDetected === false) return { mode: "direct", source: "detected", why: "no merge queue on the default branch" };
  return {
    mode: null,
    source: "unresolved",
    why: "could not detect whether this repo has a merge queue — set repo.mergeMode to \"queue\" or \"direct\" in .claude/work.config.json",
  };
}

// The single decision point for "what do I run to land this PR". Returns argv (for `gh`) or null.
// `hold` with `args: null` is the fail-closed answer: with no argv there is no merge call to make.
//
// DER-2774 — a direct merge is bound to the commit `ready` actually evaluated. `ready` prints a
// command and a human or shepherd runs it later; every gate it checked (threads, Codex-on-head, CI,
// gate evidence) is a statement about ONE sha, and a plain `gh pr merge <n>` lands whatever is on the
// branch at the moment it runs. A push between the two — a lead's late commit, a kickback fix, a
// force-push — merges a tree nothing ever gated. `--match-head-commit` makes GitHub refuse that
// merge, which is the whole protection: the window cannot be closed by running faster.
// `expectedHead` is therefore REQUIRED in direct mode. That cannot dead-end a caller: `ready` reads
// it from the same `gh pr view --json headRefOid` that supplies `isDraft`, so a PR whose head is
// unreadable already fails the draft gate and never reaches here.
// Queue mode deliberately does NOT pass it (settled shape): the native queue re-evaluates its entry
// against the branch it is about to merge and ejects a stale candidate itself, and `--auto` arms a
// future merge rather than performing one, so pinning a sha there would refuse legitimate re-arms.
export function mergeAction({ mode, strategy = "squash", pr, verdict, deleteBranch = true, expectedHead = null } = {}) {
  if (!verdict?.ready) return { action: "hold", args: null, why: verdict?.why ?? "no ready verdict — run `ready` first" };
  if (!MERGE_MODES.has(mode)) {
    return {
      action: "hold",
      args: null,
      why: `merge mode unresolved (${mode == null || mode === "" ? "unset" : JSON.stringify(mode)}) — set repo.mergeMode to "queue" or "direct" in .claude/work.config.json`,
    };
  }
  if (mode === "queue") {
    // Verbatim the pre-DER-2753 call: plain `--auto`, NO strategy flag. The native queue owns the
    // strategy and passing one is the documented mistake.
    return { action: "enqueue", args: ["pr", "merge", String(pr), "--auto"], why: "native merge queue owns the strategy" };
  }
  if (!MERGE_STRATEGIES.has(strategy)) {
    return { action: "hold", args: null, why: `repo.mergeStrategy=${JSON.stringify(strategy)} is not "squash", "merge" or "rebase" — fix .claude/work.config.json` };
  }
  // FULL oid only (40 hex today, 64 if GitHub ever moves to SHA-256). The sole producer is
  // `gh pr view --json headRefOid`, which is always full-length; an abbreviated sha would not match
  // GitHub's head and would be refused at merge time, so holding here — where the harness can name
  // the problem — beats printing a command `gh` will reject with a less useful message.
  const head = typeof expectedHead === "string" ? expectedHead.trim() : "";
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) {
    return {
      action: "hold",
      args: null,
      why: `direct merge needs the head sha \`ready\` evaluated (got ${expectedHead == null || expectedHead === "" ? "none" : JSON.stringify(expectedHead)}) — without --match-head-commit the merge lands whatever is on the branch when it runs, not the tree that passed the gates`,
    };
  }
  const args = ["pr", "merge", String(pr), `--${strategy}`];
  if (deleteBranch) args.push("--delete-branch");
  args.push("--match-head-commit", head);
  return { action: "merge", args, why: `direct merge (${strategy}) bound to ${head.slice(0, 10)} — every readyVerdict gate passed` };
}

// One `ready` result → one operator/shepherd line. Extracted so the GO-AHEAD WORD is testable: the
// shepherd greps this output, and telling a queue-less adopter to "ENQUEUE" is an instruction they
// cannot carry out. An unready PR shows NEITHER word, in either mode.
export function readyLine(r = {}) {
  const act = r.mergeAction ?? null;
  let tail;
  if (!r.ready) tail = `hold (${r.why})`;
  else if (act?.action === "merge") tail = `*** MERGEABLE (direct) *** → gh ${act.args.join(" ")}`;
  else if (act?.action === "enqueue") tail = `*** ENQUEUEABLE *** → gh ${act.args.join(" ")}`;
  else tail = `hold (gates pass but ${act?.why ?? "no merge mode resolved"})`;
  // When the GATE is what holds the PR, its label and the hold reason are the same sentence — print it
  // once. The gate column stays greppable either way; the pre-DER-2603 line printed it twice, which for
  // the longer MISSING/UNKNOWN labels is the kind of noise operators learn to skim past.
  const gateCol = !r.ready && r.why === r.gateLabel ? "" : `${r.gateLabel}  `;
  return `#${r.pr} head=${(r.head ?? "?").slice(0, 10)} draft=${r.draft} thr=${r.threads ?? "UNKNOWN"} codex-on-head=${r.onHead ? "YES" : "NO"} (rev=${(r.reviewSha ?? "").slice(0, 10)} cmt=${(r.commentSha ?? "").slice(0, 10)}) checks=${r.checks ?? "?"} shards=${r.shards} behind-main=${r.behind ?? "?"}${r.behind > 0 ? " ⚠" : ""} push=${r.push ?? "?"} ${gateCol}${tail}${r.note ?? ""}`;
}

export function scoreReviewFidelity({ local = [], cloud = [], slack = 25 } = {}) {
  const near = (l, c) => {
    if (!l.file || !c.file) return false;
    if (l.file !== c.file && !l.file.endsWith(`/${c.file}`) && !c.file.endsWith(`/${l.file}`)) return false;
    const ls = l.line_start ?? 0, le = l.line_end ?? ls, cs = c.line ?? 0, ce = c.line_end ?? cs;
    if (!ls || !cs) return true; // same file, one side unanchored (a stale cloud comment) — count it
    return ls - slack <= ce && cs - slack <= le;
  };
  const matchedCloud = new Set();
  const matchedLocal = new Set();
  cloud.forEach((c, ci) => {
    const li = local.findIndex((l, i) => !matchedLocal.has(i) && near(l, c));
    if (li >= 0) { matchedCloud.add(ci); matchedLocal.add(li); }
  });
  return {
    cloud_total: cloud.length,
    local_total: local.length,
    matched: matchedCloud.size,
    missed: cloud.length - matchedCloud.size,
    novel: local.length - matchedLocal.size,
    // Share of what the cloud posted that the local gate had already found. Null on an empty cloud
    // review — 0/0 is not a 0% hit rate, and averaging a fake zero would drag the run's number down.
    preempt_rate: cloud.length ? Math.round((matchedCloud.size / cloud.length) * 100) / 100 : null,
    missed_findings: cloud.filter((_, i) => !matchedCloud.has(i)),
    novel_findings: local.filter((_, i) => !matchedLocal.has(i)),
  };
}

// Fold a headless review's own usage into the run's token telemetry. Input is the `claude -p
// --output-format json` payload, whose `modelUsage` carries per-model tokens AND a `provider` field —
// `firstParty` means it reached Anthropic directly (the subscription), anything else means the review
// leaked onto a metered endpoint, which is the whole thing this mode exists to prevent. The emitted
// event is a normal `token_usage` record with role "reviewer", so `usage`/`work-metrics` render it as
// its own row in the role × model table without any change to the aggregator. Pure.
export function reviewUsageEvent(payload, { issueId, round = 1, actor, billing = "subscription" } = {}) {
  if (!payload || typeof payload !== "object") throw new Error("review-usage: expected the JSON object from `claude -p --output-format json`");
  if (payload.is_error || (payload.subtype && payload.subtype !== "success")) {
    throw new Error(`review-usage: the review run FAILED (subtype=${payload.subtype}, api_error_status=${payload.api_error_status ?? "none"}) — do not record it as a passed gate`);
  }
  const mu = payload.modelUsage;
  if (!mu || typeof mu !== "object" || !Object.keys(mu).length) throw new Error("review-usage: payload has no modelUsage — wrong --output-format, or an old CLI");
  const by_model = {};
  const providers = new Set();
  let cost = 0;
  let costKnown = true;
  for (const [model, u] of Object.entries(mu)) {
    by_model[model] = {
      input: Number(u?.inputTokens ?? 0) || 0,
      output: Number(u?.outputTokens ?? 0) || 0,
      cache_creation: Number(u?.cacheCreationInputTokens ?? 0) || 0,
      cache_read: Number(u?.cacheReadInputTokens ?? 0) || 0,
    };
    if (u?.provider) providers.add(String(u.provider));
    if (u?.costUSD == null) costKnown = false;
    else cost += Number(u.costUSD) || 0;
  }
  const total_tokens = Object.values(by_model).reduce((s, u) => s + u.input + u.output + u.cache_creation + u.cache_read, 0);
  const ev = {
    actor: actor ?? (issueId ? `lead:${issueId}` : "lead"),
    type: "token_usage",
    role: "reviewer",
    by_model,
    total_tokens,
    // On the subscription this is the API-EQUIVALENT price of the turn, not a charge — it is quota.
    // Kept so the role × model table can compare review cost against metered implementation spend.
    cost_usd_estimate: costKnown ? Math.round(cost * 10000) / 10000 : null,
    billing,
    providers: [...providers],
    round,
    ts: new Date().toISOString(),
    // Same idempotence contract as session-token-report: a one-way hash, never the raw session id.
    report_id: createHash("sha256").update(String(payload.session_id ?? `${issueId}:${round}`)).digest("hex").slice(0, 12),
  };
  if (issueId) ev.issue = issueId;
  return ev;
}

// ---------------------------------------------------------------------------
// Context rotation (2026-07-25) — respawn-over-compact for LEADS
// ---------------------------------------------------------------------------
// The orchestrator and the shepherd both rotate before they degrade; leads never got the pattern, so
// they ran to their ceiling and stalled there. MEASURED on run 20260725T020304Z (DER-2160, `gpt` lead
// type, 270K window): the lead sat at 276,659 tokens = 102% of its window, and its `implementer`
// subagent reached 361,384 = 134%, while a second subagent died on a stream error with its findings
// unrecoverable. Nothing fired, because context-wrap-nudge.mjs infers the window from the transcript
// MODEL id: `gpt-5.6-sol` matches no rule, so it fell through to the settings `[1m]` check, believed
// the window was 1M, and read 276,659 as 28% — under its own 30% gentle band. The hook built to catch
// exactly this could never fire on the lead type that needed it most.
//
// Design: the README's context-rotation section.
// Rejected alternative: raising CLAUDE_CODE_MAX_CONTEXT_TOKENS to force auto-compact — it depends on
// CLIProxyAPI translating an upstream context error into the exact Anthropic prompt-too-long shape the
// swap-in listens for (untested; the gateway already 502s on unsupported models, so a mangled error
// turns a recoverable compaction into the same hard wedge), and its summary is generic where a
// lead-authored handoff note knows what matters for THIS round.

// A rotation is not a kickback round — the lead ran out of context, not out of correctness — so it
// rides its own axis and must never inflate kickback_count or the review metrics. But it must not
// become an infinite-life machine either: DER-2160 burned ~922M tokens across 9 respawns without
// landing. The 3rd request is a budget trip the orchestrator has to resolve (split / re-scope / park).
export const ROTATION_CAP = 2;

// Statuses where a lead is actually running and a context reading means something. `queued` has no
// session yet; merged/reaped are done and their spend is sunk.
const LIVE_LEAD_STATUSES = new Set(["in_progress", "pr_open", "kickback"]);

// The lead type's own `contextWindow` wins (270K gpt, 1M kimi/dsv4). `claude` deliberately declares
// NONE: its real window depends on the operator's settings.json `[1m]` opt-in, which can change, so a
// static 1M in config would start lying the moment it is turned off. Inference mirrors the hook's
// rules — and resolves on the host the lead actually runs on, so a mini lead is judged against the
// remote host's settings rather than the orchestrator machine's.
export function resolveContextWindow({ leadTypeCfg = {}, model = "", settingsModel = "" } = {}) {
  const declared = Number(leadTypeCfg?.contextWindow);
  if (Number.isFinite(declared) && declared > 0) return declared;
  // DER-2547 — the OBSERVED model id is the strongest evidence there is, and it was being ignored.
  // A lead running `claude-opus-5[1m]` carries its own window in the id the API call actually used;
  // only `settingsModel` was checked for the `[1m]` marker, and that is a settings-file read that can
  // be for the wrong HOST (a remote lead judged against the orchestrator machine's settings) or missing entirely.
  // With no marker found, an Opus lead on a 1M window resolved to 200K — a 5× over-read that reported
  // healthy leads in the rotate band and spent rotations on them. Check the model id first.
  if (is1MWindow(model)) return 1_000_000;
  // DER-2581 — the SAME test on the same class of evidence. The old asymmetry was the whole defect: the
  // observed-model path had grown a `sonnet-5` special case while the settings path still tested for the
  // `[1m]` marker ALONE, so an orch/shepherd session on any other natively-1M family resolved to 200K.
  if (is1MWindow(settingsModel)) return 1_000_000;
  return 200_000;
}

// Families that are natively 1M-window and carry NO `[1m]` marker in their id. Every window resolver in
// the harness tested for the marker alone, which is a 5× over-read on these — and an over-read here is
// not a cosmetic number, it is a wrap/rotate recommendation against a healthy session. Live case, this
// run: the orchestrator's own wrap-nudge twice reported "≈82% of the 200K-token window" for a session on
// a 1M window (~16% of it), and twice talked the orchestrator into recommending an unnecessary handoff.
// The inverse error is on record too (a 270K-window lead read as 28% of an assumed 1M), which is why this
// is an explicit ALLOW-LIST rather than a default-to-1M: an unrecognised id resolves to the safe 200K.
const NATIVE_1M_MODELS = /sonnet-5|opus-5|fable-5|opus-4-[678]/;
export function is1MWindow(model) {
  const m = String(model || "");
  return m.length > 0 && (m.includes("[1m]") || NATIVE_1M_MODELS.test(m));
}

// Bands scale with the window for the same reason the hook's do: on a ≥1M window quality degrades well
// before high utilization (effective context ≈ 300–450K), so a flat 70% would rotate a Claude lead at
// 700K — long past the point it stopped being good. Per-type override: rotateArmPct / rotatePct.
//   gpt (270K): arm 148K (55%)  rotate 189K (70%)   |   1M types: arm 300K (30%)  rotate 450K (45%)
export function rotationBands(windowTokens, cfg = {}) {
  const big = Number(windowTokens) >= 1_000_000;
  return {
    armPct: Number(cfg?.rotateArmPct ?? (big ? 30 : 55)),
    rotatePct: Number(cfg?.rotatePct ?? (big ? 45 : 70)),
  };
}

// `over` (≥100%) should be unreachable once the hook fix lands; it exists so a regression is LOUD
// rather than silently reading as a healthy 28%.
export function classifyContext({ used, window, bands } = {}) {
  const w = Number(window) || 0;
  const u = Number(used) || 0;
  if (!w) return { pct: 0, band: "none" };
  const pct = Math.round((u / w) * 100);
  const b = bands ?? rotationBands(w);
  if (pct >= 100) return { pct, band: "over" };
  if (pct >= b.rotatePct) return { pct, band: "rotate" };
  if (pct >= b.armPct) return { pct, band: "arm" };
  return { pct, band: "none" };
}

// Claude Code stores a session's transcript under ~/.claude/projects/<cwd with [^a-zA-Z0-9] → ->.
// REALPATH IS MANDATORY: worktreeRoot is /tmp/agent-work and macOS resolves /tmp → /private/tmp, which
// is what the slug actually encodes (`-private-tmp-agent-work-…`). Slugging the un-resolved path yields
// a directory that does not exist, and the probe silently reports "no transcript" for every lead.
export function transcriptSlug(absPath) {
  return String(absPath).replace(/[^a-zA-Z0-9]/g, "-");
}

// Pure: the caller resolves the realpath (async) and passes it in.
export function transcriptDirFor(realWorktreePath, { home } = {}) {
  return join(home ?? homedir(), ".claude", "projects", transcriptSlug(realWorktreePath));
}

// A worktree's transcript dir also holds `claude -p` shell-outs (the security-review pass, the dsv4
// subscription-billed reviewer) and every PRIOR rotation of this lead. The live lead session is
// identified deterministically by its FIRST `type:"user"` entry, which is the slash-command boot:
//   <command-message>work-lead</command-message><command-name>/work-lead</command-name>
//   <command-args>…/briefs/DER-2160.md</command-args>
// Returns the brief path (which carries run id, issue id and the kb/rot round) or null when the first
// user turn is anything else — that null IS the discriminator against a shell-out.
export function leadBriefFromHead(text, { maxLines = 400 } = {}) {
  const lines = String(text ?? "").split("\n").slice(0, maxLines);
  for (const l of lines) {
    if (!l.includes('"user"')) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; } // a truncated tail line of the head read
    if (e?.type !== "user") continue;
    const c = e?.message?.content;
    const t = Array.isArray(c) ? c.map((x) => x?.text ?? "").join("") : String(c ?? "");
    if (!t.includes("<command-name>/work-lead</command-name>")) return null;
    const m = t.match(/<command-args>([^<]*)<\/command-args>/);
    return (m ? m[1] : "").trim();
  }
  return null;
}

// Newest lead session wins — a rotated lead leaves its predecessor's transcript in the same directory.
export function pickLeadTranscript(candidates = []) {
  const leads = candidates.filter((c) => c && c.brief != null);
  if (!leads.length) return null;
  return leads.slice().sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))[0];
}

// Scan BACKWARDS for the last real usage record. `<synthetic>` entries are Claude Code's error frames
// (`API Error: stream disconnected before completion` killed one DER-2160 subagent) and they carry
// usage:{input_tokens:0} — taking them at face value reports a session that died deep in its window as
// sitting at 0%. So skip them for the reading but remember that one was seen: `errored` is how a lost
// subagent report becomes visible instead of looking idle.
export function readContextUsage(text) {
  const lines = String(text ?? "").split("\n");
  let errored = false;
  let errorText = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const u = e?.message?.usage;
    if (!u || u.input_tokens == null) continue;
    const model = e?.message?.model ?? "";
    if (model === "<synthetic>") {
      errored = true;
      if (!errorText) {
        const c = e?.message?.content;
        const t = Array.isArray(c) ? c.map((x) => x?.text ?? "").join(" ") : String(c ?? "");
        errorText = t.trim().slice(0, 200) || null;
      }
      continue;
    }
    return {
      used: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      model,
      ts: e?.timestamp ?? null,
      errored,
      errorText,
    };
  }
  return errored ? { used: 0, model: "<synthetic>", ts: null, errored: true, errorText } : null;
}

// Subagents live at <session-id>/subagents/agent-*.jsonl with a sibling .meta.json naming them:
//   {"agentType":"implementer","description":"Implement round-seven fixes","model":"sonnet",…}
// Pure: the caller does the IO and passes {id, meta, usage}. Sorted hottest-first so the banner leads
// with the one worth acting on. A missing meta is tolerated (the reading still matters).
export function subagentReadings(entries = [], { window, cfg } = {}) {
  const bands = rotationBands(window, cfg);
  return entries
    .filter(Boolean)
    .map((e) => {
      const used = Number(e.usage?.used ?? 0) || 0;
      const { pct, band } = classifyContext({ used, window, bands });
      return {
        id: e.id,
        agentType: e.meta?.agentType ?? null,
        description: e.meta?.description ?? null,
        model: e.usage?.model ?? e.meta?.model ?? null,
        used,
        pct,
        band,
        errored: !!e.usage?.errored,
        errorText: e.usage?.errorText ?? null,
      };
    })
    .sort((a, b) => b.used - a.used);
}

// --- Context rotation: IO probes -------------------------------------------
// Lead transcripts reach ~2.8MB and this runs every wake for every in-flight lead, so a full
// readFileSync is not acceptable. Read bounded windows from each end: the HEAD identifies the session,
// the TAIL carries the latest usage record.
const TRANSCRIPT_SCAN_BYTES = 262_144;

async function readHead(path, bytes = TRANSCRIPT_SCAN_BYTES) {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

export async function readTail(path, bytes = TRANSCRIPT_SCAN_BYTES) {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const text = buf.toString("utf8");
    if (start === 0) return text;
    // Drop the partial first line of a mid-file read — it can't parse, and dropping it keeps the
    // "unparsable line" path in readContextUsage meaningful rather than routine.
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(nl + 1);
  } finally {
    await fh.close();
  }
}

async function readSettingsModel(home = homedir()) {
  try {
    const s = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    return String(s.model ?? "");
  } catch {
    return "";
  }
}

// Model ids are provider-qualified in config (`deepseek/deepseek-v4-pro`) and bare in transcripts
// (`deepseek-v4-pro`). Compare on the bare tail, and compare EXACTLY — loose containment would let the
// dsv4 reviewer slot `opus` match an observed `claude-opus-5` and hand a plain Claude lead dsv4's 1M
// window by accident.
const bareModel = (s) => String(s || "").toLowerCase().split("/").pop();

// Which configured lead type is this OBSERVED model actually from? The transcript's model is ground
// truth about what is running; the ledger's leadType is only what was intended at spawn. They diverge
// for real: a session can be killed and relaunched with `--model X --resume` in the same pane, and no
// ledger event records it. Observed live 2026-07-25 — all three mini leads were recorded as
// claude/dsv4 while every one of them was running gpt-5.6-sol, so two of them were being judged
// against a 1M window when their real one was 270K (one read as a healthy 22% while actually at 82%).
// Matches any slot, because a subagent runs its type's subagent/research tier, not the lead tier. Pure.
export function leadTypeForModel(leadTypes = {}, observed = "") {
  const b = bareModel(observed);
  if (!b || b === "<synthetic>") return null;
  for (const [name, cfg] of Object.entries(leadTypes)) {
    if (!cfg || typeof cfg !== "object") continue;
    for (const slot of [cfg.leadModel, cfg.subagentModel, cfg.researchModel, cfg.reviewerModel]) {
      if (slot && bareModel(slot) === b) return { name, cfg };
    }
  }
  return null;
}

// Does the model we OBSERVE contradict the lead type the ledger recorded? A proxy type names its
// concrete `leadModel`; the bare `claude` type names none, so its expectation is simply "a Claude
// model". Pure.
export function modelMismatches(leadTypeCfg = {}, observed = "") {
  const seen = String(observed || "");
  if (!seen || seen === "<synthetic>") return false;
  const declared = leadTypeCfg?.leadModel;
  if (!declared) return !/claude/i.test(seen); // the claude type: anything non-Claude is a switch
  return bareModel(declared) !== bareModel(seen);
}

// Subagents inherit the lead type's endpoint (the ANTHROPIC_DEFAULT_*_MODEL remaps), so the lead
// type's window applies to them too.
async function probeSubagents(leadTranscriptPath, { window, cfg }) {
  const dir = join(leadTranscriptPath.replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync(dir)) return [];
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const entries = [];
  for (const n of names) {
    if (!n.startsWith("agent-") || !n.endsWith(".jsonl")) continue;
    const id = n.slice(0, -".jsonl".length);
    let meta = null;
    try { meta = JSON.parse(await readFile(join(dir, `${id}.meta.json`), "utf8")); } catch { /* meta is optional */ }
    let usage = null;
    try { usage = readContextUsage(await readTail(join(dir, n))); } catch { /* unreadable → skip reading */ }
    entries.push({ id, meta, usage });
  }
  return subagentReadings(entries, { window, cfg });
}

// One worktree → one reading. This is the whole of `lead-context --worktree`, which is what runs over
// ssh on the mini: the mini already has the skills synced, so remote support needs no new transport.
// Fails soft everywhere — a probe that throws must never take down the orchestrator's wake loop.
export async function probeWorktreeContext(
  worktree,
  { leadTypeCfg = {}, windowOverride = null, home = homedir(), settingsModel = null } = {},
) {
  let real = worktree;
  try { real = await realpath(worktree); } catch { /* worktree gone (reaped mid-probe) — slug the raw path */ }
  const transcriptDir = transcriptDirFor(real, { home });
  // band:"unknown", NOT "none" (2026-07-26). Every early return below means "we could not determine
  // this lead's utilization" — which is NOT the same as "this lead is at 0%", and conflating them cost
  // a live incident: DER-2409 blew its window (283K used of 270K), fell out through the "no usage
  // record yet" path at the bottom of this function, and rendered as a healthy green `0% — 0K/0K`.
  // The detector never raised a rotate flag, so a wedged lead sat 90 minutes with five files of
  // uncommitted kickback work while the orchestrator read it as idle-after-hand-off. A blown window
  // and a finished lead are indistinguishable from a zeroed reading — so the zero must never be
  // rendered as health. `unknown` is loud in the banner and emits its own durable event.
  const base = { worktree, transcriptDir, transcript: null, model: null, window: null, used: 0, pct: 0, band: "unknown", readable: false, subagents: [] };
  if (!existsSync(transcriptDir)) return { ...base, note: "no transcript dir" };

  let names;
  try { names = await readdir(transcriptDir); } catch { return { ...base, note: "transcript dir unreadable" }; }
  const candidates = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const p = join(transcriptDir, n);
    let st;
    try { st = await stat(p); } catch { continue; }
    if (!st.isFile()) continue;
    let brief = null;
    try { brief = leadBriefFromHead(await readHead(p)); } catch { /* unreadable → not a lead session */ }
    candidates.push({ path: p, mtimeMs: st.mtimeMs, brief });
  }
  const lead = pickLeadTranscript(candidates);
  if (!lead) return { ...base, note: `no /work-lead session among ${candidates.length} transcript(s)` };

  const usage = readContextUsage(await readTail(lead.path));
  if (!usage) return { ...base, transcript: lead.path, brief: lead.brief, note: "no usage record yet" };

  const sm = settingsModel ?? (await readSettingsModel(home));
  // Resolution order matters, and it is: OBSERVED model → declared lead type → inference. The observed
  // model is what is actually burning context; the declared type is only what was intended at spawn.
  // Trusting the declaration over the evidence is how a lead running gpt-5.6-sol under a `dsv4` record
  // read as 22% of 1M when it was really 82% of 270K — a rotation the harness would never have fired.
  const observed = leadTypeForModel(getLeadTypes(), usage.model);
  const effectiveCfg = observed?.cfg ?? leadTypeCfg;
  const window = Number(windowOverride) || resolveContextWindow({ leadTypeCfg: effectiveCfg, model: usage.model, settingsModel: sm });
  const bands = rotationBands(window, effectiveCfg);
  const { pct, band } = classifyContext({ used: usage.used, window, bands });
  return {
    worktree,
    transcriptDir,
    transcript: lead.path,
    brief: lead.brief,
    model: usage.model,
    window,
    bands,
    used: usage.used,
    pct,
    band,
    readable: true,
    // The ledger's leadType can go stale: a session can be switched to another model MID-RUN
    // (kill the pid, relaunch `--model X --resume` in the same pane) and no ledger event records it.
    // The window then comes from the DECLARED type while the real model is something else — observed
    // live 2026-07-25 on a mini lead recorded as `claude` but actually running gpt-5.6-sol. The
    // reading stays conservative (a smaller assumed window arms earlier, never later), but a silently
    // wrong window is exactly the class of bug this whole mechanism exists to kill, so name it.
    modelMismatch: modelMismatches(leadTypeCfg, usage.model),
    windowSource: observed ? `observed-model:${observed.name}` : leadTypeCfg?.contextWindow ? "declared-type" : "inferred",
    errored: !!usage.errored,
    errorText: usage.errorText ?? null,
    subagents: await probeSubagents(lead.path, { window, cfg: leadTypeCfg }),
  };
}

// A mini lead is probed by running the SAME `--worktree` mode on the mini over ssh. `zsh -lc` does not
// source ~/.zshrc non-interactively, so it misses the mini's node — the PATH prefix is mandatory (the
// Homebrew node there belongs to a different user and its libuv is permission-denied for the lead user).
// `--repo-root` is REQUIRED, not cosmetic: the remote command runs from the ssh login dir ($HOME), and
// `applyRepoConfig` reads `<cwd>/.claude/work.config.json` — so without it the lead types never load
// and every proxy lead's window silently falls back to the 200K default. Caught live on 2026-07-25: a
// mini gpt lead reported 105% of a 200K window when it was really 78% of its declared 270K one. A
// window that is wrong in the SAFE direction is still wrong, and this one would have rotated leads early
// forever without ever looking broken.
// A non-interactive `ssh host "zsh -lc …"` does NOT reliably pick up a user-level node/claude install,
// so every remote call needs this prelude. It was inlined here and MISSING from the preflight account
// probe, which is how a healthy Max subscription came to read as a dead account. One constant, so the
// next remote call cannot be written without it. Per-host override: `remotePathPrelude` in work.config.
export const REMOTE_PATH_PRELUDE = "export PATH=$HOME/.local/bin:$HOME/.local/node/bin:$PATH;";

export function remoteProbeCommand({ ssh, worktree, leadType, repoRoot }) {
  const inner =
    `${REMOTE_PATH_PRELUDE} ` +
    `node $HOME/.claude/skills/work/work-runner.mjs lead-context --worktree ${shellQuote(worktree)}` +
    `${repoRoot ? ` --repo-root ${shellQuote(repoRoot)}` : ""}` +
    `${leadType && leadType !== "claude" ? ` --lead-type ${leadType}` : ""} --json`;
  return { command: "ssh", args: [ssh, `zsh -lc ${shellQuote(inner)}`] };
}

// Render the every-wake banner. Pure. Leads first (they are actionable), then any hot subagent — which
// is advisory: only the parent lead can re-dispatch a subagent, so the orchestrator's job is to make
// sure a busy lead does not miss it, not to queue an action for itself.
export function renderContextBanner(readings = []) {
  if (!readings.length) return "🧠 lead context: no in-flight leads with worktrees.";
  const icon = { none: "🟢", arm: "🟡", rotate: "🟠", over: "🔴", unknown: "⚠️" };
  const lines = ["🧠 lead context"];
  for (const r of readings) {
    // Process liveness leads every line (DER-2516): it is the only field that can say "dead", and
    // it must not be buried under a healthy-looking percentage read from an outliving transcript.
    if (r.process === "dead") {
      lines.push(
        `  💀 ${r.issue} (${r.host ?? "local"}) PROCESS DEAD — no live process matches its brief.` +
          ` Before respawning, DIFF THE BRANCH AGAINST ITS OPEN FINDINGS: a lead that dies late looks` +
          ` identical to one that dies early, and the work may already be pushed.`,
      );
      continue;
    }
    if (r.pollable === false) {
      const move = r.lastPushMin != null ? ` · head last moved ${r.lastPushMin} min ago${r.lastPushMin > 45 ? " ← STALE, apply the movement deadline" : ""}` : "";
      lines.push(`  ⚪ ${r.issue} (${r.host}) — not pollable: ${r.note}${move}`);
      continue;
    }
    if (!r.transcript) {
      lines.push(`  ⚪ ${r.issue} (${r.host ?? "local"}) — ${r.note ?? "no reading"}`);
      continue;
    }
    // An in-flight lead whose utilization could NOT be read is a FINDING, not a 0%. Printing the
    // numbers here would render `0% — 0K/0K · null`, which is exactly the healthy-looking line that
    // hid a wedged 100%-context lead for 90 minutes. Say UNREADABLE and say what to do about it.
    if (r.band === "unknown" || r.readable === false) {
      lines.push(
        `  ⚠️ ${r.issue} (${r.host ?? "local"}) UNREADABLE — ${r.note ?? "no usage record"}` +
          ` · treat as SUSPECT, not idle: check the pane and whether the remote head has moved` +
          ` (a blown window and a finished lead look identical from here)`,
      );
      continue;
    }
    const k = Math.round(r.used / 1000);
    const w = Math.round(r.window / 1000);
    lines.push(
      `  ${icon[r.band] ?? "⚪"} ${r.issue} (${r.host ?? "local"}) ${r.pct}% — ${k}K/${w}K · ${r.model}` +
        `${r.band === "rotate" || r.band === "over" ? "  ← ROTATE" : r.band === "arm" ? "  ← armed" : ""}`,
    );
    if (r.modelMismatch) {
      lines.push(
        `      ⚠ running ${r.model}, but the ledger says lead type "${r.leadType ?? "claude"}" — switched mid-run?` +
          ` ${r.windowSource?.startsWith("observed-model") ? `window taken from the OBSERVED model (${r.windowSource.split(":")[1]}, ${w}K) — the reading above is correct; the ledger is stale` : `window is the DECLARED one (${w}K), so this % may be off`}`,
      );
    }
    for (const s of r.subagents ?? []) {
      if (s.band !== "over" && !s.errored) continue;
      const what = `${s.agentType ?? "subagent"} · ${s.description ?? s.id}`;
      lines.push(
        s.errored
          ? `      ⚠ ${what} DIED at ${s.pct}% — ${s.errorText ?? "error"} (findings lost unless it wrote its notes file)`
          : `      ⚠ ${what} at ${s.pct}% of window (${Math.round(s.used / 1000)}K) — re-dispatch narrowed`,
      );
    }
  }
  return lines.join("\n");
}

// --- Context rotation: rotate-lead helpers ---------------------------------

// `git add -A` is DELIBERATE here even though the lead brief bans it for feature commits: the entire
// point of a rotation checkpoint is that nothing is lost, and an unstaged file the successor cannot see
// is exactly the failure this step exists to prevent. `--no-verify` because the workspace is already
// closed at this point — a slow or failing pre-commit hook must not strand the work mid-rotation.
// NEVER pushed: the successor shares the worktree, and pushing WIP to an open PR would churn CI and
// the merge queue for a commit that exists only so a fresh context can read it.
export function wipCommitCommand({ worktree, issueId, rotation }) {
  const wt = shellQuote(worktree);
  return `git -C ${wt} add -A && git -C ${wt} commit --no-verify -m ${shellQuote(`wip(${issueId}): rotation ${rotation} checkpoint`)}`;
}

// ---------------------------------------------------------------------------
// Worktree creation: LOOK BEFORE YOU DELETE (DER-2742)
// ---------------------------------------------------------------------------
//
// `create-worktree` used to run `rm -rf <wt>` UNCONDITIONALLY before `git worktree add -b`. The path is
// deterministic (`<worktreeRoot>/<runId>/<issueId>`), so any retry — and a re-create IS a normal recovery
// action here — recursively deleted whatever was at that path, INCLUDING a dispatched lead's uncommitted
// work, and then failed anyway because the branch already existed. It destroyed work and did not succeed.
//
// The replacement is one pure decision function over three facts (`git worktree list --porcelain`, what
// is physically at the path, whether the branch exists) and FOUR outcomes: resume, create, prune-then-
// create, or REFUSE. There is no delete outcome at all — this code path cannot remove a byte. Anything it
// cannot positively identify as "the worktree this run already made" is refused with recovery
// instructions, which is the fail-closed direction: a refusal costs the operator one command, a wrong
// delete costs a lead's whole session.

// `git worktree list --porcelain` → entries. Attribute lines belong to the preceding `worktree` line.
// `locked`/`prunable` may appear bare or with a reason; `branch` is normalized to a short name.
export function parseWorktreeList(stdout) {
  const out = [];
  let cur = null;
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length).trim(), head: null, branch: null, detached: false, bare: false, locked: false, lockedReason: null, prunable: false, prunableReason: null };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
    else if (line === "locked" || line.startsWith("locked ")) { cur.locked = true; cur.lockedReason = line.slice("locked".length).trim() || null; }
    else if (line === "prunable" || line.startsWith("prunable ")) { cur.prunable = true; cur.prunableReason = line.slice("prunable".length).trim() || null; }
  }
  return out;
}

export const WORKTREE_PATH_STATES = new Set(["absent", "empty-dir", "occupied-dir", "file", "symlink"]);

function worktreeRefusal({ path, branch, repo, why, extra = [] }) {
  const q = shellQuote(path);
  return [
    `create-worktree REFUSED for ${q}: ${why}. Nothing was deleted.`,
    `Recovery (pick one, then re-run create-worktree):`,
    `  1. LOOK first:  ls -la ${q} && git -C ${shellQuote(repo)} worktree list`,
    `  2. KEEP the work:  git -C ${q} status --porcelain && git -C ${q} add -A && git -C ${q} commit -m 'wip: rescued'`,
    `     (or move it aside:  mv ${q} ${shellQuote(`${path}.rescued`)})`,
    `  3. DISCARD it deliberately:  git -C ${shellQuote(repo)} worktree remove --force ${q}`,
    `     (unregistered leftovers:  rm -rf ${q} && git -C ${shellQuote(repo)} worktree prune)`,
    ...extra,
  ].join("\n");
}

// The whole decision, pure. `pathState` is what is physically at `path` (see WORKTREE_PATH_STATES),
// `realPath` its resolved form (git records resolved paths — /tmp vs /private/tmp on macOS is exactly the
// mismatch that would make a healthy resume look unregistered and get refused).
//
// Returns { action: "resume" | "create" | "refuse", attach, prune, reason, message }.
//   resume  — this IS the worktree we were asked to make, on the requested branch. Touch nothing.
//   create  — the path is free (absent or an empty dir git will accept). `attach` when the branch already
//             exists: `add -b` would abort on it, and the branch may carry a lead's committed work.
//   prune   — the path is registered but its directory is GONE. Pruning removes a stale admin file for a
//             directory that no longer exists; it cannot lose content. Then create.
//   refuse  — anything else, including every case where content of unknown value sits at the path.
export function planWorktreeAction({ path, branch, entries = [], pathState = "absent", branchExists = false, realPath = null, repo = "<repo>" } = {}) {
  const repoLabel = repo ?? "<repo>";
  const state = WORKTREE_PATH_STATES.has(pathState) ? pathState : null;
  const refuse = (reason, why, extra) => ({ action: "refuse", reason, path, branch, message: worktreeRefusal({ path, branch, repo: repoLabel, why, extra }) });
  if (!state) {
    return refuse("unprobed", `could not determine what is at the path (probe returned ${JSON.stringify(pathState)}) — refusing to act blind`);
  }
  // `realPath` may be several spellings of the same place (the path resolved, and the path rebuilt from
  // its resolved PARENT — the only form available when the directory itself is gone, which is exactly the
  // prunable case). git records resolved paths, so without these a healthy /tmp worktree on macOS reads as
  // unregistered and gets refused.
  const wanted = new Set([path, ...(Array.isArray(realPath) ? realPath : [realPath])].filter(Boolean).map((p) => String(p).replace(/\/+$/, "")));
  const isWanted = (p) => wanted.has(String(p ?? "").replace(/\/+$/, ""));
  const at = entries.find((e) => isWanted(e.path)) ?? null;
  const branchElsewhere = entries.find((e) => e.branch === branch && !isWanted(e.path)) ?? null;

  if (at) {
    if (at.locked) {
      return refuse("locked", `the worktree at that path is LOCKED by git${at.lockedReason ? ` (${at.lockedReason})` : ""} — somebody protected it on purpose`, [
        `  (unlock only if you know why it was locked:  git -C ${shellQuote(repoLabel)} worktree unlock ${shellQuote(path)})`,
      ]);
    }
    // Registered, but the directory is gone (git reports it prunable; we also see it directly).
    if (at.prunable || state === "absent") {
      return { action: "create", prune: true, attach: branchExists, reason: "prunable", path, branch };
    }
    if (at.branch && at.branch === branch) {
      return { action: "resume", path, branch, reason: "registered", head: at.head ?? null };
    }
    if (at.detached || !at.branch) {
      return refuse("detached", `a registered worktree is there in DETACHED HEAD${at.head ? ` at ${at.head}` : ""}, not on ${branch} — its commits may be reachable from nothing else`);
    }
    return refuse("branch-mismatch", `a registered worktree is there on branch '${at.branch}', not the requested '${branch}'`);
  }

  if (branchElsewhere) {
    return refuse("branch-checked-out-elsewhere", `branch '${branch}' is already checked out at ${branchElsewhere.path} — two worktrees cannot share one branch`, [
      `  (that other worktree is where this unit's work already lives — reuse it, or remove it there first)`,
    ]);
  }
  if (state === "absent" || state === "empty-dir") {
    return { action: "create", prune: false, attach: branchExists, reason: state, path, branch };
  }
  if (state === "symlink") {
    const target = (Array.isArray(realPath) ? realPath[0] : realPath) ?? null;
    return refuse("symlink", `the path is a SYMLINK${target ? ` to ${target}` : ""} and no worktree is registered there — following it to make room would delete somebody else's directory`);
  }
  if (state === "file") return refuse("file", `a non-directory file is at that path`);
  return refuse("occupied", `the directory is NOT EMPTY and git has no worktree registered there — it may be a lead's uncommitted work, or a worktree this repo no longer knows about`);
}

// The remote (ssh) half of the same three facts, as ONE read-only shell command. Read-only on purpose:
// nothing here creates, moves or deletes, so it is safe to run before we have decided anything.
export function remoteWorktreeProbeCommand({ repo, path, branch }) {
  const R = shellQuote(repo);
  const P = shellQuote(path);
  return [
    `git -C ${R} worktree list --porcelain`,
    `printf 'WT-PROBE path-state '`,
    `if [ -L ${P} ]; then echo symlink; elif [ ! -e ${P} ]; then echo absent; elif [ -d ${P} ]; then if [ -z "$(ls -A ${P} 2>/dev/null)" ]; then echo empty-dir; else echo occupied-dir; fi; else echo file; fi`,
    `printf 'WT-PROBE real-path '`,
    `(cd ${P} 2>/dev/null && pwd -P) || echo`,
    // The path rebuilt from its resolved PARENT — the only resolvable spelling when the directory itself
    // is gone (the prunable case), and what makes /tmp vs /private/tmp match on a macOS host.
    `printf 'WT-PROBE real-parent '`,
    `(cd "$(dirname ${P})" 2>/dev/null && echo "$(pwd -P)/$(basename ${P})") || echo`,
    `printf 'WT-PROBE branch-exists '`,
    `if git -C ${R} rev-parse --verify --quiet ${shellQuote(`refs/heads/${branch}`)} >/dev/null 2>&1; then echo yes; else echo no; fi`,
  ].join("; ");
}

// Splits the probe's stdout back into the porcelain listing + the three facts. `pathState:null` means the
// probe did not report one (ssh died, wrong shell, truncated output) — planWorktreeAction refuses on it
// rather than guessing, which is the difference between "I looked" and "I assumed".
export function parseRemoteWorktreeProbe(stdout) {
  const listLines = [];
  const facts = {};
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^WT-PROBE (path-state|real-path|real-parent|branch-exists) ?(.*)$/);
    if (m) { facts[m[1]] = m[2].trim(); continue; }
    listLines.push(line);
  }
  return {
    entries: parseWorktreeList(listLines.join("\n")),
    pathState: WORKTREE_PATH_STATES.has(facts["path-state"]) ? facts["path-state"] : null,
    realPath: [...new Set([facts["real-path"], facts["real-parent"]].filter(Boolean))],
    branchExists: facts["branch-exists"] === "yes",
  };
}

// `git worktree add` for a decided plan. `attach` reuses an existing branch (its commits are somebody's
// work); otherwise a fresh branch off `origin/main`. `prune` clears the stale registration of a directory
// that is already gone. Never `rm`, never `--force`.
export function worktreeAddArgs({ repo, path, branch, attach = false }) {
  return attach
    ? ["-C", repo, "worktree", "add", path, branch]
    : ["-C", repo, "worktree", "add", "-b", branch, path, "origin/main"];
}

export function remoteWorktreeAddCommand({ repo, path, branch, attach = false, prune = false }) {
  const R = shellQuote(repo);
  const parts = [`git -C ${R} fetch --quiet origin`];
  if (prune) parts.push(`git -C ${R} worktree prune`);
  parts.push(attach
    ? `git -C ${R} worktree add ${shellQuote(path)} ${shellQuote(branch)}`
    : `git -C ${R} worktree add -b ${shellQuote(branch)} ${shellQuote(path)} origin/main`);
  return parts.join(" && ");
}

// Every resolvable spelling of a local path: the path itself when it exists, and the path rebuilt from its
// resolved parent — which is the ONLY resolvable spelling once the directory is gone, and the one that
// makes `/tmp/agent-work/...` match the `/private/tmp/agent-work/...` git actually recorded.
async function realPathCandidates(p) {
  const abs = resolvePath(p);
  const out = [];
  const self = await realpath(abs).catch(() => null);
  if (self) out.push(self);
  const parent = await realpath(dirname(abs)).catch(() => null);
  if (parent) out.push(join(parent, basename(abs)));
  return [...new Set(out)];
}

// What is physically at a local path, without following the symlink (`lstat`, not `stat`): the old code's
// `rm -rf` on a symlinked path would have deleted the TARGET's contents.
async function probeLocalWorktreePath(p) {
  const realPath = await realPathCandidates(p);
  let st;
  try { st = await lstat(p); }
  catch { return { pathState: "absent", realPath }; }
  if (st.isSymbolicLink()) return { pathState: "symlink", realPath };
  if (!st.isDirectory()) return { pathState: "file", realPath };
  let names = [];
  try { names = await readdir(p); } catch { return { pathState: "occupied-dir", realPath }; }
  return { pathState: names.length ? "occupied-dir" : "empty-dir", realPath };
}

async function runLocalOrRemote(cmd, ssh) {
  return ssh
    ? runCommand({ command: "ssh", args: [ssh, cmd] })
    : runCommand({ command: "sh", args: ["-c", cmd] });
}

async function ensureWipCommit({ worktree, issueId, rotation, ssh = null }) {
  if (!worktree) return false;
  const st = await runLocalOrRemote(`git -C ${shellQuote(worktree)} status --porcelain`, ssh);
  if (!String(st.stdout ?? "").trim()) return false;
  const res = await runLocalOrRemote(wipCommitCommand({ worktree, issueId, rotation }), ssh);
  return res.exitCode === 0;
}

// A run-dir file does NOT ride the mini's existing sync — `pullHostInto` tails events.jsonl and
// nothing else — so a mini note is fetched explicitly at rotation time. Cloud leads have no run dir at
// all, so their note is a `WORK-HANDOFF` PR comment.
// Author-aware handoff-note selection (DER-2737). This used to take the LATEST `WORK-HANDOFF` comment
// author-blind, and `renderRotationBrief` presents whatever it returns to a successor lead under
// "Handoff note — written by your predecessor" with `noteSynthesized:false` and no warning — so a forged
// comment was a direct instruction to the next session, needing no ssh host and no other config. A note
// from an untrusted author is not a note: returning null routes the successor to synthesizeHandoffNote,
// which reconstructs state from git + the ledger and MARKS itself as evidence rather than testimony.
// Pure, so the control for this is a unit test rather than a live rotation.
export function selectHandoffComment({ comments = [], trustedAuthors } = {}) {
  const trusted = toAuthorSet(trustedAuthors);
  for (const c of [...comments].reverse()) {
    if (!trusted.has(commentAuthorLogin(c) ?? "")) continue;
    const body = String(c?.body ?? "");
    if (!getHandoffMarkers().some((m) => body.trimStart().startsWith(m))) continue;
    return body.replace(handoffMarkerRe(), "").trim() || null;
  }
  return null;
}

async function fetchHandoffNote({ runDir, runId, issueId, rotation, hostCfg, isCloud, pr, repoRoot }) {
  const fname = `${issueId}.rot${rotation}.md`;
  const localPath = join(runDir, "handoffs", fname);
  if (isCloud) {
    if (!pr) return null;
    const res = await runCommand({ command: "gh", args: ["pr", "view", String(pr), "--json", "comments"], cwd: repoRoot });
    if (res.exitCode !== 0) return null;
    try {
      const comments = JSON.parse(res.stdout || "{}").comments ?? [];
      // Both markers accepted on read — a lead spawned before the rename still emits the legacy one —
      // but only from an allowlisted author (DER-2737).
      return selectHandoffComment({ comments });
    } catch {
      return null;
    }
  }
  if (hostCfg) {
    await mkdir(join(runDir, "handoffs"), { recursive: true });
    const res = await runCommand({ command: "scp", args: [`${hostCfg.ssh}:${hostCfg.ledgerRoot}/${runId}/handoffs/${fname}`, localPath] });
    if (res.exitCode !== 0) {
      // Fallback (H7): the exact .rot<n> name can miss a REAL note (an off-by-one rotation number,
      // or a note written under an earlier rotation) — and synthesizing over a real handoff has
      // destroyed two handoffs in one run. Take the LATEST note for this issue instead of giving up.
      const ls = await runCommand({ command: "ssh", args: [hostCfg.ssh, `ls -t ${hostCfg.ledgerRoot}/${runId}/handoffs/${issueId}.rot*.md 2>/dev/null | head -1`] });
      const best = String(ls.stdout ?? "").trim();
      if (!best) return null;
      const cp = await runCommand({ command: "scp", args: [`${hostCfg.ssh}:${best}`, localPath] });
      if (cp.exitCode !== 0) return null;
    }
  }
  try {
    return (await readFile(localPath, "utf8")).trim() || null;
  } catch {
    // Same fallback locally (H7): prefer ANY real note for this issue over a synthesized one.
    try {
      const dir = join(runDir, "handoffs");
      const names = (await readdir(dir)).filter((n) => n.startsWith(`${issueId}.rot`) && n.endsWith(".md"));
      if (!names.length) return null;
      const stats = await Promise.all(names.map(async (n) => ({ n, m: (await stat(join(dir, n))).mtimeMs })));
      stats.sort((a, b) => b.m - a.m);
      return (await readFile(join(dir, stats[0].n), "utf8")).trim() || null;
    } catch {
      return null;
    }
  }
}

// A missing note must NEVER block a rotation — a lead that was wedged or killed could not write one,
// and that is precisely when a successor is most needed. Reconstruct from git + the ledger and mark
// the brief so the successor treats it as evidence rather than testimony.
async function synthesizeHandoffNote({ worktree, issueState, ssh = null }) {
  const it = issueState ?? {};
  const q = worktree ? shellQuote(worktree) : null;
  const log = q ? String((await runLocalOrRemote(`git -C ${q} log --oneline origin/main..HEAD`, ssh)).stdout ?? "").trim() : "";
  const stat = q ? String((await runLocalOrRemote(`git -C ${q} diff --stat origin/main...HEAD`, ssh)).stdout ?? "").trim() : "";
  return [
    `**disposition:** CLOSEOUT _(defaulted — the predecessor left no note, so nobody declared one)_`,
    ``,
    `**state of work — reconstructed from git + the ledger, NOT from the predecessor:**`,
    ``,
    `- status \`${it.status ?? "?"}\`${it.pr ? ` · PR #${it.pr}` : " · no PR opened"}${it.kickback_count ? ` · ${it.kickback_count} kickback round(s)` : ""}`,
    it.fileScope?.length
      ? `- declared fileScope: ${it.fileScope.join(", ")}`
      : `- **no \`plan_scope\` was ever declared** — this unit is unbounded. Declare one before your first push.`,
    ``,
    `**commits on this branch:**`,
    ``,
    "```",
    log || "(none — nothing is committed above origin/main)",
    "```",
    ``,
    `**diff vs origin/main:**`,
    ``,
    "```",
    stat || "(empty)",
    "```",
    ``,
    `**verification already run:** unknown — assume NONE and re-verify from scratch.`,
    ``,
    `**traps / dead ends:** unknown — none were recorded. Expect to rediscover some.`,
  ].join("\n");
}

// Env pairs that point a proxy-backed lead at CLIProxyAPI and remap the subagent aliases to that
// provider's models — so the UNCHANGED /work-lead brief (which dispatches sonnet/haiku subagents) runs
// the provider's models. Verified end-to-end (main-model passthrough, tool-use fidelity, and the
// DEFAULT_SONNET remap) against Kimi K3 + GPT-5.6-sol. Pure; the token stays a runtime `$(…)`.
export function proxyEnvPairs(cfg = {}) {
  const sub = cfg.subagentModel ?? cfg.leadModel;
  const research = cfg.researchModel ?? sub;
  // `reviewerBilling: "subscription"` moves the final adversarial review OUT of this process entirely:
  // it runs as a headless `claude -p` shell-out with the provider env UNSET, so it rides the Claude
  // OAuth subscription instead of the metered endpoint (operator decision 2026-07-24, spec §3.6b).
  // In that mode the in-process `opus` alias must NOT point at a premium metered model — nothing
  // should be able to reach $5/$25 by accident — so it resolves to the cheap subagent tier and the
  // brief's shell-out is the only ANTHROPIC review path (DER-3011 added a round-1 cross-vendor `codex
  // exec` pass beside it, which rides a different vendor's subscription entirely and never touches
  // these aliases). The ledger `token_usage` event it emits (role "reviewer", provider firstParty) is
  // what proves the Claude review actually happened.
  const subscriptionReviewer = cfg.reviewerBilling === "subscription";
  const reviewer = subscriptionReviewer ? sub : (cfg.reviewerModel ?? cfg.leadModel);
  // The lead process is launched with the concrete `--model ${leadModel}` id, so the alias slots below
  // only ever resolve SUBAGENT requests. OPUS is the FINAL-REVIEWER slot (operator decision 2026-07-23):
  // it maps to reviewerModel — default the lead's own tier — so the ONE final adversarial review subagent
  // runs same-tier as the lead (gpt lead -> sol reviewer, kimi lead -> k3 reviewer). Briefs restrict
  // 'opus' to that single final reviewer; every other subagent is 'sonnet'/'haiku', and model-less
  // subagents (which INHERIT the lead model) are banned — that inherit path is how a sol lead was first
  // observed burning sol on implementation subagents.
  // Token source: the CLIProxyAPI config by default; a `provider` type (openrouter) brings its own
  // runtime expression. `authTokenExpr` overrides both for a one-off type.
  const tokenExpr = cfg.authTokenExpr
    ?? (PROVIDER_KEY_VARS[cfg.provider] ? providerKeyExpr(PROVIDER_KEY_VARS[cfg.provider]) : null)
    ?? PROXY_KEY_EXPR;
  return [
    `ANTHROPIC_BASE_URL=${cfg.proxyUrl ?? PROXY_URL}`,
    `ANTHROPIC_AUTH_TOKEN=${tokenExpr}`,
    `ANTHROPIC_DEFAULT_OPUS_MODEL=${reviewer}`,
    `ANTHROPIC_DEFAULT_SONNET_MODEL=${sub}`,
    `ANTHROPIC_DEFAULT_HAIKU_MODEL=${research}`,
    // DO NOT set CLAUDE_CODE_SUBAGENT_MODEL here. It was added 2026-07-24 as "belt-and-braces" for
    // spawn paths that name no model alias — and it OVERRODE the explicit `model` parameter on the
    // Agent tool. MEASURED on the first dsv4 lead: the lead dispatched its adversarial review with
    // `model: "opus"`, correct prompt, review-sized context — and the subagent ran 19/19 calls on
    // deepseek-v4-flash. The opus slot was unreachable, so the quality gate silently degraded to the
    // cheapest model while the PR would have claimed an Opus review. The ANTHROPIC_DEFAULT_*_MODEL
    // alias remaps below are the verified mechanism and they respect an explicit alias; model-less
    // subagents stay banned by the brief, which is the only thing this var covered.
    // (The security-guidance gate that used to live here is now unconditional on every lead launch —
    // see SECURITY_GUIDANCE_LEAD_GATE and its rationale above buildLeadBootCommand.)
    // The CLI defaults unknown model ids to a 200k window belief and auto-compacts against it —
    // early for kimi-k3 (1M) / gpt-5.6-sol (~275k). contextWindow overrides that belief per lead type
    // (CLAUDE_CODE_MAX_CONTEXT_TOKENS, present in CLI >= 2.1.218); harmless no-op if the CLI ignores it.
    ...(cfg.contextWindow ? [`CLAUDE_CODE_MAX_CONTEXT_TOKENS=${cfg.contextWindow}`] : []),
    // Teach the context-wrap-nudge hook this lead type's REAL window (2026-07-25). Without it the hook
    // infers the window from the transcript model id, `gpt-5.6-sol` matches no rule, and it falls
    // through to the settings `[1m]` check and believes 1M — which is why a gpt lead read as 28% while
    // sitting at 102% of its actual 270K window and the nudge never fired. The three vars always
    // travel TOGETHER: band percentages without a window would break the hook's own window-scaling.
    // Claude lead types declare no contextWindow and pass none of these on purpose — the hook's
    // defaults are already 30/45 at 1M, which is exactly what rotationBands would say.
    ...(cfg.contextWindow
      ? [
          `WRAP_NUDGE_WINDOW=${cfg.contextWindow}`,
          `WRAP_NUDGE_GENTLE=${rotationBands(cfg.contextWindow, cfg).armPct}`,
          `WRAP_NUDGE_STRONG=${rotationBands(cfg.contextWindow, cfg).rotatePct}`,
        ]
      : []),
  ];
}

// Kill the security-guidance plugin's LLM review layers on EVERY lead, not just metered ones
// (widened 2026-07-25 from the `cfg.provider`-only gate added 2026-07-24). That plugin's Stop and
// commit hooks spawn their OWN claude-opus-4-7 sessions, which bill independently of the lead and are
// invisible in the TUI counter. Two measurements drove the widening:
//   - Cost: 99 hook sessions / 1,566 turns / 135.5M context tokens in 3 days = ~$199 at API rates
//     (~$2K/mo equivalent), 51% of it cache WRITES because each review re-establishes context cold.
//     On a metered lead that is cash ($2.28 of hook spend vs $1.16 of lead spend, 2026-07-24); on a
//     subscription lead it is quota — which is not free either, and is what exhausted the mini lane.
//   - Yield: across 679 sessions / 30 days the LLM layers produced SIX findings, and all of them came
//     from interactive main-repo sessions (.claude/hooks, scripts/, .github/workflows, .gitleaks.toml).
//     ZERO came from a lead worktree. Lead code already passes the mandatory opus-slot adversarial
//     reviewer, the Codex PR reviewer, the shepherd, and /secrev — four gates deep.
// ENABLE_PATTERN_RULES stays ON: the regex layer is free, makes no model call, and catches the
// hardcoded-secret / child_process_exec class at the edit site. Only the LLM layers are gated.
// The main repo is deliberately untouched — that is where all six findings came from.
const SECURITY_GUIDANCE_LEAD_GATE = "ENABLE_CODE_SECURITY_REVIEW=0";

// `proxyEnv` (from proxyEnvPairs) is set only for proxy-backed lead types; a Claude lead passes null and
// the launch is byte-identical to the pre-lead-type behavior apart from the two always-on lead flags
// (--no-chrome, and the security-guidance gate above). A proxy lead drops ANTHROPIC_API_KEY (so
// the env key can't shadow the proxy token) but sets ANTHROPIC_AUTH_TOKEN to the proxy key.
// `effort` (from the lead type's `effort` key) pins Claude Code's session effort level for this lead.
// It exists because effort is NOT provider-neutral. Claude Code sends its session effort to the API as
// `output_config.effort`, and CLIProxyAPI forwards that straight through as the OpenAI `reasoning.effort`
// level (verified 2026-07-25 in the gateway's own debug line: `thinking: original config from request |
// provider=codex model=gpt-5.6-sol mode=level budget=0 level=xhigh`). So a machine-global
// `effortLevel: "xhigh"` in ~/.claude/settings.json — a sane Claude default — silently becomes xhigh
// GPT-5.x reasoning on every proxy lead AND every one of its subagents, which is drastically slower for
// agentic tool-loop work without being better at it. Pin proxy lead types to `medium` instead; Claude
// lead types pass no flag and keep inheriting the user's setting exactly as before.
export function buildLeadBootCommand({ name, worktree, briefPath, runDir, model = "opus", proxyEnv = null, provider = null, effort = null }) {
  // ANTHROPIC_API_KEY handling differs by provider. CLIProxyAPI types UNSET it (`-u`, verified working).
  // OpenRouter requires it EXPLICITLY EMPTY: with the var unset, Claude Code falls back to the
  // macOS-keychain OAuth token and would send an Anthropic OAuth credential to a third-party endpoint
  // (401 at best, a credential leaving the machine at worst). `env VAR= …` sets it to the empty string.
  const keyClause = provider === "openrouter" ? "ANTHROPIC_API_KEY=" : "-u ANTHROPIC_API_KEY";
  const effortArg = effort ? ` --effort ${effort}` : "";
  // --no-chrome: leads never drive a browser. Measured 2026-07-25 over 3 days: 531 lead sessions made
  // ZERO claude-in-chrome calls (all 237 came from 4 orchestrator sessions), yet every lead carried the
  // Chrome system-prompt section + MCP instructions (~1,300 tok) on EVERY turn. UI verification is the
  // `e2e-pr` CI gate, not local Chrome. The orchestrator opts back in explicitly (buildOrchBootCommand
  // passes --chrome); the shepherd is left at the default deliberately (unmeasured, review-only role).
  // Both branches build their env prefix through claudeEnvPrefix, so neither can drop the transcript
  // persistence var (DER-2744 — the proxy branch used to, which is why every alt-model lane wrote no
  // transcript). `keyClause` and the provider env are the ONLY things that differ between them.
  const launch = assertForcesTranscripts(
    proxyEnv && proxyEnv.length
      ? `${claudeEnvPrefix({ keyClause, extra: [SECURITY_GUIDANCE_LEAD_GATE, ...proxyEnv] })} claude --dangerously-skip-permissions --no-chrome --model ${model}${effortArg}`
      : `${claudeEnvPrefix({ extra: [SECURITY_GUIDANCE_LEAD_GATE] })} claude --dangerously-skip-permissions --no-chrome --model ${model}${effortArg}`,
    "buildLeadBootCommand",
  );
  return {
    command: "cmux",
    // `launch` is returned so the SPAWN PATH can MEASURE the persistence guarantee off the real command
    // and stamp it on the ledger event, rather than asserting it from memory (DER-2744).
    launch,
    args: [
      "new-workspace",
      "--name", name,
      "--cwd", worktree,
      ...roleEnvArgs("lead", runDir),
      "--command", `${launch} "/work-lead ${briefPath}"`,
    ],
  };
}

// Remote lead: launched on another host via `cmux ssh`, which opens the remote session as a workspace
// in THIS cockpit. The remote shell sources the host's PAT file → GH_TOKEN (so the mini lead's
// `gh pr create` authors as the repo owner and Codex engages), cds to the remote worktree, and drops
// ANTHROPIC_API_KEY/AUTH so it runs on that host's Claude subscription. The token value stays on the
// mini (read from ghTokenFile at spawn) — never in a ledger event or a command the orchestrator logs.
// `proxyEnv`/`provider`/`effort` mirror buildLeadBootCommand exactly, so a proxy-backed lead type
// (kimi/gpt/dsv4) can run on a remote host that has been PROVISIONED with its own gateway + key files
// (the mini, 2026-07-25). This works because every token expression is a `$(…)` the REMOTE shell
// resolves at launch: the gateway config, or `<repo.repoPath>/<repo.envFile>` from work.config.json
// both resolve on the mini, and 127.0.0.1:8317 is the mini's OWN gateway. So the raw token still never
// crosses the wire, never lands in a ledger event, and never appears in a --dry-run preview — the same
// guarantee as a local lead, for the same reason. A Claude lead passes proxyEnv=null and its launch
// stays byte-identical to the pre-2026-07-25 behavior.
export function buildRemoteLeadBootCommand({ name, worktree, briefPath, ssh, ghTokenFile, model = "opus", runDir, proxyEnv = null, provider = null, effort = null }) {
  const tokenFile = ghTokenFile || "~/.work-mini.env";
  // Set the role env IN the remote command (a local lead gets these via `cmux --env`; a remote lead
  // can't, so export them in-shell). The SessionEnd learnings hook keys off WORK_ROLE=lead +
  // WORK_RUN_DIR (a mini-LOCAL run dir) to STAGE candidate learnings to run-learnings.jsonl
  // there — which the orchestrator pulls at run-end — instead of writing the global file. (The mini
  // must also have the learnings hook + <your-learnings-file>.md synced; see the mini setup runbook.)
  const roleEnv = `export WORK_ROLE=lead;${runDir ? ` export WORK_RUN_DIR=${runDir};` : ""}`;
  // Same keyClause rule as the local launcher: CLIProxyAPI types UNSET ANTHROPIC_API_KEY, OpenRouter
  // needs it EXPLICITLY EMPTY (unset ⇒ Claude Code falls back to that host's keychain OAuth token and
  // would ship an Anthropic credential to a third-party endpoint).
  const keyClause = provider === "openrouter" ? "ANTHROPIC_API_KEY=" : "-u ANTHROPIC_API_KEY";
  const effortArg = effort ? ` --effort ${effort}` : "";
  // --no-chrome and the security-guidance gate: same rationale as buildLeadBootCommand. A remote lead
  // has no browser to drive, and its review coverage is identical to a local lead's.
  // Same shared prefix as the local builder — which is what makes the comment above ("the same guarantee
  // as a local lead") true rather than aspirational. It used to MIRROR the local builder's bug instead:
  // the proxy branch omitted the persistence var here too, so a mini kimi/gpt/dsv4 lead — the least
  // observable lane in the whole harness — wrote no transcript at all (DER-2744).
  const launch = assertForcesTranscripts(
    proxyEnv && proxyEnv.length
      ? `${claudeEnvPrefix({ keyClause, extra: [SECURITY_GUIDANCE_LEAD_GATE, ...proxyEnv] })} claude --dangerously-skip-permissions --no-chrome --model ${model}${effortArg}`
      : `${claudeEnvPrefix({ extra: [SECURITY_GUIDANCE_LEAD_GATE] })} claude --dangerously-skip-permissions --no-chrome --model ${model}${effortArg}`,
    "buildRemoteLeadBootCommand",
  );
  const remote =
    `set -a; . ${tokenFile}; set +a; export GH_TOKEN="\${WORK_MINI_GITHUB_PAT}"; ${roleEnv} ` +
    `cd ${worktree}; ` +
    `${launch} "/work-lead ${briefPath}"`;
  // `ssh <host> -- <command>` runs the command in EXEC mode with NO pty, so the remote `claude`
  // sees pipes on fd 0/1/2, prints "no stdin data received", never renders its interactive TUI, and
  // the `/work-lead` slash command doesn't execute as an interactive command. Force a pty
  // (RequestTTY=force ≡ `ssh -tt`) so the remote lead is a real interactive session that STREAMS into
  // this cockpit pane — verified: the mini allocates `/dev/ttysNNN` under force.
  return { command: "cmux", launch, args: ["ssh", ssh, "--name", name, "--ssh-option", "RequestTTY=force", "--", remote] };
}

// Shepherd defaults to Opus (operator decision 2026-07-15): its inline fixes are sometimes deeply
// technical and merge with no second reviewer — asymmetric blast radius vs. a lead's mistakes. The
// kickback discipline (substantial/security-lane fixes still kick back to a lead) is unchanged.
export function buildShepherdBootCommand({ name, cwd, runId, runDir, model = "opus" }) {
  // Already correct (CLAUDE_LAUNCH carries the persistence var, and this builder has no provider branch
  // that could drop it) — gated anyway, because "this one happens to be right today" is exactly how the
  // lead builders' proxy branches came to be wrong (DER-2744). Fixing the CLASS means every builder
  // proves it, not just the two that were broken.
  const launch = assertForcesTranscripts(`${CLAUDE_LAUNCH} --model ${model}`, "buildShepherdBootCommand");
  return {
    command: "cmux",
    launch,
    args: [
      "new-workspace",
      "--name", name,
      "--cwd", cwd,
      ...roleEnvArgs("shepherd", runDir),
      "--command", `${launch} "/work-shepherd ${runId}"`,
    ],
  };
}

// Successor orchestrator (routine rotation, 2026-07-23): respawn-over-compact for the orchestrator
// itself. The outgoing orchestrator — at the context-wrap-nudge gentle band, or the tenure fallback —
// refreshes orch-handoff.md and boots a FRESH orchestrator in a CMUX workspace via `spawn-orch`; the
// successor resumes with `/work resume <run-id>` (ledger + handoff file, never the old transcript).
// --chrome is included so the §6 acceptance pass keeps its logged-in-Chrome capability. Model is
// intentionally OMITTED unless passed: the successor inherits the operator's default model (the
// orchestrator's model is whatever the operator launched, unlike the shepherd's pinned Opus).
export function buildOrchBootCommand({ name, cwd, runId, runDir, model = null }) {
  const modelArg = model ? ` --model ${model}` : "";
  // Gated for the same reason as the shepherd builder: the class, not the call site (DER-2744).
  const launch = assertForcesTranscripts(`${CLAUDE_LAUNCH} --chrome${modelArg}`, "buildOrchBootCommand");
  return {
    command: "cmux",
    launch,
    args: [
      "new-workspace",
      "--name", name,
      "--cwd", cwd,
      ...roleEnvArgs("orch", runDir),
      "--command", `${launch} "/work resume ${runId}"`,
    ],
  };
}

// Kickback model escalation (item 3, 2026-07-15 turnover). A re-spawn's model = max(original lane tier,
// tier implied by the FINDING content): a finding that touches a security/schema/packaging/cross-file-
// judgment surface pulls the fix up to Opus even if the original lead was Sonnet. The correction round is
// where subtle regressions slip in — and if the shepherd fixes inline instead, it merges with no second
// reviewer — so it warrants the stronger model. Keywords are deliberately broad (a false-Opus wastes
// tokens but never under-reviews). Returns `opusModel` when escalating, else the original model unchanged
// (already-Opus stays Opus). Pure. `opusModel` lets the cloud caller pass a concrete id (claude-opus-4-8).
const OPUS_KICKBACK_SIGNALS =
  /\b(security|auth|authz|authoriz|credential|secret|vault|token|rls|schema|migration|packaging|package\.json|money|billing|payment|ssrf|guard|permission|manifest|cross-file|invariant|tenant|isolation)\b/i;
export function escalateKickbackModel({ originalModel = "sonnet", findings = "", opusModel = "opus" } = {}) {
  if (String(originalModel).toLowerCase().includes("opus")) return originalModel; // already top tier
  if (OPUS_KICKBACK_SIGNALS.test(String(findings || ""))) return opusModel;
  return originalModel;
}

// ---------------------------------------------------------------------------
// Collision / eligibility engine (highest-risk pure logic)
// ---------------------------------------------------------------------------

// Repo-specific collision knobs — defaults are conservative; a per-repo `.claude/work.config.json` retunes
// them at startup via applyRepoConfig (so a 2nd repo drops in its own). `let`, not `const`, for that.
const COLLISION_DEFAULTS = {
  versionHolderPrefixes: ["apps/cli/", "docs/reference/"],
  versionHolderFiles: ["package.json", "VERSION"],
  serializedFiles: ["docs/STATE.md"],
  scopeKeySegments: 2,
  worktreeRoot: "/tmp/agent-work",
  // Path prefixes whose issues need a Docker-capable host (real Postgres for *.db.test.ts / RLS /
  // migrations). Feeds requiresDocker → pickHost's capability gate so a DB issue is never spilled to a
  // noDocker host (e.g. a mini whose lead-user can't install Docker). Retune per-repo.
  dockerScopePrefixes: ["packages/db/", "supabase/migrations/"],
};

// ---------------------------------------------------------------------------
// Repo identity — everything project-specific that used to be hardcoded here
// ---------------------------------------------------------------------------
// These five values were literals in this file, which is what made the harness un-shareable: the repo
// slug and the owner's GitHub login were baked into a cloud brief and a preflight assertion, and the
// path to the repo's `.env` was baked into the OpenRouter key expression. They all live in
// `.claude/work.config.json` now. Absent config ⇒ nulls, and every consumer degrades explicitly rather
// than asserting against someone else's identity.
//
//   repoSlug        "<owner>/<repo>" — used by cloud briefs' `gh api repos/...` report path
//   ownerLogin      the GitHub login commits must be authored by; preflight's gh-identity check
//   repoPath        absolute path to the repo on a lead host (where a provider key .env lives)
//   dbImageAssetId  optional release-asset id for a prebuilt Postgres image (registry CDNs are
//                   sandbox-blocked on cloud hosts, so the image is fetched as a release asset)
//   envFile         provider-key env file, relative to repoPath
const REPO_IDENTITY_DEFAULT = { repoSlug: null, ownerLogin: null, repoPath: null, dbImageAssetId: null, envFile: ".env" };
let REPO_IDENTITY = { ...REPO_IDENTITY_DEFAULT };
export function getRepoIdentity() { return REPO_IDENTITY; }
// How this repo lands PRs (DER-2753). Lives under `repo` in the config because it is a property of the
// repo, not of the run. Deliberately conservative all three ways: mergeMode null means "auto-detect,
// and refuse to guess if the probe fails"; squash is the least surprising strategy; and
// allowMergeWithoutChecks false keeps a repo with no CI un-mergeable until an adopter opts in.
const MERGE_POLICY_DEFAULT = { mergeMode: null, mergeStrategy: "squash", allowMergeWithoutChecks: false };
let MERGE_POLICY = { ...MERGE_POLICY_DEFAULT };
export function getMergePolicy() { return MERGE_POLICY; }
let VERSION_HOLDER_PREFIXES = [...COLLISION_DEFAULTS.versionHolderPrefixes];
let VERSION_HOLDER_FILES = new Set(COLLISION_DEFAULTS.versionHolderFiles);
let SERIALIZED_FILES = new Set(COLLISION_DEFAULTS.serializedFiles);
let SCOPE_KEY_SEGMENTS = COLLISION_DEFAULTS.scopeKeySegments;
let DEFAULT_WORKTREE_ROOT = COLLISION_DEFAULTS.worktreeRoot;
let DOCKER_SCOPE_PREFIXES = [...COLLISION_DEFAULTS.dockerScopePrefixes];

// Multi-host dispatch (DER-multihost): the orchestrator can overflow leads onto a second machine
// (the mini) via `cmux ssh`. `hosts` comes from `.claude/work.config.json` (applyRepoConfig); absent
// ⇒ a single local host at cap 2 (current single-host behavior). `let`, not `const`, for retune.
// DER-2749. `commitAuthor` is documented in work.config.example.json — with a note that deploy checks map
// commit author to an account — and until now NOTHING in the runner read it. `renderCloudBrief` accepted a
// `commitAuthor` argument and the cloud call site never passed one, so there was no source to pass even if
// it had. A cloud lead therefore committed as whatever the cloud environment defaulted to.
let COMMIT_AUTHOR = null;
// A PARTIAL identity is a config error, not a default: name-without-email renders
// `git config user.email ""`, which actively SETS a broken author — worse than leaving the environment's
// own default alone. Recorded here and refused where it matters (the cloud brief) rather than thrown from
// config parsing, which every subcommand runs and which must not die over a key it does not use.
let COMMIT_AUTHOR_ERROR = null;
export function getCommitAuthor() { return COMMIT_AUTHOR; }
export function getCommitAuthorError() { return COMMIT_AUTHOR_ERROR; }

const HOSTS_DEFAULT = { local: { cap: 2 } };
let HOSTS = { ...HOSTS_DEFAULT };
// 2.5 — a bare ESM import of this module answers these getters from module DEFAULTS, and a caller that
// never awaited `applyRepoConfig` cannot tell. Measured: an ad-hoc `node -e` `pickHost()` returned
// `null` purely from this and was nearly read as "nothing is dispatchable" — a HOLD derived from an
// unloaded config, not from the run.
//
// Re-verified before implementing: the plan says `applyRepoConfig(cfg)` "does not fix it". That is
// WRONG — awaited against a real repo root it updates all three getters correctly. The live defect is
// narrower and still real: nothing distinguishes "configured to the defaults" from "never configured".
//
// So the fix is a load MARKER, not a rewrite. These getters answer normally once config has been
// applied, and throw before that — a silent `{local}` is the worst of the three options, because it is
// the one that looks like an answer.
let CONFIG_APPLIED = false;
export function configApplied() { return CONFIG_APPLIED; }

// DER-3008 — WHICH config answered, and did it parse. `applyRepoConfig` reads
// `<repoRoot>/.claude/work.config.json` and swallows every failure into the built-in defaults, so an
// absent file, an unreadable one and a JSON syntax error are all indistinguishable from a repo that
// really is configured `{local:{cap:2}}` — and `{local}` has no `ssh`, so all three cross-host preflight
// checks skip every host and print NOTHING.
//
// Measured 2026-08-01: a `preflight` produced no `ssh-hostname:mini` / `skills-sync:mini` /
// `harness-digest:mini` line at all with no `--skip-probes` given, and the mini plainly configured. The
// run had cwd = a work-harness checkout, which carries no `.claude/work.config.json` — and preflight's
// own `harness-install-current` check tells the operator to run it from exactly there ("Run preflight
// from the checkout"). So the two halves of this command want different working directories and losing
// either half is silent. This records the resolution so preflight can print it instead of guessing.
let CONFIG_SOURCE = { path: null, loaded: false, error: null };
export function getConfigSource() { return { ...CONFIG_SOURCE }; }
function assertConfigLoaded(getter) {
  if (CONFIG_APPLIED) return;
  throw new Error(
    `${getter}() was called before applyRepoConfig() — refusing to answer from built-in defaults. ` +
    "Un-configured, this returns hosts={local}, leadTypes={claude} and preferHosts=[], which is " +
    "indistinguishable from a repo that really is configured that way: an ad-hoc `node -e` pickHost() " +
    "returned null purely from this and was nearly read as \"nothing is dispatchable\". " +
    "Call `await applyRepoConfig(<repoRoot>)` first (runSubcommand does this for you).",
  );
}

export function getHosts() { assertConfigLoaded("getHosts"); return HOSTS; }

// DER-3008 — which configured hosts the ssh-shaped preflight checks can actually reach, and WHY each of
// the others cannot be reached. Pure, so the "no host was checked" outcome is unit-testable without an
// ssh anywhere near it.
//
// All four cross-host loops used to inline `if (hostCfg.kind === "cloud" || !hostCfg.ssh) continue;`,
// which collapses four very different situations into one silent skip: this host, a cloud host with no
// ssh transport, a misconfigured host that SHOULD have one, and "there are no hosts because the config
// never loaded". Only the first two are benign, and a loop that prints nothing cannot tell an operator
// which one they got. Returning the skip REASONS is the whole point — the caller prints them.
export function crossHostTargets(hosts = {}) {
  const targets = [];
  const skipped = [];
  for (const [name, cfg] of Object.entries(hosts ?? {})) {
    const c = cfg ?? {};
    if (name === "local") { skipped.push({ name, why: "this host — measured directly by the checks above, not over ssh" }); continue; }
    if (c.kind === "cloud") { skipped.push({ name, why: "kind=cloud — no ssh transport; a cloud lead's harness is provisioned per session, not installed on a box we can hash" }); continue; }
    // A non-cloud host with no `ssh` alias is a CONFIG ERROR, not a benign skip: it is dispatchable (it
    // has a cap) yet nothing can ever verify what harness it runs. Flagged so the caller reds it.
    if (!c.ssh) { skipped.push({ name, why: `non-cloud host with no \`ssh\` alias in work.config.json — it can receive dispatch but its harness version and content can NEVER be checked. Add \`"ssh": "<alias>"\` or \`"kind": "cloud"\`.`, misconfigured: true }); continue; }
    targets.push([name, c]);
  }
  return { targets, skipped };
}

// Shepherd model override (item 8, 2026-07-15 turnover): `.claude/work.config.json` `shepherdModel`
// sets the shepherd's model without a per-run `--model` flag (the flag still wins). Null ⇒ the built-in
// "opus" default (operator decision 2026-07-15 — inline shepherd fixes merge with no second reviewer).
let SHEPHERD_MODEL = null;
export function getShepherdModel() { return SHEPHERD_MODEL; }

// Default lead-host preference (item 5, 2026-07-15 turnover): `.claude/work.config.json` `preferHosts`
// is the host order the orchestrator feeds pickHost for EVERY lead when the run set no `--host`/`--prefer`
// (a common default: cloud-first — local is reserved for the orchestrator + shepherd, mini is the macOS lane +
// fallback). pickHost still takes the effective preferHosts explicitly; this is the default value. Empty
// ⇒ unchanged local-first overflow. Absent hosts are ignored by pickHost, so it is safe on a 2nd repo.
let DEFAULT_PREFER_HOSTS = [];
export function getDefaultPreferHosts() { assertConfigLoaded("getDefaultPreferHosts"); return [...DEFAULT_PREFER_HOSTS]; }

// Lead-type registry (CLIProxyAPI comparison, 2026-07-23): named profiles so /work can spawn a lead on
// Kimi or GPT — routed through the local CLIProxyAPI gateway — instead of Claude, to compare lead
// performance. `claude` is the built-in default (direct subscription, unchanged). A proxy-backed entry
// carries { proxy:true, leadModel, subagentModel, researchModel?, hosts }; `hosts` is the allowlist
// pickHost/spawn-lead confine it to (proxy leads are local-only — the gateway is localhost). Config key:
// `.claude/work.config.json` `leadTypes`. See the README's lead-types section.
const LEAD_TYPES_DEFAULT = { claude: { proxy: false } };
let LEAD_TYPES = { ...LEAD_TYPES_DEFAULT };
export function getLeadTypes() { assertConfigLoaded("getLeadTypes"); return LEAD_TYPES; }

// Per-issue circuit breaker (2026-07-25 forensics). An issue with no spend ceiling can consume a
// whole night and land nothing: on run 20260725T020304Z FIVE issues burned 2.36B tokens — 76% of the
// run — with ZERO PRs merged (DER-2161 852M, DER-2160 716M, DER-2251 420M, DER-1363 284M, DER-2193
// 84M), and DER-2160 alone had taken ~922M across two nights and 9 lead respawns without merging.
// The measured baselines these thresholds come from: an EFFICIENT run merged PRs at ~83–107M tokens
// each (2026-07-19/20), and review rounds scale with diff size (<1k additions → 1.25 rounds; >7k →
// 5.67). So `warn` sits just above a healthy issue's whole budget and `trip` at ~2.5x it.
//
// A trip is NOT an auto-kill — the orchestrator owns the decision (split / re-scope / escalate to the
// operator). The breaker's job is to make an overrun IMPOSSIBLE TO MISS at the next wake, the same way
// kickbacks_pending made rotted kickbacks impossible to miss. Repo-tunable via
// `.claude/work.config.json` `budget`.
const BUDGET_DEFAULT = {
  warnTokens: 150_000_000,
  tripTokens: 250_000_000,
  warnRounds: 2,
  tripRounds: 3,
  // Delivered-vs-planned file drift the orchestrator re-authorizes above (checked against `gh pr view
  // --json changedFiles` by the caller — the ledger alone can't see the delivered diff).
  scopeDriftFactor: 1.5,
};
let BUDGET = { ...BUDGET_DEFAULT };
export function getBudget() { return BUDGET; }

// ---------------------------------------------------------------------------
// Assigned budget from a /prep-for-work run plan (2026-07-25)
// ---------------------------------------------------------------------------
// The missing half of the plan_scope contract. Today a lead invents its own scope number and grades
// itself against it; the run plan ASSIGNS one from a sizing pass over the real codebase, and this is
// what stamps it into the brief so the declaration is checked rather than self-graded.
//
// The plan schema lives with `~/.claude/skills/prep-for-work/prep-runner.mjs` (which owns sizing,
// splitting and validation). This lookup is deliberately re-implemented here rather than imported:
// work-runner is copied onto the mini and cloud hosts where the prep skill is not installed, and a
// brief that silently loses its budget because an import failed is worse than no budget at all.
// Keep the two in sync — prep-runner's `budgetFor` is the source of truth for the semantics.
// DER-2746 — the CANONICAL plan validator, loaded across the skill boundary.
//
// `validatePlan` in prep-for-work/prep-runner.mjs calls itself "the gate between 'we thought about it' and
// 'the run may start'", and `init-run` never called it: the validator was named only inside an error string
// ("run `prep-runner validate` before init-run") while the mechanical path waved the plan through. Proven
// by execution on 2c3ecbe — a plan with a dependency cycle, a NEGATIVE budget, a 98-file/11,537-addition
// over-cap unit, an unresolved founder gate and no plan review failed `prep-runner validate` with 11 errors
// and then passed `init-run` with exit 0. `write-brief` then stamped 98 files / ~11,537 additions into the
// lead's brief as its ASSIGNED budget — the exact size that brief's own copy names as the worst case the
// harness ever shipped. The weak local check that DID run only tested numeric presence, and
// `Number.isFinite(-5)` is `true`, which is how the negative budget passed.
//
// DYNAMIC, not static, for the reason spelled out on assignedBudgetFor below: work-runner.mjs is copied to
// mini and cloud hosts where the prep skill is not installed, and a static cross-skill import would fail at
// MODULE LOAD there — breaking every subcommand to protect one. `init-run` is async and orchestrator-only
// (it is the command that creates the run, so it necessarily runs where /prep-for-work ran), so the load
// happens exactly where the file exists. Same reasoning as preflight's dynamic session-end-telemetry load,
// which exists to avoid a cycle; here prep-runner imports Node builtins only, so there is no cycle to break.
//
// A load FAILURE throws rather than skipping the check: the same install ships both skills (install.sh
// copies skills/ wholesale and runs both suites), so an unloadable validator means a broken install, and a
// gate that silently skips itself when it cannot load is exactly the shape this issue is about.
export async function loadPlanValidator({ specifier = "../prep-for-work/prep-runner.mjs" } = {}) {
  let mod;
  try {
    mod = await import(specifier);
  } catch (err) {
    throw new Error(
      `the canonical plan validator (${specifier}, prep-for-work/prep-runner.mjs) could not be loaded: ` +
      `${err instanceof Error ? err.message : String(err)}. The same install ships both skills — re-run install.sh. ` +
      `Refusing to start a run on a plan nothing validated.`,
    );
  }
  if (typeof mod.validatePlan !== "function") {
    throw new Error(`the canonical plan validator (${specifier}) exports no validatePlan — this install's skills are skewed; re-run install.sh`);
  }
  return mod.validatePlan;
}

export function assignedBudgetFor(plan, issueId, extraBundle = []) {
  const issues = plan?.issues ?? [];
  if (!issues.length || !issueId) return null;
  const owner = issues.find((i) => i.id !== issueId && (i.bundleWith ?? []).includes(issueId));
  const primary = owner ?? issues.find((i) => i.id === issueId);
  if (!primary) return null;
  // A bundle is ONE branch, ONE PR — so its budget is the sum of its members'. `extraBundle` is the
  // dispatch-time --bundle, which may add members the plan didn't bundle (an operator call).
  const memberIds = [...new Set([
    primary.id,
    ...(primary.bundleWith ?? []),
    ...extraBundle,
  ])].filter((id) => id !== undefined);
  const members = memberIds.map((id) => issues.find((i) => i.id === id)).filter(Boolean);
  const files = members.reduce((s, m) => s + (Number(m.budget?.files) || 0), 0);
  const additions = members.reduce((s, m) => s + (Number(m.budget?.additions) || 0), 0);
  if (!files && !additions) return null;
  return {
    files,
    additions,
    issues: members.map((m) => m.id),
    surfaces: [...new Set(members.flatMap((m) => m.surfaces ?? []))],
    riskLane: primary.riskLane ?? null,
    versionAxes: [...new Set(members.flatMap((m) => m.versionAxes ?? []))],
    dependsOn: [...new Set(members.flatMap((m) => m.dependsOn ?? []))].filter((d) => !memberIds.includes(d)),
    notes: primary.notes ?? null,
    splitFrom: primary.splitFrom ?? null,
  };
}

// The brief block. Rendered into BOTH templates (local and cloud) — the cloud brief never asking for a
// scope at all is precisely why DER-2161 shipped 98 files with none on record.
export function renderAssignedBudget(b, { ledgerLine = null } = {}) {
  if (!b) return [];
  const lines = [
    `## 🎯 Assigned budget — ${b.files} files / ~${b.additions} additions`,
    ``,
    `This is **assigned**, not self-declared: it comes from a pre-run sizing pass over the real codebase (\`/prep-for-work\`), and it is the size at which a PR merges in about one review round. Measured across 25 PRs: <1k additions → 1.25 rounds · 2.6k–5k → 3.38 · >7k → 5.67.`,
    ``,
    `- Your \`plan_scope\` declaration is **checked against this number**, not graded by you. Declare your real file list; if it exceeds the assignment, that is a finding to report, not a number to quietly raise.`,
    `- If the work genuinely does not fit: **stop before your first commit**, re-emit \`plan_scope\` with \`"overBudget": true\` and a one-line reason${ledgerLine ? "" : " in the PR body"}, and say so in your hand-off. The orchestrator splits it — you do not absorb it.`,
    `- Do **not** widen scope to "finish the area". A PR that outgrows its budget buys review rounds at roughly 100–150M tokens each.`,
  ];
  if (b.surfaces?.length) lines.push(`- **Surfaces this unit is sized for:** ${b.surfaces.join(", ")}. A surface not on that list is a scope change — report it.`);
  if (b.versionAxes?.length) lines.push(`- **Version-holder axes you hold:** ${b.versionAxes.join(", ")}. Bump above \`git show origin/main:<file>\`, never above your stale branch, and re-derive after every rebase.`);
  if (b.dependsOn?.length) lines.push(`- **Builds ON:** ${b.dependsOn.join(", ")} — use that issue's MERGED shape; do not invent a parallel one.`);
  if (b.splitFrom) lines.push(`- Split from **${b.splitFrom}**: your siblings cover the rest. Ship YOUR slice; do not helpfully complete theirs.`);
  if (b.notes) lines.push(`- **Plan note:** ${b.notes}`);
  lines.push(``);
  return lines;
}

// Price fallbacks for models whose sessions report `cost_usd_estimate: null`. As of 2026-07-25 ~40% of
// deepseek reports and ALL kimi/gpt reports are unpriced, so the run's dollar figure silently excluded
// them (run 20260725T020304Z's $1,062 omitted DER-2160's ~716M tokens entirely). Deliberately EMPTY by
// default: guessing a rate would launder a fabricated number into a cost report. Populate real rates in
// `.claude/work.config.json` `modelPrices` as { "<model-id-substring>": {input,output,cache_creation,
// cache_read} } in USD per MILLION tokens. Until then the gap is reported explicitly (unpriced_tokens /
// unpriced_models) rather than nulling the whole run's cost.
const MODEL_PRICES_DEFAULT = {};
let MODEL_PRICES = { ...MODEL_PRICES_DEFAULT };
export function getModelPrices() { return MODEL_PRICES; }

// USD for one report's by_model block, using MODEL_PRICES (per-million rates). Returns null when NO
// constituent model has a configured price — the caller then counts the whole report as unpriced.
// Longest-substring match so "deepseek/deepseek-v4-pro" can be priced by a "deepseek-v4-pro" key.
// ── #7 (codex gate, 2026-08-12): PARTIAL pricing must stay visible ───────────────────────────────
// `estimateCostFromPrices` answers one number, so a report mixing a priced and an unpriced model
// returned a non-null cost — and the caller's `if (derived != null) continue;` then skipped the
// unpriced accounting for that WHOLE report. Executed counterexample: 1M claude-opus-5 input tokens
// plus 1M kimi-k3 input tokens reported `cost_is_partial:false, unpriced_tokens:0, unpriced_models:[]`.
// The kimi spend disappeared — while `.claude/work.config.json`'s own comment promises those models
// stay VISIBLE in `unpriced_models`. A cost meter that silently drops a model is the exact defect the
// price table was added to fix, one layer up.
//
// `priceBreakdown` is the honest primitive: it reports what it could price AND what it could not.
// `estimateCostFromPrices` stays as the number-only wrapper its existing callers expect.
export function priceBreakdown(by_model = {}, prices = MODEL_PRICES) {
  const keys = Object.keys(prices ?? {});
  let cost = 0;
  const priced = [];
  const unpriced = [];
  for (const [model, u] of Object.entries(by_model ?? {})) {
    const key = keys.length
      ? keys.filter((k) => String(model).includes(k)).sort((a, b) => b.length - a.length)[0]
      : undefined;
    if (!key) { unpriced.push(model); continue; }
    priced.push(model);
    const p = prices[key] ?? {};
    cost +=
      ((Number(u?.input) || 0) * (Number(p.input) || 0) +
        (Number(u?.output) || 0) * (Number(p.output) || 0) +
        (Number(u?.cache_creation) || 0) * (Number(p.cache_creation) || 0) +
        (Number(u?.cache_read) || 0) * (Number(p.cache_read) || 0)) / 1_000_000;
  }
  return { cost: Math.round(cost * 10000) / 10000, priced, unpriced };
}

export function estimateCostFromPrices(by_model = {}, prices = MODEL_PRICES) {
  const b = priceBreakdown(by_model, prices);
  return b.priced.length ? b.cost : null;
}

// True when an issue's file-scope requires a Docker-capable host — real Postgres for *.db.test.ts,
// RLS, or a migration. pickHost consults this so a DB issue is never spilled to a noDocker host.
// Prefixes are repo-tunable (DOCKER_SCOPE_PREFIXES); the `/migrations/` + `.db.test.ts` heuristics are
// built-in (they hold across repos). Pure.
export function requiresDocker(fileScope = []) {
  return fileScope.some(
    (p) =>
      DOCKER_SCOPE_PREFIXES.some((pre) => p.startsWith(pre)) ||
      p.includes("/migrations/") ||
      p.endsWith(".db.test.ts"),
  );
}

// Host capability gates. A host is macOS-capable unless its config explicitly marks it a non-darwin OS
// (cloud is Ubuntu → `os:"linux"`); an absent `os` is treated as the local darwin machine, so
// single-host repos keep working. Mirrors the noDocker opt-out.
function hostIsMacOS(cfg) {
  return !cfg.os || cfg.os === "darwin";
}

// Overflow selection: prefer local (or the caller's preferHosts), then any other host in config order; a
// host is eligible when it exists, is not enabled:false, its in-flight lead count is below its cap, AND
// it clears every capability gate the issue asks for:
//   - needsDocker  → skip a `noDocker:true` host (db/RLS/migration work needs a real Postgres container),
//   - needsMacOS   → skip a non-darwin host (seatbelt/keychain/launchd/Mac-runner work — cloud is Linux).
// A gated issue therefore HOLDS (returns null) rather than spilling to an incapable host: it waits for a
// capable slot to free. Returns null (hold the issue) when no eligible host exists. Pure — the orchestrator
// feeds it live in-flight counts, needsDocker (from requiresDocker on the file-scope), and needsMacOS (an
// orchestrator judgment flag on the queue entry — file-scope alone can't detect a macOS-only issue).
// Operator concentration (DER-1834): `/work <project> --host <name>` FORCES every lead onto <name>
// (records run_started.forceHost) — the ONLY host considered, and an explicit opt-in that bypasses a
// config `enabled:false` (but still honors cap + BOTH capability gates, so a DB/macOS issue on an
// incapable forced host HOLDS rather than failing). `--prefer <name>` (preferHosts) is the softer form:
// try those first, then overflow to the default local-first order. The orchestrator's default preferHosts
// come from config (`getDefaultPreferHosts()`); passing none keeps the legacy
// local-first overflow, so existing single/multi-host behavior is unchanged.
// `allowHosts` (a lead type's host allowlist) confines selection to those hosts — a proxy-backed lead
// (kimi/gpt) is thereby held off cloud/mini even under a forceHost, since the localhost gateway is only
// reachable on `local`. Null/absent ⇒ no confinement (Claude leads run anywhere), unchanged behavior.
export function pickHost({ hosts = {}, inflightByHost = {}, needsDocker = false, needsMacOS = false, forceHost = null, preferHosts = [], allowHosts = null } = {}) {
  let order;
  if (forceHost) {
    order = [forceHost];
  } else {
    const prefer = (preferHosts ?? []).filter((h) => hosts[h]);
    const rest = ["local", ...Object.keys(hosts).filter((h) => h !== "local")].filter((h) => !prefer.includes(h));
    order = [...prefer, ...rest];
  }
  if (Array.isArray(allowHosts)) order = order.filter((h) => allowHosts.includes(h));
  for (const name of order) {
    const cfg = hosts[name];
    if (!cfg) continue;
    // A forced host is an explicit operator opt-in → bypass enabled:false (but not cap / capability gates).
    if (cfg.enabled === false && name !== forceHost) continue;
    if (needsDocker && cfg.noDocker) continue; // capability gate: this host can't run db/migration work
    if (needsMacOS && !hostIsMacOS(cfg)) continue; // capability gate: darwin-only work never spills to Linux (cloud)
    const cap = typeof cfg.cap === "number" ? cfg.cap : 0;
    if ((inflightByHost[name] ?? 0) < cap) return name;
  }
  return null;
}

// Which remote hosts a `watch --pull-hosts <spec>` cycle should tail into the canonical ledger. `auto`
// = every enabled non-local host; a csv names specific ones. Disabled hosts, `local` (the canonical
// ledger itself), and absent names are always excluded. Pure. Folding this into watch is what makes a
// mini lead's `pr_opened` surface without a hung on-wake pull (a mini event never wakes the LOCAL
// ledger, so the old on-wake-only pull deadlocked until the 4-min timeout every cycle).
export function hostsToPull({ hosts = {}, spec } = {}) {
  if (!spec) return [];
  const names = spec === "auto"
    ? Object.keys(hosts).filter((h) => h !== "local")
    : spec.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s && s !== "local");
  // A cloud host (kind:"cloud") has no ssh-reachable local ledger — it reports through the draft-PR
  // lifecycle folded by `reconcile-pr-events`, NOT by ssh-tailing. Excluding it here stops `watch
  // --pull-hosts auto` from wasting a failing ssh every ~45s on a cloud entry (item 5/6 follow-on).
  return names.filter((n) => hosts[n] && hosts[n].enabled !== false && hosts[n].kind !== "cloud");
}

export function isVersionHolder(fileScope = []) {
  return fileScope.some((p) => {
    if (VERSION_HOLDER_FILES.has(p)) return true;
    if (p.split("/").pop() === "version.ts") return true;
    return VERSION_HOLDER_PREFIXES.some((prefix) => p.startsWith(prefix));
  });
}

export function touchesStateMd(fileScope = []) {
  return fileScope.some((p) => SERIALIZED_FILES.has(p));
}

// Conservative overlap: two file sets overlap if any pair shares its first SCOPE_KEY_SEGMENTS path
// segments (default 2 = package-level, e.g. `apps/web`) or is the exact same file. Intentionally
// over-serializes rather than risk a real merge collision; raise SCOPE_KEY_SEGMENTS (repo config)
// for finer granularity + more parallelism at some collision risk.
function scopeKey(p) {
  return p.split("/").slice(0, SCOPE_KEY_SEGMENTS).join("/");
}
export function globsOverlap(a = [], b = []) {
  const keysB = new Set(b.map(scopeKey));
  const filesB = new Set(b);
  return a.some((p) => keysB.has(scopeKey(p)) || filesB.has(p));
}

// Given queued issues (in dispatch order), currently in-flight leads, and the cap,
// return the ids that may be spawned NOW without violating a collision rule.
// Every CMUX workspace ever recorded for an issue's leads (DER-2517/DER-2521). `spawn-lead --kickback`
// used to leave the predecessor's workspace (and its live claude) running — two sessions editing ONE
// worktree corrupts the branch (hit twice on 2026-07-26: old lead 1h51m + new lead 34s on the same
// tree), and the panes leaked on every kickback/rotation until `reap`, which only closed the LATEST
// ref. Pure: distinct workspace_refs from the issue's spawn events, oldest first.
export function workspaceRefsToClose(events = [], issueId) {
  const refs = [];
  for (const e of events) {
    if (!e || e.issue !== issueId || !e.workspace_ref) continue;
    if (e.type !== "lead_spawned") continue;
    if (!refs.includes(e.workspace_ref)) refs.push(e.workspace_ref);
  }
  return refs;
}

// Full-run workspace sweep plan (DER-2517 + operator report 2026-07-26: panes leaked from kickback
// respawns, rotations, re-launched shepherds AND re-launched orchestrators — 22 accumulated workspaces
// were a co-factor in the cmux main-thread freeze that took the whole cockpit down). Pure: given the
// ledger + folded state, return { close, keep } of workspace_refs. Rules:
//   - a DONE (merged/reaped) issue keeps nothing — every ref it ever had is closable;
//   - an ACTIVE issue keeps only its CURRENT workspace_ref; earlier spawns' refs close;
//   - shepherd_spawned / orch_spawned keep only the LATEST ref each (the incumbents);
//   - refs in `keepRefs` are never closed (callers protect themselves / the operator's panes).
// Only refs recorded in THIS run's ledger are ever candidates — the sweep cannot touch panes it
// didn't create.
export function sweepPlan({ events = [], state = {}, keepRefs = [] } = {}) {
  const keep = new Set(keepRefs.filter(Boolean));
  const close = [];
  const consider = (ref, keepIt) => {
    if (!ref || keep.has(ref)) return;
    if (keepIt) keep.add(ref);
    else if (!close.includes(ref)) close.push(ref);
  };
  const issues = state.issues ?? {};
  for (const [id, it] of Object.entries(issues)) {
    const refs = workspaceRefsToClose(events, id);
    const active = ACTIVE_STATUSES.has(it.status);
    for (const ref of refs) consider(ref, active && ref === it.workspace_ref);
    if (it.workspace_ref && !refs.includes(it.workspace_ref)) consider(it.workspace_ref, active);
  }
  for (const type of ["shepherd_spawned", "orch_spawned"]) {
    const refs = events.filter((e) => e?.type === type && e.workspace_ref).map((e) => e.workspace_ref);
    refs.forEach((ref, i) => consider(ref, i === refs.length - 1));
  }
  // A ref can be recorded both as an old lead ref and the incumbent elsewhere — keep wins.
  return { close: close.filter((r) => !keep.has(r)), keep: [...keep] };
}

// 2.6 — an entry with an EMPTY fileScope disables every collision rule at once, silently.
//
// `globsOverlap([], anything)` is false, `isVersionHolder([])` is false, `touchesStateMd([])` is false —
// so a scopeless issue conflicts with NOTHING and the whole list reads as eligible. That is not a
// hypothetical: the run-plan file uses `surfaces`/`versionAxes`, NOT `fileScope`, so feeding its units
// straight in yields `[]` for every one of them and every collision guard silently switches off. No
// `fileScope` is recorded anywhere for queued issues — not in plan.md, not in the ledger.
//
// A guard that cannot see its own input must refuse, not pass — so this DEFAULTS to refusing.
//
// It shipped defaulting to `strict:false` with a comment claiming "the dispatch path passes strict".
// An adversarial review found that false: `computeEligible` has NO caller inside this runner at all —
// it is invoked by the orchestrator from `SKILL.md`'s prose, so nothing was ever going to pass the
// flag, and the guard could not fire on the one path that matters. A guard nothing calls is not a
// guard, and a comment asserting otherwise is worse than no comment.
//
// `strict:false` remains available for a caller that legitimately computes over in-flight units whose
// scope arrives later via `plan_scope` — but it must now be asked for out loud.
export function computeEligible({ issues = [], inflight = [], cap = 2, strict = true } = {}) {
  const chosen = inflight.map((i) => ({ id: i.id, fileScope: i.fileScope ?? [] }));
  const result = [];
  if (strict) {
    const scopeless = issues.filter((i) => !(i.fileScope ?? []).length).map((i) => i.id);
    if (scopeless.length) {
      throw new Error(
        `computeEligible: ${scopeless.length} unit(s) have an EMPTY fileScope (${scopeless.join(", ")}) — refusing. ` +
        "An empty scope overlaps nothing, so EVERY collision rule (glob overlap, version-holder, state.md) " +
        "silently passes and the whole list reads as eligible. Note the run-plan file uses `surfaces`/" +
        "`versionAxes`, not `fileScope` — map them before dispatching, or record a real fileScope per unit.",
      );
    }
  }
  for (const issue of issues) {
    if (chosen.length >= cap) break;
    const scope = issue.fileScope ?? [];
    const conflict = chosen.some(
      (c) =>
        globsOverlap(scope, c.fileScope) ||
        (isVersionHolder(scope) && isVersionHolder(c.fileScope)) ||
        (touchesStateMd(scope) && touchesStateMd(c.fileScope)),
    );
    if (conflict) continue;
    chosen.push({ id: issue.id, fileScope: scope });
    result.push(issue.id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Ledger — append-only events + state fold
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wire protocol (DER-2748) — identity, ordering and version on every event
// ---------------------------------------------------------------------------
// Until 0.2.0 `appendEvent` stamped exactly ONE field (`ts`), and every integrity property the harness
// needed was faked downstream: dedup by ad-hoc content hashing (`contentHash`), the watch cursor by line
// COUNT, and version skew between hosts not detected at all. The primitives below are the substrate:
//
//   schema_version  the ledger wire version this line was written under. ABSENT = the legacy pre-0.2.0
//                   shape, which is KNOWN and tolerated forever (real ledgers exist, and two of the
//                   harness's own producers — the SessionEnd telemetry hook and the context-report hook —
//                   still append raw legacy lines). A value this build does not know is FOREIGN and
//                   blocks dispatch, because folding it "best effort" silently mis-reads another host.
//   event_id        uuid v7, minted ONCE at the origin. Time-ordered on purpose: a later cursor can sort
//                   and range on it (DER-2741) instead of guessing a line count.
//   source_id       host:pid:nonce — the WRITER, not the host. The nonce matters: pids recycle and two
//                   machines share pid numbers, so pid alone cannot make (source_id, seq) an identity.
//   seq             monotonic per source, handed out in-process. Because a source is a PROCESS, seq needs
//                   no lock file and concurrent appenders from different processes cannot collide.
//   received_at     when THIS ledger accepted the line, always the local clock — the field that finally
//                   separates event time from arrival time for backfilled/relayed events.
//   harness_version stamped on `run_started` and `host_heartbeat` only (see VERSION_BEARING_EVENT_TYPES).
//
// A relay (pull-host / a cloud fold) PRESERVES event_id/source_id/seq/schema_version and re-stamps only
// received_at. Re-minting identity at a relay is what made an exactly-once merge impossible.
export const LEDGER_SCHEMA_VERSION = 1;

// The fields `appendEvent` stamps. Enumerated ONCE because three other things must agree with this list:
//   - `contentHash` (the DER-2519 dedup key) must EXCLUDE every one of them, or a stored event and its
//     fresh re-derivation can never produce the same seen-key and the 129-duplicate bug returns;
//   - `sanitizeCommentEvent` must never accept one from a PR comment (see PROTOCOL_EVENT_FIELDS);
//   - a relay must preserve the identity subset rather than re-mint it.
export const PROTOCOL_EVENT_FIELDS = ["schema_version", "event_id", "source_id", "seq", "received_at", "harness_version"];
export const STAMPED_EVENT_FIELDS = ["ts", ...PROTOCOL_EVENT_FIELDS];
const STAMPED_FIELD_SET = new Set(STAMPED_EVENT_FIELDS);

// Only these types carry a harness-version claim. Keeping it off every event keeps the line small; the
// two that carry it are the two that exist to answer "what code is this host running against our
// ledger?" — a run's opening statement, and a per-host heartbeat for a host that never runs `init-run`.
export const VERSION_BEARING_EVENT_TYPES = new Set(["run_started", "host_heartbeat"]);

// uuid v7: 48-bit big-endian unix-ms prefix + 74 random bits, so ids from any source sort by creation
// time as plain strings. Node has no built-in v7 (randomUUID is v4, which sorts randomly).
export function uuidv7(ms = Date.now(), rand = randomBytes(10)) {
  const b = Buffer.alloc(16);
  b.writeUIntBE(Math.max(0, Math.min(ms, 0xffffffffffff)), 0, 6);
  Buffer.from(rand).copy(b, 6, 0, 10);
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let SOURCE_ID = null;
let SOURCE_SEQ = 0;

// One process = one source. `WORK_SOURCE_ID` exists so a wrapper can name a writer explicitly (and so
// this is testable); everything else is derived, never configured, because a source_id an operator can
// mistype is a source_id two writers can share.
export function getSourceId() {
  if (SOURCE_ID) return SOURCE_ID;
  const env = process.env.WORK_SOURCE_ID;
  if (typeof env === "string" && env.trim()) {
    SOURCE_ID = env.trim().slice(0, 120);
    return SOURCE_ID;
  }
  const host = String(hostname() || "host").split(".")[0] || "host";
  SOURCE_ID = `${host}:${process.pid}:${randomBytes(3).toString("hex")}`;
  return SOURCE_ID;
}

let HARNESS_VERSION_CACHE = null;

// VERSION at the repo root is the single source of truth (repo-contract.test.mjs pins it against the
// changelog) — read it, never hardcode it. Fails CLOSED to the literal string "unknown", which counts
// as a DISTINCT version for skew purposes: an "unknown" host alongside a "0.2.0" host is exactly the
// situation this is meant to refuse.
//
// `install.sh` copies `VERSION` to `$CLAUDE_HOME` alongside `skills/` and `hooks/`, and refuses to
// install at all if `$SRC/VERSION` is missing — so an installed host resolves this via the
// `../../VERSION` candidate below the same as a checkout does. `WORK_HARNESS_VERSION` remains the
// override for a host installed some other way (e.g. copied by hand, no `install.sh` run).
export function getHarnessVersion() {
  const env = process.env.WORK_HARNESS_VERSION;
  if (typeof env === "string" && env.trim()) return env.trim();
  if (HARNESS_VERSION_CACHE) return HARNESS_VERSION_CACHE;
  for (const rel of ["../../VERSION", "../VERSION", "../../../VERSION"]) {
    try {
      const v = readFileSync(new URL(rel, import.meta.url), "utf8").trim();
      if (/^\d+\.\d+\.\d+/.test(v)) {
        HARNESS_VERSION_CACHE = v;
        return v;
      }
    } catch { /* try the next candidate layout */ }
  }
  return "unknown";
}

// The VERSION file sitting beside the code that is ACTUALLY EXECUTING — no env override, no process
// cache, no fallback string. `getHarnessVersion()` answers a different question ("what does this run
// report itself as", which is what every event stamp and status line carries) and is deliberately
// overridable; that makes it unusable for the one check whose whole job is to catch a version claim
// that disagrees with the bytes on disk. Returns null when no candidate resolves, so "I could not read
// it" stays distinguishable from a version — never the literal "unknown", which compares as a value.
export function readRunningHarnessVersion() {
  for (const rel of ["../../VERSION", "../VERSION", "../../../VERSION"]) {
    try {
      const v = readFileSync(new URL(rel, import.meta.url), "utf8").trim();
      if (/^\d+\.\d+\.\d+/.test(v)) return { version: v, path: fileURLToPath(new URL(rel, import.meta.url)) };
    } catch { /* try the next candidate layout */ }
  }
  return null;
}

// Pure-ish (reads the process's source id + clock): the exact line `appendEvent` writes. Exported so the
// stamp can be asserted without touching a filesystem.
export function stampEvent(event, { now = new Date() } = {}) {
  const e = { ...event };
  if (!e.ts) e.ts = now.toISOString();
  // ORIGIN vs RELAY. An event that already carries an event_id was minted somewhere else (a mini's local
  // ledger, a successor's replay) — its identity, sequence and schema are FACTS about that writer and
  // must survive the relay, or the same event arriving twice can never be recognized as one event.
  const relayed = typeof e.event_id === "string" && e.event_id.length > 0;
  if (!relayed) {
    e.event_id = uuidv7(now.getTime());
    e.source_id = getSourceId();
    SOURCE_SEQ += 1; // assigned synchronously, BEFORE any await — two racing appends must not share a seq
    e.seq = SOURCE_SEQ;
    e.schema_version = LEDGER_SCHEMA_VERSION;
    // A version claim is only ever THIS process's own reading of VERSION. Stamped unconditionally for
    // these types (never read from the payload) so an `append`-ed heartbeat cannot vouch for a version
    // it isn't running.
    if (VERSION_BEARING_EVENT_TYPES.has(e.type)) e.harness_version = getHarnessVersion();
  }
  // Always ours: this is the receiving ledger's arrival time. A re-pull of the same remote line therefore
  // differs from its predecessor in received_at only — and dedups on event_id.
  e.received_at = now.toISOString();
  return e;
}

// DER-2779 — ledgers this process has already attested to (or found already attested), keyed by run dir.
// Per-PROCESS, so at most one ledger read per run dir no matter how many events an invocation appends.
const ATTESTED_LEDGERS = new Set();

// The host that WROTE an event: the `source_id` prefix (`host:pid:nonce`), never the `host` field. `host`
// is an operator-supplied LABEL — `heartbeat --host mini` run locally records the LOCAL version under the
// mini's name (see the `heartbeat` case), so deduping on it would let a mislabel suppress a real
// attestation. Legacy lines carry no source_id and are attributable to nobody.
function attestingHost(event) {
  const src = typeof event?.source_id === "string" ? event.source_id : "";
  const host = src.split(":")[0];
  return host || null;
}

// The two things the write path needs to know about a ledger's existing version claims, from ONE scan:
//   anyStamped   does any version-bearing event carry a REAL version? A legacy pre-stamp `run_started`
//                carries none, and an explicit "unknown" is not a claim either — same rule
//                ledgerProtocolVerdict applies to an attestation, for the same reason (below).
//   alreadyOurs  is this exact (host, version) already on record? Then there is nothing to add.
// Scanned as text with a cheap pre-filter rather than parsed in full: only version-bearing lines carry
// the field, and this runs on the write path of a file that reaches five figures of lines on a long run.
async function scanLedgerVersionClaims(runDir, host, version) {
  const out = { anyStamped: false, alreadyOurs: false };
  let raw;
  try { raw = await readFile(join(runDir, "events.jsonl"), "utf8"); }
  catch { return out; } // no ledger yet — this process's write is about to create it
  for (const line of raw.split("\n")) {
    if (!line.includes('"harness_version"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // a torn tail is not an attestation
    if (!VERSION_BEARING_EVENT_TYPES.has(e?.type)) continue;
    const claimed = typeof e.harness_version === "string" && e.harness_version ? e.harness_version : UNKNOWN_HARNESS_VERSION;
    if (claimed !== UNKNOWN_HARNESS_VERSION) out.anyStamped = true;
    // `alreadyOurs` is checked on EVERY version-bearing line, "unknown" included — a host that cannot read
    // its own VERSION still attests (against a ledger that names one it is the host we can least identify),
    // and if its own prior attestation did not count as "already ours" it would append a fresh
    // `unknown` heartbeat on every CLI invocation, forever. Returning early is safe: `alreadyOurs`
    // suppresses the write regardless of what `anyStamped` would have become further down the file.
    if (claimed === version && attestingHost(e) === host) {
      out.alreadyOurs = true;
      return out;
    }
  }
  return out;
}

// DER-2779 — a process that WRITES to a ledger says, in that ledger, which harness code it is running.
// The dispatch gate can attest synthetically (see currentVersionAttestation), but only for the process
// that happens to be dispatching; every other writer — a `watch` loop, an `append`, a `pull-host` relay —
// used to fold and extend a run while leaving no version claim at all, which is what made skew detectable
// only by luck. Attesting on the first write means the ledger records the fact at the moment it becomes
// true, and `state`/`watch`/`work-metrics` see it without anyone remembering to run `heartbeat`.
//
// Deduped per (run, HOST, VERSION), not per source_id. Per source_id is one extra line per CLI
// invocation, and this runner is invoked on every poll cycle — the ledger would roughly double in size to
// re-state a fact that had not changed. The fact being attested is "host H is running version V against
// this run"; a second process on the same host at the same version adds nothing to it.
//
// It is an APPEND, never a precondition: nothing here can refuse a write, so no path loses the ability to
// record. Three cases are deliberately silent:
//   - a version-bearing ORIGIN event ALREADY carries this process's own reading of VERSION, so it IS the
//     attestation — and prepending another would put a host_heartbeat ahead of a brand-new run's own
//     `run_started`. (A RELAYED event vouches for whoever wrote it, not for us, so a relay still attests.)
//   - a ledger with NO stamped version claim — the LEGACY pre-stamp shape. Writing "0.2.0" next to a
//     `run_started` that claims nothing does not DISCOVER skew, it MANUFACTURES it: nobody knows what the
//     opening host was running, and the pair would read as mixed and block every later dispatch on a run
//     DER-2748 tolerates by design ("ABSENT is the legacy pre-0.2.0 shape — KNOWN, tolerated, and must
//     never block"). This is the exact rule ledgerProtocolVerdict applies to an attestation, applied to
//     the write side so the two cannot drift: attest only where the claim is comparable.
//   - this (host, version) already on record — a second process on the same host adds no fact.
// The SessionEnd telemetry hook and the context report append raw legacy lines without coming through
// here at all, so they are untouched either way.
async function attestHarnessVersion(runDir, event) {
  if (ATTESTED_LEDGERS.has(runDir)) return null;
  ATTESTED_LEDGERS.add(runDir); // BEFORE the recursive append below, or the heartbeat re-enters forever
  const relayed = typeof event?.event_id === "string" && event.event_id.length > 0;
  if (!relayed && VERSION_BEARING_EVENT_TYPES.has(event?.type)) return null;
  const host = attestingHost({ source_id: getSourceId() }) ?? "host";
  const version = getHarnessVersion();
  const { anyStamped, alreadyOurs } = await scanLedgerVersionClaims(runDir, host, version);
  if (!anyStamped || alreadyOurs) return null;
  return appendEvent(runDir, {
    actor: "harness", type: "host_heartbeat", host,
    note: "auto-attestation on this process's first write to this run (DER-2779)",
  });
}

export async function appendEvent(runDir, event) {
  await mkdir(runDir, { recursive: true });
  await attestHarnessVersion(runDir, event);
  const e = stampEvent(event);
  await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(e)}\n`, "utf8");
  return e;
}

// Exactly-once read (DER-2748). Drops a line only on EXACT IDENTITY collision: an `event_id` already
// seen, or a `(source_id, seq)` pair already seen. Legacy lines carry neither and are NEVER dropped.
//
// Deliberately NOT the issue's literal "a lower seq than already seen is ignored". `readEvents` sorts by
// effective ts (DER-2520), so a source whose clock steps BACKWARD yields seq 1,3,2 in fold order — the
// literal rule would then delete seq 2, a real event, permanently. Clock skew is a diagnostic
// (`ledgerProtocolVerdict().out_of_order`), never a licence to discard. `(source_id, seq)` still catches
// a replay whose event_id was regenerated, which is the case a pure id check would miss.
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

// Protocol health of a ledger, as data. Pure. Two independent verdicts:
//   FOREIGN schema_version ⇒ not ok. We cannot claim to fold a wire version we don't implement, and a
//     silent best-effort fold is the failure mode this whole unit exists to remove. Unparseable counts as
//     foreign (fail closed) rather than "probably fine".
//   MIXED harness_version ⇒ not ok. More than one distinct version across `run_started`/`host_heartbeat`
//     means two hosts are running different harness code against ONE ledger. "unknown" is a distinct
//     value on purpose.
// `legacy_events` and `out_of_order` are reported but never fatal.
//
// DER-2779 — `attestedVersion` folds THE CALLING PROCESS's own version in as one more version source.
// Without it the comparison only ever ran between versions ALREADY WRITTEN to the ledger, so the one host
// whose code is about to act was the one host the gate never looked at: a 9.9.9 checkout dispatching into
// a run whose ledger only records 0.1.0 was NOT refused, while the identical skew with one extra
// heartbeat in the file WAS. The comparator was right; nothing put the current process into it.
//
// The attestation cannot manufacture skew out of a ledger that makes no version claim of its own: it is
// compared only against RECORDED, STAMPED versions, never against the pseudo-version "unknown". A
// pre-stamp (legacy) ledger records "unknown" for its `run_started`, and letting an attestation refuse
// those would delete exactly the tolerance DER-2748 shipped ("ABSENT is the legacy pre-0.2.0 shape —
// KNOWN, tolerated, and must never block"). The carve-out has a stated cost, in ONE direction only: a
// host that cannot read its own VERSION also records "unknown", so it is indistinguishable from a legacy
// line and does not by itself block a later dispatch (`install.sh` refusing to install without a VERSION
// file is what keeps that rare). The reverse — THIS process reporting "unknown" against a ledger that
// carries a real version — is NOT carved out and still refuses, because that is the case where the host
// about to write is the one we cannot identify.
export const UNKNOWN_HARNESS_VERSION = "unknown";

// How the current process names itself among a ledger's version sources. Exported so the dispatch gate
// and its tests agree on one shape; the label leads with `source_id` because THAT is the writer identity
// (`host:pid:nonce`), while an event's `host` field is only an operator-supplied label.
export function currentVersionAttestation() {
  const sourceId = getSourceId();
  return { attestedVersion: getHarnessVersion(), attestedBy: `THIS PROCESS (${sourceId})` };
}

export function ledgerProtocolVerdict(events = [], { attestedVersion = null, attestedBy = "THIS PROCESS" } = {}) {
  const schemaVersions = new Set();
  const foreign = new Set();
  let legacy = 0;
  const versionSources = new Map(); // harness_version -> Set of "source_id/host" labels
  const maxSeq = new Map();
  const outOfOrder = [];
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.schema_version === undefined || e.schema_version === null) legacy += 1;
    else if (Number.isInteger(e.schema_version) && e.schema_version >= 1 && e.schema_version <= LEDGER_SCHEMA_VERSION) schemaVersions.add(e.schema_version);
    else foreign.add(typeof e.schema_version === "number" ? e.schema_version : String(e.schema_version));
    if (VERSION_BEARING_EVENT_TYPES.has(e.type)) {
      const v = typeof e.harness_version === "string" && e.harness_version ? e.harness_version : "unknown";
      if (!versionSources.has(v)) versionSources.set(v, new Set());
      versionSources.get(v).add(e.host ? `${e.host} (${e.source_id ?? "?"})` : (e.source_id ?? "?"));
    }
    if (typeof e.source_id === "string" && e.source_id && Number.isFinite(e.seq)) {
      const seen = maxSeq.get(e.source_id);
      if (seen !== undefined && e.seq < seen) outOfOrder.push({ source_id: e.source_id, seq: e.seq, after: seen });
      else maxSeq.set(e.source_id, e.seq);
    }
  }
  // DER-2779 — recorded FIRST (what the ledger says), then the attestation folded in on top, so the two
  // stay separable: `recorded_harness_versions` is what has actually been written, and only that decides
  // whether the run is already poisoned (below).
  const recordedVersions = [...versionSources.keys()].sort();
  const attested = typeof attestedVersion === "string" && attestedVersion ? attestedVersion : null;
  if (attested && recordedVersions.some((v) => v !== UNKNOWN_HARNESS_VERSION)) {
    if (!versionSources.has(attested)) versionSources.set(attested, new Set());
    versionSources.get(attested).add(attestedBy);
  }
  const harnessVersions = [...versionSources.keys()].sort();
  const reasons = [];
  if (foreign.size) {
    reasons.push(
      `foreign schema_version in the ledger: ${[...foreign].join(", ")} (this harness implements ${LEDGER_SCHEMA_VERSION}). ` +
      `Refusing rather than folding a wire version it cannot interpret — upgrade this host, or run against a ledger written by a build you have.`,
    );
  }
  if (harnessVersions.length > 1) {
    // POISON SEMANTICS, stated where the operator meets the refusal. The distinction is load-bearing and
    // is drawn on RECORDED versions only: >1 recorded means the divergent claim is already in an
    // append-only file with no supersession, so it can never be withdrawn and the flag is permanent. One
    // recorded + a divergent attestation is the repairable case — nothing has been written yet, and
    // saying "permanent" there would send an operator hunting for damage that does not exist.
    reasons.push(
      `mixed harness version on ONE ledger: ${harnessVersions.map((v) => `${v} [${[...versionSources.get(v)].join(", ")}]`).join(" vs ")}. ` +
      `Different harness code folding one ledger is how two hosts silently disagree about a run's state. ` +
      (recordedVersions.length > 1
        ? `Those claims are already IN the ledger, which is append-only and has no supersession — they cannot be withdrawn, ` +
          `so this run stays skewed and EVERY later dispatch on it needs --allow-version-skew. ` +
          `That is the intended conservative behaviour, NOT a corrupt ledger: do not delete, truncate or rewrite events.jsonl. `
        : `This process has not written its version into the ledger yet, so the skew is still repairable: put this host on the ` +
          `run's version and it is gone. Dispatching with --allow-version-skew instead WRITES this version into the append-only ` +
          `ledger, and from that point every later dispatch on this run needs the flag too. `) +
      `Re-install the lagging host (install.sh) so every host reports the same VERSION, or pass --allow-version-skew to proceed DELIBERATELY.`,
    );
  }
  return {
    ok: reasons.length === 0,
    schema_version: LEDGER_SCHEMA_VERSION,
    schema_versions: [...schemaVersions].sort((a, b) => a - b),
    foreign_schema_versions: [...foreign].sort(),
    legacy_events: legacy,
    harness_versions: harnessVersions,
    recorded_harness_versions: recordedVersions,
    attested_harness_version: attested,
    harness_version_sources: Object.fromEntries([...versionSources].map(([v, s]) => [v, [...s].sort()])),
    out_of_order: outOfOrder,
    reasons,
  };
}

// Subcommands that COMMIT MORE WORK to a ledger. A version-skewed ledger must stop here rather than at
// the post-mortem: everything downstream of a dispatch (the fold the new session reads, the events it
// appends) assumes one wire protocol. NOT exempt for --dry-run — unlike `assertExistingRunDir` (where a
// preview genuinely cannot fork a ledger), a dry-run prints a boot command the operator then pastes, so
// a preview that hides the skew hides it at exactly the moment it would be acted on.
// Every command that commits MORE work to a ledger. `spawn-cloud` and `steer-cloud` belong here for the
// same reason `spawn-lead` does: a mixed-version ledger must refuse dispatch, and a steer is a DELIVERY
// (it writes the kickback_relayed that closes a round), not a read.
// EXPORTED so the disabled-host family test can derive its roster from the runner itself (DER-4050). This
// is the set of subcommands that DISPATCH an agent, which is exactly the family the forced-only rule binds:
// a new member added here must also declare how it treats an `enabled:false` host, or that test fails.
export const VERSION_GATED_SUBCOMMANDS = new Set(["spawn-lead", "spawn-cloud", "steer-cloud", "spawn-shepherd", "spawn-orch", "rotate-lead", "rotate-shepherd"]);

export function assertLedgerProtocolCompatible(verdict, subcommand, { allowSkew = false } = {}) {
  if (!verdict || verdict.ok) return;
  // `--allow-version-skew` is a DELIBERATE degrade for harness-version skew (mid-run upgrade of one
  // host, and the operator has decided the difference is immaterial). A FOREIGN schema_version is never
  // overridable: there is no degraded mode for "lines this build cannot parse".
  const foreign = verdict.foreign_schema_versions?.length ? verdict.reasons.filter((r) => r.startsWith("foreign schema_version")) : [];
  const blocking = allowSkew ? foreign : verdict.reasons;
  if (!blocking.length) return;
  // The trailing pointer must not overstate what `state` shows. `state` reports the LEDGER's verdict, so
  // when the divergence is this process's own attestation (DER-2779) it will NOT appear there — naming
  // this process's version here is the only way the operator gets the whole comparison from the refusal.
  throw new Error(
    `refusing to run "${subcommand}" against this ledger:\n` +
      blocking.map((r) => `  - ${r}`).join("\n") +
      (verdict.attested_harness_version
        ? `\n  (this is DER-2748/DER-2779 — THIS process reports harness ${verdict.attested_harness_version}; \`state\`'s "protocol" block shows what the LEDGER records)`
        : `\n  (this is DER-2748 — see \`state\`'s "protocol" block for the full picture)`),
  );
}

// Timestamp-ordered fold (DER-2520). The ledger file is append-only, but appends are NOT in event-time
// order: `--pull-hosts` backfills a remote host's HISTORICAL events at the tail (observed 2026-07-26:
// ~100 mini events from 13:17–17:03Z appended at 17:29Z), and the fold used to run in file order — so
// a late-arriving historical `pr_opened` overwrote a later `pr_merged` and two demonstrably-merged
// units silently regressed (`done` dropped 15 → 14; one unit lost its status entirely). Appending
// fresh corrective events could not repair it, because they too folded before the stale tail.
// Stable sort by effective ts; an event with no/unparseable ts inherits its predecessor's effective ts
// (carry-forward), so legacy ts-less lines keep their file position instead of jumping to the front.
export function sortEventsByTs(events = []) {
  let carry = -Infinity;
  const keyed = events.map((e, i) => {
    const t = e && e.ts ? Date.parse(e.ts) : NaN;
    if (Number.isFinite(t)) carry = t;
    return { e, i, t: carry };
  });
  keyed.sort((a, b) => a.t - b.t || a.i - b.i);
  return keyed.map((k) => k.e);
}

// ---------------------------------------------------------------------------
// Tolerant ledger reads (DER-2738) — a torn line must not brick the recovery surface
// ---------------------------------------------------------------------------
// `readEvents` used to be `body.split("\n").filter(trim).map(JSON.parse)`. It is the SINGLE choke point
// every consumer reads through, so ONE torn final append — a writer killed mid-line — threw out of
// `state`, `watch`, `reap` and every reconciliation at exactly the moment the ledger is needed for
// crash recovery. A `--pull-hosts` backfill or a killed writer is routine, not exotic.
//
// Tolerance here is deliberately NOT "wrap JSON.parse in try/catch and move on". A torn line is the
// SIGNATURE OF A CONCURRENT WRITER and a malformed complete record is real content that did not fold —
// silently dropping either is data loss nobody can see. So every dropped line is:
//   1. classified — an unterminated TAIL line is a writer mid-append (retried once), a terminated
//      malformed line is a corrupt RECORD (quarantined);
//   2. preserved — its RAW BYTES go to `<runDir>/ledger-quarantine.jsonl` so it stays hand-repairable;
//   3. surfaced — `state.ledger` (durable, in state.json), `watch`'s `pending.ledger_damage` on EVERY
//      wake, and one stderr line per newly-seen damage signature.
// This is the DER-2745 `telemetry_gap` precedent ("record the gap, don't swallow it") and the DER-2748
// `state.protocol` precedent (ledger health is data a successor can read) applied to bad bytes.
//
// The quarantine is a SIDECAR, never an appended `ledger_damage` event: appending to a ledger whose last
// line is torn would glue the new line onto the partial one, i.e. the damage report would itself create
// a second damaged line. (That is also why the damage is contained to one line and no further: the next
// append merges into the torn line and every line after it is clean.)
export const LEDGER_QUARANTINE_FILE = "ledger-quarantine.jsonl";
// Enough of the line to repair it by hand; a runaway line can't blow up the sidecar.
export const LEDGER_RAW_KEEP = 4096;
// One re-read for an unterminated tail: it may still be being written. Short on purpose — a torn tail
// that outlives this is reported (transiently) rather than waited on, and clears itself on the next read.
const LEDGER_TORN_RETRY_MS = 25;

// DER-2776 — the REMOTE half of the same fact. `pull-host` cannot re-read 25ms later: the next look at a
// mini's ledger is the next pull cycle (~45s). So an unterminated remote tail is HELD — the cursor does
// not advance past it and it folds on a later cycle — which fixes the loss but buys a new blind spot: a
// writer that died mid-line is now retried, silently, forever. The held fragment therefore carries a
// FIRST-SEEN time, and past this threshold it stops being "the writer is busy" and becomes a fact about
// the run. Persisted per host (below) because every `pull-host` is a fresh PROCESS — an in-memory clock
// would restart every cycle and could never age.
export const LEDGER_HELD_STALE_MS_DEFAULT = 300000; // 5 min ≈ 6 pull cycles at watch's ~45s
export function ledgerHeldStaleMs() {
  // `WORK_LEDGER_HELD_STALE_MS=` (exported empty, which a shell does routinely) must read as UNSET, not
  // as 0 — `Number("")` is 0, and a 0 threshold marks every live writer's mid-append as a dead one.
  const rawStr = String(process.env.WORK_LEDGER_HELD_STALE_MS ?? "").trim();
  if (!rawStr) return LEDGER_HELD_STALE_MS_DEFAULT;
  const raw = Number(rawStr);
  if (!Number.isFinite(raw) || raw < 0) return LEDGER_HELD_STALE_MS_DEFAULT;
  return Math.floor(raw);
}
export const LEDGER_HELD_FILE_PREFIX = "sync-held.";
export const LEDGER_HELD_FILE_SUFFIX = ".json";

// The work-done seam (DER-2741 #16). Counters, not wall-clock: the review benchmark was a 100k-event /
// 9.8 MB ledger at ~310 ms/read, ~120× over a 5-minute idle watch, and the property that has to hold is
// "work per poll scales with NEW activity, not with total history" — which is a count, not a duration.
// `fullReads`/`fullBytes` are whole-ledger parses; `tailReads`/`tailBytes` are incremental tail reads.
export const LEDGER_READ_STATS = { fullReads: 0, fullBytes: 0, tailReads: 0, tailBytes: 0, statCalls: 0, polls: 0, linesParsed: 0, badLines: 0 };
export function resetLedgerReadStats() {
  for (const k of Object.keys(LEDGER_READ_STATS)) LEDGER_READ_STATS[k] = 0;
  return LEDGER_READ_STATS;
}

// What "a bad line" MEANS, in one place. work-metrics.mjs carries a byte-identical copy (it is standalone
// by contract and imports nothing from here) pinned by an agreement test in work-metrics.test.mjs — two
// instruments that disagree about the same ledger is the DER-2581 defect class.
//
// `no_type` is a bad line, not a kept one: an event with no `type` can never fold into state, and the
// second reader has always dropped it. Making both readers drop it — visibly, into quarantine — is what
// keeps the two honest about one ledger.
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

// Pure. Splits a ledger body into accepted events and located damage. `terminated:false` means the body
// does NOT end in a newline, so its last line is UNTERMINATED — a writer caught mid-append, reported as
// `torn_tail` rather than as a corrupt record. Offsets are BYTE offsets from `baseOffset`, so the
// reported location is the one an operator can seek to.
export function parseLedgerLines(text, { baseOffset = 0, terminated = true } = {}) {
  const events = [];
  const bad = [];
  const parts = String(text ?? "").split("\n");
  let offset = baseOffset;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const lineOffset = offset;
    offset += Buffer.byteLength(part) + 1; // + the "\n" that split() removed
    if (!part.trim()) continue; // blank lines are not damage — a trailing newline is normal
    LEDGER_READ_STATS.linesParsed += 1;
    const v = classifyLedgerLine(part);
    if (v.ok) {
      events.push(v.event);
      continue;
    }
    LEDGER_READ_STATS.badLines += 1;
    const isLast = i === parts.length - 1;
    bad.push({
      reason: isLast && !terminated ? "torn_tail" : v.reason,
      offset: lineOffset,
      line: i + 1,
      bytes: Buffer.byteLength(part),
      raw: part.slice(0, LEDGER_RAW_KEEP),
      raw_truncated: part.length > LEDGER_RAW_KEEP,
      ...(v.detail ? { detail: v.detail } : {}),
    });
  }
  return { events, bad };
}

// A torn tail is TRANSIENT by nature (the writer may simply not be done), so it is recorded but never
// latches the durable banner. A malformed COMPLETE record is permanent damage and does latch, until an
// operator clears the sidecar.
const TRANSIENT_DAMAGE_REASONS = new Set(["torn_tail"]);

const LEDGER_HEALTH = new Map(); // ledger path -> the last read's damage, in-process
const LEDGER_DAMAGE_SEEN = new Map(); // ledger path -> Set of signatures already recorded/warned by THIS process

// Identity of one piece of damage, so re-reading a damaged ledger 200 times records it once.
export function ledgerDamageSignature(rec) {
  return `${rec.reason}:${rec.offset ?? "-"}:${createHash("sha256").update(String(rec.raw ?? "")).digest("hex").slice(0, 16)}`;
}

function quarantinePathFor(ledgerFile) {
  return join(dirname(ledgerFile), LEDGER_QUARANTINE_FILE);
}

// Best-effort by design: a read-only run dir must still be READABLE. The health record lands in-process
// regardless, so `state`/`watch` surface the damage even when the sidecar cannot be written.
async function recordLedgerDamage(ledgerFile, bad, extra = {}) {
  LEDGER_HEALTH.set(ledgerFile, {
    quarantined: bad.filter((b) => !TRANSIENT_DAMAGE_REASONS.has(b.reason)).length,
    torn_tail: bad.filter((b) => TRANSIENT_DAMAGE_REASONS.has(b.reason)).length,
    first_bad_offset: bad.length ? (bad[0].offset ?? null) : null,
    reasons: [...new Set(bad.map((b) => b.reason))],
    at: new Date().toISOString(),
  });
  if (!bad.length) return;
  const seen = LEDGER_DAMAGE_SEEN.get(ledgerFile) ?? new Set();
  LEDGER_DAMAGE_SEEN.set(ledgerFile, seen);
  const sidecar = quarantinePathFor(ledgerFile);
  let onDisk = new Set();
  try {
    const body = await readFile(sidecar, "utf8");
    for (const l of body.split("\n")) {
      if (!l.trim()) continue;
      try { onDisk.add(ledgerDamageSignature(JSON.parse(l))); } catch { /* a torn quarantine line: re-record */ }
    }
  } catch { /* no sidecar yet */ }
  const fresh = bad.filter((b) => {
    const sig = ledgerDamageSignature(b);
    return !seen.has(sig) && !onDisk.has(sig);
  });
  if (!fresh.length) return;
  const detectedAt = new Date().toISOString();
  for (const b of fresh) seen.add(ledgerDamageSignature(b));
  try {
    await appendFile(
      sidecar,
      fresh.map((b) => `${JSON.stringify({ ...extra, ...b, ledger: ledgerFile, detected_at: detectedAt, transient: TRANSIENT_DAMAGE_REASONS.has(b.reason) })}\n`).join(""),
      "utf8",
    );
  } catch { /* unwritable run dir — the in-process health record above still surfaces it */ }
  // LOUD, once per signature per process: the operator running the command that hit the damage sees it
  // without having to go looking for state.json.
  //
  // …but only for damage that NEEDS an operator. A purely transient batch is an unterminated tail line
  // that will fold itself, and DER-2776 makes those routine on the pull path (one per cycle for as long
  // as a mini is mid-append). "Repair or acknowledge them there" is the wrong instruction for a line
  // nobody has to touch, and an always-on warning is one operators learn to skim.
  const transientOnly = fresh.every((b) => TRANSIENT_DAMAGE_REASONS.has(b.reason));
  try {
    process.stderr.write(
      transientOnly
        ? `NOTE: ledger ${ledgerFile} — ${fresh.length} UNTERMINATED tail line(s) held back, not folded YET ` +
          `(a writer caught mid-append). Raw bytes kept in ${sidecar}; they fold on their own once the ` +
          `line is completed. Nothing to repair unless they stop clearing (see state.ledger.held_fragment_stale).\n`
        : `WARNING: ledger ${ledgerFile} — ${fresh.length} line(s) did NOT fold into state ` +
          `(${[...new Set(fresh.map((b) => b.reason))].join(", ")}; first at byte ${fresh[0].offset ?? "?"}). ` +
          `Raw bytes kept in ${sidecar} — repair or acknowledge them there.\n`,
    );
  } catch { /* stderr closed */ }
}

// ---------------------------------------------------------------------------
// Held remote fragments (DER-2776)
// ---------------------------------------------------------------------------
// One tiny JSON file per host, next to `sync-cursor.<host>`, recording the unterminated tail line the
// last pull held back. It exists so the age of that hold survives the process that observed it: `pull-host`
// runs fresh every cycle, and `readLedgerHealth` usually runs in a DIFFERENT process again (`state`,
// `watch`), so neither can see how long the line has been stuck without something on disk saying so.
function heldFragmentPathFor(runDir, host) {
  return join(runDir, `${LEDGER_HELD_FILE_PREFIX}${host}${LEDGER_HELD_FILE_SUFFIX}`);
}

// One host's current hold. DER-2839: the failure path needs to REPORT the hold it is preserving —
// returning `held: null` there would launder "I did not look" into "there is nothing held" one layer
// above the shell defect this exists to close.
//
// Three outcomes, deliberately distinct (Codex review of this change, #2 — the first draft collapsed the
// last two into `null` and so reproduced the very laundering it exists to prevent, one layer up):
//
//   null                            no hold file — a fact, established by ENOENT
//   { unreadable: true, … }         a hold EXISTS but cannot be vouched for (unreadable / malformed)
//   the record                      a hold we can age
//
// The middle case matches `readHeldFragments`, whose header already states the rule for the whole family:
// "FAIL-CLOSED on an unreadable/undatable record: a hold we cannot age is one we cannot vouch for, so it
// counts as stale rather than silently disappearing."
async function readHeldFragmentFor(runDir, host) {
  let raw;
  try {
    raw = await readFile(heldFragmentPathFor(runDir, host), "utf8");
  } catch (err) {
    // Only a genuinely ABSENT file is "no hold". A permission error or any other read failure is a hold
    // whose state is unknown — never absence.
    return err?.code === "ENOENT" ? null : { unreadable: true, bytes: null, first_seen_at: null, stale: true };
  }
  try {
    const rec = JSON.parse(raw);
    // PARSING is not the bar — AGEING is (Codex round 2, #3: `{}` parsed fine, so it slipped past as a
    // valid record and reported `{bytes: null, first_seen_at: null}` with no `unreadable` flag, which
    // reads as a hold in good standing). `readHeldFragments` sets the same rule for the family: a record
    // it cannot date is stale. A hold whose `first_seen_at` will not parse is one we cannot vouch for.
    if (rec && typeof rec === "object" && !Array.isArray(rec)
      && Number.isFinite(Date.parse(String(rec.first_seen_at ?? "")))) return rec;
  } catch { /* malformed ⇒ unreadable, below */ }
  return { unreadable: true, bytes: null, first_seen_at: null, stale: true };
}

// `fragment: null` ⇒ nothing is held any more: the record is DELETED, which is how the signal
// self-clears the moment the writer finishes the line. `cursor` is the post-pull cursor, i.e. the identity
// of the held line — a fragment at a NEW cursor is a different line and starts its own clock, so a host
// that tears one line after another cannot inherit an ancient first-seen time.
//
// CALLER CONTRACT (DER-2839): only ever call this after a read that SUCCEEDED. `fragment: null` means
// "the remote had no partial line", which is a fact only a completed read can establish — a failed read
// knows nothing, and passing null for it deletes a live damage signal.
async function recordHeldFragment(runDir, host, { fragment, cursor }) {
  const path = heldFragmentPathFor(runDir, host);
  if (fragment == null) {
    await rm(path, { force: true }).catch(() => { /* best-effort: a read-only run dir must still pull */ });
    return null;
  }
  let prev = null;
  try { prev = JSON.parse(await readFile(path, "utf8")); } catch { /* absent or unreadable ⇒ new clock */ }
  const now = new Date().toISOString();
  const sameLine = prev && typeof prev.first_seen_at === "string" && prev.cursor === cursor;
  const rec = {
    host,
    cursor,
    first_seen_at: sameLine ? prev.first_seen_at : now,
    last_seen_at: now,
    bytes: Buffer.byteLength(String(fragment)),
    raw: String(fragment).slice(0, LEDGER_RAW_KEEP),
    raw_truncated: String(fragment).length > LEDGER_RAW_KEEP,
  };
  try { await writeFile(path, `${JSON.stringify(rec)}\n`, "utf8"); }
  catch { /* unwritable run dir — the pull still succeeded; only the age clock is lost */ }
  return rec;
}

// Every host's currently-held fragment, aged. FAIL-CLOSED on an unreadable/undatable record: a hold we
// cannot age is one we cannot vouch for, so it counts as stale rather than silently disappearing.
async function readHeldFragments(runDir, now = Date.now()) {
  let names;
  try { names = await readdir(runDir); } catch { return []; }
  const staleMs = ledgerHeldStaleMs();
  const out = [];
  for (const n of names) {
    if (!n.startsWith(LEDGER_HELD_FILE_PREFIX) || !n.endsWith(LEDGER_HELD_FILE_SUFFIX)) continue;
    const fallbackHost = n.slice(LEDGER_HELD_FILE_PREFIX.length, n.length - LEDGER_HELD_FILE_SUFFIX.length);
    const file = join(runDir, n);
    let rec = null;
    try { rec = JSON.parse(await readFile(file, "utf8")); } catch { /* unreadable ⇒ below */ }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      out.push({ host: fallbackHost, file, first_seen_at: null, age_ms: null, bytes: null, stale: true });
      continue;
    }
    const firstSeen = Date.parse(String(rec.first_seen_at ?? ""));
    const ageMs = Number.isFinite(firstSeen) ? Math.max(0, now - firstSeen) : null;
    out.push({
      host: typeof rec.host === "string" && rec.host ? rec.host : fallbackHost,
      file,
      first_seen_at: rec.first_seen_at ?? null,
      age_ms: ageMs,
      bytes: typeof rec.bytes === "number" ? rec.bytes : null,
      stale: ageMs === null || ageMs >= staleMs,
    });
  }
  // Oldest first. `MAX_SAFE_INTEGER` (not Infinity) for an unaged record, so two of them subtract to 0
  // rather than to NaN — a NaN comparator is not a stable "equal", it is undefined ordering.
  return out.sort((a, b) => (b.age_ms ?? Number.MAX_SAFE_INTEGER) - (a.age_ms ?? Number.MAX_SAFE_INTEGER));
}

// Ledger health as data, for `state.ledger` and `watch`'s wake banner. Combines THIS process's last read
// with the durable sidecar, so damage recorded by an earlier process is still visible after the fact.
// `ok:false` latches on permanent (non-transient) damage until the sidecar is cleared — an unacknowledged
// line that never folded is a standing fact about the run, not a one-shot message.
//
// DER-2776 adds the second standing fact: a remote host's tail line held back for longer than
// `ledgerHeldStaleMs()`. A FRESH hold is not damage (it is what a live writer looks like) and deliberately
// does not move `ok`; a STALE one does, because at that point the pull is re-reading a line nobody is
// finishing and every count in the run is a lower bound for as long as it lasts. Self-clearing: the
// record is deleted by the pull that finally folds the line.
export async function readLedgerHealth(runDir) {
  const ledgerFile = join(runDir, "events.jsonl");
  const sidecar = quarantinePathFor(ledgerFile);
  const last = LEDGER_HEALTH.get(ledgerFile) ?? { quarantined: 0, torn_tail: 0, first_bad_offset: null, reasons: [], at: null };
  let recorded = 0;
  let recordedPermanent = 0;
  let firstRecordedOffset = null;
  try {
    const body = await readFile(sidecar, "utf8");
    for (const l of body.split("\n")) {
      if (!l.trim()) continue;
      recorded += 1;
      let rec = null;
      try { rec = JSON.parse(l); } catch { /* count it, can't classify it */ }
      if (rec && !TRANSIENT_DAMAGE_REASONS.has(rec.reason)) {
        recordedPermanent += 1;
        if (firstRecordedOffset == null) firstRecordedOffset = rec.offset ?? null;
      }
    }
  } catch { /* no sidecar ⇒ nothing was ever quarantined */ }
  const held = await readHeldFragments(runDir);
  const heldStale = held.filter((h) => h.stale);
  const heldAges = held.map((h) => h.age_ms).filter((a) => Number.isFinite(a));
  const notes = [];
  if (recordedPermanent) {
    notes.push(`${recordedPermanent} ledger line(s) never folded into state; raw bytes are in ${sidecar}. Repair the ledger or delete that file to acknowledge.`);
  }
  if (heldStale.length) {
    notes.push(
      `${heldStale.length} remote host(s) have an UNTERMINATED tail line held back for ≥${ledgerHeldStaleMs()}ms ` +
      `(${heldStale.map((h) => `${h.host}: ${h.age_ms == null ? "age unknown" : `${h.age_ms}ms`}`).join(", ")}). ` +
      `Every pull re-reads that line and folds nothing — check whether that host's writer died mid-line. ` +
      `Clears itself the moment the line is completed. ` +
      // An unclearable health signal would make a run impossible to finish once its mini went away, so
      // say the escape out loud: same shape as the quarantine sidecar's "delete to acknowledge".
      `To acknowledge instead, delete ${heldStale.map((h) => h.file).join(", ")} ` +
      `(a later pull that still sees the line will restart the clock).`,
    );
  }
  return {
    ok: last.quarantined === 0 && last.torn_tail === 0 && recordedPermanent === 0 && heldStale.length === 0,
    quarantined: last.quarantined,
    torn_tail: last.torn_tail,
    first_bad_offset: last.first_bad_offset ?? firstRecordedOffset,
    reasons: last.reasons,
    quarantined_recorded: recorded,
    quarantined_unacknowledged: recordedPermanent,
    quarantine_file: recorded ? sidecar : null,
    last_read_at: last.at,
    // DER-2776 — the held-fragment age signal. `held_fragments` is every host currently holding an
    // unterminated tail line; `held_fragment_stale` is how many of those are past the threshold and is
    // the field a health gate (W10's `complete-run`) reads. Both are absent-safe: no holds ⇒ [] and 0.
    held_fragments: held,
    held_fragment_stale: heldStale.length,
    held_fragment_max_age_ms: heldAges.length ? Math.max(...heldAges) : null,
    note: notes.length ? notes.join(" ") : null,
  };
}

export async function readEvents(runDir, { retryTorn = true } = {}) {
  const ledgerFile = join(runDir, "events.jsonl");
  const readOnce = async () => {
    const body = await readFile(ledgerFile, "utf8");
    LEDGER_READ_STATS.fullReads += 1;
    LEDGER_READ_STATS.fullBytes += Buffer.byteLength(body);
    return parseLedgerLines(body, { terminated: body === "" || body.endsWith("\n") });
  };
  let parsed;
  try {
    parsed = await readOnce();
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  // One retry for an unterminated tail — the writer may be mid-append, and a line that completes in the
  // meantime is a real event we would otherwise report as damage.
  if (retryTorn && parsed.bad.some((b) => b.reason === "torn_tail")) {
    await sleep(LEDGER_TORN_RETRY_MS);
    try { parsed = await readOnce(); } catch { /* keep the first parse */ }
  }
  await recordLedgerDamage(ledgerFile, parsed.bad);
  // Sorted at the single choke point every consumer reads through, so the fold, the derived-event
  // suppression set, and "latest kickback" queries all see event-time order (DER-2520).
  //
  // Then deduped by IDENTITY (DER-2748), at the same choke point and for the same reason: a duplicate
  // delivery is not news, and doing it here means every consumer — the fold, `derivedEventSeen`,
  // `kickbackDossier` — sees each event once without each re-deriving the rule. Sort BEFORE dedup so
  // the surviving copy is the earliest by event time. Legacy lines carry no identity and are never
  // dropped, so this cannot shrink a pre-0.2.0 ledger.
  //
  // The returned length is still monotonic NON-DECREASING for a healthy ledger, which is what a legacy
  // `watch --since <count>` cursor relies on — but `watch` NO LONGER cursors on it (DER-2741): position
  // in this ts-sorted array is not a delivery cursor, because a backfilled historical event lands at an
  // EARLY index. See `createLedgerTail` / `resolveWatchCursor`.
  return dedupeLedgerEvents(sortEventsByTs(parsed.events));
}

// ---------------------------------------------------------------------------
// The watch cursor (DER-2741) — a BYTE OFFSET into the append-only file
// ---------------------------------------------------------------------------
// DER-2520 made `readEvents` fold in event-time order; `watch` then cursored on the SORTED array's
// LENGTH. A `--pull-hosts` backfill appends a remote host's HISTORICAL events at the tail (observed:
// ~100 mini events from 13:17–17:03Z appended at 17:29Z), and after the sort they land at their EARLY
// timestamp positions — index < the cursor. So `slice(since)` returned the already-seen recent tail and
// the backfilled events could never appear in any future slice: a pending-work signal consumed without
// ever being delivered. Length-preservation does not preserve the positional identity a cursor needs.
//
// The fix separates the two questions the old cursor conflated:
//   - WHAT ORDER DOES STATE FOLD IN?   event time (ts sort) — unchanged, `readEvents`.
//   - WHAT HAVE I NOT YET SEEN?        file position. Appends are ARRIVAL order, which is exactly what a
//                                      watcher wants: a backfilled line is new BYTES, so it is fresh
//                                      regardless of how early its ts is.
// So the cursor is a byte offset (exact, monotonic, unaffected by sorting), carried across processes as
// the `event_id` of the last delivered line (uuid v7 — time-sortable, so "everything after id X" is a
// range query, per DER-2748) and reported alongside the legacy `events` count.
const DEFAULT_LEDGER_IO = {
  async size(path) {
    try {
      return (await stat(path)).size;
    } catch (err) {
      if (err && err.code === "ENOENT") return -1;
      throw err;
    }
  },
  async readRange(path, offset, length) {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  },
};

// Stateful tail reader. `poll()` stats the file and reads ONLY the bytes past the cursor, so an idle poll
// costs one stat and zero parsing however large the ledger is (#16). The offset advances only past
// COMPLETE lines, so a torn tail is simply "not an event yet" — it is re-read (a few bytes) next poll and
// delivered exactly once when the writer finishes. `io` is injectable for tests.
export function createLedgerTail(filePath, { offset = 0, io = DEFAULT_LEDGER_IO } = {}) {
  let cursorOffset = Math.max(0, Number(offset) || 0);
  let lastEventId = null;
  return {
    get offset() { return cursorOffset; },
    get lastEventId() { return lastEventId; },
    async poll() {
      LEDGER_READ_STATS.polls += 1;
      LEDGER_READ_STATS.statCalls += 1;
      const size = await io.size(filePath);
      const nothing = { events: [], bad: [], bytes: 0, partial: false, rebuilt: false, unchanged: true };
      if (size < 0) return nothing; // no ledger yet
      let rebuilt = false;
      // A file that SHRANK was rotated or replaced. Rebuilding from 0 REPLAYS; keeping the old offset
      // would skip everything in the new file forever, and a cursor that can miss an event is worse
      // than one that replays (this cursor drives dispatch).
      if (size < cursorOffset) {
        cursorOffset = 0;
        rebuilt = true;
      }
      if (size === cursorOffset) return { ...nothing, rebuilt };
      const buf = await io.readRange(filePath, cursorOffset, size - cursorOffset);
      LEDGER_READ_STATS.tailReads += 1;
      LEDGER_READ_STATS.tailBytes += buf.length;
      const lastNl = buf.lastIndexOf(0x0a);
      // Nothing complete yet: do NOT advance. The cursor always sits on a line boundary, which is also
      // what makes reading a byte RANGE safe for multi-byte UTF-8.
      if (lastNl < 0) return { events: [], bad: [], bytes: buf.length, partial: true, rebuilt, unchanged: false };
      const parsed = parseLedgerLines(buf.subarray(0, lastNl + 1).toString("utf8"), { baseOffset: cursorOffset, terminated: true });
      cursorOffset += lastNl + 1;
      for (let i = parsed.events.length - 1; i >= 0; i -= 1) {
        const id = parsed.events[i].event_id;
        if (typeof id === "string" && id) { lastEventId = id; break; }
      }
      return { events: parsed.events, bad: parsed.bad, bytes: buf.length, partial: lastNl + 1 < buf.length, rebuilt, unchanged: false };
    },
  };
}

// Resolve a caller's `--since` into a byte offset. Three accepted forms, and every ambiguous case rounds
// toward REPLAY (idempotent consumers) rather than skip:
//   absent          start at EOF — only lines appended after this call wake us (today's default).
//   <event_id>      EXACT: resume immediately after the line bearing that id. An id this ledger does not
//                   contain replays from the start rather than guess.
//   <count>         LEGACY, preserved for callers already passing the payload's `events`. Resolved by
//                   counting parse-accepted LINES in file order. This can only err toward replay: the
//                   Nth event of the DEDUPED, ts-sorted array is always at line >= N, so stopping after
//                   line N stops at or before the caller's true position.
export async function resolveWatchCursor(runDir, since) {
  const ledgerFile = join(runDir, "events.jsonl");
  LEDGER_READ_STATS.statCalls += 1;
  const eof = Math.max(0, await DEFAULT_LEDGER_IO.size(ledgerFile));
  const raw = since == null ? "" : String(since).trim();
  if (!raw) return { offset: eof, mode: "eof", lastEventId: null, note: null };
  const isCount = /^\d+$/.test(raw);
  if (isCount && Number(raw) <= 0) return { offset: 0, mode: "count", lastEventId: null, note: null };
  let body;
  try {
    body = await readFile(ledgerFile, "utf8");
    LEDGER_READ_STATS.fullReads += 1;
    LEDGER_READ_STATS.fullBytes += Buffer.byteLength(body);
  } catch (err) {
    if (err && err.code === "ENOENT") return { offset: 0, mode: "empty", lastEventId: null, note: null };
    throw err;
  }
  const want = isCount ? Number(raw) : null;
  const parts = body.split("\n");
  let offset = 0;
  let accepted = 0;
  let lastId = null;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const end = offset + Buffer.byteLength(part) + 1;
    if (part.trim()) {
      const v = classifyLedgerLine(part);
      if (v.ok) {
        accepted += 1;
        if (typeof v.event.event_id === "string" && v.event.event_id) lastId = v.event.event_id;
        if (isCount && accepted >= want) return { offset: Math.min(end, eof), mode: "count", lastEventId: lastId, note: null };
        if (!isCount && v.event.event_id === raw) return { offset: Math.min(end, eof), mode: "event_id", lastEventId: raw, note: null };
      }
    }
    offset = end;
  }
  if (isCount) {
    return {
      offset: eof, mode: "count", lastEventId: lastId,
      note: want > accepted ? `--since ${want} is past the end of this ledger (${accepted} lines) — starting at EOF` : null,
    };
  }
  return {
    offset: 0, mode: "event_id_unknown", lastEventId: null,
    note: `--since ${raw} is not an event_id in this ledger — REPLAYING from the start. A cursor that can MISS an event is worse than one that replays, because watch drives dispatch.`,
  };
}

// Idle poll interval. `WORK_WATCH_POLL_MS` exists so the loop's tick rate is a tunable rather than a
// magic number frozen in a hot loop (and so the #16 idle-cost control can drive many ticks without
// asserting on wall-clock, which is flaky in CI). Clamped: a 0ms tick is a spin loop.
export function watchPollMs() {
  const raw = Number(process.env.WORK_WATCH_POLL_MS);
  if (!Number.isFinite(raw)) return 2500;
  return Math.min(60000, Math.max(5, Math.floor(raw)));
}

// How often `watch` runs its side-effect block (pull-hosts / reconcile-*). 45s in production; a seam only
// so a test can drive MANY cycles without waiting 45 seconds each — the same shape as WORK_WATCH_POLL_MS
// above. DER-2839: without it, the #16 "work per poll does not scale with history" invariant is
// untestable on the `--pull-hosts` path, because a hermetic watch only ever reaches ONE cycle and a
// per-cycle whole-ledger read is indistinguishable from a one-off. That is not a hypothetical — the first
// version of this test bounded total reads, and a deliberately reintroduced per-cycle read passed it.
export function watchPullIntervalMs() {
  const raw = Number(process.env.WORK_WATCH_PULL_INTERVAL_MS);
  if (!Number.isFinite(raw)) return 45000;
  return Math.min(600000, Math.max(1, Math.floor(raw)));
}

// Parse raw ledger lines pulled from a remote host's local events.jsonl (the mini), tagging each with
// its host if the remote append didn't. Pure — the pull-host subcommand appends the result to the
// canonical ledger. Blank lines are skipped so a trailing newline doesn't create an empty event.
//
// DER-2738: a malformed remote line is now SKIPPED AND RECORDED instead of throwing the whole pull away.
// The remote tail is the likeliest place to meet a torn line — `tail -n +N` of a file the mini is
// actively appending to. Pass `damage` to collect what was dropped (pull-host quarantines it); omit it
// and the tolerance is still there, which is the point: no consumer can crash on one bad remote line.
//
// DER-2776: …but "dropped" was the wrong verb for the tail line. `terminated:false` means the body did
// NOT end in a newline, so its LAST element is a writer caught mid-append — the same fact
// `parseLedgerLines` classifies `torn_tail` on the local side, and the same classification is used here,
// because `torn_tail` is TRANSIENT: a routine mid-append race must not latch a permanent run-wide damage
// banner. The fragment is never emitted as an event even when it happens to parse (a complete object
// missing only its "\n"), because the caller holds the cursor back and re-reads that line next pull —
// emitting it here would fold the same event twice.
export function mergeRemoteEvents({ remoteLines = [], host, damage, terminated = true } = {}) {
  const out = [];
  for (let i = 0; i < remoteLines.length; i += 1) {
    const l = remoteLines[i];
    if (!l || !l.trim()) continue;
    if (!terminated && i === remoteLines.length - 1) {
      if (damage) {
        damage.push({
          reason: "torn_tail", host: host ?? null, offset: null, line: i + 1,
          bytes: Buffer.byteLength(String(l)), raw: String(l).slice(0, LEDGER_RAW_KEEP),
          raw_truncated: String(l).length > LEDGER_RAW_KEEP, held: true,
        });
      }
      continue;
    }
    const v = classifyLedgerLine(l);
    if (!v.ok) {
      if (damage) {
        damage.push({
          reason: `remote_${v.reason}`, host: host ?? null, offset: null, line: i + 1,
          bytes: Buffer.byteLength(String(l)), raw: String(l).slice(0, LEDGER_RAW_KEEP),
          raw_truncated: String(l).length > LEDGER_RAW_KEEP, ...(v.detail ? { detail: v.detail } : {}),
        });
      }
      continue;
    }
    const e = v.event;
    if (host && !e.host) e.host = host;
    out.push(e);
  }
  return out;
}

const ACTIVE_STATUSES = new Set(["in_progress", "pr_open", "kickback"]);
const DONE_STATUSES = new Set(["merged", "reaped"]);

// Idempotent-fold guard (item 2, 2026-07-15 turnover). Out-of-band / merge-queue merges get a `pr_merged`
// from BOTH the shepherd AND the `--reconcile-merged` fold, and a run-end sweep can double-log `reaped` —
// the append-only file keeps every line, but the fold must count each terminal transition ONCE so
// counts/analytics (and any per-issue tally) stay truthful. Collapse duplicate TERMINAL events by identity:
// `pr_merged` per (issue, pr) and `reaped` per issue, first occurrence wins. `kickback` is deliberately NOT
// deduped — kb1/kb2 are distinct rounds that must each increment kickback_count. Pure; order-preserving.
export function dedupeTerminalEvents(events = []) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    let key = null;
    if (e && e.type === "pr_merged") key = `pr_merged:${e.issue ?? ""}:${e.pr ?? ""}`;
    else if (e && e.type === "reaped") key = `reaped:${e.issue ?? ""}`;
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(e);
  }
  return out;
}

// Events that PROVE a lead did work, and therefore refute an earlier `lead_process_dead` claim.
//
// `token_usage` is deliberately absent: it is the SessionEnd signature on every unit, so counting it as
// life would resurrect leads that really did stop — the inverse error, and the more dangerous one,
// because the harness would then never report a death at all. The shepherd's 2026-07-27 note says it
// plainly: "token_usage is NOT proof a lead handed off". Everything below is emitted mid-flight.
const LIVENESS_REFUTING_EVENTS = new Set([
  "context_report", "plan_scope", "handed_off", "pr_opened", "review_findings",
  "fix_pushed", "rotate_requested", "kickback_ack", "lead_online",
]);

// ---------------------------------------------------------------------------
// DER-2838 — the run-completion receipt
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT: authentication. SECURITY.md records the deliberate decision that privileged event
// authority in this harness is DOCUMENTED, NOT AUTHENTICATED — there is no signing key, no per-actor
// credential, and no ingress channel separate from ordinary file writes. `minted_by` below is an
// unauthenticated string exactly like `gate_adjudication`'s `adjudicated_by`, and no unkeyed digest
// computed from public inputs would change that (anyone who can write the line can also compute the
// digest), which is why there is deliberately no digest here. Nothing in this section proves WHO wrote a
// marker.
//
// WHAT IT IS: an INTEGRITY / PROVENANCE record that makes the claim CHECKABLE AGAINST THE LEDGER it is
// folded into. `complete-run` is the only writer that has run `runCompletionRefusals`, so it is the only
// writer that can state what the gate saw: which units it vouched for, which checks it evaluated, and on
// which build. The fold then re-derives the ledger-checkable half of that claim — is the run tracking
// anything, is every tracked unit terminal, and are those units exactly the ones the receipt names — and
// ignores the marker when the ledger disagrees.
//
// So the property this buys is precise and worth stating exactly: a forged marker cannot make an ACTIVE
// or EMPTY run read as completed, because the only way to satisfy the cross-check is to make the units
// terminal, which is the work itself. What it does NOT buy: on a run that WOULD pass the gate anyway, a
// hand-written valid receipt still completes it. That case is harmless by construction (the answer is
// the one the gate would have given), and pretending otherwise would be the overclaim this file's own
// review rules exist to catch.
//
// The checks that are NOT re-derived at read time, and why: `ledger_quarantine`, `ledger_held_fragments`
// and `ledger_health` are facts about BYTES AND SIDECARS, not about folded events, so a pure fold cannot
// see them; `protocol` is re-derivable but is the ACTING process's business at write time (see the
// attestation in `complete-run`) and re-checking it at read time would refuse every run legitimately
// completed under `--allow-version-skew`; `kickbacks_pending` cannot fire without `units_terminal` firing
// too (a `kickback` status is not terminal), so it adds nothing here.
export const RUN_COMPLETION_RECEIPT_VERSION = 1;

// The checks a receipt must claim. Derived from `runCompletionRefusals`'s own `add(...)` calls by
// `work-runner.test.mjs` rather than trusted as a hand-list — a set that drifts from the function it
// describes is a check that cannot fail.
export const RUN_COMPLETION_CHECKS = [
  "kickbacks_pending", "ledger_health", "ledger_held_fragments", "ledger_quarantine",
  "protocol", "units_terminal", "units_tracked",
];

export const RUN_COMPLETED_RESERVED =
  "`run_completed` is RESERVED for `complete-run`, which appends it only after every check in " +
  "runCompletionRefusals passed. Run `complete-run --run <r>` (add --dry-run to preview the verdict): it " +
  "refuses and lists every failing check rather than appending. This is a write-time affordance, not the " +
  "enforcement — the enforcement is the receipt the fold validates, which a hand-written marker lacks.";

// The receipt `complete-run` writes. Reads this process's version + source id; everything else is the
// gate's own accounting, passed in.
export function mintRunCompletionReceipt({ runId = null, units = [], allowVersionSkew = false } = {}) {
  const list = [...units].sort();
  return {
    receipt_version: RUN_COMPLETION_RECEIPT_VERSION,
    run_id: runId,
    units: list,
    unit_count: list.length,
    checks_passed: [...RUN_COMPLETION_CHECKS].sort(),
    harness_version: getHarnessVersion(),
    allow_version_skew: !!allowVersionSkew,
    // PROVENANCE LABEL, NOT AN IDENTITY CLAIM — same standing as `adjudicated_by`. Recorded so a
    // completed run says which process closed it; never compared against anything.
    minted_by: getSourceId(),
  };
}

// Is this `run_completed` a completion? Pure, and deliberately given the tracked units as plain data
// (`[{issue, status}]`) so the caller owns the fold and this owns the contract.
//
// A NEW GATE CHECK MEANS A NEW RECEIPT VERSION. Adding a check to `runCompletionRefusals` without
// bumping `RUN_COMPLETION_RECEIPT_VERSION` would silently honor receipts minted by a build that never
// ran it; bumping it invalidates older markers, which re-reads those runs as `running` until
// `complete-run` is run again (idempotent by gate — it re-checks and mints a current receipt). That cost
// is the point: it is paid out loud, once, instead of by a receipt that means less than it says.
export function runCompletionReceiptVerdict({ event = null, tracked = [], runId = null } = {}) {
  const no = (reason) => ({ ok: false, reason, receipt: null });
  const r = event && typeof event === "object" ? event.completion_receipt : null;
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    return no("it carries no `completion_receipt` — a run_completed written by anything other than `complete-run` is not a completion (DER-2838)");
  }
  if (r.receipt_version !== RUN_COMPLETION_RECEIPT_VERSION) {
    return no(`its completion_receipt claims version ${JSON.stringify(r.receipt_version)}; this build honors ${RUN_COMPLETION_RECEIPT_VERSION} only — re-run \`complete-run\` to mint a current one`);
  }
  if (typeof r.run_id !== "string" || !r.run_id) return no("its completion_receipt names no run");
  if (event.run_id && r.run_id !== event.run_id) {
    return no(`its completion_receipt was minted for run "${r.run_id}" but the event claims "${event.run_id}"`);
  }
  if (runId && r.run_id !== runId) {
    return no(`its completion_receipt was minted for run "${r.run_id}", not for this run ("${runId}")`);
  }
  if (typeof r.harness_version !== "string" || !r.harness_version) {
    return no("its completion_receipt does not say which build evaluated the gate");
  }
  if (!Array.isArray(r.units) || r.units.some((u) => typeof u !== "string" || !u)) {
    return no("its completion_receipt does not enumerate the units it vouched for");
  }
  const claimed = [...new Set(r.units)];
  if (claimed.length !== r.units.length) return no("its completion_receipt names a unit twice");
  if (r.unit_count !== claimed.length) {
    return no(`its completion_receipt says unit_count ${JSON.stringify(r.unit_count)} but lists ${claimed.length}`);
  }
  const missingChecks = RUN_COMPLETION_CHECKS.filter((c) => !(Array.isArray(r.checks_passed) && r.checks_passed.includes(c)));
  if (missingChecks.length) {
    return no(`its completion_receipt does not claim ${missingChecks.length} required check(s): ${missingChecks.join(", ")}`);
  }
  // THE CROSS-CHECK — the half a forger cannot write their way past, because it is derived from the
  // ledger rather than from the receipt. Mirrors gate checks 1 and 2 of runCompletionRefusals.
  const units = tracked.filter((u) => u && u.issue);
  if (!units.length) return no("this run tracks no units at all — an empty run has nothing to complete (gate check `units_tracked`)");
  const nonTerminal = units.filter((u) => !DONE_STATUSES.has(u.status ?? "queued"));
  if (nonTerminal.length) {
    return no(`${nonTerminal.length} tracked unit(s) are NOT terminal: ${nonTerminal.map((u) => `${u.issue} (${u.status ?? "queued"})`).sort().join(", ")} (gate check \`units_terminal\`)`);
  }
  const trackedIds = [...new Set(units.map((u) => u.issue))].sort();
  const claimedIds = [...claimed].sort();
  if (trackedIds.join("\u0000") !== claimedIds.join("\u0000")) {
    const unnamed = trackedIds.filter((id) => !claimedIds.includes(id));
    const invented = claimedIds.filter((id) => !trackedIds.includes(id));
    return no(
      "its completion_receipt does not name this run's tracked units" +
      (unnamed.length ? ` — unnamed: ${unnamed.join(", ")}` : "") +
      (invented.length ? ` — not in this run: ${invented.join(", ")}` : ""),
    );
  }
  return { ok: true, reason: null, receipt: r };
}

export function materializeState(rawEvents, meta = {}) {
  const events = dedupeTerminalEvents(rawEvents);
  const issues = {};
  let runStarted = null;
  const ensure = (id) => {
    if (!issues[id]) {
      // `spawn_failed*` (DER-2739) and `transcripts_forced` (DER-2744) are both TRI-STATE-ish on purpose:
      // `transcripts_forced: null` means UNKNOWN — a spawn event that carried no attestation — and unknown
      // is never the same as ok. See the transcripts_unverified banner.
      issues[id] = { status: "queued", pr: null, worktree: null, branch: null, workspace_ref: null, kickback_count: 0, kickback_unactioned: false, kickback_sha: null, fileScope: [], host: null, bundle: null, tokens: 0, plan_scope_seen: false, gate: null, budget: "ok", leadType: null, rotations: 0, rotate_pending: false, rotate_pct: null, rotate_disposition: null, spawn_failed: false, spawn_failed_count: 0, spawn_failed_note: null, spawn_failed_exit_code: null, transcripts_forced: null, reap_cleanup_ok: null, reap_failed: false, reap_leaks: [], reap_failed_note: null, gate_adjudicated: null, gate_adjudication_rejected: null, _reports: {}, _kb_uncounted: false, _gate_event: null, _gate_adjs: [] };
    }
    return issues[id];
  };
  let shepherdRotatePending = false;
  // DER-2739 — the latest UN-SUPERSEDED spawn failure per non-issue role. Cleared by that role's next
  // successful `*_spawned`, so the banner reflects the CURRENT dispatch state, not the run's history.
  const roleSpawnFailed = { shepherd: null, orch: null };
  // DER-2781 — the run's own terminal state. `run_completed` is appended ONLY by `complete-run`, and only
  // after every check in `runCompletionRefusals` passed.
  //
  // DER-2838 — "only by `complete-run`" was a CONVENTION, and the fold trusted it: the first marker won
  // unconditionally, so an `append` (or a text editor) ended an ACTIVE or EMPTY run and every one of
  // those checks was moot. The write path now reserves the type, and this is the half that matters —
  // a marker is honored only if it carries a receipt this build recognizes AND that receipt agrees with
  // the units this fold has actually seen, evaluated AT THE MARKER'S POSITION in event-time order.
  // Position matters: a rejected marker validated against the FINAL fold would be invalidated by any
  // later event that adds a unit or (per the live DER-2824 defect) walks a reaped one backwards — an
  // honest completion must not be retroactively un-done by something that happened after it.
  // A rejected marker is RECORDED (`run_completion_rejected`), never silently dropped: a forgery
  // attempt, and a run whose marker predates this contract, are both things the next reader has to be
  // told rather than left to infer from a run that quietly reads `running`.
  // This is the fold half of that settled contract:
  //   FIRST-WINS — a second marker never re-stamps the run (same rule as dedupeTerminalEvents).
  //   A LATE EVENT NEVER REOPENS IT — a `pr_merged` that lands after completion (DER-2587's late-merge
  //   shape) still folds onto its own unit, but the RUN stays `completed`. It is COUNTED rather than
  //   silently absorbed, because "the ledger kept moving after the run was declared over" is a fact the
  //   next reader has to be told; absence read as fine is how this harness's blind spots have all started.
  // 3.1 / 3.2 — message receipts and recent per-issue notes, folded in one pass over the events.
  const MSG_ACK_STALE_MS = 10 * 60 * 1000; // the kickback relay's proven threshold, generalised
  const NOTES_PER_ISSUE = 3;
  const awaitingAck = new Map(); // ref -> {ref, to, ts, type}
  const acked = new Set();
  const notesByIssue = new Map();
  for (const e of events) {
    if (e?.type === "msg_ack" && e.ref) acked.add(e.ref);
    // A message is "actionable and outstanding" when it declared a ledger ref for itself.
    else if (e?.msg_ref) awaitingAck.set(e.msg_ref, { ref: e.msg_ref, to: e.to ?? null, from: e.actor ?? null, ts: e.ts ?? null, type: e.type });
    if (typeof e?.type === "string" && e.type.endsWith("_note") && e.issue) {
      const list = notesByIssue.get(e.issue) ?? [];
      list.push({ ts: e.ts ?? null, by: e.actor ?? null, type: e.type, text: String(e.note ?? e.text ?? "").slice(0, 300) });
      notesByIssue.set(e.issue, list);
    }
  }
  const nowMs = Date.now();
  const unackedMessages = [...awaitingAck.values()]
    .filter((m) => !acked.has(m.ref))
    .map((m) => {
      const ageMs = m.ts ? nowMs - Date.parse(m.ts) : null;
      return {
        ...m,
        age_s: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
        stale: Number.isFinite(ageMs) ? ageMs > MSG_ACK_STALE_MS : false,
        act: "DELIVERED is not READ. Past ~10 min with no msg_ack, treat the message as NOT LANDED: stop re-poking and re-deliver (or respawn a wedged recipient), exactly as the kickback relay already does.",
      };
    });
  const recentNotes = Object.fromEntries(
    [...notesByIssue.entries()].map(([issue, list]) => [issue, list.slice(-NOTES_PER_ISSUE)]),
  );

  let runCompleted = null;
  const runCompletionRejected = [];
  const postCompletion = [];
  for (const e of events) {
    // Strictly-after, in fold (event-time) order. A SECOND `run_completed` counts as a post-completion
    // event on purpose: it is a real line in the ledger and swallowing it would hide a duplicate marker.
    // Note this counts the DEDUPED stream: a late `pr_merged` that merely repeats one already folded is a
    // duplicate DELIVERY, dropped upstream by dedupeTerminalEvents, and is deliberately not "news" here.
    // What does count is the DER-2587 shape — a unit reaped off an out-of-band merge whose `pr_merged`
    // reconciles later, i.e. the first delivery of that (issue, pr), arriving after the run ended.
    if (runCompleted) postCompletion.push(e);
    else if (e.type === "run_completed") {
      // The tracked set AS OF THIS MARKER: every unit that has folded so far, plus any the run declared
      // and never touched (those are `queued` — tracked, not terminal, exactly as the gate counts them).
      const declared = (meta.issues ?? runStarted?.issues ?? [])
        .map((i) => (typeof i === "string" ? i : i?.id))
        .filter(Boolean);
      const trackedNow = new Map(Object.entries(issues).map(([id, v]) => [id, v.status ?? "queued"]));
      for (const id of declared) if (!trackedNow.has(id)) trackedNow.set(id, "queued");
      const verdict = runCompletionReceiptVerdict({
        event: e,
        tracked: [...trackedNow].map(([issue, status]) => ({ issue, status })),
        runId: meta.run_id ?? runStarted?.run_id ?? null,
      });
      if (verdict.ok) runCompleted = e;
      else runCompletionRejected.push({ ts: e.ts ?? null, actor: e.actor ?? null, source_id: e.source_id ?? null, event_id: e.event_id ?? null, reason: verdict.reason });
    }
    if (e.type === "run_started" && !runStarted) runStarted = e;
    // Shepherd rotation request (respawn-over-compact, 2026-07-23): the shepherd appends
    // {actor:"shepherd",type:"rotate_requested"} when its context-wrap-nudge fires. The flag stays
    // raised until the next shepherd_spawned (the rotation itself) — surfaced top-level like
    // kickbacks_pending so a request can't rot unseen in the event stream.
    if (e.type === "rotate_requested" && (e.actor === "shepherd" || e.role === "shepherd")) shepherdRotatePending = true;
    if (e.type === "shepherd_spawned") shepherdRotatePending = false;
    // DER-2739, run-scoped half. A shepherd/orch launch has no issue, so it has to be folded ABOVE the
    // issue gate. Note what a FAILED shepherd launch must NOT do: clear shepherdRotatePending. A rotation
    // that didn't happen is not a rotation, and dropping the request is how a rotation rots unseen —
    // the same failure mode the request flag was built to prevent.
    if (e.type === "shepherd_spawn_failed") roleSpawnFailed.shepherd = e;
    if (e.type === "orch_spawn_failed") roleSpawnFailed.orch = e;
    if (e.type === "orch_spawned") roleSpawnFailed.orch = null;
    if (e.type === "shepherd_spawned") roleSpawnFailed.shepherd = null;
    if (!e.issue) continue;
    const it = ensure(e.issue);
    // A bundle rides on worktree_created/lead_spawned/pr_opened events; latest wins. The bundled
    // EXTRA ids never become their own ledger units — the primary id keys the whole unit.
    if (Array.isArray(e.bundle) && e.bundle.length) it.bundle = e.bundle;
    // A death claim is REFUTED by later work from the same unit. Deliberately excludes `token_usage`:
    // that is the SessionEnd signature on every unit, so treating it as life would resurrect genuinely
    // dead leads — the exact inverse error. See LIVENESS_REFUTING_EVENTS.
    if (it.process_dead && LIVENESS_REFUTING_EVENTS.has(e.type)) {
      it.process_dead = false;
      it.process_dead_note = null;
      it.process_dead_refuted_by = e.type;
    }
    switch (e.type) {
      case "worktree_created":
        if (e.worktree) it.worktree = e.worktree;
        if (e.branch) it.branch = e.branch;
        if (e.host) it.host = e.host;
        break;
      case "lead_spawned":
        it.status = "in_progress";
        // ANY spawn that actions a pending kickback is the delivery of that round's findings — the
        // kickback brief carries them, and a rotation brief carries latestFindings too. This is where
        // the round counts (DER-2491): the count used to increment on the kickback APPEND, so a
        // composed-but-never-delivered kickback (superseded, merged instead) falsely fed the breaker.
        if (it._kb_uncounted && it.kickback_unactioned) { it.kickback_count += 1; it._kb_uncounted = false; }
        it.kickback_unactioned = false; // a (re-)spawn IS the kickback action
        it.process_dead = false; // a fresh spawn replaces the dead process (DER-2516)
        it.process_dead_note = null;
        // A spawn that SUCCEEDED supersedes the failure that preceded it (DER-2739) — the banner tracks
        // the current dispatch state, so a retry that works must clear it.
        it.spawn_failed = false;
        it.spawn_failed_note = null;
        it.spawn_failed_exit_code = null;
        // A spawn that landed also clears a PREPARED-BUT-BLOCKED rotation (DER-4050): the human ran the
        // command the refusal printed, so the rotation is no longer owed to anyone.
        it.rotation_blocked = null;
        it.rotation_blocked_reason = null;
        it.rotation_blocked_brief = null;
        // DER-2744 — did this launch PROVE it forces transcript persistence? The spawn path measures it
        // off the real command string; anything else (an older harness on another host, a hand-appended
        // recovery event, every pre-fix ledger line) carries no attestation and folds to `null` = UNKNOWN.
        // Deliberately not defaulted to `true`: assuming the guarantee is what made the defect invisible.
        it.transcripts_forced = e.transcripts_forced === true ? true : e.transcripts_forced === false ? false : null;
        if (e.worktree) it.worktree = e.worktree;
        if (e.workspace_ref) it.workspace_ref = e.workspace_ref;
        if (e.host) it.host = e.host;
        if (e.host_kind) it.host_kind = e.host_kind;
        if (e.leadType) it.leadType = e.leadType;
        // The cloud dispatch receipt (2026-08-18). It is BOTH the steer target (`steer-cloud` reads it to
        // deliver a kickback into the live lead) and the monitor handle — which used to arrive only later,
        // scraped from the draft PR's footer, so links.md was empty for the whole pre-PR window. It
        // OVERWRITES `handle` on purpose: after a replacement spawn the PR footer still names the session
        // that opened the PR (the dead one), while this is the session now doing the work.
        if (e.cloudSessionId) {
          it.cloud_session_id = e.cloudSessionId;
          it.handle = e.cloudSessionId;
        }
        // A ROTATION re-spawn (2026-07-25) carries `rotation: n`. It is the action that clears the
        // pending request — exactly as a shepherd_spawned clears shepherd_rotate_pending. A PLAIN
        // re-spawn (kickback) must NOT clear it: the lead is still deep, and silently dropping the
        // request is how a rotation rots the same way the 2026-07-16 kickbacks did.
        if (Number.isFinite(Number(e.rotation)) && Number(e.rotation) > 0) {
          it.rotations = Math.max(it.rotations ?? 0, Number(e.rotation));
          it.rotate_pending = false;
          it.rotate_pct = null;
          it.rotate_disposition = null;
        }
        break;
      case "lead_spawn_failed":
        // DER-2739. Note everything this case does NOT do, because each omission is the actual fix:
        //   - it does not touch `status`. A failed first dispatch stays `queued` (so it stays in `queue`
        //     and out of `inflight`); a failed kickback re-spawn stays `kickback` with
        //     `kickback_unactioned` intact, so kickbacks_pending still lists it. `lead_spawned` was the
        //     ONE unguarded entrance to in_progress, and a launch nobody proved must not use it.
        //   - it does not clear `process_dead`. A respawn that failed did not replace the dead process.
        //   - it does not count a kickback round. The round counts when its findings are DELIVERED.
        // What it DOES do is drop `workspace_ref`: every spawn path closes the issue's prior refs BEFORE
        // launching, so after a failed launch there is no live workspace at all. Keeping the predecessor's
        // ref (which the old `if (e.workspace_ref)` guard did, silently, on a null ref) reads as a live
        // workspace and is what `cmux close-workspace`/reap would then chase.
        it.spawn_failed = true;
        it.spawn_failed_count += 1;
        it.spawn_failed_note = e.reason ?? e.note ?? "the launch could not be proven";
        it.spawn_failed_exit_code = e.exit_code ?? null;
        it.workspace_ref = null;
        if (e.host) it.host = e.host;
        break;
      case "rotation_prepared":
        // A rotation whose brief IS WRITTEN but whose spawn was refused — a disabled cloud host, or a unit
        // with no worktree. `rotate_lead` has appended this event since 2026-08-18 and NOTHING folded it
        // (DER-4050): the next wake read `lead_rotate_pending` with no reason and no recovery command, so a
        // prepared rotation went quiet exactly like an unprepared one. `rotate_pending` is deliberately left
        // alone — the lead still needs rotating; what this records is WHY it stopped and where to resume.
        it.rotation_blocked = e.rotation ?? true;
        it.rotation_blocked_reason = e.blocked ?? "not_spawned";
        it.rotation_blocked_brief = e.brief ?? null;
        if (e.host) it.host = e.host;
        break;
      case "rotate_requested":
        // Issue-scoped ⇒ a LEAD asked (or the detector asked on its behalf, source:"detector").
        // Stays raised until the rotation itself lands, so it cannot rot unseen in the event stream.
        it.rotate_pending = true;
        if (Number.isFinite(Number(e.pct))) it.rotate_pct = Number(e.pct);
        if (e.disposition) it.rotate_disposition = String(e.disposition).toUpperCase();
        if (e.source) it.rotate_source = e.source;
        break;
      case "lead_context_unreadable":
        // We are BLIND to this lead's utilization — record it as its own state so the orchestrator
        // must look, instead of reading a zeroed gauge as health. Cleared by any subsequent readable
        // probe (below) or by the lead leaving flight; NOT cleared by a rotation, because rotating
        // does not by itself prove the successor is readable.
        it.context_unreadable = true;
        it.context_unreadable_note = e.note ?? "no usage record";
        break;
      case "lead_context_read":
        // The paired positive signal. Emitted whenever a probe DOES resolve utilization, so a
        // transient unreadable window (a probe that raced a transcript write) self-clears instead of
        // sticking as a permanent false alarm.
        it.context_unreadable = false;
        it.context_unreadable_note = null;
        break;
      case "lead_process_dead":
        // The probe that CAN return "dead" (DER-2516). `lead-context` used to read only the
        // transcript, which outlives the process — so a dead lead rendered as a healthy percentage
        // and, paired with H1's manufactured heartbeat, EVERY liveness instrument could report a
        // healthy corpse. Raised by the lead-context process check.
        //
        // STICKINESS FIX (2026-07-27 18:30Z, live FALSE DEATH): the flag used to clear ONLY on a fresh
        // `lead_spawned`, so a false positive followed every successor around for the rest of the run.
        // DER-2511's lead was reported dead at 18:30:58 and pushed d534b6b903 at 18:31:37 — alive, with
        // 315 lines of uncommitted work in its worktree, where a respawn would have been destructive.
        // The probe's pgrep pattern was verified able to return RC=1, so it CAN fail; it simply was not.
        // Post-death work signal ⇒ the death is refuted (see LIVENESS_REFUTING_EVENTS below).
        it.process_dead = true;
        it.process_dead_note = e.note ?? null;
        break;
      case "budget_assigned":
        // The pre-run plan's ASSIGNED budget for this unit (write-brief stamped it into the brief).
        it.assigned = { files: Number(e.files) || 0, additions: Number(e.additions) || 0 };
        break;
      case "plan_scope":
        if (e.fileScope) it.fileScope = e.fileScope;
        if (Number.isFinite(Number(e.expectedAdditions))) it.declared_additions = Number(e.expectedAdditions);
        it.plan_scope_seen = true;
        break;
      case "token_usage": {
        // Per-issue spend, for the circuit breaker. Reports are CUMULATIVE per session and re-emitted
        // (one report_id was seen 12x), so summing raw events double-counts ~2x. Keep the MAX per
        // report_id and sum those — the same dedupe aggregateTokenUsage uses, which reproduces
        // work-metrics' run total exactly. A report_id-less event can't be deduped, so it is keyed by
        // its own ts to stay additive without collapsing distinct sessions.
        const key = e.report_id ? `id:${e.report_id}` : `ts:${e.ts ?? ""}`;
        const seen = Number(it._reports[key] ?? 0) || 0;
        it._reports[key] = Math.max(Number(e.total_tokens ?? 0) || 0, seen);
        break;
      }
      case "review_findings":
        // DER-2603 — the pre-PR review gate, folded so a MISSING one is visible on the board and not only
        // at enqueue time. Deliberately records what the evidence COVERS (`sha`) rather than just that it
        // exists: an event from round 1 says nothing about the round-3 head (see gateEvidenceVerdict).
        {
          // 1.4 — ONE structured `gate` object, replacing the flat `gate_seen` boolean and its four
          // siblings. A boolean cannot express "gated by a substitute", and with posture C now a
          // first-class path that distinction is exactly what a later reader needs: attributing a
          // 3-lens Claude panel to codex is not hypothetical, it happened on #1183 and propagated into
          // a run report and a learnings entry before shepherd #5 caught it.
          //
          // DER-2782 — `|| 0` turns an UNREADABLE count into a clean one, which is the same fail-open
          // gateEvidenceVerdict now refuses. Kept as its own flag rather than by letting NaN into
          // `blockers`, which every existing consumer of that field reads as a number.
          // DER-2837 — and the fold trusted the NUMBER exactly as `ready` did, so an under-counted unit
          // was missing from `gate_blocked` too: the board, which exists so the round is caught BEFORE
          // enqueue, agreed with the lie. Same contract, one function, both readers.
          const count = gateBlockerCountVerdict(e);
          const prior = it.gate ?? {};
          it.gate = {
            seen: true,
            sha: e.sha ?? null,
            blockers: count.recorded ?? 0,
            blockers_unreadable: count.kind === "unreadable",
            blockers_inconsistent: count.ok || count.kind === "unreadable" ? null : count.reason,
            round: Number.isFinite(Number(e.round)) ? Number(e.round) : prior.round ?? null,
            // Provenance. `substitute` is strictly `true` only when the producer said so — an absent
            // field means codex, which is what every pre-1.1 event is.
            substitute: e.substitute === true,
            engine: e.engine ?? prior.engine ?? null,
            model: e.model ?? prior.model ?? null,
            reviewer: e.reviewer ?? prior.reviewer ?? null,
            // requested vs returned, both kept: a 1-of-3 panel must be VISIBLE as 1-of-3 and must never
            // render as a full swap.
            lenses: Array.isArray(e.lenses) ? e.lenses : null,
            lenses_requested: Array.isArray(e.lenses_requested) ? e.lenses_requested : null,
            // DER-3011 — read from THIS event only, never carried over from `prior`. The carry-forward
            // already happened at write time (`crossVendorAttestation` stamps `inherited`), and doing it
            // again here would let a round-3 receipt that deliberately recorded `none` display round 1's
            // answer instead of its own — a reader would then see an attestation the receipt disclaims.
            cross_vendor: e.cross_vendor ?? null,
          };
          // ── Round-count FLOOR from the gates themselves (2026-08-12) ───────────────────────────
          // `kickback_count` increments only on a `kickback` event that is then DELIVERED. That is
          // correct for the shepherd's path and blind to the orchestrator's: on run 20260810 the orch
          // both GATED #1293 and DISPATCHED its fixer, so no shepherd `kickback` event ever existed,
          // `kickback_count` read 0, and the round was invisible to the 3-round hard cap — the one
          // control that stops a non-converging PR from grinding forever. The orchestrator noticed and
          // hand-appended the missing events, which is exactly the manual repair a fold should not need.
          //
          // A gate that found blockers IS a review round, regardless of who dispatched the fix. Counting
          // distinct blocker-bearing gate SHAs gives a floor that no dispatch path can bypass: re-gating
          // the same sha does not inflate it, and a clean gate does not count at all.
          if ((count.recorded ?? 0) > 0 || count.kind === "unreadable") {
            it._blocker_gate_shas = it._blocker_gate_shas ?? new Set();
            it._blocker_gate_shas.add(e.sha ?? `round:${e.round ?? "?"}`);
          }
        }
        // DER-2782 — the WHOLE event, because an adjudication is checked against this event's findings
        // list, not against the blocker COUNT. Kept private and dropped in the finalize pass below.
        it._gate_event = e;
        break;
      case "gate_adjudication":
        // DER-2782 — the machine-readable "rejected in writing" escape hatch. Collected raw and vetted
        // in the finalize pass, so the fold does not depend on an adjudication happening to be appended
        // AFTER the gate event it references (a ledger folded from two hosts orders by ts, not by intent).
        it._gate_adjs.push(e);
        break;
      case "pr_opened":
        it.status = "pr_open";
        if (e.pr != null) it.pr = e.pr;
        break;
      case "lead_online":
        // Cloud lead's draft PR appeared: alive + working. Record the pr + monitor handle; stay
        // in_progress (draft ≠ handed off). The ABSENCE of this past a deadline = failed-to-start.
        // DER-2778 — a TERMINAL unit's PR pointer is final. `it.pr` was repointed unconditionally, and
        // `lead_online` is the one event type that is DERIVED from open-PR state on a 45s loop, so any
        // PR naming this issue could retarget it. On a merged/reaped unit that is never right: the work
        // is done and its PR number is what `ready`, the shepherd's worklist and every gate aim at.
        // The status guard below already refused the status TRANSITION; the pointer writes above it did
        // not, which left the guard describing a protection it only half had.
        if (it.status === "merged" || it.status === "reaped") break;
        if (e.pr != null) it.pr = e.pr;
        if (e.handle) it.handle = e.handle;
        // 2026-07-18 incident (run 20260718T122639Z, PR 907/DER-1957): a liveness ping — ESPECIALLY
        // a derived one (draft:false) from a phantom PR-state scan — must NOT knock an UN-ACTIONED
        // kickback off "kickback" status. Doing so hides it from kickbacks_pending AND defeats the
        // handed_off / deriveCloudPrEvents flap guards, which key off status === "kickback". On that
        // run a derived lead_online flipped kickback→in_progress, so the next phantom handed_off was
        // honored and cleared the pending kickback while the head still sat at the kickback SHA.
        if (it.status === "kickback" && it.kickback_unactioned) break; // hold in kickback until a real action
        if (it.status !== "pr_open" && it.status !== "merged" && it.status !== "reaped") it.status = "in_progress";
        break;
      case "handed_off": {
        // Cloud lead marked its PR ready_for_review (draft → ready): the shepherd takes over. Same
        // semantics as pr_opened for a local lead.
        // FLAP GUARD (2026-07-16 run): a handed_off landing while a kickback is still UN-ACTIONED —
        // no re-spawn (lead_spawned) and no fix push (fix_pushed) since the kickback — is a phantom
        // ready-flip: either reconcile raced the shepherd's re-draft, or a lead re-marked ready
        // without pushing. Honoring it emptied kickbacks_pending and killed the re-spawn — 7
        // kickbacks rotted 40m–1.3h each and needed manual shepherd RE-EMITs.
        //
        // EXTENDED 2026-07-18 (run 20260718T122639Z, PR 907/DER-1957): the guard used to key on
        // status === "kickback", but a derived lead_online (draft:false) had already flipped the
        // status to in_progress, so a sha-less phantom handed_off slipped through and cleared the
        // kickback while the head still sat at the kickback SHA (no fix existed). A kickback may only
        // be cleared by DETERMINISTIC head-move evidence, not the transient status:
        //   (a) a handed_off whose sha STILL equals the kickback SHA is a flap — the head never moved,
        //       so no fix exists — NEVER clear, regardless of any re-spawn/lead_online in between;
        //   (b) a handed_off with NO proof of a head move (no sha, or no kickback SHA to compare) may
        //       not clear an UN-ACTIONED kickback — it stays pending until a real lead_spawned /
        //       fix_pushed / a handed_off carrying a NEW sha lands.
        // The fold is sequential, so this is re-fold-stable: a later lead_spawned can't retroactively
        // legitimize an earlier phantom handed_off (at that index the kickback was still un-actioned).
        //   (c) DER-2559 (ancestor variant, caught live 2026-07-27 08:00Z): "a DIFFERENT sha" is not
        //       "a LATER sha". A #1082 handed_off carried `752bb42ba7`, an ANCESTOR of the kickback sha
        //       `9dd8704f7d` — the head went BACKWARDS — and the fold happily read it as a fix, cleared
        //       the kickback and emptied kickbacks_pending while the PR sat draft at the unchanged head.
        //       Five findings (two P1s, one a credential-egress hole) silently stopped being tracked.
        //       The fold is pure and cannot run `git merge-base`, so ancestry is resolved at APPEND time
        //       and stamped on the event as `sha_descends` (see annotateShaAncestry / reconcilePrEventsInto).
        //       An explicit `false` is a proven backwards move → flap. `undefined` means nobody could
        //       check (an older ledger, or no repo) → fall back to the pre-2026-07-27 inequality test.
        const atKickbackSha = e.sha != null && it.kickback_sha != null && e.sha === it.kickback_sha;
        const wentBackwards = e.sha_descends === false;
        const provenNewSha = e.sha != null && it.kickback_sha != null && e.sha !== it.kickback_sha && !wentBackwards;
        if (atKickbackSha || wentBackwards) break; // (a)/(c) head never moved FORWARD past the kickback → flap
        if (it.kickback_unactioned && !provenNewSha) break; // (b) un-actioned + no head-move proof → flap
        // A proven-new-sha hand-off clearing a pending round means the findings DID reach a lead
        // (a fix exists past the kickback SHA) even if no relay/re-spawn event was recorded —
        // the cloud re-draft cycle takes this path. Count the round here (DER-2491).
        if (it._kb_uncounted && it.kickback_unactioned) { it.kickback_count += 1; it._kb_uncounted = false; }
        it.kickback_unactioned = false; // a genuine hand-off (re-spawn/fix already cleared it, or a proven new sha)
        it.status = "pr_open";
        if (e.pr != null) it.pr = e.pr;
        break;
      }
      case "fix_pushed":
        // PROGRESS SIGNAL ONLY — does NOT clear kickback_unactioned (changed 2026-07-24).
        // The old "head moved ⇒ someone is on it" heuristic was the hole behind two incidents:
        // PR #1008 (an UNRELATED push — the AC3 seat_id fix — cleared kickbacks_pending a minute
        // BEFORE the round-5 findings were even relayed to the lead) and PR #1002 (the orchestrator
        // merged 62s after a round-7 kickback it never saw as pending). A head-move proves motion,
        // not DELIVERY of the findings. Timestamps don't fix it either (the #1008 push postdated
        // the kickback event by seconds). Delivery evidence is exclusively: a `lead_spawned`
        // re-spawn, or an explicit `kickback_relayed` (the re-brief-a-live-lead pattern).
        break;
      case "kickback_relayed":
        // Explicit delivery receipt for the RELAY pattern (findings re-briefed to an ALIVE lead via
        // cmux-say instead of a fresh spawn — see orch/shepherd skills). Mirrors lead_spawned's
        // kickback semantics without fabricating a spawn event. The relay is a delivery, so the
        // round counts here (DER-2491).
        if (it._kb_uncounted) { it.kickback_count += 1; it._kb_uncounted = false; }
        it.kickback_unactioned = false;
        if (it.status === "kickback") it.status = "in_progress";
        break;
      case "kickback":
        // DOUBLE-FIRE / RE-EMIT DEDUP (2026-07-16 run): a second kickback while the first is still
        // un-actioned is the SAME round re-stated (orch+shepherd double-fired 60s apart; shepherd
        // RE-EMITs re-post findings after a dropped re-spawn) — it must not inflate the round
        // counter. The raw event (and its updated findings text) stays in the ledger for the brief
        // dossier; only the fold's count is deduped. A kickback after the prior one was ACTIONED
        // (re-spawn or fix push) is a genuine new round.
        if (it.status === "kickback" && it.kickback_unactioned) break;
        it.status = "kickback";
        // Deliberately NOT counted here (DER-2491): the round counts when its findings are DELIVERED
        // (kickback_relayed / a kickback re-spawn / a proven-new-sha hand-off), so a composed-but-
        // undelivered kickback cannot trip the round breaker.
        it._kb_uncounted = true;
        it.kickback_unactioned = true;
        // Record the round's head SHA (the shepherd stamps `sha` on the kickback event) so the
        // handed_off flap guard above can tell a real head move from a phantom ready-flip (2026-07-18).
        it.kickback_sha = e.sha ?? null;
        break;
      case "pr_merged":
        // DER-2587 — `reaped` is the run's terminal state; a LATE `pr_merged` must not walk it back.
        // Out-of-band merges arrive from two folds (the shepherd and `--reconcile-merged`), and one of
        // them can land after the reap. Regressing reaped→merged made DER-2508 look unfinished, and it
        // absorbed THREE no-op reaps chasing a status that was only ever cosmetic — plus it breaks the
        // naive run-end "everything reaped" check that decides when a run is done.
        if (it.status !== "reaped") it.status = "merged";
        if (e.pr != null) it.pr = e.pr;
        break;
      case "reaped":
        it.status = "reaped";
        // DER-2740: a reap that could not finish its REQUIRED cleanup still reaches terminal status (the
        // run has to be able to end, and panes are swept off the back of this event) — but it records that
        // it was not clean, so `state.reap_failures` can survive the issue going terminal.
        if (e.cleanup_ok === false) it.reap_cleanup_ok = false;
        else if (e.cleanup_ok === true) it.reap_cleanup_ok = true;
        break;
      case "msg_ack":
        // 3.1 — the READ receipt. Handled in the per-issue switch only when it names an issue; the
        // run-level tracking below folds every one regardless, because most actionable messages are
        // addressed to a ROLE (the shepherd) rather than to a unit.
        break;
      case "reap_failed":
        // Separate from `reaped` on purpose: `reaped` is deduped per issue (first wins), so the failure
        // record must be its own event or a re-reap could never report a new leak.
        it.reap_failed = true;
        it.reap_leaks = Array.isArray(e.leaks) ? e.leaks : [];
        it.reap_failed_note = e.reason ?? null;
        it.reap_cleanup_steps = Array.isArray(e.cleanup) ? e.cleanup : [];
        // The event_id a retraction must NAME. Only ONE reap_failed is folded per issue (last wins), so
        // without this a retraction of an EARLIER leak silently clears the banner for the CURRENT one.
        it.reap_failed_event_id = e.event_id ?? null;
        // A later FAILURE re-opens a retracted unit. A leak that recurs after being retracted is exactly
        // what must not stay hidden.
        it.reap_retracted = null;
        it.reap_retraction_rejected = null;
        break;
      case "reap_failure_retracted":
        // 4.4 — an append-only ledger needs a RETRACTION SHAPE.
        //
        // `state.reap_failures` listed DER-2868 forever, even after both its leaks were verified
        // resolved (no process ever existed; the worktree was gone). Terminal events dedupe first-wins,
        // so there was no way to say so — only a prose note beside it in the ledger, which `state` does
        // not read. A permanently wrong banner is not a harmless one: it is how operators learn to skip
        // the banner entirely.
        //
        // This preserves the append-only invariant (nothing is edited or deleted) while letting `state`
        // tell the truth: the original event stays, and a later event REFERENCES it with evidence.
        // Deliberately requires `retracts` (the event_id being retracted) and `evidence` — a retraction
        // with neither is indistinguishable from wishful thinking, and this is the one shape that can
        // clear a safety banner.
        //
        // REFERENCE INTEGRITY, added after an adversarial review caught the obvious hole: requiring
        // `retracts` to be merely NON-EMPTY is not the same as requiring it to name the leak actually
        // on the board. Only one `reap_failed` is folded per issue (last wins), so this sequence
        //     reap_failed EV-1 (remote_pkill) → reap_failed EV-2 (worktree) → retract EV-1
        // cleared the banner for EV-2, a live and never-investigated leak — a remote lead possibly
        // still running and spending, dropped from `state`, from every `watch` wake and from
        // `complete-run`'s exit banner. That is a SILENT PASS introduced by the very fix that was
        // meant to stop a banner from lying. Fail closed: a retraction that does not name the current
        // failure is REJECTED and SAYS SO, because an operator who records one and sees nothing change
        // must not be left guessing whether it was ignored, mistyped, or never arrived.
        if (!e.retracts || !e.evidence) {
          it.reap_retraction_rejected = "a retraction needs BOTH `retracts` (the reap_failed event_id) and `evidence` — one without the other is wishful thinking, and this is the only shape that can clear a safety banner";
        } else if (!it.reap_failed_event_id) {
          it.reap_retraction_rejected = `cannot retract: no reap_failed with an event_id is on record for this unit (retracts=${e.retracts})`;
        } else if (e.retracts !== it.reap_failed_event_id) {
          it.reap_retraction_rejected = `retracts=${e.retracts} but the CURRENT reap_failed is ${it.reap_failed_event_id} — refusing. Retracting an earlier leak must never clear a later, un-investigated one. Investigate ${it.reap_failed_event_id} and retract THAT.`;
        } else {
          it.reap_retracted = { retracts: e.retracts, evidence: e.evidence, by: e.actor ?? null, ts: e.ts ?? null };
          it.reap_retraction_rejected = null;
        }
        break;
      default:
        break;
    }
  }
  // Finalize the per-issue circuit breaker. `tokens` is the deduped sum; `budget` is the worst of the
  // token and round verdicts. An issue already merged/reaped can't be "tripped" — the spend is sunk and
  // the work landed, so flagging it would just add noise to every wake.
  for (const v of Object.values(issues)) {
    v.tokens = Object.values(v._reports).reduce((s, n) => s + n, 0);
    delete v._reports;
    delete v._kb_uncounted;
    // DER-2782 — vet the unit's latest gate_adjudication against its latest gate event, through the
    // SAME contract `ready` uses. A rejected candidate is recorded with its reason rather than dropped:
    // an operator who waived findings and still sees the unit blocked must be able to read why.
    {
      const candidate = latestGateAdjudication(v._gate_adjs, null, { sha: v._gate_event?.sha ?? null });
      const adj = gateAdjudicationVerdict({ gate: v._gate_event, adjudication: candidate });
      v.gate_adjudicated = adj.ok ? { sha: adj.sha, by: adj.by, rationale: adj.rationale, findings: adj.waived } : null;
      v.gate_adjudication_rejected = adj.reason;
      delete v._gate_event;
      delete v._gate_adjs;
    }
    const verdict = (n, warn, trip) => (n >= trip ? "tripped" : n >= warn ? "warn" : "ok");
    const byTokens = verdict(v.tokens, BUDGET.warnTokens, BUDGET.tripTokens);
    // The round count the CAP reads is the greater of the delivered-kickback count and the number of
    // distinct blocker-bearing gates. See the fold: an orchestrator that gates AND dispatches produces
    // no `kickback` event at all, and the pre-2026-08-12 cap read 0 rounds on a PR in its third.
    // `rounds_uncounted` is surfaced rather than silently folded in — a board that says "3 rounds" where
    // the ledger shows 0 kickbacks looks like a bug unless it says which axis it counted.
    const blockerGates = v._blocker_gate_shas ? v._blocker_gate_shas.size : 0;
    delete v._blocker_gate_shas;
    v.rounds_uncounted = Math.max(0, blockerGates - v.kickback_count);
    v.rounds_effective = Math.max(v.kickback_count, blockerGates);
    const byRounds = verdict(v.rounds_effective, BUDGET.warnRounds, BUDGET.tripRounds);
    // Rotation cap (2026-07-25). A rotation is NOT a kickback round — the lead ran out of context, not
    // out of correctness — so it rides its own axis and never inflates the review metrics. But an
    // UNCAPPED rotation is an infinite-life machine: DER-2160 burned ~922M tokens across 9 respawns
    // without landing. At the cap the unit has already had two fresh contexts, so a THIRD request is
    // evidence the unit is too big for one PR — an orchestrator decision (split / re-scope / park),
    // not another respawn. `rotate-lead` refuses at exactly the same boundary.
    const byRotations = (v.rotations ?? 0) >= ROTATION_CAP ? (v.rotate_pending ? "tripped" : "warn") : "ok";
    const rank = { ok: 0, warn: 1, tripped: 2 };
    const worst = [byTokens, byRounds, byRotations].reduce((a, b) => (rank[a] >= rank[b] ? a : b), "ok");
    v.budget = DONE_STATUSES.has(v.status) ? "ok" : worst;
    v.budget_reason = v.budget === "ok"
      ? null
      : [
          rank[byTokens] > 0 ? `${(v.tokens / 1e6).toFixed(0)}M tokens (${byTokens} ≥ ${((byTokens === "tripped" ? BUDGET.tripTokens : BUDGET.warnTokens) / 1e6).toFixed(0)}M)` : null,
          rank[byRounds] > 0 ? `${v.kickback_count} kickback rounds (${byRounds} ≥ ${byRounds === "tripped" ? BUDGET.tripRounds : BUDGET.warnRounds})` : null,
          rank[byRotations] > 0 ? `${v.rotations} rotations (cap ${ROTATION_CAP})${v.rotate_pending ? " + another requested" : ""}` : null,
        ].filter(Boolean).join(" + ");
    // Declared-vs-ASSIGNED (2026-07-25). The pre-run plan assigns the budget; the lead declares its
    // own plan_scope. When the declaration already busts the assignment the unit is over budget
    // BEFORE a line is written — that is the cheapest possible moment to split it, and it is the half
    // the caps alone can't see (a cap only fires after the tokens are spent).
    if (v.assigned && v.plan_scope_seen && !DONE_STATUSES.has(v.status)) {
      const overFiles = v.fileScope.length > v.assigned.files;
      const overAdds = Number.isFinite(v.declared_additions) && v.declared_additions > v.assigned.additions;
      if (overFiles || overAdds) {
        v.plan_scope_over = true;
        v.plan_scope_over_reason = [
          overFiles ? `${v.fileScope.length} files declared vs ${v.assigned.files} assigned` : null,
          overAdds ? `${v.declared_additions} additions declared vs ${v.assigned.additions} assigned` : null,
        ].filter(Boolean).join(" + ");
      }
    }
  }
  const started = new Set(Object.keys(issues));
  // Bundled EXTRA ids ride inside their primary's unit — they start/finish with it, so count them as
  // started too (otherwise an issue-list run shows them queued forever and the run never "drains").
  for (const v of Object.values(issues)) for (const id of v.bundle ?? []) started.add(id);
  const inflight = Object.entries(issues)
    .filter(([, v]) => ACTIVE_STATUSES.has(v.status))
    .map(([k]) => k);
  // Queue = the run's declared issue set (caller-supplied meta.issues wins; else the issue-list run's
  // run_started.issues) minus everything already started. A `<project>` run declares no issues here, so
  // its queue is brain-side (the Todo re-pull) — this only auto-fills for the fixed issue-list form.
  const declared = meta.issues ?? (runStarted?.issues ? runStarted.issues.map((id) => ({ id })) : []);
  // DER-2579 — `queue` under-reported the real backlog, and the orchestrator found it the hard way:
  // it showed 3 when 5 units were actually waiting. `started` is "has ANY event", so the moment an
  // issue receives a `budget_assigned` or a `worktree_created` it drops out of the queue — even though
  // its folded status is still `queued` and no lead exists. Two shifts in a row re-derived the true
  // backlog by hand. The queue is the union: declared-and-never-touched ∪ still-status-queued.
  const neverStarted = declared.map((i) => i.id).filter((id) => !started.has(id));
  const stillQueued = Object.entries(issues).filter(([, v]) => v.status === "queued").map(([k]) => k);
  const queue = [...new Set([...neverStarted, ...stillQueued])];
  return {
    run_id: meta.run_id ?? runStarted?.run_id,
    project: meta.project ?? runStarted?.project ?? null,
    mode: meta.mode ?? runStarted?.mode ?? "project",
    // Spec mode (2026-07-29): the document the units implement, and the ONE Linear issue standing for
    // the whole spec. Surfaced so every consumer — the orchestrator, the shepherd, a successor reading
    // only `state` — knows where to post progress when there are no per-unit Linear issues to update.
    specRef: meta.specRef ?? runStarted?.specRef ?? null,
    tracking: meta.tracking ?? runStarted?.tracking ?? null,
    // DER-2781 — no longer a constant. `meta.status` still wins (the caller-override this field was
    // declared with); absent it, the RUN's terminal state now comes from the ledger, exactly like every
    // other fact in this fold. See runCompletionRefusals for what has to be true before that event exists.
    status: meta.status ?? (runCompleted ? "completed" : "running"),
    completed_at: runCompleted?.ts ?? null,
    // Non-zero means the ledger kept moving AFTER the run was declared complete. Not an error and not a
    // reopening — a visible count, so a late `pr_merged`/`reaped`/`token_usage` is something a successor
    // reads rather than something it has to notice by diffing the ledger against `done`.
    post_completion_events: postCompletion.length,
    post_completion_event_types: [...new Set(postCompletion.map((e) => e?.type).filter(Boolean))].sort(),
    // DER-2838 — `run_completed` markers this fold REFUSED to honor, with the reason. Non-empty means
    // either something tried to end this run without passing the gate, or the run was completed by a
    // build predating the receipt contract (re-run `complete-run`; it is idempotent by gate). Surfaced
    // rather than dropped for the same reason `gate_adjudication_rejected` is: a privileged event that
    // was ignored is a fact about this run, and silence is how the harness's blind spots have all
    // started. Deliberately does NOT include a marker that arrived AFTER a valid completion — that one
    // is already counted as a post-completion event and changes nothing.
    run_completion_rejected: runCompletionRejected,
    issues,
    inflight,
    queue,
    // Kickbacks-pending banner (item 8, 2026-07-15 turnover): issues sitting in `kickback` status with NO
    // re-spawn yet (a re-spawn appends lead_spawned → back to in_progress). Surfaced at the top of `state`
    // so every wake sees pending corrections FIRST — a run once let 2 kickbacks rot ~50 min behind fresh
    // dispatch. The dispatch loop (SKILL §4/§5) handles these before any new-issue dispatch.
    // 2026-07-16: only UN-ACTIONED kickbacks are pending. 2026-07-24: "actioned" now means the findings
    // were DELIVERED — a lead_spawned re-spawn or an explicit kickback_relayed. A bare fix_pushed
    // (head-move) no longer clears this list: on #1008 an unrelated push emptied the banner before the
    // findings were relayed, and on #1002 that blindness preceded a direct merge past 5 open threads.
    kickbacks_pending: Object.entries(issues)
      .filter(([, v]) => v.status === "kickback" && v.kickback_unactioned)
      .map(([k]) => k),
    // Shepherd rotation banner (respawn-over-compact, 2026-07-23): true when the shepherd has
    // requested its own rotation (context nudge) and no fresh shepherd_spawned has landed yet.
    // The orchestrator rotates it at the next quiet moment (§4) instead of waiting for the ~6 h
    // service interval.
    shepherd_rotate_pending: shepherdRotatePending,
    // Lead rotation banner (2026-07-25) — the lead-side analogue of shepherd_rotate_pending, and the
    // gap this whole mechanism closes: the orchestrator and shepherd both rotated before degrading
    // while leads had NO threshold signal and NO rotation, so they ran to their ceiling and stalled
    // (DER-2160's gpt lead sat at 102% of its window). Raised by a lead's own request at its arm band
    // OR by `lead-context --emit` when the detector reads the rotate band; cleared by the
    // `lead_spawned{rotation:n}` that actually rotates it. Honor it the same wake, at the first quiet
    // moment — never mid-hand-off.
    lead_rotate_pending: Object.entries(issues)
      .filter(([, v]) => v.rotate_pending && !DONE_STATUSES.has(v.status))
      .map(([k, v]) => ({ issue: k, pct: v.rotate_pct, disposition: v.rotate_disposition, rotations: v.rotations, source: v.rotate_source ?? "lead", host: v.host, pr: v.pr, ...(v.rotation_blocked ? { blocked: v.rotation_blocked_reason ?? "not_spawned" } : {}) })),
    // Rotations PREPARED but not spawned (DER-4050). A separate banner from `lead_rotate_pending` because
    // the obligation is different: the brief already exists and the only thing missing is a human's
    // deliberate dispatch, so this list is directly actionable rather than a signal to go look.
    lead_rotation_blocked: Object.entries(issues)
      .filter(([, v]) => v.rotation_blocked && !DONE_STATUSES.has(v.status))
      .map(([k, v]) => ({ issue: k, rotation: v.rotation_blocked === true ? null : v.rotation_blocked, reason: v.rotation_blocked_reason ?? "not_spawned", brief: v.rotation_blocked_brief ?? null, host: v.host, worktree: v.worktree ?? null })),
    // Blind-spot banner (2026-07-26). An in-flight lead whose context utilization could not be read.
    // This is NOT lead_rotate_pending — we are not claiming it needs rotating, we are claiming we
    // CANNOT SEE IT, which the orchestrator must resolve by hand (check the pane; check whether the
    // remote head has moved). It exists because the detector's failure mode was silent: a lead that
    // had EXCEEDED its window read as 0% and rendered green, so the one signal built to catch a
    // context wedge went quiet exactly when it mattered. A zeroed gauge is not a healthy gauge.
    lead_context_unreadable: Object.entries(issues)
      .filter(([, v]) => v.context_unreadable && !DONE_STATUSES.has(v.status))
      .map(([k, v]) => ({ issue: k, host: v.host, pr: v.pr, note: v.context_unreadable_note ?? "no usage record" })),
    // Dead-process banner (DER-2516). An in-flight lead whose PROCESS is gone — raised by the
    // lead-context process check, the one probe capable of returning "dead". Before re-spawning,
    // DIFF THE BRANCH AGAINST ITS OPEN FINDINGS FIRST: a lead that dies late looks identical to one
    // that dies early, and DER-2416 died seconds AFTER pushing its final fix — a reflexive respawn
    // would have re-derived ~1,500 lines already on the branch.
    // A death claim is a SUSPICION, never a verdict — confirm with `ps` + `lsof` in the worktree before
    // anyone respawns. A false death that reaches a respawn puts a SECOND writer on a live worktree; on
    // 2026-07-27 that worktree held 315 lines of uncommitted work. `confirm` carries that instruction to
    // every consumer, so a successor reading only the JSON still gets it.
    leads_dead: Object.entries(issues)
      .filter(([, v]) => v.process_dead && ACTIVE_STATUSES.has(v.status))
      .map(([k, v]) => ({
        issue: k, host: v.host, pr: v.pr, note: v.process_dead_note,
        confirm: "SUSPECTED dead — confirm with ps + lsof on the worktree before respawning; a false death puts a second writer on live uncommitted work",
      })),
    // Failed-dispatch banner (DER-2739). A launch the harness could not PROVE — nonzero exit, or exit 0
    // with no `workspace:<n>` on stdout. Before this existed the same event appended a `lead_spawned`, so
    // the failure did not merely go unreported: it read as a healthy in-flight lead, emptied
    // kickbacks_pending (a re-spawn is the sole delivery evidence for a kickback round) and cleared
    // lead_process_dead. Surfaced top-level, and on every wake, for the same reason as kickbacks_pending:
    // the ONLY thing that clears it is a spawn that actually worked.
    // Leaked-teardown banner (DER-2740). Deliberately NOT filtered on DONE_STATUSES the way spawn_failures
    // is: the whole point is that the issue IS terminal (`reaped`) while something it owned is still
    // running or registered. Filtering terminal issues out here would hide exactly the case this exists for.
    reap_failures: Object.entries(issues)
      .filter(([, v]) => v.reap_failed)
      .map(([k, v]) => {
        const guidance = reapLeakGuidance({ leaks: v.reap_leaks, steps: v.reap_cleanup_steps });
        return {
          issue: k, host: v.host, worktree: v.worktree, leaks: v.reap_leaks,
          reason: v.reap_failed_note,
          // 4.5 — say WHICH: a confirmed survivor and an unrunnable probe need different actions.
          kinds: guidance.map((g) => g.kind),
          unverifiable: guidance.some((g) => g.kind === "unverifiable"),
          act: guidance.map((g) => g.note),
          // 4.4 — retraction, rendered rather than removed. The entry stays visible with its evidence,
          // because "this was investigated and closed" is information the next reader needs; what it
          // must stop doing is reading as an OPEN leak.
          retracted: v.reap_retracted ?? null,
          // A REJECTED retraction is named, for the same reason a rejected gate_adjudication is: an
          // operator who recorded one and sees the banner unchanged otherwise cannot tell whether it
          // was ignored, mistyped, or never arrived.
          retraction_rejected: v.reap_retraction_rejected ?? null,
          status: v.reap_retracted ? "RETRACTED" : "open",
          label: v.reap_retracted
            ? `${k} — RETRACTED (${v.reap_retracted.evidence}) [retracts ${v.reap_retracted.retracts}]`
            : k,
        };
      }),
    spawn_failures: [
      ...Object.entries(issues)
        .filter(([, v]) => v.spawn_failed && !DONE_STATUSES.has(v.status))
        .map(([k, v]) => ({
          role: "lead", issue: k, host: v.host, status: v.status, attempts: v.spawn_failed_count,
          exit_code: v.spawn_failed_exit_code, reason: v.spawn_failed_note,
          retry: `no lead exists for ${k} — re-run spawn-lead (the worktree is still registered)`,
        })),
      ...Object.entries(roleSpawnFailed)
        .filter(([, e]) => e)
        .map(([role, e]) => ({
          role, issue: null, host: e.host ?? null, status: null, attempts: 1,
          exit_code: e.exit_code ?? null, reason: e.reason ?? e.note ?? "the launch could not be proven",
          retry: `no ${role} was launched — re-run spawn-${role === "orch" ? "orch" : role}`,
        })),
    ],
    // Transcript-persistence blind spot (DER-2744). An in-flight lead whose launch did NOT attest that it
    // forced session persistence. This is not a claim that the lane is broken — it is a claim that we
    // CANNOT PROVE it writes a transcript, and a lane with no transcript is indistinguishable from a lane
    // whose lead died: `usage` under-reports it, `lead-context` reads nothing, and the rotation bands
    // never fire. `null` (no attestation) is listed alongside an explicit `false`, because the defect this
    // came from was invisible precisely because absence was read as fine.
    //
    // CLOUD leads are excluded: their session runs on an Anthropic-managed VM, so there is no locally
    // readable transcript AT ALL — the skill says so ("cloud leads are not pollable"). Their blind spot is
    // already modelled (they report by PR comment, and lead_context_unreadable covers the probe), so
    // listing them here would put a permanently-red entry in a banner whose whole value is that a
    // non-empty list means act. A banner that is always non-empty is a banner nobody reads.
    //
    // 2026-08-18: the test is `host_kind`, not just the literal name "cloud". A run whose leads went to
    // the SECOND or THIRD cloud account recorded `host:"cloud2"`/`"cloud3"` and matched none of it, so
    // every one of those lanes sat in this banner for the life of the run — the exact always-red state the
    // exclusion exists to prevent. `spawn-cloud` stamps host_kind:"cloud"; the name check stays for events
    // written before it existed.
    transcripts_unverified: Object.entries(issues)
      .filter(([, v]) => v.transcripts_forced !== true && ACTIVE_STATUSES.has(v.status) && v.host !== "cloud" && v.host_kind !== "cloud")
      .map(([k, v]) => ({
        issue: k, host: v.host, leadType: v.leadType, pr: v.pr,
        attested: v.transcripts_forced,
        note: v.transcripts_forced === false
          ? "the launch string did NOT force session persistence — this lane writes no transcript"
          : "the spawn event carries no persistence attestation (older harness on this host, or a hand-appended event) — unknown, not ok",
      })),
    // Circuit-breaker banner (2026-07-25). Issues at/over the per-issue token or round ceiling, worst
    // first. Surfaced top-level for the same reason as kickbacks_pending: the orchestrator must see an
    // overrunning issue at its NEXT wake, not at the post-mortem. `tripped` = stop dispatching more
    // rounds and decide (split / re-scope / escalate); `warn` = the next round is the last cheap one.
    budget_trips: Object.entries(issues)
      .filter(([, v]) => v.budget && v.budget !== "ok")
      .sort((a, b) => (b[1].budget === "tripped" ? 1 : 0) - (a[1].budget === "tripped" ? 1 : 0) || b[1].tokens - a[1].tokens)
      .map(([k, v]) => ({ issue: k, level: v.budget, tokens: v.tokens, rounds: v.kickback_count, rotations: v.rotations, pr: v.pr, reason: v.budget_reason })),
    // Missing-pre-PR-gate banner (DER-2603). Units the shepherd now OWNS (`pr_open`/`kickback` — the PR
    // is handed off) that carry no `review_findings` event at all. `ready` refuses the go-ahead word for
    // these, but the refusal is only met at enqueue time, and on 2026-07-27 three PRs reached that moment
    // ungated in one shift. Surfaced here so the orchestrator sees it while the round is still cheap.
    //
    // Scoped to handed-off units on purpose: the gate is a PRE-PR check, so an in-flight lead that has not
    // handed off yet is not late — listing every open draft would make this permanently non-empty, and a
    // banner that is always red is a banner nobody reads (the DER-2744 lesson, applied here).
    // 3.1 — DELIVERED vs READ, as state. `cmux-say --ledger-ref <id>` refuses to send an actionable
    // message without a ledger counterpart; the recipient appends `msg_ack {ref}`. Anything still
    // unacked past the threshold surfaces here and on every watch wake. Without this, "I told the
    // shepherd" and "the shepherd knows" were the same sentence — a mid-turn session reads its input
    // queue only when the turn ends, and a ruling once sat ~4 minutes before it was seen.
    unacked_messages: unackedMessages,
    // 3.2 — the cheap half of the crossed-messages fix. Shepherd #4's 19:06:03Z memo and the
    // orchestrator's 19:12Z ruling CROSSED IN FLIGHT: both independently re-derived the identical
    // #1185 re-pin recipe. Correct outcome, wasted effort — and it could as easily have produced two
    // DIFFERENT recipes, with no way to tell which was authoritative. Surfacing each unit's freshest
    // notes means an agent sees a sibling's analysis before starting its own.
    recent_notes: recentNotes,
    // 1.3 — the codex waiver, as STATE. It previously existed only as ledger prose, so every `ready`
    // call needed a human to remember it and a successor orchestrator had to be told out of band. An
    // expired waiver is reported too (`active:false, expired:true`) rather than vanishing: "the waiver
    // ran out" and "there was never a waiver" oblige an operator to do different things.
    codex_waiver: codexWaiverFrom(events),
    gate_missing: Object.entries(issues)
      .filter(([, v]) => !v.gate?.seen && v.pr != null && (v.status === "pr_open" || v.status === "kickback"))
      .map(([k, v]) => ({
        issue: k, pr: v.pr, status: v.status, host: v.host,
        note: "no review_findings event — the pre-PR adversarial review gate never ran for this PR. `ready` will refuse it; gate it now (or record why codex is unavailable, WITH the probe output) rather than at enqueue time.",
      })),
    // Open-blockers banner (DER-2782). The gate RAN and its latest verdict still records open blockers,
    // with no adjudication clearing them. `ready` refuses these now, but — exactly as with gate_missing
    // above — the refusal is only met at enqueue time, and the round is cheapest to fix before then.
    // Scoped to handed-off units for the same reason gate_missing is: a lead mid-way through fixing its
    // own round-1 findings is not late, and a banner that is permanently red is a banner nobody reads.
    gate_blocked: Object.entries(issues)
      .filter(([, v]) => v.pr != null && (v.status === "pr_open" || v.status === "kickback")
        && ((v.gate?.blockers ?? 0) > 0 || v.gate?.blockers_unreadable || v.gate?.blockers_inconsistent) && !v.gate_adjudicated)
      .map(([k, v]) => ({
        issue: k, pr: v.pr, status: v.status,
        blockers: v.gate.blockers_unreadable ? "UNREADABLE" : v.gate.blockers_inconsistent ? "INCONSISTENT" : v.gate.blockers,
        sha: v.gate.sha, round: v.gate.round,
        // 1.4 — WHO gated it. A substitute panel and a codex run are different evidence, and a banner
        // that cannot say which is a banner that invites the #1183 misattribution all over again.
        engine: v.gate.engine, substitute: v.gate.substitute, lenses: v.gate.lenses,
        rejected_adjudication: v.gate_adjudication_rejected,
        // DER-2837 — an inconsistent event gets its OWN sentence. "Fix your blockers" is the wrong
        // instruction for evidence whose blocker count cannot be believed in the first place.
        note: v.gate.blockers_inconsistent
          ? `the pre-PR gate's latest verdict is INCONSISTENT WITH ITSELF — it ${v.gate.blockers_inconsistent}. \`ready\` will refuse this PR. Re-run the gate: an under-counted event would otherwise authorize a merge over an open blocker, and no waiver can cover findings the count denies.`
          : "the pre-PR gate's latest verdict still records OPEN blockers. `ready` will refuse this PR. Fix them and re-run the gate, or — orchestrator/operator ONLY — record a gate_adjudication naming every one.",
      })),
    // Waived-findings banner (DER-2782). The AUDIT half, and the reason this list exists at all: a
    // waiver that shows up only as the absence of a block is the silent pass the adjudication event was
    // added to prevent. Listed for the whole run, including merged units — after the fact is precisely
    // when someone asks which blockers shipped waived, and by whom.
    gate_adjudicated: Object.entries(issues)
      .filter(([, v]) => v.gate_adjudicated)
      .map(([k, v]) => ({ issue: k, pr: v.pr, status: v.status, ...v.gate_adjudicated })),
    // Issues with an OPEN PR that never declared a file scope. DER-2161 shipped 98 files / +11,537
    // lines / 5 rounds having emitted no plan_scope at all — an unbounded unit nobody could have
    // caught in flight. A missing scope is itself the finding.
    plan_scope_missing: Object.entries(issues)
      .filter(([, v]) => !v.plan_scope_seen && !DONE_STATUSES.has(v.status) && v.status !== "queued")
      .map(([k]) => k),
    // Units whose OWN declared scope already exceeds the budget the pre-run plan assigned them. Split
    // these before they build, not after they burn: at declaration time a split costs one re-brief.
    plan_scope_over: Object.entries(issues)
      .filter(([, v]) => v.plan_scope_over)
      .map(([k, v]) => ({ issue: k, pr: v.pr, reason: v.plan_scope_over_reason, assigned: v.assigned })),
    // done expands bundles: a merged/reaped primary carries its bundled extras with it.
    done: Object.entries(issues)
      .filter(([, v]) => DONE_STATUSES.has(v.status))
      .flatMap(([k, v]) => [k, ...(v.bundle ?? []).filter((id) => id !== k)]),
    // Push-side context coverage (2026-07-26): latest context_report per session role/issue, emitted
    // by the throttled PostToolUse hook. This is how the ORCHESTRATOR and SHEPHERD — structurally
    // invisible to the worktree-keyed pull probe — finally show up in context accounting, and it
    // keeps reporting for rotated-out originals until their workspace closes. `window:null` means
    // the window is honestly unknown (never guessed); `used` is still real.
    // Wire-protocol health (DER-2748). Always present, so a successor reading only `state.json` learns
    // that this ledger holds a foreign schema or two harness versions WITHOUT having to hit the dispatch
    // refusal to find out. `ok:false` is what the dispatch gate blocks on.
    protocol: ledgerProtocolVerdict(rawEvents ?? events),
    // Byte-level ledger health (DER-2738), alongside the wire-protocol verdict above and for the same
    // reason: a successor reading only state.json must learn that lines of this ledger NEVER FOLDED.
    // `null` means "not measured by this caller" — never "clean". `state` and `watch` always measure.
    ledger: meta.ledger ?? null,
    session_context: (() => {
      const m = {};
      for (const e of events) {
        if (e?.type !== "context_report") continue;
        const key = e.issue ? `${e.role}:${e.issue}` : `${e.role}:${e.session ?? ""}`;
        m[key] = { role: e.role, issue: e.issue ?? null, used: e.used ?? null, window: e.window ?? null, pct: e.pct ?? null, model: e.model ?? null, ts: e.ts ?? null };
      }
      return m;
    })(),
  };
}

// ---------------------------------------------------------------------------
// Run completion (DER-2781) — the fail-closed terminal run state
// ---------------------------------------------------------------------------
// `status` was a CONSTANT: every run ever folded read `"running"`, because no event could set it, no call
// site passed `meta.status`, and nothing read the field. A run therefore had no machine-checkable end —
// closeout was prose in SKILL.md plus `/goal complete`, and "is this run actually finished?" was answered
// by a human eyeballing the ledger. DER-1589 is the checklist; this is its machine half.
//
// ALL of the value is in the GATE, none of it in the flag. A `complete-run` that stamps `completed` on
// command is a check that cannot fail — the precise defect class this wave exists to remove — so every
// fact that would make "this run is finished" a LIE is enumerated here, as data, in one pure function
// that the subcommand and its tests both call.
//
// There is deliberately NO `--force`. Every check's escape is a real act with a real receipt, never a
// bypass flag: reap a stranded unit, deliver a pending kickback, repair or acknowledge quarantined lines
// by deleting their sidecar, acknowledge a dead host's held fragment by deleting its `sync-held.<host>.json`
// (DER-2776 shipped that path exactly so an abandoned host cannot make completion unsatisfiable), and
// `--allow-version-skew` for a deliberate mid-run host upgrade. A foreign `schema_version` has no escape
// at all, matching assertLedgerProtocolCompatible: there is no degraded mode for lines this build cannot
// parse, so there is certainly no "complete anyway".
//
// Pure. `state` is a materializeState result; `ledger` is a readLedgerHealth result (or null).
//
// DER-2838 (#8) — `protocol` overrides `state.protocol`. `materializeState` reports what the LEDGER
// records (and must keep doing so: `state`/`watch` describe the run, not their reader), so check 7 only
// ever compared versions already written — the exact blind spot DER-2779 closed for dispatch, left open
// on the one other path that WRITES. The caller passes the verdict computed with
// `currentVersionAttestation()`, so the process about to append the terminal marker is one of the
// versions compared. Absent an override the old behaviour stands, which is what a hand-built test state
// and any other caller get.
export function runCompletionRefusals({ state = {}, ledger = null, allowVersionSkew = false, protocol: attestedProtocol = null } = {}) {
  const refusals = [];
  const add = (check, reason, fix) => { refusals.push({ check, reason, fix }); };
  const issues = state.issues ?? {};
  const queue = state.queue ?? [];

  // 1. A run tracking NOTHING is not a finished run, it is an empty one. Without this, `every([])` is
  //    vacuously true and the gate passes a ledger holding only `run_started` — a gate answering a
  //    question it was never asked. It is also the exact signature of DER-2570's phantom ledger (a `cd`
  //    forks a second, empty events.jsonl for a live run id), which reads healthy from every angle.
  const trackedIds = [...new Set([...Object.keys(issues), ...queue])].sort();
  if (!trackedIds.length) {
    add(
      "units_tracked",
      "this run tracks no units at all — no issue events folded and the queue is empty",
      "check --run / --runs-root first: an empty ledger for a live run id is DER-2570's phantom ledger, which reads healthy from every angle. A run that genuinely dispatched nothing has nothing to complete.",
    );
  }

  // 2. Every tracked unit terminal. `merged` (pr_merged) and `reaped` are the two terminal statuses;
  //    a `queued` id that never got an event of its own is tracked via state.queue and counts here too.
  const nonTerminal = trackedIds
    .filter((id) => !DONE_STATUSES.has(issues[id]?.status ?? "queued"))
    .map((id) => `${id} (${issues[id]?.status ?? "queued"})`);
  if (nonTerminal.length) {
    add(
      "units_terminal",
      `${nonTerminal.length} unit(s) are not terminal: ${nonTerminal.join(", ")}`,
      "land or abandon each one — a unit is terminal at `merged` (a folded pr_merged) or `reaped`. `reap --run <r> <id>` closes a queued/merged unit; `reap --abandon` destroys an ACTIVE one out loud.",
    );
  }

  // 3. Pending kickbacks. Structurally this cannot fire without (2) firing too — `kickbacks_pending`
  //    filters on status `kickback`, which is not terminal — so it is not an independent gate. It is
  //    kept because it names the ACTION (deliver the findings) that (2)'s generic "not terminal" does
  //    not, and because a future terminal status must not quietly take a rotted kickback with it.
  const kickbacks = state.kickbacks_pending ?? [];
  if (kickbacks.length) {
    add(
      "kickbacks_pending",
      `${kickbacks.length} kickback round(s) were composed but never DELIVERED: ${kickbacks.join(", ")}`,
      "re-spawn the lead (a spawn IS the delivery) or append `kickback_relayed` once the findings actually reached someone — never clear it by hand.",
    );
  }

  // 4. Unacknowledged quarantine: lines that NEVER folded into state. While any exist, every count in
  //    this run — `done`, the token totals, the metrics — is a LOWER BOUND, so "complete" would be a
  //    claim about a fold that is known to be missing input.
  const quarantined = ledger ? (ledger.quarantined_unacknowledged ?? 0) : 0;
  if (quarantined > 0) {
    add(
      "ledger_quarantine",
      `${quarantined} ledger line(s) never folded into state — every count in this run is a LOWER BOUND until they do`,
      `repair them from ${ledger?.quarantine_file ?? "the quarantine sidecar"}, or delete that file to acknowledge them.`,
    );
  }

  // 5. DER-2776's held-fragment age signal. A FRESH hold is a live writer mid-append and is deliberately
  //    silent; a STALE one means a remote writer died mid-line and the pull is re-reading a line nobody
  //    will ever finish — events are still being WITHHELD, so the run is not over. Gated on
  //    `held_fragment_stale` rather than on `ledger.ok`: `ok` is a compound whose composition can change,
  //    and this check has to name the host and the exact file to delete, which only the field can supply.
  const heldStale = (ledger?.held_fragments ?? []).filter((h) => h && h.stale);
  const heldFired = !!ledger && (ledger.held_fragment_stale ?? 0) > 0;
  if (heldFired) {
    const hosts = heldStale.map((h) => `${h.host}${h.age_ms == null ? " (age unknown)" : ` (${h.age_ms}ms)`}`);
    const files = heldStale.map((h) => h.file).filter(Boolean);
    add(
      "ledger_held_fragments",
      `${ledger.held_fragment_stale} remote host(s) are holding an UNTERMINATED tail line${hosts.length ? `: ${hosts.join(", ")}` : ""} — that host's writer died mid-line and its events are still being withheld`,
      `complete the line on the host (the hold clears itself), or acknowledge the dead writer by deleting ${files.length ? files.join(", ") : "its sync-held.<host>.json record"} (DER-2776).`,
    );
  }

  // 6. The catch-all, and the reason it exists: `readLedgerHealth().ok` is the harness's own summary of
  //    ledger damage, and checks 4 and 5 name only the two causes THIS gate knows about. Anything else
  //    `ok` already covers (a torn tail mid-append right now) — and anything a later change folds into it
  //    — must still refuse, rather than passing because this function was written before that signal
  //    existed. A NULL ledger is a refusal for the same reason `state`'s own comment gives: "not measured
  //    by this caller" is never "clean".
  if (!ledger) {
    add(
      "ledger_health",
      "ledger health was NOT MEASURED for this run — unmeasured is not clean",
      "`complete-run` measures it itself; a null here means the gate was called with a hand-built state (tests), not a real run.",
    );
  } else if (ledger.ok !== true && quarantined === 0 && !heldFired) {
    const why = [];
    if ((ledger.torn_tail ?? 0) > 0) why.push(`${ledger.torn_tail} torn tail line(s) — a writer is mid-append RIGHT NOW`);
    if ((ledger.quarantined ?? 0) > 0) why.push(`${ledger.quarantined} line(s) quarantined on this read`);
    if (ledger.note) why.push(ledger.note);
    add(
      "ledger_health",
      why.length
        ? `readLedgerHealth reports the ledger is not ok: ${why.join("; ")}`
        : "readLedgerHealth reports ok:false for a reason this gate does not recognize — treat an unexplained unhealthy ledger as unsafe to declare finished",
      "a torn tail is transient (it clears the moment the writer finishes the line) — re-run. Anything else: read `state`'s `ledger` block, which names its own repair path.",
    );
  }

  // 7. Wire-protocol verdict (DER-2748, DER-2779, DER-2838). The caller supplies a verdict that includes
  //    THIS process's own attested version, so a caller on a different build is refused BEFORE it appends
  //    a terminal marker and auto-attests its version into the ledger behind it. Same split
  //    assertLedgerProtocolCompatible applies, deliberately
  //    reused rather than re-invented stricter: harness-version SKEW is a mid-run host upgrade the
  //    operator may acknowledge with --allow-version-skew, and a FOREIGN schema_version never is. Without
  //    the skew escape a multi-host run whose mini was upgraded could never be completed at all.
  const protocol = attestedProtocol ?? state.protocol ?? null;
  if (!protocol) {
    add(
      "protocol",
      "this fold carries no wire-protocol verdict",
      "materializeState always sets `protocol`; a missing one means the gate was handed a hand-built state.",
    );
  } else if (protocol.ok !== true) {
    const foreign = (protocol.foreign_schema_versions ?? []).length
      ? (protocol.reasons ?? []).filter((r) => String(r).startsWith("foreign schema_version"))
      : [];
    const blocking = allowVersionSkew ? foreign : (protocol.reasons ?? []);
    if (blocking.length) {
      add(
        "protocol",
        blocking.join(" "),
        allowVersionSkew
          ? "a foreign schema_version is NOT overridable — there is no degraded mode for lines this build cannot parse."
          : "re-install the lagging host (install.sh) so every host reports the same VERSION, or pass --allow-version-skew to acknowledge a deliberate mid-run upgrade. That flag never waives a foreign schema_version.",
      );
    }
  }

  return refusals;
}

// The refusal an operator actually reads. Every failing check, its reason, and the act that clears it —
// never a single "not ready" line, because a gate that says only "no" sends the operator back to the
// ledger to re-derive what this function already knows.
export function renderRunCompletionRefusal({ runId = null, refusals = [] } = {}) {
  return [
    `refusing to complete run "${runId ?? "?"}": ${refusals.length} check(s) failed. NOTHING was appended.`,
    ...refusals.map((r) => `  ✗ ${r.check}: ${r.reason}\n      fix: ${r.fix}`),
    `  There is no --force: a run declared complete over a failing check is a receipt that lies about the`,
    `  work. Clear the checks above (each names its own escape) and run \`complete-run\` again.`,
  ].join("\n");
}

// Operator monitoring (item 7, 2026-07-15 turnover): the per-lead teleport/monitor link list the
// orchestrator publishes to `<runDir>/links.md` so the operator stops grepping PR bodies for handles.
// Each cloud lead's draft-PR footer handle (`session_01…`, folded onto `issues[id].handle`) becomes a
// read-only `claude.ai/code` monitor URL — open it in the CMUX browser pane with `cmux open <url>` (from
// the account that OWNS the cloud env). Pure; skips issues with no handle (local/mini leads have none).
export function renderLinksMd(state = {}) {
  const issues = state.issues ?? {};
  const rows = Object.entries(issues)
    .filter(([, v]) => v && v.handle)
    .map(([id, v]) => `- **${id}**${v.pr ? ` (PR #${v.pr})` : ""} · ${v.status ?? "?"} — https://claude.ai/code/${v.handle}`);
  const lines = [`# Cloud lead monitors${state.run_id ? ` — ${state.run_id}` : ""}`, ``];
  lines.push(...(rows.length ? rows : ["_(no cloud leads with a monitor handle yet)_"]));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Token-usage telemetry (2026-07-16) — fleet distribution for perf analysis / fine-tuning
// ---------------------------------------------------------------------------
// Every /work session self-reports at end-of-session via `scripts/session-token-report.mjs`
// : cloud leads as a WORK-EVENT PR comment (folded by
// reconcile-pr-events), local/mini leads + shepherd + orchestrator via direct `append`. The
// event shape: {type:"token_usage", role, issue(s), pr, host, kickback?, model,
// by_model:{<model>:{input,output,cache_creation,cache_read}}, total, total_tokens,
// cost_usd_estimate, ts}. This fold sums them per role × model. Pure.

const TOKEN_FIELDS = ["input", "output", "cache_creation", "cache_read"];
const zeroTokens = () => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0 });
const addTokens = (acc, u) => { for (const f of TOKEN_FIELDS) acc[f] += Number(u?.[f] ?? 0) || 0; };
const sumTokens = (u) => TOKEN_FIELDS.reduce((s, f) => s + u[f], 0);

export function aggregateTokenUsage(events = []) {
  // Idempotence across retries/re-reports (Codex P2 on PR #852): reports are CUMULATIVE
  // (each re-reads the whole transcript), and a retried post or a same-session re-report
  // carries a new ts. Events sharing a report_id (stable per-session hash) collapse to the
  // single latest/largest record; report_id-less events keep legacy every-event counting.
  const byReport = new Map();
  const counted = [];
  for (const e of events) {
    if (!e || e.type !== "token_usage" || !e.by_model || typeof e.by_model !== "object") continue;
    if (!e.report_id) { counted.push(e); continue; }
    const prev = byReport.get(e.report_id);
    const better = !prev
      || (Number(e.total_tokens ?? 0) > Number(prev.total_tokens ?? 0))
      || (Number(e.total_tokens ?? 0) === Number(prev.total_tokens ?? 0) && String(e.ts ?? "") > String(prev.ts ?? ""));
    if (better) byReport.set(e.report_id, e);
  }
  counted.push(...byReport.values());

  const by_model = {};
  const by_role = {};
  // 4.2 — per-INSTANCE spend, so `shepherd#4` and `shepherd#5` are separable in the run report.
  const by_instance = {};
  const total = zeroTokens();
  let reports = 0;
  let cost = 0;
  let costKnown = true;
  // Unpriced-spend accounting (2026-07-25). The old contract nulled the ENTIRE run's cost the moment
  // one report lacked `cost_usd_estimate` — so a night whose deepseek/kimi/gpt sessions were unpriced
  // reported either "n/a" or, worse, a confident number that silently excluded them (run
  // 20260725T020304Z's $1,062 omitted DER-2160's ~716M tokens). Now: sum what IS priced, price what we
  // have a configured rate for, and report the remaining gap explicitly instead of hiding it.
  let unpricedTokens = 0;
  let unpricedReports = 0;
  const unpricedModels = new Set();
  for (const e of counted) {
    reports += 1;
    // 4.2 — an actor may name its INSTANCE (`shepherd#4`). Bucket by role as before so every existing
    // reader is unchanged, and additionally by instance, so a run's five shepherds stop collapsing into
    // one row. `by_instance` keys role-only actors as themselves rather than guessing `#1`: crediting an
    // unidentifiable shepherd to the first one is exactly the misattribution this item exists to stop.
    const rawActor = String(e.actor ?? "");
    const parsed = parseActorInstance(rawActor);
    const role = e.role ?? (rawActor.startsWith("lead") ? "lead" : parsed.role || rawActor || "unknown");
    const instanceKey = parsed.instance != null ? rawActor : (e.instance ?? role);
    if (!by_role[role]) by_role[role] = { by_model: {}, total: zeroTokens() };
    if (!by_instance[instanceKey]) by_instance[instanceKey] = { role, instance: parsed.instance ?? null, total: zeroTokens() };
    addTokens(by_instance[instanceKey].total, Object.values(e.by_model).reduce((acc, u) => { addTokens(acc, u); return acc; }, zeroTokens()));
    for (const [m, u] of Object.entries(e.by_model)) {
      if (!by_model[m]) by_model[m] = zeroTokens();
      if (!by_role[role].by_model[m]) by_role[role].by_model[m] = zeroTokens();
      addTokens(by_model[m], u);
      addTokens(by_role[role].by_model[m], u);
      addTokens(by_role[role].total, u);
      addTokens(total, u);
    }
    if (e.cost_usd_estimate != null) {
      cost += Number(e.cost_usd_estimate) || 0;
      continue;
    }
    // Unpriced report: price what we can, and book the REST to the visible gap. #7 — this used to be
    // all-or-nothing per report, so one priced model made a mixed report read as fully priced.
    const b = priceBreakdown(e.by_model);
    cost += b.cost;
    if (b.unpriced.length) {
      costKnown = false;
      unpricedReports += 1;
      for (const m of b.unpriced) {
        unpricedModels.add(m);
        unpricedTokens += sumTokens(e.by_model[m]);
      }
    }
  }
  return {
    reports,
    total,
    total_tokens: sumTokens(total),
    by_model,
    by_role,
    by_instance,
    // The PRICED subset — never null now, so a partially-unpriced run still reports the spend it can
    // account for. Read it together with cost_is_partial/unpriced_* below; alone it is a FLOOR.
    cost_usd_estimate: Math.round(cost * 10000) / 10000,
    cost_is_partial: !costKnown,
    unpriced_reports: unpricedReports,
    unpriced_tokens: unpricedTokens,
    unpriced_models: [...unpricedModels].sort(),
  };
}

// Markdown table for the end-of-run report: totals, by model, and role × model distribution.
// 5.3 — a total must declare its FLOORS.
//
// `usage` already flagged unpriced spend (cost). It did not flag STRUCTURAL gaps — reports that were
// never folded at all — and those move the TOKEN total, not just the dollar one. Two measured on
// 2026-07-31: cloud reports before ~18:15Z were silently refused by the `trustedCommentAuthors`
// deny-list, and a host whose ledger could not be pulled contributes nothing while reading as zero.
//
// The distinction that matters: a missing report makes the total a LOWER BOUND, and a lower bound
// presented as a total is how a run gets compared against a baseline it never actually beat.
export function usageFloorNotes({ droppedReports = 0, undrainedHosts = [], droppedAuthors = [] } = {}) {
  const notes = [];
  if (droppedReports > 0) {
    notes.push(`${droppedReports} report(s) were REFUSED at ingestion${droppedAuthors.length ? ` (untrusted comment author: ${droppedAuthors.join(", ")})` : ""} — ` +
      "their tokens are in NOBODY's total. Add the author to `repo.trustedCommentAuthors` and re-run `reconcile-pr-events`.");
  }
  if (undrainedHosts.length) {
    notes.push(`${undrainedHosts.length} host ledger(s) could NOT be drained (${undrainedHosts.join(", ")}) — ` +
      "every lead that ran there contributes ZERO here, which is indistinguishable from a lead that spent nothing. Run `pull-host --run <r> --host <h>` and re-read.");
  }
  return notes;
}

export function renderUsageMd(agg, { runId, droppedReports = 0, undrainedHosts = [], droppedAuthors = [] } = {}) {
  const fmt = (n) => n.toLocaleString("en-US");
  const floors = usageFloorNotes({ droppedReports, undrainedHosts, droppedAuthors });
  const L = [
    `# Token usage — ${runId ?? "run"}`,
    ``,
    `- **Usage reports folded:** ${agg.reports}${agg.reports === 0 ? " _(no token_usage events — check that leads/shepherd emitted at end-of-session)_" : ""}`,
    `- **${floors.length ? `TOTAL (FLOOR — ${droppedReports + undrainedHosts.length} report source(s) known missing)` : "Total tokens"}:** ${fmt(agg.total_tokens)}  (input ${fmt(agg.total.input)} · output ${fmt(agg.total.output)} · cache-write ${fmt(agg.total.cache_creation)} · cache-read ${fmt(agg.total.cache_read)})`,
    ...floors.map((n) => `  - ⚠ ${n}`),
    `- **Est. cost:** ${agg.cost_usd_estimate != null ? `$${agg.cost_usd_estimate.toFixed(2)}` : "n/a"}${agg.cost_is_partial ? ` — **FLOOR ONLY**` : ""} _(price-table estimate — never billing truth)_`,
    ...(agg.cost_is_partial
      ? [`- **Unpriced spend:** ${fmt(agg.unpriced_tokens)} tokens across ${agg.unpriced_reports} report(s) carry NO cost — models: ${agg.unpriced_models.join(", ") || "unknown"}. The figure above EXCLUDES them. Add rates to \`.claude/work.config.json\` \`modelPrices\` (USD per million), and check the provider's own billing dashboard for truth.`]
      : []),
    ``,
    `## By model`,
    ``,
    `| Model | Input | Output | Cache write | Cache read | Total |`,
    `|---|---:|---:|---:|---:|---:|`,
    ...Object.entries(agg.by_model)
      .sort((a, b) => sumTokens(b[1]) - sumTokens(a[1]))
      .map(([m, u]) => `| ${m} | ${fmt(u.input)} | ${fmt(u.output)} | ${fmt(u.cache_creation)} | ${fmt(u.cache_read)} | ${fmt(sumTokens(u))} |`),
    ``,
    `## By role × model`,
    ``,
    `| Role | Model | Input | Output | Cache write | Cache read | Total |`,
    `|---|---|---:|---:|---:|---:|---:|`,
  ];
  for (const [role, r] of Object.entries(agg.by_role).sort((a, b) => sumTokens(b[1].total) - sumTokens(a[1].total))) {
    for (const [m, u] of Object.entries(r.by_model).sort((a, b) => sumTokens(b[1]) - sumTokens(a[1]))) {
      L.push(`| ${role} | ${m} | ${fmt(u.input)} | ${fmt(u.output)} | ${fmt(u.cache_creation)} | ${fmt(u.cache_read)} | ${fmt(sumTokens(u))} |`);
    }
    L.push(`| **${role}** | _all_ | | | | | **${fmt(sumTokens(r.total))}** |`);
  }
  return L.join("\n") + "\n";
}

// B3 — reconcile the ledger against `gh` truth. Given the folded state's issue map and the set of PR
// numbers gh reports merged, emit a `pr_merged` event for every still-in-flight issue whose PR has
// merged with no shepherd `pr_merged` event (out-of-band / merge-queue merges leave no shepherd event,
// so the watch-events-only loop would miss them). Idempotent: once appended, the issue folds to
// `merged` and is skipped next cycle. Pure — the caller supplies the live merged-PR list from gh.
export function mergedReconcileEvents({ issues = {}, mergedPrNumbers = [] } = {}) {
  const merged = new Set(mergedPrNumbers);
  const out = [];
  for (const [id, it] of Object.entries(issues)) {
    if (it.pr != null && merged.has(it.pr) && ACTIVE_STATUSES.has(it.status)) {
      out.push({ actor: "reconcile", type: "pr_merged", issue: id, pr: it.pr });
    }
  }
  return out;
}

// The event types worth WAKING a poll loop for — a PR opened, merged, kicked back, reaped, or a lead
// that died. `plan_scope`/`worktree_created`/`lead_spawned` are orchestration noise the loop shouldn't
// re-decompose on. `watch --wake-on actionable` filters to this set; `--wake-on a,b` names types
// explicitly; omitting --wake-on wakes on ANY new event (the original, back-compatible default).
// DER-2739 adds the three `*_spawn_failed` types. A SUCCESSFUL spawn stays noise (it is the loop's own
// action), but a dispatch that DIDN'T happen is the one thing the loop must re-decide, and it is invisible
// to a watcher that only wakes on progress.
export const ACTIONABLE_EVENT_TYPES = [
  "pr_opened", "handed_off", "pr_merged", "kickback", "reaped", "lead_failed",
  "lead_spawn_failed", "shepherd_spawn_failed", "orch_spawn_failed",
  "reap_failed",
];
export function parseWakeOn(spec) {
  if (!spec) return null; // null ⇒ wake on any new event (unchanged default)
  if (spec === "actionable") return new Set(ACTIONABLE_EVENT_TYPES);
  return new Set(spec.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean));
}

// B5: the ordered git commands to clean up a local worktree at reap. A lead's own `git merge
// --no-commit` gymnastics can leave a stale AUTO_MERGE pseudo-ref in the worktree's git-dir — harmless
// (no MERGE_HEAD; the commit still landed) and usually swept by the worktree removal, but delete it
// explicitly first so nothing lingers. The AUTO_MERGE step is `optional` (a missing ref makes
// `update-ref -d` exit non-zero — the caller ignores it). Pure; empty when there's no worktree.
// DER-2740. `reap` discarded all four cleanup results and appended the TERMINAL `reaped` regardless, so a
// failure became unreachable: `dedupeTerminalEvents` keeps the FIRST `reaped` per issue, which means a
// premature one can never be corrected by appending a better one later.
//
// Not every nonzero exit is a leak, and treating one as such would be the inverse defect. The AUTO_MERGE
// `update-ref -d` is marked `optional` because a MISSING ref is the normal case, and the commonest local
// `worktree remove` failure is "already gone" — the desired end state. Two steps are REQUIRED, because
// their failure leaves something running or registered that nothing else reclaims:
//   remote_pkill            the mini's claude survives `close-workspace` (that only drops the ssh), so a
//                           failed pkill leaves a lead ALIVE burning tokens while the ledger says reaped
//   remote_worktree_remove  nothing re-derives worktrees from the ledger, and since DER-2742 a later run
//                           REFUSES the leaked path instead of silently deleting it — visible, but stuck
// Panes are deliberately NOT required: appending `reaped` is exactly what enqueues an issue's refs into
// `sweepPlan`, and `sweep-workspaces` re-closes them at every orchestrator boot AND checks exit codes, so
// a pane close that fails here really is retried. (The issue's original framing had this backwards.)
export const REAP_REQUIRED_STEPS = ["remote_pkill", "remote_worktree_remove"];

export function reapCleanupOutcome(steps = []) {
  const attempted = steps.filter((x) => x && x.step);
  // `optional` is finally READ. It has been set on the AUTO_MERGE command since that helper was written
  // and no caller ever looked at it — a marker that meant nothing is indistinguishable from no marker.
  //
  // DER-2775: exit code is no longer the only failure signal. A kill step carries a `probe` verdict from
  // the postcondition check (classifyKillProbe), and a chain that finds the process STILL ALIVE exits 0 —
  // so `exit_code` alone reads that as a clean teardown. Only `killed` passes; `survivor` and `unknown`
  // both leak, because "I could not verify" must never be recorded as "it is gone".
  const failed = attempted.filter((x) => !x.optional
    && (Number(x.exit_code) !== 0 || (x.probe != null && x.probe !== "killed")));
  const leaks = failed.filter((x) => REAP_REQUIRED_STEPS.includes(x.step)).map((x) => x.step);
  return {
    ok: leaks.length === 0,
    leaks,
    failed_steps: failed.map((x) => x.step),
    steps: attempted.map((x) => ({
      step: x.step, exit_code: Number(x.exit_code) || 0, optional: Boolean(x.optional),
      ...(x.probe != null ? { probe: x.probe } : {}),
      ...(x.stderr ? { stderr: String(x.stderr).slice(0, 400) } : {}),
    })),
  };
}

// What each leaked step obliges the operator to do. A banner that names a step without saying what it
// costs gets skimmed; the live-remote-lead case is the one that spends money while unattended.
export const REAP_LEAK_NOTES = {
  remote_pkill: "the remote claude is or may still be ALIVE and burning tokens (the post-kill pgrep probe did not come back clean) — ssh to the host and pkill it by its brief path, then confirm with pgrep",
  remote_worktree_remove: "the remote worktree is still registered — `git -C <repo> worktree remove --force <path>` on that host (a later run will REFUSE the path, not reclaim it)",
};

// 4.5 — the probe ALREADY distinguishes "still running" from "could not check". The `reason` field
// carries it (via KILL_PROBE_NOTES) and always has. But the ALWAYS-SHOWN guidance — `act`, and the CLI
// banner — rendered every leak with the single confirmed-alive wording above, so an operator read
// "burning tokens" and went hunting.
//
// DER-2868's "leak" was: NO PROCESS EVER EXISTED, and the probe simply could not run because ssh was
// down. The distinction is not cosmetic — `failed` means go kill something, `unverifiable` means go find
// out whether there is anything to kill, and one of those is a wild goose chase. Same UNKNOWN-vs-ABSENT
// discipline the gate verdict and the codex probe both draw.
export const REAP_LEAK_NOTES_UNVERIFIABLE = {
  remote_pkill: "UNVERIFIABLE, not confirmed alive: the post-kill probe never returned a verdict (ssh, the remote shell, or pgrep itself failed) — so we do not know whether a process was ever there. FIRST check reachability (`ssh <host> true`), THEN `pgrep -fa <brief path>`. Do not assume a leak: a probe that could not run is not evidence of a survivor.",
  remote_worktree_remove: "UNVERIFIABLE: the remote cleanup command could not be run or its result could not be read — confirm with `git -C <repo> worktree list` on that host before removing anything",
};

// Pick the guidance that matches the PROBE's actual verdict. Steps carry `probe: "survivor"|"unknown"`;
// anything else (a plain nonzero exit) is a genuine failure.
export function reapLeakGuidance({ leaks = [], steps = [] } = {}) {
  const probeByStep = new Map((steps ?? []).map((st) => [st.step, st.probe ?? null]));
  return (leaks ?? []).map((step) => {
    const unverifiable = probeByStep.get(step) === "unknown";
    const note = (unverifiable ? REAP_LEAK_NOTES_UNVERIFIABLE : REAP_LEAK_NOTES)[step] ?? step;
    return { step, kind: unverifiable ? "unverifiable" : "failed", note };
  });
}

export function reapCleanupCommands({ worktree, gitCwd } = {}) {
  if (!worktree) return [];
  return [
    { command: "git", args: ["-C", worktree, "update-ref", "-d", "AUTO_MERGE"], optional: true },
    { command: "git", args: ["-C", gitCwd, "worktree", "remove", "--force", worktree] },
  ];
}

// The REMOTE half of reap's cleanup, as the one ssh shell string it has to become. The local half above
// passes argv and is structurally uninjectable; this one is a string, and DER-2737 found `it.worktree`
// interpolated into it RAW — the only unquoted use of it.worktree in the file, while every sibling (the
// pkill in the same block, the status probe at 1642, the context probe at 1704) already shellQuoted.
// `worktree` arrives from the LEDGER, and a PR comment could write the ledger, so the PoC reached
// `; touch …; #`. With no ssh host configured it still degraded to `worktree remove --force <any path>`.
// Pure and exported so the injection control is a unit test, not a live reap.
export function reapRemoteCleanupCommand({ worktree, repo } = {}) {
  if (!worktree) return null;
  const wt = shellQuote(worktree);
  return `git -C ${wt} update-ref -d AUTO_MERGE 2>/dev/null; git -C ${shellQuote(repo ?? ".")} worktree remove --force ${wt}`;
}

// ---------------------------------------------------------------------------
// Proving the kill (DER-2775)
// ---------------------------------------------------------------------------
//
// Every remote teardown used to be `pkill -f <pat>; true`. Two independent masks: `; true` discards
// pkill's exit code outright, and pkill's exit code never meant "it is gone now" — only "I matched
// something and signalled it". So a lead that ignored, outlived, or never received the signal produced a
// clean receipt. The postcondition has to be PRESENCE, measured AFTER the kill, in the same round trip.
//
// PORTABILITY — the probe must not see ITSELF, and the two pgrep families differ (verified live
// 2026-07-30 on macOS 15 BSD pgrep and, in a container, procps-ng 4.0.4):
//   * BSD/macOS pgrep excludes itself AND its ancestors, so a raw pattern is already clean there.
//   * procps-ng excludes only itself. ssh runs the chain in a shell whose own cmdline contains the
//     pattern, so `pgrep -f <raw>` matched that shell and reported RC=0 — a PHANTOM survivor on every
//     probe, with no target running at all (measured). Left unescaped, this fix would make `rotate-lead`
//     refuse to respawn on every Linux host, which is worse than the bug it closes.
//   * Worse still, `pkill -f <raw>` run from inside that shell SIGTERMs its own parent: the raw chain
//     printed no RC line at all and the shell exited 143 (measured). So the escape is required on the
//     pkill half too, not only the probe half.
// The fix is the `ps aux | grep '[s]shd'` trick. `[/]Users/x` is a regex matching the literal `/Users/x`,
// so it still matches the TARGET's cmdline, while the probing shell's own cmdline holds the literal
// characters `[/]Users/x`, which that regex does not match.
//
// A bracket expression whose single member is `^`, `]`, `-` or `\` is ambiguous or invalid across
// implementations, so only unambiguous literals are bracketed; anything else falls through to the raw
// pattern (fail-soft, and unreachable for the absolute paths every caller passes).
const BRACKET_SAFE_CHAR = /[A-Za-z0-9_/.@+:,%=~]/;

export function bracketEscapePattern(pattern) {
  const s = String(pattern ?? "");
  for (let i = 0; i < s.length; i += 1) {
    if (BRACKET_SAFE_CHAR.test(s[i])) return `${s.slice(0, i)}[${s[i]}]${s.slice(i + 1)}`;
  }
  return s;
}

// --- The pattern itself is the dangerous value ------------------------------------------------------
//
// This string is the sole argument to `pkill -f` on a remote host. `pkill -f ''` matches EVERY process
// there, and a one-character pattern matches most of them — a degenerate pattern does not fail, it kills
// the machine. Callers interpolate `${ledgerRoot}/${runId}/briefs/${issueId}`, and none of those three
// components is validated anywhere upstream: an empty `ledgerRoot` in `work.config.json`, a `--run` the
// caller forgot to pass, or a future change to the interpolation is each one edit away from producing
// `/briefs/` or worse. This floor is not defending against today's code — it makes the worst outcome in
// this file unreachable regardless of what upstream does.
//
// The bracket escape is also NOT self-sufficient at these sizes, which is the second reason for a length
// floor: `bracketEscapePattern("a")` is `[a]`, and the string `[a]` CONTAINS `a`, so the probe
// self-matches again. The escape only holds once the pattern is longer than its own bracketed form — a
// `/briefs/<id>` path always is.
export const KILL_PATTERN_MIN_LENGTH = 12;
const KILL_PATTERN_REQUIRED_SEGMENT = "/briefs/";

export function assertKillPattern(pattern) {
  const p = String(pattern ?? "");
  const why = (reason) =>
    new Error(
      `refusing to build a process-kill on an unsafe pattern (${reason}): ${JSON.stringify(p)}. ` +
        "This value is passed straight to `pkill -f` on a remote host, where an empty or degenerate " +
        `pattern matches EVERY process. A lead-kill pattern must contain "${KILL_PATTERN_REQUIRED_SEGMENT}" ` +
        `and be at least ${KILL_PATTERN_MIN_LENGTH} characters. Fix the caller (an empty ledgerRoot, run ` +
        "id, or issue id upstream) — never widen this check.",
    );
  if (!p.trim()) throw why("empty");
  if (p.length < KILL_PATTERN_MIN_LENGTH) throw why(`shorter than the ${KILL_PATTERN_MIN_LENGTH}-character floor`);
  if (!p.includes(KILL_PATTERN_REQUIRED_SEGMENT)) throw why(`missing the "${KILL_PATTERN_REQUIRED_SEGMENT}" segment`);
  // A newline would read as a separate line of the composed shell command should this value ever reach an
  // unquoted context; a NUL cannot survive argv at all. Neither appears in a legitimate brief path, so
  // both are caller bugs rather than inputs to sanitize.
  if (/[\0\n\r]/.test(p)) throw why("contains a newline or NUL");
  return p;
}

// The ONE place a lead's brief-path kill/probe pattern is built. Four call sites in two shapes used to
// interpolate it by hand, which is exactly how a component goes empty with nothing noticing. Validating
// at CONSTRUCTION means the unsafe value never exists, rather than being caught just before the shell.
export function leadBriefPattern({ runDir, issueId } = {}) {
  const dir = String(runDir ?? "").trim().replace(/\/+$/, "");
  const id = String(issueId ?? "").trim();
  if (!dir) throw new Error("leadBriefPattern: empty run dir — refusing to build a kill pattern (see assertKillPattern)");
  if (!id) throw new Error("leadBriefPattern: empty issue id — refusing to build a kill pattern (see assertKillPattern)");
  if (/\s/.test(id)) throw new Error(`leadBriefPattern: issue id ${JSON.stringify(id)} contains whitespace — that is not an issue id`);
  // The length floor cannot catch a MISSING component that is long enough to look fine: a host config
  // with no `ledgerRoot` interpolates to the literal "undefined", and `undefined/r1/briefs/DER-1` clears
  // every check above while matching no process at all — a kill that reports a clean receipt for a lead
  // it never touched. Only a stringified missing value produces these segments; no real path has one.
  //
  // Tested against the ASSEMBLED pattern, not against `dir` alone. `issueId` reaches the same shell by the
  // same route and fails the same way — `/root/r1/briefs/undefined` clears the floor, carries `/briefs/`,
  // matches nothing, and reports the same false clean kill — and it is the likelier of the two to go
  // missing, since an issue id is per-call while `ledgerRoot` is configured once. Checking one component
  // and not its sibling is how this class survives a fix.
  const pattern = `${dir}${KILL_PATTERN_REQUIRED_SEGMENT}${id}`;
  if (/(^|\/)(undefined|null)(\/|$)/.test(pattern)) {
    throw new Error(
      `leadBriefPattern: ${JSON.stringify(pattern)} contains an "undefined"/"null" path segment — a missing ` +
        "config value (a host's `ledgerRoot`, an absent --run, or an unresolved issue id) was stringified " +
        "into it. The resulting pattern would match nothing and report a CLEAN kill for a lead it never touched.",
    );
  }
  return assertKillPattern(pattern);
}

// The presence half on its own. `lead-context`'s liveness probe is exactly this minus the kill, and it
// used to hand-roll the identical string — sharing it means the two cannot drift into escaping
// differently, and it gives the live pgrep test a production binding for the probe-only case.
export function presenceProbeCommand(pattern) {
  return `pgrep -f ${shellQuote(bracketEscapePattern(assertKillPattern(pattern)))} >/dev/null 2>&1; echo RC=$?`;
}

// One ssh round trip: kill, settle, then ASK whether it is still there. `echo RC=$?` is what makes the
// answer readable — `pgrep` alone would only set an exit status that the trailing `echo` overwrites.
export function remoteKillProbeCommand(pattern) {
  const p = shellQuote(bracketEscapePattern(assertKillPattern(pattern)));
  return `pkill -f ${p} >/dev/null 2>&1; sleep 1; ${presenceProbeCommand(pattern)}`;
}

// The verdict, from the composite output of the chain above. Deliberately three-valued and fail-closed:
// only a shell that ran AND answered `RC=1` (pgrep matched nothing) proves the process is gone. ssh
// transport failure, a killed shell, a truncated read, or any other pgrep exit is `unknown` — which is
// never treated as success anywhere, because "I could not look" and "it is dead" are different facts.
export function classifyKillProbe({ exitCode, stdout } = {}) {
  if (Number(exitCode) !== 0) return "unknown"; // ssh/transport failed — NOT evidence of death
  // Take the LAST marker: a login shell can print a banner, and the chain's own echo is always last.
  const all = String(stdout ?? "").match(/RC=(\d+)/g);
  if (!all || all.length === 0) return "unknown";
  const rc = all[all.length - 1].slice(3);
  if (rc === "0") return "survivor"; // pgrep FOUND it — the kill did not take
  if (rc === "1") return "killed"; // pgrep matched nothing — proven gone
  return "unknown"; // pgrep usage/permission error
}

export const KILL_PROBE_NOTES = {
  survivor: "the process is STILL RUNNING after the kill (pgrep still matches its brief path)",
  unknown: "the kill could NOT be verified (the probe never returned a verdict — ssh, the remote shell, or pgrep itself failed)",
};

// The teardown step record for a kill-probe result. `exit_code` stays TRUTHFUL (a survivor is found by a
// chain that exits 0); the verdict rides in `probe`, which reapCleanupOutcome reads as its own failure
// condition. Encoding a survivor as a fake nonzero exit would have been a second instrument that lies.
export function killProbeStep(step, res, { optional = false } = {}) {
  const probe = classifyKillProbe(res ?? {});
  return {
    step, optional, probe,
    exit_code: Number(res?.exitCode) || 0,
    ...(res?.stderr ? { stderr: res.stderr } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reap preconditions (DER-2775)
// ---------------------------------------------------------------------------
//
// `reap` is the run's DESTRUCTIVE primitive — it kills the lead and `git worktree remove --force`s the
// tree, so anything uncommitted in it is gone. It had no preconditions at all:
//
//   * `state.issues[id] ?? {}` meant an id that is not a unit of this run (a typo, an id from another
//     run, a stale copy-paste) still appended a TERMINAL `reaped` for a PHANTOM unit — and `reaped` is
//     deduped first-wins, so that phantom is permanent. (The teardown itself was a no-op for a phantom:
//     no host ⇒ no pkill, no worktree ⇒ no removal. The harm is the ledger entry, so the fix is the
//     REFUSAL, not more teardown.)
//   * a unit still `in_progress`/`pr_open`/`kickback` was torn down exactly like a merged one, with a
//     `cleanup_ok: true` receipt. That is a live lead's uncommitted work destroyed on a clean receipt.
//
// The gate is deliberately NOT "prove the PR merged at the expected SHA": reap has legitimate uses with
// no PR at all (an abandoned unit, a dead lead that never opened one, a canceled issue), and a live-gh
// precondition would make a run unable to end when gh is down. The rule is: a unit that is NOT active can
// be reaped freely; an ACTIVE one needs the operator to say the destructive word.
export const REAP_TERMINAL_ELIGIBLE = (status) => !ACTIVE_STATUSES.has(status);

// 4.3 — a QUEUED, never-dispatched id is a real tracked unit, and `reap` must accept it.
//
// THE DEADLOCK, verified against current code before implementing:
//   * `complete-run` builds `trackedIds` as `Object.keys(issues) ∪ queue`, and counts a never-dispatched
//     id as non-terminal (`issues[id]?.status ?? "queued"`). Its own remedy text says
//     "reap --run <r> <id> closes a queued/merged unit".
//   * `reap` refuses exactly those ids — `state.issues` entries are only created by `ensure(id)` when an
//     event NAMES the id, so a declared-but-never-dispatched id has no entry, `unit` is undefined, and
//     the `!unit` branch returns before `abandon` is even consulted.
//   * There is deliberately no `--force`.
// So a non-empty `state.queue` at run end is an UNCONDITIONAL deadlock in issue-list mode: the harness
// prescribes the one command that refuses. Run `20260730T233426Z-der-2869-der-2864` cannot be closed.
//
// The root divergence is `run_started.issues` (everything declared) vs `state.issues` (only ever
// dispatched). This is a RECONCILIATION bug, not a reason for `--force`: both refusals were RIGHT.
// `reap`'s point is that a phantom terminal event is permanent in an append-only ledger — and a queued
// id is not a phantom, it is a unit the run declared and never started.
//
// So: tear nothing down (there is nothing to tear down), and append `reaped` with `never_started: true`.
// That keeps "every tracked unit reached a terminal state" TRUE *and* records how it got there, which a
// bare `reaped` would not. And it does NOT weaken the phantom guard — an id that is neither a known unit
// nor in the declared queue is still refused.
export function reapRefusal({ issueId, runId, unit, abandon = false, queued = false } = {}) {
  if (!issueId) return "reap needs an issue id: reap --run <r> <DER-id>";
  if (!unit) {
    if (queued) return null; // declared, never dispatched — terminal-eligible, nothing to destroy
    return `reap: ${issueId} is not a unit in run ${runId ?? "<none>"} — refusing. Nothing is torn down (an ` +
      "unknown id owns no worktree and no host), but the reap would append a TERMINAL `reaped` for a " +
      "unit that does not exist, and `reaped` is deduped first-wins so the phantom is permanent. Check " +
      "the id against `state --run <r>`; --abandon does NOT override this.";
  }
  if (REAP_TERMINAL_ELIGIBLE(unit.status)) return null;
  if (abandon) return null;
  const remote = unit.host && unit.host !== "local" ? unit.host : null;
  const destroys = [
    unit.worktree
      ? `its worktree ${unit.worktree}${remote ? ` on ${remote}` : ""} — \`git worktree remove --force\`, so ANY UNCOMMITTED WORK IN IT IS DESTROYED`
      : null,
    remote ? `the lead process on ${remote} (pkill by brief path)` : null,
    unit.workspace_ref ? `every CMUX workspace the issue ever had` : null,
  ].filter(Boolean);
  return `reap: ${issueId} is still ACTIVE (status \`${unit.status}\`${unit.pr != null ? `, PR #${unit.pr}` : ", no PR"}) — refusing. ` +
    `This reap would destroy:\n  - ${destroys.length ? destroys.join("\n  - ") : "(nothing recorded — but the terminal `reaped` would still land)"}\n` +
    "Reap AFTER the work lands: re-check `gh pr view` and let the `pr_merged` fold run first. If you " +
    "really mean to throw this unit's work away (abandoned unit, dead lead with no PR, canceled issue), " +
    "say so explicitly: re-run with --abandon, which records `abandoned: true` on the `reaped` event so " +
    "an audit can tell deliberate destruction from post-merge cleanup.";
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function resolveCommand(name, explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  return name; // rely on PATH
}

function runCommand({ command, args, cwd, env = process.env, timeoutMs = 120000 }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

export function parseWorkspaceRef(stdout) {
  return String(stdout || "").match(/\bworkspace:\d+\b/)?.[0] ?? null;
}

// DER-2739 — what can a launch actually be PROVEN by?
//
// Two facts, and both are required:
//   exitCode  `runCommand` NEVER throws. A missing/erroring binary resolves as `{exitCode:127}` and a
//             nonzero close resolves as the code, so the exit status is the only place a failed launcher
//             surfaces at all. All four spawn paths used to ignore it entirely.
//   ref       cmux prints `workspace:<n>` on success and `parseWorkspaceRef` returns null on anything
//             else, so `exit 0` with a usage message, a partial start, or an empty pipe proves nothing.
//             A null ref is not a workspace; it is the absence of one.
//
// Pure and exported so the proof lives in a unit test rather than in a live spawn.
export function spawnOutcome({ exitCode, stdout = "", stderr = "" } = {}) {
  const ref = parseWorkspaceRef(stdout);
  const said = String(stderr || "").trim() || String(stdout || "").trim();
  const note = said ? said.split("\n").slice(-3).join(" ").slice(0, 400) : null;
  if (exitCode !== 0) {
    return { ok: false, ref: null, exit_code: exitCode ?? null, reason: `the launcher exited ${exitCode}`, note };
  }
  if (!ref) {
    return { ok: false, ref: null, exit_code: 0, reason: "the launcher exited 0 but printed no workspace:<n> ref", note };
  }
  return { ok: true, ref, exit_code: 0, reason: null, note: null };
}

// One failure type per role, mirroring the `*_spawned` siblings so a reader of either the ledger or state
// never has to ask which role a failure belongs to. All three are in ACTIONABLE_EVENT_TYPES: a dispatch
// that failed is precisely the kind of thing a `--wake-on actionable` loop must hear about, and the
// 2026-07-16 incident (7 kickbacks rotting 40m–1.3h) is what silence here costs.
export const SPAWN_FAILED_TYPES = { lead: "lead_spawn_failed", shepherd: "shepherd_spawn_failed", orch: "orch_spawn_failed" };

// The event a failed launch records. Deliberately NARROW: no `worktree` (DER-2737's forged-payload
// surface, and worktree_created already recorded it), and `workspace_ref` is pinned to null because the
// whole point is that no workspace exists. `retryable:true` says the run is not wedged — re-running the
// same command is the recovery, since nothing was created and nothing was cleaned up.
export function spawnFailedEvent({ role = "lead", issue = null, host = null, kickback = 0, rotation = null, leadType = null, outcome = {} } = {}) {
  const ev = {
    actor: "orch",
    type: SPAWN_FAILED_TYPES[role] ?? SPAWN_FAILED_TYPES.lead,
    role,
    exit_code: outcome.exit_code ?? null,
    reason: outcome.reason ?? "the launch could not be proven",
    workspace_ref: null,
    retryable: true,
  };
  if (issue) ev.issue = issue;
  if (host) ev.host = host;
  if (kickback) ev.kickback = kickback;
  if (rotation) ev.rotation = rotation;
  if (leadType && leadType !== "claude") ev.leadType = leadType;
  if (outcome.note) ev.note = outcome.note;
  return ev;
}

// Record the failure, THEN refuse. Order matters: the throw only reaches whoever typed the command, while
// the ledger is what the next wake — and a successor orchestrator that never saw this stderr — reads.
// The `record the gap` precedent is DER-2745's telemetry_gap: an instrument that cannot measure says so
// in the ledger instead of exiting quietly.
// `launcher` names the thing that failed, and `retry` says what re-running costs. Both used to be
// hardcoded to cmux, which was true while cmux was the only launcher; the cloud path (2026-08-18) spawns
// through `claude --cloud`, where "check cmux on the target host" is advice that cannot help and the
// retry advice is DIFFERENT in kind — a cloud retry can create a SECOND session on one branch, so the
// caller supplies the retry line rather than inheriting cmux's.
async function refuseUnprovenSpawn({ runDir, role, label, outcome, launcher = "cmux", retry = null, ...rest }) {
  const ev = spawnFailedEvent({ role, outcome, ...rest });
  if (runDir) await appendEvent(runDir, ev);
  throw new Error(
    `${label}: the ${launcher} launch did not succeed — ${outcome.reason}.\n` +
      `  NO ${role}_spawned was recorded; a ${ev.type} was. So state shows this as un-dispatched rather\n` +
      "  than in flight, any pending kickback stays pending, and a lead_process_dead claim is not cleared.\n" +
      (outcome.note ? `  the launcher said: ${outcome.note}\n` : "") +
      (retry ??
        "  Retry the same command: nothing was created and nothing was cleaned up (the worktree stays\n" +
        "  registered — create-worktree RESUMES it, DER-2742). If it keeps failing, the launcher is the\n" +
        "  problem, not the ledger — check `cmux` on the target host."),
  );
}

// ---------------------------------------------------------------------------
// Cloud lead dispatch — `claude --cloud`, not RemoteTrigger routines (2026-08-18)
// ---------------------------------------------------------------------------
// Every constraint below was MEASURED on the 2026-08-15/08-17 probes (sessions 0171ZeVU…, 017Lwc7y…,
// and the 08-17 P1/P4 pair); none of it is inferred from the flag's help text:
//
//   pty            `claude --cloud` refuses `-p`/`--bg` and demands a TTY, so it is wrapped in
//                  `script -q <log>`. BSD `script` calls tcgetattr on ITS OWN STDIN: a socket (what a
//                  harness Bash tool hands it) makes it exit 1 with an EMPTY log, so stdin must be
//                  /dev/null or a tty. `runCommand`'s stdio[0]="ignore" IS /dev/null — do not "improve"
//                  it to "pipe". It propagates the child's exit code (verified: child 7 ⇒ script 7).
//   receipt        it prints `Created cloud session: … session_<id>` and exits 0 immediately
//                  (fire-and-forget). That id is the ONLY dispatch receipt; a synthesized one is the
//                  failure mode this harness has paid for repeatedly, so an absent id records
//                  lead_spawn_failed instead.
//   branch         the session clones THE CWD'S CHECKED-OUT REF and there is no branch-selection flag,
//                  so the spawn must run in the issue's worktree AND that ref must be on origin at the
//                  same sha — a local-only commit dies at provisioning (`error_during_execution`, 0
//                  turns), and a remote ref BEHIND local HEAD silently drops the local commits. This is
//                  about the CLONE SOURCE, not about where the lead works: the session is bound by its own
//                  system prompt to a `claude/…` branch and will refuse to move off it (DER-4036), so the
//                  worktree chooses the lead's STARTING COMMIT and nothing else.
//   env            `--environment` accepts only `ccpool_…` self-hosted ids, so a CLI session runs the
//                  ACCOUNT'S default cloud environment, selected per-profile by CLAUDE_CONFIG_DIR. That
//                  is why hosts.<name>.credProfile is mandatory here and why the codex-provisioned env
//                  is bound to an account rather than passed per spawn.
//   profile        a cred profile that has never been through first-run onboarding HANGS on the theme
//                  picker under the pty (stdin is /dev/null, nothing can answer). That is the one hang
//                  this command diagnoses by name rather than reporting as a bare "no session id".
export const CLOUD_SESSION_RE = /session_[A-Za-z0-9]+/;

// The pty log arrives with \r line endings and a leading ^D; the id shape is unaffected by both, which is
// why this reads the RAW text rather than trying to normalize a terminal capture into lines.
export function parseCloudSessionId(text) {
  return String(text ?? "").match(CLOUD_SESSION_RE)?.[0] ?? null;
}

// Lane alias → the model id the cloud path is PROVEN to honor (P4, 2026-08-17: `--model claude-opus-5`
// and `--model claude-sonnet-5` both echoed back on the session's own `init` event). An explicit full id
// passes through untouched, so this map never blocks a newer model — it only spares every caller from
// guessing whether the `opus`/`sonnet` aliases resolve on this path. THE IDS DRIFT: this map is the one
// place to update them (the claude-api skill carries the current list).
export const CLOUD_LANE_MODELS = { opus: "claude-opus-5", sonnet: "claude-sonnet-5" };
export function cloudLeadModel(model) {
  return CLOUD_LANE_MODELS[String(model ?? "")] ?? model ?? null;
}

// Pure command builder. `line` is derived from the SAME args array the spawn runs, so the operator-facing
// preview cannot drift from what executes — the one thing a builder-plus-printer pair gets wrong.
// CLAUDE_CONFIG_DIR rides the child env (not the arg list) because it selects the ACCOUNT, and an account
// selected by a string the shell might re-split is not a selection at all.
export function cloudSpawnCommand({ credProfile, model, prompt, logPath, claudeBin = "claude" } = {}) {
  if (!credProfile) throw new Error("cloudSpawnCommand: credProfile is required — the cred profile IS the account, and the account IS the cloud environment");
  if (!logPath) throw new Error("cloudSpawnCommand: logPath is required — the pty log is where the session-id receipt lands");
  if (!prompt) throw new Error("cloudSpawnCommand: prompt is required — a cloud lead's brief is its only instruction");
  const args = ["-q", logPath, "env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "-u", "ANTHROPIC_BASE_URL", claudeBin];
  if (model) args.push("--model", model);
  args.push("--cloud", prompt);
  return {
    command: "script",
    args,
    env: { CLAUDE_CONFIG_DIR: credProfile },
    line: `CLAUDE_CONFIG_DIR=${shellQuote(credProfile)} script ${args.map(shellQuote).join(" ")}`,
  };
}

// Two facts, same shape as spawnOutcome (DER-2739), with one deliberate asymmetry:
//
// A session id present with a NONZERO exit is treated as a SUCCESSFUL dispatch, not a failure. The id is
// printed by the server's create response, so the session EXISTS; recording that as failed would invite a
// retry, and a retry means two leads on one branch — the failure mode that corrupts a branch. The
// nonzero exit is carried as a note instead, so it is visible without being acted on as "nothing landed".
export function cloudSpawnOutcome({ exitCode, stdout = "", stderr = "", log = "" } = {}) {
  const sessionId = parseCloudSessionId(log) ?? parseCloudSessionId(stdout) ?? parseCloudSessionId(stderr);
  const said = [log, stderr, stdout].map((s) => String(s || "").replace(/\r/g, "").trim()).find(Boolean);
  const note = said ? said.split("\n").slice(-3).join(" ").slice(0, 400) : null;
  if (sessionId) {
    return {
      ok: true, session_id: sessionId, exit_code: exitCode ?? null, reason: null,
      note: exitCode === 0 ? null : `the launcher exited ${exitCode} AFTER printing ${sessionId} — the session EXISTS; do NOT retry (that would put a second lead on one branch)`,
    };
  }
  if (exitCode !== 0) {
    return { ok: false, session_id: null, exit_code: exitCode ?? null, reason: `the launcher exited ${exitCode} and printed no session_<id>`, note };
  }
  return { ok: false, session_id: null, exit_code: 0, reason: "the launcher exited 0 but printed no session_<id> — no session was created", note };
}

// Why a timeout is its own diagnosis: the measured cause is a cred profile that has never completed
// first-run onboarding. `claude --cloud` then blocks on the theme picker behind the pty forever, and the
// symptom (no output, no id, killed at the timeout) is byte-identical to a quota wall or a network stall.
// Naming the likeliest cause with its one-time fix is the difference between a 2-minute repair and the
// 40-minute misdiagnosis the same shape caused on the codex shim.
export function cloudSpawnTimeoutNote(credProfile) {
  return `the launcher produced no session id before the timeout. The measured cause is a cred profile that has never been first-run-initialized: \`claude --cloud\` then waits on the onboarding THEME PICKER behind the pty, where stdin is /dev/null and nothing can answer it. Initialize it interactively ONCE — \`CLAUDE_CONFIG_DIR=${credProfile ?? "<profile>"} claude\`, answer the prompts, quit — then re-run this spawn. (Setting .theme in that profile's .claude.json is NOT enough: a version bump re-onboards.)`;
}

// The branch precondition, as a PURE verdict over three facts, so the proof lives in a unit test instead
// of in a live spawn. Deliberately stricter than "the branch exists on origin": the cloud session resolves
// the ref REMOTELY, so a remote tip that differs from local HEAD means the lead starts from code the
// orchestrator never intended — silently, with a green spawn. Both halves return the exact repair.
export function cloudBranchRefusal({ branch, checkedOut, localSha, remoteSha, worktree } = {}) {
  if (!branch) return "spawn-cloud: no branch — a cloud session clones the ref checked out in the worktree, so the branch must be known before the spawn";
  if (!localSha) return `spawn-cloud: could not read HEAD in ${worktree ?? "the worktree"} — the spawn's source ref is unreadable, so nothing about what the lead would clone can be proven`;
  // The CHECKED-OUT ref is what the session clones, so a worktree sitting on another branch (or detached,
  // where rev-parse --abbrev-ref prints "HEAD") sends the lead to start from code nobody chose — with a
  // green spawn and a plausible session id. The branch NAME is not what selects the source; this is.
  if (checkedOut && checkedOut !== branch) {
    return `spawn-cloud: ${worktree ?? "the worktree"} has ${checkedOut === "HEAD" ? "a DETACHED HEAD" : `\`${checkedOut}\``} checked out, not \`${branch}\`. A cloud session clones the CHECKED-OUT ref (no branch-selection flag exists), so this spawn would hand the lead the wrong starting point and still return a session id. Check the branch out first: git -C ${worktree ?? "<worktree>"} checkout ${branch}`;
  }
  if (!remoteSha) {
    return `spawn-cloud: branch ${branch} is NOT on origin. A cloud session resolves the ref remotely, so this spawn would die at provisioning with 0 turns (error_during_execution) — which reads as a lead that failed to start, not as a missing branch. Push it first: git -C ${worktree ?? "<worktree>"} push -u origin ${branch} (or re-run with --push).`;
  }
  if (remoteSha !== localSha) {
    return `spawn-cloud: origin/${branch} is at ${remoteSha.slice(0, 9)} but the worktree HEAD is ${localSha.slice(0, 9)}. The cloud session would clone origin's tip, so every local commit ahead of it is silently DROPPED from the lead's checkout. Push first: git -C ${worktree ?? "<worktree>"} push origin ${branch} (or re-run with --push).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Steering a live cloud lead (2026-08-18) — how a cloud kickback is DELIVERED
// ---------------------------------------------------------------------------
// `claude -p "<msg>" --cloud <session_id>` is the one headless channel into a running cloud session:
// accepted with no pty (unlike CREATE), it prints "Sent to cloud session" and returns. The message QUEUES
// if a turn is in flight and is consumed at the turn boundary — which is precisely why the ack below
// exists: "queued" and "swallowed" are indistinguishable from the sending side.
export function cloudSteerCommand({ credProfile, sessionId, prompt, claudeBin = "claude" } = {}) {
  if (!credProfile) throw new Error("cloudSteerCommand: credProfile is required — a steer must ride the account that owns the session");
  if (!sessionId) throw new Error("cloudSteerCommand: sessionId is required");
  if (!prompt) throw new Error("cloudSteerCommand: prompt is required");
  const args = ["-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "-u", "ANTHROPIC_BASE_URL", claudeBin, "-p", prompt, "--cloud", sessionId];
  return {
    command: "env",
    args,
    env: { CLAUDE_CONFIG_DIR: credProfile },
    line: `CLAUDE_CONFIG_DIR=${shellQuote(credProfile)} env ${args.map(shellQuote).join(" ")} < /dev/null`,
  };
}

// The demanded acknowledgement. It deliberately reuses `kickback_ack` — a type the cloud-reportable
// allowlist ALREADY accepts and the fold already treats as proof of life — rather than inventing a token
// the orchestrator would have to grep for. The round makes it unique per round, so a round-2 ack can never
// be satisfied by round-1's comment, and the receipt lands in the ledger instead of in a comment nobody
// re-reads. A steer QUEUES behind the in-flight turn, so "sent" and "read" are different claims: this is
// the only thing that distinguishes them from outside the session.
export function cloudSteerAckInstruction({ repo = null, pr = null, issueId = null, round = 1 } = {}) {
  const ids = JSON.stringify([issueId ?? "<id>"]);
  const prRef = pr != null ? String(pr) : "<PR>";
  return [
    `**Acknowledge this message BEFORE you start fixing.** A steer queues behind your in-flight turn, so from outside the session "delivered" and "lost" look identical — this ack is the only thing that separates them, and the orchestrator treats a missing one as an undelivered round:`,
    ``,
    `\`gh api repos/${repo ?? "<owner>/<repo>"}/issues/${prRef}/comments -f body='WORK-EVENT {"type":"kickback_ack","issues":${ids},"pr":${prRef},"round":${round}}'\``,
    ``,
    `Then fix the findings above, push to the SAME branch, and re-mark the PR \`ready_for_review\` (that draft→ready flip is your re-hand-off). Do NOT open a new PR.`,
  ].join("\n");
}

// A steer is proven by the CLI's own accept line, not by exit 0 — the same "a check that cannot fail is
// not evidence" rule the codex gate is held to. An exit-0 run with no accept line is UNPROVEN delivery.
export function cloudSteerOutcome({ exitCode, stdout = "", stderr = "" } = {}) {
  const text = `${String(stdout || "")}${String(stderr || "")}`.replace(/\r/g, "");
  const accepted = /sent to cloud session/i.test(text);
  const said = text.trim() ? text.trim().split("\n").slice(-3).join(" ").slice(0, 400) : null;
  if (exitCode !== 0) return { ok: false, exit_code: exitCode ?? null, reason: `the steer exited ${exitCode}`, note: said };
  if (!accepted) return { ok: false, exit_code: 0, reason: 'the steer exited 0 but the CLI never printed "Sent to cloud session" — delivery is UNPROVEN (an ended or expired session is the usual cause)', note: said };
  return { ok: true, exit_code: 0, reason: null, note: null };
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function cmuxBin() {
  return resolveCommand("cmux", (process.env.WORK_CMUX_BIN ?? process.env.ROST_WORK_CMUX_BIN));
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function resolveRunsRoot(o) {
  return o.runsRoot ?? join(o.repoRoot ?? process.cwd(), "tmp", "work");
}

// Subcommands that legitimately CREATE a run dir. Everything else addresses an EXISTING run.
const RUN_DIR_CREATORS = new Set(["init-run"]);

// DER-2570 — refuse to bootstrap a phantom ledger for a KNOWN run id.
//
// `resolveRunsRoot` falls back to `process.cwd()`, and `appendEvent` does `mkdir -p` on whatever path
// it is handed. Together that means a single `cd` into the run dir sends every subsequent write to
// `<run-dir>/tmp/work/<run-id>/` — a second, empty ledger for the same run id. The failure is silent
// and every symptom reads healthy: `append` returns ok, `reap` returns reaped, `watch` returns valid
// JSON with an empty pending list, `state` returns a plausible run with no issues. It cost 35 minutes
// of an orchestrator's writes on 2026-07-27 and was caught only by contradiction with a value the
// orchestrator had read itself (`fileScope: []`).
//
// The fix is to make the instrument capable of returning the failing answer: a non-creating subcommand
// that names a run id must find that run ALREADY on disk, with its ledger present. A missing dir is now
// a hard refusal that PRINTS the resolved root, so the next line the operator reads names the cause.
// The discriminator is the run DIRECTORY, not its ledger file: `init-run` mkdir's the run dir, and the
// first `append` legitimately arrives before any `events.jsonl` exists. The phantom path is precisely the
// one where the DIRECTORY did not exist and `appendEvent`'s `mkdir -p` conjured it. `--dry-run` is exempt
// because a preview cannot fork a ledger (dry-run purity is already an invariant here — see DER-2514).
export function assertExistingRunDir(runDir, runsRoot, subcommand, { exists = existsSync, dryRun = false } = {}) {
  if (!runDir || dryRun || RUN_DIR_CREATORS.has(subcommand)) return;
  if (exists(runDir)) return;
  throw new Error(
    `refusing to bootstrap a ledger for run "${runDir.split("/").pop()}": no such run directory.\n` +
      `  resolved runs-root: ${runsRoot}\n` +
      `  This is DER-2570: runs-root falls back to the CURRENT WORKING DIRECTORY, so a \`cd\` (or a\n` +
      `  subshell that changed dirs) silently forks a second ledger for a run that already exists.\n` +
      `  Pass --runs-root <abs path to the runs root> explicitly, and never \`cd\` in a runner call.`,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read a piped payload (review-usage accepts the review JSON on stdin instead of --file).
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf8").trim();
  if (!s) throw new Error("review-usage: nothing on stdin and no --file given");
  return s;
}

// nudge is a monotonic counter file (not a deletable flag) so EVERY blocked `watch` sees the bump,
// not just the first poller (Codex #623). readNudge returns 0 when absent.
async function readNudge(runDir) {
  try {
    return Number.parseInt(await readFile(join(runDir, "nudge"), "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

// Per-host sync cursor: how many lines of a remote host's local events.jsonl have already been merged
// into the canonical ledger. Absent ⇒ 0. Used by pull-host for exactly-once merge.
async function readCursor(runDir, host) {
  try {
    return Number.parseInt(await readFile(join(runDir, `sync-cursor.${host}`), "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

// Merge a remote host's mini-local ledger into the canonical one: ssh-tail from the per-host cursor,
// append the new events (host-tagged), advance the cursor. Exactly-once; shared by the `pull-host`
// subcommand and the folded-in `watch` pull. Real ssh — callers gate it (subcommand invocation / the
// watch --pull-hosts flag), and watch treats a throw as best-effort (the mini is never a hard dep).
// THE remote read command — one builder, because `pull-host --dry-run` prints it and the pull executes
// it, and a separately-written second copy is a preview that can drift from what actually runs.
//
// DER-2839: this used to end in `2>/dev/null || true`. That suffix answers every question with success:
// a MISSING remote ledger, an UNREADABLE one, and a failed read all exited 0 with empty stdout, which is
// byte-for-byte what a healthy remote with nothing new returns. The pull then took the empty-body path
// and called `recordHeldFragment(…, {fragment: null})`, DELETING the held-fragment record — so a read
// that never happened erased the completion-blocking damage signal DER-2776 exists to preserve. That is
// the exact inversion DER-2776 was written to prevent, arriving through the shell instead of the parser.
//
// So: no suppression and no laundering. `tail`'s exit status propagates through ssh, "I could not read
// it" and "it was empty" become different facts — the distinction `classifyKillProbe` already draws for
// the kill probe — and the remote's stderr survives to say WHY.
// The path is SHELL-QUOTED (Codex review of this change, #5). `ssh host <string>` is evaluated by the
// remote shell, and the path is built from `ledgerRoot` (config) and the run id — so an entirely valid
// `ledgerRoot: "/Volumes/Work Ledger"` split into two operands and made every pull fail, and a
// metacharacter in either component was interpreted remotely. Pre-existing on main, but this builder is
// now the only place that constructs it, so it is the only place that has to be right. `cursor` is
// arithmetic on a parsed integer and is not interpolated as text.
function remoteLedgerTailCommand(remotePath, cursor) {
  const path = String(remotePath);
  // A leading `~/` is left OUTSIDE the quotes so the remote shell still expands it (Codex round 2, #1:
  // quoting the whole string turned a `ledgerRoot: "~/work-ledger"` into a literal path and would have
  // failed every pull on such a host). Everything after it is quoted, so the space/metacharacter fix
  // holds. No config in this repo uses a `~` root today — this exists so the tightening cannot silently
  // break one that does.
  const tilde = path.startsWith("~/");
  const quoted = tilde ? `~/${shellQuote(path.slice(2))}` : shellQuote(path);
  return `tail -n +${cursor + 1} ${quoted}`;
}

async function pullHostInto(runDir, hostName, runId) {
  const host = getHosts()[hostName];
  if (!host) throw new Error(`unknown host "${hostName}"`);
  const cursor = await readCursor(runDir, hostName);
  const remotePath = `${host.ledgerRoot}/${runId}/events.jsonl`;
  const res = await runCommand({ command: "ssh", args: [host.ssh, remoteLedgerTailCommand(remotePath, cursor)] });
  // A nonzero exit is now either ssh itself failing OR the remote read failing — and the two are the same
  // fact for this caller: NOTHING WAS READ. Return without touching the cursor OR the held-fragment
  // record. Clearing the latter here would restart a stuck line's age clock on every network flap (and,
  // before this fix, delete it outright on a remote that had simply not been created yet), which is how
  // an age signal becomes a lie. The hold is READ BACK and reported rather than reported as null: this
  // pull learned nothing about it, and "null" here would mean "nothing is held".
  if (res.exitCode !== 0) {
    const held = await readHeldFragmentFor(runDir, hostName);
    const why = String(res.stderr ?? "").trim().split("\n").filter(Boolean).pop() || `exit ${res.exitCode}`;
    return {
      host: hostName, pulled: 0, quarantined: 0, cursor,
      // `unreadable` rides along when the hold exists but could not be vouched for — the same fail-closed
      // shape `readHeldFragments` reports, rather than a `null` that would read as "nothing held".
      held: held
        ? { bytes: held.bytes ?? null, first_seen_at: held.first_seen_at ?? null, ...(held.unreadable ? { unreadable: true, stale: true } : {}) }
        : null,
      pull_failed: true, pull_error: why,
    };
  }
  const body = String(res.stdout ?? "");
  // DER-2776 — two arithmetic facts this line used to get wrong, both of which lose events:
  //
  //   1. `tail -n +N` numbers EVERY line, blank ones included; the old `.filter(l => l.trim())` then
  //      advanced the cursor by the count of NON-BLANK lines. One blank line in a remote ledger and the
  //      cursor lags by one FOREVER — every subsequent pull re-reads a line it already merged.
  //   2. The last line of the body is only a LINE if it ended in "\n". `tail` of a file being appended to
  //      routinely returns a final fragment; counting it advanced the cursor past a line that was never
  //      folded, so the completed record could never be re-read. That is permanent event loss (a
  //      `pr_opened` observed missing from a canonical ledger), and it arrived dressed as PERMANENT
  //      damage (`remote_malformed_json`), latching the run-wide "every number is a LOWER BOUND" banner
  //      on what is a routine mid-append race.
  //
  // So: split on "\n", take everything before the final element as the terminated lines (`"a\nb\n"` and
  // `"a\nb"` both leave exactly the complete lines there, and `""` leaves none), and advance the cursor by
  // THAT count. The fragment is held — re-read next cycle, when it will either be complete or still torn.
  const parts = body.split("\n");
  const terminated = body === "" || body.endsWith("\n");
  const lines = parts.slice(0, -1);
  const fragment = terminated ? null : parts[parts.length - 1];
  const nextCursor = cursor + lines.length;
  // DER-2738: one torn line in the mini's tail used to throw the whole pull (and the watch cycle that
  // called it). Dropped lines are quarantined with their raw bytes so a lost remote event is VISIBLE —
  // for a MALFORMED COMPLETE record the cursor still advances past it, so an invisible drop would be
  // permanent. The held fragment is the opposite case: it is recorded as `torn_tail` (transient) and the
  // cursor stays behind it, so it is not a drop at all.
  const damage = [];
  const events = mergeRemoteEvents({ remoteLines: parts, host: hostName, damage, terminated });
  for (const e of events) await appendEvent(runDir, e);
  // Unconditional: this is the pull's health record, and "no damage this time" is exactly the answer that
  // has to overwrite a previous pull's torn_tail — otherwise a tear that HAS healed keeps reading red.
  await recordLedgerDamage(join(runDir, "events.jsonl"), damage, { pulled_from: hostName, remote_cursor: cursor });
  const held = await recordHeldFragment(runDir, hostName, { fragment, cursor: nextCursor });
  await writeFile(join(runDir, `sync-cursor.${hostName}`), String(nextCursor), "utf8");
  return {
    host: hostName, pulled: events.length, quarantined: damage.length, cursor: nextCursor,
    held: held ? { bytes: held.bytes, first_seen_at: held.first_seen_at } : null,
  };
}

// Reconcile the ledger against `gh` truth (B3): list merged PRs, append a `pr_merged` for any in-flight
// issue whose PR merged out-of-band (merge-queue / manual) with no shepherd event. Best-effort — a gh
// failure (no auth / offline) returns 0, never throws the watch loop. cwd=repoRoot so gh finds the repo.
async function reconcileMergedInto(runDir, runId, repoRoot) {
  const res = await runCommand({ command: "gh", args: ["pr", "list", "--state", "merged", "--json", "number", "--limit", "100"], cwd: repoRoot });
  if (res.exitCode !== 0) return { reconciled: 0 };
  let merged;
  try {
    merged = JSON.parse(res.stdout || "[]").map((p) => p.number);
  } catch {
    return { reconciled: 0 };
  }
  const state = materializeState(await readEvents(runDir), { run_id: runId });
  const events = mergedReconcileEvents({ issues: state.issues, mergedPrNumbers: merged });
  for (const e of events) await appendEvent(runDir, e);
  return { reconciled: events.length };
}

// Cloud-lead ledger fold (DER-1834). A cloud lead has no ledger file — it reports by posting a PR
// comment whose body starts with `WORK-EVENT ` + compact JSON (pr_opened/handed_off/..., incl.
// its session_id). Pure: extract those events from an array of comment objects/strings, keeping only
// events for this run's issues (when `runIssues` given), tagging host:"cloud" + a lead actor if the
// lead omitted them. Only the FIRST line after the token is parsed, so a multi-line comment is fine.
// ---------------------------------------------------------------------------
// Untrusted-input boundary: PR comments (DER-2737)
// ---------------------------------------------------------------------------
// Everything below exists because `parsePrEventComments` and `fetchHandoffNote` read PR comment bodies
// as privileged lifecycle input with no author check — `c.author.login` is in the gh payload and was
// never consulted — while `reconcilePrEventsInto` discovers comments via `gh pr list --state open
// --limit 100`, i.e. ANY open PR in the repo, on a `watch` loop that re-folds every ~45s with no
// operator present. The harness already knew the rule ("never let untrusted text reach a shell",
// DER-2456 #5); this is the inbound version, and the author-filter technique was already in-file in
// `ready` and simply never applied to the two ingestion paths.

// Bots whose comments the harness already treats as authoritative (`ready` filters the Codex review
// surfaces on this exact login).
const TRUSTED_COMMENT_BOTS = ["chatgpt-codex-connector[bot]"];
let TRUSTED_COMMENT_AUTHORS_EXTRA = [];
let TRUSTED_PR_AUTHORS_EXTRA = [];

// The logins whose PR comments may become ledger events. Config-driven because the harness ships
// without naming anyone's account — and therefore DENY-BY-DEFAULT: an unconfigured repo trusts no human
// login at all. That is not a degraded mode. A repo that never declared an owner has no way to
// authenticate a comment, so folding one would be a guess; and the cloud lane this protects already
// requires `repo.repoSlug` + `repo.ownerLogin` to function, so it cannot be running unconfigured.
export function getTrustedCommentAuthors() {
  const set = new Set(TRUSTED_COMMENT_BOTS);
  if (REPO_IDENTITY.ownerLogin) set.add(REPO_IDENTITY.ownerLogin);
  for (const a of TRUSTED_COMMENT_AUTHORS_EXTRA) set.add(a);
  return set;
}

// ---------------------------------------------------------------------------
// Untrusted-input boundary: PR *state* (DER-2778) — a SECOND, DELIBERATELY DIFFERENT list
// ---------------------------------------------------------------------------
// DO NOT UNIFY THESE TWO SETS. They answer different questions, and the comment set is the wrong
// answer to this one:
//   getTrustedCommentAuthors() — "may THIS LOGIN'S COMMENT be read as a report?" It includes
//     TRUSTED_COMMENT_BOTS (`chatgpt-codex-connector[bot]`) because a Codex review comment IS
//     authoritative input the harness already acts on.
//   getTrustedPrAuthors()     — "is a PR OPENED BY this login one of THIS RUN'S cloud leads?" A review
//     bot is not a lead. It opens PRs of its own, and any PR whose branch or title happens to name an
//     in-flight issue id would then derive `lead_online`/`handed_off` for that unit. So the bot list is
//     excluded here: owner + explicitly configured extras only.
// Same DENY-BY-DEFAULT posture as the comment set: an unconfigured repo has no way to authenticate a
// PR, so it trusts none. The cloud lane this protects already requires `repo.repoSlug` +
// `repo.ownerLogin` to function, so it cannot be running unconfigured.
//
// Why this exists: `reconcilePrEventsInto` discovers PRs with `gh pr list --state open --limit 100` —
// ANY open PR in the repo — and `deriveCloudPrEvents` decided relevance from a branch/title SUBSTRING
// alone. On a PUBLIC repo whose PR titles announce issue ids, a fork PR titled with an in-flight id
// derived `lead_online` + `handed_off` on the next ~45s cycle with no operator present: the pointer
// update retargeted the unit's tracked PR, and the hand-off's unfetchable fork SHA made the ancestry
// guard fail OPEN, silently dropping a pending kickback out of `kickbacks_pending`. DER-2737 hardened
// the comment path and its own header names `gh pr list` as the vector; the PR-STATE path was the half
// left behind.
export function getTrustedPrAuthors() {
  const set = new Set();
  if (REPO_IDENTITY.ownerLogin) set.add(REPO_IDENTITY.ownerLogin);
  for (const a of TRUSTED_PR_AUTHORS_EXTRA) set.add(a);
  return set;
}

// The account/org that OWNS the repo being polled — the owner segment of `repo.repoSlug`.
// Deliberately NOT `repo.ownerLogin`, which is a PERSON (the login commits must be authored by). On an
// org-owned repo the two differ, and comparing a head-repository owner against the person would reject
// every same-repo PR — turning the identity gate into a blanket refusal that quietly disables the cloud
// lane. Returns null when unconfigured, which the gate treats as "cannot authenticate" ⇒ deny.
export function getRepoOwnerLogin() {
  const slug = REPO_IDENTITY.repoSlug;
  if (typeof slug !== "string" || !slug) return null;
  const owner = slug.split("/")[0].trim();
  return owner || null;
}

// gh spells these `author.login`, `headRepositoryOwner.login` and `isCrossRepository` on `pr list --json`
// (verified against gh 2.76.2). All THREE are required, and each answers a different question:
//
//   author               — "is this one of ours"
//   headRepositoryOwner  — "is the head repo owned by the org we are polling"
//   isCrossRepository    — "is the head IN that repository, or merely under that owner"
//
// DER-2840: the third is not implied by the second. GitHub lets one owner hold both a repository and a
// fork of it, so `headRepositoryOwner.login === owner` is satisfied by a repository that is NOT the
// target repository — owner equality is a strictly weaker proposition than repository identity, and a
// same-org fork therefore passed the DER-2778 gate and could drive cloud lifecycle derivation. DER-2778
// closed the untrusted-AUTHOR half correctly; this closes the head-REPOSITORY half.
//
// Anything missing (an older payload, a deleted fork, a hand-built test object) carries no identity and
// is not authenticated — so an ABSENT or non-boolean `isCrossRepository` is "I do not know", never
// "same repo". Pure; the module-config fallbacks mirror `toAuthorSet`.
export function prIdentityTrusted(pr, { trustedPrAuthors, repoOwner } = {}) {
  const trusted = trustedPrAuthors instanceof Set ? trustedPrAuthors
    : Array.isArray(trustedPrAuthors) ? new Set(trustedPrAuthors)
      : getTrustedPrAuthors();
  const owner = repoOwner === undefined ? getRepoOwnerLogin() : repoOwner;
  const author = pr?.author?.login;
  const head = pr?.headRepositoryOwner?.login;
  if (typeof author !== "string" || !author || !trusted.has(author)) return false;
  if (typeof owner !== "string" || !owner) return false;
  if (typeof head !== "string" || head !== owner) return false;
  // Strict `=== false`: a missing field is undefined and a stubbed one may be the STRING "false". Both
  // must deny. `!pr?.isCrossRepository` would accept both and reinstate exactly this defect.
  return pr?.isCrossRepository === false;
}

// gh spells the author two ways: `pr view --json comments` gives `author.login`; the REST
// `issues/<n>/comments` surface gives `user.login`. Accept both. Anything else — including a bare
// string body, which is what the unit tests used to pass — carries no authorship and is not input.
export function commentAuthorLogin(comment) {
  if (!comment || typeof comment !== "object") return null;
  const login = comment.author?.login ?? comment.user?.login ?? null;
  return typeof login === "string" && login ? login : null;
}

function toAuthorSet(trustedAuthors) {
  if (trustedAuthors instanceof Set) return trustedAuthors;
  if (Array.isArray(trustedAuthors)) return new Set(trustedAuthors);
  return getTrustedCommentAuthors();
}

// What a cloud lead may report about ITSELF through a PR comment: exactly what the cloud brief instructs
// it to post, and nothing else. A terminal transition like `pr_merged` or `reaped` is the shepherd's to
// record from gh state — a comment claiming one manufactures a merge that never happened.
const COMMENT_EVENT_TYPES = new Set([
  "pr_opened", "lead_online", "plan_scope", "handed_off", "rotate_requested", "kickback_ack", "token_usage",
]);

// Per-type field allowlist. Note what is absent from EVERY type: `worktree` and `branch` (how a forged
// payload reached reap's ssh string, and how it retargeted a live unit) and `actor` (a forged
// `actor:"shepherd"` supplied the disposition that turned a handoff note into an instruction). `host`,
// `actor` and `pr` are stamped by the reader from the PR the comment was posted on. Unknown fields are
// dropped rather than rejected, so a lead emitting a field from a newer brief still hands off.
//
// `ts` is deliberately kept: `eventSeenKey` dedups `token_usage` per EMISSION on `${pr}:${ts}`, and
// dropping it would collapse a rotated cloud lead's second usage report into its predecessor's key and
// silently under-count that unit's spend. It is accepted only from an already-authenticated author.
const COMMENT_FIELDS_COMMON = ["type", "issue", "issues", "ts", "session_id", "sha", "note", "notes"];
const COMMENT_FIELDS_BY_TYPE = {
  pr_opened: [],
  lead_online: ["handle", "draft"],
  plan_scope: ["fileScope", "expectedAdditions", "expectedFiles"],
  handed_off: [],
  rotate_requested: ["disposition", "pct", "rotation"],
  kickback_ack: ["round"],
  token_usage: ["role", "model", "by_model", "tokens", "rotation", "kickback"],
};

// Reduce a parsed comment payload to the fields its type is allowed to carry, stamping the ambient
// facts. Returns null for a type no cloud lead may report. Pure.
export function sanitizeCommentEvent(event, { pr = null } = {}) {
  if (!event || typeof event !== "object" || !COMMENT_EVENT_TYPES.has(event.type)) return null;
  const allowed = new Set([...COMMENT_FIELDS_COMMON, ...(COMMENT_FIELDS_BY_TYPE[event.type] ?? [])]);
  const out = {};
  for (const [k, v] of Object.entries(event)) {
    if (allowed.has(k) && v !== undefined) out[k] = v;
  }
  // A comment IS a cloud lead's only reporting channel, so host is a fact, not a claim. Left as a claim,
  // `host:"mini"` selected a configured ssh host and completed the injection chain into a real shell.
  out.host = "cloud";
  // The PR the comment was posted on is authoritative. The body's `pr` is honoured only when no ambient
  // PR was supplied — the pure-unit-test path; every production caller passes one.
  if (pr != null) out.pr = pr;
  else if (Number.isFinite(event.pr)) out.pr = event.pr;
  return out;
}

export function parsePrEventComments({ comments = [], runIssues = null, pr = null, trustedAuthors } = {}) {
  const trusted = toAuthorSet(trustedAuthors);
  const out = [];
  for (const c of comments) {
    // AUTHORSHIP FIRST — before the marker check, before JSON.parse. An unauthenticated comment is not
    // untrusted input to be sanitized, it is not input at all.
    const login = commentAuthorLogin(c);
    if (!login || !trusted.has(login)) continue;
    const body = typeof c === "string" ? c : c && c.body;
    if (typeof body !== "string") continue;
    // Writers emit EVENT_MARKER; readers accept the legacy marker too. A cloud lead spawned before the
    // rename is still running with the old brief in its context and will keep emitting the old token —
    // dropping those comments would silently lose that lead's entire hand-off. See EVENT_MARKERS.
    const marker = getEventMarkers().find((m) => body.startsWith(m));
    if (!marker) continue;
    const firstLine = body.slice(marker.length).trim().split("\n")[0];
    let raw;
    try { raw = JSON.parse(firstLine); } catch { continue; }
    if (!raw || typeof raw !== "object" || !raw.type) continue;
    const e = sanitizeCommentEvent(raw, { pr });
    if (!e) continue;
    // Run scope in BOTH shapes. The old filter rejected only a non-matching `issues` ARRAY, so a payload
    // carrying a SINGULAR `issue` (and no array) was never filtered at all — that is how a drive-by
    // comment folded a phantom unit, or retargeted a real one, on any run.
    if (runIssues) {
      if (Array.isArray(e.issues) && !e.issues.some((i) => runIssues.includes(i))) continue;
      if (e.issue != null && !runIssues.includes(e.issue)) continue;
    }
    // Normalize `issues:[…]` → the singular `issue` the ledger keys on (2026-07-25). The cloud brief
    // has always asked leads to emit the ARRAY form, but materializeState skips any event without
    // `issue` (`if (!e.issue) continue`) — so every WORK-EVENT comment was parsed, appended, and
    // then silently dropped from state. That is why a cloud lead's `plan_scope` never showed up and
    // cloud units read as plan_scope_missing no matter what they emitted. Found while wiring cloud
    // `rotate_requested`, which would have been dead on arrival for the same reason — and cloud is the
    // DEFAULT host (preferHosts), so this is the common path, not an edge case. Prefer the first id
    // that belongs to this run; the cloud brief puts the PRIMARY id first, which is what keys the unit.
    if (!e.issue && Array.isArray(e.issues) && e.issues.length) {
      e.issue = (runIssues && e.issues.find((i) => runIssues.includes(i))) || e.issues[0];
    }
    // Always stamped, never read from the body: a forged `actor:"shepherd"` on a rotate_requested is what
    // supplied the CONTINUE disposition that turned a planted handoff note into an instruction.
    e.actor = `lead:${e.issue || "cloud"}`;
    out.push(e);
  }
  return out;
}

// Derive cloud-lead events from a PR's STATE (the draft-PR-first lifecycle, DER-1834/DER-1838) — the
// PRIMARY cloud signal, no lead cooperation needed. A cloud lead opens a DRAFT PR at boot: its footer
// carries the `session_01…` teleport/monitor handle, its existence = liveness, and draft→ready = the
// hand-off. Pure: given `{number,isDraft,body,headRefName,title}` + the run's issue ids, emit a
// `lead_online` (with handle + draft flag) and, once it's no longer draft, a `handed_off`. Returns []
// if the PR's identity cannot be authenticated (DER-2778, below) or it isn't part of this run
// (branch/title doesn't name a run issue).
// Kickback flap guard (2026-07-16 run): pass `status` (the issue's folded status) + `kickbackSha` (the
// SHA the shepherd recorded on the latest kickback) + `pr.headRefOid`. While the issue sits in
// `kickback` and the head is STILL at the kickback SHA, a non-draft PR is a phantom ready state — the
// reconcile raced the shepherd's re-draft, or a lead re-marked ready without pushing anything. Deriving
// `handed_off` then poisons the ledger (empties kickbacks_pending, and its `${type}:${pr}` seen-key
// suppresses the REAL re-hand-off later). Suppress it until the head advances.
// IDENTITY BEFORE RELEVANCE (DER-2778): the trusted-PR-author + same-repo-head check runs before the
// branch/title match, so an untrusted PR is never input at all — the same ordering `parsePrEventComments`
// uses for comments ("an unauthenticated comment is not untrusted input to be sanitized, it is not input").
// `trustedPrAuthors`/`repoOwner` default to module config; there is deliberately NO "no filter" escape
// hatch of the kind `runIssues: null` provides, because that would be a bypass rather than a convenience.
export function deriveCloudPrEvents({ pr, runIssues = null, bundles = {}, status = null, kickbackSha = null, trustedPrAuthors, repoOwner } = {}) {
  if (!pr || pr.number == null) return [];
  if (!prIdentityTrusted(pr, { trustedPrAuthors, repoOwner })) return [];
  // Unit ids are matched as WHOLE TOKENS, never as substrings (2026-08-18). `hay.includes("der-403")` is
  // true of a PR titled "DER-4036 …", so a run holding both ids folded DER-4036's lifecycle onto DER-403 —
  // executed, not hypothesised. It was always wrong; the cloud migration made it load-bearing, because a
  // CLI-dispatched cloud lead is system-bound to a `claude/…` branch (DER-4036) and the PR TITLE becomes
  // the only place the id appears. Tokenising on non-alphanumerics keeps the old branch-or-title reach
  // (`derrekwiedeman/der-4036-…` still matches) while making a longer id stop matching a shorter one.
  const hayWords = `${pr.headRefName || ""} ${pr.title || ""}`.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  // Matching is RANKED, not first-hit (DER-4051, 2026-08-18). Two earlier attempts at this — substring, then
  // whole-token with a `<id>-` prefix — each fixed the collision they were shown and left the class open, so
  // the rule is now stated as strengths and ambiguity is REFUSED rather than resolved by ledger order:
  //   2 (exact)  the word IS the id (`DER-4036` in a title), or the id is a `<letters>-<digits>` run inside
  //              it (`<user>/der-4036-slug-words`, Linear's own gitBranchName shape).
  //   1 (branch) the word is exactly `<id>-work` — `create-worktree`'s default branch (10059/10084 derive
  //              `${o.issueId.toLowerCase()}-work`), which is how a SPEC unit like `spec-demo-u1-work` is
  //              reachable at all, since no `<letters>-<digits>` rule can find it.
  // The `-work` anchor replaces the open-ended `startsWith(`${needle}-`)`: that prefix let a run's own
  // `SPEC-DEMO-U1` claim BOTH the prose word `spec-demo-u1-compatibility` in a title about U2 and the
  // unrelated longer unit `spec-demo-u1-followup-u2-work`. `der-403` still cannot claim `der-4036-work`.
  const matchStrength = (id) => {
    const needle = String(id).toLowerCase();
    let best = 0;
    for (const word of hayWords) {
      if (word === needle || (word.match(/[a-z]+-\d+/g) ?? []).includes(needle)) return 2;
      if (word === `${needle}-work`) best = Math.max(best, 1);
    }
    return best;
  };
  let issue;
  // When runIssues is PROVIDED (an array, even empty), the PR MUST name one of them — otherwise it's
  // not part of this run and we emit nothing. Only `null`/undefined means "no filter" (test convenience;
  // the reconcile caller never passes that — it guards on an empty scope).
  if (runIssues != null) {
    if (!Array.isArray(runIssues) || !runIssues.length) return [];
    const scored = runIssues.map((id) => ({ id, strength: matchStrength(id) })).filter((x) => x.strength > 0);
    if (!scored.length) return [];
    const top = Math.max(...scored.map((x) => x.strength));
    const winners = scored.filter((x) => x.strength === top).map((x) => x.id);
    if (winners.length === 1) issue = winners[0];
    else {
      // Several ids match EQUALLY WELL. That is normal for a bundle — one PR titled "DER-1 + DER-2" whose
      // ids are all members of one bundle — and a cross-unit corruption risk for anything else. Resolve
      // only the bundle case, by finding a primary whose list covers every winner. Otherwise emit NOTHING:
      // folding a lifecycle onto the wrong unit is strictly worse than not folding it, and the missing
      // `lead_online` is already caught by the deadline/failed-to-start safety net.
      issue = winners.find((cand) => {
        const grp = Array.isArray(bundles[cand]) ? bundles[cand] : null;
        return grp && winners.every((w) => grp.includes(w));
      });
      if (!issue) return [];
    }
  }
  const m = typeof pr.body === "string" ? pr.body.match(/session_[A-Za-z0-9]+/) : null;
  const handle = m ? m[0] : null;
  const base = { actor: `lead:${issue || "cloud"}`, host: "cloud", pr: pr.number };
  // Bundle-id fidelity (item 2, 2026-07-15 turnover): a bundled lead's derived events must carry the FULL
  // id list the `lead_spawned` event recorded (PR#815's handed_off carried only the primary), so Linear
  // attaches + the shepherd closes every bundled issue. `bundles[primary]` is that list (primary first);
  // absent ⇒ the solo `[issue]`. Also set `bundle` so materializeState folds it onto the primary's unit.
  if (issue) {
    const full = Array.isArray(bundles[issue]) && bundles[issue].length ? bundles[issue] : [issue];
    base.issue = issue;
    base.issues = full;
    if (full.length > 1) base.bundle = full;
  }
  const out = [{ ...base, type: "lead_online", handle, draft: !!pr.isDraft }];
  if (pr.isDraft === false) {
    const flap = status === "kickback" && kickbackSha && pr.headRefOid && pr.headRefOid === kickbackSha;
    if (!flap) {
      const handed = { ...base, type: "handed_off" };
      // Carry the head SHA (2026-07-18) so the fold's sha-aware handed_off flap guard has deterministic
      // head-move evidence for cloud re-hand-offs too — not just the local-lead appends that now include it.
      if (pr.headRefOid) handed.sha = pr.headRefOid;
      out.push(handed);
    }
  }
  return out;
}

// Draft-on-kickback dedup (item 1, 2026-07-15 turnover). reconcile-pr-events dedups derived events by
// `${type}:${pr}` so a 45s re-scan doesn't re-append. But a KICKBACK re-opens a PR's lifecycle: the
// shepherd flips the ready PR back to draft, the re-spawned lead fixes it and marks ready again, and that
// SECOND draft→ready must re-fire `handed_off` (PR#814 went blind because the first handed_off suppressed
// it). So a re-openable event (`lead_online`/`handed_off`) counts as "already seen" ONLY when it appears
// AFTER the latest `kickback` for that PR; anything before a later kickback is stale and no longer
// suppresses a fresh derivation. Terminal/other events (`pr_merged`, `pr_opened`, `reaped`, `fix_pushed`,
// `kickback`) always suppress. Pure — pass the full prior event list; returns the suppression key Set.
const REOPENABLE_DERIVED = new Set(["lead_online", "handed_off"]);

// Dedup identity for folded events (token telemetry, 2026-07-16): `token_usage` is per-EMISSION,
// not per-PR — every session that works a PR (original lead + each kickback fixer) posts its own
// usage comment on the SAME PR, and each must fold. The emitting script stamps a `ts`, which
// becomes part of the key; a ts-less token_usage degrades to per-PR (one ever — safe default).
// Every other type keeps the original `${type}:${pr}` identity.
// Content identity for events that carry NO pr (DER-2519/H1). A WORK-EVENT comment whose parsed
// event lacks `pr` (a cloud lead's `plan_scope`, typically) used to bypass the seen-set entirely —
// `emit` only consulted it `if (e.pr != null)` — so reconcile re-derived the SAME comment every ~63s
// cycle and appended it again, forever. Measured: 129 byte-identical `plan_scope` events, 11.6% of a
// 1,114-event ledger — and worse than noise, the once-a-minute append MANUFACTURED a liveness signal
// for a lead that had been dead for 90 minutes. Key on (type, issue, content-hash), where the hash
// excludes the volatile fields append stamps (`ts`) so a stored copy and a fresh derivation collide.
function contentHash(e) {
  // Excludes EVERY field `appendEvent` stamps (STAMPED_EVENT_FIELDS), not just `ts`. This is the seam
  // DER-2748 could have broken silently: the key is computed on a FRESH derivation (unstamped) and
  // compared against keys built from STORED events (stamped), so if event_id/seq/received_at reached the
  // hash the two could never match, the suppression set would stop suppressing, and DER-2519's measured
  // failure would return — 129 byte-identical plan_scope events, 11.6% of a 1,114-event ledger,
  // manufacturing a liveness signal for a lead that had been dead 90 minutes.
  const entries = Object.entries(e ?? {})
    .filter(([k]) => !STAMPED_FIELD_SET.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const s = JSON.stringify(entries);
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function eventSeenKey(e) {
  if (e && e.type === "token_usage" && e.pr != null && e.ts) return `token_usage:${e.pr}:${e.ts}`;
  if (e && e.pr == null) return `${e?.type}:${e?.issue ?? ""}:#${contentHash(e)}`;
  return `${e?.type}:${e?.pr}`;
}

export function derivedEventSeen(events = []) {
  const lastKickbackIdx = new Map(); // pr -> index of its latest kickback
  events.forEach((e, i) => { if (e && e.type === "kickback" && e.pr != null) lastKickbackIdx.set(e.pr, i); });
  const seen = new Set();
  events.forEach((e, i) => {
    if (!e || !e.type) return;
    if (e.pr == null) {
      // pr-less events dedup purely on content (DER-2519) — reopenability doesn't apply, because a
      // CHANGED derivation (new fileScope, new totals) hashes differently and still folds.
      seen.add(eventSeenKey(e));
      return;
    }
    if (REOPENABLE_DERIVED.has(e.type) && lastKickbackIdx.has(e.pr) && i < lastKickbackIdx.get(e.pr)) return;
    seen.add(eventSeenKey(e));
    // A stored token_usage also claims the bare per-PR key so a ts-less re-parse of the same
    // comment can never re-fold every scan.
    if (e.type === "token_usage") seen.add(`token_usage:${e.pr}`);
  });
  return seen;
}

// Belt-and-braces kickback-fix detection (item 1, 2026-07-15 turnover). The primary re-fire path is
// draft→ready (above), but if the shepherd never toggled the PR to draft, a lead's fix push leaves no
// event. So when a PR sits in `kickback` status and its head SHA has advanced past the SHA the shepherd
// recorded on the kickback event, emit a `fix_pushed` progress marker (once per new SHA — pass the SHAs of
// existing fix_pushed events so a re-scan is idempotent). `fix_pushed` is a progress signal, NOT a hand-off
// (it stays out of ACTIONABLE_EVENT_TYPES) — the actionable re-hand-off is the draft→ready `handed_off`.
// Pure. Requires the shepherd to put `"sha":"<headRefOid>"` on the kickback event (see the shepherd skill).
export function deriveKickbackFixEvents({ issue, pr, status, headSha, kickbackSha, seenShas = [] } = {}) {
  if (status !== "kickback" || pr == null || !headSha || !kickbackSha) return [];
  if (headSha === kickbackSha || seenShas.includes(headSha)) return [];
  const e = { actor: "reconcile", type: "fix_pushed", pr, sha: headSha };
  if (issue) e.issue = issue;
  return [e];
}

// DER-2585 — the 1.5× `plan_scope` DRIFT gate is self-defeating, and this is why.
//
// It compared DELIVERED against DECLARED. But leads re-emit `plan_scope` at hand-off with their final
// numbers, so declared converges on delivered and the ratio is always ~1.0×. The gate could not return
// its failing answer. Measured on run 20260727T004346Z: every unit passed drift, while the median unit
// delivered **4.4×** its ASSIGNED budget (DER-2505: 400 assigned → 4,318 delivered, 10.8×) and 18 of 24
// PRs busted the additions budget. The assigned number is the only one a lead cannot move — it is fixed
// pre-run by /prep-for-work — so it is the only honest denominator.
//
// Best-effort by construction: a gh failure yields `null`, which renders as "—" and never blocks the
// poll loop. A null is explicitly NOT a pass — callers must render it as unknown.
export async function deliveredVsAssigned({ pr, assigned, repoRoot, run = runCommand } = {}) {
  if (pr == null || !assigned) return null;
  const res = await run({
    command: "gh",
    args: ["pr", "view", String(pr), "--json", "additions,changedFiles", "-q", ".additions,.changedFiles"],
    cwd: repoRoot,
  }).catch(() => null);
  if (!res || res.exitCode !== 0) return null;
  const [additions, files] = String(res.stdout ?? "").trim().split("\n").map(Number);
  if (!Number.isFinite(additions) || !Number.isFinite(files)) return null;
  const ratio = (d, a) => (a > 0 ? d / a : null);
  return {
    additions, files,
    additionsRatio: ratio(additions, assigned.additions),
    filesRatio: ratio(files, assigned.files),
    over: additions > assigned.additions || files > assigned.files,
  };
}

// DER-2559 (ancestor variant) — is `sha` a STRICT descendant of `ancestor`?
//
// `git merge-base --is-ancestor A B` exits 0 when A is an ancestor of B. Self-ancestry is also 0, so a
// strict descendant additionally requires the two to differ. Returns `null` when the question cannot be
// answered (unknown sha, no repo, git failure) — the caller must treat null as "unverified", never as a
// pass, or this becomes a check that cannot fail.
export async function shaDescendsFrom({ repoRoot, ancestor, sha, run = runCommand } = {}) {
  if (!repoRoot || !ancestor || !sha) return null;
  if (ancestor === sha) return false;
  const res = await run({ command: "git", args: ["merge-base", "--is-ancestor", ancestor, sha], cwd: repoRoot }).catch(() => null);
  if (!res || (res.exitCode !== 0 && res.exitCode !== 1)) return null; // 0 = yes, 1 = no, anything else = broken
  return res.exitCode === 0;
}

// Stamp `sha_descends` onto derived hand-off events so the PURE fold can tell a forward head-move from a
// backwards one. Only meaningful while the issue sits in `kickback` and we know the kickback's sha — with
// no kickback context there is nothing to clear, and stamping anyway would make every ordinary hand-off
// read as a flap.
//
// FAIL-CLOSED on an unresolvable sha (DER-2778). `shaDescendsFrom` returns null when git cannot answer —
// an unknown object (the shape a fork's head has on a clone that only ever fetched origin), no repo, a
// broken git. This used to DECLINE TO STAMP, leaving the field `undefined`, and the fold's fallback then
// read "the sha merely DIFFERS from the kickback sha" as proven new work: `provenNewSha` true, kickback
// cleared, the round silently dropped out of `kickbacks_pending`. That is a check that cannot fail,
// pointed at the exact outcome three rounds of flap-guard work exist to prevent. Unverified is now
// recorded as NOT-PROVEN-FORWARD (`sha_descends:false`, the value the fold already refuses to clear on),
// with `sha_unresolved` distinguishing "git said backwards" from "git could not say" for the operator —
// without it a stalled unit reads as a proven backwards move, which is a different diagnosis.
// The conservative failure is a kickback that stays pending until a real delivery marker
// (`lead_spawned` re-spawn / `kickback_relayed`); the alternative failure is a finding that stops being
// tracked, which is how this class shipped twice.
export async function annotateShaAncestry(events, { repoRoot, kickbackSha, run = runCommand } = {}) {
  if (!kickbackSha || !repoRoot) return events;
  for (const e of events) {
    if (e?.type !== "handed_off" || !e.sha) continue;
    const descends = await shaDescendsFrom({ repoRoot, ancestor: kickbackSha, sha: e.sha, run });
    e.sha_descends = descends === true;
    if (descends === null) e.sha_unresolved = true;
  }
  return events;
}

// Fold cloud leads into the canonical ledger (the cloud analogue of pullHostInto for the mini): derive
// lead_online/handed_off from each open PR's state (draft/handle) AND fold any explicit WORK-EVENT
// comments. Best-effort — a gh failure returns 0, never throws the watch loop. Dedups on `${type}:${pr}`
// against events already in the ledger, so re-scanning is idempotent.
async function reconcilePrEventsInto(runDir, runId, repoRoot) {
  // DER-2750: ONE call, not 1+N. This used to list PR numbers and then `gh pr view` each one, so the cost
  // scaled with the whole repo's open-PR count (ceiling 100) at a 45s cadence — tracking unrelated activity
  // like dependabot rather than run size (~8k calls/hour worst case against a 5k/hour budget).
  //
  // The fix is deliberately NOT to narrow the list to the run's known PRs, which was the obvious-looking
  // move and would have broken cloud-lead discovery: a cloud lead ANNOUNCES itself by opening a draft PR the
  // ledger does not know about yet, and `deriveCloudPrEvents` decides relevance from branch/title (and,
  // since DER-2778, only after the PR's identity is authenticated — the breadth is still the LIST, not the
  // trust). The waste
  // was the per-PR fan-out, not the breadth — and `gh pr list --json` accepts every field the loop fetched,
  // including `comments`, so the fan-out collapses into the call that was already being made.
  //
  // DER-2778: `author,headRepositoryOwner` ride along on the SAME call — measured free (the GraphQL
  // cost stays 1 point at the 100×100 ceiling), and without them `deriveCloudPrEvents` had nothing but a
  // branch/title substring to decide that a PR belongs to this run. A second call is not the answer here.
  //
  // DER-2840 adds `isCrossRepository` to the same call, and re-measured rather than inheriting the
  // claim: against this repo, with a zero-noise control (two `gh api rate_limit` reads and no call
  // between them ⇒ delta 0), the field set costs 1 GraphQL point both WITHOUT and WITH the new field.
  const listRes = await runCommand({ command: "gh", args: ["pr", "list", "--state", "open", "--json", "number,isDraft,body,headRefName,title,headRefOid,comments,author,headRepositoryOwner,isCrossRepository", "--limit", "100"], cwd: repoRoot });
  if (listRes.exitCode !== 0) return { folded: 0 };
  let prRows;
  try { prRows = JSON.parse(listRes.stdout || "[]"); } catch { return { folded: 0 }; }
  if (!Array.isArray(prRows)) return { folded: 0 };
  const existing = await readEvents(runDir);
  const state = materializeState(existing, { run_id: runId });
  const scope = Object.keys(state.issues);
  // No tracked issues yet (run hasn't dispatched anything) ⇒ nothing to reconcile. NEVER fold with an
  // empty scope, or deriveCloudPrEvents/parsePrEventComments would ingest EVERY open PR in the repo.
  if (!scope.length) return { folded: 0 };
  // Bundle-id fidelity (item 2): map each primary id → its full bundle list so derived events carry every
  // id. Kickback context (item 1): per-PR status, the SHA recorded on the latest kickback, and the SHAs of
  // any fix_pushed already emitted (for idempotent belt-and-braces detection).
  const bundles = Object.fromEntries(
    Object.entries(state.issues).filter(([, v]) => Array.isArray(v.bundle) && v.bundle.length).map(([id, v]) => [id, v.bundle]),
  );
  const prToIssue = new Map();
  for (const [id, v] of Object.entries(state.issues)) if (v.pr != null) prToIssue.set(v.pr, id);
  const kickbackShaByPr = new Map();
  for (const e of existing) if (e.type === "kickback" && e.pr != null && e.sha) kickbackShaByPr.set(e.pr, e.sha);
  const fixShasByPr = new Map();
  for (const e of existing) if (e.type === "fix_pushed" && e.pr != null && e.sha) {
    if (!fixShasByPr.has(e.pr)) fixShasByPr.set(e.pr, []);
    fixShasByPr.get(e.pr).push(e.sha);
  }
  // Kickback-aware suppression set (item 1): a re-openable lifecycle event before a later kickback no
  // longer suppresses a fresh derivation (the draft→ready re-hand-off after a fix).
  const seen = derivedEventSeen(existing);
  let folded = 0;
  // Every event THIS cycle appended, in append order (DER-2778 rider). links.md below is rendered from
  // `existing` + these instead of re-reading the whole ledger: `existing` alone would regress it, because
  // it was read BEFORE the folds and the freshly-derived `lead_online` handles are the entire point of
  // refreshing the file here.
  const appended = [];
  const append = async (e) => { appended.push(await appendEvent(runDir, e)); folded += 1; };
  const emit = async (e) => {
    // pr-less events dedup on their content key too (DER-2519) — the old `pr != null` guard is the
    // exact hole that let one comment re-append every scan. Idempotence control: running reconcile
    // twice against an unchanged PR must append nothing on the second pass.
    const key = eventSeenKey(e);
    if (seen.has(key)) return;
    seen.add(key);
    await append(e);
  };
  for (const data of prRows) {
    const pr = data?.number;
    if (pr == null) continue;
    // IDENTITY FIRST (DER-2778) — an unauthenticated PR row is not untrusted input to be filtered
    // downstream, it is not input at all, so nothing below reads it. `deriveCloudPrEvents` re-checks
    // this internally (it is an exported pure seam and must stand alone for any future caller); the two
    // call the SAME predicate, so they cannot drift apart.
    //
    // The COMMENTS are gated here too, deliberately. DER-2737 authenticates a comment by its AUTHOR,
    // which is the right control for "did this actor say it" — but the reader also stamps `pr` from the
    // PR the comment sits on and treats that as authoritative. Folding a comment off an unauthenticated
    // PR therefore injects that PR's number into the run's state, which is the retargeting attack this
    // issue closes, reached through a different door: the Codex review bot is a TRUSTED comment author
    // and comments on whatever PR it is asked to review, including a fork's.
    if (!prIdentityTrusted({
      author: data.author, headRepositoryOwner: data.headRepositoryOwner,
      // DER-2840: this projection is field-by-field, so a new identity field that is not named HERE is
      // dropped before the predicate ever sees it — and a dropped `isCrossRepository` reads as "I do not
      // know" and denies every PR, disabling the cloud lane rather than reopening the hole. Silent
      // either way; named here so it cannot go missing.
      isCrossRepository: data.isCrossRepository,
    })) continue;
    // Belt-and-braces fix_pushed (item 1): SHA-keyed, so it bypasses the `${type}:${pr}` seen set (which
    // would block a 2nd fix on a different SHA). deriveKickbackFixEvents does the SHA-based idempotency.
    // MUST append BEFORE the derived handed_off for the same scan (2026-07-16 flap guard): the fold only
    // honors a post-kickback handed_off once the kickback is actioned, so a fix-push + re-ready caught in
    // one scan needs its fix_pushed folded first or the handed_off is ignored as a flap.
    const issue = prToIssue.get(pr);
    const issueStatus = issue ? state.issues[issue].status : undefined;
    for (const e of deriveKickbackFixEvents({
      issue, pr, status: issueStatus,
      headSha: data.headRefOid, kickbackSha: kickbackShaByPr.get(pr), seenShas: fixShasByPr.get(pr) || [],
    })) await append(e);
    // DER-2559 (ancestor variant): resolve ancestry HERE, where a repo is in hand, and stamp it on the
    // derived hand-off. The fold is pure and cannot ask git whether the head moved forwards or backwards.
    const derived = await annotateShaAncestry(
      deriveCloudPrEvents({
        // The projection stays explicit (not `...data`) so every field the derivation may read is a
        // deliberate one. `author`/`headRepositoryOwner`/`isCrossRepository` are what
        // `deriveCloudPrEvents` authenticates on (DER-2778, DER-2840); dropping any of them here would
        // silently restore deny-everything, not the old trust-all.
        pr: {
          number: pr, isDraft: data.isDraft, body: data.body, headRefName: data.headRefName,
          title: data.title, headRefOid: data.headRefOid,
          author: data.author, headRepositoryOwner: data.headRepositoryOwner,
          isCrossRepository: data.isCrossRepository,
        },
        runIssues: scope, bundles, status: issueStatus, kickbackSha: kickbackShaByPr.get(pr),
      }),
      { repoRoot, kickbackSha: issueStatus === "kickback" ? kickbackShaByPr.get(pr) : null },
    );
    for (const e of derived) await emit(e);
    // `pr` is passed so the reader stamps the PR the comment was actually posted on rather than trusting
    // the body's claim; the author allowlist comes from config (DER-2737).
    // Ancestry is stamped on these too (DER-2778): `COMMENT_FIELDS_COMMON` lets a comment carry `sha`, so
    // a comment-reported `handed_off` reached the fold with NO `sha_descends` and cleared a pending
    // kickback on nothing but "the sha differs" — the same fail-open the derived path had, one call site
    // over. Same guard, same place, so the two ingestion paths cannot answer differently.
    const fromComments = await annotateShaAncestry(
      parsePrEventComments({ comments: data.comments || [], runIssues: scope, pr }),
      { repoRoot, kickbackSha: issueStatus === "kickback" ? kickbackShaByPr.get(pr) : null },
    );
    for (const e of fromComments) await emit(e);
  }
  // Publish the operator monitor links (item 7) from the freshly-folded state — cheap, and this is where
  // cloud leads' `lead_online` handles land, so links.md refreshes on each new cloud lead.
  // Folded from the events ALREADY IN HAND (`existing`, read at the top) plus everything this cycle
  // appended — not a second full `readEvents` of the same file (DER-2778 rider). `appended` is what makes
  // the two equivalent: without it this would publish a links.md missing exactly the handles the cycle
  // just discovered, which is the one thing the refresh is here to do.
  try {
    await writeFile(join(runDir, "links.md"), renderLinksMd(materializeState([...existing, ...appended], { run_id: runId })), "utf8");
  } catch { /* links.md is best-effort operator sugar */ }
  return { folded };
}

// Per-repo overrides for the collision knobs + worktree root, from `.claude/work.config.json`.
// Absent/partial config → keep the built-in defaults. Lets a 2nd repo (DER-1476) drop in its own.
export async function applyRepoConfig(repoRoot) {
  // Reset to defaults first — module state persists across calls, so this stays idempotent + keeps
  // unit tests isolated.
  VERSION_HOLDER_PREFIXES = [...COLLISION_DEFAULTS.versionHolderPrefixes];
  VERSION_HOLDER_FILES = new Set(COLLISION_DEFAULTS.versionHolderFiles);
  SERIALIZED_FILES = new Set(COLLISION_DEFAULTS.serializedFiles);
  SCOPE_KEY_SEGMENTS = COLLISION_DEFAULTS.scopeKeySegments;
  DEFAULT_WORKTREE_ROOT = COLLISION_DEFAULTS.worktreeRoot;
  DOCKER_SCOPE_PREFIXES = [...COLLISION_DEFAULTS.dockerScopePrefixes];
  HOSTS = { ...HOSTS_DEFAULT };
  SHEPHERD_MODEL = null;
  DEFAULT_PREFER_HOSTS = [];
  LEAD_TYPES = { ...LEAD_TYPES_DEFAULT };
  // 2.5 — set BEFORE parsing, not after: a repo with no config file at all is still a repo that has
  // been configured (to the defaults), and it must not be left looking un-configured. What the marker
  // distinguishes is "applyRepoConfig ran" from "nobody ever called it".
  CONFIG_APPLIED = true;
  BUDGET = { ...BUDGET_DEFAULT };
  MODEL_PRICES = { ...MODEL_PRICES_DEFAULT };
  REPO_IDENTITY = { ...REPO_IDENTITY_DEFAULT };
  MERGE_POLICY = { ...MERGE_POLICY_DEFAULT };
  LEGACY_EVENT_MARKER = null;
  LEGACY_HANDOFF_MARKER = null;
  TRUSTED_COMMENT_AUTHORS_EXTRA = [];
  TRUSTED_PR_AUTHORS_EXTRA = [];
  COMMIT_AUTHOR = null;
  COMMIT_AUTHOR_ERROR = null;
  const cfgPath = join(repoRoot, ".claude", "work.config.json");
  CONFIG_SOURCE = { path: cfgPath, loaded: false, error: null };
  let cfg;
  try {
    cfg = JSON.parse(await readFile(cfgPath, "utf8"));
  } catch (err) {
    // Still a silent degrade to defaults for every subcommand — a repo with no config is a legitimate
    // repo, and this function runs before every command including ones that read nothing from it. What
    // changes (DER-3008) is that the failure is now RECORDED, so preflight can say "hosts came from
    // built-in defaults because <path> does not exist" instead of printing nothing at all. A JSON syntax
    // error in a 35KB config is the same shape and was equally invisible.
    CONFIG_SOURCE.error = err && err.code === "ENOENT" ? "absent" : `unreadable: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  CONFIG_SOURCE.loaded = true;
  if (Array.isArray(cfg.versionHolderPrefixes)) VERSION_HOLDER_PREFIXES = cfg.versionHolderPrefixes;
  if (Array.isArray(cfg.versionHolderFiles)) VERSION_HOLDER_FILES = new Set(cfg.versionHolderFiles);
  if (Array.isArray(cfg.serializedFiles)) SERIALIZED_FILES = new Set(cfg.serializedFiles);
  if (Number.isInteger(cfg.scopeKeySegments) && cfg.scopeKeySegments >= 1) SCOPE_KEY_SEGMENTS = cfg.scopeKeySegments;
  if (typeof cfg.worktreeRoot === "string" && cfg.worktreeRoot) DEFAULT_WORKTREE_ROOT = cfg.worktreeRoot;
  if (Array.isArray(cfg.dockerScopePrefixes)) DOCKER_SCOPE_PREFIXES = cfg.dockerScopePrefixes;
  if (cfg.hosts && typeof cfg.hosts === "object") {
    HOSTS = { local: { cap: 2 }, ...cfg.hosts };
    if (!HOSTS.local || typeof HOSTS.local.cap !== "number") HOSTS.local = { cap: 2, ...(HOSTS.local || {}) };
  }
  if (typeof cfg.shepherdModel === "string" && cfg.shepherdModel) SHEPHERD_MODEL = cfg.shepherdModel;
  if (Array.isArray(cfg.preferHosts)) DEFAULT_PREFER_HOSTS = cfg.preferHosts.filter((h) => typeof h === "string" && h);
  if (cfg.leadTypes && typeof cfg.leadTypes === "object") LEAD_TYPES = { claude: { proxy: false }, ...cfg.leadTypes };
  if (cfg.budget && typeof cfg.budget === "object") {
    for (const k of Object.keys(BUDGET_DEFAULT)) {
      const v = cfg.budget[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) BUDGET[k] = v;
    }
  }
  if (cfg.modelPrices && typeof cfg.modelPrices === "object") MODEL_PRICES = { ...cfg.modelPrices };
  if (typeof cfg.legacyEventMarker === "string" && cfg.legacyEventMarker) LEGACY_EVENT_MARKER = cfg.legacyEventMarker;
  if (typeof cfg.legacyHandoffMarker === "string" && cfg.legacyHandoffMarker) LEGACY_HANDOFF_MARKER = cfg.legacyHandoffMarker;
  if (cfg.commitAuthor !== undefined && cfg.commitAuthor !== null) {
    const ca = cfg.commitAuthor;
    const name = ca && typeof ca.name === "string" ? ca.name.trim() : "";
    const email = ca && typeof ca.email === "string" ? ca.email.trim() : "";
    if (name && email) COMMIT_AUTHOR = { name, email };
    else COMMIT_AUTHOR_ERROR = `commitAuthor is configured but incomplete (name=${JSON.stringify(name)}, email=${JSON.stringify(email)}) — set BOTH keys or remove the block. A half-set identity makes the lead run \`git config user.email ""\`, which SETS a broken author rather than leaving the environment default alone.`;
  }
  if (cfg.repo && typeof cfg.repo === "object") {
    for (const k of Object.keys(REPO_IDENTITY_DEFAULT)) {
      if (typeof cfg.repo[k] === "string" && cfg.repo[k]) REPO_IDENTITY[k] = cfg.repo[k];
    }
    // Merge policy (DER-2753) — validated HERE, not at the merge call. A bad value must not reach `gh`
    // as an invalid flag halfway through landing a PR; an unrecognized one keeps the safe default.
    if (MERGE_MODES.has(cfg.repo.mergeMode)) MERGE_POLICY.mergeMode = cfg.repo.mergeMode;
    if (MERGE_STRATEGIES.has(cfg.repo.mergeStrategy)) MERGE_POLICY.mergeStrategy = cfg.repo.mergeStrategy;
    // Strict `=== true`: a truthy string like "no" must NOT loosen a merge gate.
    if (cfg.repo.allowMergeWithoutChecks === true) MERGE_POLICY.allowMergeWithoutChecks = true;
  }
  // Extra logins whose PR comments may be folded as lifecycle events (DER-2737) — a second maintainer,
  // or a bot that posts on the harness's behalf. `repo.ownerLogin` is trusted automatically.
  if (Array.isArray(cfg.trustedCommentAuthors)) {
    TRUSTED_COMMENT_AUTHORS_EXTRA = cfg.trustedCommentAuthors.filter((a) => typeof a === "string" && a);
  }
  // Extra logins whose OPEN PRs may be read as this run's cloud-lead lifecycle (DER-2778) — the account
  // a cloud env's `GH_TOKEN` authors PRs as, when that is not `repo.ownerLogin`. A SEPARATE key from
  // `trustedCommentAuthors` on purpose: see getTrustedPrAuthors for why the two lists must not merge.
  if (Array.isArray(cfg.trustedPrAuthors)) {
    TRUSTED_PR_AUTHORS_EXTRA = cfg.trustedPrAuthors.filter((a) => typeof a === "string" && a);
  }
}

// ---------------------------------------------------------------------------
// Preflight: is the token reporter actually there, and does it actually work? (DER-2745 follow-up)
// ---------------------------------------------------------------------------
//
// DER-2745 shipped `session-token-report.mjs` next to the SessionEnd hook, but preflight never looked at
// it — so a stale ~/.claude (an operator who copied only work-runner.mjs) or a consumer repo carrying its
// own `scripts/session-token-report.mjs` reported PREFLIGHT GREEN while every session's token spend became
// a `telemetry_gap`: not a number, and indistinguishable at the fold from a cheap run.
//
// This check SMOKE-RUNS the reporter rather than asserting a file exists — this run has already found five
// gates that could not fail (an installer self-test behind `|| true`, a CI job green on a zero-match
// pattern, a vacuous test, a NUL scan whose pattern collapsed to empty, an installer that verified 3 of
// the 5 suites it shipped). A file-exists assertion is that same shape of non-evidence.

export const TOKEN_REPORTER_FILE = "session-token-report.mjs";

// A transcript whose token sum is KNOWN. Deliberately includes the SAME `message.id` twice: one API
// response is written to a transcript as several lines when it carries several content blocks, and each
// repeats the whole `usage` object. A reporter that sums lines instead of responses reports 494 here
// rather than 362 — so this fixture fails a plausible-but-inflating reporter instead of blessing it.
export function tokenReporterSmokeFixture() {
  const turn = (id, model, usage) => JSON.stringify({ type: "assistant", message: { id, model, usage } });
  return {
    text: `${[
      turn("msg_1", "claude-opus-5", { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 }),
      turn("msg_1", "claude-opus-5", { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 }),
      turn("msg_2", "claude-haiku-4-5", { input_tokens: 200, output_tokens: 30 }),
    ].join("\n")}\n`,
    total: 100 + 20 + 5 + 7 + 200 + 30,
  };
}

// Returns preflight `{ name, ok, detail }` legs — never throws, because a preflight that dies is a
// preflight that reports nothing. Seams (`resolveReporter`, `run`, `tmpRoot`) exist so the RED and the
// healthy-case CONTROL can both be driven in a unit test.
export async function checkTokenReporter({
  skillsDir,
  cwd = process.cwd(),
  resolveReporter: resolveReporterFn = null,
  run = runCommand,
  tmpRoot = tmpdir(),
} = {}) {
  const legs = [];
  const shippedPath = join(skillsDir, TOKEN_REPORTER_FILE);
  const GAP_WARNING = "every session's token spend will be recorded as a telemetry_gap, never as a number";

  let resolveFn = resolveReporterFn;
  if (!resolveFn) {
    // DYNAMIC import on purpose: a static one would make work-runner ↔ session-end-telemetry circular
    // (session-end-telemetry imports UNIT_ID_RE from here).
    try { ({ resolveReporter: resolveFn } = await import("./session-end-telemetry.mjs")); }
    catch (err) { resolveFn = null; legs.push({ name: "token-reporter", ok: false, detail: `cannot load session-end-telemetry.mjs (${err instanceof Error ? err.message : String(err)}) — ${GAP_WARNING}` }); }
  }

  if (resolveFn) {
    let leg;
    try {
      // `hookDir: skillsDir` so the check reports on the install it was POINTED AT rather than on whichever
      // copy of session-end-telemetry.mjs happened to be imported. In production these are the same
      // directory; when they differ, silently answering for the wrong one is how a check starts lying.
      const r = resolveFn({ cwd, hookDir: skillsDir }) ?? {};
      const searched = Array.isArray(r.searched) ? r.searched : [];
      if (!r.path) {
        leg = { name: "token-reporter", ok: false, detail: `NO reporter resolved (${r.source ?? "unresolved"}). searched: ${searched.join(", ")} — ${GAP_WARNING}. Re-run install.sh.` };
      } else if (r.source === "shipped") {
        // The reporter WE ship: drive it on a known transcript and check the number it prints.
        const fx = tokenReporterSmokeFixture();
        const dir = await mkdtemp(join(tmpRoot, "work-token-smoke-"));
        try {
          const transcript = join(dir, "transcript.jsonl");
          await writeFile(transcript, fx.text, "utf8");
          const res = await run({ command: "node", args: [r.path, "--role", "preflight", "--transcript", transcript, "--format", "event"], timeoutMs: 30000 });
          const line = String(res.stdout ?? "").split("\n").find((l) => l.startsWith(`${EVENT_MARKER} `)) ?? null;
          let ev = null;
          if (line) { try { ev = JSON.parse(line.slice(EVENT_MARKER.length + 1)); } catch { ev = null; } }
          const why = res.exitCode !== 0 ? `exit ${res.exitCode}: ${String(res.stderr ?? "").trim().slice(0, 200)}`
            : !line ? "no WORK-EVENT line on stdout"
            : !ev ? "the WORK-EVENT line is not parseable JSON"
            : ev.type !== "token_usage" ? `event type ${JSON.stringify(ev.type)}, expected token_usage`
            : ev.total_tokens !== fx.total ? `total_tokens ${ev.total_tokens} on a fixture whose measured sum is ${fx.total}`
            : null;
          leg = { name: "token-reporter", ok: !why, detail: why ? `${r.path} is present but BROKEN — ${why} — re-run install.sh; until then ${GAP_WARNING}` : `${r.path} (shipped) measured the ${fx.total}-token fixture exactly` };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      } else {
        // A consumer repo's own reporter, or an operator override: FOREIGN CLI, so no `--transcript` (an
        // unknown flag would turn a working reporter into a crashing one — the same reason the hook
        // withholds it). What we can still test is the property that matters: asked about a session that
        // cannot exist, it must refuse rather than print a zero. A confident zero is the whole defect.
        const impossible = `preflight-no-such-session-${randomBytes(8).toString("hex")}`;
        const res = await run({ command: "node", args: [r.path, "--role", "preflight", "--session-id", impossible, "--format", "event"], timeoutMs: 30000 });
        const line = String(res.stdout ?? "").split("\n").find((l) => l.startsWith(`${EVENT_MARKER} `)) ?? null;
        let ev = null;
        if (line) { try { ev = JSON.parse(line.slice(EVENT_MARKER.length + 1)); } catch { ev = null; } }
        const fabricates = res.exitCode === 0 && ev && ev.type === "token_usage";
        leg = {
          name: "token-reporter",
          ok: !fabricates,
          detail: fabricates
            ? `${r.path} (${r.source}) FABRICATES ZEROS — it exited 0 with a token_usage (total_tokens ${ev.total_tokens}) for a session id that cannot exist. A measured-looking zero is worse than a telemetry_gap: replace or remove it (unset WORK_TOKEN_REPORT to fall back to the shipped reporter).`
            : `${r.path} (${r.source}) refuses an unknown session (exit ${res.exitCode}${line ? ", but printed an event" : ", no event printed"}) — an unmeasured session cannot become a zero`,
        };
      }
    } catch (err) {
      leg = { name: "token-reporter", ok: false, detail: `check itself failed (${err instanceof Error ? err.message : String(err)}) — treat as RED; ${GAP_WARNING}` };
    }
    legs.push(leg);
  }

  // ALWAYS evaluated, independent of what resolved above: the upgrade case. An operator who copies only
  // work-runner.mjs into ~/.claude/skills/work gets a reporter-less install, and the SessionEnd hook then
  // gaps on every session while everything else looks fine.
  let shipped = false;
  try { await stat(shippedPath); shipped = true; } catch { /* absent */ }
  legs.push({
    name: "token-reporter-shipped",
    ok: shipped,
    detail: shipped ? `${shippedPath} present` : `MISSING ${shippedPath} — stale ~/.claude — re-run install.sh (DER-2745 added ${TOKEN_REPORTER_FILE})`,
  });
  return legs;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// HARNESS DRIFT (P0.3) — version equality is a CLAIM; a content digest is a MEASUREMENT.
//
// The defect this closes was observed twice, on two different hosts, and neither host could see it:
// `~/.claude/skills` is a plain directory (no `.git`), and an install that predates ~12 commits still
// reports the same `VERSION` string as the checkout it drifted from, because the version was never
// bumped across those commits. Measured on the mini at 2026-07-31 BEFORE re-installing: seven shipped
// files differed — `work-runner.mjs` alone by 37,762 bytes — while both sides reported `0.2.0`.
//
// That is the same class of defect the version-skew gate (DER-2748/2779) exists to prevent, one level
// up: the gate compares what two hosts CLAIM to be running, and two hosts running different code make
// the identical claim. So the skew check is not merely silent here — it is actively reassuring.
//
// The fix is to record, at install time, a sha256 per shipped file, and to compare digests rather than
// version strings. `install.sh` writes the manifest; `preflight` re-measures the installed tree against
// it. The manifest also carries `source_commit`, so a stale-but-untampered install can still be placed
// against origin by an operator (the drift above was exactly that shape: nothing tampered, everything
// old).
export const HARNESS_MANIFEST_FILE = "INSTALL-MANIFEST.json";

// sha256 of one file's bytes. Returns null for an unreadable/absent file rather than throwing, so a
// MISSING file is reported as missing instead of collapsing the whole check into an exception — the
// same fail-loud-per-file discipline `skillsHashCommand` uses when it refuses to hash a short list.
export async function fileDigest(path) {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch { return null; }
}

// One aggregate digest over a {path: sha256} map. Sorted by path so it is order-independent, and it
// folds the PATH in as well as the hash — otherwise renaming a file to another file's name, or
// dropping one and duplicating another, would preserve the aggregate.
//
// This MUST stay byte-identical to install.sh's `CONTENT_DIGEST`: `path:sha256` lines, LC_ALL=C sort,
// joined by "\n" with no trailing newline. Two definitions of one digest that disagree would make every
// cross-host comparison report drift between two identical installs — a check that cannot say "clean".
//
// Pinned in TWO places, because this comment previously claimed a test that did not exist: the unit
// suite fixes the wire format against a hand-computed constant, and `install.test.mjs`'s real-install
// test asserts `content_digest === aggregateDigest(files)` on a manifest install.sh actually wrote —
// which is the only control that can catch the shell and JS sides diverging.
//
// Note the format is ambiguous if a path contains `:`. install.sh refuses to ship such a filename
// rather than escaping it, precisely so this function needs no matching escape rule.
export function aggregateDigest(files = {}) {
  const lines = Object.keys(files).sort().map((p) => `${p}:${files[p]}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// Compare a recorded install manifest against the digests measured NOW. Pure, so both directions are
// unit-testable without touching ~/.claude: the acceptance criterion for this item is explicitly that a
// clean install reports CLEAN, because "a drift check that cannot report clean is as useless as one
// that cannot report drift."
//
// `absent` is deliberately its own status rather than a pass. A pre-manifest install cannot attest to
// anything, and reporting that as CLEAN would reintroduce the exact false reassurance this replaces.
export function harnessDriftVerdict({ manifest, digests = {} } = {}) {
  if (!manifest || typeof manifest !== "object" || !manifest.files) {
    return {
      status: "absent",
      ok: false,
      modified: [], missing: [], unexpected: [],
      reason: `no ${HARNESS_MANIFEST_FILE} — this install predates content-digest attestation and cannot ` +
        "prove what it is running. Re-run install.sh. (An install that cannot attest is NOT a clean one.)",
    };
  }
  const recorded = manifest.files;
  const modified = [];
  const missing = [];
  for (const path of Object.keys(recorded).sort()) {
    const now = digests[path];
    if (now == null) missing.push(path);
    else if (now !== recorded[path]) modified.push(path);
  }
  // A file present in the install but absent from the manifest is drift too: it is either a leftover
  // from an older layout or something that was never shipped, and both mislead a reader of this tree.
  //
  // DER-3008 decided this deliberately for the STALE-LEFTOVER case — a file that install.sh shipped
  // once and no longer ships. Because `files` is now the payload list rather than a walk of $DEST, such
  // a file is no longer silently re-blessed into the manifest on the next install: it stays UNTRACKED
  // and reds. That is the wanted answer. A retired module left behind under `skills/work/` is code the
  // runner can still import, and a `SCRUB-MANIFEST.md` left behind is a document an agent can still
  // read and act on — measured on this MacBook at 2026-08-01, three such leftovers were present
  // (PUBLIC-README.draft.md, SCRUB-MANIFEST.md, TURNOVER-2026-07-15-cloud-run-findings.md), invisible
  // because the old whole-tree walk hashed them into the manifest as though they were shipped.
  // Deliberately NOT in `content_digest`: the cross-host aggregate must stay a function of the source
  // commit alone, or defect 1 returns in a new shape.
  //
  // The COST of that choice, stated exactly rather than waved at: this full re-measure runs only against
  // the LOCAL install. The cross-host leg (`harness-digest:<host>`) compares the digest each side
  // RECORDED at install time; it does not ask the remote to re-measure. So a leftover, a rogue file, or
  // a post-install hand-edit on the mini is invisible from here — it moves the mini's measured tree but
  // not its recorded manifest. Catching it needs `preflight` run ON that host. (An earlier draft of this
  // comment claimed "every host runs this same local check", which is not something this code arranges.)
  const unexpected = Object.keys(digests).filter((p) => !(p in recorded)).sort();
  const ok = !modified.length && !missing.length && !unexpected.length;
  const parts = [];
  if (modified.length) parts.push(`${modified.length} MODIFIED (${modified.join(", ")})`);
  if (missing.length) parts.push(`${missing.length} MISSING (${missing.join(", ")})`);
  if (unexpected.length) parts.push(`${unexpected.length} UNTRACKED (${unexpected.join(", ")})`);
  return {
    status: ok ? "clean" : "drift",
    ok,
    modified, missing, unexpected,
    version: manifest.version ?? null,
    source_commit: manifest.source_commit ?? null,
    installed_at: manifest.installed_at ?? null,
    content_digest: manifest.content_digest ?? null,
    manifest_schema: Number.isInteger(manifest.manifest_schema) ? manifest.manifest_schema : 1,
    reason: ok
      ? `install matches its manifest (${Object.keys(recorded).length} files, version ${manifest.version ?? "?"}, ` +
        `source_commit ${String(manifest.source_commit ?? "?").slice(0, 12)}, installed ${manifest.installed_at ?? "?"})`
      : `HARNESS DRIFT — ${parts.join("; ")}. The installed tree is NOT what install.sh wrote. ` +
        "Re-run install.sh from a clean checkout; do not dispatch until this is clean." +
        (unexpected.length
          ? ` UNTRACKED files are leftovers install.sh no longer ships — \`cd ${"$"}{CLAUDE_HOME:-~/.claude} && rm ${unexpected.join(" ")}\`; ` +
            "re-installing will NOT clear them (install.sh copies over the tree, it never prunes it)."
          : ""),
  };
}

// The LEGACY (manifest_schema 1) roots: install.sh's digest used to walk all of `$DEST/skills` and
// `$DEST/hooks`, so a v1 manifest attests to that whole tree and must still be re-measured that way.
// v2 manifests carry their own `roots` (see HARNESS_MANIFEST_SCHEMA below) and this is not used.
export const HARNESS_MANIFEST_ROOTS = ["skills", "hooks"];

// DER-3008. v1: whole-tree file list, no `roots`. v2: payload-scoped `files` + explicit `roots`.
// The number is compared across hosts so a v1/v2 pair is reported as "re-install both", never as drift.
export const HARNESS_MANIFEST_SCHEMA = 2;

const manifestExcluded = (rel) => rel.split("/").includes("tmp") || basename(rel) === ".DS_Store";

// The roots this manifest's UNTRACKED scan should walk. A v2 manifest names them; anything older gets
// the legacy whole-tree pair, which is what its own `files` map was built from — measuring a v1 manifest
// with v2 roots would report every unlisted file it legitimately carries as MISSING.
export function manifestRoots(manifest) {
  const declared = manifest?.roots;
  if (Array.isArray(declared) && declared.length && declared.every((r) => typeof r === "string" && r)) return declared;
  return HARNESS_MANIFEST_ROOTS;
}

// Every file under `roots`, relative to `dest`. A root may be a DIRECTORY (walk it) or a single FILE
// (`hooks/context-wrap-nudge.mjs` — install.sh records hook roots per-file because ~/.claude/hooks is
// shared with other tools and a co-tenant's hook is not harness drift). Absent roots yield nothing
// rather than throwing — a hooks-less install is a drift finding (MISSING), not a crash.
async function walkInstalledFiles(dest, roots = HARNESS_MANIFEST_ROOTS) {
  const out = [];
  const walk = async (rel) => {
    let entries;
    try { entries = await readdir(join(dest, rel), { withFileTypes: true }); }
    catch {
      // Not a directory (or unreadable). A file-root still has to be measured, or the hook files would
      // read MISSING on every clean install and this check would red forever.
      try { if ((await stat(join(dest, rel))).isFile() && !manifestExcluded(rel)) out.push(rel); }
      catch { /* genuinely absent — the manifest's own entry reports it MISSING */ }
      return;
    }
    for (const ent of entries) {
      const childRel = `${rel}/${ent.name}`;
      if (manifestExcluded(childRel)) continue;
      if (ent.isDirectory()) await walk(childRel);
      else if (ent.isFile()) out.push(childRel);
    }
  };
  for (const root of roots) await walk(root);
  return out;
}

// Read + re-measure an installed tree against its own manifest. `dest` is the install root (~/.claude).
//
// This WALKS THE TREE rather than only re-hashing the paths the manifest lists. Hashing just the listed
// paths was the first implementation, and its own acceptance control caught the flaw: it reported
// `untracked: []` for a rogue file placed in the install, because a file absent from the manifest is
// exactly the file such a loop never visits. That is the defect class this whole plan is about — a check
// that cannot produce the failing answer — so the walk is the fix, not the report wording.
export async function measureHarnessDrift(dest) {
  let manifest = null;
  try { manifest = JSON.parse(await readFile(join(dest, HARNESS_MANIFEST_FILE), "utf8")); }
  catch { return harnessDriftVerdict({ manifest: null }); }
  const digests = {};
  const seen = new Set();
  // Walk the roots this manifest declares (v2) or the legacy whole-tree pair (v1). Scoping the walk is
  // what lets the file list be payload-scoped without every unrelated skill in a shared ~/.claude/skills
  // reading as UNTRACKED on a clean install.
  for (const rel of await walkInstalledFiles(dest, manifestRoots(manifest))) {
    seen.add(rel);
    const d = await fileDigest(join(dest, rel));
    if (d != null) digests[rel] = d;
  }
  // A manifest path the walk did not reach (deleted, or under a root that no longer exists) still needs
  // a probe, so it is reported MISSING rather than silently dropping out of both sides of the compare.
  for (const rel of Object.keys(manifest.files ?? {})) {
    if (seen.has(rel)) continue;
    const d = await fileDigest(join(dest, rel));
    if (d != null) digests[rel] = d;
  }
  return harnessDriftVerdict({ manifest, digests });
}

// `work-config`, as a pure function (DER-3008 round 2).
//
// ABSENT and UNREADABLE are NOT the same verdict, and collapsing them into `unknown` made the worse one
// harmless: `unknown` does not fail the gate, so a JSON syntax error in a real five-host config degraded
// silently to `{local:{cap:2}}` and printed PREFLIGHT GREEN with the mini lane simply gone. Absent is
// genuinely ambiguous — a single-host repo looks identical — so it stays UNKNOWN. A file that EXISTS and
// does not parse is not ambiguous at all: the operator believes it is in force. That REDS.
export function workConfigVerdict({ source = {}, hosts = {} } = {}) {
  const names = Object.keys(hosts);
  if (source.loaded) return { ok: true, detail: `${source.path} — ${names.length} host(s): ${names.join(", ")}` };
  if (source.error === "absent") {
    return {
      ok: "unknown",
      detail: `NO CONFIG at ${source.path} — hosts fall back to the built-in {local:{cap:2}}, so every cross-host ` +
        "check below has nothing to check. UNKNOWN, not green: it cannot tell a single-host repo from a preflight " +
        "run in the wrong directory. Run preflight from the repo whose `.claude/work.config.json` declares the " +
        "hosts, or pass --repo-root <that repo>.",
    };
  }
  return {
    ok: false,
    detail: `BROKEN CONFIG at ${source.path} — ${source.error ?? "unreadable"}. The file EXISTS and did not parse, ` +
      "so every value it declares (hosts, lead types, budget, merge policy, commit author) is silently at its " +
      "built-in default right now — hosts are {local:{cap:2}} and the remote lanes are gone. This REDS rather than " +
      "warns: unlike an absent config, there is no reading of this that is correct. Fix the JSON and re-run.",
  };
}

// `cross-host-checks`, as a pure function (DER-3008 round 2). Answers "did the ssh-shaped checks below
// run against anything, and if not, is that FINE or is it a defect?"
//
// The subtlety worth the function: zero targets is a legitimate green for a genuinely single-host repo,
// but NOT while a host is declared-and-unverifiable. Such a host has a cap, so it can receive dispatch —
// the shape is a broken multi-host repo, and printing "genuinely single-host repo" tells the operator
// the opposite of what the `cross-host:<name>` line directly above it says.
export function crossHostCoverageVerdict({ targets = [], skipped = [], configLoaded = false } = {}) {
  const misconfigured = skipped.filter((s) => s.misconfigured).map((s) => s.name);
  if (targets.length) {
    return {
      ok: true,
      detail: `${targets.length} ssh host(s) checked below: ${targets.map(([n]) => n).join(", ")}` +
        (skipped.length ? ` — not checked: ${skipped.map((s) => `${s.name} (${s.why})`).join("; ")}` : ""),
    };
  }
  const why = misconfigured.length
    ? `NOT a single-host repo — ${misconfigured.join(", ")} ${misconfigured.length === 1 ? "is" : "are"} declared but ` +
      `unverifiable (see cross-host:${misconfigured[0]}); fix the config rather than reading this as "no remote hosts".`
    : configLoaded
      ? "The config loaded and declares no remote hosts, so this is a genuinely single-host repo."
      : "The config did NOT load — see work-config above.";
  return {
    ok: configLoaded && !misconfigured.length ? true : "unknown",
    detail: "NO ssh-reachable host to check — ssh-hostname/skills-sync/harness-digest emit NOTHING this run. " +
      `Hosts seen: ${skipped.map((s) => `${s.name} (${s.why})`).join("; ") || "none at all"}. ${why}`,
  };
}

// `skills-sync:<host>`, as a pure function (DER-3008 round 2). Same unreachable-vs-different distinction
// `harnessDigestVerdict` makes, and it was missing HERE — which was visible in the output as a direct
// self-contradiction, because both lines are printed from the SAME loop iteration against the SAME box:
// a failed ssh yields an empty remote hash, and `!!lh && lh === rh` then reported
//   🔴 skills-sync:mini — SKEW … rsync -a ~/.claude/skills/work/ macmini-hermes:.claude/skills/work/
//   ⚠️  harness-digest:mini — UNREACHABLE … this is UNKNOWN, not drift
// i.e. a confident remedy naming an rsync to a host that never answered, beside a correct abstention.
// The rsync is also the wrong action for an unreachable box and, run against a stale local tree, is the
// action most likely to make things worse.
export function skillsSyncVerdict({ hostName, sshAlias, localHash = "", remoteHash = "", remoteExitCode = 0, files = [] } = {}) {
  const lh = String(localHash ?? "").trim();
  const rh = String(remoteHash ?? "").trim();
  const list = files.join(" + ");
  // Ordered deliberately. A missing LOCAL file is a real, locally-verifiable failure and is reported
  // even when the remote is down — the remote's silence says nothing about our own install. Only then
  // does transport failure become the answer.
  if (!lh) {
    return { ok: false, detail: `a LOCAL file is missing from ${list} — re-run install.sh here first (checked before the remote: the remote's state cannot excuse a broken local install)` };
  }
  if (remoteExitCode !== 0) {
    return { ok: "unknown", detail: `UNREACHABLE — \`ssh ${sshAlias}\` exited ${remoteExitCode}; the remote hash was never read, so this is UNKNOWN, not skew. ` +
      `Do NOT rsync on this evidence — it names a host that did not answer. Re-run \`ssh ${sshAlias} true\` by hand and read the error.` };
  }
  if (!rh) {
    return { ok: false, detail: `${hostName} answered but returned no hash for ${list} — the files are missing there. ` +
      `ssh ${sshAlias} 'cd ~/Projects/work-harness && git pull --ff-only && ./install.sh'` };
  }
  return lh === rh
    ? { ok: true, detail: `in sync (${list})` }
    : { ok: false, detail: `SKEW in ${list} — rsync -a ~/.claude/skills/work/ ${sshAlias}:.claude/skills/work/` };
}

// The cross-host half of the drift check, as a PURE function (DER-3008). It used to be ~15 lines inlined
// in the `preflight` case, reachable only by an ssh to a real box — so the one verdict an operator acts
// on ("re-install on mini") had no test that could return the failing answer, and the digest-scope defect
// this function's caller was built on went unnoticed through a whole deploy.
//
// `remoteExitCode` is a separate input from `remoteRaw` on purpose: the remote command is
// `cat … 2>/dev/null || true`, which exits 0 for an ABSENT manifest AND prints nothing for an
// UNREACHABLE host. Only ssh's own exit code separates "the box said it has no manifest" from "the box
// never answered", and printing the first when you measured the second sends an operator to ssh into a
// machine that is not there. Unreachable is UNKNOWN — a probe that could not run is never a verdict.
export function harnessDigestVerdict({ hostName, sshAlias, local = {}, remoteRaw = "", remoteExitCode = 0 } = {}) {
  let remoteDigest = null, remoteVersion = null, remoteSchema = null;
  try {
    const m = JSON.parse(String(remoteRaw ?? "").trim());
    remoteDigest = m?.content_digest ?? null;
    remoteVersion = m?.version ?? null;
    remoteSchema = Number.isInteger(m?.manifest_schema) ? m.manifest_schema : 1;
  } catch { /* absent, unreachable or unparseable ⇒ null, discriminated below */ }
  const localDigest = local.content_digest ?? null;
  const localSchema = local.manifest_schema ?? 1;
  const unreachable = remoteExitCode !== 0;
  // Checked BEFORE equality: two manifests of different schemas enumerate different file SETS, so their
  // aggregates are not comparable at all. Reporting that as CONTENT DRIFT would name a defect that does
  // not exist and send the operator re-installing the wrong host.
  const schemaSkew = !!remoteDigest && !!localDigest && remoteSchema !== localSchema;
  // UNREACHABLE is decided BEFORE any comparison, and the detail is ordered to match. Both used to run
  // equality first, and `remoteRaw` is BUFFERED STDOUT — an ssh that printed the manifest and then died
  // (or one whose stdout carried anything parseable) left a remote digest equal to the local one, so a
  // FAILED transport returned `{ ok: true }` under the green "identical content digest" line while
  // `unreachable: true` sat in the same object, unread. A probe that could not run is never a verdict:
  // the green answer here is the one an operator uses to authorise a dispatch to that host.
  const ok = !unreachable && !!localDigest && !!remoteDigest && !schemaSkew && localDigest === remoteDigest;
  const detail = unreachable
    ? `UNREACHABLE — \`ssh ${sshAlias}\` exited ${remoteExitCode}; the digest was never read, so this is UNKNOWN, not drift. ` +
      `Re-run \`ssh ${sshAlias} 'cat ~/.claude/${HARNESS_MANIFEST_FILE}'\` by hand and read the error.`
    : ok
      ? `identical content digest (${localDigest.slice(0, 12)}, version ${local.version})`
      : !localDigest
        ? `LOCAL has no ${HARNESS_MANIFEST_FILE} — re-run install.sh here first`
        : !remoteDigest
          ? `${hostName} answered but has no readable ${HARNESS_MANIFEST_FILE} — ssh ${sshAlias} 'cd ~/Projects/work-harness && git pull --ff-only && ./install.sh'`
          : schemaSkew
            ? `MANIFEST SCHEMA SKEW — local v${localSchema}, ${hostName} v${remoteSchema}. The two manifests describe different file SETS ` +
              `(v1 hashed every file under ~/.claude/skills including the operator's unrelated skills; v2 hashes only the shipped payload — DER-3008), ` +
              `so the aggregates are NOT comparable and this is not evidence of drift. Re-run install.sh on BOTH hosts from the same commit.`
            : `CONTENT DRIFT vs ${hostName}: ${localDigest.slice(0, 12)} (v${local.version}) vs ${remoteDigest.slice(0, 12)} (v${remoteVersion})` +
              `${local.version === remoteVersion ? " — SAME VERSION STRING, DIFFERENT CODE. This is exactly the drift a version check cannot see." : ""}` +
              ` — re-install on ${hostName}`;
  return { ok: ok ? true : (unreachable ? "unknown" : false), detail, localDigest, remoteDigest, localSchema, remoteSchema, schemaSkew, unreachable };
}

// `harness-version-agreement`, as a pure function (remediation round 1). Three different values are all
// called "the harness version" and a reader collapses them into one:
//   (a) the VERSION file beside the RUNNING code — the only one that describes the bytes executing now;
//   (b) `$DEST/VERSION` — what an installed host resolves;
//   (c) `manifest.version` — what install.sh recorded when it last wrote the tree.
//
// The leg exists to make (a) vs (b) vs (c) loud. It read (a) through `getHarnessVersion()`, which prefers
// `WORK_HARNESS_VERSION` and then a process-level cache — so the ONE instrument for version skew answered
// with the override instead of the file. Executed by a reviewer: override, install and manifest all at
// 0.4.0 with the running file at 0.5.0 printed a green "0.4.0 everywhere". The check that exists to catch
// a false version claim was the thing making it.
//
// The env override is therefore itself reportable, even when the files agree: while it is set, every
// version-bearing event stamp and status line in this run carries the override rather than a file
// reading, and this leg is the only place positioned to say so. Two independent rules, deliberately not
// entangled: ANY active override makes this non-green — ⚠ UNKNOWN, naming the override and the remedy,
// whether or not it contradicts the running file — and a disagreement among the three FILES reds on its
// own, override or not. So the red in the executed scenario comes from `0.5.0` running against a `0.4.0`
// install, not from the override; the override is named in that same detail but never decides the colour.
// The process cache is not treated as a separate hazard because it is
// only ever populated FROM the running file (see `getHarnessVersion`), so it cannot disagree with it; the
// env var is the sole poisoning vector, and a check for a condition that cannot occur is not evidence.
export function harnessVersionAgreementVerdict({
  runningFile = null, runningFrom = "", reported = null,
  installed = null, installedPath = "", recorded = null,
  manifestFile = HARNESS_MANIFEST_FILE, envOverride = null,
} = {}) {
  const env = typeof envOverride === "string" && envOverride.trim() ? envOverride.trim() : null;
  const overrideNote = env
    ? `WORK_HARNESS_VERSION=${env} is set: every version this process REPORTS elsewhere (${reported ?? "?"}) is that string, not a file reading — unset it before quoting any version from this run. `
    : "";
  // `recorded == null` means there is no manifest at all — `harness-drift` above already reds on that
  // with the right remedy, and calling it a VERSION disagreement here would name a second, wrong defect
  // for one cause. A running file that will not resolve is the same shape: compare only what was read.
  if (runningFile == null || installed == null || recorded == null) {
    return {
      ok: "unknown",
      detail: `cannot compare: ${runningFile == null ? "the running tree's VERSION file did not resolve" : installed == null ? `no ${installedPath}` : `no version in ${manifestFile}`}. ` +
        `${overrideNote}The running tree resolved from ${runningFrom} describes THAT tree, not necessarily the install. See harness-drift above; re-run install.sh.`,
    };
  }
  const agree = runningFile === installed && installed === recorded;
  if (!agree) {
    return {
      ok: false,
      detail: `VERSION DISAGREEMENT — the running tree's VERSION file says ${runningFile} (${runningFrom}), ` +
        `${installedPath} says ${installed}, manifest says ${recorded}. ` +
        (runningFile !== installed
          ? "You are running a runner from somewhere other than the install (typically a checkout), so any version this process prints describes THAT tree, not the deployed hosts — do not quote it as a deploy reading. "
          : "") +
        overrideNote +
        "Re-run ./install.sh, then re-run preflight from the installed harness.",
    };
  }
  if (env) {
    return {
      ok: "unknown",
      detail: `${runningFile} in all three files (running tree, ${installedPath}, manifest) — but ${overrideNote.trim()} ` +
        "The files agree, so nothing is misreported right now; this abstains rather than greens because the version this run publishes is not the version it measured.",
    };
  }
  return { ok: true, detail: `${runningFile} everywhere (running tree at ${runningFrom}, ${installedPath}, and the manifest)` };
}

// ── 2.7 — staleness of queued work is unchecked, and the NAIVE check is blind ──────────────────
// DER-2594 sat `Todo` for ~21h having been fixed weeks earlier (landed in #1082 / b635d0275). Worse:
// its parked branch was BEHIND main, so merging it would have REMOVED a `credentials` join and reopened
// the exact security drift it was filed to close. Only an empty cherry-pick caught it.
//
// And the obvious check is itself blind. DER-2814 matches `preflight` EIGHT TIMES in `onboarding.ts` —
// every hit the unrelated body-size budget (`preflightCap`). `grep -c` reads ALREADY DONE. A symbol's
// PRESENCE is not the feature's presence, so the check must report WHERE a symbol landed (commit,
// subject, date) and leave the reading to a human, rather than collapsing it to a count.
export function stalenessCommand(symbol, { since = null } = {}) {
  // -S is the pickaxe: commits that CHANGED the number of occurrences, i.e. where it was introduced or
  // removed — not every commit that happens to touch a line containing it (that is -G, which is noisier
  // and would re-introduce the same false-positive problem in a different shape).
  return ["log", "-S", symbol, "--oneline", "--date=short", "--pretty=format:%h %ad %s", ...(since ? [`${since}..HEAD`] : []), "--", "."];
}

export function stalenessVerdict({ symbol, hits = [] } = {}) {
  if (!hits.length) {
    return { symbol, state: "not-found", stale: false, note: "no commit on main ever added or removed this symbol — the work looks genuinely undone (or the symbol name is wrong; a typo'd symbol also finds nothing)" };
  }
  return {
    symbol,
    state: "landed",
    stale: true,
    hits,
    // Deliberately does NOT say "already done". That was the DER-2814 failure: a count read as done when
    // all eight hits were an unrelated identifier.
    note: `this symbol was ADDED OR REMOVED by ${hits.length} commit(s) on main — READ THE CALL SITE before dispatching. ` +
      "A symbol's presence is not the feature's presence (DER-2814 matched `preflight` 8x, every hit an unrelated " +
      "body-size budget). If the work HAS landed, also check whether any parked branch is BEHIND main: DER-2594's " +
      "branch would have REVERTED the fix it was filed to make.",
  };
}

// ── 4.1 — `rotate-shepherd` (shepherd #4's top ask) ────────────────────────────────────────────
// Leads have `handoffs/<ID>.rot<n>.md` and a `rotate-lead` that checkpoints, renders a successor brief,
// respawns and verifies. THE SHEPHERD HAD NO EQUIVALENT, and `spawn-shepherd` has no handoff step at
// all — so a successor re-derived state from the ledger + `gh` and SILENTLY LOST every belief that had
// not yet become an event. At the 19:48Z rotation on 2026-07-31 shepherd #4 lost partially-written
// #1183 gate-swap findings and an unrecorded review-debt fold decision, and nothing anywhere said so.
//
// The re-derive-don't-remember discipline is right and stays: the successor's per-PR beliefs still come
// from `gh` + the ledger. What it never covered is IN-FLIGHT REASONING — an analysis half-finished, a
// decision made but not yet recorded. That is exactly what a handoff is for.
export function renderShepherdRotationBrief({ runId, instance, notes = null, openPrs = [], pending = {}, waiver = null } = {}) {
  const lines = [];
  lines.push(`# Shepherd rotation brief — run ${runId} → ${instance}`);
  lines.push("");
  lines.push("You are the INCOMING shepherd. Your predecessor stood down; this brief is the only record of");
  lines.push("what it had not yet turned into a ledger event.");
  lines.push("");
  lines.push("**Re-derive everything else.** Per-PR state comes from `gh` + the ledger on every wake, never");
  lines.push("from this file. What is below is in-flight REASONING, which the ledger cannot hold.");
  lines.push("");
  lines.push("## Predecessor's checkpoint");
  lines.push("");
  if (notes && String(notes).trim()) {
    lines.push(String(notes).trim());
  } else {
    // Say it loudly rather than rendering an empty section that reads like "nothing was in flight".
    lines.push("⚠ **NO CHECKPOINT NOTES WERE WRITTEN.** `tmp/work/<run-id>/shepherd-notes.md` was absent or empty.");
    lines.push("");
    lines.push("Treat every in-flight belief as LOST, not as absent: your predecessor may have had a");
    lines.push("half-finished analysis or an unrecorded decision, and you cannot tell which. Re-derive each");
    lines.push("open PR from scratch and re-check anything that looks half-done (a composed-but-unsent");
    lines.push("kickback, an unresolved thread with no reason recorded, a gate with no review_findings).");
  }
  lines.push("");
  lines.push("## Open PRs at rotation (re-verify each with `gh`, do not trust this list)");
  lines.push("");
  lines.push(openPrs.length ? openPrs.map((p) => `- ${p.issue} — PR #${p.pr} (${p.status})`).join("\n") : "- none recorded");
  lines.push("");
  if (waiver?.active) {
    lines.push("## ⚠ codex gate is WAIVED");
    lines.push("");
    lines.push(`Until ${waiver.until} — ${waiver.reason}`);
    lines.push("");
    lines.push("`ready` will NOT hold for want of a codex review. It STILL blocks any PR with no review_findings");
    lines.push("covering its head: record substitute reviews with `review-swap` (3 distinct lenses). See the");
    lines.push("posture-C section of your SKILL.");
    lines.push("");
  }
  const pendingLines = Object.entries(pending)
    .filter(([, v]) => Array.isArray(v) ? v.length : Boolean(v))
    .map(([k, v]) => `- **${k}**: ${Array.isArray(v) ? v.join(", ") : v}`);
  if (pendingLines.length) {
    lines.push("## Unactioned at rotation — act on these BEFORE new work");
    lines.push("");
    lines.push(...pendingLines);
    lines.push("");
  }
  return lines.join("\n");
}

// ── 4.2 — attribution must survive rotation ────────────────────────────────────────────────────
// Shepherd #5 had to correct the record: the 3-lens gate and the repro-vs-security disagreement on
// #1183 were shepherd #4's work — #1183 merged at 19:42Z, six minutes before #5 booted — and the
// misattribution had already propagated into a run report and a learnings entry.
//
// Events were stamped with a ROLE (`actor: "orch"`, `actor: "shepherd"`), so every shepherd across a
// run collapsed into one bucket and `work-metrics`' `by_role` fold could not tell them apart even in
// principle. The instance number is derived from how many of that role have already been spawned into
// THIS ledger, so it needs no coordination and is stable on replay.
export function actorInstance(role, priorSpawns = 0) {
  return `${role}#${Number(priorSpawns) + 1}`;
}

// Split `shepherd#4` back into its parts. Role-only actors (every pre-4.2 event, and `lead:DER-1`)
// return instance null — UNKNOWN, never silently folded into #1, because "the first shepherd" and "a
// shepherd we cannot identify" are different claims and only one of them can be credited.
export function parseActorInstance(actor) {
  const m = /^([a-z-]+)#(\d+)$/i.exec(String(actor ?? "").trim());
  if (!m) return { role: String(actor ?? "").trim() || null, instance: null };
  return { role: m[1], instance: Number(m[2]) };
}

// ── 6.3 — memory/swap guard, MECHANICAL rather than remembered ─────────────────────────────────
// Local swap hit 7,257 MB / 8,192 MB (88.6%) on 2026-07-31 — the documented freeze zone that once
// pinned an orchestrator and a shepherd at 0% CPU for ~40 minutes. That dispatch was declined only
// because the orchestrator happened to check. `work/SKILL.md` says to check `sysctl vm.swapusage` by
// hand, which is guidance, not a guard: the whole point of an unattended run is that nobody is there to
// remember. So the threshold refuses at the dispatch, not in prose.
export const SWAP_REFUSE_PCT = 85;
export const SWAP_WARN_PCT = 70;

// `sysctl vm.swapusage` → "vm.swapusage: total = 8192.00M  used = 7257.00M  free = 935.00M"
// Returns null when it cannot be parsed — UNKNOWN, never 0%. A guard that reads an unparseable probe as
// "plenty of headroom" fails open at exactly the moment the box is sickest.
export function parseSwapUsage(stdout) {
  const text = String(stdout ?? "");
  const total = /total\s*=\s*([\d.]+)([MG])/i.exec(text);
  const used = /used\s*=\s*([\d.]+)([MG])/i.exec(text);
  if (!total || !used) return null;
  const mb = (m) => Number(m[1]) * (m[2].toUpperCase() === "G" ? 1024 : 1);
  const t = mb(total); const u = mb(used);
  if (!Number.isFinite(t) || !Number.isFinite(u) || t <= 0) return null;
  return { totalMb: t, usedMb: u, pct: Math.round((u / t) * 1000) / 10 };
}

export function swapVerdict(swap) {
  if (!swap) {
    return { ok: "unknown", refuse: false, detail: "could not read `sysctl vm.swapusage` — UNKNOWN, not healthy. Check by hand before a heavy local dispatch." };
  }
  const at = `swap ${Math.round(swap.usedMb)}/${Math.round(swap.totalMb)} MB (${swap.pct}%)`;
  if (swap.pct >= SWAP_REFUSE_PCT) {
    return { ok: false, refuse: true, detail: `${at} — at/over ${SWAP_REFUSE_PCT}%, the documented freeze zone (a prior run pinned orch+shepherd at 0% CPU for ~40 min here). REFUSING a heavy local lane; dispatch to a mini or free memory first.` };
  }
  if (swap.pct >= SWAP_WARN_PCT) return { ok: true, refuse: false, detail: `${at} — over ${SWAP_WARN_PCT}%, watch it; a heavy local lane will push this into the freeze zone.` };
  return { ok: true, refuse: false, detail: at };
}

// ── 6.1 — a `.local` ssh HostName fails off-LAN and reads as "HOST IS DOWN" ─────────────────────
// `macmini-hermes` → `Derreks-Mac-mini.local` is Bonjour/mDNS, LAN-ONLY. Off-network it produced
// `could not resolve hostname`, and that went into a run handoff as "MINI IS DOWN, cap-5 lane gone".
// The box had been up 21 days. A documented `192.168.x` fallback is equally useless off-network — its
// presence in a config comment is FALSE REASSURANCE, which is worse than nothing.
//
// Already fixed on this machine (HostName → a Tailscale 100.x address, which routes direct on-LAN so
// there is no on-LAN cost). This is the harness half: warn on the shape, and never call a host down
// without checking the overlay first.
export function isMdnsHostName(hostName) {
  return /\.local\.?$/i.test(String(hostName ?? "").trim());
}

// A host being absent from `tailscale status` is not proof it is down, and tailscale not being
// installed says nothing at all about the host — both are UNKNOWN. Only a POSITIVE sighting is used to
// contradict a failed ssh, never to confirm one.
export function tailscaleSees({ status = "", host = "" } = {}) {
  const h = String(host ?? "").trim();
  if (!h || !String(status ?? "").trim()) return null;
  return String(status).split("\n").some((line) => line.includes(h)) ? true : null;
}

// ── 2.3 — sleep is undetectable by the obvious query ───────────────────────────────────────────
// The machine slept ~20:29Z–21:36Z and the first check said it had not. Power-assertion greps and
// `uptime` CANNOT report a sleep event — neither could have returned the failing answer. `pmset -g log`
// confirmed five cycles across the 88-minute gap.
//
// The non-obvious half: THREE `caffeinate` assertions were live during that sleep and the box slept
// anyway. `caffeinate` does NOT hold off battery or clamshell sleep.
//
// So rather than asking the OS after the fact, `watch` notices its OWN missing time: a poll loop that
// should have ticked in ~2.5s and finds 40 minutes elapsed was not running. That makes a blackout a
// ledger event instead of a forensic exercise.
export const SLEEP_GAP_FACTOR = 6;
export function sleepGapDetected({ expectedMs, actualMs, minGapMs = 60000 } = {}) {
  if (!Number.isFinite(expectedMs) || !Number.isFinite(actualMs)) return null;
  const gap = actualMs - expectedMs;
  if (gap < minGapMs || actualMs < expectedMs * SLEEP_GAP_FACTOR) return null;
  return {
    gap_ms: gap,
    gap_s: Math.round(gap / 1000),
    expected_ms: Math.round(expectedMs),
    actual_ms: Math.round(actualMs),
    note: `the watch loop lost ${Math.round(gap / 1000)}s of wall clock it should have been polling through — ` +
      "the host almost certainly SLEPT. Confirm with `pmset -g log | grep -E 'Sleep|Wake'` (uptime and " +
      "power-assertion greps CANNOT report a past sleep). Note caffeinate does NOT prevent battery or " +
      "clamshell sleep: an unattended wave needs AC power and the lid OPEN, or run it on the mini.",
  };
}

// The files whose skew between hosts silently loses telemetry or gates. `session-token-report.mjs` joined
// the list because a remote skills dir without it makes EVERY mini lead gap its token spend while
// `skills-sync` reported "in sync" on work-runner.mjs alone.
export const SKILLS_SYNC_FILES = ["work-runner.mjs", TOKEN_REPORTER_FILE];

// One md5 over the concatenation of `paths`, in the given order. A MISSING file exits 1 with no output
// instead of hashing the remainder — otherwise a host missing session-token-report.mjs would hash the
// same as any other host missing it, and two equally broken installs would read as "in sync".
// `quote:false` is for remote paths that must keep their `~` expandable.
export function skillsHashCommand(paths, { quote = true } = {}) {
  const q = paths.map((p) => (quote ? shellQuote(p) : p)).join(" ");
  return `for f in ${q}; do [ -f "$f" ] || exit 1; done; cat ${q} | md5 -q 2>/dev/null || cat ${q} | md5sum 2>/dev/null | cut -d' ' -f1`;
}

export async function runSubcommand(argv) {
  const o = parseArgs(argv);
  await applyRepoConfig(o.repoRoot ?? process.cwd());
  const runsRoot = resolveRunsRoot(o);
  const runDir = o.runId ? join(runsRoot, o.runId) : null;
  // DER-2570 — a named run must already exist; only init-run may create one. See assertExistingRunDir.
  assertExistingRunDir(runDir, runsRoot, o.subcommand, { dryRun: o.dryRun });
  // DER-2748 — before committing MORE work to this ledger, check that we can read it: no foreign wire
  // version, and not two harness versions folding one run. Reads the ledger once; dispatch is rare.
  // DER-2779 — and the version THIS process is running is one of the versions compared. The gate is the
  // only place that attests: `state`/`watch`/`heartbeat` describe the RUN and must keep reporting what the
  // ledger records, not what its reader happens to be running.
  if (runDir && VERSION_GATED_SUBCOMMANDS.has(o.subcommand)) {
    assertLedgerProtocolCompatible(
      ledgerProtocolVerdict(await readEvents(runDir), currentVersionAttestation()),
      o.subcommand,
      { allowSkew: !!o.allowVersionSkew },
    );
  }

  switch (o.subcommand) {
    case "init-run": {
      // Two invocation forms fold into one run_started event: the default `<project>` form (mode
      // "project"), and the explicit-issue-list form `--issues DER-1,DER-2` (mode "issue-list") — a
      // deliberate operator override that dispatches the listed ids regardless of Todo/Backlog status.
      // The run label comes from --project when present, else from the first few listed ids. --only
      // (filter a project to these ids) and --include-backlog stay project-mode but are recorded for
      // the brain (SKILL.md §2). materializeState reads mode/issues back so `state` shows them.
      //
      // SPEC MODE (2026-07-29, third form): `--spec <plan.json>` runs ONE spec whose units are carved in
      // the plan instead of filed as Linear children, with ONE Linear issue (`--tracking DER-N`) standing
      // for the whole thing. Everything downstream is unchanged — units key the ledger exactly as issue
      // ids do — so the two modes are directly comparable on the same metrics, which is the point:
      // `mode` is recorded on run_started and reported by work-metrics so spec-mode and issue-mode runs
      // can be A/B'd on kickback rate, delivered-vs-assigned and tokens per merged PR.
      //
      // What spec mode deliberately does NOT relax is the ASSIGNED BUDGET. That is the one lever with a
      // measured effect (0.17 kickbacks/PR inside budget vs 1.6–2.5 outside it on run 20260727T004346Z),
      // and it is enforced here identically for both modes.
      let specPlan = null;
      let specPlanPath = null;
      if (o.spec) {
        specPlanPath = resolvePath(o.spec);
        try { specPlan = JSON.parse(await readFile(specPlanPath, "utf8")); }
        catch (err) { throw new Error(`--spec ${specPlanPath}: ${err instanceof Error ? err.message : String(err)}`); }
        if (!Array.isArray(specPlan.issues) || !specPlan.issues.length) throw new Error(`--spec ${specPlanPath} has no issues[] (spec units)`);
        if (!specPlan.tracking) throw new Error(`--spec ${specPlanPath} has no "tracking" id — spec mode still needs ONE Linear issue standing for the whole spec, or the run is invisible to everyone outside this ledger`);
        if (!specPlan.specRef) throw new Error(`--spec ${specPlanPath} has no "specRef" — name the spec document the units implement`);
      }
      const listed = specPlan
        ? specPlan.issues.map((i) => i.id)
        : (o.issues ? parseIssueList(o.issues) : null);
      const only = o.only ? parseIssueList(o.only) : null;
      const mode = specPlan ? "spec" : (listed && listed.length ? "issue-list" : "project");
      const label = o.project
        ?? (specPlan ? String(specPlan.label ?? specPlan.tracking).toLowerCase()
          : (listed && listed.length ? listed.slice(0, 3).join("-").toLowerCase() : "work"));
      const runId = o.runId ?? buildRunId(new Date(), label);
      const dir = join(runsRoot, runId);
      // Run plan from /prep-for-work (2026-07-25): every subsequent `write-brief` reads the issue's
      // ASSIGNED budget from here, so the lead's plan_scope is checked rather than self-graded.
      // Validated NOW — BEFORE the run dir exists (DER-2746). Ordering is load-bearing twice over: an
      // invalid plan must fail at init rather than silently at the first dispatch, and a refusal must leave
      // NO run directory behind, because `assertExistingRunDir` (DER-2570) treats a run DIR as proof the run
      // exists — so a half-created run would let every other subcommand operate on a ledger with no
      // run_started in it.
      const planPathToCheck = o.plan ? resolvePath(o.plan) : specPlanPath;
      let planWarnings = [];
      if (planPathToCheck) {
        let plan = specPlan;
        if (!plan) {
          try { plan = JSON.parse(await readFile(planPathToCheck, "utf8")); }
          catch (err) { throw new Error(`--plan ${planPathToCheck}: ${err instanceof Error ? err.message : String(err)}`); }
        }
        if (!plan.issues?.length) throw new Error(`--plan ${planPathToCheck} has no issues[]`);
        // The cheap, specific checks first, so their wording survives for the operator; the canonical
        // validator below re-states them among its own errors. Identical in both modes ON PURPOSE — an
        // un-budgeted unit is an unbounded one whether it is called DER-1234 or SPEC-foo-U3, and dropping
        // this in spec mode would discard the one lever the data actually supports.
        const unbudgeted = (plan.issues ?? []).filter((i) => !Number.isFinite(i?.budget?.files) || !Number.isFinite(i?.budget?.additions)).map((i) => i?.id);
        if (unbudgeted.length) throw new Error(`--plan ${planPathToCheck}: no assigned budget for ${unbudgeted.join(", ")} — run \`prep-runner validate\` before init-run`);
        // DER-2746 — and now the CANONICAL gate, with the SAME strictness `prep-runner validate` applies
        // (that command calls validatePlan with no opts, so this passes none either: two doors onto one
        // plan file must not differ, or the weaker one is the only one that matters). Errors refuse;
        // warnings are advisory and returned to the caller — init-run's stdout is the run id and consumers
        // parse it, so nothing else may be printed there.
        const validatePlan = await loadPlanValidator();
        const verdict = validatePlan(plan);
        planWarnings = verdict.warnings ?? [];
        if (!verdict.ok) {
          throw new Error(
            `--plan ${planPathToCheck} is NOT dispatchable — ${verdict.errors.length} error(s) from the canonical validator ` +
            `(the same gate as \`prep-runner validate ${planPathToCheck}\`):\n` +
            verdict.errors.map((e) => `  - ${e}`).join("\n") +
            `\nFix the plan and re-run \`prep-runner validate\` until it exits 0. A plan nothing validated is a run nobody sized.`,
          );
        }
      }
      await mkdir(join(dir, "briefs"), { recursive: true });
      await mkdir(join(dir, "logs"), { recursive: true });
      const started = { run_id: runId, actor: "orch", type: "run_started", project: o.project ?? null, mode };
      if (listed && listed.length) started.issues = listed;
      if (only && only.length) started.only = only;
      if (o.includeBacklog) started.includeBacklog = true;
      if (specPlan) {
        started.specRef = specPlan.specRef;
        started.tracking = specPlan.tracking;
        started.plan = specPlanPath;
      }
      // Operator lead-concentration directive (DER-1834): `--host <name>` forces every lead onto <name>;
      // `--prefer <name>` tries it first then overflows. The orchestrator reads these back from state and
      // passes forceHost/preferHosts to pickHost each dispatch.
      if (o.host) started.forceHost = o.host;
      if (o.prefer) started.preferHosts = [o.prefer];
      // DER-2753 — record how this run intends to land PRs, so a merge is auditable against a run-start
      // declaration rather than whatever the config happened to say at merge time. `"auto"` means the
      // mode is detected per `ready` call (there is no queue probe here: init-run makes no network calls,
      // and a probe that silently no-ops in an unauthenticated shell is worse than an honest "auto").
      started.mergeMode = getMergePolicy().mergeMode ?? "auto";
      if (getMergePolicy().allowMergeWithoutChecks) started.allowMergeWithoutChecks = true;
      if (planPathToCheck) started.plan = planPathToCheck;
      await appendEvent(dir, started);
      return {
        runId, runDir: dir, mode, issues: listed ?? undefined,
        ...(specPlan ? { specRef: specPlan.specRef, tracking: specPlan.tracking } : {}),
        // DER-2746 — the canonical validator's WARNINGS, advisory: they must not refuse a run, and they must
        // not reach stdout (consumers parse the run id from it), but they must not vanish either.
        ...(planWarnings.length ? { planWarnings } : {}),
        stdout: runId,
      };
    }
    case "write-brief": {
      const repoRoot = o.repoRoot ?? process.cwd();
      const runnerCmd = o.runnerCmd ?? `node ${fileURLToPath(import.meta.url)}`;
      const hostCfg = o.host && o.host !== "local" ? getHosts()[o.host] : null;
      const isCloud = o.host === "cloud" || hostCfg?.kind === "cloud";
      const bundleArr = o.bundle ? bundleList(o.issueId, o.bundle) : undefined;
      // Kickback dossier (2026-07-16): a re-spawned lead is a fresh session — hand it every prior
      // round's findings from the ledger so it doesn't re-litigate or undo earlier fixes.
      const kbEvents = o.kickback && runDir ? await readEvents(runDir) : null;
      const priorRounds = kbEvents ? kickbackDossier(kbEvents, o.issueId) : undefined;
      // DER-2102: union the operator's --findings with EVERY un-delivered kickback in the ledger. Two
      // reviewers firing on one round used to mean one reviewer's findings silently never reached the
      // lead — and came back as the next round. Passing --findings does not opt out of the union.
      if (kbEvents) {
        const pending = pendingKickbackFindings(kbEvents, o.issueId);
        const extra = pending.filter((f) => !String(o.findings ?? "").includes(f));
        if (extra.length) {
          o.findings = [o.findings, ...extra].filter(Boolean).join("\n\n---\n\n");
        }
      }
      // The brief must match the lead type it will be handed to (pass the SAME --lead-type you will
      // pass to spawn-lead): a type whose reviewer slot is an external vendor renders the mandatory
      // review gate, and every type renders its concrete per-slot models. Default "claude" = unchanged.
      const briefLeadType = o.leadType ?? "claude";
      const briefLeadTypeCfg = getLeadTypes()[briefLeadType];
      if (!briefLeadTypeCfg) throw new Error(`unknown lead type "${briefLeadType}" — define it in .claude/work.config.json leadTypes (have: ${Object.keys(getLeadTypes()).join(", ")})`);
      // ASSIGNED budget (2026-07-25). Resolution order: explicit --budget-files/--budget-additions (a
      // mid-run split re-brief) → --plan <path> → the plan recorded on run_started by `init-run --plan`.
      // A run with no plan renders exactly as before, so this is additive for un-planned runs.
      let assignedBudget = null;
      if (Number.isFinite(o.budgetFiles) || Number.isFinite(o.budgetAdditions)) {
        assignedBudget = { files: o.budgetFiles ?? 0, additions: o.budgetAdditions ?? 0, issues: bundleArr ?? [o.issueId] };
      } else {
        let planPath = o.plan ?? null;
        if (!planPath && runDir) {
          const started = (await readEvents(runDir)).find((e) => e.type === "run_started" && e.plan);
          planPath = started?.plan ?? null;
        }
        if (planPath) {
          // A malformed or missing plan must be LOUD: silently briefing a lead with no budget is the
          // exact failure this feature exists to close.
          let plan;
          try { plan = JSON.parse(await readFile(planPath, "utf8")); }
          catch (err) { throw new Error(`could not read run plan ${planPath}: ${err instanceof Error ? err.message : String(err)}`); }
          assignedBudget = assignedBudgetFor(plan, o.issueId, bundleArr ?? []);
          if (!assignedBudget) throw new Error(`run plan ${planPath} has no budget for ${o.issueId} — add it (or pass --budget-files/--budget-additions); an un-budgeted unit is an unbounded one`);
        }
      }
      // DER-2749: refuse rather than quietly drop the line. A cloud brief is the only instruction the lead
      // gets, so a misconfigured identity has to surface here, where it is actionable.
      if (isCloud && getCommitAuthorError()) throw new Error(`write-brief --cloud: ${getCommitAuthorError()}`);
      // 2026-08-10: a planned unit briefed without --acceptance renders "(see the Linear issue)" — a
      // pointer the lead CANNOT follow (Claude headless leads have no Linear MCP; only the Codex CLI
      // does). The groomed scope lives in the Linear description; the ORCHESTRATOR has Linear access
      // and must inline it here. Refuse rather than hand a lead an unreadable pointer. Kickback
      // re-briefs are exempt: their scope is the findings dossier plus the original brief on disk.
      if (!o.kickback && assignedBudget && !String(o.acceptance ?? "").trim()) {
        throw new Error(`write-brief ${o.issueId}: unit has a plan-assigned budget but no --acceptance. Leads cannot read Linear — inline the FULL groomed scope (the issue description incl. watch-outs), e.g. --acceptance "$(cat tmp/work/plans/<wave>-scope/${o.issueId}.md)". The "(see the Linear issue)" fallback is exactly the reliance this refuses.`);
      }
      const brief = isCloud
        ? renderCloudBrief({
            issueId: o.issueId, title: o.title, branch: o.branch, runId: o.runId,
            acceptance: o.acceptance, kickback: o.kickback, findings: o.findings, bundle: bundleArr, priorRounds,
            assignedBudget,
            // DER-2749: repo/owner already reach the brief through getRepoIdentity()'s fallback inside the
            // renderer; commitAuthor had no path in at all until now.
            commitAuthor: getCommitAuthor(),
          })
        : renderBrief({
        issueId: o.issueId, title: o.title, worktree: o.worktree, branch: o.branch,
        runId: o.runId, runDir, runsRoot, ledgerRunsRoot: o.ledgerRunsRoot, runnerCmd, acceptance: o.acceptance, kickback: o.kickback, findings: o.findings,
        bundle: bundleArr, priorRounds, leadType: briefLeadType, leadTypeCfg: briefLeadTypeCfg,
        assignedBudget,
      });
      const fname = o.kickback ? `${o.issueId}.kb${o.kickback}.md` : `${o.issueId}.md`;
      const briefPath = join(runDir, "briefs", fname);
      await mkdir(join(runDir, "briefs"), { recursive: true });
      await writeFile(briefPath, brief, "utf8");
      // Record the assignment in the ledger so `state`/`budget` can check the lead's own plan_scope
      // against it. Only on the FIRST brief — a kickback re-brief must not silently re-baseline.
      if (assignedBudget && runDir && !o.kickback) {
        await appendEvent(runDir, {
          actor: "orch", type: "budget_assigned", issue: o.issueId,
          files: assignedBudget.files, additions: assignedBudget.additions,
          ...(bundleArr ? { bundle: bundleArr } : {}),
        });
      }
      return { briefPath, assignedBudget, stdout: briefPath };
    }
    case "create-worktree": {
      // DER-2742. Both hosts run the SAME pure decision (planWorktreeAction) over the same three facts:
      // the porcelain worktree registry, what is physically at the path, and whether the branch exists.
      // Neither path deletes anything, ever — an unidentifiable occupant is refused with instructions.
      // `--dry-run` stays a pure preview: it probes nothing (a preview must not depend on, or perturb,
      // live state) and prints the command the healthy path would run (DER-2514).
      const recordCreated = async (fields) => {
        const ev = { actor: "orch", type: "worktree_created", ...fields };
        if (o.bundle) ev.bundle = bundleList(o.issueId, o.bundle);
        await appendEvent(runDir, ev);
      };
      const remoteHost = o.host && o.host !== "local" ? getHosts()[o.host] : null;
      if (remoteHost) {
        const wt = join(remoteHost.worktreeRoot, o.runId, o.issueId);
        const branch = o.branch ?? `${o.issueId.toLowerCase()}-work`;
        if (o.dryRun) {
          return { worktree: wt, branch, host: o.host, stdout: `ssh ${remoteHost.ssh} ${shellQuote(remoteWorktreeAddCommand({ repo: remoteHost.repo, path: wt, branch }))}` };
        }
        const probe = await runCommand({ command: "ssh", args: [remoteHost.ssh, remoteWorktreeProbeCommand({ repo: remoteHost.repo, path: wt, branch })], timeoutMs: 60000 });
        // A failed probe is NOT a licence to proceed: without the registry we cannot tell a resume from
        // an occupied path, and the old code's answer to that was `rm -rf`.
        if (probe.exitCode !== 0) throw new Error(`create-worktree REFUSED on ${o.host}: could not probe ${wt} (ssh exit ${probe.exitCode}): ${(probe.stderr || probe.stdout || "").trim()}`);
        const facts = parseRemoteWorktreeProbe(probe.stdout);
        const plan = planWorktreeAction({ path: wt, branch, repo: remoteHost.repo, ...facts });
        if (plan.action === "refuse") throw new Error(`[${o.host}] ${plan.message}`);
        if (plan.action === "resume") {
          await recordCreated({ issue: o.issueId, worktree: wt, branch, host: o.host, resumed: true });
          return { worktree: wt, branch, host: o.host, resumed: true, stdout: wt };
        }
        // fetch first so the mini clone has fresh origin/main, then prune (only when the registration is
        // stale) and add.
        const remote = remoteWorktreeAddCommand({ repo: remoteHost.repo, path: wt, branch, attach: plan.attach, prune: plan.prune });
        const res = await runCommand({ command: "ssh", args: [remoteHost.ssh, remote] });
        if (res.exitCode !== 0) throw new Error(`remote worktree add failed on ${o.host}: ${res.stderr || res.stdout}`);
        await recordCreated({ issue: o.issueId, worktree: wt, branch, host: o.host, ...(plan.attach ? { attached: true } : {}), ...(plan.prune ? { pruned: true } : {}) });
        return { worktree: wt, branch, host: o.host, ...(plan.attach ? { attached: true } : {}), ...(plan.prune ? { pruned: true } : {}), stdout: wt };
      }
      const worktreeRoot = o.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
      const wt = join(worktreeRoot, o.runId, o.issueId);
      const branch = o.branch ?? `${o.issueId.toLowerCase()}-work`;
      if (o.dryRun) return { worktree: wt, branch, stdout: `git worktree add -b ${branch} ${wt} origin/main` };
      const repoRoot = o.repoRoot ?? process.cwd();
      const listed = await runCommand({ command: "git", args: ["-C", repoRoot, "worktree", "list", "--porcelain"] });
      if (listed.exitCode !== 0) throw new Error(`create-worktree REFUSED: git worktree list failed in ${repoRoot} — without the registry a resume is indistinguishable from an occupied path: ${(listed.stderr || listed.stdout || "").trim()}`);
      const branchProbe = await runCommand({ command: "git", args: ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`] });
      const plan = planWorktreeAction({
        path: wt, branch, repo: repoRoot,
        entries: parseWorktreeList(listed.stdout),
        branchExists: branchProbe.exitCode === 0,
        ...(await probeLocalWorktreePath(wt)),
      });
      if (plan.action === "refuse") throw new Error(plan.message);
      if (plan.action === "resume") {
        await recordCreated({ issue: o.issueId, worktree: wt, branch, resumed: true });
        return { worktree: wt, branch, resumed: true, stdout: wt };
      }
      if (plan.prune) {
        const pruned = await runCommand({ command: "git", args: ["-C", repoRoot, "worktree", "prune"] });
        if (pruned.exitCode !== 0) throw new Error(`create-worktree REFUSED: ${wt} is registered but its directory is gone, and \`git worktree prune\` failed: ${(pruned.stderr || pruned.stdout || "").trim()}`);
      }
      const res = await runCommand({ command: "git", args: worktreeAddArgs({ repo: repoRoot, path: wt, branch, attach: plan.attach }) });
      if (res.exitCode !== 0) throw new Error(`git worktree add failed: ${res.stderr || res.stdout}`);
      await recordCreated({ issue: o.issueId, worktree: wt, branch, ...(plan.attach ? { attached: true } : {}), ...(plan.prune ? { pruned: true } : {}) });
      return { worktree: wt, branch, ...(plan.attach ? { attached: true } : {}), ...(plan.prune ? { pruned: true } : {}), stdout: wt };
    }
    case "spawn-lead": {
      assertNotRoot("spawn a lead");
      const slug = o.slug ?? slugify(o.title ?? o.issueId);
      const bundle = o.bundle ? bundleList(o.issueId, o.bundle) : null;
      const name = workspaceName("lead", { issueId: o.issueId, slug, kickback: o.kickback, rotation: o.rotation, bundleCount: bundle ? bundle.length - 1 : 0 });
      // A rotation reads the purpose-built `.rot<n>` brief `rotate-lead` wrote — never the kickback
      // brief, whose prior-rounds dossier is what exhausted the predecessor in the first place.
      const fname = o.rotation
        ? `${o.issueId}.rot${o.rotation}.md`
        : o.kickback
          ? `${o.issueId}.kb${o.kickback}.md`
          : `${o.issueId}.md`;
      const localBrief = join(runDir, "briefs", fname);
      // Lead-type resolution (CLIProxyAPI comparison): default "claude" (direct subscription, unchanged).
      // A proxy-backed type (kimi/gpt) is confined to its host allowlist and its model is fixed to
      // leadModel (the opus/sonnet lane concept is Claude-only). proxyEnv points the lead at the gateway.
      const leadType = o.leadType ?? "claude";
      const ltCfg = getLeadTypes()[leadType];
      if (!ltCfg) throw new Error(`unknown lead type "${leadType}" — define it in .claude/work.config.json leadTypes (have: ${Object.keys(getLeadTypes()).join(", ")})`);
      const hostName = o.host ?? "local";
      // 6.3 — refuse a LOCAL dispatch when this box is already in the swap freeze zone. Mechanical on
      // purpose: the one time this was caught, it was caught because an orchestrator happened to check
      // `sysctl vm.swapusage` by hand and declined a db-lane lead at 88.6%. An unattended run has nobody
      // to remember, and the failure mode is not a slow lead — it is orch+shepherd pinned at 0% CPU for
      // ~40 minutes, which reads exactly like a wedge. Remote hosts are unaffected (their memory is
      // their own), and --force is the deliberate override.
      if (hostName === "local" && !o.dryRun && !o.force) {
        const swapRes = await runCommand({ command: "sysctl", args: ["vm.swapusage"], timeoutMs: 5000 }).catch(() => ({ exitCode: 1, stdout: "" }));
        const v = swapVerdict(parseSwapUsage(swapRes.stdout));
        if (v.refuse) {
          throw new Error(`spawn-lead ${o.issueId}: REFUSING a local dispatch — ${v.detail} ` +
            "Dispatch to a mini (--host <name>), free memory, or override with --force if you accept the freeze risk.");
        }
      }
      // The host allowlist is the SINGLE gate for where a proxy-backed type may run. It used to be
      // backed up by a blanket "no proxy type on any remote host" throw below, which was correct only
      // while `local` was the one machine with a gateway. A host now qualifies by being provisioned
      // (own CLIProxyAPI + own key files); the allowlist in .claude/work.config.json records which
      // ones are. Keeping both would make an allowlisted-but-still-rejected host impossible to debug.
      if (Array.isArray(ltCfg.hosts) && !ltCfg.hosts.includes(hostName)) throw new Error(`lead type "${leadType}" is not allowed on host "${hostName}" (allowed: ${ltCfg.hosts.join(", ")}). A non-Claude lead type may only run on a host provisioned with its own endpoint + credentials — a CLIProxyAPI gateway on 127.0.0.1:8317 with ~/.cli-proxy-api/config.yaml, and/or OPENROUTER_API_KEY in that host's repo .env. Provision the host and add it to this type's "hosts" list.`);
      const leadModel = ltCfg.proxy ? ltCfg.leadModel : (o.model ?? "opus");
      const proxyEnv = ltCfg.proxy ? proxyEnvPairs(ltCfg) : null;
      const remoteHost = o.host && o.host !== "local" ? getHosts()[o.host] : null;
      // Close the predecessor BEFORE spawning (DER-2521 + DER-2517). A kickback/rotation re-spawn
      // replaces the issue's lead; leaving the old session running puts two live leads on one
      // worktree (branch corruption) and leaks a CMUX pane per round. `rotate-lead` already did
      // this; `spawn-lead --kickback` did not — an inconsistency nothing warned about. Close EVERY
      // ref ever recorded for the issue (reap-style sweep), not just the latest; closing an
      // already-dead workspace is a harmless error we swallow. Remote hosts also need the remote
      // claude killed by its brief path — cmux close only drops the ssh connection.
      if (!o.dryRun && runDir) {
        const priorRefs = workspaceRefsToClose(await readEvents(runDir), o.issueId);
        if (priorRefs.length) {
          if (remoteHost) {
            // Same postcondition as rotate-lead (DER-2775), for the same reason and the same hazard: this
            // branch only runs when a PREDECESSOR was recorded, and we are about to spawn its replacement
            // onto the same worktree. `pkill …; true` let an unkilled predecessor survive into a second
            // live lead. Refusing here is recoverable (retry the spawn); two writers are not.
            const briefMatch = leadBriefPattern({ runDir: `${remoteHost.ledgerRoot}/${o.runId}`, issueId: o.issueId });
            const probe = classifyKillProbe(await runCommand({ command: "ssh", args: [remoteHost.ssh, remoteKillProbeCommand(briefMatch)] }));
            if (probe !== "killed") {
              throw new Error(
                `spawn-lead: refusing to spawn ${o.issueId} on ${o.host} — its PREDECESSOR ${KILL_PROBE_NOTES[probe]}. ` +
                  "Spawning now would put TWO leads on one worktree, which corrupts the branch. " +
                  `Clear it first: ssh ${remoteHost.ssh} "pkill -f '${bracketEscapePattern(briefMatch)}'" ` +
                  `then confirm with pgrep -f '${bracketEscapePattern(briefMatch)}' (SIGKILL it if it ignores TERM), and re-run this spawn.`,
              );
            }
          }
          for (const ref of priorRefs) {
            await runCommand({ command: cmuxBin(), args: ["close-workspace", "--workspace", ref] });
          }
        }
      }
      if (remoteHost) {
        // The brief was written by write-brief with the mini's ledgerRoot as --runs-root, so its
        // append commands already point at the mini-local ledger. Copy it to the mini, then launch.
        const remoteBriefDir = `${remoteHost.ledgerRoot}/${o.runId}/briefs`;
        const remoteBrief = `${remoteBriefDir}/${fname}`;
        const boot = buildRemoteLeadBootCommand({ name, worktree: o.worktree, briefPath: remoteBrief, ssh: remoteHost.ssh, ghTokenFile: remoteHost.ghTokenFile, model: leadModel, runDir: `${remoteHost.ledgerRoot}/${o.runId}`, proxyEnv, provider: ltCfg.provider ?? null, effort: ltCfg.effort ?? null });
        const scp = `ssh ${remoteHost.ssh} ${shellQuote(`mkdir -p ${remoteBriefDir}`)} && scp ${localBrief} ${remoteHost.ssh}:${remoteBrief}`;
        const line = `${scp} && ${boot.command} ${boot.args.map(shellQuote).join(" ")}`;
        let ref = null;
        if (!o.dryRun) {
          await runCommand({ command: "ssh", args: [remoteHost.ssh, `mkdir -p ${remoteBriefDir}`] });
          const cp = await runCommand({ command: "scp", args: [localBrief, `${remoteHost.ssh}:${remoteBrief}`] });
          if (cp.exitCode !== 0) throw new Error(`scp brief to ${o.host} failed: ${cp.stderr || cp.stdout}`);
          const res = await runCommand({ command: cmuxBin(), args: boot.args });
          // DER-2739 — the scp two lines up was ALREADY checked; the launch itself was not, which is how a
          // remote lead that never started still folded as in-flight work on this host's ledger.
          const outcome = spawnOutcome(res);
          if (!outcome.ok) {
            await refuseUnprovenSpawn({
              runDir, role: "lead", label: `spawn-lead ${o.issueId} on ${o.host}`, outcome,
              issue: o.issueId, host: o.host, kickback: o.kickback ?? 0, rotation: o.rotation ?? null, leadType,
            });
          }
          ref = outcome.ref;
        }
        const ev = { actor: "orch", type: "lead_spawned", issue: o.issueId, worktree: o.worktree, workspace_ref: ref, kickback: o.kickback ?? 0, host: o.host, transcripts_forced: launchForcesTranscripts(boot.launch) };
        // Record leadType on the REMOTE path too (2026-07-25): `lead-context` resolves a mini lead's
        // context window from its lead type, and this event is the only place that survives to state.
        if (leadType !== "claude") ev.leadType = leadType;
        if (o.rotation) ev.rotation = o.rotation;
        if (bundle) ev.bundle = bundle;
        // A dry run must be PURE (DER-2514): it used to append lead_spawned anyway, mutating the
        // ledger (rotations counter, kickback actioning) from a preview command.
        if (!o.dryRun) await appendEvent(runDir, ev);
        return { stdout: line, workspace_ref: ref, host: o.host, event: ev, dryRun: !!o.dryRun };
      }
      const { command, args, launch } = buildLeadBootCommand({ name, worktree: o.worktree, briefPath: localBrief, runDir, model: leadModel, proxyEnv, provider: ltCfg.provider ?? null, effort: ltCfg.effort ?? null });
      const line = `${command} ${args.map(shellQuote).join(" ")}`;
      let ref = null;
      if (!o.dryRun) {
        const res = await runCommand({ command: cmuxBin(), args });
        const outcome = spawnOutcome(res);
        if (!outcome.ok) {
          await refuseUnprovenSpawn({
            runDir, role: "lead", label: `spawn-lead ${o.issueId}`, outcome,
            issue: o.issueId, host: o.host ?? "local", kickback: o.kickback ?? 0, rotation: o.rotation ?? null, leadType,
          });
        }
        ref = outcome.ref;
      }
      const ev = { actor: "orch", type: "lead_spawned", issue: o.issueId, worktree: o.worktree, workspace_ref: ref, kickback: o.kickback ?? 0, transcripts_forced: launchForcesTranscripts(launch) };
      if (leadType !== "claude") ev.leadType = leadType;
      if (o.rotation) ev.rotation = o.rotation;
      if (bundle) ev.bundle = bundle;
      // Dry-run purity (DER-2514): preview only — the event is returned, never appended.
      if (!o.dryRun) await appendEvent(runDir, ev);
      return { stdout: line, workspace_ref: ref, event: ev, dryRun: !!o.dryRun };
    }
    // Cloud lead dispatch (2026-08-18) — replaces the orchestrator's hand-run `RemoteTrigger create`
    // recipe. It lives HERE, in the runner, for one reason: the dispatch receipt and the ledger event are
    // now written by the same code path. Under the routine recipe the orchestrator created the trigger with
    // an MCP tool and then hand-appended `lead_spawned`, which is exactly the seam where a fabricated or
    // mismatched id gets in ([[dispatch-id-is-a-claim-not-a-receipt]]). `claude --cloud` needs no claude.ai
    // MCP auth — it reads the cred profile's own OAuth — so the runner can own the whole step.
    case "spawn-cloud": {
      assertNotRoot("spawn a cloud lead");
      if (!runDir) throw new Error("spawn-cloud: --run <run-id> is required — the brief is read from the run dir and the dispatch receipt is written to its ledger");
      const hostName = o.host ?? "cloud";
      const hosts = getHosts();
      const hostCfg = hosts[hostName];
      if (!hostCfg) throw new Error(`spawn-cloud: unknown host "${hostName}" — define it in .claude/work.config.json hosts (have: ${Object.keys(hosts).join(", ")})`);
      if (hostCfg.kind !== "cloud") throw new Error(`spawn-cloud: host "${hostName}" is not kind:"cloud" — a machine host is dispatched with \`spawn-lead --host ${hostName}\`, which launches through cmux/ssh. This command only speaks \`claude --cloud\`.`);
      // The profile IS the account, and the account IS the cloud environment (`--environment` rejects the
      // `env_…` ids, so there is no per-spawn override). An entry with no profile rides the machine's
      // default login — operator state that changes without touching this config, which is why the
      // config's own comment calls a profile-less cloud entry a latent boot failure.
      if (!hostCfg.credProfile) throw new Error(`spawn-cloud: host "${hostName}" has no credProfile. A cloud spawn selects its ACCOUNT (and therefore its cloud environment) with CLAUDE_CONFIG_DIR, so a profile-less entry would silently ride whatever account this machine last logged in as. Add "credProfile": "~/.claude-<account>" to hosts.${hostName}.`);
      // `enabled:false` + an EXPLICIT `--host <name>` is the harness's forced-only idiom, and pickHost
      // already implements it ("a forced host is an explicit operator opt-in → bypass enabled:false").
      // This path has to agree with it: a config can truthfully say "disabled means --host only" while
      // this command refuses that exact invocation, and then the documented opt-in is a lie. What still
      // refuses is a DEFAULTED host — nobody chose it, so nobody read the note explaining why it is off.
      if (hostCfg.enabled === false && !o.host && !o.force) {
        throw new Error(`spawn-cloud: host "${hostName}" is enabled:false in .claude/work.config.json and you did not name it — read that entry's own _comment_disabled*/_comment_optin* note for the re-enable CONDITION, then opt in deliberately with \`--host ${hostName}\` (or --force).`);
      }
      if (!o.worktree) throw new Error("spawn-cloud: --worktree is required. It is not bookkeeping: the cloud session clones the ref CHECKED OUT THERE (there is no branch-selection flag), so the worktree is how this spawn chooses what the lead starts from.");
      const credProfile = hostCfg.credProfile.startsWith("~") ? join(homedir(), hostCfg.credProfile.slice(1)) : hostCfg.credProfile;
      // A bare `claude` on PATH is not necessarily the CLI: on this machine the first hit is a cmux SHIM,
      // and the codex probe carries a whole resolver (resolveCodexBin) because a shim's hang is
      // byte-identical to a quota wall. Default stays `claude` — the shim has been measured to pass
      // `--cloud` through correctly — with `--claude-bin` / hosts.<name>.claudeBin to pin the real binary.
      const claudeBin = o.claudeBin ?? hostCfg.claudeBin ?? "claude";
      const model = cloudLeadModel(o.model ?? "opus");
      const events = runDir ? await readEvents(runDir) : [];
      const bundle = o.bundle ? bundleList(o.issueId, o.bundle) : null;
      // A duplicate FIRST spawn is refused because a cloud session cannot be closed from here (no CLI stop
      // exists on this path — unproven, so not claimed), which means the two leads would both push to one
      // branch. A kickback/rotation re-spawn is the legitimate second dispatch and says so with its flag;
      // the predecessor's id rides the event as `replaces_session` so an audit can follow the handover.
      const priorSpawn = [...events].reverse().find((e) => e.type === "lead_spawned" && e.issue === o.issueId && e.cloudSessionId);
      if (priorSpawn && !o.kickback && !o.rotation && !o.force) {
        throw new Error(
          `spawn-cloud: ${o.issueId} already has a cloud lead (${priorSpawn.cloudSessionId}) on this run's ledger, and this spawn carries no --kickback/--rotation. ` +
          "Two live sessions on one branch corrupt it, and a cloud session cannot be closed from this harness. " +
          `To deliver findings to the EXISTING lead use \`steer-cloud --run ${o.runId ?? "<run>"} ${o.issueId}\` (it keeps the lead's context). ` +
          "If that session is genuinely gone, re-run with --kickback <n> (or --force) to record the replacement deliberately.",
        );
      }
      const fname = o.rotation
        ? `${o.issueId}.rot${o.rotation}.md`
        : o.kickback
          ? `${o.issueId}.kb${o.kickback}.md`
          : `${o.issueId}.md`;
      const briefPath = join(runDir, "briefs", fname);
      let brief;
      try { brief = await readFile(briefPath, "utf8"); }
      catch { throw new Error(`spawn-cloud: no brief at ${briefPath} — write it first: \`write-brief --run ${o.runId ?? "<run>"} ${o.issueId} --host ${hostName}${o.kickback ? ` --kickback ${o.kickback}` : ""} …\`. The brief text IS the argv this command passes to \`claude --cloud\`; there is no other channel into a cloud session.`);
      }
      // Branch precondition. `--push` publishes the ref instead of refusing, which is what an unattended
      // dispatch wants; without it the refusal prints the exact push command, because pushing to origin
      // on someone's behalf should be something the call site asked for.
      const branchFromLedger = [...events].reverse().find((e) => e.type === "worktree_created" && e.issue === o.issueId && e.branch)?.branch ?? null;
      const readSha = async (args) => {
        const r = await runCommand({ command: "git", args, cwd: o.worktree, timeoutMs: 30000 });
        return r.exitCode === 0 ? String(r.stdout || "").trim() : null;
      };
      const checkedOut = await readSha(["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = o.branch ?? branchFromLedger ?? (checkedOut && checkedOut !== "HEAD" ? checkedOut : null);
      const localSha = await readSha(["rev-parse", "HEAD"]);
      const remoteShaOf = async () => {
        const r = await runCommand({ command: "git", args: ["ls-remote", "origin", `refs/heads/${branch}`], cwd: o.worktree, timeoutMs: 60000 });
        // ls-remote exits 0 with EMPTY output for an absent ref, so the sha — not the exit code — is the
        // fact. An exit failure (no network, no remote) is also "unproven", never "absent".
        return r.exitCode === 0 ? (String(r.stdout || "").trim().split(/\s+/)[0] || null) : null;
      };
      let remoteSha = branch ? await remoteShaOf() : null;
      let refusal = cloudBranchRefusal({ branch, checkedOut, localSha, remoteSha, worktree: o.worktree });
      if (refusal && o.push && !o.dryRun && branch && localSha && checkedOut === branch) {
        // Never --force: a diverged remote must fail loudly here rather than have this command rewrite
        // someone else's ref to make its own precondition true.
        const pushed = await runCommand({ command: "git", args: ["push", "-u", "origin", branch], cwd: o.worktree, timeoutMs: 180000 });
        if (pushed.exitCode !== 0) throw new Error(`spawn-cloud: --push failed for ${branch}: ${(pushed.stderr || pushed.stdout || "").trim().slice(0, 400)}`);
        remoteSha = await remoteShaOf();
        refusal = cloudBranchRefusal({ branch, checkedOut, localSha, remoteSha, worktree: o.worktree });
      }
      if (refusal) throw new Error(refusal);
      const logPath = join(runDir ?? tmpdir(), "briefs", `${o.issueId}${o.kickback ? `.kb${o.kickback}` : ""}${o.rotation ? `.rot${o.rotation}` : ""}.cloud-spawn.log`);
      const built = cloudSpawnCommand({ credProfile, model, prompt: brief, logPath, claudeBin });
      const ev = {
        actor: "orch", type: "lead_spawned", issue: o.issueId, host: hostName, host_kind: "cloud",
        // The worktree is recorded for the same reason the machine paths record it: a cloud unit now OWNS
        // one locally (it is what chose the cloned ref), so reap has something to clean up and rotate-lead
        // has somewhere to put the WIP commit. Routine-era cloud units had neither.
        worktree: o.worktree,
        kickback: o.kickback ?? 0, branch, model, sha: localSha,
        // A cloud transcript is not readable from here at all (the state fold excludes cloud lanes from
        // the transcripts_unverified banner for exactly this reason), so this is `false` — measured, not
        // assumed, which is the DER-2744 rule.
        transcripts_forced: false,
      };
      if (o.rotation) ev.rotation = o.rotation;
      if (bundle) ev.bundle = bundle;
      if (priorSpawn) ev.replaces_session = priorSpawn.cloudSessionId;
      // Dry-run purity (DER-2514): print the exact command, touch nothing.
      if (o.dryRun) return { stdout: built.line, host: hostName, branch, model, event: ev, dryRun: true };
      await mkdir(join(runDir, "briefs"), { recursive: true });
      const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 180000;
      const res = await runCommand({ command: built.command, args: built.args, cwd: o.worktree, env: { ...process.env, ...built.env }, timeoutMs });
      const log = await readFile(logPath, "utf8").catch(() => "");
      const outcome = cloudSpawnOutcome({ exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, log });
      if (!outcome.ok) {
        await refuseUnprovenSpawn({
          runDir, role: "lead", label: `spawn-cloud ${o.issueId} on ${hostName}`,
          launcher: "claude --cloud",
          outcome: { ...outcome, note: outcome.note ?? cloudSpawnTimeoutNote(hostCfg.credProfile) },
          retry:
            "  BEFORE retrying, confirm no session was created: a create can land while the CLI call dies\n" +
            `  ([[dispatch-id-is-a-claim-not-a-receipt]]). Read the pty log (${logPath}) and this account's\n` +
            "  session list; a blind retry is how one branch gets two leads. Likeliest cause when the log is\n" +
            `  empty: ${cloudSpawnTimeoutNote(hostCfg.credProfile)}`,
          issue: o.issueId, host: hostName, kickback: o.kickback ?? 0, rotation: o.rotation ?? null,
        });
      }
      ev.cloudSessionId = outcome.session_id;
      if (outcome.note) ev.note = outcome.note;
      await appendEvent(runDir, ev);
      return {
        stdout: outcome.session_id, cloudSessionId: outcome.session_id, host: hostName, branch, model,
        monitor: `https://claude.ai/code/${outcome.session_id}`, log: logPath, event: ev,
      };
    }
    // Cloud kickback delivery (2026-08-18, Task 7) — steer the LIVE lead instead of respawning a
    // context-less one. Measured: `claude -p "<msg>" --cloud <session_id>` is accepted headlessly, queues
    // during a running turn, and is consumed at the turn boundary. The lead still holds the context of the
    // work the findings are about, which is the whole point; a fresh spawn re-reads everything and
    // re-litigates decisions the predecessor already made.
    case "steer-cloud": {
      if (!runDir) throw new Error("steer-cloud: --run <run-id> is required — the session id and the delivery receipt both live on that run's ledger");
      const events = await readEvents(runDir);
      const spawn = [...events].reverse().find((e) => e.type === "lead_spawned" && e.issue === o.issueId && e.cloudSessionId);
      const sessionId = o.session ?? spawn?.cloudSessionId ?? null;
      // HOST RESOLUTION MUST NOT DEPEND ON THE SESSION ID (DER-4050). `spawn` above requires
      // `e.cloudSessionId`, which is exactly the field a pre-2026-08-18 routine-era `lead_spawned` LACKS —
      // so the one event that still knows this unit's account was discarded on the very path that exists to
      // recover it. `hostName` then fell back to "cloud" and the refusal below printed a replacement command
      // pointing at a DIFFERENT account's environment. Fall back to the latest spawn carrying a host at all.
      const spawnAnyHost = [...events].reverse().find((e) => e.type === "lead_spawned" && e.issue === o.issueId && e.host);
      // Resolved BEFORE the refusal below, which names it: a message that throws a ReferenceError instead
      // of explaining itself is worse than no message, and the refusal path is exactly where nobody looks
      // until it fires. (Caught by the round-3 gate's own re-run of the suite.)
      const hostName = o.host ?? spawn?.host ?? spawnAnyHost?.host ?? "cloud";
      if (!sessionId) {
        throw new Error(
          `steer-cloud: no cloud session id for ${o.issueId}. Nothing on this run's ledger recorded one, so there is no live lead to steer. ` +
          "A pre-2026-08-18 cloud lead was spawned by RemoteTrigger routine and has no id here — pass it explicitly with --session session_… " +
          `(the draft PR's footer carries it, and \`state\` folds it onto the unit's \`handle\`), or dispatch a replacement with \`spawn-cloud --run ${o.runId ?? "<run>"} ${o.issueId} --host ${hostName} --worktree <p> --kickback <n> --push\` — the --host is REQUIRED, not decoration: it names the account this unit already lives on, and a cloud host is normally enabled:false (forced-only), so a command without it defaults to \`cloud\` and refuses.`,
        );
      }
      const hostCfg = getHosts()[hostName];
      // A DISABLED host does not receive a steer it did not ask for (DER-4050). This is the same rule
      // `spawn-cloud` states at its own guard and `rotate-lead` at its: an explicitly named host is the
      // operator's opt-in, and a host this command SYNTHESIZED from ledger state is not. A kickback round is
      // new work, and "enabled:false" means no more work here — set when an account starts 429ing, gets
      // walled, or is repointed at another environment, all of which a steer would walk straight into.
      // Guarded BEFORE the command is built, so nothing is dispatched and no `kickback_relayed` is recorded:
      // the round must stay on `state.kickbacks_pending` and keep surfacing until a human decides.
      if (hostCfg?.enabled === false && !o.host && !o.force) {
        throw new Error(
          `steer-cloud: ${o.issueId}'s lead is on host "${hostName}", which is enabled:false in .claude/work.config.json — and you did not name it.\n` +
          `  NO steer was sent and NO kickback_relayed was recorded, so this round stays UN-ACTIONED and keeps surfacing in state.kickbacks_pending.\n` +
          `  This host was resolved from the ledger, not chosen by you; a disabled host means "no more work here", and a kickback round is more work.\n` +
          `  Read that host entry's own _comment_disabled*/_comment_optin* note for the re-enable CONDITION, then opt in deliberately:\n` +
          `  steer-cloud --run ${o.runId ?? "<run>"} ${o.issueId} --host ${hostName}${o.kickback ? ` --kickback ${o.kickback}` : ""} (or --force)`,
        );
      }
      if (!hostCfg?.credProfile) throw new Error(`steer-cloud: host "${hostName}" has no credProfile — a steer must go out on the SAME account that owns the session, and CLAUDE_CONFIG_DIR is how that is chosen.`);
      const credProfile = hostCfg.credProfile.startsWith("~") ? join(homedir(), hostCfg.credProfile.slice(1)) : hostCfg.credProfile;
      // The message: an explicit --message, else the kickback brief on disk (write-brief already unions
      // every un-delivered finding into it, so this path inherits that rather than re-deriving it).
      let message = o.message ?? null;
      if (!message) {
        const fname = o.kickback ? `${o.issueId}.kb${o.kickback}.md` : `${o.issueId}.md`;
        const briefPath = join(runDir, "briefs", fname);
        try { message = await readFile(briefPath, "utf8"); }
        catch { throw new Error(`steer-cloud: no --message and no brief at ${briefPath} — compose the round's brief first (\`write-brief --host ${hostName} --kickback ${o.kickback ?? "<n>"} --findings …\`), or pass --message "<text>".`); }
      }
      // A demanded ACK is what made the queued-steer delivery PROVABLE on the 08-15 probe; without it a
      // steer that vanished and one that was read look identical from here. The PR number comes from the
      // round's own kickback event when the caller did not pass one — the instruction is worthless with a
      // `<PR>` placeholder in it, and the ledger already knows the number.
      const round = o.kickback ?? 0;
      const prFromLedger = [...events].reverse().find((e) => e.issue === o.issueId && e.pr != null)?.pr ?? null;
      const pr = o.pr != null ? Number(o.pr) : prFromLedger;
      const ack = "kickback_ack";
      const prompt = `${message}\n\n---\n\n${cloudSteerAckInstruction({ repo: getRepoIdentity().repoSlug, pr, issueId: o.issueId, round: round || 1 })}\n`;
      const built = cloudSteerCommand({ credProfile, sessionId, prompt, claudeBin: o.claudeBin ?? hostCfg.claudeBin ?? "claude" });
      const ev = {
        actor: "orch", type: "kickback_relayed", issue: o.issueId, host: hostName,
        cloudSessionId: sessionId, ack_expected: ack, ack_round: round || 1,
        ...(o.kickback ? { kickback: o.kickback } : {}), ...(pr != null ? { pr } : {}),
      };
      if (o.dryRun) return { stdout: built.line, cloudSessionId: sessionId, ack, event: ev, dryRun: true };
      const res = await runCommand({ command: built.command, args: built.args, env: { ...process.env, ...built.env }, timeoutMs: Number.isFinite(o.timeoutMs) ? o.timeoutMs : 120000 });
      const outcome = cloudSteerOutcome({ exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr });
      if (!outcome.ok) {
        // NO event is recorded, deliberately: an undelivered steer must leave the kickback PENDING, which
        // is what keeps it on `state.kickbacks_pending` and in front of the next wake. The fallback is a
        // replacement spawn on the same branch — printed here so the caller does not have to remember it.
        throw new Error(
          `steer-cloud ${o.issueId}: the steer was NOT delivered — ${outcome.reason}.\n` +
          `  NO kickback_relayed was recorded, so this round stays UN-ACTIONED and keeps surfacing in state.kickbacks_pending.\n` +
          (outcome.note ? `  the CLI said: ${outcome.note}\n` : "") +
          `  If the session has ENDED or EXPIRED (read it first: RemoteTrigger get_run_log ${sessionId}), fall back to a\n` +
          `  replacement lead on the same branch: spawn-cloud --run ${o.runId ?? "<run>"} ${o.issueId} --host ${hostName} --worktree <p> --kickback ${o.kickback ?? "<n>"} --push`,
        );
      }
      await appendEvent(runDir, ev);
      return { stdout: `${sessionId} ${ack}`, cloudSessionId: sessionId, ack, event: ev, delivered: true };
    }
    case "review-usage": {
      // Lead-facing: `… review-usage --run <r> --runs-root <p> --issue DER-x [--round n] --file review.json`
      // (or the payload on stdin). Appends the reviewer's token_usage event and PRINTS the review text,
      // so the one command both records the gate and hands the lead its findings.
      const raw = o.file ? await readFile(o.file, "utf8") : await readStdin();
      let payload;
      try { payload = JSON.parse(raw); } catch { throw new Error("review-usage: input is not JSON — did you forget `--output-format json` on the review call?"); }
      // Two reviewer shapes reach this command. Codex writes the schema'd findings object
      // (`--output-last-message`); `claude -p --output-format json` writes a modelUsage envelope.
      // Route on shape so the lead has ONE command to remember for either gate.
      if (Array.isArray(payload.findings) && payload.overall_correctness !== undefined) {
        const cwdForReview = o.repoRoot ?? process.cwd();
        const review = parseCodexReview(payload, { repoRoot: cwdForReview });
        if (!o.log) {
          // DER-2360 — the refusal STAYS (a gate that dies exits 0, so bare findings would manufacture
          // 0-finding proof of a clean PR), but it now names the acceptance path instead of dead-ending.
          // The adversarial panel IS findings-shaped with no codex JSONL, and before this it had no
          // supported command at all: that gap is what made shepherd #4 hand-roll the substitute gate.
          throw new Error(
            "review-usage: REFUSING to record a Codex review without --log <review.jsonl>; terminal producer evidence is mandatory. " +
            "If these findings came from the ADVERSARIAL PANEL rather than codex, record them with `review-panel` " +
            "(--lens-file <lens>=<file.json>, repeatable) — it has its own completion evidence per lens, so it establishes " +
            "the same fail-closed property instead of waiving this one. Posture-C substitutes still use `review-swap`.",
          );
        }
        const logText = await readFile(o.log, "utf8").catch(() => "");
        // Fail closed on a dead gate (see `codexRunCompleted`).
        const { turnCompleted, commands } = codexRunCompleted(logText);
        if (!turnCompleted) {
          throw new Error(
            `review-usage: REFUSING to record — the codex JSONL has no exact producer turn.completed event (command_execution=${commands}). ` +
            `A gate that dies exits 0, so recording it would append a 0-finding review_findings event that reads as a CLEAN PR. ` +
            `Re-run the gate. Common causes: expired credentials (\`codex login status\` lies — check the separate stderr log for 401 invalid_refresh_token), ` +
            `a bare checkout with no node_modules, or the run being killed under memory pressure.`,
          );
        }
        // A clean verdict from a run that could not execute is a false green (see the rule's own
        // comment for why the inverse — discarding a denial-bearing run WITH findings — is wrong).
        {
          const falseGreen = codexFalseGreenRefusal({ verdict: review.verdict, explanation: review.explanation, findings: review.findings });
          if (falseGreen) throw new Error(`review-usage: ${falseGreen}`);
        }
        // The sha the review actually covered. --sha wins; otherwise read the worktree's HEAD, which
        // is the tree codex just looked at. Never guessed from the PR — the gate reviews the WORKING
        // TREE, which may not equal any pushed commit.
        const shaRes = o.sha ? null : await runCommand({ command: "git", args: ["rev-parse", "HEAD"], cwd: cwdForReview }).catch(() => null);
        const coveredSha = o.sha ?? String(shaRes?.stdout ?? "").trim() ?? null;
        // 2.4 — enforce the full 40 chars AT WRITE TIME. Measured on #1180 across three recordings/95s:
        // 9- and 10-char forms both read `stale-clean`, only 40 reads `CURRENT`. It fails safe today, but
        // a blocker-carrying gate recorded short would block on FALSE staleness — and an operator who has
        // learned to distrust "stale" holds is one who waves past a real one. `git rev-parse HEAD` already
        // returns 40, so this only ever fires on a hand-passed `--sha`, which is exactly the case worth
        // refusing rather than silently truncating the run's evidence.
        {
          const bad = gateShaRefusal(coveredSha, { command: "review-usage" });
          if (bad) throw new Error(bad);
        }
        const cev = reviewFindingsEvent(review, {
          issueId: o.issueId,
          round: o.round ?? o.kickback ?? 1,
          reviewer: o.reviewer ?? "codex",
          tokensTotal: codexTokensFromLog(logText),
          sha: coveredSha || null,
        });
        await appendEvent(runDir, cev);
        const lines = review.findings.map((f) => `  P${f.priority ?? "?"} conf=${f.confidence ?? "?"} ${f.file}:${f.line_start ?? "?"}  ${f.title}`);
        const verdictLine = `${review.verdict ?? "no verdict"} (confidence ${review.confidence ?? "?"})`;
        return {
          stdout: `${verdictLine}\n${review.explanation}\n\n${lines.join("\n")}\n\n— recorded: ${cev.findings_total} findings (${cev.blockers} blocker/major), reviewer ${cev.reviewer}, round ${cev.round}${cev.tokens_total ? `, ${cev.tokens_total.toLocaleString()} tokens` : ""}`,
          event: cev,
        };
      }
      const ev = reviewUsageEvent(payload, { issueId: o.issueId, round: o.round ?? o.kickback ?? 1 });
      await appendEvent(runDir, ev);
      const offEndpoint = ev.providers.length && !ev.providers.every((p) => p === "firstParty");
      const warn = offEndpoint
        ? `\n⚠ providers=${ev.providers.join(",")} — this review did NOT ride the Claude subscription. Unset ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY on the review call and run it again.\n`
        : "";
      return { stdout: `${payload.result ?? ""}\n${warn}\n— recorded: ${Object.keys(ev.by_model).join(", ")}, ${ev.total_tokens.toLocaleString()} tokens, round ${ev.round} (${ev.billing})`, event: ev };
    }
    case "panel-prompt": {
      // DER-2360 — render ONE lens's prompt, path-routed to what this diff touches. The brief shells
      // out to this rather than carrying the prompt text inline: prose in a brief is verified by
      // nobody, and the last two review gates to lose their teeth lost them in their prompt (the
      // anti-search line that neutered codex; the variadic-flag trap that ran a lens on an empty one).
      const lensArg = (o.lens ?? [])[0] ?? o.lensName ?? null;
      if (!lensArg) throw new Error(`panel-prompt needs --lens <${[...PANEL_LENS_IDS, CROSS_VENDOR_LENS, "verify"].join("|")}>`);
      const diffPath = o.diff ?? null;
      let diffText = "";
      if (diffPath) {
        try { diffText = await readFile(resolvePath(diffPath), "utf8"); }
        catch (err) { throw new Error(`panel-prompt --diff ${diffPath}: ${err instanceof Error ? err.message : String(err)}`); }
      }
      if (lensArg === "verify") {
        return { stdout: panelVerifyPrompt({ issueId: o.issueId ?? null, unionFile: o.union ?? "<union.json>", diffFile: diffPath ?? "<diff>" }) };
      }
      // A prompt rendered from an EMPTY diff routes no repo-specific checklist at all, and reads exactly
      // like one rendered from a diff that touches nothing sensitive. Refuse: the whole value of routing
      // is that a migration gets asked about RLS, and a silently unrouted lens is the failure this
      // command exists to prevent.
      if (diffPath && !diffText.trim()) {
        throw new Error(`panel-prompt --diff ${diffPath} is EMPTY — nothing to review, and an empty diff routes NO repo-specific checklist while rendering a prompt that looks complete. Write the diff first (\`git diff origin/main...HEAD > ${diffPath}\`) and confirm it is non-empty.`);
      }
      const paths = parseDiffPaths(diffText);
      let acceptance = o.acceptance ?? null;
      if (!acceptance && o.file) {
        try { acceptance = await readFile(resolvePath(o.file), "utf8"); } catch { acceptance = null; }
      }
      // DER-3011 — the cross-vendor pass is ONE process against the panel's three, so it gets the union
      // of all three mandates plus every routed checklist. Rendering it through the same command (and
      // the same empty-diff refusal above) is deliberate: the failure both gates have actually suffered
      // is a prompt that lost its teeth, and prose in a brief is verified by nobody.
      if (lensArg === CROSS_VENDOR_LENS) {
        return {
          stdout: panelCrossVendorPrompt({
            issueId: o.issueId ?? null, diffFile: diffPath ?? "<diff>",
            paths, acceptance, base: o.base ?? "origin/main",
          }),
        };
      }
      return {
        stdout: panelLensPrompt({
          lens: lensArg, issueId: o.issueId ?? null, diffFile: diffPath ?? "<diff>",
          paths, acceptance, base: o.base ?? "origin/main",
        }),
      };
    }
    case "codex-probe": {
      // DER-3011 — "is codex reachable RIGHT NOW", as a command instead of a recipe every role
      // re-derives. Three properties, each one a measured failure this probe exists to not repeat:
      //
      //   * STDIN IS CLOSED. `runCommand` spawns with `stdio: ["ignore", …]`, which is the programmatic
      //     form of the `< /dev/null` the shepherd's runbook prints. WITHOUT it `codex exec` waits on
      //     "Reading additional input from stdin..." at 0% CPU forever — indistinguishable from a wall.
      //   * THE VERDICT IS THE TEXT. Never `codex login status` (it reports "Logged in using ChatGPT"
      //     while every call 401s) and never CPU% (a cmux shim hangs at 0% with ~37 bytes, which cost two
      //     agents ~40 minutes and a wrong root cause).
      //   * A FAILING VERDICT EXITS NONZERO and prints the ready-to-paste `--codex-waived` line. The
      //     waiver is the degradation path, so the probe that discovers the wall is what should hand it
      //     over — an operator who has to compose the reason themselves writes "n/a".
      const probeBin = resolveCodexBin({ override: process.env.WORK_CODEX_BIN ?? null });
      if (o.printBin) {
        // Deliberately NOT falling back to a bare `codex`: the caller substitutes this into a command,
        // and a shim there is the failure mode whose output is byte-identical to a quota wall.
        if (!probeBin.bin) {
          throw new Error(`codex-probe --print-bin: ${probeBin.why ?? "no codex resolved"}. Set WORK_CODEX_BIN to the real binary, or waive the round-1 codex gate with --codex-waived.`);
        }
        return { stdout: probeBin.bin };
      }
      let probeOut = "";
      let probeExit = null;
      if (probeBin.bin) {
        // `--json` is LOAD-BEARING, not cosmetic: without it the stream carries no `turn.completed`, so
        // the only evidence left is the word "OK" — which the prompt itself asks for and which error
        // text contains. Same flag, same reason, as `codexReviewCommand`.
        const res = await runCommand({ command: probeBin.bin, args: ["exec", "--json", "--sandbox", "read-only", "reply OK"], timeoutMs: 120000 })
          .catch((err) => ({ exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
        probeOut = `${String(res.stdout ?? "")}${String(res.stderr ?? "")}`;
        probeExit = res.exitCode ?? null;
      }
      const verdict = classifyCodexProbe({
        output: probeOut, exitCode: probeExit, bin: probeBin.bin, why: probeBin.why, skipped: probeBin.skipped,
      });
      const marker = `CODEX-PROBE: ${verdict.status.toUpperCase()} — ${verdict.detail}`;
      if (verdict.ok) {
        return {
          stdout: [
            marker,
            `CODEX-BIN: ${probeBin.bin}`,
            `Run the round-1 codex gate. Record it on the panel receipt with --codex-review + --codex-log.`,
          ].join("\n"),
        };
      }
      // Nonzero exit, so `codex-probe && <run the pass>` degrades correctly in a shell — and the error
      // text IS the instruction, because "read the error text" is the only reliable codex diagnostic.
      throw new Error([
        marker,
        "",
        "Do NOT stall and do NOT skip the panel. Record the panel alone, with the waiver, by appending:",
        `  --codex-waived ${JSON.stringify(verdict.waiverReason ?? "codex unavailable")}`,
        "",
        "`ready` prints the waiver so the shepherd can audit that this PR got one reviewer rather than two.",
      ].join("\n"));
    }
    case "codex-backstop": {
      // DER-2360 — the on-demand codex backstop, as a supported command rather than a remembered recipe.
      //
      // The panel is the gate. DER-3011 put a `codex exec` pass back into every ROUND-1 brief as the
      // cross-vendor lens, so this command is no longer the only production caller of
      // `codexReviewCommand` — but it stays, and its job is now the OTHER two cases: a review the
      // shepherd asks for on a REVISION round (where the brief deliberately renders nothing), and
      // CALIBRATION against the bot, which `review-fidelity` needs both sides of. `@codex review` on
      // the PR remains the cloud half. Recording differs by case and that is the whole distinction:
      // a round-1 pass is attested on the panel receipt (`review-panel --codex-review/--codex-log`),
      // while a backstop run recorded here is its OWN `review_findings` event via `review-usage`.
      const issueTag = o.issueId ?? "review";
      const selfCmd = o.runnerCmd ?? `node ${fileURLToPath(import.meta.url)}`;
      const bin = resolveCodexBin({ override: process.env.WORK_CODEX_BIN ?? null });
      if (!bin?.bin) {
        throw new Error(`codex-backstop: no usable \`codex\` on PATH${bin?.skipped?.length ? ` (skipped shim(s): ${bin.skipped.join(", ")})` : ""}${bin?.why ? ` — ${bin.why}` : ""}. This is UNKNOWN, not "codex is down": set WORK_CODEX_BIN to the real binary, or use the \`@codex review\` PR comment instead. Never invoke a bare \`codex\` — a cmux shim hangs at 0% CPU with output byte-identical to a quota wall.`);
      }
      return {
        stdout: [
          `# Local codex backstop for ${issueTag} — the panel is the GATE; this is the deliberate second opinion.`,
          `# NOT for round 1: every round-1 brief already renders the codex gate, attested on the`,
          `# panel receipt. Use this for a REVISION round the shepherd deliberately wants re-reviewed, or`,
          `# to calibrate the panel against the bot with review-fidelity.`,
          `# Run from the WORKTREE (it needs node_modules, or the test run is skipped and it goes blind).`,
          `# Write the prompt first; the SEARCH MANDATE is the load-bearing part (2 commands/0 findings`,
          `# diff-local, vs 21 commands/6 findings with it).`,
          `${selfCmd} panel-prompt --issue ${issueTag} --lens ${CROSS_VENDOR_LENS} --diff /tmp/${issueTag}-panel-diff > /tmp/${issueTag}-codex-review.md`,
          codexReviewCommand({
            bin: bin.bin,
            promptFile: `/tmp/${issueTag}-codex-review.md`,
            outFile: `/tmp/${issueTag}-codex-review.json`,
            logFile: `/tmp/${issueTag}-codex-review.jsonl`,
            // Kept separate on purpose: mixing diagnostics into the JSONL destroys its typed evidence
            // contract, and `codexRunCompleted` reads completion out of that stream.
            errorFile: `/tmp/${issueTag}-codex-review.stderr.log`,
          }),
          `# Record it as an ADDITIONAL review_findings event (reviewer=codex), then score the panel against it.`,
          `# NOTE this event becomes the LATEST gate for the unit, so its own blockers are what \`ready\` reads:`,
          `#   ${selfCmd} review-usage --run <r> --runs-root <p> --issue ${issueTag} --round <n> --reviewer codex --file /tmp/${issueTag}-codex-review.json --log /tmp/${issueTag}-codex-review.jsonl`,
          `#   ${selfCmd} review-fidelity --run <r> --runs-root <p> --issue ${issueTag} --pr <n>`,
        ].join("\n"),
      };
    }
    case "review-panel": {
      // DER-2360 — record the 3-lens adversarial panel as the pre-PR gate. Since ADR-0027 §2's 2026-08-12
      // amendment the panel is the FALLBACK (codex exec every round is the default); this command is
      // unchanged, it is just no longer the default path.
      //
      // This is a sibling of `review-swap`, not a loosening of `review-usage`. `review-usage` refuses a
      // findings-shaped payload with no codex JSONL carrying `turn.completed`, and that refusal is
      // CORRECT and stays: a gate that dies exits 0, so accepting bare findings there would let a dead
      // codex run manufacture 0-finding "proof" of a clean PR. The panel gets its own acceptance path
      // with its own completion evidence — every lens's `claude -p` envelope must show a successful run
      // AND a readable verdict — so the same fail-closed property is established rather than waived.
      if (!runDir) throw new Error("review-panel needs --run <id>");
      if (!o.issueId) throw new Error("review-panel needs --issue <DER-id> — the gate is recorded against a unit");
      const shaBad = gateShaRefusal(o.sha, { command: "review-panel", required: true });
      if (shaBad) throw new Error(shaBad);
      const specs = o.lensFile ?? [];
      if (!specs.length) throw new Error(`review-panel needs --lens-file <lens>=<file.json> (repeatable) — the \`claude -p --output-format json\` output of each lens. Suggested panel: ${PANEL_LENS_IDS.join(", ")}.`);

      const requested = [];
      const perLens = {};
      const verdictPerLens = {};
      const modelsObserved = [];
      const providers = [];
      const refusals = [];
      for (const spec of specs) {
        const eq = String(spec).indexOf("=");
        if (eq === -1) throw new Error(`review-panel --lens-file ${JSON.stringify(spec)}: expected <lens>=<file.json>. Binding a file to its lens by name is what keeps a panel auditable — positional order mislabels lenses that finish out of order.`);
        const lens = String(spec).slice(0, eq).trim();
        const file = String(spec).slice(eq + 1).trim();
        if (!lens || !file) throw new Error(`review-panel --lens-file ${JSON.stringify(spec)}: expected <lens>=<file.json>`);
        if (requested.includes(lens)) throw new Error(`review-panel: lens ${JSON.stringify(lens)} was given twice. Redundant reviewers CONCUR — on #1183 the repro lens refuted the security lens and was right; three of the same lens would have agreed and deleted live code.`);
        requested.push(lens);
        let raw = null;
        try { raw = await readFile(resolvePath(file), "utf8"); }
        catch (err) { refusals.push(`${lens}: cannot read ${file} — ${err instanceof Error ? err.message : String(err)}`); continue; }
        const parsed = parsePanelLensOutput({ raw, lens });
        if (!parsed.ok) { refusals.push(parsed.refusal); continue; }
        perLens[lens] = parsed.findings;
        verdictPerLens[lens] = { verdict: parsed.verdict, findings: parsed.findings.length, summary: parsed.summary };
        modelsObserved.push(...parsed.models);
        providers.push(...parsed.providers);
      }
      if (requested.length < PANEL_MIN_LENSES) {
        throw new Error(`review-panel: ${requested.length} lens given; the panel needs at least ${PANEL_MIN_LENSES} DISTINCT lenses (suggested: ${PANEL_LENS_IDS.join(", ")}). A single reviewer is a self-review with extra steps.`);
      }
      // A silent or failed lens is INCOMPLETE, never clean — the same rule `review-swap` enforces, and
      // for the same reason: recording 2-of-3 as a full panel is precisely the 0-finding-reads-as-CLEAN
      // failure the codex gate's own refusal exists to prevent.
      if (refusals.length) {
        throw new Error([
          `review-panel: REFUSING to record — ${refusals.length} of ${requested.length} lens(es) did not return a readable verdict.`,
          ...refusals.map((r) => `  - ${r}`),
          "",
          "A silent lens is INCOMPLETE, never clean. Send it the ultimatum (\"send your findings now, or send INCOMPLETE\") and re-run:",
          "a subagent or shell-out that returned nothing is usually alive and truncating, not dead.",
        ].join("\n"));
      }

      // ── DER-3011 — the round-1 cross-vendor codex pass ───────────────────────────────────────
      // Codex enters as a LENS of this one gate rather than as a second `review_findings` event. A
      // second event would become `latestGateEvent`, and then two blocker counts would exist for one
      // sha with nothing saying which `ready` must believe — while a panel receipt reading `blockers: 0`
      // beside an unaddressed codex P1 is precisely the gate-that-cannot-fail shape. One gate, one sha,
      // one count, and codex's P1s are inside it.
      let codexFindings = null;
      let codexReview = null;
      if (o.codexReview) {
        let payload = null;
        try { payload = JSON.parse(await readFile(resolvePath(o.codexReview), "utf8")); }
        catch (err) { throw new Error(`review-panel --codex-review ${o.codexReview}: ${err instanceof Error ? err.message : String(err)}. It must be the JSON object \`--output-last-message\` wrote (see \`codex-review-schema.json\`). If the pass never ran because codex was walled, 401'd or unresolvable, DROP --codex-review/--codex-log and record \`--codex-waived "<why not>"\` instead — \`codex-probe\` prints the line.`); }
        codexReview = parseCodexReview(payload, { repoRoot: o.repoRoot ?? process.cwd() });
        codexFindings = codexReview.findings.map((f) => ({
          title: f.title, priority: f.priority, confidence: f.confidence,
          file: f.file, line_start: f.line_start, line_end: f.line_end,
          // The schema's `body` IS this reviewer's evidence, and the union keys falsification off it.
          evidence: f.body || null,
        }));
        // The same floor every Claude lens is held to: a finding with no title cannot later be
        // falsified or adjudicated by reference, so it would be a blocker nobody can act on.
        if (codexFindings.some((f) => !f.title)) {
          throw new Error("review-panel --codex-review: a finding has no `title`. Every finding must be referenceable by title — that is how it is later falsified or adjudicated.");
        }
        // Same directional rule the standalone codex gate enforces. It is applied HERE too because the
        // panel path can carry a codex leg, and a false green entering the union as the `codex` lens
        // would read as cross-vendor corroboration of a clean PR.
        {
          const falseGreen = codexFalseGreenRefusal({ verdict: codexReview.verdict, explanation: codexReview.explanation, findings: codexReview.findings });
          if (falseGreen) throw new Error(`review-panel: ${falseGreen}`);
        }
        if (requested.includes(CROSS_VENDOR_LENS)) {
          throw new Error(`review-panel: lens ${JSON.stringify(CROSS_VENDOR_LENS)} was supplied BOTH as --lens-file and as --codex-review. Pick one: recording the same reviewer twice would double its findings in the union and make its agreement count read as corroboration.`);
        }
      }
      let codexLogText = null;
      if (o.codexLog) {
        try { codexLogText = await readFile(resolvePath(o.codexLog), "utf8"); }
        catch (err) { throw new Error(`review-panel --codex-log ${o.codexLog}: ${err instanceof Error ? err.message : String(err)}. Redirect \`codex exec --json\`'s STDOUT to it (stderr goes to a separate file — mixing them destroys the completion evidence). If the pass never ran, record \`--codex-waived "<why not>"\` instead — \`codex-probe\` prints the line.`); }
      }
      // A round is an ORDINAL. `Number.isFinite` accepted `1.5` and `0`, and a fractional or zero round
      // silently defeats the `r <= CROSS_VENDOR_ROUND` comparison the whole round-1 rule turns on —
      // `--round 1.5` is neither round 1 nor a revision round, and `--round 0` reads as round 1 while
      // recording something no reader can order against the others.
      if (o.round !== undefined && !(Number.isInteger(Number(o.round)) && Number(o.round) > 0)) {
        throw new Error(`review-panel: --round ${JSON.stringify(o.roundRaw ?? o.round)} is not a positive integer. Rounds are ordinals — a fractional or zero round cannot be compared against the round-1 rule, and every reader that orders receipts by round would place it arbitrarily.`);
      }
      const panelRound = o.round === undefined ? 1 : Number(o.round);
      // The ledger is read whenever the answer depends on it: a receipt attesting nothing of its own
      // (which inherits) OR one supplying a codex log (whose digest must be checked for replay against
      // every unit in the run). `readEvents` is a whole-ledger parse (~1s on the 100k-event benchmark),
      // so the waiver-only path still skips it.
      const needsPrior = Boolean(o.codexLog) || (!o.codexReview && !o.codexLog && !o.codexWaived);
      const priorEvents = needsPrior ? await readEvents(runDir) : [];
      const xv = crossVendorAttestation({
        round: panelRound,
        sha: o.sha ?? null,
        logPath: o.codexLog ?? null, logText: codexLogText, findings: codexFindings,
        waivedReason: o.codexWaived ?? null,
        priorEvents, issueId: o.issueId,
        // `--dry-run` writes no receipt, so it cannot be silent about one. The PAIRING and PROVENANCE
        // refusals still apply here (a lead must learn that findings-without-JSONL are refused at the
        // dry run, not after the verification pass has already been paid for); only the "round 1 must
        // attest something" rule, which is a statement about the recorded event, is relaxed.
        requireAttestation: !o.dryRun,
      });
      if (!xv.ok) throw new Error(xv.refusal);
      if (codexFindings) {
        // Counted in `lenses_requested`/`lenses_returned` so the receipt's lens list and its findings'
        // `lenses` arrays describe the same panel. NOT pushed into `models_observed` (nothing here
        // measures which model codex ran) nor into `providers` (that field answers "did the panel ride
        // the Claude subscription", and a codex entry would fire that warning on every healthy run).
        requested.push(CROSS_VENDOR_LENS);
        perLens[CROSS_VENDOR_LENS] = codexFindings;
        verdictPerLens[CROSS_VENDOR_LENS] = {
          verdict: codexReview.verdict === "patch is correct" ? "clean"
            : codexReview.verdict === "patch is incorrect" ? "findings"
              : (codexFindings.length ? "findings" : "clean"),
          findings: codexFindings.length,
          summary: codexReview.explanation || null,
        };
      }

      const returned = Object.keys(perLens);
      const union = unionPanelFindings(perLens);

      // `--dry-run` prints the union WITHOUT writing an event. That is what the verification pass reads,
      // so the phase-2 prompt sees exactly the set phase 1 produced — INCLUDING the cross-vendor
      // findings, which is the point of parsing them before this branch: a cross-vendor reviewer's
      // false positives are exactly what the falsification pass exists to kill, and one that could not
      // be falsified would leave a `gate_adjudication` as the only way out of a wrong P1.
      if (o.dryRun) {
        return { stdout: JSON.stringify({ issue: o.issueId, sha: o.sha, lenses: returned, findings: union.findings, dissent: union.dissent }, null, 2) };
      }

      // Phase 2 — falsification. Entries may arrive from the verify shell-out (`--verify-file`, a
      // `claude -p` envelope) or as a plain JSON file (`--falsify`).
      let falsifyEntries = [];
      let verified = false;
      if (o.verifyFile) {
        let vraw = null;
        try { vraw = await readFile(resolvePath(o.verifyFile), "utf8"); }
        catch (err) { throw new Error(`review-panel --verify-file ${o.verifyFile}: ${err instanceof Error ? err.message : String(err)}`); }
        const parsedVerify = parsePanelVerifyOutput({ raw: vraw });
        if (!parsedVerify.ok) {
          throw new Error(`${parsedVerify.refusal}\n\nA verification pass that cannot be read does NOT clear anything. Re-run it, or record the gate without --verify-file: every discovered finding then stands, which is the correct fail-closed answer.`);
        }
        falsifyEntries = parsedVerify.falsified;
        verified = true;
        modelsObserved.push(...parsedVerify.models);
        providers.push(...parsedVerify.providers);
      }
      if (o.falsify) {
        let fraw = null;
        try { fraw = JSON.parse(await readFile(resolvePath(o.falsify), "utf8")); }
        catch (err) { throw new Error(`review-panel --falsify ${o.falsify}: ${err instanceof Error ? err.message : String(err)}`); }
        falsifyEntries = falsifyEntries.concat(Array.isArray(fraw) ? fraw : (Array.isArray(fraw?.falsified) ? fraw.falsified : []));
        verified = true;
      }
      const applied = applyFalsifications({ findings: union.findings, falsify: falsifyEntries });
      if (!applied.ok) throw new Error(applied.refusal);

      // The file set the gate covered. Non-fatal: a bare checkout or a non-git cwd leaves it null,
      // which reads as "not recorded" rather than as "no files".
      let fileSet = null;
      if (o.base || o.diff) {
        if (o.diff) {
          try { fileSet = parseDiffPaths(await readFile(resolvePath(o.diff), "utf8")); } catch { fileSet = null; }
        } else {
          const res = await runCommand({ command: "git", args: ["diff", "--name-only", `${o.base}...HEAD`], cwd: o.repoRoot ?? process.cwd() }).catch(() => null);
          if (res?.exitCode === 0) fileSet = String(res.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
        }
      }

      const ev = reviewPanelEvent({
        issueId: o.issueId, pr: o.pr ?? null, sha: o.sha, base: o.base ?? null, files: fileSet,
        engine: o.engine ?? "claude", model: o.model ?? null,
        modelsObserved, providers,
        lensesRequested: requested, lensesReturned: returned, verdictPerLens,
        findings: applied.findings, falsified: applied.falsified, dissent: union.dissent,
        round: panelRound,
        actor: o.actor ?? null, verified,
        crossVendor: xv.attestation,
      });
      await appendEvent(runDir, ev);

      const lensLine = returned.map((l) => `${l}=${verdictPerLens[l].verdict}(${verdictPerLens[l].findings})`).join(" ");
      // The endpoint check is the DER-2293 question asked of the measurement rather than the request:
      // `provider: "firstParty"` means the lens reached Anthropic directly (the subscription). Anything
      // else means the panel leaked onto a metered endpoint — which is the exact failure the shell-out
      // exists to prevent, and it must be loud rather than inferred later from a bill.
      const offEndpoint = ev.providers.length && !ev.providers.every((p) => p === "firstParty");
      const lines = [
        `review-panel recorded for ${o.issueId}${o.pr ? ` (PR #${o.pr})` : ""} — PRIMARY gate, engine=${ev.engine}${ev.model ? `/${ev.model}` : ""}`,
        `  sha ${o.sha}${ev.files_reviewed == null ? "" : `  ·  ${ev.files_reviewed} file(s)`}`,
        `  lenses ${returned.length}/${requested.length}: ${lensLine}`,
        `  models actually used: ${ev.models_observed.length ? ev.models_observed.join(", ") : "UNKNOWN (no modelUsage in the envelope)"}`,
        `  findings ${ev.findings_total} (blockers ${ev.blockers})${ev.falsified.length ? `, ${ev.falsified.length} falsified with evidence` : ""}${ev.dissent.length ? `, ${ev.dissent.length} priority dissent(s) recorded` : ""} → verdict ${ev.verdict}`,
        `  ${crossVendorLabel(ev.cross_vendor)}`,
      ];
      if (ev.cross_vendor?.status === "waived") {
        lines.push("  ⚠ this PR got ONE reviewer, not two. That is a supported outcome, not a failure — but it is on the receipt, and `ready` prints it.");
      }
      // A BLIND run is the one that needs the warning, and it was the one not getting it. A waived gate
      // is visibly absent; a `ran` with zero repository commands reads as coverage while having
      // reviewed nothing but the diff text — the DER-2504 shape, where codex completed a turn with
      // command_execution=0 and returned fabricated findings.
      if (ev.cross_vendor?.status === "ran" && (ev.cross_vendor.commands ?? 0) === 0) {
        lines.push("  ⚠ the codex gate completed but ran ZERO repository commands — it reviewed the diff BLIND. Measured: a diff-local pass found 0 issues where a searching pass found 6, and a 0-command run has returned wholly fabricated findings (DER-2504). Treat this as UNREVIEWED and re-run it from the worktree.");
      }
      if (ev.cross_vendor?.status === "stale") {
        lines.push(`  ⚠ the codex artifacts recorded here covered ${String(ev.cross_vendor.covered_sha ?? "?").slice(0, 10)}, NOT this tree — recorded as STALE, not as a run against this sha.`);
      }
      if (!verified) {
        lines.push("  ⚠ NO verification pass was recorded (--verify-file / --falsify). Every discovered finding stands.");
      }
      if (offEndpoint) {
        lines.push(`  ⚠ providers=${ev.providers.join(",")} — this panel did NOT ride the Claude subscription. Unset ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY on the lens shell-outs and re-run.`);
      }
      lines.push(
        ev.blockers > 0
          ? "  `ready` will REFUSE this PR until the blockers are fixed and the panel re-run on the new head, or an orchestrator records a gate_adjudication naming each one."
          : "  `ready` accepts this receipt as the review gate while the PR head equals this sha; a push moves the head and the receipt goes stale.",
      );
      for (const f of ev.findings.slice(0, 20)) {
        lines.push(`  P${f.priority ?? "?"} [${(f.lenses ?? []).join("+") || "?"}] ${f.file ?? "?"}:${f.line_start ?? "?"}  ${f.title}`);
      }
      return { event: ev, stdout: lines.join("\n") };
    }

    case "review-swap": {
      // 1.1 — record a SUBSTITUTE adversarial review (posture C: codex bot down AND `codex exec` down).
      //
      // This exists because `review-usage` correctly refuses a findings-shaped payload with no codex
      // JSONL, and that refusal left the substitute gate with no supported path at all — so shepherd #4
      // hand-rolled it and shepherd #5 inherited it as undocumented tribal knowledge. Never hand-write a
      // `review_findings` event: the ledger is append-only with no supersession, so a mis-shaped gate
      // record is permanent, and this command is the only thing that validates the shape.
      if (!runDir) throw new Error("review-swap needs --run <id>");
      if (!o.issueId) throw new Error("review-swap needs --issue <DER-id> — the gate is recorded against a unit");
      const shaBad = gateShaRefusal(o.sha, { command: "review-swap", required: true });
      if (shaBad) throw new Error(shaBad);
      if (!o.verdicts) throw new Error("review-swap needs --verdicts <file.json> — an object keyed by lens name, each carrying {verdict, findings[]}");
      let rawVerdicts;
      try { rawVerdicts = JSON.parse(await readFile(resolvePath(o.verdicts), "utf8")); }
      catch (err) { throw new Error(`review-swap --verdicts ${o.verdicts}: ${err instanceof Error ? err.message : String(err)}`); }

      const lenses = parseLensVerdicts({ raw: rawVerdicts, lensesRequested: o.lens ?? [] });
      if (!lenses.ok) throw new Error(lenses.refusal);

      const ev = reviewSwapEvent({
        issueId: o.issueId, pr: o.pr ?? null, sha: o.sha,
        engine: o.engine ?? "claude", model: o.model ?? null,
        lenses, substituteReason: o.substituteReason ?? null,
        round: Number.isFinite(Number(o.round)) ? Number(o.round) : 1,
        actor: o.actor ?? "shepherd",
      });
      await appendEvent(runDir, ev);
      const lensLine = lenses.returned.map((l) => `${l}=${lenses.verdictPerLens[l].verdict}(${lenses.verdictPerLens[l].findings})`).join(" ");
      return {
        event: ev,
        stdout: [
          `review-swap recorded for ${o.issueId}${o.pr ? ` (PR #${o.pr})` : ""} — SUBSTITUTE gate, engine=${ev.engine}${ev.model ? `/${ev.model}` : ""}`,
          `  sha ${o.sha}`,
          `  lenses ${lenses.returned.length}/${lenses.requested.length}: ${lensLine}`,
          `  findings ${ev.findings_total} (blockers ${ev.blockers}) → verdict ${ev.verdict}`,
          ev.blockers > 0
            ? "  `ready` will REFUSE this PR until the blockers are fixed and the panel re-run, or an orchestrator records a gate_adjudication naming each one."
            : "  `ready` will report gate=SUBSTITUTE with this provenance — it is NOT indistinguishable from a codex run.",
        ].join("\n"),
      };
    }
    case "waive-codex-gate": {
      // 1.3 — a run-level codex waiver that lives in state instead of prose.
      if (!runDir) throw new Error("waive-codex-gate needs --run <id>");
      if (!o.reason) throw new Error("waive-codex-gate needs --reason <text> — an unexplained waiver is indistinguishable from a forgotten one");
      if (!o.until) {
        throw new Error("waive-codex-gate needs --until <iso8601>. A waiver MUST expire by construction — " +
          "an indefinite one is how a run silently stops reviewing. Use the wall's own reset time when you have it " +
          "(e.g. the `You've hit your usage limit … Aug 4th` text), else pick a bounded horizon and re-issue.");
      }
      const untilMs = Date.parse(o.until);
      if (!Number.isFinite(untilMs)) throw new Error(`waive-codex-gate: --until ${JSON.stringify(o.until)} is not a parseable ISO-8601 timestamp`);
      if (untilMs <= Date.now()) throw new Error(`waive-codex-gate: --until ${o.until} is in the PAST — that waiver is expired the moment it is written`);
      const ev = {
        actor: o.actor ?? "orch", type: "codex_gate_waived",
        reason: o.reason, until: new Date(untilMs).toISOString(), ts: new Date().toISOString(),
      };
      await appendEvent(runDir, ev);
      return {
        event: ev,
        stdout: [
          `codex gate WAIVED until ${ev.until} — ${ev.reason}`,
          "  `ready` will stop holding for want of a codex review and print gate=WAIVED instead.",
          "  (Since DER-2360 an adversarial-panel receipt AT HEAD already clears that hold on its own,",
          "   so this waiver is only needed where no local gate ran at all.)",
          "  THE WAIVER DOES NOT WAIVE EVIDENCE: `ready` still refuses any PR with no review_findings",
          "  event covering its head. Record substitute reviews with `review-swap` (3 distinct lenses).",
          "  It expires by construction — after that, `ready` holds again until it is re-issued.",
        ].join("\n"),
      };
    }
    case "review-fidelity": {
      // Shepherd-facing, run AFTER the cloud Codex review lands on a PR:
      //   `… review-fidelity --run <r> --runs-root <p> --issue DER-x --pr 1027`
      // Scores what the local gate caught against what the bot actually posted, and appends the
      // result. This is the only honest way to know whether the gate is worth its wall clock — the
      // design-time samples disagreed by 2x (33% blind vs 75% in-context), so the number has to come
      // from the run, not from an argument.
      if (!o.pr) throw new Error("review-fidelity: --pr <number> is required");
      const fidCwd = o.repoRoot ?? process.cwd();
      const events = await readEvents(runDir);
      const localEvents = events.filter((e) => e.type === "review_findings" && (!o.issueId || e.issue === o.issueId) && (!o.round || e.round === o.round));
      if (!localEvents.length) {
        throw new Error(`review-fidelity: no review_findings event for ${o.issueId ?? "any issue"}${o.round ? ` round ${o.round}` : ""} — the local gate did not run, or ran without \`review-usage\`. Nothing to score.`);
      }
      // Idempotent: re-running must not stack duplicate scores on the ledger (2026-07-25 — a
      // diagnosing orchestrator left two identical events for PR 1014 minutes apart).
      const already = events.find((e) => e.type === "review_fidelity" && e.pr === Number(o.pr) && (o.issueId ? e.issue === o.issueId : true) && (o.round ? e.round === o.round : true));
      if (already && !o.force) {
        return { stdout: `review-fidelity: already scored PR #${o.pr}${o.issueId ? ` (${o.issueId})` : ""} at ${already.ts} — matched ${already.matched}/${already.cloud_total}, preempt_rate ${already.preempt_rate ?? "n/a"}. Pass --force to re-score.` };
      }
      const local = localEvents.flatMap((e) => e.findings ?? []);
      // 🔴 THE DENOMINATOR MUST BE WHAT THE GATE COULD ACTUALLY HAVE PRE-EMPTED. Without this the
      // scorer compares one review against the PR's ENTIRE comment history: on an 8-round PR it
      // reported 1/49 (2%) where 44 of the 49 were findings from earlier rounds that were already
      // FIXED before the gate ever ran. Only comments posted at/after the reviewed tree count.
      // Consequence: `missed_findings` is only a valid source of `## Code Review Rules` once filtered
      // — unfiltered it encodes defect classes that no longer exist.
      const coveredSha = o.sha ?? localEvents.map((e) => e.sha).filter(Boolean).pop() ?? null;
      const res = await runCommand({
        command: "gh",
        args: ["api", `repos/:owner/:repo/pulls/${o.pr}/comments`, "--paginate", "--jq",
          '.[]|select(.user.login|test("codex";"i"))|{path,line,original_line,commit_id,original_commit_id,body}'],
        cwd: fidCwd,
      });
      const cloudAll = String(res.stdout ?? "").split("\n").filter(Boolean).map((l) => {
        try {
          const c = JSON.parse(l);
          // A null `.line` means GitHub considers the comment outdated vs HEAD — keep it (it still
          // shows what the bot looked at) but leave it unanchored so the scorer matches on file only.
          return {
            file: c.path, line: c.line ?? c.original_line ?? null,
            // `original_commit_id` is the sha the bot ACTUALLY reviewed; `commit_id` drifts forward
            // as the PR is updated, so it is only a fallback.
            sha: c.original_commit_id ?? c.commit_id ?? null,
            title: String(c.body ?? "").replace(/\s+/g, " ").slice(0, 120),
          };
        } catch { return null; }
      }).filter(Boolean);
      // Match on the REVIEWED SHA, not on a timestamp. An earlier version of this filter compared
      // ISO strings lexicographically — `…18:22:41Z` vs a `…13:31:08-05:00` cutoff — which silently
      // admitted the wrong comments and produced another confident-but-wrong rate. Sha equality is
      // exact and needs no timezone reasoning: a bot comment is pre-emptable iff the bot was looking
      // at the same tree the gate was.
      const cloud = coveredSha ? cloudAll.filter((c) => c.sha && (c.sha === coveredSha || coveredSha.startsWith(c.sha) || c.sha.startsWith(coveredSha))) : cloudAll;
      const dropped = cloudAll.length - cloud.length;
      const cutoff = coveredSha ? `sha:${coveredSha.slice(0, 9)}` : null;
      // Refuse to invent a rate rather than print a confident wrong one. A gate that ran on a head
      // the bot never reviewed is UNSCORED, not 0%-effective — and "2%" reads as a verdict on the
      // gate when it is really a verdict on the comparison.
      if (!cloud.length) {
        const why = !coveredSha
          ? `the review_findings event carries no \`sha\` (recorded by an older review-usage) — re-run the gate, or pass --sha`
          : `the bot NEVER REVIEWED the tree the gate covered (${coveredSha.slice(0, 9)}); it reviewed ${dropped} comment(s) on OTHER shas, none of which the gate had a chance to pre-empt`;
        return { stdout: `PR #${o.pr} — NOT SCOREABLE: ${why}. No preempt_rate recorded; do NOT mine the earlier comments for \`## Code Review Rules\` (they are already-fixed findings from prior rounds).` };
      }
      const score = scoreReviewFidelity({ local, cloud });
      const ev = {
        actor: "shepherd", type: "review_fidelity", issue: o.issueId ?? null, pr: Number(o.pr),
        ...score, reviewer: localEvents[0].reviewer ?? "codex",
        sha: coveredSha ?? null, cutoff, excluded_before_cutoff: dropped,
        round: o.round ?? localEvents[localEvents.length - 1].round ?? null,
        ts: new Date().toISOString(),
      };
      await appendEvent(runDir, ev);
      const pct = score.preempt_rate == null ? "n/a (cloud posted nothing)" : `${Math.round(score.preempt_rate * 100)}%`;
      const missed = score.missed_findings.map((c) => `  MISSED  ${c.file}:${c.line ?? "?"}  ${c.title.slice(0, 90)}`);
      const novel = score.novel_findings.map((l) => `  NOVEL   ${l.file}:${l.line_start ?? "?"}  ${l.title.slice(0, 90)}`);
      return {
        stdout: [
          `PR #${o.pr} — local gate pre-empted ${score.matched}/${score.cloud_total} cloud findings (${pct}); ${score.novel} novel.`,
          coveredSha ? `  scored against tree ${coveredSha.slice(0, 9)}${dropped ? ` — ${dropped} earlier comment(s) excluded as un-pre-emptable` : ""}` : `  ⚠ no sha on the review_findings event — denominator is UNFILTERED and the rate is not trustworthy`,
          ...missed, ...novel,
        ].join("\n"),
        event: ev,
      };
    }
    case "spawn-shepherd": {
      assertNotRoot("spawn the shepherd");
      const name = workspaceName("shepherd", { project: o.project ?? "work" });
      const cwd = o.worktree ?? o.repoRoot ?? process.cwd();
      // A shepherd rotation replaces the incumbent — close its workspace here so the rotation flow
      // is one call and the old pane can't leak (2026-07-26: re-launched shepherds accumulated).
      if (!o.dryRun && runDir) {
        const prior = (await readEvents(runDir)).filter((e) => e?.type === "shepherd_spawned" && e.workspace_ref);
        for (const e of prior) {
          await runCommand({ command: cmuxBin(), args: ["close-workspace", "--workspace", e.workspace_ref] });
        }
      }
      // Model precedence: explicit --model > config shepherdModel > "opus" default.
      const { command, args, launch } = buildShepherdBootCommand({ name, cwd, runId: o.runId, runDir, model: o.model ?? getShepherdModel() ?? "opus" });
      const line = `${command} ${args.map(shellQuote).join(" ")}`;
      let ref = null;
      if (!o.dryRun) {
        const res = await runCommand({ command: cmuxBin(), args });
        // DER-2739. A phantom shepherd_spawned is not harmless: it clears shepherd_rotate_pending, so a
        // rotation the shepherd asked for would be marked done while the incumbent — whose workspace this
        // path just CLOSED — is gone. The run then has no shepherd and nothing says so.
        const outcome = spawnOutcome(res);
        if (!outcome.ok) await refuseUnprovenSpawn({ runDir, role: "shepherd", label: "spawn-shepherd", outcome });
        ref = outcome.ref;
        // 4.2 — name WHICH shepherd this is. Counted from the ledger, so it needs no coordination
        // between the outgoing and incoming instance and stays stable on replay.
        const priorShepherds = (await readEvents(runDir)).filter((e) => e?.type === "shepherd_spawned").length;
        await appendEvent(runDir, {
          actor: "orch", type: "shepherd_spawned", workspace_ref: ref,
          instance: actorInstance("shepherd", priorShepherds),
          transcripts_forced: launchForcesTranscripts(launch),
        });
      }
      return { stdout: line, workspace_ref: ref, dryRun: !!o.dryRun };
    }
    case "staleness-check": {
      // 2.7 — run at DISPATCH time, per queued unit, against current main.
      if (!runDir) throw new Error("staleness-check needs --run <id>");
      const st = materializeState(await readEvents(runDir), { run_id: o.runId });
      const repoRootSC = o.repoRoot ?? process.cwd();
      // Symbols come from --symbol (repeatable, reusing --lens's accumulate shape is wrong here, so its
      // own flag) or from each queued unit's recorded fileScope basenames as a weak fallback.
      const queued = o.issueId ? [o.issueId] : (st.queue ?? []);
      if (!queued.length) return { stdout: "staleness-check: nothing queued — no unit to check." };
      const out = [];
      const results = [];
      for (const id of queued) {
        const symbols = (o.symbol ?? []).length ? o.symbol : [id];
        out.push(`${id}:`);
        for (const sym of symbols) {
          const res = await runCommand({ command: "git", args: stalenessCommand(sym), cwd: repoRootSC, timeoutMs: 30000 }).catch(() => ({ exitCode: 1, stdout: "" }));
          if (res.exitCode !== 0) {
            // UNKNOWN, not clean. A git that could not answer must never read as "no prior work".
            out.push(`  ⚠️  ${sym} — UNKNOWN: git log -S failed. This is NOT evidence the work is undone.`);
            results.push({ issue: id, symbol: sym, state: "unknown" });
            continue;
          }
          const hits = String(res.stdout ?? "").trim().split("\n").filter(Boolean).slice(0, 10);
          const v = stalenessVerdict({ symbol: sym, hits });
          results.push({ issue: id, ...v });
          out.push(`  ${v.stale ? "🔴" : "✅"} ${sym} — ${v.note}`);
          for (const h of hits) out.push(`      ${h}`);
        }
      }
      const stale = results.filter((r) => r.stale);
      out.push("", stale.length
        ? `⚠ ${stale.length} symbol(s) already landed on main. Read the call site / action list before dispatching — a symbol's presence is not the feature's presence.`
        : "no queued symbol has landed on main.");
      return { results, stdout: out.join("\n") };
    }
    case "rotate-shepherd": {
      // 4.1 — checkpoint → render successor brief → spawn (which VERIFIES) → confirm the event landed.
      // Mirrors rotate-lead. Without it, `spawn-shepherd` alone silently drops in-flight reasoning.
      assertNotRoot("rotate the shepherd");
      if (!runDir) throw new Error("rotate-shepherd needs --run <id>");
      const events = await readEvents(runDir);
      const st = materializeState(events, { run_id: o.runId });
      const priorShepherds = events.filter((e) => e?.type === "shepherd_spawned").length;
      const instance = actorInstance("shepherd", priorShepherds);

      // 1. Checkpoint. The notes file is the shepherd's own convention; read it rather than requiring
      // the outgoing instance to pass its state through argv (it is usually mid-turn when it rotates).
      const notesPath = join(runDir, "shepherd-notes.md");
      let notes = null;
      try { notes = await readFile(notesPath, "utf8"); } catch { /* absent — the brief says so LOUDLY */ }

      // 2. Render the successor brief. Written to disk BEFORE the spawn, so a spawn that fails still
      // leaves the handoff on record — the predecessor is already standing down either way.
      const openPrs = Object.entries(st.issues)
        .filter(([, v]) => v.pr != null && ACTIVE_STATUSES.has(v.status))
        .map(([issue, v]) => ({ issue, pr: v.pr, status: v.status }));
      const brief = renderShepherdRotationBrief({
        runId: o.runId, instance, notes, openPrs,
        waiver: st.codex_waiver,
        pending: {
          kickbacks_pending: st.kickbacks_pending ?? [],
          gate_missing: (st.gate_missing ?? []).map((g) => `${g.issue} (PR #${g.pr})`),
          gate_blocked: (st.gate_blocked ?? []).map((g) => `${g.issue} (PR #${g.pr}, blockers ${g.blockers})`),
          reap_failures: (st.reap_failures ?? []).filter((f) => !f.retracted).map((f) => f.label),
        },
      });
      const briefPath = join(runDir, "briefs", `shepherd.rot${priorShepherds}.md`);
      if (!o.dryRun) {
        await mkdir(dirname(briefPath), { recursive: true });
        await writeFile(briefPath, brief, "utf8");
        await appendEvent(runDir, {
          actor: "orch", type: "shepherd_rotated", instance, brief: briefPath,
          notes_present: Boolean(notes && notes.trim()),
          open_prs: openPrs.length, ts: new Date().toISOString(),
        });
      }

      // 3. Spawn — reusing spawn-shepherd so the DER-2739 unproven-spawn refusal applies unchanged. A
      // rotation that recorded a phantom successor would leave the run with NO shepherd and a ledger
      // saying it has one, which is strictly worse than not rotating.
      const spawned = await runSubcommand([
        "spawn-shepherd", "--run", o.runId, "--runs-root", runsRoot,
        ...(o.repoRoot ? ["--repo-root", o.repoRoot] : []),
        ...(o.project ? ["--project", o.project] : []),
        ...(o.model ? ["--model", o.model] : []),
        ...(o.dryRun ? ["--dry-run"] : []),
      ]);

      // 4. Verify the event actually landed, rather than trusting step 3's return.
      let confirmed = o.dryRun;
      if (!o.dryRun) {
        confirmed = (await readEvents(runDir)).filter((e) => e?.type === "shepherd_spawned").length > priorShepherds;
        if (!confirmed) {
          throw new Error(`rotate-shepherd: spawn-shepherd returned but NO new shepherd_spawned event is in the ledger — ` +
            `the run may now have no shepherd. The successor brief IS written (${briefPath}); re-run spawn-shepherd and check cmux.`);
        }
      }
      return {
        instance, brief: briefPath, confirmed,
        stdout: [
          `rotate-shepherd → ${instance}${o.dryRun ? " [dry-run]" : ""}`,
          `  brief: ${briefPath}${notes && notes.trim() ? "" : "   ⚠ NO checkpoint notes were found — the brief tells the successor to treat in-flight beliefs as LOST"}`,
          `  carried: ${openPrs.length} open PR(s)`,
          `  ${spawned.stdout ?? ""}`.trimEnd(),
        ].join("\n"),
      };
    }
    case "spawn-orch": {
      assertNotRoot("spawn a successor orchestrator");
      const name = workspaceName("orch", { project: o.project ?? "work" });
      const cwd = o.worktree ?? o.repoRoot ?? process.cwd();
      const { command, args, launch } = buildOrchBootCommand({ name, cwd, runId: o.runId, runDir, model: o.model ?? null });
      const line = `${command} ${args.map(shellQuote).join(" ")}`;
      let ref = null;
      if (!o.dryRun) {
        const res = await runCommand({ command: cmuxBin(), args });
        // DER-2739. This is the worst of the four to get wrong: the OUTGOING orchestrator boots its
        // successor and then stands down. A recorded-but-failed launch means the run has no brain, and the
        // ledger says it does.
        const outcome = spawnOutcome(res);
        if (!outcome.ok) await refuseUnprovenSpawn({ runDir, role: "orch", label: "spawn-orch", outcome });
        ref = outcome.ref;
        await appendEvent(runDir, { actor: "orch", type: "orch_spawned", workspace_ref: ref, transcripts_forced: launchForcesTranscripts(launch) });
      }
      return { stdout: line, workspace_ref: ref, dryRun: !!o.dryRun };
    }
    case "append": {
      const event = JSON.parse(o.rest[0] ?? o.event ?? "{}");
      // DER-2782 — `gate_adjudication` is one of TWO types this generic relay validates before writing
      // (DER-2837 added `review_findings` for the same reason), and deliberately not by growing a new
      // privileged path: between them they are the only events that can turn a blocking gate into a
      // passing one, so a malformed one must fail HERE rather than be silently ignored at `ready` while
      // the operator wonders why their PR is still held.
      //
      // This is an affordance, NOT the enforcement. The enforcement is the read side —
      // `gateEvidenceLookup` and the `materializeState` fold re-run the same contract — because anyone
      // who can bypass this check by appending to events.jsonl directly never needed the subcommand.
      // RELAYED lines (already carrying an `event_id` minted by their origin host) skip the check for
      // that reason: refusing a relay would fork the ledger, and the read side still ignores a bad one.
      const relayed = typeof event?.event_id === "string" && event.event_id.length > 0;
      // DER-2837 — a gate event whose `blockers` count disagrees with its own findings list is not
      // evidence, and the write side says so at the moment it is authored. The read side refuses it
      // anyway (that is where the enforcement lives — see below), but a lead that hand-appends one and
      // learns nothing until `ready` holds its PR has been given a puzzle instead of an error.
      if (event?.type === "review_findings" && !relayed) {
        const count = gateBlockerCountVerdict(event);
        if (!count.ok) {
          const what = count.kind === "unreadable" ? count.reason : `it ${count.reason}`;
          throw new Error(
            `append: refusing to record this review_findings${event.issue ? ` for ${event.issue}` : ""} — ${what}.\n` +
            "A gate event that disagrees with itself is not evidence: an UNDER-count would authorize a merge over an open blocker, " +
            "and no gate_adjudication can waive a finding the count denies. Re-run the gate (`review-usage`) rather than hand-writing the event.",
          );
        }
      }
      // DER-2838 — the RUN's terminal state is reserved the same way, and for the same reason: it is the
      // one event that turns a gated question ("is every unit terminal, is the ledger clean, is the wire
      // protocol sound?") into a settled answer, and this relay ran none of those checks. Same relay
      // carve-out, same reasoning as above: a line minted elsewhere is passed through rather than
      // refused (refusing forks the ledger), and the read side ignores a bad one either way — a relayed
      // marker still has to carry a receipt the fold accepts.
      if (event?.type === "run_completed" && !relayed) {
        throw new Error(`append: refusing to write a \`run_completed\` event.\n${RUN_COMPLETED_RESERVED}`);
      }
      if (event?.type === "gate_adjudication" && !relayed) {
        if (!event.issue) {
          throw new Error(`append: a gate_adjudication must name its \`issue\` — an unattributed waiver could be read against any unit.\n${GATE_ADJUDICATION_AUTHORITY}`);
        }
        const gate = latestGateEvent(await readEvents(runDir), event.issue);
        const v = gateAdjudicationVerdict({ gate, adjudication: event });
        if (!v.ok) {
          throw new Error(`append: refusing to record this gate_adjudication for ${event.issue} — ${v.reason}.\n${GATE_ADJUDICATION_AUTHORITY}`);
        }
        const ev = await appendEvent(runDir, event);
        return {
          stdout: [
            `⚠ GATE ADJUDICATION RECORDED — ${event.issue}: ${v.waived.length} finding(s) WAIVED by ${v.by} at ${String(v.sha).slice(0, 10)}`,
            ...v.waived.map((t) => `    · ${t}`),
            `  rationale: ${v.rationale}`,
            `  ${GATE_ADJUDICATION_AUTHORITY}`,
            "  This now prints on this PR's `ready` line, in state.gate_adjudicated, and on every watch wake.",
          ].join("\n"),
          event: ev,
          adjudication: v,
        };
      }
      await appendEvent(runDir, event);
      return { stdout: "ok" };
    }
    // DER-2748 — a host says, in the ledger, which harness code it is running. `run_started` covers the
    // host that opened the run; every OTHER host (a mini reached over ssh, a successor orchestrator) only
    // ever appends lifecycle events and would otherwise never declare a version, which is precisely the
    // blind spot that let two hosts fold one ledger with different code. Run this once per host per run
    // (e.g. right after `create-worktree --host mini`), and again after upgrading a host mid-run.
    // The version stamped is the APPENDING process's own reading of VERSION — never a payload claim.
    //
    // RUN IT ON THE HOST. `--host` is a LABEL; the attestation is about whichever machine executes this
    // line. `ssh mini 'node ~/.claude/skills/work/work-runner.mjs heartbeat --run <r> --host mini …'` —
    // the mini writes it to its own ledger and `pull-host` relays it with its identity intact. Running
    // `heartbeat --host mini` locally records the LOCAL version under the mini's label; that is a
    // mislabel, not a forgery, and it stays visible in `state.protocol.harness_version_sources`, where
    // the `source_id` names the machine that actually appended it.
    case "heartbeat": {
      const ev = await appendEvent(runDir, {
        actor: o.actor ?? "orch", type: "host_heartbeat",
        host: o.host ?? "local",
        ...(o.note ? { note: o.note } : {}),
      });
      const verdict = ledgerProtocolVerdict(await readEvents(runDir));
      return {
        stdout: `${ev.host} ${ev.harness_version}${verdict.ok ? "" : `\n${verdict.reasons.map((r) => `WARNING: ${r}`).join("\n")}`}`,
        host: ev.host, harnessVersion: ev.harness_version, schemaVersion: ev.schema_version, protocol: verdict,
      };
    }
    case "state": {
      const events = await readEvents(runDir);
      // readEvents FIRST, then health: the health record describes the read that just happened.
      const state = materializeState(events, { run_id: o.runId, project: o.project, ledger: await readLedgerHealth(runDir) });
      const out = `${JSON.stringify(state, null, 2)}\n`;
      await writeFile(join(runDir, "state.json"), out, "utf8");
      return { stdout: out.trimEnd(), state };
    }
    case "budget": {
      // Per-issue circuit breaker (2026-07-25). Run this EVERY poll cycle — it is the only thing that
      // makes a runaway issue visible in flight rather than in the post-mortem. Exits 3 when anything
      // is tripped so a shell loop can gate on it.
      const events = await readEvents(runDir);
      const state = materializeState(events, { run_id: o.runId, project: o.project });
      const trips = state.budget_trips ?? [];
      const missing = state.plan_scope_missing ?? [];
      const overPlan = state.plan_scope_over ?? [];
      const fmt = (n) => n.toLocaleString("en-US");
      const rows = Object.entries(state.issues ?? {})
        .filter(([, v]) => !DONE_STATUSES.has(v.status))
        .sort((a, b) => b[1].tokens - a[1].tokens);
      // DER-2585: the honest ratio is DELIVERED vs ASSIGNED. Declared-vs-assigned (plan_scope_over) is
      // still the earliest signal — it fires before a line is written — but it only catches a lead that
      // declares honestly. This catches the rest, and it is the number `prep-runner calibrate` consumes.
      const budgetRepoRoot = o.repoRoot ?? process.cwd();
      const delivered = new Map();
      for (const [id, v] of rows) {
        if (v.pr == null || !v.assigned) continue;
        const d = await deliveredVsAssigned({ pr: v.pr, assigned: v.assigned, repoRoot: budgetRepoRoot });
        if (d) delivered.set(id, d);
      }
      const x = (r) => (r == null ? "—" : `${r.toFixed(1)}×`);
      const overDelivered = [...delivered.entries()].filter(([, d]) => d.over);
      const md = [
        `# Per-issue budget — ${o.runId ?? "run"}`,
        ``,
        `Ceilings: warn ${(BUDGET.warnTokens / 1e6).toFixed(0)}M tok / ${BUDGET.warnRounds} rounds · **trip ${(BUDGET.tripTokens / 1e6).toFixed(0)}M tok / ${BUDGET.tripRounds} rounds**`,
        ``,
        `| Issue | PR | Status | Tokens | Rounds | Files declared / assigned | Delivered vs assigned | Budget |`,
        `|---|---:|---|---:|---:|---:|---|---|`,
        ...rows.map(([id, v]) => {
          const d = delivered.get(id);
          const dCell = d
            ? `${d.additions} adds ${x(d.additionsRatio)} · ${d.files} files ${x(d.filesRatio)}${d.over ? " 🔴" : ""}`
            : (v.pr != null && v.assigned ? "unknown (gh read failed)" : "—");
          return `| ${id} | ${v.pr ?? "—"} | ${v.status} | ${fmt(v.tokens)} | ${v.kickback_count} | ${v.plan_scope_seen ? v.fileScope.length : "**none declared**"}${v.assigned ? ` / ${v.assigned.files}` : ""} | ${dCell} | ${v.budget === "tripped" ? "🔴 TRIPPED" : v.budget === "warn" ? "🟠 warn" : "🟢 ok"}${v.plan_scope_over ? " · 📐 over plan" : ""} |`;
        }),
        ``,
        ...(trips.length
          ? [
              `## 🔴 Act on these BEFORE dispatching anything new`,
              ``,
              ...trips.map((t) => `- **${t.issue}**${t.pr ? ` (PR #${t.pr})` : ""} — ${t.level.toUpperCase()}: ${t.reason}`),
              ``,
              `A trip is a DECISION POINT, not an auto-kill — and **the ORCHESTRATOR decides it, never the operator.** These trip overnight; a run that waits on a human is a run that is stopped. Pick one, append an \`orch_note\` saying which and why, and keep driving:`,
              `1. **SPLIT — this is the DEFAULT. Take it unless you have a specific reason not to.** Merge what is green, carve the unfinished remainder into a NEW Linear issue carrying the open findings verbatim, and move on. Always available, never blocks.`,
              `2. **Re-scope** — cut the acceptance criteria to what the current diff already satisfies, note the cut in the PR body, merge.`,
              `3. **Park** — stop dispatching this issue, set it Blocked in Linear with the spend/rounds/open-findings as a comment, and give the slot to other work. Use when neither a split nor a re-scope yields anything mergeable.`,
              `**Do NOT wait for the operator.** Record the decision in the ledger and in the issue; the operator reads it after the run. Never simply dispatch another round on a tripped issue — that is exactly how one issue reached 922M tokens and 9 respawns without merging.`,
            ]
          : [`_No issue is at or over its ceiling._`]),
        ``,
        ...(missing.length
          ? [`## ⚠️ No declared file scope`, ``, ...missing.map((m) => `- **${m}** — never emitted \`plan_scope\`. Require one before the next push; an undeclared unit is an unbounded one.`)]
          : []),
        ...(overPlan.length
          ? [
              ``,
              `## 📐 Declared scope exceeds the ASSIGNED budget`,
              ``,
              ...overPlan.map((p) => `- **${p.issue}**${p.pr ? ` (PR #${p.pr})` : ""} — ${p.reason}.`),
              ``,
              `The lead's own plan says this unit is bigger than the pre-run sizing assumed — the earliest and cheapest possible split signal, before a line is written. Split it now (carve the remainder into a new Linear issue and re-brief), or record an explicit \`orch_note\` accepting the overrun and why. Do not just let it build: above 2.6k additions the measured cost is ~3.4 review rounds versus 1.25 under 1k.`,
            ]
          : []),
        ...(overDelivered.length
          ? [
              ``,
              `## 🔴 DELIVERED size exceeds the ASSIGNED budget (DER-2585)`,
              ``,
              ...overDelivered.map(([id, d]) => {
                const v = state.issues[id];
                return `- **${id}** (PR #${v.pr}) — delivered **${d.additions} additions / ${d.files} files** against an assigned **${v.assigned.additions} / ${v.assigned.files}** (**${x(d.additionsRatio)} additions, ${x(d.filesRatio)} files**).`;
              }),
              ``,
              `**SPLIT IS THE DEFAULT for a new overrun on a new round — accepting is the exception and must be written down.** On run 20260727T004346Z every one of 18 overruns was accepted by standing ruling, and the run's PRs that MET budget took **0.17** kickbacks each while the ones that busted it took **1.6–2.5**. Six budget-conforming PRs produced 1 of that run's 36 kickbacks. Accepting an overrun is choosing the 10× kickback rate; do it only with a reason in an \`orch_note\`.`,
              ``,
              `Feed these numbers back into sizing after the run — that is what closes the loop:`,
              `\`\`\`bash`,
              `node ~/.claude/skills/prep-for-work/prep-runner.mjs calibrate <plan.json> --actuals <actuals.json>`,
              `\`\`\``,
            ]
          : []),
      ].join("\n");
      await writeFile(join(runDir, "budget.md"), `${md}\n`, "utf8");
      return {
        stdout: md, trips, plan_scope_missing: missing, plan_scope_over: overPlan,
        delivered_over: overDelivered.map(([issue, d]) => ({ issue, ...d })),
        exitCode: trips.some((t) => t.level === "tripped") ? 3 : 0,
      };
    }
    case "usage": {
      // Token-usage rollup (2026-07-16). `usage --run <id>` folds one run's token_usage events,
      // writes <run-dir>/usage.json + usage.md, and prints the markdown (paste into the end-of-run
      // report). `usage --all` sweeps every run dir under runsRoot for the fleet view.
      if (o.all) {
        const { readdir } = await import("node:fs/promises");
        let dirs = [];
        try { dirs = (await readdir(runsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { /* empty root */ }
        const perRun = [];
        const allEvents = [];
        for (const d of dirs) {
          const evs = await readEvents(join(runsRoot, d));
          const usageEvents = evs.filter((e) => e && e.type === "token_usage");
          if (!usageEvents.length) continue;
          allEvents.push(...usageEvents);
          const agg = aggregateTokenUsage(usageEvents);
          perRun.push({ run: d, reports: agg.reports, total_tokens: agg.total_tokens, cost_usd_estimate: agg.cost_usd_estimate });
        }
        const grand = aggregateTokenUsage(allEvents);
        const fmt = (n) => n.toLocaleString("en-US");
        const md = [
          `# Fleet token usage — ${perRun.length} runs with telemetry`, ``,
          `| Run | Reports | Total tokens | Est. cost |`, `|---|---:|---:|---:|`,
          ...perRun.map((r) => `| ${r.run} | ${r.reports} | ${fmt(r.total_tokens)} | ${r.cost_usd_estimate != null ? `$${r.cost_usd_estimate.toFixed(2)}` : "n/a"} |`),
          ``, renderUsageMd(grand, { runId: "ALL RUNS" }),
        ].join("\n");
        return { stdout: md, aggregate: grand, runs: perRun };
      }
      const events = await readEvents(runDir);
      const agg = aggregateTokenUsage(events);
      // 5.3 — derive the STRUCTURAL gaps from the ledger itself, so the floor is measured rather than
      // remembered. `comment_rejected` is what reconcile-pr-events appends when an untrusted author's
      // report is refused; `pull_failed` (latched, cleared by the next good pull) names a host whose
      // leads are contributing zero because nothing could be read, not because they spent nothing.
      const st = materializeState(events, { run_id: o.runId });
      const rejected = events.filter((e) => e?.type === "comment_rejected" || e?.type === "report_rejected");
      const md = renderUsageMd(agg, {
        runId: o.runId,
        droppedReports: rejected.length,
        droppedAuthors: [...new Set(rejected.map((e) => e.author).filter(Boolean))],
        undrainedHosts: (st.pull_failed ?? []).map((p) => (typeof p === "string" ? p : p.host)).filter(Boolean),
      });
      await writeFile(join(runDir, "usage.json"), `${JSON.stringify(agg, null, 2)}\n`, "utf8");
      await writeFile(join(runDir, "usage.md"), md, "utf8");
      return { stdout: md, aggregate: agg };
    }
    case "metrics": {
      // Run-quality metrics (T2.2-lite, DER-2007): kickback rate, time-to-merge, tokens-per-merged-PR,
      // cross-run trend. Thin passthrough to the standalone work-metrics.mjs — spawned as a child, not
      // imported, so that module stays zero-import and its fold can't quietly couple to this file's
      // internals. `metrics --run <id>` / `metrics --all` (+ optional --out <file>); call
      // work-metrics.mjs directly for --json (this parser's generic flag fallback eats bare booleans).
      const { execFileSync } = await import("node:child_process");
      const script = fileURLToPath(new URL("./work-metrics.mjs", import.meta.url));
      if (!o.all && !runDir) throw new Error("metrics needs --run <id> or --all");
      const args = o.all ? ["--all", "--runs-root", runsRoot] : ["--run", runDir];
      if (o.out) args.push("--out", o.out);
      return { stdout: execFileSync(process.execPath, [script, ...args], { encoding: "utf8" }).trimEnd() };
    }
    case "lead-context": {
      // Mode 1 — pure single-worktree probe, no ledger required. This is exactly what runs over ssh on
      // the mini (the skills are already synced there), which is why remote support needed no new
      // transport: the same code path, executed on the host that owns the transcripts.
      if (o.worktree) {
        const ltCfg = o.leadType ? (getLeadTypes()[o.leadType] ?? {}) : {};
        const reading = await probeWorktreeContext(o.worktree, { leadTypeCfg: ltCfg, windowOverride: o.window });
        return { stdout: JSON.stringify(reading), reading };
      }
      if (!runDir) throw new Error("lead-context needs --run <id> (or --worktree <path> for a single probe)");
      const events = await readEvents(runDir);
      const state = materializeState(events, { run_id: o.runId });
      const hosts = getHosts();
      const leadTypes = getLeadTypes();
      const repoRootForGh = o.repoRoot ?? process.cwd();
      // Process-liveness check (DER-2516). The transcript OUTLIVES the process, so a context reading
      // alone renders a dead lead as a healthy percentage — and H1's reconcile heartbeat meant every
      // other instrument lied the same way. This is the one probe that can return "dead": match the
      // lead's brief path in live process args (the same pattern reap/rotate pkill by).
      const probeProcess = async (issue, hostCfg) => {
        if (hostCfg) {
          // DER-2775: bracket-escaped, same as the teardown probes. Un-escaped, this shape reports
          // "alive" for EVERY lead on a procps host — the shell ssh spawned carries the pattern in its
          // own cmdline and procps pgrep excludes only itself, so the probe matched itself. That reads as
          // universal health, which is the direction that keeps a dead lead invisible.
          const pat = leadBriefPattern({ runDir: `${hostCfg.ledgerRoot}/${o.runId}`, issueId: issue });
          const res = await runCommand({ command: "ssh", args: [hostCfg.ssh, presenceProbeCommand(pat)] });
          // classifyKillProbe's verdicts map 1:1 onto this probe's — it is the same RC contract, minus
          // the kill: `survivor` here just means the lead is alive, which is the healthy answer.
          const v = classifyKillProbe(res);
          return v === "survivor" ? "alive" : v === "killed" ? "dead" : "unknown";
        }
        // Local: `pgrep` is spawned directly (no intermediate shell holding the pattern), so only pgrep
        // itself could match — and every family excludes itself. Escaped anyway: the two branches must
        // not be able to drift into meaning different things.
        const res = await runCommand({ command: "pgrep", args: ["-f", bracketEscapePattern(leadBriefPattern({ runDir, issueId: issue }))] });
        return res.exitCode === 0 ? "alive" : res.exitCode === 1 ? "dead" : "unknown";
      };
      const readings = [];
      for (const [issue, it] of Object.entries(state.issues)) {
        if (!LIVE_LEAD_STATUSES.has(it.status) || !it.worktree) continue;
        const host = it.host ?? "local";
        const hostCfg = host === "local" ? null : hosts[host];
        const ltName = it.leadType ?? "claude";
        if (hostCfg?.kind === "cloud") {
          // No transcript OR process access to a cloud session (H9) — the ONLY liveness signal is
          // head-SHA movement, never event frequency (reconcile can manufacture events for a corpse).
          // Report the last push age so the orchestrator can apply a movement deadline.
          const reading = { issue, host, pollable: false, process: "unknown", note: "cloud lead — no transcript access; liveness = head-SHA movement ONLY (H9), rotation is request-only" };
          if (it.pr != null) {
            const res = await runCommand({ command: "gh", args: ["pr", "view", String(it.pr), "--json", "headRefOid,commits"], cwd: repoRootForGh });
            try {
              const d = JSON.parse(res.stdout || "{}");
              const last = Array.isArray(d.commits) && d.commits.length ? d.commits[d.commits.length - 1].committedDate : null;
              reading.headSha = d.headRefOid ?? null;
              reading.lastPush = last;
              if (last) reading.lastPushMin = Math.round((Date.now() - Date.parse(last)) / 60000);
            } catch { /* gh failed — reading stays movement-unknown */ }
          }
          readings.push(reading);
          continue;
        }
        if (hostCfg) {
          const { command, args } = remoteProbeCommand({ ssh: hostCfg.ssh, worktree: it.worktree, leadType: ltName, repoRoot: hostCfg.repo });
          const res = await runCommand({ command, args });
          let parsed = null;
          try { parsed = JSON.parse(String(res.stdout ?? "").trim().split("\n").pop() ?? ""); } catch { /* probe failed — reported below */ }
          const process_ = await probeProcess(issue, hostCfg);
          readings.push(parsed ? { issue, host, leadType: ltName, process: process_, ...parsed } : { issue, host, leadType: ltName, process: process_, transcript: null, band: "none", subagents: [], note: `remote probe failed on ${host}` });
          continue;
        }
        readings.push({ issue, host, leadType: ltName, process: await probeProcess(issue, null), ...(await probeWorktreeContext(it.worktree, { leadTypeCfg: leadTypes[ltName] ?? {} })) });
      }

      // --emit turns a transient reading into DURABLE state. Without it a rotate-band reading is lost
      // between wakes — the same way un-surfaced kickbacks rotted for ~50 min on an earlier run.
      const emitted = [];
      if (o.emit) {
        const pending = new Set((state.lead_rotate_pending ?? []).map((r) => r.issue));
        const hotSeen = new Set(events.filter((e) => e?.type === "subagent_hot").map((e) => `${e.issue}:${e.agent}`));
        const unreadableSeen = new Set(
          events.filter((e) => e?.type === "lead_context_unreadable").map((e) => `${e.issue}:${e.note ?? ""}`),
        );
        const deadSeen = new Set(
          events.filter((e) => e?.type === "lead_process_dead").map((e) => `${e.issue}:${e.workspace_ref ?? ""}`),
        );
        for (const r of readings) {
          // A dead process on an in-flight lead is DURABLE state (DER-2516) — the transcript-based
          // fields on the same reading are stale by definition. Deduped per (issue, workspace_ref)
          // so a persistent corpse doesn't spam the ledger; a respawn (new workspace_ref) re-arms it.
          if (r.process === "dead") {
            const ws = state.issues?.[r.issue]?.workspace_ref ?? "";
            const key = `${r.issue}:${ws}`;
            if (!deadSeen.has(key)) {
              const ev = { actor: "orch", type: "lead_process_dead", issue: r.issue, host: r.host, workspace_ref: ws || null, note: "no live process matches the lead's brief path — diff the branch against open findings before respawning" };
              await appendEvent(runDir, ev);
              emitted.push(ev);
              deadSeen.add(key);
            }
            continue; // don't also emit rotate/unreadable noise for a corpse
          }
          // An unreadable in-flight lead gets its own durable event. It is deliberately NOT a
          // rotate_requested — we do not know that it needs rotating, only that we are BLIND to it,
          // and manufacturing a rotate flag from no evidence is the same sin as a dead gate
          // manufacturing a clean review. Deduped on (issue, note) so a persistently-unreadable lead
          // does not spam the ledger every wake, but a CHANGE in why it is unreadable re-fires.
          if ((r.band === "unknown" || r.readable === false) && r.pollable !== false && r.transcript) {
            const key = `${r.issue}:${r.note ?? ""}`;
            if (!unreadableSeen.has(key)) {
              const ev = { actor: "orch", type: "lead_context_unreadable", issue: r.issue, host: r.host, note: r.note ?? "no usage record", transcript: r.transcript };
              await appendEvent(runDir, ev);
              emitted.push(ev);
              unreadableSeen.add(key);
            }
          } else if (r.readable === true && state.issues?.[r.issue]?.context_unreadable) {
            // Self-clear: a probe that raced a transcript write must not leave a permanent alarm.
            const ev = { actor: "orch", type: "lead_context_read", issue: r.issue, pct: r.pct, used: r.used, window: r.window };
            await appendEvent(runDir, ev);
            emitted.push(ev);
          }
          if ((r.band === "rotate" || r.band === "over") && !pending.has(r.issue)) {
            const ev = { actor: "orch", type: "rotate_requested", issue: r.issue, source: "detector", pct: r.pct, used: r.used, window: r.window };
            await appendEvent(runDir, ev);
            emitted.push(ev);
            pending.add(r.issue);
          }
          // A hot subagent is ADVISORY: only the parent lead can re-dispatch one, so this records the
          // finding and lets the orchestrator poke the lead — it never becomes an orchestrator action.
          for (const s of r.subagents ?? []) {
            if (s.band !== "over" && !s.errored) continue;
            const key = `${r.issue}:${s.id}`;
            if (hotSeen.has(key)) continue;
            const ev = { actor: "orch", type: "subagent_hot", issue: r.issue, agent: s.id, agentType: s.agentType, description: s.description, pct: s.pct, used: s.used, errored: !!s.errored };
            await appendEvent(runDir, ev);
            emitted.push(ev);
            hotSeen.add(key);
          }
        }
      }
      const payload = { run_id: o.runId, readings, emitted };
      return { ...payload, stdout: o.json ? JSON.stringify(payload) : renderContextBanner(readings) };
    }
    case "rotate-lead": {
      // Respawn-over-compact for a LEAD: close the workspace, KEEP the worktree, checkpoint the WIP,
      // read the predecessor's note, render a TIGHT resumption brief, respawn on the same worktree.
      assertNotRoot("rotate a lead");
      if (!runDir) throw new Error("rotate-lead needs --run <id>");
      const events = await readEvents(runDir);
      const state = materializeState(events, { run_id: o.runId });
      const it = state.issues[o.issueId];
      if (!it) throw new Error(`rotate-lead: ${o.issueId} is not a unit in run ${o.runId}`);
      const rotation = Number(o.rotation) || (it.rotations ?? 0) + 1;
      // The cap is the whole reason rotation is safe to automate. Two fresh contexts is generous; a
      // third means the UNIT is wrong, not the context — and DER-2160 proved an uncapped respawn loop
      // burns ~922M tokens without landing. This throws so the orchestrator has to decide.
      if ((it.rotations ?? 0) >= ROTATION_CAP) {
        throw new Error(
          `refusing to rotate ${o.issueId}: it has already used ${it.rotations}/${ROTATION_CAP} rotations. ` +
            "A third fresh context is not the fix — the unit is too big for one PR. Decide NOW and do not " +
            "escalate to the operator (these trips happen overnight): SPLIT (default — merge what is green, " +
            "carve the remainder into a NEW Linear issue carrying the open findings verbatim), RE-SCOPE, or " +
            "PARK. Append an orch_note saying which and why, then execute it.",
        );
      }
      const host = it.host ?? "local";
      const hostCfg = host === "local" ? null : getHosts()[host];
      const isCloud = hostCfg?.kind === "cloud";
      const ssh = hostCfg && !isCloud ? hostCfg.ssh : null;
      const ltName = it.leadType ?? "claude";
      const ltCfg = getLeadTypes()[ltName] ?? {};
      const repoRoot = o.repoRoot ?? process.cwd();

      // 1. Close the workspace. The worktree SURVIVES — that is the whole difference from `reap`.
      if (!o.dryRun) {
        if (ssh) {
          // POSTCONDITION (DER-2775): the predecessor must be PROVEN gone before step 5 respawns onto the
          // same worktree. `pkill …; true` proved nothing, so a lead that ignored the signal left TWO live
          // leads on one worktree — the branch-corruption failure this whole close-then-respawn dance
          // exists to prevent. `unknown` refuses too: an unverified kill is not a kill, and a rotation is
          // always safe to retry, whereas a second writer on live uncommitted work is not recoverable.
          const pat = leadBriefPattern({ runDir: `${hostCfg.ledgerRoot}/${o.runId}`, issueId: o.issueId });
          const probe = classifyKillProbe(await runCommand({ command: "ssh", args: [ssh, remoteKillProbeCommand(pat)] }));
          if (probe !== "killed") {
            throw new Error(
              `rotate-lead: refusing to respawn ${o.issueId} on ${host} — ${KILL_PROBE_NOTES[probe]}. ` +
                "Respawning now would put TWO leads on one worktree (" + it.worktree + "), which corrupts " +
                `the branch. Fix it on the host, then re-run: ssh ${ssh} "pkill -f '${bracketEscapePattern(pat)}'" ` +
                `and confirm with pgrep -f '${bracketEscapePattern(pat)}' (no output = gone; SIGKILL it if it ignores TERM). ` +
                "If the probe could not answer at all, the host or its ssh is the problem — `preflight` it first.",
            );
          }
        }
        if (it.workspace_ref) {
          await runCommand({ command: cmuxBin(), args: ["close-workspace", "--workspace", it.workspace_ref] });
        }
      }

      // 2. Checkpoint the WIP — rotation preserves only what is COMMITTED.
      const wipCommitted = o.dryRun ? null : await ensureWipCommit({ worktree: it.worktree, issueId: o.issueId, rotation, ssh });

      // 3. The predecessor's note, or a reconstruction. Never blocks.
      let note = o.dryRun ? null : await fetchHandoffNote({ runDir, runId: o.runId, issueId: o.issueId, rotation, hostCfg: ssh ? hostCfg : null, isCloud, pr: it.pr, repoRoot });
      const noteSynthesized = !note;
      if (noteSynthesized && !o.dryRun) note = await synthesizeHandoffNote({ worktree: it.worktree, issueState: it, ssh });

      // 4. The TIGHT resumption brief — never the kickback dossier.
      const latest = [...events].reverse().find((e) => e?.type === "kickback" && e.issue === o.issueId && e.findings);
      let nonIssues = null;
      try { nonIssues = await readFile(join(fileURLToPath(new URL(".", import.meta.url)), "known-non-issues.md"), "utf8"); } catch { /* optional */ }
      const brief = renderRotationBrief({
        issueId: o.issueId,
        title: o.title,
        worktree: it.worktree,
        branch: it.branch,
        runId: o.runId,
        runDir: ssh ? `${hostCfg.ledgerRoot}/${o.runId}` : runDir,
        runsRoot,
        ledgerRunsRoot: ssh ? hostCfg.ledgerRoot : o.ledgerRunsRoot,
        runnerCmd: o.runnerCmd,
        rotation,
        pr: it.pr,
        note,
        noteSynthesized,
        disposition: it.rotate_disposition ?? "CLOSEOUT",
        latestFindings: latest?.findings ?? null,
        bundle: it.bundle ?? undefined,
        leadType: ltName,
        leadTypeCfg: ltCfg,
        acceptance: o.acceptance,
        nonIssues,
      });
      const briefPath = join(runDir, "briefs", `${o.issueId}.rot${rotation}.md`);
      // Dry-run purity (DER-2514): the old behavior wrote the .rot brief AND (via spawn-lead) appended
      // lead_spawned — so a "preview" consumed a rotation slot for real. A dry run now writes nothing.
      if (!o.dryRun) {
        await mkdir(join(runDir, "briefs"), { recursive: true });
        await writeFile(briefPath, brief, "utf8");
      }

      // 5. Respawn on the SAME worktree. A cloud rotation used to stop here — RemoteTrigger was the
      // orchestrator's own MCP tool, not something the runner could call — so it prepared the brief and
      // handed it back. Since 2026-08-18 the cloud spawn IS a subcommand (`spawn-cloud`), so the rotation
      // completes here like every other host. It still cannot when the unit has no worktree, which is what
      // every routine-era cloud unit looks like: the session clones the ref checked out in a worktree, and
      // without one there is nothing to clone from.
      // A dry run SYNTHESIZES NOTHING (`noteSynthesized && !o.dryRun` above), so the payload must not claim
      // it did. The brief still renders with the synthesized-note warning — that is a faithful preview of
      // what WOULD be written — but the caller-visible field describes the action actually taken (DER-4050).
      const noteFields = o.dryRun
        ? { noteSynthesized: false, noteWouldSynthesize: noteSynthesized }
        : { noteSynthesized };
      // ORDER IS LOAD-BEARING (DER-4050): the no-worktree branch runs FIRST. Both branches stop at
      // `rotation_prepared`, so the only thing the order decides is WHICH recovery the operator is told —
      // and a routine-era cloud unit on a disabled host needs the `create-worktree` step, which the
      // disabled-host message does not carry. Putting the disabled guard first shadowed it and printed
      // `--worktree <p>` for a unit that has no worktree to name.
      if (isCloud && !it.worktree) {
        if (!o.dryRun) await appendEvent(runDir, { actor: "orch", type: "rotation_prepared", issue: o.issueId, rotation, brief: briefPath, host, ...(hostCfg?.enabled === false ? { blocked: "host_disabled" } : {}) });
        return {
          briefPath, rotation, wipCommitted, ...noteFields, host, spawned: false,
          stdout: `prepared rotation ${rotation} for ${o.issueId} (cloud), but this unit has NO worktree — a routine-era cloud unit.\n  Brief: ${briefPath}\n  Give it one and spawn: create-worktree --run ${o.runId} ${o.issueId}, then\n  spawn-cloud --run ${o.runId} ${o.issueId} --host ${host} --worktree <p> --rotation ${rotation} --push${hostCfg?.enabled === false ? `\n  NOTE: host "${host}" is also enabled:false — naming it above IS the deliberate opt-in.` : ""}`,
        };
      }
      // A DISABLED cloud host does not get an automatic rotation spawn (2026-08-18). `spawn-cloud` treats an
      // explicitly named host as the operator's opt-in — which is right when a human types it, and wrong
      // here, where this command MANUFACTURES `--host <host>` from ledger state. An operator who disables a
      // host mid-run (429s, a walled account, a repointed environment) means "send no more work there", and
      // a rotation is more work. So stop at `rotation_prepared` and make the next dispatch a human's.
      if (isCloud && hostCfg?.enabled === false) {
        if (!o.dryRun) await appendEvent(runDir, { actor: "orch", type: "rotation_prepared", issue: o.issueId, rotation, brief: briefPath, host, blocked: "host_disabled" });
        return {
          briefPath, rotation, wipCommitted, ...noteFields, host, spawned: false,
          stdout: `prepared rotation ${rotation} for ${o.issueId}, but host "${host}" is enabled:false — REFUSING to spawn it automatically.\n  A disabled host means "no more work here", and this command would have synthesized the --host that spawn-cloud reads as an operator opt-in.\n  Read that host's note in .claude/work.config.json, then dispatch it yourself if you still want it:\n  spawn-cloud --run ${o.runId} ${o.issueId} --host ${host} --worktree ${it.worktree ?? "<p>"} --rotation ${rotation} --push`,
        };
      }
      const spawnArgs = isCloud
        ? [
          "spawn-cloud", "--run", o.runId, o.issueId,
          "--worktree", it.worktree,
          "--rotation", String(rotation),
          "--host", host,
          // The rotation brief is a fresh session's only instruction, and its branch must be on origin at
          // this exact sha before the clone — the WIP commit above may well have just moved it.
          "--push",
          ...(o.runsRoot ? ["--runs-root", o.runsRoot] : []),
          ...(o.repoRoot ? ["--repo-root", o.repoRoot] : []),
          ...(o.dryRun ? ["--dry-run"] : []),
        ]
        : [
        "spawn-lead", "--run", o.runId, o.issueId,
        "--worktree", it.worktree,
        "--rotation", String(rotation),
        ...(o.title ? ["--title", o.title] : []),
        ...(host !== "local" ? ["--host", host] : []),
        ...(ltName !== "claude" ? ["--lead-type", ltName] : []),
        ...(it.bundle?.length ? ["--bundle", it.bundle.filter((b) => b !== o.issueId).join(",")] : []),
        ...(o.runsRoot ? ["--runs-root", o.runsRoot] : []),
        ...(o.repoRoot ? ["--repo-root", o.repoRoot] : []),
        ...(o.dryRun ? ["--dry-run"] : []),
      ];
      const spawned = await runSubcommand(spawnArgs);
      return {
        briefPath, rotation, wipCommitted, ...noteFields, host, spawned: true,
        workspace_ref: spawned.workspace_ref ?? null,
        ...(spawned.cloudSessionId ? { cloudSessionId: spawned.cloudSessionId } : {}),
        // Dry-run purity (DER-2514): the brief is not written, so hand its content back for preview.
        ...(o.dryRun ? { brief, dryRun: true } : {}),
        stdout: `rotated ${o.issueId} → rotation ${rotation} (${host})${o.dryRun ? " [DRY-RUN — nothing written, nothing recorded]" : ""}\n  brief: ${briefPath}${noteSynthesized ? "  ⚠ synthesized note (predecessor left none)" : ""}\n  wip commit: ${wipCommitted ? "created" : "nothing to commit"}\n  ${spawned.stdout ?? ""}`.trimEnd(),
      };
    }
    case "reap": {
      const state = materializeState(await readEvents(runDir), { run_id: o.runId });
      // PRECONDITIONS IN (DER-2775) — before ANY teardown and before ANY ledger write, including on a
      // --dry-run, because a preview of an illegal reap must refuse rather than rehearse it. `?? {}` is
      // gone on purpose: an unknown id is a refusal, never an empty unit that folds a phantom `reaped`.
      const it = state.issues[o.issueId];
      const abandoned = Boolean(o.abandon || o.force);
      // 4.3 — is this a DECLARED-but-never-dispatched id? `state.queue` is the run's own answer, so a
      // typo'd id is still refused: the queue is built from `run_started.issues`, not from the argv.
      const neverStarted = !it && (state.queue ?? []).includes(o.issueId);
      const refusal = reapRefusal({ issueId: o.issueId, runId: o.runId, unit: it, abandon: abandoned, queued: neverStarted });
      if (refusal) throw new Error(refusal);
      if (neverStarted) {
        // Nothing to tear down: no worktree, no host, no lead process ever existed. The whole point is
        // that the ledger records WHY this unit is terminal, rather than the run being unclosable or
        // someone hand-appending a `reaped` that claims a teardown that never happened.
        const ev = {
          actor: "orch", type: "reaped", issue: o.issueId,
          never_started: true, cleanup_ok: true, cleanup: [],
          note: "declared in run_started.issues and never dispatched — no worktree, host or lead process ever existed, so nothing was torn down",
          ts: new Date().toISOString(),
        };
        if (!o.dryRun) await appendEvent(runDir, ev);
        return {
          event: ev,
          stdout: `reaped ${o.issueId} — NEVER STARTED (declared, never dispatched). Nothing torn down; ` +
            `the unit is now terminal so \`complete-run\` can close the run.${o.dryRun ? " [dry-run: nothing appended]" : ""}`,
        };
      }
      // Only load-bearing when the unit was ACTIVE — an --abandon on an already-merged unit is a no-op
      // flag, and stamping `abandoned: true` there would claim a destruction that did not happen.
      const abandonedActive = abandoned && !REAP_TERMINAL_ELIGIBLE(it.status);
      // "Remote" here means SSH-REACHABLE MACHINE, not "not local" (DER-4053). A cloud unit runs on an
      // Anthropic-managed VM reached by `claude --cloud`: its host entry has no `ssh`, no `ledgerRoot` and no
      // remote `repo`, and its worktree is a LOCAL staging checkout that the session cloned FROM. Treating
      // `kind:"cloud"` as ssh-remote sent reap down the remote branch, where `leadBriefPattern` composed
      // `undefined/<run>/briefs/<id>` and threw — so there was no worktree cleanup, no `reaped` event, and a
      // cloud run could never be closed out at all. Cleanup deliberately ignores `enabled` (a unit that has
      // already done its work must be reapable even after its host is disabled); the axis is KIND.
      const reapHostCfg = it.host && it.host !== "local" ? getHosts()[it.host] : null;
      const remoteHost = reapHostCfg && reapHostCfg.kind !== "cloud" ? reapHostCfg : null;
      // DER-2740: every cleanup result is CAPTURED rather than discarded. Cleanup stays best-effort — the
      // run must still be able to end — but "best-effort" was silently doing double duty as "unrecorded".
      const cleanupSteps = [];
      if (!o.dryRun) {
        if (remoteHost) {
          // cmux close-workspace only drops the ssh connection — the remote claude survives (it
          // self-exits eventually, but non-deterministically). Kill it explicitly by its brief path
          // in the process args BEFORE removing the worktree it's cwd'd in, so a mini reap is clean.
          // POSTCONDITION OUT (DER-2775): kill THEN probe in one round trip, and record what the probe
          // found. `pkill …; true` reported success unconditionally — a survivor got a clean receipt.
          const briefMatch = leadBriefPattern({ runDir: `${remoteHost.ledgerRoot}/${o.runId}`, issueId: o.issueId });
          const r = await runCommand({ command: "ssh", args: [remoteHost.ssh, remoteKillProbeCommand(briefMatch)] });
          // REQUIRED: a failure here leaves the remote lead alive, spending, with nothing watching it.
          cleanupSteps.push(killProbeStep("remote_pkill", r));
        }
        if (it.worktree) {
          if (remoteHost) {
            // Chain the stale-AUTO_MERGE cleanup (B5) into the same ssh as the worktree remove — no
            // extra round-trip; the `2>/dev/null` swallows a missing-ref error (best-effort, as before).
            const r = await runCommand({ command: "ssh", args: [remoteHost.ssh, reapRemoteCleanupCommand({ worktree: it.worktree, repo: remoteHost.repo })] });
            cleanupSteps.push({ step: "remote_worktree_remove", optional: false, exit_code: r.exitCode, stderr: r.stderr });
          } else {
            // Local cleanup stays OPTIONAL, and now says so through the flag rather than by discarding the
            // result: the commonest nonzero here is "worktree already gone", which is the desired end state.
            for (const c of reapCleanupCommands({ worktree: it.worktree, gitCwd: o.repoRoot ?? process.cwd() })) {
              const r = await runCommand({ command: c.command, args: c.args });
              cleanupSteps.push({
                step: c.args?.includes("update-ref") ? "local_auto_merge" : "local_worktree_remove",
                optional: true, exit_code: r.exitCode, stderr: r.stderr,
              });
            }
          }
        }
        // Close EVERY workspace ever recorded for this issue (DER-2517), not just the latest —
        // kickback respawns used to leak their predecessors' panes until run end.
        const refs = workspaceRefsToClose(await readEvents(runDir), o.issueId);
        if (it.workspace_ref && !refs.includes(it.workspace_ref)) refs.push(it.workspace_ref);
        for (const ref of refs) {
          await runCommand({ command: cmuxBin(), args: ["close-workspace", "--workspace", ref] });
        }
      }
      // Dry-run purity (DER-2514): a preview reap must not record a terminal `reaped`.
      const cleanup = reapCleanupOutcome(cleanupSteps);
      if (!o.dryRun) {
        await appendEvent(runDir, {
          actor: "orch", type: "reaped", issue: o.issueId,
          cleanup_ok: cleanup.ok, cleanup: cleanup.steps,
          // DER-2775: an audit must be able to tell post-merge cleanup from deliberate destruction. Only
          // stamped when the escape hatch actually carried the reap past the ACTIVE guard.
          ...(abandonedActive ? { abandoned: true, abandoned_from: it.status } : {}),
        });
        // A SEPARATE event, not a field on `reaped` alone: `dedupeTerminalEvents` keeps the first `reaped`
        // per issue, so a leak recorded only there could never be reported by a later re-reap. Appended
        // AFTER `reaped` so the terminal transition is never lost if this write fails.
        if (!cleanup.ok) {
          await appendEvent(runDir, {
            actor: "orch", type: "reap_failed", issue: o.issueId, host: it.host ?? null,
            leaks: cleanup.leaks, failed_steps: cleanup.failed_steps, cleanup: cleanup.steps,
            // Name the VERDICT, not just the step: "the probe found it alive" and "the probe never
            // answered" oblige the operator differently, and both used to read as a clean teardown.
            reason: `required cleanup failed: ${cleanup.leaks
              .map((l) => {
                const s = cleanup.steps.find((x) => x.step === l);
                return s?.probe && KILL_PROBE_NOTES[s.probe] ? `${l} (${KILL_PROBE_NOTES[s.probe]})` : l;
              })
              .join(", ")}`,
          });
        }
      }
      const leakNote = cleanup.ok ? "" : `\n  ⚠ NOT a clean teardown — ${cleanup.leaks.map((l) => REAP_LEAK_NOTES[l] ?? l).join("\n  ⚠ ")}`;
      const abandonNote = abandonedActive ? ` ⚠ ABANDONED from \`${it.status}\` — its uncommitted work is gone (recorded as abandoned:true)` : "";
      return { stdout: `reaped ${o.issueId}${o.dryRun ? " (dry-run: nothing closed, nothing recorded)" : ""}${abandonNote}${leakNote}` };
    }
    case "complete-run": {
      // DER-2781 — the RUN's terminal state, gated. See runCompletionRefusals for why every check is here
      // and why there is no override flag.
      //
      // Deliberately NOT in VERSION_GATED_SUBCOMMANDS: that helper throws on a bad protocol verdict before
      // the gate runs, so its message would replace the full refusal list with one line about versions.
      // Check 7 applies the identical foreign-vs-skew split, inside the list, alongside everything else
      // that is wrong — an operator closing a run should read ALL of it in one pass, not one round-trip
      // per fault.
      const events = await readEvents(runDir);
      // readEvents FIRST, then health: the health record describes the read that just happened (same
      // ordering, and the same reason, as `state`).
      const ledger = await readLedgerHealth(runDir);
      const state = materializeState(events, { run_id: o.runId, project: o.project, ledger });
      // FIRST-WINS idempotency: a second `complete-run` is a no-op SUCCESS that appends nothing. Checked
      // before the gate on purpose — re-running it on a finished run must not be able to fail, or a late
      // post-completion event (which never reopens the run) would turn a settled run back into an error.
      if (state.status === "completed") {
        const late = state.post_completion_events ?? 0;
        return {
          alreadyCompleted: true, completed: true, completedAt: state.completed_at,
          postCompletionEvents: late, refusals: [], state,
          stdout: `run ${o.runId} was ALREADY completed at ${state.completed_at ?? "an unrecorded time"} — nothing appended (first-wins).`
            + (late ? `\n  ${late} event(s) landed AFTER completion (${(state.post_completion_event_types ?? []).join(", ")}) — they folded onto their units; the run stays completed.` : ""),
        };
      }
      // DER-2838 (#8) — the ACTING version, exactly as the dispatch gate does it (DER-2779). `state`
      // reports the ledger's own verdict and must keep doing so, so the attested one is computed here and
      // handed to the gate rather than folded into `state`. Without it, a caller on another build passed
      // check 7 and then auto-attested its version during the append below — the run ended up mixed at
      // the exact moment it was declared finished, and nothing had refused.
      const refusals = runCompletionRefusals({
        state, ledger, allowVersionSkew: !!o.allowVersionSkew,
        protocol: ledgerProtocolVerdict(events, currentVersionAttestation()),
      });
      if (refusals.length) throw new Error(renderRunCompletionRefusal({ runId: o.runId, refusals }));
      const units = Object.entries(state.issues)
        .filter(([, v]) => DONE_STATUSES.has(v.status))
        .map(([k]) => k)
        .sort();
      // Dry-run purity (DER-2514), applied to the one command whose whole job is a durable claim: a
      // preview that appended `run_completed` would end the run it was only asked to test.
      if (o.dryRun) {
        return {
          completed: false, dryRun: true, refusals: [], units,
          stdout: `run ${o.runId} WOULD complete — every check passes over ${units.length} terminal unit(s): ${units.join(", ")}\n  (dry-run: no run_completed appended)`,
        };
      }
      // Append-only, with no lock: two `complete-run`s racing past the idempotency check above would both
      // append. That is survivable BY the fold rather than prevented here — first-wins means `status` and
      // `completed_at` are stable, and the loser shows up as a post_completion_event. A lock file would be
      // a new failure mode (a stale one makes the run uncompletable) for a race one operator cannot run.
      // DER-2838 — the marker states what the gate saw, so the fold can cross-examine the claim instead
      // of trusting the type. This is the ONLY writer of a receipt: `append` refuses the type outright.
      const ev = await appendEvent(runDir, {
        actor: o.actor ?? "orch", type: "run_completed", run_id: o.runId,
        units, unit_count: units.length,
        completion_receipt: mintRunCompletionReceipt({ runId: o.runId, units, allowVersionSkew: !!o.allowVersionSkew }),
      });
      // Re-fold and persist, so a successor that reads only state.json learns the run is over without
      // having to run anything. Re-READ rather than appending `ev` to the in-memory array: state.json
      // must describe the ledger as it is on disk, sorted and deduped by the one choke point.
      const finalState = materializeState(await readEvents(runDir), { run_id: o.runId, project: o.project, ledger: await readLedgerHealth(runDir) });
      // DER-2838 — the mint and the validator are two halves of one contract, so ASK the reader whether
      // it honored what we just wrote instead of assuming it did. This is what keeps the receipt from
      // becoming a check that cannot fail: every successful completion exercises the rejection path's
      // inverse. Reachable in earnest if a concurrent writer added a unit between the gate and this
      // fold — in which case the run genuinely is not complete and saying so is the only honest answer.
      if (finalState.status !== "completed") {
        const why = (finalState.run_completion_rejected ?? []).map((r) => r.reason).join("; ") || "no reason recorded";
        throw new Error(
          `complete-run appended a run_completed the fold REFUSED to honor: ${why}\n` +
          `  The run is NOT complete and that marker is inert (it is listed in state.run_completion_rejected).\n` +
          `  Re-read \`state\`: if a unit stopped being terminal between the gate and this write, land it and run \`complete-run\` again.`,
        );
      }
      // A marker this fold ignored — a forgery attempt, or a completion minted before the receipt
      // contract existed. Reported on the ONE command whose job is to settle the run's end, rather than
      // left to whoever next reads the JSON.
      const rejectedMarkers = finalState.run_completion_rejected ?? [];
      // Best-effort, and deliberately so: the LEDGER is the record of completion. Failing the command
      // because a convenience file could not be rewritten would report "not completed" about a run that
      // is — the next invocation would then correctly answer "already completed", contradicting this one.
      let stateWritten = true;
      try { await writeFile(join(runDir, "state.json"), `${JSON.stringify(finalState, null, 2)}\n`, "utf8"); }
      catch { stateWritten = false; }
      // NOT a gate — DER-2740's leaked-teardown banner survives terminal status on purpose, and the
      // settled completion contract does not include it. But a run whose reap left a remote lead alive is
      // still spending, so the success receipt says so out loud rather than reading unqualified-clean.
      // 4.4 — a RETRACTED leak is not an open one. It stays in state.reap_failures with its evidence
      // (the append-only record is intact and the investigation is still readable), but the run's exit
      // banner must stop telling the operator to go check something already verified resolved.
      const leaks = (finalState.reap_failures ?? []).filter((l) => !l.retracted);
      return {
        completed: true, event: ev, units, state: finalState, stateWritten, reapFailures: leaks,
        rejectedMarkers,
        stdout: `run ${o.runId} COMPLETE — ${units.length} terminal unit(s): ${units.join(", ")}\n`
          + `  state.status is now "completed"${stateWritten ? " (state.json refreshed)" : " (state.json could NOT be written — the ledger is still the record)"}.\n`
          + `  A late event does NOT reopen the run: it folds onto its own unit and is counted in state.post_completion_events.`
          + (rejectedMarkers.length
            ? `\n  ⚠ ${rejectedMarkers.length} earlier run_completed marker(s) were IGNORED by the fold and are NOT this completion: `
              + `${rejectedMarkers.map((r) => `${r.ts ?? "?"} — ${r.reason}`).join("; ")}. `
              + `A marker written by anything other than \`complete-run\` carries no receipt (DER-2838); if you did not expect one, find out who wrote it.`
            : "")
          + (leaks.length
            ? `\n  ⚠ ${leaks.length} unit(s) did NOT tear down cleanly and are NOT part of this gate: `
              + `${leaks.map((l) => `${l.issue} (${(l.leaks ?? []).join(", ") || "see state.reap_failures"})`).join("; ")}. `
              + `Check whether anything they owned is still running before you walk away.`
            : ""),
      };
    }
    case "ready": {
      // PER-PR ENQUEUE GATE (H5) — the run-dir ready.sh promoted to a harness primitive so it stops
      // being re-derived (and re-broken) every run. Reads BOTH Codex surfaces author-filtered,
      // captures `gh pr checks` ONCE, resolves a red run's status (a CANCELLED superseded run reports
      // as `fail`), treats a throttled thread read as UNKNOWN never 0, and prints how far each branch
      // is BEHIND main (H11: CI tests the MERGE tree — a behind branch can fail on files it never
      // contained, and "can't reproduce locally" is the signature, not lead incompetence).
      //   usage: … ready --run <id> [PR numbers…]   (no numbers ⇒ every open PR the run tracks)
      const repoRootReady = o.repoRoot ?? process.cwd();
      const slugRes = await runCommand({ command: "gh", args: ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd: repoRootReady });
      const slug = String(slugRes.stdout ?? "").trim();
      if (!slug) throw new Error("ready: cannot resolve repo slug (gh repo view failed)");
      const bot = "chatgpt-codex-connector[bot]";
      let prNums = o.rest.filter((t) => /^\d+$/.test(t)).map(Number);
      // DER-2588: the gate check needs the ledger to find each PR's local review evidence, so read the
      // events once here regardless of whether PR numbers were supplied on the command line.
      const readyEvents = runDir ? await readEvents(runDir) : [];
      const readyState = runDir ? materializeState(readyEvents, { run_id: o.runId }) : { issues: {} };
      const readyCodexWaiver = codexWaiverFrom(readyEvents);
      const issueByPr = new Map();
      for (const [id, v] of Object.entries(readyState.issues)) if (v.pr != null) issueByPr.set(v.pr, id);
      if (!prNums.length && runDir) {
        prNums = Object.values(readyState.issues).filter((v) => v.pr != null && ACTIVE_STATUSES.has(v.status)).map((v) => v.pr);
      }
      if (!prNums.length) throw new Error("ready: no PR numbers given and none open in the run ledger");
      // DER-2753 — resolve the merge mode ONCE for the whole invocation. On a queue-less adopter repo
      // the go-ahead is a direct `gh pr merge`, and the SAME readyVerdict below is the only thing that
      // authorizes it: the native queue's "green + threads resolved" enforcement, moved client-side.
      const mergePolicy = getMergePolicy();
      let queueDetected = null;
      if (!mergePolicy.mergeMode) {
        const [qOwner, qName] = slug.split("/");
        const defRes = await runCommand({ command: "gh", args: ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], cwd: repoRootReady });
        const defBranch = String(defRes.stdout ?? "").trim() || "main";
        const mqQuery = `{repository(owner:"${qOwner}",name:"${qName}"){mergeQueue(branch:"${defBranch}"){id}}}`;
        const mqRes = await runCommand({ command: "gh", args: ["api", "graphql", "-f", `query=${mqQuery}`, "-q", ".data.repository.mergeQueue.id"], cwd: repoRootReady });
        queueDetected = parseMergeQueueProbe({ exitCode: mqRes.exitCode, stdout: mqRes.stdout });
      }
      const resolvedMode = resolveMergeMode({ configured: mergePolicy.mergeMode, queueDetected });
      const results = [];
      for (const n of prNums) {
        const vRes = await runCommand({ command: "gh", args: ["pr", "view", String(n), "--repo", slug, "--json", "isDraft,headRefOid,commits"], cwd: repoRootReady });
        let head = null; let draft = null; let push = null;
        try {
          const d = JSON.parse(vRes.stdout || "{}");
          head = d.headRefOid ?? null; draft = d.isDraft;
          push = Array.isArray(d.commits) && d.commits.length ? d.commits[d.commits.length - 1].committedDate : null;
        } catch { /* falls through with nulls → not ready */ }
        // Unresolved threads — GraphQL, 3 tries; null stays UNKNOWN (fix 6).
        let threads = null;
        for (let t = 0; t < 3 && threads == null; t += 1) {
          const [owner, name] = slug.split("/");
          const q = `{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${n}){reviewThreads(first:100){nodes{isResolved}}}}}`;
          const res = await runCommand({ command: "gh", args: ["api", "graphql", "-f", `query=${q}`, "-q", "[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)]|length"], cwd: repoRootReady });
          const v = String(res.stdout ?? "").trim();
          if (res.exitCode === 0 && /^\d+$/.test(v)) threads = Number(v);
          else if (t < 2) await sleep(3000);
        }
        // Codex on head — BOTH surfaces, author-filtered, paginated (fixes 4/5/7 + H5).
        const revRes = await runCommand({ command: "gh", args: ["api", `repos/${slug}/pulls/${n}/reviews`, "--paginate", "-q", `[.[]|select(.user.login=="${bot}")]|last|.commit_id`], cwd: repoRootReady });
        const reviewSha = String(revRes.stdout ?? "").trim().replace(/^null$/, "") || null;
        const cmtRes = await runCommand({ command: "gh", args: ["api", `repos/${slug}/issues/${n}/comments`, "--paginate", "-q", `[.[]|select(.user.login=="${bot}")]|last|.body`], cwd: repoRootReady });
        const commentSha = codexCommentSha(cmtRes.stdout ?? "");
        const onHead = codexOnHead({ head: head ?? "", reviewSha, commentSha });
        // Checks — captured ONCE (fix 3); a red resolves its run's status (fix 4). DER-2774: `--json`
        // so the answer comes from every check's BUCKET rather than from one row's name, and the whole
        // probe result (exit code + stderr) is handed over, because a dead probe and a check-free repo
        // are only distinguishable there. Requires gh ≥ 2.50 (`pr checks --json`, cli/cli#9079).
        const chkRes = await runCommand({ command: "gh", args: ["pr", "checks", String(n), "--repo", slug, "--json", "name,state,bucket,link"], cwd: repoRootReady });
        const chk = parseChecksOutput(chkRes);
        let note = chk.checksNote ? ` [checks: ${chk.checksNote}]` : "";
        if (chk.firstFailUrl) {
          const rid = (String(chk.firstFailUrl).match(/runs\/(\d+)/) ?? [])[1];
          if (rid) {
            const rs = await runCommand({ command: "gh", args: ["api", `repos/${slug}/actions/runs/${rid}`, "-q", `"\\(.status)/\\(.conclusion) head=\\(.head_sha[0:10])"`], cwd: repoRootReady });
            const s = String(rs.stdout ?? "").trim();
            note = ` [red from run ${rid}: ${s}]${/cancelled/.test(s) ? " ← CANCELLED, NOT a failure" : ""}`;
          }
        }
        // Behind main (H11) — merge-tree distance via the compare API (no local fetch needed).
        let behind = null;
        if (head) {
          const cRes = await runCommand({ command: "gh", args: ["api", `repos/${slug}/compare/${head}...main`, "-q", ".ahead_by"], cwd: repoRootReady });
          const v = String(cRes.stdout ?? "").trim();
          if (cRes.exitCode === 0 && /^\d+$/.test(v)) behind = Number(v);
        }
        // DER-2588: does this PR's OWN local gate evidence cover the tree that would merge?
        // DER-2603: and did that gate ever RUN? A missing event now blocks, and an UNREADABLE ledger
        // (no --run, an untracked PR, a pre-stamp ledger) blocks with a different sentence — the lookup
        // decides which, so `ready` never attributes a sibling unit's evidence to this PR.
        const gate = gateEvidenceVerdict({ head, ...gateEvidenceLookup({ events: readyEvents, issueId: issueByPr.get(n) ?? null, ledgerRead: !!runDir }) });
        const verdict = readyVerdict({
          draft, threads, onHead, checks: chk.checks, shardsPass: chk.shardsPass, shardsTotal: chk.shardsTotal, gate,
          allowMergeWithoutChecks: mergePolicy.allowMergeWithoutChecks,
          // 1.3 — read from the ledger, not from an operator's memory. Without this the `codex not on
          // head` hold can never clear while codex is dead, so `ready` reports a condition no action
          // satisfies and the run stalls on a lie of omission.
          codexWaiver: readyCodexWaiver,
        });
        // DER-2774: the printed direct-merge command is bound to the SAME head every gate above was
        // evaluated against, so a push landing between `ready` and the merge is refused by GitHub
        // rather than silently merged.
        const action = mergeAction({ mode: resolvedMode.mode, strategy: mergePolicy.mergeStrategy, pr: n, verdict, expectedHead: head });
        results.push({ pr: n, head, draft, threads, onHead, reviewSha, commentSha, checks: chk.checks, shards: `${chk.shardsPass}/${chk.shardsTotal}`, behind, push, gate: gate.state, gateLabel: gate.label, ...verdict, note, mergeMode: resolvedMode.mode, mergeModeSource: resolvedMode.source, mergeAction: action });
      }
      const waiverLine = readyCodexWaiver.active
        ? `⚠ codex gate WAIVED until ${readyCodexWaiver.until} — ${readyCodexWaiver.reason}. Evidence is NOT waived: a PR with no review_findings covering its head still blocks.`
        : readyCodexWaiver.expired
          ? `codex waiver EXPIRED (${readyCodexWaiver.until}) — the review-coverage hold is live again unless a panel receipt covers the head; re-issue with waive-codex-gate or run the panel.`
          : null;
      const header = `merge mode: ${resolvedMode.mode ?? "UNRESOLVED"} (${resolvedMode.source}) — ${resolvedMode.why}${mergePolicy.allowMergeWithoutChecks ? "  [repo.allowMergeWithoutChecks=true: waives checks=ABSENT only (gh answered \"no checks on this branch\"); fail, pending and UNKNOWN all still block]" : ""}`;
      const text = [header, ...(waiverLine ? [waiverLine] : []), ...results.map((r) => readyLine(r))].join("\n");
      return { results, mergeMode: resolvedMode.mode, stdout: o.json ? JSON.stringify(results) : text };
    }
    case "preflight": {
      // Test the HARNESS before trusting it with a run (operator ask 2026-07-26). The unit suite
      // covers the pure logic; every defect the 07-26 run found lived in the DEPLOYED seams — dead
      // credentials, quota exhaustion, skills skew between hosts, a gate that exits 0 when it dies,
      // transcript persistence off, a disk nearly full (a co-factor in the cmux freeze). Each check
      // here is an instrument that CAN return the failing answer; `--skip-probes` skips the slow
      // account/gate probes (1-token completions), everything else always runs.
      // `ok` is TRI-STATE: true (green), false (red), or the string "unknown" (⚠, could not measure).
      // The third state is the 2.1 fix. An empty probe result is not evidence of a dead dependency — it
      // is evidence of no evidence, and rendering it red trains the operator to wave past the one signal
      // this preflight exists to make trustworthy. Same reasoning as the REMOTE_PATH_PRELUDE false-RED:
      // a wrong verdict is worse than an absent one. UNKNOWN does not fail the gate; it prints loudly
      // and carries a re-run instruction so a human decides.
      const checks = [];
      const add = (name, ok, detail) => { checks.push({ name, ok, detail }); };
      const skillsDir = fileURLToPath(new URL(".", import.meta.url));
      const repoRootForPreflight = o.repoRoot ?? process.cwd();

      // 1. Unit suite — 30s bound, the cheapest full-logic check.
      {
        const res = await runCommand({ command: "node", args: ["--test", join(skillsDir, "work-runner.test.mjs")], timeoutMs: 120000 });
        const failM = String(res.stdout ?? "").match(/# fail (\d+)/) ?? String(res.stdout ?? "").match(/\bfail (\d+)/);
        const fails = failM ? Number(failM[1]) : (res.exitCode === 0 ? 0 : NaN);
        add("unit-suite", res.exitCode === 0 && fails === 0, res.exitCode === 0 ? `pass (fail=${fails})` : `exit ${res.exitCode}`);
      }
      // 2. cmux reachable.
      {
        const res = await runCommand({ command: cmuxBin(), args: ["ping"], timeoutMs: 10000 }).catch(() => ({ exitCode: 1, stdout: "" }));
        add("cmux", res.exitCode === 0, res.exitCode === 0 ? String(res.stdout).trim() : "cmux ping failed — cockpit down or frozen");
      }
      // 3. gh identity — the WRONG active account reds Vercel and mis-attributes deploys.
      {
        const res = await runCommand({ command: "gh", args: ["api", "user", "-q", ".login"], timeoutMs: 15000 }).catch(() => ({ exitCode: 1, stdout: "" }));
        const login = String(res.stdout ?? "").trim();
        // The expected login comes from `.claude/work.config.json` `repo.ownerLogin`. With none set the
        // check reports the active login and PASSES — asserting against a hardcoded name would fail for
        // every user but one, and a preflight that always reds is a preflight nobody reads.
        const expected = getRepoIdentity().ownerLogin;
        const ok = res.exitCode === 0 && (!expected || login === expected);
        add("gh-identity", ok, login
          ? `active: ${login}${expected && login !== expected ? ` — MUST be ${expected} (gh auth switch --user ${expected})` : (expected ? "" : " (no repo.ownerLogin configured — not asserted)")}`
          : "gh api user failed");
      }
      // 3b. Merge mode (DER-2753) — the run cannot land ANY PR if the harness can neither read a
      // configured mode nor see whether a queue exists, and that is worth knowing at preflight rather
      // than at 3am on the first ready PR. This check CAN return the failing answer: an unauthenticated
      // gh or a repo we cannot resolve leaves the mode UNRESOLVED and reds it.
      {
        const policy = getMergePolicy();
        let queueDetected = null;
        if (!policy.mergeMode) {
          const slugRes = await runCommand({ command: "gh", args: ["repo", "view", "--json", "nameWithOwner,defaultBranchRef", "-q", '"\\(.nameWithOwner)\\t\\(.defaultBranchRef.name)"'], timeoutMs: 15000 }).catch(() => ({ exitCode: 1, stdout: "" }));
          const [nwo, branch] = String(slugRes.stdout ?? "").trim().split("\t");
          if (slugRes.exitCode === 0 && nwo && nwo.includes("/")) {
            const [ow, nm] = nwo.split("/");
            const q = `{repository(owner:"${ow}",name:"${nm}"){mergeQueue(branch:"${branch || "main"}"){id}}}`;
            const mq = await runCommand({ command: "gh", args: ["api", "graphql", "-f", `query=${q}`, "-q", ".data.repository.mergeQueue.id"], timeoutMs: 15000 }).catch(() => ({ exitCode: 1, stdout: "" }));
            queueDetected = parseMergeQueueProbe({ exitCode: mq.exitCode, stdout: mq.stdout });
          }
        }
        const resolved = resolveMergeMode({ configured: policy.mergeMode, queueDetected });
        add("merge-mode", resolved.mode != null, `${resolved.mode ?? "UNRESOLVED"} (${resolved.source}) — ${resolved.why}${resolved.mode === "direct" ? `; strategy=${policy.mergeStrategy}, allowMergeWithoutChecks=${policy.allowMergeWithoutChecks}` : ""}`);
      }
      // 4. Disk headroom — the cmux freeze had the data volume at 99% + 11 GB swapped.
      {
        const res = await runCommand({ command: "df", args: ["-k", process.env.HOME ?? "/"], timeoutMs: 5000 });
        const line = String(res.stdout ?? "").trim().split("\n").pop() ?? "";
        const pct = Number((line.match(/(\d+)%/) ?? [])[1]);
        add("disk", Number.isFinite(pct) && pct < 90, `home volume ${pct}% used${pct >= 90 ? " — ≥90% is the freeze co-factor; clean before a run" : ""}`);
      }
      // 4b. 6.3 — swap. The other half of the freeze signature, and until now checked only by an
      // orchestrator remembering to. An unparseable read is UNKNOWN, never "plenty of headroom".
      {
        const res = await runCommand({ command: "sysctl", args: ["vm.swapusage"], timeoutMs: 5000 }).catch(() => ({ exitCode: 1, stdout: "" }));
        const v = swapVerdict(parseSwapUsage(res.stdout));
        add("swap", v.ok, v.detail);
      }
      // 4c. 2.3 — power. `caffeinate` is NOT a sleep guard: three assertions were live while the box
      // slept for 88 minutes on 2026-07-31. Battery and clamshell sleep are the ones that bite, and an
      // unattended wave that sleeps looks exactly like a wedged one.
      {
        const res = await runCommand({ command: "pmset", args: ["-g", "ps"], timeoutMs: 5000 }).catch(() => ({ exitCode: 1, stdout: "" }));
        const out = String(res.stdout ?? "");
        const onBattery = /Battery Power/i.test(out);
        const known = /AC Power|Battery Power/i.test(out);
        add("power", known ? !onBattery : "unknown", !known
          ? "could not read `pmset -g ps` — UNKNOWN. An unattended wave needs AC power and the lid OPEN; caffeinate does NOT prevent battery/clamshell sleep."
          : onBattery
            ? "ON BATTERY — an unattended wave will sleep through its own run. caffeinate does NOT prevent battery or clamshell sleep (measured: 3 live assertions, 5 sleep cycles, 88 min lost). Plug in and open the lid, or dispatch to the mini."
            : "on AC power (keep the lid OPEN — clamshell sleep is not held off by caffeinate either)");
      }
      // 5. Transcript persistence — H10: without it ALL telemetry under-reports silently.
      {
        const childMarker = !!process.env.CLAUDE_CODE_CHILD_SESSION;
        let globalEnv = false;
        try {
          const s = JSON.parse(await readFile(join(homedir(), ".claude", "settings.json"), "utf8"));
          globalEnv = s?.env?.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE === "1";
        } catch { /* unreadable settings = not set */ }
        add("transcripts", globalEnv || !childMarker, `settings env FORCE_SESSION_PERSISTENCE=${globalEnv ? "1" : "ABSENT"}; CHILD_SESSION marker ${childMarker ? "present in this env" : "absent"}`);
      }
      // 6. Telemetry hooks installed (SessionEnd token report + throttled context report).
      {
        let hooksOk = false;
        try {
          const s = JSON.parse(await readFile(join(homedir(), ".claude", "settings.json"), "utf8"));
          const flat = JSON.stringify(s?.hooks ?? {});
          hooksOk = flat.includes("session-end-telemetry.mjs") && flat.includes("session-context-report.mjs");
        } catch { /* absent */ }
        add("telemetry-hooks", hooksOk, hooksOk ? "SessionEnd + context-report hooks registered" : "hooks NOT registered — orch/shepherd spend will read as ZERO again");
      }
      // 6b. The reporter those hooks shell out to (DER-2745 follow-up). Registered hooks are worthless if
      // the script they call is absent, stale, or fabricates zeros — see checkTokenReporter, which SMOKE
      // RUNS it rather than asserting a file exists.
      for (const leg of await checkTokenReporter({ skillsDir, cwd: process.cwd() })) add(leg.name, leg.ok, leg.detail);
      // 6d. 2.2 — `watch` ALWAYS prints. These are the exact controls shepherd #5 used to prove the
      // backgrounded-watch pattern was killing the watcher, promoted from a hand-run diagnosis into a
      // standing check. The inference that mattered was "watch always prints, therefore silence ⇒
      // killed, never woke" — and that inference is only sound if something keeps verifying the premise.
      // The third leg is the one that would have caught the original defect: kill a real watch and
      // require a terminal record on its stdout.
      {
        const dir = await mkdtemp(join(tmpdir(), "preflight-watch-"));
        try {
          const runDir2 = join(dir, "runs", "SMOKE");
          await mkdir(runDir2, { recursive: true });
          await writeFile(join(runDir2, "events.jsonl"),
            `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", actor: "orch", type: "run_started", run_id: "SMOKE", event_id: "0".repeat(39) + "1", source_id: "preflight:0:0", seq: 1, schema_version: 1 })}\n`, "utf8");
          const base = ["watch", "--run", "SMOKE", "--runs-root", join(dir, "runs"), "--repo-root", dir, "--nudge-since", "0"];
          const parse = (s) => { try { return JSON.parse(String(s ?? "").trim().split("\n").pop()); } catch { return null; } };
          // CHILD processes, never an in-process runSubcommand: runSubcommand re-runs applyRepoConfig
          // with THIS smoke leg's --repo-root (a temp dir), clobbering the module-global host config
          // for every leg that follows — which is how a preflight run from the correct repo still
          // reported "config did NOT load" and skipped every cross-host check. The kill leg below
          // always spawned; these two now match it.
          const runWatchChild = (args) => new Promise((res) => {
            const ch = spawn(process.execPath, [join(skillsDir, "work-runner.mjs"), ...args], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
            let buf = "";
            ch.stdout.on("data", (d) => { buf += d; });
            const t = setTimeout(() => ch.kill("SIGKILL"), 45000);
            ch.on("exit", () => { clearTimeout(t); res(buf); });
            ch.on("error", () => { clearTimeout(t); res(""); });
          });

          const ev = parse(await runWatchChild([...base, "--since", "0", "--timeout", "30"]));
          add("watch-prints:event", ev?.wake === "event", ev?.wake === "event" ? "--since 0 → event record immediately" : `--since 0 returned ${JSON.stringify(ev)} — expected wake:"event"`);

          const t0 = Date.now();
          const to = parse(await runWatchChild([...base, "--since", "99", "--timeout", "1"]));
          add("watch-prints:timeout", to?.wake === "timeout", to?.wake === "timeout" ? `--timeout 1 → timeout record at ${Math.round((Date.now() - t0) / 100) / 10}s` : `--timeout 1 returned ${JSON.stringify(to)} — expected wake:"timeout"`);

          // The kill leg. A watch that dies silently is indistinguishable from a quiet wake, which is
          // precisely how two watchers were lost without anyone being able to tell.
          const killed = await new Promise((res) => {
            const ch = spawn(process.execPath, [join(skillsDir, "work-runner.mjs"), ...base, "--since", "99", "--timeout", "120"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
            let buf = "";
            ch.stdout.on("data", (d) => { buf += d; });
            const t = setTimeout(() => ch.kill("SIGTERM"), 1500);
            ch.on("exit", () => { clearTimeout(t); res(parse(buf)); });
            ch.on("error", () => { clearTimeout(t); res(null); });
          });
          add("watch-prints:killed", killed?.wake === "killed", killed?.wake === "killed"
            ? "SIGTERM → terminal record (silence is structurally impossible)"
            : `a SIGTERMed watch printed ${JSON.stringify(killed)} — a killed watcher that prints NOTHING reads exactly like a quiet wake`);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      // 6c. HARNESS DRIFT (P0.3) — is the installed tree what install.sh actually wrote? Every check
      // above this line tests the ENVIRONMENT; this one tests the harness's own bytes, which until now
      // nothing did. `VERSION` equality is a claim two divergent installs make identically (measured:
      // seven files differing at a shared `0.2.0`), so this compares sha256 per shipped file instead.
      // An absent manifest reds rather than passes: an install that cannot attest is not a clean one.
      {
        const dest = process.env.CLAUDE_HOME || join(homedir(), ".claude");
        const drift = await measureHarnessDrift(dest);
        add("harness-drift", drift.ok, drift.reason);

        // DER-3008, defect 3 — WHOSE version is being reported. On 2026-08-01 a deploy verification
        // stated "hosts at 0.3.0" while neither host was at 0.3.0, and there are three different
        // "harness version" values that a reader collapses into one:
        //   (a) the VERSION file beside the RUNNING code. Run the checkout's runner and that is the
        //       CHECKOUT's VERSION, i.e. the version you are about to install, described in the present
        //       tense as the version that is running.
        //   (b) `$DEST/VERSION` — what an installed host actually resolves.
        //   (c) `manifest.version` — what install.sh recorded when it last wrote the tree.
        // Nothing compared them, so running the checkout's runner against an older install printed the
        // NEW number and attributed it to the installed hosts. This leg makes that disagreement loud.
        // ((c) vs the file on disk is now covered by `harness-drift` itself: VERSION joined the manifest's
        // file list in this same change, so a hand-edited $DEST/VERSION reports MODIFIED.)
        //
        // (a) is read with `readRunningHarnessVersion()`, NOT `getHarnessVersion()` — the latter prefers
        // `WORK_HARNESS_VERSION` and a process cache, which made this leg answer with the override it
        // exists to expose (remediation round 1; see `harnessVersionAgreementVerdict`).
        {
          const runningTree = readRunningHarnessVersion();
          let installed = null;
          try { installed = (await readFile(join(dest, "VERSION"), "utf8")).trim(); } catch { /* absent ⇒ null */ }
          const v = harnessVersionAgreementVerdict({
            runningFile: runningTree?.version ?? null,
            runningFrom: runningTree?.path ?? fileURLToPath(new URL("../../", import.meta.url)),
            reported: getHarnessVersion(),
            installed, installedPath: join(dest, "VERSION"),
            recorded: drift.version ?? null,
            envOverride: process.env.WORK_HARNESS_VERSION ?? null,
          });
          add("harness-version-agreement", v.ok, v.detail);
        }

        // The other half, and the one that actually bit: the 2026-07-31 drift was stale-but-UNTAMPERED.
        // Every installed file matched what install.sh wrote, so per-file hashes alone report CLEAN —
        // correctly — while the install lags the source of truth by ~12 commits. Only `source_commit`
        // can see that, and only when a source checkout is in reach. When it is not, this is UNKNOWN:
        // "I cannot see the source" must never be printed as "the install is current".
        if (drift.source_commit) {
          const head = await runCommand({ command: "git", args: ["rev-parse", "HEAD"], cwd: repoRootForPreflight, timeoutMs: 10000 }).catch(() => ({ exitCode: 1, stdout: "" }));
          const isHarnessCheckout = existsSync(join(repoRootForPreflight, "install.sh")) && existsSync(join(repoRootForPreflight, "skills", "work", "work-runner.mjs"));
          const sha = String(head.stdout ?? "").trim();
          if (head.exitCode !== 0 || !sha || !isHarnessCheckout) {
            add("harness-install-current", "unknown", `installed from ${drift.source_commit.slice(0, 12)}; no work-harness checkout at ${repoRootForPreflight} to compare against. ` +
              "Run preflight from the checkout, or `cd ~/Projects/work-harness && git fetch && git log --oneline HEAD..origin/main` to see how far behind this install is.");
          } else if (sha === drift.source_commit) {
            add("harness-install-current", true, `install matches this checkout's HEAD (${sha.slice(0, 12)})`);
          } else {
            const behind = await runCommand({ command: "git", args: ["rev-list", "--count", `${drift.source_commit}..HEAD`], cwd: repoRootForPreflight, timeoutMs: 10000 }).catch(() => ({ exitCode: 1, stdout: "" }));
            const n = String(behind.stdout ?? "").trim();
            add("harness-install-current", false, `STALE INSTALL — installed from ${drift.source_commit.slice(0, 12)}, checkout HEAD is ${sha.slice(0, 12)}` +
              `${/^\d+$/.test(n) && n !== "0" ? ` (${n} commit(s) ahead)` : ""}. Nothing is tampered, so the digest check reads CLEAN — ` +
              "this is the exact shape that drove a 20h run on stale code while both hosts reported the same VERSION. Re-run ./install.sh.");
          }
        }
      }
      // 6e. DER-3008 — WHERE the host list came from, and WHETHER the cross-host checks below can run.
      //
      // The three loops that follow used to `continue` past every host they could not check, so the
      // outcome of "no hosts configured" was ZERO printed lines — indistinguishable from three passing
      // checks, and from `--skip-probes` (which does not even gate them). That happened for real on
      // 2026-08-01: a preflight with the mini plainly configured printed no `:mini` line at all, because
      // its cwd was a work-harness checkout, which has no `.claude/work.config.json` — and
      // `harness-install-current` above tells the operator to run preflight from exactly there. Silence
      // is never an acceptable outcome for a documented gate, so both facts now print.
      const crossHost = crossHostTargets(getHosts());
      {
        const cfg = workConfigVerdict({ source: getConfigSource(), hosts: getHosts() });
        add("work-config", cfg.ok, cfg.detail);
        for (const s of crossHost.skipped) {
          if (!s.misconfigured) continue;
          add(`cross-host:${s.name}`, false, s.why);
        }
        const coverage = crossHostCoverageVerdict({ ...crossHost, configLoaded: getConfigSource().loaded });
        add("cross-host-checks", coverage.ok, coverage.detail);
      }
      // 7. Skills skew vs remote hosts — a lead on the mini following a stale brief loses gates silently,
      // and a remote skills dir without session-token-report.mjs makes every mini lead gap its spend, so
      // BOTH files are hashed (a missing file yields no hash at all ⇒ SKEW, never a matching-broken pair).
      // 6.1 — before anything ssh-shaped runs, check the HostName SHAPE. A `.local` alias is mDNS and
      // resolves only on the LAN; off-network it fails in a way that reads as "the host is down", and
      // that exact misreading went into a run handoff ("MINI IS DOWN, cap-5 lane gone") for a box that
      // had been up 21 days.
      for (const [hostName, hostCfg] of crossHost.targets) {
        const g = await runCommand({ command: "ssh", args: ["-G", hostCfg.ssh], timeoutMs: 10000 }).catch(() => ({ exitCode: 1, stdout: "" }));
        const hn = (String(g.stdout ?? "").split("\n").find((l) => l.startsWith("hostname ")) ?? "").slice(9).trim();
        if (!hn) { add(`ssh-hostname:${hostName}`, "unknown", `could not read \`ssh -G ${hostCfg.ssh}\` — cannot tell whether this alias is mDNS-only`); continue; }
        add(`ssh-hostname:${hostName}`, !isMdnsHostName(hn), isMdnsHostName(hn)
          ? `HostName is ${hn} — mDNS/Bonjour, LAN-ONLY. Off-network this fails as "could not resolve hostname" and reads as HOST DOWN. Use a Tailscale 100.x address (it routes direct on-LAN, so there is no on-LAN cost). A documented 192.168.x fallback is NOT a fix — it is equally useless off-network and its presence in a comment is false reassurance.`
          : `HostName ${hn}`);
      }
      for (const [hostName, hostCfg] of crossHost.targets) {
        const localHash = await runCommand({ command: "sh", args: ["-c", skillsHashCommand(SKILLS_SYNC_FILES.map((f) => join(skillsDir, f)))] });
        const remoteHash = await runCommand({ command: "ssh", args: [hostCfg.ssh, skillsHashCommand(SKILLS_SYNC_FILES.map((f) => `~/.claude/skills/work/${f}`), { quote: false })], timeoutMs: 20000 }).catch(() => ({ exitCode: 1, stdout: "" }));
        const sync = skillsSyncVerdict({
          hostName,
          sshAlias: hostCfg.ssh,
          localHash: localHash.stdout,
          remoteHash: remoteHash.stdout,
          remoteExitCode: remoteHash.exitCode,
          files: SKILLS_SYNC_FILES,
        });
        add(`skills-sync:${hostName}`, sync.ok, sync.detail);
        // P0.3, cross-host half: `skills-sync` above covers TWO files, so a host can differ in
        // SKILL.md, prep-runner.mjs or the config example and still read "in sync" — which is how a
        // seven-file drift hid behind a green check. The manifest's `content_digest` covers every
        // shipped file at once, so an unbumped-version drift refuses a dispatch exactly like a
        // version mismatch does. Absent on either side ⇒ report it, never treat two absences as a match.
        {
          const localMan = await measureHarnessDrift(process.env.CLAUDE_HOME || join(homedir(), ".claude"));
          const remoteMan = await runCommand({
            command: "ssh",
            args: [hostCfg.ssh, `cat ~/.claude/${HARNESS_MANIFEST_FILE} 2>/dev/null || true`],
            timeoutMs: 20000,
          }).catch(() => ({ exitCode: 1, stdout: "" }));
          const v = harnessDigestVerdict({
            hostName,
            sshAlias: hostCfg.ssh,
            local: localMan,
            remoteRaw: remoteMan.stdout,
            remoteExitCode: remoteMan.exitCode,
          });
          add(`harness-digest:${hostName}`, v.ok, v.detail);
        }
      }
      // 8. Stale side-copies of the runner (H6) — leads that find them misdiagnose the harness.
      {
        const stale = [];
        for (const p of [join(homedir(), ".codex", "work", "bin", "work-runner.mjs")]) {
          try { await readFile(p, "utf8"); stale.push(p); } catch { /* absent is good */ }
        }
        add("stale-runner-copies", stale.length === 0, stale.length ? `present: ${stale.join(", ")} — brief guard covers leads, but prefer deleting` : "none");
      }
      // 9–11. SLOW probes: account quota (per host) + codex gate. A 1-token completion is the ONLY
      // probe that can see a quota wall — every infrastructure preflight passes while the account is
      // dead (learned the hard way, twice).
      if (!o.skipProbes) {
        {
          const res = await runCommand({ command: "sh", args: ["-c", `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude -p "Reply with exactly: OK" --model haiku 2>&1 | tail -1`], timeoutMs: 90000 }).catch(() => ({ exitCode: 1, stdout: "" }));
          const out = String(res.stdout ?? "").trim();
          add("claude-probe:local", /\bOK\b/.test(out), out.slice(0, 120) || "no output");
        }
        // Same host set as the checks above (DER-3008) — this loop carried the identical inline
        // `kind === "cloud" || !ssh ⇒ continue`, so it went silent in exactly the same situations, and
        // `cross-host-checks` above already reported why. Deriving all four loops from one classification
        // is the point: fixing three of them would have left this one skipping the mini in silence.
        for (const [hostName, hostCfg] of crossHost.targets) {
          // FALSE-RED FIX: a bare `zsh -lc` over ssh does not pick up a remote host's user-level node /
          // claude install, so a perfectly healthy account printed NOTHING and read as a dead account.
          // Proven with paired controls in one call: the old form → empty; the same command with the
          // PATH prelude → `OK`. A false RED here is worse than no probe at all — it trains the operator
          // to wave past the one signal this preflight exists to make trustworthy. Every other remote
          // call in this file already carries the same prelude; this one was the outlier.
          const remoteEnv = hostCfg.remotePathPrelude ?? REMOTE_PATH_PRELUDE;
          const res = await runCommand({ command: "ssh", args: [hostCfg.ssh, `zsh -lc '${remoteEnv} env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude -p "Reply with exactly: OK" --model haiku 2>&1 | tail -1'`], timeoutMs: 120000 }).catch(() => ({ exitCode: 1, stdout: "" }));
          const out = String(res.stdout ?? "").trim();
          // Empty output is UNKNOWN, not dead: it is the signature of a PATH/transport problem, and the
          // quota wall this probe exists to catch always SAYS something ("hit your weekly limit").
          const ok = /\bOK\b/.test(out);
          add(`claude-probe:${hostName}`, ok, ok ? out.slice(0, 120)
            : (out ? out.slice(0, 120) : "NO OUTPUT — treat as UNKNOWN, not a dead account. Re-run by hand with the PATH prelude before believing this RED; a real quota wall prints a message."));
        }
        {
          // The codex gate probe — positive evidence, since `codex login status` lies (2026-07-25).
          //
          // 2.1: resolve the binary explicitly and NEVER shell a bare `codex`. A cmux shim ahead of the
          // real binary on PATH cost two agents ~40 minutes and a wrong root cause, because its hang is
          // byte-identical to a quota wall. If nothing resolves, this is UNKNOWN — the probe could not
          // run, which is not the same claim as "codex is down".
          // DER-3019: this leg BINDS to classifyCodexProbe — the same classifier the codex-probe
          // subcommand uses — instead of carrying a second inline copy of the classification. The
          // inline copy tested the success marker FIRST, so "OK, but: 401 invalid_refresh_token"
          // read as healthy here while the canonical classifier called it unauthenticated: two
          // definitions of one predicate, drifted, which is the exact class the repo's review
          // rules name. One classifier, two call sites, zero copies.
          const resolved = resolveCodexBin();
          let probeOut = "";
          let probeExit = null;
          if (resolved.bin) {
            const res = await runCommand({ command: resolved.bin, args: ["exec", "--json", "--sandbox", "read-only", "reply OK"], timeoutMs: 120000 })
              .catch((err) => ({ exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
            probeOut = `${String(res.stdout ?? "")}${String(res.stderr ?? "")}`;
            probeExit = res.exitCode ?? null;
          }
          const verdict = classifyCodexProbe({
            output: probeOut, exitCode: probeExit, bin: resolved.bin, why: resolved.why, skipped: resolved.skipped,
          });
          const handHint = verdict.status === "unknown"
            ? ` Probe by hand with stdin closed and READ THE ERROR TEXT: \`${resolved.bin ?? "<path-to>/codex"} exec --sandbox read-only "reply OK" < /dev/null\`. A real quota wall SAYS so; CPU% is NOT a discriminator.`
            : "";
          add("codex-probe", verdict.ok ? true : verdict.status === "unknown" ? "unknown" : false, `${verdict.detail}${handHint}`);
        }
      }
      // Tri-state, strictly: only an explicit `false` fails the gate. `"unknown"` is neither — it is a
      // probe that could not measure, and it is surfaced in the marker line so it can never be read as a
      // silent pass either. A GREEN with unmeasured probes says so.
      const failed = checks.filter((c) => c.ok === false);
      const unknown = checks.filter((c) => c.ok === "unknown");
      const lines = checks.map((c) => `  ${c.ok === true ? "✅" : c.ok === "unknown" ? "⚠️ " : "🔴"} ${c.name} — ${c.detail}`);
      // The printed marker is the gate (background-verify rule: `&&…||` chains exit 0 — gate on the
      // marker, never the exit code).
      const unknownSuffix = unknown.length ? ` — ${unknown.length} UNMEASURED: ${unknown.map((c) => c.name).join(", ")}` : "";
      lines.push(failed.length
        ? `PREFLIGHT RED — ${failed.length} failing: ${failed.map((c) => c.name).join(", ")}${unknownSuffix}`
        : `PREFLIGHT GREEN${unknownSuffix}`);
      return { checks, ok: failed.length === 0, unknown: unknown.map((c) => c.name), stdout: lines.join("\n") };
    }
    case "sweep-workspaces": {
      // Close every leaked CMUX workspace this run's ledger knows about (DER-2517 + 2026-07-26
      // operator report): predecessors of kickback respawns and rotations, prior shepherds, prior
      // orchestrators, and everything belonging to done units. Run it at every orchestrator boot
      // (successors close their predecessor here) and on the wake routine. `--keep ref1,ref2`
      // protects extra refs (your own workspace!); refs never recorded in this run's ledger are
      // untouchable by construction. --dry-run prints the plan and closes nothing.
      if (!runDir) throw new Error("sweep-workspaces needs --run <id>");
      const events = await readEvents(runDir);
      const state = materializeState(events, { run_id: o.runId });
      const keepRefs = String(o.keep ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const plan = sweepPlan({ events, state, keepRefs });
      const closed = [];
      if (!o.dryRun) {
        for (const ref of plan.close) {
          const res = await runCommand({ command: cmuxBin(), args: ["close-workspace", "--workspace", ref] });
          closed.push({ ref, ok: res.exitCode === 0 });
        }
      }
      return {
        ...plan, closed, dryRun: !!o.dryRun,
        stdout: `sweep-workspaces: ${plan.close.length} closable (${o.dryRun ? "dry-run — nothing closed" : `${closed.filter((c) => c.ok).length} closed`}), ${plan.keep.length} kept\n` +
          (plan.close.length ? `  close: ${plan.close.join(", ")}\n` : "") +
          `  keep:  ${plan.keep.join(", ") || "(none)"}`,
      };
    }
    case "pull-host": {
      // Merge a remote host's mini-local ledger into the canonical one (§3.4). ssh-tail from the
      // per-host cursor, append the new events, advance the cursor. Exactly-once; a re-run with no
      // new remote lines appends nothing. Network blip → the mini keeps writing; next cycle catches up.
      const host = getHosts()[o.host];
      if (!host) throw new Error(`unknown host "${o.host}"`);
      if (o.dryRun) {
        // Same builder as the executing path (DER-2839) — a hand-written second copy is a preview that
        // silently stops describing what runs.
        const cursor = await readCursor(runDir, o.host);
        const remote = remoteLedgerTailCommand(`${host.ledgerRoot}/${o.runId}/events.jsonl`, cursor);
        return { stdout: `ssh ${host.ssh} ${shellQuote(remote)}` };
      }
      return { stdout: JSON.stringify(await pullHostInto(runDir, o.host, o.runId)) };
    }
    case "reconcile-pr-events": {
      // Cloud-lead ledger fold (DER-1834): scan this run's open PRs for WORK-EVENT comments and
      // append the new ones. The orchestrator runs this each poll cycle for a run with cloud leads
      // (the cloud analogue of pull-host for the mini). Idempotent; best-effort.
      return { stdout: JSON.stringify(await reconcilePrEventsInto(runDir, o.runId, o.repoRoot ?? process.cwd())) };
    }
    case "links": {
      // Operator monitoring (item 7, 2026-07-15 turnover): publish the per-lead teleport/monitor link
      // list to <runDir>/links.md so the operator opens claude.ai/code monitors without grepping PR
      // bodies. reconcile-pr-events + `watch --reconcile-pr-events` refresh it automatically; this is the
      // manual form. cmux open <url> from the account that OWNS the cloud env to view in the CMUX pane.
      const state = materializeState(await readEvents(runDir), { run_id: o.runId, project: o.project });
      const md = renderLinksMd(state);
      await writeFile(join(runDir, "links.md"), md, "utf8");
      return { stdout: md.trimEnd() };
    }
    case "nudge": {
      // Bump a monotonic counter (not a deletable flag) — every blocked `watch` compares against the
      // baseline it captured at start and wakes, so ONE nudge reaches the orchestrator AND the
      // shepherd, not just whichever polls first (Codex #623).
      const n = (await readNudge(runDir)) + 1;
      await writeFile(join(runDir, "nudge"), String(n), "utf8");
      return { stdout: `nudged ${o.runId} (#${n})` };
    }
    case "watch": {
      // Bounded, interruptible poll primitive — the orchestrator/shepherd loop on THIS instead of
      // hand-rolling a hard-blocking background watcher (DER-1477). Wakes on: a new ledger event past
      // --since (filtered by --wake-on), the nudge counter rising above the baseline at start
      // (--nudge-since to override), or --timeout seconds. Prints JSON {wake, events} and exits so the
      // caller re-decomposes each wake.
      //
      // Two side-effects fold into the loop so the orchestrator no longer hand-rolls a poll-cycle.sh
      // (B2/B3), throttled to PULL_INTERVAL_MS so they don't run every 2.5s tick:
      //   --pull-hosts <auto|csv>  tail each mini host's local ledger into the canonical one each cycle
      //                            (a mini `pr_opened` never wakes the LOCAL ledger, so without this the
      //                            loop only saw mini progress at the 4-min timeout).
      //   --reconcile-merged       fold `gh pr list --state merged` truth in, so an out-of-band /
      //                            merge-queue merge that left no shepherd `pr_merged` still gets reaped.
      //   --reconcile-pr-events    fold cloud leads' draft-PR lifecycle (lead_online / draft→ready
      //                            handed_off / fix_pushed) + WORK-EVENT comments in, and refresh
      //                            links.md — so a cloud lead booting or handing off surfaces without a
      //                            separate reconcile-pr-events call (item 1/7, 2026-07-15 turnover).
      // All go through the canonical ledger, so a pulled/reconciled event then trips the wake below.
      const timeoutMs = clampWatchTimeout(o.timeout) * 1000;
      // DER-2741: the cursor is a BYTE OFFSET, resolved once from --since (absent ⇒ EOF, an event_id ⇒
      // exact, a count ⇒ the preserved legacy form). Fresh events are then the NEW LINES of the
      // append-only file — arrival order — so a `--pull-hosts` backfill of historical events is
      // delivered even though the ts-sorted fold places it at an early index.
      const cursor = await resolveWatchCursor(runDir, o.since);
      const tail = createLedgerTail(join(runDir, "events.jsonl"), { offset: cursor.offset });
      let cursorId = cursor.lastEventId;
      const nudgeBaseline = o["nudge-since"] != null ? Number(o["nudge-since"]) : await readNudge(runDir);
      const wakeSet = parseWakeOn(o.wakeOn);
      const pullHostNames = hostsToPull({ hosts: getHosts(), spec: o.pullHosts });
      const reconcileMerged = !!o.reconcileMerged;
      const reconcilePrEvents = !!o.reconcilePrEvents;
      const repoRoot = o.repoRoot ?? process.cwd();
      const pollMs = watchPollMs();
      const PULL_INTERVAL_MS = watchPullIntervalMs();
      const started = Date.now();
      let lastSideEffect = 0; // 0 ⇒ run pull/reconcile immediately on entry, then every ~45s
      // DER-2839 (Codex review of that change, #1): `pullHostInto` now REPORTS a failed remote read, and
      // this loop is its primary automatic consumer. Discarding the result — as it did — meant a mini
      // whose ledger is permanently unreadable stopped ingesting events indefinitely while the operator
      // saw routine watch output: the failure signal the fix introduced, silently thrown away by the one
      // caller that runs unattended.
      //
      // Latched per host and cleared by the next SUCCESSFUL pull, so it re-surfaces on every wake until
      // it is actually fixed — the same treatment as spawn_failures/gate_missing. Reported, never fatal:
      // the pre-start window before a remote host first writes its ledger is a legitimate failure, and
      // making it fatal would wedge the mini lane on a routine race.
      const pullFailures = new Map();
      // Hosts this run has dispatched a lead to. Seeded LAZILY and at most ONCE per watch process, then
      // kept current from the tail's fresh events below.
      //
      // DER-2741 (#16) is an explicit invariant of this loop — "work per poll scales with new activity,
      // not with total history" — and the first draft of this evidence gate broke it by calling
      // `readEvents` (a whole-ledger parse) on every ~45s side-effect cycle. On the 100k-event / 9.8 MB
      // ledger that benchmark uses, a single 240s watch would have added ~6 full parses while completely
      // idle. The existing idle-watch perf test did not catch it because it runs without `--pull-hosts`,
      // so the side-effect block never executes there.
      let dispatchHosts = null;
      // ── 2.2 — silence must be structurally impossible ─────────────────────────────────────────────
      // Shepherd #5 lost its watcher TWICE to the pattern `work/SKILL.md` §4 itself recommended
      // (background `watch` + `caffeinate -w <pid>`): the watcher exited after ~100s printing NOTHING,
      // which is indistinguishable from a quiet wake. A silently-blind shepherd is exactly the failure
      // that leaves a ready PR sitting unshepherded, and the orchestrator who used the same pattern all
      // shift could not rule out missed wakes either — there was no evidence in either direction.
      //
      // It was proven with two foreground controls: `--since 0` returned an event record immediately and
      // `--timeout 15` returned a timeout record at exactly 15s. `watch` ALWAYS prints. Therefore silence
      // implies killed, never woke. This trap makes that inference unnecessary by putting the terminal
      // record on stdout before dying, so "no output" stops being an ambiguous state the reader has to
      // interpret. Writing synchronously matters: a queued async write does not survive process.exit.
      const terminalOnSignal = (signal) => {
        try {
          writeFileSync(1, `${JSON.stringify({
            wake: "killed", signal, run: o.runId ?? null,
            elapsed_s: Math.round((Date.now() - started) / 1000),
            note: "watch was TERMINATED, it did not time out and it did not wake. Any event after the " +
              "cursor below is UNSEEN. Re-run watch with --since <cursor>. If this arrives ~100s into a " +
              "backgrounded watch, the harness that backgrounded it killed it — run watch in the FOREGROUND.",
            cursor: cursorId ?? null,
          })}\n`);
        } catch { /* a dying process that cannot write is beyond rescue; never mask the signal */ }
        process.exit(SIGNAL_EXIT_BASE + (signal === "SIGINT" ? 2 : 15));
      };
      const sigHandlers = [["SIGTERM", () => terminalOnSignal("SIGTERM")], ["SIGINT", () => terminalOnSignal("SIGINT")], ["SIGHUP", () => terminalOnSignal("SIGHUP")]];
      for (const [sig, fn] of sigHandlers) process.on(sig, fn);
      // Removed on every exit path, or `runSubcommand`'s in-process callers (the suite, chained
      // subcommands) accumulate one listener set per call and Node warns at 11.
      try {
      for (;;) {
        if ((pullHostNames.length || reconcileMerged || reconcilePrEvents) && Date.now() - lastSideEffect >= PULL_INTERVAL_MS) {
          for (const h of pullHostNames) {
            try {
              const pulled = await pullHostInto(runDir, h, o.runId);
              if (!pulled?.pull_failed) { pullFailures.delete(h); continue; }
              // Surface only with positive evidence that a readable ledger should exist: we have read
              // from this host before (a cursor past 0, or a held fragment), or the run dispatched a lead
              // there. Otherwise the failure is indistinguishable from "that host has not started yet",
              // which is a routine race and not news. `--pull-hosts auto` selects every ENABLED host,
              // which is not the same set as the hosts a run USES — without this gate a run that
              // dispatched everything locally carries a failure banner for an idle `mini` on every wake,
              // forever, and a banner that is always on is one operators learn to skim (Codex round 2,
              // #2). The ledger is consulted only on the failure path, and only until the answer is
              // known — a healthy run never reads it here at all.
              const everRead = (pulled.cursor ?? 0) > 0 || pulled.held != null;
              if (!everRead && dispatchHosts === null) {
                dispatchHosts = new Set(
                  (await readEvents(runDir)).filter((e) => e.type === "lead_spawned" && e.host).map((e) => e.host),
                );
              }
              if (everRead || dispatchHosts?.has(h)) pullFailures.set(h, pulled.pull_error || `exit ${pulled.exitCode ?? "?"}`);
              else pullFailures.delete(h);
            } catch (err) {
              // A throw is also "the pull did not happen" — it must not be quieter than a nonzero exit.
              // Unconditional: a throw is a harness/ssh fault, never the not-started-yet race above.
              pullFailures.set(h, String(err?.message ?? err));
            }
          }
          if (reconcileMerged) {
            try { await reconcileMergedInto(runDir, o.runId, repoRoot); } catch { /* gh best-effort */ }
          }
          if (reconcilePrEvents) {
            try { await reconcilePrEventsInto(runDir, o.runId, repoRoot); } catch { /* cloud best-effort */ }
          }
          lastSideEffect = Date.now();
        }
        // Every wake carries the UNHANDLED-pending banners (operator report 2026-07-26: "the nudge is
        // seen, then the session forgets about the nudge"). A rotate/kickback request must not depend
        // on the orchestrator remembering the wake that first surfaced it — the wake payload itself
        // re-surfaces everything still outstanding, every time, until it is actioned.
        const wakePayload = async (wake, extra = {}) => {
          const evs = await readEvents(runDir);
          const st = materializeState(evs, { run_id: o.runId, ledger: await readLedgerHealth(runDir) });
          return JSON.stringify({
            wake, events: evs.length,
            // The RESUMABLE cursor. `offset` is exact; `cursor` is the portable form (`--since <id>`);
            // `events` is the legacy count, still accepted by --since and still what old callers feed
            // back. Prefer `cursor`: a count cannot express "after this event" once a backfill has
            // shuffled the ts-sorted array.
            cursor: tail.lastEventId ?? cursorId ?? null,
            offset: tail.offset,
            ...(cursor.note ? { cursor_note: cursor.note } : {}),
            ...extra,
            pending: {
              kickbacks: st.kickbacks_pending ?? [],
              lead_rotate: (st.lead_rotate_pending ?? []).map((r) => r.issue),
              shepherd_rotate: !!st.shepherd_rotate_pending,
              leads_dead: (st.leads_dead ?? []).map((r) => r.issue),
              context_unreadable: (st.lead_context_unreadable ?? []).map((r) => r.issue),
              // DER-2739: a dispatch that FAILED. It re-surfaces every wake until a spawn actually works,
              // because the alternative — the old behaviour — was that it never surfaced at all and read
              // as healthy in-flight work. Role failures (no issue) appear as "shepherd"/"orch".
              spawn_failures: (st.spawn_failures ?? []).map((f) => f.issue ?? f.role),
              reap_failures: (st.reap_failures ?? []).filter((f) => !f.retracted).map((f) => f.label),
              // DER-2839: hosts whose remote ledger could not be READ this cycle — missing, unreadable, or
              // an ssh failure. Distinct from `held_fragment_stale` (a tail stuck MID-LINE, where the read
              // succeeded) because the remedy differs: nothing here has been ingested at all. Carries the
              // remote's own stderr, so the operator gets the reason and not just the fact.
              pull_failed: [...pullFailures].map(([host, why]) => ({ host, why })),
              // DER-2744: in-flight lanes whose transcript persistence was never proven. Every
              // transcript-reading instrument is blind for these, and a blind lane looks exactly like a
              // dead one — so it belongs next to leads_dead, not in a report nobody runs.
              transcripts_unverified: (st.transcripts_unverified ?? []).map((r) => r.issue),
              // DER-2603: a handed-off PR with no pre-PR gate event. It re-surfaces every wake because the
              // alternative — the old behaviour — was that it surfaced nowhere and `ready` called it
              // enqueueable. Cleared only by the gate actually running (a `review_findings` event).
              // 1.3 — every wake carries the waiver, so a successor orchestrator learns it from the
              // ledger instead of from a predecessor remembering to mention it. An EXPIRED waiver is
              // surfaced too: "it ran out" and "there never was one" oblige different actions.
              // 3.1 — surfaced every wake so an unread ruling cannot sit unnoticed.
              unacked_messages: (st.unacked_messages ?? []).map((m) => `${m.ref}${m.stale ? " (STALE)" : ""}`),
              // 3.2 — a sibling's freshest analysis, so two agents stop re-deriving the same answer.
              recent_notes: st.recent_notes ?? {},
              codex_waiver: st.codex_waiver?.active
                ? { until: st.codex_waiver.until, reason: st.codex_waiver.reason }
                : (st.codex_waiver?.expired ? { expired: true, until: st.codex_waiver.until } : null),
              gate_missing: (st.gate_missing ?? []).map((r) => r.issue),
              // DER-2782: the gate RAN and its findings are still open. Same wake-level treatment as
              // gate_missing — `ready` blocks it, so the orchestrator should see it long before enqueue.
              gate_blocked: (st.gate_blocked ?? []).map((r) => r.issue),
              // …and its audit counterpart, on EVERY wake while the unit is still in flight: the control
              // on a waiver nobody can hard-block is that nobody can miss it before it merges. Scoped to
              // non-terminal units here (the board keeps the permanent record) — a merged waiver nagging
              // forever is how a loud banner becomes one operators skim, which would defeat the point.
              gate_adjudicated: (st.gate_adjudicated ?? []).filter((r) => !DONE_STATUSES.has(r.status)).map((r) => r.issue),
              budget_tripped: (st.budget_trips ?? []).filter((t) => t.level === "tripped").map((t) => t.issue),
              // DER-2748: a version-skewed ledger surfaces on EVERY wake, not only when the orchestrator
              // happens to run `state`. It already blocks dispatch; this is how the operator learns why
              // before they hit the refusal. `state.protocol.reasons` names the hosts.
              protocol_skew: !(st.protocol?.ok ?? true),
              // DER-2738: lines of this ledger that never folded into state. Surfaced on EVERY wake for
              // the same reason as protocol_skew — an operator must not have to run `state` to find out
              // that the run's source of truth has holes in it. `state.ledger` names the file.
              ledger_damage: !(st.ledger?.ok ?? true),
              // DER-2776: hosts whose ledger tail has been stuck mid-line past the staleness threshold.
              // Its own key rather than a second cause of `ledger_damage` because the REMEDY is somewhere
              // else entirely — nothing here is repairable; the writer on that host is. Empty for the
              // routine case (a fresh hold is a live writer, not a fault) and self-clearing.
              ledger_held_fragments: (st.ledger?.held_fragments ?? []).filter((h) => h.stale).map((h) => h.host),
            },
          });
        };
        if ((await readNudge(runDir)) > nudgeBaseline) {
          return { stdout: await wakePayload("nudge") };
        }
        // One stat when idle; only the NEW bytes when something was appended (#16). Work per poll scales
        // with new activity, not with total history.
        const step = await tail.poll();
        if (step.bad.length) await recordLedgerDamage(join(runDir, "events.jsonl"), step.bad);
        if (step.events.length) {
          const fresh = dedupeLedgerEvents(step.events);
          if (fresh.length) cursorId = tail.lastEventId ?? cursorId;
          // Keep the pull-failure evidence set current from the NEW bytes we already parsed, so a lead
          // dispatched to a host mid-watch is recognised without a second whole-ledger read (DER-2741's
          // invariant). Only when the set has been seeded — otherwise the lazy seed below picks it up.
          if (dispatchHosts) for (const e of fresh) if (e.type === "lead_spawned" && e.host) dispatchHosts.add(e.host);
          if (!wakeSet || fresh.some((e) => wakeSet.has(e.type))) {
            return {
              stdout: await wakePayload("event", {
                // Echo the cursor the caller GAVE US, in the type they gave it (a legacy count stays a
                // number), so an existing consumer of this field sees no change of shape.
                since: o.since == null ? null : (/^\d+$/.test(String(o.since).trim()) ? Number(o.since) : String(o.since)),
                fresh: fresh.length,
                fresh_types: fresh.slice(0, 50).map((e) => e.type),
              }),
            };
          }
          // Consume noise: the offset has already advanced past it, so we keep blocking without re-scan.
        }
        if (Date.now() - started >= timeoutMs) return { stdout: await wakePayload("timeout") };
        // 2.3 — the loop notices its OWN missing time. A tick that should take ~pollMs and took 40
        // minutes was not running, and the host almost certainly slept. Recording it here turns a
        // blackout into a ledger event instead of a forensic exercise the next morning: on 2026-07-31
        // an 88-minute sleep was first reported as "it didn't sleep", because `uptime` and
        // power-assertion greps are both structurally incapable of reporting a past sleep.
        {
          const before = Date.now();
          await sleep(pollMs);
          const gap = sleepGapDetected({ expectedMs: pollMs, actualMs: Date.now() - before });
          if (gap) {
            await appendEvent(runDir, {
              actor: "orch", type: "host_sleep_detected", host: hostname(),
              ...gap, ts: new Date().toISOString(),
            }).catch(() => { /* a ledger write failure must never kill the watcher */ });
          }
        }
      }
      } finally {
        for (const [sig, fn] of sigHandlers) process.off(sig, fn);
      }
    }
    default:
      throw new Error(`unknown subcommand "${o.subcommand}"`);
  }
}

// DER-1993: the DER-1477 discipline (bounded watch blocks so a nudge/operator can always reach
// the loop within minutes) regressed once via prompt drift (2026-07-11, crept to ~9 min);
// prose doesn't durably hold it, so the runner clamps it.
export const WATCH_TIMEOUT_MAX_S = 300;
export function clampWatchTimeout(raw) {
  const s = Number(raw ?? 240);
  if (!Number.isFinite(s)) return 240;
  return Math.min(WATCH_TIMEOUT_MAX_S, Math.max(1, Math.floor(s)));
}

function usage() {
  return `work-runner — plumbing for the /work orchestrator (brain = the /work Claude session).

Usage: node scripts/work-runner.mjs <subcommand> [flags]

Subcommands:
  init-run --project <p> | --issues DER-1,DER-2 [--plan <run-plan.json>]  create run dir + ledger, print run-id (project | issue-list mode)
  create-worktree --run <r> <DER-id> [--bundle DER-x,DER-y]  git worktree add from fresh origin/main
                     (idempotent: RESUMES the run's own registered worktree, REFUSES any other occupant
                      with recovery steps, and never deletes anything — DER-2742)
  write-brief --run <r> <DER-id> [--bundle DER-x,DER-y] [--kickback n] [--worktree p] [--title t] [--acceptance a] [--findings f] [--lead-type claude|kimi|gpt|dsv4]
              [--plan <run-plan.json> | --budget-files N --budget-additions N]  stamp the ASSIGNED budget into the brief
  spawn-lead --run <r> <DER-id> --worktree <p> [--bundle DER-x,DER-y] [--kickback n] [--model opus] [--lead-type claude|kimi|gpt|dsv4] [--dry-run]
  spawn-cloud --run <r> <DER-id> --worktree <p> [--host cloud] [--model opus|sonnet] [--kickback n] [--rotation n] [--push] [--dry-run]
                                              dispatch a CLOUD lead as a \`claude --cloud\` session and record
                                              its session id as the receipt. REFUSES: a branch not on origin
                                              at the worktree's HEAD sha (the session clones the ref checked
                                              out there — a local-only commit dies at provisioning with 0
                                              turns), a host with no credProfile (the profile is the account
                                              and the account is the environment), and a second FIRST spawn
                                              (nothing here can close a cloud session, so two leads would
                                              push to one branch — steer instead). An absent session id
                                              records lead_spawn_failed; it is never synthesized.
  steer-cloud --run <r> <DER-id> [--kickback n] [--message <t>] [--session session_…] [--pr n] [--dry-run]
                                              DELIVER a kickback into the LIVE cloud lead (it still holds the
                                              context of the work the findings are about) — records
                                              kickback_relayed, never a second lead_spawned. Proven by the
                                              CLI's own "Sent to cloud session", not by exit 0; an unproven
                                              steer records NOTHING so the round stays pending, and prints
                                              the spawn-cloud fallback for an expired session.

Lead types: pass the SAME --lead-type to write-brief AND spawn-lead. The brief then names the type's
concrete per-slot models. EVERY type renders the mandatory 3-lens adversarial review panel (DER-2360);
the shell-out model comes from the type's 'panelModel', else a subscription-billed 'reviewerModel',
else 'opus'. Non-Claude types are host-local only.

Bundling: --bundle names the EXTRA issues one lead ships in the SAME worktree/branch/PR (SKILL.md §2
"Bundling"). The positional <DER-id> stays the PRIMARY id that keys every ledger event; the brief
tells the lead to implement all, verify the union of ACs, and open ONE PR referencing every id.

Run plan (2026-07-25): /prep-for-work sizes each issue against the real codebase, splits anything over
~800 additions / ~12 files into PR-sized Linear children, and emits a run plan. "init-run --plan" records
it; every "write-brief" then stamps that issue's ASSIGNED budget into the brief, so the lead's plan_scope
is CHECKED against a number instead of self-graded — and "budget" flags any unit whose own declaration
already busts it (over plan), which is the cheapest moment to split. Runs with no plan are unchanged.
DER-2746: "init-run --plan/--spec" now runs the CANONICAL validator (prep-for-work/prep-runner.mjs
validatePlan) at exactly the strictness "prep-runner validate" applies — errors REFUSE the run and leave no
run dir, warnings are advisory (returned as result.planWarnings, never on stdout). A plan that "prep-runner
validate" rejects can no longer start a run: before this, a poison plan failed validate with 11 errors and
then init-run'd with exit 0, and write-brief stamped its 98-file / 11,537-addition budget into the brief.
  spawn-shepherd --run <r> [--project p] [--dry-run]
  spawn-orch --run <r> [--project p] [--model m] [--dry-run]   boot a SUCCESSOR orchestrator (/work resume <r>) — routine rotation
  append --run <r> '<event-json>'             atomic append to events.jsonl. Two types are RESERVED for
                                              their own subcommands and refused here: gate_adjudication is
                                              VALIDATED (DER-2782), and run_completed is rejected outright —
                                              use complete-run, which gates it (DER-2838).
  heartbeat --run <r> [--host <name>]         record THIS host's harness version in the ledger (DER-2748) —
                                              RUN IT ON THE HOST (over ssh for a mini); --host is a label.
                                              Once per host per run; mixed versions then REFUSE dispatch
                                              (override deliberately with --allow-version-skew)
  state --run <r>                             materialize + print state.json
  usage --run <r> | usage --all               fold token_usage telemetry → usage.json/usage.md (per-run) or the cross-run fleet view
  lead-context --run <r> [--emit] [--json]    read every in-flight lead's context utilization (local + mini; cloud is not pollable)
  lead-context --worktree <p> [--lead-type t] [--window N] --json   single-worktree probe (this is what runs over ssh on the mini)
  rotate-lead --run <r> <DER-id> [--rotation n] [--title t] [--acceptance a] [--dry-run]
                                              respawn-over-compact for a LEAD: close workspace (KEEP worktree) →
                                              WIP commit → read handoffs/<ID>.rot<n>.md → tight resumption brief → respawn

Context rotation (2026-07-25): the orchestrator and shepherd both rotate before they degrade; leads did
not, so they ran to their ceiling and stalled. Thresholds are per LEAD TYPE — arm/rotate at 55%/70% of a
sub-1M window, 30%/45% at >=1M (effective context is ~300-450K there); override per type with
rotateArmPct/rotatePct in .claude/work.config.json. A lead arms itself at the arm band (writes
handoffs/<ID>.rot<n>.md + appends rotate_requested); "lead-context --emit" is the BACKSTOP that raises the
same flag for a lead that never asked. state.lead_rotate_pending surfaces both. Rotations ride their own
axis (they are not kickback rounds) and are capped at ${ROTATION_CAP} — the next request is a budget trip.
Design: the README's context-rotation section.

  reap --run <r> <DER-id> [--abandon]         git worktree remove + close EVERY workspace the issue ever had
                                              REFUSES (DER-2775) an id that is not a unit of this run, and any
                                              unit still ACTIVE (in_progress/pr_open/kickback) — that reap
                                              DESTROYS its uncommitted work. Reap after the work lands.
                                              --abandon (alias --force) says "destroy it anyway" out loud and
                                              stamps abandoned:true on the reaped event; it does NOT make an
                                              unknown id reapable. The remote kill is now kill-THEN-PROBE:
                                              a lead still alive after pkill leaks (cleanup_ok:false), and an
                                              unverifiable kill leaks too — never a clean receipt.
  ready --run <r> [PR…] [--json]              per-PR merge gate (H5): BOTH Codex surfaces author-filtered, checks
                                              captured once, throttled-null threads = UNKNOWN never 0, cancelled-run
                                              note, behind-main column (CI tests the MERGE tree — H11). Resolves the
                                              merge mode once (repo.mergeMode, else a queue probe) and prints the exact
                                              command: *** ENQUEUEABLE *** → gh pr merge <n> --auto on a queue repo,
                                              *** MERGEABLE (direct) *** → gh pr merge <n> --<strategy> --delete-branch
                                              on a queue-less one. No go-ahead word ⇒ do not land the PR (DER-2753).
                                              PRE-PR GATE (DER-2603): NEITHER word is printed without a review_findings
                                              event for the PR's unit. gate=MISSING = the gate never ran (run it);
                                              gate=UNKNOWN = the evidence was UNREADABLE (no --run, PR not in the
                                              ledger, pre-stamp ledger) — both hold, and they are different jobs.
  complete-run --run <r> [--dry-run] [--allow-version-skew]
                                              END the run: append run_completed so state.status folds to
                                              "completed". THE ONLY writer of that event — append refuses
                                              the type (DER-2838). FAIL-CLOSED and there is no --force — it
                                              refuses, listing EVERY failing check and appending nothing,
                                              unless all of: at least one tracked unit and every one of them
                                              terminal (merged/reaped); no un-delivered kickback; no
                                              unacknowledged quarantined line; no STALE held remote fragment
                                              (DER-2776 — a writer that died mid-line is still withholding
                                              events; ack it by deleting its sync-held.<host>.json); ledger
                                              health ok; wire protocol ok — INCLUDING the version THIS
                                              process is running, not only the ones already recorded
                                              (DER-2838; --allow-version-skew acknowledges a mid-run host
                                              upgrade, never a foreign schema_version).
                                              The marker carries a COMPLETION RECEIPT naming the units and
                                              checks the gate passed, and the fold ignores a run_completed
                                              that has none or whose receipt disagrees with the ledger — so a
                                              hand-written marker cannot end an active or empty run. It is an
                                              INTEGRITY record, NOT authentication (SECURITY.md); ignored
                                              markers are listed in state.run_completion_rejected.
                                              PULL AND RECONCILE FIRST (pull-host per mini, reconcile-pr-events):
                                              this reads the CANONICAL ledger, so events still sitting on a host
                                              are invisible to every check above.
                                              A second call is a no-op success ("already completed", first-wins).
                                              A late event does NOT reopen the run — it folds onto its own unit
                                              and is counted in state.post_completion_events.
  preflight [--skip-probes]                   test the DEPLOYED harness before a run: unit suite, cmux, gh identity,
                                              disk, transcript persistence, telemetry hooks, skills sync per host,
                                              stale runner copies, 1-token Claude probe per account, codex gate probe.
                                              Gate the run on the printed PREFLIGHT GREEN marker.
  sweep-workspaces --run <r> [--keep refs] [--dry-run]   close every leaked pane the ledger knows: done units,
                                              kickback/rotation predecessors, prior shepherds + orchestrators
  pull-host --run <r> --host <h>              merge host <h>'s mini-local ledger into the canonical one
  reconcile-pr-events --run <r>               fold cloud leads' draft-PR lifecycle + WORK-EVENT comments in; refresh links.md (DER-1834)
  links --run <r>                             write <run-dir>/links.md — per-lead claude.ai/code monitor URLs (item 7)
  watch --run <r> [--since <event_id|count>] [--timeout 240, max 300] block until a new ledger event / nudge / timeout
                          prints {wake,events,cursor,offset,fresh_types,pending}. PREFER --since <cursor> (the
                          event_id echoed back): a count cannot say "after this event" once a --pull-hosts
                          backfill has shuffled the ts-sorted fold (DER-2741). A count still works.
        [--wake-on actionable|<csv>]          only wake on these event types (default: any new event)
        [--pull-hosts auto|<csv>]             each ~45s, tail these mini hosts' ledgers into the canonical one
        [--reconcile-merged]                  each ~45s, fold 'gh pr list --state merged' truth in (reap out-of-band merges)
        [--reconcile-pr-events]               each ~45s, fold cloud draft-PR lifecycle in + refresh links.md (cloud runs)
  panel-prompt --lens <correctness|security|repro|codex|verify> [--issue ID] [--diff <file>] [--union <file>]
              [--acceptance <text>] [--base <ref>]
                                              render ONE lens's adversarial-review prompt (DER-2360), path-routed
                                              to the repo-specific checklists the diff's files trigger. Print it
                                              to a file and feed it to the lens shell-out on STDIN — never as a
                                              trailing argument ('--allowedTools' is variadic and swallows it,
                                              producing an empty review and a zero-byte output file).
                                              --lens codex renders the CROSS-VENDOR prompt (DER-3011): the union
                                              of all three mandates + every routed checklist, answering in the
                                              codex --output-schema shape. One process against three, so it gets
                                              the whole mandate rather than a third of it.
  review-panel --run <r> --issue <ID> [--pr <n>] --sha <40-char> \
              --lens-file <lens>=<file.json> (x2+) [--verify-file <f>] [--falsify <f>] [--base <ref>]
              [--diff <file>] [--round n] [--model <id>] [--dry-run] \
              [--codex-review <out.json> --codex-log <run.jsonl> | --codex-waived "<why not>"]
                                              The FALLBACK pre-PR gate (codex exec every round is the default
                                              since ADR-0027 SS2's 2026-08-12 amendment; run-gate.sh decides).
                                              Reads each lens's 'claude -p --output-format json'
                                              envelope, unions the findings, and writes ONE review_findings event
                                              with gate_kind=panel + models_observed (the model that ACTUALLY ran,
                                              read from modelUsage — DER-2293), so 'ready' prints gate=PANEL.
                                              FAILS CLOSED: refuses a lens that failed, went silent, answered in
                                              prose, or was named twice; refuses <2 lenses or a short --sha.
                                              Majority prioritizes but NEVER erases — the blocker class is sticky,
                                              and a blocker dies only by positive falsification (evidence checked,
                                              not trusted) or a gate_adjudication. --dry-run prints the union
                                              without writing, which is what the verification pass reads.
                                              DER-3011 — ROUND 1 must attest the CROSS-VENDOR codex pass: either
                                              --codex-review + --codex-log (its findings then join the union as
                                              the 'codex' lens, so a codex P1 is a panel blocker) or
                                              --codex-waived "<reason>". Findings WITHOUT the JSONL are refused:
                                              a codex run that dies exits 0, so a payload alone cannot tell
                                              "reviewed, found nothing" from "never ran". The waiver NEVER
                                              blocks; a round-1 receipt SILENT about both does.
  codex-probe [--issue ID] [--print-bin]      is codex reachable RIGHT NOW? Runs the stdin-CLOSED probe against
                                              the resolved binary (never a bare 'codex' — a cmux shim hangs at 0%
                                              CPU byte-identically to a quota wall) and judges the TEXT, never the
                                              CPU and never 'codex login status' (which reports healthy while
                                              every call 401s). Exit 0 = reachable. Nonzero PRINTS the ready-to-
                                              paste --codex-waived line. NO OUTPUT is UNKNOWN, never "down".
                                              --print-bin resolves the binary for this host and nothing else.
  codex-backstop [--issue ID]                 print the LOCAL 'codex exec' second-opinion command. The panel is
                                              the gate; this is the deliberate backstop for a risk lane (auth /
                                              RLS / schema / money / migration) or for calibrating the panel with
                                              review-fidelity. Refuses a shim or an unresolvable binary — a bare
                                              'codex' can hang at 0% CPU indistinguishably from a quota wall.
  review-swap --run <r> --issue <ID> [--pr <n>] --sha <40-char> \
              [--engine claude] [--model <id>] --lens <name> (x2+) --verdicts <file.json>
                                              POSTURE C: record a SUBSTITUTE adversarial review when codex is
                                              down BOTH as a bot and as 'codex exec'. Writes ONE review_findings
                                              event carrying engine/model/lenses/verdict_per_lens/substitute, so
                                              'ready' prints gate=SUBSTITUTE instead of mistaking it for codex.
                                              FAILS CLOSED like codex does: refuses <2 lenses, a missing or empty
                                              lens verdict, or a --sha that is not 40 chars. Records
                                              lenses_requested vs lenses_returned, so a 1-of-3 panel is visible
                                              as 1-of-3 and can never render as a full swap.
                                              NEVER hand-write a review_findings event: the ledger is append-only.
  waive-codex-gate --run <r> --reason <text> --until <iso8601>
                                              stop 'ready' holding on the review-coverage check when codex is
                                              dead AND no panel receipt exists. Appends codex_gate_waived → state.codex_waiver, surfaced on
                                              every watch wake. --until is REQUIRED (a waiver must expire by
                                              construction). IT DOES NOT WAIVE EVIDENCE: 'ready' still blocks any
                                              PR with no review_findings covering its head — it converts
                                              "must be codex" into "must be SOME recorded adversarial review".
  rotate-shepherd --run <r> [--model m]       respawn the shepherd WITH a handoff (4.1). Checkpoints
                                              shepherd-notes.md, renders briefs/shepherd.rot<n>.md, spawns
                                              via spawn-shepherd (so the unproven-spawn refusal applies),
                                              then VERIFIES a new shepherd_spawned landed. spawn-shepherd
                                              alone silently loses in-flight reasoning.
  staleness-check --run <r> [--issue ID] [--symbol S ...]
                                              at dispatch time, 'git log -S<symbol>' each queued unit's
                                              symbols against current main and print WHERE each landed
                                              (commit + subject + date) -- never a count. A symbol's
                                              presence is NOT the feature's presence: DER-2814 matched
                                              'preflight' 8x on an unrelated body-size budget and read
                                              ALREADY DONE, while DER-2594 sat Todo ~21h already fixed.
  nudge --run <r>                             wake a blocking watch immediately (freed slot / operator change)

Multi-host: create-worktree/spawn-lead/reap accept --host <local|mini|cloud>; hosts are configured in
.claude/work.config.json (see the README's multi-host section).
Lead types (CLIProxyAPI comparison): spawn-lead --lead-type <name> spawns a lead on a non-Claude model
(kimi/gpt) routed through the local CLIProxyAPI gateway, to compare lead performance. Types are defined
in .claude/work.config.json leadTypes; proxy-backed types run on --host local only (localhost gateway).
See the README's lead-types section.
Lead concentration (DER-1834): init-run accepts --host <name> (FORCE every lead onto <name>, e.g.
--host cloud) or --prefer <name> (try it first, then overflow) — recorded in run_started for pickHost.
Cloud host (kind:"cloud"): write-brief --host cloud emits the cloud-session brief, then spawn-cloud
dispatches it as a \`claude --cloud\` session (2026-08-18 — the RemoteTrigger routine recipe is retired).
Two preconditions, both enforced: a WORKTREE (the session clones the ref checked out there — there is no
branch-selection flag) whose branch is on origin at the same sha (--push publishes it), and a credProfile
on the host entry (the profile is the account, and the ACCOUNT'S default cloud environment is the env —
--environment takes only ccpool_… ids). A cloud kickback is a steer-cloud into the LIVE session, not a
fresh spawn. Reporting is unchanged: WORK-EVENT PR comments folded by reconcile-pr-events.
See SKILL.md §3 "Cloud host dispatch".

Env: WORK_CMUX_BIN (override cmux path). Runs live under tmp/work/<run-id>/ (gitignored).`;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.subcommand) {
    console.log(usage());
    return;
  }
  const res = await runSubcommand(process.argv.slice(2));
  if (res && res.stdout != null) console.log(res.stdout);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
