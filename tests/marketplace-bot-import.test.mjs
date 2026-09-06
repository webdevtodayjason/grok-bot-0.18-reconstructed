// Import Bot is a sequence, not a call: createAgent with the template's persona, then one
// importAgentWorkflowText per skill carrying that skill's own SKILL.md text, then one
// getAgentWorkflows read-back that decides what actually landed. Every one of those is a write on
// a live box, so the order and the arguments are pinned here against a fake gateway rather than
// discovered by clicking Import in a browser.
//
// The persona field: this host stores an agent as { name, description, title } and only name +
// description reach the model as its identity (source/host/agents/agent-profile.ts, and
// renderAgentProfileUpdate in source/host/runner/sand-agent-profile-prompt.ts). There is no
// separate persona/systemPrompt field, so the template's description and its instructions share
// `description`, description first.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The module is an IIFE that attaches to a global and touches nothing at load, so a bare object
// stands in for the window.
async function loadMarketplaceBots() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/marketplace-bots.js"), "utf8");
  const fn = new Function("window", `${source}\nreturn window.__marketplaceBots;`);
  return fn({});
}

const { importBot, personaFor } = await loadMarketplaceBots();

const BOT = {
  id: "research-desk",
  name: "Research desk",
  creator: "Titanbot team",
  category: "Featured",
  featured: true,
  tile: { color: "#31b6b8", shape: "circle" },
  description: "Runs a web research pass and comes back with sourced notes.",
  instructions: "You are a research desk. Search before you answer, and cite every claim with the page you read it on.",
  skills: [
    { name: "Web research brief", description: "Search, read, summarise.", body: "---\nname: Web research brief\n---\n\nSearch, read the top results, and write the brief." },
    { name: "Source check", description: "Verify a claim.", body: "---\nname: Source check\n---\n\nFind the primary source for the claim and quote it." },
  ],
  integrations: ["tinyfish"],
};

// A gateway that records what it was asked and answers the way this box's host answers.
function fakeGateway(overrides = {}) {
  const calls = [];
  const agents = [...(overrides.agents ?? [])];
  const workflows = [...(overrides.workflows ?? [])];
  return {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      if (method === "listAgents") return agents.map((a) => ({ ...a }));
      if (method === "createAgent") {
        const agent = { id: overrides.mintedId ?? "agent-new", name: args.name, description: args.description };
        agents.push(agent);
        return { agent };
      }
      if (method === "importAgentWorkflowText") {
        const answer = overrides.importAnswer ? overrides.importAnswer(args) : { result: { imported: [args.name], skipped: [] } };
        for (const name of answer.result?.imported ?? []) workflows.push({ id: `wf-${name}`, name, source: "workflow" });
        return answer;
      }
      if (method === "getAgentWorkflows") return workflows.map((w) => ({ ...w }));
      throw new Error(`unexpected gateway call: ${method}`);
    },
  };
}

test("Import Bot makes the calls in order, with each skill's own text", async () => {
  const gateway = fakeGateway();
  const result = await importBot(gateway, BOT);

  assert.deepEqual(gateway.calls.map((c) => c.method), [
    "listAgents",
    "createAgent",
    "importAgentWorkflowText",
    "importAgentWorkflowText",
    "getAgentWorkflows",
  ]);

  // The agent carries the template's description AND its instructions, because the host has one
  // field for both. Description first, so a reader of the profile sees what the bot is before how
  // it behaves -- and so a gate can assert the description the catalog declares is what landed.
  const created = gateway.calls[1].args;
  assert.equal(created.name, "Research desk");
  assert.ok(created.description.startsWith(BOT.description), created.description.slice(0, 80));
  assert.ok(created.description.includes(BOT.instructions));
  assert.equal(created.description, `${BOT.description}\n\n${BOT.instructions}`);

  // Each skill goes as its own import, in the order the template lists them, carrying that
  // skill's markdown verbatim and its name.
  const imports = gateway.calls.filter((c) => c.method === "importAgentWorkflowText");
  assert.deepEqual(imports.map((c) => c.args.name), ["Web research brief", "Source check"]);
  assert.deepEqual(imports.map((c) => c.args.markdown), BOT.skills.map((s) => s.body));
  assert.ok(imports.every((c) => c.args.id === "agent-new"));

  // The read-back is what the page reports, not the request.
  assert.equal(gateway.calls.at(-1).args.id, "agent-new");
  assert.deepEqual(result.skills, ["Web research brief", "Source check"]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.agent, { id: "agent-new", name: "Research desk", description: created.description });
});

test("importing the same bot twice makes a second agent with ' copy' appended", async () => {
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Research desk" }] });
  await importBot(gateway, BOT);
  assert.equal(gateway.calls[1].args.name, "Research desk copy");

  // And a third time, the way duplicating a duplicate does on the host.
  const again = fakeGateway({ agents: [{ id: "a1", name: "Research desk" }, { id: "a2", name: "Research desk copy" }] });
  await importBot(again, BOT);
  assert.equal(again.calls[1].args.name, "Research desk copy copy");
});

test("a skill the host declined is reported with the host's own reason", async () => {
  const gateway = fakeGateway({
    importAnswer: (args) => (args.name === "Source check"
      ? { result: { imported: [], skipped: [{ source: "Source check", reason: "a workflow with that name is already in the library" }] } }
      : { result: { imported: [args.name], skipped: [] } }),
  });
  const result = await importBot(gateway, BOT);
  assert.deepEqual(result.skills, ["Web research brief"]);
  assert.deepEqual(result.skipped, [{ source: "Source check", reason: "a workflow with that name is already in the library" }]);
});

test("a template skill with no body is skipped without a write", async () => {
  const gateway = fakeGateway();
  const bot = { ...BOT, skills: [BOT.skills[0], { name: "Empty", description: "", body: "   " }] };
  const result = await importBot(gateway, bot);
  assert.equal(gateway.calls.filter((c) => c.method === "importAgentWorkflowText").length, 1);
  assert.deepEqual(result.skipped, [{ source: "Empty", reason: "the template carries no SKILL.md text for it" }]);
});

test("an import the host answered but did not store is reported as missing, not as a success", async () => {
  const gateway = fakeGateway({ importAnswer: (args) => ({ result: { imported: [args.name], skipped: [] } }) });
  // The host answers the import and then holds nothing: the read-back is empty.
  const original = gateway.call.bind(gateway);
  gateway.call = async (method, args) => (method === "getAgentWorkflows" ? [] : original(method, args));
  const result = await importBot(gateway, BOT);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.missing, ["Web research brief", "Source check"]);
});

test("a host that mints an agent with no envelope is found by the roster diff", async () => {
  const gateway = fakeGateway();
  const original = gateway.call.bind(gateway);
  gateway.call = async (method, args) => {
    const answer = await original(method, args);
    return method === "createAgent" ? {} : answer;
  };
  const result = await importBot(gateway, { ...BOT, skills: [] });
  assert.equal(result.agent.id, "agent-new");
  assert.deepEqual(gateway.calls.map((c) => c.method), ["listAgents", "createAgent", "listAgents", "getAgentWorkflows"]);
});

test("personaFor keeps whichever half the template carries", () => {
  assert.equal(personaFor({ description: "d", instructions: "" }), "d");
  assert.equal(personaFor({ description: "", instructions: "i" }), "i");
  assert.equal(personaFor({ description: "d", instructions: "i" }), "d\n\ni");
});

// -- the render half. This file ships as one script with no build, so nothing type-checks it and
// `node --check` only proves it parses: a helper renamed on one side of the page and not the other
// would reach a live console and fail on the click. Render the list, the bot page and each of its
// three tabs against a stub DOM, so a dangling reference fails here instead.
class StubElement {}

function stubTarget(dataset) {
  const el = new StubElement();
  el.dataset = dataset;
  const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  el.closest = (selector) => (dataset[camel(/^\[data-([a-z-]+)/.exec(selector)[1])] === undefined ? null : el);
  el.hasAttribute = (name) => dataset[camel(name.replace(/^data-/, ""))] !== undefined;
  return el;
}

function stubContainer() {
  const listeners = new Map();
  return {
    innerHTML: "",
    dataset: {},
    ownerDocument: { activeElement: null },
    querySelector: () => null,
    addEventListener(type, fn) { listeners.set(type, fn); },
    click(dataset) { listeners.get("click")({ target: stubTarget(dataset) }); },
  };
}

async function renderedTab(extraWindow = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/marketplace-bots.js"), "utf8");
  const catalog = {
    plugins: [{ id: "tinyfish", name: "TinyFish (API key)", tagline: "Web search and browser automation.", kind: "connector", connectorName: "tinyfish", install: { command: "npx", args: [], env: { TINYFISH_API_KEY: "" } } }],
    bots: [BOT, { id: "ops-watcher", name: "Ops watcher", creator: "Titanbot team", category: "Operations", description: "Watches a Slack channel.", instructions: "Watch.", skills: [], integrations: [], tile: { color: "#e7a23c", shape: "square" } }],
    categories: { bots: ["Featured", "Operations"] },
  };
  const win = {
    Element: StubElement,
    __machineRoomLive: true,
    async fetch(url, init) {
      const route = String(url);
      if (route === "/connectors") return { ok: true, json: async () => ({ mcpServers: {} }) };
      const args = init && init.body ? JSON.parse(init.body) : {};
      const body = route === "/api/listMarketplace" ? catalog
        : route === "/api/listShellTools" ? []
          : route === "/api/listAgents" ? []
            : route === "/api/createAgent" ? { agent: { id: "agent-new", name: args.name, description: args.description } }
              : route === "/api/importAgentWorkflowText" ? { result: { imported: [args.name], skipped: [] } }
                : route === "/api/getAgentWorkflows" ? BOT.skills.map((s) => ({ id: `wf-${s.name}`, name: s.name, source: "workflow" }))
                  : {};
      return { ok: true, text: async () => JSON.stringify(body) };
    },
    ...extraWindow,
  };
  const bots = new Function("window", `${source}\nreturn window.__marketplaceBots;`)(win);
  await bots.reload();
  const container = stubContainer();
  bots.render(container);
  return { bots, container, win };
}

test("the Bots tab renders a card per template, and the bot page renders each of its three tabs", async () => {
  const { container } = await renderedTab();
  assert.match(container.innerHTML, /data-marketplace-bots/);
  assert.match(container.innerHTML, /data-bot-id="research-desk"/);
  assert.match(container.innerHTML, /data-bot-id="ops-watcher"/);
  // Featured leads, and a featured bot is not also stranded in a "More" section.
  assert.ok(!container.innerHTML.includes("<span>More</span>"), container.innerHTML.slice(0, 200));

  container.click({ botId: "research-desk" });
  assert.match(container.innerHTML, /data-bot-page="research-desk"/);
  assert.match(container.innerHTML, /data-import-bot="research-desk"/);
  for (const tab of ["instructions", "skills", "integrations"]) assert.match(container.innerHTML, new RegExp(`data-bot-tab="${tab}"`));
  assert.ok(container.innerHTML.includes(BOT.instructions), "the Instructions tab shows the persona the import will write");

  container.click({ botTab: "skills" });
  for (const skill of BOT.skills) assert.ok(container.innerHTML.includes(skill.name), skill.name);

  // Nothing is installed in this stub's connectors.json, so the one integration offers Add.
  container.click({ botTab: "integrations" });
  assert.match(container.innerHTML, /data-integration="tinyfish"/);
  assert.match(container.innerHTML, /data-add-integration="tinyfish"/);

  container.click({ botsBack: "" });
  assert.match(container.innerHTML, /data-bot-id="research-desk"/);
  assert.ok(!container.innerHTML.includes("data-bot-page"));
});

// The card the whole tab exists to show. `adapter.refresh()` is a serial reload of the trays, the
// roster, the live model and the transcript, and `refreshInstalled()` is another round trip to the
// box; painting only after those two is what left the gate's 20 s poll with "no imported card on
// screen". So the paint happens the moment the import returns, and this pins it by never letting
// the refresh resolve.
test("the imported agent is on screen before the refreshes behind it return", async () => {
  let refreshStarted;
  const refreshWasCalled = new Promise((resolve) => { refreshStarted = resolve; });
  const { container } = await renderedTab({
    __machineRoomAdapter: {
      refresh() { refreshStarted(); return new Promise(() => {}); },
    },
  });

  container.click({ botId: "research-desk" });
  container.click({ importBot: "research-desk" });
  await refreshWasCalled;

  assert.match(container.innerHTML, /data-imported-agent="agent-new"/);
  assert.ok(container.innerHTML.includes("Imported as"), container.innerHTML.slice(0, 200));
  for (const skill of BOT.skills) assert.ok(container.innerHTML.includes(skill.name), skill.name);
});

// With the Integrations tab open, the tab's own rows are already above the imported card, so a
// "Still needed" block there would draw each row -- and its Add button -- a second time.
test("the imported card does not draw the integration rows a second time", async () => {
  let refreshStarted;
  const refreshWasCalled = new Promise((resolve) => { refreshStarted = resolve; });
  const { container } = await renderedTab({
    __machineRoomAdapter: {
      refresh() { refreshStarted(); return new Promise(() => {}); },
    },
  });

  container.click({ botId: "research-desk" });
  container.click({ botTab: "integrations" });
  container.click({ importBot: "research-desk" });
  await refreshWasCalled;

  assert.match(container.innerHTML, /data-imported-agent="agent-new"/);
  const rows = container.innerHTML.match(/data-integration="tinyfish"/g) ?? [];
  assert.equal(rows.length, 1, container.innerHTML.slice(-400));
  assert.equal((container.innerHTML.match(/data-add-integration="tinyfish"/g) ?? []).length, 1);
});
