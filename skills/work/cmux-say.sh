#!/bin/zsh
# cmux-say.sh — reliably deliver a message to a cmux workspace pane (Claude Code TUI or shell).
#
# WHY: `cmux send` pastes text (bracketed paste), so a trailing \r/\n inside the text becomes
# a literal newline in the input box, NOT a submit keypress. Messages "land unsent" and sit in
# the input area until a human presses Enter. The fix is a SEPARATE `cmux send-key enter`.
#
# Usage: cmux-say.sh <workspace-ref> <message> [--ledger-ref <event_id>] [--fyi]
#   e.g. cmux-say.sh workspace:74 "read ledger EV-1234" --ledger-ref EV-1234
#
# Sends text → pause → Enter keypress → pause → second Enter (harmless on an empty Claude Code
# input box or an empty shell line, rescues a swallowed first keypress).
#
# ── 3.1 — DELIVERED IS NOT READ ───────────────────────────────────────────────────────────────
# `cmux send` delivers into a session's INPUT QUEUE. A mid-turn session reads it only when its
# current turn ends. On 2026-07-31 a shepherd acted on an orchestrator ruling ~4 minutes late, and
# only because it happened to finish a turn around then. There is no upper bound on that delay and
# no receipt anywhere, so "I told it" and "it knows" were indistinguishable.
#
# So an ACTIONABLE message must have a ledger counterpart, and this script REFUSES to send one
# without `--ledger-ref`. Two reasons, and the second is the load-bearing one:
#   1. The pane text becomes "read ledger <event_id>", so the durable copy is the ledger and the
#      pane is only a doorbell. A pane scrollback that got truncated no longer loses the content.
#   2. The recipient can append `msg_ack {ref}`, which makes READ observable. `state.unacked_messages`
#      then surfaces anything unacked past a threshold on every watch wake.
# This generalises the kickback relay's existing shape (kickback_ack + a ~10-min no-ack ⇒ respawn
# rule), which already proved the pattern on the one message type that had it.
#
# `--fyi` is the deliberate escape hatch for a genuinely non-actionable note (a status ping, a
# courtesy heads-up). It is a flag rather than the default so that skipping the ledger is a
# CHOICE someone made, not an omission — an actionable message sent as `--fyi` is a process error
# the sender owns.

set -u

WS=""
MSG=""
LEDGER_REF=""
FYI=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ledger-ref) LEDGER_REF="${2:-}"; shift 2 ;;
    --fyi) FYI=1; shift ;;
    *)
      if [ -z "$WS" ]; then WS="$1"
      elif [ -z "$MSG" ]; then MSG="$1"
      else echo "cmux-say: unexpected argument: $1" >&2; exit 2
      fi
      shift ;;
  esac
done

if [ -z "$WS" ] || [ -z "$MSG" ]; then
  echo "usage: cmux-say.sh <workspace-ref> <message> [--ledger-ref <event_id>] [--fyi]" >&2
  exit 2
fi

if [ -z "$LEDGER_REF" ] && [ "$FYI" -eq 0 ]; then
  cat >&2 <<'REFUSAL'
cmux-say: REFUSING to send an actionable message with no ledger counterpart.

`cmux send` delivers into the session's INPUT QUEUE; a mid-turn session reads it whenever its turn
ends, with no upper bound and no receipt. DELIVERED is not READ, and without a ledger event there is
no durable copy and nothing for the recipient to acknowledge.

  1. Append the content as an event:  work-runner.mjs append --run <r> '{"actor":"orch","type":"orch_note",...}'
  2. Re-send with:                    cmux-say.sh <ws> "read ledger <event_id>" --ledger-ref <event_id>
  3. The recipient appends:           {"actor":"shepherd","type":"msg_ack","ref":"<event_id>"}

If this really is a non-actionable note, pass --fyi to say so deliberately.
REFUSAL
  exit 2
fi

CMUX_QUIET=1 cmux send --workspace "$WS" -- "$MSG" || { echo "SEND-FAILED $WS"; exit 1; }
sleep 0.6
CMUX_QUIET=1 cmux send-key --workspace "$WS" enter || { echo "ENTER-FAILED $WS"; exit 1; }
sleep 0.8
CMUX_QUIET=1 cmux send-key --workspace "$WS" enter 2>/dev/null

# The word DELIVERED is deliberate and unchanged: this script can only ever prove delivery. Whether
# the message was READ is answered by `msg_ack` in the ledger, never by anything printed here.
if [ -n "$LEDGER_REF" ]; then
  echo "DELIVERED $WS (text + enter x2) ref=$LEDGER_REF — NOT YET READ; expect msg_ack $LEDGER_REF (state.unacked_messages surfaces it until then)"
else
  echo "DELIVERED $WS (text + enter x2) [--fyi: no ledger counterpart, no ack expected]"
fi
exit 0
