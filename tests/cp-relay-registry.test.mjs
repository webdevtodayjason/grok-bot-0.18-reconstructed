// TENANT-5, the control plane's half. Two new doors and one changed shape:
//
//   GET /v1/relay/tenants   what the one console relay needs to serve one customer's request. It
//                           is the only route on this service that answers with a per-tenant
//                           gateway token and a per-tenant derived session key, so most of this
//                           file is about who can open it and what is in the answer. The header of
//                           cp/server.mjs amends its own "never returns a secret" rule for exactly
//                           this route; these are the tests that amendment names.
//   POST /v1/signups        one request turns a company into a customer: an account, a workspace
//                           name derived from the company name, and the box being built.
//
// Nothing here touches a real Coolify, a real docker or a real network. The fake Coolify answers
// the way the openapi says, and every secret is generated for the run and thrown away with the
// temporary directory.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  boxContainerName,
  ensureProxyKey,
  proxyKeyFileIn,
  readProxyKey,
  tenantPaths,
  tenantProfileDir,
} from "../cp/provision.mjs";
import { tenantSessionSecret } from "../cp/session.mjs";
import { startControlPlane, startFakeCoolify } from "./cp-support.mjs";
import { startFakeProxy } from "./cp-proxy-support.mjs";

const PASSWORD = "a-good-tenant-password";
const RELAY_TOKEN = randomBytes(32).toString("hex");

async function withPlane(run, options = {}) {
  const coolify = options.withCoolify === false ? null : await startFakeCoolify({ existing: options.existingServices ?? [] });
  const plane = await startControlPlane({
    ...(coolify ? { coolifyUrl: coolify.url, coolifyApiKey: coolify.apiKey } : {}),
    ...options,
    env: { CP_RELAY_TOKEN: RELAY_TOKEN, ...(options.env ?? {}) },
  });
  try { await run(plane, coolify); }
  finally { await plane.dispose(); if (coolify) await coolify.close(); }
}

const asRelay = (plane, token = RELAY_TOKEN) => plane.request("GET", "/v1/relay/tenants", { token });

// ---- the door ------------------------------------------------------------------------------

test("the registry answers to the relay's own credential and to nothing else", async () => {
  await withPlane(async (plane) => {
    // No bearer.
    const none = await plane.request("GET", "/v1/relay/tenants");
    assert.equal(none.status, 401);
    assert.deepEqual(none.body, { error: "unauthorized" });

    // The OPERATOR bearer. This is the one that matters: the admin token adds accounts and deletes
    // services, and it must not also read every customer's gateway token.
    const admin = await plane.admin("GET", "/v1/relay/tenants");
    assert.equal(admin.status, 401);
    assert.deepEqual(admin.body, { error: "unauthorized" });

    // A stranger's, and one with the right prefix and the wrong tail. The compare hashes both sides
    // first, so neither the length nor a shared prefix shortens it.
    assert.equal((await asRelay(plane, randomBytes(32).toString("hex"))).status, 401);
    assert.equal((await asRelay(plane, `${RELAY_TOKEN.slice(0, 8)}x`)).status, 401);

    // And the right one.
    const ok = await asRelay(plane);
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body).sort(), ["skipped", "tenants"]);
  });
});

test("the relay's credential opens the registry and nothing else on this service", async () => {
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
      const answer = await plane.request(method, pathname, { body, token: RELAY_TOKEN });
      assert.equal(answer.status, 401, `${method} ${pathname} opened with the relay credential`);
    }
    // And it is a read. Nothing about the registry writes.
    assert.equal((await plane.request("POST", "/v1/relay/tenants", { body: {}, token: RELAY_TOKEN })).status, 405);
  });
});

test("with no relay credential set the registry is closed to everybody", async () => {
  // An install with no relay to feed, which is a single box on a developer's machine. Nothing about
  // it should hand out a token to anybody who happens to send an empty bearer.
  const coolify = await startFakeCoolify();
  const plane = await startControlPlane({ coolifyUrl: coolify.url, coolifyApiKey: coolify.apiKey, env: { CP_RELAY_TOKEN: "" } });
  try {
    assert.equal((await plane.request("GET", "/v1/relay/tenants")).status, 401);
    assert.equal((await plane.request("GET", "/v1/relay/tenants", { token: "" })).status, 401);
    assert.equal((await plane.admin("GET", "/v1/relay/tenants")).status, 401);
  } finally { await plane.dispose(); await coolify.close(); }
});

test("a relay credential that is set and short stops the service starting, in words", async () => {
  const { configProblems, loadConfig } = await import("../cp/provision.mjs");
  const base = {
    CP_SESSION_SECRET: randomBytes(32).toString("hex"),
    CP_ADMIN_TOKEN: randomBytes(24).toString("hex"),
  };
  assert.deepEqual(configProblems(loadConfig(base)), []);
  assert.deepEqual(configProblems(loadConfig({ ...base, CP_RELAY_TOKEN: RELAY_TOKEN })), []);
  const problems = configProblems(loadConfig({ ...base, CP_RELAY_TOKEN: "too-short" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /CP_RELAY_TOKEN/);
  assert.match(problems[0], /at least 32 characters or leave it unset/);
  assert.doesNotMatch(problems[0], /—/);
});

// ---- the answer ----------------------------------------------------------------------------

test("the registry carries what the relay needs to serve one customer, and no more", async () => {
  await withPlane(async (plane) => {
    const created = await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme Roofing" });
    assert.equal(created.status, 201, created.text);

    const answer = await asRelay(plane);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.tenants.length, 1);
    const row = answer.body.tenants[0];
    assert.deepEqual(Object.keys(row).sort(), [
      "box", "boxReady", "gateway", "name", "profileDir", "sessionKey", "slug", "stateDir", "status", "token",
    ]);

    const paths = tenantPaths("acme", plane.config);
    const uuid = created.body.tenant.coolifyServiceUuid;
    assert.equal(row.slug, "acme");
    assert.equal(row.name, "Acme Roofing");
    assert.equal(row.box, boxContainerName(uuid));
    assert.equal(row.gateway, `http://${boxContainerName(uuid)}:1340`);
    // The token off the disk, not one this answer invented.
    assert.equal(row.token, JSON.parse(readFileSync(paths.profileTokenFile, "utf8")).token);
    // This tenant's own derived key, which is what the relay verifies that tenant's sessions with.
    assert.equal(row.sessionKey, tenantSessionSecret(plane.config.sessionSecret, "acme"));
    assert.equal(row.stateDir, paths.state);
    assert.equal(row.profileDir, paths.profile);
    assert.deepEqual(answer.body.skipped, []);
  });
});

// ---- what a plan includes (PROXY-1) -------------------------------------------------------------

test("with no proxy on this server the registry answers exactly as it did before", async () => {
  // CP_PROXY_URL unset is the state of every install that has not turned the feature on, including
  // Jason's own console today. The word for what that answer has to look like is "identical": no
  // included object, and no per tenant complaint in skipped either, because a registry that grew a
  // line per customer per read would be noise on the day somebody needs to read it.
  await withPlane(async (plane) => {
    await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });
    const row = (await asRelay(plane)).body.tenants[0];
    assert.equal(Object.hasOwn(row, "included"), false);
    assert.deepEqual((await asRelay(plane)).body.skipped, []);
  });
});

test("the included object is pinned field for field, and its id is its model", async () => {
  const proxy = await startFakeProxy();
  try {
    await withPlane(async (plane) => {
      await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });
      const row = (await asRelay(plane)).body.tenants[0];
      // These names are read by the relay. A rename on either side is the failure cp-relay-pair
      // exists to catch, and this is the control plane's own half of the same pin.
      //
      // Being read by the relay is not the same as being KEPT by it. modelLabel was pinned here
      // and dropped by ui/tenant-registry.mjs's includedOf on arrival, which no assertion on this
      // side could see. tests/relay-tenant-endpoints.test.mjs holds the other half.
      assert.deepEqual(Object.keys(row.included).sort(), ["baseUrl", "enforced", "key", "keyId", "models"]);
      assert.equal(row.included.baseUrl, `${proxy.url}/v1`);
      // The key off the disk, not one this answer invented, and the same one the box will present.
      assert.equal(row.included.key, readProxyKey("acme", plane.config).key);
      assert.equal(row.included.enforced, false, "observe mode is the default this wave ships");
      for (const model of row.included.models) {
        assert.deepEqual(Object.keys(model).sort(), ["contextWindow", "id", "model", "modelLabel", "name", "servedBy"]);
        assert.equal(model.id, model.model, "id and model have to be one string");
        // The plan- prefix is how the console tells an included row from a customer's own row, so a
        // row that lost it would be indistinguishable from one the customer can edit.
        assert.match(model.id, /^plan-/);
        assert.notEqual(model.servedBy, "", "without servedBy a customer's agent names a container");
      }
    }, { env: { CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey } });
  } finally { await proxy.close(); }
});

test("the operator's own adopted workspace reads its plan key from the directory it was adopted with", async () => {
  // Tenant "titanium" is Jason's own instance: adopted, no directory under the tenant root, and its
  // profile is wherever the operator already had it. It is also the ONLY workspace `proxy mint`
  // exists for, because tenantProvision refuses a non-dry-run provision on an adopted row. A key
  // written under the tenant root instead would be a mint that reported success and left his
  // console with nothing included in his plan, with no error anywhere.
  const proxy = await startFakeProxy();
  try {
    await withPlane(async (plane) => {
      const elsewhere = path.join(plane.root, "release", "profile");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(path.join(elsewhere, "local-docker-vm.json"), JSON.stringify({ token: "the-operators-own-gateway-token" }), { mode: 0o600 });
      const adopted = await plane.admin("POST", "/v1/tenants/titanium/adopt", {
        coolifyServiceUuid: "svc-operator", host: "console.titanium.bot",
        boxContainer: "titanbot-box-operator", profileDir: elsewhere, stateDir: path.join(plane.root, "release", "state"),
      });
      assert.equal(adopted.status, 200, adopted.text);

      // Minted the way the CLI mints it: into the directory the adoption named.
      const minted = await ensureProxyKey("titanium", plane.config, {
        file: proxyKeyFileIn(tenantProfileDir("titanium", plane.config, plane.store.listSteps("titanium"))),
      });
      assert.equal(minted.ok, true, minted.why);
      assert.equal(existsSync(path.join(elsewhere, "model-proxy.json")), true, "the key went somewhere else entirely");
      assert.equal(existsSync(tenantPaths("titanium", plane.config).proxyKeyFile), false, "a second copy was written under the tenant root");

      const row = (await asRelay(plane)).body.tenants.find((one) => one.slug === "titanium");
      assert.equal(row.included.key, minted.record.key, "the registry read a different file from the one the mint wrote");
    }, { env: { CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey } });
  } finally { await proxy.close(); }
});

test("an adopted workspace with no gateway token here still carries its plan, and a customer without one does not", async () => {
  // MEASURED ON THE R750 2026-09-08. Jason's own workspace is adopted and this service holds no
  // gateway token for it on purpose: the relay seeds that entry from its own environment so his
  // console survives this service being down. The whole row was therefore dropped here, and the
  // virtual key rides ON that row, so `proxy migrate titanium` minted his key and then failed
  // forever with "no included set for titanium" while the two customers went through. His box
  // would have been the one left holding the copied operator key.
  const proxy = await startFakeProxy();
  try {
    await withPlane(async (plane) => {
      // Adopted the way the live one was: a box and a host, and NO directories, so there is no
      // token to read anywhere.
      const adopted = await plane.admin("POST", "/v1/tenants/titanium/adopt", {
        coolifyServiceUuid: "svc-operator", host: "console.titanium.bot", boxContainer: "titanbot-box-operator",
      });
      assert.equal(adopted.status, 200, adopted.text);
      const minted = await ensureProxyKey("titanium", plane.config, {
        file: proxyKeyFileIn(tenantProfileDir("titanium", plane.config, plane.store.listSteps("titanium"))),
      });
      assert.equal(minted.ok, true, minted.why);

      const answer = await asRelay(plane);
      const row = answer.body.tenants.find((one) => one.slug === "titanium");
      assert.ok(row, "the operator's workspace was dropped, so its plan key had no route to the relay");
      assert.equal(row.included.key, minted.record.key);
      // Its slug, its own derived session key and its plan, and NOTHING else. The relay takes box,
      // token and both directories from its own environment for this one entry and merges only these
      // two, so sending anything more would be sending a field that is ignored at best and wrong at
      // worst. SIGNIN-2 is the second of the two: the relay cannot derive it, because the master
      // that derives it is on this side and never leaves.
      assert.deepEqual(Object.keys(row).sort(), ["included", "sessionKey", "slug"]);
      assert.equal(row.sessionKey, tenantSessionSecret(plane.config.sessionSecret, "titanium"),
        "the operator's row carried something other than that slug's own derived key");
      assert.equal(JSON.stringify(answer.body).includes(plane.config.sessionSecret), false,
        "the master's own bytes were in the registry answer");
      // The skipped note stays, because the reason the rest of the row is absent has not changed.
      assert.ok((answer.body.skipped ?? []).some((one) => one.slug === "titanium" && one.what === "tenant"));

      // And the narrowness is the point: an ordinary customer whose token is missing is still
      // skipped outright. A row with no token would have the relay calling that customer's gateway
      // with an empty bearer forever instead of saying the workspace is not available.
      await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });
      rmSync(tenantPaths("acme", plane.config).profileTokenFile, { force: true });
      const second = await asRelay(plane);
      assert.equal(second.body.tenants.some((one) => one.slug === "acme"), false,
        "a customer with no gateway token was served a row with no token in it");
    }, { env: { CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey } });
  } finally { await proxy.close(); }
});

test("an adopted workspace with no plan at all still carries its derived key, and a customer still does not", async () => {
  // SIGNIN-2, and this is the live shape on the R750 today: CP_PROXY_URL is unset there, so there is
  // no plan to send and until this wave the operator's row was not sent at all. MEASURED on that
  // machine 2026-09-10, read only inside the cp container: the titanium row carried `included` and
  // `slug` and nothing else while demo and richard-avery carried 64-character derived keys, so an
  // account on Jason's own workspace met 503 and the identical account on demo signed in at once.
  //
  // The row has to be answered with a key even when there is no plan, which is what this measures.
  await withPlane(async (plane) => {
    const adopted = await plane.admin("POST", "/v1/tenants/titanium/adopt", {
      coolifyServiceUuid: "svc-operator", host: "console.titanium.bot", boxContainer: "titanbot-box-operator",
    });
    assert.equal(adopted.status, 200, adopted.text);

    const answer = await asRelay(plane);
    const row = answer.body.tenants.find((one) => one.slug === "titanium");
    assert.ok(row, "the operator's workspace was dropped, so no key could reach the relay at all");
    // No plan on this server, so no `included` key on the row: a slug and a derived key, exactly the
    // two fields the relay merges onto the entry it builds from its own environment.
    assert.deepEqual(Object.keys(row).sort(), ["sessionKey", "slug"]);
    assert.equal(row.sessionKey, tenantSessionSecret(plane.config.sessionSecret, "titanium"));
    assert.equal(row.sessionKey.length, 64, "a derived key is a hex sha256");
    assert.equal(JSON.stringify(answer.body).includes(plane.config.sessionSecret), false,
      "the master's own bytes were in the registry answer");
    // The rest of the row really is absent, so the note saying why stays exactly as it was.
    assert.ok((answer.body.skipped ?? []).some((one) => one.slug === "titanium" && one.what === "tenant"
      && /gateway token/.test(one.why)), JSON.stringify(answer.body.skipped));

    // And the narrowness has not moved either: an ordinary customer whose token file is missing is
    // still skipped outright, with no row and therefore no key. A row with no token would have the
    // relay calling that customer's gateway with an empty bearer instead of saying the workspace is
    // not available.
    await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });
    rmSync(tenantPaths("acme", plane.config).profileTokenFile, { force: true });
    const second = await asRelay(plane);
    assert.equal(second.body.tenants.some((one) => one.slug === "acme"), false,
      "a customer with no gateway token was served a row, and it carried a signing key");
  });
});

test("a workspace with no plan key is served without one, and the reason is named", async () => {
  const proxy = await startFakeProxy();
  try {
    await withPlane(async (plane) => {
      await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });
      // The file removed the way `proxy revoke` removes it. The customer still has a workspace and
      // still signs in; what they do not have is anything included with their plan, and the whole
      // object is left out rather than sent half filled, because a card with no key behind it is a
      // customer clicking Use this one and getting a 401.
      rmSync(tenantPaths("acme", plane.config).proxyKeyFile, { force: true });
      const answer = await asRelay(plane);
      assert.equal(answer.body.tenants.length, 1, "the customer was dropped over a missing plan key");
      assert.equal(Object.hasOwn(answer.body.tenants[0], "included"), false);
      const named = answer.body.skipped.find((one) => one.slug === "acme");
      assert.equal(named.what, "included", "a note about a plan must not read like a dropped workspace");
      assert.match(named.why, /proxy mint acme/);
    }, { env: { CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey } });
  } finally { await proxy.close(); }
});

test("the registry hands over per-tenant keys and never the master", async () => {
  // This is the assertion the amendment in the header of cp/server.mjs names. The route returns
  // secrets on purpose; what it must never return is the one value that would let its holder sign
  // for every customer at once.
  await withPlane(async (plane) => {
    await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });
    await plane.admin("POST", "/v1/tenants", { slug: "roofing", name: "Roofing" });
    const answer = await asRelay(plane);
    assert.equal(answer.status, 200);

    assert.equal(answer.text.includes(plane.config.sessionSecret), false, "the master never leaves this process");
    assert.equal(answer.text.includes(plane.config.adminToken), false);
    assert.equal(answer.text.includes(plane.config.relayToken), false);
    assert.equal(/"hash"|"password_json"|"cookieSecret"/.test(answer.text), false);

    // One tenant's key is not another's, so a relay compromised for one customer is not every
    // customer. That property is what makes handing these out safe at all.
    const keys = answer.body.tenants.map((row) => row.sessionKey);
    assert.equal(new Set(keys).size, 2);
    const tokens = answer.body.tenants.map((row) => row.token);
    assert.equal(new Set(tokens).size, 2);
    for (const row of answer.body.tenants) {
      assert.equal(row.sessionKey, tenantSessionSecret(plane.config.sessionSecret, row.slug));
      assert.notEqual(row.sessionKey, plane.config.sessionSecret);
    }
  });
});

test("a workspace the relay could not serve is left out and named, not half answered", async () => {
  await withPlane(async (plane, coolify) => {
    // Built, and fine.
    await plane.admin("POST", "/v1/tenants", { slug: "acme", name: "Acme" });
    // Failed on its way up, so it has no box worth talking to.
    coolify.failOnce("POST /services", 422, "environment_uuid is required");
    const failed = await plane.admin("POST", "/v1/tenants", { slug: "roofing", name: "Roofing" });
    assert.equal(failed.status, 502);
    // Recorded but never built, so there is no container name at all.
    plane.store.createTenant({ slug: "plumbing", name: "Plumbing", status: "provisioning" });

    const answer = await asRelay(plane);
    assert.deepEqual(answer.body.tenants.map((row) => row.slug), ["acme"]);
    assert.deepEqual(answer.body.skipped.map((row) => row.slug).sort(), ["plumbing", "roofing"]);
    for (const row of answer.body.skipped) {
      assert.doesNotMatch(row.why, /—/);
      assert.doesNotMatch(row.why, /null|undefined|uuid/i);
    }
    assert.match(answer.body.skipped.find((row) => row.slug === "roofing").why, /did not finish being built/);
    assert.match(answer.body.skipped.find((row) => row.slug === "plumbing").why, /no container yet/);
  });
});

test("the adoption of the operator's own instance carries its box and where its token is read from", async () => {
  await withPlane(async (plane) => {
    // What deploy/r750 does for tenant "titanium": claim the Coolify service that is already
    // running console.titanium.bot. The box name and the two directories default to what Coolify
    // and the release layout already produce, so nothing is typed twice.
    const answer = await plane.admin("POST", "/v1/tenants/titanium/adopt", {
      coolifyServiceUuid: "p927bfqm83ioloibamlvyd7g",
      host: "console.titanium.bot",
    });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.body.boxContainer, "titanbot-box-p927bfqm83ioloibamlvyd7g");
    assert.equal(answer.body.stateDir, `${plane.config.releaseRoot}/state`);
    assert.equal(answer.body.profileDir, `${plane.config.releaseRoot}/profile`);
    assert.equal(answer.body.tenant.boxContainer, "titanbot-box-p927bfqm83ioloibamlvyd7g");

    // And an instance that is laid out some other way says so once, here.
    const other = await plane.admin("POST", "/v1/tenants/second/adopt", {
      coolifyServiceUuid: "abc123",
      host: "console.titanium.bot",
      boxContainer: "some-other-box",
      stateDir: "/srv/second/state",
      profileDir: "/srv/second/profile",
    });
    assert.equal(other.body.boxContainer, "some-other-box");
    assert.equal(other.body.stateDir, "/srv/second/state");
    assert.equal(other.body.profileDir, "/srv/second/profile");

    // Neither carries a box, a gateway token or a directory here, because neither has a token file
    // on this machine, and the reason is said rather than left as a silent gap. What each one DOES
    // carry is its slug and its own derived session key, which is the one thing the relay cannot
    // build for itself and the whole of SIGNIN-2: without it an account on an adopted workspace
    // cannot be verified at all, and the console answers 503 to a correct password.
    const registry = await asRelay(plane);
    assert.deepEqual(registry.body.tenants.map((row) => row.slug).sort(), ["second", "titanium"]);
    for (const row of registry.body.tenants) {
      assert.deepEqual(Object.keys(row).sort(), ["sessionKey", "slug"]);
      assert.equal(row.sessionKey, tenantSessionSecret(plane.config.sessionSecret, row.slug));
    }
    assert.equal(JSON.stringify(registry.body).includes(plane.config.sessionSecret), false,
      "the master's own bytes were in the registry answer");
    assert.deepEqual(registry.body.skipped.map((row) => row.slug).sort(), ["second", "titanium"]);
    for (const row of registry.body.skipped) assert.match(row.why, /no gateway token/);
  });
});

test("an adopted instance whose token file is really there is served from that directory", async () => {
  await withPlane(async (plane) => {
    // The token where the operator's own instance keeps it. Written into a temporary tree here, not
    // into anybody's real profile directory.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const profileDir = `${plane.root}/release/profile`;
    mkdirSync(profileDir, { recursive: true });
    const token = randomBytes(32).toString("hex");
    writeFileSync(`${profileDir}/local-docker-vm.json`, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });

    await plane.admin("POST", "/v1/tenants/titanium/adopt", {
      coolifyServiceUuid: "p927bfqm83ioloibamlvyd7g",
      host: "console.titanium.bot",
      profileDir,
      stateDir: `${plane.root}/release/state`,
    });

    const registry = await asRelay(plane);
    assert.deepEqual(registry.body.tenants.map((row) => row.slug), ["titanium"]);
    const row = registry.body.tenants[0];
    assert.equal(row.token, token);
    assert.equal(row.box, "titanbot-box-p927bfqm83ioloibamlvyd7g");
    assert.equal(row.gateway, "http://titanbot-box-p927bfqm83ioloibamlvyd7g:1340");
    assert.equal(row.profileDir, profileDir);
    assert.equal(row.sessionKey, tenantSessionSecret(plane.config.sessionSecret, "titanium"));
  }, { existingServices: ["p927bfqm83ioloibamlvyd7g"] });
});

// ---- signing up ----------------------------------------------------------------------------

test("one request makes the account, names the workspace after the company and builds the box", async () => {
  await withPlane(async (plane, coolify) => {
    const answer = await plane.admin("POST", "/v1/signups", {
      email: "Jane@AcmeRoofing.com",
      password: PASSWORD,
      company: "Acme Roofing & Sons",
      name: "Jane Doe",
    });
    assert.equal(answer.status, 201, answer.text);
    assert.equal(answer.body.account.email, "jane@acmeroofing.com");
    assert.equal(answer.body.account.tenant, "acme-roofing-sons");
    assert.equal(answer.body.tenant.slug, "acme-roofing-sons");
    assert.equal(answer.body.tenant.name, "Acme Roofing & Sons");
    assert.equal(answer.body.tenant.ownerEmail, "jane@acmeroofing.com");
    // The one console, in the answer, so nothing anywhere hands a customer a hostname of their own.
    assert.equal(answer.body.signIn, "https://console.titanium.bot");
    assert.equal(answer.body.tenant.host, "console.titanium.bot");
    assert.equal(answer.text.includes(".titanium.bot"), true);
    assert.equal(answer.text.includes("acme-roofing-sons.titanium.bot"), false);
    assert.equal(answer.body.boxReady, true);
    assert.doesNotMatch(answer.body.message, /—/);

    // The box was really built, as one service with one container.
    assert.deepEqual(coolify.routes(), [
      "POST /services", "POST /services/{uuid}/envs", "PATCH /services/{uuid}/envs",
      "POST /services/{uuid}/start", "GET /services/{uuid}", "GET /services/{uuid}/applications",
    ]);
    assert.equal(coolify.callsTo("POST /services")[0].body.name, "titanbot-acme-roofing-sons");

    // And they can sign in with what they typed.
    const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "jane@acmeroofing.com", password: PASSWORD } });
    assert.equal(signIn.status, 200);
    assert.equal(signIn.body.tenant.slug, "acme-roofing-sons");
    assert.equal(signIn.body.tenant.host, "console.titanium.bot");

    // The relay can serve them.
    const registry = await asRelay(plane);
    assert.deepEqual(registry.body.tenants.map((row) => row.slug), ["acme-roofing-sons"]);
  });
});

test("two companies with the same name get two workspaces, not one shared one", async () => {
  await withPlane(async (plane) => {
    const first = await plane.admin("POST", "/v1/signups", { email: "a@one.com", password: PASSWORD, company: "Acme" });
    const second = await plane.admin("POST", "/v1/signups", { email: "b@two.com", password: PASSWORD, company: "Acme" });
    assert.equal(first.body.tenant.slug, "acme");
    assert.equal(second.body.tenant.slug, "acme-2");

    // Two boxes, two tokens, two keys. Nothing is shared but the console they both sign in at.
    const registry = await asRelay(plane);
    assert.deepEqual(registry.body.tenants.map((row) => row.slug), ["acme", "acme-2"]);
    assert.notEqual(registry.body.tenants[0].box, registry.body.tenants[1].box);
    assert.notEqual(registry.body.tenants[0].token, registry.body.tenants[1].token);
    assert.notEqual(registry.body.tenants[0].sessionKey, registry.body.tenants[1].sessionKey);
    assert.notEqual(registry.body.tenants[0].stateDir, registry.body.tenants[1].stateDir);
  });
});

test("sign up is closed unless the operator says otherwise, and says so in plain words", async () => {
  await withPlane(async (plane, coolify) => {
    const closed = await plane.request("POST", "/v1/signups", { body: { email: "jane@acme.com", password: PASSWORD, company: "Acme" } });
    assert.equal(closed.status, 403);
    assert.equal(closed.body.error, "signup_closed");
    assert.doesNotMatch(closed.body.message, /—/);
    assert.doesNotMatch(closed.body.message, /CP_ALLOW_SIGNUP|env|config/i);
    assert.deepEqual(coolify.routes(), [], "nothing reached Coolify");
    assert.equal(plane.store.countAccounts(), 0);
    assert.equal(plane.store.countTenants(), 0);

    // The operator always gets in, which is how the CLI adds somebody.
    assert.equal((await plane.admin("POST", "/v1/signups", { email: "jane@acme.com", password: PASSWORD, company: "Acme" })).status, 201);
  });
});

test("with sign up open a stranger can sign up, and only so many times", async () => {
  await withPlane(async (plane) => {
    const open = await plane.request("POST", "/v1/signups", { body: { email: "jane@acme.com", password: PASSWORD, company: "Acme Roofing" } });
    assert.equal(open.status, 201, open.text);
    assert.equal(open.body.tenant.slug, "acme-roofing");

    // The counter that caps how many workspaces one address can start is the same one a wrong
    // password fills, and every attempt costs one whether it worked or not.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await plane.request("POST", "/v1/signups", { body: { email: `someone${attempt}@example.com`, password: PASSWORD, company: `Company ${attempt}` } });
    }
    const locked = await plane.request("POST", "/v1/signups", { body: { email: "late@example.com", password: PASSWORD, company: "Late" } });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, "locked");
    assert.ok(locked.body.retryAfter > 0);
    assert.equal(locked.headers.get("retry-after"), String(locked.body.retryAfter));
  }, { env: { CP_ALLOW_SIGNUP: "1" } });
});

test("sign up refuses what it cannot make a workspace out of, and leaves nothing behind", async () => {
  await withPlane(async (plane, coolify) => {
    const cases = [
      [{ password: PASSWORD, company: "Acme" }, /real email address/],
      [{ email: "jane@acme.com", password: "short", company: "Acme" }, /at least 8 characters/],
      [{ email: "jane@acme.com", password: PASSWORD }, /name of your company/],
      [{ email: "jane@acme.com", password: PASSWORD, company: "!!!" }, /no letters or numbers/],
    ];
    for (const [body, expected] of cases) {
      const answer = await plane.admin("POST", "/v1/signups", body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.match(answer.body.message, expected);
      assert.doesNotMatch(answer.body.message, /—/);
    }
    assert.equal(plane.store.countAccounts(), 0);
    assert.equal(plane.store.countTenants(), 0);
    assert.deepEqual(coolify.routes(), []);

    // An address that already has an account is told to sign in, not given a second workspace.
    await plane.admin("POST", "/v1/signups", { email: "jane@acme.com", password: PASSWORD, company: "Acme" });
    const again = await plane.admin("POST", "/v1/signups", { email: "Jane@Acme.com", password: PASSWORD, company: "Acme Again" });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /Sign in instead/);
    assert.equal(plane.store.countTenants(), 1, "the refused sign up left no workspace behind");
  });
});

test("sign up is refused outright when new workspaces are turned off on this server", async () => {
  await withPlane(async (plane, coolify) => {
    const answer = await plane.admin("POST", "/v1/signups", { email: "jane@acme.com", password: PASSWORD, company: "Acme" });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, "new_tenants_off");
    assert.match(answer.body.message, /CP_ALLOW_NEW_TENANTS=1/);
    assert.deepEqual(coolify.routes(), []);
    assert.equal(plane.store.countAccounts(), 0, "nobody is given an account for a workspace that will not be built");
    assert.equal(plane.store.countTenants(), 0);
  }, { env: { CP_ALLOW_NEW_TENANTS: "0" } });
});

test("a box that fails to build still leaves somebody who can sign in", async () => {
  await withPlane(async (plane, coolify) => {
    coolify.failOnce("POST /services", 500, "Coolify is restarting");
    const answer = await plane.admin("POST", "/v1/signups", { email: "jane@acme.com", password: PASSWORD, company: "Acme" });
    assert.equal(answer.status, 502);
    assert.equal(answer.body.step, "service");
    assert.match(answer.body.message, /not finished yet/);
    assert.doesNotMatch(answer.body.message, /—/);
    // And it does not promise something this service cannot do. It sends no mail.
    assert.doesNotMatch(answer.body.message, /email you|we will email/i);

    // The account stays, so the customer is not lost with the build.
    const signIn = await plane.request("POST", "/v1/sessions", { body: { email: "jane@acme.com", password: PASSWORD } });
    assert.equal(signIn.status, 200);

    // The relay leaves them out and says why, rather than answering them 401 forever.
    const registry = await asRelay(plane);
    assert.deepEqual(registry.body.tenants, []);
    assert.deepEqual(registry.body.skipped.map((row) => row.slug), ["acme"]);

    // And the operator finishes it with one retry.
    const retried = await plane.admin("POST", "/v1/tenants/acme/provision");
    assert.equal(retried.status, 200, retried.text);
    assert.deepEqual((await asRelay(plane)).body.tenants.map((row) => row.slug), ["acme"]);
  });
});
