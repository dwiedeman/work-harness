# work-harness fix run — orchestrator-direct plan (prep-for-work, method-applied)

**Repo:** github.com/dwiedeman/work-harness (PUBLIC). **Clone:** scratchpad/wh-work (main, owner identity set, 363/363 green baseline).
**Model:** orchestrator-direct — NO /work shepherd (no merge queue / CI to drive; that's #20/DER-2751 + merge-mode/DER-2753, which this run adds). Hosts: macbook (subagents) + mini optional for disjoint-file units. No cloud.
**Prep-runner note:** its sizing/surface tooling is ROST-calibrated (packages/commands, migrations, reference guides) — N/A here. All 17 units are small surgical fixes; the real constraint is region collisions inside one 4,840-line file, so this plan is a serialization map, not a sizing table.

## Hard rules for the run
1. **#1 (DER-2737) lands FIRST** — public repo ⇒ the unauthenticated-comment→injection chain is live-exploitable. Security gate before anything else.
2. **Install ONCE, at the very end**, after the full suite is green. **Never `cp` a worktree into `~/.claude` mid-run** — that's the self-modification hazard; the running harness (this session's tooling) must stay frozen while we edit clones.
3. **Fix #3 (installer can't fail) BEFORE trusting the install self-test** at the end.
4. Every unit: apply its must-fail regression (see the Linear issue), SEE it go red on current code, then green after the fix; then the full `node --test` (363→363+N) stays green. No unit lands on a described-but-unobserved failure.
5. Orchestrator owns all git/worktree ops; implementer subagents are files-only.

## Collision map (the core finding)
`work-runner.mjs` is touched by ~12 units. Regions:
- **1065-1097** gates: #12(DER-2603), reused by #7, merge-mode
- **1661 / 3147-3178 / 4369 / appendEvent** #1(DER-2737 security)  ← touches reap-4369 + reconcile-3431 + appendEvent
- **1829-1886** boot builders: #11(DER-2744)
- **2322-2403** ledger core (appendEvent/readEvents/mergeRemoteEvents/dedupe): #4(DER-2738), #5+16(DER-2741), #21(DER-2748)  ← heavy mutual overlap
- **2454-2465** materializeState fold: #6(DER-2739), touched by #21
- **3365-3406** reconcile: #17(DER-2750), touched by #1
- **3505-3583** init-run: #7(DER-2746)
- **3633 / 3443 / 715** cloud brief: #14(DER-2749)
- **3740-3775 / 3933-3950** spawn: #6(DER-2739)
- **4360-4388** reap: #13(DER-2740) + #1 (both edit 4369!)
- **4671-4725** watch: #5+16(DER-2741)

Disjoint files (safe to parallelize): install.sh (#3, #20), session-end-telemetry.mjs (#10), context-wrap-nudge.mjs (#15), prep-runner.mjs (#19), new .github/ (#20), README/config (merge-mode config half).

## Waves

**Wave 0 — parallel, disjoint files (macbook + mini):**
| Agent | Model | Units | Files |
|---|---|---|---|
| A | Opus | **#1 DER-2737** (security, FIRST) | work-runner.mjs only (1661/3147/4369/appendEvent) |
| B | Sonnet | #3 DER-2743 + #20 DER-2751 | install.sh, new .github/workflows/ci.yml, README |
| C | Sonnet | #10 DER-2747 + #15 DER-2581/#15 | session-end-telemetry.mjs, context-wrap-nudge.mjs |
| D | Sonnet | #19 DER-2752 (injection seam) | prep-runner.mjs |

Wave 0 is collision-safe: A owns work-runner.mjs; B/C/D own disjoint files.

**Wave 1 — work-runner.mjs, SEQUENTIAL on top of #1 (Opus), each rebases on the prior:**
1. **#21 DER-2748** ledger protocol (appendEvent/dedupe/eventSeenKey) — foundational; #1's appendEvent allowlist composes onto it.
2. **#4 DER-2738 + #5/#16 DER-2741** ledger tolerance + cursor — same 2322-2403 + 4671-4725 region; do together.
3. **#6 DER-2739 spawn** (+ materializeState fold) and **#11 DER-2744 boot builders** — #11's region (1829) is disjoint from #6 (3740/2454), so #11 can be a parallel worktree branch, but both rebase on #21's appendEvent shape.
4. **#13 DER-2740 reap** — AFTER #1 (shared line 4369).
5. **#7 DER-2746 init-run validator + #12 DER-2603 gate** — the "two gates" bundle; #7 imports the already-exported validatePlan; #12 also fixes its pinning test (work-runner.test.mjs:3321-3332).
6. **#14 DER-2749 cloud brief** (config half can pair with merge-mode) + **#17 DER-2750 reconcile** (rebase on #1).
7. **merge-mode DER-2753** — shepherd merge path + config; governance (Opus). Pairs with #20 to make work-harness self-hostable.

**Deferred:** #18 DER-2752 module split — only after all durability contracts land.

## Model/lane assignment
- **Opus:** #1, #21, #6, #13, #7, #12, merge-mode (security / schema / state-integrity / governance).
- **Sonnet:** #3, #10, #15, #17, #14, #19, #20 (mechanical / hooks / config / CI / docs).

## Landing (outward-facing — CHECKPOINT with operator)
- Changes accumulate on branches in the clone; the full suite stays green.
- **Public push + merge + `~/.claude` install are held for an explicit operator go** — public repo, hard to reverse.
- First merges are manual/direct (`gh pr merge --squash`) until DER-2753 lands, then merge-mode drives the rest.

## Success metric
363→(363+N must-fail regressions) tests green; each unit's must-fail control observed red-then-green; `#1` closed and re-verified (drive-by comment doesn't fold; injected worktree can't reach an unquoted ssh string); install self-test can fail (#3) before it's trusted.
