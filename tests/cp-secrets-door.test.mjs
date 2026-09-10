// KEYS-1. The control plane's key door: the paste, the presence read, the relay's read, and the
// ledger row that must carry evidence and never a value.
//
// WHAT THIS SUITE IS PROTECTING. Two vendor keys moved off every customer's screen and onto the super
// admin console on 2026-09-10. Everything that makes that safe rather than merely tidier is an
// assertion in here: a key the vendor refuses is not stored, no route answers with a value, the
// ledger row carries a digest, the allowlist is closed, and the relay's own read refuses a wrong
// method BEFORE it looks at a credential so a wrong method charges nobody and learns nothing.

import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";

import { SECRET_SETTINGS } from "../cp/store.mjs";
import { KEY_NAMES, keyEvidence, voiceKeyName } from "../cp/secrets.mjs";
import { startControlPlane } from "./cp-support.mjs";

const RELAY_TOKEN = "relay-token-for-a-keys-test-0123456789";
// A value with a shape nothing else in the tree uses, so a sweep that finds it has found this one.
const PLANTED = `planted-key-${randomBytes(16).toString("hex")}`;

/** A vendor that takes the key. The proof is one authenticated GET, so this is the whole of one. */
async function startTakingVendor() {
  const { createServer } = await import("node:http");
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, authorization: String(request.headers.authorization ?? "") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "a-model" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** A vendor that will not take it. 401 is the shape every one of the three answers for a bad key. */
async function startRefusingVendor(status = 401) {
  const { createServer } = await import("node:http");
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "no" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

// The three proof addresses are overridable exactly the way the GitHub one is, and they are read off
// the PROCESS environment for the same reason: cp/provision.mjs's loadConfig does not carry them and
// this harness runs the control plane in this process rather than spawning one. Set around the run
// and put back after, which is safe because node:test runs the tests in one file one at a time.
const BASE_VARS = ["CP_XAI_API_URL", "CP_OPENAI_API_URL", "CP_RESEND_API_URL"];

async function withPlane(run, { vendorUrl = "", env = {} } = {}) {
  const before = BASE_VARS.map((name) => [name, process.env[name]]);
  if (vendorUrl) for (const name of BASE_VARS) process.env[name] = vendorUrl;
  const plane = await startControlPlane({ env: { CP_RELAY_TOKEN: RELAY_TOKEN, ...env } });
  try { await run(plane); }
  finally {
    await plane.dispose();
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the allowlist is closed, and the store redacts every name on it", () => {
  assert.deepEqual([...KEY_NAMES], ["keys.voice.xai", "keys.voice.openai", "keys.mail.send"]);
  // A name in the allowlist and not in SECRET_SETTINGS is a key that listSettings hands back
  // wholesale, and cp/verification.mjs reads that list. The two have to be the same three names.
  for (const name of KEY_NAMES) {
    assert.equal(SECRET_SETTINGS.has(name), true, `${name} is not redacted by the store`);
  }
});

test("which key dials is decided by the workspace's own service and never by what happens to exist", () => {
  assert.equal(voiceKeyName("xai"), "keys.voice.xai");
  assert.equal(voiceKeyName("openai"), "keys.voice.openai");
  assert.equal(voiceKeyName("XAI"), "keys.voice.xai", "the id is compared without case");
  // A service nobody has heard of gets NOTHING rather than the other service's key: dialling one
  // vendor with another's credential is a 401 a person reads as a broken product.
  assert.equal(voiceKeyName("somebody-else"), "");
  assert.equal(voiceKeyName(""), "");
  assert.equal(voiceKeyName(null), "");
});

test("a key the vendor refuses is answered 409 and stored nowhere", async () => {
  const vendor = await startRefusingVendor(401);
  try {
    await withPlane(async (plane) => {
      const answer = await plane.admin("POST", "/v1/keys/keys.mail.send", { value: PLANTED });
      assert.equal(answer.status, 409, answer.text);
      assert.equal(answer.body.error, "key_refused");
      assert.match(answer.body.message, /Nothing was stored/);
      assert.equal(plane.store.getSetting("keys.mail.send", ""), "", "the store was touched");
      // And not even half a row in the ledger claiming it worked.
      const rows = plane.store.listAdminActions({ limit: 50 });
      assert.equal(rows.filter((row) => row.action === "keys.set").length, 0, JSON.stringify(rows));
    }, { vendorUrl: vendor.url });
  } finally { await vendor.close(); }
});

test("a vendor that cannot be reached at all is also a refusal, because an unchecked key is unchecked", async () => {
  await withPlane(async (plane) => {
    const answer = await plane.admin("POST", "/v1/keys/keys.voice.xai", { value: PLANTED });
    assert.equal(answer.status, 409, answer.text);
    assert.match(answer.body.message, /Nothing was stored/);
    assert.equal(plane.store.getSetting("keys.voice.xai", ""), "");
    // Port 9 is discard: nothing is listening and the connection is refused at once.
  }, { vendorUrl: "http://127.0.0.1:9" });
});

test("a name outside the allowlist is 400 and nothing is asked of any vendor", async () => {
  const vendor = await startTakingVendor();
  try {
    await withPlane(async (plane) => {
      for (const name of ["keys.voice.somebody", "github.token", "push.apns.key", "keys", "../../etc/passwd"]) {
        const answer = await plane.admin("POST", `/v1/keys/${encodeURIComponent(name)}`, { value: PLANTED });
        assert.equal(answer.status, 400, `${name}: ${answer.text}`);
        assert.match(answer.body.message, /Nothing was stored/);
      }
      assert.deepEqual(vendor.seen, [], "a name we do not hold must not reach a vendor");
    }, { vendorUrl: vendor.url });
  } finally { await vendor.close(); }
});

test("an empty or line-broken value is 400 before the vendor is asked", async () => {
  const vendor = await startTakingVendor();
  try {
    await withPlane(async (plane) => {
      for (const value of ["", "   ", "short", "has\na-newline-in-it-which-would-split-a-header"]) {
        const answer = await plane.admin("POST", "/v1/keys/keys.mail.send", { value });
        assert.equal(answer.status, 400, `${JSON.stringify(value)}: ${answer.text}`);
      }
      assert.deepEqual(vendor.seen, [], "nothing malformed reaches a vendor");
    }, { vendorUrl: vendor.url });
  } finally { await vendor.close(); }
});

test("a key the vendor takes is stored, and the answer, the ledger and the presence read carry evidence and never the value", async () => {
  const vendor = await startTakingVendor();
  try {
    await withPlane(async (plane) => {
      const saved = await plane.admin("POST", "/v1/keys/keys.mail.send", { value: PLANTED });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.body.name, "keys.mail.send");
      assert.equal(saved.body.evidence, keyEvidence(PLANTED));
      assert.match(saved.body.checkedWith, /Resend at http/);
      assert.doesNotMatch(saved.body.message, /—/, "no em dash in a sentence a person reads");
      // IT REALLY WENT TO THE VENDOR, with the key as a header and never in the URL.
      assert.equal(vendor.seen.length, 1, JSON.stringify(vendor.seen));
      assert.equal(vendor.seen[0].authorization, `Bearer ${PLANTED}`);
      assert.ok(!vendor.seen[0].url.includes(PLANTED), "the key is in the URL");
      // Stored, and readable only by getSetting, which is the one caller the relay route uses.
      assert.equal(plane.store.getSetting("keys.mail.send", ""), PLANTED);

      // THE LEDGER. One row, finished, carrying the digest and not a fragment of the value.
      const rows = plane.store.listAdminActions({ limit: 50 }).filter((row) => row.action === "keys.set");
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(rows[0].target, "keys.mail.send");
      assert.equal(rows[0].outcome, "ok");
      assert.ok(rows[0].detail.includes(keyEvidence(PLANTED)), rows[0].detail);
      const whole = JSON.stringify(rows);
      assert.ok(!whole.includes(PLANTED), "the ledger holds the value");
      // A PARTIAL IS STILL A LEAK: ten characters of a key is ten characters a log search finds.
      assert.ok(!whole.includes(PLANTED.slice(0, 10)), "the ledger holds a prefix of the value");

      // THE PRESENCE READ. Set, with the evidence, the time and who, and never a value.
      const door = await plane.admin("GET", "/v1/keys");
      assert.equal(door.status, 200, door.text);
      const mail = door.body.keys.find((one) => one.name === "keys.mail.send");
      assert.equal(mail.stored, true);
      assert.equal(mail.evidence, keyEvidence(PLANTED));
      assert.ok(Number(mail.at) > 0, JSON.stringify(mail));
      assert.ok(!door.text.includes(PLANTED), "the presence read answered the value");
      assert.ok(!door.text.includes(PLANTED.slice(0, 10)), "the presence read answered a prefix");
      // And the two that were never pasted say so rather than answering an empty key.
      for (const name of ["keys.voice.xai", "keys.voice.openai"]) {
        const row = door.body.keys.find((one) => one.name === name);
        assert.equal(row.stored, false);
        assert.equal(row.evidence, "");
        assert.equal(row.at, 0);
      }

      // AND NOT THROUGH listSettings EITHER, which is what cp/verification.mjs reads.
      const listed = plane.store.listSettings().find((row) => row.name === "keys.mail.send");
      assert.equal(listed.value, "");
      assert.equal(listed.redacted, true);
    }, { vendorUrl: vendor.url });
  } finally { await vendor.close(); }
});

test("the paste and the presence read are the super admin's, and the relay's own credential does not open either", async () => {
  const vendor = await startTakingVendor();
  try {
    await withPlane(async (plane) => {
      for (const [method, pathname] of [["GET", "/v1/keys"], ["POST", "/v1/keys/keys.mail.send"]]) {
        const body = method === "POST" ? { value: PLANTED } : undefined;
        const none = await plane.request(method, pathname, { body });
        assert.equal(none.status, 401, `${method} ${pathname} with no bearer: ${none.text}`);
        const wrong = await plane.request(method, pathname, { body, token: randomBytes(24).toString("hex") });
        assert.equal(wrong.status, 401, `${method} ${pathname} with a wrong bearer`);
        // THE RELAY'S TOKEN IS NOT THE OPERATOR'S. It reads the values and it may not set one.
        const relay = await plane.request(method, pathname, { body, token: RELAY_TOKEN });
        assert.equal(relay.status, 401, `${method} ${pathname} with the relay token`);
      }
      assert.deepEqual(vendor.seen, [], "a refused caller must not reach a vendor either");
    }, { vendorUrl: vendor.url });
  } finally { await vendor.close(); }
});

test("the relay's read refuses a wrong method BEFORE it looks at the credential", async () => {
  await withPlane(async (plane) => {
    // No credential at all, and the answer is still about the method. A wrong method charges nobody
    // and learns nothing, which is how the mail and push routes beside it already behave.
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const answer = await plane.request(method, "/v1/relay/secrets", { body: {} });
      assert.equal(answer.status, 405, `${method}: ${answer.text}`);
      assert.equal(answer.body.error, "method_not_allowed");
    }
  });
});

test("the relay's read is 401 and NOT 404 without the relay credential, which is the void-route class this exists to rule out", async () => {
  await withPlane(async (plane) => {
    const none = await plane.request("GET", "/v1/relay/secrets");
    assert.equal(none.status, 401, none.text);
    assert.deepEqual(none.body, { error: "unauthorized" });
    // The operator's own bearer does not open it. Two doors, neither doing the other's job.
    const admin = await plane.admin("GET", "/v1/relay/secrets");
    assert.equal(admin.status, 401, admin.text);
  });
});

test("the relay reads values, and a key nobody pasted is OMITTED rather than answered empty", async () => {
  const vendor = await startTakingVendor();
  try {
    await withPlane(async (plane) => {
      const empty = await plane.request("GET", "/v1/relay/secrets", { token: RELAY_TOKEN });
      assert.equal(empty.status, 200, empty.text);
      assert.deepEqual(empty.body, { keys: {} }, "a control plane with nothing pasted answers nothing");

      await plane.admin("POST", "/v1/keys/keys.voice.xai", { value: PLANTED });
      const one = await plane.request("GET", "/v1/relay/secrets", { token: RELAY_TOKEN });
      assert.equal(one.status, 200, one.text);
      assert.deepEqual(Object.keys(one.body.keys), ["keys.voice.xai"]);
      assert.equal(one.body.keys["keys.voice.xai"], PLANTED);
      // An empty string here would quietly BEAT a working file on the relay, because the relay's
      // fallback is decided by absence. So absence is what an unpasted key looks like.
      assert.equal(one.body.keys["keys.mail.send"], undefined);
    }, { vendorUrl: vendor.url });
  } finally { await vendor.close(); }
});

test("pasting over a key replaces it and writes a second ledger row", async () => {
  const vendor = await startTakingVendor();
  try {
    await withPlane(async (plane) => {
      const second = `planted-again-${randomBytes(12).toString("hex")}`;
      await plane.admin("POST", "/v1/keys/keys.voice.openai", { value: PLANTED });
      const again = await plane.admin("POST", "/v1/keys/keys.voice.openai", { value: second });
      assert.equal(again.status, 200, again.text);
      assert.equal(again.body.evidence, keyEvidence(second));
      assert.equal(plane.store.getSetting("keys.voice.openai", ""), second);
      const rows = plane.store.listAdminActions({ limit: 50 }).filter((row) => row.action === "keys.set");
      assert.equal(rows.length, 2, JSON.stringify(rows.map((row) => row.detail)));
      const whole = JSON.stringify(rows);
      for (const value of [PLANTED, second, PLANTED.slice(0, 10), second.slice(0, 10)]) {
        assert.ok(!whole.includes(value), `the ledger holds ${value.slice(0, 10)}…`);
      }
    }, { vendorUrl: vendor.url });
  } finally { await vendor.close(); }
});
