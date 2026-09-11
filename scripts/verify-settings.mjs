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
// THE TALKING ROWS, which used to be a card and are not one any more. KEYS-1 deleted the Voice card
// whole: its key field was the operator's and belongs in the super admin console. VOICE-8 brought the
// four operator controls that went with it back as ROWS on the Operator section's Talking group --
// Service, Model, Voice and Who you are talking to, carrying the same four attributes the card carried.
// So this gate asserts both halves by name rather than passing over them: those four are ON the
// operator's section and on NONE of the five customer sections, and [data-voice], the card's own
// attribute, is nowhere at all. The checks that read [data-voice] before VOICE-9 deleted the card were
// passing because nothing on the page matched them, which is a gate that guards nothing.
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

// SETTINGS-3, the before number, so the after number below means something. MEASURED on
// grok-bot-local-vm (this Mac), real Chrome, 2026-09-10, against the shared tip: with `always` stored,
// opening Settings and choosing *Push to talk* the instant the sheet painted left the select reading
// `always` in 10 of 10 runs at 390x844 while the voice module and this browser both read `push`; the
// same run with a 2.5 s settle first was 0 of 10, and 1440x900 was 0 of 10 either way. A leg that waits
// for the panel to settle before it clicks passes on the bug and is not the leg.
const STALE_BEFORE = { phoneNoSettle: "10 of 10 wrong", phoneSettled: "0 of 10", desktop: "0 of 10" };
const STALE_RUNS = Number(process.env.GROK_BOT_STALE_RUNS ?? 20);

// General's own height at each viewport, with the background grid still inline. THIS WAVE'S ITEM B DOES
// NOT CHANGE IT; item C shortens it in the same tree by moving the 19 tile faces off the row and behind a
// Choose control, and this is the number that change is measured against. MEASURED on grok-bot-local-vm,
// real Chrome, 2026-09-10: 1250 px of scroll in a 676 px window at 1440x900 and 1537 px in 645 px at
// 390x844.
const GENERAL_BEFORE = { desktop: "1250 px in 676 px (1.85x)", phone: "1537 px in 645 px (2.38x)" };

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
  async function open({ w, h, phone = false, operator = false, noSettingsModule = false }) {
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
    // THE DEPLOY FAULT, ON PURPOSE. With settings.js not served, app.js falls back to the panel that
    // shipped before this wave -- which is the OPERATOR body. The leg below proves the fallback is
    // gated on who is looking rather than painted at whoever pressed the button.
    // A PREDICATE, not a glob: "**/settings.js" can be read loosely enough to take push-settings.js
    // with it, and aborting that one would be measuring a different fault.
    if (noSettingsModule) {
      await context.route((url) => /(^|\/)settings\.js$/.test(new URL(url).pathname), (route) => route.abort());
    }
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

  step("every section paints exactly one body, and no customer body is a settings-list");
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
        pushMounts: document.querySelectorAll("#panel-content [data-push-mount]").length,
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
  // .settings-list is the selector voice.js hunts for, and it belongs to the OPERATOR stack alone.
  // A customer body carrying it would take the Voice card and its technical rows onto a customer's
  // screen. The Notifications card has its own slot, [data-push-mount], and shares nothing.
  const listCounts = bodies.map((body) => `${body.id}:${body.lists}`);
  check(bodies.every((body) => body.lists === 0),
    "no customer body carries .settings-list, so voice.js's card can never land on one", listCounts.join(" "));
  check(bodies.every((body) => body.pushMounts === (body.id === "notifications" ? 1 : 0)),
    "and [data-push-mount] is the Notifications body's alone, which is push-settings.js's whole mount contract",
    bodies.map((body) => `${body.id}:${body.pushMounts}`).join(" "));
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
  // WRITTEN DOWN ON PURPOSE. Item C of this wave shortens General in the same tree by moving the 19 tile
  // faces off the Background row and behind a Choose control, so the number this run measures is the
  // one its re-measurement is against.
  const generalNow = bodies.find((body) => body.id === "general");
  info(`General at ${DESKTOP.w}x${DESKTOP.h} on grok-bot-local-vm: ${generalNow?.scrollHeight} px in a ${generalNow?.clientHeight} px window`
    + ` (${((generalNow?.scrollHeight ?? 0) / Math.max(1, generalNow?.clientHeight ?? 1)).toFixed(2)}x). The grid is still on the row here, and item C is measured against ${GENERAL_BEFORE.desktop}.`);

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
  // VOICE-8/VOICE-9. The card itself is GONE -- [data-voice] matches nothing anywhere on the page, which
  // is why a check that only looked for it on a customer section had stopped measuring anything -- and
  // what replaced it is four rows on the Operator section. Both halves, named:
  const talking = await page.evaluate(() => ({
    card: document.querySelectorAll("[data-voice]").length,
    onCustomer: document.querySelectorAll('[data-settings-section]:not([data-settings-section="operator"]) [data-voice-vendor],'
      + '[data-settings-section]:not([data-settings-section="operator"]) [data-voice-model],'
      + '[data-settings-section]:not([data-settings-section="operator"]) [data-voice-voice],'
      + '[data-settings-section]:not([data-settings-section="operator"]) [data-voice-agent]').length,
    anywhere: document.querySelectorAll("[data-voice-vendor], [data-voice-model], [data-voice-voice], [data-voice-agent]").length,
  }));
  check(talking.card === 0, "the old Voice card is gone from the page entirely, not merely off the customer sections",
    `${talking.card} [data-voice]`);
  check(talking.onCustomer === 0 && talking.anywhere === 0,
    "and none of the four Talking controls is anywhere on a customer's Settings",
    JSON.stringify(talking));

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

  // ---- the deploy fault: settings.js missing, and a customer pressing the gear ----------------------
  //
  // ONE MISSING ASSET USED TO HAND A CUSTOMER THE WHOLE OPERATOR PANEL. app.js's absent-module
  // fallback paints the pre-wave body -- two password fields, the endpoint picker, the job bus, the
  // mail plane and the red Reset -- and it was painted at whoever pressed the button. It now reads the
  // same operator fact the surface's nav reads and a customer gets one plain line instead. Measured
  // here by aborting every request ending /settings.js, which is exactly the fault shape.
  step("with settings.js not served, a customer gets a plain line and none of the operator's rows");
  page = await open({ w: DESKTOP.w, h: DESKTOP.h, operator: false, noSettingsModule: true });
  const moduleGone = await page.evaluate(() => window.__mrSettings == null);
  check(moduleGone, "the module really is absent for this leg", moduleGone ? "window.__mrSettings is absent" : "it loaded anyway");
  await page.click("#settings-button");
  await page.waitForTimeout(2500);
  const broken = await page.evaluate(() => ({
    open: document.getElementById("panel-dialog")?.open === true,
    words: (document.getElementById("panel-content")?.textContent ?? "").trim().slice(0, 80),
    surface: document.querySelector("[data-settings-surface]") != null,
    passwords: document.querySelectorAll("#panel-content input[type=password]").length,
    reset: document.querySelectorAll("[data-reset-box]").length,
    update: document.querySelectorAll("[data-update-box]").length,
    jobBus: document.querySelectorAll("[data-job-bus]").length,
    mail: document.querySelectorAll("[data-mail]").length,
    endpoint: document.getElementById("endpoint-select") != null,
  }));
  check(broken.open && /Settings could not load/.test(broken.words),
    "the panel opens on one plain line a person can act on", broken.words || "nothing painted");
  check(broken.passwords === 0 && broken.reset === 0 && broken.update === 0,
    "no password field, no Update and no Reset reach a customer when the module is missing",
    `${broken.passwords} password(s), ${broken.update} update, ${broken.reset} reset`);
  check(!broken.jobBus && !broken.mail && !broken.endpoint,
    "and neither does the job bus, the mail plane or the endpoint picker",
    JSON.stringify({ jobBus: broken.jobBus, mail: broken.mail, endpoint: broken.endpoint }));
  await shoot(page, "settings-module-absent-customer-1440x900");
  await page.context().close();

  // The same fault as the OPERATOR: the old panel is what he should get, because it is his panel and
  // a deploy fault must not take his endpoint picker away.
  page = await open({ w: DESKTOP.w, h: DESKTOP.h, operator: true, noSettingsModule: true });
  await page.click("#settings-button");
  await page.waitForTimeout(3000);
  const operatorFallback = await page.evaluate(() => ({
    endpoint: document.getElementById("endpoint-select") != null,
    jobBus: document.querySelector("[data-job-bus]") != null,
    reset: document.querySelector("[data-reset-box]") != null,
  }));
  check(operatorFallback.endpoint && operatorFallback.jobBus && operatorFallback.reset,
    "the operator still gets his own panel when the module is missing", JSON.stringify(operatorFallback));
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

    // ---- VOICE-8: the four controls KEYS-1 took off the page with the card ------------------------
    //
    // WHY THIS LEG HAS TO READ THE CONTROLS AND NOT THE REGISTRY. The registry accepted these rows all
    // along: bodyMarkup returned early for a section whose body another module fills, so the entries
    // were stored, their fill() ran against the operator's body every paint, and their markup was never
    // drawn. No error, no failing unit case, a row nobody can see. So what is measured is the control's
    // own attribute on screen, inside the Operator section, and nothing shorter than that.
    await page.waitForFunction(() => document.querySelector("[data-voice-vendor]") != null, { timeout: within(20_000) }).catch(() => {});
    const rows = await page.evaluate(() => {
      const host = document.querySelector('[data-settings-contributed-host="operator"]');
      const of = (selector) => {
        const node = document.querySelector(selector);
        if (node == null) return null;
        const rect = node.getBoundingClientRect();
        const row = node.closest("[data-setting-row]");
        return {
          tag: node.tagName.toLowerCase(),
          disabled: node.disabled === true,
          w: Math.round(rect.width), h: Math.round(rect.height),
          label: (row?.querySelector("strong")?.textContent ?? "").trim(),
          line: (row?.querySelector("small")?.textContent ?? "").trim(),
          inOperator: row?.closest('[data-settings-contributed-host="operator"]') != null,
          group: row?.closest("[data-settings-group]")?.dataset.settingsGroup ?? "",
          slots: row == null ? 0 : row.querySelectorAll(":scope > .setting-control").length,
          action: node.hasAttribute("data-settings-action"),
        };
      };
      return {
        heading: (host?.querySelector(".settings-group-label")?.textContent ?? "").trim(),
        insideOperatorStack: document.querySelector('.settings-operator [data-voice-vendor]') != null,
        vendor: of("[data-voice-vendor]"),
        model: of("[data-voice-model]"),
        voice: of("[data-voice-voice]"),
        agent: of("[data-voice-agent]"),
        vendorOptions: [...(document.querySelector("[data-voice-vendor]")?.options ?? [])].map((one) => one.textContent.trim()),
        agentOptions: (document.querySelector("[data-voice-agent]")?.options ?? []).length,
        passwords: document.querySelectorAll('[data-settings-contributed-host="operator"] input[type=password]').length,
      };
    });
    const four = [["Service", rows.vendor], ["Model", rows.model], ["Voice", rows.voice], ["Who you are talking to", rows.agent]];
    for (const [name, one] of four) {
      check(one != null && one.w > 0 && one.h > 0 && !one.disabled,
        `the Talking row "${name}" is on the Operator section, on screen and usable`,
        one == null ? "the control is not on the page at all" : JSON.stringify(one));
      if (one != null) {
        check(one.label === name && one.line.length > 0 && one.slots === 1 && !one.action,
          `and it is a label, one line and exactly one control, with no settings action the surface would swallow`,
          `${one.label} / "${one.line}" / ${one.slots} slot(s) / action ${one.action}`);
      }
    }
    check(rows.heading === "Talking", "the four are under one Talking heading", rows.heading || "no heading");
    check(rows.vendor?.group === "talking" && rows.agent?.group === "talking", "in the Talking group",
      `${rows.vendor?.group} / ${rows.agent?.group}`);
    // BESIDE app.js's own stack and not inside it: that body is somebody else's markup and every other
    // leg above reads its controls by id.
    check(!rows.insideOperatorStack, "and beside app.js's operator stack rather than inserted into it",
      rows.insideOperatorStack ? "a Talking control is inside .settings-operator" : "a sibling container of its own");
    check(rows.passwords === 0, "no key field came back with them", `${rows.passwords} password field(s)`);
    // PRINTED, not assumed: the rule is that a label a person reads names no vendor, and the only way to
    // show that is to put the words in the run.
    info(`the Service options, in the words the route answers: ${rows.vendorOptions.map((one) => `"${one}"`).join(" | ") || "none"}`);
    const named = rows.vendorOptions.filter((one) => /xai|x\.ai|openai|grok|anthropic/i.test(one));
    check(rows.vendorOptions.length >= 2 && named.length === 0,
      "and each one is a billing shape rather than a vendor's name", named.length > 0 ? named.join(", ") : `${rows.vendorOptions.length} options`);
    info(`Who you are talking to offers ${rows.agentOptions} choice(s), which is this box's roster plus "whoever is leading the team"`);

    // ---- VOICE-8: and the write really reaches the door ------------------------------------------
    //
    // READ BACK OFF THE ROUTE, not off the control: the control showing what was chosen proves the
    // select works, and this wave's whole claim is that the capability is reachable again. The box is
    // SHARED with every other gate, so whatever it was on goes back on at the end.
    const beforeVendor = await page.evaluate(async () => {
      const answer = await fetch("/voice/settings", { headers: { accept: "application/json" } }).then((r) => r.json());
      return { vendor: answer.vendor, choices: (answer.vendors ?? []).map((one) => one.id) };
    });
    const other = (beforeVendor.choices ?? []).find((id) => id !== beforeVendor.vendor);
    if (other == null) {
      skip("choosing the other Service round-trips through the door", `this relay answers one service only (${beforeVendor.vendor})`);
    } else {
      await page.selectOption("[data-voice-vendor]", other);
      await page.waitForTimeout(1800);
      const afterVendor = await page.evaluate(async () =>
        (await fetch("/voice/settings", { headers: { accept: "application/json" } }).then((r) => r.json())).vendor);
      const onControl = await page.evaluate(() => document.querySelector("[data-voice-vendor]")?.value ?? "");
      check(afterVendor === other && onControl === other,
        "choosing the other Service round-trips through the door and is written back from its own answer",
        `${beforeVendor.vendor} -> asked ${other}, route says ${afterVendor}, control says ${onControl}`);
      await page.selectOption("[data-voice-vendor]", beforeVendor.vendor);
      await page.waitForTimeout(1800);
      const restoredVendor = await page.evaluate(async () =>
        (await fetch("/voice/settings", { headers: { accept: "application/json" } }).then((r) => r.json())).vendor);
      check(restoredVendor === beforeVendor.vendor, "and the box is left on the service it was found on",
        `${beforeVendor.vendor} -> ${restoredVendor}`);
    }

    // ---- and they are on NO customer section, with the operator door shut -------------------------
    for (const id of EXPECTED_NAV) {
      await gotoSection(page, id);
      const leaked = await page.evaluate(() => document.querySelectorAll("[data-voice-vendor], [data-voice-model], [data-voice-voice], [data-voice-agent]").length);
      check(leaked === 0, `none of the four Talking controls is on ${id}`, `${leaked} found`);
    }
  }

  // ---- the tripwire the merged design named by name ------------------------------------------------
  //
  // Execution on this computer stops being a read-only pill and becomes a writable picker, and the
  // middle choice is the one that could have been a lie: the settings extension's own setter is
  // typed "always" | "never" at extension.ts:7 while the controller reads "ask" at
  // local-tool-permission-controller.ts:45. So the write is PROVED here rather than assumed --
  // set "ask", reopen the panel, read what the host answered -- and the original value is put back
  // afterwards, because this gate shares a box with every other one.
  step("Execution on this computer writes, and the host gives the value back");
  await gotoSection(page, "computer");
  const before = await page.evaluate(() => document.querySelector('[data-setting-row="execution"] select')?.value ?? null);
  if (before == null) {
    skip("a write of \"ask\" round-trips through the host", "this box reports no local tool permission at all, so the row is not drawn");
  } else {
    // BOTH WRITES, and "ask" LAST, because "ask" is the one the tripwire is about: it is the middle
    // choice, the one the settings extension's own setter is not typed for, and the one a box is
    // most likely to be sitting on already -- so a leg that only wrote "whatever it is not" would
    // have proved "never" on this box and called the tripwire cleared without ever writing "ask".
    const write = async (value) => {
      await page.selectOption('[data-setting-row="execution"] select', value);
      await page.waitForTimeout(2500);
      await openSettings(page, false);
      await gotoSection(page, "computer");
      return page.evaluate(() => document.querySelector('[data-setting-row="execution"] select')?.value ?? null);
    };
    for (const target of ["never", "always", "ask"]) {
      const after = await write(target);
      check(after === target, `a write of "${target}" round-trips through the host`,
        `asked for ${target}, host answered ${after}`);
      if (after !== target) {
        info(`TRIPWIRE: the host would not take "${target}". That option has to ship disabled with an honest line, and the row is item C's to file.`);
      }
    }
    // Put the box back the way it was found. It is shared with every other gate.
    const restored = await write(before);
    check(restored === before, "and the box is left on the value it was found on", `${before} -> ${restored}`);
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

  // =================================================================================================
  step(`SETTINGS-3: a refresh that started before a person's change may not paint over it (${STALE_BEFORE.phoneNoSettle} at ${PHONE.w}x${PHONE.h} before this)`);
  // =================================================================================================
  //
  // HOW THIS LEG IS WRITTEN TO FAIL ON THE UNFIXED CODE, which is the only thing that makes it a leg.
  //
  // The producer is open()'s own `void readFacts().then(paint)`. readFacts snapshots the live values
  // synchronously BEFORE its first await; act() used to write the module, this browser's storage and the
  // DOM node and never the facts; so a change made while that read was in flight was painted over from
  // its own older snapshot when it landed. The window is a few hundred milliseconds on this Mac at
  // 390x844 and closed at 1440x900, which is why every existing leg -- each of which waits for the sheet
  // to settle -- was green through it.
  //
  // So: the panel is opened ONCE to warm the facts (the row is drawn from them on the synchronous paint
  // of the next open, which is what puts the change inside the window), then each run opens it again,
  // checks that the row was there on that synchronous paint -- PROOF the read is still in flight, since
  // it cannot have completed synchronously -- and dispatches the change with no settle at all, from
  // inside the page, so there is no round trip between the row existing and the value changing.
  //
  // And all three are read, not only the control: the select, the module, and this browser's stored
  // value. The bug had the other two correct and the control lying, which is the one thing a settings
  // row may never do.
  const raceOne = async (row, from, to, readBack) => page.evaluate(async ({ row: rowId, from: was, to: want }) => {
    const settle = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    document.getElementById("panel-dialog")?.close();
    await settle();
    window.__mrSettings.open("general", null);
    const select = document.querySelector(`[data-setting-row="${rowId}"] select`);
    // The row was NOT on the synchronous paint, so the facts were cold and this run is not the race.
    if (select == null) return { reproduced: false, why: "the row was not on the synchronous paint" };
    const started = Date.now();
    select.value = want;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { reproduced: true, was, want, at: Date.now() - started };
  }, { row, from, to });

  // -- the Talk mode row, which is the row the defect was found on -----------------------------------
  const talkRow = await page.evaluate(() => document.querySelector('[data-setting-row="talk-mode"]') != null);
  if (!talkRow) {
    await openSettings(page, true);
    await gotoSection(page, "general");
  }
  const haveTalk = await page.evaluate(() => document.querySelector('[data-setting-row="talk-mode"] select') != null);
  if (!haveTalk) {
    skip(`the Talk mode row survives a refresh that started before the change, ${STALE_RUNS} runs`,
      "this relay serves no voice module, so there is no Talk mode row to change");
  } else {
    let wrong = 0;
    let reproduced = 0;
    const seen = [];
    for (let run = 0; run < STALE_RUNS; run += 1) {
      // Armed on the OTHER mode every time, through the module's own door, so each run really changes
      // something. The panel is closed by raceOne before it reopens.
      await page.evaluate(() => window.__voice?.setTalkMode?.("always"));
      await page.waitForTimeout(250);
      const attempt = await raceOne("talk-mode", "always", "push");
      if (attempt.reproduced === true) reproduced += 1;
      // Two seconds, which is longer than the read it is racing and longer than the account menu's own
      // refresh 2.5 s after boot would need if it were the producer on this page.
      await page.waitForTimeout(2000);
      const now = await page.evaluate(() => ({
        field: document.querySelector('[data-setting-row="talk-mode"] select')?.value ?? "gone",
        mode: window.__voice?.talkMode?.() ?? "",
        stored: (() => { try { return window.localStorage.getItem(window.__voice._TALK_MODE_KEY); } catch { return null; } })(),
      }));
      if (!(now.field === "push" && now.mode === "push" && now.stored === "push")) { wrong += 1; seen.push(JSON.stringify(now)); }
    }
    check(reproduced === STALE_RUNS, `all ${STALE_RUNS} runs really reproduced the condition: the row was on the synchronous paint, so the read was in flight`,
      `${reproduced} of ${STALE_RUNS}`);
    check(wrong === 0, `the Talk mode row, the module and this browser all read push, ${STALE_RUNS} of ${STALE_RUNS} runs with NO settle at ${PHONE.w}x${PHONE.h}`,
      wrong === 0 ? `${STALE_RUNS} of ${STALE_RUNS} · before this ship: ${STALE_BEFORE.phoneNoSettle} here, ${STALE_BEFORE.desktop} at ${DESKTOP.w}x${DESKTOP.h}, MEASURED on grok-bot-local-vm 2026-09-10`
        : `${wrong} of ${STALE_RUNS} wrong — ${seen.slice(0, 4).join(" ")}`);
  }

  // -- and the two other rows measured reverting in the same repaint ---------------------------------
  //
  // Theme and Microphone were measured coming back together with the talk mode in ONE repaint, which is
  // why the fix is at the mechanism and not on the one row. A run that changed the talk mode and then
  // the theme had BOTH selects reverted while the module read push and this browser held light.
  const themeRuns = Math.min(6, STALE_RUNS);
  let themeWrong = 0;
  for (let run = 0; run < themeRuns; run += 1) {
    const want = run % 2 === 0 ? "light" : "dark";
    await page.evaluate((value) => window.__mrSettings._applyTheme(value === "light" ? "dark" : "light"), want);
    await page.waitForTimeout(200);
    const attempt = await raceOne("theme", want === "light" ? "dark" : "light", want);
    if (attempt.reproduced !== true) continue;
    await page.waitForTimeout(1500);
    const now = await page.evaluate(() => ({
      field: document.querySelector('[data-setting-row="theme"] select')?.value ?? "gone",
      stored: (() => { try { return window.localStorage.getItem("titanbot.theme"); } catch { return null; } })(),
    }));
    if (now.field !== want || now.stored !== want) themeWrong += 1;
  }
  check(themeWrong === 0, `the Theme row keeps the choice through the same race, ${themeRuns} runs with no settle`,
    themeWrong === 0 ? `${themeRuns} of ${themeRuns}` : `${themeWrong} of ${themeRuns} reverted`);

  const haveMic = await page.evaluate(() => document.querySelector('[data-setting-row="microphone"] select') != null);
  if (!haveMic) {
    skip("the Microphone row keeps the choice through the same race", "this browser names no microphone, so the row is correctly not drawn");
  } else {
    let micWrong = 0;
    const choices = await page.evaluate(() => [...document.querySelectorAll('[data-setting-row="microphone"] select option')].map((one) => one.value));
    const want = choices.find((one) => one.length > 0) ?? "";
    for (let run = 0; run < 4; run += 1) {
      await page.evaluate(() => window.__voice?.setMicDeviceId?.(""));
      await page.waitForTimeout(200);
      const attempt = await raceOne("microphone", "", want);
      if (attempt.reproduced !== true) continue;
      await page.waitForTimeout(1500);
      const now = await page.evaluate(() => ({
        field: document.querySelector('[data-setting-row="microphone"] select')?.value ?? "gone",
        chosen: window.__voice?.micDeviceId?.() ?? "",
      }));
      if (now.field !== want || now.chosen !== want) micWrong += 1;
    }
    check(micWrong === 0, "the Microphone row keeps the choice through the same race, 4 runs with no settle",
      micWrong === 0 ? "4 of 4" : `${micWrong} of 4 reverted`);
  }

  // =================================================================================================
  step("General's own height at both viewports, written down because item C shortens it in this tree");
  // =================================================================================================
  // NOT THROUGH THE GEAR. The leg above leaves the roster drawer open, and at 390 px the top bar is
  // under it; this step is about a HEIGHT, and the two legs above already measured the routes in. So the
  // surface is opened by naming its section, which is the seam __mrUi publishes for exactly this.
  await page.evaluate(() => { document.getElementById("panel-dialog")?.close(); window.__mrSettings?.open?.("general", null); });
  await page.waitForSelector('[data-settings-section="general"]', { timeout: within(20_000) }).catch(() => {});
  await page.waitForTimeout(1200);
  const generalPhone = await page.evaluate(() => {
    const scroller = document.querySelector(".settings-body");
    const row = document.querySelector('[data-setting-row="background"]')?.getBoundingClientRect();
    return {
      scrollHeight: scroller?.scrollHeight ?? 0, clientHeight: scroller?.clientHeight ?? 0,
      backgroundRow: row == null ? null : { w: Math.round(row.width), h: Math.round(row.height) },
      tiles: document.querySelectorAll('[data-settings-mount="background"] [data-bg-id]').length,
    };
  });
  info(`General at ${PHONE.w}x${PHONE.h} on grok-bot-local-vm: ${generalPhone.scrollHeight} px in a ${generalPhone.clientHeight} px window`
    + ` (${(generalPhone.scrollHeight / Math.max(1, generalPhone.clientHeight)).toFixed(2)}x), background row ${JSON.stringify(generalPhone.backgroundRow)},`
    + ` ${generalPhone.tiles} tile faces inline. The grid is still on the row here, and item C is measured against ${GENERAL_BEFORE.phone}.`);

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
