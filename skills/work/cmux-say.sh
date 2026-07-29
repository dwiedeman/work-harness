#!/bin/zsh
# cmux-say.sh — reliably deliver a message to a cmux workspace pane (Claude Code TUI or shell).
#
# WHY: `cmux send` pastes text (bracketed paste), so a trailing \r/\n inside the text becomes
# a literal newline in the input box, NOT a submit keypress. Messages "land unsent" and sit in
# the input area until a human presses Enter. The fix is a SEPARATE `cmux send-key enter`.
#
# Usage: cmux-say.sh <workspace-ref> <message>
#   e.g. cmux-say.sh workspace:74 "OPERATOR DIRECTIVE: ..."
#
# Sends text → pause → Enter keypress → pause → second Enter (harmless on an empty Claude Code
# input box or an empty shell line, rescues a swallowed first keypress). If you need proof of
# delivery, follow up with: cmux capture-pane --workspace <ref> | tail -20
# (a submitted Claude Code message shows in the queued/processed area, not the input box).

set -u
WS="$1"
MSG="$2"

CMUX_QUIET=1 cmux send --workspace "$WS" -- "$MSG" || { echo "SEND-FAILED $WS"; exit 1; }
sleep 0.6
CMUX_QUIET=1 cmux send-key --workspace "$WS" enter || { echo "ENTER-FAILED $WS"; exit 1; }
sleep 0.8
CMUX_QUIET=1 cmux send-key --workspace "$WS" enter 2>/dev/null
echo "DELIVERED $WS (text + enter x2)"
exit 0
