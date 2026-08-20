# Changelog

All notable changes to the work harness. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are [semantic](https://semver.org/spec/v2.0.0.html). The single source of truth for the current
version is the `VERSION` file at the repo root — `repo-contract.test.mjs` fails if this file has no
section for it.

## Why a version at all

Multiple hosts run copies of this harness (local, an ssh host, cloud sessions), each installed at a
different time by `install.sh`. Before 0.2.0 there was no recorded version anywhere, so two hosts could
run materially different harness code against **one shared ledger** with no way to detect the skew.
0.2.0 closed that: every ledger line carries a wire `schema_version`, `run_started`/`heartbeat` stamp
`harness_version`, and a mixed-version or foreign-schema ledger refuses dispatch (DER-2748). The dispatch
gate itself gained the missing half below — attesting the *acting* process's own version, not only
versions already recorded in the ledger — in DER-2779.

## [0.8.10] — 2026-08-20

**A metrics report that never said how long the run took, and a README that said "License: TBD" over an MIT LICENSE file.**

- `work-metrics.mjs` now reports **Run duration** (first→last ledger event, with the end timestamp) in
  `renderRunMarkdown` and exposes `runEndedIso` / `runDurationHours` on the metrics object. The label is
  honest about what it measures: a run that idled overnight still counts the night.
- README `## License` now says MIT and links the LICENSE file — it had said "TBD.", which contradicted
  the shipped MIT license and was the single most likely line to stop an evaluator from adopting.
- README gained "What a real run looks like" (a pasted production metrics table with cost and duration
  expectation-setting) and "Starting from an empty repo" (the spec-mode path for greenfield use).
- `skills/work/SKILL.md` no longer names the maintainer's GitHub login/noreply address in the DER-1838
  cloud-attribution note — the README's own rule says nothing in `skills/` may carry a login; the note
  now states the proven check generically (token owner, `is_bot:false`, owner's noreply address).

## [0.8.9] — 2026-08-19

**`memgate` had never once passed, and it was costing 15 minutes per lens.**

Every MEMGATE line ever logged was a TIMEOUT — `freeRAM=15MB`, `19MB`, `33MB`. On #1357 the gate burned
**30 of 55 wall-clock minutes doing nothing**: 15 minutes of sleep before each of two lenses that then
took 17.5 and 7.9 minutes to actually review. A check that can never return its PASSING answer is as
useless as one that can never fail — the same rule pointed the other way — and worse than absent,
because it looks like protection.

**Two independent reasons it could not pass, and the second was the real one:**

1. It read `vm_stat`'s *Pages free*, which macOS keeps near zero by design (idle RAM is lent to the
   cache). Measured the same day: killing three stale processes reclaimed ~1.0 GB — `vm.swapusage used`
   12,796 → 11,797 MB — and *Pages free* went **down**, 31 → 15 MB. Now measures **available** =
   free + inactive + purgeable + speculative, which is what Activity Monitor means and what a new
   process can actually get. Same instant: free 19 MB, available 838 MB.
2. **`[ 524.5 -ge 900 ]` is an integer test on a float.** `vm.swapusage` free is `"524.50M"`, and awk's
   `$9+0` yields `524.5`; bash errors with *"integer expression expected"* — to stderr, unread — and the
   condition evaluates FALSE. **So the swap half could not be satisfied at any threshold, and had not
   been since 0.6.0.** Fixed with `printf "%d"`.

Reason 2 was found by the CLEAR control the first time one was ever written: it reported
`blocked_by=swapfree` against a floor of **0**. Without the `blocked_by` field the RAM fix alone would
have shipped, still never passed, and looked correct.

- **Available-RAM measurement**, floors configurable (`WORK_GATE_MEMGATE_AVAIL_MB` default 500,
  `WORK_GATE_MEMGATE_SWAP_MB` default 256). On the operator's box right now: available 812 MB, swapfree
  540 MB → **clears immediately, 0s wait**, where the old gate slept 15 minutes.
- **Wait capped at 2 min** (24 × 5s, was 90 × 10s). Real starvation does not clear in 15 minutes; a long
  wait only delays the same decision.
- **A timeout now names what blocked it** — `blocked_by=availableRAM+swapfree`. Reporting both numbers
  and no verdict is precisely how a dead swap comparison hid for four minor versions.
- **Two controls, one per direction** — that it CLEARS on a healthy box, and that it TIMES OUT on an
  unreachable floor, names the blocker, and still proceeds. Neither existed before, which is why a gate
  that never passed went unnoticed.

## [0.8.8] — 2026-08-19

**The scope contract reached codex and not the panel** — found while preparing to run a panel-only
round on #1358 (codex quota-walled until 08-20 14:50).

0.8.7 restored `--contract` but appended the block inside the codex leg only. A round that fell back to
the panel therefore reviewed **unscoped** — while `gate-verdict.json` still said nothing at all, since
the panel receipt had no `scope_contract` field to carry. The fallback quietly reproduced the exact
defect DER-4055 is about, on the leg that costs ~$17 instead of ~$0.

- **One `append_contract` function, two callers.** The codex leg and every panel lens now share one
  implementation, so the two prompts cannot drift again. A lens logs `CONTRACT_APPENDED_LENS <lens>`.
- **The panel receipt carries `scope_contract` and `test_evidence`**, like the codex receipt.
- **Two controls**, mutation-proved: deleting the panel-leg call reddens "PANEL lenses get the SAME
  scope contract as codex"; the negative control pins that an unbriefed panel round records
  `scope_contract: "absent"` rather than silently reading as briefed.

Found by asking what a *fallback* round would actually send, rather than trusting that restoring the
flag had restored the behaviour on both paths — the same "verify the sibling, not just the member the
reporter named" rule the reviewed repo applies to families.

## [0.8.7] — 2026-08-19

**`run-gate.sh` lost its scope contract to `install.sh` and nothing noticed for a day** (DER-4055).

The `--contract` (§0.3 scope block) and `--tests` (§0.4 pre-sandbox test evidence) flags were written on
2026-08-15 for the pre-beta gate wave and shipped **only into `~/.claude`** — never committed here.
`install.sh` is a one-way `cp -R skills/. $DEST/skills/`, so its first run on 2026-08-18 copied the
pre-W0 file back over them. Measured: every gate prompt from #1333 through #1345 carries
`in_scope` / `known_dependent_units` / `ship_blocking_rule`; every prompt from #1353 onward carries
**zero**, and the prompt shrank from ~9–21 KB to ~6–7 KB. Three units (#1353, #1354, #1356) were gated
with no scope contract at all, and one of the P1s that parked #1353 was a scoping its own diff disclosed.

Nothing exposed it. An unscoped round exits 0 and returns a well-formed, high-confidence findings payload
shaped exactly like a scoped one — `gate-verdict.json` could not distinguish the two.

- **Restored** `--contract FILE` and `--tests "<vitest args>"`, plus the `TMPDIR` redirect for the codex
  leg, byte-for-byte as they ran on #1333–#1345.
- **The receipt now names its own briefing.** `gate-verdict.json` carries `scope_contract`
  (`applied` | `absent`) and `test_evidence` (`attached-exit<N>` | `skipped-wrong-sha` | `absent`), and a
  round with no contract logs a loud `CONTRACT_ABSENT`. The question "was this round briefed?" had no
  answer on any surface before; now it is in the artifact the recorder already reads.
- **Five controls in `run-gate.test.mjs`**, each mutation-proved to return the failing answer: dropping
  the `--contract` case (the exact revert shape) kills 2; hardcoding `scope_contract=applied` kills the
  negative control; removing the `--tests` sha guard kills 1; flipping `STALE_AT_START` to `exit 0`
  kills 2. CI already runs this suite, so the same revert now reds here instead of in a review round.

**Correction to DER-4055 as filed:** `STALE_AT_START` does *not* return exit 0. It returns 2, it always
has, and the pre-existing "refuses to START" test covered it — verified with a stubbed `gh` reporting a
head that differs from `--sha`, and re-verified by mutating the exit code and watching two tests fail.
Only the scope-contract half of that issue was real.

## [0.8.6] — 2026-08-18

Round 5 of the pre-PR gate (`turn.completed = 1`, 67 command executions, verdict **not ready**: 2×P1, 4×P2)
— the THIRD consecutive round dominated by defects the previous round's fixes created. This release is
deliberately **narrow**: it takes the subset of round 5's findings that is mechanically correct and leaves
the two genuine design questions open rather than reflexively patching them, because "fix everything the
reviewer named, immediately" is the loop that produced rounds 3, 4 and 5.

- **An already-bound PR could go dark when its title gained a second run id** (round 5 #2, the dangerous
  half of 0.8.5's ambiguity refusal). `deriveCloudPrEvents` now resolves from the **durable binding**
  (`state.issues[id].pr`, passed as `boundIssue`) before considering the text, so a PR that has folded
  before cannot be detached by an edit like `fix(DER-2): preserve DER-1 compatibility`. This mattered more
  than it looks: a detached PR reads as a lead that never started, which routes the operator to a
  REPLACEMENT SPAWN onto a branch that already has work on it. A never-yet-bound ambiguous PR is **still
  refused, still silently** — that residual is DER-4051's remaining design work and is not fixed here.
- **Any spawn cleared a still-owed blocked rotation** (round 5 #4). A kickback respawn has nothing to do
  with the owed rotation, but it erased `lead_rotation_blocked` and the path to the already-written brief —
  "prepared then forgotten" one level up from the bug the banner was added for. The block now clears only
  on a spawn carrying the **matching** rotation number.
- **The disabled-host rule now covers every host KIND, not just cloud** (round 5 #6). `rotate-lead`
  synthesizes its host for every kind, so a disabled **mini** still took an automatic rotation spawn while a
  disabled cloud host was refused — the guard had been written `isCloud && …` for the one kind the round-4
  reviewer happened to name, which is the same one-instance-at-a-time mistake one level up. A disabled ssh
  host is also no longer contacted at all: the kill probe used to run first and die on an unverifiable
  verdict, so the operator got "fix your ssh" instead of "this host is disabled".
- **`THE FAMILY` test now iterates every ledger-resolved member** instead of hardcoding `steer-cloud`
  (round 5 #6). Its `rotate-lead` legs run on a no-worktree unit so every leg stops at the same structural
  point and the only variable is whether the guard fired — a `--dry-run` version of this was written first
  and was WRONG (dry-run skips writing the brief, so the enabled leg died on a missing brief and would have
  "passed" as a refusal).

**Known open, deliberately not fixed here** — both are design questions, filed rather than patched:
DER-4053 (reaping an ACTIVE cloud unit skips the only kill/probe step and records a clean teardown while
the session may still be running; and a failed local worktree removal still reports a clean reap) and
DER-4051 (durable primary attribution, so an unbound ambiguous PR surfaces as an observable state instead
of an empty array). Every cloud host remains `enabled:false`.

## [0.8.5] — 2026-08-18

Round 4 of the pre-PR gate (`turn.completed = 1`, 94 command executions, verdict **not ready**: 4×P1, 5×P2).
Its findings were again dominated by defects the PREVIOUS round's fixes created — the second consecutive
fix-induced round. So this release does not patch the call sites the reviewer named. **Each fix is applied
to the class, and each class gets a test that derives its own roster or sweeps its own property**, because
one-instance-at-a-time is the mechanism by which all three rounds recurred.

- **`steer-cloud` sent work to a DISABLED host with no human opt-in** (DER-4050). 0.8.4 established the
  rule — a `--host` this harness MANUFACTURES from ledger state is not the operator's choice — and applied
  it to `rotate-lead` only. `steer-cloud` resolves its host the same way and had no guard, so a kickback
  round walked straight into an account someone had disabled for 429s or a wall. It now refuses before the
  command is built, records nothing (the round stays on `kickbacks_pending`), and prints the deliberate
  `--host` opt-in. **`THE FAMILY` test derives its roster from the runner's own `VERSION_GATED_SUBCOMMANDS`**:
  a new dispatching subcommand must declare its disabled-host behavior or the suite fails.
- **The missing-session recovery named the WRONG account** (DER-4050). The lookup required
  `e.cloudSessionId`, which is exactly the field a routine-era `lead_spawned` lacks — so the one event that
  knew the unit's host was discarded on the path built to recover it, and the printed command pointed at a
  different account's environment. Host resolution no longer depends on the session id.
- **`reap` could not clean up a CLI cloud unit, so a cloud run could never be closed out** (DER-4053).
  Every host but literal `local` was treated as ssh-remote; a cloud entry has no `ssh`/`ledgerRoot`/`repo`,
  so cleanup composed `undefined/<run>/briefs/<id>` and threw — no worktree removal, no `reaped` event. The
  axis is host **kind**: a cloud unit owns a LOCAL staging worktree and has no ssh process to kill. Cleanup
  deliberately ignores `enabled` — a unit that has already done its work must be reapable after its host is
  disabled. This was the actual blocker on delivering an issue end-to-end through the cloud lane.
- **A PR could still fold onto the WRONG unit** (DER-4051). Identity matching had been fixed twice and was
  still first-hit: an open-ended `<id>-` prefix let `SPEC-DEMO-U1` claim both the prose word
  `spec-demo-u1-compatibility` in a title about U2 and the unrelated longer unit `spec-demo-u1-followup-u2`,
  and `runIssues.find` let ledger order beat an exact title match. Matching is now **ranked** (exact, then
  the `<id>-work` branch shape that is the prefix rule's only real purpose) and **ambiguity is refused**
  rather than guessed — except for a bundle, where one primary covering every winner still resolves.
- **A blocked rotation was invisible to the next wake** (DER-4050). `rotation_prepared` had been appended
  since 0.8.4 and nothing folded it, so a prepared-and-waiting rotation read exactly like an untouched one.
  It now folds to `state.lead_rotation_blocked` with its reason and its already-written brief, and clears
  when the dispatch lands. The no-worktree branch also runs BEFORE the disabled-host guard, which had
  shadowed it and printed `--worktree <p>` for a unit that has no worktree.
- **Dry-run stopped claiming work it skipped** (DER-4050): `rotate-lead --dry-run` reported
  `noteSynthesized: true` although synthesis is explicitly skipped; it now reports `noteWouldSynthesize`.

Still open from round 4, filed rather than fixed here: DER-4052 (the documented failed-to-start recovery
selects a `.kb<n>.md` brief that does not exist for an initial spawn failure, and the ROST mini runbook's
routing prose is stale).

## [0.8.4] — 2026-08-18

Round 3 of the pre-PR gate, which reviewed the forced-only change itself. Three of these are defects the
previous round's fixes CREATED — the reason a round reviews the current head rather than the original diff:

- **`rotate-lead` could auto-spawn onto a DISABLED cloud host.** 0.8.2 made "an explicitly named host is
  the operator's opt-in" the rule; `rotate-lead` synthesizes `--host <host>` from ledger state, so a
  machine was authorizing itself with the human's syntax. An operator who disables a host mid-run (429s, a
  walled account, a repointed environment) means "no more work here", and a rotation is more work — so it
  now stops at `rotation_prepared` (with `blocked:"host_disabled"` on the event) and prints the exact
  command a human would run.
- **Whole-token id matching broke `create-worktree`'s own default branch for SPEC units.** That branch is
  `${id.toLowerCase()}-work`, so a spec unit lives on `spec-demo-u1-work` — a word no `<letters>-<digits>`
  rule can find, which silently unhooked spec units from `lead_online`/`handed_off`. An id now matches a
  word exactly OR as its leading `<id>-` segment; the trailing `-` is what keeps `der-403` from claiming
  `der-4036-work`. Both id families and the collision are pinned by tests.
- **`steer-cloud`'s "no session id" refusal threw a ReferenceError** instead of explaining itself: the new
  message named `hostName` above its declaration. A refusal path is exactly where nobody looks until it
  fires.
- **Every cloud replacement command now carries `--host <the unit's own host>`** — in `steer-cloud`'s
  fallback text and in SKILL's failed-to-start and kickback recoveries. Without it the command defaults to
  `cloud`, which is `enabled:false`, so the documented recovery refused itself; on a multi-account fleet it
  would also silently move the unit to another account's environment.
- SKILL's routing paragraph still described cloud-first filling in its tail after its head had been
  corrected to say cloud is not the default.

## [0.8.3] — 2026-08-18

Two stale claims in the deployed skill, both found by the pre-PR gate reviewing the config change that
depended on them:

- **"Cloud is the default lead host … `preferHosts: [\"cloud\"]`"** — false since the 2026-08-13 directive,
  and it taught the wrong mental model besides: `pickHost`'s order is `[...preferHosts, ...EVERY other
  host]`, so omitting a host from the list does not stop it receiving work once the preferred ones fill.
  Only `enabled:false` does that — and `--host <name>` then bypasses it, by design. The section now says
  to read `preferHosts` back rather than assume it, and states what the list does not do.
- **Cloud PR attribution was listed under "Proven behavior".** It was proven on the RETIRED routine path.
  On the CLI path a 2026-08-18 probe got as far as `GH_TOKEN` being present in-session and no further
  (DER-4036 stopped it), and presence is not attribution — the check is a real draft PR's author login,
  canonical head repository, and `isCrossRepository:false`.

## [0.8.2] — 2026-08-18

Two defects the round-2 pre-PR gate **executed** rather than argued, both in code the cloud migration made
load-bearing:

- **A unit id was matched as a SUBSTRING of a PR's branch-or-title.** `hay.includes("der-403")` is true of
  a PR titled "DER-4036 …", so a run holding both ids folded DER-4036's lifecycle events onto DER-403 —
  repointing the wrong unit's PR, and able to hand off the wrong one. Ids are now matched as whole tokens
  (the `<user>/der-4036-slug` branch form still matches, and spec-mode `SPEC-…-U1` ids still match). This
  bug predates the migration; the migration made the PR TITLE the only place a cloud lead's id appears,
  which is what turned a latent mismatch into a routing hazard.
- **`spawn-cloud` refused the very opt-in the config prescribes.** `pickHost` treats a forced host as an
  explicit operator opt-in and bypasses `enabled:false`; `spawn-cloud` demanded `--force` on top of
  `--host <name>`, so "disabled means forced-only" was true of routing and false of dispatch. Naming a host
  explicitly is now the opt-in on both paths; a DEFAULTED disabled host still refuses, because nobody chose
  it.

## [0.8.1] — 2026-08-18

**A cloud lead does NOT move off its own branch, and the pre-PR gate policy in the deployed skill is
corrected.** Both came out of an adversarial review of 0.8.0's own change, and the first one reverses a
decision 0.8.0 shipped an hour earlier:

- **The cloud brief no longer prescribes a branch bind.** A `claude --cloud` session is bound by its SYSTEM
  prompt to a `claude/<title-slug>-<hash>` branch ("NEVER push to a different branch without explicit
  permission"). Handed 0.8.0's bind step, a real lead REFUSED it as an in-task attempt to override that
  binding — the right call for a zero-context session reading untrusted text. So the lead now stays on its
  own branch and **the issue id rides the PR TITLE**, which is what `deriveCloudPrEvents` already matches
  on (`headRefName + " " + title`). `spawn-cloud`'s branch/sha guard keeps its job with its purpose
  restated: it protects the session's CLONE SOURCE, not the lead's working branch. Tracked as DER-4036.
- **SKILL.md said the adversarial panel was THE pre-PR gate**, and that revisions were panel-only — the
  pre-2026-08-12 policy, contradicting ADR-0027 §2, `CLAUDE.md`, and this harness's own `run-gate.sh` for
  six days. The section is now marked superseded (codex every round; panel is the fallback), and the same
  correction is applied to `review-panel`'s help text and code comment.
- **§3 now states the gate-receipt gap out loud (DER-4037):** a cloud lead's in-session codex gate cannot
  reach the ledger, because `review_findings` is deliberately absent from the cloud-reportable WORK-EVENT
  allowlist (a forgeable gate receipt is exactly what that allowlist exists to prevent), so `ready` reports
  `gate=MISSING`. Until that is designed, a cloud unit means the orchestrator still owes the gate leg
  locally — which is why the cloud hosts stay `enabled:false`, the harness's own "forced-only" state
  (`pickHost` skips a disabled host automatically but honors `--host <name>`; merely omitting a host
  from `preferHosts` does NOT stop an automatic spill, since the order is preferred-then-everything).

## [0.8.0] — 2026-08-18

**Cloud leads are dispatched as `claude --cloud` sessions, and a cloud kickback steers the live lead.**
Two new subcommands replace a recipe the orchestrator ran by hand with MCP tools:

- **`spawn-cloud`** wraps `claude --cloud` in a pty (the CLI refuses `-p`/`--bg` and demands a TTY) and
  records the returned `session_…` id as the dispatch receipt on `lead_spawned` (`cloudSessionId`,
  `host_kind:"cloud"`, `branch`, `sha`, `model`, `worktree`). The receipt and the ledger event are now
  written by ONE code path — the routine recipe created the session with an MCP tool and then relied on
  the orchestrator hand-appending the event, which is the seam a fabricated id gets in through. An absent
  id records `lead_spawn_failed` and never a synthesized one; an id with a nonzero exit IS a dispatch
  (the session exists, so a retry would put two leads on one branch) and carries a do-not-retry note.
- **`steer-cloud`** delivers a kickback INTO the running session — which still holds the context of the
  work the findings are about — and records `kickback_relayed` instead of a second `lead_spawned`. It
  demands a `kickback_ack` WORK-EVENT comment, because a steer queues behind the in-flight turn and
  "sent" is not "read". Delivery is proven by the CLI's own `Sent to cloud session`, not by exit 0; an
  unproven steer records NOTHING, so the round stays pending and keeps waking the orchestrator, and the
  refusal prints the `spawn-cloud --kickback` fallback for an expired session.

**A cloud lead now needs a worktree — this REVERSED.** A CLI cloud session clones the ref checked out in
the cwd and has no branch-selection flag, so `spawn-cloud` refuses without `--worktree`, and refuses
again unless that branch is on `origin` at the worktree's exact HEAD sha (`--push` publishes it). Both
halves are measured failures: a local-only commit dies at provisioning with 0 turns (reading exactly like
a lead that never started), and a remote ref behind local HEAD silently drops commits from the lead's
checkout. `rotate-lead` completes a cloud rotation itself now, except for a routine-era unit with no
worktree, where it prints the two commands to run.

**Environment selection is per ACCOUNT, so `credProfile` became load-bearing.** `claude --cloud
--environment` accepts only `ccpool_…` self-hosted ids and rejects the `env_…` routine ids: a CLI session
runs the account's server-side default cloud environment, chosen by `CLAUDE_CONFIG_DIR`. A cloud host
entry with no `credProfile` is refused rather than silently riding whatever account the machine last
logged in as; a legacy `environmentId` is inert history.

Also in this release:

- The brief's boot step BINDS to the issue branch (`git fetch origin <b>:refs/remotes/origin/<b> &&
  git checkout -B <b> origin/<b>`) instead of creating it with `checkout -b`. Measured 2026-08-18: the
  session starts at the COMMIT checked out in the orchestrator's worktree (its HEAD was a scratch commit
  that was not on main) but on its OWN `claude/<title-slug>` branch — so the bind is required, and on a
  kickback round it is what loads the prior round's work. Do not read the `claude/…` branch name as "it
  cloned main"; check the sha. The cloud kickback ack instruction points at a WORK-EVENT PR comment — a cloud lead has no ledger access, so the shared `append` form named a command
  that did not exist in its brief.
- `state.transcripts_unverified` excludes cloud lanes by `host_kind`, not by the literal host name
  `"cloud"`: a run whose leads went to the second or third cloud account recorded `host:"cloud2"` and sat
  in that banner for the life of the run — the always-red state the exclusion exists to prevent.
- `--claude-bin` / `hosts.<name>.claudeBin` pins the real CLI when a shim precedes it on PATH.
- **The local-dispatch freeze guard's own tests no longer depend on the developer's machine.** Five
  spawn-accounting tests shelled the real `sysctl vm.swapusage`, so on a box swapping over 85% they
  failed with the guard's refusal instead of testing what they assert — and since `install.sh` gates on a
  green suite, a swapping machine could not install the harness at all. The probe is now stubbed on PATH
  (a fixture, not the weather) and a new control proves the call site still runs it and still honors a
  freeze-zone reading, which is the half `swapVerdict`'s pure test cannot cover.

## [0.7.0] — 2026-08-18

**Cloud leads run the pre-PR codex gate themselves.** 0.6.0 made `codex exec` the gate for every lead
type; cloud leads were the standing exception, because a cloud session had no `codex` binary and the
brief told them to say so at hand-off while the orchestrator supplied the gate leg locally. That
exception is retired for a **codex-provisioned** cloud environment.

### Changed — the cloud brief renders the gate (policy)

- `renderCloudBrief` gains **step 6, the pre-PR codex gate** — the real `codex exec --json --sandbox
  read-only` invocation with model and effort pinned on the command, the re-run-on-new-head rule, and
  the three silent failure modes (`< /dev/null` or it hangs to timeout at ~0% CPU; run it inside the
  repo or it refuses the trusted-directory check; `codex login status` returns an EOF parse error even
  when auth is healthy, so judge by a positive `turn.completed`). Hand-off (now step 8) requires that
  `turn.completed` on the head being handed off.
  **This step did not previously exist in the cloud renderer at all** — the cloud brief went targeted
  verify → self-review → telemetry → hand-off, so a grep for the old "no codex" carve-out found the
  *local* renderer's copy and missed that the cloud path emitted no gate instruction whatsoever. The
  regression test for this is to render a brief and assert on its text, never to grep the source.
- `renderBrief` step 7 and `cloud-lead-brief-template.md` flip the carve-out: codex **is** present on a
  provisioned env (`/opt/node22/bin/codex` 0.147.0, auth materialized at session start by a
  `SessionStart` hook, effort pinned `high`). The old rule survives only for its true case — a
  genuinely empty `command -v codex` on a non-provisioned env, where the lead must still say so at
  hand-off rather than substituting the panel silently.

### Added — the cloud-only classifier trap

- Both cloud briefs now warn that the auto-mode **classifier denies bash that reads or executes
  credential material, and three consecutive denials halt the session waiting on a human**. `codex exec`
  itself is not denied, so the gate must be run directly and never wrapped in a script that touches
  auth. A lead stalled this way is invisible except through the liveness rule.

### Evidence

Measured 2026-08-18 against a codex-provisioned environment: real `turn.completed` from a web session
(`session_01HkfM3t5kg96ppBoRjxJghL`) and from a CLI-dispatched one
(`session_01FWCKuvj9ga9NMbTb2Ude2R`), the latter also proving a synchronous session-id receipt from
`claude --cloud`. Paired repo-side with the ADR-0027 §2 amendment.

### Known-stale after this release

- `SKILL.md` still says the adversarial **panel** is the pre-PR gate ("superseding DER-2375's codex
  gate"), which has contradicted ADR-0027 §2 since its 2026-08-12 amendment. Pre-existing divergence,
  not introduced here; it needs its own pass.

## [0.6.2] — 2026-08-12

### Fixed — a report mixing priced and unpriced models no longer reads as fully priced

Found by the new codex gate reviewing its own enabling change. `estimateCostFromPrices` answers one
number, so a report carrying both a priced and an unpriced model returned non-null and the caller
skipped the unpriced accounting for the WHOLE report. Executed counterexample: 1M `claude-opus-5`
input tokens + 1M `kimi-k3` input tokens reported `cost_is_partial:false, unpriced_tokens:0,
unpriced_models:[]` — the kimi spend vanished, while the config comment promises those models stay
visible. New `priceBreakdown()` reports what it could price AND what it could not;
`estimateCostFromPrices` stays as the number-only wrapper. Same case now: partial=true, 1,000,000
unpriced tokens, `[kimi-k3]`, $5.

## [0.6.1] — 2026-08-12

### Fixed — `run-gate.sh` scratch is no longer a fixed absolute path

`WORK_GATE_SCRATCH` overrides the default `/tmp/rost-gate-pr<N>r<R>`. Two gates on the same pr+round (a
re-run, or a shepherd and an orchestrator racing) shared one directory, and the second `rm -rf` deleted
the first's evidence mid-flight. It also made the script untestable in parallel — which is exactly how
0.6.0's first CI run failed: green in the runner-suite step, red inside the installer smoke, where
several installs run the same suite against that one path.

## [0.6.0] — 2026-08-12

**The pre-PR gate is now `codex exec` alone, and the launcher exists as a file.** Both changes come out
of run `20260810T194109Z` (28 units planned, 5 merged, wound down on the Claude weekly quota wall).

### Changed — the review gate is codex, not a 3-lens Claude panel (BREAKING, policy)

- `codexReviewCommand` pins **`-m gpt-5.6-sol -c model_reasoning_effort="high"`** on the command rather
  than inheriting `~/.codex/config.toml` (whose default is `medium`). A gate that silently reviewed at a
  lower effort would still produce a receipt saying the gate ran.
- `CROSS_VENDOR_ROUND` 1 → 99: codex runs on **every** round, not just the first. It rides a separate
  subscription, so re-running costs no Claude budget — and a verdict on a tree the lead has since
  changed is not a gate.
- The 3-lens panel is now the **FALLBACK**, rendered but explicitly gated on "codex came back
  unavailable". Measured on PR #1293: codex found the round's **only** P1 in 5.4 minutes while three
  Opus lenses spent **$17.25 and 36.5 minutes** and read past it — all three examined the same function
  and reported the same line without reaching the production item shape. 22 findings from 4 reviewers
  deduped to ~10 distinct defects on a `file:line_start` key.
- Briefs now carry a **QUIESCE** section. Four head-moves under a running gate in one night (#1292 ×2,
  #1282 ×2); on #1292 r2 the push landed 102 seconds into a 12-minute $6.11 review, on the file under
  review. The word `quiesce` previously appeared **zero** times in the harness.

### Added — `skills/work/run-gate.sh`, the launcher that did not exist

Every orchestrator hand-wrote one per run, and the same three defects recurred across seven documented
sessions — each written down after each occurrence, each re-introduced by the next copy:

- **Completeness is now non-empty AND parseable** (`test -s` + `jq -e '.result'`), reported as
  `OUTS_NONEMPTY` / `OUTS_PARSEABLE` separately from `PROMPTS`. `> "$out"` creates the file empty before
  the agent runs, so the old `ls | wc -l` reported 3-of-3 against a real roster of 2-of-3.
- **The head is re-read from GitHub before any verdict is accepted**, and a mismatch stamps
  `{"verdict":"stale"}`. The lens's own `git rev-parse HEAD` runs in a detached clone whose `origin` is a
  local path — it cannot observe a push, so it was a check that could not fail. Six stale verdicts.
- **`panel-manifest.json`** records the lenses actually started. A brief asserting three lenses when one
  ran is undetectable from inside a lens.
- Quota-corpse detection (`is_error` + a byte floor — walled lenses returned 833–1377 B against 9–15 KB),
  `MEMGATE … clear|TIMEOUT` printed from the loop's exit condition, per-round scratch at
  `/tmp/rost-gate-pr<N>r<R>/`, and a `REVIEW-TARGET` file per tree (lens trees were pooled across PRs, so
  the tree name lied). `WORK_GATE_MEMGATE_TRIES=0` disables the memory wait, whose default is a
  15-minute silent block per lens.
- It runs codex FIRST and **refuses to spend the panel** unless codex could not deliver.

### Added — the codex false-green refusal is DIRECTIONAL

`codexFalseGreenRefusal` refuses `overall_correctness == "patch is correct"` **only when** the run also
reports a sandbox denial **and** returned zero findings. The naive rule — grep for "could not run" and
discard — is backwards: on #1293 the run whose own explanation says *"Vitest could not collect in the
read-only sandbox … but direct executable counterexamples confirmed the principal failures"* is the run
that carried the only P1. Findings are positive evidence a denial cannot manufacture. Enforced in both
`review-usage` and `review-panel`, and verified through the real CLI in both directions.

### Fixed — a blocker-bearing gate is a round the hard cap can see

`kickback_count` incremented only on a *delivered* `kickback` event. An orchestrator that both GATED and
DISPATCHED produced no such event, so on run 20260810 a PR in its third blocker-bearing round read
**0 rounds** and the 3-round cap never saw it. `rounds_effective` is now
`max(kickback_count, distinct blocker-bearing gate shas)`, with `rounds_uncounted` surfaced so the board
says which axis it counted. Re-gating the same sha is one round; a clean gate is not a round.

### Changed — `prep-for-work` calibration, finally run against actuals

`calibrate` was run against run 20260810's five merged PRs (its own output, not a hand summary):
**additions 2.49× · files 1.70×**, against the stored 4.79× / 1.44×.

- **Files replicate** (1.44×, then 1.70×) → the file multiplier is APPLIED at **1.57**.
- **Additions do not** (4.79×, then 2.49× — a factor of two apart) → stays at 1, per the tool's own
  "two runs disagree, do NOT move the table" verdict.
- Split arithmetic is now driven by the **files** axis — not because files are accurate, but because
  their bias is *stable*, and a stable bias can be divided out while an unstable one cannot.
- 🔴 This **corrects** a claim circulating in the session notes that file counts "transfer exactly". They
  do not (0.86×/2.29×/1.70×/1.00×/2.80×). That claim came from PR #1293 — which never merged and was
  therefore never in the sample.

## [0.5.2] — 2026-08-10

### Fixed

- **`write-brief` refuses a plan-budgeted unit with no `--acceptance`.** Leads cannot read Linear
  (Claude headless leads have no Linear MCP; only the Codex CLI does), yet a brief written without
  `--acceptance` rendered the literal fallback "(see the Linear issue)" — a pointer the lead cannot
  follow, observed as leads reporting "no Linear access" on the 2026-08-09 run. A unit with a
  plan-assigned budget now refuses to brief until the orchestrator inlines the full groomed scope;
  kickback re-briefs stay exempt (their scope is the findings dossier plus the original brief on disk).
- **prep-for-work: plan-review output schema made codex-strict-mode valid.** Codex began enforcing
  strict output schemas server-side (~2026-08-10): `required` must list EVERY key in `properties` at
  every nesting level, or the request 400s (`invalid_json_schema`) before the model runs — under
  `codex exec` that reads as `turn.failed`, killing the mandatory plan-review gate at startup (7/7
  reviews died identically). `PLAN_REVIEW_SCHEMA` now lists all keys as required and expresses
  optionality as nullable types (`evidence`, `size_challenge`).

## [0.5.1] — 2026-08-01

### Fixed

- **DER-3008 (the actual root cause) — preflight was clobbering its own host config.** The two
  watch-prints smoke legs called `runSubcommand([...])` **in-process** with `--repo-root <tempdir>`;
  `runSubcommand` re-runs `applyRepoConfig`, so from that leg onward the module-global host set was
  the temp dir's built-in `{local:{cap:2}}` — which is why a preflight run from the CORRECT repo
  still printed no `:mini` line (0.4.0, silently) and "config did NOT load" (0.5.0, loudly — the
  DER-3008 visibility fix is what exposed this). Both legs now spawn child processes, exactly like
  the kill leg beside them always did; a source pin refuses any in-process `runSubcommand` inside
  the preflight case (mutation-proven).

## [0.5.0] — 2026-08-01

**`codex exec` returns as the DEFAULT gate of the first complete diff; the Claude panel becomes the
backup (DER-3011).** 0.4.0 (below) dropped `codex exec` out of every brief when the panel became the
primary gate. The founder decision of 2026-08-01 puts it back in exactly one slot and re-ranks the two:

| | Round 1 | Revision rounds | Codex probe says unavailable |
|---|---|---|---|
| **Gate** | `codex exec` (default) **+** the 3-lens panel beside it | the panel alone | the panel alone, waiver on the receipt |

The case for that slot rests on three measurements: overlap with the Claude lenses is only **~33%**
(independent, not redundant — which is also what makes the panel a real backup rather than a duplicate),
P1 yield **decays 53% → 24% → 31% → 11% → 0% by round** (so all of its value is in the first pass over a
complete diff), and it rides a **separate subscription pool** — ~8 minutes, no Claude budget, no CI
rounds. The 0.4.0 entry's "no brief renders the codex gate" is superseded: every ROUND-1 brief renders
it, and no revision-round brief does.

### Added

- **`codex-probe`** — "is codex reachable RIGHT NOW", as a command instead of a recipe each role
  re-derived. Runs the **stdin-closed** probe against the resolved binary (never a bare `codex`: a cmux
  shim ahead of it hangs at 0% CPU byte-identically to a quota wall), judges the **text** — never CPU%,
  never `codex login status`, which reports "Logged in using ChatGPT" while every call 401s — exits
  nonzero when unreachable, and prints the ready-to-paste `--codex-waived` line. NO OUTPUT is `unknown`,
  never "down". `--print-bin` resolves the binary for the host that runs it, which is why the brief
  substitutes `$CODEX` instead of a path resolved on whichever machine rendered the brief.
- **`panel-prompt --lens codex`** — the cross-vendor prompt: the union of all three lens mandates plus
  every path-routed checklist, answering in the `codex-review-schema.json` shape. One process against
  three, so splitting the mandate would hand it a third of the review; and the schema constrains fields
  but not what `priority` MEANS, so the prompt supplies the semantics.
- **`review-panel --codex-review <out.json> --codex-log <run.jsonl>` / `--codex-waived "<reason>"`** — the
  round-1 attestation, recorded as `cross_vendor` on the panel receipt and printed by `ready` as
  `xvendor=…`. Codex enters as a **lens of the same gate**, not a second event: its findings join the
  union (so a codex P1 is a panel blocker, and the falsification pass can kill a cross-vendor false
  positive by execution), and one receipt keeps one sha and one blocker count.

### Changed

- **A round-1 `review-panel` receipt must attest the gate, one way or the other.** A receipt silent about
  whether codex ever looked is refused; so is a claim that codex ran with no JSONL carrying
  `turn.completed` (a dead codex run exits 0, so findings alone cannot distinguish "reviewed and found
  nothing" from "never ran"). The waiver is always one flag away and **never blocks** — codex availability
  is bimodal (this harness has watched it die for a day and a half, sit behind a usage wall, and come back
  live, inside one week), so degrading to a RECORDED WAIVER rather than to a stall is the whole design,
  and no shipped copy asserts which way it is pointing on any given day. A revision round inherits round
  1's answer, so `ready` — which reads only the latest gate event — can still report it.
- **The panel block renders its real round number.** It hardcoded `--round 1` on every brief including a
  kickback's; that was cosmetic until "round 1 only" came to depend on it.

### Fixed

- **The attestation is bound to a TREE and a UNIT, not to a filename.** It recorded only `log: <path>`,
  which made it a claim about `/tmp/X.jsonl` — whatever was last written there. One codex run's artifacts
  replayed clean at a different sha AND under a different issue, both printing "CODEX RAN". It now carries
  `covered_sha` and `log_sha256`; re-submitting a digest against another tree or unit records
  `status: "stale"` naming the tree codex really looked at, and `ready` renders stale as NOT covering this
  tree. The findings still enter the union — dropping them would REMOVE blockers, the direction that ships
  a defect; what changes is the claim on the receipt.
  **Review round 1 closed two ways around it, both executed against this code.** (a) `log_sha256` was
  sha256 over the raw JSONL *text*, so the same log plus **one blank line** — or plus any event the
  completion parser skips — hashed differently, matched no prior attestation and was recorded `ran`
  against a tree codex never saw. The identity is now the **canonical run**: the events the gate actually
  consumes, re-serialized with sorted keys, so padding, blank lines, key order and unread events cannot
  move it while two genuinely different runs still separate. The raw digest is kept as `log_sha256_raw`
  (pre-remediation receipts recorded it as their identity and stay findable), and the producer's own
  `thread_id` is recorded as `codex_thread_id` when the stream carries one — deliberately not `run_id`,
  which already means the work run throughout this ledger. It is provenance for a human, never a
  predicate, because `codex exec resume` reuses a thread id. (b) The first-attested **tree and unit are
  immutable properties of the evidence**, carried forward by every later record. They were re-derived
  from whichever record the lookup landed on, and a `stale` record carries its enclosing receipt's issue
  — so a log that ran for DER-A@SHA1, was staled for DER-B@SHA2, was then accepted as `ran` for
  DER-B@SHA1. The event that exists to refuse a replay was the one laundering it.
  **The delta review found the same laundering still open for LEGACY records**, which carry no
  `first_attested_issue` at all and so fell through to the enclosing receipt: legacy RAN(DER-A) + legacy
  STALE(enclosed by DER-B) → replay at DER-B → `ran`. Identity is now taken from the **first `ran`** for
  a digest — never the freshest, since a ledger can already contain a laundered one — and a `stale`
  record's enclosing receipt is never consulted, because it names the unit the evidence was replayed
  INTO. A legacy `ran`'s receipt still is, correctly: there it names the unit that really ran it. When
  neither is available the unit is unknowable and the receipt records `stale` rather than treating an
  absent identity as a matching one.
- **A round-1 pre-PR fix loop now INHERITS instead of forcing a false claim.** The brief told a lead to
  re-run the panel on the new head while hardcoding the codex artifact paths into that same command, so
  re-attesting stale artifacts as RAN was the *default* path. Re-running at a new head with those flags
  dropped now inherits round 1's answer (as STALE once the head has moved), and the brief says exactly
  that: carrying it forward as stale is acceptable, claiming RAN on a tree codex never saw is not.
- **`codex-probe` passes `--json` and treats a nonzero exit as never-healthy.** Without `--json` there is
  no `turn.completed`, so `\bOK\b` alone decided success — over a prompt that literally asks for "OK".
  Five broken shapes read HEALTHY, all exit 1: OK + a 500 stream error, OK + model-not-found, an error
  containing the words "OK button", the 120s SIGKILL path, and plain OK at exit 1 (identical to exit 0).
- **`--round` is validated as an ordinal**, and a revision round with nothing to carry forward is refused
  rather than recorded as `status: "none"`. `1.5` and `0` both defeated the round-1 comparison, and
  recording round 2 first was a one-flag bypass of the whole rule. The refusal never blocks — the waiver
  is one flag away — it turns a silent skip into a recorded choice.
- **`review-swap` no longer synthesizes a substitute reason.** Given none it stamped "codex was
  unavailable as both a bot and a local `codex exec`" — a factual claim nothing measured, propagated onto
  the receipt and rendered as established. It records `null` now, and the label prints "no reason
  recorded", which is the true sentence.
- **The blind-run warning was backwards.** A waived gate printed ⚠ while a `ran` with **zero** repository
  commands printed nothing — yet the blind run is the one that reads as coverage while having reviewed
  only the diff text (DER-2504: a 0-command run returned wholly fabricated findings). Both warn now.
- **Both review parsers coerce a finding's `priority` through one shared helper.** The codex side used a
  bare `Number.isFinite`, so the schema-legal string `"1"` became `null` — a P1 dropped out of the blocker
  count, the under-counting direction. The helper is stricter than a bare `Number()` in the other
  direction too: `Number(null)` is `0`, so the obvious coercion would promote a MISSING priority to P0.
- Shipped prose that no longer described the code: `work-lead/SKILL.md`'s "this is the ONLY review your PR
  gets", `codex-backstop`'s "codex is no longer in any brief", `proxyEnvPairs`' "the ONLY review path", the
  README's dependency table, and `work/SKILL.md`'s claim that `review-usage` refuses on zero
  `command_execution` (it never has — only `turn.completed` is completion provenance; command counts are
  search-coverage evidence, and a healthy read-only client may suppress them).

- **DER-3008 (P0) — the cross-host `content_digest` could never match, and the checks that compare it
  ran on no hosts at all.** Two independent defects, both measured live on 2026-08-01 against a
  known-good deploy. **(1) Scope.** 0.3.0's digest (see its `INSTALL-MANIFEST.json` entry below, which
  described the behaviour accurately for that release) walked `find skills hooks -type f` under `$DEST`
  — i.e. every file in `~/.claude/skills`, a **shared** directory holding 798 unrelated files on this
  MacBook against 4 on the mini. With both hosts at `0.4.0` from `source_commit 0ba513f` and every
  harness-suite file byte-identical, the aggregates were `f18703c0bca0…` vs `a1cc1fae4a5c…`, so
  `harness-digest:<host>` would have printed *"CONTENT DRIFT — SAME VERSION STRING, DIFFERENT CODE"* on a
  correct deploy — and a gate that reds on a correct deploy gets waved past. The file list now comes from
  the **shipped payload** (`$SRC`'s `skills/`, `hooks/`, and `VERSION`) while every hash is still taken at
  `$DEST`, keeping the measure-what-landed property: a shipped file that does not land now **fails the
  install by name** rather than quietly shortening the list. **(2) Silence.** `ssh-hostname:<host>`,
  `skills-sync:<host>`, `harness-digest:<host>` and `claude-probe:<host>` each inlined
  `if (kind === "cloud" || !ssh) continue`, so "no host was checked" printed **zero lines** —
  indistinguishable from four passing checks. A `preflight` run from a work-harness checkout produced no
  `:mini` line at all, because a checkout carries no `.claude/work.config.json` and `getHosts()` fell back
  to the built-in `{local:{cap:2}}` — while `harness-install-current` tells the operator to run preflight
  from exactly that checkout. All four loops now derive from one `crossHostTargets()` classification that
  returns a REASON per skipped host, and two new legs print what used to be inferred from absence:
  `work-config` (which `work.config.json` answered, and whether it parsed) and `cross-host-checks` (which
  hosts are checkable, and why the rest are not). A non-cloud host with no `ssh` alias is now a config
  error rather than a silent skip, and an unreachable host is `UNKNOWN`, never "the host has no manifest".
  **Upgrade:** the manifest carries `manifest_schema: 2` and an explicit `roots` list. A v1 manifest is
  still re-measured with the legacy whole-tree roots, so an un-upgraded host keeps reading its own install
  correctly — but a v1/v2 pair enumerates different file SETS, so the cross-host check reports
  `MANIFEST SCHEMA SKEW` and asks for a re-install of **both** hosts rather than naming a drift that does
  not exist. Because `files` is now the payload rather than a walk of `$DEST`, a file install.sh shipped
  once and no longer ships is no longer silently re-blessed into the manifest: it reads `UNTRACKED` and
  reds `harness-drift`, with the `rm` naming it. That is deliberate — a retired module under
  `skills/work/` is code the runner can still import. Three such leftovers were live on this MacBook when
  the issue was written (`PUBLIC-README.draft.md`, `SCRUB-MANIFEST.md`,
  `TURNOVER-2026-07-15-cloud-run-findings.md`), so the first `preflight` after this deploy reds until they
  are deleted; re-installing does not prune them.
- **DER-3008 (review round 2) — four more silent-success shapes in the same family.** (a) A payload
  filename containing `:` or `"` corrupted the manifest at **exit 0**: `awk -F:` split
  `skills/work/notes:draft.md` into the key `skills/work/notes` with the *value* `draft.md` where a
  sha256 belongs (a clean install then re-measures as permanent drift), and `skills/work/say"hi.md`
  emitted JSON that does not parse (`measureHarnessDrift` returns `absent`). Both reproduced against the
  installer; it now **refuses** such a payload by name — the payload is repo-controlled, and any escaping
  scheme would have to be mirrored byte-for-byte in `aggregateDigest`, which is the two-definitions
  hazard itself. **Review round 1** found the guard enumerated half its own class: `skills/work/say\hi.md`
  passed `[:"]` and then died in `JSON.parse` with "Bad escaped character", and a tab (or any control
  byte) does the same one layer down — both at exit 0, with a manifest written. The rejection now covers
  `\` and every control character, and the refusal renders the offending names through `cat -vt`, because
  a raw tab is invisible in the path an operator is being told to rename. (b) `skills-sync:<host>`
  reported `SKEW … rsync -a …` when the ssh had simply **failed**
  — a confident remedy naming a host that never answered, printed from the same loop iteration in which
  `harness-digest` correctly abstained with `UNREACHABLE … UNKNOWN, not drift`. It now makes the same
  distinction, and a missing LOCAL file is still reported first (the remote's silence cannot excuse a
  broken local install). **Review round 1 found that `harness-digest`'s abstention was itself conditional
  on the failed ssh printing nothing.** `remoteRaw` is buffered stdout, and equality was computed *before*
  the transport check — so an ssh that emitted the manifest and then died returned `{ ok: true }` under
  the green "identical content digest" line, with `unreachable: true` unread in the same object. That
  verdict is what authorises a dispatch to the host. `harnessDigestVerdict` now decides UNREACHABLE first,
  matching the sibling it was described as agreeing with; both halves are pinned by one test on one input.
  (c) `work-config` collapsed *absent* and *unreadable* into `unknown`, which does
  not fail the gate — so a JSON syntax error in the real five-host config degraded silently to
  `{local:{cap:2}}` and printed `PREFLIGHT GREEN` with the mini lane gone. Absent stays UNKNOWN (a
  single-host repo looks identical); a file that exists and does not parse now **REDS**. (d)
  `cross-host-checks` called a repo "genuinely single-host" while a declared-but-unverifiable host was
  flagged in the same run — that host has a cap and can receive dispatch, so the shape is a broken
  multi-host repo, not a single-host one. Four verdicts (`harnessDigestVerdict`, `skillsSyncVerdict`,
  `workConfigVerdict`, `crossHostCoverageVerdict`) are now pure exported functions the preflight case
  calls, because every defect above lived in an inlined expression no unit test could reach.
- **DER-3008 — three "harness version" values were never compared to each other.** A 2026-08-01 deploy
  reading reported "hosts at 0.3.0" while neither host was. `getHarnessVersion()` resolves
  `../../VERSION` **relative to the running file**, so the checkout's runner reports the checkout's
  version — the one about to be installed — in the present tense; it is also process-cached and
  overridden by `WORK_HARNESS_VERSION`. The new `harness-version-agreement` leg compares that reading
  against `$DEST/VERSION` and the manifest's `version`, and says which tree each came from. `VERSION`
  also joined the manifest's file list, so a hand-edited `$DEST/VERSION` now reads as `MODIFIED` instead
  of being the one shipped file nothing attested to.
  **Review round 1: the leg was reading its own input through the override it exists to expose.** With
  `WORK_HARNESS_VERSION`, `$DEST/VERSION` and the manifest all at 0.4.0 and the running *file* at 0.5.0,
  it printed a green "0.4.0 everywhere" — the check that catches a false version claim was making one.
  The running version now comes from `readRunningHarnessVersion()`, which reads the VERSION file beside
  the executing code with no env and no cache, and the comparison is a pure `harnessVersionAgreementVerdict`
  the preflight leg is source-pinned to call. An override can no longer produce a green: **any** active
  override abstains (⚠, naming it and the remedy), because while it is set every version this run
  publishes is the export rather than a measurement — and a disagreement among the three FILES **reds** on
  its own, override or not. In the executed scenario the red comes from 0.5.0 running against a 0.4.0
  install; the override is named in that same detail but never decides the colour.

- **DER-3019 — `preflight`’s codex probe now BINDS to `classifyCodexProbe`.** The preflight leg carried a
  second, drifted copy of the probe classification that tested the success marker FIRST, so a 401 body
  containing "OK" read as GREEN there while the canonical classifier called it unauthenticated. The leg
  now calls the classifier (source-pinned by a binding test carrying the 401+"OK" drift fixture) and
  gained `--sandbox read-only` on its spawn. Two delta-review label nits landed with it: a refused
  `--round abc` echoes the typed value instead of `null`, and an inherited WAIVED renders "no reason
  recorded" exactly like the direct render.

### Known limits (accepted, not defects)

- **A revision-round codex attestation does not record that the shepherd ASKED for it.** `review-panel`
  accepts `--codex-review`/`--codex-log` on any round, so a re-run on round 3 records a normal `ran` with
  no trace of who requested it or why. The policy — panel-only on revisions unless the shepherd explicitly
  asks — is therefore documented but not evidenced. Accepted: the round is on the receipt, so an auditor
  can see that a revision-round run happened and ask who wanted it.

## [0.4.0] — 2026-08-01

**The pre-PR adversarial panel replaces the mandatory Codex review as the harness's primary review
gate (DER-2360).** The operator disabled the GitHub Codex bot's per-PR auto-review on 2026-08-01, so a
PR with zero bot reviews is now the normal case and nothing downstream catches what the local gate
misses. Mining PRs #1074–#1197 is what settled it: 65.4% of commits on bot-reviewed PRs landed *after*
the first bot review, size-matched cohorts merged 1.4–2.7x faster without the bot at near-identical
churn, and head-to-head on #1185 the local panel found 12 of 15 findings while the bot added 2 unique.

### Added

- **`review-panel`** — the acceptance path for a findings-shaped gate with no codex JSONL. It reads each
  lens's raw `claude -p --output-format json` envelope, so it establishes completion per lens rather
  than waiving `review-usage`'s refusal (that refusal is correct and stays: a gate that dies exits 0, so
  bare findings would manufacture 0-finding proof of a clean PR). Writes one `review_findings` event
  with `gate_kind: "panel"` and `models_observed` — the model that ACTUALLY ran, read from `modelUsage`
  rather than from the alias requested (DER-2293). Fails closed on a lens that failed, went silent,
  answered in prose, or was named twice; on fewer than 2 lenses; and on a short `--sha`.
- **`panel-prompt`** — renders one lens's prompt, path-routed to the repo-specific checklists the diff's
  files trigger (tenant isolation, authorization precedence, command-surface parity, prompt/schema
  drift, SQL-vs-Zod divergence, route error handling, docs claims). The prompt is tested code rather
  than prose pasted into a brief that nothing verifies. Refuses an empty diff, which would route no
  checklist at all while rendering a prompt that looks complete.
- **`codex-backstop`** — prints the local `codex exec` second-opinion command for a risk lane or for
  calibrating the panel with `review-fidelity`. It also gives `codexReviewCommand` a production caller
  again now that no brief renders the codex gate; an exported helper whose only caller is its own test
  is a helper that can rot green.
- **`panelModel`** per lead type in `.claude/work.config.json`. Resolution is `panelModel`, else
  `reviewerModel` *only* under `reviewerBilling: "subscription"`, else `opus` — the billing guard is
  load-bearing, because on `kimi`/`gpt` the `reviewerModel` names an in-process proxy model that does
  not exist on the Claude subscription.
- The advisory **PR size target (under 1,000 additions)** is surfaced next to `plan_scope` in every
  brief, including one that already carries an assigned budget.

### Changed

- **Every lead type's brief now renders the 3-lens panel** (`correctness` / `security` / `repro`) as a
  shell-out on a fresh context. A Claude lead's step-5 "adversarial self-review" is gone: it dispatched
  an in-process `opus` subagent, which on a Claude lead resolves to the lead's own tier, so the same
  model graded its own work.
- **`ready` accepts an adversarial receipt as satisfying the review hold when the receipt's reviewed
  sha equals the PR head.** This replaces the `hold (codex not on head)` that can no longer clear on its
  own now that auto-review is off — a condition no action satisfies is a wedge, not a gate. It is
  strictly narrower than the codex waiver: a receipt one commit behind head still holds, with the
  covered sha named so the operator knows what to re-run.
- **Union semantics: majority prioritizes, never erases.** A 1-of-3 finding survives; the blocker class
  is sticky, so a majority cannot downgrade a P1 out of the blocker count; priority dissent is recorded
  on the event. A blocker dies only by positive falsification — evidence checked at record time, not
  trusted — or by a `gate_adjudication`.
- **Round cap 3 with escalation.** Unresolved blocker-class findings after round 3 stop and re-scope the
  PR; only non-blocking residue becomes review-debt.
- Shepherd guidance rewritten for auto-review being off: the reaction watchdog applies only to a review
  the shepherd explicitly requested (absence of a 👀 is now the expected state, not a missed pickup),
  `@codex review` is the on-demand backstop for risk lanes and calibration, and the rollback condition
  is recorded — if the panel misses a blocker the bot catches, `@codex review` becomes mandatory on risk
  lanes until the panel is fixed.

### Removed

- The two brief gate headings this supersedes: "⚑ Mandatory Codex review (pre-PR gate — every lead
  type)" (DER-2375) and "⚑ Mandatory external adversarial review (pre-hand-off gate)". The second is
  retired rather than kept alongside the panel: both are Claude-Opus-on-the-subscription shell-outs, so
  rendering both would have told a `dsv4` lead to run a fourth Opus review after the three lenses.

## [0.3.0] — 2026-07-31

The harness-upgrade wave from run `20260730T233426Z-der-2869-der-2864` (23 PRs, 20h08m, 3.84B tokens),
implementing `docs/plans/2026-07-31-harness-upgrades.md`. Per-item status, including the findings that
did **not** survive re-verification, is in `docs/state/2026-07-31-harness-upgrade-status.md`.

**Why this version exists at all** is the wave's headline finding. Measured on two hosts on 2026-07-31:
seven shipped files differed — `work-runner.mjs` alone by 37,762 bytes — while **both sides reported
`VERSION` 0.2.0**, because the version was never bumped across ~12 commits and `~/.claude/skills` is not
a git repo. The 0.2.0 skew machinery compares version *strings*, so it did not merely fail to see this;
it reported the two divergent hosts as **agreeing**. Version equality was a claim, never a measurement.

### Added

- **`INSTALL-MANIFEST.json` (P0.3).** `install.sh` now records `{version, installed_at, source_commit,
  content_digest, files{path: sha256}}`, hashing the tree it actually **wrote** (walking `$DEST`, not
  `$SRC`, so a `cp` that dropped a file cannot still produce a matching manifest). Runtime state under
  `tmp/` is excluded — a drift check that reds the moment anything runs is one nobody reads.
- **`preflight` check `harness-drift`.** Re-measures the installed tree against its manifest and prints
  **`HARNESS DRIFT`** naming every modified / missing / untracked file. An install with **no** manifest
  reports `absent`, not clean: an install that cannot attest to what it is running is not a clean one.
- **`preflight` check `harness-digest:<host>`.** Compares whole-tree `content_digest` across hosts, where
  the existing `skills-sync` leg compares only two files — which is how a seven-file drift hid behind a
  green check. When the digests differ but the versions match, it says so in those words.
- **CI job `skills/** requires a VERSION bump`.** A PR touching `skills/**` must bump `VERSION` or carry
  a `no-version-bump:` trailer, so opting out is a recorded, greppable decision rather than an omission.
  Control-tested against real history: it produces the failing answer on `f4ef1b3..658d97e`, a merged PR
  that changed shipped code under an unchanged version.

### Added — posture C, the substitute review gate (Phase 1)

There are **three** review postures, not two: normal, cloud-down, and **both-down**. Posture C ran for
~16h of the source run — the Codex bot died 3h47m in, and `codex exec` hit a quota wall the same night —
with **zero** harness support, so shepherd #4 hand-rolled it and shepherd #5 inherited it as
undocumented tribal knowledge.

- **`review-swap`** records a substitute adversarial review as ONE `review_findings` event carrying
  first-class `engine`, `model`, `lenses[]`, `lenses_requested[]`, `verdict_per_lens`, `substitute` and
  `substitute_reason`. It **fails closed exactly like the codex gate does** — refusing fewer than 2
  lenses, any missing or empty lens verdict, or a `--sha` that is not 40 chars. **A silent lens is
  `INCOMPLETE`, never `clean`**, and recording `lenses_requested` alongside `lenses_returned` means a
  1-of-3 panel is *visible as* 1-of-3 and can never render as a full swap.
- **`waive-codex-gate --run <r> --reason <text> --until <iso8601>`** ends the `hold (codex not on head)`
  that can never clear while codex is dead. Appends `codex_gate_waived` → `state.codex_waiver`, surfaced
  on **every** `watch` wake. `--until` is required, so a waiver expires by construction; an unparseable
  `--until` reads as **expired**, never as forever. Previously this waiver existed only as ledger prose,
  so every `ready` call needed a human to remember it and a successor orchestrator had to be *told*.
- **The waiver does not waive evidence.** With one active, `ready` still refuses any PR with no
  `review_findings` covering its head. It converts *"must be codex"* into *"must be **some** recorded
  adversarial review"*, never into *"no review"*. Pinned by a test asserting all three cases.
- **`state.issues[].gate` is a structured object (1.4)**, replacing the `gate_seen` boolean and its four
  flat siblings. A boolean cannot express "gated by a substitute", and misattributing one is not
  hypothetical — the #1183 3-lens gate was shepherd #4's work and was credited to #5 in a run report and
  a learnings entry before it was caught. `ready` now prints
  `gate=SUBSTITUTE (claude/opus-5, 3 lenses: correctness/security/repro, sha …)`.
- **The posture-C procedure is written into `work-shepherd/SKILL.md`** — the codex-down probe (and why
  CPU% is not a discriminator), three *distinct* refute lenses, refute-by-default, diff-scoping, the
  verdict-first contract, mutation proofs with paired controls, and `review-swap`. Distinct-not-redundant
  is the load-bearing part: on #1183 the **repro lens refuted the security lens and was right**; three
  redundant reviewers would have concurred and deleted live code.
- **A gate sha must be 40 chars (2.4)**, enforced at write time. Measured on #1180: 9- and 10-char forms
  both read `stale-clean`, only 40 reads `CURRENT`. Required outright by `review-swap`; format-checked
  by `review-usage`, which still legitimately produces an unstamped gate on a bare checkout.

### Fixed

- **`watch` can no longer die in silence (2.2).** A SIGTERM/SIGINT/SIGHUP now writes a terminal
  `{"wake":"killed", signal, cursor, elapsed_s}` record synchronously before exiting `128+N`. The
  pattern `work/SKILL.md` §4 itself recommended — background `watch` + `caffeinate -w <pid>` — **killed
  shepherd #5's watcher twice**, exiting after ~100s printing nothing, which is indistinguishable from a
  quiet wake. That guidance is **removed**, in both `work/SKILL.md` and `work-shepherd/SKILL.md`, in
  favour of foreground bounded `watch`. `preflight` now runs the three controls that proved it:
  `watch-prints:event` (`--since 0`), `watch-prints:timeout` (`--timeout 1`), and `watch-prints:killed`
  (a real SIGTERM against a real child process).
- **Never invoke a bare `codex` (2.1).** `resolveCodexBin()` honours `WORK_CODEX_BIN`, walks `PATH`
  skipping any `cmux-cli-shims` directory, and falls back to `~/bin/codex` only if it exists. A cmux shim
  resolving ahead of the real binary cost two agents ~40 minutes and a wrong root cause, because its hang
  is byte-identical to a quota wall.
- **`preflight` checks are tri-state.** `ok` is now `true` / `false` / `"unknown"`. An empty codex probe
  is `⚠️ UNKNOWN` with a re-run instruction — evidence of no evidence, never a verdict — and the marker
  line reports `PREFLIGHT GREEN — n UNMEASURED: …` so it cannot read as a silent pass either. A wall that
  *says* it is a wall still reds; the discriminator (**a real hang burns CPU; ~0% CPU with ~0 bytes is a
  wall, not work**) ships in the probe's own text.
- **`preflight` check `harness-install-current`.** Compares the manifest's `source_commit` against the
  surrounding checkout's HEAD. This is the half that actually bit: the 2026-07-31 drift was
  stale-but-**untampered**, so per-file digests report CLEAN — correctly — while the install lags by ~12
  commits. Reports `unknown` when no checkout is in reach, never "current".

### Fixed — run lifecycle and coordination (Phases 3–4)

- **The `complete-run` / `reap` deadlock (4.3).** `complete-run` counted never-dispatched `state.queue`
  ids as non-terminal and prescribed `reap <id>`; `reap` refused exactly those, because `state.issues`
  entries are only created when an event *names* the id — so the `!unit` branch returned before
  `--abandon` was consulted, and there is deliberately no `--force`. **A non-empty queue at run end was
  an unconditional deadlock**, with the harness prescribing the one command that refuses. `reap` now
  accepts a `state.queue` id, tears nothing down, and appends `reaped` with `never_started: true` — the
  plan's preferred fix. A typo'd id is still refused, so the phantom-terminal-event guard is intact.
- **A retraction shape for an append-only ledger (4.4).** `state.reap_failures` listed DER-2868 forever
  after both leaks were verified resolved. `reap_failure_retracted` references the original `event_id`
  **with evidence** and renders the entry `RETRACTED`: the original stays (append-only intact), the
  banner stops lying. Both fields are required — this is the one shape that can clear a safety banner.
- **`failed` vs `unverifiable` in reap's surfaced guidance (4.5).** The probe already drew the
  distinction in `reason`; the always-shown `act` text said *"still ALIVE and burning tokens"* either
  way. DER-2868's leak was: no process ever existed and ssh was down. "Go kill something" and "go find
  out whether there is anything to kill" are different instructions.
- **`rotate-shepherd` (4.1).** Leads had `rotate-lead`; the shepherd had nothing, and `spawn-shepherd`
  has no handoff step — so a successor re-derived state and **silently lost in-flight reasoning**. At the
  19:48Z rotation shepherd #4 lost partially-written #1183 gate-swap findings and an unrecorded
  review-debt fold decision. Checkpoints notes → renders `briefs/shepherd.rot<n>.md` → spawns (keeping
  the unproven-spawn refusal) → **verifies** the event landed. With no checkpoint it says so loudly:
  *treat every in-flight belief as LOST*, because an empty section reads as "nothing was in flight".
- **Actor instance ids (4.2).** Events carried a role, so every shepherd in a run collapsed into one
  bucket. `shepherd#4` is now stamped and `usage` folds `by_instance`. A role-only actor parses to
  instance `null` — never `#1`, since crediting an unidentifiable shepherd to the first one is exactly
  the misattribution that put #1183 in a run report and a learnings entry under the wrong name.
- **`cmux-say` refuses an actionable message with no `--ledger-ref` (3.1).** `cmux send` lands in a
  session's *input queue*; a mid-turn session reads it only when the turn ends, and a ruling once sat
  ~4 minutes. **DELIVERED ≠ READ.** The pane text becomes "read ledger `<id>`", recipients append
  `msg_ack {ref}`, and `state.unacked_messages` surfaces anything unacked on every wake — generalising
  the kickback relay's proven ~10-minute rule. `--fyi` is a deliberate, explicit escape.
- **Recent per-issue notes in the wake payload (3.2).** Shepherd #4's 19:06:03Z memo and the
  orchestrator's 19:12Z ruling crossed in flight and independently re-derived the identical #1185 re-pin
  recipe — correct outcome, wasted effort, and it could as easily have produced two *different* recipes.
- **A verdict-first contract on every dispatched subagent (3.3),** terminating in `COMPLETE` /
  `INCOMPLETE` / `REFUSED` — never silence. **And a correction to standing guidance:** SILENT is not
  WEDGED. Two of three reviewers went silent twice, then delivered in full on an explicit *"findings or
  INCOMPLETE"* ultimatum, having burned 136k and 158k tokens. Re-pinging did nothing. Send the ultimatum
  to a silent agent; reserve respawn for a provably wedged one.
- **`staleness-check` (2.7).** DER-2594 sat `Todo` ~21h having been fixed weeks earlier — and its parked
  branch was *behind* main, so merging it would have removed a `credentials` join and reopened the drift
  it was filed to close. The naive check is blind too: DER-2814 matched `preflight` **8×**, every hit an
  unrelated body-size budget, so `grep -c` read ALREADY DONE. Uses `git log -S` and prints **where a
  symbol landed** — commit, subject, date — never a count, and never asserts "already done".
- **Token totals declare their floors (5.3).** `usage` already flagged unpriced *cost*; it now flags
  structural gaps that move the *token* total — reports refused at ingestion (the `trustedCommentAuthors`
  deny-list silently dropped cloud reports before ~18:15Z) and undrained hosts — as
  `TOTAL (FLOOR — n report source(s) known missing)`.

### Notes

- The plan prescribed hardcoding `~/bin/codex` for 2.1. Re-verification found that path **does not exist
  on this host**, where `codex` on `PATH` is the real `@openai/codex` CLI and the cmux shims present never
  invoke `timeout` at all. Implementing it literally would have broken every codex call here. The durable
  rule (resolve explicitly, never trust a shim, never render silence as a verdict) is kept; the brittle
  path is not. The plan's companion audit — *no bare `timeout` anywhere* — came back **clean**, and now
  ships as a standing test rather than a one-time grep.
- `aggregateDigest()` in `work-runner.mjs` and `CONTENT_DIGEST` in `install.sh` are two implementations
  of one wire definition (`path:sha256` lines, sorted, newline-joined, no trailing newline). The suite
  pins their agreement by recomputing one from a real manifest's own `files` map — if they drift apart,
  every cross-host comparison reports drift between two byte-identical installs.
- The drift walk **enumerates the tree** rather than re-hashing only the paths the manifest lists. The
  first implementation did the latter and its own acceptance control caught the flaw: it reported
  `untracked: []` for a rogue file, because a file absent from the manifest is exactly the file such a
  loop never visits. Same defect class as everything else in this wave — a check that could not produce
  the failing answer.

## [Unreleased]

The 2026-07-30 cold-eyes remediation wave: nine fixes against the 21 findings of a cold-eyes review of
`2c3ecbe`, closing the gaps 0.2.0 shipped with, plus this entry itself (DER-2780), which corrects four
places this file and its neighbors described those gaps as still open after they were closed.

**A SECOND cold-eyes review, of `fbb8631`, ran the same day and its fixes land in this same section** —
DER-2836 (P0), DER-2837, DER-2838, DER-2839, DER-2841/DER-2810/DER-2808, and DER-2840 so far. They are
listed below alongside the first wave's,
which is why the entry count under `### Security` exceeds the nine named above. Recording it because the
paragraph above was written when this section held one wave, and a reader counting entries against it
would otherwise conclude the file had drifted.

### Security

- **DER-2840 (P1) — a same-owner FORK is not the same REPOSITORY, and owner equality let one through the
  identity gate.** DER-2778 (below) required a PR's `headRepositoryOwner.login` to equal the target repo's
  owner segment, and its changelog entry and the shipped `SKILL.md` both stated that a fork never satisfies
  it. GitHub lets **one owner hold both a repository and a fork of it**, so owner equality is strictly
  weaker than repository identity: a same-org fork passed the gate and could drive cloud lifecycle
  derivation against a tracked unit — the half of DER-2778 that closing the untrusted-AUTHOR side did not
  reach. `prIdentityTrusted` now additionally requires `isCrossRepository === false`, spelled strictly:
  a missing field is `undefined` and a stubbed one may be the string `"false"`, and **both must deny**
  (`!pr?.isCrossRepository` would have accepted both and reinstated the defect). Both call sites that
  project the identity field-by-field were updated — that projection is the silent-loss shape, where an
  identity field not named is dropped before the predicate sees it, and a dropped `isCrossRepository`
  denies *every* PR, disabling the cloud lane rather than reopening the hole. The `pr list` call now
  requests the field, asserted by a test, so the gate cannot decide on a field it never asked for.
  GraphQL cost was re-measured rather than inherited: against a zero-noise control (two `gh api
  rate_limit` reads with no call between them ⇒ delta 0), the field set costs 1 point at the 100×100
  ceiling both without and with `isCrossRepository` — free. Evidence: the fork case is RED on
  `origin/main` at the predicate, at the production fold, and end to end through a real
  `reconcile-pr-events` subprocess; a mutation audit neutering the new return to `true` turns **all three**
  of those cases red — two in `work-runner.test.mjs` (457 tests, 2 fail) and one in `e2e.test.mjs` (47
  tests, 1 fail) — and leaves every control green, so the gate is load-bearing. *(An earlier draft of this
  entry said "exactly the two defect cases", which is wrong and contradicted the three levels enumerated
  in the same sentence. The count is stated here as measured, with its denominators, because a maintainer
  re-running the audit gets three and would otherwise have to work out what broke.)*
- **DER-2839 (P1) — a remote read that FAILED was reported as a remote that was EMPTY, and that erased a
  completion-blocking damage signal.** The remote ledger tail ran as
  `tail -n +N <path> 2>/dev/null || true`. That suffix answers every question with success: a MISSING
  remote ledger, an UNREADABLE one, and a failed read all exited 0 with empty stdout — byte-for-byte what
  a healthy remote with nothing new returns. `pullHostInto` then took the empty-body path and called
  `recordHeldFragment(…, {fragment: null})`, whose documented contract is "nothing is held any more:
  DELETE the record". So a read that never happened destroyed the held-fragment record — the exact
  inversion DER-2776 was written to prevent, arriving through the shell instead of the parser. The
  existing `exitCode !== 0` guard could not help: `|| true` had already guaranteed exit 0.
  **The construction appeared TWICE, and the review named only one of them** — the executing path, and
  the `pull-host --dry-run` preview that printed a separately-written copy of the same string. Both now
  come from one builder (`remoteLedgerTailCommand`), so the preview cannot drift from what runs, and
  neither suppresses stderr nor masks the exit status: `tail`'s status propagates through ssh, and the
  remote's stderr survives as `pull_error` to say WHY. On failure the pull preserves the cursor **and**
  the hold, and READS THE HOLD BACK to report it — returning `held: null` there would have laundered "I
  did not look" into "nothing is held" one layer above the shell defect itself.
  Regressions in `e2e.test.mjs` drive a real `pull-host` subprocess against a real `ssh` stub with a real
  `tail`. Observed RED on the parent (`116bc69`) for a missing remote ledger, for an unreadable one, and
  for the stale dry-run preview; the empty-but-successful control passed on the parent and still passes,
  which is what stops the fix from being "call every pull a failure" — a change that would wedge the mini
  lane while looking like a security improvement.
  **Five findings from the Codex review of this change were fixed on the branch**, four of which are the
  same defect class the change is about, reappearing at layers the fix had not yet reached — recorded
  because "I fixed the laundering" was only true of the shell:
  (1) *P1* — `watch --pull-hosts` is the pull's only UNATTENDED consumer and it `await`ed the result and
  threw it away, so a mini whose ledger is permanently unreadable stopped ingesting events indefinitely
  while the operator saw routine watch output. Failures now latch per host, clear on the next successful
  pull, and re-surface on every wake as `pending.pull_failed` (host + the remote's own reason) — the same
  treatment as `spawn_failures`. Reported, never fatal: the pre-start window before a host first writes
  its ledger is a legitimate failure and making it fatal would wedge the lane on a routine race.
  (2) The new single-host hold reader returned `null` for a hold that EXISTS but is unreadable — the
  identical "I did not look" → "there is nothing there" collapse, one layer above the shell, and in
  direct disagreement with its own sibling `readHeldFragments`, whose header already states the family
  rule ("a hold we cannot age is one we cannot vouch for, so it counts as stale rather than silently
  disappearing"). It now distinguishes ENOENT (no hold) from unreadable/malformed (`unreadable: true`,
  `stale: true`).
  (3) The failure tests asserted the on-disk state but not the RESPONSE CONTRACT, so an implementation
  that kept the hold on disk while reporting `held: null` with no reason passed them — the two behaviors
  this entry claims. Both are now pinned, including that `pull_error` describes the actual failure.
  (4) The dry-run test asserted only that the preview LACKED `|| true`, which stays green if production
  drifts to a different path or cursor — the whole failure mode a preview has. It now captures what the
  ssh stub was actually handed and compares. (Writing it surfaced a real ordering constraint: a
  successful pull advances the cursor, so preview and execution are only comparable at the same cursor.)
  (5) *Pre-existing on `main`, closed here because the new builder is now the only site that constructs
  the path*: the remote path was unquoted, so a valid `ledgerRoot: "/Volumes/Work Ledger"` split into two
  operands and failed every pull, and a metacharacter in `ledgerRoot` or the run id was interpreted by
  the remote shell.
  **A second review round found five more, all in the remediation itself** — recorded because the pattern
  is the point: each round of "I fixed the laundering" was true only of the layer it looked at.
  (a) Quoting the whole remote path also disabled `~`/`$HOME` expansion, so a `ledgerRoot: "~/work-ledger"`
  would have failed every pull; a leading `~/` is now left outside the quotes while the rest stays quoted.
  No config here uses one — the point is that the tightening must not silently break one that does.
  (b) `--pull-hosts auto` selects every ENABLED host, not every host the run USES, so an enabled `mini`
  that was never dispatched to reported a failed read on **every wake, forever** — a permanent banner on a
  healthy run, which is how a new signal destroys itself. It is now raised only on positive evidence that
  a readable ledger should exist (a cursor past 0, a held fragment, or a `lead_spawned` on that host). A
  throw is still reported unconditionally — that is a harness fault, not the not-started race.
  *The bound this gate actually has, stated precisely rather than as "monotonic":* `lead_spawned` is an
  append-only ledger event, so once a run has dispatched to a host the evidence is permanent, and every
  production dispatch (`spawn-lead --host <h>`) writes one. The other two witnesses are weaker — a hold is
  deleted when its line completes, and a cursor reads 0 again if the file is removed — so a hand-built run
  state with no host-tagged `lead_spawned`, a zeroed cursor, and no hold would suppress a real failure.
  Production cannot reach that state; a manually reset run dir can.
  (c) The hold reader checked that the record PARSED, but `{}` parses: it reported as a hold in good
  standing with a null age. The bar is now the one `readHeldFragments` already sets for the family — a
  record it cannot DATE is stale.
  (d) The "the reason must describe the ACTUAL failure" assertion listed `exit \d+` among its accepted
  matches — the generic no-stderr fallback, i.e. it accepted the exact placeholder its own message
  forbade, and would have stayed green if `2>/dev/null` came back. It now rejects that form explicitly.
  (e) `skills/work/SKILL.md` carries the list of the `pending` block's keys, read by the unattended agent
  consumer, and adding `pull_failed` to the payload without adding it there left the one reader that acts
  on it unaware the signal exists. A third round then caught that the same list had been missing
  `gate_missing`, `gate_blocked` and `gate_adjudicated` since before this change; all sixteen keys the
  payload emits are now documented, checked by enumerating them from the source rather than by eye.
  **A third round also caught a performance regression introduced by (b)**: the evidence gate called
  `readEvents` — a whole-ledger parse — on every ~45s side-effect cycle, against DER-2741 (#16)'s explicit
  invariant that work per poll scales with new activity, not total history. On that benchmark's
  100k-event / 9.8 MB ledger a single idle 240s watch would have added ~6 full parses. The existing
  idle-watch perf test did not catch it because it runs without `--pull-hosts`, so the block never
  executes there. The set is now seeded lazily (at most once per watch process, and only on the failure
  path — a healthy run never reads the ledger here) and kept current from the bytes the tail has already
  parsed.
  **Repo-wide sweep** (the acceptance criterion): two `|| true` sites remain in command construction and
  both were verified fail-closed against their masked paths rather than reasoned about. `install.sh:41`
  masks a *display* grep of the suite summary — load-bearing under the file's `set -euo pipefail`, and
  the actual gate is the `node --test` exit status captured on the line above, so it cannot pass a red
  suite. `.github/workflows/ci.yml:157` masks `grep -c` counting matched security tests: replaying the
  exact construction, zero matches yields `0` and a grep error yields `""`, and `[ "${ran:-0}" -lt 1 ]`
  fails the job on both — against a control with a real match, which passes. Every other hit in the repo
  is prose describing the banned construction, not the construction.
- **DER-2841 / DER-2810 / DER-2808 (P1) — three ways for an evidence query to be stamped `ok` while
  having measured nothing.** DER-2783 established the rule all three defeat: a run that did not exit 0 is
  a FAILED run, not a count. They are bundled because they collide on the same three functions
  (`parseEvidenceQuery`, `queryCountsNumerically`, `evaluateQueryOutput`) and the same `stages` array.
  - **DER-2841 — a multi-file `grep -c` count inflated to the number of files SEARCHED.** `grep -c`/`rg -c`
    over multiple files print `path:count` ROWS, not a scalar. Numeric mode correctly declined the
    non-scalar, and the LINE-COUNTING FALLBACK behind it was the defect: it counted the rows, so a file
    matching **zero** times counted as a match. Measured on the parent, with the fixture the review names:
    `grep -c 'x' a.txt b.txt c.txt` where only `a.txt` matches once prints `a.txt:1 / b.txt:0 / c.txt:0`,
    exits **0**, and was stamped **`3 ≥ 3`** — one match certified as three. The inflation is exactly the
    number of files searched, so a wider search produces a more convincing fabricated count.
    A counting pipeline whose stdout is not a single number is now **refused with the reason**, rather
    than line-counted. Refusing is chosen over summing the rows deliberately: a summed number is only
    correct if every row parsed, whereas a refusal tells the author to narrow the query. `evaluateQueryRun`
    previously hardcoded `failed: false` over the evaluator's verdict, which would have discarded the new
    refusal at birth — it now carries it out.
    *A carve-out was tried here and REVERTED, which is worth recording because the reversal is the
    finding.* Refusing every non-scalar also refused a prefixed SINGLE-file count — `grep -Hc PAT one.txt`
    prints `one.txt:2`, `wc -l one.txt` prints `2 one.txt` — where the parent line-counted the row to 1.
    So a carve-out read one such row as its number. Adversarial probing showed that carve-out **fails
    open**, which is strictly worse than the under-count it softened: `/^(.*):(\d+)$/` is greedy and has
    no notion of "count", so it matches ANY line ending in `:digits`. Measured on the branch before the
    reversal — `wc -l 'notes:2026'` prints `3 notes:2026` and was read as **2026**, PASSING a floor of
    2000 against a true count of 3; `grep -e -c file` (where `-e -c` is a documented false positive of
    `queryCountsNumerically`, so numeric mode is on for a command emitting matched LINES) read **34** out
    of the timestamp in `run -c at 12:34` and passed a floor of 30. The parent was wrong on both — it
    answered 1 — but wrong and FAIL-CLOSED. Trading a fail-closed wrong answer for a fail-open fabricated
    one is the exact inversion this bundle exists to close, so the carve-out is gone: a non-scalar is
    refused, and the remedy moved into the message, which now names the spelling that works per command
    (`wc -l < FILE`; drop `-H` and name one file; or drop the counting flag and count matching lines).
    Nothing correct was lost — the parent's answers for those shapes were also wrong. A softer rule may
    return only with a way to PROVE the number is a count (binding the row's path to one of the query's
    own file operands, selecting the pattern by command family), not by matching text that looks like one.
    *At least one file must match for this to be reachable end to end*: with no matches anywhere `grep -c`
    exits 1 and DER-2783's gate refuses the query before its output is read. An all-zero fixture is
    therefore refused identically on the parent and proves nothing — the first draft of both regressions
    used one, and passed on the parent for a reason that had nothing to do with this defect.
  - **DER-2810 — a trailing stage that can only destroy the signal the gate reads.** *Measured rather than
    taken from the issue, which predicts all three suffixes are stamped `ok 1 ≥ 1`. Only one is.* With
    `… | cat`, grep's `0` is piped through, so stdout is the line `0`, the counting command is no longer
    last, numeric mode is off, and one line clears a floor of 1 — on the parent this exact query exits 0
    and prints `ok 1 ≥ 1`, a real false pass. With `… || true` / `… ; true` the trailing `true` is joined
    by `||`/`;` rather than a pipe, so **its** stdout — empty — is what gets evaluated: count 0, floor 1,
    already refused on the parent (`returned 0 < 1`). They mask DER-2783's exit-status signal but did not
    buy a pass in this executor. All three are refused regardless, because masking the signal is the thing
    being closed and `|| true` is one keystroke from a form that does pass (`|| echo 1`) — but only the
    `| cat` case is evidence of a closed false pass, and the regressions say so per case. Refused at the
    validator by
    exact trailing command name — not by a heuristic over the raw string, which is what made this
    unfixable inside DER-2783's scope. The deliberate scope decision the issue asked for: only `true`,
    `:`, `cat` and `tee` are refused as trailing stages, because none can ADD information to an evidence
    query and all can subtract it. A trailing `head`/`sort`/`awk` still falls back to line counting —
    those genuinely transform the output, and refusing them would break working queries.
  - **DER-2808 — a query beginning with a bare separator lost its leading segment silently.** `| wc -l`
    parsed to ONE stage with no problem raised, so `stages[0]` was a stage that was never the query's
    first command. Harmless only by luck (such a query is a shell syntax error, so it produces no output
    and fails on the count), but a blind spot in the PARSE rather than in the verdict, which any future
    consumer of `stages[0]` inherits. Now refused with the operator named. The contract comment above
    `queryCountsNumerically` documented this case as a deliberate residual and is amended in the same
    diff — it would otherwise describe behavior its own file no longer has.
  **Follow-up in the same wave:** `skills/prep-for-work/SKILL.md` — the SHIPPED guidance an author reads —
  still carried both retracted claims after the code changed under it: it recommended "end it in
  `| wc -l`" (removed from the refusal message because it counts FILES, and over one file answers 1 for
  any pattern) and stated that "a single `path:count` row is still counted" (the carve-out that was
  reverted for failing open). Both were written when those behaviours were true and neither was updated
  when they stopped being. Caught by grepping for copy that depended on the old behaviour AFTER the
  reversal merged, which is the only step that finds this class — the diff that made the prose false does
  not touch the file the prose is in.
  **Left open deliberately, and PINNED live: DER-2900.** `grep -c PATTERN file | wc -l` is stamped
  `ok 1 ≥ 1` for ANY pattern — `grep -c` prints one line whatever the count, `wc -l` counts that one
  line, and numeric mode reads the 1. `| head -1` and `| sort` do the same. All exit 0, so DER-2783's
  gate does not fire. The obvious rule — refuse a counting command that is not the last stage — also
  refuses `rg -c PATTERN . | wc -l`, which legitimately answers "how many files contain PATTERN", and
  telling those apart needs to know how many files the command searches, which the query text does not
  say. A heuristic guess there is what DER-2810 was filed for, so this bundle fixed only the provable
  half — **the refusal message used to RECOMMEND `| wc -l` after a counting command**, and now says to
  drop the `-c` and count matching lines instead (verified: with 2 matches in `a.txt` and 1 in `b.txt`,
  `grep -c … | wc -l` answers 2, the FILE count, while `grep … | wc -l` answers 3, the real one). The
  residual is a live pin in `e2e.test.mjs`, to be INVERTED when DER-2900 lands.
  Also corrected here: `e2e.test.mjs`'s header claimed **four** proven-live defect pins and listed
  DER-2810 among them, but only three pins exist and DER-2810 never had one — the count was one more than
  the file could back, with the sentence "the pins below" doing the vouching. That is this suite's own
  rule turned on itself, so it is fixed rather than footnoted.
- **DER-2837 (P1) — an UNDER-counted `blockers` field authorized a merge.** `gateEvidenceVerdict` read
  the `review_findings` event's `blockers` number and never asked whether it described that event's own
  `findings` list. The one consistency check that existed — in `gateAdjudicationVerdict` — compared
  `recorded > actual`, so it caught an over-count and let an under-count through. Measured at `c477ee9`:
  `{blockers: 0, findings: [{priority: 1}]}` on the head returned `{"blocks":false,"state":"current"}`
  (MERGEABLE), against the control `{blockers: 1, …}` returning `{"blocks":true,"state":"current-dirty"}`.
  A gate event carrying a live P1 while recording zero blockers was therefore indistinguishable from a
  clean gate — and, because `stale-clean` and `unstamped` also pass on a zero count, it read as a pass on
  three separate branches, not one. DER-2782 had made a recorded blocker *block*; nothing had made the
  record *true*.
  **The count must now EXACTLY equal the number of priority-≤1 entries in the same event's findings
  list**, via one shared predicate (`gateBlockerCountVerdict`) applied at every boundary: derived from
  those findings at the producer (`reviewFindingsEvent`), refused at the write boundary (`append`, the
  second event type it validates), and re-checked at all three reads — the merge verdict (new blocking
  state `gate=INCONSISTENT`, evaluated ahead of every sha branch), the `materializeState` fold (the unit
  now reaches `state.gate_blocked` as `blockers: "INCONSISTENT"` with its own instruction, where before
  the board agreed with the lie), and the waiver contract, whose `>` became `!==` so a waiver can no
  longer cover findings the count denies. **Both directions block**, because a one-directional check is
  exactly the shape that let the harmful direction through; an over-count merely holds work that should
  ship, while an under-count ships an open blocker and looks clean. A count that is not a number — now
  including the *string* `"0"` — remains the distinct `gate=UNREADABLE`, since "not a count" and
  "contradicts your own findings" oblige different actions. Legacy events with no findings list and a
  zero count still read clean: there is nothing to contradict, and blocking them would strand every
  pre-`findings` ledger. Verified by fault injection in `e2e.test.mjs` (the write boundary refuses the
  lying event; a forged *relayed* line that bypasses `append` is still refused by the read side) with
  controls proving an honest dirty gate, an honest clean gate and a valid adjudication all still behave
  as before. **This is consistency, not authentication** — see `SECURITY.md`; anything that can write the
  run directory can still write a self-consistent event, and `adjudicated_by` remains an unauthenticated
  string by recorded decision.

- **DER-2838 (P1) — a run's terminal state could be FORGED, and the completion gate never looked at the
  build about to write it.** Two halves of one path. **(a)** The fold accepted the first `run_completed`
  it saw, and the generic `append` relay reserved only `gate_adjudication` — so anyone who could write
  the ledger (an agent with `append`, or a text editor) could mark an **active or empty** run completed
  and every one of DER-2781's seven checks was moot, with `state.status` reading `"completed"` to every
  later consumer. Fixed on **both** sides, because a write-time check alone is defeated by appending to
  `events.jsonl` directly: `append` now refuses the type outright, and the fold honors a marker only if
  it carries a **completion receipt** — the versioned record `complete-run` writes naming the units it
  vouched for, the checks it evaluated and the build it ran — whose ledger-checkable half the fold
  **re-derives** at the marker's position in event-time order (is this run tracking anything, is every
  tracked unit terminal, are those exactly the units the receipt names). Be exact about what that is:
  **integrity and provenance, not authentication.** `minted_by` is an unauthenticated string with the
  same standing as `adjudicated_by`, and there is no key, so any digest the harness could compute an
  appender could compute too — which is why the receipt carries none. What it buys: a forged marker
  cannot complete an active or empty run, because the only way to satisfy the cross-check is to make the
  units terminal, which is the work itself. What it does not: on a run that would pass the gate anyway, a
  hand-written valid receipt still completes it. Ignored markers are listed in
  `state.run_completion_rejected` and named by `complete-run`'s output rather than silently dropped.
  **(b)** `complete-run` compared only the harness versions **already recorded** in the ledger — exactly
  the blind spot DER-2779 closed for dispatch, left open on the one other path that writes. A caller on a
  different build passed the protocol check and then auto-attested its own version during the append,
  leaving a freshly-completed run with mixed protocol versions. It now folds
  `currentVersionAttestation()` into the verdict the gate reads, the same way dispatch does;
  `--allow-version-skew` still acknowledges a deliberate mid-run upgrade. **Migration:** a run completed
  by a pre-receipt build carries an unreceipted marker and reads as `running` again — re-run
  `complete-run`, which re-checks the gate and mints a current marker (it appends nothing if a check
  fails). Adding a future gate check means bumping the receipt version, so an older receipt is never
  honored as covering a check its build never ran. (DER-2838)

- **DER-2836 (P0) — the evidence-query policy was decorative, because a shell re-expanded the query
  AFTER it was validated.** `query-check` handed the raw text to `spawnSync(…, {shell: true})`, so the
  arguments a command finally received were not the arguments any rule had read. `find . $(printf --
  -delete)` passed every check and deleted files: the substitution was validated on its own (`printf` is
  read-only and allowlisted), then collapsed to a placeholder, so `find`'s `-delete` rule was applied to a
  word that was not yet `-delete`. The same hole was `sed $(printf -- -i) …`, `sort $(printf -- -o) …`,
  `awk $(printf -- -f) …` — and, with no substitution at all, `$'-delete'`, a bare `$EVIL`, and an
  unquoted glob in a repo containing a file *named* `-delete`. It defeated the option allowlists by
  construction rather than by finding a hole in one, so widening those lists could not have fixed it.
  **Fixed by removing the expander, not by enumerating expansions**: `runEvidenceQuery` executes the
  parsed pipeline in argv form — `spawnSync(cmd, args)`, one stage at a time, stdout buffered into the
  next stage, `&&`/`||` short-circuiting off the previous status, redirects resolved by the parser — so
  there is no second expansion pass for anything to hide in. An enumeration is only as complete as its
  author; this is a property of the execution model. Words carrying an expansion, and unquoted globs, are
  now refused in every position (not just the command name) as defense in depth and because nothing would
  expand them — a literal `$(git rev-parse HEAD)` would silently answer a different question. **This
  reverses a documented allowance:** substitution was previously permitted when its contents were
  themselves read-only, which was the bug — `printf`/`echo`/`cat` are all read-only *and* all emit
  arbitrary text. Verified by fault injection in `e2e.test.mjs`: six payloads, each planting a canary file
  that the parent commit actually deleted, plus controls proving legitimate pipelines still run. A
  mutation audit with **both** the validator and the executor's refusal neutered confirms the canary still
  survives — the argv execution is what protects, the refusal is the second layer. (DER-2836)

- **DER-2777 — the evidence-query sandbox closes four outbound channels that were all validated
  "read-only."** `git ls-remote` was in the read-subcommand allowlist and its nested `$(...)` re-validated
  by the same rule; the awk/gawk option parser skipped every content check on any `-`-prefixed argument,
  including an attached `-f`; gawk's `/inet/tcp/.../getline` special files were never matched by the
  `/dev/` path predicate; and `<` input redirection was waved through because reading is a read, even
  against `/dev/tcp/...` or an expansion-built target. All four are live outbound channels — reading a
  value is not read-only when the read target is a remote host. awk/gawk options are now default-deny
  against a closed safe list, `/inet[46]?/` is refused in every argument position, and `<` is refused
  against a device/socket target or one built by expansion; `ls-remote`/`fetch`/`pull`/`push`/`clone` are
  dropped from the read-subcommand list outright. Introduces `parseEvidenceQuery`, the shared query parse
  DER-2776 and DER-2783 below both consume. (PR #21)
- **DER-2778 — a fork PR could impersonate a cloud lead and silently clear a pending kickback.** This is
  DER-2737's incomplete family: PR *comments* were hardened in 0.2.0, PR *list* state was not. This repo
  is public and issue ids are announced in PR titles; `gh pr list` reconciliation matched PRs on a
  branch-or-title substring with no author/owner check, so a fork PR titled with an in-flight issue id
  could repoint the tracked PR's pointer, and its ancestry check failed **open** on an unfetchable fork
  SHA — reading it as "proven new work" and dropping a real pending kickback out of `kickbacks_pending`. A
  PR now counts as this run's own only when its author is the repo owner or a configured
  `trustedPrAuthors` login **and** its head repository owner matches the target repo; an unresolvable SHA
  now fails closed rather than open. *(This entry as written asserted parenthetically that the owner check
  alone already excluded every fork. That is false when one owner holds both a repository and a fork of
  it, which is the defect DER-2840 closes (its entry is at the top of this section — `[Unreleased]` is
  newest-first). The false wording is described rather than quoted, because `repo-contract.test.mjs` now
  sieves shipped prose for it literally and cannot tell a quotation from a live claim. Corrected here
  rather than left standing, because it is the sentence a
  reader would use to conclude the hole was already shut.)* `trustedPrAuthors` is deliberately a separate
  allowlist from `trustedCommentAuthors` (DER-2737) — the review bot's *comments* are trusted input, but a
  PR it opens is not one of your leads. (PR #23)

### Fixed

- **DER-2774 — a red CI no longer parses as "no checks."** `parseChecksOutput` matched the CI status row
  by the literal job name `checks`, a carry-over from the repo this harness grew up on, and returned
  `checks: null` for any repo using different job names — indistinguishable from "the probe died" and
  "this repo has no CI at all." Measured directly against this repo's own genuinely-red PR, the old parser
  reported `checks UNKNOWN — WAIVED` where the correct read is `checks=fail`. `gh`'s `--json` exit-code
  semantics (verified against `cli/cli` source, not memory) now drive three outcomes: exit 0 classifies
  from the returned buckets only; a `no checks reported` stderr sentinel is verified-absent and still
  waivable; anything else is unknown and never waivable. Direct-mode merges also now bind
  `--match-head-commit <headRefOid>`, since every gate `ready` checks is a statement about one sha, and a
  push landing before the operator's later merge command previously went ungated. (PR #18)
- **DER-2775 — `reap` no longer destroys work it cannot account for, and only records a kill it can
  prove.** It had no precondition on its target: an id this run never had could append a **terminal**
  `reaped` event (permanent, since dedup keeps the first per issue), and a unit still
  `in_progress`/`pr_open`/`kickback` was torn down with `git worktree remove --force` exactly like a
  merged one. Both now refuse before any teardown or ledger write; `--abandon`/`--force` is the explicit
  deliberate-destruction hatch and is stamped on the event so audits can tell post-merge cleanup from
  deliberate destruction. Separately, all three remote kills ran `pkill -f <pattern>; true`, which
  discarded the exit code and never actually proved the process was gone; they are now kill-then-`pgrep`
  in one round trip, an unverifiable kill leaks (never reads as success), and `rotate-lead`/`spawn-lead`
  refuse to respawn onto a worktree whose predecessor is not provably dead. The kill pattern is now
  validated at construction (non-empty, 12-character floor, `/briefs/`-bearing, no newline) through one
  shared constructor all four call sites build through — closing a same-issue follow-up where an
  `undefined` path segment from a missing config key cleared every check and reported a clean kill for a
  lead it never touched. (PR #17, PR #19)
- **DER-2776 — a torn remote ledger tail is held for retry instead of consumed as damage.**
  `pullHostInto` advanced its cursor by the count of non-blank lines while `tail -n +N` numbers all of
  them, so a line torn by a concurrent remote writer was misclassified as a corrupt complete record: the
  cursor skipped past it, the completed event was **lost permanently** once the writer finished it, and
  the non-transient `remote_malformed_json` classification latched a run-wide "every number is a lower
  bound" damage banner that only a human could clear — over a line that was never actually corrupt. An
  unterminated remainder is now held and re-read next cycle (`torn_tail`, transient); a hold older than
  `WORK_LEDGER_HELD_STALE_MS` (default 5 min) surfaces as `state.ledger.held_fragment_stale` so an
  abandoned host's fragment doesn't retry invisibly forever, and can be acknowledged so DER-2781's
  `complete-run` below doesn't become permanently unsatisfiable once a host goes away. (PR #22)
- **DER-2779 — the version-skew gate now attests the version of the process about to act, not only
  versions already written to the ledger.** DER-2748's comparator only ever ran between versions already
  recorded — so a 9.9.9 checkout dispatching into a ledger whose only recorded version was 0.1.0 was
  **not** blocked, while the identical skew with one extra heartbeat already in the file was. The dispatch
  gate's verdict now includes this process's own `getHarnessVersion()`, so a skewed checkout refuses even
  with no heartbeat having run, and a process's first ledger write attests its version — but only when the
  ledger already carries a real recorded version, so a legacy pre-stamp ledger is not retroactively
  poisoned by its first writer. The refusal names which host and version wrote the divergent event.
  Legacy pre-stamp ledgers stay tolerated and unblocked; read-only subcommands stay usable against a
  skewed ledger so an operator can still diagnose one. (PR #26)
- **DER-2782 — review-gate blockers must block on the current head, not just an absent one.**
  `gateEvidenceVerdict` returned `{state:"current", blocks:false}` whenever the evidence sha matched head,
  with no check of the blockers count at all — so a lead that *fixed* its findings (moving sha off head,
  turning the gate STALE) blocked, while a lead that *ignored* them (sha stays == head) sailed through as
  `gate=CURRENT`. Blockers are now checked on the current-head path too. The escape hatch for a blocked
  gate is a `gate_adjudication` event that clears only the sha it names, requires non-empty findings
  referencing the gate event, and prints loudly (`⚠ gate=ADJUDICATED (n findings waived by <who>)`) rather
  than folding into a silent pass — authority is documented (orchestrator/operator only) rather than
  enforced, since anyone with filesystem access can append an event. (PR #20)
- **DER-2783 — evidence queries are gated on real exit status, and `grep -c`/`rg -c`/`wc -l` are counted
  by number, not by output lines.** `query-check` never read the child process's exit status or signal, so
  an ordinary nonzero exit (the tool's own documented failure shape) still evaluated its stdout and could
  pass — `git log ... | grep -c 'fix('` matching zero commits stamped `ok 1 ≥ 1`. A query is now `ok` only
  if the run exited 0 with no signal **and** the output meets `expectAtLeast`. In the other direction,
  `grep -c` always emits exactly one line, so a line-counting evaluator made any floor above 1 impossible
  to satisfy even on a genuine match — numeric mode (built on DER-2777's shared query parse) now reads a
  single bare integer on the final counting stage as the count itself, on both a piped and a single-stage
  query. (PR #24)

### Added

- **DER-2837 — `SECURITY.md`: the trust boundary is now stated instead of implied.** The harness runs
  with the operator's own credentials and is a control plane for authorized work, not a sandbox around an
  adversary. Supported use is supervised sessions in trusted repositories; unattended operation against
  semi-trusted issue/plan/PR text is explicitly NOT supported. Two limits are named rather than left to
  be inferred: privileged event **authority is a documented convention, not authentication** (anything
  that can write the run directory can write any ledger event — `gate_adjudication` is shape-validated
  and surfaced loudly, but `adjudicated_by` is an unauthenticated string), and evidence queries are
  ultimately **executed by a shell**, so the read-only policy is defence-in-depth against mistakes, not a
  sandbox. Authenticated privileged-event ingress was considered and is deliberately out of scope for
  now — the decision, and what it implies for adopters, is recorded rather than silently carried. Also
  adds a private vulnerability-reporting route and a hardening roadmap. (Codex cold-eyes finding #4.)

- **DER-2830 — a fault-injection E2E suite (`e2e.test.mjs`), hermetic tier wired into CI.** The unit
  suites prove the predicates; this drives `work-runner.mjs` as a real subprocess and INDUCES the
  failures the harness exists to survive — a torn ledger tail, harness-version skew, a foreign wire
  version, a reap of a phantom unit, an unfinished run. The gap it closes: almost every fix since 0.1.0
  is a *failure handler*, so a happy-path run exercises none of them and still returns green. Tier A is
  hermetic (no network, no model calls, no `gh`) and runs on every PR in ~3s; Tier B is opt-in behind
  `WORK_E2E_LIVE=1` and never runs in PR CI. The file also carries **defect pins** asserting four
  known-live fold bugs (DER-2323, DER-2602, DER-2810, DER-2824): a pin going red means the bug was
  FIXED and the pin must be inverted, so an all-green E2E is never mistaken for "no known defects".
  Each case was validated by a mutation audit — neuter the guard, observe the matching test go red —
  and one mutation that produced byte-identical output was discarded as a no-op rather than counted as
  coverage.

- **DER-2781 — `complete-run --run <r>`, a machine-checkable end to a run.** `materializeState` set
  `status: meta.status ?? "running"`, no call site ever passed a status, no terminal run event existed,
  and nothing read the field — a run had no way to record that it was finished, so a successor couldn't
  distinguish completion from abandonment. `complete-run` verifies every tracked issue is terminal
  (`pr_merged`/`reaped`), no kickbacks are pending, ledger health is ok (including DER-2776's
  held-fragment age signal), and the protocol verdict is clean, before appending anything; any check
  failing refuses with the list. Idempotent (a second call is a no-op "already completed"); a late event
  arriving after completion does not reopen it but surfaces as a visible `post_completion_events` count; a
  stale hold from a departed host can be acknowledged so completion is never a permanent dead end. (PR #25)

### Docs

- **DER-2780 — the changelog and its neighbors no longer contradict the version-skew protocol they
  describe.** `install.sh` already copied `VERSION` and refused to install without it, and DER-2748/DER-2779
  above already refused mixed-version dispatch — but `README.md`, this file's own preamble, this file's
  "Known follow-ups" bullet under 0.2.0, and a code comment in `work-runner.mjs` still described skew as
  invisible and `VERSION` as never copied, one of them self-contradicting a "Fixed" bullet nine lines above
  it in the same file. Corrected in place. This `[Unreleased]` section also backfills all nine units above,
  none of which had a changelog entry before this one — no wave commit had touched this file.

### Known follow-ups

- **DER-2809** — the `Number("") === 0` env-read family: an empty `WORK_WATCH_POLL_MS` (and siblings
  sharing the coercion) reads as `0` rather than "unset", turning a poll loop into a ~5ms spin instead of
  its intended default.

_(**DER-2808** and **DER-2810** were listed here and are now CLOSED — see the evidence-query entry under
`[Unreleased]` above. Removed from this list in the same change that fixed them: a follow-up list that
still names a closed defect is the same drift as a comment describing code that no longer exists.)_

## [0.2.0] — 2026-07-29

The "world-class harness" fix run: a cold-eyes review of `2c3ecbe` produced 21 code-grounded findings.
Each fix below landed with a regression test that was **observed failing on the pre-fix code first**.

### Security

- **DER-2737 — unauthenticated PR comments are no longer privileged lifecycle input.** `parsePrEventComments`
  and the handoff-note reader folded any `WORK-EVENT`/`WORK-HANDOFF`-prefixed comment on any open PR into
  the ledger with no author check, which allowed a phantom unit forged via a comment, an injected
  `worktree` that reached an **unquoted** `ssh` string in `reap`, and a forged predecessor handoff note
  presented to a successor lead as testimony. Comment authors are now allowlisted (repo owner + known
  bots), comment payloads may not carry `worktree`/`branch`/`host`, `pr`/`host`/`actor` are stamped by the
  reader rather than read from the body, the run-scope filter applies to the singular `issue` as well as
  `issues[]`, and both `reap` interpolations are `shellQuote`d. **This closed the comment vector only** —
  a *retargeted* unit stayed reachable through PR-*list* state (`gh pr list` + branch/title matching, no
  comment involved at all), which a fork PR could exploit to silently drop a pending kickback; that half
  was closed by DER-2778 (`[Unreleased]`, above) — and only fully by DER-2840, which closed the same-owner
  fork that DER-2778's owner-equality check still admitted. Named here because this entry points a reader
  at DER-2778 as the closer, and on its own would hand them the retracted conclusion.
- **#19 — evidence queries are validated read-only before a shell runs them.** `prep-runner`'s
  `query-check` passed `evidenceQueries[].query` to `spawnSync(…, {shell: true})` behind only a *shape*
  check, and a plan is often assembled from issue text and lead output — so plan content could execute
  anything in the repo root. Validated now by an allowlist over a parsed query (not a metacharacter
  blocklist, because pipelines are the feature), applied both in `validate` and immediately before the
  `spawnSync`. Unrecognised is refused rather than run. **"Read-only" was not the whole test:** DER-2777
  (`[Unreleased]`, above) later found four channels this allowlist accepted as read-only that still
  exfiltrated over the network (`git ls-remote`, an awk option-parsing bypass, gawk's `/inet/` getline,
  and `< /dev/tcp/...`) — reading a value is not sufficient when the read target can be a remote host.
- **DER-2742 — `create-worktree` no longer deletes anything.** It called
  `rm(wt, {recursive:true, force:true})` unconditionally *before* `git worktree add`, with no check
  whether the path was a registered worktree or held uncommitted files. Because the path is deterministic
  per run+issue, a retry erased a lead's uncommitted work **and then failed anyway** (`add -b` aborts on
  an existing branch). Replaced by a pure planner with exactly three outcomes — resume, create, refuse —
  and **no delete outcome at all**. A registered worktree on the requested branch resumes idempotently; a
  branch that exists is *attached* rather than recreated; anything else is refused with numbered recovery
  steps. Symlinks are inspected with `lstat` and never followed.

### Fixed

- **DER-2743 — `install.sh`'s self-test can now fail the install.** Both verification lines ended in
  `|| true`, which nullifies `set -o pipefail`: a red suite, a missing `node`, or a broken test file all
  still exited 0 while the script printed "Verifying (the harness tests itself)". The installer captures
  each suite's real exit status, names the suite that failed, and exits nonzero.
- **The installer verified 3 of the 5 suites it shipped.** `install.sh` copies `skills/` and `hooks/`
  wholesale but named its self-test suites by hand, so `session-end-telemetry.test.mjs` and
  `hooks/context-wrap-nudge.test.mjs` were installed and never run — a broken hook installed reporting
  "clean". `repo-contract.test.mjs` now enforces both directions: every shipped suite appears in
  `install.sh`, and `install.sh` never names a suite it doesn't ship.
- **`install.sh` did not ship `VERSION`.** The runner reads `<skillsDir>/../../VERSION`, which resolves to
  `$DEST/VERSION` once installed, so an installed host reported `harness_version: "unknown"` — and two such
  hosts looked *same-version to each other*, exactly the skew DER-2748 exists to detect. The suite also
  passed in a checkout and failed only from `~/.claude`, the copy that actually runs. A real-repo install
  control now covers that class, since the fixture-based tests structurally cannot.
- **DER-2747 — the SessionEnd hook attributes `SPEC-<slug>-U<n>` units.** Its id regex matched only classic
  Linear ids, so every spec-mode run silently lost all per-unit token attribution; a `token_usage` event
  that folds to nothing is indistinguishable from one never emitted. Now derived through the shared
  exported grammar. The hook body also ran at module top level with `process.exit(0)` on every early-out,
  so importing it to test the parser killed the test process — now behind a `main()` guard.
- **DER-2581 — window resolution no longer under-reports a 1M-token model as 200K.** Every resolver tested
  for the `[1m]` marker alone, but that marker is a deployment identifier, not what grants the window:
  Opus 5, Fable 5, Sonnet 5 and Opus 4.6/4.7/4.8 are natively 1M. Fixed as a class in all three copies of
  the predicate, with a test asserting they agree. Explicitly an allow-list, not default-to-1M, so the
  inverse error (a 270K lead judged against 1M) stays out. **Partial:** the ~1.8× discrepancy this issue
  originally measured is probably a second, still-open defect in token accounting — for a rotation
  decision, trust `state.session_context`, not the banner.
- **DER-2745 — the token reporter is shipped, and its absence is loud.** The SessionEnd hook resolved
  `<cwd>/scripts/session-token-report.mjs`, a path the harness never shipped, then `exit(0)`'d — so on a
  fresh install every token number was an undercount by omission, and a session that recorded nothing
  looked identical to one that spent nothing. The reporter now ships, and all six no-number paths append a
  durable `telemetry_gap` event. It never prints a number it did not measure: no transcript means exit 2,
  not a fabricated `0`. `preflight` gained a `token-reporter` check that smoke-runs the reporter against a
  known-sum fixture (catching one that inflates by summing transcript lines) and a separate leg that
  catches a stale `~/.claude`; `skills-sync:<host>` now hashes the reporter too.
- **`work-metrics.mjs` disagreed with the runner about the same ledger** — a duplicated line reported 165
  tokens against the runner's correct 110. Its dedup rule is deliberately duplicated (that module is
  standalone by contract) and pinned by an agreement test over six ledgers.
- **DER-2738 — one torn or malformed ledger line no longer crashes every consumer.** `readEvents` did a raw
  `JSON.parse` per line, so a writer interrupted mid-append (the signature of a concurrent writer) threw
  `SyntaxError` out of `state`, `watch`, and every other consumer. Parsing is now tolerant at the single
  choke point — but **never silent**, because an invisible dropped line is data loss you cannot see. Every
  dropped line is preserved with its **raw bytes** in `<runDir>/ledger-quarantine.jsonl`, warned once per
  signature on stderr, surfaced as `state.ledger`, raised as `pending.ledger_damage` on every `watch` wake,
  and labelled in the `work-metrics` report so a number over a holed ledger reads as a lower bound. A torn
  *tail* does not latch (it is usually a live writer and clears on the next clean read); a malformed
  *complete* record latches until acknowledged. The damage report is a **sidecar, never an appended event** —
  appending to a ledger whose last line is torn would glue the new line onto the partial one.
- **DER-2741 — the watch cursor no longer misses backfilled events, and idle watch stops re-reading the
  whole ledger.** The cursor was an event *count* over a ts-sorted array, so a historical event appended at
  the tail by `--pull-hosts` sorted behind the watcher's position and was **silently skipped** — a dropped
  dispatch signal. The cursor is now a byte offset carried across processes as the last delivered
  `event_id`, and fresh events are the lines appended since, in arrival order. `--since <count>` still works
  and can only round toward *replay*, never skip; `--since <garbage>` used to become `NaN` and never wake at
  all, and now replays. Idle ticks stat an unchanged file instead of re-parsing it (`WORK_WATCH_POLL_MS`
  tunes the interval).
- **DER-2739 — a failed launch is no longer recorded as a lead.** `spawn-lead` appended `lead_spawned`
  without checking the launcher's exit code or the returned workspace ref, so ONE failed `cmux` launch did
  all of this at once: appended a phantom `lead_spawned`, **emptied `kickbacks_pending`**, **cleared
  `leads_dead`**, retained the closed predecessor's `workspace:11` as if live, promoted the issue to
  `in_progress`/`inflight`, and incremented `kickback_count` as though the round had been delivered. A launch
  is now proven only by exit code 0 **and** a parsed `workspace:<n>` ref — neither alone suffices, since
  `runCommand` never throws and the ref parser returns null on garbage. An unproven launch records
  `lead_spawn_failed`/`shepherd_spawn_failed`/`orch_spawn_failed` **before** throwing (the throw reaches only
  whoever typed the command; the ledger is what the next wake reads), leaves the issue queued, and keeps any
  kickback pending. Surfaced as `state.spawn_failures` + `pending.spawn_failures` and added to the actionable
  set, so a dispatch that *didn't* happen wakes the loop as loudly as one that did.
- **DER-2744 — alt-model lanes wrote no transcript, undetectably.** The proxy branches of both lead boot
  builders omitted `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, so every non-Claude local and mini lead ran
  without a transcript — and `lead-context`, the rotation bands, token telemetry and crash-recovery evidence
  all read transcripts, which makes such a lane indistinguishable from a dead lead. One `claudeEnvPrefix`
  now builds the env for every claude launch so no branch can drop it, and each builder asserts its own
  finished launch string. The predicate checks the var's **position**, not merely its presence: `env` applies
  only assignments that precede the binary, so a trailing occurrence is an argv word — a substring check
  would have passed the broken form. Spawn events carry `transcripts_forced` **measured off the command
  actually built**, folded tri-state (`null` = UNKNOWN, never assumed true) and surfaced as
  `state.transcripts_unverified`. Cloud lanes are excluded by construction (RemoteTrigger, no locally
  readable transcript), so the banner stays meaningful.
- **DER-2740 — `reap` no longer claims a teardown it did not achieve.** It discarded all four cleanup
  results and appended the TERMINAL `reaped` regardless, and because `dedupeTerminalEvents` keeps the first
  `reaped` per issue, a premature one could never be corrected later. The sharpest harm: a failed remote
  `pkill` leaves the mini's `claude` **alive burning tokens** while the ledger says the issue is reaped and
  nothing will look at it again. Cleanup stays best-effort — the run must be able to end — but every step's
  exit code is now captured and classified. `remote_pkill` and `remote_worktree_remove` are REQUIRED, since
  nothing else reclaims what they leave behind; the AUTO_MERGE delete and the local worktree remove stay
  optional, because a missing ref and an already-gone worktree are the normal cases and treating them as
  leaks would be the inverse defect. That also finally *reads* the `optional` marker, which had been set on
  the AUTO_MERGE command since it was written and inspected by nobody. A leak records a separate
  `reap_failed` event (not just a field on `reaped`, which dedup would swallow), surfaces as
  `state.reap_failures` with per-step remediation, raises `pending.reap_failures`, and is actionable so it
  wakes the loop. Note the original framing was backwards about panes: appending `reaped` is precisely what
  enqueues an issue's refs into `sweepPlan`, and `sweep-workspaces` re-closes them *and* checks exit codes.
- **DER-2603 — `ready` no longer prints a go-ahead word for a PR whose pre-PR review gate never ran.**
  `gateEvidenceVerdict` treated an ABSENT `review_findings` event as non-blocking, so a PR that skipped the
  gate was indistinguishable from one that passed it — three PRs skipped it in one shift and one merged. Both
  go-ahead words are gated now (`*** ENQUEUEABLE ***` and DER-2753's `*** MERGEABLE (direct) ***`; a direct
  merge that skipped the gate is strictly worse, since no queue will catch it), and `readyVerdict` refuses
  when handed no gate verdict at all — previously *omitting* it read as a pass. MISSING and UNKNOWN both fail
  closed but name different jobs: "you skipped it" versus "I could not read the evidence" (no `--run`, PR not
  tracked, or a pre-stamp ledger, discriminated mechanically by DER-2748's `harness_version` on
  `run_started`). `UNSTAMPED` still passes deliberately — the event's existence proves the gate ran, and
  blocking it would refuse work over the runner's age. Surfaced as `state.gate_missing` +
  `pending.gate_missing`.
  Two further defects fell out of this. A **live** one: `latestGateEvent`'s filter is
  `if (issueId && e.issue !== issueId)`, so an `undefined` issue matched **every** issue — an untracked PR
  could read `gate=CURRENT` off a *sibling unit's* evidence and print the go-ahead word. And the test pinning
  this behaviour asserted only `.state` beneath a comment claiming "neither is silently a pass"; `absent`
  **was** silently a pass, and nothing checked the claim. That comment/assertion gap is what the merge went
  through, so the test now asserts `blocks`.
- **DER-2746 — `init-run` runs the canonical plan validator.** It applied only two cheap local checks, so it
  accepted plans `prep-runner validate` rejects: two doors onto one plan file at different strictness, which
  makes the weaker one the only one that matters. It now calls the same exported `validatePlan` with the same
  options, via a dynamic cross-skill import (work-runner.mjs is copied to hosts where the prep skill isn't
  installed, so a static import would break every subcommand to protect one). Validation also moved **before**
  `mkdir`: a refused `init-run` previously still created the run directory, and `assertExistingRunDir`
  (DER-2570) treats a run directory as proof the run exists — so every later subcommand would operate on a
  ledger with no `run_started`. This legitimately refuses plan shapes that used to reach dispatch (missing
  plan review, unresolved gates, unrecorded symbol/evidence checks, a risk lane on a weak lead type); the
  escape is the documented `planReviewSkipped:{why}`, not a `--force`.
- **DER-2749 — the configured commit identity now reaches a cloud lead's brief.** `renderCloudBrief` had
  always accepted a `commitAuthor` and emitted the `git config user.name/email` step when given one, but the
  cloud call site never passed it — and, worse than filed, **`applyRepoConfig` never parsed the documented
  `commitAuthor` key at all**, so there was no source to pass even if the call site had asked. Every cloud
  lead committed as whatever the cloud environment defaulted to, which reds a deploy check that maps commit
  author to an account. Now parsed, plumbed, and refused when half-set: name-without-email would render
  `git config user.email ""`, actively SETTING a broken author rather than leaving the default alone, so a
  partial block is a config error naming the key. Omitting the block entirely stays legitimate and emits no
  git-config step.
- **DER-2750 — cloud reconciliation costs one `gh` call instead of 1+N.** It listed open PR numbers and then
  ran `gh pr view` per PR, so the cost scaled with the whole repo's open-PR count (ceiling 100) at a 45s
  cadence — tracking unrelated activity such as dependabot rather than run size, ~8k calls/hour worst case
  against a 5k/hour budget. The fix is deliberately **not** to narrow the list to the run's known PRs, which
  looks like the obvious move and would break cloud-lead discovery: a cloud lead announces itself by opening
  a draft PR the ledger does not know about yet, and relevance is decided from branch/title. The waste was
  the per-PR fan-out, and `gh pr list --json` accepts every field the loop fetched — including `comments` —
  so it collapses into the call already being made. Measured: 12 open PRs went from 1 list + 12 views to
  1 list + 0 views, with a control proving an untracked draft is still discovered and an unrelated
  dependabot PR still ignored.

### Added

- **DER-2751 — release engineering.** A CI workflow (`.github/workflows/ci.yml`) that runs the runner,
  metrics, prep, installer-contract and repo-contract suites on Node 20/22/24, plus `node --check`,
  `bash -n`, ShellCheck (`--severity=error`), and a named public-comment security-regression job that
  **fails when zero DER-2737 controls match** rather than passing on an empty pattern. Adds `VERSION`,
  this changelog, `install.test.mjs`, `repo-contract.test.mjs`, and `.github/REPO-SETUP.md` (the
  branch-protection settings, as a one-paste `gh api` call).
- **DER-2753 — direct-merge mode, for repos with no merge queue.** The harness could only merge through a
  GitHub merge queue, so a queue-less repo (this one, and most public adopters) had no supported merge path
  at all. `repo.mergeMode` (`queue`/`direct`, omit to auto-detect), `repo.mergeStrategy`, and
  `repo.allowMergeWithoutChecks` (default `false`, compared `=== true` so a truthy string cannot loosen a
  gate). Fails closed throughout: an unresolved mode holds and names the config key, a *failed* queue probe
  is UNKNOWN rather than "no queue", and the checks waiver applies only to a wholly absent check surface —
  red and pending still block, and the verdict names the waiver so it stays auditable.
- **DER-2748 — ledger wire protocol.** Every line now carries `schema_version`, a uuid-v7 `event_id` minted
  at origin, `(source_id, seq)` identifying the writing *process*, and `received_at`; `run_started` and
  `host_heartbeat` additionally carry `harness_version`. A relay preserves origin identity and re-stamps
  only `received_at`. Reads are exactly-once on identity collision only — a lower-but-unseen `seq` is a
  late arrival, not a duplicate, because `readEvents` sorts by ts and discarding it would delete a real
  event on a backwards clock step. Mixed harness versions refuse a dispatch (`--allow-version-skew` to
  override) and a foreign `schema_version` fails closed. Legacy ledgers with neither field keep working,
  which matters because the two SessionEnd hooks still append unstamped lines. Run `heartbeat --host <name>`
  once per host at dispatch, or skew detection stays dormant for every host except the one that ran
  `init-run`.

### Known follow-ups

- **Branch protection is not applied by this release.** It requires repo `admin`; the exact call is in
  `.github/REPO-SETUP.md` and must be run by the repo owner. Until it runs, CI is advisory: it reports,
  but nothing stops a merge that ignores it.
- **ShellCheck runs at `--severity=error`,** not `warning`. Tightening it is a follow-up; a gate that
  arrives red on style nits teaches operators to ignore CI, which is worse than no gate.
- **`skills/work/cmux-look.sh` and `cmux-say.sh` are not ShellCheck'd** — they are `#!/bin/zsh`, and
  ShellCheck supports sh/bash/dash/ksh only (SC1071). CI syntax-checks them with `zsh -n` and prints the
  exclusion rather than passing over it silently. Porting them to bash would bring them under the linter.
- **The first CI run found two defects in this PR itself,** which is the argument for the workflow: Node 24
  switched `node --test`'s default non-TTY reporter from TAP to spec, so an installer test that asserted
  the TAP shape failed there (the installer already accepted both); and the ShellCheck gate as first
  written pointed at zsh scripts, so it could never have passed.
- **Harness version IS now recorded in the ledger and mixed-version runs are refused** (DER-2748).
  `run_started` and the new `heartbeat` subcommand stamp `harness_version` read from `VERSION`; every
  event carries `schema_version` / `event_id` (uuid v7) / `source_id` / `seq` / `received_at`; a ledger
  holding two harness versions or a `schema_version` this build does not implement refuses `spawn-lead` /
  `spawn-shepherd` / `spawn-orch` / `rotate-*` (harness skew is overridable with `--allow-version-skew`,
  a foreign schema is not), and the skew shows in `state.protocol` and on every `watch` wake. `install.sh`
  copies `VERSION` to `$CLAUDE_HOME` and refuses to install at all without it (see this entry's own
  "Fixed" section, above) — an installed host reports its real version, not `"unknown"`. This gap is
  closed, not residual; DER-2779 (`[Unreleased]`) closed the other remaining half, attesting the *acting*
  process's own version too, not only versions already written to the ledger.

## [0.1.0] — 2026-07-29

Initial import of the harness as a public, shareable repo: `skills/work` (orchestrator + `work-runner.mjs`),
`skills/work-lead`, `skills/work-shepherd`, `skills/prep-for-work` (+ its four grounding gates),
`hooks/context-wrap-nudge.mjs`, and `install.sh`. Repo-specific identity moved out of the runner and into
`.claude/work.config.json` (see `skills/work/work.config.example.json`), which is what made the harness
installable by anyone other than its author.
