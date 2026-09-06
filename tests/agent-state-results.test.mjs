import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-agent-state-"));
  const output = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function fakeDeps(overrides = {}) {
  const written = { profile: null, settings: null };
  return {
    written,
    deps: {
      agentId: "a1", agentDir: "/tmp/nowhere", sandRoot: "/tmp/nowhere",
      memory: { addMemory: (content) => ({ content }), removeMemoryByContent: () => true },
      membership: { read: () => new Set(), join: () => true, leave: () => true },
      channels: { remove: () => true },
      automations: { upsert: () => null, update: () => null, setEnabled: () => null, remove: () => true, get: () => null },
      workflows: { create: (spec) => ({ id: "w1", name: spec.name }), update: () => null, remove: () => true },
      readProfile: () => ({ name: "Titan", description: "" }),
      writeProfile: (profile) => { written.profile = profile; },
      writeSettings: (settings) => { written.settings = settings; },
      ...overrides,
    },
  };
}

// STATE-1. The runner's state tool reads `detail` on success and `reason` on failure (the shape
// runner/agent-state.ts defines); this module answered with `message` alone, so a successful save
// handed the tool undefined and every skill, routine and memory write "failed" after landing.
test("a state write answers with detail on success and reason on failure, beside message", async () => {
  const loaded = await loadModule("source/host/extensions/memory/agent-state.ts");
  try {
    const { createSandAgentState } = loaded.module;
    const { deps } = fakeDeps();
    const state = createSandAgentState(deps);
    const saved = await state.writeMemory({ content: "the box restarts at ships", tier: "note" });
    assert.equal(saved.ok, true);
    assert.equal(typeof saved.detail, "string", "success carries detail for the state tool");
    assert.equal(saved.detail, saved.message);
    const workflow = await state.writeWorkflow({ name: "Act on implied setup requests", body: "Do it." });
    assert.equal(workflow.ok, true); assert.equal(typeof workflow.detail, "string");
    const failed = await state.updateProfile({});
    assert.equal(failed.ok, false);
    assert.equal(typeof failed.reason, "string", "failure carries reason for the state tool");
    assert.equal(failed.reason, failed.message);
  } finally { await loaded.dispose(); }
});

test("updateProfile and updateSettings go through the deps the composition must wire", async () => {
  const loaded = await loadModule("source/host/extensions/memory/agent-state.ts");
  try {
    const { createSandAgentState } = loaded.module;
    const { deps, written } = fakeDeps();
    const state = createSandAgentState(deps);
    const profile = await state.updateProfile({ description: "Chief of staff for Titanium" });
    assert.equal(profile.ok, true, profile.message);
    assert.deepEqual(written.profile, { name: "Titan", description: "Chief of staff for Titanium" });
    const settings = await state.updateSettings({ notifyOnAgentUpdates: false });
    assert.equal(settings.ok, true);
    assert.deepEqual(written.settings, { notifyOnAgentUpdates: false });
    const bare = createSandAgentState({ ...deps, readProfile: undefined, writeProfile: undefined });
    await assert.rejects(() => bare.updateProfile({ description: "x" }), /readProfile is not a function/, "without the wiring the profile path dies exactly as Titan saw");
  } finally { await loaded.dispose(); }
});
