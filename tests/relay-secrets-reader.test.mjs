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
import { readFile } from "node:fs/promises";
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
  assert.equal(fake.calls[0].url, `${CP}/v1/relay/keys`);
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

// ---- blind: cannot see, as against nobody has pasted one -----------------------------------------
//
// The two conditions hand every caller the same empty string and they are acted on by different
// people. "Nobody pasted a key" is a thing the OPERATOR does, once. "This relay cannot reach the
// control plane" is a thing that is broken and clears itself. mail settles a different outcome word
// on each and voice says a different sentence, so the reader has to be able to tell them apart.

test("blind is false with no control plane, because there is nothing there to be unable to reach", async () => {
  const fake = fakeFetch([{ status: 200, body: { keys: {} } }]);
  const reader = createSecretsReader({ env: {}, fetchImpl: fake.impl });
  assert.equal(reader.blind, false);
  await reader.refresh();
  assert.equal(reader.blind, false, "a single-box install must never read as an outage");
});

test("blind is false before anything has been asked, so a relay that has just booted refuses nothing", () => {
  const fake = fakeFetch([{ status: 200, body: { keys: {} } }]);
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl });
  assert.equal(reader.blind, false, "an unasked reader is not a failed reader");
});

test("blind is true after a read that did not get through with nothing cached", async () => {
  const fake = fakeFetch([() => { throw new Error("connect ECONNREFUSED"); }]);
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl, log: () => {} });
  assert.equal(await reader.value("keys.mail.send"), "");
  assert.equal(reader.blind, true, "an unreachable control plane with no copy is not an empty one");
});

test("a control plane that answers with no key at all is NOT blind: that is an operator who has pasted nothing", async () => {
  const fake = fakeFetch([{ status: 200, body: { keys: {} } }]);
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl });
  assert.equal(await reader.value("keys.mail.send"), "");
  assert.equal(reader.blind, false, "an empty answer is an answer");
});

test("an older control plane with no door at all is NOT blind, because its files are the right home", async () => {
  // 404 is a DEPLOY fact: that deployment keeps its keys on its own files and its mail sends
  // perfectly. Calling it unreachable would settle key_unreachable over a key sitting right there.
  const fake = fakeFetch([{ status: 404, body: {} }]);
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl, log: () => {} });
  assert.equal(await reader.value("keys.mail.send"), "");
  assert.equal(reader.blind, false);
});

test("a good copy already held survives an outage, and blind stays false while it does", async () => {
  const fake = fakeFetch([
    { status: 200, body: { keys: { "keys.mail.send": PLANTED } } },
    () => { throw new Error("connect ECONNREFUSED"); },
  ]);
  const reader = createSecretsReader({ env: ENV, fetchImpl: fake.impl, log: () => {} });
  assert.equal(await reader.value("keys.mail.send"), PLANTED);
  await reader.refresh();
  assert.equal(await reader.value("keys.mail.send"), PLANTED, "the last good copy is what keeps mail sending");
  assert.equal(reader.blind, false, "a live copy is a live copy however the last refresh went");
});

test("every read carries a deadline, and the two numbers are the shorter pair", async () => {
  // A fetch with no deadline is the hang this exists to prevent: a black-holed control plane would
  // hold a websocket upgrade open with a lit Talk button and nothing said.
  let sawSignal = false;
  const impl = async (_url, init) => { sawSignal = init?.signal != null; return { status: 200, json: async () => ({ keys: {} }) }; };
  await createSecretsReader({ env: ENV, fetchImpl: impl }).refresh();
  assert.equal(sawSignal, true, "the read carries no deadline");

  // AbortSignal.timeout carries no readable millisecond count, so the numbers are pinned at the
  // source. MEASURED on the R750 2026-09-10: the relay-to-control-plane round trip is 194 ms with
  // the bearer, so six seconds is thirty times the real answer and fires only on an outage.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const source = await readFile(path.join(here, "..", "ui", "relay-secrets.mjs"), "utf8");
  assert.match(source, /refreshMs = 60_000/, "the refresh is no longer a minute, so a rotated key takes longer to land");
  assert.match(source, /timeoutMs = 6_000/, "the timeout is no longer six seconds, so a press waits longer on an outage");
});
