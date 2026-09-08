// CURSOR-1. What decides a feature gate on a box we ship.
//
// The measurement these cases exist for: on 2026-09-07 three boxes on the R750 ran ONE bundle and
// printed three different gate tables. On the demo box `sand_auto_review` read true while the
// bundled default is false, and on that box every Shell command and browser navigation answered
// "Rejected: An error occured while classifying this action. Please review manually." A remote
// rollout, evaluated for somebody else's product, decided whether a customer's agent could run a
// command, and the boot-time table labelled that value "bundled default" because it had no word
// for "a StatsigClient hydrated from a cached bootstrap file".
//
// Three things are pinned here.
//
// 1. Precedence. The pin file outranks the override store, the environment, any live evaluation and
//    the bundled default. The product's own table sits below the operator layers -- a pin nobody
//    can move is a rollout with our name on it -- and above Statsig, which is what makes two boxes
//    on one bundle agree.
// 2. The source label. Every layer names itself, and a pin says whether it came from the file or
//    from the bundle, because "which switch do I edit" is the only question the table is for.
// 3. No expiry. The override store used to drop entries after 24 hours: measured on
//    grok-bot-local-vm, sand-feature-flag-overrides.json held sand_teach_by_demonstration pinned
//    true with an expiry that had lapsed six days earlier, so a deliberate decision had turned
//    itself off with the clock and nothing said so.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".gate-pins-test-"));
const dataRoot = mkdtempSync(path.join(tmpdir(), "gate-pins-"));
after(() => {
  rmSync(stage, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

const load = async (relative, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, relative)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser", "@statsig/js-client"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, `${name}.cjs`);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(bundlePath);
};

const pins = await load("source/shared/node/experiments/gate-pins.ts", "gate-pins");
const overrides = await load("source/shared/node/experiments/feature-flag-overrides.ts", "overrides");
const experiments = await load("source/shared/node/experiments/cursor-experiments.ts", "experiments");
const flags = await load("source/shared/node/experiments/experiment-config.gen.ts", "flags");

// Distinct payloads every time: the read caches on mtime and size, and a same-millisecond rewrite
// of the same length would be indistinguishable.
const writePins = (value) => {
  writeFileSync(path.join(dataRoot, "gates.json"), JSON.stringify(value));
  pins.clearGatePinCacheForTests();
};
const clearPins = () => {
  rmSync(path.join(dataRoot, "gates.json"), { force: true });
  pins.clearGatePinCacheForTests();
};

// A service with no Statsig client and no network. `getCacheDir` is the data root the pin file and
// the override file both live in, which is how production wires it (getSandRootDir).
const service = (env = {}) => new experiments.SandExperimentService({
  getAccessToken: async () => { throw new Error("no backend in a unit test"); },
  getMachineId: async () => "machine",
  getCacheDir: () => dataRoot,
  isDevBuild: true,
  env,
});

test("the bundled defaults these decisions are made against are what we think they are", () => {
  // If upstream regenerates experiment-config.gen.ts and a default moves, the pin table below is
  // still right but the DOC's claim about what it changes is not. This case is the tripwire.
  assert.equal(flags.FLAGS.sand_auto_review.default, false);
  assert.equal(flags.FLAGS.sand_browser_use_subagent.default, false);
  assert.equal(flags.FLAGS.grok_bot_dynamic_tools.default, false);
  assert.equal(flags.FLAGS.sand_product_analytics.default, true);
  assert.equal(flags.FLAGS.codebase_telemetry_v2.default, true);
  assert.equal(flags.FLAGS.sand_notify_safety_poll.default, true);
  assert.equal(flags.FLAGS.sand_enable_pressure_cpu_profiler.default, true);
});

test("the product's own decisions, and every one of them names a real gate", () => {
  for (const name of pins.pinnedGateNames()) {
    assert.ok(Object.hasOwn(flags.FLAGS, name), `${name} is pinned but is not a gate`);
  }
  // The four that cost a customer something if they come back on.
  assert.equal(pins.PRODUCT_GATE_PINS.sand_auto_review, false, "the review classifier is not ours");
  assert.equal(pins.PRODUCT_GATE_PINS.sand_product_analytics, false);
  assert.equal(pins.PRODUCT_GATE_PINS.sand_codebase_telemetry, false);
  assert.equal(pins.PRODUCT_GATE_PINS.codebase_telemetry_v2, false);
  // Titan holds the browser himself; the fetch failure text tells a person to open the page in
  // their browser, which is only honest if he can hold one.
  assert.equal(pins.PRODUCT_GATE_PINS.sand_browser_use_subagent, true);
  // Load-bearing features, pinned on so a live evaluation can never take one away.
  assert.equal(pins.PRODUCT_GATE_PINS.sand_multitask, true);
  assert.equal(pins.PRODUCT_GATE_PINS.sand_spotlight, true);
  assert.equal(pins.PRODUCT_GATE_PINS.sand_global_search, true);
});

test("with no pin file at all, the product's table decides and says so", () => {
  clearPins();
  const resolved = service().resolveFeatureGate("sand_auto_review");
  assert.equal(resolved.value, false);
  assert.equal(resolved.source, "local pin");
  assert.equal(resolved.pin, "host");
  // A gate the product has no opinion about still falls through to the bundled default.
  const other = service().resolveFeatureGate("sand_agent_network");
  assert.equal(other.source, "bundled default");
  assert.equal(other.value, flags.FLAGS.sand_agent_network.default);
});

test("the pin file wins over the product's table, and names itself", () => {
  writePins({ sand_auto_review: true, sand_browser_use_subagent: false });
  const armed = service().resolveFeatureGate("sand_auto_review");
  assert.equal(armed.value, true);
  assert.equal(armed.source, "local pin");
  assert.equal(armed.pin, "file");
  assert.equal(service().resolveFeatureGate("sand_browser_use_subagent").value, false,
    "an operator must be able to turn a product pin off, or the pin is just our own rollout");
  clearPins();
});

test("the pin file wins over the environment override too", () => {
  writePins({ grok_bot_dynamic_tools: true });
  const env = { SAND_FEATURE_GATE_OVERRIDES: "grok_bot_dynamic_tools=0" };
  assert.equal(service(env).resolveFeatureGate("grok_bot_dynamic_tools").value, true);
  clearPins();
  // With the pin gone the environment is reached, and it outranks the product's table.
  const fromEnv = service(env).resolveFeatureGate("grok_bot_dynamic_tools");
  assert.equal(fromEnv.value, false);
  assert.equal(fromEnv.source, "env");
});

test("the nested shape reads, string values read, and a typo is ignored rather than guessed at", () => {
  writePins({ gates: { sand_multitask: "0", sand_spotlight: "on", sand_global_search: "maybe" } });
  assert.equal(pins.readGatePin("sand_multitask", dataRoot), false);
  assert.equal(pins.readGatePin("sand_spotlight", dataRoot), true);
  assert.equal(pins.readGatePin("sand_global_search", dataRoot), undefined,
    "an unrecognised value must not arm a gate");
  // A name that is not a gate is dropped: the pin file is not a place to invent gates.
  writePins({ not_a_real_gate: true, sand_multitask: false });
  assert.equal(pins.readGatePin("not_a_real_gate", dataRoot), undefined);
  assert.equal(pins.readGatePin("sand_multitask", dataRoot), false);
  clearPins();
});

test("a missing or half-written pin file means no pins, never a thrown turn", () => {
  clearPins();
  assert.deepEqual(pins.readGatePinFile(dataRoot), {});
  writeFileSync(path.join(dataRoot, "gates.json"), "{ not json");
  pins.clearGatePinCacheForTests();
  assert.deepEqual(pins.readGatePinFile(dataRoot), {});
  assert.equal(service().resolveFeatureGate("sand_multitask").value, true, "the product's pin still stands");
  clearPins();
});

test("a pin written a year ago still applies", () => {
  // The override store used to stamp a 24 hour expiry on every entry and drop it on read. The Mac
  // box's file held sand_teach_by_demonstration pinned true with an expiry six days past, so the
  // decision had quietly reversed itself. Entries no longer expire, and an old file with an
  // expiresAtMs in it still loads.
  const aYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1_000;
  writeFileSync(path.join(dataRoot, "sand-feature-flag-overrides.json"), JSON.stringify({
    overrides: { sand_teach_by_demonstration: { value: true, expiresAtMs: aYearAgo } },
  }));
  const store = new overrides.SandFeatureFlagOverrideStore(() => dataRoot);
  store.hydrateFromDisk();
  assert.equal(store.read("sand_teach_by_demonstration"), true);
  assert.equal(service().resolveFeatureGate("sand_teach_by_demonstration").source, "override store");
  rmSync(path.join(dataRoot, "sand-feature-flag-overrides.json"), { force: true });
});

test("an override the operator wrote is read back on a box that is not a dev build", () => {
  // Reads used to be gated on isDevBuild-or-an-Anysphere-account, so an override could sit on disk
  // and be ignored on the very box it was written for.
  writeFileSync(path.join(dataRoot, "sand-feature-flag-overrides.json"), JSON.stringify({
    overrides: { sand_agent_network: { value: true } },
  }));
  const packaged = new experiments.SandExperimentService({
    getAccessToken: async () => { throw new Error("no backend in a unit test"); },
    getMachineId: async () => "machine",
    getCacheDir: () => dataRoot,
    isDevBuild: false,
    env: {},
  });
  const resolved = packaged.resolveFeatureGate("sand_agent_network");
  assert.equal(resolved.value, true);
  assert.equal(resolved.source, "override store");
  rmSync(path.join(dataRoot, "sand-feature-flag-overrides.json"), { force: true });
});

test("checkFeatureGate and resolveFeatureGate never disagree", () => {
  writePins({ sand_auto_review: true });
  const one = service();
  for (const name of [...pins.pinnedGateNames(), "sand_agent_network"]) {
    assert.equal(one.checkFeatureGate(name), one.resolveFeatureGate(name).value, name);
  }
  clearPins();
});
