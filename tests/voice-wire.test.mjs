/**
 * VOICE-1 item A2: the two wires.
 *
 * The design brief for this wave said the two providers speak one wire and switching is "a URL
 * swap". That is FALSE as of 2026-09-09 and this file is where it is pinned false: xAI takes the
 * FLAT session (top-level `voice` and `turn_detection`, no `session.type`) and OpenAI's GA realtime
 * REFUSES exactly that with `Unknown parameter: 'session.voice'`, wanting `session.type:"realtime"`,
 * `audio.output.voice`, `audio.input.turn_detection`, and NO `OpenAI-Beta` header.
 *
 * So each builder is driven against BOTH stubs: its own, which must accept it, and the other
 * vendor's, which must refuse it in that vendor's own words. A bridge whose tests only ever met a
 * permissive stub would pass here and fail on the wire.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { startStubRealtime } from "./helpers/stub-realtime.mjs";
import {
  AUDIO_RATE, TURN_DETECTION, VENDORS, VENDOR_IDS,
  buildSession, canonicalEvent, dialHeaders, dialUrl, makeCaption, titanTool, vendorOf,
} from "../ui/voice-edge.mjs";

/** A real key-shaped string, so a leak sweep has bytes to look for. */
const PLANTED_KEY = "xai-9Ht7QbLmZ2pRvK4sXwE8cD1fJ6nY3aU0";

/** Dial a stub and drive one session.update through it; return what the stub made of it. */
async function offerSession(stub, vendorId, { apiKey = PLANTED_KEY } = {}) {
  const socket = new WebSocket(dialUrl(vendorId, { url: stub.url }), { headers: dialHeaders(vendorId, apiKey) });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("the stub refused the dial")), { once: true });
    const timer = setTimeout(() => reject(new Error("the stub never opened")), 5000);
    timer.unref();
  });
  const answers = [];
  socket.addEventListener("message", (event) => { try { answers.push(JSON.parse(String(event.data))); } catch { /* not JSON */ } });
  socket.send(JSON.stringify(buildSession(vendorId, { tools: [titanTool()] })));
  await stub.waitFor((events) => events.sessions.length > 0 || events.refusals.length > 0, { label: "the stub's verdict on the session" });
  // One more turn of the loop so the answer frame has landed in the client too.
  for (let i = 0; i < 40 && answers.length === 0; i += 1) await new Promise((r) => { const timer = setTimeout(r, 20); timer.unref(); });
  socket.close();
  return { answers, accepted: stub.events.sessions.length > 0, refusals: stub.events.refusals };
}

test("the xAI session is FLAT, and its own stub takes it", async () => {
  const built = buildSession("xai", { tools: [titanTool()] });
  assert.equal(built.type, "session.update");
  const session = built.session;
  assert.equal(typeof session.voice, "string");
  assert.ok(session.voice.length > 0, "the voice is top level on xAI");
  assert.equal(session.turn_detection.type, "server_vad", "and so is turn detection");
  assert.equal(session.type, undefined, "there is NO session.type on xAI");
  assert.equal(session.audio.input.format.rate, AUDIO_RATE);
  assert.equal(session.audio.output.format.rate, AUDIO_RATE);
  assert.equal(session.audio.input.transcription.model, "grok-transcribe");
  // The thresholds are set deliberately, not left to a default tuned for a phone call.
  assert.equal(session.turn_detection.silence_duration_ms, TURN_DETECTION.silence_duration_ms);
  assert.equal(session.turn_detection.threshold, TURN_DETECTION.threshold);

  const stub = await startStubRealtime({ vendor: "xai" });
  try {
    const result = await offerSession(stub, "xai");
    assert.equal(result.accepted, true, `the xai stub refused its own shape: ${JSON.stringify(result.refusals)}`);
    assert.deepEqual(result.refusals, []);
  } finally { await stub.close(); }
});

test("the xAI session is REFUSED by the OpenAI stub, in OpenAI's own words", async () => {
  const stub = await startStubRealtime({ vendor: "openai" });
  try {
    const result = await offerSession(stub, "xai");
    assert.equal(result.accepted, false, "the GA service does not take the flat shape");
    assert.equal(result.refusals[0].code, "unknown_parameter");
    assert.equal(result.refusals[0].message, "Unknown parameter: 'session.voice'.");
    // And the bridge is TOLD, as an error event it can act on, rather than left to time out.
    const error = result.answers.find((event) => event.type === "error");
    assert.ok(error != null, "the refusal reaches the bridge as an event");
    assert.equal(error.error.code, "unknown_parameter");
  } finally { await stub.close(); }
});

test("the OpenAI session is GA-shaped, and its own stub takes it", async () => {
  const built = buildSession("openai", { tools: [titanTool()] });
  const session = built.session;
  assert.equal(session.type, "realtime", "session.type is required on GA");
  assert.equal(session.voice, undefined, "the voice is NOT top level on GA");
  assert.equal(session.turn_detection, undefined, "and neither is turn detection");
  assert.ok(typeof session.audio.output.voice === "string" && session.audio.output.voice.length > 0, "the voice lives at audio.output.voice");
  assert.equal(session.audio.input.turn_detection.type, "server_vad");
  // A belt beside the mic gate, and the one place the two vendors differ in our favour: xAI
  // documents no equivalent, so there the gate is the only defence.
  assert.equal(session.audio.input.turn_detection.interrupt_response, false);
  assert.deepEqual(session.output_modalities, ["audio"]);
  // create_response is left alone, so VAD still answers on its own.
  assert.equal(session.audio.input.turn_detection.create_response, undefined);

  const stub = await startStubRealtime({ vendor: "openai" });
  try {
    const result = await offerSession(stub, "openai");
    assert.equal(result.accepted, true, `the openai stub refused its own shape: ${JSON.stringify(result.refusals)}`);
  } finally { await stub.close(); }
});

test("the OpenAI session is REFUSED by the xAI stub", async () => {
  const stub = await startStubRealtime({ vendor: "xai" });
  try {
    const result = await offerSession(stub, "openai");
    assert.equal(result.accepted, false, "xAI does not take the GA shape either, so one builder could not serve both");
    assert.equal(result.refusals[0].code, "unknown_parameter");
    assert.equal(result.refusals[0].message, "Unknown parameter: 'session.type'.");
  } finally { await stub.close(); }
});

test("the key travels as a header and appears in no URL and no subprotocol", async () => {
  for (const vendorId of VENDOR_IDS) {
    const stub = await startStubRealtime({ vendor: vendorId });
    try {
      await offerSession(stub, vendorId);
      const request = stub.events.requests.at(-1);
      assert.ok(request != null, "the stub saw the dial");
      assert.equal(request.auth, `Bearer ${PLANTED_KEY}`, "the credential arrived as an Authorization header");
      assert.ok(!request.url.includes(PLANTED_KEY), `the key's bytes are in the URL: ${request.url}`);
      assert.equal(request.subprotocol, "", "never a subprotocol: proxies log those");
      // xAI ships an `xai-client-secret.<token>` subprotocol and OpenAI ships client secrets plus
      // WebRTC. Both were refused on purpose: each puts a real credential in the browser and makes
      // the minutes ledger and the day cap unenforceable.
      assert.ok(!request.subprotocol.includes("client-secret"));
      // The legacy beta header must not be sent to GA.
      assert.equal(request.beta, "", "no OpenAI-Beta header on either vendor");
    } finally { await stub.close(); }
  }
});

test("the dial URL carries the model and the headers carry nothing but the credential", () => {
  for (const vendorId of VENDOR_IDS) {
    const url = dialUrl(vendorId, {});
    assert.ok(url.startsWith("wss://"), `${vendorId} dials over TLS`);
    assert.ok(url.includes(`model=${encodeURIComponent(VENDORS[vendorId].model)}`));
    const headers = dialHeaders(vendorId, PLANTED_KEY);
    assert.deepEqual(Object.keys(headers), ["authorization"], "one header, and it is the credential");
    assert.equal(headers.authorization, `Bearer ${PLANTED_KEY}`);
  }
  // An explicit model wins, which is what the Voice card's model field is for.
  assert.ok(dialUrl("xai", { model: "grok-voice-next" }).includes("model=grok-voice-next"));
});

test("the event map resolves the GA audio delta on both vendors and accepts the legacy aliases", () => {
  // GA names are what the bridge emits and reads; the legacy names are accepted INBOUND, because a
  // provider mid-migration sends either and a bridge that knew one set would go deaf mid-sentence.
  assert.equal(canonicalEvent("response.output_audio.delta"), "response.output_audio.delta");
  assert.equal(canonicalEvent("response.audio.delta"), "response.output_audio.delta");
  assert.equal(canonicalEvent("response.audio_transcript.delta"), "response.output_audio_transcript.delta");
  assert.equal(canonicalEvent("response.text.delta"), "response.output_text.delta");
  assert.equal(canonicalEvent("response.audio.done"), "response.output_audio.done");
  // An unknown type is passed through rather than mapped to something plausible.
  assert.equal(canonicalEvent("session.updated"), "session.updated");
  assert.equal(canonicalEvent(undefined), "");
});

test("three xAI transcription updates with corrections leave exactly ONE final text", () => {
  // xAI's `.updated` is CUMULATIVE with corrections. Appending the delta writes the sentence N
  // times, which is what the console would then draw under the person's own words.
  const caption = makeCaption(vendorOf("xai").transcription.mode);
  assert.equal(vendorOf("xai").transcription.mode, "cumulative");
  caption.apply({ transcript: "what is the", delta: "what is the" });
  caption.apply({ transcript: "what is the team", delta: "what is the team" });
  caption.apply({ transcript: "what is the team working on", delta: "what is the team working on" });
  assert.equal(caption.value, "what is the team working on");
  assert.equal(caption.value.split("what is the").length - 1, 1, "the phrase appears ONCE, not three times");
});

test("OpenAI transcription deltas are incremental and are appended", () => {
  const caption = makeCaption(vendorOf("openai").transcription.mode);
  assert.equal(vendorOf("openai").transcription.mode, "incremental");
  caption.apply({ delta: "what is " });
  caption.apply({ delta: "the team " });
  caption.apply({ delta: "working on" });
  assert.equal(caption.value, "what is the team working on");
  // A completed event carrying the whole utterance still replaces, because that is the corrected one.
  assert.equal(caption.complete({ transcript: "What is the team working on?" }), "What is the team working on?");
});

test("the stub's own transcription shape matches the vendor it claims to be", async () => {
  for (const vendorId of VENDOR_IDS) {
    const stub = await startStubRealtime({ vendor: vendorId });
    const seen = [];
    try {
      const socket = new WebSocket(dialUrl(vendorId, { url: stub.url }), { headers: dialHeaders(vendorId, PLANTED_KEY) });
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        const timer = setTimeout(() => reject(new Error("the stub never opened")), 5000);
        timer.unref();
      });
      socket.addEventListener("message", (event) => { try { seen.push(JSON.parse(String(event.data))); } catch { /* not JSON */ } });
      stub.emitUserTranscript("hello there");
      for (let i = 0; i < 60 && seen.length === 0; i += 1) await new Promise((r) => { const timer = setTimeout(r, 20); timer.unref(); });
      const type = seen[0]?.type ?? "";
      if (vendorId === "xai") assert.equal(type, "conversation.item.input_audio_transcription.updated");
      else assert.equal(type, "conversation.item.input_audio_transcription.delta");
      // And rate_limits.updated is an OpenAI-only event, so nothing on xAI may ever wait on it.
      assert.equal(stub.emitRateLimits(), vendorId === "openai");
      assert.equal(VENDORS[vendorId].emitsRateLimits, vendorId === "openai");
      socket.close();
    } finally { await stub.close(); }
  }
});

test("the tool array is length one and its name is titan", () => {
  for (const vendorId of VENDOR_IDS) {
    const session = buildSession(vendorId).session;
    assert.equal(session.tools.length, 1, "one tool, and nothing is ever added to this array");
    assert.equal(session.tools[0].name, "titan");
    assert.equal(session.tool_choice, "auto");
    // xAI's session-level web_search, x_search, file_search and mcp are explicitly ABSENT: a
    // realtime model that can search is the second brain this design exists to prevent.
    const asText = JSON.stringify(session);
    for (const forbidden of ["web_search", "x_search", "file_search", "\"mcp\""]) {
      assert.ok(!asText.includes(forbidden), `${vendorId} session offers ${forbidden}`);
    }
    assert.deepEqual(Object.keys(session.tools[0].parameters.properties), ["message"], "one string parameter");
  }
});

test("the base instructions are byte-identical between two builds of the same session", () => {
  // Rewriting the instructions invalidates the cached prefix and re-bills the whole conversation
  // every turn -- the single most expensive thing omarchy's session did, and the same lesson as
  // m3-glm-prefix-cache.md. So nothing per-turn may leak into them: no clock, no id, no counter.
  for (const vendorId of VENDOR_IDS) {
    const first = JSON.stringify(buildSession(vendorId));
    const second = JSON.stringify(buildSession(vendorId));
    assert.equal(first, second);
  }
});
