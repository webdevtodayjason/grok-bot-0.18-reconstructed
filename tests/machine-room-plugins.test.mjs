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
    "  global.__test = { messagesOf, subscriptionPlugins, connectorPlugins, pluginsOf, routinesOf, includedPlugins, endpointModels };\n  global.__bootMachineRoom =",
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

const { messagesOf, subscriptionPlugins, connectorPlugins, pluginsOf, routinesOf, includedPlugins, endpointModels } = await loadAdapterInternals();

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

test("an evidence verdict rides on the reply it judged, never as a line of its own", () => {
  const stamped = (verdict, extra = {}) => ({
    kind: "send-message", id: `e-${verdict}`, timestampMs: 1,
    message: { type: "text", content: `a reply judged ${verdict}` },
    evidence: { attemptId: `att-${verdict}`, verdict, receipts: 1, attestations: ["x"], missing: [], ...extra },
  });
  const rows = messagesOf([stamped("evidenced"), stamped("unsupported", { missing: ["/workspace/report.md"] }), stamped("conversational")], "Atera", null);
  // EVID-UX-1: the adapter used to synthesize an "Evidence: <verdict> · <why>" system message
  // under each judged reply, and an operator read that as an error on a reply that had in fact
  // been delivered. The stamp stays on the reply; the view draws it as a chip in the same row.
  assert.equal(rows.filter((r) => r.type === "system").length, 0);
  assert.deepEqual(rows.map((r) => r.evidence?.verdict), ["evidenced", "unsupported", "conversational"]);
  assert.deepEqual(rows.map((r) => r.evidence?.attemptId), ["att-evidenced", "att-unsupported", "att-conversational"]);
  // The missing token stays in the stamp, for the Claim provenance panel, and is never text on a row.
  assert.deepEqual(rows[1].evidence.missing, ["/workspace/report.md"]);
  assert.ok(!rows.some((r) => r.text.includes("/workspace/report.md")));
});


// ---- PROXY-1: the plan's own cards, and the section they live in -------------------------------
//
// The included rows are the one thing on Settings a customer neither owns nor can edit, and the
// card has to say so by what it does NOT have. Every field asserted below is a thing a provider
// card carries and this one must not: a secret field, a Connect form, an account to name, a
// dollar figure.

// What GET /endpoints answers in its `included` array. The relay computes these from the registry
// per request; the key is never in them, which is why there is nothing key-shaped to assert.
const INCLUDED = [
  { id: "plan-zai", model: "plan-zai", name: "Z.AI GLM (included with your plan)", baseUrl: "http://titanbot-proxy:4000/v1", contextWindow: 200000, servedBy: "Z.AI", apiKey: "included", enforced: false, health: { reachable: true } },
  { id: "plan-minimax", model: "plan-minimax", name: "MiniMax M3 (included with your plan)", baseUrl: "http://titanbot-proxy:4000/v1", contextWindow: 1000000, servedBy: "MiniMax", apiKey: "included", enforced: true, health: { reachable: true } },
];

test("a plan card has nothing to paste, nothing to connect and no money on it", () => {
  const cards = includedPlugins(INCLUDED, "plan-zai");
  assert.equal(cards.length, 2);
  const [zai, minimax] = cards;

  assert.equal(zai.group, "Plan");
  // Prefixed so it cannot collide with a connector or a subscription card, while the ENDPOINT id
  // underneath stays bare -- that string is what the relay resolves and the model menu carries.
  assert.equal(zai.id, "plan:plan-zai");
  assert.equal(zai.endpointId, "plan-zai");
  assert.equal(zai.live, true, "the one the box answers through says so");
  assert.equal(minimax.live, false);

  // No key form, on any card, in any state. There is no credential for a customer to supply here.
  for (const card of cards) {
    assert.equal(card.secretField, null);
    assert.deepEqual(card.secretFields, []);
    assert.equal(card.connectable, false, "there is nothing to connect");
    assert.equal(card.status, "connected", "and nothing to do before it works");
    assert.match(card.toolsNote, /not a toolset/);
  }

  // One plain line, in words. Percent and words on the customer's side; dollars live in the admin
  // console and are not a thing a customer is shown here.
  assert.match(zai.connectedNote, /^Included with your plan\./);
  assert.match(minimax.connectedNote, /Titan will say so/, "an enforced plan says what happens at the end of it");
  for (const card of cards) {
    for (const forbidden of ["$", "dollar", "USD", "budget", "titanbot", "proxy", "sk-"]) {
      const text = `${card.name} ${card.description} ${card.connectedNote} ${card.account} ${card.category}`;
      assert.equal(text.includes(forbidden), false, `"${forbidden}" is on a card a customer reads`);
    }
  }

  // Nothing at all when the plan is off, which is a developer Mac and a single-box install.
  assert.deepEqual(includedPlugins(undefined, null), []);
  assert.deepEqual(includedPlugins([], null), []);
});

test("the endpoint menu carries the plan rows, so Currently answering matches when the box is on one", () => {
  const catalog = {
    endpoints: [{ id: "mine", name: "my own provider", model: "glm-4.6", baseUrl: "https://example.test/v1", contextWindow: 128000 }],
    included: INCLUDED,
    live: { baseUrl: "http://titanbot-proxy:4000/v1", model: "plan-zai" },
  };
  const models = endpointModels({ model: "plan-zai" }, catalog);
  // The plan first, and its rows are real menu entries rather than an unknown extra one.
  assert.deepEqual(models.available.map((m) => m.id), ["plan-zai", "plan-minimax", "mine"]);
  assert.equal(models.available[0].provider, "plan");
  assert.equal(models.available[0].context, "200k");
  // The thing this test exists for: without the plan rows in the list, `current` was undefined and
  // the menu grew a row called "plan-zai" with the box's own name on it, beside a picker that
  // disagreed with it.
  assert.equal(models.default, "plan-zai");
  assert.equal(models.available.filter((m) => m.provider === "box").length, 0);

  // A customer on their own key still resolves to their own row, and the plan rows stay available.
  const own = endpointModels({ model: "glm-4.6" }, { ...catalog, live: { baseUrl: "https://example.test/v1", model: "glm-4.6" } });
  assert.equal(own.default, "mine");
});

test("a console with no plan builds the same menu it always did", () => {
  const catalog = {
    endpoints: [{ id: "mine", name: "my own provider", model: "glm-4.6", baseUrl: "https://example.test/v1" }],
    live: { baseUrl: "https://example.test/v1", model: "glm-4.6" },
  };
  const models = endpointModels({ model: "glm-4.6" }, catalog);
  assert.deepEqual(models.available.map((m) => m.id), ["mine"]);
  assert.equal(models.default, "mine");
});
