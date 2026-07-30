#!/usr/bin/env bash
# Install the work harness into ~/.claude. Idempotent; re-run to update.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"

echo "Installing from $SRC → $DEST"
mkdir -p "$DEST/skills" "$DEST/hooks"
cp -R "$SRC/skills/." "$DEST/skills/"
cp -R "$SRC/hooks/."  "$DEST/hooks/"
# VERSION is part of the shipped payload, not just repo metadata: the runner reads the harness version
# from `<skillsDir>/../../VERSION`, which resolves to `$DEST/VERSION` once installed (DER-2748). Without
# it the installed harness reports `harness_version: "unknown"` — and the failure is subtle in the worst
# way, because TWO installed hosts then look same-version to each other, which is precisely the skew the
# version check exists to catch. The suite also passes in a checkout and fails only from ~/.claude.
if [ ! -f "$SRC/VERSION" ]; then
  echo "INSTALL FAILED: $SRC/VERSION is missing — refusing to install a harness that cannot report its own version." >&2
  exit 1
fi
cp "$SRC/VERSION" "$DEST/VERSION"

echo
echo "Installed:"
find "$DEST/skills/work" "$DEST/skills/work-lead" "$DEST/skills/work-shepherd" \
     "$DEST/skills/prep-for-work" "$DEST/hooks/context-wrap-nudge.mjs" -type f 2>/dev/null | sed "s|$DEST/|  |"

echo
echo "Verifying (the harness tests itself):"
# DER-2743: both of these lines used to end in `|| true`, which nullifies `pipefail` — a red suite, a
# missing `node`, or a broken test file all still exited 0, so the installer announced that it was
# verifying and then ignored the answer. A check that cannot fail is not evidence, and this is the
# operator's first trust signal for a harness that then runs unattended. Capture each suite's REAL
# exit status, keep the counts visible, and refuse the install on any failure.
verify_failed=0
run_suite() {
  local label="$1"
  shift
  local log rc
  log="$(mktemp)"
  if node --test "$@" >"$log" 2>&1; then rc=0; else rc=$?; fi
  grep -E '^# (tests|pass|fail)|^ℹ (tests|pass|fail)' "$log" || true
  if [ "$rc" -ne 0 ]; then
    echo "  ✗ $label FAILED (node --test exit $rc)" >&2
    tail -40 "$log" >&2
    verify_failed=1
  else
    echo "  ✓ $label"
  fi
  rm -f "$log"
}
# Every suite listed here must be one this script actually COPIED — and every suite it copies must be
# listed. `repo-contract.test.mjs` enforces the second half: the installer shipped session-end-telemetry
# and the context-wrap-nudge suites into ~/.claude for a while without ever running them, so a broken
# hook would have installed "clean". An unverified shipped file is the same silent-success shape as the
# `|| true` this function replaced.
run_suite "skills/work — work-runner + work-metrics + session-end-telemetry" \
  "$DEST/skills/work/work-runner.test.mjs" \
  "$DEST/skills/work/work-metrics.test.mjs" \
  "$DEST/skills/work/session-end-telemetry.test.mjs"
run_suite "skills/prep-for-work — prep-runner.test.mjs" \
  "$DEST/skills/prep-for-work/prep-runner.test.mjs"
run_suite "hooks — context-wrap-nudge.test.mjs" \
  "$DEST/hooks/context-wrap-nudge.test.mjs"

if [ "$verify_failed" -ne 0 ]; then
  echo >&2
  echo "INSTALL FAILED: the harness's own suite is not green in $DEST (see the failing suite above)." >&2
  echo "The files WERE copied, so $DEST is now this source tree — do not run the harness until it is green." >&2
  echo "Fix the source tree and re-run install.sh." >&2
  exit 1
fi

echo
echo "Next:"
echo "  1. cp $DEST/skills/work/work.config.example.json <your-repo>/.claude/work.config.json"
echo "  2. edit it (repo.repoSlug, repo.ownerLogin, commitAuthor)"
echo "  3. cd <your-repo> && node $DEST/skills/work/work-runner.mjs preflight"
echo "     Gate your first run on the printed PREFLIGHT GREEN."
