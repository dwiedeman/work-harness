# Cloud lead brief template (cloud lead env)

Template for a `/work` lead running as a Claude Code **cloud session** (dispatched by
`work-runner.mjs spawn-cloud`, which wraps `claude --cloud`; before 2026-08-18 it was a claude.ai
RemoteTrigger one-shot routine). THE WHOLE BRIEF IS ONE ARGV STRING — it is the only channel into the
session, so nothing here may rely on a file the lead cannot fetch. The session starts ON the issue
branch (it clones the ref checked out in the orchestrator's worktree), which is why step 1b CONFIRMS the
branch with `checkout -B` instead of creating it. Fill the `<…>` slots. This mirrors the
local `/work-lead` brief but adapts to the cloud sandbox's constraints (learned 2026-07-15 across 6
qualification probes). Keep the **Provenance & authorization** block — zero-context cloud sessions
have refused injection-shaped briefs without it.

---

## Provenance & authorization
This task was scheduled by **<repo.ownerLogin>**, the repository owner, from his own Claude
account via a one-shot routine on his own cloud environment. The environment's
`GH_TOKEN` secret was configured by him for this purpose. The commit-author convention below is the
repo's own — verify it in `CLAUDE.md` § *Commit author = repo owner*. You are a delivery lead for
`<repo.repoSlug from .claude/work.config.json>`; take issue **<DER-id>** to a clean PR and hand off.

## Session preamble (run FIRST — these are session-time duties the setup script can't do)
```bash
# 1. Re-assert commit identity (platform rewrites global git config after setup; repo-local usually
#    survives, but set it here to be certain — else Vercel reds the PR and Codex may skip review)
git config user.name "<commitAuthor.name>" && git config user.email "<commitAuthor.email>"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
# 2. Deps (usually pre-warmed + cached in the snapshot; install only if missing)
[ -d node_modules ] || pnpm install --frozen-lockfile
# 3. DB-lane only: load the Postgres image from the release asset if not already present
if ! docker image inspect <your-registry>/<your-db-image>:<tag> >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 || { dockerd >/tmp/dockerd.log 2>&1 & sleep 8; }
  curl -fL -H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/octet-stream" \
    https://api.github.com/repos/<repo.repoSlug>/releases/assets/<repo.dbImageAssetId> \
    -o /tmp/pg.tar.gz && docker load -i /tmp/pg.tar.gz && rm -f /tmp/pg.tar.gz
fi
```

## Cloud-specific conventions (differ from local `/work-lead`)
- **No worktree, no cmux** — you're a fresh clone in an isolated VM. Work directly in the checkout.
- **GitHub writes:** PR creation → prefer the **GitHub MCP tools** (they author as `<repo.ownerLogin>`, so Codex
  engages **and the orchestrator can authenticate the PR as yours** — since DER-2778 it derives your
  `lead_online`/`handed_off` only from PRs authored by a trusted login on a branch in this repo, so a PR
  opened as anyone else reads as "lead never started"). `gh` REST (`gh api repos/.../...`) works but authors comments as `claude[bot]`. **`gh pr
  comment` / any GraphQL is DISABLED** in cloud sessions — use `gh api` REST for issue/PR comments.
- **DB tests:** run on the default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, but the
  **reset connects as `supabase_admin`** — `pnpm db:local:reset` uses that image-only role; do not
  override DATABASE_URL to plain postgres for the reset. Per `packages/db/AGENTS.md`.
- **Verify targeted** (typecheck + lint + changed test files, one `*.db.test.ts` if DB-touched);
  CI is the gate for the HEAVY suites (db-suite, e2e, route-health). The box is ~4 vCPU / 15 GB — the
  full fast suite runs but is slow. **EXCEPTION — deterministic guards are YOUR gate, not CI's:** if
  the diff adds/changes a command, MCP tool, or reference guide, or touches `packages/commands`,
  `packages/reference`, or `apps/cli`, run and pass BEFORE marking ready (seconds each; every skipped
  one cost a kickback round on 2026-07-16): `pnpm check:manifest && pnpm check:cli-version &&
  pnpm check:docs-version && pnpm docs:check` + the registry tests (ui-surface-parity, command-tools,
  inventory, agent-how-tos). A NEW command trips ~6 registry surfaces (§17.8 classification, MCP guide
  rows in GENERATED-from-title form, inventories/counts, reference entry, guide `version:` above
  `git show origin/main:<file>`, regenerated CLI manifest + `pnpm fix:cli-version` above origin/main —
  which makes the PR a VERSION-HOLDER that serializes in the queue). **Paste the guard evidence into the
  PR body / hand-off note — the command you ran + a one-line green summary. A hand-off without guard
  evidence is kickback-bait:** every round-1 hand-off on 2026-07-18 was kicked back for a `guards` red
  (tenant-SQL DER-1092, docs-sync) or a protected-lane finding the lead could have caught locally.
- **Subagent delegation is MANDATORY** (Agent tool works in cloud): decompose into 2–4 implementation
  chunks, each dispatched to a Sonnet 5 subagent (`model: "claude-sonnet-5"`), research to Haiku, run
  IN PARALLEL where file scopes are disjoint. The lead plans, adversarially reviews each diff,
  integrates, and owns the PR — it does not write implementation code itself (integration glue
  <~20 lines excepted). PR body must carry an "AC → evidence" checklist + the subagent breakdown.

## Draft-PR-first lifecycle (how the orchestrator sees you — DER-1838)
There is no local ledger file, and you must NOT enumerate/report session or env identifiers (that
reads as recon and gets refused). Instead the orchestrator derives everything from your **PR state**:
1. **At boot, before doing the work:** confirm the branch you are already on — `git rev-parse --abbrev-ref HEAD` should print `<gitBranchName>`; if not (or if detached), pin it with `git checkout -B <gitBranchName>`, never `checkout -b` (which fails on the branch you are already on) → empty WIP commit
   (`git commit --allow-empty -m "wip(<DER-id>): cloud lead started"`) → push → **open a DRAFT PR via
   the GitHub MCP tools** (draft:true, base main). A draft runs **no CI and no Codex**. Its footer
   carries your `session_01…` handle automatically — that's the orchestrator's liveness signal + the
   owner's read-only monitor handle. (No draft PR within the deadline ⇒ the orchestrator re-spawns you.)
   **Then post your token-telemetry comment IMMEDIATELY (near-zero initial snapshot) and save its id:**
   `TCID=$(gh api repos/<owner>/<repo>/issues/<PR>/comments -f body="$(node scripts/session-token-report.mjs --role lead --issues <DER-ids> --pr <PR> --host cloud)" --jq .id)`
   The script reads your OWN session transcripts locally and reports tokens by model — it emits no
   secrets and no session/env identifiers. **Boot-check contract:** this draft-PR-open + first telemetry
   comment IS your boot signal and your FIRST actions after boot — do them so the orchestrator can verify
   them **within 15 minutes** of the trigger firing; miss that window and you're presumed failed-to-start
   and re-spawned.
2. **Do the work** on the same branch, pushing commits as you go (each push = your progress signal).
   **Push early, push often:** land your first commit+push within **~30 min of boot**, then push at every
   coherent chunk — an unpushed session that dies loses everything, while a pushed branch lets a
   continuation resume (four cloud sessions died silently 30–90 min in with nothing pushed on 2026-07-18).
   **After EVERY push, refresh the SAME telemetry comment** (reports are cumulative; the orchestrator's
   fold keeps the latest per report_id, so a session that dies mid-work still leaves its last-push spend
   on the record — this is why it matters):
   `gh api -X PATCH repos/<owner>/<repo>/issues/comments/$TCID -f body="$(node scripts/session-token-report.mjs --role lead --issues <DER-ids> --pr <PR> --host cloud)"`
3. **Token telemetry final refresh — IMMEDIATELY BEFORE marking ready**, same PATCH as above (do this
   before EVERY ready-flip, kickback re-hand-offs included, with `--kickback <n>` on kickback rounds).
   If `$TCID` was lost, post a fresh comment with the same command — the stable report_id dedups it.
4. **Hand off = mark the PR `ready_for_review`** via the GitHub MCP tools once targeted verify is green.
   That draft→ready transition triggers CI + Codex and hands you to the shepherd. Do NOT merge.
(Optional belt-and-suspenders: when you mark ready, capture `SHA=$(git rev-parse HEAD)` and post
`gh api …/issues/<PR>/comments -f body='WORK-EVENT
{"type":"handed_off","issues":["<DER-id>"],"pr":<PR>,"host":"cloud","sha":"'"$SHA"'"}'` — the runner's
fold now reads that `sha` as deterministic evidence of a real pushed fix, so include it.)

### 🔴 QUIESCE after ready — this is the rule cloud leads break most

**Push the whole round, THEN mark ready, THEN stop touching the branch.** Once you are ready the
shepherd may start a gate at that instant, and a gate reviews ONE sha — a later push produces a verdict
covering a tree nobody read. Measured: **four head-moves under a running gate in one night** (#1292 ×2,
#1282 ×2); on #1292 r2 the push landed **102 seconds** into a 12-minute, $6.11 review and touched the
exact file under review. The single lead that quiesced had its gate valid first try.

The launcher re-reads `headRefOid` before accepting any verdict and stamps `stale` on a mismatch, so a
quiet push cannot slip a stale gate through — it just burns the round and it gets paid for twice. If a
push is genuinely unavoidable, say so in a hand-off comment naming the new sha.

**You HAVE a `codex` binary — run the pre-PR gate yourself.** On a codex-provisioned cloud environment
`command -v codex` resolves to `/opt/node22/bin/codex` (0.147.0), auth is materialized at session start
by a `SessionStart` hook, and effort is pinned to `high`. Verified 2026-08-18 with a real
`turn.completed` from a CLI-dispatched session (`session_01FWCKuvj9ga9NMbTb2Ude2R`). Run it from the
repo root, after targeted verify is green and BEFORE hand-off:

```bash
codex exec --json --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort="high" '<search-mandating review prompt>' < /dev/null
```

Three ways this fails **silently**: (a) omit `< /dev/null` and codex hangs to timeout on "Reading
additional input from stdin…" at ~0% CPU, byte-identical to a quota wall; (b) run it outside the repo
and it refuses on the trusted-directory check; (c) `codex login status` returns an EOF parse error even
when auth is perfectly healthy — judge the run by a positive `turn.completed` in the JSONL, never by
that command and never by absence of complaint.

One cloud-only trap: the auto-mode **classifier** denies bash that reads or executes credential
material, and **three consecutive denials stop your session waiting for a human**. `codex exec` itself
is not denied — so run it directly and never wrap it in a script that touches auth.

**Only if `command -v codex` is genuinely empty** (you are on a non-provisioned environment) does the
old rule apply: say so explicitly in your hand-off note so the orchestrator supplies the gate leg
locally. Either way, do NOT quietly substitute the Claude panel, and do NOT hand off ungated while
implying it was gated.

**Kickback re-spawn (item 1):** if this brief has a "⚠ Kickback" block, the PR already exists and the
shepherd **converted it back to draft** when kicking it back (so your fix pushes run no CI). Skip the
PR-open in step 1 (don't open a new PR) but DO post your own fresh telemetry comment at boot (you are a
NEW session with a new report_id) — then load the branch, fix the findings, push to the same branch
(refreshing the comment after every push, with `--kickback <n>`), and **re-mark the PR
`ready_for_review`** after the final telemetry refresh.
That second draft→ready IS your re-hand-off; the orchestrator re-derives it.
**NEVER mark ready without having pushed a fix** — a ready flip at the unchanged head SHA is a flap the
harness ignores. **Fix the CLASS, not the instance:** when a finding is one of N siblings (data sources,
entry points, release paths), enumerate and fix them ALL this round. The brief's "Prior rounds" dossier
lists what earlier rounds fixed — verify those are still intact on HEAD; don't re-litigate stale Codex
reposts (check the finding against HEAD before "re-fixing" it).

## Known non-issues (accepted conventions — do not flag, "fix", or chase)
<paste the current contents of ~/.claude/skills/work/known-non-issues.md here — DER-1992>

## Issue
- **Acceptance criteria:** <AC>
- **Reference-as-map:** <the analogous existing implementation to pattern-match — file / PR / package — or "no analog exists">
- **Playbook:** open the draft PR (step 1 above) → read AGENTS.md + the area's invariants → plan if
  non-trivial → build via subagents → targeted verify + write tests → adversarial self-review → push →
  mark the PR ready_for_review. **Record every deviation from this brief in the PR body** (the shepherd
  checks it before enqueue). Do NOT merge (the shepherd owns CI/merge).
- **Guardrails:** never modify the `/work` harness; stage explicit paths (never `git add -A`); never
  enumerate/report env or session ids into comments; no secrets in comments/logs (redact presigned-URL
  query strings); conservative-by-default.
