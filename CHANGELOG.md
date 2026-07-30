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

### Fixed

- **DER-2743 — `install.sh`'s self-test can now fail the install.** Both verification lines ended in
  `|| true`, which nullifies `set -o pipefail`: a red suite, a missing `node`, or a broken test file all
  still exited 0 while the script printed "Verifying (the harness tests itself)". The installer captures
  each suite's real exit status, names the suite that failed, and exits nonzero.

### Added

- **DER-2751 — release engineering.** A CI workflow (`.github/workflows/ci.yml`) that runs the runner,
  metrics, prep, installer-contract and repo-contract suites on Node 20/22/24, plus `node --check`,
  `bash -n`, ShellCheck (`--severity=error`), and a named public-comment security-regression job that
  **fails when zero DER-2737 controls match** rather than passing on an empty pattern. Adds `VERSION`,
  this changelog, `install.test.mjs`, `repo-contract.test.mjs`, and `.github/REPO-SETUP.md` (the
  branch-protection settings, as a one-paste `gh api` call).

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
