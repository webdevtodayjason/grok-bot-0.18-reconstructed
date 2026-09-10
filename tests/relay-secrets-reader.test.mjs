// KEYS-1. The relay's copy of the keys the product uses: what it does when the control plane is
// absent, present, broken, or has no door at all.
//
// THE ONE THAT MATTERS MOST is the 404 line. This product already has a silent void route of exactly
// this class -- the relay calls POST /v1/relay/code/e2b-key, the live control plane 404s it while its
// sibling answers 401, codeE2bKey() swallows the answer, and a cloud coding task is refused as "no
// key" forever while two gap rows blame an unpasted key. A door that is not there is a DEPLOY fact
// and reads nothing like a service that is down, so it gets its own sentence and does not hide inside
// the outage line.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SECRET_NAMES, createSecretsReader, voiceKeyName } from "../ui/relay-secrets.mjs";

const CP = "http://127.0.0.1:59999";
const TOKEN = "relay-token-for-a-reader-test";
const ENV = { CP_URL: CP, CP_RELAY_TOKEN: TOKEN };
const PLANTED = "planted-value-0123456789abcdef";

/** A fetch that answers what the arm says and records what it was asked. */
function fakeFetch(arms) {
  const calls = [];
  let at = 0;
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url: String(url), authorization: String(init?.headers?.authorization ?? "") });
      const arm = arms[Math.min(at, arms.length - 1)];
      at += 1;
      if (typeof arm === "function") return arm();
      return {
        status: arm.status,
        json: async () => arm.body ?? {},
      };
    },
  };
}

test("the three names are the control plane's three names", () => {
  assert.deepEqual([...SECRET_NAMES], ["keys.voice.xai", "keys.voice.openai", "keys.mail.send"]);
  assert.equal(voiceKeyName("xai"), "keys.voice.xai");
  assert.equal(voiceKeyName("openai"), "keys.voice.openai");
  // Not a service we have a key for is "", never the other one's key.
  assert.equal(voiceKeyName("something-else"), "");
});

test("with no control plane it answers nothing and asks nobody, which is every single-box install", async () => {
  for (const env of [{}, { CP_URL: CP }, { CP_RELAY_TOKEN: TOKEN }, { CP_URL: "", CP_RELAY_TOKEN: "" }]) {
    const fake = fakeFetch([{ status: 200, body: { keys: { "keys.mail.send": PLANTED } } }]);
    const reader = createSecretsReader({ env, fetchImpl: fake.impl });
    assert.equal(reader.configured, false, JSON.stringify(env));
    assert.deepEqual(reader.current(), {});
    assert.equal(await reader.value("keys.mail.send"), "");
    await reader.refresh();
    assert.deepEqual(fake.calls, [], `a console with no control plane asked for ${JSON.stringify(env)}`);
    // And starting it starts nothing, so a gate's relay still exits.
    const stop = reader.start();
    assert.equal(typeof stop, "function");
    stop();
  }
});

test("it reads the door with the relay credential as a header, and never in the URL", async () => {
  const fake = fakeFetch([{ status: 200, body: { keys: { "keys.voice.xai": PLANTED } } }]);
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl });
  assert.equal(await reader.value("keys.voice.xai"), PLANTED);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, `${CP}/v1/relay/secrets`);
  assert.equal(fake.calls[0].authorization, `Bearer ${TOKEN}`);
  assert.ok(!fake.calls[0].url.includes(TOKEN), "the credential is in the URL");
});

test("a name the door did not answer is empty, and an empty string is not a value", async () => {
  const fake = fakeFetch([{ status: 200, body: { keys: { "keys.voice.xai": PLANTED, "keys.mail.send": "   " } } }]);
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl });
  await reader.refresh();
  assert.equal(await reader.value("keys.voice.openai"), "", "a name nobody pasted");
  // An empty or whitespace value would otherwise BEAT a working file, because the relay's fallback
  // is decided by absence. It is dropped here rather than carried as a key of no length.
  assert.equal(await reader.value("keys.mail.send"), "");
  assert.deepEqual(Object.keys(reader.current()), ["keys.voice.xai"]);
  // A name the control plane invented is ignored: the allowlist is this side's too.
  const other = fakeFetch([{ status: 200, body: { keys: { "keys.something.else": PLANTED } } }]);
  const second = createSecretsReader({ env: ENV, fetchImpl: other.impl });
  await second.refresh();
  assert.deepEqual(second.current(), {});
});

test("a non-200 keeps the last good copy rather than going empty or throwing", async () => {
  const fake = fakeFetch([
    { status: 200, body: { keys: { "keys.mail.send": PLANTED } } },
    { status: 500 },
    { status: 401 },
  ]);
  const lines = [];
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl, log: (line) => lines.push(line) });
  assert.equal(await reader.value("keys.mail.send"), PLANTED);
  await reader.refresh();
  assert.equal(await reader.value("keys.mail.send"), PLANTED, "a 500 emptied the copy");
  await reader.refresh();
  assert.equal(await reader.value("keys.mail.send"), PLANTED, "a 401 emptied the copy");
  assert.equal(lines.length, 2, lines.join(" | "));
  for (const line of lines) {
    assert.match(line, /keeping the last copy/);
    // The outage line must not carry the value, and must not read as a missing door.
    assert.ok(!line.includes(PLANTED), line);
    assert.doesNotMatch(line, /does not have the keys door/);
  }
});

test("a throw keeps the last good copy too, and says so once per failure without the value", async () => {
  const fake = fakeFetch([
    { status: 200, body: { keys: { "keys.voice.xai": PLANTED } } },
    () => { throw new Error("connect ECONNREFUSED 127.0.0.1:59999"); },
  ]);
  const lines = [];
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl, log: (line) => lines.push(line) });
  assert.equal(await reader.value("keys.voice.xai"), PLANTED);
  await reader.refresh();
  assert.equal(await reader.value("keys.voice.xai"), PLANTED);
  assert.equal(lines.length, 1, lines.join(" | "));
  assert.match(lines[0], /could not be read/);
  assert.ok(!lines[0].includes(PLANTED));
});

test("a 404 says the door is not there, in its own sentence, ONCE", async () => {
  const fake = fakeFetch([{ status: 404 }]);
  const lines = [];
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl, log: (line) => lines.push(line) });
  assert.equal(await reader.value("keys.mail.send"), "");
  await reader.refresh();
  await reader.refresh();
  assert.equal(fake.calls.length, 3, "it keeps asking, because a deploy can add the door");
  // ONE line, and it is not the outage line: "this control plane is down" and "this control plane
  // does not have that route" are two different mornings and the log has to tell them apart.
  assert.equal(lines.length, 1, lines.join(" | "));
  assert.match(lines[0], /does not have the keys door yet/);
  assert.doesNotMatch(lines[0], /keeping the last copy/);
});

test("two callers at boot are ONE request", async () => {
  const fake = fakeFetch([{ status: 200, body: { keys: { "keys.mail.send": PLANTED } } }]);
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl });
  const [a, b, c] = await Promise.all([
    reader.value("keys.mail.send"),
    reader.value("keys.voice.xai"),
    reader.refresh(),
  ]);
  assert.equal(a, PLANTED);
  assert.equal(b, "");
  assert.ok(c != null);
  assert.equal(fake.calls.length, 1, `${fake.calls.length} requests for one boot`);
});

test("nothing is written to disk, ever", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-secrets-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const fake = fakeFetch([{ status: 200, body: { keys: { "keys.mail.send": PLANTED } } }]);
    const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl });
    await reader.refresh();
    assert.equal(await reader.value("keys.mail.send"), PLANTED);
    const stop = reader.start();
    await reader.refresh();
    stop();
    // The whole point of the reader is that the control plane is the only durable home. A copy on a
    // relay's disk is a second place to rotate, a second place to leak, and a second answer to
    // "which key is live".
    assert.deepEqual(readdirSync(dir), [], `the reader wrote ${readdirSync(dir).join(", ")}`);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the refresh timer is unref'd, so a relay holding one still exits", async () => {
  const fake = fakeFetch([{ status: 200, body: { keys: {} } }]);
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl, refreshMs: 50 });
  const stop = reader.start();
  // If the interval held the loop open, `node --test` on this file would never finish. The stop is
  // called anyway, because a test that leans on unref to exit is a test that hangs when it regresses.
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  assert.ok(fake.calls.length >= 1);
});
