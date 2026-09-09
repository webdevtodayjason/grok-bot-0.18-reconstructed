// BOTS-4. The 65 community bot rows, and the eight things that can actually go wrong with them.
//
// The rows are GENERATED (scripts/build-bot-catalog.mjs) from a scrape checked in verbatim
// (source/shared/marketplace/bots/bots.json) plus a file of human decisions each carrying the exact
// string it replaces and a reason (bots/overlay.json). That arrangement only holds if three things
// stay true, and they are the first three tests here: the checked-in module is byte for byte what
// the data and the overlay produce, no overlay row is dead, and nothing in the module names the
// upstream this catalog was rebuilt away from.
//
// The rest are about what an import would do with a row. A memory the host would silently cut in
// half is not a memory. A routine whose schedule never resolves to a next run is a job that is dead
// the day somebody switches it on. A skill whose front matter does not name it is filed under
// something else. An app that names a plugin we do not carry is an Add button over nothing.
//
// Nothing here touches a box, the network, or a credential.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".community-bots-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));

const bundle = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const file = path.join(stage, name);
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(file);
};

const catalog = await bundle("source/shared/marketplace/catalog.ts", "catalog.cjs");
const schedule = await bundle("source/shared/automation-schedule.ts", "automation-schedule.cjs");

const GENERATOR = path.join(repoRoot, "scripts", "build-bot-catalog.mjs");
const MODULE_PATH = path.join(repoRoot, "source", "shared", "marketplace", "community-bots.ts");
const MODULE_TEXT = readFileSync(MODULE_PATH, "utf8");
const overlay = JSON.parse(readFileSync(path.join(repoRoot, "source", "shared", "marketplace", "bots", "overlay.json"), "utf8"));
const scraped = Object.values(JSON.parse(readFileSync(path.join(repoRoot, "source", "shared", "marketplace", "bots", "bots.json"), "utf8")));

const community = catalog.MARKETPLACE_BOTS.filter((bot) => bot.origin === "community");
const firstParty = catalog.MARKETPLACE_BOTS.filter((bot) => bot.origin !== "community");
const pluginIds = new Set(catalog.MARKETPLACE_PLUGINS.map((plugin) => plugin.id));

// ---------------------------------------------------------------- a. the module is the data

test("the checked-in module is byte for byte what the data and the overlay produce", () => {
  // --check writes nothing and exits non-zero on any difference, so a hand edit to a row is a red
  // suite rather than a change nobody can reproduce.
  execFileSync(process.execPath, [GENERATOR, "--check"], { cwd: repoRoot, stdio: "pipe" });
  // And the same thing said a second way, without trusting the script's own comparison: regenerate
  // to stdout and hold it against the file on disk.
  const fresh = execFileSync(process.execPath, [GENERATOR, "--stdout"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(fresh, MODULE_TEXT, "community-bots.ts differs from a fresh generation; run node scripts/build-bot-catalog.mjs");
  // And --check LEFT THE TREE ALONE. It is the form the gate runs, so it must never be the thing
  // that writes: same bytes on disk, and git says exactly what it said before. Skipped rather than
  // failed where git cannot answer, because a test that needs a repository is a test that fails for
  // the wrong reason in a tarball.
  assert.equal(readFileSync(MODULE_PATH, "utf8"), MODULE_TEXT, "--check rewrote the module it was only asked to compare");
  const gitStatus = () => {
    try { return execFileSync("git", ["status", "--porcelain", "--", "source/shared/marketplace"], { cwd: repoRoot, encoding: "utf8" }); } catch { return null; }
  };
  const before = gitStatus();
  execFileSync(process.execPath, [GENERATOR, "--check"], { cwd: repoRoot, stdio: "pipe" });
  if (before != null) assert.equal(gitStatus(), before, "running --check changed the working tree");
});

test("every overlay row was applied, so no decision in it is dead", () => {
  const ids = new Set(scraped.map((bot) => bot.id));
  const dropped = new Set(overlay.drop.map((row) => row.id));
  for (const row of overlay.drop) {
    assert.ok(ids.has(row.id), `overlay drops "${row.id}", which is not in the scrape`);
    assert.ok(row.why.trim().length > 20, `overlay drops "${row.id}" without saying why`);
    assert.equal(community.find((bot) => bot.id === row.id), undefined, `"${row.id}" is dropped by the overlay and still shipped`);
  }
  for (const row of overlay.category) {
    assert.ok(row.why.trim().length > 20, `overlay category row for "${row.id}" says no why`);
    const bot = community.find((entry) => entry.id === row.id);
    assert.ok(bot != null, `overlay gives "${row.id}" a category and that bot does not ship`);
    assert.equal(bot.category, row.category, `"${row.id}" did not take the overlay's category`);
  }
  for (const row of overlay.replace) {
    assert.ok(row.why.trim().length > 20, `overlay replace row for "${row.id}" says no why`);
    assert.ok(!dropped.has(row.id), `overlay rewrites "${row.id}", which it also drops`);
    const bot = community.find((entry) => entry.id === row.id);
    assert.ok(bot != null, `overlay rewrites "${row.id}" and that bot does not ship`);
    const serialized = JSON.stringify(bot);
    assert.ok(!serialized.includes(JSON.stringify(row.from).slice(1, -1)), `"${row.id}" still carries the text the overlay replaces`);
    if (row.to.length > 0) assert.ok(serialized.includes(JSON.stringify(row.to).slice(1, -1)), `"${row.id}" does not carry the overlay's replacement`);
  }
  for (const row of overlay.schedule) {
    assert.ok(row.why.trim().length > 20, `overlay schedule row for "${row.id}" says no why`);
    const bot = community.find((entry) => entry.id === row.id);
    assert.ok(bot != null, `overlay schedules "${row.id}" and that bot does not ship`);
    const routine = (bot.routines ?? []).find((entry) => entry.name === row.routine);
    assert.ok(routine != null, `overlay schedules "${row.routine}" and "${row.id}" has no such routine`);
    assert.equal(routine.schedule, row.cron, `"${row.id}" routine "${row.routine}" did not take the overlay's cron`);
  }
});

// ---------------------------------------------------------------- b. it does not name the upstream

test("nothing in the generated module names the upstream, comments included", () => {
  const vendor = /grok|cursor|xai|x\.ai|createagent/i;
  const offending = MODULE_TEXT.split("\n")
    .map((line, index) => [index + 1, line])
    .filter(([, line]) => vendor.test(line));
  assert.deepEqual(offending, [], `community-bots.ts still names the old upstream:\n${offending.map(([n, line]) => `  L${n} ${line.trim().slice(0, 120)}`).join("\n")}`);

  // The one thing that LOOKS like an exception and is not: X is a plugin this catalog carries, its
  // id is the single letter "x" and its label is the single letter "X", and neither matches the
  // expression above. Pinned so a future widening of the expression has to think about it.
  const app = community.flatMap((bot) => bot.apps ?? []).find((entry) => entry.plugin === "x");
  assert.ok(app != null, "no community row maps an app to the X plugin any more; the allowance below is stale");
  assert.equal(app.label, "X");
  assert.ok(!vendor.test(app.plugin) && !vendor.test(app.label), "the X row must pass the vendor scan by exact match, not by an exception");
});

// ---------------------------------------------------------------- c. memories fit the store

test("every memory fact fits the host's cap, breaks at a sentence, and rejoins to the paragraph", () => {
  const cap = 500;
  let facts = 0;
  let forced = 0;
  for (const bot of catalog.MARKETPLACE_BOTS) {
    for (const [index, memory] of (bot.memories ?? []).entries()) {
      const where = `bot ${bot.id} memory ${index}`;
      assert.ok(memory.facts.length > 0, `${where} carries no facts`);
      for (const [position, fact] of memory.facts.entries()) {
        facts += 1;
        const length = fact.replace(/\s+/g, " ").trim().length;
        assert.ok(length <= cap, `${where} has a fact of ${length} characters, over the store's ${cap}`);
        if (/[.!?][")\]'’”]?$/.test(fact)) continue;
        // A fact ends where a sentence ends, with two honest exceptions. The LAST fact of a memory
        // is the paragraph's own tail, and a paragraph is free to end without a full stop ("Created
        // by @karenxcheng"). And a SINGLE sentence longer than the cap -- the pack's list-shaped
        // memories, "Job: a, b, c, d ..." -- has no boundary to break at and is cut at the last
        // space that fits, so it lands near the cap. Anything else is a broken splitter.
        if (position === memory.facts.length - 1) continue;
        forced += 1;
        assert.ok(length > 400, `${where} has a ${length}-character fact that does not end at a sentence: ${JSON.stringify(fact.slice(-60))}`);
      }
      assert.equal(memory.facts.join(" "), memory.text.replace(/\s+/g, " ").trim(), `${where} does not rejoin to its own paragraph`);
    }
  }
  assert.ok(facts > 500, `only ${facts} facts across the catalog; the community pack alone carries hundreds`);
  assert.ok(forced < facts / 10, `${forced} of ${facts} facts are forced cuts rather than sentence breaks`);
});

// ---------------------------------------------------------------- d. routines resolve to a run

test("every routine either carries a cron that resolves, or says why it has none", () => {
  const now = Date.UTC(2026, 8, 9, 12, 0, 0);
  let scheduled = 0;
  let unscheduled = 0;
  for (const bot of catalog.MARKETPLACE_BOTS) {
    for (const routine of bot.routines ?? []) {
      const where = `bot ${bot.id} routine "${routine.name}"`;
      assert.ok(routine.scheduleNote.trim().length > 0, `${where} says nothing about when it runs`);
      if (routine.schedule == null) {
        unscheduled += 1;
        // The note is what the page shows in place of a cadence, so it has to be a sentence a
        // person can act on rather than a shrug.
        assert.ok(routine.scheduleNote.length > 40, `${where} has no schedule and a note too short to explain it`);
        continue;
      }
      scheduled += 1;
      const next = schedule.computeNextRunAt(routine.schedule, now);
      assert.ok(Number.isFinite(next) && next > now, `${where} has a schedule that never resolves to a next run ("${routine.schedule}")`);
      // describeSchedule hands the raw expression back when it cannot render one, and a raw cron on
      // a bot page is the thing this whole resolution step exists to avoid.
      const prose = schedule.describeSchedule(routine.schedule);
      assert.notEqual(prose, routine.schedule, `${where} has a schedule the console can only show as raw cron ("${routine.schedule}")`);
      assert.ok(/[A-Za-z]/.test(prose), `${where} describes as "${prose}"`);
    }
  }
  assert.ok(scheduled > 80, `only ${scheduled} routines resolved to a cron`);
  assert.ok(unscheduled > 0, "no routine is left unscheduled, which means the event-triggered ones were invented a cadence");
});

// ---------------------------------------------------------------- e. skills are filed correctly

test("every skill body names itself in its front matter and no bot repeats a skill name", () => {
  const slug = (value) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const documents = new Map();
  for (const bot of community) {
    assert.ok(typeof bot.skillPrefix === "string" && bot.skillPrefix.endsWith("-"), `bot ${bot.id} has no skill namespace`);
    const names = new Set();
    for (const skill of bot.skills) {
      assert.ok(!names.has(skill.name), `bot ${bot.id} lists the skill "${skill.name}" twice`);
      names.add(skill.name);
      const document = `${bot.skillPrefix}${slug(skill.name)}`;
      assert.ok(skill.body.startsWith(`---\nname: ${document}\n`), `bot ${bot.id} skill "${skill.name}" is filed as something else`);
      assert.ok(skill.body.includes(`\ndescription: ${skill.description}\n`), `bot ${bot.id} skill "${skill.name}" front matter does not carry its description`);
      assert.ok(skill.body.includes("\n---\n"), `bot ${bot.id} skill "${skill.name}" front matter is not closed`);
      // The document name is what lands in the box's shared library, and the host clamps it at 80.
      assert.ok(document.length <= 80, `bot ${bot.id} skill document name is ${document.length} characters and the host clamps at 80`);
      const taken = documents.get(document);
      assert.equal(taken, undefined, `bot ${bot.id} and bot ${taken} would both write the document "${document}"`);
      documents.set(document, bot.id);
      // Every bodyless skill says so in its own words rather than pretending to be a playbook.
      assert.ok(skill.body.includes("## Written from a summary"), `bot ${bot.id} skill "${skill.name}" does not say its body was written from a summary`);
    }
  }
  assert.ok(documents.size > 200, `only ${documents.size} community skill documents`);
});

// ---------------------------------------------------------------- f. apps map to real plugins

test("every app maps to a plugin this catalog carries, and Google claims only what was measured", () => {
  // MEASURED on grok-bot-local-vm 2026-09-09: `npx -y google-workspace-mcp-server@1.4.3` was spawned
  // in the box with invented credentials and listed 34 tools -- 11 sheets_*, 4 calendar_*, 3 docs_*,
  // 9 drive_*, 7 gmail_* and NO slides_*. docs/BOTS.md carries the list. That measurement is the
  // only reason Sheets and Calendar map to the `google` row, whose own description says "Gmail and
  // Docs", and the only reason Slides does not.
  const google = new Set(["Gmail", "Google Sheets", "Google Calendar", "Google Drive"]);
  const notGoogle = new Set(["Google Slides"]);
  let apps = 0;
  for (const bot of catalog.MARKETPLACE_BOTS) {
    for (const app of bot.apps ?? []) {
      apps += 1;
      const where = `bot ${bot.id} app "${app.name}"`;
      assert.ok(["connect", "page", "byo"].includes(app.offer), `${where} offers "${app.offer}"`);
      if (app.plugin != null) {
        assert.ok(pluginIds.has(app.plugin), `${where} names the plugin "${app.plugin}", which is not in the catalog`);
        assert.ok(bot.integrations.includes(app.plugin), `${where} names a plugin the row's integrations do not`);
      } else {
        assert.equal(app.offer, "byo", `${where} has no plugin and does not offer add-your-own`);
      }
      if (google.has(app.label)) assert.equal(app.plugin, "google", `${where} should map to the Google Workspace row`);
      if (notGoogle.has(app.label)) assert.equal(app.plugin, null, `${where} maps to a plugin whose server carries no tool for it`);
    }
  }
  assert.ok(apps > 200, `only ${apps} app entries across the catalog`);

  // A row that installs nothing gets a page, never an Add. X is the only one of those the pack names.
  for (const bot of catalog.MARKETPLACE_BOTS) {
    for (const app of bot.apps ?? []) {
      if (app.plugin == null) continue;
      const plugin = catalog.MARKETPLACE_PLUGINS.find((entry) => entry.id === app.plugin);
      assert.equal(app.offer === "page", plugin.installsNothing === true, `bot ${bot.id} app "${app.name}" offers "${app.offer}" against a plugin that ${plugin.installsNothing === true ? "installs nothing" : "does install something"}`);
    }
  }
});

// ---------------------------------------------------------------- g. the catalog holds together

test("the catalog validates and serves 7 first-party rows before 65 community ones", () => {
  const problems = catalog.validateMarketplaceCatalog();
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.equal(firstParty.length, 7, "the first-party rows are no longer seven");
  assert.equal(community.length, 65, "the community pack is no longer 65 rows");
  assert.equal(catalog.MARKETPLACE_BOTS.length, 72);
  // Ours first, deliberately: the Bots tab opens on rows we stand behind.
  const firstCommunity = catalog.MARKETPLACE_BOTS.findIndex((bot) => bot.origin === "community");
  assert.equal(firstCommunity, 7, "a community row is mixed in among the first-party rows");
  assert.ok(catalog.MARKETPLACE_BOTS.slice(7).every((bot) => bot.origin === "community"), "a first-party row sits after the community ones");

  for (const bot of community) {
    assert.ok(bot.creator.length > 0, `bot ${bot.id} credits nobody`);
    assert.equal(bot.creatorNote, "from the community");
    assert.equal(bot.featured, false, `bot ${bot.id} is featured, which is a shelf we choose`);
    assert.equal(bot.tile.file, undefined, `bot ${bot.id} names a tile image; community tiles are drawn, never fetched`);
    assert.match(bot.tile.color, /^#[0-9a-f]{6}$/, `bot ${bot.id} tile colour "${bot.tile.color}"`);
    assert.ok(["circle", "squircle", "rounded", "square"].includes(bot.tile.shape), `bot ${bot.id} tile shape "${bot.tile.shape}" is not one the console draws`);
    assert.ok(bot.instructions.length > 0, `bot ${bot.id} has no identity`);
    assert.equal(bot.instructions, bot.memories[0].text, `bot ${bot.id} identity is not its first memory`);
  }

  // "From Grok Bot Team" was 44 of the scrape's 69 rows and is not a topic. It is dropped rather
  // than renamed, and no row may smuggle it back in as a chip.
  for (const name of catalog.MARKETPLACE_BOT_CATEGORIES) {
    assert.ok(!/grok|team$/i.test(name) || name === "From Titanbot team", `"${name}" is a bot category`);
  }
  assert.equal(new Set(catalog.MARKETPLACE_BOT_CATEGORIES).size, catalog.MARKETPLACE_BOT_CATEGORIES.length,
    "a bot category is listed twice, so the console would draw two identical chips");
  // Every chip has members, or it filters to an empty page.
  for (const name of catalog.MARKETPLACE_BOT_CATEGORIES) {
    if (name === "Featured" || name === "From Titanbot team") continue;
    const members = catalog.MARKETPLACE_BOTS.filter((bot) => bot.category === name || (bot.tags ?? []).includes(name));
    assert.ok(members.length > 0, `the "${name}" chip has no bots under it`);
  }
});

// ---------------------------------------------------------------- the list is a card

test("the wire's bot list is a card and the detail command still serves the whole row", () => {
  const wire = catalog.marketplaceCatalogWireView();
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
  for (const card of wire.bots) {
    for (const heavy of ["instructions", "memories", "skills", "routines", "apps"]) {
      assert.equal(card[heavy], undefined, `the list still carries "${heavy}" on ${card.id}`);
    }
    assert.ok(card.counts != null, `${card.id} carries no counts, so the page cannot say how many of each it has`);
    assert.ok(Array.isArray(card.integrations), `${card.id} lost its integrations, which the chips are drawn from`);
    for (const member of card.members ?? []) {
      assert.deepEqual(Object.keys(member).sort(), ["id", "reportsTo", "role", "summary"], `${card.id} member ${member.id} carries more than the list needs`);
    }
  }
  const card = wire.bots.find((bot) => bot.id === "seo-aeo-desk");
  const whole = catalog.MARKETPLACE_BOTS.find((bot) => bot.id === "seo-aeo-desk");
  assert.equal(card.counts.memories, whole.memories.length);
  assert.equal(card.counts.skills, whole.skills.length);
  assert.equal(card.counts.routines, whole.routines.length);
  assert.equal(card.counts.apps, whole.apps.length);
  // The number this projection exists for. Measured on this Mac with the whole catalog in memory:
  // serving the rows whole is close to a megabyte, and the console fetched the list twice per open.
  assert.ok(bytes(wire) < 200_000, `the list answer is ${bytes(wire)} bytes; the card projection is what keeps it small`);
  assert.ok(bytes(catalog.MARKETPLACE_CATALOG.bots) > 500_000, "the whole rows are no longer large, so this projection may not be needed");
});
