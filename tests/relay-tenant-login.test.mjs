// TENANT-5, items 3, 4 and 6. One console, one login page, every workspace.
//
// The relay has always had one door: an instance password read once at boot. A customer needs a
// second one, their own account, and the thing that makes it safe is that the relay verifies the
// control plane's token itself, with the key that belongs to the workspace the token names, before
// it mints anything.
//
// What TENANT-5 changed is that there is no longer one relay per customer. console.titanium.bot is
// everybody's front door, so this file is handed a LOOKUP of keys rather than one key, and the
// redirect to <slug>.titanium.bot went away with the hostnames it pointed at. A right password for
// a workspace this console does not serve is not a redirect and not a refusal: it is the plain
// "That workspace is not available right now.", the same sentence a session for a workspace that is
// still being built gets.
//
// Five failures are worth naming, because each of them looks like working software:
//   - a token for another customer, validly signed by the same control plane, accepted here;
//   - a forged sign-in link accepted because the query string was believed;
//   - the instance password stopping working the day the account door was added;
//   - the control plane being down turning into a locked-out operator instead of a sentence;
//   - the registry route answering anyone who asks, which would publish every workspace's gateway
//     token in one GET.
// There is a test below for each.
//
// The control plane in these tests is a real http server in this process, so the relay makes a real
// fetch to a real port and the mint and verify are the shipping code. Nothing is stubbed except the
// control plane's own decisions, which is exactly the part a relay is not allowed to trust.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import { base64urlEncode, mintSessionToken } from "../ui/session-token.mjs";
import { OPERATOR_SLUG } from "../ui/tenant-registry.mjs";
import { accountSignIn, relayConfig, ssoVerdict, CP_TIMEOUT_MS } from "../ui/tenant-login.mjs";
import {
  MASTER, RELAY_PASSWORD, RELAY_TOKEN, cookieOf, form, keyFor, startRelay, tenantRow, tenantsFile,
  tokenFor,
} from "./relay-tenant-support.mjs";

const TENANT = "demo";
const OTHER = "acme";
const KEY = keyFor(TENANT);
const OTHER_KEY = keyFor(OTHER);

// The lookup the console hands the module: this console serves demo and nobody else.
const keyOf = (slug) => (slug === TENANT ? KEY : "");

// ---- the module, with the control plane faked at the fetch ------------------------------------

test("the account door needs both variables, and one of two is none", () => {
  const full = { CP_URL: "https://api.titanium.bot/", CP_RELAY_TOKEN: RELAY_TOKEN };
  assert.deepEqual(relayConfig(full), { cpUrl: "https://api.titanium.bot", relayToken: RELAY_TOKEN });
  for (const missing of ["CP_URL", "CP_RELAY_TOKEN"]) {
    assert.equal(relayConfig({ ...full, [missing]: "" }), null, `${missing} empty must mean no account door`);
    assert.equal(relayConfig({ ...full, [missing]: "   " }), null);
    const without = { ...full };
    delete without[missing];
    assert.equal(relayConfig(without), null);
  }
  assert.equal(relayConfig({}), null);
});

const config = { cpUrl: "https://api.titanium.bot", relayToken: RELAY_TOKEN };

// A fetch that answers like the control plane, and records what it was asked.
function fakeCp(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: async () => {
        if (answer.body === undefined) throw new Error("not json");
        return answer.body;
      },
    };
  };
  return { fetchImpl, calls };
}

test("a right password for a workspace we serve comes back as a verified session", async () => {
  const now = 1_800_000_000_000;
  const token = tokenFor(TENANT, KEY, { now });
  const cp = fakeCp({ status: 200, body: { token, expiresAt: new Date(now + 3_600_000).toISOString() } });
  const verdict = await accountSignIn({ config, email: "demo@titanium.bot", password: "hunter2hunter2", keyOf, ...cp, now: now + 1000 });
  assert.equal(verdict.kind, "session");
  assert.equal(verdict.payload.tenant, TENANT);

  // The call itself: the right route, a POST, and the password in the body and nowhere else.
  assert.equal(cp.calls.length, 1);
  assert.equal(cp.calls[0].url, "https://api.titanium.bot/v1/sessions");
  assert.equal(cp.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(cp.calls[0].init.body), { email: "demo@titanium.bot", password: "hunter2hunter2" });
  assert.ok(cp.calls[0].init.signal, `the call carries a timeout (${CP_TIMEOUT_MS} ms)`);
  // The relay credential opens the registry route and nothing else. It must never be sent with a
  // customer's password.
  assert.equal(JSON.stringify(cp.calls[0].init).includes(RELAY_TOKEN), false);
});

test("the sign-in tells the control plane who is actually signing in", async () => {
  const now = 1_800_000_000_000;
  const token = tokenFor(TENANT, KEY, { now });
  const cp = fakeCp({ status: 200, body: { token } });
  await accountSignIn({ config, email: "demo@titanium.bot", password: "hunter2hunter2", client: "203.0.113.44", keyOf, ...cp, now: now + 1 });
  // Without this the control plane counts its address lockout against this container, so every
  // customer shares one bucket there: the fleet is locked out by one guesser.
  assert.equal(cp.calls[0].init.headers["x-forwarded-for"], "203.0.113.44");

  // And with no client to name, the header is absent rather than empty: an empty forwarded value is
  // a hop that parses as nothing, which is worse than saying nothing at all.
  const quiet = fakeCp({ status: 200, body: { token } });
  await accountSignIn({ config, email: "demo@titanium.bot", password: "hunter2hunter2", keyOf, ...quiet, now: now + 1 });
  assert.equal("x-forwarded-for" in quiet.calls[0].init.headers, false);
});

test("a token this control plane signed for a workspace we do not serve is not a session here", async () => {
  const now = 1_800_000_000_000;
  const token = tokenFor(OTHER, OTHER_KEY, { now });
  const cp = fakeCp({ status: 200, body: { token } });
  const verdict = await accountSignIn({ config, email: "somebody@acme.example", password: "their password", keyOf, ...cp, now });
  // Not refused: their password was right. Not accepted either, and there is no other console to
  // send them to any more.
  assert.equal(verdict.kind, "unknown");
  assert.equal(verdict.slug, OTHER);
});

test("a token that claims a workspace we serve and does not verify is a refusal, whatever it claims", async () => {
  const now = 1_800_000_000_000;
  // The right workspace name, signed with the wrong key. This is what a stolen or a home-made token
  // looks like, and the only thing that catches it is that the relay checks the signature itself.
  const forged = tokenFor(TENANT, OTHER_KEY, { now });
  const cp = fakeCp({ status: 200, body: { token: forged } });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "x", keyOf, ...cp, now })).kind, "refused");

  // An expired one, from a control plane whose clock or whose ttl is wrong.
  const stale = tokenFor(TENANT, KEY, { now: now - 3_600_000, ttlMs: 60_000 });
  const staleCp = fakeCp({ status: 200, body: { token: stale } });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "x", keyOf, ...staleCp, now })).kind, "refused");

  // A token naming no workspace at all: hand made, because the minter refuses to write one.
  const nameless = `v1.${base64urlEncode(JSON.stringify({
    sub: "s", email: "e@x.y", tenant: "", host: "h", iat: now, exp: now + 1000, jti: "j",
  }))}.no-signature-needed`;
  const namelessCp = fakeCp({ status: 200, body: { token: nameless } });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "x", keyOf, ...namelessCp, now })).kind, "refused");
});

test("the answers a control plane can give, each in its own words", async () => {
  const wrong = fakeCp({ status: 401, body: { error: "invalid_login" } });
  assert.equal((await accountSignIn({ config, email: "nobody@titanium.bot", password: "no", keyOf, ...wrong })).kind, "refused");

  const locked = fakeCp({ status: 429, body: { error: "locked", retryAfter: 30 } });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "no", keyOf, ...locked })).kind, "busy");

  // The control plane's own sentence for an account whose instance is not registered yet. Passing
  // it through beats telling a customer sign-in is "not answering" when it answered very clearly.
  const orphan = fakeCp({ status: 409, body: { error: "tenant_missing", message: "Your account is set up but its instance is not registered yet. Please contact support." } });
  const said = await accountSignIn({ config, email: "demo@titanium.bot", password: "yes", keyOf, ...orphan });
  assert.equal(said.kind, "message");
  assert.match(said.text, /not registered yet/);

  const down = { fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } };
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "yes", keyOf, ...down })).kind, "unreachable");

  const nonsense = fakeCp({ status: 200, body: { nothing: true } });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "yes", keyOf, ...nonsense })).kind, "unreachable");

  const html = fakeCp({ status: 502 });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "yes", keyOf, ...html })).kind, "unreachable");

  // No control plane behind this console at all: the account door is not a door, and the instance
  // password is the only sign-in. Same as it was before any of this.
  assert.equal((await accountSignIn({ config: null, email: "a@b.c", password: "x", keyOf })).kind, "unreachable");
});

test("a sign-in link is verified with the claimed workspace's own key", () => {
  const now = 1_800_000_000_000;
  assert.equal(ssoVerdict({ token: tokenFor(TENANT, KEY, { now }), keyOf, now: now + 1 }).kind, "session");
  // A workspace this console does not serve: a sentence, not a refusal and not a redirect.
  assert.equal(ssoVerdict({ token: tokenFor(OTHER, OTHER_KEY, { now }), keyOf, now }).kind, "unknown");
  // Claiming a workspace we serve but signed with another key: the point of deriving a key per
  // workspace rather than handing everybody the master.
  assert.equal(ssoVerdict({ token: tokenFor(TENANT, OTHER_KEY, { now }), keyOf, now }).kind, "bad");
  // Expired, empty, and edited.
  assert.equal(ssoVerdict({ token: tokenFor(TENANT, KEY, { now: now - 7_200_000, ttlMs: 1000 }), keyOf, now }).kind, "bad");
  assert.equal(ssoVerdict({ token: "", keyOf, now }).kind, "bad");
  const edited = tokenFor(TENANT, KEY, { now }).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal(ssoVerdict({ token: edited, keyOf, now }).kind, "bad");
  // And with no lookup at all, nothing verifies: a console with an empty registry lets nobody in
  // through this door rather than everybody.
  assert.equal(ssoVerdict({ token: tokenFor(TENANT, KEY, { now }), now }).kind, "unknown");
});

// ---- the relay itself, against a control plane on a real port ----------------------------------

// A control plane that answers /v1/sessions and /v1/relay/tenants the way the real one does, and
// records what it saw. The registry route is the new half: it is the only place a gateway token or
// a derived session key is ever handed out, and it is opened by the relay credential and by nothing
// else.
function startFakeControlPlane({ accounts, tenants = [], relayToken = RELAY_TOKEN }) {
  const seen = [];
  const registryCalls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/relay/tenants") {
        const header = String(req.headers.authorization ?? "");
        registryCalls.push({ authorization: header });
        if (header !== `Bearer ${relayToken}`) {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "unauthorized" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ tenants, skipped: [] }));
      }
      if (req.method !== "POST" || req.url !== "/v1/sessions") {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "not_found" }));
      }
      let fields = {};
      try { fields = JSON.parse(body); } catch {}
      seen.push({ email: fields.email, hadPassword: typeof fields.password === "string" });
      const account = accounts[String(fields.email ?? "").toLowerCase()];
      if (account == null || account.password !== fields.password) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_login" }));
      }
      const now = Date.now();
      const token = tokenFor(account.tenant, account.secret, { host: "console.titanium.bot", now });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        token, expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
        account: { id: "acct_1", email: fields.email, name: "Demo" },
        tenant: { slug: account.tenant, host: "console.titanium.bot", status: "running" },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      seen,
      registryCalls,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

test("without a control plane the login page is exactly what it was", async () => {
  const relay = await startRelay();
  try {
    const page = await (await fetch(`${relay.base}/login`, { headers: { accept: "text/html" } })).text();
    assert.equal(page.includes('name="email"'), false, "no email field on a console with no control plane");
    assert.match(page, /This console drives the box/);
    assert.equal(page.includes("Titanium Bot account"), false);
    assert.match(relay.boot, /tnnt one workspace/);
    // One workspace, the operator's, seeded from this process's own environment. That is the whole
    // compatibility story: a developer Mac and a single-box install behave as they always did.
    assert.match(relay.boot, /work 1: titanium/);

    // And a sso link is not a route here at all: it is just the login page.
    const sso = await fetch(`${relay.base}/login?sso=anything`, { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(sso.status, 200);
    assert.equal(cookieOf(sso), "");
  } finally { relay.stop(); }
});

test("one console signs an account in, says so about a workspace it does not serve, and keeps its password", async () => {
  const demo = tenantRow(TENANT);
  const cp = await startFakeControlPlane({
    accounts: {
      "demo@titanium.bot": { password: "the demo account password", tenant: TENANT, secret: KEY },
      "someone@acme.example": { password: "the acme account password", tenant: OTHER, secret: OTHER_KEY },
    },
    tenants: [demo.row],
  });
  const relay = await startRelay({ CP_URL: cp.url, CP_RELAY_TOKEN: RELAY_TOKEN }, { pathValue: "/nonexistent" });
  try {
    assert.match(relay.boot, /tnnt accounts sign in through/);
    // The registry came off the control plane over the relay credential, and it holds the customer
    // beside the operator.
    assert.match(relay.boot, /work 2: /);
    assert.match(relay.boot, /titanium/);
    assert.match(relay.boot, new RegExp(TENANT));
    assert.ok(cp.registryCalls.length > 0, "the relay read the registry route on its way up");
    assert.equal(cp.registryCalls[0].authorization, `Bearer ${RELAY_TOKEN}`);

    // 1. The page offers both doors, in one form with one button.
    const page = await (await fetch(`${relay.base}/login`, { headers: { accept: "text/html" } })).text();
    assert.match(page, /Sign in with your Titanium Bot account/);
    assert.match(page, /id="email" name="email" type="email"/);
    assert.match(page, /or the instance password/);
    assert.equal(page.match(/<form/g).length, 1);
    assert.equal(page.match(/<button/g).length, 1);

    // 2. A wrong password for a real address: one plain sentence, and no cookie.
    const wrong = await fetch(`${relay.base}/login`, form({ email: "demo@titanium.bot", password: "not it" }));
    assert.equal(wrong.status, 401);
    assert.equal(cookieOf(wrong), "");
    assert.match(await wrong.text(), /That email or password is not right\./);

    // 3. The right password: a session cookie, and it opens the console on its own.
    const right = await fetch(`${relay.base}/login`, form({ email: "demo@titanium.bot", password: "the demo account password" }));
    assert.equal(right.status, 302);
    assert.equal(right.headers.get("location"), "/");
    const cookie = cookieOf(right);
    assert.ok(cookie.length > 0, "the account sign-in mints the relay's own session cookie");
    const page2 = await fetch(`${relay.base}/login`, { redirect: "manual", headers: { accept: "text/html", cookie } });
    assert.equal(page2.status, 200, "the login page is still reachable while signed in");
    const api = await fetch(`${relay.base}/api/getHostStatus`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}",
    });
    assert.notEqual(api.status, 401, "the cookie gets past the door; the gateway behind it is a dead port");
    assert.equal(api.headers.get("x-relay-auth"), null);

    // 3b. And log out still ends it. The account session is the relay's own cookie, so the one
    //     control that clears it did not have to learn anything about accounts.
    const out = await fetch(`${relay.base}/logout`, { method: "POST", redirect: "manual", headers: { cookie } });
    assert.equal(out.status, 200);
    assert.match(String(out.headers.get("set-cookie")), /gb_session=;.*Max-Age=0/);

    // 4. A customer whose workspace this console does not serve. Their password was right, so this
    //    is not a refusal; it is the sentence, and no session is minted.
    const elsewhere = await fetch(`${relay.base}/login`, form({ email: "someone@acme.example", password: "the acme account password" }));
    assert.equal(elsewhere.status, 503);
    assert.equal(cookieOf(elsewhere), "", "no session is minted for a workspace this console does not serve");
    assert.match(await elsewhere.text(), /That workspace is not available right now\./);

    // 5. The instance password still signs in, with the email left empty. This is the door Jason
    //    already has and the one the "not answering" sentence points at.
    const byPassword = await fetch(`${relay.base}/login`, form({ email: "", password: RELAY_PASSWORD }));
    assert.equal(byPassword.status, 302);
    assert.ok(cookieOf(byPassword).length > 0);

    // The control plane was asked about the two accounts and never about the instance password.
    assert.deepEqual(cp.seen.map((row) => row.email), ["demo@titanium.bot", "demo@titanium.bot", "someone@acme.example"]);
    assert.ok(cp.seen.every((row) => row.hadPassword));
  } finally { relay.stop(); await cp.stop(); }
});

// ---- SIGNIN-2: the operator's own workspace, with and without a derived key --------------------

test("an account on the operator's own workspace signs in once the control plane's key has been merged", async () => {
  // SIGNIN-2, MEASURED ON THE R750 2026-09-10: a correct password on an account on tenant `titanium`
  // read 503 "That workspace is not available right now." while the byte-identical account on `demo`
  // was signed in at once. The whole difference was one field. The relay seeds the operator's entry
  // from its own environment and can derive nothing from it, so the control plane puts that slug's
  // derived key on the registry row and the refresh merges it -- and the row here is the real live
  // shape, slug and key and nothing else: no box, no token, no directories.
  const OPERATOR_KEY = keyFor(OPERATOR_SLUG);
  const cp = await startFakeControlPlane({
    accounts: { "jason@titaniumcomputing.com": { password: "the operator account password", tenant: OPERATOR_SLUG, secret: OPERATOR_KEY } },
  });
  const relay = await startRelay({
    CP_URL: cp.url, CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: tenantsFile([{ slug: OPERATOR_SLUG, sessionKey: OPERATOR_KEY }]),
  }, { pathValue: "/nonexistent" });
  try {
    // One workspace, the operator's own, and the key arriving did not turn it into two.
    assert.match(relay.boot, /work 1: titanium/, relay.boot);

    // 1. The account door. A 302 with a cookie is the whole of SIGNIN-2: the control plane signed
    //    with the key it derived and the relay verified with the key it was handed, which is two
    //    derivations in two processes where only one of them holds the master.
    const inByAccount = await fetch(`${relay.base}/login`,
      form({ email: "jason@titaniumcomputing.com", password: "the operator account password" }));
    assert.equal(inByAccount.status, 302, `the operator's own account could not sign in: ${(await inByAccount.text()).slice(0, 200)}`);
    assert.equal(inByAccount.headers.get("location"), "/");
    const cookie = cookieOf(inByAccount);
    assert.ok(cookie.length > 0, "no session was minted for the operator's own workspace");
    // And it lands on the operator's workspace, not on a stranger's: the dead gateway in this
    // relay's own environment is what answers behind the cookie.
    const api = await fetch(`${relay.base}/api/getHostStatus`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}",
    });
    assert.notEqual(api.status, 401, "the cookie did not get past the door");
    assert.notEqual(api.status, 503, "the session resolved to a workspace this console cannot serve");

    // 2. The other door onto the same key: a sign-in link for that slug.
    const sso = await fetch(`${relay.base}/login?sso=${encodeURIComponent(tokenFor(OPERATOR_SLUG, OPERATOR_KEY))}`,
      { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(sso.status, 302, `a sign-in link for the operator's workspace answered ${sso.status}`);
    assert.ok(cookieOf(sso).length > 0);

    // 3. The instance password is untouched by any of it. It is still the door that needs no
    //    control plane, and it still means this same workspace.
    const byPassword = await fetch(`${relay.base}/login`, form({ email: "", password: RELAY_PASSWORD }));
    assert.equal(byPassword.status, 302);
    assert.ok(cookieOf(byPassword).length > 0);
  } finally { relay.stop(); await cp.stop(); }
});

test("with no key on the operator's row an account there is answered in words, and the instance password still works", async () => {
  // The state every console is in before this wave ships, and the state one is in for the minute
  // between a relay restart and a control plane that has not caught up: the row carries no key. The
  // account door has to say the sentence rather than 500, and the password door has to keep working,
  // which is rule 3 of ui/tenant-login.mjs.
  const cp = await startFakeControlPlane({
    accounts: { "jason@titaniumcomputing.com": { password: "the operator account password", tenant: OPERATOR_SLUG, secret: keyFor(OPERATOR_SLUG) } },
  });
  const relay = await startRelay({
    CP_URL: cp.url, CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: tenantsFile([{ slug: OPERATOR_SLUG }]),
  }, { pathValue: "/nonexistent" });
  try {
    const noKey = await fetch(`${relay.base}/login`,
      form({ email: "jason@titaniumcomputing.com", password: "the operator account password" }));
    assert.equal(noKey.status, 503, `status ${noKey.status}`);
    assert.equal(cookieOf(noKey), "", "a session was minted for a workspace the relay cannot verify");
    assert.match(await noKey.text(), /That workspace is not available right now\./);

    // The same answer at the sign-in link, for the same reason.
    const sso = await fetch(`${relay.base}/login?sso=${encodeURIComponent(tokenFor(OPERATOR_SLUG, keyFor(OPERATOR_SLUG)))}`,
      { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(sso.status, 503);
    assert.equal(cookieOf(sso), "");

    // And the door that needs nothing from the control plane at all is open, which is the whole
    // reason a missing key is a sentence and not an outage.
    const byPassword = await fetch(`${relay.base}/login`, form({ email: "", password: RELAY_PASSWORD }));
    assert.equal(byPassword.status, 302, "the instance password stopped working when the key was missing");
    assert.ok(cookieOf(byPassword).length > 0);
  } finally { relay.stop(); await cp.stop(); }
});

test("a control plane that cannot be reached at all leaves the operator's password door open", async () => {
  // Port 1 on loopback: refused rather than hung, so this measures the doors and not a timeout. No
  // row arrives, so the seed keeps whatever key it had -- which at boot is none -- and the password
  // is what the operator has. A control plane being DOWN must never read as a console being down.
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1", CP_RELAY_TOKEN: RELAY_TOKEN,
  }, { pathValue: "/nonexistent" });
  try {
    const byPassword = await fetch(`${relay.base}/login`, form({ email: "", password: RELAY_PASSWORD }));
    assert.equal(byPassword.status, 302);
    const cookie = cookieOf(byPassword);
    assert.ok(cookie.length > 0);
    const api = await fetch(`${relay.base}/api/getHostStatus`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}",
    });
    assert.notEqual(api.status, 401, "the operator's own cookie did not get past the door");
    assert.notEqual(api.status, 503, "a control plane outage turned the operator's own workspace off");
  } finally { relay.stop(); }
});

test("a sign-in link mints a session, and a forged one does not", async () => {
  const demo = tenantRow(TENANT);
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1", CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: tenantsFile([demo.row]),
  }, { pathValue: "/nonexistent" });
  try {
    const good = tokenFor(TENANT, KEY);
    const arrived = await fetch(`${relay.base}/login?sso=${encodeURIComponent(good)}`, { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(arrived.status, 302);
    assert.equal(arrived.headers.get("location"), "/");
    const cookie = cookieOf(arrived);
    assert.ok(cookie.length > 0);
    // Twelve hours at the outside, and no longer than the token itself, whichever is smaller. This
    // token has an hour on it.
    const maxAge = Number(/Max-Age=(\d+)/.exec(arrived.headers.get("set-cookie") ?? "")?.[1]);
    assert.ok(maxAge > 0 && maxAge <= 3600, `the cookie outlives the token: Max-Age=${maxAge}`);

    const api = await fetch(`${relay.base}/api/getHostStatus`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}",
    });
    assert.notEqual(api.status, 401);

    // Forged: a workspace we serve, somebody else's key. And a token with the payload edited under
    // a signature that was valid for the original.
    for (const bad of [tokenFor(TENANT, OTHER_KEY), `${good}x`, "v1.not.a.token", ""]) {
      const refused = await fetch(`${relay.base}/login?sso=${encodeURIComponent(bad)}`, { redirect: "manual", headers: { accept: "text/html" } });
      assert.equal(refused.status, 401, `a forged link answered ${refused.status}`);
      assert.equal(cookieOf(refused), "");
      assert.match(await refused.text(), /That sign-in link is not valid here\./);
    }

    // A valid link for a workspace this console does not serve is the sentence, not the refusal.
    const away = await fetch(`${relay.base}/login?sso=${encodeURIComponent(tokenFor(OTHER, OTHER_KEY))}`,
      { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(away.status, 503);
    assert.equal(cookieOf(away), "");
    assert.match(await away.text(), /That workspace is not available right now\./);
  } finally { relay.stop(); }
});

test("a control plane that is not answering says so, and does not take the password door away", async () => {
  // Port 1 on loopback: nothing listens, and the connection is refused rather than hanging, so this
  // measures the sentence and not the timeout.
  const demo = tenantRow(TENANT);
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1", CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: tenantsFile([demo.row]),
  }, { pathValue: "/nonexistent" });
  try {
    const down = await fetch(`${relay.base}/login`, form({ email: "demo@titanium.bot", password: "whatever" }));
    assert.equal(down.status, 503);
    assert.equal(cookieOf(down), "");
    const page = await down.text();
    assert.match(page, /Titanium Bot sign-in is not answering right now\. The instance password still works\./);
    // The page it says that on is still a page you can sign in from.
    assert.match(page, /or the instance password/);

    // And it is not counted as a failed attempt. Six of them in a row would otherwise lock the
    // address out (five failures, then thirty seconds), which would take away the very door the
    // sentence above is pointing at.
    for (let i = 0; i < 6; i += 1) {
      await fetch(`${relay.base}/login`, form({ email: "demo@titanium.bot", password: "whatever" }));
    }
    const byPassword = await fetch(`${relay.base}/login`, form({ email: "", password: RELAY_PASSWORD }));
    assert.equal(byPassword.status, 302, "the instance password still works after the control plane failed seven times");
    assert.ok(cookieOf(byPassword).length > 0);

    // The workspaces read before it went down are still served, which is the point of keeping the
    // last good answer: a control plane outage must not sign a customer out.
    const sso = await fetch(`${relay.base}/login?sso=${encodeURIComponent(tokenFor(TENANT, KEY))}`,
      { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(sso.status, 302);
    assert.ok(cookieOf(sso).length > 0);
  } finally { relay.stop(); }
});

test("a wrong account password counts toward the lockout the way a wrong instance password does", async () => {
  const demo = tenantRow(TENANT);
  const cp = await startFakeControlPlane({
    accounts: { "demo@titanium.bot": { password: "the demo account password", tenant: TENANT, secret: KEY } },
    tenants: [demo.row],
  });
  const relay = await startRelay({ CP_URL: cp.url, CP_RELAY_TOKEN: RELAY_TOKEN }, { pathValue: "/nonexistent" });
  try {
    for (let i = 0; i < 5; i += 1) {
      const attempt = await fetch(`${relay.base}/login`, form({ email: "demo@titanium.bot", password: `guess ${i}` }));
      assert.equal(attempt.status, 401, `attempt ${i} answered ${attempt.status}`);
    }
    // The sixth is refused before the body is read, by the same lockout the password door uses, and
    // it locks the instance password out too: five wrong guesses is five wrong guesses.
    const locked = await fetch(`${relay.base}/login`, form({ email: "demo@titanium.bot", password: "guess 5" }));
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
    const alsoLocked = await fetch(`${relay.base}/login`, form({ email: "", password: RELAY_PASSWORD }));
    assert.equal(alsoLocked.status, 429);
  } finally { relay.stop(); await cp.stop(); }
});

test("a sign-in for a workspace this console does not serve does not reset the lockout", async () => {
  // The hole this measures: the branch for a credential that belongs somewhere else used to call
  // recordSuccess, which deletes the failure count for the address. Anyone holding an account the
  // control plane knows could therefore guess this console's instance password four at a time, sign
  // in with their own account to wipe the counter, and go again. Eight consecutive wrong passwords
  // with no lockout was measured against a live console before the fix.
  const demo = tenantRow(TENANT);
  const cp = await startFakeControlPlane({
    accounts: {
      "demo@titanium.bot": { password: "the demo account password", tenant: TENANT, secret: KEY },
      "someone@acme.example": { password: "the acme account password", tenant: OTHER, secret: OTHER_KEY },
    },
    tenants: [demo.row],
  });
  const relay = await startRelay({ CP_URL: cp.url, CP_RELAY_TOKEN: RELAY_TOKEN }, { pathValue: "/nonexistent" });
  try {
    // Four wrong instance passwords: one short of the five that lock the address.
    for (let i = 0; i < 4; i += 1) {
      const attempt = await fetch(`${relay.base}/login`, form({ email: "", password: `guess ${i}` }));
      assert.equal(attempt.status, 401, `attempt ${i} answered ${attempt.status}`);
    }

    // A real sign-in, for a real account, on a workspace this console does not serve. It is the
    // sentence and it is correct; what it must not be is a reset.
    const away = await fetch(`${relay.base}/login`, form({ email: "someone@acme.example", password: "the acme account password" }));
    assert.equal(away.status, 503);
    assert.equal(cookieOf(away), "");

    // The fifth wrong password is still the fifth, so it trips the lockout, and the sixth is
    // refused before the password is looked at.
    const fifth = await fetch(`${relay.base}/login`, form({ email: "", password: "guess 4" }));
    assert.equal(fifth.status, 401);
    const sixth = await fetch(`${relay.base}/login`, form({ email: "", password: "guess 5" }));
    assert.equal(sixth.status, 429, "an unknown-workspace sign-in cleared the lockout");
    assert.ok(Number(sixth.headers.get("retry-after")) > 0);

    // And it is still refused while the address is locked, so the reset button cannot be pressed
    // from the far side of the lockout either.
    const lockedAway = await fetch(`${relay.base}/login`, form({ email: "someone@acme.example", password: "the acme account password" }));
    assert.equal(lockedAway.status, 429);
  } finally { relay.stop(); await cp.stop(); }
});

test("a sign-in on a workspace this console serves still clears the lockout", async () => {
  const demo = tenantRow(TENANT);
  const cp = await startFakeControlPlane({
    accounts: { "demo@titanium.bot": { password: "the demo account password", tenant: TENANT, secret: KEY } },
    tenants: [demo.row],
  });
  const relay = await startRelay({ CP_URL: cp.url, CP_RELAY_TOKEN: RELAY_TOKEN }, { pathValue: "/nonexistent" });
  try {
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await fetch(`${relay.base}/login`, form({ email: "", password: `guess ${i}` }))).status, 401);
    }
    const inHere = await fetch(`${relay.base}/login`, form({ email: "demo@titanium.bot", password: "the demo account password" }));
    assert.equal(inHere.status, 302);
    assert.ok(cookieOf(inHere).length > 0);
    // Four more wrong ones after it, all answered rather than locked: the counter really did reset.
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await fetch(`${relay.base}/login`, form({ email: "", password: `again ${i}` }))).status, 401,
        "a sign-in on a workspace this console serves is a success here and resets the counter");
    }
  } finally { relay.stop(); await cp.stop(); }
});

test("the registry route is opened by the relay credential and by nothing else", async () => {
  // The route deliberately returns per-workspace gateway tokens and derived session keys, which is
  // the one amendment TENANT-5 makes to the control plane's "this service never returns a key"
  // rule. That makes the credential on it the whole of the fleet's security, so the relay must
  // never present anything else and the route must never answer anything else.
  const demo = tenantRow(TENANT);
  const cp = await startFakeControlPlane({ accounts: {}, tenants: [demo.row] });

  const wrong = await fetch(`${cp.url}/v1/relay/tenants`);
  assert.equal(wrong.status, 401, "no bearer must not read the fleet's tokens");
  const guessed = await fetch(`${cp.url}/v1/relay/tenants`, { headers: { authorization: "Bearer an admin token" } });
  assert.equal(guessed.status, 401, "a different credential must not read the fleet's tokens");
  const right = await fetch(`${cp.url}/v1/relay/tenants`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } });
  assert.equal(right.status, 200);
  const body = await right.json();
  assert.equal(body.tenants[0].slug, TENANT);
  // The derived key is per workspace and the master never leaves the control plane, which is the
  // property that makes handing a key out at all acceptable.
  assert.equal(body.tenants[0].sessionKey, KEY);
  assert.equal(JSON.stringify(body).includes(MASTER), false, "the master key must appear nowhere in the answer");

  // The three probes above are in the record too, so only what the relay itself sent is measured.
  const before = cp.registryCalls.length;
  const relay = await startRelay({ CP_URL: cp.url, CP_RELAY_TOKEN: RELAY_TOKEN }, { pathValue: "/nonexistent" });
  try {
    // Every call the relay made carried the relay credential and nothing else.
    const mine = cp.registryCalls.slice(before);
    assert.ok(mine.length > 0, "the relay read the registry route on its way up");
    for (const call of mine) assert.equal(call.authorization, `Bearer ${RELAY_TOKEN}`);
  } finally { relay.stop(); await cp.stop(); }
});

test("a relay with the wrong relay credential serves the operator and nobody else", async () => {
  // A control plane that refuses this relay is the same fact as a control plane that is down: the
  // last good answer is kept, and at boot the last good answer is the operator alone. What must not
  // happen is a console that will not come up, or one that lets a customer in on no evidence.
  const demo = tenantRow(TENANT);
  const cp = await startFakeControlPlane({ accounts: {}, tenants: [demo.row], relayToken: "the real one" });
  const relay = await startRelay({ CP_URL: cp.url, CP_RELAY_TOKEN: RELAY_TOKEN }, { pathValue: "/nonexistent" });
  try {
    assert.match(relay.boot, /work 1: titanium/);
    assert.match(relay.boot, /reg  could not reach the control plane \(HTTP 401\)/);
    const away = await fetch(`${relay.base}/login?sso=${encodeURIComponent(tokenFor(TENANT, KEY))}`,
      { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(away.status, 503);
    assert.equal(cookieOf(away), "");
    // And the operator's own door is untouched, which is the whole reason the last good answer is
    // kept rather than the console refusing to start.
    const byPassword = await fetch(`${relay.base}/login`, form({ email: "", password: RELAY_PASSWORD }));
    assert.equal(byPassword.status, 302);
    assert.ok(cookieOf(byPassword).length > 0);
  } finally { relay.stop(); await cp.stop(); }
});

/**
 * CP-FIX 2. A login by sign-in link is written into the relay's own ledger.
 *
 * MEASURED ON THE R750 2026-09-12 for beta-36: the tester came in by link at 13:52 and the Clients
 * panel said he had never logged in for the next 38 minutes, while his box spent 9.7M input tokens.
 * The link door wrote a console log line and nothing else, and the control plane cannot hear about
 * it any other way: no password is typed, so POST /v1/sessions is never called.
 */
test("a login by sign-in link lands in the login ledger, and a bad link lands as a refusal", async () => {
  const demo = tenantRow(TENANT);
  // No SAND_UI_STATE_DIR on purpose: with none the ledger lands beside the code, which for a test is
  // the relay's own copy directory, and the auth.json serverCopy wrote stays the one the door reads.
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1", CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: tenantsFile([demo.row]),
  }, { pathValue: "/nonexistent" });
  try {
    const arrived = await fetch(`${relay.base}/login?sso=${encodeURIComponent(tokenFor(TENANT, KEY))}`,
      { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(arrived.status, 302, "the link itself still works");
    const refused = await fetch(`${relay.base}/login?sso=not-a-token`,
      { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(refused.status, 401);

    // The write is never awaited by the route, so the rows are read once they are there rather than
    // immediately. The ledger is a record of the door and must never hold a sign-in open.
    const file = path.join(relay.dir, "login-attempts.jsonl");
    let rows = [];
    for (let attempt = 0; attempt < 50 && rows.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        rows = readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
      } catch { rows = []; }
    }
    assert.equal(rows.length, 2, `the ledger has ${rows.length} rows, not two`);
    const [ok, bad] = rows;
    assert.equal(ok.door, "link", "a third door, named, so the control plane can count it as a login");
    assert.equal(ok.outcome, "ok");
    assert.equal(ok.tenant, TENANT, "the workspace comes off the verified token");
    assert.equal(ok.email, `${TENANT}@titanium.bot`, "and so does the person, which is what the Clients panel joins on");
    assert.equal(ok.triedHash, "", "no password was typed, so there is nothing derived from one");
    assert.equal(bad.door, "link");
    assert.equal(bad.outcome, "refused");
    assert.equal(bad.triedHash, "", "a forged link carries no password either");
  } finally { relay.stop(); }
});

// mintSessionToken is imported for the hand-made token above; naming it here keeps the linter and
// the reader agreed that it is used on purpose.
assert.equal(typeof mintSessionToken, "function");
