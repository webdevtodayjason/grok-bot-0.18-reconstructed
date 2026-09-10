#!/usr/bin/env node
// verify-console-polish.mjs -- CONSOLE-4, the four things Jason saw on console.titanium.bot, in a
// real browser (docs/CONSOLE.md, gap row CONSOLE-4).
//
// He wrote them down on 2026-09-08 in his own words, and this file is one leg per complaint:
//
//   "the page loads, shows the original background with the mountains, then reloads with whatever
//    background the user chose"                                                          --boot
//   "the chat for Titan just scrolls forever"                                            --scroll
//   "two of the backgrounds ... are just blank spots"                                    --picker
//   "everything that happens in between chats ... can live inside a badge"               --badge
//   "there's a broken image there"                                                       --tile
//   "when there is a file and I click Files ... I can't do anything with it"             --files
//
// FOUR RULES THIS FILE IS WRITTEN UNDER, each one paid for by an earlier gate that lied.
//
//   A CLICK THAT RESOLVED IS NOT EVIDENCE. page.click() calls scrollIntoViewIfNeeded first and has
//   passed on menu items no mouse could reach. Everything here that claims a person can use a
//   control hit-tests it: a box with area, and the element under its own centre is that element or
//   something inside it.
//
//   NOTHING IS READ BEFORE THE ADAPTER EXISTS. index.html ships a static shell, and a selector
//   satisfied at 200 ms is reading markup app.js has not filled yet. (It used to ship seed COPY in
//   those fields -- "MSP Team", "3 members ready" -- which the review pass emptied, because an 8 s
//   ceiling over a stalled boot uncovered it as if it were the person's own box.) Every leg waits
//   for window.__machineRoomAdapter first.
//
//   THE RAIL TILE'S CLICK IS A WRITE. data-handoff-action="open" reaches mountBoxSurface, which
//   POSTs /box/launch and opens an app on the agent's seat. So the leg that proves the tile opens
//   the desktop runs on the local box ONLY and is refused outright in --url mode.
//
//   getForeverBoxStatus TAKES { id }, NEVER { agentId }. The host adds boxSeat only when it has an
//   agent to add it for; the agentId form answers a stub with no boxSeat FIELD at all, and a probe
//   using it would conclude the host cannot say which screen an agent is on. Measured on
//   grok-bot-local-vm 2026-09-08 for an agent really sitting on display 3: {id} -> 289 B carrying
//   "boxSeat":3, {agentId} -> 71 B with no boxSeat KEY at all. The tile leg asserts the difference
//   rather than trusting it, and prints both byte counts.
//
// USAGE
//   node scripts/verify-console-polish.mjs --tile            one leg against the local box
//   node scripts/verify-console-polish.mjs --all             every leg, in sequence, one browser
//   node scripts/verify-console-polish.mjs --tile \
//        --url https://console.titanium.bot                  read-only, with CONSOLE_BEARER set
//
// In --url mode nothing is created, nothing is prompted and nothing is clicked that writes. The
// bearer is read from the environment (CONSOLE_BEARER) and sent as an Authorization header; it is
// never printed and never written to disk.
//
// Screenshots land in the scratchpad and every one is named in the output, because a claim about
// what a person sees that has no picture behind it is a claim, not a measurement.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireBoxLock } from "./lib/box-lock.mjs";
// SIGNIN-1. Every gate says its own name at somebody's front door. This file sent nothing at
// all -- node's default user agent -- while seven other gates already carried this, so its
// requests were indistinguishable from a stranger's in the relay's sign-in ledger.
import { gateUserAgent } from "./gate-agent.mjs";
import { execFile } from "node:child_process";

const LEGS = ["boot", "scroll", "picker", "badge", "tile", "files", "approval"];
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

const URL_TARGET = value("url");
const READ_ONLY = URL_TARGET != null || flag("read-only");
const chosen = flag("all") ? [...LEGS] : LEGS.filter((leg) => flag(leg));
if (chosen.length === 0) {
  console.log("usage: node scripts/verify-console-polish.mjs (--boot | --scroll | --picker | --badge | --tile | --files | --approval | --all)");
  console.log("       [--url https://console.titanium.bot]   read-only pass, CONSOLE_BEARER in the environment");
  console.log("");
  console.log("  --boot    the chosen background is on the page before first paint, and the cover lifts");
  console.log("  --scroll  the transcript settles once and stays where the person left it");
  console.log("  --picker  the background picker has no tile-shaped blanks and defaults to Titan Nebula");
  console.log("  --badge   everything between two chat messages folds into one badge that opens again");
  console.log("  --tile    the rail's screen tile shows a picture or a plate, and never a broken image");
  console.log("  --files   a file row opens a viewer and downloads");
  console.log("  --approval  the auto-review card in every state, plus one real forced approval on the local box");
  process.exit(2);
}

const ORIGIN = URL_TARGET ?? process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BEARER = process.env.CONSOLE_BEARER ?? "";
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? new URL("../.cache/playwright", import.meta.url).pathname;
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.GROK_BOT_SHOT_DIR ?? "/tmp/console-polish-shots";
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
// Well inside the 300 s these gates run under, so the summary is printed here rather than replaced
// by a `timeout` kill with no tallies in it.
const RUN_BUDGET_MS = Number(process.env.GROK_BOT_POLISH_BUDGET_MS ?? 260_000);
const deadline = Date.now() + RUN_BUDGET_MS;
const budgetLeft = () => deadline - Date.now();
const within = (ms) => Math.max(0, Math.min(ms, budgetLeft()));

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
// A leg that deliberately did not measure, with its reason and its own numbers. Never a pass: a
// gate that banks a vacuous PASS for something it did not run stops meaning the same thing twice.
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const info = (line) => console.log(`  INFO  ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const until = async (fn, ms, step = 400) => {
  const stop = Date.now() + ms;
  for (;;) {
    const got = await fn().catch(() => null);
    if (got) return got;
    if (Date.now() > stop || budgetLeft() <= 0) return null;
    await sleep(step);
  }
};

mkdirSync(SHOTS, { recursive: true });
const shots = [];
const shoot = async (page, name, selector = null) => {
  const file = path.join(SHOTS, `${name}.png`);
  // A fixture taller than the viewport is clipped by a page screenshot, and the clipped half is
  // exactly the state nobody looked at. Naming a selector shoots that element whole instead.
  //
  // AND IT SAYS WHEN IT COULD NOT. An element screenshot waits for the element to hold still and
  // throws when it does not; swallowing that left a file from an EARLIER RUN sitting under the new
  // run's name, which is a picture that lies about what was measured. So the element attempt has a
  // short timeout, a failure falls back to the page, and the file is deleted first so a stale one
  // can never be mistaken for this run's.
  rmSync(file, { force: true });
  if (selector) {
    // A LOCATOR, not an element handle. The transcript re-renders by wiping its own innerHTML, so a
    // handle taken a moment earlier is detached by the time the shot is taken -- measured on
    // grok-bot-local-vm as "Element is not attached to the DOM" on the live approval card. A locator
    // re-resolves the selector at the moment of the shot, which is the whole difference.
    const why = await page.locator(selector).first().screenshot({ path: file, timeout: 8000 })
      .then(() => null).catch((error) => String(error.message).split("\n")[0]);
    if (why == null) { shots.push(file); return file; }
    info(`${name}: could not shoot ${selector} on its own (${why.slice(0, 90)}); the whole page instead`);
  }
  await page.screenshot({ path: file }).catch(() => {});
  shots.push(file);
  return file;
};

const GATE_AGENT = gateUserAgent(import.meta.url);
const headers = { "user-agent": GATE_AGENT, ...(BEARER ? { authorization: `Bearer ${BEARER}` } : {}) };
const api = async (method, args = {}, ms = 25_000) => {
  const res = await fetch(`${ORIGIN}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(ms),
  });
  const text = await res.text();
  if (!res.ok) { const error = new Error(`${method} (${res.status}): ${text.slice(0, 180)}`); error.status = res.status; error.body = text; throw error; }
  return { bytes: text.length, value: text.length ? JSON.parse(text) : null };
};

// ---- the browser ---------------------------------------------------------------------------------

const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
let browser = null;
let releaseLock = null;

// The module under test, in case the page does not carry it yet. A, B and D land their <script>
// tags in index.html; until those merge, a leg can still measure ITS OWN module in a real browser by
// injecting the shipped file. Which mode a leg ran in is printed, because "it works when I inject
// it" and "it works on the page" are two different claims.
const readModule = (file) => { try { return readFileSync(path.join(repoRoot, "ui/machine-room", file), "utf8"); } catch { return null; } };

// Declared before the closure that pushes into it, not after: a `const` read from a function that
// runs first is a temporal-dead-zone throw, and the first thing this would report is itself.
const errors = [];

async function newPage() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    userAgent: GATE_AGENT,
    extraHTTPHeaders: headers,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => { errors.push(String(e)); });
  return page;
}

const bootConsole = async (page, ms = 60_000) => {
  await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: within(ms) });
  return await until(() => page.evaluate(() => (window.__machineRoomAdapter ? true : null)), within(ms), 500);
};

// Visible, with area, and the element under its own centre is itself or something inside it.
// `elementFromPoint` answers null for anything outside the viewport, so a control sitting below the
// fold reads as "under its centre is nothing" whether it is reachable or not -- measured on Jason's
// console, where Titan's transcript is 34,217 px in a 668 px viewport and the badge under test was
// 20,000 px up. This scrolls the element into the viewport FIRST and hit-tests where it lands, which
// is what a person does: they scroll to a control and then click it. That is not the trap the rule
// about page.click() names. page.click()'s scrollIntoViewIfNeeded hides the interesting failure
// because it also passes when something is drawn ON TOP of the control; this still reads what is
// under the centre afterwards, so a covered control still fails, and `scrolled` says whether the
// page had to move at all.
const hitTest = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  const before = el.getBoundingClientRect();
  const offscreen = before.bottom < 0 || before.top > window.innerHeight
    || before.right < 0 || before.left > window.innerWidth;
  if (offscreen) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { found: true, visible: false, w: 0, h: 0, scrolled: offscreen };
  const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return {
    found: true, visible: true, scrolled: offscreen,
    w: Math.round(rect.width), h: Math.round(rect.height),
    hit: at != null && (at === el || el.contains(at) || at.contains(el)),
    on: at ? `${at.tagName.toLowerCase()}${at.id ? `#${at.id}` : ""}` : "nothing",
  };
}, selector);

// Every <img> the page is currently laying out, and whether the browser has anything to draw in it.
// naturalWidth 0 on a laid-out img is precisely where Chrome paints its broken-image glyph.
const brokenImages = (page) => page.evaluate(() => [...document.querySelectorAll("img")]
  .filter((img) => {
    const style = getComputedStyle(img);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = img.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (img.naturalWidth === 0 || !(img.getAttribute("src") ?? "").length);
  })
  .map((img) => ({
    where: img.closest("[id]")?.id ?? img.parentElement?.className ?? "?",
    src: (img.getAttribute("src") ?? "").slice(0, 40),
    hidden: img.hidden,
    display: getComputedStyle(img).display,
    natural: img.naturalWidth,
    box: `${Math.round(img.getBoundingClientRect().width)}x${Math.round(img.getBoundingClientRect().height)}`,
    alt: (img.getAttribute("alt") ?? "").slice(0, 60),
  })));

const openConversation = async (page, id) => {
  await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
  const card = await until(() => page.$(`.worker-card[data-context-id="${id}"]`), within(25_000), 700);
  if (!card) return false;
  await card.click({ timeout: 8000 }).catch(() => {});
  return (await until(() => page.evaluate((want) => (document.querySelector(".worker-card.is-active")?.dataset.contextId === want ? true : null), id), within(20_000), 500)) === true;
};

// ---- --tile ---------------------------------------------------------------------------------------

async function legTile(page) {
  console.log("\n== --tile: the rail's screen tile shows a picture or a plate, never a broken image");

  // 1. THE ARGUMENT SHAPE. Asserted rather than trusted, because a probe that gets it wrong reports
  //    "this host cannot say which screen this agent is on" for every agent on a healthy box.
  const roster = await api("listAgents").then((r) => r.value).catch(() => null);
  const workers = (Array.isArray(roster) ? roster : []).filter((a) => !a.isGroup);
  if (workers.length === 0) {
    skip("getForeverBoxStatus answers boxSeat for { id } and not for { agentId }", "no worker agent on this box to ask about");
  } else {
    const byId = await api("getForeverBoxStatus", { id: workers[0].id }).catch(() => ({ bytes: 0, value: null }));
    const byAgentId = await api("getForeverBoxStatus", { agentId: workers[0].id }).catch(() => ({ bytes: 0, value: null }));
    const idHas = byId.value != null && Object.prototype.hasOwnProperty.call(byId.value, "boxSeat");
    const agentIdHas = byAgentId.value != null && Object.prototype.hasOwnProperty.call(byAgentId.value, "boxSeat");
    check(idHas && !agentIdHas,
      "getForeverBoxStatus answers boxSeat for { id } and a stub for { agentId }",
      `{id} ${byId.bytes} B boxSeat=${idHas ? JSON.stringify(byId.value.boxSeat) : "ABSENT"} · {agentId} ${byAgentId.bytes} B boxSeat=${agentIdHas ? JSON.stringify(byAgentId.value.boxSeat) : "ABSENT"}`);
  }

  // 2. WHO IS ON WHICH SCREEN. Read from the host, one agent at a time and bounded, so the leg runs
  //    against a seated agent, a shared-seat agent and an idle one rather than against a guess.
  let seated = null;
  let shared = null;
  for (const worker of workers.slice(0, 12)) {
    if (seated && shared) break;
    if (budgetLeft() < 60_000) break;
    const status = await api("getForeverBoxStatus", { id: worker.id }).then((r) => r.value).catch(() => null);
    if (!status) continue;
    const seat = status.boxSeat;
    if (!seated && typeof seat === "number" && seat > 1) seated = { ...worker, seat, vncUrl: status.vncUrl ?? null };
    else if (!shared && seat === null) shared = { ...worker, seat: null };
  }
  info(`seats on this box: seated=${seated ? `${seated.name} on :${seated.seat}` : "none"} · shared=${shared ? shared.name : "none"} · ${workers.length} workers`);

  const booted = await bootConsole(page);
  check(booted === true, "the console boots and the gateway adapter is on the page", booted === true ? "window.__machineRoomAdapter present" : "no adapter — everything below would be reading the static shell");
  if (booted !== true) return;

  // 3. THE BEFORE. What the page does with the tile's <img> as it stands, before anything of this
  //    wave's is added to it. This is the number Jason's complaint is about.
  const opened = seated ?? shared ?? workers[0];
  if (opened) await openConversation(page, opened.id);
  await sleep(1500);
  const before = await brokenImages(page);
  const beforeShot = await shoot(page, `tile-before-${Date.now()}`);
  info(`BEFORE this wave: ${before.length} laid-out <img> the browser has nothing to draw in — ${JSON.stringify(before).slice(0, 320)}`);
  info(`screenshot ${beforeShot}`);

  // 4. THE MODULE. Native if index.html carries it, injected from the shipped files if the page
  //    predates A's merge -- and the leg says which, because those are two different claims.
  let mode = "native";
  const hasModule = await page.evaluate(() => typeof window.__screenTile?.sync === "function");
  if (!hasModule) {
    const js = readModule("screen-tile.js");
    const css = readModule("screen-tile.css");
    if (!js || !css) { skip("the screen-tile module is on the page", "ui/machine-room/screen-tile.js is missing from this tree"); return; }
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: js });
    mode = "injected";
  }
  const wired = await page.evaluate(() => typeof window.__screenTile?.sync === "function" && typeof window.__screenTile?.frameFor === "function");
  check(wired, "window.__screenTile publishes frameFor and sync", `${mode} — the two functions app.js calls`);
  if (mode === "injected") info('the page carries no <script src="screen-tile.js"> yet; that tag lands with builder A. Everything below measures the shipped module in a real browser, not the shipped page.');

  // 5. THE BELT. With screen-tile.css on the page, an <img> the console marked hidden must not be
  //    laid out at all -- which is what takes the broken glyph off Jason's console whatever app.js
  //    happens to emit.
  const belt = await page.evaluate(() => {
    const button = document.querySelector(".rail-screen-button");
    if (!button) return { noTile: true };
    const img = document.createElement("img");           // the exact element app.js used to emit
    img.setAttribute("data-rail-screen", "");
    img.alt = "belt probe";
    img.hidden = true;
    button.appendChild(img);
    const display = getComputedStyle(img).display;
    const rect = img.getBoundingClientRect();
    img.remove();
    return { display, w: Math.round(rect.width), h: Math.round(rect.height) };
  });
  if (belt.noTile) skip("a hidden <img> in the tile is not laid out", "no .rail-screen-button on screen for this conversation");
  else check(belt.display === "none" && belt.w === 0,
    "a hidden <img> in the tile is not laid out, so Chrome has nowhere to paint its broken glyph",
    `computed display ${belt.display}, box ${belt.w}x${belt.h} — before this stylesheet it was display block in a ${before[0]?.box ?? "real"} box`);

  const afterBelt = await brokenImages(page);
  check(afterBelt.length === 0, "with this stylesheet on the page, nothing on screen is a broken image",
    `${before.length} before, ${afterBelt.length} after${afterBelt.length ? ` — ${JSON.stringify(afterBelt).slice(0, 200)}` : ""}`);

  // 6. THE THREE SEAT BRANCHES. A numbered seat, a null seat (the shared screen) and no boxSeat
  //    field at all. In every one, what a person sees is a plate or a picture and never a hole.
  const seatBranch = async (label, seat) => {
    const state = await page.evaluate((s) => {
      const parsed = s === "ABSENT" ? undefined : s;
      window.__screenTile.teardown();
      window.__screenTile.sync({ agentId: document.querySelector(".worker-card.is-active")?.dataset.contextId ?? "probe", seat: parsed, status: "idle" });
      const tile = document.getElementById("rail-screen");
      const img = tile?.querySelector("img[data-rail-screen]") ?? null;
      const plate = tile?.querySelector("[data-rail-screen-plate]") ?? null;
      return {
        display: window.__screenTile.state().display,
        mounted: window.__screenTile.state().mounted,
        imgSrc: img ? (img.getAttribute("src") ?? "") : null,
        plateShown: plate ? !plate.hidden : null,
        plateText: plate?.textContent?.trim().slice(0, 70) ?? "",
      };
    }, seat === undefined ? "ABSENT" : seat);
    const broken = await brokenImages(page);
    check(broken.length === 0 && (state.plateShown !== false || Boolean(state.imgSrc)),
      `on ${label} a person sees a plate or a picture, never a hole`,
      `display=${JSON.stringify(state.display)} reader=${state.mounted} plate="${state.plateText}" ${broken.length} broken`);
    // The markup half is builder A's: renderScreenTile stops emitting an <img> without a src. On a
    // page that predates that merge the element is still there, harmlessly not laid out.
    if (mode === "native") check(state.imgSrc == null || state.imgSrc.length > 0, `and on ${label} no src-less <img> is in the markup at all`, state.imgSrc == null ? "no <img> until there is a frame" : `src is ${state.imgSrc.length} characters`);
    return state;
  };
  await seatBranch("a shared seat (boxSeat null)", null);
  const absent = await seatBranch("a host that did not say (no boxSeat field)", undefined);
  check(absent.mounted === false, "a host that did not say which screen mounts no reader at all", "a wrong screen is worse than no screen");
  // The plate itself, on the product's own mark, with the words in front of it. This is what a
  // person sees where the broken glyph used to be.
  info(`the plate, with no picture behind it: ${await shoot(page, `tile-plate-${Date.now()}`)}`);
  await seatBranch(`a numbered seat (boxSeat ${seated?.seat ?? 3})`, seated?.seat ?? 3);
  if (mode !== "native") info("the src-less <img> is still in the markup on this page and is no longer laid out; removing it from the markup is builder A's half of the fix");

  // 7. ONE READER, AND IT GOES. The count on the page, not a promise about it.
  const readers = () => page.evaluate(() => document.querySelectorAll("iframe[data-screen-tile-source]").length);
  await page.evaluate(() => { window.__screenTile.teardown(); window.__screenTile.sync({ agentId: "probe-a", seat: 2, status: "working" }); });
  const one = await readers();
  await page.evaluate(() => { for (let i = 0; i < 5; i += 1) window.__screenTile.sync({ agentId: "probe-a", seat: 2, status: "working" }); });
  const stillOne = await readers();
  check(one === 1 && stillOne === 1, "six renders mount exactly one reader", `${one} after the first, ${stillOne} after six`);

  await page.evaluate(() => window.__screenTile.sync({ agentId: "probe-b", seat: 2, status: "working" }));
  check(await readers() === 1, "the conversation moving to another agent leaves one reader, not two", "the old client is torn down with its timer");

  await page.evaluate(() => window.__screenTile.sync({ agentId: "probe-b", seat: undefined, status: "working" }));
  check(await readers() === 1, "a render that merely carried no display does NOT tear the reader down", "the roster and the box status are two reads; between them a record is briefly seatless");

  await page.evaluate(() => window.__screenTile.sync({ agentId: "probe-b", seat: 2, status: "working", visible: false }));
  check(await readers() === 0, "a hidden tab drops the reader to zero", "no websocket held open on a seat nobody is watching");
  await page.evaluate(() => window.__screenTile.teardown());

  // 8. A PICTURE, AND THE PLATE UNTIL IT LANDS. Only a real seat can answer this: the relay proxies
  //    the box's noVNC at /vnc/<display>/, and a display with no websockify token behind it serves
  //    the static client happily and then connects to nothing.
  if (!seated) {
    skip("a picture appears for a seated agent", `no agent on this box has a seat of its own (${workers.length} workers, all boxSeat null or absent)`);
    skip("and the plate held until it did", "not reached: no seated agent");
  } else {
    const cardOpened = await openConversation(page, seated.id);
    info(`${seated.name} is on :${seated.seat}${seated.vncUrl ? ` (${seated.vncUrl.replace(/^https?:\/\/[^/]+/, "")})` : ""}${cardOpened ? "" : " — its card would not open, driving the reader directly"}`);
    const plateHeld = await page.evaluate((s) => {
      window.__screenTile.teardown();
      try { window.localStorage.removeItem(`${window.__screenTile.limits.IDLE_PREFIX}${s.id}`); } catch { /* no storage */ }
      window.__screenTile.sync({ agentId: s.id, seat: s.seat, status: "working" });
      const plate = document.querySelector("[data-rail-screen-plate]");
      return plate ? !plate.hidden : null;
    }, { id: seated.id, seat: seated.seat });
    const started = Date.now();
    const frame = await until(() => page.evaluate((id) => {
      const got = window.__screenTile.frameFor(id);
      return got ? { len: got.length, kind: got.slice(5, got.indexOf(";")) } : null;
    }, seated.id), within(30_000), 400);
    if (frame) {
      const tookMs = Date.now() - started;
      check(true, "a picture appears for a seated agent", `${seconds(tookMs)} to a ${frame.len}-character ${frame.kind} frame off :${seated.seat}`);
      check(plateHeld !== false, "and the plate held until it did", plateHeld === null ? "no tile on screen to hold it" : "the words were on screen while the client warmed up");
      const painted = await page.evaluate(() => {
        const img = document.querySelector("#rail-screen img[data-rail-screen]");
        const plate = document.querySelector("[data-rail-screen-plate]");
        const rect = img?.getBoundingClientRect();
        return img ? { natural: img.naturalWidth, w: Math.round(rect.width), h: Math.round(rect.height), plateGone: plate ? plate.hidden : null } : null;
      });
      check(painted != null && painted.natural > 0, "and it is drawn in the tile, not just held in memory",
        painted ? `${painted.natural}px wide in a ${painted.w}x${painted.h} tile, plate hidden ${painted.plateGone}` : "no <img> in the tile");
      await shoot(page, `tile-picture-${Date.now()}`);
      const withFrame = await brokenImages(page);
      check(withFrame.length === 0, "with a picture on the tile, still nothing on screen is a broken image", `${withFrame.length} broken`);
    } else {
      skip("a picture appears for a seated agent", `no frame off :${seated.seat} inside 30 s`);
      const stillPlate = await page.evaluate(() => document.querySelector("[data-rail-screen-plate]")?.hidden === false);
      check(stillPlate === true, "and with no frame the plate is what a person sees, for as long as that lasts",
        "no empty <img>, no broken glyph, the words in plain English — which is the behaviour under test on a screen that cannot be read");
      await shoot(page, `tile-plate-${Date.now()}`);
    }
  }

  // 9. THE BLANK-FRAME REFUSAL, on the real thresholds.
  const guard = await page.evaluate(() => {
    const white = `data:image/webp;base64,${"A".repeat(1020)}`;
    const real = `data:image/webp;base64,${"B".repeat(7568)}`;
    return {
      whiteLen: white.length, realLen: real.length,
      whiteTaken: window.__screenTile.frameLooksReal(white, 220),
      realTaken: window.__screenTile.frameLooksReal(real, 220),
      flatTaken: window.__screenTile.frameLooksReal(real, 0),
    };
  });
  check(guard.whiteTaken === false && guard.realTaken === true && guard.flatTaken === false,
    "a frame caught mid-handshake is refused and a real one is taken",
    `${guard.whiteLen} chars white refused · ${guard.realLen} chars real taken · the same length with no colour spread refused`);

  // 10. THE COST. What the reader does to the frames the person is looking at, as a difference
  //     rather than an absolute nobody can compare.
  const frameCost = async () => page.evaluate(() => new Promise((resolve) => {
    const marks = [];
    let last = performance.now();
    const stop = last + 3000;
    const step = (now) => { marks.push(now - last); last = now; if (now < stop) requestAnimationFrame(step); else resolve(marks); };
    requestAnimationFrame(step);
  }));
  await page.evaluate(() => window.__screenTile.teardown());
  const quiet = await frameCost();
  const share = (marks) => `${((marks.filter((m) => m > 20).length / Math.max(1, marks.length)) * 100).toFixed(1)}%`;
  if (seated) {
    await page.evaluate((s) => window.__screenTile.sync({ agentId: s.id, seat: s.seat, status: "working" }), { id: seated.id, seat: seated.seat });
    const reading = await frameCost();
    info(`main thread over 3 s on this Mac: ${quiet.length} frames with no reader (${share(quiet)} over 20 ms) · ${reading.length} frames with a reader on :${seated.seat} (${share(reading)} over 20 ms)`);
  } else {
    info(`main thread over 3 s on this Mac with no reader: ${quiet.length} frames (${share(quiet)} over 20 ms) — no seated agent to measure the difference against`);
  }
  await page.evaluate(() => window.__screenTile.teardown());
  check(await readers() === 0, "and the reader is gone when the leg lets go of it", "nothing left running on a seat");

  // 11. THE CLICK. A WRITE: mountBoxSurface POSTs /box/launch and opens an app on the seat.
  if (READ_ONLY) {
    skip("clicking the tile opens the desktop view", "read-only pass: that click launches an app on a real seat");
  } else {
    const target = await hitTest(page, ".rail-screen-button");
    if (!target.found) {
      skip("clicking the tile opens the desktop view", "no .rail-screen-button on screen for the open conversation");
    } else {
      check(target.visible && target.hit, "the tile is where a mouse can actually reach it", `${target.w}x${target.h}, the element under its centre is ${target.on}`);
      await page.click(".rail-screen-button", { timeout: 8000 }).catch(() => {});
      const openedView = await until(() => page.evaluate(() => (document.getElementById("desktop-dialog")?.open ? true : null)), within(25_000), 500);
      check(openedView === true, "clicking the tile opens the desktop view", openedView === true ? "#desktop-dialog is open" : "the dialog never opened");
      await shoot(page, `tile-desktop-${Date.now()}`);
      await page.evaluate(() => document.getElementById("desktop-dialog")?.close());
    }
  }
}

// ---- --boot, --scroll, --picker (builder A's contract) ---------------------------------------------

async function legBoot(page) {
  console.log("\n== --boot: the chosen background is on the page before first paint, and the cover lifts");
  // A screenshot at 50 ms is the whole claim. The page is loaded with the network still in flight,
  // so what is on screen at that instant is what the stylesheet painted, not what hydrate chose.
  await page.goto(`${ORIGIN}/`, { waitUntil: "commit", timeout: within(30_000) });
  await sleep(50);
  // `document.body` is read through a guard on purpose. At 50 ms after commit over the internet the
  // parser may not have reached <body> yet -- measured against console.titanium.bot, where this leg
  // threw "getComputedStyle: parameter 1 is not of type Element" while passing over loopback, where
  // the body is always already there. A head-only document is not a failure of this claim; it is the
  // strongest possible version of it, because the plate is on <html> before a body exists at all.
  const early = await page.evaluate(() => ({
    bg: document.documentElement.dataset.bg ?? null,
    custom: getComputedStyle(document.documentElement).getPropertyValue("--machine-room-bg").trim().slice(0, 80),
    body: document.body ? getComputedStyle(document.body).backgroundImage.slice(0, 120) : "(no body parsed yet)",
    hasBody: document.body != null,
    cover: document.getElementById("boot-cover")?.dataset.bootState ?? null,
    step: document.querySelector("[data-boot-step]")?.textContent?.trim().slice(0, 60) ?? null,
  }));
  const shot = await shoot(page, `boot-50ms-${Date.now()}`);
  info(`at 50 ms: data-bg=${JSON.stringify(early.bg)} cover=${JSON.stringify(early.cover)} step=${JSON.stringify(early.step)}${early.hasBody ? "" : " body=not parsed yet"} · ${shot}`);
  const mountains = /warmwind-landscape/.test(early.body) || /warmwind-landscape/.test(early.custom);
  if (early.bg == null && !mountains) {
    skip("the chosen background is on <html> before first paint", "no data-bg and no mountains at 50 ms — builder A's inline boot script has not merged into index.html yet");
  } else {
    check(early.bg != null && !mountains,
      "the chosen background is on <html> before first paint",
      `data-bg=${JSON.stringify(early.bg)}, and warmwind-landscape.svg is ${mountains ? "STILL what the stylesheet paints" : "not on screen"}`);
  }

  if (early.cover == null) {
    skip("the boot cover appears and then goes", "no #boot-cover in the markup — builder A's cover has not merged");
  } else {
    check(early.cover === "showing", "the boot cover is on screen with the first paint", `data-boot-state=${early.cover}${early.step ? `, "${early.step}"` : ""}`);
    const gone = await until(() => page.evaluate(() => (document.getElementById("boot-cover") == null ? true : null)), within(20_000), 300);
    check(gone === true, "and it is removed from the DOM once the console is ready", gone === true ? "no #boot-cover left on the page" : "the cover was still there after 20 s, past its own ceiling");
    await shoot(page, `boot-after-cover-${Date.now()}`);
  }
}

// Opens each conversation in turn and keeps the one with the most scrollable transcript, because a
// scroll leg run against a transcript that does not overflow proves nothing at all.
async function pickLongestTranscript(page, limit = 10) {
  const roster = await api("listAgents").then((r) => r.value).catch(() => []);
  const workers = (Array.isArray(roster) ? roster : []).filter((a) => !a.isGroup).slice(0, limit);
  let best = null;
  for (const worker of workers) {
    if (budgetLeft() < 40_000) break;
    if (!(await openConversation(page, worker.id))) continue;
    await sleep(1200);
    const m = await page.evaluate(() => {
      const el = document.getElementById("transcript");
      return el ? { height: el.scrollHeight, client: el.clientHeight, rows: el.querySelectorAll("article.message-row").length } : null;
    }).catch(() => null);
    if (m && (!best || m.height > best.height)) best = { ...m, id: worker.id, name: worker.name ?? worker.id, of: workers.length };
  }
  if (best && !(await openConversation(page, best.id))) return null;
  return best;
}

async function legScroll(page) {
  console.log("\n== --scroll: the transcript settles once and stays where the person left it");
  const booted = await bootConsole(page);
  if (booted !== true) { skip("the transcript settles and stays put", "the adapter never appeared"); return; }
  // The longest transcript on the box, not roster[0]. A five-row conversation that fits its
  // viewport cannot drift by construction, so parking it and watching it not move measures the
  // scrollbar's absence rather than the fix -- measured here, where the first agent in listAgents
  // has 5 rows and 0 px of overflow.
  const busiest = await pickLongestTranscript(page);
  if (!busiest) { skip("the transcript settles and stays put", "no conversation to open on this box"); return; }
  info(`measuring on ${busiest.name} — ${busiest.rows} rows, ${busiest.height}px in a ${busiest.client}px viewport (the longest of ${busiest.of} on this box)`);
  await sleep(2000);
  const behaviour = await page.evaluate(() => {
    const el = document.getElementById("transcript") ?? document.body;
    return el ? getComputedStyle(el).scrollBehavior : "(no element to read)";
  });
  info(`.transcript scroll-behavior is ${behaviour}${behaviour === "smooth" ? " — every rebuild is an animation across the full height" : ""}`);
  // Park the reader half way up and leave the page alone. `behavior: "auto"` deliberately: with
  // scroll-behavior smooth an assignment animates, and reading scrollTop straight afterwards gives
  // the position it is LEAVING rather than the one it was put at -- which is how a leg can report a
  // parked value that was never true and then call the snap away from it "no drift".
  const parked = await page.evaluate(() => {
    const el = document.getElementById("transcript");
    if (!el) return null;
    el.scrollTo({ top: Math.round(el.scrollHeight / 3), behavior: "instant" });
    return { height: el.scrollHeight, client: el.clientHeight };
  });
  if (!parked) { skip("the transcript settles and stays put", "no #transcript on the page"); return; }
  const rowsBefore = await page.evaluate(() => document.querySelectorAll("article.message-row").length);
  await sleep(300);
  const at = await page.evaluate(() => document.getElementById("transcript")?.scrollTop ?? -1);
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    await sleep(500);
    samples.push(await page.evaluate(() => document.getElementById("transcript")?.scrollTop ?? -1));
  }
  // The parked position counts. A transcript that yanks the reader to the bottom once and then sits
  // there has drifted by the whole height, however still the ten samples afterwards look.
  const all = [at, ...samples];
  const drift = Math.max(...all) - Math.min(...all);
  check(drift <= 4, "the transcript stays where the person left it across 5 s",
    `parked at ${at} of ${parked.height} (viewport ${parked.client}); drift ${drift}px over [${all.join(", ")}]`);
  // How much of a test that was. With no rows arriving this measures only that an idle console does
  // not move the reader; the complaint is about a transcript with rows landing at the SSE cadence,
  // and that needs a working agent, which is a write this leg does not make.
  const grew = await page.evaluate(() => document.querySelectorAll("article.message-row").length);
  info(grew === rowsBefore
    ? `${grew} rows throughout: this is the idle case only. The moving case needs an agent at work, which is a write — run it under builder A's leg with a scratch agent.`
    : `${rowsBefore} rows to ${grew} during the sample, so the drift above was measured with the transcript actually growing`);
  await shoot(page, `scroll-parked-${Date.now()}`);
}

async function legPicker(page) {
  console.log("\n== --picker: no tile-shaped blanks, and the default is the product's own plate");
  const booted = await bootConsole(page);
  if (booted !== true) { skip("the background picker has no blank tiles", "the adapter never appeared"); return; }
  // Waited for, not read once. backgrounds.js is appended by app.js's own onload, so there is a real
  // window in which the adapter exists and the picker's object does not yet -- measured here, where
  // this leg skipped with "not published" on a boot it had passed on a minute earlier. A skip that
  // is not true is worse than a slow leg.
  const opened = await until(() => page.evaluate(() => {
    const list = window.__machineRoomBackgrounds;
    return list ? { defaultChoice: list.DEFAULT_CHOICE ?? null, count: (list.BUILT_IN ?? []).length } : null;
  }), within(20_000), 400);
  if (!opened) { skip("the background picker has no blank tiles", "window.__machineRoomBackgrounds never appeared in 20s"); return; }
  check(opened.defaultChoice === "titan-nebula",
    "a person who never chose a background gets Titan Nebula, not the mountains",
    `DEFAULT_CHOICE=${JSON.stringify(opened.defaultChoice)} across ${opened.count} plates`);

  // The picker is injected into the settings panel the first time it is opened, so a leg that reads
  // the page without opening it measures nothing.
  await page.evaluate(() => (document.getElementById("settings-button") ?? document.getElementById("shelf-settings"))?.click());
  const injected = await until(() => page.$(".bg-grid"), within(15_000), 400);
  if (!injected) { skip("the background picker has no blank tiles", "Settings would not open, or it carries no .bg-grid"); return; }

  // The blank spots: a series heading drawn as a grid item reads as a tile-shaped hole. A heading
  // row spans the whole grid; a tile does not.
  const grid = await page.evaluate(() => {
    const el = document.querySelector(".bg-grid");
    if (!el) return null;
    const width = Math.round(el.getBoundingClientRect().width);
    return [...el.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return {
        tag: child.tagName.toLowerCase(),
        cls: child.className,
        text: (child.textContent ?? "").trim().slice(0, 24),
        w: Math.round(rect.width), h: Math.round(rect.height),
        full: Math.round(rect.width) >= width - 4,
        hasImage: child.querySelector("img") != null || getComputedStyle(child).backgroundImage !== "none",
      };
    });
  });
  if (!grid) { skip("the background picker has no blank tiles", "the picker is not on screen — builder A opens it from Settings"); return; }
  const blanks = grid.filter((cell) => !cell.hasImage && !cell.full && cell.w > 40 && cell.h > 40);
  check(blanks.length === 0, "no series heading is drawn in a tile's box",
    blanks.length === 0 ? `${grid.length} cells, every heading spans the grid` : `${blanks.length} tile-shaped blanks: ${JSON.stringify(blanks).slice(0, 220)}`);
  await shoot(page, `picker-${Date.now()}`);
}

// A leg that measures a thing has to open a conversation that HAS that thing. Taking roster[0] and
// skipping when it comes up empty is how a gate reports "builder B's module has not merged" about a
// module that is loaded and working -- measured on grok-bot-local-vm, where the first agent in
// listAgents has a five-row transcript with no run of system rows in it at all. So these two legs
// walk the roster until the page shows the shape, and say how many they opened before giving up.
async function openFirstWith(page, probe, limit = 12) {
  const roster = await api("listAgents").then((r) => r.value).catch(() => []);
  const workers = (Array.isArray(roster) ? roster : []).filter((a) => !a.isGroup).slice(0, limit);
  const tried = [];
  for (const worker of workers) {
    if (budgetLeft() < 25_000) break;
    if (!(await openConversation(page, worker.id))) { tried.push(worker.name ?? worker.id); continue; }
    await sleep(1400);
    // Twice, with a beat between: a probe that has to open a panel before it can look is asking
    // about the render its own click caused.
    let got = await page.evaluate(probe).catch(() => null);
    if (!got) { await sleep(1200); got = await page.evaluate(probe).catch(() => null); }
    tried.push(worker.name ?? worker.id);
    if (got) return { worker, got, tried };
  }
  return { worker: null, got: null, tried };
}

// ---- --badge (builder B's contract) -------------------------------------------------------------

async function legBadge(page) {
  console.log("\n== --badge: everything between two chat messages folds into one badge that opens again");
  const booted = await bootConsole(page);
  if (booted !== true) { skip("a gap folds into one badge", "the adapter never appeared"); return; }
  const found = await openFirstWith(page, () => (document.querySelector("article.gap-badge[data-gap]") ? true : null));
  if (!found.worker) {
    const loaded = await page.evaluate(() => typeof window.__gapBadge?.render === "function");
    skip("a gap folds into one badge", loaded
      ? `the module is loaded and no conversation on this box has a run of ${await page.evaluate(() => window.__gapBadge?.MIN_FOLD ?? 2)} or more system rows — opened ${found.tried.length}: ${found.tried.slice(0, 6).join(", ")}`
      : "window.__gapBadge is not on the page — the module has not merged");
    return;
  }
  info(`measuring on ${found.worker.name ?? found.worker.id} (${found.tried.length} conversation(s) opened to find a gap)`);
  await sleep(1200);
  const badge = await page.evaluate(() => {
    const el = document.querySelector("article.gap-badge[data-gap]");
    if (!el) return null;
    const head = el.querySelector("button.gap-badge-head[data-gap-toggle]");
    const body = el.querySelector("div.gap-badge-body");
    return {
      steps: el.dataset.gapSteps ?? null,
      open: el.dataset.gapOpen ?? null,
      head: head?.textContent?.trim().slice(0, 80) ?? null,
      expanded: head?.getAttribute("aria-expanded") ?? null,
      live: body?.getAttribute("aria-live") ?? null,
      bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : null,
      rows: document.querySelectorAll("article.message-row").length,
    };
  });
  if (!badge) { skip("a gap folds into one badge", "the badge was there when the conversation opened and is gone now"); return; }
  check(badge.expanded === "false" && badge.bodyHeight === 0, "a gap is one collapsed row by default", `"${badge.head}", ${badge.steps} steps, body ${badge.bodyHeight}px`);
  const target = await hitTest(page, "button.gap-badge-head[data-gap-toggle]");
  check(target.visible && target.hit, "the badge is where a mouse can reach it", `${target.w}x${target.h}, under its centre is ${target.on}${target.scrolled ? " (scrolled to it first, as a person would)" : ""}`);
  await page.click("button.gap-badge-head[data-gap-toggle]", { timeout: 8000 }).catch(() => {});
  const open = await until(() => page.evaluate(() => {
    const el = document.querySelector("article.gap-badge[data-gap]");
    const body = el?.querySelector("div.gap-badge-body");
    const h = body ? Math.round(body.getBoundingClientRect().height) : 0;
    return h > 0 ? { h, receipts: body.querySelectorAll("details.tool-receipt").length } : null;
  }), within(10_000), 300);
  check(open != null, "clicking it opens the rows that were folded", open ? `body ${open.h}px with ${open.receipts} receipt rows inside` : "the body never opened");
  await shoot(page, `badge-open-${Date.now()}`);
  await page.click("button.gap-badge-head[data-gap-toggle]", { timeout: 8000 }).catch(() => {});
  const shut = await until(() => page.evaluate(() => {
    const body = document.querySelector("article.gap-badge[data-gap] div.gap-badge-body");
    return body && Math.round(body.getBoundingClientRect().height) === 0 ? true : null;
  }), within(10_000), 300);
  check(shut === true, "and clicking it again puts them away", shut === true ? "back to one row" : "the body stayed open");
}

// ---- --files (builder D's contract) --------------------------------------------------------------

async function legFiles(page) {
  console.log("\n== --files: a file row opens a viewer and downloads");
  const booted = await bootConsole(page);
  if (booted !== true) { skip("a file row opens a viewer", "the adapter never appeared"); return; }
  // The file rows are drawn in the desktop's Files view, not on the shell -- Jason's own complaint
  // is about clicking Files and finding nothing to open. So the probe opens that view the way he
  // does, through the Agent panel's "Files N" row, and only then looks for rows. Reading a panel is
  // not a write: renderDesktop's files branch draws markup, unlike Browser and Terminal, which
  // mount a live surface. Without this the leg reported "no conversation carries a file" against a
  // console whose Agent panel says Files 1.
  const openFilesView = () => {
    const row = [...document.querySelectorAll('[data-context-action="files"]')][0];
    if (row) row.click();
    return document.querySelector("[data-file-open]") ? true : null;
  };
  const found = await openFirstWith(page, openFilesView);
  if (!found.worker) {
    const loaded = await page.evaluate(() => typeof window.__filesViewer?.open === "function");
    skip("a file row opens a viewer", loaded
      ? `the viewer is loaded and the Files view of every conversation on this box was empty — opened ${found.tried.length}: ${found.tried.slice(0, 6).join(", ")}`
      : "window.__filesViewer is not on the page — the module has not merged");
    return;
  }
  info(`measuring on ${found.worker.name ?? found.worker.id} (${found.tried.length} conversation(s) opened to find a file)`);
  await sleep(1200);
  const rows = await page.evaluate(() => [...document.querySelectorAll("[data-file-open]")].map((el) => ({
    tag: el.tagName.toLowerCase(),
    path: el.dataset.fileOpen ?? "",
    name: el.dataset.fileName ?? "",
    clickable: el.tagName === "BUTTON" || el.tagName === "A",
  })));
  if (rows.length === 0) { skip("a file row opens a viewer", "the rows were there when the conversation opened and are gone now"); return; }
  check(rows.every((r) => r.clickable), `every one of the ${rows.length} file rows is a real control`, rows.map((r) => r.name || r.path).slice(0, 4).join(", "));
  const markdown = rows.find((r) => /\.md$/i.test(r.path)) ?? rows[0];
  await page.click(`[data-file-open="${markdown.path.replaceAll('"', '\\"')}"]`, { timeout: 8000 }).catch(() => {});
  const viewer = await until(() => page.evaluate(() => {
    const el = document.querySelector("[data-file-viewer]");
    if (!el || el.getBoundingClientRect().height === 0) return null;
    return {
      headings: el.querySelectorAll("h1,h2,h3").length,
      lists: el.querySelectorAll("ul,ol").length,
      chars: (el.textContent ?? "").trim().length,
      download: document.querySelector("a.file-download[data-file-download]")?.getAttribute("href") ?? null,
    };
  }), within(20_000), 400);
  check(viewer != null, "the file opens in a viewer", viewer ? `${viewer.chars} characters, ${viewer.headings} headings, ${viewer.lists} lists` : "no [data-file-viewer] appeared");
  if (viewer) {
    check(viewer.download != null, "and every row carries a Download", viewer.download ? `href ${String(viewer.download).slice(0, 60)}` : "no a.file-download[data-file-download]");
    await shoot(page, `files-viewer-${Date.now()}`);
    const url = new URL(String(viewer.download ?? "/files"), ORIGIN);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }).then(async (r) => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength, type: r.headers.get("content-type") ?? "" })).catch((e) => ({ status: 0, bytes: 0, type: String(e.message) }));
    check(res.status === 200 && res.bytes > 0, "the relay's files route hands the bytes back", `${res.status}, ${res.bytes} B, ${res.type}`);
  }
}

// ---- --approval -----------------------------------------------------------------------------
//
// COMMAND-CARD-1. The auto-review card in the shape Jason kept a screenshot of, in three parts, and
// each part says out loud which kind of claim it is, because they are not equally strong.
//
//   1. THE FIVE STATES. The shipped markup, on the shipped stylesheet, in real Chrome, every control
//      hit-tested and the lot screenshot. This is app.js's own decisionMarkup sliced out of the file
//      that ships and run in the page -- not a mock of it -- so the words, the pill, the elision and
//      the buttons are the ones a person gets. What it does NOT prove is that the host ever produces
//      each of those states, which is part 2's job.
//
//   2. ONE REAL APPROVAL, forced on the local box. The box is armed the way scripts/verify-review.mjs
//      proved: SAND_AUTO_REVIEW_MODE=enforce in the box's own settings file (read live per call since
//      REVIEW-1, so nothing restarts) plus one block instruction through setHostSettings. A scratch
//      agent is asked to run one harmless command, the card it raises is read in the browser, Allow is
//      pressed for real and the settled card is read back off the page.
//
//   3. THE TWO CALLS BEHIND ALWAYS ALLOW, made against the live host in the adapter's own order:
//      read the instructions, append the rule, write them back, and only then approve. The host never
//      proposes a rule for a plain echo, so this part exercises the settings half against the real
//      host and then draws the settled card with that rule on the list -- it is not a button press,
//      and it says so.
//
// THE BOX IS PUT BACK IN A FINALLY, always. A leg that dies between arming and restoring leaves every
// other wave's gate on this box looking at a host that blocks every command, so the restore covers the
// settings file, the instructions, any card still pending and the scratch agent.
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const BOX_SETTINGS = "/home/box/sand-data/sand-host-settings.json";
const APPROVAL_BLOCK = "ask me before running any shell command";
const APPROVAL_PROBE = "echo hello-from-command-card";
// A rule nobody would write by hand, so a leftover is recognisable if the restore ever fails.
const APPROVAL_RULE = "Allow the console polish gate's echo probe in the box shell";

const dockerExec = (args) => new Promise((resolve, reject) => execFile(
  "docker", ["exec", BOX, ...args], { maxBuffer: 8 << 20 },
  (error, out) => (error ? reject(new Error(`docker exec ${args[0]}: ${error.message}`)) : resolve(out)),
));
// readSettingsFile (source/host/sand-box-setting.ts) accepts a flat object or { settings: {...} } and
// PREFERS the nested one, so both helpers resolve the container the reader actually consults -- the
// pair scripts/verify-review.mjs proved, and the reason the arming needs no restart. Nothing is read
// into this process but the one key being moved: the file is the operator's.
const settingsContainer = "const c=(d&&typeof d.settings==='object'&&d.settings!=null&&!Array.isArray(d.settings))?d.settings:d;";
const boxSettingsPreamble = `const fs=require('fs');const p=${JSON.stringify(BOX_SETTINGS)};let d={};`
  + `try{const parsed=JSON.parse(fs.readFileSync(p,'utf8'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))d=parsed;}catch{}`;
const readBoxSetting = async (name) => {
  const out = await dockerExec(["node", "-e", `${boxSettingsPreamble}${settingsContainer}`
    + `process.stdout.write(JSON.stringify(c[${JSON.stringify(name)}] ?? null));`]);
  try { return JSON.parse(out); } catch { return null; }
};
const writeBoxSetting = async (name, value) => {
  const mutate = value == null ? `delete c[${JSON.stringify(name)}];` : `c[${JSON.stringify(name)}]=${JSON.stringify(value)};`;
  await dockerExec(["node", "-e", `${boxSettingsPreamble}${settingsContainer}${mutate}`
    + `fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});`]);
};

// The shipped renderer, sliced out of the file that ships. The run of helpers between
// DECISION_ACTIONS and decisionMarkup carries the pill, the elision and the sentence-stripping; the
// drawer itself follows. This is the same slice tests/console-approval-card.test.mjs evaluates, so a
// green unit test and a green browser leg are reading the same bytes.
const approvalRendererSource = () => {
  const app = readModule("app.js");
  if (app == null) return null;
  const from = app.indexOf("  const DECISION_ACTIONS = {");
  const at = app.indexOf("  function decisionMarkup(");
  if (from < 0 || at < 0) return null;
  return `${app.slice(from, at)}\n${app.slice(at, app.indexOf("\n  }\n", at) + 4)}`;
};

const APPROVAL_CASES = [
  {
    label: "pending-rule",
    allow: [],
    card: { status: "pending", rule: "Allow echo commands in the box shell" },
  },
  { label: "pending-no-rule", allow: [], card: { status: "pending", rule: null } },
  {
    label: "always-allowed",
    allow: ["Allow echo commands in the box shell"],
    card: { status: "approved", rule: "Allow echo commands in the box shell" },
  },
  { label: "allowed-once", allow: [], card: { status: "approved", rule: null } },
  { label: "refused", allow: [], card: { status: "denied", rule: null } },
];

async function legApproval(page) {
  console.log("\n== --approval: the auto-review card in the original's shape, and one real forced approval");
  if (READ_ONLY) {
    skip("--approval", "it arms the box's review mode, forces a real approval and presses its buttons; refused against a URL");
    return;
  }
  const source = approvalRendererSource();
  if (source == null) { check(false, "app.js still carries DECISION_ACTIONS and decisionMarkup to slice", "one of the two anchors moved"); return; }
  if (!await bootConsole(page, 60_000)) { check(false, "the console booted", `no adapter at ${ORIGIN} inside the budget`); return; }

  // ---- part 1: the five states, shipped markup on the shipped stylesheet ----------------------
  const drawn = await page.evaluate(({ src, cases, longCommand }) => {
    const escapeHtml = (value) => String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    const build = new Function("escapeHtml", "adapter", "activeContext", "contextName", `${src}\nreturn decisionMarkup;`);
    const draw = build(escapeHtml, { dismissCard() {}, submitSecretRequest() {} }, () => ({ kind: "worker", id: "w-3" }), () => "Titan");
    const host = document.createElement("div");
    host.id = "gate-approval-states";
    host.setAttribute("style", "position:fixed;left:18px;top:18px;width:540px;z-index:999999;display:grid;gap:12px;padding:14px;border-radius:16px;background:rgba(8,14,18,0.92)");
    host.innerHTML = cases.map((one) => {
      const message = {
        id: `e-${one.label}`, type: "decision", authorId: "w-3", authorName: "Titan",
        card: {
          kind: "auto-review", requestId: `r-${one.label}`, surface: "box_shell",
          title: "Echo hello-from-command-card in shell on Grok Bot's computer",
          detail: "", command: one.label === "pending-rule" ? longCommand : "echo hello-from-command-card",
          reason: "Violates the instruction to ask the user before running any shell command.",
          options: [], ...one.card,
        },
      };
      return `<div data-state-case="${one.label}">${draw(message, one.allow)}</div>`;
    }).join("");
    document.body.appendChild(host);
    const read = (label) => {
      const root = host.querySelector(`[data-state-case="${label}"]`);
      const card = root?.querySelector("[data-approval-card]") ?? null;
      if (card == null) return null;
      return {
        text: card.textContent.replace(/\s+/g, " ").trim(),
        commandShown: card.querySelector(".approval-command pre")?.textContent ?? "",
        pill: card.querySelector("[data-approval-pill]")?.textContent ?? "",
        pillColour: card.querySelector("[data-approval-pill]") ? getComputedStyle(card.querySelector("[data-approval-pill]")).color : "",
        where: card.querySelector(".approval-where")?.textContent ?? "",
        request: card.querySelector(".approval-request")?.textContent ?? "",
        rule: card.querySelector(".approval-rule")?.textContent ?? "",
        buttons: [...card.querySelectorAll("[data-decide]")].map((b) => b.getAttribute("data-decide")),
        disclosure: card.querySelector(".approval-command") != null,
        box: `${Math.round(card.getBoundingClientRect().width)}x${Math.round(card.getBoundingClientRect().height)}`,
      };
    };
    return Object.fromEntries(cases.map((one) => [one.label, read(one.label)]));
  }, { src: source, cases: APPROVAL_CASES, longCommand: `echo ${"a".repeat(761)}` });

  const pills = { "pending-rule": "Needs your yes", "pending-no-rule": "Needs your yes", "always-allowed": "Always allowed", "allowed-once": "Allowed once", refused: "Refused" };
  for (const [label, want] of Object.entries(pills)) {
    const got = drawn[label];
    check(got != null && got.pill === want, `the ${label} card's pill reads ${JSON.stringify(want)}`, got == null ? "no card drawn" : `pill ${JSON.stringify(got.pill)}, ${got.box}`);
  }
  check(drawn["pending-rule"]?.buttons?.join(",") === "approved,always,denied",
    "a pending card with a proposed rule offers Allow, Always allow and Refuse",
    `buttons ${JSON.stringify(drawn["pending-rule"]?.buttons ?? null)}`);
  check(drawn["pending-no-rule"]?.buttons?.join(",") === "approved,denied",
    "a pending card with no rule offers no Always allow, because there would be nothing to save",
    `buttons ${JSON.stringify(drawn["pending-no-rule"]?.buttons ?? null)}`);
  check(drawn["always-allowed"]?.rule?.includes("was added to your Auto-review settings") === true,
    "an always-allowed card names the standing rule back to the person",
    JSON.stringify((drawn["always-allowed"]?.rule ?? "").slice(0, 90)));
  check(drawn["allowed-once"]?.rule === "" && drawn["refused"]?.rule === "",
    "a card with no saved rule claims no standing rule");
  for (const label of Object.keys(pills)) {
    check(drawn[label]?.where === "Runs on Titan's computer", `the ${label} card says whose computer it runs on`, JSON.stringify(drawn[label]?.where ?? null));
    check(drawn[label]?.request === "Echo hello-from-command-card in shell",
      `the ${label} card's request sentence has the host's location clause stripped`, JSON.stringify(drawn[label]?.request ?? null));
    check(drawn[label]?.disclosure === true, `the ${label} card keeps the command behind a disclosure`);
  }
  const noOldName = Object.values(drawn).every((one) => one != null && !one.text.includes("Grok Bot"));
  check(noOldName, "the dead upstream's name is on none of the five cards");
  check(drawn["pending-rule"]?.commandShown?.includes("[366 chars omitted]") === true,
    "a 766-character command is elided at 400 and the remainder counted",
    JSON.stringify((drawn["pending-rule"]?.commandShown ?? "").match(/\[[^\]]*omitted[^\]]*\]/)?.[0] ?? null));

  // Every control a person presses, hit-tested where it lands rather than clicked blind.
  for (const [label, decide] of [["pending-rule", "approved"], ["pending-rule", "always"], ["pending-rule", "denied"]]) {
    const hit = await hitTest(page, `#gate-approval-states [data-state-case="${label}"] [data-decide="${decide}"]`);
    check(hit.found && hit.visible && hit.hit, `the ${decide} button is where a mouse can reach it`, `${hit.w}x${hit.h}, under its centre ${hit.on}`);
  }
  const summaryHit = await hitTest(page, `#gate-approval-states [data-state-case="pending-rule"] .approval-command > summary`);
  check(summaryHit.found && summaryHit.visible && summaryHit.hit, "Show the command is a control a person can press", `${summaryHit.w}x${summaryHit.h}, under its centre ${summaryHit.on}`);
  const toggled = await page.evaluate(() => {
    const details = document.querySelector('#gate-approval-states [data-state-case="pending-rule"] .approval-command');
    const shown = () => [...details.querySelectorAll("summary span")].filter((s) => getComputedStyle(s).display !== "none").map((s) => s.textContent);
    const closed = shown();
    details.open = true;
    const open = shown();
    const pre = getComputedStyle(details.querySelector("pre"));
    details.open = false;
    return { closed, open, preWrap: pre.whiteSpace, preMax: pre.maxHeight };
  });
  check(toggled.closed.join("") === "Show the command" && toggled.open.join("") === "Hide the command",
    "the disclosure swaps its own two words with no script behind it", `closed ${JSON.stringify(toggled.closed)}, open ${JSON.stringify(toggled.open)}`);
  info(`the command block wraps (${toggled.preWrap}) and clips at ${toggled.preMax}`);
  info(`the five cards at 1440x1000: ${Object.entries(drawn).map(([k, v]) => `${k} ${v?.box ?? "-"}`).join(", ")}`);
  info(`pending pill colour ${drawn["pending-rule"]?.pillColour}, always-allowed ${drawn["always-allowed"]?.pillColour}, refused ${drawn["refused"]?.pillColour}`);
  await page.evaluate(() => {
    const first = document.querySelector('#gate-approval-states [data-state-case="pending-rule"] .approval-command');
    if (first != null) first.open = true;
  });
  await shoot(page, "approval-states", "#gate-approval-states");
  await page.evaluate(() => document.getElementById("gate-approval-states")?.remove());

  // ---- part 2: one real approval, forced on the local box -------------------------------------
  if (budgetLeft() < 120_000) { skip("a real forced approval on the local box", `${seconds(budgetLeft())} left of ${seconds(RUN_BUDGET_MS)}, and one turn needs about 90s`); return; }

  const beforeMode = await readBoxSetting("SAND_AUTO_REVIEW_MODE");
  const beforeEnforce = await readBoxSetting("SAND_AUTO_REVIEW");
  const beforeTrace = await readBoxSetting("SAND_TOOL_TRACE");
  const liveSettings = await api("getHostSettings").then((r) => r.value).catch(() => null);
  const beforeInstructions = liveSettings?.autoReviewInstructions ?? null;
  let probeId = null;
  let pending = null;
  try {
    if (beforeInstructions == null) { check(false, "the host answered getHostSettings", "no autoReviewInstructions to arm"); return; }
    await writeBoxSetting("SAND_AUTO_REVIEW_MODE", "enforce");
    await writeBoxSetting("SAND_TOOL_TRACE", "1");
    await api("setHostSettings", {
      autoReviewInstructions: {
        isEnabled: true,
        allowInstructions: [...(beforeInstructions.allowInstructions ?? [])],
        blockInstructions: [...new Set([...(beforeInstructions.blockInstructions ?? []), APPROVAL_BLOCK])],
      },
    });
    const armed = await api("getHostSettings").then((r) => r.value?.autoReviewInstructions ?? {});
    check((armed.blockInstructions ?? []).includes(APPROVAL_BLOCK), "the box is armed: the block instruction is stored",
      `isEnabled ${armed.isEnabled}, ${(armed.blockInstructions ?? []).length} block instruction(s)`);

    const created = await api("createAgent", { name: `probe-command-card-${Math.random().toString(36).slice(2, 7)}`, description: "", origin: "user", isKickstartRequested: false });
    probeId = created.value?.agent?.id ?? created.value?.id ?? null;
    if (probeId == null) { check(false, "createAgent returned an agent to prompt", JSON.stringify(created.value).slice(0, 140)); return; }
    info(`scratch agent ${probeId}`);
    await api("sendPrompt", {
      agentId: probeId,
      prompt: `Run exactly this one command in your box shell and then tell me what happened: ${APPROVAL_PROBE}\n`
        + "If Auto-review blocks it, immediately retry the exact same command once with "
        + "request_smart_mode_approval set to true so the approval card reaches me, then stop and wait for my "
        + "answer. Do not run any other command and do not work around the block.",
    });
    const askedAt = Date.now();
    pending = await until(async () => {
      const entries = await api("getAgentTranscript", { id: probeId }).then((r) => r.value).catch(() => []);
      const cards = (Array.isArray(entries) ? entries : [])
        .filter((e) => e.kind === "send-message" && e.message?.type === "auto-review-approval")
        .map((e) => ({ entryId: e.id, ...e.message.approval }));
      return cards.find((c) => c.status === "pending") ?? null;
    }, within(Math.max(0, budgetLeft() - 70_000)), 3000);
    if (pending == null) {
      skip("a real forced approval on the local box", `no pending approval inside ${seconds(Date.now() - askedAt)}; the box's model endpoint may not have taken the turn`);
    } else {
      check(true, "the host raised a real pending approval", `${seconds(Date.now() - askedAt)}, surface ${pending.surface}, command ${JSON.stringify(String(pending.command ?? "").slice(0, 60))}, proposedRule ${pending.proposedRule == null ? "none" : "present"}`);
      // The roster on the page predates this agent, so the page is reloaded rather than waited on.
      await page.reload({ waitUntil: "load", timeout: within(40_000) });
      await until(() => page.evaluate(() => (window.__machineRoomAdapter ? true : null)), within(40_000), 500);
      const opened = await openConversation(page, probeId);
      check(opened, "the console opens the conversation the approval is waiting in");
      const live = await until(() => page.evaluate(() => {
        const card = document.querySelector("#transcript [data-approval-card]");
        if (card == null) return null;
        return {
          state: card.getAttribute("data-approval-state"),
          title: card.querySelector("strong")?.textContent ?? "",
          pill: card.querySelector("[data-approval-pill]")?.textContent ?? "",
          where: card.querySelector(".approval-where")?.textContent ?? "",
          request: card.querySelector(".approval-request")?.textContent ?? "",
          why: card.querySelector(".approval-why")?.textContent ?? "",
          command: card.querySelector(".approval-command pre")?.textContent ?? "",
          buttons: [...card.querySelectorAll("[data-decide]")].map((b) => b.getAttribute("data-decide")),
          needsYou: card.getAttribute("data-needs-you-card"),
          pushTitle: card.getAttribute("data-title"),
          box: `${Math.round(card.getBoundingClientRect().width)}x${Math.round(card.getBoundingClientRect().height)}`,
        };
      }), within(45_000), 900);
      if (live == null) {
        check(false, "the real approval draws the new card in the browser", "no [data-approval-card] in the transcript inside 45s");
      } else {
        check(live.pill === "Needs your yes" && live.state === "pending", "the live card carries the pending pill", `${live.pill}, state ${live.state}, ${live.box}`);
        check(/ wants to run a command$/.test(live.title), "the live card's title names what the agent wants in plain words", JSON.stringify(live.title));
        check(live.where.endsWith("'s computer") || live.where === "Runs on your computer", "the live card says whose computer it runs on", JSON.stringify(live.where));
        check(!live.title.includes("Grok Bot") && !live.request.includes("Grok Bot") && !String(live.pushTitle ?? "").includes("Grok Bot"),
          "the dead upstream's name is on neither the card nor the title a lock screen would get", JSON.stringify(live.pushTitle));
        check(live.command.includes("echo hello-from-command-card"), "the command is readable inside the disclosure", JSON.stringify(live.command.slice(0, 60)));
        check(live.why.length > 0, "the live card says why it is being asked", JSON.stringify(live.why.slice(0, 80)));
        check(live.needsYou != null, "the pending card still carries the needs-you hook the shells read", live.needsYou ?? "absent");
        const hit = await hitTest(page, '#transcript [data-approval-card] [data-decide="approved"]');
        check(hit.found && hit.visible && hit.hit, "Allow is where a mouse can reach it on the live card", `${hit.w}x${hit.h}, under its centre ${hit.on}`);
        // After the hit-test, and after the boot cover has actually gone: the reload above puts the
        // cover back up, it fades over its own few seconds, and a picture taken under it shows the
        // card through a scrim. #boot-cover is removed from the DOM when the console is ready.
        await until(() => page.evaluate(() => (document.getElementById("boot-cover") == null ? true : null)), within(15_000), 300);
        await shoot(page, "approval-live-pending", "#transcript [data-approval-card]");
        info(`the live card today: ${live.box} at 1440x1000, buttons ${JSON.stringify(live.buttons)}`);
        await page.click('#transcript [data-approval-card] [data-decide="approved"]', { timeout: 8000 }).catch(() => {});
        const settled = await until(() => page.evaluate(() => {
          const card = document.querySelector("#transcript [data-approval-card]");
          if (card == null || card.getAttribute("data-approval-state") === "pending") return null;
          return {
            state: card.getAttribute("data-approval-state"),
            pill: card.querySelector("[data-approval-pill]")?.textContent ?? "",
            command: card.querySelector(".approval-command pre")?.textContent ?? "",
            request: card.querySelector(".approval-request")?.textContent ?? "",
            buttons: card.querySelectorAll("[data-decide]").length,
            needsYou: card.getAttribute("data-needs-you-card"),
          };
        }), within(Math.min(45_000, Math.max(0, budgetLeft() - 25_000))), 900);
        if (settled == null) {
          check(false, "pressing Allow settles the card", "the card was still pending when the budget ran out");
        } else {
          await shoot(page, "approval-live-settled", "#transcript [data-approval-card]");
          pending = null;
          check(settled.state === "approved" && settled.pill === "Allowed once",
            "pressing Allow leaves an Allowed once card, because no standing rule decided it", `state ${settled.state}, pill ${JSON.stringify(settled.pill)}`);
          check(settled.command.includes("echo hello-from-command-card") && settled.request.length > 0,
            "the settled card still shows what was allowed, which the old card threw away");
          check(settled.buttons === 0 && settled.needsYou == null, "a settled card offers no buttons and counts on no tray");
        }
      }
    }

    // ---- part 3: the two calls behind Always allow, against the live host --------------------
    if (budgetLeft() < 20_000) { skip("the two calls behind Always allow", `${seconds(budgetLeft())} left`); }
    else {
      const live = await api("getHostSettings").then((r) => r.value?.autoReviewInstructions ?? {});
      const allow = [...new Set([...(live.allowInstructions ?? []), APPROVAL_RULE])];
      await api("setHostSettings", { autoReviewInstructions: { isEnabled: live.isEnabled ?? true, allowInstructions: allow, blockInstructions: live.blockInstructions ?? [] } });
      const after = await api("getHostSettings").then((r) => r.value?.autoReviewInstructions ?? {});
      check((after.allowInstructions ?? []).includes(APPROVAL_RULE),
        "the rule Always allow would write really lands in the host's allowInstructions",
        `${(after.allowInstructions ?? []).length} allow instruction(s) after the write`);
      check((after.blockInstructions ?? []).includes(APPROVAL_BLOCK),
        "and the block list the settings panel owns survived the write, because the instructions were re-read first");
      const named = await page.evaluate(({ src, rule }) => {
        const escapeHtml = (value) => String(value ?? "")
          .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
        const build = new Function("escapeHtml", "adapter", "activeContext", "contextName", `${src}\nreturn decisionMarkup;`);
        const draw = build(escapeHtml, {}, () => ({ kind: "worker", id: "w-3" }), () => "Titan");
        const html = draw({
          id: "e-1", type: "decision", authorId: "w-3", authorName: "Titan",
          card: { kind: "auto-review", requestId: "r-1", surface: "box_shell", status: "approved", title: "Echo hello-from-command-card in shell on Grok Bot's computer", detail: "", command: "echo hello-from-command-card", reason: "", rule, options: [] },
        }, [rule]);
        const host = document.createElement("div");
        host.innerHTML = html;
        return { pill: host.querySelector("[data-approval-pill]")?.textContent ?? "", rule: host.querySelector(".approval-rule")?.textContent ?? "" };
      }, { src: source, rule: APPROVAL_RULE });
      check(named.pill === "Always allowed" && named.rule.includes(APPROVAL_RULE),
        "with that rule on the host's list the card reads Always allowed and quotes the rule", `${JSON.stringify(named.pill)} / ${JSON.stringify(named.rule.slice(0, 90))}`);
      info("part 3 exercised the settings write against the live host, not the button: the host proposes no rule for a plain echo, so there was no live Always-allow card to press");
    }
  } finally {
    // Back the way it was found, in this order: answer anything still pending, put the operator's
    // instructions back, put the two switches back, delete the scratch agent.
    if (pending != null && probeId != null) {
      await api("resolveAutoReviewApproval", { agentId: probeId, entryId: pending.entryId, requestId: pending.requestId, resolution: "denied" }).catch(() => {});
    }
    if (beforeInstructions != null) {
      await api("setHostSettings", { autoReviewInstructions: beforeInstructions }).catch((error) => info(`the instructions were NOT restored: ${error.message}`));
      const back = await api("getHostSettings").then((r) => r.value?.autoReviewInstructions ?? {}).catch(() => ({}));
      check(!(back.blockInstructions ?? []).includes(APPROVAL_BLOCK) && !(back.allowInstructions ?? []).includes(APPROVAL_RULE),
        "the box is back the way it was found: neither the gate's block instruction nor its rule is left behind",
        `${(back.allowInstructions ?? []).length} allow, ${(back.blockInstructions ?? []).length} block`);
    }
    await writeBoxSetting("SAND_AUTO_REVIEW_MODE", beforeMode).catch((error) => info(`SAND_AUTO_REVIEW_MODE was NOT restored: ${error.message}`));
    await writeBoxSetting("SAND_AUTO_REVIEW", beforeEnforce).catch(() => {});
    await writeBoxSetting("SAND_TOOL_TRACE", beforeTrace).catch(() => {});
    const mode = await readBoxSetting("SAND_AUTO_REVIEW_MODE").catch(() => "?");
    check(JSON.stringify(mode) === JSON.stringify(beforeMode), "the box's review mode is back where it started", `now ${JSON.stringify(mode)}, was ${JSON.stringify(beforeMode)}`);
    if (probeId != null) {
      await api("deleteAgents", { ids: [probeId] }).catch(() => api("deleteAgent", { id: probeId }).catch(() => {}));
      const gone = (await api("listAgents").then((r) => r.value).catch(() => [])).every((a) => a.id !== probeId);
      check(gone, "the scratch agent is gone from the roster");
    }
  }
}

// ---- the run --------------------------------------------------------------------------------------

const RUNNER = { boot: legBoot, scroll: legScroll, picker: legPicker, badge: legBadge, tile: legTile, files: legFiles, approval: legApproval };

try {
  console.log(`console-polish: ${chosen.join(", ")} against ${ORIGIN}${READ_ONLY ? " (read-only)" : ""}`);
  if (READ_ONLY && !BEARER) info("CONSOLE_BEARER is not set; a console behind a login will bounce every request to /login");
  if (!READ_ONLY) {
    // The gates share the local box. Held for the whole run rather than per leg, because a leg that
    // opens the desktop view and a leg from another wave prompting an agent cannot both be right.
    releaseLock = await acquireBoxLock({ what: `verify-console-polish ${chosen.join("+")}`, waitMs: within(120_000), pollMs: 5000, log: info });
  }
  browser = await chromium.launch({ executablePath: CHROME, headless: !flag("headed") });
  for (const leg of chosen) {
    if (budgetLeft() <= 10_000) { skip(`--${leg}`, `out of budget: ${seconds(budgetLeft())} left of ${seconds(RUN_BUDGET_MS)}`); continue; }
    const page = await newPage();
    try { await RUNNER[leg](page); }
    catch (error) { check(false, `--${leg} ran to the end`, error.message.slice(0, 200)); }
    finally { await page.context().close().catch(() => {}); }
  }
} catch (error) {
  check(false, "the gate ran", error.message.slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  releaseLock?.();
}

if (errors.length) info(`page errors during the run: ${errors.slice(0, 3).join(" | ").slice(0, 300)}`);
console.log("\nscreenshots:");
for (const file of shots) console.log(`  ${file}`);
console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped`);
writeFileSync(path.join(SHOTS, "last-run.json"), JSON.stringify({ at: new Date().toISOString(), origin: ORIGIN, legs: chosen, passes, failures, skips, shots }, null, 2));
process.exit(failures > 0 ? 1 : 0);
