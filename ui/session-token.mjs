// ui/session-token.mjs -- the session token the control plane mints and every tenant relay verifies.
//
// This file is the shared half of tenancy. The control plane signs a token when a customer signs
// in; the relay on that customer's own instance verifies the same bytes with the key it was given
// and lets the session in instead of asking for the relay password. So it has to be importable from
// both sides, and it must never grow a dependency on the store, the config or the network. It
// imports node:crypto and nothing else, on purpose.
//
// It lives in ui/ rather than cp/ because the relay is the side that ships everywhere. ui/ is what
// deploy/r750/sync.sh copies to the server and what every tenant container mounts read only, and a
// relay cannot import a file out of the control plane's image. cp/session.mjs is a re-export of
// this file, so the control plane's own imports read the same as they always did and the two sides
// cannot drift into two copies of one verifier -- which is the failure that matters here, because
// two verifiers that disagree by one line look exactly like a customer with a bad password.
//
// The key is per tenant, not one key for everybody. See tenantSessionSecret below: the control
// plane holds a master and gives each tenant only HMAC-SHA256(master, that tenant's name).
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

// ---- one key per tenant --------------------------------------------------------------------
//
// CP_SESSION_SECRET on the control plane is a MASTER key and is never handed to a tenant. Each
// tenant relay is given only this, its own derived key, and that key signs for that tenant and
// nothing else.
//
// Why it has to work this way: the tenant's key is written into that tenant's Coolify environment,
// which means it is readable by anyone who can read the container's environment, which is anyone
// who can run code in that customer's relay. If the value there were the master, that customer
// could sign a token claiming any tenant they liked, including console.titanium.bot, and the
// relay's tenant check would be no defence at all: they would simply mint the claim it wants.
//
// HMAC is what makes the derivation one-way, so holding a tenant key does not walk back to the
// master and cannot produce a second tenant's key. The label is in the message so this value can
// never collide with some other thing derived from the same master later.
const TENANT_KEY_LABEL = "titanbot-tenant-session-v1";

export function tenantSessionSecret(masterSecret, tenant) {
  const master = String(masterSecret ?? "");
  const slug = String(tenant ?? "");
  if (master.length === 0) throw new Error("the session secret is empty");
  if (slug.length === 0) throw new Error("the tenant name is empty");
  return createHmac("sha256", master).update(`${TENANT_KEY_LABEL}:${slug}`, "utf8").digest("hex");
}

// Which tenant a token SAYS it is for, read without checking anything. It is used for one purpose
// only: choosing the key to verify with. A liar picks a key that is not the one the token was
// signed under, so the signature check that follows fails, which is the whole reason reading an
// unverified claim is safe here and nowhere else.
export function tenantOfUnverifiedToken(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return "";
  try {
    const payload = JSON.parse(base64urlDecode(parts[1]).toString("utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "";
    return typeof payload.tenant === "string" ? payload.tenant : "";
  } catch { return ""; }
}

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
