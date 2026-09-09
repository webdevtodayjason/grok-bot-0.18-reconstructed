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
import { FEEDBACK_STATES, normalizeEmail } from "./store.mjs";
// FEEDBACK-1. The payload's shape, the issue body, the GitHub call and the digest all live in their
// own file, because every one of them is a pure function over a report and none of them needs a
// store, a config or a request to be tested.
import {
  FEEDBACK_TIERS,
  GITHUB_API,
  TIER_ROUTING,
  buildIssueBody,
  fileIssue,
  normalizeReport,
  parseRepo,
  proveRepoToken,
} from "./feedback.mjs";
import {
  PROVIDER_PRESETS,
  PROVIDER_QUOTA,
  TB,
  TENANT_ALLOWED_ROUTES,
  tenantRoutesFor,
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
    // WHICH VENDOR MODELS HAVE A PRICE. Without this every row below prints $0.00 for a customer
    // who ran hundreds of thousands of tokens, because a deployment created with no cost per token
    // bills at zero and LiteLLM carries no price for a Z.AI or Alibaba model id. Measured on the
    // R750 2026-09-08: 654 Z.AI spend rows, all spend 0.000000. One /model/info read, joined on the
    // vendor model string the spend rows already carry.
    const deploymentPrices = await askProxy("/model/info", () => proxy.listModels());
    const pricedModels = new Set(
      (deploymentPrices.ok ? deploymentPrices.rows : [])
        .filter((row) => row.inputCostPerToken != null || row.outputCostPerToken != null)
        .map((row) => String(row.vendorModel)),
    );
    const unpricedModels = new Set(
      (deploymentPrices.ok ? deploymentPrices.rows : [])
        .filter((row) => row.inputCostPerToken == null && row.outputCostPerToken == null)
        .map((row) => String(row.vendorModel)),
    );
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
        // null when nothing is known, false when this customer ran something with no price on it.
        // The page prints "not priced" for false rather than a dollar sign in front of a zero.
        spendPriced: !deploymentPrices.ok
          ? null
          : (models.length === 0
            ? null
            : !models.some((row) => unpricedModels.has(String(row.model)) || (!pricedModels.has(String(row.model)) && !String(row.model).toLowerCase().includes(TINYFISH_MODEL_MARK)))),
        spendPricedWhy: deploymentPrices.ok
          ? "A dollar figure only means something for a model that has a cost per token set on it in the Providers panel."
          : deploymentPrices.why,
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
    // AGENTS-CAP-2. How many bots each workspace may hold, read off each box. One sweep for the
    // whole panel, sharing the box cache window, so the column costs one round trip per customer
    // rather than one per row rendered.
    const ceilings = new Map((await boxCeilings()).map((row) => [row.slug, row]));
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
        // AGENTS-CAP-2. Always an object, never a bare number, because the three honest states
        // (could not be read, pinned in the container environment, settable) each need a sentence
        // and a bare number can only carry one of them.
        ceiling: ceilings.get(tenant.slug) ?? {
          slug: tenant.slug, read: false, maxAgents: null, bots: null, pinned: false, pinnedBy: null,
          why: "this control plane did not ask about that workspace",
        },
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
  const healthSetting = (id) => `health:${id}`;
  // How long an operator-triggered check is worth showing before the request log is the better
  // evidence again. Five minutes: long enough to still be on the page after the click that made it.
  const HEALTH_PROBE_TTL_MS = 5 * 60 * 1000;
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

  /**
   * The two prices, read off a request body and shaped for litellm_params.
   *
   * A blank field is NOT zero and is not sent: sending zero would write a real price of nothing,
   * which reads on every page as "$0.00 spent" and is exactly the confusion this exists to end.
   * Sending nothing leaves whatever is there, because POST /model/update merges.
   */
  function priceOf(body) {
    const params = {};
    const input = Number(body?.inputCostPerToken);
    const output = Number(body?.outputCostPerToken);
    if (Number.isFinite(input) && input >= 0 && String(body?.inputCostPerToken ?? "").length > 0) params.input_cost_per_token = input;
    if (Number.isFinite(output) && output >= 0 && String(body?.outputCostPerToken ?? "").length > 0) params.output_cost_per_token = output;
    return params;
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
   * There is no other honest source for the REQUEST half. What a box is pointed at lives in its own
   * box-secrets.json, which boxLabels() below reads directly off the disk; this list is the
   * complementary fact, which workspaces actually sent traffic through the alias inside a named
   * window, and every answer that carries it says so.
   *
   * IT JOINS ON THE DEPLOYMENT ID, NOT ON THE MODEL NAME, and that is a correction rather than a
   * preference. A spend row's `model` is what the VENDOR was asked for -- on the R750 2026-09-08,
   * `select model,count(*) from "LiteLLM_SpendLogs"` answered openai/glm-5.3 596, openai/glm-4.7 40
   * and the alias `plan-zai` three times in the whole log. Matching the alias against that string
   * therefore said plan-zai was run by demo alone while richard-avery and titanium were on it, and
   * that wrong list is what the remove guard consumes: deleting the alias would have been allowed
   * and would have failed every turn in two live boxes, one of them a paying customer's. The
   * deployment id IS ours (`tb-<alias>-<slot>`), the spend row carries it as model_id, and slotShare
   * already joins on exactly that.
   *
   * The model-name match is KEPT as a union rather than replaced, because a row whose model_id the
   * upstream did not record still names the alias in `model` on the three rows above, and for a
   * guard that refuses a destructive change a false positive is the safe direction.
   */
  function ranAlias(sweep, alias, deploymentIds = []) {
    if (!sweep?.month?.ok) return { slugs: [], why: sweep?.month?.why ?? "the proxy's request log could not be read", measured: false };
    const ids = new Set((deploymentIds ?? []).map(String));
    const slugs = [];
    for (const row of sweep.month.keys) {
      const alias_ = String(row.alias ?? "");
      if (!alias_.startsWith("titanbot-")) continue;
      const byDeployment = (row.deployments ?? []).some((one) => ids.has(String(one.id)));
      const byName = row.models.some((one) => String(one.model) === String(alias));
      if (!byDeployment && !byName) continue;
      slugs.push(alias_.slice("titanbot-".length));
    }
    return { slugs, why: "", measured: true };
  }

  /**
   * WHAT EACH BOX IS ACTUALLY RUNNING, read off the disk rather than assumed.
   *
   * The label a customer's Titan says lives in that box's own box-secrets.json, and until this pass
   * nothing reported it back: the panel printed `labelBehind: null` for every model and a box that
   * had never been given SAND_OPENAI_COMPATIBLE_MODEL_LABEL looked the same as one that had. That
   * is not an unknowable. This container has /data/titanbot bind mounted -- it is where it writes
   * every tenant's directory -- so the file is one read away, and a read is what it gets.
   *
   * MEASURED ON THE R750 2026-09-08: richard-avery's file carried SAND_OPENAI_COMPATIBLE_MODEL
   * plan-zai and NO label, so his Titan answered with the routing alias while his own registry row
   * said GLM-5.3; demo's carried the label. Neither box carried a container-env override, so the
   * file is authoritative for both.
   *
   * IT IS ASKED OF THE RELAY, NOT READ OFF THE DISK, and that is a measurement rather than a
   * preference. The first shape of this opened /data/titanbot/<slug>/volumes/data/box-secrets.json
   * directly, which this container does mount. MEASURED FROM INSIDE titanbot-cp 2026-09-08: demo
   * and richard-avery answer EACCES (the file is 0600 and owned by the box user, which is the whole
   * point of SECRET-3) and the adopted titanium answers ENOENT, because an adopted workspace's
   * directories are not under the tenant root at all. The relay has the docker socket and reads
   * that file through the box already, for the model picker, so it is the one that can answer.
   *
   * A box that could not be read is reported as unknown, never as up to date: a green count
   * computed over a box nobody checked is the made-up green light this file's header refuses to
   * ship. The answers are cached for the same few seconds the box sweep uses, because one panel
   * load asks once per plan model.
   */
  let boxLabelCache = { at: 0, rows: null, inFlight: null };
  async function boxLabels() {
    if (boxLabelCache.rows != null && now() - boxLabelCache.at < BOXES_CACHE_MS) return boxLabelCache.rows;
    if (boxLabelCache.inFlight != null) return boxLabelCache.inFlight;
    const pending = (async () => {
      const rows = [];
      for (const tenant of store.listTenants()) {
        const answer = await askRelay(`/admin/tenants/${encodeURIComponent(tenant.slug)}/running`, "");
        if (!answer.ok) {
          rows.push({ slug: tenant.slug, model: "", label: "", read: false, why: answer.why });
          continue;
        }
        const body = answer.body ?? {};
        rows.push({
          slug: tenant.slug,
          model: String(body.model ?? ""),
          label: String(body.modelLabel ?? ""),
          read: body.read === true,
          pinned: body.pinned === true,
          why: body.read === true ? "" : String(body.why ?? "that workspace did not answer"),
        });
      }
      return rows;
    })();
    boxLabelCache = { ...boxLabelCache, inFlight: pending };
    return pending.then(
      (rows) => { boxLabelCache = { at: now(), rows, inFlight: null }; return rows; },
      (error) => { boxLabelCache = { at: 0, rows: null, inFlight: null }; throw error; },
    );
  }

  /**
   * How many bots each workspace may hold, READ OFF EACH BOX and never out of this store.
   * AGENTS-CAP-2.
   *
   * There is no ceiling column anywhere in the control plane, and that is the design rather than an
   * omission. The number that decides whether a customer can add a bot is SAND_MAX_AGENTS in that
   * box's own sand-host-settings.json, resolved by the host on every turn; a copy kept here would
   * be a second answer that drifts the first time anybody edits the file, and the Clients panel
   * would then show a number no box has ever honoured. So every panel load asks the relay, which
   * asks each box's own gateway.
   *
   * A box that could not be read reports read:false with the reason. Not a zero, and not the
   * default: "we could not look" and "this workspace holds forty" send an operator to different
   * places, and a ceiling shown over a box nobody asked is the made-up green this file refuses.
   *
   * The same cache window and in-flight join boxLabels uses, for the same reason: one panel load
   * asks once per workspace, sequentially, and the Clients panel is loaded beside five others.
   */
  let ceilingCache = { at: 0, rows: null, inFlight: null };
  async function boxCeilings() {
    if (ceilingCache.rows != null && now() - ceilingCache.at < BOXES_CACHE_MS) return ceilingCache.rows;
    if (ceilingCache.inFlight != null) return ceilingCache.inFlight;
    const pending = (async () => {
      const rows = [];
      for (const tenant of store.listTenants()) {
        const answer = await askRelay(`/admin/tenants/${encodeURIComponent(tenant.slug)}/ceiling`, "");
        if (!answer.ok) {
          rows.push({ slug: tenant.slug, read: false, maxAgents: null, bots: null, pinned: false, pinnedBy: null, why: answer.why });
          continue;
        }
        const body = answer.body ?? {};
        // A NUMBER IS TAKEN ONLY WHEN THE BOX SAID IT READ ONE. The relay answers read:false with
        // nulls, but a stale number beside a false flag is exactly the shape that puts a ceiling on
        // the screen over a box nobody could ask, so the flag decides here rather than the field.
        const read = body.read === true;
        rows.push({
          slug: tenant.slug,
          read,
          maxAgents: read && Number.isFinite(Number(body.maxAgents)) ? Number(body.maxAgents) : null,
          bots: read && Number.isFinite(Number(body.bots)) ? Number(body.bots) : null,
          pinned: body.pinned === true,
          pinnedBy: body.pinnedBy ?? null,
          why: read ? "" : String(body.why ?? "that workspace did not answer"),
        });
      }
      return rows;
    })();
    ceilingCache = { ...ceilingCache, inFlight: pending };
    return pending.then(
      (rows) => { ceilingCache = { at: now(), rows, inFlight: null }; return rows; },
      (error) => { ceilingCache = { at: 0, rows: null, inFlight: null }; throw error; },
    );
  }
  /** A write invalidates the read, so the row shows what the box now says rather than the old sweep. */
  const forgetCeilings = () => { ceilingCache = { at: 0, rows: null, inFlight: null }; };

  /**
   * The range a ceiling may be set to, checked HERE rather than left to the box.
   *
   * The host fails OPEN on a value it cannot use: anything outside this range, or a value that is
   * not a string, drops that workspace back to the product default with nothing on any screen
   * saying why. So a number that would do that is refused in a sentence before the relay is called,
   * and the customer's box is never written with a value that quietly means something else.
   */
  const CEILING_MIN = 1;
  const CEILING_MAX = 1000;

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

  /**
   * Whether a provider is well, said only as far as something actually checked.
   *
   * Three states and they are different claims. `null` means nothing has checked -- no health run,
   * no failed request, no successful one either -- and the page says "not checked" rather than
   * drawing a light. `false` means requests on this provider's own deployments really did fail
   * inside the window, with the count and the vendor's own last message. `true` means requests went
   * through and none failed, which is the strongest thing this install can honestly say without a
   * live probe.
   *
   * checkedAt is stamped from the EVIDENCE, not from now(). The old code stamped a fresh timestamp
   * on a value nothing had measured, which is what made an unchecked provider look freshly green.
   */
  function providerHealth(provider, keys, sweep, deployments, at) {
    if (keys.length === 0) return { reachable: null, why: "no key here yet, so there is nothing to reach", checkedAt: "", requests: 0, failures: 0 };
    if (!sweep?.month?.ok) return { reachable: null, why: sweep?.month?.why ?? "the proxy's request log could not be read, so nothing here has been checked", checkedAt: "", requests: 0, failures: 0 };
    const mine = new Set(deployments.filter((row) => String(row.provider ?? "") === provider.id).map((row) => String(row.id)));
    let requests = 0;
    let failures = 0;
    let lastAt = "";
    let lastWhy = "";
    for (const row of sweep.month.deployments ?? []) {
      if (!mine.has(String(row.id))) continue;
      requests += row.requests;
      failures += Number(row.failures ?? 0);
      if (String(row.lastFailureAt ?? "") > lastAt) { lastAt = String(row.lastFailureAt ?? ""); lastWhy = String(row.lastFailureWhy ?? ""); }
    }
    // A live check the operator asked for beats the log, when there is one on record.
    const probe = readJsonSetting(healthSetting(provider.id), null);
    if (probe != null && Number(probe.at) > 0 && Number(probe.at) > at - HEALTH_PROBE_TTL_MS) {
      return {
        reachable: probe.ok === true,
        why: probe.ok === true ? "" : String(probe.why ?? ""),
        checkedAt: new Date(Number(probe.at)).toISOString(),
        how: "a check you asked for",
        requests,
        failures,
      };
    }
    if (requests === 0) {
      return { reachable: null, why: `nothing has run on ${provider.name} inside this window and no check has been made, so there is nothing to report`, checkedAt: "", requests, failures };
    }
    if (failures > 0) {
      return {
        reachable: false,
        why: `${failures} of ${requests} request(s) on ${provider.name} failed inside this window${lastWhy ? `; the last one said: ${lastWhy}` : ""}`,
        checkedAt: lastAt,
        how: "the proxy's own request log",
        requests,
        failures,
      };
    }
    return { reachable: true, why: "", checkedAt: new Date(at).toISOString(), how: `${requests} request(s) went through inside this window and none failed`, requests, failures };
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
    // One sweep per panel load, shared by every plan model row below.
    const boxes = await boxLabels();
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
          // `priced` decides whether the dollar column is a NUMBER or the words "not priced". A
          // deployment created with no input/output cost per token bills every request at zero, so
          // $0.00 here can mean "spent nothing" or "nobody set a price", and those are opposite
          // facts about a customer.
          spend: {
            month: share.dollars,
            requests: share.requests,
            tokens: share.tokens,
            priced: serving.length > 0 && serving.every((row) => row.inputCostPerToken != null || row.outputCostPerToken != null),
            why: share.why || (serving.length > 0 && serving.some((row) => row.inputCostPerToken == null && row.outputCostPerToken == null)
              ? "no price is set on this key's deployment(s), so what went through it cannot be turned into money. Set a cost per token on the plan model."
              : ""),
          },
          quota: quotaFor(credential.name, provider, share),
          lastError,
          serves: [...new Set(serving.map((row) => row.alias))],
        };
      }).sort((a, b) => (a.order - b.order) || a.slot.localeCompare(b.slot));
      providers.push({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        fromPreset: provider.fromPreset === true,
        bootstrapEnv: provider.bootstrapEnv ?? [],
        // WHAT IS ACTUALLY KNOWN ABOUT THIS PROVIDER, which on this install is usually "nothing".
        //
        // This used to read `reachable: keys.every(row => row.lastError == null)` with checkedAt
        // stamped from now(). lastError comes only from GET /health/latest, config.yaml sets
        // background_health_checks false and nothing calls /health, so MEASURED ON THE R750
        // 2026-09-08 that endpoint answers `{"latest_health_checks":{},"total_models":0}` -- every
        // key's lastError is null forever and the panel drew a green light with a fresh timestamp on
        // it for a provider whose catalog had never once been read. A health signal that cannot go
        // red is worse than none: it is the made-up green light this file's header refuses to ship.
        //
        // So: null and "not checked" while nothing has checked, and a real signal derived from data
        // already in hand -- the failures the spend sweep counted on this provider's own deployments
        // inside the window. Those are requests that really did fail, for real customers.
        health: providerHealth(provider, keys, sweep, deployments, at),
        catalog: {
          models: Array.isArray(catalog?.models) ? catalog.models : [...(provider.curated ?? [])],
          live: catalog?.live === true,
          readAt: String(catalog?.readAt ?? ""),
          why: catalog?.live === true ? "" : String(catalog?.why ?? "This is the short list this product has actually run. Refresh reads the vendor's own list once a key is in."),
          // Said on the page in these words, because a refresh CANNOT infer either of them.
          note: "This is a list of names. The context window and whether a model takes an image are things you set.",
          ready: catalogTargetOf(provider).length > 0 && String(provider.catalogPath ?? "").length > 0,
          // A LIVE read needs the key, which this service does not keep. Said here so the page can
          // ask for it rather than offering a Refresh button that can only ever return the stored
          // list. `leftoverDoor` is the cleartext pass-through the first shape of this feature used
          // to register; it should always be false and it is shown so an install that still has one
          // is visible rather than silent.
          liveNeedsKey: true,
          leftoverDoor: passThroughPaths.has(`/catalog/${provider.id}`),
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
      const ran = ranAlias(sweep, alias, rows.map((row) => row.id));
      const fallback = await askProxy(`/fallback/${alias}`, () => proxy.getFallback(alias));
      // WHICH BOXES ARE BEHIND, out of the files themselves. A box counts as behind when it is
      // pointed at this alias and the label it would say back is not the label this row carries --
      // including the empty label, which is the case that had richard-avery's Titan calling itself
      // plan-zai for two days while his console said GLM-5.3.
      const onThis = boxes.filter((row) => row.read && row.model === alias);
      const behind = onThis.filter((row) => row.label !== String(first.customerLabel ?? ""));
      const unread = boxes.filter((row) => !row.read);
      planModels.push({
        alias,
        provider: first.provider,
        vendorModel: first.vendorModel,
        customerName: first.customerName,
        customerLabel: first.customerLabel,
        servedBy: first.servedBy,
        contextWindow: first.contextWindow,
        inputCostPerToken: first.inputCostPerToken,
        outputCostPerToken: first.outputCostPerToken,
        priced: rows.every((row) => row.inputCostPerToken != null || row.outputCostPerToken != null),
        pricedWhy: rows.every((row) => row.inputCostPerToken != null || row.outputCostPerToken != null)
          ? ""
          : "Every dollar figure for this model is zero until a cost per token is set on it, and a zero reads as 'they have not spent anything'.",
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
          ? "workspaces whose traffic ran on one of this model's deployments inside the current spend window, joined on the deployment id rather than on the vendor model name."
          : ran.why,
        // MEASURED NOW, out of each box's own box-secrets.json. See boxLabels().
        runningHere: onThis.map((row) => row.slug),
        labelBehind: behind.length,
        labelBehindSlugs: behind.map((row) => row.slug),
        labelBehindWhy: unread.length > 0
          ? `${unread.length} workspace file(s) could not be read, so this count is of the ones that could: ${unread.map((row) => row.slug).join(", ")}.`
          : (behind.length === 0
            ? ""
            : `${behind.map((row) => row.slug).join(", ")} ${behind.length === 1 ? "is" : "are"} pointed at ${alias} and ${behind.length === 1 ? "says" : "say"} something else. Push the label to fix what their Titan calls itself.`),
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
      pricing: {
        unpriced: planModels.filter((row) => row.priced !== true).map((row) => row.alias),
        why: planModels.some((row) => row.priced !== true)
          ? "Some plan models carry no cost per token. Every dollar figure that touches them is zero, on this page and on the client rows, and a zero there is not evidence that nothing was spent."
          : "",
      },
      window: sweep.month.ok ? { month: `${sweep.monthStart} to ${sweep.today}` } : { month: "", why: sweep.month.why },
      measuredAt: new Date(at).toISOString(),
    };
  }

  /**
   * The vendor's own model list and the vendor's own opinion of a key, in ONE outbound request.
   *
   * WHY THIS IS NOT A PASS-THROUGH ANY MORE. The first shape of this read registered a LiteLLM
   * pass-through at /catalog/<provider> carrying `authorization: Bearer <the key>` so the control
   * plane could refresh a catalog while holding no vendor key. MEASURED ON THE R750 2026-09-08, that
   * header is stored in the proxy's Postgres in CLEARTEXT, in LiteLLM_Config.general_settings, with
   * none of the encryption the credentials table gets under PROXY_SALT_KEY, and GET
   * /config/pass_through_endpoint hands it back UNMASKED to anything holding the master key. Two
   * rows were live: /catalog/zai with a 56 character authorization and /catalog/minimax with a 132
   * character one, and the minimax row had never served a single read. So the arrangement that was
   * supposed to keep a key out of this container's reach was instead making a second, weaker copy of
   * it -- and deploy/coolify/proxy-config/config.yaml's own comment said the control plane never put
   * a cleartext key through that route.
   *
   * The honest shape is the plain one: read the vendor DIRECTLY, at the two moments the operator has
   * legitimately just handed us the key (adding it and rolling it), hold it for that one request,
   * and store the NAMES. Nothing is persisted anywhere but the name list that was already stored.
   *
   * The same request is the key's PROOF. A key that cannot fetch a model list is a key that will
   * fail the next customer turn, and finding that out before the value reaches a serving pool is
   * the whole of finding 4.
   */
  async function readVendorCatalog(provider, apiKey) {
    const target = catalogTargetOf(provider);
    const pathname = String(provider.catalogPath ?? "");
    if (target.length === 0 || pathname.length === 0) return { ok: false, models: [], why: `${provider.name} has no model list to read`, none: true };
    try {
      const response = await fetchImpl(`${target.replace(/\/$/, "")}${pathname}`, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(relayTimeoutMs),
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (!response.ok) {
        // The VENDOR'S OWN SENTENCE, trimmed, because "401" on its own tells an operator nothing
        // about whether they pasted the wrong key or the subscription lapsed.
        const said = String(parsed?.error?.message ?? parsed?.message ?? parsed?.msg ?? text ?? "").split("\n")[0].slice(0, 200);
        return { ok: false, models: [], why: `${provider.name} answered ${response.status}${said ? `: ${said}` : ""}`, status: response.status };
      }
      const rows = Array.isArray(parsed?.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
      const models = rows.map((row) => String(row?.id ?? row?.model ?? "")).filter((one) => one.length > 0);
      return { ok: true, models, why: "" };
    } catch (error) {
      return { ok: false, models: [], why: error?.name === "TimeoutError" ? `${provider.name} did not answer in time` : `${provider.name} could not be reached (${notMeasured(error)})` };
    }
  }

  /**
   * Does this key work. Asked BEFORE it is stored and BEFORE a serving slot is patched.
   *
   * MEASURED ON THE R750 2026-09-08 with a throwaway slot: patching a credential to a junk value
   * made the very next request 401 in 0.3 s, and three requests later the router put the deployment
   * in a 30 s cooldown answering "No deployments available". On a one-key pool that is an outage of
   * that plan model, started by a click, lasting longer than the operator's next click, and with the
   * old value overwritten in place there is nothing to undo it with. So the value is proved first.
   *
   * The proof is the vendor's own model list where there is one, and a one-token completion where
   * there is not. A provider with neither cannot be proved, and that is reported rather than
   * assumed: `provable: false` lets the add through with the fact attached and makes a roll ask for
   * `force`, because refusing a key nobody can check would make such a provider unusable.
   */
  async function proveKey(provider, apiKey) {
    const listed = await readVendorCatalog(provider, apiKey);
    if (listed.none !== true) {
      return { ok: listed.ok === true, provable: true, why: listed.why, how: `${provider.name}'s own model list`, models: listed.models };
    }
    const base = String(provider.baseUrl ?? "");
    if (base.length === 0) return { ok: true, provable: false, why: "", how: `${provider.name} has no model list and no base url here, so this key could not be checked before it was stored`, models: [] };
    try {
      const response = await fetchImpl(`${base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ model: String(provider.curated?.[0] ?? ""), max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(relayTimeoutMs),
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (response.ok) return { ok: true, provable: true, why: "", how: `a one token completion on ${provider.name}`, models: [] };
      // 400 and 404 are the MODEL being wrong, not the key. The key got far enough to be read.
      if (response.status === 400 || response.status === 404) {
        return { ok: true, provable: true, why: "", how: `${provider.name} accepted this key and refused the probe model, which is the key answering`, models: [] };
      }
      const said = String(parsed?.error?.message ?? parsed?.message ?? text ?? "").split("\n")[0].slice(0, 200);
      return { ok: false, provable: true, why: `${provider.name} answered ${response.status}${said ? `: ${said}` : ""}`, how: "a one token completion", models: [] };
    } catch (error) {
      return { ok: false, provable: true, why: error?.name === "TimeoutError" ? `${provider.name} did not answer in time` : `${provider.name} could not be reached (${notMeasured(error)})`, how: "a one token completion", models: [] };
    }
  }

  /**
   * The stored catalog, refreshed live only when the operator has just handed us the key.
   *
   * A Refresh with no key in hand is NOT a live read and does not pretend to be one: the last live
   * list is returned with the date it was read and a sentence saying what would make it live again.
   * A refresh that quietly fell back would be a page showing yesterday's names as though they were
   * today's, and one that lied about where they came from would be worse.
   */
  async function refreshCatalog(provider, actor, apiKey = "") {
    const target = catalogTargetOf(provider);
    const pathname = String(provider.catalogPath ?? "");
    const curated = { models: [...(provider.curated ?? [])], live: false, readAt: new Date(now()).toISOString() };
    if (target.length === 0 || pathname.length === 0) {
      const answer = { ...curated, why: `${provider.name} has no model list to read, so this is the short list this product has run.` };
      writeJsonSetting(catalogSetting(provider.id), answer, actor);
      return answer;
    }
    if (String(apiKey ?? "").length === 0) {
      const last = readJsonSetting(catalogSetting(provider.id), null);
      const answer = last?.live === true
        ? { models: last.models, live: false, readAt: String(last.readAt ?? ""), why: `These are the names ${provider.name} gave on ${String(last.readAt ?? "an earlier refresh").slice(0, 10)}. A live read goes through the vendor with the key, and this service keeps no copy of one: paste the key to read the list again.` }
        : { ...curated, why: `This is the short list this product has run. A live read goes through ${provider.name} with the key, and this service keeps no copy of one: paste the key to read their list.` };
      writeJsonSetting(catalogSetting(provider.id), answer, actor);
      return answer;
    }
    const read = await readVendorCatalog(provider, apiKey);
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
   * THE OPPOSITE OF WHAT USED TO BE HERE: it takes the catalog door DOWN.
   *
   * There was a wireCatalog that registered /catalog/<provider> as a LiteLLM pass-through carrying
   * the vendor key as a cleartext header. See readVendorCatalog above for what that turned out to
   * be. This runs wherever that one used to, so an install that already has those rows loses them
   * the first time a key is added, rolled or a catalog is refreshed, and a fresh install never gets
   * them. It is safe to call when there is nothing to remove.
   *
   * The delete wants the ROW ID the POST answered with; DELETE by path answers 400 and removes
   * nothing (measured, and written down in deploy/coolify/proxy-config/config.yaml). So the rows are
   * listed first and each one is removed by its own id, and the outcome is reported rather than
   * assumed.
   */
  async function unwireCatalog(provider) {
    const path_ = `/catalog/${provider.id}`;
    const existing = await askProxy("/config/pass_through_endpoint", () => proxy.listPassThrough());
    if (!existing.ok) return { removed: 0, why: existing.why };
    const mine = existing.rows.filter((one) => one.path === path_);
    let removed = 0;
    let why = "";
    for (const row of mine) {
      const gone = await askProxy("/config/pass_through_endpoint delete", () => proxy.deletePassThrough(row.id));
      if (gone.ok) removed += 1;
      else why = gone.why;
    }
    if (removed > 0) store.setSetting(catalogSlotSetting(provider.id), "", "");
    return { removed, why };
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
    // The door list as the proxy really is, not as the constant hopes. A pass-through whose
    // credential header is empty is not a door a customer should be able to book a metered request
    // against: measured on the R750 2026-09-08, both TinyFish paths were live with `x-api-key: ""`.
    const routes = tenantRoutesFor(await proxy.listPassThrough());
    const rows = [];
    for (const tenant of store.listTenants()) {
      const record = proxyKeyOf(tenant.slug);
      if (record == null) { rows.push({ slug: tenant.slug, ok: false, why: "this workspace has no plan key yet" }); continue; }
      const answer = await askProxy("/key/update", () => proxy.updateKey({
        key: record.key,
        models: served.aliases,
        allowedRoutes: routes,
      }));
      rows.push({ slug: tenant.slug, ok: answer.ok === true, why: answer.ok ? "" : answer.why });
    }
    return { ok: rows.some((row) => row.ok), why: "", rows, models: served.aliases, routes };
  }

  // ---- what the agents reported (FEEDBACK-1) ---------------------------------------------------
  //
  // The panel's whole job is the SECOND of the two gates. The first one already happened inside the
  // customer's console: the workspace operator saw the report, could edit it, add to it or drop it,
  // and pressed Send. Everything listed here is therefore something a person chose to send, which
  // is why the actions are approve, edit, suppress and close rather than triage-from-nothing.
  //
  // The tiers are filters and nothing more. All three passed through both gates; critical is drawn
  // loudly because it blocks somebody's work today.

  const SETTING_GITHUB_REPO = "github.repo";
  const SETTING_GITHUB_TOKEN = "github.token";
  // Where GitHub is. api.github.com unless somebody names another, which is what lets a gate stand
  // a fake one up in its own process instead of filing a real issue at a real repository on every
  // run, and what lets an operator on GitHub Enterprise point this at their own host. Anybody who
  // can set this can already read this service's environment, so it is no weaker than CP_RELAY_URL.
  const githubApiBase = String(config.githubApiUrl ?? process.env.CP_GITHUB_API_URL ?? GITHUB_API).replace(/\/+$/, "");

  /** What is stored about the issue door, PROVED and never carried. Evidence only, at every caller. */
  const githubDoor = () => {
    const repo = store.getSetting(SETTING_GITHUB_REPO, "");
    const token = store.getSetting(SETTING_GITHUB_TOKEN, "");
    return {
      repo,
      stored: token.length > 0,
      // The same string the ledger keeps forever. No fragment of the value is in it.
      evidence: token.length > 0 ? keyEvidence(token) : "",
      why: token.length > 0
        ? ""
        : "no repository token is stored, so an issue can be prepared here and filed by hand. Paste one below and the Create GitHub issue button files it.",
    };
  };

  /**
   * Wave B's verification records, if that table has landed.
   *
   * The Feedback panel is where a "needs re-verification" marketplace row is meant to surface
   * (MARKET-26), and wave B owns the table it would come from. Probing sqlite_master rather than
   * importing a module means this returns an empty list on a tree where that wave has not shipped,
   * instead of a stack trace, and the panel simply draws three filters instead of four.
   *
   * WAVE B FILLS THIS IN. Point it at the table you create and give it a row shape; nothing else
   * on this page has to change.
   */
  function verificationRows() {
    const tables = typeof store.tableNames === "function" ? store.tableNames() : [];
    const table = tables.find((name) => /verification/i.test(name)) ?? null;
    return { table, rows: [] };
  }

  /**
   * The panel's own answer. Filters are applied in the store, not here, so a workspace with
   * thousands of observations does not have to be read into this process to show ten critical ones.
   */
  function feedback({ tier = "", state = "", tenant = "", sinceMs = 0, limit = 200 } = {}) {
    const rows = store.listFeedback({ tier, state, tenant, sinceMs, limit });
    // The counts are over EVERYTHING, not over the filtered list, because the number the operator
    // needs on a bad morning is "how many critical reports are open", and a filter is exactly what
    // hides that.
    const open = store.listFeedback({ limit: 2000 });
    const counting = (t, s) => open.filter((row) => (t === "" || row.tier === t) && (s === "" || row.state === s)).length;
    return {
      rows: rows.map((row) => ({ ...row, at: new Date(row.at).toISOString(), decidedAt: row.decidedAt > 0 ? new Date(row.decidedAt).toISOString() : "" })),
      total: store.countFeedback(),
      counts: {
        new: counting("", "new"),
        critical: counting("critical", ""),
        criticalNew: open.filter((row) => row.tier === "critical" && row.state === "new").length,
        filed: counting("", "filed"),
      },
      tiers: FEEDBACK_TIERS.map((name) => ({ name, means: TIER_ROUTING[name] })),
      states: FEEDBACK_STATES,
      github: githubDoor(),
      verification: verificationRows(),
      // The sentence the panel prints under its heading, so the two gates are on the screen rather
      // than only in a document.
      gates: "Every report here was written by an agent, shown to the workspace operator, and sent"
        + " by that person. This is the second gate: what you approve becomes a GitHub issue, and"
        + " what you suppress is kept with the decision on it.",
      retention: "these rows are never pruned",
      measuredAt: new Date(now()).toISOString(),
    };
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
      // PROVED BEFORE IT IS STORED. A mistyped or expired value used to be live on the very next
      // request with the operator told nothing but "the key is in slot zai-3".
      const proof = await proveKey(provider, apiKey);
      if (!proof.ok) {
        json(response, 409, {
          error: "key_refused",
          message: `${provider.name} would not accept that key, so nothing was stored. ${proof.why}`,
          checkedWith: proof.how,
        });
        return true;
      }
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
      // The one moment the model list can honestly be read live: the key is in hand for this
      // request and for no other. Nothing about it is persisted here or at the proxy.
      const catalog = await refreshCatalog(provider, guard.account?.email ?? "the operator token", apiKey);
      // And the cleartext pass-through this route used to leave behind comes down.
      const unwired = await unwireCatalog(provider);
      ledger.done(`slot ${slot} now holds a key (${keyEvidence(apiKey)}), checked against ${proof.how}`);
      json(response, 200, {
        slot,
        label,
        checkedWith: proof.how,
        provable: proof.provable !== false,
        catalog: { models: catalog.models, live: catalog.live === true, readAt: catalog.readAt, why: catalog.why },
        ...(unwired.removed > 0 ? { removedPassThroughs: unwired.removed } : {}),
        message: proof.provable === false
          ? `The key is in slot ${slot}. ${proof.how}, so it is stored unchecked. It serves nothing until a plan model is pointed at it.`
          : `The key is in slot ${slot} and ${provider.name} accepted it. It serves nothing until a plan model is pointed at it.`,
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
        // THE CANDIDATE IS PROVED BEFORE THE SERVING SLOT IS TOUCHED.
        //
        // MEASURED ON THE R750 2026-09-08 with a throwaway slot and deployment, no plan alias and no
        // tenant on it: PATCH /credentials to a junk value answered 200; the next chat completion
        // 401'd 0.3 s later; the three after that got 429 "No deployments available,
        // cooldown_list=['review-roll-probe-1']" for 30 s. There is no undo -- the old value is
        // overwritten in place -- so a bad paste on a one-key pool is an outage of that plan model
        // that outlasts the operator's next click. Proving first costs one request to the vendor.
        const proof = await proveKey(provider, apiKey);
        if (!proof.ok && body?.force !== true) {
          json(response, 409, {
            error: "key_refused",
            message: `${provider.name} would not accept that key, so slot ${slot} was NOT changed and the pool is still serving on the key it had. ${proof.why}`,
            checkedWith: proof.how,
          });
          return true;
        }
        const ledger = beginAction(guard, request, {
          action: "provider.key.roll",
          target: `${provider.id}/${slot}`,
          detail: `rolling the key in slot ${slot} (${keyEvidence(apiKey)}), checked against ${proof.how}${proof.ok ? "" : " and forced past its refusal"}`,
        });
        const rolled = await askProxy("/credentials patch", () => proxy.patchCredential({ name: slot, apiKey }));
        if (!rolled.ok) { ledger.failed(rolled.why); json(response, 502, { error: "proxy", message: rolled.why }); return true; }
        const catalog = await refreshCatalog(provider, guard.account?.email ?? "the operator token", apiKey);
        const unwired = await unwireCatalog(provider);
        ledger.done(`slot ${slot} now holds a different key (${keyEvidence(apiKey)})`);
        json(response, 200, {
          slot,
          checkedWith: proof.how,
          provable: proof.provable !== false,
          catalog: { models: catalog.models, live: catalog.live === true, readAt: catalog.readAt, why: catalog.why },
          ...(unwired.removed > 0 ? { removedPassThroughs: unwired.removed } : {}),
          // The old copy said a request already under way may finish on the old key. The
          // measurement above says the opposite: the new value bites on the very next request. A
          // reassuring sentence that is not true is how an operator rolls a key at 09:00 on a
          // Monday believing there is a grace period.
          message: `Slot ${slot} holds the new key, and ${provider.name} accepted it before the swap. The pool never changed shape, so nothing was taken out of service. The new value serves the very next request; there is no grace period on the old one.`,
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
            snapshot.push({ alias: row.alias, vendorModel: row.vendorModel, id: row.id, contextWindow: row.contextWindow, supportsVision: row.supportsVision, inputCostPerToken: row.inputCostPerToken, outputCostPerToken: row.outputCostPerToken, customerName: row.customerName, customerLabel: row.customerLabel, servedBy: row.servedBy, customerVisible: row.customerVisible, visionFallback: row.visionFallback, plans: row.plans, keyLabel: row.keyLabel, keyOrder: row.keyOrder });
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
            params: {
              ...(provider.baseUrl ? { api_base: provider.baseUrl } : {}),
              ...(row.inputCostPerToken != null ? { input_cost_per_token: row.inputCostPerToken } : {}),
              ...(row.outputCostPerToken != null ? { output_cost_per_token: row.outputCostPerToken } : {}),
            },
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

    // A LIVE CHECK, because the operator asked for one. Nothing on this install runs health in the
    // background (config.yaml sets background_health_checks false, deliberately: a sweep the tenants
    // can trigger spends the operator's money), so this is the only way a provider light goes green
    // on purpose rather than by inference from the request log.
    if (rest.length === 3 && rest[0] === "providers" && rest[2] === "health" && method === "POST") {
      const provider = providerById(decodeURIComponent(rest[1]));
      if (provider == null) { json(response, 404, { error: "not_found", message: "There is no provider by that name." }); return true; }
      const models = await askProxy("/model/info", () => proxy.listModels());
      if (!models.ok) { json(response, 502, { error: "proxy", message: models.why }); return true; }
      const mine = models.rows.filter((row) => String(row.provider ?? "") === provider.id);
      if (mine.length === 0) {
        json(response, 409, { error: "nothing_to_check", message: `${provider.name} serves no model here yet, so there is nothing to check. Add a key and a plan model first.` });
        return true;
      }
      const ledger = beginAction(guard, request, { action: "provider.health", target: provider.id, detail: `checking ${mine.length} deployment(s) on ${provider.name}` });
      const checked = [];
      for (const row of mine) {
        const answer = await askProxy("/health", () => proxy.deploymentHealth(row.id));
        checked.push({ id: row.id, alias: row.alias, keySlot: row.keySlot, ok: answer.ok === true && answer.healthy === true, why: answer.ok ? answer.why : answer.why });
      }
      const bad = checked.filter((row) => !row.ok);
      writeJsonSetting(healthSetting(provider.id), {
        ok: bad.length === 0,
        why: bad.length === 0 ? "" : `${bad.length} of ${checked.length} deployment(s) did not answer${bad[0]?.why ? `; the first said: ${bad[0].why}` : ""}`,
        at: now(),
      }, guard.account?.email ?? "the operator token");
      ledger.done(`${checked.length - bad.length} of ${checked.length} deployment(s) answered`);
      json(response, 200, {
        provider: provider.id,
        deployments: checked,
        reachable: bad.length === 0,
        // Every check costs the vendor a request, which is why this is a button and not a timer.
        message: bad.length === 0
          ? `${provider.name} answered on all ${checked.length} deployment(s). This is a real request to the vendor, made just now.`
          : `${bad.length} of ${checked.length} deployment(s) on ${provider.name} did not answer${bad[0]?.why ? `: ${bad[0].why}` : "."}`,
      });
      return true;
    }

    if (rest.length === 4 && rest[0] === "providers" && rest[2] === "catalog" && rest[3] === "refresh" && method === "POST") {
      const provider = providerById(decodeURIComponent(rest[1]));
      if (provider == null) { json(response, 404, { error: "not_found", message: "There is no provider by that name." }); return true; }
      // A key MAY be pasted to make this a live read. It is used for the one outbound request and
      // stored nowhere: this service deliberately keeps no copy of a vendor key, which is why a
      // Refresh without one returns the last live list with its date rather than a fresh claim.
      const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
      const ledger = beginAction(guard, request, {
        action: "provider.catalog.refresh",
        target: provider.id,
        detail: apiKey.length > 0 ? `reading ${provider.name}'s model list with a pasted key (${keyEvidence(apiKey)})` : `reading ${provider.name}'s stored model list`,
      });
      const answer = await refreshCatalog(provider, guard.account?.email ?? "the operator token", apiKey);
      await unwireCatalog(provider);
      ledger.done(`${answer.models.length} name(s), ${answer.live ? "read from the vendor" : "the stored list"}`);
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
      // WHAT A REQUEST COSTS. Without it every dollar on every page is a zero, and a zero on a spend
      // column is indistinguishable from a customer who has not spent anything: on the R750
      // 2026-09-08 richard-avery read $0.00 at 665,915 tokens. LiteLLM has no price for a Z.AI or
      // Alibaba model id, so nobody else is going to supply one. Optional, because a subscription
      // plan genuinely has no per-token price and pretending one would be worse -- but then the
      // pages say "not priced" rather than drawing a zero.
      const priceParams = priceOf(body);
      if (customerVisible && !supportsVision && visionFallback.length === 0) {
        json(response, 400, {
          error: "bad_request",
          message: "Every Titan conversation carries screenshots. Either this model takes an image, or name the model a request carrying one falls back to. A plan model that refuses images is a fleet-wide screenshot outage, which is what PROXY-10 cost.",
        });
        return true;
      }
      // A MODEL CANNOT BE ITS OWN FALLBACK ON A PROMISE. Naming yourself satisfies the guard above
      // while registering nothing, and that is exactly the state plan-minimax shipped in: customer
      // visible, visionFallback plan-minimax, never once asked whether it takes an image, and GET
      // /fallback/plan-minimax answering 404. Any workspace moved onto it takes PROXY-10 again on
      // its first screenshot turn. So self-naming is allowed only where the vision check has
      // actually passed on record.
      if (visionFallback.length > 0 && visionFallback === alias && !(supportsVision && body?.visionOk === true)) {
        json(response, 409, {
          error: "vision_unproved",
          message: `${alias} cannot be its own screenshot fallback until it has been asked whether it takes an image and answered yes. Create it, run Check screenshots on it, then set the fallback -- or name a different model.`,
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
          params: { ...(provider.baseUrl ? { api_base: provider.baseUrl } : {}), ...priceParams },
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
      // A FALLBACK THAT DID NOT REGISTER IS NOT A SUCCESS. This used to answer 200 with the proxy's
      // refusal tucked into a `why` field nobody reads, so a model could go customer-visible with no
      // screenshot route at all and the page would show it as done. It is a 409 with the proxy's own
      // sentence now, and the model stays hidden until the operator fixes it.
      if (!fallback.ok && customerVisible) {
        const hidden = [];
        for (const row of made.filter((one) => one.ok)) {
          const patched = await askProxy("/model/{id}/update", () => proxy.patchModel({ id: row.id, info: { [TB.customerVisible]: false } }));
          hidden.push({ id: row.id, ok: patched.ok === true });
        }
        ledger.failed(`the screenshot fallback did not register: ${fallback.why}`);
        json(response, 409, {
          error: "fallback_refused",
          message: `${alias} was created on ${landed} key(s) but its screenshot fallback did not register, so it is kept OFF every customer's card. The proxy said: ${fallback.why}`,
          deployments: made,
          hidden,
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
        // POST /model/update MERGES litellm_params, so a repoint keeps a price that is already
        // there and this only has to carry one when the operator changed it.
        const priceParams = priceOf(body);
        if (vendorModel.length === 0 && Object.keys(info).length === 0 && Object.keys(priceParams).length === 0) {
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
        // The same self-fallback rule as the create route, on the edit too: a model that names
        // itself has to have passed the screenshot check.
        const wouldFallBackTo = String(body?.visionFallback ?? known.visionFallback ?? "");
        const wouldTakeImages = body?.supportsVision === undefined ? known.supportsVision === true : body.supportsVision === true;
        if (wouldFallBackTo === alias && !(wouldTakeImages && known.visionOk === true)) {
          json(response, 409, {
            error: "vision_unproved",
            message: `${alias} cannot be its own screenshot fallback until Check screenshots has passed on it. Run that first, or name a different model.`,
          });
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
            ? await askProxy("/model/update", () => proxy.updateModel({ id: row.id, vendorModel, info, params: priceParams }))
            : await askProxy("/model/{id}/update", () => proxy.patchModel({ id: row.id, info, params: priceParams }));
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
        // A screenshot fallback that the proxy refused is reported as a refusal, not as a field in
        // a 200. The model itself changed; the fallback did not, and a customer-visible model with
        // no screenshot route is PROXY-10 waiting to happen.
        if (fallback != null && !fallback.ok && wouldBeVisible) {
          ledger.failed(`the screenshot fallback did not register: ${fallback.why}`);
          json(response, 409, {
            error: "fallback_refused",
            message: `${alias} changed, but its screenshot fallback did not register and this model is on customers' cards. The proxy said: ${fallback.why}`,
            deployments: changed,
          });
          return true;
        }
        ledger.done(`${landed} of ${editable.length} deployment(s) changed${fromFile > 0 ? `, and ${fromFile} more are declared in the proxy's file and were left alone` : ""}`);
        const ran = ranAlias(await askProxySpend(), alias, rows.map((row) => row.id));
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
      // THE POOL ITSELF. Jason, 2026-09-08: "add a third, second, or fourth key on a specific model
      // plan." Adding a key to a PROVIDER is one thing; putting an existing plan model onto it is
      // another, because a plan model IS its deployments and there is one per key. Without this a
      // key added after the model was created could only be attached by deleting the model and
      // making it again, which is exactly the hand operation this wave exists to end.
      //
      // Add first, then remove, never the reverse: a pool must not be short a key for an instant.
      if (action === "keys") {
        const wanted = Array.isArray(body?.keySlots) ? [...new Set(body.keySlots.map(String))] : null;
        if (wanted == null || wanted.length === 0) {
          json(response, 400, { error: "bad_request", message: "Name the keys this model should run on. A plan model with no key behind it serves nothing." });
          return true;
        }
        const mine = rows.filter((row) => row.fromDb === true);
        const have = new Set(mine.map((row) => row.keySlot));
        const adding = wanted.filter((slot) => !have.has(slot));
        const removing = mine.filter((row) => !wanted.includes(row.keySlot));
        if (adding.length === 0 && removing.length === 0) {
          json(response, 200, { alias, keySlots: wanted, message: `${alias} already runs on ${wanted.join(", ")}. Nothing changed.` });
          return true;
        }
        const credentials = await askProxy("/credentials", () => proxy.listCredentials());
        if (!credentials.ok) { json(response, 502, { error: "proxy", message: credentials.why }); return true; }
        const provider = providerById(known.provider) ?? { id: known.provider, kind: "openai", baseUrl: "" };
        const ledger = beginAction(guard, request, {
          action: "plan-model.keys",
          target: alias,
          detail: `${adding.length > 0 ? `adding ${adding.join(", ")}` : ""}${adding.length > 0 && removing.length > 0 ? "; " : ""}${removing.length > 0 ? `removing ${removing.map((row) => row.keySlot).join(", ")}` : ""}`,
        });
        const added = [];
        for (const slot of adding) {
          const credential = credentials.rows.find((row) => row.name === slot);
          if (credential == null) { added.push({ slot, ok: false, why: `there is no key in slot ${slot}` }); continue; }
          const id = deploymentIdFor(alias, slot);
          const answer = await askProxy("/model/new", () => proxy.addModel({
            alias,
            vendorModel: known.vendorModel,
            credentialName: slot,
            id,
            params: {
              ...(provider.baseUrl ? { api_base: provider.baseUrl } : {}),
              // The price too, or the pool's new key would bill at zero while its siblings billed
              // correctly and the per-key column would be nonsense.
              ...(known.inputCostPerToken != null ? { input_cost_per_token: known.inputCostPerToken } : {}),
              ...(known.outputCostPerToken != null ? { output_cost_per_token: known.outputCostPerToken } : {}),
            },
            // The same facts the other deployments behind this alias carry, so a pool stays one
            // thing rather than becoming two rows that disagree about what a customer is told.
            info: {
              ...(Number(known.contextWindow) > 0 ? { max_input_tokens: Number(known.contextWindow) } : {}),
              supports_vision: known.supportsVision === true,
              [TB.provider]: known.provider,
              [TB.keySlot]: slot,
              [TB.keyLabel]: credential.label,
              [TB.keyOrder]: credential.order ?? 0,
              [TB.customerName]: known.customerName,
              [TB.customerLabel]: known.customerLabel,
              [TB.servedBy]: known.servedBy,
              [TB.customerVisible]: known.customerVisible === true,
              [TB.visionFallback]: known.visionFallback,
              [TB.plans]: known.plans,
            },
          }));
          added.push({ slot, id, ok: answer.ok === true, why: answer.ok ? "" : answer.why });
        }
        // Only once something is serving. A pool that went empty for an instant is the failure this
        // whole shape exists to avoid, so a removal that would empty it is refused rather than run.
        const serving = mine.length + added.filter((row) => row.ok).length - removing.length;
        const taken = [];
        if (serving < 1) {
          ledger.failed("that would leave the alias with no deployment");
          json(response, 409, { error: "empty", message: `That would leave ${alias} with nothing to run on. Add a key before taking the last one away.`, added });
          return true;
        }
        for (const row of removing) {
          const answer = await askProxy("/model/delete", () => proxy.deleteModel(row.id));
          taken.push({ slot: row.keySlot, ok: answer.ok === true, why: answer.ok ? "" : answer.why });
        }
        ledger.done(`${alias} now runs on ${wanted.join(", ")}`);
        json(response, 200, {
          alias,
          keySlots: wanted,
          added,
          removed: taken,
          message: `${alias} runs on ${wanted.length === 1 ? "one key" : `${wanted.length} keys`} from the next request: ${wanted.join(", ")}. The load spreads across them and one being rate limited no longer stops the others.`,
        });
        return true;
      }

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
        // Candidates are the boxes actually POINTED at the alias plus the ones whose traffic ran on
        // it, and the first list is the one that matters: a box on the alias with a stale label is
        // exactly what this route exists to repair, and it may not have sent a request this month.
        const ran = ranAlias(await askProxySpend(), alias, rows.map((row) => row.id));
        const pointed = (await boxLabels()).filter((row) => row.read && row.model === alias).map((row) => row.slug);
        ran.slugs = [...new Set([...pointed, ...ran.slugs])];
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
        const ran = ranAlias(await askProxySpend(), alias, rows.map((row) => row.id));
        ran.slugs = [...new Set([...(await boxLabels()).filter((row) => row.read && row.model === alias).map((row) => row.slug), ...ran.slugs])];
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
      // AGENTS-CAP-2. How many bots this one workspace may hold, from its own row.
      //
      // Jason, 2026-09-09: default 40, and the super admin raises a workspace's ceiling from its
      // client row. Forty because flat coordination holds to about that many and the hierarchy
      // tooling does not exist yet; a power user who wants a hundred asks and gets it here.
      //
      // THE RANGE IS CHECKED IN THIS PROCESS. The host fails open on a value it cannot use, so a
      // zero or a five thousand written into a box drops that customer to the product default with
      // nothing anywhere saying why. Refusing here is what keeps that from being a silent
      // downgrade of somebody's live workspace.
      if (action === "ceiling") {
        const wanted = Number(body?.maxAgents);
        if (!Number.isInteger(wanted) || wanted < CEILING_MIN || wanted > CEILING_MAX) {
          json(response, 400, {
            error: "bad_request",
            message: `A ceiling is a whole number from ${CEILING_MIN} to ${CEILING_MAX}. Nothing was changed: a number outside that is one the box quietly ignores, which would put this workspace back on the default with nothing on any screen saying so.`,
          });
          return true;
        }
        const ledger = beginAction(guard, request, { action: "client.ceiling", target: slug, detail: `${slug} to ${wanted} bots` });
        const answer = await askRelayPost(`/admin/tenants/${encodeURIComponent(slug)}/ceiling`, { maxAgents: wanted });
        if (!answer.ok) { ledger.failed(answer.why); json(response, 502, { error: "relay", message: answer.why }); return true; }
        forgetCeilings();
        // WHAT THE BOX READ BACK, never what was sent. The relay writes the file and then asks the
        // host what its ceiling now is, so this number is the live one; reporting the number that
        // went out would report a success on a box that ignored it.
        const read = answer.body?.read === true;
        const live = read && Number.isFinite(Number(answer.body?.maxAgents)) ? Number(answer.body.maxAgents) : null;
        const pinned = answer.body?.pinned === true;
        ledger.done(pinned
          ? `${slug} was written and its container environment pins ${String(answer.body?.pinnedBy ?? "SAND_MAX_AGENTS")}`
          : `${slug} now holds ${live == null ? "a ceiling the box did not report" : live}`);
        json(response, 200, {
          slug,
          asked: wanted,
          maxAgents: live,
          bots: read && Number.isFinite(Number(answer.body?.bots)) ? Number(answer.body.bots) : null,
          pinned,
          pinnedBy: answer.body?.pinnedBy ?? null,
          // PINNED IS NOT A SUCCESS, said the way the model row two blocks up says it.
          message: pinned
            ? `${slug} was written, and it will keep the ceiling its container environment pins: ${String(answer.body?.pinnedBy ?? "SAND_MAX_AGENTS is set on the container")}. Nothing this console does takes effect there until that is gone.`
            : live == null
              ? `${slug} was written and its box did not report a ceiling back, so nothing here can say what it is now. ${String(answer.body?.why ?? "")}`.trim()
              : `${slug} holds ${live} bots from now on. Their own page shows it on its next load.`,
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

    // ---- FEEDBACK-1: the seventh panel ------------------------------------------------------------
    //
    // Appended at the end rather than beside the read routes, so the whole feature is one block a
    // reader can take in at once. It is behind requireSuperAdmin like everything else here without
    // saying so: the guard ran before `rest` was computed and returned already if it failed.

    if (rest[0] === "feedback") {
      if (rest.length === 1 && method === "GET") {
        const sinceParam = url.searchParams.get("since");
        const sinceMs = sinceParam
          ? (Number.isFinite(Number(sinceParam)) ? Number(sinceParam) : Date.parse(sinceParam))
          : 0;
        json(response, 200, feedback({
          tier: String(url.searchParams.get("tier") ?? ""),
          state: String(url.searchParams.get("state") ?? ""),
          tenant: String(url.searchParams.get("tenant") ?? ""),
          sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0,
          limit: Number(url.searchParams.get("limit") ?? 200),
        }));
        return true;
      }

      // The repository token, and it is the FIRST secret this store has ever held.
      //
      // Proved before it is stored, exactly the way a provider key is: a token that GitHub will not
      // take is a Create GitHub issue button that fails weeks later on somebody else's morning.
      // Nothing about the value comes back out of this route or any other: the answer, the ledger
      // row and the panel all carry a length and eight hex characters of a digest.
      //
      // It is here rather than at the proxy because there is no proxy for a repo token to hide
      // behind, and it is never pushed into a box: every exec daemon in a customer's container runs
      // as uid 0, so a super admin's token inside one is readable by that customer's own agents.
      if (rest.length === 2 && rest[1] === "github-token" && method === "POST") {
        const token = typeof body?.token === "string" ? body.token.trim() : "";
        const repo = String(body?.repo ?? "").trim();
        const parsed = parseRepo(repo);
        if (parsed == null) { json(response, 400, { error: "bad_request", message: "Name the repository as owner/name. Nothing was stored." }); return true; }
        if (token.length < 8) { json(response, 400, { error: "bad_request", message: "Paste the token. Nothing was stored." }); return true; }
        const proof = await proveRepoToken({ token, repo: parsed.full, fetchImpl, apiBase: githubApiBase });
        if (!proof.ok) {
          json(response, 409, { error: "token_refused", message: `GitHub would not accept that token for ${parsed.full}, so nothing was stored. ${proof.why}` });
          return true;
        }
        const ledger = beginAction(guard, request, {
          action: "feedback.github-token",
          target: parsed.full,
          detail: `a repository token for ${parsed.full} (${keyEvidence(token)})`,
        });
        const actor = guard.account?.email ?? "the operator token";
        store.setSetting(SETTING_GITHUB_REPO, parsed.full, actor);
        store.setSetting(SETTING_GITHUB_TOKEN, token, actor);
        ledger.done(`checked against ${proof.how}`);
        json(response, 200, {
          repo: parsed.full,
          checkedWith: proof.how,
          // NOT the token. Nothing on this service ever answers with it again.
          evidence: keyEvidence(token),
          message: `${parsed.full} accepted that token. Create GitHub issue files there from now on.`,
        });
        return true;
      }

      if (rest.length === 3 && method === "POST") {
        const id = Number(rest[1]);
        const verb = rest[2];
        const row = Number.isFinite(id) ? store.getFeedback(id) : null;
        if (row == null) { json(response, 404, { error: "not_found", message: "There is no report by that number." }); return true; }
        const actor = guard.account?.email ?? "the operator token";

        // Edit is the operator's own words added to somebody else's report, so the two are kept
        // apart: the title and the description move, the PAYLOAD does not. What the agent actually
        // sent is still exactly what it sent, whatever gets typed over the top of it.
        if (verb === "edit") {
          const title = String(body?.title ?? row.title).replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
          const text = String(body?.body ?? row.body);
          if (title.length === 0) { json(response, 400, { error: "bad_request", message: "A report needs a title. Nothing was changed." }); return true; }
          const ledger = beginAction(guard, request, { action: "feedback.edit", target: String(id), detail: `report ${id} edited` });
          let updated;
          try { updated = store.updateFeedback(id, { title, body: text, decidedBy: actor }); }
          catch (error) { ledger.failed(String(error?.message ?? error)); json(response, 400, { error: error?.code ?? "bad_request", message: String(error?.message ?? error) }); return true; }
          ledger.done();
          json(response, 200, { report: { ...updated, at: new Date(updated.at).toISOString() }, message: `Report ${id} now reads as you left it. What the agent sent is kept underneath it, unchanged.` });
          return true;
        }

        if (verb === "approve" || verb === "suppress" || verb === "close") {
          const state = verb === "approve" ? "approved" : (verb === "suppress" ? "suppressed" : "closed");
          const ledger = beginAction(guard, request, { action: `feedback.${verb}`, target: String(id), detail: `report ${id} to ${state}` });
          const updated = store.updateFeedback(id, { state, decidedBy: actor });
          ledger.done();
          json(response, 200, {
            report: { ...updated, at: new Date(updated.at).toISOString() },
            message: verb === "approve"
              ? `Report ${id} is approved. Press Create GitHub issue to file it.`
              : verb === "suppress"
                ? `Report ${id} is suppressed. It stays on the record with your name on the decision, because "we looked at this and it was not a bug" is itself worth keeping.`
                : `Report ${id} is closed.`,
          });
          return true;
        }

        // The issue. With a token stored it is filed and the URL is recorded; with none the body is
        // PREPARED and handed back, and the answer says exactly that rather than pretending the
        // door is broken. The body is built from the payload the agent sent, not from the edited
        // title, so what lands on GitHub is the evidence.
        if (verb === "issue") {
          const door = githubDoor();
          const payload = row.payload ?? normalizeReport({ tier: row.tier, title: row.title, description: row.body }).report;
          const issueBody = buildIssueBody(payload ?? {}, { workspace: row.tenant, id: row.id });
          const issueTitle = `[${row.tier}] ${row.title}`;
          if (!door.stored) {
            json(response, 200, {
              filed: false,
              title: issueTitle,
              body: issueBody,
              repo: door.repo,
              message: "the issue body is ready; paste a repo token in the Feedback panel and press this again",
            });
            return true;
          }
          const ledger = beginAction(guard, request, { action: "feedback.issue", target: String(id), detail: `report ${id} to ${door.repo}` });
          const filed = await fileIssue({
            token: store.getSetting(SETTING_GITHUB_TOKEN, ""),
            repo: door.repo,
            title: issueTitle,
            body: issueBody,
            labels: ["titanium-bot", row.tier],
            fetchImpl,
            apiBase: githubApiBase,
          });
          if (!filed.ok) {
            ledger.failed(filed.why);
            json(response, 502, { error: "github", filed: false, title: issueTitle, body: issueBody, message: filed.why });
            return true;
          }
          const updated = store.updateFeedback(id, { state: "filed", issueUrl: filed.url, decidedBy: actor });
          ledger.done(`filed as ${filed.url}`);
          json(response, 200, {
            filed: true,
            issueUrl: filed.url,
            report: { ...updated, at: new Date(updated.at).toISOString() },
            message: `Report ${id} is ${filed.url}.`,
          });
          return true;
        }

        json(response, 404, { error: "not_found" });
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

  return { handle, servePage, recordAttempt, requireSuperAdmin, signIns, clients, boxes, system, spend, providers: providersAnswer, feedback };
}
