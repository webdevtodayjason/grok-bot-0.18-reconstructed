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
import { randomBytes, randomInt, randomUUID, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

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

// The same derivation on the libuv threadpool instead of on the event loop.
//
// This matters more than it looks. scryptSync at these parameters holds the ONLY thread this
// service has for about 40 ms, and the sign-in route is the one route a stranger can reach without
// a bearer. Measured before this change: forty sign-in attempts in flight from one client took the
// health route from 1.6 ms to 88 ms, a 54x slowdown, and every customer's sign-in went with it. The
// async form hands the work to the threadpool, so the process keeps answering while it runs.
// cp/server.mjs caps how many can be in flight at once, because the threadpool is small and an
// uncapped queue is the same denial of service one step further along.
function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
}

export async function hashPasswordAsync(password, salt = randomBytes(16).toString("hex"), params = CP_SCRYPT_PARAMS) {
  const { N, r, p, keylen, maxmem } = params;
  const hash = (await scryptAsync(utf8(password), utf8(salt), keylen, { N, r, p, maxmem })).toString("hex");
  return { algorithm: "scrypt", N, r, p, keylen, salt, hash };
}

export async function verifyPasswordAsync(password, record) {
  if (record === null || typeof record !== "object") return false;
  if (record.algorithm !== "scrypt") return false;
  const { N, r, p, keylen, salt, hash } = record;
  if (typeof salt !== "string" || typeof hash !== "string") return false;
  if (![N, r, p, keylen].every((n) => Number.isInteger(n) && n > 0)) return false;
  let derived;
  try { derived = (await scryptAsync(utf8(password), utf8(salt), keylen, { N, r, p, maxmem: CP_SCRYPT_PARAMS.maxmem })).toString("hex"); }
  catch { return false; }
  return safeEqualHex(derived, hash);
}

// A sign-in for an address that does not exist must cost the same as one for an address that does,
// or the response time is a free account enumeration oracle. This is a real record over a fixed
// salt and a password nobody holds, so verifying against it runs the same scrypt the real path
// runs. It is built once, on the first sign-in, and reused after that.
let decoyRecord = null;
let decoyBuild = null;
export async function burnPasswordTime(password) {
  if (decoyRecord === null) {
    if (decoyBuild === null) decoyBuild = hashPasswordAsync(randomBytes(32).toString("hex"));
    decoyRecord = await decoyBuild;
  }
  await verifyPasswordAsync(password, decoyRecord);
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
  -- TENANT-5. The container the relay talks to for this customer, and whether it has ever
  -- answered. Coolify names a service's containers "<compose service>-<resource uuid>", so the
  -- name is knowable the moment the service exists, but it is WRITTEN DOWN rather than rebuilt at
  -- read time: a re-provision mints a new uuid, and a relay resolving a box by rebuilding a name
  -- from a stale row would land on a container that is not this customer's. box_ready is set when
  -- provisioning saw the box answer, so a console can say "still starting" instead of "broken".
  box_container         TEXT,
  box_ready             INTEGER NOT NULL DEFAULT 0,
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
-- ADMIN-1. Every sign-in this service decided, refused or allowed, and what was tried.
--
-- login_failures above is the LOCKOUT's memory: it is counted, it is cleared on a success, and it
-- is pruned to a ten minute window, so by design it cannot answer "who has been knocking today".
-- This table is the RECORD, and it is kept separately for exactly that reason: nothing clears it on
-- a successful sign-in and nothing prunes it inside the retention window.
--
-- tried_hash is HMAC-SHA256(this service's own salt, the password). Never the password. See
-- adminSalt in cp/admin.mjs for the decision; the short version is that the panel has to be able to
-- say "the same password forty times" (a stale saved password) versus "forty different passwords"
-- (an attack), and that is the least it can hold and still tell them apart.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  email      TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  outcome    TEXT NOT NULL DEFAULT 'refused',
  tried_hash TEXT NOT NULL DEFAULT '',
  tenant     TEXT NOT NULL DEFAULT '',
  -- "relay" when a tenant console forwarded this sign-in, which makes the ip column that machine's
  -- egress address rather than the visitor's. Empty is a client posting straight at this service.
  via        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS login_attempts_at ON login_attempts (at);
-- A workspace name that has been removed while sign-ins still pointed at it.
--
-- Deleting a tenant deliberately leaves its accounts alone: the operator may be rebuilding, and
-- cascading would lock those people out to tidy a row. But sign-up derives a name from the company
-- and checked only the tenants that exist RIGHT NOW, so a name freed that way could be handed to a
-- DIFFERENT company, and the previous customer's sign-ins would then resolve to the new customer's
-- box with full access to it. This table is what keeps a name out of circulation while somebody
-- can still sign in with it. Creating a tenant under the name again clears it, which is the
-- operator rebuilding on purpose, and removing the last account pointing at it clears it too.
CREATE TABLE IF NOT EXISTS retired_slugs (
  slug       TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL,
  accounts   INTEGER NOT NULL DEFAULT 0
);
-- PROVIDERS-1. What a super admin CHANGED, as opposed to who tried to sign in.
--
-- There was no such record before this wave. Seven tables and not one of them could answer "who
-- changed the plan model, and when". login_attempts is the wrong home for it and deliberately so:
-- its columns are fixed around a sign-in (a validated hash, a coerced via), and it is pruned to
-- thirty days. "Who repointed plan-zai in March" is a question asked in June, so this table is
-- NEVER PRUNED. Nothing in this file deletes from it and nothing should be added that does. It is
-- a few hundred bytes a change on a system where changes are rare, and it is the only record that
-- a provider key was rolled at all.
--
-- The row is written BEFORE the proxy call it describes and finished after, so a change that half
-- succeeded is still on the record with outcome 'started'. See recordAdminAction / finishAdminAction.
--
-- NO KEY VALUE EVER REACHES THE detail COLUMN. Callers put a name, a length and a sha256 prefix there and
-- nothing else, and tests/cp-store asserts a planted value does not appear.
CREATE TABLE IF NOT EXISTS admin_actions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL DEFAULT '',
  via     TEXT NOT NULL DEFAULT '',
  ip      TEXT NOT NULL DEFAULT '',
  action  TEXT NOT NULL DEFAULT '',
  target  TEXT NOT NULL DEFAULT '',
  detail  TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'started'
);
CREATE INDEX IF NOT EXISTS admin_actions_at ON admin_actions (at);
-- The handful of settings the console owns that are not a tenant's and not an account's. One row
-- today: the plan model a NEW workspace gets. A table rather than a column on something else,
-- because the next one (a default allowance, a default label) has no other home either.
CREATE TABLE IF NOT EXISTS admin_settings (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  at    INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT ''
);
-- MAIL-2. Every bot's own email address, which is the one thing about mail this service owns.
--
-- The address is agent<code>@<domain> and NOTHING ELSE. It never carries a name: a name is not
-- unique across workspaces (two customers each have a Titan), it is guessable, and the old
-- name-based rule is what made mail for an unknown localpart land in whichever workspace happened
-- to claim the domain.
--
-- code is the PRIMARY KEY, so a code is unique across the whole fleet in the only way that matters
-- to a router: one localpart, one bot, one workspace. UNIQUE(tenant, agent_id) is the other half --
-- one bot has one address, and a sweep that runs every five minutes cannot mint a second one.
--
-- NOTHING IN THIS FILE DELETES A ROW. Retiring sets state and retired_at and leaves the row where
-- it is, because the row IS the reservation: a deleted code could be minted again for a different
-- bot in a different workspace, and mail still addressed to the old one would then be delivered to
-- a stranger. A retired code is a dead address forever, which is the only safe meaning of retired.
CREATE TABLE IF NOT EXISTS mail_addresses (
  code       TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  state      TEXT NOT NULL DEFAULT 'active'
);
-- One ACTIVE address per bot, and the WHERE is the whole reason this is an index rather than a
-- constraint on the table. A plain UNIQUE(tenant, agent_id) would mean that retiring an address
-- leaves that bot unable to ever have another one: the sweep would find the retired row, hand it
-- back, and the bot would be unreachable for good. An operator who retires an address is killing
-- the ADDRESS, usually because it is being spammed, and not the bot. So the dead row stays (its
-- code is the PRIMARY KEY, so that number can never be minted for anybody again) and the next
-- sweep gives the bot a fresh one, within five minutes.
CREATE UNIQUE INDEX IF NOT EXISTS mail_addresses_active ON mail_addresses (tenant, agent_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS mail_addresses_tenant ON mail_addresses (tenant, agent_id);
-- Approved senders, per workspace. The switch that turns them into a whitelist is one row in
-- admin_settings (mail.approvedSenders.<slug>) and it is OFF for every workspace this wave: an
-- on-by-default whitelist is exactly what would eat the first verification mail a new customer
-- asks for. This table is the allow list the switch reads when somebody turns it on.
CREATE TABLE IF NOT EXISTS mail_senders (
  tenant TEXT NOT NULL,
  sender TEXT NOT NULL,
  at     TEXT NOT NULL,
  PRIMARY KEY (tenant, sender)
);
-- One row per message a bot sends through the relay's send route, so a per-customer send count
-- exists at all. It holds addresses and an outcome and never a subject or a body -- and that is
-- still true of resend_id (the provider's id for the message) and detail (why an outcome is what
-- it is, never any of the mail). The readable row with the subject on it belongs to the workspace,
-- in its own mail-sent.jsonl on its own volume, read by its own console.
--
-- outcome is "sending" from the moment the row is claimed, then "sent", "failed" or "no_key".
-- The claim comes BEFORE the mail goes: an unsent mail is recoverable and an unlogged send is not,
-- so a crash in between leaves a row reading "sending", which counts toward the cap and reads as
-- "we do not know", which is the safe direction.
--
-- MAIL-3 ADDED resend_id AND detail TO A TABLE THAT ALREADY EXISTED, so they are written in TWO
-- places and both are needed: here, for a database made fresh, and in TENANT_MIGRATIONS, for every
-- database that already has this table. CREATE TABLE IF NOT EXISTS does nothing whatever to a
-- table that is already there, and on the R750 this one was live with seven columns and no
-- resend_id. Editing only this DDL would have shipped a claim that fails in a way reading like
-- Resend refusing.
CREATE TABLE IF NOT EXISTS mail_send_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant    TEXT NOT NULL,
  agent_id  TEXT NOT NULL DEFAULT '',
  code      TEXT NOT NULL DEFAULT '',
  to_addr   TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL,
  outcome   TEXT NOT NULL DEFAULT '',
  resend_id TEXT NOT NULL DEFAULT '',
  detail    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS mail_send_log_tenant ON mail_send_log (tenant, id);
-- The per-bot hourly cap counts on (tenant, agent_id, at), which is a different shape from the
-- list above. An index needs no migration entry of its own: CREATE INDEX IF NOT EXISTS runs on
-- every open and makes one on an existing table, which is exactly what a new COLUMN cannot do.
CREATE INDEX IF NOT EXISTS mail_send_log_agent ON mail_send_log (tenant, agent_id, at);
-- FEEDBACK-1. What an agent reported, after the workspace operator sent it and before the super
-- admin decides what to do with it.
--
-- No TENANT_MIGRATIONS entry, for the reason written over admin_actions: db.exec(SCHEMA) runs on
-- every open and CREATE TABLE IF NOT EXISTS makes a table that is not there. Only a new COLUMN on a
-- table that already exists needs an ALTER.
--
-- Two gates decide what is in here and neither is a check in this file. The report was written by
-- an agent into its own box, SHOWN TO THE WORKSPACE OPERATOR, who could edit it or drop it, and
-- posted by that operator's own console. The tenant column is stamped by the relay out of its own
-- registry and never read from the body, so a box cannot file as its neighbour. What the super
-- admin then does with it is the state column, which moves new to approved to filed, or new to
-- suppressed, or to closed.
--
-- NEVER PRUNED, the same as admin_actions and for the same reason: "did we ever hear about this
-- before" is a question asked months later, and the rows are a few kilobytes each on a system where
-- a report is a rare event.
CREATE TABLE IF NOT EXISTS feedback (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  tenant    TEXT NOT NULL DEFAULT '',
  agent     TEXT NOT NULL DEFAULT '',
  agentName TEXT NOT NULL DEFAULT '',
  tier      TEXT NOT NULL DEFAULT 'observation',
  category  TEXT NOT NULL DEFAULT '',
  title     TEXT NOT NULL DEFAULT '',
  body      TEXT NOT NULL DEFAULT '',
  payload   TEXT NOT NULL DEFAULT '',
  state     TEXT NOT NULL DEFAULT 'new',
  issueUrl  TEXT NOT NULL DEFAULT '',
  decidedAt INTEGER NOT NULL DEFAULT 0,
  decidedBy TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS feedback_at ON feedback (at);
CREATE INDEX IF NOT EXISTS feedback_state ON feedback (state);
`;

/**
 * The five states a report can be in, and there is no sixth.
 *
 * `new` it arrived. `approved` a super admin read it and it is worth filing. `filed` it is a GitHub
 * issue and issueUrl says which. `suppressed` it is noise and is kept rather than deleted, because
 * "we decided this was not a bug" is itself a record. `closed` it is dealt with.
 */
export const FEEDBACK_STATES = ["new", "approved", "filed", "suppressed", "closed"];

/**
 * 256 KB each for the rendered body and the payload it was rendered from.
 *
 * The intake refuses a request body over 64 KB long before this, so nothing a console posts can
 * reach this limit. It is here because the store is the last thing between a caller and the disk,
 * and a table that is never pruned must not be a place one caller can fill.
 */
export const FEEDBACK_FIELD_LIMIT = 256 * 1024;

/**
 * The setting names whose VALUE never comes back out of listSettings.
 *
 * admin_settings held nothing secret until FEEDBACK-1: a plan model alias, a quota, a provider
 * list. It now holds the super admin's GitHub token, and listSettings hands every value back
 * wholesale, so the two facts together would put that token in any answer that ever renders the
 * settings. getSetting still returns it, for the one caller that files an issue.
 */
export const SECRET_SETTINGS = new Set(["github.token"]);

const accountRow = (row) => (row == null ? null : {
  id: row.id,
  email: row.email,
  name: row.name ?? "",
  tenant: row.tenant,
  // ADMIN-1. Whether this account may open the super admin console. It is read from the store on
  // every admin request and it is NOT in the session token: a claim in a token is a fact from
  // whenever the token was minted, and "this person was demoted" has to take effect now rather than
  // in up to twelve hours.
  superAdmin: Number(row.super_admin ?? 0) === 1,
  // A door that has been closed without the account being deleted. Deleting is the right shape for
  // "this person has left"; this is the right shape for "not right now", and it is reversible.
  disabled: Number(row.disabled ?? 0) === 1,
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
  boxContainer: row.box_container ?? null,
  boxReady: Number(row.box_ready ?? 0) === 1,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

// MAIL-2. One directory row, as everything outside this file reads it.
const mailRow = (row) => (row == null ? null : {
  code: row.code,
  tenant: row.tenant,
  agentId: row.agent_id,
  agentName: row.agent_name ?? "",
  address: row.address,
  createdAt: row.created_at,
  retiredAt: row.retired_at ?? null,
  state: row.state ?? "active",
});
// FEEDBACK-1. The payload is stored as text and handed back parsed, because every caller wants the
// object and none of them wants to remember that the column is a string. A payload that will not
// parse comes back null rather than throwing: a row whose evidence is unreadable is still a report
// with a title, a workspace and a time, and losing the whole panel over one bad row is worse.
const feedbackRow = (row) => {
  if (row == null) return null;
  let payload = null;
  try { payload = JSON.parse(String(row.payload ?? "")); } catch { payload = null; }
  return {
    id: Number(row.id),
    at: Number(row.at),
    tenant: row.tenant ?? "",
    agent: row.agent ?? "",
    agentName: row.agentName ?? "",
    tier: row.tier ?? "",
    category: row.category ?? "",
    title: row.title ?? "",
    body: row.body ?? "",
    payload,
    state: row.state ?? "new",
    issueUrl: row.issueUrl ?? "",
    decidedAt: Number(row.decidedAt ?? 0),
    decidedBy: row.decidedBy ?? "",
  };
};

// The columns added after the first release, applied to a database that already exists.
//
// CREATE TABLE IF NOT EXISTS does nothing at all to a table that is already there, so a schema
// change lands on a fresh install and nowhere else, and the symptom on the R750 would be every
// tenant answering with no box. Each one is tried on its own and a duplicate-column error is the
// expected answer on the second boot, not a failure worth stopping for.
const TENANT_MIGRATIONS = [
  "ALTER TABLE tenants ADD COLUMN box_container TEXT",
  "ALTER TABLE tenants ADD COLUMN box_ready INTEGER NOT NULL DEFAULT 0",
  // ADMIN-1. Both default to 0, which is the only safe default for either: an upgrade of the R750's
  // existing database gives nobody the super admin console and locks nobody out of their workspace.
  // Jason's own flag is set afterwards by hand, with `account promote`, on an account he creates.
  "ALTER TABLE accounts ADD COLUMN super_admin INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
  // Whether this row's address is a person's or a relay's. "relay" means the sign-in arrived here
  // forwarded by a tenant console, so `ip` is that machine's egress address and not the visitor's;
  // the relay wrote its own richer row for the same attempt at its own door. Empty is the ordinary
  // case, a client posting straight at this service. See recordLoginAttempt.
  "ALTER TABLE login_attempts ADD COLUMN via TEXT NOT NULL DEFAULT ''",
  // MAIL-3. The provider's id for a message and the reason an outcome is what it is. The same two
  // columns are on the CREATE TABLE in SCHEMA and BOTH places are needed: the DDL makes them on a
  // database that has no mail_send_log, and these make them on the R750's, which has held that
  // table with seven columns since MAIL-2. Neither ever holds a subject or a body.
  "ALTER TABLE mail_send_log ADD COLUMN resend_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE mail_send_log ADD COLUMN detail TEXT NOT NULL DEFAULT ''",
];

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
  for (const migration of TENANT_MIGRATIONS) {
    try { db.exec(migration); }
    catch (error) {
      // "duplicate column name" is this migration having already run, which is every boot after
      // the first. Anything else is a real problem and is worth the throw.
      if (!/duplicate column name/i.test(String(error?.message ?? ""))) throw error;
    }
  }
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
  const selectAccountsByTenant = statement("SELECT * FROM accounts WHERE tenant = ? ORDER BY created_at, email");
  const deleteAccountRow = statement("DELETE FROM accounts WHERE id = ?");
  const updateAccountPassword = statement("UPDATE accounts SET password_json = ?, updated_at = ? WHERE id = ?");
  const countAccountsRow = statement("SELECT COUNT(*) AS n FROM accounts");

  const insertTenant = statement("INSERT INTO tenants (slug, name, host, status, coolify_service_uuid, owner_email, last_error, box_container, box_ready, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)");
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

  const insertRetired = statement("INSERT OR REPLACE INTO retired_slugs (slug, retired_at, accounts) VALUES (?, ?, ?)");
  const selectRetired = statement("SELECT slug FROM retired_slugs WHERE slug = ?");
  const selectRetiredAll = statement("SELECT * FROM retired_slugs ORDER BY retired_at, slug");
  const deleteRetired = statement("DELETE FROM retired_slugs WHERE slug = ?");

  const updateSuperAdmin = statement("UPDATE accounts SET super_admin = ?, updated_at = ? WHERE id = ?");
  const updateDisabled = statement("UPDATE accounts SET disabled = ?, updated_at = ? WHERE id = ?");
  const countSuperAdminsRow = statement("SELECT COUNT(*) AS n FROM accounts WHERE super_admin = 1");

  const insertAttempt = statement("INSERT INTO login_attempts (at, email, ip, outcome, tried_hash, tenant, via) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const selectAttempts = statement("SELECT * FROM login_attempts WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?");
  const selectAttemptsByOutcome = statement("SELECT * FROM login_attempts WHERE at >= ? AND outcome = ? ORDER BY at DESC, id DESC LIMIT ?");
  const deleteOldAttempts = statement("DELETE FROM login_attempts WHERE at < ?");
  const countAttemptsRow = statement("SELECT COUNT(*) AS n FROM login_attempts WHERE at >= ?");

  // PROVIDERS-1. The change record and the console's own settings.
  //
  // No TENANT_MIGRATIONS entry for either, and that is not an omission: db.exec(SCHEMA) runs on
  // every open and CREATE TABLE IF NOT EXISTS makes a table that is not there. A new TABLE needs no
  // ALTER; only a new COLUMN on an existing table does, which is what that list is for.
  const insertAction = statement("INSERT INTO admin_actions (at, actor, via, ip, action, target, detail, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  // The finish APPENDS rather than replaces. What was attempted and what happened are two different
  // facts and a row that kept only the second one could not answer "what was this trying to do".
  const finishActionRow = statement("UPDATE admin_actions SET outcome = ?, detail = CASE WHEN ? = '' THEN detail WHEN detail = '' THEN ? ELSE detail || '; ' || ? END WHERE id = ?");
  const selectActions = statement("SELECT * FROM admin_actions WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?");
  const countActionsRow = statement("SELECT COUNT(*) AS n FROM admin_actions");
  const selectSetting = statement("SELECT * FROM admin_settings WHERE name = ?");
  const upsertSetting = statement("INSERT INTO admin_settings (name, value, at, actor) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, at = excluded.at, actor = excluded.actor");
  const selectSettings = statement("SELECT * FROM admin_settings ORDER BY name");

  // MAIL-2. The per-bot address directory. No TENANT_MIGRATIONS entry, for the reason written
  // beside the admin statements above: these are whole new TABLES, and db.exec(SCHEMA) runs on
  // every open, so CREATE TABLE IF NOT EXISTS makes them on an existing database too.
  const insertMailAddress = statement("INSERT INTO mail_addresses (code, tenant, agent_id, agent_name, address, created_at, state) VALUES (?, ?, ?, ?, ?, ?, 'active')");
  const selectMailByCode = statement("SELECT * FROM mail_addresses WHERE code = ?");
  const selectMailByAgent = statement("SELECT * FROM mail_addresses WHERE tenant = ? AND agent_id = ? AND state = 'active'");
  const selectMailByTenant = statement("SELECT * FROM mail_addresses WHERE tenant = ? ORDER BY created_at, code");
  const selectMailAll = statement("SELECT * FROM mail_addresses ORDER BY tenant, created_at, code");
  const updateMailName = statement("UPDATE mail_addresses SET agent_name = ? WHERE code = ?");
  const retireMailRow = statement("UPDATE mail_addresses SET state = 'retired', retired_at = ? WHERE code = ?");
  const countMailByTenant = statement("SELECT COUNT(*) AS n FROM mail_addresses WHERE tenant = ? AND state = 'active'");
  const insertMailSender = statement("INSERT OR IGNORE INTO mail_senders (tenant, sender, at) VALUES (?, ?, ?)");
  const selectMailSenders = statement("SELECT * FROM mail_senders WHERE tenant = ? ORDER BY sender");
  const deleteMailSender = statement("DELETE FROM mail_senders WHERE tenant = ? AND sender = ?");
  const insertMailSend = statement("INSERT INTO mail_send_log (tenant, agent_id, code, to_addr, at, outcome) VALUES (?, ?, ?, ?, ?, ?)");
  const countMailSendRows = statement("SELECT COUNT(*) AS n FROM mail_send_log WHERE tenant = ? AND at >= ?");
  // MAIL-3. The claim, the settle, the operator's list, and the two counts the caps read.
  //
  // BOTH COUNTS TAKE `sending` AND `sent` AND NOTHING ELSE. A row still reading `sending` is a
  // message we do not know the fate of, and not counting it is what would let a bug that crashes
  // between the claim and Resend send without limit. A `failed` row gave its place back on purpose:
  // we know that one did not go.
  const claimMailSendRow = statement("INSERT INTO mail_send_log (tenant, agent_id, code, to_addr, at, outcome, resend_id, detail) VALUES (?, ?, ?, ?, ?, 'sending', '', '')");
  const settleMailSendRow = statement("UPDATE mail_send_log SET outcome = ?, resend_id = ?, detail = ? WHERE id = ?");
  const selectMailSends = statement("SELECT * FROM mail_send_log WHERE tenant = ? ORDER BY id DESC LIMIT ?");
  const countAgentSendRows = statement("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM mail_send_log WHERE tenant = ? AND agent_id = ? AND at >= ? AND outcome IN ('sending', 'sent')");
  const countTenantSendRows = statement("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM mail_send_log WHERE tenant = ? AND at >= ? AND outcome IN ('sending', 'sent')");
  const sendWindow = (row) => ({ count: Number(row?.n ?? 0), oldest: String(row?.oldest ?? "") });
  const mailSendRow = (record) => (record == null ? null : {
    id: Number(record.id),
    tenant: String(record.tenant ?? ""),
    agentId: String(record.agent_id ?? ""),
    code: String(record.code ?? ""),
    to: String(record.to_addr ?? ""),
    at: String(record.at ?? ""),
    outcome: String(record.outcome ?? ""),
    resendId: String(record.resend_id ?? ""),
    detail: String(record.detail ?? ""),
  });
  // FEEDBACK-1. The filters are built rather than prepared, because tier, state and tenant are each
  // optional and a prepared statement per combination is eight statements for one list. The values
  // are still bound and never interpolated: the only thing built is which `AND` clauses are in the
  // string, and each clause's placeholder is filled from the argument list below.
  const insertFeedback = statement("INSERT INTO feedback (at, tenant, agent, agentName, tier, category, title, body, payload, state, issueUrl, decidedAt, decidedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, '')");
  const selectFeedbackRow = statement("SELECT * FROM feedback WHERE id = ?");
  const countFeedbackRow = statement("SELECT COUNT(*) AS n FROM feedback");
  const tableNamesRow = statement("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");

  const insertFailure = statement("INSERT INTO login_failures (email, ip, at) VALUES (?, ?, ?)");
  const countFailuresByEmail = statement("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_failures WHERE email = ? AND at >= ?");
  const countFailuresByIp = statement("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_failures WHERE ip = ? AND at >= ?");
  // AND, not OR, and the difference is the whole lockout.
  //
  // With OR, a successful sign-in deleted every failure row for that address whoever it belonged
  // to. So anyone with one working account of their own could guess a stranger's password without
  // limit: spread the guesses one per address so no address bucket reaches ten, then sign in to
  // their own account once from each of those addresses and the victim's rows are gone with them.
  // Measured before this change: 60 guesses out of 60 reached the password check, against 10 of 60
  // with no clearing sign-ins.
  //
  // With AND only the rows that are this person, at this address, are cleared, which is exactly the
  // case the clear exists for: somebody who mistyped their own password and then got it right.
  const clearFailuresFor = statement("DELETE FROM login_failures WHERE email = ? AND ip = ?");
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
    listAccountsForTenant(slug) { return selectAccountsByTenant.all(String(slug)).map(accountRow); },
    countAccounts() { return Number(countAccountsRow.get()?.n ?? 0); },

    // Removing a person's sign-in. It does NOT touch the tenant or anything in the tenant's data
    // directory: an account is a door, and this closes one door. The rows it leaves behind on
    // purpose are the login-failure rows, which are the lockout's memory and belong to the address
    // rather than to the account; deleting them would hand a guesser a reset button.
    //
    // Sessions already minted stay valid until they expire, because a session is a signed token
    // this service does not hold. revokeSession is the lever for one of those, and it needs the
    // token's jti, which only its holder has. So this is the right shape for "this person has
    // left" and not for "this person is hostile"; that one is a password change, then the token
    // TTL, which is twelve hours.
    deleteAccount(id) {
      const row = accountRow(selectAccountById.get(String(id)));
      if (row == null) return null;
      deleteAccountRow.run(String(id));
      // The last door into a removed workspace just closed, so its name goes back into circulation.
      // Held any longer it would be a name no future customer could have, for nobody's benefit.
      if (selectTenant.get(String(row.tenant)) == null
        && selectAccountsByTenant.all(String(row.tenant)).length === 0) {
        deleteRetired.run(String(row.tenant));
      }
      return row;
    },

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

    // The same answer, with the derivation on the threadpool. This is what the sign-in route uses,
    // because that route is open to strangers and the sync form would stop the whole service for
    // 40 ms per attempt. The sync one above stays for the operator routes, which are behind
    // CP_ADMIN_TOKEN and are not a lever anybody else can pull.
    async verifyAccountPasswordAsync(email, password) {
      const row = selectAccountByEmail.get(normalizeEmail(email));
      if (row == null) return { ok: false, account: null };
      let record;
      try { record = JSON.parse(row.password_json); } catch { return { ok: false, account: null }; }
      if (!(await verifyPasswordAsync(password, record))) return { ok: false, account: null };
      return { ok: true, account: accountRow(row) };
    },

    setAccountPassword(id, password) {
      const account = selectAccountById.get(String(id));
      if (account == null) return null;
      updateAccountPassword.run(JSON.stringify(hashPassword(password)), now(), String(id));
      return accountRow(selectAccountById.get(String(id)));
    },

    // ---- super admin, and a door that is shut rather than removed (ADMIN-1) ---------------------

    // Promote or demote. Takes an id or an email, because the operator types an email and the
    // console holds an id, and making both callers convert first is how one of them gets it wrong.
    setSuperAdmin(idOrEmail, flag) {
      const row = selectAccountById.get(String(idOrEmail)) ?? selectAccountByEmail.get(normalizeEmail(idOrEmail));
      if (row == null) return null;
      updateSuperAdmin.run(flag ? 1 : 0, now(), row.id);
      return accountRow(selectAccountById.get(row.id));
    },

    setAccountDisabled(idOrEmail, flag) {
      const row = selectAccountById.get(String(idOrEmail)) ?? selectAccountByEmail.get(normalizeEmail(idOrEmail));
      if (row == null) return null;
      updateDisabled.run(flag ? 1 : 0, now(), row.id);
      return accountRow(selectAccountById.get(row.id));
    },

    // How many super admins there are. The demote route reads it before it does anything: taking the
    // last one away leaves a console nobody can open, and the only way back in is the CLI with
    // CP_ADMIN_TOKEN. That is a recoverable mistake and it should still be refused, out loud.
    countSuperAdmins() { return Number(countSuperAdminsRow.get()?.n ?? 0); },

    // ---- the sign-in record (ADMIN-1) ------------------------------------------------------------
    //
    // Separate from login_failures on purpose. That one is the lockout's counter, cleared on a
    // success and pruned to ten minutes; this one is the record the panel reads, and nothing clears
    // it early.
    //
    // `via` is "relay" when a tenant console forwarded the sign-in. It matters because the address
    // on such a row is the forwarding machine's, not the visitor's: every console on this server
    // reaches this service from one egress address, so without the flag the whole fleet's console
    // sign-ins pile into one bucket that belongs to nobody. The relay wrote its own row for the same
    // attempt, with the real address on it, and the merge drops this one in favour of that.
    recordLoginAttempt({ at = now(), email = "", ip = "", outcome = "refused", triedHash = "", tenant = "", via = "" }) {
      insertAttempt.run(
        Number(at), normalizeEmail(email), String(ip ?? ""), String(outcome),
        // Only ever a hex digest. A caller that passed a password here by mistake would be writing
        // a password into the database, so the shape is checked rather than trusted.
        /^[0-9a-f]{64}$/i.test(String(triedHash ?? "")) ? String(triedHash) : "",
        String(tenant ?? ""),
        String(via ?? "") === "relay" ? "relay" : "",
      );
    },

    listLoginAttempts({ since = 0, outcome = "", limit = 500 } = {}) {
      const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 5000) : 500;
      const rows = String(outcome ?? "").length > 0
        ? selectAttemptsByOutcome.all(Number(since) || 0, String(outcome), cap)
        : selectAttempts.all(Number(since) || 0, cap);
      return rows.map((row) => ({
        at: new Date(Number(row.at)).toISOString(),
        door: "account",
        email: row.email ?? "",
        ip: row.ip ?? "",
        userAgent: "",
        triedHash: row.tried_hash ?? "",
        outcome: row.outcome ?? "refused",
        tenant: row.tenant ?? "",
        via: row.via ?? "",
      }));
    },

    countLoginAttempts(since = 0) { return Number(countAttemptsRow.get(Number(since) || 0)?.n ?? 0); },

    // Thirty days by default. Long enough that "has this been going on for weeks" is answerable and
    // short enough that the table does not become a permanent record of everybody who ever mistyped
    // their own password.
    pruneLoginAttempts(before) { deleteOldAttempts.run(Number(before)); },

    // ---- what a super admin changed (PROVIDERS-1) ------------------------------------------------
    //
    // Two calls rather than one, and the pair is the point. The row goes down BEFORE the proxy is
    // asked, carrying outcome 'started'; the second call finishes it with what happened. A change
    // that timed out half way through, or a process that was killed between the two, therefore
    // leaves a row saying a change was STARTED and never says it succeeded, which is the honest
    // record and is exactly the state an operator needs to see. A single write after the fact
    // would leave no trace at all of the one case worth investigating.

    /** Written before the change. Answers the row id, which finishAdminAction takes. */
    recordAdminAction({ at = now(), actor = "", via = "console", ip = "", action = "", target = "", detail = "", outcome = "started" }) {
      insertAction.run(
        Number(at), String(actor ?? ""), String(via ?? ""), String(ip ?? ""),
        String(action ?? ""), String(target ?? ""),
        // A caller that hands an object gets it written as JSON rather than as [object Object].
        typeof detail === "string" ? detail : JSON.stringify(detail ?? ""),
        String(outcome ?? "started"),
      );
      return Number(db.prepare("SELECT last_insert_rowid() AS id").get()?.id ?? 0);
    },

    /** The same row, finished. `detail` is left as it was when nothing new is passed. */
    finishAdminAction(id, outcome, detail = "") {
      const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
      finishActionRow.run(String(outcome ?? "ok"), text, text, text, Number(id));
    },

    listAdminActions({ sinceMs = 0, limit = 200 } = {}) {
      const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 5000) : 200;
      return selectActions.all(Number(sinceMs) || 0, cap).map((row) => ({
        id: Number(row.id),
        at: Number(row.at),
        actor: row.actor ?? "",
        via: row.via ?? "",
        ip: row.ip ?? "",
        action: row.action ?? "",
        target: row.target ?? "",
        detail: row.detail ?? "",
        outcome: row.outcome ?? "",
      }));
    },

    countAdminActions() { return Number(countActionsRow.get()?.n ?? 0); },

    // ---- the console's own settings (PROVIDERS-1) ------------------------------------------------

    getSetting(name, fallback = "") {
      const row = selectSetting.get(String(name));
      return row == null ? fallback : String(row.value ?? "");
    },
    setSetting(name, value, actor = "") {
      upsertSetting.run(String(name), String(value ?? ""), now(), String(actor ?? ""));
      const row = selectSetting.get(String(name));
      return { name: String(name), value: String(row?.value ?? ""), at: Number(row?.at ?? 0), actor: String(row?.actor ?? "") };
    },
    // A SECRET NAME COMES BACK WITH NO VALUE. See SECRET_SETTINGS: this table now holds the super
    // admin's GitHub token, and every caller of this method renders what it gets. `redacted` is on
    // the row rather than the row being left out, because the panel has to be able to say "there is
    // a token here" without being able to say what it is.
    listSettings() {
      return selectSettings.all().map((row) => {
        const secret = SECRET_SETTINGS.has(String(row.name));
        return {
          name: row.name,
          value: secret ? "" : (row.value ?? ""),
          redacted: secret,
          at: Number(row.at),
          actor: row.actor ?? "",
        };
      });
    },

    // ---- what an agent reported (FEEDBACK-1) -----------------------------------------------------

    /** One report, as the relay's forwarded workspace and the console's clamped payload. */
    recordFeedback({ at = now(), tenant = "", agent = "", agentName = "", tier = "observation", category = "", title = "", body = "", payload = "", state = "new" }) {
      const bodyText = String(body ?? "");
      const payloadText = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
      // Refused rather than truncated. A report cut in half reads as a whole one and sends whoever
      // reads it looking for a step that was never written down.
      if (bodyText.length > FEEDBACK_FIELD_LIMIT || payloadText.length > FEEDBACK_FIELD_LIMIT) {
        const error = new Error(`a report has to fit in ${Math.round(FEEDBACK_FIELD_LIMIT / 1024)} KB, and this one does not, so nothing was stored`);
        error.code = "too_large";
        throw error;
      }
      if (!FEEDBACK_STATES.includes(String(state))) {
        const error = new Error(`a report's state has to be one of ${FEEDBACK_STATES.join(", ")}`);
        error.code = "bad_state";
        throw error;
      }
      insertFeedback.run(
        Number(at), String(tenant ?? ""), String(agent ?? ""), String(agentName ?? ""),
        String(tier ?? ""), String(category ?? ""), String(title ?? ""),
        bodyText, payloadText, String(state),
      );
      return feedbackRow(selectFeedbackRow.get(Number(db.prepare("SELECT last_insert_rowid() AS id").get()?.id ?? 0)));
    },

    getFeedback(id) { return feedbackRow(selectFeedbackRow.get(Number(id))); },

    listFeedback({ tier = "", state = "", tenant = "", sinceMs = 0, limit = 200 } = {}) {
      const where = ["at >= ?"];
      const values = [Number(sinceMs) || 0];
      if (String(tier ?? "").length > 0) { where.push("tier = ?"); values.push(String(tier)); }
      if (String(state ?? "").length > 0) { where.push("state = ?"); values.push(String(state)); }
      if (String(tenant ?? "").length > 0) { where.push("tenant = ?"); values.push(String(tenant)); }
      const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 2000) : 200;
      values.push(cap);
      return db.prepare(`SELECT * FROM feedback WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`)
        .all(...values).map(feedbackRow);
    },

    countFeedback() { return Number(countFeedbackRow.get()?.n ?? 0); },

    /** A patch of the columns a super admin can move. Anything else on the row is what arrived. */
    updateFeedback(id, patch = {}) {
      const current = selectFeedbackRow.get(Number(id));
      if (current == null) return null;
      const sets = [];
      const values = [];
      if (patch.state !== undefined) {
        if (!FEEDBACK_STATES.includes(String(patch.state))) {
          const error = new Error(`a report's state has to be one of ${FEEDBACK_STATES.join(", ")}`);
          error.code = "bad_state";
          throw error;
        }
        sets.push("state = ?"); values.push(String(patch.state));
      }
      for (const [key, column] of [["title", "title"], ["body", "body"], ["issueUrl", "issueUrl"], ["decidedBy", "decidedBy"]]) {
        if (patch[key] === undefined) continue;
        const text = String(patch[key] ?? "");
        if ((key === "body") && text.length > FEEDBACK_FIELD_LIMIT) {
          const error = new Error(`a report has to fit in ${Math.round(FEEDBACK_FIELD_LIMIT / 1024)} KB, and this edit does not, so nothing was changed`);
          error.code = "too_large";
          throw error;
        }
        sets.push(`${column} = ?`); values.push(text);
      }
      if (sets.length === 0) return feedbackRow(current);
      sets.push("decidedAt = ?"); values.push(now());
      values.push(Number(id));
      db.prepare(`UPDATE feedback SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      return feedbackRow(selectFeedbackRow.get(Number(id)));
    },

    /**
     * Every table in this database, by name.
     *
     * One caller: the Feedback panel asks whether wave B's verification table has landed yet, so
     * the filter appears when there is something behind it and is absent rather than empty when
     * there is not. Reading sqlite_master is the only way to ask that without importing a module
     * that may not exist.
     */
    tableNames() { return tableNamesRow.all().map((row) => String(row.name)); },

    // ---- tenants -----------------------------------------------------------------------------

    createTenant({ slug, name = "", host = "", status = "provisioning", ownerEmail = null, coolifyServiceUuid = null, boxContainer = null }) {
      const at = now();
      try {
        insertTenant.run(String(slug), String(name ?? ""), String(host ?? ""), String(status), coolifyServiceUuid, ownerEmail, null, boxContainer, at, at);
      } catch (error) {
        if (String(error?.message ?? "").includes("UNIQUE") || String(error?.message ?? "").includes("PRIMARY KEY")) {
          const conflict = new Error("that tenant already exists");
          conflict.code = "duplicate_slug";
          throw conflict;
        }
        throw error;
      }
      // Built again under a name that was retired: that is the operator rebuilding on purpose, and
      // the orphaned sign-ins this table was protecting now belong to this workspace again.
      deleteRetired.run(String(slug));
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
        boxContainer: "box_container",
      };
      const sets = [];
      const values = [];
      for (const [key, column] of Object.entries(columns)) {
        if (!Object.hasOwn(patch, key)) continue;
        sets.push(`${column} = ?`);
        values.push(patch[key] === null || patch[key] === undefined ? null : String(patch[key]));
      }
      // A boolean, so it goes in as 0 or 1 rather than through the String() the text columns take.
      if (Object.hasOwn(patch, "boxReady")) { sets.push("box_ready = ?"); values.push(patch.boxReady ? 1 : 0); }
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
      // Only when somebody can still sign in with it. A sign-up that failed half way through
      // deletes the row it just wrote, and that name has never been anybody's, so it stays free.
      const left = selectAccountsByTenant.all(String(slug)).length;
      if (left > 0) insertRetired.run(String(slug), now(), left);
      return row;
    },

    // ---- retired workspace names ---------------------------------------------------------------
    isSlugRetired(slug) { return selectRetired.get(String(slug)) != null; },
    listRetiredSlugs() {
      return selectRetiredAll.all().map((row) => ({
        slug: row.slug, retiredAt: Number(row.retired_at), accounts: Number(row.accounts ?? 0),
      }));
    },
    releaseSlug(slug) { deleteRetired.run(String(slug)); },

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

    // ---- the per-bot mail directory (MAIL-2) ----------------------------------------------------

    /**
     * This bot's address, minted once and then handed back for ever.
     *
     * The code is SIX RANDOM DIGITS and it is INSERTED rather than chosen: a select-then-insert
     * would let two sweeps running together pick the same free number, and one of those bots would
     * lose its mail to the other. The insert IS the check -- a UNIQUE failure on `code` means
     * somebody already holds that number, so it tries again. Twenty tries against a million values
     * is not a number that runs out; the cap is there so a corrupt table cannot spin forever.
     *
     * A RETIRED ROW IS NEVER HANDED BACK, and is never reactivated either. Retiring kills the
     * ADDRESS and not the bot, so the next sweep mints that bot a fresh one; the dead row stays
     * where it is, and because `code` is the primary key that number can never be minted for
     * anybody, ever. See the partial index on the table for why it is written that way.
     */
    mintMailCode({ tenant, agentId, agentName = "", domain }) {
      const slug = String(tenant ?? "");
      const id = String(agentId ?? "");
      const name = String(agentName ?? "");
      const at = String(domain ?? "").trim().toLowerCase();
      if (slug.length === 0 || id.length === 0 || at.length === 0) return null;
      const found = selectMailByAgent.get(slug, id);
      if (found != null) {
        // The display name is the one field that moves: an agent renamed in the console should read
        // as its new name on the operator's list and in the From line. The address never moves.
        if (name.length > 0 && name !== found.agent_name) {
          updateMailName.run(name, found.code);
          return mailRow(selectMailByCode.get(found.code));
        }
        return mailRow(found);
      }
      for (let tries = 0; tries < 20; tries += 1) {
        const code = String(randomInt(0, 1000000)).padStart(6, "0");
        try {
          insertMailAddress.run(code, slug, id, name, `agent${code}@${at}`, new Date().toISOString());
          return mailRow(selectMailByCode.get(code));
        } catch (error) {
          if (!/UNIQUE/i.test(String(error?.message ?? ""))) throw error;
          // The other UNIQUE on this table is (tenant, agent_id), which means a sweep running
          // beside this one minted the row between the select above and this insert. That is a
          // success and not a collision: read its row and hand it back.
          const raced = selectMailByAgent.get(slug, id);
          if (raced != null) return mailRow(raced);
        }
      }
      const exhausted = new Error("could not find a free six digit code in twenty tries");
      exhausted.code = "mail_code_exhausted";
      throw exhausted;
    },

    getMailAddressByCode(code) { return mailRow(selectMailByCode.get(String(code ?? ""))); },
    /** This bot's LIVE address, or null. A bot whose address was retired has none until the next sweep. */
    getMailAddressByAgent(tenant, agentId) { return mailRow(selectMailByAgent.get(String(tenant ?? ""), String(agentId ?? ""))); },
    listMailAddresses(tenant = null) {
      return (tenant == null ? selectMailAll.all() : selectMailByTenant.all(String(tenant))).map(mailRow);
    },
    countMailAddresses(tenant) { return Number(countMailByTenant.get(String(tenant ?? ""))?.n ?? 0); },
    /** Sets the state and the date. It never deletes: see the comment on the table. */
    retireMailAddress(code) {
      const key = String(code ?? "");
      if (selectMailByCode.get(key) == null) return null;
      retireMailRow.run(new Date().toISOString(), key);
      return mailRow(selectMailByCode.get(key));
    },

    allowSender(tenant, sender) {
      const address = normalizeEmail(sender);
      if (String(tenant ?? "").length === 0 || address.length === 0) return null;
      insertMailSender.run(String(tenant), address, new Date().toISOString());
      return { tenant: String(tenant), sender: address };
    },
    listSenders(tenant) {
      return selectMailSenders.all(String(tenant ?? "")).map((row) => ({ tenant: row.tenant, sender: row.sender, at: row.at }));
    },
    blockSender(tenant, sender) { deleteMailSender.run(String(tenant ?? ""), normalizeEmail(sender)); },

    /** One row per send. Addresses and an outcome; never a subject and never a body. */
    recordMailSend({ tenant, agentId = "", code = "", to = "", outcome = "sent", at = new Date().toISOString() }) {
      insertMailSend.run(String(tenant ?? ""), String(agentId), String(code), String(to), String(at), String(outcome));
    },
    countMailSends(tenant, since = "") { return Number(countMailSendRows.get(String(tenant ?? ""), String(since))?.n ?? 0); },

    /**
     * MAIL-3. The claim, made before the mail is, answering the row's id so the settle can find it.
     * The row reads `sending` until somebody says otherwise.
     */
    claimMailSend({ tenant, agentId = "", code = "", to = "", at = new Date().toISOString() }) {
      const answer = claimMailSendRow.run(String(tenant ?? ""), String(agentId), String(code), String(to), String(at));
      return Number(answer?.lastInsertRowid ?? 0);
    },
    /** And the settle. It updates the claimed row rather than writing a second one. */
    settleMailSend(id, { outcome = "", resendId = "", detail = "" } = {}) {
      settleMailSendRow.run(String(outcome), String(resendId), String(detail).slice(0, 500), Number(id));
    },
    /** The operator's list, newest first, for one workspace and never for all of them at once. */
    listMailSends(tenant, limit = 50) {
      const rows = selectMailSends.all(String(tenant ?? ""), Math.max(1, Math.min(500, Number(limit) || 50)));
      return rows.map(mailSendRow).map((row) => ({
        ...row,
        // The bot's NAME is read out of the directory by its code rather than copied into this
        // table when the send happened: a name is a customer's string and a copy of one goes stale
        // the moment the bot is renamed. Empty when the code has no row, which a very old send has.
        agentName: String(selectMailByCode.get(row.code)?.agent_name ?? ""),
      }));
    },
    /** What one bot has in flight or away inside the window, and when the oldest of those went. */
    agentMailSendWindow(tenant, agentId, since = "") {
      return sendWindow(countAgentSendRows.get(String(tenant ?? ""), String(agentId ?? ""), String(since)));
    },
    /** The same for a whole workspace. */
    tenantMailSendWindow(tenant, since = "") {
      return sendWindow(countTenantSendRows.get(String(tenant ?? ""), String(since)));
    },
    countAgentMailSends(tenant, agentId, since = "") {
      return sendWindow(countAgentSendRows.get(String(tenant ?? ""), String(agentId ?? ""), String(since))).count;
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
    // countIp false leaves the address bucket out and keeps the email one.
    //
    // It is for a caller that is a RELAY rather than a person: every customer signing in through
    // console.titanium.bot or any tenant's console arrives here from that one machine's egress
    // address, so the address bucket is a single bucket shared by the whole fleet. Ten wrong
    // passwords typed at any login page then refused POST /v1/sessions for every customer on every
    // instance for ten minutes, and nobody could clear it: clearLoginFailures matches email AND ip,
    // so failures against ten made-up addresses stay until they age out. Measured 2026-09-07: a
    // failed sign-in through demo.titanium.bot and one through console.titanium.bot both landed in
    // login_failures as the R750's own egress address.
    //
    // The email bucket still does the work it always did, and it is the one that is actually about
    // a person. The relay in front of these callers has its own per-address lockout (ui/auth.mjs,
    // five failures then thirty seconds) counted against the real visitor, which is the address
    // this service cannot see.
    loginLock({ email = "", ip = "", at = now(), countIp = true }) {
      const since = Number(at) - LOCKOUT_WINDOW_MS;
      const buckets = [
        countFailuresByEmail.get(normalizeEmail(email), since),
        countIp ? countFailuresByIp.get(String(ip ?? ""), since) : null,
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
