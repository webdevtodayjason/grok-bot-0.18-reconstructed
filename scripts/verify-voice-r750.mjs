#!/usr/bin/env node
// VOICE-7 on the LIVE SERVER, through console.titanium.bot, as a throwaway customer.
//
// WHY THIS IS ITS OWN SCRIPT and not a leg of scripts/verify-voice.mjs. Every leg in that file builds
// its own control plane, relay and stub on loopback and drives grok-bot-local-vm. This one drives
// nothing: it signs in to the real console over the internet and presses what a customer presses. It
// needs no ports, no stub and no profile, and it must never be able to start a service.
//
//   GATE_EMAIL / GATE_PASSWORD   a throwaway customer, minted inside the control plane container on
//                                the demo tenant and removed afterwards. Never Jason's account.
//   PW                           the directory holding node_modules/playwright-core.
//   SHOTS                        where the screenshots go.
//   CONSOLE_BASE                 defaults to https://console.titanium.bot.
//
// WHAT IT CAN AND CANNOT SHOW. A workspace with talking switched off and no operator key cannot open a
// line, so what is measurable here is the Talk mode row and its round trip, the panel being mounted
// over the conversation, the button behaving per mode for the instant before the refusal lands, and
// the footer. Whether a held line carries audio, and what the panel paints while somebody speaks, is
// measured against the stub on the local box by `verify-voice.mjs --leg overlay` and `--leg frames`.
//
// MEASURED, R750 through console.titanium.bot, 2026-09-10: 1440x900 and 390x844 with a real touch
// hold, a throwaway customer on the demo tenant.
//
// What it measures, at 1440x900 and at 390x844 with touch:
//   1. The Talk mode row is under General > System, opens on the mode the page is in, and the
//      choice round-trips and survives a reload of the page.
//   2. The talk button behaves per mode: a click is the toggle in always-listening and is NOT in
//      push-to-talk, where a press and hold is.
//   3. The footer's shelf, composer and talk button rects are identical before, during and after.
//   4. Whether a realtime key exists at all, which decides whether a real spoken turn is possible.
//
// Nothing here writes to the box. It signs in as a customer and presses what a customer presses.
const { chromium } = await import(`${process.env.PW}/node_modules/playwright-core/index.mjs`);
import { mkdirSync } from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import path from "node:path";
// SIGNIN-1. This gate signs in at a real front door on a real server, so it says its own name there:
// the Sign-in attempts panel could not otherwise tell it from a stranger. A hint, never a credential.
import { gateUserAgent } from "./gate-agent.mjs";

const BASE = process.env.CONSOLE_BASE ?? "https://console.titanium.bot";
const EMAIL = process.env.GATE_EMAIL;
const PASSWORD = process.env.GATE_PASSWORD;
const SHOTS = process.env.SHOTS;
const GATE_AGENT = gateUserAgent(import.meta.url);
mkdirSync(SHOTS, { recursive: true });

let pass = 0; let fail = 0;
const ok = (what, detail = "") => { pass += 1; console.log(`  PASS  ${what}${detail ? `  (${detail})` : ""}`); };
const no = (what, detail = "") => { fail += 1; console.log(`  FAIL  ${what}${detail ? `  (${detail})` : ""}`); };
const check = (good, what, detail = "") => (good ? ok(what, detail) : no(what, detail));
const info = (line) => console.log(`  INFO  ${line}`);
const step = (what) => console.log(`\n== ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// VOICE-13 moved the second one. At 390x844 a press of Talk is now a CALL SCREEN rather than a hold, so
// a row that held the button there would be measuring a behaviour the product no longer has. 740x900 is
// still under the refusal line's 900 px shelf home and over the 690 px call width, so everything these
// rows measure still applies. The phone is measured by the call-screen section at the foot of this file.
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, hasTouch: false },
  { name: "narrow", width: 740, height: 900, hasTouch: true },
];

// Every rect that VOICE-6 measured, read in one go so nothing can move between two reads.
const rects = (page) => page.evaluate(() => {
  const r = (sel) => {
    const node = document.querySelector(sel);
    if (node == null) return null;
    const b = node.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) };
  };
  return {
    shelf: r(".control-shelf"), composer: r("#composer"), talk: r("[data-voice-talk]"),
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    // WHETHER A SENTENCE IS STANDING, because that is a different claim from the panel's.
    note: (window.__voice?.stats?.().notes ?? []).length > 0,
    panelUp: document.getElementById("voice-overlay")?.hidden === false,
  };
});

/**
 * WHAT VOICE-7 CLAIMS, exactly, and what it does not.
 *
 * The panel may never change the footer, at any width: it is a child of the conversation area and not
 * of the row the message box lives in. THE LINE is a different thing and belongs to VOICE-6: on a
 * phone one plain sentence takes a row of the shelf by that wave's own design, measured by it on this
 * same box as 133 -> 189 px with the composer unmoved. So a footer read while a sentence is standing
 * is compared the way VOICE-6 measured it -- the composer and the button must not move -- and a footer
 * read with no sentence up must be identical to the pixel.
 */
/** Two rects, byte for byte. Hoisted because the reply leg below reads it too. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const footerHeld = (before, now, what) => {
  if (!now.note) {
    check(same(now.shelf, before.shelf) && same(now.composer, before.composer) && same(now.talk, before.talk),
      `THE FOOTER DID NOT MOVE ${what}`,
      `shelf ${JSON.stringify(now.shelf)} composer ${JSON.stringify(now.composer)} talk ${JSON.stringify(now.talk)}`);
    return;
  }
  check(same(now.composer, before.composer) && same(now.talk, before.talk),
    `the composer and the talk button did not move ${what}, with one sentence standing`,
    `composer ${JSON.stringify(now.composer)} talk ${JSON.stringify(now.talk)}`);
  if (!same(now.shelf, before.shelf)) {
    info(`the shelf took a row for that sentence: ${JSON.stringify(before.shelf)} -> ${JSON.stringify(now.shelf)}. That is VOICE-6's own shipped line, which it measured on this box as 133 -> 189 px on a phone with the composer unmoved, and not this wave's panel -- which was ${now.panelUp ? "up" : "not up"} at that moment.`);
  }
};

// Chrome is left to playwright the way every other gate in this tree leaves it: an executablePath
// guessed from /Applications is one OS upgrade away from a gate that cannot run.
const browser = await chromium.launch({
  ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
  headless: true,
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required"],
});

try {
  for (const v of VIEWPORTS) {
    step(`${v.name} ${v.width}x${v.height}${v.hasTouch ? " with touch" : ""} on the R750 through console.titanium.bot`);
    const context = await browser.newContext({
      userAgent: GATE_AGENT, permissions: ["microphone"],
      viewport: { width: v.width, height: v.height }, hasTouch: v.hasTouch, isMobile: v.hasTouch,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // The customer's own sign-in: an email and a password, the way the onboarding wave left it.
    await page.fill('input[type="email"], input[name="email"]', EMAIL).catch(() => {});
    await page.fill('input[type="password"]', PASSWORD).catch(() => {});
    await page.press('input[type="password"]', "Enter").catch(() => {});
    await page.waitForLoadState("domcontentloaded");
    const landed = await page.waitForFunction(() => window.__voice !== undefined, null, { timeout: 60_000 })
      .then(() => true).catch(() => false);
    check(landed, "a throwaway customer signs in and the console's talking module is loaded",
      landed ? "" : `still at ${page.url()}`);
    // THE CONSOLE IS NOT READY WHEN voice.js IS, and asking too early is a measurement bug that reads
    // exactly like a missing feature. The settings surface opens through the console's own panel host,
    // which app.js hangs on the window later in its boot; measured on the R750 2026-09-10, a run that
    // asked before that existed got `false` from open() and reported no rows on a console that has
    // them. So the readiness signal is the host itself.
    const hostReady = await page.waitForFunction(() => typeof window.__mrUi?.openPanel === "function",
      null, { timeout: 60_000 }).then(() => true).catch(() => false);
    check(hostReady, "and the console's own panel host has finished booting", hostReady ? "" : "no __mrUi.openPanel after 60 s");
    if (!landed) {
      await page.screenshot({ path: path.join(SHOTS, `r750-${v.name}-signin-failed.png`) });
      await context.close();
      continue;
    }
    // Any first-run dialog is cleared the way a person would, so Escape and clicks reach the page.
    await page.evaluate(() => { for (const d of document.querySelectorAll("dialog[open]")) { try { d.close(); } catch { /* not ours */ } } });
    await page.waitForSelector("[data-voice-talk]", { timeout: 30_000 }).catch(() => {});

    // ---- the panel is mounted over the conversation and not in the footer ----------------------
    const where = await page.evaluate(() => {
      const node = document.getElementById("voice-overlay");
      return {
        mounted: node != null,
        inConversation: node?.closest(".conversation-space") != null,
        inShelf: node?.closest(".control-shelf") != null,
        hidden: node?.hidden !== false,
      };
    });
    check(where.mounted && where.inConversation && !where.inShelf,
      "the speech panel is on the page, over the conversation and outside the footer", JSON.stringify(where));
    check(where.hidden, "and it is away before anybody talks");

    const before = await rects(page);
    info(`footer before: shelf ${JSON.stringify(before.shelf)} composer ${JSON.stringify(before.composer)} talk ${JSON.stringify(before.talk)}`);

    // ---- the Talk mode row, under General > System ---------------------------------------------
    const opened = await page.evaluate(() => window.__mrSettings?.open?.("general", "talk-mode") ?? false);
    await page.waitForFunction(() => document.querySelector('[data-setting-row="talk-mode"] select') != null,
      null, { timeout: 30_000 }).catch(() => {});
    const row = await page.evaluate(() => {
      const host = document.querySelector('[data-setting-row="talk-mode"]');
      const field = host?.querySelector("select");
      if (field == null) return null;
      const b = field.getBoundingClientRect();
      return {
        value: field.value,
        choices: [...field.options].map((o) => o.textContent.replace(/\s+/g, " ").trim()),
        section: host.closest("[data-settings-section]")?.getAttribute("data-settings-section") ?? "",
        visible: b.width > 0 && b.height > 0, width: Math.round(b.width),
        mode: window.__voice.talkMode(),
      };
    });
    check(row != null && row.visible, "the Talk mode row is on screen in Settings", JSON.stringify(row));
    check(row?.section === "general", "under General, beside the microphone and the talking switch", row?.section);
    check(row != null && row.value === row.mode && typeof row.mode === "string" && row.mode.length > 0,
      "opening it shows the mode this page is really in", `${row?.value} / ${row?.mode}`);
    check((row?.choices ?? []).length === 2, "with exactly the two ways to talk", JSON.stringify(row?.choices));
    await page.screenshot({ path: path.join(SHOTS, `r750-${v.name}-talk-mode-row.png`) });

    // THE ROUND TRIP, through the real control, and then across a reload.
    const other = row?.value === "push" ? "always" : "push";
    await page.selectOption('[data-setting-row="talk-mode"] select', other).catch(() => {});
    await page.waitForFunction((want) => window.__voice?.talkMode?.() === want, other, { timeout: 15_000 }).catch(() => {});
    const took = await page.evaluate(() => ({ mode: window.__voice.talkMode(), field: document.querySelector('[data-setting-row="talk-mode"] select')?.value ?? "" }));
    check(took.mode === other && took.field === other, "choosing the other one takes", JSON.stringify(took));

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__voice !== undefined, null, { timeout: 60_000 }).catch(() => {});
    const survived = await page.evaluate(() => window.__voice.talkMode());
    check(survived === other, "and it is still there after a reload of the console", `${survived} after choosing ${other}`);
    await page.evaluate(() => { for (const d of document.querySelectorAll("dialog[open]")) { try { d.close(); } catch { /* not ours */ } } });

    // ---- the button behaves per mode -----------------------------------------------------------
    // ALWAYS LISTENING: a click is the press. PUSH TO TALK: a click is not, a hold is.
    await page.evaluate(() => window.__voice.setTalkMode("push"));
    const talkBox = await page.locator("[data-voice-talk]").boundingBox().catch(() => null);
    check(talkBox != null, "the talk button has a box a finger could land on", JSON.stringify(talkBox));
    if (talkBox != null) {
      const cx = Math.round(talkBox.x + talkBox.width / 2);
      const cy = Math.round(talkBox.y + talkBox.height / 2);
      // WHAT A FINGER WOULD ACTUALLY LAND ON at that point. A rect is not reachability: the console
      // draws an opaque cover while it boots, and a press at raw coordinates lands on the cover and
      // does nothing, which reads as a button that does not work. Polled until the control itself is
      // what is under the point.
      const reachable = await page.waitForFunction(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit != null && hit.closest("[data-voice-talk]") != null;
      }, { x: cx, y: cy }, { timeout: 30_000 }).then(() => true).catch(() => false);
      check(reachable, "and a press at the middle of it really lands on the button, not on something over it",
        reachable ? "" : await page.evaluate(({ x, y }) => { const h = document.elementFromPoint(x, y); return h == null ? "nothing" : `${h.tagName}.${h.className}`.slice(0, 80); }, { x: cx, y: cy }));
      // A press and hold, as a person does it, and the button says it is held while it is down.
      // WHEN TO LOOK, and this is the whole of what the R750 can honestly show about a hold.
      //
      // The demo tenant has talking switched OFF and the operator has pasted no realtime key, so the
      // line this hold opens is refused a few hundred milliseconds later, and the refusal correctly
      // clears the hold and puts one plain sentence on screen. MEASURED on the R750 2026-09-10,
      // sampling a single held press: held true / on true / orb "thinking" at 40 ms and 120 ms, then
      // held false with the sentence by 250 ms. So the hold is read EARLY, which is the only window in
      // which a workspace without talking can prove the button does what the mode says; whether the
      // line then stays up is a question about the key, not about the button, and is measured against
      // the stub on the local box.
      if (v.hasTouch) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
        await sleep(60);
        const heldNow = await page.evaluate(() => ({ held: window.__voice.stats().held, on: window.__voice.stats().on, orb: window.__voice.stats().orb, filled: document.querySelector("[data-voice-talk]")?.classList.contains("is-held") === true }));
        check(heldNow.held && heldNow.filled, "a real touch hold holds the microphone and the button shows it", JSON.stringify(heldNow));
        await sleep(640);
        const during = await rects(page);
        footerHeld(before, during, "while the button was held");
        check(during.sideways === false, "and the page does not scroll sideways");
        await page.screenshot({ path: path.join(SHOTS, `r750-${v.name}-held.png`) });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await sleep(60);
        const heldNow = await page.evaluate(() => ({ held: window.__voice.stats().held, on: window.__voice.stats().on, orb: window.__voice.stats().orb, filled: document.querySelector("[data-voice-talk]")?.classList.contains("is-held") === true }));
        check(heldNow.held && heldNow.filled, "a press and hold holds the microphone and the button shows it", JSON.stringify(heldNow));
        await sleep(640);
        const during = await rects(page);
        footerHeld(before, during, "while the button was held");
        check(during.sideways === false, "and the page does not scroll sideways");
        await page.screenshot({ path: path.join(SHOTS, `r750-${v.name}-held.png`) });
        await page.mouse.up();
      }
      const refused = await page.evaluate(() => ({ on: window.__voice.stats().on, notes: window.__voice.stats().notes, held: window.__voice.stats().held }));
      info(`while still held, the line on this workspace read: ${JSON.stringify(refused)}`);
      if (refused.notes.length > 0) info("talking is switched off for this workspace, so the line was refused in one plain sentence and the hold was let go with it; whether a held line carries audio is measured against the stub on the local box.");
      await sleep(400);
      const released = await page.evaluate(() => ({ held: window.__voice.stats().held, talking: window.__voice.stats().talking }));
      check(released.held === false && released.talking === false, "and after the release nothing is held", JSON.stringify(released));
      const after = await rects(page);
      footerHeld(before, after, "after the release");

      // Leave whatever line the press opened, so the next viewport is not refused for being in a call.
      await page.evaluate(() => window.__voice.stop());
      await sleep(600);

      // ALWAYS LISTENING: now a click IS the press, and pressing again leaves.
      await page.evaluate(() => window.__voice.setTalkMode("always"));
      await page.evaluate(() => { const n = document.querySelector("[data-voice-talk]"); n?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await sleep(1200);
      const toggled = await page.evaluate(() => ({ on: window.__voice.stats().on, notes: window.__voice.stats().notes, held: window.__voice.stats().held }));
      info(`always listening after one press: ${JSON.stringify(toggled)}`);
      check(toggled.held === false, "a press in always listening is not a hold", JSON.stringify(toggled.held));
      const afterToggle = await rects(page);
      footerHeld(before, afterToggle, "after a press in always listening");
      await page.evaluate(() => window.__voice.stop());

      // ---- THE AGENT'S REPLY, which is the half the first run of this gate never saw -------------
      //
      // The panel was never the only thing that could move this footer. Until the adversarial pass on
      // VOICE-7 the agent's reply was written into VOICE-6's own one-line node in the composer, so the
      // footer moved on EVERY turn rather than only on a refused one, and it stayed moved for the rest
      // of the call because only a start or a stop cleared it. Measured on this Mac before the fix:
      // #message-input 370.05 -> 215.31 px at 1440x900, and this shelf 25 px taller and 25 px higher at
      // 390x844. A workspace with talking switched off can never produce a real reply, so the frame is
      // handed to the page the way the relay would hand it over, and the footer is read with it up.
      await page.evaluate(() => window.__voice.stop());
      await sleep(400);
      const quiet = await rects(page);
      await page.evaluate((text) => window.__voice._onMessage({ data: JSON.stringify({ t: "said", text }) }),
        "The team is on the settings surface this afternoon, and the deploy gate is green.");
      await sleep(200);
      const withReply = await rects(page);
      const lineNow = await page.evaluate(() => {
        const line = document.getElementById("voice-line");
        return { hidden: line == null ? null : line.hidden === true, text: (line?.textContent ?? "").replace(/\s+/g, " ").trim(),
          box: (() => { const n = document.querySelector("#message-input"); if (n == null) return null; const b = n.getBoundingClientRect();
            return { w: Math.round(b.width * 100) / 100, h: Math.round(b.height) }; })() };
      });
      check(same(withReply.shelf, quiet.shelf) && same(withReply.composer, quiet.composer) && same(withReply.talk, quiet.talk),
        "the agent's reply moves nothing in the footer, which is every turn rather than only a refused one",
        `shelf ${JSON.stringify(quiet.shelf)} -> ${JSON.stringify(withReply.shelf)}, composer ${JSON.stringify(quiet.composer)} -> ${JSON.stringify(withReply.composer)}, button ${JSON.stringify(withReply.talk)}`);
      check(lineNow.hidden !== false, "and it puts no words in the footer's line: his answer is a transcript row and a voice",
        JSON.stringify(lineNow));
      check(withReply.panelUp === false, "and no panel while he speaks, where the orb on the button is the only sign",
        String(withReply.panelUp));
      info(`the message box with his reply up: ${JSON.stringify(lineNow.box)}`);
    }

    // ---- is a real spoken turn possible at all on this workspace -------------------------------
    const door = await page.evaluate(async () => {
      try {
        const res = await fetch("/voice/settings", { headers: { accept: "application/json" } });
        if (!res.ok) return { status: res.status };
        const body = await res.json();
        // Presence only. No route on this server can answer with a key and this reads neither.
        return { status: res.status, enabled: body.enabled === true, available: body.available === true, apiKeySet: body.apiKeySet === true };
      } catch (error) { return { error: String(error).slice(0, 120) }; }
    });
    info(`the talking door on this workspace: ${JSON.stringify(door)}`);
    check(door.status === 200, "the relay answers the talking door for this customer", JSON.stringify(door.status));
    if (door.available === true) info("A REALTIME KEY EXISTS: a real spoken turn is measurable here.");
    else info("no realtime key for this workspace's service, so no real spoken turn is measurable; the panel is measured against the stub on the local box only.");

    check(errors.length === 0, "and the console threw nothing while all of that happened", errors.slice(0, 2).join(" | ") || "clean");
    await page.screenshot({ path: path.join(SHOTS, `r750-${v.name}-after.png`) });
    await context.close();
  }
} finally {
  await browser.close();
}

// ---- VOICE-13: the call screen, on the live server -----------------------------------------------
//
// TWO ENGINES, and each measures the half it can. A real spoken exchange needs a microphone that says
// words: Chromium takes a WAV file as its capture device, so the turns are driven there with speech
// made on this Mac by `say`. WebKit has no such switch -- and WebKit is what the iPhone app's web view
// is -- so the SCREEN is measured there, at 390x844 with device scale 3 and the iPhone's own insets
// restated as the phone-layout gate restates them, and its microphone is not the claim.
//
// BOTH OUTCOMES ARE WRITTEN DOWN IN ADVANCE so nobody fudges the difference: if this tenant's talking
// door answers enabled false, the honest result is the refusal path measured live -- the screen opens,
// the refusal takes it away, one plain sentence stands on the shelf -- and the spoken turn recorded as
// NOT MEASURED, which is the same shape docs/VOICE.md 13 already uses.
const speechWav = await (async () => {
  const dir = path.join(os.tmpdir(), `voice13-speech-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const aiff = path.join(dir, "said.aiff");
  const wav = path.join(dir, "said.wav");
  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (error) => (error ? reject(error) : resolve())));
  try {
    await run("say", ["-o", aiff, "Hello Titan. In one short sentence, what is the team working on today?"]);
    await run("ffmpeg", ["-y", "-i", aiff, "-ar", "48000", "-ac", "1", "-acodec", "pcm_s16le", wav]);
    return wav;
  } catch (error) {
    info(`no speech file could be made on this Mac (${String(error?.message ?? error).split("\n")[0]}), so the spoken turns are NOT MEASURED and only the screen is`);
    return null;
  }
})();

const callShots = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, `r750-call-${name}.png`) }).catch(() => {}); };

const signInOn = async (page) => {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.fill('input[type="email"], input[name="email"]', EMAIL).catch(() => {});
  await page.fill('input[type="password"]', PASSWORD).catch(() => {});
  await page.press('input[type="password"]', "Enter").catch(() => {});
  await page.waitForLoadState("domcontentloaded");
  const ready = await page.waitForFunction(() => window.__voice !== undefined, null, { timeout: 60_000 }).then(() => true).catch(() => false);
  await page.evaluate(() => { for (const d of document.querySelectorAll("dialog[open]")) { try { d.close(); } catch { /* not ours */ } } }).catch(() => {});
  await page.waitForSelector("[data-voice-talk]", { timeout: 30_000 }).catch(() => {});
  return ready;
};

const talkAt = async (page) => {
  for (let i = 0; i < 60; i += 1) {
    const at = await page.evaluate(() => {
      const node = document.querySelector("[data-voice-talk]");
      if (node == null || node.disabled === true) return null;
      const r = node.getBoundingClientRect();
      if (r.width === 0) return null;
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return node.contains(hit) || hit === node ? { x, y } : null;
    });
    if (at != null) return at;
    await sleep(500);
  }
  return null;
};

const CALL_READ = `(() => {
  const screen = document.getElementById("voice-call");
  const style = screen == null ? null : getComputedStyle(screen);
  const stats = window.__voice?.stats?.() ?? null;
  const rect = (sel) => { const n = document.querySelector(sel); if (n == null) return null;
    const b = n.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left), y: Math.round(b.top) }; };
  return {
    up: screen != null && screen.hidden === false,
    rect: rect("#voice-call"), z: style?.zIndex ?? "", position: style?.position ?? "",
    padBottom: style?.paddingBottom ?? "", padTop: style?.paddingTop ?? "",
    word: (document.querySelector("[data-voice-call-state]")?.textContent ?? "").trim(),
    status: (document.querySelector("[data-voice-call-status]")?.textContent ?? "").trim(),
    mascot: document.querySelector("#voice-call titan-mascot") != null,
    end: rect("[data-voice-call-end]"), mute: rect("[data-voice-call-mute]"), field: rect("[data-voice-call-input]"),
    line: (() => { const n = document.getElementById("voice-line"); return n == null ? null : {
      hidden: n.hidden === true, text: (n.textContent ?? "").replace(/\s+/g, " ").trim() }; })(),
    spokenRows: [...document.querySelectorAll(".message-row")]
      .filter((row) => row.querySelector(".voice-spoken-chip") != null)
      .map((row) => (row.querySelector(".message-bubble")?.textContent ?? "").replace(/\s+/g, " ").trim()),
    rows: [...document.querySelectorAll("#transcript .message-row")].length,
    on: stats?.on === true, orb: stats?.orb ?? "", lastHeard: stats?.lastHeard ?? "", lastSaid: stats?.lastSaid ?? "",
    notes: stats?.notes ?? [], talking: stats?.talking === true, micLevel: stats?.micLevel ?? 0, level: stats?.level ?? 0,
    gap: (() => { const t = document.getElementById("transcript");
      return t == null ? -1 : Math.round(t.scrollHeight - t.scrollTop - t.clientHeight); })(),
  };
})()`;

step("VOICE-13: the call screen at 390x844, in WebKit, with the iPhone's insets restated");
const { webkit } = await import(`${process.env.PW}/node_modules/playwright-core/index.mjs`);
let webkitBrowser = null;
try { webkitBrowser = await webkit.launch({ headless: true }); }
catch (error) { info(`webkit would not launch on this Mac (${String(error?.message ?? error).split("\n")[0]}), so the screen is not measured in the iPhone's own engine`); }
if (webkitBrowser != null) {
  const context = await webkitBrowser.newContext({
    userAgent: GATE_AGENT, permissions: ["microphone"],
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
  });
  // WebKit has no fake capture device, so the stream is a real MediaStream out of a real Web Audio
  // graph. It is a tone and not speech: what it proves is that the microphone opens and frames flow,
  // never what the vendor heard.
  await context.addInitScript(() => {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const ctx = new Ctx();
          try { await ctx.resume(); } catch { /* silence still renders */ }
          const osc = ctx.createOscillator();
          osc.frequency.value = 220;
          const gain = ctx.createGain();
          gain.gain.value = 0.3;
          const dest = ctx.createMediaStreamDestination();
          osc.connect(gain);
          gain.connect(dest);
          osc.start();
          return dest.stream;
        },
        enumerateDevices: async () => [],
      },
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const ready = await signInOn(page);
  check(ready, "the throwaway customer signs in on the iPhone's own engine", ready ? "" : `still at ${page.url()}`);
  if (ready) {
    await page.addStyleTag({ content: ":root { --sat: 59px; --sab: 34px; }" }).catch(() => {});
    const at = await talkAt(page);
    check(at != null, "a thumb really reaches the talk button at 390x844", JSON.stringify(at));
    if (at != null) {
      const pressedAt = Date.now();
      await page.touchscreen.tap(at.x, at.y);
      await page.waitForFunction(() => document.getElementById("voice-call")?.hidden === false, null, { timeout: 10_000 }).catch(() => {});
      const opened = await page.evaluate(CALL_READ);
      check(opened.up === true, "one press brings the call screen up on the live server", `${Date.now() - pressedAt} ms, ${JSON.stringify(opened.rect)}`);
      check(opened.rect?.w === 390 && opened.rect?.h === 844 && opened.position === "fixed" && opened.z === "80",
        "covering the viewport, fixed, at z-index 80", `${JSON.stringify(opened.rect)} ${opened.position} z ${opened.z}`);
      info(`the screen's own padding with the insets restated: top ${opened.padTop}, bottom ${opened.padBottom}. THIS is the reading Playwright cannot take on its own, and the screenshots beside it are what a person can look at.`);
      check(opened.end != null && opened.end.h >= 44 && opened.mute != null && opened.mute.h >= 44 && opened.field != null && opened.field.h >= 44,
        "with all three controls at 44 px or more and on screen",
        `end ${JSON.stringify(opened.end)} mute ${JSON.stringify(opened.mute)} field ${JSON.stringify(opened.field)}`);
      await callShots(page, "webkit-connecting");
      const words = new Set([opened.word]);
      for (let i = 0; i < 40; i += 1) {
        const now = await page.evaluate(CALL_READ);
        words.add(now.word);
        if (now.up === false) break;
        if (now.word === "Listening") { await callShots(page, "webkit-listening"); }
        await sleep(500);
        if (i === 6) { await page.tap("[data-voice-call-mute]").catch(() => {}); await sleep(400); await callShots(page, "webkit-muted"); await page.tap("[data-voice-call-mute]").catch(() => {}); }
      }
      const after = await page.evaluate(CALL_READ);
      info(`the words this run saw on the live server: ${JSON.stringify([...words])}`);
      if (after.up === true) {
        await callShots(page, "webkit-live");
        await page.tap("[data-voice-call-end]").catch(() => {});
        await page.waitForFunction(() => document.getElementById("voice-call")?.hidden === true, null, { timeout: 6000 }).catch(() => {});
        const ended = await page.evaluate(CALL_READ);
        check(ended.up === false && ended.on === false, "and End takes it away and hangs up", JSON.stringify({ up: ended.up, on: ended.on }));
        check(ended.gap >= 0 && ended.gap < 90, "leaving the chat at its newest line", `${ended.gap} px from the bottom`);
      } else {
        // The refusal path, measured live. Written in advance rather than discovered: a workspace with
        // talking switched off closes the screen and puts ONE plain sentence on the shelf's own row.
        check(after.notes.length <= 1, "the refusal closed the screen and left at most one sentence standing", JSON.stringify(after.notes));
        check(after.line != null && after.line.hidden === false && after.line.text.length > 20,
          "and the sentence a person reads is in its one home on the shelf, not on a screen that is gone",
          JSON.stringify(after.line?.text));
        info("A REAL SPOKEN TURN IS NOT MEASURED HERE: the screen opened, the relay refused the line, and the refusal path is what this run measured instead.");
      }
      await callShots(page, "webkit-chat-after");
    }
    check(errors.length === 0, "and WebKit threw nothing through any of it", errors.slice(0, 2).join(" | ") || "clean");
  }
  await webkitBrowser.close();
}

step("VOICE-13: two real spoken turns through the real vendor, in Chromium with speech as the microphone");
if (speechWav == null) info("skipped: no speech file on this Mac");
else {
  const spoken = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    headless: true,
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${speechWav}`, "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const context = await spoken.newContext({
      userAgent: GATE_AGENT, permissions: ["microphone"],
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    const ready = await signInOn(page);
    check(ready, "the throwaway customer signs in for the spoken turns", ready ? "" : `still at ${page.url()}`);
    if (ready) {
      const before = await page.evaluate(CALL_READ);
      const at = await talkAt(page);
      if (at == null) no("a press reaches the talk button for the spoken turns");
      else {
        await page.touchscreen.tap(at.x, at.y);
        await page.waitForFunction(() => document.getElementById("voice-call")?.hidden === false, null, { timeout: 10_000 }).catch(() => {});
        await callShots(page, "chromium-connecting");
        // TWO TURNS AND NO MORE. The vendor bills by the minute and this is his key.
        const seen = new Set();
        let heard = [];
        let said = [];
        const deadline = Date.now() + 150_000;
        while (Date.now() < deadline) {
          const now = await page.evaluate(CALL_READ);
          seen.add(now.word);
          if (now.word === "Thinking") await callShots(page, "chromium-thinking");
          if (now.word === "Talking") await callShots(page, "chromium-talking");
          if (now.lastHeard.length > 0 && !heard.includes(now.lastHeard)) heard.push(now.lastHeard);
          if (now.lastSaid.length > 0 && !said.includes(now.lastSaid)) said.push(now.lastSaid);
          if (now.up === false) { info(`the call ended on its own after ${JSON.stringify(now.notes)}`); break; }
          if (heard.length >= 2 && said.length >= 2) break;
          await sleep(1000);
        }
        const live = await page.evaluate(CALL_READ);
        info(`the microphone's own level on the live call: ${live.micLevel}; the playback analyser: ${live.level}`);
        check(heard.length >= 1, "the real vendor heard the person and the relay handed the words to the bot",
          heard.length === 0 ? "nothing was confirmed inside 150 s" : JSON.stringify(heard));
        check(said.length >= 1, "and the bot answered out loud", said.length === 0 ? "no reply inside 150 s" : JSON.stringify(said.map((one) => one.slice(0, 120))));
        info(`turns heard: ${heard.length}, replies spoken: ${said.length}, state words seen: ${JSON.stringify([...seen])}`);
        if (live.up === true) {
          await page.tap("[data-voice-call-end]").catch(() => {});
          await page.waitForFunction(() => document.getElementById("voice-call")?.hidden === true, null, { timeout: 6000 }).catch(() => {});
        }
        const ended = await page.evaluate(CALL_READ);
        await callShots(page, "chromium-chat-after");
        check(ended.up === false, "End put the person back in the chat", String(ended.up));
        const mine = ended.spokenRows.filter((one) => heard.includes(one));
        check(mine.length >= Math.min(1, heard.length), "and the exchange is in the transcript with the Spoken chip on the person's lines",
          `${ended.spokenRows.length} spoken row(s) in all, ${mine.length} of them this run's; the chat grew ${before.rows} -> ${ended.rows} rows`);
        check(ended.gap >= 0 && ended.gap < 90, "scrolled to the newest line", `${ended.gap} px from the bottom`);
      }
      check(errors.length === 0, "and the console threw nothing during the spoken turns", errors.slice(0, 2).join(" | ") || "clean");
    }
  } finally { await spoken.close(); }
}

console.log(`\nR750 through console.titanium.bot: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
