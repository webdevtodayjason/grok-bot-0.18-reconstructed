// The relay's login helpers: the password hash, the session signature, and the lockout.
//
// These are the three pieces where a quiet mistake is indistinguishable from working software. A
// hash that compares the wrong buffers, a signature that is not actually checked, and a limiter
// that resets itself all behave exactly like the correct version until someone attacks them.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clientAddress, createLoginThrottle, createSession, hashPassword, isLoopbackHost, isSecureRequest,
  newAuthRecord, parseCookies, parseTrustedProxies, readAuthFile, readSession, safeNextPath,
  serializeCookie, signSession, sourceAddress, verifyPassword, writeAuthFile,
} from "../ui/auth.mjs";

// Cheap scrypt parameters: these tests derive keys dozens of times and the production cost factor
// would put the suite in the tens of seconds for no extra coverage.
const FAST = { N: 1024, r: 8, p: 1, keylen: 32 };

test("a password verifies against its own hash and nothing else", () => {
  const record = hashPassword("correct horse battery staple", undefined, FAST);
  assert.equal(verifyPassword("correct horse battery staple", record), true);
  assert.equal(verifyPassword("correct horse battery stapl", record), false);
  assert.equal(verifyPassword("", record), false);
  assert.equal(verifyPassword("correct horse battery staple ", record), false);
});

test("the hash is salted, so the same password stores differently every time", () => {
  const a = hashPassword("same password", undefined, FAST);
  const b = hashPassword("same password", undefined, FAST);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(verifyPassword("same password", a), true);
  assert.equal(verifyPassword("same password", b), true);
});

test("a tampered or malformed record verifies nothing rather than throwing", () => {
  const record = hashPassword("hunter2hunter2", undefined, FAST);
  assert.equal(verifyPassword("hunter2hunter2", { ...record, salt: "00" }), false);
  // Flip the first nibble to something it is definitely not: replacing it with a constant "f" is
  // a no-op one time in sixteen, when the fresh salt happened to derive a hash starting with f.
  const flipped = record.hash.replace(/^./, (c) => (c === "f" ? "0" : "f"));
  assert.notEqual(flipped, record.hash);
  assert.equal(verifyPassword("hunter2hunter2", { ...record, hash: flipped }), false);
  assert.equal(verifyPassword("hunter2hunter2", { ...record, algorithm: "md5" }), false);
  assert.equal(verifyPassword("hunter2hunter2", { ...record, N: 0 }), false);
  for (const bad of [null, undefined, "", 7, [], {}]) assert.equal(verifyPassword("hunter2hunter2", bad), false);
});

const SECRET = "a".repeat(64);

test("a session round trips and carries its expiry", () => {
  const now = 1_700_000_000_000;
  const token = createSession(SECRET, { nowMs: now, lifetimeMs: 12 * 60 * 60 * 1000 });
  const payload = readSession(token, SECRET, now + 1000);
  assert.ok(payload);
  assert.equal(payload.exp, now + 12 * 60 * 60 * 1000);
});

test("a session is rejected once it expires, one millisecond after", () => {
  const now = 1_700_000_000_000;
  const token = createSession(SECRET, { nowMs: now, lifetimeMs: 1000 });
  assert.ok(readSession(token, SECRET, now + 999));
  assert.equal(readSession(token, SECRET, now + 1000), null);
  assert.equal(readSession(token, SECRET, now + 5000), null);
});

test("a session is rejected under a different secret", () => {
  const token = createSession(SECRET, { nowMs: 1000 });
  assert.equal(readSession(token, "b".repeat(64), 2000), null);
});

test("an edited payload no longer verifies", () => {
  const now = 1_700_000_000_000;
  const token = signSession({ iat: now, exp: now + 1000 }, SECRET);
  const [body, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ iat: now, exp: now + 999_999_999 })).toString("base64url");
  assert.equal(readSession(`${forged}.${signature}`, SECRET, now), null);
  // Keeping the payload and inventing a signature fails the same way.
  assert.equal(readSession(`${body}.${"x".repeat(43)}`, SECRET, now), null);
});

test("garbage is not a session", () => {
  for (const bad of ["", ".", "abc", "abc.", ".abc", "a.b.c", null, undefined, 12]) {
    assert.equal(readSession(bad, SECRET, 0), null);
  }
  assert.equal(readSession(createSession(SECRET), "", 0), null);
});

test("five failures lock the source out for thirty seconds", () => {
  const now = 1000;
  const limiter = createLoginThrottle({ maxFailures: 5, lockoutMs: 30_000 });
  for (let i = 0; i < 4; i += 1) {
    assert.equal(limiter.recordFailure("10.0.0.1", now), 0, `failure ${i + 1} must not lock`);
    assert.equal(limiter.retryAfterMs("10.0.0.1", now), 0);
  }
  assert.equal(limiter.recordFailure("10.0.0.1", now), 30_000);
  assert.equal(limiter.retryAfterMs("10.0.0.1", now), 30_000);
  assert.equal(limiter.retryAfterMs("10.0.0.1", now + 29_999), 1);
  assert.equal(limiter.retryAfterMs("10.0.0.1", now + 30_000), 0);
});

test("the lockout is per source address", () => {
  const limiter = createLoginThrottle({ maxFailures: 5, lockoutMs: 30_000 });
  for (let i = 0; i < 5; i += 1) limiter.recordFailure("10.0.0.1", 0);
  assert.ok(limiter.retryAfterMs("10.0.0.1", 0) > 0);
  assert.equal(limiter.retryAfterMs("10.0.0.2", 0), 0);
});

test("a success clears the count, so four typos plus a login is not a lockout", () => {
  const limiter = createLoginThrottle({ maxFailures: 5, lockoutMs: 30_000 });
  for (let i = 0; i < 4; i += 1) limiter.recordFailure("10.0.0.1", 0);
  limiter.recordSuccess("10.0.0.1");
  for (let i = 0; i < 4; i += 1) assert.equal(limiter.recordFailure("10.0.0.1", 0), 0);
  assert.equal(limiter.retryAfterMs("10.0.0.1", 0), 0);
});

test("an expired lockout starts a fresh five, not a permanent ban", () => {
  const limiter = createLoginThrottle({ maxFailures: 5, lockoutMs: 30_000 });
  for (let i = 0; i < 5; i += 1) limiter.recordFailure("10.0.0.1", 0);
  assert.equal(limiter.retryAfterMs("10.0.0.1", 30_000), 0);
  assert.equal(limiter.size(), 0);
  for (let i = 0; i < 4; i += 1) assert.equal(limiter.recordFailure("10.0.0.1", 30_000), 0);
  assert.equal(limiter.recordFailure("10.0.0.1", 30_000), 30_000);
});

test("the session cookie is HttpOnly, SameSite=Strict, and Secure only over TLS", () => {
  const plain = serializeCookie("gb_session", "value", { maxAgeSeconds: 43_200, secure: false });
  assert.match(plain, /^gb_session=value; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  assert.ok(!plain.includes("Secure"));
  assert.ok(serializeCookie("gb_session", "v", { secure: true }).endsWith("; Secure"));
  assert.match(serializeCookie("gb_session", "", { maxAgeSeconds: 0 }), /Max-Age=0/);
});

test("cookies parse out of a real header, including one with an equals sign in the value", () => {
  const jar = parseCookies("theme=dusk; gb_session=abc.def%3D%3D; other=1");
  assert.equal(jar.theme, "dusk");
  assert.equal(jar.gb_session, "abc.def==");
  assert.equal(parseCookies(undefined).gb_session, undefined);
  assert.equal(parseCookies("novalue").novalue, undefined);
});

// This used to accept a forwarded https from anyone, on the argument that the header can only ADD
// the Secure flag and so can only ever hurt the liar. That argument stopped holding the moment the
// same signal started deciding whether a response carries HSTS: a stranger could then make a
// browser refuse plain HTTP to a host they do not own. So the forwarded scheme is now believed
// only from a peer the operator has named, and from nobody by default.
test("Secure comes from a TLS socket, or a forwarded https from a TRUSTED peer, and nothing else", () => {
  const trusted = parseTrustedProxies("10.0.2.0/24");
  assert.equal(isSecureRequest({ socket: { encrypted: true }, headers: {} }), true);
  assert.equal(isSecureRequest({ socket: { remoteAddress: "10.0.2.7" }, headers: { "x-forwarded-proto": "https" } }, trusted), true);
  assert.equal(isSecureRequest({ socket: { remoteAddress: "10.0.2.7" }, headers: { "x-forwarded-proto": "https, http" } }, trusted), true);
  assert.equal(isSecureRequest({ socket: { remoteAddress: "10.0.2.7" }, headers: { "x-forwarded-proto": "http" } }, trusted), false);
  // The same claim from an address nobody vouched for, and with no trusted list at all.
  assert.equal(isSecureRequest({ socket: { remoteAddress: "203.0.113.9" }, headers: { "x-forwarded-proto": "https" } }, trusted), false);
  assert.equal(isSecureRequest({ socket: {}, headers: { "x-forwarded-proto": "https" } }), false);
  assert.equal(isSecureRequest({ socket: {}, headers: {} }), false);
});

test("the throttle key is the socket address, never a forwarded header", () => {
  const req = { socket: { remoteAddress: "10.0.0.9" }, headers: { "x-forwarded-for": "1.2.3.4" } };
  assert.equal(sourceAddress(req), "10.0.0.9");
  assert.equal(sourceAddress({ headers: {} }), "unknown");
  // And that is still what the login keys on when no proxy is trusted, which is the default.
  assert.equal(clientAddress(req), "10.0.0.9");
  assert.equal(clientAddress(req, parseTrustedProxies("")), "10.0.0.9");
});

test("only a path on this site survives as a redirect target", () => {
  assert.equal(safeNextPath("/operator?x=1"), "/operator?x=1");
  assert.equal(safeNextPath("//evil.example/"), "/");
  assert.equal(safeNextPath("https://evil.example/"), "/");
  assert.equal(safeNextPath("/\\evil.example"), "/");
  assert.equal(safeNextPath(""), "/");
  assert.equal(safeNextPath(null), "/");
});

test("loopback is recognised by every name the operator might type", () => {
  for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.53", "LOCALHOST", "127.1"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  // The last three are the reason this is not a startsWith("127."): a name someone else's DNS
  // answers, and two shapes that are not an address at all, must not read as loopback and let the
  // relay bind a reachable interface with no password.
  for (const host of ["0.0.0.0", "100.110.83.82", "192.168.1.10", "", null,
    "127.0.0.1.example.com", "127.", "127.0.0.999"]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test("the auth file is written 0600 and read back, and a missing one is not an error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-auth-"));
  const file = path.join(dir, "auth.json");
  assert.equal(readAuthFile(file), null);
  const record = newAuthRecord("a probe password");
  writeAuthFile(file, record);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const loaded = readAuthFile(file);
  assert.equal(loaded.cookieSecret.length, 64);
  assert.equal(verifyPassword("a probe password", loaded.password), true);
  // The password itself is nowhere in the file.
  assert.ok(!readFileSync(file, "utf8").includes("a probe password"));
});

test("a broken auth file throws rather than reading as no password at all", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-auth-"));
  const file = path.join(dir, "auth.json");
  writeFileSync(file, "{ not json");
  assert.throws(() => readAuthFile(file));
  writeFileSync(file, JSON.stringify({ version: 1 }));
  assert.throws(() => readAuthFile(file), /no password or no cookieSecret/);
  writeFileSync(file, JSON.stringify({ version: 1, password: {}, cookieSecret: "" }));
  assert.throws(() => readAuthFile(file), /no password or no cookieSecret/);
});
