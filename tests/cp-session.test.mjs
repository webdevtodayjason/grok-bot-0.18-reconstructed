// TENANT-1. The session token the control plane mints and every tenant relay verifies: the shape,
// the twelve hour life, what a tamper does, and the one thing the relay side deliberately does not
// check.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomBytes } from "node:crypto";

import {
  SESSION_TTL_MS,
  SESSION_VERSION,
  base64urlDecode,
  base64urlEncode,
  mintSessionToken,
  tenantOfUnverifiedToken,
  tenantSessionSecret,
  verifySessionToken,
} from "../cp/session.mjs";

const SECRET = randomBytes(32).toString("hex");
const NOW = 1_780_000_000_000;

const claims = (overrides = {}) => ({
  sub: "account-1", email: "owner@example.com", tenant: "acme", host: "acme.titanium.bot", jti: "jti-1", ...overrides,
});

test("a minted token is v1, three parts, and carries every claim", () => {
  const { token, payload } = mintSessionToken(claims(), SECRET, NOW);
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], SESSION_VERSION);
  assert.deepEqual(JSON.parse(base64urlDecode(parts[1]).toString("utf8")), payload);
  assert.equal(payload.sub, "account-1");
  assert.equal(payload.tenant, "acme");
  assert.equal(payload.host, "acme.titanium.bot");
  assert.equal(payload.iat, NOW);
  // Twelve hours, the value the contract fixes.
  assert.equal(payload.exp, NOW + SESSION_TTL_MS);
  assert.equal(SESSION_TTL_MS, 12 * 60 * 60 * 1000);
});

test("the token is base64url, so it survives a header and a URL untouched", () => {
  const { token } = mintSessionToken(claims({ email: "a+b@example.com" }), SECRET, NOW);
  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test("verify accepts what mint produced and returns the payload", () => {
  const { token, payload } = mintSessionToken(claims(), SECRET, NOW);
  const verdict = verifySessionToken(token, SECRET, NOW + 1000);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.payload, payload);
});

test("a token past its expiry is refused, one millisecond either side of the line", () => {
  const { token, payload } = mintSessionToken(claims(), SECRET, NOW);
  assert.equal(verifySessionToken(token, SECRET, payload.exp - 1).ok, true);
  const expired = verifySessionToken(token, SECRET, payload.exp);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");
  assert.equal(verifySessionToken(token, SECRET, payload.exp + 60_000).reason, "expired");
});

test("a changed payload is refused even when the change is a valid token's payload", () => {
  const { token } = mintSessionToken(claims(), SECRET, NOW);
  const [, , signature] = token.split(".");
  // The obvious attack: keep the signature, swap the tenant for somebody else's.
  const forged = base64urlEncode(JSON.stringify(claims({ tenant: "titanium", host: "console.titanium.bot", iat: NOW, exp: NOW + SESSION_TTL_MS })));
  const verdict = verifySessionToken(`v1.${forged}.${signature}`, SECRET, NOW);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "bad_signature");
});

test("a changed expiry is refused, which is the tamper worth caring about", () => {
  const { token, payload } = mintSessionToken(claims(), SECRET, NOW);
  const [, part] = token.split(".");
  const stretched = JSON.parse(base64urlDecode(part).toString("utf8"));
  stretched.exp = payload.exp + 365 * 24 * 60 * 60 * 1000;
  const forged = `v1.${base64urlEncode(JSON.stringify(stretched))}.${token.split(".")[2]}`;
  assert.equal(verifySessionToken(forged, SECRET, NOW).reason, "bad_signature");
});

test("a token signed with another secret is refused", () => {
  const { token } = mintSessionToken(claims(), SECRET, NOW);
  assert.equal(verifySessionToken(token, randomBytes(32).toString("hex"), NOW).reason, "bad_signature");
});

test("malformed input is refused without throwing", () => {
  for (const value of ["", "nonsense", "v1.only-two", "v2.a.b", "v1..sig", "v1.sig.", null, undefined, 42, {}]) {
    const verdict = verifySessionToken(value, SECRET, NOW);
    assert.equal(verdict.ok, false, `expected ${JSON.stringify(value)} to be refused`);
  }
});

test("a well signed token whose payload is not an object, or is missing a claim, is malformed", () => {
  const arrayPart = base64urlEncode(JSON.stringify([1, 2, 3]));
  const arrayToken = mintSignedShape(arrayPart);
  assert.equal(verifySessionToken(arrayToken, SECRET, NOW).reason, "malformed");

  const missing = base64urlEncode(JSON.stringify({ sub: "a", email: "b", tenant: "c", iat: NOW, exp: NOW + 1000, jti: "d" }));
  assert.equal(verifySessionToken(mintSignedShape(missing), SECRET, NOW).reason, "malformed");
});

test("mint refuses to sign a token with an empty claim", () => {
  assert.throws(() => mintSessionToken(claims({ tenant: "" }), SECRET, NOW), /tenant/);
  assert.throws(() => mintSessionToken(claims({ host: "" }), SECRET, NOW), /host/);
});

test("mint refuses an empty secret rather than signing with nothing", () => {
  assert.throws(() => mintSessionToken(claims(), "", NOW), /secret/);
});

test("the verifier does not know about revocation, which is the relay's whole contract", () => {
  // The relay checks the signature and the expiry and nothing else, so a revoked token still
  // verifies here. Revocation is the control plane's table, checked around this call, and it is why
  // the token life is twelve hours rather than a week.
  const { token, payload } = mintSessionToken(claims(), SECRET, NOW);
  const verdict = verifySessionToken(token, SECRET, NOW);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.payload.jti, payload.jti);
});

// Signs an arbitrary payload segment the way cp/session.mjs does, so a test can build a token that
// is correctly signed and still wrong.
function mintSignedShape(part) {
  return `v1.${part}.${base64urlEncode(createHmac("sha256", SECRET).update(part, "utf8").digest())}`;
}

// ---- one key per tenant ---------------------------------------------------------------------

test("each tenant gets its own key, derived from the master, and one key does not reach another", () => {
  const acme = tenantSessionSecret(SECRET, "acme");
  const roofing = tenantSessionSecret(SECRET, "roofing");
  const titanium = tenantSessionSecret(SECRET, "titanium");

  assert.equal(acme.length, 64, "32 bytes as hex, which is what the relay's own check wants");
  assert.notEqual(acme, SECRET, "the master is never what a tenant is given");
  assert.notEqual(acme, roofing);
  assert.notEqual(acme, titanium);
  // Derivation is a function of the two inputs and nothing else, so the same tenant is the same key
  // on every run of the service.
  assert.equal(tenantSessionSecret(SECRET, "acme"), acme);
  // A different master gives a different key for the same tenant, which is what makes rotating the
  // master sign everybody out.
  assert.notEqual(tenantSessionSecret(randomBytes(32).toString("hex"), "acme"), acme);
  assert.throws(() => tenantSessionSecret("", "acme"), /session secret is empty/);
  assert.throws(() => tenantSessionSecret(SECRET, ""), /tenant name is empty/);
});

test("a tenant holding its own key cannot mint a session for another tenant", () => {
  // This is the whole point. Acme's relay holds acme's key, because that key is in acme's own
  // container environment. Whoever holds it can sign whatever claims they like.
  const acmeKey = tenantSessionSecret(SECRET, "acme");
  const forged = mintSessionToken(
    claims({ tenant: "titanium", host: "console.titanium.bot" }),
    acmeKey,
    NOW,
  ).token;

  // The control plane and the relay both check with the key for the tenant the token names, and
  // that is titanium's key, which acme does not have.
  const asTitanium = verifySessionToken(forged, tenantSessionSecret(SECRET, "titanium"), NOW);
  assert.equal(asTitanium.ok, false);
  assert.equal(asTitanium.reason, "bad_signature");
  // Nor does it verify under the master, which is what it would have been signed with before.
  assert.equal(verifySessionToken(forged, SECRET, NOW).ok, false);
  // Acme's own sessions still work, which is the other half of the answer.
  const honest = mintSessionToken(claims(), acmeKey, NOW).token;
  assert.equal(verifySessionToken(honest, acmeKey, NOW).ok, true);
});

test("the tenant a token names can be read before it is checked, and only to pick the key", () => {
  const { token } = mintSessionToken(claims(), tenantSessionSecret(SECRET, "acme"), NOW);
  assert.equal(tenantOfUnverifiedToken(token), "acme");
  assert.equal(tenantOfUnverifiedToken(""), "");
  assert.equal(tenantOfUnverifiedToken("not-a-token"), "");
  assert.equal(tenantOfUnverifiedToken("v2.abc.def"), "");
  assert.equal(tenantOfUnverifiedToken(`v1.${base64urlEncode("{not json")}.sig`), "");
  assert.equal(tenantOfUnverifiedToken(`v1.${base64urlEncode(JSON.stringify([1, 2]))}.sig`), "");
  // A rewritten claim reads back as the rewritten name, which is exactly what makes the check that
  // follows fail: it picks the key that name means, and the signature was made with another.
  const parts = token.split(".");
  const lying = `v1.${base64urlEncode(JSON.stringify({ ...claims(), tenant: "titanium", iat: NOW, exp: NOW + SESSION_TTL_MS }))}.${parts[2]}`;
  assert.equal(tenantOfUnverifiedToken(lying), "titanium");
  assert.equal(verifySessionToken(lying, tenantSessionSecret(SECRET, "titanium"), NOW).ok, false);
});
