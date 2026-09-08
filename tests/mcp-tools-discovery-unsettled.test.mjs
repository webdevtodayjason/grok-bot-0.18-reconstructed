import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-tools-discovery-"));
  const output = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CONNECT-12. The box answers a tools listing for every configured stdio server as it stands at that
// moment; a server still starting answers with no tools. That answer used to be cached as settled
// for a day, so a connector added a moment ago listed no tools to the agents until the next reload.
function fakeWorld() {
  const listings = [];
  const core = {
    definitionSource: {
      peekHttpServerNames: () => [],
      peekStdioServerNames: () => ["probe"],
      getUserServerConfigs: async () => ({}),
      getStdioServerConfigs: async () => ({ probe: { command: "node", args: [] } }),
      // MARKET-6 split "what the box is responsible for" from "what the dead Cursor backend owns".
      // A url connector of this box's own is dispatched to the box, which connects to it; an
      // account url server went to the Dashboard RPC, which answers nothing here. This double has
      // one stdio server and no account, so both answers follow from that.
      getBoxServerConfigs: async () => ({ probe: { command: "node", args: [] } }),
      getBackendHttpServerNames: async () => [],
      ensureConfigLoaded: async () => {},
    },
    lastAccountDisplayConfig: () => null,
    settingsStore: () => ({ getMcpDisabledToolsByServerId: () => ({}) }),
    backendMcpExec: { listTools: async () => [] },
  };
  const boxMcpExec = {
    loadServers: async () => {},
    listTools: async (names) => {
      listings.push([...names]);
      return listings.length === 1
        ? [{ serverIdentifier: "probe", tools: [], status: "loading", toolCount: 0 }]
        : [{ serverIdentifier: "probe", tools: [{ providerIdentifier: "probe", name: "probe.env_probe", toolName: "env_probe" }], status: "connected", toolCount: 1 }];
    },
  };
  return { core, boxMcpExec, listings };
}

test("a tools answer taken while a server was still loading is asked again after the short TTL", async () => {
  const loaded = await loadModule("source/shared/node/mcp/tools-discovery.ts");
  try {
    const { createMcpToolsDiscovery, MCP_TOOLS_UNSETTLED_TTL_MS, MCP_TOOLS_CACHE_TTL_MS } = loaded.module;
    assert.ok(MCP_TOOLS_UNSETTLED_TTL_MS < 60_000 && MCP_TOOLS_UNSETTLED_TTL_MS < MCP_TOOLS_CACHE_TTL_MS, "the unsettled TTL is seconds, not the day");
    const world = fakeWorld();
    const discovery = createMcpToolsDiscovery(world.core, { boxMcpExec: world.boxMcpExec, unsettledTtlMs: 40 });
    assert.deepEqual(await discovery.getToolsRaw(), [], "the first answer, taken while the probe loads, has no tools");
    assert.equal(world.listings.length, 1);
    await sleep(80);
    await discovery.getToolsRaw(); // past the short TTL: serves the stale answer and asks the box again
    await sleep(20);
    const tools = await discovery.getToolsRaw();
    assert.equal(world.listings.length, 2, "the box was asked a second time without any reload");
    assert.deepEqual(tools.map((tool) => tool.toolName), ["env_probe"], "the connected probe's tool is listed");
  } finally {
    await loaded.dispose();
  }
});

test("a settled answer keeps the long TTL: a connected server is not re-asked", async () => {
  const loaded = await loadModule("source/shared/node/mcp/tools-discovery.ts");
  try {
    const { createMcpToolsDiscovery } = loaded.module;
    const world = fakeWorld();
    world.boxMcpExec.listTools = async (names) => { world.listings.push([...names]); return [{ serverIdentifier: "probe", tools: [{ providerIdentifier: "probe", name: "probe.env_probe", toolName: "env_probe" }], status: "connected", toolCount: 1 }]; };
    const discovery = createMcpToolsDiscovery(world.core, { boxMcpExec: world.boxMcpExec, unsettledTtlMs: 40 });
    assert.equal((await discovery.getToolsRaw()).length, 1);
    await sleep(80);
    await discovery.getToolsRaw(); await sleep(20); await discovery.getToolsRaw();
    assert.equal(world.listings.length, 1, "a settled answer is served from the cache");
  } finally {
    await loaded.dispose();
  }
});
