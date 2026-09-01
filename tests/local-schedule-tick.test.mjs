import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The tick module imports only a type, so a single-file transform reaches the decision without
// pulling the host graph into the test process.
async function loadSource(relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const { dueAutomations } = await loadSource("source/host/extensions/automations/local-schedule-tick.ts");

const entry = (id, over) => ({ agentId: "a1", automation: { id, isEnabled: true, nextRunAt: 1000, runs: [], ...over } });

test("fires a routine whose slot has arrived", () => {
  assert.deepEqual(dueAutomations([entry("r1")], 1000, new Map()).map((d) => d.automationId), ["r1"]);
});

test("does not fire before the slot", () => {
  assert.deepEqual(dueAutomations([entry("r1")], 999, new Map()), []);
});

test("does not fire a disabled routine", () => {
  assert.deepEqual(dueAutomations([entry("r1", { isEnabled: false })], 5000, new Map()), []);
});

test("does not fire a routine with no schedule", () => {
  assert.deepEqual(dueAutomations([entry("r1", { nextRunAt: null })], 5000, new Map()), []);
});

test("fires each slot once", () => {
  const fired = new Map([["a1:r1", 1000]]);
  assert.deepEqual(dueAutomations([entry("r1")], 5000, fired), []);
});

test("fires again once the slot advances", () => {
  const fired = new Map([["a1:r1", 1000]]);
  assert.deepEqual(dueAutomations([entry("r1", { nextRunAt: 2000 })], 5000, fired).map((d) => d.slot), [2000]);
});

test("a restart does not re-fire a slot already recorded in run history", () => {
  const entries = [entry("r1", { runs: [{ startedAt: 1000 }] })];
  assert.deepEqual(dueAutomations(entries, 5000, new Map()), []);
});

test("run history older than the slot does not suppress the fire", () => {
  const entries = [entry("r1", { runs: [{ startedAt: 999 }] })];
  assert.deepEqual(dueAutomations(entries, 5000, new Map()).map((d) => d.automationId), ["r1"]);
});
