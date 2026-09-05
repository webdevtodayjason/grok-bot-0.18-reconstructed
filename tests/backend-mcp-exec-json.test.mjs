import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry = "source/shared/node/cursor-backend/backend-mcp-exec.ts") {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-backend-mcp-exec-"));
  const output = path.join(temporary, "backend-mcp-exec.mjs");
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

test("MCP discovery accepts both routed JSON and native generated values", async () => {
  const loaded = await loadModule("source/shared/node/mcp/mcp-validation.ts");
  try {
    assert.deepEqual(loaded.module.toJsonArgs({
      query: "in:inbox",
      pageSize: 1,
      native: { toJson: () => ({ retained: true }) },
    }), {
      query: "in:inbox",
      pageSize: 1,
      native: { retained: true },
    });
  } finally {
    await loaded.dispose();
  }
});

test("routed MCP JSON arguments become a protobuf Struct before backend serialization", async () => {
  const loaded = await loadModule();
  try {
    let captured;
    const backend = loaded.module.createDashboardSandBackendMcpExec({
      getAccessToken: async () => "unused",
      getMachineId: async () => "unused",
      createClient: () => ({
        executeSandMcpTool: async request => {
          captured = request;
          // This is the operation that failed in the real Connect serializer when
          // routed providers supplied a plain object instead of a Struct.
          assert.deepEqual(request.args.toJson(), { query: "in:inbox", pageSize: 1 });
          return { result: { result: { case: "success", value: { content: [] } } } };
        },
      }),
    });
    const result = await backend.executeTool({
      serverIdentifier: "user-Gmail",
      toolName: "search_threads",
      args: { query: "in:inbox", pageSize: 1 },
      toolCallId: "call-1",
      agentId: "agent-1",
    });
    assert.equal(result.result.case, "success");
    assert.equal(typeof captured.args.toBinary, "function");
  } finally {
    await loaded.dispose();
  }
});

test("routed MCP tool arguments become protobuf Values before the box exec serializes them", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    let received;
    const mcp = {
      mcp: {
        createExecutor: () => ({
          execute: async (_context, args) => {
            received = args;
            return { result: { case: "success", value: { content: [] } } };
          },
        }),
      },
    };
    const api = loaded.module.createHostGatewayApi({
      extensions: { api: () => mcp },
      hostEvents: { emit: () => {} },
      decorateForeverBoxStatus: status => status,
      getHealth: () => ({ isBusy: false }),
      kickstartIfPending: async () => false,
      requestDiskSaverAudit: async () => false,
      releaseAgentBox: async () => {},
      handleDesktopMcpAuthCompletion: async () => {},
      forgetLocalToolPermission: () => {},
    });
    await api.executeRoutedMcpTool({
      providerIdentifier: "tinyfish",
      name: "search",
      toolName: "tinyfish-search",
      args: { query: "echo-me", limit: 2, nested: { deep: [1, "two", null] } },
      toolCallId: "call-1",
    });
    // The plain object this used to forward is what every box stdio connector died on: that
    // branch serializes the arguments as map<string, google.protobuf.Value>, where a plain
    // object is "google.protobuf.Value must have a value" and no tool call ever ran.
    assert.deepEqual(Object.keys(received.args), ["query", "limit", "nested"]);
    for (const value of Object.values(received.args)) assert.equal(typeof value.toBinary, "function");
    assert.deepEqual(
      Object.fromEntries(Object.entries(received.args).map(([key, value]) => [key, value.toJson()])),
      { query: "echo-me", limit: 2, nested: { deep: [1, "two", null] } },
    );

    await api.executeRoutedMcpTool({ providerIdentifier: "tinyfish", name: "search", toolName: "tinyfish-search", toolCallId: "call-2" });
    assert.deepEqual(received.args, {});
  } finally {
    await loaded.dispose();
  }
});
