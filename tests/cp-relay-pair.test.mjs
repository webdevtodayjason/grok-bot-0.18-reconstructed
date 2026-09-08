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
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { createApp, createHttpServer } from "../cp/server.mjs";
import { ensureProxyKey, loadConfig, tenantPaths } from "../cp/provision.mjs";
import { openStore } from "../cp/store.mjs";
import { startRelay } from "./relay-tenant-support.mjs";
import { startFakeProxy } from "./cp-proxy-support.mjs";

const SLUG = "acme";
const ACCOUNT = "owner@acme.test";
const PASSWORD = "an account password of real length";
const GATEWAY_TOKEN = "the-gateway-token-of-acmes-own-box";
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

async function startPair({ extraTenant = null, withProxy = false } = {}) {
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

  const relay = await startRelay(
    { CP_URL: cp, CP_RELAY_TOKEN: relayToken, SAND_BOX_CONTAINER: "titanbot-box-operator" },
    { prefix: "pair-relay-", pathValue: dockerStub([BOX, "titanbot-box-operator"]) },
  );
  return {
    cp, ask, relay, master, relayToken, adminToken, proxyKey,
    stop: () => { relay.stop(); server.close(); if (proxy) void proxy.close(); },
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
  //                modelLabel}], enforced}
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
    assert.deepEqual(Object.keys(row.included).sort(), ["baseUrl", "enforced", "key", "keyId", "models"]);
    assert.equal(typeof row.included.baseUrl, "string");
    // Plain http to a private name on the docker bridge. That is precisely what the relay's tenant
    // endpoint guard refuses, and the guard is NOT relaxed for it: these rows never enter a
    // customer's endpoints.json, the relay computes them from this answer.
    assert.match(row.included.baseUrl, /^http:\/\/[^/]+\/v1$/);
    assert.notEqual(row.included.key, "", "the relay was handed no key to use");
    assert.equal(typeof row.included.enforced, "boolean");
    assert.ok(Array.isArray(row.included.models) && row.included.models.length > 0);
    for (const model of row.included.models) {
      assert.deepEqual(Object.keys(model).sort(), ["contextWindow", "id", "model", "modelLabel", "name", "servedBy"]);
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
