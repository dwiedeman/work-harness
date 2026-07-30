# work — a multi-agent delivery harness for Claude Code

Ship a whole backlog overnight. `work` decomposes a project into PR-sized units, dispatches one
autonomous lead per unit across local, SSH and cloud hosts, and drives every PR from open to merged
through a persistent shepherd — while recording enough telemetry that you can tell afterwards whether
it actually worked.

It is a **local development harness**, not a product. You are the orchestrator; the harness is the
plumbing you shell out to.

---

## What it actually is

Four cooperating roles, one append-only ledger:

| Role | What it is | Lives in |
|---|---|---|
| **Orchestrator** | Your `/work` session. Decides what dispatches, when, and where. Rotates itself before it degrades. | `skills/work/SKILL.md` |
| **Lead** | One autonomous session per unit, in its own git worktree. Implements, self-reviews, opens a PR, hands off. | `skills/work-lead/SKILL.md` |
| **Shepherd** | One long-running session that takes handed-off PRs through review to merge. | `skills/work-shepherd/SKILL.md` |
| **Planner** | A pre-run phase that sizes and splits the work before any of the above exists. | `skills/prep-for-work/SKILL.md` |

Everything they know about a run lives in `tmp/work/<run-id>/events.jsonl` — append-only, folded into
state on demand. That ledger is the reason the harness can survive every one of its sessions being
replaced mid-run.

**The design claim, stated plainly:** the expensive failure in agentic delivery is not a model writing
bad code — it is *review rounds*, and rounds scale with diff size. Measured across 25 PRs from four
runs: under 1,000 additions → **1.25** review rounds; 2,600–5,000 → **3.38**; over 7,000 → **5.67**.
On one run the PRs that met the size budget took **0.17** kickbacks each while the ones that busted it
took **1.6–2.5**. Almost every opinion in this harness follows from that.

---

## Dependencies

### Required

| Dependency | Why | Install |
|---|---|---|
| **Claude Code** | Every role — orchestrator, lead, shepherd — is a Claude Code session. | [claude.com/claude-code](https://claude.com/claude-code) · `npm i -g @anthropic-ai/claude-code` |
| **Node.js ≥ 20** | The harness is Node built-ins only. No npm dependencies at all. | [nodejs.org](https://nodejs.org) |
| **git ≥ 2.30** | One worktree per unit; `merge-base --is-ancestor` for head-movement proof. | [git-scm.com](https://git-scm.com/downloads) |
| **GitHub CLI (`gh`) ≥ 2.50** | PR lifecycle, checks, review threads, merge queue. Must be authenticated. The floor is `gh pr checks --json`, which `ready` needs to tell a **red** CI from a repo that has **no** CI — on an older `gh` that probe cannot answer and every PR holds on `checks=UNKNOWN`. Verified working on 2.76.2 and 2.86.0. | [cli.github.com](https://cli.github.com) · then `gh auth login` · check with `gh --version` |

A Claude **subscription** (Pro/Max) is strongly recommended over metered API billing — the launchers
drop `ANTHROPIC_API_KEY` deliberately so sessions ride OAuth. A long run on metered API pricing is
expensive; see [Claude pricing](https://www.anthropic.com/pricing).

### Optional — each unlocks one feature

| Dependency | Unlocks | Install / docs |
|---|---|---|
| **cmux** | The visible cockpit: one pane per role, and the spawn mechanism for local + SSH leads. Without it you can still drive the runner CLI directly. Override the binary with `WORK_CMUX_BIN`. | [github.com/manaflow-ai/cmux](https://github.com/manaflow-ai/cmux) |
| **Linear** | Issue mode (`--issues`), status transitions, and the tracking issue in spec mode. Wire it up as an MCP server. | [linear.app](https://linear.app) · [Linear MCP docs](https://linear.app/docs/mcp) |
| **Codex CLI** | The local adversarial review gate **and** the mandatory plan review. Both degrade gracefully when absent (the plan-review skip must be written down). | [github.com/openai/codex](https://github.com/openai/codex) · then `codex login` |
| **Docker** | Real-database tests on a lead host. Hosts without it are marked `noDocker` and DB-lane issues are never routed there. | [docker.com](https://www.docker.com/get-started/) or [Colima](https://github.com/abiosoft/colima) on macOS |
| **A second machine over SSH** | Overflow capacity (`hosts.<name>.kind: "ssh"`). Needs a clone of your repo and Claude Code installed there. | — |
| **Claude Code cloud environments** | Cloud leads (`hosts.<name>.kind: "cloud"`), spawned via the `RemoteTrigger` tool. One environment **per Claude account**, each with a `GH_TOKEN` secret. | [Claude Code docs](https://docs.claude.com/en/docs/claude-code) |
| **A model gateway** (e.g. CLIProxyAPI) | Non-Claude lead types routed through a localhost endpoint. | [github.com/router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) |
| **OpenRouter** | Direct third-party lead models without a gateway. Key read at launch from your repo env file. | [openrouter.ai](https://openrouter.ai) |

### Not required

There is **no `package.json` and no `npm install`.** Every script is Node built-ins only, so the
harness has no supply chain of its own and nothing to keep up to date.

## Install

```bash
git clone https://github.com/dwiedeman/work-harness ~/work-harness
cd ~/work-harness && ./install.sh          # copies into ~/.claude and runs the test suites
```

<details>
<summary>Manual install (what <code>install.sh</code> does)</summary>

```bash
git clone https://github.com/dwiedeman/work-harness ~/work-harness

# Skills live where Claude Code looks for them.
mkdir -p ~/.claude/skills ~/.claude/hooks
cp -R ~/work-harness/skills/*        ~/.claude/skills/
cp -R ~/work-harness/hooks/*         ~/.claude/hooks/

# Per-repo config.
mkdir -p /path/to/your-repo/.claude
cp ~/.claude/skills/work/work.config.example.json /path/to/your-repo/.claude/work.config.json
$EDITOR /path/to/your-repo/.claude/work.config.json
```

</details>

Then verify the deployed harness before trusting it with a run:

```bash
cd /path/to/your-repo
node ~/.claude/skills/work/work-runner.mjs preflight
```

Gate the run on the printed `PREFLIGHT GREEN`. Preflight probes the things that kill runs *silently* —
per-account quota, credential expiry, skills skew between hosts, transcript persistence, disk headroom.
Each check is written so it can return the failing answer; a check that cannot fail is not evidence.

### Upgrading, and the version contract

`install.sh` **is** the upgrade path — pull and re-run it. It copies into `~/.claude`, then runs the
harness's own suites there and **exits nonzero if they are not green**, so a broken upgrade tells you
instead of reporting success (DER-2743; before that fix both self-test lines ended in `|| true` and the
install could not fail).

```bash
cd ~/work-harness && git pull && ./install.sh   # exits nonzero if the deployed suite is red
cat VERSION                                      # what you just installed; CHANGELOG.md describes it
```

Two rules worth respecting:

- **Never re-run `install.sh` while a run is in flight on that machine.** It replaces the code the running
  orchestrator and leads are executing from. Install between runs.
- **Keep hosts on the same version.** Multiple machines run copies of this harness against one shared
  ledger; the version is not yet recorded *in* the ledger, so skew is currently invisible (tracked in
  DER-2748). Until then, upgrading one host means upgrading all of them.

`.github/REPO-SETUP.md` documents the CI checks and the branch-protection settings for anyone forking
this repo to develop the harness itself rather than just install it.

### Telemetry hooks (optional but recommended)

Without these, every token number the harness reports is an undercount. Add to `~/.claude/settings.json`:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node $HOME/.claude/hooks/context-wrap-nudge.mjs" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "node $HOME/.claude/skills/work/session-end-telemetry.mjs" }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "node $HOME/.claude/skills/work/session-context-report.mjs" }] }]
  },
  "env": { "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE": "1" }
}
```

---

## Configure

Everything repo-specific lives in `<your-repo>/.claude/work.config.json`. Nothing in `skills/` or
`hooks/` should ever contain your repo path, your GitHub login, or a credential — if you find one, it
is a bug, not a customization point. See `work.config.example.json` for every key.

The three you almost certainly need:

```jsonc
{
  "repo": { "repoSlug": "you/your-repo", "ownerLogin": "you", "repoPath": "$HOME/your-repo" },
  "commitAuthor": { "name": "You", "email": "0000000+you@users.noreply.github.com" },
  "worktreeRoot": "/tmp/agent-work"
}
```

**Credentials are never stored in config.** The harness builds a *runtime shell expression* that reads
a key from your gateway config or repo env file at launch, so the raw value never appears in a ledger
event, a logged command line, or a `--dry-run` preview.

### Environment variables

| Variable | Purpose |
|---|---|
| `WORK_ROLE` | `orch` \| `lead` \| `shepherd`. Set by the launchers; makes hooks role-aware. |
| `WORK_RUN_DIR` | The active run directory. Set by the launchers. |
| `WORK_CMUX_BIN` | Override the `cmux` binary path. |
| `WRAP_NUDGE_WINDOW` / `_GENTLE` / `_STRONG` | Override context-rotation thresholds. |

*(`ROST_WORK_*` are the legacy names, still read as a fallback.)*

---

## Use

### 1. Plan before you run

```bash
node ~/.claude/skills/prep-for-work/prep-runner.mjs scaffold --issues ABC-1,ABC-2 --out plan.json
node ~/.claude/skills/prep-for-work/prep-runner.mjs size --surfaces command,migration --core 2
```

Size every unit against the real codebase, split anything over budget (**≤ ~12 files / ≤ ~800
additions**) *before* the run exists, and record every decision that would otherwise become a 3am
question. This phase carries most of the harness's value; skipping it is how a run costs 5× what it
should.

**The plan review is mandatory.** Reviewing the *plan* is the cheapest moment to delete a finding — a
plan edit costs one re-brief; the same finding on a PR costs a review round.

```bash
node ~/.claude/skills/prep-for-work/prep-runner.mjs plan-review plan.json ABC-1
# ...run the printed `codex exec` command, then:
node ~/.claude/skills/prep-for-work/prep-runner.mjs plan-review-record plan.json ABC-1 \
  --review out.json --log codex.jsonl
```

`plan-review-record` **refuses** a review that never completed or never searched the repo. A reviewer
that ran zero repository commands returns confident, fabricated findings — and against a plan there is
no diff to catch it. Recording that would write an empty watch-out list that reads as "reviewed".

```bash
node ~/.claude/skills/prep-for-work/prep-runner.mjs validate plan.json   # exit 1 = not dispatchable
```

### 2. Run

Two modes. They key the ledger identically and report the same metrics, so you can A/B them.

**Issue mode** — one tracker issue per unit:

```bash
node ~/.claude/skills/work/work-runner.mjs init-run --issues ABC-1,ABC-2 --plan plan.json
```

**Spec mode** — one spec, one tracking issue, units carved in the plan:

```bash
node ~/.claude/skills/work/work-runner.mjs init-run --spec plan.json
```

Spec mode exists because the recurring failure in issue mode is a lead inventing its own shape: it
cannot see its sibling's contract. A spec shows the whole shape by construction. It relaxes nothing
else — budgets, risk lanes, version-axis serialization and the plan-review gate are identical.

Then start the orchestrator:

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN WORK_ROLE=orch \
  claude --dangerously-skip-permissions "/work <run-id>"
```

Dropping `ANTHROPIC_API_KEY` keeps the session on your subscription rather than metered API billing.

### 3. Watch

```bash
work-runner state   --run <id>          # folded run state
work-runner budget  --run <id>          # per-unit spend + delivered-vs-assigned size
work-runner ready   --run <id>          # per-PR enqueue gate
work-runner lead-context --run <id>     # every in-flight lead's context utilization
work-runner watch   --run <id>          # block until something happens
```

### 4. Measure

```bash
node ~/.claude/skills/work/work-metrics.mjs --run tmp/work/<id>
node ~/.claude/skills/work/work-metrics.mjs --all --runs-root tmp/work
```

Track **kickback rate** and **tokens per merged PR**. Then close the loop — the sizing estimates *will*
drift:

```bash
node ~/.claude/skills/prep-for-work/prep-runner.mjs calibrate plan.json \
  --actuals actuals.json --run <run-id>
```

`--run` is required, and self-comparison is refused: a measurement cannot confirm itself. The table
moves only when a ratio holds across **two independent runs**.

---

## Design notes worth knowing before you extend it

These are the rules the harness enforces on itself. Each exists because breaking it cost a real run.

- **A check that cannot fail is not evidence.** Every probe must be paired with a control known to
  produce the failing answer. A `grep -c` over a file with control bytes prints nothing, which reads
  exactly like a legitimate zero.
- **Evidence must name the head it covers.** A review recorded against an older commit is not evidence
  about the tree that would merge. The enqueue gate compares shas; it does not merely check that a
  review event exists.
- **A different sha is not a later sha.** Head movement is verified with `git merge-base --is-ancestor`,
  because a hand-off once carried an *ancestor* of the kickback sha and silently cleared five findings.
- **A death claim is a suspicion, not a verdict.** Liveness probes produce false positives; a false
  death that reaches a respawn puts a second writer on live uncommitted work. Post-death work refutes
  the claim automatically, and the surfaced entry says so.
- **The orchestrator never blocks on a human.** Runs go overnight. Every decision is made before the
  run or by the orchestrator during it; a wrong-but-reversible call beats a stopped run.
- **Subagents are files-only.** The orchestrator owns every `git worktree` operation. Parallel
  `worktree add`s stomp each other.

---

## Repository layout

```
skills/
  work/                  orchestrator skill + work-runner.mjs (the plumbing) + metrics
  work-lead/             the per-unit lead's operating instructions
  work-shepherd/         the PR shepherd's operating instructions
  prep-for-work/         pre-run sizing, splitting, plan review, calibration
hooks/
  context-wrap-nudge.mjs context-aware rotation nudge
```

Run the test suites before trusting a change — the harness tests itself, and `preflight` runs them:

```bash
node --test ~/.claude/skills/work/work-runner.test.mjs ~/.claude/skills/work/work-metrics.test.mjs
node --test ~/.claude/skills/prep-for-work/prep-runner.test.mjs
```

---

## License

TBD.
