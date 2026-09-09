// The per-bot address directory, on the side that owns it (MAIL-2, docs/MAIL.md).
//
// The control plane mints one six digit code per (workspace, bot) and hands it back for ever. The
// three claims worth a test are the three that decide whether one customer's mail can reach
// another's bot:
//
//   two workspaces each with a bot called Titan hold two different codes, and one workspace's
//   localpart does not resolve for the other. This is the whole reason a name-based address had to
//   go: names are not unique across customers, and titan@ was ambiguous the moment Richard got one.
//
//   a code is never handed out twice, including after it is retired. The row is the reservation:
//   a code returned to the pool could be minted for a different bot in a different workspace, and
//   mail still addressed to the old one would then reach a stranger.
//
//   the two relay routes are behind CP_RELAY_TOKEN and nothing else opens them.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";

import { openStore } from "../cp/store.mjs";
import { createMailDirectory, normalizeAgents } from "../cp/mail.mjs";
import { startControlPlane } from "./cp-support.mjs";

const DOMAIN = "myagents.email";
const memory = () => openStore({ file: ":memory:" });

test("two workspaces each with a Titan hold two different addresses, and neither localpart is the other's", () => {
  const store = memory();
  try {
    const directory = createMailDirectory({ store, domain: DOMAIN });
    directory.mint("demo", [{ id: "agent_titan", name: "Titan" }]);
    directory.mint("titanium", [{ id: "agent_titan", name: "Titan" }]);

    const demo = directory.directory("demo").tenants.demo.addresses[0];
    const titanium = directory.directory("titanium").tenants.titanium.addresses[0];

    assert.notEqual(demo.code, titanium.code, "two Titans, two codes");
    assert.match(demo.address, /^agent\d{6}@myagents\.email$/);
    assert.match(titanium.address, /^agent\d{6}@myagents\.email$/);
    // No address carries a name, whatever the bot is called. This is the assertion that fails if
    // anybody ever puts a name back into the localpart.
    assert.equal(demo.address.includes("titan"), false, demo.address);

    // The demo localpart resolves to demo and to nothing else.
    const found = directory.lookup(demo.address.split("@")[0]);
    assert.equal(found.slug, "demo");
    assert.equal(found.agentId, "agent_titan");
    // And it is not titanium's, which is the leak this scheme closes.
    assert.notEqual(directory.lookup(titanium.address.split("@")[0]).slug, "demo");
  } finally { store.close(); }
});

test("a bot that already has an address never gets a second one, however often the sweep runs", () => {
  const store = memory();
  try {
    const directory = createMailDirectory({ store, domain: DOMAIN });
    const first = directory.mint("demo", [{ id: "a1", name: "Titan" }]);
    for (let pass = 0; pass < 20; pass += 1) directory.mint("demo", [{ id: "a1", name: "Titan" }]);
    const rows = store.listMailAddresses("demo");
    assert.equal(rows.length, 1, "twenty sweeps, one address");
    assert.equal(rows[0].code, first.addresses[0].code);
    // A rename moves the display name and never the address.
    directory.mint("demo", [{ id: "a1", name: "Titan the Second" }]);
    const after = store.listMailAddresses("demo")[0];
    assert.equal(after.code, first.addresses[0].code);
    assert.equal(after.agentName, "Titan the Second");
  } finally { store.close(); }
});

test("five thousand codes are five thousand distinct addresses, and a retired one is never handed out again", () => {
  const store = memory();
  try {
    const directory = createMailDirectory({ store, domain: DOMAIN });
    const roster = [];
    for (let index = 0; index < 5000; index += 1) roster.push({ id: `bot_${index}`, name: `Bot ${index}` });
    directory.mint("big", roster);

    const rows = store.listMailAddresses("big");
    assert.equal(rows.length, 5000, "one address per bot");
    assert.equal(new Set(rows.map((row) => row.code)).size, 5000, "and every code distinct");
    assert.equal(new Set(rows.map((row) => row.address)).size, 5000);
    for (const row of rows) assert.match(row.code, /^\d{6}$/);

    // Retire one, then mint two thousand more bots and prove the dead code is not among them. The
    // mechanism is that the row stays in the table, so the insert can never pick that number: the
    // row surviving IS the proof, and the two thousand are the demonstration.
    const dead = rows[1234].code;
    const orphaned = rows[1234].agentId;
    const retired = store.retireMailAddress(dead);
    assert.equal(retired.state, "retired");
    assert.ok(retired.retiredAt, "and it says when");

    const more = [];
    for (let index = 5000; index < 7000; index += 1) more.push({ id: `bot_${index}`, name: `Bot ${index}` });
    directory.mint("big", more);
    const all = store.listMailAddresses("big");
    assert.equal(all.length, 7000);
    assert.equal(all.filter((row) => row.code === dead).length, 1, "the retired row is still the only holder of that code");
    assert.equal(store.getMailAddressByCode(dead).state, "retired");
    // And a retired address is still refused when it is looked up.
    assert.equal(directory.lookup(`agent${dead}`).state, "retired");

    // Retiring kills the ADDRESS and not the bot. The next sweep gives it a new one, the dead code
    // is never handed to anybody, and the bot is not left unreachable for ever -- which is what a
    // plain unique constraint on (workspace, bot) would have done.
    assert.equal(store.getMailAddressByAgent("big", orphaned), null, "that bot has no live address the moment it is retired");
    const replaced = directory.mint("big", [{ id: orphaned, name: "back again" }]);
    assert.equal(replaced.minted, 1, "and the pass that mints it says so: a gravestone is not an address it already had");
    const fresh = store.getMailAddressByAgent("big", orphaned);
    assert.ok(fresh, "and a fresh one on the next sweep");
    assert.notEqual(fresh.code, dead);
    assert.equal(store.getMailAddressByCode(dead).state, "retired", "the dead code stays dead");
    assert.equal(store.listMailAddresses("big").filter((row) => row.agentId === orphaned).length, 2,
      "one live row and one gravestone");
  } finally { store.close(); }
});

test("a group chat is never given an address, and a roster with no id is not an agent", () => {
  assert.deepEqual(normalizeAgents([
    { id: "a1", name: "Titan" },
    { id: "g1", name: "Sales", isGroup: true },
    { id: "", name: "nothing" },
    { id: "a1", name: "Titan again" },
  ]), [{ id: "a1", name: "Titan" }]);

  const store = memory();
  try {
    const directory = createMailDirectory({ store, domain: DOMAIN });
    directory.mint("demo", [{ id: "a1", name: "Titan" }, { id: "g1", name: "Sales", isGroup: true }]);
    assert.equal(store.listMailAddresses("demo").length, 1);
  } finally { store.close(); }
});

test("only a code localpart resolves; a name never does, however it is spelled", () => {
  const store = memory();
  try {
    const directory = createMailDirectory({ store, domain: DOMAIN });
    const minted = directory.mint("demo", [{ id: "a1", name: "Titan" }]);
    const code = minted.addresses[0].code;
    assert.equal(directory.lookup(`agent${code}`).slug, "demo");
    for (const guess of ["titan", "Titan", "agent12345", "agent1234567", "agentabcdef", "agent 123456", ""]) {
      assert.equal(directory.lookup(guess), null, guess);
    }
    // And through a whole address, where the domain is checked first: this account also receives
    // anvilmail.io, because Resend's webhook is account-wide rather than domain-scoped.
    assert.equal(directory.lookupAddress(`agent${code}@myagents.email`).slug, "demo");
    assert.equal(directory.lookupAddress(`agent${code}@anvilmail.io`), null);
  } finally { store.close(); }
});

test("approved senders is off for every workspace until somebody turns it on", () => {
  const store = memory();
  try {
    const directory = createMailDirectory({ store, domain: DOMAIN });
    directory.mint("demo", [{ id: "a1", name: "Titan" }]);
    assert.equal(directory.approvedSendersOnly("demo"), false, "off by default, which is what lets a first verification mail through");
    assert.deepEqual(directory.directory("demo").tenants.demo.senders, []);

    store.allowSender("demo", "Noreply@Stripe.com");
    directory.setApprovedSendersOnly("demo", true, "a test");
    const answer = directory.directory("demo").tenants.demo;
    assert.equal(answer.approvedSendersOnly, true);
    assert.deepEqual(answer.senders, ["noreply@stripe.com"], "addresses are compared lowercased");

    directory.setApprovedSendersOnly("demo", false, "a test");
    assert.equal(directory.directory("demo").tenants.demo.approvedSendersOnly, false);
  } finally { store.close(); }
});

// ---- the two relay routes -------------------------------------------------------------------

test("the directory routes answer the relay's credential and refuse every other one", async () => {
  const relayToken = randomBytes(24).toString("hex");
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: relayToken } });
  try {
    const relay = (method, pathname, body) => cp.request(method, pathname, { body, token: relayToken });

    // Nothing minted yet: an empty directory is an answer and not an error.
    const empty = await relay("GET", "/v1/relay/mail/directory");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.tenants, {});
    assert.equal(empty.body.domain, "myagents.email");

    const minted = await relay("POST", "/v1/relay/mail/mint", {
      slug: "demo",
      agents: [{ id: "a1", name: "Titan" }, { id: "g1", name: "Sales", isGroup: true }, { id: "a2", name: "Scribe" }],
    });
    assert.equal(minted.status, 200);
    assert.equal(minted.body.minted, 2, "the group chat is not a bot");
    assert.equal(minted.body.addresses.length, 2);
    assert.equal(minted.body.approvedSendersOnly, false);

    // The second mint mints nothing and answers the same two addresses.
    const again = await relay("POST", "/v1/relay/mail/mint", { slug: "demo", agents: [{ id: "a1", name: "Titan" }, { id: "a2", name: "Scribe" }] });
    assert.equal(again.body.minted, 0);
    assert.deepEqual(again.body.addresses.map((row) => row.code).sort(), minted.body.addresses.map((row) => row.code).sort());

    const all = await relay("GET", "/v1/relay/mail/directory");
    assert.equal(all.body.tenants.demo.addresses.length, 2);
    const narrowed = await relay("GET", "/v1/relay/mail/directory?slug=demo");
    assert.deepEqual(Object.keys(narrowed.body.tenants), ["demo"]);

    // The credential. The admin token opens accounts and deletes services; it does not open this,
    // and this does not open anything of its own beyond the directory.
    for (const token of [undefined, cp.config.adminToken, `${relayToken}x`, ""]) {
      const refused = await cp.request("GET", "/v1/relay/mail/directory", { token: token || undefined });
      assert.equal(refused.status, 401, `token ${String(token).slice(0, 6)} should not open the directory`);
    }
    const refusedMint = await cp.request("POST", "/v1/relay/mail/mint", { body: { slug: "demo", agents: [] }, token: cp.config.adminToken });
    assert.equal(refusedMint.status, 401);

    // A mint with no workspace named is a bad request rather than a silent nothing.
    const nameless = await relay("POST", "/v1/relay/mail/mint", { agents: [{ id: "a1", name: "Titan" }] });
    assert.equal(nameless.status, 400);

    // And the method matters: the directory is a read.
    assert.equal((await relay("POST", "/v1/relay/mail/directory", {})).status, 405);
    assert.equal((await relay("GET", "/v1/relay/mail/mint")).status, 405);
  } finally { await cp.dispose(); }
});

test("the super admin sees how many addresses a workspace holds, and never a secret", async () => {
  const relayToken = randomBytes(24).toString("hex");
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: relayToken } });
  try {
    await cp.request("POST", "/v1/relay/mail/mint", {
      body: { slug: "demo", agents: [{ id: "a1", name: "Titan" }, { id: "a2", name: "Scribe" }] },
      token: relayToken,
    });
    const answer = await cp.request("GET", "/v1/admin/mail", { token: cp.config.adminToken });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.counts.total, 2);
    assert.equal(answer.body.counts.active, 2);
    assert.equal(answer.body.domain, "myagents.email");
    for (const row of answer.body.rows) assert.match(row.address, /^agent\d{6}@myagents\.email$/);

    const narrowed = await cp.request("GET", "/v1/admin/mail?slug=nobody", { token: cp.config.adminToken });
    assert.equal(narrowed.body.rows.length, 0);

    // It is a super admin route like every other one on that panel.
    assert.equal((await cp.request("GET", "/v1/admin/mail")).status, 401);
    assert.equal((await cp.request("GET", "/v1/admin/mail", { token: relayToken })).status, 401);
  } finally { await cp.dispose(); }
});
