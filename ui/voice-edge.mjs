/**
 * VOICE-1. The relay's half of talking to Titan out loud.
 *
 * WHAT THIS IS. One websocket from the browser to this relay (the console's own cookie is the
 * credential; the tenant is stamped here and never sent by the page), one websocket from here to a
 * realtime provider with the workspace's own key, and between them ONE tool: titan(message). The
 * realtime model is a mouth and a pair of ears. It does not search, it does not remember, it does
 * not decide anything; it hands what it heard to Titan through the gateway the console already
 * uses and speaks back what Titan said. Memory, persona, the team and every approval stay Titan's,
 * and the thread stays one thread, because a spoken turn is an ordinary prompt carrying a
 * `voice:` clientNonce.
 *
 * WHY THE RELAY HOLDS THE SOCKET. Both vendors ship a browser path that is easier to build -- xAI
 * an `xai-client-secret.<token>` subprotocol, OpenAI client secrets and WebRTC, which OpenAI
 * actively recommends for browsers. Both were REFUSED ON PURPOSE: each puts a real credential in
 * the browser, bypasses the minutes ledger, and makes the day cap unenforceable. The relay holding
 * the socket and counting the seconds is the entire reason this bridge exists. The cost is that we
 * own jitter and playback, and docs/VOICE.md says so out loud.
 *
 * NO IMPORTS OUTSIDE NODE BUILTINS. This process has no node_modules at all -- ui/server.mjs:2941
 * says so for the VNC socket and it is just as true here -- so the RFC 6455 codec below is written
 * rather than required. `ws` appears only in tests/helpers/stub-realtime.mjs, which runs under the
 * test runner and never in the relay.
 *
 * THE THREE THINGS NOT TO BELIEVE FROM THE BRIEF, each measured instead:
 *   1. The two vendors do NOT speak one wire. xAI takes a FLAT session (top-level `voice` and
 *      `turn_detection`, no `session.type`); OpenAI's GA refuses exactly that and wants
 *      `session.type:"realtime"` with the voice at `audio.output.voice` and NO OpenAI-Beta header.
 *      One transport, TWO session builders, one event-name map.
 *   2. Titan's reply does NOT stream. Measured on grok-bot-local-vm: it lands as ONE complete
 *      `send-message` entry 5.5 to 25 s after sendPrompt (50.6 s on a cold box), with no partial
 *      text and no in-place growth -- the host drops the SendMessage tool call from every gateway
 *      surface. So titan() is a WAIT-THEN-SPLIT seam: the model's own acknowledgement carries the
 *      real silence, and the finished reply is split into sentences here. Nothing in this file,
 *      its copy or its doc claims streaming. True sentence streaming is one host-side projection
 *      and is filed as VOICE-3.
 *   3. The key does NOT come from the super-admin Providers panel. That panel is global, its keys
 *      live at LiteLLM as credentials and read back masked, and there is no per-workspace provider
 *      row at all. The realtime key is a PER-WORKSPACE secret in the tenant's own voice.json,
 *      written through the ordinary console session and never readable back -- mail's door, which
 *      already works in production -- and it reaches the vendor as an Authorization HEADER only.
 *
 * THE SILENT-SOCKET RULE, which the whole refusal path is built around. Measured: an unknown
 * upgrade path answers zero bytes with no status line, and real Chrome reports only `onerror` at
 * 16 ms with no close code -- indistinguishable from the relay being down, which is the
 * void-answer failure this console has already been burned by. So EVERY voice refusal (no key, day
 * cap, session cap, bad origin, no agent, provider refused) is: accept the upgrade, send one `note`
 * frame carrying one plain sentence, send `bye`, close 1000. A refusal is words, never a destroyed
 * socket, and never names a vendor.
 */
import { createHash } from "node:crypto";
import { appendFile, chmod, chown, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// ---- the RFC 6455 codec (A1) --------------------------------------------------------------------
//
// Nothing in this tree did server-side websocket framing before: the VNC route pipes raw bytes to
// websockify and never parses a frame, and the magic GUID appears nowhere in ui/, cp/, scripts/ or
// tests/. So these are exported as pure functions over buffers, because a framing bug here is a
// wedged socket carrying a live microphone and the only way to be sure is to drive crafted bytes
// through them from a test.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** The handshake answer's Sec-WebSocket-Accept. The RFC's own example is one of the frame tests. */
export function wsAccept(key) {
  return createHash("sha1").update(`${String(key ?? "")}${WS_GUID}`).digest("base64");
}

/** A browser's key is 16 random bytes in base64, and nothing else is accepted. */
export const WS_KEY_SHAPE = /^[A-Za-z0-9+/]{21,22}={0,2}$/;

/**
 * The 101 this server writes by hand.
 *
 * permessage-deflate is DECLINED by saying nothing about it: an extension offered and not
 * acknowledged is not in force, and a compressed frame this codec did not expect would be
 * indistinguishable from a framing bug. Audio is already PCM and compresses to nothing worth the
 * risk. No subprotocol is echoed either -- the browser asks for none, and a provider key must never
 * travel as one.
 */
export function handshakeResponse(key) {
  return `${[
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${wsAccept(key)}`,
  ].join("\r\n")}\r\n\r\n`;
}

/** A cap on one message, so a hostile or broken peer cannot make this process buffer the box. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export class VoiceFrameError extends Error {
  constructor(message, code = 1002) { super(message); this.name = "VoiceFrameError"; this.code = code; }
}

/**
 * Decode whole frames out of whatever bytes have arrived, and hand back the tail that is not a
 * whole frame yet. Stateless on purpose: a frame split across two TCP reads is the normal case, so
 * the caller keeps `rest` and prepends it to the next chunk. Masking is undone here because every
 * frame a browser sends is masked, and a server that forgot would read noise.
 *
 * Continuation frames are returned AS FRAMES (fin tells you which is the last). Reassembly is
 * FrameReader's job below, because it is the stateful half.
 */
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    // RSV bits set means an extension is in force. This handshake declines every extension, so a
    // set bit is either a bug or a peer that ignored the answer; both are a protocol error and not
    // something to guess at.
    if (rsv !== 0) throw new VoiceFrameError("a frame arrived with an extension bit set, and this socket negotiated none");
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      const big = buf.readBigUInt64BE(p);
      if (big > BigInt(MAX_MESSAGE_BYTES)) throw new VoiceFrameError("a frame longer than this bridge will ever accept", 1009);
      len = Number(big);
      p += 8;
    }
    if (len > MAX_MESSAGE_BYTES) throw new VoiceFrameError("a frame longer than this bridge will ever accept", 1009);
    let mask = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask != null) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    frames.push({ fin, opcode, masked, payload });
    off = p + len;
  }
  return { frames, rest: off === 0 ? Buffer.from(buf) : Buffer.from(buf.subarray(off)) };
}

/** One frame out, unmasked, which is what a server sends. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const head = body.length < 126 ? Buffer.alloc(2) : body.length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | (opcode & 0x0f);
  if (body.length < 126) head[1] = body.length;
  else if (body.length < 65536) { head[1] = 126; head.writeUInt16BE(body.length, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([head, body]);
}

/**
 * A close frame carrying a code AND a reason, because the page reads `event.reason`. A close with
 * no reason is the same void answer as a destroyed socket as far as the person is concerned.
 */
export function encodeClose(code = 1000, reason = "") {
  const text = Buffer.from(String(reason).slice(0, 120), "utf8");
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  return encodeFrame(OPCODE.close, body);
}

export function decodeClose(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 2) return { code: 1005, reason: "" };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString("utf8") };
}

/**
 * The stateful half: bytes in, whole messages out. It holds the partial frame across TCP reads and
 * the continuation run across frames, which are the two things audio will definitely do.
 */
export class FrameReader {
  constructor({ maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
    this.rest = Buffer.alloc(0);
    this.maxMessageBytes = maxMessageBytes;
    this.fragments = [];
    this.fragmentOpcode = null;
    this.fragmentBytes = 0;
  }

  /** @returns {Array<{opcode:number,payload:Buffer}>} complete messages and control frames. */
  push(chunk) {
    const { frames, rest } = decodeFrames(Buffer.concat([this.rest, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]));
    this.rest = rest;
    const out = [];
    for (const frame of frames) {
      // A control frame is never fragmented and may arrive in the middle of a fragmented message,
      // so it is passed straight through rather than folded into the run.
      if (frame.opcode === OPCODE.close || frame.opcode === OPCODE.ping || frame.opcode === OPCODE.pong) {
        out.push({ opcode: frame.opcode, payload: frame.payload });
        continue;
      }
      if (frame.opcode === OPCODE.continuation) {
        if (this.fragmentOpcode == null) throw new VoiceFrameError("a continuation frame arrived with nothing to continue");
        this.fragments.push(frame.payload);
        this.fragmentBytes += frame.payload.length;
      } else {
        if (this.fragmentOpcode != null) throw new VoiceFrameError("a new message started before the last one finished");
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
        this.fragmentBytes = frame.payload.length;
      }
      if (this.fragmentBytes > this.maxMessageBytes) throw new VoiceFrameError("a message longer than this bridge will ever accept", 1009);
      if (frame.fin) {
        out.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) });
        this.fragments = [];
        this.fragmentOpcode = null;
        this.fragmentBytes = 0;
      }
    }
    return out;
  }
}

// ---- the two wires (A2) -------------------------------------------------------------------------

/** 100 ms of 24 kHz mono PCM16. Both halves of this bridge and the browser all use this frame. */
export const FRAME_BYTES = 4800;
export const AUDIO_RATE = 24000;
/** How long after the last sample the microphone stays shut. omarchy's number, and it is right. */
export const ECHO_TAIL_MS = 350;

/**
 * The VAD thresholds, set deliberately rather than left to a default. A default silence window is
 * tuned for a phone call; a person thinking mid-sentence at a desk needs longer before the turn is
 * called over, and a threshold too low turns a keyboard into a turn.
 */
export const TURN_DETECTION = { type: "server_vad", threshold: 0.55, silence_duration_ms: 700, prefix_padding_ms: 300 };

/** The one tool. One string parameter, and nothing else is ever added to this array. */
export function titanTool() {
  return {
    type: "function",
    name: "titan",
    description:
      "Give what the person just said to Titan, the head of their team, and get his answer back. "
      + "Call this for EVERYTHING the person asks or tells you: questions, instructions, answers to "
      + "a question you read out, yes and no. You have no knowledge of your own about their work, "
      + "their team, their files or their machines -- he has all of it. While waiting, say one short "
      + "thing like \"on it\" so the line is not silent, then read his answer out as it comes back.",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "What the person said, in their own words." } },
      required: ["message"],
    },
  };
}

/**
 * The base instructions, written ONCE at session.update and byte-identical for the life of the
 * socket. Rewriting them invalidates the cached prefix and re-bills the whole conversation every
 * turn, which was the single most expensive thing omarchy's session did -- the same lesson as
 * m3-glm-prefix-cache.md. Nothing per-turn goes in here.
 */
export function voiceInstructions(agentName = "Titan") {
  return [
    `You are the voice of ${agentName}. You are his mouth and his ears and nothing else.`,
    "You have no memory, no tools and no knowledge of your own. Every single thing the person says",
    "goes to him through the titan function, including short answers like yes, no, that one, or go ahead.",
    "Never answer from your own knowledge, never guess, never make something up to fill a silence.",
    "He can take five to twenty-five seconds. Say one short natural thing while you wait and then",
    "read out exactly what comes back, in a normal speaking voice, without reading out punctuation,",
    "headings, file paths character by character, or anything that sounds like a screen being read.",
    "If he asks the person to confirm something, read it out as a plain question and send their",
    "answer straight back to him. If you get told something went wrong, say so plainly.",
    "Keep your own words short. You are a phone line, not a participant.",
  ].join(" ");
}

/**
 * The two vendors. Each has its own session builder because the two shapes are mutually
 * incompatible, not stylistically different: the other vendor's shape is REFUSED on the wire.
 */
export const VENDORS = {
  xai: {
    id: "xai",
    /**
     * What the Service dropdown on the Voice card says, and it is a BILLING SHAPE and not a
     * comparison. It said "the cheaper realtime service" until 2026-09-10, which is a price claim
     * docs/VOICE.md 7 states this product cannot make: one vendor publishes minutes and the other
     * publishes tokens, and converting one into the other and calling the answer cheaper is the
     * thing that document refuses to do. A person picking between two services can act on how they
     * are billed; they cannot act on our arithmetic.
     */
    label: "flat rate for each minute you talk",
    url: "wss://api.x.ai/v1/realtime",
    /**
     * PINNED, and the same string cp/voice.mjs REALTIME_VENDORS.xai.defaultModel carries, which
     * tests/cp-voice.test.mjs now asserts. It read `grok-voice-latest` until 2026-09-10 while the
     * authoritative table and the price in docs/VOICE.md 7 both named this one, so the model the
     * relay dialled was not the model the document priced. A moving alias is also the one way a
     * vendor can change what a minute costs without anything here changing.
     */
    model: "grok-voice-think-fast-2.0",
    voice: "eve",
    transcription: { mode: "cumulative", model: "grok-transcribe" },
    /** xAI emits neither conversation.item.done nor rate_limits.updated, so never wait on either. */
    emitsRateLimits: false,
    /** Every conversation.item.create is a flat billed fee except a function_call_output. */
    billsTextItems: true,
    buildSession({ instructions, voice, model: _model, tools }) {
      return {
        type: "session.update",
        session: {
          // FLAT. No session.type, no OpenAI-Beta header. AmpCortex drives exactly this today.
          voice,
          instructions,
          turn_detection: { ...TURN_DETECTION },
          audio: {
            input: { format: { type: "audio/pcm", rate: AUDIO_RATE }, transcription: { model: "grok-transcribe" } },
            output: { format: { type: "audio/pcm", rate: AUDIO_RATE } },
          },
          tools,
          tool_choice: "auto",
        },
      };
    },
  },
  openai: {
    id: "openai",
    /** The other billing shape, in words a person can act on and with no comparison in it either. */
    label: "charged by how much is said, not by the minute",
    url: "wss://api.openai.com/v1/realtime",
    model: "gpt-realtime-2.1",
    voice: "marin",
    transcription: { mode: "incremental", model: "gpt-4o-mini-transcribe" },
    emitsRateLimits: true,
    billsTextItems: false,
    buildSession({ instructions, voice, model: _model, tools }) {
      return {
        type: "session.update",
        session: {
          // GA. `type` is required, the voice lives under audio.output, turn detection lives under
          // audio.input, and the legacy `OpenAI-Beta: realtime=v1` header MUST NOT be sent.
          type: "realtime",
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: AUDIO_RATE },
              // A belt beside the mic gate: xAI documents no equivalent, so on xAI the gate is the
              // only defence and this is the one place the two vendors differ in our favour.
              turn_detection: { ...TURN_DETECTION, interrupt_response: false },
              transcription: { model: "gpt-4o-mini-transcribe" },
            },
            output: { format: { type: "audio/pcm", rate: AUDIO_RATE }, voice },
          },
          instructions,
          tools,
          tool_choice: "auto",
        },
      };
    },
  },
};

export const VENDOR_IDS = Object.keys(VENDORS);
export const DEFAULT_VENDOR = "xai";
export const vendorOf = (id) => VENDORS[String(id ?? "").trim()] ?? VENDORS[DEFAULT_VENDOR];

/** The session.update for a vendor, built from that vendor's own rules. */
export function buildSession(vendorId, { instructions, voice, model, tools } = {}) {
  const vendor = vendorOf(vendorId);
  return vendor.buildSession({
    instructions: typeof instructions === "string" && instructions.length > 0 ? instructions : voiceInstructions(),
    voice: typeof voice === "string" && voice.length > 0 ? voice : vendor.voice,
    model: typeof model === "string" && model.length > 0 ? model : vendor.model,
    tools: Array.isArray(tools) ? tools : [titanTool()],
  });
}

/** The dial URL. The key is NEVER in it, which a test sweeps for on the stub's own request log. */
export function dialUrl(vendorId, { model, url } = {}) {
  const vendor = vendorOf(vendorId);
  const base = typeof url === "string" && url.length > 0 ? url : vendor.url;
  const chosen = typeof model === "string" && model.length > 0 ? model : vendor.model;
  return `${base}${base.includes("?") ? "&" : "?"}model=${encodeURIComponent(chosen)}`;
}

/** Header form only. Never a URL, never a subprotocol -- proxies log both. */
export function dialHeaders(_vendorId, apiKey) {
  return { authorization: `Bearer ${String(apiKey ?? "")}` };
}

/**
 * GA event names are what this bridge emits and reads; the legacy names are accepted inbound as
 * aliases, because a provider mid-migration will send either and a bridge that only knew one set
 * would go deaf halfway through somebody's sentence.
 */
const INBOUND_ALIASES = new Map([
  ["response.audio.delta", "response.output_audio.delta"],
  ["response.audio.done", "response.output_audio.done"],
  ["response.audio_transcript.delta", "response.output_audio_transcript.delta"],
  ["response.audio_transcript.done", "response.output_audio_transcript.done"],
  ["response.text.delta", "response.output_text.delta"],
  ["response.text.done", "response.output_text.done"],
]);
export const canonicalEvent = (type) => INBOUND_ALIASES.get(String(type ?? "")) ?? String(type ?? "");

/**
 * What the person said, normalised to REPLACE-WHOLE on both vendors.
 *
 * This is not tidiness. xAI's `conversation.item.input_audio_transcription.updated` is CUMULATIVE
 * with corrections -- each event carries the whole utterance so far -- and OpenAI's `.delta` is
 * incremental. Appending the delta on xAI writes the sentence N times, which is what the console
 * would then draw.
 *
 * IT ALSO KEEPS THE ITEM ID, and a new one RESETS the accumulator. MEASURED on this Mac (node
 * v22.23.1, 2026-09-10) before that existed: on the incremental path an utterance whose `.completed`
 * never arrives -- a `.failed`, a dropped event, two utterances close together -- bleeds into the
 * next one, so "open the box" then "what time is it" reads "open the boxwhat time is it". A one-line
 * strip hid that; VOICE-7 puts these words in a panel over the conversation where it is unmissable.
 * OpenAI's own transcription guide says to reconcile finals on `item_id` for exactly this reason,
 * and it does not guarantee ordering between two turns' `.completed` events.
 */
export function makeCaption(mode = "cumulative") {
  let text = "";
  let itemId = "";
  /** A transcription event for a DIFFERENT item is a different utterance, so start it empty. */
  const seat = (event) => {
    const id = String(event?.item_id ?? "");
    if (id.length === 0) return;
    if (id !== itemId) text = "";
    itemId = id;
  };
  return {
    apply(event) {
      seat(event);
      const whole = typeof event?.transcript === "string" ? event.transcript : null;
      const delta = typeof event?.delta === "string" ? event.delta : "";
      if (mode === "cumulative") text = whole != null && whole.length > 0 ? whole : (delta.length > 0 ? delta : text);
      else if (whole != null) text = whole;
      else text += delta;
      return text;
    },
    complete(event) {
      seat(event);
      const whole = typeof event?.transcript === "string" ? event.transcript : null;
      if (whole != null && whole.length > 0) text = whole;
      return text;
    },
    get value() { return text; },
    get itemId() { return itemId; },
    reset() { text = ""; itemId = ""; },
  };
}

/**
 * One call_id is dispatched ONCE, whichever of the three surfaces it arrives on first. xAI really
 * does emit the same call on all three, and dispatching twice would send the same sentence into
 * Titan's conversation twice.
 */
export function makeCallDedupe() {
  const seen = new Set();
  return {
    /** @returns {boolean} true the first time this call_id is offered and never again. */
    claim(callId) {
      const id = String(callId ?? "");
      if (id.length === 0 || seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    has: (callId) => seen.has(String(callId ?? "")),
    get size() { return seen.size; },
  };
}

/** Every surface a function call can arrive on, read into one shape. */
export function toolCallsOf(event) {
  const type = canonicalEvent(event?.type);
  const out = [];
  const push = (callId, name, args) => {
    if (String(callId ?? "").length === 0) return;
    out.push({ callId: String(callId), name: String(name ?? ""), argumentsJson: typeof args === "string" ? args : JSON.stringify(args ?? {}) });
  };
  if (type === "response.function_call_arguments.done") push(event.call_id, event.name, event.arguments);
  if (type === "response.output_item.done" && event?.item?.type === "function_call") push(event.item.call_id, event.item.name, event.item.arguments);
  if (type === "response.done" && Array.isArray(event?.response?.output)) {
    for (const item of event.response.output) if (item?.type === "function_call") push(item.call_id, item.name, item.arguments);
  }
  return out;
}

/** A `failed` response carrying a rate limit, and the wait the server only ever names in prose. */
export function rateLimitOf(event) {
  if (canonicalEvent(event?.type) !== "response.done") return null;
  const response = event?.response ?? {};
  if (String(response.status ?? "") !== "failed") return null;
  const error = response.status_details?.error ?? response.status_details ?? {};
  const code = String(error.code ?? error.type ?? "");
  if (!code.includes("rate_limit")) return null;
  const message = String(error.message ?? "");
  const seconds = Number(/try again in ([\d.]+)\s*(ms|s|seconds|milliseconds)?/i.exec(message)?.[1] ?? 0);
  const unit = /try again in [\d.]+\s*(ms|milliseconds)/i.test(message) ? "ms" : "s";
  const waitMs = seconds > 0 ? Math.min(unit === "ms" ? seconds : seconds * 1000, 30000) : 1000;
  return { message, waitMs };
}

/**
 * A provider complaint that is a NOTE and not an error. A cancel race and a vanished item are the
 * normal shape of a conversation someone is talking over; colouring the orb for them would be
 * host-notes-read-as-errors.md happening in someone else's codebase.
 */
const QUIET_PROVIDER_CODES = new Set(["response_cancel_not_active", "item_not_found", "conversation_already_has_active_response"]);
export const providerErrorIsQuiet = (event) => QUIET_PROVIDER_CODES.has(String(event?.error?.code ?? ""));

// ---- the echo gate, server side (A4) ------------------------------------------------------------
//
// The gate lives on BOTH sides: the browser holds capture so nothing is even sent, and this drops
// anything that arrives inside the same window anyway -- so a patched page cannot make the model
// hear itself, and the held count is a server-side number a unit test asserts with no browser in
// the room. The reference this wave was handed does NOT do this: omarchy has ECHO_TAIL_SECONDS,
// Speaker.is_playing(tail) and _held_frames, and `input_audio_buffer.append` (realtime.py:653)
// fires for every frame unconditionally -- `.is_playing(` has zero call sites and `_held_frames` is
// never incremented. So this is written here and its test asserts frames were DROPPED.

export function makeEchoGate({ tailMs = ECHO_TAIL_MS, rate = AUDIO_RATE, now = () => Date.now() } = {}) {
  let playsUntil = 0;
  let heldFrames = 0;
  let heldMs = 0;
  return {
    /**
     * Book the time this audio will take to come out of a speaker, FROM ITS BYTES. Never from "is
     * the queue empty": the model sends a reply far faster than it is spoken, so an empty queue
     * means the bytes were handed over, not that the room is quiet (realtime.py:278-282).
     */
    book(bytes) {
      const ms = (Number(bytes) || 0) / (rate * 2) * 1000;
      playsUntil = Math.max(playsUntil, now()) + ms;
      return playsUntil;
    },
    /** Sound is still in the room, or was within the tail. */
    holding() { return now() < playsUntil + tailMs; },
    /** @returns {boolean} whether this browser frame may go to the provider. */
    admit(bytes) {
      if (!this.holding()) return true;
      heldFrames += 1;
      heldMs += (Number(bytes) || 0) / (rate * 2) * 1000;
      return false;
    },
    /** The person toggled off, or the reply was cancelled: the room is quiet now. */
    release() { playsUntil = 0; },
    get playsUntilMs() { return playsUntil; },
    get heldFrames() { return heldFrames; },
    get heldMs() { return Math.round(heldMs); },
  };
}

// ---- sentences ----------------------------------------------------------------------------------

/**
 * Titan's finished reply, split so speech starts on the first sentence rather than the whole wall.
 * A fenced block, a path or a table read out character by character is unlistenable, so anything
 * that is plainly not speech is named rather than spoken.
 */
export function splitSentences(text, { max = 320 } = {}) {
  const clean = String(text ?? "")
    // A fenced block is not speech. Saying so is better than reading three backticks out loud.
    .replace(/```[\s\S]*?```/g, " (there is a block of code or output in the message on screen) ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (clean.length === 0) return [];
  const pieces = [];
  for (const line of clean.split(/\n{2,}/)) {
    for (const raw of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)) {
      let piece = raw.replace(/\n+/g, " ").trim();
      if (piece.length === 0) continue;
      while (piece.length > max) {
        const cut = piece.lastIndexOf(" ", max);
        pieces.push(piece.slice(0, cut > 40 ? cut : max).trim());
        piece = piece.slice(cut > 40 ? cut : max).trim();
      }
      if (piece.length > 0) pieces.push(piece);
    }
  }
  return pieces;
}

// ---- the settings door: voice.json --------------------------------------------------------------
//
// Custody, decided: the realtime key is a PER-WORKSPACE secret in the tenant's own state file,
// written through the ordinary console session and never readable back. That is mail's door
// (ui/mail-edge.mjs), which already works in production, and it is the only door in this wave that
// touches a secret. The super-admin Providers panel is global and its keys read back masked; there
// is no per-workspace provider row to put this on.

const asString = (value) => (typeof value === "string" ? value.trim() : "");

export function normalizeVoiceSettings(raw) {
  const value = raw == null || typeof raw !== "object" ? {} : raw;
  const vendor = VENDORS[asString(value.vendor)] != null ? asString(value.vendor) : DEFAULT_VENDOR;
  return {
    enabled: value.enabled === true,
    vendor,
    model: asString(value.model),
    voice: asString(value.voice),
    /** Which agent the voice talks to. Empty means "work it out", and the relay prints which. */
    agentId: asString(value.agentId),
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
  };
}

export const VOICE_DEFAULTS = normalizeVoiceSettings({});

export async function readVoiceSettings(file) {
  try { return normalizeVoiceSettings(JSON.parse(await readFile(file, "utf8"))); }
  catch { return { ...VOICE_DEFAULTS }; }
}

/** Written the way ui/mail-edge.mjs writes its own: 0600, owned like the parent, renamed over. */
export async function writeVoiceSettings(next, { file, ownLikeParent = null } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(normalizeVoiceSettings(next), null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  if (ownLikeParent != null) await ownLikeParent(tmp);
  else { try { const parent = await stat(path.dirname(file)); await chown(tmp, parent.uid, parent.gid); } catch { /* not ours to own */ } }
  await rename(tmp, file);
}

/**
 * The console's partial update. Everything but the key is replaced when present; the key is SET
 * when a string, CLEARED when null, and KEPT when the field is absent -- which is what lets the
 * Voice card save the vendor or the agent without ever holding a key it never received.
 */
export function mergeVoiceSettings(current, patch) {
  const base = normalizeVoiceSettings(current);
  const value = patch == null || typeof patch !== "object" ? {} : patch;
  const next = { ...base };
  if (typeof value.enabled === "boolean") next.enabled = value.enabled;
  if (typeof value.vendor === "string" && VENDORS[value.vendor.trim()] != null) next.vendor = value.vendor.trim();
  if (typeof value.model === "string") next.model = value.model;
  if (typeof value.voice === "string") next.voice = value.voice;
  if (typeof value.agentId === "string") next.agentId = value.agentId;
  if (typeof value.apiKey === "string") next.apiKey = value.apiKey.trim();
  else if (value.apiKey === null) next.apiKey = "";
  return normalizeVoiceSettings(next);
}

/**
 * What GET and POST /voice/settings both answer. The key is a BOOLEAN and never a value: this
 * shape is the only thing either route returns, so there is no route on this server that can read
 * a realtime key back out once it is set. cp/PROVIDERS-ROUTES.md 5 is the rule and this honours it.
 */
export function voiceSettingsShape(settings, { vendors = null, agents = [], sessionCapSeconds = 0, dayCapSeconds = 0, dayUsedSeconds = 0, recent = [] } = {}) {
  const value = normalizeVoiceSettings(settings);
  return {
    enabled: value.enabled,
    vendor: value.vendor,
    // EXACTLY WHAT THE WORKSPACE SET, and empty when it set nothing. These used to fall back to the
    // vendor's own default, and the Voice card writes the answer straight into two text inputs, so a
    // customer who had never touched either field read a vendor's product name back off their own
    // card. The relay already falls back to the vendor default when the field is empty, so an empty
    // string here is the whole of "use the service's own", and the card says that in a placeholder.
    model: value.model,
    voice: value.voice,
    agentId: value.agentId,
    apiKeySet: value.apiKey.length > 0,
    // `label` is what the Voice card puts in the Service dropdown -- ui/machine-room/voice.js reads
    // `one.label` and an absent one renders a row of empty options, which is a control a person
    // cannot use. The labels in VENDORS name no vendor on purpose; docs/VOICE.md names them.
    // No model and no voice name on these rows either: the page draws the label and nothing else,
    // and a vendor's model id on the wire to a customer's browser is one careless template away
    // from being on their screen.
    vendors: vendors ?? VENDOR_IDS.map((id) => ({ id, label: VENDORS[id].label })),
    agents,
    sessionCapSeconds,
    dayCapSeconds,
    dayUsedSeconds,
    dayRemainingSeconds: Math.max(0, dayCapSeconds - dayUsedSeconds),
    recent,
  };
}

// ---- caps and the ledger (A4) -------------------------------------------------------------------
//
// CLAIM BEFORE DIAL. The row is written when the session is authorised and BEFORE the provider
// socket opens. That is not a preference, it is the rule already written in this tree at the mail
// send routes (cp/server.mjs:1035-1039: "TWO ROUTES AND NOT ONE, because the claim happens BEFORE
// the mail goes and the outcome is only known after. An unsent mail is recoverable and an unlogged
// send is not"). A row written on close does not exist for a crashed relay or a tab closed
// mid-sentence, and the day cap is read from this same ledger -- so getting it backwards is
// unbounded spend, not a missing report.

export const SESSION_CAP_SECONDS = 30 * 60;
export const DAY_CAP_SECONDS = 120 * 60;
/** An honest ceiling over a measured 50.6 s cold start, not a guess at a typical turn. */
export const TURN_WAIT_CAP_S = 120;
export const TURN_POLL_MS = 400;
export const MAX_TITAN_ROUNDS = 2;
export const MAX_NUDGES = 2;
export const FIRST_NUDGE_MS = 20000;
/** Two announcements never closer than this, and never while a response is in flight. */
export const ANNOUNCE_GAP_MS = 8000;
/** How often the relay checks its own clock against the caps. */
export const CAP_TICK_MS = 10000;
/**
 * How long a dial may stay silent before the person is told. MEASURED on this Mac (node v22.23.1): a
 * failed upgrade fires `error` and NEVER `close`, and a black-holed address fires neither for at
 * least four seconds, so without this a wrong key left the microphone open and the orb listening
 * until the session cap ticked half an hour later. A real open on a healthy vendor is well inside
 * this; the number is a ceiling on silence and not a latency budget.
 */
export const DIAL_WATCHDOG_MS = 8000;
/**
 * How much audio a page may be ahead of the wall clock. The caps count WALL seconds, and a page can
 * push audio as fast as its uplink allows: MEASURED on this Mac, 3000 frames (14.4 MB, five minutes
 * of audio) reached the vendor in 0.15 s of wall clock, against which every cap on screen read
 * green. One frame is 100 ms, so three seconds of slack absorbs ordinary jitter and a tab coming
 * back from being backgrounded, and anything beyond it is a patched or broken page.
 */
export const AUDIO_LEAD_SECONDS = 3;

/**
 * One session's row. No transcript, no audio, no secret -- ui/mail-edge.mjs:513's rule for its own
 * ledger, and the same reason: this file is a spend record and the cap's own truth, not an archive
 * of what somebody said in their kitchen.
 *
 * BOTH meters are recorded and the Spend line says WHICH, because xAI bills audio sent-or-received
 * plus a flat per-event text fee while OpenAI bills audio tokens with the whole prefix re-read
 * every turn. One "minutes" column reconciles against neither invoice. The CAPS count WALL seconds,
 * the only number a person can predict, and docs/VOICE.md says so.
 */
export function voiceLedgerRow({
  sessionId, slug, agentId, agentName = "", vendor, model, startedAt, state = "open",
  endedAt = null, wallSeconds = 0, audioInSeconds = 0, audioOutSeconds = 0,
  billedItemEvents = 0, toolCalls = 0, heldFrames = 0, closeReason = "",
}) {
  return {
    sessionId: asString(sessionId),
    slug: asString(slug),
    agentId: asString(agentId),
    agentName: asString(agentName),
    vendor: asString(vendor),
    model: asString(model),
    startedAt: startedAt ?? new Date().toISOString(),
    state: state === "closed" ? "closed" : "open",
    endedAt,
    wallSeconds: Math.max(0, Math.round(Number(wallSeconds) || 0)),
    audioInSeconds: Math.max(0, Math.round(Number(audioInSeconds) || 0)),
    audioOutSeconds: Math.max(0, Math.round(Number(audioOutSeconds) || 0)),
    billedItemEvents: Math.max(0, Number(billedItemEvents) || 0),
    toolCalls: Math.max(0, Number(toolCalls) || 0),
    heldFrames: Math.max(0, Number(heldFrames) || 0),
    closeReason: asString(closeReason),
  };
}

export async function appendVoiceLedger(row, { file, ownLikeParent = null } = {}) {
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  await appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  if (ownLikeParent != null) await ownLikeParent(file).catch(() => {});
}

/**
 * The ledger read back, one row per session, newest last.
 *
 * The file is APPEND-ONLY and a session writes twice: the open claim before the dial, and the
 * settled row on close. They are folded here by sessionId, last write winning. Rewriting the first
 * line in place would mean a read-modify-write on the one file the cap is read from, and a relay
 * killed mid-rewrite would lose rows that were already spent.
 */
export async function readVoiceLedger(file) {
  let text = "";
  try { text = await readFile(file, "utf8"); } catch { return []; }
  const folded = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row = null;
    try { row = JSON.parse(trimmed); } catch { continue; }
    const id = asString(row?.sessionId);
    if (id.length === 0) continue;
    folded.set(id, { ...(folded.get(id) ?? {}), ...row });
  }
  return [...folded.values()];
}

/** Midnight UTC, which is what the day cap resets on and what the doc says it resets on. */
export const dayStartMs = (nowMs = Date.now()) => Date.UTC(
  new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate(),
);

/**
 * Wall seconds this workspace has spent today. An OPEN row counts at its CURRENT elapsed, not
 * zero: two tabs opened at once would otherwise each read the other as costing nothing, and the
 * cap would be per-tab rather than per-workspace.
 */
export function daySecondsUsed(rows, nowMs = Date.now(), { openCapSeconds = SESSION_CAP_SECONDS } = {}) {
  const start = dayStartMs(nowMs);
  const end = start + 86_400_000;
  let total = 0;
  for (const row of rows ?? []) {
    const startedMs = Date.parse(row?.startedAt ?? "");
    if (!Number.isFinite(startedMs)) continue;
    // A CLOSED row counts its whole wall clock against the day it STARTED on, which is the day an
    // operator reading the ledger looks for it under.
    if (row?.state === "closed") {
      if (startedMs < start) continue;
      total += Math.max(0, Number(row.wallSeconds) || 0);
      continue;
    }
    // AN OPEN ROW IS CLIPPED TO TODAY, whichever day it started on, which is the same window
    // cp/voice.mjs openSecondsInWindow clips to. A row dated yesterday was skipped outright here
    // until 2026-09-10, so a session started at 23:59:30 and still running at 00:05 counted against
    // NEITHER day: MEASURED on this Mac, 300 seconds of it inside today read as nought and the next
    // session was handed a whole fresh day. docs/VOICE.md 9 promises both halves count, and this is
    // the half that is the enforcement truth.
    const from = Math.max(startedMs, start);
    const to = Math.min(nowMs, end);
    // And still CLAMPED to the session cap, because a row is open for two reasons: the session is
    // running (and the relay's own tick will close it at the cap), or the relay died before it could
    // settle. Left unclamped the second case accrues for the rest of the day and silently eats a
    // workspace's whole allowance after one restart.
    total += Math.min(Math.max(0, Math.round((to - from) / 1000)), Math.max(0, openCapSeconds));
  }
  return total;
}

/**
 * The policy a workspace is under. Per-workspace overrides are NOT writable from the console -- a
 * customer raising their own cap is the bypass -- so they live in the control plane and are read
 * through the relay door behind CP_RELAY_TOKEN. Numbers and a vendor allowlist, never a secret.
 *
 * The constants are the fallback when cp is absent or unreachable, which is also the normal case on
 * grok-bot-local-vm, where there is no control plane at all.
 */
export function makeVoicePolicy({ relayBase = "", relayToken = "", fetchImpl = null, now = () => Date.now(), ttlMs = 60000, timeoutMs = 4000, log = () => {} } = {}) {
  const cache = new Map();
  const fallback = { sessionCapSeconds: SESSION_CAP_SECONDS, dayCapSeconds: DAY_CAP_SECONDS, vendors: VENDOR_IDS, openSessions: 0, source: "the relay's own constants" };
  return {
    async for(slug) {
      const key = String(slug ?? "");
      const held = cache.get(key);
      if (held != null && now() - held.at < ttlMs) return held.value;
      if (relayBase.length === 0 || relayToken.length === 0) {
        cache.set(key, { at: now(), value: fallback });
        return fallback;
      }
      const call = fetchImpl ?? fetch;
      const value = await call(`${relayBase}/v1/relay/voice/policy?slug=${encodeURIComponent(key)}`, {
        headers: { authorization: `Bearer ${relayToken}`, "user-agent": "titanbot-relay/voice" },
        signal: AbortSignal.timeout(timeoutMs),
      })
        .then((answer) => (answer.ok ? answer.json() : null))
        .then((body) => (body == null ? null : {
          sessionCapSeconds: Number(body.sessionCapSeconds) > 0 ? Math.round(Number(body.sessionCapSeconds)) : SESSION_CAP_SECONDS,
          dayCapSeconds: Number(body.dayCapSeconds) > 0 ? Math.round(Number(body.dayCapSeconds)) : DAY_CAP_SECONDS,
          vendors: Array.isArray(body.vendors) && body.vendors.length > 0 ? body.vendors.filter((id) => VENDORS[id] != null) : VENDOR_IDS,
          // How many rows the control plane still has OPEN for this workspace. cp/voice.mjs has
          // always computed it and this side dropped it on the floor. It is carried and LOGGED and
          // is deliberately NOT what refuses a second call: a row left open by a relay that died is
          // exactly this number, and refusing on it would lock a workspace out of voice over a
          // fault nobody can see. The live-session set in makeVoiceEdge is the one that refuses.
          openSessions: Number.isFinite(Number(body.openSessions)) ? Math.max(0, Math.round(Number(body.openSessions))) : 0,
          source: "the control plane",
        }))
        .catch((error) => { log(`voice policy for ${key} fell back to the constants: ${error?.message ?? error}`); return null; });
      const chosen = value ?? fallback;
      cache.set(key, { at: now(), value: chosen });
      return chosen;
    },
    /**
     * Best-effort and never awaited into a dial: a cp outage costs a Spend line, never a cap.
     *
     * TWO PATHS AND NOT ONE, which is the shape cp/server.mjs:1108 actually answers and the same
     * shape the mail send pair next to it takes: the claim happens BEFORE the provider socket opens
     * and the outcome is only known after. A single route taking a finished session would have no way
     * to claim before the dial, which is the rule the whole ledger rests on. Posting the whole row at
     * one path answered 404 and the operator's Spend line stayed empty while the minutes were really
     * being spent -- measured on this Mac at integration.
     *
     * A refusal here is LOGGED AND NOT OBEYED. The relay holds the caps on its own clock against its
     * own jsonl, which is the enforcement truth; this report is the operator's record. A cp that says
     * no to a session the relay already authorised is a number to reconcile, not a line to cut.
     */
    report(row) {
      if (relayBase.length === 0 || relayToken.length === 0) return Promise.resolve(false);
      const call = fetchImpl ?? fetch;
      const closing = row?.state === "closed";
      const body = closing
        ? {
          sessionId: row.sessionId, wallSeconds: row.wallSeconds, audioInSeconds: row.audioInSeconds,
          audioOutSeconds: row.audioOutSeconds, billedItemEvents: row.billedItemEvents,
          toolCalls: row.toolCalls, heldFrames: row.heldFrames, closeReason: row.closeReason,
        }
        : { slug: row.slug, sessionId: row.sessionId, agentId: row.agentId, vendor: row.vendor, model: row.model };
      return call(`${relayBase}/v1/relay/voice/usage/${closing ? "close" : "open"}`, {
        method: "POST",
        headers: { authorization: `Bearer ${relayToken}`, "content-type": "application/json", "user-agent": "titanbot-relay/voice" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }).then((answer) => {
        if (!answer.ok) log(`voice usage ${closing ? "close" : "open"} for ${row?.slug ?? "?"} answered HTTP ${answer.status}; the relay's own ledger is still the cap's truth`);
        return answer.ok;
      }).catch(() => false);
    },
  };
}

// ---- who Titan is (A3) --------------------------------------------------------------------------

/**
 * Resolved HERE, from the relay's authenticated session, and never from model input: a
 * model-supplied agent id would be a cross-tenant read through an open microphone. The chain, and
 * the gate prints which link answered, because grok-bot-local-vm has nine agents and none is
 * called Titan.
 */
export function resolveVoiceAgent(agents, settings) {
  const roster = (Array.isArray(agents) ? agents : []).filter((agent) => agent != null && agent.isGroup !== true);
  const wanted = asString(settings?.agentId);
  if (wanted.length > 0) {
    const chosen = roster.find((agent) => String(agent.id ?? "") === wanted);
    if (chosen != null) return { agentId: String(chosen.id), agentName: String(chosen.name ?? ""), why: "the workspace chose this one on its Voice card" };
    return { agentId: "", agentName: "", why: "the agent this workspace chose for voice is not on the roster any more" };
  }
  // mail's own chain (ui/mail-edge.mjs:279-283), so the voice lands on the same bot the mail does.
  const localpart = (name) => String(name ?? "").toLowerCase().replace(/[\s-]+/g, "").replace(/[^a-z0-9._]+/g, "");
  const named = roster.find((agent) => localpart(agent.name) === "titan");
  if (named != null) return { agentId: String(named.id), agentName: String(named.name ?? ""), why: "this workspace has a bot called Titan" };
  const first = roster.find((agent) => agent.kind !== "room" && agent.isGroup !== true);
  if (first != null) return { agentId: String(first.id), agentName: String(first.name ?? ""), why: "the first bot on the roster, because none is called Titan" };
  return { agentId: "", agentName: "", why: "this workspace has no bot to talk to yet" };
}

// ---- held actions (A6) --------------------------------------------------------------------------

/**
 * A pending card read out of the tail, server side. The same three kinds the console's own card
 * reader takes (gateway-adapter.js cardOf), and nothing else: a credential request takes a masked
 * value and there is no spoken answer that could be one.
 */
export function pendingCardsOf(entries) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const m = entry?.message ?? {};
    if (m.type === "auto-review-approval" && m.approval != null && String(m.approval.status ?? "pending") === "pending") {
      out.push({
        kind: "auto-review", entryId: String(entry.id ?? ""), requestId: String(m.approval.requestId ?? ""),
        title: String(m.approval.summary || "This needs your go-ahead"),
        detail: [m.approval.reason, m.approval.command].filter(Boolean).join(" - "),
        timestampMs: Number(entry.timestampMs ?? entry.createdAt) || 0,
      });
    }
    if (m.type === "local-tool-permission" && m.ask != null && String(m.ask.status ?? "pending") === "pending") {
      out.push({
        kind: "local-tool", entryId: String(entry.id ?? ""), requestId: String(m.ask.requestId ?? ""),
        title: `${m.ask.action ?? "Run"} ${m.ask.target ?? "a local tool"}`,
        detail: String(m.ask.description ?? "This runs on the box itself."),
        timestampMs: Number(entry.timestampMs ?? entry.createdAt) || 0,
      });
    }
    if (m.type === "widget" && m.widget != null && entry.widgetDismissed !== true && entry.respondedValue == null) {
      out.push({
        kind: "widget", entryId: String(entry.id ?? ""), requestId: "",
        title: String(m.widget.prompt || "A question for you"),
        detail: "", options: Array.isArray(m.widget.options) ? m.widget.options.map(String) : [],
        timestampMs: Number(entry.timestampMs ?? entry.createdAt) || 0,
      });
    }
  }
  return out;
}

const NEGATION = /\b(?:not|never|don'?t|doesn'?t|didn'?t|won'?t|can'?t|cannot|no longer|hold off|wait)\b/i;
/** A leading refusal, which turns the yes phrase after it into a no rather than into nothing. */
const NEGATION_PREFIX = /^(?:don'?t|do not|dont|never|no|not|please don'?t|i don'?t want to)\s+/;
const YES = ["yes", "yeah", "yep", "yup", "sure", "go ahead", "do it", "send it", "send that", "approve", "approved", "confirm", "confirmed", "ok", "okay", "that's right", "correct", "go for it"];
const NO = ["no", "nope", "nah", "stop", "cancel", "deny", "denied", "don't", "do not", "hold off", "not yet", "never mind", "nevermind", "forget it"];
const FILLER = new Set(["please", "thanks", "thank", "you", "then", "now", "titan", "mate", "man"]);

/**
 * A WHOLE-UTTERANCE yes or no, with a negation guard.
 *
 * session.py's own `_matches` exists because substring search read "don't confirm" as confirm, and
 * that bug on this path closes a held action nobody approved. A match is the phrase alone, or the
 * phrase plus trailing filler.
 */
export function matchYesNo(text) {
  const low = String(text ?? "").toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  if (low.length === 0) return null;
  /** The phrase alone, or the phrase plus trailing filler, and nothing looser than that. */
  const tryPhrasesIn = (text, phrases) => {
    for (const phrase of phrases) {
      if (text === phrase) return phrase;
      if (text.startsWith(`${phrase} `)) {
        const rest = text.slice(phrase.length).trim().split(" ").filter((word) => word.length > 0);
        if (rest.every((word) => FILLER.has(word))) return phrase;
      }
    }
    return null;
  };
  const tryPhrases = (phrases) => tryPhrasesIn(low, phrases);
  const no = tryPhrases(NO);
  if (no != null) return { decision: "no", phrase: no };
  // A REFUSED confirm is a NO, not a nothing. "don't confirm" is the exact utterance session.py's
  // `_matches` was rewritten for, and leaving it unmatched would be safe but would also leave the
  // card open after the person clearly answered it. So a leading refusal is stripped and what
  // remains is tried as a yes phrase: "don't confirm" -> no, "do not send it" -> no. A question
  // that merely contains a negation and the word confirm ("I am not sure, can you confirm what it
  // would do") does not start with a refusal, so it stays prose and goes to Titan as prose.
  const stripped = low.replace(NEGATION_PREFIX, "");
  if (stripped !== low) {
    const negated = tryPhrasesIn(stripped, YES);
    if (negated != null) return { decision: "no", phrase: `not ${negated}` };
  }
  const yes = tryPhrases(YES);
  // And a yes that carries a negation anywhere in it is never a yes.
  if (yes != null && !NEGATION.test(low)) return { decision: "yes", phrase: yes };
  return null;
}

// ---- the turn: titan(message) -------------------------------------------------------------------

/**
 * One spoken turn's round trip into Titan's conversation and back.
 *
 * It POLLS getAgentTranscriptTail. Not the SSE (measured: it fires only for the host's ONE global
 * active agent, and a concurrent gate stole it mid-measurement leaving 27 s of silence), not
 * reloadActive (four extra reads), not openAgent (it would change what every other surface on the
 * box sees, which is why the console avoids it on purpose).
 *
 * EVERY failure RETURNS A SENTENCE and never throws. A dead socket instead of a spoken fallback is
 * the failure AmpCortex's own reference wrote a comment about, and on a microphone it is a phone
 * line that died mid-question.
 */
export function makeTurnRunner({
  call,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = TURN_POLL_MS,
  waitCapS = TURN_WAIT_CAP_S,
  maxRounds = MAX_TITAN_ROUNDS,
  maxNudges = MAX_NUDGES,
  firstNudgeMs = FIRST_NUDGE_MS,
  tailLimit = 24,
  log = () => {},
}) {
  let rounds = 0;
  let nudges = 0;

  const tailOf = (agentId) => call("getAgentTranscriptTail", { id: agentId, limit: tailLimit })
    .then((answer) => (Array.isArray(answer?.entries) ? answer.entries : []))
    .catch(() => null);

  /** The reply is at message.content. Reading `.text` returns empty and looks like a stall. */
  const replyOf = (entry) => {
    if (entry?.kind === "turn-failed") {
      const cause = String(entry.cause ?? "").trim();
      return `That turn did not finish. ${String(entry.text ?? "").trim() || cause || "The box stopped partway through."}`;
    }
    const m = entry?.message ?? {};
    if (typeof m.content === "string" && m.content.trim().length > 0) return m.content.trim();
    if (typeof m.alt === "string" && m.alt.trim().length > 0) return m.alt.trim();
    return "";
  };

  const isReply = (entry) => entry?.kind === "turn-failed"
    || (entry?.kind === "send-message" && pendingCardsOf([entry]).length === 0 && replyOf(entry).length > 0);

  return {
    get rounds() { return rounds; },
    /** A new user turn resets the round counter. omarchy had a max_turns nobody enforced, and a
     *  failing launch then looped every 30 s opening terminals after listening was already off. */
    newUserTurn() { rounds = 0; nudges = 0; },

    /**
     * `onSent` fires once, the instant sendPrompt is accepted, carrying the nonce that the durable
     * user entry will be stamped with. `accepted` says whether anything reached Titan at all, which
     * is what tells "he has not answered yet" from "this never went in".
     *
     * @returns {Promise<{ok:boolean, accepted:boolean, text:string, pieces:string[], attemptId:string,
     *          afterId:string, afterMs:number, card:object|null, hops:object, nonce?:string}>}
     */
    async run({ agentId, message, onNudge = () => {}, onSent = () => {} }) {
      const hops = { t1: now(), t2: 0, t3: 0, t4: 0 };
      if (rounds >= maxRounds) {
        return { ok: false, refused: true, accepted: false, text: "I have already asked him twice about that. Say it again and I will take it to him fresh.", pieces: [], attemptId: "", afterId: "", afterMs: 0, card: null, hops };
      }
      rounds += 1;
      const before = await tailOf(agentId);
      const beforeId = before == null ? "" : String(before.at(-1)?.id ?? "");
      const beforeMs = before == null ? 0 : Number(before.at(-1)?.timestampMs ?? before.at(-1)?.createdAt) || 0;
      const nonce = `voice:${now()}`;
      // MEASURED 6-14 ms and fire-and-forget: sendPrompt answers {accepted:true} unconditionally
      // (awaitTurn is gated on SAND_DISABLE_SEND_ACCEPT_RETURN, which is set nowhere), so the
      // answer is a receipt that the host took it and not that Titan replied.
      const accepted = await call("sendPrompt", { agentId, prompt: message, clientNonce: nonce })
        .then(() => true)
        .catch((error) => { log(`voice sendPrompt failed: ${error?.message ?? error}`); return false; });
      hops.t2 = now();
      // THE CONFIRMATION, SAID THE MOMENT IT IS TRUE and not when Titan finishes. sendPrompt answers
      // in 6-14 ms; run() does not return for 5.5 to 25 s. VOICE-7's panel over the conversation has
      // to dissolve when the PERSON stops talking, so what the page needs -- the bytes that went into
      // Titan's conversation and the nonce his durable row will carry -- is handed out here.
      if (!accepted) {
        return { ok: false, accepted: false, text: "I could not get that to him just now. His box did not take it.", pieces: [], attemptId: "", afterId: beforeId, afterMs: beforeMs, card: null, hops, nonce };
      }
      try { onSent({ nonce, message, agentId }); } catch (error) { log(`voice onSent failed: ${error?.message ?? error}`); }
      const deadline = now() + waitCapS * 1000;
      let nudged = 0;
      while (now() < deadline) {
        await sleep(pollMs);
        const entries = await tailOf(agentId);
        if (entries != null) {
          const fresh = newerThan(entries, beforeId, beforeMs);
          const landed = fresh.find(isReply);
          if (landed != null) {
            hops.t3 = now();
            const text = replyOf(landed);
            const pieces = splitSentences(text);
            hops.t4 = now();
            return {
              ok: landed.kind !== "turn-failed", text, pieces,
              attemptId: String(landed.evidence?.attemptId ?? ""),
              afterId: String(landed.id ?? beforeId),
              afterMs: Number(landed.timestampMs ?? landed.createdAt) || now(),
              card: pickOneCard(pendingCardsOf(fresh)),
              hops, nonce, accepted: true,
            };
          }
          // A card with no reply beside it is still an answer: he is waiting on the person.
          const card = pickOneCard(pendingCardsOf(fresh));
          if (card != null) {
            hops.t3 = now();
            hops.t4 = now();
            return { ok: true, accepted: true, text: "", pieces: [], attemptId: "", afterId: String(fresh.at(-1)?.id ?? beforeId), afterMs: Number(fresh.at(-1)?.timestampMs ?? now()), card, hops, nonce, cards: pendingCardsOf(fresh) };
          }
        }
        // A nudge is driven off the roster's own working flag, never a bare timer, and each one is
        // a billed event on xAI so it is bounded rather than a heartbeat.
        if (nudged < maxNudges && now() - hops.t2 > firstNudgeMs * (nudged + 1)) {
          const working = await stillWorking(call, agentId);
          nudged += 1;
          nudges += 1;
          if (working) onNudge(nudged === 1 ? "He is still on it." : "Still going.");
          else break;
        }
      }
      return {
        ok: false,
        text: now() < deadline
          ? "He stopped working without answering that one. Ask again and I will take it back to him."
          : `He has not come back in ${waitCapS} seconds. It is still in his conversation on screen.`,
        pieces: [], attemptId: "", afterId: beforeId, afterMs: beforeMs, card: null, hops, nonce, accepted: true,
      };
    },

    /**
     * Later entries of the SAME attempt, for the announcement queue. They are spoken, not returned
     * as the tool result: the first entry already closed the call so speech could start.
     */
    async follow({ agentId, attemptId, afterId, afterMs, windowMs = 60000, onAnnounce = () => {} }) {
      const deadline = now() + windowMs;
      let cursorId = afterId;
      let cursorMs = afterMs;
      while (now() < deadline) {
        await sleep(pollMs * 2);
        const entries = await tailOf(agentId);
        if (entries == null) continue;
        const fresh = newerThan(entries, cursorId, cursorMs).filter(isReply);
        for (const entry of fresh) {
          cursorId = String(entry.id ?? cursorId);
          cursorMs = Number(entry.timestampMs ?? entry.createdAt) || cursorMs;
          if (attemptId.length > 0 && String(entry.evidence?.attemptId ?? "") !== attemptId) continue;
          onAnnounce(replyOf(entry));
        }
        if (fresh.length === 0 && !(await stillWorking(call, agentId))) return;
      }
    },
  };
}

/** Entries after a cursor. The id is the anchor; the clock is only the tie-break. */
function newerThan(entries, afterId, afterMs) {
  const list = Array.isArray(entries) ? entries : [];
  if (afterId.length > 0) {
    const at = list.findIndex((entry) => String(entry?.id ?? "") === afterId);
    if (at >= 0) return list.slice(at + 1);
  }
  return list.filter((entry) => (Number(entry?.timestampMs ?? entry?.createdAt) || 0) > afterMs);
}

/**
 * Whether this agent is actually at work.
 *
 * The roster's own field is `isRunning` (the console reads exactly this at
 * gateway-adapter.js:666). The brief named isRunningTurn and isComposingMessage; neither exists
 * anywhere in ui/, so both are accepted as aliases in case a newer bundle stamps them and
 * `isRunning` is what actually answers today.
 */
/**
 * The roster, whatever shape the host answers in.
 *
 * MEASURED on grok-bot-local-vm 2026-09-10: POST /api/listAgents answers a BARE ARRAY of nine
 * agents, not `{agents:[...]}`. Reading only the wrapped shape is how this bridge told a box with
 * nine bots on it that there was nobody to talk to. ui/mail-edge.mjs:694 already had this exactly
 * right and it is the only place in ui/ that did; this is that line, in one helper, used everywhere.
 */
async function rosterOf(call) {
  const answer = await call("listAgents", {}).catch(() => null);
  return Array.isArray(answer) ? answer : Array.isArray(answer?.agents) ? answer.agents : [];
}

async function stillWorking(call, agentId) {
  const agents = await rosterOf(call);
  const row = agents.find((agent) => String(agent?.id ?? "") === String(agentId));
  if (row == null) return false;
  return row.isRunning === true || row.isRunningTurn === true || row.isComposingMessage === true || row.isBusy === true;
}

/**
 * At most ONE card is read out. Two or more and the relay says in words that it will not guess and
 * names them, because a spoken yes that closes the wrong card is the worst outcome in this wave.
 */
function pickOneCard(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  if (cards.length > 1) return { kind: "many", count: cards.length, cards };
  return cards[0];
}

/**
 * Close a held card through the commands the console already uses. Never a second gate.
 *
 * The card's status is RE-READ out of the tail immediately before resolving: an unknown requestId
 * throws SAND_AUTO_REVIEW_STALE and every pending approval expires at session end, and reporting
 * success for a command that never ran is the worst thing this wave could do.
 */
export async function resolveHeldCard({ call, agentId, card, decision }) {
  const fresh = await call("getAgentTranscriptTail", { id: agentId, limit: 24 })
    .then((answer) => pendingCardsOf(Array.isArray(answer?.entries) ? answer.entries : []))
    .catch(() => null);
  if (fresh == null) return { ok: false, said: "I could not check whether that is still waiting, so I have left it alone." };
  const still = fresh.find((row) => row.entryId === card.entryId && (card.requestId.length === 0 || row.requestId === card.requestId));
  if (still == null) return { ok: false, said: "That one already closed, so I have not touched it." };
  const resolution = decision === "yes" ? "approved" : "denied";
  try {
    if (card.kind === "auto-review") {
      await call("resolveAutoReviewApproval", { agentId, entryId: card.entryId, requestId: card.requestId, resolution });
    } else if (card.kind === "local-tool") {
      await call("resolveLocalToolPermission", { agentId, entryId: card.entryId, requestId: card.requestId, resolution: decision === "yes" ? "allow" : "deny" });
    } else if (card.kind === "widget") {
      const options = Array.isArray(card.options) ? card.options : [];
      const value = decision === "yes" ? (options[0] ?? "yes") : (options[1] ?? "no");
      await call("respondToWidget", { entryId: card.entryId, value, agentId });
    } else {
      return { ok: false, said: "That one is not something I can answer out loud." };
    }
  } catch (error) {
    return { ok: false, said: `That answer did not reach his box: ${String(error?.message ?? error).slice(0, 120)}` };
  }
  // Nothing reports success on its own. The host rewrites the card's status, so what went through
  // is what the next read says went through.
  return { ok: true, said: decision === "yes" ? "Done, I told him to go ahead." : "Told him no.", requestId: card.requestId };
}

// ---- the browser socket -------------------------------------------------------------------------

/**
 * One browser's socket, after the 101 this file wrote by hand.
 *
 * Binary in is raw PCM16 LE mono 24 kHz and nothing else. Text in is small JSON. The page never
 * names a tenant, an agent, a provider, a model, a cap or a key -- all of those are decided here,
 * from the cookie -- so there is nothing in an inbound frame worth lying about.
 */
export function wrapBrowserSocket(socket, { onBinary = () => {}, onJson = () => {}, onClose = () => {}, log = () => {} } = {}) {
  const reader = new FrameReader();
  let closed = false;
  const write = (buffer) => { if (!closed && socket.writable) socket.write(buffer); };
  const api = {
    get closed() { return closed; },
    sendJson(object) { write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(object), "utf8"))); },
    sendBinary(buffer) { write(encodeFrame(OPCODE.binary, buffer)); },
    /** One plain sentence the person reads. Never a vendor name, never a tool name. The optional
     *  `reason` is the page's own condition vocabulary ("no-key", "day-cap", "session-cap",
     *  "line-dropped"); it decides whether the row offers a way forward, and an unmapped condition
     *  is sent as "" on purpose so the page leaves our sentence exactly as written. */
    note(text, reason = "") { api.sendJson({ t: "note", text: String(text), reason: String(reason) }); },
    state(value) { api.sendJson({ t: "state", value }); },
    /**
     * A close carries a code AND a reason, because the page reads event.reason.
     *
     * The JSON frame's `reason` is the page's CONDITION, not our prose: it is what retitles the
     * sentence we already sent so a missing key can offer the card that fixes it. The prose stays on
     * `detail` and on the close frame, which is what an operator reads in a log. The page also knows
     * close codes 4001..4004 for a relay that dies mid-call without getting a frame out; this bridge
     * always writes the note, the bye and the close together on the live socket, so it closes 1000.
     */
    bye(reason, code = 1000, condition = "") {
      api.sendJson({ t: "bye", reason: String(condition), detail: String(reason) });
      write(encodeClose(code, reason));
      closed = true;
      // The frames have to reach the browser before the FIN, or Chrome reports onerror with no
      // code and the person reads "the relay is down" over a sentence we actually sent.
      const timer = setTimeout(() => { try { socket.end(); } catch { /* already gone */ } }, 40);
      timer.unref?.();
    },
    destroy() { closed = true; try { socket.destroy(); } catch { /* already gone */ } },
  };
  socket.on("data", (chunk) => {
    let messages = [];
    try { messages = reader.push(chunk); }
    catch (error) {
      log(`voice browser frame error: ${error?.message ?? error}`);
      return api.bye("That connection went out of step. Press the button again.", error?.code ?? 1002);
    }
    for (const message of messages) {
      if (message.opcode === OPCODE.close) { closed = true; onClose(decodeClose(message.payload)); try { socket.end(); } catch { /* gone */ } return undefined; }
      if (message.opcode === OPCODE.ping) { write(encodeFrame(OPCODE.pong, message.payload)); continue; }
      if (message.opcode === OPCODE.pong) continue;
      if (message.opcode === OPCODE.binary) { onBinary(message.payload); continue; }
      if (message.opcode === OPCODE.text) {
        let parsed = null;
        try { parsed = JSON.parse(message.payload.toString("utf8")); } catch { parsed = null; }
        if (parsed != null) onJson(parsed);
      }
    }
    return undefined;
  });
  socket.on("error", () => { if (!closed) { closed = true; onClose({ code: 1006, reason: "the browser socket errored" }); } });
  socket.on("close", () => { if (!closed) { closed = true; onClose({ code: 1006, reason: "the browser went away" }); } });
  socket.setNoDelay?.(true);
  return api;
}

/** The 101, then one sentence, then goodbye. This is what EVERY voice refusal looks like. */
export function acceptAndSay(socket, key, sentence, reason = "refused", condition = "") {
  try {
    socket.write(handshakeResponse(key));
    const browser = wrapBrowserSocket(socket);
    browser.state("off");
    browser.note(sentence, condition);
    browser.bye(reason, 1000, condition);
  } catch { try { socket.destroy(); } catch { /* already gone */ } }
}

// ---- the provider socket ------------------------------------------------------------------------

/**
 * Dial a provider. MEASURED on node v22.23.1: the global WebSocket puts `authorization: Bearer ...`
 * on the wire from `new WebSocket(url, { headers })` and the URL carries nothing -- the stub's own
 * request log is what a test sweeps to prove it. Header form ONLY: never a URL parameter, never a
 * subprotocol (proxies log both), and never an ephemeral token handed to a browser.
 */
export function dialProviderSocket({ vendorId, apiKey, model, url, WebSocketImpl = null }) {
  const Impl = WebSocketImpl ?? globalThis.WebSocket;
  if (typeof Impl !== "function") throw new Error("this node has no WebSocket client, so the bridge cannot dial out");
  return new Impl(dialUrl(vendorId, { model, url }), { headers: dialHeaders(vendorId, apiKey) });
}

// ---- the session --------------------------------------------------------------------------------

const SENTENCE = {
  noKey: "This workspace has no realtime voice key yet. Add one on the Voice card in Settings and press the button again.",
  notEnabled: "Voice is switched off for this workspace. Turn it on on the Voice card in Settings.",
  badOrigin: "That came from a page this console does not serve, so I did not open the microphone.",
  noAgent: "There is no bot in this workspace to talk to yet.",
  sessionCap: "That is the time limit for one conversation. Press the button again to start a fresh one.",
  dayCap: "This workspace has used its voice time for today. It resets at midnight UTC.",
  providerRefused: "The voice service would not take that key. Check it on the Voice card in Settings.",
  // A DIAL THAT NEVER OPENED, which is what a wrong key and an unreachable address BOTH look like
  // from here. MEASURED on this Mac (node v22.23.1): a vendor answering 401 to the upgrade and a
  // vendor with nothing listening produce the same single error event, "Received network error or
  // non-101 status code", with no close event and no status code of any kind; a black-holed address
  // produces nothing at all for at least four seconds. So one sentence covers both causes and names
  // the thing a person can actually check. It was silence until 2026-09-10.
  providerSilent: "The voice service did not answer. Check the key on the Voice card in Settings, then press the button again.",
  providerGone: "The voice line dropped. Press the button again.",
  // One call at a time per workspace. The day cap is a number read from the ledger, so N sockets
  // opened together each read the same remaining day and the cap multiplies by N.
  alreadyInCall: "This workspace is already in a call. Stop that one and press the button again.",
  busy: "I could not start a voice session just now. Try again in a moment.",
};

export const VOICE_SENTENCES = SENTENCE;

/**
 * One voice session, from an accepted upgrade to a closed socket.
 *
 * The two readers NEVER await each other. Draining the player inline froze omarchy's whole event
 * loop -- tool calls included -- for the length of every spoken reply (realtime.py:270-276), so the
 * provider reader here never awaits a browser write and the turn runs on its own task.
 */
export function makeVoiceSession({
  t,
  settings,
  policy,
  agent,
  call,
  ledger,
  sessionId,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }),
  WebSocketImpl = null,
  providerUrl = "",
  // How often the caps are checked. Ten seconds is the production choice; a test overrides it so
  // that proving the cap closes the line is a deterministic assertion rather than a wall-clock wait
  // that passes alone and flakes in a full bundle.
  capTickMs = CAP_TICK_MS,
  // How long the dial may stay silent before the person is told. A test shortens it.
  dialWatchdogMs = DIAL_WATCHDOG_MS,
  /** Called once, after the row is settled, so the edge can forget this session. */
  onClosed = () => {},
  log = () => {},
}) {
  const vendor = vendorOf(settings.vendor);
  const model = settings.model.length > 0 ? settings.model : vendor.model;
  const voice = settings.voice.length > 0 ? settings.voice : vendor.voice;
  const gate = makeEchoGate({ now });
  const dedupe = makeCallDedupe();
  const caption = makeCaption(vendor.transcription.mode);
  const runner = makeTurnRunner({ call, now, sleep, log });
  const startedMs = now();
  const meter = { audioInBytes: 0, audioOutBytes: 0, billedItemEvents: 0, toolCalls: 0, browserHeld: 0 };
  const announcements = [];
  let browser = null;
  let provider = null;
  let responseInFlight = false;
  let lastAnnounceMs = 0;
  let speakId = 0;
  let stopping = false;
  let tick = null;
  let rateLimitWaits = 0;
  /** Whether the provider socket ever opened, which is what tells a refused dial from a dropped line. */
  let opened = false;
  let dialWatch = null;
  /** The caps this session was authorised under, kept so the audio ceiling and the tick can read them. */
  let capSeconds = SESSION_CAP_SECONDS;
  /**
   * The orb's own value, kept here as well as sent, because two things read it: nothing may paint
   * the person's words while the machine is the one making noise (docs/VOICE.md 8 records a measured
   * feedback loop where the model's own speech came back through the microphone and transcribed as a
   * user turn), and the VOICE-7 panel must never show the machine's words as the person's.
   */
  let orbState = "off";
  /**
   * The user turn whose words are on screen right now, or 0 when none is. Every open turn is closed
   * EXACTLY ONCE by a `hear-end`, whatever happens to it, because a panel that waits for a chat row
   * hangs on the three turns that never produce one: a spoken yes answering a held card, an empty
   * utterance, and a send the box refused.
   */
  let hearTurn = 0;
  /** The last turn a `hear-end` closed, so a transcript arriving after it cannot re-open the panel. */
  let hearClosedTurn = 0;

  const secondsNow = () => Math.max(0, Math.round((now() - startedMs) / 1000));
  const bytesToSeconds = (bytes) => Math.round(bytes / (AUDIO_RATE * 2));

  const rowNow = (state, closeReason = "") => voiceLedgerRow({
    sessionId, slug: t.slug, agentId: agent.agentId, agentName: agent.agentName,
    vendor: vendor.id, model,
    startedAt: new Date(startedMs).toISOString(),
    state,
    endedAt: state === "closed" ? new Date(now()).toISOString() : null,
    wallSeconds: secondsNow(),
    audioInSeconds: bytesToSeconds(meter.audioInBytes),
    audioOutSeconds: bytesToSeconds(meter.audioOutBytes),
    billedItemEvents: meter.billedItemEvents,
    toolCalls: meter.toolCalls,
    heldFrames: gate.heldFrames + meter.browserHeld,
    closeReason,
  });

  /** The orb, said once and remembered, so the two readers above never have to guess. */
  const setState = (value) => { orbState = String(value ?? ""); browser?.state(orbState); };

  /**
   * VOICE-7's vocabulary, beside the `heard` frame and not instead of it.
   *
   * `heard` is shipped and drawn by ui/machine-room/voice.js, and a relay restart mid-call leaves an
   * old page against a new relay, so it keeps going out exactly as it did. What it could never do is
   * say WHICH of three different things it was carrying -- a partial transcript, the finished
   * transcript, or the string the model actually handed to Titan -- which is what a panel that has to
   * dissolve at the right moment needs. So:
   *
   *   hear-begin       {turn, itemId}                  the person started talking
   *   hear             {turn, itemId, text, final}     the words so far, replace-whole
   *   heard-confirmed  {turn, text, nonce, landed}     the bytes that went into Titan's conversation
   *   hear-end         {turn, reason}                  this turn is over, and why
   *
   * `heard-confirmed` is the ONLY frame whose text is the same bytes as the chat row: the words the
   * person watched being built are the transcription model's, and the string that becomes the row is
   * the realtime model's own tool argument. Two models, two strings, and they will differ. The nonce
   * is the one the durable entry carries, so the page can tie the panel to the row it becomes
   * (ui/machine-room/gateway-adapter.js stamps `spoken` off that same `voice:` prefix).
   */
  /**
   * Whether the machine is the one making noise. The orb alone is not enough: a speech_started event
   * sets the orb back to listening before anything else runs, so the truth is the echo gate, which is
   * booked from the BYTES of audio that went out and stays held for the tail after them. MEASURED: a
   * guard on the orb alone admitted two partials of the model's own sentence.
   */
  const machineTalking = () => orbState === "speaking" || gate.holding();

  const hearBegin = (itemId = "") => {
    if (machineTalking()) return undefined;
    hearTurn = Math.max(session.userTurn, 1);
    browser?.sendJson({ t: "hear-begin", turn: hearTurn, itemId: String(itemId ?? "") });
    return undefined;
  };
  const hear = (text, { final = false, itemId = "" } = {}) => {
    // Never while the machine is the one talking. If the echo gate ever slips, the panel would
    // otherwise render Titan's own sentence as though the person had said it.
    if (machineTalking()) return undefined;
    if (hearTurn === 0) {
      // A vendor that sends a transcript without a speech_started still gets a panel. A transcript
      // arriving AFTER this turn was closed does not: the `.completed` and the tool call race, and
      // resurrecting the panel a moment after it dissolved is a flicker over the conversation.
      const turn = Math.max(session.userTurn, 1);
      if (turn <= hearClosedTurn) return undefined;
      hearTurn = turn;
    }
    browser?.sendJson({ t: "hear", turn: hearTurn, itemId: String(itemId ?? ""), text: String(text ?? ""), final: final === true });
    return undefined;
  };
  /** Closes an open turn once. A second call for the same turn is dropped, so no panel flickers back. */
  const hearEnd = (reason) => {
    if (hearTurn === 0) return undefined;
    const turn = hearTurn;
    hearClosedTurn = turn;
    hearTurn = 0;
    browser?.sendJson({ t: "hear-end", turn, reason: String(reason ?? "") });
    return undefined;
  };

  const sendProvider = (object) => {
    if (provider == null || provider.readyState !== 1) return false;
    provider.send(JSON.stringify(object));
    // xAI bills one flat fee per conversation.item.create EXCEPT a function_call_output, and
    // response.create is free. Counting it here is what makes the Spend line honest about xAI's
    // second meter, and is why Titan's reply goes back as tool output rather than as chat.
    if (object?.type === "conversation.item.create" && object?.item?.type !== "function_call_output" && vendor.billsTextItems) meter.billedItemEvents += 1;
    return true;
  };

  /** Speak something that is not an answer to a tool call: an announcement, or a nudge. */
  const say = async (text) => {
    const clean = String(text ?? "").trim();
    if (clean.length === 0) return;
    // Never while a response is in flight, and never closer than eight seconds: each one is a
    // billed event on xAI, and two overlapping responses is the provider error nobody can hear.
    for (let i = 0; i < 40 && !stopping && (responseInFlight || now() - lastAnnounceMs < ANNOUNCE_GAP_MS); i += 1) await sleep(400);
    if (stopping) return;
    lastAnnounceMs = now();
    sendProvider({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `Read this out to the person, word for word, nothing added: ${clean}` }] } });
    sendProvider({ type: "response.create" });
  };

  const answerTool = (callId, payload) => {
    sendProvider({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(payload) } });
    sendProvider({ type: "response.create" });
  };

  /** The one tool, dispatched once per call_id, on whichever surface carried it first. */
  const dispatch = async (toolCall) => {
    if (toolCall.name !== "titan") return answerTool(toolCall.callId, { error: "there is no such tool here" });
    meter.toolCalls += 1;
    // The turn this call belongs to, taken here rather than read later: in always-listening the next
    // utterance can start while this one is still with Titan, and the panel's frames have to stay
    // with the words the person watched being built.
    const turn = hearTurn || session.userTurn;
    let message = "";
    try { message = String(JSON.parse(toolCall.argumentsJson || "{}").message ?? "").trim(); } catch { message = ""; }
    if (message.length === 0) {
      hearEnd("empty");
      return answerTool(toolCall.callId, { reply: "I did not catch that. Say it again." });
    }
    browser?.sendJson({ t: "heard", text: message });
    // A whole-utterance yes or no while a card is on the table is an ANSWER to that card, and it
    // goes through the approval path the console already uses rather than into the conversation as
    // prose. A confirm arriving in the same turn as the gated action is refused: it needs a NEW
    // user turn, or the model could talk itself into a yes.
    const decision = matchYesNo(message);
    if (decision != null && session.heldCard != null) {
      const card = session.heldCard;
      if (card.offeredTurn === session.userTurn) {
        // The model talked itself into a confirmation inside one user turn. Nothing goes to Titan and
        // no row appears, so the panel is closed rather than left over the conversation.
        hearEnd("not-accepted");
        return answerTool(toolCall.callId, { reply: "Say that again and I will take it as your answer." });
      }
      session.heldCard = null;
      const outcome = card.kind === "many"
        ? { ok: false, said: `There are ${card.count} things waiting on you. Say which one and I will take it back to him, or answer them on screen.` }
        : await resolveHeldCard({ call, agentId: agent.agentId, card, decision: decision.decision });
      const said = outcome.ok && String(outcome.requestId ?? "").length > 0 ? `${outcome.said} That was ${outcome.requestId}.` : outcome.said;
      // A yes that closes a card never becomes a row in the conversation, so the panel is told the
      // turn is over on its own terms rather than waiting for a row that is not coming.
      hearEnd("answered-card");
      browser?.sendJson({ t: "said", text: said });
      return answerTool(toolCall.callId, { reply: said });
    }
    setState("thinking");
    const result = await runner.run({
      agentId: agent.agentId,
      message,
      onNudge: (text) => void say(text),
      // The instant the box takes it, and not when Titan answers: these are the bytes that became
      // the row, and the nonce that row carries.
      onSent: ({ nonce }) => {
        browser?.sendJson({ t: "heard-confirmed", turn, text: message, nonce: String(nonce ?? ""), landed: true });
        hearEnd("sent");
      },
    });
    // Nothing reached his box: a refused send, or a third round inside one user turn. Either way no
    // durable row will ever appear, so the panel is closed here instead of hanging over the chat.
    if (result.accepted !== true) hearEnd("not-accepted");
    const pieces = result.pieces.length > 0 ? result.pieces : (result.text.length > 0 ? [result.text] : []);
    let reply = pieces.join(" ");
    if (result.card != null) {
      session.heldCard = { ...result.card, offeredTurn: session.userTurn };
      const question = result.card.kind === "many"
        ? `There are ${result.card.count} things waiting on you: ${result.card.cards.map((c) => c.title).join("; ")}. Say which one.`
        : `${result.card.title}. ${result.card.detail ?? ""}`.trim();
      reply = `${reply} ${question}`.trim();
    }
    if (reply.length === 0) reply = "He did not say anything back.";
    browser?.sendJson({ t: "said", text: reply });
    // The latency ledger, so a gate can print every hop with the machine it was measured on. T0 is
    // the provider's own VAD stop, T1 the tool call dispatched, T2 sendPrompt accepted, T3 the first
    // entry seen in the tail, T4 sentence one handed back. T2 to T3 is TITAN'S time, not ours: it is
    // reported and never asserted, and what is ours is that the person hears something during it.
    browser?.sendJson({ t: "hops", t0: session.hops.t0, ...result.hops });
    // FREE on xAI, and what the design wanted anyway: the reply goes back as the tool's output
    // rather than as a chat item, in sentence-sized pieces so speech starts on the first one.
    answerTool(toolCall.callId, { reply, sentences: pieces });
    if (result.attemptId.length > 0) {
      void runner.follow({
        agentId: agent.agentId, attemptId: result.attemptId, afterId: result.afterId, afterMs: result.afterMs,
        onAnnounce: (text) => { announcements.push(text); void say(text); },
      }).catch(() => {});
    }
    return undefined;
  };

  const onProviderEvent = (event) => {
    const type = canonicalEvent(event?.type);
    if (type === "error") {
      // A cancel race and a vanished item are NOTES, never errors: they must not colour the orb,
      // and that is host-notes-read-as-errors.md happening in someone else's codebase.
      if (providerErrorIsQuiet(event)) return log(`voice note from the provider: ${event?.error?.code}`);
      log(`voice provider error: ${JSON.stringify(event?.error ?? {}).slice(0, 240)}`);
      // A session refused before a single word was said cannot recover by itself, and silence is
      // the void answer this console has already been burned by.
      if (meter.toolCalls === 0 && meter.audioOutBytes === 0) return void close("the voice service refused this session", SENTENCE.providerRefused, "no-key");
      return undefined;
    }
    if (type === "session.updated") { setState("listening"); return undefined; }
    if (type === "input_audio_buffer.speech_started") {
      session.userTurn += 1;
      runner.newUserTurn();
      // THE RESET THAT WAS MISSING. Until 2026-09-10 the accumulator was cleared only by a
      // `.completed`, so an utterance whose completion never arrived bled into the next one. A new
      // utterance starts empty here whatever happened to the last one.
      caption.reset();
      setState("listening");
      hearBegin(event?.item_id);
      return undefined;
    }
    if (type === "input_audio_buffer.speech_stopped") { session.hops.t0 = now(); setState("thinking"); return undefined; }
    if (type === "conversation.item.input_audio_transcription.updated" || type === "conversation.item.input_audio_transcription.delta") {
      // REPLACE-WHOLE on both vendors. Append-the-delta writes the sentence N times on xAI.
      const text = caption.apply(event);
      browser?.sendJson({ t: "heard", text });
      hear(text, { final: false, itemId: event?.item_id ?? caption.itemId });
      return undefined;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const text = caption.complete(event);
      const itemId = event?.item_id ?? caption.itemId;
      caption.reset();
      browser?.sendJson({ t: "heard", text });
      // The transcription model's own last word. It is a `hear` and NOT the end of the turn: this
      // and the tool call race, and dissolving here would flicker the panel back when the confirmed
      // text arrives a moment later.
      hear(text, { final: true, itemId });
      return undefined;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      // Handled nowhere in this file until 2026-09-10, which is how one utterance came to bleed into
      // the next. The words are gone; the turn is not left open waiting for them.
      log(`voice transcription failed: ${String(event?.error?.message ?? event?.error?.code ?? "").slice(0, 160)}`);
      caption.reset();
      hearEnd("no-words");
      return undefined;
    }
    if (type === "response.created") { responseInFlight = true; return undefined; }
    if (type === "response.output_audio.delta") {
      const audio = Buffer.from(String(event.delta ?? ""), "base64");
      if (audio.byteLength === 0) return undefined;
      meter.audioOutBytes += audio.byteLength;
      if (!gate.holding()) { speakId += 1; browser?.sendJson({ t: "speak-begin", id: speakId }); setState("speaking"); }
      // Booked from BYTES: the model sends audio far faster than it is spoken, so the room is loud
      // long after the queue is empty, and that window is exactly when the mic must stay shut.
      gate.book(audio.byteLength);
      browser?.sendBinary(audio);
      return undefined;
    }
    if (type === "response.output_audio.done") {
      browser?.sendJson({ t: "speak-end", id: speakId, holdUntilMs: gate.playsUntilMs + ECHO_TAIL_MS });
      return undefined;
    }
    if (type === "rate_limits.updated") {
      // Logged every turn on OpenAI the way omarchy learned to: "tier 3 but enforced at 40k" took a
      // whole session to notice. xAI emits this never, so nothing here waits on it.
      return log(`voice rate limits: ${JSON.stringify(event.rate_limits ?? []).slice(0, 200)}`);
    }
    if (type === "response.done") {
      responseInFlight = false;
      const limited = rateLimitOf(event);
      if (limited != null) {
        rateLimitWaits += 1;
        if (rateLimitWaits <= 2) {
          log(`voice rate limited, waiting ${limited.waitMs} ms: ${limited.message}`);
          void sleep(limited.waitMs).then(() => { if (!stopping) sendProvider({ type: "response.create" }); });
        } else {
          // Dropping it is indistinguishable from not being heard, so it is said out loud.
          void say("The voice service is rate limiting us. Give it a moment and say that again.");
        }
      }
      if (!gate.holding()) setState("listening");
    }
    const calls = toolCallsOf(event);
    for (const toolCall of calls) {
      // ONE call_id, dispatched once, on whichever of the three surfaces carried it first.
      if (dedupe.claim(toolCall.callId)) void dispatch(toolCall).catch((error) => log(`voice dispatch failed: ${error?.message ?? error}`));
    }
    // A finished response that asked Titan nothing means the model answered out of its own head,
    // which the instructions forbid but cannot prevent. No tool call, no row, so the turn is closed
    // here rather than leaving the person's words sitting over the conversation forever.
    if (type === "response.done" && !calls.some((toolCall) => toolCall.name === "titan")) hearEnd("no-answer");
    return undefined;
  };

  async function close(reason, sentence = "", condition = "") {
    if (stopping) return;
    stopping = true;
    if (tick != null) clearInterval(tick);
    if (dialWatch != null) clearTimeout(dialWatch);
    if (sentence.length > 0) browser?.note(sentence, condition);
    // The line is going down with words on screen, so the panel is dissolved before the socket is.
    hearEnd("line-closed");
    setState("off");
    browser?.bye(reason, 1000, condition);
    try { provider?.close(1000, "done"); } catch { /* already gone */ }
    await ledger.settle(rowNow("closed", reason)).catch((error) => log(`voice could not settle the ledger: ${error?.message ?? error}`));
    // The edge forgets this session here, so "what is live right now" is a truthful answer and the
    // one-call-at-a-time check reads it. Every finished session used to be retained for the life of
    // the relay process, with its socket wrappers, its gate and its meter.
    try { onClosed(session); } catch (error) { log(`voice could not release the session: ${error?.message ?? error}`); }
  }

  /**
   * A dial that never opened, which is a wrong key or an address nothing answers at.
   *
   * Both look the SAME from here and neither arrives as a close: MEASURED on this Mac, node fires one
   * `error` with "Received network error or non-101 status code" for a 401 upgrade AND for a refused
   * connection, and fires nothing at all for a black hole. So this one path carries all three, the
   * watchdog covers the silent case, and the sentence names the thing a person can check.
   */
  const dialNeverOpened = (why) => {
    if (stopping || opened) return;
    void close(why, SENTENCE.providerSilent, "no-key");
  };

  const session = {
    sessionId,
    heldCard: null,
    /** Which user turn we are on, so a confirm cannot land in the same turn as its own question. */
    userTurn: 0,
    hops: { t0: 0 },
    get meter() { return meter; },
    get gate() { return gate; },
    get announcements() { return announcements; },
    get stopped() { return stopping; },
    row: (state, reason) => rowNow(state, reason),
    close,

    /** Attach the accepted browser socket, dial the provider, and run until something closes. */
    start(socket, key, { sessionCapSeconds, dayRemainingSeconds, dayRemainingNow = null }) {
      capSeconds = Math.max(1, Math.round(Number(sessionCapSeconds) || SESSION_CAP_SECONDS));
      socket.write(handshakeResponse(key));
      browser = wrapBrowserSocket(socket, {
        log,
        onBinary: (payload) => {
          // The gate lives on BOTH sides: the page holds capture, and anything that arrives inside
          // the same window anyway is DROPPED here, so a patched page cannot make the model hear
          // itself and the held count is a server-side number with no browser in it.
          if (!gate.admit(payload.byteLength)) return;
          // THE METER THE VENDOR BILLS ON IS AUDIO SECONDS, AND THE CAPS COUNT WALL SECONDS, so the
          // audio has its own ceiling beside the wall one and the page does not get to set the rate.
          // MEASURED on this Mac before this: 3000 frames, 14,400,000 bytes, five minutes of audio
          // forwarded in 0.15 s of wall clock, the settled row reading wallSeconds 0 and
          // audioInSeconds 300, every cap on screen green. Two rules, both server-side:
          //   1. no more audio than the session's own wall cap, ever;
          //   2. no further ahead of the wall clock than AUDIO_LEAD_SECONDS, so a page cannot send a
          //      day of audio in a minute. A frame dropped here is counted, and it is counted as a
          //      held frame because that is the one number a person's own page reports too.
          const seconds = bytesToSeconds(meter.audioInBytes + payload.byteLength);
          if (seconds > capSeconds) { meter.browserHeld += 1; return; }
          if (seconds > secondsNow() + AUDIO_LEAD_SECONDS) { meter.browserHeld += 1; return; }
          meter.audioInBytes += payload.byteLength;
          sendProvider({ type: "input_audio_buffer.append", audio: payload.toString("base64") });
        },
        onJson: (message) => {
          if (message?.t === "stop") { void close("the person pressed the button"); return undefined; }
          if (message?.t === "ping") { browser?.sendJson({ t: "pong" }); return undefined; }
          if (message?.t === "held") { meter.browserHeld += Math.max(0, Number(message.frames) || 0); return undefined; }
          if (message?.t === "mic" && message.on !== true) { gate.release(); return undefined; }
          return undefined;
        },
        onClose: () => void close("the browser closed the socket"),
      });
      browser.sendJson({
        t: "ready",
        // The page is told what it needs to draw an orb and a timer and nothing else. No key; the
        // vendor id only so a support question has an answer, and the copy never shows it.
        provider: vendor.id, model, voice, sessionId,
        agentName: agent.agentName, agentWhy: agent.why,
        sessionCapSeconds, dayRemainingSeconds,
        frameBytes: FRAME_BYTES, rate: AUDIO_RATE, echoTailMs: ECHO_TAIL_MS,
      });
      setState("listening");

      // ARMED BEFORE THE DIAL, cleared on the provider's own `open`. A failed upgrade does not close
      // and a black hole says nothing at all, so this is the only thing between a wrong key and half
      // an hour of open microphone.
      dialWatch = setTimeout(() => { dialWatch = null; dialNeverOpened("the voice line never opened"); }, dialWatchdogMs);
      dialWatch.unref?.();
      try {
        provider = dialProviderSocket({ vendorId: vendor.id, apiKey: settings.apiKey, model, url: providerUrl, WebSocketImpl });
      } catch (error) {
        log(`voice could not dial: ${error?.message ?? error}`);
        void close("the relay could not open a voice line", SENTENCE.providerGone, "line-dropped");
        return undefined;
      }
      provider.addEventListener("open", () => {
        opened = true;
        if (dialWatch != null) { clearTimeout(dialWatch); dialWatch = null; }
        // Written ONCE, byte-identical for the life of the socket: rewriting the instructions
        // invalidates the cached prefix and re-bills the whole conversation every turn.
        sendProvider(buildSession(vendor.id, { instructions: voiceInstructions(agent.agentName || "Titan"), voice, model, tools: [titanTool()] }));
      });
      provider.addEventListener("message", (event) => {
        let parsed = null;
        try { parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch { parsed = null; }
        if (parsed != null) onProviderEvent(parsed);
      });
      provider.addEventListener("error", () => {
        if (stopping) return;
        log("voice provider socket errored");
        // LOG-ONLY UNTIL 2026-09-10, and this is the one path a customer with a typo'd key actually
        // hits: the upgrade fails, node fires error and NEVER close, and the page sat on a listening
        // orb with a live microphone and an open ledger row until the session cap. Measured.
        if (!opened) return dialNeverOpened("the voice line never opened");
        if (meter.toolCalls === 0 && meter.audioOutBytes === 0) {
          return void close("the voice service refused this session", SENTENCE.providerRefused, "no-key");
        }
        return void close("the voice line errored", SENTENCE.providerGone, "line-dropped");
      });
      provider.addEventListener("close", (event) => {
        if (stopping) return;
        // A close on a socket that never spoke a word is a refused key, and that is the one thing
        // the person can fix themselves.
        const refused = meter.toolCalls === 0 && meter.audioOutBytes === 0 && secondsNow() < 10;
        log(`voice provider closed ${event?.code ?? ""} ${String(event?.reason ?? "").slice(0, 120)}`);
        void close("the voice service closed the line", refused ? SENTENCE.providerRefused : SENTENCE.providerGone, refused ? "no-key" : "line-dropped");
      });

      // The relay's own clock, on a ten second tick, and never a provider's warning: xAI emits no
      // rate_limits.updated, documents no duration or concurrency cap, and the "25 minutes" people
      // quote belongs to a different API. WALL seconds, because that is the only number a person
      // can predict, and docs/VOICE.md says so.
      let ticking = false;
      tick = setInterval(() => {
        const spent = secondsNow();
        if (spent >= sessionCapSeconds) { void close("the session cap", SENTENCE.sessionCap, "session-cap"); return; }
        // THE DAY IS RE-READ, not trusted from the open-time snapshot. `dayRemainingSeconds` was a
        // number taken once when the socket was accepted, so N sockets opened together each got the
        // whole remaining day and the cap multiplied by N: MEASURED on this Mac, ten sockets against
        // a 20 s day cap were all accepted and authorised 200 s between them. The fresh read counts
        // every open row including this one, so sessions that opened together converge on the same
        // budget and the first to cross it is the first to be closed.
        if (dayRemainingNow == null) {
          if (spent >= dayRemainingSeconds) { void close("the day cap", SENTENCE.dayCap, "day-cap"); return; }
          void ledger.touch(rowNow("open")).catch(() => {});
          return;
        }
        if (ticking) return;
        ticking = true;
        void Promise.resolve()
          .then(() => dayRemainingNow())
          .then((left) => {
            if (stopping) return undefined;
            if (Number.isFinite(left) && left <= 0) { void close("the day cap", SENTENCE.dayCap, "day-cap"); return undefined; }
            return ledger.touch(rowNow("open")).catch(() => {});
          })
          .catch((error) => log(`voice could not re-read the day: ${error?.message ?? error}`))
          .finally(() => { ticking = false; });
      }, capTickMs);
      tick.unref?.();
      return undefined;
    },
  };
  return session;
}

// ---- the edge: the settings door and the upgrade branch (A5) -------------------------------------

/**
 * Everything ui/server.mjs needs, behind two functions, so the lines that land in that shared file
 * are one import, two buildContext fields, one route line and one upgrade branch.
 */
export function makeVoiceEdge({
  t,
  call,
  policy,
  ownLikeParent = null,
  log = () => {},
  now = () => Date.now(),
  WebSocketImpl = null,
  providerUrl = "",
  capTickMs = CAP_TICK_MS,
  // How long a silent dial is waited on. A test and a gate shorten it so that proving the sentence
  // arrives is an assertion rather than an eight second wall-clock wait.
  dialWatchdogMs = DIAL_WATCHDOG_MS,
  newSessionId = () => `vs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
}) {
  const settingsFile = t.voiceSettingsFile;
  const ledgerFile = t.voiceLedgerFile;
  const sessions = new Set();
  /**
   * An upgrade that has passed the one-call-at-a-time check and has not yet put its session in the
   * set. Without it the check is useless: the rest of handleUpgrade awaits a ledger read, a roster
   * read and a claim, so ten presses arriving together ALL pass the check before any of them adds
   * anything -- MEASURED on this Mac, nine of ten sockets still got in with the set check alone.
   */
  let starting = false;
  /** The sessions that are really still running. A stopped one is forgotten on its own close. */
  const liveSessions = () => {
    for (const one of [...sessions]) if (one.stopped) sessions.delete(one);
    return sessions.size;
  };

  const ledgerFor = (sessionId) => ({
    sessionId,
    /** CLAIM BEFORE DIAL. See the ledger section above for why this is not a preference. */
    claim: async (row) => { await appendVoiceLedger(row, { file: ledgerFile, ownLikeParent }); void policy.report(row); },
    /** The open row's elapsed, kept in memory; the file only grows on claim and on settle. */
    touch: (row) => Promise.resolve(row),
    settle: async (row) => { await appendVoiceLedger(row, { file: ledgerFile, ownLikeParent }); void policy.report(row); },
  });

  async function handleSettings(req, res) {
    const sendJson = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const shapeNow = async (settings) => {
      const caps = await policy.for(t.slug);
      const rows = await readVoiceLedger(ledgerFile);
      const agents = (await rosterOf(call))
        .filter((a) => a?.isGroup !== true)
        .map((a) => ({ id: String(a.id), name: String(a.name ?? "") }));
      return voiceSettingsShape(settings, {
        agents,
        sessionCapSeconds: caps.sessionCapSeconds,
        dayCapSeconds: caps.dayCapSeconds,
        dayUsedSeconds: daySecondsUsed(rows, now(), { openCapSeconds: caps.sessionCapSeconds }),
        // No transcript and no audio is in the ledger, so this list is spend and nothing else.
        recent: rows.slice(-10).reverse().map((row) => ({
          sessionId: row.sessionId, startedAt: row.startedAt, endedAt: row.endedAt ?? null, state: row.state,
          wallSeconds: row.wallSeconds, audioInSeconds: row.audioInSeconds, audioOutSeconds: row.audioOutSeconds,
          toolCalls: row.toolCalls, heldFrames: row.heldFrames, agentName: row.agentName, closeReason: row.closeReason,
        })),
      });
    };
    if (req.method === "GET") return sendJson(200, await shapeNow(await readVoiceSettings(settingsFile)));
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "GET, POST" });
      return res.end(JSON.stringify({ error: "GET or POST" }));
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) {
        res.writeHead(413, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "that is too large to be a settings form" }));
      }
    }
    let patch = null;
    try { patch = JSON.parse(body || "{}"); } catch { patch = null; }
    if (patch == null) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "the body must be JSON" }));
    }
    const next = mergeVoiceSettings(await readVoiceSettings(settingsFile), patch);
    t.ensureDir();
    try { await writeVoiceSettings(next, { file: settingsFile, ownLikeParent }); }
    catch (error) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `could not write the voice settings: ${error instanceof Error ? error.message : String(error)}` }));
    }
    // The answer is the shape, which reports the key as a boolean. There is no route on this server
    // that reads a realtime key back out.
    return sendJson(200, await shapeNow(next));
  }

  /**
   * The upgrade. EVERY refusal from here on is 101 + one sentence + bye, never a destroyed socket:
   * an unknown upgrade path answers zero bytes and real Chrome reports only onerror at 16 ms with
   * no close code, which a person reads as "the relay is down".
   */
  async function handleUpgrade(req, socket, head, { origin = null } = {}) {
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const version = String(req.headers["sec-websocket-version"] ?? "13");
    // Not a refusal: this is not a browser websocket at all, so there is nobody to read a sentence.
    if (!WS_KEY_SHAPE.test(key) || version !== "13") return socket.destroy();
    if (head != null && head.length > 0) socket.unshift(head);
    if (origin === false) return acceptAndSay(socket, key, SENTENCE.badOrigin, "a cross-origin upgrade");

    const settings = await readVoiceSettings(settingsFile);
    if (settings.apiKey.length === 0) return acceptAndSay(socket, key, SENTENCE.noKey, "no realtime key", "no-key");
    if (!settings.enabled) return acceptAndSay(socket, key, SENTENCE.notEnabled, "voice is switched off");

    // ONE CALL AT A TIME FOR A WORKSPACE, and the reservation is taken HERE, in the same tick as the
    // check. The day cap is a number read off the ledger a few lines below, so N sockets opened
    // together would each read the same remaining day and the cap would multiply by N: MEASURED on
    // this Mac before this, ten sockets against a 20 s day cap were every one accepted, each told it
    // had the whole 20 s, and 200 s was authorised against a 20 s cap. The live set is what decides
    // and not the control plane's open-row count, because a row left open by a relay that died is
    // exactly that number and refusing on it would lock a workspace out over a fault nobody sees.
    if (starting || liveSessions() > 0) {
      const openAtCp = Number((await policy.for(t.slug))?.openSessions ?? 0);
      log(`voice ${t.slug} already holds ${liveSessions() + (starting ? 1 : 0)} live session(s) here and the control plane has ${openAtCp} row(s) open, so this press was refused in words`);
      return acceptAndSay(socket, key, SENTENCE.alreadyInCall, "this workspace is already in a call", "line-dropped");
    }
    starting = true;
    try {
      const caps = await policy.for(t.slug);
      if (!caps.vendors.includes(settings.vendor)) {
        return acceptAndSay(socket, key, "That voice service is not available on this console.", "the vendor is not allowed here");
      }

      const used = daySecondsUsed(await readVoiceLedger(ledgerFile), now(), { openCapSeconds: caps.sessionCapSeconds });
      const remaining = caps.dayCapSeconds - used;
      if (remaining <= 0) return acceptAndSay(socket, key, SENTENCE.dayCap, "the day cap", "day-cap");

      const agents = await rosterOf(call);
      const agent = resolveVoiceAgent(agents, settings);
      if (agent.agentId.length === 0) return acceptAndSay(socket, key, `${SENTENCE.noAgent} Reason: ${agent.why}.`, "no agent");
      log(`voice ${t.slug} talks to ${agent.agentName || agent.agentId}: ${agent.why}`);

      const sessionId = newSessionId();
      const ledger = ledgerFor(sessionId);
      const session = makeVoiceSession({
        t, settings, policy, agent, call, ledger, sessionId, now, WebSocketImpl, providerUrl, capTickMs, log,
        dialWatchdogMs,
        onClosed: (one) => { sessions.delete(one); },
      });
      // THE ROW EXISTS BEFORE THE PROVIDER HEARS A BYTE. A row written on close does not exist for a
      // crashed relay or a tab closed mid-sentence, and the day cap is read from this same file.
      try { t.ensureDir(); await ledger.claim(session.row("open", "")); }
      catch (error) {
        log(`voice could not claim a ledger row: ${error?.message ?? error}`);
        return acceptAndSay(socket, key, SENTENCE.busy, "the ledger would not take the claim");
      }
      sessions.add(session);
      session.start(socket, key, {
        sessionCapSeconds: Math.min(caps.sessionCapSeconds, remaining),
        dayRemainingSeconds: remaining,
        // What is left of the day RIGHT NOW, re-read from the ledger on every tick rather than taken
        // from the number above. Every open row counts, this one included, which is what makes two
        // sessions that opened together converge instead of each spending a whole day.
        dayRemainingNow: async () => {
          const spent = daySecondsUsed(await readVoiceLedger(ledgerFile), now(), { openCapSeconds: caps.sessionCapSeconds });
          return caps.dayCapSeconds - spent;
        },
      });
      return session;
    } finally {
      // The reservation ends here whatever happened: a session that got in is in the set by now, and
      // one that was refused must not hold the next press out.
      starting = false;
    }
  }

  return { handleSettings, handleUpgrade, get sessions() { return [...sessions]; } };
}

/**
 * Whether an upgrade's Origin is this console's own.
 *
 * X-Forwarded-Host when present and Host otherwise, because on the R750 the relay sits behind
 * Traefik and Cloudflare and its own Host header is the container's. True when allowed, false when
 * refused, and null when there is no Origin at all -- a native client, a gate, or curl, none of
 * which a browser's cross-site attacker can be.
 */
export function originAllowed(req) {
  const origin = String(req?.headers?.origin ?? "").trim();
  if (origin.length === 0) return null;
  const forwarded = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  const host = forwarded.length > 0 ? forwarded : String(req.headers.host ?? "").trim();
  if (host.length === 0) return false;
  let parsed = null;
  try { parsed = new URL(origin); } catch { return false; }
  // The name is what is checked, not the port: a developer's console is 127.0.0.1:8848 behind a
  // Host of 127.0.0.1:8848, and on the public name the port is the proxy's business.
  return parsed.hostname.toLowerCase() === host.split(":")[0].toLowerCase();
}

// ---- what ui/server.mjs actually calls -----------------------------------------------------------
//
// The footprint in that file is deliberately four edits and no more -- one import, two buildContext
// fields beside the mail pair, one route line beside /mail/settings, one branch in the ONE existing
// upgrade handler -- because three waves share it and every one of those is a surgical stage after
// a rebase. Everything else that would otherwise have to live there (the per-tenant edge cache, the
// gateway caller, the policy reader) lives here instead.

/**
 * The gateway, called in-process with this tenant's own bearer and parsed.
 *
 * jobBusCall in ui/server.mjs answers the HTTP shape ({status, text, type}) because its callers
 * forward it to a customer; a poll loop wants the body or a throw. Same fetch, same headers, same
 * choke point -- t.headers() -- and a non-200 throws so every caller in this file can catch it and
 * RETURN A SENTENCE rather than dying with the microphone open.
 */
export function makeGatewayCall(t, { timeoutMs = 20000 } = {}) {
  return async (command, args = {}) => {
    const answer = await fetch(`${t.gateway}/api/${command}`, {
      method: "POST",
      headers: t.headers({ "content-type": "application/json" }),
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await answer.text();
    if (!answer.ok) throw new Error(`${command} answered HTTP ${answer.status}: ${text.slice(0, 160)}`);
    if (text.length === 0) return {};
    try { return JSON.parse(text); } catch { return {}; }
  };
}

const voiceEdges = new Map();

/**
 * One edge per workspace, rebuilt when the tenant's state directory moves under it -- the same
 * cache shape and the same invalidation mailEdgeFor uses, so a tenant re-provisioned under a live
 * relay does not keep writing to a path that is no longer theirs.
 */
export function voiceEdgeFor(t, { ownLikeParent = null, log = () => {}, relayBase = "", relayToken = "", WebSocketImpl = null, providerUrl = "" } = {}) {
  const found = voiceEdges.get(t.slug);
  if (found != null && found.settingsFile === t.voiceSettingsFile) return found.edge;
  const edge = makeVoiceEdge({
    t,
    call: makeGatewayCall(t),
    policy: makeVoicePolicy({ relayBase, relayToken, log }),
    ownLikeParent,
    log,
    WebSocketImpl,
    providerUrl,
  });
  voiceEdges.set(t.slug, { settingsFile: t.voiceSettingsFile, edge });
  return edge;
}

/** The route this upgrade branch answers, and nothing else on the relay answers it. */
export const VOICE_SOCKET_PATH = "/voice/socket";
