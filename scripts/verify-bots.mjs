// BOTS-4. The Bots tab, a bot's page and one click on Add, in a real browser against a real box.
//
// WHAT IT PROVES, and why each leg is here rather than in the unit test:
//
//   THE WORDS ARE ON SCREEN. The four blocks are Jason's own: Memories "Facts it already knows",
//   Skills "Playbooks it can run", Routines "Jobs that run on their own", Integrations "Apps it can
//   use". The unit test pins the markup; this reads the rendered page, because a block whose CSS
//   hides its hint is a block a person never read.
//
//   A PERSON CAN PRESS ADD. The round button on a row is measured -- its rectangle on screen, that
//   it is not nested inside the row's own button, and a REAL mouse click at its centre. A
//   page.click() would pass on a button of zero size under an overlay, and a nested button would
//   fire both handlers and still look fine.
//
//   THE ROSTER AND THE LIBRARY ARE DIFFED, NEVER COUNTED. This box carries two dozen bots and a
//   shared library with dozens of rows, most of it probe debris. Every leg takes the before-set and
//   the after-set and asserts the DIFFERENCE.
//
//   WHAT THE BOX HOLDS, NOT WHAT WAS ASKED FOR. addMemory answers null on a duplicate and the
//   automation store answers 200 on a write it dropped, so every claim is read back:
//   getAgentMemories, getAgentWorkflows, getAgentAutomations.
//
//   NO MEMORY WAS CUT. The host caps a fact at 500 characters and slices silently, so the memories
//   the box holds are compared against the row's own facts character for character, and a fact of
//   exactly 500 characters that is not the row's own is a cut one.
//
//   A SECOND CLICK MAKES NOTHING. The page is reloaded first, because a fresh browser is the case
//   that matters: nothing in it remembers the first click, and the check has to come off the box.
//
// It writes to the roster and to the shared library, so run it ALONE. Everything it creates is
// taken back in the finally, whatever happened.
//
//   node scripts/verify-bots.mjs
//   node scripts/verify-bots.mjs --keep        leave what it created on the box
//   node scripts/verify-bots.mjs --shots DIR   where the screenshots go
//
//   0  every leg passed        1  a leg failed        2  nothing could be measured
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "../.cache/playwright/node_modules/playwright-core/index.mjs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// SIGNIN-1: every gate says who it is, so the sign-in panel can tell a gate from an attacker.
const USER_AGENT = "titanbot-gate/verify-bots";
const MEMORY_CAP = 500;

const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const KEEP = process.argv.includes("--keep");
const SHOTS = flag("--shots", process.env.GROK_BOT_SHOTS ?? "/tmp/verify-bots");

let failures = 0;
let unmeasured = 0;
class NothingToMeasure extends Error {}
const bail = (why) => { throw new NothingToMeasure(why); };
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); unmeasured += 1; };
const info = (line) => console.log(`  INFO  ${line}`);
const step = (name) => console.log(`\n== ${name}`);
const oneLine = (value, width = 220) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, width);

function token() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch { /* the next one */ }
  }
  throw new Error("no gateway token: set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS");
}

let TOKEN;
try { TOKEN = token(); } catch (error) {
  console.error(`nothing could be measured: ${error.message}`);
  process.exit(2);
}

const gw = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};

// ---------------------------------------------------------------- the sets this gate diffs
const rosterOf = async () => {
  const rows = await gw("listAgents", {});
  return new Map((Array.isArray(rows) ? rows : []).map((agent) => [String(agent.id), String(agent.name ?? "")]));
};
// Asked through whichever bot answers: reading through one anchor gave an EMPTY list halfway
// through a run on 2026-09-09, and an empty-versus-empty diff passes every assertion.
const libraryOf = async (preferId) => {
  const roster = await rosterOf();
  for (const id of [...new Set([preferId, ...roster.keys()].filter(Boolean))]) {
    let rows;
    try { rows = await gw("getAgentWorkflows", { id }); } catch { continue; }
    if (!Array.isArray(rows)) continue;
    return new Map(rows.filter((row) => row != null && row.source !== "automation").map((row) => [String(row.id), String(row.name ?? "")]));
  }
  return new Map();
};
const added = (before, after) => [...after.entries()].filter(([id]) => !before.has(id));

// ---------------------------------------------------------------- the row's own four blocks
const RAIL = [
  ["memories", "Memories", "Facts it already knows"],
  ["skills", "Skills", "Playbooks it can run"],
  ["routines", "Routines", "Jobs that run on their own"],
  ["integrations", "Integrations", "Apps it can use"],
];

const memoriesOf = (bot) => (Array.isArray(bot?.memories) ? bot.memories : [])
  .map((row) => (typeof row === "string" ? { text: row } : row))
  .filter((row) => row != null);
// What the import SEEDS: the split facts where the row carries them, the paragraph where it does not.
const factsOf = (bot) => memoriesOf(bot).flatMap((memory) => (Array.isArray(memory.facts) && memory.facts.length
  ? memory.facts.map(String)
  : [String(memory.text ?? memory.description ?? "")])).map((fact) => fact.trim()).filter(Boolean);
const routinesOf = (bot) => (Array.isArray(bot?.routines) ? bot.routines : []).filter((row) => row != null && typeof row === "object");
const appsOf = (bot) => (Array.isArray(bot?.apps) ? bot.apps : []).filter((row) => row != null && typeof row === "object");

// ---------------------------------------------------------------- the run
let browser = null;
let context = null;
let page = null;
let createdAgentIds = [];
let startLibrary = new Map();
let anchorAgent = null;

const openBots = async () => {
  const alreadyOpen = (await page.$$("[data-marketplace-bots]")).length > 0;
  if (!alreadyOpen && (await page.$$("[data-marketplace-tab='bots']")).length === 0) {
    await page.click('[data-capability="marketplace"]').catch(() => {});
    await page.waitForTimeout(1200);
  }
  const opened = (await page.$$("[data-marketplace-bots] [data-bot-row], [data-marketplace-bots] [data-bot-id]")).length > 0
    || await page.click("#panel-dialog [data-marketplace-tab='bots']", { timeout: 4000 }).then(() => true).catch(() => false)
    || await page.locator("#panel-dialog button", { hasText: /^Bots$/ }).first().click({ timeout: 4000 }).then(() => true).catch(() => false);
  for (let n = 0; n < 30; n += 1) {
    if ((await page.$$("[data-bot-row]")).length > 0) break;
    await page.waitForTimeout(500);
  }
  return opened;
};

/** Empty the Bots search, so a query this gate typed to reach one row does not hide the next. */
const clearBotSearch = async () => {
  const box = await page.$("[data-bot-search]");
  if (box == null) return;
  const value = await box.inputValue().catch(() => "");
  if (!value) return;
  await box.fill("").catch(() => {});
  await page.waitForTimeout(500);
};

const openBotPage = async (id, name = null) => {
  if ((await page.$$(`[data-bot-page="${id}"]`)).length > 0) return true;
  if ((await page.$$(`[data-bot-id="${id}"]`)).length === 0) {
    await page.click("[data-bots-back]", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(600);
  }
  // MEASURED on grok-bot-local-vm 2026-09-09: the All view draws 40 of the 72 rows, because each
  // topical section shows six and then offers "See all N in <category>". That is the page working
  // as designed, and it means a gate that only ever looks at the All view can reach 40 bots. So
  // when the row is not on screen the gate does what a person does: it searches for it by name.
  if (name && (await page.$$(`[data-bot-id="${id}"]`)).length === 0) {
    const box = await page.$("[data-bot-search]");
    if (box != null) {
      await box.click({ timeout: 4000 }).catch(() => {});
      await box.fill(String(name)).catch(() => {});
      await page.waitForTimeout(700);
    }
  }
  // The list is WAITED FOR rather than read on a fixed delay. Measured on grok-bot-local-vm
  // 2026-09-09: with 72 rows the back-to-the-list paint does not always land inside 600 ms, and the
  // third bot of the run then read as a page that would not open when the row simply was not drawn
  // yet. On the seven-row catalog this gate was written against it never missed.
  let found = null;
  for (let n = 0; n < 25 && found == null; n += 1) {
    found = await page.$(`[data-bot-id="${id}"]`);
    if (found == null) await page.waitForTimeout(400);
  }
  if (found == null) return false;
  await found.scrollIntoViewIfNeeded().catch(() => {});
  await found.click({ timeout: 6000 }).catch(() => {});
  for (let n = 0; n < 20; n += 1) {
    if ((await page.$$(`[data-bot-page="${id}"]`)).length > 0) return true;
    await page.waitForTimeout(400);
  }
  return false;
};

/** A REAL mouse press at the centre of the element's own rectangle, and the rectangle reported. */
const pressAtCentre = async (selector) => {
  const box = await (await page.$(selector))?.boundingBox() ?? null;
  if (box == null || box.width < 8 || box.height < 8) return { box, pressed: false };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  return { box, pressed: true };
};

const shot = async (name) => {
  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
  } catch (error) { info(`screenshot ${name} failed: ${error.message}`); }
};

try {
  step("the box, and what it serves");
  const served = await gw("listMarketplace", {}).catch((error) => ({ error: error.message }));
  if (served?.error) bail(`the host would not serve a catalog: ${served.error}`);
  const cards = Array.isArray(served.bots) ? served.bots : [];
  if (cards.length === 0) bail("this box's host serves no bots at all");
  info(`the host serves ${cards.length} bots and ${(served.plugins ?? []).length} plugins`);

  // The row for a bot, through the command the page itself now uses.
  const detailOf = async (id) => gw("getMarketplaceItem", { kind: "bot", id }).catch(() => null);

  // THREE ROWS, PICKED BY PROPERTY off the served catalog rather than by name, so the gate keeps
  // measuring the thing it is for when the catalog is regenerated.
  const rows = [];
  for (const card of cards) {
    const row = await detailOf(String(card.id));
    if (row != null) rows.push(row);
  }
  check(rows.length === cards.length, "every bot on the list can be fetched as its own row",
    `${rows.length} of ${cards.length} answered getMarketplaceItem`);
  const single = rows.filter((row) => !Array.isArray(row.members) || row.members.length === 0);
  const withRoutines = single.find((row) => routinesOf(row).some((routine) => String(routine.schedule ?? "").trim())) ?? null;
  const withByoApp = single.find((row) => appsOf(row).some((app) => !String(app.pluginId ?? "").trim()) && row.id !== withRoutines?.id) ?? null;
  const withTags = single.find((row) => (row.tags ?? []).length > 0 && row.id !== withRoutines?.id && row.id !== withByoApp?.id) ?? null;
  const picks = [
    ["a bot with jobs of its own", withRoutines],
    ["a bot naming an app this box has no plugin for", withByoApp],
    ["a bot that carried two categories upstream", withTags],
  ];
  for (const [what, row] of picks) {
    if (row == null) skip(`pick: ${what}`, "no row on this box's catalog carries that");
    else info(`pick: ${what} -> ${row.id} (${row.name})`);
  }
  // Something has to be opened even on a catalog that carries none of the three, or the page legs
  // measure nothing at all.
  const fallback = single[0] ?? null;
  const chosen = [...new Set(picks.map(([, row]) => row).filter(Boolean))];
  if (chosen.length === 0 && fallback != null) {
    info(`no row carries any of the three properties, so the page legs run against ${fallback.id}`);
    chosen.push(fallback);
  }
  if (chosen.length === 0) bail("this box's catalog carries no single-bot row to open");

  startLibrary = await libraryOf(null);
  const startRoster = await rosterOf();
  anchorAgent = [...startRoster.keys()][0] ?? null;
  info(`this box holds ${startRoster.size} bots and ${startLibrary.size} documents before anything is added`);
  for (const row of chosen) {
    const clash = [...startRoster.values()].filter((name) => name === String(row.name));
    if (clash.length > 0) bail(`a bot called "${row.name}" is already on this box, so nothing here can be diffed; remove it and run again`);
  }

  step("the console, in a real browser");
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on("pageerror", (error) => { console.log(`  PAGEERROR ${error.message}`); failures += 1; });
  // What one Marketplace open costs, in bytes and in round trips.
  const catalogReads = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (!/\/api\/(listMarketplace|getMarketplaceItem)$/.test(url)) return;
    const size = await response.body().then((body) => body.length).catch(() => 0);
    catalogReads.push({ url: url.slice(url.lastIndexOf("/") + 1), size });
  });
  await page.goto(`${GATEWAY}/`, { waitUntil: "load" });
  await page.waitForTimeout(3500);
  check(await openBots(), "the Marketplace opens and the Bots tab opens");
  await shot("bots-list");

  step("the list");
  const drawn = await page.$$eval("[data-bot-row]", (els) => els.map((el) => el.dataset.botRow));
  check(drawn.length > 0, "the list draws its rows", `${drawn.length} rows on screen`);
  const listReads = catalogReads.filter((row) => row.url === "listMarketplace");
  const listBytes = listReads.reduce((sum, row) => sum + row.size, 0);
  info(`listMarketplace: ${listReads.length} fetch(es) on one open, ${listBytes} B in total`
    + ` (measured on this box, ${new Date().toISOString().slice(0, 10)})`);
  check(listReads.length <= 1, "the catalog is fetched once on one Marketplace open", `${listReads.length} fetches`);

  // The chips are chips, and every one of them has members.
  const chips = await page.$$eval("[data-bot-category]", (els) => els.map((el) => ({
    name: el.dataset.botCategory,
    className: el.className,
    inChipRow: el.closest(".marketplace-chips") != null,
    tag: "TAG",
  })));
  const chipRow = chips.filter((chip) => chip.inChipRow);
  check(chipRow.length > 0 && chipRow.every((chip) => /(^|\s)tag(\s|$)/.test(chip.className)),
    "every category chip is a tag in the chip row, the way the Plugins half draws one",
    chipRow.map((chip) => `${chip.name}:${chip.className}`).join(" | ").slice(0, 200));
  check(!chipRow.some((chip) => /roster-tab/.test(chip.className)), "and none of them is still a panel tab");
  const empties = [];
  for (const chip of chipRow) {
    if (chip.name === "All") continue;
    await page.click(`[data-bot-category="${chip.name.replace(/"/g, '\\"')}"]`).catch(() => {});
    await page.waitForTimeout(250);
    const shown = (await page.$$("[data-bot-row]")).length;
    if (shown === 0) empties.push(chip.name);
  }
  check(empties.length === 0, "no chip filters the list to nothing", empties.join(", "));
  await page.click('[data-bot-category="All"]').catch(() => {});
  await page.waitForTimeout(400);

  // The Add on a row is a sibling of the row's open button, and a person can hit it.
  const first = chosen[0];
  const shape = await page.$eval(`[data-bot-row="${first.id}"]`, (row) => ({
    wrapperIsButton: row.tagName === "BUTTON",
    addInsideOpen: row.querySelector("[data-bot-id] [data-add-bot]") != null,
    addIsSibling: row.querySelector(":scope > [data-add-bot]") != null,
  })).catch(() => null);
  if (shape == null) check(false, "the chosen bot has a row on screen", first.id);
  else {
    check(!shape.wrapperIsButton, "a row is not itself a button");
    check(!shape.addInsideOpen, "the Add is not nested inside the row's own button");
    check(shape.addIsSibling, "the Add is a sibling of it, in the row's third column");
  }

  step("a bot's page: the four blocks, in the words a person was promised");
  for (const row of chosen) {
    const id = String(row.id);
    const opened = await openBotPage(id, row.name);
    check(opened, `${row.name}: its page opens`);
    if (!opened) continue;
    // The page paints the card first and fills itself in when getMarketplaceItem answers, so the
    // blocks are read once that read has landed. Waiting on the page's own "still reading" line
    // rather than on a fixed delay is what makes this leg the same on a slow box as a fast one.
    for (let n = 0; n < 25; n += 1) {
      const stillReading = await page.$$eval(".empty-state", (els) => els.some((el) => /Reading this bot's own row/.test(el.textContent ?? "")));
      const drawn = (await page.$$("[data-bot-memories], [data-bot-skills], [data-bot-routine]")).length > 0;
      if (!stillReading && drawn) break;
      await page.waitForTimeout(400);
    }
    const rail = await page.$$eval("[data-bot-page] [data-bot-tab]", (els) => els.map((el) => ({
      id: el.dataset.botTab,
      label: el.querySelector("strong")?.textContent?.trim() ?? "",
      hint: el.querySelector("small")?.textContent?.trim() ?? "",
      active: el.className.includes("is-active"),
      visible: el.getBoundingClientRect().height > 0,
    })));
    check(rail.length === RAIL.length && RAIL.every(([blockId, label, hint], at) =>
      rail[at]?.id === blockId && rail[at]?.label === label && rail[at]?.hint === hint),
    `${row.name}: the four blocks are drawn in order, with their own words`,
    rail.map((entry) => `${entry.label}/${entry.hint}`).join(" | "));
    check(rail.every((entry) => entry.visible), `${row.name}: and every one of them is on screen`);
    check(rail[0]?.active === true, `${row.name}: the page opens on Memories`);

    // Memories: paragraphs of the row's own prose.
    const paragraphs = await page.$$eval("[data-bot-memories] p", (els) => els.map((el) => el.textContent.trim()));
    const wanted = memoriesOf(row).map((memory) => String(memory.text ?? memory.description ?? "").trim()).filter(Boolean);
    if (wanted.length === 0) skip(`${row.name}: the memories block`, "this row carries no memories");
    else {
      check(paragraphs.length === wanted.length, `${row.name}: every memory is a paragraph of its own`, `${paragraphs.length} on screen, ${wanted.length} on the row`);
      // A memory carries real line breaks on 42 rows of the pack -- a heading, then "Owns:", then
      // "Does not own:" -- and the page honours them, so textContent comes back with them in it.
      // Both sides collapse before the comparison; the point of this leg is that no character was
      // LOST, not that the whitespace matches.
      const flat = (value) => String(value).replace(/\s+/g, " ").trim();
      check(wanted.every((memory) => paragraphs.some((drawn) => flat(drawn) === flat(memory))),
        `${row.name}: and each is the row's own text, uncut`, oneLine(paragraphs[0] ?? ""));
    }
    await shot(`bot-page-${id}-memories`);

    // Routines: the cadence in words, and switched off.
    await page.click('[data-bot-tab="routines"]').catch(() => {});
    await page.waitForTimeout(400);
    const routineRows = await page.$$eval("[data-bot-routine]", (els) => els.map((el) => ({
      name: el.dataset.botRoutine,
      text: el.textContent.replace(/\s+/g, " ").trim(),
    })));
    const declared = routinesOf(row);
    if (declared.length === 0) skip(`${row.name}: the routines block`, "this row carries no jobs");
    else {
      check(routineRows.length === declared.length, `${row.name}: every job is on the page`, `${routineRows.length} of ${declared.length}`);
      const scheduled = declared.filter((routine) => String(routine.schedule ?? "").trim());
      const drawnScheduled = routineRows.filter((drawn) => /off until you switch it on/.test(drawn.text));
      check(drawnScheduled.length === scheduled.length, `${row.name}: and each one that will be created says it arrives off`,
        `${drawnScheduled.length} say so, ${scheduled.length} carry a schedule`);
      check(!routineRows.some((drawn) => /\*\s|\* \*|^\d+ \d+ \*/.test(drawn.text)), `${row.name}: and none of them shows a raw expression`,
        oneLine(routineRows.map((drawn) => drawn.text).join(" / ")));
      const events = declared.length - scheduled.length;
      if (events > 0) {
        check(routineRows.some((drawn) => /cannot watch/.test(drawn.text)), `${row.name}: the ones that will not be created say so`);
      }
    }
    await shot(`bot-page-${id}-routines`);

    // Integrations: the bot's own sentence, and one of exactly three controls.
    await page.click('[data-bot-tab="integrations"]').catch(() => {});
    await page.waitForTimeout(400);
    const appRows = await page.$$eval("[data-integration]", (els) => els.map((el) => ({
      id: el.dataset.integration,
      offer: el.dataset.appOffer ?? "",
      line: el.querySelector("small")?.textContent?.trim() ?? "",
      add: el.querySelector("[data-add-integration]") != null,
      installed: /installed/i.test(el.querySelector(".status-pill")?.textContent ?? ""),
      unavailable: /not available yet/i.test(el.textContent ?? ""),
    })));
    const declaredApps = appsOf(row);
    if (appRows.length === 0) skip(`${row.name}: the integrations block`, "this row names no apps");
    else {
      check(appRows.every((app) => app.installed || app.add || app.unavailable || /nothing to install/.test(app.line) || app.offer === "page"),
        `${row.name}: every app carries one of the three controls`,
        appRows.map((app) => `${app.id}:${app.installed ? "installed" : app.add ? "add" : app.offer}`).join(", "));
      check(!appRows.some((app) => app.offer === "page" && app.add), `${row.name}: and a row that installs nothing offers no Add`);
      check(!appRows.some((app) => app.offer === "byo" && app.add), `${row.name}: and neither does one this box has no plugin for`);
      const sentences = declaredApps.map((app) => String(app.line ?? "").trim()).filter(Boolean);
      if (sentences.length === 0) skip(`${row.name}: the apps' own sentences`, "this row writes none");
      else {
        const onScreen = await page.$eval("[data-bot-apps]", (el) => el.textContent.replace(/\s+/g, " "));
        const missing = sentences.filter((line) => !onScreen.includes(line.replace(/\s+/g, " ")));
        check(missing.length === 0, `${row.name}: each app shows what THIS bot does with it`, oneLine(missing[0] ?? sentences[0]));
      }
    }
    await shot(`bot-page-${id}-integrations`);
    await page.click("[data-bots-back]").catch(() => {});
    await page.waitForTimeout(500);
  }

  step("one press on Add, at the centre of the button a person sees");
  await clearBotSearch();
  const subject = chosen[0];
  const subjectId = String(subject.id);
  const beforeRoster = await rosterOf();
  const beforeLibrary = await libraryOf(anchorAgent);
  let target = await page.$(`[data-bot-row="${subjectId}"] [data-add-bot]`);
  if (target == null) {
    // Its section shows six and the rest are behind "See all"; a person would search for it, so
    // this does, and the press is still a real press at the centre of the button it finds.
    const searchBox = await page.$("[data-bot-search]");
    if (searchBox != null) { await searchBox.fill(String(subject.name)); await page.waitForTimeout(700); }
    target = await page.$(`[data-bot-row="${subjectId}"] [data-add-bot]`);
  }
  if (target != null) await target.scrollIntoViewIfNeeded().catch(() => {});
  const { box, pressed } = await pressAtCentre(`[data-bot-row="${subjectId}"] [data-add-bot]`);
  check(pressed, "the round Add on the row is a real target", box == null ? "no rectangle at all" : `${Math.round(box.width)}x${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}`);

  let agentId = null;
  if (pressed) {
    const by = Date.now() + 120_000;
    while (Date.now() < by) {
      await page.waitForTimeout(1500);
      const roster = await rosterOf().catch(() => beforeRoster);
      const fresh = added(beforeRoster, roster).find(([, name]) => name === String(subject.name) || name.startsWith(String(subject.name)));
      if (fresh != null) { agentId = fresh[0]; break; }
    }
    check(agentId != null, "Add creates the bot on the box, under its own title", agentId ?? "no new bot after 120s");
  }
  if (agentId != null) createdAgentIds.push(agentId);
  await shot("after-add");

  if (agentId != null) {
    step("what the box actually holds");
    const rosterNow = await rosterOf();
    check(rosterNow.get(agentId) === String(subject.name), "the bot's name on the roster is the bot's title", rosterNow.get(agentId));

    // MEMORIES. Every fact the row declares, none of them cut at the host's 500-character cap.
    const wantedFacts = factsOf(subject);
    const held = await gw("getAgentMemories", { id: agentId }).catch(() => null);
    if (!Array.isArray(held)) skip("the memory store", "this host answered no getAgentMemories");
    else if (wantedFacts.length === 0) skip("the memory store", "this row declares no memories");
    else {
      const contents = held.map((row) => String(row.content ?? "").trim());
      const missing = wantedFacts.filter((fact) => !contents.includes(fact.replace(/\s+/g, " ").trim()));
      check(missing.length === 0, "the memory store holds every fact the row declares",
        missing.length ? `${missing.length} missing, first: ${oneLine(missing[0], 90)}` : `${contents.length} facts`);
      const cut = contents.filter((content) => content.length === MEMORY_CAP && !wantedFacts.includes(content));
      check(cut.length === 0, "and not one of them is a 500-character cut", cut.length ? oneLine(cut[0], 90) : "");
      if (missing.length === wantedFacts.length) {
        info("no fact of this row's reached the store, which is what a build with no setup module does");
      }
    }

    // SKILLS. Diffed, never counted, and matched by name against the row's own.
    const libraryNow = await libraryOf(agentId);
    const newDocs = added(beforeLibrary, libraryNow).map(([, name]) => name);
    // A skill's `name` is the LABEL the page shows ("Getting started"); the document the box files
    // is named by the skill's own frontmatter, which the generator namespaces by bot
    // ("account-book-getting-started"). That is deliberate: the library is box-wide and dozens of
    // these 65 bots ship a playbook called "Getting started". So the library is checked against the
    // document name the row itself declares, read out of its own body, and never against the label.
    const documentName = (skill) => {
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(skill?.body ?? ""));
      const named = front ? /^name:\s*(.+)$/m.exec(front[1]) : null;
      return String(named ? named[1] : skill?.name ?? "").trim();
    };
    const wantedSkills = (subject.skills ?? []).map(documentName).filter(Boolean);
    if (wantedSkills.length === 0) skip("the shared library", "this row carries no playbooks");
    else {
      const absent = wantedSkills.filter((name) => !newDocs.some((doc) => doc === name || doc.includes(name)));
      check(absent.length === 0, "the shared library gained every playbook the row carries",
        absent.length ? `missing: ${absent.join(", ")}; gained: ${newDocs.join(", ")}` : newDocs.join(", "));
    }

    // ROUTINES. Present, switched off, and described in prose rather than in cron.
    const wantedRoutines = routinesOf(subject).filter((routine) => String(routine.schedule ?? "").trim());
    const automations = await gw("getAgentAutomations", { id: agentId }).catch(() => null);
    if (!Array.isArray(automations)) skip("the jobs", "this host answered no getAgentAutomations");
    else if (wantedRoutines.length === 0) skip("the jobs", "this row declares none with a schedule");
    else {
      const byName = new Map(automations.map((row) => [String(row.name ?? ""), row]));
      const absent = wantedRoutines.filter((routine) => !byName.has(String(routine.name)));
      check(absent.length === 0, "every job with a schedule was created",
        absent.length ? `missing: ${absent.map((r) => r.name).join(", ")}; created: ${[...byName.keys()].join(", ")}` : [...byName.keys()].join(", "));
      const live = wantedRoutines.map((routine) => byName.get(String(routine.name))).filter(Boolean);
      check(live.length > 0 && live.every((row) => row.isEnabled === false), "and every one of them arrived switched off",
        live.map((row) => `${row.name}:${row.isEnabled}`).join(", "));
      check(live.every((row) => String(row.triggerDescription ?? "").trim() && !/^[\d*/,\-\s]+$/.test(String(row.triggerDescription))),
        "and each says when it runs in words, not in an expression",
        live.map((row) => oneLine(row.triggerDescription, 40)).join(" | "));
    }

    // THE RECEIPT. The panel card is what a box with no model still shows.
    const openedAgain = await openBotPage(subjectId, subject.name);
    const receipt = openedAgain
      ? await page.$eval("[data-bot-setup-done], [data-imported-agent]", (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => "")
      : "";
    check(receipt.length > 0, "the page reports what was set up", oneLine(receipt, 200));
    check(/not connected|already on this box|every app/i.test(receipt), "and says what it could not connect", oneLine(receipt, 160));
    // The number on the receipt is what THIS run added, not the shared library filtered by the
    // row's names. Measured on this box 2026-09-09: it read "13 playbooks" for a bot carrying one,
    // because the library holds several rows under one name from earlier imports.
    const claimed = Number((/(\d+)\s+playbook/.exec(receipt) ?? [])[1] ?? NaN);
    if (Number.isFinite(claimed)) {
      check(claimed <= newDocs.length, "and the count of playbooks it claims is the count it added",
        `${claimed} claimed, ${newDocs.length} added`);
    }
    await shot("receipt");

    // THE FIRST MESSAGE, on this one bot only.
    step("the bot's own first message");
    let introduced = null;
    const by = Date.now() + 90_000;
    while (Date.now() < by) {
      const outline = await gw("getConversationOutline", { id: agentId }).catch(() => null);
      const assistant = (Array.isArray(outline) ? outline : []).find((row) => /assistant/i.test(String(row?.role ?? row?.kind ?? "")));
      if (assistant != null) { introduced = assistant; break; }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (introduced == null) {
      const endpoints = await fetch(`${GATEWAY}/endpoints`, { headers: { "user-agent": USER_AGENT } })
        .then((res) => res.json()).catch(() => ({}));
      const healthy = (endpoints.endpoints ?? []).length;
      skip("the bot introduces itself", healthy === 0
        ? "this box has no model endpoint configured, so no bot can write anything"
        : "nothing was written to its conversation inside 90s");
    } else {
      check(true, "the bot wrote its own first message", oneLine(introduced.title ?? introduced.summary ?? "", 120));
    }

    // A SECOND PRESS, from a browser that remembers nothing.
    step("a second press makes nothing");
    const rosterBeforeSecond = await rosterOf();
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(3500);
    await openBots();
    const secondTarget = await page.$(`[data-bot-row="${subjectId}"] [data-add-bot]`);
    if (secondTarget == null) {
      skip("the second press", "the row draws no Add after a reload, so there was nothing to press");
    } else {
      await secondTarget.scrollIntoViewIfNeeded().catch(() => {});
      const second = await pressAtCentre(`[data-bot-row="${subjectId}"] [data-add-bot]`);
      check(second.pressed, "the Add is still a real target on a fresh page");
      await page.waitForTimeout(4000);
      const said = await page.evaluate(() => document.body.textContent.replace(/\s+/g, " "));
      check(/already on the roster/i.test(said), "and it says the bot is already on the roster");
      const rosterAfter = await rosterOf();
      const extra = added(rosterBeforeSecond, rosterAfter);
      check(extra.length === 0, "and the roster is unmoved", extra.map(([, name]) => name).join(", "));
      await shot("second-press");
    }
  }
} catch (error) {
  if (error instanceof NothingToMeasure) {
    console.log(`\n  STOP  ${error.message}`);
    unmeasured += 1;
  } else {
    console.log(`\n  FAIL  the run threw: ${error?.stack ?? error}`);
    failures += 1;
  }
} finally {
  if (!KEEP && createdAgentIds.length > 0) {
    // Documents FIRST, while a bot they can be asked through is still alive: they outlive their
    // bot, and deleting the bots alone is exactly the leftovers the next run would trip over.
    let docs = 0;
    const library = await libraryOf(createdAgentIds[0]).catch(() => new Map());
    for (const [id, name] of library.entries()) {
      if (startLibrary.has(id)) continue;
      if (await gw("deleteAgentWorkflow", { id: createdAgentIds[0], workflowId: id }).then(() => true).catch(() => false)) {
        docs += 1;
        info(`took back the document ${name}`);
      }
    }
    for (const id of createdAgentIds) await gw("deleteAgent", { id }).catch(() => {});
    console.log(`  removed ${createdAgentIds.length} bot(s) and ${docs} document(s) this run created`);
  } else if (KEEP && createdAgentIds.length > 0) {
    console.log(`  --keep: ${createdAgentIds.length} bot(s) left on the box`);
  }
  if (browser != null) await browser.close().catch(() => {});
  console.log(`  screenshots in ${SHOTS}`);
}

// A run that measured nothing is not a pass.
const verdict = failures > 0 ? "FAIL" : unmeasured > 0 ? "INCOMPLETE" : "PASS";
console.log(`\n${verdict}  ${failures} failure(s)${unmeasured ? `, ${unmeasured} leg(s) not measured` : ""}`);
process.exit(failures > 0 ? 1 : unmeasured > 0 ? 2 : 0);
