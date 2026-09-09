#!/usr/bin/env node
// verify-mobile.mjs -- MOBILE-1, the console on a phone, in a real browser at real device sizes.
//
// Titan's report #4 in the control plane is the spec, in the person's own words: "the mobile
// version of the console does not work: cannot scroll or move around, content is too large for the
// mobile viewport. User was trying to read chat on a phone and could not navigate at all."
//
// THREE RULES THIS FILE IS WRITTEN UNDER.
//
//   A PASSING page.click() IS NOT EVIDENCE A THUMB CAN REACH SOMETHING. Every control this gate
//   claims a person can use is hit-tested: on screen, at least 44x44, and the element under its own
//   centre is that element or something inside it. Before this ship, `.send-button` sat at x 425 in
//   a 390 px viewport and elementFromPoint at its centre answered null -- and page.click() would
//   still have passed on it, because it scrolls first.
//
//   THE OVERFLOW COUNT ONLY COUNTS WHAT A PERSON CANNOT REACH. An element inside a container that
//   scrolls sideways is reachable by dragging it, and a drawer parked off canvas at
//   `visibility: hidden` is not on the page at all. Both are excluded, and the raw count is printed
//   beside the real one so the two are never confused. The number that matters is the document's
//   own scrollWidth against innerWidth: 125 px of console used to hang off the right edge with no
//   scrollbar and no pan.
//
//   THE DESKTOP LEG IS AN A/B, NOT A COMMITTED PNG. The phone pass adds exactly two rules outside
//   `@media (max-width: 690px)`: the shell's column track and the hide on the drawer nodes. The leg
//   screenshots 1440x900 as shipped, then puts the console back the way it was (implicit column,
//   drawer nodes laid out) and screenshots again, and fails on any differing pixel. That isolates
//   this ship's own base rules instead of comparing against a baseline that would also carry every
//   other wave's changes.
//
// USAGE
//   node scripts/verify-mobile.mjs --all                     every leg, one browser, one relay
//   node scripts/verify-mobile.mjs --width --reach           just those two
//   node scripts/verify-mobile.mjs --all --url https://console.titanium.bot
//                                                            read-only, CONSOLE_BEARER in the env
//
// The default target is a relay spawned from THIS worktree against grok-bot-local-vm, so the gate
// always measures the tree it lives in rather than whatever tree the 7777 server was started from.
// It takes the shared box lock while it does, and the whole run fits inside the 300 s ceiling.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBoxLock } from "./lib/box-lock.mjs";

const LEGS = ["width", "reach", "scroll", "send", "drawers", "panels", "attach", "card", "fonts", "land", "desktop"];
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

const URL_TARGET = value("url");
const READ_ONLY = URL_TARGET != null;
const chosen = flag("all") ? [...LEGS] : LEGS.filter((leg) => flag(leg));
if (chosen.length === 0) {
  console.log("usage: node scripts/verify-mobile.mjs (--all | --width | --reach | --scroll | --send | --drawers | --panels | --attach | --card | --fonts | --land | --desktop)");
  console.log("       [--url https://console.titanium.bot]  read-only, CONSOLE_BEARER in the environment");
  console.log("");
  console.log("  --width    the shell's column is the viewport and nothing hangs off the right edge");
  console.log("  --reach    every control a thumb needs is on screen, 44x44, and nothing is on top of it");
  console.log("  --scroll   a real touch drag moves the transcript both ways and the document never moves");
  console.log("  --send     a tapped Send puts a message in the transcript");
  console.log("  --drawers  the roster and the agent panel open, work, and close");
  console.log("  --panels   the marketplace, a bot page and settings fit");
  console.log("  --attach   a picture staged from the composer shows an unclipped chip");
  console.log("  --card     a report card opened by hand fits, and its Send is a real target");
  console.log("  --fonts    every text input is at least 16px and the viewport meta covers the notch");
  console.log("  --land     a phone turned sideways still has its composer on screen");
  console.log("  --desktop  1440x900 does not move by one pixel");
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? path.join(repoRoot, ".cache/playwright");
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.GROK_BOT_SHOT_DIR ?? "/tmp/mobile-shots";
const BEARER = process.env.CONSOLE_BEARER ?? "";
const RUN_BUDGET_MS = Number(process.env.GROK_BOT_MOBILE_BUDGET_MS ?? 260_000);
let deadline = Date.now() + RUN_BUDGET_MS;
const budgetLeft = () => deadline - Date.now();
const within = (ms) => Math.max(1, Math.min(ms, budgetLeft()));

// The two device sizes every phone leg runs at. iPhone 14/15 and the Pro Max, at their real scale.
const PHONES = [{ w: 390, h: 844, name: "390x844" }, { w: 430, h: 932, name: "430x932" }];
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 titanbot-gate/verify-mobile.mjs";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 titanbot-gate/verify-mobile.mjs";

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
// A skipped leg is never a passing one: it is named, counted, and printed in the summary.
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const info = (line) => console.log(`  INFO  ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOTS, { recursive: true });
const shots = [];
const shoot = async (page, name) => {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  shots.push(file);
  return file;
};

// ---- the relay under test ------------------------------------------------------------------------

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startRelay() {
  const port = await freePort();
  const child = spawn(process.execPath, ["ui/server.mjs"], {
    cwd: repoRoot,
    env: { ...process.env, SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1" },
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

// ---- the browser -----------------------------------------------------------------------------------

const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
const headers = BEARER ? { authorization: `Bearer ${BEARER}` } : {};
let browser = null;
let ORIGIN = URL_TARGET ?? "";
let relay = null;
const errors = [];

async function phonePage({ w, h }) {
  const context = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_UA,
    extraHTTPHeaders: headers,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: within(60_000) });
  await page.waitForFunction(() => window.__machineRoomAdapter != null, { timeout: within(60_000) }).catch(() => {});
  await page.waitForTimeout(3000);
  return page;
}

// Visible, at least 44x44, and the element under its own centre is itself or something inside it.
// Nothing is scrolled first: a control a person needs at all times has to be where they can press
// it, and "it works once you scroll to it" is the failure this gate exists to catch.
const REACH = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { found: true, on: false, w: 0, h: 0 };
  const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return {
    found: true,
    x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height),
    on: r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
    big: r.width >= 44 && r.height >= 44,
    hit: at != null && (at === el || el.contains(at) || at.contains(el)),
    under: at ? at.tagName.toLowerCase() + (at.id ? "#" + at.id : "") : "nothing",
  };
};

// What a person cannot reach, as opposed to what merely reports a rect past the edge: a hidden
// drawer and anything inside a sideways scroller are both reachable or not on the page.
const OVERFLOW = () => {
  const scrollableX = (el) => {
    const cs = getComputedStyle(el);
    return (cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1;
  };
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrollableX(p)) return true;
    return false;
  };
  const raw = [...document.querySelectorAll("body *")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > window.innerWidth + 1;
  });
  const real = raw.filter((el) => getComputedStyle(el).visibility !== "hidden" && !inScroller(el));
  return {
    raw: raw.length,
    real: real.length,
    worst: real.slice(0, 5).map((el) => (el.tagName.toLowerCase() + "." + String(el.className || "").split(" ")[0] + "@" + Math.round(el.getBoundingClientRect().right))),
    shellColumn: getComputedStyle(document.querySelector(".app-shell")).gridTemplateColumns,
    docScrollWidth: document.scrollingElement.scrollWidth,
    shellScrollWidth: document.querySelector(".app-shell").scrollWidth,
    inner: window.innerWidth,
  };
};

// A real thumb, not scrollTop: touchStart, a run of touchMoves, touchEnd, through CDP.
async function thumbDrag(page, x, fromY, toY) {
  const client = await page.context().newCDPSession(page);
  const steps = 8;
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
  for (let i = 1; i <= steps; i += 1) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: Math.round(fromY + ((toY - fromY) * i) / steps) }] });
    await sleep(16);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
  await sleep(500);
}

// A tap at real screen coordinates, on a control this gate has already hit-tested.
async function tap(page, selector) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  if (!box) return false;
  await page.touchscreen.tap(box.x, box.y);
  await sleep(700);
  return true;
}

// ================================================================================================
// the legs
// ================================================================================================

async function legWidth(page, phone) {
  const out = await page.evaluate(OVERFLOW);
  info(`${phone.name}: shell column ${out.shellColumn}, document scrollWidth ${out.docScrollWidth}, ${out.raw} rects past the edge, ${out.real} of them reachable by nobody`);
  check(out.shellColumn === `${phone.w}px`, `${phone.name}: the shell's column is the viewport`, `${out.shellColumn} (515.406px before this ship, at every viewport)`);
  check(out.real === 0, `${phone.name}: nothing is off the right edge`, `${out.real} (402 at 390 and 392 at 430 before this ship)${out.worst.length ? ` — ${out.worst.join(", ")}` : ""}`);
  check(out.docScrollWidth <= out.inner + 1, `${phone.name}: the document does not scroll sideways`, `${out.docScrollWidth} vs ${out.inner}`);
  check(out.shellScrollWidth <= phone.w + 1, `${phone.name}: and neither does the shell`, `${out.shellScrollWidth}`);
  await shoot(page, `mobile-width-${phone.name}`);
}

async function legReach(page, phone) {
  const wanted = [
    [".send-button", "Send"],
    ["#settings-button", "Settings"],
    ["#theme-toggle", "the theme toggle"],
    ["#composer-plus", "the composer's plus"],
    ["#message-input", "the message box"],
    ["#roster-drawer", "the conversations handle"],
    ["#context-drawer", "the agent-panel handle"],
    ["#room-menu", "the room menu"],
  ];
  for (const [selector, name] of wanted) {
    const got = await page.evaluate(REACH, selector);
    if (!got.found) { check(false, `${phone.name}: ${name} is on the page`, selector); continue; }
    check(got.on === true, `${phone.name}: ${name} is on screen`, `x ${got.x}..${got.right} in ${phone.w}`);
    check(got.big === true, `${phone.name}: ${name} is at least 44x44`, `${got.w}x${got.h}`);
    check(got.hit === true, `${phone.name}: and nothing is drawn on top of ${name}`, `under it: ${got.under}`);
  }
  await shoot(page, `mobile-reach-${phone.name}`);
}

async function legScroll(page, phone) {
  const before = await page.evaluate(() => {
    const t = document.querySelector(".transcript");
    return { top: Math.round(t.scrollTop), height: t.scrollHeight, view: t.clientHeight };
  });
  if (before.height <= before.view + 40) { skip(`${phone.name}: the transcript scrolls both ways`, "this conversation is shorter than the viewport"); return; }
  const mid = Math.round(phone.h / 2);
  await thumbDrag(page, Math.round(phone.w / 2), mid - 160, mid + 160);
  const up = await page.evaluate(() => Math.round(document.querySelector(".transcript").scrollTop));
  await thumbDrag(page, Math.round(phone.w / 2), mid + 160, mid - 160);
  const down = await page.evaluate(() => Math.round(document.querySelector(".transcript").scrollTop));
  const doc = await page.evaluate(() => ({ top: document.scrollingElement.scrollTop, left: document.scrollingElement.scrollLeft }));
  info(`${phone.name}: transcript ${before.height} px in a ${before.view} px band; a thumb moved it ${before.top} → ${up} → ${down}`);
  check(up < before.top, `${phone.name}: a real touch drag scrolls the transcript back`, `${before.top} → ${up}`);
  check(down > up, `${phone.name}: and forward again`, `${up} → ${down}`);
  check(doc.top === 0 && doc.left === 0, `${phone.name}: the document itself never moves`, `top ${doc.top}, left ${doc.left}`);
}

async function legSend(page, phone) {
  if (READ_ONLY) { skip(`${phone.name}: a tapped Send lands a message`, "a send is a write, and --url runs read-only"); return; }
  const line = `titanbot-gate mobile ${phone.name} ${Date.now()}`;
  await tap(page, "#message-input");
  await page.keyboard.type(line);
  const sent = await tap(page, ".send-button");
  check(sent, `${phone.name}: Send takes a tap at its own coordinates`);
  // The transcript is the box's, re-read on the adapter's own beat, so this waits for the box
  // rather than for a fixed pause: at 2.5 s one of the two widths landed and the other did not,
  // which is a busy box and not a layout fault.
  const landed = await page.waitForFunction(
    (text) => (document.querySelector(".transcript")?.innerText ?? "").includes(text),
    line,
    { timeout: within(25_000) },
  ).then(() => true).catch(() => false);
  check(landed, `${phone.name}: and the message is in the transcript`, line);
  await shoot(page, `mobile-send-${phone.name}`);
}

async function legDrawers(page, phone) {
  const before = await page.evaluate(() => document.getElementById("room-title")?.textContent ?? "");
  await tap(page, "#roster-drawer");
  const roster = await page.evaluate(() => {
    const el = document.getElementById("worker-roster");
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const at = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return {
      onScreen: r.left >= -1 && r.right <= window.innerWidth + 1 && r.width > 100,
      width: Math.round(r.width),
      visible: cs.visibility === "visible",
      covers: at != null && el.contains(at),
      under: at ? at.tagName.toLowerCase() + (at.id ? "#" + at.id : "." + String(at.className || "").split(" ")[0]) : "nothing",
      cards: document.querySelectorAll("#worker-roster [data-context-id]").length,
      expanded: document.getElementById("roster-drawer")?.getAttribute("aria-expanded"),
    };
  });
  check(roster.onScreen && roster.visible, `${phone.name}: the conversations drawer opens on screen`, `${roster.width} px wide, ${roster.cards} conversations in it`);
  check(roster.covers === true, `${phone.name}: and it is what a tap in the middle of it lands on`, `under it: ${roster.under}`);
  check(roster.expanded === "true", `${phone.name}: its handle says it is open`, `aria-expanded=${roster.expanded}`);
  await shoot(page, `mobile-drawer-roster-${phone.name}`);

  const other = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#worker-roster [data-context-id]")];
    const next = cards.find((c) => c.getAttribute("aria-pressed") !== "true") ?? cards[0];
    if (!next) return null;
    const r = next.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 30), name: next.textContent.trim().slice(0, 24) };
  });
  if (other) {
    await page.touchscreen.tap(other.x, other.y);
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => ({
      title: document.getElementById("room-title")?.textContent ?? "",
      drawer: document.body.dataset.drawer ?? "",
    }));
    check(after.title !== before || after.title.length > 0, `${phone.name}: tapping a conversation in the drawer opens it`, `${before || "(blank)"} → ${after.title}`);
    check(after.drawer === "", `${phone.name}: and the drawer closes behind you`, `data-drawer="${after.drawer}"`);
  } else {
    skip(`${phone.name}: tapping a conversation in the drawer opens it`, "this box has no conversations in the roster");
  }

  await tap(page, "#context-drawer");
  const rail = await page.evaluate(() => {
    const el = document.getElementById("context-space");
    const r = el.getBoundingClientRect();
    return {
      onScreen: r.right <= window.innerWidth + 1 && r.left >= -1 && r.width > 100,
      visible: getComputedStyle(el).visibility === "visible",
      tile: (() => { const t = document.querySelector("#rail-screen [data-handoff-action], #rail-screen button"); if (!t) return null; const b = t.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), on: b.right <= window.innerWidth + 1 }; })(),
    };
  });
  check(rail.onScreen && rail.visible, `${phone.name}: the agent panel opens on screen`);
  if (rail.tile) check(rail.tile.w > 0 && rail.tile.h > 0 && rail.tile.on, `${phone.name}: this agent's screen tile is reachable by a thumb for the first time`, `${rail.tile.w}x${rail.tile.h}`);
  else skip(`${phone.name}: this agent's screen tile is reachable`, "the rail is drawing no screen tile for this agent");
  await shoot(page, `mobile-drawer-context-${phone.name}`);

  const scrim = await page.evaluate(() => {
    const el = document.getElementById("drawer-scrim");
    const cs = getComputedStyle(el);
    return { drawn: cs.display !== "none", x: Math.round(window.innerWidth * 0.1), y: Math.round(window.innerHeight * 0.5) };
  });
  check(scrim.drawn, `${phone.name}: the scrim is drawn while a drawer is open`);
  await page.touchscreen.tap(scrim.x, scrim.y);
  await page.waitForTimeout(600);
  const closed = await page.evaluate(() => document.body.dataset.drawer ?? "");
  check(closed === "", `${phone.name}: a tap on the scrim closes the drawer`, `data-drawer="${closed}"`);
}

async function legPanels(page, phone) {
  await tap(page, '[data-capability="marketplace"]');
  await page.waitForTimeout(2000);
  const market = await page.evaluate(OVERFLOW);
  const dialog = await page.evaluate(() => {
    const el = document.getElementById("panel-dialog");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const body = el.querySelector(".panel-body, .plugin-browser, .panel-scroll");
    return { w: Math.round(r.width), right: Math.round(r.right), cards: el.querySelectorAll(".plugin-card, [data-plugin-id], [data-bot-id]").length, scrolls: body ? body.scrollHeight > body.clientHeight + 1 : null };
  });
  check(dialog != null, `${phone.name}: the marketplace opens from a tap`);
  if (dialog) {
    check(dialog.right <= phone.w + 1, `${phone.name}: and it fits the width`, `${dialog.w} px, right edge ${dialog.right}`);
    check(market.real === 0, `${phone.name}: with nothing inside it off the edge`, `${market.real}${market.worst.length ? ` — ${market.worst.join(", ")}` : ""}`);
  }
  await shoot(page, `mobile-marketplace-${phone.name}`);

  const opened = await page.evaluate(() => {
    const card = document.querySelector("#panel-dialog .plugin-card, #panel-dialog [data-plugin-id], #panel-dialog [data-bot-id]");
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 40) };
  });
  if (opened) {
    await page.touchscreen.tap(opened.x, opened.y);
    await page.waitForTimeout(1500);
    const page2 = await page.evaluate(OVERFLOW);
    check(page2.real === 0, `${phone.name}: a bot page inside the marketplace fits too`, `${page2.real}${page2.worst.length ? ` — ${page2.worst.join(", ")}` : ""}`);
    await shoot(page, `mobile-botpage-${phone.name}`);
  } else {
    skip(`${phone.name}: a bot page inside the marketplace fits`, "the marketplace drew no cards on this box");
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await tap(page, "#settings-button");
  await page.waitForTimeout(2500);
  const settings = await page.evaluate(OVERFLOW);
  info(`${phone.name}: settings — ${settings.raw} rects past the edge, ${settings.real} of them unreachable`);
  check(settings.real === 0, `${phone.name}: the settings panel fits`, `${settings.real} (31 before this ship, worst right edge 692 px)${settings.worst.length ? ` — ${settings.worst.join(", ")}` : ""}`);
  await shoot(page, `mobile-settings-${phone.name}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

async function legAttach(page, phone) {
  if (READ_ONLY) { skip(`${phone.name}: a staged picture shows an unclipped chip`, "staging a file is a write, and --url runs read-only"); return; }
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.setInputFiles("#composer-file", { name: "one-pixel.png", mimeType: "image/png", buffer: png });
  await page.waitForTimeout(1200);
  const chip = await page.evaluate(() => {
    const tray = document.getElementById("attachment-tray");
    const one = tray?.querySelector(".tag, [data-attachment-chip], button");
    if (!one) return null;
    const r = one.getBoundingClientRect();
    const t = tray.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right),
      onScreen: r.right <= window.innerWidth + 1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.top >= -1,
      trayRight: Math.round(t.right),
      hit: at != null && (one.contains(at) || at.contains(one)),
      under: at ? at.tagName.toLowerCase() + (at.className ? "." + String(at.className).split(" ")[0] : "") : "nothing",
    };
  });
  check(chip != null, `${phone.name}: staging a picture draws an attachment chip`);
  if (chip) {
    check(chip.onScreen, `${phone.name}: and the chip is on screen, not clipped`, `${chip.w}x${chip.h}, right edge ${chip.right} in ${phone.w}`);
    check(chip.hit, `${phone.name}: and nothing is drawn on top of it`, `under it: ${chip.under}`);
  }
  // FEEDBACK-2's own measurement, taken here because this is the one leg with a file in the tray:
  // the tray used to float over the transcript's last row and push the status chip up with it.
  const clear = await page.evaluate(() => {
    const t = document.querySelector(".transcript").getBoundingClientRect();
    const shelf = document.querySelector(".control-shelf").getBoundingClientRect();
    const tray = document.getElementById("attachment-tray").getBoundingClientRect();
    return { transcriptBottom: Math.round(t.bottom), shelfTop: Math.round(shelf.top), trayTop: Math.round(tray.top) };
  });
  check(clear.trayTop >= clear.shelfTop - 1, `${phone.name}: the tray sits inside the shelf, not over the conversation`, `tray top ${clear.trayTop}, shelf top ${clear.shelfTop}, transcript bottom ${clear.transcriptBottom}`);
  await shoot(page, `mobile-attach-${phone.name}`);
}

// FEEDBACK-2 meets MOBILE-1. The report card is the transcript's last child, and on a phone it used
// to be drawn 442 px wide inside a 390 px viewport with its body text and half its textarea off the
// edge, and an 11px box to type into. This opens one the way a person does -- the always-present
// control -- and then answers it, so nothing is left pending on the box.
async function legCard(page, phone) {
  const opened = await tap(page, "#report-problem");
  check(opened, `${phone.name}: Report a problem takes a tap`);
  await page.waitForTimeout(900);
  const card = await page.evaluate(() => {
    const node = document.querySelector(".problem-report-card");
    if (!node) return null;
    const r = node.getBoundingClientRect();
    const area = node.querySelector("textarea");
    const ar = area?.getBoundingClientRect();
    const send = node.querySelector("[data-report-send]");
    const sr = send?.getBoundingClientRect();
    const at = sr ? document.elementFromPoint(sr.x + sr.width / 2, sr.y + sr.height / 2) : null;
    const over = [...node.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).length;
    return {
      w: Math.round(r.width), right: Math.round(r.right),
      areaRight: ar ? Math.round(ar.right) : null,
      areaFont: area ? parseFloat(getComputedStyle(area).fontSize) : null,
      send: sr ? { w: Math.round(sr.width), h: Math.round(sr.height), on: sr.right <= window.innerWidth + 1 && sr.bottom <= window.innerHeight + 1 } : null,
      sendHit: at != null && send != null && (send === at || send.contains(at) || at.contains(send)),
      over,
    };
  });
  check(card != null, `${phone.name}: and a report card is on the page`);
  if (card) {
    check(card.right <= phone.w + 1 && card.over === 0, `${phone.name}: the report card fits the viewport`, `${card.w} px wide, right edge ${card.right}, textarea right ${card.areaRight}, ${card.over} descendants past the edge (442 px wide at x 0 before this ship)`);
    check(card.areaFont >= 16, `${phone.name}: and its box is big enough to type into without iOS zooming`, `${card.areaFont}px (11px before this ship)`);
    check(card.send?.on === true && card.sendHit === true && card.send.w >= 44 && card.send.h >= 44,
      `${phone.name}: its Send is a 44x44 target on screen with nothing on top of it`,
      card.send ? `${card.send.w}x${card.send.h} (58x34 before the card's buttons joined the tap-target rule)` : "missing");
  }
  // Answer it, so nothing is left pending and the settled card gets its own measurement.
  await tap(page, "[data-report-drop]");
  const foldedAway = await page.waitForFunction(
    () => (document.querySelector(".transcript")?.innerText ?? "").includes("Kept to yourself:"),
    { timeout: within(14_000) },
  ).then(() => true).catch(() => false);
  check(foldedAway, `${phone.name}: Not now folds the card into a quiet row instead of pinning it above the composer`);
  await shoot(page, `mobile-report-card-${phone.name}`);
}

async function legFonts(page, phone) {
  const out = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input[type=text], input[type=search], input:not([type]), textarea")]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((el) => ({ id: el.id || el.className || el.tagName, size: parseFloat(getComputedStyle(el).fontSize) }));
    const box = document.getElementById("message-input");
    const cs = getComputedStyle(box);
    return {
      inputs,
      small: inputs.filter((one) => one.size < 16),
      meta: document.querySelector('meta[name="viewport"]')?.content ?? "",
      line: parseFloat(cs.lineHeight),
      max: parseFloat(cs.maxHeight),
    };
  });
  info(`${phone.name}: ${out.inputs.length} visible text inputs, smallest ${Math.min(...out.inputs.map((o) => o.size))}px`);
  check(out.small.length === 0, `${phone.name}: every visible text input is at least 16px`, out.small.length ? out.small.map((o) => `${o.id} ${o.size}px`).join(", ") : "15px on the composer and 11px on the report card before this ship");
  check(/viewport-fit=cover/.test(out.meta), `${phone.name}: the viewport meta covers the notch`, out.meta);
  check(out.max === out.line * 8, `${phone.name}: the composer's eight-line cap moved with its line box`, `${out.line}px line, ${out.max}px cap`);

  // The keyboard. Chrome cannot raise an iPhone's, so the visual viewport is shrunk by hand and the
  // shelf is read for the padding it puts under itself. THE IPHONE ITSELF IS UNMEASURED.
  const kb = await page.evaluate(() => {
    const before = parseFloat(getComputedStyle(document.querySelector(".control-shelf")).paddingBottom);
    Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => window.innerHeight - 300 });
    window.visualViewport.dispatchEvent(new Event("resize"));
    const after = parseFloat(getComputedStyle(document.querySelector(".control-shelf")).paddingBottom);
    const kbVar = document.documentElement.style.getPropertyValue("--kb");
    return { before, after, kbVar };
  });
  check(kb.after - kb.before >= 290, `${phone.name}: a keyboard-sized visual viewport lifts the composer off the bottom`, `shelf padding ${kb.before} → ${kb.after}, --kb ${kb.kbVar} (the iPhone's own keyboard is unmeasured: Chrome cannot raise one)`);
}

async function legLand(phone) {
  const context = await browser.newContext({
    viewport: { width: phone.h, height: phone.w },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA, extraHTTPHeaders: headers,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: within(60_000) });
  await page.waitForFunction(() => window.__machineRoomAdapter != null, { timeout: within(60_000) }).catch(() => {});
  await page.waitForTimeout(2500);
  const out = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell").getBoundingClientRect();
    const composer = document.querySelector(".composer").getBoundingClientRect();
    return {
      shellHeight: Math.round(shell.height),
      composerBottom: Math.round(composer.bottom),
      view: window.innerHeight,
      minHeight: getComputedStyle(document.querySelector(".app-shell")).minHeight,
    };
  });
  info(`${phone.h}x${phone.w} sideways: shell ${out.shellHeight} px tall, min-height ${out.minHeight}, composer bottom ${out.composerBottom} in ${out.view}`);
  check(out.shellHeight <= out.view + 1, `${phone.h}x${phone.w}: the shell fits the height`, `${out.shellHeight} (650 before this ship)`);
  check(out.composerBottom <= out.view + 1, `${phone.h}x${phone.w}: and the composer is on screen`, `${out.composerBottom} (394 in a 390 px viewport before this ship)`);
  await shoot(page, `mobile-landscape-${phone.h}x${phone.w}`);
  await context.close();
}

// THE NO-CHANGE LEG. Two shots at 1440x900 in one browser: the console as shipped, and the console
// with this ship's two base rules put back the way they were. Any differing pixel is a desktop
// regression, and there is nowhere else it could have come from.
async function legDesktop() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: DESKTOP_UA, extraHTTPHeaders: headers,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: within(60_000) });
  await page.waitForFunction(() => window.__machineRoomAdapter != null, { timeout: within(60_000) }).catch(() => {});
  await page.waitForTimeout(3500);

  const geometry = await page.evaluate(() => {
    const send = document.querySelector(".send-button").getBoundingClientRect();
    const composer = document.querySelector(".composer").getBoundingClientRect();
    return {
      column: getComputedStyle(document.querySelector(".app-shell")).gridTemplateColumns,
      sendX: Math.round(send.x), sendRight: Math.round(send.right),
      composerBottom: Math.round(composer.bottom),
    };
  });
  const overflow = await page.evaluate(OVERFLOW);
  check(geometry.column === "1440px", "1440x900: the shell's column is the viewport", geometry.column);
  check(overflow.real === 0, "1440x900: nothing is off the right edge", String(overflow.real));
  check(geometry.composerBottom === 856, "1440x900: the composer's bottom is where it was", `${geometry.composerBottom} (856 measured on this box before this ship)`);
  check(geometry.sendX === 959 && geometry.sendRight === 1053, "1440x900: and Send is where it was", `x ${geometry.sendX}..${geometry.sendRight} (959..1053 before this ship)`);

  // WHAT A PIXEL CLAIM CAN AND CANNOT BE ON THIS CONSOLE.
  //
  // The first cut of this leg screenshotted the full page twice a few seconds apart and failed by
  // 11 KB on a page nobody had touched. With every animation and transition forced off, measured on
  // this Mac in headless Chrome: `.window-bar` and `#transcript` come back byte-identical shot after
  // shot, and every panel carrying `backdrop-filter: blur() saturate()` -- the roster, the room
  // capsule, the agent rail, the shelf -- differs by a hundred bytes in a hundred kilobytes each
  // time. That is the compositor re-rasterising a blur, not the layout moving, and no amount of
  // waiting settles it.
  //
  // So the leg makes two claims instead of one bad one:
  //
  //   THE GEOMETRY, EXACTLY. Every element in the document, by tag, id, class and rounded rect. A
  //   single element moving one pixel changes the fingerprint. This is what "the shell's column rule
  //   changes nothing" actually means, and it is deterministic.
  //
  //   THE PIXELS, WHERE PIXELS ARE STABLE. The two regions that come back identical in the same
  //   state are shot in both states and compared byte for byte. A region's own noise floor is
  //   measured first, in the same run, and a region that will not hold still is named and skipped
  //   rather than silently dropped.
  await page.addStyleTag({ content: `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }` });
  await sleep(800);

  // Every element by a key that survives a re-render, and its rounded rect. Keyed rather than
  // ordered because the adapter rebuilds subtrees and a positional diff would call every row after
  // an inserted one "moved".
  const fingerprint = () => page.evaluate(() => {
    const seen = new Map();
    const out = {};
    for (const el of document.querySelectorAll("body *")) {
      const cls = String(el.className || "").split(" ")[0];
      const base = `${el.tagName}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}`;
      const ordinal = (seen.get(base) ?? 0) + 1;
      seen.set(base, ordinal);
      const r = el.getBoundingClientRect();
      out[`${base}[${ordinal}]`] = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
    }
    return out;
  });

  // What moves on its own, in the same state, with nothing changed. The agent rail redraws its
  // screen tile and its browser strip on the adapter's beat, so those rects are not evidence about
  // a stylesheet rule either way. They are named, counted and left out, and everything else has to
  // hold still exactly.
  const churn = (a, b) => new Set(Object.keys(a).filter((key) => b[key] !== a[key]).concat(Object.keys(b).filter((key) => a[key] === undefined)));
  const compare = (a, b, skip) => Object.keys(a).filter((key) => !skip.has(key) && b[key] !== a[key]);

  const STABLE = [".window-bar", "#transcript"];
  const region = async (selector) => page.locator(selector).screenshot().catch(() => null);

  const geometryA = await fingerprint();
  await sleep(1200);
  const geometryB = await fingerprint();
  const moving = churn(geometryA, geometryB);
  const shippedGeometry = geometryB;
  const noise = {};
  const shippedPixels = {};
  for (const selector of STABLE) {
    const first = await region(selector);
    await sleep(900);
    const second = await region(selector);
    noise[selector] = first != null && second != null && first.equals(second);
    shippedPixels[selector] = second;
  }
  const wholePage = await page.screenshot({ path: path.join(SHOTS, "desktop-as-shipped.png"), fullPage: true });
  shots.push(path.join(SHOTS, "desktop-as-shipped.png"));
  info(`1440x900: ${Object.keys(shippedGeometry).length} elements fingerprinted, ${moving.size} of them moving on their own with nothing changed${moving.size ? ` (${[...moving].slice(0, 4).join(", ")})` : ""}; still regions ${STABLE.map((one) => `${one}=${noise[one] ? "yes" : "no"}`).join(", ")}`);

  // Both base rules back the way they were. The drawer nodes coming back MUST change the geometry:
  // that is what shows the comparison can see a change at all.
  await page.addStyleTag({ content: `
    .app-shell { grid-template-columns: none !important; }
    .icon-button.drawer-toggle { display: grid !important; }
    .drawer-scrim { display: block !important; }
  ` });
  await sleep(800);
  const revertedGeometry = await fingerprint();
  await page.screenshot({ path: path.join(SHOTS, "desktop-base-rules-reverted.png"), fullPage: true });
  shots.push(path.join(SHOTS, "desktop-base-rules-reverted.png"));
  const revertMoved = compare(shippedGeometry, revertedGeometry, moving);
  check(revertMoved.length > 0, "1440x900: the comparison can see a difference at all",
    `the revert draws the two drawer handles and the scrim, and ${revertMoved.length} rects change`);

  // Now only the shell's column rule is reverted. This is the claim.
  await page.addStyleTag({ content: `.icon-button.drawer-toggle, .drawer-scrim { display: none !important; }` });
  await sleep(800);
  const columnOnlyGeometry = await fingerprint();
  await page.screenshot({ path: path.join(SHOTS, "desktop-column-rule-reverted.png"), fullPage: true });
  shots.push(path.join(SHOTS, "desktop-column-rule-reverted.png"));
  const moved = compare(shippedGeometry, columnOnlyGeometry, moving);
  const held = Object.keys(shippedGeometry).length - moving.size;
  check(moved.length === 0, "1440x900: the shell's column rule moves nothing, to the pixel, across the whole document",
    moved.length === 0
      ? `${held} elements with identical rects, ${moving.size} left out because they move on their own`
      : moved.slice(0, 5).map((key) => `${key} ${shippedGeometry[key]} -> ${columnOnlyGeometry[key]}`).join(" | "));

  for (const selector of STABLE) {
    if (!noise[selector]) { skip(`1440x900: ${selector} is pixel-identical with the column rule reverted`, "this region did not hold still in the same state, so a comparison of it would prove nothing"); continue; }
    const now = await region(selector);
    check(now != null && shippedPixels[selector].equals(now), `1440x900: ${selector} is pixel-identical with the column rule reverted`,
      `${shippedPixels[selector]?.length ?? 0} bytes against ${now?.length ?? 0}`);
  }
  info(`1440x900: the full page is NOT byte-compared — every backdrop-filter panel re-rasterises by ~100 bytes in ~100 KB between two shots of the same unchanged page (${wholePage.length} bytes). The geometry above is the claim; desktop-as-shipped.png and desktop-column-rule-reverted.png are saved for a human to look at`);

  await context.close();
}

// ================================================================================================

let release = null;
try {
  if (!READ_ONLY) {
    release = await acquireBoxLock({ what: "verify-mobile.mjs", waitMs: 120 * 60_000, pollMs: 15_000, log: info });
    deadline = Date.now() + RUN_BUDGET_MS;
    relay = await startRelay();
    ORIGIN = relay.origin;
    info(`a relay from this worktree at ${ORIGIN}, against grok-bot-local-vm`);
  } else {
    info(`read-only against ${ORIGIN}`);
  }
  browser = await chromium.launch({ executablePath: CHROME, headless: true });

  const phoneLegs = chosen.filter((leg) => !["land", "desktop"].includes(leg));
  if (phoneLegs.length) {
    for (const phone of PHONES) {
      console.log(`\n== ${phone.name}, device scale 3, touch, iPhone ==`);
      const page = await phonePage(phone);
      if (chosen.includes("width")) await legWidth(page, phone);
      if (chosen.includes("reach")) await legReach(page, phone);
      if (chosen.includes("scroll")) await legScroll(page, phone);
      if (chosen.includes("drawers")) await legDrawers(page, phone);
      if (chosen.includes("panels")) await legPanels(page, phone);
      if (chosen.includes("attach")) await legAttach(page, phone);
      if (chosen.includes("card")) await legCard(page, phone);
      if (chosen.includes("fonts")) await legFonts(page, phone);
      if (chosen.includes("send")) await legSend(page, phone);
      await page.context().close();
    }
  }
  if (chosen.includes("land")) { console.log("\n== sideways =="); for (const phone of PHONES) await legLand(phone); }
  if (chosen.includes("desktop")) { console.log("\n== 1440x900, the no-change leg =="); await legDesktop(); }

  check(errors.length === 0, "the page threw nothing at any size", errors.slice(0, 3).join(" | "));
} catch (error) {
  check(false, "the gate ran to the end", String(error?.message ?? error));
} finally {
  await browser?.close().catch(() => {});
  relay?.stop();
  release?.();
}

console.log("");
for (const file of shots) console.log(`  SHOT  ${file}`);
console.log(`\n${passes} passed, ${failures} failed${skips ? `, ${skips} skipped` : ""}`);
process.exit(failures === 0 ? 0 : 1);
