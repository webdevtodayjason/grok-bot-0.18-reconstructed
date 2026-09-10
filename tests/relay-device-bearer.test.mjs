// STORE-1, against a real relay on a real port. What a phone or desktop shell actually meets.
//
// The unit tests next door prove the token and the rows. This file proves the six things only a whole
// relay can answer, each of which would otherwise be a plausible-sounding claim:
//
//   1. A device bearer CAN DO NO MORE THAN THE COOKIE AND STRICTLY LESS. It never mints a session
//      cookie, it is refused on /v1, and a token for one workspace does not open another's.
//   2. A REFUSAL IS SOMETHING A SHELL CAN BRANCH ON. A request carrying an Authorization header is
//      never 302'd into the login page, whatever its Accept header says.
//   3. CORS ADMITS AN EXACT-STRING SET AND NEVER ALLOWS CREDENTIALS, and a preflight is answered
//      ABOVE the login gate, because a browser sends no credential on one.
//   4. A FAILED MINT CHARGES THE PASSWORD LOCKOUT AND A FLOOD OF FAILED USES DOES NOT. Getting this
//      backwards locks a customer out of his own laptop's console over an app with a stale token.
//   5. A SUB-LESS COOKIE READS AS THE OPERATOR, which is what keeps a session alive across the deploy
//      that adds the claim, and is the same precedent the tenant claim already set.
//   6. A REVOKE BITES WITHIN ONE CACHE WINDOW, measured rather than asserted.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createSession } from "../ui/auth.mjs";
import { mintSessionToken } from "../ui/session-token.mjs";
import { DEVICE_CACHE_MS, DEVICE_TOKEN_PREFIX, readDeviceToken, signDeviceToken } from "../ui/auth-device.mjs";
import {
  RELAY_PASSWORD, RELAY_TOKEN, cookieOf, keyFor, signInAsOperator, startRelay, tenantRow, tenantsFile,
  tokenFor,
} from "./relay-tenant-support.mjs";

const OPERATOR = "titanium";
const json = { "content-type": "application/json" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The cookie secret the relay is actually using, read out of the copy it booted from, so a test can
// forge a token the relay will verify -- which is how the expiry and the wrong-tenant legs are written
// without waiting thirty days or standing up a second workspace's control plane.
const secretOf = (relay) => JSON.parse(readFileSync(path.join(relay.dir, "auth.json"), "utf8")).cookieSecret;

async function mint(relay, body, headers = {}) {
  const res = await fetch(`${relay.base}/auth/token`, {
    method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* a 413 has no body worth reading */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

const withBearer = (token) => ({ authorization: `Bearer ${token}` });

test("the instance password mints a named device bearer, and the bearer opens /api", async () => {
  const relay = await startRelay();
  try {
    const answer = await mint(relay, { password: RELAY_PASSWORD, device: { name: "Jason iPhone", platform: "ios" } });
    assert.equal(answer.status, 200);
    assert.ok(String(answer.body.token).startsWith(DEVICE_TOKEN_PREFIX));
    assert.equal(answer.body.tenant, OPERATOR, "the instance password is the operator's door");
    assert.equal(answer.body.renewed, false);
    assert.equal(answer.body.device.name, "Jason iPhone");
    assert.equal(answer.body.device.platform, "ios");
    assert.ok(answer.body.expiresAt > Date.now() + 29 * 24 * 3600_000, "thirty days");
    // The token is in the body and NOWHERE else. A Set-Cookie here would be a credential the browser
    // keeps sending, which is the thing a device bearer exists not to be.
    assert.equal(answer.headers.get("set-cookie"), null);

    // 502 from a gateway nothing listens on is proof of getting PAST the gate, which is what this
    // leg measures. The harness points every relay at a dead port for exactly this reason.
    const api = await fetch(`${relay.base}/api/getHealth`, { method: "POST", headers: { ...json, ...withBearer(answer.body.token) }, body: "{}" });
    assert.equal(api.status, 502, `a device bearer reaches the gateway: ${await api.text()}`);

    const devices = await (await fetch(`${relay.base}/auth/devices`, { headers: withBearer(answer.body.token) })).json();
    assert.equal(devices.devices.length, 1);
    assert.equal(devices.devices[0].id, answer.body.device.id);
    assert.equal(devices.devices[0].token, undefined, "the list never carries a token");
  } finally { relay.stop(); }
});

test("a wrong password is refused, and five of them charge the same lockout the login page does", async () => {
  const relay = await startRelay();
  try {
    for (let i = 0; i < 5; i += 1) {
      const bad = await mint(relay, { password: "not it", device: { name: "a phone", platform: "ios" } });
      assert.equal(bad.status, 401, `attempt ${i + 1}`);
      assert.equal(bad.headers.get("x-relay-auth"), "required");
    }
    // A mint is a password guess and is counted as one. The shared throttle is the SAME object the
    // login page and the job bus read, so a locked address is locked at every door -- which is the
    // point, and is why the USE of a bad bearer deliberately does not touch it.
    const locked = await mint(relay, { password: "not it", device: {} });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
    const page = await fetch(`${relay.base}/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ password: RELAY_PASSWORD }).toString(),
    });
    assert.equal(page.status, 429, "the login page is locked too: one bucket per address, all three doors");
  } finally { relay.stop(); }
});

test("a flood of bad bearers is rate limited and does NOT lock the customer out of his own console", async () => {
  const relay = await startRelay();
  try {
    const stale = signDeviceToken({ tenant: OPERATOR, did: "dev_gone" }, secretOf(relay)).token;
    // Sixty a minute, then 429. An app is told to stop on a 401, re-mint once, then ask the person --
    // but an app that loops anyway must cost its owner nothing but its own speed limit.
    let refusals = 0;
    let limited = 0;
    for (let i = 0; i < 70; i += 1) {
      const res = await fetch(`${relay.base}/api/getHealth`, { method: "POST", headers: { ...json, ...withBearer(stale) }, body: "{}" });
      if (res.status === 401) refusals += 1;
      else if (res.status === 429) limited += 1;
      else assert.fail(`unexpected ${res.status}`);
      assert.equal(res.headers.get("x-relay-auth"), "required", "every refusal is one the app can branch on");
    }
    assert.ok(refusals >= 55 && refusals <= 60, `about sixty get through before the window closes: ${refusals}`);
    assert.ok(limited > 0, "and then it is limited");

    // THE WHOLE POINT OF THIS LEG: the password door is still open. If the bad-bearer flood had charged
    // the shared lockout, seventy of them would have locked this address out of the console.
    const cookie = await signInAsOperator(relay);
    assert.ok(cookie.length > 0, "the person can still sign in on the password");
  } finally { relay.stop(); }
});

test("the same POST carrying a live bearer re-mints silently, so an app never asks for the password again", async () => {
  const relay = await startRelay();
  try {
    const first = await mint(relay, { password: RELAY_PASSWORD, device: { id: "dev_keychain", name: "iPhone", platform: "ios" } });
    assert.equal(first.status, 200);
    await sleep(5);
    const renewed = await mint(relay, { device: { id: "dev_keychain", name: "iPhone", platform: "ios" } }, withBearer(first.body.token));
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.renewed, true);
    assert.equal(renewed.body.device.id, "dev_keychain", "the same row, refreshed rather than a second device");
    assert.notEqual(renewed.body.token, first.body.token);

    const devices = await (await fetch(`${relay.base}/auth/devices`, { headers: withBearer(renewed.body.token) })).json();
    assert.equal(devices.devices.length, 1, "one device, not two");

    // And the token it replaced is dead, which is what makes a re-mint worth doing after a phone is
    // stolen. The signature is still good; the ROW says this is not the current credential.
    const old = await fetch(`${relay.base}/api/getHealth`, { method: "POST", headers: { ...json, ...withBearer(first.body.token) }, body: "{}" });
    assert.equal(old.status, 401);

    // With no credential and no live bearer there is nothing to re-mint from.
    const naked = await mint(relay, { device: { id: "dev_keychain" } });
    assert.equal(naked.status, 401);
  } finally { relay.stop(); }
});

test("a revoked device stops within one cache window, and the refusal says so", async () => {
  const relay = await startRelay();
  try {
    const answer = await mint(relay, { password: RELAY_PASSWORD, device: { name: "iPhone", platform: "ios" } });
    const token = answer.body.token;
    const gone = await fetch(`${relay.base}/auth/devices/${answer.body.device.id}`, { method: "DELETE", headers: withBearer(token) });
    assert.equal(gone.status, 200);

    await sleep(DEVICE_CACHE_MS + 400);
    const after = await fetch(`${relay.base}/api/getHealth`, { method: "POST", headers: { ...json, ...withBearer(token) }, body: "{}" });
    assert.equal(after.status, 401, `a revoke bites within ${DEVICE_CACHE_MS} ms`);
    assert.equal(after.headers.get("x-relay-auth"), "required");

    // A device nobody holds is a 404 and not a 500, and a method nobody meant is a 405.
    const cookie = await signInAsOperator(relay);
    const missing = await fetch(`${relay.base}/auth/devices/dev_nothing`, { method: "DELETE", headers: { cookie } });
    assert.equal(missing.status, 404);
    const wrong = await fetch(`${relay.base}/auth/devices`, { method: "DELETE", headers: { cookie } });
    assert.equal(wrong.status, 405);
  } finally { relay.stop(); }
});

test("an expired token, another workspace's token and a token for a workspace we do not serve are all 401", async () => {
  const demo = tenantRow("demo");
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1", CP_RELAY_TOKEN: RELAY_TOKEN, SAND_UI_TENANTS_FILE: tenantsFile([demo.row]),
  }, { pathValue: "/nonexistent" });
  try {
    const secret = secretOf(relay);
    const expired = signDeviceToken({ tenant: OPERATOR, did: "dev_old", nowMs: Date.now() - 40 * 24 * 3600_000 }, secret).token;
    assert.equal(readDeviceToken(expired, secret), null, "dead before the relay is even asked");
    const one = await fetch(`${relay.base}/api/getHealth`, { method: "POST", headers: { ...json, ...withBearer(expired) }, body: "{}" });
    assert.equal(one.status, 401);

    // A token naming a workspace this console does not serve. The signature is OURS and verifies; the
    // tenant does not resolve, so there is nothing to open.
    const elsewhere = signDeviceToken({ tenant: "not-a-workspace", did: "dev_x" }, secret).token;
    const two = await fetch(`${relay.base}/api/getHealth`, { method: "POST", headers: { ...json, ...withBearer(elsewhere) }, body: "{}" });
    assert.equal(two.status, 401);

    // And a token whose signature is somebody else's entirely.
    const forged = signDeviceToken({ tenant: OPERATOR, did: "dev_x" }, keyFor("demo")).token;
    const three = await fetch(`${relay.base}/api/getHealth`, { method: "POST", headers: { ...json, ...withBearer(forged) }, body: "{}" });
    assert.equal(three.status, 401);

    // A token minted FOR demo reads demo's box, not the operator's: the tenant comes off the verified
    // payload, so one workspace's phone cannot be pointed at another's.
    const forDemo = signDeviceToken({ tenant: "demo", did: "dev_demo" }, secret).token;
    const four = await fetch(`${relay.base}/api/getHealth`, { method: "POST", headers: { ...json, ...withBearer(forDemo) }, body: "{}" });
    // The row does not exist in demo's state directory, so this is 401 rather than 502. That IS the
    // answer: a signed payload alone is not a device, which is the whole reason the rows exist.
    assert.equal(four.status, 401);
  } finally { relay.stop(); }
});

test("a device bearer is refused on /v1 and never mints a session cookie on a page", async () => {
  const relay = await startRelay({ TITAN_JOB_TOKEN: "a".repeat(48) });
  try {
    const answer = await mint(relay, { password: RELAY_PASSWORD, device: { name: "iPhone", platform: "ios" } });
    const token = answer.body.token;

    // The job bus keeps its own token and the two doors never see each other's credential.
    const bus = await fetch(`${relay.base}/v1/jobs`, { method: "POST", headers: { ...json, ...withBearer(token) }, body: "{}" });
    assert.equal(bus.status, 401);
    assert.equal(bus.headers.get("x-relay-auth"), "required");

    // And it charged nothing: the password door is still open right after.
    assert.ok((await signInAsOperator(relay)).length > 0);

    // A page request on a device bearer gets NO Set-Cookie. A cookie is strictly more than a device
    // token is meant to be -- it opens the websocket upgrade, which is the box's screen -- and on an
    // asset response a Set-Cookie is also a Cloudflare cache bypass.
    for (const pathname of ["/", "/auth/devices"]) {
      const page = await fetch(`${relay.base}${pathname}`, { headers: { ...withBearer(token), accept: "text/html" } });
      assert.equal(page.headers.get("set-cookie"), null, pathname);
    }
  } finally { relay.stop(); }
});

test("a request carrying an Authorization header is never redirected into the login page", async () => {
  const relay = await startRelay();
  try {
    const stale = signDeviceToken({ tenant: OPERATOR, did: "dev_gone" }, secretOf(relay)).token;
    // THE MEASURED BUG: Accept: text/html is what a web view sends on a document fetch and what an app
    // sends when it copies the browser's own headers, so a cross-origin read whose bearer had expired
    // followed a 302 and got 200 OK with a sign-in form in it. An app cannot branch on that.
    const res = await fetch(`${relay.base}/`, {
      redirect: "manual", headers: { ...withBearer(stale), accept: "text/html,application/xhtml+xml" },
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("x-relay-auth"), "required");
    assert.equal(res.headers.get("location"), null);

    // A browser with no header still gets the redirect: that is the person who needs a sign-in page.
    const browser = await fetch(`${relay.base}/`, { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(browser.status, 302);
    assert.match(String(browser.headers.get("location")), /^\/login\?next=/);
  } finally { relay.stop(); }
});

test("a preflight is answered above the login gate, for exactly the named origins, with no credentials", async () => {
  const relay = await startRelay({ SAND_UI_APP_ORIGINS: "capacitor://localhost,titaniumbot://desktop" });
  try {
    for (const origin of ["capacitor://localhost", "titaniumbot://desktop"]) {
      // /api is below the login gate, and a browser sends NO cookie and NO Authorization on a
      // preflight -- so answering this below the gate would be a 401 and every cross-origin call a
      // shell makes would die on it.
      const pre = await fetch(`${relay.base}/api/getHealth`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
      });
      assert.equal(pre.status, 204, origin);
      assert.equal(pre.headers.get("access-control-allow-origin"), origin, "the exact string, never a wildcard");
      assert.equal(pre.headers.get("access-control-allow-credentials"), null,
        "credentials would trade SameSite=Strict away for a cookie the browser never sends anyway");
      assert.match(String(pre.headers.get("access-control-allow-headers")), /authorization/);
      assert.equal(pre.headers.get("vary"), "origin");
    }

    // https://localhost is NOT in the set this relay was given, which is what proves the set is the
    // env value and not a default that quietly also allows the default pair.
    for (const liar of ["https://localhost", "https://localhost.evil.example", "https://evil.example"]) {
      const pre = await fetch(`${relay.base}/api/getHealth`, { method: "OPTIONS", headers: { origin: liar, "access-control-request-method": "POST" } });
      assert.equal(pre.status, 403, liar);
      assert.equal(pre.headers.get("access-control-allow-origin"), null, liar);
    }

    // A real request from an allowed origin carries the header; one from nobody's origin carries none
    // and is otherwise untouched, which is what keeps a native client sending no Origin at all working.
    const answer = await mint(relay, { password: RELAY_PASSWORD, device: { name: "iPhone", platform: "ios" } }, { origin: "capacitor://localhost" });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("access-control-allow-origin"), "capacitor://localhost");
    assert.equal(answer.headers.get("access-control-allow-credentials"), null);

    const plain = await mint(relay, { password: RELAY_PASSWORD, device: { name: "iPhone", platform: "ios" } });
    assert.equal(plain.status, 200, "no Origin at all is not a CORS request and is answered as it always was");
    assert.equal(plain.headers.get("access-control-allow-origin"), null);
  } finally { relay.stop(); }
});

test("a cookie with no sub reads as the operator, which is what keeps a session alive across the deploy", async () => {
  const relay = await startRelay();
  try {
    const secret = secretOf(relay);
    // Exactly the cookie the deploy before this one minted: a tenant claim and no person.
    const old = createSession(secret, { tenant: OPERATOR });
    const list = await (await fetch(`${relay.base}/auth/devices`, { headers: { cookie: `gb_session=${encodeURIComponent(old)}` } })).json();
    assert.equal(list.tenant, OPERATOR);
    assert.deepEqual(list.devices, [], "the workspace's own rows, which is what a sub-less session means");

    // And one WITH a person is a different list, which is the whole reason the claim was added: two
    // accounts can share a workspace (accounts.tenant has no UNIQUE constraint).
    const withSub = createSession(secret, { tenant: OPERATOR, sub: "acct_7" });
    const mine = await mint(relay, { password: RELAY_PASSWORD, device: { name: "the workspace phone", platform: "ios" } });
    assert.equal(mine.status, 200);
    const theirs = await (await fetch(`${relay.base}/auth/devices`, { headers: { cookie: `gb_session=${encodeURIComponent(withSub)}` } })).json();
    assert.deepEqual(theirs.devices, [], "the instance password's device is not acct_7's");
    const operator = await (await fetch(`${relay.base}/auth/devices`, { headers: { cookie: `gb_session=${encodeURIComponent(old)}` } })).json();
    assert.equal(operator.devices.length, 1);
  } finally { relay.stop(); }
});

test("the control plane can list and revoke a device on its own credential, and nobody else can", async () => {
  const relay = await startRelay({ CP_URL: "http://127.0.0.1:1", CP_RELAY_TOKEN: RELAY_TOKEN });
  try {
    const answer = await mint(relay, { password: RELAY_PASSWORD, device: { name: "a lost iPhone", platform: "ios" } });
    const id = answer.body.device.id;
    const admin = { authorization: `Bearer ${RELAY_TOKEN}` };

    const list = await fetch(`${relay.base}/admin/tenants/${OPERATOR}/devices`, { headers: admin });
    assert.equal(list.status, 200);
    const rows = (await list.json()).devices;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "a lost iPhone");
    assert.equal(rows[0].token, undefined);

    // A console session must not open this route: it is the control plane's credential and nobody
    // else's, the same rule every other /admin route in this band has.
    const cookie = await signInAsOperator(relay);
    assert.equal((await fetch(`${relay.base}/admin/tenants/${OPERATOR}/devices`, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(`${relay.base}/admin/tenants/${OPERATOR}/devices`, { headers: withBearer(answer.body.token) })).status, 401);

    const revoke = await fetch(`${relay.base}/admin/tenants/${OPERATOR}/devices?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: admin });
    assert.equal(revoke.status, 200);
    await sleep(DEVICE_CACHE_MS + 400);
    const dead = await fetch(`${relay.base}/api/getHealth`, { method: "POST", headers: { ...json, ...withBearer(answer.body.token) }, body: "{}" });
    assert.equal(dead.status, 401, "a phone killed from the cp container is a phone that stops");

    assert.equal((await fetch(`${relay.base}/admin/tenants/${OPERATOR}/devices`, { method: "DELETE", headers: admin })).status, 400, "name a device");
    assert.equal((await fetch(`${relay.base}/admin/tenants/nope/devices`, { headers: admin })).status, 404);
    assert.equal((await fetch(`${relay.base}/admin/tenants/${OPERATOR}/devices`, { method: "POST", headers: admin })).status, 405);
  } finally { relay.stop(); }
});

// A control plane on a real port, answering /v1/sessions and /v1/relay/tenants the way the real one
// does. Real fetch, real port, so what the mint runs through is the shipping code; the only thing
// faked is the control plane's own decision, which is exactly the part the relay is not allowed to
// trust. The same shape tests/relay-tenant-login.test.mjs uses.
function startFakeControlPlane({ accounts, tenants }) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/relay/tenants") {
        if (String(req.headers.authorization ?? "") !== `Bearer ${RELAY_TOKEN}`) {
          res.writeHead(401, json); return res.end(JSON.stringify({ error: "unauthorized" }));
        }
        res.writeHead(200, json); return res.end(JSON.stringify({ tenants, skipped: [] }));
      }
      if (req.method !== "POST" || req.url !== "/v1/sessions") { res.writeHead(404, json); return res.end("{}"); }
      let fields = {};
      try { fields = JSON.parse(body); } catch { /* a body that is not JSON is a refusal */ }
      const account = accounts[String(fields.email ?? "").toLowerCase()];
      if (account == null || account.password !== fields.password) {
        res.writeHead(401, json); return res.end(JSON.stringify({ error: "invalid_login" }));
      }
      const now = Date.now();
      // Minted here rather than through the harness's tokenFor, which stamps one sub per TENANT. The
      // thing this leg exists to prove is two DIFFERENT people on one workspace, so each account's own
      // id has to be in its own token -- which is what the real control plane does.
      res.writeHead(200, json);
      res.end(JSON.stringify({
        token: mintSessionToken({
          sub: account.id, email: String(fields.email), tenant: account.tenant,
          host: "console.titanium.bot", iat: now, exp: now + 3600_000, jti: `${account.id}-${now}`,
        }, keyFor(account.tenant), now).token,
        account: { id: account.id, email: fields.email, name: "A Customer" },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

test("an account signs an app in, the token names that person, and two people on one workspace stay apart", async () => {
  const demo = tenantRow("demo");
  const cp = await startFakeControlPlane({
    accounts: {
      // TWO ACCOUNTS, ONE WORKSPACE. accounts.tenant has no UNIQUE constraint (cp/store.mjs), so this
      // is the shape in production and not a contrivance -- it is the whole reason `sub` exists.
      "owner@demo.example": { id: "acct_owner", password: "the owner's password", tenant: "demo" },
      "partner@demo.example": { id: "acct_partner", password: "the partner's password", tenant: "demo" },
    },
    tenants: [demo.row],
  });
  // pathValue: no docker on PATH, so the box-name verification learns nothing and every registry row
  // is taken at its word. Without it this relay finds no container called titanbot-box-demo on the
  // machine it is running on and answers "that workspace is not available", which is correct and is a
  // different test.
  const relay = await startRelay({ CP_URL: cp.url, CP_RELAY_TOKEN: RELAY_TOKEN }, { pathValue: "/nonexistent" });
  try {
    const owner = await mint(relay, {
      email: "owner@demo.example", password: "the owner's password",
      device: { name: "the owner's iPhone", platform: "ios" },
    });
    assert.equal(owner.status, 200);
    assert.equal(owner.body.tenant, "demo", "the tenant comes off the VERIFIED token, never off the form");
    const claims = readDeviceToken(owner.body.token, secretOf(relay));
    assert.equal(claims.tenant, "demo");
    assert.equal(claims.sub, "acct_owner", "the person, off the same verified token mintAccountSession reads");

    const partner = await mint(relay, {
      email: "partner@demo.example", password: "the partner's password",
      device: { name: "the partner's Pixel", platform: "android" },
    });
    assert.equal(partner.status, 200);

    // Two people, one workspace, two device lists. Before the sub claim this was one list and either
    // of them could revoke the other's phone.
    const ownerList = await (await fetch(`${relay.base}/auth/devices`, { headers: withBearer(owner.body.token) })).json();
    const partnerList = await (await fetch(`${relay.base}/auth/devices`, { headers: withBearer(partner.body.token) })).json();
    assert.deepEqual(ownerList.devices.map((one) => one.name), ["the owner's iPhone"]);
    assert.deepEqual(partnerList.devices.map((one) => one.name), ["the partner's Pixel"]);

    const poach = await fetch(`${relay.base}/auth/devices/${partnerList.devices[0].id}`, {
      method: "DELETE", headers: withBearer(owner.body.token),
    });
    assert.equal(poach.status, 404, "one person cannot take away the other's phone");

    const wrong = await mint(relay, { email: "owner@demo.example", password: "not the password", device: {} });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("x-relay-auth"), "required");
  } finally { relay.stop(); await cp.stop(); }
});

test("an oversized mint body is refused without the relay buffering it, and a non-POST is a 405", async () => {
  const relay = await startRelay();
  try {
    const res = await fetch(`${relay.base}/auth/token`, { method: "POST", headers: json, body: "x".repeat(9 * 1024) });
    assert.equal(res.status, 413);
    assert.equal((await fetch(`${relay.base}/auth/token`)).status, 405);
    assert.equal((await mint(relay, "not json")).status, 400);
  } finally { relay.stop(); }
});
