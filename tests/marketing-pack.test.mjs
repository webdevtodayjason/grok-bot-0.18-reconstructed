// The Marketing team pack, as a row and as an import.
//
// TEAMS-1's first slice. The gate (scripts/verify-marketing.mjs) drives the console in a real
// browser and is the only thing that can prove a person can click Import; this file pins the parts
// a browser is a bad place to pin -- what the row declares, what the import sequence does in what
// order, and what Remove team takes back -- against the same pure functions the console calls.
//
// Three of these tests exist because of something measured on grok-bot-local-vm on 2026-09-09
// rather than because of a rule:
//
//   NO DOUBLES. That box's shared workflow library holds web-research-pass, web-research-pass-2 and
//   web-research-pass-3: three copies of one skill, left behind by three imports of the Research
//   desk. The host suffixes on a name collision, it does not dedupe, and deleting the agent leaves
//   every copy behind. So the pack namespaces every skill and the import reads the library first.
//
//   THE CAP IS READ BEFORE THE FIRST WRITE. A half-imported team cannot be undone from the roster.
//
//   NOTHING IS INSTALLED SILENTLY. Import writes no connector and no key: it reports what is
//   missing and the operator adds each one.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".marketing-pack-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));

// The same bundle-then-require the marketplace suite uses: the catalog is TypeScript and this
// process runs the shipped shape, not a hand-copied one.
const bundle = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const file = path.join(stage, name);
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(file);
};

const catalog = await bundle("source/shared/marketplace/catalog.ts", "marketing-catalog.cjs");
const pack = await bundle("source/shared/marketplace/marketing-team.ts", "marketing-team.cjs");

const {
  MARKETING_TEAM_BOTS, MARKETING_TEAM_PACK_ID, MARKETING_SKILL_PREFIX, MARKETING_TEAM_AGENT_PREFIX,
  MARKETING_APPROVAL_SENTENCE, MARKETING_TEAM_CAPACITY_REFUSAL, marketingTeamProblems, marketingTeamAgentName,
  marketingTeamCapacityRefusal, marketplaceBotMembers, isMarketingTeamAgentName, isMarketingTeamSkillName,
} = pack;

const theTeam = MARKETING_TEAM_BOTS[0];
const members = marketplaceBotMembers(theTeam);
const pluginIds = new Set(catalog.MARKETPLACE_PLUGINS.map((plugin) => plugin.id));

// ------------------------------------------------------------------ 1. the row

test("the pack is a bot row the catalog serves, in a category the catalog declares", () => {
  const served = catalog.MARKETPLACE_BOTS.find((bot) => bot.id === MARKETING_TEAM_PACK_ID);
  assert.ok(served != null, "the Marketing team pack is not in MARKETPLACE_BOTS");
  // Deep, not identity: the catalog and the pack are bundled separately here, so each bundle holds
  // its own copy of the module. What matters is that the row the catalog serves IS the row the
  // module declares, field for field.
  assert.deepEqual(served, theTeam, "the catalog serves a different row than the module declares");
  assert.ok(catalog.MARKETPLACE_BOT_CATEGORIES.includes(served.category),
    `the pack's category "${served.category}" is not a declared bot category`);
  assert.equal(served.creator, "Titanbot team");
});

test("the catalog validator reports no problems, with the pack in it", () => {
  assert.deepEqual(catalog.validateMarketplaceCatalog(), []);
});

test("the pack's own invariants hold against the plugins this catalog serves", () => {
  assert.deepEqual(marketingTeamProblems(MARKETING_TEAM_BOTS, pluginIds), []);
});

test("seven specialists, one of them the coordinator that reports to Titan", () => {
  assert.equal(members.length, 7, members.map((m) => m.id).join(", "));
  const coordinators = members.filter((member) => member.reportsTo == null);
  assert.equal(coordinators.length, 1);
  assert.equal(coordinators[0].id, "coordinator");
  // The roles Jason's morning named, each present under some id.
  const roles = members.map((member) => member.role.toLowerCase());
  for (const wanted of ["social strategist", "copywriter", "community manager", "paid ads planner", "analytics reporter", "brand profile keeper", "coordinator"]) {
    assert.ok(roles.includes(wanted), `no member is the ${wanted} (have: ${roles.join(", ")})`);
  }
});

// The card shipped saying "Seven marketing specialists and a coordinator's approval rule", which a
// person reads as eight bots against a roster of seven. Any number word in the copy a customer
// reads now has to be a number the roster actually has.
test("the numbers in the pack's own copy match the roster it creates", () => {
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const specialists = members.filter((member) => member.reportsTo != null).length;
  const allowed = new Set([members.length, specialists]);
  // Only a number that is COUNTING BOTS. "One team, a brand profile per client" is a sentence about
  // the shape of the thing, not a headcount, and a check that cannot tell those apart is a check
  // somebody deletes.
  const counted = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:marketing\s+)?(specialists?|bots?|agents?)\b/gi;
  for (const found of theTeam.description.matchAll(counted)) {
    const value = WORDS[found[1].toLowerCase()];
    assert.ok(
      allowed.has(value),
      `the pack description counts "${found[0]}" and the roster has ${members.length} bots, ${specialists} of them specialists: ${theTeam.description}`,
    );
  }
});

test("every member names real plugin ids, and the pack's list is exactly their union", () => {
  const union = new Set();
  for (const member of members) {
    assert.ok(member.integrations.length > 0, `${member.id} names no integration`);
    for (const id of member.integrations) {
      assert.ok(pluginIds.has(id), `${member.id} needs "${id}", which is not a plugin id`);
      union.add(id);
    }
  }
  assert.deepEqual([...theTeam.integrations].sort(), [...union].sort());
});

// ------------------------------------------------------------------ 2. the approval rule

test("the approval sentence is in every member's instructions", () => {
  for (const member of members) {
    assert.ok(member.instructions.includes(MARKETING_APPROVAL_SENTENCE),
      `${member.id} can post without a yes: its persona does not carry the rule`);
  }
  assert.ok(theTeam.instructions.includes(MARKETING_APPROVAL_SENTENCE), "the pack's own description does not carry the rule");
});

test("the rule is also a skill, imported once, and it names the widget that ends the turn", () => {
  const rule = theTeam.skills.filter((skill) => skill.name === "mkt-approval-rule");
  assert.equal(rule.length, 1, "the approval rule is imported more than once, which is a duplicate in the shared library");
  // The card is the one that already exists. A widget ENDS the turn, which is why the rule cannot
  // be skipped by a model that keeps going, and why the skill has to name it rather than say
  // "ask first".
  assert.match(rule[0].body, /"type":"widget"/);
  assert.match(rule[0].body, /ENDS your turn|ends your turn/);
  // Money before the yes: X charges per post, so the count and the total are on the card.
  assert.match(rule[0].body, /costs per post|spending limit/i);
});

test("the coordinator's own skill raises one card for the batch and stops", () => {
  const runTheWeek = theTeam.skills.find((skill) => skill.name === "mkt-coordinator-run-the-week");
  assert.ok(runTheWeek != null);
  assert.match(runTheWeek.body, /ONE decision card/);
  assert.match(runTheWeek.body, /do-not-say list/);
  assert.match(runTheWeek.body, /fresh card/);
});

// ------------------------------------------------------------------ 3. the skills

test("every skill body is a SKILL.md whose front matter names it, and every name is namespaced", () => {
  const seen = new Set();
  for (const skill of theTeam.skills) {
    assert.ok(skill.name.startsWith(MARKETING_SKILL_PREFIX),
      `"${skill.name}" is not namespaced, so a second import would leave a duplicate behind`);
    assert.ok(!seen.has(skill.name), `"${skill.name}" is listed twice`);
    seen.add(skill.name);
    // The invariant the other six templates are already held to (tests/marketplace-catalog.test.mjs).
    assert.ok(skill.body.startsWith("---\nname: "), `${skill.name} has no front matter`);
    assert.match(skill.body, new RegExp(`^---\\nname: ${skill.name}\\n`), `${skill.name}: front matter names something else`);
    assert.match(skill.body, /^description: .+$/m, `${skill.name} has no description in its front matter`);
  }
  // Namespaced per ROLE as well as per pack, so two members cannot land on one library row.
  const roles = new Set(members.map((member) => member.id));
  for (const member of members) {
    for (const skill of member.skills) {
      const segment = skill.name.slice(MARKETING_SKILL_PREFIX.length).split("-")[0];
      assert.ok(roles.has(segment) || ["approval", "brand"].includes(segment),
        `${skill.name} is not namespaced to a role of this pack`);
    }
  }
});

test("the brand profile ships filled and blank, and the filled one carries a do-not-say list", () => {
  const template = theTeam.skills.find((skill) => skill.name === "mkt-brand-profile-template");
  const fixture = theTeam.skills.find((skill) => skill.name === "mkt-brand-northgate");
  assert.ok(template != null, "no blank brand profile for the operator to fill");
  assert.ok(fixture != null, "no filled brand profile for the gate to drive");
  for (const heading of ["## Voice", "## Audiences", "## Offers", "## Do not say", "## Approval rules", "## Accounts"]) {
    assert.ok(template.body.includes(heading), `the template has no ${heading} section`);
    assert.ok(fixture.body.includes(heading), `the fixture has no ${heading} section`);
  }
  // The part that earns its keep. A fixture with an empty list would let the gate pass while
  // proving nothing about the check the copywriter is supposed to run.
  const doNotSay = fixture.body.split("## Do not say")[1].split("##")[0];
  assert.ok(doNotSay.split("\n").filter((line) => line.trim().startsWith("-")).length >= 4,
    "the fixture's do-not-say list is too short to check a draft against");
});

// ------------------------------------------------------------------ 4. the first-run message

test("the first-run message names every credential the pack's integrations need", () => {
  const firstRun = theTeam.firstRun;
  assert.ok(firstRun != null && firstRun.needs.length > 0);
  const said = [firstRun.headline, firstRun.body, ...firstRun.needs, ...firstRun.prerequisites].join("\n");
  // Derived from the catalog rather than listed here: a plugin that grows a second credential
  // makes this fail, which is the point.
  for (const id of theTeam.integrations) {
    const plugin = catalog.findMarketplacePlugin(id);
    assert.ok(plugin != null, `${id} is not a plugin`);
    for (const field of catalog.marketplaceCredentialFields(plugin)) {
      assert.ok(said.includes(field), `the first-run message never mentions ${field}, which ${plugin.name} needs`);
    }
  }
  // And the plugins that need no key are still an Add the operator has to make.
  for (const id of theTeam.integrations) {
    const plugin = catalog.findMarketplacePlugin(id);
    if (catalog.marketplaceCredentialFields(plugin).length === 0) {
      assert.ok(said.includes(plugin.name), `the first-run message never mentions ${plugin.name}, which still has to be added`);
    }
  }
});

test("the first-run message names the two prerequisites that strand people", () => {
  const said = [theTeam.firstRun.body, ...theTeam.firstRun.prerequisites].join("\n");
  assert.match(said, /LinkedIn Page has to exist before a LinkedIn developer app/);
  assert.match(said, /Meta Business has to exist in Business Manager before Business Verification/);
});

test("the first-run message says plainly that the team drafts and does not post", () => {
  const said = [theTeam.firstRun.body, ...theTeam.firstRun.needs].join("\n");
  assert.match(said, /drafts\. It does not post|drafts and stops/);
  // No official connector publishes an organic post anywhere, so a row that implied one would lie.
  assert.match(theTeam.firstRun.body, /No official connector publishes an ordinary post/);
});

// ------------------------------------------------------------------ 5. the refusal

test("the capacity refusal is one plain sentence with both numbers in it", () => {
  const line = marketingTeamCapacityRefusal(3, 7);
  assert.equal(line.split(/(?<=[.!?])\s/).length, 1, `not one sentence: ${line}`);
  assert.match(line, /\b3\b/);
  assert.match(line, /\b7\b/);
  assert.match(line, /nothing was created/);
  // Plain words: no command names, no vendor names, no status codes.
  assert.doesNotMatch(line, /getAgentCapacity|createAgent|maxAgents|4\d\d|5\d\d/);
  // A workspace with room for exactly one reads right too.
  assert.match(marketingTeamCapacityRefusal(1, 7), /room for 1 more bot\b/);
});

// ------------------------------------------------------------------ 6. what Remove team takes back

test("a pack agent and a pack skill are recognised from their names alone", () => {
  for (const member of members) {
    const name = marketingTeamAgentName(member);
    assert.ok(name.startsWith(MARKETING_TEAM_AGENT_PREFIX));
    assert.ok(isMarketingTeamAgentName(name), `${name} would not be taken back by Remove team`);
  }
  for (const skill of theTeam.skills) assert.ok(isMarketingTeamSkillName(skill.name));
  // The rows that are NOT this pack's, on the box the gate runs against. Remove team must leave
  // every one of them exactly where it found it.
  for (const name of ["web-research-pass", "Gate global skill 1788736922117", "take-course-notes", "Marketing", "Chief of staff", "Atera Triage"]) {
    assert.ok(!isMarketingTeamSkillName(name) || name.startsWith(MARKETING_SKILL_PREFIX), name);
    assert.equal(isMarketingTeamAgentName(name), false, `${name} would be deleted by Remove team`);
  }
  assert.equal(isMarketingTeamSkillName("marketing-plan"), false, "the namespace is a prefix, not a word match");
  assert.equal(isMarketingTeamAgentName(null), false);
});

// ------------------------------------------------------------------ 7. the import sequence
//
// The console's own importMarketingTeam, driven by a fake gateway. The order of the calls IS the
// contract: capacity first, then per member createAgent, then only the skills the library does not
// already hold.

const { installMarketingTeamModule } = await import("./helpers/marketing-team-console.mjs");
const team = installMarketingTeamModule();

test("the console renders the same refusal sentence the catalog declares", () => {
  // The template is on the row because marketplace-bots.js is served to a browser and cannot
  // import the catalog module. This is the pin that keeps the two substitutions identical.
  for (const [remaining, needed] of [[0, 7], [1, 7], [3, 7], [6, 7], [7, 7]]) {
    assert.equal(
      team.renderRefusal(MARKETING_TEAM_CAPACITY_REFUSAL, remaining, needed),
      marketingTeamCapacityRefusal(remaining, needed),
      `the console and the catalog disagree at ${remaining}/${needed}`,
    );
  }
  assert.equal(team.renderRefusal(theTeam.packaging.capacityRefusal, 3, 7), marketingTeamCapacityRefusal(3, 7));
});

test("the console finds the members and the roster names on the row alone", () => {
  assert.equal(team.packMembersOf(theTeam).length, 7);
  assert.equal(team.packMembersOf(catalog.findMarketplaceBot("research-desk")).length, 0, "a single bot is not a team");
  for (const member of members) {
    assert.equal(team.memberAgentName(theTeam, member), marketingTeamAgentName(member));
  }
});

/** A box with a roster, a shared library, and a cap. Records every call in order. */
function fakeBox({ agents = [], library = [], maxAgents = 100 } = {}) {
  const calls = [];
  const roster = agents.map((name, index) => ({ id: `a${index}`, name }));
  const shared = library.map((name, index) => ({ id: `w${index}`, name, source: "workflow" }));
  let next = roster.length;
  return {
    calls,
    roster,
    shared,
    async call(method, args = {}) {
      calls.push({ method, args });
      if (method === "getAgentCapacity") return { bots: roster.length, maxAgents, remaining: Math.max(0, maxAgents - roster.length), isFull: roster.length >= maxAgents };
      if (method === "listAgents") return roster.map((agent) => ({ ...agent }));
      if (method === "createAgent") {
        const agent = { id: `a${next += 1}`, name: args.name, description: args.description };
        roster.push(agent);
        return { agent };
      }
      if (method === "deleteAgent") {
        const at = roster.findIndex((agent) => agent.id === args.id);
        if (at >= 0) roster.splice(at, 1);
        return { ok: true };
      }
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
      throw new Error(`unknown gateway method: ${method}`);
    },
  };
}

test("the cap is read before the first createAgent, and a refusal creates nothing", async () => {
  const box = fakeBox({ agents: ["Titan", "Books", "Dispatch"], maxAgents: 6 });
  const outcome = await team.importMarketingTeam(box, theTeam);
  assert.equal(outcome.state, "refused");
  assert.match(outcome.message, /room for 3 more bots/);
  assert.match(outcome.message, /nothing was created/);
  assert.equal(box.roster.length, 3, "a refusal created an agent anyway");
  assert.equal(box.shared.length, 0, "a refusal imported a skill anyway");
  assert.equal(box.calls[0].method, "getAgentCapacity", "the cap was not the first thing read");
  assert.ok(!box.calls.some((call) => call.method === "createAgent"), "createAgent ran after a refusal");
});

test("a clean import creates seven agents and imports ten skills, and nothing else", async () => {
  const box = fakeBox({ agents: ["Titan"] });
  // Seven creates and ten imports is long enough that one spinner reads as a hang, so the import
  // reports per member and the running card says whose turn it is.
  const progress = [];
  const outcome = await team.importMarketingTeam(box, theTeam, (row) => progress.push(row));
  assert.deepEqual(progress.filter((row) => row.phase === "creating").map((row) => row.role),
    members.map((member) => member.role), "the progress did not name each member in order");
  assert.equal(progress.filter((row) => row.phase === "importing").length, theTeam.skills.length);
  assert.ok(progress.every((row) => row.total === 7 && row.at >= 1 && row.at <= 7));
  assert.equal(outcome.state, "done", outcome.message);
  assert.equal(outcome.members.length, 7);
  assert.deepEqual(box.roster.slice(1).map((agent) => agent.name), members.map(marketingTeamAgentName));
  assert.deepEqual(box.shared.map((row) => row.name).sort(), theTeam.skills.map((skill) => skill.name).sort());
  // Never silently: no connector is written and no key is stored by an import.
  for (const method of ["addConnector", "installShellTool", "setConnectorSecret", "refreshMcp"]) {
    assert.ok(!box.calls.some((call) => call.method === method), `the import called ${method}`);
  }
  // Capacity first, and read once rather than per member.
  assert.equal(box.calls.filter((call) => call.method === "getAgentCapacity").length, 1);
  assert.equal(box.calls[0].method, "getAgentCapacity");
});

test("a second import leaves no doubles: the same seven agents and the same ten skills", async () => {
  const box = fakeBox({ agents: ["Titan"] });
  await team.importMarketingTeam(box, theTeam);
  const afterFirst = { agents: box.roster.length, skills: box.shared.length };
  const second = await team.importMarketingTeam(box, theTeam);
  assert.equal(second.state, "done", second.message);
  assert.equal(box.roster.length, afterFirst.agents, "a second import made more agents");
  assert.equal(box.shared.length, afterFirst.skills, "a second import made more skills");
  // The " copy" suffix the generic importer appends is exactly what must NOT happen here.
  assert.ok(!box.roster.some((agent) => / copy$/.test(agent.name)), box.roster.map((a) => a.name).join(", "));
  assert.ok(second.members.every((member) => member.reused === true), "a second import re-created a member");
});

test("a member that fails rolls back what the import created, and nothing it found", async () => {
  const box = fakeBox({ agents: ["Titan"], library: ["web-research-pass", "web-research-pass-2"] });
  const before = { agents: [...box.roster], skills: box.shared.map((row) => row.name) };
  const call = box.call.bind(box);
  let created = 0;
  box.call = async (method, args) => {
    if (method === "createAgent" && (created += 1) === 4) throw new Error("the host refused");
    return call(method, args);
  };
  const outcome = await team.importMarketingTeam(box, theTeam);
  assert.equal(outcome.state, "failed");
  assert.match(outcome.message, /refused/);
  assert.deepEqual(box.roster.map((a) => a.name), before.agents.map((a) => a.name), "a failed import left agents behind");
  assert.deepEqual(box.shared.map((row) => row.name), before.skills, "a failed import left skills behind");
});

test("Remove team takes back the agents AND the skills, and leaves everything else", async () => {
  const box = fakeBox({ agents: ["Titan", "Marketing"], library: ["web-research-pass", "web-research-pass-2", "Gate global skill 1788736922117"] });
  const before = { agents: box.roster.map((a) => a.name), skills: box.shared.map((row) => row.name) };
  await team.importMarketingTeam(box, theTeam);
  assert.equal(box.roster.length, before.agents.length + 7);
  assert.equal(box.shared.length, before.skills.length + 10);
  const removed = await team.removeMarketingTeam(box, theTeam);
  assert.equal(removed.agents, 7, "Remove team did not take back every bot");
  assert.equal(removed.skills, 10, "Remove team left skills behind, which is what deleting an agent already does");
  assert.deepEqual(box.roster.map((a) => a.name), before.agents);
  assert.deepEqual(box.shared.map((row) => row.name), before.skills);
});

test("one agent refusing the library read does not read as an empty library", async () => {
  // Measured on grok-bot-local-vm 2026-09-09: the library was read through one agent chosen at the
  // start, that agent stopped answering, and the read came back empty on a box holding 55 rows. An
  // empty library is precisely the answer that makes a second import re-write every document, so
  // the read walks the roster until one answers.
  const box = fakeBox({ agents: ["Sulky", "Titan"] });
  await team.importMarketingTeam(box, theTeam);
  const after = { agents: box.roster.length, skills: box.shared.length };
  const call = box.call.bind(box);
  box.call = async (method, args) => {
    if (method === "getAgentWorkflows" && args.id === "a0") throw new Error("that agent does not exist");
    return call(method, args);
  };
  const second = await team.importMarketingTeam(box, theTeam);
  assert.equal(second.state, "done", second.message);
  assert.equal(box.shared.length, after.skills, "the sulky agent's refusal re-imported every document");
  assert.equal(box.roster.length, after.agents);
});

// ------------------------------------------------------------------ 8. the page's own markup
//
// The gate drives one run, so it reaches the confirm, imported, refused and removed states and not
// the failed one. These render every state once, offline, because a typo in a branch nobody drew
// is a branch that first renders at a person.

test("every state of the pack page renders, with nothing undefined in it", () => {
  const states = [
    null,
    { state: "running", step: "Copywriter (3 of 7)" },
    { state: "confirm", members: 7, skills: 10, missing: ["Notion", "Resend"], keys: ["NOTION_TOKEN"] },
    { state: "confirm", members: 7, skills: 10, missing: [], keys: [] },
    { state: "refused", message: marketingTeamCapacityRefusal(2, 7) },
    { state: "failed", message: "the host refused" },
    { state: "removed", message: "7 bots and 10 documents taken back." },
    { state: "done", members: members.map((member, index) => ({ id: member.id, role: member.role, agentId: `a${index}`, name: marketingTeamAgentName(member), reused: index === 0, skills: member.skills.map((skill) => ({ name: skill.name, reused: false })) })) },
  ];
  for (const state of states) {
    const html = team.renderTeamState(theTeam, state);
    const label = state == null ? "(no import yet)" : state.state;
    assert.equal(typeof html, "string", label);
    assert.ok(!/undefined|\[object Object\]|NaN/.test(html), `${label} rendered: ${html.slice(0, 200)}`);
    if (state != null) assert.ok(html.length > 0, `${label} rendered nothing`);
  }
  // The refusal reaches the page verbatim, with no command name and no status code in it.
  const refused = team.renderTeamState(theTeam, { state: "refused", message: marketingTeamCapacityRefusal(2, 7) });
  assert.ok(refused.includes("room for 2 more bots"), refused);
  assert.doesNotMatch(refused, /getAgentCapacity|createAgent|maxAgents/);
});

test("the members section names every member, its playbooks and its tools", () => {
  const html = team.renderTeamMembers(theTeam);
  for (const member of members) {
    assert.ok(html.includes(member.role), `${member.id} is not on the members section`);
    for (const skill of member.skills) assert.ok(html.includes(skill.name), `${skill.name} is not shown`);
  }
  // The coordinator reports to Titan; everyone else reports to the coordinator.
  assert.ok(html.includes("Reports to Titan"), "nobody is shown reporting to Titan");
  assert.ok(html.includes("Reports to the coordinator"), "nobody is shown reporting to the coordinator");
  assert.ok(!/undefined|\[object Object\]/.test(html));
});

test("the first-run section draws both lists and the prose", () => {
  const html = team.renderFirstRun(theTeam);
  for (const line of theTeam.firstRun.needs) assert.ok(html.includes(line.slice(0, 40)), line.slice(0, 40));
  for (const line of theTeam.firstRun.prerequisites) assert.ok(html.includes(line.slice(0, 40)), line.slice(0, 40));
  assert.ok(html.includes("No official connector publishes an ordinary post"));
  assert.ok(!/undefined|\[object Object\]/.test(html));
});

test("Remove team on a box that never imported the pack does nothing at all", async () => {
  const box = fakeBox({ agents: ["Titan", "Marketing"], library: ["web-research-pass"] });
  const removed = await team.removeMarketingTeam(box, theTeam);
  assert.deepEqual(removed, { agents: 0, skills: 0, failures: [] });
  assert.equal(box.roster.length, 2);
  assert.equal(box.shared.length, 1);
  assert.ok(!box.calls.some((call) => call.method === "deleteAgent" || call.method === "deleteAgentWorkflow"));
});
