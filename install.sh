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

# DER-3008 — the digest is scoped to the SHIPPED PAYLOAD, not to everything under $DEST/skills.
#
# This walk used to be `find skills hooks -type f` under $DEST, i.e. every file in the operator's
# ~/.claude/skills tree. `~/.claude/skills` is a SHARED directory: this MacBook carries 59 top-level
# skills (823 files — email skills, hyperframes symlinks, __pycache__) against the mini's handful. So
# the aggregate could never match across two hosts no matter how faithfully both were installed.
# Measured 2026-08-01, both hosts at 0.4.0 from source_commit 0ba513f with every harness-suite file
# byte-identical: MacBook f18703c0bca0… vs mini a1cc1fae4a5c…. `harness-digest:<host>` compares exactly
# that aggregate, so a KNOWN-GOOD deploy reported "CONTENT DRIFT — SAME VERSION STRING, DIFFERENT CODE".
# A gate that reds on a correct deploy gets waved past, which is how the drift it exists to catch gets
# through.
#
# The list therefore comes from $SRC (what this script ships), and every hash is still taken at $DEST
# (what actually landed) — measure-what-landed is the property that makes a `cp` which silently dropped
# a file fail rather than vanish from both sides of the compare. A missing $DEST copy has no hash, and
# rather than skipping the line (which would just shorten the list and still produce a valid-looking
# digest) it FAILS THE INSTALL by name.
#
# `tmp/` is excluded because the runner writes run state under skills/work/tmp/; including it would make
# every install drift against itself the moment anything ran, and a drift check that always reds is one
# nobody reads.
SHIPPED_RELS="$( { (cd "$SRC" && find skills hooks -type f ! -path '*/tmp/*' ! -name '.DS_Store'); echo VERSION; } | LC_ALL=C sort)"

# The manifest's wire format is `path:sha256` lines plus hand-emitted JSON, and BOTH encodings are
# ambiguous for a family of characters. Each was reproduced against this script and each failed
# SILENTLY, at exit 0, with a manifest that looked well-formed:
#   `:`      `awk -F:` splits on the FIRST colon, so a payload file `skills/work/notes:draft.md` was
#            recorded as key "skills/work/notes" with the VALUE "draft.md" in place of a hash.
#            `aggregateDigest` folds `path:sha` the same way, so the two sides cannot even agree on what
#            the line means — and a perfectly clean install then reads as PERMANENT drift.
#   `"`      emitted raw into the JSON string, so `skills/work/say"hi.md` produced a manifest that is not
#            valid JSON. `measureHarnessDrift` cannot parse it and returns `absent` — an install unable
#            to attest to itself — while install.sh reported success.
#   `\`      the SAME failure as `"`, and it was missed when this guard was first written because the
#            character is harmless to the shell here and only bites the hand-emitted JSON:
#            `skills/work/say\hi.md` passes `[:"]`, then `JSON.parse` dies on "Bad escaped character".
#            Reproduced at exit 0 with a written manifest, remediation round 1.
#   control  tab, CR and friends are the same class one layer down — a literal control byte inside a
#            JSON string is invalid JSON ("Bad control character in string literal"), and unlike the
#            quote it is INVISIBLE in any error message that echoes the path back.
#   newline  splits one path across two `while read` iterations, corrupting both list and aggregate.
#
# The payload is repo-controlled and no such filename exists today, so the honest fix is to fail CLOSED
# at the source rather than build an escaping layer for filenames this project must never ship. Any
# quoting scheme would also have to be mirrored byte-for-byte in `aggregateDigest`, which is precisely
# the two-definitions-of-one-digest hazard documented above that function.
#
# `\\` sits mid-class deliberately: a bracket expression ending in `\]` is read differently by different
# greps, and this one must mean the same thing everywhere it runs.
BAD_NAMES="$(printf '%s\n' "$SHIPPED_RELS" | LC_ALL=C grep -E '[:"\\]|[[:cntrl:]]' || true)"
# A newline inside a filename is invisible in the line-oriented list above — it has already split. Count
# NUL-delimited entries against line-delimited ones instead; a mismatch means some name contains one.
NL_LINES="$( (cd "$SRC" && find skills hooks -type f ! -path '*/tmp/*' ! -name '.DS_Store') | wc -l | tr -d ' ')"
NUL_ENTRIES="$( (cd "$SRC" && find skills hooks -type f ! -path '*/tmp/*' ! -name '.DS_Store' -print0) | tr -dc '\0' | wc -c | tr -d ' ')"
if [ -n "$BAD_NAMES" ] || [ "$NL_LINES" != "$NUL_ENTRIES" ]; then
  echo "INSTALL FAILED: the shipped payload contains a filename the manifest format cannot encode unambiguously." >&2
  if [ -n "$BAD_NAMES" ]; then
    echo "  these contain ':', '\"', '\\' or a control character:" >&2
    # `-vt` renders control bytes as ^I / ^M rather than printing them raw: a tab in a path is invisible
    # in an error message, and an operator cannot rename a character they cannot see. The `t` is not
    # optional — plain `cat -v` passes TAB through untouched, which is the one control character a
    # filename is most likely to actually contain.
    # Indented AFTER rendering, one line at a time: `$BAD_NAMES` is a single multi-line argument, so a
    # `printf '    %s\n'` prefix reaches only the first name — which is exactly the case where there is
    # more than one, and the list is what the operator has to read.
    printf '%s\n' "$BAD_NAMES" | LC_ALL=C cat -vt | sed 's/^/    /' >&2
  fi
  if [ "$NL_LINES" != "$NUL_ENTRIES" ]; then
    echo "  a filename contains a NEWLINE ($NL_LINES line(s) for $NUL_ENTRIES file(s))" >&2
  fi
  echo "  Rename it in the source tree. A ':' silently corrupts the path:sha256 line, and '\"', '\\' or a control byte emits invalid JSON — all at exit 0, which is why this refuses rather than escapes." >&2
  exit 1
fi
# The TERRITORY the payload lands in: the top-level paths `cp -R "$SRC/skills/." "$DEST/skills/"` and its
# hooks twin write into — `skills/work`, `skills/prep-for-work`, `hooks/context-wrap-nudge.mjs`, … .
# Recorded in the manifest because `measureHarnessDrift` needs it to find UNTRACKED files: with the file
# list now scoped, a walk of all of `skills/` would report the operator's other 798 files as untracked on
# every clean install. Scoping the WALK to these roots keeps rogue-file and stale-leftover detection
# alive exactly where the runner loads code from, and nowhere else.
#
# `cut -f1-2` gives `skills/<dir>` for a nested skill file and `hooks/<file>` for a hook — deliberately
# the individual hook FILES, not the whole `hooks/` directory, because ~/.claude/hooks is shared with
# other tools and a co-tenant's hook is not harness drift. VERSION is in `files` but is not a root.
SHIPPED_ROOTS="$(printf '%s\n' "$SHIPPED_RELS" | grep -E '^(skills|hooks)/' | cut -d/ -f1-2 | LC_ALL=C sort -u)"
DIGEST_LINES="$(cd "$DEST" && printf '%s\n' "$SHIPPED_RELS" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  h="$(shasum -a 256 "$f" 2>/dev/null | cut -d' ' -f1)"
  if [ -z "$h" ]; then
    echo "INSTALL FAILED: $DEST/$f is in the shipped payload but is not readable after the copy — refusing to write a manifest that attests to a file that did not land." >&2
    exit 1
  fi
  printf '%s:%s\n' "$f" "$h"
done)"
# The aggregate is sha256 over those `path:sha256` lines joined by newline, NO trailing newline —
# byte-identical to `aggregateDigest()` in work-runner.mjs, which the unit suite pins with a control that
# recomputes this from the manifest's own files map. Two definitions of one digest that disagree would
# make every cross-host comparison read as drift.
CONTENT_DIGEST="$(printf '%s' "$DIGEST_LINES" | shasum -a 256 | cut -d' ' -f1)"
# `manifest_schema` exists so a v1 manifest (whole-tree file list, no `roots`) is RECOGNISED as old
# rather than compared against a v2 one and reported as content drift. The cross-host check reads it and
# says "re-install BOTH hosts" instead of naming a drift that isn't one.
{
  printf '{\n  "manifest_schema": 2,\n  "version": "%s",\n  "installed_at": "%s",\n  "source_commit": "%s",\n  "content_digest": "%s",\n  "roots": [' \
    "$(cat "$SRC/VERSION")" "$INSTALLED_AT" "$SOURCE_COMMIT" "$CONTENT_DIGEST"
  printf '%s\n' "$SHIPPED_ROOTS" | awk 'NR>1{printf ", "} {printf "\"%s\"", $0}'
  printf '],\n  "files": {\n'
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
