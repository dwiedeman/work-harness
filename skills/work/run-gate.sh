#!/bin/bash
# run-gate.sh — the pre-PR review gate launcher.
#
# ── Why this file exists ──────────────────────────────────────────────────────────────────────────
# Until 2026-08-12 there was no launcher in the harness. Each orchestrator hand-wrote a `run-panel.sh`
# per run, and the SAME three defects recurred across seven documented sessions — each one written down
# after each occurrence, and each one re-introduced by the next hand-rolled copy:
#
#   1. Completeness counted by FILE EXISTENCE. `> "$D/$L.out.json"` creates the file EMPTY before the
#      agent runs, so `ls … | wc -l` reports 3-of-3 against a real roster of 2-of-3. Measured live three
#      times (two 0-byte lens outputs, one 0-byte output beside a 6,698-byte prompt).
#   2. The head was never re-read. The lens's own `git rev-parse HEAD` runs in a detached clone whose
#      `origin` is a LOCAL PATH — it cannot observe a push, so it is a check that cannot fail. Six
#      verdicts shipped stale; on #1292 r2 the author pushed 102 seconds into a $6.11 review, touching
#      the exact file under review.
#   3. The brief asserted "three lenses are reviewing independently" when one ran. Undetectable from
#      inside a lens.
#
# A rule that lives only in prose has gone 0-for-7 here. A rule that lives in the brief has gone 8-for-8.
# This script is the third channel: the launcher itself.
#
# ── Policy (2026-08-12) ───────────────────────────────────────────────────────────────────────────
# The gate is `codex exec` on a pinned model at pinned effort. The 3-lens Claude panel is the FALLBACK,
# run only when codex is unavailable. This script enforces that ordering rather than trusting a lead to:
# it runs codex first, and it refuses to spend the panel's ~36 minutes and ~$17 unless codex could not
# deliver a verdict (or --force-panel is passed explicitly).
#
# Usage:
#   run-gate.sh --pr 1293 --repo owner/name --sha <40-char> --tree /path/to/worktree \
#               [--round 1] [--issue DER-3487] [--runner /path/to/work-runner.mjs] \
#               [--lenses "correctness security repro"] [--force-panel] [--panel-model claude-opus-5] \
#               [--contract /path/to/contract.md] [--tests "<vitest file args>"]
#
# ── Scope + test-evidence additions (2026-08-15, U4 post-mortem) ─────────────────────────────────
#   --contract FILE  appends the unit's frozen contract/scope block (in_scope, known_dependent_units,
#                    ship_blocking_rule) to the codex prompt. Measured on #1314: 2 of 3 gate rounds
#                    were spent on out-of-contract findings (a naming dispute r2; an already-planned
#                    dependent unit's file r3). The scope block is generated from the unit's contract
#                    table, never hand-written per round.
#   --tests "FILES"  pre-runs the named Vitest suites in the tree (normal permissions, OUTSIDE the
#                    review sandbox) and attaches the tail of the output — bound to the reviewed sha —
#                    to the prompt. The read-only sandbox EPERMs Vitest's temp-dir creation, so every
#                    U4 round fell back to ad-hoc probes and hunted a fresh counterexample family.
#                    The reviewer is told the suites already ran and must verify by reading +
#                    targeted probes, not by re-running Vitest.
#   TMPDIR is also pointed at gate scratch for the codex leg — harmless if the sandbox still blocks
#   it, sufficient if the profile honors it.
#
# ── Why the receipt names its own scope (2026-08-19, DER-4055) ───────────────────────────────────
# The two flags above were written on 2026-08-15 and lived only in ~/.claude — never committed here —
# so the first `install.sh` of 2026-08-18 copied the pre-W0 file back over them. Rounds on #1353,
# #1354 and #1356 then ran with NO scope contract for a full day. Nothing exposed it: an unscoped
# round exits 0 and returns a well-formed, high-confidence findings payload that is byte-shaped
# exactly like a scoped one, and one of its P1s was a scoping the diff itself disclosed.
# `gate-verdict.json` therefore records `scope_contract` (applied|absent) and `test_evidence`
# (attached-exit<N>|skipped-wrong-sha|absent). The receipt now answers "was this round briefed?",
# which no surface could answer before. The controls for both flags live in run-gate.test.mjs, so
# the same revert reddens in CI instead of going a day unnoticed.
#
# Exit codes: 0 = a verdict was produced and validated · 1 = usage/setup error · 2 = the gate did not
# produce a usable verdict (walled, dead, or stale) — NEVER silently 0. A gate that dies exits 0 is the
# failure this whole file is written against.

set -uo pipefail

# ── args ──────────────────────────────────────────────────────────────────────────────────────────
PR=""; REPO=""; SHA=""; TREE=""; ROUND="1"; ISSUE=""; RUNNER=""; CONTRACT=""; TESTS=""
SCOPED="absent"; TEST_EVIDENCE="absent"
LENSES="correctness security repro"; FORCE_PANEL=0; PANEL_MODEL="claude-opus-5"
CODEX_MODEL="${WORK_CODEX_MODEL:-gpt-5.6-sol}"; CODEX_EFFORT="${WORK_CODEX_EFFORT:-high}"

while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --sha) SHA="$2"; shift 2 ;;
    --tree) TREE="$2"; shift 2 ;;
    --round) ROUND="$2"; shift 2 ;;
    --issue) ISSUE="$2"; shift 2 ;;
    --runner) RUNNER="$2"; shift 2 ;;
    --lenses) LENSES="$2"; shift 2 ;;
    --panel-model) PANEL_MODEL="$2"; shift 2 ;;
    --contract) CONTRACT="$2"; shift 2 ;;
    --tests) TESTS="$2"; shift 2 ;;
    --force-panel) FORCE_PANEL=1; shift ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "run-gate: unknown argument $1" >&2; exit 1 ;;
  esac
done

# Written out rather than looped over ${!var} / ${var,,}: `${var,,}` is bash 4.0+, and macOS ships
# bash 3.2 as /bin/bash. CI runs ubuntu (bash 5), so the incompatible form would have passed CI and
# failed only on the operator's own box — the worst place to discover it.
[ -n "$PR" ]   || { echo "run-gate: --pr is required" >&2; exit 1; }
[ -n "$REPO" ] || { echo "run-gate: --repo is required (owner/name)" >&2; exit 1; }
[ -n "$SHA" ]  || { echo "run-gate: --sha is required" >&2; exit 1; }
[ -n "$TREE" ] || { echo "run-gate: --tree is required" >&2; exit 1; }

# A 40-char sha, enforced here rather than at record time. Measured on #1180: a short sha reads
# `stale-clean` at every downstream check, so a blocker-carrying gate recorded short blocks on FALSE
# staleness — and an operator who learns to distrust "stale" is one who waves past a real one.
case "$SHA" in
  ????????????????????????????????????????) : ;;
  *) echo "run-gate: --sha must be the full 40-char sha (got ${#SHA} chars). \`gh pr view --json headRefOid\` returns 40." >&2; exit 1 ;;
esac

[ -d "$TREE" ] || { echo "run-gate: --tree $TREE does not exist" >&2; exit 1; }

# Per-ROUND scratch, not per-lens. Measured: 15 files matching one lens's own `__zzz_security_*`
# convention in /tmp belonged to a DIFFERENT PR's lens, resolvable only by reading mtimes. Both failure
# directions are silent — cite a sibling's artifact as your evidence, or `rm` a live sibling's files.
#
# WORK_GATE_SCRATCH overrides the location. Two reasons it exists: two gates on the SAME pr+round (a
# re-run, or a shepherd and an orchestrator racing) would otherwise share one directory and the second
# `rm -rf` would delete the first's evidence mid-flight; and a fixed absolute path makes the script
# untestable in parallel, which is how its first CI run failed.
D="${WORK_GATE_SCRATCH:-/tmp/rost-gate-pr${PR}r${ROUND}}"
rm -rf "$D"; mkdir -p "$D" || exit 1

# The tree name lies: lens trees were POOLED across PRs, so a review of #1292 ran in `shep-1283-*`.
# Every later archaeology then re-derives which PR a transcript belongs to, and a MIS-TARGETED tree
# would be invisible. Drop the identity in the tree itself.
cat > "$TREE/REVIEW-TARGET" <<EOF
pr=$PR
repo=$REPO
reviewed_sha=$SHA
round=$ROUND
issue=$ISSUE
started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$D/driver.log"; }

# ── the head re-bind ──────────────────────────────────────────────────────────────────────────────
# THE check the lens cannot perform. Reads GitHub, not the local clone, so it can actually return the
# failing answer. Called at gate start AND before any verdict is accepted.
current_head() {
  gh -R "$REPO" pr view "$PR" --json headRefOid --jq .headRefOid 2>/dev/null
}

HEAD_AT_START="$(current_head)"
if [ -z "$HEAD_AT_START" ]; then
  log "HEAD_READ_FAILED — could not read headRefOid for $REPO#$PR. A head that cannot be read is UNKNOWN, not unchanged."
  exit 2
fi
if [ "$HEAD_AT_START" != "$SHA" ]; then
  log "STALE_AT_START reviewed=$SHA head=$HEAD_AT_START — refusing to start a gate on a sha that is already not the head."
  printf '{"verdict":"stale","reviewed":"%s","head":"%s","phase":"start"}\n' "$SHA" "$HEAD_AT_START" > "$D/gate-verdict.json"
  exit 2
fi
log "HEAD_BOUND $SHA"

# ── codex leg — the gate ──────────────────────────────────────────────────────────────────────────
# Resolve the binary rather than shelling a bare `codex`. A cmux shim ahead of it on PATH hangs at 0%
# CPU byte-identically to a quota wall, so "the only codex on PATH is a shim" is UNKNOWN, not down.
resolve_codex() {
  if [ -n "${WORK_CODEX_BIN:-}" ]; then [ -x "$WORK_CODEX_BIN" ] && { echo "$WORK_CODEX_BIN"; return 0; }; return 1; fi
  local dir cand
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    cand="${dir%/}/codex"
    [ -x "$cand" ] || continue
    case "$cand" in *cmux-cli-shims*|*/shims/*) continue ;; esac
    echo "$cand"; return 0
  done < <(echo "$PATH" | tr ':' '\n')
  [ -x "$HOME/bin/codex" ] && { echo "$HOME/bin/codex"; return 0; }
  return 1
}

CODEX_BIN="$(resolve_codex || true)"
CODEX_OK=0

if [ -z "$CODEX_BIN" ]; then
  log "CODEX_UNRESOLVED — no real codex binary (a shim does not count). Falling back to the panel."
else
  log "CODEX_BIN=$CODEX_BIN model=$CODEX_MODEL effort=$CODEX_EFFORT"
  if [ -n "$RUNNER" ] && [ -n "$ISSUE" ]; then
    (cd "$TREE" && git diff origin/main...HEAD > "$D/diff" 2>/dev/null) || true
    node "$RUNNER" panel-prompt --issue "$ISSUE" --lens codex --diff "$D/diff" > "$D/codex.prompt.md" 2>"$D/codex.prompt.err" || true
  fi
  if [ ! -s "$D/codex.prompt.md" ]; then
    log "CODEX_PROMPT_MISSING — panel-prompt produced nothing (need --runner and --issue). Falling back to the panel."
  else
    # ── contract/scope block (2026-08-15). Appended AFTER prompt generation so the runner's prompt
    # stays canonical and the scope block is visibly last-word. A named-but-missing contract file is
    # a hard error, not a silent unscoped review — an unscoped round costs a full remediation cycle.
    if [ -n "$CONTRACT" ]; then
      if [ ! -s "$CONTRACT" ]; then
        log "CONTRACT_MISSING — --contract $CONTRACT is empty or absent. Refusing an unscoped gate."
        exit 1
      fi
      {
        printf '\n\n## Review scope contract (binding — generated from the unit contract table)\n\n'
        cat "$CONTRACT"
        printf '\n\nship_blocking_rule: a P1 must demonstrate either (a) a regression introduced by THIS diff, or (b) a violated acceptance criterion of THIS unit'"'"'s contract table above. A finding in an untouched file already assigned to a listed known_dependent_unit is reported as "planned follow-up" severity P2, not P1 — unless this diff worsens it or falsely claims to fix it. Findings outside in_scope are still reported, at the severity the rule assigns.\n'
      } >> "$D/codex.prompt.md"
      SCOPED="applied"
      log "CONTRACT_APPENDED $(wc -c < "$CONTRACT")B from $CONTRACT"
    else
      log "CONTRACT_ABSENT — no --contract given. This round carries NO in_scope / known_dependent_units / ship_blocking_rule, so out-of-contract findings will arrive as P1. Intended only for units with no frozen contract table."
    fi
    # ── pre-sandbox test evidence (2026-08-15). The read-only sandbox EPERMs Vitest; run the unit's
    # named suites OUTSIDE it, at the reviewed sha, and attach the result. Runs from repo-root config
    # (package-local vitest configs are not CI-parity). Failure of the suite is attached verbatim —
    # a red suite is exactly what the reviewer must see.
    if [ -n "$TESTS" ]; then
      TREE_SHA="$(cd "$TREE" && git rev-parse HEAD 2>/dev/null)"
      if [ "$TREE_SHA" != "$SHA" ]; then
        log "TESTS_SKIPPED — tree HEAD $TREE_SHA != reviewed sha $SHA; refusing to attach evidence from the wrong code."
        TEST_EVIDENCE="skipped-wrong-sha"
      else
        log "TESTS_START files=[$TESTS]"
        ( cd "$TREE" && pnpm exec vitest run --config vitest.config.fast.ts $TESTS ) \
          > "$D/tests.out" 2>&1
        TESTS_EXIT=$?
        log "TESTS_DONE exit=$TESTS_EXIT bytes=$(wc -c < "$D/tests.out" 2>/dev/null || echo 0)"
        TEST_EVIDENCE="attached-exit${TESTS_EXIT}"
        {
          printf '\n\n## Executed test evidence (run by the gate at reviewed sha %s, exit=%s)\n\n' "$SHA" "$TESTS_EXIT"
          printf 'The review sandbox cannot run Vitest (temp-dir EPERM). These suites were executed outside it, at the exact reviewed head. Do NOT attempt to run Vitest; verify claims by reading code and by targeted node probes. Last 80 lines:\n\n```\n'
          tail -80 "$D/tests.out"
          printf '\n```\n'
        } >> "$D/codex.prompt.md"
      fi
    fi
    SCHEMA="$(dirname "$0")/codex-review-schema.json"
    mkdir -p "$D/tmp"
    log "CODEX_START"
    ( cd "$TREE" && TMPDIR="$D/tmp" "$CODEX_BIN" exec --json --sandbox read-only \
        -m "$CODEX_MODEL" -c model_reasoning_effort="$CODEX_EFFORT" \
        --output-schema "$SCHEMA" --output-last-message "$D/codex.json" \
        - < "$D/codex.prompt.md" > "$D/codex.jsonl" 2> "$D/codex.err" )
    # Exit code is NOT the discriminator: a dead codex run exits 0. The producer event is.
    TURNS="$(grep -c '"type":"turn.completed"' "$D/codex.jsonl" 2>/dev/null || echo 0)"
    CMDS="$(grep -c 'command_execution' "$D/codex.jsonl" 2>/dev/null || echo 0)"
    log "CODEX_DONE turn_completed=$TURNS command_execution=$CMDS bytes=$(wc -c < "$D/codex.jsonl" 2>/dev/null || echo 0)"
    if [ "$TURNS" -ge 1 ] && [ -s "$D/codex.json" ]; then
      CODEX_OK=1
      log "CODEX_VERDICT_OK — record it with: $RUNNER review-usage --issue $ISSUE --round $ROUND --sha $SHA --file $D/codex.json --log $D/codex.jsonl"
      log "NOTE the recorder applies the DIRECTIONAL false-green rule: a clean verdict from a sandbox-denied run is refused; the same denial WITH findings is valid."
    else
      log "CODEX_DEAD — no turn.completed. This is a wall, a 401, or a kill; it is NOT a clean PR. Falling back to the panel."
    fi
  fi
fi

if [ "$CODEX_OK" -eq 1 ] && [ "$FORCE_PANEL" -eq 0 ]; then
  HEAD_AT_END="$(current_head)"
  if [ "$HEAD_AT_END" != "$SHA" ]; then
    log "STALE_AT_END reviewed=$SHA head=$HEAD_AT_END — the author pushed during the gate. The verdict does NOT cover the head."
    printf '{"verdict":"stale","reviewed":"%s","head":"%s","phase":"end","gate":"codex"}\n' "$SHA" "$HEAD_AT_END" > "$D/gate-verdict.json"
    exit 2
  fi
  printf '{"verdict":"ok","gate":"codex","reviewed":"%s","round":%s,"model":"%s","effort":"%s","scope_contract":"%s","test_evidence":"%s","artifacts":"%s"}\n' \
    "$SHA" "$ROUND" "$CODEX_MODEL" "$CODEX_EFFORT" "$SCOPED" "$TEST_EVIDENCE" "$D" > "$D/gate-verdict.json"
  log "GATE=codex OK. Panel NOT run (that is the point — it costs ~36 min and ~\$17 for breadth, not depth)."
  exit 0
fi

# ── panel fallback ────────────────────────────────────────────────────────────────────────────────
log "PANEL_FALLBACK lenses=[$LENSES] model=$PANEL_MODEL"
if [ -z "$RUNNER" ] || [ -z "$ISSUE" ]; then
  log "PANEL_CANNOT_RUN — the panel needs --runner and --issue to render its prompts."
  exit 2
fi

# The manifest is written from the lenses actually STARTED, and the brief interpolates it. A lens told
# "two other lenses are reviewing independently" when one ran cannot detect the lie from inside, and a
# single-lens round must be told it is covering all three lenses' ground.
STARTED=""

memgate() {
  # Prints `clear` or `TIMEOUT` FROM THE LOOP'S EXIT CONDITION. The prior version printed "clear"
  # unconditionally after the loop, so a reader of driver.log could not tell "gate satisfied" from
  # "gate gave up after 15 minutes" — and the `||` let a lens start at 54MB free RAM on swap headroom.
  #
  # WORK_GATE_MEMGATE_TRIES=0 disables the wait entirely. This exists because the gate is otherwise
  # untestable: on a box that is already memory-starved, the default is a 15-MINUTE silent block PER
  # LENS, and the first control set written against this script hung for 45 minutes before anyone saw
  # a single assertion. A knob a test can turn is also a knob an operator can turn when they know the
  # box is busy and want the panel to start anyway.
  local lens="$1" g=0 freemb swapfree
  local tries="${WORK_GATE_MEMGATE_TRIES:-90}"
  if [ "$tries" -eq 0 ]; then log "MEMGATE $lens SKIPPED (WORK_GATE_MEMGATE_TRIES=0)"; return 0; fi
  while [ "$g" -lt "$tries" ]; do
    freemb=$(( $(vm_stat 2>/dev/null | awk '/Pages free/ {gsub("\\.","",$3); print $3+0}') * 4096 / 1048576 ))
    swapfree=$(sysctl -n vm.swapusage 2>/dev/null | awk '{gsub("M","",$9); print $9+0}')
    if [ "${freemb:-0}" -ge 250 ] && [ "${swapfree:-0}" -ge 900 ]; then
      log "MEMGATE $lens clear freeRAM=${freemb}MB swapfree=${swapfree}MB"
      return 0
    fi
    g=$((g + 1)); sleep 10
  done
  log "MEMGATE $lens TIMEOUT freeRAM=${freemb:-?}MB swapfree=${swapfree:-?}MB — starting anyway, but this run is memory-starved and the verdict may be truncated."
  return 1
}

for L in $LENSES; do
  node "$RUNNER" panel-prompt --issue "$ISSUE" --lens "$L" --diff "$D/diff" > "$D/$L.prompt.md" 2>/dev/null || true
  if [ ! -s "$D/$L.prompt.md" ]; then log "LENS_SKIP $L — empty prompt"; continue; fi
  memgate "$L"
  log "LENS_START $L"
  STARTED="$STARTED $L"
  ( cd "$TREE" && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
      claude -p --output-format json --model "$PANEL_MODEL" --permission-mode bypassPermissions \
      < "$D/$L.prompt.md" > "$D/$L.out.json" 2> "$D/$L.err" )
  log "LENS_DONE $L bytes=$(wc -c < "$D/$L.out.json" 2>/dev/null || echo 0)"
done

printf '{"round":%s,"lenses_started":[%s]}\n' "$ROUND" \
  "$(echo "$STARTED" | tr -s ' ' '\n' | sed '/^$/d' | sed 's/.*/"&"/' | paste -sd, -)" > "$D/panel-manifest.json"

# ── completeness: NON-EMPTY and PARSEABLE, never a file count ─────────────────────────────────────
PROMPTS=0; OUTS_NONEMPTY=0; OUTS_PARSEABLE=0; OUTS_WALLED=0; MISSING=""
for L in $LENSES; do
  [ -s "$D/$L.prompt.md" ] && PROMPTS=$((PROMPTS + 1))
  out="$D/$L.out.json"
  if [ ! -s "$out" ]; then MISSING="$MISSING $L(empty)"; continue; fi
  OUTS_NONEMPTY=$((OUTS_NONEMPTY + 1))
  if ! jq -e '.result' "$out" >/dev/null 2>&1; then MISSING="$MISSING $L(unparseable)"; continue; fi
  OUTS_PARSEABLE=$((OUTS_PARSEABLE + 1))
  # The quota corpse: a limit-killed lens returns a WELL-FORMED envelope with top-level
  # subtype:"success". Only `is_error` and the BYTE COUNT separate it from a real verdict —
  # 833-1377 bytes measured, against 9-15 KB for a genuine one.
  if [ "$(jq -r '.is_error // false' "$out")" = "true" ]; then
    OUTS_WALLED=$((OUTS_WALLED + 1)); MISSING="$MISSING $L(is_error)"
  elif [ "$(wc -c < "$out")" -lt 2000 ]; then
    OUTS_WALLED=$((OUTS_WALLED + 1)); MISSING="$MISSING $L(suspiciously-small:$(wc -c < "$out")B)"
  fi
done
log "PROMPTS=$PROMPTS OUTS_NONEMPTY=$OUTS_NONEMPTY OUTS_PARSEABLE=$OUTS_PARSEABLE WALLED=$OUTS_WALLED MISSING=[${MISSING# }]"

HEAD_AT_END="$(current_head)"
if [ "$HEAD_AT_END" != "$SHA" ]; then
  log "STALE_AT_END reviewed=$SHA head=$HEAD_AT_END — the author pushed during the panel."
  printf '{"verdict":"stale","reviewed":"%s","head":"%s","phase":"end","gate":"panel"}\n' "$SHA" "$HEAD_AT_END" > "$D/gate-verdict.json"
  exit 2
fi

USABLE=$((OUTS_PARSEABLE - OUTS_WALLED))
if [ "$USABLE" -lt 2 ]; then
  log "PANEL_INCOMPLETE usable=$USABLE — a silent or walled lens is INCOMPLETE, never clean. Do NOT record this."
  printf '{"verdict":"incomplete","usable_lenses":%s,"missing":"%s"}\n' "$USABLE" "${MISSING# }" > "$D/gate-verdict.json"
  exit 2
fi
printf '{"verdict":"ok","gate":"panel","reviewed":"%s","round":%s,"usable_lenses":%s,"artifacts":"%s"}\n' \
  "$SHA" "$ROUND" "$USABLE" "$D" > "$D/gate-verdict.json"
log "GATE=panel OK usable=$USABLE. Record with review-panel --lens-file <lens>=<file> plus --codex-waived \"<why codex could not run>\"."
exit 0
