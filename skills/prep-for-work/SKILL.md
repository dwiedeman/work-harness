---
name: prep-for-work
description: Pre-run planning phase for a /work run. Use when you run /prep-for-work <linear-project|DER-1,DER-2,…> before dispatching an overnight or long autonomous run — size every candidate issue against the real codebase, split anything bigger than one PR into PR-sized Linear children, decide bundling, version-holder serialization, lead types and every founder gate IN WRITING, and emit a run plan that /work consumes. Run this BEFORE /work, never during.
argument-hint: "<linear-project> | DER-1,DER-2,… [--out <plan.json>]"
---

# /prep-for-work — the phase that sizes the work before a run exists

You are the **planner**. Your output is a machine-readable **run plan** (`tmp/work/plans/<date>-<slug>.json` + a `.md`) that `/work` consumes with `init-run --plan`, plus written answers to every decision that would otherwise become a mid-run question.

You are **not** dispatching anything. No worktrees, no leads, no PRs. If the operator wants the run started, that is `/work` after this finishes.

Plumbing: `node ~/.claude/skills/prep-for-work/prep-runner.mjs <subcommand>` (see `--help`).

## Why this phase exists (read once, then act on it)

Five-run forensics, 2026-07-19 → 2026-07-25:

| Date | PRs opened | avg additions | avg files | kickback rate | tokens/merged PR |
|---|---|---|---|---|---|
| 07-19 | 11 | 541 | 9.4 | **0.18** | 107M |
| 07-20 | 17 | 879 | 11.4 | 0.38 | **86M** |
| 07-23 | 29 | 1,024 | 11.1 | 1.7–2.8 | 213–242M |
| 07-24 | 22 | 2,322 | 16.5 | 1.42 | 235M |
| 07-25 | 9 | **3,754** | **22.8** | **8.0** | **776M** |

Dose-response across 25 PRs from four runs: `<1k` additions → **1.25** review rounds · `1k–2.6k` → 2.70 · `2.6k–5k` → 3.38 · `>7k` → **5.67**.

Cost ≈ `context × turns`. Turns per issue went 426 → 838 while per-turn context stayed flat (159K → 190K). **Turns is the multiplier, turns come from review rounds, and rounds come from diff size.** On the worst run five issues burned **2.36B tokens — 76% of the night — and merged zero PRs**.

Two things follow, and both are load-bearing:

1. **The dominant cause is issues groomed as SPEC units, not PR units.** The catastrophic PRs carry U-numbers — they were carved out of an ADR breakdown (U1, U2, U3) and dispatched as if that made them PR-sized. "External operator authentication and execution" is a 98-file change *by construction*. No lead discipline fixes that after dispatch.
2. **This must happen BEFORE the run.** Standing operator rule (DER-2350): no mid-run human gates and no mid-run escalation. Runs go overnight. One blocking question on 07-25 cost ~4h15m, left three kickbacks un-actioned ~3.7h, killed two cloud fixers, and stranded one fixer's three finished commits in draft ~2h. If no decision can be made *during* a run, every decision must be made *before* one.

**Do not sell this skill as a token saving on prompts or docs.** Always-on context is ~5,863 tokens; the most efficient night ran 1,095 orchestrator turns without rotating. Shrinking prompts does not move this bill. PR size does.

## The eight steps

Work them in order. Steps 2 and 3 carry essentially all the value — if you are short on time, do those two completely and mark the rest as done-by-default in the plan.

### 1. Assemble the candidate set

Pull the Linear project's `Todo` issues (or the explicit id list). For each: title, description, acceptance criteria, labels, links, and any comment that reads like an unresolved question. Read them — do not skim titles. A U-number, a "and" in the title, or an AC list longer than five bullets is a size smell you will confirm in step 2.

Scaffold the plan file now so every later step has somewhere to land:

```bash
node ~/.claude/skills/prep-for-work/prep-runner.mjs scaffold \
  --issues DER-1,DER-2,DER-3 --label "<wave name>" --date 2026-07-25 \
  --out tmp/work/plans/2026-07-25-<slug>.json
```

### 2. Size each issue against the real codebase — the step that catches U2/U3

For every candidate, **grep the actual touch points** before you estimate anything. You are answering one question: *what does this change drag with it?*

- Does it add or change a **command**? → 7 lockstep registry files ride along (`packages/commands/src/commands/index.ts`, `references.ts`, `operator-classification.ts`, `apps/cli/src/generated/command-manifest.ts`, `docs/specs/agent-native-command-surface.md`, `docs/reference/governed-command-capability-matrix.md`, `packages/reference/src/content.ts`). An **optional new arg still counts**. An **output-only** field addition does **not** (bounded negative, #964).
- A **migration**? → migration-number axis, a `*.db.test.ts`, a Docker-capable host.
- A **reference guide**? → `packages/reference/src/content.ts` version-holder axis.
- A **UI surface**? → tri-surface parity + the `ui-surface-parity` guard.
- Pure backend logic? → ~1 file of fan-out.

Then let the tool do the arithmetic (`--core N` = distinct implementation concerns, each ≈ impl file + colocated test):

```bash
node ~/.claude/skills/prep-for-work/prep-runner.mjs size --surfaces command,migration --core 2
# → expectedFiles / expectedAdditions / expectedRounds / versionAxes / needsDocker / split guidance
node ~/.claude/skills/prep-for-work/prep-runner.mjs surfaces          # the fan-out table
node ~/.claude/skills/prep-for-work/prep-runner.mjs surfaces --verify --repo-root "$PWD"   # table vs repo
```

Run `surfaces --verify` once per session. The table is grounded in real paths and a rotted table under-sizes **silently**, which is the one failure mode worse than not sizing at all.

**Know the estimator's bias.** It is calibrated on the median change in the authoring repo (10 files, 3 of them registry boilerplate) and it **systematically under-sizes the big multi-surface issues** — it would have called the 98-file PR ~27 files. So: `overBudget` is a floor, not a measurement. Anything the tool puts over budget is *at least* that far over, and `splitInto` is a minimum child count.

Write `budget`, `surfaces`, `versionAxes` and `riskLane` into the plan entry for every issue.

### 3. Split anything over budget — in Linear, before the run exists

**Budget: ≤ ~12 files / ≤ ~800 additions per PR.** This is the single highest-value step in the skill.

Anything over gets decomposed into PR-sized child issues **written back to Linear now**, each with its own acceptance criteria, each independently mergeable and independently valuable. Never split so finely that a child cannot stand alone.

A child should be a **tracer bullet**: a narrow but COMPLETE path through every layer it touches, verifiable on its own, and **sized to fit in one fresh context window**. That last framing is sharper than the raw addition count and it is the constraint that actually binds — the additions budget is its proxy, not its definition.

Split axes that fit this repo, in preference order:
1. **By surface lane** — DB+command in one child, web UI in another, docs/reference in a third. The tool draws these lines for you when the issue spans ≥2 lanes.
2. **By pipeline stage** — read path / write path / enforcement.
3. **By class-member group** — sites A–C in one child, D–F in the next. Use when there is no surface seam.
4. **Expand → migrate → contract, for a WIDE REFACTOR.** A wide refactor is one mechanical change — rename a column, retype a shared symbol — whose blast radius fans across the codebase, so a single edit breaks thousands of call sites at once and **no vertical slice can land green**. Do not force it into a tracer bullet. Sequence it: *expand* (add the new form beside the old, nothing breaks) → *migrate* in batches sized by blast radius, each its own child blocked by the expand, CI green batch to batch because the old form still exists → *contract* (delete the old form, blocked by every migrate batch). This is the axis the other three cannot express, and it is exactly the shape of run 07-27's two largest PRs (31 and 32 files).

**Give every child its blocking edges, and work the frontier.** A child with no unmet blockers can start immediately; that set is the frontier. Record edges in `dependsOn` — the validator already rejects a cycle and warns when a dependency is not NAMED in `notes`. Do this properly and the orchestrator stops hand-deriving eligibility mid-run: on run 07-27 two consecutive orchestrator shifts wrote throwaway scripts to recompute the eligible set, and one of them got a blocked-by wrong (DER-2526 was held by DER-2486, not DER-2527).

When you split, in Linear: create the children under the same project, copy the relevant ACs verbatim into each, link them `relatedTo` the parent, set the parent to `Canceled`/`Duplicate` (or keep it as a tracking epic and move it out of `Todo` so nothing dispatches it), and record `splitFrom` in the plan entry. A split that exists only in the plan file and not in Linear will be silently re-merged by the next grooming pass.

**Enumerate the class members while you are here.** ~80% of repeat kickbacks were *"same class, new site"* — the lead fixed one instance and the reviewer found the siblings one round at a time. If an issue is "fix X everywhere", grep every site now and put the list in the plan's `notes`; the brief carries it, and the lead fixes the class on round 1.

### 4. Decide bundling under an explicit policy

Bundle **only** when *all* of these hold: file scopes genuinely overlap · the work is mechanical · the **combined** estimate is still under budget · no member is in a risk lane.

**Never bundle to save CI.** ~500 PRs/month against ≈$1,063/mo CI ⇒ **~$2–5 CI per PR**. One extra review round ⇒ ~100–150M tokens ⇒ **~$35–50**. Bundling two issues saves ~$5 and buys 1–2 rounds: **net loss 3–7×**, before wall-clock. The real lever on CI cost is path-gating and DER-1832 (e2e-pr is ~30% of CI failures), not bigger PRs.

### 5. Serialize the version-holder axes

Live axes (2026-07-25): reference-guide `version:` in `packages/reference/src/content.ts` (`check:docs-version`) and the **migration-number space**. The `apps/cli` per-PR axis was **RETIRED** (DER-1356) — CLI bumps are publish-time serialized via `classifyCliPublishContract` / `check:cli-version`. Do **not** re-introduce per-PR CLI serialization.

Two PRs bumping the *same* axis to the *same* value look mergeable — git auto-resolves identical changes — and the second fails its guard the instant the first merges. Put same-axis holders in a `serialization` group or bundle them. Pre-allocate migration numbers with `pnpm db:next-migration` (max+1/+2/+3) and note that they are re-derived at every rebase.

Also flag **concept collisions**: two issues touching different files but depending on the same not-yet-merged shape. Bundle by concept or serialize, and make the dependent's `notes` **NAME** the sibling contract ("build ON DER-1233's merged registry shape") — the plan validator warns when a `dependsOn` has no note, because an unnamed dependency means the lead invents its own shape.

### 6. Assign lead type by risk lane

**Size discipline first — it outranks every model choice below.** Within claude-opus *alone*, kickbacks per unit rise **0.53 → 2.21 → 2.12** across the 1–8 / 8–16 / 16+ files-touched bands: a **4× swing from size at a fixed model**, against a total cross-model spread of only ~1.3–2×. And Claude first-pass units deliver **3.23× their assigned budget** (13/16 over; median 525 assigned vs 1471 actual) where gpt holds **1.16×**. So the highest-leverage thing you do in this step is size and split honestly (§2–§4) — re-tiering the lead is second-order.

| lane | first pass | why |
|---|---|---|
| governance · security · invariant · schema · money · SSRF | **claude-opus (cloud)** | 95 first-pass units at **4% escalation**. Not because it wins the normalized table — it doesn't — but because it's the only type whose sample is large enough to trust on hard work. |
| standard feature work, ≤16 files, crisp brief | **kimi** | Best or tied-best on every normalizer at every band it appears in: **0.40** kickbacks/1k additions, 100% merge, 0 rotations, 0 failures, 23% escalation. Widen it (~13 → ~25 units) as a **measurement**, not a settled conclusion — n=10. |
| UI · copy · docs · mechanical | **claude-sonnet** | 100% merge, 0.62 kickbacks per 10 files. Unchanged. |
| a unit **stuck ≥3 rounds** on its current family | **gpt as finisher** | It closed 5 units (DER-2161, 2160, 2251, 1363, 2193) that Claude *and* dsv4 had failed to close after 4–6 rounds. A fresh context on a different model breaks a stuck kickback loop. |
| — | **gpt not first-pass above ~8 files** | 56% escalation, 2.86 kickbacks/1k additions, and a 270K window that forces ~1 rotation per unit. |
| — | **dsv4-pro stays retired from first pass** | Measured, not inherited: **0 of 6** units held alone, all 6 escalated to Claude, 3 needed a *third* family to close. |
| — | **dsv4-flash unproven — not endorsed** | Its 3 units total **163 additions across 8 files** (median 54 adds). If retested, give it ONE 200–600-addition unit and escalate at the first kickback. |

Keep the existing escalation rule: a `dsv4` lead gets **one** kickback round before re-spawn on `kimi`/`claude`.

**Two normalizers, and they disagree** — quote the one you mean. Pure units (one family start→finish):

| | kimi | claude-sonnet | claude-opus | gpt | dsv4-flash |
|---|---:|---:|---:|---:|---:|
| kickbacks / 1k additions | **0.40** | 1.54 | 1.16 | 2.86 | 6.13 |
| kickbacks / 10 files touched | **0.52** | 0.62 | 1.05 | 1.46 | 1.25 |
| units (n) | 10 | 18 | 73 | 4 | 3 |

claude-sonnet and claude-opus swap 2nd/3rd between the two, and dsv4-flash swings from last to
4th — which is the tell that its 3-unit / 163-addition sample carries no signal, not that it
beats gpt. **Only kimi's position is stable.** dsv4-pro has *zero* pure units, so it appears in
neither row.

**Carry these caveats whenever you report the numbers — the previous version of this table was wrong for exactly these reasons** (full analysis in your own operator notes):

- **The confound is still real and still unfixed.** Model, review strictness and issue difficulty were confounded by design — governance lanes drew Opus *and* the stickiest reviews at once. Size-matching collapses most of the spread: kimi's headline 2.9× edge over claude-opus becomes **1.3× at matched size on n=5**, and its four large clean units are large-but-*narrow* and near-purely additive (6–13 files, del/add ≤ 0.056 — new-surface scaffolding, not surgery across a family) where claude-opus's comparable units span 21–58 files. **None of this confidently ranks models on skill. It assigns lanes.**
- **dsv4-flash's old #1 spot (1.25 rounds/100%) was task triviality, not skill** — median 54 additions, 2 files. Size-normalized it has the *worst* rate in the set (6.13/1k adds). Never credit a type for winning at tasks no model could lose.
- **Type-of-record is the OBSERVED model, never the ledger's `leadType`** — a mid-run `--model … --resume` leaves no event. Resolving from `token_usage.by_model` moved 9 sessions, including 7 where `leadType` was absent and the "absent ⇒ claude" default was wrong (5 mini sessions were really `gpt-5.6-sol`).
- **A session is the trial, not a unit** — 19 units were handled by >1 provider family (one ran 5 sessions across 3 families for a single PR), so a unit's kickbacks and its merge cannot be credited to its declared type. And **per-session metrics structurally reward types that rotate** (gpt leads per-session cleanliness purely because rotation manufactures extra clean sessions). Use per-unit.
- **No dollar comparison exists across providers** — kimi/gpt/dsv4 carry no price table, so their `cost_usd_estimate` is null; and total tokens aren't comparable either (Claude's cache-read inflates them cheaply). Compare output tokens. Pre-2026-07-16 runs give merge/kickback counts only.
- **Kickback magnitudes are basis-dependent** — the old figures counted "rounds" (≈1+kickbacks, via a `kickback_count` whose semantics changed to delivery-based on 2026-07-26); the new ones count **raw kickback events per unit**. Never mix the two bases in one comparison.

### 7. Resolve every founder decision, in writing

Sweep the set for anything that would become a mid-run question — a policy ceiling, an irreversible action, a naming call, a "should we also…". Answer it **now**, with the operator if needed, and record it in `decisions[]` with who decided and when.

Any issue whose gate is still open is **held out of the run** (`heldOut[]`), not dispatched hoping. The validator treats an unresolved `gate` as a hard error for exactly this reason.

If the operator is unreachable while you are planning: state the default you will take, record it as the decision with `by: "planner-default"`, and move on. Do not park the phase on a blocking prompt — that is the same failure mode this skill exists to prevent, one phase earlier.

### 7b. Codex-anticipation adversarial pass — pre-empt the cloud reviewer per issue (2026-07-26)

The GitHub Codex reviewer is a great pre-merge gate but its findings are the run's dominant recycle cost — and most of what it flags is PREDICTABLE from the repo's own review corpus. For each planned issue, run an adversarial pass over the issue's plan (not code — none exists yet) and emit a **watch-outs block** the lead will implement *toward*, so the finding never gets written:

1. **Assemble the predictor corpus once per session:** `AGENTS.md § Code Review Rules` (every rule there is a defect class Codex has actually posted), the per-package `AGENTS.md` of each package the issue touches, `~/.claude/<your-learnings-file>.md` review-rule entries, and the latest run's kickback classes (the 07-26 run: instrument-blindness — checks that cannot fail; test-binds-symbol-vs-call-site; SQL-mirrors-validator drift; incomplete-family edits; silent input loss).
2. **Per issue, adversarially ask:** which of these classes does THIS change shape invite? A new guard → "enumerate every sibling entry point, Codex will find the one you missed". A registry/command → "the 7 lockstep files, plus error precedence". A migration/SQL predicate → "derive from the Zod schema, never mirror it". A test asserting a property → "bind the test to the CALL SITE, not the exported symbol". Anything with a doc/comment → "the code in the same diff must match it".
3. **Run the real instrument on the plan — MANDATORY as of 2026-07-29 (was "optional").** The corpus pass predicts from memory; this one *reads the repository*. Two commands, and `validate` fails without a recorded result:

   ```bash
   node ~/.claude/skills/prep-for-work/prep-runner.mjs plan-review <plan.json> DER-1234
   # → writes the prompt + prints the exact `codex exec` command. Run it, then:
   node ~/.claude/skills/prep-for-work/prep-runner.mjs plan-review-record <plan.json> DER-1234 \
     --review tmp/plan-review/DER-1234.review.json --log tmp/plan-review/DER-1234.codex.jsonl
   ```

   The four things that decide whether the instrument works (measured 2026-07-25): plain `codex exec`, **never** `codex exec review --base` (it is diff-local, and there is no diff at plan time); the prompt must **mandate searching**; the checkout needs `node_modules` present or the reviewer goes blind; and it obeys `AGENTS.md § Code Review Rules`, so the repo's own corpus steers it for free.

   **`plan-review-record` REFUSES a review that never completed or never searched the repo.** `codex exec` can complete with `command_execution=0` and return wholly fabricated findings (DER-2504) — and a plan review is exactly where that is undetectable, because there is no diff to check the output against. A refused review is the correct outcome; recording it would write an empty watch-out list that reads as "reviewed". If codex is genuinely unavailable on this host, set `planReviewSkipped: {why: "…"}` — an unexplained skip is indistinguishable from a forgotten one, so the validator rejects a bare skip.

   **Why this is worth a mandatory gate:** on run `20260727T004346Z`, 36 kickbacks landed across 24 merged PRs and review rounds were the dominant recycle cost. A plan edit costs one re-brief; the same finding on a PR costs a review round (~100–150M tokens, ~$35–50).
4. **Land the output where the lead will actually read it:** append a `**Codex watch-outs:**` list (3–7 bullets, each "class → concrete instruction for THIS issue") to the issue's acceptance text in the plan (`notes`/acceptance fields — `write-brief --acceptance` carries it into the brief verbatim). Watch-outs are ACs phrased as review-findings-not-yet-written; the lead's step-5 self-review checks against them explicitly.

This pass plus the P2-defer policy (shepherd skill, 2026-07-26) attacks the recycle bill from both ends: fewer findings get written, and the ones that are get triaged out of the round loop.

### 7c. Grounding gates — the deterministic complement to 7b (2026-07-29)

7b's codex review is probabilistic: it catches what the plan **fails** to claim. These four are deterministic: they ground what the plan **does** claim. Both exist because of one measured fact: an implementation plan in this repo was written by an agent that explicitly cited *"a check that cannot fail is not evidence"*, was revised twice while actively hunting that exact class, and still shipped **six vacuous checks** — found only by two independent reviewers. The class survives attention. It does not survive arithmetic.

Declare the claims while sizing (steps 2–3), then run the gates; `validate` refuses a plan whose declared claims are ungrounded:

```bash
node ~/.claude/skills/prep-for-work/prep-runner.mjs mutation-check <plan.json> --record
node ~/.claude/skills/prep-for-work/prep-runner.mjs query-check    <plan.json> --repo-root <repo> --record
node ~/.claude/skills/prep-for-work/prep-runner.mjs symbol-check   <plan.json> --repo-root <repo> --record
node ~/.claude/skills/prep-for-work/prep-runner.mjs priorart-check <plan.json> --repo-root <repo> --record
```

1. **mutation-check** (refuses in validate): every check/test/guard a plan entry proposes (`checks: [{name, mutation, observedFailure}]`) must name the exact edit that makes it FAIL. `--record` folds an observe-the-failure AC into `notes` (the brief carries it verbatim): the implementer must APPLY the mutation, SEE the failure, and record the message in `observedFailure` — a described failure is not an observed one. Post-implementation, `mutation-check --require-observed` verifies the record.
2. **query-check** (refuses): any query used as evidence — a kill criterion, a recurrence count, a "returns zero so we're clean" — must carry a `window` and `expectAtLeast` naming a known-positive history, and the tool RUNS it. Motivating case: a kill criterion's grep matched **2 of the 6 commits its own plan cited** — it would have returned zero and auto-selected "delete the tool" while the problem recurred.
   **Two things decide the verdict, and the exit status is the first of them.** A run that exits nonzero or is killed is a FAILED run, not a small count: it is stamped `observed: {count: 0, failed: true}` and `validate` refuses it, so output alone can never buy a pass. (Until 2026-07-30 only spawn failure was noticed — spawnSync sets `error` when the *shell* cannot start, never when the command it ran exits 1 — so a query printing three lines and exiting 1 was stamped `ok`, and the canonical zero-match `… | grep -c 'fix('` exited 1 with stdout `0`, which read as `ok 1 ≥ 1`: the kill criterion returning zero, passing.) The second is **how the output is counted**: a pipeline whose LAST stage is `grep -c` / `rg -c` / `wc -l` — reached by a **pipe**, or standing alone as the whole query — is counted by NUMBER when stdout is a single bare integer; everything else counts non-empty stdout lines. Both halves are required: `grep -c` over *multiple* files emits `path:count` lines (a per-file breakdown, never a total) and falls back to line counting, and a `;`/`&&`/`||`-joined trailing `wc -l` consumed nothing upstream so its number is not the query's answer. Write the documented shape — `git log --oneline --since=… | grep -c 'fix('` with `expectAtLeast: 6` — and it now means what it says; before numeric mode that floor was unsatisfiable at any number of matches, because `grep -c` prints one line whether it counted 5 or 500.
   **The query is also refused unless it is read-only, and it runs with NO SHELL.** `evidenceQueries[].query` came out of a plan file — which is often assembled from issue text and lead output — and reached `spawnSync(…, {shell: true})` with only a *shape* check in front of it, so a plan could execute anything in your repo root. It is now parsed (quote-aware) and every segment of a `|`/`&&`/`||`/`;` pipeline is validated independently against an **allowlist** of read-only commands (`QUERY_READONLY_COMMANDS` in prep-runner.mjs: git, rg, grep, sed, awk, jq, find, wc, sort, head, cut, …), with per-command escape hatches closed (`sed -i`, `awk system()`, `find -exec`, `git -c alias.x='!…'`, `--output=`, …). Redirection is allowed only to `/dev/null`. **Execution is argv, not a shell** (DER-2836): the parsed pipeline is run one stage at a time as `spawnSync(cmd, args)` with stdout piped into the next stage, so nothing expands the query a second time and the arguments the rules checked are the arguments the command gets. That closes a P0 in which `find . $(printf -- -delete)` passed every check — the substitution was validated on its own (`printf` is read-only) and collapsed to a placeholder, so find's `-delete` rule was applied to a word that was not yet `-delete`. Consequently **`$(…)`, backticks, `$VAR`, `$'…'` and unquoted globs are now REFUSED in every position**, because nothing would expand them and running the literal text would answer a different question than the one you wrote: use `--since=2026-07-01` rather than `$(date …)`, and quote a glob so the command matches it itself (`find . -name '*.mjs'`, `git ls-files 'skills/**'`). **"Read-only" is not the only test — the second is "can it reach a network":** a command that writes nothing still exfiltrates if it can name a remote, because the URL is in the collector's access log before the request fails. So `git ls-remote` (and `fetch`/`push`/`clone`/…) is refused despite reading; gawk's `/inet/…` socket special files are refused in every argument position, including inside a `getline <`; `< /dev/tcp/host/port` and `< /dev/udp/…` are refused (an input redirect from a socket is an outbound connection, and `/bin/sh` is bash on macOS); and a `<` whose target is built by expansion (`< $(…)`) is refused because that "read" is a command. awk/gawk **options** are default-deny against a closed list — `-F`/`--field-separator`, `-v`/`--assign`, `--posix`, `--sandbox`, `--` — so an unrecognised option like `-fprog.awk`, `--source=…`, `-o`/`-p`/`-d` or `--include=` is refused, not skipped. **Pipelines are the feature and still work** — `git log --oneline --since=… | grep -c 'fix('` passes untouched. An unrecognised command is refused rather than run, so if a legitimate query is rejected the refusal names the allowlist and widening it is one line. Known sharp edges: a query needing a value computed at run time cannot express it (inline the value); `awk '$1 > 100'` and `awk '$1 < 100'` are refused (`>`/`<` inside a program are indistinguishable from a redirect or a `getline` without an awk parser — use `grep`/`sort -rn`), and `xargs`/`tee` are refused outright.
3. **symbol-check** (refuses): every named call/test target (`symbols: [{name, from, use?}]`) must exist and be exported from where the plan implies. A **private** target is a **re-scope** — test through the public entry that reaches it; exporting a private function solely so a test can import it is the shape AGENTS.md's test-binds-symbol rule rejects. `use: "edit"` permits private for modify-in-place plans. Motivating case: a brief demanded a behavioral test of `assertConfirmationScopeAuthority` — a non-exported function with only internal call sites; unimplementable as written, one full lead round to discover.
4. **priorart-check** (warns — the only gate whose outcome can DELETE work, which is exactly why the tool never does the deleting): sweeps tests + guards (rg, grep fallback) for prior art already asserting what each issue proposes to add, and reports candidates for HUMAN judgement; record your call in `priorArt.disposition`. Two of one wave's planned deliverables already existed in full (`cli-adapter.test.ts:1148`; `scripts/db-next-migration.mjs`).

The declared-claims contract cuts both ways: gates 1–3 only hold what the plan declares, so a plan that declares nothing passes them trivially. That gap is 7b's job — the codex review flags the *missing* must-fail control or sibling surface — and its watch-outs should become declared `checks`/`symbols`/`evidenceQueries` entries these gates can then hold.

**When you extend these gates, mutation-audit their own suite before trusting it**: neuter each new gate function (`return []` / constant-true) and confirm tests actually go red. The first version of this very tooling shipped with one shape guard (`symbolShapeProblems`) that could be deleted with the whole suite green — found exactly that way, by a reviewer applying the gates' own standard to the gates. The class needs arithmetic, not attention, including from the people building the arithmetic.

### 8. Emit and validate the run plan

```bash
node ~/.claude/skills/prep-for-work/prep-runner.mjs validate tmp/work/plans/<file>.json   # exit 1 = not dispatchable
node ~/.claude/skills/prep-for-work/prep-runner.mjs render   tmp/work/plans/<file>.json --out tmp/work/plans/<file>.md
```

`validate` is the gate between "we thought about it" and "the run may start". Every check corresponds to a failure that cost a night: an over-budget unit dispatched as one PR, two PRs holding one version axis, a governance issue first-passed on a cheap lead, a founder question hit at 3am. **Do not hand a plan to `/work` until validate exits 0.**

Plan shape (the validator is the source of truth):

```jsonc
{
  "label": "overnight wave", "date": "2026-07-25",
  "issues": [{
    "id": "DER-1234",
    "budget": { "files": 10, "additions": 700 },   // ASSIGNED, not self-declared
    "surfaces": ["command", "migration"],
    "coreUnits": 2,
    "riskLane": "governance",
    "leadType": "claude",
    "bundleWith": [],
    "versionAxes": ["migration:0139"],
    "dependsOn": ["DER-1233"],
    "splitFrom": "DER-2161",
    "notes": "build ON DER-1233's merged registry shape; class members: a.ts, b.ts, c.ts",
    // grounding gates (7c) — declared claims; validate refuses them ungrounded
    "checks": [{ "name": "entropy floor", "mutation": "the exact edit that makes it FAIL", "observedFailure": null }],
    "evidenceQueries": [{ "name": "recurrence", "query": "git log …", "window": "known-positive history", "expectAtLeast": 6 }],
    "symbols": [{ "name": "evaluateCommandAuthorization", "from": "packages/…/file.ts", "use": "test" }]
  }],
  "serialization": [["DER-1240", "DER-1241"]],
  "heldOut": [{ "id": "DER-1250", "why": "ceiling-raise gate unresolved" }],
  "decisions": [{ "q": "…", "a": "…", "by": "operator", "at": "2026-07-25" }]
}
```

## Handing off to /work

Run the harness preflight FIRST and gate on its printed marker — `node ~/.claude/skills/work/work-runner.mjs preflight` must end `PREFLIGHT GREEN` (it probes the things that kill runs silently: account quota per host, the codex credential, skills sync, telemetry hooks, disk). Then:

```bash
node ~/.claude/skills/work/work-runner.mjs init-run --issues DER-1,DER-2 --plan tmp/work/plans/<file>.json
```

`init-run` now runs **the canonical validator — the same `validatePlan` this skill's `validate` subcommand uses, at identical strictness (DER-2746)** — and refuses the run rather than creating a run directory. Two doors onto one plan file must not differ in strictness, or the weaker one is the only one that matters. Practical consequence: a hand-written plan, or one authored before the mandatory plan-review gate, now refuses at `init-run`; the only escape is the documented `planReviewSkipped:{why:"…"}`, deliberately, because a `--force` on a gate this young is how it becomes decoration. Warnings stay advisory and do not block. It also records the plan path on `run_started`. From then on, every `write-brief` stamps that issue's **assigned** budget into the brief (both the local and the cloud template), so the lead's `plan_scope` is **checked against a number instead of self-graded** — the cloud brief never asking for a scope at all is precisely why DER-2161 shipped 98 files with none on record.

Then `work-runner budget --run <r>` flags any unit whose own declaration already busts its assignment (**📐 over plan**). That is the cheapest possible split signal: it fires *before a line is written*, where a split costs one re-brief instead of 800M tokens.

Mid-run splits get their budget explicitly, without editing the plan:

```bash
node ~/.claude/skills/work/work-runner.mjs write-brief --run <r> DER-9 --worktree <p> \
  --budget-files 6 --budget-additions 400
```

**Plan sizes the work; the caps catch the cases where sizing was wrong.** The per-issue circuit breaker (DER-2347) and the round cap (DER-2349) are the safety net, not the system. A cap without a plan just converts token overruns into a pile of unfinished splits.

## Close the loop — calibrate after every run

The estimates **will** be wrong, and without this they ossify at whatever was first guessed.

```bash
# actuals.json: [{"id":"DER-1234","files":14,"additions":900}, …] from `gh pr view <n> --json changedFiles,additions`
node ~/.claude/skills/prep-for-work/prep-runner.mjs calibrate tmp/work/plans/<file>.json --actuals actuals.json
```

With ≥3 data points it prints the multiplier to apply to the sizing table. Move `SURFACES` / `CORE_UNIT` in `prep-runner.mjs` when the median ratio holds across two runs — not on one surprising PR. Also record what the phase itself cost: a sizing pass over ~28 issues should run 20–50M tokens against one avoided round at 100–150M. Measure it rather than assuming it.

## Success metric

**Tokens per merged PR** (`work-runner metrics`). Baseline to beat: **86M** (07-20). Failure state: 776M (07-25). Secondary: kickback rate back under 0.5, and **zero** issues finishing a run with >250M tokens and no merged PR.

## Guardrails

- **Never dispatch from this skill.** No `git worktree`, no `spawn-lead`, no PRs. Plan, write to Linear, emit, stop.
- **Never widen an issue's scope while planning.** Splitting is allowed; adding work is a new issue in `Backlog`.
- **Don't relitigate settled architecture** — no microservices, Postgres `ltree` is the graph, tri-surface parity is a product requirement. The fix for registry boilerplate is *generating* the surfaces (DER-2001), not deleting them.
- **Over-splitting has a real cost**: more PRs → more merge-queue traffic and more version-holder collisions. It is only safe if steps 5 and 6 are done in the same pass. Never defer serialization to the run.
- **CI cost genuinely rises** with smaller PRs. Accept it — the economics are 3–7× in favour — and pursue path-gating + DER-1832 as the real CI lever.
