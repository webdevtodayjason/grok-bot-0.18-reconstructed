#!/usr/bin/env node
// BOTS-1 item A. Turn the scraped community pack into source/shared/marketplace/community-bots.ts.
//
// THE POINT OF A GENERATOR. 65 rows carrying 444 paragraphs of operating rules, 277 skills and 104
// routines is not a file a person edits. bots.json goes into the repo exactly as it came off the
// wire and is never touched again; every human decision -- a dropped bot, a rewritten sentence, a
// category for a bot the scrape gave none, a cron the prose does not state -- is a row in
// bots/overlay.json carrying the EXACT string it replaces and a `why`. This script reads both and
// writes the module. It fails loudly when an overlay row's `from` is no longer found, so the
// overlay cannot rot against a re-scrape, and tests/community-bots.test.mjs regenerates in memory
// and asserts the checked-in module is byte identical, so nobody hand-edits a row.
//
// Usage:
//   node scripts/build-bot-catalog.mjs            write source/shared/marketplace/community-bots.ts
//   node scripts/build-bot-catalog.mjs --check     regenerate and diff; exit 1 on any difference
//   node scripts/build-bot-catalog.mjs --stdout    print the module and write nothing
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DATA_DIR = path.join(REPO, "source", "shared", "marketplace", "bots");
const OUT = path.join(REPO, "source", "shared", "marketplace", "community-bots.ts");

// ---------------------------------------------------------------- 1. the vendor phrase table
//
// Applied to every string this script emits, longest first so "Grok Bots" never becomes
// "Titanium Bot" plus a stray "s". It is deliberately small: it handles the phrases that repeat
// across the pack, and everything left over has to be a decision in overlay.json with a reason
// beside it. The residue scan at the end of this file is what enforces that -- the build fails
// rather than shipping a row that names the old upstream.
const PHRASES = [
  ["Grok Bots", "Titanium Bots"],
  ["Grok Bot", "Titanium Bot"],
  ["grok bots", "Titanium Bots"],
  ["grok bot", "Titanium Bot"],
  ["Cursor cloud agent", "cloud coding agent"],
  ["Cursor/Agent Plugin", "marketplace plugin"],
  ["Cursor marketplace plugin", "plugin in this Marketplace"],
  ["Cursor plugin", "marketplace plugin"],
  ["CreateAgent", "create a bot"],
];

/** What a shipped string may never contain. The build refuses rather than ships one. */
const VENDOR = /grok|cursor|xai|x\.ai|createagent/i;

function scrub(value) {
  let out = String(value ?? "");
  for (const [from, to] of PHRASES) out = out.split(from).join(to);
  return out;
}

// ---------------------------------------------------------------- 2. the tile
//
// The console draws every tile -- it fetches no image, so `tile.file` stays absent on every
// community row and each one gets the drawn face. That face is painted in near-black (#0d0f14, in
// ui/machine-room/marketplace-bots.js), which is why none of these eleven is a dark tone: a
// literally black tile would be a blank square with an invisible face on it. "black" therefore
// becomes the lightest graphite that still reads as the achromatic tile of the set, and
// docs/BOTS.md says so rather than leaving a reader to wonder why it is grey.
const COLORS = {
  blue: "#7cb0f5", green: "#5fca8f", violet: "#a996f5", magenta: "#ef8fc0", orange: "#f2a765",
  gray: "#c3cad6", cyan: "#79d7ea", red: "#f0999b", black: "#9aa4b2", brown: "#cfa47e", yellow: "#e8cf6a",
};
// The console knows four radii (circle 50%, squircle 30%, rounded 18%, square 8%). The scrape uses
// eighteen shape words. Eighteen shape drawings is UI work this wave does not buy, so the words are
// translated onto the four by how round the form is, and docs/BOTS.md carries the table.
const SHAPES = {
  egg: "circle", dome: "circle", pebble: "circle", blob: "circle", bean: "circle", cloud: "circle",
  squircle: "squircle", capsule: "squircle", teardrop: "squircle", leaf: "squircle", gem: "squircle", crystal: "squircle",
  tablet: "rounded", arch: "rounded", cylinder: "rounded", shield: "rounded",
  hex: "square", wedge: "square",
};

// ---------------------------------------------------------------- 3. integrations to plugins
//
// Keyed by the scrape's own name, case-folded. `plugin` is a real plugin id from catalog.ts or null.
// `offer` is what the page may put in front of a person: "connect" draws the Add card, "page" is a
// row that installs nothing (commit 1694a3f's rule, which X is under) and gets an information line
// and never an Add, "byo" is the add-your-own door through custom-mcp.
//
// GOOGLE, MEASURED RATHER THAN ASSUMED. Sheets, Calendar and Slides do not map to `google` because
// the row's own words say Gmail and Docs. They map because the server it installs was spawned on
// grok-bot-local-vm on 2026-09-09 and its 34 tools were listed: 11 sheets_*, 4 calendar_* and 12
// drive_*/docs_*, and NO slides_*. So Sheets and Calendar connect and Slides does not. Claiming a
// surface the server does not carry is the CONNECT-13 defect this catalog already names.
const APPS = {
  "gmail": { label: "Gmail", plugin: "google", offer: "connect" },
  "google sheets": { label: "Google Sheets", plugin: "google", offer: "connect" },
  "google calendar": { label: "Google Calendar", plugin: "google", offer: "connect" },
  "google drive": { label: "Google Drive", plugin: "google", offer: "connect" },
  "google slides": { label: "Google Slides", plugin: null, offer: "byo" },
  "slack": { label: "Slack", plugin: "slack", offer: "connect" },
  "notion": { label: "Notion", plugin: "notion", offer: "connect" },
  "notion-workspace": { label: "Notion", plugin: "notion", offer: "connect" },
  "linear": { label: "Linear", plugin: "linear", offer: "connect" },
  "x": { label: "X", plugin: "x", offer: "page" },
  "figma": { label: "Figma", plugin: null, offer: "byo" },
  "granola": { label: "Granola", plugin: null, offer: "byo" },
  "salesforce": { label: "Salesforce", plugin: null, offer: "byo" },
  "hex": { label: "Hex", plugin: null, offer: "byo" },
  "databricks sql": { label: "Databricks SQL", plugin: null, offer: "byo" },
  "gong": { label: "Gong", plugin: null, offer: "byo" },
  "profound": { label: "Profound", plugin: null, offer: "byo" },
  "pstack": { label: "pstack", plugin: null, offer: "byo" },
  "ashby": { label: "Ashby", plugin: null, offer: "byo" },
  "datadog": { label: "Datadog", plugin: null, offer: "byo" },
  "sentry": { label: "Sentry", plugin: null, offer: "byo" },
  "ramp": { label: "Ramp", plugin: null, offer: "byo" },
};

// ---------------------------------------------------------------- 4. memories, split at build time
//
// The host caps one remembered fact at 500 characters and normalizeMemoryContent (sand-memory.ts)
// collapses whitespace and then SLICES, silently. 48 of the pack's 444 paragraphs are longer than
// that and 62,898 characters would vanish mid sentence, on exactly the persona and job-boundary
// paragraphs that are the substance of the bot. We do not raise the cap -- it is read on every
// write path in the product, including the agent's own remember tool -- and we do not truncate.
// The paragraph is split at sentence boundaries into facts that each fit, `text` stays the
// paragraph the page shows and `facts` is the list the import seeds.
const FACT_LIMIT = 500;

function collapse(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }

/** Sentence ends, as a person reads them: . ! ? followed by a space, not inside "e.g." or a number. */
function sentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = text[i + 1];
    if (next != null && next !== " ") continue;
    // "e.g." and "U.S." and "1." are not sentence ends: a single letter or digit before the dot
    // with another dot two back is an abbreviation, and so is a lone capital.
    const before = text.slice(Math.max(0, i - 3), i);
    if (ch === "." && /(^|[\s(])([A-Za-z]|[A-Za-z]\.[A-Za-z])$/.test(before)) continue;
    out.push(text.slice(start, i + 1).trim());
    start = i + 1;
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out.filter((piece) => piece.length > 0);
}

/** Split one paragraph into facts of at most FACT_LIMIT characters, at sentence boundaries. */
function splitFacts(paragraph) {
  const text = collapse(paragraph);
  if (text.length <= FACT_LIMIT) return [text];
  const facts = [];
  let current = "";
  const push = () => { if (current.length > 0) { facts.push(current); current = ""; } };
  for (const sentence of sentences(text)) {
    // A single sentence longer than the cap has no boundary to break at, so it breaks at the last
    // space that fits. It happens on the pack's list-shaped memories ("Job: a, b, c, d ...").
    if (sentence.length > FACT_LIMIT) {
      push();
      let rest = sentence;
      while (rest.length > FACT_LIMIT) {
        let cut = rest.lastIndexOf(" ", FACT_LIMIT);
        if (cut <= 0) cut = FACT_LIMIT;
        facts.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
      continue;
    }
    if (current.length === 0) { current = sentence; continue; }
    if (current.length + 1 + sentence.length <= FACT_LIMIT) { current = `${current} ${sentence}`; continue; }
    push();
    current = sentence;
  }
  push();
  return facts;
}

// ---------------------------------------------------------------- 5. routines, a real cron or none
//
// automation-store.upsert writes nothing when a trigger will not normalise and the gateway still
// answers 200, and normalizeSchedule happily accepts the bare word "weekly", stores it, describes
// it as "weekly" and never computes a next run -- a dead routine the day somebody switches it on.
// So a routine gets a five-field cron resolved here at build time, or it is not created at all.
//
// A STATED CLOCK IS USED AS STATED. A cadence with no clock takes a DECLARED default, written here,
// in docs/BOTS.md, on the page and in the import report: 09:00 in the box's local time, 14:00 for
// an afternoon, 17:00 for an evening, 12:00 for a midday, 02:00 for a night with no hour. A default
// that is disclosed, created switched off, and named in the report is not an invented fact.
const DEFAULT_HOUR = 9, AFTERNOON_HOUR = 14, EVENING_HOUR = 17, MIDDAY_HOUR = 12, NIGHT_HOUR = 2;
const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clockOf(text) {
  // Only an explicit am/pm is read as a clock. "3:15 local" is genuinely ambiguous and belongs in
  // the overlay with a person's reason, not in a guess here.
  const match = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (match == null) return null;
  let hour = Number(match[1]) % 12;
  if (/pm/i.test(match[3])) hour += 12;
  return { hour, minute: Number(match[2] ?? 0) };
}

function clockWords(hour, minute) {
  const period = hour < 12 ? "AM" : "PM";
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}:${String(minute).padStart(2, "0")} ${period}`;
}

function resolveRoutine(name, summary) {
  const text = `${name}. ${summary}`.toLowerCase();
  const clock = clockOf(text);
  const stated = clock != null;
  const minute = stated ? clock.minute : 0;
  const night = /\bnight(ly)?\b/.test(text);
  const hour = stated ? clock.hour
    : /\bevening\b/.test(text) ? EVENING_HOUR
    : /\bafternoon\b/.test(text) ? AFTERNOON_HOUR
    : /\bmidday\b|\bnoon\b/.test(text) ? MIDDAY_HOUR
    : night ? NIGHT_HOUR
    : DEFAULT_HOUR;
  const at = clockWords(hour, minute);
  const how = stated ? "the cadence this routine states" : "the default hour, because this routine names a cadence and no clock";
  const cron = (dom, dow) => `${minute} ${hour} ${dom} * ${dow}`;
  const named = Object.keys(DAYS).filter((day) => new RegExp(`\\b${day}\\b`).test(text));
  const weekday = /\bweekday/.test(text);

  if (/\bquarterly\b|\beach quarter\b|\bevery quarter\b/.test(text)) {
    return { schedule: null, note: "Quarterly, which this box's schedules cannot say in words a person reads, so adding the bot does not create it. Make it a monthly routine you skip, or set the cron yourself." };
  }
  if (/\bmonthly\b|\bevery month\b|\bonce a month\b|\b1st of every month\b|\beach month\b|\bfirst of each month\b/.test(text)) {
    const first = /\bfirst business day\b/.test(text)
      ? `On the 1st at ${at}, ${how}. A cron cannot say "first business day", so it lands on the 1st whatever day that is.`
      : `On the 1st of every month at ${at}, ${how}.`;
    return { schedule: cron("1", "*"), note: first };
  }
  if (named.length > 0 && !weekday) {
    const numbers = [...new Set(named.map((day) => DAYS[day]))].sort((a, b) => a - b);
    const words = numbers.map((n) => DAY_NAMES[n]);
    const joined = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
    return { schedule: cron("*", numbers.join(",")), note: `Every ${joined} at ${at}, ${how}.` };
  }
  if (weekday) return { schedule: cron("*", "1-5"), note: `Weekdays at ${at}, ${how}.` };
  if (/\bevery day\b|\beach day\b|\bdaily\b|\ball seven days\b|\bevery morning\b|\bonce a day\b/.test(text)) {
    return { schedule: cron("*", "*"), note: `Every day at ${at}, ${how}.` };
  }
  if (night) return { schedule: cron("*", "*"), note: `Every day at ${at}, ${how}.` };
  if (/\btwice a week\b/.test(text)) {
    return { schedule: cron("*", "1,4"), note: `Monday and Thursday at ${at}. It states twice a week and names no days, so those two are the declared default; move them once it is yours.` };
  }
  if (/\bweekly\b|\bevery week\b|\bonce a week\b|\beach week\b/.test(text)) {
    return { schedule: cron("*", "1"), note: `Every Monday at ${at}. It states a week and names no day, so Monday is the declared default.` };
  }
  if (/\bhourly\b|\bevery hour\b/.test(text)) {
    return { schedule: null, note: "It runs through the day rather than at an hour, and this box only schedules a clock, so adding the bot does not create it." };
  }
  return { schedule: null, note: "This one waits on something this box cannot watch -- an event, or an hour you have not picked yet -- so adding the bot does not create it. Add it yourself from the routines panel when you know the cadence." };
}

// ---------------------------------------------------------------- 6. the build
const bots = Object.values(JSON.parse(readFileSync(path.join(DATA_DIR, "bots.json"), "utf8")));
const overlay = JSON.parse(readFileSync(path.join(DATA_DIR, "overlay.json"), "utf8"));
const failures = [];
const applied = new Set();

const byId = new Map(bots.map((bot) => [bot.id, bot]));
for (const row of overlay.drop) if (!byId.has(row.id)) failures.push(`overlay drops "${row.id}", which is not in bots.json`);
for (const row of overlay.category) if (!byId.has(row.id)) failures.push(`overlay gives "${row.id}" a category and it is not in bots.json`);
for (const row of overlay.replace) if (!byId.has(row.id)) failures.push(`overlay rewrites "${row.id}", which is not in bots.json`);
for (const row of overlay.schedule) if (!byId.has(row.id)) failures.push(`overlay schedules "${row.id}", which is not in bots.json`);

const DROPPED = new Set(overlay.drop.map((row) => row.id));
const CATEGORY = new Map(overlay.category.map((row) => [row.id, row]));
const SCHEDULE = new Map(overlay.schedule.map((row) => [`${row.id} ${row.routine}`, row]));

/** The overlay rows for one bot and one path, applied in file order. */
function overlaid(id, where, value) {
  let out = value;
  for (const [index, row] of overlay.replace.entries()) {
    if (row.id !== id || row.path !== where) continue;
    if (!out.includes(row.from)) {
      failures.push(`overlay row ${index} (${id} @${where}) replaces a string that is no longer there: ${JSON.stringify(row.from.slice(0, 70))}`);
      continue;
    }
    applied.add(index);
    out = out.split(row.from).join(row.to);
  }
  // Tidy up after a replacement without FLATTENING the source. 43 of the 444 memories carry real
  // line structure -- "JOB BOUNDARY", then "Owns:", then "Does not own:" on their own lines -- and
  // collapsing every run of whitespace turned those into one unreadable run-on. So: runs of spaces
  // collapse, trailing spaces on a line go, three or more blank lines become one, and line breaks
  // survive. The memory STORE collapses whitespace on its own when a fact is written, which is why
  // `facts` is built from the collapsed form and `text`, which is what the page shows, is not.
  // Every other field in the scrape is a single line already, so this only ever affects memories.
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** scrub, then the overlay: the table runs first so every overlay `from` is post-rename text. */
function copy(id, where, value) { return overlaid(id, where, scrub(value)); }

// A sentence that repeats verbatim across two or more bots is the vendor's own tagline for the app,
// not this bot's reason for wanting it. The page shows the plugin's own words for those and for the
// 41 that are blank; a sentence a person writes goes in the overlay, never a generated filler.
const lineCount = new Map();
for (const bot of bots) {
  for (const entry of bot.integrations ?? []) {
    const line = collapse(entry.description);
    if (line.length > 0) lineCount.set(line, (lineCount.get(line) ?? 0) + 1);
  }
}

const SKILL_TEMPLATE = (name, label, description, botName) => `---
name: ${name}
description: ${description}
---
# ${label}

## When to run this
${description}

## How to run it
1. Read what ${botName} already remembers, and the request in front of you. Say what you are about to do in one line.
2. Do the work in the order the memories set out, and stop at the first thing you cannot establish rather than filling the gap.
3. Hand back the result, and name plainly what you could not do and what you would need to do it.

## Written from a summary
This playbook arrived as a one-line summary and nothing else, so the three steps above are the shape of a job and not the job itself. Sharpen them after the first real run: replace them with what you actually did, the order you did it in, and the checks that mattered.
`;

const rows = [];
for (const bot of bots) {
  if (DROPPED.has(bot.id)) continue;

  const memories = (bot.memories ?? []).map((memory, index) => {
    const text = copy(bot.id, `memories[${index}]`, memory.description);
    return { text, facts: splitFacts(text) };
  }).filter((memory) => memory.text.length > 0);

  const skillPrefix = `${bot.id}-`;
  const skills = (bot.skills ?? []).map((skill, index) => {
    const name = copy(bot.id, `skills[${index}].name`, skill.name);
    const description = copy(bot.id, `skills[${index}].description`, skill.description);
    const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return { name, description, body: SKILL_TEMPLATE(`${skillPrefix}${slug}`, name, description, copy(bot.id, "name", bot.name)) };
  });

  const routines = (bot.routines ?? []).map((routine, index) => {
    const name = copy(bot.id, `routines[${index}].name`, routine.name);
    // "Disabled by default." is a statement about the upstream product, and the page already says
    // every routine lands switched off, so the sentence is stripped rather than shown twice.
    const summary = copy(bot.id, `routines[${index}].summary`, routine.summary).replace(/^Disabled by default\.\s*/i, "");
    const pinned = SCHEDULE.get(`${bot.id} ${name}`);
    if (pinned != null) { applied.add(`schedule:${bot.id}:${name}`); return { name, summary, schedule: pinned.cron, scheduleNote: pinned.note }; }
    const resolved = resolveRoutine(name, summary);
    return { name, summary, schedule: resolved.schedule, scheduleNote: resolved.note };
  });

  const apps = [];
  for (const entry of bot.integrations ?? []) {
    const raw = collapse(entry.name);
    const known = APPS[raw.toLowerCase()];
    if (known == null) { failures.push(`bot "${bot.id}" names the app "${raw}", which is not in the mapping table`); continue; }
    const written = collapse(entry.description);
    const own = written.length > 0 && (lineCount.get(written) ?? 0) < 2;
    apps.push({
      name: raw,
      label: known.label,
      line: own ? copy(bot.id, `integrations[${bot.integrations.indexOf(entry)}].description`, written) : "",
      plugin: known.plugin,
      offer: known.offer,
    });
  }
  const integrations = [...new Set(apps.map((app) => app.plugin).filter((id) => id != null))];

  const scraped = (bot.categories ?? []).filter((name) => name !== "From Grok Bot Team");
  const pinnedCategory = CATEGORY.get(bot.id);
  if (pinnedCategory != null) applied.add(`category:${bot.id}`);
  const category = pinnedCategory?.category ?? scraped[0];
  if (category == null) failures.push(`bot "${bot.id}" has no category once the team grouping is dropped, and the overlay gives it none`);
  const tags = scraped.filter((name) => name !== category);

  if (memories.length === 0 && skills.length === 0 && routines.length === 0) {
    failures.push(`bot "${bot.id}" carries no memory, skill or routine, so an import could do nothing with it`);
  }

  rows.push({
    id: bot.id,
    name: copy(bot.id, "name", bot.name),
    creator: collapse(bot.creatorName),
    creatorNote: "from the community",
    category: category ?? "Personal",
    ...(tags.length > 0 ? { tags } : {}),
    featured: false,
    tile: { color: COLORS[bot.color] ?? COLORS.gray, shape: SHAPES[bot.shape] ?? "squircle" },
    description: copy(bot.id, "description", bot.description),
    // The host has ONE identity field, the agent's description, and personaFor already composes
    // `description + blank line + instructions`. So a community row's `instructions` is its first
    // memory: the paragraph that says what this bot is. One paragraph is therefore duplicated
    // between the identity and the memory store on every row, deliberately, and docs/BOTS.md says so.
    instructions: memories[0]?.text ?? copy(bot.id, "description", bot.description),
    skills,
    integrations,
    ...(apps.length > 0 ? { apps } : {}),
    ...(memories.length > 0 ? { memories } : {}),
    ...(routines.length > 0 ? { routines } : {}),
    origin: "community",
    skillPrefix,
  });
}

for (const [index] of overlay.replace.entries()) {
  if (!applied.has(index)) failures.push(`overlay replace row ${index} was never applied; its bot may have been dropped`);
}
for (const row of overlay.category) if (!DROPPED.has(row.id) && !applied.has(`category:${row.id}`)) failures.push(`overlay category row for "${row.id}" was never applied`);
for (const row of overlay.schedule) if (!DROPPED.has(row.id) && !applied.has(`schedule:${row.id}:${row.routine}`)) failures.push(`overlay schedule row for "${row.id}" names the routine "${row.routine}", which that bot does not have`);

// The residue scan. Anything the table and the overlay together did not clean is a build failure,
// not a warning: a row that names the old upstream must never reach a page a customer reads.
const scan = (value, where) => {
  if (typeof value === "string") { if (VENDOR.test(value)) failures.push(`${where} still names the old upstream: ${JSON.stringify(value.slice(0, 120))}`); return; }
  if (Array.isArray(value)) return value.forEach((item, index) => scan(item, `${where}[${index}]`));
  if (value != null && typeof value === "object") return Object.entries(value).forEach(([key, item]) => scan(item, `${where}.${key}`));
};
for (const row of rows) scan(row, `bot "${row.id}"`);
for (const row of rows) for (const memory of row.memories ?? []) {
  for (const fact of memory.facts) if (collapse(fact).length > FACT_LIMIT) failures.push(`bot "${row.id}" has a fact of ${collapse(fact).length} characters, over the host's cap`);
}

if (failures.length > 0) {
  console.error(`build-bot-catalog: ${failures.length} problem${failures.length === 1 ? "" : "s"}`);
  for (const problem of failures) console.error(`  - ${problem}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 7. the module
const stamp = {
  bots: rows.length,
  memories: rows.reduce((n, row) => n + (row.memories?.length ?? 0), 0),
  facts: rows.reduce((n, row) => n + (row.memories ?? []).reduce((m, memory) => m + memory.facts.length, 0), 0),
  skills: rows.reduce((n, row) => n + row.skills.length, 0),
  routines: rows.reduce((n, row) => n + (row.routines?.length ?? 0), 0),
  scheduled: rows.reduce((n, row) => n + (row.routines ?? []).filter((routine) => routine.schedule != null).length, 0),
  apps: rows.reduce((n, row) => n + (row.apps?.length ?? 0), 0),
};

// U+2028 and U+2029 are legal inside a JSON string and used to be illegal inside a JavaScript
// one; escaping them costs nothing and means the emitted module cannot depend on the parser's vintage.
const json = JSON.stringify(rows, null, 2).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const module = `// GENERATED by scripts/build-bot-catalog.mjs from source/shared/marketplace/bots/bots.json
// and source/shared/marketplace/bots/overlay.json. DO NOT EDIT BY HAND: tests/community-bots.test.mjs
// regenerates this file in memory and fails on any difference, so a hand edit is a red suite rather
// than a row nobody can reproduce. To change a row, add an overlay entry with its \`why\` and rerun
// \`node scripts/build-bot-catalog.mjs\`.
//
// ${stamp.bots} community bots, ${stamp.memories} memories split into ${stamp.facts} facts that each fit the host's
// 500-character cap, ${stamp.skills} skills, ${stamp.routines} routines of which ${stamp.scheduled} resolve to a cron, and
// ${stamp.apps} app entries. The first-party rows in catalog.ts stay first in the catalog; these come after.
//
// docs/BOTS.md is the standard these rows are built to.
import type { MarketplaceBot } from "./catalog.js";

/**
 * Frozen all the way down, once, at module load. The rows are plain literals below because a
 * generated file where every node is an Object.freeze call is mostly ceremony; the invariant the
 * catalog relies on -- nobody mutates a catalog row at runtime -- is what this preserves.
 */
function deepFreeze<T>(value: T): T {
  if (value != null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

const ROWS = ${json} as unknown as readonly MarketplaceBot[];

export const COMMUNITY_BOTS: readonly MarketplaceBot[] = deepFreeze(ROWS);
`;

const argv = new Set(process.argv.slice(2));
// `process.exitCode` and NOT `process.exit()`: the module is close to a megabyte, a write that big
// to a PIPE is asynchronous, and process.exit() truncates it. The first thing --stdout was used for
// was a byte-identity test, which failed on a short read rather than on a real difference.
if (argv.has("--stdout")) { process.stdout.write(module); process.exitCode = 0; }
else if (argv.has("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { current = ""; }
  if (current === module) { console.log(`build-bot-catalog --check: community-bots.ts is current (${stamp.bots} bots, ${stamp.skills} skills, ${stamp.routines} routines)`); process.exitCode = 0; }
  else {
    console.error("build-bot-catalog --check: community-bots.ts differs from what the data and the overlay produce. Run `node scripts/build-bot-catalog.mjs`.");
    process.exitCode = 1;
  }
}
else {
  writeFileSync(OUT, module, "utf8");
  console.log(`build-bot-catalog: wrote ${path.relative(REPO, OUT)} -- ${stamp.bots} bots, ${stamp.memories} memories (${stamp.facts} facts), ${stamp.skills} skills, ${stamp.routines} routines (${stamp.scheduled} scheduled), ${stamp.apps} apps`);
}
