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

async function withPlane(run, { env } = {}) {
  const coolify = await startFakeCoolify();
  const plane = await startControlPlane({ coolifyUrl: coolify.url, coolifyApiKey: coolify.apiKey, env });
  try { await run(plane, coolify); }
  finally { await plane.dispose(); await coolify.close(); }
}

const add = (plane, body) => plane.admin("POST", "/v1/admin/clients", body);

test("one request from the console makes the account, names the workspace and builds the box", async () => {
  await withPlane(async (plane, coolify) => {
    const answer = await add(plane, {
      email: "Jane@AcmeRoofing.com", company: "Acme Roofing & Sons", name: "Jane Doe",
      ceiling: 40, sendWelcome: true,
    });
    assert.equal(answer.status, 201, answer.text);
    assert.equal(answer.body.account.email, "jane@acmeroofing.com");
    assert.equal(answer.body.tenant.slug, "acme-roofing-sons");
    assert.equal(answer.body.tenant.name, "Acme Roofing & Sons");
    assert.equal(answer.body.tenant.ownerEmail, "jane@acmeroofing.com");
    assert.equal(answer.body.signIn, "https://console.titanium.bot");
    assert.equal(answer.body.state, "running");

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

    // The box was really built, as one service with one container, the same steps the customer's
    // own door runs.
    assert.equal(coolify.callsTo("POST /services")[0].body.name, "titanbot-acme-roofing-sons");

    // THE WELCOME MAIL IS NOT DRAWN AS A GREEN LIGHT. This control plane sends no mail at all, so
    // the flag is accepted and the answer says plainly that nothing was sent and why. A tick here
    // would be a customer never hearing from anybody.
    assert.equal(answer.body.welcomeMail.sent, false);
    assert.equal(answer.body.welcomeMail.asked, true);
    assert.match(answer.body.welcomeMail.why, /sends no mail/);

    // No plan model was asked for and no relay is configured, so both of those say so rather than
    // claiming a success. Neither one fails the add.
    assert.equal(answer.body.planModel.applied, false);
    assert.match(answer.body.planModel.why, /no plan model was asked for/);
    assert.equal(answer.body.ceiling.applied, false);
    assert.match(answer.body.ceiling.why, /no relay configured|did not answer|relay/);
    assert.equal(answer.body.ceiling.asked, 40);
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
    assert.equal((await add(plane, { email: "jane@acme.com", company: "Acme" })).status, 201);
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
    assert.equal(answer.status, 201, answer.text);
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

test("a box that will not build keeps the account, and says which step stopped", async () => {
  await withPlane(async (plane, coolify) => {
    coolify.failOnce("POST /services", 500, "Coolify said no");
    const answer = await add(plane, { email: "jane@acme.com", company: "Acme" });

    // 201, NOT a 502. The account exists and the temporary password is shown once: an error status
    // that swallowed it would leave an operator holding a customer they cannot sign in as, with no
    // way to ask for the password again.
    assert.equal(answer.status, 201, answer.text);
    assert.equal(answer.body.state, "failed");
    assert.equal(answer.body.provisioning.ok, false);
    assert.equal(answer.body.provisioning.step.length > 0, true);
    assert.match(answer.body.message, /did not finish building/);
    assert.match(answer.body.message, /Press Provision/);

    // THE ACCOUNT STAYS. They can sign in, and one retry from the client's own row picks up where
    // it stopped.
    const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "jane@acme.com", password: answer.body.temporaryPassword } });
    assert.equal(signIn.status, 200, signIn.text);
    const clients = await plane.admin("GET", "/v1/admin/clients");
    assert.deepEqual(clients.body.clients.map((row) => row.slug), ["acme"]);
  });
});

test("a plan model that is not a plan model is said so rather than pointed at", async () => {
  await withPlane(async (plane) => {
    const answer = await add(plane, { email: "jane@acme.com", company: "Acme", planModel: "gpt-4" });
    assert.equal(answer.status, 201, answer.text);
    assert.equal(answer.body.planModel.applied, false);
    assert.match(answer.body.planModel.why, /not a plan model/);
    // The customer is still added, because a bad model choice is not a reason to lose a customer.
    assert.equal(answer.body.tenant.slug, "acme");
  });
});

test("a ceiling outside the range is refused without failing the add", async () => {
  await withPlane(async (plane) => {
    const answer = await add(plane, { email: "jane@acme.com", company: "Acme", ceiling: 5000 });
    assert.equal(answer.status, 201, answer.text);
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
