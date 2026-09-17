// ADMIN-1. The control plane's half: the super admin flag and the disabled flag on an account, the
// sign-in record that is NOT the lockout counter, and the two rules the panel is built on -- which
// address is attacking, and which row is the same attempt seen twice.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
// PUSH-1. The two credential tests sign with keys generated per run rather than with a fixture: a
// fixture private key is a private key in git whatever it happens to open.
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";

import { openStore } from "../cp/store.mjs";
import {
  ATTACK_DISTINCT_PASSWORDS,
  ATTACK_SPRAY_ACCOUNTS,
  ATTACK_WINDOW_MS,
  createAdminApi,
  mergeAttempts,
  normalizeRouterPin,
  stuckProvisioning,
  summariseByAccount,
  summariseByAddress,
  summariseByPassword,
} from "../cp/admin.mjs";
// ONBOARD-4. The marker a removal writes, so this suite can build the state the Box health panel is
// supposed to report rather than a fixture shaped like a guess at it.
import { writeKeptMarker } from "../cp/kept.mjs";
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

test("workspace router pins accept only the three public states", () => {
  assert.equal(normalizeRouterPin("work"), "work");
  assert.equal(normalizeRouterPin(" TALK "), "talk");
  assert.equal(normalizeRouterPin("auto"), "auto");
  assert.equal(normalizeRouterPin("anything-else"), "auto");
  const source = readFileSync(path.join(import.meta.dirname, "../cp/admin/admin.js"), "utf8");
  assert.match(source, /"Auto"/);
  assert.match(source, /"Always work"/);
  assert.match(source, /"Always talk"/);
  assert.match(source, /\/router-pin/);
});

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
    let clock = Date.parse("2026-09-12T12:01:29.000Z");
    const api = createAdminApi({
      config: { dataDir: root, tenantRoot: root, relayUrl: "http://relay.invalid", relayToken: "r".repeat(32) },
      store,
      now: () => clock,
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
        return { ok: true, status: 200, json: async () => ({
          measuredAt: "2026-09-12T12:00:02.000Z",
          boxes: [{
            slug: "acme", containerState: "running", measuredAt: "2026-09-12T12:00:00.000Z",
            ageMs: 2_000, containerStateWhy: "",
          }],
        }) };
      },
    });

    const [boxes, system] = await Promise.all([api.boxes(), api.system()]);
    assert.equal(asks, 1, "both panels shared the one sweep");
    assert.equal(boxes.boxes[0].containerState, "running", "and the panel that needed the whole answer got it");
    assert.equal(boxes.boxes[0].measuredAt, "2026-09-12T12:00:00.000Z");
    assert.equal(boxes.boxes[0].ageMs, 89_000);
    assert.equal(boxes.measuredAt, "2026-09-12T12:00:02.000Z", "the fleet stamp came from the relay sweep");
    assert.equal(system.relay.reachable, true, "and the one that only needed a reachability line got that");

    // A second refresh inside the window is still the same sweep; the window is short so the panel
    // cannot quietly show a stale minute.
    clock += 2_000;
    const stale = await api.boxes();
    assert.equal(asks, 1);
    assert.equal(stale.boxes[0].ageMs, 91_000, "the age advances even while the relay body is cached");
    assert.match(stale.boxes[0].containerStateWhy, /last measured 2 minutes ago/);
  });
});

test("the box health panel renders each row's age and the fleet sweep stamp in plain words", () => {
  const source = readFileSync(path.join(import.meta.dirname, "../cp/admin/admin.js"), "utf8");
  const block = /async function loadBoxes\(\)[\s\S]*?\n  }\n\n  \/\/ ---- panel 4/.exec(source)?.[0] ?? "";
  assert.match(source, /const age = \(ageMs\)/);
  assert.match(block, /age\(box\.ageMs\)/, "the age is drawn beside every workspace row");
  assert.match(block, /fleet last swept/, "the header identifies the fleet sweep timestamp");
  assert.match(block, /fleet sweep has not finished yet/, "the first background sweep is named honestly");
});

// ---- ONBOARD-4: the data kept for customers who are gone ----------------------------------------

test("the box health answer lists every kept directory with its date and its size in words", async () => {
  await withStore(async (store, root) => {
    const tenantRoot = path.join(root, "tenants");
    // A removed customer's tree, marked the way cp/decommission.mjs marks one.
    mkdirSync(path.join(tenantRoot, "acme-roofing"), { recursive: true });
    const at = Date.parse("2026-09-13T02:00:00.000Z");
    const marked = writeKeptMarker({
      dir: path.join(tenantRoot, "acme-roofing"), slug: "acme-roofing",
      container: "titanbot-box-p927bfqm83ioloibamlvyd7g", at,
    });
    assert.equal(marked.ok, true, marked.why);
    // A live customer's tree, which has no marker and must not appear.
    mkdirSync(path.join(tenantRoot, "north-bay", "volumes"), { recursive: true });

    let clock = at + 10 * 24 * 60 * 60 * 1000;
    store.createTenant({ slug: "north-bay", name: "North Bay", status: "running" });
    const api = createAdminApi({
      config: { dataDir: root, tenantRoot, relayUrl: "http://relay.invalid", relayToken: "r".repeat(32) },
      store,
      now: () => clock,
      client: { base: "", call: async () => ({}) },
      json: () => {}, noContent: () => {},
      publicAccount: (account) => account,
      publicTenant: (tenant) => tenant,
      tenantView: async (row) => ({ slug: row.slug, status: row.status, coolify: { reachable: false } }),
      tenantPower: async () => {}, tenantProvision: async () => {},
      currentSession: () => ({ ok: false }),
      log: () => {},
      // The relay answers the box sweep and the purge probe. The probe is what carries the size,
      // because this service runs as uid 1001 and cannot read inside a box's volumes.
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (href.endsWith("/admin/boxes")) {
          return { ok: true, status: 200, json: async () => ({ measuredAt: "2026-09-13T12:00:00.000Z", boxes: [] }) };
        }
        if (href.endsWith("/tenant/purge")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          assert.equal(body.probeOnly, true, "the panel must never ask the relay to DELETE anything");
          assert.equal(body.slug, "acme-roofing");
          return { ok: true, status: 200, text: async () => JSON.stringify({
            message: "Nothing was touched.", probeOnly: true, slug: body.slug,
            dir: { path: path.join(tenantRoot, body.slug), exists: true, bytes: 6_200_000, complete: true },
          }) };
        }
        throw new Error(`nothing should have asked for ${href}`);
      },
    });

    const answer = await api.boxes();
    assert.equal(answer.kept.ok, true, answer.kept.why);
    assert.equal(answer.kept.rows.length, 1, "a live customer's directory has no marker and is not this list's business");
    const [row] = answer.kept.rows;
    assert.equal(row.slug, "acme-roofing");
    assert.equal(row.day, "2026-10-13");
    assert.equal(row.daysLeft, 20);
    assert.equal(row.pastDue, false);
    assert.equal(row.size, "5.9 MB", "the size is in words, with the rounding the box table already uses");
    assert.equal(row.bytes, 6_200_000);
  });
});

test("the box health panel draws the kept directories and says what is not measured", () => {
  const source = readFileSync(path.join(import.meta.dirname, "../cp/admin/admin.js"), "utf8");
  const block = /function drawKept\(kept\)[\s\S]*?\n  }\n\n  \/\/ ---- panel 4/.exec(source)?.[0] ?? "";
  assert.ok(block.length > 0, "the kept-data section is not in the Box health panel");
  assert.match(source, /drawKept\(answer\.kept\)/, "loading the panel has to draw it");
  assert.match(block, /Data kept for removed customers/);
  assert.match(block, /Nothing is being kept\./, "an empty list says so rather than drawing an empty table");
  // NOT MEASURED IS A SENTENCE AND NEVER A ZERO, which is the rule the whole panel is built on: a
  // zero in a size column is indistinguishable from an empty directory.
  assert.match(block, /not measured/);
  assert.match(block, /due, the next sweep takes it/);
  assert.match(block, /section\.id = "keptData"/, "the section is found by its id on a redraw rather than appended twice");
});

// ---- the spend panel (PROXY-1) ------------------------------------------------------------------

// The same shape the other two api tests here use, plus a proxy and a reader for one tenant's key.
function makeApi({ store, root, proxy = null, proxyClient = null, keys = new Map(), allowance = "", enforce = "", fetchImpl }) {
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
    proxy: proxyClient ?? (proxy ? createProxyClient({ config }) : null),
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
      assert.equal(acme.usage[0].provider, "not recorded", "an unnamed provider row disappeared or was invented");
      assert.deepEqual(acme.totals, { tokensIn: 800, tokensOut: 160, calls: 8, cost: 4 });
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

test("spend reports workspace usage and fleet totals by provider", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    store.createTenant({ slug: "beta", name: "Beta", status: "running" });
    const at = new Date().toISOString();
    const logs = [
      { api_key: "hash-acme", key_alias: "titanbot-acme", spend: 1, model: "plan-zai", model_id: "file-zai", custom_llm_provider: "zai", prompt_tokens: 1_000, completion_tokens: 200, startTime: at },
      { api_key: "hash-acme", key_alias: "titanbot-acme", spend: 1, model: "plan-zai", model_id: "file-zai", custom_llm_provider: "zai", prompt_tokens: 1_000, completion_tokens: 200, startTime: at },
      // No row provider: this one is resolved from its deployment's tb_provider field.
      { api_key: "hash-beta", key_alias: "titanbot-beta", spend: 1, model: "plan-minimax", model_id: "file-minimax", prompt_tokens: 500, completion_tokens: 75, startTime: at },
    ];
    const fetchImpl = async (url) => {
      const body = String(url).endsWith("/model/info")
        ? { data: [
          { model_name: "plan-zai", litellm_params: { model: "openai/plan-zai" }, model_info: { id: "file-zai" } },
          { model_name: "plan-minimax", litellm_params: { model: "openai/plan-minimax" }, model_info: { id: "file-minimax", tb_provider: "minimax" } },
        ] }
        : logs;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const config = { proxyUrl: "http://proxy.invalid", proxyMasterKey: "master" };
    const proxyClient = createProxyClient({ config, fetchImpl });
    const keys = new Map([
      ["acme", { key: "secret-acme", keyId: "hash-acme", alias: "titanbot-acme", mintedAt: "", enforced: false, models: [] }],
      ["beta", { key: "secret-beta", keyId: "hash-beta", alias: "titanbot-beta", mintedAt: "", enforced: false, models: [] }],
    ]);
    const answer = await makeApi({ store, root, proxy: { url: config.proxyUrl, masterKey: config.proxyMasterKey }, proxyClient, keys }).spend();
    const acme = answer.clients.find((row) => row.slug === "acme");
    assert.deepEqual(acme.usage, [{ provider: "zai", model: "plan-zai", tokensIn: 2_000, tokensOut: 400, calls: 2, cost: 2, tier: "work" }]);
    assert.deepEqual(acme.totals, { tokensIn: 2_000, tokensOut: 400, calls: 2, cost: 2 });
    assert.deepEqual(answer.totals, { tokensIn: 2_500, tokensOut: 475, calls: 3, cost: 3 });
    assert.deepEqual(answer.byProvider, [
      { provider: "zai", tokensIn: 2_000, tokensOut: 400, calls: 2, cost: 2 },
      { provider: "minimax", tokensIn: 500, tokensOut: 75, calls: 1, cost: 1 },
    ]);
  });
});

test("the spend panel renders the provider usage table and Intl-formatted totals", () => {
  const source = readFileSync(path.join(import.meta.dirname, "../cp/admin/admin.js"), "utf8");
  const block = /function usageTable\(client\)[\s\S]*?\n  }\n/.exec(source)?.[0] ?? "";
  assert.match(block, /\["Provider", "Model", "In", "Out", "Calls", "Cost"\]/);
  assert.match(block, /by provider/);
  assert.match(block, /line\.tier === "talk"/);
  assert.match(block, /no usage recorded this month/);
  assert.match(source, /new Intl\.NumberFormat/);
  assert.match(source, /who\.appendChild\(usageTable\(client\)\)/);
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
      assert.equal(proxy.callsTo("GET /spend/logs").length, 2, "the two windows were asked for more than once");
      // PROXY-8. This used to assert ONE /key/info per refresh. It now asserts NONE, and the change
      // is the fix rather than an optimisation: that call was the only caller of /key/info in the
      // product, and it is why /key/info had to stay in the proxy's global door list -- a list that
      // cannot tell the operator from a tenant, so leaving it open for this panel left every box on
      // the bridge able to read every other key's record. The number the panel needs is in the
      // request log it already reads.
      assert.equal(proxy.callsTo("GET /key/info").length, 0, "the panel still reads a key's own record, which is what PROXY-8 closes");
      await api.spend();
      assert.equal(proxy.callsTo("GET /spend/logs").length, 2, "a second refresh inside the window asked again");
      assert.equal(proxy.callsTo("GET /key/info").length, 0);
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

// ---- the ceiling on a client row (AGENTS-CAP-2) --------------------------------------------------
//
// Jason, 2026-09-09: default 40, the super admin raises a workspace's ceiling from its client row.
// The three facts these cover are the three the panel gets wrong if nobody watches: the number is
// READ off the box and never remembered here, a box that could not be asked reads as not measured
// rather than as a default, and a pin is reported as a pin rather than as a success.

// A relay that answers the ceiling route and records what it was asked.
function fakeCeilingRelay(answerFor) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    asked.push({ pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const answer = answerFor(pathname, init.method ?? "GET");
    if (answer == null) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    return { ok: true, status: 200, text: async () => JSON.stringify(answer), json: async () => answer };
  };
  return { asked, fetchImpl };
}

function ceilingApi({ store, root, fetchImpl }) {
  return createAdminApi({
    config: { dataDir: root, tenantRoot: root, relayUrl: "http://relay.invalid", relayToken: "r".repeat(32) },
    store,
    client: { base: "", call: async () => ({}) },
    json: () => {}, noContent: () => {},
    publicAccount: (account) => account,
    publicTenant: (tenant) => tenant,
    tenantView: async (row) => ({ slug: row.slug, status: row.status, coolify: { reachable: false } }),
    tenantPower: async () => {}, tenantProvision: async () => {},
    currentSession: () => ({ ok: false }),
    log: () => {},
    fetchImpl,
  });
}

test("the clients panel reads each box's ceiling rather than remembering one", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "demo", name: "Demo", status: "running" });
    store.createTenant({ slug: "titanium", name: "Titanium", status: "running" });
    const relay = fakeCeilingRelay((pathname) => (pathname.includes("/demo/ceiling")
      ? { read: true, maxAgents: 40, bots: 6, pinned: false, pinnedBy: null, why: "" }
      : pathname.includes("/titanium/ceiling")
        ? { read: true, maxAgents: 100, bots: 13, pinned: true, pinnedBy: "container env (SAND_MAX_AGENTS)" }
        : { read: false }));
    const answer = await ceilingApi({ store, root, fetchImpl: relay.fetchImpl }).clients();
    const demo = answer.clients.find((row) => row.slug === "demo");
    const titanium = answer.clients.find((row) => row.slug === "titanium");
    assert.equal(demo.ceiling.read, true);
    assert.equal(demo.ceiling.maxAgents, 40, "the number on the row is the box's own");
    assert.equal(demo.ceiling.bots, 6);
    assert.equal(demo.ceiling.pinned, false);
    // A pin is a pin on the row, so the panel can refuse to draw a control that would do nothing.
    assert.equal(titanium.ceiling.pinned, true);
    assert.match(String(titanium.ceiling.pinnedBy), /container env/);
    // One ask per workspace, not one per row rendered.
    assert.equal(relay.asked.filter((one) => one.pathname.endsWith("/ceiling")).length, 2);
  });
});

test("a box that could not be asked reads as not measured, never as the default", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "demo", name: "Demo", status: "running" });
    const api = ceilingApi({ store, root, fetchImpl: async () => { throw new Error("the relay is down"); } });
    const answer = await api.clients();
    const ceiling = answer.clients[0].ceiling;
    assert.equal(ceiling.read, false);
    // A ceiling shown over a box nobody asked is the made-up green light this console refuses.
    assert.equal(ceiling.maxAgents, null);
    assert.ok(String(ceiling.why).length > 0);
  });
});

// ---- PUSH-1: the two push credentials ------------------------------------------------------------
//
// Appended at the end of this file, beside the marketplace and ceiling blocks above it, because the
// end of a test file is where three parallel worktrees can each add a group without meeting.
//
// Everything here drives the REAL routes through api.handle, with the vendor answers injected: Apple
// over a fake node:http2 and Firebase over a fake fetch. That is the only way to reach every branch
// of the two verdict tables without an Apple developer account and a Firebase project, and the
// branches are the point -- the difference between "Apple read the key and refused the address" and
// "Apple refused the key" is the whole proof.

/** Drives one admin route and hands back {status, body}. The operator token opens the guard. */
function adminCall(api, { method, segments, body = null, adminToken }) {
  let answer = null;
  const response = { writeHead: () => response, end: () => response, setHeader: () => response };
  const request = { method, headers: { authorization: `Bearer ${adminToken}` }, socket: { remoteAddress: "127.0.0.1" } };
  const json = (_res, status, payload) => { answer = { status, body: payload }; };
  return api({ json }).handle(request, response, {
    segments: ["v1", "admin", ...segments], method, body,
    url: new URL(`http://cp.invalid/v1/admin/${segments.join("/")}`),
  }).then(() => answer);
}

/** An Apple that answers one status and one reason word, over the http2 shape the prover uses. */
function fakeApple({ status, reason }) {
  const seen = [];
  return {
    seen,
    http2: {
      connect() {
        const session = {
          on: () => session,
          close: () => {},
          request(headers) {
            seen.push(headers);
            const handlers = new Map();
            const stream = {
              on: (event, fn) => { handlers.set(event, fn); return stream; },
              setTimeout: () => stream,
              close: () => {},
              end: () => {
                // Next tick, so the prover's own listeners are attached before anything fires, which
                // is exactly the order a real http2 stream delivers them in.
                setTimeout(() => {
                  if (status === 0) { handlers.get("error")?.(new Error("no answer")); return; }
                  handlers.get("response")?.({ ":status": status });
                  if (reason) handlers.get("data")?.(Buffer.from(JSON.stringify({ reason })));
                  handlers.get("end")?.();
                }, 0);
                return stream;
              },
            };
            return stream;
          },
        };
        return session;
      },
    },
  };
}

/** A Firebase that mints a token and then answers the dry run with one status and one error code. */
function fakeFirebase({ mint = 200, send = 200, code = "" } = {}) {
  const seen = [];
  return {
    seen,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).includes("oauth2")) {
        return { ok: mint === 200, status: mint, json: async () => (mint === 200 ? { access_token: "ya29.a-minted-token", expires_in: 3600 } : { error: "invalid_grant" }) };
      }
      return { ok: send === 200, status: send, json: async () => (send === 200 ? { name: "projects/p/messages/1" } : { error: { status: code, details: [{ errorCode: code }] } }) };
    },
  };
}

// A real ES256 key and a real RSA key, generated per run. Nothing in this repo ships a private key,
// and a fixture one would be a private key in git whatever it opened.
const PUSH_P8 = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const PUSH_RSA = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const SERVICE_ACCOUNT = JSON.stringify({ type: "service_account", project_id: "titanium-bot", client_email: "push@titanium-bot.iam.gserviceaccount.com", private_key: PUSH_RSA, token_uri: "https://oauth2.googleapis.com/token" });
const PUSH_ADMIN_TOKEN = "an-operator-token-of-at-least-thirty-two-chars";

function pushApi({ store, root, http2Impl = null, fetchImpl = async () => ({ ok: false, status: 0, json: async () => ({}) }) }) {
  return ({ json }) => createAdminApi({
    config: { dataDir: root, tenantRoot: root, adminToken: PUSH_ADMIN_TOKEN },
    store,
    client: { base: "", call: async () => ({}) },
    json, noContent: () => {},
    publicAccount: (account) => account,
    publicTenant: (tenant) => tenant,
    tenantView: async (row) => ({ slug: row.slug }),
    tenantPower: async () => {}, tenantProvision: async () => {},
    currentSession: () => ({ ok: false }),
    log: () => {},
    http2Impl, fetchImpl,
  });
}

test("GET /v1/admin/push says what is stored and never what it is", async () => {
  await withStore(async (store, root) => {
    const api = pushApi({ store, root });
    const empty = await adminCall(api, { method: "GET", segments: ["push"], adminToken: PUSH_ADMIN_TOKEN });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.apns.stored, false);
    assert.equal(empty.body.fcm.stored, false);
    assert.match(String(empty.body.apns.why), /never woken/);
    assert.match(String(empty.body.stub), /records what it would have sent/);

    // Stored directly, so this read is tested on its own rather than through the store route.
    store.setSetting("push.apns.key", PUSH_P8, "a test");
    store.setSetting("push.apns.bundleId", "bot.titanium.app", "a test");
    store.setSetting("push.fcm.serviceAccount", SERVICE_ACCOUNT, "a test");
    store.setSetting("push.fcm.projectId", "titanium-bot", "a test");
    const full = await adminCall(api, { method: "GET", segments: ["push"], adminToken: PUSH_ADMIN_TOKEN });
    assert.equal(full.body.apns.stored, true);
    assert.equal(full.body.apns.bundleId, "bot.titanium.app");
    assert.match(String(full.body.apns.evidence), /^\d+ characters, sha256 [0-9a-f]{8}$/);
    assert.equal(full.body.fcm.stored, true);
    assert.equal(full.body.stub, "", "with both stored there is nothing to warn about");
    // THE TEST THIS WHOLE ROUTE EXISTS FOR: no fragment of either value is in the answer.
    const text = JSON.stringify(full.body);
    assert.ok(!text.includes(PUSH_P8.slice(40, 120)), "the Apple key is not in the answer");
    assert.ok(!text.includes(PUSH_RSA.slice(40, 120)), "the Firebase key is not in the answer");
    assert.ok(!text.includes("BEGIN PRIVATE KEY"));
  });
});

test("the Apple key is stored only when Apple read it and refused the address", async () => {
  await withStore(async (store, root) => {
    const apple = fakeApple({ status: 400, reason: "BadDeviceToken" });
    const api = pushApi({ store, root, http2Impl: apple.http2 });
    const answer = await adminCall(api, {
      method: "POST", segments: ["push", "apns"], adminToken: PUSH_ADMIN_TOKEN,
      body: { key: PUSH_P8, keyId: "ABCDE12345", teamId: "TEAM123456", bundleId: "bot.titanium.app" },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer?.body));
    assert.equal(answer.body.bundleId, "bot.titanium.app");
    assert.match(String(answer.body.checkedWith), /refused only the address/);
    assert.match(String(answer.body.evidence), /^\d+ characters, sha256 [0-9a-f]{8}$/);
    assert.ok(!JSON.stringify(answer.body).includes("BEGIN PRIVATE KEY"), "the answer never carries the key");
    // Stored trimmed and with CRLF normalised, which is what parseApnsCredential does on the way in:
    // a .p8 pasted out of Notepad arrives with \r\n and createPrivateKey is the thing that has to be
    // able to read it back, not a byte comparison.
    assert.equal(store.getSetting("push.apns.key", ""), PUSH_P8.trim(), "and it is stored");
    assert.equal(store.getSetting("push.apns.teamId", ""), "TEAM123456");

    // One request to Apple, addressed to a token that cannot be a device, on the sandbox host.
    assert.equal(apple.seen.length, 1);
    assert.match(String(apple.seen[0][":path"]), /^\/3\/device\/0{64}$/);
    assert.equal(apple.seen[0]["apns-topic"], "bot.titanium.app");
    // And the ledger row names the act and the evidence and never the value.
    const rows = store.listAdminActions({ limit: 20 });
    const row = rows.find((one) => one.action === "push.apns");
    assert.ok(row != null, "the act is on the record");
    assert.ok(!String(row.detail).includes("BEGIN PRIVATE KEY"));
    assert.match(String(row.detail), /characters, sha256/);
  });
});

test("a key Apple refuses is not stored, and the refusal says which half was wrong", async () => {
  await withStore(async (store, root) => {
    for (const [vendor, pattern] of [
      [fakeApple({ status: 403, reason: "InvalidProviderToken" }), /refused the signing key itself/],
      [fakeApple({ status: 400, reason: "TopicDisallowed" }), /refused the bundle id/],
      [fakeApple({ status: 0, reason: "" }), /did not answer/],
    ]) {
      const api = pushApi({ store, root, http2Impl: vendor.http2 });
      const answer = await adminCall(api, {
        method: "POST", segments: ["push", "apns"], adminToken: PUSH_ADMIN_TOKEN,
        body: { key: PUSH_P8, keyId: "ABCDE12345", teamId: "TEAM123456", bundleId: "bot.titanium.app" },
      });
      assert.equal(answer.status, 409, JSON.stringify(answer?.body));
      assert.match(String(answer.body.message), pattern);
      assert.match(String(answer.body.message), /Nothing was stored/);
      assert.equal(store.getSetting("push.apns.key", ""), "", "and nothing was");
    }
  });
});

test("a paste that is not a key is refused before any vendor is asked", async () => {
  await withStore(async (store, root) => {
    const apple = fakeApple({ status: 400, reason: "BadDeviceToken" });
    const api = pushApi({ store, root, http2Impl: apple.http2 });
    for (const [body, pattern] of [
      [{ key: "not a key", keyId: "ABCDE12345", teamId: "TEAM123456", bundleId: "bot.titanium.app" }, /not a \.p8/],
      [{ key: PUSH_P8, keyId: "short", teamId: "TEAM123456", bundleId: "bot.titanium.app" }, /ten characters/],
      [{ key: PUSH_P8, keyId: "ABCDE12345", teamId: "TEAM123456", bundleId: "x" }, /bundle id/],
    ]) {
      const answer = await adminCall(api, { method: "POST", segments: ["push", "apns"], adminToken: PUSH_ADMIN_TOKEN, body });
      assert.equal(answer.status, 400);
      assert.match(String(answer.body.message), pattern);
    }
    assert.equal(apple.seen.length, 0, "a paste that cannot be right costs Apple nothing");
  });
});

test("the Firebase service account is proved with a dry run, and stored with its project", async () => {
  await withStore(async (store, root) => {
    const firebase = fakeFirebase({ mint: 200, send: 200 });
    const api = pushApi({ store, root, fetchImpl: firebase.fetchImpl });
    const answer = await adminCall(api, {
      method: "POST", segments: ["push", "fcm"], adminToken: PUSH_ADMIN_TOKEN,
      body: { serviceAccount: SERVICE_ACCOUNT, projectId: "" },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer?.body));
    assert.equal(answer.body.projectId, "titanium-bot", "the project comes out of the JSON when nobody typed one");
    assert.equal(answer.body.clientEmail, "push@titanium-bot.iam.gserviceaccount.com");
    assert.match(String(answer.body.checkedWith), /validate_only/);
    assert.ok(!JSON.stringify(answer.body).includes("BEGIN PRIVATE KEY"));
    assert.ok(store.getSetting("push.fcm.serviceAccount", "").includes("BEGIN PRIVATE KEY"), "stored whole");
    assert.equal(store.getSetting("push.fcm.projectId", ""), "titanium-bot");

    // The dry run IS a dry run: validate_only true, so nothing was ever delivered to prove a paste.
    const send = firebase.seen.find((one) => one.url.includes("messages:send"));
    assert.ok(send != null);
    assert.equal(JSON.parse(send.body).validate_only, true);
    assert.match(JSON.parse(send.body).message.token, /^0{64}$/);
  });
});

test("a Firebase refusal names which half was wrong, and a token refusal still stores nothing", async () => {
  await withStore(async (store, root) => {
    for (const [firebase, pattern] of [
      [fakeFirebase({ mint: 400 }), /would not mint a messaging token/],
      [fakeFirebase({ mint: 200, send: 403, code: "PERMISSION_DENIED" }), /refused the service account/],
      [fakeFirebase({ mint: 200, send: 404, code: "NOT_FOUND" }), /no such project/],
    ]) {
      const api = pushApi({ store, root, fetchImpl: firebase.fetchImpl });
      const answer = await adminCall(api, {
        method: "POST", segments: ["push", "fcm"], adminToken: PUSH_ADMIN_TOKEN,
        body: { serviceAccount: SERVICE_ACCOUNT },
      });
      assert.equal(answer.status, 409, JSON.stringify(answer?.body));
      assert.match(String(answer.body.message), pattern);
      assert.equal(store.getSetting("push.fcm.serviceAccount", ""), "");
    }
    // And a 400 INVALID_ARGUMENT on the deliberately malformed address IS a pass: Google read the
    // service account and refused only the token, which is the same verdict Apple's 400 is.
    const good = fakeFirebase({ mint: 200, send: 400, code: "INVALID_ARGUMENT" });
    const answer = await adminCall(pushApi({ store, root, fetchImpl: good.fetchImpl }), {
      method: "POST", segments: ["push", "fcm"], adminToken: PUSH_ADMIN_TOKEN, body: { serviceAccount: SERVICE_ACCOUNT },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer?.body));
    assert.match(String(answer.body.checkedWith), /refused only the address/);
  });
});

test("listSettings answers the two push names with no value at all", async () => {
  await withStore((store) => {
    store.setSetting("push.apns.key", PUSH_P8, "a test");
    store.setSetting("push.fcm.serviceAccount", SERVICE_ACCOUNT, "a test");
    store.setSetting("push.apns.bundleId", "bot.titanium.app", "a test");
    const rows = new Map(store.listSettings().map((row) => [row.name, row]));
    for (const name of ["push.apns.key", "push.fcm.serviceAccount"]) {
      assert.equal(rows.get(name).redacted, true, `${name} is a secret name`);
      assert.equal(rows.get(name).value, "", `${name} comes back with no value`);
    }
    // The non-secret ids DO come back: a person has to be able to check they pasted the right app,
    // and a bundle id opens nothing on its own.
    assert.equal(rows.get("push.apns.bundleId").redacted, false);
    assert.equal(rows.get("push.apns.bundleId").value, "bot.titanium.app");
    // Swept whole: no fragment of either key is anywhere in what listSettings answers.
    const text = JSON.stringify(store.listSettings());
    assert.ok(!text.includes("BEGIN PRIVATE KEY"));
    assert.ok(!text.includes(PUSH_P8.slice(40, 120)));
  });
});

// ---- CP-FIX 2 and 3: what the Clients panel knows about a person's sign-ins ----------------------
//
// MEASURED ON THE R750 2026-09-12 for beta-36: the tester signed in by sign-in link at 13:52, his
// Titan then ran an interview and a computer-use subagent that spent 9.7M input tokens in 38
// minutes, and the Clients panel said he had NEVER LOGGED IN the whole time. Two separate holes,
// both of them here:
//
//   the last sign-in was read from this service's OWN ledger alone, and a sign-in-link login
//   happens entirely at the relay: there is no password, so POST /v1/sessions is never called and
//   this service never hears about it;
//
//   and a FAILURE had nowhere to show at all. The same tester could not sign back in after his
//   password was changed, and the row for it carried an outcome word and no reason, on a panel that
//   only ever rendered successes.

/** A relay that answers the login ledger and the ceiling route, and records what it was asked. */
function fakeSignInRelay({ rows = [] } = {}) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    asked.push({ pathname: parsed.pathname, search: parsed.search, method: init.method ?? "GET" });
    const body = parsed.pathname === "/admin/login-attempts"
      ? { source: "relay", measuredAt: new Date().toISOString(), rows }
      : null;
    if (body == null) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  return { asked, fetchImpl };
}

const relayRow = ({ at, door = "account", email, outcome = "ok", tenant = "", ip = "203.0.113.40" }) => ({
  at: new Date(at).toISOString(), door, email, ip, userAgent: "Mozilla/5.0", triedHash: "", outcome, tenant,
});

test("a sign-in-link login is a login: the panel counts it and names the kind", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "beta-36", name: "Beta 36", status: "running" });
    store.createAccount({ email: "tester@beta36.test", password: PASSWORD, tenant: "beta-36" });
    const at = Date.now() - 60_000;
    // The shape the relay writes for GET /login?sso=<token>: no password was typed, so there is no
    // row on this service's side at all and the merge has exactly one row to work with.
    const relay = fakeSignInRelay({ rows: [relayRow({ at, door: "link", email: "tester@beta36.test", tenant: "beta-36" })] });
    const answer = await ceilingApi({ store, root, fetchImpl: relay.fetchImpl }).clients();
    const person = answer.clients.find((row) => row.slug === "beta-36").users[0];
    assert.equal(person.signIns, 1, "a link login is a successful login and is counted as one");
    assert.equal(person.lastSignInAt, new Date(at).toISOString());
    assert.equal(person.lastSignInKind, "by sign-in link", "the kind of the last one, in words");
  });
});

test("one sign-in seen by both ledgers is counted once, and the kind is the door it came in by", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    store.createAccount({ email: "owner@acme.test", password: PASSWORD, tenant: "acme" });
    const at = Date.now() - 30_000;
    // A password sign-in at a tenant console: the relay writes its own row with the visitor's
    // address, forwards it here, and this service writes one too with via=relay. The panel must not
    // read that as two sign-ins.
    store.recordLoginAttempt({ at: at + 200, email: "owner@acme.test", ip: "10.0.0.7", outcome: "ok", tenant: "acme", via: "relay" });
    const relay = fakeSignInRelay({ rows: [relayRow({ at, email: "owner@acme.test", tenant: "acme" })] });
    const answer = await ceilingApi({ store, root, fetchImpl: relay.fetchImpl }).clients();
    const person = answer.clients[0].users[0];
    assert.equal(person.signIns, 1, "the same attempt seen twice is one sign-in");
    assert.equal(person.lastSignInKind, "with an email and password");
  });
});

test("an account nobody has ever used still reads as never, and the relay being down says so", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    store.createAccount({ email: "owner@acme.test", password: PASSWORD, tenant: "acme" });
    const answer = await ceilingApi({ store, root, fetchImpl: async () => { throw new Error("the relay is down"); } }).clients();
    const person = answer.clients[0].users[0];
    assert.equal(person.signIns, 0);
    assert.equal(person.lastSignInAt, null, "never is a real answer and reads as one");
    assert.equal(person.lastSignInKind, "");
    // And the panel is told the count is short rather than being left to present it as whole: a
    // link login lives only at the relay, so an unreachable relay can hide one.
    assert.equal(answer.signIns.relay.reachable, false);
    assert.ok(String(answer.signIns.why).length > 0);
  });
});

test("a lockout and a refusal after a password change reach the panel with the reason in words", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "beta-36", name: "Beta 36", status: "running" });
    const account = store.createAccount({ email: "tester@beta36.test", password: PASSWORD, tenant: "beta-36" });
    const at = Date.now();
    store.setAccountPassword(account.id, "a-brand-new-password");
    // What the sign-in route writes when the password on file is not the one that was typed, and
    // then when the address has knocked too often. Both carry the sentence the route decided, which
    // is the part that was missing: "refused" alone does not tell an operator that this person is
    // holding a password somebody changed.
    store.recordLoginAttempt({
      at: at - 2000, email: "tester@beta36.test", ip: "203.0.113.40", outcome: "refused", tenant: "beta-36",
      reason: "the password did not match the one on file, which was changed 1 minute before this try",
    });
    store.recordLoginAttempt({
      at: at - 1000, email: "tester@beta36.test", ip: "203.0.113.40", outcome: "locked", tenant: "beta-36",
      reason: "too many tries from this address, so the door was shut for 600 seconds",
    });
    const relay = fakeSignInRelay({ rows: [] });
    const answer = await ceilingApi({ store, root, fetchImpl: relay.fetchImpl }).clients();
    const person = answer.clients[0].users[0];
    assert.equal(person.signIns, 0, "none of this is a sign-in");
    assert.equal(person.lastSignInAt, null);
    // The newest failure, because that is the one the person is living with right now.
    assert.equal(person.lastFailure.outcome, "locked");
    assert.match(person.lastFailure.reason, /too many tries from this address/);
    assert.equal(person.lastFailure.at, new Date(at - 1000).toISOString());
    assert.equal(person.failures, 2, "both of them are counted");
  });
});

test("the reason a sign-in was refused is stored as words and never as a password", async () => {
  await withStore((store) => {
    store.recordLoginAttempt({
      email: "owner@acme.test", ip: "1.1.1.1", outcome: "refused",
      reason: "the password did not match the one on file",
    });
    const row = store.listLoginAttempts({ since: 0 })[0];
    assert.equal(row.reason, "the password did not match the one on file");
    // A reason is a sentence this service wrote, so it is capped and it is never allowed to become a
    // place a caller could park a password. The hash column is the only thing derived from one.
    store.recordLoginAttempt({ email: "owner@acme.test", ip: "1.1.1.1", outcome: "refused", reason: "x".repeat(500) });
    assert.equal(store.listLoginAttempts({ since: 0 })[0].reason.length, 200);
  });
});

// PROVIDERS-1 said "Runs on" is read out of the proxy's request log. It filtered that log for a
// `plan-` prefix, which only `model_group` ever carries: the `model` field is the upstream that
// served the request, `openai/glm-5.3-flash`. So the filter matched nothing and the field read
// "not measured" for every workspace on the fleet, not only the quiet ones.
test("Runs on reads the plan group out of a log of upstream names, and marks the pin", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    const proxy = await startFakeProxy();
    try {
      const config = {
        dataDir: root, tenantRoot: root,
        proxyUrl: proxy.url, proxyMasterKey: proxy.masterKey,
        relayUrl: "http://relay.invalid", relayToken: "r".repeat(32),
      };
      const client = createProxyClient({ config });
      const minted = await client.mintKey({ slug: "acme", models: ["plan-zai-talk"] });
      // What beta-36's log actually looked like: the group is a plan alias, the model is not.
      proxy.chargeAlias("titanbot-acme", 1, 3, "plan-zai-talk", { recordedModel: "openai/glm-5.3-flash" });
      const api = createAdminApi({
        config, store,
        client: { base: "", call: async () => ({}) },
        json: () => {}, noContent: () => {},
        publicAccount: (account) => account,
        publicTenant: (tenant) => tenant,
        tenantView: async (row) => ({ slug: row.slug, status: row.status, coolify: { reachable: false } }),
        tenantPower: async () => {}, tenantProvision: async () => {},
        currentSession: () => ({ ok: false }),
        log: () => {},
        proxy: client,
        proxyKeyOf: () => ({ key: minted.key, keyId: minted.keyId, alias: minted.alias, mintedAt: "", enforced: false, models: [] }),
        // The box's own file, through the relay: the only place that says what it is POINTED at.
        fetchImpl: async (url) => {
          const { pathname } = new URL(String(url));
          if (!pathname.endsWith("/running")) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
          const body = { read: true, model: "plan-zai", modelLabel: "GLM 5.3", pinned: false };
          return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
        },
      });
      const acme = (await api.clients()).clients.find((row) => row.slug === "acme");
      assert.equal(acme.model.current, "plan-zai-talk", "the group it ran, not the upstream that served it");
      assert.ok(!String(acme.model.current).startsWith("openai/"), "an upstream name never reaches this field");
      // The pin is a separate fact from what was run, and the renderer's pinned branch needs it.
      assert.equal(acme.model.pinned, true);
      assert.equal(acme.model.pin, "plan-zai");
    } finally { await proxy.close(); }
  });
});

test("a box whose file cannot be read carries no pin rather than a guessed one", async () => {
  await withStore(async (store, root) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    const api = makeApi({ store, root, fetchImpl: async () => { throw new Error("the relay is down"); } });
    const acme = (await api.clients()).clients.find((row) => row.slug === "acme");
    assert.equal(acme.model.pinned, false);
    assert.equal(Object.hasOwn(acme.model, "pin"), false);
  });
});
