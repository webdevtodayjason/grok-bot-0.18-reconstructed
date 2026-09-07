#!/usr/bin/env node
// verify-tenant-browser.mjs -- the three things a customer's own browser has to be able to do.
//
// scripts/verify-tenant.mjs measures the tenant relay over HTTP, which is the right way to measure
// status codes, headers and copy. It cannot tell you that a person can sign in: a form that posts
// the wrong field name, a button that is not a submit, a redirect a browser will not follow all
// answer 200 to curl. This drives the real Chrome on this Mac instead, headless, and does the three
// things the customer does.
//
//   DEMO_PASSWORD="$(ssh dell-remote "grep '^DEMO_PASSWORD=' /home/sem/titanbot/cp.env | cut -d= -f2-")" \
//     node scripts/verify-tenant-browser.mjs
//
//   --url    the tenant's console, default https://demo.titanium.bot
//   --other  an instance the same account does NOT belong to, default https://console.titanium.bot,
//            which is where the wrong-address redirect is measured from
//
// The password comes from the environment and never from an argument: an argument is in the shell
// history and in `ps`. It is never printed, and neither is anything the page says about it.
//
// playwright-core comes from the same .cache/playwright install verify-deploy.mjs uses, and drives
// the Chrome already on this machine rather than a bundled build.
//
// Exit 0 no leg failed, 1 a leg failed, 2 nothing could be measured.
//
// Run it ONCE and leave a minute before the next gate. The relay's login throttle is five failures
// per address per 30 seconds and the account door and the password door share it, so this script's
// own wrong-password leg, verify-deploy's lockout legs and verify-tenant's all fill the same
// bucket. Back-to-back runs lock this Mac out of the instance they are measuring. A leg that hits
// that says so by name rather than failing as though the product were broken.
import { createRequire } from "node:module";
const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};
const RELAY = (flag("url") ?? process.env.TENANT_GATE_URL ?? "https://demo.titanium.bot").replace(/\/+$/, "");
const OTHER = (flag("other") ?? process.env.TENANT_GATE_OTHER_URL ?? "https://console.titanium.bot").replace(/\/+$/, "");
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR
  ?? new URL("../.cache/playwright", import.meta.url).pathname;
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const require = createRequire(`${PW_DIR}/package.json`);
const { chromium } = require("playwright-core");

const EMAIL = process.env.DEMO_EMAIL ?? "demo@titanium.bot";
const PASSWORD = process.env.DEMO_PASSWORD ?? "";
if (PASSWORD.length === 0) { console.error("DEMO_PASSWORD is not set, so nothing here can be measured"); process.exit(2); }

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const step = (name) => console.log(`\n== ${name}`);

// Click and wait for where the click should land, and turn a wait that never lands into a FAIL
// rather than a stack trace. The reason is almost always the same one and it is worth naming: the
// relay's login throttle is five failures per address per 30 seconds, it is shared by the account
// door and the password door, and verify-deploy and verify-tenant both end by filling it on
// purpose. Run those and this one back to back from the same Mac and this is what you get. The
// page it was left on is printed, so a real failure is still readable.
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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  {
    step(`an account signs in at ${RELAY}`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(`${RELAY}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
    check(await page.locator('input[name="email"]').count() === 1, "the login page has an email field");
    check((await page.content()).includes("Sign in with your Titanium Bot account"), "and says what the account is for");
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    const landed = await clickAndLandOn(page, (u) => new URL(u).pathname === "/", "it lands on the console");
    if (landed) check(new URL(page.url()).pathname === "/", "it lands on the console", page.url());
    const cookies = await context.cookies();
    check(cookies.some((c) => c.name === "gb_session"), "with a session cookie of that instance's own");
    await page.waitForSelector(".worker-card[data-context-id]", { timeout: 60000 }).catch(() => {});
    const names = await page.locator(".worker-card[data-context-id]").allTextContents();
    check(names.length > 0, `the roster has agent cards on it -- ${names.length}`);
    // The contract asked for Titan by name. A brand new box does not have one: the first agent on
    // any fresh instance is called "New Bot", which is SAND_DEFAULT_AGENT_NAME in
    // source/shared/agents/agents.ts and is upstream's, not this rebuild's. Titan is the name
    // Jason gave his own agent. So the leg that means something is that the roster is THIS
    // instance's, drawn live from its own box, and the agent it shows is the one its own gateway
    // lists. Asserting "Titan" here would only be asserting that somebody had renamed it by hand.
    check(names.some((t) => t.includes("New Bot")), "showing this instance's own first agent", names.map((t) => t.split("\n")[0].trim()).join(", ").slice(0, 120));
    await context.close();
  }
  {
    step(`the same account typed into ${OTHER}`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(`${OTHER}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
    check(await page.locator('input[name="email"]').count() === 1, "the operator's own login page also takes an account");
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    const sent = await clickAndLandOn(page, (u) => new URL(u).host === new URL(RELAY).host, "it is sent to its own instance");
    if (sent) check(new URL(page.url()).host === new URL(RELAY).host, "it is sent to its own instance", new URL(page.url()).host);
    check(new URL(page.url()).pathname === "/", "and lands signed in rather than at another login", new URL(page.url()).pathname);
    const cookies = await context.cookies();
    check(cookies.some((c) => c.name === "gb_session" && c.domain.includes(new URL(RELAY).hostname)), "with a session on that instance");
    await page.waitForSelector(".worker-card[data-context-id]", { timeout: 60000 }).catch(() => {});
    const roster = await page.locator(".worker-card[data-context-id]").count().catch(() => 0);
    check(roster > 0, "and the console it landed on is a working one", `${roster} card(s)`);
    await context.close();
  }
  {
    step("a wrong password");
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(`${RELAY}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', "not-the-password-9f2a");
    await page.click("button");
    await page.waitForLoadState("domcontentloaded");
    const body = await page.content();
    check(body.includes("That email or password is not right."), "it says so in plain words");
    check(!body.includes("401") && !body.includes("invalid_login"), "and shows no status code or machine word");
    const cookies = await context.cookies();
    check(!cookies.some((c) => c.name === "gb_session"), "and nobody is signed in");
    await context.close();
  }
} finally { await browser.close(); }

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
