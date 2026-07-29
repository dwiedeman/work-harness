#!/usr/bin/env bash
# Install the work harness into ~/.claude. Idempotent; re-run to update.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"

echo "Installing from $SRC → $DEST"
mkdir -p "$DEST/skills" "$DEST/hooks"
cp -R "$SRC/skills/." "$DEST/skills/"
cp -R "$SRC/hooks/."  "$DEST/hooks/"

echo
echo "Installed:"
find "$DEST/skills/work" "$DEST/skills/work-lead" "$DEST/skills/work-shepherd" \
     "$DEST/skills/prep-for-work" "$DEST/hooks/context-wrap-nudge.mjs" -type f 2>/dev/null | sed "s|$DEST/|  |"

echo
echo "Verifying (the harness tests itself):"
node --test "$DEST/skills/work/work-runner.test.mjs" "$DEST/skills/work/work-metrics.test.mjs" 2>&1 | grep -E '^# (tests|pass|fail)|^ℹ (tests|pass|fail)' || true
node --test "$DEST/skills/prep-for-work/prep-runner.test.mjs" 2>&1 | grep -E '^# (tests|pass|fail)|^ℹ (tests|pass|fail)' || true

echo
echo "Next:"
echo "  1. cp $DEST/skills/work/work.config.example.json <your-repo>/.claude/work.config.json"
echo "  2. edit it (repo.repoSlug, repo.ownerLogin, commitAuthor)"
echo "  3. cd <your-repo> && node $DEST/skills/work/work-runner.mjs preflight"
echo "     Gate your first run on the printed PREFLIGHT GREEN."
