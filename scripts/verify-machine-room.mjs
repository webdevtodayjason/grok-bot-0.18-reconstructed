#!/usr/bin/env node
/*
 * Machine Room acceptance harness.
 * --------------------------------
 * Drives the real UI in a real browser against the real gateway. It never reads source to decide
 * whether something works: it clicks the control a person would click, then asks the gateway
 * independently whether anything actually happened. A control that looks right and changes nothing
 * is the failure this exists to catch.
 *
 *   node scripts/verify-machine-room.mjs --e2e                   every wired control, end to end
 *   node scripts/verify-machine-room.mjs --surfaces              Browser/Terminal, 5x each way
 *   node scripts/verify-machine-room.mjs --assert-no-silent-mocks demo data rendered as if real
 *   node scripts/verify-machine-room.mjs --all
 *
 * Needs playwright. It is not a dependency of this repo, so the path is configurable:
 *   PLAYWRIGHT_DIR=/path/to/node_modules node scripts/verify-machine-room.mjs --all
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const UI = process.env.MACHINE_ROOM_URL ?? "http://127.0.0.1:7777/machine-room/";
const RELAY = new URL(UI).origin;
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const DISPLAY = process.env.BOX_DISPLAY ?? ":1";

const argv = new Set(process.argv.slice(2));
const want = (flag) => argv.has(flag) || argv.has("--all");

let failures = 0;
const pass = (name, detail = "") => console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (name, detail) => { failures += 1; console.log(`  FAIL  ${name} — ${detail}`); };
const step = (name) => console.log(`\n== ${name}`);

async function api(method, args = {}) {
  const r = await fetch(`${RELAY}/api/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(body?.error ?? `${method} ${r.status}`);
  return body;
}

// The window the operator is actually looking at, asked of X rather than of our own code.
async function activeWindowClass() {
  const script = `w=$(xdotool getactivewindow 2>/dev/null) && xprop -id $w WM_CLASS 2>/dev/null | sed 's/.*= //'`;
  const { stdout } = await exec("docker", ["exec", "-e", `DISPLAY=${DISPLAY}`, BOX, "sh", "-c", script]);
  return stdout.trim();
}

async function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_DIR;
  try {
    // A directory import resolves to the package's CJS entry, whose named exports do not survive
    // the ESM bridge -- take the default and fall back to the namespace.
    const mod = dir ? await import(`${dir}/playwright/index.js`) : await import("playwright");
    return mod.chromium ? mod : (mod.default ?? mod);
  } catch (error) {
    console.error("playwright is not resolvable. Set PLAYWRIGHT_DIR to a node_modules holding it.");
    console.error(String(error.message));
    process.exit(2);
  }
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(UI, { waitUntil: "networkidle" });
await page.waitForTimeout(2600);

const live = await page.evaluate(() => window.__machineRoomLive);
if (!live) {
  console.error("The page fell back to demo data — the gateway is unreachable from the relay.");
  console.error("Start the relay with SAND_PROFILE_DIRS set, or nothing below means anything.");
  await browser.close();
  process.exit(2);
}

// ---------------------------------------------------------------- silent mocks

if (want("--assert-no-silent-mocks")) {
  step("no demo data rendered as if it were real");

  // Names and labels that exist only in the handoff's seed. If the page is live and any of these
  // are on screen, the operator is being shown fiction with the same weight as fact.
  const SEEDED = [
    "Marketing Channels", "ClientSync Tester", "MSP Team", "Finance close",
    "team-brief.md", "delegation-map.json", "ticket-audit.csv", "regression-report.json",
    "overnight-summary.pdf", "client-digest.md", "campaign-calendar.csv",
    "Context7", "Ticket audit", "Reports",
    "Weekday ticket review", "Morning command brief", "Weekly digest draft",
    "Nemotron Super", "GLM 4.7", "Qwen 3.5",
  ];
  const body = await page.evaluate(() => document.body.innerText);
  const found = SEEDED.filter((s) => body.includes(s));
  if (found.length === 0) pass("no seed strings on the main view");
  else fail("seed strings rendered as real data", found.join(", "));

  // The desktop dialog carries its own labels.
  await page.click('[data-capability="browser"]').catch(() => {});
  await page.waitForTimeout(1500);
  const desk = await page.evaluate(() => document.getElementById("desktop-dialog")?.innerText ?? "");
  const deskFound = SEEDED.filter((s) => desk.includes(s));
  if (deskFound.length === 0) pass("no seed strings in the desktop dialog");
  else fail("seed strings in the desktop dialog", deskFound.join(", "));
  await page.click("[data-close-desktop]").catch(() => {});
  await page.waitForTimeout(600);
}

// ---------------------------------------------------------------- surfaces

if (want("--surfaces")) {
  step("Browser and Terminal each show what they claim, five times each way");
  const EXPECT = { browser: "Google-chrome", terminal: "Xfce4-terminal" };
  await page.click('[data-capability="browser"]').catch(() => {});
  await page.waitForTimeout(2000);

  for (let round = 1; round <= 5; round += 1) {
    for (const surface of ["browser", "terminal"]) {
      await page.click(`[data-desktop-app="${surface}"]`);
      await page.waitForTimeout(4500);
      let cls = "";
      try { cls = await activeWindowClass(); } catch (error) { cls = `(x query failed: ${error.message})`; }
      if (cls.includes(EXPECT[surface])) pass(`round ${round} ${surface}`, cls);
      else fail(`round ${round} ${surface}`, `active window is ${cls || "(none)"}, expected ${EXPECT[surface]}`);
    }
  }
  await page.click("[data-close-desktop]").catch(() => {});
  await page.waitForTimeout(600);
}

// ---------------------------------------------------------------- end to end

if (want("--e2e")) {
  step("every wired control reaches the gateway");
  const made = [];
  const names = async () => (await api("listAgents")).map((a) => a.name);

  try {
    // -- sendMessage
    const probe = `E2E probe ${process.pid}: reply with one short sentence.`;
    await page.click("#message-input");
    await page.type("#message-input", probe, { delay: 4 });
    await page.press("#message-input", "Enter");
    let landed = false;
    for (let i = 0; i < 30 && !landed; i += 1) {
      await page.waitForTimeout(2000);
      const active = await page.evaluate(() => window.__machineRoomLive && document.querySelector(".worker-card.is-active,[data-context-id]")?.dataset?.contextId);
      if (!active) continue;
      const t = await api("getAgentTranscript", { id: active }).catch(() => []);
      landed = (t ?? []).some((e) => typeof e.content === "string" && e.content.includes(`E2E probe ${process.pid}`));
    }
    landed ? pass("sendMessage reached the transcript") : fail("sendMessage", "prompt never appeared in the gateway transcript");

    // -- addWorker
    await page.click('[data-capability="add"]');
    await page.waitForTimeout(700);
    await page.fill("#worker-name", "E2E Probe Worker");
    await page.click('form[data-add-worker] button[type="submit"]');
    await page.waitForTimeout(4500);
    if ((await names()).includes("E2E Probe Worker")) { pass("addWorker -> createAgent"); made.push("E2E Probe Worker"); }
    else fail("addWorker", "no such agent after submitting the form");

    // -- addRoom, with a member, which is where the memberAgentIds trap lives
    await page.click('[data-capability="add"]');
    await page.waitForTimeout(700);
    await page.fill("#room-name-input", "E2E Probe Room");
    const memberId = await page.$eval("#room-first-member", (el) => el.value).catch(() => null);
    await page.click('form[data-add-room] button[type="submit"]');
    await page.waitForTimeout(4500);
    const room = (await api("listAgents")).find((a) => a.name === "E2E Probe Room");
    if (!room) fail("addRoom", "no such room after submitting the form");
    else {
      made.push("E2E Probe Room");
      pass("addRoom -> createGroup");
      if (memberId && (room.memberIds ?? []).includes(memberId)) pass("addRoom carried its first member", memberId);
      else fail("addRoom members", `room has ${JSON.stringify(room.memberIds)}, expected to include ${memberId}`);
    }

    // -- runRoutine, on whichever agent actually has one
    const withRoutine = [];
    for (const a of await api("listAgents")) {
      const list = await api("getAgentAutomations", { id: a.id }).catch(() => []);
      if ((list ?? []).length) withRoutine.push({ agent: a, automation: list[0] });
    }
    if (!withRoutine.length) fail("runRoutine", "no agent on this box has an automation to test");
    else {
      const { agent, automation } = withRoutine[0];
      try {
        await api("runAgentAutomationNow", { id: agent.id, automationId: automation.id });
        pass("runAgentAutomationNow", `${agent.name} / ${automation.id}`);
      } catch (error) { fail("runAgentAutomationNow", error.message); }
    }
  } finally {
    for (const a of await api("listAgents")) {
      if (made.includes(a.name)) { await api("deleteAgent", { id: a.id }).catch(() => {}); console.log(`  (cleaned up ${a.name})`); }
    }
  }
}

// ---------------------------------------------------------------- always

step("page errors");
if (pageErrors.length === 0) pass("no uncaught errors during the run");
else fail("uncaught page errors", pageErrors.slice(0, 5).join(" | "));

await browser.close();
console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
