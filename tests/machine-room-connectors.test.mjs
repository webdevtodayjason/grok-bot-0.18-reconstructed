// Wave D1 (docs/GAP-ANALYSIS.md CP-03, CP-04, CP-09, CP-10, CP-11, CP-12, GW-11): the connector
// plane behind the Machine Room's Plugins page, against a stub gateway that records every command.
// What is pinned here is the half a browser gate cannot show while the host side is still landing:
// which command each control sends, with which argument names, and what the page does on a host
// that does not have the command yet.
//
// Argument names come from source/host/host-gateway-api.ts where the command already exists
// (connectChannel(args.id, args.platform, args.token) at :553, disconnectChannel(args.id,
// args.platform) at :557, submitSecret(args.entryId, args.value, args.agentId) at :260), and for
// the Wave D1 commands landing beside this, from the host half in the same tree
// (gateway-protocol.ts, host-gateway-api.ts, extensions/mcp/mcp-service.ts):
//   listInstalledMcpServers {}    -> [{ id, name, serverIdentifier, status, statusDetail?, transport, toolCount, ... }]
//                                    (`id` is the minted numeric-string local id, CP-07)
//   listMcpServerTools {serverId} -> [{ name, description, isDisabled, enabled }]
//   toggleMcpToolDisabled {serverId, toolName, disabled} -> the same tool list, after
//   listConnectorSecretFields {server} -> { server, serverId, fields, stored } -- `fields` are the
//                                    credential fields (CONNECT-4: stored names plus the entry's
//                                    empty-valued env keys), `stored` the names it HOLDS a value for
//   setConnectorSecret {server, field, value} -> { server, serverId, field, stored, restarted, fields }
// A host without them answers {"error":"unknown gateway method: <name>"}, which is the one string
// that separates "not here yet" from "the host refused".
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONNECTORS = { mcpServers: { localfiles: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"], env: {} } } };
const UNKNOWN = (method) => new Error(`unknown gateway method: ${method}`);

async function loadAdapter(answers = {}, options = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { createGatewayAdapter, connectorPlugins, cardOf };\n  global.__bootMachineRoom =",
  );
  const calls = [];
  const posts = [];
  let connectors = options.connectors ?? CONNECTORS;
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
  const defaults = { listAgents: [], getTrays: [], getAgentAutomations: [], getAgentWorkflows: [], getConversationOutline: [], getAgentTranscriptTail: { entries: [] } };
  const fetchStub = async (url, init) => {
    const target = String(url);
    if (target === "/connectors") {
      if (init?.method === "POST") {
        const parsed = JSON.parse(init.body);
        posts.push(parsed);
        connectors = { mcpServers: parsed.mcpServers };
        return { ok: true, json: async () => ({ saved: Object.keys(parsed.mcpServers), restartRequired: true }), text: async () => "{}" };
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

const seed = (over = {}) => ({
  activeContext: { kind: "worker", id: "w1" },
  openContexts: [{ kind: "worker", id: "w1" }],
  workers: [{ id: "w1", name: "Probe", role: "", description: "", status: "ready", statusText: "Ready", messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, hasOlder: false, composer: null }],
  rooms: [], routines: [], plugins: [], models: { default: "d", available: [] },
  settings: { autoReview: { enabled: false, allow: [], block: [] }, localToolPermission: null, reachable: true },
  desktop: { paused: false, timeline: [] }, teaching: { active: false, workerId: null, startedAt: null },
  agentCount: 1, search: { enabled: false },
  ...over,
});

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const INSTALLED = [{ id: 1, name: "localfiles", status: "connected", transport: "stdio", toolCount: 3 }];
const SERVER_TOOLS = [
  { name: "read_file", description: "Read a file", enabled: true },
  { name: "write_file", description: "Write a file", enabled: true },
  { name: "list_directory", description: "List a directory", enabled: false },
];
const installedAnswers = (over = {}) => ({
  listInstalledMcpServers: INSTALLED,
  listMcpServerTools: SERVER_TOOLS,
  // The live host answers { server, serverId, fields, stored }: `fields` are the credential
  // fields, `stored` the ones it already holds a value for -- both empty on a fresh connector.
  listConnectorSecretFields: { server: "localfiles", serverId: 1, fields: ["API_TOKEN"], stored: ["API_TOKEN"] },
  ...over,
});

// -- CP-03: the card the host installs, with its numeric id and a real switch per tool.
test("a connector card is built from listInstalledMcpServers and its tools carry switches", async () => {
  const { connectorPlugins, calls } = await loadAdapter(installedAnswers());
  const [card] = await connectorPlugins();
  assert.equal(card.id, "mcp:localfiles");
  assert.equal(card.serverId, 1);
  assert.equal(card.group, "Connectors");
  assert.equal(card.status, "connected");
  assert.match(card.category, /stdio · connected/);
  // The numeric id is what mcpDisabledToolsByServerId is keyed by, so the card says which one.
  assert.match(card.description, /host id 1, stdio/);
  assert.match(card.description, /3 tool\(s\) discovered/);
  // The executable, never its argv: connectors.json is the 0600 file that carries connector
  // tokens, and a stdio server is routinely launched with --api-key= in argv.
  assert.match(card.description, /Runs in the box as npx \(3 argument\(s\), configured in connectors\.json\)/);
  for (const arg of CONNECTORS.mcpServers.localfiles.args) assert.equal(card.description.includes(arg), false, `argv leaked: ${arg}`);
  assert.deepEqual(card.tools.map((t) => t.name), ["read_file", "write_file", "list_directory"]);
  assert.deepEqual(card.tools.map((t) => t.enabled), [true, true, false]);
  assert.equal(card.tools.every((t) => t.togglable === true), true);
  assert.equal(card.toolsReadOnlyNote, null);
  // The form is the union of the env names connectors.json declares and the names the host
  // already holds, or a connector whose secret has never been set would have no input at all.
  assert.deepEqual(card.secretFields, ["API_TOKEN"]);
  assert.deepEqual(card.storedFields, ["API_TOKEN"]);
  assert.equal(card.removable, true);
  assert.deepEqual(calls.find((c) => c.method === "listMcpServerTools").args, { serverId: 1 });
  assert.deepEqual(calls.find((c) => c.method === "listConnectorSecretFields").args, { server: "localfiles" });
});

// -- The degrade: this page ships before the host half, and on that host it must show Wave B's
// read-only card rather than an empty Connectors group or a switch that silently does nothing.
test("a host without the new commands keeps the read-only Wave B connector card", async () => {
  const { connectorPlugins, calls } = await loadAdapter({
    listInstalledMcpServers: UNKNOWN("listInstalledMcpServers"),
    listConnectorSecretFields: UNKNOWN("listConnectorSecretFields"),
    listRoutedMcpTools: [{ name: "localfiles-read_file", providerIdentifier: "localfiles", toolName: "read_file", description: "Read a file" }],
    listBoxMcpServers: { servers: [{ serverIdentifier: "localfiles", status: "connected", toolCount: 14 }] },
  });
  const [card] = await connectorPlugins();
  assert.equal(card.id, "mcp:localfiles");
  assert.equal(card.serverId, undefined);
  assert.equal(card.tools.every((t) => t.togglable === false), true);
  assert.match(card.toolsReadOnlyNote, /numeric server id/);
  assert.deepEqual(card.secretFields, []);
  assert.match(card.description, /14 tool\(s\) discovered/);
  // Asked once, then remembered: a card must not re-ask a missing command on every tick.
  await connectorPlugins();
  assert.equal(calls.filter((c) => c.method === "listInstalledMcpServers").length, 1);
});

// -- "not here yet" and "the host refused" are different answers and must not render the same.
// tryCall answers null only for the gateway's "unknown gateway method" string; anything else it
// throws, and swallowing that showed a 500 as a host that had never heard of the command.
test("a host that refuses listInstalledMcpServers says so instead of looking like an older host", async () => {
  const said = [];
  const { connectorPlugins, calls } = await loadAdapter({
    listInstalledMcpServers: new Error("mcp extension is not running"),
    listRoutedMcpTools: [{ name: "localfiles-read_file", providerIdentifier: "localfiles", toolName: "read_file", description: "Read a file" }],
    listBoxMcpServers: { servers: [{ serverIdentifier: "localfiles", status: "connected", toolCount: 14 }] },
  });
  const cards = await connectorPlugins((message) => said.push(message));
  assert.equal(said.length, 1);
  assert.match(said[0], /could not list its connectors: mcp extension is not running/);
  // The read-only card is still drawn -- there is nothing else to draw -- but the reason is said.
  assert.equal(cards[0].id, "mcp:localfiles");
  assert.equal(cards[0].serverId, undefined);
  // A refusal is not a missing command, so it is asked again on the next tick.
  await connectorPlugins(() => {});
  assert.equal(calls.filter((c) => c.method === "listInstalledMcpServers").length, 2);
});

// -- CP-03: the switch is the host's state, not the click's.
test("a tool switch writes toggleMcpToolDisabled and re-reads the host's list", async () => {
  let disabled = new Set();
  const { createGatewayAdapter, calls } = await loadAdapter(installedAnswers({
    toggleMcpToolDisabled: (args) => { if (args.disabled) disabled.add(args.toolName); else disabled.delete(args.toolName); return { ok: true }; },
    listMcpServerTools: () => SERVER_TOOLS.map((t) => ({ ...t, enabled: t.name === "list_directory" ? false : !disabled.has(t.name) })),
  }));
  const state = seed();
  const adapter = createGatewayAdapter(state);
  // The card the panel is holding when the switch is clicked.
  state.plugins = [{
    id: "mcp:localfiles", name: "localfiles", group: "Connectors", serverId: 1,
    tools: SERVER_TOOLS.map((t) => ({ id: `localfiles::${t.name}`, name: t.name, description: t.description, enabled: t.enabled, togglable: true })),
  }];
  const result = await adapter.togglePluginTool("mcp:localfiles", "localfiles::read_file");
  const write = calls.find((c) => c.method === "toggleMcpToolDisabled");
  assert.deepEqual(write.args, { serverId: 1, toolName: "read_file", disabled: true });
  // Read back, not assumed: the row on the card is whatever listMcpServerTools now says.
  assert.equal(calls.filter((c) => c.method === "listMcpServerTools").length, 1);
  assert.equal(state.plugins[0].tools.find((t) => t.name === "read_file").enabled, false);
  assert.equal(result.accepted, true);
  assert.match(result.message, /read_file is now disabled on the host/);
});

test("a host that cannot store a per-tool disable reports that instead of moving the switch", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({ toggleMcpToolDisabled: UNKNOWN("toggleMcpToolDisabled") });
  const state = seed({ plugins: [{ id: "mcp:localfiles", name: "localfiles", group: "Connectors", serverId: 1, tools: [{ id: "localfiles::read_file", name: "read_file", description: "", enabled: true, togglable: true }] }] });
  const adapter = createGatewayAdapter(state);
  const result = await adapter.togglePluginTool("mcp:localfiles", "localfiles::read_file");
  assert.equal(result.accepted, false);
  assert.match(result.message, /no toggleMcpToolDisabled command yet/);
  assert.equal(state.plugins[0].tools[0].enabled, true);
  assert.equal(calls.filter((c) => c.method === "listMcpServerTools").length, 0);
});

// -- CP-10 item 1: the key form on a connector card.
test("the connector key form posts setConnectorSecret and reports the host's answer", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({ setConnectorSecret: { stored: true } });
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.setConnectorSecret("localfiles", "API_TOKEN", "PROBE-SECRET-0001");
  const write = calls.find((c) => c.method === "setConnectorSecret");
  assert.deepEqual(Object.keys(write.args).sort(), ["field", "server", "value"]);
  assert.equal(write.args.server, "localfiles");
  assert.equal(write.args.field, "API_TOKEN");
  assert.equal(result.accepted, true);
  assert.match(result.message, /never entered chat or model context/);
});

test("a host with no setConnectorSecret says nothing was stored rather than reporting success", async () => {
  const { createGatewayAdapter } = await loadAdapter({ setConnectorSecret: UNKNOWN("setConnectorSecret") });
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.setConnectorSecret("localfiles", "API_TOKEN", "PROBE-SECRET-0002");
  assert.equal(result.accepted, false);
  assert.match(result.message, /no setConnectorSecret command yet/);
});

// -- CP-11: the connectors editor writes the relay's file and asks the host to re-read it.
test("adding a connector writes connectors.json with env NAMES only and calls refreshMcp", async () => {
  const { createGatewayAdapter, calls, posts, config } = await loadAdapter(installedAnswers());
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.addConnector({ name: "probe", command: "node", args: ["/workspace/probe-mcp.mjs"], envNames: ["PROBE_TOKEN"] });
  assert.equal(result.accepted, true);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].mcpServers.probe, { command: "node", args: ["/workspace/probe-mcp.mjs"], env: { PROBE_TOKEN: "" } });
  // The existing connector survives the write; this is a merge, not a replacement.
  assert.equal(Object.keys(config().mcpServers).sort().join(","), "localfiles,probe");
  assert.equal(calls.filter((c) => c.method === "refreshMcp").length, 1);
  assert.match(result.message, /re-read connectors\.json/);
});

test("a connector with no command is refused here rather than by the relay", async () => {
  const { createGatewayAdapter, posts } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.addConnector({ name: "probe", command: "" });
  assert.equal(result.accepted, false);
  assert.match(result.message, /needs a command/);
  assert.equal(posts.length, 0);
});

test("removing a connector drops it from the file and refreshes the host", async () => {
  const { createGatewayAdapter, calls, posts, config } = await loadAdapter(installedAnswers());
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.removeConnector("localfiles");
  assert.equal(result.accepted, true);
  assert.deepEqual(posts[0].mcpServers, {});
  assert.deepEqual(config().mcpServers, {});
  assert.equal(calls.filter((c) => c.method === "refreshMcp").length, 1);
});

// -- CP-04: the listener token goes to the host for the agent on screen.
test("connecting a listener posts connectChannel with the active agent's id and reads the state back", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    connectChannel: { manifests: [{ platform: "slack" }], connections: [{ platform: "slack", name: "Titanium" }] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const result = await adapter.connectListener("slack", "PROBE-SECRET-0003");
  const write = calls.find((c) => c.method === "connectChannel");
  assert.deepEqual(Object.keys(write.args).sort(), ["id", "platform", "token"]);
  assert.equal(write.args.id, "w1");
  assert.equal(write.args.platform, "slack");
  assert.equal(result.accepted, true);
  // connectChannel answers with getAgentChannels, so the row under the form is the host's.
  assert.deepEqual(state.workers[0].channels, [{ platform: "slack", connected: true, detail: "Titanium" }]);
});

// -- The group case. app.js draws the form for contextLead(), which on a ROOM is the chief or
// first member worker, not the room -- so the id has to come from the caller. Taking
// state.activeContext here stored the token against the room the form never named.
test("a listener token binds to the agent the card names, not the conversation on screen", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    connectChannel: { manifests: [{ platform: "slack" }], connections: [{ platform: "slack", name: "Titanium" }] },
  });
  const state = seed({
    activeContext: { kind: "room", id: "r1" },
    openContexts: [{ kind: "room", id: "r1" }],
    rooms: [{ id: "r1", name: "Diag Room", memberIds: ["w1"], messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, hasOlder: false, composer: null, status: "ready", statusText: "Ready" }],
  });
  const adapter = createGatewayAdapter(state);
  const result = await adapter.connectListener("slack", "PROBE-SECRET-0007", "w1");
  const write = calls.find((c) => c.method === "connectChannel");
  assert.equal(write.args.id, "w1");
  assert.equal(result.accepted, true);
  // Read back onto the worker the form named, so the card can flip to connected.
  assert.deepEqual(state.workers[0].channels, [{ platform: "slack", connected: true, detail: "Titanium" }]);
  assert.equal(state.rooms[0].channels, null);
});

test("a host that takes the token but lists no channel is not reported as connected", async () => {
  const { createGatewayAdapter } = await loadAdapter({ connectChannel: { manifests: [{ platform: "slack" }], connections: [] } });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const result = await adapter.connectListener("slack", "PROBE-SECRET-0004");
  assert.equal(result.accepted, false);
  assert.match(result.message, /still lists no slack channel/);
});

// -- CP-12: unbinding is per agent too. Sent without an id it unbound nothing.
test("disconnecting a listener passes the active agent's id", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    disconnectChannel: { manifests: [{ platform: "slack" }], connections: [] },
    getListenerIntegrations: [],
    listRoutedMcpTools: [],
  });
  const state = seed({ plugins: [{ id: "slack", name: "Slack", group: "Listeners", status: "connected", connectable: true, tools: [] }] });
  const adapter = createGatewayAdapter(state);
  await adapter.setPluginState("slack", "disconnect");
  const write = calls.find((c) => c.method === "disconnectChannel");
  assert.deepEqual(write.args, { id: "w1", platform: "slack" });
});

test("disconnecting uses the agent the button names, not the room on screen", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    disconnectChannel: { manifests: [{ platform: "slack" }], connections: [] },
    getListenerIntegrations: [], listRoutedMcpTools: [],
    listAgents: [{ id: "w1", name: "Probe", isGroup: false, unreadCount: 0 }],
  });
  const state = seed({
    activeContext: { kind: "room", id: "r1" },
    openContexts: [{ kind: "room", id: "r1" }],
    rooms: [{ id: "r1", name: "Diag Room", memberIds: ["w1"], messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, hasOlder: false, composer: null, status: "ready", statusText: "Ready" }],
    plugins: [{ id: "slack", name: "Slack", group: "Listeners", status: "connected", connectable: true, tools: [] }],
  });
  const adapter = createGatewayAdapter(state);
  await adapter.setPluginState("slack", "disconnect", "w1");
  assert.deepEqual(calls.find((c) => c.method === "disconnectChannel").args, { id: "w1", platform: "slack" });
});

// -- ui/server.mjs readConnectors answers { mcpServers: {} } for a box it could not exec into as
// well as for an empty file, and this POST REPLACES the file. A write derived from a failed read
// during a box restart would drop every connector the operator has.
test("a connector is not added on a read that came back empty from a box that is not answering", async () => {
  const { createGatewayAdapter, posts } = await loadAdapter(
    { getHostStatus: new Error("box is restarting") },
    { connectors: { mcpServers: {} } },
  );
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.addConnector({ name: "probe", command: "node", args: [], envNames: [] });
  assert.equal(result.accepted, false);
  assert.match(result.message, /could not be read from the box/);
  assert.equal(posts.length, 0);
  const removal = await adapter.removeConnector("localfiles");
  assert.equal(removal.accepted, false);
  assert.equal(posts.length, 0);
});

test("a genuinely empty connectors.json on a live box still takes the first connector", async () => {
  const { createGatewayAdapter, posts, config } = await loadAdapter(
    { getHostStatus: { ok: true } },
    { connectors: { mcpServers: {} } },
  );
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.addConnector({ name: "probe", command: "node", args: [], envNames: [] });
  assert.equal(result.accepted, true);
  assert.deepEqual(Object.keys(config().mcpServers), ["probe"]);
  assert.equal(posts.length, 1);
});

// -- CP-10 item 2 / GW-11: the masked secret request in the conversation.
test("a secret request card posts submitSecret with the entry id the host asked by", async () => {
  const entry = {
    kind: "send-message", id: "entry-9", timestampMs: 1,
    message: { type: "secret-request", secretRequest: { label: "the Linear API key", target: { kind: "channel-credential", platform: "linear", field: "apiKey" } } },
  };
  const { createGatewayAdapter, calls } = await loadAdapter({
    // The host stamps secretProvided on the entry once it has really stored the value
    // (widget-responses.ts), so the tail answers with the stamp only after submitSecret was sent.
    getAgentTranscriptTail: (_args, all) => ({ entries: [{ ...entry, secretProvided: all.some((c) => c.method === "submitSecret") }] }),
    submitSecret: {},
    listAgents: [{ id: "w1", name: "Probe", isGroup: false, unreadCount: 0 }],
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  adapter.selectContext({ kind: "worker", id: "w1" });
  await settle();
  const message = state.workers[0].messages.find((m) => m.card?.kind === "secret");
  assert.equal(message.card.entryId, "entry-9");
  assert.equal(message.card.field, "apiKey");
  const result = await adapter.submitSecretRequest({ kind: "worker", id: "w1" }, message.id, "PROBE-SECRET-0005");
  const write = calls.find((c) => c.method === "submitSecret");
  assert.deepEqual(Object.keys(write.args).sort(), ["agentId", "entryId", "value"]);
  assert.equal(write.args.entryId, "entry-9");
  assert.equal(write.args.agentId, "w1");
  assert.equal(result.accepted, true);
  // The claim is the host's stamp read back, not the 200: the entry now says provided.
  assert.equal(state.workers[0].messages.find((m) => m.card?.kind === "secret").card.status, "provided");
});

// -- The failure this page must not paper over: submitSecret returns VOID on every failure path
// (no such entry, not a secret request, already answered, routeSecret returned null), so the
// relay answers 200 with an empty body and nothing was stored. A 200 is not an answer.
test("a host that takes submitSecret but never stamps the entry is not reported as stored", async () => {
  const entry = {
    kind: "send-message", id: "entry-11", timestampMs: 1,
    message: { type: "secret-request", secretRequest: { label: "the Linear API key", target: { kind: "channel-credential", platform: "linear", field: "apiKey" } } },
  };
  const { createGatewayAdapter, calls } = await loadAdapter({
    getAgentTranscriptTail: { entries: [entry] },   // never stamped: the host dropped it silently
    submitSecret: {},
    listAgents: [{ id: "w1", name: "Probe", isGroup: false, unreadCount: 0 }],
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  adapter.selectContext({ kind: "worker", id: "w1" });
  await settle();
  const message = state.workers[0].messages.find((m) => m.card?.kind === "secret");
  const result = await adapter.submitSecretRequest({ kind: "worker", id: "w1" }, message.id, "PROBE-SECRET-0006");
  assert.equal(calls.filter((c) => c.method === "submitSecret").length, 1);
  assert.equal(result.accepted, false);
  assert.match(result.message, /nothing was stored/);
  // And the card goes back to pending rather than sitting on "sending" forever.
  assert.equal(state.workers[0].messages.find((m) => m.card?.kind === "secret").card.status, "pending");
});

test("an empty credential is not sent to the host at all", async () => {
  const entry = {
    kind: "send-message", id: "entry-10", timestampMs: 1,
    message: { type: "secret-request", secretRequest: { label: "a token", target: { kind: "channel-credential", platform: "slack", field: "token" } } },
  };
  const { createGatewayAdapter, calls } = await loadAdapter({ getAgentTranscriptTail: { entries: [entry] }, listAgents: [{ id: "w1", name: "Probe", isGroup: false, unreadCount: 0 }] });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  adapter.selectContext({ kind: "worker", id: "w1" });
  await settle();
  const message = state.workers[0].messages.find((m) => m.card?.kind === "secret");
  const result = await adapter.submitSecretRequest({ kind: "worker", id: "w1" }, message.id, "   ");
  assert.equal(result.accepted, false);
  assert.equal(calls.filter((c) => c.method === "submitSecret").length, 0);
});

// -- The DOM half of CP-04 and CP-10 item 1, read out of app.js itself: a masked input, and no
// `value=` attribute anywhere in the markup that carries a credential. A password input whose
// value is painted into the markup is readable in the page source and survives a screenshot.
async function markupHelpers() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const grab = (name) => {
    const start = source.indexOf(`  function ${name}(`);
    assert.notEqual(start, -1, `app.js no longer defines ${name}`);
    const end = source.indexOf("\n  }\n", start);
    return source.slice(start, end + 4);
  };
  const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const decisions = source.slice(source.indexOf("  const DECISION_ACTIONS = {"), source.indexOf("  function decisionMarkup("));
  const fn = new Function("escapeHtml", "adapter", `${grab("connectorSecretMarkup")}\n${grab("listenerConnectMarkup")}\n${decisions}${grab("decisionMarkup")}\nreturn { connectorSecretMarkup, listenerConnectMarkup, decisionMarkup };`);
  return fn(escapeHtml, { connectListener: () => {}, submitSecretRequest: () => {} });
}

test("the connector key form is masked and carries no value in the markup", async () => {
  const { connectorSecretMarkup } = await markupHelpers();
  const html = connectorSecretMarkup({ id: "mcp:localfiles", name: "localfiles", secretFields: ["API_TOKEN", "API_BASE"], secretHint: "Stored by the host." });
  assert.equal((html.match(/type="password"/g) ?? []).length, 2);
  assert.equal(/\bvalue=/.test(html), false, "a credential input must never be rendered with a value attribute");
  assert.match(html, /data-connector-secret-form="mcp:localfiles"/);
  assert.match(html, /name="API_TOKEN"/);
});

test("the listener card offers the local token form and nothing else", async () => {
  const { listenerConnectMarkup } = await markupHelpers();
  const html = listenerConnectMarkup({ id: "slack", name: "Slack" }, { name: "Atera Triage" });
  assert.match(html, /data-connect-channel="slack"/);
  assert.match(html, /type="password"/);
  assert.equal(/\bvalue=/.test(html), false);
  assert.match(html, /Atera Triage/);
  // There is no second route any more: no install button, and no mention of the old vendor.
  assert.equal(/data-install-plugin=/.test(html), false);
  assert.equal(/cursor/i.test(html), false);
});

test("the secret request card renders a masked input instead of sending the operator elsewhere", async () => {
  const { decisionMarkup } = await markupHelpers();
  const html = decisionMarkup({
    id: "entry-9", type: "decision",
    card: { kind: "secret", entryId: "entry-9", status: "pending", field: "apiKey", platform: "linear", title: "The agent asked for the Linear API key", detail: "It never reaches the model.", options: [] },
  });
  assert.match(html, /type="password"/);
  assert.match(html, /data-secret-input="entry-9"/);
  assert.match(html, /data-submit-secret="entry-9"/);
  assert.equal(/\bvalue=/.test(html), false);
  // The copy this wave removes: submitSecret is a real host command, so "answer it elsewhere" was
  // sending the operator away from the only page that can answer it.
  assert.equal(/Answer this in the host app/.test(html), false);
});

// SECRET-1: the hint under the masked field is the custody promise the operator reads before
// typing, so it has to be true for the destination this card names. It is for a connector or chat
// credential. It is not for the reserved "shell" connector, whose whole purpose is to hand the
// value to the shell the agent runs commands in.
test("the custody hint under the masked field splits on the shell destination", async () => {
  const { decisionMarkup } = await markupHelpers();
  const card = (over) => decisionMarkup({
    id: "entry-9", type: "decision",
    card: { kind: "secret", entryId: "entry-9", status: "pending", title: "The agent asked for a credential", detail: "d", options: [], ...over },
  });
  const connector = card({ field: "apiKey", platform: "linear" });
  assert.match(connector, /Stored securely, never shown to your agent\./);
  const shell = card({ field: "TITAN_JOB_TOKEN", platform: "shell" });
  assert.match(shell, /Stored securely and never shown in this chat\./);
  assert.match(shell, /It becomes \$TITAN_JOB_TOKEN in this agent&#39;s shell, so commands it runs can read it\./);
  assert.equal(/never shown to your agent/.test(shell), false, "the shell card must not promise a custody the shell route does not keep");
  // The rule is the host's own (shell-secret-field.ts trims and lowercases before matching), so a
  // card that arrives with the name cased differently gets the same honest line.
  assert.match(card({ field: "TITAN_JOB_TOKEN", platform: " Shell " }), /in this agent&#39;s shell/);
});

test("a credential request the host already took shows what happened, not another input", async () => {
  const { decisionMarkup } = await markupHelpers();
  const html = decisionMarkup({ id: "entry-9", type: "decision", card: { kind: "secret", entryId: "entry-9", status: "provided", field: "apiKey", title: "The agent asked for a credential", options: [] } });
  assert.equal(/type="password"/.test(html), false);
  // SECRET-1: the answered card is the original product's -- one line and a green pill. It says
  // the value was kept private, and says nothing about the value.
  assert.match(html, /Saved securely and kept private\./);
  assert.match(html, /class="status-pill success[^"]*"[^>]*>\u2713 Saved</);
  assert.equal(/apiKey/.test(html), false);
});

test("a connector whose secret was never set still gets a field for every env name it declares", async () => {
  const { connectorPlugins } = await loadAdapter(
    installedAnswers({ listConnectorSecretFields: { server: "localfiles", serverId: 1, fields: [] } }),
    { connectors: { mcpServers: { localfiles: { command: "node", args: ["/workspace/x.mjs"], env: { PROBE_TOKEN: "", API_BASE: "" } } } } },
  );
  const [card] = await connectorPlugins();
  assert.deepEqual(card.secretFields.sort(), ["API_BASE", "PROBE_TOKEN"]);
  assert.deepEqual(card.storedFields, []);
  // Names only: connectors.json is the 0600 plaintext file, so nothing of its env VALUES may be
  // read onto the card even when the operator has written one there by hand.
  assert.equal(card.description.includes("PROBE_TOKEN"), false);
});

// -- MR-11: the "Current run" rail. It used to be one hardcoded line whatever the agent was doing
// ("Started — no step detail from this host"). It is now the tool rows the adapter wove into the
// transcript from the conversation outline, narrowed to the turn in progress: everything after the
// last thing the operator sent. The rule is lifted out of renderDesktop and run over a synthetic
// conversation, because the live gate can only see whatever the box happens to be doing.
async function currentRunRail() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("    const rows = Array.isArray(record.messages) ? record.messages : [];");
  assert.notEqual(start, -1, "renderDesktop no longer builds the rail from record.messages");
  const end = source.indexOf("elements.desktopTimeline.innerHTML", start);
  const body = source.slice(start, end);
  return new Function("record", `${body}\nreturn steps;`);
}

test("the current-run rail is this turn's tool rows, not every tool row in the window", async () => {
  const rail = await currentRunRail();
  const steps = rail({
    messages: [
      { id: "u1", authorId: "you", type: "text", text: "first ask" },
      { id: "tool-1", type: "system", text: "Shell · ls /workspace → exit 0" },
      { id: "a1", authorId: "agent", type: "text", text: "done" },
      { id: "u2", authorId: "you", type: "text", text: "second ask" },
      { id: "tool-2", type: "system", text: "Read · /workspace/report.md" },
      { id: "e1", type: "system", text: "Evidence: evidenced · 1 receipt behind this reply" },
      { id: "tool-3", type: "system", text: "Shell · npm test · running" },
    ],
  });
  // The first turn's row is history, the evidence pill is not a tool row, the rest is this turn.
  assert.deepEqual(steps.map((s) => s.id), ["tool-2", "tool-3"]);
});

// MR-36 fixer: SHOT-4 turned a summarised tool row into a <details> -- the plain-word headline is
// its <summary>, the verbatim command and output its <pre>. The rail draws the headline, so the
// two only agree while the headline is a row of its OWN in the markup. When it stopped being one,
// reading a row's text as textContent returned the headline with the whole receipt glued onto it,
// and the browser gate's exact rail comparison failed against a rail that was right.
test("a summarised tool row keeps its headline as its own element, with the receipt behind it", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function messageMarkup(");
  assert.notEqual(start, -1, "app.js no longer defines messageMarkup");
  const body = source.slice(start, source.indexOf("\n  }\n", start) + 4);
  const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const markup = new Function("escapeHtml", "message", `${body}\nreturn messageMarkup(message);`);
  const row = markup(escapeHtml, { id: "tool-1", type: "system", text: "Opened example.com", detail: "Shell · box-chrome 'https://example.com'\n\nexit 0" });
  assert.match(row, /<summary>Opened example\.com<\/summary>/, "the headline is the summary, and nothing else is");
  assert.match(row, /<pre>Shell · box-chrome/, "the receipt is the detail behind it, never dropped");
  assert.match(row, /class="message-bubble tool-receipt"/);
  // A row with no detail is the plain bubble it always was.
  const plain = markup(escapeHtml, { id: "tool-2", type: "system", text: "Read · /workspace/report.md" });
  assert.doesNotMatch(plain, /<summary>/);
  assert.match(plain, /class="message-bubble">Read · \/workspace\/report\.md</);
});

test("an agent that has not run a tool this turn gets no invented step", async () => {
  const rail = await currentRunRail();
  assert.deepEqual(rail({ messages: [{ id: "u1", authorId: "you", type: "text", text: "hello" }] }), []);
  assert.deepEqual(rail({ messages: [] }), []);
});

// -- Two app.js call sites this wave's review found, asserted on the source because both are
// inside the delegated submit/click handlers rather than in a function a stub can call.
test("app.js hands the connect and disconnect calls the agent the card was drawn for", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  // listenerConnectMarkup/listenerConnectedMarkup are built from contextLead(), which on a room is
  // a member worker; passing state.activeContext instead bound the token to the room.
  assert.match(source, /adapter\.connectListener\(platform, token, contextLead\(\)\?\.id\)/);
  assert.match(source, /adapter\.setPluginState\(pluginId, "disconnect", contextLead\(\)\?\.id\)/);
  assert.match(source, /adapter\.setPluginState\(target\.dataset\.installPlugin, "connect", contextLead\(\)\?\.id\)/);
});

test("the key form says so when its card is gone, instead of throwing past its own catch", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf('} else if (form.dataset.connectorSecretForm) {');
  assert.notEqual(start, -1, "app.js no longer handles the connector key form");
  const handler = source.slice(start, source.indexOf('} else if (form.hasAttribute("data-add-connector"))', start));
  const guard = handler.indexOf("no longer on this page");
  const clear = handler.indexOf('input.value = ""');
  assert.notEqual(guard, -1, "a missing card must be reported, not dereferenced");
  assert.ok(guard < clear, "the guard has to run before the inputs are cleared, or the typed value is lost");
});

// -- CP-11 in the state where it matters most: a box with nothing configured at all. MARKET-1
// moved the panel this lives in -- the Plugins tab of the Marketplace -- but not the rule: the
// editor is on the list view unconditionally, so the first connector can be added from a box that
// has none, and no branch tells the operator connectors can only be added by hand on the box.
test("the Marketplace's Plugins list carries the connector editor and no longer denies it exists", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function marketplaceListMarkup() {");
  assert.notEqual(start, -1, "app.js no longer draws the Plugins list");
  const body = source.slice(start, source.indexOf("\n  }", start));
  assert.match(body, /\$\{connectorEditorMarkup\(\)\}/);
  assert.equal(/Connectors are added to connectors\.json on the box, not from this page/.test(source), false);
});

// -- CONNECT-5: the shell tools group. A shell tool is a CLI the agent runs itself, with its
// credential in the box shell's environment. CodeRabbit ships no MCP server at all, so it can
// never be a connector card; the card has to exist beside them, in its own group, reusing the
// credential component and nothing else.
const SHELL_CATALOG = [
  { id: "coderabbit", name: "CodeRabbit CLI", field: "CODERABBIT_API_KEY", install: "CI=1 curl -fsSL https://cli.coderabbit.ai/install.sh | sh", usage: 'cr review --agent --api-key "$CODERABBIT_API_KEY"', credentialNote: "An Agentic API key.", stored: false },
  { id: "tinyfish-cli", name: "TinyFish CLI", field: "TINYFISH_API_KEY", install: "pip install cli-anything-tinyfish", usage: "Read from the environment.", credentialNote: "The same TinyFish API key.", skillUrl: "https://raw.githubusercontent.com/webdevtodayjason/cli-anything-tinyfish/main/cli_anything/tinyfish/skills/SKILL.md", stored: true },
];

test("the shell tools come back as their own group beside the connectors", async () => {
  const { connectorPlugins, calls } = await loadAdapter(installedAnswers({
    listShellTools: SHELL_CATALOG,
    listShellSecretFields: { fields: ["CODERABBIT_API_KEY", "TINYFISH_API_KEY"], stored: ["TINYFISH_API_KEY"] },
  }));
  const cards = await connectorPlugins();
  assert.deepEqual(cards.map((card) => card.id), ["mcp:localfiles", "shell:coderabbit", "shell:tinyfish-cli"]);

  const [, coderabbit, tinyfish] = cards;
  assert.equal(coderabbit.group, "Shell tools");
  // Not connected, not installed: a shell tool with no key is a card waiting for one.
  assert.equal(coderabbit.status, "available");
  assert.deepEqual(coderabbit.secretFields, ["CODERABBIT_API_KEY"]);
  assert.deepEqual(coderabbit.storedFields, []);
  assert.equal(coderabbit.shellTool.install, "CI=1 curl -fsSL https://cli.coderabbit.ai/install.sh | sh");
  assert.equal(coderabbit.shellTool.teachable, false);
  // A shell tool has no MCP tools, and the card must say why rather than showing an empty list.
  assert.deepEqual(coderabbit.tools, []);
  assert.match(coderabbit.toolsNote, /runs its command itself/);
  // A connector can be removed from connectors.json; a shell tool was never in it.
  assert.equal(coderabbit.removable, false);

  assert.equal(tinyfish.status, "connected");
  assert.deepEqual(tinyfish.storedFields, ["TINYFISH_API_KEY"]);
  assert.equal(tinyfish.shellTool.teachable, true);

  // No value is ever asked for or echoed: the page reads names and the catalog, nothing else.
  assert.deepEqual(calls.find((c) => c.method === "listShellTools").args, {});
  assert.equal(JSON.stringify(cards).includes("cr-"), false);
});

test("a host without the shell tool commands simply has no shell tools group", async () => {
  const { connectorPlugins } = await loadAdapter(installedAnswers({
    listShellTools: UNKNOWN("listShellTools"),
  }));
  const cards = await connectorPlugins();
  assert.deepEqual(cards.map((card) => card.id), ["mcp:localfiles"]);
});

test("the credential form sends a shell tool's value to setShellSecret, not setConnectorSecret", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf('} else if (form.dataset.connectorSecretForm) {');
  assert.notEqual(start, -1, "app.js no longer handles the connector key form");
  const end = source.indexOf('} else if (form.hasAttribute("data-add-connector"))', start);
  assert.notEqual(end, -1, "the key form handler no longer ends where this test expects");
  const handler = source.slice(start, end);
  // The two stores are not interchangeable: a key in the connector store never reaches the shell.
  assert.match(handler, /adapter\.setShellSecret\(plugin\.shellTool\.id, field, value\)/);
  assert.match(handler, /adapter\.setConnectorSecret\(plugin\.name, field, value\)/);
  assert.match(source, /adapter\.installShellTool\(id, contextLead\(\)\?\.id\)/);
  assert.match(source, /adapter\.teachShellTool\(id, lead\.id\)/);
  // MARKET-1: the one grouped nav became two surfaces. The Marketplace draws connectors and shell
  // tools; providers and chat listeners are sections in Settings, built from the same cards.
  assert.match(source, /group === "Connectors" \|\| group === "Shell tools"/);
  assert.match(source, /pluginGroupSection\("Providers", "Providers"/);
  assert.match(source, /pluginGroupSection\("Listeners", "Chat listeners"/);
});
