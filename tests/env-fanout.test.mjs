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
const ackBuilder = await load("source/host/runner/tools/sand-secret-request.ts", "sand-secret-request");
const seedModule = await load("source/host/extensions/forever-box/window-seed.ts", "window-seed");
const shellSecrets = await load("source/host/extensions/shell-tools/shell-secrets.ts", "shell-secrets");

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

  assert.deepEqual(result, { applied: true, pendingWindows: [], pendingWindowIndexes: [] });
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
  // The DISPLAY index, not this box's map key: the key is `<box id>#<index>`, and on the shared
  // desktop that box id is the shared box, never the agent. The layer that knows who holds the
  // seat renames these (the shared-desktop case below).
  assert.deepEqual(result.pendingWindows, ["display :4"]);
  assert.deepEqual(result.pendingWindowIndexes, [4]);
  assert.deepEqual(pushes.map((push) => push.display).sort(), ["7", "primary"]);
});

test("ENV-1: a window whose daemon has gone is reported and dropped, so the next open re-creates it", async () => {
  const { box } = fakeBox();
  await box.ensureWindow(ctx, "agent-a", 4);
  // The window was reachable when it opened; the ping in the fan-out is what finds it gone.
  box.options.operations.ping = async (_c, endpoint) => ({ outcome: endpoint.port === 1337 ? "ok" : "refused" });

  const result = await box.applyEnvironment(ctx, { env: { VERIFY_ENV_3: "value" }, replace: false });
  assert.equal(result.applied, false);
  assert.deepEqual(result.pendingWindows, ["display :4"]);
  // A second push does not keep reporting a window nobody holds any more.
  const again = await box.applyEnvironment(ctx, { env: { VERIFY_ENV_3: "value" }, replace: false });
  assert.deepEqual(again, { applied: true, pendingWindows: [], pendingWindowIndexes: [] });
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

test("ENV-1: through the shared desktop, a missed window is named by the agent holding the seat", async () => {
  // The shape the live box has, which the loopback-only cases above cannot produce: every window
  // is opened under the SHARED box id, so the inner box's own key is `grok-bot-local-vm#2` for
  // every agent on this desktop. This is the layer that holds index -> agent.
  const { box: loopback } = fakeBox({ failWindow: "2" });
  const shared = new SharedDesktopSandBox(loopback, { sharedBoxId: "grok-bot-local-vm" });
  await shared.ensureReady(ctx, "agent-a");
  assert.equal(shared.getAgentWindowIndex("agent-a"), 2);

  const result = await shared.applyEnvironment(ctx, { env: { VERIFY_ENV_3: "value" }, replace: false });

  assert.equal(result.applied, false);
  assert.deepEqual(result.pendingWindows, ["agent-a (display :2)"]);
  assert.deepEqual(result.pendingWindowIndexes, [2]);
  // A seat nobody is assigned stays the bare display rather than borrowing someone else's name.
  assert.equal(shared.describeWindowSeat(9), "display :9");
});

test("ENV-1: the seed a new window starts with carries BOTH stores, not just the shell one", () => {
  // The half that was missing: the operator's box secrets go into the same daemons through the
  // same applyEnvironment, so a window opened after one was stored started without it while every
  // window already open had it.
  const root = mkdtempSync(path.join(stage, "seed-"));
  writeFileSync(path.join(root, "connector-env-secrets.json"), JSON.stringify({ shell: { CODERABBIT_API_KEY: "shell-value" } }), { mode: 0o600 });
  writeFileSync(path.join(root, "box-secrets.json"), JSON.stringify({ version: 1, secrets: { OPERATOR_TOKEN: "box-value" } }), { mode: 0o600 });

  const seed = seedModule.buildWindowSeedEnvironment(root);

  assert.equal(seed.env.CODERABBIT_API_KEY, "shell-value");
  assert.equal(seed.env.OPERATOR_TOKEN, "box-value");
  // The redaction list rides with the box secrets, so the window daemon redacts them the way the
  // primary does.
  assert.equal(seed.env.CLOUD_AGENT_INJECTED_SECRET_NAMES, "OPERATOR_TOKEN");
  // Never replace on this path: the daemon's replace mode deletes what the update does not carry.
  assert.equal(seed.replace, false);
});

test("ENV-1: a store that is not there yet is no secrets, not an error", () => {
  const root = mkdtempSync(path.join(stage, "seed-empty-"));
  assert.deepEqual(seedModule.buildWindowSeedEnvironment(root), { env: {}, replace: false });
});

test("ENV-1: a replace push carries the shell store, so saving box secrets does not wipe it", () => {
  const root = mkdtempSync(path.join(stage, "preserve-"));
  writeFileSync(path.join(root, "connector-env-secrets.json"), JSON.stringify({ shell: { CODERABBIT_API_KEY: "shell-value" } }), { mode: 0o600 });

  // What BoxSecretsApplier pushes: replace:true, which DELETES every variable it does not carry.
  const merged = shellSecrets.withShellSecretsPreserved({ OPERATOR_TOKEN: "box-value" }, root);

  assert.deepEqual(merged, { OPERATOR_TOKEN: "box-value", CODERABBIT_API_KEY: "shell-value" });
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
  const routed = await shellHarness(async () => ({ field: "TITAN_JOB_TOKEN", stored: true, applied: false, pendingWindows: ["agent-a (display :4)"] }))
    .routeSecret("agent1", { kind: "channel-credential", platform: "shell", field: "TITAN_JOB_TOKEN" }, "value");
  assert.equal(routed.applied, false);
  assert.deepEqual(routed.pendingWindows, ["agent-a (display :4)"]);
});

test("ENV-1: the ack names the agent whose shell missed the push, not a box id", () => {
  const ack = ackBuilder.buildSecretProvidedAck(
    { label: "CodeRabbit key", target: { kind: "shell" } },
    { destination: "your shell's environment as $CODERABBIT_API_KEY", shellField: "CODERABBIT_API_KEY", applied: false, pendingWindows: ["agent-a (display :4)"] },
  );
  assert.match(ack, /agent-a \(display :4\)/);
  // What it used to say -- `grok-bot-local-vm#4` -- named the shared box, which is the same string
  // for every agent on this desktop and so resolved to nothing the model could act on.
  assert.doesNotMatch(ack, /#\d/);
});
