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
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

// N=16384 keeps the derivation around 40 ms on this hardware and stays under node's default
// 32 MB scrypt maxmem (the cost is 128 * N * r = 16 MB), so no caller has to pass maxmem in.
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

const utf8 = (value) => Buffer.from(String(value), "utf8");

// A per-process key, so the digests below are not something an attacker can precompute against a
// guessed token. It never leaves this module and never has to survive a restart.
const EQUALITY_KEY = randomBytes(32);

// What safeEqual actually compares: a fixed-width keyed digest of the value, never the value. The
// width is why the comparison is constant time whatever the two inputs are.
export function comparableDigest(value) {
  return createHash("sha256").update(EQUALITY_KEY).update(utf8(value)).digest();
}

// Constant time, including in the LENGTH of the inputs. The old version returned false on a length
// mismatch before comparing anything, which is a fast path an attacker can time: probe /v1 with a
// 1-char bearer, then a 2-char one, and the length of the configured token falls out of the
// response times. Hashing both sides first makes every comparison the same 32 bytes of work, so the
// only thing the timing can say is "not equal", which the 401 already said.
export function safeEqual(a, b) {
  return timingSafeEqual(comparableDigest(a), comparableDigest(b));
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

// TENANT-5. One relay serves every workspace, so the cookie has to say which one this session is
// for. It is a claim inside the signed payload, not a second cookie: readSession already returns
// the whole payload, so nothing about the format, the signature or the lifetime changes.
//
// A cookie minted before this shipped carries no tenant claim and reads back as the operator, which
// is what keeps Jason signed in across the deploy. That is a property to be aware of rather than to
// rely on: rotating the cookie secret is what ends every old session at once.
//
// STORE-1. `sub` is the second claim, and it is WHICH PERSON rather than which workspace. It has to
// exist because accounts.tenant carries no UNIQUE constraint (cp/store.mjs): two people can share
// one workspace, and a device list, a push registration and a quiet-hours setting all belong to a
// person rather than to the workspace they happen to share. mintAccountSession is already holding a
// verified account id off the control plane's token and threw it away; this is the field it goes in.
//
// Absent reads back as the operator, exactly the way an absent tenant claim does, so a cookie minted
// before this deploy keeps working and a session from the INSTANCE password -- which is the machine's
// door and names no person -- carries none on purpose.
// SETTINGS-2 adds the third, `email`, and it is the same shape and the same argument as `sub`: it is
// already on the verified token the control plane hands back, mintAccountSession was already holding
// it and throwing it away, and the settings surface has to be able to draw "Signed in as" without
// asking the control plane a question on every page load.
//
// It is a DISPLAY claim and nothing keys on it. Every decision in this process reads `tenant` or
// `sub`; a forged email would change one line of text on the screen of somebody who already holds a
// valid signature over their own session. Absent -- an old cookie, or the instance-password door,
// which names no person -- draws no row at all rather than a blank one.
export function createSession(secretHex, { nowMs = Date.now(), lifetimeMs = SESSION_LIFETIME_MS, tenant = "", sub = "", email = "" } = {}) {
  const slug = String(tenant ?? "").trim();
  const who = String(sub ?? "").trim();
  const address = String(email ?? "").trim().slice(0, 254);
  return signSession({
    iat: nowMs, exp: nowMs + lifetimeMs,
    ...(slug.length > 0 ? { tenant: slug } : {}),
    ...(who.length > 0 ? { sub: who } : {}),
    ...(address.length > 0 ? { email: address } : {}),
  }, secretHex);
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

// ---- who is on the other end, when a proxy is in the way ---------------------------------------
//
// Published on a domain the relay stops talking to browsers directly: Cloudflare answers the name,
// Coolify's Traefik terminates the TLS, and what arrives at this process is a plain HTTP request
// from a container on a docker network. Every visitor then shares one socket address, so a lockout
// keyed on that address is one bucket for the whole internet and any stranger's five typos lock
// the operator out. The forwarded headers carry the real address, and they are also the easiest
// thing in the world to forge, so who is allowed to speak for a caller is settled in two steps:
// a peer the operator named may report an address at all, and only an address inside a second
// named set may go on to hand over a CF-Connecting-IP. edgeAddress and clientAddress below are
// those two steps, and the long comment on clientAddress is the reason for the second one.
//
// A parsed address is bytes plus a family. ::ffff:10.0.2.5 is folded to 10.0.2.5's four bytes
// because node hands a dual stack listener the mapped spelling, and one host must not be inside a
// range under one spelling and outside it under the other.

function v4Bytes(text) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return null;
  const parts = text.split(".").map(Number);
  return parts.every((n) => n <= 255) ? Uint8Array.from(parts) : null;
}

function v6Bytes(text) {
  let rest = text;
  let trailing = new Uint8Array(0);
  // The dotted tail form, which is how a v4 mapped address is written.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(rest);
  if (dotted != null) {
    const four = v4Bytes(dotted[1]);
    if (four == null) return null;
    trailing = four;
    rest = rest.slice(0, rest.length - dotted[1].length);
    if (!rest.endsWith(":")) return null;
    rest = rest.slice(0, -1);
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const groups = (chunk) => (chunk.length === 0 ? [] : chunk.split(":").map(
    (g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN)));
  const left = groups(halves[0] ?? "");
  const right = halves.length === 2 ? groups(halves[1]) : [];
  if ([...left, ...right].some(Number.isNaN)) return null;
  const written = (left.length + right.length) * 2 + trailing.length;
  if (written > 16) return null;
  const gap = 16 - written;
  // Without a "::" every group has to be written out, so a short address is not an address.
  if (halves.length === 1 && gap !== 0) return null;
  const out = new Uint8Array(16);
  let at = 0;
  const put = (group) => { out[at] = group >> 8; out[at + 1] = group & 255; at += 2; };
  for (const group of left) put(group);
  at += gap;
  for (const group of right) put(group);
  out.set(trailing, at);
  return out;
}

// null for anything that is not an address, which is the answer every caller here wants: an
// unparseable value is never trusted and never becomes a range.
export function parseAddress(value) {
  const text = String(value ?? "").trim().toLowerCase()
    .replace(/^\[/, "").replace(/\]$/, "")
    // A link local address can carry a zone, "fe80::1%eth0", and the zone is not part of the host.
    .replace(/%.*$/, "");
  if (text.length === 0) return null;
  const four = v4Bytes(text);
  if (four != null) return { bits: 32, bytes: four };
  if (!text.includes(":")) return null;
  const sixteen = v6Bytes(text);
  if (sixteen == null) return null;
  const mapped = sixteen.subarray(0, 12).every((byte, i) => (i < 10 ? byte === 0 : byte === 255));
  return mapped ? { bits: 32, bytes: sixteen.slice(12) } : { bits: 128, bytes: sixteen };
}

const inNetwork = (address, range) => {
  if (address.bits !== range.bits) return false;
  const whole = range.prefix >> 3;
  for (let i = 0; i < whole; i += 1) if (address.bytes[i] !== range.bytes[i]) return false;
  const spare = range.prefix & 7;
  if (spare === 0) return true;
  const mask = (0xff << (8 - spare)) & 0xff;
  return (address.bytes[whole] & mask) === (range.bytes[whole] & mask);
};

// A comma list of CIDRs, or the single word "any". Empty means trust nothing, which is the default
// and is today's behaviour: the socket address is the client and no header is read at all.
//
// An entry that does not parse is DROPPED rather than thrown, and `ignored` reports it, because
// the failure direction matters: a typo leaves the relay trusting less, which costs a shared
// lockout bucket, where throwing would take the console down over a stray character in an env var.
export function parseTrustedProxies(spec) {
  const entries = String(spec ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.some((entry) => entry.toLowerCase() === "any")) return { any: true, ranges: [], ignored: [] };
  const ranges = [];
  const ignored = [];
  for (const entry of entries) {
    const cut = entry.lastIndexOf("/");
    const address = parseAddress(cut === -1 ? entry : entry.slice(0, cut));
    if (address == null) { ignored.push(entry); continue; }
    const prefix = cut === -1 ? address.bits : Number(entry.slice(cut + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) { ignored.push(entry); continue; }
    ranges.push({ ...address, prefix });
  }
  return { any: false, ranges, ignored };
}

// ---- a customer's box is never a proxy --------------------------------------------------------
//
// SAND_UI_TRUSTED_PROXIES and CP_TRUSTED_PROXIES name the docker private ranges, because Coolify
// allocates a fresh network per resource and its address is not knowable in advance. Under
// TENANT-2 the only peers in those ranges were Traefik and the operator's own box, which is what
// that reasoning rests on. TENANT-5 put EVERY customer's box on a network with the relay and the
// control plane, so every customer's agents are now inside a trusted range and can write their own
// X-Forwarded-For: the login lockout is keyed on that value, so it stops bounding guessing from
// inside a box, and it can be aimed at the operator's own address to hold him out of the console
// and the job bus. Measured from a tenant's box on the R750, 2026-09-07: a request to the relay
// carrying X-Forwarded-Proto: https came back with HSTS, and two wrong-password POSTs with forged
// X-Forwarded-For values were logged and counted against the addresses the box chose.
//
// Narrowing the ranges cannot fix it: the relay's own Traefik pin is titanbot-net (see
// deploy/coolify/docker-compose.yml), so the proxy reaches the relay from the same subnet the
// boxes are on, and a subnet that keeps the proxy keeps the boxes.
//
// So the rule is written where it is actually true: an address that belongs to a BOX is never a
// proxy, whatever the ranges say. The names are already known -- the registry carries one per
// tenant and the control plane's ledger carries box_container -- and docker's own resolver turns a
// container name into the address that container reaches us from. A set that could not be
// refreshed keeps its last value rather than emptying, for the same reason the box-name sweep does.
export function createBoxPeers({ lookup = null, log = () => {} } = {}) {
  // Compared as ADDRESSES, never as strings. A dual stack listener reports an IPv4 peer as
  // "::ffff:192.168.48.6" while docker's resolver answers "192.168.48.6", and a set keyed on the
  // text would miss on exactly the deployment this exists for. parseAddress already folds the two
  // spellings onto the same bytes, which is why the trusted ranges match under both.
  const key = (value) => {
    const parsed = parseAddress(value);
    if (parsed == null) return `raw:${String(value ?? "").trim().toLowerCase()}`;
    return `${parsed.bits}:${Array.from(parsed.bytes).join(".")}`;
  };
  let peers = new Set();
  return {
    has(address) { return peers.has(key(address)); },
    size() { return peers.size; },
    all() { return [...peers]; },
    /** names: the container names to resolve. Returns the number of addresses now held. */
    async refresh(names) {
      if (typeof lookup !== "function") return peers.size;
      const wanted = [...new Set([...names].map((name) => String(name ?? "")).filter((name) => name.length > 0))];
      if (wanted.length === 0) { peers = new Set(); return 0; }
      const found = new Set();
      let asked = 0;
      for (const name of wanted) {
        let addresses = null;
        try { addresses = await lookup(name); } catch { addresses = null; }
        if (addresses == null) continue;
        asked += 1;
        for (const address of addresses) {
          if (String(address ?? "").trim().length > 0) found.add(key(address));
        }
      }
      // Nothing resolved at all is "the resolver could not be asked", not "there are no boxes".
      if (asked === 0) return peers.size;
      if (found.size !== peers.size || [...found].some((one) => !peers.has(one))) {
        log(`peer ${found.size} box address(es) are held untrusted as forwarders`);
      }
      peers = found;
      return peers.size;
    },
  };
}

// Every address docker's resolver gives for a container name. Injected as `lookup` above so the
// set can be tested with no docker and no network.
export function containerAddressLookup(dns) {
  return async (name) => {
    const answers = await dns.lookup(name, { all: true, family: 0 });
    return answers.map((answer) => String(answer.address ?? "")).filter((address) => address.length > 0);
  };
}

export function isTrustedProxy(address, trusted) {
  if (trusted == null) return false;
  if (trusted.any === true) return true;
  const parsed = parseAddress(address);
  if (parsed == null) return false;
  return (trusted.ranges ?? []).some((range) => inNetwork(parsed, range));
}

// One hop of a forwarded list, parsed, or null. Bounded on purpose: a header is a value the
// caller writes, and an unbounded one would become an unbounded key in the lockout's map.
function forwardedAddress(text) {
  const hop = String(text ?? "").trim();
  if (hop.length === 0 || hop.length > 64) return null;
  const candidates = [hop];
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(hop);
  if (bracketed != null) candidates.push(bracketed[1]);
  const withPort = /^([\d.]+):\d+$/.exec(hop);
  if (withPort != null) candidates.push(withPort[1]);
  for (const candidate of candidates) if (parseAddress(candidate) != null) return candidate.toLowerCase();
  return null;
}

// The LAST hop of X-Forwarded-For, which is the one the proxy itself wrote.
//
// Which end of that list to read is the entire security question here, so it was measured rather
// than reasoned about. Traefik v3.6 with no forwardedHeaders setting -- which is exactly how
// Coolify runs it -- REPLACES X-Forwarded-For with the address it actually saw: a request sent
// with "X-Forwarded-For: 1.2.3.4, 5.6.7.8, 9.9.9.9" arrived at the backend as a single hop that
// was the sender's own address, and the forged list was gone. A proxy that appends instead, which
// is nginx's proxy_add_x_forwarded_for, puts that same real address last. Under both shapes the
// last hop is the proxy's own observation and everything before it is whatever the caller typed,
// so the last hop is read and the rest are thrown away.
function lastForwardedHop(value) {
  const hops = String(value ?? "").split(",");
  return forwardedAddress(hops[hops.length - 1]);
}

// Secure only when the connection really is TLS, or when a proxy the operator trusts says it was.
// X-Forwarded-Proto from anyone else is ignored: on its own the flag only ever ADDS Secure, but
// the same signal now also decides whether this response carries HSTS, and a stranger must not be
// able to make a browser refuse plain HTTP to this host. Traefik rewrites this header too, from
// the entrypoint the request actually landed on: a forged "https" over a plain connection came out
// the far side as "http".
export function isSecureRequest(req, trusted = null) {
  if (req?.socket?.encrypted === true) return true;
  if (!isTrustedProxy(sourceAddress(req), trusted)) return false;
  const forwarded = String(req?.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  return forwarded === "https";
}

// The socket address, always, whatever any header says.
export function sourceAddress(req) {
  return String(req?.socket?.remoteAddress ?? "unknown");
}

// The address this process can be certain of: what a trusted proxy observed, and otherwise the
// socket. No value a caller can write reaches it, which is what makes it safe to key a lockout on.
export function edgeAddress(req, trusted = null) {
  const peer = sourceAddress(req);
  if (!isTrustedProxy(peer, trusted)) return peer;
  return lastForwardedHop(req?.headers?.["x-forwarded-for"]) ?? peer;
}

// Who to count a login failure against.
//
// CF-Connecting-IP is deliberately NOT read just because the peer is a trusted proxy, and getting
// that one condition wrong is the difference between a lock and a doorbell. Traefik rewrites the
// X-Forwarded-* family but passes CF-Connecting-IP through byte for byte, because it is not one of
// those names. Believing it from any proxy therefore means believing anyone at all: the origin
// address behind a proxied name is published in certificate transparency and shared with every
// other site on the same host, so a guesser reaches it directly, rotates the header, and is never
// counted twice. That is unlimited password attempts on a console whose password is the only lock.
//
// So it is read only when the edge address -- the one that cannot be forged -- is itself inside a
// range the operator named in SAND_UI_CLOUDFLARE_RANGES. On that path Cloudflare overwrote the
// header with the visitor it is talking to, so the header is Cloudflare speaking rather than the
// caller. Off that path, including a request aimed straight at the origin, the client is the edge
// address, which for that request is the sender's own.
//
// What is left is the limit every per-address lockout has: someone with many source addresses gets
// one bucket per address. A cap that ignored the address would bound that, and would also let any
// stranger lock the operator out by burning it, which is the failure this whole file exists to
// avoid. The password carries that weight.
export function clientAddress(req, trusted = null, cloudflare = null) {
  const edge = edgeAddress(req, trusted);
  if (!isTrustedProxy(edge, cloudflare)) return edge;
  return forwardedAddress(String(req?.headers?.["cf-connecting-ip"] ?? "").split(",")[0]) ?? edge;
}

// The addresses that are not somewhere else.
//
// A tenant console lets a customer save a provider endpoint and the relay then fetches it to say
// whether it is up. Left open, that is a request generator inside the private network, with a
// bearer the customer chose and the answer -- status, latency, model list -- handed straight back
// to them: a working port scan of the machine every other customer is on. So on a tenant the
// address a base URL resolves to has to be somewhere on the public internet, and this list is what
// "somewhere else" means.
//
// It is deliberately wider than RFC1918. 100.64/10 is carrier NAT and is also every tailnet
// address; 169.254/16 is the link local range that holds cloud metadata services; 0.0.0.0/8 and
// the v6 unspecified address reach the local host on several stacks. A range that is arguable is
// in, because the cost of blocking one is a customer who cannot health-check an endpoint they
// could not reach from their laptop either.
const PRIVATE_RANGES = parseTrustedProxies([
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
  "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  "::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8",
].join(","));

// True for an address inside any of those, false for a public one AND for anything that is not an
// address at all. The caller resolves a name to addresses first: a name is not something this can
// answer about, and answering "not private" for a name would be the wrong direction to fail.
export function isPrivateAddress(value) {
  return isTrustedProxy(value, PRIVATE_RANGES);
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
