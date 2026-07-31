# Harness upgrade — implementation status

**Implementer:** orchestrator session, 2026-07-31, on the mini (`/Users/macbook/Projects/work-harness`).
**Authority:** `docs/plans/2026-07-31-harness-upgrades.md` (22 items, 7 phases, authored at `aed5abc`).
**Rule followed:** every finding re-verified against synced code *before* implementing (plan P0.2). A
finding that no longer reproduces gets a note here, not an implementation.

---

## Phase 0 — sync (COMPLETE)

### P0.1 — done

`git pull --ff-only` → already up to date at `aed5abc`. `./install.sh` → green.

Gate evidence (the printed suite results, not the exit code):

```
# tests 514 / # pass 514 / # fail 0   skills/work — work-runner + work-metrics + session-end-telemetry
# tests 95  / # pass 95  / # fail 0   skills/prep-for-work — prep-runner.test.mjs
# tests 11  / # pass 11  / # fail 0   hooks — context-wrap-nudge.test.mjs
```

**620 tests, 0 failures.** Post-install drift re-measured: **0 files differ.**

### The drift the plan predicted — reproduced fresh on THIS host

The plan warned its drift table was measured on the MacBook and that this host must be measured
fresh. It was, *before* installing. Seven files differed at an **identical `VERSION = 0.2.0`**:

| File | Repo | Installed | Δ |
|---|---:|---:|---|
| `skills/work/work-runner.mjs` | 604,211 | 566,449 | **+37,762** |
| `skills/work/work-runner.test.mjs` | 590,057 | 538,000 | +52,057 |
| `skills/prep-for-work/prep-runner.mjs` | 141,139 | 130,280 | +10,859 |
| `skills/prep-for-work/prep-runner.test.mjs` | 103,497 | 91,213 | +12,284 |
| `skills/work/SKILL.md` | 107,548 | 103,215 | +4,333 |
| `skills/prep-for-work/SKILL.md` | 37,389 | 35,697 | +1,692 |
| `skills/work/work.config.example.json` | 8,774 | 8,507 | +267 |

`~/.claude/skills` confirmed **not a git repo** (no `.git`). This is the independent second
observation of the P0.3 defect class — two hosts, same version string, different code — and it is why
P0.3 is implemented rather than taken on faith.

---

## P0.2 — re-verification results (BLOCKING GATE, COMPLETE)

All 22 items checked against `aed5abc`. Verdicts:

| Item | Verdict | Note |
|---|---|---|
| P0.3 | REPRODUCES | no manifest/digest in `install.sh`; `preflight` compares version strings only; no `HARNESS DRIFT` string exists; no version-bump CI check |
| 1.1 | REPRODUCES | zero occurrences of `review-swap`; `review-usage` accepts only a codex-`--log` payload or a token-usage envelope |
| 1.2 | REPRODUCES | no posture-C procedure in `work-shepherd/SKILL.md` |
| 1.3 | REPRODUCES | zero occurrences of `waive-codex-gate`/`codex_gate_waived`; the hold is unconditional at `work-runner.mjs:1565` |
| 1.4 | REPRODUCES *(plan detail corrected)* | `gate_seen` is a boolean. **Correction:** the plan says `ready`/`budget`/`work-metrics` read it; they do not. Only the `state.gate_missing` fold and the `watch` wake payload consume it. `gate_engine` exists but is dead code — no producer ever writes `engine`. |
| **1.5** | **ALREADY-FIXED — struck** | verified personally, not taken on report. See below. |
| 2.1 | REPRODUCES *(root cause differs on this host — see below)* | |
| 2.2 | REPRODUCES | zero `process.on(` traps in `work-runner.mjs`; the background-`watch` + `caffeinate -w` pattern is still prescribed at `work/SKILL.md:177` and `work-shepherd/SKILL.md:22` |
| 2.3 | REPRODUCES | zero occurrences of `pmset`/`battery`/`clamshell`/`host_sleep_detected` |
| 2.4 | REPRODUCES | `--sha` accepts any string; no length check before `reviewFindingsEvent` |
| 2.5 | PARTIAL *(plan claim corrected)* | silent-defaults defect is real (`getHosts()` → `{local:{cap:2}}` on a bare import, no throw). **But the plan's claim that `applyRepoConfig(cfg)` "does not fix it" is wrong** — awaited against a real repo root it correctly updates all three getters. The live risk is an ad-hoc `node -e` that never calls it. |
| 2.6 | REPRODUCES | `computeEligible` does `issue.fileScope ?? []` and never refuses; `prep-runner.mjs` has zero `fileScope` occurrences (emits `surfaces`/`versionAxes`); `init-run` never persists one |
| 2.7 | REPRODUCES | no `staleness-check` subcommand; zero `git log -S` occurrences |
| 3.1 | REPRODUCES | `cmux-say.sh` has no `--ledger-ref`; zero `msg_ack`/`unacked_messages` |
| 3.2 | REPRODUCES | no `claim`/lease subcommand; wake payload carries no per-issue notes |
| 3.3 | REPRODUCES | no verdict-first contract in any reviewer prompt; current guidance at `work/SKILL.md:184` is respawn-don't-repoke with no silent-vs-wedged split |
| 4.1 | REPRODUCES | `rotate-shepherd` is listed in `VERSION_GATED_SUBCOMMANDS` but has **no `case`** — it falls to `unknown subcommand` |
| 4.2 | REPRODUCES | actor is a hardcoded role literal (`actor: "orch"`); `by_role` collapses every shepherd instance into one bucket |
| **4.3** | **REPRODUCES — confirmed personally** | see below |
| 4.4 | REPRODUCES | zero `retracted_by`/`retract` occurrences; `it.reap_failed = true` is never cleared by any event |
| 4.5 | PARTIAL | the `reason` field already splits survivor/unknown via `KILL_PROBE_NOTES`. The **always-shown** `act` guidance and CLI banner do not — both render every leak as confirmed-alive. |
| 5.1 | REPRODUCES | single blended `kickbackCount / mergedPrs.length`; no coverage fetch; no Gate-coverage column. *(median+p90 already reported separately — that half is fine)* |
| 5.2 | REPRODUCES | `work-metrics.mjs` never reads `review_findings` at all |
| 5.3 | PARTIAL | unpriced-spend `FLOOR ONLY` flagging already exists; structural-gap flagging (dropped telemetry, undrained hosts) does not |
| 6.1 | REPRODUCES | zero `tailscale`/`.local` occurrences in `work-runner.mjs` |
| 6.2 | REPRODUCES | zero `known_hosts`/`fingerprint`/`ssh-keygen` occurrences across `skills/`, `README.md`, `SECURITY.md` |
| 6.3 | PARTIAL | prose-only guidance at `work/SKILL.md:19`; zero `swap`/`sysctl`/`vm_stat` occurrences in code — no mechanical refusal anywhere |

### 1.5 — STRUCK, does not reproduce

The plan says `review-fidelity --pr` "returns nothing and reads as `preempt_rate: 0%`". It does not.
Verified by reading the code directly:

- `work-runner.mjs:7288` — the empty-cloud branch returns
  `PR #<n> — NOT SCOREABLE: the bot NEVER REVIEWED the tree the gate covered …` and returns an object
  with **no `event` key**, so `appendEvent` is never reached. Nothing is recorded.
- `work-runner.mjs:1705` — `preempt_rate: cloud.length ? … : null`, with the comment
  *"Null on an empty cloud review — 0/0 is not a 0% hit rate."*
- `work-metrics.mjs` has zero references to `preempt_rate`/`review_fidelity` — there is no propagation
  path to fix.

`git log -S "NOT SCOREABLE"` shows this protection is original, not a recent fix. The only divergence
from the plan is cosmetic: the marker reads `NOT SCOREABLE`, not the literal `UNMEASURABLE`. The
harmful behavior — a fake 0% reading as a real number — cannot occur. **No implementation.**

### 2.1 — reproduces, but the plan's prescribed fix would BREAK this host

The plan prescribes: *"Resolve the real binary explicitly (`~/bin/codex`), never bare `codex`."*
Measured on this host:

- `which -a codex` → `/Users/macbook/.local/node/bin/codex`, a symlink into
  `@openai/codex/bin/codex.js`. **That is the real CLI, not a shim.**
- **`~/bin/codex` does not exist here.** Hardcoding it, as written, would break every codex call on
  this machine.
- A cmux shim dir *does* exist (`/var/folders/…/cmux-cli-shims/`, 6 session dirs) but **this
  generation of shim never invokes `timeout`** — it `exec`s `cmux-codex-wrapper`, or strips the shim
  dir out of `PATH` and `exec`s the real `codex`. The plan's specific root cause (`timeout` missing on
  macOS) is not reproducible against the shims on this box.

Independent audit of the plan's *"never use bare `timeout` anywhere"* instruction: **zero bare
`timeout N` invocations** exist in `skills/**`, `hooks/**`, or `install.sh`. The only hits are the
harness's own `--timeout <seconds>` CLI flag. That sub-item is already clean.

What *does* still reproduce, and is the durable defect:

- `work-runner.mjs:938` and `work-runner.mjs:8300` both invoke **bare `codex`**, so whatever `PATH`
  hands them wins — shim or not.
- `work-runner.mjs:8300`'s probe fails **RED on empty output**:
  `add("codex-probe", out.includes("turn.completed") || /\bOK\b/.test(out), …)`. The adjacent
  `claude-probe` at `:8290` explicitly treats empty output as *"UNKNOWN, not dead"*; the codex probe
  has no such branch. **An absent verdict is rendered as a failing verdict** — the exact
  `REMOTE_PATH_PRELUDE` false-RED shape the plan cites.

**Implemented instead:** a `resolveCodexBin()` that honors `WORK_CODEX_BIN`, walks `which -a codex`
skipping any `cmux-cli-shims` path, and falls back to `~/bin/codex` only if it exists — satisfying
"never bare, never a shim" without hardcoding a path this host does not have. Plus the empty-output
⇒ `UNKNOWN` fix, which is the half that actually cost the run 40 minutes.

### 4.3 — confirmed personally (the deadlock is real and unconditional)

- `work-runner.mjs:5110` — `const trackedIds = [...new Set([...Object.keys(issues), ...queue])]`
  — queue-only ids are tracked.
- `work-runner.mjs:5121` — `nonTerminal` filters on `issues[id]?.status ?? "queued"`, so a
  never-dispatched id is permanently non-terminal, and the remedy text prescribes
  `reap --run <r> <id> closes a queued/merged unit`.
- `work-runner.mjs:5661` — `reapRefusal` returns `not a unit in run … --abandon does NOT override
  this` when `!unit`, and `state.issues` entries are only created by `ensure(id)` when an event names
  the id. **A queue-only id has no `issues` entry, so `reap` refuses exactly what `complete-run`
  prescribes.** The `!unit` branch returns before `abandon` is even consulted.
- Divergence root confirmed at `work-runner.mjs:4845` — `neverStarted` is derived from
  `run_started.issues` minus `Object.keys(issues)`.

No `never_started` flag exists anywhere. The plan's preferred fix is implemented; no events were
hand-appended to the stuck run.
