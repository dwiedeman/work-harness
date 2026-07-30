# Changelog

All notable changes to the work harness. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are [semantic](https://semver.org/spec/v2.0.0.html). The single source of truth for the current
version is the `VERSION` file at the repo root — `repo-contract.test.mjs` fails if this file has no
section for it.

## Why a version at all

Multiple hosts run copies of this harness (local, an ssh host, cloud sessions), each installed at a
different time by `install.sh`. Before 0.2.0 there was no recorded version anywhere, so two hosts could
run materially different harness code against **one shared ledger** with no way to detect the skew.
Recording the version in `run_started` + host heartbeats — and refusing or degrading a mixed-protocol
run — is tracked as part of the ledger-protocol work (DER-2748) and is deliberately NOT in this entry.

## [0.2.0] — 2026-07-29

The "world-class harness" fix run: a cold-eyes review of `2c3ecbe` produced 21 code-grounded findings.
Each fix below landed with a regression test that was **observed failing on the pre-fix code first**.

### Security

- **DER-2737 — unauthenticated PR comments are no longer privileged lifecycle input.** `parsePrEventComments`
  and the handoff-note reader folded any `WORK-EVENT`/`WORK-HANDOFF`-prefixed comment on any open PR into
  the ledger with no author check, which allowed a phantom/retargeted unit, an injected `worktree` that
  reached an **unquoted** `ssh` string in `reap`, and a forged predecessor handoff note presented to a
  successor lead as testimony. Comment authors are now allowlisted (repo owner + known bots), comment
  payloads may not carry `worktree`/`branch`/`host`, `pr`/`host`/`actor` are stamped by the reader rather
  than read from the body, the run-scope filter applies to the singular `issue` as well as `issues[]`, and
  both `reap` interpolations are `shellQuote`d.
- **#19 — evidence queries are validated read-only before a shell runs them.** `prep-runner`'s
  `query-check` passed `evidenceQueries[].query` to `spawnSync(…, {shell: true})` behind only a *shape*
  check, and a plan is often assembled from issue text and lead output — so plan content could execute
  anything in the repo root. Validated now by an allowlist over a parsed query (not a metacharacter
  blocklist, because pipelines are the feature), applied both in `validate` and immediately before the
  `spawnSync`. Unrecognised is refused rather than run.
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
  a foreign schema is not), and the skew shows in `state.protocol` and on every `watch` wake. Residual
  gap: `install.sh` does not copy `VERSION` to `$CLAUDE_HOME`, so a host running from an install rather
  than a checkout reports `harness_version: "unknown"` unless `WORK_HARNESS_VERSION` is set — two such
  hosts look same-version to each other.

## [0.1.0] — 2026-07-29

Initial import of the harness as a public, shareable repo: `skills/work` (orchestrator + `work-runner.mjs`),
`skills/work-lead`, `skills/work-shepherd`, `skills/prep-for-work` (+ its four grounding gates),
`hooks/context-wrap-nudge.mjs`, and `install.sh`. Repo-specific identity moved out of the runner and into
`.claude/work.config.json` (see `skills/work/work.config.example.json`), which is what made the harness
installable by anyone other than its author.
