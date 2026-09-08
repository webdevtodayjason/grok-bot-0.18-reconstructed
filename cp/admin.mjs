// cp/admin.mjs -- the super admin console's API, and the page it serves.
//
// ADMIN-1. Jason, 2026-09-07: "An admin console is merely for a super admin of the entire
// system... Client accounts, payment details that we don't have yet, the health of their boxes, the
// health of this overall system."
//
// One person's view of the whole product, and everything in it is read-only except six named
// actions: stop, start, restart and provision a customer's workspace, and disable, enable or reset
// the password of one person's sign-in.
//
// WHAT IS NOT MEASURED, and why it says so instead of guessing.
//
// The control plane runs in a container with ONE bind mount, /data/titanbot, and deliberately no
// docker socket (deploy/coolify/control-plane.compose.yml says so out loud). That fixes what it can
// see on its own:
//
//   it CAN read   /proc/loadavg and /proc/meminfo (neither is namespaced, so both are the host's),
//                 free space on /data through statfs, every customer's directory, its own store,
//                 Coolify over the api, and the relay over the shared docker network.
//   it CANNOT     run docker inspect or docker stats, see /mnt/rosa-storage where the nightly
//                 backups land, or see the box isolation timer's output.
//
// So the docker facts are asked of the RELAY, which has the socket, and the two facts that live on
// neither container read "not measured" with the reason attached. A health panel that guessed would
// be worse than one with holes in it: a made-up green light is how an outage gets missed.
//
// THE PASSWORD DECISION, in plain words. When a sign-in is refused, this service writes down a
// keyed hash of the password that was tried, never the password. That is the least it can keep and
// still tell the operator the difference between one address trying the same wrong password forty
// times (somebody's phone with a stale saved password), one address trying forty different
// passwords (an attack), and one password tried against forty accounts (a spray, which trips no
// lockout anywhere and is invisible in every other view). The key is 32 random bytes made once,
// kept 0600 in the control plane's own data directory, and it never leaves the machine, so the file
// cannot be run through a dictionary by anybody who steals it. A sign-in that WORKED gets no hash
// at all.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statfsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// One implementation of the row shape and of the keyed hash, shared with the relay. cp/Dockerfile
// copies ui/login-ledger.mjs into the image for this import. The two services keep DIFFERENT salts,
// which is the point: a hash from here and a hash from there are never comparable, so neither salt
// widens the other's blast radius.
import { filterAttempts, hashTried, readOrCreateSalt } from "../ui/login-ledger.mjs";
import { normalizeEmail } from "./store.mjs";
import { isoDay, monthStartDay, proxyKeyAlias } from "./proxy.mjs";

export const ADMIN_SALT_NAME = "login-attempt-salt";

// Six different passwords from one address inside ten minutes, and the row is flagged as an attack.
//
// Six because the relay locks an address out after five failures, so an address that got to six
// distinct passwords either waited out a lockout deliberately or came in through a door with a
// different counter. Neither is a person who forgot their password. Ten minutes because that is
// already the control plane's own lockout window, and one window in the product beats two.
export const ATTACK_DISTINCT_PASSWORDS = 6;
export const ATTACK_WINDOW_MS = 10 * 60 * 1000;

// And the attack that runs the other way: ONE password against many accounts. A spray.
//
// Six different passwords from one address is somebody working through a password list against one
// account, and every brake in the product catches it: the relay locks an address out after five
// failures, and this service locks an email out after ten. A spray trips none of them. One password
// tried once against a hundred accounts from a hundred addresses is a hundred rows, no lockout on
// any address, no lockout on any account, and nothing flagged, which is exactly the shape that gets
// in. So the same window is asked the mirror question: how many DIFFERENT accounts did one password
// get tried against. Six, for the same reason six is the number above.
export const ATTACK_SPRAY_ACCOUNTS = 6;

// How long the sign-in record is kept. Long enough to answer "has this been going on for weeks",
// short enough that it does not become a permanent list of everybody who ever mistyped their own
// password.
export const ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// A generated password is 18 random bytes in base64url, which is 24 characters and about 144 bits.
// It is shown once and stored as a scrypt hash like every other password here.
const TEMP_PASSWORD_BYTES = 18;

// How long this service waits on the relay.
//
// It used to be eight seconds, which was shorter than the sweep on the other end could take: one
// customer whose `du` ran long blanked the whole Box health panel AND put "not answering" on the
// System panel's relay card, which is a false alarm about the relay being down. The sweep is now
// bounded on the relay side (ui/box-health.mjs, SWEEP_BUDGET_MS), so this only has to be
// comfortably longer than that budget plus the trip. CP_RELAY_TIMEOUT_MS moves it.
export const RELAY_TIMEOUT_MS = 15_000;

// One box-health sweep answers every ask inside this window. One click on Refresh loads the Box
// health panel and the System health panel together and both want the same answer, so without this
// a single refresh runs the relay's whole docker-plus-du fleet sweep twice.
export const BOXES_CACHE_MS = 5_000;

// PROXY-1. How a TinyFish row is recognised in the proxy's per-model spend breakdown. It is a
// substring rather than an exact name because the pass-through's model string carries the route on
// it, and the column it feeds counts requests rather than dollars.
export const TINYFISH_MODEL_MARK = "tinyfish";

/** The control plane's own salt, made once in CP_DATA_DIR at 0600. */
export function adminSalt(dataDir, { name = ADMIN_SALT_NAME } = {}) {
  return readOrCreateSalt(path.join(String(dataDir ?? "."), name));
}

/**
 * The two stories the panel has to tell apart, per address.
 *
 * For each address: how many tries, how many of them were refused or locked, which accounts were
 * named, how many DISTINCT passwords were tried, and how many times the most repeated one came
 * back. `attack` is true when there were ATTACK_DISTINCT_PASSWORDS or more distinct passwords
 * inside any ATTACK_WINDOW_MS window, which is a sliding window rather than a calendar bucket: an
 * attacker who straddles the top of the hour is still an attacker.
 *
 * Hashes from the relay and hashes from the control plane are under different salts, so they are
 * counted per source before they are added up. Without that, one password tried through both doors
 * would count as two different passwords and every ordinary sign-in loop would look like an attack.
 */
export function summariseByAddress(rows, {
  windowMs = ATTACK_WINDOW_MS, threshold = ATTACK_DISTINCT_PASSWORDS,
} = {}) {
  const byAddress = new Map();
  for (const row of rows ?? []) {
    // A row THIS service wrote for a sign-in that arrived through the relay carries the relay's own
    // egress address rather than the visitor's, because that is the address the request came from.
    // Bucketing those by address would pile the whole fleet's console sign-ins under one phantom
    // address that can raise the attack chip on nobody. They stay in Every attempt and in the
    // by-account table, neither of which depends on the address being a person's.
    if (String(row?.via ?? "") === "relay") continue;
    const ip = String(row?.ip ?? "") || "unknown";
    let bucket = byAddress.get(ip);
    if (bucket == null) {
      bucket = { ip, attempts: 0, refused: 0, locked: 0, ok: 0, emails: new Set(), tries: [], firstAt: "", lastAt: "" };
      byAddress.set(ip, bucket);
    }
    bucket.attempts += 1;
    const outcome = String(row?.outcome ?? "");
    if (outcome === "refused") bucket.refused += 1;
    else if (outcome === "locked") bucket.locked += 1;
    else if (outcome === "ok") bucket.ok += 1;
    const email = String(row?.email ?? "");
    if (email.length > 0) bucket.emails.add(email);
    const at = Date.parse(String(row?.at ?? ""));
    if (Number.isFinite(at)) {
      const hash = String(row?.triedHash ?? "");
      // The salt differs per source, so the source is part of the identity of a password.
      if (hash.length > 0) bucket.tries.push({ at, key: `${String(row?.source ?? "relay")}:${hash}` });
      if (bucket.firstAt === "" || at < Date.parse(bucket.firstAt)) bucket.firstAt = new Date(at).toISOString();
      if (bucket.lastAt === "" || at > Date.parse(bucket.lastAt)) bucket.lastAt = new Date(at).toISOString();
    }
  }

  const summaries = [];
  for (const bucket of byAddress.values()) {
    const counts = new Map();
    for (const try_ of bucket.tries) counts.set(try_.key, (counts.get(try_.key) ?? 0) + 1);
    const distinct = counts.size;
    let topRepeat = 0;
    for (const count of counts.values()) if (count > topRepeat) topRepeat = count;

    const worst = widestInWindow(bucket.tries, windowMs);

    summaries.push({
      ip: bucket.ip,
      attempts: bucket.attempts,
      refused: bucket.refused,
      locked: bucket.locked,
      ok: bucket.ok,
      emails: [...bucket.emails].sort(),
      distinctPasswords: distinct,
      repeatedMost: topRepeat,
      distinctInWindow: worst,
      attack: worst >= threshold,
      firstAt: bucket.firstAt,
      lastAt: bucket.lastAt,
      // The sentence the panel prints, written here so the page never has to decide what a number
      // means. Plain words, because a business owner reads this screen.
      passwordStory: distinct === 0
        ? "no password reached the check"
        : distinct === 1
          ? `the same password ${topRepeat} time${topRepeat === 1 ? "" : "s"}`
          : `${distinct} different passwords`,
    });
  }
  summaries.sort((a, b) => (b.attack === a.attack ? b.attempts - a.attempts : (b.attack ? 1 : -1)));
  return summaries;
}

/** The widest set of distinct keys ever held inside one sliding window. */
function widestInWindow(tries, windowMs) {
  const sorted = [...tries].sort((a, b) => a.at - b.at);
  const live = new Map();
  let worst = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right += 1) {
    live.set(sorted[right].key, (live.get(sorted[right].key) ?? 0) + 1);
    while (sorted[right].at - sorted[left].at > windowMs) {
      const key = sorted[left].key;
      const rest = (live.get(key) ?? 0) - 1;
      if (rest <= 0) live.delete(key); else live.set(key, rest);
      left += 1;
    }
    if (live.size > worst) worst = live.size;
  }
  return worst;
}

/**
 * The spray, seen from the password's side: one tried password, and every account it was tried on.
 *
 * A row with no account named cannot be part of a spray, so the instance-password door is not in
 * here. Hashes are counted per source, for the same reason they are in summariseByAddress: the two
 * services keep different salts, so one password through both doors is two hashes and comparing
 * them across sources would be comparing nothing.
 */
export function summariseByPassword(rows, {
  windowMs = ATTACK_WINDOW_MS, threshold = ATTACK_SPRAY_ACCOUNTS,
} = {}) {
  const byKey = new Map();
  for (const row of rows ?? []) {
    const hash = String(row?.triedHash ?? "");
    const email = String(row?.email ?? "");
    const at = Date.parse(String(row?.at ?? ""));
    if (hash.length === 0 || email.length === 0 || !Number.isFinite(at)) continue;
    const source = String(row?.source ?? "relay");
    const key = `${source}:${hash}`;
    let bucket = byKey.get(key);
    if (bucket == null) {
      bucket = { source, attempts: 0, emails: new Set(), addresses: new Set(), tries: [], firstAt: "", lastAt: "" };
      byKey.set(key, bucket);
    }
    bucket.attempts += 1;
    bucket.emails.add(email);
    // A row this service wrote for a sign-in that came THROUGH the relay carries the relay's own
    // egress address rather than the visitor's, so it is not an address a person was at.
    const ip = String(row?.ip ?? "");
    if (ip.length > 0 && String(row?.via ?? "") !== "relay") bucket.addresses.add(ip);
    bucket.tries.push({ at, key: email });
    if (bucket.firstAt === "" || at < Date.parse(bucket.firstAt)) bucket.firstAt = new Date(at).toISOString();
    if (bucket.lastAt === "" || at > Date.parse(bucket.lastAt)) bucket.lastAt = new Date(at).toISOString();
  }

  const summaries = [];
  for (const bucket of byKey.values()) {
    const worst = widestInWindow(bucket.tries, windowMs);
    summaries.push({
      source: bucket.source,
      attempts: bucket.attempts,
      accounts: [...bucket.emails].sort(),
      addresses: [...bucket.addresses].sort(),
      accountsInWindow: worst,
      spray: worst >= threshold,
      firstAt: bucket.firstAt,
      lastAt: bucket.lastAt,
    });
  }
  summaries.sort((a, b) => (b.spray === a.spray ? b.attempts - a.attempts : (b.spray ? 1 : -1)));
  return summaries;
}

/**
 * The same window, per ACCOUNT rather than per address.
 *
 * This is the table the by-address one cannot be: a spray comes from a hundred addresses and lands
 * on a hundred accounts, so every address bucket holds one harmless-looking row and the attack is
 * only visible when the rows are lined up by who was being guessed at. `sprayed` is set from
 * summariseByPassword: this account was one of the accounts that a single password was tried
 * against inside one window.
 */
export function summariseByAccount(rows, {
  windowMs = ATTACK_WINDOW_MS, threshold = ATTACK_SPRAY_ACCOUNTS,
} = {}) {
  const sprayed = new Set();
  for (const password of summariseByPassword(rows, { windowMs, threshold })) {
    if (password.spray) for (const email of password.accounts) sprayed.add(email);
  }

  const byEmail = new Map();
  for (const row of rows ?? []) {
    const email = String(row?.email ?? "");
    // The instance-password door names nobody, so those rows belong to the by-address table only.
    if (email.length === 0) continue;
    let bucket = byEmail.get(email);
    if (bucket == null) {
      bucket = { email, tenant: "", attempts: 0, refused: 0, locked: 0, ok: 0, addresses: new Set(), tries: [], firstAt: "", lastAt: "" };
      byEmail.set(email, bucket);
    }
    bucket.attempts += 1;
    const outcome = String(row?.outcome ?? "");
    if (outcome === "refused") bucket.refused += 1;
    else if (outcome === "locked") bucket.locked += 1;
    else if (outcome === "ok") bucket.ok += 1;
    if (bucket.tenant === "" && String(row?.tenant ?? "").length > 0) bucket.tenant = String(row.tenant);
    const ip = String(row?.ip ?? "");
    if (ip.length > 0 && String(row?.via ?? "") !== "relay") bucket.addresses.add(ip);
    const at = Date.parse(String(row?.at ?? ""));
    if (Number.isFinite(at)) {
      const hash = String(row?.triedHash ?? "");
      if (hash.length > 0) bucket.tries.push({ at, key: `${String(row?.source ?? "relay")}:${hash}` });
      if (bucket.firstAt === "" || at < Date.parse(bucket.firstAt)) bucket.firstAt = new Date(at).toISOString();
      if (bucket.lastAt === "" || at > Date.parse(bucket.lastAt)) bucket.lastAt = new Date(at).toISOString();
    }
  }

  const summaries = [];
  for (const bucket of byEmail.values()) {
    const counts = new Map();
    for (const try_ of bucket.tries) counts.set(try_.key, (counts.get(try_.key) ?? 0) + 1);
    const distinct = counts.size;
    let topRepeat = 0;
    for (const count of counts.values()) if (count > topRepeat) topRepeat = count;
    summaries.push({
      email: bucket.email,
      tenant: bucket.tenant,
      attempts: bucket.attempts,
      refused: bucket.refused,
      locked: bucket.locked,
      ok: bucket.ok,
      addresses: [...bucket.addresses].sort(),
      distinctPasswords: distinct,
      repeatedMost: topRepeat,
      distinctInWindow: widestInWindow(bucket.tries, windowMs),
      sprayed: sprayed.has(bucket.email),
      firstAt: bucket.firstAt,
      lastAt: bucket.lastAt,
      passwordStory: distinct === 0
        ? "no password reached the check"
        : distinct === 1
          ? `the same password ${topRepeat} time${topRepeat === 1 ? "" : "s"}`
          : `${distinct} different passwords`,
    });
  }
  summaries.sort((a, b) => (b.sprayed === a.sprayed ? b.attempts - a.attempts : (b.sprayed ? 1 : -1)));
  return summaries;
}

/**
 * One list out of two ledgers.
 *
 * An account sign-in that arrives through the console is written down TWICE, once at the relay's
 * door and once here, because the relay forwards it. Showing both would double every number on the
 * panel, so a control plane row that matches a relay row within two seconds is dropped in favour of
 * the relay's, which is the richer of the two: it knows which door was used and what the browser
 * called itself.
 *
 * WHICH FIELDS HAVE TO MATCH depends on how the row got here. A row this service wrote for a
 * request that arrived through the relay carries the relay's own egress address, not the visitor's,
 * so its address will never equal the relay's row and matching on address would keep every
 * duplicate. Those rows carry via "relay" and are matched on the email and the outcome alone.
 * Everything else still has to match on the address too, because two different people failing on
 * the same account inside two seconds are two attempts and not one.
 *
 * What survives from the control plane's side is exactly what the contract wanted it for: an
 * attempt that never went through the relay at all, which is a client posting straight at
 * api.titanium.bot.
 */
export function mergeAttempts(relayRows, controlRows, { windowMs = 2000 } = {}) {
  const merged = (relayRows ?? []).map((row) => ({ ...row, source: "relay" }));
  const index = new Map();
  const add = (key, at) => {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(at);
  };
  for (const row of merged) {
    const at = Date.parse(String(row.at ?? ""));
    add(`${row.ip}|${row.email}|${row.outcome}`, at);
    add(`|${row.email}|${row.outcome}`, at);
  }
  for (const row of controlRows ?? []) {
    const forwarded = String(row.via ?? "") === "relay";
    const key = forwarded
      ? `|${String(row.email ?? "")}|${String(row.outcome ?? "")}`
      : `${String(row.ip ?? "")}|${String(row.email ?? "")}|${String(row.outcome ?? "")}`;
    const at = Date.parse(String(row.at ?? ""));
    const near = (index.get(key) ?? []).some((seen) => Number.isFinite(seen) && Number.isFinite(at) && Math.abs(seen - at) <= windowMs);
    if (near) continue;
    merged.push({ ...row, source: "control plane" });
  }
  merged.sort((a, b) => Date.parse(String(b.at ?? "")) - Date.parse(String(a.at ?? "")));
  return merged;
}

// ---- the facts this container can read for itself ----------------------------------------------

/** Host load, from /proc/loadavg. Not namespaced, so this is the machine and not the container. */
export function hostLoad({ read = (file) => readFileSync(file, "utf8") } = {}) {
  try {
    const parts = String(read("/proc/loadavg")).trim().split(/\s+/);
    return { one: Number(parts[0]), five: Number(parts[1]), fifteen: Number(parts[2]) };
  } catch (error) { return { one: null, five: null, fifteen: null, why: notMeasured(error) }; }
}

/** Host memory, from /proc/meminfo. MemAvailable is the number that means anything on Linux. */
export function hostMemory({ read = (file) => readFileSync(file, "utf8") } = {}) {
  try {
    const text = String(read("/proc/meminfo"));
    const field = (name) => {
      const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text);
      return match == null ? null : Number(match[1]) * 1024;
    };
    return { totalBytes: field("MemTotal"), availableBytes: field("MemAvailable") };
  } catch (error) { return { totalBytes: null, availableBytes: null, why: notMeasured(error) }; }
}

/** Free space on a path this container actually has mounted. statfs, not a df subprocess. */
export function diskOf(target, { statfs = statfsSync } = {}) {
  try {
    const info = statfs(String(target));
    const block = Number(info.bsize);
    return {
      path: String(target),
      totalBytes: Number(info.blocks) * block,
      freeBytes: Number(info.bavail) * block,
    };
  } catch (error) { return { path: String(target), totalBytes: null, freeBytes: null, why: notMeasured(error) }; }
}

const notMeasured = (error) => String(error?.message ?? error).split("\n")[0];

/**
 * The newest nightly backup manifest, and whether the tenant we are asking about was in it.
 *
 * The archives live on /mnt/rosa-storage, which is mounted into NO container, so this reads
 * "not measured" on the R750 as things stand and says exactly that. CP_BACKUP_MANIFEST_DIR exists
 * so an operator who binds that directory in gets the panel populated with no code change; until
 * somebody does, the panel is honest about the hole rather than green about it.
 */
export async function lastBackup(dir) {
  const root = String(dir ?? "");
  if (root.length === 0) {
    return { measured: false, why: "the archives are not mounted into this container. Set CP_BACKUP_MANIFEST_DIR to a directory this service can read." };
  }
  let stamps;
  try { stamps = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch (error) { return { measured: false, why: notMeasured(error) }; }
  for (const stamp of stamps.reverse()) {
    try {
      const manifest = JSON.parse(await readFile(path.join(root, stamp, "manifest.json"), "utf8"));
      return {
        measured: true,
        stamp: String(manifest?.stamp ?? stamp),
        takenAt: String(manifest?.takenAt ?? ""),
        // "consistent" means the pause held for the whole copy and every volume copied cleanly.
        // "live" is a copy taken while things were running, which is a backup with a caveat, and
        // the panel says which rather than showing a tick either way.
        mode: String(manifest?.mode ?? "unknown"),
        tenantCount: Number(manifest?.tenantCount ?? 0),
        tenants: Array.isArray(manifest?.tenants) ? manifest.tenants.map((row) => String(row?.slug ?? "")).filter(Boolean) : [],
        storeDbCount: Number(manifest?.storeDbCount ?? 0),
      };
    } catch { /* an unreadable or half-written stamp is not the newest good one */ }
  }
  return { measured: false, why: `no readable manifest under ${root}` };
}

/**
 * The box isolation timer's last verdict.
 *
 * deploy/r750/box-isolation.sh --verify PRINTS its result and writes nothing, so there is no file
 * to read yet and this says so. CP_ISOLATION_REPORT names the file for the day the timer starts
 * writing one; the shape it expects is {at, ok, detail}.
 */
export async function isolationReport(file) {
  const target = String(file ?? "");
  if (target.length === 0) {
    return { measured: false, why: "box-isolation.sh --verify prints its result and writes no file, so nothing here can read it. Set CP_ISOLATION_REPORT once a timer writes one." };
  }
  try {
    const parsed = JSON.parse(await readFile(target, "utf8"));
    return { measured: true, at: String(parsed?.at ?? ""), ok: parsed?.ok === true, detail: String(parsed?.detail ?? "") };
  } catch (error) { return { measured: false, why: notMeasured(error) }; }
}

/** A workspace whose build started and never finished. Read out of the provisioning ledger. */
export function stuckProvisioning(store, { at = Date.now(), afterMs = 15 * 60 * 1000 } = {}) {
  const stuck = [];
  for (const row of store.listTenants()) {
    if (row.status !== "provisioning") continue;
    const steps = store.listSteps(row.slug);
    const last = steps.length === 0 ? row.updatedAt : steps[steps.length - 1].at;
    if (at - Number(last) < afterMs) continue;
    stuck.push({
      slug: row.slug,
      since: new Date(Number(last)).toISOString(),
      lastStep: steps.length === 0 ? "none recorded" : steps[steps.length - 1].step,
      lastError: row.lastError ?? "",
    });
  }
  return stuck;
}

// ---- the api -----------------------------------------------------------------------------------

/**
 * Every /v1/admin route, plus the static page at /admin.
 *
 * It is handed the pieces cp/server.mjs already owns rather than building its own, so there is one
 * store, one Coolify client, one session verifier and one set of guards in this process. `handle`
 * answers true when it took the request and false when it did not, which is what lets cp/server.mjs
 * mount it with two lines.
 */
export function createAdminApi({
  config, store, client, now = () => Date.now(), fetchImpl = globalThis.fetch,
  json, noContent, publicAccount, publicTenant, tenantView, tenantPower, tenantProvision,
  currentSession, version = "0.0.0", pageDir = new URL("./admin/", import.meta.url).pathname,
  read = (file) => readFileSync(file, "utf8"),
  log = (line) => { try { process.stderr.write(`${line}\n`); } catch { /* a closed stderr is not worth throwing over */ } },
  // PROXY-1. The proxy, and one tenant's plan key read off the disk. Both are handed in by
  // cp/server.mjs rather than built here, for the same reason the store and the Coolify client
  // are: one of each in this process.
  proxy = null,
  proxyKeyOf = () => null,
} = {}) {
  // Made on the first refused sign-in rather than at boot, so a data directory that is not writable
  // yet cannot stop the service from starting.
  //
  // A FAILURE IS NOT MEMOISED, and it is not silent. A directory that could not be written at the
  // first refusal is usually writable at the next one, and remembering the empty value would turn
  // one bad moment into a process that never hashes another password. What that looks like on the
  // panel is every address reading "no password reached the check" with attack false, which is the
  // made-up green light this file's own header refuses to ship. So the empty value is retried, the
  // reason is kept for the System panel, and the failure goes to the log with the path in it. The
  // salt itself is never logged.
  let salt = null;
  let saltWhy = "";
  const saltFile = () => path.join(String(config.dataDir ?? "."), ADMIN_SALT_NAME);
  const saltOf = () => {
    if (salt) return salt;
    try { salt = adminSalt(config.dataDir); saltWhy = ""; }
    catch (error) {
      salt = "";
      saltWhy = `this service could not read or make its salt at ${saltFile()}: ${notMeasured(error)}`;
      log(`admin console: the sign-in record cannot be signed. ${saltWhy}`);
    }
    return salt;
  };

  /**
   * Whether the sign-in record is actually being signed, for the System panel.
   *
   * Asking makes the salt if it is not there yet, which is the same thing the next refused sign-in
   * would do, so this card is a live check and not a memory of one. It exists because "no attacks"
   * and "the ledger cannot hash" look identical on every other panel.
   */
  const signInRecord = () => (saltOf().length > 0
    ? { signing: true, why: `a refused sign-in is written down with a keyed hash of the password that was tried, under ${ADMIN_SALT_NAME} in this service's data directory` }
    : { signing: false, why: saltWhy || `this service could not read or make its salt at ${saltFile()}` });

  const relayBase = String(config.relayUrl ?? "").replace(/\/+$/, "");

  const secretsMatch = (given, expected) => {
    if (typeof given !== "string" || typeof expected !== "string" || expected.length === 0) return false;
    const a = createHash("sha256").update(given, "utf8").digest();
    const b = createHash("sha256").update(expected, "utf8").digest();
    return timingSafeEqual(a, b);
  };
  const bearer = (request) => {
    const header = String(request.headers.authorization ?? "");
    return /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
  };

  /**
   * Two doors, and the flag is read from the STORE on every single request.
   *
   * CP_ADMIN_TOKEN, because that is how the CLI promotes the first super admin on a system that has
   * none, and because it is the way back in if the last one is ever demoted.
   *
   * Otherwise a session whose account carries super_admin, looked up now. Nothing is taken from the
   * token: a token is a fact from whenever it was minted, and "this person was demoted" has to mean
   * demoted now and not in up to twelve hours.
   *
   * The account the token names has to BE the account the token was issued for, and that is three
   * checks rather than one. A session is signed with the tenant's OWN derived key, and every tenant
   * relay is handed its own key (cp/server.mjs, the relay registry), which is a key that lives in
   * that customer's Coolify environment. So the signature proves "somebody who holds tenant X's key
   * minted this" and nothing more. Without the two lines below, a customer who can run code in
   * their own relay could mint a token under their own tenant's key carrying a SUPER ADMIN'S
   * account id and open every route on this console, including the promote that makes the
   * escalation permanent. Matching the account's tenant and address against the token's own claims
   * closes it: cp/server.mjs fills sub, email and tenant from one account row when it mints, so
   * every real token passes and a token whose sub was swapped for somebody else's does not.
   */
  const requireSuperAdmin = (request, response) => {
    if (secretsMatch(bearer(request), config.adminToken)) return { ok: true, via: "operator token", account: null };
    const session = currentSession(request);
    if (session.ok) {
      const account = store.getAccountById(session.payload.sub);
      const sameTenant = account != null && String(account.tenant) === String(session.payload.tenant ?? "");
      const sameEmail = account != null && normalizeEmail(account.email) === normalizeEmail(session.payload.email ?? "");
      if (account != null && sameTenant && sameEmail && account.superAdmin === true && account.disabled !== true) {
        return { ok: true, via: "session", account };
      }
    }
    json(response, 401, { error: "unauthorized", message: "This console is for super admins." });
    return { ok: false };
  };

  const relayTimeoutMs = Number(config.relayTimeoutMs) > 0 ? Number(config.relayTimeoutMs) : RELAY_TIMEOUT_MS;

  /** The relay, asked for the two things only it can see. Never throws; says why instead. */
  async function askRelay(pathname, query = "") {
    if (relayBase.length === 0 || String(config.relayToken ?? "").length === 0) {
      return { ok: false, why: "this control plane has no relay configured (CP_RELAY_URL and CP_RELAY_TOKEN)" };
    }
    try {
      const response = await fetchImpl(`${relayBase}${pathname}${query}`, {
        headers: { authorization: `Bearer ${config.relayToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(relayTimeoutMs),
      });
      if (!response.ok) return { ok: false, why: `the relay answered ${response.status}` };
      return { ok: true, body: await response.json() };
    } catch (error) {
      return { ok: false, why: error?.name === "TimeoutError" ? "the relay did not answer in time" : "the relay did not answer" };
    }
  }

  /**
   * The relay's box-health answer, asked for once and handed to everybody who wants it.
   *
   * Two panels want it: Box health for all of it, System health for one line saying whether the
   * relay is reachable. They load together, so `inFlight` is what makes two CONCURRENT asks one
   * sweep and the short cache is what makes two asks a second apart one sweep. Aborting on this
   * side never stopped the work on the other one, so asking twice was two full docker-and-du fleet
   * sweeps on the host for one click.
   */
  let boxesCache = { at: 0, answer: null, inFlight: null };
  function askRelayBoxes() {
    if (boxesCache.answer != null && now() - boxesCache.at < BOXES_CACHE_MS) return Promise.resolve(boxesCache.answer);
    if (boxesCache.inFlight != null) return boxesCache.inFlight;
    const pending = askRelay("/admin/boxes").then(
      (answer) => { boxesCache = { at: now(), answer, inFlight: null }; return answer; },
      (error) => { boxesCache = { at: 0, answer: null, inFlight: null }; throw error; },
    );
    boxesCache = { ...boxesCache, inFlight: pending };
    return pending;
  }

  // ---- the proxy (PROXY-1) ----------------------------------------------------------------------
  //
  // Modelled line for line on askRelay above: a bearer, a deadline, and it never throws. A proxy
  // that is down has to come out of here as "not measured" with the reason on the panel, because a
  // zero on a spend column is indistinguishable from a customer who has not spent anything, and
  // that is the one number an operator would act on without checking.
  //
  // The BROWSER never talks to the proxy. The admin page's own CSP is connect-src 'self', which is
  // deliberate: the proxy is on the docker bridge and is not on the internet, so a panel that
  // fetched it directly could not work and a panel that could would be the proxy on the internet.
  // Everything below runs in this container.

  /** Whether there is a proxy to ask at all, in the words the panel prints when there is not. */
  const proxyOff = () => {
    if (proxy == null || proxy.configured !== true) {
      return "this control plane has no proxy configured (CP_PROXY_URL and CP_PROXY_MASTER_KEY)";
    }
    return "";
  };

  async function askProxy(method, call) {
    const off = proxyOff();
    if (off) return { ok: false, why: off };
    try { return await call(); }
    catch (error) {
      // createProxyClient does not throw, so reaching this is a bug in it rather than a proxy that
      // is down. It is still caught, because a panel that 500s tells an operator less than a panel
      // that says what happened.
      return { ok: false, why: `the proxy call ${method} failed: ${notMeasured(error)}` };
    }
  }

  /**
   * One sweep of the two spend windows, shared by the Spend panel and the Clients panel.
   *
   * The same cache and in-flight join askRelayBoxes uses, and for the same reason: the two panels
   * load together, so one Refresh has to be one pair of reports rather than four.
   *
   * The windows are calendar windows in UTC. "This month" is the first of the month to today,
   * because an allowance is a monthly allowance and a rolling thirty days would never line up with
   * the number a customer is told they get.
   */
  let spendCache = { at: 0, answer: null, inFlight: null };
  function askProxySpend() {
    if (spendCache.answer != null && now() - spendCache.at < BOXES_CACHE_MS) return Promise.resolve(spendCache.answer);
    if (spendCache.inFlight != null) return spendCache.inFlight;
    const at = now();
    const pending = (async () => {
      const today = isoDay(at);
      const [month, day] = await Promise.all([
        askProxy("/global/spend/report month", () => proxy.spendReport({ startDay: monthStartDay(at), endDay: today })),
        askProxy("/global/spend/report today", () => proxy.spendReport({ startDay: today, endDay: today })),
      ]);
      return { month, day, today, monthStart: monthStartDay(at) };
    })().then(
      (answer) => { spendCache = { at: now(), answer, inFlight: null }; return answer; },
      (error) => { spendCache = { at: 0, answer: null, inFlight: null }; throw error; },
    );
    spendCache = { ...spendCache, inFlight: pending };
    return pending;
  }

  /** One report's row for one tenant, matched on the key id first and the alias second. */
  function windowFor(report, { alias, keyId }) {
    if (!report.ok) return { requests: null, dollars: null, why: report.why };
    const row = report.keys.find((one) => (keyId.length > 0 && one.keyId === keyId))
      ?? report.keys.find((one) => (alias.length > 0 && one.alias === alias));
    // Nothing in the report for this key is not a hole. It is a real zero: the report covers the
    // whole window and this key is not in it, so nothing was spent. That is the one place a zero is
    // honest, and it is written out rather than left to a default.
    if (row == null) return { requests: 0, dollars: 0, why: "" };
    return {
      requests: row.requests,
      dollars: row.dollars,
      why: row.requests === null && row.dollars === null ? "the proxy reported this key with no numbers on it" : "",
      models: row.models,
    };
  }

  /**
   * Per client: what their plan includes, what they have spent, and how close they are.
   *
   * PERCENT AND DOLLARS ARE NOT THE SAME AUDIENCE. Dollars are here, in the operator's own
   * console. What a customer is shown in their own Settings is a percentage and a sentence, which
   * is C's surface, and the reason is that a customer's plan price is not their provider cost and
   * showing them one as the other invites a conversation nobody wants to have.
   */
  // The whole answer, cached and joined the way the box sweep is, not just the two reports inside
  // it. The Spend panel and the Clients panel both render this object and they load together, so
  // without this one Refresh would be one pair of reports and TWO /key/info calls per customer.
  let spendAnswerCache = { at: 0, answer: null, inFlight: null };
  function spend() {
    if (spendAnswerCache.answer != null && now() - spendAnswerCache.at < BOXES_CACHE_MS) {
      return Promise.resolve(spendAnswerCache.answer);
    }
    if (spendAnswerCache.inFlight != null) return spendAnswerCache.inFlight;
    const pending = computeSpend().then(
      (answer) => { spendAnswerCache = { at: now(), answer, inFlight: null }; return answer; },
      (error) => { spendAnswerCache = { at: 0, answer: null, inFlight: null }; throw error; },
    );
    spendAnswerCache = { ...spendAnswerCache, inFlight: pending };
    return pending;
  }

  async function computeSpend() {
    const off = proxyOff();
    const at = now();
    if (off) {
      return {
        configured: false,
        why: off,
        clients: store.listTenants().map((tenant) => ({
          slug: tenant.slug,
          name: tenant.name,
          alias: "",
          keyId: "",
          minted: false,
          allowance: null,
          enforced: false,
          pct: null,
          spendToDate: null,
          thisMonth: { requests: null, dollars: null, why: off },
          today: { requests: null, dollars: null, why: off },
          tinyfish: { requests: null, why: off },
          why: off,
        })),
        allowance: Number(config.proxyAllowanceUsd) > 0 ? Number(config.proxyAllowanceUsd) : null,
        enforced: Boolean(config.proxyEnforce),
        measuredAt: new Date(at).toISOString(),
      };
    }

    const sweep = await askProxySpend();
    const allowance = Number(config.proxyAllowanceUsd) > 0 ? Number(config.proxyAllowanceUsd) : null;
    const rows = [];
    for (const tenant of store.listTenants()) {
      const record = proxyKeyOf(tenant.slug);
      if (record == null) {
        rows.push({
          slug: tenant.slug,
          name: tenant.name,
          alias: proxyKeyAlias(tenant.slug),
          keyId: "",
          minted: false,
          allowance,
          enforced: false,
          pct: null,
          spendToDate: null,
          thisMonth: { requests: null, dollars: null, why: "this workspace has no plan key yet" },
          today: { requests: null, dollars: null, why: "this workspace has no plan key yet" },
          tinyfish: { requests: null, why: "this workspace has no plan key yet" },
          why: `this workspace has no plan key yet (mint one with cp/cli.mjs proxy mint ${tenant.slug})`,
        });
        continue;
      }
      const handle = { alias: record.alias, keyId: record.keyId };
      const thisMonth = windowFor(sweep.month, handle);
      const today = windowFor(sweep.day, handle);
      // The spend LiteLLM itself compares a budget against, which is not the same as the sum of a
      // report window: the report is a calendar month and the key's own counter resets on the
      // budget duration. The chip has to read the number that will actually stop a request.
      const info = await askProxy("/key/info", () => proxy.keyInfo(record.key));
      const spendToDate = info.ok ? info.spend : null;
      // TinyFish is counted in REQUESTS and never in dollars. Its pass-through is priced as a flat
      // cost per request on our side and an agent run's real credits vary, so a dollar figure here
      // would be a number that looks precise and is not.
      const models = Array.isArray(thisMonth.models) ? thisMonth.models : [];
      const tinyfishRows = models.filter((row) => String(row.model).toLowerCase().includes(TINYFISH_MODEL_MARK));
      rows.push({
        slug: tenant.slug,
        name: tenant.name,
        alias: record.alias,
        keyId: record.keyId,
        minted: true,
        mintedAt: record.mintedAt,
        allowance,
        enforced: record.enforced === true,
        pct: allowance != null && spendToDate != null ? Math.round((spendToDate / allowance) * 100) : null,
        spendToDate,
        spendToDateWhy: info.ok ? "" : info.why,
        thisMonth: { requests: thisMonth.requests, dollars: thisMonth.dollars, why: thisMonth.why },
        today: { requests: today.requests, dollars: today.dollars, why: today.why },
        tinyfish: models.length === 0
          ? { requests: null, why: thisMonth.why || "the proxy's report does not break this key down by model on this build" }
          : { requests: tinyfishRows.reduce((total, row) => total + (row.requests ?? 0), 0), why: "" },
        why: "",
      });
    }
    return {
      configured: true,
      why: "",
      clients: rows,
      allowance,
      enforced: Boolean(config.proxyEnforce),
      // Said out loud on the panel as well as here. The spend counter chain is batch written, so a
      // stop at the allowance is a stop and not an exact cap: a burst in flight when the number is
      // read can carry a customer past it before the next write lands.
      note: "A stop at the allowance is a stop, not an exact cap. Spend is batch written at the proxy, so the number this panel reads can be a little behind what has actually been spent.",
      window: { month: `${sweep.monthStart} to ${sweep.today}`, today: sweep.today },
      measuredAt: new Date(at).toISOString(),
    };
  }

  /** The merged sign-in ledger, both sides, filtered and summarised. */
  async function signIns({ sinceMs, outcome, limit }) {
    const relay = await askRelay("/admin/login-attempts", `?since=${encodeURIComponent(new Date(sinceMs).toISOString())}&outcome=${encodeURIComponent(outcome)}&limit=${limit}`);
    const relayRows = relay.ok && Array.isArray(relay.body?.rows) ? relay.body.rows : [];
    const controlRows = store.listLoginAttempts({ since: sinceMs, outcome, limit });
    const merged = filterAttempts(mergeAttempts(relayRows, controlRows), { limit });
    // The tenant a row belongs to, filled in from the account list. The relay cannot know it for a
    // refusal -- it has no accounts -- and this is the one place that does.
    for (const row of merged) {
      if (String(row.tenant ?? "").length > 0) continue;
      const account = String(row.email ?? "").length > 0 ? store.getAccountByEmail(row.email) : null;
      row.tenant = account?.tenant ?? "";
    }
    return {
      rows: merged,
      addresses: summariseByAddress(merged),
      // The mirror of the address table, and the only one a spray shows up in.
      accounts: summariseByAccount(merged),
      passwords: summariseByPassword(merged),
      relay: relay.ok ? { reachable: true } : { reachable: false, why: relay.why },
      measuredAt: new Date(now()).toISOString(),
    };
  }

  /** Every customer, their people, and what their workspace is doing right now. */
  async function clients() {
    // PROXY-1. The same object the Spend panel renders, on the same row as the customer, from the
    // same sweep. `plan: "none"` used to sit here as a named placeholder; it is now the real
    // allowance, and it is called an allowance because `plan` already means the eight step
    // provisioning plan everywhere else in cp/.
    const spending = await spend();
    const byTenant = new Map(spending.clients.map((row) => [row.slug, row]));
    // The last time each person actually got in, out of the sign-in record. Read ONCE for the whole
    // fleet rather than per account: the rows come back newest first, so the first one seen for an
    // address is that person's most recent sign-in. "never" is a real answer and reads as one -- an
    // account nobody has ever used is a thing an operator wants to see rather than a blank.
    const lastSignIn = new Map();
    for (const row of store.listLoginAttempts({ since: 0, outcome: "ok", limit: 5000 })) {
      if (!lastSignIn.has(row.email)) lastSignIn.set(row.email, row.at);
    }
    const rows = [];
    for (const tenant of store.listTenants()) {
      const view = await tenantView(tenant);
      const users = store.listAccountsForTenant(tenant.slug).map((account) => ({
        ...publicAccount(account),
        lastSignInAt: lastSignIn.get(account.email) ?? null,
      }));
      rows.push({
        ...view,
        users,
        // Named rather than left out, because a fact that could not be measured has to read as one
        // and never as an empty column.
        spend: byTenant.get(tenant.slug) ?? null,
      });
    }
    return { clients: rows, proxy: { configured: spending.configured, why: spending.why }, measuredAt: new Date(now()).toISOString() };
  }

  /** Box health: the ledger's view, plus the relay's, joined on the slug. */
  async function boxes() {
    const relay = await askRelayBoxes();
    const fromRelay = new Map();
    if (relay.ok && Array.isArray(relay.body?.boxes)) {
      for (const box of relay.body.boxes) fromRelay.set(String(box?.slug ?? ""), box);
    }
    const backup = await lastBackup(config.backupManifestDir);
    const rows = [];
    for (const tenant of store.listTenants()) {
      const live = await tenantView(tenant);
      const seen = fromRelay.get(tenant.slug) ?? null;
      rows.push({
        slug: tenant.slug,
        name: tenant.name,
        status: live.status,
        coolify: live.coolify,
        boxContainer: tenant.boxContainer ?? "",
        boxReady: tenant.boxReady,
        // Everything below comes from the relay, which has the docker socket this container does
        // not. A relay that did not answer leaves every one of them as "not measured".
        relayReachable: seen != null,
        containerState: seen?.containerState ?? "not measured",
        containerStateWhy: seen?.containerStateWhy ?? (relay.ok ? "the relay did not report this workspace" : relay.why),
        gatewayAnswering: seen?.gatewayAnswering ?? null,
        gatewayMs: seen?.gatewayMs ?? null,
        gatewayWhy: seen?.gatewayWhy ?? "",
        lastActivityAt: seen?.lastActivityAt ?? null,
        lastActivityWhy: seen?.lastActivityWhy ?? "",
        diskKb: seen?.diskKb ?? null,
        diskWhy: seen?.diskWhy ?? "",
        memoryBytes: seen?.memoryBytes ?? null,
        memoryWhy: seen?.memoryWhy ?? "",
        lastBackupStamp: backup.measured && backup.tenants.includes(tenant.slug) ? backup.stamp : null,
        lastBackupWhy: backup.measured
          ? (backup.tenants.includes(tenant.slug) ? "" : `this workspace was not in the ${backup.stamp} snapshot`)
          : backup.why,
      });
    }
    return { boxes: rows, backup, measuredAt: new Date(now()).toISOString() };
  }

  /** The whole machine, as far as this container can see it, with the holes named. */
  async function system() {
    const coolify = await (async () => {
      if (!config.coolifyUrl || !config.coolifyApiKey) return { reachable: false, why: "Coolify is not configured on this service" };
      try { await client.call("GET", "/projects"); return { reachable: true, url: client.base }; }
      catch (error) { return { reachable: false, why: notMeasured(error) }; }
    })();
    // The same sweep the Box health panel just asked for, not a second one. All this card needs is
    // whether the relay answered.
    const relay = await askRelayBoxes();
    const backup = await lastBackup(config.backupManifestDir);
    const isolation = await isolationReport(config.isolationReport);
    return {
      version,
      measuredAt: new Date(now()).toISOString(),
      load: hostLoad(),
      memory: hostMemory({ read }),
      disks: [
        diskOf(config.tenantRoot),
        // The archives mount, named so the panel can say it is not there rather than omit it.
        config.backupManifestDir ? diskOf(config.backupManifestDir) : {
          path: "the archives mount",
          totalBytes: null,
          freeBytes: null,
          why: "not mounted into this container",
        },
      ],
      coolify,
      relay: relay.ok ? { reachable: true, url: relayBase } : { reachable: false, url: relayBase, why: relay.why },
      // The relay owns the mail webhook and its secret; this container has neither, so the honest
      // answer is that it cannot see it from here.
      mailWebhook: { measured: false, why: "the mail webhook is configured on the relay, which this service cannot read from inside its container. Check it in the console's Email card." },
      // Whether the sign-in panel's numbers can be trusted at all. Without this card, a data
      // directory this service cannot write reads as a quiet day rather than as a broken ledger.
      signInRecord: signInRecord(),
      backup,
      isolation,
      stuckProvisioning: stuckProvisioning(store, { at: now() }),
      counts: {
        tenants: store.countTenants(),
        accounts: store.countAccounts(),
        superAdmins: store.countSuperAdmins(),
        signInsLastDay: store.countLoginAttempts(now() - 24 * 60 * 60 * 1000),
      },
    };
  }

  // ---- the static page -------------------------------------------------------------------------
  //
  // The page shell is public and everything it SHOWS is not. That is not a compromise, it is the
  // only shape that works: the page carries the sign-in form, so a page behind the session could
  // never be reached by anyone who is not already signed in. There is no customer data, no count and
  // no hostname in these three files -- every byte the panel renders arrives from a /v1/admin route
  // that refuses anything but a super admin.
  const PAGE_FILES = {
    "/admin": ["index.html", "text/html; charset=utf-8"],
    "/admin/": ["index.html", "text/html; charset=utf-8"],
    "/admin/index.html": ["index.html", "text/html; charset=utf-8"],
    "/admin/admin.css": ["admin.css", "text/css; charset=utf-8"],
    "/admin/admin.js": ["admin.js", "text/javascript; charset=utf-8"],
  };

  function servePage(pathname, response) {
    const entry = PAGE_FILES[pathname];
    if (entry == null) return false;
    const [name, type] = entry;
    let text;
    try { text = read(path.join(pageDir, name)); }
    catch { json(response, 500, { error: "page_missing", message: `the admin console's ${name} is not in this image` }); return true; }
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
      // The page loads nothing from anywhere. No framework, no CDN, no font service: the whole
      // console is three files from this origin, so the policy that says exactly that is one this
      // page can actually keep.
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-length": Buffer.byteLength(text, "utf8"),
    });
    response.end(text);
    return true;
  }

  // ---- the routes ------------------------------------------------------------------------------

  async function handle(request, response, { segments, method, body, url }) {
    if (servePage(url.pathname, response)) return true;
    if (segments[0] !== "v1" || segments[1] !== "admin") return false;

    const guard = requireSuperAdmin(request, response);
    if (!guard.ok) return true;

    const rest = segments.slice(2);

    if (rest.length === 1 && rest[0] === "overview" && method === "GET") {
      const hours = 24;
      const sinceMs = now() - hours * 60 * 60 * 1000;
      const attempts = await signIns({ sinceMs, outcome: "", limit: 2000 });
      const attacks = attempts.addresses.filter((row) => row.attack);
      const sprayed = attempts.accounts.filter((row) => row.sprayed);
      json(response, 200, {
        version,
        measuredAt: new Date(now()).toISOString(),
        signedInAs: guard.account?.email ?? "the operator token",
        counts: {
          clients: store.countTenants(),
          users: store.countAccounts(),
          superAdmins: store.countSuperAdmins(),
        },
        signIns: {
          hours,
          total: attempts.rows.length,
          refused: attempts.rows.filter((row) => row.outcome === "refused").length,
          locked: attempts.rows.filter((row) => row.outcome === "locked").length,
          ok: attempts.rows.filter((row) => row.outcome === "ok").length,
          attackAddresses: attacks.map((row) => row.ip),
          // The other shape: one password against many accounts. It trips no lockout anywhere, so
          // this list is the only place it appears.
          sprayedAccounts: sprayed.map((row) => row.email),
        },
        stuckProvisioning: stuckProvisioning(store, { at: now() }),
        relay: attempts.relay,
      });
      return true;
    }

    if (rest.length === 1 && rest[0] === "sign-ins" && method === "GET") {
      const hours = Number(url.searchParams.get("hours") ?? 0);
      const sinceParam = url.searchParams.get("since");
      const sinceMs = sinceParam
        ? (Number.isFinite(Number(sinceParam)) ? Number(sinceParam) : Date.parse(sinceParam))
        : now() - (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
      const answer = await signIns({
        sinceMs: Number.isFinite(sinceMs) ? sinceMs : now() - 24 * 60 * 60 * 1000,
        outcome: String(url.searchParams.get("outcome") ?? ""),
        limit: Number(url.searchParams.get("limit") ?? 500),
      });
      json(response, 200, {
        ...answer,
        rule: `an address that tried ${ATTACK_DISTINCT_PASSWORDS} or more different passwords inside ${Math.round(ATTACK_WINDOW_MS / 60000)} minutes is flagged as an attack`,
        sprayRule: `one password tried against ${ATTACK_SPRAY_ACCOUNTS} or more accounts inside ${Math.round(ATTACK_WINDOW_MS / 60000)} minutes is flagged as a spray, however many addresses it came from`,
      });
      return true;
    }

    if (rest.length === 1 && rest[0] === "clients" && method === "GET") {
      json(response, 200, await clients());
      return true;
    }

    if (rest.length === 1 && rest[0] === "boxes" && method === "GET") {
      json(response, 200, await boxes());
      return true;
    }

    if (rest.length === 1 && rest[0] === "system" && method === "GET") {
      json(response, 200, await system());
      return true;
    }

    // PROXY-1. What every customer has spent against what their plan includes.
    if (rest.length === 1 && rest[0] === "spend" && method === "GET") {
      json(response, 200, await spend());
      return true;
    }

    // ---- the six actions -------------------------------------------------------------------------

    if (rest.length === 3 && rest[0] === "clients" && method === "POST") {
      const slug = decodeURIComponent(rest[1]);
      const action = rest[2];
      if (store.getTenant(slug) == null) { json(response, 404, { error: "not_found" }); return true; }
      if (["stop", "start", "restart"].includes(action)) { await tenantPower(response, slug, action); return true; }
      if (action === "provision") { await tenantProvision(response, slug, body ?? {}); return true; }
      json(response, 404, { error: "not_found" });
      return true;
    }

    if (rest.length === 3 && rest[0] === "users" && method === "POST") {
      let named = rest[1];
      try { named = decodeURIComponent(rest[1]); } catch { named = rest[1]; }
      const account = store.getAccountById(named) ?? store.getAccountByEmail(named);
      if (account == null) { json(response, 404, { error: "not_found" }); return true; }
      const action = rest[2];

      if (action === "disable" || action === "enable") {
        // A super admin cannot disable themselves out of the console they are holding. It is a
        // mistake with no upside and exactly one recovery path, which is the CLI.
        if (action === "disable" && guard.account != null && guard.account.id === account.id) {
          json(response, 409, { error: "self", message: "You cannot disable your own sign-in from this console." });
          return true;
        }
        const updated = store.setAccountDisabled(account.id, action === "disable");
        json(response, 200, {
          account: publicAccount(updated),
          message: action === "disable"
            ? `${updated.email} can no longer sign in. A session they already hold keeps working until it expires, which is at most 12 hours.`
            : `${updated.email} can sign in again.`,
        });
        return true;
      }

      if (action === "reset-password") {
        // Shown once, in this response, and stored as a scrypt hash like every other password here.
        // Nothing writes it to a log, and there is no route that can be asked for it again.
        const temporary = randomBytes(TEMP_PASSWORD_BYTES).toString("base64url");
        store.setAccountPassword(account.id, temporary);
        json(response, 200, {
          account: publicAccount(store.getAccountById(account.id)),
          temporaryPassword: temporary,
          // The second sentence is the one that matters when this button is being pressed because
          // an account is compromised. A session is a signed token neither this service nor the
          // relay holds a copy of, so changing the password shuts the door and leaves anybody who
          // is already inside where they are. It is said here because the disable button two blocks
          // up says it, and a reset that stayed quiet about it reads as though the door is now shut.
          message: "This password is shown once. Send it to them by a route that is not this screen, and have them change it when they sign in. The old password stops working now, but a session that is already open keeps working until it expires, which is at most 12 hours.",
        });
        return true;
      }

      if (action === "promote" || action === "demote") {
        if (action === "demote" && store.countSuperAdmins() <= 1 && account.superAdmin === true) {
          json(response, 409, {
            error: "last_super_admin",
            message: "That is the only super admin. Promote somebody else first, or this console has nobody who can open it.",
          });
          return true;
        }
        const updated = store.setSuperAdmin(account.id, action === "promote");
        json(response, 200, { account: publicAccount(updated) });
        return true;
      }

      json(response, 404, { error: "not_found" });
      return true;
    }

    json(response, 404, { error: "not_found" });
    return true;
  }

  /**
   * One sign-in written down, from cp/server.mjs's own sign-in route. The PASSWORD comes in and the
   * keyed hash goes to disk; a success gets no hash at all.
   */
  function recordAttempt({ email, ip, outcome, password = "", tenant = "", at = now(), via = "" }) {
    store.recordLoginAttempt({
      at, email, ip, outcome, tenant, via,
      triedHash: outcome === "ok" ? "" : hashTried(password, saltOf()),
    });
    // Pruned on the same call rather than on a timer, so the table cannot grow without bound on a
    // service nobody restarts.
    store.pruneLoginAttempts(at - ATTEMPT_RETENTION_MS);
  }

  return { handle, servePage, recordAttempt, requireSuperAdmin, signIns, clients, boxes, system, spend };
}
