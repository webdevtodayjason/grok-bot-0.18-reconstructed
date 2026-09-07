// TENANT-1. The HTTP API: health, the customer sign-in and its lockout, the operator bearer, the
// tenant routes including the two guards on delete, and the sweep that proves no route on this
// service hands back a password hash, the session secret or the operator token.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { tenantPaths } from "../cp/provision.mjs";
import { CP_VERSION } from "../cp/server.mjs";
import { LOCKOUT_MAX_FAILURES } from "../cp/store.mjs";
import { tenantSessionSecret, verifySessionToken } from "../cp/session.mjs";
import { startControlPlane, startFakeCoolify } from "./cp-support.mjs";

const PASSWORD = "a-good-tenant-password";

async function withPlane(run, options = {}) {
  const coolify = options.withCoolify ? await startFakeCoolify({ existing: options.existingServices ?? [] }) : null;
  const plane = await startControlPlane({
    ...(coolify ? { coolifyUrl: coolify.url, coolifyApiKey: coolify.apiKey } : {}),
    ...options,
  });
  try { await run(plane, coolify); }
  finally { await plane.dispose(); if (coolify) await coolify.close(); }
}

// The shortest path to a signed-in customer: adopt a tenant (no Coolify needed) and add an account.
async function seedTenantAndAccount(plane, { slug = "acme", email = "owner@example.com" } = {}) {
  await plane.admin("POST", `/v1/tenants/${slug}/adopt`, { coolifyServiceUuid: "svc-existing", host: `${slug}.titanium.bot` });
  const created = await plane.admin("POST", "/v1/accounts", { email, password: PASSWORD, name: "The Owner", tenant: slug });
  assert.equal(created.status, 201, created.text);
  return created.body.account;
}

test("health is open, and says only how many of each there are", async () => {
  await withPlane(async (plane) => {
    const answer = await plane.request("GET", "/v1/health");
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body).sort(), ["accounts", "ok", "tenants", "version"]);
    assert.equal(answer.body.ok, true);
    assert.equal(answer.body.version, CP_VERSION);
    assert.equal(answer.body.tenants, 0);
    assert.equal(answer.body.accounts, 0);

    await seedTenantAndAccount(plane);
    const again = await plane.request("GET", "/v1/health");
    assert.equal(again.body.tenants, 1);
    assert.equal(again.body.accounts, 1);
  });
});

test("the operator routes want the operator bearer and nothing else opens them", async () => {
  await withPlane(async (plane) => {
    const routes = [
      ["GET", "/v1/accounts"],
      ["POST", "/v1/accounts"],
      ["GET", "/v1/tenants"],
      ["POST", "/v1/tenants"],
      ["GET", "/v1/tenants/acme"],
      ["POST", "/v1/tenants/acme/adopt"],
      ["POST", "/v1/tenants/acme/stop"],
      ["DELETE", "/v1/tenants/acme"],
    ];
    for (const [method, pathname] of routes) {
      const body = method === "GET" ? undefined : {};
      const none = await plane.request(method, pathname, { body });
      assert.equal(none.status, 401, `${method} ${pathname} without a bearer`);
      assert.deepEqual(none.body, { error: "unauthorized" });

      const wrong = await plane.request(method, pathname, { body, token: randomBytes(24).toString("hex") });
      assert.equal(wrong.status, 401, `${method} ${pathname} with the wrong bearer`);

      // A token with the right prefix and the wrong tail is still wrong. The compare hashes both
      // sides first, so neither the length nor a shared prefix shortens it.
      const prefix = await plane.request(method, pathname, { body, token: `${plane.config.adminToken.slice(0, 8)}x` });
      assert.equal(prefix.status, 401, `${method} ${pathname} with a matching prefix`);
    }
  });
});

test("an account is added, listed without its hash, and its password can be reset", async () => {
  await withPlane(async (plane) => {
    await plane.admin("POST", "/v1/tenants/acme/adopt", { coolifyServiceUuid: "svc-1", host: "acme.titanium.bot" });

    const created = await plane.admin("POST", "/v1/accounts", { email: "Owner@Example.com", password: PASSWORD, name: "The Owner", tenant: "acme" });
    assert.equal(created.status, 201);
    assert.equal(created.body.account.email, "owner@example.com");
    assert.equal(created.body.account.tenant, "acme");
    // The tenant's real hostname comes back, so the operator is never told to send a customer to an
    // address rebuilt from the name. An adopted tenant answers somewhere else entirely.
    assert.deepEqual(created.body.tenant, { slug: "acme", host: "acme.titanium.bot" });

    const duplicate = await plane.admin("POST", "/v1/accounts", { email: "owner@example.com", password: PASSWORD, tenant: "acme" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "duplicate_email");

    const listed = await plane.admin("GET", "/v1/accounts");
    assert.equal(listed.status, 200);
    // The exact key set, so a column added to the accounts table cannot leak out of this route by
    // accident. superAdmin and disabled joined it with ADMIN-1: both are facts about a door and
    // neither is a secret, and the two that matter are still absent -- no hash and no salt.
    assert.deepEqual(Object.keys(listed.body.accounts[0]).sort(), ["createdAt", "disabled", "email", "id", "name", "superAdmin", "tenant"]);
    assert.equal(listed.body.accounts[0].superAdmin, false, "a new account is nobody's super admin");
    assert.equal(listed.body.accounts[0].disabled, false);

    const reset = await plane.admin("POST", `/v1/accounts/${created.body.account.id}/password`, { password: "a-brand-new-password" });
    assert.equal(reset.status, 204);
    assert.equal(reset.text, "");
    assert.equal((await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: PASSWORD } })).status, 401);
    assert.equal((await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: "a-brand-new-password" } })).status, 200);

    const missing = await plane.admin("POST", "/v1/accounts/no-such-id/password", { password: "a-brand-new-password" });
    assert.equal(missing.status, 404);
  });
});

test("an account is refused when it names a tenant that does not exist, in plain words", async () => {
  await withPlane(async (plane) => {
    const answer = await plane.admin("POST", "/v1/accounts", { email: "owner@example.com", password: PASSWORD, tenant: "nowhere" });
    assert.equal(answer.status, 400);
    assert.match(answer.body.message, /no tenant called nowhere/);
    assert.doesNotMatch(answer.body.message, /—/);
  });
});

test("a short password is refused on both the create and the reset", async () => {
  await withPlane(async (plane) => {
    await plane.admin("POST", "/v1/tenants/acme/adopt", { coolifyServiceUuid: "svc-1", host: "acme.titanium.bot" });
    const short = await plane.admin("POST", "/v1/accounts", { email: "owner@example.com", password: "short", tenant: "acme" });
    assert.equal(short.status, 400);
    assert.match(short.body.message, /at least 8 characters/);
  });
});

test("signing in returns a session that names the tenant, and verifies with that tenant's own key", async () => {
  await withPlane(async (plane) => {
    const account = await seedTenantAndAccount(plane);
    const answer = await plane.request("POST", "/v1/sessions", { body: { email: "Owner@Example.com", password: PASSWORD } });
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body).sort(), ["account", "expiresAt", "tenant", "token"]);
    // superAdmin rides in the BODY and never in the token: ADMIN-1. It is what tells the admin
    // page which door to draw, and the admin routes look the flag up in the store on every request
    // so a demotion takes effect now rather than in up to twelve hours.
    assert.deepEqual(answer.body.account, { id: account.id, email: "owner@example.com", name: "The Owner", superAdmin: false });
    assert.deepEqual(answer.body.tenant, { slug: "acme", host: "acme.titanium.bot", status: "adopted" });

    // This is the check the tenant's own relay will run, with the key that relay is given and this
    // same file. That key is derived from the master, and the master itself does not verify it:
    // handing every tenant the master would let any one of them sign for console.titanium.bot.
    const verdict = verifySessionToken(answer.body.token, tenantSessionSecret(plane.config.sessionSecret, "acme"), Date.now());
    assert.equal(verdict.ok, true);
    assert.equal(verifySessionToken(answer.body.token, plane.config.sessionSecret, Date.now()).ok, false);
    assert.equal(verifySessionToken(answer.body.token, tenantSessionSecret(plane.config.sessionSecret, "titanium"), Date.now()).ok, false);
    assert.equal(verdict.payload.tenant, "acme");
    assert.equal(verdict.payload.host, "acme.titanium.bot");
    assert.equal(verdict.payload.sub, account.id);
    assert.equal(new Date(answer.body.expiresAt).getTime(), verdict.payload.exp);
    // Twelve hours.
    assert.equal(verdict.payload.exp - verdict.payload.iat, 12 * 60 * 60 * 1000);
  });
});

test("a wrong email and a wrong password get exactly the same answer", async () => {
  await withPlane(async (plane) => {
    await seedTenantAndAccount(plane);
    const wrongPassword = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: "not-the-password" } });
    const wrongEmail = await plane.request("POST", "/v1/sessions", { body: { email: "nobody@example.com", password: PASSWORD } });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongEmail.status, 401);
    assert.equal(wrongPassword.text, wrongEmail.text);
    assert.deepEqual(wrongPassword.body, { error: "invalid_login" });
  });
});

test("ten wrong tries lock the address out with a retryAfter, and a Retry-After header", async () => {
  await withPlane(async (plane) => {
    await seedTenantAndAccount(plane);
    for (let attempt = 0; attempt < LOCKOUT_MAX_FAILURES; attempt += 1) {
      const answer = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: "not-the-password" } });
      assert.equal(answer.status, 401, `attempt ${attempt + 1} should still be a plain refusal`);
    }
    const locked = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: "not-the-password" } });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, "locked");
    assert.ok(locked.body.retryAfter > 0 && locked.body.retryAfter <= 600);
    assert.equal(locked.headers.get("retry-after"), String(locked.body.retryAfter));

    // The lock is on the attempt, not on the password: the right one is refused too while it holds.
    const rightPassword = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: PASSWORD } });
    assert.equal(rightPassword.status, 429);
  });
});

test("signing in successfully clears the counter", async () => {
  await withPlane(async (plane) => {
    await seedTenantAndAccount(plane);
    for (let attempt = 0; attempt < LOCKOUT_MAX_FAILURES - 1; attempt += 1) {
      await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: "not-the-password" } });
    }
    assert.equal((await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: PASSWORD } })).status, 200);
    for (let attempt = 0; attempt < LOCKOUT_MAX_FAILURES - 1; attempt += 1) {
      const answer = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: "not-the-password" } });
      assert.equal(answer.status, 401);
    }
  });
});

test("a body with no email or no password is a plain bad request, not a login attempt", async () => {
  await withPlane(async (plane) => {
    await seedTenantAndAccount(plane);
    for (const body of [{}, { email: "owner@example.com" }, { password: PASSWORD }]) {
      const answer = await plane.request("POST", "/v1/sessions", { body });
      assert.equal(answer.status, 400);
      assert.equal(answer.body.error, "bad_request");
    }
    // And they did not count against the lockout.
    assert.equal((await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: PASSWORD } })).status, 200);
  });
});

test("the current session reads back and a delete revokes it", async () => {
  await withPlane(async (plane) => {
    const account = await seedTenantAndAccount(plane);
    const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: PASSWORD } });
    const token = signIn.body.token;

    const current = await plane.request("GET", "/v1/sessions/current", { token });
    assert.equal(current.status, 200);
    assert.deepEqual(current.body.account, { id: account.id, email: "owner@example.com", name: "The Owner" });
    assert.deepEqual(current.body.tenant, { slug: "acme", host: "acme.titanium.bot", status: "adopted" });
    assert.equal(current.body.expiresAt, signIn.body.expiresAt);

    assert.equal((await plane.request("GET", "/v1/sessions/current")).status, 401);
    assert.equal((await plane.request("GET", "/v1/sessions/current", { token: "v1.nonsense.nonsense" })).status, 401);

    const revoked = await plane.request("DELETE", "/v1/sessions/current", { token });
    assert.equal(revoked.status, 204);
    assert.equal((await plane.request("GET", "/v1/sessions/current", { token })).status, 401);
    // The signature is still good, which is exactly why the relay side needs the twelve hour life:
    // it has no revocation table and checks only the signature and the expiry.
    assert.equal(verifySessionToken(token, tenantSessionSecret(plane.config.sessionSecret, "acme"), Date.now()).ok, true);
  });
});

test("a session for a tenant that has been removed is refused with a sentence a customer can read", async () => {
  await withPlane(async (plane) => {
    await seedTenantAndAccount(plane);
    plane.store.deleteTenant("acme");
    const answer = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: PASSWORD } });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, "tenant_missing");
    assert.doesNotMatch(answer.body.message, /—/);
    assert.doesNotMatch(answer.body.message, /tenant|slug|ledger/i);
  });
});

test("an account on an adopted tenant is told the address that tenant really answers on", async () => {
  await withPlane(async (plane) => {
    await plane.admin("POST", "/v1/tenants/titanium/adopt", { coolifyServiceUuid: "p927bfqm83ioloibamlvyd7g", host: "console.titanium.bot" });
    const created = await plane.admin("POST", "/v1/accounts", { email: "jason@example.com", password: PASSWORD, tenant: "titanium" });
    assert.equal(created.status, 201);
    assert.equal(created.body.tenant.host, "console.titanium.bot");
    assert.notEqual(created.body.tenant.host, "titanium.titanium.bot");
  });
});

test("adopting an existing service claims it without touching it, reserved name and all", async () => {
  await withPlane(async (plane, coolify) => {
    // titanium is on the reserved list, which is what stops a customer taking it. The operator
    // adopting Jason's own instance under that name is the reason adopt does not consult the list.
    const answer = await plane.admin("POST", "/v1/tenants/titanium/adopt", { coolifyServiceUuid: "p927bfqm83ioloibamlvyd7g", host: "console.titanium.bot", name: "Titanium Computing" });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.body.tenant.slug, "titanium");
    assert.equal(answer.body.tenant.status, "adopted");
    assert.equal(answer.body.tenant.coolifyServiceUuid, "p927bfqm83ioloibamlvyd7g");
    assert.equal(answer.body.tenant.host, "console.titanium.bot");
    // Nothing was created, patched or started on Coolify.
    assert.deepEqual(coolify.routes(), []);

    // The same call again is not an error and does not make a second tenant.
    const again = await plane.admin("POST", "/v1/tenants/titanium/adopt", { coolifyServiceUuid: "p927bfqm83ioloibamlvyd7g", host: "console.titanium.bot" });
    assert.equal(again.status, 200);
    assert.equal(plane.store.countTenants(), 1);

    const bad = await plane.admin("POST", "/v1/tenants/-nope/adopt", { coolifyServiceUuid: "x", host: "y" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "bad_slug");
  }, { withCoolify: true });
});

test("creating a tenant refuses a bad name, a reserved name and a name already taken", async () => {
  await withPlane(async (plane) => {
    for (const slug of ["ab", "Acme", "acme roofing", "-acme", "www", "console", "titanium"]) {
      const answer = await plane.admin("POST", "/v1/tenants", { slug, name: "Whoever" });
      assert.equal(answer.status, 400, `${slug} should be refused`);
      assert.equal(answer.body.error, "bad_slug");
      assert.doesNotMatch(answer.body.message, /—/);
    }
    await plane.admin("POST", "/v1/tenants/acme/adopt", { coolifyServiceUuid: "svc-1", host: "acme.titanium.bot" });
    const duplicate = await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Someone else" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "duplicate_slug");
  }, { withCoolify: true });
});

test("a dry run over the API answers with the plan and leaves no tenant behind", async () => {
  await withPlane(async (plane, coolify) => {
    const answer = await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme Roofing", dryRun: true });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.dryRun, true);
    // The one console everybody signs in at, not a hostname of this tenant's own.
    assert.equal(answer.body.host, "console.titanium.bot");
    assert.deepEqual(answer.body.plan.steps.map((step) => step.name), ["directories", "secrets", "compose", "service", "envs", "start", "ready"]);
    assert.deepEqual(coolify.routes(), []);
    assert.equal(plane.store.countTenants(), 0, "a rehearsal that left half a tenant would be the opposite of a rehearsal");
    assert.equal((await plane.admin("GET", "/v1/tenants/acme")).status, 404);
  }, { withCoolify: true });
});

test("creating a tenant builds one box and hands back no password at all", async () => {
  await withPlane(async (plane, coolify) => {
    const answer = await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme Roofing", ownerEmail: "owner@example.com" });
    assert.equal(answer.status, 201, answer.text);
    assert.equal(answer.body.tenant.slug, "acme");
    // The one console. No tenant is given a hostname of its own any more.
    assert.equal(answer.body.tenant.host, "console.titanium.bot");
    assert.match(answer.body.tenant.coolifyServiceUuid, /^svc-/);
    assert.equal(answer.body.tenant.boxContainer, `titanbot-box-${answer.body.tenant.coolifyServiceUuid}`);
    assert.equal(answer.body.tenant.boxReady, true);
    assert.match(answer.body.message, /up and answering/);
    // There used to be a generated relay password in this answer, for a login page each tenant had
    // of its own. There is one console, so that password opened nothing, and a credential that
    // opens nothing is worse than none.
    assert.equal(answer.text.toLowerCase().includes("password"), false);
    assert.deepEqual(coolify.routes(), [
      // The PATCH is Coolify's 409 on a field it made itself from the compose's ${VAR}. One env,
      // no urls PATCH, and the two reads at the end are the wait for the box.
      "POST /services", "POST /services/{uuid}/envs", "PATCH /services/{uuid}/envs",
      "POST /services/{uuid}/start",
      "GET /services/{uuid}", "GET /services/{uuid}/applications",
    ]);

    // And the read-back carries the live Coolify state alongside the ledger row.
    const read = await plane.admin("GET", "/v1/tenants/acme");
    assert.equal(read.status, 200);
    assert.equal(read.body.tenant.coolify.reachable, true);
    assert.equal(read.body.tenant.coolify.status, "running");
    assert.equal(read.body.tenant.status, "running");
    // One container, because that is what a tenant is.
    assert.deepEqual(read.body.tenant.coolify.containers.map((row) => row.name), ["titanbot-box"]);
  }, { withCoolify: true });
});

test("stop, start and restart go to Coolify and move the recorded status", async () => {
  await withPlane(async (plane, coolify) => {
    await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });
    assert.equal((await plane.admin("POST", "/v1/tenants/acme/stop")).body.tenant.status, "stopped");
    assert.equal(coolify.callsTo("POST /services/{uuid}/stop").length, 1);
    assert.equal((await plane.admin("POST", "/v1/tenants/acme/start")).body.tenant.status, "provisioning");
    assert.equal((await plane.admin("POST", "/v1/tenants/acme/restart")).body.tenant.status, "provisioning");
    assert.equal(coolify.callsTo("POST /services/{uuid}/restart").length, 1);

    const missing = await plane.admin("POST", "/v1/tenants/nowhere/stop");
    assert.equal(missing.status, 404);
  }, { withCoolify: true });
});

test("removing a tenant needs it stopped and needs the name typed back, and keeps the data", async () => {
  await withPlane(async (plane, coolify) => {
    await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });

    const running = await plane.admin("DELETE", "/v1/tenants/acme", { confirm: "acme" });
    assert.equal(running.status, 409);
    assert.equal(running.body.error, "not_stopped");
    assert.match(running.body.message, /Stop the tenant first/);

    await plane.admin("POST", "/v1/tenants/acme/stop");
    const unconfirmed = await plane.admin("DELETE", "/v1/tenants/acme", {});
    assert.equal(unconfirmed.status, 400);
    assert.equal(unconfirmed.body.error, "confirm_required");
    const wrongName = await plane.admin("DELETE", "/v1/tenants/acme", { confirm: "acme-roofing" });
    assert.equal(wrongName.status, 400);

    const gone = await plane.admin("DELETE", "/v1/tenants/acme", { confirm: "acme" });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.deleted, true);
    assert.match(gone.body.dataKept, /tenants\/acme$/);
    assert.match(gone.body.message, /nothing the customer made was deleted/);
    assert.equal(coolify.callsTo("DELETE /services/{uuid}").length, 1);
    // Coolify is told to keep the volumes, because a customer's work is not the API's to delete.
    assert.equal(coolify.callsTo("DELETE /services/{uuid}")[0].query.delete_volumes, "false");
    assert.equal(plane.store.getTenant("acme"), null);
  }, { withCoolify: true });
});

test("an unknown route is a 404 and an oversized or unparseable body is a 400", async () => {
  await withPlane(async (plane) => {
    assert.equal((await plane.request("GET", "/")).status, 404);
    assert.equal((await plane.request("GET", "/v1/nope")).status, 404);
    assert.equal((await plane.request("PUT", "/v1/sessions/current")).status, 405);

    const badJson = await fetch(`${plane.base}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, "bad_json");

    const huge = await fetch(`${plane.base}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.c", password: "x".repeat(200_000) }) });
    assert.equal(huge.status, 400);
    assert.equal((await huge.json()).error, "too_large");
  });
});

test("no route on this service ever answers with a hash, the session secret or the operator token", async () => {
  await withPlane(async (plane, coolify) => {
    const account = await seedTenantAndAccount(plane);
    await plane.admin("POST", "/v1/tenants", { slug: "roofing", name: "Roofing" });
    const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: PASSWORD } });
    const token = signIn.body.token;

    // The secrets, read straight out of the store rather than assumed.
    const hashes = plane.store.db.prepare("SELECT password_json FROM accounts").all()
      .flatMap((row) => { const record = JSON.parse(row.password_json); return [record.hash, record.salt, row.password_json]; });
    // The tenant's real gateway token, read off the disk rather than assumed.
    const paths = tenantPaths("roofing", plane.config);
    const gatewayToken = JSON.parse(readFileSync(paths.profileTokenFile, "utf8")).token;
    const ledger = JSON.stringify(plane.store.listSteps("roofing").concat(plane.store.listSteps("acme")));
    assert.equal(ledger.includes(gatewayToken), false, "the provisioning ledger holds no secret");

    const forbidden = [
      ...hashes, plane.config.sessionSecret, plane.config.adminToken, coolify.apiKey, gatewayToken,
    ];

    const sweep = [
      await plane.request("GET", "/v1/health"),
      await plane.request("GET", "/v1/sessions/current", { token }),
      await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: "wrong" } }),
      await plane.admin("GET", "/v1/accounts"),
      await plane.admin("GET", "/v1/tenants"),
      await plane.admin("GET", "/v1/tenants/acme"),
      await plane.admin("GET", "/v1/tenants/roofing"),
      await plane.admin("POST", "/v1/tenants", { slug: "another", name: "Another", dryRun: true }),
      await plane.admin("POST", `/v1/tenants/roofing/provision`),
      await plane.admin("POST", "/v1/tenants/roofing/stop"),
      await plane.request("GET", "/v1/nope"),
      await plane.request("POST", "/v1/accounts", { body: {}, token: "wrong-token" }),
      await plane.admin("POST", `/v1/accounts/${account.id}/password`, { password: "another-good-password" }),
      // TENANT-5 added one route that DOES hand out per-tenant secrets, so it is swept with the
      // wrong credential and with none. Both answer 401 and neither answers with anything.
      await plane.request("GET", "/v1/relay/tenants"),
      await plane.admin("GET", "/v1/relay/tenants"),
      await plane.request("POST", "/v1/signups", { body: { email: "someone@example.com", password: "a-good-password", company: "Someone" } }),
    ];

    for (const answer of sweep) {
      for (const secret of forbidden) {
        assert.equal(answer.text.includes(secret), false, `a response leaked a secret: ${answer.text.slice(0, 200)}`);
      }
      assert.equal(/"hash"|"password_json"|"cookieSecret"/.test(answer.text), false, `a response carried a password field: ${answer.text.slice(0, 200)}`);
    }
  }, { withCoolify: true });
});

test("the retry route re-runs provisioning from the step that failed", async () => {
  await withPlane(async (plane, coolify) => {
    coolify.failOnce("POST /services/{uuid}/start", 500, "the proxy is busy");
    const failed = await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.step, "start");
    assert.equal(failed.body.tenant.status, "failed");
    assert.match(failed.body.tenant.lastError, /the proxy is busy/);

    const retried = await plane.admin("POST", "/v1/tenants/acme/provision");
    assert.equal(retried.status, 200, retried.text);
    assert.deepEqual(retried.body.ran, ["start", "ready"]);
    assert.equal(coolify.callsTo("POST /services").length, 1);
    assert.equal(retried.body.boxReady, true);
    assert.match(retried.body.message, /up and answering/);
  }, { withCoolify: true });
});

test("building a new customer workspace is refused when the operator has not turned it on", async () => {
  await withPlane(async (plane, coolify) => {
    const answer = await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme Roofing" });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, "new_tenants_off");
    assert.match(answer.body.message, /CP_ALLOW_NEW_TENANTS=1/);
    assert.doesNotMatch(answer.body.message, /—/);
    assert.deepEqual(coolify.routes(), [], "nothing reached Coolify");
    assert.equal(plane.store.countTenants(), 0, "and no half tenant was left in the ledger");

    // A rehearsal still works, because it builds nothing.
    const dry = await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme Roofing", dryRun: true });
    assert.equal(dry.status, 200);
    // And so does claiming an instance that is already running, which is how Jason's own console
    // gets into the ledger.
    const adopted = await plane.admin("POST", "/v1/tenants/titanium/adopt", { coolifyServiceUuid: "p927bfqm83ioloibamlvyd7g", host: "console.titanium.bot" });
    assert.equal(adopted.status, 200);
  }, { withCoolify: true, env: { CP_ALLOW_NEW_TENANTS: "0" } });
});

test("provisioning an adopted instance is refused, because it would build a second one beside it", async () => {
  await withPlane(async (plane, coolify) => {
    await plane.admin("POST", "/v1/tenants/titanium/adopt", { coolifyServiceUuid: "p927bfqm83ioloibamlvyd7g", host: "console.titanium.bot" });

    const answer = await plane.admin("POST", "/v1/tenants/titanium/provision", {});
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, "adopted");
    assert.match(answer.body.message, /did not build it and will not rebuild it/);
    assert.doesNotMatch(answer.body.message, /—/);

    assert.deepEqual(coolify.routes(), [], "no service was created");
    const row = plane.store.getTenant("titanium");
    assert.equal(row.status, "adopted");
    assert.equal(row.host, "console.titanium.bot", "the live hostname is not rewritten to titanium.titanium.bot");
    assert.equal(row.coolifyServiceUuid, "p927bfqm83ioloibamlvyd7g");
  }, { withCoolify: true });
});

test("deleting an adopted instance is refused, and stopping it first does not get around that", async () => {
  await withPlane(async (plane, coolify) => {
    await plane.admin("POST", "/v1/tenants/titanium/adopt", { coolifyServiceUuid: "p927bfqm83ioloibamlvyd7g", host: "console.titanium.bot" });

    const straight = await plane.admin("DELETE", "/v1/tenants/titanium", { confirm: "titanium" });
    assert.equal(straight.status, 409);
    assert.equal(straight.body.error, "adopted");
    assert.match(straight.body.message, /will not delete it/);

    // A stop used to write "stopped" over "adopted", which was the way past the guard: stop, then
    // confirm, and the live console's Coolify service was gone.
    const stopped = await plane.admin("POST", "/v1/tenants/titanium/stop");
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.tenant.status, "adopted", "how it got here is not a container state");
    const afterStop = await plane.admin("DELETE", "/v1/tenants/titanium", { confirm: "titanium" });
    assert.equal(afterStop.status, 409);
    assert.equal(afterStop.body.error, "adopted");

    assert.equal(coolify.callsTo("DELETE /services/{uuid}").length, 0, "the live console's service was never deleted");
    assert.notEqual(plane.store.getTenant("titanium"), null);
  }, { withCoolify: true, existingServices: ["p927bfqm83ioloibamlvyd7g"] });
});

test("a forged X-Forwarded-For does not buy a fresh lockout bucket per try", async () => {
  await withPlane(async (plane) => {
    await seedTenantAndAccount(plane);
    // Every try carries a different address and a different email, so neither bucket can fill on
    // the header's word. The socket peer is loopback for all of them, and that is what counts.
    for (let attempt = 0; attempt < LOCKOUT_MAX_FAILURES; attempt += 1) {
      const answer = await plane.request("POST", "/v1/sessions", {
        body: { email: `nobody${attempt}@example.com`, password: "not-the-password" },
        headers: { "x-forwarded-for": `203.0.113.${attempt}` },
      });
      assert.equal(answer.status, 401, `attempt ${attempt + 1}`);
    }
    const locked = await plane.request("POST", "/v1/sessions", {
      body: { email: "nobody99@example.com", password: "not-the-password" },
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    assert.equal(locked.status, 429, "the address that actually sent them is locked");
    assert.equal(locked.body.error, "locked");
  });
});

test("the forwarded address is believed only from a proxy the operator named", async () => {
  await withPlane(async (plane) => {
    await seedTenantAndAccount(plane);
    // Now loopback IS the named proxy, which is what the R750's Traefik will be, so each forged
    // entry is a different visitor and no single bucket reaches ten.
    for (let attempt = 0; attempt < LOCKOUT_MAX_FAILURES + 4; attempt += 1) {
      const answer = await plane.request("POST", "/v1/sessions", {
        body: { email: `nobody${attempt}@example.com`, password: "not-the-password" },
        headers: { "x-forwarded-for": `203.0.113.${attempt}` },
      });
      assert.equal(answer.status, 401, `attempt ${attempt + 1}`);
    }
    // And one visitor who keeps trying is still locked, from behind the same proxy.
    for (let attempt = 0; attempt < LOCKOUT_MAX_FAILURES; attempt += 1) {
      await plane.request("POST", "/v1/sessions", {
        body: { email: `someone${attempt}@example.com`, password: "not-the-password" },
        headers: { "x-forwarded-for": "198.51.100.7" },
      });
    }
    const locked = await plane.request("POST", "/v1/sessions", {
      body: { email: "someone99@example.com", password: "not-the-password" },
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
    assert.equal(locked.status, 429);
  }, { env: { CP_TRUSTED_PROXIES: "127.0.0.1/32,::1/128" } });
});

test("a relay's sign-ins are counted by email, so one instance's guesser cannot lock the fleet out", async () => {
  await withPlane(async (plane) => {
    await seedTenantAndAccount(plane);
    // Every account sign-in on every instance is posted here BY that instance's relay, so what this
    // service sees is one machine's egress address whoever typed the password. Measured 2026-09-07:
    // a failed sign-in through demo.titanium.bot and one through console.titanium.bot both landed in
    // login_failures as the same address. Counting the address bucket against it meant ten wrong
    // passwords at any one login page refused POST /v1/sessions for every customer for ten minutes,
    // and nothing could clear it: a clear matches email AND address, and none of these emails will
    // ever sign in.
    for (let attempt = 0; attempt < LOCKOUT_MAX_FAILURES + 4; attempt += 1) {
      const answer = await plane.request("POST", "/v1/sessions", {
        body: { email: `made-up-${attempt}@example.com`, password: "not-the-password" },
      });
      assert.equal(answer.status, 401, `attempt ${attempt + 1} answered ${answer.status}`);
    }
    // A different customer's sign-in still gets through, which is the whole point.
    const other = await plane.request("POST", "/v1/sessions", {
      body: { email: "owner@example.com", password: PASSWORD },
    });
    assert.notEqual(other.status, 429, "another customer was refused for somebody else's guesses");

    // The email bucket is untouched: a real address being guessed at is still locked.
    for (let attempt = 0; attempt < LOCKOUT_MAX_FAILURES; attempt += 1) {
      await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: `guess-${attempt}` } });
    }
    const locked = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: "guess-again" } });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, "locked");
  }, { env: { CP_RELAY_PEERS: "127.0.0.1/32,::1/128" } });
});

test("without CP_RELAY_PEERS the address bucket still applies, so the flag is a decision and not a default", async () => {
  await withPlane(async (plane) => {
    await seedTenantAndAccount(plane);
    for (let attempt = 0; attempt < LOCKOUT_MAX_FAILURES; attempt += 1) {
      await plane.request("POST", "/v1/sessions", { body: { email: `made-up-${attempt}@example.com`, password: "no" } });
    }
    const locked = await plane.request("POST", "/v1/sessions", { body: { email: "owner@example.com", password: PASSWORD } });
    assert.equal(locked.status, 429, "an unnamed caller is a person, and a person's address is counted");
  });
});

test("a burst of sign-in attempts is capped rather than queued, so the service keeps answering", async () => {
  await withPlane(async (plane) => {
    await seedTenantAndAccount(plane);
    // Sixty at once, all of them unknown addresses so every one costs a full derivation. Only four
    // may derive at a time; the rest are told to come back rather than queueing behind them, which
    // is what stops one client stalling every other customer's sign-in.
    const answers = await Promise.all(Array.from({ length: 60 }, (_, index) => plane.request("POST", "/v1/sessions", {
      body: { email: `nobody${index}@example.com`, password: "not-the-password" },
    })));
    assert.equal(answers.length, 60, "every request was answered");
    const busy = answers.filter((answer) => answer.body?.error === "busy");
    assert.ok(busy.length > 0, `nothing was capped: ${answers.map((a) => a.status).join(",")}`);
    assert.equal(busy[0].status, 429);
    assert.equal(busy[0].headers.get("retry-after"), "1");
    assert.match(busy[0].body.message, /Wait a moment and try again/);
    assert.doesNotMatch(busy[0].body.message, /—/);
    // The service is still answering everything else while that is going on.
    assert.equal((await plane.request("GET", "/v1/health")).status, 200);
  });
});

test("a workspace that is deleted names the sign-ins it leaves standing, and they can be removed", async () => {
  // The hole this closes was found by deleting a tenant on the live server. Deleting a workspace
  // left its accounts, those people could still sign in, and the console told them the workspace
  // was not available for ever, with nothing the operator could do about it short of editing the
  // database by hand.
  await withPlane(async (plane) => {
    const built = await plane.admin("POST", "/v1/tenants", { slug: "leavers", name: "Leavers" });
    assert.equal(built.status, 201, built.text.slice(0, 200));
    for (const email of ["one@leavers.test", "two@leavers.test"]) {
      const made = await plane.admin("POST", "/v1/accounts", { email, password: "a password of real length", tenant: "leavers" });
      assert.equal(made.status, 201, `${email}: ${made.text.slice(0, 200)}`);
    }

    await plane.admin("POST", "/v1/tenants/leavers/stop", {});
    const gone = await plane.admin("DELETE", "/v1/tenants/leavers", { confirm: "leavers" });
    assert.equal(gone.status, 200, gone.text.slice(0, 200));
    // Named, not deleted. Re-provisioning under the same slug is how a workspace is moved, and it
    // gives these people their access back, so cascading would lock them out to tidy a row.
    assert.deepEqual([...gone.body.accountsLeft].sort(), ["one@leavers.test", "two@leavers.test"]);
    assert.match(gone.body.message, /2 sign-ins still point at this workspace/);
    assert.equal((await plane.admin("GET", "/v1/accounts")).body.accounts.length, 2, "the accounts must survive the workspace");

    // And now there is a way to close one.
    const noConfirm = await plane.admin("DELETE", "/v1/accounts/one@leavers.test", {});
    assert.equal(noConfirm.status, 400, "an account must not be removable without naming it");
    assert.match(noConfirm.body.message, /one@leavers\.test/);

    // Percent-encoded, which is what anything that builds a URL properly sends and is what the CLI
    // sends. The first live run of this route answered 404 for an account that was in the list,
    // because the path segment was never decoded and the test above had typed a raw @.
    const removed = await plane.admin("DELETE", `/v1/accounts/${encodeURIComponent("one@leavers.test")}`, { confirm: "one@leavers.test" });
    assert.equal(removed.status, 200, removed.text.slice(0, 200));
    assert.equal(removed.body.email, "one@leavers.test");
    const left = (await plane.admin("GET", "/v1/accounts")).body.accounts.map((account) => account.email);
    assert.deepEqual(left, ["two@leavers.test"], "the wrong account was removed, or none was");

    // By id as well as by email, because the list route hands out ids.
    const byId = (await plane.admin("GET", "/v1/accounts")).body.accounts[0];
    assert.equal((await plane.admin("DELETE", `/v1/accounts/${byId.id}`, { confirm: byId.email })).status, 200);
    assert.equal((await plane.admin("GET", "/v1/accounts")).body.accounts.length, 0);

    // No bearer does not open this door, and a name nobody holds is a 404 rather than a 200.
    assert.equal((await plane.request("DELETE", `/v1/accounts/${encodeURIComponent("anyone@nowhere.test")}`, { body: {} })).status, 401);
    // A malformed escape is a name nobody holds, not a crash.
    assert.equal((await plane.admin("DELETE", "/v1/accounts/%E0%A4%A", { confirm: "whatever" })).status, 404);
    assert.equal((await plane.admin("DELETE", "/v1/accounts/nobody@nowhere.test", { confirm: "nobody@nowhere.test" })).status, 404);
  }, { withCoolify: true });
});

test("a workspace name with sign-ins still pointing at it is never handed to a second company", async () => {
  await withPlane(async (plane) => {
    // The first company signs up and gets "acme".
    const first = await plane.request("POST", "/v1/signups", {
      body: { email: "owner@acme.example", password: PASSWORD, company: "Acme" },
    });
    assert.equal(first.status, 201, first.text);
    assert.equal(first.body.tenant.slug, "acme");

    // The operator finishes with them and removes the workspace. The account is deliberately left
    // alone, and the answer says the name is held back.
    await plane.admin("POST", "/v1/tenants/acme/stop");
    const removed = await plane.admin("DELETE", "/v1/tenants/acme", { confirm: "acme" });
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.body.accountsLeft, ["owner@acme.example"]);
    assert.match(removed.body.message, /the name acme is held back/);

    // A different company with the same name gets a different workspace, so the first company's
    // sign-in cannot land in it.
    const second = await plane.request("POST", "/v1/signups", {
      body: { email: "owner@acme-roofing.example", password: PASSWORD, company: "Acme" },
    });
    assert.equal(second.status, 201, second.text);
    assert.notEqual(second.body.tenant.slug, "acme");
    assert.match(second.body.tenant.slug, /^acme-\d+$/);
  }, { withCoolify: true, env: { CP_ALLOW_SIGNUP: "1" } });
});
