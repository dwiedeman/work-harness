#!/bin/zsh
# cmux-look.sh — read another workspace's pane WITHOUT silently reading your own.
#
# WHY THIS EXISTS (measured 2026-07-25, cost a false liveness call):
# `cmux capture-pane` has NO positional form. Its only selector is the `--workspace` FLAG:
#     Usage: cmux capture-pane [--workspace <id|ref|index>] [--surface …] [--window …] …
# So `cmux capture-pane workspace:411` does NOT error — the bare arg is IGNORED and the command
# falls back to its default, `$CMUX_WORKSPACE_ID`, i.e. THE PANE YOU ARE RUNNING IN. An orchestrator
# checking whether its shepherd was alive got back its own healthy pane and read it as the shepherd's.
#
# That failure is silent AND it fails toward FALSE CONFIDENCE — you get a plausible, healthy-looking
# pane while diagnosing somebody else's stall. (It reads as WEDGED just as easily if you happen to be
# blocked.) `cmux-say.sh` resolves a positional ref correctly, which is exactly why the inconsistency
# is so easy to walk into.
#
# Usage: cmux-look.sh <workspace-ref> [lines] [--scrollback]
#   e.g. cmux-look.sh workspace:411 40
#
# A SECOND silent-wrong-answer, found while testing the first: a ref that does not exist at all
# (`--workspace workspace:9999`) also returns EXIT 0 and a plausible, fully-rendered pane belonging to
# something else. So "it returned a pane" proves nothing about WHICH pane. This wrapper therefore
# validates the ref against `cmux workspace list` before capturing.
#
# Guarantees:
#   1. always passes --workspace (never a positional)
#   2. LOUDLY refuses when the target resolves to your own workspace — the actual bug this prevents
#   3. refuses a ref that is not in `cmux workspace list` (bogus refs otherwise return someone else's pane)
#   4. non-zero exit on a failed capture, so `&&` chains don't march on with empty output
#
# 🔴 Panes are for DETAIL, never for TRUTH. Liveness belongs to `ps aux` + session-id correlation
# (a session id ties to a role via the scratchpad worktrees it owns); merge/PR state belongs to `gh`.

set -u

if [ $# -lt 1 ]; then
  echo "usage: cmux-look.sh <workspace-ref> [lines] [--scrollback]" >&2
  exit 2
fi

WS="$1"
LINES="${2:-40}"
shift $(( $# > 1 ? 2 : 1 ))

# The whole point: catch target == self BEFORE reporting someone else's health from your own pane.
SELF="${CMUX_WORKSPACE_ID:-}"
if [ -n "$SELF" ] && [ "$WS" = "$SELF" ]; then
  echo "REFUSING: $WS is THIS session's own workspace (\$CMUX_WORKSPACE_ID)." >&2
  echo "Capturing it would tell you about yourself, not the actor you are diagnosing." >&2
  exit 3
fi

# A bogus ref does NOT error — it renders some other workspace's pane at exit 0. Validate first, or
# "I got a pane back" silently becomes "the workspace I asked about is healthy".
LIST="$(CMUX_QUIET=1 cmux workspace list 2>/dev/null)" || LIST=""
if [ -n "$LIST" ] && ! printf '%s\n' "$LIST" | grep -qE "(^|[[:space:]])${WS}([[:space:]]|$)"; then
  echo "REFUSING: $WS is not in \`cmux workspace list\` — it may have been closed." >&2
  echo "cmux would return exit 0 and ANOTHER workspace's pane for it, which reads as a healthy target." >&2
  printf '%s\n' "$LIST" >&2
  exit 4
fi

OUT="$(CMUX_QUIET=1 cmux capture-pane --workspace "$WS" --scrollback --lines "$LINES" "$@" 2>&1)" || {
  echo "CAPTURE-FAILED $WS" >&2
  [ -n "$OUT" ] && printf '%s\n' "$OUT" >&2
  exit 1
}

printf '%s\n' "$OUT"
