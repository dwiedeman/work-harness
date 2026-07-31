# Harness upgrade plan — from run `20260730T233426Z-der-2869-der-2864`

**Author:** orchestrator ws:60 (`orch:5532907b`), 2026-07-31
**Source run:** 23 PRs merged, 20h08m wall clock, 3.84B tokens. Contributors: 3 orchestrators, 5 shepherds, 50 lead spawns.
**Inputs folded:** this run's ledger + `~/.claude/rost-learnings.md` (2026-07-31 entry) + two shepherd hand-offs (ws:59 and ws:61) + `work-metrics` cross-run trend.

---

## 🔴 PHASE 0 — SYNC FIRST. Nothing below is valid until this is done.

**This run was driven on stale harness code, and neither host could tell.** The installed harness at `~/.claude/skills/` is **not a git repo** (plain directory, no `.git`). The source of truth is `dwiedeman/work-harness`, which was pushed at `2026-07-31T16:38:46Z` — *during* the run.

Measured drift at close-out:

| File | Remote | Installed | Δ |
|---|---:|---:|---|
| `skills/work/work-runner.mjs` | 604,211 B | 566,993 B | **+37,218 B** |
| `skills/work/SKILL.md` | 107,548 B | 103,215 B | +4,333 B |
| `skills/work-shepherd/SKILL.md` | 40,713 B | 39,615 B | +1,098 B |
| `skills/work-lead/SKILL.md`, `skills/work/known-non-issues.md`, `skills/work/work-runner.test.mjs`, `skills/work/work.config.example.json`, all of `skills/prep-for-work/` | differ | differ | — |

**Both sides report `VERSION` = `0.2.0`.** The version-skew machinery (DER-2748/2779) therefore **cannot see this drift at all** — it compares versions, and the version was not bumped across ~12 commits. Two hosts running different code look identical to each other. That is the same class of defect the skew check exists to prevent, one level up.

### P0.1 — Do the sync

```bash
cd ~/Projects/work-harness          # clone already created by this plan's author
git pull --ff-only
./install.sh                        # idempotent; copies skills/, hooks/, VERSION → ~/.claude
```

`install.sh` is the supported mechanism and it self-verifies (it refuses to install without `VERSION`, and it runs the harness test suite — DER-2743 removed the `|| true` that used to let a red suite exit 0). **Gate on the suite passing, not on the command returning.**

Then re-sync every non-local host that will take leads:

```bash
ssh macmini-hermes 'cd ~/Projects/work-harness && git pull --ff-only && ./install.sh'
```

⚠️ Before trusting a remote sync, read **P6.1** — `macmini-hermes` was unreachable for most of this run and the ssh config has been fixed since.

### P0.2 — Re-verify every finding below against synced code before implementing

Several defects in this plan were observed on the **stale** install. I spot-checked the big ones against the remote and they **still reproduce** (`reap`'s refusal string, `units_terminal`, the `codex not on head` hold, `review-usage`'s `turn.completed` requirement, zero occurrences of `review-swap`/`lens`/`substitute-gate`/`codexWaiver`). But **check each one yourself after syncing** — filing or fixing an already-fixed defect is the exact waste this phase exists to prevent. Where a finding is already fixed upstream, strike it and note that in the changelog.

### P0.3 — Make this drift detectable (the actual fix)

Version equality is currently a *claim*, not a *measurement*.

- Add a **content digest** alongside `VERSION`: `install.sh` writes `$DEST/INSTALL-MANIFEST.json` = `{version, installed_at, source_commit, sha256 per shipped file}`.
- `preflight` compares the installed manifest against the running checkout's digest and prints **`HARNESS DRIFT`** naming the differing files.
- The dispatch-time skew check compares **digests**, not just version strings, so an unbumped-version drift refuses a dispatch exactly like a version mismatch does.
- Add a release check: a PR touching `skills/**` must bump `VERSION`, or explicitly opt out with a `no-version-bump:` trailer.

**Acceptance:** modify one byte of an installed file → `preflight` prints `HARNESS DRIFT` naming it. Control: an unmodified install prints green. *Both directions must be exercised — a drift check that cannot report "clean" is as useless as one that cannot report "drift."*

---

## PHASE 1 — Operating with no Codex at all (highest priority)

**This is the phase the operator explicitly asked for.** State it plainly in the skills: there are **three** review postures, not two.

| Posture | Bot on PR | `codex exec` local | Gate |
|---|---|---|---|
| **A. Normal** | yes | yes | codex pre-PR gate + bot post-PR |
| **B. Cloud down, local alive** | no | yes | local `codex exec` only |
| **C. Both down** ← *this run, from 03:21Z* | no | no | **local adversarial Claude panel** |

Posture C had **zero harness support**. Shepherd #4 hand-rolled it successfully; shepherd #5 inherited it as undocumented tribal knowledge. Everything below makes C a first-class, recordable path.

### 1.1 — `review-swap`: the substitute gate as a supported command

Today `review-usage` **refuses** a findings-shaped JSON without a codex JSONL `--log` containing `turn.completed` + `command_execution`. That refusal is correct for codex (it exists so a dead gate can't manufacture 0-finding "proof" — keep it). But it means **the substitute gate cannot be recorded through any supported path**, so the shepherd worked around it and the workaround is undocumented.

Add:

```
review-swap --run <r> --issue <ID> --pr <n> --sha <40-char> \
            --engine claude --model <id> \
            --lens correctness --lens security --lens repro \
            --verdicts <file.json>
```

- Writes ONE `review_findings` event with first-class fields: `engine`, `model`, `lenses[]`, `verdict_per_lens`, `sha` (**40 chars enforced** — see 2.4), `substitute: true`, `substitute_reason`.
- **Fails closed the same way codex does**: refuses if fewer than 2 lenses returned, if any lens verdict is missing/empty, or if `--sha` is not 40 chars. A silent lens is `INCOMPLETE`, never `clean`.
- Records `lenses_requested` vs `lenses_returned` so a 1-of-3 gate is *visible as* 1-of-3 and can never render as a full swap.

### 1.2 — Write the posture-C procedure into `work-shepherd/SKILL.md`

Currently nothing tells a shepherd how to do this. Specify, from what actually worked on #1183:

1. **Confirm codex is genuinely down** using the probe in **2.1** — not `codex login status`, which reports healthy while every call 401s.
2. Dispatch **three** reviewers with **distinct refute lenses** — *correctness*, *security/trust-boundary*, *does-it-actually-reproduce*. **Distinct, not redundant**: on #1183 the repro lens **refuted the security lens** (which had called a `size_bytes` branch redundant with the checksum) and was right. Three redundant reviewers would have concurred and deleted live code.
3. Each reviewer is prompted to **REFUTE** and to default `refuted=true` under uncertainty. Majority-refute kills a finding.
4. **Scope each to the diff over `origin/main`, not the repo** — cheaper and it finishes.
5. **Verdict-first output contract** (see 3.3).
6. Prefer a **mutation proof** where a finding claims missing coverage — and *require paired controls*: on #1183 one green mutation meant something **only because four control mutations went red**.
7. Record with `review-swap`. Never hand-write a `review_findings` event.

### 1.3 — A run-level codex waiver that lives in state, not in prose

`ready` prints `hold (codex not on head)` forever when codex is dead. This run's waiver existed **only as ledger prose**, so every single `ready` call required a human to remember it — and a successor orchestrator had to be told.

- Add `waive-codex-gate --run <r> --reason <text> --until <iso8601>` → appends `codex_gate_waived`, surfaced in `state.codex_waiver` and on every `watch` wake.
- `ready` then prints `gate=SUBSTITUTE (claude, 3 lenses, sha …)` or `⚠ gate=WAIVED (<reason>, expires <ts>)` instead of a hold it cannot clear.
- **The waiver must not waive evidence** — with a waiver active, `ready` still blocks unless a `review_findings` event (codex *or* substitute) covers the head. It converts "must be codex" into "must be *some* recorded adversarial review," never into "no review."
- Require `--until` so a waiver expires by construction. An indefinite waiver is how a run silently stops reviewing.

### 1.4 — `state.gate_seen` must carry provenance

It is a boolean today and cannot express "gated by a substitute." Replace with `gate: {engine, model, substitute, lenses, sha, blockers, round}`. `ready`/`budget`/`work-metrics` all read the structured field.

### 1.5 — `review-fidelity` must refuse, not return 0%

When codex never posts, `review-fidelity --pr` returns nothing and reads as **`preempt_rate: 0%`**. Shepherd #5 nearly reported that as a real number. Make it return `UNMEASURABLE` with the reason (`no codex review on this PR`) and make `work-metrics` propagate `UNMEASURED` rather than `0`.

---

## PHASE 2 — Instruments that return confident wrong answers

Two consecutive shift retrospectives named this as the dominant defect class. Every item is a check that **could not produce the failing answer**.

### 2.1 — 🔴 The `codex` on PATH is a cmux shim that fake-hangs (highest-severity in this phase)

`which -a codex` resolves to `/var/folders/.../cmux-cli-shims/<id>/codex` **before** `~/bin/codex`. The shim invokes `timeout`, which **does not exist on macOS** (`gtimeout` isn't installed either), so it prints `command not found: timeout` and hangs at **0.0% CPU with ~37 bytes of output** — *byte-identical to the quota-wall signature the skill teaches you to trust.*

Both the orchestrator and shepherd #4 hit this independently, so it is environmental, not a one-off. It cost ~40 minutes and a wrong root cause across two rounds.

- Resolve the real binary explicitly (`~/bin/codex`), never bare `codex`, in `preflight` and every harness-shelled `codex exec`.
- **Treat empty output as `UNKNOWN` with a re-run instruction, never as a verdict** — same shape as the `REMOTE_PATH_PRELUDE` fix, where a false RED was judged worse than no probe.
- Ship the discriminator in the skill: **a real hang burns CPU; ~0% CPU with ~0 bytes is a wall, not work.**
- Probe form: `~/bin/codex exec --sandbox read-only "reply OK"` — it prints the actual `You've hit your usage limit … Aug 4th, 2026 11:22 PM`.
- **Never use bare `timeout` anywhere in the harness or skills.** Audit for it.

### 2.2 — 🔴 The prescribed `watch` handoff silently kills the watcher

**From shepherd #5, and this one is in `work/SKILL.md` §4 as recommended practice.** The background-`watch` + `caffeinate -w <pid>` pattern killed the watcher **twice** — it exited after ~100s printing nothing, which is *indistinguishable from a quiet wake*. A silently-blind shepherd is exactly the failure mode that lets a ready PR sit unshepherded.

The shepherd proved it with two foreground controls: `--since 0` → event record immediately; `--timeout 15` → timeout record at exactly 15s. **`watch` always prints.** Therefore silence ⇒ killed, never woke.

- Fix or **remove** the backgrounding recommendation from `work/SKILL.md` §4; make **foreground bounded `watch`** the documented default.
- Make `watch` **always** emit a terminal record (`{"wake":"killed"}` on SIGTERM/SIGINT via a trap), so silence becomes structurally impossible.
- Add the control pair to `preflight`.

*(Author's note: I used the prescribed pattern throughout my shift. It did not visibly fail for me — which is precisely the problem: I have no way to know whether I missed a wake.)*

### 2.3 — Sleep is undetectable by the obvious query

The machine slept ~20:29Z–21:36Z; the first check said it hadn't. Power-assertion greps and `uptime` **cannot report a sleep event** — neither could have returned the failing answer. The correct query (`pmset -g log`, battery sleep cycles) confirmed five cycles across the 88-minute gap.

**The non-obvious half: three `caffeinate` assertions were live during the sleep and the box slept anyway.** `caffeinate` does not hold off battery/clamshell sleep.

- `preflight` warns when on battery or when clamshell sleep is possible: unattended waves need **AC power, lid open**, or the mini.
- Add a **sleep-gap detector**: `watch` compares wall-clock delta against expected timeout and appends `host_sleep_detected` when they diverge — so a blackout is a ledger event, not a forensic exercise.
- Document that `caffeinate -w` is **not** a sleep guard.

### 2.4 — `review_findings` sha must be 40 chars, enforced

9- and 10-char forms both read `stale-clean`; only 40 chars reads `CURRENT` (measured on #1180 across three recordings/95s). Fails safe today, but a blocker-carrying gate recorded short would block on **false staleness**. Enforce at write time in `review-usage` and `review-swap`.

### 2.5 — A bare ESM import of `work-runner.mjs` does not load repo config

`getHosts()` → `{local}` only; `getLeadTypes()` → `{claude}` only; `getDefaultPreferHosts()` → `[]`. **`applyRepoConfig(cfg)` does not fix it.** So an ad-hoc `node -e` `pickHost()` returns `local` or `null` and is meaningless — mine returned `null` (= HOLD) purely from this, and I nearly read it as "nothing dispatchable."

Either make `applyRepoConfig` actually work, or make the config-dependent getters **throw** when called before config load. A silent `{local}` is the worst option.

### 2.6 — `state.queue` entries carry no `fileScope`, and empty scope disables every collision rule

The run-plan file uses `surfaces` / `versionAxes` — **not** `fileScope`. Feeding its units to `computeEligible` expecting `fileScope` yields `[]` for every issue, so `globsOverlap` returns false for everything and **everything reads as eligible**. No `fileScope` is recorded anywhere for queued issues — not in `plan.md`, not in the ledger.

- `computeEligible` **refuses** an entry with an empty `fileScope` instead of silently passing it.
- `prep-for-work` emits a real `fileScope` per unit; `init-run` persists it into the ledger so queued units carry scope across orchestrator rotations.

### 2.7 — Staleness of queued work is unchecked, and the naive check is blind

**DER-2594 sat `Todo` for ~21h having been fixed weeks earlier** (landed in #1082 / `b635d0275`). Worse: its "parked" branch was *behind* main, so merging it would have **removed a `credentials` join and reopened the exact security drift it was filed to close.** Only an empty cherry-pick caught it.

And the naive check is itself blind: DER-2814 matches `preflight` **8×** in `onboarding.ts` — every hit the unrelated body-size budget (`preflightCap`). `grep -c` reads ALREADY DONE.

- Add `staleness-check --run <r>` run at dispatch time: for each queued unit, `git log -S<symbol>` on its declared symbols against current `main`, printing **where a symbol landed**, not just a count.
- Skill guidance: *a symbol's presence is not the feature's presence — read the call site / action list.*

---

## PHASE 3 — Inter-agent messaging

The ledger-first convention works but **nothing enforces it**, and there are no receipts.

### 3.1 — Pane messages need a ledger counterpart and a read receipt

`cmux-say` delivers into a session's **input queue**; a mid-turn session reads it only when the turn ends. Shepherd #5 acted on my 19:1xZ ruling ~4 minutes later, and only because it happened to finish a turn. **DELIVERED ≠ READ.**

- `cmux-say` gains `--ledger-ref <event_id>`: it **refuses** to send an actionable message with no ledger counterpart, and the pane text becomes "read ledger `<event_id>`."
- Recipients append `msg_ack {ref}`. `state.unacked_messages` surfaces anything unacked past a threshold, on every `watch` wake.
- Existing precedent to generalize: the kickback relay already demands `kickback_ack` with a ~10-min no-ack ⇒ respawn rule. Apply that shape to **all** actionable messages.

### 3.2 — Crossed messages: two agents derived the same answer independently

Shepherd #4's 19:06:03Z memo and my 19:12Z ruling **crossed in flight**. We independently re-derived the identical #1185 re-pin recipe (v29→v35, append v34, mirror, recompute digest). Correct outcome, wasted effort, and it could as easily have produced two *different* recipes.

- Add a lightweight **claim/lease**: `claim --run <r> --topic <issue|pr> --actor <role>` appended before deep analysis; `watch` surfaces active claims so the other agent sees "shepherd is analyzing #1185" before starting.
- Cheap version if the above is too much: **surface the last N `*_note` events per issue in the `watch` wake payload**, so an agent sees a sibling's fresh analysis without polling the ledger by hand.

### 3.3 — Verdict-first output contract for every dispatched reviewer/subagent

Two of three reviewer subagents **went silent twice**, then delivered in full on an explicit *"send findings or send INCOMPLETE"* ultimatum. They were **not dead** (136k / 158k tokens each). A subagent that returns nothing is indistinguishable from one still working.

- Mandate in every reviewer/subagent prompt: **verdict first** (`refuted: true|false` + one-line reason), detail after. A truncated return then still yields a usable answer.
- Every dispatch must terminate in **one of** `COMPLETE` / `INCOMPLETE` / `REFUSED` — never silence.
- The ultimatum ("findings or INCOMPLETE") worked where re-pinging did not: prefer it to a respawn for a **silent** agent; reserve respawn for a **wedged** one. *This corrects the current guidance, which says respawn-don't-repoke.*

---

## PHASE 4 — Rotation and lifecycle

### 4.1 — `rotate-shepherd` (shepherd #4's top ask)

Leads have `handoffs/<ID>.rot<n>.md`. **The shepherd has no equivalent**, and `spawn-shepherd` has no handoff step — so a successor re-derives state from ledger+`gh` but **silently loses in-flight reasoning**. At the 19:48Z rotation, shepherd #4 lost partially-written #1183 gate-swap findings and an unrecorded review-debt fold decision.

Add `rotate-shepherd` mirroring `rotate-lead`: checkpoint notes → render successor brief → spawn → verify `shepherd_spawned`.

### 4.2 — Attribution survives rotation

Shepherd #5 had to correct the record: **the 3-lens gate and the repro-vs-security disagreement on #1183 were shepherd #4's work**, not its own (#1183 merged at 19:42Z, six minutes before #5 booted). I propagated that error into a run report and a learnings entry.

Stamp every event with an **actor instance id** (`shepherd#4`), not just the role, and have `work-metrics` attribute by instance.

### 4.3 — `complete-run` / `reap` deadlock (filed on DER-2668; **still present on latest remote**)

`complete-run` counts never-dispatched `state.queue` ids as non-terminal and prescribes `reap`; `reap` refuses those same ids as "not a unit in run," and `--abandon` does not override. There is deliberately no `--force`, so **a non-empty `state.queue` at run end is an unconditional deadlock in issue-list mode.** This run cannot be marked complete.

Root cause: `run_started.issues` (28 ids) vs `state.issues` (24 ids, only ever-dispatched).

**Preferred fix:** `reap` accepts a `state.queue` id — tears nothing down, appends `reaped` with `never_started: true`. Keeps "every tracked unit reached a terminal state" true *and* records how.
**Alternative:** `units_terminal` ignores never-dispatched entries and reports `units_not_started` separately.

⚠️ **Do not "fix" this by hand-appending `reaped` events.** `complete-run`'s own refusal text says a run completed over a failing check is a receipt that lies; the ledger is append-only with no supersession, so a forged terminal event is permanent.

### 4.4 — An append-only ledger needs a retraction shape

`state.reap_failures` still lists DER-2868 forever, even though both leaks were verified resolved (no process ever existed; worktree removed). Terminal events dedupe first-wins, so there is no retraction — only a prose note beside it.

Add a **first-class `retracted_by`**: a later event may reference an earlier `event_id` with evidence, and `state` renders `⚠ reap_failures: [DER-2868 — RETRACTED <ref>]`. Preserves the append-only invariant while letting state tell the truth.

### 4.5 — Reap's remote probe must distinguish *unverifiable* from *failed*

It already does, and it was **right** — but the surfaced text reads as failure. DER-2868's "leak" was: no process ever existed, and the probe simply couldn't run because ssh was down. Split the reason field into `failed` vs `unverifiable (<cause>)` so an operator doesn't chase a phantom.

---

## PHASE 5 — Metrics honesty

### 5.1 — 🔴 `kickbacks/merged-PR` silently measures reviewer availability

**The headline finding of the close-out.** The Codex bot died **3h47m into a 20h run** (last review `2026-07-31T03:21:46Z`, #1169). The nine PRs after it got **zero** bot reviews. Splitting the same run on that line:

| Slice | PRs | Kickbacks | Per PR |
|---|---:|---:|---:|
| Codex-reviewed | 8 | 20 | **2.50** |
| No codex review | 9 | 7 | **0.78** |

A **3.2× gap**, and 19 of the 20 kickbacks on reviewed PRs cite Codex findings. Like-for-like, the gated slice was **2.50 vs 07-26's 2.09 and 07-27's 1.50 — worse than baseline**, while the blended 1.17 read as a 44% *improvement*. I reported the improvement before the operator challenged it.

- `work-metrics` computes **per-PR bot-review coverage** (`gh api …/pulls/<n>/reviews` filtered to the reviewer bot) and **refuses to print a single blended kickback rate** when coverage is partial — it prints the split.
- Add a **`Gate coverage`** column to the cross-run trend table. Runs are only comparable at equal coverage.
- Same contamination applies to **tokens/PR** (fewer rounds ⇒ fewer tokens); annotate it identically.
- Keep reporting **median vs p90 hand-off→merge** separately: this run's median 1.6h beat both baselines while p90 13.2h was the worst in the table — the p90 was an **availability** failure (8.5h orchestrator blackout), not review quality. One number would have hidden both.

### 5.2 — Distinguish pre-PR from post-PR review in every report

Kickbacks are **post-hand-off** (every event carries a `pr`); the pre-PR gate emits `review_findings`. During this run the **pre-PR gate never went dark** — 40+ `review_findings` with real blockers, substituted with Claude — only the post-PR bot died. Reports that say "the gate was down" are too coarse and misled my own analysis.

### 5.3 — Token totals must declare their floors

`usage` already flags unpriced spend. Also make it flag **structural gaps**: dropped telemetry (this run: cloud reports before ~18:15Z silently refused by the `trustedCommentAuthors` deny-list) and undrained hosts. Print `TOTAL (FLOOR — n reports known missing)`.

---

## PHASE 6 — Host and environment

### 6.1 — A `.local` ssh HostName fails off-LAN and reads as "host is down"

`macmini-hermes` → `Derreks-Mac-mini.local` is **Bonjour/mDNS, LAN-only**. Off-network it produced `could not resolve hostname`, and I wrote **"MINI IS DOWN, cap-5 lane gone"** into a run handoff. The box had been up **21 days**. A documented `192.168.x` fallback is equally useless off-network — its presence in a config comment is false reassurance.

**Already fixed on this machine** (`HostName` → `100.116.5.7`, Tailscale; routes direct when local, so no on-LAN cost; backup at `~/.ssh/config.bak-*`). Harness-side work:

- `preflight` checks `tailscale status` before declaring any Mac host down, and **warns on any `.local` HostName** in a configured host's ssh alias.
- Knock-on to document: `pull-host` fails for the same reason, so a run's telemetry silently reads as a floor.

### 6.2 — `known_hosts` verification procedure

`REMOTE HOST IDENTIFICATION HAS CHANGED` on a Tailscale IP is usually a stale entry from a previous holder — **but prove it.** Verify by matching the presented fingerprint against the same host's key recorded under *other* names (`.local` **and** LAN IP = two independent attestations). Mine matched exactly; the stale entry was a genuinely different host. **The two fingerprints diverged only after the first character (`9W…` vs `9S…`)** — an eyeball comparison would have passed a MITM. Document; never auto-`ssh-keygen -R`.

### 6.3 — Memory/swap guard before dispatch

Local swap hit **7,257 MB / 8,192 MB (88.6%)** — the documented freeze zone that once pinned orch+shepherd at 0% CPU for ~40 min. I declined a local db-lane dispatch on this basis. Make it mechanical: `preflight` and every dispatch **refuse** a local heavy-lane lead above a swap threshold, instead of relying on an orchestrator to check.

---

## Suggested sequencing

| Order | Items | Why first |
|---|---|---|
| **1** | **Phase 0** | Everything else is unverifiable until installs agree. |
| **2** | 2.1, 2.2 | Both make an agent *blind while reporting healthy*. 2.2 is live guidance that silently kills a watcher. |
| **3** | 1.1–1.5 | Codex is dead until **Aug 4** — posture C is the operating mode *right now*. |
| **4** | 4.3, 5.1 | 4.3 blocks run closure today; 5.1 makes every future comparison honest. |
| **5** | 3.1–3.3, 4.1–4.2 | Coordination correctness; compounding but not blocking. |
| **6** | 2.3–2.7, 4.4–4.5, 5.2–5.3, 6.1–6.3 | Hardening. |

## Standing rules for whoever implements this

- **Every fix needs a control that produces the failing answer.** This is the dominant defect class across two consecutive shifts; a fix verified only by "it didn't complain" reproduces it.
- **Harness defects go as comments on DER-2668**, not new Linear issues — *unless* the defect makes an instrument lie toward a destructive action or destroys state, which gets its own Urgent issue. Filed this run: the codex shim (2.1) and the completion deadlock (4.3).
- **Never route around a guard.** The two places the harness refused me (`reap`, `complete-run`) were both right to refuse; the deadlock is a *reconciliation* bug, not a reason for `--force`.
