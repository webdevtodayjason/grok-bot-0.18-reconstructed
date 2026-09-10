// STORE-1. The token door's own rules, without a socket: the token format, the rows on disk, and the
// CORS allow-list.
//
// Every test here is one of the five rules at the top of ui/auth-device.mjs made checkable. The ones
// worth naming, because each of them looks like working software if it is wrong:
//
//   - a token verified with the wrong workspace's claim, or after the cookie secret rotated;
//   - a re-mint that leaves the PREVIOUS token live, which is a stolen phone with thirty days on it;
//   - a revoke that the cache keeps serving past its own window;
//   - a reflected Origin, or a prefix match, instead of the exact-string set;
//   - Access-Control-Allow-Credentials on any answer at all, which would trade SameSite=Strict away.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  DEVICE_CACHE_MS, DEVICE_LIMIT, DEVICE_TOKEN_PREFIX, DEVICE_TOKEN_TTL_MS, LAST_SEEN_WRITE_MS,
  cleanDeviceName, cleanPlatform, corsHeaders, createDeviceStore, deviceBearerOf,
  looksLikeDeviceBearer, mintRequest, newDeviceId, parseAppOrigins, publicDevice, readDeviceToken,
  signDeviceToken,
} from "../ui/auth-device.mjs";

const SECRET = randomBytes(32).toString("hex");
const OTHER_SECRET = randomBytes(32).toString("hex");
const fileIn = (name = "devices.json") => path.join(mkdtempSync(path.join(tmpdir(), "devices-")), name);

// ---- the token -------------------------------------------------------------------------------

test("a device token carries the workspace, the person and the device, and verifies", () => {
  const now = 1_700_000_000_000;
  const { token, payload } = signDeviceToken({ tenant: "demo", sub: "acct_7", did: "dev_abc", nowMs: now }, SECRET);
  assert.ok(token.startsWith(DEVICE_TOKEN_PREFIX), `the prefix routes the verifier: ${token.slice(0, 12)}`);
  assert.equal(payload.kind, "device");
  assert.equal(payload.exp - payload.iat, DEVICE_TOKEN_TTL_MS, "thirty days");

  const read = readDeviceToken(token, SECRET, now + 1000);
  assert.equal(read.tenant, "demo");
  assert.equal(read.sub, "acct_7");
  assert.equal(read.did, "dev_abc");
  assert.equal(read.iat, now);
});

test("a token is dead on the wrong secret, an edited payload, a missing half and an expiry", () => {
  const now = 1_700_000_000_000;
  const { token } = signDeviceToken({ tenant: "demo", did: "dev_abc", nowMs: now }, SECRET);

  // Rotating the instance password writes a fresh cookie secret, which is the operator's one
  // revoke-everything lever. Every device token has to die with it.
  assert.equal(readDeviceToken(token, OTHER_SECRET, now), null, "a rotated secret kills every device token");

  const [prefix, body, signature] = [DEVICE_TOKEN_PREFIX, ...token.slice(DEVICE_TOKEN_PREFIX.length).split(".")];
  const edited = Buffer.from(JSON.stringify({ v: 1, kind: "device", tenant: "someone-else", did: "dev_abc", iat: now, exp: now + 1000 })).toString("base64url");
  assert.equal(readDeviceToken(`${prefix}${edited}.${signature}`, SECRET, now), null, "a re-signed claim is not a signature");

  assert.equal(readDeviceToken(`${prefix}${body}`, SECRET, now), null, "no signature at all");
  assert.equal(readDeviceToken(`${prefix}.${signature}`, SECRET, now), null, "no payload at all");
  assert.equal(readDeviceToken(token, SECRET, now + DEVICE_TOKEN_TTL_MS + 1), null, "a month in a drawer is dead");
  assert.equal(readDeviceToken(null, SECRET, now), null);
  assert.equal(readDeviceToken(token, "", now), null);
});

test("a cookie-shaped session, the operator bearer and a control plane token are not device tokens", () => {
  // The four credentials that reach this process have four shapes and the prefix is what keeps the
  // verifiers from being tried against each other.
  for (const other of ["v1.abc.def", "847feea9c8b5a9543140b227c075469730c1ba39b", "eyJhbGciOi.abc.def", ""]) {
    assert.equal(readDeviceToken(other, SECRET), null, other);
    assert.equal(looksLikeDeviceBearer(`Bearer ${other}`), false, other);
  }
  assert.equal(looksLikeDeviceBearer("Bearer tbd1.x.y"), true);
  assert.equal(looksLikeDeviceBearer("bearer tbd1.x.y"), true, "the scheme is case insensitive, as HTTP says");
  assert.equal(looksLikeDeviceBearer("tbd1.x.y"), false, "without the scheme it is not an Authorization value");
  assert.equal(deviceBearerOf("Bearer tbd1.x.y"), "tbd1.x.y");
  assert.equal(deviceBearerOf("Bearer something-else"), "");
  assert.equal(deviceBearerOf(undefined), "");
});

// ---- the rows --------------------------------------------------------------------------------

test("a row is written 0600, read back, and revoking it makes the token stop", () => {
  const file = fileIn();
  let clock = 1_000_000;
  const store = createDeviceStore(file, { now: () => clock, cacheMs: 0 });
  assert.deepEqual(store.all(), [], "no file is no devices, not an error");

  const row = store.upsert({ name: "Jason iPhone", platform: "ios", sub: "acct_7", tokenIat: clock });
  assert.equal(row.platform, "ios");
  assert.equal((statSync(file).mode & 0o777), 0o600, "a row file inside a customer's volume is 0600");

  assert.ok(store.live(row.id, clock) != null, "a fresh row is live");
  assert.equal(store.revoke(row.id, { sub: "acct_7" }), true);
  assert.equal(store.live(row.id, clock), null, "a revoked row answers no");
  assert.ok(store.all().find((one) => one.id === row.id)?.revokedAt != null,
    "the row STAYS, stamped: a person who revokes a phone wants to see that they did");
  assert.equal(store.revoke("dev_nothing"), false, "nothing to revoke is false, not a throw");
});

test("one person cannot revoke another's phone on a shared workspace", () => {
  // accounts.tenant has no UNIQUE constraint, so this is not hypothetical.
  const store = createDeviceStore(fileIn(), { cacheMs: 0 });
  const mine = store.upsert({ id: "dev_mine", name: "my phone", platform: "ios", sub: "acct_me" });
  const theirs = store.upsert({ id: "dev_theirs", name: "their phone", platform: "ios", sub: "acct_them" });
  assert.equal(store.revoke(theirs.id, { sub: "acct_me" }), false, "not mine, so not mine to revoke");
  assert.ok(store.live(theirs.id) != null);
  assert.equal(store.revoke(mine.id, { sub: "acct_me" }), true);
  assert.deepEqual(store.forSub("acct_me").map((one) => one.id), ["dev_mine"]);
  assert.deepEqual(store.forSub("acct_them").map((one) => one.id), ["dev_theirs"]);
  assert.deepEqual(store.forSub("").map((one) => one.id), [], "the workspace's own rows are a third list");
});

test("a re-mint refreshes the row and kills the token it replaced", () => {
  const file = fileIn();
  let clock = 5_000_000;
  const store = createDeviceStore(file, { now: () => clock, cacheMs: 0 });
  const first = store.upsert({ id: "dev_phone", name: "iPhone", platform: "ios", sub: "acct_7", tokenIat: clock });
  const firstIat = clock;

  clock += 60_000;
  const second = store.upsert({ id: "dev_phone", name: "iPhone", platform: "ios", sub: "acct_7", tokenIat: clock });
  assert.equal(second.id, first.id, "the same device is refreshed, not duplicated");
  assert.equal(store.all().length, 1);
  assert.equal(store.live(second.id, clock)?.id, second.id, "the new token works");
  // The whole reason tokenIat exists: a person re-mints BECAUSE a phone was stolen, and leaving the
  // stolen phone's token live for thirty days would make the re-mint worthless.
  assert.equal(store.live(second.id, firstIat), null, "and the one it replaced does not");
});

test("a re-mint on a revoked row brings it back, because a password is more than Revoke took away", () => {
  const store = createDeviceStore(fileIn(), { cacheMs: 0 });
  const row = store.upsert({ id: "dev_phone", name: "iPhone", platform: "ios", sub: "" });
  store.revoke(row.id);
  assert.equal(store.live(row.id), null);
  const again = store.upsert({ id: "dev_phone", name: "iPhone", platform: "ios", sub: "" });
  assert.ok(store.live(again.id) != null);
  assert.equal(store.all().find((one) => one.id === row.id).revokedAt, undefined);
});

test("twenty devices per person, the longest idle one falls off, and the other person is untouched", () => {
  let clock = 1_000;
  const store = createDeviceStore(fileIn(), { now: () => clock, cacheMs: 0 });
  store.upsert({ id: "dev_theirs", name: "theirs", platform: "ios", sub: "acct_them" });
  for (let i = 0; i < DEVICE_LIMIT; i += 1) {
    clock += 1000;
    store.upsert({ id: `dev_${String(i).padStart(3, "0")}`, name: `phone ${i}`, platform: "ios", sub: "acct_me" });
  }
  assert.equal(store.forSub("acct_me").length, DEVICE_LIMIT);
  clock += 1000;
  store.upsert({ id: "dev_new", name: "the new one", platform: "ios", sub: "acct_me" });
  const mine = store.forSub("acct_me").map((one) => one.id);
  assert.equal(mine.length, DEVICE_LIMIT);
  assert.equal(mine.includes("dev_000"), false, "the longest idle one is the one that goes");
  assert.equal(mine.includes("dev_new"), true);
  assert.equal(store.forSub("acct_them").length, 1, "the cap is per person: nobody can push another's phones off");
});

test("lastSeenAt is written at most once per ten minutes, so the hot path does not churn the disk", () => {
  const file = fileIn();
  let clock = 9_000_000;
  const store = createDeviceStore(file, { now: () => clock, cacheMs: 0 });
  const row = store.upsert({ id: "dev_phone", name: "iPhone", platform: "ios", sub: "" });
  assert.equal(store.touch(row.id), false, "just written, so nothing to write");
  clock += LAST_SEEN_WRITE_MS - 1;
  assert.equal(store.touch(row.id), false, "a second under the window is still nothing");
  clock += 2;
  assert.equal(store.touch(row.id), true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).devices[0].lastSeenAt, clock);
  assert.equal(store.touch("dev_nothing"), false);
});

test("a revoke lands within one cache window, and inside it the cached copy is served", async () => {
  const file = fileIn();
  const store = createDeviceStore(file, { cacheMs: DEVICE_CACHE_MS });
  const row = store.upsert({ id: "dev_phone", name: "iPhone", platform: "ios", sub: "" });
  assert.ok(store.live(row.id) != null);

  // A SECOND store over the same file is the shape that matters: the console's revoke and the phone's
  // next request are two different readers, and the cache is what decides how long they disagree.
  const other = createDeviceStore(file, { cacheMs: DEVICE_CACHE_MS });
  assert.ok(other.live(row.id) != null, "the second reader warms its cache");
  store.revoke(row.id);
  await new Promise((resolve) => setTimeout(resolve, DEVICE_CACHE_MS + 250));
  assert.equal(other.live(row.id), null, `a revoke bites within ${DEVICE_CACHE_MS} ms`);
});

test("a corrupt or half-written row file is no devices, never a throw", () => {
  for (const content of ["", "{", "null", "[]", '{"devices": "not an array"}', '{"devices": [null, 3]}']) {
    const file = fileIn();
    writeFileSync(file, content);
    const store = createDeviceStore(file, { cacheMs: 0 });
    assert.deepEqual(store.all(), [], JSON.stringify(content));
    // And it still takes a write, so one bad file is not a workspace that can never register a phone.
    assert.ok(store.upsert({ name: "iPhone", platform: "ios", sub: "" }).id.length > 0);
  }
});

test("nothing a person reads carries a token, and a name cannot smuggle a newline onto the page", () => {
  const store = createDeviceStore(fileIn(), { cacheMs: 0 });
  const row = store.upsert({ name: "Jason\r\niPhone ", platform: "IOS", sub: "acct_7" });
  assert.equal(row.name, "Jason iPhone", "control characters out, the name capped and trimmed");
  assert.equal(row.platform, "ios");
  assert.deepEqual(Object.keys(publicDevice(row)).sort(),
    ["createdAt", "id", "lastSeenAt", "name", "platform", "revokedAt"],
    "a token is answered once, at the mint, and never read back");
  assert.equal(cleanDeviceName(""), "a device");
  assert.equal(cleanDeviceName("x".repeat(200)).length, 64);
  assert.equal(cleanPlatform("windows"), "", "three platforms, and anything else is not one");
  assert.match(newDeviceId(), /^dev_[0-9a-f]{18}$/);
});

// ---- what /auth/token accepts -----------------------------------------------------------------

test("the mint body has three shapes and a bad one is a sentence rather than a throw", () => {
  assert.equal(mintRequest("not json").error, "body must be JSON");
  assert.equal(mintRequest("[]").error, "body must be a JSON object");
  const account = mintRequest(JSON.stringify({ email: " Me@Example.com ", password: "p", device: { id: "dev_x1", name: "iPhone", platform: "ios" } }));
  assert.equal(account.email, "Me@Example.com");
  assert.deepEqual(account.device, { id: "dev_x1", name: "iPhone", platform: "ios" });
  const instance = mintRequest(JSON.stringify({ password: "p" }));
  assert.equal(instance.email, "");
  assert.equal(instance.device.id, "", "no device is a fresh id, not a refusal");
  assert.equal(instance.device.name, "a device");
  const renew = mintRequest("{}");
  assert.equal(renew.password, "");
  // A device id is bookkeeping, not a credential, so a shape nobody can use is replaced rather than
  // refused: a mint that fails over a name is a customer who cannot sign in.
  assert.equal(mintRequest(JSON.stringify({ device: { id: "../../etc/passwd" } })).device.id, "");
  assert.equal(mintRequest(JSON.stringify({ device: "nope" })).device.name, "a device");
});

// ---- CORS ------------------------------------------------------------------------------------

test("the origin set is exact strings, and empty means the two Capacitor origins", () => {
  assert.deepEqual([...parseAppOrigins("")].sort(), ["capacitor://localhost", "https://localhost"]);
  assert.deepEqual([...parseAppOrigins("   ")].sort(), ["capacitor://localhost", "https://localhost"]);
  assert.deepEqual([...parseAppOrigins("titaniumbot://app")], ["titaniumbot://app"],
    "a third origin for the desktop shell is a config line, not a deploy");
  assert.deepEqual([...parseAppOrigins("capacitor://localhost, https://localhost")].sort(),
    ["capacitor://localhost", "https://localhost"]);
  // An Origin header is scheme://host[:port] and nothing else, so anything else would never match and
  // is better dropped than kept as a line somebody believes is working.
  for (const junk of ["https://localhost/", "localhost", "https://a b", "/", "*"]) {
    assert.equal(parseAppOrigins(junk).size, 0, junk);
  }
});

test("an allowed origin gets the headers, a near miss gets none, and nothing ever gets credentials", () => {
  const allowed = parseAppOrigins("");
  const ok = corsHeaders("capacitor://localhost", allowed);
  assert.equal(ok["access-control-allow-origin"], "capacitor://localhost", "the exact string, never a wildcard");
  assert.equal(ok.vary, "origin", "without vary a shared cache serves one origin's headers to another");
  assert.match(ok["access-control-allow-headers"], /authorization/);
  assert.match(ok["access-control-allow-methods"], /DELETE/);

  // SameSite=Strict IS this console's CSRF answer (ui/auth.mjs:151-153) and the cookie is never sent
  // cross-site anyway, so allowing credentials would buy a shell nothing and cost that.
  for (const headers of [ok, corsHeaders("https://localhost", allowed)]) {
    assert.equal(headers["access-control-allow-credentials"], undefined);
  }

  // A prefix match on https://localhost also matches this, which is exactly why it is exact strings.
  for (const liar of ["https://localhost.evil.example", "https://evil.example", "capacitor://localhost.evil", "null"]) {
    const refused = corsHeaders(liar, allowed);
    assert.equal(refused["access-control-allow-origin"], undefined, liar);
    assert.equal(refused.vary, "origin", "a refused origin still varies, or the cache makes it an allowed one");
  }
  assert.equal(corsHeaders("", allowed), null, "no Origin is not a CORS request at all");
  assert.equal(corsHeaders(undefined, allowed), null);
});

// ---- the mint's body, and the one spelling that used to fail silently --------------------------

test("the mint takes the device id under either of the two spellings this contract uses", () => {
  // THE DEFECT THIS PINS, found when the apps wave's three items were first in one tree. The mint
  // takes `device: {id}` and POST /push/devices takes a top-level `deviceId`, and docs/APPS.md tells a
  // shell to use the SAME stable id at both. A shell sending the push spelling at the mint was not
  // refused: it was given a bearer for a freshly minted id, so the bearer and the push row keyed on
  // different devices, and revoking the bearer left the push row behind, notifying a phone somebody
  // had signed out of. Nothing errored anywhere along that path.
  const nested = mintRequest(JSON.stringify({ password: "x", device: { id: "phone-in-a-pocket" } }));
  assert.equal(nested.device.id, "phone-in-a-pocket");

  const flat = mintRequest(JSON.stringify({ password: "x", deviceId: "phone-in-a-pocket" }));
  assert.equal(flat.device.id, "phone-in-a-pocket", "the push door's spelling names the same device here");

  // The nested one wins when both are sent, because it is the shape this door documents.
  const both = mintRequest(JSON.stringify({ password: "x", deviceId: "the-flat-one", device: { id: "the-nested-one" } }));
  assert.equal(both.device.id, "the-nested-one");

  // No id, and an id of the wrong shape, both come out EMPTY here rather than as a refusal: the
  // store mints a fresh one (`cleanId(id) || newDeviceId()`), because an id is bookkeeping and a
  // mint that fails over bookkeeping is a customer who cannot sign in.
  assert.equal(mintRequest(JSON.stringify({ password: "x" })).device.id, "");
  assert.equal(mintRequest(JSON.stringify({ password: "x", deviceId: "no" })).device.id, "",
    "three characters is not the shape, so the store will mint one");

  // A non-string in either place is empty, not a crash and not an object on the row.
  assert.equal(mintRequest(JSON.stringify({ password: "x", deviceId: { nope: true } })).device.id, "");
  assert.equal(mintRequest(JSON.stringify({ password: "x", device: { id: { nope: true } } })).device.id, "");
  // A one-element array stringifies to its element and so survives if the element is a valid id.
  // Recorded rather than guarded: what comes out is a well-formed id either way, and the store only
  // ever compares it as a string.
  assert.equal(mintRequest(JSON.stringify({ password: "x", device: { id: ["a-real-looking-id"] } })).device.id, "a-real-looking-id");
});
