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

const { dueAutomations, startLocalScheduleTick } = await loadSource("source/host/extensions/automations/local-schedule-tick.ts");

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

const { localScheduleRunUuid, stableAutomationId } = await loadSource("source/host/automations/automation-id.ts");

test("a slot's run id is the same every time it is derived", () => {
  const args = { agentId: "a1", localId: "r1", slotMs: 1_757_000_000_000 };
  assert.equal(localScheduleRunUuid(args), localScheduleRunUuid({ ...args }));
  assert.match(localScheduleRunUuid(args), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("a different slot, agent or routine is a different run", () => {
  const base = { agentId: "a1", localId: "r1", slotMs: 1_757_000_000_000 };
  const ids = new Set([base, { ...base, slotMs: base.slotMs + 60_000 }, { ...base, agentId: "a2" }, { ...base, localId: "r2" }].map(localScheduleRunUuid));
  assert.equal(ids.size, 4);
});

test("the automation id both helpers share still renders the value the cloud sync stores", () => {
  // Pinned: this id is the routine's identity in every telemetry row and cloud record already
  // written, so the shared renderer must not have moved it.
  assert.equal(stableAutomationId({ agentId: "a1", localId: "r1" }), "858cbe36-7679-5f19-98aa-1cd81d3431c4");
});

// The tick's own reporting. A fire that recorded nothing used to be logged as a fire, which is how
// a slot came to look served while its run history skipped it.
function fakePolling() {
  let run = async () => {};
  return { policy: { start: (fn) => { run = fn; return { dispose() {} }; } }, tick: () => run() };
}

test("the fire is handed the slot it is serving, and the log names the run", async () => {
  const { policy, tick } = fakePolling();
  const calls = [];
  const lines = [];
  startLocalScheduleTick({
    polling: policy,
    listAutomations: async () => [entry("r1")],
    fire: async (args) => { calls.push(args); return { runUuid: "run-uuid-1", fired: true }; },
    isReady: () => true,
    log: (line) => lines.push(line),
    now: () => 5000,
  });
  await tick();
  assert.deepEqual(calls, [{ agentId: "a1", automationId: "r1", slotMs: 1000 }]);
  assert.match(lines[0], /fired r1 on its schedule \(slot 1970-01-01T00:00:01\.000Z, run run-uuid-1\)/);
});

test("a fire that recorded nothing is logged as nothing, with the reason", async () => {
  const { policy, tick } = fakePolling();
  const lines = [];
  startLocalScheduleTick({
    polling: policy,
    listAutomations: async () => [entry("r1")],
    fire: async () => ({ runUuid: "run-uuid-1", fired: false, reason: "its definition could not be read" }),
    isReady: () => true,
    log: (line) => lines.push(line),
    now: () => 5000,
  });
  await tick();
  assert.match(lines[0], /recorded nothing: its definition could not be read/);
  assert.ok(!/^\[automations\] fired /.test(lines[0]), lines[0]);
});

test("the local tick's entry point fires as a schedule, not as a manual run", async () => {
  // The runtime imports the host graph, so the claim is pinned against the shipped source: the
  // whole finding was that this path reached runAgentAutomationNow, which hardcodes "manual".
  const runtime = await readFile(path.join(repoRoot, "source/host/extensions/transcript/automation-runtime.ts"), "utf8");
  const start = runtime.indexOf("async runLocalScheduledAutomation(");
  assert.ok(start > 0, "runLocalScheduledAutomation not found");
  const body = runtime.slice(start, runtime.indexOf("\n  runServerScheduledAutomation(", start));
  assert.match(body, /trigger: "schedule"/);
  assert.match(body, /runUuid,/);
  assert.match(body, /scheduledForMs: args\.slotMs/);
  assert.ok(!/"manual"/.test(body), "the scheduled path must not fire as manual");
  const extension = await readFile(path.join(repoRoot, "source/host/extensions/automations/extension.ts"), "utf8");
  assert.match(extension, /fire: \(args\) => deps\.transcript\.runLocalScheduledAutomation\(args\)/);
});
