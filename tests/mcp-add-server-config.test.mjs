import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-mcp-add-server-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

// The shape is the whole point. parseServerConfig used to take the validator as a second argument
// and no construction site ever passed one, so AddMcpServer died on "parse is not a function"
// before it reached the account. A one-argument signature is what makes that unforgettable.
test("parseServerConfig validates a config on its own, with no injected parser", async () => {
  const loaded = await loadModule("source/shared/node/mcp/mcp-validation.ts");
  try {
    const { parseServerConfig } = loaded.module;
    assert.equal(parseServerConfig.length, 1, "parseServerConfig must not take an injected parser");

    assert.deepEqual(
      parseServerConfig(JSON.stringify({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"] })),
      { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"] },
    );
    assert.deepEqual(
      parseServerConfig(JSON.stringify({ url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } })),
      { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } },
    );
    assert.deepEqual(parseServerConfig(JSON.stringify({ type: "sse", url: "https://mcp.example.com/sse" })), {
      type: "sse",
      url: "https://mcp.example.com/sse",
    });

    for (const bad of ["{", JSON.stringify({}), JSON.stringify({ command: 7 }), JSON.stringify({ url: 7 })]) {
      assert.throws(() => parseServerConfig(bad), (error) => {
        assert.equal(error.name, "SandMcpConfigError", `${bad} threw ${error.name}: ${error.message}`);
        assert.doesNotMatch(error.message, /is not a function/);
        return true;
      });
    }
  } finally {
    await loaded.dispose();
  }
});

// The regression itself: a manager built the way the host builds it -- no parseServerConfig option,
// because there is no such option any more -- must carry a config through to the account writer.
test("addServer carries a parsed config to the account writer on a host-shaped manager", async () => {
  const loaded = await loadModule("source/shared/node/mcp/mcp-manager.ts");
  try {
    const written = [];
    const manager = new loaded.module.SandMcpManager({
      includeBuiltins: false,
      accountServersProvider: async () => ({ servers: [], cacheScope: "test" }),
      accountMcpWriter: {
        getConfigForEdit: async () => ({ config: { mcpServers: {} }, serverIdsByName: {} }),
        setConfig: async (config) => { written.push(config); },
      },
      effectivePluginsProvider: async () => [],
      backendMcpExec: { listServers: async () => [], listTools: async () => [] },
      getMachineId: async () => "test-machine",
    });
    manager.setBoxRuntime({
      isBoxExecWired: () => false,
      getTools: async () => [],
      listBoxServers: async () => [],
      setBoxMcpExec: () => {},
      resolveProviderTransport: () => undefined,
      invalidateToolsCache: () => {},
      resetPushState: () => {},
    });

    // The reload that follows the write reaches for more of the box than a unit test has. The claim
    // under test is what reached the writer, so a throw after the write is not this test's news --
    // but a throw with nothing written is exactly the failure this test exists to catch.
    await manager.addServer({
      name: "probe-connector",
      configJson: JSON.stringify({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"] }),
    }).catch((error) => {
      if (written.length === 0) assert.fail(`addServer threw before it wrote: ${error?.message ?? error}`);
    });

    assert.equal(written.length, 1, "addServer never wrote to the account");
    assert.deepEqual(written[0].mcpServers["probe-connector"], {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    });
  } finally {
    await loaded.dispose();
  }
});
