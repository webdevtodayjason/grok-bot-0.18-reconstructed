/**
 * A stub realtime provider, for the voice bridge's tests and for scripts/verify-voice.mjs.
 *
 * THIS CONTRACT IS FROZEN (VOICE-1, item A7). Item C's gate imports it, so the exported shape --
 * startStubRealtime's options, the returned object, and every field on `events` -- is added to and
 * never changed. If something here has to change, it changes with C's gate in the same commit.
 *
 * It runs on `ws`, which is a devDependency this repo already carries (package.json) for tests and
 * gates. ui/voice-edge.mjs imports NOTHING outside node builtins, because the relay has no
 * node_modules at all; that asymmetry is deliberate and is why the stub lives under tests/.
 *
 * WHAT IT IS FOR. The two vendors do NOT speak one wire, whatever the design brief for this wave
 * said. xAI takes a FLAT session (top-level `voice` and `turn_detection`, no `session.type`) and
 * OpenAI's GA realtime refuses exactly that shape; OpenAI wants `session.type:"realtime"` with the
 * voice down under `audio.output.voice`. So each stub ENFORCES ITS OWN VENDOR'S RULES and answers
 * the other vendor's shape the way the real service does. A bridge that only ever met a permissive
 * stub would pass its tests and fail on the wire, which is the whole reason this file is strict.
 */
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";

/** 100 ms of 24 kHz mono PCM16, which is the frame size the bridge and the browser both use. */
export const STUB_FRAME_BYTES = 4800;
export const STUB_RATE = 24000;

/** A sine tone as PCM16 LE mono, so a playback test can hear something that is not silence. */
export function toneFrame(hz = 440, bytes = STUB_FRAME_BYTES, rate = STUB_RATE, phase = 0) {
  const samples = Math.floor(bytes / 2);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin(2 * Math.PI * hz * ((phase + i) / rate)) * 12000);
    out.writeInt16LE(value, i * 2);
  }
  return out;
}

const jsonOf = (raw) => { try { return JSON.parse(String(raw)); } catch { return null; } };

/**
 * The one thing both vendors agree on: a realtime session is configured with `session.update` and
 * a tool result goes back as a `conversation.item.create` holding a `function_call_output`. Every
 * other name in this file is one vendor's and is checked as that vendor's.
 */
function checkSession(vendor, session) {
  if (session == null || typeof session !== "object") {
    return { code: "invalid_request_error", message: "session.update carried no session object." };
  }
  if (vendor === "openai") {
    // The GA refusal, in the service's own words (mastra-ai/mastra#16940).
    if (session.voice !== undefined) {
      return { code: "unknown_parameter", message: "Unknown parameter: 'session.voice'." };
    }
    if (session.turn_detection !== undefined) {
      return { code: "unknown_parameter", message: "Unknown parameter: 'session.turn_detection'." };
    }
    if (session.type !== "realtime") {
      return { code: "missing_required_parameter", message: "Missing required parameter: 'session.type'." };
    }
    if (typeof session.audio?.output?.voice !== "string" || session.audio.output.voice.length === 0) {
      return { code: "missing_required_parameter", message: "Missing required parameter: 'session.audio.output.voice'." };
    }
    return null;
  }
  // xAI: the flat shape AmpCortex drives today.
  if (session.type !== undefined) {
    return { code: "unknown_parameter", message: "Unknown parameter: 'session.type'." };
  }
  if (typeof session.voice !== "string" || session.voice.length === 0) {
    return { code: "missing_required_parameter", message: "Missing required parameter: 'session.voice'." };
  }
  if (session.turn_detection?.type !== "server_vad") {
    return { code: "missing_required_parameter", message: "Missing required parameter: 'session.turn_detection'." };
  }
  return null;
}

/**
 * Start a stub provider.
 *
 * @param {object} options
 * @param {"xai"|"openai"} options.vendor  which vendor's rules this stub enforces.
 * @param {number} [options.toneHz]        the pitch of the fake speech, so a test can measure it.
 * @param {number} [options.audioFrames]   how many 100 ms frames one spoken reply is.
 * @param {boolean} [options.requireAuth]  off only for a test that wants to prove the refusal.
 * @returns {Promise<object>} { url, port, close, events, emitToolCall, emitRateLimits, ... }
 */
export async function startStubRealtime({
  vendor = "xai",
  toneHz = 440,
  audioFrames = 3,
  requireAuth = true,
} = {}) {
  if (vendor !== "xai" && vendor !== "openai") throw new Error(`unknown stub vendor ${vendor}`);

  const events = {
    vendor,
    /** Every upgrade this stub was asked for: the URL and the headers it arrived with. A key-leak
     *  sweep reads `requests[].url` and asserts the key's bytes are not in it. */
    requests: [],
    /** Every JSON message the bridge sent, in order, parsed. */
    inbound: [],
    /** Every session.update's `session` object that was ACCEPTED. */
    sessions: [],
    /** What the stub refused, as {code, message}. */
    refusals: [],
    /** input_audio_buffer.append frames and their decoded byte count. */
    appendFrames: 0,
    appendBytes: 0,
    /**
     * NEW FIELDS, ADDED FOR VOICE-11 AND NEVER CHANGED (the frozen-contract rule at the top).
     *
     * A real service's turn detection ends a turn on SILENCE THAT KEEPS ARRIVING, so the console
     * sends eight zero-filled frames after a release. `silentFrames` is every all-zero append this
     * stub has seen; `trailingSilentFrames` is how many of them are at the END of the stream, reset
     * by the next append that carries sound. A gate asserting "the release reached the vendor" reads
     * the second one, because the first cannot tell a tail from a quiet room.
     */
    silentFrames: 0,
    trailingSilentFrames: 0,
    /** conversation.item.create that are NOT a function_call_output. On xAI each of these is a
     *  billed text event, which is why the bridge sends Titan's reply back as a tool output. */
    billableItems: 0,
    /** The function_call_output items the bridge returned, as {call_id, output}. */
    toolOutputs: [],
    /** response.create requests. */
    responseCreates: 0,
    /** Whether the socket ever opened and whether it is open now. */
    opened: 0,
    closed: 0,
  };

  let socket = null;
  let phase = 0;
  let responseSeq = 0;
  const waiters = [];
  /**
   * Wake every waiter ONCE per notification.
   *
   * The drain takes the whole list first. Written as `while (waiters.length > 0) waiters.shift()()`
   * it never ends: a predicate that is still false re-registers itself, the loop sees a non-empty
   * list again, and the event loop is held for the whole of waitFor's timeout. MEASURED at
   * integration on this Mac: the browser leg waits up to 130 s for a real reply off the local box, and
   * that spin blocked the gate's own socket reads until the backlog of forwarded audio exhausted the
   * heap -- "Reached heap limit" inside the websocket parser, which reads as a leak in the bridge
   * rather than a busy-wait in the harness. Splicing first is what makes a false predicate cost one
   * call per notification instead of an infinite number.
   */
  const notify = () => { for (const waiter of waiters.splice(0, waiters.length)) waiter(); };

  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", handleProtocols: () => false });

  // A real provider answers 401 to a dial with no credential, and the bridge must never be able to
  // pass its tests by dialing without one.
  wss.on("headers", (lines, req) => {
    events.requests.push({
      url: String(req.url ?? ""),
      auth: String(req.headers.authorization ?? ""),
      subprotocol: String(req.headers["sec-websocket-protocol"] ?? ""),
      // OpenAI's GA realtime must NOT be sent the legacy `OpenAI-Beta: realtime=v1` header, so the
      // absence of it is a thing a test asserts rather than assumes.
      beta: String(req.headers["openai-beta"] ?? ""),
    });
  });
  wss.shouldHandle = (req) => {
    if (!requireAuth) return true;
    const auth = String(req.headers.authorization ?? "");
    if (/^Bearer\s+\S/i.test(auth)) return true;
    events.refusals.push({ code: "invalid_api_key", message: "no Authorization header" });
    events.requests.push({ url: String(req.url ?? ""), auth, subprotocol: "", refused: true });
    return false;
  };

  const send = (object) => { if (socket != null && socket.readyState === 1) socket.send(JSON.stringify(object)); };
  const fail = (code, message) => { events.refusals.push({ code, message }); send({ type: "error", error: { type: "invalid_request_error", code, message } }); };

  wss.on("connection", (ws) => {
    socket = ws;
    events.opened += 1;
    notify();
    ws.on("close", () => { events.closed += 1; if (socket === ws) socket = null; notify(); });
    ws.on("message", (raw) => {
      const event = jsonOf(raw);
      if (event == null) return;
      const type = String(event.type ?? "");
      // Everything EXCEPT audio, which is counted below rather than kept. A minute of microphone is
      // six hundred frames of base64 and holding them all is an unbounded hold for no assertion: the
      // only reader of this list prints a slice of it in a failure message.
      if (type !== "input_audio_buffer.append") events.inbound.push(event);
      if (type === "session.update") {
        const bad = checkSession(vendor, event.session);
        if (bad != null) return fail(bad.code, bad.message);
        events.sessions.push(event.session);
        send({ type: "session.updated", session: event.session });
        notify();
        return;
      }
      if (type === "input_audio_buffer.append") {
        const bytes = Buffer.from(String(event.audio ?? ""), "base64");
        events.appendFrames += 1;
        events.appendBytes += bytes.byteLength;
        // Every byte zero is the silence a release sends. A frame of real room tone is not: the
        // console's own capture writes what the microphone gave it, sample for sample.
        if (bytes.byteLength > 0 && bytes.every((byte) => byte === 0)) {
          events.silentFrames += 1;
          events.trailingSilentFrames += 1;
        } else {
          events.trailingSilentFrames = 0;
        }
        notify();
        return;
      }
      if (type === "conversation.item.create") {
        const item = event.item ?? {};
        if (item.type === "function_call_output") {
          events.toolOutputs.push({ call_id: String(item.call_id ?? ""), output: String(item.output ?? "") });
        } else {
          // xAI bills one flat fee per text item we create. Counting them is what lets a test
          // prove the bridge does not chat Titan's reply back in at $0.004 a sentence.
          events.billableItems += 1;
        }
        notify();
        return;
      }
      if (type === "response.create") {
        events.responseCreates += 1;
        notify();
        void speak();
        return;
      }
      if (type === "response.cancel") {
        // A cancel race is the normal case, not an error: nothing is in flight here.
        send({ type: "error", error: { type: "invalid_request_error", code: "response_cancel_not_active", message: "Cancellation failed: no active response found" } });
        return;
      }
      if (type === "input_audio_buffer.commit" || type === "session.close") return;
    });
  });

  /** One spoken reply: a transcript, then tone audio in 100 ms frames, then the two dones. */
  async function speak(text = "All right.") {
    responseSeq += 1;
    const responseId = `resp_${responseSeq}`;
    send({ type: "response.created", response: { id: responseId } });
    send({ type: "response.output_audio_transcript.delta", response_id: responseId, delta: text });
    for (let i = 0; i < audioFrames; i += 1) {
      const frame = toneFrame(toneHz, STUB_FRAME_BYTES, STUB_RATE, phase);
      phase += STUB_FRAME_BYTES / 2;
      send({ type: "response.output_audio.delta", response_id: responseId, delta: frame.toString("base64") });
    }
    send({ type: "response.output_audio.done", response_id: responseId });
    if (vendor === "openai") emitRateLimits();
    send({ type: "response.done", response: { id: responseId, status: "completed", output: [] } });
    notify();
  }

  /**
   * Emit one tool call. With `triple` it arrives on all three surfaces a realtime provider can put
   * it on, carrying ONE call_id -- which is the dedupe the bridge has to survive, and is xAI's real
   * behaviour rather than a hypothetical.
   */
  function emitToolCall({ name = "titan", args = {}, callId = `call_${Date.now().toString(36)}`, triple = true } = {}) {
    const argumentsJson = typeof args === "string" ? args : JSON.stringify(args);
    const item = { id: `item_${callId}`, type: "function_call", name, call_id: callId, arguments: argumentsJson };
    send({ type: "response.function_call_arguments.done", call_id: callId, name, arguments: argumentsJson, item_id: item.id });
    if (triple) {
      send({ type: "response.output_item.done", item });
      send({ type: "response.done", response: { id: `resp_tool_${callId}`, status: "completed", output: [item] } });
    }
    return callId;
  }

  /**
   * The caption of what the person said, as ONE step or as a whole sequence.
   *
   * Cumulative on xAI, incremental on OpenAI, and the caller writes the same thing either way: the
   * CUMULATIVE transcript at each step. That is the only shape a caller can express once, because
   * the two vendors disagree about what a step is -- xAI's `.updated` carries the whole utterance so
   * far and its own reference says it "may have corrections to previous updated transcripts -- this
   * is different from a transcript delta", while OpenAI's `.delta` carries only newly available text.
   *
   * So on OpenAI each step is sent as the SUFFIX it added, and a step that is not an extension of the
   * one before it throws here rather than going out: an incremental wire cannot un-say a delta, and a
   * stub that pretended otherwise would let a bridge pass against a shape OpenAI never sends. Drive
   * corrections against the xAI stub, which is where they really happen.
   *
   * The one-argument form is unchanged, so tests written against the frozen contract do not move.
   *
   * @param {string|string[]} steps   the cumulative transcript at each step.
   * @param {object} [options]
   * @param {string} [options.itemId] the item these belong to; a new one is a new utterance.
   * @param {number} [options.gapMs]  how long to wait between steps, so a page can be watched.
   */
  async function emitUserTranscript(steps, { itemId = "item_user", gapMs = 0 } = {}) {
    const list = (Array.isArray(steps) ? steps : [steps]).map((step) => String(step ?? ""));
    let sent = "";
    for (let i = 0; i < list.length; i += 1) {
      const whole = list[i];
      if (i > 0 && gapMs > 0) await new Promise((resolve) => { const timer = setTimeout(resolve, gapMs); timer.unref?.(); });
      if (vendor === "xai") {
        send({ type: "conversation.item.input_audio_transcription.updated", item_id: itemId, transcript: whole, delta: whole });
      } else {
        if (!whole.startsWith(sent)) {
          throw new Error(`the incremental vendor cannot un-say a delta: step ${i} "${whole}" does not extend "${sent}"`);
        }
        send({ type: "conversation.item.input_audio_transcription.delta", item_id: itemId, delta: whole.slice(sent.length) });
      }
      sent = whole;
    }
    return list.at(-1) ?? "";
  }
  function emitUserTranscriptDone(text, { itemId = "item_user" } = {}) {
    send({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: text });
  }
  /**
   * The transcription that never finished. Both vendors document this event and until 2026-09-10 the
   * bridge handled it nowhere, which is how one utterance came to bleed into the next.
   */
  function emitTranscriptFailed({ itemId = "item_user", message = "audio was too short to transcribe" } = {}) {
    send({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: itemId,
      error: { type: "invalid_request_error", code: "audio_unintelligible", message },
    });
  }
  /**
   * The same event under the name the overlay's own legs call it. One implementation, two names: both
   * halves of this wave were written against their own stub and renaming either one's calls would be
   * editing tests to fit a merge.
   */
  const emitUserTranscriptFailed = ({ itemId = "item_user", code = "transcription_failed" } = {}) =>
    emitTranscriptFailed({ itemId, message: code === "transcription_failed" ? "the audio could not be transcribed" : code });
  /**
   * The two halves of a turn, separately. `emitSpeechStopped` below sends BOTH and is what the
   * VOICE-1 leg drives; a leg that wants to put words between the start and the stop needs them
   * apart, and calling the pair version twice would start a second user turn and reset the
   * transcript the panel is in the middle of showing.
   */
  function emitSpeechStart() { send({ type: "input_audio_buffer.speech_started" }); }
  function emitSpeechStop() { send({ type: "input_audio_buffer.speech_stopped" }); }

  /** xAI emits no rate_limits.updated at all, which is why this is a no-op there. */
  function emitRateLimits({ remaining = 38000, resetSeconds = 42 } = {}) {
    if (vendor !== "openai") return false;
    send({ type: "rate_limits.updated", rate_limits: [{ name: "tokens", limit: 40000, remaining, reset_seconds: resetSeconds }] });
    return true;
  }

  /** A rate-limited response, whose wait is only ever named in free text. */
  function emitRateLimited({ seconds = 1 } = {}) {
    send({
      type: "response.done",
      response: {
        id: `resp_rl_${Date.now().toString(36)}`,
        status: "failed",
        status_details: { type: "failed", error: { type: "rate_limit_exceeded", code: "rate_limit_exceeded", message: `Rate limit reached. Please try again in ${seconds}s.` } },
        output: [],
      },
    });
  }

  function emitSpeechStopped() {
    send({ type: "input_audio_buffer.speech_started" });
    send({ type: "input_audio_buffer.speech_stopped" });
  }
  /** The start of an utterance on its own, so a test can drive two utterances that never completed. */
  function emitSpeechStarted({ itemId = "item_user" } = {}) {
    send({ type: "input_audio_buffer.speech_started", item_id: itemId });
  }

  /** Resolve once `predicate(events)` holds, or throw after `timeoutMs`. */
  function waitFor(predicate, { timeoutMs = 5000, label = "a stub condition" } = {}) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      // The 20 ms re-tick below is the poll, so a condition that goes true with no further message
      // arriving still resolves and a predicate that never matches still times out here rather than in
      // the caller. One poll is enough; a second interval beside it only leaks a timer per wait.
      const tick = () => {
        let ok = false;
        try { ok = predicate(events) === true; } catch { ok = false; }
        if (ok) return resolve(events);
        if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
        waiters.push(tick);
        setTimeout(() => { const i = waiters.indexOf(tick); if (i >= 0) { waiters.splice(i, 1); tick(); } }, 20);
      };
      tick();
    });
  }

  await new Promise((resolve) => (wss.address() != null ? resolve() : wss.once("listening", resolve)));
  const port = wss.address().port;

  return {
    vendor,
    port,
    url: `ws://127.0.0.1:${port}/v1/realtime`,
    events,
    emitToolCall,
    emitUserTranscript,
    emitUserTranscriptDone,
    emitTranscriptFailed,
    emitUserTranscriptFailed,
    emitSpeechStarted,
    emitSpeechStart,
    emitSpeechStop,
    emitRateLimits,
    emitRateLimited,
    emitSpeechStopped,
    speak,
    waitFor,
    /** The accept value a browser would compute, exported so a frame test can share one helper. */
    accept: (key) => createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64"),
    close: () => new Promise((resolve) => {
      try { socket?.close(); } catch { /* already gone */ }
      wss.close(() => resolve());
      for (const client of wss.clients) { try { client.terminate(); } catch { /* gone */ } }
    }),
  };
}
