// ui/login-ledger.mjs -- who knocked at this console, when, from where, and whether they got in.
//
// ADMIN-1, item 1. Jason, 2026-09-07 15:12: "we should capture tries, users and passwords tried and
// report in the Super admin for failures with IP."
//
// THE PASSWORD DECISION, and it is the only interesting thing in this file.
//
// The panel has to be able to tell the operator two different stories apart. One address trying the
// SAME wrong password forty times is somebody's phone with a stale saved password, or a script with
// one leaked credential. One address trying forty DIFFERENT passwords is an attack. Those look
// identical unless something about the password itself is kept.
//
// So what is kept is HMAC-SHA256(salt, password), and never the password. The salt is 32 random
// bytes generated once, written 0600 into the relay's own state directory, and it never leaves this
// machine. Two consequences, both wanted:
//
//   - Reading this file tells you that two tries were the same password, and nothing else. There is
//     no dictionary attack worth running against a keyed hash whose key you do not have, and the
//     key is not in the file, not in the ledger row, and not in any response.
//   - The hashes do not compare across machines. The relay's salt and the control plane's salt are
//     different values, so a row from here and a row from there are never "the same password" even
//     when they are. That is the price of the salt being per relay, and it is the right price: the
//     alternative is one shared secret that makes every instance's hashes rainbow-comparable to
//     each other.
//
// A successful sign-in gets no hash at all. There is no reason to hold anything derived from a
// password that WORKED, and a file of keyed hashes where one of them is known-good is a worse file
// than one where none of them is.
//
// Nothing here imports anything outside node builtins, because the relay image has no node_modules.

import { createHmac, randomBytes } from "node:crypto";
import { appendFile, chmod, chown, readFile, rename, stat } from "node:fs/promises";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LEDGER_NAME = "login-attempts.jsonl";
export const SALT_NAME = "login-attempt-salt";

// Five megabytes, then the file is renamed and a fresh one starts. One previous file is kept, so
// the ceiling on disk is ten megabytes whatever happens. A JSONL row here is about 220 bytes, so
// five megabytes is roughly 24,000 attempts: months of an ordinary console and about a day of
// somebody hammering it, which is the case the ledger is actually for.
export const LEDGER_MAX_BYTES = 5 * 1024 * 1024;

// The user agent is a string a stranger writes, so it is truncated rather than trusted. 120
// characters is enough to tell a browser from curl from a scanner and not enough to be a payload.
export const USER_AGENT_LIMIT = 120;

// The doors. `instance` is the operator's own password; `account` is a customer's email and
// password, which the control plane decides. A request too large to be a password has no door of
// its own and is recorded as `instance`, because that is the door the relay's own code would have
// sent it to: an empty email means the instance door.
export const DOORS = new Set(["account", "instance"]);
export const OUTCOMES = new Set(["ok", "refused", "locked"]);

const clip = (value, limit) => {
  const text = String(value ?? "");
  return text.length > limit ? text.slice(0, limit) : text;
};

/**
 * The per-relay salt, made once and read forever after.
 *
 * 0600 on create AND a chmod after, because writeFileSync's mode only applies when it creates the
 * file: a salt file that was once 0644 stays 0644 without the second call. Same reason
 * ui/auth.mjs writes auth.json that way.
 *
 * A file that exists and is empty or truncated is replaced. That loses the ability to compare old
 * rows against new ones, which is a smaller loss than a ledger that cannot hash at all.
 */
export function readOrCreateSalt(file) {
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32,}$/i.test(existing)) return existing;
  } catch { /* not there yet, or not readable: make one */ }
  const salt = randomBytes(32).toString("hex");
  writeFileSync(file, `${salt}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return salt;
}

/**
 * The keyed hash of a tried password. "" for an empty password and for a missing salt, because a
 * hash of nothing is not evidence of anything and a hash under a key we do not have is a lie.
 */
export function hashTried(password, salt) {
  const text = String(password ?? "");
  const key = String(salt ?? "");
  if (text.length === 0 || key.length === 0) return "";
  return createHmac("sha256", key).update(text, "utf8").digest("hex");
}

/**
 * One row, in the shape the contract fixes, with every field forced to a type. The row is written
 * from values a stranger controls (the email field, the user agent), so nothing here is passed
 * through as it arrived.
 *
 * `email` is lowercased because that is how the control plane stores an address and the panel
 * groups by it; it is otherwise as typed, including the shapes that are not addresses at all,
 * because "who is being guessed at" is the question the operator is asking.
 */
export function loginAttemptRow({
  at = new Date().toISOString(), door = "instance", email = "", ip = "", userAgent = "",
  triedHash = "", outcome = "refused", tenant = "",
} = {}) {
  return {
    at: typeof at === "number" ? new Date(at).toISOString() : String(at),
    door: DOORS.has(String(door)) ? String(door) : "instance",
    email: clip(String(email ?? "").trim().toLowerCase(), 200),
    ip: clip(ip, 60),
    userAgent: clip(userAgent, USER_AGENT_LIMIT),
    // Never the password, and never anything the password can be recovered from. See the top.
    triedHash: /^[0-9a-f]{64}$/i.test(String(triedHash ?? "")) ? String(triedHash) : "",
    outcome: OUTCOMES.has(String(outcome)) ? String(outcome) : "refused",
    tenant: clip(tenant, 64),
  };
}

/**
 * Rows out of one file, tolerating a torn last line. A ledger that throws on a half-written row
 * would take the admin panel down for the one thing that says an attack is in progress.
 */
export async function readLedgerFile(file) {
  let raw;
  try { raw = await readFile(file, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") rows.push(parsed);
    } catch { /* a torn line is not worth failing the panel over */ }
  }
  return rows;
}

/**
 * The ledger itself.
 *
 * `dir` is the relay's own state directory, not a tenant's: a refused sign-in has no tenant yet, so
 * there is nowhere per-tenant to put it. On the R750 that is /state in the container, bound from
 * /home/sem/titanbot/state on the host.
 *
 * `ownLikeParent` is the relay's own chown helper. The relay runs as root inside its container and
 * files it writes into a bind mount must end up owned by the host directory's owner, or the
 * operator's own backup cannot read them.
 */
export function createLoginLedger({
  dir = ".",
  file = path.join(dir, LEDGER_NAME),
  saltFile = path.join(dir, SALT_NAME),
  maxBytes = LEDGER_MAX_BYTES,
  now = () => Date.now(),
  ownLikeParent = null,
  log = () => {},
} = {}) {
  const previous = `${file}.1`;
  let salt = null;

  // Read lazily rather than at construction, so a relay whose state directory is not writable yet
  // still boots. The first attempt makes the file.
  const saltOf = () => {
    if (salt != null) return salt;
    try { salt = readOrCreateSalt(saltFile); }
    catch (error) { log(`login ledger could not make its salt at ${saltFile}: ${error?.message ?? error}`); salt = ""; }
    return salt;
  };

  const own = async (target) => {
    if (typeof ownLikeParent === "function") { await ownLikeParent(target); return; }
    try { const parent = await stat(path.dirname(target)); await chown(target, parent.uid, parent.gid); } catch { /* same user, or not root */ }
  };

  // Rename, do not copy. A rename is atomic on the same filesystem, so there is no window where a
  // row can land in a file that is about to be replaced. The previous file is overwritten, which is
  // what "keep one previous file" means.
  const rotateIfNeeded = async () => {
    let size = 0;
    try { size = (await stat(file)).size; } catch { return false; }
    if (size < maxBytes) return false;
    try { await rename(file, previous); return true; }
    catch (error) { log(`login ledger could not rotate ${file}: ${error?.message ?? error}`); return false; }
  };

  return {
    file,
    previousFile: previous,
    saltFile,
    // For the tests and for a gate that wants to prove the hash is what it says it is. It is the
    // hash, never the salt: nothing hands the salt out.
    hash(password) { return hashTried(password, saltOf()); },

    /**
     * One attempt, appended. Takes the tried PASSWORD and hashes it here, so no caller ever has to
     * hold a hash and no caller can accidentally pass the clear text through as `triedHash`.
     *
     * Never throws. A console that could not append its ledger must still answer the sign-in: the
     * ledger is a record of the door, not the door.
     */
    async record({ password = "", at = now(), ...rest } = {}) {
      const row = loginAttemptRow({
        ...rest,
        at,
        // A success gets no hash. See the top of this file.
        triedHash: rest.outcome === "ok" ? "" : hashTried(password, saltOf()),
      });
      try {
        await rotateIfNeeded();
        await appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
        await chmod(file, 0o600).catch(() => {});
        await own(file);
      } catch (error) {
        log(`login ledger could not write ${file}: ${error?.message ?? error}`);
        return null;
      }
      return row;
    },

    /** The previous file first, then the current one, so the rows come back oldest first. */
    async rows() {
      return [...(await readLedgerFile(previous)), ...(await readLedgerFile(file))];
    },

    rotateIfNeeded,
  };
}

/**
 * The filter the relay's own route and the control plane's merge both apply: rows at or after
 * `since` (an ISO string or epoch ms), of one outcome or all of them, newest first, capped.
 */
export function filterAttempts(rows, { since = null, outcome = "", limit = 200 } = {}) {
  const floor = since == null ? 0 : (typeof since === "number" ? since : Date.parse(String(since)));
  const wanted = String(outcome ?? "").trim();
  const kept = [];
  for (const row of rows) {
    if (row == null || typeof row !== "object") continue;
    const at = Date.parse(String(row.at ?? ""));
    if (Number.isFinite(floor) && floor > 0 && (!Number.isFinite(at) || at < floor)) continue;
    if (wanted.length > 0 && String(row.outcome ?? "") !== wanted) continue;
    kept.push(row);
  }
  kept.sort((a, b) => Date.parse(String(b.at ?? "")) - Date.parse(String(a.at ?? "")));
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 5000) : 200;
  return kept.slice(0, cap);
}
