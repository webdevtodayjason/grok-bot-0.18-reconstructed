// The relay's send route (MAIL-3, docs/MAIL.md).
//
// THE ORDER OF THE REFUSALS IS THE SECURITY, so every case below is walked on its own and each one
// asserts the thing that must NOT have happened as well as the answer: nothing reached Resend,
// nothing was claimed, no key was read. A route that refuses with the right status after it has
// already sent the mail is not a refusal.
//
// The door itself -- the route being mounted, and a real box's gateway bearer opening it -- is
// proved end to end against a running relay in tests/mail-directory.test.mjs. This file is the
// rules, so a failure here names the rule that broke rather than the request that noticed.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFrom, createMailSendRoute, mailSentLedgerRow, sanitizeFromName,
} from "../ui/mail-edge.mjs";

const OWNER_KEY = "re_the_relays_own_key";
const DOMAIN = "myagents.email";
const ADDRESS = "agent247758@myagents.email";

/** Just enough of a response for a route that only ever writes a head and one JSON body. */
function fakeRes() {
  return {
    status: 0, headers: {}, body: null, ended: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = { ...this.headers, ...headers }; return this; },
    end(payload) { this.ended = true; this.body = payload == null ? null : JSON.parse(String(payload)); return this; },
  };
}

const fakeReq = (body, { method = "POST", token = "gateway-token-for-demo" } = {}) => ({
  method,
  headers: token == null ? {} : { authorization: `Bearer ${token}` },
  raw: typeof body === "string" ? body : JSON.stringify(body ?? {}),
});

/**
 * A route with every collaborator recorded, so a case can assert what was NOT called. Anything a
 * case wants to change it passes in; everything else is the happy path.
 */
function routeWith(overrides = {}) {
  const seen = { resend: [], opened: [], closed: [], sent: [], settingsRead: 0 };
  const route = createMailSendRoute({
    readBody: async (req, max) => {
      if (req.raw.length > max) { const error = new Error("too large"); error.code = "BODY_TOO_LARGE"; throw error; }
      return req.raw;
    },
    drainThenEnd: async (req, res, status, headers, payload) => { res.writeHead(status, headers); res.end(payload); },
    workspaceOf: (bearer) => (bearer === "gateway-token-for-demo" ? { slug: "demo", name: "Demo Company" } : null),
    directoryRowFor: async (slug, agentId) => (slug === "demo" && agentId === "a_titan"
      ? { agentId: "a_titan", code: "247758", address: ADDRESS, agentName: "Titan", state: "active" }
      : null),
    ownerSettings: async () => { seen.settingsRead += 1; return { apiKey: OWNER_KEY, domain: DOMAIN }; },
    directoryDomain: () => DOMAIN,
    noSend: () => false,
    openSend: async (row) => { seen.opened.push(row); return { ok: true, id: 7 }; },
    closeSend: async (id, outcome, resendId, detail) => { seen.closed.push({ id, outcome, resendId, detail }); },
    appendSent: async (slug, row) => { seen.sent.push({ slug, row }); },
    fetchImpl: async (url, init) => {
      seen.resend.push({ url, init, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "49a3999c-0000-4000-8000-000000000000" }) };
    },
    log: () => {},
    ...overrides,
  });
  return { seen, route };
}

const GOOD = { agentId: "a_titan", to: "jane@client.example", subject: "September invoice", text: "Here it is." };

const send = async (body, options = {}, overrides = {}) => {
  const { seen, route } = routeWith(overrides);
  const res = fakeRes();
  await route.handleSend(fakeReq(body, options), res);
  return { seen, res };
};

// ---- the happy path, and what it proves about custody -------------------------------------------

test("a bot with an address sends, and the answer is one plain sentence the model can read back", async () => {
  const { seen, res } = await send(GOOD);
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, true);
  assert.equal(res.body.id, "49a3999c-0000-4000-8000-000000000000");
  assert.equal(res.body.from, `"Titan (demo)" <${ADDRESS}>`);
  assert.equal(res.body.to, "jane@client.example");
  assert.equal(res.body.message,
    `Sent to jane@client.example from ${ADDRESS}. Message id 49a3999c-0000-4000-8000-000000000000.`);
  // `message` is first in the shape because it is what the model reads back verbatim.
  assert.equal(Object.keys(res.body)[0], "message");

  // One POST, at Resend's send route, carrying the relay's own key and nobody else's.
  assert.equal(seen.resend.length, 1);
  assert.match(seen.resend[0].url, /\/emails$/);
  assert.equal(seen.resend[0].init.method, "POST");
  assert.equal(seen.resend[0].init.headers.authorization, `Bearer ${OWNER_KEY}`);
  assert.equal(seen.resend[0].body.to.length, 1, "one recipient per call, so one row is one mail");
});

test("the row is claimed BEFORE Resend is called and closed after it with the id", async () => {
  const order = [];
  const { seen, res } = await send(GOOD, {}, {
    openSend: async (row) => { order.push("open"); return { ok: true, id: 11, row }; },
    closeSend: async (id, outcome, resendId) => { order.push(`close:${id}:${outcome}:${resendId}`); },
    fetchImpl: async () => { order.push("resend"); return { ok: true, status: 200, text: async () => JSON.stringify({ id: "re_1" }) }; },
  });
  assert.equal(res.status, 200);
  // An unsent mail is recoverable; an unlogged send is not. That is the whole reason for the order.
  assert.deepEqual(order, ["open", "resend", "close:11:sent:re_1"]);
  void seen;
});

test("the workspace's own sent ledger carries the subject and the control plane's row does not", async () => {
  const { seen } = await send(GOOD);
  assert.equal(seen.sent.length, 1);
  assert.equal(seen.sent[0].slug, "demo");
  assert.equal(seen.sent[0].row.subject, "September invoice");
  assert.equal(seen.sent[0].row.outcome, "sent");
  assert.equal(seen.sent[0].row.code, "247758");
  // What went to the control plane: addresses and an outcome, and never a subject or a body.
  assert.deepEqual(Object.keys(seen.opened[0]).sort(), ["agentId", "code", "idem", "slug", "to"]);
  assert.equal(JSON.stringify(seen.opened[0]).includes("September"), false);
  assert.equal(JSON.stringify(seen.closed[0]).includes("September"), false);
});

// ---- the From, forced ---------------------------------------------------------------------------

test("a caller-supplied from and reply-to are ignored and never reach Resend", async () => {
  // Ignored rather than refused: a bot that guessed at a field should still get its mail sent, from
  // its own address. What must never happen is the guess being honoured.
  const { seen, res } = await send({
    ...GOOD,
    from: "Titan <titan@titaniumcomputing.com>",
    replyTo: "someone@else.example",
    reply_to: "someone@else.example",
    headers: { From: "billing@bank.example" },
  });
  assert.equal(res.status, 200);
  const body = seen.resend[0].body;
  assert.equal(body.from, `"Titan (demo)" <${ADDRESS}>`);
  assert.equal(body.reply_to, ADDRESS);
  assert.equal(JSON.stringify(body).includes("titaniumcomputing.com"), false, "the caller's From never reached Resend");
  assert.equal(JSON.stringify(body).includes("someone@else.example"), false, "the caller's Reply-To never reached Resend");
  assert.equal(JSON.stringify(body).includes("bank.example"), false, "the caller's headers never reached Resend");
});

test("a display name with a quote, a comma and a newline in it makes one well-formed header line", () => {
  // agent_name is typed by a customer, and live names already carry spaces and a middle dot. CR and
  // LF would end the header line and a quote would end the quoted string.
  const nasty = 'Ti"tan,\r\nBcc: victim@example.com';
  const from = buildFrom({ name: nasty, workspace: "demo", address: ADDRESS });
  assert.equal(from.includes("\r"), false);
  assert.equal(from.includes("\n"), false);
  assert.equal(from, `"Titan, Bcc: victim@example.com (demo)" <${ADDRESS}>`);
  assert.equal((from.match(/"/g) ?? []).length, 2, "exactly the two quotes that open and close the display name");

  // Nothing left after the strip is a bare address, which is a valid From and not a broken one.
  assert.equal(buildFrom({ name: '""', workspace: "", address: ADDRESS }), ADDRESS);
  assert.equal(sanitizeFromName("x".repeat(200)).length, 64, "a name is capped before it goes near a header");
  assert.equal(buildFrom({ name: "Titan", workspace: "demo", address: "" }), "", "no address is no From at all");
});

// ---- the refusal order, one case at a time -------------------------------------------------------

test("a request that is not a POST is refused and reaches nothing", async () => {
  const { seen, res } = await send(GOOD, { method: "GET" });
  assert.equal(res.status, 405);
  assert.equal(res.body.sent, false);
  assert.equal(seen.resend.length + seen.opened.length, 0);
});

test("no bearer, and a bearer no tenant holds, are both refused before the body is read", async () => {
  const missing = await send(GOOD, { token: null });
  assert.equal(missing.res.status, 401);
  assert.equal(missing.seen.resend.length + missing.seen.opened.length, 0);

  const stranger = await send(GOOD, { token: "a token nobody was given" });
  assert.equal(stranger.res.status, 401);
  assert.equal(stranger.seen.resend.length + stranger.seen.opened.length, 0);
  assert.equal(stranger.res.body.message.includes("token"), false, "a refusal never repeats what was presented");
});

test("a workspace on the no-send list is refused at the route, whatever its box was told", async () => {
  // Richard's box holds a valid gateway token and never learns canSend, but an absent push is not a
  // rule. This is the rule.
  const { seen, res } = await send(GOOD, {}, { noSend: (slug) => slug === "demo" });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "sending_off");
  assert.match(res.body.message, /switched off for this workspace/);
  assert.equal(seen.resend.length + seen.opened.length, 0, "nothing was claimed and nothing was sent");
});

test("no address, a retired address and another workspace's bot all meet the same sentence", async () => {
  // One lookup refuses all three, so they cannot drift apart, and they answer alike because a
  // caller must learn nothing about a workspace that is not theirs. MAIL-2c, closed in one line.
  const noRow = await send({ ...GOOD, agentId: "a_new_bot" });
  const foreign = await send({ ...GOOD, agentId: "b_titan" });
  const retired = await send(GOOD, {}, { directoryRowFor: async () => null });
  for (const answer of [noRow, foreign, retired]) {
    assert.equal(answer.res.status, 403);
    assert.equal(answer.res.body.error, "no_address");
    assert.equal(answer.seen.resend.length + answer.seen.opened.length, 0);
  }
  assert.equal(noRow.res.body.message, foreign.res.body.message);
  assert.equal(noRow.res.body.message, retired.res.body.message);
  assert.equal(foreign.res.body.message.includes("workspace"), false, "and it says nothing about another workspace");
});

test("an address at a domain the directory does not own is refused", async () => {
  const { seen, res } = await send(GOOD, {}, {
    directoryRowFor: async () => ({ agentId: "a_titan", code: "247758", address: "titan@somewhere.else", agentName: "Titan", state: "active" }),
  });
  assert.equal(res.status, 403);
  assert.equal(seen.resend.length, 0, "the owner's key is never used to send from a domain it does not hold");
});

test("attachments are refused by name, and an empty or missing field is refused in plain words", async () => {
  const withFile = await send({ ...GOOD, attachments: [{ filename: "invoice.pdf" }] });
  assert.equal(withFile.res.status, 400);
  assert.equal(withFile.res.body.error, "attachments_unsupported");
  assert.match(withFile.res.body.message, /Attachments cannot be sent/);
  assert.equal(withFile.seen.resend.length + withFile.seen.opened.length, 0);

  for (const [body, why] of [
    [{ ...GOOD, agentId: "" }, "no bot"],
    [{ ...GOOD, to: "" }, "no recipient"],
    [{ ...GOOD, to: ["a@b.example", "c@d.example"] }, "more than one recipient"],
    [{ ...GOOD, to: "a@b.example, c@d.example" }, "two in one string"],
    [{ ...GOOD, subject: "" }, "no subject"],
    [{ ...GOOD, text: "", html: "" }, "nothing in it"],
  ]) {
    const answer = await send(body);
    assert.equal(answer.res.status, 400, why);
    assert.equal(answer.seen.resend.length + answer.seen.opened.length, 0, why);
    assert.equal(typeof answer.res.body.message, "string");
    assert.match(answer.res.body.message, /nothing was sent/, why);
  }

  const torn = await send("{not json", {});
  assert.equal(torn.res.status, 400);
  assert.equal(torn.seen.resend.length, 0);
});

test("a body past the cap is refused without being held", async () => {
  const { seen, res } = await send({ ...GOOD, text: "x".repeat(70 * 1024) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "too_large");
  assert.equal(seen.resend.length + seen.opened.length, 0);
});

// ---- the caps, which are the control plane's answer and not this route's ------------------------

test("a cap refusal names the number it hit and sends nothing", async () => {
  const { seen, res } = await send(GOOD, {}, {
    openSend: async () => ({
      ok: false, error: "rate_limited", scope: "agent", cap: 30, retryAfterSeconds: 720,
      message: "That bot has sent its 30 emails for this hour, so nothing was sent. The next one can go in 12 minutes.",
    }),
  });
  assert.equal(res.status, 429);
  assert.match(res.body.message, /30 emails/);
  assert.equal(res.headers["retry-after"], "720");
  assert.equal(seen.resend.length, 0);
});

test("a control plane that cannot be reached stops the send rather than sending unlogged", async () => {
  // Every send is on the record, and that is the entire justification for this route existing. An
  // unsent mail is recoverable; an unlogged send is not.
  const { seen, res } = await send(GOOD, {}, { openSend: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "no_record");
  assert.equal(seen.resend.length, 0, "nothing reached Resend");
  assert.equal(seen.settingsRead, 0, "and the key was never even read");
});

// ---- the key, and Resend saying no ---------------------------------------------------------------

test("the directory owner's key is the one read, and an empty one closes the row and refuses", async () => {
  const { seen, res } = await send(GOOD, {}, { ownerSettings: async () => ({ apiKey: "", domain: DOMAIN }) });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "no_key");
  assert.equal(seen.resend.length, 0);
  // The row is not left reading `sending` for ever when we know why it stopped.
  assert.equal(seen.closed.length, 1);
  assert.equal(seen.closed[0].outcome, "no_key");
  // And the sentence a bot reads aloud points at the one person who can act, and names nothing the
  // person cannot act on: no key, no service, no route.
  assert.match(res.body.message, /Ask your operator/);
  assert.equal(/key|token|secret|Resend|api\./i.test(res.body.message), false, res.body.message);
});

// KEYS-1. The SECOND way the key comes back empty, and it is not the same event.
//
// Since the sending key became the operator's, an empty answer from ownerSettings can mean either
// "nobody has pasted one" or "this relay cannot see the control plane this minute". They are acted on
// by different people: the first is a thing the operator does once, the second is broken and clears
// itself. A row reading `no_key` over the second sends him to paste a key he already pasted.
test("a relay that cannot read the keys the product uses settles key_unreachable, never no_key", async () => {
  const { seen, res } = await send(GOOD, {}, {
    ownerSettings: async () => ({ apiKey: "", domain: DOMAIN }),
    keysBlind: () => true,
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "key_unreachable");
  assert.equal(seen.resend.length, 0, "nothing was sent on a key we could not read");
  assert.equal(seen.closed.length, 1);
  assert.equal(seen.closed[0].outcome, "key_unreachable");
  // It says try again, because it really does clear on its own, and it does not say "you have no
  // key" -- which is the sentence that sends the wrong person to the wrong screen.
  assert.match(res.body.message, /Try again/);
  assert.equal(/no key|not switched on/i.test(res.body.message), false, res.body.message);
  assert.equal(/key|token|secret|Resend|control plane/i.test(res.body.message), false, res.body.message);
});

test("blind is only consulted when there is no key at all: a working key sends whatever the reader says", async () => {
  // The order matters. A relay holding a good copy of a control plane that has since gone down, or a
  // workspace whose own file still carries the key, must send exactly as it always did.
  const { seen, res } = await send(GOOD, {}, { keysBlind: () => true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(seen.resend.length, 1, "a send with a key in hand must not be refused over a reader's mood");
  assert.equal(seen.closed[0].outcome, "sent");
});

test("a keysBlind that throws is read as not blind, so a fault in the reader cannot invent an outage", async () => {
  const { seen, res } = await send(GOOD, {}, {
    ownerSettings: async () => ({ apiKey: "", domain: DOMAIN }),
    keysBlind: () => { throw new Error("the reader is broken"); },
  });
  assert.equal(res.body.error, "no_key");
  assert.equal(seen.closed[0].outcome, "no_key");
});

test("Resend refusing is said in plain words and the row is closed as failed", async () => {
  const { seen, res } = await send(GOOD, {}, {
    fetchImpl: async () => ({ ok: false, status: 422, text: async () => JSON.stringify({ message: "domain is not verified" }) }),
  });
  assert.equal(res.status, 502);
  assert.equal(res.body.sent, false);
  assert.match(res.body.message, /nothing was sent/);
  assert.equal(seen.closed[0].outcome, "failed");
  assert.equal(seen.sent[0].row.outcome, "failed", "and the workspace's own ledger says so too");
  // The provider's own words belong on the row an operator reads, and nowhere near the bot.
  assert.match(String(seen.closed[0].detail), /HTTP 422/);
});

test("a 4xx and a 5xx from the mail service are told apart in the words the bot says", async () => {
  const refused = await send(GOOD, {}, {
    fetchImpl: async () => ({ ok: false, status: 422, text: async () => '{"message":"invalid recipient"}' }),
  });
  assert.match(refused.res.body.message, /would not accept/, "a message it will never take");
  const wobbled = await send(GOOD, {}, {
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "upstream unavailable" }),
  });
  assert.match(wobbled.res.body.message, /Try again/, "and a failure on their side is worth retrying");
});

// THE ROUTE NEVER READS A VENDOR OUT TO A CUSTOMER. The bot repeats the sentence it is given
// verbatim, so a status code, a JSON brace or a provider's domain in any answer here lands on a
// person's own screen. Every refusal this route can make is walked, including the one that used to
// echo Resend's body straight through.
test("no answer this route gives carries a status code, a JSON blob or a vendor's name", async () => {
  const cases = [
    ["no bearer", () => send(GOOD, { token: null }, {})],
    ["a bearer this relay does not know", () => send(GOOD, { token: "someone-elses" }, {})],
    ["sending switched off", () => send(GOOD, {}, { noSend: () => true })],
    ["a body that is not JSON", () => send("not json at all", {}, {})],
    ["an attachment", () => send({ ...GOOD, attachments: [{ name: "a.pdf" }] }, {}, {})],
    ["no bot named", () => send({ ...GOOD, agentId: "" }, {}, {})],
    ["no recipient", () => send({ ...GOOD, to: "" }, {}, {})],
    ["no subject", () => send({ ...GOOD, subject: "" }, {}, {})],
    ["nothing in it", () => send({ ...GOOD, text: "", html: "" }, {}, {})],
    ["a bot with no address", () => send({ ...GOOD, agentId: "a_nobody" }, {}, {})],
    ["over the cap", () => send(GOOD, {}, {
      openSend: async () => ({
        ok: false, error: "rate_limited", scope: "agent", cap: 30, retryAfterSeconds: 720,
        message: "That bot has sent its 30 emails for this hour, so nothing was sent. The next one can go in 12 minutes.",
      }),
    })],
    ["a control plane that will not answer", () => send(GOOD, {}, { openSend: async () => { throw new Error("connect ECONNREFUSED 10.0.0.4:8080"); } })],
    ["no key stored", () => send(GOOD, {}, { ownerSettings: async () => ({ apiKey: "", domain: DOMAIN }) })],
    ["the mail service saying no", () => send(GOOD, {}, {
      fetchImpl: async () => ({
        ok: false, status: 422,
        text: async () => '{"statusCode":422,"name":"validation_error","message":"The gmail.com domain is not verified. Please verify at resend.com/domains"}',
      }),
    })],
    ["the mail service falling over", () => send(GOOD, {}, { fetchImpl: async () => { throw new Error("fetch failed ECONNRESET"); } })],
  ];
  for (const [name, run] of cases) {
    const { res } = await run();
    const message = String(res.body?.message ?? "");
    assert.ok(message.length > 0, `${name} says something`);
    for (const leak of ["HTTP ", "{", "}", "resend", "Resend", "ECONN", "502", "422"]) {
      assert.equal(message.includes(leak), false, `${name} must not say "${leak}": ${message}`);
    }
  }
});

// ---- threading and idempotency -------------------------------------------------------------------

test("inReplyTo threads the reply and the idempotency key rides Resend's own header", async () => {
  const { seen, res } = await send({ ...GOOD, inReplyTo: "<abc123@client.example>", idempotencyKey: "a_titan:call_7" });
  assert.equal(res.status, 200);
  assert.equal(seen.resend[0].body.headers["In-Reply-To"], "<abc123@client.example>");
  assert.equal(seen.resend[0].init.headers["idempotency-key"], "a_titan:call_7");
  // Stable per call and not per attempt, so a tool retry is one mail rather than two.
  assert.equal(seen.opened[0].idem, "a_titan:call_7");
});

test("a sent ledger row holds no body", () => {
  const row = mailSentLedgerRow({
    agentId: "a_titan", agentName: "Titan", code: "247758",
    from: `"Titan (demo)" <${ADDRESS}>`, to: "jane@client.example",
    subject: "September invoice", outcome: "sent", resendId: "re_1",
  });
  assert.equal(Object.keys(row).includes("text"), false);
  assert.equal(Object.keys(row).includes("html"), false);
  assert.equal(row.resend_id, "re_1");
});
