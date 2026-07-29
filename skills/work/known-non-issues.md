# Known non-issues — standing block for dispatched subagents (DER-1992)

Paste this whole file into every dispatched subagent prompt (research / review / audit /
acceptance) and every lead or kickback brief. Subagents do NOT inherit the orchestrator's
memories — without this block the same false positives recur (each entry below has cost real
time at least once).

Treat every item as an ACCEPTED CONVENTION. Do not flag, "fix", or chase them; do not count
them as findings.

1. **`docs/STATE.md` is frozen by design.** Per-PR dated fragments in `docs/state/` are the
   live state. Never flag STATE.md staleness as drift, and never edit it in a feature PR.
2. **A red `Vercel` check on a PR is usually the commit-author mapping** (machine-global git
   email → the old the wrong account account). It is NOT a required check (`checks` is the only required
   context) and does not block the merge queue. The fix is repo-local author config, never the
   PR content.
3. **`mergeStateStatus: BLOCKED`/`UNSTABLE` driven by non-required contexts is not a real
   blocker.** Diff the failing contexts against the branch-protection required checks before
   treating BLOCKED as actionable; the most common real cause is one unresolved review thread.
4. **The Codex GitHub reviewer re-posts already-fixed findings** re-anchored to nearby lines
   (a null `.line` = stale/outdated). Verify every finding against HEAD before acting; a stale
   repost gets its thread resolved, not a re-fix.
5. **`tmp/`, `tmp/work/`, `.omo/`, and dated `TURNOVER-*.md` files are session/scratch
   artifacts**, not repo drift — don't flag them as untracked-file problems in reviews/audits.
6. **Docs-only PRs skipping the heavy CI jobs is by design** (path-gated) — a near-instant
   green `checks` on a docs PR is normal, not a misconfiguration.

This next one is not an accepted convention to ignore — it's a routing rule for something real
you found. Follow it instead of filing on your own:

7. **A `/work`-harness/tooling defect you notice (never app code) does not get a new Linear
   issue.** Comment it on the standing **DER-2668 "Harness freeze list"** issue instead —
   finding text + `file:line` under `~/.claude/skills/work/**` + the run id/PR it surfaced on.
   Report it to the orchestrator or shepherd rather than filing yourself if you have no Linear
   access. **Exception — file immediately as its own Urgent issue:** the defect makes an
   instrument actively **lie toward a destructive action** or **destroy state** (2026-07-27,
   pre-client regroup plan §4.2).

Maintenance: when a review/audit re-flags an accepted convention not listed here, ADD it here
(one numbered entry, with the why) in the same session — this file is the structural fix for
"subagents don't inherit memory". Keep entries machine-portable (`~`-relative paths only).
