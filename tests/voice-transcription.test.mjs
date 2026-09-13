/**
 * VOICE-7, the bridge half: the words the person is saying, labelled on the wire.
 *
 * WHAT THIS PINS. Until 2026-09-10 the relay sent ONE frame, `{t:"heard", text}`, for three
 * different things -- a partial transcript, the finished transcript, and the string the realtime
 * model actually handed to Titan -- and the page could not tell them apart. That was invisible
 * behind a one-line strip beside the composer. VOICE-7 puts those words in a panel over the
 * conversation that has to appear, grow, and dissolve at exactly the right moment and then BE the
 * next row in the chat, so the difference is now the whole feature.
 *
 * THE TWO STRINGS ARE NOT ONE STRING, and that is the thing to keep in view while reading this
 * file. What the person watches being built is the TRANSCRIPTION model's output. What lands in
 * Titan's conversation is the REALTIME model's own tool argument. Two models, two strings. So the
 * panel's last paint comes from `heard-confirmed`, which carries the bytes that went into sendPrompt
 * verbatim along with the nonce the durable row is stamped with, and everything before it is
 * `hear`.
 *
 * THE MEASURED DEFECT IT ALSO CLOSES. On the incremental vendor the caption accumulator was reset
 * only by a `.completed`. Measured on this Mac (node v22.23.1, 2026-09-10): "open the box" followed
 * by "what time is it", with no completion in between, read "open the boxwhat time is it". A strip
 * hid that for the length of one line; a panel shows it for the length of the next utterance.
 */
import { strict as assert } from "node:assert";
import net from "node:net";
import test from "node:test";
import WebSocketClient from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStubRealtime } from "./helpers/stub-realtime.mjs";
import {
  makeCaption, makeVoiceEdge, makeVoicePolicy, vendorOf, writeVoiceSettings,
} from "../ui/voice-edge.mjs";

// ---- the accumulator, with no socket in the room -------------------------------------------------

test("a new item id starts the words empty, so one utterance cannot bleed into the next", () => {
  // THE MEASURED DEFECT, in four lines. The incremental vendor's accumulator used to be cleared only
  // by a `.completed`, and a `.failed` or a dropped completion left the previous sentence in it.
  const caption = makeCaption("incremental");
  caption.apply({ item_id: "item_a", delta: "open " });
  caption.apply({ item_id: "item_a", delta: "the box" });
  assert.equal(caption.value, "open the box");
  assert.equal(caption.itemId, "item_a");
  caption.apply({ item_id: "item_b", delta: "what " });
  caption.apply({ item_id: "item_b", delta: "time is it" });
  assert.equal(caption.value, "what time is it", "the second utterance is its own sentence");
  assert.ok(!caption.value.includes("open"), "and the first one is gone");
});

test("an explicit reset clears the item too, so the next utterance is not read as the same one", () => {
  const caption = makeCaption("incremental");
  caption.apply({ item_id: "item_a", delta: "half a sentence" });
  caption.reset();
  assert.equal(caption.value, "");
  assert.equal(caption.itemId, "");
  caption.apply({ item_id: "item_a", delta: "a fresh one" });
  assert.equal(caption.value, "a fresh one", "the same item id after a reset is still a fresh start");
});

test("the cumulative vendor's corrections leave exactly ONE final string", () => {
  // xAI's own reference: the `.updated` transcript "is the cumulative transcript which may have
  // corrections to previous updated transcripts -- this is different from a transcript delta".
  const caption = makeCaption(vendorOf("xai").transcription.mode);
  caption.apply({ item_id: "item_a", transcript: "what is the teen", delta: "what is the teen" });
  caption.apply({ item_id: "item_a", transcript: "what is the team", delta: "what is the team" });
  caption.apply({ item_id: "item_a", transcript: "what is the team working on", delta: "what is the team working on" });
  assert.equal(caption.value, "what is the team working on");
  assert.ok(!caption.value.includes("teen"), "the correction replaced the wrong word rather than appending it");
});

// ---- the whole session, through a real stub and a real ws client ----------------------------------
//
// The harness below is the one in tests/voice-turn.test.mjs and tests/voice-caps-ledger.test.mjs,
// duplicated rather than shared: this wave owns exactly one test helper
// (tests/helpers/stub-realtime.mjs) and a second one would put a file in two waves' hands.

function fakeGateway({ agents = [{ id: "a1", name: "Titan", isRunning: true }], tail = () => [], fail = null } = {}) {
  const calls = [];
  let polls = 0;
  const call = async (command, args = {}) => {
    calls.push({ command, args });
    if (typeof fail === "function") {
      const thrown = fail(command, polls);
      if (thrown != null) throw thrown;
    }
    if (command === "listAgents") return { agents };
    if (command === "sendPrompt") return { accepted: true };
    if (command === "getAgentTranscriptTail") { polls += 1; return { entries: tail(polls) }; }
    if (command === "resolveAutoReviewApproval" || command === "resolveLocalToolPermission" || command === "respondToWidget") return { ok: true };
    return {};
  };
  return { call, calls, of: (command) => calls.filter((row) => row.command === command) };
}

const reply = (id, content, { attemptId = "att1", at = 1_700_000_000_500 } = {}) => ({
  id, kind: "send-message", timestampMs: at, evidence: { attemptId },
  message: { type: "text", content },
});

/** Wall time, for the one thing that is a real clock: the echo gate's tail after spoken audio. */
const waitMs = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

const approvalEntry = (id, requestId, { at = 1_700_000_000_400, summary = "Send the email to Richard" } = {}) => ({
  id, kind: "send-message", timestampMs: at,
  message: { type: "auto-review-approval", approval: { requestId, status: "pending", summary, reason: "it sends mail", command: "mail send" } },
});

async function openSession({ stub, settings, gateway, dir }) {
  await writeVoiceSettings(settings, { file: path.join(dir, "voice.json") });
  const t = {
    slug: "acme", name: "Acme", operator: false,
    gateway: "http://127.0.0.1:1/unused",
    headers: () => ({}),
    ensureDir: () => {},
    voiceSettingsFile: path.join(dir, "voice.json"),
    voiceLedgerFile: path.join(dir, "voice-minutes.jsonl"),
  };
  const logLines = [];
  const edge = makeVoiceEdge({ greet: false,
    t, call: gateway.call, policy: makeVoicePolicy({}), providerUrl: stub.url,
    log: (line) => logLines.push(String(line)),
  });
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  server.on("upgrade", () => {});
  server.on("connection", (socket) => {
    let head = "";
    const onData = (chunk) => {
      head += String(chunk);
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const headers = Object.fromEntries(head.split("\r\n").slice(1).filter((l) => l.includes(":"))
        .map((line) => [line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
      edge.handleUpgrade({ headers, method: "GET", url: "/voice/socket" }, socket, null, { origin: null })
        .catch((error) => logLines.push(`handleUpgrade threw: ${error?.stack ?? error}`));
    };
    socket.on("data", onData);
  });
  const client = new WebSocketClient(`ws://127.0.0.1:${port}/voice/socket`);
  const frames = { json: [], binary: [], log: logLines };
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
  const settle = async (predicate, label, tries = 250) => {
    for (let i = 0; i < tries; i += 1) {
      if (predicate()) return true;
      await new Promise((r) => { const timer = setTimeout(r, 20); timer.unref(); });
    }
    throw new Error([
      `timed out waiting for ${label}.`,
      `  frames to the page: ${JSON.stringify(frames.json).slice(0, 900)}`,
      `  the relay said: ${logLines.join(" | ").slice(0, 600)}`,
      `  the provider saw: ${JSON.stringify(stub.events.inbound).slice(0, 400)}`,
    ].join("\n"));
  };
  const session = {
    client, frames, edge, settle,
    of: (kind) => frames.json.filter((f) => f.t === kind),
    close: async () => { client.terminate(); await new Promise((resolve) => server.close(resolve)); },
  };
  await session.settle(() => session.of("ready").length > 0, "the ready frame");
  // The provider socket has to be UP before the stub can emit into it: the ready frame goes to the
  // page before the dial completes, so emitting on ready alone drops the event on the floor.
  await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
  return session;
}

/** One session, one stub, one temp dir, cleaned up whatever the body does. */
async function withSession(body, { vendor = "xai", gateway = fakeGateway(), audioFrames = 3, key = "xai-test-key-voice7" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-transcription-"));
  const stub = await startStubRealtime({ vendor, audioFrames });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor, apiKey: key }, gateway, dir });
    await body({ stub, session, gateway });
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the labelled frames -------------------------------------------------------------------------

test("a growing utterance arrives as hear frames the page can tell apart, and `heard` still ships", async () => {
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStarted({ itemId: "item_1" });
    await session.settle(() => session.of("hear-begin").length > 0, "the panel being opened");
    await stub.emitUserTranscript(
      ["what", "what is the", "what is the team working on"],
      { itemId: "item_1" },
    );
    await session.settle(() => session.of("hear").filter((f) => f.final === false).length >= 3, "three partials");
    stub.emitUserTranscriptDone("What is the team working on?", { itemId: "item_1" });
    await session.settle(() => session.of("hear").some((f) => f.final === true), "the finished transcript");

    const begins = session.of("hear-begin");
    assert.equal(begins.length, 1, "one panel per utterance");
    assert.equal(begins[0].itemId, "item_1", "the item id reaches the page, which is what OpenAI says to reconcile on");
    assert.ok(begins[0].turn >= 1);

    const partials = session.of("hear").filter((f) => f.final === false);
    assert.deepEqual(partials.map((f) => f.text), ["what", "what is the", "what is the team working on"], "the words grow");
    assert.ok(partials.every((f) => f.itemId === "item_1" && f.turn === begins[0].turn), "every partial belongs to this turn");

    const finals = session.of("hear").filter((f) => f.final === true);
    assert.equal(finals.length, 1, "exactly one final");
    assert.equal(finals[0].text, "What is the team working on?", "and it is the corrected one");

    // The frame the shipped page draws is untouched, so a relay restart mid-call does not blank an
    // old page's strip. Four transcription events, four `heard` frames, same as before this wave.
    assert.equal(session.of("heard").length, 4);
    assert.equal(session.of("heard").at(-1).text, "What is the team working on?");
  });
});

test("the cumulative vendor's correction reaches the page as a replacement, not an append", async () => {
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStarted({ itemId: "item_c" });
    await stub.emitUserTranscript(["what is the teen", "what is the team"], { itemId: "item_c" });
    await session.settle(() => session.of("hear").length >= 2, "both updates");
    const texts = session.of("hear").map((f) => f.text);
    assert.deepEqual(texts, ["what is the teen", "what is the team"]);
    assert.ok(!texts.at(-1).includes("teen"), "the panel shows one sentence, not the wrong word plus the right one");
  }, { vendor: "xai" });
});

test("on the incremental vendor a new utterance does not carry the last one's words", async () => {
  // The measured defect, end to end. Two utterances, no `.completed` between them: before this wave
  // the second one read "open the boxwhat time is it".
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStarted({ itemId: "item_1" });
    await stub.emitUserTranscript(["open ", "open the box"], { itemId: "item_1" });
    await session.settle(() => session.of("hear").length >= 2, "the first utterance");
    // No `.completed` at all: a failed transcription, a dropped event, or two utterances close
    // together. The next speech_started is what clears it.
    stub.emitSpeechStarted({ itemId: "item_2" });
    await stub.emitUserTranscript(["what ", "what time is it"], { itemId: "item_2" });
    await session.settle(() => session.of("hear").length >= 4, "the second utterance");
    const last = session.of("hear").at(-1);
    assert.equal(last.text, "what time is it");
    assert.ok(!last.text.includes("open"), `the first utterance bled into the second: ${last.text}`);
    assert.equal(last.itemId, "item_2");
    assert.equal(session.of("hear-begin").length, 2, "two utterances, two panels");
    assert.ok(session.of("hear-begin")[1].turn > session.of("hear-begin")[0].turn, "and the second is a later turn");
  }, { vendor: "openai", key: "sk-test-key-voice7" });
});

test("a transcription that failed closes the turn instead of leaving words over the conversation", async () => {
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStarted({ itemId: "item_f" });
    await stub.emitUserTranscript(["mm"], { itemId: "item_f" });
    await session.settle(() => session.of("hear").length > 0, "the partial");
    stub.emitTranscriptFailed({ itemId: "item_f" });
    await session.settle(() => session.of("hear-end").length > 0, "the turn being closed");
    assert.equal(session.of("hear-end").at(-1).reason, "no-words");
    assert.equal(session.of("heard-confirmed").length, 0, "nothing went into his conversation");
  });
});

// ---- the confirmation ----------------------------------------------------------------------------

test("heard-confirmed carries the bytes sendPrompt was called with and the nonce the row is stamped with", async () => {
  const gateway = fakeGateway({ tail: (n) => (n >= 2 ? [reply("e1", "We are on the deploy gate.")] : []) });
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStarted({ itemId: "item_1" });
    // The transcription model's words and the realtime model's tool argument are DIFFERENT strings,
    // which is the whole reason the confirmation exists.
    await stub.emitUserTranscript(["what is the team working on"], { itemId: "item_1" });
    stub.emitUserTranscriptDone("what is the team working on", { itemId: "item_1" });
    stub.emitToolCall({ name: "titan", args: { message: "What is the team working on?" }, callId: "c1", triple: false });
    await session.settle(() => session.of("heard-confirmed").length > 0, "the confirmation");

    const confirmed = session.of("heard-confirmed").at(-1);
    const sent = gateway.of("sendPrompt")[0].args;
    assert.equal(confirmed.text, sent.prompt, "byte-identical to what went into his conversation");
    assert.equal(confirmed.text, "What is the team working on?");
    assert.notEqual(confirmed.text, session.of("hear").at(-1).text, "and it is NOT the transcription model's string");
    assert.equal(confirmed.nonce, sent.clientNonce, "the same nonce the durable entry carries");
    assert.ok(confirmed.nonce.startsWith("voice:"), confirmed.nonce);
    assert.equal(confirmed.landed, true);
    assert.equal(confirmed.turn, session.of("hear-begin").at(-1).turn, "and it belongs to the turn on screen");

    await session.settle(() => session.of("hear-end").length > 0, "the panel dissolving");
    assert.equal(session.of("hear-end").at(-1).reason, "sent");
    // The order is what the panel's state machine reads: the confirmed words are its LAST paint, and
    // only then does it dissolve.
    const order = session.frames.json.filter((f) => f.t === "heard-confirmed" || f.t === "hear-end").map((f) => f.t);
    assert.deepEqual(order, ["heard-confirmed", "hear-end"]);
  }, { gateway });
});

test("the confirmation is sent when the box TAKES it, not when Titan finishes answering", async () => {
  // sendPrompt answers in 6-14 ms; the reply lands 5.5 to 25 s later. A panel that waited for the
  // reply would sit over the conversation for the whole of Titan's thinking time.
  let released = false;
  const gateway = fakeGateway({ tail: () => (released ? [reply("e1", "Done.")] : []) });
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStarted({ itemId: "item_1" });
    stub.emitToolCall({ name: "titan", args: { message: "run the gate" }, callId: "c1", triple: false });
    await session.settle(() => session.of("hear-end").length > 0, "the panel dissolving before the reply");
    assert.equal(session.of("heard-confirmed").length, 1);
    assert.equal(session.of("hear-end").at(-1).reason, "sent");
    assert.equal(stub.events.toolOutputs.length, 0, "Titan has not answered yet");
    released = true;
    await session.settle(() => stub.events.toolOutputs.length > 0, "the answer, afterwards");
    assert.equal(session.of("heard-confirmed").length, 1, "and the confirmation is not repeated");
  }, { gateway });
});

// ---- the turns that never become a row -----------------------------------------------------------

test("a spoken yes that closes a held card ends the turn on its own terms", async () => {
  const gateway = fakeGateway({ tail: (n) => (n >= 2 ? [approvalEntry("e1", "req1")] : []) });
  await withSession(async ({ stub, session }) => {
    // Turn one: the card is read out as a question, and that turn DOES become a row.
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "anything pending" }, callId: "c1", triple: false });
    await session.settle(() => stub.events.toolOutputs.length >= 1, "the card spoken back");
    assert.equal(session.of("hear-end").at(-1).reason, "sent");
    // Turn two: the yes. The mic is held shut until the spoken card has finished coming out of the
    // speaker plus the 350 ms tail, which is three hundred milliseconds of tone here, so this waits
    // it out rather than pretending a person could talk over it.
    await waitMs(900);
    stub.emitSpeechStopped();
    await session.settle(() => session.of("hear-begin").length >= 2, "the second panel");
    stub.emitToolCall({ name: "titan", args: { message: "yes" }, callId: "c2", triple: false });
    await session.settle(() => gateway.of("resolveAutoReviewApproval").length > 0, "the approval closing");
    await session.settle(() => session.of("hear-end").length >= 2, "the second panel dissolving");
    assert.equal(session.of("hear-end").at(-1).reason, "answered-card");
    assert.equal(session.of("heard-confirmed").length, 1, "the yes produced no second row");
    assert.equal(gateway.of("sendPrompt").length, 1, "and nothing extra went into his conversation");
  }, { gateway });
});

test("an utterance the model made nothing of ends the turn rather than hanging over the chat", async () => {
  const gateway = fakeGateway();
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStopped();
    await session.settle(() => session.of("hear-begin").length > 0, "the panel");
    stub.emitToolCall({ name: "titan", args: { message: "   " }, callId: "c1", triple: false });
    await session.settle(() => session.of("hear-end").length > 0, "the panel dissolving");
    assert.equal(session.of("hear-end").at(-1).reason, "empty");
    assert.equal(session.of("heard-confirmed").length, 0);
    assert.equal(gateway.of("sendPrompt").length, 0, "nothing was sent");
  }, { gateway });
});

test("a send his box refused ends the turn, because no row will ever arrive", async () => {
  const gateway = fakeGateway({ fail: (command) => (command === "sendPrompt" ? new Error("HTTP 503") : null) });
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStopped();
    await session.settle(() => session.of("hear-begin").length > 0, "the panel");
    stub.emitToolCall({ name: "titan", args: { message: "start the gate" }, callId: "c1", triple: false });
    await session.settle(() => session.of("hear-end").length > 0, "the panel dissolving");
    assert.equal(session.of("hear-end").at(-1).reason, "not-accepted");
    assert.equal(session.of("heard-confirmed").length, 0, "nothing was confirmed, because nothing landed");
  }, { gateway });
});

test("a finished response that asked Titan nothing still ends the turn", async () => {
  // The instructions forbid the model answering out of its own head. They cannot prevent it, and a
  // panel that waits for a row would sit over the conversation for the rest of the call.
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStarted({ itemId: "item_1" });
    await stub.emitUserTranscript(["never mind"], { itemId: "item_1" });
    await session.settle(() => session.of("hear").length > 0, "the words");
    await stub.speak("All right.");
    await session.settle(() => session.of("hear-end").length > 0, "the panel dissolving");
    assert.equal(session.of("hear-end").at(-1).reason, "no-answer");
    assert.equal(session.of("heard-confirmed").length, 0);
  });
});

test("every open turn is closed exactly once, whatever ends it", async () => {
  const gateway = fakeGateway({ tail: (n) => (n >= 2 ? [reply("e1", "Right.")] : []) });
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "one thing" }, callId: "c1", triple: true });
    await session.settle(() => session.of("hear-end").length > 0, "the turn closing");
    await session.settle(() => stub.events.toolOutputs.length > 0, "the answer going back");
    // The tool call arrives on all three surfaces and the reply is spoken afterwards, both of which
    // end in a `response.done`. Neither may close the turn a second time.
    const ends = session.of("hear-end").filter((f) => f.turn === session.of("hear-begin")[0].turn);
    assert.equal(ends.length, 1, `the turn was closed ${ends.length} times: ${JSON.stringify(session.of("hear-end"))}`);
  }, { gateway });
});

// ---- the machine's own words are never the person's ----------------------------------------------

test("no words are painted while Titan is the one talking", async () => {
  // docs/VOICE.md 8 records a measured feedback loop where the model's own speech came back through
  // the microphone and transcribed as a user turn. The echo gate holds the mic on both sides; if it
  // ever slips, the panel must not render the machine's sentence as the person's.
  const gateway = fakeGateway({ tail: (n) => (n >= 2 ? [reply("e1", "Right.")] : []) });
  await withSession(async ({ stub, session }) => {
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "say something" }, callId: "c1", triple: false });
    await session.settle(() => session.of("speak-begin").length > 0, "Titan speaking");
    const before = session.of("hear").length;
    const beginsBefore = session.of("hear-begin").length;
    // Thirty frames of audio is three seconds of speech, so this lands well inside the window.
    stub.emitSpeechStarted({ itemId: "item_echo" });
    await stub.emitUserTranscript(["right", "right so the gate"], { itemId: "item_echo" });
    for (let i = 0; i < 15; i += 1) await new Promise((r) => { const timer = setTimeout(r, 20); timer.unref(); });
    assert.equal(session.of("hear").length, before, "nothing was painted while the machine was talking");
    assert.equal(session.of("hear-begin").length, beginsBefore, "and no panel was opened for it");
    // The shipped strip is unchanged, so this wave is not a behaviour change for the old page.
    assert.ok(session.of("heard").length > 0);
  }, { gateway, audioFrames: 30 });
});
