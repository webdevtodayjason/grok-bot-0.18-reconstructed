// ADMIN-2. Adding a client from the console, and the one rule that keeps two doors honest.
//
// Jason, 2026-09-09 11:43: "if I was going to onboard a new client, would that be something I would
// do from this console or is this console merely reporting?" It was reporting. Adding a customer
// was a CLI line typed on the server, and the panel that could stop, start, restart, provision, set
// a ceiling and move a workspace onto a plan model could not do the one thing that has to happen
// first.
//
// THE SEQUENCE NOW EXISTS TWICE. cp/server.mjs's handleSignup is an HTTP handler that also counts
// against a rate limiter and writes a response; cp/signup.mjs is the same eight steps as a function
// the console calls. That duplication is the thing this file is really testing: every refusal is a
// named constant in cp/signup.mjs and the last test in this file reads cp/server.mjs's own source
// and asserts each sentence is in it word for word, so the two doors cannot drift into telling a
// person two different things about the same refusal. ADMIN-2b is filed with the rewiring.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  SIGNUP_BAD_COMPANY,
  SIGNUP_BAD_COMPANY_EMPTY,
  SIGNUP_BAD_EMAIL,
  SIGNUP_DUPLICATE_EMAIL,
  SIGNUP_NEW_TENANTS_OFF,
  SIGNUP_PROVISIONING_UNFINISHED,
  TEMP_PASSWORD_BYTES,
  addClient,
} from "../cp/signup.mjs";
import { NEW_TENANTS_BLOCKED } from "../cp/provision.mjs";
import { startControlPlane, startFakeCoolify } from "./cp-support.mjs";

// ONBOARD-2. The invite is a JOB now, and these are the environment knobs that bound its waits. They
// are set here rather than handed through startControlPlane because cp/onboard.mjs reads them at call
// time, which is what lets a gate turn a ten minute cold-box budget into a test that finishes. The
// production defaults are in cp/onboard.mjs and every one of them is minutes.
process.env.CP_ONBOARD_HEALTH_BUDGET_MS = "120";
process.env.CP_ONBOARD_HEALTH_INTERVAL_MS = "20";
process.env.CP_ONBOARD_ADDRESS_BUDGET_MS = "120";
process.env.CP_ONBOARD_RUNNING_BUDGET_MS = "60";
process.env.CP_ONBOARD_DEADLINE_MS = "4000";

/**
 * Wait for something the background job does, or give up with the reason.
 *
 * The invite answers before the box is built, so every assertion about the BUILD has to wait for it.
 * There is no hook into the job from out here on purpose: the poll route is the only thing the console
 * has, so the test uses the same door.
 */
async function until(what, check, { ms = 4000, every = 20 } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = await check();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error(`${what} never happened inside ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

async function withPlane(run, { env } = {}) {
  const coolify = await startFakeCoolify();
  const plane = await startControlPlane({ coolifyUrl: coolify.url, coolifyApiKey: coolify.apiKey, env });
  try { await run(plane, coolify); }
  finally { await plane.dispose(); await coolify.close(); }
}

const add = (plane, body) => plane.admin("POST", "/v1/admin/clients", body);

test("one press makes the account and names the workspace, and answers before the box is built", async () => {
  await withPlane(async (plane, coolify) => {
    const started = Date.now();
    const answer = await add(plane, {
      email: "Jane@AcmeRoofing.com", company: "Acme Roofing & Sons", name: "Jane Doe",
      ceiling: 40, sendWelcome: true,
    });
    // ONBOARD-2. 202 AND NOT 201, and it arrives at once. api.titanium.bot is behind Cloudflare, which
    // cuts a proxied request at about 100 seconds, and a synchronous invite that waits for a cold box,
    // a model push, an address sweep and a mail send is a 524 with a half-built tenant behind it and
    // the temporary password lost with the response.
    assert.equal(answer.status, 202, answer.text);
    assert.equal(Date.now() - started < 1000, true, `the invite blocked for ${Date.now() - started} ms`);
    assert.equal(answer.body.account.email, "jane@acmeroofing.com");
    assert.equal(answer.body.tenant.slug, "acme-roofing-sons");
    assert.equal(answer.body.tenant.name, "Acme Roofing & Sons");
    assert.equal(answer.body.tenant.ownerEmail, "jane@acmeroofing.com");
    assert.equal(answer.body.signIn, "https://console.titanium.bot");
    assert.equal(answer.body.state, "building");
    // The five steps are on the answer, in Jason's own words, with the first one already done.
    assert.deepEqual(answer.body.steps.map((one) => one.label), [
      "Creating the workspace", "Building the computer", "Waking Titan",
      "Giving the agents their addresses", "Sending the welcome",
    ]);
    assert.equal(answer.body.steps[0].state, "ok");
    assert.equal(answer.body.jobId.length > 0, true);

    // THE PASSWORD IS IN THIS ANSWER AND NOWHERE ELSE. 18 random bytes in base64url is 24
    // characters, and it is stored as a scrypt hash like every other password here.
    const temporary = answer.body.temporaryPassword;
    assert.equal(typeof temporary, "string");
    assert.equal(temporary.length, Math.ceil((TEMP_PASSWORD_BYTES * 4) / 3));
    assert.doesNotMatch(temporary, /[^A-Za-z0-9_-]/);

    // And it works: this is the whole promise the success card makes.
    const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "jane@acmeroofing.com", password: temporary } });
    assert.equal(signIn.status, 200, signIn.text);
    assert.equal(signIn.body.tenant.slug, "acme-roofing-sons");

    // The box really is built, by the job, as one service with one container. It is not built by the
    // time this answer arrives, which is the whole point, so the test waits the way the card does.
    const created = await until("the box was created", () => coolify.callsTo("POST /services")[0] ?? null);
    assert.equal(created.body.name, "titanbot-acme-roofing-sons");

    // THE WELCOME IS NOT DRAWN AS SENT BEFORE IT HAS BEEN SENT. The checkbox is no longer disabled
    // and the flag is no longer ignored: it is asked for, the card says where it will go and what
    // reply address it will carry, and `sent` stays false until the Sending the welcome step is
    // green. A tick on a mail nobody sent is a customer never hearing from anybody.
    assert.equal(answer.body.welcomeMail.asked, true);
    assert.equal(answer.body.welcomeMail.sent, false);
    assert.equal(answer.body.welcomeMail.to, "jane@acmeroofing.com");
    assert.equal(answer.body.welcomeMail.overridden, false);
    assert.equal(answer.body.welcomeMail.replyTo, "support@titaniumcomputing.com");

    // Neither the model nor the ceiling is claimed as applied on this answer, because neither has
    // been tried yet: both are the job's third step, and the card reports what the box read back.
    assert.equal(answer.body.planModel.applied, false);
    assert.match(answer.body.planModel.why, /no plan model was asked for/);
    assert.equal(answer.body.ceiling.applied, false);
    assert.equal(answer.body.ceiling.asked, 40);
    assert.match(answer.body.ceiling.why, /being set to it now/);
  });
});

test("the temporary password is in no ledger row and in no other answer", async () => {
  await withPlane(async (plane) => {
    const answer = await add(plane, { email: "jane@acme.com", company: "Acme" });
    const temporary = answer.body.temporaryPassword;
    assert.equal(temporary.length > 0, true);

    // Every row of the record of who changed what, swept for it. A change is written down before it
    // happens and finished after, and neither half may carry a secret.
    const actions = await plane.admin("GET", "/v1/admin/actions");
    assert.equal(actions.status, 200);
    assert.equal(actions.text.includes(temporary), false, "the temporary password reached the admin action record");
    const record = actions.body.rows.find((row) => row.action === "client.add");
    assert.equal(record.target, "jane@acme.com");
    assert.equal(record.outcome, "ok");
    assert.match(record.detail, /acme/);

    // And there is no route that can be asked for it again.
    const clients = await plane.admin("GET", "/v1/admin/clients");
    assert.equal(clients.text.includes(temporary), false, "the temporary password came back out of the clients panel");
    const users = await plane.admin("GET", "/v1/accounts");
    assert.equal(users.text.includes(temporary), false, "the temporary password came back out of the accounts list");
  });
});

test("the same email a second time is refused in the customer door's own words", async () => {
  await withPlane(async (plane) => {
    assert.equal((await add(plane, { email: "jane@acme.com", company: "Acme" })).status, 202);
    const again = await add(plane, { email: "Jane@Acme.com", company: "Acme Again" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "duplicate_email");
    assert.equal(again.body.message, SIGNUP_DUPLICATE_EMAIL);
    // Nothing half-made behind it: the refusal happens before any row is written.
    const clients = await plane.admin("GET", "/v1/admin/clients");
    assert.deepEqual(clients.body.clients.map((row) => row.slug), ["acme"]);
  });
});

test("two companies with the same name get two workspaces, and a retired name is not handed out", async () => {
  await withPlane(async (plane) => {
    const first = await add(plane, { email: "a@one.com", company: "Acme" });
    const second = await add(plane, { email: "b@two.com", company: "Acme" });
    assert.equal(first.body.tenant.slug, "acme");
    assert.equal(second.body.tenant.slug, "acme-2", "two companies were handed one workspace");

    // A name that has been retired stays out of circulation. Handing it to a different company
    // would make the previous customer's sign-ins resolve to the new company's box, with full
    // access to it. A workspace is retired by being removed while somebody could still sign in.
    plane.store.createTenant({ slug: "acme-3", name: "Acme Gone", status: "running" });
    plane.store.createAccount({ email: "gone@acme.com", password: "a-good-long-password", tenant: "acme-3" });
    plane.store.deleteTenant("acme-3");
    assert.equal(plane.store.isSlugRetired("acme-3"), true);

    const third = await add(plane, { email: "c@three.com", company: "Acme" });
    assert.equal(third.body.tenant.slug, "acme-4", "a retired workspace name was handed to a different company");
  });
});

test("a reserved name is never given to a customer", async () => {
  await withPlane(async (plane) => {
    // `console` is where everybody signs in and `api` is this service. Handing either one to a
    // customer as a workspace name is a product that cannot address itself.
    const answer = await add(plane, { email: "someone@example.com", company: "Console" });
    assert.equal(answer.status, 202, answer.text);
    assert.notEqual(answer.body.tenant.slug, "console");
    assert.equal(answer.body.tenant.slug, "console-2");
  });
});

test("a company name with nothing to name a workspace after is refused, and so is a missing one", async () => {
  await withPlane(async (plane) => {
    const symbols = await add(plane, { email: "someone@example.com", company: "!!! ???" });
    assert.equal(symbols.status, 400);
    assert.equal(symbols.body.error, "bad_company");
    assert.equal(symbols.body.message, SIGNUP_BAD_COMPANY);

    const missing = await add(plane, { email: "someone@example.com", company: "  " });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.message, SIGNUP_BAD_COMPANY_EMPTY);

    const noEmail = await add(plane, { email: "not-an-address", company: "Acme" });
    assert.equal(noEmail.status, 400);
    assert.equal(noEmail.body.message, SIGNUP_BAD_EMAIL);

    assert.deepEqual((await plane.admin("GET", "/v1/admin/clients")).body.clients, []);
  });
});

test("with new workspaces turned off nothing is created and the reason is the operator's own", async () => {
  await withPlane(async (plane) => {
    const answer = await add(plane, { email: "jane@acme.com", company: "Acme" });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, "new_tenants_off");
    assert.equal(answer.body.message, NEW_TENANTS_BLOCKED);
    assert.equal(SIGNUP_NEW_TENANTS_OFF, NEW_TENANTS_BLOCKED);
    // Not even the account, because the refusal comes before the first write.
    assert.equal((await plane.admin("GET", "/v1/accounts")).body.accounts.length, 0);
  }, { env: { CP_ALLOW_NEW_TENANTS: "0" } });
});

test("a box that will not build keeps the account, and the card says which step stopped", async () => {
  await withPlane(async (plane, coolify) => {
    coolify.failOnce("POST /services", 500, "Coolify said no");
    const answer = await add(plane, { email: "jane@acme.com", company: "Acme", sendWelcome: true });

    // 202 AND THE PASSWORD, not a 502. The account exists whatever happens to the box, and an error
    // status that swallowed the password would leave an operator holding a customer they cannot sign
    // in as, with no way to ask for it again.
    assert.equal(answer.status, 202, answer.text);
    assert.equal(String(answer.body.temporaryPassword).length, 24);

    // The failure lands on the card's second step, with the provisioning step that stopped named on
    // it and the one thing to press. It is NOT on this answer, because the build had not started
    // when this answer left.
    const stopped = await until("the build failed on the card", async () => {
      const state = (await plane.admin("GET", "/v1/admin/clients/acme/onboarding")).body;
      return state.steps[1].state === "failed" ? state : null;
    });
    assert.equal(stopped.steps[1].label, "Building the computer");
    assert.equal(stopped.steps[1].detail.step, "service");
    assert.match(stopped.steps[1].next, /Press Retry/);
    assert.equal(stopped.stopped, "box");
    assert.equal(stopped.retryable, true);
    // And nothing after it ran. A welcome about a workspace that does not exist is worse than none.
    assert.deepEqual(stopped.steps.map((one) => one.state), ["ok", "failed", "waiting", "waiting", "waiting"]);

    // THE ACCOUNT STAYS. They can sign in, and Retry picks up where it stopped.
    const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "jane@acme.com", password: answer.body.temporaryPassword } });
    assert.equal(signIn.status, 200, signIn.text);
    const clients = await plane.admin("GET", "/v1/admin/clients");
    assert.deepEqual(clients.body.clients.map((row) => row.slug), ["acme"]);

    const resumed = await plane.admin("POST", "/v1/admin/clients/acme/onboard", {});
    assert.equal(resumed.status, 202, resumed.text);
    await until("the retry built the service", () => coolify.callsTo("POST /services").length > 0);
  });
});

test("addClient without the wait writes the two rows and builds nothing", async () => {
  await withPlane(async (plane, coolify) => {
    // The option the console's route uses. Every other caller keeps the wait, including the
    // customer's own sign-up door, which is not edited.
    const made = await addClient({
      store: plane.store, config: plane.config,
      email: "jane@acme.com", company: "Acme", name: "Jane",
      awaitProvisioning: false,
    });
    assert.equal(made.ok, true);
    assert.equal(made.state, "building");
    assert.equal(made.boxReady, false);
    assert.equal(made.provisioning.awaited, false);
    assert.equal(String(made.temporaryPassword).length, 24);
    assert.equal(plane.store.getTenant("acme") != null, true);
    assert.equal(plane.store.getAccountByEmail("jane@acme.com") != null, true);
    // NOTHING WAS BUILT. Not a service, not a ledger step.
    assert.deepEqual(coolify.routes(), []);
    assert.deepEqual(plane.store.listSteps("acme"), []);
  });
});

test("a plan model that is not a plan model is said so rather than pointed at", async () => {
  await withPlane(async (plane) => {
    const answer = await add(plane, { email: "jane@acme.com", company: "Acme", planModel: "gpt-4" });
    assert.equal(answer.status, 202, answer.text);
    assert.equal(answer.body.planModel.applied, false);
    assert.match(answer.body.planModel.why, /not a plan model/);
    // The customer is still added, because a bad model choice is not a reason to lose a customer.
    assert.equal(answer.body.tenant.slug, "acme");
  });
});

test("a ceiling outside the range is refused without failing the add", async () => {
  await withPlane(async (plane) => {
    const answer = await add(plane, { email: "jane@acme.com", company: "Acme", ceiling: 5000 });
    assert.equal(answer.status, 202, answer.text);
    assert.equal(answer.body.ceiling.applied, false);
    assert.match(answer.body.ceiling.why, /whole number from 1 to 1000/);
    assert.equal(answer.body.tenant.slug, "acme");
  });
});

test("addClient answers a refusal rather than throwing, so a caller with no response object can use it", async () => {
  await withPlane(async (plane) => {
    const refusal = await addClient({
      store: plane.store, config: plane.config,
      email: "nobody", company: "Acme",
    });
    assert.equal(refusal.ok, false);
    assert.equal(refusal.status, 400);
    assert.equal(refusal.message, SIGNUP_BAD_EMAIL);
  });
});

/**
 * THE CONTROL ON THE DUPLICATION, and the reason this file can live with it.
 *
 * cp/server.mjs is outside this wave's ownership and is being edited by another wave, so the
 * console's door could not be built by calling into it. What CAN be held is the words: every
 * sentence a person reads when they are refused is a named constant in cp/signup.mjs, and this
 * reads the other door's source and asserts it says the same thing. A change to one of them without
 * the other turns this red.
 */
test("both doors refuse in exactly the same words", async () => {
  const server = await readFile(new URL("../cp/server.mjs", import.meta.url), "utf8");
  for (const sentence of [
    SIGNUP_BAD_EMAIL,
    SIGNUP_BAD_COMPANY_EMPTY,
    SIGNUP_DUPLICATE_EMAIL,
    SIGNUP_BAD_COMPANY,
    SIGNUP_PROVISIONING_UNFINISHED,
  ]) {
    assert.equal(
      server.includes(sentence),
      true,
      `the console and the customer's own door no longer refuse in the same words: cp/server.mjs does not say "${sentence}"`,
    );
  }
  // The sixth one is a shared constant rather than a copied string, which is stronger than a match.
  assert.equal(SIGNUP_NEW_TENANTS_OFF, NEW_TENANTS_BLOCKED);
  assert.equal(server.includes("NEW_TENANTS_BLOCKED"), true);
});
