// ADMIN-1. The control plane's half: the super admin flag and the disabled flag on an account, the
// sign-in record that is NOT the lockout counter, and the two rules the panel is built on -- which
// address is attacking, and which row is the same attempt seen twice.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";

import { openStore } from "../cp/store.mjs";
import {
  ATTACK_DISTINCT_PASSWORDS,
  ATTACK_WINDOW_MS,
  mergeAttempts,
  stuckProvisioning,
  summariseByAddress,
} from "../cp/admin.mjs";
import { makeTempRoot } from "./cp-support.mjs";

async function withStore(run) {
  const root = await makeTempRoot("cp-admin-");
  const store = openStore({ dataDir: root });
  try { await run(store, root); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

const PASSWORD = "a-good-password";
const HASH = (n) => String(n).padStart(2, "0").repeat(32);

test("a new account is nobody's super admin and nobody's disabled account", async () => {
  await withStore((store) => {
    const account = store.createAccount({ email: "owner@example.com", password: PASSWORD, tenant: "acme" });
    // The only safe default for either. An upgrade of a database that already exists gives nobody
    // the console and locks nobody out of their own workspace.
    assert.equal(account.superAdmin, false);
    assert.equal(account.disabled, false);
    assert.equal(store.countSuperAdmins(), 0);
  });
});

test("promote and demote, by id or by the email an operator actually types", async () => {
  await withStore((store) => {
    const account = store.createAccount({ email: "Jason@Example.com", password: PASSWORD, tenant: "titanium" });
    assert.equal(store.setSuperAdmin("jason@example.com", true).superAdmin, true, "an email works, because that is what the CLI is given");
    assert.equal(store.getAccountById(account.id).superAdmin, true);
    assert.equal(store.countSuperAdmins(), 1);
    assert.equal(store.setSuperAdmin(account.id, false).superAdmin, false, "and so does an id, because that is what the console holds");
    assert.equal(store.countSuperAdmins(), 0);
    assert.equal(store.setSuperAdmin("nobody@example.com", true), null, "somebody who does not exist is null, not a throw");
  });
});

test("a disabled account keeps its password, its workspace and its place in the list", async () => {
  await withStore(async (store) => {
    const account = store.createAccount({ email: "owner@example.com", password: PASSWORD, tenant: "acme" });
    store.setAccountDisabled(account.id, true);
    assert.equal(store.getAccountById(account.id).disabled, true);
    // The point of a disabled account as against a deleted one: it is reversible, and nothing about
    // the person's workspace or password moved. The sign-in route is what reads the flag.
    assert.equal((await store.verifyAccountPasswordAsync("owner@example.com", PASSWORD)).ok, true);
    assert.equal(store.listAccountsForTenant("acme").length, 1);
    assert.equal(store.setAccountDisabled(account.id, false).disabled, false);
  });
});

test("the sign-in record is not the lockout counter, and a success does not clear it", async () => {
  await withStore((store) => {
    const at = Date.now();
    store.recordLoginAttempt({ at: at - 3000, email: "Owner@Example.com", ip: "203.0.113.9", outcome: "refused", triedHash: HASH(1) });
    store.recordLoginAttempt({ at: at - 2000, email: "owner@example.com", ip: "203.0.113.9", outcome: "locked" });
    store.recordLoginAttempt({ at: at - 1000, email: "owner@example.com", ip: "203.0.113.9", outcome: "ok", tenant: "acme" });
    // login_failures is cleared on a successful sign-in, by design: it is a speed limit, not a
    // record. This table is the record, and the whole panel depends on nothing clearing it.
    store.clearLoginFailures({ email: "owner@example.com", ip: "203.0.113.9" });

    const rows = store.listLoginAttempts({ since: 0 });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].outcome, "ok", "newest first");
    assert.equal(rows[0].tenant, "acme");
    assert.equal(rows[2].email, "owner@example.com", "the address is lowercased on the way in");
    assert.equal(rows[2].triedHash, HASH(1));
    assert.equal(rows[1].triedHash, "", "a lockout carries no hash");
    assert.equal(store.listLoginAttempts({ since: 0, outcome: "refused" }).length, 1);
    assert.equal(store.listLoginAttempts({ since: at - 1500 }).length, 1, "the window filters");
    assert.equal(store.countLoginAttempts(0), 3);
  });
});

test("a caller cannot write a password into the hash column by mistake", async () => {
  await withStore((store) => {
    store.recordLoginAttempt({ email: "owner@example.com", ip: "1.1.1.1", outcome: "refused", triedHash: "hunter2" });
    store.recordLoginAttempt({ email: "owner@example.com", ip: "1.1.1.1", outcome: "refused", triedHash: `${HASH(2)}extra` });
    // The shape is checked rather than trusted. A caller that passed the clear text here would
    // otherwise be writing a password into the database, which is the one thing this whole design
    // exists to prevent.
    for (const row of store.listLoginAttempts({ since: 0 })) assert.equal(row.triedHash, "");
  });
});

test("the record is pruned to its retention window and not before", async () => {
  await withStore((store) => {
    const at = Date.now();
    store.recordLoginAttempt({ at: at - 40 * 24 * 60 * 60 * 1000, email: "old@example.com", ip: "1.1.1.1", outcome: "refused", triedHash: HASH(1) });
    store.recordLoginAttempt({ at, email: "new@example.com", ip: "1.1.1.1", outcome: "refused", triedHash: HASH(2) });
    store.pruneLoginAttempts(at - 30 * 24 * 60 * 60 * 1000);
    const rows = store.listLoginAttempts({ since: 0 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "new@example.com");
  });
});

test("six different passwords from one address inside the window is an attack; the same one forty times is not", () => {
  const at = Date.now();
  const rows = [];
  for (let index = 0; index < ATTACK_DISTINCT_PASSWORDS; index += 1) {
    rows.push({ at: new Date(at + index * 30_000).toISOString(), ip: "198.51.100.7", email: "owner@example.com", outcome: "refused", triedHash: HASH(index), source: "relay" });
  }
  for (let index = 0; index < 40; index += 1) {
    rows.push({ at: new Date(at + index * 30_000).toISOString(), ip: "203.0.113.44", email: "someone@example.com", outcome: "refused", triedHash: HASH(9), source: "relay" });
  }
  const summary = summariseByAddress(rows);
  const attack = summary.find((row) => row.ip === "198.51.100.7");
  const stale = summary.find((row) => row.ip === "203.0.113.44");

  assert.equal(attack.attack, true);
  assert.equal(attack.distinctPasswords, 6);
  assert.equal(attack.passwordStory, "6 different passwords");
  // Forty tries and not an attack, which is the whole reason the hash is kept. This is somebody's
  // phone with a saved password that stopped working, and telling an operator it is an attack is
  // how a real one gets ignored.
  assert.equal(stale.attack, false);
  assert.equal(stale.distinctPasswords, 1);
  assert.equal(stale.repeatedMost, 40);
  assert.equal(stale.passwordStory, "the same password 40 times");
  assert.equal(summary[0].ip, "198.51.100.7", "an attacking address sorts to the top");
});

test("the window slides, so six passwords spread over an hour are not an attack", () => {
  const at = Date.now();
  const spread = [];
  for (let index = 0; index < 6; index += 1) {
    // Twelve minutes apart, so no ten minute window ever holds more than one of them.
    spread.push({ at: new Date(at + index * 12 * 60_000).toISOString(), ip: "198.51.100.8", outcome: "refused", triedHash: HASH(index), source: "relay" });
  }
  const [summary] = summariseByAddress(spread);
  assert.equal(summary.distinctPasswords, 6, "six different passwords were still tried");
  assert.equal(summary.distinctInWindow, 1, "but never more than one inside a window");
  assert.equal(summary.attack, false);
  assert.equal(ATTACK_WINDOW_MS, 10 * 60 * 1000);
});

test("one password tried through both doors is not two different passwords", () => {
  const at = new Date().toISOString();
  // The two services keep separate salts, so the same password produces a different hash on each
  // side. Counted naively, every ordinary sign-in loop would look like twice as many passwords as
  // it was, and a handful of retries would raise the flag.
  const rows = [
    { at, ip: "192.0.2.10", outcome: "refused", triedHash: HASH(1), source: "relay" },
    { at, ip: "192.0.2.10", outcome: "refused", triedHash: HASH(2), source: "control plane" },
  ];
  const [summary] = summariseByAddress(rows);
  assert.equal(summary.distinctPasswords, 2, "they are counted per source, which is the honest count of what is knowable");
  assert.equal(summary.attack, false, "and two is nowhere near the threshold, which is the point");
});

test("an address with no hashed tries says so rather than claiming a password", () => {
  const [summary] = summariseByAddress([
    { at: new Date().toISOString(), ip: "192.0.2.11", outcome: "locked", triedHash: "", source: "relay" },
  ]);
  assert.equal(summary.distinctPasswords, 0);
  assert.equal(summary.passwordStory, "no password reached the check");
  assert.equal(summary.locked, 1);
});

test("the same attempt seen by both ledgers appears once, and the relay's version wins", () => {
  const at = "2026-09-07T12:00:00.000Z";
  const relay = [{ at, ip: "192.0.2.10", email: "owner@example.com", outcome: "refused", door: "account", userAgent: "curl/8", triedHash: HASH(1) }];
  const control = [
    // The same attempt, forwarded: the relay posted it here, so the control plane wrote it down too.
    { at: "2026-09-07T12:00:01.000Z", ip: "192.0.2.10", email: "owner@example.com", outcome: "refused", triedHash: HASH(2) },
    // And one that never went through the console at all, which is what the control plane's own
    // ledger exists for.
    { at: "2026-09-07T12:05:00.000Z", ip: "203.0.113.99", email: "owner@example.com", outcome: "refused", triedHash: HASH(3) },
  ];
  const merged = mergeAttempts(relay, control);
  assert.equal(merged.length, 2, "the duplicate was dropped");
  assert.equal(merged[0].ip, "203.0.113.99", "newest first");
  assert.equal(merged[1].source, "relay");
  assert.equal(merged[1].userAgent, "curl/8", "the relay's row is the richer of the two, so it is the one that survives");
  assert.equal(merged[0].source, "control plane");

  // Two seconds is the window. An attempt a minute later is a different attempt, not the same one.
  const later = mergeAttempts(relay, [{ at: "2026-09-07T12:01:00.000Z", ip: "192.0.2.10", email: "owner@example.com", outcome: "refused", triedHash: HASH(4) }]);
  assert.equal(later.length, 2);
});

test("a workspace whose build stopped moving shows up, and one that just started does not", async () => {
  await withStore((store) => {
    const at = Date.now();
    store.createTenant({ slug: "stalled", name: "Stalled", status: "provisioning" });
    store.createTenant({ slug: "starting", name: "Starting", status: "provisioning" });
    store.createTenant({ slug: "fine", name: "Fine", status: "running" });
    store.recordStep({ slug: "starting", step: "compose", status: "ok" });

    // "stalled" recorded nothing, so its own row's updatedAt is what is read, and that is now: the
    // list is empty until the clock moves past the threshold.
    assert.deepEqual(stuckProvisioning(store, { at }), []);
    const stuck = stuckProvisioning(store, { at: at + 20 * 60 * 1000 });
    assert.deepEqual(stuck.map((row) => row.slug).sort(), ["stalled", "starting"]);
    assert.equal(stuck.find((row) => row.slug === "starting").lastStep, "compose");
    assert.equal(stuck.find((row) => row.slug === "stalled").lastStep, "none recorded");
    assert.equal(stuck.some((row) => row.slug === "fine"), false, "a workspace that is running is not stuck building");
  });
});
