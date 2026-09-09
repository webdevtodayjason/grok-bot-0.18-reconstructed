// TITAN-CATALOG-1. Titan's three catalog tools: the ones that let a bot look at what the
// Marketplace already carries before it builds a new bot out of nothing.
//
// Jason, 2026-09-09 17:40: "Titan should be able to see all connectors and all the agents as a
// catalog. When creating a new agent, it should be able to pull from those templates and ask,
// 'Would you like to use this template or would you like me to create one from scratch?'"
//
// MEASURED BEFORE ANY OF THIS EXISTED, grok-bot-local-vm bundle df1300366eb2, 2026-09-09: asked
// "create me an Instagram marketer" a fresh agent made exactly one call, CreateAgent, and shipped
// an agent with a model-invented persona, 0 memories, 0 routines and no template.
//
// Every case here is a way this could be green and wrong:
//
//   THE FIXTURE IS THE REAL CATALOG. tests/bot-setup.test.mjs writes its bot by hand, in the
//   report's internal vocabulary rather than the catalog's, and that is precisely why nobody
//   noticed for a day that the import read `pluginId`/`description` off rows that carry
//   `plugin`/`line`. So the rows here come from source/shared/marketplace/catalog.ts itself and
//   the ids are FOUND rather than typed, which also means BOTS-4 renaming a row cannot silently
//   turn these assertions into assertions about nothing.
//
//   THERE IS NO INSTAGRAM BOT. Exactly one row in the catalog mentions Instagram and it is a pack.
//   A whole-word match on "marketer" hits nothing at all, which would leave the model with nothing
//   to offer and send it straight back to building blank -- the original bug, wearing a tool. The
//   stemming is what makes marketer and Marketing one token, and it is pinned here.
//
//   TWO ROW SHAPES ARE LIVE AT ONCE. A generated community row carries apps and routines; a
//   first-party pack carries neither and its integrations are bare plugin ids. Both have to read.
//
//   THE CHIPS ARE NOT FREE. Every communicate-wrapped tool is named communicateUpdateToolCall and
//   the console's NOT_A_RECEIPT filter drops it before it renders, so these three ride proto cases
//   of their own. If a name here ever starts matching that filter, the person sees nothing at all.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".titan-catalog-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));

const load = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, `${name}.cjs`);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(bundlePath);
};

const tools = await load("source/host/runner/tools/sand-catalog-tools.ts", "sand-catalog-tools");
const catalog = await load("source/shared/marketplace/catalog.ts", "catalog");
const outline = await load("source/host/runner/conversation-outline.ts", "conversation-outline");
const contextModule = await load("source/packages/context/core.ts", "context-core");
const ctx = () => contextModule.createContext().withName("titan-catalog-test");

// ------------------------------------------------------------------ the runner's own contract

/** The smallest shape the tools use: hand over the initial call, run the body, merge the result. */
function handler() {
  const seen = { initial: null, completed: null };
  return {
    seen,
    executeToolCall: async (context, initial, id, run, merge) => {
      seen.initial = initial;
      const result = await run(context);
      seen.completed = merge(result);
      return result;
    },
  };
}

const runTool = async (built, callArgs, handle = handler()) => {
  const stream = (async function* () { yield JSON.stringify(callArgs); })();
  const result = await built.execute(ctx(), handle, stream, { toolCallId: "call-1" });
  return { result, seen: handle.seen };
};

const byName = (built, name) => {
  const found = built.find((tool) => tool.name === name);
  assert.ok(found != null, `${name} was not built (built: ${built.map((tool) => tool.name).join(", ")})`);
  return found;
};

// -------------------------------------------------------------------- rows out of the catalog

const CARDS = catalog.MARKETPLACE_BOTS.map(catalog.marketplaceBotCardView);

/** A generated community row: one that carries both apps and routines. */
const generatedRow = catalog.MARKETPLACE_BOTS.find(
  (bot) => (bot.apps ?? []).length > 0 && (bot.routines ?? []).length > 0 && (bot.memories ?? []).length > 0,
);
/** A first-party pack: members, and NO apps and NO routines fields at all. */
const packRow = catalog.MARKETPLACE_BOTS.find(
  (bot) => (bot.members ?? []).length > 0 && (bot.apps ?? []).length === 0,
);

/** Plugin rows in the shape the box's own installed-state reader answers, over REAL plugin ids. */
const pluginRows = (installedIds = []) => catalog.MARKETPLACE_PLUGINS.map((plugin) => ({
  pluginId: plugin.id,
  displayName: plugin.name,
  category: plugin.category,
  isInstalled: installedIds.includes(plugin.id),
}));

const deps = ({ installed = [], importBot } = {}) => ({
  listPlugins: async () => pluginRows(installed),
  ...(importBot == null ? {} : { importBot }),
});

// ----------------------------------------------------------------------------- the outline names

test("TITAN-CATALOG-1: each tool's outline row is one the console can see and label", () => {
  const names = [
    tools.CATALOG_SEARCH_OUTLINE_NAME,
    tools.CATALOG_TEMPLATE_OUTLINE_NAME,
    tools.CATALOG_SETUP_OUTLINE_NAME,
  ];
  assert.equal(new Set(names).size, 3, "three tools, three distinct rows, or two chips read as one");
  // The filter the console throws non-receipt rows away with, before the renderer ever sees them.
  const NOT_A_RECEIPT = /communicate|update_state|todo|send.?to.?agent|react.?to.?message|sleep|wait|getmcptools/i;
  for (const name of names) {
    assert.equal(NOT_A_RECEIPT.test(name), false, `${name} would be dropped and draw no chip at all`);
    // getOutlineToolCallName returns the proto case verbatim, so this is the name the page reads.
    assert.equal(outline.getOutlineToolCallName({ tool: { case: name, value: { args: undefined } } }), name);
  }
  assert.equal(NOT_A_RECEIPT.test("communicateUpdateToolCall"), true,
    "which is what defineCommunicateTool would have produced for all three");
});

test("TITAN-CATALOG-1: each tool rides its own proto case when it actually runs", async () => {
  const built = tools.createCatalogTools(deps({ importBot: async () => ({ agentId: "a1" }) }));
  const search = await runTool(byName(built, tools.CATALOG_SEARCH_TOOL_NAME), { query: "marketing" });
  assert.equal(search.seen.initial.tool.case, tools.CATALOG_SEARCH_OUTLINE_NAME);
  const read = await runTool(byName(built, tools.CATALOG_TEMPLATE_TOOL_NAME), { template_id: generatedRow.id });
  assert.equal(read.seen.initial.tool.case, tools.CATALOG_TEMPLATE_OUTLINE_NAME);
  const setup = await runTool(byName(built, tools.CATALOG_SETUP_TOOL_NAME), { template_id: generatedRow.id });
  assert.equal(setup.seen.initial.tool.case, tools.CATALOG_SETUP_OUTLINE_NAME);
});

// --------------------------------------------------------------------------------- the ranking

test("TITAN-CATALOG-1: \"instagram marketer\" finds marketing rows, though no Instagram bot exists", () => {
  // The measured fact this is for: one row in the whole catalog mentions Instagram and it is a
  // pack, and the literal word "marketer" appears in no id, name or category. A whole-word
  // includes() answers nothing here, which is a model with nothing to offer.
  const instagramNamed = CARDS.filter((card) => /instagram/i.test(card.name) || /instagram/i.test(card.id));
  assert.equal(instagramNamed.length, 0, "if an Instagram bot is ever added this case needs rewriting, not deleting");

  const ranked = tools.rankBotsLexically(CARDS, "create me an Instagram marketer");
  assert.ok(ranked.length >= 3, `something to offer, got ${ranked.length}`);
  for (const card of ranked.slice(0, 3)) {
    assert.match(`${card.name} ${card.category} ${card.description}`, /market/i,
      `the closest rows are the marketing ones, got ${card.id} (${card.category})`);
  }
  // And they are real rows, which is what the gate asserts on the box rather than a fixed id.
  for (const card of ranked.slice(0, 3)) {
    assert.ok(catalog.findMarketplaceBot(card.id) != null, `${card.id} is a row that exists`);
  }
});

test("TITAN-CATALOG-1: a marketing query puts a marketing row above an unrelated one", () => {
  const marketing = CARDS.find((card) => card.category === "Marketing");
  assert.ok(marketing != null, "the catalog still has a Marketing category");
  const unrelated = CARDS.find((card) => !/market/i.test(`${card.id} ${card.name} ${card.category} ${card.description}`)
    && !(card.integrations ?? []).some((id) => /market/i.test(id)));
  assert.ok(unrelated != null, "a row with nothing to do with marketing");
  const ranked = tools.rankBotsLexically([unrelated, marketing], "marketing");
  assert.equal(ranked[0]?.id, marketing.id);
  assert.equal(tools.scoreBotForToken(unrelated, "marketing"), 0);
});

test("TITAN-CATALOG-1: a query nothing matches still leaves something to say", () => {
  const answer = tools.describeCatalogListing("zzzzqqqq", CARDS, pluginRows());
  assert.match(answer, /No ready-made bot matches "zzzzqqqq"/);
  assert.match(answer, /build one from scratch/, "the other half of the question is still offered");
  // The categories are named, so the model can ask again with one instead of giving up.
  assert.match(answer, /Marketing/);
});

// ----------------------------------------------------------------------------- the list tool

test("TITAN-CATALOG-1: the list marks an installed plugin installed and an absent one not", async () => {
  const installed = catalog.MARKETPLACE_PLUGINS[0].id;
  const absent = catalog.MARKETPLACE_PLUGINS[1].id;
  const built = tools.createCatalogTools(deps({ installed: [installed] }));
  const { result } = await runTool(byName(built, tools.CATALOG_SEARCH_TOOL_NAME), {});
  const text = result.result.value.message;
  const line = (id) => text.split("\n").find((one) => one.startsWith(`- ${id} · `));
  assert.match(line(installed), /installed on this box$/, `${installed} is installed here`);
  assert.match(line(absent), /not installed$/, `${absent} is not`);
  // A card carries none of the four blocks, so the counts are how the model knows a row is worth
  // reading; and a bot with no query still gets its category heading.
  assert.match(text, /fact\(s\) it already knows/);
  assert.match(text, /job\(s\) that can run on their own/);
  assert.ok(text.includes(`- ${generatedRow.id} · `), "every bot is listed when no query is given");
});

test("TITAN-CATALOG-1: the list never puts a tool name or a raw proto name in front of a person", async () => {
  const built = tools.createCatalogTools(deps());
  const { result } = await runTool(byName(built, tools.CATALOG_SEARCH_TOOL_NAME), { query: "marketing" });
  const text = result.result.value.message;
  // The model may read tool names; the words it is TOLD TO SAY may not carry a proto case.
  for (const leak of ["ToolCall", "getAgentStatus", "communicateUpdate"]) {
    assert.ok(!text.includes(leak), `${leak} must not be in the answer`);
  }
});

// -------------------------------------------------------------------------- the template tool

test("TITAN-CATALOG-1: a generated row comes back with all four blocks and its own reason per app", async () => {
  const built = tools.createCatalogTools(deps({ installed: generatedRow.integrations.slice(0, 1) }));
  const { result } = await runTool(byName(built, tools.CATALOG_TEMPLATE_TOOL_NAME), { template_id: generatedRow.id });
  const text = result.result.value.transcript;
  assert.match(text, new RegExp(`\\(${generatedRow.id}\\)`));
  assert.match(text, new RegExp(`Facts it already knows \\(${generatedRow.memories.length}\\)`));
  assert.match(text, new RegExp(`Playbooks it brings \\(${generatedRow.skills.length}\\)`));
  assert.match(text, new RegExp(`Jobs that run on their own \\(${generatedRow.routines.length}\\)`));
  assert.match(text, new RegExp(`Apps it uses \\(${generatedRow.apps.length}\\)`));
  // THE DEFECT THIS ROW SHAPE CAUSED ELSEWHERE: the catalog writes `plugin` and `line`, and code
  // that reads `pluginId`/`description` puts every app in the bring-your-own bucket and tells a
  // customer that Slack is not something we carry. An app with a plugin id must never read that
  // way here.
  const withPlugin = generatedRow.apps.find((app) => app.plugin != null && app.plugin.length > 0);
  if (withPlugin != null) {
    const line = text.split("\n").find((one) => one.startsWith(`- ${withPlugin.label} · `));
    assert.ok(line != null, `${withPlugin.label} is on the page`);
    assert.doesNotMatch(line, /bring their own/,
      "an app this product HAS a plugin for is never reported as one it does not");
  }
  const withLine = generatedRow.apps.find((app) => (app.line ?? "").length > 0);
  if (withLine != null) assert.ok(text.includes(withLine.line), "the bot's own sentence about the app");
  // And the question the whole wave is about is in the tool's own answer, so the model is told.
  assert.match(text, /one built from scratch/);
});

test("TITAN-CATALOG-1: a pack with no apps and no routines reads without throwing", async () => {
  assert.ok(packRow != null, "the catalog still carries a pack");
  const built = tools.createCatalogTools(deps());
  const { result } = await runTool(byName(built, tools.CATALOG_TEMPLATE_TOOL_NAME), { template_id: packRow.id });
  assert.equal(result.result.case, "success");
  const text = result.result.value.transcript;
  assert.match(text, /Jobs that run on their own \(0\)/);
  assert.match(text, new RegExp(`a team of ${packRow.members.length}`));
  // Its integrations are bare plugin ids with no app row beside them, and they still get a line
  // each with whether this box has them.
  assert.match(text, new RegExp(`Apps it uses \\(${packRow.integrations.length}\\)`));
});

test("TITAN-CATALOG-1: an id the catalog does not carry is said in words, not thrown", async () => {
  const built = tools.createCatalogTools(deps());
  const { result } = await runTool(byName(built, tools.CATALOG_TEMPLATE_TOOL_NAME), { template_id: "no-such-bot" });
  assert.equal(result.result.case, "success");
  assert.match(result.result.value.transcript, /No ready-made bot with id "no-such-bot"/);
});

// ----------------------------------------------------------------------------- the setup tool

test("TITAN-CATALOG-1: the setup tool hands the verb its arguments and reports what came back", async () => {
  const calls = [];
  const built = tools.createCatalogTools(deps({
    importBot: async (args) => {
      calls.push(args);
      return {
        agentId: "agent-9",
        name: "Search Desk",
        memories: 4,
        skills: ["a", "b"],
        routines: 3,
        integrations: { connected: ["Slack"], offered: ["Notion"], unavailable: ["Profound"] },
      };
    },
  }));
  const { result, seen } = await runTool(byName(built, tools.CATALOG_SETUP_TOOL_NAME), {
    template_id: generatedRow.id, name: "Search Desk",
  });
  assert.deepEqual(calls, [{ id: generatedRow.id, name: "Search Desk" }]);
  assert.equal(result.result.case, "success");
  assert.equal(result.result.value.agentId, "agent-9");
  const message = result.result.value.message;
  assert.match(message, /Set up "Search Desk" \(id agent-9\) from the catalog/);
  // A count that arrives as a list and a list that arrives as a count read the same, because the
  // verb and these tools were written by two hands at the same time.
  assert.match(message, /knows 4 fact\(s\), brings 2 playbook\(s\) and carries 3 job\(s\)/);
  assert.match(message, /switched OFF/);
  assert.match(message, /Already connected here: Slack\./);
  assert.match(message, /Ready to add from the Marketplace: Notion\./);
  assert.match(message, /bring their own: Profound\./);
  // The chip's ONLY source: the readable name has to be in the call's own args.
  assert.equal(seen.initial.tool.value.args.name, "Search Desk");
  assert.equal(seen.initial.tool.value.args.prompt, generatedRow.id);
});

test("TITAN-CATALOG-1: with no name given, the chip still carries the ready-made bot's own name", async () => {
  const built = tools.createCatalogTools(deps({ importBot: async () => ({ agentId: "a", name: generatedRow.name }) }));
  const { seen } = await runTool(byName(built, tools.CATALOG_SETUP_TOOL_NAME), { template_id: generatedRow.id });
  assert.equal(seen.initial.tool.value.args.name, generatedRow.name);
});

test("TITAN-CATALOG-1: a bot already on the roster is reported as already there, not as created", async () => {
  const built = tools.createCatalogTools(deps({
    importBot: async () => ({ name: generatedRow.name, alreadyExisted: true }),
  }));
  const { result } = await runTool(byName(built, tools.CATALOG_SETUP_TOOL_NAME), { template_id: generatedRow.id });
  const message = result.result.value.message;
  assert.match(message, /is already on the roster, so nothing was created/);
  assert.doesNotMatch(message, /^Set up/);
});

test("TITAN-CATALOG-1: with no import on this box the setup tool is not offered at all", () => {
  const built = tools.createCatalogTools(deps());
  const names = built.map((tool) => tool.name);
  assert.deepEqual(names, [tools.CATALOG_SEARCH_TOOL_NAME, tools.CATALOG_TEMPLATE_TOOL_NAME],
    "a tool offered against an importer that is not there is a tool that can only fail");
  const withImport = tools.createCatalogTools(deps({ importBot: async () => ({}) }));
  assert.equal(withImport.length, 3);
});

test("TITAN-CATALOG-1: a verb that throws says so and does not claim a bot was made", async () => {
  const built = tools.createCatalogTools(deps({
    importBot: async () => { throw new Error("the roster is full"); },
  }));
  const { result } = await runTool(byName(built, tools.CATALOG_SETUP_TOOL_NAME), { template_id: generatedRow.id });
  assert.equal(result.result.case, "error");
  assert.match(result.result.value.error, /the roster is full/);
});

// ------------------------------------------------------------------------------------ the chips

const adapterPath = path.join(repoRoot, "ui/machine-room/gateway-adapter.js");
const between = (source, startMark, endMark, what) => {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error(`could not slice ${what} out of the console source`);
  return source.slice(start, end);
};
// The same slice tests/machine-room-mail-chip.test.mjs takes, so the chip tests cannot drift into
// disagreeing copies of one block.
function loadToolRow() {
  const source = readFileSync(adapterPath, "utf8");
  const body = between(source, "  const PROBLEM_REPORT_TOOL_CALL =", "  const messageKey =", "the tool-row block");
  return new Function(`${body}\nreturn { toolRowText, TOOL_LABELS, CATALOG_LIST_TOOL_CALL, CATALOG_READ_TOOL_CALL, CATALOG_SETUP_TOOL_CALL };`)();
}

test("TITAN-CATALOG-1: the console draws three plain sentences and no tool name", () => {
  const { toolRowText, CATALOG_LIST_TOOL_CALL, CATALOG_READ_TOOL_CALL, CATALOG_SETUP_TOOL_CALL } = loadToolRow();
  // The three names the host writes and the three the console reads are the same three.
  assert.equal(CATALOG_LIST_TOOL_CALL, tools.CATALOG_SEARCH_OUTLINE_NAME);
  assert.equal(CATALOG_READ_TOOL_CALL, tools.CATALOG_TEMPLATE_OUTLINE_NAME);
  assert.equal(CATALOG_SETUP_TOOL_CALL, tools.CATALOG_SETUP_OUTLINE_NAME);

  const list = toolRowText({ id: "t1", name: CATALOG_LIST_TOOL_CALL, status: "done", summary: JSON.stringify({ agentIds: ["marketing"] }) });
  assert.equal(list.text, "Looked at the catalog");
  assert.equal(list.detail, "", "an empty detail is what makes app.js draw a bubble and not an expander");

  const read = toolRowText({ id: "t2", name: CATALOG_READ_TOOL_CALL, status: "done", summary: JSON.stringify({ agentId: "seo-desk" }) });
  assert.equal(read.text, "Read a template");
  assert.equal(read.detail, "");

  const setup = toolRowText({ id: "t3", name: CATALOG_SETUP_TOOL_CALL, status: "done", summary: JSON.stringify({ name: "SEO Desk", prompt: "seo-desk" }) });
  assert.equal(setup.text, "Set up SEO Desk from the catalog");
  assert.equal(setup.detail, "");

  for (const drawn of [list, read, setup]) {
    assert.equal(drawn.kind, "Catalog");
    for (const leak of ["ToolCall", "getAgentStatus", "readAgentTranscript", "createAgent", "CATALOG_"]) {
      assert.ok(!drawn.text.includes(leak) && !drawn.detail.includes(leak), `${leak} must not reach the page`);
    }
  }
});

test("TITAN-CATALOG-1: a setup still running, or one that failed, never reads as one that worked", () => {
  const { toolRowText, CATALOG_SETUP_TOOL_CALL } = loadToolRow();
  const row = (status) => toolRowText({ id: "t", name: CATALOG_SETUP_TOOL_CALL, status, summary: JSON.stringify({ name: "SEO Desk" }) });
  assert.equal(row("pending").text, "Setting up SEO Desk from the catalog");
  assert.equal(row("failed").text, "Tried to set up SEO Desk from the catalog · it did not finish");
  assert.doesNotMatch(row("failed").text, /^Set up SEO Desk from the catalog$/);
  // A row the page cannot read a name out of falls back to words, never to the proto name.
  const bare = toolRowText({ id: "t", name: CATALOG_SETUP_TOOL_CALL, status: "done", summary: "" });
  assert.equal(bare.text, "Set up a bot from the catalog");
});

test("TITAN-CATALOG-1: the labels are in the table, and the two chips beside them are untouched", () => {
  const { TOOL_LABELS, CATALOG_LIST_TOOL_CALL, CATALOG_READ_TOOL_CALL, CATALOG_SETUP_TOOL_CALL } = loadToolRow();
  for (const name of [CATALOG_LIST_TOOL_CALL, CATALOG_READ_TOOL_CALL, CATALOG_SETUP_TOOL_CALL]) {
    assert.equal(TOOL_LABELS[name], "Catalog", `a name missing from this table is headlined with the raw proto name`);
  }
  assert.equal(TOOL_LABELS.reportBugToolCall, "Report");
  assert.equal(TOOL_LABELS.sendToUserToolCall, "Email");
  assert.equal(TOOL_LABELS.shellToolCall, "Shell");
});

// ------------------------------------------------------------- the words the person is promised

test("TITAN-CATALOG-1: the standing persona asks the question, in first person and with no tool name", () => {
  const persona = readFileSync(path.join(repoRoot, "source/host/runner/standing-persona.ts"), "utf8");
  // The sentences are written as concatenated string literals, so the source is read with those
  // joins closed up: a phrase that straddles a `" + "` is one phrase in the prompt and has to be
  // one phrase here, or this test passes on a sentence that says something else.
  const section = between(persona, "export function renderStandingPersonaSection", "\n}\n", "the persona section")
    .replace(/"\s*\n?\s*\+\s*"/g, "");
  assert.match(section, /one of those or one built from scratch/, "the question Jason asked for");
  assert.match(section, /Marketplace already carries/);
  // The paragraph is in the general block, because the tools behind it are offered to every
  // top-level agent and not only to a box that happens to have a lead marker written.
  const leadAt = section.indexOf("if (isLead)");
  const catalogAt = section.indexOf("one built from scratch");
  assert.ok(catalogAt > 0 && catalogAt < leadAt, "the catalog paragraph is not behind the lead gate");
  // The comments in that function name tools on purpose; the SENTENCES may not. Strip the comment
  // lines and check what is left, which is what a model is handed and what a person hears back.
  const words = section.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const name of ["SearchBotCatalog", "GetBotTemplate", "CreateAgentFromTemplate", "CreateAgent"]) {
    assert.ok(!words.includes(name), `${name} must not be in words a person reads`);
  }
});

test("TITAN-CATALOG-1: the onboarding skill sends them to the catalog before it builds anything blank", () => {
  const skill = readFileSync(
    path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills/onboarding/SKILL.md"), "utf8",
  );
  assert.match(skill, /A new bot starts from the catalog/);
  assert.match(skill, /one of those or one built from scratch/);
  // The generated module has to agree with the file or a swap ships the old words. Escaped the way
  // scripts/gen-seed-skills.mjs escapes it, backslashes first.
  const generated = readFileSync(
    path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills.gen.ts"), "utf8",
  );
  const asTemplateLiteral = skill.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  assert.ok(generated.includes(asTemplateLiteral),
    "onboarding/SKILL.md is what seed-skills.gen.ts carries — re-run scripts/gen-seed-skills.mjs");
});

// ------------------------------------------------- the seam between the wave's two halves

// TITAN-CATALOG-1. The setup tool is only built when an importer is handed in, which is right --
// but it means a broken wiring line does not fail anything above: the two read-only tools still
// build, the bot still looks at the catalog, and the only symptom is that it can never actually
// set one up. That is invisible in every case in this file. The box gate measures the live
// article; these three cases stop the wiring being deleted between gates.
test("TITAN-CATALOG-1: the host hands the catalog tools the one import the console's Add uses", () => {
  const host = readFileSync(path.join(repoRoot, "source/host/sand-host.ts"), "utf8");
  assert.match(host, /setMarketplaceImporter/,
    "nothing wires the importer, so the setup tool is never offered on a real box");
  assert.match(host, /getApi\(\)\.importMarketplaceBot/,
    "the importer has to be the gateway api's own command, not a second sequence");
});

test("TITAN-CATALOG-1: the composition reads the importer per turn rather than capturing it", () => {
  const composition = readFileSync(path.join(repoRoot, "source/host/host-runner-composition.ts"), "utf8");
  assert.match(composition, /setMarketplaceImporter/);
  assert.match(composition, /importBot: args => marketplaceImporter!\(args\)/,
    "the holder is set after the composition is built, so capturing its value strands every turn");
});

test("TITAN-CATALOG-1: no second import adapter is built beside the gateway api's", () => {
  const composition = readFileSync(path.join(repoRoot, "source/host/host-runner-composition.ts"), "utf8");
  // The one adapter lives in host-gateway-api.ts and is built out of mintAgent,
  // removeAgentCompletely, createAutomationFor and the host's kickstartIfPending. A second one
  // assembled here out of the manager alone would differ in agent teardown, automation
  // attribution and the introduction -- which is the drift this whole wave exists to end.
  assert.doesNotMatch(composition, /from "[^"]*marketplace-bot-import/,
    "two adapters means the console's Add and the bot's request reach different boxes");
  const gatewayApi = readFileSync(path.join(repoRoot, "source/host/host-gateway-api.ts"), "utf8");
  assert.match(gatewayApi, /const marketplaceImportBox: MarketplaceImportBox = \{/,
    "the one adapter lives in the gateway api, beside mintAgent and removeAgentCompletely");
});
