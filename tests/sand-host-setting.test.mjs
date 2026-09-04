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
// Pinned per case, not once at import. The module under test reads SAND_DATA_ROOT on every call,
// and tests/index.js loads every suite into one process before any of them run, so a later suite
// that points the same variable at its own temp root wins for all of them: five of these cases
// failed under that runner while passing under `node --test tests/*.test.mjs`, where each file has
// a process to itself.
const useRoot = () => { process.env.SAND_DATA_ROOT = root; };
useRoot();
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
  useRoot();
  assert.equal(mod.getSandHostSettingsPath(), path.join(root, "sand-host-settings.json"));
  write("box-secrets.json", { version: 1, secrets: { SAND_BROWSER_USE: "1" } });
  assert.equal(mod.readSandBoxSetting("SAND_BROWSER_USE"), undefined,
    "a SAND_ key in box-secrets.json must be ignored: parking one there disables secret injection");
  write("sand-host-settings.json", { SAND_BROWSER_USE: "1" });
  assert.equal(mod.readSandBoxSetting("SAND_BROWSER_USE"), "1");
  assert.equal(mod.isSandBoxSettingEnabled("SAND_BROWSER_USE"), true);
});

test("the nested shape reads too, and a falsy value is off", () => {
  useRoot();
  write("sand-host-settings.json", { settings: { SAND_TOOL_TRACE: "0", SAND_BROWSER_USE: "yes" } });
  assert.equal(mod.readSandBoxSetting("SAND_TOOL_TRACE"), "0");
  assert.equal(mod.isSandBoxSettingEnabled("SAND_TOOL_TRACE"), false);
  assert.equal(mod.isSandBoxSettingEnabled("SAND_BROWSER_USE"), true);
});

test("a missing or unparseable file means no overrides, never a throw", () => {
  useRoot();
  rmSync(path.join(root, "sand-host-settings.json"), { force: true });
  assert.equal(mod.readSandBoxSetting("SAND_TOOL_TRACE"), undefined);
  writeFileSync(path.join(root, "sand-host-settings.json"), "{ not json");
  assert.equal(mod.readSandBoxSetting("SAND_TOOL_TRACE"), undefined);
});

test("the environment still wins over the file", () => {
  useRoot();
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

// Teach recording read the Statsig gate directly, which is false on any box without a
// Cursor login, so startTeachRecording could never succeed here. Same resolver shape as browser use.
test("resolveTeachEnabled: an explicit override decides, otherwise the gate", () => {
  assert.equal(mod.SAND_TEACH_SETTING, "SAND_TEACH");
  assert.equal(mod.resolveTeachEnabled("1", () => false), true);
  assert.equal(mod.resolveTeachEnabled("true", () => false), true);
  assert.equal(mod.resolveTeachEnabled("0", () => true), false);
  assert.equal(mod.resolveTeachEnabled("false", () => true), false);
  assert.equal(mod.resolveTeachEnabled("FALSE", () => true), false);
  assert.equal(mod.resolveTeachEnabled(undefined, () => true), true);
  assert.equal(mod.resolveTeachEnabled(undefined, () => false), false);
  assert.equal(mod.resolveTeachEnabled("", () => true), true, "an empty value is not an override");
});

// Memory synthesis was armed only by pinGateOnAuthenticatedBootstrap("sand_memory_dreaming"),
// which needs a Cursor login, so no turn was ever recorded as evidence and no agent memory file
// was ever written on this box. Same resolver shape as teach.
test("resolveMemoryDreamingEnabled: an explicit override decides, otherwise the gate", () => {
  assert.equal(mod.SAND_MEMORY_DREAMING_SETTING, "SAND_MEMORY_DREAMING");
  assert.equal(mod.resolveMemoryDreamingEnabled("1", () => false), true);
  assert.equal(mod.resolveMemoryDreamingEnabled("true", () => false), true);
  assert.equal(mod.resolveMemoryDreamingEnabled("TRUE", () => false), true);
  assert.equal(mod.resolveMemoryDreamingEnabled("0", () => true), false);
  assert.equal(mod.resolveMemoryDreamingEnabled("false", () => true), false);
  assert.equal(mod.resolveMemoryDreamingEnabled("FALSE", () => true), false);
  assert.equal(mod.resolveMemoryDreamingEnabled(undefined, () => true), true);
  assert.equal(mod.resolveMemoryDreamingEnabled(undefined, () => false), false);
  assert.equal(mod.resolveMemoryDreamingEnabled("", () => true), true, "an empty value is not an override");
});

// The extension asks readSandBoxSetting whether the switch is SET at all before it decides: an
// unset switch has to fall through to the gate, and "0" has to mean off rather than unset, or a
// deliberate disable would silently wait forever on a bootstrap that never comes.
test("the memory switch reads out of the same host settings file", () => {
  useRoot();
  write("sand-host-settings.json", { SAND_MEMORY_DREAMING: "1", SAND_TEACH: "0" });
  assert.equal(mod.readSandBoxSetting(mod.SAND_MEMORY_DREAMING_SETTING), "1");
  assert.equal(mod.resolveMemoryDreamingEnabled(mod.readSandBoxSetting(mod.SAND_MEMORY_DREAMING_SETTING), () => false), true);
  write("sand-host-settings.json", { settings: { SAND_MEMORY_DREAMING: "0" } });
  assert.equal(mod.readSandBoxSetting(mod.SAND_MEMORY_DREAMING_SETTING), "0");
  assert.equal(mod.resolveMemoryDreamingEnabled(mod.readSandBoxSetting(mod.SAND_MEMORY_DREAMING_SETTING), () => true), false);
  write("sand-host-settings.json", { SAND_TEACH: "1" });
  assert.equal(mod.readSandBoxSetting(mod.SAND_MEMORY_DREAMING_SETTING), undefined,
    "an unset switch must leave the gate in charge, not read as off");
});

test("the teach switch reads out of the same host settings file", () => {
  useRoot();
  write("sand-host-settings.json", { SAND_TEACH: "1", SAND_BROWSER_USE: "0" });
  assert.equal(mod.readSandBoxSetting(mod.SAND_TEACH_SETTING), "1");
  assert.equal(mod.resolveTeachEnabled(mod.readSandBoxSetting(mod.SAND_TEACH_SETTING), () => false), true);
  // The resolver treats an empty string as "no override", and the reader never hands one out, so
  // the gate table cannot credit a switch that decided nothing.
  write("sand-host-settings.json", { SAND_TEACH: "", SAND_BROWSER_USE: "  " });
  assert.equal(mod.readSandBoxSetting(mod.SAND_TEACH_SETTING), undefined);
  assert.equal(mod.readSandBoxSetting(mod.SAND_BROWSER_USE_SETTING), undefined);
});

// GC-1. The maintenance switches (stale-root GC, legacy blob retirement, conversation GC) read an
// env object; on a running box only the settings file can change, so the helpers now default to
// process.env with the file's values layered in. Only the named keys are consulted.
test("maintenance switches read the host settings file through envWithSandBoxSettings", () => {
  useRoot();
  write("sand-host-settings.json", { SAND_STALE_ROOT_GC: "1", SAND_TOOL_TRACE: "1" });
  const env = mod.envWithSandBoxSettings(["SAND_STALE_ROOT_GC", "SAND_CONVERSATION_GC"], { HOME: "/x" });
  assert.equal(env.SAND_STALE_ROOT_GC, "1");
  assert.equal(env.SAND_CONVERSATION_GC, undefined);
  assert.equal(env.SAND_TOOL_TRACE, undefined, "keys that were not asked for are not layered in");
  assert.equal(env.HOME, "/x");
});

// TOOLS-15. The five host-machine tools swing on a live 30 s bridge-liveness fact, which no gate
// can stage: on a box with the desktop app attached it is stuck at "connected". This switch pins
// either world so both legs can be driven and measured. Unset has to fall through to the bridge,
// and "0" has to mean withheld rather than unset, or the withhold is unverifiable again.
test("the local-machine switch pins either world and otherwise asks the bridge", () => {
  useRoot();
  write("sand-host-settings.json", { SAND_LOCAL_MACHINE: "0" });
  assert.equal(mod.readSandBoxSetting(mod.SAND_LOCAL_MACHINE_SETTING), "0");
  assert.equal(mod.resolveLocalMachineOffered(mod.readSandBoxSetting(mod.SAND_LOCAL_MACHINE_SETTING), () => true), false,
    "the pin withholds even while a computer is announced");
  write("sand-host-settings.json", { SAND_LOCAL_MACHINE: "1" });
  assert.equal(mod.resolveLocalMachineOffered(mod.readSandBoxSetting(mod.SAND_LOCAL_MACHINE_SETTING), () => false), true,
    "the pin offers even while none is");
  write("sand-host-settings.json", {});
  assert.equal(mod.readSandBoxSetting(mod.SAND_LOCAL_MACHINE_SETTING), undefined);
  assert.equal(mod.resolveLocalMachineOffered(undefined, () => true), true, "unset asks the bridge");
  assert.equal(mod.resolveLocalMachineOffered(undefined, () => false), false, "unset asks the bridge");
});
