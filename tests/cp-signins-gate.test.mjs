// SIGNIN-1. This operator's own verification gates, told apart from strangers -- and, since the
// review of 2026-09-09, told apart WITHOUT taking anything out of the attack maths.
//
// Jason, 2026-09-09 11:43, over two screenshots of the Sign-in attempts panel: 147.136.44.142
// marked "Attack", 101 tries, 58 locked out, 23 different passwords, and one of the accounts named
// was his own. Every number on that screen was right. The one thing it got wrong was who: every
// burst was scripts/verify-deploy.mjs steps 3 and 8, two wrong instance passwords refused and then
// seven more until the throttle answers, run from this Mac behind his home address, one burst per
// wave ship since 2026-09-05.
//
// The first shape of the fix labelled those rows and then subtracted them from the counts, on two
// facts: the user agent said titanbot-gate, AND the address had a successful operator sign-in
// inside the hour. That second half was called the part an outsider cannot fake. IT IS NOT.
// MEASURED ON THIS MAC 2026-09-09: eight refusals with eight distinct passwords from one address,
// with one operator sign-in from that address earlier in the hour, read attack=true with a plain
// agent and attack=FALSE with the header on the identical rows. Anyone behind the same office NAT,
// VPN egress or compromised laptop as an operator who signed in that hour could turn the pill off
// by writing a string.
//
// So the label no longer subtracts. It greys the row, names the script, and puts a count beside the
// number. Every case below is one of the ways that could go wrong.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";

import { openStore } from "../cp/store.mjs";
import {
  ATTACK_DISTINCT_PASSWORDS,
  GATE_AGENT_PREFIX,
  GATE_LABEL_BEFORE,
  createAdminApi,
  markGateRows,
  summariseByAccount,
  summariseByAddress,
  summariseByPassword,
} from "../cp/admin.mjs";
import { makeTempRoot } from "./cp-support.mjs";

const HASH = (seed) => createHash("sha256").update(`password-${seed}`).digest("hex");
const MINE = "147.136.44.142";
const STRANGER = "198.51.100.31";
const OPERATOR_TOKEN = "operator-token-for-a-test";

// Well before GATE_LABEL_BEFORE, so the retroactive clause is reachable, and inside one hour of
// each other so the operator test can hold.
const OLD = Date.parse("2026-09-08T22:40:00.000Z");
const at = (offsetMs) => new Date(OLD + offsetMs).toISOString();

/** The shape the relay writes: a door, an outcome, an agent, and a keyed hash of what was tried. */
const row = (extra) => ({
  at: at(0), door: "instance", email: "", ip: MINE, userAgent: "node",
  outcome: "refused", triedHash: HASH(1), source: "relay", ...extra,
});

/** The operator getting in. */
const operatorIn = (ip = MINE, offsetMs = 0) => row({
  at: at(offsetMs), outcome: "ok", triedHash: "", userAgent: "Mozilla/5.0",
  ip,
});

/** Nine wrong instance passwords in a burst, the way the deploy gate's login and lockout legs run. */
function gateBurst({ ip = MINE, agent = `${GATE_AGENT_PREFIX}verify-deploy`, start = 60_000 } = {}) {
  const rows = [];
  for (let index = 0; index < 9; index += 1) {
    rows.push(row({
      at: at(start + index * 4_000),
      ip,
      userAgent: agent,
      outcome: index < 5 ? "refused" : "locked",
      triedHash: HASH(100 + index),
    }));
  }
  return rows;
}

test("a gate's own burst is named and greyed, and every row of it is still counted", () => {
  const rows = [operatorIn(), ...gateBurst()];
  const gates = markGateRows(rows, { isOperatorAccount: () => false });

  assert.equal(gates.rows, 9);
  assert.equal(gates.named, 9, "the header clause is what matched, and the answer says so");
  assert.equal(gates.older, 0);
  assert.deepEqual(gates.scripts, ["verify-deploy"]);
  assert.match(gates.setAsideNote, /verify-deploy/);
  assert.match(gates.setAsideNote, /NOT taken out of the counts/);
  assert.equal(gates.yourAddresses.has(MINE), true);

  // THE ROWS ARE STILL THERE, and they are still in the numbers.
  assert.equal(rows.length, 10);
  assert.equal(rows.filter((one) => one.gate === true).length, 9);
  assert.equal(rows.find((one) => one.gate === true).gateScript, "verify-deploy");
  assert.equal(rows.find((one) => one.gate === true).gateWhy, "named");

  const [summary] = summariseByAddress(rows, { yourAddresses: gates.yourAddresses });
  assert.equal(summary.ip, MINE);
  assert.equal(summary.gateRows, 9, "the panel is told how many of these said they were a gate");
  assert.equal(summary.yourAddress, true);
  assert.equal(summary.attempts, 10, "a labelled row left the attempt count");
  assert.equal(summary.ok, 1);
  assert.equal(summary.distinctPasswords, 9, "the gate's nine passwords stopped being counted");
  assert.equal(summary.attack, true, "nine different passwords in four minutes stopped reading as one");
  assert.equal(summary.lastAt, at(60_000 + 8 * 4_000));
});

test("the label cannot be used to turn the Attack pill off from outside", () => {
  // THE MEASUREMENT THAT CHANGED THIS FILE. One operator sign-in, then eight distinct passwords
  // from the same address. Under the old rule the header alone flipped this address from Attack to
  // silence, and took the eight rows out of the by-address counts on the way.
  const spray = [operatorIn()];
  for (let index = 0; index < 8; index += 1) {
    spray.push(row({ at: at(60_000 + index * 60_000), triedHash: HASH(300 + index), userAgent: "curl/8" }));
  }
  const plain = summariseByAddress(spray).find((one) => one.ip === MINE);
  assert.equal(plain.attack, true);

  const spoofed = spray.map((one) => (one.outcome === "refused" && one.userAgent === "curl/8"
    ? { ...one, userAgent: `${GATE_AGENT_PREFIX}verify-deploy` }
    : { ...one }));
  const gates = markGateRows(spoofed, { isOperatorAccount: () => false });
  const marked = summariseByAddress(spoofed, { yourAddresses: gates.yourAddresses }).find((one) => one.ip === MINE);
  assert.equal(marked.attack, true, "a header turned a live password spray into silence");
  assert.equal(marked.attempts, plain.attempts, "a header changed how many tries this address made");
  assert.equal(marked.distinctInWindow, plain.distinctInWindow, "a header changed the distinct-password window");
  assert.equal(marked.gateRows, 8, "and the panel is still told which rows claimed to be a gate");
});

test("a stranger's copy of the header is marked and counted, never trusted", () => {
  // The header names a script. It says nothing about who sent it, so it is a label and never a
  // decision: this address never signed in as anybody and it still reads as an attack.
  const rows = [operatorIn(), ...gateBurst({ ip: STRANGER })];
  const gates = markGateRows(rows, { isOperatorAccount: () => false });
  assert.equal(gates.named, 9, "a gate's first run from a new address must still be nameable");
  assert.equal(gates.yourAddresses.has(STRANGER), false, "an address nobody signed in from became the operator's");

  const stranger = summariseByAddress(rows, { yourAddresses: gates.yourAddresses }).find((one) => one.ip === STRANGER);
  assert.equal(stranger.attack, true, "a stranger claimed the gate label with a header and was believed");
  assert.equal(stranger.attempts, 9);
  assert.equal(stranger.gateRows, 9);
  assert.equal(stranger.yourAddress, false);
});

test("a super admin's own sign-in is what makes an address yours, and only that", () => {
  // The instance door names nobody, so that half is "somebody typed the instance password and got
  // in". The other half is an ACCOUNT door sign-in by an account this store says is a super admin.
  // It no longer gates the label; it gates the words "your address" beside the row.
  const rows = [
    row({ at: at(0), door: "account", email: "jason@titaniumcomputing.com", outcome: "ok", triedHash: "", userAgent: "Mozilla/5.0" }),
    ...gateBurst(),
  ];
  const gates = markGateRows(rows, { isOperatorAccount: (email) => email === "jason@titaniumcomputing.com" });
  assert.equal(gates.yourAddresses.has(MINE), true);

  // And an ordinary customer getting in from that address does NOT make it the operator's.
  const customer = [
    row({ at: at(0), door: "account", email: "someone@acme.com", outcome: "ok", triedHash: "", userAgent: "Mozilla/5.0" }),
    ...gateBurst(),
  ];
  assert.equal(markGateRows(customer, { isOperatorAccount: (email) => email === "jason@titaniumcomputing.com" }).yourAddresses.has(MINE), false);
});

test("a blank agent on the account door is never labelled", () => {
  // 58 of the 222 rows in the live ledger carry an empty agent, 10 of them written by the control
  // plane's own door, which hardcodes an empty string. An absence test on its own would label every
  // one of them, including a real attack on a real customer's account.
  const rows = [
    operatorIn(),
    row({ at: at(30_000), door: "account", email: "demo@titanium.bot", userAgent: "", triedHash: HASH(7), source: "control plane" }),
  ];
  const gates = markGateRows(rows, { isOperatorAccount: () => false });
  assert.equal(gates.rows, 0, "a blank agent on the account door was read as a gate");
  assert.equal(rows[1].gate, false);

  const account = summariseByAccount(rows, { yourAddresses: gates.yourAddresses }).find((one) => one.email === "demo@titanium.bot");
  assert.equal(account.attempts, 1);
  assert.equal(account.gateRows, 0);
  assert.equal(account.yourAddress, true);
});

test("the retroactive clause is dated and address-bound, and it says which clause it was", () => {
  // The 178 rows already in the live ledger carry no marker and will not age out: the file is 39 KB
  // against a 5 MB rotation cap. This is the only clause that reaches them, and it is bounded --
  // instance door, refused or locked, the bare agent node had, this operator's address, and OLDER
  // THAN THE INSTANT THE CLAUSE WAS WRITTEN. It is shape evidence rather than a name, so the panel
  // prints a different sentence for it.
  const before = [operatorIn(), ...gateBurst({ agent: "node" })];
  const olderGates = markGateRows(before);
  assert.equal(olderGates.rows, 9);
  assert.equal(olderGates.named, 0);
  assert.equal(olderGates.older, 9);
  assert.match(olderGates.setAsideNote, /before gates named themselves/);
  const one = before.find((each) => each.gate === true);
  assert.equal(one.gateScript, "", "a retroactive row claimed a script name it cannot know");
  assert.equal(one.gateWhy, "before");

  // Same rows from an address nobody signed in from: the shape clause has no evidence and does not
  // fire.
  const elsewhere = [operatorIn(), ...gateBurst({ ip: STRANGER, agent: "node" })];
  assert.equal(markGateRows(elsewhere).rows, 0);

  const after = Date.parse(GATE_LABEL_BEFORE) + 60_000;
  const later = [
    { ...operatorIn(), at: new Date(after).toISOString() },
    ...gateBurst({ agent: "node" }).map((each, index) => ({ ...each, at: new Date(after + index * 4_000).toISOString() })),
  ];
  assert.equal(markGateRows(later).rows, 0, "a bare node row written after the clause was labelled anyway");
  assert.equal(summariseByAddress(later).find((each) => each.ip === MINE).attack, true);
});

test("an outcome that worked is never a gate row, whatever the agent says", () => {
  // Both clauses, not just the dated one. A gate that GETS IN made a successful sign-in and belongs
  // in the ok count with everything else that got in.
  const bare = [operatorIn(), ...gateBurst({ agent: "node" }).map((one) => ({ ...one, outcome: "ok", triedHash: "" }))];
  assert.equal(markGateRows(bare).rows, 0, "a successful sign-in was labelled a gate");

  const named = [operatorIn(), ...gateBurst().map((one) => ({ ...one, outcome: "ok", triedHash: "" }))];
  const gates = markGateRows(named, { isOperatorAccount: () => false });
  assert.equal(gates.rows, 0, "a successful sign-in carrying the header was labelled a gate");
  const [summary] = summariseByAddress(named, { yourAddresses: gates.yourAddresses });
  assert.equal(summary.ok, 10, "a successful sign-in went missing from the ok count because of its user agent");
  assert.equal(summary.gateRows, 0);
});

test("a gate's refusals are still a spray, because a header is not a credential", () => {
  // One password against many accounts trips no lockout anywhere and is invisible in every other
  // view, so the spray table is the one place it appears at all. That is exactly why a string in a
  // user agent must not be able to empty it.
  const shared = HASH(42);
  const rows = [operatorIn()];
  for (let index = 0; index < 6; index += 1) {
    rows.push(row({
      at: at(60_000 + index * 5_000), door: "account", email: `person${index}@acme.com`,
      userAgent: `${GATE_AGENT_PREFIX}verify-control-plane`, triedHash: shared,
    }));
  }
  const gates = markGateRows(rows, { isOperatorAccount: () => false });
  assert.equal(gates.rows, 6);
  assert.deepEqual(gates.scripts, ["verify-control-plane"]);
  assert.equal(summariseByPassword(rows).some((one) => one.spray), true, "a header emptied the spray table");
  assert.equal(summariseByAccount(rows, { yourAddresses: gates.yourAddresses }).every((one) => one.sprayed === true), true);
  assert.equal(summariseByAccount(rows, { yourAddresses: gates.yourAddresses }).every((one) => one.gateRows === 1), true);
});

test("the route says what it marked, and the counts do not move when it marks something", async () => {
  const root = await makeTempRoot("cp-signins-gate-");
  const store = openStore({ dataDir: root });
  try {
    store.createTenant({ slug: "titanium", name: "Titanium", status: "running" });
    store.createAccount({ email: "jason@titaniumcomputing.com", password: "a-good-long-password", name: "Jason", tenant: "titanium" });
    store.setSuperAdmin("jason@titaniumcomputing.com", true);

    const ledger = [
      operatorIn(),
      row({ at: at(30_000), door: "account", email: "jason@titaniumcomputing.com", outcome: "ok", triedHash: "", userAgent: "Mozilla/5.0" }),
      ...gateBurst(),
      // A stranger, at the same moment, from somewhere else. This is the row the pill is for.
      ...Array.from({ length: 7 }, (unused, index) => row({
        at: at(60_000 + index * 3_000), ip: STRANGER, door: "account",
        email: "demo@titanium.bot", userAgent: "python-requests/2.31", triedHash: HASH(200 + index),
      })),
    ];

    const api = createAdminApi({
      config: { dataDir: root, tenantRoot: root, adminToken: OPERATOR_TOKEN, relayUrl: "http://relay.invalid", relayToken: "relay-token" },
      store,
      client: { base: "", call: async () => ({}) },
      json: (response, status, body) => { response.status = status; response.body = body; },
      noContent: () => {},
      publicAccount: (account) => account,
      publicTenant: (tenant) => tenant,
      tenantView: async (one) => ({ slug: one.slug }),
      tenantPower: async () => {}, tenantProvision: async () => {},
      currentSession: () => ({ ok: false }),
      log: () => {},
      clientOf: () => MINE,
      fetchImpl: async () => new Response(JSON.stringify({ source: "relay", rows: ledger }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    const url = new URL("http://cp.invalid/v1/admin/sign-ins?hours=720");
    const response = { status: 0, body: null };
    const took = await api.handle(
      { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }, method: "GET" },
      response,
      { segments: ["v1", "admin", "sign-ins"], method: "GET", body: {}, url },
    );
    assert.equal(took, true);
    assert.equal(response.status, 200);

    const answer = response.body;
    assert.equal(answer.gates.rows, 9);
    assert.equal(answer.gates.named, 9, "the answer does not say which clause matched");
    assert.equal(answer.gates.older, 0);
    assert.deepEqual(answer.gates.scripts, ["verify-deploy"]);
    assert.match(answer.gates.setAsideNote, /grey/);
    // Every row is still in the answer, including the nine, so the panel can draw them.
    assert.equal(answer.rows.length, ledger.length);
    assert.equal(answer.rows.filter((one) => one.gate === true).length, 9);

    const mine = answer.addresses.find((one) => one.ip === MINE);
    assert.equal(mine.gateRows, 9);
    assert.equal(mine.yourAddress, true);
    assert.equal(mine.attack, true, "the operator's own address stopped reading as an attack because of a header");
    assert.equal(mine.distinctInWindow >= ATTACK_DISTINCT_PASSWORDS, true);

    // AND THE PILL STILL WORKS ON A STRANGER, which it did before and has to go on doing.
    const stranger = answer.addresses.find((one) => one.ip === STRANGER);
    assert.equal(stranger.attack, true, "a stranger's seven passwords stopped raising the pill");
    assert.equal(stranger.gateRows, 0);
    assert.equal(stranger.yourAddress, false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
