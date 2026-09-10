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

/**
 * A workspace row for every slug a test mints for.
 *
 * ONBOARD-2: mint refuses a slug with no tenant row, because the five minute sweep minted an address
 * 28.7 s into a removal on the R750 on 2026-09-10 and nothing would ever have retired it. Every one
 * of these tests was minting for a workspace that did not exist, which is the shape of the bug.
 */
const workspaces = (store, ...slugs) => {
  for (const slug of slugs) {
    store.createTenant({ slug, name: slug, host: `${slug}.titanium.bot`, status: "running", ownerEmail: `owner@${slug}.invalid` });
  }
  return store;
};
const memory = (...slugs) => workspaces(openStore({ file: ":memory:" }), ...(slugs.length > 0 ? slugs : ["demo"]));

test("two workspaces each with a Titan hold two different addresses, and neither localpart is the other's", () => {
  const store = memory("demo", "titanium");
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
  const store = memory("big");
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

test("nothing mints an address for a workspace that is gone", () => {
  // ONBOARD-2, measured on the R750 2026-09-10. A removal retires every address at its second step
  // and keeps serving the tenant row to the relay until its eighth, so the five minute sweep read a
  // roster off a box that was not dead yet, posted here 28.7 s into the teardown, and this wrote
  // agent218973@myagents.email ACTIVE for a customer who no longer existed. Nothing would ever have
  // retired it: the sweep only retires codes for a roster it can READ, and that box is gone.
  const store = memory("demo");
  try {
    const directory = createMailDirectory({ store, domain: DOMAIN });
    const refused = directory.mint("went-away", [{ id: "a1", name: "Titan" }]);
    assert.equal(refused.error, "no_such_workspace");
    assert.match(refused.message, /There is no workspace called went-away/);
    assert.equal(refused.minted, 0);
    assert.equal(store.listMailAddresses("went-away").length, 0, "not even a retired row was written");
    assert.equal(store.listMailAddresses().length, 0, "and nothing was written anywhere else either");

    // A workspace that is there is untouched by any of this.
    const minted = directory.mint("demo", [{ id: "a1", name: "Titan" }]);
    assert.equal(minted.error, undefined);
    assert.equal(minted.minted, 1);
    assert.equal(store.listMailAddresses("demo").length, 1);
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

    // The workspace exists, the way one does on a live control plane. The mint refuses a slug with no
    // tenant row, which is what stops the sweep writing an address for a customer who is gone.
    workspaces(cp.store, "demo");
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
    workspaces(cp.store, "demo");
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

// The operator's four other mail verbs, over HTTP against a running service.
//
// This is here because of what it caught on the R750 on 2026-09-09 at 14:07Z. Every mail verb in
// cp/cli.mjs opened the sqlite store itself, which is the right database only on the machine that
// holds it. The store lives inside the control plane container on the server and the operator types
// the command on his Mac, so `cp mail list` opened an empty file of its own and answered "no
// addresses yet" over a live directory of nine. Nothing failed and nothing said anything: the verb
// the ship plan and docs/MAIL.md tell him to trust just quietly disagreed with the truth.
//
// So the verbs now go over the same API as every other verb in that file, and these are the routes
// they use. The test asserts what a store-reading CLI could never have satisfied: the ANSWER comes
// out of the service that holds the rows.
test("retiring, listing senders and the approved-senders switch all answer over the admin API", async () => {
  const relayToken = randomBytes(24).toString("hex");
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: relayToken } });
  try {
    const admin = cp.config.adminToken;
    workspaces(cp.store, "demo");
    await cp.request("POST", "/v1/relay/mail/mint", {
      body: { slug: "demo", agents: [{ id: "a1", name: "Titan" }] },
      token: relayToken,
    });
    const listed = await cp.request("GET", "/v1/admin/mail?slug=demo", { token: admin });
    const code = listed.body.rows[0].code;

    // Approved senders is off until somebody turns it on, and the switch reads back.
    const before = await cp.request("GET", "/v1/admin/mail/senders?slug=demo", { token: admin });
    assert.equal(before.status, 200);
    assert.equal(before.body.approvedSendersOnly, false);
    assert.deepEqual(before.body.senders, []);

    const allowed = await cp.request("POST", "/v1/admin/mail/senders", {
      body: { slug: "demo", sender: "noreply@example.com" }, token: admin,
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.allowed.sender, "noreply@example.com");

    const on = await cp.request("POST", "/v1/admin/mail/only", { body: { slug: "demo", on: true }, token: admin });
    assert.equal(on.body.approvedSendersOnly, true);
    assert.deepEqual(on.body.senders, ["noreply@example.com"]);
    const off = await cp.request("POST", "/v1/admin/mail/only", { body: { slug: "demo", on: false }, token: admin });
    assert.equal(off.body.approvedSendersOnly, false);

    // Retiring kills the address and keeps the row, so the code is never handed to anybody else.
    const retired = await cp.request("POST", "/v1/admin/mail/retire", { body: { code }, token: admin });
    assert.equal(retired.status, 200);
    assert.equal(retired.body.retired.state, "retired");
    const after = await cp.request("GET", "/v1/admin/mail?slug=demo", { token: admin });
    assert.equal(after.body.counts.retired, 1);
    assert.equal((await cp.request("POST", "/v1/admin/mail/retire", { body: { code: "000000" }, token: admin })).status, 404);

    // Super admin routes like every other one on that panel: the relay's credential does not open them.
    assert.equal((await cp.request("GET", "/v1/admin/mail/senders?slug=demo")).status, 401);
    assert.equal((await cp.request("POST", "/v1/admin/mail/only", { body: { slug: "demo", on: true }, token: relayToken })).status, 401);
  } finally { await cp.dispose(); }
});

// And the verbs themselves: not one of them may open the store, or the bug above comes straight
// back the next time somebody adds a verb by copying its neighbour.
test("no mail verb in the CLI opens the database directly", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../cp/cli.mjs", import.meta.url), "utf8"));
  const section = source.slice(source.indexOf("async function mailList"), source.indexOf("const [group, action, ...rest]"));
  assert.ok(section.length > 500, "the mail section of cp/cli.mjs was not found");
  assert.equal(/openLedger\s*\(/.test(section), false, "a mail verb opens the sqlite store; it must ask the service instead");
  for (const verb of ["mailList", "mailRetire", "mailSenders", "mailAllow", "mailOnly"]) {
    assert.ok(section.includes(`function ${verb}`), `${verb} is missing from the mail section`);
  }
});

test("a bot that has left the roster loses its address, and a roster that says nothing changes none", () => {
  // Minting alone left a deleted bot's code active and routable for ever: measured on the R750 on
  // 2026-09-09, two throwaway gate probes deleted hours earlier still held live addresses.
  const store = memory();
  try {
    const directory = createMailDirectory({ store, domain: "myagents.email" });
    const first = directory.mint("demo", [{ id: "a1", name: "Titan" }, { id: "a2", name: "cf-probe-833658" }]);
    assert.equal(first.minted, 2);
    assert.equal(first.retired, 0);
    const probe = first.addresses.find((row) => row.agentId === "a2");

    // The probe agent is deleted, so the next sweep hands over a roster without it.
    const second = directory.mint("demo", [{ id: "a1", name: "Titan" }]);
    assert.equal(second.retired, 1, "the address of a bot that is gone is retired");
    assert.equal(second.addresses.find((row) => row.agentId === "a2").state, "retired");
    assert.equal(second.addresses.find((row) => row.agentId === "a1").state, "active");
    assert.equal(directory.lookup(probe.address.split("@")[0]).state, "retired",
      "and the relay refuses it, because that is what it does with a retired row");

    // A roster read that answered nothing is not the same as a workspace with no bots.
    const empty = directory.mint("demo", []);
    assert.equal(empty.retired, 0, "an empty roster retires nothing");
    assert.equal(empty.addresses.find((row) => row.agentId === "a1").state, "active");
  } finally { store.close(); }
});
