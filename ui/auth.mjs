// Password and session helpers for the relay's login.
//
// Kept out of server.mjs so the parts worth being sure about -- the hash, the signature, the
// lockout -- can be tested without standing a server up. Nothing here imports anything outside
// node builtins, because the relay image has no node_modules at all.
//
// The threat this closes: the relay injects the gateway bearer into every /api call it forwards,
// so reaching the relay has always been equivalent to holding the token. A login puts a password
// in front of that. It does not make the relay safe to publish on the open internet; it makes
// reaching the port stop being the same thing as holding the token.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

// N=16384 keeps the derivation around 40 ms on this hardware and stays under node's default
// 32 MB scrypt maxmem (the cost is 128 * N * r = 16 MB), so no caller has to pass maxmem in.
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

const utf8 = (value) => Buffer.from(String(value), "utf8");

// Constant time for equal-length inputs; a length difference is not a secret worth hiding here,
// and timingSafeEqual throws rather than returning false when the lengths differ.
export function safeEqual(a, b) {
  const left = utf8(a);
  const right = utf8(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function hashPassword(password, salt = randomBytes(16).toString("hex"), params = SCRYPT_PARAMS) {
  const { N, r, p, keylen } = params;
  const hash = scryptSync(utf8(password), utf8(salt), keylen, { N, r, p }).toString("hex");
  return { algorithm: "scrypt", N, r, p, keylen, salt, hash };
}

// False for every kind of bad input rather than throwing: this runs on an unauthenticated request
// path, and a malformed auth.json must lock everyone out, never crash the process.
export function verifyPassword(password, record) {
  if (record == null || typeof record !== "object") return false;
  if (record.algorithm !== "scrypt") return false;
  const { N, r, p, keylen, salt, hash } = record;
  if (typeof salt !== "string" || typeof hash !== "string") return false;
  if (![N, r, p, keylen].every((n) => Number.isInteger(n) && n > 0)) return false;
  let derived;
  try { derived = scryptSync(utf8(password), utf8(salt), keylen, { N, r, p }).toString("hex"); }
  catch { return false; }
  return safeEqual(derived, hash);
}

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

const mac = (body, secretHex) =>
  createHmac("sha256", Buffer.from(secretHex, "hex")).update(body).digest("base64url");

// The session is the payload plus its HMAC, not an opaque id in a server-side table. That is on
// purpose: the relay is restarted by every redeploy, and a table would sign everyone out each
// time for no security gain. The cost is that a session cannot be revoked individually; rotating
// the cookie secret (set-password writes a fresh one) revokes all of them at once.
export function signSession(payload, secretHex) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${mac(body, secretHex)}`;
}

export function createSession(secretHex, { nowMs = Date.now(), lifetimeMs = SESSION_LIFETIME_MS } = {}) {
  return signSession({ iat: nowMs, exp: nowMs + lifetimeMs }, secretHex);
}

// Returns the payload, or null for anything that is not a live signature: wrong secret, edited
// payload, missing separator, expired. Callers only ever ask "is this a session".
export function readSession(token, secretHex, nowMs = Date.now()) {
  if (typeof token !== "string" || typeof secretHex !== "string" || secretHex.length === 0) return null;
  const cut = token.indexOf(".");
  if (cut <= 0 || cut === token.length - 1) return null;
  const body = token.slice(0, cut);
  const signature = token.slice(cut + 1);
  if (!safeEqual(signature, mac(body, secretHex))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { return null; }
  if (payload == null || typeof payload !== "object") return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= nowMs) return null;
  return payload;
}

// Five failures then a thirty second wait, per source address. The counter resets on a success and
// again when a lockout expires, so this is a speed limit rather than a permanent ban: an operator
// who mistypes six times waits half a minute, an online guesser gets ten tries a minute.
export function createLoginThrottle({ maxFailures = 5, lockoutMs = 30_000, capacity = 4096 } = {}) {
  const seen = new Map();
  const entry = (key) => seen.get(key) ?? { failures: 0, lockedUntil: 0, touched: 0 };
  return {
    // Milliseconds the caller must wait; 0 means the attempt is allowed.
    retryAfterMs(key, nowMs = Date.now()) {
      const state = seen.get(key);
      if (state == null) return 0;
      if (state.lockedUntil > nowMs) return state.lockedUntil - nowMs;
      if (state.lockedUntil !== 0) { seen.delete(key); return 0; }
      return 0;
    },
    recordFailure(key, nowMs = Date.now()) {
      const state = entry(key);
      state.failures += 1;
      state.touched = nowMs;
      if (state.failures >= maxFailures) { state.lockedUntil = nowMs + lockoutMs; state.failures = 0; }
      seen.set(key, state);
      // An unbounded map keyed by a value the caller controls is a memory leak with a nice name.
      if (seen.size > capacity) {
        for (const [k, v] of seen) { if (v.lockedUntil <= nowMs) seen.delete(k); if (seen.size <= capacity) break; }
      }
      return state.lockedUntil > nowMs ? state.lockedUntil - nowMs : 0;
    },
    recordSuccess(key) { seen.delete(key); },
    size() { return seen.size; },
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const cut = part.indexOf("=");
    if (cut <= 0) continue;
    const name = part.slice(0, cut).trim();
    if (name.length === 0) continue;
    try { out[name] = decodeURIComponent(part.slice(cut + 1).trim()); }
    catch { out[name] = part.slice(cut + 1).trim(); }
  }
  return out;
}

export function serializeCookie(name, value, { maxAgeSeconds, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  // SameSite=Strict is also the CSRF answer: a POST originating anywhere but this site carries no
  // cookie at all, so a cross-site form cannot ride an operator's session into /api.
  if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// Secure only when the connection really is TLS. X-Forwarded-Proto is a header a client can send,
// but the only thing it can do here is ADD the Secure flag, which never weakens the cookie: the
// worst a liar achieves is locking their own session out of plain HTTP.
export function isSecureRequest(req) {
  if (req?.socket?.encrypted === true) return true;
  const forwarded = String(req?.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  return forwarded === "https";
}

// The socket address, deliberately not X-Forwarded-For. A forwarded value is attacker controlled,
// and keying the lockout on it would let a guesser rotate the header and never be limited. Behind
// a proxy every request then shares one bucket, which limits harder than intended rather than
// less, and that is the right way for this to be wrong.
export function sourceAddress(req) {
  return String(req?.socket?.remoteAddress ?? "unknown");
}

// Anything not recognised here is treated as reachable, so the loose end of this test is the
// dangerous one: "127.0.0.1.example.com" starts with "127." and is a name someone else's DNS
// answers. Only the numeric forms node itself treats as loopback count, shorthands included
// (127.1 resolves to 127.0.0.1).
export function isLoopbackHost(host) {
  const value = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "::1" || value === "localhost") return true;
  if (!/^127(\.\d{1,3}){1,3}$/.test(value)) return false;
  return value.split(".").slice(1).every((octet) => Number(octet) <= 255);
}

// A "next" that is not a path on this site is an open redirect, so anything else becomes "/".
// Two leading slashes are the case that looks relative and is not: //evil.example is an origin.
export function safeNextPath(value) {
  const next = String(value ?? "");
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

export function newAuthRecord(password) {
  return {
    version: 1,
    password: hashPassword(password),
    // 32 bytes of HMAC key. Rotating it (which set-password does on every run) invalidates every
    // outstanding session, which is the only revocation this design has.
    cookieSecret: randomBytes(32).toString("hex"),
    createdAtMs: Date.now(),
  };
}

// null means "no password is configured", which is a supported state on loopback. A file that
// exists but does not parse is NOT that: it throws, because starting wide open because the JSON
// had a stray comma is precisely the failure this whole file exists to prevent.
export function readAuthFile(file) {
  let raw;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const parsed = JSON.parse(raw);
  if (parsed?.password == null || typeof parsed?.cookieSecret !== "string" || parsed.cookieSecret.length === 0) {
    throw new Error(`${file} has no password or no cookieSecret`);
  }
  return parsed;
}

export function writeAuthFile(file, record) {
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode applies only when it creates the file, so an overwrite of a file that was
  // once 0644 would keep 0644 without this.
  chmodSync(file, 0o600);
}
