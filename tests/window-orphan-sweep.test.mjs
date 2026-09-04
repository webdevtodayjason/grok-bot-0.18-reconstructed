// What happens to a desktop seat nobody is using.
//
// DISPLAY-5. An agent that never held a conversation is hidden from the roster, but the window
// allocator never heard of that test: the blank agent kept its assignment and cost an X server at
// every boot. DISPLAY-6. A seat can also outlive its assignment entirely (a bring-up that raced a
// delete), and every teardown path started from an assignment, so nothing ever stopped it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".sand-window-sweep-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const load = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const bundlePath = path.join(stage, `${name}.cjs`);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(bundlePath);
};
const { SharedDesktopSandBox } = await load("source/host/box/shared-desktop-sand-box.ts", "shared-desktop");
const { ForeverBoxService } = await load("source/host/extensions/forever-box/forever-box-service.ts", "forever-box-service");

const shellAccessor = (stdout) => ({ get: () => ({ execute: async () => ({ result: { case: "success", value: { exitCode: 0, stdout, stderr: "" } } }) }) });
const sharedBox = (tokenListing) => {
  const stopped = [];
  const inner = {
    maxWindows: () => 100,
    ensureReady: async () => ({ remoteAccessor: shellAccessor(tokenListing), vncUrl: "vnc://primary" }),
    ensureWindow: async (_ctx, _id, windowIndex) => ({ windowIndex, computerUse: {}, vncUrl: `vnc://${windowIndex}` }),
    releaseWindow: async (_ctx, _id, windowIndex) => { stopped.push(windowIndex); },
    runState: async () => "running",
    listBoxes: async () => [{ agentId: "shared", running: true }],
    uploadFile: async () => {},
    downloadFile: async () => new Uint8Array(),
  };
  return { box: new SharedDesktopSandBox(inner), stopped };
};

test("a seat with a token and no assignment is stopped; assigned and primary seats are left alone", async () => {
  const { box, stopped } = sharedBox("2\n3\n8\n1\n");
  assert.equal(box.takeFreeForkIndex("agent-a"), 2);
  assert.equal(box.takeFreeForkIndex("agent-b"), 3);
  assert.deepEqual(await box.sweepUnassignedWindows({}), [8]);
  assert.deepEqual(stopped, [8]);
});

test("a token directory that holds nothing but assigned seats stops nothing", async () => {
  const { box, stopped } = sharedBox("4\n");
  box.takeFreeForkIndex("agent-a");
  box.takeFreeForkIndex("agent-b");
  box.takeFreeForkIndex("agent-c"); // 2, 3, 4
  assert.deepEqual(await box.sweepUnassignedWindows({}), []);
  assert.deepEqual(stopped, []);
});

const AGENT = "3882b623-02f3-40c0-b369-250b09162968";
const BLANK = "12863856-fe88-43f4-851f-bcd270317bf6";
const SUBAGENT = "sand-subagent-0006f5ea-59af-4d85-97e6-0881aef6adb4";

const service = (options = {}) => {
  const released = [], sweeps = [];
  let clock = 1_000;
  const assigned = options.assigned ?? [AGENT, BLANK, SUBAGENT];
  const box = {
    subscribe: () => () => {},
    listAssignedAgentIds: () => assigned.filter((id) => !released.includes(id)),
    loadAssignments: options.loadAssignments ?? (async () => {}),
    sweepUnassignedWindows: async () => { sweeps.push(clock); return [8]; },
    releaseWindow: async (_ctx, agentId) => { released.push(agentId); },
    getStatus: async () => ({ agentId: "", state: "running", vncUrl: null }),
  };
  const deadline = { name: "test", run: (work, signal) => work(signal ?? new AbortController().signal) };
  const instance = new ForeverBoxService({
    box,
    lifecycleClient: { recreateInBox: async () => ({ started: false }), fetchImageUpdateAvailable: async () => undefined },
    trays: { pushError: () => {} },
    telemetry: { reportBoxRecreateDecided: () => {}, reportBoxImageCheck: () => {} },
    imagePolling: { name: "test", start: () => ({ dispose: () => {} }) },
    imagePollingStartDelay: { name: "test", schedule: () => ({ elapsed: Promise.resolve(), dispose: () => {} }), runWithRetry: async (work) => work(1, new AbortController().signal) },
    imageSeedRetry: { name: "test", schedule: () => ({ elapsed: Promise.resolve(), dispose: () => {} }), runWithRetry: async (work) => work(1, new AbortController().signal) },
    imageCheckDeadline: deadline,
    migrationExpiry: { name: "test", arm: () => ({ dispose: () => {} }) },
    screenshotDeadline: deadline,
    recreateFlushWaitDeadline: deadline,
    flushPendingUploads: async () => {},
    autoUpdateEnabled: false,
    hostBundleAutoUpdateEnabled: false,
    isInBox: () => false,
    log: () => {},
    now: () => clock,
  });
  after(() => instance.dispose());
  return { instance, released, sweeps, tick: (ms) => { clock += ms; } };
};

test("the window of an agent the roster hides is released; a visible agent and a subagent keep theirs", async () => {
  const { instance, released } = service();
  await instance.useRosterReader(async () => new Set([AGENT]));
  assert.deepEqual(released, [BLANK]);
});

test("no roster reader means no roster sweep: nothing is released on a guess", async () => {
  const { instance, released } = service();
  assert.equal(await instance.releaseWindowsWithoutConversation(), true);
  assert.deepEqual(released, []);
});

test("a box that cannot answer leaves every window alone and reports the sweep as unfinished", async () => {
  const { instance, released } = service({ loadAssignments: async () => { throw new Error("box is down"); } });
  const startSweep = instance.useRosterReader(async () => new Set([AGENT]));
  assert.equal(await instance.releaseWindowsWithoutConversation(), false);
  assert.deepEqual(released, []);
  instance.dispose(); // the start sweep is still waiting to try again; disposing is what stops it
  await startSweep;
});

test("the box sweep runs at most once a minute, however often a page asks for status", async () => {
  const { instance, sweeps, tick } = service({ assigned: [AGENT] });
  await instance.useRosterReader(async () => new Set([AGENT]));
  await instance.reconcileWindows();
  tick(59_000);
  await instance.reconcileWindows();
  assert.equal(sweeps.length, 1);
  tick(2_000);
  await instance.reconcileWindows();
  assert.equal(sweeps.length, 2);
});
