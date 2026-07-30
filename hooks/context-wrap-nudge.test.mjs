// Unit/integration tests for hooks/context-wrap-nudge.mjs — run with:
//   node --test hooks/context-wrap-nudge.test.mjs
//
// DER-2581 — "Context wrap-nudge over-reads orch/shepherd ~1.8x vs the context_report hook — caused a
// premature shepherd rotation." Reproduced fresh the night this fix was written: THIS orchestrator
// session runs on a model with a real 1,000,000-token window (Sonnet 5), and the hook fired twice
// reporting "≈ 70% of the 200K-token window (~139K tokens)" and later "≈ 82% of the 200K-token window
// (~164K tokens)" — both computed against an assumed 200K window on a session that actually had 1M.
//
// Root cause, confirmed against the code: `contextWindowFor` resolves the window from the MOST RECENT
// usage-bearing transcript line's `message.model`. That line is not always the orch/shepherd's OWN
// turn — a background/subagent usage record can be the last "usage"-bearing line in the same
// transcript file, and its model tells you nothing about the parent session's window. When the
// transcript-observed model doesn't resolve to a known-1M family, the OLD fallback re-tested
// `settingsModel()` (the operator's `~/.claude/settings.json`) for the "[1m]" MARKER ONLY — never for a
// model that is natively 1M with no marker (Sonnet 5 / Opus 5 / Fable 5 / Opus 4.6-4.8). So a session
// whose own settings.json correctly said `claude-sonnet-5` still fell through to the 200K default.
// 139K/200K ≈ 70% and 164K/200K ≈ 82% — exactly the two readings from tonight's log.
//
// The fix (`is1MWindow`, used identically against BOTH the transcript model and the settings-file
// model) closes that asymmetry. It stays an explicit allow-list rather than a loose pattern — SKILL.md
// already records the INVERSE error (a 270K `gpt-5.6-sol` lead once misread as a 1M window, masking a
// lead at 102% of its real capacity) — so the control below pins that a genuinely-shallow OR
// genuinely-deep session still reads correctly, in both directions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { is1MWindow, contextWindowFor, bandsFor } from "./context-wrap-nudge.mjs";

const HOOK_PATH = fileURLToPath(new URL("./context-wrap-nudge.mjs", import.meta.url));

function usageLine({ model, inputTokens, cacheRead = 0, cacheCreation = 0 }) {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    },
  });
}

// Spawns the REAL shipped hook (as Claude Code's UserPromptSubmit trigger actually does), with a
// crafted transcript and an isolated $HOME (so `~/.claude/settings.json` is fully controlled), and
// returns the `additionalContext` string it emitted — or null if it stayed silent.
async function runHook({ lines, settingsModel, role, env = {} }) {
  const workDir = await mkdtemp(join(tmpdir(), "der-2581-hook-"));
  const transcriptPath = join(workDir, "transcript.jsonl");
  await writeFile(transcriptPath, lines.join("\n") + "\n", "utf8");

  const home = await mkdtemp(join(tmpdir(), "der-2581-home-"));
  if (settingsModel != null) {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ model: settingsModel }),
      "utf8"
    );
  }

  const sessionId = randomUUID();
  const out = execFileSync("node", [HOOK_PATH], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath }),
    env: {
      ...process.env,
      HOME: home,
      WORK_ROLE: role,
      WRAP_NUDGE_WINDOW: "",
      WRAP_NUDGE_GENTLE: "",
      WRAP_NUDGE_STRONG: "",
      ...env,
    },
    encoding: "utf8",
  });

  await rm(workDir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });

  if (!out.trim()) return null;
  const parsed = JSON.parse(out);
  return parsed?.hookSpecificOutput?.additionalContext ?? null;
}

test("DER-2581 (must-fail on the unfixed hook): a 1M-window session whose last transcript line carries an unrelated (subagent) model must NOT be read as 82% of a 200K window", async () => {
  // The last usage-bearing line in the file is what a background/subagent turn would leave behind —
  // a model that resolves to neither "[1m]" nor a native-1M family. This is exactly the shape that
  // defeats the transcript-side check and forces the settings.json fallback.
  const lines = [
    usageLine({ model: "claude-sonnet-5-20260315", inputTokens: 5000 }),
    usageLine({ model: "claude-haiku-5-20260315", inputTokens: 164000 }), // 164K, matches tonight's log
  ];
  const msg = await runHook({ lines, settingsModel: "claude-sonnet-5" });

  assert.ok(
    !msg || !/200K-token window/.test(msg),
    `expected the real 1M window to be resolved via settings.json (native Sonnet 5), but got: ${msg}`
  );
  assert.ok(
    !msg || !/≈ 82%/.test(msg),
    `expected ~16% of a 1M window, not the 200K-assumption's 82%, but got: ${msg}`
  );
  // At 164K/1,000,000 ≈ 16%, this is well under even the 1M window's gentle (30%) band — no nudge at all.
  assert.equal(msg, null, `expected NO nudge at ~16% of the real 1M window, but got: ${msg}`);
});

test("DER-2581 control (inverse — must not degrade into 'never warn'): a genuinely-deep 1M-window session still nudges at the strong band", async () => {
  const lines = [
    usageLine({ model: "claude-sonnet-5-20260315", inputTokens: 480000 }), // 48% of 1M ≥ strong (45%)
  ];
  const msg = await runHook({ lines, settingsModel: "claude-sonnet-5" });

  assert.ok(msg, "expected a nudge for a session at 48% of its real 1M window");
  assert.match(msg, /≈ 48%/);
  assert.match(msg, /1000K-token window/);
  assert.match(msg, /quality degradation is likely/); // strong-band urgency text
});

test("DER-2581 control: a genuine 200K-window model (no native-1M marker) at high usage still nudges correctly", async () => {
  const lines = [
    usageLine({ model: "claude-sonnet-4-5-20250929", inputTokens: 170000 }), // 85% of 200K ≥ strong (80%)
  ];
  const msg = await runHook({ lines, settingsModel: "claude-sonnet-4-5" });

  assert.ok(msg, "expected a nudge for a session at 85% of its real 200K window");
  assert.match(msg, /≈ 85%/);
  assert.match(msg, /200K-token window/);
});

test("is1MWindow recognizes the native-1M families and the explicit [1m] marker", () => {
  assert.equal(is1MWindow("claude-sonnet-5-20260315"), true);
  assert.equal(is1MWindow("claude-opus-5-20260315"), true);
  assert.equal(is1MWindow("claude-fable-5-20260315"), true);
  assert.equal(is1MWindow("claude-opus-4-8"), true);
  assert.equal(is1MWindow("claude-opus-4-7"), true);
  assert.equal(is1MWindow("claude-opus-4-6"), true);
  assert.equal(is1MWindow("claude-opus-4-5[1m]"), true);
  assert.equal(is1MWindow("gpt-5.6-sol[1m]"), true);
});

test("is1MWindow does NOT match a decimal-generation model as a false positive (guards the INVERSE error)", () => {
  assert.equal(is1MWindow("claude-sonnet-4-5-20250929"), false); // Sonnet 4.5, 200K
  assert.equal(is1MWindow("claude-haiku-4-5-20251001"), false); // Haiku 4.5, 200K
  assert.equal(is1MWindow("gpt-5.6-sol"), false); // 270K lead model, no marker — SKILL.md's inverse case
  assert.equal(is1MWindow(""), false);
  assert.equal(is1MWindow(undefined), false);
});

test("contextWindowFor: transcript model wins outright when it resolves", () => {
  assert.equal(contextWindowFor("claude-sonnet-5-20260315", "claude-sonnet-4-5"), 1_000_000);
});

test("contextWindowFor: settings.json model is now tested with the SAME classifier as the transcript model (the DER-2581 fix)", () => {
  // Transcript model unresolved (e.g. a subagent's Haiku turn); settings.json correctly says Sonnet 5.
  assert.equal(contextWindowFor("claude-haiku-5", "claude-sonnet-5"), 1_000_000);
});

test("contextWindowFor: falls back to 200K only when NEITHER signal resolves to a known 1M family", () => {
  assert.equal(contextWindowFor("claude-haiku-5", "claude-sonnet-4-5"), 200_000);
  assert.equal(contextWindowFor("", ""), 200_000);
});

test("bandsFor still scales gentle/strong by window size (unchanged behavior)", () => {
  assert.deepEqual(bandsFor(1_000_000).map((b) => b.pct).sort((a, b) => a - b), [30, 45]);
  assert.deepEqual(bandsFor(200_000).map((b) => b.pct).sort((a, b) => a - b), [60, 80]);
});

// ---- DER-2581, class-level: the three window resolvers must AGREE ----------------------------------
// The issue's acceptance criterion is that the two instruments agree. There are actually THREE copies of
// the 1M predicate in the shipped harness — here, work-runner.mjs (`resolveContextWindow`, read by the
// `lead-context` pull probe), and session-context-report.mjs (the PostToolUse push hook). The two hooks
// duplicate it on purpose: each is spawned per prompt / per tool call, and importing a 4,900-line module
// to answer one predicate would put that parse on the hot path. Duplication is only safe if drift is
// caught, so this test IS the coupling.
import { is1MWindow as wrIs1M, resolveContextWindow } from "../skills/work/work-runner.mjs";
import { is1MWindow as reportIs1M } from "../skills/work/session-context-report.mjs";

test("DER-2581: all three 1M-window classifiers agree, in both directions", () => {
  const table = [
    // natively 1M, no marker — the whole defect: every copy tested for the marker ALONE
    ["claude-sonnet-5", true],
    ["claude-opus-5", true],
    ["claude-fable-5", true],
    ["claude-opus-4-6", true],
    ["claude-opus-4-7", true],
    ["claude-opus-4-8", true],
    // explicit marker still honoured
    ["claude-opus-5[1m]", true],
    ["some-future-model[1m]", true],
    // NOT 1M — an unrecognised id must resolve to the safe 200K, never optimistically to 1M. The inverse
    // error is on record: a 270K-window lead read as 28% of an assumed 1M and nothing ever fired.
    // The only current tier that is genuinely 200K. Everything else above is natively 1M — the `[1m]`
    // suffix is a deployment identifier, not the switch that grants the window.
    ["claude-haiku-4-5-20251001", false],
    ["claude-haiku-4-5", false],
    ["claude-3-5-sonnet", false],
    ["some-270k-proxy-model", false],
    ["", false],
  ];
  for (const [model, expected] of table) {
    assert.equal(is1MWindow(model), expected, `context-wrap-nudge disagrees on ${model || "(empty)"}`);
    assert.equal(wrIs1M(model), expected, `work-runner disagrees on ${model || "(empty)"}`);
    assert.equal(reportIs1M(model), expected, `session-context-report disagrees on ${model || "(empty)"}`);
  }
});

test("DER-2581: resolveContextWindow applies the same test to the SETTINGS model as to the observed one", () => {
  // The asymmetry WAS the bug: the observed-model path had grown a `sonnet-5` special case while the
  // settings path still tested `[1m]` alone — so an orch/shepherd (which has no observed lead model and
  // inherits the operator's settings) resolved to 200K on a 1M window.
  assert.equal(resolveContextWindow({ settingsModel: "claude-opus-5" }), 1_000_000);
  assert.equal(resolveContextWindow({ settingsModel: "claude-sonnet-5" }), 1_000_000);
  assert.equal(resolveContextWindow({ model: "claude-opus-5" }), 1_000_000);
  // Controls: a genuinely-200K model stays 200K on either path, and an explicit lead-type
  // contextWindow still wins over both (a 270K proxy lead must not be judged against 1M).
  assert.equal(resolveContextWindow({ settingsModel: "claude-haiku-5" }), 200_000);
  assert.equal(resolveContextWindow({ model: "claude-haiku-5" }), 200_000);
  assert.equal(resolveContextWindow({ leadTypeCfg: { contextWindow: 270_000 }, settingsModel: "claude-opus-5" }), 270_000);
});
