// Who is allowed to recreate the container (SHIP-2).
//
// A recreate cuts every turn in flight and wipes whatever agents installed into the container
// outside the volumes, which is the whole reason the host now upgrades by swapping its bundle in
// place. SAND_BOX_AUTO_UPDATE arms that swap and is supposed to disable the image auto-update at
// the same time. Two of the three image-update paths honoured it. The third, the gateway's
// autoUpdateBoxNow, carried only the autoUpdateEnabled gate: it answered "auto-update-disabled" for
// as long as the flag was 0, and setting it to 1 (this wave) is what would have armed it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".sand-forever-box-auto-update-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/extensions/forever-box/forever-box-service.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
});
const bundlePath = path.join(stage, "forever-box-service.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
const { ForeverBoxService } = createRequire(import.meta.url)(bundlePath);

const service = (options) => {
  const recreates = [];
  const deadline = { name: "test", run: (work, signal) => work(signal ?? new AbortController().signal) };
  const instance = new ForeverBoxService({
    box: { subscribe: () => () => {}, recordImageUpdateAvailable: () => {}, getStatus: async () => ({}) },
    lifecycleClient: {
      recreateInBox: async (input) => { recreates.push(input); return { started: true }; },
      // An image update IS waiting, so nothing but the guard can stop the recreate.
      fetchImageUpdateAvailable: async () => true,
    },
    trays: { pushError: () => {} },
    telemetry: { reportBoxRecreateDecided: () => {}, reportBoxImageCheck: () => {} },
    imagePolling: { name: "test", start: () => ({ dispose: () => {} }) },
    imagePollingStartDelay: { name: "test", schedule: () => ({ elapsed: Promise.resolve(), dispose: () => {} }) },
    imageSeedRetry: { name: "test", runWithRetry: async (work) => work(1, new AbortController().signal) },
    imageCheckDeadline: deadline,
    migrationExpiry: { name: "test", arm: () => ({ dispose: () => {} }) },
    screenshotDeadline: deadline,
    recreateFlushWaitDeadline: deadline,
    flushPendingUploads: async () => {},
    isInBox: () => true,
    log: () => {},
    now: () => 1_000,
    ...options,
  });
  after(() => instance.dispose());
  return { instance, recreates };
};

test("the gateway's autoUpdateBoxNow refuses while the host-bundle swap owns updates", async () => {
  // Both flags come from the same SAND_BOX_AUTO_UPDATE=1 the deploy sets, plus SAND_BOX_STORE_COPY_IN,
  // so this is the shape every shipped instance runs in.
  const { instance, recreates } = service({ autoUpdateEnabled: true, hostBundleAutoUpdateEnabled: true });
  assert.deepEqual(await instance.autoUpdateNow(), { started: false, reason: "host-bundle-auto-update" });
  assert.deepEqual(recreates, [], "no container recreate was asked for");
});

test("with no host-bundle upgrade path the same call still recreates the container", async () => {
  // The guard is about who owns the upgrade, not about disabling the command: upstream's own
  // hibernation path is unchanged when nothing arms the bundle swap.
  const { instance, recreates } = service({ autoUpdateEnabled: true, hostBundleAutoUpdateEnabled: false });
  assert.deepEqual(await instance.autoUpdateNow(), { started: true });
  assert.deepEqual(recreates, [{ preserveData: true }]);
});

test("outside a box, and with image auto-update off, the older refusals still come first", async () => {
  const outside = service({ autoUpdateEnabled: true, hostBundleAutoUpdateEnabled: true, isInBox: () => false });
  assert.deepEqual(await outside.instance.autoUpdateNow(), { started: false, reason: "not-in-box" });
  const off = service({ autoUpdateEnabled: false, hostBundleAutoUpdateEnabled: true });
  assert.deepEqual(await off.instance.autoUpdateNow(), { started: false, reason: "auto-update-disabled" });
});
