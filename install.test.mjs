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

    // The ONE control that can catch install.sh's shell `CONTENT_DIGEST` and work-runner's
    // `aggregateDigest()` drifting apart. `work-runner.test.mjs` pins the JS side against a
    // hand-computed constant, which fixes the wire format but says nothing about what the SHELL wrote —
    // and the comment above `aggregateDigest` claimed a test recomputing from a real manifest's own
    // files map that did not exist. Two definitions of one digest that disagree would make every
    // cross-host comparison report drift between byte-identical installs: a check that cannot say clean.
    const { aggregateDigest } = await import("./skills/work/work-runner.mjs");
    const man = JSON.parse(await readFile(join(dest, "INSTALL-MANIFEST.json"), "utf8"));
    assert.equal(man.content_digest, aggregateDigest(man.files),
      "install.sh's CONTENT_DIGEST must equal aggregateDigest() recomputed from the manifest's own files map");
    assert.ok(Object.keys(man.files).length > 15,
      `and it must be a real payload, not an empty map that agrees vacuously (${Object.keys(man.files).length} files)`);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("install.sh: a payload filename the manifest cannot encode is REFUSED, not silently corrupted", async () => {
  // Both spellings were reproduced against this installer and both failed at EXIT 0 with a manifest that
  // looked well-formed:
  //   `skills/work/notes:draft.md` -> `awk -F:` split on the first colon, recording the key
  //      "skills/work/notes" with the VALUE "draft.md" where a sha256 belongs. A clean install then
  //      re-measures as PERMANENT drift, because the two sides disagree on what the line even means.
  //   `skills/work/say"hi.md`      -> emitted raw into the JSON, producing a manifest that does not
  //      parse. `measureHarnessDrift` returns `absent` — an install that cannot attest to itself.
  // The payload is repo-controlled, so this fails closed at the source rather than growing an escaping
  // layer that `aggregateDigest` would then have to mirror byte-for-byte.
  for (const [label, name] of [["colon", "notes:draft.md"], ["quote", 'say"hi.md']]) {
    const f = await fixture();
    try {
      await writeFile(join(f.src, "skills", "work", name), "payload\n", "utf8");
      const r = await runInstall(f);
      assert.notEqual(r.code, 0, `a ${label} in a shipped filename must refuse the install\n${r.out}`);
      assert.match(r.out, /INSTALL FAILED/i);
      assert.match(r.out, /cannot encode unambiguously/);
      await assert.rejects(readFile(join(f.dest, "INSTALL-MANIFEST.json")),
        `no manifest may be written for a ${label} payload — a corrupt one reads as drift or as absent, both silently`);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }

  // THE CONTROL: the same fixture without the offending file must still install, so the guard is proven
  // to key on the filename rather than on anything else about the tree.
  const clean = await fixture();
  try {
    const r = await runInstall(clean);
    assert.equal(r.code, 0, `control: a clean payload must still install\n${r.out}`);
    const man = JSON.parse(await readFile(join(clean.dest, "INSTALL-MANIFEST.json"), "utf8"));
    assert.ok(Object.keys(man.files).length > 0);
  } finally {
    await rm(clean.dir, { recursive: true, force: true });
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DER-3008 — the aggregate content_digest could never match across two hosts.
//
// `~/.claude/skills` is a SHARED directory. install.sh's digest used to walk `find skills hooks -type f`
// under $DEST, so it hashed every skill the operator keeps there — 798 files on this MacBook (email
// skills, hyperframes symlinks, __pycache__) against 4 on the mini. Measured 2026-08-01 with both hosts
// at 0.4.0 from source_commit 0ba513f and every harness-suite file byte-identical: MacBook
// f18703c0bca0… vs mini a1cc1fae4a5c…. `preflight`'s `harness-digest:<host>` compares exactly that
// aggregate, so a known-good deploy would have printed "CONTENT DRIFT — SAME VERSION STRING, DIFFERENT
// CODE" — and a gate that reds on a correct deploy is one that gets waved past.

// The whole-tree definition this change replaced. Kept as the CONTROL: without it these tests would pass
// against an implementation that never had the bug and could not show the fixture models the failure.
async function legacyWholeTreeDigest(dest) {
  const { readdir } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const lines = [];
  const walk = async (rel) => {
    let entries;
    try { entries = await readdir(join(dest, rel), { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const child = `${rel}/${ent.name}`;
      if (ent.isDirectory()) await walk(child);
      else if (ent.isFile()) lines.push(`${child}:${createHash("sha256").update(await readFile(join(dest, child))).digest("hex")}`);
    }
  };
  await walk("skills");
  await walk("hooks");
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

async function seedUnrelatedSkills(dest, n) {
  for (let i = 0; i < n; i += 1) {
    await mkdir(join(dest, "skills", `unrelated-skill-${i}`), { recursive: true });
    await writeFile(join(dest, "skills", `unrelated-skill-${i}`, "SKILL.md"), `# an unrelated skill ${i}\n`, "utf8");
  }
}

test("install.sh: two hosts with different unrelated ~/.claude/skills populations get the SAME content_digest", async () => {
  const f = await fixture();
  const destB = join(f.dir, "claude-home-b");
  try {
    // The live shape: one host crowded with co-tenant skills, one nearly bare, identical harness payload.
    await mkdir(join(f.dest, "skills"), { recursive: true });
    await mkdir(join(destB, "skills"), { recursive: true });
    await seedUnrelatedSkills(f.dest, 60);
    await seedUnrelatedSkills(destB, 2);

    const a = await runInstall(f);
    assert.equal(a.code, 0, a.out);
    const b = await runInstall({ src: f.src, dest: destB });
    assert.equal(b.code, 0, b.out);

    const manA = JSON.parse(await readFile(join(f.dest, "INSTALL-MANIFEST.json"), "utf8"));
    const manB = JSON.parse(await readFile(join(destB, "INSTALL-MANIFEST.json"), "utf8"));

    // THE CONTROL, asserted first: under the OLD definition these two hosts MUST disagree. If they
    // agree, the fixture no longer models the defect and the assertion below proves nothing.
    assert.notEqual(
      await legacyWholeTreeDigest(f.dest),
      await legacyWholeTreeDigest(destB),
      "control: the old whole-tree digest must still differ between these two fixtures",
    );

    assert.equal(manA.content_digest, manB.content_digest,
      "two correctly-installed hosts must agree no matter what else lives in ~/.claude/skills");

    // …and the digest is not vacuously equal because it covers nothing: it covers the whole payload.
    assert.ok(Object.keys(manA.files).length >= 9, `expected the whole shipped payload in files, got ${Object.keys(manA.files).length}`);
    assert.ok("VERSION" in manA.files, "VERSION is shipped, so it is attested — a hand-edited $DEST/VERSION must read as MODIFIED");
    assert.ok(!Object.keys(manA.files).some((p) => p.includes("unrelated-skill")),
      "a co-tenant skill must never enter the harness manifest");
    assert.equal(manA.manifest_schema, 2, "the schema number is what lets a v1 host be told apart from drift");
    assert.deepEqual(manA.roots, manB.roots);
    assert.ok(manA.roots.includes("skills/work"), `roots must name the shipped territory, got ${JSON.stringify(manA.roots)}`);
    assert.ok(!manA.roots.includes("skills"), "an unscoped `skills` root would pull all 60 co-tenants back in");
    assert.ok(manA.roots.includes("hooks/context-wrap-nudge.mjs"),
      "hook roots are per-FILE: ~/.claude/hooks is shared, and a co-tenant's hook is not harness drift");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("install.sh: a shipped file that does not LAND fails the install instead of quietly shortening the manifest", async () => {
  // The measure-what-landed property. The file list now comes from $SRC, so a `cp` that silently dropped
  // a file could have produced a perfectly well-formed manifest that simply never mentioned it — the
  // exact false-attestation the $DEST walk existed to prevent. Every hash is still taken at $DEST, and a
  // file with no hash fails by name.
  //
  // Proven by MUTATION: the same fixture is installed twice, once with install.sh's hooks copy removed.
  // The un-mutated control must pass, so the failure is attributable to the dropped file and not to the
  // fixture.
  const control = await fixture();
  try {
    const ok = await runInstall(control);
    assert.equal(ok.code, 0, `control: an unmutated install must succeed\n${ok.out}`);
  } finally {
    await rm(control.dir, { recursive: true, force: true });
  }

  const f = await fixture();
  try {
    const sh = await readFile(join(f.src, "install.sh"), "utf8");
    const cpLine = 'cp -R "$SRC/hooks/."  "$DEST/hooks/"';
    assert.ok(sh.includes(cpLine), "the mutation must match install.sh's real copy line, or this test mutates nothing");
    await writeFile(join(f.src, "install.sh"), sh.replace(cpLine, "# MUTATION: the hooks copy silently does nothing"), "utf8");

    const r = await runInstall(f);
    assert.notEqual(r.code, 0, `a shipped file that never landed must fail the install\n${r.out}`);
    assert.match(r.out, /INSTALL FAILED/i);
    assert.match(r.out, /context-wrap-nudge\.mjs/, "and must name the file that did not land");
    await assert.rejects(readFile(join(f.dest, "INSTALL-MANIFEST.json")),
      "no manifest may be written when the tree it would attest to is incomplete");
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
