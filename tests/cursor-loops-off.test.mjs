// CURSOR-1. The background loops that dialled a competitor, and the one switch that stops them.
//
// Measured on the R750 and on grok-bot-local-vm, 2026-09-07:
//   - Every box logged "[sand:privacy] privacy-mode lookup failed, using privacy-safe fallback
//     backend=https://api2.cursor.sh/ error=ConnectError" continuously. On the Mac box
//     /tmp/sand-host.log was 2,947,354 bytes and held 1740 of those lines out of 1742 lines
//     containing "cursor" at all.
//   - Tenant boxes logged "inference-credential renewal failed (streak N): ENOENT" until somebody
//     copied a credential file in by hand.
//   - SAND_PACKAGED is unset on our boxes, so every one of them ran the Statsig bootstrap on the
//     30 s cadence against api3.cursor.sh, which answers 403 from inside the box.
//   - Compose env on every box carried SAND_BACKEND_URL=https://api2.cursor.sh/, so "is a backend
//     configured" was always yes. The question that matters is whether the host is one we own.
//
// So the switch is `getSandBackendMode()`, not the presence of a URL and not the presence of a
// credential file. These cases pin what it answers, and that every loop asks it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".cursor-loops-test-"));
const dataRoot = mkdtempSync(path.join(tmpdir(), "cursor-loops-"));
after(() => {
  delete process.env.SAND_DATA_ROOT;
  delete process.env.SAND_BACKEND_URL;
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

const mode = await load("source/shared/node/backend-mode.ts", "backend-mode");
const statsig = await load("source/shared/node/experiments/statsig-bootstrap.ts", "statsig");
const auth = await load("source/host/extensions/auth/auth-service.ts", "auth-service");

// Pinned per case, not once at import: tests/index.js loads every suite into one process before any
// of them run, and another suite points SAND_DATA_ROOT at its own root.
const useRoot = () => { process.env.SAND_DATA_ROOT = dataRoot; };
const writeSettings = (value) => {
  useRoot();
  writeFileSync(path.join(dataRoot, "sand-host-settings.json"), JSON.stringify(value));
};

test("a Cursor host is mode none however explicitly it was configured", () => {
  // The compose files we shipped set this on every box, so "the operator set it deliberately"
  // cannot be inferred from the value being present.
  for (const url of [
    "https://api2.cursor.sh/",
    "https://api2.cursor.sh",
    "https://api3.cursor.sh/tev1/v1",
    "https://dev-staging.cursor.sh",
    "https://anything.cursor.com/",
    "https://x.anysphere.co",
  ]) assert.equal(mode.getSandBackendModeForUrl(url), "none", url);
});

test("unset, empty and unparseable all mean none, never Cursor", () => {
  for (const raw of [undefined, "", "   ", "not a url", "api2.cursor.sh"]) {
    assert.equal(mode.getSandBackendModeForUrl(raw), "none", String(raw));
  }
});

test("a host of ours is mode ours", () => {
  for (const url of [
    "https://console.titanium.bot/",
    "https://relay.example.internal:8443",
    "http://localhost:4000/",
  ]) assert.equal(mode.getSandBackendModeForUrl(url), "ours", url);
});

test("the mode moves on a live box from the settings file, not only from compose", () => {
  // BOX-6 forbids recreating a live instance, and `docker restart` re-reads the bundle but not the
  // environment -- so a compose-only switch would mean "recreate the box to change your mind".
  // readSandBoxSetting reads the container env first and the settings file second.
  writeSettings({ SAND_BACKEND_URL: "https://console.titanium.bot/" });
  delete process.env.SAND_BACKEND_URL;
  assert.equal(mode.getSandBackendMode(), "ours");
  writeSettings({ SAND_BACKEND_URL: "https://api2.cursor.sh/" });
  assert.equal(mode.getSandBackendMode(), "none");
  // The environment still wins where it is set.
  process.env.SAND_BACKEND_URL = "https://console.titanium.bot/";
  assert.equal(mode.getSandBackendMode(), "ours");
  delete process.env.SAND_BACKEND_URL;
  assert.equal(mode.getSandBackendMode(), "none");
});

test("telemetry is off when the backend is not ours, and when the disable switch is set", () => {
  writeSettings({ SAND_BACKEND_URL: "https://console.titanium.bot/" });
  assert.equal(mode.isSandTelemetryEnabled({}), true);
  assert.equal(mode.isSandTelemetryEnabled({ SAND_DISABLE_TELEMETRY: "1" }), false);
  writeSettings({ SAND_BACKEND_URL: "https://api2.cursor.sh/" });
  assert.equal(mode.isSandTelemetryEnabled({}), false,
    "an exporter pointed at a host that refuses us is a retry loop, not telemetry");
});

test("nothing leaves through the Statsig SDK, including the event-logging endpoint", () => {
  // The filter used to pass any URL containing "/rgstr" -- Statsig's event upload -- to real fetch
  // and answer everything else with a synthetic 204. That permitted exactly the egress a
  // self-hosted box must not have, to https://api3.cursor.sh/tev1/v1.
  assert.equal(statsig.sandStatsigNetworkUrlAllowed("https://api3.cursor.sh/tev1/v1/rgstr"), false);
  assert.equal(statsig.sandStatsigNetworkUrlAllowed("https://api3.cursor.sh/tev1/v1/initialize"), false);
});

test("the Statsig shim answers 204 without calling fetch", async () => {
  let called = 0;
  const response = await statsig.sandStatsigNetworkOverride(
    "https://api3.cursor.sh/tev1/v1/rgstr", {}, async () => { called += 1; return new Response(null, { status: 200 }); },
  );
  assert.equal(called, 0);
  assert.equal(response.status, 204);
});

test("the credential renewer does not start when the backend is not ours", async () => {
  const lines = [];
  let renewals = 0;
  const service = auth.createHostAuthService({
    retry: { schedule: () => ({ elapsed: Promise.resolve() }) },
    clock: { schedule: () => ({ dispose() {} }), now: () => Date.now(), monotonicNow: () => 0 },
    log: (message) => lines.push(message),
    env: { SAND_DEV_INFERENCE_TOKEN_FILE: "/run/grok-bot/inference.json" },
    readDevCredential: async () => { renewals += 1; throw new Error("ENOENT"); },
    isBackendOurs: false,
  });
  // No cycle ran, so no "renewal failed (streak N): ENOENT" can ever be printed.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewals, 0);
  assert.equal(lines.filter((line) => line.includes("streak")).length, 0);
  assert.match(lines.join("\n"), /renewer is off/);
  // And the box reports itself logged out, which is what REVIEW-1's local classifier is chosen on.
  assert.equal(service.peekAccessToken(), null);
  service.dispose();
});

test("the renewer still runs when the backend IS ours", async () => {
  const lines = [];
  let renewals = 0;
  const service = auth.createHostAuthService({
    retry: { schedule: () => ({ elapsed: Promise.resolve() }) },
    clock: { schedule: () => ({ dispose() {} }), now: () => Date.now(), monotonicNow: () => 0 },
    log: (message) => lines.push(message),
    env: { SAND_DEV_INFERENCE_TOKEN_FILE: "/run/grok-bot/inference.json" },
    readDevCredential: async () => { renewals += 1; return { accessToken: "token", expiresAtMs: Date.now() + 600_000 }; },
    isBackendOurs: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewals, 1);
  assert.equal(service.peekAccessToken(), "token");
  service.dispose();
});

test("the privacy lookup makes no call and prints no line when the backend is not ours", async () => {
  // resolveSandRunPrivacyMode is exposed on the inference object BEFORE the provider branch, so it
  // fired once per turn and again per subagent run even on a box routed entirely to xAI. Its
  // failure path already returned this exact fallback; what is removed is the 3 s stall at the head
  // of every turn and the log line.
  writeSettings({ SAND_BACKEND_URL: "https://api2.cursor.sh/" });
  const privacy = await load("source/shared/node/cursor-backend/cursor-inference.ts", "cursor-inference");
  let fetches = 0;
  const fetcher = async () => { fetches += 1; return 3; };
  const resolved = await privacy.resolveSandRunPrivacyMode({
    getAccessToken: async () => { throw new Error("no credential"); },
    getMachineId: () => "machine",
  }, fetcher);
  assert.equal(fetches, 0, "no lookup may be attempted against a backend that is not ours");
  assert.equal(resolved, privacy.SAND_RUN_PRIVACY_MODE_FALLBACK);
  // Undefined from the plain resolver is what the ghost-mode header reads as privacy-safe.
  assert.equal(await privacy.resolveSandPrivacyMode({ backendUrl: "https://api2.cursor.sh/", accessToken: "t", machineId: "m" }, fetcher), undefined);
  assert.equal(fetches, 0);
  assert.equal(privacy.getSandGhostModeHeaderFromPrivacyMode(undefined), "true");
});
