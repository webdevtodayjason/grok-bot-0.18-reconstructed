// MEM-2. Three lines in the memory prompt and one in the extraction prompt, behind
// SAND_MEMORY_PROMPT_V2, off unless a box sets it.
//
// The case that matters most is the first one. A gate run set a floor against the prompt as it is
// today, and a comparison against that floor only means anything if the flag being off leaves that
// prompt untouched to the byte. So the off case is pinned as a literal rather than as "does not
// contain the new lines": a stray space or a reordered sentence would pass that weaker check and
// quietly invalidate every before-and-after this feature is for.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".memory-prompt-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const built = await build({
  entryPoints: [path.join(repoRoot, "source/host/runner/sand-memory.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser"], logLevel: "silent",
});
const bundlePath = path.join(stage, "sand-memory.cjs");
writeFileSync(bundlePath, built.outputFiles[0].text, "utf8");
const memory = createRequire(import.meta.url)(bundlePath);

const RECALL = {
  profile: [{ kind: "profile", content: "The user's name is Marta Quill.", createdAt: Date.parse("2026-09-01T00:00:00Z") }],
  recent: [{ kind: "log", content: "Ticket FD-4471 was opened for the trailer telematics outage.", createdAt: Date.parse("2026-09-05T00:00:00Z") }],
};

/** The prompt as it stands today, byte for byte, with no location line. */
const PROMPT_TODAY = [
  "Memory: durable facts you have learned about the user and their world.",
  "These persist across every conversation with this agent, even after the chat is cleared. Rely on them so you stay consistent and avoid re-asking what you already know.",
  "About the user:",
  "- (learned 2026-09-01) The user's name is Marta Quill.",
  "Recently:",
  "- (learned 2026-09-05) Ticket FD-4471 was opened for the trailer telematics outage.",
].join("\n");

const withFlag = (value, run) => {
  const previous = process.env.SAND_MEMORY_PROMPT_V2;
  if (value === undefined) delete process.env.SAND_MEMORY_PROMPT_V2;
  else process.env.SAND_MEMORY_PROMPT_V2 = value;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.SAND_MEMORY_PROMPT_V2;
    else process.env.SAND_MEMORY_PROMPT_V2 = previous;
  }
};

test("with the flag off the memory prompt is byte-identical to today's", () => {
  withFlag(undefined, () => {
    assert.equal(memory.renderMemorySystemPrompt(RECALL), PROMPT_TODAY);
  });
  // Explicitly off is the same as absent: a box that turned it off gets the floor's prompt back.
  withFlag("0", () => {
    assert.equal(memory.renderMemorySystemPrompt(RECALL), PROMPT_TODAY);
  });
});

test("with the flag on the three lines are appended and nothing above them moves", () => {
  withFlag("1", () => {
    const rendered = memory.renderMemorySystemPrompt(RECALL);
    assert.ok(rendered.startsWith(PROMPT_TODAY), "the prompt that set the floor is still the head of this one");
    assert.equal(rendered, [PROMPT_TODAY, ...memory.MEMORY_PROMPT_V2_LINES].join("\n"));
    assert.equal(memory.MEMORY_PROMPT_V2_LINES.length, 3);
    assert.match(rendered, /never present a remembered value as current/);
    assert.match(rendered, /Never write keys, passwords, tokens or credential material into memory/);
    assert.match(rendered, /a live board wins over all of them for current state/);
  });
});

test("the three lines are plain sentences, not stamps that read as errors", () => {
  for (const line of memory.MEMORY_PROMPT_V2_LINES) {
    assert.ok(!/^[A-Z][A-Z_ -]{3,}:/.test(line), `no shouted prefix in ${JSON.stringify(line.slice(0, 40))}`);
    assert.ok(!line.includes("—"), "no em dashes: a person reads this product's prompts");
    assert.ok(/[.]$/.test(line), "a full sentence, ending in a full stop");
  }
});

test("the extraction prompt carries the no-secrets rule only with the flag on", () => {
  const off = withFlag(undefined, () => memory.buildExtractionSystemPrompt());
  const on = withFlag("1", () => memory.buildExtractionSystemPrompt());
  assert.ok(!off.includes(memory.MEMORY_EXTRACTION_V2_LINE), "off is the prompt that set the floor");
  assert.ok(on.includes(memory.MEMORY_EXTRACTION_V2_LINE), "on tells the writer not to write a credential");
  assert.ok(on.startsWith(off), "the rule is appended; nothing above it moves");
});

test("an empty recall with no location still renders nothing, flag or no flag", () => {
  // The early return happens before the flag is read, so a box with no memory yet is unchanged.
  for (const value of [undefined, "1"]) {
    withFlag(value, () => {
      assert.equal(memory.renderMemorySystemPrompt({ profile: [], recent: [] }), "");
    });
  }
});
