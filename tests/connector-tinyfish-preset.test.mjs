// CONNECT-3 / CONNECT-4, the console half: the TinyFish (API key) preset in the connector editor,
// and the rule that decides which environment values the credential card offers.
//
// The facts the preset entry is built from, measured on 2026-09-04/05 and written up in
// docs/CONNECTORS-TINYFISH.md: https://agent.tinyfish.ai/mcp refuses an X-API-Key header, and
// TinyFish's own CLI docs (npm @tiny-fish/cli, "Connect Grok") pass the API key as
// `Authorization: Bearer <key>`. mcp-remote carries a custom header with `--header "Name: value"`
// and expands ${VAR} in that value from its own environment, so the literal text
// ${TINYFISH_API_KEY} is what belongs in connectors.json -- never a key. Nothing in this file
// touches a real key: the entry is a shape, not a credential.
//
// CONNECT-4's rule, which the console mirrors while it waits for the host to answer: an env key
// whose value in the entry is the EMPTY string is a credential field; one that carries a value is
// configuration and is never offered as somewhere to paste a key. That distinction is the bug this
// wave exists for -- MCP_REMOTE_CONFIG_DIR is a path, the card offered it, and a key went into it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OAUTH_TINYFISH = {
  mcpServers: {
    tinyfish: {
      command: "npx",
      args: ["-y", "mcp-remote", "https://agent.tinyfish.ai/mcp", "--transport", "http-only"],
      env: { MCP_REMOTE_CONFIG_DIR: "/home/box/sand-data/.mcp-auth" },
    },
  },
};

// The same harness tests/machine-room-connectors.test.mjs uses: the adapter's IIFE is run with a
// stub window and fetch, and the functions under test are handed back through window.__test.
async function loadAdapter(answers = {}, options = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { createGatewayAdapter, connectorPlugins };\n  global.__bootMachineRoom =",
  );
  const calls = [];
  const posts = [];
  let connectors = options.connectors ?? OAUTH_TINYFISH;
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: () => 0,
    clearInterval: () => {},
    EventSource: function () { return { onmessage: null }; },
    crypto: { randomUUID: () => "nonce-0001" },
    open: () => {},
  };
  // MARKET-6: a box on today's bundle has no addLocalConnector, so the console writes the preset
  // through the relay exactly as it always has. That is the path this file is about.
  const missing = (method) => () => new Error(`unknown gateway method: ${method}`);
  const defaults = {
    listAgents: [], getTrays: [], getAgentAutomations: [], getAgentWorkflows: [], getConversationOutline: [], getAgentTranscriptTail: { entries: [] },
    addLocalConnector: missing("addLocalConnector"), removeLocalConnector: missing("removeLocalConnector"),
    previewLocalConnector: missing("previewLocalConnector"), setPluginCredential: missing("setPluginCredential"),
    listConnectorSecretOrphans: missing("listConnectorSecretOrphans"),
  };
  const fetchStub = async (url, init) => {
    const target = String(url);
    if (target === "/connectors") {
      if (init?.method === "POST") {
        const parsed = JSON.parse(init.body);
        posts.push(parsed);
        connectors = { mcpServers: parsed.mcpServers };
        return { ok: true, json: async () => ({ saved: Object.keys(parsed.mcpServers) }), text: async () => "{}" };
      }
      return { ok: true, json: async () => connectors, text: async () => JSON.stringify(connectors) };
    }
    if (!target.startsWith("/api/")) return { ok: true, text: async () => "{}", json: async () => ({}) };
    const method = target.slice(5);
    const args = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, args });
    const answer = answers[method] ?? defaults[method] ?? {};
    const value = typeof answer === "function" ? answer(args, calls) : answer;
    if (value instanceof Error) return { ok: false, status: 500, text: async () => JSON.stringify({ error: value.message }) };
    return { ok: true, text: async () => JSON.stringify(value) };
  };
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  return { ...fn(window, fetchStub), calls, posts, config: () => connectors };
}

const seed = () => ({
  activeContext: { kind: "worker", id: "w1" },
  openContexts: [{ kind: "worker", id: "w1" }],
  workers: [{ id: "w1", name: "Probe", role: "", description: "", status: "ready", statusText: "Ready", messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, hasOlder: false, composer: null }],
  rooms: [], routines: [], plugins: [], models: { default: "d", available: [] },
  settings: { autoReview: { enabled: false, allow: [], block: [] }, localToolPermission: null, reachable: true },
  desktop: { paused: false, timeline: [] }, teaching: { active: false, workerId: null, startedAt: null },
  agentCount: 1, search: { enabled: false },
});

const TINYFISH_ARGS = ["-y", "mcp-remote", "https://agent.tinyfish.ai/mcp", "--transport", "http-only", "--header", "Authorization:Bearer ${TINYFISH_API_KEY}"];
const TINYFISH_ARGS_TEXT = '-y mcp-remote https://agent.tinyfish.ai/mcp --transport http-only --header "Authorization:Bearer ${TINYFISH_API_KEY}"';

// -- The preset entry, character for character. Every part of it is load-bearing: the bearer
// header rather than X-API-Key, no space after the colon, and the unexpanded ${TINYFISH_API_KEY}.
test("the TinyFish preset is the entry the contract fixes, with the key named and never held", async () => {
  const { createGatewayAdapter } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  const presets = adapter.connectorPresets();
  const tinyfish = presets.find((p) => p.id === "tinyfish") ?? null;
  assert.ok(tinyfish, "the editor offers no TinyFish preset");
  assert.equal(tinyfish.label, "TinyFish (API key)");
  assert.equal(tinyfish.name, "tinyfish");
  assert.equal(tinyfish.command, "npx");
  assert.deepEqual(tinyfish.args, TINYFISH_ARGS);
  // The header is a bearer, not X-API-Key: the MCP endpoint refuses the latter.
  assert.equal(tinyfish.args[tinyfish.args.length - 2], "--header");
  assert.match(tinyfish.args[tinyfish.args.length - 1], /^Authorization:Bearer /);
  // No space after the colon -- the form mcp-remote's README asks for from clients that mangle
  // spaces inside an argument.
  assert.equal(tinyfish.args.some((a) => a.includes("Authorization: ")), false);
  // The env key is declared with NO value, which is what makes it a credential field below.
  assert.deepEqual(tinyfish.envNames, ["TINYFISH_API_KEY"]);
  // A box wants one TinyFish, so this preset owns its name.
  assert.equal(tinyfish.replaces, true);
});

// -- The argument field is one line of text. The header argument holds a space, so a whitespace
// split cannot express this entry at all: it arrives as two arguments and the header is lost.
test("the preset's argument text round-trips to exactly those arguments", async () => {
  const { createGatewayAdapter } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  const tinyfish = adapter.connectorPresets().find((p) => p.id === "tinyfish");
  assert.equal(tinyfish.argsText, TINYFISH_ARGS_TEXT);
  assert.deepEqual(adapter.splitConnectorArgs(tinyfish.argsText), TINYFISH_ARGS);
  // And the old behaviour is unchanged for everything that carries no quote.
  assert.deepEqual(adapter.splitConnectorArgs("  -y  @modelcontextprotocol/server-filesystem /workspace "), ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]);
  assert.deepEqual(adapter.splitConnectorArgs(""), []);
  assert.deepEqual(adapter.splitConnectorArgs("--header 'X-Api:one two'"), ["--header", "X-Api:one two"]);
});

// -- The write the console makes from that preset: the literal ${TINYFISH_API_KEY} in the file,
// the env key with an empty value, and no key anywhere.
test("saving the preset writes the entry with an empty env value and the placeholder unexpanded", async () => {
  const { createGatewayAdapter, posts, config } = await loadAdapter({ listInstalledMcpServers: [] }, { connectors: { mcpServers: {} }, });
  const adapter = createGatewayAdapter(seed());
  const preset = adapter.connectorPresets().find((p) => p.id === "tinyfish");
  const result = await adapter.addConnector({ name: preset.name, command: preset.command, args: adapter.splitConnectorArgs(preset.argsText), envNames: preset.envNames, replace: true });
  assert.equal(result.accepted, true);
  assert.deepEqual(posts[0].mcpServers.tinyfish, { command: "npx", args: TINYFISH_ARGS, env: { TINYFISH_API_KEY: "" } });
  assert.equal(JSON.stringify(config()).includes("${TINYFISH_API_KEY}"), true);
});

// -- "It replaces the OAuth entry of the same name if present, since a box wants one TinyFish."
// A duplicate typed by hand is still refused; only a preset that owns its name may overwrite.
test("the preset replaces an existing tinyfish entry and a hand-typed duplicate is still refused", async () => {
  const { createGatewayAdapter, posts } = await loadAdapter({ listInstalledMcpServers: [] });
  const adapter = createGatewayAdapter(seed());
  const refused = await adapter.addConnector({ name: "tinyfish", command: "npx", args: [], envNames: [] });
  assert.equal(refused.accepted, false);
  assert.match(refused.message, /already configured on the box/);
  assert.equal(posts.length, 0);
  const replaced = await adapter.addConnector({ name: "tinyfish", command: "npx", args: TINYFISH_ARGS, envNames: ["TINYFISH_API_KEY"], replace: true });
  assert.equal(replaced.accepted, true);
  assert.match(replaced.message, /tinyfish replaced/);
  // The OAuth entry is gone whole: its MCP_REMOTE_CONFIG_DIR does not survive into the new one.
  assert.deepEqual(posts[0].mcpServers.tinyfish.env, { TINYFISH_API_KEY: "" });
});

// -- CONNECT-4, mirrored on the card. This is the bug the wave exists for: a path was offered as
// somewhere to "Enter securely" and a pasted key went into it.
test("the credential card offers only the env values the entry leaves empty", async () => {
  const { connectorPlugins } = await loadAdapter(
    {
      listInstalledMcpServers: [{ id: 1, name: "tinyfish", status: "connected", transport: "stdio", toolCount: 2 }],
      listMcpServerTools: [{ name: "search", description: "Search the web", enabled: true }],
      listConnectorSecretFields: { server: "tinyfish", serverId: 1, fields: [] },
    },
    {
      connectors: {
        mcpServers: {
          tinyfish: {
            command: "npx",
            args: TINYFISH_ARGS,
            env: { TINYFISH_API_KEY: "", MCP_REMOTE_CONFIG_DIR: "/home/box/sand-data/.mcp-auth" },
          },
        },
      },
    },
  );
  const [card] = await connectorPlugins();
  assert.deepEqual(card.secretFields, ["TINYFISH_API_KEY"]);
  assert.equal(card.secretFields.includes("MCP_REMOTE_CONFIG_DIR"), false);
  // And the configuration value itself stays off the card, the way argv already does.
  assert.equal(card.description.includes("/home/box/sand-data/.mcp-auth"), false);
});

// -- The host stays the authority: a field it reports holding is offered even where the entry
// gives that key a value, or a credential already stored would have no input to replace it.
test("a field the host already holds is offered even when the entry gives that key a value", async () => {
  const { connectorPlugins } = await loadAdapter(
    {
      listInstalledMcpServers: [{ id: 1, name: "tinyfish", status: "connected", transport: "stdio", toolCount: 2 }],
      listMcpServerTools: [],
      listConnectorSecretFields: { server: "tinyfish", serverId: 1, fields: ["TINYFISH_API_KEY"], stored: ["TINYFISH_API_KEY"] },
    },
    { connectors: { mcpServers: { tinyfish: { command: "npx", args: TINYFISH_ARGS, env: { TINYFISH_API_KEY: "placeholder", MCP_REMOTE_CONFIG_DIR: "/home/box/sand-data/.mcp-auth" } } } } },
  );
  const [card] = await connectorPlugins();
  assert.deepEqual(card.secretFields, ["TINYFISH_API_KEY"]);
  assert.deepEqual(card.storedFields, ["TINYFISH_API_KEY"]);
});

// -- The flow this wave exists for, at the step the operator does it: the preset was added, the
// entry declares TINYFISH_API_KEY empty, the store holds nothing. The host's `fields` names the
// field (that is CONNECT-4's union), and reading THAT for "already held" captioned the input "The
// host holds a value - type to replace it" on a card with no key in it. Only `stored` may say so.
test("a declared but unstored credential is offered, not reported as already held", async () => {
  const { connectorPlugins } = await loadAdapter(
    {
      listInstalledMcpServers: [{ id: 1, name: "tinyfish", status: "initializing", transport: "stdio", toolCount: 0 }],
      listMcpServerTools: [],
      listConnectorSecretFields: { server: "tinyfish", serverId: 1, fields: ["TINYFISH_API_KEY"], stored: [] },
    },
    { connectors: { mcpServers: { tinyfish: { command: "npx", args: TINYFISH_ARGS, env: { TINYFISH_API_KEY: "" } } } } },
  );
  const [card] = await connectorPlugins();
  assert.deepEqual(card.secretFields, ["TINYFISH_API_KEY"]);
  assert.deepEqual(card.storedFields, []);
});

// A host that predates the `stored` list says nothing about what it holds, and the card must not
// invent it: "Enter securely" is the honest caption, and storing over a value that is there is
// what the field does anyway.
test("a host that answers no stored list leaves the card claiming nothing is held", async () => {
  const { connectorPlugins } = await loadAdapter(
    {
      listInstalledMcpServers: [{ id: 1, name: "tinyfish", status: "connected", transport: "stdio", toolCount: 0 }],
      listMcpServerTools: [],
      listConnectorSecretFields: { server: "tinyfish", serverId: 1, fields: ["TINYFISH_API_KEY"] },
    },
    { connectors: { mcpServers: { tinyfish: { command: "npx", args: TINYFISH_ARGS, env: { TINYFISH_API_KEY: "" } } } } },
  );
  const [card] = await connectorPlugins();
  assert.deepEqual(card.secretFields, ["TINYFISH_API_KEY"]);
  assert.deepEqual(card.storedFields, []);
});

/* ------------------------------------------------------------------------------------------- *
 * PROXY-1, leg one: the same preset, bridged to the proxy instead of the public endpoint.
 *
 * ONE catalog entry serves an operator install and a tenant box. With no proxy configured the
 * entry is the public one character for character -- that is the first assertion below and it is
 * the one that keeps an operator install unchanged. With a proxy configured the far end and the
 * two headers move, and the placeholder now expands to that BOX's virtual key rather than the
 * operator's TinyFish key, so the migration can take the operator's key out of the box and the
 * connector keeps working.
 *
 * Measured against LiteLLM v1.100.0 on this Mac, 2026-09-08 (docker, stub upstream): mcp-remote
 * connects to the mount, initializes and lists tools with exactly these two headers.
 * ------------------------------------------------------------------------------------------- */
test("the catalog's TinyFish entry is the public one until a proxy is configured, and then it bridges to the proxy", async () => {
  const source = await readFile(path.join(repoRoot, "source/shared/marketplace/catalog.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  const catalog = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const tinyfish = catalog.findMarketplacePlugin("tinyfish");

  // No proxy: byte for byte what an operator install has always had.
  assert.deepEqual(catalog.marketplaceConnectorEntry(tinyfish).args, TINYFISH_ARGS);
  assert.deepEqual(catalog.marketplaceConnectorEntry(tinyfish, {}).args, TINYFISH_ARGS);
  assert.deepEqual(catalog.marketplaceConnectorEntry(tinyfish, { proxyMcpUrl: null }).args, TINYFISH_ARGS);
  assert.deepEqual(catalog.marketplaceConnectorEntry(tinyfish, { proxyMcpUrl: "" }).args, TINYFISH_ARGS);

  // With a proxy: the mount, the key header the bridge does not own, and the server name.
  const tenant = catalog.marketplaceConnectorEntry(tinyfish, { proxyMcpUrl: "http://titanbot-proxy:4000/mcp/" });
  assert.deepEqual(tenant.args, [
    "-y", "mcp-remote", "http://titanbot-proxy:4000/mcp/", "--transport", "http-only",
    "--header", "x-litellm-api-key:Bearer ${TINYFISH_API_KEY}",
    "--header", "x-mcp-servers:tinyfish",
  ]);
  // The credential name does not move, so the box's own 0600 store and the card keep one name.
  assert.deepEqual(tenant.env, { TINYFISH_API_KEY: "" });
  // Authorization stays free: mcp-remote uses it for its own OAuth discovery, which is why the
  // proxy's alternate header name exists at all.
  assert.equal(tenant.args.some((a) => a.startsWith("Authorization:")), false);
  // Still no key anywhere, still the unexpanded placeholder.
  assert.equal(JSON.stringify(tenant).includes("${TINYFISH_API_KEY}"), true);

  // A plugin that is not on a plan is untouched by the option: only a declared mount is bridged.
  const github = catalog.findMarketplacePlugin("github");
  assert.deepEqual(
    catalog.marketplaceConnectorEntry(github, { proxyMcpUrl: "http://titanbot-proxy:4000/mcp/" }),
    catalog.marketplaceConnectorEntry(github),
  );
});

test("the credential card says a customer on a plan needs no key of their own", async () => {
  const source = await readFile(path.join(repoRoot, "source/shared/marketplace/catalog.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  const catalog = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const hint = catalog.findMarketplacePlugin("tinyfish").credentialHints.TINYFISH_API_KEY;
  assert.match(hint, /included with your plan you need no key here at all/);
  // Plain words on the customer's side: no vendor of ours, no dollars, no tool name.
  assert.equal(/LiteLLM|virtual key|proxy/i.test(hint), false);
  // And the console's own preset row carries the same sentence, or the two drift.
  const adapter = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  assert.equal(adapter.includes("included with your plan you need no key here at all"), true);
});

// -- app.js's half, asserted on the source: both are inside the delegated click and submit
// handlers rather than in a function a stub can call.
test("app.js fills the form from the preset and saves nothing on the click", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("} else if (target.dataset.connectorPreset) {");
  assert.notEqual(start, -1, "app.js has no preset click handler");
  const handler = source.slice(start, source.indexOf("} else if (target.dataset.removeConnector)", start));
  assert.match(handler, /querySelector\('\[name="args"\]'\)\.value = preset\.argsText/);
  assert.equal(/addConnector/.test(handler), false, "the preset click must fill the form, not write connectors.json");
  // The editor draws a button per preset, so a preset added to the adapter needs no view change.
  assert.match(source, /data-connector-preset="\$\{escapeHtml\(p\.id\)\}"/);
  // The submit uses the adapter's quote-aware split, or the bearer header arrives as two arguments.
  assert.match(source, /adapter\.splitConnectorArgs\(argsText\)/);
  // And only a save of the preset's own name may overwrite an entry already using it.
  assert.match(source, /form\.dataset\.presetName === spec\.name\) spec\.replace = true/);
});
