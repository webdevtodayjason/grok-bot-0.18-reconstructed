// TEAMS-1. The Marketing team pack, in a real browser against a real box.
//
// WHAT IT PROVES, and why each leg is here rather than in the unit test:
//
//   THE CHIPS ARE BOT CATEGORIES. Measured on screen on 2026-09-09, the Bots tab drew
//   "Development", "Code review" and "Shell tools" -- the PLUGIN list -- because the adapter's
//   cache flattens the host's { plugins, bots } for the Plugins tab and this tab took whatever
//   flat array arrived. No JSON test would ever see that: the wire was right and the page was
//   wrong. So the first leg reads the chips off the rendered page and holds them against what
//   listMarketplace actually declares for bots.
//
//   A PERSON CAN CLICK IMPORT. A passing page.click() is not evidence of that, so the button is
//   measured: its rectangle on screen, that it is enabled, and that it is the same primary control
//   every other Import is.
//
//   THE ROSTER AND THE LIBRARY ARE DIFFED, NEVER COUNTED. This box carries two dozen agents, most
//   of them probe debris, and a shared workflow library with 26 Gate rows and three copies of
//   web-research-pass left by three imports of another template. A count would pass on the wrong
//   set. Every leg below takes the before-set and the after-set and asserts the DIFFERENCE.
//
//   A SECOND IMPORT LEAVES NO DOUBLES. That is the defect the namespace exists for: the host
//   suffixes on a name collision (web-research-pass-2, -3) and never dedupes.
//
//   THE CAP REFUSAL CREATES NOTHING. SAND_MAX_AGENTS is lowered for real, on the running box, and
//   the roster is diffed across the refused import. Restored afterwards whatever happens.
//
//   THE APPROVAL CARD STOPS THE TURN. Driven by a stub model on this Mac, not a real one, so what
//   is measured is the product and not the model's mood: the stub asserts the coordinator's own
//   prompt carries the approval rule and the fixture brand profile, then sends the widget, and the
//   gate checks the card is on screen, that the host asked for no further completion afterwards,
//   and that nothing else was dispatched. The stub writes the posts, so this leg proves the STOP
//   and the material the model was given, never that a model writes a good week.
//
//   REMOVE TEAM PUTS THE BOX BACK. Both the bots and the documents, checked against the set the
//   run found rather than against a number.
//
// It repins the box's model endpoint for the length of the run, so run it ALONE, through
// scripts/on-box.sh. It needs the box up on a bundle from this tree and a relay serving this tree.
//
//   node scripts/verify-marketing.mjs
//   node scripts/verify-marketing.mjs --no-model   skip the stub-model leg (no endpoint repin)
//   node scripts/verify-marketing.mjs --keep       leave the imported team on the box
//
//   0  every leg passed        1  a leg failed        2  nothing could be measured
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { chromium } from "../.cache/playwright/node_modules/playwright-core/index.mjs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SETTINGS = "/home/box/sand-data/sand-host-settings.json";
const MAX_AGENTS_SETTING = "SAND_MAX_AGENTS";
const PACK_ID = "marketing-team";

const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const NO_MODEL = process.argv.includes("--no-model");
const KEEP = process.argv.includes("--keep");
const STUB_PORT = Number.parseInt(flag("--stub-port", "18795"), 10);
const STUB_MODEL = "marketing-gate-stub";
const STUB_ID = "marketing-gate-stub";

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (value, width = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, width);

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
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};

const relay = async (route, body) => {
  const res = await fetch(`${GATEWAY}${route}`, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${oneLine(typeof parsed === "string" ? parsed : parsed.error)}`);
  return parsed;
};

const docker = (args) => new Promise((resolve) =>
  execFile("docker", args, { maxBuffer: 64 << 20 }, (error, out) => resolve(error && !out ? "" : String(out))));
const sh = (script) => docker(["exec", BOX, "sh", "-lc", script]);

// The switch file, not container env: the cap has to move on a RUNNING box, and it does, because
// the host caches the parse against the file's mtime rather than reading it once at start.
const readSetting = async (name) => {
  const raw = await sh(`cat ${SETTINGS} 2>/dev/null || echo '{}'`);
  try { return JSON.parse(raw)[name]; } catch { return undefined; }
};
const writeSetting = async (name, value) => {
  const mutate = value == null ? `delete d[${JSON.stringify(name)}];` : `d[${JSON.stringify(name)}]=${JSON.stringify(value)};`;
  await docker(["exec", BOX, "node", "-e",
    `const fs=require('fs');const p=${JSON.stringify(SETTINGS)};`
    + `let d={};try{const parsed=JSON.parse(fs.readFileSync(p,'utf8'));`
    + `if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))d=parsed;}catch{}`
    + `${mutate}fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});`]);
};

// ---------------------------------------------------------------- the two sets this gate diffs
//
// A ROSTER is a map of id -> name. A LIBRARY is the box's shared workflow list, which every agent
// sees, so it is read through whatever agent is handy and the answer is the same either way.
const rosterOf = async () => {
  const rows = await gw("listAgents", {});
  return new Map((Array.isArray(rows) ? rows : []).map((agent) => [String(agent.id), String(agent.name ?? "")]));
};
// Asked through whichever agent answers, not through one chosen at the start of the run.
// Measured 2026-09-09: reading it through a single anchor gave an EMPTY list halfway through a
// run, and an empty-versus-empty diff passes every assertion while proving nothing. So a failed
// read moves to the next agent, and a library that comes back empty on a box that has one is a
// failure rather than a quiet zero.
const libraryOf = async (preferId) => {
  const roster = await rosterOf();
  const ids = [...new Set([preferId, ...roster.keys()].filter(Boolean))];
  for (const id of ids) {
    let rows;
    try { rows = await gw("getAgentWorkflows", { id }); } catch { continue; }
    if (!Array.isArray(rows)) continue;
    return new Map(rows
      .filter((row) => row != null && row.source !== "automation")
      .map((row) => [String(row.id), String(row.name ?? "")]));
  }
  return new Map();
};
const added = (before, after) => [...after.entries()].filter(([id]) => !before.has(id));
const lost = (before, after) => [...before.entries()].filter(([id]) => !after.has(id));

// ---------------------------------------------------------------- the stub model
//
// It answers only a request that offers SendMessage, so a title generator borrowing the same
// pinned endpoint gets plain text and does not consume the one widget this leg has to send.
function startStub(port, state) {
  const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const chunk = (delta, finish = null) => ({
    id: "probe-marketing", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model: STUB_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && String(req.url).startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: STUB_MODEL, object: "model", max_model_len: 128_000, context_length: 128_000 }] }));
    }
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let parsed = {}; try { parsed = JSON.parse(body || "{}"); } catch { /* plain text below */ }
      const offered = (parsed.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const finish = () => {
        sse(res, { ...chunk({}, "stop"), usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } });
        res.write("data: [DONE]\n\n");
        res.end();
      };
      if (!offered.includes("SendMessage")) {
        sse(res, chunk({ role: "assistant", content: "ok" }));
        return finish();
      }
      state.turns += 1;
      // What the pack actually put in front of the model. Read once, off the turn under test.
      if (state.prompt === "") {
        state.prompt = (parsed.messages ?? []).filter((m) => m?.role === "system")
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n");
        state.offered = offered;
      }
      if (state.sentWidget) {
        // A turn AFTER the widget means the widget did not end the turn, which is the whole
        // mechanism the approval rule rests on. Recorded, and answered plainly so nothing hangs.
        state.turnsAfterWidget += 1;
        sse(res, chunk({ role: "assistant", content: "already asked" }));
        return finish();
      }
      state.sentWidget = true;
      const widget = {
        type: "widget",
        widget: {
          prompt: "Northgate Plumbing, five posts for the week of 15 September. Post them?",
          helpText: "Nothing goes out until you say yes. Editing any of these needs a fresh card.",
          options: [
            { label: "Post them", value: "Yes, post the five as listed", style: "primary" },
            { label: "Hold", value: "No, hold these", style: "danger" },
          ],
        },
      };
      sse(res, chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call-widget-1", type: "function", function: { name: "SendMessage", arguments: JSON.stringify(widget) } }],
      }));
      sse(res, { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, "0.0.0.0", () => resolve(server)));
}

// ---------------------------------------------------------------- the run
let browser = null;
let page = null;
let capBefore;
let capTouched = false;
let endpointsTouched = false;
let previousEndpoint = null;
let stub = null;
let importedIds = [];

// Idempotent on purpose. Clicking the capability again when the panel is ALREADY open closes it,
// and the next step then hunts for a tile that is no longer on the page.
const marketplaceIsOpen = async () => (await page.$$("[data-marketplace-tab='bots'], [data-marketplace-bots]")).length > 0;
const openBots = async () => {
  if (!(await marketplaceIsOpen())) {
    await page.click('[data-capability="marketplace"]').catch(() => {});
    await page.waitForTimeout(1200);
  }
  const opened = (await page.$$("[data-marketplace-bots]")).length > 0
    || await page.click("#panel-dialog [data-marketplace-tab='bots']", { timeout: 4000 }).then(() => true).catch(() => false)
    || await page.locator("#panel-dialog button", { hasText: /^Bots$/ }).first().click({ timeout: 4000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(1500);
  return opened;
};
const openPack = async () => {
  if ((await page.$$(`[data-team-page="${PACK_ID}"]`)).length > 0) return;
  if ((await page.$$(`[data-bot-id="${PACK_ID}"]`)).length === 0) {
    await page.click("[data-bots-back]", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.click(`[data-bot-id="${PACK_ID}"]`, { timeout: 6000 });
  await page.waitForTimeout(900);
};
/** Import is a two-press control: the first press draws the confirmation, the second goes ahead. */
const pressImport = async () => {
  await page.click(`[data-import-bot="${PACK_ID}"]`, { timeout: 6000 });
  await page.waitForTimeout(500);
  await page.click(`[data-import-bot="${PACK_ID}"]`, { timeout: 6000 });
};
const settleImport = async (timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const done = await page.$$eval("[data-team-imported], [data-team-refusal], [data-team-failure], [data-team-removed]", (els) => els.length);
    if (done > 0) return true;
  }
  return false;
};

try {
  step("the box, and what it serves");
  const served = await gw("listMarketplace", {}).catch((error) => ({ error: error.message }));
  if (served?.error) bail(`the host would not serve a catalog: ${served.error}`);
  const pack = (served.bots ?? []).find((bot) => String(bot?.id ?? "") === PACK_ID) ?? null;
  check(pack != null, "the host serves the Marketing team pack", pack == null
    ? `bots: ${(served.bots ?? []).map((b) => b.id).join(", ")}`
    : `${(pack.members ?? []).length} members, ${(pack.skills ?? []).length} documents`);
  if (pack == null) bail("this box is running a bundle without the pack in it; build and deploy this tree's host first");
  const declaredBotCategories = (served.categories?.bots ?? []).map(String);
  const declaredPluginCategories = (served.categories?.plugins ?? []).map(String);
  check(declaredBotCategories.includes("Marketing"), "the host declares a Marketing bot category", declaredBotCategories.join(" | "));

  const startRoster = await rosterOf();
  const anchorAgent = [...startRoster.keys()][0] ?? null;
  const startLibrary = await libraryOf(anchorAgent);
  info(`this box holds ${startRoster.size} bots and ${startLibrary.size} documents before anything is imported`);
  // Both halves. Documents outlive their bot -- that is the whole reason Remove team exists -- so
  // a run that checked only the roster started against a library that already held the pack, read
  // "the library gained 0 documents" as a failure, and then reported its own leftovers as
  // somebody else's documents being deleted. Measured exactly that way on 2026-09-09.
  const leftoverBots = [...startRoster.values()].filter((name) => name.startsWith(pack.packaging.agentPrefix));
  const leftoverDocs = [...startLibrary.values()].filter((name) => name.startsWith(pack.packaging.skillPrefix));
  if (leftoverBots.length > 0 || leftoverDocs.length > 0) {
    bail(`an earlier run left this pack on the box (${leftoverBots.length} bots, ${leftoverDocs.length} documents: ${[...leftoverBots, ...leftoverDocs].join(", ")});`
      + " take the team off and run again");
  }

  step("the console, in a real browser");
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  page.on("pageerror", (error) => { console.log(`  PAGEERROR ${error.message}`); failures += 1; });
  await page.goto(`${GATEWAY}/`, { waitUntil: "load" });
  await page.waitForTimeout(3500);
  check(await openBots(), "the Marketplace opens and the Bots tab opens");
  for (let n = 0; n < 30; n += 1) {
    if ((await page.$$("[data-bot-id]")).length > 0) break;
    await page.waitForTimeout(500);
  }

  step("the chips are bot categories, not plugin ones");
  const chips = await page.$$eval("[data-bot-category]", (els) => els.map((el) => el.dataset.botCategory));
  check(chips[0] === "All" && chips.length > 1, `the chip row is drawn (${chips.join(" | ")})`);
  const strays = chips.filter((chip) => chip !== "All" && !declaredBotCategories.includes(chip));
  check(strays.length === 0, "every chip is one of the host's own BOT categories", strays.length ? `stray: ${strays.join(", ")}` : chips.join(" | "));
  // The defect itself, named: these three are PLUGIN categories and were on this row on 2026-09-09.
  const pluginOnly = declaredPluginCategories.filter((name) => !declaredBotCategories.includes(name));
  const drewPluginChips = chips.filter((chip) => pluginOnly.includes(chip));
  check(drewPluginChips.length === 0, "no plugin category is drawn on the Bots tab", drewPluginChips.join(", "));
  check(chips.includes("Marketing"), "the Marketing chip is on the row");

  step("the pack page, before anything is imported");
  await openPack();
  const memberRows = await page.$$eval("[data-team-member]", (els) => els.map((el) => ({
    id: el.dataset.teamMember,
    text: el.textContent.replace(/\s+/g, " ").trim(),
  })));
  check(memberRows.length === (pack.members ?? []).length && memberRows.length === 7,
    `the page lists all ${memberRows.length} members before you import`, memberRows.map((row) => row.id).join(", "));
  const withoutSkills = memberRows.filter((row) => !/mkt-/.test(row.text));
  check(memberRows.length > 0 && withoutSkills.length === 0, "every member row names the playbooks it brings",
    memberRows.length === 0 ? "no member rows at all, so this proved nothing" : withoutSkills.map((r) => r.id).join(", "));
  const withoutTools = memberRows.filter((row) => !/Filesystem|TinyFish|Browser Use|Notion|Resend|Exa/.test(row.text));
  check(memberRows.length > 0 && withoutTools.length === 0, "and the tools it needs", withoutTools.map((r) => r.id).join(", "));

  // The first-run page: what the operator has to provide, read before the button.
  await page.click('[data-bot-tab="firstrun"]', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);
  const firstRunText = await page.$eval("[data-bot-page] .plugin-detail", (el) => el.textContent.replace(/\s+/g, " ")).catch(() => "");
  for (const needle of ["TINYFISH_API_KEY", "BROWSER_USE_API_KEY", "LinkedIn Page", "Business Manager"]) {
    check(firstRunText.includes(needle), `the first-run page names ${needle}`);
  }
  await page.click('[data-bot-tab="members"]', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);

  step("a person can hit the Import control");
  const target = await page.$eval(`[data-import-bot="${PACK_ID}"]`, (el) => {
    const rect = el.getBoundingClientRect();
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return {
      w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top),
      disabled: el.disabled === true, label: el.textContent.trim(),
      visible: style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.1,
    };
  }).catch(() => null);
  check(target != null && target.visible && !target.disabled && target.w >= 90 && target.h >= 28,
    "Import is a visible, enabled, human-sized rectangle", target == null ? "no button at all" : `${target.w}x${target.h}px, "${target.label}"`);
  const inView = target != null && target.top >= 0 && target.top < 2000;
  check(inView, "and it is on the page rather than below it", target == null ? "" : `top ${target.top}px`);

  step("the import, diffed rather than counted");
  const beforeRoster = await rosterOf();
  const beforeLibrary = await libraryOf(anchorAgent);
  await pressImport();
  check(await settleImport(), "the import finished and reported on screen");
  const afterRoster = await rosterOf();
  const afterLibrary = await libraryOf(anchorAgent);
  const newAgents = added(beforeRoster, afterRoster);
  const newSkills = added(beforeLibrary, afterLibrary);
  importedIds = newAgents.map(([id]) => id);
  const wantedNames = (pack.members ?? []).map((member) => `${pack.packaging.agentPrefix}${member.role}`);
  check(newAgents.length === 7, `the roster gained exactly the pack's ${wantedNames.length} members`,
    `${newAgents.length}: ${newAgents.map(([, name]) => name).join(", ")}`);
  const missingNames = wantedNames.filter((name) => !newAgents.some(([, got]) => got === name));
  check(missingNames.length === 0, "each one under the name the row declares", missingNames.join(", "));
  check(lost(beforeRoster, afterRoster).length === 0, "and nothing else left the roster",
    lost(beforeRoster, afterRoster).map(([, name]) => name).join(", "));

  const wantedSkills = (pack.skills ?? []).map((skill) => String(skill.name));
  check(afterLibrary.size > 0, "the shared library is readable after the import", `${afterLibrary.size} rows`);
  check(newSkills.length === wantedSkills.length, `the library gained exactly the pack's ${wantedSkills.length} documents`,
    `${newSkills.length}: ${newSkills.map(([, name]) => name).join(", ")}`);
  const unnamespaced = newSkills.filter(([, name]) => !name.startsWith(pack.packaging.skillPrefix));
  check(unnamespaced.length === 0, "and every one of them is namespaced", unnamespaced.map(([, name]) => name).join(", "));
  check(lost(beforeLibrary, afterLibrary).length === 0, "and nothing else left the library",
    lost(beforeLibrary, afterLibrary).map(([, name]) => name).join(", "));

  // Their tools: the persona each one actually carries, read back off the box.
  const personas = await Promise.all(newAgents.map(async ([id, name]) => {
    const rows = await gw("listAgents", {}).catch(() => []);
    const row = (Array.isArray(rows) ? rows : []).find((agent) => String(agent.id) === id) ?? {};
    return { id, name, description: String(row.description ?? "") };
  }));
  const withoutRule = personas.filter((row) => !row.description.includes("until the operator answers a decision card"));
  check(withoutRule.length === 0, "every imported bot carries the approval rule in its own persona",
    withoutRule.map((row) => row.name).join(", "));
  let coordinatorId = newAgents.find(([, name]) => /Coordinator$/.test(name))?.[0] ?? null;
  check(coordinatorId != null, "the coordinator is on the roster");
  const coordinatorLibrary = await libraryOf(coordinatorId);
  const packRows = [...coordinatorLibrary.values()].filter((name) => name.startsWith(pack.packaging.skillPrefix));
  check(packRows.includes("mkt-approval-rule") && packRows.includes("mkt-brand-northgate"),
    "the coordinator can reach the approval rule and the fixture brand profile", packRows.join(", "));

  step("a second import leaves no doubles");
  const beforeSecond = { roster: await rosterOf(), library: await libraryOf(anchorAgent) };
  await page.click("[data-bots-back]", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  await openPack();
  await pressImport();
  check(await settleImport(), "the second import finished and reported on screen");
  const afterSecond = { roster: await rosterOf(), library: await libraryOf(anchorAgent) };
  const doubledAgents = added(beforeSecond.roster, afterSecond.roster);
  const doubledSkills = added(beforeSecond.library, afterSecond.library);
  check(doubledAgents.length === 0, "no second set of bots", doubledAgents.map(([, name]) => name).join(", "));
  check(doubledSkills.length === 0, "no second set of documents", doubledSkills.map(([, name]) => name).join(", "));
  const copies = [...afterSecond.roster.values()].filter((name) => / copy$/.test(name) && name.startsWith(pack.packaging.agentPrefix));
  check(copies.length === 0, "and nothing called “copy”", copies.join(", "));

  step("the cap refuses, and creates nothing");
  capBefore = await readSetting(MAX_AGENTS_SETTING);
  const rosterNow = await rosterOf();
  // Below the roster itself, so the refusal is unambiguous however many bots the box holds.
  await writeSetting(MAX_AGENTS_SETTING, String(Math.max(1, rosterNow.size - 3)));
  capTouched = true;
  const capacity = await gw("getAgentCapacity", {}).catch(() => null);
  check(Number(capacity?.maxAgents) === Math.max(1, rosterNow.size - 3),
    "the box took the lower limit on a running host", `maxAgents ${capacity?.maxAgents}, remaining ${capacity?.remaining}`);
  // A refusal is only meaningful when the pack is NOT already here, so the team comes off first.
  const removedForCap = await page.evaluate(async (id) => {
    const bots = window.__marketplaceBots;
    const bot = (await (await fetch("/api/listMarketplace", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).bots.find((b) => b.id === id);
    const gateway = { call: async (m, a) => {
      const res = await fetch(`/api/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a ?? {}) });
      const body = await res.text();
      try { return JSON.parse(body); } catch { return body; }
    } };
    return bots.removeMarketingTeam(gateway, bot);
  }, PACK_ID);
  info(`the team came off for the cap leg: ${removedForCap.agents} bots, ${removedForCap.skills} documents`);
  const beforeRefusal = { roster: await rosterOf(), library: await libraryOf(anchorAgent) };
  await page.click("[data-bots-back]", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__marketplaceBots.reload());
  await page.waitForTimeout(1200);
  await openPack();
  await pressImport();
  check(await settleImport(30_000), "the refused import reported on screen");
  const refusal = await page.$eval("[data-team-refusal]", (el) => el.textContent.trim()).catch(() => "");
  check(refusal.length > 0, "the page says why in one sentence", refusal);
  check(/\bnothing was created\b/.test(refusal) && /\bremove\b/.test(refusal), "and it says what to do about it");
  check(!/getAgentCapacity|createAgent|maxAgents|\b4\d\d\b|\b5\d\d\b/.test(refusal), "in plain words, with no command name and no status code");
  const afterRefusal = { roster: await rosterOf(), library: await libraryOf(anchorAgent) };
  check(added(beforeRefusal.roster, afterRefusal.roster).length === 0, "the refusal created no bot",
    added(beforeRefusal.roster, afterRefusal.roster).map(([, name]) => name).join(", "));
  check(added(beforeRefusal.library, afterRefusal.library).length === 0, "and imported no document",
    added(beforeRefusal.library, afterRefusal.library).map(([, name]) => name).join(", "));

  await writeSetting(MAX_AGENTS_SETTING, capBefore ?? null);
  capTouched = false;
  info(`the limit is back to ${capBefore ?? "the box's default"}`);

  // Put the team back for the remaining legs.
  await page.click("[data-bots-back]", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  await openPack();
  await pressImport();
  await settleImport();
  const rebuilt = await rosterOf();
  importedIds = [...rebuilt.entries()].filter(([, name]) => name.startsWith(pack.packaging.agentPrefix)).map(([id]) => id);
  // Re-derived: the cap leg took the team off and put it back, so every id from the first import
  // now names a bot that does not exist.
  coordinatorId = [...rebuilt.entries()].find(([, name]) => /Coordinator$/.test(name))?.[0] ?? null;
  check(importedIds.length === 7 && coordinatorId != null, "the team is back on the box for the approval leg", String(importedIds.length));

  step("the approval card ends the turn");
  if (NO_MODEL) {
    skip("the coordinator stops at the approval card", "--no-model was passed, so the endpoint was not repinned");
  } else {
    const state = { turns: 0, turnsAfterWidget: 0, sentWidget: false, prompt: "", offered: [] };
    stub = await startStub(STUB_PORT, state);
    const reachable = (await sh(`curl -s -m 5 -o /dev/null -w '%{http_code}' http://host.docker.internal:${STUB_PORT}/v1/models`)).trim();
    check(reachable === "200", "the box reaches the stub model on this Mac", `host.docker.internal:${STUB_PORT} -> ${reachable || "no answer"}`);
    if (reachable !== "200") {
      skip("the coordinator stops at the approval card", "the box cannot reach this Mac");
    } else {
      const endpointsBefore = await relay("/endpoints");
      if (endpointsBefore.live?.model === STUB_MODEL) {
        bail("the box is still pointed at a gate stub from a run that did not finish; pin it back to a real endpoint first");
      }
      previousEndpoint = (endpointsBefore.endpoints ?? [])
        .find((e) => e.baseUrl === endpointsBefore.live?.baseUrl && e.model === endpointsBefore.live?.model)?.id ?? null;
      if (previousEndpoint == null) {
        skip("the coordinator stops at the approval card", "the live endpoint could not be identified, so it will not be repinned blindly");
      } else {
        const kept = (endpointsBefore.endpoints ?? []).filter((e) => e.id !== STUB_ID).map(({ health, ...row }) => ({ ...row, apiKey: "set" }));
        await relay("/endpoints", { endpoints: [...kept, { id: STUB_ID, name: "marketing gate stub", baseUrl: `http://host.docker.internal:${STUB_PORT}/v1`, model: STUB_MODEL, apiKey: "" }] });
        endpointsTouched = true;
        await relay("/endpoints/use", { id: STUB_ID });
        info(`the box is answering through the stub; it was on ${previousEndpoint}`);

        await gw("sendPrompt", {
          agentId: coordinatorId,
          prompt: "Draft next week for Northgate Plumbing from its brand profile and show me the batch before anything goes out.",
        });
        const deadline = Date.now() + 100_000;
        while (Date.now() < deadline) {
          await sleep(3000);
          if (state.sentWidget) break;
        }
        check(state.sentWidget, `the coordinator's turn reached the model (${state.turns} request(s))`);
        // What the pack put in front of it. This is the half the pack controls; the stub writes
        // the posts, so nothing here claims a model drafts a good week.
        check(/until the operator answers a decision card/.test(state.prompt),
          "the approval rule is in the coordinator's own prompt");
        check(state.offered.includes("SendMessage"), "and SendMessage is offered, which is what raises the card");

        // The mechanism the rule rests on: a widget ENDS the turn, and the bot waits.
        //
        // Measured, not counted. Counting further completions was the first attempt and it is not
        // attributable: the box asks the same endpoint for a conversation title with the same
        // toolset offered, so one extra request after the widget says nothing about whether the
        // TURN ended. What does say it is the bot's own running state, and the console's own words
        // on the card.
        await sleep(8000);
        const stillRunning = (await gw("listAgents", {}).catch(() => []))
          .find((agent) => String(agent.id) === coordinatorId)?.isRunning === true;
        check(!stillRunning, "the bot stopped and is waiting on the answer rather than carrying on");
        info(`the stub answered ${state.turns} request(s) for this bot, ${state.turnsAfterWidget} of them after the card`);

        await page.click("[data-panel-close], [data-close-panel]").catch(() => {});
        await page.evaluate((id) => {
          const adapter = window.__machineRoomAdapter;
          if (adapter && typeof adapter.selectContext === "function") adapter.selectContext({ kind: "worker", id });
        }, coordinatorId);
        // Polled, not slept: the conversation is fetched when the context changes, and a fixed
        // wait either flakes or wastes the run's budget.
        let card = { buttons: [], text: "" };
        for (let n = 0; n < 20; n += 1) {
          await page.waitForTimeout(1000);
          card = await page.evaluate(() => {
            const buttons = [...document.querySelectorAll("[data-decide]")];
            const host = buttons[0]?.closest(".inline-card") ?? null;
            return { buttons: buttons.map((b) => b.textContent.trim()), text: host ? host.textContent.replace(/\s+/g, " ").trim() : "" };
          });
          if (card.buttons.length > 0) break;
        }
        check(card.buttons.length >= 2, "the decision card is on screen with its options", card.buttons.join(" | "));
        check(/Northgate/.test(card.text), "and it names the client and the batch", oneLine(card.text));
        check(/blocked until you answer/i.test(card.text),
          "and the console says the bot is blocked until it is answered", oneLine(card.text));
        check(!/\bposted\b|\bpublished\b/i.test(card.text),
          "and nothing on it says anything went out", oneLine(card.text));
      }
    }
  }

  step("Remove team puts the box back");
  if (KEEP) {
    skip("Remove team", "--keep was passed, so the team is left on the box");
  } else {
    await openBots();
    await openPack();
    const removeTarget = await page.$(`[data-remove-team="${PACK_ID}"]`);
    if (removeTarget == null) {
      // The control lives on the imported card, which is only drawn after an import in THIS page
      // session. The page was reloaded by the model leg above, so drive the same function the
      // button drives rather than pretending the button was not there.
      const removed = await page.evaluate(async (id) => {
        const bots = window.__marketplaceBots;
        const bot = (await (await fetch("/api/listMarketplace", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).bots.find((b) => b.id === id);
        const gateway = { call: async (m, a) => {
      const res = await fetch(`/api/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a ?? {}) });
      const body = await res.text();
      try { return JSON.parse(body); } catch { return body; }
    } };
        return bots.removeMarketingTeam(gateway, bot);
      }, PACK_ID);
      info(`Remove team ran through its own function: ${removed.agents} bots, ${removed.skills} documents`);
    } else {
      await removeTarget.click();
      await page.waitForTimeout(1000);
      for (let n = 0; n < 30; n += 1) {
        if ((await page.$$("[data-team-removed]")).length > 0) break;
        await page.waitForTimeout(1000);
      }
      const said = await page.$eval("[data-team-removed]", (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
      check(said.length > 0, "the page says what came back", said);
    }
    const endRoster = await rosterOf();
    const endLibrary = await libraryOf(anchorAgent);
    const stillThere = [...endRoster.values()].filter((name) => name.startsWith(pack.packaging.agentPrefix));
    const skillsLeft = [...endLibrary.values()].filter((name) => name.startsWith(pack.packaging.skillPrefix));
    check(stillThere.length === 0, "no bot of the pack's is left on the roster", stillThere.join(", "));
    check(skillsLeft.length === 0, "and no document of the pack's is left in the library", skillsLeft.join(", "));
    const strayAgents = added(startRoster, endRoster);
    const straySkills = added(startLibrary, endLibrary);
    check(strayAgents.length === 0, "the roster is exactly as this run found it", strayAgents.map(([, name]) => name).join(", "));
    check(straySkills.length === 0, "and so is the shared library", straySkills.map(([, name]) => name).join(", "));
    check(lost(startRoster, endRoster).length === 0, "with nothing of anyone else's removed",
      lost(startRoster, endRoster).map(([, name]) => name).join(", "));
    check(lost(startLibrary, endLibrary).length === 0, "and nobody else's documents removed",
      lost(startLibrary, endLibrary).map(([, name]) => name).join(", "));
    importedIds = [];
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
  // Everything this gate moved goes back, whatever happened above.
  if (endpointsTouched && previousEndpoint != null) {
    await relay("/endpoints/use", { id: previousEndpoint }).catch(() => {});
    const kept = ((await relay("/endpoints").catch(() => ({}))).endpoints ?? [])
      .filter((e) => e.id !== STUB_ID).map(({ health, ...row }) => ({ ...row, apiKey: "set" }));
    if (kept.length > 0) await relay("/endpoints", { endpoints: kept }).catch(() => {});
    console.log(`  restored the model endpoint to ${previousEndpoint}`);
  }
  if (capTouched) {
    await writeSetting(MAX_AGENTS_SETTING, capBefore ?? null).catch(() => {});
    console.log(`  restored ${MAX_AGENTS_SETTING} to ${capBefore ?? "the box's default"}`);
  }
  if (!KEEP && importedIds.length > 0) {
    // Documents FIRST, while a bot that can be asked through is still alive, and both halves --
    // deleting the bots alone is precisely the defect Remove team exists for, and doing it here
    // left the next run of this gate starting against a dirty library.
    let docs = 0;
    for (const agentId of importedIds) {
      const rows = await gw("getAgentWorkflows", { id: agentId }).catch(() => []);
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!String(row?.name ?? "").startsWith("mkt-")) continue;
        if (await gw("deleteAgentWorkflow", { id: agentId, workflowId: String(row.id) }).then(() => true).catch(() => false)) docs += 1;
      }
    }
    for (const id of importedIds) await gw("deleteAgent", { id }).catch(() => {});
    console.log(`  removed ${importedIds.length} bot(s) and ${docs} document(s) this run created`);
  }
  if (stub != null) stub.close();
  if (browser != null) await browser.close().catch(() => {});
}

// A run that measured nothing is not a pass. The first version of this line exited 0 whenever no
// leg had actually failed, so the run that stopped on a dirty box -- having asserted three things
// and skipped everything after -- printed PASS. That is the vacuous green this gate exists to
// refuse, and it read as one on the way past.
const verdict = failures > 0 ? "FAIL" : unmeasured > 0 ? "INCOMPLETE" : "PASS";
console.log(`\n${verdict}  ${failures} failure(s)${unmeasured ? `, ${unmeasured} leg(s) not measured` : ""}`);
process.exit(failures > 0 ? 1 : unmeasured > 0 ? 2 : 0);
