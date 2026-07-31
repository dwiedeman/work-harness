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

# P0.3 — VERSION is a CLAIM; this manifest is a MEASUREMENT.
#
# The version file above is necessary but provably not sufficient: on 2026-07-31 two hosts both reported
# `0.2.0` while seven shipped files differed (work-runner.mjs by 37,762 bytes), because the version was
# never bumped across ~12 commits. `~/.claude/skills` is not a git repo, so neither host had any way to
# notice, and the skew gate — which compares version STRINGS — reported them as agreeing. A gate that
# reassures two divergent hosts is worse than no gate.
#
# So record a sha256 per shipped file plus an aggregate `content_digest`. `preflight` re-measures the
# installed tree against this (both directions: it must be able to print CLEAN as well as DRIFT), and the
# cross-host check compares aggregates so an unbumped-version drift refuses a dispatch. `source_commit`
# is recorded because the drift actually observed was stale-but-untampered — nothing modified, everything
# old — which per-file hashes alone cannot distinguish from a fresh install.
echo "Recording content digests → $DEST/INSTALL-MANIFEST.json"
SOURCE_COMMIT="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)"
INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Hash what was actually COPIED, walking $DEST — not $SRC. Hashing the source would attest to the bytes
# we meant to install rather than the bytes that landed, and a `cp` that silently dropped a file would
# still produce a matching manifest. The point is to measure the tree preflight will later re-measure.
#
# `tmp/` is excluded because the runner writes run state under skills/work/tmp/; including it would make
# every install drift against itself the moment anything ran, and a drift check that always reds is one
# nobody reads.
DIGEST_LINES="$(cd "$DEST" && find skills hooks -type f ! -path '*/tmp/*' ! -name '.DS_Store' \
  | LC_ALL=C sort \
  | while IFS= read -r f; do printf '%s:%s\n' "$f" "$(shasum -a 256 "$f" | cut -d' ' -f1)"; done)"
# The aggregate is sha256 over those `path:sha256` lines joined by newline, NO trailing newline —
# byte-identical to `aggregateDigest()` in work-runner.mjs, which the unit suite pins with a control that
# recomputes this from the manifest's own files map. Two definitions of one digest that disagree would
# make every cross-host comparison read as drift.
CONTENT_DIGEST="$(printf '%s' "$DIGEST_LINES" | shasum -a 256 | cut -d' ' -f1)"
{
  printf '{\n  "version": "%s",\n  "installed_at": "%s",\n  "source_commit": "%s",\n  "content_digest": "%s",\n  "files": {\n' \
    "$(cat "$SRC/VERSION")" "$INSTALLED_AT" "$SOURCE_COMMIT" "$CONTENT_DIGEST"
  printf '%s\n' "$DIGEST_LINES" | awk -F: 'NR>1{printf ",\n"} {printf "    \"%s\": \"%s\"", $1, $2}'
  printf '\n  }\n}\n'
} > "$DEST/INSTALL-MANIFEST.json"

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
