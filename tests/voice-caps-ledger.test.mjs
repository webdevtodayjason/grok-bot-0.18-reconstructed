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

test("a session that crossed midnight counts against today, for the part that falls inside it", () => {
  // docs/VOICE.md 9 promises both halves of such a session count. cp/voice.mjs did that and THIS
  // side did not: a row dated yesterday was skipped outright, so the enforcement truth -- the relay's
  // own file -- counted 300 seconds of a live session as nought and handed the next press a whole
  // fresh day. MEASURED on this Mac before the fix at exactly this shape.
  const now = Date.parse("2026-09-10T00:05:00.000Z");
  const crossing = [{ sessionId: "midnight", startedAt: "2026-09-09T23:59:30.000Z", state: "open" }];
  assert.equal(daySecondsUsed(crossing, now), 300, "the five minutes that fall inside today are today's");
  // Yesterday's half is yesterday's, and nothing counts a second time.
  assert.equal(daySecondsUsed(crossing, Date.parse("2026-09-09T23:59:40.000Z")), 10);
  // An open row from days ago counts only TODAY'S slice of itself, because the window is clipped
  // before the session cap is applied -- the cap is an upper bound on the slice, not the slice.
  const ancient = [{ sessionId: "ancient", startedAt: "2026-09-08T12:00:00.000Z", state: "open" }];
  assert.equal(daySecondsUsed(ancient, now), 300);
  // And late in the day that clamp is what stops such a row eating the whole allowance.
  assert.equal(daySecondsUsed(ancient, Date.parse("2026-09-10T23:00:00.000Z")), SESSION_CAP_SECONDS);
  // A CLOSED row still counts against the day it started on, which is where an operator looks for it.
  const closed = [{ sessionId: "yesterday", startedAt: "2026-09-09T23:00:00.000Z", state: "closed", wallSeconds: 600 }];
  assert.equal(daySecondsUsed(closed, now), 0);
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
  // TWO PATHS AND NOT ONE, and it is the claim that makes it two: cp/server.mjs:1108 answers
  // /usage/open and /usage/close, because the claim happens BEFORE the provider socket opens and the
  // outcome is only known after. Reported at the parent path the control plane answered 404 and the
  // operator's Spend line stayed empty while the minutes were really being spent -- found at
  // integration against a real cp, not here, which is why this asserts the path and not just the body.
  assert.equal(await policy.report(voiceLedgerRow({ sessionId: "vs_1", slug: "acme", vendor: "xai" })), true);
  assert.match(seen[0].url, /\/v1\/relay\/voice\/usage\/open$/);
  const opened = JSON.parse(seen[0].body);
  assert.equal(opened.sessionId, "vs_1");
  assert.equal(opened.slug, "acme", "the claim names the workspace, because that is what the cap is per");
  assert.equal(opened.wallSeconds, undefined, "and carries no duration, because nothing has been spent yet");

  assert.equal(await policy.report(voiceLedgerRow({ sessionId: "vs_1", slug: "acme", vendor: "xai", state: "closed", wallSeconds: 42, heldFrames: 7, closeReason: "the person pressed the button" })), true);
  assert.match(seen[1].url, /\/v1\/relay\/voice\/usage\/close$/);
  const closed = JSON.parse(seen[1].body);
  assert.equal(closed.sessionId, "vs_1", "settled by the same id it was claimed under");
  assert.equal(closed.wallSeconds, 42);
  assert.equal(closed.heldFrames, 7);
  assert.equal(closed.slug, undefined, "the settle names no workspace: the row it settles already knows");
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

// ---- VOICE-10 and VOICE-8: whose field is whose on this door --------------------------------------

test("VOICE-10: a talk mode lands under the caller's own sub and is invisible to another", () => {
  // TWO ACCOUNTS CAN SHARE ONE WORKSPACE -- cp/store.mjs puts no UNIQUE constraint on accounts.tenant
  // -- and voice.json is one file for that workspace. So the talk mode is the one field on this door
  // keyed on the SUB, which is the session's own person claim and the same key the device list and the
  // notification settings use. A person writing theirs can neither read nor move anybody else's.
  const empty = normalizeVoiceSettings({});
  assert.deepEqual(empty.talkModes, {}, "a workspace nobody has chosen on carries an empty map, not a default");

  const hers = mergeVoiceSettings(empty, { talkMode: "always" }, { sub: "person-a" });
  assert.deepEqual(hers.talkModes, { "person-a": "always" });
  const both = mergeVoiceSettings(hers, { talkMode: "push" }, { sub: "person-b" });
  assert.deepEqual(both.talkModes, { "person-a": "always", "person-b": "push" },
    "one person's write moved the other's choice");

  // And the ANSWER carries one entry, never the map: there is no route on this relay that reads back
  // how somebody else's button behaves.
  const mine = voiceSettingsShape(both, { sub: "person-a" });
  assert.equal(mine.talkMode, "always");
  assert.equal(mine.talkModes, undefined, "the whole map came back in the answer");
  assert.equal(voiceSettingsShape(both, { sub: "person-b" }).talkMode, "push");
  // A person who has never chosen gets the field OMITTED rather than defaulted, which is the PROXY-1
  // rule: it is how the page knows to keep its own browser's copy instead of being handed a value the
  // relay made up.
  assert.equal(voiceSettingsShape(both, { sub: "person-c" }).talkMode, undefined);
  assert.equal(voiceSettingsShape(both).talkMode, undefined, "and no sub at all is not somebody's choice either");
  // The instance-password door is "" everywhere else in this process, and it is a real person here too.
  assert.equal(voiceSettingsShape(mergeVoiceSettings(empty, { talkMode: "always" }), { sub: "" }).talkMode, "always");

  // A value this relay does not know is IGNORED and not defaulted, because a default written over a real
  // choice is a choice silently thrown away. Null clears this person's entry and nobody else's.
  assert.deepEqual(mergeVoiceSettings(both, { talkMode: "sideways" }, { sub: "person-a" }).talkModes, both.talkModes);
  assert.deepEqual(mergeVoiceSettings(both, { talkMode: null }, { sub: "person-a" }).talkModes, { "person-b": "push" });
  // A hand-edited file cannot break the route, and the map is bounded.
  assert.deepEqual(normalizeVoiceSettings({ talkModes: "nonsense" }).talkModes, {});
  assert.deepEqual(normalizeVoiceSettings({ talkModes: { who: "sideways", 7: "push" } }).talkModes, { 7: "push" });
  const many = {};
  for (let n = 0; n < 260; n += 1) many[`p${n}`] = "always";
  assert.equal(Object.keys(normalizeVoiceSettings({ talkModes: many }).talkModes).length, 200,
    "a state file that grows by one per person forever is one somebody finds at a gigabyte");
});

/** A request and a response this file can drive handleSettings with, and read back. */
function fakeExchange({ method = "GET", body = null, sub = "" } = {}) {
  const chunks = body == null ? [] : [JSON.stringify(body)];
  const req = {
    method,
    headers: { "x-gate-sub": sub },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
  const out = { status: 0, headers: {}, text: "" };
  const res = {
    writeHead: (status, headers) => { out.status = status; out.headers = headers ?? {}; },
    end: (text) => { out.text = String(text ?? ""); },
  };
  return { req, res, out, json: () => { try { return JSON.parse(out.text); } catch { return null; } } };
}

function settingsEdge({ dir, operator }) {
  const t = {
    slug: operator ? "titanium" : "acme", name: "Acme", operator,
    gateway: "http://127.0.0.1:1/unused",
    headers: () => ({}),
    ensureDir: () => {},
    voiceSettingsFile: path.join(dir, "voice.json"),
    voiceLedgerFile: path.join(dir, "voice-minutes.jsonl"),
  };
  return makeVoiceEdge({
    t,
    call: async (command) => (command === "listAgents" ? { agents: [{ id: "a1", name: "Titan", isRunning: true }] } : {}),
    policy: makeVoicePolicy({}),
    // The one dep VOICE-10 added: who is asking. ui/server.mjs hands its own subOf down; here it is a
    // header so one edge can answer as two people.
    subOf: (req) => String(req.headers["x-gate-sub"] ?? ""),
  });
}

test("VOICE-10: the route answers this caller's own talk mode and writes only theirs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-talkmode-"));
  try {
    await writeVoiceSettings({ enabled: true, vendor: "xai", apiKey: PLANTED_KEY }, { file: path.join(dir, "voice.json") });
    const edge = settingsEdge({ dir, operator: false });

    const cold = fakeExchange({ sub: "person-a" });
    await edge.handleSettings(cold.req, cold.res);
    assert.equal(cold.out.status, 200);
    assert.equal(cold.json().talkMode, undefined, "a person who has never chosen is handed a default");

    const wrote = fakeExchange({ method: "POST", body: { talkMode: "always" }, sub: "person-a" });
    await edge.handleSettings(wrote.req, wrote.res);
    assert.equal(wrote.out.status, 200, wrote.out.text.slice(0, 140));
    assert.equal(wrote.json().talkMode, "always");
    // NOT THE OPERATOR'S, and no key anywhere in the answer: the customer wrote the one field that is
    // theirs, on a workspace whose file holds a key, and it came back as a boolean the way it always did.
    assert.equal(wrote.json().apiKey, undefined);
    assert.equal(wrote.json().apiKeySet, true);
    assert.ok(!wrote.out.text.includes(PLANTED_KEY));

    const other = fakeExchange({ sub: "person-b" });
    await edge.handleSettings(other.req, other.res);
    assert.equal(other.json().talkMode, undefined, "one person's choice is on another person's screen");

    const again = fakeExchange({ sub: "person-a" });
    await edge.handleSettings(again.req, again.res);
    assert.equal(again.json().talkMode, "always", "it did not survive the write");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("VOICE-8: the four the operator sets are refused from a customer's workspace, in words", async () => {
  // WHY THIS IS NOT ONLY A CLIENT-SIDE GATE. The four rows are on the Operator section, which a customer
  // never sees -- and until this shipped the route took all four from any signed-in session, so a
  // customer with a browser console could point their own workspace's voice at a model the operator did
  // not choose and have it billed to his key. A client-side gate is not a gate, which is the same thing
  // KEYS-1 concluded about the key field itself.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-operator-"));
  try {
    await writeVoiceSettings({ enabled: false, vendor: "xai", model: "chosen-by-the-operator", agentId: "a1" },
      { file: path.join(dir, "voice.json") });
    const customer = settingsEdge({ dir, operator: false });

    for (const patch of [{ vendor: "openai" }, { model: "something-else" }, { voice: "another" }, { agentId: "a2" },
      { vendor: "openai", model: "x" }]) {
      const asked = fakeExchange({ method: "POST", body: patch, sub: "person-a" });
      await customer.handleSettings(asked.req, asked.res);
      assert.equal(asked.out.status, 400, `${JSON.stringify(patch)} was taken from a customer`);
      assert.equal(asked.json().error, "not_yours");
      // REFUSED AND NOT SILENTLY DROPPED. A 200 that quietly ignores a field the caller sent is the
      // failure where the caller believes it worked, and the sentence has to be readable by a person.
      assert.match(asked.json().message, /set by your operator/);
      assert.deepEqual(asked.json().fields, Object.keys(patch));
    }
    // AND NOTHING WAS WRITTEN, which is the half that shows the refusal is a refusal.
    const after = await readVoiceSettings(path.join(dir, "voice.json"));
    assert.equal(after.vendor, "xai");
    assert.equal(after.model, "chosen-by-the-operator");
    assert.equal(after.agentId, "a1");

    // The two fields that really are the workspace's and the person's own stay open to a customer.
    for (const patch of [{ enabled: true }, { talkMode: "always" }]) {
      const asked = fakeExchange({ method: "POST", body: patch, sub: "person-a" });
      await customer.handleSettings(asked.req, asked.res);
      assert.equal(asked.out.status, 200, `${JSON.stringify(patch)} was refused from the workspace it belongs to`);
    }

    // And the operator's own workspace writes all four, which is what the rows on his section do.
    const operator = settingsEdge({ dir, operator: true });
    const his = fakeExchange({ method: "POST", body: { vendor: "openai", model: "m", voice: "v", agentId: "a2" }, sub: "" });
    await operator.handleSettings(his.req, his.res);
    assert.equal(his.out.status, 200, his.out.text.slice(0, 140));
    assert.equal(his.json().vendor, "openai");
    assert.equal(his.json().model, "m");
    assert.equal(his.json().voice, "v");
    assert.equal(his.json().agentId, "a2");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the harness: a real browser socket, a real stub, and a dial we can freeze -------------------
//
// Duplicated from tests/voice-turn.test.mjs on purpose. This wave owns exactly one test helper
// (tests/helpers/stub-realtime.mjs, which item C's gate imports) and adding a second shared file
// would put a file in two waves' hands for the sake of thirty lines.

async function openSocket({ dir, settings, stub = null, gateway = null, WebSocketImpl = null, origin = null, relay = {}, capTickMs = undefined, dialWatchdogMs = undefined, secrets = null }) {
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
    // KEYS-1. The operator's own keys, when a test is measuring which one dials. Null -- the default
    // and every other test in this file -- is a console with no control plane, which is exactly what
    // this edge did before the door existed.
    ...(secrets == null ? {} : { secrets }),
    ...(capTickMs == null ? {} : { capTickMs }),
    ...(dialWatchdogMs == null ? {} : { dialWatchdogMs }),
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
  /** A second press on the same relay, so "one call at a time" can be measured rather than reasoned about. */
  const again = async () => {
    const second = new WebSocketClient(`ws://127.0.0.1:${port}/voice/socket`);
    const seen = { json: [], closed: null };
    second.on("message", (data, isBinary) => {
      if (isBinary) return;
      try { seen.json.push(JSON.parse(String(data))); } catch { /* not JSON */ }
    });
    second.on("close", (code, reason) => { seen.closed = { code, reason: String(reason) }; });
    await new Promise((resolve, reject) => {
      second.on("open", resolve);
      second.on("error", reject);
      const timer = setTimeout(() => reject(new Error("the second socket never opened")), 6000);
      timer.unref();
    });
    return { socket: second, seen };
  };
  return {
    client, frames, edge, settle, closed, logLines, again, ledgerFile: t.voiceLedgerFile,
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
    // KEYS-1 rewrote this one, and it is Jason's own wording. A customer cannot act on a key any
    // more -- it is the operator's, pasted once at the super admin console -- so the sentence names
    // no key and no card, and it no longer ends "press the button again", which is the clause that
    // instructed the loop he got stuck in on 2026-09-10.
    [{ enabled: true, vendor: "xai", apiKey: "" }, /^Voice is not switched on for this workspace yet\.$/],
    [{ enabled: false, vendor: "xai", apiKey: PLANTED_KEY }, /switched off/],
  ]) {
    const dir = mkdtempSync(path.join(tmpdir(), "voice-refuse-"));
    let session = null;
    try {
      session = await openSocket({ dir, settings });
      await session.settle(() => session.of("note").length > 0, `the refusal for ${JSON.stringify(settings)}`);
      assert.match(session.of("note")[0].text, pattern);
      // And no sentence a customer reads may name a key or a card they cannot open.
      for (const banned of [/\bkey\b/i, /Voice card/i, /\bsecret\b/i, /\btoken\b/i]) {
        assert.doesNotMatch(session.of("note")[0].text, banned, session.of("note")[0].text);
      }
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

// KEYS-1 adds a fifth surface, and it is the one this wave created: the key that dialled came from
// the control plane rather than from a file, so the reader that fetched it and every line it logged
// are now part of the same sweep. Neither was covered before, because /v1/relay/* was not a thing
// this suite had ever touched.
test("a key that came from the control plane is in no ledger line, no log line and no frame either", async () => {
  const CP_KEY = `cp-planted-key-${"k".repeat(24)}`;
  const dir = mkdtempSync(path.join(tmpdir(), "voice-cp-sweep-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  let session = null;
  const readerLines = [];
  try {
    session = await openSocket({
      dir, stub,
      // NOTHING on the file. This is a customer as they will be after this wave: no key of their own
      // anywhere, and the product still talks.
      settings: { enabled: true, vendor: "xai", apiKey: "" },
      secrets: {
        configured: true,
        current: () => ({ "keys.voice.xai": CP_KEY }),
        refresh: async () => ({ "keys.voice.xai": CP_KEY }),
        value: async (name) => {
          readerLines.push(`asked for ${name}`);
          return name === "keys.voice.xai" ? CP_KEY : "";
        },
        start: () => () => {},
      },
    });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update");
    session.client.close(1000, "done");
    await session.settle(() => (session.ledger().match(/"state":"closed"/g) ?? []).length > 0, "the settled row");

    // It really did dial with it, as a header and never in the URL.
    assert.equal(stub.events.requests[0].auth, `Bearer ${CP_KEY}`);
    assert.ok(!stub.events.requests[0].url.includes(CP_KEY), "the key is in a URL");
    // And it is nowhere it could be read back.
    const head = CP_KEY.slice(0, 10);
    for (const [what, text] of [
      ["the minutes ledger", session.ledger()],
      ["a relay log line", session.logLines.join("\n")],
      ["a frame the browser was sent", JSON.stringify(session.frames.json)],
      ["the reader's own trace", readerLines.join("\n")],
      // And it did NOT get written down beside the workspace's own settings, which is the whole of
      // "memory only": a customer's voice.json must be exactly as empty as it was.
      ["the workspace's own settings file", readFileSync(path.join(dir, "voice.json"), "utf8")],
    ]) {
      assert.ok(!text.includes(CP_KEY), `the key is in ${what}`);
      assert.ok(!text.includes(head), `a prefix of the key is in ${what}`);
    }
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- KEYS-1: which key dials ---------------------------------------------------------------------
//
// The operator's own key at the control plane first, this workspace's own file second, nothing third.
// There is no code anywhere that pushes a file value UP: that would be a new write path for a secret
// and would undo write-only-from-the-console. The fallback IS the migration, which is what these
// three assertions are really pinning.

/** A stand-in for ui/relay-secrets.mjs, answering whatever this arm says the operator has pasted. */
const secretsHolding = (keys) => ({
  configured: true,
  current: () => keys,
  refresh: async () => keys,
  value: async (name) => String(keys[String(name)] ?? ""),
  start: () => () => {},
});

test("the operator's key beats the workspace's file, and the file beats nothing", async () => {
  const OPERATOR_KEY = `operator-key-${"o".repeat(20)}`;
  for (const arm of [
    { what: "the operator's key wins over a file that has one", file: PLANTED_KEY, cp: OPERATOR_KEY, wire: OPERATOR_KEY },
    { what: "and it works with no file key at all, which is every customer", file: "", cp: OPERATOR_KEY, wire: OPERATOR_KEY },
    { what: "and the file is what dials when the control plane holds nothing", file: PLANTED_KEY, cp: "", wire: PLANTED_KEY },
  ]) {
    const dir = mkdtempSync(path.join(tmpdir(), "voice-prefer-"));
    const stub = await startStubRealtime({ vendor: "xai" });
    let session = null;
    try {
      session = await openSocket({
        dir, stub,
        settings: { enabled: true, vendor: "xai", apiKey: arm.file },
        secrets: secretsHolding(arm.cp.length > 0 ? { "keys.voice.xai": arm.cp } : {}),
      });
      await session.settle(() => stub.events.requests.length > 0, `the dial for ${arm.what}`);
      assert.equal(stub.events.requests[0].auth, `Bearer ${arm.wire}`, arm.what);
      // Whatever dialled, the file is not rewritten and the other value is nowhere on the wire.
      const other = arm.wire === OPERATOR_KEY ? PLANTED_KEY : OPERATOR_KEY;
      assert.ok(!JSON.stringify(stub.events.requests).includes(other), `${arm.what}: the other key reached the vendor`);
    } finally {
      await session?.close();
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a relay that cannot read the keys the product uses says try again, not you have no key", async () => {
  // The two conditions arrive at this branch as the same empty string. "Voice is not switched on for
  // this workspace yet" sends the OPERATOR to paste a key; if he already pasted one and this relay
  // simply cannot reach the control plane for a minute, that sends him to do a thing he has done
  // already, over a fault that clears itself. So a blind reader says busy, which is true.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-blind-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  let session = null;
  try {
    session = await openSocket({
      dir, stub,
      settings: { enabled: true, vendor: "xai", apiKey: "" },
      secrets: { ...secretsHolding({}), blind: true },
    });
    await session.settle(() => session.of("note").length > 0, "the refusal");
    const said = session.of("note")[0].text;
    assert.match(said, /^I could not start a voice session just now\. Try again in a moment\.$/);
    assert.equal(/switched on|key|operator/i.test(said), false, said);
    assert.equal(stub.events.requests.length, 0, "nothing was dialled");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reader that is NOT blind still gets the plain no-key sentence, which is every single-box install", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-notblind-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  let session = null;
  try {
    session = await openSocket({
      dir, stub,
      settings: { enabled: true, vendor: "xai", apiKey: "" },
      secrets: secretsHolding({}),
    });
    await session.settle(() => session.of("note").length > 0, "the refusal");
    assert.match(session.of("note")[0].text, /^Voice is not switched on for this workspace yet\.$/);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a workspace set to a service the operator has no key for is refused in words, never dialled with the other one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-wrong-service-"));
  const stub = await startStubRealtime({ vendor: "openai" });
  let session = null;
  try {
    // The workspace's own choice is the second service; the operator has pasted only the first.
    // Handing over the xAI key here would be a 401 the person reads as a broken product.
    session = await openSocket({
      dir, stub,
      settings: { enabled: true, vendor: "openai", apiKey: "" },
      secrets: secretsHolding({ "keys.voice.xai": `only-the-other-one-${"x".repeat(16)}` }),
    });
    await session.settle(() => session.of("note").length > 0, "the refusal");
    assert.match(session.of("note")[0].text, /^Voice is not switched on for this workspace yet\.$/);
    assert.equal(stub.events.requests.length, 0, "the vendor was dialled with somebody else's key");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- a vendor that will not take the call --------------------------------------------------------

/** A dial that fires `error` and never `close`, which is what node really does on a failed upgrade. */
class ErroringDial {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.listeners = new Map();
    // Measured on this Mac (node v22.23.1): a 401 upgrade and a refused connection both arrive as
    // ONE error event carrying "Received network error or non-101 status code", and no close event
    // of any kind ever follows.
    setTimeout(() => {
      for (const fn of this.listeners.get("error") ?? []) fn({ message: "Received network error or non-101 status code." });
    }, 10).unref?.();
  }
  addEventListener(kind, fn) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, []);
    this.listeners.get(kind).push(fn);
  }
  send() { /* never open */ }
  close() { this.readyState = 3; }
}

/** A dial that says NOTHING at all, which is what a black-holed address does. Only the watchdog sees it. */
class SilentDial {
  constructor(url) { this.url = String(url); this.readyState = 0; }
  addEventListener() {}
  send() { /* never open */ }
  close() { this.readyState = 3; }
}

test("a vendor that refuses the dial is one plain sentence, a clean close and a settled row", async () => {
  // THE ONE PATH A CUSTOMER WITH A TYPO'D KEY ACTUALLY HITS. The provider error listener was log-only
  // and node fires no close on a failed upgrade, so MEASURED on this Mac before this fix: no sentence
  // at all, the browser socket still open after 15 s, the ledger row still open and the orb still
  // listening -- with a live microphone -- until the thirty minute session cap.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-refused-"));
  let session = null;
  try {
    session = await openSocket({ dir, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY }, WebSocketImpl: ErroringDial });
    const closed = await session.closed;
    assert.equal(closed.code, 1000, "closed cleanly, because a destroyed socket reads as the relay being down");
    const note = session.of("note")[0];
    assert.ok(note != null, `no sentence reached the page: ${JSON.stringify(session.frames.json)}`);
    // KEYS-1 merged the refused and silent sentences: this edge genuinely cannot tell a 401 on the
    // upgrade from a vendor with nothing listening -- both are one error event with no code -- and
    // under KEYS-1 there is nothing a customer can do about either cause, because the key and the
    // vendor are both the operator's. So the sentence names the fact and who can see the reason.
    assert.match(note.text, /^Talking is not working right now\. Your operator can see why\.$/);
    assert.equal(/key|vendor|xai|openai|websocket/i.test(note.text), false, note.text);
    assert.equal(note.reason, "no-key", "so the row still draws the control that opens the Voice card");
    assert.deepEqual(session.of("state").map((one) => one.value).slice(-1), ["off"], "and the orb stops saying it is listening");
    // The settle is a file write and the close frame does not wait for it, so this waits for the row.
    await session.settle(() => (session.ledger().match(/"state":"closed"/g) ?? []).length > 0, "the settled row");
    const rows = await readVoiceLedger(session.ledgerFile);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "closed", "the row is settled rather than left open and counting");
    assert.equal(rows[0].closeReason, "the voice line never opened");
    assert.ok(!session.ledger().includes(PLANTED_KEY));
  } finally {
    await session?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dial that says nothing at all is caught by the watchdog, not by the session cap", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-silent-"));
  let session = null;
  try {
    session = await openSocket({
      dir, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY },
      WebSocketImpl: SilentDial, dialWatchdogMs: 150,
    });
    const closed = await session.closed;
    assert.equal(closed.code, 1000);
    assert.match(session.of("note")[0]?.text ?? "", /^Talking is not working right now\. Your operator can see why\.$/);
    await session.settle(() => (session.ledger().match(/"state":"closed"/g) ?? []).length > 0, "the settled row");
    const rows = await readVoiceLedger(session.ledgerFile);
    assert.equal(rows[0].state, "closed");
    assert.equal(rows[0].closeReason, "the voice line never opened");
  } finally {
    await session?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- one call at a time, and the audio a page may push -------------------------------------------

test("a second press while a call is live is refused in words, and the set forgets a finished call", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-onecall-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  let session = null;
  try {
    session = await openSocket({ dir, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY }, stub });
    await session.settle(() => session.of("ready").length === 1, "the first call");
    assert.equal(session.edge.sessions.length, 1);

    const second = await session.again();
    await session.settle(() => second.seen.json.some((one) => one.t === "note"), "the second press being answered");
    const note = second.seen.json.find((one) => one.t === "note");
    assert.match(note.text, /already in a call/i);
    assert.equal(second.seen.json.some((one) => one.t === "ready"), false, "and no second session was opened");
    // ONE ROW, not two: a refused press must not spend anything either.
    assert.equal((await readVoiceLedger(session.ledgerFile)).length, 1);

    // And when the first call ends the set forgets it, so the next press gets in. The set was
    // append-only until 2026-09-10 and held every finished session for the life of the process.
    session.client.close(1000, "done");
    await session.settle(() => session.edge.sessions.length === 0, "the finished session being released");
    const third = await session.again();
    await session.settle(() => third.seen.json.some((one) => one.t === "ready" || one.t === "note"), "the third press");
    assert.ok(third.seen.json.some((one) => one.t === "ready"), `the next press was refused: ${JSON.stringify(third.seen.json)}`);
    try { third.socket.terminate(); } catch { /* gone */ }
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audio arriving faster than realtime is DROPPED and counted, because that is the meter a vendor bills", async () => {
  // MEASURED on this Mac before this: 3000 frames, 14,400,000 bytes -- five minutes of audio --
  // forwarded to the vendor in 0.15 s of wall clock, the settled row reading wallSeconds 0 and
  // audioInSeconds 300, and every cap on screen green. The caps count wall seconds; this is the
  // ceiling on the other meter.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-flood-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  let session = null;
  try {
    session = await openSocket({ dir, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY }, stub });
    await session.settle(() => stub.events.sessions.length > 0, "the session frame");
    const frames = 600; // a minute of audio, offered in a fraction of a second
    for (let i = 0; i < frames; i += 1) session.client.send(Buffer.alloc(FRAME_BYTES, 0x40));
    await session.settle(() => stub.events.appendFrames > 0, "the first frame through");
    // Settle: the pacer admits about three seconds of audio (the lead) and drops the rest.
    await new Promise((resolve) => { const timer = setTimeout(resolve, 400); timer.unref(); });
    assert.ok(stub.events.appendFrames < frames / 4,
      `${stub.events.appendFrames} of ${frames} frames reached the vendor, which is not a ceiling`);
    const admittedSeconds = stub.events.appendBytes / (AUDIO_RATE * 2);
    assert.ok(admittedSeconds <= 6, `${admittedSeconds} s of audio was admitted in under a second of wall clock`);
    session.client.close(1000, "done");
    await session.settle(() => (session.ledger().match(/"state":"closed"/g) ?? []).length > 0, "the settled row");
    const rows = await readVoiceLedger(session.ledgerFile);
    assert.ok(rows[0].heldFrames > frames / 2, `the dropped frames are counted: heldFrames=${rows[0].heldFrames}`);
    assert.ok(rows[0].audioInSeconds <= 6, `and the audio meter is bounded: ${rows[0].audioInSeconds} s`);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the day cap is re-read while a call runs, so a session cannot outlive a day spent elsewhere", async () => {
  // The day was a snapshot taken when the socket was accepted and never read again. Two sockets
  // opened together each got the whole remaining day; one call at a time closes most of that, and
  // this closes the rest -- a row spent by anything else on this workspace now ends the live call.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-dayreread-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  let session = null;
  try {
    session = await openSocket({
      dir, settings: { enabled: true, vendor: "xai", apiKey: PLANTED_KEY }, stub, capTickMs: 40,
    });
    await session.settle(() => session.of("ready").length === 1, "the call");
    // Somebody else's spend lands in the ledger while this call is running: the whole day, closed.
    await appendVoiceLedger(voiceLedgerRow({
      sessionId: "vs_elsewhere", slug: "acme", vendor: "xai", startedAt: new Date().toISOString(),
      state: "closed", endedAt: new Date().toISOString(), wallSeconds: DAY_CAP_SECONDS + 5,
    }), { file: session.ledgerFile });
    const closed = await session.closed;
    assert.equal(closed.code, 1000);
    const note = session.of("note").at(-1);
    assert.match(note?.text ?? "", /voice time for today/i);
    assert.equal(note?.reason, "day-cap");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
