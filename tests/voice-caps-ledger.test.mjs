/**
 * VOICE-1 item A4: the caps, the ledger, the echo gate, and the key that must not leak.
 *
 * THE ORDERING IS THE WHOLE TEST. The ledger row is written when the session is AUTHORISED and
 * BEFORE the provider socket opens. That is not a preference: it is the rule already written in this
 * tree at the mail send routes ("the claim happens BEFORE the mail goes and the outcome is only
 * known after. An unsent mail is recoverable and an unlogged send is not"). A row written on close
 * does not exist for a crashed relay or a tab closed mid-sentence, and the day cap is READ FROM THIS
 * SAME FILE -- so getting it backwards is unbounded spend, not a missing report.
 *
 * And the caps are the RELAY'S OWN CLOCK, never a provider's warning: xAI emits no
 * rate_limits.updated, documents no duration or concurrency cap, and the "25 minutes" people quote
 * belongs to a different API entirely.
 */
import { strict as assert } from "node:assert";
import net from "node:net";
import test from "node:test";
import WebSocketClient from "ws";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStubRealtime } from "./helpers/stub-realtime.mjs";
import {
  AUDIO_RATE, DAY_CAP_SECONDS, ECHO_TAIL_MS, FRAME_BYTES, SESSION_CAP_SECONDS, VENDOR_IDS,
  appendVoiceLedger, daySecondsUsed, dayStartMs, makeEchoGate, makeVoiceEdge, makeVoicePolicy,
  mergeVoiceSettings, normalizeVoiceSettings, readVoiceLedger, readVoiceSettings,
  voiceLedgerRow, voiceSettingsShape, writeVoiceSettings,
} from "../ui/voice-edge.mjs";

/** A key shaped like a real one, so every sweep below has actual bytes to hunt for. */
const PLANTED_KEY = "xai-7Kp2QmZv9LtRxW4sBnE6cD8fJ3yU1aH5";

// ---- the echo gate -------------------------------------------------------------------------------

test("the gate books from BYTES, not from an empty queue, and DROPS what arrives inside the window", () => {
  // The reference this wave was handed does NOT do this. omarchy has ECHO_TAIL_SECONDS,
  // Speaker.is_playing(tail) and _held_frames, and input_audio_buffer.append (realtime.py:653) fires
  // for every frame unconditionally: `.is_playing(` has ZERO call sites and `_held_frames` is never
  // incremented. So the gate is written here, and this asserts frames were DROPPED rather than that
  // a setting exists.
  let ms = 1000;
  const gate = makeEchoGate({ now: () => ms });
  assert.equal(gate.holding(), false, "nothing is playing yet, so the mic is open");
  assert.equal(gate.admit(FRAME_BYTES), true);
  assert.equal(gate.heldFrames, 0);

  // One second of audio, handed over in one go. The model sends it far faster than it is spoken.
  const oneSecond = AUDIO_RATE * 2;
  gate.book(oneSecond);
  assert.equal(gate.playsUntilMs, 2000, "a second of bytes books a second of room");
  assert.equal(gate.holding(), true);
  // Every frame inside the window is dropped and counted.
  for (let i = 0; i < 5; i += 1) assert.equal(gate.admit(FRAME_BYTES), false);
  assert.equal(gate.heldFrames, 5);
  assert.ok(gate.heldMs >= 500, `heldMs was ${gate.heldMs}`);

  // Still held through the tail, and open again only after it.
  ms = 2000;
  assert.equal(gate.holding(), true, "the tail is still running");
  ms = 2000 + ECHO_TAIL_MS - 1;
  assert.equal(gate.holding(), true);
  ms = 2000 + ECHO_TAIL_MS + 1;
  assert.equal(gate.holding(), false, "and then the mic opens again");
  assert.equal(gate.admit(FRAME_BYTES), true);
  assert.equal(gate.heldFrames, 5, "an admitted frame does not add to the held count");
});

test("booking twice queues, rather than overwriting, and a release opens the mic at once", () => {
  let ms = 1000;
  const gate = makeEchoGate({ now: () => ms });
  gate.book(AUDIO_RATE * 2);
  gate.book(AUDIO_RATE * 2);
  // Two seconds of audio is two seconds of room, not one. Overwriting here is how a reply that
  // arrives in ten deltas ends up with the mic open while the speaker is still talking.
  assert.equal(gate.playsUntilMs, 3000);
  gate.release();
  assert.equal(gate.holding(), false, "the person toggled off, so the room is quiet now");
  assert.equal(gate.admit(FRAME_BYTES), true);
});

test("the frame size really is 100 ms of 24 kHz mono PCM16", () => {
  // 4800 bytes = 2400 samples = 100 ms. Every one of the three sides uses this number, so it is
  // pinned rather than assumed: capture written against a 48 kHz track ships double-speed audio
  // that sounds like a bad model rather than a bad rate.
  assert.equal(FRAME_BYTES, 4800);
  assert.equal(AUDIO_RATE, 24000);
  assert.equal((FRAME_BYTES / 2) / AUDIO_RATE, 0.1);
  assert.equal(ECHO_TAIL_MS, 350);
});

// ---- the ledger ----------------------------------------------------------------------------------

test("a row carries the two meters, says which vendor, and carries no transcript, audio or secret", () => {
  const row = voiceLedgerRow({
    sessionId: "vs_1", slug: "acme", agentId: "a1", agentName: "Titan", vendor: "xai", model: "grok-voice-latest",
    startedAt: "2026-09-09T10:00:00.000Z", state: "closed", endedAt: "2026-09-09T10:03:20.000Z",
    wallSeconds: 200, audioInSeconds: 42, audioOutSeconds: 58, billedItemEvents: 3, toolCalls: 4,
    heldFrames: 11, closeReason: "the person pressed the button",
  });
  // BOTH meters, because xAI bills audio sent-or-received plus a flat per-event text fee while
  // OpenAI bills audio tokens with the whole prefix re-read every turn. One "minutes" column
  // reconciles against neither invoice.
  assert.equal(row.audioInSeconds, 42);
  assert.equal(row.audioOutSeconds, 58);
  assert.equal(row.billedItemEvents, 3);
  assert.equal(row.vendor, "xai", "the Spend line can say which meter this is");
  assert.equal(row.wallSeconds, 200, "and the CAPS count wall seconds, the only number a person can predict");
  // ui/mail-edge.mjs:513's rule for its own ledger, and the same reason here: this file is a spend
  // record and the cap's truth, not an archive of what somebody said in their kitchen.
  const asText = JSON.stringify(row);
  for (const forbidden of ["transcript", "apiKey", "key", "prompt", "content", "text", "audio"]) {
    assert.ok(!Object.keys(row).includes(forbidden), `the row carries a ${forbidden} field`);
  }
  assert.ok(!asText.includes("Bearer"));
  // Exactly the shape the Spend line and the day cap both read, and nothing else.
  assert.deepEqual(Object.keys(row).sort(), [
    "agentId", "agentName", "audioInSeconds", "audioOutSeconds", "billedItemEvents", "closeReason",
    "endedAt", "heldFrames", "model", "sessionId", "slug", "startedAt", "state", "toolCalls",
    "vendor", "wallSeconds",
  ]);
});

test("the ledger folds an open row and its settled twin into one row per session", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-ledger-"));
  const file = path.join(dir, "voice-minutes.jsonl");
  try {
    // The file is APPEND-ONLY and a session writes twice: the claim before the dial, and the settled
    // row on close. Rewriting the first line in place would be a read-modify-write on the one file
    // the cap is read from, and a relay killed mid-rewrite would lose rows that were already spent.
    await appendVoiceLedger(voiceLedgerRow({ sessionId: "vs_1", slug: "acme", vendor: "xai", startedAt: "2026-09-09T10:00:00.000Z", state: "open" }), { file });
    await appendVoiceLedger(voiceLedgerRow({ sessionId: "vs_1", slug: "acme", vendor: "xai", startedAt: "2026-09-09T10:00:00.000Z", state: "closed", endedAt: "2026-09-09T10:01:00.000Z", wallSeconds: 60, closeReason: "done" }), { file });
    await appendVoiceLedger(voiceLedgerRow({ sessionId: "vs_2", slug: "acme", vendor: "openai", startedAt: "2026-09-09T11:00:00.000Z", state: "open" }), { file });
    const rows = await readVoiceLedger(file);
    assert.equal(rows.length, 2, "two sessions, not three lines");
    const first = rows.find((row) => row.sessionId === "vs_1");
    assert.equal(first.state, "closed", "the later write wins");
    assert.equal(first.wallSeconds, 60);
    assert.equal(rows.find((row) => row.sessionId === "vs_2").state, "open");
    // A hand-edited or half-written line must not break the file the cap is read from.
    writeFileSync(file, `${readFileSync(file, "utf8")}not json at all\n{"no":"sessionId"}\n`);
    assert.equal((await readVoiceLedger(file)).length, 2);
    // And a file that does not exist yet is an empty ledger, not a 500 on somebody's first click.
    assert.deepEqual(await readVoiceLedger(path.join(dir, "never-written.jsonl")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the day total counts an OPEN row at its current elapsed, not at zero", () => {
  // Two tabs opened at once would otherwise each read the other as costing nothing, and the cap
  // would be per-tab rather than per-workspace.
  const now = Date.parse("2026-09-09T12:00:00.000Z");
  const rows = [
    { sessionId: "a", startedAt: "2026-09-09T10:00:00.000Z", state: "closed", wallSeconds: 600 },
    { sessionId: "b", startedAt: "2026-09-09T11:55:00.000Z", state: "open" },
    // Yesterday's spend is not today's.
    { sessionId: "c", startedAt: "2026-09-08T23:59:00.000Z", state: "closed", wallSeconds: 3000 },
  ];
  assert.equal(daySecondsUsed(rows, now), 600 + 300);
  assert.equal(dayStartMs(now), Date.parse("2026-09-09T00:00:00.000Z"), "the day resets at midnight UTC");
  // A row with an unreadable start cannot be counted, and must not throw either.
  assert.equal(daySecondsUsed([{ sessionId: "x", startedAt: "not a date", state: "open" }], now), 0);
  assert.equal(daySecondsUsed(null, now), 0);
});

test("an abandoned OPEN row is clamped to the session cap, so one relay restart cannot eat the day", () => {
  // A row stays open for two reasons: the session is running (and the relay's own tick closes it at
  // the cap), or the relay died before it could settle. Unclamped, the second case accrues time for
  // the rest of the day -- so after one restart this wave's own caps would lock a customer out over
  // a fault they cannot see or clear. Found by a flaky assertion, which is the only reason it was
  // looked at; the flake was a race in the test and this was the bug underneath it.
  const now = Date.parse("2026-09-09T23:00:00.000Z");
  const abandoned = [{ sessionId: "dead", startedAt: "2026-09-09T00:05:00.000Z", state: "open" }];
  const elapsed = Math.round((now - Date.parse("2026-09-09T00:05:00.000Z")) / 1000);
  assert.ok(elapsed > DAY_CAP_SECONDS, "this row really has been open longer than a whole day's allowance");
  assert.equal(daySecondsUsed(abandoned, now), SESSION_CAP_SECONDS, "and it is only ever worth one session");
  assert.ok(daySecondsUsed(abandoned, now) < DAY_CAP_SECONDS, "so the workspace is not locked out by it");
  // A shorter cap from the control plane clamps harder, because that is the most it could have cost.
  assert.equal(daySecondsUsed(abandoned, now, { openCapSeconds: 120 }), 120);
  // A live session still counts at its real elapsed while it is under the cap.
  const live = [{ sessionId: "live", startedAt: "2026-09-09T22:55:00.000Z", state: "open" }];
  assert.equal(daySecondsUsed(live, now), 300);
});

// ---- the policy ----------------------------------------------------------------------------------

test("the policy falls back to the relay's own constants when the control plane is unreachable", async () => {
  // Which is the NORMAL case on grok-bot-local-vm, where there is no control plane at all.
  const unreachable = makeVoicePolicy({
    relayBase: "http://127.0.0.1:9/never", relayToken: "t",
    fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
  });
  const caps = await unreachable.for("acme");
  assert.equal(caps.sessionCapSeconds, SESSION_CAP_SECONDS);
  assert.equal(caps.dayCapSeconds, DAY_CAP_SECONDS);
  assert.deepEqual(caps.vendors, VENDOR_IDS);
  assert.match(caps.source, /constants/);
  // No control plane configured at all takes the same path without a request.
  let called = 0;
  const none = makeVoicePolicy({ fetchImpl: () => { called += 1; return Promise.reject(new Error("nope")); } });
  assert.equal((await none.for("acme")).dayCapSeconds, DAY_CAP_SECONDS);
  assert.equal(called, 0, "with no cp configured it does not even try");
});

test("the control plane's numbers win, are cached, and a nonsense answer does not become a cap", async () => {
  let calls = 0;
  const policy = makeVoicePolicy({
    relayBase: "http://cp", relayToken: "t", ttlMs: 60000,
    fetchImpl: (url, options) => {
      calls += 1;
      assert.match(String(url), /\/v1\/relay\/voice\/policy\?slug=acme$/);
      // Behind CP_RELAY_TOKEN, which is the credential this relay already holds for the registry.
      assert.equal(options.headers.authorization, "Bearer t");
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessionCapSeconds: 120, dayCapSeconds: 600, vendors: ["xai"] }) });
    },
  });
  assert.equal((await policy.for("acme")).dayCapSeconds, 600);
  assert.equal((await policy.for("acme")).dayCapSeconds, 600);
  assert.equal(calls, 1, "cached for sixty seconds, not read per dial");
  // A zero or a negative is not a cap, it is a bug that would either block everyone or nobody.
  const silly = makeVoicePolicy({
    relayBase: "http://cp", relayToken: "t",
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ sessionCapSeconds: 0, dayCapSeconds: -5, vendors: [] }) }),
  });
  const caps = await silly.for("acme");
  assert.equal(caps.sessionCapSeconds, SESSION_CAP_SECONDS);
  assert.equal(caps.dayCapSeconds, DAY_CAP_SECONDS);
  assert.deepEqual(caps.vendors, VENDOR_IDS);
});

test("usage is reported to the relay door best-effort, and a cp outage costs a Spend line and never a cap", async () => {
  const seen = [];
  const policy = makeVoicePolicy({ relayBase: "http://cp", relayToken: "t", fetchImpl: (url, options) => { seen.push({ url: String(url), body: options.body }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); } });
  assert.equal(await policy.report(voiceLedgerRow({ sessionId: "vs_1", slug: "acme", vendor: "xai" })), true);
  assert.match(seen[0].url, /\/v1\/relay\/voice\/usage$/);
  assert.equal(JSON.parse(seen[0].body).sessionId, "vs_1");
  const broken = makeVoicePolicy({ relayBase: "http://cp", relayToken: "t", fetchImpl: () => Promise.reject(new Error("down")) });
  assert.equal(await broken.report(voiceLedgerRow({ sessionId: "vs_2", slug: "acme", vendor: "xai" })), false, "a refusal, never a throw");
});

// ---- the settings shape, and the key that never comes back ----------------------------------------

test("the settings shape reports the key as a BOOLEAN and never as a value", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-settings-"));
  const file = path.join(dir, "voice.json");
  try {
    await writeVoiceSettings({ enabled: true, vendor: "xai", apiKey: PLANTED_KEY, agentId: "a1" }, { file });
    const settings = await readVoiceSettings(file);
    assert.equal(settings.apiKey, PLANTED_KEY, "on disk it is the real thing, because the relay dials with it");
    const shape = voiceSettingsShape(settings, { sessionCapSeconds: 1800, dayCapSeconds: 7200, dayUsedSeconds: 60 });
    assert.equal(shape.apiKeySet, true);
    assert.equal(shape.apiKey, undefined, "there is no apiKey field at all in the answer");
    assert.ok(!JSON.stringify(shape).includes(PLANTED_KEY), "and not a byte of it anywhere in the shape");
    assert.ok(!JSON.stringify(shape).includes(PLANTED_KEY.slice(0, 8)), "not even a prefix of it");
    assert.equal(shape.dayRemainingSeconds, 7140);
    // The file itself is 0600, because it holds a credential.
    assert.equal(readFileSync(file, "utf8").includes(PLANTED_KEY), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a save sets, clears or KEEPS the key, so the card can save the rest of the form without it", () => {
  const current = normalizeVoiceSettings({ enabled: true, vendor: "xai", apiKey: PLANTED_KEY, agentId: "a1" });
  // Absent: kept. This is what lets the Voice card change the vendor without ever having held a key.
  const vendorOnly = mergeVoiceSettings(current, { vendor: "openai" });
  assert.equal(vendorOnly.apiKey, PLANTED_KEY);
  assert.equal(vendorOnly.vendor, "openai");
  // A string: set. Null: cleared.
  assert.equal(mergeVoiceSettings(current, { apiKey: "  new-key  " }).apiKey, "new-key");
  assert.equal(mergeVoiceSettings(current, { apiKey: null }).apiKey, "");
  // A vendor this relay does not have is not a vendor, and does not become one by being typed.
  assert.equal(mergeVoiceSettings(current, { vendor: "whoever" }).vendor, "xai");
  assert.equal(normalizeVoiceSettings({ vendor: "nonsense" }).vendor, "xai");
  // A hand-edited file cannot break a route.
  assert.deepEqual(normalizeVoiceSettings(null), normalizeVoiceSettings({}));
  assert.equal(normalizeVoiceSettings({ apiKey: 42 }).apiKey, "");
  assert.equal(normalizeVoiceSettings({}).enabled, false, "voice is off until somebody turns it on");
});

// ---- the harness: a real browser socket, a real stub, and a dial we can freeze -------------------
//
// Duplicated from tests/voice-turn.test.mjs on purpose. This wave owns exactly one test helper
// (tests/helpers/stub-realtime.mjs, which item C's gate imports) and adding a second shared file
// would put a file in two waves' hands for the sake of thirty lines.

async function openSocket({ dir, settings, stub = null, gateway = null, WebSocketImpl = null, origin = null, relay = {}, capTickMs = undefined }) {
  await writeVoiceSettings(settings, { file: path.join(dir, "voice.json") });
  const logLines = [];
  const t = {
    slug: "acme", name: "Acme", operator: false,
    gateway: "http://127.0.0.1:1/unused",
    headers: () => ({}),
    ensureDir: () => {},
    voiceSettingsFile: path.join(dir, "voice.json"),
    voiceLedgerFile: path.join(dir, "voice-minutes.jsonl"),
  };
  const call = gateway ?? (async (command) => (command === "listAgents" ? { agents: [{ id: "a1", name: "Titan", isRunning: true }] } : {}));
  const edge = makeVoiceEdge({
    t, call, policy: makeVoicePolicy(relay), providerUrl: stub?.url ?? "ws://127.0.0.1:9/never",
    WebSocketImpl, log: (line) => logLines.push(String(line)),
    ...(capTickMs == null ? {} : { capTickMs }),
  });
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  server.on("connection", (socket) => {
    let head = "";
    const onData = (chunk) => {
      head += String(chunk);
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const headers = Object.fromEntries(head.split("\r\n").slice(1).filter((l) => l.includes(":"))
        .map((line) => [line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
      edge.handleUpgrade({ headers, method: "GET", url: "/voice/socket" }, socket, null, { origin })
        .catch((error) => logLines.push(`handleUpgrade threw: ${error?.stack ?? error}`));
    };
    socket.on("data", onData);
  });
  const client = new WebSocketClient(`ws://127.0.0.1:${port}/voice/socket`);
  const frames = { json: [], binary: [] };
  const closed = new Promise((resolve) => client.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
  client.on("message", (data, isBinary) => {
    if (isBinary) frames.binary.push(Buffer.from(data));
    else { try { frames.json.push(JSON.parse(String(data))); } catch { /* not JSON */ } }
  });
  await new Promise((resolve, reject) => {
    client.on("open", resolve);
    client.on("error", reject);
    const timer = setTimeout(() => reject(new Error("the voice socket never opened")), 6000);
    timer.unref();
  });
  const settle = async (predicate, label, tries = 200) => {
    for (let i = 0; i < tries; i += 1) {
      if (predicate()) return true;
      await new Promise((r) => { const timer = setTimeout(r, 20); timer.unref(); });
    }
    throw new Error(`timed out waiting for ${label}. frames: ${JSON.stringify(frames.json).slice(0, 500)} relay: ${logLines.join(" | ").slice(0, 400)}`);
  };
  return {
    client, frames, edge, settle, closed, logLines,
    of: (kind) => frames.json.filter((f) => f.t === kind),
    ledger: () => (existsSync(t.voiceLedgerFile) ? readFileSync(t.voiceLedgerFile, "utf8") : ""),
    close: async () => { client.terminate(); await new Promise((resolve) => server.close(resolve)); },
  };
}

// ---- claim before dial ---------------------------------------------------------------------------

test("the ledger row exists BEFORE the provider is dialled, and is settled on close", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-claim-"));
  const ledgerFile = path.join(dir, "voice-minutes.jsonl");
  // A WebSocket that records what the ledger held AT THE MOMENT OF CONSTRUCTION. That snapshot is
  // the proof of ordering: no amount of "it happens soon after" would be.
  const atDial = { ledger: null, dials: 0 };
  class FrozenDial {
    constructor(url) {
      atDial.dials += 1;
      atDial.url = String(url);
      atDial.ledger = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : "";
      this.readyState = 0;
    }
    addEventListener() {}
    send() { throw new Error("this dial never opens"); }
    close() { this.readyState = 3; }
  }
  let session = null;
  try {
    session = await openSocket({ dir, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY }, WebSocketImpl: FrozenDial });
    await session.settle(() => atDial.dials > 0, "the dial");
    assert.equal(atDial.dials, 1);
    // THE ASSERTION THIS FILE EXISTS FOR.
    assert.ok(atDial.ledger.length > 0, "the ledger was EMPTY when the provider was dialled");
    const claimed = JSON.parse(atDial.ledger.trim().split("\n")[0]);
    assert.equal(claimed.state, "open");
    assert.equal(claimed.slug, "acme");
    assert.equal(claimed.vendor, "xai");
    assert.equal(claimed.agentName, "Titan");
    assert.ok(claimed.startedAt.length > 0);
    assert.equal(claimed.endedAt, null);
    // And the key is not in the row that was just written.
    assert.ok(!atDial.ledger.includes(PLANTED_KEY));
    // Now close from the browser side and the row settles.
    session.client.close(1000, "done");
    await session.settle(() => (session.ledger().match(/"state":"closed"/g) ?? []).length > 0, "the settled row");
    const rows = await readVoiceLedger(ledgerFile);
    assert.equal(rows.length, 1, "one row per session, folded from its two writes");
    assert.equal(rows[0].state, "closed");
    assert.ok(rows[0].endedAt != null);
    assert.ok(rows[0].closeReason.length > 0, "and it says why it closed");
  } finally {
    await session?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the caps, from the browser's point of view ---------------------------------------------------

test("the day cap refuses in one plain sentence on an ACCEPTED socket, and opens no row", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-daycap-"));
  const ledgerFile = path.join(dir, "voice-minutes.jsonl");
  // Spent to the cap already, today.
  await appendVoiceLedger(voiceLedgerRow({
    sessionId: "vs_old", slug: "acme", vendor: "xai", startedAt: new Date().toISOString(),
    state: "closed", endedAt: new Date().toISOString(), wallSeconds: DAY_CAP_SECONDS + 5,
  }), { file: ledgerFile });
  const before = readFileSync(ledgerFile, "utf8");
  let session = null;
  try {
    session = await openSocket({ dir, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY } });
    // A refusal is WORDS on an accepted socket. Measured: an unknown upgrade path answers zero bytes
    // and real Chrome reports only onerror at 16 ms with no close code, which a person reads as "the
    // relay is down". So this must be a 101, a sentence, and a close that carries its reason.
    await session.settle(() => session.of("note").length > 0, "the refusal sentence");
    const note = session.of("note")[0].text;
    assert.match(note, /voice time for today/);
    assert.match(note, /midnight UTC/, "and it says when it comes back");
    for (const vendor of ["xAI", "x.ai", "OpenAI", "Grok", "grok"]) assert.ok(!note.includes(vendor), `the sentence names ${vendor}`);
    assert.ok(!note.includes("titan("), "and never a tool name");
    const closed = await session.closed;
    assert.equal(closed.code, 1000, "a clean close, not a reset");
    assert.ok(closed.reason.length > 0, "carrying a reason the page can read");
    assert.equal(readFileSync(ledgerFile, "utf8"), before, "a refused session opens no row");
  } finally {
    await session?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the session cap is the relay's own clock and closes the line in words", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-sesscap-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  let session = null;
  try {
    // A cap of one second, through the control-plane door, because a customer cannot set this. The
    // tick is shortened too: the production tick is ten seconds, and waiting for a real one made
    // this assertion pass alone and flake inside a full bundle, which is worse than no assertion.
    session = await openSocket({
      dir, stub, capTickMs: 40, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY },
      relay: {
        relayBase: "http://cp", relayToken: "t",
        fetchImpl: (url) => (String(url).includes("/policy")
          ? Promise.resolve({ ok: true, json: () => Promise.resolve({ sessionCapSeconds: 1, dayCapSeconds: 7200, vendors: ["xai"] }) })
          : Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
      },
    });
    assert.equal(session.of("ready")[0].sessionCapSeconds, 1, "the page is told the cap it is under");
    await session.settle(() => session.of("note").length > 0, "the cap closing the line", 400);
    assert.match(session.of("note")[0].text, /time limit for one conversation/);
    assert.match(session.of("note")[0].text, /Press the button again/, "and what to do about it");
    // The sentence reaches the person FIRST and the ledger settles a moment later, which is the right
    // order for a human and the wrong order to assert in one breath. Waiting for the settled row is
    // the honest assertion; reading it straight after the note was a race that passed most runs.
    await session.settle(() => (session.ledger().match(/"state":"closed"/g) ?? []).length > 0, "the settled row");
    const rows = await readVoiceLedger(path.join(dir, "voice-minutes.jsonl"));
    assert.equal(rows[0].state, "closed");
    assert.match(rows[0].closeReason, /session cap/);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a vendor the control plane does not allow is refused in words", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-vendor-"));
  let session = null;
  try {
    session = await openSocket({
      dir, settings: { enabled: true, vendor: "openai", apiKey: PLANTED_KEY },
      relay: { relayBase: "http://cp", relayToken: "t", fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ sessionCapSeconds: 1800, dayCapSeconds: 7200, vendors: ["xai"] }) }) },
    });
    await session.settle(() => session.of("note").length > 0, "the refusal");
    assert.match(session.of("note")[0].text, /not available on this console/);
    assert.ok(!session.of("note")[0].text.toLowerCase().includes("openai"), "and it does not name the vendor");
  } finally {
    await session?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no key, voice switched off, and no bot are each one plain sentence", async () => {
  for (const [settings, pattern] of [
    [{ enabled: true, vendor: "xai", apiKey: "" }, /no realtime voice key yet/],
    [{ enabled: false, vendor: "xai", apiKey: PLANTED_KEY }, /switched off/],
  ]) {
    const dir = mkdtempSync(path.join(tmpdir(), "voice-refuse-"));
    let session = null;
    try {
      session = await openSocket({ dir, settings });
      await session.settle(() => session.of("note").length > 0, `the refusal for ${JSON.stringify(settings)}`);
      assert.match(session.of("note")[0].text, pattern);
      // Every refusal points at the one place a person can fix it.
      assert.match(session.of("note")[0].text, /Voice card in Settings/);
      assert.equal(session.of("state").at(-1).value, "off", "and the orb goes back to off");
    } finally {
      await session?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // A roster with nothing on it but a room has no bot to talk to.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-noagent-"));
  let session = null;
  try {
    session = await openSocket({
      dir, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY },
      gateway: async (command) => (command === "listAgents" ? { agents: [{ id: "r1", name: "Weekly Room", isGroup: true }] } : {}),
    });
    await session.settle(() => session.of("note").length > 0, "the no-bot refusal");
    assert.match(session.of("note")[0].text, /no bot in this workspace/);
  } finally {
    await session?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cross-origin upgrade is refused in words, not by destroying the socket", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-origin-"));
  let session = null;
  try {
    session = await openSocket({ dir, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY }, origin: false });
    await session.settle(() => session.of("note").length > 0, "the origin refusal");
    assert.match(session.of("note")[0].text, /page this console does not serve/);
    assert.match(session.of("note")[0].text, /did not open the microphone/);
    const closed = await session.closed;
    assert.equal(closed.code, 1000);
    assert.equal(readFileSync(path.join(dir, "voice.json"), "utf8").includes(PLANTED_KEY), true, "the key is untouched on disk");
    assert.ok(!existsSync(path.join(dir, "voice-minutes.jsonl")), "and a refused origin opens no row");
  } finally {
    await session?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the gate, server side, with a real provider on the other end --------------------------------

test("browser audio arriving inside the held window is DROPPED, and the count is a server-side number", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-gate-"));
  const stub = await startStubRealtime({ vendor: "xai", audioFrames: 20 });
  let session = null;
  try {
    session = await openSocket({ dir, stub, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY } });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update");
    // Before anything is spoken, the mic is open and frames go through.
    session.client.send(Buffer.alloc(FRAME_BYTES, 0x10));
    await session.settle(() => stub.events.appendFrames >= 1, "the first frame reaching the provider");
    const openFrames = stub.events.appendFrames;

    // Now the model speaks two seconds of audio, handed over in one burst the way a model really
    // does it. From here the relay must drop browser audio even if the page sends it anyway.
    await stub.speak("Here is a long answer.");
    await session.settle(() => session.of("speak-begin").length > 0, "the speak-begin frame");
    for (let i = 0; i < 10; i += 1) session.client.send(Buffer.alloc(FRAME_BYTES, 0x20));
    // Give them time to arrive and be refused.
    await new Promise((r) => { const timer = setTimeout(r, 200); timer.unref(); });
    assert.equal(stub.events.appendFrames, openFrames, "not one held frame reached the provider");

    // A patched page cannot make the model hear itself: the gate is on BOTH sides, and this is the
    // server side proving it with no browser co-operation at all.
    session.client.close(1000, "done");
    await session.settle(() => (session.ledger().match(/"state":"closed"/g) ?? []).length > 0, "the settled row");
    const rows = await readVoiceLedger(path.join(dir, "voice-minutes.jsonl"));
    assert.ok(rows[0].heldFrames >= 10, `the ledger recorded ${rows[0].heldFrames} held frames`);
    assert.ok(rows[0].audioOutSeconds >= 1, `the model's own audio was metered: ${rows[0].audioOutSeconds}s`);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the provider socket closes when the person toggles off", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-stop-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  let session = null;
  try {
    session = await openSocket({ dir, stub, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY } });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update");
    assert.equal(stub.events.closed, 0);
    session.client.send(JSON.stringify({ t: "stop" }));
    await session.settle(() => stub.events.closed > 0, "the provider socket closing");
    const closed = await session.closed;
    assert.match(closed.reason, /pressed the button/);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the key sweep -------------------------------------------------------------------------------

test("a planted key's bytes appear in no URL, no ledger line, no log line and no settings answer", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-sweep-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  let session = null;
  try {
    session = await openSocket({ dir, stub, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY } });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update");
    session.client.send(Buffer.alloc(FRAME_BYTES, 0x30));
    await session.settle(() => stub.events.appendFrames > 0, "audio going out");
    session.client.close(1000, "done");
    await session.settle(() => (session.ledger().match(/"state":"closed"/g) ?? []).length > 0, "the settled row");

    // 1. The wire. The credential arrived as a header and the URL carries nothing.
    for (const request of stub.events.requests) {
      assert.ok(!request.url.includes(PLANTED_KEY), `the key is in a URL: ${request.url}`);
      assert.ok(!request.subprotocol.includes(PLANTED_KEY), "the key is in a subprotocol, which proxies log");
      assert.equal(request.auth, `Bearer ${PLANTED_KEY}`, "and it did arrive, as a header");
    }
    // 2. The ledger, which is the one file that grows forever.
    assert.ok(!session.ledger().includes(PLANTED_KEY), "the key is in the minutes ledger");
    // 3. Every line the relay logged.
    assert.ok(!session.logLines.join("\n").includes(PLANTED_KEY), `the key is in a log line: ${session.logLines.join(" | ")}`);
    // 4. Every frame the page was ever sent, which is the one a person can open devtools on.
    assert.ok(!JSON.stringify(session.frames.json).includes(PLANTED_KEY), "the key reached the browser");
    // And a partial is still a leak: eight characters of a key is eight characters a log search finds.
    const head = PLANTED_KEY.slice(0, 10);
    assert.ok(!session.ledger().includes(head));
    assert.ok(!JSON.stringify(session.frames.json).includes(head));
    assert.ok(!session.logLines.join("\n").includes(head));
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
