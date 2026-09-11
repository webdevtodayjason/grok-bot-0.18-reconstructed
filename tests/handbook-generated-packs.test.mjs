// KB-1c. The two handbook packs that derive from the Marketplace catalogs, and the validators that
// stop them drifting away from it.
//
// WHAT THESE CASES ARE FOR. A pack is a restatement of the catalog in an owner's words, and a
// restatement nobody checks is wrong by the next release. Four things can rot independently:
//
//   1. Somebody hand-edits a generated SKILL.md. The first case regenerates in memory and asserts
//      the checked-in file is byte identical, which is the same guard tests/community-bots.test.mjs
//      puts on community-bots.ts.
//   2. A new plugin lands with a credential nobody wrote a plain phrase for, so Titan reads the
//      operator's own label out loud and says a word the console bans on a customer's screen.
//   3. A catalog label, tagline, bot id or routine title moves, and the overlay keeps pointing at
//      the string that used to be there.
//   4. A routine whose cron resolved to null gets described as a schedule, which promises a job
//      that is dead the day somebody switches it on (docs/BOTS.md section 2).
//
// Each of those has a case that injects the failure and asserts the generator REFUSES, because a
// validator nobody has ever seen fire is a validator that does not work.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

import {
  PACK_BODY_CEILING,
  buildPacks,
  buildSweep,
  cadenceOf,
  loadCatalog,
  mintedAt,
  pluginShape,
  publishedWordLists,
  readJson,
  renderConnectorPack,
  resolvePhrases,
  resolveStarters,
  spokenLines,
} from "../scripts/gen-handbook-packs.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const handbookDir = path.join(repoRoot, "source/host/extensions/managed-setup/handbook");
const seedDir = path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills");

const catalog = await loadCatalog();
const settingsSource = readFileSync(path.join(repoRoot, "ui/machine-room/settings.js"), "utf8");
const phrasesOnDisk = readJson(path.join(handbookDir, "connector-phrases.json"));
const startersOnDisk = readJson(path.join(handbookDir, "starter-packs.json"));

/** A deep copy, so a case can break an overlay without breaking the next case. */
const copy = (value) => JSON.parse(JSON.stringify(value));
const build = (overrides = {}) => buildPacks({ catalog, phrases: phrasesOnDisk, starters: startersOnDisk, settingsSource, ...overrides });
const built = build();

// The host's own workflow model, bundled here rather than reimplemented, so section 7 measures what
// an invoking turn is really handed instead of estimating it. It has to be staged and required
// BEFORE the first test() below: node:test starts the declared cases on the first await, and the
// after() hook would then remove the stage while a later top-level await was still queued.
const modelStage = mkdtempSync(path.join(repoRoot, "node_modules", ".handbook-packs-test-"));
after(() => rmSync(modelStage, { recursive: true, force: true }));
const modelBundle = await esbuild({
  entryPoints: [path.join(repoRoot, "source/shared/workflow-model.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
});
const modelPath = path.join(modelStage, "workflow-model.cjs");
writeFileSync(modelPath, modelBundle.outputFiles[0].text, "utf8");
const { WORKFLOW_INJECTED_BODY_LIMIT, WORKFLOW_MAX_DESCRIPTION_LENGTH, WORKFLOW_MAX_NAME_LENGTH, injectedWorkflowBody, parseWorkflowFile } =
  createRequire(import.meta.url)(modelPath);
const bodyOf = (text) => text.slice(text.indexOf("\n---\n", 4) + 5);

const FILES = [
  ["handbook-connect-an-app", "connect"],
  ["handbook-starter-packs", "packs"],
];

// ----------------------------------------------------------------------------- 1. nobody hand-edits
test("regenerating both packs reproduces the checked-in files byte for byte", () => {
  for (const [id, key] of FILES) {
    const onDisk = readFileSync(path.join(seedDir, id, "SKILL.md"), "utf8");
    assert.equal(built[key], onDisk, `${id}/SKILL.md is not what the generator produces; run node scripts/gen-handbook-packs.mjs`);
  }
});

test("both packs carry the frontmatter the seed loader needs, and an id-shaped directory", () => {
  for (const [id, key] of FILES) {
    const text = built[key];
    assert.ok(text.startsWith("---\n"), `${id} has no YAML frontmatter, and gen-seed-skills.mjs throws on that`);
    assert.match(text, /\nname: \S/, `${id} declares no name, so the seed would be named after its directory`);
    assert.match(text, /\ndescription: >-\n/, `${id} declares no description, and a description is the only thing a catalog listing can show`);
    assert.match(id, /^handbook-[a-z0-9-]+$/, "a pack id is lowercase kebab and prefixed, so an owner's own skill cannot shadow it and sand-workflow:<id> still matches");
    assert.ok(bodyOf(text).length > 0);
  }
});

test("each body sits under the injection ceiling with real headroom", () => {
  for (const [id, key] of FILES) {
    const length = bodyOf(built[key]).length;
    assert.ok(length <= PACK_BODY_CEILING, `${id} is ${length} characters, over the ${PACK_BODY_CEILING} ceiling`);
    // WORKFLOW_INJECTED_BODY_LIMIT is 16,000 and cuts at a line break with a pointer; the ceiling is
    // below it so a pack is never cut at all. Under 1,000 characters of headroom means the next
    // plugin row pushes the generator into its table fallback, which is worth knowing before it does.
    assert.ok(PACK_BODY_CEILING - length >= 1_000, `${id} has only ${PACK_BODY_CEILING - length} characters of headroom left`);
  }
});

// ------------------------------------------------------------------- 2. every credential has a phrase
test("every declared credential field has a plain phrase, and nothing else does", () => {
  const declared = catalog.plugins.flatMap((plugin) => (plugin.credentials ?? []).map((credential) => credential.field));
  assert.equal(declared.length, 17, "the catalog's credential count moved; the pack's own header says how many boxes there are");
  assert.deepEqual(
    [...declared].sort(),
    Object.keys(phrasesOnDisk.credentials).sort(),
    "connector-phrases.json and the catalog disagree about which credentials exist",
  );
});

test("the generator refuses a keyed plugin whose credential has no phrase", () => {
  const phrases = copy(phrasesOnDisk);
  delete phrases.credentials.TODOIST_API_KEY;
  assert.throws(() => build({ phrases }), /no phrase for todoist's TODOIST_API_KEY/);
});

test("the generator refuses a phrase for a credential the catalog no longer declares", () => {
  const phrases = copy(phrasesOnDisk);
  phrases.credentials.GONE_AWAY_API_KEY = { plugin: "todoist", replaces: "Gone", say: "the one thing" };
  assert.throws(() => build({ phrases }), /GONE_AWAY_API_KEY .* which no catalog row declares any more/);
});

test("the generator refuses an overlay entry whose replaced label has moved", () => {
  const phrases = copy(phrasesOnDisk);
  phrases.credentials.TODOIST_API_KEY.replaces = "Todoist API key that was renamed";
  assert.throws(() => build({ phrases }), /but the catalog's label is now "Todoist API token"/);
});

test("the generator refuses an overlay entry filed under the wrong plugin", () => {
  const phrases = copy(phrasesOnDisk);
  phrases.credentials.TODOIST_API_KEY.plugin = "linear";
  assert.throws(() => build({ phrases }), /maps TODOIST_API_KEY to plugin "linear"/);
});

test("the generator refuses a phrase that puts a banned word in Titan's mouth", () => {
  const phrases = copy(phrasesOnDisk);
  phrases.credentials.TODOIST_API_KEY.say = "the API key Todoist gives you";
  assert.throws(() => build({ phrases }), /carries "key", which a customer may never hear/);
});

test("the generator refuses a phrase naming a vendor that is not a Marketplace row", () => {
  const phrases = copy(phrasesOnDisk);
  phrases.credentials.TODOIST_API_KEY.say = "the one thing anthropic gives you";
  assert.throws(() => build({ phrases }), /carries "anthropic"/);
});

test("a tagline that trips the sweep needs a replacement naming the exact catalog string", () => {
  const phrases = copy(phrasesOnDisk);
  delete phrases.taglines.buffer;
  assert.throws(() => build({ phrases }), /buffer's catalog tagline carries "key" and has no plain-words replacement/);

  const moved = copy(phrasesOnDisk);
  moved.taglines.buffer.replaces = "Schedule to eleven networks, somehow";
  assert.throws(() => build({ phrases: moved }), /rewrites buffer's tagline .* but the catalog's tagline is now/);
});

// ----------------------------------------------------------- 3. every id and cron the packs cite
test("the pack's own shape counts are the catalog's, not a claim", () => {
  const shapes = { keyed: 0, free: 0, page: 0, editor: 0 };
  for (const plugin of catalog.plugins) shapes[pluginShape(plugin)] += 1;
  assert.equal(catalog.plugins.length, 24);
  assert.deepEqual(shapes, { keyed: 13, free: 6, page: 4, editor: 1 });
  const keyed = catalog.plugins.filter((plugin) => (plugin.credentials ?? []).length > 0);
  assert.equal(keyed.length, 14, "13 keyed rows install something and Browserbase installs nothing and still takes two");
  const needNothing = catalog.plugins.filter((plugin) => (plugin.credentials ?? []).length === 0 && plugin.installsNothing !== true);
  assert.equal(needNothing.length, 7, "six rows press-Add-and-work, plus the one that opens the editor");
  const body = bodyOf(built.connect);
  assert.match(body, /## 14 apps want something filled in, 17 boxes in all/);
  assert.match(body, /## 6 apps want nothing at all/);
  assert.match(body, /## 4 rows put nothing on the box at all/);
  assert.match(body, /seven rows ask for nothing at all/);
  for (const plugin of catalog.plugins) assert.ok(body.includes(plugin.name), `the connector pack never names ${plugin.id}`);
});

test("every minted-at line is a verbatim prefix of the catalog's own hint", () => {
  for (const plugin of catalog.plugins) {
    for (const credential of plugin.credentials ?? []) {
      const rendered = mintedAt(credential.hint);
      const stem = rendered.endsWith(".") ? rendered.slice(0, -1) : rendered;
      assert.ok(credential.hint.includes(stem), `${credential.field}'s minted-at line is not a substring of its catalog hint`);
      assert.ok(bodyOf(built.connect).includes(rendered), `${credential.field}'s minted-at line is not in the rendered pack`);
    }
  }
});

test("every bot and routine a starter pack cites is in the catalog, with the cron the catalog resolved", () => {
  const ids = new Set(catalog.bots.map((bot) => bot.id));
  const body = bodyOf(built.packs);
  for (const [id] of Object.entries(startersOnDisk.bots)) assert.ok(ids.has(id), `starter-packs.json describes "${id}", which is not in the catalog`);
  for (const persona of startersOnDisk.personas) {
    for (const id of persona.bots ?? []) {
      assert.ok(ids.has(id), `persona ${persona.id} names "${id}"`);
      assert.ok(body.includes(`\`${id}\``), `persona ${persona.id}'s bot "${id}" is not in the rendered pack`);
    }
    for (const cited of persona.routines ?? []) {
      const bot = catalog.bots.find((row) => row.id === cited.bot);
      const routine = (bot.routines ?? []).find((row) => row.name === cited.name);
      assert.ok(routine != null, `"${cited.name}" is not a routine on ${cited.bot}`);
      assert.ok(routine.schedule != null, `"${cited.name}" has no cron and is listed under the jobs to switch on`);
      assert.ok(body.includes(`\`${routine.schedule}\``), `the pack does not render ${cited.bot}'s "${cited.name}" cron`);
      assert.ok(routine.scheduleNote.startsWith(cadenceOf(routine.scheduleNote)), "a rendered cadence must be a prefix of the catalog's own note");
    }
    for (const cited of persona.notCreated ?? []) {
      const bot = catalog.bots.find((row) => row.id === cited.bot);
      const routine = (bot.routines ?? []).find((row) => row.name === cited.name);
      assert.ok(routine != null, `"${cited.name}" is not a routine on ${cited.bot}`);
      assert.equal(routine.schedule, null, `"${cited.name}" is called uncreatable and the catalog resolved it`);
    }
  }
});

test("no cron:null routine is anywhere in the rendered pack as a schedule", () => {
  const body = bodyOf(built.packs);
  // The 13 routines the catalog refuses to create, wherever they are cited, appear only under the
  // not-created heading and carry the catalog's own sentence saying why.
  const nullNames = catalog.bots.flatMap((bot) => (bot.routines ?? []).filter((row) => row.schedule == null).map((row) => ({ bot: bot.id, row })));
  assert.ok(nullNames.length > 0, "the catalog no longer has a routine without a cron, and this case is the guard on that class");
  for (const { row } of nullNames) {
    if (!body.includes(`**${row.name}**`)) continue;
    const at = body.indexOf(`**${row.name}**`);
    const heading = body.lastIndexOf("Not created at all", at);
    assert.ok(heading > 0 && heading < at, `"${row.name}" has no cron and is rendered outside the not-created section`);
  }
});

test("the generator refuses an unknown bot id", () => {
  const starters = copy(startersOnDisk);
  starters.personas[0].bots.push("there-is-no-such-bot");
  assert.throws(() => build({ starters }), /names bot "there-is-no-such-bot", which is not in the catalog/);

  const described = copy(startersOnDisk);
  described.bots["there-is-no-such-bot"] = "Does a thing.";
  assert.throws(() => build({ starters: described }), /describes bot "there-is-no-such-bot"/);
});

test("the generator refuses a bot with no owner-facing line", () => {
  const starters = copy(startersOnDisk);
  delete starters.bots["site-audit"];
  assert.throws(() => build({ starters }), /names bot "site-audit", which has no line/);
});

test("the generator refuses a routine title the bot does not carry", () => {
  const starters = copy(startersOnDisk);
  starters.personas[0].routines[0].name = "Daily shipment status report";
  assert.throws(() => build({ starters }), /cites routine "Daily shipment status report" on "office-ops-desk", which that bot does not carry/);
});

test("the generator refuses a cron:null routine listed as a job to switch on", () => {
  const starters = copy(startersOnDisk);
  starters.personas[1].routines.push({ bot: "follow-through-agent", name: "Commitment-strand audit" });
  assert.throws(() => build({ starters }), /its cron resolved to null: it is not created at all/);
});

test("the generator refuses a real cron listed as uncreatable", () => {
  const starters = copy(startersOnDisk);
  starters.personas[1].notCreated.push({ bot: "call-follow-ups", name: "Morning follow-up check" });
  assert.throws(() => build({ starters }), /uncreatable, but the catalog resolved it to "0 9 \* \* 1-5"/);
});

test("the generator refuses a team pack the import verb would not refuse", () => {
  const starters = copy(startersOnDisk);
  starters.personas.at(-1).team = "todoist-is-not-a-bot";
  assert.throws(() => build({ starters }), /names team pack "todoist-is-not-a-bot"/);

  const single = copy(startersOnDisk);
  single.personas.at(-1).team = "site-audit";
  assert.throws(() => build({ starters: single }), /the catalog row carries no members, so the import verb would not refuse it/);
});

test("the marketing pack is rendered as a team with its real members and the refusal", () => {
  const team = catalog.bots.find((bot) => bot.id === "marketing-team");
  const body = bodyOf(built.packs);
  assert.equal(team.members.length, 7);
  for (const member of team.members) assert.ok(body.includes(member.role), `the pack never names the ${member.role}`);
  assert.match(body, /CreateAgentFromTemplate refuses it/);
  assert.match(body, /A refusal is not a success/);
  assert.match(body, /Import team/);
});

// ------------------------------------------------------------------------ 4. the spoken-line sweep
test("no spoken line in either pack carries a banned word or a vendor that is not a Marketplace row", () => {
  const sweep = buildSweep({ ...publishedWordLists(settingsSource), plugins: catalog.plugins });
  assert.deepEqual([...sweep.allowedVendors].sort(), ["browser-use", "github", "resend", "slack"]);
  for (const vendor of ["openai", "xai", "anthropic", "z.ai", "glm", "grok", "firebase", "apns", "coolify", "s3"]) {
    assert.ok(sweep.bannedVendors.includes(vendor), `${vendor} must stay unsayable to a customer`);
  }
  for (const [id, key] of FILES) {
    const lines = spokenLines(built[key]);
    assert.ok(lines.length >= 8, `${id} has only ${lines.length} owner-facing lines, which is not a pack a person could be read to from`);
    for (const line of lines) assert.equal(sweep.hit(line), null, `${id} has a spoken line carrying a forbidden word: ${line}`);
  }
});

test("the sweep fires on a vendor a customer may never hear, and not on a Marketplace row", () => {
  const sweep = buildSweep({ ...publishedWordLists(settingsSource), plugins: catalog.plugins });
  assert.equal(sweep.hit("Marketplace, then Plugins, then GitHub, then Accounts."), null);
  assert.equal(sweep.hit("Slack and Resend both take one box."), null);
  assert.equal(sweep.hit("I will ask xai about it."), "xai");
  assert.equal(sweep.hit("paste the key here"), "key");
  assert.equal(sweep.hit("there is a webhook for that"), "webhook");
  assert.equal(sweep.hit("your keyboard is fine"), null, "the published regex is whole-word at both ends");
  assert.equal(sweep.hit("one thing, the private half"), null);
  assert.equal(sweep.hit("this one — that one"), "an em dash");
});

test("the sweep reads the console's own published lists rather than a second copy", () => {
  const lists = publishedWordLists(settingsSource);
  assert.deepEqual(lists.bannedWords, ["key", "keys", "token", "tokens", "secret", "secrets", "endpoint", "endpoints", "relay", "proxy", "webhook"]);
  assert.ok(lists.bannedVendors.includes("grok") && lists.bannedVendors.includes("github"));
  assert.throws(() => publishedWordLists("const BANNED_VENDORS = [];"), /BANNED_WORDS is no longer a one-line array literal/);
  assert.throws(() => publishedWordLists('const BANNED_WORDS = ["key"];\nconst BANNED_VENDORS = [];'), /BANNED_VENDORS parsed empty/);
});

// -------------------------------------------------------------- 5. the fallback, rather than a break
test("a catalog too big for one read collapses its long tail into a table instead of failing", () => {
  const sweep = buildSweep({ ...publishedWordLists(settingsSource), plugins: catalog.plugins });
  const { byField, taglines } = resolvePhrases({ plugins: catalog.plugins, phrases: phrasesOnDisk, sweep });
  const tight = renderConnectorPack({ plugins: catalog.plugins, shellTools: catalog.shellTools, taglines, byField, sweep, ceiling: 11_000 });
  const body = bodyOf(tight);
  assert.ok(body.length <= 11_000, `the fallback left ${body.length} characters against an 11,000 ceiling`);
  assert.match(body, /\| App \| What it is for \| Boxes \|/);
  // Collapsed rows are still NAMED: a pack that silently dropped CodeRabbit would be worse than a
  // long one, because Titan would tell an owner the product cannot do something it can.
  for (const plugin of catalog.plugins) assert.ok(body.includes(plugin.name), `the fallback dropped ${plugin.id} entirely`);
  for (const line of spokenLines(tight)) assert.equal(sweep.hit(line), null, `the fallback shipped a spoken line carrying a forbidden word: ${line}`);

  // Past what collapsing the keyed list can buy, the renderer hands back the smallest form it has
  // and the CALLER refuses: buildPacks checks the real ceiling, so an unfittable pack is a loud
  // generator failure rather than a body the injection cap cuts at a line break.
  const floor = renderConnectorPack({ plugins: catalog.plugins, shellTools: catalog.shellTools, taglines, byField, sweep, ceiling: 1 });
  assert.ok(bodyOf(floor).length > 1, "an unreachable ceiling must still produce the collapsed pack");
  assert.ok(bodyOf(floor).length < bodyOf(built.connect).length);
});

// ------------------------------------------------------ 6. the two pure readers, pinned on their own
test("mintedAt picks the sentence that says where, and stops before the permissions", () => {
  assert.equal(
    mintedAt("A GitHub fine-grained personal access token. Create one under Settings (github.com/x); reading needs Contents: read."),
    "Create one under Settings (github.com/x).",
  );
  assert.equal(mintedAt("The project id from the same Settings page."), "The project id from the same Settings page.");
  assert.throws(() => mintedAt(""), /rendered no sentence at all/);
});

test("cadenceOf keeps the cadence and drops the repeated explanation, in both catalog shapes", () => {
  assert.equal(cadenceOf("Weekdays at 9:00 AM, the default hour, because this routine names a cadence and no clock."), "Weekdays at 9:00 AM");
  assert.equal(cadenceOf("Every Monday at 9:00 AM. It states a week and names no day, so Monday is the declared default."), "Every Monday at 9:00 AM");
  assert.equal(cadenceOf("On the 1st of every month at 9:00 AM, the default hour, because x."), "On the 1st of every month at 9:00 AM");
  assert.throws(() => cadenceOf(". nothing before it"), /rendered no cadence/);
});

test("resolveStarters hands back the catalog's titles and categories, never the overlay's", () => {
  const sweep = buildSweep({ ...publishedWordLists(settingsSource), plugins: catalog.plugins });
  const personas = resolveStarters({ bots: catalog.bots, starters: startersOnDisk, sweep });
  assert.equal(personas.length, 5);
  const flowers = personas.find((persona) => persona.id === "flower-shop");
  const frank = flowers.members.find((member) => member.bot.id === "frank");
  assert.equal(frank.bot.name, catalog.bots.find((bot) => bot.id === "frank").name);
  assert.equal(frank.bot.category, "Operations");
  assert.equal(flowers.routines.length, 4);
  assert.ok(personas.every((persona) => persona.team != null || persona.members.length > 0));
});

// ------------------------------------------- 7. what a turn that reads one of these is really handed
//
// Not an estimate: injectedWorkflowBody is the function the invoking turn goes through. The failure
// it guards is the one Wave T found on the learn recipe -- a body past the cap is cut at a line
// break, the model reads the cut as the end of the recipe, and the pack has silently lost whichever
// rule happened to be last.
test("both packs parse into a seedable skill and reach the model whole", () => {
  assert.equal(PACK_BODY_CEILING < WORKFLOW_INJECTED_BODY_LIMIT, true, "the pack ceiling has to sit under the host's own injection cap");
  for (const [id, key] of FILES) {
    const parsed = parseWorkflowFile(built[key]);
    assert.ok(parsed != null, `${id} does not parse as a SKILL.md at all`);
    assert.ok(parsed.name.length > 0 && parsed.name.length <= WORKFLOW_MAX_NAME_LENGTH, `${id}'s name is ${parsed.name.length} characters`);
    assert.ok(parsed.description.length > 0 && parsed.description.length <= WORKFLOW_MAX_DESCRIPTION_LENGTH, `${id}'s description is ${parsed.description.length} characters`);
    assert.ok(!parsed.description.startsWith(">"), "a folded description must come back as its text, never as the fold marker");
    assert.equal(parsed.trigger, null, "a handbook pack is a skill the agent reads, never a job on a clock");
    const injected = injectedWorkflowBody({ body: parsed.body, filePath: `/home/box/agent-data/managed-skills/skills/${id}/SKILL.md` });
    assert.equal(injected.isTruncated, false, `${id} is cut at ${injected.inlinedChars} of ${injected.bodyChars} characters`);
    assert.equal(injected.inlinedChars, injected.bodyChars);
  }
});
