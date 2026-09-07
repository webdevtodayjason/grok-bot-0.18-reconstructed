// TENANT-1. The store: password hashing, the accounts and tenants tables, the revocation list, the
// provisioning ledger a retry reads, and the two login lockout buckets.
import assert from "node:assert/strict";
import test from "node:test";
import { rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  CP_SCRYPT_PARAMS,
  LOCKOUT_MAX_FAILURES,
  LOCKOUT_WINDOW_MS,
  burnPasswordTime,
  hashPassword,
  hashPasswordAsync,
  normalizeEmail,
  openStore,
  verifyPassword,
  verifyPasswordAsync,
} from "../cp/store.mjs";
import { makeTempRoot } from "./cp-support.mjs";

async function withStore(run) {
  const root = await makeTempRoot("cp-store-");
  const store = openStore({ dataDir: root });
  try { await run(store, root); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

test("scrypt runs at the parameters the contract fixes, with maxmem set so it can run at all", () => {
  const record = hashPassword("correct horse battery staple");
  assert.equal(record.algorithm, "scrypt");
  assert.equal(record.N, 32768);
  assert.equal(record.r, 8);
  assert.equal(record.p, 1);
  assert.equal(record.keylen, 64);
  // 64 hex characters is 32 bytes; a 64 byte key is 128.
  assert.equal(record.hash.length, 128);
  assert.equal(record.salt.length, 32);
  // Node's default scrypt ceiling is 32 MB and these parameters need 33.5, so without maxmem the
  // very first account could never be created.
  assert.ok(CP_SCRYPT_PARAMS.maxmem > 128 * CP_SCRYPT_PARAMS.N * CP_SCRYPT_PARAMS.r);
});

test("verify says yes to the password and no to everything else", () => {
  const record = hashPassword("a-good-password");
  assert.equal(verifyPassword("a-good-password", record), true);
  assert.equal(verifyPassword("a-good-passwore", record), false);
  assert.equal(verifyPassword("", record), false);
  assert.equal(verifyPassword("a-good-password", null), false);
  assert.equal(verifyPassword("a-good-password", { ...record, algorithm: "md5" }), false);
  assert.equal(verifyPassword("a-good-password", { ...record, hash: "00" }), false);
  assert.equal(verifyPassword("a-good-password", { ...record, N: 0 }), false);
});

test("two accounts with the same password get different hashes", () => {
  const first = hashPassword("same-password-twice");
  const second = hashPassword("same-password-twice");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
});

test("the sqlite file is 0600 and the accounts table never hands a hash back", async () => {
  await withStore(async (store, root) => {
    const file = path.join(root, "control-plane.sqlite");
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600);

    const account = store.createAccount({ email: "Owner@Example.COM", password: "a-good-password", name: "Owner", tenant: "acme" });
    assert.equal(account.email, "owner@example.com", "the address is lowercased on the way in");
    assert.equal(Object.hasOwn(account, "password_json"), false);
    assert.equal(Object.hasOwn(account, "hash"), false);
    for (const row of store.listAccounts()) {
      assert.deepEqual(Object.keys(row).sort(), ["createdAt", "email", "id", "name", "tenant", "updatedAt"]);
    }
    assert.equal(store.getAccountByEmail("OWNER@example.com").id, account.id);
    assert.equal(normalizeEmail("  Mixed@Case.io "), "mixed@case.io");
  });
});

test("a second account on the same address is a duplicate, not a silent overwrite", async () => {
  await withStore(async (store) => {
    store.createAccount({ email: "one@example.com", password: "a-good-password", tenant: "acme" });
    assert.throws(
      () => store.createAccount({ email: "ONE@example.com", password: "another-password", tenant: "other" }),
      (error) => error.code === "duplicate_email",
    );
    assert.equal(store.countAccounts(), 1);
  });
});

test("verifyAccountPassword checks the stored hash and an operator reset replaces it", async () => {
  await withStore(async (store) => {
    const account = store.createAccount({ email: "owner@example.com", password: "first-password", tenant: "acme" });
    assert.equal(store.verifyAccountPassword("owner@example.com", "first-password").ok, true);
    assert.equal(store.verifyAccountPassword("owner@example.com", "wrong-password").ok, false);
    assert.equal(store.verifyAccountPassword("nobody@example.com", "first-password").ok, false);

    store.setAccountPassword(account.id, "second-password");
    assert.equal(store.verifyAccountPassword("owner@example.com", "first-password").ok, false);
    assert.equal(store.verifyAccountPassword("owner@example.com", "second-password").ok, true);
    assert.equal(store.setAccountPassword("no-such-id", "second-password"), null);
  });
});

test("tenants round trip, refuse a duplicate slug and take a patch", async () => {
  await withStore(async (store) => {
    const tenant = store.createTenant({ slug: "acme", name: "Acme Roofing", host: "acme.titanium.bot" });
    assert.equal(tenant.status, "provisioning");
    assert.equal(tenant.coolifyServiceUuid, null);
    assert.throws(() => store.createTenant({ slug: "acme", name: "Someone else" }), (error) => error.code === "duplicate_slug");

    const updated = store.updateTenant("acme", { status: "running", coolifyServiceUuid: "svc-1", lastError: "a thing went wrong" });
    assert.equal(updated.status, "running");
    assert.equal(updated.coolifyServiceUuid, "svc-1");
    assert.equal(updated.lastError, "a thing went wrong");
    // An explicit null clears it, which is what a successful retry does.
    assert.equal(store.updateTenant("acme", { lastError: null }).lastError, null);
    assert.equal(store.updateTenant("no-such-tenant", { status: "running" }), null);
    assert.equal(store.countTenants(), 1);

    store.deleteTenant("acme");
    assert.equal(store.getTenant("acme"), null);
    assert.equal(store.countTenants(), 0);
  });
});

test("a revoked session id is remembered until it expires and then pruned", async () => {
  await withStore(async (store) => {
    const now = 1_780_000_000_000;
    store.revokeSession("jti-live", now + 60_000);
    store.revokeSession("jti-stale", now - 60_000);
    assert.equal(store.isSessionRevoked("jti-live"), true);
    assert.equal(store.isSessionRevoked("jti-stale"), true);
    assert.equal(store.isSessionRevoked("jti-never-seen"), false);

    // A revoked token that has expired is refused by the expiry check anyway, so its row is dead
    // weight and goes.
    store.pruneRevocations(now);
    assert.equal(store.isSessionRevoked("jti-stale"), false);
    assert.equal(store.isSessionRevoked("jti-live"), true);
  });
});

test("the provisioning ledger says which steps are complete, and a later failure undoes an earlier ok", async () => {
  await withStore(async (store) => {
    store.createTenant({ slug: "acme" });
    store.recordStep({ slug: "acme", step: "directories", status: "ok" });
    store.recordStep({ slug: "acme", step: "secrets", status: "ok" });
    store.recordStep({ slug: "acme", step: "envs", status: "failed", detail: "Coolify answered 500" });
    assert.deepEqual([...store.completedSteps("acme")].sort(), ["directories", "secrets"]);

    store.recordStep({ slug: "acme", step: "envs", status: "ok" });
    assert.deepEqual([...store.completedSteps("acme")].sort(), ["directories", "envs", "secrets"]);
    assert.equal(store.listSteps("acme").length, 4, "the ledger is append only, the failure stays on the record");
    assert.equal(store.listSteps("acme")[2].detail, "Coolify answered 500");

    // Removing a tenant takes its ledger with it, so a name reused later starts clean.
    store.deleteTenant("acme");
    assert.deepEqual(store.listSteps("acme"), []);
  });
});

test("ten failures on one email in ten minutes locks it, and the answer says when to try again", async () => {
  await withStore(async (store) => {
    const now = 1_780_000_000_000;
    for (let index = 0; index < LOCKOUT_MAX_FAILURES - 1; index += 1) {
      store.recordLoginFailure({ email: "owner@example.com", ip: "203.0.113.9", at: now + index });
    }
    assert.equal(store.loginLock({ email: "owner@example.com", ip: "203.0.113.9", at: now + 100 }).locked, false);

    store.recordLoginFailure({ email: "owner@example.com", ip: "203.0.113.9", at: now + 100 });
    const lock = store.loginLock({ email: "owner@example.com", ip: "203.0.113.9", at: now + 200 });
    assert.equal(lock.locked, true);
    // The oldest failure ages out ten minutes after it happened, and that is the earliest a further
    // try can get through.
    assert.equal(lock.retryAfter, Math.ceil((now + LOCKOUT_WINDOW_MS - (now + 200)) / 1000));

    // Ten minutes and one millisecond later the window is empty again.
    assert.equal(store.loginLock({ email: "owner@example.com", ip: "203.0.113.9", at: now + LOCKOUT_WINDOW_MS + 1 }).locked, false);
  });
});

test("the two buckets are separate: one address spraying many emails locks, and so does one email from many addresses", async () => {
  await withStore(async (store) => {
    const now = 1_780_000_000_000;
    // One machine, ten different addresses. The email bucket never reaches ten; the ip bucket does.
    for (let index = 0; index < LOCKOUT_MAX_FAILURES; index += 1) {
      store.recordLoginFailure({ email: `person${index}@example.com`, ip: "198.51.100.7", at: now + index });
    }
    assert.equal(store.loginLock({ email: "person0@example.com", ip: "198.51.100.7", at: now + 50 }).locked, true);
    assert.equal(store.loginLock({ email: "person0@example.com", ip: "198.51.100.8", at: now + 50 }).locked, false);

    // One address, ten different machines. The ip bucket never reaches ten; the email bucket does.
    for (let index = 0; index < LOCKOUT_MAX_FAILURES; index += 1) {
      store.recordLoginFailure({ email: "target@example.com", ip: `192.0.2.${index}`, at: now + index });
    }
    assert.equal(store.loginLock({ email: "target@example.com", ip: "192.0.2.99", at: now + 50 }).locked, true);
    assert.equal(store.loginLock({ email: "someone-else@example.com", ip: "192.0.2.99", at: now + 50 }).locked, false);
  });
});

test("countIp false drops the address bucket and keeps the email one", async () => {
  await withStore(async (store) => {
    const now = 1_780_000_000_000;
    // What a relay's calls look like: ten failures against ten made-up addresses, all arriving from
    // the one machine every tenant console posts its sign-ins from. With the address bucket counted,
    // that armed a ten minute refusal for EVERY customer on EVERY instance, and nothing could clear
    // it: a clear matches email AND address, and none of those emails will ever sign in.
    for (let index = 0; index < LOCKOUT_MAX_FAILURES; index += 1) {
      store.recordLoginFailure({ email: `made-up-${index}@example.com`, ip: "66.90.191.45", at: now + index });
    }
    assert.equal(store.loginLock({ email: "customer@example.com", ip: "66.90.191.45", at: now + 50 }).locked, true,
      "the shared bucket is what this is about, so it has to still be there when it is counted");
    assert.equal(store.loginLock({ email: "customer@example.com", ip: "66.90.191.45", at: now + 50, countIp: false }).locked, false);

    // And the email bucket is untouched by the flag: a real person being guessed at is still locked,
    // which is the half that is actually about a person.
    for (let index = 0; index < LOCKOUT_MAX_FAILURES; index += 1) {
      store.recordLoginFailure({ email: "customer@example.com", ip: "66.90.191.45", at: now + index });
    }
    assert.equal(store.loginLock({ email: "customer@example.com", ip: "66.90.191.45", at: now + 50, countIp: false }).locked, true);
    assert.equal(store.loginLock({ email: "somebody-else@example.com", ip: "66.90.191.45", at: now + 50, countIp: false }).locked, false);
  });
});

test("a successful sign-in clears the counters for that email and that address", async () => {
  await withStore(async (store) => {
    const now = 1_780_000_000_000;
    for (let index = 0; index < LOCKOUT_MAX_FAILURES; index += 1) {
      store.recordLoginFailure({ email: "owner@example.com", ip: "203.0.113.9", at: now + index });
    }
    assert.equal(store.loginLock({ email: "owner@example.com", ip: "203.0.113.9", at: now + 50 }).locked, true);
    store.clearLoginFailures({ email: "owner@example.com", ip: "203.0.113.9" });
    assert.equal(store.loginLock({ email: "owner@example.com", ip: "203.0.113.9", at: now + 50 }).locked, false);
  });
});

test("one person's successful sign-in does not clear the lock somebody else was walking into", async () => {
  await withStore(async (store) => {
    const now = 1_780_000_000_000;
    // The attacker owns attacker@example.com and is guessing target@example.com. Their guesses are
    // spread one per address so no address bucket ever reaches ten, and the email bucket fills.
    for (let index = 0; index < LOCKOUT_MAX_FAILURES; index += 1) {
      store.recordLoginFailure({ email: "target@example.com", ip: `198.51.100.${index}`, at: now + index });
    }
    assert.equal(store.loginLock({ email: "target@example.com", ip: "198.51.100.50", at: now + 60 }).locked, true);

    // Now they sign in successfully as themselves, from every one of those same addresses. Under
    // the old `email = ? OR ip = ?` clear this deleted the target's rows and the lock was gone.
    for (let index = 0; index < LOCKOUT_MAX_FAILURES; index += 1) {
      store.clearLoginFailures({ email: "attacker@example.com", ip: `198.51.100.${index}` });
    }
    assert.equal(
      store.loginLock({ email: "target@example.com", ip: "198.51.100.50", at: now + 60 }).locked,
      true,
      "somebody else's sign-in must not unlock an account that is being guessed at",
    );

    // And the clear still does the job it exists for: the same person, at the same address.
    store.clearLoginFailures({ email: "target@example.com", ip: "198.51.100.0" });
    for (let index = 1; index < LOCKOUT_MAX_FAILURES; index += 1) {
      store.clearLoginFailures({ email: "target@example.com", ip: `198.51.100.${index}` });
    }
    assert.equal(store.loginLock({ email: "target@example.com", ip: "198.51.100.50", at: now + 60 }).locked, false);
  });
});

test("the async password path answers the same as the sync one, off the event loop", async () => {
  const record = await hashPasswordAsync("correct horse battery staple");
  assert.equal(record.algorithm, "scrypt");
  assert.equal(record.N, CP_SCRYPT_PARAMS.N);
  assert.equal(await verifyPasswordAsync("correct horse battery staple", record), true);
  assert.equal(await verifyPasswordAsync("not the password", record), false);
  // The two forms read each other's records, which is what lets the operator routes stay sync.
  assert.equal(verifyPassword("correct horse battery staple", record), true);
  assert.equal(await verifyPasswordAsync("correct horse battery staple", hashPassword("correct horse battery staple")), true);

  await withStore(async (store) => {
    store.createTenant({ slug: "acme", name: "Acme" });
    const account = store.createAccount({ email: "owner@example.com", password: "a-good-password", tenant: "acme" });
    const right = await store.verifyAccountPasswordAsync("Owner@Example.com", "a-good-password");
    assert.equal(right.ok, true);
    assert.equal(right.account.id, account.id);
    assert.equal((await store.verifyAccountPasswordAsync("owner@example.com", "wrong")).ok, false);
    assert.equal((await store.verifyAccountPasswordAsync("nobody@example.com", "a-good-password")).ok, false);
  });
});

test("the health of the process is measurable while sign-in derivations are in flight", async () => {
  // The point of the async path, stated as a measurement rather than as a claim: with forty
  // derivations running, a plain turn of the event loop still happens promptly. The sync form held
  // the only thread for about 40 ms each, so this loop could not have run at all until they were
  // all done.
  const started = Date.now();
  const work = Array.from({ length: 40 }, () => burnPasswordTime("whatever-they-typed"));
  let turns = 0;
  const ticker = setInterval(() => { turns += 1; }, 5);
  await Promise.all(work);
  clearInterval(ticker);
  const elapsed = Date.now() - started;
  assert.ok(turns > 0, `the event loop turned ${turns} times in ${elapsed} ms of derivations`);
});
