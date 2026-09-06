// The relay behind a proxy: whose address the lockout counts, and where the Secure flag and HSTS
// come from.
//
// This is the difference between a console on a tailnet and a console on a domain. Published
// through Coolify's Traefik and Cloudflare, every request arrives from one docker address, so a
// lockout keyed on the socket is a single bucket the whole internet shares: five typos from a
// stranger in another country lock the operator out of his own box. The forwarded headers carry
// the real caller, and they are also trivially forged, so the whole question is which peer is
// allowed to speak for someone else.
//
// The halves are tested from opposite directions. From an untrusted peer a forged header must buy
// NOTHING -- six attempts under six different forged addresses still hit the limiter. From a
// trusted peer the address the proxy observed must be honoured, so one visitor's lockout does not
// touch another's.
//
// And then the case that is easy to get wrong, which has its own test below: CF-Connecting-IP is
// not one of the X-Forwarded-* names Traefik rewrites, so it arrives exactly as its sender wrote
// it. Anyone who reaches the origin address directly -- and the origin behind a Cloudflare-proxied
// name is public -- can therefore write a fresh one per attempt. It is believed only when the
// address the proxy observed is itself inside Cloudflare's published ranges, which is the one path
// on which Cloudflare rather than the caller wrote it.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clientAddress, edgeAddress, isSecureRequest, isTrustedProxy, newAuthRecord, parseAddress,
  parseTrustedProxies, writeAuthFile,
} from "../ui/auth.mjs";

// Cloudflare's published ranges, trimmed to the ones these tests use. The relay reads the same
// shape out of SAND_UI_CLOUDFLARE_RANGES.
const CF = "162.158.0.0/15,104.16.0.0/13,2400:cb00::/32";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- the parser ------------------------------------------------------------------------------

test("an address parses out of every spelling a proxy or a kernel might hand over", () => {
  const bytes = (value) => Array.from(parseAddress(value)?.bytes ?? []);
  assert.deepEqual(bytes("10.0.2.5"), [10, 0, 2, 5]);
  // What a dual stack listener reports for an IPv4 peer. It has to be the same host as above, or a
  // range would match under one spelling and not the other.
  assert.deepEqual(bytes("::ffff:10.0.2.5"), [10, 0, 2, 5]);
  assert.equal(parseAddress("::ffff:10.0.2.5").bits, 32);
  assert.equal(parseAddress("fdb8:a9ef:e4a4::1").bits, 128);
  assert.equal(parseAddress("[::1]").bits, 128);
  // A zone is a local interface name, not part of the host.
  assert.deepEqual(parseAddress("fe80::1%eth0"), parseAddress("fe80::1"));
  for (const bad of ["", "1.2.3", "1.2.3.4.5", "256.0.0.1", "abcd", "2001:db8", "::ffff:999.1.1.1", null]) {
    assert.equal(parseAddress(bad), null, `${bad} parsed as an address`);
  }
});

test("an empty list trusts nothing, and that is the default", () => {
  const none = parseTrustedProxies("");
  assert.equal(none.any, false);
  assert.equal(none.ranges.length, 0);
  assert.equal(isTrustedProxy("10.0.2.5", none), false);
  assert.equal(isTrustedProxy("127.0.0.1", none), false);
  // Not configured at all is the same answer as configured empty.
  assert.equal(isTrustedProxy("10.0.2.5", parseTrustedProxies(undefined)), false);
  assert.equal(isTrustedProxy("10.0.2.5", null), false);
});

test("ranges match by prefix, in both families, and a bare address is its own /32", () => {
  const trusted = parseTrustedProxies("10.0.0.0/8, 172.16.0.0/12 ,fdb8:a9ef:e4a4::/64, 203.0.113.7");
  assert.equal(trusted.ranges.length, 4);
  for (const inside of ["10.0.2.5", "::ffff:10.0.2.5", "10.255.255.255", "172.31.0.1", "fdb8:a9ef:e4a4::9", "203.0.113.7"]) {
    assert.equal(isTrustedProxy(inside, trusted), true, `${inside} should be trusted`);
  }
  for (const outside of ["11.0.0.1", "172.32.0.1", "fdb8:a9ef:e4a5::1", "203.0.113.8", "127.0.0.1", "not-an-address"]) {
    assert.equal(isTrustedProxy(outside, trusted), false, `${outside} should not be trusted`);
  }
  assert.equal(isTrustedProxy("8.8.8.8", parseTrustedProxies("any")), true);
});

test("an entry that is not a range is dropped and reported, never silently widened", () => {
  const trusted = parseTrustedProxies("10.0.0.0/8, junk, 10.0.0.0/33, 1.2.3.4/-1");
  assert.deepEqual(trusted.ignored, ["junk", "10.0.0.0/33", "1.2.3.4/-1"]);
  assert.equal(trusted.ranges.length, 1);
  // The failure direction that matters: a typo leaves the relay trusting LESS, not everything.
  assert.equal(isTrustedProxy("1.2.3.4", trusted), false);
});

test("the forwarded address is the one the proxy wrote, which is the last hop, and only from a trusted peer", () => {
  const trusted = parseTrustedProxies("10.0.2.0/24");
  const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
  // Measured against Traefik v3.6 as Coolify runs it: a caller who sends a whole forged list has
  // it REPLACED by the single address Traefik saw. A proxy that appends instead puts the real
  // address last. Reading the last hop is correct under both, and reading the first is wrong
  // under both.
  assert.equal(edgeAddress(req("10.0.2.3", { "x-forwarded-for": "1.1.1.1, 9.9.9.9, 198.51.100.4" }), trusted), "198.51.100.4");
  assert.equal(edgeAddress(req("10.0.2.3", { "x-forwarded-for": "198.51.100.4" }), trusted), "198.51.100.4");
  // From anyone else the header is not read at all.
  assert.equal(edgeAddress(req("203.0.113.9", { "x-forwarded-for": "1.1.1.1" }), trusted), "203.0.113.9");
  // Garbage, and a value long enough to be an attempt at filling the lockout's map, fall back to
  // the peer rather than becoming a key.
  assert.equal(edgeAddress(req("10.0.2.3", { "x-forwarded-for": "not-an-address" }), trusted), "10.0.2.3");
  assert.equal(edgeAddress(req("10.0.2.3", { "x-forwarded-for": "a".repeat(200) }), trusted), "10.0.2.3");
  // Some proxies write the port. The port is not part of who is calling.
  assert.equal(edgeAddress(req("10.0.2.3", { "x-forwarded-for": "9.9.9.9:5555" }), trusted), "9.9.9.9");
  assert.equal(edgeAddress(req("10.0.2.3", { "x-forwarded-for": "[2001:db8::1]:443" }), trusted), "2001:db8::1");
});

test("CF-Connecting-IP is ignored unless the address the proxy observed is Cloudflare's", () => {
  const trusted = parseTrustedProxies("10.0.2.0/24");
  const cf = parseTrustedProxies(CF);
  const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });

  // The attack the ranges exist to stop. Nothing forces traffic through Cloudflare: the origin
  // address of a proxied name is in certificate transparency and is shared with every other site
  // on the host, so a guesser connects to it directly. Traefik reports his real address, he writes
  // whatever CF-Connecting-IP he likes, and the header must count for nothing -- otherwise he
  // mints himself a fresh five attempts per forged value and is never locked out at all.
  const direct = (forged) => clientAddress(req("10.0.2.3", {
    "x-forwarded-for": "198.51.100.4", "cf-connecting-ip": forged,
  }), trusted, cf);
  assert.equal(direct("1.2.3.4"), "198.51.100.4");
  assert.equal(direct("5.6.7.8"), "198.51.100.4", "a second forged value must land in the same bucket");

  // The path Cloudflare owns. Traefik reports a Cloudflare edge, and on that path Cloudflare
  // overwrote CF-Connecting-IP with the visitor it is actually talking to, so it is worth reading:
  // without it every visitor behind one edge would share a lockout.
  const viaCf = (visitor, edge = "162.158.1.1") => clientAddress(req("10.0.2.3", {
    "x-forwarded-for": edge, "cf-connecting-ip": visitor,
  }), trusted, cf);
  assert.equal(viaCf("198.51.100.7"), "198.51.100.7");
  assert.equal(viaCf("198.51.100.8"), "198.51.100.8");
  assert.equal(viaCf("198.51.100.7", "2400:cb00::5"), "198.51.100.7", "the v6 edges count too");
  // A Cloudflare edge that sends nothing usable is still the client, never a null key.
  assert.equal(viaCf("not-an-address"), "162.158.1.1");

  // No ranges configured, which is the default and the tailnet shape: the header is dead.
  assert.equal(clientAddress(req("10.0.2.3", {
    "x-forwarded-for": "198.51.100.4", "cf-connecting-ip": "1.2.3.4",
  }), trusted, null), "198.51.100.4");
  // And an untrusted peer gets nothing from either header.
  assert.equal(clientAddress(req("203.0.113.9", {
    "x-forwarded-for": "162.158.1.1", "cf-connecting-ip": "1.2.3.4",
  }), trusted, cf), "203.0.113.9");
});

test("a TLS socket is secure whoever the peer is; a forwarded scheme needs a trusted one", () => {
  const trusted = parseTrustedProxies("10.0.2.0/24");
  assert.equal(isSecureRequest({ socket: { encrypted: true, remoteAddress: "203.0.113.9" }, headers: {} }, trusted), true);
  assert.equal(isSecureRequest({ socket: { remoteAddress: "10.0.2.3" }, headers: { "x-forwarded-proto": "https" } }, trusted), true);
  assert.equal(isSecureRequest({ socket: { remoteAddress: "203.0.113.9" }, headers: { "x-forwarded-proto": "https" } }, trusted), false);
});

// ---- the same rules through a running relay ---------------------------------------------------

// A copy of the server, never ui/ itself: the operator's own ui/auth.json would decide which
// branch runs, and a test that quietly stops testing anything is worse than no test.
const PASSWORD = "a password these tests wrote themselves";

// `pages` copies the two HTML surfaces as well. It is off by default because ui/machine-room is
// 2.3 MB and most of the tests here never ask for a page at all; only the http-only-asset test
// below needs them.
async function startRelay(env, { pages = false } = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dir = mkdtempSync(path.join(tmpdir(), "relay-proxy-"));
    for (const name of ["server.mjs", "auth.mjs", "subscriptions.mjs", "vnc-bridge.mjs"]) {
      copyFileSync(path.join(repoRoot, "ui", name), path.join(dir, name));
    }
    if (pages) {
      copyFileSync(path.join(repoRoot, "ui", "index.html"), path.join(dir, "index.html"));
      cpSync(path.join(repoRoot, "ui", "machine-room"), path.join(dir, "machine-room"), { recursive: true });
    }
    writeAuthFile(path.join(dir, "auth.json"), newAuthRecord(PASSWORD));
    const port = 34000 + Math.floor(Math.random() * 8000);
    const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
      env: {
        ...process.env,
        SAND_UI_PORT: String(port),
        SAND_UI_BIND_HOST: "127.0.0.1",
        SAND_HOST_GATEWAY_TOKEN: "b".repeat(64),
        // Nothing answers there. Every assertion below is decided by the login before the relay
        // reaches upstream at all.
        SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const listening = await new Promise((resolve) => {
      // "cfip " and not "prox ": cfip is the LAST line the relay prints on start, and waiting on
      // the earlier one means the snapshot of stdout taken here sometimes stops mid-boot. That
      // showed up as a test that passed alone and failed in the suite.
      child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("cfip ")) resolve(true); });
      child.on("exit", () => resolve(false));
      setTimeout(() => resolve(false), 15_000).unref();
    });
    if (listening) return { base: `http://127.0.0.1:${port}`, boot: out, stop: () => child.kill("SIGKILL") };
    child.kill("SIGKILL");
  }
  throw new Error("the relay copy would not start on any of five ports");
}

// The relay is reached over loopback, so 127.0.0.1 stands in for Traefik: it is the peer, and
// whether its headers are believed is the whole question.
const attempt = (base, password, headers = {}) => fetch(`${base}/login`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", ...headers },
  body: new URLSearchParams({ password, next: "/" }).toString(),
});

test("from a trusted proxy, one forwarded address's lockout does not touch another's", async () => {
  const relay = await startRelay({ SAND_UI_TRUSTED_PROXIES: "127.0.0.1/32" });
  try {
    assert.match(relay.boot, /prox 1 trusted range/);
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await attempt(relay.base, `wrong-${i}`, { "x-forwarded-for": "198.51.100.1" })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429], "five refusals then the limiter");

    // A second visitor, arriving through the same proxy while the first is locked out.
    const other = await attempt(relay.base, "also-wrong", { "x-forwarded-for": "198.51.100.2" });
    assert.equal(other.status, 401, "the second address inherited the first one's lockout");

    // And the right password still works for that second address, which is the operator's case:
    // somebody else's failures must not cost him his console.
    const good = await attempt(relay.base, PASSWORD, {
      "x-forwarded-for": "198.51.100.2", "x-forwarded-proto": "https",
    });
    assert.equal(good.status, 302);
    const cookie = good.headers.get("set-cookie") ?? "";
    assert.match(cookie, /gb_session=/);
    // Traefik terminated the TLS, so the cookie has to be marked Secure even though this hop was
    // plain HTTP. Without that the browser would send the session over http as well.
    assert.match(cookie, /Secure/);
    assert.equal(good.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  } finally { relay.stop(); }
});

test("from an untrusted peer a forged X-Forwarded-For buys nothing at all", async () => {
  // No SAND_UI_TRUSTED_PROXIES, which is the default and today's tailnet deployment.
  const relay = await startRelay({});
  try {
    assert.match(relay.boot, /prox none, so the socket address is the client/);
    const statuses = [];
    // A different forged address every time. If the header were believed this would be six
    // separate first attempts and every one of them would answer 401.
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await attempt(relay.base, `wrong-${i}`, { "x-forwarded-for": `198.51.100.${10 + i}` })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429], "the forged addresses were counted as one caller");
    // CF-Connecting-IP is not a way around it either.
    const viaCf = await attempt(relay.base, "wrong-again", { "cf-connecting-ip": "198.51.100.99" });
    assert.equal(viaCf.status, 429);
  } finally { relay.stop(); }
});

test("a forged CF-Connecting-IP does not escape the lockout, however many are tried", async () => {
  // The whole point of SAND_UI_CLOUDFLARE_RANGES, exercised through a running relay. The peer is
  // trusted, so the relay reads X-Forwarded-For -- and 198.51.100.4 is the address Traefik would
  // have written for someone who connected straight to the origin, bypassing Cloudflare
  // altogether. His CF-Connecting-IP is his own invention and changes every attempt.
  const relay = await startRelay({
    SAND_UI_TRUSTED_PROXIES: "127.0.0.1/32",
    SAND_UI_CLOUDFLARE_RANGES: CF,
  });
  try {
    assert.match(relay.boot, /cfip 3 Cloudflare range\(s\)/);
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await attempt(relay.base, `wrong-${i}`, {
        "x-forwarded-for": "198.51.100.4",
        "cf-connecting-ip": `203.0.113.${10 + i}`,
      })).status);
    }
    // Five refusals and then the limiter, exactly as if the header had not been sent. If it were
    // believed this would read 401 eight times and a guesser would have unlimited attempts.
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429], "the forged CF-Connecting-IP bought fresh attempts");

    // And the address that was really locked out is the one the proxy observed, not the forged
    // one: a request from that address with no CF header at all is still refused.
    const bare = await attempt(relay.base, "wrong-again", { "x-forwarded-for": "198.51.100.4" });
    assert.equal(bare.status, 429);
  } finally { relay.stop(); }
});

test("behind a Cloudflare edge the visitor's own address is what gets locked out", async () => {
  const relay = await startRelay({
    SAND_UI_TRUSTED_PROXIES: "127.0.0.1/32",
    SAND_UI_CLOUDFLARE_RANGES: CF,
  });
  try {
    // 162.158.1.1 is inside Cloudflare's published range, so on this path Cloudflare wrote the
    // CF-Connecting-IP and it is the visitor. Without reading it every visitor behind that one
    // edge would share a bucket, which is the lockout Jason gets pushed out of.
    const cfHop = { "x-forwarded-for": "162.158.1.1" };
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await attempt(relay.base, `wrong-${i}`, { ...cfHop, "cf-connecting-ip": "198.51.100.20" })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429], "one visitor, one bucket");

    // A different visitor through the same edge, while the first is locked out.
    const other = await attempt(relay.base, "also-wrong", { ...cfHop, "cf-connecting-ip": "198.51.100.21" });
    assert.equal(other.status, 401, "the second visitor inherited the first one's lockout");

    // Including the operator with the right password, which is the case that matters.
    const good = await attempt(relay.base, PASSWORD, { ...cfHop, "cf-connecting-ip": "198.51.100.21" });
    assert.equal(good.status, 302);
  } finally { relay.stop(); }
});

test("with no Cloudflare ranges configured the header is dead, and that is the default", async () => {
  const relay = await startRelay({ SAND_UI_TRUSTED_PROXIES: "127.0.0.1/32" });
  try {
    assert.match(relay.boot, /cfip none, so CF-Connecting-IP is never read/);
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await attempt(relay.base, `wrong-${i}`, {
        "x-forwarded-for": "162.158.1.1",
        "cf-connecting-ip": `203.0.113.${30 + i}`,
      })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429], "the header was read without being configured");
  } finally { relay.stop(); }
});

test("HSTS is sent on a request that arrived over TLS, and on no other", async () => {
  const relay = await startRelay({ SAND_UI_TRUSTED_PROXIES: "127.0.0.1/32" });
  try {
    const overTls = await fetch(`${relay.base}/login`, { headers: { accept: "text/html", "x-forwarded-proto": "https" } });
    assert.equal(overTls.status, 200);
    assert.equal(overTls.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");

    const plain = await fetch(`${relay.base}/login`, { headers: { accept: "text/html" } });
    assert.equal(plain.headers.get("strict-transport-security"), null);

    // The login page is one response with its CSS inside it. Nothing it asks for may be plain
    // HTTP, or a browser on the public domain blocks it and the operator gets a bare form.
    const html = await overTls.text();
    assert.equal(/(?:src|href)\s*=\s*["']http:/i.test(html), false, "the login page asks for an http asset");
    // And every refusal carries it too, not only the pages that succeed.
    const refused = await attempt(relay.base, "wrong", { "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.200" });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  } finally { relay.stop(); }
});

test("a forged x-forwarded-proto from an untrusted peer sets neither HSTS nor Secure", async () => {
  const relay = await startRelay({});
  try {
    const lying = await fetch(`${relay.base}/login`, { headers: { accept: "text/html", "x-forwarded-proto": "https" } });
    assert.equal(lying.headers.get("strict-transport-security"), null);
    const good = await attempt(relay.base, PASSWORD, { "x-forwarded-proto": "https" });
    assert.equal(good.status, 302);
    assert.equal(/Secure/.test(good.headers.get("set-cookie") ?? ""), false);
  } finally { relay.stop(); }
});

// The pages themselves, not just the login form. This is the check the login-page assertion above
// could not make: /operator serves ui/index.html, and that file still carries the desktop frame's
// original address, http://127.0.0.1:6080. On https://<the domain> that is mixed content the
// browser blocks outright, and even unblocked it aims at the VIEWER's own loopback rather than at
// the box. The file is not this server's to edit; what it publishes is, so the relay rewrites the
// address on the way out and this test is what says the rewrite is still there.
//
// It reads the token the way a browser cannot be made to: with the bearer, which mints a session.
// Typing a password would work too and would prove nothing extra.
test("neither page the relay serves asks for an http asset, and the desktop frame is same-origin", async () => {
  const relay = await startRelay({ SAND_UI_TRUSTED_PROXIES: "127.0.0.1/32" }, { pages: true });
  try {
    const headers = { accept: "text/html", authorization: `Bearer ${"b".repeat(64)}`, "x-forwarded-proto": "https" };
    for (const pathname of ["/", "/operator"]) {
      const page = await fetch(`${relay.base}${pathname}`, { headers, redirect: "manual" });
      assert.equal(page.status, 200, `${pathname} answered ${page.status}`);
      const html = await page.text();
      // Every http:// in a served page, minus the one that is not a fetch: the SVG namespace in a
      // data: URI, which is an identifier and is never resolved.
      const insecure = (html.match(/http:\/\/[^"'\s)]+/g) ?? [])
        .filter((url) => !url.startsWith("http://www.w3.org/"));
      assert.deepEqual(insecure, [], `${pathname} embeds ${insecure.length} http-only reference(s)`);
    }

    // And the rewrite put something usable in its place rather than merely deleting a scheme: the
    // relay's own /vnc route, with the websocket path noVNC needs to be told explicitly.
    const operator = await (await fetch(`${relay.base}/operator`, { headers, redirect: "manual" })).text();
    assert.match(operator, /\/vnc\/1\/vnc_lite\.html\?/);
    assert.match(operator, /path=%2Fvnc%2F1%2Fwebsockify/);
  } finally { relay.stop(); }
});
