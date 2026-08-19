// Controls for run-gate.sh — the launcher whose three recurring defects were all "checks that could not
// fail". Each test below drives the REAL script with a stubbed `gh`/`codex`/`claude` on PATH, so what is
// asserted is the script's behaviour, not a re-implementation of its logic in the test.
//
// The three defects, each with a control that must return the FAILING answer:
//   1. completeness by file existence  -> a 0-byte lens output must NOT count as a verdict
//   2. no head re-bind                 -> a head that moves mid-gate must produce verdict=stale
//   3. no manifest                     -> the lenses actually started must be recorded

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "run-gate.sh");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

// A fake bin dir placed FIRST on PATH. `gh` prints whatever head the scenario wants; `codex` and
// `claude` are scripted per test.
async function fakeBin(dir, { ghHeads = [SHA_A], codex = null, claude = null } = {}) {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  // `gh` walks a list of heads, one per invocation, so a test can make the head MOVE between the
  // start-bind and the end-bind. A single fixed value could never exercise the stale path.
  await writeFile(join(bin, "gh"), [
    "#!/bin/bash",
    `HEADS=(${ghHeads.join(" ")})`,
    `N_FILE="${join(dir, "gh.calls")}"`,
    'n=$(cat "$N_FILE" 2>/dev/null || echo 0)',
    'echo $((n+1)) > "$N_FILE"',
    'idx=$n; last=$(( ${#HEADS[@]} - 1 )); [ "$idx" -gt "$last" ] && idx=$last',
    'echo "${HEADS[$idx]}"',
  ].join("\n"), "utf8");
  await chmod(join(bin, "gh"), 0o755);

  await writeFile(join(bin, "codex"), codex ?? ["#!/bin/bash", "exit 127"].join("\n"), "utf8");
  await chmod(join(bin, "codex"), 0o755);

  await writeFile(join(bin, "claude"), claude ?? ["#!/bin/bash", "exit 127"].join("\n"), "utf8");
  await chmod(join(bin, "claude"), 0o755);
  return bin;
}

// A stub runner that emits a non-empty prompt for any lens, so prompt rendering is never the reason a
// scenario fails. `node <runner> panel-prompt --issue X --lens L --diff D`
async function fakeRunner(dir) {
  const p = join(dir, "runner.mjs");
  await writeFile(p, `console.log("PROMPT for lens " + process.argv[process.argv.indexOf("--lens")+1]);`, "utf8");
  return p;
}

async function scenario(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "run-gate-"));
  const tree = join(dir, "tree");
  await mkdir(tree, { recursive: true });
  const bin = await fakeBin(dir, opts);
  const runner = await fakeRunner(dir);
  // `contract: "<text>"` writes a contract file and passes --contract for it. Kept beside the other
  // stubs so a scenario states its scope in one place rather than juggling paths in extraArgs.
  const contractArgs = [];
  if (opts.contract) {
    const cf = join(dir, "contract.md");
    await writeFile(cf, opts.contract, "utf8");
    contractArgs.push("--contract", cf);
  }
  const res = spawnSync("bash", [GATE,
    "--pr", "1293", "--repo", "o/r", "--sha", opts.sha ?? SHA_A, "--tree", tree,
    "--round", "1", "--issue", "DER-1", "--runner", runner,
    ...contractArgs,
    ...(opts.extraArgs ?? []),
  ], {
    encoding: "utf8",
    // MEMGATE off: its default is a 15-minute block PER LENS on a memory-starved box, which made the
    // first version of this file hang for 45 minutes without emitting one assertion.
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      WORK_CODEX_BIN: "",
      WORK_GATE_MEMGATE_TRIES: "0",
      // Per-scenario scratch. The first CI run of this file failed only inside the installer smoke,
      // where several installs run the same suite against one fixed /tmp path — a collision the
      // script now makes impossible rather than one the test tiptoes around.
      WORK_GATE_SCRATCH: join(dir, "gate-scratch"),
      // Per-scenario env overrides, so a test can exercise the memgate itself rather than only ever
      // disabling it. Last-wins, so `env` can override the defaults above.
      ...(opts.env ?? {}),
    },
  });
  const D = join(dir, "gate-scratch");
  let verdict = null;
  if (existsSync(join(D, "gate-verdict.json"))) {
    verdict = JSON.parse(await readFile(join(D, "gate-verdict.json"), "utf8"));
  }
  let manifest = null;
  if (existsSync(join(D, "panel-manifest.json"))) {
    manifest = JSON.parse(await readFile(join(D, "panel-manifest.json"), "utf8"));
  }
  return { res, verdict, manifest, D, dir };
}

const CODEX_LIVE = [
  "#!/bin/bash",
  // Mimic the real invocation: --output-last-message <file>, JSONL on stdout.
  'out=""; while [ $# -gt 0 ]; do [ "$1" = "--output-last-message" ] && out="$2"; shift; done',
  'echo \'{"type":"item.completed","item":{"type":"command_execution","command":"rg -n x"}}\'',
  'echo \'{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\'',
  '[ -n "$out" ] && echo \'{"overall_correctness":"patch is incorrect","findings":[{"title":"t"}]}\' > "$out"',
  "exit 0",
].join("\n");

// A codex that DIES: exits 0 with no turn.completed. This is the shape the whole gate is written
// against — "a gate that dies exits 0".
const CODEX_DEAD = [
  "#!/bin/bash",
  "echo '{\"type\":\"thread.started\"}'",
  "exit 0",
].join("\n");

test("run-gate: codex produces the verdict and the panel is NOT run", async () => {
  const { res, verdict } = await scenario({ codex: CODEX_LIVE });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(verdict.gate, "codex");
  assert.equal(verdict.verdict, "ok");
  assert.match(res.stdout, /Panel NOT run/, "the whole point of the 2026-08-12 policy is that the panel does not also run");
  assert.doesNotMatch(res.stdout, /LENS_START/, "no lens may start when codex delivered");
});

test("run-gate: a codex run that EXITS 0 with no turn.completed is DEAD, not clean", async () => {
  // Panel also unavailable (claude exits 127), so the run must end unusable rather than pretend.
  const { res, verdict } = await scenario({ codex: CODEX_DEAD });
  assert.notEqual(res.status, 0, "a dead gate must NEVER exit 0 — that is the failure this file exists against");
  assert.match(res.stdout, /CODEX_DEAD/);
  assert.match(res.stdout, /it is NOT a clean PR/);
  assert.equal(verdict?.verdict, "incomplete");
});

test("run-gate: a 0-byte lens output does NOT count as a delivered verdict", async () => {
  // THE defect. `> $D/$L.out.json` creates the file before the agent runs; a file-existence count
  // reports 3-of-3 against a real roster of 0-of-3. This claude stub writes NOTHING and exits 0.
  const CLAUDE_SILENT = ["#!/bin/bash", "exit 0"].join("\n");
  const { res, verdict } = await scenario({ codex: CODEX_DEAD, claude: CLAUDE_SILENT });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /OUTS_NONEMPTY=0/, "empty outputs must be counted as empty, not as delivered");
  assert.match(res.stdout, /PROMPTS=3/, "…while the prompts really were rendered — the two counts must be reported SEPARATELY");
  assert.equal(verdict.verdict, "incomplete");
});

test("run-gate: a QUOTA-WALLED lens (is_error, subtype success) is refused despite being well-formed", async () => {
  // The dangerous shape: a limit-killed lens returns a well-formed envelope with top-level
  // subtype:"success". Only is_error and the byte count separate it from a real verdict.
  const CLAUDE_WALLED = [
    "#!/bin/bash",
    `echo '{"subtype":"success","is_error":true,"result":"You have hit your weekly limit"}'`,
    "exit 0",
  ].join("\n");
  const { res, verdict } = await scenario({ codex: CODEX_DEAD, claude: CLAUDE_WALLED });
  assert.notEqual(res.status, 0, "a walled panel must not read as a clean one");
  assert.match(res.stdout, /WALLED=3/);
  assert.match(res.stdout, /is_error/);
  assert.equal(verdict.verdict, "incomplete");
});

test("run-gate: a head that MOVES during the gate produces verdict=stale, not a verdict", async () => {
  // Six verdicts shipped stale because the lens's own `git rev-parse HEAD` ran in a detached clone
  // whose origin is a local path — a check that cannot fail. The launcher reads GitHub, so it can.
  const { res, verdict } = await scenario({ codex: CODEX_LIVE, ghHeads: [SHA_A, SHA_B] });
  assert.notEqual(res.status, 0);
  assert.equal(verdict.verdict, "stale");
  assert.equal(verdict.reviewed, SHA_A);
  assert.equal(verdict.head, SHA_B);
  assert.equal(verdict.phase, "end", "the move must be caught at the END bind — binding only at the start is what failed 6 times");
});

test("run-gate: CONTROL — an unmoved head does NOT produce stale", async () => {
  // Without this the stale check might simply fire always, which would be indistinguishable from
  // working and would block every good gate.
  const { verdict } = await scenario({ codex: CODEX_LIVE, ghHeads: [SHA_A, SHA_A] });
  assert.equal(verdict.verdict, "ok", "a stationary head must pass — a check that always fails is not a check");
});

test("run-gate: refuses to START on a sha that is already not the head", async () => {
  const { res, verdict } = await scenario({ codex: CODEX_LIVE, ghHeads: [SHA_B] });
  assert.notEqual(res.status, 0);
  assert.equal(verdict.phase, "start");
});

test("run-gate: writes a panel-manifest of the lenses actually STARTED", async () => {
  const CLAUDE_OK = [
    "#!/bin/bash",
    `printf '{"subtype":"success","is_error":false,"result":"%s"}' "$(head -c 3000 /dev/zero | tr '\\0' 'x')"`,
    "exit 0",
  ].join("\n");
  const { manifest } = await scenario({ codex: CODEX_DEAD, claude: CLAUDE_OK, extraArgs: ["--lenses", "correctness security"] });
  assert.deepEqual(manifest.lenses_started, ["correctness", "security"],
    "a brief that claims 3 lenses when 1 ran is undetectable from inside a lens — the manifest is the only fix");
});

test("run-gate: --sha shorter than 40 chars is refused", async () => {
  const { res } = await scenario({ codex: CODEX_LIVE, sha: "abc123def" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /40-char/);
});

test("run-gate: drops a REVIEW-TARGET identity file in the tree", async () => {
  const { dir } = await scenario({ codex: CODEX_LIVE });
  const rt = await readFile(join(dir, "tree", "REVIEW-TARGET"), "utf8");
  assert.match(rt, /pr=1293/);
  assert.match(rt, new RegExp(`reviewed_sha=${SHA_A}`), "lens trees were POOLED across PRs; the tree name lies, so the identity must be IN the tree");
  await rm(dir, { recursive: true, force: true });
});

// ── DER-4055: the scope contract (§0.3) and test evidence (§0.4) ──────────────────────────────────
// These flags shipped 2026-08-15 into ~/.claude and were never committed here, so `install.sh` —
// a one-way `cp -R skills/. $DEST/skills/` — reverted them on its next run. Three units were then
// gated with no in_scope / known_dependent_units / ship_blocking_rule for a day, and no surface
// showed it: an unscoped round exits 0 with a well-formed high-confidence payload. These controls
// are what make the same revert red in CI rather than in a review round.

const CONTRACT_BODY = [
  "in_scope: the widget loader and its two callers",
  "known_dependent_units: DER-9999 (the other loader — filed, named in the body)",
].join("\n");

test("run-gate: --contract appends the scope block and the RECEIPT says it was applied", async () => {
  const { res, verdict, D, dir } = await scenario({
    codex: CODEX_LIVE,
    contract: CONTRACT_BODY,
  });
  assert.equal(res.status, 0, res.stderr);
  const prompt = await readFile(join(D, "codex.prompt.md"), "utf8");
  assert.match(prompt, /in_scope: the widget loader/, "the unit's own scope must reach the reviewer");
  assert.match(prompt, /known_dependent_units: DER-9999/);
  assert.match(prompt, /ship_blocking_rule: a P1 must demonstrate/,
    "the downgrade rule is the half that stops an already-owned follow-up arriving as a P1");
  assert.equal(verdict.scope_contract, "applied",
    "the receipt must be able to state that the round WAS briefed — that is the whole DER-4055 fix");
  assert.match(res.stdout, /CONTRACT_APPENDED/);
  await rm(dir, { recursive: true, force: true });
});

test("run-gate: CONTROL — with NO --contract the block is absent and the receipt SAYS so", async () => {
  // The control that can return the failing answer. If run-gate.sh is ever reverted to a build
  // without --contract, the test above fails; if the flag survives but silently no-ops, this one
  // catches it by pinning the negative. Both directions were unobservable on 2026-08-18.
  const { res, verdict, D, dir } = await scenario({ codex: CODEX_LIVE });
  assert.equal(res.status, 0, res.stderr);
  const prompt = await readFile(join(D, "codex.prompt.md"), "utf8");
  assert.doesNotMatch(prompt, /ship_blocking_rule/, "an unbriefed round must not look briefed");
  assert.equal(verdict.scope_contract, "absent");
  assert.match(res.stdout, /CONTRACT_ABSENT/,
    "silence is what let three units gate unscoped for a day; the unscoped state must be LOUD");
  await rm(dir, { recursive: true, force: true });
});

test("run-gate: --contract naming a missing file is a hard error, never a silent unscoped gate", async () => {
  const { res, dir } = await scenario({
    codex: CODEX_LIVE,
    extraArgs: ["--contract", "/nonexistent/contract.md"],
  });
  assert.equal(res.status, 1, "a named-but-absent contract must refuse, not fall through to an unscoped review");
  assert.match(res.stdout, /CONTRACT_MISSING/);
  await rm(dir, { recursive: true, force: true });
});

test("run-gate: --tests refuses to attach evidence from a tree that is not at the reviewed sha", async () => {
  // The scenario tree is not a git checkout, so `git rev-parse HEAD` yields nothing — which is
  // exactly the "tree HEAD is not the reviewed sha" case. Attaching a green suite run against the
  // wrong code is a green from an adjacent question.
  const { res, verdict, D, dir } = await scenario({
    codex: CODEX_LIVE,
    extraArgs: ["--tests", "packages/web/src/thing.test.ts"],
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /TESTS_SKIPPED/);
  assert.equal(verdict.test_evidence, "skipped-wrong-sha");
  const prompt = await readFile(join(D, "codex.prompt.md"), "utf8");
  assert.doesNotMatch(prompt, /Executed test evidence/,
    "no evidence section may appear when the suites were never run at the reviewed head");
  await rm(dir, { recursive: true, force: true });
});

test("run-gate: STALE_AT_START exits 2 — the refusal code, not the success code", async () => {
  // DER-4055 was filed claiming this path returns 0. It does not, and never did: measured here with
  // a `gh` that reports a DIFFERENT head than --sha. Pinned by exact code because "non-zero" would
  // not distinguish exit 1 (usage) from exit 2 (no usable verdict), and the caller branches on it.
  const { res, verdict, dir } = await scenario({ codex: CODEX_LIVE, ghHeads: [SHA_B] });
  assert.equal(res.status, 2, "a gate that refuses to start must report 'no usable verdict', not success");
  assert.equal(verdict.verdict, "stale");
  assert.equal(verdict.phase, "start");
  await rm(dir, { recursive: true, force: true });
});

test("run-gate: PANEL lenses get the SAME scope contract as codex", async () => {
  // Added 2026-08-19. The contract was appended to the codex prompt only, so a round that fell back
  // to the panel — the leg that costs ~$17 rather than ~$0 — reviewed UNSCOPED while the receipt still
  // said `scope_contract: applied`. Both legs now call one `append_contract`, and this pins it: codex
  // is dead here, so the panel is what runs, and every lens prompt must carry the block.
  const CLAUDE_OK = [
    "#!/bin/bash",
    `printf '{"subtype":"success","is_error":false,"result":"%s"}' "$(head -c 3000 /dev/zero | tr '\\0' 'x')"`,
    "exit 0",
  ].join("\n");
  const { res, verdict, D, dir } = await scenario({
    codex: CODEX_DEAD,
    claude: CLAUDE_OK,
    contract: CONTRACT_BODY,
    extraArgs: ["--lenses", "correctness security"],
  });
  assert.equal(res.status, 0, res.stderr);
  for (const lens of ["correctness", "security"]) {
    const prompt = await readFile(join(D, `${lens}.prompt.md`), "utf8");
    assert.match(prompt, /in_scope: the widget loader/, `${lens} must be told what is in scope`);
    assert.match(prompt, /ship_blocking_rule: a P1 must demonstrate/,
      `${lens} must get the downgrade rule — without it an already-owned dependent unit's file arrives as a P1`);
  }
  assert.equal(verdict.gate, "panel");
  assert.equal(verdict.scope_contract, "applied",
    "the panel receipt must carry the same provenance the codex receipt does");
  await rm(dir, { recursive: true, force: true });
});

test("run-gate: CONTROL — an unbriefed PANEL round says so in its receipt", async () => {
  const CLAUDE_OK = [
    "#!/bin/bash",
    `printf '{"subtype":"success","is_error":false,"result":"%s"}' "$(head -c 3000 /dev/zero | tr '\\0' 'x')"`,
    "exit 0",
  ].join("\n");
  const { verdict, D, dir } = await scenario({
    codex: CODEX_DEAD, claude: CLAUDE_OK, extraArgs: ["--lenses", "correctness security"],
  });
  const prompt = await readFile(join(D, "correctness.prompt.md"), "utf8");
  assert.doesNotMatch(prompt, /ship_blocking_rule/, "no contract given means no block — the negative half");
  assert.equal(verdict.scope_contract, "absent",
    "a panel round with no contract must NOT record itself as briefed");
  await rm(dir, { recursive: true, force: true });
});


// ── DER-4055 sibling: the memgate had never once PASSED ───────────────────────────────────────────
// Every MEMGATE line ever logged on the operator's box was a TIMEOUT (freeRAM 15/19/33MB) because it
// read `vm_stat`'s "Pages free", which macOS keeps near zero by design. It degenerated into a flat
// 15-min-per-lens sleep — 30 of 55 wall-clock minutes on #1357. A check that can never return its
// PASSING answer is as useless as one that can never fail, and worse than absent because it looks
// like protection. Both directions are pinned here; neither existed before, which is exactly why the
// defect survived. The first run of the CLEAR control immediately found a SECOND unmeetable
// condition (a hardcoded 900MB swap floor) that the RAM fix alone had left in place.

const CLAUDE_BIG = [
  "#!/bin/bash",
  `printf '{"subtype":"success","is_error":false,"result":"%s"}' "$(head -c 3000 /dev/zero | tr '\\0' 'x')"`,
  "exit 0",
].join("\n");

test("run-gate: memgate CLEARS on a healthy box — the passing path exists at all", async () => {
  const { res } = await scenario({
    codex: CODEX_DEAD, claude: CLAUDE_BIG, extraArgs: ["--lenses", "correctness security"],
    // Floors any machine running this suite clears. tries>0 so the gate really evaluates rather than
    // taking the SKIPPED shortcut — a skip would prove nothing about the passing path.
    env: {
      WORK_GATE_MEMGATE_TRIES: "3",
      WORK_GATE_MEMGATE_AVAIL_MB: "1",
      WORK_GATE_MEMGATE_SWAP_MB: "0",
    },
  });
  assert.match(res.stdout, /MEMGATE correctness clear availableRAM=\d+MB/,
    "the gate must be ABLE to report CLEAR — in production it never did, not once");
  assert.doesNotMatch(res.stdout, /MEMGATE correctness TIMEOUT/);
  assert.equal(res.status, 0, res.stderr);
});

test("run-gate: memgate TIMES OUT on an unreachable floor, names what blocked it, and proceeds", async () => {
  const { res } = await scenario({
    codex: CODEX_DEAD, claude: CLAUDE_BIG, extraArgs: ["--lenses", "correctness security"],
    // One try, so this costs 5s rather than 15 minutes: the OUTCOME is what is pinned, not duration.
    env: {
      WORK_GATE_MEMGATE_TRIES: "1",
      WORK_GATE_MEMGATE_AVAIL_MB: "99999999",
      WORK_GATE_MEMGATE_SWAP_MB: "0",
    },
  });
  assert.match(res.stdout, /MEMGATE correctness TIMEOUT blocked_by=availableRAM/,
    "a timed-out gate must name WHICH condition blocked — reporting both numbers and no verdict is how a 900MB swap floor hid behind a RAM fix");
  assert.match(res.stdout, /starting anyway/, "a starved box still gets a review, never a hang");
  assert.equal(res.status, 0, "the timeout is a warning, never a refusal");
});
