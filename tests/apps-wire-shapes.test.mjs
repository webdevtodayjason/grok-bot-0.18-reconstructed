// APPS-DOC-1. Every wire shape docs/APPS.md section 15 documents, driven through the LIVE route.
//
// WHY THIS FILE EXISTS. docs/APPS.md described the settings fields in prose without spelling them.
// The phone app read that prose, sent `{enabled, kinds: ["widget"], quietHours: {enabled, fromHour,
// toHour}}`, and the relay answered 200 {"message":"Saved."} -- and did not merely ignore the body,
// it OVERWROTE with the defaults, so a phone saving quiet hours switched the customer's quiet hours
// off and un-muted two kinds they had turned off. A document is not a contract until something fails
// when it is wrong, so this file makes the document fail.
//
// HOW. It parses the examples out of docs/APPS.md itself -- each one is a `##### METHOD path — what`
// heading followed by a fenced json block -- starts a REAL relay from a copy of ui/, mints a REAL
// device bearer at POST /auth/token, drives each documented body through the route it names, and
// asserts the answer has EXACTLY the keys the documented answer has, at every level: no key missing,
// no key extra. Values that move per call (tokens, ids, timestamps) are compared by type; the ones
// that are fixed by the product -- the six kinds, the scope words, the sentences -- are compared
// exactly.
//
// So an example edited here that the relay does not answer turns this red, and a route whose answer
// grows a key nobody wrote down turns this red too. That is the whole point: the document is the
// thing under test.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PUSH_CARD_KINDS } from "../ui/push-edge.mjs";
import { RELAY_PASSWORD, repo, startRelay } from "./relay-tenant-support.mjs";

const DOC = path.join(repo, "docs", "APPS.md");

// ---- the examples, read out of the document ------------------------------------------------------

/**
 * Every `##### METHOD path — what it is` heading in the document, with the fenced block under it.
 * The heading text is the key, so a test names the example the way the document does and a reader
 * can find it by searching for the same string.
 */
function examples() {
  const text = readFileSync(DOC, "utf8");
  const out = new Map();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^##### (.+)$/.exec(lines[i]);
    if (heading == null) continue;
    // The next fence, and nothing between the heading and it but blank lines.
    let j = i + 1;
    while (j < lines.length && lines[j].trim().length === 0) j += 1;
    const fence = /^```(\w*)$/.exec(lines[j] ?? "");
    if (fence == null) continue;
    const body = [];
    for (j += 1; j < lines.length && lines[j] !== "```"; j += 1) body.push(lines[j]);
    // The backticks around the method and path are the document's own emphasis, not part of the key.
    out.set(heading[1].replace(/`/g, ""), { lang: fence[1], text: body.join("\n") });
  }
  return out;
}

const EXAMPLES = examples();
const json = (name) => {
  const held = EXAMPLES.get(name);
  assert.ok(held != null, `docs/APPS.md has no example headed "${name}"`);
  assert.equal(held.lang, "json", `the example "${name}" is not a json block`);
  return JSON.parse(held.text);
};

/**
 * The SHAPE of a value: its keys all the way down, with a type at every leaf. Two shapes being equal
 * is the assertion this file is built on -- an answer that grew a key, lost one, or turned a number
 * into a string fails, while a token, an id or a timestamp that differs per call does not.
 */
function shapeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? ["<empty>"] : [shapeOf(value[0])];
  if (typeof value !== "object") return typeof value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = shapeOf(value[key]);
  return out;
}
const sameShape = (got, documented, what) =>
  assert.deepEqual(shapeOf(got), shapeOf(documented), `${what}: the answer's shape is not the one docs/APPS.md section 15 documents`);

// ---- one real relay, one real bearer -------------------------------------------------------------

let relay = null;
let bearer = "";
let deviceId = "";

const call = async (method, pathname, body) => {
  const response = await fetch(`${relay.base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed, text, headers: response.headers };
};

test.before(async () => {
  relay = await startRelay({}, { prefix: "relay-wire-" });
  // The instance-password door, which is the one this harness has: no control plane answers here, so
  // an account sign-in has nothing to decide it. It is one of the three documented bodies.
  const minted = await fetch(`${relay.base}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: RELAY_PASSWORD, device: { id: "dev_wire_1", name: "the wire test", platform: "desktop" } }),
  });
  const answer = await minted.json();
  bearer = String(answer.token ?? "");
  deviceId = String(answer.device?.id ?? "");
  assert.equal(minted.status, 200, "the token door minted a bearer for the documented body");
  assert.ok(bearer.length > 0);
});

test.after(() => relay?.stop());

// ---- the token door ------------------------------------------------------------------------------

test("the three documented POST /auth/token bodies are the three the door takes", async () => {
  // Each of them is parsed out of the document rather than typed here, so an example that stops being
  // a body the door accepts is caught by the example and not by a copy of it.
  const account = json("POST /auth/token — the body, an account sign-in");
  assert.deepEqual(Object.keys(account).sort(), ["device", "email", "password"]);
  assert.deepEqual(Object.keys(account.device).sort(), ["id", "name", "platform"]);
  assert.ok(["ios", "android", "desktop"].includes(account.device.platform));

  const instance = json("POST /auth/token — the body, the instance-password door");
  assert.deepEqual(Object.keys(instance).sort(), ["device", "password"]);

  const remint = json("POST /auth/token — the body, a silent re-mint for the same device");
  assert.deepEqual(Object.keys(remint).sort(), ["device"]);

  // And the instance body is what actually minted the bearer this file holds, driven through the live
  // door in `before`. A re-mint carrying that bearer answers the same shape with `renewed` true.
  const again = await fetch(`${relay.base}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ device: { id: deviceId } }),
  });
  const body = await again.json();
  assert.equal(again.status, 200);
  sameShape(body, json("POST /auth/token — the answer"), "POST /auth/token");
  assert.equal(body.renewed, true, "a re-mint says it renewed rather than minting a second device");
  // A re-mint refreshes the row, which is what makes the bearer it replaced stop working. So the
  // tests below hold the renewed one, exactly as a shell that re-minted would.
  bearer = String(body.token);
});

test("GET /auth/devices answers the documented shape, and DELETE answers the documented one", async () => {
  const list = await call("GET", "/auth/devices");
  assert.equal(list.status, 200);
  sameShape(list.body, json("GET /auth/devices — the answer"), "GET /auth/devices");
  // Not this file's bearer: a revoke here would close every call below it. A second device is minted
  // and taken away, which is the shape the document names.
  const spare = await fetch(`${relay.base}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: RELAY_PASSWORD, device: { id: "dev_wire_spare", platform: "ios" } }),
  });
  const spareId = String((await spare.json()).device?.id ?? "");
  const gone = await call("DELETE", `/auth/devices/${encodeURIComponent(spareId)}`);
  assert.equal(gone.status, 200);
  sameShape(gone.body, json("DELETE /auth/devices/<id> — the answer"), "DELETE /auth/devices/<id>");
});

// ---- the push routes -----------------------------------------------------------------------------

test("POST /push/devices takes the documented body and answers the documented shape", async () => {
  const body = json("POST /push/devices — the body");
  assert.deepEqual(Object.keys(body).sort(), ["deviceId", "env", "name", "platform", "token"]);
  const answer = await call("POST", "/push/devices", { ...body, deviceId });
  assert.equal(answer.status, 200);
  sameShape(answer.body, json("POST /push/devices — the answer"), "POST /push/devices");
  assert.equal(answer.body.deviceId, deviceId);
  assert.equal(answer.body.platform, body.platform);
  // The one field the document promises is never on any answer.
  assert.ok(!answer.text.includes(body.token), "a registration answer never carries the token back");
});

test("GET /push/devices answers the documented shape, with no token on any row", async () => {
  const answer = await call("GET", "/push/devices");
  assert.equal(answer.status, 200);
  assert.equal(answer.body.devices.length, 1);
  sameShape(answer.body, json("GET /push/devices — the answer"), "GET /push/devices");
  assert.ok(!answer.text.includes("whatever the platform SDK handed back"));
});

test("GET /push/settings answers the documented shape, spellings and scope word", async () => {
  const answer = await call("GET", "/push/settings");
  assert.equal(answer.status, 200);
  const documented = json("GET /push/settings — the answer");
  sameShape(answer.body, documented, "GET /push/settings");

  // The three spellings the prose lost, asserted against the document's own example rather than
  // against a copy of them typed into this file.
  assert.deepEqual(Object.keys(documented.settings.kinds).sort(), [...PUSH_CARD_KINDS].sort(),
    "the document's kinds map names the six kinds the server knows");
  assert.deepEqual(Object.keys(answer.body.settings.kinds).sort(), [...PUSH_CARD_KINDS].sort());
  assert.deepEqual(Object.keys(documented.settings.quietHours).sort(), ["from", "on", "to"]);
  assert.ok(Object.hasOwn(documented.settings, "utcOffsetMinutes"), "the offset is at the top level of settings");
  assert.ok(!Object.hasOwn(documented.settings.quietHours, "utcOffsetMinutes"));
  assert.deepEqual(answer.body.kinds, PUSH_CARD_KINDS, "the flat list beside it is the server's own");
  // "person" or "workspace", never "account", which is the word section 2's prose used.
  assert.ok(["person", "workspace"].includes(documented.scope));
  assert.ok(["person", "workspace"].includes(answer.body.scope));
});

test("the documented PUT /push/settings body round-trips to the documented answer, exactly", async () => {
  const body = json("PUT /push/settings — the body");
  const answer = await call("PUT", "/push/settings", body);
  assert.equal(answer.status, 200);
  const documented = json("PUT /push/settings — the answer");
  sameShape(answer.body, documented, "PUT /push/settings");
  // Not only the shape: the documented answer is what this documented body actually produces.
  assert.deepEqual(answer.body.settings, documented.settings,
    "the answer the document shows is the answer the body it shows produces");
  assert.equal(answer.body.message, documented.message);

  // And it is read back the same off the relay rather than out of the page.
  const read = await call("GET", "/push/settings");
  assert.deepEqual(read.body.settings, documented.settings);
});

test("a field left out is left as it was, which is what the document promises", async () => {
  await call("PUT", "/push/settings", json("PUT /push/settings — the body"));
  // The document says `{"kinds": {"report": false}}` is a complete, valid body and so is `{}`.
  const partial = await call("PUT", "/push/settings", { kinds: { report: false } });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.settings.kinds.report, false);
  assert.equal(partial.body.settings.kinds.widget, false, "what was not sent was not reset");
  assert.equal(partial.body.settings.quietHours.on, true);
  assert.equal(partial.body.settings.utcOffsetMinutes, -300);

  const nothing = await call("PUT", "/push/settings", {});
  assert.equal(nothing.status, 200);
  assert.equal(nothing.body.settings.quietHours.from, 23);
});

test("the documented refusal is the refusal the prose's own body gets", async () => {
  // The shape the phone app sent after reading section 6's prose. This is the measured defect.
  const refused = await call("PUT", "/push/settings", { enabled: true, kinds: ["widget"], quietHours: { enabled: true, fromHour: 1, toHour: 9 } });
  assert.equal(refused.status, 400);
  const documented = json("PUT /push/settings — the refusal");
  sameShape(refused.body, documented, "PUT /push/settings, refused");
  assert.equal(refused.body.error, documented.error);
  assert.equal(refused.body.field, documented.field, "the 400 names the same field the document shows");
  assert.equal(refused.body.message, documented.message, "word for word, so a client author can grep for it");

  // And nothing moved.
  const after = await call("GET", "/push/settings");
  assert.equal(after.body.settings.kinds.widget, false);
  assert.equal(after.body.settings.quietHours.on, true);
});

test("a POST to /push/settings is the 405 the route's own sentence always claimed", async () => {
  const posted = await call("POST", "/push/settings", { kinds: { widget: true } });
  assert.equal(posted.status, 405);
  assert.equal(posted.body.error, "GET or PUT");
});

test("GET /push/pending answers the documented refusal when the box does not answer", async () => {
  // This harness's tenant gateway is a dead port on purpose, which is exactly the case the document
  // says must be a 503 and never an empty list: an empty list tells a tray that everything has been
  // answered, so a customer's badge would drop to zero because a box blinked.
  const answer = await call("GET", "/push/pending");
  assert.equal(answer.status, 503);
  sameShape(answer.body, json("GET /push/pending — the refusal when the box is unreachable"), "GET /push/pending, refused");
  assert.equal(answer.body.error, "no_answer");
});

test("the documented GET /push/pending row is the row the relay's own builder makes", () => {
  // The route cannot be driven end to end here (this harness has no box), so the SHAPE is compared
  // against the answer the module builds, which tests/relay-push-routes.test.mjs drives over a real
  // port against a stub box. Between the two, the documented row is pinned at both ends.
  const documented = json("GET /push/pending — the answer");
  assert.deepEqual(Object.keys(documented).sort(), ["ageMs", "agents", "at", "badge", "cards", "memoMs"]);
  assert.deepEqual(Object.keys(documented.cards[0]).sort(),
    ["agent", "at", "body", "deadlineMs", "entry", "key", "kind", "link", "muted", "pending", "quiet", "quietUntil", "requestId", "title"]);
  assert.deepEqual(Object.keys(documented.cards[0].agent).sort(), ["id", "name"]);
  assert.deepEqual(Object.keys(documented.cards[0].link).sort(), ["app", "web"]);
  assert.match(documented.cards[0].key, /^[0-9a-f]{32}$/, "the card key is the collapse key, 32 hex characters");
  assert.ok(PUSH_CARD_KINDS.includes(documented.cards[0].kind));
});

test("the documented frames are the pending row plus state, and a closed frame on the same key", () => {
  const pending = json("GET /push/events — a pending frame");
  const closed = json("GET /push/events — a closed frame");
  const row = json("GET /push/pending — the answer").cards[0];
  assert.equal(pending.channel, "push-card");
  assert.equal(closed.channel, "push-card");
  assert.equal(pending.payload.state, "pending");
  assert.equal(closed.payload.state, "closed");
  // A tray has ONE shape to draw, not two: the pending payload is the pending row with `state`,
  // `badge` and `ageMs` on it and nothing else added or taken away.
  assert.deepEqual(
    Object.keys(pending.payload).filter((key) => !["state", "badge", "ageMs"].includes(key)).sort(),
    Object.keys(row).sort(),
  );
  assert.equal(closed.payload.key, pending.payload.key, "a closed frame names the card it closes");
  assert.equal(closed.payload.body, undefined, "and carries no sentence, because there is nothing to say");
});

test("GET /push/events answers the header set relayEvents already proves through Cloudflare", async () => {
  const held = EXAMPLES.get("GET /push/events — the response headers");
  assert.ok(held != null, "the document names the headers");
  const wanted = Object.fromEntries(held.text.split("\n").filter((line) => line.includes(":")).map((line) => {
    const cut = line.indexOf(":");
    return [line.slice(0, cut).trim().toLowerCase(), line.slice(cut + 1).trim()];
  }));
  assert.deepEqual(Object.keys(wanted).sort(), ["cache-control", "connection", "content-type", "x-accel-buffering"]);

  const controller = new AbortController();
  try {
    const response = await fetch(`${relay.base}/push/events`, {
      headers: { authorization: `Bearer ${bearer}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    for (const [name, value] of Object.entries(wanted)) {
      // `connection` is hop by hop and Node's fetch does not surface it; the other three are what a
      // proxy in front of this actually reads, and are what a stream that stalls live gets wrong.
      if (name === "connection") continue;
      assert.equal(response.headers.get(name), value, `${name} is what the document says`);
    }
  } finally { controller.abort(); }
});

// ---- the refusals the review pass found were the wrong shape or missing --------------------------

test("a body that is not JSON at all is refused in the SAME shape as every other refusal", async () => {
  // Every validator refusal answers {error:"bad_request", field, message}, which is what the document
  // shows and what a shell switches on to point at a form control. The parse failure answered
  // {"error":"that was not JSON"} instead -- no field, and an `error` that is a sentence -- so the one
  // refusal a client hits while its serialiser is still wrong was the one it could not parse.
  // Measured on the R750 through console.titanium.bot 2026-09-10 as `{not json`.
  const documented = json("PUT /push/settings — the refusal");
  for (const [method, pathname] of [["PUT", "/push/settings"], ["POST", "/push/devices"]]) {
    const response = await fetch(`${relay.base}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: "{not json",
    });
    const body = await response.json();
    assert.equal(response.status, 400, `${method} ${pathname} refuses a body that is not JSON`);
    sameShape(body, documented, `${method} ${pathname}, not JSON`);
    assert.equal(body.error, "bad_request", `${method} ${pathname} says bad_request like the rest`);
    assert.equal(body.field, "body", `${method} ${pathname} names the field`);
    assert.match(body.message, /not JSON at all/);
    assert.match(body.message, /Nothing was stored/);
  }
  // And nothing moved.
  const after = await call("GET", "/push/settings");
  assert.equal(after.status, 200);
});

test("a quiet window that starts and ends at the same hour is refused rather than stored", async () => {
  // quietHoursHold answers false on from === to, which is the right reading of an ambiguous window,
  // so 9 to 9 stored 200 and then held nothing, for ever, silently. Same class as rule 3's out-of-range
  // hour: a typo becoming a different, perfectly valid setting with no complaint.
  const before = await call("GET", "/push/settings");
  const refused = await call("PUT", "/push/settings", { quietHours: { on: true, from: 9, to: 9 } });
  assert.equal(refused.status, 400);
  sameShape(refused.body, json("PUT /push/settings — the refusal"), "PUT /push/settings, a zero-width window");
  assert.equal(refused.body.error, "bad_request");
  assert.equal(refused.body.field, "quietHours.to", "the 400 names the hour that has to move");
  assert.match(refused.body.message, /Nothing was stored/);
  const after = await call("GET", "/push/settings");
  assert.deepEqual(after.body.settings, before.body.settings, "and nothing was stored");

  // It is the MERGED window that is refused, not the body: `from` and `to` arrive one at a time.
  await call("PUT", "/push/settings", { quietHours: { on: true, from: 23, to: 6 } });
  const half = await call("PUT", "/push/settings", { quietHours: { to: 23 } });
  assert.equal(half.status, 400, "a patch that only moves `to` onto the stored `from` is refused too");
  assert.equal(half.body.field, "quietHours.to");

  // And a window that is off is not a window, so it is not refused.
  const off = await call("PUT", "/push/settings", { quietHours: { on: false, from: 9, to: 9 } });
  assert.equal(off.status, 200, "quiet hours turned off may say anything, because nothing reads it");

  // A body that does not touch quietHours is never refused for a window it did not send: a row already
  // on disk reading 9 to 9 must not lock a panel out of every other save.
  const elsewhere = await call("PUT", "/push/settings", { kinds: { report: false } });
  assert.equal(elsewhere.status, 200);
  await call("PUT", "/push/settings", { kinds: { report: true }, quietHours: { on: true, from: 23, to: 6 } });
});
