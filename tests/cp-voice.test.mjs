// The minutes ledger and the caps behind spoken work, on the side that owns them
// (VOICE-1, docs/VOICE.md).
//
// The relay holds the microphone, the vendor socket and the workspace's key; this service holds the
// NUMBERS and the RECORD, and the split is the only reason there is a control-plane half at all. So
// the claims worth a test are the ones that split can get wrong:
//
//   the policy the relay dials against carries numbers and an allowlist and NO SECRET, and the relay's
//   own credential is the only thing that opens it;
//
//   the operator's read lives OUTSIDE /v1/admin, because cp/admin.mjs claims every /v1/admin/* path
//   and answers 404 to anything it does not match itself -- which is written out in cp/server.mjs as
//   the reason the mail send log lives at /v1/mail/sends. That file belongs to another wave this week
//   and this wave does not touch it;
//
//   NO CUSTOMER-REACHABLE ROUTE CAN RAISE A CAP. A cap a customer can raise is not a cap, and it
//   would be one fetch away if the minutes lived beside the key in their own state file;
//
//   wall seconds, audio seconds and billable text events are three different meters and the answer
//   SAYS WHICH each number is, because one "minutes" column reconciles against neither vendor's
//   invoice;
//
//   the day cap counts a session that is RUNNING RIGHT NOW at its current elapsed. Counting only
//   closed rows would read one session left open all afternoon as nought seconds used, and the cap
//   would never fire while the thing it caps was happening;
//
//   voice_sessions is made on a database that ALREADY HOLDS the other tables, because
//   CREATE TABLE IF NOT EXISTS does nothing whatever to a database it is not run against and the
//   R750's control plane database is live;
//
//   the Spend block says not-measured IN WORDS when nothing has ever reported, and never 0 minutes.
//   That rule is written at cp/admin/admin.js:1303 after a real screenshot bug;
//
//   and the two realtime rows on the Providers panel are INERT: providerList() offers no model from
//   them and no key pasted into one reaches LiteLLM. This is the prove-or-drop test the wave's design
//   asks for, and a leak means the rows are deleted rather than cp/admin.mjs patched.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../cp/store.mjs";
import {
  DAY_CAP_MINUTES,
  DAY_CAP_SETTING,
  REALTIME_VENDORS,
  REALTIME_VENDOR_DEFAULT,
  REALTIME_VENDOR_IDS,
  SESSION_CAP_MINUTES,
  VENDORS_SETTING,
  WIRE_FLAT,
  WIRE_TYPED,
  createVoiceLog,
  parseVendors,
  voiceSetting,
} from "../cp/voice.mjs";
import { PROVIDER_PRESETS, REALTIME_PRESET_IDS } from "../cp/proxy.mjs";
import { startControlPlane } from "./cp-support.mjs";
import { startFakeProxy } from "./cp-proxy-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const memory = () => openStore({ file: ":memory:" });
const RELAY_TOKEN = "r".repeat(40);

/** A clock the caps can be walked past without a test that sleeps. */
const clockFrom = (start) => { let at = start; return { now: () => at, advance(ms) { at += ms; } }; };
const NOON = Date.parse("2026-09-09T12:00:00.000Z");

// ---- the vendor table ----------------------------------------------------------------------------

test("the vendor table is the authority, and it records that the two wires are NOT the same", () => {
  // The brief's premise -- "since both providers speak the same wire, one bridge serves both" -- is
  // false as of 2026-09-09, and this is where the product records that rather than in a comment
  // somebody can walk past. xAI takes the flat session; OpenAI GA refuses that exact body.
  assert.equal(REALTIME_VENDORS.xai.wire, WIRE_FLAT);
  assert.equal(REALTIME_VENDORS.openai.wire, WIRE_TYPED);
  assert.notEqual(REALTIME_VENDORS.xai.wire, REALTIME_VENDORS.openai.wire,
    "a URL swap is not a provider swap, and the table has to say so");

  assert.equal(REALTIME_VENDOR_DEFAULT, "xai");
  assert.deepEqual(REALTIME_VENDOR_IDS, ["xai", "openai"]);

  // Every published price carries the date it was read and what kind of source it was. A price with
  // no date is a price that will be wrong and will still look authoritative.
  for (const id of REALTIME_VENDOR_IDS) {
    const row = REALTIME_VENDORS[id];
    assert.match(row.price.readAt, /^\d{4}-\d{2}-\d{2}$/, `${id} has no date on its price`);
    assert.equal(row.price.source, "vendor page");
    assert.equal(typeof row.url, "string");
    assert.match(row.url, /^wss:\/\//, `${id}'s realtime endpoint is a websocket`);
  }

  // The corrected xAI number, and the deprecated model the cheaper figure belongs to. $0.05 is what
  // gets quoted; it is not what the current model costs.
  assert.equal(REALTIME_VENDORS.xai.price.audioPerMinuteUsd, 0.08);
  assert.equal(REALTIME_VENDORS.xai.price.deprecated.audioPerMinuteUsd, 0.05);
  assert.equal(REALTIME_VENDORS.xai.price.deprecated.model, "grok-voice-think-fast-1.0");
  // The flat fee per billable text event, which is why a tool result goes back as
  // function_call_output and why the nudges are bounded.
  assert.equal(REALTIME_VENDORS.xai.price.perBilledItemEventUsd, 0.004);

  // OpenAI has no per-minute number on its own page, so there is none in the table: a per-minute band
  // for that vendor is third-party analysis and the doc marks it as that.
  assert.equal(REALTIME_VENDORS.openai.price.audioPerMinuteUsd, undefined);
  assert.equal(REALTIME_VENDORS.openai.price.audioOutPerMillionUsd, 64);
});

test("a vendor list that is a typo falls back, and the one word that means off is honoured", () => {
  assert.deepEqual(parseVendors(""), ["xai", "openai"], "nothing written means the default");
  assert.deepEqual(parseVendors("xai"), ["xai"]);
  assert.deepEqual(parseVendors("openai, xai"), ["openai", "xai"]);
  assert.deepEqual(parseVendors("none"), [], "one word switches voice off for a workspace");
  // A typo must never be the thing that changes what a customer can do. An empty allowlist from a
  // fat-fingered settings row reads to that customer as voice being broken with nothing anywhere to
  // say why, which is the same reasoning cp/mail.mjs capOf gives about a number.
  assert.deepEqual(parseVendors("xaii"), ["xai", "openai"], "an unknown id falls back rather than switching voice off");
  assert.deepEqual(parseVendors("anthropic,google"), ["xai", "openai"]);
});

// ---- the policy and the caps ----------------------------------------------------------------------

test("the policy carries numbers and an allowlist and nothing that is a secret", () => {
  const store = memory();
  try {
    const voice = createVoiceLog({ store, now: () => NOON });
    const policy = voice.policy("demo");
    assert.equal(policy.sessionMinutes, SESSION_CAP_MINUTES);
    assert.equal(policy.dayMinutes, DAY_CAP_MINUTES);
    assert.equal(policy.sessionCapSeconds, 30 * 60);
    assert.equal(policy.dayCapSeconds, 120 * 60);
    assert.equal(policy.dayUsedSeconds, 0);
    assert.equal(policy.dayRemainingSeconds, 120 * 60);
    assert.deepEqual(policy.vendors, ["xai", "openai"]);
    assert.equal(policy.defaultVendor, "xai");
    assert.equal(policy.day, "2026-09-09");
    assert.equal(policy.resetsAt, "2026-09-10T00:00:00.000Z");

    // Nothing in this answer is, or could become, a credential. The key never reaches this service in
    // either direction: it is written through the customer's own console into their own state file and
    // read off the relay's own disk when it dials.
    for (const field of ["apiKey", "key", "token", "url", "secret", "authorization"]) {
      assert.equal(Object.keys(policy).includes(field), false, `${field} has no business in a policy answer`);
    }
  } finally { store.close(); }
});

test("a per-workspace override beats the global one, and a typo in either falls back", () => {
  const store = memory();
  try {
    const voice = createVoiceLog({ store, now: () => NOON });
    store.setSetting(DAY_CAP_SETTING, "90", "a test");
    assert.equal(voice.policy("demo").dayMinutes, 90, "the global row applies to everybody");
    store.setSetting(voiceSetting(DAY_CAP_SETTING, "demo"), "10", "a test");
    assert.equal(voice.policy("demo").dayMinutes, 10, "the workspace's own row wins");
    assert.equal(voice.policy("other").dayMinutes, 90, "and belongs to that workspace alone");

    // A row that is not a positive number falls back rather than uncapping or zeroing anybody.
    store.setSetting(voiceSetting(DAY_CAP_SETTING, "demo"), "ten", "a test");
    assert.equal(voice.policy("demo").dayMinutes, 90);
    store.setSetting(voiceSetting(DAY_CAP_SETTING, "demo"), "0", "a test");
    assert.equal(voice.policy("demo").dayMinutes, 90, "nought is a typo and not a decision; --vendors none is the decision");
    store.setSetting(voiceSetting(DAY_CAP_SETTING, "demo"), "-5", "a test");
    assert.equal(voice.policy("demo").dayMinutes, 90);
  } finally { store.close(); }
});

test("the claim comes before the dial, and the row exists the moment the session is authorised", () => {
  const store = memory();
  try {
    const voice = createVoiceLog({ store, now: () => NOON });
    const claim = voice.openSession({ slug: "demo", sessionId: "v-1", agentId: "a_titan", vendor: "xai", model: "grok-voice-think-fast-2.0" });
    assert.equal(claim.ok, true);
    assert.equal(typeof claim.id, "number");
    assert.equal(claim.sessionCapSeconds, 30 * 60);

    const row = store.getVoiceSession("v-1");
    assert.equal(row.state, "open", "the row exists before the provider hears audio");
    assert.equal(row.tenant, "demo");
    assert.equal(row.agentId, "a_titan");
    assert.equal(row.wallSeconds, 0, "nothing is known about the length of a session that has not ended");
    assert.equal(row.endedAt, "");

    // No transcript, no audio, no key, nothing anybody said. The same rule the mail ledger lives by.
    for (const forbidden of ["transcript", "text", "audio", "apiKey", "key", "prompt", "reply"]) {
      assert.equal(Object.keys(row).includes(forbidden), false, `${forbidden} has no business in this table`);
    }
  } finally { store.close(); }
});

test("a retried claim for the same session gets the row it already has, keeping its original start", () => {
  const store = memory();
  const clock = clockFrom(NOON);
  try {
    const voice = createVoiceLog({ store, now: clock.now });
    const first = voice.openSession({ slug: "demo", sessionId: "v-1", vendor: "xai" });
    clock.advance(5 * 60_000);
    const again = voice.openSession({ slug: "demo", sessionId: "v-1", vendor: "xai" });
    assert.equal(again.ok, true);
    assert.equal(again.id, first.id, "one session is one row however many times the claim is retried");
    assert.equal(store.listVoiceSessions({ tenant: "demo" }).length, 1);
    // And the start did NOT move. A claim that reset started_at would hand the session its whole cap
    // again on every retry, which is a cap anybody can reset by making the network flap.
    assert.equal(store.getVoiceSession("v-1").startedAt, new Date(NOON).toISOString());
  } finally { store.close(); }
});

test("the day cap counts a session that is running right now at its current elapsed", () => {
  const store = memory();
  const clock = clockFrom(NOON);
  try {
    const voice = createVoiceLog({ store, now: clock.now });
    store.setSetting(voiceSetting(DAY_CAP_SETTING, "demo"), "30", "a test");

    voice.openSession({ slug: "demo", sessionId: "running", vendor: "xai" });
    // Twenty minutes into a session that nobody has closed.
    clock.advance(20 * 60_000);
    const mid = voice.policy("demo");
    assert.equal(mid.dayUsedSeconds, 20 * 60, "an open row counts, or one session left open reads as nought used");
    assert.equal(mid.dayRemainingSeconds, 10 * 60);
    assert.equal(mid.openSessions, 1);

    // Eleven more minutes and the day is gone, with nothing ever having been closed.
    clock.advance(11 * 60_000);
    const refused = voice.openSession({ slug: "demo", sessionId: "second", vendor: "xai" });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "day_cap");
    assert.match(refused.message, /used all the voice time it has for today/);
    assert.match(refused.message, /starts again in \d+ hours?/);
    // A refused claim writes NO row, so a workspace cannot be pushed further over its limit by being
    // refused. The same order cp/mail.mjs openSend keeps.
    assert.equal(store.getVoiceSession("second"), null);

    // And the sentence a person hears names no vendor, no model and no setting.
    for (const leak of ["xai", "openai", "grok", "realtime", "voice.dayMinutes", "titan("]) {
      assert.equal(refused.message.toLowerCase().includes(leak.toLowerCase()), false, `the refusal must not say ${leak}`);
    }
  } finally { store.close(); }
});

test("a closed session counts its reported wall clock, and the next UTC day starts clean", () => {
  const store = memory();
  const clock = clockFrom(NOON);
  try {
    const voice = createVoiceLog({ store, now: clock.now });
    voice.openSession({ slug: "demo", sessionId: "v-1", vendor: "xai" });
    clock.advance(9 * 60_000);
    const settled = voice.closeSession({
      sessionId: "v-1", wallSeconds: 540, audioInSeconds: 120, audioOutSeconds: 65,
      billedItemEvents: 3, toolCalls: 2, heldFrames: 41, closeReason: "the person toggled off",
    });
    assert.equal(settled.ok, true);
    assert.equal(store.listVoiceSessions({ tenant: "demo" }).length, 1, "settling updates the row rather than writing a second one");

    const row = store.getVoiceSession("v-1");
    assert.equal(row.state, "closed");
    assert.equal(row.wallSeconds, 540);
    assert.equal(row.audioInSeconds, 120);
    assert.equal(row.audioOutSeconds, 65);
    assert.equal(row.billedItemEvents, 3);
    assert.equal(row.toolCalls, 2);
    assert.equal(row.heldFrames, 41, "the echo gate's dropped-frame count is the only evidence it ran that outlives the session");
    assert.equal(row.closeReason, "the person toggled off");

    assert.equal(voice.policy("demo").dayUsedSeconds, 540);
    // Tomorrow is a different day's cap. The caps are a UTC day, which the doc says in those words.
    clock.advance(24 * 60 * 60_000);
    assert.equal(voice.policy("demo").dayUsedSeconds, 0);
    assert.equal(voice.policy("demo").day, "2026-09-10");
  } finally { store.close(); }
});

test("a session that straddles midnight counts against both days, for the part inside each", () => {
  // MEASURED on this Mac 2026-09-09 before the clip went in: a session started at 23:59:30 and still
  // running at 00:05 counted against NEITHER day. Today's sum only looked at rows dated today, and the
  // row's own date belongs to yesterday -- so a workspace could be talking, burning its minutes, and
  // counting against no day at all, up to a whole session cap's worth.
  const store = memory();
  const clock = clockFrom(Date.parse("2026-09-09T23:59:30.000Z"));
  try {
    const voice = createVoiceLog({ store, now: clock.now });
    voice.openSession({ slug: "demo", sessionId: "straddle", vendor: "xai" });
    assert.equal(voice.policy("demo").day, "2026-09-09");
    clock.advance(20_000); // 23:59:50, still the ninth
    assert.equal(voice.policy("demo").dayUsedSeconds, 20, "twenty seconds of it are spent on the ninth");
    clock.advance(10_000); // exactly midnight: the policy is now the tenth, and the tenth has had none
    assert.equal(voice.policy("demo").day, "2026-09-10");
    assert.equal(voice.policy("demo").dayUsedSeconds, 0, "the new day starts at nought, however long the session has run");

    clock.advance(5 * 60_000); // 00:05 the next day, still running
    const today = voice.policy("demo");
    assert.equal(today.day, "2026-09-10");
    assert.equal(today.dayUsedSeconds, 300, "and five minutes of it are spent today, not nought");
    assert.equal(today.openSessions, 1, "the session it belongs to is still open");

    // The day it started on keeps only its own part, so the same seconds are never counted twice.
    const asOfYesterday = createVoiceLog({ store, now: () => Date.parse("2026-09-09T23:59:45.000Z") });
    assert.equal(asOfYesterday.policy("demo").dayUsedSeconds, 15);
  } finally { store.close(); }
});

test("a replayed close leaves a settled row alone, so a number cannot change after the fact", () => {
  // The relay reports the close best effort and retries, so it arrives twice whenever the first
  // attempt times out after the write landed. MEASURED before this guard: a replay carrying 99999
  // seconds overwrote a settled 100 -- and the day cap is read out of these rows.
  const store = memory();
  try {
    const voice = createVoiceLog({ store, now: () => NOON });
    voice.openSession({ slug: "demo", sessionId: "replay", vendor: "xai" });
    voice.closeSession({ sessionId: "replay", wallSeconds: 100, toolCalls: 1 });
    const again = voice.closeSession({ sessionId: "replay", wallSeconds: 99999, toolCalls: 77 });
    assert.equal(again.ok, true, "a retry is not an error, or the relay would retry forever");
    assert.equal(again.alreadyClosed, true);
    assert.equal(store.getVoiceSession("replay").wallSeconds, 100, "and the settled number stands");
    assert.equal(store.getVoiceSession("replay").toolCalls, 1);
    assert.equal(store.listVoiceSessions({ tenant: "demo" }).length, 1);
  } finally { store.close(); }
});

test("a settle for a session nobody claimed is refused rather than invented", () => {
  const store = memory();
  try {
    const voice = createVoiceLog({ store, now: () => NOON });
    const answer = voice.closeSession({ sessionId: "never-claimed", wallSeconds: 600 });
    assert.equal(answer.ok, false);
    assert.equal(answer.error, "not_found");
    // Writing the row here would hide the exact case the claim-first rule exists to expose: a claim
    // that was lost. A close with no claim means the minutes were spent off the books.
    assert.equal(store.countVoiceSessions(), 0);
  } finally { store.close(); }
});

test("one word switches voice off for a workspace, and the refusal says nothing about a provider", () => {
  const store = memory();
  try {
    const voice = createVoiceLog({ store, now: () => NOON });
    store.setSetting(voiceSetting(VENDORS_SETTING, "demo"), "none", "a test");
    assert.deepEqual(voice.policy("demo").vendors, []);
    assert.equal(voice.policy("demo").defaultVendor, "");
    const off = voice.openSession({ slug: "demo", sessionId: "v-1", vendor: "xai" });
    assert.equal(off.ok, false);
    assert.equal(off.error, "voice_off");
    assert.equal(off.message, "Voice is not switched on for this workspace yet.");

    // And a vendor outside this workspace's allowlist reads the same, because a person at a microphone
    // has no way to act on a vendor id and the console never shows one.
    store.setSetting(voiceSetting(VENDORS_SETTING, "demo"), "openai", "a test");
    const wrong = voice.openSession({ slug: "demo", sessionId: "v-2", vendor: "xai" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "vendor_not_allowed");
    assert.equal(wrong.message, "Voice is not switched on for this workspace yet.");
    assert.equal(store.countVoiceSessions(), 0);
  } finally { store.close(); }
});

// ---- the operator's read ---------------------------------------------------------------------------

test("the usage answer keeps the three meters apart and names which each number is", () => {
  const store = memory();
  const clock = clockFrom(NOON);
  try {
    const voice = createVoiceLog({ store, now: clock.now });
    voice.openSession({ slug: "demo", sessionId: "v-1", agentId: "a_titan", vendor: "xai", model: "grok-voice-think-fast-2.0" });
    clock.advance(60_000);
    voice.closeSession({ sessionId: "v-1", wallSeconds: 60, audioInSeconds: 18, audioOutSeconds: 22, billedItemEvents: 4, toolCalls: 1, heldFrames: 7 });
    voice.openSession({ slug: "demo", sessionId: "v-2", agentId: "a_titan", vendor: "xai" });
    clock.advance(30_000);
    voice.closeSession({ sessionId: "v-2", wallSeconds: 30, audioInSeconds: 5, audioOutSeconds: 9, billedItemEvents: 1, toolCalls: 0, heldFrames: 3 });
    voice.openSession({ slug: "titanium", sessionId: "v-3", vendor: "openai", model: "gpt-realtime-2.1" });
    clock.advance(10_000);
    voice.closeSession({ sessionId: "v-3", wallSeconds: 10, audioInSeconds: 2, audioOutSeconds: 3, billedItemEvents: 0, toolCalls: 0, heldFrames: 0 });

    const answer = voice.usage({});
    assert.equal(answer.everMeasured, true);
    assert.equal(answer.tenants.length, 2);
    const demo = answer.tenants.find((one) => one.slug === "demo");
    assert.equal(demo.sessions, 2);
    assert.equal(demo.wallSeconds, 90);
    assert.equal(demo.audioInSeconds, 23);
    assert.equal(demo.audioOutSeconds, 31);
    assert.equal(demo.billedItemEvents, 5);
    assert.equal(demo.toolCalls, 1);
    assert.equal(demo.heldFrames, 10);

    // THREE METERS, NOT ONE. One "minutes" column reconciles against neither vendor's invoice: one
    // bills audio sent-or-received plus a flat fee per billable text event, the other bills audio
    // tokens with the whole prefix re-read every turn.
    assert.notEqual(demo.wallSeconds, demo.audioInSeconds + demo.audioOutSeconds);
    assert.match(answer.meters.wall, /wall clock/);
    assert.match(answer.meters.wall, /caps count/);
    assert.match(answer.meters.audio, /invoice/);
    assert.match(answer.meters.events, /flat fee/);

    // And one workspace never reads another's.
    assert.equal(voice.usage({ slug: "demo" }).tenants.length, 1);
    assert.equal(voice.usage({ slug: "titanium" }).tenants[0].slug, "titanium");
    assert.equal(voice.usage({ slug: "nobody" }).tenants.length, 0);
    // A named workspace also gets its policy, the way /v1/mail/sends carries its caps.
    assert.equal(voice.usage({ slug: "demo" }).policy.dayMinutes, DAY_CAP_MINUTES);
  } finally { store.close(); }
});

test("nothing ever reported reads as not measured in words, and never as nought", () => {
  const store = memory();
  try {
    const voice = createVoiceLog({ store, now: () => NOON });
    const answer = voice.usage({});
    // The flag the Spend block draws its sentence from. A zero from a meter nobody has ever reported
    // is not a zero: that rule is written at cp/admin/admin.js over the Spend table after a real
    // screenshot bug where $0.00 sat an inch from a note saying nothing was measured.
    assert.equal(answer.everMeasured, false);
    assert.deepEqual(answer.tenants, []);
    assert.match(answer.why, /no voice session has been reported/);
  } finally { store.close(); }
});

test("a window is a UTC day or the month, matched on the row's own start", () => {
  const store = memory();
  const clock = clockFrom(Date.parse("2026-08-31T23:50:00.000Z"));
  try {
    const voice = createVoiceLog({ store, now: clock.now });
    voice.openSession({ slug: "demo", sessionId: "august", vendor: "xai" });
    voice.closeSession({ sessionId: "august", wallSeconds: 600 });
    clock.advance(20 * 60_000); // over midnight, and over the month boundary
    voice.openSession({ slug: "demo", sessionId: "september", vendor: "xai" });
    voice.closeSession({ sessionId: "september", wallSeconds: 300 });

    assert.equal(voice.usage({}).tenants[0].wallSeconds, 300, "the default window is this UTC month");
    assert.equal(voice.usage({ day: "2026-08-31" }).tenants[0].wallSeconds, 600);
    assert.equal(voice.usage({ day: "2026-09-01" }).tenants[0].wallSeconds, 300);
    assert.equal(voice.usage({ day: "2026-09-02" }).tenants.length, 0);
    assert.equal(voice.usage({ day: "2026-09-02" }).everMeasured, true,
      "a window with no rows in it is not the same fact as a meter nobody ever reported");
  } finally { store.close(); }
});

// ---- the doors -------------------------------------------------------------------------------------

test("the policy route answers the relay and nobody else, and carries no secret", async () => {
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: RELAY_TOKEN } });
  try {
    const withRelay = (method, pathname, body) => cp.request(method, pathname, { body, token: RELAY_TOKEN });

    // The method refusal comes FIRST, so a wrong method charges nobody and learns nothing: the same
    // order the mail send pair keeps. A POST is refused before the credential is even looked at.
    assert.equal((await cp.request("POST", "/v1/relay/voice/policy?slug=demo")).status, 405);

    assert.equal((await cp.request("GET", "/v1/relay/voice/policy?slug=demo")).status, 401, "no bearer");
    assert.equal((await cp.admin("GET", "/v1/relay/voice/policy?slug=demo")).status, 401,
      "the admin token does not open the relay's door, the same two-door rule the registry keeps");

    const answer = await withRelay("GET", "/v1/relay/voice/policy?slug=demo");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.dayMinutes, DAY_CAP_MINUTES);
    assert.equal(answer.body.sessionMinutes, SESSION_CAP_MINUTES);
    assert.deepEqual(answer.body.vendors, ["xai", "openai"]);
    // The whole body, swept. Nothing shaped like a credential, and no vendor URL either: the relay
    // knows where the vendors are, and an address in an answer is one more thing to keep in step.
    assert.equal(/sk-|Bearer |xai-|authorization/i.test(answer.text), false, `nothing credential-shaped: ${answer.text.slice(0, 200)}`);
    assert.equal(answer.text.includes("wss://"), false, "the policy is numbers, not an address");

    assert.equal((await withRelay("GET", "/v1/relay/voice/policy")).status, 400, "it names the workspace or it answers nothing");
  } finally { await cp.dispose(); }
});

test("the claim and the settle are two routes, and a cap refusal arrives as the relay can pass it on", async () => {
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: RELAY_TOKEN } });
  try {
    const relay = (method, pathname, body) => cp.request(method, pathname, { body, token: RELAY_TOKEN });

    assert.equal((await cp.request("GET", "/v1/relay/voice/usage/open")).status, 405);
    assert.equal((await cp.request("POST", "/v1/relay/voice/usage/open", { body: { slug: "demo", sessionId: "v-1" } })).status, 401);
    assert.equal((await cp.admin("POST", "/v1/relay/voice/usage/open", { slug: "demo", sessionId: "v-1" })).status, 401);

    const claim = await relay("POST", "/v1/relay/voice/usage/open", { slug: "demo", sessionId: "v-1", agentId: "a_titan", vendor: "xai" });
    assert.equal(claim.status, 200);
    assert.equal(claim.body.ok, true);
    assert.equal(cp.store.getVoiceSession("v-1").state, "open");

    const settle = await relay("POST", "/v1/relay/voice/usage/close", {
      sessionId: "v-1", wallSeconds: 77, audioInSeconds: 20, audioOutSeconds: 25, billedItemEvents: 2, toolCalls: 1, heldFrames: 12,
    });
    assert.equal(settle.status, 200);
    assert.equal(cp.store.getVoiceSession("v-1").wallSeconds, 77);

    // A settle nobody claimed is a 404 and not a new row.
    assert.equal((await relay("POST", "/v1/relay/voice/usage/close", { sessionId: "ghost" })).status, 404);

    // 429 on a cap, so the relay passes the sentence on word for word rather than inventing one.
    cp.store.setSetting(voiceSetting(DAY_CAP_SETTING, "demo"), "1", "a test");
    const capped = await relay("POST", "/v1/relay/voice/usage/open", { slug: "demo", sessionId: "v-2", vendor: "xai" });
    assert.equal(capped.status, 429);
    assert.match(capped.body.message, /used all the voice time it has for today/);

    // 403 and the same plain sentence when voice is off for that workspace.
    cp.store.setSetting(voiceSetting(VENDORS_SETTING, "other"), "none", "a test");
    const off = await relay("POST", "/v1/relay/voice/usage/open", { slug: "other", sessionId: "v-3", vendor: "xai" });
    assert.equal(off.status, 403);
    assert.equal(off.body.message, "Voice is not switched on for this workspace yet.");

    assert.equal((await relay("POST", "/v1/relay/voice/usage/open", { sessionId: "v-4" })).status, 400);
  } finally { await cp.dispose(); }
});

test("the operator's read lives outside /v1/admin, so cp/admin.mjs stays untouched by this wave", async () => {
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: RELAY_TOKEN } });
  try {
    // THE STRUCTURAL REASON, measured rather than asserted from the comment: cp/admin.mjs claims
    // every /v1/admin/* path and answers 404 to anything it does not match itself. A voice route under
    // that prefix would have to be added inside that file, and that file belongs to another wave.
    const underAdmin = await cp.admin("GET", "/v1/admin/voice/usage");
    assert.equal(underAdmin.status, 404, "this is why the read is at /v1/voice/usage instead");

    assert.equal((await cp.request("POST", "/v1/voice/usage")).status, 405);
    assert.equal((await cp.request("GET", "/v1/voice/usage")).status, 401, "no bearer");
    assert.equal((await cp.request("GET", "/v1/voice/usage", { token: RELAY_TOKEN })).status, 401,
      "the relay's credential reads numbers and does not read the operator's ledger");

    const answer = await cp.admin("GET", "/v1/voice/usage");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.everMeasured, false);
    assert.match(answer.body.why, /no voice session has been reported/);

    assert.equal((await cp.admin("GET", "/v1/voice/usage?day=yesterday")).status, 400, "a day is YYYY-MM-DD in UTC");

    // And it is a real read of real rows once the relay has reported some.
    await cp.request("POST", "/v1/relay/voice/usage/open", { body: { slug: "demo", sessionId: "v-1", vendor: "xai" }, token: RELAY_TOKEN });
    await cp.request("POST", "/v1/relay/voice/usage/close", { body: { sessionId: "v-1", wallSeconds: 42, audioInSeconds: 10, audioOutSeconds: 11, billedItemEvents: 2, toolCalls: 1 }, token: RELAY_TOKEN });
    const filled = await cp.admin("GET", "/v1/voice/usage");
    assert.equal(filled.body.everMeasured, true);
    assert.equal(filled.body.tenants[0].slug, "demo");
    assert.equal(filled.body.tenants[0].wallSeconds, 42);
    assert.equal(filled.body.tenants[0].toolCalls, 1);
  } finally { await cp.dispose(); }
});

test("no customer-reachable route can raise a cap", async () => {
  const cp = await startControlPlane({ env: { CP_RELAY_TOKEN: RELAY_TOKEN } });
  try {
    cp.store.createTenant({ slug: "demo", name: "Demo" });
    const made = await cp.admin("POST", "/v1/accounts", { email: "jane@demo.example", password: "a-long-enough-password-1", tenant: "demo" });
    assert.equal(made.status, 201, made.text);
    const signedIn = await cp.request("POST", "/v1/sessions", { body: { email: "jane@demo.example", password: "a-long-enough-password-1" } });
    assert.equal(signedIn.status, 200, signedIn.text);
    const customer = String(signedIn.body.token);

    // THE WHOLE POINT OF THE NUMBERS LIVING HERE. A cap a customer can raise is not a cap, and it
    // would be one fetch away if the minutes lived in their own state file beside the key they DO
    // write. Their own console writes the key and nothing else.
    for (const token of [customer, RELAY_TOKEN, ""]) {
      const tried = await cp.request("POST", "/v1/voice/caps", { body: { slug: "demo", dayMinutes: 100000 }, token: token || undefined });
      assert.equal(tried.status, 401, `a cap must not be writable with ${token === customer ? "a customer session" : token ? "the relay token" : "no credential"}`);
    }
    // And nothing was written by any of those.
    assert.equal(cp.store.getSetting(voiceSetting(DAY_CAP_SETTING, "demo"), ""), "");

    // The operator can, and the answer hands back the policy that is now in force.
    assert.equal((await cp.request("GET", "/v1/voice/caps", { token: cp.config.adminToken })).status, 405);
    const set = await cp.admin("POST", "/v1/voice/caps", { slug: "demo", dayMinutes: 45, sessionMinutes: 10, vendors: "xai" });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.policy.dayMinutes, 45);
    assert.equal(set.body.policy.sessionMinutes, 10);
    assert.deepEqual(set.body.policy.vendors, ["xai"]);

    // A vendor this product has never heard of is refused rather than written, because a settings row
    // nobody can act on is a workspace whose voice is quietly off.
    const bad = await cp.admin("POST", "/v1/voice/caps", { slug: "demo", vendors: "anthropic" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /knows xai and openai/);
    assert.deepEqual((await cp.admin("GET", "/v1/voice/usage?slug=demo")).body.policy.vendors, ["xai"], "and the old value stands");

    assert.equal((await cp.admin("POST", "/v1/voice/caps", { slug: "demo" })).status, 400, "a write that names nothing changes nothing");
    assert.equal((await cp.admin("POST", "/v1/voice/caps", { slug: "demo", dayMinutes: 0 })).status, 400);
  } finally { await cp.dispose(); }
});

test("the CLI's four new flags take values, so a value is never read as the workspace", async () => {
  // The first cut of these verbs left them out of the CLI's valued-flag set, so
  // `voice usage --day 2026-09-09` read that date as the WORKSPACE as well as the day, and the gate
  // leg that covered it passed for the wrong reason: both readings answer "nothing". The set is
  // asserted from the source, because it is the only place that decides this.
  const source = await readFile(path.join(repoRoot, "cp/cli.mjs"), "utf8");
  const set = /const VALUED_FLAGS = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1] ?? "";
  for (const flagName of ["--day-minutes", "--session-minutes", "--vendors", "--day"]) {
    assert.equal(set.includes(`"${flagName}"`), true, `${flagName} takes a value and must be in VALUED_FLAGS`);
  }
  // And every flag the voice verbs read is in that list, so a fifth one added later cannot be missed.
  const verbs = /\/\/ VOICE-1\. The three voice verbs[\s\S]*?\nasync function mailSweep/.exec(source)?.[0] ?? "";
  assert.notEqual(verbs.length, 0, "the voice verbs are not in cp/cli.mjs");
  for (const match of verbs.matchAll(/flag\(args, "(--[a-z-]+)"\)/g)) {
    assert.equal(set.includes(`"${match[1]}"`), true, `${match[1]} is read by a voice verb and is not in VALUED_FLAGS`);
  }
});

// ---- the table, on a database that already exists -------------------------------------------------

test("voice_sessions is made on a database that already holds the other tables", async () => {
  // mail_send_log was LIVE on the R750 with seven columns and no resend_id when MAIL-3 added two, and
  // CREATE TABLE IF NOT EXISTS does nothing whatever to a table that is already there. A fresh
  // in-memory store proves none of that.
  //
  // So this builds the database the way the release BEFORE this wave left it -- the shipped schema
  // with this wave's own DDL cut out of it -- and then opens the store on that. Cutting the new block
  // out of the real SCHEMA rather than hand-writing an old one is what makes this keep working: a
  // hand-written fixture drifts from the product and then passes for the wrong reason.
  const root = await mkdtemp(path.join(os.tmpdir(), "cp-voice-"));
  try {
    const file = path.join(root, "control-plane.sqlite");
    const storeSource = await readFile(path.join(repoRoot, "cp/store.mjs"), "utf8");
    const schema = /\nconst SCHEMA = `([\s\S]*?)\n`;/.exec(storeSource)?.[1];
    assert.notEqual(schema, undefined, "SCHEMA is no longer a template literal in cp/store.mjs");
    const before = schema.replace(/-- VOICE-1\.[\s\S]*$/, "");
    assert.equal(before.includes("voice_sessions"), false, "the cut did not remove this wave's DDL");
    assert.equal(before.includes("CREATE TABLE IF NOT EXISTS mail_send_log"), true, "the cut removed more than this wave's DDL");
    const old = new DatabaseSync(file);
    old.exec(before);
    old.exec("INSERT INTO tenants (slug, name, status, created_at, updated_at) VALUES ('demo', 'Demo', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'voice_sessions'").get(), undefined,
      "the database this opens on must NOT already have the table, or it proves nothing");
    old.close();

    const store = openStore({ file });
    try {
      const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name));
      assert.equal(names.includes("voice_sessions"), true, `voice_sessions was not made: ${names.join(", ")}`);
      // And it works on that database, which is the only proof that matters.
      const voice = createVoiceLog({ store, now: () => NOON });
      assert.equal(voice.openSession({ slug: "demo", sessionId: "v-1", vendor: "xai" }).ok, true);
      assert.equal(voice.closeSession({ sessionId: "v-1", wallSeconds: 11 }).ok, true);
      assert.equal(store.getVoiceSession("v-1").wallSeconds, 11);
      // The older table survived, which is the other half of "this migration is a no-op on a live
      // database": a new table must not take anything with it.
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM tenants").get().n, 1);
    } finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- the Spend block -------------------------------------------------------------------------------

test("the Spend block says not-measured in words when nothing was ever reported, and never 0 minutes", async () => {
  // The renderer is a browser module and this is node, so the assertion is on the SOURCE of the block
  // that ships. It is sliced out of the live file rather than copied into the test, for the reason
  // tests/machine-room-mail-chip.test.mjs gives: a copy would go on passing after the console changed,
  // which on a promise about what an operator sees is worse than no test at all.
  const source = await readFile(path.join(repoRoot, "cp/admin/admin.js"), "utf8");
  const block = /\/\/ ---- VOICE-1[\s\S]*?\n  }\n/.exec(source);
  assert.notEqual(block, null, "the VOICE-1 block is not in cp/admin/admin.js");
  const code = block[0];

  // It reads the route this wave added, with the admin bearer, through the helper already in the file.
  assert.match(code, /api\("GET", "\/v1\/voice\/usage"\)/);
  // It draws the words and not a number when nothing has ever reported.
  assert.match(code, /everMeasured/);
  assert.match(code, /not measured/i);
  // And it says which meter every number is, because three of them are seconds of different things.
  assert.match(code, /wall/i);

  // SIX COLUMNS, STILL. rowSpanning(6) and every row build in loadSpend depend on that number, so this
  // block appends BELOW the table rather than adding a seventh column.
  assert.equal(/<th>/.test(code), false, "the voice line is a block under the table and not a column in it");
  assert.match(source, /rowSpanning\(6, "No customers yet\."\)/, "the Spend table is still six columns wide");

  // And no change to the panel's HTML, which belongs to nobody this week.
  const html = await readFile(path.join(repoRoot, "cp/admin/index.html"), "utf8");
  assert.equal(html.includes("voiceSpend"), false, "the block makes its own nodes rather than needing markup");
});

// ---- the two realtime preset rows: prove or drop ---------------------------------------------------

test("the realtime preset rows exist, offer no model, and carry no catalog to read", () => {
  for (const id of REALTIME_PRESET_IDS) {
    const preset = PROVIDER_PRESETS[id];
    assert.notEqual(preset, undefined, `${id} is not in PROVIDER_PRESETS`);
    assert.equal(preset.kind, "realtime", "and kind is not a LiteLLM prefix here, which is why it is its own word");
    assert.deepEqual([...preset.curated], [], `${id} must offer no model: a spoken session does not go through the proxy`);
    assert.equal(String(preset.catalogPath ?? ""), "", `${id} must have no catalog to read`);
    assert.equal(preset.bootstrapEnv.length > 0, true, `${id} names its ~/.api_keys slot`);
  }
  // The authoritative table is cp/voice.mjs, not this one. These rows feed nothing the relay reads.
  assert.equal(REALTIME_PRESET_IDS.length, Object.keys(REALTIME_VENDORS).length);
});

test("providerList offers no model from the realtime rows and nothing mints a credential for them", async () => {
  // THE PROVE-OR-DROP TEST. If either of these leaks the answer is to DELETE both rows rather than
  // patch cp/admin.mjs, which belongs to another wave: the rows are cosmetic, because the key a spoken
  // session dials with is per workspace and lives in that workspace's own state file.
  // A configured proxy, because with none the panel answers `providers: []` and says why -- so a run
  // against an unconfigured one would pass this test by proving nothing at all.
  const proxy = await startFakeProxy({ models: [] });
  const cp = await startControlPlane({
    env: { CP_RELAY_TOKEN: RELAY_TOKEN, CP_PROXY_URL: proxy.url, CP_PROXY_MASTER_KEY: proxy.masterKey },
  });
  try {
    const answer = await cp.admin("GET", "/v1/admin/providers");
    assert.equal(answer.status, 200, answer.text);
    assert.notEqual(answer.body.providers?.length ?? 0, 0, "the panel answered no providers at all, so nothing below is a measurement");
    const rows = Array.isArray(answer.body.providers) ? answer.body.providers : [];
    for (const id of REALTIME_PRESET_IDS) {
      const row = rows.find((one) => one.id === id);
      assert.notEqual(row, undefined, `${id} is not on the panel`);
      // NOT ONE MODEL, from the curated list or from a catalog. This is the assertion the design asks
      // for against providerList(): a realtime model offered as a chat model would be picked, pinned
      // into a box and would fail every request.
      assert.deepEqual(row.catalog.models, [], `${id} offered a model: ${JSON.stringify(row.catalog.models)}`);
      assert.equal(row.keys.length, 0, `${id} holds no key`);
    }

    // And nothing anywhere turns one of these rows into a LiteLLM deployment or credential. The
    // plan-model list is what a customer's box is ever pointed at.
    const aliases = (Array.isArray(answer.body.planModels) ? answer.body.planModels : []).map((one) => String(one.alias ?? ""));
    for (const id of REALTIME_PRESET_IDS) {
      assert.equal(aliases.some((alias) => alias.includes(id)), false, `${id} has a plan model, which it must not`);
    }

    // THE FENCE, MEASURED. A key pasted into one of these cards must not reach LiteLLM. It does not:
    // the realtime endpoint is a websocket address, so the proof step cannot complete against it and
    // the route refuses before it stores anything. The residual sharp edge -- a panel control that can
    // never succeed, refusing with a sentence about reachability -- is filed as VOICE-4, whose fix is
    // a read-only card and lives in cp/admin.mjs.
    const pasted = await cp.admin("POST", `/v1/admin/providers/${REALTIME_PRESET_IDS[0]}/keys`, { apiKey: "xai-not-a-real-key-0123456789" });
    assert.equal([409, 502].includes(pasted.status), true, `a realtime key must not be stored, got ${pasted.status}: ${pasted.text}`);
    const after = await cp.admin("GET", "/v1/admin/providers");
    const realtimeRow = (Array.isArray(after.body.providers) ? after.body.providers : []).find((one) => one.id === REALTIME_PRESET_IDS[0]);
    assert.deepEqual(realtimeRow?.keys ?? [], [], "nothing was stored");
    // And the value appears in no answer, which is cp/PROVIDERS-ROUTES.md section 5's rule.
    assert.equal(pasted.text.includes("xai-not-a-real-key-0123456789"), false);
    assert.equal(after.text.includes("xai-not-a-real-key-0123456789"), false);
  } finally { await cp.dispose(); await proxy.close(); }
});
