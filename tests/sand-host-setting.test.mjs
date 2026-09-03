// Where the operator switches live, and where they must NOT live.
//
// The wave's switches (SAND_BROWSER_USE, SAND_TOOL_TRACE) first went into box-secrets.json,
// following the endpoint pin. That file is the wrong home: `SAND_` is a reserved box-secret
// prefix (shared/box-secrets.ts), and BoxSecretsApplier.applyPersisted silently drops EVERY
// persisted secret when the file holds one reserved key -- so a switch parked there would stop
// real secrets from ever reaching the box, and the next setBoxSecrets (which rewrites the whole
// file) would erase the switch. They live in their own host-owned file instead. These cases pin
// that: the settings file is read, box-secrets.json is not, and env still wins.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(tmpdir(), "sand-host-setting-"));
process.env.SAND_DATA_ROOT = root;
after(() => {
  delete process.env.SAND_DATA_ROOT;
  rmSync(root, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
});

const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/sand-box-setting.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser"], logLevel: "silent",
});
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".sand-host-setting-test-"));
const bundlePath = path.join(stage, "sand-box-setting.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
const mod = createRequire(import.meta.url)(bundlePath);

const write = (file, value) => {
  writeFileSync(path.join(root, file), JSON.stringify(value));
  // The read caches on mtime+size; a same-millisecond rewrite of the same length would be
  // indistinguishable, so every case here writes a distinct payload.
};

test("the settings file, not box-secrets.json, is what an operator flips", () => {
  assert.equal(mod.getSandHostSettingsPath(), path.join(root, "sand-host-settings.json"));
  write("box-secrets.json", { version: 1, secrets: { SAND_BROWSER_USE: "1" } });
  assert.equal(mod.readSandBoxSetting("SAND_BROWSER_USE"), undefined,
    "a SAND_ key in box-secrets.json must be ignored: parking one there disables secret injection");
  write("sand-host-settings.json", { SAND_BROWSER_USE: "1" });
  assert.equal(mod.readSandBoxSetting("SAND_BROWSER_USE"), "1");
  assert.equal(mod.isSandBoxSettingEnabled("SAND_BROWSER_USE"), true);
});

test("the nested shape reads too, and a falsy value is off", () => {
  write("sand-host-settings.json", { settings: { SAND_TOOL_TRACE: "0", SAND_BROWSER_USE: "yes" } });
  assert.equal(mod.readSandBoxSetting("SAND_TOOL_TRACE"), "0");
  assert.equal(mod.isSandBoxSettingEnabled("SAND_TOOL_TRACE"), false);
  assert.equal(mod.isSandBoxSettingEnabled("SAND_BROWSER_USE"), true);
});

test("a missing or unparseable file means no overrides, never a throw", () => {
  rmSync(path.join(root, "sand-host-settings.json"), { force: true });
  assert.equal(mod.readSandBoxSetting("SAND_TOOL_TRACE"), undefined);
  writeFileSync(path.join(root, "sand-host-settings.json"), "{ not json");
  assert.equal(mod.readSandBoxSetting("SAND_TOOL_TRACE"), undefined);
});

test("the environment still wins over the file", () => {
  write("sand-host-settings.json", { SAND_TOOL_TRACE: "0", SAND_BROWSER_USE: "0" });
  process.env.SAND_TOOL_TRACE = "1";
  try {
    assert.equal(mod.isSandBoxSettingEnabled("SAND_TOOL_TRACE"), true);
  } finally { delete process.env.SAND_TOOL_TRACE; }
});

test("resolveBrowserUseEnabled: an explicit override decides, otherwise the gate", () => {
  assert.equal(mod.resolveBrowserUseEnabled("1", () => false), true);
  assert.equal(mod.resolveBrowserUseEnabled("0", () => true), false);
  assert.equal(mod.resolveBrowserUseEnabled(undefined, () => true), true);
  assert.equal(mod.resolveBrowserUseEnabled(undefined, () => false), false);
});
