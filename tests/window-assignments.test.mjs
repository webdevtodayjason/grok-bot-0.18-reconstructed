// Who may hold a seat on the shared desktop.
//
// DISPLAY-1b. parseAssignments guarded the persisted file with a shape rule -- a leading
// alphanumeric plus seven or more id-ish characters -- and the comment beside it claimed that
// dropped the literal key "undefined". It did not: "undefined" is nine such characters, so the
// junk key loaded, took a window, and kept it. Both kinds of owner (an agent, and a
// sand-subagent-<uuid>) are minted from randomUUID, so these cases pin the id itself as the test.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/box/shared-desktop-sand-box.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  logLevel: "silent",
});
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".sand-window-assignments-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const bundlePath = path.join(stage, "shared-desktop-sand-box.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
const { parseAssignments } = createRequire(import.meta.url)(bundlePath);

const parse = (value, maxWindowCount = 8) =>
  parseAssignments(new TextEncoder().encode(JSON.stringify(value)), maxWindowCount);

const AGENT = "3882b623-02f3-40c0-b369-250b09162968";
const SUBAGENT = "sand-subagent-0006f5ea-59af-4d85-97e6-0881aef6adb4";

test('the literal key "undefined" never loads a window', () => {
  const parsed = parse({ assignments: { undefined: 2, [AGENT]: 3 } });
  assert.equal(parsed.assignments.has("undefined"), false);
  assert.equal(parsed.assignments.get(AGENT), 3);
});

test("an agent id and a sand-subagent id both load, with their tokens", () => {
  const parsed = parse({
    assignments: { [AGENT]: 2, [SUBAGENT]: 4 },
    tokens: { [AGENT]: "owner-token" },
  });
  assert.deepEqual([...parsed.assignments.entries()].sort(), [[AGENT, 2], [SUBAGENT, 4]].sort());
  assert.equal(parsed.tokens.get(AGENT), "owner-token");
  assert.equal(parsed.isCorrupt, false);
});

test("an id that is merely id-shaped is not an id", () => {
  const parsed = parse({
    assignments: { "null-agent-0000": 2, "Atera Triage": 3, "sand-subagent-undefined": 4 },
  });
  assert.equal(parsed.assignments.size, 0);
});
