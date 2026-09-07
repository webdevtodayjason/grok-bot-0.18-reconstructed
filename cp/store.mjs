// cp/store.mjs -- the control plane's whole memory: accounts, tenants, revoked sessions, the
// provisioning ledger and the login failure counters.
//
// node:sqlite, because a control plane that knows about a few dozen tenants does not need a
// database server, and a file that can be copied off the R750 with `cp` is a backup an operator
// can actually take. No npm dependency anywhere in this directory.
//
// The file is 0600. It holds the scrypt hashes of every customer's password, so the mode is not
// decoration: the control plane container runs as its own uid and nothing else on the host has any
// business reading it. WAL is on because the API and a CLI run against the same file at the same
// time and the default rollback journal makes those two block each other for no reason.
//
// One rule this file enforces on everybody above it: a password hash never leaves the store. The
// only functions that hand one out are the ones in here, the callers ask "does this password
// verify" rather than "give me the hash", and no route in cp/server.mjs selects the column.

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

// N is 2^15, one notch above the relay's own auth.json (ui/auth.mjs uses 2^14). The relay's file
// is on a host an operator already has to be on; this one holds every customer, so it buys the
// extra doubling. Measured on this Mac: about 40 ms a hash, which is invisible on a sign-in and
// expensive across a stolen database.
//
// maxmem is not optional. scrypt needs 128 * N * r bytes, which at these parameters is 33.5 MB,
// and node's default ceiling is 32 MB, so without this line every hash throws "memory limit
// exceeded" and the first customer can never be created.
export const CP_SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

// Ten failures in ten minutes, counted twice: once for the email and once for the address.
export const LOCKOUT_MAX_FAILURES = 10;
export const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;

const utf8 = (value) => Buffer.from(String(value), "utf8");

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function hashPassword(password, salt = randomBytes(16).toString("hex"), params = CP_SCRYPT_PARAMS) {
  const { N, r, p, keylen, maxmem } = params;
  const hash = scryptSync(utf8(password), utf8(salt), keylen, { N, r, p, maxmem }).toString("hex");
  return { algorithm: "scrypt", N, r, p, keylen, salt, hash };
}

export function verifyPassword(password, record) {
  if (record === null || typeof record !== "object") return false;
  if (record.algorithm !== "scrypt") return false;
  const { N, r, p, keylen, salt, hash } = record;
  if (typeof salt !== "string" || typeof hash !== "string") return false;
  if (![N, r, p, keylen].every((n) => Number.isInteger(n) && n > 0)) return false;
  let derived;
  try { derived = scryptSync(utf8(password), utf8(salt), keylen, { N, r, p, maxmem: CP_SCRYPT_PARAMS.maxmem }).toString("hex"); }
  catch { return false; }
  return safeEqualHex(derived, hash);
}

// A sign-in for an address that does not exist must cost the same as one for an address that does,
// or the response time is a free account enumeration oracle. This is a real record over a fixed
// salt and a password nobody holds, so verifying against it runs the same scrypt the real path
// runs. It is built once at import so the cost lands on the sign-in, not on module load.
let decoyRecord = null;
export function burnPasswordTime(password) {
  if (decoyRecord === null) decoyRecord = hashPassword(randomBytes(32).toString("hex"));
  verifyPassword(password, decoyRecord);
  return false;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  tenant        TEXT NOT NULL,
  password_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tenants (
  slug                  TEXT PRIMARY KEY,
  name                  TEXT NOT NULL DEFAULT '',
  host                  TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'provisioning',
  coolify_service_uuid  TEXT,
  owner_email           TEXT,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions_revoked (
  jti        TEXT PRIMARY KEY,
  exp        INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provisioning_steps (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  slug   TEXT NOT NULL,
  step   TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS provisioning_steps_slug ON provisioning_steps (slug, id);
CREATE TABLE IF NOT EXISTS login_failures (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL DEFAULT '',
  ip    TEXT NOT NULL DEFAULT '',
  at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_at ON login_failures (at);
`;

const accountRow = (row) => (row == null ? null : {
  id: row.id,
  email: row.email,
  name: row.name ?? "",
  tenant: row.tenant,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const tenantRow = (row) => (row == null ? null : {
  slug: row.slug,
  name: row.name ?? "",
  host: row.host ?? "",
  status: row.status,
  coolifyServiceUuid: row.coolify_service_uuid ?? null,
  ownerEmail: row.owner_email ?? null,
  lastError: row.last_error ?? null,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

export function openStore(options = {}) {
  const dataDir = options.dataDir ?? ".";
  const file = options.file ?? path.join(dataDir, "control-plane.sqlite");
  const now = options.now ?? (() => Date.now());
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(file);
  // WAL first, then the schema, so the very first write is already in the mode everything else
  // runs in. An in-memory database refuses WAL, which is fine and is not an error worth throwing.
  if (file !== ":memory:") { try { db.exec("PRAGMA journal_mode = WAL"); } catch { /* memory databases stay in their own mode */ } }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  if (file !== ":memory:") {
    // writeFileSync-style modes only apply on create, and sqlite creates the file itself, so this
    // is the line that makes the mode true after an upgrade of a file that was once 0644. The two
    // WAL sidecars are chmodded too, best effort: they may not exist yet on a fresh database.
    for (const target of [file, `${file}-wal`, `${file}-shm`]) {
      try { chmodSync(target, 0o600); } catch { /* the sidecars appear on the first write */ }
    }
  }

  const statement = (sql) => db.prepare(sql);

  const insertAccount = statement("INSERT INTO accounts (id, email, name, tenant, password_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const selectAccountByEmail = statement("SELECT * FROM accounts WHERE email = ?");
  const selectAccountById = statement("SELECT * FROM accounts WHERE id = ?");
  const selectAccounts = statement("SELECT * FROM accounts ORDER BY created_at, email");
  const updateAccountPassword = statement("UPDATE accounts SET password_json = ?, updated_at = ? WHERE id = ?");
  const countAccountsRow = statement("SELECT COUNT(*) AS n FROM accounts");

  const insertTenant = statement("INSERT INTO tenants (slug, name, host, status, coolify_service_uuid, owner_email, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const selectTenant = statement("SELECT * FROM tenants WHERE slug = ?");
  const selectTenants = statement("SELECT * FROM tenants ORDER BY created_at, slug");
  const deleteTenantRow = statement("DELETE FROM tenants WHERE slug = ?");
  const countTenantsRow = statement("SELECT COUNT(*) AS n FROM tenants");

  const insertRevocation = statement("INSERT OR REPLACE INTO sessions_revoked (jti, exp, revoked_at) VALUES (?, ?, ?)");
  const selectRevocation = statement("SELECT jti FROM sessions_revoked WHERE jti = ?");
  const deleteExpiredRevocations = statement("DELETE FROM sessions_revoked WHERE exp <= ?");

  const insertStep = statement("INSERT INTO provisioning_steps (slug, step, status, detail, at) VALUES (?, ?, ?, ?, ?)");
  const selectSteps = statement("SELECT * FROM provisioning_steps WHERE slug = ? ORDER BY id");
  const deleteSteps = statement("DELETE FROM provisioning_steps WHERE slug = ?");

  const insertFailure = statement("INSERT INTO login_failures (email, ip, at) VALUES (?, ?, ?)");
  const countFailuresByEmail = statement("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_failures WHERE email = ? AND at >= ?");
  const countFailuresByIp = statement("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_failures WHERE ip = ? AND at >= ?");
  const clearFailuresFor = statement("DELETE FROM login_failures WHERE email = ? OR ip = ?");
  const deleteOldFailures = statement("DELETE FROM login_failures WHERE at < ?");

  const store = {
    file,
    db,

    close() { try { db.close(); } catch { /* already closed */ } },

    // ---- accounts ----------------------------------------------------------------------------

    // Throws {code: "duplicate_email"} on a second account for the same address, so the route can
    // answer 409 without parsing a sqlite error string.
    createAccount({ email, password, name = "", tenant, id = randomUUID() }) {
      const address = normalizeEmail(email);
      const at = now();
      const record = hashPassword(password);
      try {
        insertAccount.run(id, address, String(name ?? ""), String(tenant), JSON.stringify(record), at, at);
      } catch (error) {
        if (String(error?.message ?? "").includes("UNIQUE")) {
          const conflict = new Error("that email address already has an account");
          conflict.code = "duplicate_email";
          throw conflict;
        }
        throw error;
      }
      return accountRow(selectAccountById.get(id));
    },

    getAccountByEmail(email) { return accountRow(selectAccountByEmail.get(normalizeEmail(email))); },
    getAccountById(id) { return accountRow(selectAccountById.get(String(id))); },
    listAccounts() { return selectAccounts.all().map(accountRow); },
    countAccounts() { return Number(countAccountsRow.get()?.n ?? 0); },

    // The one place a hash is read, and it is read into a comparison and dropped. Nothing returns
    // it to a caller.
    verifyAccountPassword(email, password) {
      const row = selectAccountByEmail.get(normalizeEmail(email));
      if (row == null) return { ok: false, account: null };
      let record;
      try { record = JSON.parse(row.password_json); } catch { return { ok: false, account: null }; }
      if (!verifyPassword(password, record)) return { ok: false, account: null };
      return { ok: true, account: accountRow(row) };
    },

    setAccountPassword(id, password) {
      const account = selectAccountById.get(String(id));
      if (account == null) return null;
      updateAccountPassword.run(JSON.stringify(hashPassword(password)), now(), String(id));
      return accountRow(selectAccountById.get(String(id)));
    },

    // ---- tenants -----------------------------------------------------------------------------

    createTenant({ slug, name = "", host = "", status = "provisioning", ownerEmail = null, coolifyServiceUuid = null }) {
      const at = now();
      try {
        insertTenant.run(String(slug), String(name ?? ""), String(host ?? ""), String(status), coolifyServiceUuid, ownerEmail, null, at, at);
      } catch (error) {
        if (String(error?.message ?? "").includes("UNIQUE") || String(error?.message ?? "").includes("PRIMARY KEY")) {
          const conflict = new Error("that tenant already exists");
          conflict.code = "duplicate_slug";
          throw conflict;
        }
        throw error;
      }
      return tenantRow(selectTenant.get(String(slug)));
    },

    getTenant(slug) { return tenantRow(selectTenant.get(String(slug))); },
    listTenants() { return selectTenants.all().map(tenantRow); },
    countTenants() { return Number(countTenantsRow.get()?.n ?? 0); },

    // A patch of the columns a caller names. lastError is written as null rather than skipped when
    // it is explicitly passed as null, which is how a successful retry clears the last failure.
    updateTenant(slug, patch = {}) {
      const current = selectTenant.get(String(slug));
      if (current == null) return null;
      const columns = {
        name: "name", host: "host", status: "status",
        coolifyServiceUuid: "coolify_service_uuid", ownerEmail: "owner_email", lastError: "last_error",
      };
      const sets = [];
      const values = [];
      for (const [key, column] of Object.entries(columns)) {
        if (!Object.hasOwn(patch, key)) continue;
        sets.push(`${column} = ?`);
        values.push(patch[key] === null || patch[key] === undefined ? null : String(patch[key]));
      }
      sets.push("updated_at = ?");
      values.push(now());
      values.push(String(slug));
      db.prepare(`UPDATE tenants SET ${sets.join(", ")} WHERE slug = ?`).run(...values);
      return tenantRow(selectTenant.get(String(slug)));
    },

    deleteTenant(slug) {
      const row = tenantRow(selectTenant.get(String(slug)));
      deleteTenantRow.run(String(slug));
      deleteSteps.run(String(slug));
      return row;
    },

    // ---- revoked sessions --------------------------------------------------------------------

    revokeSession(jti, exp) { insertRevocation.run(String(jti), Number(exp), now()); },
    isSessionRevoked(jti) { return selectRevocation.get(String(jti)) != null; },
    // A revoked token that has expired is refused by the expiry check anyway, so the row is dead
    // weight. Pruned on every sign-in so the table cannot grow without bound.
    pruneRevocations(at = now()) { deleteExpiredRevocations.run(Number(at)); },

    // ---- the provisioning ledger ---------------------------------------------------------------

    recordStep({ slug, step, status, detail = "" }) {
      insertStep.run(String(slug), String(step), String(status), typeof detail === "string" ? detail : JSON.stringify(detail), now());
    },
    listSteps(slug) {
      return selectSteps.all(String(slug)).map((row) => ({
        id: Number(row.id), slug: row.slug, step: row.step, status: row.status, detail: row.detail ?? "", at: Number(row.at),
      }));
    },
    // Which steps are already done, so a retry starts at the one that failed rather than at the
    // top. A step that later failed is not complete even if an earlier attempt said ok.
    completedSteps(slug) {
      const state = new Map();
      for (const row of selectSteps.all(String(slug))) state.set(row.step, row.status);
      return new Set([...state.entries()].filter(([, status]) => status === "ok").map(([step]) => step));
    },

    // ---- login failures ------------------------------------------------------------------------

    recordLoginFailure({ email = "", ip = "", at = now() }) {
      insertFailure.run(normalizeEmail(email), String(ip ?? ""), Number(at));
    },
    clearLoginFailures({ email = "", ip = "" }) { clearFailuresFor.run(normalizeEmail(email), String(ip ?? "")); },
    pruneLoginFailures(at = now()) { deleteOldFailures.run(Number(at) - LOCKOUT_WINDOW_MS); },

    // Answers {locked, retryAfter}. Two buckets, either one of which locks: the email stops a
    // spray against one customer from anywhere, the address stops one machine working through a
    // list of addresses. retryAfter is when the oldest failure in the offending bucket ages out,
    // which is the earliest moment a further try can succeed.
    loginLock({ email = "", ip = "", at = now() }) {
      const since = Number(at) - LOCKOUT_WINDOW_MS;
      const buckets = [
        countFailuresByEmail.get(normalizeEmail(email), since),
        countFailuresByIp.get(String(ip ?? ""), since),
      ];
      let retryAfter = 0;
      for (const bucket of buckets) {
        if (Number(bucket?.n ?? 0) < LOCKOUT_MAX_FAILURES) continue;
        const oldest = Number(bucket.oldest);
        retryAfter = Math.max(retryAfter, Math.ceil((oldest + LOCKOUT_WINDOW_MS - Number(at)) / 1000));
      }
      if (retryAfter <= 0) return { locked: false, retryAfter: 0 };
      return { locked: true, retryAfter };
    },
  };

  return store;
}
