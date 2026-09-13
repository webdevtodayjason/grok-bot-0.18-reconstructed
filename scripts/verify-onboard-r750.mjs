#!/usr/bin/env node
// verify-onboard-r750.mjs -- ONBOARD-2's one real measurement: a customer built, signed in, read and
// removed, on a LIVE control plane, through the product's own doors and nothing else.
//
// THIS GATE CREATES AND DESTROYS A REAL CUSTOMER. It is not part of `npm test` and it refuses to run
// without being told, by name, which console to do it on and who to do it as. Everything it makes it
// takes away again through the product's own Remove, because a hand cleanup on the box means the wave
// did not ship what it claims.
//
// What it will not do, on purpose:
//   it never signs in as a real person -- the operator makes a throwaway super admin and passes it
//   it never prompts a box -- onboarding-state.ts marks a box done FOR EVER on the first prompted
//     read, and resetOnboarding is 403 without SAND_TEST_HOOKS, so a smoke turn here would destroy
//     the customer's first-run interview with no error and no way back
//   it never writes the sign-in link anywhere -- not a log, not a file, not a screenshot, not stdout.
//     The link is a stateless bearer the relay never checks for revocation (ONBOARD-5), so it is read
//     out of the send answer, clicked, and dropped. Screenshots are redacted before they are saved.
//   it touches no other workspace. Richard's box is never asked anything.
//
//   CONSOLE=https://api.titanium.bot  the control plane's admin console
//   BOSS_EMAIL / BOSS_PASSWORD        a THROWAWAY super admin, made and removed with cp/cli.mjs
//   WELCOME_TO                        the one real address the welcome is sent to
//   SHOTS                             where the screenshots go
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// SIGNIN-1. The name this gate says at a REAL front door, derived from its own filename rather than
// typed in. It posts a throwaway super admin's password at api.titanium.bot/v1/sessions, so the row
// it writes on the Sign-in attempts panel has to be one an operator can tell from a stranger's.
import { gateUserAgent } from "./gate-agent.mjs";

const CONSOLE_URL = String(process.env.CONSOLE ?? "").replace(/\/+$/, "");
const BOSS_EMAIL = String(process.env.BOSS_EMAIL ?? "");
const BOSS_PASSWORD = String(process.env.BOSS_PASSWORD ?? "");
const WELCOME_TO = String(process.env.WELCOME_TO ?? "");
const SHOTS = String(process.env.SHOTS ?? "");
const PW_DIR = String(process.env.PW_DIR ?? path.join(process.cwd(), ".cache/playwright/node_modules"));
const GATE_AGENT = gateUserAgent(import.meta.url);

for (const [name, value] of [["CONSOLE", CONSOLE_URL], ["BOSS_EMAIL", BOSS_EMAIL], ["BOSS_PASSWORD", BOSS_PASSWORD], ["WELCOME_TO", WELCOME_TO], ["SHOTS", SHOTS]]) {
  if (value.length === 0) {
    console.error(`verify-onboard-r750 needs ${name}. This gate builds and removes a real customer, so it will not guess any of its inputs.`);
    process.exit(2);
  }
}

const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
await mkdir(SHOTS, { recursive: true });

let passes = 0;
let failures = 0;
const lines = [];
const say = (text) => { console.log(text); lines.push(text); };
const step = (title) => say(`\n== ${title}`);
const check = (ok, label, detail = "") => {
  if (ok) { passes += 1; say(`  PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failures += 1; say(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
  return ok;
};

/** Anything that must never reach a screenshot, a log line or this gate's own output. */
const SECRETS = new Set();
const redact = (text) => {
  let out = String(text ?? "");
  for (const secret of SECRETS) if (secret.length > 0) out = out.split(secret).join("REDACTED");
  return out;
};

const hex = Math.random().toString(16).slice(2, 8);
const SLUG = `onboard-test-${hex}`;
const COMPANY = `Onboard Test ${hex}`;
const OWNER_EMAIL = `onboard-${hex}@titanium.invalid`;
const PERSON = "Onboard Test";

say(`verify-onboard-r750 -- ONBOARD-2 on ${CONSOLE_URL}, ${new Date().toISOString()}`);
say(`  the throwaway customer is ${COMPANY} (${SLUG}), owner ${OWNER_EMAIL}`);
say(`  the welcome goes to ${WELCOME_TO} and to nobody else`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ userAgent: GATE_AGENT, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error?.message ?? error)));

/** A screenshot, with every secret blanked out of the DOM first. */
let shotIndex = 0;
const shoot = async (name, target = page) => {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await target.evaluate((secrets) => {
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        for (const secret of secrets) if (secret.length > 0 && node.nodeValue.includes(secret)) node.nodeValue = node.nodeValue.split(secret).join("REDACTED");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.value && typeof node.value === "string") {
        for (const secret of secrets) if (secret.length > 0 && node.value.includes(secret)) node.value = "REDACTED";
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(document.body);
  }, [...SECRETS]).catch(() => {});
  await target.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
};

const api = async (method, pathname, body) => {
  const token = await page.evaluate(() => { try { return sessionStorage.getItem("titanbot.admin.token") ?? ""; } catch { return ""; } });
  const response = await fetch(`${CONSOLE_URL}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`, accept: "application/json", "user-agent": GATE_AGENT,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

try {
  // ---- 1. the door -----------------------------------------------------------------------------
  step("the console, as a throwaway super admin");
  await page.goto(`${CONSOLE_URL}/admin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.fill("#email", BOSS_EMAIL);
  await page.fill("#password", BOSS_PASSWORD);
  SECRETS.add(BOSS_PASSWORD);
  await page.click("#signinButton");
  await page.waitForFunction(() => document.body.getAttribute("data-admin-loaded") === "true", null, { timeout: 60_000 }).catch(() => {});
  const signedIn = await page.evaluate(() => { try { return (sessionStorage.getItem("titanbot.admin.token") ?? "").length > 0; } catch { return false; } });
  check(signedIn, "a throwaway super admin opens the console", signedIn ? "" : String(await page.locator("#doorMessage").textContent().catch(() => "")));
  if (!signedIn) throw new Error("the console did not open, so nothing was created");

  // What was there before, so it can be shown identical afterwards.
  const before = await api("GET", "/v1/admin/clients");
  const beforeSlugs = (before.body?.clients ?? []).map((one) => one.slug).sort();
  say(`  the workspaces before: ${beforeSlugs.join(", ")}`);

  // ---- 2. the invite ---------------------------------------------------------------------------
  step("Add a client, one press");
  // The admin console is a left-nav dashboard (ADMIN-3): one panel on screen at a time, named by the
  // hash, so the Clients panel has to be opened before its button is visible.
  await page.click('a[href="#panel-clients"]');
  await page.waitForSelector("#addClientShow", { state: "visible", timeout: 30_000 });
  await page.click("#addClientShow");
  await page.fill("#acEmail", OWNER_EMAIL);
  await page.fill("#acCompany", COMPANY);
  await page.fill("#acName", PERSON);
  await page.fill("#acCeiling", "40");
  check(await page.locator("#acWelcome").isChecked(), "the welcome box is on by default");
  check(!(await page.locator("#acWelcome").isDisabled()), "and it is a live control");
  // THE OVERRIDE, NOT A COPY. One recipient. A bcc would put a live sign-in link and a temporary
  // password for a customer's workspace in a third party's inbox until the link expires.
  await page.fill("#acWelcomeTo", WELCOME_TO);

  // THE PICKER'S OWN DEFAULT, left alone, and recorded. It matters which: writeBoxDefaults leaves a
  // new box with no model, so a workspace nobody points at one has Titan awake and mute, and step 3
  // stops amber before the welcome rather than mailing a customer a bot that cannot answer. If the
  // providers panel returned no plan models the select hides in favour of a free-text field, and an
  // empty one here would be exactly that silent no-model invite.
  const chosenModel = await page.evaluate(() => {
    const select = document.getElementById("acPlanModel");
    const typed = document.getElementById("acPlanModelText");
    if (select != null && select.hidden !== true) return String(select.value ?? "");
    return String(typed?.value ?? "");
  });
  check(chosenModel.length > 0, "the plan model picker has a default to send", chosenModel.length > 0 ? chosenModel : "EMPTY, so Titan would be awake with no model");
  await shoot("form-filled");

  const pressedAt = Date.now();
  await page.click("#addClientSave");
  await page.waitForSelector("#addClientResult .newClient", { timeout: 60_000 });
  const answeredMs = Date.now() - pressedAt;
  check(answeredMs < 5_000, "the press answers without waiting for the box", `${answeredMs} ms from ${CONSOLE_URL}`);

  const card = String(await page.locator("#addClientResult").textContent());
  const password = (card.match(/Temporary password\s*([^\s]+)/) ?? [])[1] ?? "";
  if (password.length > 0) SECRETS.add(password);
  check(password.length >= 12, "the temporary password is on the card, once", `${password.length} characters`);
  check(card.includes(SLUG), "and the card names the workspace the company gave its name to", SLUG);
  check(/Welcome email:/.test(card) && card.includes(WELCOME_TO),
    "and says the welcome goes to the override address and not the owner's",
    (card.match(/Welcome email:[^.]{0,90}/) ?? ["not on the card"])[0]);
  await shoot("card-pressed");

  // ---- 3. the five steps -----------------------------------------------------------------------
  step("the five steps, watched to the end");
  const LABELS = ["Creating the workspace", "Building the computer", "Waking Titan", "Giving the agents their addresses", "Sending the welcome"];
  const seen = new Map();
  const deadline = Date.now() + 12 * 60_000;
  let state = null;
  for (;;) {
    const answer = await api("GET", `/v1/admin/clients/${encodeURIComponent(SLUG)}/onboarding`);
    state = answer.body;
    for (const row of state?.steps ?? []) {
      const was = seen.get(row.key);
      if (was !== row.state) {
        seen.set(row.key, row.state);
        say(`    ${String(row.state).padEnd(8)}${row.label}${row.at ? `  ${row.at}` : ""}${row.why ? `  (${redact(row.why)})` : ""}`);
        await shoot(`step-${row.key}-${row.state}`);
      }
    }
    if (state?.done === true || state?.running !== true) break;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  check((state?.steps ?? []).map((row) => row.label).join("|") === LABELS.join("|"),
    "the card shows exactly the five named steps, in Jason's own words",
    (state?.steps ?? []).map((row) => row.label).join(" > "));
  for (const row of state?.steps ?? []) {
    check(row.state === "ok", `${row.label} finished`, `${row.state}${row.why ? ` -- ${redact(row.why)}` : ""}${row.at ? ` at ${row.at}` : ""}`);
  }
  // The wall clock of each step, off the ledger's own timestamps.
  const clock = (state?.steps ?? []).filter((row) => row.at).map((row) => `${row.key} ${row.at}`);
  say(`  the ledger's own timestamps: ${clock.join(" | ")}`);
  await shoot("card-done");

  // ---- 3b. WHICH model the box got, off the row rather than off a green tick -------------------
  //
  // A green Waking Titan means the box's own settings file named SOMETHING (ui/server.mjs
  // reportRunning reads SAND_OPENAI_COMPATIBLE_MODEL out of it), and that is worth having. It does
  // not say which model, or whether the push that put it there was the first one. Both are on the
  // titan row now and this is the only place they can be read: store.deleteTenant wipes the whole
  // ledger at Remove, so a run that does not print them leaves no record of the model the box got.
  //
  // This gate does NOT try to make Titan answer. onboarding-state.ts marks a box done FOR EVER on
  // the first prompted read, so a smoke turn here would spend the customer's own first-run
  // interview. What the box runs on is a setting that can be read; an answer is not.
  const titanStep = (state?.steps ?? []).find((row) => row.key === "titan") ?? null;
  const titanDetail = titanStep?.detail ?? {};
  const askedModel = String(titanDetail.asked ?? "");
  const gotModel = String(titanDetail.model ?? "");
  const gotLabel = String(titanDetail.label ?? "");
  const pushes = Number(titanDetail.pushes ?? 0);
  say(`  what the box runs on: asked ${askedModel || "nothing"} | it read back ${gotModel || "nothing"}`
    + ` (${gotLabel || "no label"}) | applied ${String(titanDetail.applied)} | ${pushes} push(es)`);
  check(gotModel.length > 0 && gotLabel.length > 0,
    "the box read its own model back, so Titan has one to answer on",
    `${gotModel || "nothing"} / ${gotLabel || "no label"}`);
  check(askedModel.length > 0 && askedModel === chosenModel,
    "and it is the model the invite sent and not some leftover", `asked ${askedModel}, the form sent ${chosenModel}`);
  check(titanDetail.applied === true, "and the push the relay took is the one that set it", String(titanDetail.applied));
  // Two pushes is the retry having earned its keep: the first was refused and a later one landed.
  // One is a relay that took it first time, which is also right. Printed rather than asserted.
  say(`  the plan model took ${pushes} push(es) to land${pushes > 1 ? ", so the first was refused and a later one landed" : ""}`);

  // ---- 4. the welcome, and the link it carried -------------------------------------------------
  step("the welcome mail");
  const sends = await api("GET", `/v1/admin/clients/${encodeURIComponent(SLUG)}/welcome`);
  const row = (sends.body?.rows ?? [])[0] ?? null;
  check(row != null, "the send is a row on the client's own panel");
  check(String(row?.to ?? "") === WELCOME_TO, "it went to the override address", String(row?.to ?? ""));
  check(String(row?.outcome ?? "") === "sent", "and the provider took it", String(row?.outcome ?? ""));
  check(String(row?.resendId ?? "").length > 0, "with a provider id, which is the proof a mail left", String(row?.resendId ?? ""));
  say(`  THE WELCOME LEFT AT ${String(row?.at ?? "")} to ${String(row?.to ?? "")}, provider id ${String(row?.resendId ?? "")}`);
  const written = JSON.stringify(sends.body ?? {});
  check(password.length > 0 && !written.includes(password), "and the row holds no password");
  check(!/\/login\?sso=/.test(written), "and no sign-in link");

  // THE LINK IS READ OUT OF A FRESH MINT and never out of the row, which holds none, and never out of
  // anybody's inbox. It is used once here and dropped.
  const minted = await api("POST", `/v1/admin/clients/${encodeURIComponent(SLUG)}/sign-in-link`, {});
  const signInUrl = String(minted.body?.url ?? "");
  if (signInUrl.length > 0) SECRETS.add(signInUrl.split("sso=")[1] ?? "");
  check(signInUrl.length > 0 && /\/login\?sso=/.test(signInUrl), "a sign-in link is minted once for the operator", signInUrl.length > 0 ? "minted, and not printed here" : "none");
  check(String(minted.body?.email ?? "") === OWNER_EMAIL, "for the customer and not for anybody else", String(minted.body?.email ?? ""));

  // ---- 5. the customer's own first screen ------------------------------------------------------
  step("what the customer sees");
  const fresh = await browser.newContext({ userAgent: GATE_AGENT, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const theirs = await fresh.newPage();
  const theirErrors = [];
  theirs.on("pageerror", (error) => theirErrors.push(String(error?.message ?? error)));
  await theirs.goto(signInUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await theirs.waitForTimeout(5_000);
  const landedUrl = String(theirs.url());
  // THE PATHNAME, not a disjunction. The old condition was true whenever the URL carried no `sso=`,
  // which is exactly what a bare /login is, so the one case this leg exists to catch -- the customer
  // dumped back at a password box -- passed it.
  const landedPath = (() => { try { return new URL(landedUrl).pathname; } catch { return landedUrl; } })();
  check(!/^\/login\/?$/.test(landedPath),
    "the link lands them signed in rather than back at a password box", redact(landedUrl).replace(/sso=[^&]*/, "sso=REDACTED"));
  // AND A SESSION EXISTS, which is the positive half. The relay sets gb_session on the sso landing
  // (ui/server.mjs), so its presence on this context is the link having been accepted rather than the
  // page merely having rendered. The value is a bearer and is never read, printed or saved.
  const theirCookies = await fresh.cookies().catch(() => []);
  const hasSession = theirCookies.some((one) => String(one.name) === "gb_session");
  check(hasSession, "and the relay gave them a real session rather than a page that only looks signed in",
    hasSession ? "gb_session is set, and its value is not printed" : "no gb_session cookie");
  await shoot("customer-first-screen", theirs);

  // WHAT IS ON THE SCREEN, and nothing more. This reads the first-run dialog's own copy, which the
  // console draws from ui/machine-room/app.js whether or not any model exists, so it is evidence the
  // customer's first screen is the introduction and NOT evidence that Titan answered anything. The
  // model is proved in 3b off the box's own settings; an answer is not proved anywhere, because
  // prompting this box would spend the customer's first-run interview for ever.
  const dialog = await theirs.locator("#onboarding-dialog").count().catch(() => 0);
  check(dialog > 0, "the first-run dialog is on their screen", `${dialog} dialog(s)`);
  let titanSaid = "";
  for (let waited = 0; waited < 90_000; waited += 3_000) {
    titanSaid = String(await theirs.evaluate(() => {
      const host = document.querySelector("#onboarding-dialog") ?? document.body;
      return host.innerText ?? "";
    }).catch(() => ""));
    if (titanSaid.trim().length > 40) break;
    await theirs.waitForTimeout(3_000);
  }
  check(titanSaid.trim().length > 40, "and it carries the introduction the customer reads", titanSaid.replace(/\s+/g, " ").slice(0, 220));
  say(`  THE FIRST-RUN DIALOG, as a person reads it (the product's own copy, not an answer from a model):\n    ${titanSaid.replace(/\s+/g, " ").slice(0, 600)}`);
  await shoot("customer-titan-first-message", theirs);
  check(theirErrors.length === 0, "their first screen threw nothing", theirErrors.slice(0, 2).join(" | "));
  await fresh.close();

  // ---- 5b. ONBOARD-5: the link the customer just used is spent, and the console can cancel one ---
  //
  // This is the live half of ONBOARD-5. Until 2026-09-12 the link above was a stateless bearer: it
  // worked as many times as it was clicked for a full day and the only cancel was rotating
  // CP_SESSION_SECRET, which signs the whole fleet out. The customer has now clicked it once, so the
  // first assertion is simply that clicking it again does not sign anybody in.
  //
  // NOTHING HERE PRINTS A LINK. The mint answers an ID beside the URL; the id cancels a link and can
  // never use one, so it is the only half that reaches this output.
  step("the sign-in link is spent, and a live one can be cancelled");
  const again = await browser.newContext({ userAgent: GATE_AGENT, viewport: { width: 1440, height: 1000 } });
  const replay = await again.newPage();
  await replay.goto(signInUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await replay.waitForTimeout(2_000);
  const replayCookies = await again.cookies().catch(() => []);
  const replayText = String(await replay.evaluate(() => document.body?.innerText ?? "").catch(() => ""));
  check(!replayCookies.some((one) => String(one.name) === "gb_session"),
    "the link the customer already used signs nobody in a second time",
    replayCookies.some((one) => String(one.name) === "gb_session") ? "a second session was minted" : "no gb_session on a fresh browser");
  check(/already been used/i.test(replayText),
    "and it says so in words a customer can act on", replayText.replace(/\s+/g, " ").slice(0, 160));
  await shoot("sign-in-link-already-used", replay);
  await again.close();

  // A fresh link, listed as live on the panel's own read, then cancelled, then clicked.
  const second = await api("POST", `/v1/admin/clients/${encodeURIComponent(SLUG)}/sign-in-link`, {});
  const secondUrl = String(second.body?.url ?? "");
  const secondId = String(second.body?.id ?? "");
  if (secondUrl.length > 0) SECRETS.add(secondUrl.split("sso=")[1] ?? "");
  check(secondId.length > 0 && second.body?.singleUse === true, "a fresh link is minted single-use and carries an id", secondId);
  const live = await api("GET", `/v1/admin/clients/${encodeURIComponent(SLUG)}/sign-in-links`);
  check((live.body?.rows ?? []).some((one) => String(one.id) === secondId),
    "the console lists it as a link a click would still open", `${(live.body?.rows ?? []).length} live link(s)`);
  check(!JSON.stringify(live.body ?? {}).includes("sso="), "and that list holds no link, only ids");
  const cancelled = await api("POST", `/v1/admin/clients/${encodeURIComponent(SLUG)}/sign-in-link/revoke`, { id: secondId });
  check(cancelled.body?.revoked === true, "Revoke on the Clients panel cancels it", String(cancelled.body?.message ?? `HTTP ${cancelled.status}`));
  const dead = await browser.newContext({ userAgent: GATE_AGENT, viewport: { width: 1440, height: 1000 } });
  const deadPage = await dead.newPage();
  await deadPage.goto(secondUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await deadPage.waitForTimeout(2_000);
  const deadCookies = await dead.cookies().catch(() => []);
  const deadText = String(await deadPage.evaluate(() => document.body?.innerText ?? "").catch(() => ""));
  check(!deadCookies.some((one) => String(one.name) === "gb_session"),
    "a cancelled link signs nobody in", deadCookies.some((one) => String(one.name) === "gb_session") ? "it still worked" : "no gb_session");
  check(/was cancelled/i.test(deadText), "and says it was cancelled", deadText.replace(/\s+/g, " ").slice(0, 160));
  await shoot("sign-in-link-cancelled", deadPage);
  await dead.close();
  const afterwards = await api("GET", `/v1/admin/clients/${encodeURIComponent(SLUG)}/sign-in-links`);
  check(!(afterwards.body?.rows ?? []).some((one) => String(one.id) === secondId),
    "and it is off the live list afterwards", `${(afterwards.body?.rows ?? []).length} live link(s)`);

  // ---- 6. the agent address --------------------------------------------------------------------
  step("the bots' own addresses");
  const directory = await api("GET", `/v1/admin/mail?slug=${encodeURIComponent(SLUG)}`);
  const addresses = directory.body?.rows ?? [];
  const titan = addresses.find((one) => String(one.agentName ?? "").toLowerCase() === "titan") ?? addresses[0] ?? null;
  check(titan != null && String(titan.state) === "active", "Titan holds a live address in the directory", String(titan?.address ?? "none"));
  check(addresses.length > 0, "and the workspace has at least one bot address", `${addresses.length} address(es) on ${String(directory.body?.domain ?? "")}`);
  // THE SAME ADDRESS THE MAIL NAMED, or the customer writes to a bot that is not there. The mail's
  // body is deliberately stored nowhere, so the addresses step's own row is the only honest record of
  // what went in it -- the sender is handed that field and no other. The old version of this leg read
  // the welcome row's detail, which holds the reply-to note and never an address, through a condition
  // (`.length >= 0`) that is true of every string there is.
  const addressStep = (state?.steps ?? []).find((one) => one.key === "addresses") ?? null;
  const namedInMail = String(addressStep?.detail?.titanAddress ?? "");
  check(namedInMail.length > 0 && namedInMail === String(titan?.address ?? ""),
    "and it is the address the welcome named", `the mail named ${namedInMail || "nothing"}, the directory holds ${String(titan?.address ?? "none")}`);

  // ---- 7. Remove, with the data -----------------------------------------------------------------
  step("Remove, and the proof that it is gone");
  const plan = await api("GET", `/v1/admin/clients/${encodeURIComponent(SLUG)}/removal`);
  check(plan.body?.status === "ready", "the confirm panel says what removing them would do", String(plan.body?.status ?? plan.status));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => document.body.getAttribute("data-admin-loaded") === "true", null, { timeout: 60_000 }).catch(() => {});
  await shoot("remove-confirm");

  const removed = await api("DELETE", `/v1/admin/clients/${encodeURIComponent(SLUG)}`, { confirm: SLUG, deleteData: true });
  check(removed.body?.ok === true, "the removal finished", redact(String(removed.body?.message ?? removed.status)));
  check(removed.body?.containerGone === true, "and the container is PROVED gone rather than assumed", String(removed.body?.provedBy ?? ""));
  check(removed.body?.dataDeleted === true, "and their data went with it", `${Number(removed.body?.bytesFreed ?? 0)} bytes freed`);
  // THE PURGE'S OWN NUMBER, not the removal's summary of it. A removal can answer dataDeleted true on
  // a relay that reported nothing freed, and a directory still on the disk is the one thing "delete
  // their data" has to mean. This leg reads the data effect's own detail, which is what the relay's
  // freedBytes was written into.
  const dataEffect = (removed.body?.effects ?? []).find((one) => one.step === "data") ?? null;
  const dataDetail = (() => { try { return JSON.parse(String(dataEffect?.detail ?? "")); } catch { return {}; } })();
  check(dataEffect?.status === "ok" && Number(dataDetail.bytesFreed ?? 0) > 0,
    "and the purge itself says how many bytes came back",
    `${dataEffect?.status ?? "there was no data step"}, ${Number(dataDetail.bytesFreed ?? 0)} bytes`);
  say(`  the effects, in the order they landed: ${(removed.body?.effects ?? []).map((one) => `${one.step}=${one.status}`).join(" > ")}`);
  // AND WHAT EVERY ONE THAT IS NOT OK ACTUALLY SAID. The line above drops the detail, and the data
  // step's detail is wiped from the ledger one step later by design, so for one run on 2026-09-10 a
  // refusal existed in two places and both threw it away. It is printed here, redacted like every
  // other line.
  for (const one of (removed.body?.effects ?? [])) {
    if (one.status === "ok") continue;
    say(`    ${one.step}=${one.status}: ${redact(String(one.detail ?? "")).slice(0, 400)}`);
  }

  const after = await api("GET", "/v1/admin/clients");
  const afterSlugs = (after.body?.clients ?? []).map((one) => one.slug).sort();
  check(!afterSlugs.includes(SLUG), "the workspace is off the panel", afterSlugs.join(", "));
  check(afterSlugs.join(",") === beforeSlugs.join(","), "and every workspace that was there before is there still, unchanged", afterSlugs.join(", "));
  const gone = await api("GET", `/v1/admin/clients/${encodeURIComponent(SLUG)}/onboarding`);
  check(gone.status === 404, "and the workspace itself is gone", `status ${gone.status}`);
  // EVERY ADDRESS RETIRED. Nothing else ever will: the sweep only retires codes for a roster it could
  // READ, and it cannot read a box that no longer exists, so an address left active here would keep
  // routing mail to a workspace that is gone, for ever.
  const leftovers = await api("GET", `/v1/admin/mail?slug=${encodeURIComponent(SLUG)}`);
  const stillActive = (leftovers.body?.rows ?? []).filter((one) => String(one.state) === "active");
  check(stillActive.length === 0, "and every address that workspace's bots held is retired",
    stillActive.length === 0 ? `${(leftovers.body?.rows ?? []).length} row(s), none active` : stillActive.map((one) => one.address).join(", "));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => document.body.getAttribute("data-admin-loaded") === "true", null, { timeout: 60_000 }).catch(() => {});
  await shoot("panel-after-removal");
  check(pageErrors.length === 0, "the console threw nothing for the whole run", pageErrors.slice(0, 2).join(" | "));
} catch (error) {
  failures += 1;
  say(`  FAIL  the run stopped: ${redact(String(error?.message ?? error))}`);
} finally {
  await browser.close().catch(() => {});
}

say(`\n${failures === 0 ? "PASS" : "FAIL"}  ${passes} passed, ${failures} failed`);
say(`screenshots in ${SHOTS}`);
// The transcript, with every secret already blanked. This is what goes in the report.
await writeFile(path.join(SHOTS, "run.log"), `${redact(lines.join("\n"))}\n`, "utf8");
process.exit(failures > 0 ? 1 : 0);
