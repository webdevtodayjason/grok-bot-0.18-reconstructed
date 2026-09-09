// MARKET-6, the console half: bring your own MCP server, one credential home, and the two things
// that used to have no home at all -- a plain sentence when a connector fails, and the values the
// host still holds for a plugin the box no longer has.
//
// What is worth pinning here, because each one is a way this card could quietly start lying:
//   - THE THREE DOORS. A person arrives with a link, with a command, or with a config block they
//     copied out of a vendor's page. Each produces a spec; the spec says nothing about transport,
//     because whether a remote server is opened natively or through a bridge is the box's business
//     and a form that baked it in would go stale without anyone noticing.
//   - NO VALUE IN A SPEC, EVER. A header ticked as a secret carries an env NAME and an empty
//     value. connectors.json is plaintext on the box, so a literal that reached a spec would reach
//     that file; a pasted block's header value is dropped and the card says it was dropped.
//   - THE REFUSALS, WORD FOR WORD. They arrive before a key is typed rather than sixty seconds
//     later as a stack, and each names the thing to change. A refused address is the only defence
//     against a bridge aimed at the box's own gateway on 127.0.0.1:1340.
//   - ONE CREDENTIAL HOME (MARKET-5). One masked box per credential, one line naming every process
//     the value reaches, and ONE write. The complaint was two forms for one provider, each warning
//     that the other's value did not reach it.
//   - INCLUDED WITH YOUR PLAN (PROXY-7's shape, not its plumbing): a row the box carries on its
//     plan draws no key box at all, because there is no key for the owner to go and get.
//   - CONNECT-11: a stored value for a connector nobody has any more can be named and cleared.
//
// Nothing here touches a real credential: every value in this file is the literal string
// "not-a-real-key", and the assertions are about where it does NOT go.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(repoRoot, "ui/machine-room/app.js");

const UNKNOWN = (method) => new Error(`unknown gateway method: ${method}`);
const NOT_A_KEY = "not-a-real-key";

// A box with two entries and a catalog that carries the MARKET-5 credential shape on one row, the
// older env-name-to-hint map on another, and a row the plan carries.
const CONNECTORS = {
  mcpServers: {
    tinyfish: { command: "npx", args: ["-y", "mcp-remote", "https://agent.tinyfish.ai/mcp"], env: { TINYFISH_API_KEY: "" } },
    notion: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server@2.5.1"], env: { NOTION_TOKEN: "" } },
  },
};

const CATALOG = {
  categories: ["Featured", "Web & Search", "Documents & Files", "Business"],
  plugins: [
    {
      id: "tinyfish", name: "TinyFish", tagline: "Web automation and search.", description: "TinyFish's hosted endpoint.",
      category: "Web & Search", featured: true, kind: "connector",
      icon: { letter: "T", color: "#31b6b8" },
      install: CONNECTORS.mcpServers.tinyfish,
      keywords: ["scraping", "browser"],
      // One key, two processes. This is the row MARKET-5 is about.
      components: [
        { kind: "connector", connectorName: "tinyfish", install: CONNECTORS.mcpServers.tinyfish },
        { kind: "shell-tool", shellToolId: "tinyfish-cli", install: "tinyfish-cli" },
      ],
      credentials: [{
        field: "TINYFISH_API_KEY",
        label: "TinyFish API key",
        hint: "Make one in the TinyFish dashboard under API keys; the read scope is enough.",
        consumers: [{ kind: "connector", env: "TINYFISH_API_KEY" }, { kind: "shell", env: "TINYFISH_API_KEY" }],
      }],
    },
    {
      id: "notion", name: "Notion", tagline: "Pages and databases.", description: "Notion's own MCP server.",
      category: "Documents & Files", kind: "connector",
      icon: { letter: "N", color: "#8b69ea" },
      install: CONNECTORS.mcpServers.notion,
      keywords: ["wiki", "docs"],
      // The older shape, with no preset of its own in the adapter's hand-written five. The hint
      // has to reach the card from HERE or the masked box draws with no sentence under it, which
      // is the one thing CONNECT-4 was about.
      credentialHints: { NOTION_TOKEN: "Make an internal integration in Notion and share the pages you want it to see." },
    },
    {
      id: "cloudflare-docs", name: "Cloudflare docs", tagline: "Search the Cloudflare documentation.", description: "Cloudflare's public docs server.",
      category: "Business", kind: "connector",
      icon: { letter: "C", color: "#f38020" },
      install: { url: "https://docs.mcp.cloudflare.com/mcp", type: "http" },
      keywords: ["dns", "workers"],
    },
    {
      id: "proxied", name: "Proxied provider", tagline: "Carried on your plan.", description: "A provider the box's proxy carries.",
      category: "Business", kind: "connector",
      icon: { letter: "P", color: "#0EA5E9" },
      install: { command: "npx", args: ["-y", "proxied-mcp"], env: { PROXIED_KEY: "" } },
      includedWithPlan: true,
      credentials: [{ field: "PROXIED_KEY", label: "Provider key", hint: "not needed", consumers: [{ kind: "connector", env: "PROXIED_KEY" }] }],
    },
  ],
};

// A box on today's bundle: none of the MARKET-6 host commands exist yet, so the console falls back
// to the relay. Tests that want the host path answer these themselves.
const HOST_WITHOUT_MARKET6 = {
  addLocalConnector: () => UNKNOWN("addLocalConnector"),
  removeLocalConnector: () => UNKNOWN("removeLocalConnector"),
  previewLocalConnector: () => UNKNOWN("previewLocalConnector"),
  setPluginCredential: () => UNKNOWN("setPluginCredential"),
  listConnectorSecretOrphans: () => UNKNOWN("listConnectorSecretOrphans"),
};

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
  const defaults = {
    listAgents: [], getTrays: [], getAgentAutomations: [], getAgentWorkflows: [],
    getConversationOutline: [], getAgentTranscriptTail: { entries: [] },
    listMarketplace: CATALOG,
    ...HOST_WITHOUT_MARKET6,
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

// ---- the markup halves, sliced out of app.js and RUN ------------------------------------------
// Copied assertions would go on passing after the console changed, so the blocks themselves are
// evaluated here with the smallest surface they touch: an escaper, a status label, and an adapter.
const between = (source, startMark, endMark, what) => {
  const start = source.indexOf(startMark);
  assert.notEqual(start, -1, `${what}: "${startMark}" is no longer in app.js`);
  const end = source.indexOf(endMark, start);
  assert.ok(end > start, `${what}: "${endMark}" is no longer after it in app.js`);
  return source.slice(start, end);
};

const ESCAPER = `const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));`;

// The credential home, the component rows and the health line.
async function loadCredentialMarkup(adapter = {}) {
  const source = await readFile(appPath, "utf8");
  const block = between(source, "  const CREDENTIAL_CONSUMER_WORDS = {", "  function marketplaceConnectorsSectionMarkup(", "the credential home");
  const health = between(source, "  function connectorHealthMarkup(card) {", "\n  function marketplaceConnectorsSectionMarkup(", "the health line");
  const fn = new Function("adapter", `${ESCAPER}
    const pluginStatusLabel = (status) => String(status);
    const pluginAccountMarkup = () => "<!--account-->";
    const pluginSecretsMarkup = () => "<!--old-secret-card-->";
    ${block}
    ${health}
    return { pluginCredentialHomeMarkup, marketplaceAccountsSectionMarkup, pluginComponentRowsMarkup, credentialConsumerLine, pluginCredentials, connectorHealthMarkup };`);
  return fn(adapter);
}

// The three doors and the orphan strip.
async function loadDoorMarkup(adapter = {}, orphans = null) {
  const source = await readFile(appPath, "utf8");
  const block = between(source, "  const BYO_DOORS = [", "  function connectorEditorMarkup()", "the doors");
  const fn = new Function("adapter", "seedOrphans", `${ESCAPER}
    ${block}
    byoOrphans = seedOrphans;
    return {
      doors: BYO_DOORS,
      setHeaders: (rows) => { byoHeaders = rows; },
      byoHeaderRowMarkup, byoPreviewMarkup, byoLinkDoorMarkup, byoProgramDoorMarkup, byoPasteDoorMarkup, byoOrphanStripMarkup,
      setPreview: (value) => { byoPreview = value; },
    };`);
  return fn(adapter, orphans);
}

// ---- the doors -------------------------------------------------------------------------------

test("the link door builds a remote spec, and a secret header carries a name and never a value", async () => {
  const { createGatewayAdapter } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  const spec = adapter.byoRemoteSpec({
    name: "",
    url: "https://mcp.notion.com/mcp",
    transport: "http",
    // What a person types: a header they ticked as a secret, and one that is genuinely a literal.
    headers: [
      { name: "Authorization", secret: true, value: NOT_A_KEY },
      { name: "X-MCP-Readonly", secret: false, value: "true" },
    ],
  });
  assert.equal(spec.shape, "remote");
  assert.equal(spec.url, "https://mcp.notion.com/mcp");
  assert.equal(spec.transport, "http");
  // Named from the address, because nobody came here to invent a name.
  assert.equal(spec.name, "notion");
  const secret = spec.headers.find((row) => row.name === "Authorization");
  assert.equal(secret.secret, true);
  assert.equal(secret.env, "NOTION_TOKEN");
  assert.equal(Object.hasOwn(secret, "value"), false, "a secret header row must not carry a value at all");
  assert.deepEqual(spec.envNames, ["NOTION_TOKEN"]);
  // The literal survives as one -- an "X-MCP-Readonly: true" is not a credential.
  assert.deepEqual(spec.headers.find((row) => row.name === "X-MCP-Readonly"), { name: "X-MCP-Readonly", secret: false, value: "true" });
  // And the key itself is nowhere in the spec, at any depth.
  assert.equal(JSON.stringify(spec).includes(NOT_A_KEY), false);
});

test("the program door builds a program spec with env names only", async () => {
  const { createGatewayAdapter } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  const spec = adapter.byoProgramSpec({
    name: "localfiles",
    command: "npx",
    argsText: '-y @modelcontextprotocol/server-filesystem "/workspace/my files"',
    envNames: "API_TOKEN, OTHER_TOKEN",
  });
  assert.equal(spec.shape, "program");
  assert.equal(spec.command, "npx");
  // The quote-aware split survives: an argument that holds a space is one argument.
  assert.deepEqual(spec.args, ["-y", "@modelcontextprotocol/server-filesystem", "/workspace/my files"]);
  assert.deepEqual(spec.envNames, ["API_TOKEN", "OTHER_TOKEN"]);
});

test("a pasted config block reads into whichever door fits it, and its key is dropped out loud", async () => {
  const { createGatewayAdapter } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());

  const remote = adapter.byoParsePasted(JSON.stringify({
    mcpServers: { linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${NOT_A_KEY}` } } },
  }));
  assert.equal(remote.ok, true);
  assert.equal(remote.door, "link");
  assert.equal(remote.spec.url, "https://mcp.linear.app/mcp");
  assert.equal(remote.spec.name, "linear");
  assert.equal(remote.spec.headers[0].secret, true);
  assert.equal(JSON.stringify(remote.spec).includes(NOT_A_KEY), false, "a pasted key must not reach the spec");
  // Said out loud: a value silently discarded is worse than one refused, because the operator
  // would press Add believing the key came along.
  assert.match(remote.note, /was not kept/);

  const program = adapter.byoParsePasted(JSON.stringify({
    mcpServers: { airtable: { command: "npx", args: ["-y", "airtable-mcp-server@1.14.0"], env: { AIRTABLE_API_KEY: NOT_A_KEY } } },
  }));
  assert.equal(program.ok, true);
  assert.equal(program.door, "program");
  assert.equal(program.spec.command, "npx");
  assert.deepEqual(program.spec.envNames, ["AIRTABLE_API_KEY"]);
  assert.equal(JSON.stringify(program.spec).includes(NOT_A_KEY), false);
  assert.match(program.note, /was not kept/);

  // Two servers in one block is refused rather than half-read: the point of the preview is that a
  // person reads what will be written, and that does not survive being handed two of them.
  const many = adapter.byoParsePasted(JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b" } } }));
  assert.equal(many.ok, false);
  assert.match(many.message, /Paste one at a time/);

  const rubbish = adapter.byoParsePasted("not json at all");
  assert.equal(rubbish.ok, false);
  assert.match(rubbish.message, /mcpServers/);
});

// ---- the refusals, word for word ---------------------------------------------------------------

test("the five refusals are one plain sentence each, and each names what to change", async () => {
  const { createGatewayAdapter } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  const link = (over) => adapter.byoRefusal(adapter.byoRemoteSpec({ name: "probe", url: "https://mcp.example.com/mcp", headers: [], ...over }));

  assert.equal(
    adapter.byoRefusal(adapter.byoProgramSpec({ name: "shell", command: "npx" })),
    '"shell" is reserved for the agent\'s own box shell environment, so a connector cannot use that name. Rename it (for example shell-mcp) and add it again.',
  );
  assert.equal(
    link({ url: "http://mcp.example.com/mcp" }),
    "Give the address as https. Over plain http the key would travel in the clear, so this box will not open one.",
  );
  const privateHost = "That address is inside this box's own network, where its gateway and its tool daemons listen. Give the server's address on the internet instead.";
  // The one that matters: a bridge aimed at 127.0.0.1 runs beside the gateway on 1340 and the exec
  // daemons on 1337 and 1338.
  // MARKET-22: and the same addresses in their IPv6 coat, which the shipped door accepted --
  // byoPrivateHost("::ffff:7f00:1") was false on this Mac on 2026-09-08, and the host's own door
  // took the matching URL with a secret header on the R750 demo box.
  for (const host of [
    "127.0.0.1", "localhost", "10.0.0.5", "192.168.1.9", "172.16.4.4", "169.254.1.1", "box.local",
    "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::]", "[::1]", "[::ffff:169.254.169.254]",
    "[::ffff:192.168.48.6]", "[fd00::1]", "[fe80::1]",
  ]) {
    assert.equal(link({ url: `https://${host}/mcp` }), privateHost, `${host} was not refused`);
  }
  // A global-unicast v6 address is a server on the internet and stays addable.
  assert.equal(link({ url: "https://[2606:4700::1111]/mcp" }), null);
  assert.equal(
    link({ url: `https://mcp.example.com/mcp?api_key=${NOT_A_KEY}` }),
    "That address carries the key inside it. Take the key out of the address and add it as a header below, where it is stored instead of written down.",
  );
  assert.equal(link({ url: `https://user:${NOT_A_KEY}@mcp.example.com/mcp` }), "That address carries the key inside it. Take the key out of the address and add it as a header below, where it is stored instead of written down.");
  // MARKET-18. The old sentence sent the operator to the box's desktop to sign in and add it
  // again, and there is no OAuth path on either the native remote or the bridge, so the second add
  // answered the same sentence forever. This one is true, and it is the same string the host says
  // when it reads the far end's own WWW-Authenticate challenge -- which is where an operator
  // actually meets it, since no control in the console sets auth:"oauth".
  assert.equal(
    link({ auth: "oauth" }),
    "That server asks people to sign in through a browser, and this box has no browser sign-in to give it, so it would never finish connecting. If the server also takes an API key, add it again with that key in a header; otherwise it cannot be added here yet.",
  );
  // And a good one is not refused.
  assert.equal(link({}), null);
});

test("a refusal stops the write before it starts", async () => {
  const { createGatewayAdapter, calls, posts } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.addLocalConnector(adapter.byoRemoteSpec({ name: "probe", url: "http://mcp.example.com/mcp", headers: [] }));
  assert.equal(result.accepted, false);
  assert.match(result.message, /^Give the address as https/);
  assert.equal(posts.length, 0);
  assert.equal(calls.filter((c) => c.method === "addLocalConnector").length, 0);
});

// ---- one writer ---------------------------------------------------------------------------------

test("Add goes to the host's own writer where the box has one", async () => {
  const written = [];
  const { createGatewayAdapter, calls, posts } = await loadAdapter({
    addLocalConnector: (args) => { written.push(args); return { added: true, message: "notion added", entry: { command: "npx" } }; },
  });
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.addConnector({ name: "notion", command: "npx", args: ["-y", "@notionhq/notion-mcp-server@2.5.1"], envNames: ["NOTION_TOKEN"] });
  assert.equal(result.accepted, true);
  assert.equal(written.length, 1);
  // The host's own argument shape, which is the entry it is about to write: a program says its
  // command, and the credential crosses as a NAME, never a value.
  assert.equal(written[0].name, "notion");
  assert.equal(written[0].command, "npx");
  assert.deepEqual(written[0].env, ["NOTION_TOKEN"]);
  assert.equal(Object.hasOwn(written[0], "url"), false);
  // The whole-file write through the relay is no longer how a customer's connectors get edited.
  assert.equal(posts.length, 0);
  assert.equal(calls.filter((c) => c.method === "addLocalConnector").length, 1);
});

test("a secret Authorization header is written with the scheme the far end expects", async () => {
  const written = [];
  const { createGatewayAdapter } = await loadAdapter({
    addLocalConnector: (args) => { written.push(args); return { added: true, message: "added", entry: {} }; },
  });
  const adapter = createGatewayAdapter(seed());

  // The common case, and the one that was broken: a person pastes an address, leaves the header
  // row as Authorization, ticks it secret, and types their key into the masked box afterwards.
  // Written bare, the far end receives `Authorization: <key>` with no scheme and answers 401, and
  // the health line then tells the operator their key was refused. Every catalog row that uses
  // Authorization writes `Bearer ${FIELD}`; the form now agrees with them.
  await adapter.addLocalConnector(adapter.byoRemoteSpec({
    name: "acme", url: "https://mcp.acme.com/mcp", transport: "http",
    headers: [{ name: "Authorization", secret: true }],
  }));
  assert.equal(written[0].headers.Authorization, "Bearer ${ACME_TOKEN}");
  assert.deepEqual(written[0].env, ["ACME_TOKEN"]);

  // A vendor's own header takes the key on its own, which is what those servers ask for, so the
  // placeholder stays bare there. Getting this wrong the other way would break Exa and Browser Use.
  written.length = 0;
  await adapter.addLocalConnector(adapter.byoRemoteSpec({
    name: "exa", url: "https://mcp.exa.ai/mcp", transport: "http",
    headers: [{ name: "x-api-key", secret: true }],
  }));
  assert.equal(written[0].headers["x-api-key"], "${EXA_API_KEY}");

  // And a header that is not a secret is still written as the literal it is.
  written.length = 0;
  await adapter.addLocalConnector(adapter.byoRemoteSpec({
    name: "gh", url: "https://api.githubcopilot.com/mcp/", transport: "http",
    headers: [{ name: "X-MCP-Readonly", secret: false, value: "true" }],
  }));
  assert.equal(written[0].headers["X-MCP-Readonly"], "true");
});

test("the preview shows the scheme it is going to write", async () => {
  const { createGatewayAdapter } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  const shown = await adapter.byoPreview(adapter.byoRemoteSpec({
    name: "acme", url: "https://mcp.acme.com/mcp", transport: "http",
    headers: [{ name: "Authorization", secret: true }],
  }));
  // The preview is the operator's only sight of the entry before Add, so it has to agree with what
  // gets written -- scheme included -- and still carry no key.
  assert.equal(shown.entry.headers.Authorization, "Bearer (stored under ACME_TOKEN)");
  assert.deepEqual(shown.entry.env, { ACME_TOKEN: "" });
});

test("a box whose bundle predates the host writer still takes a program, and says so about an address", async () => {
  const { createGatewayAdapter, posts } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  const program = await adapter.addConnector({ name: "localfiles", command: "npx", args: ["-y", "server-filesystem"], envNames: [] });
  assert.equal(program.accepted, true);
  assert.equal(posts.length, 1, "the relay's whole-file write is the fallback, and it ran");
  assert.deepEqual(posts[0].mcpServers.localfiles.env, {});

  // A remote server cannot be written as a command, so it is refused in words rather than written
  // as something it is not.
  const remote = await adapter.addLocalConnector(adapter.byoRemoteSpec({ name: "docs", url: "https://docs.mcp.cloudflare.com/mcp", headers: [] }));
  assert.equal(remote.accepted, false);
  assert.match(remote.message, /Update the box and add it again/);
});

test("Uninstall asks the host to clear the values and drop the entry in one call", async () => {
  const asked = [];
  // The host's OWN answer shape: mcp-service's removeLocalConnector returns `cleared: string[]`,
  // and it was measured returning cleared:["MKT6REV_TOKEN"] on the R750 demo box on 2026-09-08.
  // This stub used to invent a `clearedCredentials` number the gateway has never once produced, so
  // the suite was green while the toast's "and 1 stored value cleared" clause was dead on every box.
  const { createGatewayAdapter, posts } = await loadAdapter({
    removeLocalConnector: (args) => { asked.push(args); return { removed: true, cleared: ["TINYFISH_API_KEY", "TINYFISH_PROFILE"], stored: [] }; },
  });
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.removeConnector("tinyfish", { clearSecrets: true });
  assert.equal(result.accepted, true);
  assert.deepEqual(asked, [{ server: "tinyfish", name: "tinyfish", clearSecrets: true }]);
  assert.equal(result.clearedCredentials, 2);
  assert.match(result.message, /2 stored values cleared/);
  // The ordering -- values first, then the entry -- lives in the host now, so the console makes
  // no deleteConnectorSecret calls of its own.
  assert.equal(posts.length, 0);
});

test("a box on the older answer shape still gets a truthful toast", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    removeLocalConnector: () => ({ removed: true, clearedCredentials: 1 }),
  });
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.removeConnector("tinyfish", { clearSecrets: true });
  assert.equal(result.clearedCredentials, 1);
  assert.match(result.message, /1 stored value cleared/);
});

test("every removal door clears the key, not only the Marketplace's Uninstall", async () => {
  // MARKET-23. Measured on the R750 demo box on 2026-09-08: the plugin card's Remove sent
  // removeLocalConnector with no options, the host answered cleared:[] and the value stayed in the
  // 0600 store as an orphan, while the Marketplace card next door cleared it. The relay's connector
  // editor did the same. All three doors now send the flag.
  const source = await readFile(appPath, "utf8");
  const handler = between(source, "    } else if (target.dataset.removeConnector) {", "    } else if (target.dataset.installShellTool) {", "the card's remove handler");
  assert.match(handler, /adapter\.removeConnector\(name, \{ clearSecrets: true \}\)/);
  const relay = await readFile(path.join(repoRoot, "ui/server.mjs"), "utf8");
  assert.match(relay, /\{ server: change\.name, name: change\.name, clearSecrets: true \}/);
});

// ---- the hint triangle, collapsed ---------------------------------------------------------------

test("a catalog row with no hand-written preset still gets its hint under the masked box", async () => {
  const { createGatewayAdapter, connectorPlugins } = await loadAdapter({
    listInstalledMcpServers: [
      { id: "1", name: "notion", serverIdentifier: "notion", status: "connected", transport: "stdio", toolCount: 4 },
    ],
    listMcpServerTools: [],
    listConnectorSecretFields: { server: "notion", serverId: 1, fields: ["NOTION_TOKEN"], stored: [] },
  });
  const adapter = createGatewayAdapter(seed());
  // The catalog is read once and cached; the hints come off that read rather than a second list.
  await adapter.listMarketplace();
  const cards = await connectorPlugins();
  const card = cards.find((one) => one.name === "notion");
  assert.deepEqual(card.secretFields, ["NOTION_TOKEN"]);
  assert.equal(card.secretHints.NOTION_TOKEN, "Make an internal integration in Notion and share the pages you want it to see.");
});

test("the editor's preset row carries the catalog's rows beside the pinned five, once each", async () => {
  const { createGatewayAdapter } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  await adapter.listMarketplace();
  const presets = adapter.connectorPresets();
  const ids = presets.map((preset) => preset.id);
  // The five that docs/connectors/ holds character for character are still there.
  for (const pinned of ["github", "slack", "linear", "google", "tinyfish"]) assert.ok(ids.includes(pinned), `${pinned} left the pinned presets`);
  // And a catalog row with a command of its own is now a preset too, with its hint.
  const notion = presets.find((preset) => preset.id === "notion");
  assert.ok(notion, "the catalog's notion row is not offered as a preset");
  assert.equal(notion.command, "npx");
  assert.equal(notion.hints.NOTION_TOKEN, "Make an internal integration in Notion and share the pages you want it to see.");
  // A remote row has nothing to fill four fields with, so it is not a preset -- its Add is its card.
  assert.equal(ids.includes("cloudflare-docs"), false);
  // And no id twice: two buttons writing the same entry is a way to make someone wonder which is real.
  assert.equal(new Set(ids).size, ids.length);
});

// ---- one credential home (MARKET-5) -------------------------------------------------------------

test("setPluginCredential is one write, and the page is told where the value went", async () => {
  const written = [];
  const { createGatewayAdapter } = await loadAdapter({
    setPluginCredential: (args) => {
      written.push({ pluginId: args.pluginId, field: args.field, hasValue: typeof args.value === "string" && args.value.length > 0 });
      return { stored: true, wentTo: ["the connector", "the agent's shell"], pendingWindows: ["w2"] };
    },
  });
  const adapter = createGatewayAdapter(seed());
  const result = await adapter.setPluginCredential("tinyfish", "TINYFISH_API_KEY", NOT_A_KEY);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.wentTo, ["the connector", "the agent's shell"]);
  assert.deepEqual(result.pendingWindows, ["w2"]);
  // ONE call. The complaint was two forms for one provider; two writes would be the same bug
  // wearing one form.
  assert.deepEqual(written, [{ pluginId: "tinyfish", field: "TINYFISH_API_KEY", hasValue: true }]);
});

test("a host with no fan-out yet still keeps the page's promise, from the catalog's own declaration", async () => {
  const connector = [];
  const shell = [];
  const { createGatewayAdapter } = await loadAdapter({
    setConnectorSecret: (args) => { connector.push(args.server); return { stored: true, fields: [args.field] }; },
    setShellSecret: (args) => { shell.push(args.field ?? args.toolId); return { stored: true }; },
  });
  const adapter = createGatewayAdapter(seed());
  await adapter.listMarketplace();
  const item = (await adapter.listMarketplace()).plugins.find((one) => one.id === "tinyfish");
  const result = await adapter.setPluginCredential("tinyfish", "TINYFISH_API_KEY", NOT_A_KEY, item);
  assert.equal(result.accepted, true);
  // Both consumers the row declares were written, so the sentence under the box stays true on a
  // box that has not landed the host half.
  assert.deepEqual(connector, ["tinyfish"]);
  assert.equal(shell.length, 1);
  assert.deepEqual(result.wentTo, ["the connector", "the agent's shell"]);
});

test("the credential card draws ONE masked box, its hint, and one line naming every consumer", async () => {
  const markup = await loadCredentialMarkup();
  const item = CATALOG.plugins.find((one) => one.id === "tinyfish");
  const html = markup.pluginCredentialHomeMarkup(item, { installed: true, storedCredentials: [] }, { storedFields: [] });
  assert.equal((html.match(/type="password"/g) ?? []).length, 1, "one credential, one box");
  assert.equal((html.match(/<form /g) ?? []).length, 1, "one credential, one form");
  assert.match(html, /data-plugin-credential-form="tinyfish"/);
  assert.match(html, /Make one in the TinyFish dashboard/);
  // The line MARKET-5 is about, in plain words, naming both processes.
  assert.match(html, /Stored once\. Used by the connector and by the agent&#39;s shell\./);
  // The old second card is gone from this page.
  assert.equal(html.includes("<!--old-secret-card-->"), false);
});

test("a row the plan carries draws no key box at all", async () => {
  const markup = await loadCredentialMarkup();
  const item = CATALOG.plugins.find((one) => one.id === "proxied");
  const html = markup.pluginCredentialHomeMarkup(item, { installed: false, includedWithPlan: true }, null);
  assert.equal(html.includes("type=\"password\""), false, "there is no key for the owner to go and get");
  assert.equal(html.includes("<form"), false);
  assert.match(html, /Included with your plan/);
  // And the section above it says the same thing rather than telling them to enter something.
  const section = markup.marketplaceAccountsSectionMarkup(item, { installed: false, includedWithPlan: true, label: "Included with your plan" }, null, null);
  assert.match(section, /Your plan carries this one, so there is no key to enter\./);
  assert.equal(section.includes("type=\"password\""), false);
});

test("a folded plugin says what it installed where, once", async () => {
  const markup = await loadCredentialMarkup();
  const rows = markup.pluginComponentRowsMarkup({
    components: [
      { kind: "connector", connectorName: "tinyfish", installed: true, ready: true, needsAuth: false },
      { kind: "shell-tool", shellToolId: "tinyfish-cli", installed: true, ready: false, needsAuth: true },
    ],
  });
  assert.match(rows, /data-plugin-component="tinyfish"/);
  assert.match(rows, /data-plugin-component="tinyfish-cli"/);
  assert.match(rows, /needs its key/);
  // One component is the ordinary case and draws no rows at all.
  assert.equal(markup.pluginComponentRowsMarkup({ components: [{ kind: "connector", connectorName: "notion", installed: true }] }), "");
});

test("the install state rolls up per component, so half installed is not Added", async () => {
  const { marketplaceInstallState } = await loadAdapter();
  const cards = [
    { id: "mcp:tinyfish", removable: true, boxStatus: "connected", secretFields: ["TINYFISH_API_KEY"], storedFields: ["TINYFISH_API_KEY"] },
  ];
  const [row] = marketplaceInstallState([CATALOG.plugins[0]], cards);
  assert.deepEqual(row.cardIds, ["mcp:tinyfish", "shell:tinyfish-cli"]);
  assert.equal(row.cardId, "mcp:tinyfish", "the strip draws a folded plugin under its connector");
  assert.equal(row.installed, false, "the shell tool is not on the box, so the plugin is not installed");
  assert.equal(row.label, "Half installed");

  const both = marketplaceInstallState([CATALOG.plugins[0]], [
    ...cards,
    { id: "shell:tinyfish-cli", shellTool: { installed: true }, boxStatus: "connected", secretFields: [], storedFields: [] },
  ]);
  assert.equal(both[0].installed, true);
  assert.equal(both[0].label, "Ready");
});

// ---- health, in one plain sentence ---------------------------------------------------------------

test("the host's own sentence is drawn verbatim, and the stack sits behind a disclosure", async () => {
  const markup = await loadCredentialMarkup();
  const html = markup.connectorHealthMarkup({
    name: "notion",
    statusSentence: "It needs its key before it can connect. Add the key below.",
    statusDetail: "MCP error -32000: Connection closed; stderr: SseError at EventSource.failConnection_fn",
  });
  assert.match(html, /It needs its key before it can connect\. Add the key below\./);
  assert.match(html, /<details class="panel-card" data-connector-health-detail>/);
  // The stack is behind the disclosure, not in the line the person reads first.
  const line = html.slice(0, html.indexOf("<details"));
  assert.equal(line.includes("EventSource"), false);
  // A host with no sentence draws no line rather than a guess made in the browser.
  assert.equal(markup.connectorHealthMarkup({ name: "notion" }), "");
});

test("the console never matches on a statusDetail to work out what happened", async () => {
  const source = await readFile(appPath, "utf8");
  const block = between(source, "  function connectorHealthMarkup(card) {", "\n  function marketplaceConnectorsSectionMarkup(", "the health line");
  // Reading it to escape it, and asking whether it is a string at all, is the whole of what this
  // may do with it. No search of any kind, and no pattern in the function to search it with.
  assert.equal(/statusDetail[^\n]*\.(test|match|includes|indexOf|search|startsWith)\(/.test(block), false, "the browser started searching the box's raw error text");
  assert.equal(/=\s*\/[^/\n]+\//.test(block), false, "a pattern appeared in the function that draws the health line");
  // The only comparison allowed on it is the typeof guard that decides whether there is one.
  const comparisons = block.match(/statusDetail\s*===\s*(\S+)/g) ?? [];
  for (const line of comparisons) assert.equal(line.replace(/\s+/g, " "), 'statusDetail === "string"', `statusDetail is being compared to something: ${line.trim()}`);
});

// ---- CONNECT-11: values with no plugin ------------------------------------------------------------

test("stored values for a plugin the box no longer has can be named and cleared by name", async () => {
  const cleared = [];
  const { createGatewayAdapter } = await loadAdapter({
    listConnectorSecretOrphans: { orphans: [{ server: "gone", fields: ["GONE_TOKEN", "GONE_OTHER"] }] },
    deleteConnectorSecret: (args) => { cleared.push(args); return { removed: true }; },
  });
  const adapter = createGatewayAdapter(seed());
  const orphans = await adapter.listConnectorSecretOrphans();
  assert.deepEqual(orphans, [{ server: "gone", fields: ["GONE_TOKEN", "GONE_OTHER"] }]);
  const result = await adapter.clearConnectorSecretOrphan("gone");
  assert.equal(result.accepted, true);
  // By NAME, and all of them: the old resolver went through connectors.json for delete as well as
  // for list, so once the entry had left the file its values could not even be named.
  assert.deepEqual(cleared, [{ server: "gone", all: true }]);
});

test("a host with no orphan command draws no strip rather than an empty one claiming all is well", async () => {
  const { createGatewayAdapter } = await loadAdapter();
  const adapter = createGatewayAdapter(seed());
  assert.equal(await adapter.listConnectorSecretOrphans(), null);
  const markup = await loadDoorMarkup({}, null);
  assert.equal(markup.byoOrphanStripMarkup(), "");
});

test("the orphan strip names each one and offers a Clear per name", async () => {
  const markup = await loadDoorMarkup({}, [{ server: "gone", fields: ["GONE_TOKEN"] }, { server: "also-gone", fields: ["A", "B"] }]);
  const html = markup.byoOrphanStripMarkup();
  assert.match(html, /Stored keys with no plugin/);
  assert.match(html, /data-byo-clear-orphan="gone"/);
  assert.match(html, /data-byo-clear-orphan="also-gone"/);
  assert.match(html, /1 value the host still holds/);
  assert.match(html, /2 values the host still holds/);
});

// ---- the card itself ------------------------------------------------------------------------------

test("the card asks link or program first, and offers the paste door beside them", async () => {
  const markup = await loadDoorMarkup({ byoTransports: () => [{ id: "http", label: "Streamable HTTP (what almost every server uses)" }, { id: "sse", label: "SSE (older; only if the server's docs say so)" }] });
  assert.deepEqual(markup.doors.map((door) => door.id), ["link", "program", "paste"]);
  const link = markup.byoLinkDoorMarkup();
  assert.match(link, /Streamable HTTP \(what almost every server uses\)/);
  assert.match(link, /SSE \(older; only if the server&#39;s docs say so\)/);
  assert.match(link, /data-byo-show/);
  const program = markup.byoProgramDoorMarkup();
  assert.match(program, /Environment variable names/);
  assert.match(program, /names only/);
  const paste = markup.byoPasteDoorMarkup();
  assert.match(paste, /mcpServers/);
  assert.match(paste, /A key inside the block is dropped rather than kept\./);
});

test("a header ticked as a secret shows the name it is stored under and no value box", async () => {
  const markup = await loadDoorMarkup();
  const secret = markup.byoHeaderRowMarkup({ name: "Authorization", secret: true, env: "NOTION_TOKEN" }, 0);
  assert.match(secret, /data-byo-header-env="0"/);
  assert.match(secret, /value="NOTION_TOKEN"/);
  assert.equal(secret.includes("data-byo-header-value"), false, "a secret header must not draw a value box");
  assert.match(secret, /Nothing you type here is stored\./);
  const literal = markup.byoHeaderRowMarkup({ name: "X-MCP-Readonly", secret: false, value: "true" }, 1);
  assert.match(literal, /data-byo-header-value="1"/);
  assert.equal(literal.includes("data-byo-header-env"), false);
});

test("the preview shows the entry that will be written, with a stored name where a key would be", async () => {
  const markup = await loadDoorMarkup();
  markup.setPreview({
    entry: { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "(stored under NOTION_TOKEN)" }, env: { NOTION_TOKEN: "" } },
    fromHost: true,
    note: null,
  });
  const html = markup.byoPreviewMarkup();
  assert.match(html, /What will be written/);
  assert.match(html, /This is the entry the box will write\./);
  assert.match(html, /\(stored under NOTION_TOKEN\)/);
  assert.equal(html.includes(NOT_A_KEY), false);
});

// ---- the wiring, read out of app.js itself ---------------------------------------------------------
// These are source assertions on purpose: they are about which call a control makes, which is the
// half a markup test cannot see and the half that goes wrong silently.

test("every control on the card is wired, and the uninstall ordering is the host's", async () => {
  const source = await readFile(appPath, "utf8");
  const click = between(source, "  function handleByoClick(target) {", "  function byoLiveHeaders()", "the byo click handler");
  for (const control of ["byoDoor", "data-byo-header-add", "byoHeaderRemove", "data-byo-show", "byoClearOrphan"]) {
    assert.ok(click.includes(control), `${control} has no handler`);
  }
  assert.ok(source.includes("if (handleByoClick(target)) return;"), "the card's controls never reach their handler");
  assert.ok(source.includes('form.hasAttribute("data-byo-link")'), "the link door's Add is not wired");
  assert.ok(source.includes('form.hasAttribute("data-byo-paste")'), "the paste door is not wired");
  assert.ok(source.includes("form.dataset.pluginCredentialForm"), "the one credential home has no save");

  const uninstall = between(source, "    } else if (target.dataset.marketplaceUninstall) {", "    } else if (target.dataset.installPlugin) {", "the uninstall handler");
  assert.match(uninstall, /removeConnector\(name, \{ clearSecrets:/);
  assert.equal(/deleteConnectorSecret/.test(uninstall), false, "the console is still doing the clear itself");
});

// ---- the relay's POST /connectors, now a shim ------------------------------------------------------
// It used to be the mechanism: read a customer's connectors.json out of the box with `docker exec
// cat`, replace it whole, write it back. Two writers of one file that never agreed on the rules.
// It now works out which keys moved and asks the host to make each change, so validation lives
// where the parser is. Every caller keeps its shape, and a box too old for those commands still
// gets the old write.
async function loadShim() {
  const source = await readFile(path.join(repoRoot, "ui/server.mjs"), "utf8");
  const block = between(source, "const sameConnectorEntry = ", "\nconst readCatalog = ", "the connectors shim");
  const seen = [];
  const answers = { addLocalConnector: { ok: true }, removeLocalConnector: { ok: true } };
  const jobBusCall = async (t, command, args) => {
    seen.push({ command, args });
    const answer = answers[command];
    if (answer instanceof Error) return { status: 500, text: JSON.stringify({ error: answer.message }), type: "application/json" };
    return { status: 200, text: JSON.stringify(answer ?? {}), type: "application/json" };
  };
  const fn = new Function("jobBusCall", `${block}\nreturn { delegateConnectorChanges, connectorSpecFromEntry };`);
  return { ...fn(jobBusCall), seen, answers };
}

test("the relay asks the host for each key that actually moved, and for nothing else", async () => {
  const shim = await loadShim();
  const held = { ...CONNECTORS.mcpServers };
  // The same map back: a console that reloads and resaves must not rewrite anything.
  const unchanged = await shim.delegateConnectorChanges({}, held, { ...held });
  assert.deepEqual(unchanged, { handled: true, changed: [] });
  assert.deepEqual(shim.seen, []);

  // One added, one dropped, one untouched.
  const next = { tinyfish: held.tinyfish, airtable: { command: "npx", args: ["-y", "airtable-mcp-server@1.14.0"], env: { AIRTABLE_API_KEY: "" } } };
  const result = await shim.delegateConnectorChanges({}, held, next);
  assert.equal(result.handled, true);
  assert.deepEqual(result.changed, ["add airtable", "remove notion"]);
  assert.deepEqual(shim.seen.map((one) => one.command), ["addLocalConnector", "removeLocalConnector"]);
  assert.equal(shim.seen[0].args.command, "npx");
  assert.equal(shim.seen[0].args.name, "airtable");
  assert.deepEqual(shim.seen[0].args.env, ["AIRTABLE_API_KEY"]);
  assert.equal(shim.seen[0].args.replace, true);
  // MARKET-23: an entry deleted in the editor takes its stored value with it, the same as the
  // card's Remove and the Marketplace's Uninstall.
  assert.deepEqual(shim.seen[1].args, { server: "notion", name: "notion", clearSecrets: true });
});

test("an address in the file goes to the host as a remote server, not as a command", async () => {
  const shim = await loadShim();
  const spec = shim.connectorSpecFromEntry("cloudflare-docs", { url: "https://docs.mcp.cloudflare.com/mcp", type: "http", env: {} });
  assert.equal(spec.url, "https://docs.mcp.cloudflare.com/mcp");
  assert.equal(spec.type, "http");
  assert.equal(Object.hasOwn(spec, "command"), false, "which way the box opens an address is the host's decision");

  // A credential field crosses as a name with no value; a configuration variable the operator has
  // already answered keeps its value, or a resave would wipe it.
  const program = shim.connectorSpecFromEntry("notion", { command: "npx", args: ["-y", "x"], env: { NOTION_TOKEN: "" } });
  assert.deepEqual(program.env, ["NOTION_TOKEN"]);
  const configured = shim.connectorSpecFromEntry("bridge", { command: "npx", args: [], env: { MCP_REMOTE_CONFIG_DIR: "/home/box/sand-data/.mcp-auth", A_TOKEN: "" } });
  assert.deepEqual(configured.env, { MCP_REMOTE_CONFIG_DIR: "/home/box/sand-data/.mcp-auth", A_TOKEN: "" });
});

test("a box too old for the host writer falls back, and a host refusal does not", async () => {
  const older = await loadShim();
  older.answers.addLocalConnector = new Error("unknown gateway method: addLocalConnector");
  const fallback = await older.delegateConnectorChanges({}, {}, { probe: { command: "npx", args: [], env: {} } });
  assert.deepEqual(fallback, { handled: false }, "the caller has to do the old whole-file write");

  const refusing = await loadShim();
  refusing.answers.addLocalConnector = new Error('"shell" is reserved for the agent\'s own box shell environment');
  const refused = await refusing.delegateConnectorChanges({}, {}, { shell: { command: "npx", args: [], env: {} } });
  assert.equal(refused.handled, true, "a refusal must not be taken for a missing command and written behind the host's back");
  assert.match(refused.error, /reserved for the agent/);
});

test("the marketplace search reads the catalog's keywords", async () => {
  const source = await readFile(appPath, "utf8");
  const matches = between(source, "  function marketplaceMatches(item) {", "\n  function marketplaceCardMarkup(", "the search filter");
  assert.match(matches, /item\?\.keywords/);
  // An owner types "crm" or "invoice", and those words do not belong in a tagline a person reads.
  const fn = new Function("item", "q", `let marketplaceQuery = q;\n${matches}\nreturn marketplaceMatches(item);`);
  assert.equal(fn({ name: "Notion", tagline: "Pages and databases.", category: "Documents & Files", keywords: ["wiki", "docs"] }, "wiki"), true);
  assert.equal(fn({ name: "Notion", tagline: "Pages and databases.", category: "Documents & Files", keywords: ["wiki"] }, "spreadsheet"), false);
});

test("no copy on this card names a tool, a vendor's old name, or the retired product name", async () => {
  const source = await readFile(appPath, "utf8");
  const block = between(source, "  const BYO_DOORS = [", "  // ---- end MARKET-6: Add your own", "the card's copy");
  const credentials = between(source, "  const CREDENTIAL_CONSUMER_WORDS = {", "  function marketplaceConnectorsSectionMarkup(", "the credential home copy");
  for (const banned of [/Grok Bot/i, /\bCursor\b/]) {
    assert.equal(banned.test(block), false, `the doors' copy says ${banned}`);
    assert.equal(banned.test(credentials), false, `the credential home's copy says ${banned}`);
  }
});
