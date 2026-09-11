#!/usr/bin/env node
// KB-1c. Generate the two handbook packs that derive from the Marketplace catalogs.
//
// THE POINT OF A GENERATOR, and it is the same point build-bot-catalog.mjs makes: the connector
// playbook and the starter packs are a restatement of the catalog in an owner's words, and a
// restatement kept by hand is a restatement that is wrong by the next release. Twenty-four plugin
// rows, seventeen declared credentials and ninety-one resolved crons are not a file a person edits.
// So: the catalog is the authority and is READ ONLY here, every human decision is a row in one of
// the two overlays under source/host/extensions/managed-setup/handbook/ carrying the EXACT catalog
// string it replaces, and this script refuses rather than shipping a pack that has drifted.
//
//   node scripts/gen-handbook-packs.mjs            write both SKILL.md files, report their sizes
//   node scripts/gen-handbook-packs.mjs --check    regenerate and diff; exit 1 on any difference
//
// It does NOT run scripts/gen-seed-skills.mjs and does not touch seed-skills.gen.ts. Baking the
// packs into the bundle is a second, separate hand-run step, and docs/HANDBOOK.md says so: forget
// it and the bundle ships the old words with every test green.
//
// THE SPOKEN-LINE CONVENTION, which is the one thing another item has to agree with. A line in a
// handbook pack is OWNER LANGUAGE if and only if its trimmed form begins with "> " (a markdown
// blockquote). Those lines are swept: no word on the console's published BANNED_WORDS list, no
// vendor on its BANNED_VENDORS list unless that vendor is a row in this Marketplace, and no em
// dash. Every other line is addressed to Titan and is NOT swept, because a recipe that cannot say
// "credential" to him cannot teach him what never to ask for. Each pack states the convention in
// its own first paragraph, so the agent reading the file learns it too.
//
// Why the vendor list is narrowed rather than applied whole: BANNED_VENDORS contains github, slack,
// resend and browser-use, and all four are Marketplace rows. Swept whole, this pack would fail for
// telling an owner how to connect their own GitHub. The exemption is DERIVED from the catalog at
// run time, so the infrastructure vendors a customer must never hear (openai, xai, anthropic, z.ai,
// glm, grok, firebase, apns, coolify, s3) stay banned and cannot be exempted by accident.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const HANDBOOK_DIR = path.join(REPO, "source", "host", "extensions", "managed-setup", "handbook");
const SEED_DIR = path.join(REPO, "source", "host", "extensions", "managed-setup", "seed-skills");
const SETTINGS_JS = path.join(REPO, "ui", "machine-room", "settings.js");

/** The per-pack ceiling. WORKFLOW_INJECTED_BODY_LIMIT is 16,000; a pack stays well under it. */
export const PACK_BODY_CEILING = 14_000;

// --------------------------------------------------------------------- 1. the published word lists
//
// Parsed out of the console's own module rather than copied, because a second copy is a second
// thing to forget. The arrays are literal and on one line each; a shape change here is a loud
// failure, which is what we want -- the alternative is a sweep that quietly stops sweeping.
export function publishedWordLists(source) {
  const pick = (name) => {
    const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
    if (match == null) throw new Error(`${name} is no longer a one-line array literal in ui/machine-room/settings.js; the sweep cannot read it`);
    const words = [...match[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1]);
    if (words.length === 0) throw new Error(`${name} parsed empty out of ui/machine-room/settings.js`);
    return words;
  };
  return { bannedWords: pick("BANNED_WORDS"), bannedVendors: pick("BANNED_VENDORS") };
}

/**
 * The sweep an owner-facing line has to pass.
 *
 * `allowedVendors` is the intersection of BANNED_VENDORS with the ids and the words of the names of
 * the rows this Marketplace carries. Derived, never declared: a vendor only becomes speakable by
 * being a row an owner can add.
 */
export function buildSweep({ bannedWords, bannedVendors, plugins }) {
  const speakable = new Set();
  for (const plugin of plugins) {
    speakable.add(plugin.id.toLowerCase());
    for (const word of plugin.name.toLowerCase().split(/[^a-z0-9.-]+/)) if (word.length > 0) speakable.add(word);
  }
  const vendors = bannedVendors.filter((vendor) => !speakable.has(vendor.toLowerCase()));
  const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const banned = new RegExp(`\\b(?:${[...bannedWords, ...vendors].map(escape).join("|")})\\b`, "i");
  return {
    allowedVendors: bannedVendors.filter((vendor) => speakable.has(vendor.toLowerCase())),
    bannedVendors: vendors,
    /** The offending word, or null. */
    hit(text) {
      const word = banned.exec(text);
      if (word != null) return word[0];
      // No em dash in anything a person reads. The catalog's own hints carry them and those lines
      // are Titan's, not the owner's, which is exactly why only spoken lines are swept.
      return text.includes("—") ? "an em dash" : null;
    },
  };
}

/** Every line of a rendered pack that is owner language: a markdown blockquote. */
export function spokenLines(body) {
  return body.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("> ")).map((line) => line.slice(2).trim());
}

// ---------------------------------------------------------------------------- 2. the catalog, read
//
// The host ships as one bundled file and these modules are TypeScript, so the only honest way to
// read the live rows is to bundle them. Nothing here writes to source/shared/marketplace.
export async function loadCatalog() {
  const stage = mkdtempSync(path.join(REPO, ".tmp-handbook-packs-"));
  try {
    const require_ = createRequire(import.meta.url);
    const load = async (entry, name) => {
      const result = await build({
        entryPoints: [path.join(REPO, entry)],
        bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
        external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
      });
      const file = path.join(stage, name);
      writeFileSync(file, result.outputFiles[0].text, "utf8");
      return require_(file);
    };
    const catalog = await load("source/shared/marketplace/catalog.ts", "catalog.cjs");
    const shell = await load("source/host/extensions/shell-tools/shell-tool-catalog.ts", "shell-tools.cjs");
    return {
      plugins: catalog.MARKETPLACE_PLUGINS,
      bots: catalog.MARKETPLACE_BOTS,
      shellTools: shell.SHELL_TOOLS,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------- 3. the four shapes
//
// Resolved from what a row INSTALLS and what it DECLARES, never asserted by hand. "One key home
// each" is false on eight of twenty-four rows -- Google Workspace declares three credentials,
// Browserbase two, seven rows need none and four install nothing at all -- so the shape is a
// question asked of the row.
export function pluginShape(plugin) {
  const credentials = plugin.credentials ?? [];
  if (plugin.opensEditor === true) return "editor";
  if (plugin.installsNothing === true) return "page";
  return credentials.length === 0 ? "free" : "keyed";
}

/** The first sentence of a hint that says WHERE the value is minted, verbatim out of the catalog. */
export function mintedAt(hint) {
  const sentences = hint.split(/(?<=\.)\s+/).map((piece) => piece.trim()).filter((piece) => piece.length > 0);
  const locator = sentences.find((piece) => /https?:\/\/|[a-z0-9-]+\.(?:com|ai|app|io|so|dev)\b|→/i.test(piece));
  const picked = locator ?? sentences[0];
  if (picked == null || picked.length === 0) throw new Error("a credential hint rendered no sentence at all");
  // Past the first semicolon a hint stops saying where and starts listing permissions, which is
  // the half GetPlugin is for. Still a verbatim prefix of the catalog's own line, never a paraphrase.
  const semicolon = picked.indexOf("; ");
  return semicolon > 0 ? `${picked.slice(0, semicolon)}.` : picked;
}

/**
 * The cadence half of a routine's schedule note, verbatim, without the paragraph explaining where
 * the default hour came from.
 *
 * The explanation is identical on every routine that takes a declared default, so repeating it
 * fifteen times costs a tenth of the pack to say one thing. It is said ONCE in the pack's rules
 * instead, and what each routine carries is the cadence itself: a prefix of the catalog's own note,
 * so nothing here is a paraphrase. Two shapes exist in the catalog and both end the cadence at the
 * same two places.
 */
export function cadenceOf(note) {
  const cut = [note.indexOf(", the default hour"), note.indexOf(". ")].filter((at) => at >= 0);
  const end = cut.length === 0 ? note.length : Math.min(...cut);
  const cadence = note.slice(0, end).replace(/[.,]+$/, "").trim();
  if (cadence.length === 0) throw new Error(`a routine's schedule note rendered no cadence: ${note}`);
  return cadence;
}

// --------------------------------------------------------------------------------- 4. the overlays
export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Every declared credential has a phrase, every phrase still names a live catalog label, and no
 * phrase puts a word in Titan's mouth that a customer may never hear.
 *
 * The `replaces` field is the anti-rot catch: a phrase is a replacement for ONE exact catalog
 * label, so the day the catalog renames "GitHub personal access token" the build fails naming the
 * row rather than shipping a phrase for a label that no longer exists.
 */
export function resolvePhrases({ plugins, phrases, sweep }) {
  const byField = new Map();
  for (const plugin of plugins) {
    for (const credential of plugin.credentials ?? []) {
      const entry = phrases.credentials?.[credential.field];
      if (entry == null) throw new Error(`connector-phrases.json has no phrase for ${plugin.id}'s ${credential.field}; a new plugin cannot ship a banned word into Titan's mouth`);
      if (entry.plugin !== plugin.id) throw new Error(`connector-phrases.json maps ${credential.field} to plugin "${entry.plugin}" but the catalog declares it on "${plugin.id}"`);
      if (entry.replaces !== credential.label) throw new Error(`connector-phrases.json says ${credential.field} replaces "${entry.replaces}" but the catalog's label is now "${credential.label}"`);
      const bad = sweep.hit(entry.say);
      if (bad != null) throw new Error(`the spoken phrase for ${credential.field} carries "${bad}", which a customer may never hear: ${entry.say}`);
      byField.set(credential.field, { ...entry, label: credential.label, hint: credential.hint });
    }
  }
  for (const [field, entry] of Object.entries(phrases.credentials ?? {})) {
    if (!byField.has(field)) throw new Error(`connector-phrases.json carries a phrase for ${field} (${entry.plugin}), which no catalog row declares any more`);
  }
  // A tagline is rendered, and a rendered line may be read out, so a tagline that trips the sweep
  // needs a plain-words replacement naming the exact string it replaces. Two do today.
  const taglines = new Map();
  for (const plugin of plugins) {
    const override = phrases.taglines?.[plugin.id];
    if (override != null) {
      if (override.replaces !== plugin.tagline) throw new Error(`connector-phrases.json rewrites ${plugin.id}'s tagline "${override.replaces}" but the catalog's tagline is now "${plugin.tagline}"`);
      const bad = sweep.hit(override.say);
      if (bad != null) throw new Error(`the rewritten tagline for ${plugin.id} carries "${bad}": ${override.say}`);
      taglines.set(plugin.id, override.say);
      continue;
    }
    const bad = sweep.hit(plugin.tagline);
    if (bad != null) throw new Error(`${plugin.id}'s catalog tagline carries "${bad}" and has no plain-words replacement in connector-phrases.json: ${plugin.tagline}`);
    taglines.set(plugin.id, plugin.tagline);
  }
  for (const id of Object.keys(phrases.taglines ?? {})) {
    if (!plugins.some((plugin) => plugin.id === id)) throw new Error(`connector-phrases.json rewrites the tagline of "${id}", which is not a catalog row`);
  }
  return { byField, taglines };
}

/** Every bot id, every routine title and every cron a starter pack cites, resolved against the catalog. */
export function resolveStarters({ bots, starters, sweep }) {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  for (const [id, says] of Object.entries(starters.bots ?? {})) {
    if (!byId.has(id)) throw new Error(`starter-packs.json describes bot "${id}", which is not in the catalog`);
    const bad = sweep.hit(says);
    if (bad != null) throw new Error(`the spoken line for bot "${id}" carries "${bad}": ${says}`);
  }
  const resolved = [];
  for (const persona of starters.personas) {
    for (const text of [persona.theyAsk, persona.whatTheyGet, ...(persona.spoken ?? [])]) {
      const bad = sweep.hit(text);
      if (bad != null) throw new Error(`persona "${persona.id}" has a spoken line carrying "${bad}": ${text}`);
    }
    const members = (persona.bots ?? []).map((id) => {
      const bot = byId.get(id);
      if (bot == null) throw new Error(`persona "${persona.id}" names bot "${id}", which is not in the catalog`);
      if (starters.bots?.[id] == null) throw new Error(`persona "${persona.id}" names bot "${id}", which has no line in starter-packs.json's bots map`);
      return { bot, says: starters.bots[id] };
    });
    const routines = (persona.routines ?? []).map(({ bot: botId, name }) => {
      const bot = byId.get(botId);
      if (bot == null) throw new Error(`persona "${persona.id}" cites a routine on bot "${botId}", which is not in the catalog`);
      const routine = (bot.routines ?? []).find((row) => row.name === name);
      if (routine == null) throw new Error(`persona "${persona.id}" cites routine "${name}" on "${botId}", which that bot does not carry`);
      // The rule BOTS.md exists for: a routine whose cron did not resolve is NOT CREATED, so
      // describing it as a schedule would promise a job that is dead the day somebody switches it
      // on. Nothing in this pack may say "every Monday" about one of those.
      if (routine.schedule == null) throw new Error(`persona "${persona.id}" lists routine "${name}" on "${botId}" under the jobs to switch on, but its cron resolved to null: it is not created at all, and describing it as a schedule is the promise BOTS.md refuses`);
      return { botId, routine };
    });
    const notCreated = (persona.notCreated ?? []).map(({ bot: botId, name }) => {
      const bot = byId.get(botId);
      if (bot == null) throw new Error(`persona "${persona.id}" cites a not-created routine on bot "${botId}", which is not in the catalog`);
      const routine = (bot.routines ?? []).find((row) => row.name === name);
      if (routine == null) throw new Error(`persona "${persona.id}" cites routine "${name}" on "${botId}" as not created, and that bot does not carry it`);
      if (routine.schedule != null) throw new Error(`persona "${persona.id}" calls routine "${name}" on "${botId}" uncreatable, but the catalog resolved it to "${routine.schedule}"`);
      return { botId, routine };
    });
    let team = null;
    if (persona.team != null) {
      team = byId.get(persona.team);
      if (team == null) throw new Error(`persona "${persona.id}" names team pack "${persona.team}", which is not in the catalog`);
      if ((team.members ?? []).length === 0) throw new Error(`persona "${persona.id}" calls "${persona.team}" a team pack, but the catalog row carries no members, so the import verb would not refuse it`);
    }
    resolved.push({ ...persona, members, routines, notCreated, team });
  }
  return resolved;
}

// ------------------------------------------------------------------------ 5. the connector playbook
const FOUR_STATES = [
  ["Not installed", "the app is not on the box yet. Press Add on its card."],
  ["Needs auth", "it is on the box and at least one box on the Accounts row is still empty."],
  ["Ready", "on the box, filled in, and talking. This is the one you are waiting for."],
  ["Connecting", "on the box, nothing left to fill in, and no tool list back yet. It can take the best part of a minute. It is not a blink to ignore: it means the app is written down and the box has not heard back."],
];

function renderConnectorRow({ plugin, taglines, byField, boxes }) {
  const lines = [];
  const count = boxes.length === 1 ? "One box." : `${boxes.length} boxes.`;
  lines.push(`**${plugin.name}** (${plugin.category}). ${taglines.get(plugin.id)}. ${count}`);
  for (const field of boxes) {
    const entry = byField.get(field);
    lines.push(`> ${entry.say}.`);
    lines.push(`  Minted at: ${mintedAt(entry.hint)}`);
  }
  return lines.join("\n");
}

/**
 * The pack, and the long tail it falls back to rather than breaking the build.
 *
 * Every keyed row renders in full while the body fits. Past the ceiling the tail of that list
 * collapses, one row at a time, into a table of name, what it is for and how many boxes to fill --
 * so a catalog that grows past what one injected body can carry degrades into a shorter pack
 * instead of failing a generator run, and the rows that collapse are still named rather than
 * dropped. Nothing is cut mid-sentence: the injection cap's own truncation is what this avoids.
 */
export function renderConnectorPack({ plugins, shellTools, taglines, byField, sweep, ceiling = PACK_BODY_CEILING }) {
  const keyedInOrder = plugins.filter((plugin) => pluginShape(plugin) === "keyed");
  for (let full = keyedInOrder.length; full >= 0; full -= 1) {
    const text = renderConnectorPackAt({ plugins, shellTools, taglines, byField, sweep, full });
    const body = text.slice(text.indexOf("\n---\n", 4) + 5);
    if (body.length <= ceiling || full === 0) return text;
  }
  throw new Error("unreachable: the fallback loop always returns");
}

function renderConnectorPackAt({ plugins, shellTools, taglines, byField, sweep, full }) {
  const byShape = { keyed: [], free: [], page: [], editor: [] };
  for (const plugin of plugins) byShape[pluginShape(plugin)].push(plugin);
  const fields = plugins.reduce((total, plugin) => total + (plugin.credentials ?? []).length, 0);
  const keyedRows = plugins.filter((plugin) => (plugin.credentials ?? []).length > 0);
  const todoist = plugins.find((plugin) => plugin.id === "todoist");
  if (todoist == null) throw new Error("the worked example is Todoist and the catalog no longer carries it");
  const shellRows = plugins.filter((plugin) => plugin.install?.shellTool != null);

  const out = [];
  out.push("---");
  // The frontmatter name is the directory id, which is what every other seed in this tree does and
  // what the host writes back into the box's own copy. The prose title stays as the body's heading.
  out.push("name: handbook-connect-an-app");
  out.push("description: >-");
  out.push("  Use when the owner wants one of their own apps joined up to you, asks what you can plug");
  out.push("  into, or offers you something private in the conversation. It carries the one place a");
  out.push("  private value goes, the plain words for it, and the playbook for every app here.");
  out.push("---");
  out.push("# Connecting an app for the owner");
  out.push("");
  out.push("**How to read this file.** Every line that starts with `>` is owner language: say it word for word. Everything else is for you. The owner never hears a field name, a vendor's own label for one, or any of the words this product keeps off a customer's screen.");
  out.push("");
  out.push("## The rule, and it has no exception");
  out.push("");
  out.push("You install. They store the private value. You never see it and you never ask for it in the conversation, because anything typed into a chat sits in the transcript, in your own context, and in whatever window that conversation was later compacted into. There is no taking it back out. Two places take one, and both are masked boxes that never show it to you:");
  out.push("");
  out.push("1. **The app's page.** Marketplace, then Plugins, then the app, then the box headed **Accounts**: one masked box per thing that app needs, the vendor's own line under it, and **Store on the host**. You cannot fill it. There is no tool for it, deliberately.");
  out.push("2. **A masked card you raise yourself.** `SendMessage` with `type: \"secret-request\"` and `{label, description, connector, field}` draws a card with a masked box and a **Save securely** button; the value goes straight to the store and into neither the transcript nor the page. Use it when sending them to a panel would lose them. `connector: \"shell\"` puts it in this agent's own shell instead and the field name must then be UPPERCASE.");
  out.push("");
  out.push("Say the path with the app's name in it, and say the custody in the same breath:");
  out.push("");
  out.push("> Marketplace, then Plugins, then Todoist, then the box headed Accounts. Whatever you type in there never reaches me.");
  out.push("");
  out.push("If they paste one into the chat anyway, do not repeat it back, not even a few characters of it:");
  out.push("");
  out.push("> Do not paste that to me. Anything in our chat stays in the conversation for good and I cannot take it back out. Put it in the masked box instead. And because that one has been in a chat window, go and replace it where you made it.");
  out.push("");
  out.push("## The four states they can read back to you");
  out.push("");
  for (const [state, means] of FOUR_STATES) out.push(`- **${state}.** ${means.charAt(0).toUpperCase()}${means.slice(1)}`);
  out.push("");
  out.push("> It will say Connecting for a moment and then Ready. Ready is the one that means it worked.");
  out.push("");
  out.push(`## ${keyedRows.length} apps want something filled in, ${fields} boxes in all`);
  out.push("");
  out.push("Never say one box per app. It is one box per thing the app needs, and two rows need more than one. The minted-at line under each is the vendor's own wording out of the catalog: it is yours to know, not to read out. GetPlugin hands you the rest of it when you need the permissions.");
  out.push("");
  for (const plugin of byShape.keyed.slice(0, full)) {
    out.push(renderConnectorRow({ plugin, taglines, byField, boxes: (plugin.credentials ?? []).map((credential) => credential.field) }));
    out.push("");
  }
  const tail = byShape.keyed.slice(full);
  if (tail.length > 0) {
    out.push("The rest, in short, because the whole of this file has to fit in one read. GetPlugin gives you the boxes and the vendor's own wording for any of them.");
    out.push("");
    out.push("| App | What it is for | Boxes |");
    out.push("| --- | --- | --- |");
    for (const plugin of tail) out.push(`| ${plugin.name} | ${taglines.get(plugin.id)} | ${(plugin.credentials ?? []).length} |`);
    out.push("");
  }
  out.push(`## ${byShape.free.length} apps want nothing at all`);
  out.push("");
  out.push("Press Add and they work. No box, so nothing to ask for and nothing to wait on.");
  out.push("");
  for (const plugin of byShape.free) out.push(`- **${plugin.name}.** ${taglines.get(plugin.id)}.`);
  out.push("");
  out.push("> That one needs nothing from you. I can turn it on myself and use it in my next message.");
  out.push("");
  out.push(`## ${byShape.page.length} rows put nothing on the box at all`);
  out.push("");
  out.push("Pages, not switches. No official connector publishes an ordinary post to Facebook, Instagram, X or LinkedIn anywhere, so there is nothing to install and nothing to fill in. A row is allowed to be a page: a box for a value nothing reads would be the same lie one level up. What the page carries is what somebody has to do first, and it takes weeks rather than an afternoon.");
  out.push("");
  for (const plugin of byShape.page) {
    const boxes = (plugin.credentials ?? []).map((credential) => credential.field);
    out.push(`**${plugin.name}** (${plugin.category}). ${taglines.get(plugin.id)}. ${boxes.length === 0 ? "Nothing to install and nothing to fill in: read the page with them and say what it will cost in time." : `Nothing to install, and still ${boxes.length} boxes, read by the product itself rather than by any bot.`}`);
    for (const field of boxes) {
      const entry = byField.get(field);
      out.push(`> ${entry.say}.`);
      out.push(`  Minted at: ${mintedAt(entry.hint)}`);
    }
    out.push("");
  }
  out.push("> Nobody's connector can put an ordinary post on that for you. What works is your own developer app, or a scheduler you already pay for, or a browser somebody is signed in to. I can drive the browser while you sign in.");
  out.push("");
  out.push(`## ${shellRows.length} rows also install a command inside the box`);
  out.push("");
  out.push("A command-line program the agent runs itself, rather than a server the box talks to. Add runs the vendor's own installer inside the box as root, capped at five minutes, and the state afterwards is asked of the box rather than read out of a file. There is no Uninstall for one of these on this host, so say so before you add one.");
  out.push("");
  for (const plugin of shellRows) {
    const tool = shellTools.find((row) => row.id === plugin.install.shellTool);
    if (tool == null) throw new Error(`${plugin.id} installs shell tool "${plugin.install.shellTool}", which shell-tool-catalog.ts does not carry`);
    out.push(`- **${plugin.name}** runs \`${tool.binary}\`. Installed when \`command -v ${tool.binary}\` answers.`);
  }
  out.push("");
  const editor = byShape.editor[0];
  if (editor == null) throw new Error("the catalog no longer carries a row that opens the editor");
  out.push(`## ${editor.name}, the one row your own tool refuses`);
  out.push("");
  out.push(`**${editor.name}.** ${taglines.get(editor.id)}. Its Add opens an editor in the console. Your InstallPlugin refuses it and explains why rather than writing anything, because there is nothing to write. Send them to the card; do not try the tool and report the refusal as a failure. With this one, seven rows ask for nothing at all. Neither door signs in through a browser: a server that can only be authorized by a person clicking through says so and stops, rather than waiting on a window nobody is watching. One such bridge on a test box had been waiting nine hours and fifty-one minutes when it was found.`);
  out.push("");
  out.push("## The worked example, start to finish");
  out.push("");
  out.push("They keep their to-do list somewhere and ask how you get into it.");
  out.push("");
  out.push("> Your to-do list is one I can work. Marketplace, then Plugins, then Todoist, then the box headed Accounts. There is one thing to fill in: the one thing Todoist gives you under Settings, Integrations, Developer. Paste it there and press Store on the host. I never see it and I cannot fill it in for you.");
  out.push("");
  out.push(`Yours to know and not to read out: "${todoist.credentials[0].hint}" Account-wide is the part that matters: if their whole task list is not something they want reachable, the honest answer is a second account, not a narrowing that does not exist.`);
  out.push("");
  out.push("First run is slow and the rest are not. Measured on a box with nothing cached: 24.9 seconds the first time, 2.1 seconds warm. Do not report the first wait as a failure.");
  out.push("");
  out.push("> It will take half a minute the first time and then be quick. Tell me when the row says Ready and I will have a look at what is in there.");
  out.push("");
  out.push("Then press on. When the row says Ready, do one concrete thing with the app and say what you found: a connection nobody used is not proof of anything.");
  out.push("");
  out.push("## Two refusals you will meet, and neither is a bug");
  out.push("");
  out.push("- **A value typed into a header, or carried in a web address, is refused** with the field it wants named instead. The refusal does not repeat the value back, and neither do you. Write a header as a placeholder naming the field, and pass environment variables as NAMES only.");
  out.push("- **A team pack is refused by the import verb** and points at the console. A refusal is not a success: never answer \"done\" to one. The starter packs pack carries that case with the measured failure.");

  const text = `${out.join("\n")}\n`;
  for (const line of spokenLines(text)) {
    const bad = sweep.hit(line);
    if (bad != null) throw new Error(`the connector pack has a spoken line carrying "${bad}": ${line}`);
  }
  return text;
}

// -------------------------------------------------------------------------- 6. the starter packs
export function renderStarterPack({ personas, sweep }) {
  const out = [];
  out.push("---");
  out.push("name: handbook-starter-packs");
  out.push("description: >-");
  out.push("  Use when the owner says what kind of business they run and wants setting up, or asks what");
  out.push("  a shop, a law practice, a course business, a design studio or a marketing team should");
  out.push("  have. It names the real bots, the real jobs, and the offer to make.");
  out.push("---");
  out.push("# Starter packs by trade");
  out.push("");
  out.push("**How to read this file.** Every line that starts with `>` is owner language: say it word for word. Everything else is for you.");
  out.push("");
  out.push("**There is no flower-shop template.** No legal one, no course-creator one, no freelance-designer one. What the Marketplace actually has is bots, and a pack is a handful of them picked for one trade plus the jobs worth switching on. Say that rather than implying a ready-made thing exists, and never claim a template that is not on the shelf.");
  out.push("");
  out.push("> There is no off-the-shelf set for a flower shop, so I would put one together out of what is on the shelf. Want me to set this up for you?");
  out.push("");
  out.push("End with that question. Offering four bots and never asking is the half that makes the other half worth anything.");
  out.push("");
  out.push("## How you actually do it");
  out.push("");
  out.push("1. **SearchBotCatalog** with what they said, in their words. It ranks the shelf and hands back the best rows.");
  out.push("2. **GetBotTemplate** on the one you mean, in full: its facts, its playbooks, its jobs and the apps it wants.");
  out.push("3. **CreateAgentFromTemplate** to set it up. It calls the same thing the console's own Add button calls, so there is one implementation and the two cannot disagree.");
  out.push("4. **Read the answer and say what really happened.** It comes back with counts: facts added, duplicated and refused, playbooks imported, reused and skipped, jobs created and not created, apps connected, addable, informational and theirs to bring. Those counts are the truth. Do not say \"done\" and leave them unread.");
  out.push("");
  out.push("> That one is on your roster now. It came with eleven facts it already knows, seven playbooks and two jobs, and the jobs are switched off until you want them on.");
  out.push("");
  out.push("## Three rules that hold for every pack");
  out.push("");
  out.push("- **Every job arrives switched off.** Nothing a pack adds starts running on its own. Say so, and offer to switch on the ones they want.");
  out.push("- **A job has a real clock or it is not created.** Five fields, in the box's own local time. Where the words named a cadence and no hour, nine in the morning local is the declared default, and that is disclosed rather than invented. There are no jobs here that run when something happens: no event triggers exist on this product, so never offer one.");
  out.push("- **A fact has to fit.** One remembered fact is capped at 500 characters and a longer one is refused outright rather than quietly cut in half. If the answer reports a refusal, say which fact did not fit instead of reporting a clean run.");
  out.push("");
  out.push("## The four blocks they see on a bot's page");
  out.push("");
  out.push("Memories are facts it already knows, Skills are playbooks it can run, Routines are jobs that run on their own, Integrations are apps it can use. Use those four words with them: they are the words on the screen.");
  out.push("");
  for (const persona of personas) {
    out.push(`## ${persona.title}`);
    out.push("");
    out.push(`They ask: "${persona.theyAsk}"`);
    out.push("");
    out.push(`> ${persona.whatTheyGet}`);
    out.push("");
    if (persona.team != null) {
      out.push(`**A team does not come through your tools.** \`${persona.team.id}\` is one row carrying ${persona.team.members.length} bots: ${persona.team.members.map((member) => member.role).join(", ")}. The coordinator reports to you and the other six to the coordinator.`);
      out.push("");
      out.push("**CreateAgentFromTemplate refuses it**, in plain words, and points at Marketplace, then Bots, then the Import team button. Through your tool it would make ONE bot carrying the pack's name and none of its members, which looks like it worked, so the refusal is deliberate.");
      out.push("");
      out.push("**A refusal is not a success.** This has already gone wrong once: a bot searched the shelf, this pack came back first, it was told to use it, the import refused it, and the bot answered \"Done, Marketing team is set up and on your roster\" having created nothing at all. Handed a refusal, say it was refused and say where the button is.");
      out.push("");
      out.push("> That one is a team rather than a single bot, so it gets added from its own page: Marketplace, then Bots, then Import team. That puts all seven on at once. I cannot do it from here.");
      out.push("");
      out.push("It carries playbooks and no jobs, so there is nothing to switch on afterwards. Nothing it writes goes out anywhere until somebody says yes, and that rule is in all seven of them.");
      out.push("");
      continue;
    }
    out.push("Bots:");
    out.push("");
    for (const { bot, says } of persona.members) out.push(`- \`${bot.id}\`, **${bot.name}** (${bot.category}). ${says}`);
    out.push("");
    if (persona.routines.length > 0) {
      out.push("Jobs worth switching on, with the clock each really gets:");
      out.push("");
      for (const { botId, routine } of persona.routines) out.push(`- \`${botId}\` **${routine.name}**: \`${routine.schedule}\`, ${cadenceOf(routine.scheduleNote)}.`);
      out.push("");
    }
    if (persona.notCreated.length > 0) {
      out.push("Not created at all, and say so rather than letting them find out:");
      out.push("");
      for (const { botId, routine } of persona.notCreated) out.push(`- \`${botId}\` **${routine.name}**. ${routine.scheduleNote}`);
      out.push("");
    }
    for (const line of persona.spoken ?? []) {
      out.push(`> ${line}`);
      out.push("");
    }
  }
  out.push("## What to do when nothing on the shelf fits");
  out.push("");
  out.push("Say so. Name the two or three closest rows with a line each, say what they do and do not cover, and ask whether they want one of those or one built from scratch. Both are real answers. Inventing a row that is not there is not.");
  out.push("");
  out.push("> There is nothing on the shelf built for exactly that. The closest two are these, and here is what each would and would not cover. Do you want one of those, or shall I build you one from scratch?");

  const text = `${out.join("\n")}\n`;
  for (const line of spokenLines(text)) {
    const bad = sweep.hit(line);
    if (bad != null) throw new Error(`the starter packs pack has a spoken line carrying "${bad}": ${line}`);
  }
  return text;
}

// ------------------------------------------------------------------------------------- 7. the build
export function buildPacks({ catalog, phrases, starters, settingsSource }) {
  const lists = publishedWordLists(settingsSource);
  const sweep = buildSweep({ ...lists, plugins: catalog.plugins });
  const { byField, taglines } = resolvePhrases({ plugins: catalog.plugins, phrases, sweep });
  const personas = resolveStarters({ bots: catalog.bots, starters, sweep });
  const connect = renderConnectorPack({ plugins: catalog.plugins, shellTools: catalog.shellTools, taglines, byField, sweep });
  const packs = renderStarterPack({ personas, sweep });
  for (const [id, text] of [["handbook-connect-an-app", connect], ["handbook-starter-packs", packs]]) {
    const body = text.slice(text.indexOf("\n---\n", 4) + 5);
    if (body.length > PACK_BODY_CEILING) throw new Error(`${id}'s body is ${body.length} characters, over the ${PACK_BODY_CEILING} ceiling`);
  }
  return { connect, packs, sweep };
}

export async function generate() {
  const catalog = await loadCatalog();
  return buildPacks({
    catalog,
    phrases: readJson(path.join(HANDBOOK_DIR, "connector-phrases.json")),
    starters: readJson(path.join(HANDBOOK_DIR, "starter-packs.json")),
    settingsSource: readFileSync(SETTINGS_JS, "utf8"),
  });
}

const FILES = [
  ["handbook-connect-an-app", "connect"],
  ["handbook-starter-packs", "packs"],
];

async function main() {
  const check = process.argv.includes("--check");
  const built = await generate();
  let differed = false;
  for (const [id, key] of FILES) {
    const file = path.join(SEED_DIR, id, "SKILL.md");
    const text = built[key];
    const body = text.slice(text.indexOf("\n---\n", 4) + 5);
    let existing = null;
    try { existing = readFileSync(file, "utf8"); } catch { /* first run */ }
    if (check) {
      if (existing !== text) { differed = true; console.error(`DIFFERS ${path.relative(REPO, file)}`); }
    } else if (existing !== text) {
      writeFileSync(file, text, "utf8");
    }
    const over = body.length > PACK_BODY_CEILING ? " OVER CEILING" : "";
    console.log(`${id}: ${text.length} chars of file, ${body.length} of body against the ${PACK_BODY_CEILING} ceiling${over}`);
  }
  console.log(`vendors a spoken line may name because they are Marketplace rows: ${built.sweep.allowedVendors.join(", ")}`);
  if (check && differed) process.exit(1);
  if (check) console.log("--check: both files match what the overlays and the catalog say");
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) await main();
