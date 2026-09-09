// TITAN-CATALOG-1 — the console's half of Add, now that the sequence lives in the box.
//
// This suite used to drive eight gateway calls against a fake gateway and pin their order, because
// the order IS the contract and a click in a browser is no place to pin it. The order is still
// pinned, in tests/host-marketplace-bot-import.test.mjs, against the host module that now holds it. The
// sequence moved because Titan could not reach it: asked for an Instagram marketer he made a blank
// agent with an invented persona, no memories, no playbooks and no jobs. Writing it a second time
// for him would have given the product two imports that drift, so there is one import and two doors
// onto it — the console's Add, and the agent's request.
//
// So what is left to pin here is the console's half, and the most valuable case in the file is the
// last one: that this file no longer contains a second copy of the sequence. A thin caller that
// quietly regrows the eight steps is exactly the drift the move exists to end, and it would pass
// every other case below.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installBotSetupModule } from "./helpers/bot-setup-console.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { module: setup } = installBotSetupModule();

// A catalog row as the Bots tab holds one. Only two fields of it ever leave the browser now — the
// id, and the name the card says while it waits — because the box resolves the row itself.
const theBot = Object.freeze({
  id: "seo-desk",
  name: "SEO Desk",
  category: "Marketing",
  description: "Keeps the search brief current and tells you what moved.",
  instructions: "You keep the search brief current for one team.",
  skills: [{ name: "Question map", description: "The questions buyers ask.", body: "" }],
  integrations: ["notion", "slack"],
});

/** The report the box answers with, in the shape the panel card draws. */
const theReport = Object.freeze({
  state: "done",
  alreadyExisted: false,
  agent: { id: "a7", name: "SEO Desk" },
  agentId: "a7",
  name: "SEO Desk",
  memories: { added: 3, duplicates: 0, rejected: [] },
  skills: { imported: ["seo-desk-question-map"], reused: [], skipped: [] },
  routines: { created: [{ name: "Weekly brief sweep", schedule: "0 9 * * 1", describes: "Mondays", isEnabled: false }], notCreated: [] },
  apps: {
    connected: [{ name: "notion-workspace", label: "Notion", description: "Where the team writes.", pluginId: "notion" }],
    addable: [{ name: "slack", label: "Slack", description: "Post the digest.", pluginId: "slack" }],
    informational: [],
    byo: [],
  },
  integrations: { connected: ["Notion"], offered: ["Slack"], informational: [], unavailable: [] },
  introduction: { started: true },
  message: "SEO Desk is on your roster with 3 facts it now remembers, 1 playbook, 1 job that stays switched off until you turn it on. Slack still need connecting.",
});

/** A gateway that records every call and answers whatever the case tells it to. */
function fakeGateway(answers = {}) {
  const calls = [];
  return {
    calls,
    methods: () => calls.map((call) => call.method),
    argsFor(method) { return calls.filter((call) => call.method === method).map((call) => call.args); },
    async call(method, args = {}) {
      calls.push({ method, args });
      const answer = answers[method];
      if (typeof answer === "function") return answer(args);
      if (answer !== undefined) return answer;
      if (method === "listAgents") return [];
      throw new Error(`unknown gateway method: ${method}`);
    },
  };
}

// ------------------------------------------------------------------ 1. one call, and the id

test("Add is one call to the box's own import, carrying the id and nothing else", async () => {
  const gateway = fakeGateway({ importMarketplaceBot: theReport });
  const outcome = await setup.setUpBot(gateway, theBot);
  assert.deepEqual(gateway.methods(), ["importMarketplaceBot"], "the console did more than ask the box");
  assert.deepEqual(gateway.argsFor("importMarketplaceBot"), [{ id: "seo-desk" }]);
  assert.equal(outcome, theReport, "the box's receipt was rewritten on the way through");
});

test("the row never leaves the browser, so a list card and a whole row make the same call", async () => {
  // The card the Bots tab lists carries no instructions, memories, skills, routines or apps. When
  // the row travelled, a press from the list could create a description-only agent holding nothing.
  const card = { id: "seo-desk", name: "SEO Desk", category: "Marketing", description: theBot.description, counts: { memories: 2, skills: 1, routines: 3, apps: 4 } };
  const fromCard = fakeGateway({ importMarketplaceBot: theReport });
  const fromRow = fakeGateway({ importMarketplaceBot: theReport });
  await setup.setUpBot(fromCard, card);
  await setup.setUpBot(fromRow, theBot);
  assert.deepEqual(fromCard.argsFor("importMarketplaceBot"), fromRow.argsFor("importMarketplaceBot"));
});

test("a deliberate second copy is the only thing that adds an argument", async () => {
  const gateway = fakeGateway({ importMarketplaceBot: { ...theReport, name: "SEO Desk copy" } });
  await setup.setUpBot(gateway, theBot, { duplicate: true });
  assert.deepEqual(gateway.argsFor("importMarketplaceBot"), [{ id: "seo-desk", duplicate: true }]);
  const plain = fakeGateway({ importMarketplaceBot: theReport });
  await setup.setUpBot(plain, theBot, { duplicate: false });
  assert.deepEqual(plain.argsFor("importMarketplaceBot"), [{ id: "seo-desk" }], "duplicate false was sent as an argument");
});

test("installedPluginIds is gone, because it was never once passed and every receipt was wrong for it", async () => {
  // No caller in the product ever handed it over, so `connected` was empty on every box the console
  // ever drew a receipt for. The box works it out for itself now and there is no argument left to
  // forget: an option handed in here must not reach the box as one.
  const gateway = fakeGateway({ importMarketplaceBot: theReport });
  await setup.setUpBot(gateway, theBot, { installedPluginIds: ["notion"] });
  assert.deepEqual(gateway.argsFor("importMarketplaceBot"), [{ id: "seo-desk" }]);
});

// ------------------------------------------------------------------ 2. what the card is given

test("the receipt reaches the card exactly as the box wrote it", async () => {
  const gateway = fakeGateway({ importMarketplaceBot: theReport });
  const outcome = await setup.setUpBot(gateway, theBot);
  assert.equal(outcome.state, "done");
  assert.equal(outcome.agent.id, "a7");
  assert.equal(outcome.memories.added, 3);
  assert.deepEqual(outcome.skills.imported, ["seo-desk-question-map"]);
  assert.equal(outcome.routines.created[0].isEnabled, false);
  // The card names what is not connected off these three buckets, and an app the box carries must
  // not appear in any of them.
  const notConnected = [...outcome.apps.addable, ...outcome.apps.byo, ...outcome.apps.informational].map((row) => row.label);
  assert.deepEqual(notConnected, ["Slack"]);
  assert.ok(!notConnected.includes("Notion"), "an app the box already carries was drawn as missing");
});

test("an already-on-the-roster answer passes through with the id the card opens", async () => {
  const gateway = fakeGateway({
    importMarketplaceBot: { ...theReport, state: "already", alreadyExisted: true, message: "SEO Desk is already on your roster. Open it, or add another copy if you want a second one." },
  });
  const outcome = await setup.setUpBot(gateway, theBot);
  assert.equal(outcome.state, "already");
  assert.equal(outcome.agent.id, "a7");
  assert.match(outcome.message, /already on your roster/);
});

test("both progress phases fire, so the card is not left on its opening sentence", async () => {
  const seen = [];
  const gateway = fakeGateway({ importMarketplaceBot: theReport });
  await setup.setUpBot(gateway, theBot, { onProgress: (step) => seen.push(step) });
  assert.deepEqual(seen.map((step) => step.phase), ["creating", "introducing"]);
  assert.deepEqual(seen.map((step) => step.name), ["SEO Desk", "SEO Desk"]);
  // A copy reports the name the box actually gave it, not the one that was asked for.
  const copies = [];
  const copy = fakeGateway({ importMarketplaceBot: { ...theReport, name: "SEO Desk copy" } });
  await setup.setUpBot(copy, theBot, { duplicate: true, onProgress: (step) => copies.push(step) });
  assert.deepEqual(copies.map((step) => step.name), ["SEO Desk", "SEO Desk copy"]);
});

// ------------------------------------------------------------------ 3. the two sentences a browser owns

test("a box older than the console gets its own sentence, not the host's error text", async () => {
  // The relay serves this console to every workspace, and a box that has not been updated yet does
  // not carry the import. "unknown gateway method: importMarketplaceBot" on the card would read as
  // a bug in the page rather than a box that needs updating.
  const gateway = fakeGateway({
    importMarketplaceBot: () => { throw new Error("unknown gateway method: importMarketplaceBot"); },
  });
  const outcome = await setup.setUpBot(gateway, theBot);
  assert.equal(outcome.state, "failed");
  assert.match(outcome.message, /box is older than the console/);
  assert.match(outcome.message, /Nothing was created/);
  assert.match(outcome.message, /once the box has been updated/);
  assert.ok(!/unknown gateway method|importMarketplaceBot/.test(outcome.message), "the card shows the host's own error text");
  assert.deepEqual(outcome.apps, { connected: [], addable: [], informational: [], byo: [] });
});

test("any other refusal is shown in the box's own words, with the roster said to be untouched", async () => {
  const gateway = fakeGateway({
    importMarketplaceBot: () => { throw new Error("this workspace already holds 12 bots"); },
  });
  const outcome = await setup.setUpBot(gateway, theBot);
  assert.equal(outcome.state, "failed");
  assert.match(outcome.message, /this workspace already holds 12 bots/);
  assert.match(outcome.rolledBack, /roster is as you found it/);
});

test("a box that answers with nothing is a failure, never a blank card", async () => {
  for (const answer of [null, "", 7]) {
    const gateway = fakeGateway({ importMarketplaceBot: () => answer });
    const outcome = await setup.setUpBot(gateway, theBot);
    assert.equal(outcome.state, "failed", `an answer of ${JSON.stringify(answer)} drew a card`);
    assert.match(outcome.message, /answered with nothing/);
  }
});

test("a row with no name or no id is refused before the box is asked", async () => {
  const gateway = fakeGateway();
  await assert.rejects(() => setup.setUpBot(gateway, { id: "x" }), /no name/);
  await assert.rejects(() => setup.setUpBot(gateway, { name: "Nameless id" }), /no id/);
  await assert.rejects(() => setup.setUpBot(gateway, null), /no bot to set up/);
  assert.deepEqual(gateway.methods(), []);
});

// ------------------------------------------------------------------ 4. the roster read

test("alreadyOnRoster answers the agent or null and writes nothing", async () => {
  const gateway = fakeGateway({ listAgents: [{ id: "a0", name: "SEO Desk" }, { id: "a1", name: "Titan" }] });
  const found = await setup.alreadyOnRoster(gateway, theBot);
  assert.equal(found.name, "SEO Desk");
  assert.equal(await setup.alreadyOnRoster(gateway, { ...theBot, name: "Nobody" }), null);
  assert.equal(await setup.alreadyOnRoster(gateway, { id: "x" }), null);
  assert.deepEqual(new Set(gateway.methods()), new Set(["listAgents"]));
});

// ------------------------------------------------------------------ 5. no second copy of the sequence

test("the console holds no second copy of the import, which is the whole point of the move", async () => {
  // Every other case above would still pass if somebody quietly regrew the eight steps here beside
  // the one call. So: the module offers the two things the page uses and nothing else, and the file
  // itself names none of the writing commands.
  assert.deepEqual(Object.keys(setup).sort(), ["alreadyOnRoster", "setUpBot"]);
  const source = readFileSync(path.join(repoRoot, "ui/machine-room/bot-setup.js"), "utf8");
  const body = source.split("\n").filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line)).join("\n");
  for (const command of ["createAgent", "addAgentMemories", "importAgentWorkflowText", "createAgentAutomation", "getAgentWorkflows", "getAgentMemories", "getAgentAutomations", "deleteAgentWorkflow", "deleteAgent", "kickstartAgent"]) {
    assert.ok(!body.includes(command), `bot-setup.js calls ${command} again; the sequence belongs to the box`);
  }
  // And it reaches the box through exactly one command.
  const gateway = fakeGateway({ importMarketplaceBot: theReport, listAgents: [] });
  await setup.alreadyOnRoster(gateway, theBot);
  await setup.setUpBot(gateway, theBot);
  assert.deepEqual(gateway.methods(), ["listAgents", "importMarketplaceBot"]);
});

test("the module loads with no page beside it and reaches no network at load", () => {
  // The Bots tab used to hand this file its persona composition; it composes nothing now, so it
  // must load on its own. `withPage` still works, which is what the panel actually does.
  const alone = installBotSetupModule();
  assert.equal(typeof alone.module.setUpBot, "function");
  const beside = installBotSetupModule({ withPage: true });
  assert.equal(typeof beside.module.setUpBot, "function");
  assert.equal(typeof beside.window.__marketplaceBots.personaFor, "function");
});
