// SUPPORT-1. Mail to the operator's support address: the intake's two refusals, the row, the panel,
// the state move, and the one notification that must happen exactly once per message.
//
// The rules this file exists to keep, and each one has a case here that would have caught it
// breaking:
//
//   - THE CREDENTIAL IS `support.inboundToken` AND NOT CP_RELAY_TOKEN. The caller is a Cloudflare
//     Email Worker running in somebody else's datacentre, and CP_RELAY_TOKEN opens the tenant
//     registry, which hands out every customer's gateway token. The relay token must not open this
//     door and this one must not open that one.
//   - A REFUSAL NAMES THE FIELD. The reader of a 400 here is the operator debugging their own Worker.
//   - ONE MESSAGE IS ONE ROW AND ONE NOTIFICATION. Cloudflare retries a Worker that threw or timed
//     out, and a notification costs a model turn in the operator's own workspace.
//   - THE MINTED TOKEN IS ANSWERED ONCE AND IS IN NO OTHER ANSWER, ROW OR LISTING.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { openStore, SUPPORT_STATES } from "../cp/store.mjs";
import {
  LIMITS,
  SUPPORT_INBOUND_TOKEN_SETTING,
  SUPPORT_NOTIFY_AGENT_SETTING,
  SUPPORT_NOTIFY_SETTING,
  SUPPORT_NOTIFY_WORKSPACE_SETTING,
  addressOf,
  createSupport,
  messageIdFor,
  normalizeInbound,
  notificationLine,
  stripHtml,
} from "../cp/support.mjs";
import { boxContainerFor } from "../cp/provision.mjs";
import { makeTempRoot, startControlPlane } from "./cp-support.mjs";

const ADMIN_JS = path.join(import.meta.dirname, "../cp/admin/admin.js");
const ADMIN_HTML = path.join(import.meta.dirname, "../cp/admin/index.html");
const ADMIN_CSS = path.join(import.meta.dirname, "../cp/admin/admin.css");
const PASSWORD = "a-good-password";

async function withStore(run) {
  const root = await makeTempRoot("cp-support-");
  const store = openStore({ dataDir: root });
  try { await run(store, root); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

const MAIL = {
  from: "Jane Doe <jane@example.com>",
  to: "support@titanium.bot",
  subject: "My bots stopped answering this morning",
  text: "Three of them are quiet since about eight. Nothing in the console says why.",
  messageId: "<abc123@mail.example.com>",
  receivedAt: "2026-09-12T08:14:00.000Z",
};

/**
 * A box that answers the two commands a notification makes, counting both.
 *
 * It is a real HTTP server rather than a function double for the route tests, because the route
 * builds its own desk out of `probeImpl` and the point of those cases is the wiring: a notification
 * that works against an injected double and not against an address proves nothing about production.
 */
async function startFakeBox({ agents = [{ id: "agent-titan", name: "Titan", isGroup: false }], refuse = "" } = {}) {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = null;
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; } }
      const command = String(request.url ?? "").replace(/^\/api\//, "");
      calls.push({ command, body, authorization: String(request.headers.authorization ?? "") });
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
      };
      if (refuse === command) return send(500, { error: "no" });
      // listAgents answers a BARE ARRAY on this host build, which is the shape that made a PUSH-1
      // sweep report a clean zero on a box with twelve bots. Both shapes are read; this is the one
      // that is easy to get wrong.
      if (command === "listAgents") return send(200, agents);
      if (command === "sendPrompt") return send(200, { accepted: true });
      return send(404, { error: "not_found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    callsTo: (command) => calls.filter((call) => call.command === command),
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

/**
 * SUPPORT-1d. The SHAPE THE R750 ACTUALLY HAD on 2026-09-13, which is the shape that broke.
 *
 * `titanium` is Jason's own console and the one workspace this service did not build: it was claimed
 * with `tenant adopt`, so its row carries a Coolify service uuid and NO box_container, and its profile
 * directory is under the release root rather than the tenant root. Both reads in cp/support.mjs went
 * looking in the other place -- the column alone for the container, the tenant root for the token --
 * and the first three support mails ever to reach this product answered "no container name on its row"
 * and then "gateway token could not be read" and told nobody. An operator repaired it by writing a
 * database column and a 0600 file on a live server by hand.
 *
 * So this builds the row the way an adoption really builds it and asserts the notification lands. It
 * is a separate fixture from withPlane below on purpose: that one writes the column, and a test that
 * writes the column cannot catch a reader that only reads the column.
 */
async function withAdoptedPlane(run, { box = null, env = {} } = {}) {
  const plane = await startControlPlane({
    env: { ...(box == null ? {} : { CP_BOX_URL_OVERRIDE: box.url }), ...env },
  });
  try {
    const uuid = "p927bfqm83ioloibamlvyd7g";
    plane.store.createTenant({ slug: "titanium", name: "Titanium", status: "adopted", coolifyServiceUuid: uuid });
    assert.equal(plane.store.getTenant("titanium").boxContainer, null,
      "an adopted row with its container written down is not the row this case is about");
    // Where an adoption says this workspace's files are, recorded in the adopt step and nowhere else,
    // which is exactly how POST /v1/tenants/<slug>/adopt records it.
    const profileDir = path.join(plane.config.releaseRoot, "profile");
    plane.store.recordStep({
      slug: "titanium", step: "adopt", status: "ok",
      detail: JSON.stringify({ uuid, host: "console.titanium.bot", stateDir: path.join(plane.config.releaseRoot, "state"), profileDir }),
    });
    const account = plane.store.createAccount({ email: "jason@example.com", password: PASSWORD, tenant: "titanium" });
    plane.store.setSuperAdmin(account.id, true);
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, "local-docker-vm.json"), JSON.stringify({ token: "gateway-token-for-titanium" }), { mode: 0o600 });
    await run(plane, { uuid, profileDir });
  } finally { await plane.dispose(); }
}

/**
 * A control plane with a workspace, a super admin on it, and a gateway token on disk, so the support
 * desk's notification has somewhere real to go.
 */
async function withPlane(run, { box = null, env = {} } = {}) {
  const plane = await startControlPlane({
    env: { ...(box == null ? {} : { CP_BOX_URL_OVERRIDE: box.url }), ...env },
  });
  try {
    plane.store.createTenant({ slug: "titanium", name: "Titanium", status: "running" });
    plane.store.setTenantBox?.("titanium", "titanbot-box-svc-1");
    // The column, written directly when there is no setter, because what the desk reads is the row.
    plane.store.db.prepare("UPDATE tenants SET box_container = ? WHERE slug = ?").run("titanbot-box-svc-1", "titanium");
    const account = plane.store.createAccount({ email: "jason@example.com", password: PASSWORD, tenant: "titanium" });
    plane.store.setSuperAdmin(account.id, true);
    // The gateway token lives in the tenant's profile directory, 0600, and readGatewayToken is what
    // the desk uses to reach the box. Written here the way provisioning writes it.
    const profile = path.join(plane.config.tenantRoot, "titanium", "profile");
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, "local-docker-vm.json"), JSON.stringify({ token: "gateway-token-for-titanium" }), { mode: 0o600 });
    await run(plane);
  } finally { await plane.dispose(); }
}

/** The bearer the worker presents, minted through the console's own door. */
async function mint(plane) {
  const answer = await plane.admin("POST", "/v1/admin/support/token", {});
  assert.equal(answer.status, 200, answer.text);
  assert.equal(typeof answer.body.token, "string");
  assert.ok(answer.body.token.length > 32, "a minted token that short is not a credential");
  return answer.body.token;
}

// ---- the payload --------------------------------------------------------------------------------

test("a delivery keeps what it knows, clamps the one-liners and drops everything else", () => {
  const normalized = normalizeInbound({
    ...MAIL,
    subject: "x".repeat(LIMITS.subject + 200),
    // Nothing takes a state, a note or an id from a body.
    state: "closed",
    notes: "written by the sender",
    id: 91,
    surprise: { deeply: { nested: "thing" } },
  });
  assert.equal(normalized.ok, true, normalized.why);
  const message = normalized.message;
  assert.equal(message.subject.length, LIMITS.subject, "the subject is one line and clamped");
  assert.equal(message.from, "jane@example.com", "the address comes out of the angle brackets");
  assert.equal(message.state, "new", "a delivery is always new whatever the body said");
  assert.equal(message.notes, undefined, "a sender cannot write the operator's note");
  assert.equal(message.id, undefined);
  assert.equal(message.surprise, undefined, "an unknown key is dropped");
  assert.equal(message.receivedAt, Date.parse(MAIL.receivedAt), "the worker's own stamp is kept");
});

test("a delivery with no sender, no words or an oversized part is refused with the field named", () => {
  const cases = [
    [{ ...MAIL, from: "" }, "from", /needs from/],
    [{ ...MAIL, from: undefined }, "from", /needs from/],
    [{ ...MAIL, text: "", html: "" }, "text", /needs text or html/],
    [{ ...MAIL, text: "y".repeat(LIMITS.text + 1) }, "text", /at most \d+ are carried/],
    [{ ...MAIL, text: "", html: "z".repeat(LIMITS.html + 1) }, "html", /at most \d+ are carried/],
    // Markup with no words in it at all is not a message, and saying so names html rather than text,
    // because html is the key the worker sent.
    [{ ...MAIL, text: "", html: "<div><span></span></div>" }, "html", /no words in it/],
    ["not an object", "body", /JSON object/],
    [null, "body", /JSON object/],
    [[MAIL], "body", /JSON object/],
  ];
  for (const [body, field, why] of cases) {
    const normalized = normalizeInbound(body);
    assert.equal(normalized.ok, false, `${JSON.stringify(body).slice(0, 40)} was accepted`);
    assert.equal(normalized.field, field, `the refusal named ${normalized.field} rather than ${field}`);
    assert.match(normalized.why, why);
  }
});

test("an html mail is reduced to its words, and a script or a style block's contents do not survive", () => {
  const flattened = stripHtml(
    "<style>.x{color:red}</style><p>Hello there.</p><script>alert('hi')</script><p>Second &amp; last.</p>",
  );
  assert.match(flattened, /Hello there\./);
  assert.match(flattened, /Second & last\./);
  assert.equal(flattened.includes("color:red"), false, "a style block's contents reached the panel as text");
  assert.equal(flattened.includes("alert"), false, "a script's contents reached the panel as text");
  // A tag becomes a break or a space and never nothing, or two sentences read as one word.
  assert.equal(stripHtml("Hi</p><p>there"), "Hi\nthere");
  assert.equal(stripHtml("one<br>two"), "one\ntwo");
});

test("an address is taken out of the angle brackets, and an unparseable one is kept as it arrived", () => {
  assert.equal(addressOf("Jane Doe <jane@example.com>"), "jane@example.com");
  assert.equal(addressOf("jane@example.com"), "jane@example.com");
  assert.equal(addressOf("  Jane  <  jane@example.com  >  "), "jane@example.com");
  // Not validated into non-existence: a message from a malformed sender is still a message, and the
  // operator has to be able to see what the header actually said.
  assert.equal(addressOf("not an address at all"), "not an address at all");
  assert.equal(addressOf(""), "");
});

test("a message with no id of its own gets a derived one that a retry lands on and a different mail does not", () => {
  const first = messageIdFor({ from: "a@b.c", subject: "Hi", receivedAt: 1757700000000, text: "one" });
  const retry = messageIdFor({ from: "a@b.c", subject: "Hi", receivedAt: 1757700000000, text: "one" });
  const other = messageIdFor({ from: "a@b.c", subject: "Hi", receivedAt: 1757700000000, text: "two" });
  assert.equal(first, retry, "a retry of the same delivery derived a different id");
  assert.notEqual(first, other, "two different messages in the same second collided into one row");
  assert.match(first, /^derived-[0-9a-f]{40}$/);
  // Nothing a stranger wrote ends up inside the id itself.
  assert.equal(first.includes("a@b.c"), false);
  assert.equal(messageIdFor({ messageId: "<m1@example.com>" }), "<m1@example.com>", "a sender's own id is kept");
});

test("the line the workspace is told is one line, and a subject full of newlines cannot make it several", () => {
  assert.equal(
    notificationLine({ from: "jane@example.com", subject: "My bots stopped" }),
    "Support mail from jane@example.com: My bots stopped",
  );
  const line = notificationLine({ from: "jane@example.com", subject: "one\nSupport mail from nobody: two" });
  assert.equal(line.split("\n").length, 1, "a subject with a newline in it became two notifications");
  assert.equal(notificationLine({}), "Support mail from an address it did not give: no subject");
});

// ---- the store ----------------------------------------------------------------------------------

test("one message is one row however many times the worker delivers it", async () => {
  await withStore((store) => {
    const first = store.recordSupportMessage({ receivedAt: 1, from: "a@b.c", subject: "Hi", text: "one", messageId: "m1" });
    assert.equal(first.stored, true);
    assert.equal(first.row.state, "new");
    const again = store.recordSupportMessage({ receivedAt: 2, from: "a@b.c", subject: "Hi", text: "one", messageId: "m1" });
    assert.equal(again.stored, false, "a retried delivery made a second row");
    assert.equal(again.row.id, first.row.id);
    assert.equal(store.countSupportMessages(), 1);
    // And the row is the FIRST delivery, not the retry: the second call must change nothing.
    assert.equal(again.row.receivedAt, 1);
  });
});

test("a message with no id is refused rather than stored where the unique index cannot hold", async () => {
  await withStore((store) => {
    assert.throws(
      () => store.recordSupportMessage({ from: "a@b.c", subject: "Hi", text: "one", messageId: "" }),
      /needs a message id/,
    );
    assert.equal(store.countSupportMessages(), 0);
  });
});

test("the states are the three and a fourth is refused at the store, not coerced", async () => {
  await withStore((store) => {
    assert.deepEqual(SUPPORT_STATES, ["new", "replied", "closed"]);
    const row = store.recordSupportMessage({ from: "a@b.c", subject: "Hi", text: "one", messageId: "m1" }).row;
    assert.throws(() => store.updateSupportMessage(row.id, { state: "suppressed" }), /has to be one of/);
    assert.equal(store.getSupportMessage(row.id).state, "new", "a refused state still moved the row");
    assert.throws(() => store.recordSupportMessage({ from: "a@b.c", subject: "x", text: "y", messageId: "m2", state: "open" }), /has to be one of/);
  });
});

test("the list is newest first, filters in sqlite, and the counts are over everything", async () => {
  await withStore((store) => {
    for (const [n, state] of [[1, "new"], [2, "replied"], [3, "closed"], [4, "new"]]) {
      const row = store.recordSupportMessage({ receivedAt: n * 1000, from: `p${n}@b.c`, subject: `S${n}`, text: "x", messageId: `m${n}` }).row;
      if (state !== "new") store.updateSupportMessage(row.id, { state });
    }
    assert.deepEqual(store.listSupportMessages({}).map((row) => row.subject), ["S4", "S3", "S2", "S1"]);
    assert.deepEqual(store.listSupportMessages({ state: "new" }).map((row) => row.subject), ["S4", "S1"]);
    assert.deepEqual(store.countSupportByState(), { new: 2, replied: 1, closed: 1 });
    assert.equal(store.countSupportMessages(), 4);
    assert.equal(store.listSupportMessages({ sinceMs: 3000 }).length, 2, "the since filter is applied");
  });
});

// ---- the relay intake ---------------------------------------------------------------------------

test("the intake says what is wrong when no token has been minted, and it is not a 401", async () => {
  await withPlane(async (plane) => {
    const answer = await plane.request("POST", "/v1/relay/support", { body: MAIL, token: "anything-at-all" });
    assert.equal(answer.status, 503, answer.text);
    assert.equal(answer.body.error, "not_configured");
    // There is nothing wrong with the caller, and telling the operator so is the difference between a
    // ten minute fix and an hour of reading a Worker's logs.
    assert.match(answer.body.message, /support\.inboundToken/);
    assert.match(answer.body.message, /Support panel/);
    assert.equal(plane.store.countSupportMessages(), 0);
  });
});

test("the intake refuses a bad bearer, no bearer, and the relay's own credential", async () => {
  const relayToken = `relay-${randomBytes(16).toString("hex")}`;
  await withPlane(async (plane) => {
    await mint(plane);
    const refused = [
      await plane.request("POST", "/v1/relay/support", { body: MAIL }),
      await plane.request("POST", "/v1/relay/support", { body: MAIL, token: "wrong-token" }),
      // THE TWO DOORS STAY SEPARATE. CP_RELAY_TOKEN opens GET /v1/relay/tenants, which hands out
      // every customer's gateway token and derived session key. A Cloudflare Worker holding it would
      // be one leaked environment away from the fleet, so it must not open this route either.
      await plane.request("POST", "/v1/relay/support", { body: MAIL, token: relayToken }),
      // And the operator's own bearer does not open it: this is not an operator route.
      await plane.admin("POST", "/v1/relay/support", MAIL),
    ];
    for (const answer of refused) {
      assert.equal(answer.status, 401, answer.text);
      assert.equal(answer.body.error, "unauthorized");
    }
    assert.equal(plane.store.countSupportMessages(), 0, "a refused delivery stored something");

    // And the relay's own route still works with that credential, so the separation above is a
    // measurement of two doors rather than of one broken token.
    const registry = await plane.request("GET", "/v1/relay/tenants", { token: relayToken });
    assert.equal(registry.status, 200, registry.text);
  }, { env: { CP_RELAY_TOKEN: relayToken } });
});

test("the intake refuses a bad body with the field named, and a wrong method before anything else", async () => {
  await withPlane(async (plane) => {
    const token = await mint(plane);
    const noSender = await plane.request("POST", "/v1/relay/support", { body: { ...MAIL, from: "" }, token });
    assert.equal(noSender.status, 400, noSender.text);
    assert.equal(noSender.body.error, "bad_request");
    assert.equal(noSender.body.field, "from");
    assert.match(noSender.body.message, /needs from/);

    const empty = await plane.request("POST", "/v1/relay/support", { body: { from: "a@b.c", subject: "Hi" }, token });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.field, "text");

    const tooBig = await plane.request("POST", "/v1/relay/support", { body: { ...MAIL, text: "y".repeat(LIMITS.text + 10) }, token });
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.body.field, "text");
    assert.match(tooBig.body.message, /Clip it in the worker/);

    // The method refusal comes first, before the credential, so a wrong method learns nothing.
    const wrongMethod = await plane.request("GET", "/v1/relay/support");
    assert.equal(wrongMethod.status, 405, wrongMethod.text);
    assert.equal(plane.store.countSupportMessages(), 0);
  });
});

test("SUPPORT-1d: an adopted workspace with no container column and its profile elsewhere is still told", async () => {
  const box = await startFakeBox();
  try {
    await withAdoptedPlane(async (plane, { uuid }) => {
      const token = await mint(plane);
      const answer = await plane.request("POST", "/v1/relay/support", { body: MAIL, token });
      assert.equal(answer.status, 201, answer.text);
      // THE TWO SENTENCES THAT WERE THE BUG. Either one of them here means the mail landed and nobody
      // heard about it, which is what happened to the first three.
      assert.doesNotMatch(String(answer.body.notifyWhy ?? ""), /no container name on its row/);
      assert.doesNotMatch(String(answer.body.notifyWhy ?? ""), /gateway token could not be read/);
      assert.equal(answer.body.notified, true, answer.text);

      const rows = plane.store.listSupportMessages({});
      assert.match(rows[0].notifyDetail, /Titan in titanium was told/);
      assert.ok(rows[0].notifiedAt > 0);

      // The name it used is the one Coolify gives a service, derived from the uuid on the row by the
      // one helper every reader in this service shares.
      assert.equal(boxContainerFor(plane.store.getTenant("titanium")), `titanbot-box-${uuid}`);
      assert.deepEqual(box.calls.map((call) => call.command), ["listAgents", "sendPrompt"]);
      assert.equal(box.callsTo("sendPrompt")[0].authorization, "Bearer gateway-token-for-titanium",
        "the token came out of the directory the adoption named, which is the read that used to miss");
    }, { box });
  } finally { await box.close(); }
});

test("a good delivery is stored, and the operator's workspace is told once", async () => {
  const box = await startFakeBox();
  try {
    await withPlane(async (plane) => {
      const token = await mint(plane);
      const answer = await plane.request("POST", "/v1/relay/support", { body: MAIL, token });
      assert.equal(answer.status, 201, answer.text);
      assert.equal(answer.body.duplicate, false);
      assert.equal(answer.body.notified, true, answer.text);
      assert.equal(answer.body.notifyWhy, "");

      const rows = plane.store.listSupportMessages({});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].from, "jane@example.com");
      assert.equal(rows[0].subject, MAIL.subject);
      assert.equal(rows[0].text, MAIL.text);
      assert.equal(rows[0].state, "new");
      assert.ok(rows[0].notifiedAt > 0, "the row carries no receipt for a notification that was made");
      assert.match(rows[0].notifyDetail, /Titan in titanium was told/);

      // THE TWO CALLS AND NO OTHERS. One roster read, which costs nothing, and one prompt, which is
      // one model turn in the operator's own workspace. That turn is the whole cost of this feature
      // and a second one per message would double it.
      assert.deepEqual(box.calls.map((call) => call.command), ["listAgents", "sendPrompt"]);
      const prompt = box.callsTo("sendPrompt")[0];
      assert.equal(prompt.body.agentId, "agent-titan");
      assert.equal(prompt.body.prompt, `Support mail from jane@example.com: ${MAIL.subject}`);
      assert.equal(prompt.body.clientNonce, `support:${MAIL.messageId}`);
      // The box is reached with that workspace's own gateway token and with nothing else.
      assert.equal(prompt.authorization, "Bearer gateway-token-for-titanium");
    }, { box });
  } finally { await box.close(); }
});

test("a retried delivery is one row and one notification, and it answers 200 so the worker stops", async () => {
  const box = await startFakeBox();
  try {
    await withPlane(async (plane) => {
      const token = await mint(plane);
      const first = await plane.request("POST", "/v1/relay/support", { body: MAIL, token });
      assert.equal(first.status, 201, first.text);

      const again = await plane.request("POST", "/v1/relay/support", { body: MAIL, token });
      // 200 and not 409: a Worker that sees anything but a 2xx tries again, and this delivery has in
      // fact already succeeded.
      assert.equal(again.status, 200, again.text);
      assert.equal(again.body.duplicate, true);
      assert.equal(again.body.id, first.body.id);
      assert.equal(again.body.notified, true);

      assert.equal(plane.store.countSupportMessages(), 1, "a retry made a second row");
      assert.equal(box.callsTo("sendPrompt").length, 1, "a retry cost a second model turn");
    }, { box });
  } finally { await box.close(); }
});

test("a message still lands when nobody can be told, and the row says so rather than implying it went", async () => {
  // A box whose roster cannot be read, which is what a restarting gateway looks like from here.
  const box = await startFakeBox({ refuse: "listAgents" });
  try {
    await withPlane(async (plane) => {
      const token = await mint(plane);
      const answer = await plane.request("POST", "/v1/relay/support", { body: MAIL, token });
      // 201, because the message IS stored. A 500 here would have Cloudflare retry a delivery that
      // already succeeded, and the message would be announced the moment the box came back anyway.
      assert.equal(answer.status, 201, answer.text);
      assert.equal(answer.body.notified, false);
      assert.match(answer.body.notifyWhy, /roster could not be read/);
      const row = plane.store.listSupportMessages({})[0];
      assert.equal(row.notifiedAt, 0, "a failed notification stamped a time");
      assert.match(row.notifyDetail, /roster could not be read/);
      assert.equal(box.callsTo("sendPrompt").length, 0, "a prompt went to a box whose roster was unreadable");
    }, { box });
  } finally { await box.close(); }
});

test("the bot and the workspace can be named, and naming the bot costs no roster read", async () => {
  const box = await startFakeBox();
  try {
    await withPlane(async (plane) => {
      plane.store.setSetting(SUPPORT_NOTIFY_WORKSPACE_SETTING, "titanium", "the test");
      plane.store.setSetting(SUPPORT_NOTIFY_AGENT_SETTING, "agent-chosen", "the test");
      const token = await mint(plane);
      const answer = await plane.request("POST", "/v1/relay/support", { body: MAIL, token });
      assert.equal(answer.status, 201, answer.text);
      assert.equal(answer.body.notified, true, answer.text);
      assert.deepEqual(box.calls.map((call) => call.command), ["sendPrompt"], "a named bot still cost a roster read");
      assert.equal(box.callsTo("sendPrompt")[0].body.agentId, "agent-chosen");
    }, { box });
  } finally { await box.close(); }
});

test("announcing can be switched off, and then a message is stored and nothing is prompted", async () => {
  const box = await startFakeBox();
  try {
    await withPlane(async (plane) => {
      plane.store.setSetting(SUPPORT_NOTIFY_SETTING, "0", "the test");
      const token = await mint(plane);
      const answer = await plane.request("POST", "/v1/relay/support", { body: MAIL, token });
      assert.equal(answer.status, 201, answer.text);
      assert.equal(answer.body.notified, false);
      assert.match(answer.body.notifyWhy, /is off/);
      assert.equal(box.calls.length, 0, "a box was reached with announcing switched off");
      assert.equal(plane.store.countSupportMessages(), 1);
    }, { box });
  } finally { await box.close(); }
});

test("a control plane with no super admin has nobody to tell, and says that in words", async () => {
  await withStore((store) => {
    store.createTenant({ slug: "acme", name: "Acme", status: "running" });
    const desk = createSupport({ store, boxCall: async () => ({ ok: true, body: {} }) });
    const target = desk.notifyTarget();
    assert.equal(target.ok, false);
    assert.match(target.why, /no super admin account has one/);
    // And a workspace named in the setting that does not exist is its own sentence, not a silence.
    store.setSetting(SUPPORT_NOTIFY_WORKSPACE_SETTING, "nowhere", "the test");
    assert.match(desk.notifyTarget().why, /there is no workspace by that name/);
  });
});

// ---- the panel's routes -------------------------------------------------------------------------

test("the panel lists the rows newest first, filters by state, and counts over everything", async () => {
  const box = await startFakeBox();
  try {
    await withPlane(async (plane) => {
      const token = await mint(plane);
      for (const n of [1, 2, 3]) {
        const answer = await plane.request("POST", "/v1/relay/support", {
          body: { ...MAIL, subject: `Question ${n}`, messageId: `<m${n}@example.com>`, receivedAt: new Date(1757700000000 + n * 60000).toISOString() },
          token,
        });
        assert.equal(answer.status, 201, answer.text);
      }

      const panel = await plane.admin("GET", "/v1/admin/support");
      assert.equal(panel.status, 200, panel.text);
      assert.deepEqual(panel.body.rows.map((row) => row.subject), ["Question 3", "Question 2", "Question 1"]);
      assert.deepEqual(panel.body.counts, { new: 3, replied: 0, closed: 0 });
      assert.equal(panel.body.total, 3);
      assert.deepEqual(panel.body.states, SUPPORT_STATES);
      assert.equal(panel.body.notify.workspace, "titanium");
      assert.equal(panel.body.token.stored, true);
      // The one thing this panel does not do, on the screen rather than only in a document.
      assert.match(panel.body.gates, /Nothing is ever sent from here/);
      // Times come back as strings a person reads, and "never notified" is an empty string and not
      // 1970.
      assert.match(panel.body.rows[0].receivedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(panel.body.rows[0].notifiedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(panel.body.rows[0].decidedAt, "");

      const moved = await plane.admin("POST", `/v1/admin/support/${panel.body.rows[0].id}/state`, { state: "closed" });
      assert.equal(moved.status, 200, moved.text);
      const filtered = await plane.admin("GET", "/v1/admin/support?state=new");
      assert.equal(filtered.body.rows.length, 2, "the state filter was not applied");
      // The COUNTS are over everything, not over the filtered list, because the number an operator
      // needs is how many are unanswered and a filter is exactly what hides that.
      assert.deepEqual(filtered.body.counts, { new: 2, replied: 0, closed: 1 });
    }, { box });
  } finally { await box.close(); }
});

test("a state change moves the row, writes a ledger row, and says out loud that nothing was sent", async () => {
  const box = await startFakeBox();
  try {
    await withPlane(async (plane) => {
      const token = await mint(plane);
      const delivered = await plane.request("POST", "/v1/relay/support", { body: MAIL, token });
      const id = delivered.body.id;

      const replied = await plane.admin("POST", `/v1/admin/support/${id}/state`, { state: "replied", notes: "answered from my own mail" });
      assert.equal(replied.status, 200, replied.text);
      assert.equal(replied.body.support.state, "replied");
      assert.equal(replied.body.support.notes, "answered from my own mail");
      // THE SENTENCE IS THE POINT. An operator who thinks pressing a button answered a customer is a
      // customer who never hears back.
      assert.match(replied.body.message, /Nothing was sent from here/);
      assert.equal(plane.store.getSupportMessage(id).decidedBy, "the operator token");

      const reopened = await plane.admin("POST", `/v1/admin/support/${id}/state`, { state: "new" });
      assert.equal(reopened.status, 200, reopened.text);
      assert.equal(reopened.body.support.state, "new");
      // The note survives a state move that does not carry one.
      assert.equal(plane.store.getSupportMessage(id).notes, "answered from my own mail");

      const bad = await plane.admin("POST", `/v1/admin/support/${id}/state`, { state: "suppressed" });
      assert.equal(bad.status, 400, bad.text);
      assert.equal(bad.body.field, "state");
      assert.equal(plane.store.getSupportMessage(id).state, "new", "a refused state still moved the row");

      const missing = await plane.admin("POST", "/v1/admin/support/9999/state", { state: "closed" });
      assert.equal(missing.status, 404, missing.text);

      // Every move is on the record with a name on it, the way every other admin action is.
      const actions = plane.store.listAdminActions({ limit: 50 }).map((row) => row.action);
      assert.ok(actions.includes("support.replied"), `the ledger did not record the move: ${actions.join(", ")}`);
      assert.ok(actions.includes("support.token"), "minting the inbound token was not recorded");
    }, { box });
  } finally { await box.close(); }
});

test("the inbound token is answered once and is in no other answer, row or listing", async () => {
  const box = await startFakeBox();
  try {
    await withPlane(async (plane) => {
      const token = await mint(plane);
      const delivered = await plane.request("POST", "/v1/relay/support", { body: MAIL, token });
      assert.equal(delivered.status, 201, delivered.text);

      const elsewhere = [
        await plane.admin("GET", "/v1/admin/support"),
        await plane.admin("GET", "/v1/admin/actions"),
        await plane.admin("GET", "/v1/admin/system"),
        await plane.admin("GET", "/v1/tenants"),
        await plane.request("GET", "/v1/health"),
        delivered,
      ];
      for (const answer of elsewhere) {
        assert.equal(answer.text.includes(token), false, `the inbound token leaked: ${answer.text.slice(0, 200)}`);
        // Ten characters of a credential is ten characters a log search finds.
        assert.equal(answer.text.includes(token.slice(0, 12)), false, "a prefix of the inbound token leaked");
      }
      // listSettings is what cp/verification.mjs reads, so the name is in SECRET_SETTINGS and the
      // value never comes back. That Set is added to at import by cp/support.mjs rather than edited
      // in cp/store.mjs, and this is the assertion that the line ran.
      const listed = plane.store.listSettings();
      const row = listed.find((one) => one.name === SUPPORT_INBOUND_TOKEN_SETTING);
      assert.ok(row != null, "the inbound token is not in the settings listing at all");
      assert.equal(row.value, "");
      assert.equal(row.redacted, true);
      assert.equal(JSON.stringify(listed).includes(token), false, "listSettings handed the inbound token back");

      // The panel's own read answers a length and eight hex characters of a digest, and never a value.
      const panel = await plane.admin("GET", "/v1/admin/support");
      assert.match(panel.body.token.evidence, /^\d+ characters, sha256 [0-9a-f]{8}$/);

      // Minting again replaces it, so the old worker stops being able to deliver. That is a rotation
      // and the panel says so before the operator presses it.
      const second = await mint(plane);
      assert.notEqual(second, token);
      const withOld = await plane.request("POST", "/v1/relay/support", { body: { ...MAIL, messageId: "<m2@example.com>" }, token });
      assert.equal(withOld.status, 401, withOld.text);
    }, { box });
  } finally { await box.close(); }
});

// ---- the page -----------------------------------------------------------------------------------

test("the console has a Support panel, a rail entry for it and the CSS that came with it", async () => {
  await withPlane(async (plane) => {
    const page = await plane.request("GET", "/admin");
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('data-panel="support"'), "the support panel is not on the page");
    assert.ok(page.text.includes('<a href="#panel-support">Support</a>'), "the rail has no Support entry");
    assert.ok(page.text.includes('id="supportRows"'));
    assert.ok(page.text.includes('id="supportState"'));
    assert.ok(page.text.includes('id="supportTokenForm"'));

    const css = await plane.request("GET", "/admin/admin.css");
    assert.equal(css.status, 200);
    assert.ok(css.text.includes(".supportCard"), "the support card has no styling of its own");
    assert.ok(css.text.includes("#supportTokenValue"), "the minted token has no styling of its own");
  });
});

test("the Support panel's markup carries the rows, the two state buttons and the body on click", () => {
  const source = readFileSync(ADMIN_JS, "utf8");
  const block = /function renderSupportCard\(message\)[\s\S]*?\n  }\n/.exec(source)?.[0] ?? "";
  assert.ok(block.length > 0, "the support card renderer is gone from admin.js");
  // The four things a row has to show.
  assert.match(block, /message\.from/, "the card does not draw who it came from");
  assert.match(block, /message\.subject/, "the card does not draw the subject");
  assert.match(block, /ago\(message\.receivedAt\)/, "the card does not draw when it arrived");
  assert.match(block, /SUPPORT_STATE_CHIP\[message\.state\]/, "the card does not draw the state");
  // The body, behind a details element, which is the "on click" part.
  assert.match(block, /document\.createElement\("details"\)/, "the body is not behind a click");
  assert.match(block, /message\.text \|\| message\.htmlText/, "the card does not fall back to the flattened html");
  // The two state buttons, and the third only on a row that has been moved.
  assert.match(block, /\["replied", "Mark replied"\]/);
  assert.match(block, /\["closed", "Close"\]/);
  assert.match(block, /\["new", "Reopen"\]/);
  assert.match(block, /\/v1\/admin\/support\/\$\{message\.id\}\/state/);
  // And the receipt, because a message nobody was told about has to be visible rather than inferred.
  assert.match(block, /nobody was told about this one/);

  // NOTHING ON THIS CARD IS ASSIGNED AS MARKUP. Every field came from a stranger: anybody on the
  // internet can write to a support address.
  assert.equal(/innerHTML/.test(block), false, "the support card assigns innerHTML somewhere");
  assert.equal(/innerHTML/.test(/async function loadSupport\(\)[\s\S]*?\n  }\n/.exec(source)?.[0] ?? ""), false);

  // The loader is in the refresh and the readiness flag counts it, which is the invariant a browser
  // gate waits on: a panel added to the HTML and not to the loader leaves the flag saying one number
  // while the screen shows another.
  assert.match(source, /api\("GET", `\/v1\/admin\/support\?state=/);
  assert.ok(source.includes("loadSupport()"), "the support panel is not loaded with the others");
  const declared = /window\.__adminLive = \{ panels: (\d+)/.exec(source);
  const loaders = /Promise\.allSettled\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(declared != null && loaders != null);
  assert.equal(
    Number(declared[1]),
    loaders[1].split(",").filter((call) => call.trim().length > 0).length,
    "the live flag counts a different number of panels than the refresh loads",
  );
  // Every panel in the rail is in the PANELS list, or the hash cannot open it and the rail entry is
  // a dead link.
  assert.match(source, /"panel-support"/);
  const rail = [...readFileSync(ADMIN_HTML, "utf8").matchAll(/<a href="#(panel-[a-z-]+)">/g)].map((match) => match[1]);
  const known = /const PANELS = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  for (const id of rail) {
    assert.ok(known.includes(`"${id}"`), `the rail links #${id} and PANELS does not carry it, so that entry opens the Overview`);
  }
  // And the stylesheet is the one the page serves, read off disk here so this case fails even on a
  // tree where the route is broken for another reason.
  assert.ok(readFileSync(ADMIN_CSS, "utf8").includes(".supportCard"));
});
