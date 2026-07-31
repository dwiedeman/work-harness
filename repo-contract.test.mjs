// Repo release-engineering contract — run with: node --test repo-contract.test.mjs
//
// DER-2751 (#20): at 2c3ecbe this repo had no CI, no version, no changelog and no tags — nothing ran the
// harness's own 363 tests on push, and `main` was unprotected. These tests are the part of that contract
// a test CAN enforce: that every suite in the repo is actually wired into CI, that the version is real,
// and that CI gates cannot be silently defanged. Branch protection itself needs repo `admin` and is
// documented in .github/REPO-SETUP.md instead — see the last test, which keeps that honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFile(join(REPO, rel), "utf8");
const gitFiles = (glob) =>
  execFileSync("git", ["ls-files", glob], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);

test("CI runs EVERY test suite in the repo — a new suite cannot be added without wiring it in", async () => {
  // The drift this catches is concrete: install.test.mjs and repo-contract.test.mjs were both added in
  // this same run, and a CI file that lists suites by hand silently stops covering the newest one.
  const ci = await read(".github/workflows/ci.yml");
  const suites = gitFiles("*.test.mjs");
  assert.ok(suites.length >= 3, `expected the repo's suites to be tracked by git, found ${suites.length}`);
  const missing = suites.filter((s) => !ci.includes(s));
  assert.deepEqual(missing, [], `these suites exist but CI never runs them: ${missing.join(", ")}`);
});

test("install.sh verifies EVERY suite it copies into ~/.claude", async () => {
  // Same rule as the CI test above, one layer down, and it caught a real gap: install.sh shipped
  // session-end-telemetry.test.mjs and hooks/context-wrap-nudge.test.mjs into the destination and never
  // ran them, so a broken hook would have installed reporting "clean". `install.sh` copies skills/ and
  // hooks/ wholesale, so anything matching there is shipped and must be verified.
  const sh = await read("install.sh");
  const shipped = gitFiles("*.test.mjs").filter((f) => f.startsWith("skills/") || f.startsWith("hooks/"));
  assert.ok(shipped.length >= 4, `expected the shipped suites to be tracked, found ${shipped.length}`);
  const missing = shipped.filter((f) => !sh.includes(f));
  assert.deepEqual(missing, [], `install.sh copies these into ~/.claude but never runs them: ${missing.join(", ")}`);
  // And the converse: it must not claim to verify a suite that isn't shipped, or the install fails on a
  // path that will never exist.
  const claimed = [...sh.matchAll(/\$DEST\/([A-Za-z0-9/_.-]+\.test\.mjs)/g)].map((m) => m[1]);
  const phantom = claimed.filter((c) => !shipped.includes(c));
  assert.deepEqual(phantom, [], `install.sh runs suites that are not shipped: ${phantom.join(", ")}`);
});

test("CI gates cannot be defanged with continue-on-error", async () => {
  // The YAML spelling of DER-2743's `|| true`: a step that cannot fail the build is not a gate.
  const ci = await read(".github/workflows/ci.yml");
  // Match the SETTING (a `continue-on-error:` key), not the word — prose that explains why the setting is
  // banned must not trip the control that bans it.
  assert.doesNotMatch(ci, /^\s*continue-on-error\s*:/m, "a CI step that cannot fail is not evidence");
});

test("CI checks syntax of every shipped .mjs and .sh, and runs the security-regression job by name", async () => {
  const ci = await read(".github/workflows/ci.yml");
  assert.match(ci, /node --check/, "a syntax error in a shipped runner must fail CI");
  assert.match(ci, /bash -n/, "so must one in a shipped shell script");
  assert.match(ci, /shellcheck/i);
  assert.match(ci, /DER-2737/, "the public-comment security regression runs as its own named gate");
});

test("VERSION is semver and CHANGELOG has a section for exactly that version", async () => {
  // Without this pair, `VERSION` drifts into a number nothing describes — which is how two hosts end up
  // running different harness code that both claim the same version.
  const version = (await read("VERSION")).trim();
  assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, `VERSION is not semver: "${version}"`);
  const changelog = await read("CHANGELOG.md");
  assert.ok(
    changelog.includes(`[${version}]`),
    `CHANGELOG.md has no section for the current VERSION (${version}) — the version says nothing without it`,
  );
});

test("DER-2780: no shipped doc or comment still claims harness-version skew is untracked or VERSION uncopied", async () => {
  // Four sites (README.md's upgrade section, CHANGELOG.md's own preamble, CHANGELOG.md's "Known
  // follow-ups" bullet, and a work-runner.mjs comment) described version-skew detection as untracked and
  // `install.sh` as never copying VERSION — after DER-2748/DER-2779 made the ledger track skew and refuse
  // a mixed-version dispatch, and after install.sh was fixed to copy VERSION and refuse to install
  // without it. One of the four directly contradicted a "Fixed" bullet nine lines above it in the SAME
  // file. DER-2780 corrected all four in place; this guard is what stops a fifth from creeping back in.
  //
  // Shape: discover the files to check by scanning tracked source rather than hand-listing "README.md and
  // CHANGELOG.md" — a future false claim is exactly as likely to land in a SKILL.md or a different .mjs
  // comment, and a hand-picked file list goes stale exactly like a hand-picked line number does.
  //
  // Stated limit: this is a literal-string sieve, not an intent check. It proves these EXACT claims are
  // absent from shipped prose/comments right now; it cannot catch a differently-worded claim making the
  // same false point. That is a known, accepted gap, not an oversight — a hand-maintained inventory of
  // "prose that depends on X" would be the wrong shape to grow instead of accepting this limit, since it
  // just relocates the staleness into the inventory itself.
  const FALSE_CLAIMS = [
    /skew is currently invisible/i,
    /version is not yet recorded/i,
    /is deliberately NOT in this entry/i,
    /does not copy `?VERSION`?/i,
    /copies[^.\n]*but NOT `?VERSION`?/i,
    // DER-2840: owner equality does NOT exclude forks — one owner may hold both a repository and a fork
    // of it. Three shipped files asserted that it did ("a fork never is" / "a fork never does"), and the
    // one this guard would have missed is the one that mattered most: see the .json note below.
    /a fork never (is|does)/i,
  ];
  // `*.json` is in scope deliberately. The DER-2840 sweep found the false claim above in THREE files, and
  // `skills/work/work.config.example.json` — the file README.md and install.sh both tell an adopter to
  // copy into their own repo, and which this suite elsewhere calls "the ONLY adopter doc" — was the one a
  // .md/.mjs/.sh-only sieve could not see. The most load-bearing prose in this repo is a JSON doc value,
  // so a guard that skips .json has a hole exactly where it can least afford one.
  const files = gitFiles("*.md")
    .concat(gitFiles("*.mjs"), gitFiles("*.sh"), gitFiles("*.json"))
    .filter((f) => !f.endsWith(".test.mjs"));
  assert.ok(files.length >= 10, `expected shipped docs/sources to be tracked, found ${files.length}`);
  const hits = [];
  for (const f of files) {
    const body = await read(f);
    for (const pattern of FALSE_CLAIMS) {
      if (pattern.test(body)) hits.push(`${f} matches ${pattern}`);
    }
  }
  assert.deepEqual(hits, [], `stale/contradictory version-skew claim(s) found:\n${hits.join("\n")}`);
});

test("the branch-protection settings that CI can't apply itself are written down, with the checks named", async () => {
  // Honest bookkeeping: applying protection needs repo `admin`, which the harness's own credentials do
  // not have. The contract is therefore "documented + reproducible in one paste", and this test fails if
  // a required check is renamed in ci.yml but not in the setup doc.
  const setup = await read(".github/REPO-SETUP.md");
  const ci = await read(".github/workflows/ci.yml");
  assert.match(setup, /branch.?protection|required_status_checks/i);
  const jobNames = [...ci.matchAll(/^\s{4}name:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.ok(jobNames.length >= 3, `expected CI job names to parse, got ${JSON.stringify(jobNames)}`);
  for (const n of jobNames) {
    const literal = n.replace(/\$\{\{\s*matrix\.node\s*\}\}/, "").trim();
    const stem = literal.replace(/\(\s*node\s*\)?$/, "").trim();
    assert.ok(
      setup.includes(stem),
      `CI job "${n}" is not named in .github/REPO-SETUP.md's required checks — protection would not gate it`,
    );
  }
});
