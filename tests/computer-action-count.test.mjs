// A Computer success reaches the audit with the actions it ran and the time they took.
//
// THE FAULT, measured on Jason's box 2026-09-16. `ComputerUseSuccessMessage` has carried
// `actionCount` and `durationMs` since it was generated, and nothing ever set them: the inner tool
// did not produce them and `toComputerUseMessage` did not copy them. So every Computer success in
// every audit read `actionCount: 0, durationMs: 0`, which is the protobuf's default for a field
// nobody writes and is indistinguishable from a real zero.
//
// It cost a real turn. Titan dispatched two computerUse subagents to check per-store TV stock, read
// those zeros as "wedged, not working", killed both, and filed a desktop incident. The screenshots
// in the same audit rows were changing throughout: 22 distinct screens across 28 calls on one
// subagent and 20 across 23 on the other, both stopped at exactly 535 s. The browser was up the
// whole time, `DISPLAY=:3` with Chrome answering on its debug port.
//
// So both halves are pinned here: the inner tool MEASURES, and the adapter CARRIES. Either one
// alone puts the zeros back.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".computer-action-count-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const require_ = createRequire(import.meta.url);
const bundle = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, name);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return require_(bundlePath);
};
const tool = await bundle("source/host/runner/tools/sand-computer-tool.ts", "sand-computer-tool.cjs");

/** Three actions, a screenshot back, and an executor that takes a measurable moment. */
const threeActions = { toolCallId: "call_1", actions: [{ action: {} }, { action: {} }, { action: {} }] };
const deps = (delayMs = 0) => ({
  resourceAccessor: { get: () => undefined },
  getPersistImage: () => undefined,
  async execute() {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { result: { case: "success", value: { screenshot: "AAAA" } } };
  },
});

test("the inner tool reports how many actions it ran", async () => {
  const result = await tool.executeAndPersistComputerUse({}, deps(), threeActions);
  assert.equal(result.result.case, "success");
  assert.equal(result.result.value.actionCount, 3, "three actions in, three reported");
  assert.equal(typeof result.result.value.durationMs, "number");
});

test("durationMs is the actions' own time, and it is not zero when they take time", async () => {
  const result = await tool.executeAndPersistComputerUse({}, deps(25), threeActions);
  assert.ok(result.result.value.durationMs >= 20,
    `an executor that took 25 ms reported ${result.result.value.durationMs} ms`);
  // A single screenshot is one action, not none. The Screenshot tool goes through the same path.
  const one = await tool.executeAndPersistComputerUse({}, deps(), { toolCallId: "c", actions: [{ action: {} }] });
  assert.equal(one.result.value.actionCount, 1);
});

test("an error result is untouched: nothing invents a count for a call that did nothing", async () => {
  const failing = { ...deps(), async execute() { return { result: { case: "error", value: { error: "the desktop said no" } } }; } };
  const result = await tool.executeAndPersistComputerUse({}, failing, threeActions);
  assert.equal(result.result.case, "error");
  assert.equal(result.result.value.actionCount, undefined);
});

test("the adapter carries both fields onto the message instead of dropping them", async () => {
  // The other half. The message has always had the two fields; this is the copy that was missing,
  // and it is asserted on the source because the adapter is private to the toolset module.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(path.join(repoRoot, "source/host/runner/tools/turn-toolset.ts"), "utf8");
  const at = source.indexOf("function toComputerUseMessage");
  assert.ok(at > 0, "the adapter is still here");
  const body = source.slice(at, source.indexOf("\nfunction ", at + 10));
  for (const field of ["screenshot", "screenshotPath", "log", "actionCount", "durationMs"]) {
    assert.match(body, new RegExp(`value\\.${field} == null \\? \\{\\} : \\{ ${field}:`),
      `${field} is copied onto the success message; a field left out defaults to the protobuf zero and reads as a measurement`);
  }
});

test("the protobuf really has the two fields, so this is a copy and not an invention", async () => {
  const { readFileSync } = await import("node:fs");
  const generated = readFileSync(path.join(repoRoot, "source/packages/proto/generated/agent/v1/computer_use_tool_pb.ts"), "utf8");
  assert.match(generated, /declare actionCount: number;/);
  assert.match(generated, /declare durationMs: number;/);
});
