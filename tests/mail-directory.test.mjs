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
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { signSvix, routeDirectoryFirst, legacyNotice, MAIL_LEGACY_STOP } from "../ui/mail-edge.mjs";
import { openStore } from "../cp/store.mjs";
import { createMailDirectory } from "../cp/mail.mjs";
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
    agents: ROSTER, settings: SETTINGS,
    directoryDomain: DOMAIN,
    directoryRoute: async () => { asked += 1; return null; },
  });
  assert.equal(answer.kind, "elsewhere");
  assert.equal(asked, 0, "nothing at our domain means nothing about our directory is read");
});

test("with no directory configured every message routes the way it always did", async () => {
  const answer = await routeDirectoryFirst({ addresses: [`titan@${DOMAIN}`], agents: ROSTER, settings: SETTINGS });
  assert.equal(answer.kind, "elsewhere");
});

test("a code resolves to the workspace that holds it, and a retired one is refused", async () => {
  const rows = { agent123456: { slug: "demo", agentId: "a_titan", agentName: "Titan", address: `agent123456@${DOMAIN}`, state: "active" },
                 agent222222: { slug: "demo", agentId: "a_old", agentName: "Gone", address: `agent222222@${DOMAIN}`, state: "retired" } };
  const directoryRoute = async (localpart) => rows[localpart] ?? null;

  const found = await routeDirectoryFirst({ addresses: [`agent123456@${DOMAIN}`], agents: ROSTER, settings: SETTINGS, directoryDomain: DOMAIN, directoryRoute });
  assert.equal(found.kind, "code");
  assert.equal(found.route.slug, "demo");
  assert.equal(found.route.agentId, "a_titan");

  const retired = await routeDirectoryFirst({ addresses: [`agent222222@${DOMAIN}`], agents: ROSTER, settings: SETTINGS, directoryDomain: DOMAIN, directoryRoute });
  assert.equal(retired.kind, "no_route");

  const nobody = await routeDirectoryFirst({ addresses: [`agent999999@${DOMAIN}`], agents: ROSTER, settings: SETTINGS, directoryDomain: DOMAIN, directoryRoute });
  assert.equal(nobody.kind, "no_route", "an address nobody holds is nobody's, and not the catch-all's");
});

test("a name address still arrives, with the line that says it is going away, until the stop date", async () => {
  const directoryRoute = async () => null;
  const directoryAddress = async ({ agentId }) => (agentId === "a_books" ? `agent654321@${DOMAIN}` : "");
  const at = Date.parse("2026-09-09T00:00:00Z");

  const legacy = await routeDirectoryFirst({
    addresses: [`books@${DOMAIN}`], agents: ROSTER, settings: SETTINGS,
    directoryDomain: DOMAIN, directoryRoute, directoryAddress, now: () => at,
  });
  assert.equal(legacy.kind, "legacy");
  assert.equal(legacy.route.agentId, "a_books");
  assert.match(legacy.notice, /2026-10-01/);
  assert.match(legacy.notice, /agent654321@myagents\.email/);

  // A name nobody on the roster answers to is not the catch-all's either.
  const guess = await routeDirectoryFirst({
    addresses: [`accounts@${DOMAIN}`], agents: ROSTER, settings: SETTINGS,
    directoryDomain: DOMAIN, directoryRoute, now: () => at,
  });
  assert.equal(guess.kind, "no_route");

  // And after the stop date the notice is not a warning any more, it is the refusal.
  const after = await routeDirectoryFirst({
    addresses: [`books@${DOMAIN}`], agents: ROSTER, settings: SETTINGS,
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
  const seen = { directory: 0, mint: [] };
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
function fakeResend(senders = new Map()) {
  const server = createServer((req, res) => {
    const id = /\/emails\/receiving\/([^/]+)/.exec(req.url)?.[1] ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.endsWith("/attachments")
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

const ledgerOf = (dir) => {
  try {
    return readFileSync(path.join(dir, "mail-inbox.jsonl"), "utf8").split("\n")
      .filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  } catch { return []; }
};

/**
 * A console with three workspaces on it: the one whose card claims myagents.email and receives the
 * webhook, a second one whose bots the mail is actually for, and Richard's, which is a real
 * customer and read-only this wave.
 */
async function console3() {
  const store = openStore({ file: ":memory:" });
  const cp = stubControlPlane(store);
  const cpUrl = await cp.start();
  const senders = new Map();
  const resend = fakeResend(senders);
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
  }, { prefix: "relay-mail-directory-", pathValue: "/nonexistent" });

  // The sweep runs at start. Wait for it rather than racing it.
  await waitFor(() => cp.seen.mint.length >= 3, "the relay's first mint sweep");
  await waitFor(() => store.listMailAddresses("beta").length === 2, "beta's addresses");

  return {
    relay, cp, store, alpha, beta, richard, alphaBox, betaBox, richardBox, senders,
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

test("the relay sweeps every workspace, mints what is missing, and leaves Richard's box alone", async () => {
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
      "nothing was written inside Richard's box: it is a real customer and read-only this wave");

    // Beta's box is on the current bundle, alpha's too; the push carries the addresses and no key.
    const pushed = world.alphaBox.seen.find((one) => one.command === "setAgentMail");
    assert.equal(pushed.args.domain, DOMAIN);
    assert.equal(pushed.args.canSend, false, "sending is unchanged this wave, and the box is told so");
    assert.equal(pushed.args.addresses.length, 2);
    assert.equal(JSON.stringify(pushed.args).includes("re_test"), false, "no key is ever in that push");
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
