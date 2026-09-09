// SIGNIN-1. This operator's own verification gates, told apart from strangers.
//
// Jason, 2026-09-09 11:43, over two screenshots of the Sign-in attempts panel: 147.136.44.142
// marked "Attack", 101 tries, 58 locked out, 23 different passwords, and one of the accounts named
// was his own. Every number on that screen was right. The one thing it got wrong was who: every
// burst was scripts/verify-deploy.mjs steps 3 and 8, two wrong instance passwords refused and then
// seven more until the throttle answers, run from this Mac behind his home address, one burst per
// wave ship since 2026-09-05.
//
// A PANEL THAT CRIES WOLF IS WORSE THAN NO PANEL. But the fix cannot be "trust the user agent",
// because a user agent is a string a stranger writes and the whole value of the Attack pill is that
// it cannot be turned off from outside. So the label needs two halves and the second one is the
// part that matters: the row's ADDRESS also has a successful operator or super admin sign-in inside
// the same hour. Faking that means already holding the password.
//
// Every case below is one of the ways that could go wrong.
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

/** The operator getting in, which is the half of the test an outsider cannot fake. */
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

test("a gate's own burst is set aside, and the address stops reading as an attack", () => {
  const rows = [operatorIn(), ...gateBurst()];
  const gates = markGateRows(rows, { isOperatorAccount: () => false });

  assert.equal(gates.rows, 9);
  assert.deepEqual(gates.scripts, ["verify-deploy"]);
  assert.match(gates.setAsideNote, /verify-deploy/);
  assert.equal(gates.yourAddresses.has(MINE), true);

  // THE ROWS ARE STILL THERE. A set-aside row is drawn in grey, never hidden: a row nobody can see
  // is a row nobody can check, and this label is exactly the kind that has to stay checkable.
  assert.equal(rows.length, 10);
  assert.equal(rows.filter((one) => one.gate === true).length, 9);
  assert.equal(rows.find((one) => one.gate === true).gateScript, "verify-deploy");

  const [summary] = summariseByAddress(rows, { yourAddresses: gates.yourAddresses });
  assert.equal(summary.ip, MINE);
  assert.equal(summary.gateRows, 9, "a set-aside row was made invisible instead of counted");
  assert.equal(summary.yourAddress, true);
  assert.equal(summary.attack, false, "the operator's own gate still reads as an attack");
  assert.equal(summary.distinctPasswords, 0, "the gate's nine passwords were counted against the address");
  // The one real sign-in is still counted, because it is a real sign-in.
  assert.equal(summary.ok, 1);
  assert.equal(summary.attempts, 1);
  // And the window still covers everything that happened at this address.
  assert.equal(summary.lastAt, at(60_000 + 8 * 4_000));
});

test("without the gate label the very same rows are an attack, which is why the label is narrow", () => {
  const rows = [operatorIn(), ...gateBurst()];
  const [before] = summariseByAddress(rows);
  assert.equal(before.attack, true, "nine different passwords in four minutes is an attack and should read as one");
  assert.equal(before.distinctInWindow >= ATTACK_DISTINCT_PASSWORDS, true);
});

test("the same agent from an address that never signed in is NOT set aside", () => {
  // A stranger who read this file and copied the header. The prefix alone buys nothing: the second
  // half of the test is a successful operator sign-in from the SAME address, and having one of
  // those means already holding the password.
  const rows = [operatorIn(), ...gateBurst({ ip: STRANGER })];
  const gates = markGateRows(rows, { isOperatorAccount: () => false });
  assert.equal(gates.rows, 0);
  assert.equal(gates.yourAddresses.has(STRANGER), false);
  assert.match(gates.setAsideNote, /Nothing here/);

  const stranger = summariseByAddress(rows, { yourAddresses: gates.yourAddresses }).find((one) => one.ip === STRANGER);
  assert.equal(stranger.attack, true, "a stranger claimed the gate label with a header");
  assert.equal(stranger.gateRows, 0);
  assert.equal(stranger.yourAddress, false);
});

test("a super admin's own sign-in is the other way an address becomes yours", () => {
  // The instance door names nobody, so that half is "somebody typed the instance password and got
  // in". The other half is an ACCOUNT door sign-in by an account this store says is a super admin.
  const rows = [
    row({ at: at(0), door: "account", email: "jason@titaniumcomputing.com", outcome: "ok", triedHash: "", userAgent: "Mozilla/5.0" }),
    ...gateBurst(),
  ];
  const gates = markGateRows(rows, { isOperatorAccount: (email) => email === "jason@titaniumcomputing.com" });
  assert.equal(gates.rows, 9);

  // And an ordinary customer getting in from that address does NOT make it the operator's.
  const customer = [
    row({ at: at(0), door: "account", email: "someone@acme.com", outcome: "ok", triedHash: "", userAgent: "Mozilla/5.0" }),
    ...gateBurst(),
  ];
  assert.equal(markGateRows(customer, { isOperatorAccount: (email) => email === "jason@titaniumcomputing.com" }).rows, 0);
});

test("a blank agent on the account door is never set aside", () => {
  // 58 of the 222 rows in the live ledger carry an empty agent, 10 of them written by the control
  // plane's own door, which hardcodes an empty string. An absence test on its own would set aside
  // every one of them, including a real attack on a real customer's account.
  const rows = [
    operatorIn(),
    row({ at: at(30_000), door: "account", email: "demo@titanium.bot", userAgent: "", triedHash: HASH(7), source: "control plane" }),
  ];
  const gates = markGateRows(rows, { isOperatorAccount: () => false });
  assert.equal(gates.rows, 0, "a blank agent on the account door was read as a gate");
  assert.equal(rows[1].gate, false);

  const account = summariseByAccount(rows, { yourAddresses: gates.yourAddresses }).find((one) => one.email === "demo@titanium.bot");
  assert.equal(account.attempts, 1, "a real attempt on a customer's account was set aside");
  assert.equal(account.gateRows, 0);
  // It DID come from an address the operator was signing in from, and that is said rather than
  // used to excuse anything.
  assert.equal(account.yourAddress, true);
});

test("the retroactive clause is dated, so nothing written after it can lean on it", () => {
  // The 178 rows already in the live ledger carry no marker and will not age out: the file is 39 KB
  // against a 5 MB rotation cap. This is the only clause that reaches them, and it is bounded --
  // instance door, refused or locked, the bare agent node had, this operator's address, and OLDER
  // THAN THE INSTANT THE CLAUSE WAS WRITTEN.
  const before = [operatorIn(), ...gateBurst({ agent: "node" })];
  assert.equal(markGateRows(before).rows, 9);
  assert.equal(before.find((one) => one.gate === true).gateScript, "", "a retroactive row claimed a script name it cannot know");

  const after = Date.parse(GATE_LABEL_BEFORE) + 60_000;
  const later = [
    { ...operatorIn(), at: new Date(after).toISOString() },
    ...gateBurst({ agent: "node" }).map((one, index) => ({ ...one, at: new Date(after + index * 4_000).toISOString() })),
  ];
  assert.equal(markGateRows(later).rows, 0, "a bare node row written after the clause was set aside anyway");
  assert.equal(summariseByAddress(later).find((one) => one.ip === MINE).attack, true);
});

test("an outcome that worked is never a gate row, whatever the agent says", () => {
  const rows = [operatorIn(), ...gateBurst({ agent: "node" }).map((one) => ({ ...one, outcome: "ok", triedHash: "" }))];
  assert.equal(markGateRows(rows).rows, 0, "a successful sign-in was set aside as a gate");
});

test("a gate's refusals are never a spray", () => {
  // One password against many accounts trips no lockout anywhere and is invisible in every other
  // view, so the spray table is the one place it appears. A gate that posted the same wrong
  // password at six accounts must not be able to raise that flag either.
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
  assert.equal(summariseByPassword(rows).some((one) => one.spray), false, "the gate's own loop raised a spray");
  assert.equal(summariseByAccount(rows, { yourAddresses: gates.yourAddresses }).every((one) => one.sprayed === false), true);

  // The same six rows with no gate label are exactly the spray this table exists for.
  const bare = rows.map(({ gate, gateScript, ...rest }) => rest);
  assert.equal(summariseByPassword(bare).some((one) => one.spray), true);
});

test("the route says what it left out, and the rows are still in the answer", async () => {
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
    assert.deepEqual(answer.gates.scripts, ["verify-deploy"]);
    assert.match(answer.gates.setAsideNote, /grey/);
    // Every row is still in the answer, including the nine, so the panel can draw them.
    assert.equal(answer.rows.length, ledger.length);
    assert.equal(answer.rows.filter((one) => one.gate === true).length, 9);

    const mine = answer.addresses.find((one) => one.ip === MINE);
    assert.equal(mine.attack, false, "the operator's own address still reads as an attack");
    assert.equal(mine.gateRows, 9);
    assert.equal(mine.yourAddress, true);

    // AND THE PILL STILL WORKS. This is the whole point: the label is narrow enough that the thing
    // it was built to stop hiding is still shown.
    const stranger = answer.addresses.find((one) => one.ip === STRANGER);
    assert.equal(stranger.attack, true, "a stranger's seven passwords stopped raising the pill");
    assert.equal(stranger.gateRows, 0);
    assert.equal(stranger.yourAddress, false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
