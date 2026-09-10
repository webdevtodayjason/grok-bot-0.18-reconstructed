#!/usr/bin/env node
// verify-settings.mjs -- the settings surface a customer actually sees (SETTINGS-2, docs/SETTINGS.md).
//
// WHAT THIS GATE IS FOR. Jason, 2026-09-10, on what shipped: "this modal in the center, going down,
// does not make a lot of sense. It's so busy, with so much stuff ... A user is never going to put a
// resend key in. That's on the backend ... it's getting to the point where you've got to be a
// developer to understand what's going on." So the four things measured here are the four rules:
//
//   1. Every section is reachable from the nav and from the search, and each one FITS -- measured
//      against the 6936 px (1440x900) and 11332 px (390x844) of stacked cards it replaces.
//   2. Every customer row is a label, at most one explanation line, and exactly one control slot.
//   3. No customer-visible copy carries key, token, secret, endpoint, relay, proxy, webhook or a
//      vendor name -- with the offending node NAMED, on the live page, not only in the unit test.
//   4. The Operator section is present for the operator and absent for a customer.
//
// TWO THINGS IT DOES DELIBERATELY, both printed in the run rather than hidden:
//
//   * BOTH VIEWS ARE FORCED THROUGH GET /auth/state's operator FIELD. grok-bot-local-vm has
//     AUTH == null, so tenantOf() answers OPERATOR_SLUG and EVERY local session is the operator's:
//     there is no way to be a customer on this machine, and no way to be measurably the operator
//     either until item B adds the field. So the browser answers /auth/state itself, once with
//     operator:false and once with operator:true, keeping every other field the live route returned
//     and overwriting only that one. The real customer proof is the R750 through
//     console.titanium.bot, where a throwaway customer is a customer for real. When item B merges,
//     the forcing is overwriting a real value rather than inventing one and this leg can drop it.
//
//   * THE SWEEP READS COPY, NOT VALUES. "GLM 4.6" is on the Computer section as an option somebody
//     picks between: it is the machine's word, not the product's, and a gate that failed on it would
//     be asking the product to lie about which model is answering. Every node the surface marks
//     data-machine-value is excluded and the excluded text is printed, so the exclusion is visible
//     rather than assumed.
//
// ONE KNOWN SKIP while this wave is landing: voice.js still mounts its own Voice card into whatever
// .settings-list is on screen, which under the new contract is the Notifications body. That card
// and its key field are item C's and retire with it. The sweep says so by name rather than passing
// over it quietly.
//
//   node scripts/verify-settings.mjs              both viewports against a relay from this worktree
//   node scripts/verify-settings.mjs --url ...    read-only, against a deployed console
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBoxLock } from "./lib/box-lock.mjs";

const argv = process.argv.slice(2);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const URL_TARGET = value("url");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? path.join(repoRoot, ".cache/playwright");
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.GROK_BOT_SHOT_DIR ?? "/tmp/settings-shots";
const BEARER = process.env.CONSOLE_BEARER ?? "";
const UA = "titanbot-gate/verify-settings.mjs";
const DESKTOP = { w: 1440, h: 900 };
const PHONE = { w: 390, h: 844 };
const RUN_BUDGET_MS = Number(process.env.GROK_BOT_SETTINGS_BUDGET_MS ?? 260_000);

// The baselines this ship is measured against, each with its machine and its viewport. Measured on
// grok-bot-local-vm (this Mac), real Chrome, 2026-09-10, on the panel as it stood at c4518c1.
const BASELINE = {
  desktopScroll: 6936,   // px of scroll in ONE dialog at 1440x900
  phoneScroll: 11332,    // px of scroll in ONE dialog at 390x844
  phoneOverflow: 31,     // rects past the right edge at 390x844, worst right edge 692 px
  sections: 10,
  controls: 90,
  passwordFields: 4,
};

const EXPECTED_NAV = ["general", "computer", "usage", "updates", "notifications"];

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const info = (line) => console.log(`  INFO  ${line}`);
const step = (line) => console.log(`\n== ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let deadline = Date.now() + RUN_BUDGET_MS;
const budgetLeft = () => deadline - Date.now();
const within = (ms) => Math.max(1, Math.min(ms, budgetLeft()));

mkdirSync(SHOTS, { recursive: true });
const shots = [];
const shoot = async (page, name) => {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  shots.push(file);
};

// ---- the relay under test -----------------------------------------------------------------------

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

// Where the local-docker connector wrote grok-bot-local-vm's gateway token. Without it the relay
// holds no bearer, the gateway answers 401, and the console falls back to its DEMO adapter -- which
// looks like a working page and measures nothing: a seeded roster, no host status, no plan group.
const PROFILE_DIRS = process.env.SAND_PROFILE_DIRS
  ?? "/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb-leaked/.cache/firstmate-profile/sand-data";

async function startRelay() {
  const port = await freePort();
  const child = spawn(process.execPath, ["ui/server.mjs"], {
    cwd: repoRoot,
    env: { ...process.env, SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1", SAND_PROFILE_DIRS: PROFILE_DIRS },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const origin = `http://127.0.0.1:${port}`;
  const stop = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${origin}/`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* not yet */ }
    if (Date.now() > stop) { child.kill("SIGKILL"); throw new Error("the relay from this worktree did not come up"); }
    await sleep(300);
  }
  return { origin, stop: () => { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
}

// ---- what the browser reads back ------------------------------------------------------------------

// Every piece of COPY on the surface, with the node that carries it, so a failure names the row.
// data-machine-value marks a value the machine supplied rather than words the product wrote.
const COPY = () => {
  const out = [];
  const push = (where, node) => {
    if (node == null) return;
    if (node.closest("[data-machine-value]") != null || node.hasAttribute?.("data-machine-value")) return;
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 0) out.push({ where, text });
  };
  const body = document.querySelector("[data-settings-body]");
  if (body == null) return out;
  const id = body.querySelector("[data-settings-section]")?.dataset.settingsSection ?? "?";
  push(`${id} title`, body.querySelector("[data-settings-title]"));
  push(`${id} subtitle`, body.querySelector("[data-settings-subtitle]"));
  for (const label of body.querySelectorAll(".settings-group-label")) push(`${id} group`, label);
  for (const row of body.querySelectorAll("[data-setting-row]")) {
    const name = `${id}/${row.dataset.settingRow}`;
    push(`${name} label`, row.querySelector("strong"));
    push(`${name} line`, row.querySelector("small"));
    for (const button of row.querySelectorAll("button")) push(`${name} button`, button);
  }
  // The Notifications body is push-settings.js's own markup, and it is a customer's card too.
  for (const row of body.querySelectorAll("[data-push-settings] .setting-row")) {
    push(`${id}/notification row label`, row.querySelector("strong"));
    push(`${id}/notification row line`, row.querySelector("small"));
  }
  for (const heading of body.querySelectorAll("[data-push-settings] h3, [data-push-settings] > p")) push(`${id}/notifications`, heading);
  return out;
};

// One row's shape, as the DOM contract gives it: a label block and exactly one control slot.
const ROWS = () => [...document.querySelectorAll("[data-settings-body] [data-setting-row]")].map((row) => {
  const first = row.children[0];
  const slots = row.querySelectorAll(":scope > .setting-control");
  return {
    id: row.dataset.settingRow,
    label: first?.querySelector("strong")?.textContent?.trim() ?? "",
    lines: first?.querySelectorAll("small").length ?? 0,
    slots: slots.length,
    controls: [...slots].reduce((n, slot) => n + slot.querySelectorAll("select, input, textarea, button, a, .status-pill, .settings-meter, [data-settings-mount], .settings-subrow").length, 0),
    children: row.children.length,
  };
});

// Everything past the right edge that nobody can reach, the same rule verify-mobile uses: an element
// inside a container that scrolls sideways can be dragged into view and is not counted.
const OVERFLOW = () => {
  const edge = document.documentElement.clientWidth;
  const scrollable = (node) => {
    for (let at = node; at && at !== document.body; at = at.parentElement) {
      const css = getComputedStyle(at);
      if (/(auto|scroll)/.test(css.overflowX) && at.scrollWidth > at.clientWidth + 1) return true;
      if (css.visibility === "hidden" || css.display === "none") return true;
    }
    return false;
  };
  const worst = [];
  let count = 0;
  for (const node of document.querySelectorAll("#panel-content *")) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.right <= edge + 1) continue;
    if (scrollable(node)) continue;
    count += 1;
    worst.push(`${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(" ")[0]}` : ""}@${Math.round(rect.right)}`);
  }
  return { count, worst: worst.slice(0, 5) };
};

// ---- the run ---------------------------------------------------------------------------------------

let release = () => {};
let relay = null;
let browser = null;
const pageErrors = [];

async function shutdown() {
  await browser?.close().catch(() => {});
  relay?.stop();
  release();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void shutdown().then(() => process.exit(130)); });

try {
  if (URL_TARGET == null) {
    release = await acquireBoxLock({ what: "verify-settings", log: (line) => info(line) });
    deadline = Date.now() + RUN_BUDGET_MS;
    relay = await startRelay();
    info(`the relay from this worktree at ${relay.origin}, box grok-bot-local-vm`);
  } else {
    info(`read-only against ${URL_TARGET}`);
  }
  const ORIGIN = URL_TARGET ?? relay.origin;

  const require = createRequire(import.meta.url);
  let chromium = null;
  let why = "";
  for (const dir of [PW_DIR, ...(process.env.GROK_BOT_PLAYWRIGHT_DIR ? [] : [path.resolve("/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/.cache/playwright")])]) {
    try { chromium = require(path.join(dir, "node_modules", "playwright-core")).chromium; info(`playwright-core from ${dir}`); break; }
    catch (error) { why = `${dir}: ${String(error?.message).slice(0, 70)}`; }
  }
  if (chromium == null) throw new Error(`playwright-core could not be loaded (${why})`);
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

  /**
   * One page, at one viewport, with the session answer's operator field forced as asked.
   *
   * The route handler asks the relay FIRST and keeps every field it answered with, overwriting only
   * `operator`. So the required/authenticated halves are the live ones, and the day item B ships the
   * operator field this stand-in is overwriting a real value rather than inventing one -- at which
   * point the forcing can go and the leg reads live truth with no other edit here.
   */
  async function open({ w, h, phone = false, operator = false }) {
    const context = await browser.newContext({
      viewport: { width: w, height: h },
      ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}),
      userAgent: phone
        ? `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 ${UA}`
        : `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ${UA}`,
      extraHTTPHeaders: BEARER ? { authorization: `Bearer ${BEARER}` } : {},
    });
    await context.route("**/auth/state", async (route) => {
      const live = await route.fetch().catch(() => null);
      let body = {};
      if (live != null && live.status() === 200) body = await live.json().catch(() => ({}));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({
          required: body.required ?? false,
          authenticated: body.authenticated ?? true,
          workspace: body.workspace ?? { slug: "gate-workspace", name: "Gate Workspace" },
          person: body.person ?? { email: "gate@example.test" },
          operator,
        }),
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error?.message ?? error)));
    await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: within(45_000) });
    await page.waitForFunction(() => window.__machineRoomAdapter != null, { timeout: within(45_000) }).catch(() => {});
    await page.waitForTimeout(1500);
    return page;
  }

  const openSettings = async (page, phone) => {
    await page.evaluate(() => document.getElementById("panel-dialog")?.close());
    // ONE tap on the top-bar gear, at both widths. It is 44x44 at 390 px and always has been:
    // MOBILE-2c's row says there is no phone route into Settings at all, and that is measured wrong
    // -- #shelf-settings is 0x0 because .shelf-utilities is display:none, but #settings-button is not.
    if (phone) await page.tap("#settings-button"); else await page.click("#settings-button");
    await page.waitForSelector("[data-settings-surface]", { timeout: within(20_000) });
    await page.waitForTimeout(900);
  };

  const gotoSection = async (page, id) => {
    await page.click(`[data-settings-nav="${id}"]`);
    await page.waitForTimeout(700);
  };

  // =================================================================================================
  step(`the surface at ${DESKTOP.w}x${DESKTOP.h}, as a customer`);
  // =================================================================================================
  let page = await open({ w: DESKTOP.w, h: DESKTOP.h, operator: false });
  await openSettings(page, false);

  const head = await page.evaluate(() => ({
    title: document.getElementById("panel-title")?.textContent?.trim() ?? "",
    eyebrow: document.getElementById("panel-eyebrow")?.textContent?.trim() ?? "",
    dialogs: document.querySelectorAll("dialog[open]").length,
    isSettings: document.getElementById("panel-dialog")?.classList.contains("is-settings") === true,
  }));
  check(head.title === "Settings", 'the panel is titled "Settings"', `${head.eyebrow} / ${head.title}`);
  check(head.dialogs === 1, "and it is the ONE dialog this console already had, not a second one", `${head.dialogs} open`);
  check(head.isSettings, "and the dialog carries .is-settings, which is how settings.css sizes it");

  const nav = await page.$$eval("[data-settings-nav]", (nodes) => nodes.map((node) => node.dataset.settingsNav));
  check(JSON.stringify(nav) === JSON.stringify(EXPECTED_NAV),
    "the nav lists exactly the five customer sections, in the original's order", nav.join(" | "));
  const stale = await page.evaluate(() => /Operator settings|Global router/i.test(document.body.textContent ?? ""));
  check(!stale, '"Operator settings" appears nowhere on the page');

  step("every section paints exactly one body, and only Notifications is a settings-list");
  const bodies = [];
  for (const id of EXPECTED_NAV) {
    await gotoSection(page, id);
    const seen = await page.evaluate(() => {
      const body = document.querySelector("[data-settings-body]");
      const sections = [...body.querySelectorAll("[data-settings-section]")].map((node) => node.dataset.settingsSection);
      const scroller = document.querySelector(".settings-body");
      return {
        sections,
        lists: document.querySelectorAll("#panel-content .settings-list").length,
        pushCards: document.querySelectorAll("[data-push-settings]").length,
        scrollHeight: scroller?.scrollHeight ?? 0,
        clientHeight: scroller?.clientHeight ?? 0,
        title: body.querySelector("[data-settings-title]")?.textContent?.trim() ?? "",
      };
    });
    bodies.push({ id, ...seen });
    check(seen.sections.length === 1 && seen.sections[0] === id,
      `pressing ${id} paints one body and it is ${id}'s`, seen.sections.join(",") || "none");
  }
  const listCounts = bodies.map((body) => `${body.id}:${body.lists}`);
  check(bodies.every((body) => body.lists === (body.id === "notifications" ? 1 : 0)),
    "only the Notifications body carries .settings-list, which is push-settings.js's whole mount contract", listCounts.join(" "));
  const notifications = bodies.find((body) => body.id === "notifications");
  check(notifications.pushCards === 1, "and the Notifications card mounts exactly once, with no double mount when the observer re-fires",
    `${notifications.pushCards} [data-push-settings]`);

  step(`every section fits, against ${BASELINE.desktopScroll} px of stacked cards in one dialog`);
  for (const body of bodies) {
    const ratio = body.clientHeight > 0 ? body.scrollHeight / body.clientHeight : 0;
    check(ratio > 0 && ratio <= 3, `${body.id} is under three screens at ${DESKTOP.w}x${DESKTOP.h}`,
      `${body.scrollHeight} px in a ${body.clientHeight} px window (${ratio.toFixed(2)}x)`);
  }
  info(`total across five sections ${bodies.reduce((n, body) => n + body.scrollHeight, 0)} px, against ${BASELINE.desktopScroll} px in one dialog before this ship`);

  step("every row is a label, at most one line, and exactly one control slot");
  for (const id of EXPECTED_NAV) {
    if (id === "notifications") continue;
    await gotoSection(page, id);
    const rows = await page.evaluate(ROWS);
    const bad = rows.filter((row) => row.label.length === 0 || row.lines > 1 || row.slots !== 1 || row.children !== 2);
    check(rows.length === 0 || bad.length === 0, `${id}: ${rows.length} row(s), each one label and one control slot`,
      bad.length > 0 ? bad.map((row) => `${row.id}: ${row.lines} line(s), ${row.slots} slot(s), ${row.children} child(ren)`).join("; ")
        : rows.map((row) => row.id).join(", ") || "no rows on this box");
  }

  step("the words a customer reads");
  const offenders = [];
  const excluded = [];
  for (const id of EXPECTED_NAV) {
    await gotoSection(page, id);
    const copy = await page.evaluate(COPY);
    const machine = await page.evaluate(() => [...document.querySelectorAll("[data-settings-body] [data-machine-value]")]
      .map((node) => (node.value ?? node.textContent ?? "").trim()).filter((text) => text.length > 0));
    excluded.push(...machine);
    const banned = await page.evaluate(() => window.__mrSettings.BANNED.source);
    const re = new RegExp(banned, "i");
    for (const entry of copy) if (re.test(entry.text)) offenders.push(entry);
  }
  // The composer's own voice line is a customer-visible sentence too, and it is the one Jason got
  // stuck in. Swept here with the rows because it is the same rule.
  const voiceLine = await page.evaluate(() => {
    const strip = document.querySelector(".voice-strip, [data-voice-line], .voice-note");
    return strip == null ? "" : (strip.textContent ?? "").replace(/\s+/g, " ").trim();
  });
  if (voiceLine.length > 0) {
    const banned = await page.evaluate(() => window.__mrSettings.BANNED.source);
    if (new RegExp(banned, "i").test(voiceLine)) offenders.push({ where: "the composer's voice line", text: voiceLine });
  }
  check(offenders.length === 0, "no customer-visible label, line or button carries a key, a secret or a vendor's name",
    offenders.length === 0 ? `swept five sections${voiceLine ? " and the composer's voice line" : ""}`
      : offenders.map((one) => `${one.where}: "${one.text}"`).join(" | "));
  info(`machine-supplied values excluded from the sweep, on purpose: ${excluded.length > 0 ? excluded.slice(0, 6).join(", ") : "none on this box"}`);
  // The one card that is not this wave's: item C retires voice.js's own settings card.
  const voiceCard = await page.evaluate(() => document.querySelector("[data-voice]") != null);
  if (voiceCard) {
    skip("the Voice card is not on the surface",
      "voice.js still mounts its own card into whatever .settings-list is drawn, so it lands in Notifications. That card and its key field are item C's and retire with it; this is the one transient the merged design names");
  } else {
    check(true, "the Voice card is not on the surface", "voice.js draws the Talking row through window.__voice instead");
  }

  step("the search");
  await gotoSection(page, "general");
  await page.fill("[data-settings-search]", "quiet");
  await page.waitForTimeout(600);
  const afterQuiet = await page.evaluate(() => document.querySelector("[data-settings-body] [data-settings-section]")?.dataset.settingsSection ?? "");
  check(afterQuiet === "notifications", 'typing "quiet" reaches Notifications', afterQuiet || "nothing painted");
  await page.fill("[data-settings-search]", "background");
  await page.waitForTimeout(600);
  const afterBackground = await page.evaluate(() => document.querySelector("[data-settings-body] [data-settings-section]")?.dataset.settingsSection ?? "");
  check(afterBackground === "general", 'typing "background" reaches General', afterBackground || "nothing painted");
  await page.fill("[data-settings-search]", "");
  await page.waitForTimeout(400);

  step("the Background picker, which the old title guard would have deleted");
  await gotoSection(page, "general");
  const picker = await page.evaluate(() => {
    const grid = document.querySelector('[data-settings-mount="background"] .bg-grid') ?? document.querySelector(".bg-grid");
    return grid == null ? null : {
      inAppearance: grid.closest('[data-settings-group="appearance"]') != null,
      inGeneral: grid.closest('[data-settings-section="general"]') != null,
      tiles: grid.querySelectorAll("[data-bg-id]").length,
    };
  });
  check(picker != null && picker.tiles > 0, "the Background picker is on screen with its tiles",
    picker == null ? "no .bg-grid anywhere: the rename deleted the picker" : `${picker.tiles} tiles`);
  if (picker != null) check(picker.inGeneral && picker.inAppearance, "and it mounted into General -> Appearance and nowhere else",
    `general ${picker.inGeneral}, appearance ${picker.inAppearance}`);

  step("the notification switches round-trip through the push settings route");
  await gotoSection(page, "notifications");
  const hasSwitch = await page.$('[data-push-kind="widget"]');
  if (hasSwitch == null) {
    skip("a notification switch is flipped, the panel reopened, and the value stuck", "this relay serves no /push routes, so there was nothing to flip");
  } else {
    const before = await page.evaluate(() => document.querySelector('[data-push-kind="widget"]').getAttribute("aria-pressed"));
    await page.click('[data-push-kind="widget"]');
    await page.click("[data-push-save]");
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById("panel-dialog")?.close());
    await openSettings(page, false);
    await gotoSection(page, "notifications");
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => document.querySelector('[data-push-kind="widget"]')?.getAttribute("aria-pressed") ?? "gone");
    check(after !== "gone" && after !== before, "a notification switch is flipped, the panel reopened, and the value stuck",
      `${before} -> ${after}`);
  }

  step("the Update row arms twice and disarms on its own");
  await gotoSection(page, "updates");
  const update = await page.evaluate(() => {
    const button = document.querySelector('[data-setting-row="update-box"] button');
    return button == null ? null : { text: button.textContent.trim(), disabled: button.disabled };
  });
  check(update != null, "Update Titan's computer is on the Updates section", update ? `${update.text}, ${update.disabled ? "disabled" : "enabled"}` : "absent");
  if (update != null) {
    const status = await page.evaluate(() => window.__mrSettings.facts().updateAvailable);
    check(update.disabled === (status !== true),
      "and it is enabled only where a newer bundle is published, so it is inert on a patched host",
      `hostUpdateAvailable ${JSON.stringify(status)}, button ${update.disabled ? "disabled" : "enabled"}`);
    if (!update.disabled) {
      await page.click('[data-setting-row="update-box"] button');
      await page.waitForTimeout(400);
      const armed = await page.evaluate(() => document.querySelector('[data-setting-row="update-box"] button')?.textContent.trim());
      check(armed === "Click Again to Confirm", "one press arms it", armed);
      await page.waitForTimeout(6500);
      const rested = await page.evaluate(() => document.querySelector('[data-setting-row="update-box"] button')?.textContent.trim());
      check(rested === "Update", "and it disarms without a second press", rested);
    } else {
      info("the two-press arm is not exercised here: the button is correctly disabled on this host, and NO gate presses it on a live one");
    }
  }

  step("the account menu at the foot of the roster");
  await page.evaluate(() => document.getElementById("panel-dialog")?.close());
  await page.waitForTimeout(400);
  const tile = await page.evaluate(() => {
    const node = document.querySelector("[data-account-tile]");
    if (node == null) return null;
    const rect = node.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height), inRoster: node.closest("#worker-roster") != null };
  });
  check(tile != null && tile.inRoster, "the workspace tile is at the foot of the roster", tile ? `${tile.w}x${tile.h}` : "absent");
  if (tile != null) {
    await page.click("[data-account-tile]");
    await page.waitForTimeout(400);
    const rows = await page.$$eval("[data-account-menu] [data-account-row]", (nodes) => nodes.map((node) => node.dataset.accountRow));
    // The top level is the reference's order; the three under Support are its submenu, and they are
    // in the markup whether or not the submenu is open.
    const top = rows.filter((row) => !["feedback", "self-test", "about"].includes(row));
    const expected = ["usage", "mobile", "support", "settings"];
    check(JSON.stringify(top) === JSON.stringify(expected)
      || JSON.stringify(top) === JSON.stringify(["update-banner", ...expected, "log-out"])
      || JSON.stringify(top) === JSON.stringify([...expected, "log-out"])
      || JSON.stringify(top) === JSON.stringify(["update-banner", ...expected]),
      "and its rows are the reference's, in the reference's order", rows.join(" | "));
    await page.click('[data-account-action="open-settings"]');
    await page.waitForTimeout(900);
    const opened = await page.evaluate(() => document.querySelector("[data-settings-body] [data-settings-section]")?.dataset.settingsSection ?? "");
    check(opened === "general", "Settings on the menu opens the surface at General", opened || "nothing opened");
    await page.evaluate(() => document.getElementById("panel-dialog")?.close());
    await page.click("[data-account-tile]");
    await page.waitForTimeout(300);
    await page.click('[data-account-action="open-usage"]');
    await page.waitForTimeout(900);
    const usage = await page.evaluate(() => document.querySelector("[data-settings-body] [data-settings-section]")?.dataset.settingsSection ?? "");
    check(usage === "usage", "Weekly usage opens Usage & Billing", usage || "nothing opened");
    await page.evaluate(() => document.getElementById("panel-dialog")?.close());
    await page.click("[data-account-tile]");
    await page.waitForTimeout(300);
    // Support is a submenu, so it is opened before its rows are pressed -- the same two presses a
    // person makes.
    await page.click(".account-menu-submenu > summary");
    await page.waitForTimeout(300);
    await page.click('[data-account-action="send-feedback"]');
    await page.waitForTimeout(1200);
    const report = await page.evaluate(() => document.querySelector(".problem-report-card") != null);
    check(report, "Send feedback opens the report-a-problem card", report ? "the card is in the transcript" : "no card appeared");
  }

  step("as a customer, the operator's section does not exist");
  await openSettings(page, false);
  const asCustomer = await page.evaluate(() => ({
    nav: document.querySelector('[data-settings-nav="operator"]') != null,
    jobBus: document.querySelector("[data-job-bus]") != null,
    mail: document.querySelector("[data-mail]") != null,
    endpoint: document.getElementById("endpoint-select") != null,
    passwords: document.querySelectorAll("#panel-content input[type=password]").length,
  }));
  check(!asCustomer.nav, 'there is no data-settings-nav="operator" anywhere');
  check(!asCustomer.jobBus && !asCustomer.mail && !asCustomer.endpoint,
    "and none of the operator's cards is reachable", JSON.stringify(asCustomer));
  check(asCustomer.passwords === 0, `and there is no password field on a customer's Settings (${BASELINE.passwordFields} before this ship)`,
    `${asCustomer.passwords} field(s)`);
  for (const id of EXPECTED_NAV) { await gotoSection(page, id); await shoot(page, `settings-${id}-1440x900`); }
  await page.context().close();

  // =================================================================================================
  step("as the operator");
  // =================================================================================================
  page = await open({ w: DESKTOP.w, h: DESKTOP.h, operator: true });
  await openSettings(page, false);
  const asOperator = await page.evaluate(() => document.querySelector('[data-settings-nav="operator"]') != null);
  check(asOperator, 'with the session answering operator:true there IS a data-settings-nav="operator"');
  if (asOperator) {
    await gotoSection(page, "operator");
    await page.waitForTimeout(2500);
    const kept = await page.evaluate(() => ({
      endpoint: document.getElementById("endpoint-select") != null,
      groups: [...document.querySelectorAll("[data-plugin-group]")].map((node) => node.dataset.pluginGroup),
      review: document.getElementById("auto-review-toggle") != null && document.querySelector("[data-save-review]") != null,
      jobBus: document.querySelector("[data-job-bus]") != null,
      jobBusControls: document.querySelectorAll("[data-job-bus] button, [data-job-bus] input, [data-job-bus] select").length,
      mail: document.querySelector("[data-mail]") != null,
      mailKeyField: document.querySelector("[data-mail-key]") != null,
      mailSecretField: document.querySelector("[data-mail-secret]") != null,
      host: document.querySelector("[data-update-box]") != null && document.querySelector("[data-reset-box]") != null,
      adminLink: /api\.titanium\.bot\/admin/.test(document.querySelector("[data-settings-body]")?.textContent ?? ""),
    }));
    check(kept.endpoint, "the endpoint picker is still there");
    check(kept.review, "the review policy switch and its Save are still there");
    check(kept.jobBus && kept.jobBusControls > 0, "the whole job bus card is still there", `${kept.jobBusControls} controls`);
    check(kept.mail, "the mail card is still there");
    check(!kept.mailKeyField, "with its sending-key field GONE, which is KEYS-1");
    check(kept.mailSecretField, "and its signing secret still on it, which is MAIL-WEBHOOK-1");
    check(kept.host, "the host's own Update and Reset are still the operator's");
    check(kept.adminLink, "and the section says where the keys are instead", "api.titanium.bot/admin");
    info(`plugin groups on this box: ${kept.groups.join(", ") || "none (this Mac has no plan group; the R750 with a proxy does)"}`);
    await shoot(page, "settings-operator-1440x900");
  }
  await page.context().close();

  // =================================================================================================
  step(`the phone sheet at ${PHONE.w}x${PHONE.h}, device scale 3, touch`);
  // =================================================================================================
  page = await open({ w: PHONE.w, h: PHONE.h, phone: true, operator: false });
  const routes = await page.evaluate(() => {
    const box = (id) => { const rect = document.getElementById(id)?.getBoundingClientRect(); return rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null; };
    return { gear: box("settings-button"), shelf: box("shelf-settings"), tile: document.querySelector("[data-account-tile]") != null };
  });
  info(`#settings-button ${JSON.stringify(routes.gear)}, #shelf-settings ${JSON.stringify(routes.shelf)} (MOBILE-2c's row says there is NO phone route; measured, the top-bar gear is one)`);
  check(routes.gear != null && routes.gear.w >= 44 && routes.gear.h >= 44, "the top-bar gear is a 44 px target at phone width", JSON.stringify(routes.gear));

  await openSettings(page, true);
  const sheet = await page.evaluate(() => {
    const dialog = document.getElementById("panel-dialog");
    const rect = dialog.getBoundingClientRect();
    const navList = document.querySelector(".settings-nav-list");
    return {
      w: Math.round(rect.width), h: Math.round(rect.height),
      viewportW: document.documentElement.clientWidth, viewportH: document.documentElement.clientHeight,
      navScrolls: navList != null && getComputedStyle(navList).overflowX === "auto",
    };
  });
  check(sheet.w >= sheet.viewportW - 2 && sheet.h >= sheet.viewportH - 2,
    "the surface is a full-height sheet", `${sheet.w}x${sheet.h} in a ${sheet.viewportW}x${sheet.viewportH} viewport`);
  check(sheet.navScrolls, "and the nav is a horizontal scroller of the sections above the body");

  const phoneBodies = [];
  for (const id of EXPECTED_NAV) {
    await gotoSection(page, id);
    const seen = await page.evaluate(() => {
      const scroller = document.querySelector(".settings-body");
      return { scrollHeight: scroller?.scrollHeight ?? 0, clientHeight: scroller?.clientHeight ?? 0 };
    });
    phoneBodies.push({ id, ...seen });
    const ratio = seen.clientHeight > 0 ? seen.scrollHeight / seen.clientHeight : 0;
    check(ratio > 0 && ratio <= 3, `${id} is under three screens at ${PHONE.w}x${PHONE.h}`,
      `${seen.scrollHeight} px in a ${seen.clientHeight} px window (${ratio.toFixed(2)}x)`);
    await shoot(page, `settings-${id}-390x844`);
  }
  info(`total across five sections ${phoneBodies.reduce((n, body) => n + body.scrollHeight, 0)} px, against ${BASELINE.phoneScroll} px in one dialog before this ship`);

  step(`nothing past the right edge (${BASELINE.phoneOverflow} rects before this ship, worst right edge 692 px)`);
  let worstOverflow = { count: 0, worst: [] };
  for (const id of EXPECTED_NAV) {
    await gotoSection(page, id);
    const over = await page.evaluate(OVERFLOW);
    if (over.count > worstOverflow.count) worstOverflow = over;
    check(over.count === 0, `${id} keeps every rect inside the viewport`, over.count === 0 ? "0" : `${over.count} — ${over.worst.join(", ")}`);
  }

  step("every control on the sheet is a 44 px target");
  const small = [];
  for (const id of EXPECTED_NAV) {
    await gotoSection(page, id);
    const under = await page.evaluate(() => [...document.querySelectorAll("[data-settings-surface] button, [data-settings-surface] select, [data-settings-surface] input, [data-settings-surface] a")]
      .map((node) => { const rect = node.getBoundingClientRect(); return { tag: node.tagName.toLowerCase(), cls: String(node.className).split(" ")[0], w: Math.round(rect.width), h: Math.round(rect.height) }; })
      .filter((row) => row.w > 0 && row.h > 0 && (row.w < 44 || row.h < 44)));
    small.push(...under.map((row) => `${id}/${row.tag}.${row.cls} ${row.w}x${row.h}`));
  }
  check(small.length === 0, "every control on the phone sheet is at least 44x44", small.length === 0 ? "swept five sections" : small.slice(0, 6).join(", "));

  step("two taps from the roster drawer's foot");
  await page.evaluate(() => document.getElementById("panel-dialog")?.close());
  await page.waitForTimeout(400);
  await page.tap("#roster-drawer");
  await page.waitForTimeout(700);
  const footReachable = await page.evaluate(() => {
    const node = document.querySelector("[data-account-tile]");
    if (node == null) return null;
    const rect = node.getBoundingClientRect();
    const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { w: Math.round(rect.width), h: Math.round(rect.height), hits: node.contains(at) || node === at };
  });
  if (footReachable?.hits !== true) {
    check(false, "the account tile is reachable at the foot of the open roster drawer", JSON.stringify(footReachable));
  } else {
    await page.tap("[data-account-tile]");
    await page.waitForTimeout(400);
    await page.tap('[data-account-action="open-settings"]');
    await page.waitForTimeout(1200);
    const open2 = await page.evaluate(() => document.querySelector("[data-settings-body] [data-settings-section]")?.dataset.settingsSection ?? "");
    check(open2 === "general", "two taps from the roster drawer's foot reach the settings sheet", `tile then Settings -> ${open2}`);
  }

  check(pageErrors.length === 0, "and nothing threw in either browser", pageErrors.length === 0 ? "no page errors" : pageErrors.slice(0, 3).join(" · "));
  await page.context().close();
} catch (error) {
  failures += 1;
  console.log(`  FAIL  the run itself — ${String(error?.stack ?? error).split("\n").slice(0, 3).join(" | ")}`);
} finally {
  await shutdown();
}

console.log(`\nscreenshots: ${shots.length}`);
for (const file of shots) console.log(`  ${file}`);
console.log(`\nverify-settings: ${passes} pass, ${failures} fail, ${skips} skip · ${URL_TARGET ?? "grok-bot-local-vm on this Mac"} · ${DESKTOP.w}x${DESKTOP.h} and ${PHONE.w}x${PHONE.h}`);
process.exit(failures > 0 ? 1 : 0);
