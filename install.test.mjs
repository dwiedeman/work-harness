// Installer contract tests — run with: node --test install.test.mjs
//
// DER-2743 (#3): both self-test lines in install.sh used to end in `|| true`, which nullifies
// `set -o pipefail` — so a red suite, a missing `node` binary, or a broken test file all still exited
// 0 and the installer printed "Verifying (the harness tests itself)" before ignoring the result. A
// check that cannot return the failing answer is not evidence, and the installer is the operator's
// FIRST trust signal for a harness that then runs unattended.
//
// These tests run the REAL install.sh (copied verbatim into a fixture tree, so its `SRC` resolves to
// the fixture instead of this repo) against deliberately-red suites. They must fail on the pre-fix
// script — that is the point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO = dirname(fileURLToPath(import.meta.url));

const GREEN = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("fixture green", () => { assert.equal(1, 1); });\n';
const RED = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("fixture DELIBERATELY red", () => { assert.equal(1, 2); });\n';

// A fixture SRC tree shaped the way install.sh expects: its `find` line names every skill dir and the
// hook, and under `set -euo pipefail` a missing path is fatal — so the fixture ships them all, and a
// failure here is about the self-test, not about a missing fixture file.
async function fixture({ runner = GREEN, metrics = GREEN, prep = GREEN, telemetry = GREEN, hook = GREEN, version = "9.9.9\n" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wh-install-"));
  const src = join(dir, "src");
  for (const d of ["skills/work", "skills/work-lead", "skills/work-shepherd", "skills/prep-for-work", "hooks"]) {
    await mkdir(join(src, d), { recursive: true });
  }
  await copyFile(join(REPO, "install.sh"), join(src, "install.sh"));
  await writeFile(join(src, "skills/work/work-runner.test.mjs"), runner, "utf8");
  await writeFile(join(src, "skills/work/work-metrics.test.mjs"), metrics, "utf8");
  await writeFile(join(src, "skills/prep-for-work/prep-runner.test.mjs"), prep, "utf8");
  // The fixture must model every suite install.sh verifies, or the all-green control fails on a missing
  // fixture file rather than on installer behaviour. repo-contract.test.mjs keeps the two lists aligned.
  await writeFile(join(src, "skills/work/session-end-telemetry.test.mjs"), telemetry, "utf8");
  await writeFile(join(src, "hooks/context-wrap-nudge.test.mjs"), hook, "utf8");
  await writeFile(join(src, "skills/work-lead/SKILL.md"), "# lead\n", "utf8");
  await writeFile(join(src, "skills/work-shepherd/SKILL.md"), "# shepherd\n", "utf8");
  await writeFile(join(src, "hooks/context-wrap-nudge.mjs"), "// hook\n", "utf8");
  // VERSION is shipped, not just repo metadata — the runner reads it from `<skillsDir>/../../VERSION`,
  // which is `$DEST/VERSION` once installed (DER-2748). `version: null` models a broken source tree.
  if (version !== null) await writeFile(join(src, "VERSION"), version, "utf8");
  return { dir, src, dest: join(dir, "claude-home") };
}

function runInstall({ src, dest }, { path = process.env.PATH } = {}) {
  // The OUTER `node --test` running this file exports NODE_TEST_CONTEXT, which would switch the
  // installer's own nested `node --test` off the TAP reporter and out of the shape install.sh greps.
  // That is an artifact of testing a test runner with a test runner — strip it so the child behaves
  // exactly as it does for an operator running install.sh from a shell.
  const env = { ...process.env, CLAUDE_HOME: dest, PATH: path };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return new Promise((resolve) => {
    const child = spawn("bash", [join(src, "install.sh")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });
}

function commandExists(cmd, path) {
  return new Promise((resolve) => {
    const c = spawn("/bin/sh", ["-c", `command -v ${cmd}`], { env: { PATH: path }, stdio: ["ignore", "pipe", "ignore"] });
    let o = "";
    c.stdout.on("data", (d) => { o += d; });
    c.on("close", () => resolve(Boolean(o.trim())));
  });
}

test("install.sh: a RED harness suite FAILS the install, naming the suite", async () => {
  // THE CONTROL. `|| true` made this outcome unreachable: the install exited 0 on a red suite.
  const f = await fixture({ runner: RED });
  try {
    const r = await runInstall(f);
    assert.notEqual(r.code, 0, `a red suite must fail the install (DER-2743)\n${r.out}`);
    assert.match(r.out, /work-runner\.test\.mjs|skills\/work/, "the installer must say WHICH suite failed");
    assert.match(r.out, /INSTALL FAILED/i, "and must say plainly that the install failed");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("install.sh: a red PREP suite fails the install too (both self-tests are gated, not just the first)", async () => {
  // The second `|| true` was its own hole: gating only the first suite would leave prep-runner unchecked.
  const f = await fixture({ prep: RED });
  try {
    const r = await runInstall(f);
    assert.notEqual(r.code, 0, `a red prep-runner suite must fail the install\n${r.out}`);
    assert.match(r.out, /prep-runner\.test\.mjs|prep-for-work/, "the installer must say WHICH suite failed");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("install.sh: a red HOOK suite fails the install too — every SHIPPED suite is verified, not just skills/", async () => {
  // The installer copied hooks/ and skills/work/session-end-telemetry.test.mjs into ~/.claude and never
  // ran them, so a broken hook installed reporting "clean". This is the control for that gap.
  const f = await fixture({ hook: RED });
  try {
    const r = await runInstall(f);
    assert.notEqual(r.code, 0, `a red hook suite must fail the install\n${r.out}`);
    assert.match(r.out, /context-wrap-nudge|hooks/, "the installer must say WHICH suite failed");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("install.sh: a red session-end-telemetry suite fails the install", async () => {
  const f = await fixture({ telemetry: RED });
  try {
    const r = await runInstall(f);
    assert.notEqual(r.code, 0, `a red telemetry suite must fail the install\n${r.out}`);
    assert.match(r.out, /session-end-telemetry|skills\/work/, "the installer must say WHICH suite failed");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("install.sh: VERSION is shipped into the destination, and a source tree without it is refused", async () => {
  // Two installed hosts that both report `harness_version: "unknown"` look same-version to each other,
  // which is exactly the skew DER-2748's check exists to catch — so a missing VERSION fails the install
  // rather than installing something that cannot describe itself.
  const ok = await fixture();
  try {
    const r = await runInstall(ok);
    assert.equal(r.code, 0, r.out);
    assert.equal((await readFile(join(ok.dest, "VERSION"), "utf8")).trim(), "9.9.9", "VERSION must land in $DEST");
  } finally {
    await rm(ok.dir, { recursive: true, force: true });
  }
  const broken = await fixture({ version: null });
  try {
    const r = await runInstall(broken);
    assert.notEqual(r.code, 0, `a source tree with no VERSION must be refused\n${r.out}`);
    assert.match(r.out, /VERSION is missing/);
  } finally {
    await rm(broken.dir, { recursive: true, force: true });
  }
});

test("install.sh: a REAL install of this repo succeeds — catches repo-vs-installed layout drift", async () => {
  // The fixture tests above use synthetic suites, so they structurally CANNOT catch a file the runner
  // needs at runtime that install.sh fails to copy. That is how the VERSION gap survived: the suite
  // passed in the checkout and failed only from ~/.claude, which is the copy that actually runs. This
  // test installs the real repo into a temp CLAUDE_HOME and runs the real suites there.
  const dest = await mkdtemp(join(tmpdir(), "wh-realinstall-"));
  try {
    const r = await runInstall({ src: REPO, dest });
    assert.equal(r.code, 0, `a real install of this repo must succeed\n${r.out.slice(-4000)}`);
    for (const rel of ["VERSION", "skills/work/work-runner.mjs", "skills/work/session-token-report.mjs", "hooks/context-wrap-nudge.mjs"]) {
      await readFile(join(dest, rel)); // throws if install.sh didn't ship it
    }
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("install.sh: an all-green suite still installs cleanly — exit 0, counts printed, next steps shown", async () => {
  // The other half of the contract: fail-closed must not mean fail-always.
  const f = await fixture();
  try {
    const r = await runInstall(f);
    assert.equal(r.code, 0, `a green suite must install cleanly\n${r.out}`);
    // Both reporter shapes: `node --test` emits TAP (`# pass 2`) on Node 20/22 for a non-TTY stdout, and
    // the spec reporter (`ℹ pass 2`) on Node 24. install.sh's grep already accepts either — asserting only
    // the TAP form made this test, not the installer, the thing that broke on Node 24 in CI.
    assert.match(r.out, /(?:#|ℹ) pass /, "the test counts stay visible");
    assert.doesNotMatch(r.out, /INSTALL FAILED/i);
    assert.match(r.out, /Next:/, "the post-install instructions still print");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("install.sh: a missing `node` FAILS the install instead of silently skipping verification", async (t) => {
  // `node --test` under a node-less PATH is command-not-found (127) — swallowed by `|| true`, so the
  // installer claimed success having verified nothing at all.
  const minimalPath = "/usr/bin:/bin";
  if (await commandExists("node", minimalPath)) {
    t.skip(`node resolves under ${minimalPath}, so this control cannot fail here`);
    return;
  }
  const f = await fixture();
  try {
    const r = await runInstall(f, { path: minimalPath });
    assert.notEqual(r.code, 0, `a missing node must fail the install\n${r.out}`);
    assert.match(r.out, /INSTALL FAILED|node/i);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
