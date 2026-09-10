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

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, hasTouch: false },
  { name: "phone", width: 390, height: 844, hasTouch: true },
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

console.log(`\nR750 through console.titanium.bot: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
