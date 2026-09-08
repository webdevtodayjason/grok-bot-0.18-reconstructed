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
import {
  PROVIDER_PRESETS,
  PROVIDER_QUOTA,
  TB,
  TENANT_ALLOWED_ROUTES,
  isPlanModel,
  isoDay,
  monthStartDay,
  proxyKeyAlias,
  servedPlanModels,
} from "./proxy.mjs";

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

// One transparent pixel, base64. What the vision check sends through a candidate model, because
// "does this model take an image" cannot be read out of any catalog and getting it wrong is a
// fleet-wide screenshot outage: MEASURED 2026-09-08, glm-5.3 refuses an image part with code 1210
// while glm-5.3-flash answers, and every Titan conversation carries screenshots.
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
  // PROVIDERS-1. The address a change came from, worked out by cp/server.mjs, which is the only
  // thing in this process that knows which peers are trusted proxies and which are boxes. Without
  // it an admin_actions row could say who and when and not where. The default is a sentence rather
  // than an empty string, so a row written by a caller that did not pass one reads as unmeasured.
  clientOf = () => "not measured",
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
      // PROXY-8's half of the fix, and it is a DELETION rather than a guard.
      //
      // This used to be `proxy.keyInfo(record.key)`, and it was the only caller of /key/info in the
      // product. That one call is why /key/info had to stay in the proxy's global door list, and
      // that list is one list for everybody: it cannot tell the operator from a tenant, so leaving
      // /key/info open for this panel left it open to every box on the bridge, where any virtual
      // key could read any other key's record. The boundary moves to the key (allowed_routes at
      // mint, see TENANT_ALLOWED_ROUTES), and this call goes away entirely.
      //
      // What is lost, said out loud rather than papered over: /key/info reported the counter
      // LiteLLM itself compares a budget against, which resets on the budget duration, while this
      // number is the calendar month out of the request log. On an install with no budget duration
      // set they are the same window. Where they differ, the request log is the better evidence
      // anyway: it is one row per request, it is what the two windows beside it already come from,
      // and one aggregator with two groupings is what stops this panel and the Providers panel
      // disagreeing by a batch write.
      const spendToDate = thisMonth.dollars;
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
        spendToDateWhy: thisMonth.why,
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
    // PROVIDERS-1. WHAT THIS WORKSPACE RUNS ON, and the models it could be put on, on the same row
    // as the customer. Without this block the Clients panel drew "not measured" beside every
    // workspace and the one control the wave promised -- set a customer's model from their row --
    // had nothing to render. The current model is read out of the proxy's own request log rather
    // than out of a stored field, because the stored field is what a box was TOLD and the log is
    // what it actually ran; where the log cannot be read that is said rather than guessed.
    const modelChoices = [];
    const runningBySlug = new Map();
    let modelWhy = spending.configured ? "" : spending.why;
    if (spending.configured) {
      const shape = await proxyShape();
      const sweep = await askProxySpend();
      const seen = new Set();
      for (const row of (shape.deployments.ok ? shape.deployments.rows : [])) {
        if (!isPlanModel(row.alias) || seen.has(row.alias)) continue;
        seen.add(row.alias);
        // Only what a customer could be told they are on. A routing target with no customer name
        // is not a choice: putting a workspace on one is how "plan-zai" reached a Settings card.
        if (row.customerVisible !== true || String(row.customerLabel ?? "").length === 0 || String(row.customerName ?? "").length === 0) continue;
        modelChoices.push({ alias: row.alias, name: row.customerName, label: row.customerLabel });
      }
      modelChoices.sort((a, b) => a.alias.localeCompare(b.alias));
      if (sweep?.month?.ok) {
        for (const key of sweep.month.keys ?? []) {
          const alias = String(key.alias ?? "");
          if (!alias.startsWith("titanbot-")) continue;
          const ran = (key.models ?? []).map((one) => String(one.model)).filter((one) => isPlanModel(one));
          if (ran.length > 0) runningBySlug.set(alias.slice("titanbot-".length), ran);
        }
      } else {
        modelWhy = sweep?.month?.why ?? "the proxy's request log could not be read";
      }
    }
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
      const ran = runningBySlug.get(tenant.slug) ?? [];
      // The flagship first when a workspace ran both it and its vision fallback, because the
      // fallback is not a thing anybody chose and is not what this workspace is "on".
      const current = ran.find((one) => modelChoices.some((row) => row.alias === one)) ?? ran[0] ?? "";
      rows.push({
        ...view,
        users,
        // Named rather than left out, because a fact that could not be measured has to read as one
        // and never as an empty column.
        spend: byTenant.get(tenant.slug) ?? null,
        model: {
          current,
          label: modelChoices.find((row) => row.alias === current)?.name ?? "",
          choices: modelChoices,
          why: modelWhy.length > 0
            ? modelWhy
            : current.length > 0
              ? "read out of the proxy's request log: this is what this workspace has actually run inside the current window."
              : "this workspace has run nothing through the proxy inside the current window, so what it is pointed at cannot be read from here. Its own file is the only place that says, and this service cannot read inside a box.",
        },
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

  // ---- PROVIDERS-1: providers, their keys, and the plan models they serve -----------------------
  //
  // Jason, 2026-09-08: "say I have to roll a key, or I want to add a provider or add a third,
  // second, or fourth key on a specific model plan... the mechanism for both me and the AI agent
  // needs to be able to do this on our own."
  //
  // Until this wave all of that was a text file on the R750 plus a proxy restart, which is a hand
  // operation on the product. Everything below is that operation as a route. The CONTROL PLANE is
  // the only thing in the product that talks to the proxy's admin API: the admin page's CSP is
  // connect-src 'self' and the proxy has no published port, so the browser could not reach it and
  // a browser that could would be the proxy on the internet.
  //
  // TWO RULES THAT ARE TESTED RATHER THAN TRUSTED.
  //
  //   A key value arrives in a POST body and leaves through nothing. Not a GET, not a URL, not a
  //   query string, not a ledger row, not a log line. tests/cp-server sweeps every route for a
  //   planted one and tests/cp-store sweeps the ledger.
  //
  //   Every change writes an admin_actions row BEFORE the proxy call and finishes it after. A
  //   change that half succeeded is on the record as 'started', which is the only state worth
  //   investigating and the one a single write-after-the-fact would lose.

  const SETTING_DEFAULT_MODEL = "default_plan_model";
  const SETTING_PROVIDERS = "providers";
  const catalogSetting = (id) => `catalog:${id}`;
  const catalogSlotSetting = (id) => `catalog_slot:${id}`;
  const quotaSetting = (slot) => `quota:${slot}`;
  // How far back "a box has run this model" looks. Thirty days rather than the spend panel's
  // calendar month, because "nobody has used this since the 2nd" on the 3rd of the month is not
  // evidence that a model is unused.
  const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  // The chip the allowance already uses, applied to a vendor plan window as well.
  const QUOTA_WARN_PCT = 80;

  /** A credential proved without being carried: how long it is and the first bytes of its digest. */
  const keyEvidence = (value) => `${String(value ?? "").length} characters, sha256 ${createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, 8)}`;

  const readJsonSetting = (name, fallback) => {
    const raw = store.getSetting(name, "");
    if (raw.length === 0) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  };
  const writeJsonSetting = (name, value, actor) => store.setSetting(name, JSON.stringify(value), actor);

  /**
   * The providers this console offers, which is the presets plus whatever the operator has added.
   *
   * The presets are a starting point and never a ceiling: an id the operator registered overrides
   * the preset of the same name field for field, and an id nobody has ever heard of is theirs. The
   * order is stable so the panel does not reshuffle under a click.
   */
  function providerList() {
    const added = readJsonSetting(SETTING_PROVIDERS, []);
    const byId = new Map();
    for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
      byId.set(id, { id, ...preset, curated: [...preset.curated], bootstrapEnv: [...preset.bootstrapEnv], fromPreset: true });
    }
    for (const row of Array.isArray(added) ? added : []) {
      const id = String(row?.id ?? "").trim();
      if (id.length === 0) continue;
      const existing = byId.get(id) ?? { id, fromPreset: false };
      byId.set(id, {
        ...existing,
        id,
        name: String(row?.name ?? existing.name ?? id),
        kind: String(row?.kind ?? existing.kind ?? "openai"),
        baseUrl: String(row?.baseUrl ?? existing.baseUrl ?? ""),
        catalogBaseUrl: String(row?.catalogBaseUrl ?? existing.catalogBaseUrl ?? ""),
        catalogPath: String(row?.catalogPath ?? existing.catalogPath ?? ""),
        curated: Array.isArray(row?.curated) ? row.curated.map(String) : (existing.curated ?? []),
        bootstrapEnv: Array.isArray(existing.bootstrapEnv) ? existing.bootstrapEnv : [],
        fromPreset: existing.fromPreset === true,
      });
    }
    return [...byId.values()];
  }
  const providerById = (id) => providerList().find((row) => row.id === String(id));

  /** Where a provider's catalog is read from. Its own address when it has one, its base url when not. */
  const catalogTargetOf = (provider) => String(provider?.catalogBaseUrl ?? "") || String(provider?.baseUrl ?? "");

  /**
   * The next free slot name for a provider's pool: zai-1, zai-2, and so on.
   *
   * The NAME is the handle for every write after this one -- the roll, the park, the removal -- so
   * it has to be stable and it has to be readable in a ledger row six months later. Numbers are
   * never reused: a slot that was removed leaves its number spent, because a spend row pointing at
   * `zai-2` has to keep meaning the subscription it meant when it was written.
   */
  function nextSlot(providerId, taken) {
    const prefix = `${providerId}-`;
    let highest = 0;
    for (const name of taken) {
      if (!name.startsWith(prefix)) continue;
      const number = Number(name.slice(prefix.length));
      if (Number.isInteger(number) && number > highest) highest = number;
    }
    return `${prefix}${highest + 1}`;
  }

  /** The deployment id this product gives one alias on one key slot. Ours, tracked, and readable. */
  const deploymentIdFor = (alias, slot) => `tb-${String(alias)}-${String(slot)}`.replace(/[^a-zA-Z0-9._-]/g, "-");

  /** The vendor model with its LiteLLM provider prefix, added when the operator did not type one. */
  function prefixedModel(provider, vendorModel) {
    const wanted = String(vendorModel ?? "").trim();
    if (wanted.length === 0) return "";
    if (wanted.includes("/")) return wanted;
    const kind = String(provider?.kind ?? "openai");
    return `${kind}/${wanted}`;
  }

  /**
   * One change, on the record, before it happens.
   *
   * Handed back as a pair of closures so a route reads as begin, do the thing, say how it went. The
   * detail string is written by the caller and is never allowed a key value: keyEvidence above is
   * what a caller uses to say WHICH key without saying what it is.
   */
  // Where a change came from, which is a fact about the CALLER and not about the route. cp/cli.mjs
  // sets this header so a change made without a browser is on the same record and can be told
  // apart; the console sends nothing and reads as "console". Nothing is trusted from it beyond the
  // one word, and the word is chosen from a fixed set rather than echoed.
  const viaOf = (request) => (String(request?.headers?.["x-titanbot-via"] ?? "").toLowerCase() === "cli" ? "cli" : "console");

  function beginAction(guard, request, { action, target = "", detail = "", via = "" }) {
    const id = store.recordAdminAction({
      at: now(),
      actor: guard?.account?.email ?? "the operator token",
      via: via || viaOf(request),
      ip: clientOf(request),
      action, target, detail,
      outcome: "started",
    });
    return {
      id,
      done: (detailAfter = "") => store.finishAdminAction(id, "ok", detailAfter),
      failed: (why) => store.finishAdminAction(id, `failed: ${String(why ?? "").split("\n")[0].slice(0, 300)}`),
    };
  }

  /**
   * The proxy's whole shape, read once per request that needs it.
   *
   * Four reads, in parallel, and NOT cached: this is the page an operator refreshes after making a
   * change, and a cached answer would show them the state before their own edit. The spend sweep it
   * joins against IS cached, and that is the right way round -- spend moves on a batch write and
   * configuration moves on a click.
   */
  async function proxyShape() {
    const [db, deployments, credentials, health, passThrough] = await Promise.all([
      askProxy("/model/info (db flag)", () => proxy.storeModelInDb()),
      askProxy("/model/info", () => proxy.listModels()),
      askProxy("/credentials", () => proxy.listCredentials()),
      askProxy("/health/latest", () => proxy.healthLatest()),
      askProxy("/config/pass_through_endpoint", () => proxy.listPassThrough()),
    ]);
    return { db, deployments, credentials, health, passThrough };
  }

  /**
   * Which workspaces have actually RUN an alias, measured out of the proxy's own request log.
   *
   * There is no other honest source. What a box runs lives in its own box-secrets.json, which only
   * the relay can read and which it has no route to report; this service's stored per tenant record
   * lists what is INCLUDED in a plan and not which one is selected. So "three workspaces run this"
   * is a measurement of requests, over a named window, and every answer that carries it says so.
   */
  function ranAlias(sweep, alias) {
    if (!sweep?.month?.ok) return { slugs: [], why: sweep?.month?.why ?? "the proxy's request log could not be read", measured: false };
    const slugs = [];
    for (const row of sweep.month.keys) {
      const alias_ = String(row.alias ?? "");
      if (!alias_.startsWith("titanbot-")) continue;
      if (!row.models.some((one) => String(one.model) === String(alias))) continue;
      slugs.push(alias_.slice("titanbot-".length));
    }
    return { slugs, why: "", measured: true };
  }

  /**
   * A vendor plan window for one key slot, in the vendor's own unit.
   *
   * WHAT IS OURS AND WHAT IS THEIRS, kept apart on purpose. The USED figure is ours: it is counted
   * out of the proxy's per-key request log, so it is exact for traffic that went through this
   * product and blind to anything the same subscription is spending elsewhere. The TOTAL and the
   * RESET are the vendor's, and this build has no endpoint that reports either (see PROVIDER_QUOTA
   * in cp/proxy.mjs for the four probes and their 404s), so they are typed in once by the operator
   * off the vendor's own page and stored here.
   *
   * That makes the bar an ESTIMATE and it is labelled one everywhere it is drawn. It is still the
   * thing Jason asked for: the Alibaba plan that ran to 42.9 percent remaining is a plan nobody was
   * watching, and a bar that says "our count, calibrated against their page on the 8th" is the
   * difference between noticing at 80 percent and noticing at zero.
   */
  function quotaFor(slot, provider, share) {
    const stored = readJsonSetting(quotaSetting(slot), null);
    const known = PROVIDER_QUOTA[String(provider?.id ?? "")] ?? null;
    const unit = String(stored?.unit ?? known?.unit ?? "requests");
    const used = unit === "thousands of tokens"
      ? Math.round(share.tokens / 1000)
      : (unit === "prompts" || unit === "requests" ? share.requests : Math.round(share.dollars * 100) / 100);
    const total = Number(stored?.total) > 0 ? Number(stored.total) : null;
    const resetAt = String(stored?.resetAt ?? "");
    const pct = total != null && total > 0 ? Math.round((used / total) * 100) : null;
    return {
      unit,
      window: String(stored?.window ?? known?.windows?.[0] ?? ""),
      used,
      total,
      remaining: total != null ? Math.max(0, total - used) : null,
      pct,
      resetAt,
      warn: pct != null && pct >= QUOTA_WARN_PCT,
      // Never true on this build, and it is a field rather than a comment so the page does not have
      // to be edited on the day a vendor endpoint is found.
      live: false,
      why: total == null
        ? `Nothing is set for this subscription's plan size yet, so there is no bar to draw. Read the total and the reset off ${provider?.name ?? "the vendor"}'s own page and set them here; what we count against it is ${used} ${unit} through this key.`
        : `Our own count of what went through this key, ${used} of ${total} ${unit}. ${known?.why ?? ""} Set against ${provider?.name ?? "the vendor"}'s page on ${new Date(Number(stored?.at ?? 0)).toISOString().slice(0, 10)}.`.trim(),
      // WHICH CUSTOMER used it, inside the same window. The second half of what Jason asked for.
      byWorkspace: share.byWorkspace,
    };
  }

  /** One key slot's share of a window, and each workspace's share of that. */
  function slotShare(sweep, deploymentIds) {
    const ids = new Set(deploymentIds.map(String));
    const empty = { requests: 0, tokens: 0, dollars: 0, byWorkspace: [], measured: false, why: "" };
    if (!sweep?.month?.ok) return { ...empty, why: sweep?.month?.why ?? "the proxy's request log could not be read" };
    let requests = 0;
    let tokens = 0;
    let dollars = 0;
    for (const row of sweep.month.deployments ?? []) {
      if (!ids.has(String(row.id))) continue;
      requests += row.requests;
      tokens += row.tokens;
      dollars += row.dollars;
    }
    const byWorkspace = [];
    for (const key of sweep.month.keys ?? []) {
      const alias = String(key.alias ?? "");
      if (!alias.startsWith("titanbot-")) continue;
      let theirs = { requests: 0, tokens: 0, dollars: 0 };
      for (const row of key.deployments ?? []) {
        if (!ids.has(String(row.id))) continue;
        theirs = {
          requests: theirs.requests + row.requests,
          tokens: theirs.tokens + row.tokens,
          dollars: Math.round((theirs.dollars + row.dollars) * 1e6) / 1e6,
        };
      }
      if (theirs.requests === 0 && theirs.tokens === 0) continue;
      byWorkspace.push({ slug: alias.slice("titanbot-".length), ...theirs });
    }
    byWorkspace.sort((a, b) => b.requests - a.requests);
    return { requests, tokens, dollars: Math.round(dollars * 1e6) / 1e6, byWorkspace, measured: true, why: "" };
  }

  /**
   * THE WHOLE PANEL IN ONE FETCH.
   *
   * One call renders the page: providers, their pools, the plan models, the defaults and the ten
   * most recent changes. It is one fetch rather than six because six would be six chances for the
   * page to render half a state, and because the joins between them (which slot serves which alias,
   * which workspace spent inside which key's window) can only be done where all of it is in hand.
   */
  async function providersAnswer() {
    const off = proxyOff();
    const at = now();
    const actions = store.listAdminActions({ limit: 10 }).map((row) => ({ ...row, at: new Date(row.at).toISOString() }));
    const defaults = {
      planModel: store.getSetting(SETTING_DEFAULT_MODEL, ""),
      why: store.getSetting(SETTING_DEFAULT_MODEL, "").length === 0
        ? "No default is set, so a new workspace is scoped to every plan model the proxy serves and its console picks the first one."
        : "",
    };
    if (off) {
      return {
        configured: false, why: off,
        db: { on: null, why: off },
        providers: [], planModels: [], defaults, actions,
        measuredAt: new Date(at).toISOString(),
      };
    }
    const [shape, sweep] = await Promise.all([proxyShape(), askProxySpend()]);
    const deployments = shape.deployments.ok ? shape.deployments.rows : [];
    const credentials = shape.credentials.ok ? shape.credentials.rows : [];
    const healthRows = shape.health.ok ? shape.health.rows : [];
    const healthById = new Map(healthRows.map((row) => [row.id, row]));
    const passThroughPaths = new Set((shape.passThrough.ok ? shape.passThrough.rows : []).map((row) => row.path));

    // ---- the pools -----------------------------------------------------------------------------
    const providers = [];
    for (const provider of providerList()) {
      const mine = credentials.filter((row) => row.provider === provider.id || row.name.startsWith(`${provider.id}-`));
      const catalog = readJsonSetting(catalogSetting(provider.id), null);
      const keys = mine.map((credential) => {
        const serving = deployments.filter((row) => row.keySlot === credential.name);
        const share = slotShare(sweep, serving.map((row) => row.id));
        const lastError = serving
          .map((row) => healthById.get(row.id))
          .filter((row) => row != null && String(row.status ?? "").toLowerCase() !== "healthy")
          .map((row) => ({ at: row.at, why: row.why }))[0] ?? null;
        return {
          slot: credential.name,
          label: credential.label,
          order: credential.order ?? 0,
          // THE PROXY'S OWN MASK, passed through as it came. Never something this side computed: a
          // mask built here would be a mask this file could get wrong, and a wrong mask on a key
          // page is how somebody concludes the wrong key is in the slot.
          masked: credential.masked,
          parked: credential.parked,
          spend: { month: share.dollars, requests: share.requests, why: share.why },
          quota: quotaFor(credential.name, provider, share),
          lastError,
          serves: [...new Set(serving.map((row) => row.alias))],
          backsCatalog: store.getSetting(catalogSlotSetting(provider.id), "") === credential.name,
        };
      }).sort((a, b) => (a.order - b.order) || a.slot.localeCompare(b.slot));
      providers.push({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        fromPreset: provider.fromPreset === true,
        bootstrapEnv: provider.bootstrapEnv ?? [],
        health: keys.length === 0
          ? { reachable: null, why: "no key here yet, so there is nothing to reach", checkedAt: "" }
          : { reachable: keys.every((row) => row.lastError == null), why: keys.find((row) => row.lastError != null)?.lastError?.why ?? "", checkedAt: new Date(at).toISOString() },
        catalog: {
          models: Array.isArray(catalog?.models) ? catalog.models : [...(provider.curated ?? [])],
          live: catalog?.live === true,
          readAt: String(catalog?.readAt ?? ""),
          why: catalog?.live === true ? "" : String(catalog?.why ?? "This is the short list this product has actually run. Refresh reads the vendor's own list once a key is in."),
          // Said on the page in these words, because a refresh CANNOT infer either of them.
          note: "This is a list of names. The context window and whether a model takes an image are things you set.",
          ready: catalogTargetOf(provider).length > 0 && String(provider.catalogPath ?? "").length > 0,
          wired: passThroughPaths.has(`/catalog/${provider.id}`),
        },
        keys,
      });
    }

    // ---- the plan models -----------------------------------------------------------------------
    const byAlias = new Map();
    for (const row of deployments) {
      const list = byAlias.get(row.alias) ?? [];
      list.push(row);
      byAlias.set(row.alias, list);
    }
    const planModels = [];
    for (const [alias, rows] of byAlias) {
      if (!isPlanModel(alias)) continue;
      // THE ROW THAT CARRIES THE PRODUCT'S OWN FACTS. During the move off a file-configured proxy
      // the same alias has file deployments and database ones, and only the database ones carry
      // customerName, customerLabel and the rest: a file row has none of it. Reading rows[0] meant
      // the panel showed every plan model with no customer name, every one therefore counted as not
      // shown to customers, and push-label pushed an empty label into a box. The database row is the
      // one that knows, and rows[0] is only a fallback for an install that has not been seeded.
      const first = rows.find((row) => row.fromDb === true) ?? rows[0];
      const ran = ranAlias(sweep, alias);
      const fallback = await askProxy(`/fallback/${alias}`, () => proxy.getFallback(alias));
      planModels.push({
        alias,
        provider: first.provider,
        vendorModel: first.vendorModel,
        customerName: first.customerName,
        customerLabel: first.customerLabel,
        servedBy: first.servedBy,
        contextWindow: first.contextWindow,
        supportsVision: rows.some((row) => row.supportsVision),
        visionFallback: fallback.ok ? (fallback.fallbacks[0] ?? "") : first.visionFallback,
        vision: { ok: first.visionOk, at: first.visionAt, why: first.visionAt ? "" : "this model has never been asked whether it takes an image" },
        plans: first.plans,
        customerVisible: first.customerVisible,
        // The one rule that keeps a routing target off a customer's page, said on the operator's
        // page too so the reason a row is missing from Settings is visible here.
        shownToCustomers: first.customerVisible === true && String(first.customerLabel ?? "").length > 0 && String(first.customerName ?? "").length > 0,
        deployments: rows.map((row) => ({
          id: row.id,
          keySlot: row.keySlot,
          fromDb: row.fromDb,
          healthy: String(healthById.get(row.id)?.status ?? "").toLowerCase() === "healthy" ? true : (healthById.has(row.id) ? false : null),
          why: healthById.get(row.id)?.why ?? "",
        })),
        workspaces: ran.slugs.length,
        workspaceSlugs: ran.slugs,
        workspacesWhy: ran.measured
          ? "workspaces whose key ran this model inside the current spend window. What a box is pointed at lives in its own file, which this service cannot read."
          : ran.why,
        // NOT MEASURABLE FROM HERE, and named rather than left as a zero. The label lives in each
        // box's box-secrets.json; nothing reports it back. Pushing it is safe at any time and only
        // touches the workspaces the operator names.
        labelBehind: null,
        labelBehindWhy: "the label a customer's Titan says lives inside each box, and nothing reports it back to this service. Push it to be sure.",
      });
    }
    planModels.sort((a, b) => a.alias.localeCompare(b.alias));

    return {
      configured: true,
      why: "",
      db: { on: shape.db.ok ? shape.db.on : null, why: shape.db.ok ? shape.db.why : shape.db.why },
      providers,
      planModels,
      defaults,
      actions,
      window: sweep.month.ok ? { month: `${sweep.monthStart} to ${sweep.today}` } : { month: "", why: sweep.month.why },
      measuredAt: new Date(at).toISOString(),
    };
  }

  /**
   * The vendor's own model list, read THROUGH the proxy so this container holds no vendor key.
   *
   * The pass-through carries the key on its far side and the master key on ours. When there is no
   * pass-through for this provider, or the vendor did not answer, the curated list is the answer and
   * `live` says which of the two the operator is looking at. A refresh that quietly fell back would
   * be a page showing yesterday's names as though they were today's.
   */
  async function refreshCatalog(provider, actor) {
    const target = catalogTargetOf(provider);
    const pathname = String(provider.catalogPath ?? "");
    const curated = { models: [...(provider.curated ?? [])], live: false, readAt: new Date(now()).toISOString() };
    if (target.length === 0 || pathname.length === 0) {
      const answer = { ...curated, why: `${provider.name} has no model list to read, so this is the short list this product has run.` };
      writeJsonSetting(catalogSetting(provider.id), answer, actor);
      return answer;
    }
    const read = await askProxy(`/catalog/${provider.id}`, () => proxy.catalog(provider.id, { pathname }));
    if (!read.ok || read.models.length === 0) {
      // A FAILED REFRESH DOES NOT THROW AWAY A LIST THAT WAS ONCE REAL. Falling back to the curated
      // six when the vendor was briefly unreachable would quietly delete names the operator had
      // read from the vendor an hour ago, and the page would look like the vendor had retired them.
      // The last live list is kept, dated, and marked stale instead.
      const last = readJsonSetting(catalogSetting(provider.id), null);
      const answer = last?.live === true
        ? {
          models: last.models,
          live: false,
          readAt: String(last.readAt ?? ""),
          why: `${provider.name}'s own list could not be read just now (${read.ok ? "it answered with no models" : read.why}). These are the names it gave on ${String(last.readAt ?? "an earlier refresh").slice(0, 10)}.`,
        }
        : {
          ...curated,
          why: read.ok
            ? `${provider.name} answered with no models, so this is the short list this product has run.`
            : `${provider.name}'s own list could not be read (${read.why}), so this is the short list this product has run.`,
        };
      writeJsonSetting(catalogSetting(provider.id), answer, actor);
      return answer;
    }
    const answer = { models: read.models, live: true, readAt: new Date(now()).toISOString(), why: "" };
    writeJsonSetting(catalogSetting(provider.id), answer, actor);
    return answer;
  }

  /**
   * The catalog door, pointed at whichever key is backing it.
   *
   * Registered on the first key a provider gets and re-registered when that key is rolled, because
   * the key rides in the pass-through's header rather than in a credential. It is the one place in
   * this file that puts a key ANYWHERE other than /credentials, and it is why listPassThrough drops
   * the header values before anything can render them: unlike /credentials, LiteLLM returns a
   * pass-through's headers in the clear.
   */
  async function wireCatalog(provider, apiKey, slot) {
    const target = catalogTargetOf(provider);
    if (target.length === 0 || String(provider.catalogPath ?? "").length === 0) {
      return { ok: true, wired: false, why: `${provider.name} has no model list to read` };
    }
    const path_ = `/catalog/${provider.id}`;
    const existing = await askProxy("/config/pass_through_endpoint", () => proxy.listPassThrough());
    if (existing.ok) {
      for (const row of existing.rows.filter((one) => one.path === path_)) {
        await askProxy("/config/pass_through_endpoint delete", () => proxy.deletePassThrough(row.id));
      }
    }
    const added = await askProxy("/config/pass_through_endpoint add", () => proxy.addPassThrough({
      path: path_,
      target,
      headers: { authorization: `Bearer ${apiKey}` },
      includeSubpath: true,
    }));
    if (!added.ok) return { ok: false, wired: false, why: added.why };
    store.setSetting(catalogSlotSetting(provider.id), slot, "");
    return { ok: true, wired: true, why: "" };
  }

  /** Every plan alias the proxy serves right now, which is what a tenant key is scoped to. */
  async function servedAliases() {
    const listed = await askProxy("/model/info", () => proxy.listModels());
    if (!listed.ok) return { ok: false, why: listed.why, aliases: [] };
    return { ok: true, why: "", aliases: servedPlanModels({ deployments: listed.rows }) };
  }

  /**
   * The sweep that widens every tenant key's model scope to include a new alias.
   *
   * IT WRITES NOTHING INTO A BOX. /key/update takes the same key value the box already holds, so
   * there is no re-mint, no new credential in anybody's file and none of the registry hazard that
   * wrote a REVOKED key back into a box on 2026-09-08. On the page it is one button reading "Give
   * every workspace access to this model", and it is safe to press twice.
   */
  async function applyToEveryKey() {
    const served = await servedAliases();
    if (!served.ok) return { ok: false, why: served.why, rows: [] };
    const rows = [];
    for (const tenant of store.listTenants()) {
      const record = proxyKeyOf(tenant.slug);
      if (record == null) { rows.push({ slug: tenant.slug, ok: false, why: "this workspace has no plan key yet" }); continue; }
      const answer = await askProxy("/key/update", () => proxy.updateKey({
        key: record.key,
        models: served.aliases,
        allowedRoutes: TENANT_ALLOWED_ROUTES,
      }));
      rows.push({ slug: tenant.slug, ok: answer.ok === true, why: answer.ok ? "" : answer.why });
    }
    return { ok: rows.some((row) => row.ok), why: "", rows, models: served.aliases };
  }

  /** The relay's box door, which is the only thing that can write inside a customer's box. */
  async function askRelayPost(pathname, body) {
    if (relayBase.length === 0 || String(config.relayToken ?? "").length === 0) {
      return { ok: false, why: "this control plane has no relay configured (CP_RELAY_URL and CP_RELAY_TOKEN), and only the relay can write inside a box" };
    }
    try {
      const response = await fetchImpl(`${relayBase}${pathname}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.relayToken}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(relayTimeoutMs),
      });
      const text = await response.text();
      let parsed = null;
      if (text.length > 0) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
      if (!response.ok) return { ok: false, why: `the relay answered ${response.status}${parsed?.message ? `: ${String(parsed.message).split("\n")[0].slice(0, 200)}` : ""}` };
      return { ok: true, body: parsed ?? {} };
    } catch (error) {
      return { ok: false, why: error?.name === "TimeoutError" ? "the relay did not answer in time" : `the relay did not answer (${notMeasured(error)})` };
    }
  }

  /**
   * One workspace pointed at one plan model, label and all.
   *
   * The relay's use-included door writes the base url, the model, the endpoint name, the served-by
   * line, the context window AND the label in one write, which is why setting a workspace's model
   * and pushing a label are the same call with a different reason for making it. It takes effect on
   * that box's next message, because the host re-reads box-secrets.json every turn.
   */
  const pointWorkspaceAt = (slug, alias) => askRelayPost(`/admin/tenants/${encodeURIComponent(slug)}/use-included`, { model: alias });

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

    // ---- PROVIDERS-1: the providers panel --------------------------------------------------------

    if (rest.length === 1 && rest[0] === "providers" && method === "GET") {
      json(response, 200, await providersAnswer());
      return true;
    }

    if (rest.length === 1 && rest[0] === "actions" && method === "GET") {
      const sinceMs = Number(url.searchParams.get("sinceMs") ?? 0);
      json(response, 200, {
        rows: store.listAdminActions({
          sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0,
          limit: Number(url.searchParams.get("limit") ?? 200),
        }).map((row) => ({ ...row, at: new Date(row.at).toISOString() })),
        total: store.countAdminActions(),
        // Said here as well as in docs/ADMIN.md, because the retention of a record is part of what
        // the record means. "Who changed the plan model in March" is a question asked in June.
        retention: "these rows are never pruned",
        measuredAt: new Date(now()).toISOString(),
      });
      return true;
    }

    // A provider registered. No proxy call: a provider is a label until it has a key.
    if (rest.length === 1 && rest[0] === "providers" && method === "POST") {
      const id = String(body?.id ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) {
        json(response, 400, { error: "bad_request", message: "A provider needs a short name in lower case letters, numbers and dashes." });
        return true;
      }
      const ledger = beginAction(guard, request, { action: "provider.add", target: id, detail: `${String(body?.name ?? id)} at ${String(body?.baseUrl ?? "no base url")}` });
      const added = readJsonSetting(SETTING_PROVIDERS, []);
      const rows = (Array.isArray(added) ? added : []).filter((row) => String(row?.id ?? "") !== id);
      rows.push({
        id,
        name: String(body?.name ?? id),
        kind: String(body?.kind ?? "openai"),
        baseUrl: String(body?.baseUrl ?? ""),
        catalogBaseUrl: String(body?.catalogBaseUrl ?? ""),
        catalogPath: String(body?.catalogPath ?? ""),
        curated: Array.isArray(body?.curated) ? body.curated.map(String) : [],
      });
      writeJsonSetting(SETTING_PROVIDERS, rows, guard.account?.email ?? "the operator token");
      ledger.done();
      json(response, 200, { provider: providerById(id), message: `${String(body?.name ?? id)} is registered. Add a key to it and it can serve a plan model.` });
      return true;
    }

    // A key added to a pool. THE VALUE ARRIVES HERE AND LEAVES THROUGH NOTHING.
    if (rest.length === 3 && rest[0] === "providers" && rest[2] === "keys" && method === "POST") {
      const provider = providerById(decodeURIComponent(rest[1]));
      if (provider == null) { json(response, 404, { error: "not_found", message: "There is no provider by that name." }); return true; }
      const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
      if (apiKey.length < 8) {
        json(response, 400, { error: "bad_request", message: "Paste the key. Nothing was stored." });
        return true;
      }
      const existing = await askProxy("/credentials", () => proxy.listCredentials());
      if (!existing.ok) { json(response, 502, { error: "proxy", message: existing.why }); return true; }
      const slot = String(body?.slot ?? "").trim() || nextSlot(provider.id, existing.rows.map((row) => row.name));
      if (existing.rows.some((row) => row.name === slot)) {
        json(response, 409, { error: "exists", message: `There is already a key in slot ${slot}. Roll it if you are replacing it.` });
        return true;
      }
      const label = String(body?.label ?? `subscription ${slot.split("-").pop()}`);
      const order = Number(body?.order) > 0 ? Number(body.order) : existing.rows.filter((row) => row.provider === provider.id).length + 1;
      const ledger = beginAction(guard, request, {
        action: "provider.key.add",
        target: `${provider.id}/${slot}`,
        // The key is proved and not carried. This string is what a ledger row holds forever.
        detail: `added a key to slot ${slot} (${keyEvidence(apiKey)})`,
      });
      const added = await askProxy("/credentials", () => proxy.addCredential({
        name: slot,
        apiKey,
        baseUrl: provider.baseUrl,
        info: { [TB.provider]: provider.id, [TB.keyLabel]: label, [TB.keyOrder]: order, tb_parked: false },
      }));
      if (!added.ok) { ledger.failed(added.why); json(response, 502, { error: "proxy", message: added.why }); return true; }
      // The catalog door goes on the FIRST key a provider gets, so a Refresh works the moment there
      // is something to refresh with.
      let wired = { wired: false, why: "" };
      if (store.getSetting(catalogSlotSetting(provider.id), "").length === 0) {
        wired = await wireCatalog(provider, apiKey, slot);
      }
      ledger.done(`slot ${slot} now holds a key (${keyEvidence(apiKey)})${wired.wired ? ", and the model list reads through it" : ""}`);
      json(response, 200, {
        slot,
        label,
        catalog: wired,
        message: `The key is in slot ${slot}. It serves nothing until a plan model is pointed at it.`,
        // NOT the key. The mask is read back from the proxy on the next panel load.
        evidence: keyEvidence(apiKey),
      });
      return true;
    }

    if (rest.length === 5 && rest[0] === "providers" && rest[2] === "keys" && method === "POST") {
      const provider = providerById(decodeURIComponent(rest[1]));
      if (provider == null) { json(response, 404, { error: "not_found", message: "There is no provider by that name." }); return true; }
      const slot = decodeURIComponent(rest[3]);
      const action = rest[4];
      const credentials = await askProxy("/credentials", () => proxy.listCredentials());
      if (!credentials.ok) { json(response, 502, { error: "proxy", message: credentials.why }); return true; }
      const credential = credentials.rows.find((row) => row.name === slot);
      if (credential == null) { json(response, 404, { error: "not_found", message: `There is no key in slot ${slot}.` }); return true; }
      const models = await askProxy("/model/info", () => proxy.listModels());
      if (!models.ok) { json(response, 502, { error: "proxy", message: models.why }); return true; }
      const serving = models.rows.filter((row) => row.keySlot === slot);

      // THE ZERO-GAP ROLL. The credential is patched IN PLACE under a name that does not change, so
      // no deployment is touched and no request can land between two states. Measured at 0.033 s on
      // this Mac against the real image.
      if (action === "roll") {
        const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
        if (apiKey.length < 8) { json(response, 400, { error: "bad_request", message: "Paste the new key. Nothing was changed." }); return true; }
        const ledger = beginAction(guard, request, {
          action: "provider.key.roll",
          target: `${provider.id}/${slot}`,
          detail: `rolling the key in slot ${slot} (${keyEvidence(apiKey)})`,
        });
        const rolled = await askProxy("/credentials patch", () => proxy.patchCredential({ name: slot, apiKey }));
        if (!rolled.ok) { ledger.failed(rolled.why); json(response, 502, { error: "proxy", message: rolled.why }); return true; }
        let wired = { wired: false, why: "" };
        if (store.getSetting(catalogSlotSetting(provider.id), "") === slot) wired = await wireCatalog(provider, apiKey, slot);
        ledger.done(`slot ${slot} now holds a different key (${keyEvidence(apiKey)})`);
        json(response, 200, {
          slot,
          catalog: wired,
          message: `Slot ${slot} holds the new key. The pool never changed shape, so nothing was taken out of service and requests in flight kept working. The proxy caches a key for up to its cache window, so a request already under way may finish on the old one.`,
          evidence: keyEvidence(apiKey),
        });
        return true;
      }

      // Parked means stored and serving nothing. The deployments that reference it are removed and
      // written down here, so unparking rebuilds exactly what was taken away.
      if (action === "park") {
        const parked = body?.parked !== false;
        if (parked) {
          const orphaned = [...new Set(serving
            .filter((row) => !models.rows.some((other) => other.alias === row.alias && other.keySlot !== slot))
            .map((row) => row.alias))];
          if (orphaned.length > 0) {
            json(response, 409, {
              error: "last_key",
              message: `Parking ${slot} would leave ${orphaned.join(", ")} with nothing to run on. Add another key to this provider first.`,
            });
            return true;
          }
          const ledger = beginAction(guard, request, { action: "provider.key.park", target: `${provider.id}/${slot}`, detail: `parking ${slot}, which serves ${serving.length} deployment(s)` });
          const snapshot = [];
          for (const row of serving) {
            snapshot.push({ alias: row.alias, vendorModel: row.vendorModel, id: row.id, contextWindow: row.contextWindow, supportsVision: row.supportsVision, customerName: row.customerName, customerLabel: row.customerLabel, servedBy: row.servedBy, customerVisible: row.customerVisible, visionFallback: row.visionFallback, plans: row.plans, keyLabel: row.keyLabel, keyOrder: row.keyOrder });
            const removed = await askProxy("/model/delete", () => proxy.deleteModel(row.id));
            if (!removed.ok) { ledger.failed(removed.why); json(response, 502, { error: "proxy", message: removed.why }); return true; }
          }
          writeJsonSetting(`parked:${slot}`, snapshot, guard.account?.email ?? "the operator token");
          await askProxy("/credentials patch", () => proxy.patchCredential({ name: slot, info: { [TB.provider]: provider.id, [TB.keyLabel]: credential.label, [TB.keyOrder]: credential.order, tb_parked: true } }));
          ledger.done(`${slot} is parked; ${snapshot.length} deployment(s) taken out of service`);
          json(response, 200, { slot, parked: true, removed: snapshot.length, message: `${slot} is parked. The key is still stored and it serves nothing. Traffic is on the rest of the pool from the next request.` });
          return true;
        }
        const snapshot = readJsonSetting(`parked:${slot}`, []);
        const ledger = beginAction(guard, request, { action: "provider.key.unpark", target: `${provider.id}/${slot}`, detail: `putting ${slot} back into service` });
        const back = [];
        for (const row of Array.isArray(snapshot) ? snapshot : []) {
          const added = await askProxy("/model/new", () => proxy.addModel({
            alias: row.alias,
            vendorModel: row.vendorModel,
            credentialName: slot,
            id: row.id,
            params: provider.baseUrl ? { api_base: provider.baseUrl } : {},
            info: {
              ...(row.contextWindow ? { max_input_tokens: row.contextWindow } : {}),
              supports_vision: row.supportsVision === true,
              [TB.provider]: provider.id,
              [TB.keySlot]: slot,
              [TB.keyLabel]: row.keyLabel ?? credential.label,
              [TB.keyOrder]: row.keyOrder ?? credential.order,
              [TB.customerName]: row.customerName ?? "",
              [TB.customerLabel]: row.customerLabel ?? "",
              [TB.servedBy]: row.servedBy ?? "",
              [TB.customerVisible]: row.customerVisible === true,
              [TB.visionFallback]: row.visionFallback ?? "",
              [TB.plans]: row.plans ?? [],
            },
          }));
          back.push({ alias: row.alias, ok: added.ok === true, why: added.ok ? "" : added.why });
        }
        await askProxy("/credentials patch", () => proxy.patchCredential({ name: slot, info: { [TB.provider]: provider.id, [TB.keyLabel]: credential.label, [TB.keyOrder]: credential.order, tb_parked: false } }));
        ledger.done(`${slot} is back in service on ${back.filter((row) => row.ok).length} deployment(s)`);
        json(response, 200, { slot, parked: false, restored: back, message: `${slot} is serving again from the next request.` });
        return true;
      }

      if (action === "remove") {
        if (String(body?.confirm ?? "") !== slot) {
          json(response, 400, { error: "confirm", message: `Type ${slot} to remove it. Nothing was changed.` });
          return true;
        }
        if (serving.length > 0) {
          json(response, 409, {
            error: "in_use",
            message: `${slot} is still serving ${[...new Set(serving.map((row) => row.alias))].join(", ")}. Park it or point those at another key first.`,
          });
          return true;
        }
        const ledger = beginAction(guard, request, { action: "provider.key.remove", target: `${provider.id}/${slot}`, detail: `removing slot ${slot}` });
        const removed = await askProxy("/credentials delete", () => proxy.deleteCredential(slot));
        if (!removed.ok) { ledger.failed(removed.why); json(response, 502, { error: "proxy", message: removed.why }); return true; }
        ledger.done(`slot ${slot} removed`);
        json(response, 200, { slot, message: `${slot} is gone. Its number is not reused, so old spend rows still mean what they said.` });
        return true;
      }

      // The vendor's own plan window, typed in once off their page. See quotaFor: the USED figure
      // is ours and exact, the total and the reset are theirs and are not on any endpoint this
      // build could find.
      if (action === "quota") {
        const total = Number(body?.total);
        const ledger = beginAction(guard, request, {
          action: "provider.key.quota",
          target: `${provider.id}/${slot}`,
          detail: `plan window set to ${Number.isFinite(total) ? total : "nothing"} ${String(body?.unit ?? "")}`,
        });
        writeJsonSetting(quotaSetting(slot), {
          total: Number.isFinite(total) && total > 0 ? total : null,
          unit: String(body?.unit ?? PROVIDER_QUOTA[provider.id]?.unit ?? "requests"),
          window: String(body?.window ?? PROVIDER_QUOTA[provider.id]?.windows?.[0] ?? ""),
          resetAt: String(body?.resetAt ?? ""),
          at: now(),
        }, guard.account?.email ?? "the operator token");
        ledger.done();
        json(response, 200, {
          slot,
          message: `Recorded. The bar is this product's own count against the total you read off ${provider.name}'s page, and it says so wherever it is drawn.`,
        });
        return true;
      }

      json(response, 404, { error: "not_found" });
      return true;
    }

    if (rest.length === 4 && rest[0] === "providers" && rest[2] === "catalog" && rest[3] === "refresh" && method === "POST") {
      const provider = providerById(decodeURIComponent(rest[1]));
      if (provider == null) { json(response, 404, { error: "not_found", message: "There is no provider by that name." }); return true; }
      const ledger = beginAction(guard, request, { action: "provider.catalog.refresh", target: provider.id, detail: `reading ${provider.name}'s model list` });
      const answer = await refreshCatalog(provider, guard.account?.email ?? "the operator token");
      ledger.done(`${answer.models.length} name(s), ${answer.live ? "read from the vendor" : "the curated list"}`);
      json(response, 200, {
        provider: provider.id,
        ...answer,
        note: "This is a list of names. The context window and whether a model takes an image are things you set.",
      });
      return true;
    }

    // ---- plan models -----------------------------------------------------------------------------

    if (rest.length === 1 && rest[0] === "plan-models" && method === "POST") {
      const alias = String(body?.alias ?? "").trim();
      if (!isPlanModel(alias) || alias.length < 6) {
        json(response, 400, { error: "bad_request", message: "A plan model's name starts with plan- and is a contract with every box pointed at it. It is created once and never renamed." });
        return true;
      }
      const provider = providerById(String(body?.provider ?? ""));
      if (provider == null) { json(response, 404, { error: "not_found", message: "There is no provider by that name." }); return true; }
      const vendorModel = prefixedModel(provider, body?.vendorModel);
      if (vendorModel.length === 0) { json(response, 400, { error: "bad_request", message: "Pick the vendor's model this runs on." }); return true; }
      const customerVisible = body?.customerVisible !== false;
      const customerName = String(body?.customerName ?? "").trim();
      const customerLabel = String(body?.customerLabel ?? "").trim();
      if (customerVisible && (customerName.length === 0 || customerLabel.length === 0)) {
        json(response, 400, {
          error: "bad_request",
          message: "A model a customer can see needs the words on their card and the name their Titan says it runs. Without both it would show up as its routing alias, which is the failure this panel exists to end.",
        });
        return true;
      }
      const visionFallback = String(body?.visionFallback ?? "").trim();
      const supportsVision = body?.supportsVision === true;
      if (customerVisible && !supportsVision && visionFallback.length === 0) {
        json(response, 400, {
          error: "bad_request",
          message: "Every Titan conversation carries screenshots. Either this model takes an image, or name the model a request carrying one falls back to. A plan model that refuses images is a fleet-wide screenshot outage, which is what PROXY-10 cost.",
        });
        return true;
      }
      const db = await askProxy("/model/info (db flag)", () => proxy.storeModelInDb());
      if (db.ok && db.on === false) {
        json(response, 409, { error: "db_off", message: db.why });
        return true;
      }
      const [credentials, models] = await Promise.all([
        askProxy("/credentials", () => proxy.listCredentials()),
        askProxy("/model/info", () => proxy.listModels()),
      ]);
      if (!credentials.ok) { json(response, 502, { error: "proxy", message: credentials.why }); return true; }
      if (!models.ok) { json(response, 502, { error: "proxy", message: models.why }); return true; }
      // IN THE DATABASE, not merely being served. While an install is moving off a file-configured
      // proxy, /model/info reports the file's deployments beside the database's, so an alias the
      // file is serving would refuse the very row that replaces it and the seed would leave the
      // proxy with nothing after the file's half goes away. A file row is not something this route
      // can change either, which is why it is not treated as one that exists.
      if (models.rows.some((row) => row.alias === alias && row.fromDb === true)) {
        json(response, 409, { error: "exists", message: `${alias} already exists. Change it instead: the name is what every box already points at.` });
        return true;
      }
      const wanted = Array.isArray(body?.keySlots) && body.keySlots.length > 0
        ? body.keySlots.map(String)
        : credentials.rows.filter((row) => (row.provider === provider.id || row.name.startsWith(`${provider.id}-`)) && !row.parked).map((row) => row.name);
      if (wanted.length === 0) {
        json(response, 409, { error: "no_keys", message: `${provider.name} has no key to run this on. Add one first.` });
        return true;
      }
      const ledger = beginAction(guard, request, {
        action: "plan-model.add",
        target: alias,
        detail: `${alias} on ${vendorModel} across ${wanted.length} key(s): ${wanted.join(", ")}`,
      });
      const made = [];
      for (const slot of wanted) {
        const credential = credentials.rows.find((row) => row.name === slot);
        if (credential == null) { made.push({ slot, ok: false, why: `there is no key in slot ${slot}` }); continue; }
        const id = deploymentIdFor(alias, slot);
        // Create only, and the id is ours. A duplicate id answers 500 rather than upserting, so a
        // timed-out add is checked against what is really there before anything is retried.
        if (models.rows.some((row) => row.id === id)) { made.push({ slot, ok: false, why: `${id} is already at the proxy` }); continue; }
        const added = await askProxy("/model/new", () => proxy.addModel({
          alias,
          vendorModel,
          credentialName: slot,
          id,
          params: provider.baseUrl ? { api_base: provider.baseUrl } : {},
          info: {
            ...(Number(body?.contextWindow) > 0 ? { max_input_tokens: Number(body.contextWindow) } : {}),
            supports_vision: supportsVision,
            [TB.provider]: provider.id,
            [TB.keySlot]: slot,
            [TB.keyLabel]: credential.label,
            [TB.keyOrder]: credential.order ?? 0,
            [TB.customerName]: customerName,
            [TB.customerLabel]: customerLabel,
            [TB.servedBy]: String(body?.servedBy ?? customerLabel),
            [TB.customerVisible]: customerVisible,
            [TB.visionFallback]: visionFallback,
            [TB.plans]: Array.isArray(body?.plans) ? body.plans.map(String) : ["included"],
          },
        }));
        made.push({ slot, id, ok: added.ok === true, why: added.ok ? "" : added.why });
      }
      let fallback = { ok: true, why: "" };
      if (visionFallback.length > 0) {
        // AFTER the deployments, because POST /fallback validates that the target exists and
        // answers 400 listing what is available when it does not.
        fallback = await askProxy("/fallback", () => proxy.setFallback({ alias, fallbacks: [visionFallback] }));
      }
      const landed = made.filter((row) => row.ok).length;
      if (landed === 0) {
        ledger.failed(made.map((row) => row.why).join("; "));
        // THE HALF-STATE, named. With store_model_in_db off the credential half answered 200 and
        // really persisted while this half refused, so the operator has a key in a slot and no
        // model on it and nothing on the page would say why. 409 rather than 502, because the proxy
        // is not broken: it is configured to ignore this.
        const dbOff = made.some((row) => /STORE_MODEL_IN_DB/i.test(String(row.why ?? "")));
        json(response, dbOff ? 409 : 502, {
          error: dbOff ? "db_off" : "proxy",
          message: made.find((row) => !row.ok)?.why ?? "nothing was created",
          deployments: made,
        });
        return true;
      }
      ledger.done(`${alias} created on ${landed} of ${wanted.length} key(s)`);
      json(response, 200, {
        alias,
        deployments: made,
        fallback: fallback.ok ? { model: visionFallback } : { model: visionFallback, why: fallback.why },
        message: `${alias} answers on the next request. It reaches a customer's plan card within one registry cycle, and only after you give every workspace access to it.`,
      });
      return true;
    }

    if (rest.length === 3 && rest[0] === "plan-models" && method === "POST") {
      const alias = decodeURIComponent(rest[1]);
      const action = rest[2];
      const models = await askProxy("/model/info", () => proxy.listModels());
      if (!models.ok) { json(response, 502, { error: "proxy", message: models.why }); return true; }
      const rows = models.rows.filter((row) => row.alias === alias);
      if (rows.length === 0) { json(response, 404, { error: "not_found", message: `The proxy serves nothing called ${alias}.` }); return true; }
      // The same rule as the panel's own read: only a database row carries this product's facts
      // about an alias, so it is the one every sentence below is written from.
      const known = rows.find((row) => row.fromDb === true) ?? rows[0];

      if (action === "update") {
        const provider = providerById(String(body?.provider ?? known.provider)) ?? { kind: "openai", baseUrl: "" };
        const vendorModel = body?.vendorModel === undefined ? "" : prefixedModel(provider, body.vendorModel);
        const info = {};
        if (body?.customerName !== undefined) info[TB.customerName] = String(body.customerName);
        if (body?.customerLabel !== undefined) info[TB.customerLabel] = String(body.customerLabel);
        if (body?.servedBy !== undefined) info[TB.servedBy] = String(body.servedBy);
        if (body?.customerVisible !== undefined) info[TB.customerVisible] = body.customerVisible === true;
        if (body?.plans !== undefined) info[TB.plans] = Array.isArray(body.plans) ? body.plans.map(String) : [];
        if (body?.visionFallback !== undefined) info[TB.visionFallback] = String(body.visionFallback);
        if (Number(body?.contextWindow) > 0) info.max_input_tokens = Number(body.contextWindow);
        if (body?.supportsVision !== undefined) info.supports_vision = body.supportsVision === true;
        if (vendorModel.length === 0 && Object.keys(info).length === 0) {
          json(response, 400, { error: "bad_request", message: "Nothing to change." });
          return true;
        }
        // The rule that keeps a routing target off a customer's page holds on an EDIT too: a row
        // cannot be made visible without the two words that name it.
        const wouldBeVisible = body?.customerVisible === undefined ? known.customerVisible : body.customerVisible === true;
        const wouldHaveLabel = String(body?.customerLabel ?? known.customerLabel ?? "").length > 0;
        const wouldHaveName = String(body?.customerName ?? known.customerName ?? "").length > 0;
        if (wouldBeVisible && !(wouldHaveLabel && wouldHaveName)) {
          json(response, 400, { error: "bad_request", message: "A model a customer can see needs the words on their card and the name their Titan says it runs." });
          return true;
        }
        const ledger = beginAction(guard, request, {
          action: "plan-model.update",
          target: alias,
          detail: vendorModel.length > 0 ? `${alias} from ${known.vendorModel} to ${vendorModel}` : `${alias}: ${Object.keys(info).join(", ")}`,
        });
        // ONLY WHAT THIS ROUTE CAN ACTUALLY EDIT. While an install is moving off a file-configured
        // proxy the same alias has file deployments and database ones, and LiteLLM refuses the file
        // ones with 400 "Can't edit model. Model in config." (MEASURED on the R750 2026-09-08). They
        // are not a failure to report: they are rows this route was never able to touch, and they go
        // away at the second restart. Reporting them as failures is how an operator learns to read a
        // red row as furniture.
        const editable = rows.filter((row) => row.fromDb === true);
        const fromFile = rows.length - editable.length;
        if (editable.length === 0) {
          ledger.failed("every deployment behind this alias is declared in the proxy's own file");
          json(response, 409, {
            error: "in_file",
            message: `${alias} is served from the proxy's configuration file, which this console cannot edit. Seed it into the database first: node cp/cli.mjs proxy seed.`,
          });
          return true;
        }
        const changed = [];
        for (const row of editable) {
          // POST /model/update MERGES and keeps the credential and every tb_ key; it REFUSES a
          // model_info-only edit with 400, which is why the label path is a PATCH.
          const answer = vendorModel.length > 0
            ? await askProxy("/model/update", () => proxy.updateModel({ id: row.id, vendorModel, info }))
            : await askProxy("/model/{id}/update", () => proxy.patchModel({ id: row.id, info }));
          changed.push({ id: row.id, ok: answer.ok === true, why: answer.ok ? "" : answer.why });
        }
        let fallback = null;
        if (body?.visionFallback !== undefined) {
          fallback = String(body.visionFallback).length > 0
            ? await askProxy("/fallback", () => proxy.setFallback({ alias, fallbacks: [String(body.visionFallback)] }))
            : await askProxy("/fallback delete", () => proxy.deleteFallback(alias));
        }
        const landed = changed.filter((row) => row.ok).length;
        if (landed === 0) { ledger.failed(changed[0]?.why ?? "nothing changed"); json(response, 502, { error: "proxy", message: changed[0]?.why ?? "nothing changed", deployments: changed }); return true; }
        ledger.done(`${landed} of ${editable.length} deployment(s) changed${fromFile > 0 ? `, and ${fromFile} more are declared in the proxy's file and were left alone` : ""}`);
        const ran = ranAlias(await askProxySpend(), alias);
        json(response, 200, {
          alias,
          deployments: changed,
          ...(fallback == null ? {} : { fallback: { ok: fallback.ok, why: fallback.ok ? "" : fallback.why } }),
          message: vendorModel.length > 0
            ? `${alias} runs on ${vendorModel} from the very next request, and a box picks it up on its next turn. ${ran.slugs.length > 0 ? `${ran.slugs.length} workspace(s) have run this model: their Titan keeps saying the old name until you push the new one.` : "No workspace has run this model inside the current window."}`
            : `Changed. A customer's plan card follows within one registry cycle; their open page updates on its next load.`,
        });
        return true;
      }

      // A catalog refresh can never infer this, and PROXY-10 was a fleet-wide screenshot outage.
      if (action === "vision-check") {
        const ledger = beginAction(guard, request, { action: "plan-model.vision-check", target: alias, detail: `sending an image part through ${alias}` });
        const answer = await askProxy("/v1/chat/completions", () => proxy.call("POST", "/v1/chat/completions", {
          body: {
            model: alias,
            max_tokens: 16,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "Answer with the single word yes." },
                // One transparent pixel. The smallest thing that is unambiguously an image part.
                { type: "image_url", image_url: { url: `data:image/png;base64,${ONE_PIXEL_PNG}` } },
              ],
            }],
          },
        }));
        const at = new Date(now()).toISOString();
        // Same rule as an edit: a deployment declared in the proxy's file cannot carry our answer,
        // and asking it to would only put a 400 on the record.
        for (const row of rows.filter((one) => one.fromDb === true)) {
          await askProxy("/model/{id}/update", () => proxy.patchModel({ id: row.id, info: { [TB.visionOk]: answer.ok === true, [TB.visionAt]: at } }));
        }
        ledger.done(answer.ok ? "it took the image" : `it refused the image: ${answer.why}`);
        json(response, 200, {
          alias,
          vision: { ok: answer.ok === true, at, why: answer.ok ? "" : answer.why },
          message: answer.ok
            ? `${alias} took an image part. Recorded against every deployment behind it.`
            : `${alias} refused an image part (${answer.why}). It needs a vision fallback, or every screenshot a customer's Titan takes is a failed turn.`,
        });
        return true;
      }

      if (action === "apply") {
        const ledger = beginAction(guard, request, { action: "plan-model.apply", target: alias, detail: `widening every workspace key to include ${alias}` });
        const swept = await applyToEveryKey();
        if (!swept.ok) { ledger.failed(swept.why || "no key could be updated"); json(response, 502, { error: "proxy", message: swept.why || "no key could be updated", rows: swept.rows }); return true; }
        ledger.done(`${swept.rows.filter((row) => row.ok).length} of ${swept.rows.length} workspace key(s) updated`);
        json(response, 200, {
          alias,
          rows: swept.rows,
          models: swept.models,
          message: "Every workspace key is now scoped to every plan model the proxy serves. Nothing was written into a box: the key value did not change. A customer's plan card follows within one registry cycle.",
        });
        return true;
      }

      // The label lives inside each box, so pushing it WRITES INTO A BOX and this route will not do
      // that to a workspace nobody named. Without slugs it answers with the candidates and changes
      // nothing, because the door it drives sets the model as well as the label: pushed at a box
      // running something else, it would move that customer onto this model without being asked.
      if (action === "push-label") {
        const ran = ranAlias(await askProxySpend(), alias);
        const named = Array.isArray(body?.slugs) ? body.slugs.map(String) : [];
        const targets = named.length > 0 ? named : (body?.all === true ? ran.slugs : []);
        if (targets.length === 0) {
          json(response, 409, {
            error: "name_them",
            candidates: ran.slugs,
            message: ran.slugs.length > 0
              ? `Say which workspaces. These have run ${alias} inside the current window: ${ran.slugs.join(", ")}. This writes inside a box and it sets the model as well as the label, so it is never done to a workspace nobody named.`
              : `No workspace has run ${alias} inside the current window, so there is nothing to push. Name the workspaces if you know better.`,
          });
          return true;
        }
        const ledger = beginAction(guard, request, { action: "plan-model.push-label", target: alias, detail: `pushing ${known.customerLabel || alias} into ${targets.join(", ")}` });
        const pushed = [];
        for (const slug of targets) {
          if (store.getTenant(slug) == null) { pushed.push({ slug, ok: false, why: "there is no workspace by that name" }); continue; }
          const answer = await pointWorkspaceAt(slug, alias);
          pushed.push({
            slug,
            ok: answer.ok === true,
            why: answer.ok ? "" : answer.why,
            // The relay's own evidence: names, lengths and hash prefixes. No value comes back.
            wrote: answer.ok ? (answer.body?.wrote ?? []) : [],
          });
        }
        const landed = pushed.filter((row) => row.ok).length;
        ledger.done(`${landed} of ${targets.length} workspace(s) told it runs ${known.customerLabel || alias}`);
        json(response, 200, {
          alias,
          label: known.customerLabel,
          workspaces: pushed,
          message: `${landed} workspace(s) updated. Each one's Titan says ${known.customerLabel || alias} from its next message, because the host re-reads that file every turn.`,
        });
        return true;
      }

      if (action === "remove") {
        if (String(body?.confirm ?? "") !== alias) { json(response, 400, { error: "confirm", message: `Type ${alias} to remove it. Nothing was changed.` }); return true; }
        const ran = ranAlias(await askProxySpend(), alias);
        if (ran.slugs.length > 0) {
          json(response, 409, {
            error: "in_use",
            workspaces: ran.slugs,
            message: `${ran.slugs.join(", ")} ran ${alias} inside the current window. Move them first: a box pointed at a model that is gone fails every turn.`,
          });
          return true;
        }
        const ledger = beginAction(guard, request, { action: "plan-model.remove", target: alias, detail: `removing ${alias} and its ${rows.length} deployment(s)` });
        const gone = [];
        for (const row of rows) {
          const answer = await askProxy("/model/delete", () => proxy.deleteModel(row.id));
          gone.push({ id: row.id, ok: answer.ok === true, why: answer.ok ? "" : answer.why });
        }
        await askProxy("/fallback delete", () => proxy.deleteFallback(alias));
        ledger.done(`${gone.filter((row) => row.ok).length} of ${rows.length} deployment(s) removed`);
        json(response, 200, {
          alias,
          deployments: gone,
          message: `${alias} is gone from the next request. It is off every customer's plan card within one registry cycle. No box was written to.`,
        });
        return true;
      }

      json(response, 404, { error: "not_found" });
      return true;
    }

    if (rest.length === 1 && rest[0] === "defaults" && method === "POST") {
      const planModel = String(body?.planModel ?? "").trim();
      if (planModel.length > 0 && !isPlanModel(planModel)) {
        json(response, 400, { error: "bad_request", message: "A default has to be one of the plan models." });
        return true;
      }
      const ledger = beginAction(guard, request, { action: "defaults.plan-model", target: planModel || "(none)", detail: `new workspaces get ${planModel || "whatever the proxy serves"}` });
      store.setSetting(SETTING_DEFAULT_MODEL, planModel, guard.account?.email ?? "the operator token");
      ledger.done();
      json(response, 200, {
        planModel,
        message: planModel.length > 0
          ? `A new workspace gets ${planModel}. Workspaces that already exist keep what they are on.`
          : "Cleared. A new workspace gets whatever the proxy serves and its console picks the first one.",
      });
      return true;
    }

    // ---- the six actions -------------------------------------------------------------------------

    if (rest.length === 3 && rest[0] === "clients" && method === "POST") {
      const slug = decodeURIComponent(rest[1]);
      const action = rest[2];
      if (store.getTenant(slug) == null) { json(response, 404, { error: "not_found" }); return true; }
      if (["stop", "start", "restart"].includes(action)) { await tenantPower(response, slug, action); return true; }
      if (action === "provision") { await tenantProvision(response, slug, body ?? {}); return true; }
      // PROVIDERS-1. One workspace moved onto one plan model, from its own row.
      //
      // The relay's use-included door writes the base url, the model, the endpoint name, the
      // served-by line, the context window and the LABEL in one write, so the name this customer's
      // Titan says follows the model automatically and cannot be left behind. It takes effect on
      // that box's next message; nothing is restarted and nothing is recreated.
      if (action === "model") {
        const planModel = String(body?.planModel ?? "").trim();
        if (!isPlanModel(planModel)) {
          json(response, 400, { error: "bad_request", message: "Name the plan model this workspace should run." });
          return true;
        }
        const ledger = beginAction(guard, request, { action: "client.model", target: slug, detail: `${slug} onto ${planModel}` });
        const answer = await pointWorkspaceAt(slug, planModel);
        if (!answer.ok) { ledger.failed(answer.why); json(response, 502, { error: "relay", message: answer.why }); return true; }
        ledger.done(`${slug} is on ${planModel}`);
        // PINNED IS NOT A SUCCESS. The relay writes the file either way, but a box whose container
        // environment carries SAND_OPENAI_COMPATIBLE_* keeps answering through that until it is
        // recreated, so reporting "runs it from its next message" would be a claim the box will
        // not honour. The relay measured it; this says it in the operator's own words.
        const pinned = answer.body?.pinned === true;
        json(response, 200, {
          slug,
          planModel,
          pinned,
          pinnedBy: answer.body?.pinnedBy ?? null,
          // Names, lengths and hash prefixes, out of the relay's own answer. No value comes back.
          wrote: answer.body?.wrote ?? [],
          message: pinned
            ? `${slug} was written, and it will keep running what its container environment pins: ${String(answer.body?.pinnedBy ?? "SAND_OPENAI_COMPATIBLE_* is set on the container")}. Nothing this console does takes effect there until that is gone.`
            : `${slug} runs ${planModel} from its next message, and its Titan says the name that goes with it. Their open page shows the change on its next load.`,
        });
        return true;
      }
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

  return { handle, servePage, recordAttempt, requireSuperAdmin, signIns, clients, boxes, system, spend, providers: providersAnswer };
}
