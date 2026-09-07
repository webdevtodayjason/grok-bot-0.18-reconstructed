// TENANT-2, item 3. Signing in to a tenant relay with a Titanium Bot account.
//
// The relay has always had one door: an instance password read once at boot. A customer needs a
// second one, their own account, and the thing that makes it safe is that the relay verifies the
// control plane's token itself, with a key that is only ever this tenant's, and checks the tenant
// claim before it mints anything.
//
// Four failures are worth naming, because each of them looks like working software:
//   - a token for another customer, validly signed by the same control plane, accepted here;
//   - a forged sign-in link accepted because the query string was believed;
//   - the instance password stopping working the day the account door was added;
//   - the control plane being down turning into a locked-out operator instead of a sentence.
// There is a test below for each.
//
// The control plane in these tests is a real http server in this process, so the relay makes a real
// fetch to a real port and the mint and verify are the shipping code. Nothing is stubbed except the
// control plane's own decisions, which is exactly the part a relay is not allowed to trust.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { base64urlEncode, mintSessionToken, tenantSessionSecret } from "../ui/session-token.mjs";
import { accountSignIn, hostOfUnverifiedToken, ssoVerdict, tenantConfig, CP_TIMEOUT_MS } from "../ui/tenant-login.mjs";
import { newAuthRecord, writeAuthFile } from "../ui/auth.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MASTER = "a control plane master key no tenant ever holds";
const TENANT = "demo";
const OTHER = "acme";
const RELAY_PASSWORD = "an instance password no test types";
const KEY = tenantSessionSecret(MASTER, TENANT);
const OTHER_KEY = tenantSessionSecret(MASTER, OTHER);

function tokenFor(tenant, secret, { host = `${tenant}.titanium.bot`, ttlMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  return mintSessionToken({
    sub: "acct_demo", email: `demo@titanium.bot`, tenant, host,
    iat: now, exp: now + ttlMs, jti: `${tenant}-${now}`,
  }, secret, now).token;
}

// ---- the module, with the control plane faked at the fetch ------------------------------------

test("tenant mode needs all three variables, and treats two of three as none", () => {
  const full = { TENANT_ID: "demo", CP_URL: "https://api.titanium.bot/", CP_SESSION_SECRET: KEY };
  assert.deepEqual(tenantConfig(full), { tenant: "demo", cpUrl: "https://api.titanium.bot", secret: KEY });
  for (const missing of ["TENANT_ID", "CP_URL", "CP_SESSION_SECRET"]) {
    assert.equal(tenantConfig({ ...full, [missing]: "" }), null, `${missing} empty must mean no tenant mode`);
    assert.equal(tenantConfig({ ...full, [missing]: "   " }), null);
    const without = { ...full };
    delete without[missing];
    assert.equal(tenantConfig(without), null);
  }
  assert.equal(tenantConfig({}), null);
});

const config = { tenant: TENANT, cpUrl: "https://api.titanium.bot", secret: KEY };

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

test("a right password for this tenant comes back as a verified session", async () => {
  const now = 1_800_000_000_000;
  const token = tokenFor(TENANT, KEY, { now });
  const cp = fakeCp({ status: 200, body: { token, expiresAt: new Date(now + 3_600_000).toISOString() } });
  const verdict = await accountSignIn({ config, email: "demo@titanium.bot", password: "hunter2hunter2", ...cp, now: now + 1000 });
  assert.equal(verdict.kind, "session");
  assert.equal(verdict.payload.tenant, TENANT);

  // The call itself: the right route, a POST, and the password in the body and nowhere else.
  assert.equal(cp.calls.length, 1);
  assert.equal(cp.calls[0].url, "https://api.titanium.bot/v1/sessions");
  assert.equal(cp.calls[0].init.method, "POST");
  assert.equal(cp.calls[0].init.url, undefined);
  assert.deepEqual(JSON.parse(cp.calls[0].init.body), { email: "demo@titanium.bot", password: "hunter2hunter2" });
  assert.ok(cp.calls[0].init.signal, `the call carries a timeout (${CP_TIMEOUT_MS} ms)`);
});

test("a token this control plane signed for ANOTHER customer is not a session here", async () => {
  const now = 1_800_000_000_000;
  const token = tokenFor(OTHER, OTHER_KEY, { now });
  const cp = fakeCp({ status: 200, body: { token } });
  const verdict = await accountSignIn({ config, email: "somebody@acme.example", password: "their password", ...cp, now });
  // Not refused and not accepted: sent to their own front door with the token the control plane
  // just minted for them, which only their relay's key can verify.
  assert.equal(verdict.kind, "elsewhere");
  assert.equal(verdict.host, "acme.titanium.bot");
  assert.equal(verdict.location, `https://acme.titanium.bot/login?sso=${encodeURIComponent(token)}`);
});

test("a token that claims to be ours and does not verify is a refusal, whatever it claims", async () => {
  const now = 1_800_000_000_000;
  // The right tenant name, signed with the wrong key. This is what a stolen or a home-made token
  // looks like, and the only thing that catches it is that the relay checks the signature itself.
  const forged = tokenFor(TENANT, OTHER_KEY, { now });
  const cp = fakeCp({ status: 200, body: { token: forged } });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "x", ...cp, now })).kind, "refused");

  // An expired one, from a control plane whose clock or whose ttl is wrong.
  const stale = tokenFor(TENANT, KEY, { now: now - 3_600_000, ttlMs: 60_000 });
  const staleCp = fakeCp({ status: 200, body: { token: stale } });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "x", ...staleCp, now })).kind, "refused");
});

test("the four answers a control plane can give, each in its own words", async () => {
  const wrong = fakeCp({ status: 401, body: { error: "invalid_login" } });
  assert.equal((await accountSignIn({ config, email: "nobody@titanium.bot", password: "no", ...wrong })).kind, "refused");

  const locked = fakeCp({ status: 429, body: { error: "locked", retryAfter: 30 } });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "no", ...locked })).kind, "busy");

  // The control plane's own sentence for an account whose instance is not registered yet. Passing
  // it through beats telling a customer sign-in is "not answering" when it answered very clearly.
  const orphan = fakeCp({ status: 409, body: { error: "tenant_missing", message: "Your account is set up but its instance is not registered yet. Please contact support." } });
  const said = await accountSignIn({ config, email: "demo@titanium.bot", password: "yes", ...orphan });
  assert.equal(said.kind, "message");
  assert.match(said.text, /not registered yet/);

  const down = { fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } };
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "yes", ...down })).kind, "unreachable");

  const nonsense = fakeCp({ status: 200, body: { nothing: true } });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "yes", ...nonsense })).kind, "unreachable");

  const html = fakeCp({ status: 502 });
  assert.equal((await accountSignIn({ config, email: "demo@titanium.bot", password: "yes", ...html })).kind, "unreachable");
});

test("a host claim that is not a hostname is never turned into a redirect", () => {
  const now = 1_800_000_000_000;
  // Built by hand rather than minted, because this reads a claim the minter would refuse to write
  // and a signature it would refuse to make. That is the point: the token comes from somewhere
  // else, this relay cannot verify it, and the only thing standing between the claim and a Location
  // header is the check being measured here.
  const handMade = (host) => `v1.${base64urlEncode(JSON.stringify({
    sub: "s", email: "e@x.y", tenant: OTHER, host, iat: now, exp: now + 1000, jti: "j",
  }))}.no-signature-needed`;

  for (const host of [
    "acme.titanium.bot/../evil", "https://evil.example", "acme.titanium.bot:7777",
    "acme.titanium.bot\r\nSet-Cookie: a=b", "localhost", "", "   ", "-acme.titanium.bot", "..",
    "acme.titanium.bot?x=1", "user@acme.titanium.bot", "a".repeat(300),
    "acme .titanium.bot", 7, null,
  ]) {
    assert.equal(hostOfUnverifiedToken(handMade(host)), "",
      `${JSON.stringify(host)} must not be usable as a redirect target`);
  }
  // And the shapes that are real hosts, case folded so the Location header is one thing.
  assert.equal(hostOfUnverifiedToken(handMade("Acme.Titanium.Bot")), "acme.titanium.bot");
  assert.equal(hostOfUnverifiedToken(handMade("a-b.example.co.uk")), "a-b.example.co.uk");
  assert.equal(hostOfUnverifiedToken(tokenFor(OTHER, OTHER_KEY, { host: "acme.titanium.bot", now })), "acme.titanium.bot");
  // Not a token at all.
  for (const junk of ["", "one.two", "a.b.c.d", null]) assert.equal(hostOfUnverifiedToken(junk), "");
});

test("a sign-in link is verified with this relay's own key and its own tenant name", () => {
  const now = 1_800_000_000_000;
  assert.equal(ssoVerdict({ config, token: tokenFor(TENANT, KEY, { now }), now: now + 1 }).kind, "session");
  // Signed with another tenant's key: the signature does not check out here, which is the point of
  // deriving a key per tenant rather than handing everybody the master.
  assert.equal(ssoVerdict({ config, token: tokenFor(OTHER, OTHER_KEY, { now }), now }).kind, "bad");
  // Signed with OUR key but claiming another tenant. Only reachable if the secret was configured
  // wrong; it still fails closed rather than letting any tenant in.
  assert.equal(ssoVerdict({ config, token: tokenFor(OTHER, KEY, { now }), now }).kind, "bad");
  // Expired, empty, and edited.
  assert.equal(ssoVerdict({ config, token: tokenFor(TENANT, KEY, { now: now - 7_200_000, ttlMs: 1000 }), now }).kind, "bad");
  assert.equal(ssoVerdict({ config, token: "", now }).kind, "bad");
  const edited = tokenFor(TENANT, KEY, { now }).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal(ssoVerdict({ config, token: edited, now }).kind, "bad");
  assert.equal(ssoVerdict({ config: null, token: tokenFor(TENANT, KEY, { now }), now }).kind, "bad");
});

// ---- the relay itself, against a control plane on a real port ----------------------------------

// A control plane that answers /v1/sessions the way the real one does, and records what it saw.
function startFakeControlPlane({ accounts }) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
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
      const token = tokenFor(account.tenant, account.secret, { host: account.host, now });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        token, expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
        account: { id: "acct_1", email: fields.email, name: "Demo" },
        tenant: { slug: account.tenant, host: account.host, status: "running" },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      seen,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

// A copy of ui/, never ui/ itself: the operator's own auth.json would change which branch runs.
function serverCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-tenant-"));
  for (const name of readdirSync(path.join(repo, "ui")).filter((file) => file.endsWith(".mjs"))) {
    copyFileSync(path.join(repo, "ui", name), path.join(dir, name));
  }
  return dir;
}

// There is no way to read back the port from a server started with SAND_UI_PORT=0 -- it prints the
// value it was given -- so a port is picked and retried, the same as tests/relay-login-guards.
async function startRelay(env = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dir = serverCopy();
    writeAuthFile(path.join(dir, "auth.json"), newAuthRecord(RELAY_PASSWORD));
    const port = 34000 + Math.floor(Math.random() * 8000);
    const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
      env: {
        ...process.env, SAND_UI_PORT: String(port), SAND_UI_BIND_HOST: "127.0.0.1",
        SAND_HOST_GATEWAY_TOKEN: "not-a-real-token",
        // Nothing answers here. Every request in these tests is decided by the login before the
        // relay reaches upstream, so a 502 from a dead gateway is itself proof of getting past.
        SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1",
        TENANT_ID: "", CP_URL: "", CP_SESSION_SECRET: "", SAND_UI_STATE_DIR: "", SAND_UI_AUTH_FILE: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const listening = await new Promise((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("cfip ")) resolve(out); });
      child.on("exit", () => resolve(null));
      setTimeout(() => resolve(null), 15_000).unref();
    });
    if (listening != null) return { base: `http://127.0.0.1:${port}`, boot: listening, stop: () => child.kill("SIGKILL") };
    child.kill("SIGKILL");
  }
  throw new Error("the relay copy would not start on any of five ports");
}

const cookieOf = (response) => /(?:^|,\s*)(gb_session=[^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "";

const form = (fields) => ({
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
  body: new URLSearchParams(fields).toString(),
});

test("without tenant mode the login page is exactly what it was", async () => {
  const relay = await startRelay();
  try {
    const page = await (await fetch(`${relay.base}/login`, { headers: { accept: "text/html" } })).text();
    assert.equal(page.includes('name="email"'), false, "no email field on an instance that is not a tenant");
    assert.match(page, /This console drives the box/);
    assert.equal(page.includes("Titanium Bot account"), false);
    assert.match(relay.boot, /tnnt not a tenant/);

    // And a sso link is not a route here at all: it is just the login page.
    const sso = await fetch(`${relay.base}/login?sso=anything`, { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(sso.status, 200);
    assert.equal(cookieOf(sso), "");
  } finally { relay.stop(); }
});

test("a tenant relay signs an account in, sends another customer home, and keeps its own password", async () => {
  const cp = await startFakeControlPlane({
    accounts: {
      "demo@titanium.bot": { password: "the demo account password", tenant: TENANT, secret: KEY, host: "demo.titanium.bot" },
      "someone@acme.example": { password: "the acme account password", tenant: OTHER, secret: OTHER_KEY, host: "acme.titanium.bot" },
    },
  });
  const relay = await startRelay({ TENANT_ID: TENANT, CP_URL: cp.url, CP_SESSION_SECRET: KEY });
  try {
    assert.match(relay.boot, new RegExp(`tnnt ${TENANT}, accounts sign in through`));

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

    // 3. The right password for this tenant: a session cookie, and it opens the console on its own.
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

    // 4. A customer whose instance is somewhere else: sent to their own host with a sign-in link,
    //    not refused and certainly not signed in here.
    const elsewhere = await fetch(`${relay.base}/login`, form({ email: "someone@acme.example", password: "the acme account password" }));
    assert.equal(elsewhere.status, 302);
    assert.equal(cookieOf(elsewhere), "", "no session is minted for another customer's account");
    const location = new URL(String(elsewhere.headers.get("location")));
    assert.equal(location.origin, "https://acme.titanium.bot");
    assert.equal(location.pathname, "/login");
    const handed = location.searchParams.get("sso");
    assert.ok(handed, "the redirect carries the token, which is the only way a browser carries it across origins");
    // And that token is worthless here, which is what the tenant check is for.
    const replayed = await fetch(`${relay.base}/login?sso=${encodeURIComponent(handed)}`, { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(replayed.status, 401);
    assert.equal(cookieOf(replayed), "");
    assert.match(await replayed.text(), /That sign-in link is not valid here\./);

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

test("a sign-in link mints a session, and a forged one does not", async () => {
  const relay = await startRelay({ TENANT_ID: TENANT, CP_URL: "http://127.0.0.1:1", CP_SESSION_SECRET: KEY });
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

    // Forged: our tenant's name, somebody else's key. And a token with the payload edited under a
    // signature that was valid for the original.
    for (const bad of [tokenFor(TENANT, OTHER_KEY), `${good}x`, "v1.not.a.token", ""]) {
      const refused = await fetch(`${relay.base}/login?sso=${encodeURIComponent(bad)}`, { redirect: "manual", headers: { accept: "text/html" } });
      assert.equal(refused.status, 401, `a forged link answered ${refused.status}`);
      assert.equal(cookieOf(refused), "");
      assert.match(await refused.text(), /That sign-in link is not valid here\./);
    }
  } finally { relay.stop(); }
});

test("a control plane that is not answering says so, and does not take the password door away", async () => {
  // Port 1 on loopback: nothing listens, and the connection is refused rather than hanging, so this
  // measures the sentence and not the timeout.
  const relay = await startRelay({ TENANT_ID: TENANT, CP_URL: "http://127.0.0.1:1", CP_SESSION_SECRET: KEY });
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
  } finally { relay.stop(); }
});

test("a wrong account password counts toward the lockout the way a wrong instance password does", async () => {
  const cp = await startFakeControlPlane({
    accounts: { "demo@titanium.bot": { password: "the demo account password", tenant: TENANT, secret: KEY, host: "demo.titanium.bot" } },
  });
  const relay = await startRelay({ TENANT_ID: TENANT, CP_URL: cp.url, CP_SESSION_SECRET: KEY });
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

test("a sign-in that belongs to another instance does not reset this relay's lockout", async () => {
  // The hole this measures: the `elsewhere` branch used to call recordSuccess, which deletes the
  // failure count for the address. Anyone holding an account on ANY other instance could therefore
  // guess this relay's instance password four at a time, sign in with their own account to wipe the
  // counter, and go again. Eight consecutive wrong passwords with no lockout was measured against a
  // live console before the fix.
  const cp = await startFakeControlPlane({
    accounts: {
      "demo@titanium.bot": { password: "the demo account password", tenant: TENANT, secret: KEY, host: "demo.titanium.bot" },
      "someone@acme.example": { password: "the acme account password", tenant: OTHER, secret: OTHER_KEY, host: "acme.titanium.bot" },
    },
  });
  const relay = await startRelay({ TENANT_ID: TENANT, CP_URL: cp.url, CP_SESSION_SECRET: KEY });
  try {
    // Four wrong instance passwords: one short of the five that lock the address.
    for (let i = 0; i < 4; i += 1) {
      const attempt = await fetch(`${relay.base}/login`, form({ email: "", password: `guess ${i}` }));
      assert.equal(attempt.status, 401, `attempt ${i} answered ${attempt.status}`);
    }

    // A real sign-in, for a real account, on somebody else's instance. It is a redirect and it is
    // correct; what it must not be is a reset.
    const away = await fetch(`${relay.base}/login`, form({ email: "someone@acme.example", password: "the acme account password" }));
    assert.equal(away.status, 302);
    assert.match(String(away.headers.get("location")), /^https:\/\/acme\.titanium\.bot\/login\?sso=/);
    assert.equal(cookieOf(away), "");

    // The fifth wrong password is still the fifth, so it trips the lockout, and the sixth is
    // refused before the password is looked at.
    const fifth = await fetch(`${relay.base}/login`, form({ email: "", password: "guess 4" }));
    assert.equal(fifth.status, 401);
    const sixth = await fetch(`${relay.base}/login`, form({ email: "", password: "guess 5" }));
    assert.equal(sixth.status, 429, "an other-tenant sign-in cleared the lockout");
    assert.ok(Number(sixth.headers.get("retry-after")) > 0);

    // And the redirect itself is still refused while the address is locked, so the reset button
    // cannot be pressed from the far side of the lockout either.
    const lockedAway = await fetch(`${relay.base}/login`, form({ email: "someone@acme.example", password: "the acme account password" }));
    assert.equal(lockedAway.status, 429);
  } finally { relay.stop(); await cp.stop(); }
});

test("a sign-in on THIS instance still clears the lockout, which is the door that proves you belong here", async () => {
  const cp = await startFakeControlPlane({
    accounts: { "demo@titanium.bot": { password: "the demo account password", tenant: TENANT, secret: KEY, host: "demo.titanium.bot" } },
  });
  const relay = await startRelay({ TENANT_ID: TENANT, CP_URL: cp.url, CP_SESSION_SECRET: KEY });
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
        "a sign-in on this instance is a success here and resets the counter");
    }
  } finally { relay.stop(); await cp.stop(); }
});
