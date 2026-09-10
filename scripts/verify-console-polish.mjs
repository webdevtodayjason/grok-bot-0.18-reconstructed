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
// And one from 2026-09-10, which is SCREEN-TILE-1:
//
//   "the AI's desktop in the right-hand corner has a screenshot that does not stay up to
//    date. It gets recorded once and stays that way. It never updates."                  --tile-live
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
//   A CADENCE MEASURED THROUGH app.js's OWN RENDER LOOP IS NOT A CADENCE. renderBoxHandoffSurfaces
//   calls window.__screenTile.sync on every heartbeat with the record's REAL status, and that
//   retimes the reader underneath any probe holding it at another one -- measured while building
//   this leg: a reader forced to the live cadence came back at the warm-up one seconds later. So
//   --tile-live pins the state the module is driven with for the length of a measurement and puts
//   it back afterwards, and says in its own output that the cadence was forced. The local box's
//   model endpoint does not take turns (docs/APPS.md), so a forced cadence is the strongest claim
//   this machine can make; the real-turn proof belongs on the R750 demo tenant.
//
//   WEBSOCKET BYTES ARE INVISIBLE TO scripts/verify-cost.mjs. That gate sums Network.dataReceived,
//   which is HTTP only, so the whole cost of the tile's reader is uncounted anywhere else. This one
//   counts Network.webSocketFrameReceived and prints it against the same ceilings docs/APPS.md set.
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
//   node scripts/verify-console-polish.mjs --tile-live       the tile keeps up, and what that costs
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { acquireBoxLock } from "./lib/box-lock.mjs";
import { gateUserAgent } from "./gate-agent.mjs";

const LEGS = ["boot", "scroll", "picker", "badge", "tile", "tile-live", "files"];
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

const URL_TARGET = value("url");
const READ_ONLY = URL_TARGET != null || flag("read-only");
const chosen = flag("all") ? [...LEGS] : LEGS.filter((leg) => flag(leg));
if (chosen.length === 0) {
  console.log("usage: node scripts/verify-console-polish.mjs (--boot | --scroll | --picker | --badge | --tile | --tile-live | --files | --all)");
  console.log("       [--url https://console.titanium.bot]   read-only pass, CONSOLE_BEARER in the environment");
  console.log("");
  console.log("  --boot    the chosen background is on the page before first paint, and the cover lifts");
  console.log("  --scroll  the transcript settles once and stays where the person left it");
  console.log("  --picker  the background picker has no tile-shaped blanks and defaults to Titan Nebula");
  console.log("  --badge   everything between two chat messages folds into one badge that opens again");
  console.log("  --tile    the rail's screen tile shows a picture or a plate, and never a broken image");
  console.log("  --tile-live  the tile follows the agent's screen on its own, and what that costs");
  console.log("  --files   a file row opens a viewer and downloads");
  process.exit(2);
}

const ORIGIN = URL_TARGET ?? process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BEARER = process.env.CONSOLE_BEARER ?? "";
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? new URL("../.cache/playwright", import.meta.url).pathname;
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.GROK_BOT_SHOT_DIR ?? "/tmp/console-polish-shots";
// The standing rule: every gate says who it is. This file sent nothing until SCREEN-TILE-1, which
// is why a refused sign-in from it read on the admin panel as a stranger rather than as our own
// gate spending the throttle on purpose (cp/admin.mjs matches on the prefix, at the start).
const GATE_AGENT = gateUserAgent(import.meta.url);
// The box whose screen this gate drives. Only --tile-live uses it, and only off the local box.
const BOX = process.env.GROK_BOT_BOX ?? "grok-bot-local-vm";
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
const shoot = async (page, name) => {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  shots.push(file);
  return file;
};

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

// ---- the seats on this box --------------------------------------------------------------------

// Who has a screen of their own and who is on the shared one, asked of the host one agent at a time
// and bounded, so a leg runs against a real seat rather than against a guess. Both tile legs use it.
async function seatsOnThisBox(reserveMs = 60_000) {
  const roster = await api("listAgents").then((r) => r.value).catch(() => null);
  const workers = (Array.isArray(roster) ? roster : []).filter((a) => !a.isGroup);
  const seats = [];
  let shared = null;
  for (const worker of workers.slice(0, 12)) {
    if (budgetLeft() < reserveMs) break;
    const status = await api("getForeverBoxStatus", { id: worker.id }).then((r) => r.value).catch(() => null);
    if (!status) continue;
    const seat = status.boxSeat;
    if (typeof seat === "number" && seat > 1) seats.push({ ...worker, seat, vncUrl: status.vncUrl ?? null });
    else if (!shared && seat === null) shared = { ...worker, seat: null };
  }
  // EVERY seated candidate, not the first one. The gates share this box and other waves leave probe
  // agents on it; the first seated agent was one of those on a run of --tile-live, and its display
  // never painted a frame, so the whole leg skipped on an unhealthy seat rather than measuring a
  // healthy one. `seated` stays the first for the legs that only need one.
  return { workers, seats, seated: seats[0] ?? null, shared };
}

// ---- --tile ---------------------------------------------------------------------------------------

async function legTile(page) {
  console.log("\n== --tile: the rail's screen tile shows a picture or a plate, never a broken image");

  // 1. THE ARGUMENT SHAPE. Asserted rather than trusted, because a probe that gets it wrong reports
  //    "this host cannot say which screen this agent is on" for every agent on a healthy box.
  const { workers, seated, shared } = await seatsOnThisBox();
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

  // 2. WHO IS ON WHICH SCREEN, from seatsOnThisBox above.
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

// ---- --tile-live ------------------------------------------------------------------------------
//
// SCREEN-TILE-1. Jason, 2026-09-10 10:55: "the AI's desktop in the right-hand corner has a
// screenshot that does not stay up to date. It gets recorded once and stays that way. It never
// updates. For instance, Titan was on a different web page, but when I looked at it on my desktop, I
// saw the original web page it loaded with."
//
// So this leg drives the box's own browser to one page, waits for the tile, drives it to a second,
// and asserts the tile follows WITH NO CLICK. Then it prices it: websocket bytes per working minute
// against the 600 KiB ceiling, per idle minute against the 100 KiB one, for one whole page change,
// and with the tab hidden. Those bytes are uncounted anywhere else -- scripts/verify-cost.mjs sums
// Network.dataReceived, which is HTTP only.

// The box's own browser, driven the way an agent drives it. box-chrome is the box's launcher: it
// derives the display from DISPLAY, uses the profile the computer-use tooling expects and opens the
// CDP port the agent drives it through. Argv straight through docker exec and never a shell, so the
// URL is never interpolated into a command line.
const boxChrome = (display, url) => new Promise((resolve) => {
  execFile("docker", ["exec", "-e", `DISPLAY=:${display}`, BOX, "box-chrome", url], { timeout: 25_000 }, (error) => resolve(error == null));
});

// Websocket bytes, which is the whole cost of this tile and is invisible to every other gate.
// Binary frames arrive base64-encoded over CDP; a text frame is the string itself.
async function websocketMeter(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  let bytes = 0;
  let frames = 0;
  const onFrame = ({ response }) => {
    const payload = String(response?.payloadData ?? "");
    bytes += response?.opcode === 1 ? Buffer.byteLength(payload, "utf8") : Buffer.from(payload, "base64").length;
    frames += 1;
  };
  cdp.on("Network.webSocketFrameReceived", onFrame);
  return {
    reset() { bytes = 0; frames = 0; },
    read() { return { bytes, frames, kib: bytes / 1024 }; },
    async stop() { cdp.off("Network.webSocketFrameReceived", onFrame); await cdp.detach().catch(() => {}); },
  };
}

// PIN THE STATE THE MODULE IS DRIVEN WITH. app.js calls sync on every heartbeat with the record's
// real status, which retimes the reader underneath any probe -- measured while building this leg.
// So sync is wrapped for the length of a measurement and the held state is what every caller gets,
// app.js's own renders included. `visible` is deliberately left undefined so the module reads
// document.visibilityState itself, which is what the hidden-tab measurement needs.
const holdTile = (page, held) => page.evaluate((h) => {
  const tile = window.__screenTile;
  if (!tile.__gateRealSync) tile.__gateRealSync = tile.sync;
  window.__gateTileHold = h;
  tile.sync = () => tile.__gateRealSync({ ...window.__gateTileHold });
  return true;
}, held);

const releaseTile = (page) => page.evaluate(() => {
  const tile = window.__screenTile;
  if (tile?.__gateRealSync) { tile.sync = tile.__gateRealSync; delete tile.__gateRealSync; }
  if (window.__gateTileBeat) { clearInterval(window.__gateTileBeat); delete window.__gateTileBeat; }
  if (window.__gateMountWatch) { clearInterval(window.__gateMountWatch); delete window.__gateMountWatch; }
  delete window.__gateTileHold;
  delete window.__gateMounts;
});

// A beat of its own, so the held state is asserted whether or not app.js happens to render.
const beatTile = (page, ms = 1000) => page.evaluate((every) => {
  if (window.__gateTileBeat) clearInterval(window.__gateTileBeat);
  window.__gateTileBeat = setInterval(() => { try { window.__screenTile.sync(); } catch { /* the page is going away */ } }, every);
}, ms);

// Count mounts rather than infer them, and record how much of the window a client was up for. A
// mount-grab-release cadence is 0 -> 1 -> 0 on this attribute a couple of times a minute; a HELD
// client is 1 for the whole window. The duty cycle is the difference, and it is what "it holds no
// client in between" actually means -- sampling the count at one instant fails the moment the window
// ends mid-grab, which it did on the first run of this leg.
const watchMounts = (page) => page.evaluate(() => {
  window.__gateMounts = 0;
  window.__gateSamples = 0;
  window.__gateUp = 0;
  let was = document.querySelectorAll("iframe[data-screen-tile-source]").length;
  if (window.__gateMountWatch) clearInterval(window.__gateMountWatch);
  window.__gateMountWatch = setInterval(() => {
    const n = document.querySelectorAll("iframe[data-screen-tile-source]").length;
    if (n > was) window.__gateMounts += 1;
    window.__gateSamples += 1;
    if (n > 0) window.__gateUp += 1;
    was = n;
  }, 200);
});

const readMounts = (page) => page.evaluate(() => ({
  mounts: window.__gateMounts ?? 0,
  samples: window.__gateSamples ?? 0,
  up: window.__gateUp ?? 0,
}));

// "as of 3 s ago" -> 3. Minutes and hours answer in seconds, so one number can be compared.
const ageSeconds = (words) => {
  const text = String(words ?? "");
  const m = text.match(/as of (\d+) (s|min|h) ago/);
  if (m) return Number(m[1]) * (m[2] === "s" ? 1 : m[2] === "min" ? 60 : 3600);
  if (/as of a minute ago/.test(text)) return 60;
  if (/as of an hour ago/.test(text)) return 3600;
  return null;
};

async function legTileLive(page) {
  console.log("\n== --tile-live: the tile keeps up with the agent on its own, and what that costs");
  if (READ_ONLY) {
    skip("the tile follows the agent's screen", "read-only pass: this leg drives a real box's browser and holds a reader on a real seat");
    return;
  }

  const { workers, seats } = await seatsOnThisBox(150_000);
  if (seats.length === 0) {
    skip("the tile follows the agent's screen", `no agent on this box has a seat of its own (${workers.length} workers, all boxSeat null or absent)`);
    return;
  }

  const booted = await bootConsole(page);
  check(booted === true, "the console boots and the gateway adapter is on the page", booted === true ? "window.__machineRoomAdapter present" : "no adapter");
  if (booted !== true) return;
  const hasModule = await page.evaluate(() => typeof window.__screenTile?.sync === "function");
  if (!hasModule) { skip("the tile follows the agent's screen", "window.__screenTile is not on this page; the relay is serving a console without screen-tile.js"); return; }

  const meter = await websocketMeter(page);
  // THE TILE HAS TO BE SHOWING THIS AGENT, AND THE SEAT HAS TO ANSWER, or nothing below means
  // anything. screen-tile.js refuses to paint into a tile carrying another agent's id, so a leg
  // measuring agent A while the console has agent B open reads a stamp that moves and a picture that
  // never changes. Both were measured while building this leg: Playwright's element click on a roster
  // card silently did not take (so the card is also clicked in the page, and the tile's own
  // data-agent-id is what gets asserted), and the first seated agent on this box was another wave's
  // leftover probe whose display never painted anything (so every seated candidate is tried in turn
  // rather than the first one being trusted).
  let seated = null;
  let firstFrame = null;
  const tried = [];
  for (const candidate of seats) {
    if (budgetLeft() < 120_000) break;
    let opened = await openConversation(page, candidate.id);
    if (!opened) {
      opened = await page.evaluate((id) => {
        const card = document.querySelector(`.worker-card[data-context-id="${id}"]`);
        if (!card) return false;
        card.click();
        return true;
      }, candidate.id);
      await sleep(2500);
    }
    const showing = await until(() => page.evaluate((id) => (document.querySelector(".rail-screen-button")?.dataset.agentId === id ? true : null), candidate.id), within(12_000), 500);
    if (showing !== true) { tried.push(`${candidate.name} (:${candidate.seat}, its conversation would not open)`); continue; }
    await holdTile(page, { agentId: candidate.id, seat: candidate.seat, status: "working" });
    await beatTile(page, 1000);
    // A cache-buster on both pages, so the box really navigates rather than raising a tab a previous
    // run of this gate already rendered — measured once at 0.0 KiB and 1.38 s, which is a window
    // raise and not a page load, and reads as a much cheaper change than one actually costs.
    await boxChrome(candidate.seat, `https://example.com/?titanbot-gate=${Date.now()}`);
    const frame = await until(() => page.evaluate((id) => {
      const got = window.__screenTile.frameFor(id);
      return got && got.length > 2048 ? got : null;
    }, candidate.id), within(25_000), 400);
    if (!frame) { tried.push(`${candidate.name} (:${candidate.seat}, no frame in 25 s)`); await releaseTile(page); continue; }
    seated = candidate;
    firstFrame = frame;
    break;
  }
  if (!seated) {
    check(false, "a seated agent on this box paints a frame into its tile",
      `${seats.length} seated agent(s), none painted: ${tried.join("; ") || "none reached"}`);
    await meter.stop();
    return;
  }
  check(true, "the rail tile on screen belongs to the agent this leg measures, and its seat answers",
    `#rail-screen carries ${seated.name}'s id, :${seated.seat}, first frame ${firstFrame.length} characters${tried.length ? ` (skipped ${tried.length}: ${tried.join("; ")})` : ""}`);

  const held = { agentId: seated.id, seat: seated.seat, status: "working" };
  try {
    // 1. THE CADENCE THE MODULE PUBLISHES, read off state() rather than trusted: what a probe passed
    //    in and what the module did with it are two different things, and the display it settled on
    //    has to be the seat this agent is actually sitting on.
    const live = await until(() => page.evaluate((want) => {
      const s = window.__screenTile.state();
      return s.live && s.display === want ? s : null;
    }, seated.seat), within(15_000), 300);
    check(live != null, "a working agent holds a reader at the live cadence, on its own seat",
      live ? `every ${live.everyMs} ms on :${live.display}, held` : `the module never reported a held reader on :${seated.seat}`);
    await shoot(page, `tile-live-page-one-${Date.now()}`);

    // 3. PAGE TWO, AND THE WHOLE CLAIM. No click anywhere between here and the assertion.
    //
    //    THE SCREEN HAS TO BE SETTLED FIRST or "the frame changed" means nothing: a held client
    //    re-encodes every 3 s, and a caret blinking in a URL bar changes the bytes on its own. Two
    //    reads four seconds apart that come back identical are what make the change attributable to
    //    the page. Whether it settled is printed either way rather than quietly assumed.
    const frameNow = () => page.evaluate((id) => window.__screenTile.frameFor(id), seated.id);
    const settleA = await frameNow();
    await sleep(4000);
    const settleB = await frameNow();
    const settled = settleA === settleB && settleB.length > 2048;
    info(`before the second page the screen was ${settled ? "settled" : "STILL MOVING"} — two reads 4 s apart, ${settleA.length} then ${settleB.length} characters`);
    meter.reset();
    const askedAt = Date.now();
    const secondUrl = `https://en.wikipedia.org/wiki/Titanium?titanbot-gate=${Date.now()}`;
    const pageTwo = await boxChrome(seated.seat, secondUrl);
    // THE CLOCK STARTS WHEN THE LAUNCHER RETURNS, not when this gate reached for docker. `docker
    // exec` from macOS into the box is this gate's own instrumentation -- an agent on the box calls
    // box-chrome directly and pays none of it -- and it measured 1 to 3 s on this Mac, which is most
    // of the difference between a 3 s reading and a 6 s one. Both numbers are printed.
    const changedAt = Date.now();
    check(pageTwo, "and then a second page", `box-chrome — en.wikipedia.org/wiki/Titanium, cache-busted so it is a real load; the launcher itself took ${((changedAt - askedAt) / 1000).toFixed(2)}s of docker exec`);
    const moved = await until(() => page.evaluate((args) => {
      const got = window.__screenTile.frameFor(args.id);
      return got && got !== args.was ? { len: got.length } : null;
    }, { id: seated.id, was: settleB }), within(20_000), 250);
    const followedMs = Date.now() - changedAt;
    // The LATENCY is measured above; the COST needs three more seconds of meter. CDP delivers
    // websocket frame events in batches, and a 1.4 s window read 0 bytes on this Mac while the
    // minute straight after it read 101.8 KiB — a short window under-counts rather than measuring a
    // cheap change. So the tile's own latency claim and the byte claim have different windows, and
    // the output says so.
    await sleep(3000);
    const changeCost = meter.read();
    check(moved != null && followedMs <= 5000,
      "the tile shows the second page within five seconds, with no click",
      moved
        ? `${(followedMs / 1000).toFixed(2)}s from the launcher returning (${((Date.now() - askedAt - 3000) / 1000).toFixed(2)}s counting this gate's own docker exec) to a ${moved.len}-character frame · ${changeCost.kib.toFixed(1)} KiB over the change and the 3 s after it · the screen was ${settled ? "settled beforehand, so the change is the page" : "still moving beforehand, so read the latency as an upper bound"}`
        : `the frame never changed inside 20 s (${changeCost.kib.toFixed(1)} KiB read)`);
    info(`one whole page change cost ${changeCost.kib.toFixed(1)} KiB over ${changeCost.frames} websocket frames on grok-bot-local-vm, counted across the change and the 3 s that follow it`);
    await shoot(page, `tile-live-page-two-${Date.now()}`);

    // 4. THE CAPTION. How old the picture is, in words, on the picture.
    const caption = await until(() => page.evaluate(() => {
      const note = document.querySelector("#rail-screen [data-rail-screen-age]");
      if (!note) return null;
      const rect = note.getBoundingClientRect();
      return { words: (note.textContent ?? "").trim(), w: Math.round(rect.width), h: Math.round(rect.height) };
    }), within(8000), 300);
    const said = caption ? ageSeconds(caption.words) : null;
    check(caption != null && said != null && said < 35,
      "the tile says how old the picture is, and it is fresh",
      caption ? `"${caption.words}" in a ${caption.w}x${caption.h} chip — ${said} s` : "no [data-rail-screen-age] on the tile");

    // 5. THE WORKING MINUTE, against the 600 KiB ceiling docs/APPS.md set and has never exercised.
    if (budgetLeft() > 110_000) {
      meter.reset();
      await sleep(60_000);
      const working = meter.read();
      check(working.kib < 600, "a working minute of the live tile is inside the 600 KiB working ceiling",
        `${working.kib.toFixed(1)} KiB over ${working.frames} frames on grok-bot-local-vm at 1440x1000, forced cadence (the local box's model endpoint does not take turns)`);
    } else {
      skip("a working minute of the live tile is inside the 600 KiB working ceiling", `out of budget: ${seconds(budgetLeft())} left`);
    }

    // 6. THE IDLE MINUTE. Mount, grab, release, twice in sixty seconds.
    if (budgetLeft() > 80_000) {
      await page.evaluate(() => window.__screenTile.teardown());
      await holdTile(page, { agentId: seated.id, seat: seated.seat, status: "idle" });
      await watchMounts(page);
      meter.reset();
      const before = await page.evaluate(() => window.__screenTile.state().capturedAt);
      await sleep(60_000);
      const idle = meter.read();
      const watched = await readMounts(page);
      const mounts = watched.mounts;
      const after = await page.evaluate(() => window.__screenTile.state().capturedAt);
      const duty = watched.samples > 0 ? watched.up / watched.samples : 1;
      // WHAT IS ASSERTED HERE AND WHAT IS ONLY PRINTED. A byte threshold on an idle grab would be a
      // gate that passes or fails on somebody's wallpaper: one grab is a whole framebuffer, and it
      // measured 17.5 KiB over a settled desktop and 75.0 KiB over a photo-heavy page on this same
      // box within the hour. So the ASSERTION is the design property the code actually controls --
      // it goes back for a new picture on its own, and it holds no client between grabs -- and the
      // cost is printed with the machine it was measured on and what the ceiling it is compared
      // against actually is. docs/APPS.md's 100 KiB idle ceiling is decoded API bytes at PHONE
      // width and excludes noVNC by name as COST-2; the rail tile does not exist at phone width,
      // where the rails are drawers, and the leg below proves it costs zero there.
      const perMount = mounts > 0 ? idle.kib / mounts : idle.kib;
      check(mounts >= 1 && after != null && before != null && after > before && duty < 0.25,
        "the idle tile goes back for a new picture on its own and holds no client in between",
        `${mounts} mount(s) in 60 s with no render asking for one, the picture's stamp moved ${(((after ?? 0) - (before ?? 0)) / 1000).toFixed(1)}s forward, a client was up for ${(duty * 100).toFixed(0)}% of the window (a held one would be 100%)`);
      info(`the idle minute cost ${idle.kib.toFixed(1)} KiB over ${idle.frames} websocket frames, ${perMount.toFixed(1)} KiB a grab, on grok-bot-local-vm at 1440x1000. At the steady two grabs a minute that is ${(perMount * 2).toFixed(1)} KiB; with the adapter's own measured 56.1 KiB idle minute (docs/APPS.md) ${(perMount * 2 + 56.1).toFixed(1)} KiB all in. A grab is a whole framebuffer and costs whatever is on the screen: 17.5 KiB over a settled desktop, 51.9 KiB at the client's default quality, 75.0 KiB over a photo-heavy page. The 100 KiB idle ceiling is API bytes at phone width and excludes noVNC by name (COST-2); the lever for this number is the cadence.`);
    } else {
      skip("the idle tile goes back for a new picture on its own and holds no client in between", `out of budget: ${seconds(budgetLeft())} left`);
    }

    // 6b. THE PHONE, WHERE THAT CEILING ACTUALLY LIVES. At 390x844 the rails are drawers, so the
    //     tile is laid out at zero size and the module must not open a websocket for a picture
    //     nobody can see. Measured rather than reasoned: the viewport really is moved.
    if (budgetLeft() > 30_000) {
      await page.setViewportSize({ width: 390, height: 844 });
      // The rail is held live here so the test is the strongest one available: a working agent at
      // desktop width holds a client continuously, so any moment with no client at phone width is
      // the drawer and nothing else.
      await holdTile(page, held);
      await beatTile(page, 1000);
      await sleep(2500);
      const box = await page.evaluate(() => {
        const b = document.querySelector(".rail-screen-button");
        if (!b) return { present: false, w: 0, h: 0, painted: null };
        const r = b.getBoundingClientRect();
        return {
          present: true, w: Math.round(r.width), h: Math.round(r.height),
          // The measured trap: the closed drawer is `visibility: hidden` and translated off the
          // right edge, so the BOX is still a healthy 274x172 and only this answers honestly.
          painted: typeof b.checkVisibility === "function" ? b.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : null,
        };
      });
      meter.reset();
      await sleep(8000);
      const phone = meter.read();
      const phoneReaders = await page.evaluate(() => document.querySelectorAll("iframe[data-screen-tile-source]").length);
      check(box.painted === false && phone.bytes === 0 && phoneReaders === 0,
        "at phone width the rail is a closed drawer, so a working agent's tile costs nothing",
        `the tile's box still measures ${box.w}x${box.h} and the browser says painted=${box.painted}; ${phone.bytes} B over 8 s, ${phoneReaders} reader(s) — held live throughout, which at 1440x1000 is a client up 100% of the time`);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await sleep(2500);
      const backOnDesktop = await until(() => page.evaluate(() => (document.querySelectorAll("iframe[data-screen-tile-source]").length > 0 ? true : null)), within(15_000), 500);
      check(backOnDesktop === true, "and opening the console back up to desktop width starts it reading again", backOnDesktop === true ? "a reader is up within 15 s of the rail coming back" : "no reader came back");
    } else {
      skip("at phone width the tile is in a closed drawer and costs nothing", `out of budget: ${seconds(budgetLeft())} left`);
    }

    // 7. A HIDDEN TAB COSTS NOTHING. Real if the browser will hide the page for us, faked on the
    //    signal the module actually reads if it will not, and the output says which.
    const other = await page.context().newPage().catch(() => null);
    let hiddenFor = "bringToFront on a second page";
    if (other) { await other.bringToFront().catch(() => {}); }
    let hidden = await page.evaluate(() => document.visibilityState === "hidden");
    if (!hidden) {
      hiddenFor = "document.visibilityState forced, which is the signal the module reads";
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      hidden = await page.evaluate(() => document.visibilityState === "hidden");
    } else {
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    meter.reset();
    await sleep(10_000);
    const dark = meter.read();
    const readers = await page.evaluate(() => document.querySelectorAll("iframe[data-screen-tile-source]").length);
    check(hidden && dark.bytes === 0 && readers === 0,
      "a hidden tab holds no reader and costs no bytes",
      `${dark.bytes} B over 10 s, ${readers} reader(s) — hidden by ${hiddenFor}`);

    // 8. AND COMING BACK PAINTS A FRESH ONE.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await other?.close().catch(() => {});
    const stale = await page.evaluate(() => window.__screenTile.state().capturedAt);
    await holdTile(page, held);
    await beatTile(page, 1000);
    const back = await until(() => page.evaluate((was) => {
      const at = window.__screenTile.state().capturedAt;
      return at != null && at > was ? at : null;
    }, stale ?? 0), within(30_000), 500);
    check(back != null, "and coming back paints a fresh frame", back != null ? `the stamp moved ${(((back ?? 0) - (stale ?? 0)) / 1000).toFixed(1)}s forward` : "no new frame inside 30 s");
    await shoot(page, `tile-live-back-${Date.now()}`);
  } finally {
    await releaseTile(page).catch(() => {});
    await page.evaluate(() => window.__screenTile?.teardown?.()).catch(() => {});
    await meter.stop();
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

// ---- the run --------------------------------------------------------------------------------------

const RUNNER = { boot: legBoot, scroll: legScroll, picker: legPicker, badge: legBadge, tile: legTile, "tile-live": legTileLive, files: legFiles };

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
