#!/usr/bin/env node
// verify-console-flicker.mjs -- CONSOLE-6 and COMPOSER-1, in a real browser.
//
// Jason, on console.titanium.bot in Chrome on his Mac, 2026-09-11 12:02 to 12:32 CDT:
//
//   "The entire page flickers when I am typing in the bot. Also when it flickers I lose where my
//    cursor is, so I have to target the field again to continue typing."             --typing
//
//   inside the first-run Meet Titan window, "only the text chat area is flashing, refreshing
//    every 3 seconds or so."                                                         --modal
//
//   the composer's corners are a pill, and pasted or wrapped text sits in an oval.   --corners
//
// WHAT EACH LEG IS ALLOWED TO CLAIM
//
//   --typing is the whole complaint, measured the way he made it: the caret goes into the message
//   box and stays there while a person types for fifteen seconds. A MutationObserver over the
//   whole document counts, per node, how many times the composer, the message box itself, the
//   transcript container and the direct children of <body> are TAKEN OUT of the document, and a
//   focusout listener on the box records every time the caret leaves it and what took it. The
//   characters typed and the characters that landed are both printed: a run where focus went and
//   the keystrokes went with it reads as a short value, which is the thing Jason actually loses.
//
//   A REPLACEMENT IS A REMOVAL, NOT A REPAINT. Counting mutation RECORDS would count the age
//   caption on the screen tile, which rewrites one string a second on purpose and moves nothing.
//   This counts removals of the four nodes a person is using, which is what a lost caret is made
//   of, plus every <iframe> added or removed, because an off-screen VNC reader taking the keyboard
//   and being handed it back leaves the caret on <body> rather than back in the box.
//
//   --modal fakes ONE gateway command and nothing else: getOnboardingState answers done:false, so
//   the console's own boot path opens the real first-run dialog against the live box. Everything
//   in it -- the roster, the transcript, the adapter, the poll -- is the product. The leg then
//   watches the dialog's own chat container for fifteen seconds and counts how many times its
//   children are replaced wholesale. The local box reports done:true (measured 2026-09-11), so
//   this is the only way to see that dialog here without writing to the box's setup record.
//
//   --corners measures the composer's border radius and box at 1440x900 and 390x844, empty and
//   with four lines of text in it, and hit-tests Talk and Send at both. A radius at or above half
//   the box's height is a pill whatever the number says, so the leg prints both and judges on the
//   ratio as well as the pixels.
//
// USAGE
//   node scripts/verify-console-flicker.mjs --typing
//   node scripts/verify-console-flicker.mjs --modal
//   node scripts/verify-console-flicker.mjs --corners
//   node scripts/verify-console-flicker.mjs --all
//   node scripts/verify-console-flicker.mjs --typing --url https://console.titanium.bot
//
// In --url mode nothing is created and nothing is sent: the leg types into the box and never
// presses Send. CONSOLE_BEARER is read from the environment, sent as an Authorization header, and
// never printed. A tenant console asks for a sign-in rather than a bearer: set GATE_EMAIL and
// GATE_PASSWORD for a throwaway customer minted outside this file, which is what the R750 leg uses.
// Neither is printed, and with neither set the run opens the local relay the way it always has.
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { gateUserAgent } from "./gate-agent.mjs";

const LEGS = ["typing", "modal", "corners"];
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

const URL_TARGET = value("url");
const chosen = flag("all") ? [...LEGS] : LEGS.filter((leg) => flag(leg));
if (chosen.length === 0) {
  console.log("usage: node scripts/verify-console-flicker.mjs (--typing | --modal | --corners | --all) [--url https://console.titanium.bot]");
  console.log("  --typing   fifteen seconds of typing: the caret stays in the box and every character lands");
  console.log("  --modal    the first-run dialog's chat area is not rebuilt under the person");
  console.log("  --corners  the composer is a rounded rectangle at both widths, empty and four lines deep");
  process.exit(2);
}

const ORIGIN = URL_TARGET ?? process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const BEARER = process.env.CONSOLE_BEARER ?? "";
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? new URL("../.cache/playwright", import.meta.url).pathname;
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.GROK_BOT_SHOT_DIR ?? "/tmp/console-flicker-shots";
const GATE_AGENT = gateUserAgent(import.meta.url);
// Fifteen seconds is Jason's own run length. The whole file sits inside the 300 s these gates hold to.
const TYPE_MS = Number(process.env.GROK_BOT_FLICKER_TYPE_MS ?? 15_000);
const RUN_BUDGET_MS = Number(process.env.GROK_BOT_FLICKER_BUDGET_MS ?? 270_000);
const deadline = Date.now() + RUN_BUDGET_MS;
const budgetLeft = () => deadline - Date.now();
const within = (ms) => Math.max(0, Math.min(ms, budgetLeft()));

let passes = 0;
let failures = 0;
let skips = 0;
const check = (ok, label, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (ok) passes += 1; else failures += 1; };
const skip = (label, why) => { console.log(`  SKIP  ${label} — ${why}`); skips += 1; };
const info = (line) => console.log(`  INFO  ${line}`);
const step = (line) => console.log(`\n${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOTS, { recursive: true });
const shots = [];
const shoot = async (page, name) => {
  const file = path.join(SHOTS, `${name}.png`);
  rmSync(file, { force: true });
  await page.screenshot({ path: file }).catch(() => {});
  shots.push(file);
  return file;
};

const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
const authHeaders = BEARER ? { authorization: `Bearer ${BEARER}` } : {};
let browser = null;
const errors = [];

async function newPage({ w = 1440, h = 900 } = {}) {
  const context = await browser.newContext({
    viewport: { width: w, height: h },
    userAgent: GATE_AGENT,
    extraHTTPHeaders: authHeaders,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e).split("\n")[0]));
  return page;
}

// The live console is a tenant's, behind its own door, so a run against console.titanium.bot signs
// in as a throwaway customer first. The password is read from the environment, added to nothing that
// is printed, and the account is minted and removed by the operator outside this file. With no
// credentials in the environment this is a no-op and the local relay opens as it always has.
const EMAIL = process.env.GATE_EMAIL ?? "";
const PASSWORD = process.env.GATE_PASSWORD ?? "";
const signIn = async (page, ms = 60_000) => {
  if (!EMAIL || !PASSWORD) return false;
  await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded", timeout: within(ms) });
  await page.fill('input[type="email"], input[name="email"]', EMAIL).catch(() => {});
  await page.fill('input[type="password"]', PASSWORD).catch(() => {});
  await page.press('input[type="password"]', "Enter").catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return true;
};

const boot = async (page, ms = 60_000) => {
  const signedIn = await signIn(page, ms);
  if (!signedIn) await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: within(ms) });
  return await page.waitForFunction(() => window.__machineRoomAdapter != null, null, { timeout: within(ms) })
    .then(() => true).catch(() => false);
};

// ---- the watcher, installed in the page before anything is typed -------------------------------
//
// One observer over the whole document, childList and subtree. Every removed node is tested
// against the four things a person is using, and every added or removed <iframe> is counted on its
// own, because that is how an off-screen screen reader announces itself.
const INSTALL_WATCH = () => {
  const seen = {
    composerForm: 0, messageBox: 0, transcriptBox: 0, bodyChild: 0,
    iframeAdded: 0, iframeRemoved: 0, records: 0,
    focusOuts: [], activeTrail: [],
  };
  const box = () => document.getElementById("message-input");
  const form = () => document.getElementById("composer");
  const transcript = () => document.getElementById("transcript");
  const holds = (node, target) => node instanceof Element && target != null && (node === target || node.contains(target));
  const observer = new MutationObserver((records) => {
    seen.records += records.length;
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (holds(node, form())) seen.composerForm += 1;
        if (holds(node, box())) seen.messageBox += 1;
        if (holds(node, transcript())) seen.transcriptBox += 1;
        // The two off-screen readers are children of <body> by design and are meant to come and go
        // (screen-tile.js mount/teardown), so they are counted as readers and not as the page being
        // rebuilt under the person.
        const reader = node.getAttribute?.("data-screen-tile-source") != null
          || node.getAttribute?.("data-box-handoff-thumb-source") != null;
        if (record.target === document.body && !reader) seen.bodyChild += 1;
        if (node.tagName === "IFRAME" || node.querySelector?.("iframe")) seen.iframeRemoved += 1;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.tagName === "IFRAME" || node.querySelector?.("iframe")) seen.iframeAdded += 1;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // The composer's node is not replaced when the caret is merely taken away, so the caret is
  // watched on its own: what took it, and at what second of the run.
  const started = Date.now();
  const nameOf = (el) => {
    if (el == null) return "nothing";
    const tag = el.tagName ? el.tagName.toLowerCase() : String(el.nodeName).toLowerCase();
    return `${tag}${el.id ? `#${el.id}` : ""}${el.getAttribute?.("data-screen-tile-source") != null ? "[reader]" : ""}`;
  };
  document.addEventListener("focusout", (event) => {
    if (event.target !== box()) return;
    // The element that has it a tick later, which is what the person is left with.
    const to = nameOf(event.relatedTarget);
    setTimeout(() => {
      seen.focusOuts.push({ at: Date.now() - started, to, landedOn: nameOf(document.activeElement) });
    }, 0);
  }, true);
  // A sample of where the caret is, four times a second, so a steal that is handed back between
  // two keystrokes still shows up as a moment the box did not have it.
  const sampler = setInterval(() => {
    const where = nameOf(document.activeElement);
    const last = seen.activeTrail[seen.activeTrail.length - 1];
    if (!last || last.where !== where) seen.activeTrail.push({ at: Date.now() - started, where });
  }, 250);
  window.__flickerWatch = {
    read: () => ({ ...seen, tile: (() => { try { return window.__screenTile?.state?.() ?? null; } catch { return null; } })() }),
    stop: () => { try { observer.disconnect(); } catch { /* gone */ } clearInterval(sampler); },
  };
};

// ---- --typing ------------------------------------------------------------------------------------

async function typingLeg() {
  step(`the typing run: fifteen seconds in the message box on ${ORIGIN}`);
  const page = await newPage({ w: 1440, h: 900 });
  const live = await boot(page);
  if (!live) { skip("the typing run", "the console never published its adapter"); await page.context().close(); return; }
  // A conversation open, so the stage is the one a person actually types into. The first roster
  // card is whatever this box leads with; nothing is created.
  await page.waitForSelector("#message-input", { timeout: within(30_000) }).catch(() => {});
  const card = page.locator("#worker-stack [data-worker-id], #worker-stack .worker-card").first();
  if (await card.count().catch(() => 0)) await card.click({ timeout: 5000 }).catch(() => {});
  await sleep(2500);

  await page.evaluate(INSTALL_WATCH);
  await page.click("#message-input", { timeout: 10_000 }).catch(() => {});
  const startedFocused = await page.evaluate(() => document.activeElement === document.getElementById("message-input"));
  check(startedFocused, "the caret is in the message box when the run starts");

  // A person's pace, not a robot's: a character every 400 ms, for Jason's own fifteen seconds and
  // then on until the screen tile's off-screen reader has mounted at least once. That second half is
  // not padding: the reader's idle wake is 30 s out (screen-tile.js IDLE_REFRESH_MS), it takes the
  // keyboard about a second after it connects, and handing it back used to leave the caret on <body>
  // -- so a run that stops at fifteen seconds never sees the half of this complaint that swallows
  // the keystrokes. The run is capped, and what it actually covered is printed.
  const every = 400;
  const line = "the quick brown fox jumps over the lazy dog and keeps on typing";
  const CEILING_MS = Number(process.env.GROK_BOT_FLICKER_CEILING_MS ?? 78_000);
  const startedAt = Date.now();
  // How many times a reader had already taken the keyboard and been handed it back before the run.
  // The run carries on until that number MOVES, because that is the moment this row is about: a
  // steal that was handed back to <body> is what swallowed Jason's typing, and a run that never saw
  // one has not measured the hand-back at all.
  const handBacksAtStart = await page.evaluate(() => { try { return window.__screenTile.state().handBacks; } catch { return null; } });
  let typed = 0;
  let atFifteen = null;
  for (;;) {
    await page.keyboard.type(line[typed % line.length]);
    typed += 1;
    await sleep(every);
    const elapsed = Date.now() - startedAt;
    if (atFifteen == null && elapsed >= TYPE_MS) {
      atFifteen = await page.evaluate(() => {
        const seen = window.__flickerWatch.read();
        const box = document.getElementById("message-input");
        return { typed: box ? box.value.length : 0, focusOuts: seen.focusOuts.length, bodyChild: seen.bodyChild, records: seen.records, focused: document.activeElement === box };
      });
      info(`at ${(TYPE_MS / 1000).toFixed(0)}s: ${atFifteen.typed} character(s) in the box, ${atFifteen.records} mutation record(s), ${atFifteen.focusOuts} caret departure(s), caret in the box: ${atFifteen.focused}`);
    }
    const now = await page.evaluate(() => {
      const seen = window.__flickerWatch.read();
      return { mounted: seen.iframeAdded > 0, handBacks: seen.tile ? seen.tile.handBacks : null };
    });
    const handedBack = handBacksAtStart != null && now.handBacks != null && now.handBacks > handBacksAtStart;
    if (elapsed >= TYPE_MS && now.mounted && handedBack) break;
    if (elapsed >= CEILING_MS || budgetLeft() < 45_000) {
      if (!now.mounted) info(`no off-screen reader mounted inside ${(elapsed / 1000).toFixed(0)}s, so this run did not measure the hand-back`);
      else if (!handedBack) info(`a reader mounted but never took the keyboard inside ${(elapsed / 1000).toFixed(0)}s, so this run did not measure the hand-back`);
      break;
    }
  }
  const handBacksAtEnd = await page.evaluate(() => { try { return window.__screenTile.state().handBacks; } catch { return null; } });
  const provedHandBack = handBacksAtStart != null && handBacksAtEnd != null && handBacksAtEnd > handBacksAtStart;
  info(`the off-screen reader took the keyboard and was handed it back ${handBacksAtStart} time(s) before the run and ${handBacksAtEnd} time(s) by the end of it`);
  const elapsedMs = Date.now() - startedAt;
  info(`the run lasted ${(elapsedMs / 1000).toFixed(1)}s`);
  const read = await page.evaluate(() => {
    const box = document.getElementById("message-input");
    const seen = window.__flickerWatch.read();
    window.__flickerWatch.stop();
    return { ...seen, landed: box ? box.value.length : 0, endsFocused: document.activeElement === box };
  });

  info(`typed ${typed} character(s); ${read.landed} landed in the box`);
  info(`mutation records seen: ${read.records}; off-screen readers mounted ${read.iframeAdded}, taken down ${read.iframeRemoved}`);
  info(`screen tile: ${read.tile ? `mounted=${read.tile.mounted} live=${read.tile.live} every=${read.tile.everyMs}ms handBacks=${read.tile.handBacks}` : "no module on the page"}`);
  if (read.focusOuts.length) for (const out of read.focusOuts) info(`the caret left the box at ${(out.at / 1000).toFixed(1)}s, to ${out.to}, and landed on ${out.landedOn}`);
  if (read.activeTrail.length > 1) info(`where the caret was: ${read.activeTrail.map((t) => `${(t.at / 1000).toFixed(1)}s ${t.where}`).join(" → ")}`);

  // The flicker itself, as a rate. A console with nobody but the typist on it writes the screen
  // tile's age caption once a second and whatever voice.js paints beside it, which measured 6 records
  // a second on grok-bot-local-vm; the repaint loop this row closed measured 211. The ceiling is set
  // well above the honest traffic and a long way below the loop, so it fails on a loop and not on a
  // module that paints a string.
  const perSecond = read.records / (elapsedMs / 1000);
  info(`${perSecond.toFixed(1)} mutation record(s) a second across the run`);
  check(perSecond <= 20, "the page is not being repainted on a loop while a person types", `${perSecond.toFixed(1)} record(s) a second`);
  check(read.composerForm === 0, "the composer form is never taken out of the document", `${read.composerForm} removal(s)`);
  check(read.messageBox === 0, "the message box itself is never replaced", `${read.messageBox} removal(s)`);
  check(read.bodyChild === 0, "no direct child of <body> is replaced while a person types", `${read.bodyChild} removal(s)`);
  // WHY THIS IS "COMES BACK" AND NOT "NEVER LEAVES". The off-screen reader's noVNC client focuses a
  // canvas inside its OWN document, and nothing the parent page can do stops that -- screen-tile.js
  // records that `inert` on the frame does not, and a pointerdown inside an iframe is not visible out
  // here at all. So the keyboard does leave the box for the part of a second before the hand-back
  // sees it. What a person can tell the difference between is where it lands: back in the box they
  // were typing in, or on <body>, where the rest of what they type goes nowhere.
  const strays = read.focusOuts.filter((out) => out.landedOn !== "textarea#message-input");
  check(strays.length === 0, "every time the caret left the message box it was put straight back", strays.length ? strays.map((out) => `${(out.at / 1000).toFixed(1)}s → ${out.landedOn}`).join("; ") : `${read.focusOuts.length} departure(s), all of them returned`);
  check(read.endsFocused, "the caret is still in the message box at the end of the run");
  check(read.landed === typed, "every character typed landed in the box", `${read.landed} of ${typed}`);
  if (provedHandBack) check(strays.length === 0 && read.landed === typed, "the caret was put back in the box after the off-screen reader took the keyboard", `${handBacksAtEnd - handBacksAtStart} hand-back(s) during the run`);
  else skip("the caret is put back after the off-screen reader takes the keyboard", "no reader took the keyboard inside the run, so there was nothing to hand back");
  // The transcript is redrawn by design when a message arrives; it is counted and printed rather
  // than failed, because a transcript that grew is not a flicker.
  info(`the transcript container was rebuilt ${read.transcriptBox} time(s) during the run`);

  await shoot(page, "typing-run");
  await page.context().close();
}

// ---- --modal ---------------------------------------------------------------------------------------

async function modalLeg() {
  step("the first-run dialog: its chat area, watched for fifteen seconds");
  const page = await newPage({ w: 1440, h: 900 });
  // The one fake. Everything else on this page is the live box.
  let asked = 0;
  await page.route("**/api/getOnboardingState", async (route) => {
    asked += 1;
    const res = await route.fetch().catch(() => null);
    let body = {};
    if (res) { try { body = await res.json(); } catch { body = {}; } }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...body, done: false, doneReason: null, completedAt: null }),
    });
  });
  const live = await boot(page);
  if (!live) { skip("the first-run dialog", "the console never published its adapter"); await page.context().close(); return; }
  const opened = await page.waitForSelector("#onboarding-dialog[open]", { timeout: within(30_000) }).then(() => true).catch(() => false);
  if (!opened) { skip("the first-run dialog", "the dialog did not open even with the box reporting done:false"); await page.context().close(); return; }
  info(`getOnboardingState was answered done:false ${asked} time(s) so far`);
  await sleep(1500);

  const watch = await page.evaluate(() => {
    const box = document.getElementById("onboarding-transcript");
    if (!box) return null;
    const seen = { rebuilds: 0, removed: 0, added: 0, at: [] };
    const started = Date.now();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target !== box) continue;
        seen.removed += record.removedNodes.length;
        seen.added += record.addedNodes.length;
        if (record.removedNodes.length > 0) { seen.rebuilds += 1; seen.at.push(Math.round(Date.now() - started)); }
      }
    });
    observer.observe(box, { childList: true, subtree: false });
    window.__modalWatch = { read: () => ({ ...seen }), stop: () => observer.disconnect() };
    return true;
  });
  if (!watch) { skip("the first-run dialog", "the dialog has no #onboarding-transcript to watch"); await page.context().close(); return; }

  // Something in it, so a rebuild has a draft to destroy as well as rows to replace.
  await page.fill("#onboarding-input", "half an answer").catch(() => {});
  await page.click("#onboarding-input").catch(() => {});
  await sleep(within(TYPE_MS));
  const read = await page.evaluate(() => {
    const seen = window.__modalWatch.read();
    window.__modalWatch.stop();
    const input = document.getElementById("onboarding-input");
    return { ...seen, draft: input ? input.value : "", focused: document.activeElement === input };
  });

  info(`the chat area's children were replaced ${read.rebuilds} time(s) in ${(TYPE_MS / 1000).toFixed(0)}s (${read.removed} node(s) out, ${read.added} in)`);
  if (read.at.length) info(`at ${read.at.map((ms) => `${(ms / 1000).toFixed(1)}s`).join(", ")}`);
  check(read.rebuilds === 0, "the first-run chat area is not rebuilt while nothing in it has changed", `${read.rebuilds} rebuild(s)`);
  check(read.draft === "half an answer", "a half-typed answer survives the dialog's own poll", `"${read.draft}"`);
  check(read.focused, "the caret stays in the dialog's answer box");
  await shoot(page, "first-run-dialog");
  await page.context().close();
}

// ---- --corners -------------------------------------------------------------------------------------

const READ_COMPOSER = () => {
  const form = document.getElementById("composer");
  const box = document.getElementById("message-input");
  const talk = document.getElementById("voice-talk");
  const send = document.querySelector("#composer .send-button");
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const radiusOf = (el) => {
    if (!el) return null;
    const style = getComputedStyle(el);
    return ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"]
      .map((key) => Math.round(Number.parseFloat(style[key]) || 0));
  };
  const hit = (el) => {
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { found: true, hit: false };
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { found: true, hit: at != null && (at === el || el.contains(at) || at.contains(el)), w: Math.round(r.width), h: Math.round(r.height) };
  };
  // The line box is read rather than assumed: the phone rules set line-height 22px against the
  // desktop's 20px, so a count divided by a hard 20 reads eight lines as nine.
  const line = box ? (Number.parseFloat(getComputedStyle(box).lineHeight) || 20) : 20;
  const cap = box ? Number.parseFloat(getComputedStyle(box).maxHeight) : Number.NaN;
  return {
    form: rect(form), box: rect(box), talk: hit(talk), send: hit(send),
    radius: radiusOf(form),
    line,
    lines: box ? Math.round(box.getBoundingClientRect().height / line) : 0,
    capLines: Number.isFinite(cap) ? Math.round(cap / line) : null,
  };
};

async function cornersLeg() {
  step("the composer's corners and box, empty and four lines deep");
  const four = "line one of a pasted answer\nline two of a pasted answer\nline three of a pasted answer\nline four of a pasted answer";
  for (const size of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
    const name = `${size.w}x${size.h}`;
    const page = await newPage(size);
    const live = await boot(page);
    if (!live) { skip(`the composer at ${name}`, "the console never published its adapter"); await page.context().close(); continue; }
    await page.waitForSelector("#composer", { timeout: within(20_000) }).catch(() => {});
    await sleep(1500);
    const empty = await page.evaluate(READ_COMPOSER);
    // Typed rather than assigned, so autosizeComposer runs the way it does under a person.
    await page.click("#message-input").catch(() => {});
    await page.evaluate((text) => {
      const box = document.getElementById("message-input");
      box.value = text;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }, four);
    await sleep(400);
    const filled = await page.evaluate(READ_COMPOSER);

    const r = empty.radius ?? [];
    const half = empty.form ? empty.form.h / 2 : 0;
    const pill = r.some((corner) => corner >= half - 1);
    info(`${name} empty: form ${empty.form?.w}x${empty.form?.h} at y${empty.form?.y}, radius ${r.join("/")}px (half its height is ${half.toFixed(0)}px)`);
    info(`${name} four lines: form ${filled.form?.w}x${filled.form?.h}, message box ${filled.box?.w}x${filled.box?.h} (${filled.lines} line(s) of ${filled.line}px, the box stops at ${filled.capLines ?? "?"}), radius ${(filled.radius ?? []).join("/")}px`);
    check(!pill, `the composer is a rounded rectangle at ${name}, not a pill`, `radius ${r.join("/")}px against a ${empty.form?.h}px box`);
    check(r.every((corner) => corner >= 10 && corner <= 18), `every corner is about 14px at ${name}`, `${r.join("/")}px`);
    check((filled.radius ?? []).every((corner) => corner >= 10 && corner <= 18), `the corners hold at ${name} with four lines in the box`, `${(filled.radius ?? []).join("/")}px`);
    check(filled.lines >= 4, `the message box grows to four lines at ${name}`, `${filled.lines} line(s)`);
    check(filled.talk.hit === true, `Talk is still reachable at ${name} with four lines in the box`, `${filled.talk.w}x${filled.talk.h}`);
    check(filled.send.hit === true, `Send is still reachable at ${name} with four lines in the box`, `${filled.send.w}x${filled.send.h}`);
    check(empty.talk.w === filled.talk.w && empty.talk.h === filled.talk.h, `Talk does not change size at ${name}`, `${empty.talk.w}x${empty.talk.h} → ${filled.talk.w}x${filled.talk.h}`);
    check(empty.send.w === filled.send.w && empty.send.h === filled.send.h, `Send does not change size at ${name}`, `${empty.send.w}x${empty.send.h} → ${filled.send.w}x${filled.send.h}`);
    await shoot(page, `composer-${name}`);
    await page.context().close();
  }
}

// ---- the run ----------------------------------------------------------------------------------------

(async () => {
  console.log(`verify-console-flicker — ${chosen.join(", ")} against ${ORIGIN}`);
  browser = await chromium.launch({ executablePath: CHROME, headless: !flag("headed") });
  try {
    if (chosen.includes("typing")) await typingLeg();
    if (chosen.includes("modal")) await modalLeg();
    if (chosen.includes("corners")) await cornersLeg();
  } finally {
    await browser.close().catch(() => {});
  }
  if (errors.length) { step("page errors"); for (const e of new Set(errors)) info(e); }
  if (shots.length) { step("screenshots"); for (const s of shots) info(s); }
  console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
