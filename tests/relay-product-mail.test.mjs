// ONBOARD-2. The relay's product-mail door: POST /mail/product.
//
// THE WHOLE POINT OF THIS ROUTE IS CUSTODY, so the cases below are mostly about what a caller may
// NOT decide. The relay holds the operator's Resend key, which is account wide: measured read-only on
// the R750 2026-09-10 it lists 39 of the operator's domains. A route that took a From from its caller
// would therefore be one bad config value upstream away from sending as somebody's personal address,
// with no way for a recipient to tell. So the sender is resolved here, from this relay's own
// environment and its own settings file, and a body carrying one is refused BY NAME rather than
// quietly ignored.
//
// THE ORDER OF THE REFUSALS IS THE SECURITY. Every case asserts the thing that must NOT have happened
// as well as the answer: nothing reached the provider, no key was read. A route that refuses after it
// has already sent the mail is not a refusal.
//
// Nothing here touches api.resend.com. The fetch is a recorder, which is also how a case reads the
// exact payload that would have gone.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";

import {
  PRODUCT_MAIL_BANNED,
  PRODUCT_MAIL_FROM_DEFAULT,
  PRODUCT_MAIL_HTML_LIMIT,
  addressOfFrom,
  createProductMailRoute,
  normalizeMailSettings,
  productFrom,
} from "../ui/mail-edge.mjs";
// The control plane's own default reply address, imported rather than retyped: the point of the test
// below is that the two files' defaults agree and that the pair of them lands in a real mailbox.
import { WELCOME_REPLY_TO_DEFAULT } from "../cp/welcome.mjs";

// The one credential the control plane and the relay already share. Taken from the relay harness so
// the unit cases above and the booted relay below are held to the same value, and so a change there
// cannot leave this file quietly asserting against a token nothing uses.
import { RELAY_TOKEN } from "./relay-tenant-support.mjs";
const OWNER_KEY = "re_the_relays_own_key";

/** Just enough of a response for a route that only ever writes a head and one JSON body. */
function fakeRes() {
  return {
    status: 0, headers: {}, body: null, ended: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = { ...this.headers, ...headers }; return this; },
    end(payload) { this.ended = true; this.body = payload == null ? null : JSON.parse(String(payload)); return this; },
  };
}

const fakeReq = (body, { method = "POST", token = RELAY_TOKEN } = {}) => ({
  method,
  headers: token == null ? {} : { authorization: `Bearer ${token}` },
  raw: typeof body === "string" ? body : JSON.stringify(body ?? {}),
});

function routeWith(overrides = {}) {
  const seen = { resend: [], settingsRead: 0, logs: [] };
  const route = createProductMailRoute({
    readBody: async (req, max) => {
      if (req.raw.length > max) { const error = new Error("too large"); error.code = "BODY_TOO_LARGE"; throw error; }
      return req.raw;
    },
    drainThenEnd: async (req, res, status, headers, payload) => { res.writeHead(status, headers); res.end(payload); },
    relayToken: RELAY_TOKEN,
    ownerSettings: async () => { seen.settingsRead += 1; return { apiKey: OWNER_KEY, domain: "myagents.email", welcomeFrom: "" }; },
    env: {},
    fetchImpl: async (url, init) => {
      seen.resend.push({ url, init, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "re_49a3999c" }) };
    },
    log: (line) => seen.logs.push(line),
    ...overrides,
  });
  return { seen, route };
}

const GOOD = {
  kind: "welcome",
  slug: "acme-roofing",
  to: "jane@acmeroofing.com",
  subject: "Your Titanium Bot workspace is ready",
  html: "<html><body><p>Hi Jane,</p></body></html>",
  text: "Hi Jane,",
};

const send = async (body, options = {}, overrides = {}) => {
  const { seen, route } = routeWith(overrides);
  const res = fakeRes();
  await route.handleProductMail(fakeReq(body, options), res);
  return { seen, res };
};

// ---- the sender, which is this relay's and nobody else's ---------------------------------------

test("the From is the product's default, the environment beats the file, and a broken value falls back", () => {
  assert.equal(productFrom(null, {}), PRODUCT_MAIL_FROM_DEFAULT);
  assert.equal(PRODUCT_MAIL_FROM_DEFAULT, "Titanium Bot <welcome@titanium.bot>");

  // The file the operator already owns, and the value goes out as the operator wrote it: an ordinary
  // display name needs no quotes and gaining a pair on the way to a customer's inbox would be this
  // route quietly editing the operator's own words.
  assert.equal(productFrom({ welcomeFrom: "Acme Roofing <hello@acme.example>" }, {}), "Acme Roofing <hello@acme.example>");
  // And the container's environment over it, because that is what an operator can set without editing
  // a file inside a running container.
  assert.equal(productFrom({ welcomeFrom: "Ops <ops@acme.example>" }, { PRODUCT_MAIL_FROM: "Support <help@acme.example>" }),
    "Support <help@acme.example>");
  // A name carrying a character that changes what a header means does get the quotes.
  assert.equal(productFrom({ welcomeFrom: "Acme, Inc <hello@acme.example>" }, {}), '"Acme, Inc" <hello@acme.example>');
  // A bare address is a valid From and stays bare.
  assert.equal(productFrom({ welcomeFrom: "hello@acme.example" }, {}), "hello@acme.example");
  // A value that is not an address at all never becomes a malformed From on a real customer's mail.
  for (const broken of ["not an address", "<>", "", "   ", "a@b"]) {
    assert.equal(productFrom({ welcomeFrom: broken }, {}), PRODUCT_MAIL_FROM_DEFAULT, `"${broken}" falls back`);
  }
  // A CONFIGURED VALUE WITH A NEWLINE IN IT DOES NOT SEND AT ALL. A display name is where a header
  // injection would come from, and the whole value here is refused rather than cleaned up: the pattern
  // that reads a sender out of this setting spans one line, so a value carrying CR or LF matches
  // nothing, is not an address either, and the product's own default goes out instead.
  const nasty = productFrom({ welcomeFrom: 'Ev"il\r\nBcc: x@y.example <hello@acme.example>' }, {});
  assert.equal(nasty, PRODUCT_MAIL_FROM_DEFAULT);
  assert.equal(nasty.includes("\r"), false);
  assert.equal(nasty.includes("\n"), false);
  assert.equal(nasty.includes("Bcc"), false);
  // A display name on ONE line with a quote in it is cleaned rather than refused, because that is an
  // ordinary typo in an ordinary name and the quote is what would end the quoted string.
  const quoted = productFrom({ welcomeFrom: 'Ev"il Co <hello@acme.example>' }, {});
  assert.equal(quoted, "Evil Co <hello@acme.example>");
  assert.equal(addressOfFrom(quoted), "hello@acme.example");
  assert.equal(addressOfFrom(PRODUCT_MAIL_FROM_DEFAULT), "welcome@titanium.bot");
});

test("welcomeFrom survives the console saving the mail card, because the normalize keeps it", () => {
  // mergeMailSettings builds from normalizeMailSettings, so a field the normalize drops is a field the
  // next save of the Email card deletes.
  const kept = normalizeMailSettings({ welcomeFrom: "Acme <hello@acme.example>", apiKey: "re_x" });
  assert.equal(kept.welcomeFrom, "Acme <hello@acme.example>");
});

test("the From is productFrom's whatever the body says, and a body that tries is refused by name", async () => {
  // Refused, not ignored. A bot guessing at a field is a bot; a control plane sending a sender is a
  // bug upstream, and a bug that is silently dropped is a bug that ships.
  for (const field of PRODUCT_MAIL_BANNED) {
    const { seen, res } = await send({ ...GOOD, [field]: field === "headers" ? { "X-Evil": "1" } : "evil@attacker.example" });
    assert.equal(res.status, 400, field);
    assert.equal(res.body.sent, false);
    assert.equal(res.body.error, "field_not_allowed");
    assert.match(res.body.message, new RegExp(`A product email's ${field} is decided by this relay`));
    assert.equal(seen.resend.length, 0, `a refused ${field} must not have sent anything`);
    assert.equal(seen.settingsRead, 0, "and must not have read the key");
  }
  // And the happy path's From is the relay's, every time.
  const { seen } = await send(GOOD);
  assert.equal(seen.resend[0].body.from, PRODUCT_MAIL_FROM_DEFAULT);
});

// ---- the door ----------------------------------------------------------------------------------

test("an unauthenticated POST is 401 and a GET is 405, and neither reads the key", async () => {
  const missing = await send(GOOD, { token: null });
  assert.equal(missing.res.status, 401);
  assert.equal(missing.res.body.error, "unauthorized");
  assert.equal(missing.seen.settingsRead, 0);

  const wrong = await send(GOOD, { token: "not-the-relay-token" });
  assert.equal(wrong.res.status, 401);
  assert.equal(wrong.seen.resend.length, 0);

  // The method refusal comes BEFORE the credential, the same order handleRelayAdmin uses: a wrong
  // method learns nothing and charges nobody's lockout.
  const get = await send(GOOD, { method: "GET", token: null });
  assert.equal(get.res.status, 405);
  assert.equal(get.res.headers.allow, "POST");
});

test("a relay with no control plane has no such door at all", async () => {
  const { res, seen } = await send(GOOD, {}, { relayToken: "" });
  assert.equal(res.status, 404);
  assert.equal(seen.resend.length, 0);
});

// ---- one recipient, and the words ---------------------------------------------------------------

test("two recipients in any spelling are refused, because the link in a product mail is a bearer", async () => {
  // A sign-in link has no revocation, so a second recipient is a second key to somebody's workspace.
  const array = await send({ ...GOOD, to: ["jane@acmeroofing.com", "x@attacker.example"] });
  assert.equal(array.res.status, 400);
  assert.equal(array.res.body.error, "too_many_recipients");
  assert.equal(array.seen.resend.length, 0);

  const comma = await send({ ...GOOD, to: "jane@acmeroofing.com, x@attacker.example" });
  assert.equal(comma.res.status, 400);
  assert.equal(comma.res.body.error, "too_many_recipients");
  assert.equal(comma.seen.resend.length, 0);
});

test("a missing kind, workspace, recipient, subject or body sends nothing", async () => {
  for (const [patch, error] of [
    [{ kind: "" }, "bad_kind"],
    [{ kind: "invoice" }, "bad_kind"],
    [{ slug: "" }, "bad_request"],
    [{ to: "not-an-address" }, "bad_request"],
    [{ subject: "" }, "bad_request"],
    [{ html: "", text: "" }, "bad_request"],
  ]) {
    const { seen, res } = await send({ ...GOOD, ...patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.equal(res.body.error, error, JSON.stringify(patch));
    assert.equal(seen.resend.length, 0);
  }
  const unreadable = await send("{not json");
  assert.equal(unreadable.res.status, 400);
  assert.equal(unreadable.res.body.error, "bad_request");
});

test("a page with a script in it, or an image over plain http, is refused", async () => {
  const script = await send({ ...GOOD, html: "<html><body><script>alert(1)</script></body></html>" });
  assert.equal(script.res.status, 400);
  assert.equal(script.res.body.error, "bad_html");
  assert.equal(script.seen.resend.length, 0);

  // Upper case, spacing and a single quote are all the same tag.
  const shouty = await send({ ...GOOD, html: "<html><SCRIPT src='x'></SCRIPT></html>" });
  assert.equal(shouty.res.status, 400);

  for (const img of [
    '<img src="http://tracker.example/p.gif">',
    "<img  width='1' src = 'http://tracker.example/p.gif'>",
  ]) {
    const { res, seen } = await send({ ...GOOD, html: `<html><body>${img}</body></html>` });
    assert.equal(res.status, 400, img);
    assert.equal(res.body.error, "bad_html", img);
    assert.equal(seen.resend.length, 0);
  }
  // An https image is not this route's business to refuse, even though the product's own mail has none.
  const secure = await send({ ...GOOD, html: '<html><body><img src="https://titanium.bot/x.png"></body></html>' });
  assert.equal(secure.res.status, 200);
});

test("a page larger than a product email may be is refused, and so is an oversized request", async () => {
  const huge = await send({ ...GOOD, html: `<html>${"x".repeat(PRODUCT_MAIL_HTML_LIMIT)}</html>` });
  assert.equal(huge.res.status, 400);
  assert.equal(huge.res.body.error, "too_large");
  assert.equal(huge.seen.resend.length, 0);

  const { seen, route } = routeWith({
    readBody: async () => { const error = new Error("too large"); error.code = "BODY_TOO_LARGE"; throw error; },
  });
  const res = fakeRes();
  await route.handleProductMail(fakeReq(GOOD), res);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "too_large");
  assert.equal(seen.resend.length, 0);
});

// ---- the reply address --------------------------------------------------------------------------

test("the reply address goes out on its own domain or any other, and a malformed one stops the send", async () => {
  const same = await send({ ...GOOD, replyTo: "help@titanium.bot" });
  assert.equal(same.res.status, 200);
  assert.equal(same.seen.resend[0].body.reply_to, "help@titanium.bot");
  assert.equal(same.res.body.replyToWhy, undefined);

  // THE DEFAULT INSTALL IS THE CROSS-DOMAIN CASE, so it is the one that has to work. The operator's
  // support address is on a domain that already receives mail; titanium.bot has no inbound at all
  // (`dig MX titanium.bot` answers nothing, measured on this Mac 2026-09-10). This used to DROP the
  // header, which meant the first thing the product ever sent a business owner invited a reply to a
  // mailbox that does not exist. Reply-To is unsigned and Resend does not require it on a verified
  // domain, so it goes.
  const other = await send({ ...GOOD, replyTo: "support@titaniumcomputing.com" });
  assert.equal(other.res.status, 200);
  assert.equal(other.res.body.sent, true);
  assert.equal(other.seen.resend[0].body.reply_to, "support@titaniumcomputing.com",
    "a reply a customer sends has to reach a mailbox somebody reads");
  assert.match(other.res.body.replyToWhy, /Replies go to support@titaniumcomputing\.com rather than welcome@titanium\.bot/);

  // A reply address that is not a single address is the caller's bug and stops the send.
  for (const broken of ["not an address", "a@b.example, c@d.example", "<a@b.example>"]) {
    const { res, seen } = await send({ ...GOOD, replyTo: broken });
    assert.equal(res.status, 400, broken);
    assert.equal(res.body.error, "bad_reply_to", broken);
    assert.equal(seen.resend.length, 0);
  }
});

test("a welcome sent with the shipped defaults carries a reply address on a domain that receives mail", async () => {
  // The two halves of the default install, read from the two files that ship them rather than typed
  // out here: the control plane's default reply address and the relay's default From. The From's
  // domain has no inbound, so the reply address must be the other one and it must be on the wire.
  assert.equal(PRODUCT_MAIL_FROM_DEFAULT, "Titanium Bot <welcome@titanium.bot>");
  assert.equal(WELCOME_REPLY_TO_DEFAULT, "support@titaniumcomputing.com");
  const { res, seen } = await send({ ...GOOD, replyTo: WELCOME_REPLY_TO_DEFAULT });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(seen.resend[0].body.from, PRODUCT_MAIL_FROM_DEFAULT, "the From keeps the verified domain");
  assert.equal(seen.resend[0].body.reply_to, WELCOME_REPLY_TO_DEFAULT);
  // INBOUND, not just a syntactically valid address. titanium.bot publishes no MX; a reply address on
  // it is a reply nobody ever reads, which is why this assertion is about the DOMAIN and not the
  // header. If titanium.bot ever gets inbound mail, PRODUCT_MAIL_FROM can change and this still holds.
  assert.notEqual(seen.resend[0].body.reply_to.split("@")[1], "titanium.bot",
    "titanium.bot has no MX record, so a reply addressed there reaches nobody");
});

// ---- the key, and the send itself --------------------------------------------------------------

test("the key is the DIRECTORY OWNER's and a console with none sends nothing", async () => {
  const { seen, res } = await send(GOOD);
  assert.equal(res.status, 200);
  assert.equal(seen.resend.length, 1);
  assert.match(seen.resend[0].url, /\/emails$/);
  assert.equal(seen.resend[0].init.headers.authorization, `Bearer ${OWNER_KEY}`);
  assert.equal(seen.resend[0].body.to.length, 1, "one recipient per call");

  const none = await send(GOOD, {}, { ownerSettings: async () => ({ apiKey: "" }) });
  assert.equal(none.res.status, 503);
  assert.equal(none.res.body.error, "no_key");
  assert.equal(none.seen.resend.length, 0);
});

test("the caller's idempotency key travels, so a double press cannot mail a real person twice", async () => {
  const key = "welcome:acme-roofing:0123456789abcdef:2026091012";
  const { seen } = await send({ ...GOOD, idempotencyKey: key });
  assert.equal(seen.resend[0].init.headers["idempotency-key"], key);
  const without = await send(GOOD);
  assert.equal(without.seen.resend[0].init.headers["idempotency-key"], undefined);
});

test("a refusal from the mail service answers the status and never the provider's body", async () => {
  const { seen, res } = await send(GOOD, {}, {
    fetchImpl: async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ name: "validation_error", message: "The jane@acmeroofing.com address is not allowed" }),
    }),
  });
  assert.equal(res.status, 502);
  assert.equal(res.body.sent, false);
  assert.equal(res.body.error, "send_failed");
  // The status is what an operator acts on. The provider's own words are NOT in the answer, because
  // the control plane writes what it is told into a welcome_sends row an operator reads, and a
  // provider's JSON in that row is how a recipient address lands somewhere nobody meant to put one.
  assert.match(res.body.message, /HTTP 422/);
  assert.equal(res.body.message.includes("validation_error"), false);
  assert.equal(res.body.message.includes("not allowed"), false);
  // A 4xx says retrying will not help; a 5xx says it will. Both read as sentences.
  assert.match(res.body.message, /would not accept/);

  const transient = await send(GOOD, {}, {
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "upstream down" }),
  });
  assert.match(transient.res.body.message, /could not take that message just now/);
  assert.match(transient.res.body.message, /HTTP 503/);

  // And nothing the provider said is in the log line either.
  for (const line of seen.logs) {
    assert.equal(line.includes("validation_error"), false, line);
    assert.equal(line.includes("not allowed"), false, line);
  }
});

test("the log line carries the workspace, the recipient and the provider's id, and no words from the mail", async () => {
  const { seen, res } = await send(GOOD);
  assert.equal(res.status, 200);
  assert.equal(seen.logs.length, 1);
  assert.match(seen.logs[0], /welcome for acme-roofing sent to jane@acmeroofing\.com \(re_49a3999c\)/);
  assert.equal(seen.logs[0].includes(GOOD.subject), false, "never the subject");
  assert.equal(seen.logs[0].includes("Hi Jane"), false, "never the words");
  assert.equal(seen.logs[0].includes(OWNER_KEY), false, "never the key");
});

test("the answer is one plain sentence, the provider's id, and nothing a page could be rebuilt from", async () => {
  const { res } = await send(GOOD);
  assert.equal(res.status, 200);
  assert.equal(Object.keys(res.body)[0], "message");
  assert.equal(res.body.message, "Sent to jane@acmeroofing.com.");
  assert.equal(res.body.id, "re_49a3999c");
  assert.equal(res.body.from, PRODUCT_MAIL_FROM_DEFAULT);
  assert.equal(res.body.to, "jane@acmeroofing.com");
  assert.equal(res.body.html, undefined);
  assert.equal(res.body.text, undefined);
  assert.equal(res.body.subject, undefined);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("the bot's own send route is not touched by any of this", async () => {
  // Two doors, one key, and the bot door's rules are the ones tests/mail-send-route.test.mjs holds.
  // This asserts only that the product door did not grow into it: a product mail has no agentId and
  // could never be claimed against a workspace's caps.
  const { seen } = await send(GOOD);
  assert.equal(seen.resend[0].body.agentId, undefined);
  assert.equal(seen.resend[0].body.reply_to, undefined, "no agent address is invented for a product mail");
});

// ---- the per-slug address sweep (ONBOARD-2, the same hunk of ui/server.mjs as the door above) ----
//
// POST /mail/sweep grew an OPTIONAL {slug}. It is in this file rather than its own because it is the
// other half of the same change and the same ship: the invite's fourth step asks the relay for a
// sweep the moment a new box is up, so Titan has an address before the welcome goes.
//
// WHY PER SLUG MATTERS, and it is not tidiness. The fleet sweep makes a listAgents and a setAgentMail
// call into EVERY workspace this console serves. So onboarding one customer reached inside every
// other customer's box, and the cost of giving a new client their addresses grew with the number of
// clients. The two assertions below are exactly that: a named sweep touches one box, and an empty
// body still sweeps them all so the five minute timer and `cp mail sweep` are unchanged.
//
// AND THE REFRESH, proved by its effect rather than by counting a call. A workspace created a minute
// ago is not in this relay's registry yet, because that list is read on its own sixty second cycle.
// The named path reads it again first, so the case below adds a workspace AFTER the relay booted and
// sweeps it by name: without that read the answer is "not a workspace this console knows yet", which
// is what a new customer's first welcome would have been sent without an address behind it.

import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMailDirectory } from "../cp/mail.mjs";
import { openStore } from "../cp/store.mjs";
import { startRelay, tenantRow, tenantsFile } from "./relay-tenant-support.mjs";

const DOMAIN = "myagents.email";

/** A box, counting what the sweep asked it. A sweep that reached the wrong box shows up here. */
function startFakeBox(label) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const command = String(req.url ?? "").replace("/api/", "");
      calls.push({ command, body: raw });
      res.writeHead(200, { "content-type": "application/json" });
      if (command === "listAgents") {
        return res.end(JSON.stringify({ agents: [{ id: `${label}-titan`, name: "Titan" }] }));
      }
      return res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      label,
      url: `http://127.0.0.1:${server.address().port}`,
      calls,
      count: (command) => calls.filter((call) => call.command === command).length,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

/** The control plane's two directory routes, over a real store, so the mint is the real mint. */
function startStubControlPlane(store) {
  const directory = createMailDirectory({ store, domain: DOMAIN });
  const seen = { mint: [], directory: 0 };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://cp.invalid");
      const answer = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (String(req.headers.authorization ?? "") !== `Bearer ${RELAY_TOKEN}`) return answer(401, { error: "unauthorized" });
      if (url.pathname === "/v1/relay/mail/directory") {
        seen.directory += 1;
        const slug = url.searchParams.get("slug");
        return answer(200, directory.directory(slug && slug.length > 0 ? slug : null));
      }
      if (url.pathname === "/v1/relay/mail/mint") {
        let body; try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
        seen.mint.push(String(body.slug ?? ""));
        return answer(200, directory.mint(body.slug, body.agents));
      }
      return answer(404, { error: "not_found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      seen,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

const sweep = (relay, body = null) => fetch(`${relay.base}/mail/sweep`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${RELAY_TOKEN}`,
    ...(body == null ? {} : { "content-type": "application/json" }),
  },
  ...(body == null ? {} : { body: JSON.stringify(body) }),
});

async function until(what, why, deadlineMs = 15_000) {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    if (await what()) return;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  throw new Error(`timed out waiting for ${why}`);
}

test("a named sweep reads the workspace list again, then touches exactly that one box", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "relay-sweep-"));
  const store = openStore({ dataDir: root });
  const [alphaBox, betaBox] = await Promise.all([startFakeBox("alpha"), startFakeBox("beta")]);
  const cp = await startStubControlPlane(store);
  const alpha = tenantRow("alpha", { gateway: alphaBox.url, token: "alpha-gateway-token" });
  const beta = tenantRow("beta", { gateway: betaBox.url, token: "beta-gateway-token" });
  // BOOTED KNOWING ONLY ALPHA. Beta is the workspace created after the relay was already running,
  // which is every new customer.
  const file = tenantsFile([alpha.row]);
  const relay = await startRelay({
    CP_URL: cp.url,
    CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: file,
  }, { prefix: "relay-sweep-", pathValue: "/nonexistent" });
  try {
    // The sweep at boot, finished, so what follows is measured against a quiet relay.
    await until(() => cp.seen.mint.includes("alpha"), "the sweep this relay runs at boot");
    await until(() => alphaBox.count("setAgentMail") > 0, "alpha's box to be given its addresses");
    const alphaBefore = alphaBox.count("listAgents");

    writeFileSync(file, JSON.stringify({ tenants: [alpha.row, beta.row] }, null, 2));

    // A named sweep. The refresh is what makes this answer anything but "not a workspace this console
    // knows yet", because the list the relay is holding was read before beta existed.
    const named = await sweep(relay, { slug: "beta" });
    const namedText = await named.text();
    assert.equal(named.status, 200, namedText);
    const body = JSON.parse(namedText);
    assert.equal(body.ok, true);
    assert.equal(body.asked, "beta");
    assert.equal(body.swept.length, 1, "one workspace, not the fleet");
    assert.equal(body.swept[0].slug, "beta");
    assert.equal(body.swept[0].minted, 1, "Titan's address was minted on this pass");

    // EXACTLY ONE BOX. Alpha's was not read and not written to, which is the whole point: a sweep that
    // reached into every other customer's box is what this change ended.
    assert.equal(betaBox.count("listAgents"), 1);
    assert.equal(betaBox.count("setAgentMail"), 1);
    assert.equal(alphaBox.count("listAgents"), alphaBefore, "alpha's box was not touched");

    // And the address really exists, read out of the control plane's own directory rather than out of
    // the sweep's answer: a green sweep over a workspace it never named is the exact shape of a light
    // somebody believes.
    const rows = store.listMailAddresses("beta").filter((row) => row.state === "active");
    assert.equal(rows.length, 1);
    assert.match(rows[0].address, /^agent\d{6}@myagents\.email$/);
    assert.equal(rows[0].agentName, "Titan");

    // A NAME THIS CONSOLE DOES NOT KNOW IS A REFUSAL AND NOT AN EMPTY SUCCESS.
    const stranger = await sweep(relay, { slug: "never-existed" });
    assert.equal(stranger.status, 503);
    const said = await stranger.json();
    assert.equal(said.ok, false);
    assert.match(said.why, /never-existed is not a workspace this console/);
    assert.deepEqual(said.swept, []);

    // AND AN EMPTY BODY IS STILL THE FLEET, so the five minute timer and `cp mail sweep` are
    // unchanged by any of this.
    const beforeAlpha = alphaBox.count("listAgents");
    const beforeBeta = betaBox.count("listAgents");
    const fleet = await sweep(relay);
    const fleetText = await fleet.text();
    assert.equal(fleet.status, 200, fleetText);
    const all = JSON.parse(fleetText);
    assert.equal(all.ok, true);
    assert.equal(all.asked, undefined, "a fleet sweep names no workspace");
    assert.equal(all.swept.length, 2);
    assert.deepEqual(all.swept.map((row) => row.slug).sort(), ["alpha", "beta"]);
    assert.equal(alphaBox.count("listAgents"), beforeAlpha + 1);
    assert.equal(betaBox.count("listAgents"), beforeBeta + 1);

    // The door's own rules did not move either.
    assert.equal((await fetch(`${relay.base}/mail/sweep`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${relay.base}/mail/sweep`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } })).status, 405);
  } finally {
    relay.stop();
    store.close();
    await Promise.all([alphaBox.stop(), betaBox.stop(), cp.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});
