// Routing on the per-bot address directory (MAIL-2, docs/MAIL.md).
//
// The refusal ORDER is the security, so these are tests of the order and not only of the happy
// path. Against a real relay process, a real stub control plane and two fake boxes:
//
//   a code localpart reaches the bot that holds it, IN ITS OWN WORKSPACE, whoever received the
//   webhook. One relay holds every customer's gateway bearer, so the workspace the mail belongs to
//   is decided by the directory and never by which workspace claimed the domain.
//
//   agent999999@ -- an address nobody holds -- answers 200 no_route AND NEVER REACHES THE
//   CATCH-ALL. This is the leak that closes: today that message lands in whichever workspace claims
//   myagents.email, which is the operator's own Titan.
//
//   a name localpart still works until 2026-10-01 and arrives with the line that says so.
//
//   a recipient at a domain that is not the directory's is refused before any lookup, and that
//   customer's own domain still routes exactly as it did.
//
//   a bad Svix signature is 401 with nothing looked up at all.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { signSvix, routeDirectoryFirst, legacyNotice, MAIL_LEGACY_STOP } from "../ui/mail-edge.mjs";
import { openStore } from "../cp/store.mjs";
import { createMailDirectory, createMailSends } from "../cp/mail.mjs";
import { RELAY_TOKEN, startRelay, tenantRow, tenantsFile } from "./relay-tenant-support.mjs";

const DOMAIN = "myagents.email";
const SECRET = `whsec_${Buffer.from("the signing secret for these tests").toString("base64")}`;

// ---- the decision, as a function ---------------------------------------------------------------
// The order is worth its own cases: a failure names the rule that broke rather than the request
// that noticed.

const ROSTER = [{ id: "a_titan", name: "Titan" }, { id: "a_books", name: "Books" }, { id: "g1", name: "Sales", isGroup: true }];
const SETTINGS = { enabled: true, domain: DOMAIN, routes: {}, catchAllAgentId: "a_titan" };

test("a recipient at another domain is refused before the directory is read at all", async () => {
  let asked = 0;
  const answer = await routeDirectoryFirst({
    addresses: ["someone@anvilmail.io", "hello@acme.test"],
    agents: ROSTER, settings: SETTINGS, ownsDirectory: true,
    directoryDomain: DOMAIN,
    directoryRoute: async () => { asked += 1; return null; },
  });
  assert.equal(answer.kind, "elsewhere");
  assert.equal(asked, 0, "nothing at our domain means nothing about our directory is read");
});

test("an edge that does not hold the directory can never resolve a code, however the body is signed", async () => {
  // The blocker of 2026-09-09: the credential that unlocks this route is a signing secret each
  // customer sets on their OWN card, and the thing it unlocked was the directory that spans every
  // customer. So the question has to be asked before the lookup, and it is asked of the caller and
  // not of the message.
  let asked = 0;
  const answer = await routeDirectoryFirst({
    addresses: [`agent123456@${DOMAIN}`], agents: ROSTER, settings: SETTINGS,
    directoryDomain: DOMAIN,
    directoryRoute: async () => { asked += 1; return { slug: "demo", agentId: "a_titan", agentName: "Titan", address: `agent123456@${DOMAIN}`, state: "active" }; },
  });
  assert.equal(answer.kind, "elsewhere", "a foreign edge is told this is not its mail");
  assert.equal(asked, 0, "and the directory is not even read on its behalf");
  assert.match(answer.why, /does not hold the address directory/);
});

test("with no directory configured every message routes the way it always did", async () => {
  const answer = await routeDirectoryFirst({ addresses: [`titan@${DOMAIN}`], agents: ROSTER, settings: SETTINGS, ownsDirectory: true });
  assert.equal(answer.kind, "elsewhere");
});

test("a code resolves to the workspace that holds it, and a retired one is refused", async () => {
  const rows = { agent123456: { slug: "demo", agentId: "a_titan", agentName: "Titan", address: `agent123456@${DOMAIN}`, state: "active" },
                 agent222222: { slug: "demo", agentId: "a_old", agentName: "Gone", address: `agent222222@${DOMAIN}`, state: "retired" } };
  const directoryRoute = async (localpart) => rows[localpart] ?? null;

  const found = await routeDirectoryFirst({ addresses: [`agent123456@${DOMAIN}`], agents: ROSTER, settings: SETTINGS, ownsDirectory: true, directoryDomain: DOMAIN, directoryRoute });
  assert.equal(found.kind, "code");
  assert.equal(found.route.slug, "demo");
  assert.equal(found.route.agentId, "a_titan");

  const retired = await routeDirectoryFirst({ addresses: [`agent222222@${DOMAIN}`], agents: ROSTER, settings: SETTINGS, ownsDirectory: true, directoryDomain: DOMAIN, directoryRoute });
  assert.equal(retired.kind, "no_route");

  const nobody = await routeDirectoryFirst({ addresses: [`agent999999@${DOMAIN}`], agents: ROSTER, settings: SETTINGS, ownsDirectory: true, directoryDomain: DOMAIN, directoryRoute });
  assert.equal(nobody.kind, "no_route", "an address nobody holds is nobody's, and not the catch-all's");
});

test("a name address still arrives, with the line that says it is going away, until the stop date", async () => {
  const directoryRoute = async () => null;
  const directoryAddress = async ({ agentId }) => (agentId === "a_books" ? `agent654321@${DOMAIN}` : "");
  const at = Date.parse("2026-09-09T00:00:00Z");

  const legacy = await routeDirectoryFirst({
    addresses: [`books@${DOMAIN}`], agents: ROSTER, settings: SETTINGS, ownsDirectory: true,
    directoryDomain: DOMAIN, directoryRoute, directoryAddress, now: () => at,
  });
  assert.equal(legacy.kind, "legacy");
  assert.equal(legacy.route.agentId, "a_books");
  assert.match(legacy.notice, /2026-10-01/);
  assert.match(legacy.notice, /agent654321@myagents\.email/);

  // A name nobody on the roster answers to is not the catch-all's either.
  const guess = await routeDirectoryFirst({
    addresses: [`accounts@${DOMAIN}`], agents: ROSTER, settings: SETTINGS, ownsDirectory: true,
    directoryDomain: DOMAIN, directoryRoute, now: () => at,
  });
  assert.equal(guess.kind, "no_route");

  // And after the stop date the notice is not a warning any more, it is the refusal.
  const after = await routeDirectoryFirst({
    addresses: [`books@${DOMAIN}`], agents: ROSTER, settings: SETTINGS, ownsDirectory: true,
    directoryDomain: DOMAIN, directoryRoute, directoryAddress,
    now: () => Date.parse("2026-10-02T00:00:00Z"),
  });
  assert.equal(after.kind, "no_route");
  assert.match(after.why, /2026-10-01/);
});

test("the notice names the bot's own address, or says plainly that there is not one yet", () => {
  assert.match(legacyNotice({ address: `titan@${DOMAIN}`, codeAddress: `agent111111@${DOMAIN}` }),
    /Your own address is agent111111@myagents\.email\./);
  assert.match(legacyNotice({ address: `titan@${DOMAIN}` }), /has not been made yet/);
  assert.match(legacyNotice({ address: `titan@${DOMAIN}` }), new RegExp(MAIL_LEGACY_STOP));
});

// ---- the same rules through a real relay --------------------------------------------------------

/** A box: listAgents and sendPrompt, recorded, with setAgentMail refused the way an older bundle does. */
function fakeBox(roster, { knowsSetAgentMail = true } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const command = req.url.replace("/api/", "");
      let args; try { args = JSON.parse(raw || "{}"); } catch { args = null; }
      seen.push({ command, args });
      if (command === "setAgentMail" && !knowsSetAgentMail) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unknown gateway method: setAgentMail" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(command === "listAgents" ? roster : { accepted: true }));
    });
  });
  return {
    seen,
    prompts: () => seen.filter((one) => one.command === "sendPrompt"),
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    stop() { server.close(); },
  };
}

/** A control plane: the registry route it needs to be quiet, and the two directory routes. */
function stubControlPlane(store) {
  const directory = createMailDirectory({ store, domain: DOMAIN });
  // MAIL-3. The real send log over the same store, so the relay's claim and settle are checked
  // against the code that actually runs on the control plane rather than against a stub of it.
  const sends = createMailSends({ store });
  const seen = { directory: 0, mint: [], sendOpen: [], sendClose: [] };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://cp.invalid");
      const send = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (String(req.headers.authorization ?? "") !== `Bearer ${RELAY_TOKEN}`) return send(401, { error: "unauthorized" });
      if (url.pathname === "/v1/relay/tenants") return send(200, { tenants: [], skipped: [] });
      if (url.pathname === "/v1/relay/mail/directory") {
        seen.directory += 1;
        const slug = url.searchParams.get("slug");
        return send(200, directory.directory(slug && slug.length > 0 ? slug : null));
      }
      if (url.pathname === "/v1/relay/mail/mint") {
        let body; try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
        seen.mint.push(body.slug);
        return send(200, directory.mint(body.slug, body.agents));
      }
      if (url.pathname === "/v1/relay/mail/send/open") {
        let body; try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
        seen.sendOpen.push(body);
        const answer = sends.openSend(body);
        return send(answer.ok ? 200 : (answer.error === "rate_limited" ? 429 : 400), answer);
      }
      if (url.pathname === "/v1/relay/mail/send/close") {
        let body; try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
        seen.sendClose.push(body);
        return send(200, sends.closeSend(body.id, body.outcome, body.resendId, body.detail));
      }
      return send(404, { error: "not_found" });
    });
  });
  return {
    seen, directory,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    stop() { server.close(); },
  };
}

const event = (to, emailId = `em_${Math.random().toString(36).slice(2)}`, from = "jane@client.test") => JSON.stringify({
  type: "email.received",
  data: { email_id: emailId, to: [to], from, subject: "hello" },
});

const post = (relay, raw, secret = SECRET) => {
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return fetch(`${relay.base}/hooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id, "svix-timestamp": timestamp,
      "svix-signature": signSvix(secret, { id, timestamp }, raw),
    },
    body: raw,
  });
};

// Resend's receiving API, as much of it as the relay reads. The From line comes back from HERE and
// not out of the webhook body, which is Resend's own shape: the event announces an id and the
// message is fetched. Approved senders turns on exactly that difference, so the fake keeps it and
// `senders` maps an email id to whoever wrote it.
function fakeResend(senders = new Map(), outbound = []) {
  const server = createServer((req, res) => {
    // MAIL-3. The send route's own POST. Every field it was given is kept, because the claims worth
    // asserting are about what DID and did not reach this door.
    if (req.method === "POST" && req.url === "/emails") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        let body; try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
        outbound.push({ body, headers: req.headers });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `re_${outbound.length}` }));
      });
      return undefined;
    }
    const id = /\/emails\/receiving\/([^/]+)/.exec(req.url)?.[1] ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(req.url.endsWith("/attachments")
      ? { data: [] }
      : {
        from: senders.get(id) ?? "Jane <jane@client.test>",
        subject: "hello", text: "the body of the message",
        message_id: "<m@client.test>", created_at: "2026-09-09T06:00:00Z",
      }));
  });
  return {
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    stop() { server.close(); },
  };
}

const waitFor = async (predicate, why, ms = 20_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${why}`);
};

const jsonlOf = (dir, name) => {
  try {
    return readFileSync(path.join(dir, name), "utf8").split("\n")
      .filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  } catch { return []; }
};
const ledgerOf = (dir) => jsonlOf(dir, "mail-inbox.jsonl");
// MAIL-3. What this workspace's own bots sent, beside what arrived for them and on the same volume.
const sentLedgerOf = (dir) => jsonlOf(dir, "mail-sent.jsonl");

/**
 * A console with three workspaces on it: the one whose card claims myagents.email and receives the
 * webhook, a second one whose bots the mail is actually for, and Richard's, which is a real
 * customer and read-only this wave.
 */
async function console3({ noPush = "richard-avery", noSend = "", noSendFile = null } = {}) {
  const store = openStore({ file: ":memory:" });
  const cp = stubControlPlane(store);
  const cpUrl = await cp.start();
  const senders = new Map();
  const outbound = [];
  const resend = fakeResend(senders, outbound);
  const resendUrl = await resend.start();

  const alphaBox = fakeBox([{ id: "a_titan", name: "Titan" }, { id: "a_books", name: "Books" }]);
  const betaBox = fakeBox([{ id: "b_titan", name: "Titan" }, { id: "b_scribe", name: "Scribe" }]);
  // Richard's box is on an older bundle in this test as well as being read-only, which is the state
  // his box is actually in after this wave: it never gets the swap that adds setAgentMail.
  const richardBox = fakeBox([{ id: "r_titan", name: "Titan" }], { knowsSetAgentMail: false });

  const alpha = tenantRow("alpha", { gateway: await alphaBox.start() });
  const beta = tenantRow("beta", { gateway: await betaBox.start() });
  const richard = tenantRow("richard-avery", { gateway: await richardBox.start() });

  // Alpha claims the product domain, so alpha's edge is the one Resend reaches. Beta claims a
  // domain of its own, which has to keep working exactly as it did.
  writeFileSync(path.join(alpha.state, "mail.json"), JSON.stringify({
    enabled: true, domain: DOMAIN, webhookSecret: SECRET, apiKey: "re_test", catchAllAgentId: "a_titan",
  }));
  writeFileSync(path.join(beta.state, "mail.json"), JSON.stringify({
    enabled: true, domain: "acme.test", webhookSecret: SECRET, apiKey: "re_test", catchAllAgentId: "b_titan",
  }));

  const relay = await startRelay({
    SAND_UI_TENANTS_FILE: tenantsFile([alpha.row, beta.row, richard.row]),
    CP_URL: cpUrl, CP_RELAY_TOKEN: RELAY_TOKEN,
    GROK_BOT_MAIL_API_BASE: resendUrl,
    // Alpha is the workspace whose Resend account holds myagents.email on this console, which is
    // what makes its edge the one a per-bot code may be resolved on. On the R750 that workspace is
    // the operator's and this variable is not set at all.
    CP_MAIL_OWNER_SLUG: "alpha",
    // And which workspaces this relay must not write inside. Empty in the product; an operator
    // sets it, which is the whole point of the setting.
    SAND_UI_MAIL_NO_PUSH_SLUGS: noPush,
    // MAIL-3, and a SEPARATE list from the one above: not-pushed is about a box on an old bundle,
    // not-allowed-to-send is about custody. A workspace that is never pushed still holds a valid
    // gateway token and could call the send route anyway.
    SAND_UI_MAIL_NO_SEND_SLUGS: noSend,
    // A relay container's environment is fixed when the container is made, and a live console is
    // not recreated to stop one workspace sending for an afternoon. So a file of one slug per line
    // beside the rest of the relay's state does it too, and that is the mechanism the ship plan
    // actually uses -- which is why it is the mechanism a test drives.
    ...(noSendFile == null ? {} : { SAND_UI_MAIL_NO_SEND_FILE: noSendFile }),
  }, { prefix: "relay-mail-directory-", pathValue: "/nonexistent" });

  // The sweep runs at start. Wait for it rather than racing it.
  await waitFor(() => cp.seen.mint.length >= 3, "the relay's first mint sweep");
  await waitFor(() => store.listMailAddresses("beta").length === 2, "beta's addresses");

  return {
    relay, cp, store, alpha, beta, richard, alphaBox, betaBox, richardBox, senders, outbound,
    /** POST /mail/send as a box would: the box's own gateway token and nothing else. */
    send(token, body) {
      return fetch(`${relay.base}/mail/send`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token == null ? {} : { authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
      });
    },
    codeOf(slug, agentId) {
      const row = store.listMailAddresses(slug).find((one) => one.agentId === agentId);
      if (row == null) throw new Error(`${slug}/${agentId} has no address`);
      return row.address;
    },
    stop() {
      relay.stop(); cp.stop(); resend.stop();
      alphaBox.stop(); betaBox.stop(); richardBox.stop(); store.close();
    },
  };
}

test("the relay sweeps every workspace, mints what is missing, and leaves a read-only box alone", async () => {
  const world = await console3();
  try {
    assert.deepEqual([...world.cp.seen.mint].sort(), ["alpha", "beta", "richard-avery"]);
    // Two bots in alpha, two in beta, one for Richard. The group chat, had there been one, is not
    // a bot and gets nothing.
    assert.equal(world.store.listMailAddresses("alpha").length, 2);
    assert.equal(world.store.listMailAddresses("beta").length, 2);
    assert.equal(world.store.listMailAddresses("richard-avery").length, 1, "Richard's codes are minted even though his box is not touched");
    for (const row of world.store.listMailAddresses()) assert.match(row.address, /^agent\d{6}@myagents\.email$/);

    // The push into the box, which is the only part that writes inside one.
    assert.ok(world.alphaBox.seen.some((one) => one.command === "setAgentMail"), "alpha's box was told its addresses");
    assert.ok(world.betaBox.seen.some((one) => one.command === "setAgentMail"), "beta's box was told its addresses");
    assert.equal(world.richardBox.seen.some((one) => one.command === "setAgentMail"), false,
      "nothing was written inside the box the operator named read-only");

    // Beta's box is on the current bundle, alpha's too; the push carries the addresses and no key.
    const pushed = world.alphaBox.seen.find((one) => one.command === "setAgentMail");
    assert.equal(pushed.args.domain, DOMAIN);
    assert.equal(pushed.args.canSend, true, "the relay carries the send route, so the box is told its bots can send");
    assert.equal(pushed.args.addresses.length, 2);
    assert.equal(JSON.stringify(pushed.args).includes("re_test"), false, "no key is ever in that push");
  } finally { world.stop(); }
});

test("the read-only list is an operator's setting and the product ships with it empty", async () => {
  // The slug that was in this list on 2026-09-09 was a live customer's, written into the relay's
  // source with nothing that would ever take it out. With no setting every workspace is pushed to,
  // which is the behaviour every deployment of this product gets.
  const world = await console3({ noPush: "" });
  try {
    await waitFor(() => world.richardBox.seen.some((one) => one.command === "setAgentMail"),
      "the push into a workspace nobody asked to be left alone");
  } finally { world.stop(); }
});

test("a box on an older bundle refuses setAgentMail and mail is delivered to it anyway", async () => {
  // Richard's box answers "unknown gateway method". The claim is that this changes nothing about
  // delivery: the file only decides what a bot can SAY about its own address.
  const world = await console3();
  try {
    const address = world.codeOf("richard-avery", "r_titan");
    const response = await post(world.relay, event(address));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).delivered?.slug, "richard-avery");
    assert.equal(world.richardBox.prompts().length, 1, "the message reached his Titan");
  } finally { world.stop(); }
});

test("a code address reaches the bot that holds it, in its own workspace, and writes that workspace a ledger row", async () => {
  const world = await console3();
  try {
    const address = world.codeOf("beta", "b_scribe");
    const response = await post(world.relay, event(address));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.delivered?.agentId, "b_scribe");
    assert.equal(body.delivered?.slug, "beta");

    assert.equal(world.betaBox.prompts().length, 1, "beta's Scribe got it");
    assert.equal(world.alphaBox.prompts().length, 0, "and the workspace that received the webhook did not");
    const prompt = world.betaBox.prompts()[0].args.prompt;
    assert.match(prompt, new RegExp(`Email received at ${address}`));
    assert.match(prompt, new RegExp(`You can reply from your own address \\(${address}\\)`),
      "a bot answers as itself, which is the whole of MAIL-2");

    // The customer's own mail card shows what arrived for their bots, not only the door it came in.
    await waitFor(() => ledgerOf(world.beta.state).some((row) => row.outcome === "delivered"), "beta's ledger row");
    const row = ledgerOf(world.beta.state).find((one) => one.outcome === "delivered");
    assert.equal(row.agentId, "b_scribe");
    assert.equal(row.to, address);
  } finally { world.stop(); }
});

test("an address nobody holds answers no_route and never reaches the catch-all", async () => {
  const world = await console3();
  try {
    const response = await post(world.relay, event(`agent999999@${DOMAIN}`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ignored: "no_route" });
    // THIS is the leak that closes. Before MAIL-2 the localpart matched nothing, so the router fell
    // to the catch-all, which on the workspace claiming the domain is its own Titan.
    assert.equal(world.alphaBox.prompts().length, 0, "the operator's Titan was not handed a stranger's mail");
    assert.equal(world.betaBox.prompts().length, 0);
    assert.equal(world.richardBox.prompts().length, 0);
    await waitFor(() => ledgerOf(world.alpha.state).some((row) => row.outcome === "no_route"), "the no_route row");
  } finally { world.stop(); }
});

test("a name address still arrives, carrying the retiring line and the stop date", async () => {
  const world = await console3();
  try {
    const response = await post(world.relay, event(`books@${DOMAIN}`));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).delivered?.agentId, "a_books");
    const prompt = world.alphaBox.prompts()[0].args.prompt;
    assert.match(prompt, /2026-10-01/);
    assert.match(prompt, new RegExp(`Your own address is ${world.codeOf("alpha", "a_books")}`));
    await waitFor(() => ledgerOf(world.alpha.state).some((row) => row.outcome === "legacy_name"), "the legacy_name row");
  } finally { world.stop(); }
});

test("a customer's own domain keeps routing exactly as it did, and no directory is read for it", async () => {
  const world = await console3();
  try {
    const before = world.cp.seen.directory;
    // Beta claims acme.test, so beta's edge takes this, its directory domain does not match, and
    // its own routing (name, then catch-all) decides -- which is the behaviour a customer with
    // their own domain has today and must keep.
    const response = await post(world.relay, event("scribe@acme.test"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).delivered?.agentId, "b_scribe");
    assert.equal(world.cp.seen.directory, before, "not our domain, so nothing about our directory was read");
  } finally { world.stop(); }
});

test("a body signed with the wrong secret is 401 and nothing is looked up", async () => {
  const world = await console3();
  try {
    const before = world.cp.seen.directory;
    const address = world.codeOf("beta", "b_titan");
    const response = await post(world.relay, event(address), `whsec_${Buffer.from("not the secret").toString("base64")}`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_signature" });
    assert.equal(world.betaBox.prompts().length, 0);
    assert.equal(world.cp.seen.directory, before);
  } finally { world.stop(); }
});

test("with approved senders on, a stranger is refused and an allowed address is not", async () => {
  const world = await console3();
  try {
    world.cp.directory.setApprovedSendersOnly("beta", true, "a test");
    world.store.allowSender("beta", "noreply@stripe.test");
    // The relay reads the switch on its next directory refresh, which a miss triggers.
    await fetch(`${world.relay.base}/mail/sweep`, { method: "POST", headers: { authorization: `Bearer ${RELAY_TOKEN}` } });

    const address = world.codeOf("beta", "b_titan");
    world.senders.set("em_stranger", "someone@nowhere.test");
    world.senders.set("em_allowed", "Stripe <noreply@stripe.test>");
    const stranger = await post(world.relay, event(address, `em_stranger`, "someone@nowhere.test"));
    assert.deepEqual(await stranger.json(), { ignored: "sender_not_approved" });
    assert.equal(world.betaBox.prompts().length, 0);

    const allowed = await post(world.relay, event(address, `em_allowed`, "noreply@stripe.test"));
    assert.equal((await allowed.json()).delivered?.agentId, "b_titan");
    assert.equal(world.betaBox.prompts().length, 1);
  } finally { world.stop(); }
});

test("the sweep route is the control plane's, and a console session does not open it", async () => {
  const world = await console3();
  try {
    assert.equal((await fetch(`${world.relay.base}/mail/sweep`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${world.relay.base}/mail/sweep`, { method: "POST", headers: { authorization: "Bearer not-the-token" } })).status, 401);
    assert.equal((await fetch(`${world.relay.base}/mail/sweep`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } })).status, 405);
    const ok = await fetch(`${world.relay.base}/mail/sweep`, { method: "POST", headers: { authorization: `Bearer ${RELAY_TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
  } finally { world.stop(); }
});

// ---- POST /mail/send, against a running relay (MAIL-3) ------------------------------------------
//
// The rules of the route are walked case by case in tests/mail-send-route.test.mjs, where a failure
// names the rule that broke. What only a real relay can prove is the DOOR: that the route is
// mounted at all, that it sits in front of the console's login, that a box's own gateway token is
// what opens it, and that the whole path from that token to Resend's request body is wired the way
// the pieces say it is.

test("a box's own gateway token sends from its bot's address, and the From is not the caller's to choose", async () => {
  const world = await console3();
  try {
    const address = world.codeOf("alpha", "a_titan");
    const answer = await world.send(world.alpha.row.token, {
      agentId: "a_titan",
      to: "jane@client.example",
      subject: "September invoice",
      text: "Here it is.",
      // Everything a bot might guess at, ignored rather than honoured.
      from: "Titan <titan@titaniumcomputing.test>",
      replyTo: "someone@else.example",
      headers: { From: "billing@bank.example" },
    });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.equal(body.sent, true);
    assert.equal(body.from, `"Titan (alpha)" <${address}>`);
    assert.match(body.message, new RegExp(`^Sent to jane@client\\.example from ${address}\\. Message id `));

    // What actually reached Resend, over the wire, with the relay's own stored key on it.
    assert.equal(world.outbound.length, 1);
    assert.equal(world.outbound[0].body.from, `"Titan (alpha)" <${address}>`);
    assert.equal(world.outbound[0].body.reply_to, address);
    assert.deepEqual(world.outbound[0].body.to, ["jane@client.example"]);
    assert.equal(world.outbound[0].headers.authorization, "Bearer re_test");
    const sent = JSON.stringify(world.outbound[0].body);
    assert.equal(sent.includes("titaniumcomputing.test"), false, "the caller's From never reached Resend");
    assert.equal(sent.includes("someone@else.example"), false, "nor its Reply-To");
    assert.equal(sent.includes("bank.example"), false, "nor its headers");

    // One row on the control plane, settled with Resend's id and carrying no subject.
    const rows = world.store.listMailSends("alpha", 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "sent");
    assert.equal(rows[0].to, "jane@client.example");
    assert.equal(rows[0].agentName, "Titan");
    assert.equal(JSON.stringify(rows[0]).includes("September"), false);

    // And the readable row, with the subject, on that workspace's OWN volume.
    const ledger = ledgerOf(world.alpha.state).concat(sentLedgerOf(world.alpha.state));
    const line = sentLedgerOf(world.alpha.state).at(-1);
    assert.equal(line.subject, "September invoice");
    assert.equal(line.to, "jane@client.example");
    assert.equal(line.outcome, "sent");
    assert.equal(line.from, `"Titan (alpha)" <${address}>`);
    void ledger;
  } finally { world.stop(); }
});

test("the send route is in front of the console's login and takes a box token and nothing else", async () => {
  const world = await console3();
  try {
    const body = { agentId: "a_titan", to: "jane@client.example", subject: "hi", text: "hi" };
    assert.equal((await world.send(null, body)).status, 401, "no bearer");
    assert.equal((await world.send("a token nobody was given", body)).status, 401, "a token no tenant holds");
    // The console's own credential is not this door's credential, and the relay token is not either.
    assert.equal((await world.send(RELAY_TOKEN, body)).status, 401, "the control plane's token does not send mail");
    assert.equal((await fetch(`${world.relay.base}/mail/send`)).status, 405, "and it is a POST");
    assert.equal(world.outbound.length, 0);
    assert.equal(world.store.listMailSends("alpha", 10).length, 0, "and nothing was claimed either");
  } finally { world.stop(); }
});

test("a bot in another workspace cannot be sent as, whichever box asks", async () => {
  const world = await console3();
  try {
    // Beta's box, naming one of alpha's bots. The bearer proves the workspace, the body does not.
    const answer = await world.send(world.beta.row.token, {
      agentId: "a_titan", to: "jane@client.example", subject: "hi", text: "hi",
    });
    assert.equal(answer.status, 403);
    const body = await answer.json();
    assert.equal(body.sent, false);
    assert.equal(body.error, "no_address");
    assert.equal(world.outbound.length, 0);

    // And it is the SAME sentence a bot with no address at all gets, so nothing about another
    // workspace can be learned by comparing the two.
    const unknown = await world.send(world.beta.row.token, {
      agentId: "b_nobody", to: "jane@client.example", subject: "hi", text: "hi",
    });
    assert.equal((await unknown.json()).message, body.message);
  } finally { world.stop(); }
});

test("a workspace an operator switched sending off for is refused at the route, and its box is told so", async () => {
  // Richard's is the live case: his box is not swapped, so the push never reaches it and it never
  // learns canSend -- but his box holds a valid gateway token and could call this route anyway. An
  // absent push is not a rule, so the rule is the list, and it is read per request.
  const world = await console3({ noPush: "", noSend: "richard-avery" });
  try {
    await waitFor(() => world.richardBox.seen.some((one) => one.command === "setAgentMail"),
      "the push into Richard's box");
    const pushed = world.richardBox.seen.find((one) => one.command === "setAgentMail");
    assert.equal(pushed.args.canSend, false, "a workspace on the no-send list is told its bots cannot send");
    assert.equal(world.alphaBox.seen.find((one) => one.command === "setAgentMail").args.canSend, true,
      "and nobody else moved");

    const answer = await world.send(world.richard.row.token, {
      agentId: "r_titan", to: "jane@client.example", subject: "hi", text: "hi",
    });
    assert.equal(answer.status, 403);
    assert.equal((await answer.json()).error, "sending_off");
    assert.equal(world.outbound.length, 0, "nothing was sent");
    assert.equal(world.store.listMailSends("richard-avery", 10).length, 0, "and nothing was claimed");
  } finally { world.stop(); }
});

test("the no-send list is a file the relay reads per request, so a send is stopped without a restart", async () => {
  // This is the mechanism the ship plan uses, so it is the mechanism a test drives: step 3 writes
  // richard-avery into the relay's /state/mail-no-send.txt BEFORE the relay carries the route at
  // all. Per request rather than per sweep, because a send is a thing an operator may want stopped
  // in the next second and not within five minutes.
  const file = path.join(mkdtempSync(path.join(tmpdir(), "relay-no-send-")), "mail-no-send.txt");
  writeFileSync(file, "# one slug per line\nrichard-avery\n");
  const world = await console3({ noPush: "", noSendFile: file });
  try {
    const body = { agentId: "r_titan", to: "jane@client.example", subject: "hi", text: "hi" };
    assert.equal((await world.send(world.richard.row.token, body)).status, 403);
    assert.equal(world.outbound.length, 0);

    // Take the line out and the very next call goes through. Nothing restarted.
    writeFileSync(file, "");
    const after = await world.send(world.richard.row.token, body);
    assert.equal(after.status, 200, "the file is read again on the next request");
    assert.equal(world.outbound.length, 1);
    assert.equal(world.outbound[0].body.from, `"Titan (richard-avery)" <${world.codeOf("richard-avery", "r_titan")}>`);
  } finally { world.stop(); }
});
