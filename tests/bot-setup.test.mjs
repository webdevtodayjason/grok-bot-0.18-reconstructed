// BOTS-4 — the Add sequence, driven by a fake gateway.
//
// One click on a catalog row has to leave a person with an agent that greets them in its own voice,
// already knowing its operating rules, holding its playbooks, carrying its jobs switched off, and
// saying which apps it still needs. The ORDER of the calls is what makes that true and a click in a
// browser is no place to pin it: the gate (scripts/verify-bots.mjs) proves a person can start the
// setup, and these cases prove what ran in between.
//
// Four of them exist because of something the host does silently rather than because of a rule:
//
//   KICKSTART IS LAST. createAgent with isKickstartRequested true writes the introduction
//   immediately, before the agent knows anything, and the introduction is written once. So the
//   agent is minted with it false and asked for the introduction after everything is seeded.
//
//   A ROUTINE IS A REAL CRON OR IT IS NOT CREATED. automation-store.upsert writes NOTHING when a
//   trigger will not normalise and the gateway still answers 200, and normalizeSchedule accepts the
//   bare word "weekly", stores it, describes it as "weekly" and never computes a next run. Both are
//   a routine that is silently not there the day somebody switches it on.
//
//   THE LIBRARY IS READ ONCE, BEFORE THE FIRST WRITE. Measured on grok-bot-local-vm 2026-09-09:
//   that box's shared library holds web-research-pass, -2 and -3, three copies of one skill left by
//   three imports, because the host suffixes on a name collision and never dedupes.
//
//   A HALF-DONE SETUP IS TAKEN BACK. There is no undo on the roster, and a bot with four of its
//   seven playbooks looks exactly like one that worked.
import assert from "node:assert/strict";
import test from "node:test";

import { installBotSetupModule } from "./helpers/bot-setup-console.mjs";

const { module: setup } = installBotSetupModule();

// ------------------------------------------------------------------ the fixture
//
// A community row as the generator writes one: memories split into cap-sized facts, skills with a
// one-line description and no body, one routine with a real cron, one that waits on an event, and
// apps of all three kinds.
const theBot = Object.freeze({
  id: "seo-desk",
  name: "SEO Desk",
  creator: "Ada Vance",
  creatorNote: "by Ada Vance, from the community",
  category: "Marketing",
  description: "Keeps the search brief current and tells you what moved.",
  instructions: "You keep the search brief current for one team.",
  memories: [
    { name: "memory 1", text: "You keep the search brief current for one team.", facts: ["You keep the search brief current for one team."] },
    { name: "memory 2", text: "Long paragraph split at sentence boundaries.", facts: ["Publish nothing without a human read.", "Name the source of every number you quote."] },
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
    { name: "notion-workspace", label: "Notion", description: "Keep the ideas board and briefs where the team already writes.", pluginId: "notion", offer: "connect" },
    { name: "slack", label: "Slack", description: "Post the digest where people read it.", pluginId: "slack", offer: "connect" },
    { name: "X", label: "X", description: "Read what people are asking.", pluginId: "", offer: "page" },
    { name: "Profound", label: "Profound", description: "Pull the answer-engine numbers.", pluginId: "", offer: "byo" },
  ],
});

/** A box with a roster, a shared library, routines and a memory store. Records every call in order. */
function fakeBox({ agents = [], library = [] } = {}) {
  const calls = [];
  const roster = agents.map((name, index) => ({ id: `a${index}`, name }));
  const shared = library.map((name, index) => ({ id: `w${index}`, name, source: "workflow" }));
  const memories = new Map();
  const automations = new Map();
  let next = roster.length;
  return {
    calls,
    roster,
    shared,
    memories,
    automations,
    methods: () => calls.map((call) => call.method),
    argsFor(method) { return calls.filter((call) => call.method === method).map((call) => call.args); },
    async call(method, args = {}) {
      calls.push({ method, args });
      if (method === "listAgents") return roster.map((agent) => ({ ...agent }));
      if (method === "createAgent") {
        const agent = { id: `a${next += 1}`, name: args.name, description: args.description };
        roster.push(agent);
        memories.set(agent.id, []);
        automations.set(agent.id, []);
        return { agent };
      }
      if (method === "deleteAgent") {
        const at = roster.findIndex((agent) => agent.id === args.id);
        if (at >= 0) roster.splice(at, 1);
        memories.delete(args.id);
        automations.delete(args.id);
        return { ok: true };
      }
      if (method === "addAgentMemories") {
        const held = memories.get(args.id) ?? [];
        const added = [];
        const rejected = [];
        for (const raw of args.memories) {
          const value = String(raw).replace(/\s+/g, " ").trim();
          // The host's own rule, in one line: over the cap it is refused, never shortened.
          if (value.length > 500) { rejected.push({ text: value, why: "too long" }); continue; }
          if (held.some((row) => row.content === value)) continue;
          held.push({ id: `m${held.length}`, content: value, createdAt: 1, kind: "log" });
          added.push(value);
        }
        memories.set(args.id, held);
        return { added, duplicates: args.memories.length - added.length - rejected.length, rejected };
      }
      if (method === "getAgentMemories") return (memories.get(args.id) ?? []).map((row) => ({ ...row }));
      if (method === "getAgentWorkflows") return shared.map((row) => ({ ...row }));
      if (method === "importAgentWorkflowText") {
        shared.push({ id: args.name, name: args.name, source: "workflow" });
        return { result: { imported: [args.name], skipped: [] } };
      }
      if (method === "deleteAgentWorkflow") {
        const at = shared.findIndex((row) => row.id === args.workflowId);
        if (at >= 0) shared.splice(at, 1);
        return { ok: true };
      }
      if (method === "createAgentAutomation") {
        const held = automations.get(args.id) ?? [];
        held.push({ id: `r${held.length}`, name: args.spec.name, prompt: args.spec.prompt, trigger: args.spec.trigger, isEnabled: args.spec.isEnabled === true });
        automations.set(args.id, held);
        return { ok: true };
      }
      if (method === "getAgentAutomations") return (automations.get(args.id) ?? []).map((row) => ({ ...row }));
      if (method === "kickstartAgent") return { isIntroductionInFlight: true };
      throw new Error(`unknown gateway method: ${method}`);
    },
  };
}

const WRITES = ["createAgent", "addAgentMemories", "importAgentWorkflowText", "createAgentAutomation", "deleteAgent", "deleteAgentWorkflow", "kickstartAgent"];

// ------------------------------------------------------------------ 1. the order

test("the order is roster, mint, memories, one library read, skills, routines, then the introduction", async () => {
  const box = fakeBox({ agents: ["Titan"] });
  const outcome = await setup.setUpBot(box, theBot);
  assert.equal(outcome.state, "done", outcome.message);
  const methods = box.methods();

  assert.equal(methods[0], "listAgents", "the roster was not read first");
  assert.equal(methods[1], "createAgent");
  assert.equal(methods[2], "addAgentMemories");

  const firstImport = methods.indexOf("importAgentWorkflowText");
  const libraryRead = methods.indexOf("getAgentWorkflows");
  assert.ok(libraryRead >= 0 && libraryRead < firstImport, "the library was not read before the first import");
  assert.equal(methods.slice(0, firstImport).filter((m) => m === "getAgentWorkflows").length, 1,
    "the library was read more than once before the first write");

  // Every routine that has a cron, and only those, and every one of them switched off.
  const specs = box.argsFor("createAgentAutomation").map((args) => args.spec);
  assert.deepEqual(specs.map((spec) => spec.name), ["Weekly brief sweep", "Daily digest"]);
  for (const spec of specs) {
    assert.equal(spec.isEnabled, false, "a routine was created switched on");
    assert.deepEqual(Object.keys(spec.trigger), ["type", "schedule"]);
    assert.equal(spec.trigger.type, "cron");
  }
  assert.deepEqual(specs.map((spec) => spec.trigger.schedule), ["0 9 * * 1", "0 9 * * 1-5"]);

  // The introduction is the LAST thing that happens, so it is written by an agent that already
  // remembers everything and holds its playbooks.
  assert.equal(methods[methods.length - 1], "kickstartAgent");
  assert.equal(methods.filter((m) => m === "kickstartAgent").length, 1);

  // And every write happened before it, which is the half that "last" is really claiming.
  const kickstartAt = methods.lastIndexOf("kickstartAgent");
  for (const [at, method] of methods.entries()) {
    if (method === "kickstartAgent") continue;
    assert.ok(!(WRITES.includes(method) && at > kickstartAt), `${method} ran after the introduction`);
  }
});

test("the agent is minted with the introduction held back, never with kickstart requested", async () => {
  const box = fakeBox();
  await setup.setUpBot(box, theBot);
  const [args] = box.argsFor("createAgent");
  assert.equal(args.isKickstartRequested, false);
  assert.equal(args.name, "SEO Desk");
  // One identity field: the description, composed the way the console has always composed it.
  assert.equal(args.description, "Keeps the search brief current and tells you what moved.\n\nYou keep the search brief current for one team.");
});

test("the identity is the console's own composition, not a second copy of the rule", async () => {
  // Loaded beside marketplace-bots.js, personaFor comes off that module. Two compositions in one
  // console drift within a week and the page and the setup then disagree about what the bot is.
  const { module: both, window: win } = installBotSetupModule({ withPage: true });
  assert.equal(typeof win.__marketplaceBots.personaFor, "function");
  assert.equal(both.personaFor(theBot), win.__marketplaceBots.personaFor(theBot));
  assert.equal(both.personaFor(theBot), setup.personaFor(theBot), "the local copy and the page's rule disagree");
});

test("every fact the row carries is seeded, split as the generator split it", async () => {
  const box = fakeBox();
  await setup.setUpBot(box, theBot);
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
  await setup.setUpBot(box, { ...theBot, memories: [{ name: "memory 1", text: "One whole paragraph." }] });
  assert.deepEqual(box.argsFor("addAgentMemories")[0].memories, ["One whole paragraph."]);
});

// ------------------------------------------------------------------ 2. the second click

test("a second setup says it is already on the roster and writes nothing at all", async () => {
  const box = fakeBox();
  const first = await setup.setUpBot(box, theBot);
  assert.equal(first.state, "done", first.message);
  const after = { agents: box.roster.length, skills: box.shared.length };

  box.calls.length = 0;
  const second = await setup.setUpBot(box, theBot);
  assert.equal(second.state, "already");
  assert.equal(second.agent.name, "SEO Desk");
  assert.match(second.message, /already on your roster/);
  assert.deepEqual(box.methods(), ["listAgents"], "a second click did more than read the roster");
  assert.equal(box.roster.length, after.agents, "a second click made another bot");
  assert.equal(box.shared.length, after.skills, "a second click wrote another playbook");
  assert.ok(!box.roster.some((agent) => / copy$/.test(agent.name)));
});

test("a deliberate second copy is still reachable, and only behind that flag", async () => {
  const box = fakeBox();
  await setup.setUpBot(box, theBot);
  const copy = await setup.setUpBot(box, theBot, { duplicate: true });
  assert.equal(copy.state, "done", copy.message);
  assert.equal(copy.agent.name, "SEO Desk copy");
  assert.equal(box.roster.length, 2);
});

test("alreadyOnRoster answers the agent or null and writes nothing", async () => {
  const box = fakeBox({ agents: ["SEO Desk"] });
  const found = await setup.alreadyOnRoster(box, theBot);
  assert.equal(found.name, "SEO Desk");
  assert.equal(await setup.alreadyOnRoster(box, { ...theBot, name: "Nobody" }), null);
  assert.deepEqual(new Set(box.methods()), new Set(["listAgents"]));
});

// ------------------------------------------------------------------ 3. routines that are not clocks

test("a routine with no schedule never reaches the box and is named with its reason", async () => {
  const box = fakeBox();
  const outcome = await setup.setUpBot(box, theBot);
  assert.deepEqual(outcome.routines.created.map((row) => row.name), ["Weekly brief sweep", "Daily digest"]);
  assert.deepEqual(outcome.routines.notCreated.map((row) => row.name), ["Ranking watch"]);
  assert.match(outcome.routines.notCreated[0].why, /waits on something happening rather than on a clock/);
  assert.ok(!box.argsFor("createAgentAutomation").some((args) => args.spec.name === "Ranking watch"));
});

test("a cadence word is not a schedule, because the host stores it and never runs it", async () => {
  // normalizeSchedule accepts "weekly", stores it, describes it as "weekly" and computes no next
  // run. That is a dead routine, so it is refused here rather than created and left to rot.
  assert.equal(setup.cronOf({ schedule: "weekly" }), "");
  assert.equal(setup.cronOf({ schedule: "every Monday" }), "");
  assert.equal(setup.cronOf({ schedule: "0 9 * * 1" }), "0 9 * * 1");
  assert.equal(setup.cronOf({ schedule: "" }), "");
  assert.equal(setup.cronOf({}), "");
  const box = fakeBox();
  const outcome = await setup.setUpBot(box, {
    ...theBot,
    routines: [{ name: "Weekly thing", summary: "Runs weekly.", schedule: "weekly" }],
  });
  assert.equal(box.argsFor("createAgentAutomation").length, 0);
  assert.match(outcome.routines.notCreated[0].why, /not a clock this box can hold/);
});

test("a routine the box takes and does not list is reported as not created", async () => {
  const box = fakeBox();
  const call = box.call.bind(box);
  box.call = async (method, args) => {
    // upsert answers 200 and writes nothing when a trigger will not normalise. This is that.
    if (method === "createAgentAutomation") { box.calls.push({ method, args }); return { ok: true }; }
    return call(method, args);
  };
  const outcome = await setup.setUpBot(box, theBot);
  assert.equal(outcome.state, "done");
  assert.deepEqual(outcome.routines.created, []);
  assert.equal(outcome.routines.notCreated.length, 3);
  assert.ok(outcome.routines.notCreated.some((row) => /is not listing the job/.test(row.why)));
});

// ------------------------------------------------------------------ 4. the shared library

test("a playbook the box already holds is reused rather than written a second time", async () => {
  const box = fakeBox({ library: ["seo-desk-question-map"] });
  const outcome = await setup.setUpBot(box, theBot);
  assert.deepEqual(outcome.skills.reused, ["seo-desk-question-map"]);
  assert.deepEqual(outcome.skills.imported, ["seo-desk-brief-refresh"]);
  assert.deepEqual(box.argsFor("importAgentWorkflowText").map((args) => args.name), ["seo-desk-brief-refresh"]);
  assert.equal(box.shared.length, 2, "the library grew a double");
});

test("skills are namespaced by the bot, so a stranger's document is never adopted", () => {
  assert.equal(setup.skillNameFor(theBot, { name: "Question map" }), "seo-desk-question-map");
  assert.equal(setup.skillNameFor({ id: "site-audit" }, { name: "Crawl & report" }), "site-audit-crawl-report");
  // A pack that declares its own prefix keeps it, so the Marketing team's documents stay where
  // Remove team can find them.
  assert.equal(setup.skillNameFor({ id: "x", packaging: { skillPrefix: "marketing-" } }, { name: "Plan" }), "marketing-plan");
});

test("the name the box will file a document under is the one in its frontmatter", () => {
  // MEASURED on grok-bot-local-vm 2026-09-09: the `name` argument to importAgentWorkflowText is not
  // what the box stores. A body headed "# Probe playbook" and imported as
  // "bots1-probe-probe-playbook" landed in the shared library as "Probe playbook" -- so a namespace
  // that lives only in the argument is decoration, the reuse check can never match it, and a second
  // Add writes a second copy of every document. Every imported document therefore names itself.
  assert.equal(setup.frontmatterName("---\nname: mkt-brand-northgate\ndescription: x\n---\n# Brand"), "mkt-brand-northgate");
  assert.equal(setup.frontmatterName('---\nname: "quoted-name"\n---\n'), "quoted-name");
  assert.equal(setup.frontmatterName("# no frontmatter"), "");
  // A document that already names itself keeps its own name on both sides of the reuse check.
  const authored = { name: "Plan the week", body: "---\nname: mkt-strategist-plan-the-week\n---\n# Plan\n" };
  assert.equal(setup.skillNameFor(theBot, authored), "mkt-strategist-plan-the-week");
  assert.equal(setup.skillBody(theBot, authored), authored.body, "an authored document was rewritten");
});

test("a skill with no body gets one written from its description, and the document says so", () => {
  const body = setup.skillBody(theBot, theBot.skills[0]);
  assert.ok(body.startsWith("---\nname: seo-desk-question-map\n"), body.slice(0, 80));
  assert.match(body, /# Question map/);
  assert.match(body, /Use when the team needs the questions buyers actually ask\./);
  assert.match(body, /written from a one-line summary/);
  assert.match(body, /rewrite this document with the steps you actually took/);
  assert.equal(setup.frontmatterName(body), setup.skillNameFor(theBot, theBot.skills[0]));
  // A description carrying a colon must not break the frontmatter it sits in.
  const tricky = setup.skillBody(theBot, { name: "Odd", description: 'Use when: a "quote" appears.' });
  assert.match(tricky, /description: "Use when: a \\"quote\\" appears\."/);
  assert.equal(setup.frontmatterName(tricky), "seo-desk-odd");
});

test("a body with no frontmatter is named without its text being touched", () => {
  const body = setup.skillBody(theBot, theBot.skills[1]);
  assert.equal(setup.frontmatterName(body), "seo-desk-brief-refresh");
  assert.ok(body.endsWith("# Brief refresh\n\nDo the thing.\n"), JSON.stringify(body));
});

test("a playbook the box declines is named with the box's own reason", async () => {
  const box = fakeBox();
  const call = box.call.bind(box);
  box.call = async (method, args) => {
    if (method === "importAgentWorkflowText" && args.name === "seo-desk-question-map") {
      box.calls.push({ method, args });
      return { result: { imported: [], skipped: [{ source: args.name, reason: "a document by that name is already here" }] } };
    }
    return call(method, args);
  };
  const outcome = await setup.setUpBot(box, theBot);
  assert.equal(outcome.state, "done", outcome.message);
  assert.ok(outcome.skills.skipped.some((row) => /already here/.test(row.reason)));
});

// ------------------------------------------------------------------ 5. the rollback

test("a failure part way takes back the bot and this run's playbooks, and nothing it found", async () => {
  const box = fakeBox({ agents: ["Titan"], library: ["web-research-pass", "web-research-pass-2"] });
  const before = { agents: box.roster.map((a) => a.name), skills: box.shared.map((row) => row.name) };
  const call = box.call.bind(box);
  let routines = 0;
  box.call = async (method, args) => {
    if (method === "createAgentAutomation" && (routines += 1) === 2) {
      box.calls.push({ method, args });
      throw new Error("the host refused the trigger");
    }
    return call(method, args);
  };
  const outcome = await setup.setUpBot(box, theBot);
  assert.equal(outcome.state, "failed");
  assert.match(outcome.message, /refused the trigger/);
  assert.match(outcome.message, /taken back/);
  assert.deepEqual(box.roster.map((a) => a.name), before.agents, "a failed setup left a bot behind");
  assert.deepEqual(box.shared.map((row) => row.name), before.skills, "a failed setup left playbooks behind");
  assert.ok(!box.methods().includes("kickstartAgent"), "a failed setup still asked for an introduction");
});

test("a rollback does not touch a document the run merely reused", async () => {
  const box = fakeBox({ library: ["seo-desk-question-map", "web-research-pass"] });
  const call = box.call.bind(box);
  box.call = async (method, args) => {
    if (method === "createAgentAutomation") { box.calls.push({ method, args }); throw new Error("no"); }
    return call(method, args);
  };
  await setup.setUpBot(box, theBot);
  assert.deepEqual(box.shared.map((row) => row.name).sort(), ["seo-desk-question-map", "web-research-pass"]);
  assert.equal(box.roster.length, 0);
});

// ------------------------------------------------------------------ 6. what it reports

test("the report is what the box holds, read back, and never what was asked for", async () => {
  const box = fakeBox();
  const outcome = await setup.setUpBot(box, theBot);
  const methods = box.methods();
  for (const read of ["getAgentMemories", "getAgentWorkflows", "getAgentAutomations"]) {
    assert.ok(methods.includes(read), `${read} was never read back`);
  }
  assert.equal(outcome.memories.added, 3);
  assert.equal(outcome.memories.rejected.length, 0);
  assert.deepEqual(outcome.skills.imported.sort(), ["seo-desk-brief-refresh", "seo-desk-question-map"]);
  for (const routine of outcome.routines.created) assert.equal(routine.isEnabled, false);
});

test("a fact the host refused is carried into the report rather than counted as stored", async () => {
  const long = `${"a".repeat(600)}.`;
  const box = fakeBox();
  const outcome = await setup.setUpBot(box, {
    ...theBot,
    memories: [{ name: "memory 1", text: long, facts: [long] }, { name: "memory 2", text: "Short.", facts: ["Short."] }],
  });
  assert.equal(outcome.memories.added, 1);
  assert.equal(outcome.memories.rejected.length, 1);
  assert.match(outcome.message, /too long to store/);
  assert.match(outcome.message, /rather than cut short/);
});

test("the apps split four ways, and an installed one is not offered again", () => {
  const plan = setup.planApps(theBot, ["notion"]);
  assert.deepEqual(plan.connected.map((a) => a.label), ["Notion"]);
  assert.deepEqual(plan.addable.map((a) => a.label), ["Slack"]);
  assert.deepEqual(plan.informational.map((a) => a.label), ["X"], "a row that installs nothing was offered an Add");
  assert.deepEqual(plan.byo.map((a) => a.label), ["Profound"]);
  assert.equal(plan.connected[0].description, "Keep the ideas board and briefs where the team already writes.");
  // A Set is accepted too, which is what the Plugins tab hands over.
  assert.deepEqual(setup.planApps(theBot, new Set(["notion", "slack"])).addable, []);
  // A row from before the apps field falls back to its plugin ids, so the six first-party bots
  // still report their integrations rather than nothing.
  const old = setup.planApps({ integrations: ["github", "slack"] }, ["github"]);
  assert.deepEqual(old.connected.map((a) => a.label), ["github"]);
  assert.deepEqual(old.addable.map((a) => a.label), ["slack"]);
});

test("the message is one plain sentence a person reads, with no tool or field names in it", async () => {
  const box = fakeBox();
  const outcome = await setup.setUpBot(box, { ...theBot, apps: theBot.apps }, { installedPluginIds: ["notion"] });
  assert.match(outcome.message, /^SEO Desk is on your roster with 3 facts it now remembers, 2 playbooks, 2 jobs that stay switched off until you turn them on\./);
  assert.match(outcome.message, /Slack still need connecting/);
  assert.match(outcome.message, /Profound is not something we carry yet/);
  assert.match(outcome.message, /1 job could not be set up/);
  for (const word in { createAgent: 1, importAgentWorkflowText: 1, createAgentAutomation: 1, addAgentMemories: 1, kickstartAgent: 1, gateway: 1, plugin: 1, cron: 1 }) {
    assert.ok(!outcome.message.includes(word), `the message says "${word}" at a person`);
  }
  assert.ok(!/Grok|Cursor|xAI|x\.ai/i.test(outcome.message), "the message names the old vendor");
});

test("the plan says what an Add would do, with nothing written and no box to ask", () => {
  const plan = setup.planFor(theBot, ["notion"]);
  assert.equal(plan.name, "SEO Desk");
  assert.deepEqual(plan.memories, { paragraphs: 2, facts: 3 });
  assert.deepEqual(plan.skills.map((row) => row.as), ["seo-desk-question-map", "seo-desk-brief-refresh"]);
  assert.deepEqual(plan.routines.create.map((row) => row.name), ["Weekly brief sweep", "Daily digest"]);
  assert.deepEqual(plan.routines.skip.map((row) => row.name), ["Ranking watch"]);
  assert.deepEqual(plan.apps.addable.map((a) => a.label), ["Slack"]);
  assert.equal(plan.description, setup.personaFor(theBot));
});

test("the plan and the setup agree about what would be created", async () => {
  // A plan the page shows that does not match what the click does is worse than no plan.
  const box = fakeBox();
  const plan = setup.planFor(theBot, []);
  const outcome = await setup.setUpBot(box, theBot, { installedPluginIds: [] });
  assert.deepEqual(outcome.routines.created.map((row) => row.name), plan.routines.create.map((row) => row.name));
  assert.deepEqual(outcome.routines.notCreated.map((row) => row.name), plan.routines.skip.map((row) => row.name));
  assert.deepEqual([...outcome.skills.imported, ...outcome.skills.reused].sort(), plan.skills.map((row) => row.as).sort());
  assert.equal(outcome.memories.added, plan.memories.facts);
});

// ------------------------------------------------------------------ 7. rows that carry nothing

test("a row with no memories, skills or routines still becomes an agent", async () => {
  const box = fakeBox();
  const outcome = await setup.setUpBot(box, { id: "plain", name: "Plain", description: "Does one thing.", instructions: "", skills: [], integrations: [] });
  assert.equal(outcome.state, "done", outcome.message);
  assert.equal(box.argsFor("addAgentMemories").length, 0, "an empty seed was sent anyway");
  assert.equal(box.argsFor("importAgentWorkflowText").length, 0);
  assert.equal(box.argsFor("createAgentAutomation").length, 0);
  assert.equal(outcome.message, "Plain is on your roster.");
  assert.equal(box.methods()[box.methods().length - 1], "kickstartAgent");
});

test("a row with no name is refused before anything is read", async () => {
  const box = fakeBox();
  await assert.rejects(() => setup.setUpBot(box, { id: "x" }), /no name/);
  await assert.rejects(() => setup.setUpBot(box, null), /no bot to set up/);
  assert.deepEqual(box.methods(), []);
});

test("one agent refusing the library read does not read as an empty library", async () => {
  // Measured on grok-bot-local-vm 2026-09-09 during the team import: the library was read through
  // one agent, that agent stopped answering, and the read came back empty on a box holding 55 rows.
  // An empty library is the answer that makes the setup write every document again.
  const box = fakeBox({ agents: ["Sulky"], library: ["seo-desk-question-map", "seo-desk-brief-refresh"] });
  const call = box.call.bind(box);
  box.call = async (method, args) => {
    if (method === "getAgentWorkflows" && args.id !== "a0") { box.calls.push({ method, args }); throw new Error("that agent is busy"); }
    return call(method, args);
  };
  const outcome = await setup.setUpBot(box, theBot);
  assert.equal(outcome.state, "done", outcome.message);
  assert.deepEqual(box.argsFor("importAgentWorkflowText"), [], "the setup wrote documents the box already held");
  assert.equal(box.shared.length, 2);
});
