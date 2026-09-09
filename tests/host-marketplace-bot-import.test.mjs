// TITAN-CATALOG-1 — the catalog import, now that it lives in the host.
//
// NOT to be confused with tests/marketplace-bot-import.test.mjs, which is BOTS-4's and pins the
// Bots tab page's own `importBot`. This one pins the gateway verb behind
// source/host/extensions/marketplace/marketplace-bot-import.ts.
//
// The eight-step sequence used to be ui/machine-room/bot-setup.js and tests/bot-setup.test.mjs
// pinned its order against a fake gateway. The sequence moved into the box so the console's Add and
// Titan's request are two doors onto one import; the order came with it, and so did the pinning.
// Most of what follows is that suite, driven against the host module instead of the browser one.
//
// Three cases are here that were NOT there before, and they are the reason this file is not a
// straight copy:
//
//   A REAL CATALOG ROW DRIVES THE APP CASE. The console read `row.pluginId` and `row.description`;
//   a catalog app row carries `plugin` and `line`. Every app on every generated row therefore fell
//   into the add-your-own bucket, and the receipt told a customer that Slack "is not something we
//   carry yet". It was green in the old suite because the fixture there was hand-written in the
//   report's internal vocabulary rather than the catalog's row shape. So the case below is fed
//   findMarketplaceBot("account-book") straight out of the bundled catalog, where a fixture cannot
//   drift from the data.
//
//   INSTALLED STATE IS ASKED FOR, NOT ACCEPTED. `installedPluginIds` was an option no caller in the
//   product ever passed, so `connected` was empty on every box. The verb takes no such argument and
//   asks the box; the case checks that it asked, and asked once per plugin rather than once per app.
//
//   THE PERSONA COMPOSITION IS PINNED ACROSS THE TWO LANGUAGES. The host composes the agent's one
//   identity field now, and the Bots tab still composes the same thing for its own page. This
//   loads marketplace-bots.js into a stub window and asserts the two agree, because that is the
//   drift a TypeScript module and a browser file cannot catch for each other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hostMarketplaceImport as importer, marketplaceCatalog as catalog } from "./helpers/host-marketplace-import.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ------------------------------------------------------------------ the fixture
//
// A community row as the generator writes one: memories split into cap-sized facts, skills with a
// one-line description and no body, one routine with a real cron, one that waits on an event, and
// apps of all three kinds — in the catalog's OWN vocabulary, `plugin` and `line`.
const theBot = Object.freeze({
  id: "seo-desk",
  name: "SEO Desk",
  creator: "Ada Vance",
  category: "Marketing",
  description: "Keeps the search brief current and tells you what moved.",
  instructions: "You keep the search brief current for one team.",
  memories: [
    { text: "You keep the search brief current for one team.", facts: ["You keep the search brief current for one team."] },
    { text: "Long paragraph split at sentence boundaries.", facts: ["Publish nothing without a human read.", "Name the source of every number you quote."] },
  ],
  skills: [
    { name: "Question map", description: "Use when the team needs the questions buyers actually ask.", body: "" },
    { name: "Brief refresh", description: "Use when a brief is more than a month old.", body: "# Brief refresh\n\nDo the thing.\n" },
  ],
  routines: [
    { name: "Weekly brief sweep", summary: "Once a week, reread the briefs and flag the stale ones.", schedule: "0 9 * * 1", scheduleNote: "Once a week, Monday at 9am on this box's clock." },
    { name: "Ranking watch", summary: "Watches for a ranking drop and says so.", schedule: null },
    { name: "Daily digest", summary: "Each weekday morning, write the digest.", schedule: "0 9 * * 1-5", scheduleNote: "Each weekday at 9am on this box's clock." },
  ],
  integrations: ["notion", "slack"],
  apps: [
    { name: "notion-workspace", label: "Notion", line: "Keep the ideas board and briefs where the team already writes.", plugin: "notion", offer: "connect" },
    { name: "slack", label: "Slack", line: "Post the digest where people read it.", plugin: "slack", offer: "connect" },
    { name: "X", label: "X", line: "Read what people are asking.", plugin: null, offer: "page" },
    { name: "Profound", label: "Profound", line: "Pull the answer-engine numbers.", plugin: null, offer: "byo" },
  ],
});

/**
 * A box with a roster, a shared library, routines and a memory store, recording every call in
 * order. The method names are the host doors the import goes through, which is what the order
 * assertions read.
 */
function fakeBox({ agents = [], library = [], installed = [] } = {}) {
  const calls = [];
  const roster = agents.map((name, index) => ({ id: `a${index}`, name }));
  const shared = library.map((name, index) => ({ id: `w${index}`, name, source: "workflow" }));
  const memories = new Map();
  const automations = new Map();
  const probed = [];
  let next = roster.length;
  const record = (method, args) => { calls.push({ method, args }); };
  return {
    calls, roster, shared, memories, automations, probed,
    methods: () => calls.map((call) => call.method),
    argsFor(method) { return calls.filter((call) => call.method === method).map((call) => call.args); },

    async listAgents() { record("listAgents", {}); return roster.map((agent) => ({ ...agent })); },
    async createAgent(args) {
      record("createAgent", args);
      const agent = { id: `a${next += 1}`, name: args.name, description: args.description };
      roster.push(agent);
      memories.set(agent.id, []);
      automations.set(agent.id, []);
      return { agent };
    },
    async deleteAgent(id) {
      record("deleteAgent", { id });
      const at = roster.findIndex((agent) => agent.id === id);
      if (at >= 0) roster.splice(at, 1);
      memories.delete(id);
      automations.delete(id);
      return { ok: true };
    },
    async addAgentMemories(id, seeds) {
      record("addAgentMemories", { id, memories: seeds });
      const held = memories.get(id) ?? [];
      const added = [];
      const rejected = [];
      for (const raw of seeds) {
        const value = String(raw).replace(/\s+/g, " ").trim();
        // The store's own rule, in one line: over the cap it is refused, never shortened.
        if (value.length > 500) { rejected.push({ text: value, why: "too long" }); continue; }
        if (held.some((row) => row.content === value)) continue;
        held.push({ id: `m${held.length}`, content: value, createdAt: 1, kind: "log" });
        added.push(value);
      }
      memories.set(id, held);
      return { added, duplicates: seeds.length - added.length - rejected.length, rejected };
    },
    async getAgentMemories(id) { record("getAgentMemories", { id }); return (memories.get(id) ?? []).map((row) => ({ ...row })); },
    async getAgentWorkflows(id) { record("getAgentWorkflows", { id }); return shared.map((row) => ({ ...row })); },
    async importAgentWorkflowText(id, markdown, name) {
      record("importAgentWorkflowText", { id, markdown, name });
      shared.push({ id: name, name, source: "workflow" });
      return { result: { imported: [name], skipped: [] } };
    },
    async deleteAgentWorkflow(id, workflowId) {
      record("deleteAgentWorkflow", { id, workflowId });
      const at = shared.findIndex((row) => row.id === workflowId);
      if (at >= 0) shared.splice(at, 1);
      return { ok: true };
    },
    async createAgentAutomation(id, spec) {
      record("createAgentAutomation", { id, spec });
      const held = automations.get(id) ?? [];
      held.push({ id: `r${held.length}`, name: spec.name, prompt: spec.prompt, trigger: spec.trigger, isEnabled: spec.isEnabled === true });
      automations.set(id, held);
      return { ok: true };
    },
    async getAgentAutomations(id) { record("getAgentAutomations", { id }); return (automations.get(id) ?? []).map((row) => ({ ...row })); },
    async kickstartAgent(id) { record("kickstartAgent", { id }); return { isIntroductionInFlight: true }; },
    // Never a real probe in a test: a machine that happens to carry a binary on its PATH must not
    // decide the assertion.
    async isPluginInstalled(pluginId) { probed.push(pluginId); return installed.includes(pluginId); },
  };
}

/**
 * Run the import for a fixture row. The public verb takes a catalog id and resolves the row itself
 * against a deep-frozen list, which no test can put a row into, so the fixture cases drive the
 * sequence directly. The lookup that sits in front of it is one line and is pinned on its own,
 * below, against the real catalog.
 */
const importFixture = (box, row, request = {}) => importer.setUpMarketplaceBot(box, row, request);

const WRITES = ["createAgent", "addAgentMemories", "importAgentWorkflowText", "createAgentAutomation", "deleteAgent", "deleteAgentWorkflow", "kickstartAgent"];

// ------------------------------------------------------------------ 1. the order

test("the order is roster, mint, memories, one library read, playbooks, jobs, then the introduction", async () => {
  const box = fakeBox({ agents: ["Titan"] });
  const report = await importFixture(box, theBot);
  assert.equal(report.state, "done", report.message);
  const methods = box.methods();

  assert.equal(methods[0], "listAgents", "the roster was not read first");
  assert.equal(methods[1], "createAgent");
  assert.equal(methods[2], "addAgentMemories");

  const firstImport = methods.indexOf("importAgentWorkflowText");
  const libraryRead = methods.indexOf("getAgentWorkflows");
  assert.ok(libraryRead >= 0 && libraryRead < firstImport, "the library was not read before the first import");
  assert.equal(methods.slice(0, firstImport).filter((m) => m === "getAgentWorkflows").length, 1,
    "the library was read more than once before the first write");

  const specs = box.argsFor("createAgentAutomation").map((args) => args.spec);
  assert.deepEqual(specs.map((spec) => spec.name), ["Weekly brief sweep", "Daily digest"]);
  for (const spec of specs) {
    assert.equal(spec.isEnabled, false, "a job was created switched on");
    assert.deepEqual(Object.keys(spec.trigger), ["type", "schedule"]);
    assert.equal(spec.trigger.type, "cron");
  }
  assert.deepEqual(specs.map((spec) => spec.trigger.schedule), ["0 9 * * 1", "0 9 * * 1-5"]);

  assert.equal(methods[methods.length - 1], "kickstartAgent");
  assert.equal(methods.filter((m) => m === "kickstartAgent").length, 1);
  const kickstartAt = methods.lastIndexOf("kickstartAgent");
  for (const [at, method] of methods.entries()) {
    if (method === "kickstartAgent") continue;
    assert.ok(!(WRITES.includes(method) && at > kickstartAt), `${method} ran after the introduction`);
  }
});

test("the agent is minted with the introduction held back, never with kickstart requested", async () => {
  const box = fakeBox();
  await importFixture(box, theBot);
  const [args] = box.argsFor("createAgent");
  assert.equal(args.isKickstartRequested, false);
  assert.equal(args.name, "SEO Desk");
  // One identity field: the description, composed the way the console has always composed it.
  assert.equal(args.description, "Keeps the search brief current and tells you what moved.\n\nYou keep the search brief current for one team.");
});

test("the identity the host composes is the one the Bots tab draws, in both languages", () => {
  // The composition rule now lives in TypeScript and the page still has its own for the bot page.
  // Two copies of one rule in two languages drift silently, so they are pinned against each other.
  const win = { fetch: async () => { throw new Error("no network"); }, Element: class {}, document: null, __machineRoomLive: true };
  const page = readFileSync(path.join(repoRoot, "ui/machine-room/marketplace-bots.js"), "utf8");
  new Function("window", page)(win);
  assert.equal(typeof win.__marketplaceBots.personaFor, "function");
  assert.equal(importer.personaFor(theBot), win.__marketplaceBots.personaFor(theBot));
  const noInstructions = { ...theBot, instructions: "" };
  assert.equal(importer.personaFor(noInstructions), win.__marketplaceBots.personaFor(noInstructions));
});

test("every fact the row carries is seeded, split as the generator split it", async () => {
  const box = fakeBox();
  await importFixture(box, theBot);
  const [args] = box.argsFor("addAgentMemories");
  assert.deepEqual(args.memories, [
    "You keep the search brief current for one team.",
    "Publish nothing without a human read.",
    "Name the source of every number you quote.",
  ]);
  assert.equal(box.memories.get(box.roster[0].id).length, 3);
});

test("a memory the row never split is seeded as its own paragraph", async () => {
  const box = fakeBox();
  await importFixture(box, { ...theBot, memories: [{ text: "One whole paragraph." }] });
  assert.deepEqual(box.argsFor("addAgentMemories")[0].memories, ["One whole paragraph."]);
});

// ------------------------------------------------------------------ 2. the second call

test("a second import says it already exists and writes nothing at all", async () => {
  const box = fakeBox();
  const first = await importFixture(box, theBot);
  assert.equal(first.state, "done", first.message);
  const after = { agents: box.roster.length, skills: box.shared.length };

  box.calls.length = 0;
  const second = await importFixture(box, theBot);
  assert.equal(second.state, "already");
  assert.equal(second.alreadyExisted, true);
  assert.equal(second.agent.name, "SEO Desk");
  assert.match(second.message, /already on your roster/);
  assert.deepEqual(box.methods(), ["listAgents"], "a second import did more than read the roster");
  assert.equal(box.roster.length, after.agents, "a second import made another bot");
  assert.equal(box.shared.length, after.skills, "a second import wrote another playbook");
  assert.ok(!box.roster.some((agent) => / copy$/.test(agent.name)));
});

test("a deliberate second copy is still reachable, and only behind that flag", async () => {
  const box = fakeBox();
  await importFixture(box, theBot);
  const copy = await importFixture(box, theBot, { duplicate: true });
  assert.equal(copy.state, "done", copy.message);
  assert.equal(copy.agent.name, "SEO Desk copy");
  assert.equal(copy.name, "SEO Desk copy");
  assert.equal(box.roster.length, 2);
});

test("a name of the operator's choosing replaces the row's, and is what the roster check reads", async () => {
  const box = fakeBox({ agents: ["Search desk"] });
  const report = await importFixture(box, theBot, { name: "Search desk" });
  assert.equal(report.state, "already");
  assert.equal(report.name, "Search desk");
  const fresh = fakeBox();
  const made = await importFixture(fresh, theBot, { name: "Search desk" });
  assert.equal(made.agent.name, "Search desk");
  assert.equal(fresh.argsFor("createAgent")[0].name, "Search desk");
});

// ------------------------------------------------------------------ 3. jobs that are not clocks

test("a job with no schedule never reaches the box and is named with its reason", async () => {
  const box = fakeBox();
  const report = await importFixture(box, theBot);
  assert.deepEqual(report.routines.created.map((row) => row.name), ["Weekly brief sweep", "Daily digest"]);
  assert.deepEqual(report.routines.notCreated.map((row) => row.name), ["Ranking watch"]);
  assert.match(report.routines.notCreated[0].why, /waits on something happening rather than on a clock/);
  assert.ok(!box.argsFor("createAgentAutomation").some((args) => args.spec.name === "Ranking watch"));
});

test("a cadence word is not a schedule, because the host stores it and never runs it", async () => {
  assert.equal(importer.cronOf({ schedule: "weekly" }), "");
  assert.equal(importer.cronOf({ schedule: "every Monday" }), "");
  assert.equal(importer.cronOf({ schedule: "0 9 * * 1" }), "0 9 * * 1");
  assert.equal(importer.cronOf({ schedule: "" }), "");
  assert.equal(importer.cronOf({}), "");
  const box = fakeBox();
  const report = await importFixture(box, {
    ...theBot,
    routines: [{ name: "Weekly thing", summary: "Runs weekly.", schedule: "weekly" }],
  });
  assert.equal(box.argsFor("createAgentAutomation").length, 0);
  assert.match(report.routines.notCreated[0].why, /not a clock this box can hold/);
});

test("a job the box takes and does not list is reported as not created", async () => {
  const box = fakeBox();
  box.createAgentAutomation = async (id, spec) => { box.calls.push({ method: "createAgentAutomation", args: { id, spec } }); return { ok: true }; };
  const report = await importFixture(box, theBot);
  assert.equal(report.state, "done");
  assert.deepEqual(report.routines.created, []);
  assert.equal(report.routines.notCreated.length, 3);
  assert.ok(report.routines.notCreated.some((row) => /is not listing the job/.test(row.why)));
});

// ------------------------------------------------------------------ 4. the shared library

test("a playbook the box already holds is reused rather than written a second time", async () => {
  const box = fakeBox({ library: ["seo-desk-question-map"] });
  const report = await importFixture(box, theBot);
  assert.deepEqual(report.skills.reused, ["seo-desk-question-map"]);
  assert.deepEqual(report.skills.imported, ["seo-desk-brief-refresh"]);
  assert.deepEqual(box.argsFor("importAgentWorkflowText").map((args) => args.name), ["seo-desk-brief-refresh"]);
  assert.equal(box.shared.length, 2, "the library grew a double");
});

test("playbooks are namespaced by the bot, so a stranger's document is never adopted", () => {
  assert.equal(importer.skillNameFor(theBot, { name: "Question map" }), "seo-desk-question-map");
  assert.equal(importer.skillNameFor({ id: "site-audit" }, { name: "Crawl & report" }), "site-audit-crawl-report");
  assert.equal(importer.skillNameFor({ id: "x", packaging: { skillPrefix: "marketing-" } }, { name: "Plan" }), "marketing-plan");
});

test("the name the box will file a document under is the one in its frontmatter", () => {
  // MEASURED on grok-bot-local-vm 2026-09-09: the `name` argument to importAgentWorkflowText is not
  // what the box stores. It reads the name out of the document's own YAML frontmatter, so a
  // namespace that lives only in the argument is decoration and a second import doubles everything.
  assert.equal(importer.frontmatterName("---\nname: mkt-brand-northgate\ndescription: x\n---\n# Brand"), "mkt-brand-northgate");
  assert.equal(importer.frontmatterName('---\nname: "quoted-name"\n---\n'), "quoted-name");
  assert.equal(importer.frontmatterName("# no frontmatter"), "");
  const authored = { name: "Plan the week", body: "---\nname: mkt-strategist-plan-the-week\n---\n# Plan\n" };
  assert.equal(importer.skillNameFor(theBot, authored), "mkt-strategist-plan-the-week");
  assert.equal(importer.skillBody(theBot, authored), authored.body, "an authored document was rewritten");
});

test("a playbook with no body gets one written from its description, and the document says so", () => {
  const body = importer.skillBody(theBot, theBot.skills[0]);
  assert.ok(body.startsWith("---\nname: seo-desk-question-map\n"), body.slice(0, 80));
  assert.match(body, /# Question map/);
  assert.match(body, /Use when the team needs the questions buyers actually ask\./);
  assert.match(body, /written from a one-line summary/);
  assert.equal(importer.frontmatterName(body), importer.skillNameFor(theBot, theBot.skills[0]));
  const tricky = importer.skillBody(theBot, { name: "Odd", description: 'Use when: a "quote" appears.' });
  assert.match(tricky, /description: "Use when: a \\"quote\\" appears\."/);
  assert.equal(importer.frontmatterName(tricky), "seo-desk-odd");
});

test("a body with no frontmatter is named without its text being touched", () => {
  const body = importer.skillBody(theBot, theBot.skills[1]);
  assert.equal(importer.frontmatterName(body), "seo-desk-brief-refresh");
  assert.ok(body.endsWith("# Brief refresh\n\nDo the thing.\n"), JSON.stringify(body));
});

test("a playbook the box declines is named with the box's own reason", async () => {
  const box = fakeBox();
  const real = box.importAgentWorkflowText.bind(box);
  box.importAgentWorkflowText = async (id, markdown, name) => {
    if (name !== "seo-desk-question-map") return real(id, markdown, name);
    box.calls.push({ method: "importAgentWorkflowText", args: { id, markdown, name } });
    return { result: { imported: [], skipped: [{ source: name, reason: "a document by that name is already here" }] } };
  };
  const report = await importFixture(box, theBot);
  assert.equal(report.state, "done", report.message);
  assert.ok(report.skills.skipped.some((row) => /already here/.test(row.reason)));
});

test("one agent refusing the library read does not read as an empty library", async () => {
  // Measured on grok-bot-local-vm 2026-09-09 during the team import: the library was read through
  // one agent, that agent stopped answering, and the read came back empty on a box holding 55 rows.
  const box = fakeBox({ agents: ["Sulky"], library: ["seo-desk-question-map", "seo-desk-brief-refresh"] });
  const real = box.getAgentWorkflows.bind(box);
  box.getAgentWorkflows = async (id) => {
    if (id === "a0") return real(id);
    box.calls.push({ method: "getAgentWorkflows", args: { id } });
    throw new Error("that agent is busy");
  };
  const report = await importFixture(box, theBot);
  assert.equal(report.state, "done", report.message);
  assert.deepEqual(box.argsFor("importAgentWorkflowText"), [], "the import wrote documents the box already held");
  assert.equal(box.shared.length, 2);
});

// ------------------------------------------------------------------ 5. the rollback

test("a failure part way takes back the bot and this run's playbooks, and nothing it found", async () => {
  const box = fakeBox({ agents: ["Titan"], library: ["web-research-pass", "web-research-pass-2"] });
  const before = { agents: box.roster.map((a) => a.name), skills: box.shared.map((row) => row.name) };
  const real = box.createAgentAutomation.bind(box);
  let jobs = 0;
  box.createAgentAutomation = async (id, spec) => {
    if ((jobs += 1) === 2) { box.calls.push({ method: "createAgentAutomation", args: { id, spec } }); throw new Error("the host refused the trigger"); }
    return real(id, spec);
  };
  const report = await importFixture(box, theBot);
  assert.equal(report.state, "failed");
  assert.match(report.message, /refused the trigger/);
  assert.match(report.message, /taken back/);
  assert.deepEqual(box.roster.map((a) => a.name), before.agents, "a failed import left a bot behind");
  assert.deepEqual(box.shared.map((row) => row.name), before.skills, "a failed import left playbooks behind");
  assert.ok(!box.methods().includes("kickstartAgent"), "a failed import still asked for an introduction");
});

test("a rollback does not touch a document the run merely reused", async () => {
  const box = fakeBox({ library: ["seo-desk-question-map", "web-research-pass"] });
  box.createAgentAutomation = async () => { throw new Error("no"); };
  await importFixture(box, theBot);
  assert.deepEqual(box.shared.map((row) => row.name).sort(), ["seo-desk-question-map", "web-research-pass"]);
  assert.equal(box.roster.length, 0);
});

// ------------------------------------------------------------------ 6. what it reports

test("the report is what the box holds, read back, and never what was asked for", async () => {
  const box = fakeBox();
  const report = await importFixture(box, theBot);
  const methods = box.methods();
  for (const read of ["getAgentMemories", "getAgentWorkflows", "getAgentAutomations"]) {
    assert.ok(methods.includes(read), `${read} was never read back`);
  }
  assert.equal(report.memories.added, 3);
  assert.equal(report.memories.rejected.length, 0);
  assert.deepEqual(report.skills.imported.slice().sort(), ["seo-desk-brief-refresh", "seo-desk-question-map"]);
  for (const routine of report.routines.created) assert.equal(routine.isEnabled, false);
  assert.equal(report.agentId, report.agent.id);
  assert.equal(report.alreadyExisted, false);
});

test("whether the box started the bot's own first message is reported, never assumed", async () => {
  // BOX-7 is measured: some boxes start no introduction for ANY new agent and say so by answering
  // false, and the agent then sits in an empty conversation. A caller waiting for words has to be
  // able to tell a box that declined from a box that is merely slow.
  const willing = fakeBox();
  const started = await importFixture(willing, theBot);
  assert.deepEqual(started.introduction, { started: true });

  const declines = fakeBox();
  declines.kickstartAgent = async (id) => { declines.calls.push({ method: "kickstartAgent", args: { id } }); return { isIntroductionInFlight: false }; };
  const quiet = await importFixture(declines, theBot);
  assert.equal(quiet.state, "done", quiet.message);
  assert.deepEqual(quiet.introduction, { started: false });

  // A box that throws on the ask is still an import that worked; the bot is on the roster either way.
  const broken = fakeBox();
  broken.kickstartAgent = async () => { throw new Error("no runner"); };
  const anyway = await importFixture(broken, theBot);
  assert.equal(anyway.state, "done", anyway.message);
  assert.deepEqual(anyway.introduction, { started: false });
});

test("a fact the host refused is carried into the report rather than counted as stored", async () => {
  const long = `${"a".repeat(600)}.`;
  const box = fakeBox();
  const report = await importFixture(box, {
    ...theBot,
    memories: [{ text: long, facts: [long] }, { text: "Short.", facts: ["Short."] }],
  });
  assert.equal(report.memories.added, 1);
  assert.equal(report.memories.rejected.length, 1);
  assert.match(report.message, /too long to store/);
  assert.match(report.message, /rather than cut short/);
});

// ------------------------------------------------------------------ 7. the apps, off a real row

test("the apps split four ways off the catalog's own field names, and an installed one is not offered again", () => {
  const plan = importer.planApps(theBot, ["notion"]);
  assert.deepEqual(plan.connected.map((a) => a.label), ["Notion"]);
  assert.deepEqual(plan.addable.map((a) => a.label), ["Slack"]);
  assert.deepEqual(plan.informational.map((a) => a.label), ["X"], "a row that installs nothing was offered an Add");
  assert.deepEqual(plan.byo.map((a) => a.label), ["Profound"]);
  assert.equal(plan.connected[0].description, "Keep the ideas board and briefs where the team already writes.");
  // A row from before the apps field falls back to its plugin ids, so the first-party bots still
  // report their integrations rather than nothing.
  const old = importer.planApps({ integrations: ["github", "slack"] }, ["github"]);
  assert.deepEqual(old.connected.map((a) => a.label), ["github"]);
  assert.deepEqual(old.addable.map((a) => a.label), ["slack"]);
  // And the pre-BOTS-4 spelling still resolves, so a host serving older rows is not broken by this.
  const legacy = importer.planApps({ apps: [{ name: "slack", label: "Slack", description: "Post it.", pluginId: "slack", offer: "connect" }] }, []);
  assert.deepEqual(legacy.addable.map((a) => a.label), ["Slack"]);
  assert.equal(legacy.addable[0].description, "Post it.");
  // A row whose own sentence was written by another bot first carries it under `fallbackLine`.
  const shared = importer.planApps({ apps: [{ name: "Gmail", label: "Gmail", line: "", fallbackLine: "Read and send from the address you already use.", plugin: "google", offer: "connect" }] }, []);
  assert.equal(shared.addable[0].description, "Read and send from the address you already use.");
});

test("a REAL catalog row never reports an app we carry as one we do not", () => {
  // THE CASE THAT WOULD HAVE CAUGHT THE DEFECT. Measured against the live host's own answer for
  // this row on grok-bot-local-vm 2026-09-09: all 11 of its apps landed in the add-your-own bucket,
  // Slack, Notion, Linear and Gmail included, because the console read `pluginId`/`description` and
  // the row carries `plugin`/`line`. No fixture here: the row comes out of the bundled catalog.
  const row = catalog.findMarketplaceBot("account-book");
  assert.ok(row != null, "the catalog no longer carries account-book; pick another row with apps");
  const named = new Map(row.apps.map((app) => [app.label, app]));
  assert.ok(named.has("Slack") && named.has("Notion") && named.has("Linear"), "this row lost the apps the case is about");

  const nothingInstalled = importer.planApps(row, []);
  const offered = new Set(nothingInstalled.addable.map((a) => a.label));
  const unavailable = new Set(nothingInstalled.byo.map((a) => a.label));
  for (const label of ["Slack", "Notion", "Linear", "Gmail"]) {
    assert.ok(offered.has(label), `${label} was not offered on a box that could add it`);
    assert.ok(!unavailable.has(label), `${label} was reported as something we do not carry`);
  }
  // Each app carries the bot's OWN sentence about it, not an empty string. Some rows carry an empty
  // `line` and the shared sentence under `fallbackLine` — measured on this row, Gmail and Google
  // Calendar are two of them — so a reader that stops at `line` hands a person an app name with
  // nothing under it.
  assert.equal(nothingInstalled.addable.find((a) => a.label === "Slack").description, named.get("Slack").line);
  for (const app of [...nothingInstalled.addable, ...nothingInstalled.connected, ...nothingInstalled.byo]) {
    const row = named.get(app.label);
    if (!row) continue;
    if (!row.line && !row.fallbackLine) continue;
    assert.ok(app.description.length > 0, `${app.label} came back with no sentence under it`);
    assert.equal(app.description, row.line || row.fallbackLine);
  }

  // And a box that already holds Slack says so instead of offering it again.
  const withSlack = importer.planApps(row, ["slack"]);
  assert.deepEqual(withSlack.connected.map((a) => a.label), ["Slack"]);
  assert.ok(!withSlack.addable.some((a) => a.label === "Slack"));
  // Hex and Databricks SQL carry no plugin at all, so they stay honestly in the add-your-own door.
  assert.ok(withSlack.byo.some((a) => a.label === "Hex"));
});

test("installed state is asked of the box, once per plugin, and is never an argument", async () => {
  const box = fakeBox({ installed: ["slack"] });
  const report = await importFixture(box, theBot);
  // Two apps name a plugin; the other two name none, so exactly two questions were asked.
  assert.deepEqual(box.probed.slice().sort(), ["notion", "slack"]);
  assert.deepEqual(report.apps.connected.map((a) => a.label), ["Slack"]);
  assert.deepEqual(report.integrations.connected, ["Slack"]);
  assert.deepEqual(report.integrations.offered, ["Notion"]);
  assert.deepEqual(report.integrations.unavailable, ["Profound"]);
  assert.deepEqual(report.integrations.informational, ["X"]);
  assert.ok(!/still need connecting: Slack|Slack still need/.test(report.message), "an app the box carries was reported as missing");
});

test("a probe that throws leaves the import standing and the app merely unconnected", async () => {
  const box = fakeBox();
  box.isPluginInstalled = async () => { throw new Error("the shell is busy"); };
  const report = await importFixture(box, theBot);
  assert.equal(report.state, "done", report.message);
  assert.deepEqual(report.integrations.connected, []);
  assert.deepEqual(report.integrations.offered, ["Notion", "Slack"]);
});

test("the message is one plain sentence a person reads, with no tool or field names in it", async () => {
  const box = fakeBox({ installed: ["notion"] });
  const report = await importFixture(box, theBot);
  assert.match(report.message, /^SEO Desk is on your roster with 3 facts it now remembers, 2 playbooks, 2 jobs that stay switched off until you turn them on\./);
  assert.match(report.message, /Slack still need connecting/);
  assert.match(report.message, /Profound is not something we carry yet/);
  assert.match(report.message, /1 job could not be set up/);
  for (const word of ["createAgent", "importAgentWorkflowText", "createAgentAutomation", "addAgentMemories", "kickstartAgent", "gateway", "plugin", "cron"]) {
    assert.ok(!report.message.includes(word), `the message says "${word}" at a person`);
  }
  assert.ok(!/Grok|Cursor|xAI|x\.ai/i.test(report.message), "the message names the old vendor");
});

// ------------------------------------------------------------------ 8. the plan

test("the plan says what an import would do, with nothing written and no box to ask", () => {
  const plan = importer.planFor(theBot, ["notion"]);
  assert.equal(plan.name, "SEO Desk");
  assert.deepEqual(plan.memories, { paragraphs: 2, facts: 3 });
  assert.deepEqual(plan.skills.map((row) => row.as), ["seo-desk-question-map", "seo-desk-brief-refresh"]);
  assert.deepEqual(plan.routines.create.map((row) => row.name), ["Weekly brief sweep", "Daily digest"]);
  assert.deepEqual(plan.routines.skip.map((row) => row.name), ["Ranking watch"]);
  assert.deepEqual(plan.apps.addable.map((a) => a.label), ["Slack"]);
  assert.equal(plan.description, importer.personaFor(theBot));
});

test("the plan and the import agree about what would be created", async () => {
  // A plan a page shows that does not match what the press does is worse than no plan.
  const box = fakeBox();
  const plan = importer.planFor(theBot, []);
  const report = await importFixture(box, theBot);
  assert.deepEqual(report.routines.created.map((row) => row.name), plan.routines.create.map((row) => row.name));
  assert.deepEqual(report.routines.notCreated.map((row) => row.name), plan.routines.skip.map((row) => row.name));
  assert.deepEqual([...report.skills.imported, ...report.skills.reused].sort(), plan.skills.map((row) => row.as).sort());
  assert.equal(report.memories.added, plan.memories.facts);
  assert.deepEqual(report.apps, plan.apps);
});

// ------------------------------------------------------------------ 9. rows that carry nothing

test("a row with no memories, playbooks or jobs still becomes an agent", async () => {
  const box = fakeBox();
  const report = await importFixture(box, { id: "plain", name: "Plain", description: "Does one thing.", instructions: "", skills: [], integrations: [] });
  assert.equal(report.state, "done", report.message);
  assert.equal(box.argsFor("addAgentMemories").length, 0, "an empty seed was sent anyway");
  assert.equal(box.argsFor("importAgentWorkflowText").length, 0);
  assert.equal(box.argsFor("createAgentAutomation").length, 0);
  assert.equal(report.message, "Plain is on your roster.");
  assert.equal(box.methods()[box.methods().length - 1], "kickstartAgent");
});

test("an id the catalog does not carry is refused before the box is read", async () => {
  const box = fakeBox();
  await assert.rejects(() => importer.importMarketplaceBot(box, { id: "no-such-bot" }), /no marketplace bot/);
  await assert.rejects(() => importer.importMarketplaceBot(box, {}), /needs the catalog id/);
  assert.deepEqual(box.methods(), []);
});

test("the verb resolves the whole row off its own catalog, never a card handed to it", async () => {
  // A list card carries no instructions, memories, skills, routines or apps. A verb that took the
  // row from its caller would let a model hand back a card and quietly create an empty agent, so
  // the id is all it takes and the lookup is its own. Driven through the PUBLIC verb, on a real row.
  const box = fakeBox();
  const row = catalog.findMarketplaceBot("account-book");
  const card = catalog.marketplaceBotCardView(row);
  assert.equal(card.skills, undefined, "the card stopped being a card; this case is measuring nothing");
  const report = await importer.importMarketplaceBot(box, { id: "account-book" });
  assert.equal(report.state, "done", report.message);
  assert.equal(box.argsFor("importAgentWorkflowText").length, row.skills.length);
  assert.equal(report.memories.added, importer.planFor(row).memories.facts);
  assert.ok(report.integrations.offered.includes("Slack"), report.message);
  assert.ok(!report.integrations.unavailable.includes("Slack"), report.message);
});

test("a team pack is refused in plain words rather than half-imported as one bot", async () => {
  // A pack is several agents with a coordinator and a reporting line, and that sequence lives on
  // the Bots tab. Through this door it would make ONE agent carrying the pack's name and none of
  // its members, which looks exactly like it worked.
  const box = fakeBox();
  const pack = { id: "small-team", name: "Small team", description: "A team.", instructions: "", skills: [], integrations: [], members: [{ id: "a", role: "Lead", summary: "Leads." }] };
  const report = await importFixture(box, pack);
  assert.equal(report.state, "refused");
  assert.match(report.message, /team of several bots/);
  assert.match(report.message, /added from its own page/);
  assert.deepEqual(box.methods(), [], "a pack reached the box anyway");
  for (const word of ["members", "coordinator", "pack"]) {
    assert.ok(!report.message.includes(word), `the refusal says "${word}" at a person`);
  }
});
