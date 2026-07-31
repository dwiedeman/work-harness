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

## [Unreleased]

The 2026-07-30 cold-eyes remediation wave: nine fixes against the 21 findings of a cold-eyes review of
`2c3ecbe`, closing the gaps 0.2.0 shipped with, plus this entry itself (DER-2780), which corrects four
places this file and its neighbors described those gaps as still open after they were closed.

**A SECOND cold-eyes review, of `fbb8631`, ran the same day and its fixes land in this same section** —
DER-2836 (P0), DER-2837, DER-2838, DER-2839 so far. They are listed below alongside the first wave's,
which is why the entry count under `### Security` exceeds the nine named above. Recording it because the
paragraph above was written when this section held one wave, and a reader counting entries against it
would otherwise conclude the file had drifted.

### Security

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
  `trustedPrAuthors` login **and** its head repository owner matches the target repo (a fork never does);
  an unresolvable SHA now fails closed rather than open. `trustedPrAuthors` is deliberately a separate
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
  was closed by DER-2778 (`[Unreleased]`, above).
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
