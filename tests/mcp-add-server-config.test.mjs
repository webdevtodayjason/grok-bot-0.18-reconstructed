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

// ---------------------------------------------------------------------------------------------
// MARKET-6: the agent's own door onto the one writer.
//
// AddMcpServer used to write to the Cursor account's server list, which is the one place on this
// box that does not exist: the model could add a server, be told it worked, and find nothing on
// the box afterwards. And its description told the model the exact inverse of the truth here --
// "only supports remote http/sse MCP servers (executed on the backend); local/stdio servers are
// not supported" -- in a sentence the model reads before deciding whether it can help at all.
test("MARKET-6: AddMcpServer builds both shapes, and env arrives as names with no values", async () => {
  const loaded = await loadModule("source/host/runner/tools/sand-mcp-management-tools.ts");
  try {
    const { buildServerConfigJson } = loaded.module;

    // A link. `type` defaults to the transport almost every server speaks.
    assert.deepEqual(
      JSON.parse(buildServerConfigJson({ url: "https://mcp.example.com/mcp" })),
      { type: "http", url: "https://mcp.example.com/mcp" },
    );
    assert.deepEqual(
      JSON.parse(buildServerConfigJson({ url: "https://mcp.example.com/sse", type: "sse" })),
      { type: "sse", url: "https://mcp.example.com/sse" },
    );

    // A program. This is the shape the old description said was unsupported, and it is the shape
    // every connector that works on this box actually has.
    assert.deepEqual(
      JSON.parse(buildServerConfigJson({
        command: "npx", args: ["-y", "@acme/mcp-server@1.2.3"], env: ["ACME_TOKEN"],
      })),
      { command: "npx", args: ["-y", "@acme/mcp-server@1.2.3"], env: { ACME_TOKEN: "" } },
    );

    // The empty value is not an oversight: it is how this box marks "the operator still owes a
    // key", and it is what makes the masked card offer that field. CONNECT-4 reads a NON-empty env
    // value as configuration the operator already answered, which is why the model's schema takes
    // names and never a map: the model has no way to write one.
    assert.equal(buildServerConfigJson({ name: "acme" }), null);
  } finally {
    await loaded.dispose();
  }
});

test("MARKET-6: a key the model typed is refused, with the placeholder to use instead", async () => {
  const loaded = await loadModule("source/host/runner/tools/sand-mcp-management-tools.ts");
  try {
    const { credentialLiteralRefusal } = loaded.module;

    // The refusal has to be actionable, not a scolding: it names the field to write and where the
    // person types the value. A model told only "no" asks the user to paste the key into chat.
    const refusal = credentialLiteralRefusal("acme", { Authorization: "Bearer sk-live-abc" }, undefined);
    assert.match(refusal, /Authorization/);
    assert.match(refusal, /\$\{ACME_TOKEN\}/);
    assert.match(refusal, /masked box/);
    assert.match(refusal, /stored in this conversation/);

    assert.match(credentialLiteralRefusal("acme", { "x-api-key": "sk-live-abc" }, undefined), /masked box/);
    assert.match(credentialLiteralRefusal("acme", { "x-browser-use-api-key": "bu_live" }, undefined), /masked box/);

    // A placeholder is the whole point, so it passes.
    assert.equal(credentialLiteralRefusal("acme", { Authorization: "Bearer ${ACME_TOKEN}" }, undefined), null);
    // A header that carries no key is a documented, ordinary thing and must not be refused.
    assert.equal(credentialLiteralRefusal("acme", { "x-mcp-servers": "acme", Accept: "application/json" }, undefined), null);

    // env is NAMES. A "NAME=value" pair is the model trying to set the value anyway.
    assert.match(credentialLiteralRefusal("acme", undefined, ["ACME_TOKEN=sk-live-abc"]), /only the NAME/);
    assert.equal(credentialLiteralRefusal("acme", undefined, ["ACME_TOKEN"]), null);
  } finally {
    await loaded.dispose();
  }
});

test("MARKET-6: the URL the model gives goes through the SAME rules as the file's own writer", async () => {
  const loaded = await loadModule("source/host/runner/tools/sand-mcp-management-tools.ts");
  try {
    const { validateRemoteMcpUrl } = loaded.module;
    // Not a restatement of the writer's rules but the writer's own function, because a second copy
    // is how the reserved-name rule ended up made in four places and enforced in three.
    assert.equal(validateRemoteMcpUrl("https://mcp.example.com/mcp"), null);
    assert.match(validateRemoteMcpUrl("http://127.0.0.1:1340/api"), /points back at the box itself/);
    assert.match(validateRemoteMcpUrl("https://mcp.example.com/mcp?api_key=sk-live"), /Take "api_key" out/);
    assert.match(validateRemoteMcpUrl("http://mcp.example.com/mcp"), /plain http/);
    assert.match(validateRemoteMcpUrl("nonsense"), /is not a web address/);

    // And the retired product name and the false claim about stdio are gone from the message.
    const message = validateRemoteMcpUrl("file:///etc/passwd");
    assert.doesNotMatch(message, /Grok Bot/i);
    assert.doesNotMatch(message, /not supported/i);
  } finally {
    await loaded.dispose();
  }
});

// Driving one tool without the whole turn machinery. A communicate tool's execute takes the turn
// context and the interaction handler that wraps every call in a widget; the handler here just runs
// the body and hands back what it produced, which is the part these cases are about.
let contextModule = null;
async function turnContext() {
  contextModule ??= await loadModule("source/packages/context/core.ts");
  return contextModule.module.createContext().withName("test");
}

async function runTool(tool, args) {
  // The real call site streams the model's arguments in as JSON chunks, so the schema is exercised
  // here the way it is in a turn rather than bypassed.
  const argsStream = (async function* () { yield JSON.stringify(args); })();
  const handler = {
    emitPartialToolCall: () => {},
    executeToolCall: async (_ctx, _initial, _id, run) => run(),
  };
  const result = await tool.execute(await turnContext(), handler, argsStream, { toolCallId: "test-call" });
  const value = result?.result?.value;
  return value?.currentStep ?? value?.error ?? JSON.stringify(result);
}

test("MARKET-6: nothing the model reads still claims this box cannot run a local server", async () => {
  const loaded = await loadModule("source/host/runner/tools/sand-mcp-management-tools.ts");
  try {
    const tools = loaded.module.createMcpManagementTools({
      listPlugins: async () => [], getPlugin: async () => null, install: async () => {},
      add: async () => [], listInstalled: async () => [],
      removeServer: async () => ({ removed: true, servers: [] }),
      uninstallPlugin: async () => ({ removed: true }), setInstructions: async () => [],
      restart: async () => [], authenticate: async () => ({ kind: "not-configured", serverName: "x" }),
      removeAccount: async () => [], renameAccount: async () => [],
    });
    const describe = (tool) => `${tool.name ?? ""} ${tool.descriptionGenerator?.() ?? ""}`;
    const descriptions = tools.map(describe).join("\n");
    // The exact sentence that was there, and the retired product name anywhere in the surface the
    // model reads before it decides whether to help.
    assert.doesNotMatch(descriptions, /local\/stdio servers are not supported/i);
    assert.doesNotMatch(descriptions, /executed on the backend/i);
    assert.doesNotMatch(descriptions, /Grok Bot/i);
    // And AddMcpServer now tells the model the truth about both shapes.
    const add = tools.find((tool) => tool.name === "AddMcpServer");
    assert.ok(add != null, "AddMcpServer is missing");
    assert.match(add.descriptionGenerator(), /`command`/);
    assert.match(add.descriptionGenerator(), /NEVER put a key/);
  } finally {
    await loaded.dispose();
  }
});

test("MARKET-6: uninstalling a server offers to clear its key, and says which way it went", async () => {
  const loaded = await loadModule("source/host/runner/tools/sand-mcp-management-tools.ts");
  try {
    const row = {
      id: "1001", serverIdentifier: "acme", name: "acme", status: "connected", accountKey: "default",
      transport: "http", toolCount: 2, customInstructions: "",
    };
    const calls = [];
    const make = () => loaded.module.createMcpManagementTools({
      listPlugins: async () => [], getPlugin: async () => null, install: async () => {},
      add: async () => [], listInstalled: async () => [row],
      removeConnector: async (args) => { calls.push(args); return { removed: true, cleared: args.clearSecrets ? ["ACME_TOKEN"] : [] }; },
      removeServer: async () => { throw new Error("the account writer must not be reached"); },
      uninstallPlugin: async () => ({ removed: true }), setInstructions: async () => [],
      restart: async () => [], authenticate: async () => ({ kind: "not-configured", serverName: "x" }),
      removeAccount: async () => [], renameAccount: async () => [],
    });
    const tool = make().find((entry) => entry.name === "UninstallMcpServer");

    const kept = await runTool(tool, { server_id: "acme" });
    assert.match(kept, /Removed MCP server acme/);
    assert.match(kept, /stored key was kept/);
    assert.equal(calls.at(-1).clearSecrets, false);

    const cleared = await runTool(tool, { server_id: "acme", clear_stored_values: true });
    assert.match(cleared, /Cleared its stored ACME_TOKEN/);
    assert.equal(calls.at(-1).clearSecrets, true);
  } finally {
    await loaded.dispose();
  }
});

test("MARKET-6: a status read speaks the host's sentence and lists the tools", async () => {
  const loaded = await loadModule("source/host/runner/tools/sand-mcp-management-tools.ts");
  try {
    const row = {
      id: "1001", serverIdentifier: "acme", name: "acme", status: "error", accountKey: "default",
      transport: "http", toolCount: 0, customInstructions: "",
      statusDetail: "MCP error -32000: Connection closed; stderr: SseError: Non-200 status code (401) at EventSource.failConnection_fn (/root/.npm/_npx/705d/node_modules/eventsource/dist/index.js:290:20)",
      statusSentence: "It needs its key before it can connect. Add the key below.",
    };
    const tools = loaded.module.createMcpManagementTools({
      listPlugins: async () => [], getPlugin: async () => null, install: async () => {},
      add: async () => [], listInstalled: async () => [row],
      listServerTools: async () => [{ name: "search_docs", enabled: true }, { name: "fetch_page", enabled: false }],
      removeServer: async () => ({ removed: true, servers: [] }),
      uninstallPlugin: async () => ({ removed: true }), setInstructions: async () => [],
      restart: async () => [], authenticate: async () => ({ kind: "not-configured", serverName: "x" }),
      removeAccount: async () => [], renameAccount: async () => [],
    });
    const answer = await runTool(tools.find((tool) => tool.name === "GetMcpServerStatus"), { server_id: "acme" });
    assert.match(answer, /It needs its key before it can connect/);
    // The Node stack must not be what the model reads out to a person.
    assert.doesNotMatch(answer, /failConnection_fn/);
    assert.doesNotMatch(answer, /-32000/);
    assert.match(answer, /Tools: search_docs, fetch_page \(disabled\)/);
  } finally {
    await loaded.dispose();
  }
});
