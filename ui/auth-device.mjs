// ui/auth-device.mjs -- the token door. A phone or desktop shell's credential for this relay.
//
// STORE-1's server half. Jason, 2026-09-09 22:21: "I don't want to do a PWA phone app. I want to do
// a real phone app wrapper installed in the iOS App Store." A store app bundles its own assets, so
// its page origin is capacitor://localhost or https://localhost, not console.titanium.bot -- and
// the console's whole credential is a cookie set `HttpOnly; SameSite=Strict` (ui/auth.mjs:149-157),
// which a browser NEVER sends from a cross-site origin. Measured on grok-bot-local-vm 2026-09-09: a
// cross-site iframe of / got the login page, not the console. So a shell needs a credential it can
// put in a header itself, and that is all this file is.
//
// FIVE RULES THIS FILE IS WRITTEN UNDER, each of which is a decision that was made once.
//
// 1. A DEVICE BEARER CAN DO NO MORE THAN THE COOKIE, AND STRICTLY LESS. It is one new arm in
//    tenantOf and nothing else. It never mints a cookie (mintSessionFromBearer returns early for
//    it), it never opens /v1 (the job bus keeps its own token and the two doors never see each
//    other's credential), and it cannot open the websocket upgrade because a browser WebSocket
//    carries no header. A phone therefore gets no live screen by construction as well as by design.
//
// 2. REVOCATION IS A SIGNED TOKEN PLUS A ROW ON DISK, AND IT CANNOT BE ANYTHING ELSE.
//    ui/session-token.mjs:133-140 forbids the relay calling the control plane to validate anything,
//    ui/tenant-login.mjs's third rule says the control plane is allowed to be down, and
//    ui/auth.mjs:63-68 records that a redeploy restarts the relay -- which is why a session is a
//    signed payload rather than a table. A device token is the same signed payload PLUS a row in the
//    tenant's own state directory, because "revoke this one device" is the thing a signature alone
//    cannot express. The row is read through an mtime-gated cache so the hot path does no file read
//    per request, and the cache window is what bounds how long a revoked device keeps working.
//
// 3. THE SECRET IS THE COOKIE SECRET, DELIBERATELY. Rotating the instance password writes a fresh
//    cookie secret (set-password.mjs), which therefore kills every device token at once as well as
//    every session. That is the contract the cookie already has, it is the only revoke-everything
//    lever the operator has when something is wrong, and docs/APPS.md states it so an app author is
//    not surprised by it.
//
// 4. A FAILED MINT CHARGES THE PASSWORD LOCKOUT; A FAILED USE DOES NOT. A mint is a password guess
//    and is counted as one. A use is an app with a stale token, and an app looping on one would
//    otherwise spend the shared throttle and lock the customer out of his own laptop's console AND
//    the job bus, which share that object. So a bad bearer gets its own fixed-window limiter and a
//    401 the app can branch on. docs/APPS.md states the app's obligation: stop, re-mint once, then
//    ask the person, never loop.
//
// 5. A TOKEN NEVER RIDES IN A URL. No events ticket, no query-string credential, no token in a log
//    line. /events is read with fetch plus a stream reader and images are fetched with the bearer
//    and turned into blob URLs, because EventSource and <img> cannot carry a header. That is the
//    shells' obligation and it is in docs/APPS.md, and nothing here accepts a token from a URL.
//
// Nothing here imports anything outside node builtins, because the relay image has no node_modules.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---- the shape -------------------------------------------------------------------------------
//
// tbd1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, the payload segment))>
//
// "tbd1" rather than "v1": the control plane's own session token is `v1.` (ui/session-token.mjs),
// the operator's gateway token is 64 hex, and a job bus token is 48 hex. Four credentials reach this
// process and a prefix nobody else uses is what lets tenantOf route on the first five characters
// instead of trying every verifier on every request.
export const DEVICE_TOKEN_PREFIX = "tbd1.";
// Thirty days. Long enough that an app in weekly use never meets a password prompt, short enough
// that a phone left in a drawer for a month is dead rather than a standing key.
export const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A person gets twenty devices and the longest idle one falls off. Unbounded it is a file that grows
// every time an app reinstalls and a read that gets slower forever.
export const DEVICE_LIMIT = 20;
// lastSeenAt is a nice thing to show a person and a terrible thing to write on every request. Ten
// minutes per device means a busy app writes the file six times an hour rather than six times a
// second, and the number on screen is still honest to the minute.
export const LAST_SEEN_WRITE_MS = 10 * 60_000;
// How long a revoke can take to bite. Two seconds is a value judgement: a file stat per request is
// cheap but not free, and an app that is mid-poll when a person presses Revoke stopping within two
// seconds is indistinguishable from instant to the person pressing it.
export const DEVICE_CACHE_MS = 2_000;

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const mac = (body, secretHex) =>
  createHmac("sha256", Buffer.from(secretHex, "hex")).update(body).digest("base64url");

// Constant time over both the value and the LENGTH, the same compare ui/auth.mjs:safeEqual makes and
// for the same reason: a length-first early return is a fast path an attacker can time.
const EQUALITY_KEY = randomBytes(32);
const digest = (value) => createHash("sha256").update(EQUALITY_KEY).update(Buffer.from(String(value), "utf8")).digest();
const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

// A device id the caller did not choose. An app MAY send its own (a keychain value that survives a
// reinstall is the point of letting it), and anything that is not this shape is replaced rather than
// refused, because an id is bookkeeping and not a credential.
export const newDeviceId = () => `dev_${randomBytes(9).toString("hex")}`;
const DEVICE_ID = /^[A-Za-z0-9_.:-]{4,64}$/;
const cleanId = (value) => {
  const text = String(value ?? "").trim();
  return DEVICE_ID.test(text) ? text : "";
};

// What a person reads in the device list, so it is capped and stripped of control characters. The
// name comes from an app and lands on a console page; escaping is the page's job, and a newline in
// the middle of a name is nobody's.
export const cleanDeviceName = (value, fallback = "a device") => {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 64);
  return text.length > 0 ? text : fallback;
};

export const PLATFORMS = new Set(["ios", "android", "desktop"]);
export const cleanPlatform = (value) => {
  const text = String(value ?? "").trim().toLowerCase();
  return PLATFORMS.has(text) ? text : "";
};

/**
 * Signs a device token. `tenant` is the workspace, `sub` the person (empty means the operator, the
 * same way an absent claim does everywhere else in this console), `did` the device row's id.
 */
export function signDeviceToken({ tenant, sub = "", did, nowMs = Date.now(), lifetimeMs = DEVICE_TOKEN_TTL_MS }, secretHex) {
  const payload = {
    v: 1, kind: "device",
    tenant: String(tenant ?? ""),
    ...(String(sub ?? "").length > 0 ? { sub: String(sub) } : {}),
    did: String(did ?? ""),
    iat: nowMs, exp: nowMs + lifetimeMs,
  };
  const body = b64url(JSON.stringify(payload));
  return { token: `${DEVICE_TOKEN_PREFIX}${body}.${mac(body, secretHex)}`, payload };
}

/**
 * The payload of a live device token, or null for anything else: wrong prefix, wrong secret, edited
 * payload, expired, missing a field. Callers get the payload rather than a boolean because the
 * tenant, the person and the device row all come out of it.
 *
 * This checks the SIGNATURE and the CLOCK and nothing else. Whether the device row still exists is
 * a separate question with a separate answer on disk, and keeping the two apart is what lets a test
 * prove each of them.
 */
export function readDeviceToken(token, secretHex, nowMs = Date.now()) {
  if (typeof token !== "string" || typeof secretHex !== "string" || secretHex.length === 0) return null;
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const rest = token.slice(DEVICE_TOKEN_PREFIX.length);
  const cut = rest.indexOf(".");
  if (cut <= 0 || cut === rest.length - 1) return null;
  const body = rest.slice(0, cut);
  const signature = rest.slice(cut + 1);
  if (!safeEqual(signature, mac(body, secretHex))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { return null; }
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.kind !== "device" || payload.v !== 1) return null;
  if (typeof payload.tenant !== "string" || payload.tenant.length === 0) return null;
  if (typeof payload.did !== "string" || payload.did.length === 0) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= nowMs) return null;
  if (!Number.isFinite(payload.iat)) return null;
  return payload;
}

/** Is this header value shaped like a device bearer at all? The routing question, before any crypto. */
export function looksLikeDeviceBearer(authorizationHeader) {
  const header = String(authorizationHeader ?? "");
  if (!/^bearer\s/i.test(header)) return false;
  return header.replace(/^bearer\s+/i, "").trim().startsWith(DEVICE_TOKEN_PREFIX);
}

/** The token out of an Authorization header, or "" -- so no caller does the slicing by hand. */
export function deviceBearerOf(authorizationHeader) {
  const header = String(authorizationHeader ?? "");
  if (!/^bearer\s/i.test(header)) return "";
  const value = header.replace(/^bearer\s+/i, "").trim();
  return value.startsWith(DEVICE_TOKEN_PREFIX) ? value : "";
}

// ---- the rows on disk ------------------------------------------------------------------------
//
// devices.json beside mail.json in the tenant's own state directory, through the t.file() helper the
// relay already splits endpoints.json, subscriptions.json, mail.json and the two mail ledgers with.
// There is deliberately NO cp/devices.mjs: a device row is read on the hot path of every /api call a
// phone makes, and the control plane is allowed to be down.
//
// The file is {version, devices: [...]}, and a row is
//   {id, name, platform, sub, createdAt, lastSeenAt, revokedAt, tokenIat}
// tokenIat is the iat of the newest token minted for this row, and it is what makes a re-mint
// invalidate the token it replaced: a token whose iat is older than the row's is not this device's
// current credential. Without it, a person who re-mints because a phone was stolen would leave the
// stolen phone's token live for thirty days.

const EMPTY = { version: 1, devices: [] };

function readFileJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed == null || typeof parsed !== "object" || !Array.isArray(parsed.devices)) return { ...EMPTY };
    return { version: 1, devices: parsed.devices.filter((row) => row != null && typeof row === "object") };
  } catch { return { ...EMPTY }; }
}

// 0600 and owned like its directory, the same two properties every other file this relay writes into
// a bind mount has: a root-owned row file inside a customer's volume was unreadable to the
// operator's own backup on the R750 (2026-09-06), which is the bug ownLikeParent exists for. The
// write is a rename over a temp file in the same directory, so a reader never sees half a file.
function writeFileJson(file, value, { own = null } = {}) {
  try { mkdirSync(path.dirname(file), { recursive: true }); } catch { /* already there */ }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(temp, 0o600); } catch { /* some filesystems do not */ }
  renameSync(temp, file);
  if (own != null) { try { own(file); } catch { /* not root, or the same user */ } }
}

/**
 * The store for one tenant's devices.json, with the mtime gate on the read.
 *
 * `file` is a path, not a handle, because a tenant's state directory is made by the provisioner and
 * may not exist when this is constructed. Every read tolerates a missing file as "no devices", which
 * is also the honest answer for a workspace whose first app has not signed in yet.
 */
export function createDeviceStore(file, { now = () => Date.now(), cacheMs = DEVICE_CACHE_MS, own = null } = {}) {
  let cached = null;
  let cachedAt = 0;
  let cachedMtime = -1;

  const statMtime = () => { try { return statSync(file).mtimeMs; } catch { return -1; } };

  // Inside the window, the cached copy. Past it, one stat: an unchanged mtime re-arms the window
  // without a read, and a changed one re-reads. So a busy phone costs one stat every two seconds and
  // a revoke from the console is seen on the first request after it lands.
  const load = () => {
    const at = now();
    if (cached != null && at - cachedAt < cacheMs) return cached;
    const mtime = statMtime();
    if (cached != null && mtime === cachedMtime) { cachedAt = at; return cached; }
    cached = readFileJson(file);
    cachedMtime = mtime;
    cachedAt = at;
    return cached;
  };

  const save = (value) => {
    writeFileJson(file, value, { own });
    cached = value;
    cachedMtime = statMtime();
    cachedAt = now();
  };

  return {
    file,
    /** Every row, including revoked ones: the console shows a revoked device as revoked. */
    all: () => load().devices.map((row) => ({ ...row })),
    /** One person's rows. "" means the workspace's own -- the operator, or an instance-password session. */
    forSub(sub = "") {
      const who = String(sub ?? "");
      return load().devices.filter((row) => String(row.sub ?? "") === who).map((row) => ({ ...row }));
    },
    /** The live row for an id, or null: missing, or revoked, or holding a newer token than the one presented. */
    live(id, tokenIat = null) {
      const row = load().devices.find((one) => String(one.id) === String(id));
      if (row == null) return null;
      if (row.revokedAt != null) return null;
      // A re-mint bumps tokenIat, so an older token is the PREVIOUS credential for this device and
      // is not live. Rows written before this field existed have none and are taken at their word.
      if (tokenIat != null && Number.isFinite(row.tokenIat) && Number(tokenIat) < Number(row.tokenIat)) return null;
      return { ...row };
    },
    /**
     * Mint-or-refresh. Answers the row as it now stands. `id` may be an app's own value; a row that
     * exists under that id for THIS person is refreshed rather than duplicated, which is what makes
     * a silent re-mint a re-mint and not a twenty-first device.
     */
    upsert({ id = "", name = "", platform = "", sub = "", tokenIat = now() } = {}) {
      const state = load();
      const devices = state.devices.map((row) => ({ ...row }));
      const who = String(sub ?? "");
      const wanted = cleanId(id) || newDeviceId();
      const found = devices.findIndex((row) => String(row.id) === wanted && String(row.sub ?? "") === who);
      const at = now();
      const row = found >= 0 ? devices[found] : { id: wanted, sub: who, createdAt: at };
      row.name = cleanDeviceName(name, row.name ?? "a device");
      row.platform = cleanPlatform(platform) || row.platform || "desktop";
      row.sub = who;
      row.createdAt = Number.isFinite(row.createdAt) ? row.createdAt : at;
      row.lastSeenAt = at;
      row.tokenIat = tokenIat;
      // A re-mint on a revoked row un-revokes it: the person just proved they hold the password or a
      // live bearer, which is strictly more than Revoke took away.
      delete row.revokedAt;
      if (found >= 0) devices[found] = row; else devices.push(row);
      // The cap is per person, not per workspace: two people sharing a workspace must not be able to
      // push each other's phones off the list.
      const mine = devices.filter((one) => String(one.sub ?? "") === who);
      if (mine.length > DEVICE_LIMIT) {
        const idle = mine.filter((one) => one.id !== row.id)
          .sort((a, b) => Number(a.lastSeenAt ?? 0) - Number(b.lastSeenAt ?? 0));
        const drop = new Set(idle.slice(0, mine.length - DEVICE_LIMIT).map((one) => one.id));
        save({ version: 1, devices: devices.filter((one) => !(drop.has(one.id) && String(one.sub ?? "") === who)) });
        return { ...row, dropped: [...drop] };
      }
      save({ version: 1, devices });
      return { ...row, dropped: [] };
    },
    /**
     * Revoke. True when a row was there to revoke. The row STAYS, stamped: a person who revokes a
     * phone wants to see that they did, and a row that vanishes reads as a device that was never
     * there.
     */
    revoke(id, { sub = null } = {}) {
      const state = load();
      const devices = state.devices.map((row) => ({ ...row }));
      const found = devices.findIndex((row) => String(row.id) === String(id)
        && (sub == null || String(row.sub ?? "") === String(sub)));
      if (found < 0) return false;
      if (devices[found].revokedAt != null) return true;
      devices[found].revokedAt = now();
      save({ version: 1, devices });
      return true;
    },
    /** Every row for a person, revoked at once. What account deletion calls. */
    revokeAll({ sub = null } = {}) {
      const state = load();
      const devices = state.devices.map((row) => ({ ...row }));
      let count = 0;
      for (const row of devices) {
        if (sub != null && String(row.sub ?? "") !== String(sub)) continue;
        if (row.revokedAt != null) continue;
        row.revokedAt = now();
        count += 1;
      }
      if (count > 0) save({ version: 1, devices });
      return count;
    },
    /**
     * lastSeenAt, at most once per device per LAST_SEEN_WRITE_MS. It answers whether it wrote so a
     * caller can say so; the hot path ignores the answer.
     */
    touch(id) {
      const state = load();
      const row = state.devices.find((one) => String(one.id) === String(id));
      if (row == null) return false;
      const at = now();
      if (Number.isFinite(row.lastSeenAt) && at - Number(row.lastSeenAt) < LAST_SEEN_WRITE_MS) return false;
      const devices = state.devices.map((one) => (String(one.id) === String(id) ? { ...one, lastSeenAt: at } : { ...one }));
      save({ version: 1, devices });
      return true;
    },
  };
}

/** What a console page or the CLI is given. No token, ever: a token is answered once, at the mint. */
export const publicDevice = (row) => ({
  id: String(row?.id ?? ""),
  name: String(row?.name ?? ""),
  platform: String(row?.platform ?? ""),
  createdAt: Number(row?.createdAt ?? 0) || null,
  lastSeenAt: Number(row?.lastSeenAt ?? 0) || null,
  revokedAt: Number(row?.revokedAt ?? 0) || null,
});

// ---- what /auth/token accepts ------------------------------------------------------------------

export const MINT_BODY_LIMIT = 8 * 1024;

/**
 * The body, shaped, or an error sentence. Three valid shapes and nothing else:
 *
 *   {email, password, device:{...}}   an account sign-in from an app
 *   {password, device:{...}}          the instance password, the operator's door
 *   {device:{...}}                    a silent re-mint, when the request carries a live bearer
 *
 * The device object is optional in every one of them: an app that sends none gets a fresh id and the
 * name "a device", because refusing a mint over bookkeeping is worse than a row with a dull name.
 */
export function mintRequest(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw ?? "").trim().length > 0 ? raw : "{}"); }
  catch { return { error: "body must be JSON" }; }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "body must be a JSON object" };
  const device = parsed.device != null && typeof parsed.device === "object" && !Array.isArray(parsed.device) ? parsed.device : {};
  return {
    email: String(parsed.email ?? "").trim(),
    password: String(parsed.password ?? ""),
    device: {
      // `device.id` OR a top-level `deviceId`, because the two doors of this same contract spell it
      // differently: the mint takes `device: {id}` and POST /push/devices takes `deviceId`, and a
      // shell is told to use the same stable id at both. Sending the push spelling here used to mint a
      // bearer for a FRESH id instead of refusing, so the bearer and the push row keyed on different
      // devices and revoking the bearer left the push row behind, notifying a phone somebody had
      // signed out of. Silent, and only visible as a notification nobody could stop. Accepting both
      // spellings is a tolerance, not a second API: the answer still names the id it used.
      id: cleanId(device.id ?? parsed.deviceId),
      name: cleanDeviceName(device.name),
      platform: cleanPlatform(device.platform),
    },
  };
}

// ---- CORS, because a bundled shell is cross-origin ---------------------------------------------
//
// THREE PROPERTIES, each of which is a decision and not a default.
//
// An EXACT-STRING set. Never a reflected Origin, never a prefix, never a regex. A reflected Origin
// with credentials is the whole-internet hole; a prefix match on "https://localhost" also matches
// "https://localhost.evil.example"; and a regex is how a third author later widens one by accident.
//
// NO Access-Control-Allow-Credentials, EVER. Measured: the cookie is SameSite=Strict and a browser
// never sends it from a cross-site origin, so allowing credentials buys a shell exactly nothing --
// and it would trade away this console's entire CSRF answer, which ui/auth.mjs:151-153 says out loud
// IS SameSite=Strict. The bearer is the mechanism. There is no second one.
//
// AN ALLOWED ORIGIN IS NEVER A REQUIREMENT. A native HTTP client sends no Origin at all, so the
// allow-list decides only which access-control headers come BACK. A request with no Origin, or with
// one nobody named, is answered exactly as it is today: the bearer still works, the browser simply
// will not hand the answer to a page on that origin. That is the browser's rule and not ours.

// capacitor://localhost is what a Capacitor iOS web view calls itself; https://localhost is the
// Android one. A third origin for the desktop shell is a config line, which is why the env exists.
export const DEFAULT_APP_ORIGINS = ["capacitor://localhost", "https://localhost"];

export function parseAppOrigins(value, { fallback = DEFAULT_APP_ORIGINS } = {}) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return new Set(fallback);
  const out = new Set();
  for (const part of text.split(",")) {
    const one = part.trim();
    // No trailing slash and no path: an Origin header is scheme://host[:port] and nothing else, so a
    // value that is not that shape would never match anything and is better dropped loudly than
    // kept as a line somebody believes is working.
    if (one.length === 0 || one.length > 200 || one.endsWith("/") || /\s/.test(one)) continue;
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(one)) continue;
    out.add(one);
  }
  return out;
}

export const CORS_ALLOW_HEADERS = "authorization, content-type, x-titan-projection, x-titan-if-digest";
export const CORS_ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
// x-titan-digest IS ON THIS LINE FOR A REASON, and it was missing from it until the review pass.
// Only the names listed here are readable by cross-origin JavaScript: everything else is dropped by
// the browser before the page sees it, with no error anywhere. Measured in real Chrome on this Mac
// 2026-09-10, a cross-origin page reading an /api answer with the live header set: the headers JS
// could see were `content-type` alone and r.headers.get("x-titan-digest") answered null; with the
// name added, `content-type, x-titan-digest` and the digest itself. Without it the adapter's memo
// (gateway-adapter.js:144) is never filled on a bundled origin, x-titan-if-digest is never sent, and
// every idempotent read is downloaded whole on every tick -- 39.7 KiB instead of 20 bytes on the
// outline alone, which is the one mechanism the 100 KiB idle ceiling rests on. So the unchanged-answer
// protocol was dead in exactly the shells this door exists for, and same-origin is the only shape
// that ever measured it.
export const CORS_EXPOSE_HEADERS = "x-relay-auth, etag, x-titan-digest";
export const CORS_MAX_AGE = "600";

/**
 * The headers for one request's Origin, or null when there is nothing to add.
 *
 * `vary: origin` is on the answer whenever an Origin was present, including a refused one: without
 * it a shared cache in front of this relay can serve one origin's access-control headers to another
 * origin's request, which is the same hole as reflecting the Origin with extra steps.
 */
export function corsHeaders(origin, allowed) {
  const value = String(origin ?? "");
  if (value.length === 0) return null;
  if (!allowed.has(value)) return { vary: "origin" };
  return {
    "access-control-allow-origin": value,
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-allow-methods": CORS_ALLOW_METHODS,
    "access-control-expose-headers": CORS_EXPOSE_HEADERS,
    "access-control-max-age": CORS_MAX_AGE,
    vary: "origin",
  };
}
