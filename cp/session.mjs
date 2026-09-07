// cp/session.mjs -- the session token the control plane mints and every tenant relay verifies.
//
// This file is the shared half of tenancy. The control plane signs a token when a customer signs
// in; the relay on that customer's own instance verifies the same bytes with the same secret and
// lets the session in instead of asking for the relay password. So it has to be importable from
// both sides, and it must never grow a dependency on the store, the config or the network. It
// imports node:crypto and nothing else, on purpose.
//
// The shape, written out:
//
//   v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, the payload part))>
//
// The signature covers the payload SEGMENT, the base64url text, not the JSON behind it. That is
// what makes a re-encoding attack pointless: two different encodings of the same object are two
// different strings, and only one of them carries a signature that checks out.
//
// iat and exp are milliseconds since the epoch, the same unit as Date.now(), so neither side has
// to remember a conversion. Seconds are the more common choice and the reason to break with it is
// that a unit mistake here reads as "the token expired twelve hours ago" or "expires in 1971", and
// one of those two locks a customer out of their own console.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_VERSION = "v1";
// Twelve hours. Long enough that a working day does not end with a sign-in, short enough that a
// laptop left in a coffee shop is not a standing key to the instance.
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// The claims a token must carry. sub is the account id, tenant is the slug, host is the hostname
// the relay answers on. host is in here so a relay can refuse a token minted for somebody else's
// instance without asking the control plane anything.
const REQUIRED_CLAIMS = ["sub", "email", "tenant", "host", "iat", "exp", "jti"];

export function base64urlEncode(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(text) {
  const padded = String(text).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function signPart(part, secret) {
  if (typeof secret !== "string" || secret.length === 0) throw new Error("the session secret is empty");
  return base64urlEncode(createHmac("sha256", secret).update(part, "utf8").digest());
}

// Constant time over two base64url strings of the same length. Different lengths cannot be a valid
// pair here, both being a fixed width HMAC, so the early return leaks nothing the caller did not
// already put in the token themselves.
function signaturesMatch(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// Mints a token. Callers may pass iat and exp so a test can hold the clock still; both default to
// now and now plus twelve hours.
export function mintSessionToken(claims, secret, now = Date.now()) {
  const iat = Number.isFinite(claims?.iat) ? Number(claims.iat) : Number(now);
  const exp = Number.isFinite(claims?.exp) ? Number(claims.exp) : iat + SESSION_TTL_MS;
  const payload = {
    sub: String(claims?.sub ?? ""),
    email: String(claims?.email ?? ""),
    tenant: String(claims?.tenant ?? ""),
    host: String(claims?.host ?? ""),
    iat,
    exp,
    jti: String(claims?.jti ?? ""),
  };
  for (const key of REQUIRED_CLAIMS) {
    const value = payload[key];
    if (value === "" || value === undefined || value === null) throw new Error(`the session claim ${key} is empty`);
  }
  const part = base64urlEncode(JSON.stringify(payload));
  return { token: `${SESSION_VERSION}.${part}.${signPart(part, secret)}`, payload };
}

// The verifier both sides run.
//
// It answers {ok: true, payload} or {ok: false, reason}. The reasons are "malformed",
// "bad_signature" and "expired", and callers turn every one of them into the same 401 for the
// person signing in: which of the three it was is worth nothing to the customer and something to
// an attacker.
//
// Revocation is deliberately NOT checked here. The control plane keeps the revocation table and
// checks it around this call; a relay has no such table and checks only the signature and the
// expiry, which is the whole reason the token carries a twelve hour life instead of a longer one.
export function verifySessionToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [version, part, signature] = parts;
  if (version !== SESSION_VERSION) return { ok: false, reason: "malformed" };
  if (part.length === 0 || signature.length === 0) return { ok: false, reason: "malformed" };

  let expected;
  try { expected = signPart(part, secret); }
  catch { return { ok: false, reason: "malformed" }; }
  if (!signaturesMatch(signature, expected)) return { ok: false, reason: "bad_signature" };

  let payload;
  try { payload = JSON.parse(base64urlDecode(part).toString("utf8")); }
  catch { return { ok: false, reason: "malformed" }; }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "malformed" };
  for (const key of REQUIRED_CLAIMS) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") return { ok: false, reason: "malformed" };
  }
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return { ok: false, reason: "malformed" };
  if (Number(payload.exp) <= Number(now)) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}
