// ENV-1. Where an environment update actually lands.
//
// Measured on the Mac box 2026-09-06: setShellSecret answered {stored: true, applied: true}, the
// gateway's probeShellSecret agreed, and "Chief of staff" -- an agent with its own desktop window
// on display :4 -- ran `printenv VERIFY_ENV_3 | wc -c` through its shell tool and got 0. The box
// runs one exec daemon per open window (box-exec-daemon/server.ts, its own #environment), the
// window router sends that agent's every shell to its own daemon, and applyEnvironment pushed to
// the primary endpoint alone. Both the push and the probe were about a shell nobody was using.
//
// These cases pin the three parts that are pure: the push fans out and names what it could not
// reach, a window that starts later is given the stored credentials before it is handed back, and
// an agent's shell accessor is its WINDOW's, not the primary's. SECRET-2's refusal beat is here
// too, because an unresumed agent is the other half of the same honesty rule.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".env-fanout-test-"));
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

const { LoopbackSandBox } = await load("source/host/box/loopback-sand-box.ts", "loopback-sand-box");
const { SharedDesktopSandBox } = await load("source/host/box/shared-desktop-sand-box.ts", "shared-desktop");
const { HostBox } = await load("source/host/extensions/forever-box/host-box.ts", "host-box");
const widgets = await load("source/host/extensions/transcript/widget-responses.ts", "widget-responses");

const ctx = {};
const okShell = () => ({ result: { case: "success", value: { exitCode: 0, stdout: "", stderr: "" } } });

/**
 * A box with two exec daemons: the primary on 1337 and one window behind the 1339 router, which is
 * exactly the shape the live box has. Every push is recorded with the endpoint it reached, so
 * "the window was skipped" is a fact these tests state rather than infer.
 */
function fakeBox(overrides = {}) {
  const pushes = [], accessors = new Map();
  const box = new LoopbackSandBox({
    pollIntervalMs: 1,
    ...(overrides.storedEnvironment == null ? {} : { storedEnvironment: overrides.storedEnvironment }),
    operations: {
      ping: async () => ({ outcome: "ok" }),
      createRemoteAccessor: (endpoint) => {
        const key = `${endpoint.port}:${endpoint.headers?.["x-sand-display"] ?? "primary"}`;
        const accessor = accessors.get(key) ?? { key, get: () => ({ execute: async () => okShell() }) };
        accessors.set(key, accessor);
        return accessor;
      },
      protectRemoteAccessor: (accessor) => accessor,
      applyEnvironment: async (_ctx, endpoint, update) => {
        const display = endpoint.headers?.["x-sand-display"] ?? "primary";
        if (overrides.failWindow === display) throw new Error("the window daemon refused the update");
        pushes.push({ display, env: update.env });
      },
      sleep: async () => {},
    },
  });
  return { box, pushes };
}

test("ENV-1: an environment push reaches the primary daemon and every open window", async () => {
  const { box, pushes } = fakeBox();
  await box.ensureWindow(ctx, "agent-a", 4);
  await box.ensureWindow(ctx, "agent-b", 7);
  pushes.length = 0;

  const result = await box.applyEnvironment(ctx, { env: { VERIFY_ENV_3: "value" }, replace: false });

  assert.deepEqual(result, { applied: true, pendingWindows: [] });
  assert.deepEqual(pushes.map((push) => push.display).sort(), ["4", "7", "primary"]);
  for (const push of pushes) assert.deepEqual(push.env, { VERIFY_ENV_3: "value" });
});

test("ENV-1: a window that will not take the update is named, and applied is false", async () => {
  const { box, pushes } = fakeBox({ failWindow: "4" });
  await box.ensureWindow(ctx, "agent-a", 4);
  await box.ensureWindow(ctx, "agent-b", 7);
  pushes.length = 0;

  const result = await box.applyEnvironment(ctx, { env: { VERIFY_ENV_3: "value" }, replace: false });

  // Not swallowed, and not a thrown push either: the primary and the healthy window took it, and
  // the answer says which shell did not, because that is the shell an agent may be running in.
  assert.equal(result.applied, false);
  assert.deepEqual(result.pendingWindows, ["agent-a#4"]);
  assert.deepEqual(pushes.map((push) => push.display).sort(), ["7", "primary"]);
});

test("ENV-1: a window whose daemon has gone is reported and dropped, so the next open re-creates it", async () => {
  const { box } = fakeBox();
  await box.ensureWindow(ctx, "agent-a", 4);
  // The window was reachable when it opened; the ping in the fan-out is what finds it gone.
  box.options.operations.ping = async (_c, endpoint) => ({ outcome: endpoint.port === 1337 ? "ok" : "refused" });

  const result = await box.applyEnvironment(ctx, { env: { VERIFY_ENV_3: "value" }, replace: false });
  assert.equal(result.applied, false);
  assert.deepEqual(result.pendingWindows, ["agent-a#4"]);
  // A second push does not keep reporting a window nobody holds any more.
  const again = await box.applyEnvironment(ctx, { env: { VERIFY_ENV_3: "value" }, replace: false });
  assert.deepEqual(again, { applied: true, pendingWindows: [] });
});

test("ENV-1: a new window is given the stored shell credentials before it is handed back", async () => {
  const seen = [];
  const { box, pushes } = fakeBox({ storedEnvironment: () => ({ env: { CODERABBIT_API_KEY: "stored" }, replace: false }) });
  const original = box.options.operations.applyEnvironment;
  box.options.operations.applyEnvironment = async (c, endpoint, update) => {
    seen.push(endpoint.headers?.["x-sand-display"] ?? "primary");
    return original(c, endpoint, update);
  };

  const window = await box.ensureWindow(ctx, "agent-a", 4);

  // The push happened on the way to the window, not after it: a window handed back without the
  // credentials would run its first command without them.
  assert.deepEqual(seen, ["4"]);
  assert.deepEqual(pushes, [{ display: "4", env: { CODERABBIT_API_KEY: "stored" } }]);
  assert.equal(window.windowIndex, 4);
});

test("ENV-1: with nothing stored, a new window is not pushed an empty environment", async () => {
  const { box, pushes } = fakeBox({ storedEnvironment: () => ({ env: {}, replace: false }) });
  await box.ensureWindow(ctx, "agent-a", 4);
  assert.deepEqual(pushes, []);
});

test("GATE-11: an agent's shell accessor is its own window's, not the primary's", async () => {
  const primary = { name: "primary", get: () => ({ execute: async () => okShell() }) };
  const windows = new Map();
  const inner = {
    maxWindows: () => 100,
    ensureReady: async () => ({ remoteAccessor: primary, vncUrl: "vnc://primary" }),
    ensureWindow: async (_ctx, _id, windowIndex) => {
      const computerUse = windows.get(windowIndex) ?? { name: `window-${windowIndex}`, get: () => ({ execute: async () => okShell() }) };
      windows.set(windowIndex, computerUse);
      return { windowIndex, computerUse, vncUrl: `vnc://${windowIndex}` };
    },
    releaseWindow: async () => {},
    runState: async () => "running",
    listBoxes: async () => [{ agentId: "shared", running: true }],
    uploadFile: async () => {},
    downloadFile: async () => new Uint8Array(),
  };
  const box = new HostBox(new SharedDesktopSandBox(inner));

  const first = await box.agentShellAccessor(ctx, "agent-a");
  assert.equal(first.name, "window-2");
  // The same agent keeps its seat, and a second agent gets its own -- neither is the primary,
  // which is the shell the old probe was asking all along.
  assert.equal((await box.agentShellAccessor(ctx, "agent-a")).name, "window-2");
  assert.equal((await box.agentShellAccessor(ctx, "agent-b")).name, "window-3");
  assert.equal(box.getAgentWindowIndex("agent-a"), 2);
});

/** A WidgetResponses whose shell sink can be missing or refuse, which is what SECRET-2 is about. */
const shellHarness = (shellSecretSink) => new widgets.WidgetResponses({
  ...(shellSecretSink === undefined ? {} : { shellSecretSink }),
  sessionStore: { storeConnectorCredential: () => { throw new Error("the channel store must not be reached"); } },
  channelConfigChanged: () => {},
});

test("SECRET-2: a shell route with no sink refuses in words instead of answering null", async () => {
  const routed = await shellHarness(undefined).routeSecret("agent1", { kind: "channel-credential", platform: "shell", field: "TITAN_JOB_TOKEN" }, "value");
  // null was the bug: submitSecret pushed a tray error and returned, so the agent was never
  // resumed and waited forever on a card the operator had already answered.
  assert.ok("refused" in routed, JSON.stringify(routed));
  assert.match(routed.refused, /no route from a secret card to the agent's shell environment/);
});

test("SECRET-2: a sink that did not store refuses in words too", async () => {
  const routed = await shellHarness(async () => ({ field: "TITAN_JOB_TOKEN", stored: false, applied: false }))
    .routeSecret("agent1", { kind: "channel-credential", platform: "shell", field: "TITAN_JOB_TOKEN" }, "value");
  assert.ok("refused" in routed, JSON.stringify(routed));
  assert.match(routed.refused, /did not take \$TITAN_JOB_TOKEN/);

  const nothing = await shellHarness(async () => null)
    .routeSecret("agent1", { kind: "channel-credential", platform: "shell", field: "TITAN_JOB_TOKEN" }, "value");
  assert.ok("refused" in nothing, JSON.stringify(nothing));
});

test("ENV-1: the windows a push missed ride out of routeSecret to the ack", async () => {
  const routed = await shellHarness(async () => ({ field: "TITAN_JOB_TOKEN", stored: true, applied: false, pendingWindows: ["agent-a#4"] }))
    .routeSecret("agent1", { kind: "channel-credential", platform: "shell", field: "TITAN_JOB_TOKEN" }, "value");
  assert.equal(routed.applied, false);
  assert.deepEqual(routed.pendingWindows, ["agent-a#4"]);
});
