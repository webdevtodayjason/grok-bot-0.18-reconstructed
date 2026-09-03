// The Plugins page used to render three lies at once: every card hardcoded `tools: []` and
// `skills: []`, a provider the host cannot adopt still offered a Connect button, and the key form
// said the value was discarded while the relay stored it. These pin the builders behind that page
// against the shapes the live gateway actually returns (captured from this box on 2026-09-02):
//   listRoutedMcpTools  -> [{ name, providerIdentifier, toolName, description, inputSchema }]
//   listBoxMcpServers   -> { servers: [{ serverIdentifier, status, toolCount }] }
//   GET /connectors     -> { mcpServers: { localfiles: { command, args, env } } }
//   GET /subscriptions  -> { subscriptions: [{ id, name, route, adopted, usable, endpointId }] }
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONNECTORS = { mcpServers: { localfiles: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"], env: {} } } };
const ROUTED_TOOLS = ["read_file", "read_text_file", "write_file"].map((toolName) => ({
  name: `localfiles-${toolName}`, providerIdentifier: "localfiles", toolName, description: `${toolName} description`,
}));
const BOX_SERVERS = { servers: [{ serverIdentifier: "localfiles", status: "connected", toolCount: 14 }] };

// The adapter is an IIFE that attaches to window and opens an EventSource at load; give it just
// enough of a page to evaluate, then reach in for the pure builders worth pinning.
async function loadAdapterInternals() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { messagesOf, subscriptionPlugins, connectorPlugins, pluginsOf, routinesOf };\n  global.__bootMachineRoom =",
  );
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    EventSource: function () { return { onmessage: null }; },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, removeAttribute() {} } },
    open: () => {},
  };
  const fetchStub = async (url) => {
    if (String(url) === "/connectors") return { ok: true, json: async () => CONNECTORS, text: async () => JSON.stringify(CONNECTORS) };
    if (String(url) === "/api/listRoutedMcpTools") return { ok: true, text: async () => JSON.stringify(ROUTED_TOOLS) };
    if (String(url) === "/api/listBoxMcpServers") return { ok: true, text: async () => JSON.stringify(BOX_SERVERS) };
    return { ok: true, text: async () => "{}", json: async () => ({}) };
  };
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  return fn(window, fetchStub);
}

const { messagesOf, subscriptionPlugins, connectorPlugins, pluginsOf, routinesOf } = await loadAdapterInternals();

test("a connector card carries the box's real server and its real tools", async () => {
  const cards = await connectorPlugins();
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.id, "mcp:localfiles");
  assert.equal(card.group, "Connectors");
  assert.equal(card.status, "connected");
  assert.equal(card.tools.length, ROUTED_TOOLS.length);
  assert.deepEqual(card.tools.map((t) => t.name), ["read_file", "read_text_file", "write_file"]);
  // The host stores per-tool disables under numeric server ids only, so a switch here would be
  // accepted and dropped. Read-only, and the copy says why.
  assert.equal(card.tools.every((t) => t.togglable === false), true);
  assert.match(card.toolsReadOnlyNote, /numeric server id/);
  // getListenerConnectUrl is a chat-platform command; an MCP server is not one.
  assert.equal(card.connectable, false);
  assert.match(card.description, /14 tool\(s\) discovered/);
  // The description is painted straight into the dashboard DOM, and connectors.json is the 0600
  // file ui/server.mjs describes as carrying connector tokens in plaintext -- a stdio MCP server
  // is routinely launched with --api-key= or an Authorization header in argv. Executable only.
  assert.match(card.description, /Runs in the box as npx \(3 argument\(s\), configured in connectors\.json\)/);
  for (const arg of CONNECTORS.mcpServers.localfiles.args) assert.equal(card.description.includes(arg), false, `argv leaked into the card: ${arg}`);
});

test("a provider the host cannot route to is not connectable, and says why", () => {
  const rows = [
    { id: "zai", name: "Z.AI GLM", route: "key", adopted: false, usable: true, endpointId: "sub-zai", posture: "." },
    { id: "claude", name: "Claude subscription", route: "runtime", adopted: false, usable: true, endpointId: null, posture: "." },
    { id: "grok", name: "Grok CLI", route: "none", adopted: false, usable: false, endpointId: null, posture: "." },
    { id: "codex", name: "ChatGPT / Codex", route: "endpoint", adopted: false, usable: true, endpointId: "sub-codex", posture: "." },
    // Route "endpoint" but the provider's own CLI holds no usable login on this Mac. This is the
    // card that used to draw a Connect button: clicking it called getListenerConnectUrl with a
    // subscription id, which does not error -- it answers with an unrelated URL -- so the toast
    // reported a success that never happened.
    { id: "minimax", name: "MiniMax", route: "endpoint", adopted: false, usable: false, endpointId: "sub-minimax", posture: ".", source: "~/.minimax/auth.json" },
  ];
  const [key, runtime, none, cliReady, cliMissing] = subscriptionPlugins(rows, null);
  assert.equal(key.connectable, true);
  assert.equal(key.secretField, "API key");
  // Where the value goes, on a form that used to say it was thrown away.
  assert.match(key.secretHint, /0600 store/);
  assert.equal(runtime.connectable, false);
  assert.match(runtime.connectNote, /Not adoptable here/);
  assert.equal(none.connectable, false);
  assert.match(none.connectNote, /Not usable on this box/);
  // Route alone is not the test: a CLI-login card is connectable only when there is a login here.
  assert.equal(cliReady.connectable, true);
  assert.equal(cliMissing.connectable, false);
  assert.match(cliMissing.connectNote, /Nothing to adopt yet/);
  assert.match(cliMissing.connectNote, /auth\.json/);
  // A provider is an endpoint, not a toolset; the Tools section says that instead of "0/0".
  for (const card of [key, runtime, none, cliReady, cliMissing]) assert.match(card.toolsNote, /not a toolset/);
});

test("a listener card says what it is instead of showing an empty tool list", () => {
  const [card] = pluginsOf([{ platform: "slack", isConnected: false, state: "idle" }]);
  assert.equal(card.group, "Listeners");
  assert.deepEqual(card.tools, []);
  assert.match(card.toolsNote, /not a toolset/);
});

test("a routine the host reports as running is running", () => {
  const started = Date.now() - 5000;
  const [live] = routinesOf([{ id: "a", name: "Sweep", isEnabled: true, runs: [{ status: "running", startedAt: started }] }], { kind: "worker", id: "w1" });
  assert.equal(live.status, "running");
  const [ok] = routinesOf([{ id: "b", name: "Sweep", isEnabled: true, runs: [{ status: "ok", startedAt: started, finishedAt: started + 1000 }] }], { kind: "worker", id: "w1" });
  assert.equal(ok.status, "ready");
  const [paused] = routinesOf([{ id: "c", name: "Sweep", isEnabled: false, runs: [{ status: "running", startedAt: started }] }], { kind: "worker", id: "w1" });
  assert.equal(paused.status, "paused");
});

test("an evidence verdict becomes a pill that carries its attempt id", () => {
  const stamped = (verdict, extra = {}) => ({
    kind: "send-message", id: `e-${verdict}`, timestampMs: 1,
    message: { type: "text", content: `a reply judged ${verdict}` },
    evidence: { attemptId: `att-${verdict}`, verdict, receipts: 1, attestations: ["x"], missing: [], ...extra },
  });
  const rows = messagesOf([stamped("evidenced"), stamped("unsupported", { missing: ["/workspace/report.md"] }), stamped("conversational")], "Atera", null);
  const pills = rows.filter((r) => r.type === "system" && r.text.startsWith("Evidence:"));
  // "conversational" makes no checkable claim, so it gets no pill; the other two do.
  assert.equal(pills.length, 2);
  assert.deepEqual(pills.map((p) => p.evidence.attemptId), ["att-evidenced", "att-unsupported"]);
  assert.match(pills[0].text, /1 receipt behind this reply/);
  assert.match(pills[1].text, /report\.md/);
});
