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
