# Repo setup — branch protection + release contract (DER-2751)

CI (`.github/workflows/ci.yml`) is only half a gate. Until `main` is **protected** and these checks are
**required**, CI merely reports: a merge can ignore a red run entirely. Applying protection needs repo
`admin`, which the harness's own credentials deliberately do not have — so it lives here as a single
paste for the repo owner rather than as something automation quietly grants itself.

`repo-contract.test.mjs` fails if a CI job is renamed here or in `ci.yml` without the other being
updated, so this list cannot silently stop matching the jobs it claims to require.

## Required checks

| Check | Why it must block a merge |
|---|---|
| `tests (node 20)` | Oldest supported LTS. The harness is stdlib-only; a 20-incompatible API is a real install break. |
| `tests (node 22)` | The version the harness is developed and run on today. |
| `tests (node 24)` | Current. A runtime deprecation should surface here, not mid-run on an operator's box. |
| `static checks` | `node --check` every `.mjs`, `bash -n` every `.sh`, ShellCheck (`--severity=error`). A syntax error in a shipped runner is unattended-run downtime. |
| `public-comment security regression` | DER-2737. Fails when **zero** controls match, so deleting the security tests fails loudly instead of passing on an empty pattern. |
| `skills/** requires a VERSION bump` | P0.3. Shipped code must not change under a version that already means something else. Measured 2026-07-31: two hosts differed by seven files at an identical `VERSION`, and the skew gate — which compares version *strings* — reported them as **agreeing**. Opt out per-PR with a `no-version-bump:` trailer. Pull-request-only, so it is `required` but never runs on a direct push to `main`. |

## Apply it (repo owner, needs `admin`)

```bash
gh api -X PUT repos/dwiedeman/work-harness/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "tests (node 20)",
      "tests (node 22)",
      "tests (node 24)",
      "static checks",
      "public-comment security regression",
      "skills/** requires a VERSION bump"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Notes on the choices, so they can be argued with rather than inherited:

- **`strict: true`** — a branch must be up to date with `main` before merging. CI tests the *merge* tree;
  a behind branch can fail on files it never contained, and "can't reproduce locally" is that signature.
- **`required_pull_request_reviews: null`** — this harness merges its own work autonomously by design, so
  requiring a human reviewer would deadlock it. The gate is the test suite, not a second pair of eyes.
  If a human reviewer is ever wanted, set `{"required_approving_review_count": 1}` and expect the harness
  to stop being able to land anything unattended.
- **`enforce_admins: false`** — leaves the owner an explicit escape hatch for a broken-CI emergency.
  Set it to `true` if you would rather have no exception.

## Verify it took

```bash
gh api repos/dwiedeman/work-harness/branches/main/protection \
  --jq '{strict: .required_status_checks.strict, checks: .required_status_checks.contexts}'
```

## Release contract

- `VERSION` at the repo root is the single source of truth; `CHANGELOG.md` must have a section for it
  (enforced by `repo-contract.test.mjs`).
- Tag a release from `main` once its CI run is green:
  ```bash
  git tag -a "v$(cat VERSION)" -m "work-harness v$(cat VERSION)"
  git push origin "v$(cat VERSION)"
  ```
- Operators upgrade by pulling and re-running `./install.sh`, which now **refuses to finish** if the
  harness's own suite is not green in the destination (DER-2743). Re-running it is the whole upgrade path.
- **Do not re-run `install.sh` while a harness run is in flight on that machine** — it replaces the code
  the running orchestrator/leads are executing from. Install between runs.
- Recording the harness version *inside the ledger* (`run_started`, host heartbeats) and refusing
  mixed-version runs is tracked in DER-2748, not here.
