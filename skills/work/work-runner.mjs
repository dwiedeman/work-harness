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
import { existsSync, readFileSync } from "node:fs";
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
    // Re-score an already-scored (pr, round) in review-fidelity instead of returning the prior result.
    else if (a === "--force") o.force = true;
    else if (a === "--branch") o.branch = argv[++i];
    else if (a === "--slug") o.slug = argv[++i];
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--lead-type") o.leadType = argv[++i];
    else if (a === "--file") o.file = argv[++i];
    // `--issue DER-x` is an explicit alias for the positional id — review-usage reads better with it,
    // and a lead pasting a long shell block is less likely to drop a flagged value than a bare token.
    else if (a === "--issue") o.issueIdFlag = argv[++i];
    else if (a === "--round") o.round = Number(argv[++i]);
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
function kickbackSharedLines({ findings, priorRounds, kickback }) {
  const lines = [
    ``,
    `### Findings`,
    ``,
    findings || "(see the PR review threads)",
    ``,
    `**FIRST, acknowledge receipt** (messages between sessions can queue unseen — the ledger, not the message, is the delivery record): \`… append … '{"actor":"lead:<id>","type":"kickback_ack","issue":"<id>","round":${kickback ?? 1}}'\` using the exact append command from your original brief. The orchestrator respawns this round if no ack lands in ~10 min.`,
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
  // In subscription mode the reviewer is launched by the brief's shell-out, so the model here is the
  // CLI alias (`opus` auto-resolves to the latest Opus the installed CLI knows — harness-wide policy,
  // spec §3.7), not a provider-qualified id.
  const reviewerLaunchModel = subscriptionReview ? (ltCfg.reviewerModel ?? "opus") : ltCfg.reviewerModel;
  const reviewerModel = ltCfg.reviewerModel;
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
    `   **Scope contract (2026-07-25):** the declared \`fileScope\` bounds this PR. If the real change needs **more than 1.5× the declared file count**, STOP and say so in a \`plan_scope\` re-emission plus a note to the orchestrator — do not silently grow. ${assignedBudget ? `Your **assigned budget is ${assignedBudget.files} files / ~${assignedBudget.additions} additions** (see above) — declare against it, do not raise it.` : "Aim for **≤ ~800 additions / ≤ ~12 files**"}; a PR that outgrows that should be split. Measured 2026-07-25: review rounds scale directly with diff size (<1k additions → 1.25 rounds; >7k → 5.67), and the run whose PRs averaged 3,754 additions took 8 kickbacks per merged PR versus 0.18 when they averaged 541. A PR with NO declared scope is the worst case of all — the one that shipped 98 files and +11,537 lines took 5 rounds and never merged.`,
    externalReviewer
      ? `3. **Build by DELEGATING — on this lead type that is an instruction, not a style preference.** (Measured 2026-07-24: a lead on this tier made 220 model calls and ZERO Agent calls, implementing every line itself — and a lead that never dispatches a subagent also never runs step 5's review gate.) Decompose into 2–4 chunks and dispatch each with the **Agent tool**, \`model: "sonnet"\` (routes to ${ltCfg.subagentModel ?? "your subagent tier"}); research/codebase-mapping goes to \`"haiku"\` (${ltCfg.researchModel ?? ltCfg.subagentModel ?? "same"}). You plan, adversarially review each returned diff, and integrate — you do not write the bulk of the implementation yourself. Run subagents in the FOREGROUND. Read-only work fans out freely; parallel EDITS only on disjoint files via Agent \`isolation:"worktree"\`, then integrate onto the issue branch. NEVER dispatch model-less (it inherits YOUR tier); reserve \`opus\` for step 5's single final reviewer.`
      : `3. Build in bite-size chunks with in-process subagents (Sonnet 5 / Haiku). **Model discipline:** dispatch EVERY subagent with an explicit model alias — \`sonnet\` for implementation, \`haiku\` for research; NEVER model-less (a model-less subagent inherits your lead-tier model) and reserve \`opus\` for step 5's single final reviewer. Run subagents in the FOREGROUND (background task handles are unreliable on proxy-backed leads). Read-only work fans out freely; parallel EDITS only on disjoint files via Agent \`isolation:"worktree"\`, then integrate diffs onto the issue branch.`,
    `4. Targeted local verify: typecheck + lint the changed package + touched test files (+ one \`*.db.test.ts\` if you touched DB/RLS). NOT full remote CI. **EXCEPTION — deterministic guards are YOUR gate:** if the diff adds/changes a command, MCP tool, or reference guide, or touches \`packages/commands\`/\`packages/reference\`/\`apps/cli\`, also run \`pnpm check:manifest && pnpm check:cli-version && pnpm check:docs-version && pnpm docs:check\` + the registry tests (ui-surface-parity, command-tools, inventory, agent-how-tos) before handing off — seconds each; every skipped one is a guaranteed kickback round.`,
    externalReviewer
      ? `5. **Final adversarial review — MANDATORY GATE, see "${REVIEW_GATE_HEADING}" below.** ${subscriptionReview ? "It is a **shell-out**, NOT an Agent subagent (a subagent would inherit your own cheap tier and silently fake the gate) — the block below is copy-paste-able and self-recording." : `Dispatch ONE review subagent with model \`opus\`; on this lead type that slot resolves to **${reviewerModel}**.`} It is the quality floor for this PR, not a formality. Address its findings BEFORE hand-off.`
      : `5. Final adversarial self-review (correctness / security / tests): dispatch ONE review subagent with model \`opus\` — the reviewer slot resolves to your OWN tier (Claude lead → Opus; gpt lead → gpt-5.6-sol; kimi lead → kimi-k3), so the reviewer matches the lead's strength. Fix findings before hand-off. (External model council is v2 — off for MVP.)`,
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
    `> Write your findings to \`${runDir ?? "<run-dir>"}/subagent-notes/${issueId}/<label>.md\` **as you go**, not at the end. Return **≤500 words + that path** — never a dump; cite \`file:line\` instead of pasting code. If you approach your context limit: finalize the file, then return \`done\` or \`partial\` plus exactly what remains.`,
    ``,
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
  lines.push(
    ``,
    `## ${CODEX_GATE_HEADING}`,
    ``,
    `Run this on EVERY hand-off, on every lead type. It is the same reviewer family that reviews your PR on GitHub minutes later, so anything it catches here is a kickback round you do not pay for. Measured 2026-07-25 on PR #1027: this pass caught **3 of the 4 findings** the GitHub Codex bot went on to post, before the bot ran.`,
    ``,
    `**Run it from your worktree** (it needs \`node_modules\` present — on a bare checkout it silently skips the test run and goes blind), after targeted verify is green and BEFORE \`gh pr create\`:`,
    ``,
    "```bash",
    `# 1. write the review prompt. The SEARCH MANDATE is the load-bearing part — a diff-local codex`,
    `#    pass measured 2 shell commands and 0 findings where this one ran 21 and found 6.`,
    `cat > /tmp/${issueId}-codex-review.md <<'PROMPT'`,
    `Review the branch diff: git diff origin/main...HEAD  (run it yourself).`,
    ``,
    `Focus on issues that impact correctness, security, tenant isolation, maintainability, or`,
    `developer experience. Flag only actionable issues INTRODUCED by this diff.`,
    ``,
    `EXHAUSTIVE SEARCH IS REQUIRED — do not review the diff in isolation:`,
    `  - grep every call site, sibling, and consumer of what the diff changes; say whether the`,
    `    change is complete across all of them;`,
    `  - when the diff edits ONE member of a family (table/registry/enum/switch entry, one branch`,
    `    of a guard, one of several parallel implementations), enumerate the family and check each;`,
    `  - when the diff adds or edits a doc, spec, comment, or config, verify the code in the SAME`,
    `    diff matches it — including anything the text says NOT to do yet;`,
    `  - prefer EXECUTING the changed code (node -e, the test runner) over reasoning about it;`,
    `  - git log / git blame for why the surrounding code looks the way it does.`,
    ``,
    `Obey the "## Code Review Rules" sections of the repo's AGENTS.md files, including their`,
    `"Do not flag" lists. Do not report anything a \`pnpm check:*\` script or guard test already`,
    `enforces mechanically.`,
    ``,
    `Acceptance criteria this change must meet: <paste the AC bullets from the brief>`,
    `PROMPT`,
    `# 2. run it read-only with the JSON schema, then record + print the findings in one step.`,
    codexReviewCommand({
      promptFile: `/tmp/${issueId}-codex-review.md`,
      outFile: `/tmp/${issueId}-codex-review.json`,
      logFile: `/tmp/${issueId}-codex-review.log`,
    }),
    `${runner} review-usage --run ${runId ?? "<run>"} --runs-root ${appendRunsRoot} --issue ${issueId} --round 1 --reviewer codex --file /tmp/${issueId}-codex-review.json --log /tmp/${issueId}-codex-review.log`,
    "```",
    ``,
    `That last command appends a \`review_findings\` event (the shepherd's machine-checkable proof the gate ran) AND prints the findings for you to act on. Fix every P0/P1, or reject it IN WRITING in the PR body with a reason the shepherd can audit. Put \`Codex review: <verdict>, round N, 0 open blockers\` in the PR body.`,
    ``,
    `⚠ It takes ~3–8 minutes and rides the **ChatGPT** subscription, not the Anthropic one — it does not spend your lead budget.`,
  );
  if (externalReviewer) {
    lines.push(
      ``,
      `## ${REVIEW_GATE_HEADING}`,
      ``,
      `This runs IN ADDITION to the Codex gate above — different vendor, different blind spot. Measured: on one PR the Codex pass found authority bugs in the TypeScript while the GitHub bot stayed inside the \`.sql\`; on another the reverse. Two reviewers that fail differently beat one that fails twice.`,
      ``,
      `Your implementation tier is cheap; your reviewer is not. **Claude ${reviewerLaunchModel === "opus" ? "Opus" : reviewerLaunchModel}, on the operator's subscription**, is the external quality floor on this PR — the deal is: you write, it attacks, you fix. Run it EXACTLY once per hand-off (twice at most, see 4).`,
      ``,
      `> **⚠ Do NOT dispatch this as an Agent/Task subagent.** Every subagent you spawn inherits THIS process's`,
      `> endpoint and model aliases, so an in-process "opus" reviewer silently runs on your own cheap tier —`,
      `> measured 2026-07-24: a lead dispatched \`model: "opus"\` with a perfect review prompt and got 19/19 calls`,
      `> on the flash tier, while its PR was about to claim an Opus review. The review is a **shell-out** that`,
      `> unsets the provider env, so it runs as a separate process on the Claude subscription. Run it VERBATIM:`,
      ``,
      "```bash",
      `# 1. review-sized context — the diff, nothing more`,
      `git diff origin/main...HEAD > /tmp/${issueId}-review.diff`,
      `# 2. write the review prompt (acceptance criteria above + the conventions of the packages you touched)`,
      `cat > /tmp/${issueId}-review-prompt.md <<'PROMPT'`,
      `You are an adversarial reviewer. This is a GATE, not a suggestion. Start from the diff at`,
      `/tmp/${issueId}-review.diff and the per-package AGENTS.md of every package it touches —`,
      `including their "## Code Review Rules" sections, which are binding for this review.`,
      `Find every defect, vulnerability, silent-failure path, spec deviation, and convention violation.`,
      ``,
      `SEARCH THE REPOSITORY. Do not review the diff in isolation — the expensive defects are only`,
      `visible in code the diff does NOT touch. Before you finalize:`,
      `  - grep every call site, sibling, and consumer of anything the diff changes, and say whether`,
      `    the change is complete across all of them;`,
      `  - when the diff edits ONE member of a family (a table/registry/enum/switch entry, one branch`,
      `    of a guard, one of several parallel implementations), enumerate the whole family and check`,
      `    each member — report the class, not the single call site;`,
      `  - when the diff adds or edits a doc, spec, comment, or config, verify the code in the SAME`,
      `    diff matches it, including anything the text says NOT to do yet;`,
      `  - prefer EXECUTING the changed code (node -e, the test runner, a REPL) over reasoning about`,
      `    it. An executed counterexample is a finding; a hunch is not. You have Bash for this.`,
      `  - use git log / git blame for why the surrounding code looks the way it does.`,
      ``,
      `Posture: comprehensive threat model — correctness, tenant isolation/RLS, secret handling, spec`,
      `conformance, convention compliance. Rank each finding blocker / major / minor with file:line.`,
      `Do NOT report anything in the "Do not flag" list of the root AGENTS.md Code Review Rules, and`,
      `do not report what CI already enforces mechanically — both cost a round without adding signal.`,
      `Acceptance criteria this change must meet: <paste the AC bullets from the brief>`,
      `PROMPT`,
      `# 3. run it on the SUBSCRIPTION (provider env unset) and record it in one step.`,
      `#    Two traps, both observed live: pass the prompt on STDIN as shown (--allowedTools is VARIADIC`,
      `#    and swallows a trailing prompt argument, producing an empty review + a zero-byte file), and`,
      `#    use the BARE alias below — a provider-qualified id (anthropic/claude-opus-5) does NOT exist`,
      `#    on the subscription and the call errors out.`,
      reviewShellCommand({ model: reviewerLaunchModel, promptFile: `/tmp/${issueId}-review-prompt.md`, outFile: `/tmp/${issueId}-review.json` }),
      `${runner} review-usage --run ${runId ?? "<run>"} --runs-root ${appendRunsRoot} --issue ${issueId} --round 1 --file /tmp/${issueId}-review.json`,
      "```",
      ``,
      `That last command PRINTS the review findings for you to act on AND appends the reviewer's own token usage (role \`reviewer\`, with its real model id) to the run ledger — that event is the machine-checkable proof the gate ran, and it lands in \`work-metrics\`' role × model table. It REFUSES to record a failed review run, and warns loudly if the review did not actually ride the subscription.`,
      ``,
      `1. **When:** after your own targeted verification (typecheck/lint/touched tests) is green, and BEFORE \`gh pr create\` / hand-off. Not earlier — reviewing a moving diff wastes it. Not later — the shepherd is not a substitute for this gate.`,
      `2. **What it gets — and what it must go find.** SEED it with the diff, the acceptance criteria, and the touched packages' \`AGENTS.md\` (including their \`## Code Review Rules\` sections). Do NOT paste the rest of the repo in — but the reviewer MUST search it. Dumping context is waste; **agentic searching is the whole point**, and the two are not the same thing. Measured 2026-07-25: a diff-local reviewer ran 2 commands and found 0 issues on a PR where a searching reviewer ran 21 and found 6, including two P1s the GitHub Codex bot never posted. Require it to: grep every call site, sibling, and consumer of what the diff changes; enumerate the WHOLE family when the diff edits one member of a table/registry/enum/switch/guard; \`git log\`/\`git blame\` for why surrounding code looks the way it does; and **prefer EXECUTING the changed code** (\`node -e\`, the test runner, a REPL) over reasoning about it — an executed counterexample is a finding, a hunch is not.`,
      `3. **Posture:** adversarial, comprehensive threat model — correctness, tenant-isolation/RLS, secret handling, spec conformance, convention compliance, silent-failure paths. Plus the classes the Codex reviewer actually posts (root \`AGENTS.md\` § *Code Review Rules*): incomplete change across a family, silent loss of explicit input, error precedence letting a descriptive error beat an authority check, predicates comparing the wrong operand, and claims the diff does not keep (a doc/config contradicting code in the SAME diff). Findings ranked **blocker / major / minor**.`,
      `4. **Address, don't relay:** fix every blocker and major, or reject it IN WRITING in the PR body with a reason the shepherd can audit. Re-review ONCE if the fixes were substantial (re-run the block above with \`--round 2\`) — **cap 2 rounds**; a third means you're thrashing, so hand off with the findings attached instead. Minors may be deferred: note them in the PR body under "Deferred minors" (finding + file:line) for the shepherd's review-debt pass — do NOT file your own Linear issue; the shepherd folds it into an existing per-class \`review-debt\` issue or mints one only if no matching class issue exists (2026-07-27 exhaust policy).`,
      `5. **Evidence in the PR body (the shepherd checks this):** a line reading \`Adversarial review: <the model id the command printed>, round N, 0 open blockers\`. A missing or unresolved blocker list is an automatic kickback — same discipline as an unresolved Codex thread.`,
      ``,
      `Every in-process subagent stays \`sonnet\`/\`haiku\`; model-less subagents are banned (they inherit YOUR tier). The TUI cost counter is wrong by design on this lead type — ignore it; the ledger events are the truth.`,
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
// Code cloud session (Anthropic-managed VM): no worktree, no cmux, spawned by the ORCHESTRATOR via the
// RemoteTrigger tool (work-runner can't auth to claude.ai). Ledger reporting is a WORK-EVENT PR
// comment the orchestrator folds via `reconcile-pr-events`.
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
  p(`Scheduled by **${owner}**, the repository owner, from their own Claude account via a one-shot routine on their own cloud environment. The env's \`GH_TOKEN\` secret was configured by them for this. The commit-author convention below is the repo's own — verify it in the repo's agent instructions. You are a delivery lead for \`${repo}\`: take ${allIds.join(" + ")} to a clean PR and hand off (do NOT merge).`, ``);
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
    `   b. \`git checkout -b ${branch ?? "<gitBranchName>"}\`; make an empty WIP commit so a PR can open with no code yet: \`git commit --allow-empty -m "wip(${issueId}): cloud lead started"\`; push.`,
    `   c. **Open a DRAFT PR via the GitHub MCP tools** (draft:true, base main; authored by the configured commit author). A draft runs NO CI and NO Codex review — it's a placeholder. Title mentions ${allIds.join(" + ")}; body: one line noting it's a cloud lead in progress.`,
    `2. Read AGENTS.md + the area's invariants. **If the change isn't trivially clear, write a short plan FIRST, inline** — the \`/superpowers:*\` plugins (writing-plans, brainstorming, …) are NOT installed in cloud sessions (they're user-global, not repo-committed), so do not call them; instead jot: goal · exact files to touch · steps · definition-of-done · **reference-as-map** (the analogous existing implementation you're following, or "no analog exists"), then implement against it. (Repo-committed skills under \`.claude/skills\` and the built-in Skill tool ARE available.)`,
    `2b. **Declare your file scope BEFORE your first commit — MANDATORY (2026-07-25).** You have no ledger access, so emit it as a PR comment exactly like the token report in step 6:\n   \`gh api repos/${repo}/issues/<PR>/comments -f body='WORK-EVENT {"type":"plan_scope","issues":["${allIds.join('","')}"],"fileScope":["path/a.ts","path/b.ts"],"expectedAdditions":600}'\`\n   **This is a BUDGET, not a note.** The declared \`fileScope\` bounds this PR: if the real change needs **more than 1.5× the declared file count**, STOP, re-emit an updated \`plan_scope\`, and say so in the PR body — do not silently grow. ${assignedBudget ? `Your **assigned budget is ${assignedBudget.files} files / ~${assignedBudget.additions} additions** (see "Assigned budget" above) — declare against it, do not raise it.` : "Aim for **≤ ~800 additions / ≤ ~12 files**."} Measured 2026-07-25: review rounds scale directly with diff size (<1k additions → 1.25 rounds; >7k → 5.67), and cloud briefs previously never asked for this at all — the PR that shipped 98 files / +11,537 lines with no declared scope took 5 rounds and never merged.`,
    `3. **Build via subagent delegation — MANDATORY, not optional.** Decompose the change into 2–4 implementation chunks and dispatch each to a Sonnet 5 subagent via the Agent tool (\`model: "claude-sonnet-5"\`); research/codebase-mapping goes to Haiku. Run chunks IN PARALLEL whenever their file scopes are disjoint (one message, multiple Agent calls). You (the lead) plan, adversarially review each subagent's diff, integrate, and own the PR — you do NOT write implementation code yourself (sole exception: integration glue under ~20 lines). Work directly in the checkout — there is NO worktree here. Commit (conventional, mention ${allIds.join(" + ")}) and push to the SAME branch as you go (each push is your progress signal).`,
    `4. Targeted verify (typecheck + lint the changed package + touched tests; one \`*.db.test.ts\` if DB-touched). CI remains the gate for the HEAVY suites (db-suite, e2e, route-health) — do not run those locally. **EXCEPTION — the cheap deterministic guards are YOUR gate, not CI's.** If your diff adds/changes a command, an MCP tool, or a reference guide, or touches \`packages/commands\`, \`packages/reference\`, or \`apps/cli\`, run and pass ALL of these locally BEFORE marking ready (seconds each; every skipped one cost a kickback round on 2026-07-16): \`pnpm check:manifest && pnpm check:cli-version && pnpm check:docs-version && pnpm docs:check\`, plus the registry tests (ui-surface-parity, command-tools, inventory, agent-how-tos). A NEW command trips ~6 registry surfaces: §17.8 classification in \`docs/specs/agent-native-command-surface.md\`, MCP guide rows (tool names in the GENERATED-from-title form), command inventories + counts, a reference-guide entry, the changed guide's \`version:\` bumped ABOVE \`git show origin/main:<file>\`, and the regenerated CLI manifest (\`pnpm --filter <your-cli-package> generate:manifest\`) + \`pnpm fix:cli-version\` strictly above origin/main (this makes the PR a VERSION-HOLDER — it serializes in the merge queue).`,
    `5. Layer-1 adversarial self-review (correctness / security / tests) — verify EVERY acceptance-criteria bullet explicitly; fix findings. The PR body MUST carry an "AC → evidence" checklist (one row per AC bullet), a one-line note of the subagent breakdown used, and a **deviation log** (every departure from this brief; "none" if none — the shepherd checks it before enqueue).`,
    `6. **Token telemetry — post your usage IMMEDIATELY BEFORE marking ready** (fleet performance analysis; the orchestrator folds it from the PR comment). Run the repo script and post its one-line output as a PR comment via gh api REST:\n   \`gh api repos/${repo}/issues/<PR>/comments -f body="$(node scripts/session-token-report.mjs --role lead --issues ${allIds.join(",")} --pr <PR> --host cloud${kickback ? ` --kickback ${kickback}` : ""})"\`\n   It reads your OWN session transcripts locally and reports tokens by model — no secrets, no session/env identifiers.`,
    `7. **Hand off = mark the PR ready_for_review via the GitHub MCP tools.** This transition (draft → ready) IS your hand-off — it triggers CI + Codex and tells the shepherd to take over. Do NOT merge. Do NOT mark ready until targeted verify is green.`, ``);
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
    `> Write your findings to \`tmp/subagent-notes/${issueId}/<label>.md\` **as you go**, not at the end. That path is gitignored scratch — **do NOT commit it** and never \`git add -f\` it. Return **≤500 words + that path** — never a dump; cite \`file:line\` instead of pasting code. If you approach your context limit: finalize the file, then return \`done\` or \`partial\` plus exactly what remains.`, ``,
    `**A subagent cannot rotate** — it never receives a user prompt, so no nudge can reach it, and when it dies it leaves NOTHING. Measured 2026-07-25: one \`implementer\` subagent reached 134% of its window and an \`Explore\` subagent DIED at 101% with its findings unrecoverable. The bigger win is your own context: a subagent's return value is injected verbatim into you, so a 20K-token report costs YOU 20K. When one returns \`partial\` or dies, read its notes file and **re-dispatch narrowed** — never re-run the same unbounded prompt.`, ``);
  p(`## Guardrails`, ``, `Do NOT merge. Do NOT enumerate/report environment or session identifiers into comments (opening the draft PR is enough — its footer has your handle). Stage explicit paths only (never \`git add -A\`). No secrets anywhere; redact presigned-URL query strings. Never modify the /work harness.`);
  if (kickback) {
    p(``, `## ⚠ Kickback (round ${kickback})`, ``,
      `The branch and its PR already exist — the shepherd **converted the PR back to draft** when kicking it back, so it runs no CI while you fix. Load the branch state, address the findings below, re-verify (targeted), and push to the SAME branch. Then **mark the PR \`ready_for_review\` again** via the GitHub MCP tools — that draft→ready transition IS your re-hand-off (it re-fires CI + Codex and hands you back to the shepherd, exactly like your first hand-off, and the orchestrator derives it as a fresh \`handed_off\`). Do NOT open a new PR; do NOT merge. **NEVER mark ready without having pushed a fix** — a ready flip at the unchanged head SHA is a flap the harness now ignores, and it wastes the round.`,
      ...kickbackSharedLines({ findings, priorRounds, kickback }));
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
const CLAUDE_LAUNCH = `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN ${FORCE_TRANSCRIPTS} claude --dangerously-skip-permissions`;

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

const REVIEW_GATE_HEADING = "⚑ Mandatory external adversarial review (pre-hand-off gate)";
// The codex gate runs on EVERY lead type (DER-2375). It is deliberately first in the brief: it is the
// cheap one (different subscription), the fast one, and the one whose findings predict the kickbacks.
const CODEX_GATE_HEADING = "⚑ Mandatory Codex review (pre-PR gate — every lead type)";

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
export function codexReviewCommand({ promptFile = "<prompt.md>", outFile = "<review.json>", logFile = "<review.jsonl>", errorFile = "<review.stderr.log>", schemaFile = "~/.claude/skills/work/codex-review-schema.json" } = {}) {
  return `codex exec --json --sandbox read-only --output-schema ${schemaFile} --output-last-message ${outFile} - < ${promptFile} > ${logFile} 2> ${errorFile}`;
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
      priority: Number.isFinite(f?.priority) ? f.priority : null,
      confidence: Number.isFinite(f?.confidence_score) ? f.confidence_score : null,
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
  const blockers = review.findings.filter((f) => f.priority != null && f.priority <= 1).length;
  const ev = {
    actor: actor ?? (issueId ? `lead:${issueId}` : "lead"),
    type: "review_findings",
    role: "reviewer",
    reviewer: reviewer ?? "codex",
    verdict: review.verdict,
    confidence: review.confidence,
    findings_total: review.findings.length,
    blockers,
    findings: review.findings.map(({ title, priority, confidence, file, line_start, line_end }) => ({ title, priority, confidence, file, line_start, line_end })),
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
  let turnCompleted = false;
  let commands = 0;
  for (const line of String(logText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "turn.completed") turnCompleted = true;
    if (
      event?.type === "command_execution"
      || (event?.type === "item.completed" && event?.item?.type === "command_execution")
    ) {
      commands += 1;
    }
  }
  return { turnCompleted, commands };
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
// Parse `gh pr checks` TSV once and answer from the captured text (fix 3: three separate calls
// observed three CI states and printed an arithmetically impossible shard count).
export function parseChecksOutput(text = "") {
  const rows = String(text).split("\n").filter((l) => l.trim()).map((l) => l.split("\t"));
  const checksRow = rows.find((r) => r[0] === "checks");
  const shardRows = rows.filter((r) => /^db-suite \(\d+\)/.test(r[0] ?? ""));
  const firstFail = rows.find((r) => r[1] === "fail");
  return {
    checks: checksRow ? checksRow[1] : null,
    shardsPass: shardRows.filter((r) => r[1] === "pass").length,
    shardsTotal: shardRows.length,
    firstFailUrl: firstFail ? firstFail[3] ?? null : null,
  };
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
//   - gate sha == head                    → CURRENT. The evidence describes what ships.
//   - gate sha != head, blockers == 0     → STALE-CLEAN. Report it; do not block. The clean verdict
//                                            can only have been invalidated by the new commits, which
//                                            the cloud bot reviews on head anyway.
//   - gate sha != head, blockers > 0      → STALE-DIRTY. BLOCK. The only record of this PR's local gate
//                                            says it had open blockers, and no evidence covers the tree
//                                            that would merge. This is exactly DER-2513's shape.
//   - no gate event at all                → ABSENT. Report; the cloud bot is the gate of record.
export function gateEvidenceVerdict({ head, gate } = {}) {
  if (!gate) return { state: "absent", blocks: false, label: "gate=ABSENT" };
  const sha = gate.sha ?? null;
  const blockers = Number(gate.blockers ?? 0);
  if (!sha) return { state: "unstamped", blocks: false, label: "gate=UNSTAMPED (older review-usage — re-run to stamp a sha)" };
  if (head && sha === head) return { state: "current", blocks: false, label: `gate=CURRENT (${sha.slice(0, 10)}, blockers=${blockers})` };
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

// DER-2753 `allowMergeWithoutChecks`: a PUBLIC adopter repo often has NO required checks at all, so
// `gh pr checks` reports nothing, `checks` reads UNKNOWN, and this verdict never passes — which in
// direct-merge mode means the shepherd can never merge anything. The opt-in loosens EXACTLY that one
// case (an ABSENT check surface) and nothing else: a `fail` or `pending` check still blocks with the
// flag on, or the key would quietly mean "ignore CI". Default false — the loosening is the adopter's
// explicit, written decision, and the verdict says so out loud so it stays auditable in the run log.
export function readyVerdict({ draft, threads, onHead, checks, shardsPass, shardsTotal, gate, allowMergeWithoutChecks = false } = {}) {
  if (draft !== false) return { ready: false, why: "draft" };
  if (threads !== 0) return { ready: false, why: threads == null || Number.isNaN(threads) ? "threads UNKNOWN (throttled — never treat as 0)" : `${threads} unresolved thread(s)` };
  if (!onHead) return { ready: false, why: "codex not on head" };
  const checksAbsent = checks == null || checks === "";
  const checksWaived = checksAbsent && allowMergeWithoutChecks === true;
  if (checks !== "pass" && !checksWaived) return { ready: false, why: `checks=${checks ?? "UNKNOWN"}` };
  if (shardsTotal > 0 && shardsPass !== shardsTotal) return { ready: false, why: `db shards ${shardsPass}/${shardsTotal}` };
  if (shardsPass > shardsTotal) return { ready: false, why: "INCONSISTENT shard read — re-run" };
  if (gate?.blocks) return { ready: false, why: gate.label };
  return { ready: true, why: checksWaived ? "all gates pass (checks UNKNOWN — WAIVED by repo.allowMergeWithoutChecks)" : "all gates pass" };
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
export function mergeAction({ mode, strategy = "squash", pr, verdict, deleteBranch = true } = {}) {
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
  const args = ["pr", "merge", String(pr), `--${strategy}`];
  if (deleteBranch) args.push("--delete-branch");
  return { action: "merge", args, why: `direct merge (${strategy}) — every readyVerdict gate passed` };
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
  return `#${r.pr} head=${(r.head ?? "?").slice(0, 10)} draft=${r.draft} thr=${r.threads ?? "UNKNOWN"} codex-on-head=${r.onHead ? "YES" : "NO"} (rev=${(r.reviewSha ?? "").slice(0, 10)} cmt=${(r.commentSha ?? "").slice(0, 10)}) checks=${r.checks ?? "?"} shards=${r.shards} behind-main=${r.behind ?? "?"}${r.behind > 0 ? " ⚠" : ""} push=${r.push ?? "?"} ${r.gateLabel}  ${tail}${r.note ?? ""}`;
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
  // brief's shell-out is the ONLY review path. The ledger `token_usage` event it emits (role
  // "reviewer", provider firstParty) is what proves the review actually happened.
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
  const launch = proxyEnv && proxyEnv.length
    ? `env ${keyClause} ${SECURITY_GUIDANCE_LEAD_GATE} ${proxyEnv.join(" ")} claude --dangerously-skip-permissions --no-chrome --model ${model}${effortArg}`
    : `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN ${FORCE_TRANSCRIPTS} ${SECURITY_GUIDANCE_LEAD_GATE} claude --dangerously-skip-permissions --no-chrome --model ${model}${effortArg}`;
  return {
    command: "cmux",
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
  const launch = proxyEnv && proxyEnv.length
    ? `env ${keyClause} ${SECURITY_GUIDANCE_LEAD_GATE} ${proxyEnv.join(" ")} claude --dangerously-skip-permissions --no-chrome --model ${model}${effortArg}`
    : `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN ${FORCE_TRANSCRIPTS} ${SECURITY_GUIDANCE_LEAD_GATE} claude --dangerously-skip-permissions --no-chrome --model ${model}${effortArg}`;
  const remote =
    `set -a; . ${tokenFile}; set +a; export GH_TOKEN="\${WORK_MINI_GITHUB_PAT}"; ${roleEnv} ` +
    `cd ${worktree}; ` +
    `${launch} "/work-lead ${briefPath}"`;
  // `ssh <host> -- <command>` runs the command in EXEC mode with NO pty, so the remote `claude`
  // sees pipes on fd 0/1/2, prints "no stdin data received", never renders its interactive TUI, and
  // the `/work-lead` slash command doesn't execute as an interactive command. Force a pty
  // (RequestTTY=force ≡ `ssh -tt`) so the remote lead is a real interactive session that STREAMS into
  // this cockpit pane — verified: the mini allocates `/dev/ttysNNN` under force.
  return { command: "cmux", args: ["ssh", ssh, "--name", name, "--ssh-option", "RequestTTY=force", "--", remote] };
}

// Shepherd defaults to Opus (operator decision 2026-07-15): its inline fixes are sometimes deeply
// technical and merge with no second reviewer — asymmetric blast radius vs. a lead's mistakes. The
// kickback discipline (substantial/security-lane fixes still kick back to a lead) is unchanged.
export function buildShepherdBootCommand({ name, cwd, runId, runDir, model = "opus" }) {
  return {
    command: "cmux",
    args: [
      "new-workspace",
      "--name", name,
      "--cwd", cwd,
      ...roleEnvArgs("shepherd", runDir),
      "--command", `${CLAUDE_LAUNCH} --model ${model} "/work-shepherd ${runId}"`,
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
  return {
    command: "cmux",
    args: [
      "new-workspace",
      "--name", name,
      "--cwd", cwd,
      ...roleEnvArgs("orch", runDir),
      "--command", `${CLAUDE_LAUNCH} --chrome${modelArg} "/work resume ${runId}"`,
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
const HOSTS_DEFAULT = { local: { cap: 2 } };
let HOSTS = { ...HOSTS_DEFAULT };
export function getHosts() { return HOSTS; }

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
export function getDefaultPreferHosts() { return [...DEFAULT_PREFER_HOSTS]; }

// Lead-type registry (CLIProxyAPI comparison, 2026-07-23): named profiles so /work can spawn a lead on
// Kimi or GPT — routed through the local CLIProxyAPI gateway — instead of Claude, to compare lead
// performance. `claude` is the built-in default (direct subscription, unchanged). A proxy-backed entry
// carries { proxy:true, leadModel, subagentModel, researchModel?, hosts }; `hosts` is the allowlist
// pickHost/spawn-lead confine it to (proxy leads are local-only — the gateway is localhost). Config key:
// `.claude/work.config.json` `leadTypes`. See the README's lead-types section.
const LEAD_TYPES_DEFAULT = { claude: { proxy: false } };
let LEAD_TYPES = { ...LEAD_TYPES_DEFAULT };
export function getLeadTypes() { return LEAD_TYPES; }

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
export function estimateCostFromPrices(by_model = {}, prices = MODEL_PRICES) {
  const keys = Object.keys(prices ?? {});
  if (!keys.length) return null;
  let cost = 0;
  let matched = false;
  for (const [model, u] of Object.entries(by_model ?? {})) {
    const key = keys.filter((k) => String(model).includes(k)).sort((a, b) => b.length - a.length)[0];
    if (!key) continue;
    matched = true;
    const p = prices[key] ?? {};
    cost +=
      ((Number(u?.input) || 0) * (Number(p.input) || 0) +
        (Number(u?.output) || 0) * (Number(p.output) || 0) +
        (Number(u?.cache_creation) || 0) * (Number(p.cache_creation) || 0) +
        (Number(u?.cache_read) || 0) * (Number(p.cache_read) || 0)) / 1_000_000;
  }
  return matched ? Math.round(cost * 10000) / 10000 : null;
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

export function computeEligible({ issues = [], inflight = [], cap = 2 } = {}) {
  const chosen = inflight.map((i) => ({ id: i.id, fileScope: i.fileScope ?? [] }));
  const result = [];
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
// KNOWN GAP: `install.sh` copies `skills/` and `hooks/` but NOT `VERSION`, so a host running from
// `~/.claude/skills/work/` finds no VERSION file and reports "unknown". Two such hosts therefore look
// same-version to each other. Closing it is a one-line `cp "$SRC/VERSION" "$DEST/VERSION"` in the
// installer plus the `../../VERSION` candidate below; until then, `WORK_HARNESS_VERSION` is the override.
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

export async function appendEvent(runDir, event) {
  await mkdir(runDir, { recursive: true });
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
export function ledgerProtocolVerdict(events = []) {
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
  const harnessVersions = [...versionSources.keys()].sort();
  const reasons = [];
  if (foreign.size) {
    reasons.push(
      `foreign schema_version in the ledger: ${[...foreign].join(", ")} (this harness implements ${LEDGER_SCHEMA_VERSION}). ` +
      `Refusing rather than folding a wire version it cannot interpret — upgrade this host, or run against a ledger written by a build you have.`,
    );
  }
  if (harnessVersions.length > 1) {
    reasons.push(
      `mixed harness version on ONE ledger: ${harnessVersions.map((v) => `${v} [${[...versionSources.get(v)].join(", ")}]`).join(" vs ")}. ` +
      `Different harness code folding one ledger is how two hosts silently disagree about a run's state. ` +
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
const VERSION_GATED_SUBCOMMANDS = new Set(["spawn-lead", "spawn-shepherd", "spawn-orch", "rotate-lead", "rotate-shepherd"]);

export function assertLedgerProtocolCompatible(verdict, subcommand, { allowSkew = false } = {}) {
  if (!verdict || verdict.ok) return;
  // `--allow-version-skew` is a DELIBERATE degrade for harness-version skew (mid-run upgrade of one
  // host, and the operator has decided the difference is immaterial). A FOREIGN schema_version is never
  // overridable: there is no degraded mode for "lines this build cannot parse".
  const foreign = verdict.foreign_schema_versions?.length ? verdict.reasons.filter((r) => r.startsWith("foreign schema_version")) : [];
  const blocking = allowSkew ? foreign : verdict.reasons;
  if (!blocking.length) return;
  throw new Error(
    `refusing to run "${subcommand}" against this ledger:\n` +
      blocking.map((r) => `  - ${r}`).join("\n") +
      `\n  (this is DER-2748 — see \`state\`'s "protocol" block for the full picture)`,
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
  try {
    process.stderr.write(
      `WARNING: ledger ${ledgerFile} — ${fresh.length} line(s) did NOT fold into state ` +
      `(${[...new Set(fresh.map((b) => b.reason))].join(", ")}; first at byte ${fresh[0].offset ?? "?"}). ` +
      `Raw bytes kept in ${sidecar} — repair or acknowledge them there.\n`,
    );
  } catch { /* stderr closed */ }
}

// Ledger health as data, for `state.ledger` and `watch`'s wake banner. Combines THIS process's last read
// with the durable sidecar, so damage recorded by an earlier process is still visible after the fact.
// `ok:false` latches on permanent (non-transient) damage until the sidecar is cleared — an unacknowledged
// line that never folded is a standing fact about the run, not a one-shot message.
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
  return {
    ok: last.quarantined === 0 && last.torn_tail === 0 && recordedPermanent === 0,
    quarantined: last.quarantined,
    torn_tail: last.torn_tail,
    first_bad_offset: last.first_bad_offset ?? firstRecordedOffset,
    reasons: last.reasons,
    quarantined_recorded: recorded,
    quarantined_unacknowledged: recordedPermanent,
    quarantine_file: recorded ? sidecar : null,
    last_read_at: last.at,
    note: recordedPermanent
      ? `${recordedPermanent} ledger line(s) never folded into state; raw bytes are in ${sidecar}. Repair the ledger or delete that file to acknowledge.`
      : null,
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

// Parse raw ledger lines pulled from a remote host's local events.jsonl (the mini), tagging each with
// its host if the remote append didn't. Pure — the pull-host subcommand appends the result to the
// canonical ledger. Blank lines are skipped so a trailing newline doesn't create an empty event.
//
// DER-2738: a malformed remote line is now SKIPPED AND RECORDED instead of throwing the whole pull away.
// The remote tail is the likeliest place to meet a torn line — `tail -n +N` of a file the mini is
// actively appending to. Pass `damage` to collect what was dropped (pull-host quarantines it); omit it
// and the tolerance is still there, which is the point: no consumer can crash on one bad remote line.
export function mergeRemoteEvents({ remoteLines = [], host, damage } = {}) {
  const out = [];
  for (let i = 0; i < remoteLines.length; i += 1) {
    const l = remoteLines[i];
    if (!l || !l.trim()) continue;
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

export function materializeState(rawEvents, meta = {}) {
  const events = dedupeTerminalEvents(rawEvents);
  const issues = {};
  let runStarted = null;
  const ensure = (id) => {
    if (!issues[id]) {
      issues[id] = { status: "queued", pr: null, worktree: null, branch: null, workspace_ref: null, kickback_count: 0, kickback_unactioned: false, kickback_sha: null, fileScope: [], host: null, bundle: null, tokens: 0, plan_scope_seen: false, budget: "ok", leadType: null, rotations: 0, rotate_pending: false, rotate_pct: null, rotate_disposition: null, _reports: {}, _kb_uncounted: false };
    }
    return issues[id];
  };
  let shepherdRotatePending = false;
  for (const e of events) {
    if (e.type === "run_started" && !runStarted) runStarted = e;
    // Shepherd rotation request (respawn-over-compact, 2026-07-23): the shepherd appends
    // {actor:"shepherd",type:"rotate_requested"} when its context-wrap-nudge fires. The flag stays
    // raised until the next shepherd_spawned (the rotation itself) — surfaced top-level like
    // kickbacks_pending so a request can't rot unseen in the event stream.
    if (e.type === "rotate_requested" && (e.actor === "shepherd" || e.role === "shepherd")) shepherdRotatePending = true;
    if (e.type === "shepherd_spawned") shepherdRotatePending = false;
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
        if (e.worktree) it.worktree = e.worktree;
        if (e.workspace_ref) it.workspace_ref = e.workspace_ref;
        if (e.host) it.host = e.host;
        if (e.leadType) it.leadType = e.leadType;
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
      case "pr_opened":
        it.status = "pr_open";
        if (e.pr != null) it.pr = e.pr;
        break;
      case "lead_online":
        // Cloud lead's draft PR appeared: alive + working. Record the pr + monitor handle; stay
        // in_progress (draft ≠ handed off). The ABSENCE of this past a deadline = failed-to-start.
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
    const verdict = (n, warn, trip) => (n >= trip ? "tripped" : n >= warn ? "warn" : "ok");
    const byTokens = verdict(v.tokens, BUDGET.warnTokens, BUDGET.tripTokens);
    const byRounds = verdict(v.kickback_count, BUDGET.warnRounds, BUDGET.tripRounds);
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
    status: meta.status ?? "running",
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
      .map(([k, v]) => ({ issue: k, pct: v.rotate_pct, disposition: v.rotate_disposition, rotations: v.rotations, source: v.rotate_source ?? "lead", host: v.host, pr: v.pr })),
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
    // Circuit-breaker banner (2026-07-25). Issues at/over the per-issue token or round ceiling, worst
    // first. Surfaced top-level for the same reason as kickbacks_pending: the orchestrator must see an
    // overrunning issue at its NEXT wake, not at the post-mortem. `tripped` = stop dispatching more
    // rounds and decide (split / re-scope / escalate); `warn` = the next round is the last cheap one.
    budget_trips: Object.entries(issues)
      .filter(([, v]) => v.budget && v.budget !== "ok")
      .sort((a, b) => (b[1].budget === "tripped" ? 1 : 0) - (a[1].budget === "tripped" ? 1 : 0) || b[1].tokens - a[1].tokens)
      .map(([k, v]) => ({ issue: k, level: v.budget, tokens: v.tokens, rounds: v.kickback_count, rotations: v.rotations, pr: v.pr, reason: v.budget_reason })),
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
    const role = e.role ?? (String(e.actor ?? "").startsWith("lead") ? "lead" : e.actor || "unknown");
    if (!by_role[role]) by_role[role] = { by_model: {}, total: zeroTokens() };
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
    // Unpriced report: try the configured per-model rates, else book it to the visible gap.
    const derived = estimateCostFromPrices(e.by_model);
    if (derived != null) { cost += derived; continue; }
    costKnown = false;
    unpricedReports += 1;
    unpricedTokens += Object.values(e.by_model).reduce((s, u) => s + sumTokens(u), 0);
    for (const m of Object.keys(e.by_model)) unpricedModels.add(m);
  }
  return {
    reports,
    total,
    total_tokens: sumTokens(total),
    by_model,
    by_role,
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
export function renderUsageMd(agg, { runId } = {}) {
  const fmt = (n) => n.toLocaleString("en-US");
  const L = [
    `# Token usage — ${runId ?? "run"}`,
    ``,
    `- **Usage reports folded:** ${agg.reports}${agg.reports === 0 ? " _(no token_usage events — check that leads/shepherd emitted at end-of-session)_" : ""}`,
    `- **Total tokens:** ${fmt(agg.total_tokens)}  (input ${fmt(agg.total.input)} · output ${fmt(agg.total.output)} · cache-write ${fmt(agg.total.cache_creation)} · cache-read ${fmt(agg.total.cache_read)})`,
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
export const ACTIONABLE_EVENT_TYPES = ["pr_opened", "handed_off", "pr_merged", "kickback", "reaped", "lead_failed"];
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
async function pullHostInto(runDir, hostName, runId) {
  const host = getHosts()[hostName];
  if (!host) throw new Error(`unknown host "${hostName}"`);
  const cursor = await readCursor(runDir, hostName);
  const remotePath = `${host.ledgerRoot}/${runId}/events.jsonl`;
  const remote = `tail -n +${cursor + 1} ${remotePath} 2>/dev/null || true`;
  const res = await runCommand({ command: "ssh", args: [host.ssh, remote] });
  const lines = res.stdout.split("\n").filter((l) => l.trim());
  // DER-2738: one torn line in the mini's tail used to throw the whole pull (and the watch cycle that
  // called it). Dropped lines are quarantined with their raw bytes so a lost remote event is VISIBLE —
  // the per-host cursor still advances past them, so an invisible drop here would be permanent.
  const damage = [];
  const events = mergeRemoteEvents({ remoteLines: lines, host: hostName, damage });
  for (const e of events) await appendEvent(runDir, e);
  if (damage.length) await recordLedgerDamage(join(runDir, "events.jsonl"), damage, { pulled_from: hostName });
  await writeFile(join(runDir, `sync-cursor.${hostName}`), String(cursor + lines.length), "utf8");
  return { host: hostName, pulled: events.length, quarantined: damage.length, cursor: cursor + lines.length };
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
// if the PR isn't part of this run (branch/title doesn't name a run issue).
// Kickback flap guard (2026-07-16 run): pass `status` (the issue's folded status) + `kickbackSha` (the
// SHA the shepherd recorded on the latest kickback) + `pr.headRefOid`. While the issue sits in
// `kickback` and the head is STILL at the kickback SHA, a non-draft PR is a phantom ready state — the
// reconcile raced the shepherd's re-draft, or a lead re-marked ready without pushing anything. Deriving
// `handed_off` then poisons the ledger (empties kickbacks_pending, and its `${type}:${pr}` seen-key
// suppresses the REAL re-hand-off later). Suppress it until the head advances.
export function deriveCloudPrEvents({ pr, runIssues = null, bundles = {}, status = null, kickbackSha = null } = {}) {
  if (!pr || pr.number == null) return [];
  const hay = `${pr.headRefName || ""} ${pr.title || ""}`.toLowerCase();
  let issue;
  // When runIssues is PROVIDED (an array, even empty), the PR MUST name one of them — otherwise it's
  // not part of this run and we emit nothing. Only `null`/undefined means "no filter" (test convenience;
  // the reconcile caller never passes that — it guards on an empty scope).
  if (runIssues != null) {
    if (!Array.isArray(runIssues) || !runIssues.length) return [];
    issue = runIssues.find((id) => hay.includes(String(id).toLowerCase()));
    if (!issue) return [];
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
// backwards one. Only meaningful while the issue sits in `kickback` and we know the kickback's sha.
export async function annotateShaAncestry(events, { repoRoot, kickbackSha, run = runCommand } = {}) {
  if (!kickbackSha || !repoRoot) return events;
  for (const e of events) {
    if (e?.type !== "handed_off" || !e.sha) continue;
    const descends = await shaDescendsFrom({ repoRoot, ancestor: kickbackSha, sha: e.sha, run });
    if (descends !== null) e.sha_descends = descends;
  }
  return events;
}

// Fold cloud leads into the canonical ledger (the cloud analogue of pullHostInto for the mini): derive
// lead_online/handed_off from each open PR's state (draft/handle) AND fold any explicit WORK-EVENT
// comments. Best-effort — a gh failure returns 0, never throws the watch loop. Dedups on `${type}:${pr}`
// against events already in the ledger, so re-scanning is idempotent.
async function reconcilePrEventsInto(runDir, runId, repoRoot) {
  const listRes = await runCommand({ command: "gh", args: ["pr", "list", "--state", "open", "--json", "number", "--limit", "100"], cwd: repoRoot });
  if (listRes.exitCode !== 0) return { folded: 0 };
  let prs;
  try { prs = JSON.parse(listRes.stdout || "[]").map((p) => p.number); } catch { return { folded: 0 }; }
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
  const emit = async (e) => {
    // pr-less events dedup on their content key too (DER-2519) — the old `pr != null` guard is the
    // exact hole that let one comment re-append every scan. Idempotence control: running reconcile
    // twice against an unchanged PR must append nothing on the second pass.
    const key = eventSeenKey(e);
    if (seen.has(key)) return;
    seen.add(key);
    await appendEvent(runDir, e);
    folded += 1;
  };
  for (const pr of prs) {
    const vRes = await runCommand({ command: "gh", args: ["pr", "view", String(pr), "--json", "comments,isDraft,body,headRefName,title,headRefOid"], cwd: repoRoot });
    if (vRes.exitCode !== 0) continue;
    let data;
    try { data = JSON.parse(vRes.stdout || "{}"); } catch { continue; }
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
    })) { await appendEvent(runDir, e); folded += 1; }
    // DER-2559 (ancestor variant): resolve ancestry HERE, where a repo is in hand, and stamp it on the
    // derived hand-off. The fold is pure and cannot ask git whether the head moved forwards or backwards.
    const derived = await annotateShaAncestry(
      deriveCloudPrEvents({
        pr: { number: pr, isDraft: data.isDraft, body: data.body, headRefName: data.headRefName, title: data.title, headRefOid: data.headRefOid },
        runIssues: scope, bundles, status: issueStatus, kickbackSha: kickbackShaByPr.get(pr),
      }),
      { repoRoot, kickbackSha: issueStatus === "kickback" ? kickbackShaByPr.get(pr) : null },
    );
    for (const e of derived) await emit(e);
    // `pr` is passed so the reader stamps the PR the comment was actually posted on rather than trusting
    // the body's claim; the author allowlist comes from config (DER-2737).
    for (const e of parsePrEventComments({ comments: data.comments || [], runIssues: scope, pr })) await emit(e);
  }
  // Publish the operator monitor links (item 7) from the freshly-folded state — cheap, and this is where
  // cloud leads' `lead_online` handles land, so links.md refreshes on each new cloud lead.
  try {
    await writeFile(join(runDir, "links.md"), renderLinksMd(materializeState(await readEvents(runDir), { run_id: runId })), "utf8");
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
  BUDGET = { ...BUDGET_DEFAULT };
  MODEL_PRICES = { ...MODEL_PRICES_DEFAULT };
  REPO_IDENTITY = { ...REPO_IDENTITY_DEFAULT };
  MERGE_POLICY = { ...MERGE_POLICY_DEFAULT };
  LEGACY_EVENT_MARKER = null;
  LEGACY_HANDOFF_MARKER = null;
  TRUSTED_COMMENT_AUTHORS_EXTRA = [];
  let cfg;
  try {
    cfg = JSON.parse(await readFile(join(repoRoot, ".claude", "work.config.json"), "utf8"));
  } catch {
    return;
  }
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
  if (runDir && VERSION_GATED_SUBCOMMANDS.has(o.subcommand)) {
    assertLedgerProtocolCompatible(ledgerProtocolVerdict(await readEvents(runDir)), o.subcommand, { allowSkew: !!o.allowVersionSkew });
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
      // Run plan from /prep-for-work (2026-07-25): every subsequent `write-brief` reads the issue's
      // ASSIGNED budget from here, so the lead's plan_scope is checked rather than self-graded.
      // Validate it NOW — an invalid plan must fail at init, not silently at the first dispatch.
      const planPathToCheck = o.plan ? resolvePath(o.plan) : specPlanPath;
      if (planPathToCheck) {
        let plan = specPlan;
        if (!plan) {
          try { plan = JSON.parse(await readFile(planPathToCheck, "utf8")); }
          catch (err) { throw new Error(`--plan ${planPathToCheck}: ${err instanceof Error ? err.message : String(err)}`); }
        }
        const unbudgeted = (plan.issues ?? []).filter((i) => !Number.isFinite(i?.budget?.files) || !Number.isFinite(i?.budget?.additions)).map((i) => i?.id);
        if (!plan.issues?.length) throw new Error(`--plan ${planPathToCheck} has no issues[]`);
        // Identical in both modes ON PURPOSE — an un-budgeted unit is an unbounded one whether it is
        // called DER-1234 or SPEC-foo-U3, and dropping this in spec mode would discard the one lever
        // the data actually supports.
        if (unbudgeted.length) throw new Error(`--plan ${planPathToCheck}: no assigned budget for ${unbudgeted.join(", ")} — run \`prep-runner validate\` before init-run`);
        started.plan = planPathToCheck;
      }
      await appendEvent(dir, started);
      return {
        runId, runDir: dir, mode, issues: listed ?? undefined,
        ...(specPlan ? { specRef: specPlan.specRef, tracking: specPlan.tracking } : {}),
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
      const brief = isCloud
        ? renderCloudBrief({
            issueId: o.issueId, title: o.title, branch: o.branch, runId: o.runId,
            acceptance: o.acceptance, kickback: o.kickback, findings: o.findings, bundle: bundleArr, priorRounds,
            assignedBudget,
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
            const briefMatch = `${remoteHost.ledgerRoot}/${o.runId}/briefs/${o.issueId}`;
            await runCommand({ command: "ssh", args: [remoteHost.ssh, `pkill -f ${shellQuote(briefMatch)}; true`] });
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
          ref = parseWorkspaceRef(res.stdout);
        }
        const ev = { actor: "orch", type: "lead_spawned", issue: o.issueId, worktree: o.worktree, workspace_ref: ref, kickback: o.kickback ?? 0, host: o.host };
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
      const { command, args } = buildLeadBootCommand({ name, worktree: o.worktree, briefPath: localBrief, runDir, model: leadModel, proxyEnv, provider: ltCfg.provider ?? null, effort: ltCfg.effort ?? null });
      const line = `${command} ${args.map(shellQuote).join(" ")}`;
      let ref = null;
      if (!o.dryRun) {
        const res = await runCommand({ command: cmuxBin(), args });
        ref = parseWorkspaceRef(res.stdout);
      }
      const ev = { actor: "orch", type: "lead_spawned", issue: o.issueId, worktree: o.worktree, workspace_ref: ref, kickback: o.kickback ?? 0 };
      if (leadType !== "claude") ev.leadType = leadType;
      if (o.rotation) ev.rotation = o.rotation;
      if (bundle) ev.bundle = bundle;
      // Dry-run purity (DER-2514): preview only — the event is returned, never appended.
      if (!o.dryRun) await appendEvent(runDir, ev);
      return { stdout: line, workspace_ref: ref, event: ev, dryRun: !!o.dryRun };
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
          throw new Error("review-usage: REFUSING to record a Codex review without --log <review.jsonl>; terminal producer evidence is mandatory");
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
        // The sha the review actually covered. --sha wins; otherwise read the worktree's HEAD, which
        // is the tree codex just looked at. Never guessed from the PR — the gate reviews the WORKING
        // TREE, which may not equal any pushed commit.
        const shaRes = o.sha ? null : await runCommand({ command: "git", args: ["rev-parse", "HEAD"], cwd: cwdForReview }).catch(() => null);
        const coveredSha = o.sha ?? String(shaRes?.stdout ?? "").trim() ?? null;
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
      const { command, args } = buildShepherdBootCommand({ name, cwd, runId: o.runId, runDir, model: o.model ?? getShepherdModel() ?? "opus" });
      const line = `${command} ${args.map(shellQuote).join(" ")}`;
      let ref = null;
      if (!o.dryRun) {
        const res = await runCommand({ command: cmuxBin(), args });
        ref = parseWorkspaceRef(res.stdout);
        await appendEvent(runDir, { actor: "orch", type: "shepherd_spawned", workspace_ref: ref });
      }
      return { stdout: line, workspace_ref: ref, dryRun: !!o.dryRun };
    }
    case "spawn-orch": {
      assertNotRoot("spawn a successor orchestrator");
      const name = workspaceName("orch", { project: o.project ?? "work" });
      const cwd = o.worktree ?? o.repoRoot ?? process.cwd();
      const { command, args } = buildOrchBootCommand({ name, cwd, runId: o.runId, runDir, model: o.model ?? null });
      const line = `${command} ${args.map(shellQuote).join(" ")}`;
      let ref = null;
      if (!o.dryRun) {
        const res = await runCommand({ command: cmuxBin(), args });
        ref = parseWorkspaceRef(res.stdout);
        await appendEvent(runDir, { actor: "orch", type: "orch_spawned", workspace_ref: ref });
      }
      return { stdout: line, workspace_ref: ref, dryRun: !!o.dryRun };
    }
    case "append": {
      const event = JSON.parse(o.rest[0] ?? o.event ?? "{}");
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
      const md = renderUsageMd(agg, { runId: o.runId });
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
          const pat = `${hostCfg.ledgerRoot}/${o.runId}/briefs/${issue}`;
          const res = await runCommand({ command: "ssh", args: [hostCfg.ssh, `pgrep -f ${shellQuote(pat)} >/dev/null 2>&1; echo RC=$?`] });
          if (res.exitCode !== 0) return "unknown"; // ssh itself failed — NOT evidence of death
          const m = String(res.stdout ?? "").match(/RC=(\d+)/);
          return m ? (m[1] === "0" ? "alive" : m[1] === "1" ? "dead" : "unknown") : "unknown";
        }
        const res = await runCommand({ command: "pgrep", args: ["-f", `${runDir}/briefs/${issue}`] });
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
          await runCommand({ command: "ssh", args: [ssh, `pkill -f ${shellQuote(`${hostCfg.ledgerRoot}/${o.runId}/briefs/${o.issueId}`)}; true`] });
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

      // 5. Respawn on the SAME worktree. Cloud is the exception: RemoteTrigger is the orchestrator's
      // own tool, not a runner subcommand, so prepare everything and hand the brief back to it.
      if (isCloud) {
        if (!o.dryRun) await appendEvent(runDir, { actor: "orch", type: "rotation_prepared", issue: o.issueId, rotation, brief: briefPath, host });
        return {
          briefPath, rotation, wipCommitted, noteSynthesized, host, spawned: false,
          stdout: `prepared rotation ${rotation} for ${o.issueId} (cloud). Brief: ${briefPath}\nSpawn it yourself with the RemoteTrigger tool — rotate-lead cannot create a cloud session.`,
        };
      }
      const spawnArgs = [
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
        briefPath, rotation, wipCommitted, noteSynthesized, host, spawned: true,
        workspace_ref: spawned.workspace_ref ?? null,
        // Dry-run purity (DER-2514): the brief is not written, so hand its content back for preview.
        ...(o.dryRun ? { brief, dryRun: true } : {}),
        stdout: `rotated ${o.issueId} → rotation ${rotation} (${host})${o.dryRun ? " [DRY-RUN — nothing written, nothing recorded]" : ""}\n  brief: ${briefPath}${noteSynthesized ? "  ⚠ synthesized note (predecessor left none)" : ""}\n  wip commit: ${wipCommitted ? "created" : "nothing to commit"}\n  ${spawned.stdout ?? ""}`.trimEnd(),
      };
    }
    case "reap": {
      const state = materializeState(await readEvents(runDir), { run_id: o.runId });
      const it = state.issues[o.issueId] ?? {};
      const remoteHost = it.host && it.host !== "local" ? getHosts()[it.host] : null;
      if (!o.dryRun) {
        if (remoteHost) {
          // cmux close-workspace only drops the ssh connection — the remote claude survives (it
          // self-exits eventually, but non-deterministically). Kill it explicitly by its brief path
          // in the process args BEFORE removing the worktree it's cwd'd in, so a mini reap is clean.
          const briefMatch = `${remoteHost.ledgerRoot}/${o.runId}/briefs/${o.issueId}`;
          await runCommand({ command: "ssh", args: [remoteHost.ssh, `pkill -f ${shellQuote(briefMatch)}; true`] });
        }
        if (it.worktree) {
          if (remoteHost) {
            // Chain the stale-AUTO_MERGE cleanup (B5) into the same ssh as the worktree remove — no
            // extra round-trip; the `2>/dev/null` swallows a missing-ref error (best-effort, as before).
            await runCommand({ command: "ssh", args: [remoteHost.ssh, reapRemoteCleanupCommand({ worktree: it.worktree, repo: remoteHost.repo })] });
          } else {
            // Best-effort, matching prior reap behavior (worktree-remove failures are not fatal); the
            // AUTO_MERGE step is `optional` so a missing ref doesn't abort the removal.
            for (const c of reapCleanupCommands({ worktree: it.worktree, gitCwd: o.repoRoot ?? process.cwd() })) {
              await runCommand({ command: c.command, args: c.args });
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
      if (!o.dryRun) await appendEvent(runDir, { actor: "orch", type: "reaped", issue: o.issueId });
      return { stdout: `reaped ${o.issueId}${o.dryRun ? " (dry-run: nothing closed, nothing recorded)" : ""}` };
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
        // Checks — captured ONCE (fix 3); a red resolves its run's status (fix 4).
        const chkRes = await runCommand({ command: "gh", args: ["pr", "checks", String(n), "--repo", slug], cwd: repoRootReady });
        const chk = parseChecksOutput(chkRes.stdout ?? "");
        let note = "";
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
        const gate = gateEvidenceVerdict({ head, gate: latestGateEvent(readyEvents, issueByPr.get(n)) });
        const verdict = readyVerdict({
          draft, threads, onHead, checks: chk.checks, shardsPass: chk.shardsPass, shardsTotal: chk.shardsTotal, gate,
          allowMergeWithoutChecks: mergePolicy.allowMergeWithoutChecks,
        });
        const action = mergeAction({ mode: resolvedMode.mode, strategy: mergePolicy.mergeStrategy, pr: n, verdict });
        results.push({ pr: n, head, draft, threads, onHead, reviewSha, commentSha, checks: chk.checks, shards: `${chk.shardsPass}/${chk.shardsTotal}`, behind, push, gate: gate.state, gateLabel: gate.label, ...verdict, note, mergeMode: resolvedMode.mode, mergeModeSource: resolvedMode.source, mergeAction: action });
      }
      const header = `merge mode: ${resolvedMode.mode ?? "UNRESOLVED"} (${resolvedMode.source}) — ${resolvedMode.why}${mergePolicy.allowMergeWithoutChecks ? "  [repo.allowMergeWithoutChecks=true: an ABSENT check surface is waived; a red/pending check still blocks]" : ""}`;
      const text = [header, ...results.map((r) => readyLine(r))].join("\n");
      return { results, mergeMode: resolvedMode.mode, stdout: o.json ? JSON.stringify(results) : text };
    }
    case "preflight": {
      // Test the HARNESS before trusting it with a run (operator ask 2026-07-26). The unit suite
      // covers the pure logic; every defect the 07-26 run found lived in the DEPLOYED seams — dead
      // credentials, quota exhaustion, skills skew between hosts, a gate that exits 0 when it dies,
      // transcript persistence off, a disk nearly full (a co-factor in the cmux freeze). Each check
      // here is an instrument that CAN return the failing answer; `--skip-probes` skips the slow
      // account/gate probes (1-token completions), everything else always runs.
      const checks = [];
      const add = (name, ok, detail) => { checks.push({ name, ok, detail }); };
      const skillsDir = fileURLToPath(new URL(".", import.meta.url));

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
      // 7. Skills skew vs remote hosts — a lead on the mini following a stale brief loses gates silently,
      // and a remote skills dir without session-token-report.mjs makes every mini lead gap its spend, so
      // BOTH files are hashed (a missing file yields no hash at all ⇒ SKEW, never a matching-broken pair).
      for (const [hostName, hostCfg] of Object.entries(getHosts())) {
        if (hostCfg.kind === "cloud" || !hostCfg.ssh) continue;
        const localHash = await runCommand({ command: "sh", args: ["-c", skillsHashCommand(SKILLS_SYNC_FILES.map((f) => join(skillsDir, f)))] });
        const remoteHash = await runCommand({ command: "ssh", args: [hostCfg.ssh, skillsHashCommand(SKILLS_SYNC_FILES.map((f) => `~/.claude/skills/work/${f}`), { quote: false })], timeoutMs: 20000 }).catch(() => ({ exitCode: 1, stdout: "" }));
        const lh = String(localHash.stdout ?? "").trim();
        const rh = String(remoteHash.stdout ?? "").trim();
        add(`skills-sync:${hostName}`, !!lh && lh === rh, lh === rh ? `in sync (${SKILLS_SYNC_FILES.join(" + ")})` : `SKEW in ${SKILLS_SYNC_FILES.join(" + ")}${lh ? "" : " (a LOCAL file is missing — re-run install.sh)"} — rsync -a ~/.claude/skills/work/ ${hostCfg.ssh}:.claude/skills/work/`);
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
        for (const [hostName, hostCfg] of Object.entries(getHosts())) {
          if (hostCfg.kind === "cloud" || !hostCfg.ssh) continue;
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
          const res = await runCommand({ command: "sh", args: ["-c", `codex exec --json 'Reply with exactly: OK' 2>&1 | tail -5`], timeoutMs: 120000 }).catch(() => ({ exitCode: 1, stdout: "" }));
          const out = String(res.stdout ?? "");
          add("codex-probe", out.includes("turn.completed") || /\bOK\b/.test(out), out.includes("401") ? "401 — credential expired (login status LIES; re-login)" : (out.includes("turn.completed") ? "turn.completed seen" : out.trim().slice(-120)));
        }
      }
      const failed = checks.filter((c) => !c.ok);
      const lines = checks.map((c) => `  ${c.ok ? "✅" : "🔴"} ${c.name} — ${c.detail}`);
      // The printed marker is the gate (background-verify rule: `&&…||` chains exit 0 — gate on the
      // marker, never the exit code).
      lines.push(failed.length ? `PREFLIGHT RED — ${failed.length} failing: ${failed.map((c) => c.name).join(", ")}` : "PREFLIGHT GREEN");
      return { checks, ok: failed.length === 0, stdout: lines.join("\n") };
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
        const cursor = await readCursor(runDir, o.host);
        const remote = `tail -n +${cursor + 1} ${host.ledgerRoot}/${o.runId}/events.jsonl 2>/dev/null || true`;
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
      const PULL_INTERVAL_MS = 45000;
      const started = Date.now();
      let lastSideEffect = 0; // 0 ⇒ run pull/reconcile immediately on entry, then every ~45s
      for (;;) {
        if ((pullHostNames.length || reconcileMerged || reconcilePrEvents) && Date.now() - lastSideEffect >= PULL_INTERVAL_MS) {
          for (const h of pullHostNames) {
            try { await pullHostInto(runDir, h, o.runId); } catch { /* mini best-effort; next cycle retries */ }
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
              budget_tripped: (st.budget_trips ?? []).filter((t) => t.level === "tripped").map((t) => t.issue),
              // DER-2748: a version-skewed ledger surfaces on EVERY wake, not only when the orchestrator
              // happens to run `state`. It already blocks dispatch; this is how the operator learns why
              // before they hit the refusal. `state.protocol.reasons` names the hosts.
              protocol_skew: !(st.protocol?.ok ?? true),
              // DER-2738: lines of this ledger that never folded into state. Surfaced on EVERY wake for
              // the same reason as protocol_skew — an operator must not have to run `state` to find out
              // that the run's source of truth has holes in it. `state.ledger` names the file.
              ledger_damage: !(st.ledger?.ok ?? true),
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
        await sleep(pollMs);
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

Lead types: pass the SAME --lead-type to write-brief AND spawn-lead. The brief then names the type's
concrete per-slot models, and a type whose reviewer slot is a different vendor than its lead model
(dsv4: deepseek implements, anthropic/claude-opus-5 reviews) renders the mandatory pre-hand-off
external-review gate. Non-Claude types are host-local only.

Bundling: --bundle names the EXTRA issues one lead ships in the SAME worktree/branch/PR (SKILL.md §2
"Bundling"). The positional <DER-id> stays the PRIMARY id that keys every ledger event; the brief
tells the lead to implement all, verify the union of ACs, and open ONE PR referencing every id.

Run plan (2026-07-25): /prep-for-work sizes each issue against the real codebase, splits anything over
~800 additions / ~12 files into PR-sized Linear children, and emits a run plan. "init-run --plan" records
it; every "write-brief" then stamps that issue's ASSIGNED budget into the brief, so the lead's plan_scope
is CHECKED against a number instead of self-graded — and "budget" flags any unit whose own declaration
already busts it (over plan), which is the cheapest moment to split. Runs with no plan are unchanged.
  spawn-shepherd --run <r> [--project p] [--dry-run]
  spawn-orch --run <r> [--project p] [--model m] [--dry-run]   boot a SUCCESSOR orchestrator (/work resume <r>) — routine rotation
  append --run <r> '<event-json>'             atomic append to events.jsonl
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

  reap --run <r> <DER-id>                     git worktree remove + close EVERY workspace the issue ever had
  ready --run <r> [PR…] [--json]              per-PR merge gate (H5): BOTH Codex surfaces author-filtered, checks
                                              captured once, throttled-null threads = UNKNOWN never 0, cancelled-run
                                              note, behind-main column (CI tests the MERGE tree — H11). Resolves the
                                              merge mode once (repo.mergeMode, else a queue probe) and prints the exact
                                              command: *** ENQUEUEABLE *** → gh pr merge <n> --auto on a queue repo,
                                              *** MERGEABLE (direct) *** → gh pr merge <n> --<strategy> --delete-branch
                                              on a queue-less one. No go-ahead word ⇒ do not land the PR (DER-2753)
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
  nudge --run <r>                             wake a blocking watch immediately (freed slot / operator change)

Multi-host: create-worktree/spawn-lead/reap accept --host <local|mini|cloud>; hosts are configured in
.claude/work.config.json (see the README's multi-host section).
Lead types (CLIProxyAPI comparison): spawn-lead --lead-type <name> spawns a lead on a non-Claude model
(kimi/gpt) routed through the local CLIProxyAPI gateway, to compare lead performance. Types are defined
in .claude/work.config.json leadTypes; proxy-backed types run on --host local only (localhost gateway).
See the README's lead-types section.
Lead concentration (DER-1834): init-run accepts --host <name> (FORCE every lead onto <name>, e.g.
--host cloud) or --prefer <name> (try it first, then overflow) — recorded in run_started for pickHost.
Cloud host (kind:"cloud"): write-brief --host cloud emits the cloud-session brief; the ORCHESTRATOR
spawns it via the RemoteTrigger tool (not a subcommand) and folds WORK-EVENT PR comments via
reconcile-pr-events. See SKILL.md §3 "Cloud host dispatch".

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
