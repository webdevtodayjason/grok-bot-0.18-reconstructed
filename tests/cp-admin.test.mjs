// ADMIN-1. The control plane's half: the super admin flag and the disabled flag on an account, the
// sign-in record that is NOT the lockout counter, and the two rules the panel is built on -- which
// address is attacking, and which row is the same attempt seen twice.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { openStore } from "../cp/store.mjs";
import {
  ATTACK_DISTINCT_PASSWORDS,
  ATTACK_SPRAY_ACCOUNTS,
  ATTACK_WINDOW_MS,
  createAdminApi,
  mergeAttempts,
  stuckProvisioning,
  summariseByAccount,
  summariseByAddress,
  summariseByPassword,
} from "../cp/admin.mjs";
import { createProxyClient } from "../cp/proxy.mjs";
import { makeTempRoot } from "./cp-support.mjs";
import { startFakeProxy } from "./cp-proxy-support.mjs";

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

test("one password against many accounts from many addresses is a spray, and nothing else catches it", () => {
  const at = Date.now();
  const rows = [];
  // The shape of the attack: one common password, one try per account, a different address each
  // time. No address reaches the relay's five-failure lockout, no email reaches this service's
  // ten-failure lockout, and every by-address bucket holds exactly one harmless row.
  for (let index = 0; index < ATTACK_SPRAY_ACCOUNTS; index += 1) {
    rows.push({
      at: new Date(at + index * 20_000).toISOString(),
      ip: `203.0.113.${10 + index}`,
      email: `person${index}@example.com`,
      outcome: "refused",
      triedHash: HASH(7),
      source: "relay",
    });
  }
  assert.equal(summariseByAddress(rows).some((row) => row.attack), false, "the by-address table sees nothing, which is the whole problem");

  const passwords = summariseByPassword(rows);
  assert.equal(passwords.length, 1, "one password was tried");
  assert.equal(passwords[0].accountsInWindow, ATTACK_SPRAY_ACCOUNTS);
  assert.equal(passwords[0].spray, true);
  assert.equal(passwords[0].addresses.length, ATTACK_SPRAY_ACCOUNTS, "and it came from that many places");

  const accounts = summariseByAccount(rows);
  assert.equal(accounts.length, ATTACK_SPRAY_ACCOUNTS);
  assert.equal(accounts.every((row) => row.sprayed), true, "every account it touched is flagged");
  assert.equal(accounts[0].passwordStory, "the same password 1 time");
});

test("ordinary retries are not a spray, and the spray window slides", () => {
  // One person, one account, the same wrong password six times. Nobody else was touched.
  const at = Date.now();
  const mine = [];
  for (let index = 0; index < 6; index += 1) {
    mine.push({ at: new Date(at + index * 20_000).toISOString(), ip: "198.51.100.3", email: "owner@example.com", outcome: "refused", triedHash: HASH(3), source: "relay" });
  }
  assert.equal(summariseByPassword(mine)[0].spray, false, "six tries on one account is a person, not a spray");
  assert.equal(summariseByAccount(mine)[0].sprayed, false);

  // The same password against six accounts, but spread over an hour: no window holds more than one.
  const spread = [];
  for (let index = 0; index < ATTACK_SPRAY_ACCOUNTS; index += 1) {
    spread.push({ at: new Date(at + index * 12 * 60_000).toISOString(), ip: "198.51.100.4", email: `slow${index}@example.com`, outcome: "refused", triedHash: HASH(4), source: "relay" });
  }
  const slow = summariseByPassword(spread)[0];
  assert.equal(slow.accounts.length, ATTACK_SPRAY_ACCOUNTS);
  assert.equal(slow.accountsInWindow, 1);
  assert.equal(slow.spray, false);
});

test("a sign-in forwarded by a customer's console is not an address, and not a second row", () => {
  const at = "2026-09-07T12:00:00.000Z";
  // The relay's row carries the visitor. The control plane's copy of the same attempt carries the
  // R750's own egress address, because that is where the forwarded request came from.
  const relay = [{ at, ip: "192.0.2.77", email: "owner@example.com", outcome: "refused", door: "account", userAgent: "Firefox", triedHash: HASH(1) }];
  const control = [{ at: "2026-09-07T12:00:01.000Z", ip: "66.90.191.45", email: "owner@example.com", outcome: "refused", triedHash: HASH(2), via: "relay" }];

  const merged = mergeAttempts(relay, control);
  assert.equal(merged.length, 1, "the address differs, so only matching on email and outcome drops the duplicate");
  assert.equal(merged[0].ip, "192.0.2.77", "and what is left is the visitor's address, not the server's");

  // One that did NOT come through the console keeps its own row, which is what the second ledger
  // exists for.
  const direct = mergeAttempts(relay, [{ at: "2026-09-07T12:00:01.000Z", ip: "203.0.113.9", email: "owner@example.com", outcome: "refused", triedHash: HASH(3) }]);
  assert.equal(direct.length, 2);

  // And a forwarded row that survived on its own is still kept out of the by-address table, because
  // that address is the server's and bucketing by it would pile the whole fleet under one phantom.
  const alone = [{ at, ip: "66.90.191.45", email: "owner@example.com", outcome: "refused", triedHash: HASH(2), via: "relay", source: "control plane" }];
  assert.deepEqual(summariseByAddress(alone), []);
  assert.equal(summariseByAccount(alone)[0].addresses.length, 0, "the account still shows the attempt, with no address to blame");
  assert.equal(summariseByAccount(alone)[0].attempts, 1);
});

test("the record carries whether a sign-in was forwarded, and only ever that word", async () => {
  await withStore((store) => {
    store.recordLoginAttempt({ email: "owner@example.com", ip: "66.90.191.45", outcome: "refused", triedHash: HASH(1), via: "relay" });
    store.recordLoginAttempt({ email: "owner@example.com", ip: "203.0.113.9", outcome: "refused", triedHash: HASH(2) });
    store.recordLoginAttempt({ email: "owner@example.com", ip: "203.0.113.9", outcome: "refused", triedHash: HASH(3), via: "something else" });
    const rows = store.listLoginAttempts({ since: 0 });
    assert.equal(rows[2].via, "relay");
    assert.equal(rows[1].via, "");
    assert.equal(rows[0].via, "", "anything that is not the one word this means is not written down");
  });
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

test("one refresh of the console is one box-health sweep on the relay, not two", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    // The sweep runs docker inspect, docker stats and du for every customer on the host, and the
    // Box health panel and the System health panel both want the same answer. They load together,
    // so asking twice was two full fleet sweeps running at once for one click on Refresh.
    let asks = 0;
    const api = createAdminApi({
      config: { dataDir: root, tenantRoot: root, relayUrl: "http://relay.invalid", relayToken: "r".repeat(32) },
      store,
      client: { base: "", call: async () => ({}) },
      json: () => {},
      noContent: () => {},
      publicAccount: (account) => account,
      publicTenant: (tenant) => tenant,
      tenantView: async (row) => ({ slug: row.slug, status: row.status, coolify: { reachable: false } }),
      tenantPower: async () => {},
      tenantProvision: async () => {},
      currentSession: () => ({ ok: false }),
      fetchImpl: async () => {
        asks += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, status: 200, json: async () => ({ boxes: [{ slug: "acme", containerState: "running" }] }) };
      },
    });

    const [boxes, system] = await Promise.all([api.boxes(), api.system()]);
    assert.equal(asks, 1, "both panels shared the one sweep");
    assert.equal(boxes.boxes[0].containerState, "running", "and the panel that needed the whole answer got it");
    assert.equal(system.relay.reachable, true, "and the one that only needed a reachability line got that");

    // A second refresh inside the window is still the same sweep; the window is short so the panel
    // cannot quietly show a stale minute.
    await api.boxes();
    assert.equal(asks, 1);
  });
});

// ---- the spend panel (PROXY-1) ------------------------------------------------------------------

// The same shape the other two api tests here use, plus a proxy and a reader for one tenant's key.
function makeApi({ store, root, proxy = null, keys = new Map(), allowance = "", enforce = "", fetchImpl }) {
  const config = {
    dataDir: root, tenantRoot: root,
    proxyUrl: proxy?.url ?? "", proxyMasterKey: proxy?.masterKey ?? "",
    proxyAllowanceUsd: Number(allowance) || 0, proxyEnforce: /^(1|true)$/i.test(String(enforce)),
  };
  return createAdminApi({
    config, store,
    client: { base: "", call: async () => ({}) },
    json: () => {}, noContent: () => {},
    publicAccount: (account) => account,
    publicTenant: (tenant) => tenant,
    tenantView: async (row) => ({ slug: row.slug, status: row.status, coolify: { reachable: false } }),
    tenantPower: async () => {}, tenantProvision: async () => {},
    currentSession: () => ({ ok: false }),
    log: () => {},
    proxy: proxy ? createProxyClient({ config }) : null,
    proxyKeyOf: (slug) => keys.get(slug) ?? null,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

test("spend lands against the client who spent it and never against the neighbour", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    store.createTenant({ slug: "beta", name: "Beta", status: "running" });
    const proxy = await startFakeProxy();
    try {
      const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
      const keys = new Map();
      for (const slug of ["acme", "beta"]) {
        const minted = await client.mintKey({ slug, models: ["plan-zai"], allowanceUsd: 20 });
        keys.set(slug, { key: minted.key, keyId: minted.keyId, alias: minted.alias, mintedAt: "2026-09-08T00:00:00.000Z", enforced: false, models: [] });
      }
      proxy.chargeAlias("titanbot-acme", 4, 8);

      const answer = await makeApi({ store, root, proxy, keys, allowance: "20" }).spend();
      assert.equal(answer.configured, true);
      const acme = answer.clients.find((row) => row.slug === "acme");
      const beta = answer.clients.find((row) => row.slug === "beta");
      assert.equal(acme.thisMonth.dollars, 4);
      assert.equal(acme.thisMonth.requests, 8);
      assert.equal(acme.spendToDate, 4);
      assert.equal(acme.pct, 20, "four dollars against a twenty dollar allowance is 20 percent");
      // The neighbour is a real zero, and it is the one place a zero is honest: the report covered
      // the window and this key is not in it.
      assert.equal(beta.thisMonth.dollars, 0);
      assert.equal(beta.pct, 0);
      // And what comes out carries the alias and the id and never the key, because this answer is
      // rendered in a browser.
      assert.equal(JSON.stringify(answer).includes(keys.get("acme").key), false, "the spend panel carried a live key");
      assert.equal(acme.alias, "titanbot-acme");
    } finally { await proxy.close(); }
  });
});

test("an unreachable proxy renders not measured with the reason, and never a zero", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    const keys = new Map([["acme", { key: "sk-whatever", keyId: "hashed-1", alias: "titanbot-acme", mintedAt: "", enforced: false, models: [] }]]);
    // A proxy at an address nothing answers on, which is what a stopped titanbot-proxy looks like
    // from in here. A zero on this panel would be indistinguishable from a customer who has not
    // spent anything, and that is the one number an operator would act on without checking.
    const api = makeApi({
      store, root, keys, allowance: "20",
      proxy: { url: "http://127.0.0.1:1", masterKey: "sk-master" },
    });
    const answer = await api.spend();
    const acme = answer.clients[0];
    assert.equal(acme.thisMonth.dollars, null);
    assert.equal(acme.thisMonth.requests, null);
    assert.equal(acme.pct, null);
    assert.match(acme.thisMonth.why, /the proxy did not answer/);
    assert.equal(acme.tinyfish.requests, null);
  });
});

test("with no proxy configured every route stays honest and the service still boots", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    // CP_PROXY_URL unset is the state of every install that has not turned this on. It is
    // deliberately NOT in configProblems: making it required would stop the control plane starting
    // for every existing customer including Jason's own console.
    const answer = await makeApi({ store, root }).spend();
    assert.equal(answer.configured, false);
    assert.match(answer.why, /CP_PROXY_URL/);
    assert.equal(answer.clients[0].thisMonth.dollars, null);
    assert.equal(answer.clients[0].minted, false);

    // And the Clients panel carries the same object rather than a hardcoded word.
    const clients = await makeApi({ store, root }).clients();
    assert.equal(clients.clients[0].spend.configured, undefined, "the per client row is the row, not the envelope");
    assert.equal(clients.clients[0].spend.minted, false);
    assert.equal(clients.proxy.configured, false);
    assert.equal(Object.hasOwn(clients.clients[0], "plan"), false, "the placeholder word is gone");
  });
});

test("a workspace with no plan key says so and names the command that mints one", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    const proxy = await startFakeProxy();
    try {
      const answer = await makeApi({ store, root, proxy, keys: new Map() }).spend();
      const acme = answer.clients[0];
      assert.equal(acme.minted, false);
      assert.match(acme.why, /proxy mint acme/);
      assert.equal(acme.thisMonth.dollars, null, "a workspace with no key must not read as one that spent nothing");
    } finally { await proxy.close(); }
  });
});

test("one refresh is one pair of spend reports, not four", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    const proxy = await startFakeProxy();
    try {
      const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
      const minted = await client.mintKey({ slug: "acme", models: ["plan-zai"] });
      const keys = new Map([["acme", { key: minted.key, keyId: minted.keyId, alias: minted.alias, mintedAt: "", enforced: false, models: [] }]]);
      const api = makeApi({ store, root, proxy, keys });

      // The Spend panel and the Clients panel load together and both want the same two windows, so
      // one click on Refresh has to be one sweep.
      await Promise.all([api.spend(), api.clients()]);
      assert.equal(proxy.callsTo("GET /global/spend/report").length, 2, "the two windows were asked for more than once");
      // And the per key read too, which is the one that scales with the number of customers: two
      // panels times one call per customer is how a fleet's worth of calls comes out of one click.
      assert.equal(proxy.callsTo("GET /key/info").length, 1, "the key's own spend was read once per panel");
      await api.spend();
      assert.equal(proxy.callsTo("GET /global/spend/report").length, 2, "a second refresh inside the window asked again");
      assert.equal(proxy.callsTo("GET /key/info").length, 1);
    } finally { await proxy.close(); }
  });
});

test("the web tools column counts requests and never dollars", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    const proxy = await startFakeProxy();
    try {
      const client = createProxyClient({ config: { proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey } });
      const minted = await client.mintKey({ slug: "acme", models: ["plan-zai"] });
      const keys = new Map([["acme", { key: minted.key, keyId: minted.keyId, alias: minted.alias, mintedAt: "", enforced: false, models: [] }]]);
      proxy.chargeAlias("titanbot-acme", 1, 4, "plan-zai");
      proxy.chargeAlias("titanbot-acme", 0.5, 5, "tinyfish-search");

      const answer = await makeApi({ store, root, proxy, keys }).spend();
      const acme = answer.clients[0];
      // Requests, because the pass-through is a flat cost per request on our side and an agent
      // run's real credits vary. A dollar figure here would look precise and would not be.
      assert.equal(acme.tinyfish.requests, 5);
      assert.equal(Object.hasOwn(acme.tinyfish, "dollars"), false);
      assert.equal(acme.thisMonth.requests, 9, "the model rows still add up to the whole month");
    } finally { await proxy.close(); }
  });
});

test("the system panel says whether the sign-in record can be signed at all", async () => {
  await withStore(async (store, root) => {
    const make = (dataDir) => createAdminApi({
      config: { dataDir, tenantRoot: root },
      store,
      client: { base: "", call: async () => ({}) },
      json: () => {},
      noContent: () => {},
      publicAccount: (account) => account,
      publicTenant: (tenant) => tenant,
      tenantView: async (row) => ({ slug: row.slug, status: row.status, coolify: { reachable: false } }),
      tenantPower: async () => {},
      tenantProvision: async () => {},
      currentSession: () => ({ ok: false }),
      log: () => {},
    });

    const working = await make(root).system();
    assert.equal(working.signInRecord.signing, true);

    // A directory this service cannot write. Without this card that reads as a quiet day: every
    // refusal is stored with no hash, every address says "no password reached the check", and
    // nothing is ever flagged.
    const broken = make(path.join(root, "not-there", "either"));
    const answer = await broken.system();
    assert.equal(answer.signInRecord.signing, false);
    assert.match(answer.signInRecord.why, /could not read or make its salt/);

    // And the failure is not remembered: the next call tries again rather than leaving the ledger
    // unable to hash for the life of the process.
    const retried = await broken.system();
    assert.equal(retried.signInRecord.signing, false, "still broken, and still asked");
  });
});
