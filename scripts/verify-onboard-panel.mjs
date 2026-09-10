// scripts/verify-onboard-panel.mjs -- ONBOARD-2's browser leg for the operator's own surface.
//
//   timeout 300 node scripts/verify-onboard-panel.mjs
//
// It is a SEPARATE gate from scripts/verify-onboard.mjs, which drives the sequence and the removal
// end to end against a control plane. This one drives the SCREEN: the form, the card, the five step
// rows and the Remove control, in a real browser, because a passing route is not evidence that a
// person can press anything.
//
// It stands up the REAL admin console -- cp/admin.mjs's routes and the three page files it serves --
// against a fake Coolify, a stub relay, a stub box and doubles for the welcome sender and the
// removal, then drives it in headless Chromium. What it proves:
//
//   Add a client opens the form, the welcome checkbox is ON and no longer disabled, and the override
//   field appears with it.
//   One press answers at once with the temporary password on the card.
//   All five step rows reach done, in order, and the card is screenshotted at every transition.
//   Remove refuses a typed name that does not match, and accepts one that does.
//
// Every request carries the user agent titanbot-gate/verify-onboard-panel. Nothing here reaches the
// R750, Coolify, Resend or any box: every port in this file is on 127.0.0.1 and dies with the run.
import { createRequire } from "node:module";
import path from "node:path";
import { mkdirSync } from "node:fs";

import { pathToFileURL } from "node:url";

const REPO = process.env.GB_REPO ?? new URL("..", import.meta.url).pathname;
const {
  probeThrough, startAdminOnly, startStubBox, startStubRelay, stubDecommission, stubWelcome,
} = await import(pathToFileURL(path.join(REPO, "tests/helpers/onboard-fakes.mjs")).href);
const { startFakeCoolify } = await import(pathToFileURL(path.join(REPO, "tests/cp-support.mjs")).href);
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? path.join(REPO, ".cache/playwright");
const SHOTS = process.env.GB_SHOTS ?? path.join(process.env.TMPDIR ?? "/tmp", "titanbot-onboard-panel");
const UA = "titanbot-gate/verify-onboard-panel";

mkdirSync(SHOTS, { recursive: true });

let pass = 0;
const fails = [];
const ok = (what, extra = "") => { pass += 1; console.log(`PASS ${what}${extra ? ` -- ${extra}` : ""}`); };
const bad = (what, why) => { fails.push(`${what}: ${why}`); console.log(`FAIL ${what} -- ${why}`); };
const check = (what, condition, why = "") => (condition ? ok(what, why) : bad(what, why || "it was not true"));

const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");

const TITAN = { id: "agent-titan", name: "Titan", isGroup: false };

const coolify = await startFakeCoolify();
const box = await startStubBox({ answers: { listAgents: [TITAN], getOnboardingState: { done: false, maxAgents: 40 } } });
const relay = await startStubRelay();
const welcome = stubWelcome();
// THE EFFECTS IN THE SHAPE cp/decommission.mjs ACTUALLY WRITES, which is `{step, status, detail}`.
// This fixture used to say `{name, ok, detail}` -- a shape the library has never emitted -- so the
// gate passed 30/30 while every chip on the real card was drawn with an empty label and a failed step
// was painted green. It is copied from a real removal driven through the real relay route on this Mac
// 2026-09-10, `carried-on` data step and all, because that mixture is what the colours have to
// survive: two things the operator must go and finish, three deliberate non-events, four plain
// successes.
const REMOVAL_EFFECTS = [
  { step: "disable-signins", status: "ok", detail: "1 account disabled" },
  { step: "addresses", status: "ok", detail: "1 address retired" },
  { step: "proxy-key", status: "skipped", detail: "no proxy is configured" },
  { step: "stop", status: "skipped", detail: "this workspace had no service" },
  { step: "service", status: "skipped", detail: "this workspace had no service" },
  { step: "container-gone", status: "ok", detail: "docker says the container is absent" },
  { step: "data", status: "carried-on", detail: "the relay answered 409" },
  { step: "accounts", status: "ok", detail: "1 removed" },
  { step: "audit-ready", status: "ok", detail: "" },
];
const decommission = stubDecommission({
  answer: {
    ok: true,
    effects: REMOVAL_EFFECTS,
    message: "onboard-test is gone, data and all.",
  },
});

const plane = await startAdminOnly({
  coolify, relay,
  probeImpl: probeThrough(box),
  deps: { welcome, decommission },
  onboard: { healthBudgetMs: 8_000, healthIntervalMs: 100, addressBudgetMs: 8_000, runningBudgetMs: 2_000 },
});

// The address the sweep would mint. The stub relay's sweep answers 200 and mints nothing, because
// minting is the control plane's own door, so this stands in for that door having run.
plane.store.mintMailCode({ tenant: "onboard-test", agentId: TITAN.id, agentName: "Titan", domain: "myagents.email" });

let browser = null;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    userAgent: UA,
    extraHTTPHeaders: { "user-agent": UA },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // The operator token, seeded the way the ADMIN-2 measurement seeded it. There is no super admin
  // account in this store and the page's door takes either.
  await page.addInitScript((value) => {
    try { sessionStorage.setItem("titanbot.admin.token", value); } catch { /* nothing to do */ }
    try { sessionStorage.setItem("titanbot.admin.email", "the operator token"); } catch { /* nothing to do */ }
  }, plane.config.adminToken);

  await page.goto(`${plane.base}/admin#panel-clients`, { waitUntil: "load", timeout: 30_000 });
  await page.waitForSelector("#panel-clients:not([hidden])", { timeout: 20_000 });
  check("the Clients panel opens", true);

  // ---- the form ---------------------------------------------------------------------------------
  await page.click("#addClientShow");
  await page.waitForSelector("#addClientForm:not([hidden])", { timeout: 5_000 });
  const form = await page.evaluate(() => ({
    welcomeChecked: document.getElementById("acWelcome").checked,
    welcomeDisabled: document.getElementById("acWelcome").disabled,
    overrideShown: document.getElementById("acWelcomeToRow").hidden === false,
    why: document.getElementById("acWelcomeWhy").textContent.trim(),
    nameRequired: document.getElementById("acName").required,
  }));
  check("the welcome checkbox is on by default", form.welcomeChecked === true, `checked ${form.welcomeChecked}`);
  check("the welcome checkbox is no longer disabled", form.welcomeDisabled === false, "ADMIN-2c");
  check("the override field is there when the welcome is on", form.overrideShown === true);
  check("the person's name is required", form.nameRequired === true);
  check("the note beside the checkbox no longer says this service sends no mail", !/sends no mail|does not send mail/.test(form.why), form.why);

  // Turning the welcome off takes the override field away, because a field that cannot do anything
  // is a question the operator has to answer for nothing.
  await page.click("#acWelcome");
  const hiddenNow = await page.evaluate(() => document.getElementById("acWelcomeToRow").hidden);
  check("the override field goes away when the welcome is off", hiddenNow === true);
  await page.click("#acWelcome");

  await page.fill("#acName", "Onboard Test");
  await page.fill("#acEmail", "onboard@titanium.invalid");
  await page.fill("#acCompany", "Onboard Test");
  await page.fill("#acCeiling", "40");
  await page.fill("#acWelcomeTo", "test@titaniumcomputing.invalid");
  await page.screenshot({ path: path.join(SHOTS, "01-form.png"), fullPage: false });

  const pressed = Date.now();
  await page.click("#addClientSave");
  await page.waitForSelector("#addClientResult .newClient", { timeout: 10_000 });
  const answered = Date.now() - pressed;
  check("the invite answers in well under a second", answered < 2_000, `${answered} ms in a real browser`);

  const card = await page.evaluate(() => {
    const host = document.querySelector("#addClientResult .newClient");
    const rows = [...host.querySelectorAll("dt")].map((dt) => [dt.textContent.trim(), dt.nextElementSibling?.textContent?.trim() ?? ""]);
    return {
      text: host.textContent,
      rows: Object.fromEntries(rows),
      once: host.querySelector(".once")?.textContent ?? "",
    };
  });
  check("the temporary password is on the card, once", String(card.rows["Temporary password"] ?? "").length === 24, `${String(card.rows["Temporary password"] ?? "").length} characters`);
  check("the card says the password is shown once", /shown once/.test(card.once), card.once);
  check("the card says the welcome is going to the override and not the owner", /NOT to the owner/.test(card.text));
  check("the card names the reply address", /support@titaniumcomputing\.com/.test(card.text));
  await page.screenshot({ path: path.join(SHOTS, "02-card-password.png"), fullPage: false });

  // ---- the five steps ----------------------------------------------------------------------------
  const readSteps = () => page.evaluate(() => [...document.querySelectorAll("#addClientSteps .stepRow")].map((row) => ({
    key: row.dataset.step, state: row.dataset.state, label: row.querySelector("strong")?.textContent ?? "",
  })));

  const seen = [];
  let shot = 0;
  const deadline = Date.now() + 90_000;
  let last = "";
  let steps = await readSteps();
  for (;;) {
    steps = await readSteps();
    const signature = steps.map((one) => `${one.key}:${one.state}`).join(" ");
    if (signature !== last && steps.length === 5) {
      last = signature;
      seen.push(steps.map((one) => one.state));
      shot += 1;
      await page.screenshot({ path: path.join(SHOTS, `03-steps-${String(shot).padStart(2, "0")}.png`), fullPage: false });
    }
    if (steps.length === 5 && steps.every((one) => one.state === "ok")) break;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(250);
  }

  check("the five rows are Jason's own words, in order",
    steps.map((one) => one.label).join(" | ") === "Creating the workspace | Building the computer | Waking Titan | Giving the agents their addresses | Sending the welcome",
    steps.map((one) => one.label).join(" | "));
  check("all five rows reach done", steps.every((one) => one.state === "ok"), JSON.stringify(steps));
  check("the card was screenshotted at every transition", shot >= 2, `${shot} transitions`);

  // They went green IN ORDER: no row was ever green while an earlier one was not.
  const outOfOrder = seen.some((row) => {
    let sawUnfinished = false;
    for (const state of row) {
      if (state !== "ok") sawUnfinished = true;
      else if (sawUnfinished) return true;
    }
    return false;
  });
  check("no row was ever green while an earlier one was not", outOfOrder === false, JSON.stringify(seen));
  check("the box was read and never prompted",
    [...new Set(box.commands())].filter((one) => one !== "health").sort().join(",") === "getOnboardingState,listAgents",
    [...new Set(box.commands())].join(","));
  check("the welcome went to the override address and nowhere else",
    welcome.sends.length === 1 && welcome.sends[0].to === "test@titaniumcomputing.invalid",
    JSON.stringify(welcome.sends.map((one) => one.to)));
  check("the welcome carried Titan's own address", /^agent\d{6}@myagents\.email$/.test(String(welcome.sends[0]?.titanAddress ?? "")), String(welcome.sends[0]?.titanAddress ?? ""));

  await page.screenshot({ path: path.join(SHOTS, "04-steps-done.png"), fullPage: true });

  // ---- Remove -------------------------------------------------------------------------------------
  await page.waitForSelector(".client .removeRow button", { timeout: 10_000 });
  const rowOf = ".clients .client:first-child";
  await page.click(`${rowOf} .removeRow button`);
  const armed = await page.evaluate((sel) => {
    const row = document.querySelector(`${sel} .removeRow`);
    return {
      label: row.querySelector("button").textContent.trim(),
      confirmShown: row.querySelector(".removeConfirm").hidden === false,
      dataShown: row.querySelector("label.check").hidden === false,
      said: row.querySelector(".clock")?.textContent?.trim() ?? "",
      dataChecked: row.querySelector(".removeData").checked,
    };
  }, rowOf);
  check("the first click arms rather than removes", armed.label === "Click again to remove", armed.label);
  check("arming shows the typed-name field", armed.confirmShown === true);
  check("arming shows the data switch, off", armed.dataShown === true && armed.dataChecked === false);
  check("the card says what is TRUE about kept data, and never promises a timer",
    /kept at \/data\/titanbot/.test(armed.said) && /Nothing deletes them on a timer/.test(armed.said) && !/thirty days|30 days/.test(armed.said),
    armed.said);
  await page.screenshot({ path: path.join(SHOTS, "05-remove-armed.png"), fullPage: false });

  // A name that does not match: refused, with the route's own sentence, and NOTHING done.
  //
  // The banner is emptied first. It was still holding the add's own success message, and a gate that
  // read a banner it had not watched change would pass on the previous sentence.
  await page.evaluate(() => { const node = document.getElementById("banner"); node.textContent = ""; node.hidden = true; });
  await page.fill(`${rowOf} .removeConfirm`, "not-the-name");
  await page.click(`${rowOf} .removeRow button`);
  await page.waitForFunction(() => (document.getElementById("banner")?.textContent ?? "").trim().length > 0, null, { timeout: 5_000 });
  const refused = await page.evaluate(() => document.getElementById("banner").textContent.trim());
  check("a typed name that does not match is refused in the route's own words", /Type the workspace name/.test(refused), refused);
  check("nothing was removed by the mismatch", decommission.removals.length === 0, `${decommission.removals.length} removals`);
  await page.screenshot({ path: path.join(SHOTS, "06-remove-refused.png"), fullPage: false });

  // The name that matches, with the data switch on.
  const slug = await page.evaluate((sel) => document.querySelector(`${sel} .head .quiet`)?.textContent?.trim() ?? "", rowOf);
  await page.fill(`${rowOf} .removeConfirm`, slug);
  await page.click(`${rowOf} .removeData`);
  await page.click(`${rowOf} .removeRow button`);
  await page.waitForFunction(() => /is gone/.test(document.getElementById("banner")?.textContent ?? ""), null, { timeout: 10_000 });
  check("a typed name that matches is accepted", decommission.removals.length === 1, `${decommission.removals.length} removals`);
  check("the data switch reached the route", decommission.removals[0]?.deleteData === true);
  const drawn = await page.evaluate(() => {
    const card = document.querySelector("#addClientResult .removedClient");
    if (card == null) return { found: false, chips: [] };
    return {
      found: true,
      chips: [...card.querySelectorAll(".chip")].map((one) => ({ text: one.textContent.trim(), cls: one.className })),
    };
  });
  check("the removal's own effects are drawn where the operator can still read them",
    drawn.found === true && drawn.chips.length === REMOVAL_EFFECTS.length
      && drawn.chips.every((chip) => chip.text.length > 0),
    JSON.stringify(drawn));
  // THE LABEL AND THE COLOUR, which is the whole value of this card. A blank chip says nothing, and a
  // green one over a step that did not happen says the wrong thing in the colour for success.
  const byName = (name) => drawn.chips.find((chip) => chip.text.startsWith(`${name} `));
  check("each chip names its step and its status",
    byName("container-gone")?.text === "container-gone ok" && byName("data")?.text === "data carried-on",
    JSON.stringify(drawn.chips.map((chip) => chip.text)));
  check("a step the operator has to go and finish is not painted green",
    /attack/.test(byName("data")?.cls ?? "") && /ok/.test(byName("container-gone")?.cls ?? "")
      && !/attack|ok/.test(byName("stop")?.cls ?? ""),
    JSON.stringify(drawn.chips));
  await page.screenshot({ path: path.join(SHOTS, "07-remove-done.png"), fullPage: true });

  check("the page threw nothing", errors.length === 0, errors.join(" | "));
  const scrolls = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  check("the page does not scroll sideways", scrolls.w <= scrolls.c, `${scrolls.w} in ${scrolls.c}`);
} finally {
  if (browser != null) await browser.close().catch(() => {});
  await plane.dispose();
  await box.close();
  await relay.close();
  await coolify.close();
}

console.log(`\n${pass} PASS ${fails.length} FAIL`);
console.log(`screenshots in ${SHOTS}`);
if (fails.length > 0) { for (const line of fails) console.log(`  ${line}`); process.exit(1); }
