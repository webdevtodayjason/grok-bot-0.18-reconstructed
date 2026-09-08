// MARKET-1: the marketplace derivations in ui/machine-room/gateway-adapter.js, against a stub
// gateway that answers listMarketplace and the connector-plane commands the cards are built from.
//
// What is pinned here is the contract's three install states and where each one comes from, so
// none of them can quietly become a guess:
//   INSTALLED  the connector's name is in connectors.json -- and NOT "the host lists a server by
//              that name": an account server the host installs has no stdio entry, so a card can
//              exist for something the operator never added.
//   NEEDS AUTH installed, and a credential field the entry declares has no value in the host's
//              own 0600 store. `fields` and `stored` are two different lists on the host's answer
//              and reading one for the other is what once captioned a fresh, empty connector
//              "The host holds a value".
//   READY      installed, nothing left to authenticate, and the BOX reports it connected. An
//              entry the host is still launching is "Connecting", which is a real state.
// The catalog itself is not restated here: it is read through listMarketplace, because the console
// is contractually forbidden a static copy of it -- the agents' plugin tools and this page have to
// resolve against the same rows.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const UNKNOWN = (method) => new Error(`unknown gateway method: ${method}`);

// MARKET-6: the console now asks the HOST to write a connector (addLocalConnector), and falls back
// to the relay's whole-file POST /connectors on a box whose bundle predates that command. Both
// paths are real and both are pinned here. This is the older box -- the default, because it is
// what every box on today's bundle answers -- so every guard below goes on testing the relay path
// it was written for, and the tests that want the new one say so by answering these.
const HOST_WITHOUT_MARKET6 = {
  addLocalConnector: () => UNKNOWN("addLocalConnector"),
  removeLocalConnector: () => UNKNOWN("removeLocalConnector"),
  previewLocalConnector: () => UNKNOWN("previewLocalConnector"),
  setPluginCredential: () => UNKNOWN("setPluginCredential"),
  listConnectorSecretOrphans: () => UNKNOWN("listConnectorSecretOrphans"),
};

// A connectors.json with two entries: one that wants a key, one that wants nothing.
const CONNECTORS = {
  mcpServers: {
    tinyfish: { command: "npx", args: ["-y", "mcp-remote", "https://agent.tinyfish.ai/mcp"], env: { TINYFISH_API_KEY: "" } },
    localfiles: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"], env: {} },
  },
};

// The shape the two gateway commands answer with. `install` on a connector is the entry itself --
// the same {command,args,env} object the console's presets already carry -- and on a shell tool it
// is the shell-tool id.
const CATALOG = {
  categories: ["Featured", "Web & Search", "Documents & Files", "Development", "Shell tools"],
  plugins: [
    {
      id: "tinyfish", name: "TinyFish", tagline: "Web automation and search.", description: "TinyFish's hosted MCP endpoint.",
      category: "Web & Search", featured: true, kind: "connector",
      icon: { letter: "T", color: "#31b6b8" },
      source: { label: "docs.tinyfish.ai", url: "https://docs.tinyfish.ai" },
      install: CONNECTORS.mcpServers.tinyfish,
      credentialHints: { TINYFISH_API_KEY: "Your TinyFish account's API key." },
    },
    {
      id: "localfiles", name: "Filesystem", tagline: "Read and write files in the box.", description: "The reference filesystem MCP server.",
      category: "Documents & Files", featured: false, kind: "connector",
      icon: { letter: "F", color: "#8b69ea" },
      source: { label: "modelcontextprotocol", url: "https://github.com/modelcontextprotocol/servers" },
      install: CONNECTORS.mcpServers.localfiles,
      credentialHints: {},
    },
    {
      id: "github", name: "GitHub", tagline: "Repository, issue and pull request reads.", description: "GitHub's hosted MCP endpoint.",
      category: "Development", featured: true, kind: "connector",
      icon: { letter: "G", color: "#6ea8fe" },
      source: { label: "github.com", url: "https://github.com/github/github-mcp-server" },
      install: { command: "npx", args: ["-y", "mcp-remote@0.8.3", "https://api.githubcopilot.com/mcp/"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" } },
      credentialHints: { GITHUB_PERSONAL_ACCESS_TOKEN: "A fine-grained personal access token." },
    },
    {
      id: "coderabbit", name: "CodeRabbit CLI", tagline: "Agentic code review from the shell.", description: "CodeRabbit ships a CLI, not an MCP server.",
      category: "Shell tools", featured: false, kind: "shell-tool",
      icon: { letter: "C", color: "#e7a23c" },
      source: { label: "cli.coderabbit.ai", url: "https://docs.coderabbit.ai/cli" },
      install: "coderabbit",
      credentialHints: { CODERABBIT_API_KEY: "An Agentic API key." },
    },
  ],
  bots: [],
};

const INSTALLED_SERVERS = [
  { id: 1, name: "tinyfish", status: "initializing", transport: "stdio", toolCount: 0 },
  { id: 2, name: "localfiles", status: "connected", transport: "stdio", toolCount: 3 },
  // A server the HOST installs that connectors.json knows nothing about. The catalog does not
  // claim it either; what matters is that its presence cannot make a catalog row read "Added".
  { id: 3, name: "github", status: "connected", transport: "mcp", toolCount: 40 },
];

const SHELL_CATALOG = [
  { id: "coderabbit", name: "CodeRabbit CLI", field: "CODERABBIT_API_KEY", install: "CI=1 curl -fsSL https://cli.coderabbit.ai/install.sh | sh", usage: "cr review", credentialNote: "An Agentic API key.", stored: false },
];

// The same loader the rest of the machine-room tests use: the adapter is an IIFE that attaches to
// window, so give it just enough page to evaluate and reach in for what is worth pinning.
async function loadAdapter(answers = {}, options = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { createGatewayAdapter, connectorPlugins, marketplaceInstallState };\n  global.__bootMachineRoom =",
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
    const answer = answers[method] ?? HOST_WITHOUT_MARKET6[method] ?? {};
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
  workers: [], rooms: [], routines: [], plugins: [],
  models: { default: "d", available: [] },
  settings: { autoReview: { enabled: false, allow: [], block: [] }, localToolPermission: null, reachable: true },
  desktop: { paused: false, timeline: [] }, teaching: { active: false, workerId: null, startedAt: null },
  agentCount: 0, search: { enabled: false },
  ...over,
});

// tinyfish: in connectors.json, no key in the store -> Needs auth.
// localfiles: in connectors.json, no credential fields at all, box says connected -> Ready.
// github: the host runs a server by that name but connectors.json has no entry -> Not installed.
// coderabbit: a shell tool the box has neither installed nor keyed -> Not installed.
const answers = (over = {}) => ({
  listMarketplace: CATALOG,
  listInstalledMcpServers: INSTALLED_SERVERS,
  listMcpServerTools: [],
  listConnectorSecretFields: (args) => (args.server === "tinyfish"
    ? { server: "tinyfish", serverId: 1, fields: ["TINYFISH_API_KEY"], stored: [] }
    : { server: args.server, fields: [], stored: [] }),
  listShellTools: SHELL_CATALOG,
  listShellSecretFields: { fields: [], stored: [] },
  ...over,
});

async function statesFor(over = {}, options = {}) {
  const { createGatewayAdapter, connectorPlugins, calls } = await loadAdapter(answers(over), options);
  const adapter = createGatewayAdapter(seed());
  const cards = await connectorPlugins();
  const rows = await adapter.installedPlugins(cards);
  return { rows, byId: Object.fromEntries(rows.map((row) => [row.id, row])), cards, calls, adapter };
}

test("the catalog is read through the gateway, never from a file beside the page", async () => {
  const { calls, rows } = await statesFor();
  assert.equal(calls.filter((c) => c.method === "listMarketplace").length, 1);
  assert.deepEqual(rows.map((row) => row.id), ["tinyfish", "localfiles", "github", "coderabbit"]);
  // Cached: a second read of the same catalog must not go back to the box on every repaint.
  const { createGatewayAdapter, calls: calls2 } = await loadAdapter(answers());
  const adapter = createGatewayAdapter(seed());
  await adapter.listMarketplace();
  await adapter.listMarketplace();
  assert.equal(calls2.filter((c) => c.method === "listMarketplace").length, 1);
});

test("installed is the name being in connectors.json, not the host running a server by that name", async () => {
  const { byId } = await statesFor();
  assert.equal(byId.tinyfish.installed, true);
  assert.equal(byId.localfiles.installed, true);
  // The host reports a connected `github` server with 40 tools and connectors.json has no entry
  // for it. An "Added" pill here would offer an Uninstall that removes nothing.
  assert.equal(byId.github.installed, false);
  assert.equal(byId.github.label, "Not installed");
  assert.equal(byId.github.cardId, "mcp:github");
});

test("needs auth is a declared credential field the host holds no value for", async () => {
  const { byId } = await statesFor();
  assert.equal(byId.tinyfish.needsAuth, true);
  assert.equal(byId.tinyfish.ready, false);
  assert.deepEqual(byId.tinyfish.missingCredentials, ["TINYFISH_API_KEY"]);
  assert.equal(byId.tinyfish.label, "Needs auth");
  // A connector that wants nothing is never "Needs auth" for want of a field it never declared.
  assert.equal(byId.localfiles.needsAuth, false);
  assert.deepEqual(byId.localfiles.missingCredentials, []);
});

test("a stored value moves the same entry from needs auth to ready, once the box connects it", async () => {
  const stored = { listConnectorSecretFields: (args) => (args.server === "tinyfish"
    ? { server: "tinyfish", serverId: 1, fields: ["TINYFISH_API_KEY"], stored: ["TINYFISH_API_KEY"] }
    : { server: args.server, fields: [], stored: [] }) };
  // Still launching: authenticated is not the same as answering, and the panel must not say ready.
  const connecting = await statesFor(stored);
  assert.equal(connecting.byId.tinyfish.needsAuth, false);
  assert.equal(connecting.byId.tinyfish.ready, false);
  assert.equal(connecting.byId.tinyfish.label, "Connecting");
  const up = await statesFor({
    ...stored,
    listInstalledMcpServers: INSTALLED_SERVERS.map((row) => (row.name === "tinyfish" ? { ...row, status: "connected", toolCount: 9 } : row)),
  });
  assert.equal(up.byId.tinyfish.ready, true);
  assert.equal(up.byId.tinyfish.label, "Ready");
  assert.deepEqual(up.byId.tinyfish.storedCredentials, ["TINYFISH_API_KEY"]);
});

test("ready is the box's own word: a connector in the file the box has not connected is not ready", async () => {
  const { byId } = await statesFor();
  assert.equal(byId.localfiles.ready, true);
  const down = await statesFor({
    listInstalledMcpServers: INSTALLED_SERVERS.map((row) => (row.name === "localfiles" ? { ...row, status: "error" } : row)),
  });
  assert.equal(down.byId.localfiles.installed, true);
  assert.equal(down.byId.localfiles.ready, false);
  assert.equal(down.byId.localfiles.label, "Connecting");
});

test("a shell tool resolves against the shell-tool catalog, not against connectors.json", async () => {
  const { byId } = await statesFor();
  assert.equal(byId.coderabbit.kind, "shell-tool");
  assert.equal(byId.coderabbit.cardId, "shell:coderabbit");
  assert.equal(byId.coderabbit.installed, false);
  // MARKET-1: the host answers `installed` from `command -v <binary>` in the box's own shell, and
  // `stored` from its 0600 key store. They are two facts. A key with no program is not an install
  // -- saying it was is how the model came to report a CLI it would then fail to run.
  const keyed = await statesFor({ listShellTools: [{ ...SHELL_CATALOG[0], installed: false, stored: true }] });
  assert.equal(keyed.byId.coderabbit.installed, false);
  assert.equal(keyed.byId.coderabbit.label, "Not installed");
  // A program with no key IS installed, and what it is missing is the key.
  const bare = await statesFor({ listShellTools: [{ ...SHELL_CATALOG[0], installed: true, stored: false }] });
  assert.equal(bare.byId.coderabbit.installed, true);
  assert.equal(bare.byId.coderabbit.label, "Needs auth");
  const set = await statesFor({ listShellTools: [{ ...SHELL_CATALOG[0], installed: true, stored: true }] });
  assert.equal(set.byId.coderabbit.installed, true);
  assert.equal(set.byId.coderabbit.label, "Ready");
  // An older host answers no `installed` at all, and there the stored key is the only signal there
  // is to read; the adapter says so rather than calling every shell tool uninstalled.
  const older = await statesFor({ listShellTools: [{ ...SHELL_CATALOG[0], stored: true }] });
  assert.equal(older.byId.coderabbit.installed, true);
});

test("a host with no marketplace commands yet leaves the catalog absent rather than empty", async () => {
  const { createGatewayAdapter, connectorPlugins } = await loadAdapter(answers({ listMarketplace: UNKNOWN("listMarketplace") }));
  const adapter = createGatewayAdapter(seed());
  assert.equal(await adapter.listMarketplace(), null);
  // No catalog is not "a catalog with nothing in it": the panel has to say the host cannot serve
  // one, and the derivation has nothing to derive.
  assert.deepEqual(await adapter.installedPlugins(await connectorPlugins()), []);
});

test("Add writes the catalog's own entry through the connector path, with env names and no values", async () => {
  // Every server connected: a write calls refreshMcp, and a card the box is still launching puts
  // the adapter's settle poll on a 30s timer that would hold this test open for its whole cap.
  const { createGatewayAdapter, posts, calls } = await loadAdapter(
    answers({ listInstalledMcpServers: INSTALLED_SERVERS.map((row) => ({ ...row, status: "connected" })) }),
    { connectors: { mcpServers: { localfiles: CONNECTORS.mcpServers.localfiles } } },
  );
  const adapter = createGatewayAdapter(seed());
  const catalog = await adapter.listMarketplace();
  const item = catalog.plugins.find((p) => p.id === "tinyfish");
  const result = await adapter.addMarketplacePlugin(item);
  assert.equal(result.accepted, true);
  assert.equal(posts.length, 1);
  const written = posts[0].mcpServers.tinyfish;
  assert.equal(written.command, "npx");
  assert.deepEqual(written.args, CONNECTORS.mcpServers.tinyfish.args);
  // Names only. connectors.json is the 0600 plaintext file on the box; the value goes through the
  // credential card, which hands it to the host's own store.
  assert.deepEqual(written.env, { TINYFISH_API_KEY: "" });
  // The entry that was already there survives the write, and the host is asked to re-read.
  assert.ok(posts[0].mcpServers.localfiles);
  assert.ok(calls.some((c) => c.method === "refreshMcp"));
});

// MARKET-6: on a box that has the host's own writer, Add goes there instead, and a catalog row
// that names an ADDRESS rather than a command is added as a remote server rather than refused for
// having no command. Which way the box opens that address is the host's decision, so the console
// hands it the same spec its own Add-your-own link door builds and states no transport of its own.
test("Add reaches the host's writer where the box has one, and an address goes as a remote server", async () => {
  const written = [];
  const { createGatewayAdapter, posts } = await loadAdapter(
    answers({
      listInstalledMcpServers: INSTALLED_SERVERS.map((row) => ({ ...row, status: "connected" })),
      listMarketplace: {
        ...CATALOG,
        plugins: [...CATALOG.plugins, {
          id: "cloudflare-docs", name: "Cloudflare docs", tagline: "Search the documentation.", description: "A public docs server.",
          category: "Development", kind: "connector", icon: { letter: "C", color: "#f38020" },
          install: { url: "https://docs.mcp.cloudflare.com/mcp", type: "http" },
        }],
      },
      addLocalConnector: (args) => { written.push(args.spec); return { added: true, message: "added" }; },
    }),
    { connectors: { mcpServers: { localfiles: CONNECTORS.mcpServers.localfiles } } },
  );
  const adapter = createGatewayAdapter(seed());
  const catalog = await adapter.listMarketplace();

  await adapter.addMarketplacePlugin(catalog.plugins.find((p) => p.id === "tinyfish"));
  assert.equal(written.length, 1);
  assert.equal(written[0].shape, "program");
  assert.deepEqual(written[0].envNames, ["TINYFISH_API_KEY"]);

  const remote = await adapter.addMarketplacePlugin(catalog.plugins.find((p) => p.id === "cloudflare-docs"));
  assert.equal(remote.accepted, true);
  assert.equal(written[1].shape, "remote");
  assert.equal(written[1].url, "https://docs.mcp.cloudflare.com/mcp");
  assert.equal(Object.hasOwn(written[1], "command"), false);

  // And the customer's connector file was never rewritten wholesale to do either of them.
  assert.equal(posts.length, 0);
});

test("Add on a shell-tool row runs the box installer and writes nothing to connectors.json", async () => {
  // A shell tool's `install` is a string -- its shell-tool id -- not a {command,args,env} entry.
  // Add has to read that and reach installShellTool; a typeof check that only recognised the
  // object shape sent CodeRabbit CLI to the MCP connector editor, which writes nothing at all.
  const { createGatewayAdapter, posts, calls } = await loadAdapter(answers({ installShellTool: { ok: true, output: "" } }));
  const adapter = createGatewayAdapter(seed());
  const catalog = await adapter.listMarketplace();
  const item = catalog.plugins.find((p) => p.id === "coderabbit");
  assert.equal(item.kind, "shell-tool");
  assert.equal(typeof item.install, "string");
  const result = await adapter.addMarketplacePlugin(item, "w1");
  assert.equal(result.accepted, true);
  assert.deepEqual(calls.filter((c) => c.method === "installShellTool").map((c) => c.args.id), ["coderabbit"]);
  // Nothing about a shell tool belongs in connectors.json, and the host has no server to re-read.
  assert.equal(posts.length, 0);
  assert.equal(calls.filter((c) => c.method === "refreshMcp").length, 0);
});

test("Uninstall is the same removeConnector write, and clearing a stored value is its own call", async () => {
  const removed = [];
  const { createGatewayAdapter, posts } = await loadAdapter(answers({
    deleteConnectorSecret: (args) => { removed.push(args); return { removed: true }; },
    listInstalledMcpServers: INSTALLED_SERVERS.map((row) => ({ ...row, status: "connected" })),
  }));
  const adapter = createGatewayAdapter(seed());
  const cleared = await adapter.deleteConnectorSecret("tinyfish", "TINYFISH_API_KEY");
  assert.equal(cleared.accepted, true);
  assert.deepEqual(removed, [{ server: "tinyfish", field: "TINYFISH_API_KEY" }]);
  const result = await adapter.removeConnector("tinyfish");
  assert.equal(result.accepted, true);
  assert.equal(posts.at(-1).mcpServers.tinyfish, undefined);
  assert.ok(posts.at(-1).mcpServers.localfiles);
});

// The two rules the click path in ui/machine-room/app.js has to keep. They are drawn markup with
// no adapter behind them, so they are pinned against the source the browser gate then exercises.
test("the click path keeps Add's door narrow and Settings to one open card", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  // Add falls back to the connector editor only for the catalog's explicit door -- a row that says
  // `opensEditor` and carries no install. A shell tool's install is a STRING, so a typeof-object
  // test on it threw CodeRabbit CLI and TinyFish CLI back to the editor instead of installing them.
  assert.match(source, /if \(item\.opensEditor === true \|\| item\.install == null\) \{/);
  assert.doesNotMatch(source, /typeof item\.install !== "object"/);
  // Settings draws Providers and Chat listeners from the same cards, and one card is open at a
  // time: a section that fell back to its own first member put a listener's Connect form and its
  // masked token input on the page beside every provider card.
  const start = source.indexOf("function pluginGroupSection(");
  assert.notEqual(start, -1, "app.js no longer builds the Settings plugin sections here");
  const section = source.slice(start, source.indexOf("function settingsPanel(", start));
  assert.match(section, /members\.find\(\(plugin\) => plugin\.id === selectedPluginId\) \?\? null/);
  assert.equal(section.split('class="plugin-detail"').length - 1, 1);
});

// MR-37: the panel reads the catalog through the gateway when it opens. Until that read has
// answered it knows nothing about the host, and the sentence it used to draw in that window --
// "There is no catalog to draw" -- is a claim about the host made before the host was asked. On a
// loaded box that window is seconds long and it is the operator's first sight of the Marketplace.
async function sectionsMarkup() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function marketplaceSectionsMarkup(");
  assert.notEqual(start, -1, "app.js no longer defines marketplaceSectionsMarkup");
  const body = source.slice(start, source.indexOf("\n  }\n", start) + 4);
  const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return (items, read) => new Function(
    "escapeHtml", "marketplaceItems", "marketplaceMatches", "marketplaceCategories",
    "marketplaceCardMarkup", "MARKETPLACE_ALL", "marketplaceCategory", "marketplaceQuery", "marketplaceRead",
    `${body}\nreturn marketplaceSectionsMarkup();`,
  )(
    escapeHtml,
    () => items,
    () => true,
    () => ["All", ...new Set(items.map((i) => String(i.category ?? "")))],
    (item) => `<div data-marketplace-card="${item.id}"></div>`,
    "All", "All", "", read,
  );
}

test("MR-37: the Marketplace says it is reading the host's catalog instead of that there is none", async () => {
  const sections = await sectionsMarkup();
  const reading = sections([], false);
  assert.match(reading, /data-marketplace-loading/, "the read in flight is addressable, so a gate can wait for it rather than time a sleep");
  assert.match(reading, /Reading the host’s catalog/);
  assert.doesNotMatch(reading, /There is no catalog to draw/, "nothing is claimed about the host before the host has answered");
  // Once the read has answered, an empty catalog IS the host's answer and the panel says so.
  const answered = sections([], true);
  assert.match(answered, /There is no catalog to draw/);
  assert.doesNotMatch(answered, /data-marketplace-loading/);
  // And an answered read with rows draws the rows, with nothing left for a gate to wait on.
  const drawn = sections([{ id: "github", category: "Development" }], true);
  assert.match(drawn, /data-marketplace-card="github"/);
  assert.doesNotMatch(drawn, /data-marketplace-loading/);
});

// MR-37: a live repaint that changes nothing must write nothing. Every write to the sections
// throws away the catalog's <img> tiles and makes the browser decode them again, so a heartbeat
// on an untouched catalog blinked every logo on the page -- and a tile caught mid-decode is a
// tile that is not drawn.
test("MR-37: a live marketplace repaint compares against what it last wrote", async () => {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const start = source.indexOf("  function paintMarketplaceLive(");
  assert.notEqual(start, -1, "app.js no longer defines paintMarketplaceLive");
  const body = source.slice(start, source.indexOf("\n  }\n", start) + 4);
  assert.match(body, /next !== marketplacePainted\.sections/);
  assert.match(body, /next !== marketplacePainted\.strip/);
  // Against the cache, not against the DOM's own serialisation: the browser rewrites `<img ... />`
  // as `<img ...>`, so a comparison with innerHTML would never be equal and would repaint always.
  assert.doesNotMatch(body, /sections\.innerHTML !== /);
  assert.doesNotMatch(body, /strip\.outerHTML !== /);
  // A full repaint seeds the cache with what it drew, so the first heartbeat after it is a no-op.
  const full = source.slice(source.indexOf("  function paintMarketplaceBody("));
  assert.match(full.slice(0, full.indexOf("\n  }\n")), /marketplacePainted\.sections = body\.querySelector/);
});
