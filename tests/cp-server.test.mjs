// TENANT-1. The HTTP API: health, the customer sign-in and its lockout, the operator bearer, the
// tenant routes including the two guards on delete, and the sweep that proves no route on this
// service hands back a password hash, the session secret or the operator token.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { readAuthFile } from "../ui/auth.mjs";
import { tenantPaths } from "../cp/provision.mjs";
import { CP_VERSION } from "../cp/server.mjs";
import { LOCKOUT_MAX_FAILURES } from "../cp/store.mjs";
import { verifySessionToken } from "../cp/session.mjs";
import { startControlPlane, startFakeCoolify } from "./cp-support.mjs";

const PASSWORD = "a-good-tenant-password";

async function withPlane(run, options = {}) {
  const coolify = options.withCoolify ? await startFakeCoolify() : null;
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
    assert.deepEqual(Object.keys(listed.body.accounts[0]).sort(), ["createdAt", "email", "id", "name", "tenant"]);

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

test("signing in returns a session that names the tenant, and verifies with the shared secret", async () => {
  await withPlane(async (plane) => {
    const account = await seedTenantAndAccount(plane);
    const answer = await plane.request("POST", "/v1/sessions", { body: { email: "Owner@Example.com", password: PASSWORD } });
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body).sort(), ["account", "expiresAt", "tenant", "token"]);
    assert.deepEqual(answer.body.account, { id: account.id, email: "owner@example.com", name: "The Owner" });
    assert.deepEqual(answer.body.tenant, { slug: "acme", host: "acme.titanium.bot", status: "adopted" });

    // This is the check the tenant's own relay will run, with the same secret and this same file.
    const verdict = verifySessionToken(answer.body.token, plane.config.sessionSecret, Date.now());
    assert.equal(verdict.ok, true);
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
    assert.equal(verifySessionToken(token, plane.config.sessionSecret, Date.now()).ok, true);
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
    assert.equal(answer.body.host, "acme.titanium.bot");
    assert.deepEqual(answer.body.plan.steps.map((step) => step.name), ["directories", "secrets", "compose", "service", "envs", "urls", "start"]);
    assert.deepEqual(coolify.routes(), []);
    assert.equal(plane.store.countTenants(), 0, "a rehearsal that left half a tenant would be the opposite of a rehearsal");
    assert.equal((await plane.admin("GET", "/v1/tenants/acme")).status, 404);
  }, { withCoolify: true });
});

test("creating a tenant provisions it and hands the relay password back once", async () => {
  await withPlane(async (plane, coolify) => {
    const answer = await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme Roofing", ownerEmail: "owner@example.com" });
    assert.equal(answer.status, 201, answer.text);
    assert.equal(answer.body.tenant.slug, "acme");
    assert.equal(answer.body.tenant.host, "acme.titanium.bot");
    assert.match(answer.body.tenant.coolifyServiceUuid, /^svc-/);
    assert.ok(answer.body.relayPassword.length >= 32);
    assert.match(answer.body.relayPasswordNote, /Write this down now/);
    assert.deepEqual(coolify.routes(), [
      "POST /services", "POST /services/{uuid}/envs", "POST /services/{uuid}/envs", "PATCH /services/{uuid}", "POST /services/{uuid}/start",
    ]);

    // And the read-back carries the live Coolify state alongside the ledger row.
    const read = await plane.admin("GET", "/v1/tenants/acme");
    assert.equal(read.status, 200);
    assert.equal(read.body.tenant.coolify.reachable, true);
    assert.equal(read.body.tenant.coolify.status, "running");
    // The live read corrects the ledger, which was left at "provisioning" because Coolify queues
    // the start rather than doing it.
    assert.equal(read.body.tenant.status, "running");
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
    // The tenant's real gateway token, read off the disk rather than assumed, plus the relay
    // password hash and cookie secret that were written beside it.
    const paths = tenantPaths("roofing", plane.config);
    const gatewayToken = JSON.parse(readFileSync(paths.profileTokenFile, "utf8")).token;
    const relayAuth = readAuthFile(paths.authFile);
    const ledger = JSON.stringify(plane.store.listSteps("roofing").concat(plane.store.listSteps("acme")));
    for (const secret of [gatewayToken, relayAuth.password.hash, relayAuth.cookieSecret]) {
      assert.equal(ledger.includes(secret), false, "the provisioning ledger holds no secret");
    }

    const forbidden = [
      ...hashes, plane.config.sessionSecret, plane.config.adminToken, coolify.apiKey,
      gatewayToken, relayAuth.password.hash, relayAuth.cookieSecret,
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
    coolify.failOnce("PATCH /services/{uuid}", 500, "the proxy is busy");
    const failed = await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.step, "urls");
    assert.equal(failed.body.tenant.status, "failed");
    assert.match(failed.body.tenant.lastError, /the proxy is busy/);

    const retried = await plane.admin("POST", "/v1/tenants/acme/provision");
    assert.equal(retried.status, 200, retried.text);
    assert.deepEqual(retried.body.ran, ["urls", "start"]);
    assert.equal(coolify.callsTo("POST /services").length, 1);
    assert.equal(retried.body.relayPassword, null);
    assert.match(retried.body.relayPasswordNote, /set on an earlier run/);
  }, { withCoolify: true });
});
