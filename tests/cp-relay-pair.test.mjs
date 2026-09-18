// The two halves of TENANT-5, run against each other.
//
// Everything else in this tree tests one half against a written-down contract: the relay suites
// feed a fake control plane, and the control plane suites answer a fake relay. That is the right
// way round for both, and it is exactly the arrangement in which two correct halves disagree.
// The relay reads `sessionKey`; the control plane could have called it `key` and every test in the
// tree would still be green. So this file starts the REAL control plane out of cp/server.mjs and
// the REAL relay out of a copy of ui/, points the second at the first, and measures what crosses.
//
// What it deliberately does NOT do is reach a customer's box. A box's address is
// http://<container>:1340 and the port is not a setting, so a test that wanted to answer as one
// would have to hold port 1340 on the machine running it. The two things that have to cross for a
// box to be reachable are measured without one: the gateway token, over the runtime route, which
// matches a presented token to a workspace; and the derived session key, over the account door,
// which is a sign-in the relay can only complete with the key the control plane derived.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { createApp, createHttpServer } from "../cp/server.mjs";
import { mintSignInLink } from "../cp/onboard.mjs";
import { ensureProxyKey, loadConfig, tenantPaths } from "../cp/provision.mjs";
import { openStore } from "../cp/store.mjs";
import { RELAY_PASSWORD, startRelay } from "./relay-tenant-support.mjs";
import { startFakeProxy } from "./cp-proxy-support.mjs";

const SLUG = "acme";
const ACCOUNT = "owner@acme.test";
const PASSWORD = "an account password of real length";
const GATEWAY_TOKEN = "the-gateway-token-of-acmes-own-box";
// SIGNIN-2. The operator's own account and the bearer of the operator's own box. The bearer comes out
// of this relay's ENVIRONMENT and never off the registry route, which is the half of the pairing the
// control plane must not be able to move.
const OPERATOR_ACCOUNT = "jason@titaniumcomputing.test";
const OPERATOR_GATEWAY_TOKEN = "the-gateway-token-only-this-relays-env-holds";
const BOX = "titanbot-box-svc-acme";

// A `docker` that names the two containers this pairing expects to be running. The relay verifies
// every box name it is handed against `docker ps` and refuses to serve a workspace whose container
// is not there, which is the check that stops a stale registry row reaching a neighbour's box. With
// real docker on PATH the customer's box would correctly be missing, so the stub is what lets the
// rest of the pairing be measured at all.
function dockerStub(names) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pair-docker-"));
  writeFileSync(path.join(dir, "docker"), `#!/bin/sh\n[ "$1" = "ps" ] && { ${names.map((n) => `echo ${n}`).join("; ")}; }\nexit 0\n`, { mode: 0o755 });
  return `${dir}:/usr/bin:/bin`;
}

async function startPair({ extraTenant = null, withProxy = false, operator = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cp-relay-pair-"));
  const master = randomBytes(32).toString("hex");
  const relayToken = randomBytes(32).toString("hex");
  const adminToken = randomBytes(24).toString("hex");
  // PROXY-1. Off unless a test asks for it, so every assertion in this file that predates the proxy
  // is measured on a control plane shaped exactly as it was.
  const proxy = withProxy ? await startFakeProxy() : null;
  const config = loadConfig({
    CP_PORT: "0", CP_DATA_DIR: path.join(root, "data"),
    CP_SESSION_SECRET: master, CP_ADMIN_TOKEN: adminToken, CP_RELAY_TOKEN: relayToken,
    CP_BASE_DOMAIN: "titanium.bot", CP_TENANT_ROOT: path.join(root, "tenants"),
    CP_RELEASE_ROOT: path.join(root, "release"), CP_PUBLIC_URL: "https://api.titanium.bot",
    COOLIFY_URL: "", COOLIFY_API_KEY: "", COOLIFY_PROJECT_UUID: "p", COOLIFY_SERVER_UUID: "s",
    COOLIFY_ENVIRONMENT_NAME: "production", CP_ALLOW_NEW_TENANTS: "1",
    ...(proxy ? { CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey } : {}),
  });
  const store = openStore({ dataDir: config.dataDir });
  const app = createApp({ config, store, probeImpl: () => { throw new Error("there is no docker network in a test"); } });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cp = `http://127.0.0.1:${server.address().port}`;

  // One customer, left in the ledger the way a finished provisioning run leaves them.
  store.createTenant({ slug: SLUG, name: "Acme", host: "", status: "running", ownerEmail: ACCOUNT, coolifyServiceUuid: "svc-acme", boxContainer: BOX });
  store.updateTenant(SLUG, { status: "running", boxReady: 1 });
  const paths = tenantPaths(SLUG, config);
  mkdirSync(paths.profile, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
  writeFileSync(paths.profileTokenFile, `${JSON.stringify({ token: GATEWAY_TOKEN })}\n`, { mode: 0o600 });
  // The key a finished proxy-key step leaves behind, minted through the real code path rather than
  // written by hand, so what crosses is what a real mint produces.
  let proxyKey = "";
  if (proxy) {
    const minted = await ensureProxyKey(SLUG, config, { box: BOX });
    assert.equal(minted.ok, true, `the plan key could not be minted: ${minted.why ?? ""}`);
    proxyKey = minted.record.key;
  }

  const ask = (method, pathname, { body, token } = {}) => {
    const init = { method, headers: { accept: "application/json" } };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    return fetch(`${cp}${pathname}`, init);
  };
  const account = await ask("POST", "/v1/accounts", { token: adminToken, body: { email: ACCOUNT, password: PASSWORD, tenant: SLUG } });
  assert.equal(account.status, 201, "the customer's account was not created, so nothing below means anything");

  // A second customer, optionally without the token file, which is the half-built shape.
  if (extraTenant) {
    store.createTenant({ slug: extraTenant.slug, name: extraTenant.name, host: "", status: "running", ownerEmail: extraTenant.email, coolifyServiceUuid: `svc-${extraTenant.slug}`, boxContainer: `titanbot-box-svc-${extraTenant.slug}` });
    store.updateTenant(extraTenant.slug, { status: "running", boxReady: 1 });
    const extraPaths = tenantPaths(extraTenant.slug, config);
    mkdirSync(extraPaths.profile, { recursive: true });
    mkdirSync(extraPaths.state, { recursive: true });
    if (extraTenant.withToken) writeFileSync(extraPaths.profileTokenFile, `${JSON.stringify({ token: `token-for-${extraTenant.slug}` })}\n`, { mode: 0o600 });
    const extraAccount = await ask("POST", "/v1/accounts", { token: adminToken, body: { email: extraTenant.email, password: PASSWORD, tenant: extraTenant.slug } });
    assert.equal(extraAccount.status, 201, "the second customer's account was not created");
  }

  // SIGNIN-2. The operator's own workspace, adopted the way the live one is -- a Coolify service and
  // a host, no box recorded and no token file anywhere on this machine -- plus an account on it and a
  // stand-in for its box. The box is here because the half of the entry that must NOT come from the
  // control plane is only measurable by reaching it: a roster that comes back proves the relay used
  // the container and the bearer out of its own environment, because that gateway refuses any other.
  let operatorBox = null;
  if (operator) {
    const adopted = await ask("POST", "/v1/tenants/titanium/adopt", {
      token: adminToken,
      body: { coolifyServiceUuid: "p927bfqm83ioloibamlvyd7g", host: "console.titanium.bot" },
    });
    assert.equal(adopted.status, 200, `the operator's workspace could not be adopted: ${await adopted.text()}`);
    const account = await ask("POST", "/v1/accounts", {
      token: adminToken, body: { email: OPERATOR_ACCOUNT, password: PASSWORD, tenant: "titanium" },
    });
    assert.equal(account.status, 201, `the operator's own account was not created: ${await account.text()}`);

    const asked = [];
    const boxServer = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
        asked.push({ path: req.url, bearer });
        if (bearer !== OPERATOR_GATEWAY_TOKEN) {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "unauthorized" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: "titan", name: "Titan" }, { id: "scribe", name: "Scribe" }]));
      });
    });
    await new Promise((resolve) => boxServer.listen(0, "127.0.0.1", resolve));
    operatorBox = { asked, url: `http://127.0.0.1:${boxServer.address().port}`, close: () => boxServer.close() };
  }

  const relay = await startRelay(
    {
      CP_URL: cp, CP_RELAY_TOKEN: relayToken, SAND_BOX_CONTAINER: "titanbot-box-operator",
      ...(operatorBox
        ? { SAND_HOST_GATEWAY_URL: operatorBox.url, SAND_HOST_GATEWAY_TOKEN: OPERATOR_GATEWAY_TOKEN }
        : {}),
    },
    { prefix: "pair-relay-", pathValue: dockerStub([BOX, "titanbot-box-operator"]) },
  );
  return {
    cp, ask, relay, master, relayToken, adminToken, proxyKey, operatorBox, store, config,
    stop: () => {
      relay.stop();
      server.close();
      if (proxy) void proxy.close();
      if (operatorBox) operatorBox.close();
    },
  };
}

test("what the control plane puts on the registry route is what the relay reads off it", async () => {
  const pair = await startPair();
  try {
    const answer = await pair.ask("GET", "/v1/relay/tenants", { token: pair.relayToken });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    const row = body.tenants.find((tenant) => tenant.slug === SLUG);
    assert.ok(row, `the customer was left out: ${JSON.stringify(body.skipped)}`);

    // Field by field, by the name the relay reads. A rename on either side is the failure this
    // whole file exists to catch, and it is a failure no other test in the tree can see.
    for (const field of ["slug", "name", "status", "box", "gateway", "token", "sessionKey", "stateDir", "profileDir"]) {
      assert.equal(typeof row[field], "string", `the relay reads ${field} and the control plane did not send a string`);
      assert.notEqual(row[field], "", `the relay reads ${field} and the control plane sent an empty one`);
    }
    assert.equal(row.box, BOX, "the box name is computed from the Coolify service uuid");
    assert.equal(row.gateway, `http://${BOX}:1340`, "the gateway is that container on the box port");
    assert.equal(row.token, GATEWAY_TOKEN, "the token is the one on the disk, not a new one");
    assert.equal(JSON.stringify(body).includes(pair.master), false, "the master's bytes were in the answer");
  } finally { pair.stop(); }
});

test("the included object the control plane writes is the one the relay reads, field for field", async () => {
  // PROXY-1's half of what this file exists for. The relay renders `included` as read-only cards in
  // a customer's Settings and points their box at `included.baseUrl` with `included.key`. Every one
  // of these names could have been spelled differently on the two sides and every other test in the
  // tree would still be green, which is exactly the failure this suite was written to catch.
  //
  // The pin, and it does not move:
  //   included = {baseUrl, key, keyId, models: [{id, model, name, contextWindow, servedBy,
  //                modelLabel, supportsVision, visionFallback, visionFallbackLabel}], enforced}
  //
  // modelLabel is in the pin below and has been since 611fc9c, and it is worth saying why a green
  // assertion here was not enough. This is the CONTROL PLANE's half. The relay's own normaliser
  // (ui/tenant-registry.mjs includedOf) dropped the field on the way in, so both sides of this pin
  // agreed on a name that then went nowhere, and every box on the R750 told its customer it ran
  // "plan-zai". The relay's half of the same pin is in tests/relay-tenant-endpoints.test.mjs, on
  // GET /endpoints, which is where the field is finally read.
  const pair = await startPair({ withProxy: true });
  try {
    const body = await (await pair.ask("GET", "/v1/relay/tenants", { token: pair.relayToken })).json();
    const row = body.tenants.find((tenant) => tenant.slug === SLUG);
    assert.ok(row?.included, `the customer got no included object: ${JSON.stringify(body.skipped)}`);
    assert.deepEqual(Object.keys(row.included).sort(), ["baseUrl", "enforced", "key", "keyId", "models", "upstreamBaseUrl"]);
    assert.equal(typeof row.included.baseUrl, "string");
    // Plain http to a private name on the docker bridge. That is precisely what the relay's tenant
    // endpoint guard refuses, and the guard is NOT relaxed for it: these rows never enter a
    // customer's endpoints.json, the relay computes them from this answer.
    assert.match(row.included.baseUrl, /^http:\/\/[^/]+\/model-proxy\/v1$/);
    assert.match(row.included.upstreamBaseUrl, /^http:\/\/[^/]+\/v1$/);
    assert.notEqual(row.included.key, "", "the relay was handed no key to use");
    assert.equal(typeof row.included.enforced, "boolean");
    assert.ok(Array.isArray(row.included.models) && row.included.models.length > 0);
    for (const model of row.included.models) {
      assert.deepEqual(Object.keys(model).sort(),
        ["contextWindow", "id", "model", "modelLabel", "name", "servedBy", "supportsVision", "visionFallback", "visionFallbackLabel"]);
      assert.equal(model.id, model.model, "the relay keys a row by id and points the box at model");
      // A plan id must never be able to collide with a row a customer made themselves, because the
      // console drops plan- rows out of anything a customer posts back.
      assert.match(model.id, /^plan-/);
    }
    // And the key that crossed is the one on the disk, not a second one this answer minted.
    assert.equal(row.included.key, pair.proxyKey);
  } finally { pair.stop(); }
});

test("the relay boots against the real control plane and says which workspaces it serves", async () => {
  const pair = await startPair();
  try {
    assert.match(pair.relay.boot, /work 2: acme, titanium/, pair.relay.boot);
    // The operator's own workspace is the relay's own environment and never the control plane's,
    // which is what keeps this console up when the control plane is not.
    assert.equal(pair.relay.boot.includes(GATEWAY_TOKEN), false, "a customer's gateway token reached the relay's log");
    assert.equal(pair.relay.boot.includes(pair.relayToken), false, "the relay credential reached the relay's log");
    assert.equal(pair.relay.boot.includes(pair.master), false, "the control plane's master reached the relay's log");
  } finally { pair.stop(); }
});

test("a customer signs in at the one console with the key the control plane derived", async () => {
  const pair = await startPair();
  try {
    const page = await fetch(`${pair.relay.base}/login`, { redirect: "manual" });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /type="email"/i, "a control plane answered, so the account door has to be on the page");

    const login = await fetch(`${pair.relay.base}/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: ACCOUNT, password: PASSWORD }).toString(),
    });
    // A 302 here is the whole point: the control plane minted the token with the key it derived for
    // this customer, and the relay verified it with the key it read off the registry route. Those
    // are two derivations in two processes, and only one of them holds the master.
    assert.equal(login.status, 302, `the customer could not sign in: ${(await login.text()).slice(0, 200)}`);
    assert.equal(login.headers.get("location"), "/");
    const cookie = (login.headers.getSetCookie?.() ?? []).map((one) => one.split(";")[0]).join("; ");
    assert.notEqual(cookie, "", "no session was minted");

    // And the session resolves to that customer's own files. /endpoints reads the endpoints.json in
    // the workspace's state directory, which is the third thing that had to cross the registry
    // route: not the operator's catalogue, and not a 500 for a directory nobody made.
    const catalog = await fetch(`${pair.relay.base}/endpoints`, { redirect: "manual", headers: { cookie } });
    const catalogText = await catalog.text();
    assert.equal(catalog.status, 200, `the customer's own settings did not open: ${catalogText.slice(0, 200)}`);
    assert.ok(Array.isArray(JSON.parse(catalogText).endpoints), "the customer got something that is not a catalogue");
  } finally { pair.stop(); }
});

test("the gateway token the control plane holds is the one the relay matches a box by", async () => {
  const pair = await startPair();
  try {
    // The runtime route's credential is the token in the path, because the caller is a box's own
    // host process. It is measured here because it is the one seam that proves the TOKEN crossed
    // from the control plane to the relay, with no box to answer and no port to hold: 503 is "your
    // workspace matched and there is no runtime directory here", and 404 is "no workspace has that
    // token", so the two are impossible to confuse.
    const known = await fetch(`${pair.relay.base}/runtime/${GATEWAY_TOKEN}/sand-host-bundle-latest.version`);
    assert.equal(known.status, 503, "the token the control plane holds did not match any workspace on the relay");
    const stranger = await fetch(`${pair.relay.base}/runtime/a-token-no-box-here-holds/sand-host-bundle-latest.version`);
    assert.equal(stranger.status, 404, "a token no workspace holds must not be told the path exists");
  } finally { pair.stop(); }
});

test("a workspace the control plane cannot serve is named, and its customer is answered in words", async () => {
  // A tenant with a ledger row and no gateway token on the disk, which is what a customer whose
  // provisioning stopped halfway looks like. The control plane must leave them OUT of the registry
  // and say why, and the relay must answer that customer in words rather than with a 500, a stack
  // trace, or somebody else's console.
  const pair = await startPair({
    extraTenant: { slug: "halfway", name: "Halfway", email: "owner@halfway.test", withToken: false },
  });
  try {
    const body = await (await pair.ask("GET", "/v1/relay/tenants", { token: pair.relayToken })).json();
    assert.equal(body.tenants.some((tenant) => tenant.slug === "halfway"), false, "a workspace with no token was served anyway");
    const named = body.skipped.find((one) => one.slug === "halfway");
    assert.ok(named, `the workspace was dropped without being named: ${JSON.stringify(body.skipped)}`);
    assert.match(named.why, /token/, named.why);

    // A browser, which is what an owner is. The password was right, so this is not a refusal and
    // must not read like one.
    const login = await fetch(`${pair.relay.base}/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ email: "owner@halfway.test", password: PASSWORD }).toString(),
    });
    const text = await login.text();
    assert.equal(login.status, 503, `status ${login.status}`);
    assert.match(text, /That workspace is not available right now\./, text.slice(0, 300));
    assert.equal((login.headers.getSetCookie?.() ?? []).length, 0, "a session was minted for a workspace nobody can serve");

    // And the customer who CAN be served is untouched by their neighbour's half-built workspace.
    const good = await fetch(`${pair.relay.base}/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ email: ACCOUNT, password: PASSWORD }).toString(),
    });
    assert.equal(good.status, 302, "one broken workspace took the working one down with it");
  } finally { pair.stop(); }
});

test("the operator's own account signs in at the one console, and the box it lands on is still the relay's own", async () => {
  // SIGNIN-2, and this is the pairing test for it: the real control plane derives the key and signs
  // the token, the real relay verifies it with the key that crossed the registry route, and the two
  // halves could have spelled that field differently with every other test in the tree still green.
  //
  // MEASURED ON THE R750 2026-09-10 before the change: the control plane's row for `titanium` carried
  // `slug` and `included` and nothing else, the relay's key for that slug was "", and an account
  // there met 503 "That workspace is not available right now." with a correct password while the
  // byte-identical account on `demo` was signed in at once.
  const pair = await startPair({ operator: true });
  try {
    // The row the control plane actually answers for an adopted workspace with no token here: a slug
    // and a derived key, and not one field more.
    const body = await (await pair.ask("GET", "/v1/relay/tenants", { token: pair.relayToken })).json();
    const row = body.tenants.find((tenant) => tenant.slug === "titanium");
    assert.ok(row, `the operator's workspace was left out: ${JSON.stringify(body.skipped)}`);
    assert.deepEqual(Object.keys(row).sort(), ["sessionKey", "slug"]);
    assert.equal(row.sessionKey.length, 64, "a derived key is a hex sha256");
    assert.equal(JSON.stringify(body).includes(pair.master), false, "the master's bytes were in the answer");

    // The sign-in, through the real form on the real login page.
    const login = await fetch(`${pair.relay.base}/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ email: OPERATOR_ACCOUNT, password: PASSWORD }).toString(),
    });
    const text = await login.text();
    assert.equal(login.status, 302, `the operator's own account could not sign in: ${text.slice(0, 300)}`);
    assert.equal(login.headers.get("location"), "/");
    const cookie = (login.headers.getSetCookie?.() ?? []).map((one) => one.split(";")[0]).join("; ");
    assert.notEqual(cookie, "", "no session was minted");

    // And the workspace it landed on is the one this relay builds out of its own environment. The
    // fake box refuses any bearer but the one in SAND_HOST_GATEWAY_TOKEN, so a 200 with Jason's own
    // two agents on it is proof that neither the container nor the token came off the registry route.
    const roster = await fetch(`${pair.relay.base}/api/listAgents`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", cookie }, body: "{}",
    });
    const rosterText = await roster.text();
    assert.equal(roster.status, 200, `the operator's own roster did not come back: ${rosterText.slice(0, 300)}`);
    assert.match(rosterText, /Titan/);
    assert.equal(rosterText.includes("Acme"), false, "the customer's box answered the operator's session");
    assert.ok(pair.operatorBox.asked.length > 0, "the relay never reached the box in its own environment");
    assert.ok(pair.operatorBox.asked.every((one) => one.bearer === OPERATOR_GATEWAY_TOKEN),
      "the relay presented a bearer that did not come from its own environment");

    // The instance password is still a door to the same workspace, which is what a control plane
    // outage leaves the operator holding.
    const byPassword = await fetch(`${pair.relay.base}/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ password: RELAY_PASSWORD }).toString(),
    });
    assert.equal(byPassword.status, 302, "the instance password stopped working");

    // And the customer beside him is untouched: their own account still signs in to their own box.
    const customer = await fetch(`${pair.relay.base}/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ email: ACCOUNT, password: PASSWORD }).toString(),
    });
    assert.equal(customer.status, 302, "the operator's key took the customer's sign-in with it");
  } finally { pair.stop(); }
});

/**
 * ONBOARD-5, and this is the test the wave is not finished without.
 *
 * docs/ONBOARDING.md 14.1: when a wave ships BOTH ENDS of a new HTTP contract, the joining test uses
 * the REAL route. Everything else about sign-in links in this tree has a hand-written double on one
 * side -- the relay suites answer a fake control plane, the control plane suites drive the store
 * directly -- and that is precisely the arrangement in which two correct halves disagree about a field
 * name and every suite stays green. ONBOARD-2 lost a welcome to exactly that, twice.
 *
 * So: the real cp/onboard.mjs mint writing the real store, the real POST /v1/relay/sign-in-links/claim
 * out of cp/server.mjs, and the real ui/server.mjs handleSso reaching it over a real socket.
 */
test("a real sign-in link crosses the real claim route once, and the second click is refused", async () => {
  const pair = await startPair();
  try {
    const tenant = { ...pair.store.getTenant(SLUG), host: "console.titanium.bot" };
    const account = pair.store.getAccountByEmail(ACCOUNT);
    const link = mintSignInLink({
      account, tenant, config: pair.config, store: pair.store, mintedBy: "the pairing test",
    });
    const click = () => fetch(`${pair.relay.base}${new URL(link.url).pathname}${new URL(link.url).search}`,
      { redirect: "manual", headers: { accept: "text/html" } });

    // The row exists before the url is handed out, which is what makes the link answerable at all.
    assert.equal(pair.store.getSignInLink(link.id).usedAt, 0);

    const first = await click();
    assert.equal(first.status, 302, `the real link did not sign in: ${await first.text()}`);
    assert.ok(/gb_session=/.test(first.headers.get("set-cookie") ?? ""));

    // THE CLAIM CROSSED AND THE ROW MOVED. This is the field-name seam: the relay sends {id, tenant,
    // from}, the control plane reads those names, and the row it marks is this one.
    const spent = pair.store.getSignInLink(link.id);
    assert.ok(spent.usedAt > 0, "the control plane did not mark the link used, so it is still multi-use");
    assert.equal(spent.uses, 1);
    assert.ok(spent.usedFrom.length > 0, "the caller's address did not cross");

    // And the same link again, still validly signed and still inside its 24 hours.
    const second = await click();
    assert.equal(second.status, 401);
    assert.equal(/gb_session=/.test(second.headers.get("set-cookie") ?? ""), false);
    assert.match(await second.text(), /That sign-in link has already been used\. Ask for a new one\./);
    // The refused click did not move the row: who came in on this link and when is the fact it keeps.
    assert.equal(pair.store.getSignInLink(link.id).uses, 1);
  } finally { pair.stop(); }
});

test("a link the control plane has revoked is refused by the real relay, and one it never recorded too", async () => {
  const pair = await startPair();
  try {
    const tenant = { ...pair.store.getTenant(SLUG), host: "console.titanium.bot" };
    const account = pair.store.getAccountByEmail(ACCOUNT);
    const mint = () => mintSignInLink({ account, tenant, config: pair.config, store: pair.store });
    const click = (url) => fetch(`${pair.relay.base}${new URL(url).pathname}${new URL(url).search}`,
      { redirect: "manual", headers: { accept: "text/html" } });

    // Revoked on the control plane. The token is untouched and still verifies under the workspace's own
    // derived key, which is the entire reason a signature cannot be the whole answer.
    const killed = mint();
    pair.store.revokeSignInLink(killed.id, { by: "jason@titaniumcomputing.test" });
    const refused = await click(killed.url);
    assert.equal(refused.status, 401);
    assert.match(await refused.text(), /That sign-in link was cancelled\. Ask for a new one\./);

    // A link minted the way ONE WAS BEFORE TONIGHT: a valid token for this workspace whose jti was
    // never written down. This is every link mailed before ONBOARD-5 shipped, and it is refused.
    const unrecorded = mintSignInLink({
      account, tenant, config: pair.config,
      // A store that signs nothing down, standing in for the code that used to be here.
      store: { recordSignInLink: () => null },
    });
    const old = await click(unrecorded.url);
    assert.equal(old.status, 401);
    assert.match(await old.text(), /That sign-in link is not on record here, so it cannot be used\. Ask for a new one\./);

    // A fresh one still works, so none of the above is the door being broken.
    assert.equal((await click(mint().url)).status, 302);
  } finally { pair.stop(); }
});

test("the claim route is opened by the relay credential and by nothing else", async () => {
  const pair = await startPair();
  try {
    const tenant = { ...pair.store.getTenant(SLUG), host: "console.titanium.bot" };
    const link = mintSignInLink({
      account: pair.store.getAccountByEmail(ACCOUNT), tenant, config: pair.config, store: pair.store,
    });
    const body = { id: link.id, tenant: SLUG };

    // No credential, and the ADMIN credential, which adds accounts and deletes services and must never
    // be able to spend a sign-in link. Neither one touches the row.
    assert.equal((await pair.ask("POST", "/v1/relay/sign-in-links/claim", { body })).status, 401);
    assert.equal((await pair.ask("POST", "/v1/relay/sign-in-links/claim", { body, token: pair.adminToken })).status, 401);
    assert.equal(pair.store.getSignInLink(link.id).usedAt, 0, "a refused claim spent the link anyway");

    // A wrong method charges nobody and learns nothing, the same order every other relay route uses.
    assert.equal((await pair.ask("GET", "/v1/relay/sign-in-links/claim", { token: pair.relayToken })).status, 405);
    // And a body with nothing in it is a caller bug rather than a verdict, so it is the one 4xx here.
    const empty = await pair.ask("POST", "/v1/relay/sign-in-links/claim", { body: {}, token: pair.relayToken });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, "bad_request");

    // The relay credential opens it, and the refusals come back as a 200 with a verdict: the question
    // WAS answered, and the relay has to tell "the control plane said no" from "I could not ask".
    const good = await pair.ask("POST", "/v1/relay/sign-in-links/claim", { body, token: pair.relayToken });
    assert.equal(good.status, 200);
    const verdict = await good.json();
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verdict, "good");
    assert.equal(verdict.email, ACCOUNT);
    assert.equal(verdict.singleUse, true);

    const again = await pair.ask("POST", "/v1/relay/sign-in-links/claim", { body, token: pair.relayToken });
    assert.equal(again.status, 200, "a spent link is an answer and not an error");
    assert.equal((await again.json()).verdict, "used");

    // NO TOKEN IN EITHER DIRECTION. The answer carries the id's verdict and the person's address, and
    // nothing anybody could sign in with.
    const unknown = await pair.ask("POST", "/v1/relay/sign-in-links/claim",
      { body: { id: "a-jti-nobody-recorded", tenant: SLUG }, token: pair.relayToken });
    assert.equal((await unknown.json()).verdict, "unknown");
    assert.equal(JSON.stringify(verdict).includes(new URL(link.url).searchParams.get("sso")), false);
  } finally { pair.stop(); }
});
