#!/usr/bin/env node
// verify-one-console-browser.mjs -- what two customers' own browsers do at the one console.
//
// scripts/verify-one-console.mjs measures the same arrangement over HTTP, which is the right way to
// measure status codes, headers and copy. It cannot tell you that a person can sign in: a form that
// posts the wrong field name, a button that is not a submit, a redirect a browser will not follow,
// a roster the page never renders, all answer 200 to curl. This drives the real Chrome on this Mac,
// headless, in two separate browser contexts, and does what two customers do.
//
// It replaces scripts/verify-tenant-browser.mjs, which measured the TENANT-2 shape: an account
// typed into the wrong per-customer hostname and redirected to its own. There are no per-customer
// hostnames any more. console.titanium.bot is everybody's front door, and the thing worth proving
// with a browser is that two people at that one door get two different consoles.
//
//   ONE_CONSOLE_PASSWORD_A="$(ssh dell-remote "sudo grep '^DEMO_PASSWORD=' /home/sem/titanbot/cp.env | cut -d= -f2-")" \
//   ONE_CONSOLE_EMAIL_A=demo@titanium.bot \
//   ONE_CONSOLE_EMAIL_B=... ONE_CONSOLE_PASSWORD_B=... \
//     node scripts/verify-one-console-browser.mjs
//
//   --url    the console, default https://console.titanium.bot
//
// Passwords come from the environment and never from an argument: an argument is in the shell
// history and in `ps`. They are never printed, and neither is anything the page says about them.
//
// THE LEG THAT MATTERS is the cross-check, and it is done on agent IDS rather than names. Every
// fresh box calls its first agent "New Bot" (SAND_DEFAULT_AGENT_NAME), so two customers who have
// not renamed anything have rosters that read identically and are drawn from two different boxes.
// Comparing the names would pass whether the isolation worked or not.
//
// playwright-core comes from the same .cache/playwright install verify-deploy.mjs uses, and drives
// the Chrome already on this machine rather than a bundled build.
//
// Exit 0 no leg failed, 1 a leg failed, 2 nothing could be measured.
//
// Run it ONCE and leave a minute before the next gate. The relay's login throttle is five failures
// per address per 30 seconds and the account door and the password door share it, so this script's
// own wrong-password leg, verify-deploy's lockout legs and verify-one-console's all fill the same
// bucket. Back to back from one Mac and the next one measures its own lockout. A leg that hits it
// says so by name rather than failing as though the product were broken.
import { createRequire } from "node:module";

import { gateUserAgent } from "./gate-agent.mjs";

// SIGNIN-1. This gate has no fetch of its own: every request it makes is made by Chrome, so the
// name goes on the browser context rather than on a headers object, and it therefore rides on the
// page loads and the form posts alike. See scripts/gate-agent.mjs for what the header is worth.
const GATE_AGENT = gateUserAgent(import.meta.url);

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};
const CONSOLE_URL = (flag("url") ?? process.env.ONE_CONSOLE_URL ?? "https://console.titanium.bot").replace(/\/+$/, "");
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR
  ?? new URL("../.cache/playwright", import.meta.url).pathname;
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const require = createRequire(`${PW_DIR}/package.json`);
const { chromium } = require("playwright-core");

// DEMO_EMAIL and DEMO_PASSWORD still work for the first customer, so the one-liner that was
// documented for the old gate keeps working.
const A = {
  email: process.env.ONE_CONSOLE_EMAIL_A ?? process.env.DEMO_EMAIL ?? "demo@titanium.bot",
  password: process.env.ONE_CONSOLE_PASSWORD_A ?? process.env.DEMO_PASSWORD ?? "",
};
const B = {
  email: process.env.ONE_CONSOLE_EMAIL_B ?? "",
  password: process.env.ONE_CONSOLE_PASSWORD_B ?? "",
};
if (A.password.length === 0) {
  console.error("ONE_CONSOLE_PASSWORD_A is not set, so nothing here can be measured");
  process.exit(2);
}

let failures = 0;
let skipped = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const skip = (label, why) => { console.log(`  SKIP  ${label} -- ${why}`); skipped += 1; };
const step = (name) => console.log(`\n== ${name}`);

// Click and wait for where the click should land, and turn a wait that never lands into a FAIL
// rather than a stack trace. The reason is almost always the login throttle, so it is named.
async function clickAndLandOn(page, predicate, label) {
  try {
    await Promise.all([page.waitForURL(predicate, { timeout: 60000 }), page.click("button")]);
    return true;
  } catch (error) {
    const body = await page.content().catch(() => "");
    const why = /too many (sign-in )?attempts/i.test(body)
      ? "the login lockout is holding; another gate filled it in the last 30 s, so run them further apart"
      : `left on ${page.url()}`;
    check(false, label, `${String(error?.name ?? "error")}: ${why}`);
    return false;
  }
}

// One customer's whole visit: sign in at the one console, wait for the roster to render, and come
// back with the agent ids the page actually drew.
async function visit(browser, who, label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: GATE_AGENT });
  const page = await context.newPage();
  await page.goto(`${CONSOLE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  check(await page.locator('input[name="email"]').count() === 1, `${label}: the one login page has an email field`);
  check((await page.content()).includes("Sign in with your Titanium Bot account"), `${label}: and says what the account is for`);
  await page.fill('input[name="email"]', who.email);
  await page.fill('input[name="password"]', who.password);
  const landed = await clickAndLandOn(page, (u) => new URL(u).pathname === "/", `${label}: it lands on the console`);
  if (landed) check(new URL(page.url()).pathname === "/", `${label}: it lands on the console`, page.url());
  const cookies = await context.cookies();
  check(cookies.some((c) => c.name === "gb_session"), `${label}: with a session cookie of their own`);
  await page.waitForSelector(".worker-card[data-context-id]", { timeout: 60000 }).catch(() => {});
  const ids = await page.locator(".worker-card[data-context-id]").evaluateAll(
    (cards) => cards.map((card) => card.getAttribute("data-context-id")),
  ).catch(() => []);
  // The card's own name element, not its first line of text: the first line of a worker card is
  // whitespace, and a detail string that prints nothing reads like a broken gate.
  const names = await page.locator(".worker-card[data-context-id]").evaluateAll(
    (cards) => cards.map((card) => (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)),
  ).catch(() => []);
  const shown = names.filter((name) => name.length > 0);
  check(ids.length > 0, `${label}: the roster has agent cards on it`,
    `${ids.length} card(s): ${(shown.length > 0 ? shown : ids).join(", ").slice(0, 90)}`);
  return { context, page, ids, names, cookie: cookies.find((c) => c.name === "gb_session")?.value ?? "" };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let a = null;
let b = null;
try {
  step(`customer A signs in at ${CONSOLE_URL}`);
  a = await visit(browser, A, "A");

  if (B.email.length === 0 || B.password.length === 0) {
    skip("customer B signs in at the same address", "no ONE_CONSOLE_EMAIL_B / ONE_CONSOLE_PASSWORD_B");
    skip("the two rosters are two different sets of agents", "no second customer to compare against");
    skip("neither browser carries one agent from the other's box", "no second customer to compare against");
  } else {
    step(`customer B signs in at the SAME address, in a second browser context`);
    b = await visit(browser, B, "B");

    step("the cross-check, which is the whole point");
    check(a.cookie !== b.cookie && a.cookie.length > 0, "the two sessions are two different cookies");
    // Ids, not names: a fresh box calls its first agent "New Bot", so two isolated customers have
    // rosters that read the same and are drawn from different boxes. The id is per box.
    const shared = a.ids.filter((id) => b.ids.includes(id));
    check(shared.length === 0, "neither browser carries one agent from the other's box",
      shared.length === 0
        ? `A ${a.ids.join(", ").slice(0, 40)} | B ${b.ids.join(", ").slice(0, 40)}`
        : `both rosters contain ${shared.join(", ")}`);
    check(a.ids.length > 0 && b.ids.length > 0, "and both of them got a roster at all",
      `A ${a.ids.length} card(s), B ${b.ids.length} card(s)`);
  }

  step("a wrong password");
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: GATE_AGENT });
  const page = await context.newPage();
  await page.goto(`${CONSOLE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[name="email"]', A.email);
  await page.fill('input[name="password"]', "not-the-password-9f2a");
  await page.click("button");
  await page.waitForLoadState("domcontentloaded");
  const body = await page.content();
  check(body.includes("That email or password is not right."), "it says so in plain words");
  check(!body.includes("401") && !body.includes("invalid_login"), "and shows no status code or machine word");
  const cookies = await context.cookies();
  check(!cookies.some((c) => c.name === "gb_session"), "and nobody is signed in");
  await context.close();
} finally {
  if (a?.context) await a.context.close().catch(() => {});
  if (b?.context) await b.context.close().catch(() => {});
  await browser.close();
}

if (skipped > 0) console.log(`\n${skipped} leg(s) were not measured.`);
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
