/**
 * VOICE-1. The relay's half of talking to Titan out loud.
 *
 * WHAT THIS IS. One websocket from the browser to this relay (the console's own cookie is the
 * credential; the tenant is stamped here and never sent by the page), one websocket from here to a
 * realtime provider with the workspace's own key, and between them ONE tool: titan(message).
 *
 * VOICE-16 CHANGED WHAT THE MODEL ON THE OTHER END IS, and this paragraph used to say the opposite.
 * It said the realtime model "is a mouth and a pair of ears. It does not search, it does not
 * remember, it does not decide anything", and that was true and it was also why a conversation was a
 * sequence of pauses: every syllable, "thanks" included, cost a whole turn of the agent runtime, 5.5
 * to 25 s of it. Jason, 2026-09-12: "Why can't the voice just be Titan?" So the voice now IS the
 * agent for CONVERSATION. Before the dial this edge reads one gateway command, `getVoiceBrief`
 * (source/host/extensions/transcript/voice-brief.ts), which hands back the same three things the
 * agent's own prompt is built from -- its persona, its remembered facts, and the last twenty turns of
 * its conversation -- and folds them into the session instructions ONCE, at session.update. A
 * question it can answer out of that is answered in under two seconds with no sendPrompt at all.
 *
 * THE BOX STILL DOES THE WORK. Anything that needs DOING, LOOKING UP or CHECKING goes to the agent
 * through titan(message) exactly as it always did, and so does every answer to a question that came
 * back from there: a spoken yes still resolves a held card through the approval path and never in the
 * voice's own head. Tools, files, machines, mail, the team and every approval stay the agent's, the
 * thread stays one thread, and a spoken turn is still an ordinary prompt carrying a `voice:`
 * clientNonce. At close the whole spoken exchange goes back as ONE note, so the conversation on
 * screen holds what was said out loud -- and VOICE-16c FILES that note as a row instead of asking it
 * as a prompt, so the agent has nothing to answer and nobody gets a message they did not ask for.
 *
 * AND A BOX WHOSE HOST HAS NO `getVoiceBrief` IS UNCHANGED. It answers 404, the reader says so in the
 * log, and the line dials with `phoneLineInstructions` -- the words above, byte for byte, which a
 * test asserts literally.
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
 *   2. Titan's reply did NOT stream, and VOICE-3 built the surface that makes it. Measured on
 *      grok-bot-local-vm: the reply landed as ONE complete `send-message` entry 5.5 to 25 s after
 *      sendPrompt (50.6 s on a cold box), with no partial text and no in-place growth, because the
 *      host dropped the SendMessage tool call from every gateway surface. As of 2026-09-12 the host
 *      projects the message it is part way through writing behind one new command, `getTurnDraft`
 *      (source/host/extensions/transcript/turn-draft.ts), and the turn runner below reads it on the
 *      same 400 ms tick it already polls the tail on, handing the FIRST sentence over as it becomes
 *      whole -- VOICE-16b capped it at that one, and the rest of the answer goes back on the tool
 *      output for the model to say short. BOTH PATHS ARE LIVE AND BOTH ARE TESTED: a box whose host
 *      predates that command
 *      answers 404, the reader stops asking, and the turn is the original WAIT-THEN-SPLIT seam with
 *      the acknowledgement carrying the silence. What this file still does not do is claim the
 *      vendor streams: the sentences are cut here, from the host's draft, and the finished entry
 *      read out of the transcript is still the truth about what he said.
 *   3. The key is the OPERATOR's, and KEYS-1 moved it. It used to be a per-workspace secret a
 *      customer typed into their own Voice card; Jason, 2026-09-10, over that panel: "A user is
 *      never going to put a resend key in. That's on the backend." So the super admin pastes it once
 *      at api.titanium.bot/admin under "Keys the product uses", the relay reads it from
 *      GET /v1/relay/keys behind CP_RELAY_TOKEN and holds it in memory (ui/relay-secrets.mjs), and
 *      keyFor() below prefers that over this workspace's own voice.json -- the file second, nothing
 *      third, which is the whole of the migration. It still reaches the vendor as an Authorization
 *      HEADER only. It is still NOT on the super-admin Providers panel: those keys are global, they
 *      live at LiteLLM as credentials and read back masked, and a realtime key is not a LiteLLM
 *      deployment. That is PROVIDERS-10, and the two cosmetic realtime rows there are now deleted.
 *
 * BARGE-IN IS THE PHONE APP'S AND NOTHING ELSE'S (VOICE-14). The echo gate below is why a browser's
 * microphone cannot hear the agent speak, and for a browser it is unchanged. A page inside the iPhone
 * app says `bargeIn: true` on its opening frame and gets a different line: its frames are never held,
 * and an `input_audio_buffer.speech_started` arriving while audio is STILL BOOKED to be playing
 * cancels the reply at the provider and tells the page to throw away what it has queued. Why the
 * phone and not a laptop: the app owns the audio session and iOS takes the agent's own voice out of
 * the microphone, so the thing the gate defends against is not in the room. The relay takes the page's
 * WORD for which host it is in -- there is nothing on a socket that proves an app -- so the first
 * `hello` wins and what that word can buy is bounded by the two audio ceilings further down and by
 * nothing else: it cannot raise a cap, spend another workspace's minutes or reach a key.
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

// KEYS-1. Which of the operator's keys dials for a given service. The name table and nothing else:
// the reader itself is built once in ui/server.mjs and handed to this edge.
import { voiceKeyName } from "./relay-secrets.mjs";

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

/**
 * The one tool. One string parameter, and nothing else is ever added to this array.
 *
 * VOICE-16 CHANGED WHAT IT IS FOR, not what it is. It used to say "call this for EVERYTHING the
 * person asks or tells you", because the voice genuinely knew nothing: the description and the
 * instructions below were a phone line's, and every syllable cost a whole turn of the agent runtime.
 * Now the voice carries the agent's own persona, facts and conversation (`getVoiceBrief`), so this is
 * the seam for a JOB and not for a sentence -- do it, look it up, or check it. The result path is
 * untouched: VOICE-3 sentence streaming, held cards and the spoken yes all still come back through
 * the same output.
 *
 * VOICE-16b CHANGED FIVE WORDS OF IT, and only because leaving them contradicts the instructions. The
 * description used to finish "then read out what comes back", which is the exact behaviour the spoken
 * contract in voiceInstructions now forbids; a tool description and a system prompt that disagree is a
 * prompt that argues with itself, and the model resolves that however it likes. Nothing else here moved.
 */
export function titanTool() {
  return {
    type: "function",
    name: "titan",
    description:
      "Hand a job to the rest of yourself: the part of you at the desk, with the files, the machines, "
      + "the mail, the team and every tool. Call this to DO something, to LOOK something up, or to "
      + "CHECK something -- send it, run it, open it, read it, fix it, book it, a file, a machine, a "
      + "log, a number you do not already have, anything that has happened since you last spoke, and "
      + "anything at all you are not sure of. Do NOT call it for ordinary conversation you can already "
      + "answer out of who you are and what you remember. Say one short thing first, like \"checking "
      + "the mail now\", so the line is not silent, and then say the gist of what comes back in one "
      + "short sentence. It takes five to twenty-five seconds.",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "The job, in the person's own words." } },
      required: ["message"],
    },
  };
}

/**
 * THE PHONE LINE. What every voice session was told until VOICE-16, and what a box whose host has no
 * `getVoiceBrief` is still told, byte for byte.
 *
 * It is kept as its own function rather than inlined into the fallback branch so that the fallback is
 * provably the same words and not a paraphrase of them -- tests/voice-turn.test.mjs asserts this
 * string literally, so an edit here fails there.
 */
export function phoneLineInstructions(agentName = "Titan") {
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
 * The base instructions, written ONCE at session.update and byte-identical for the life of the
 * socket. Rewriting them invalidates the cached prefix and re-bills the whole conversation every
 * turn, which was the single most expensive thing omarchy's session did -- the same lesson as
 * m3-glm-prefix-cache.md. NOTHING PER-TURN GOES IN HERE, and VOICE-16 does not change that: the brief
 * is read once, before the dial, and folded in once, at session.update.
 *
 * WHAT VOICE-16 CHANGED. Jason, 2026-09-12, about the pause before every single answer: "Why can't
 * the voice just be Titan?" So with a brief this is no longer a phone line's script. The voice is
 * handed the same three things the agent's own prompt is built from -- its persona, its remembered
 * facts, and the last turns of the conversation -- and answers conversation out of them, in under two
 * seconds, with no round trip at all. A JOB still goes to the box through the titan function, because
 * the box is where the files, the machines, the mail and the team are.
 *
 * THE ONE RULE THAT SURVIVED WORD FOR WORD is the held card. A question that came back from the box
 * asking the person to confirm or choose is resolved by the relay through the approval path
 * (makeVoiceSession's dispatch reads matchYesNo against session.heldCard), so their answer HAS to
 * arrive as a titan call. A voice that answered "yes, go ahead" out of its own head would leave the
 * card open and nothing approved, which is the worst outcome on this path.
 *
 * WHAT VOICE-16b ADDED. Two sections at the end, the spoken contract: a phone voice is one or two
 * short conversational sentences, and a result that comes back from the box is given as a gist rather
 * than read out. It lives HERE, in the once-per-call instructions, and not in a per-turn hint, for the
 * same cached-prefix reason everything else in this function lives here. The tool output on a streamed
 * turn carries the one per-turn thing that cannot be known in advance -- which sentence the person has
 * already heard -- and nothing else.
 *
 * NO BRIEF, NO CHANGE. `brief: null` -- an older host, a box that does not hold that agent any more,
 * a read that timed out -- answers phoneLineInstructions above, byte for byte. The spoken contract is
 * NOT back-ported into it: that string is pinned literally by a test as the thing it always was, and a
 * box old enough to miss `getVoiceBrief` is a box nobody is tuning the voice of.
 *
 * @param {string|{agentName?: string, brief?: object|null}} [options] the agent's name, or the name
 *        and the brief. The string form is what buildSession's own default uses and is unchanged.
 */
export function voiceInstructions(options = {}) {
  const flat = typeof options === "string" || options == null;
  const agentName = flat ? options : options.agentName;
  const brief = flat ? null : options.brief;
  const name = String(agentName ?? "").trim() || "Titan";
  if (brief == null || typeof brief !== "object") return phoneLineInstructions(name);
  const line = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const persona = String(brief.persona ?? "").trim();
  const facts = (Array.isArray(brief.facts) ? brief.facts : []).map(line).filter((fact) => fact.length > 0);
  const recent = (Array.isArray(brief.recent) ? brief.recent : [])
    .map((turn) => ({ role: String(turn?.role ?? ""), text: line(turn?.text) }))
    .filter((turn) => turn.text.length > 0);
  const place = line(brief.workspaceName);
  const out = [
    `You are ${name}, and you are talking out loud to the person who called you. You are not `
    + `${name}'s phone line and you are not reading his words to somebody: you ARE him, on the phone. `
    + "Everything below is yours -- who you are, what you remember, and what the two of you have been "
    + "saying. Answer out of it, straight away, in your own voice, the way a person on a phone does.",
  ];
  if (persona.length > 0) out.push(`WHO YOU ARE.\n${persona}`);
  if (facts.length > 0) out.push(`WHAT YOU REMEMBER.\n${facts.map((fact) => `- ${fact}`).join("\n")}`);
  if (recent.length > 0) {
    out.push(`WHAT THE TWO OF YOU HAVE BEEN SAYING, oldest first. "Them" is the person you are on the `
      + `phone with now.\n${recent.map((turn) => `${turn.role === "person" ? "Them" : "You"}: ${turn.text}`).join("\n")}`);
  }
  if (place.length > 0) {
    out.push(`WHERE THIS IS. The workspace you both work in is called ${place}. Say that name only if `
      + "the person asks which workspace or which machine they are on.");
  }
  out.push(
    "WHEN TO USE THE titan FUNCTION. You are the part of you that is talking. The rest of you is at "
    + "the desk, with the files, the machines, the mail, the team and every tool. Send it anything "
    + "that needs DOING, LOOKING UP or CHECKING: send it, run it, open it, read it, fix it, book it, "
    + "a file, a machine, a log, a number you do not already have, anything that has happened since "
    + "the conversation above, and anything at all you are not sure of. Say one short thing first, "
    + "like \"checking the mail now\", so the line is not silent, and then say the gist of what comes "
    + "back in a sentence. It takes five to twenty-five seconds.",
    "ANSWERS TO A QUESTION THAT CAME BACK ALWAYS GO THROUGH IT. If you read out something that asks "
    + "the person to confirm, approve or choose, their answer goes straight back through the titan "
    + "function, every time, even when it is only yes or no. Never treat a yes as done yourself: "
    + "nothing is approved until it has been back through there.",
    "WHEN NOT TO USE IT. Ordinary talk you can already answer -- who you are, what you do, what the "
    + "two of you just decided, something you remember, what a thing means, an opinion, a greeting, "
    + "a thank you. Answer those yourself, immediately, with no function call and no waiting.",
    "NEVER MAKE ANYTHING UP. Not a number, not a name, not a file, not a result, and never a thing "
    + "you did. If you do not have it, the rest of you does: call titan and ask. If what comes back "
    + "says something went wrong, say so plainly.",
    // VOICE-16b. THE SPOKEN CONTRACT, and it is the rule this voice breaks most. Jason, 2026-09-12,
    // after the first working call: "it needs to be shorter and more conversational. Instead of
    // repeating everything it did, it can say, 'Yep, I did it.' ... less like a syllabus coming back
    // every time." The text on screen is unchanged and still carries everything; this is about the
    // mouth. It is written ONCE, here, like every other line of these instructions.
    "HOW YOU SOUND, AND THIS IS THE ONE YOU WILL GET WRONG. You are on a phone. Everything you say is "
    + "one or two short sentences in plain conversational words, the way a person answers a phone. No "
    + "lists, no headings, no numbered steps, no file paths, no code, no punctuation read out, and "
    + "never the sound of a screen being read.",
    "WHAT YOU SAY WHEN SOMETHING COMES BACK FROM THE titan FUNCTION. Do not repeat it and do not read "
    + "it out. Give the gist in one breath, the way you would over your shoulder: \"Yep, did that.\" "
    + "\"Done. The backup ran clean.\" \"That one failed, I am on it.\" Only if there is more to it "
    + "than you just said, add in a few words that the rest is on the screen. Never walk back through "
    + "what you did, never say it twice, and never turn one result into a summary with parts.",
  );
  return out.join("\n\n");
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
export const providerErrorIsQuiet = (event) => QUIET_PROVIDER_CODES.has(String(event?.error?.code ?? ""))
  // xAI answers a response.cancel that lands after the response finished with a generic
  // invalid_request_error whose message says what happened. MEASURED on the R750 2026-09-12 twice
  // in one barge-in call: a race nobody can hear, not a fault.
  || /^Cancellation failed/.test(String(event?.error?.message ?? ""));

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

// ---- VOICE-3: sentences out of a reply that is still being written ------------------------------
//
// THE SEAM THIS IS. The host now projects the message Titan is part way through writing as one small
// object behind the `getTurnDraft` gateway command (source/host/extensions/transcript/turn-draft.ts).
// The turn runner below reads it on the same 400 ms tick it already polls the tail on, cuts whole
// sentences off the front, and hands each one to the voice model the moment it is complete, so the
// person hears sentence one while Titan is still typing sentence four. The two functions here are the
// whole of the arithmetic, kept pure and exported so a test can drive a growing string through them
// without a socket.
//
// WHAT A DRAFT IS NOT. It is not the answer. It is the FIRST delivered message of the turn, it is
// capped at 20,000 characters by the projection it comes from, and a reply long enough to hit that cap
// loses its tail there. The finished entry read out of the transcript is still the truth, and
// remainderOf is what stops the person hearing the first half of it twice.

/**
 * VOICE-16b. How many sentences of the draft are ever read out word for word.
 *
 * ONE. The first sentence is the latency win VOICE-3 was built for -- the person hears something
 * twenty seconds before the entry is persisted -- and every sentence after it is the thing Jason
 * asked to stop: "less like a syllabus coming back every time". So sentence one is read as it lands,
 * and the REST of the answer goes back through the tool output for the model to say in its own short
 * words, under the spoken contract in voiceInstructions.
 *
 * It is a cap on what is SPOKEN and not on what is known. The page, the conversation and the tool
 * output all still carry the whole reply.
 */
export const SPOKEN_LEAD_SENTENCES = 1;

/**
 * VOICE-16b. What the tool output says about the part of the answer nobody has heard.
 *
 * It rides on the `function_call_output` and NOT in the session instructions, because it is the one
 * thing on this path that cannot be known once per call: which sentence the person has already heard
 * is a per-turn fact. The standing contract -- short, conversational, no lists, give the gist -- is in
 * voiceInstructions, written once at session.update, where the cached prefix lives.
 *
 * It is deliberately permissive about saying NOTHING. A one-sentence answer that was already read out
 * in full takes a different branch and never sees this, but a two-sentence answer whose second
 * sentence adds nothing is common, and "or nothing at all" is what stops the voice padding.
 */
export const SPOKEN_REMAINDER_HINT = "The person has ALREADY heard the first sentence of this out loud. "
  + "Say the rest in ONE short spoken sentence, in your own plain words, or say nothing at all if the "
  + "first sentence already covered it. Do not read this out word for word, do not repeat what they have "
  + "heard, and do not turn it into a list. The whole answer is on their screen either way.";

/**
 * Whole sentences off the front of a draft, once each, up to `limit` of them.
 *
 * The LAST piece of an unfinished draft is never handed out: splitSentences cannot know whether a
 * trailing fragment is a short sentence or the first four words of a long one, so it waits for text
 * to arrive behind it. A draft the host has marked finished has no such doubt and every piece goes.
 *
 * A draft that was REWRITTEN rather than extended -- the model revising what it already wrote -- is
 * not repaired here. Words already spoken cannot be unsaid, so only genuinely new tail pieces are
 * handed out, and the divergence is settled once, against the finished reply, by remainderOf.
 *
 * WHY THE LIMIT IS IN HERE rather than in the loop that calls it. `spoken` is what remainderOf
 * subtracts to work out what the person has NOT heard, so it has to mean "handed out", exactly. A
 * caller that cut three sentences and then spoke only the first would leave two sentences recorded as
 * said and nobody would ever hear them. Refusing to cut them is the only shape where the record and
 * the room agree. `done` is how the caller knows it can stop reading the draft at all.
 */
export function makeSentenceCutter({ max = 320, limit = Infinity } = {}) {
  const spoken = [];
  return {
    /** Everything handed out so far, in the order it was said. */
    get spoken() { return spoken.slice(); },
    get count() { return spoken.length; },
    /** Whether the limit is reached, so there is nothing left for this cutter to ever hand out. */
    get done() { return spoken.length >= limit; },
    cut(draftText, { complete = false } = {}) {
      if (spoken.length >= limit) return [];
      const pieces = splitSentences(draftText, { max });
      const ready = complete ? pieces : pieces.slice(0, -1);
      if (ready.length <= spoken.length) return [];
      const fresh = ready.slice(spoken.length, limit);
      for (const piece of fresh) spoken.push(piece);
      return fresh;
    },
  };
}

/**
 * What is left to say once the finished reply lands, given what was already said.
 *
 * Both lists come out of the same splitSentences, so a draft that was a clean prefix of the reply
 * produces identical leading pieces and the match is exact. The first piece that does not match is
 * where the remainder begins, which is also the right repair when the model revised itself: the
 * person hears the corrected text from the point it changed rather than nothing at all.
 */
export function remainderOf(allPieces, spokenPieces) {
  const all = Array.isArray(allPieces) ? allPieces : [];
  const said = Array.isArray(spokenPieces) ? spokenPieces : [];
  let same = 0;
  while (same < said.length && same < all.length && said[same] === all[same]) same += 1;
  return { pieces: all.slice(same), diverged: same < said.length };
}

/**
 * Whether a gateway error means "this host has never heard of that command" rather than "that call
 * did not get through". Only the first kind turns streaming off for the rest of the session: a box
 * under load answering one 504 must not cost every later turn its first sentence.
 */
export function isUnknownGatewayMethod(error) {
  const message = String(error?.message ?? error ?? "");
  return message.includes("unknown gateway method") || message.includes("HTTP 404");
}

// ---- VOICE-16: the brief, and the one memory the call leaves behind -------------------------------

/**
 * How long the brief read may hold the handshake up.
 *
 * It is read in handleUpgrade, in the same stretch that already awaits the settings file, the
 * operator's key, the policy, the ledger and the roster, and BEFORE the provider is dialled -- which
 * is what keeps the provider's `open` handler synchronous. That handler sends session.update the
 * instant the socket opens, and an await inside it would let forwarded microphone audio reach the
 * provider before its session was configured.
 *
 * The budget exists because a wedged box answers a gateway read in 20 s (makeGatewayCall's own
 * timeout) and a person pressing the talk button must not wait 20 s for a microphone. A brief that
 * does not arrive in time is no brief, and the line is the phone line it always was.
 */
export const VOICE_BRIEF_READ_MS = 2500;

/**
 * The brief, once, before the dial.
 *
 * EVERY FAILURE IS null AND NEVER A THROW, and that is the whole fallback: an older host (404, which
 * `isUnknownGatewayMethod` is the existing reader for), a box that no longer holds that agent
 * (`{brief:null}`, which the host answers as a fact), a read that timed out, a malformed answer. Each
 * of those dials with phoneLineInstructions, byte for byte, and the relay logs which one it was
 * because "the voice does not know anything today" is otherwise indistinguishable between them.
 *
 * THE WORKSPACE NAME IS THE RELAY'S when it has one. The box answers its own SAND_TENANT or its
 * hostname, which is a container name on the R750; the tenant's display name is what a person calls
 * the place, and this edge is the only half that knows it.
 */
export async function readVoiceBrief(call, agentId, {
  workspaceName = "",
  timeoutMs = VOICE_BRIEF_READ_MS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const id = String(agentId ?? "");
  if (id.length === 0) return null;
  const started = now();
  const LATE = Symbol("late");
  let answer = null;
  // THE TIMER IS NOT unref'd, and every other timer in this file is. An unref'd timer cannot fire when
  // nothing else is holding the event loop open, so the await would never settle and the budget would
  // be no budget at all. It is cleared the instant either side answers, so it holds the loop for at
  // most the budget and never for longer.
  let timer = null;
  try {
    answer = await Promise.race([
      Promise.resolve(call("getVoiceBrief", { id })).finally(() => { if (timer != null) clearTimeout(timer); }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(LATE), Math.max(1, Number(timeoutMs) || VOICE_BRIEF_READ_MS));
      }),
    ]);
  } catch (error) {
    if (isUnknownGatewayMethod(error)) log("voice getVoiceBrief is not on this box's host, so this line is a phone line");
    else log(`voice could not read the brief, so this line is a phone line: ${error?.message ?? error}`);
    return null;
  } finally {
    if (timer != null) clearTimeout(timer);
  }
  if (answer === LATE) {
    log(`voice gave up on the brief after ${timeoutMs} ms, so this line is a phone line`);
    return null;
  }
  const raw = answer?.brief ?? null;
  if (raw == null || typeof raw !== "object") {
    log("voice this box holds no brief for that agent, so this line is a phone line");
    return null;
  }
  const text = (value) => (typeof value === "string" ? value : "");
  const brief = {
    persona: text(raw.persona),
    facts: (Array.isArray(raw.facts) ? raw.facts : []).map(text).filter((fact) => fact.trim().length > 0),
    recent: (Array.isArray(raw.recent) ? raw.recent : [])
      .map((turn) => ({ role: text(turn?.role) === "person" ? "person" : "agent", text: text(turn?.text), at: Number(turn?.at) || 0 }))
      .filter((turn) => turn.text.trim().length > 0),
    agentName: text(raw.agentName),
    workspaceName: workspaceName.trim().length > 0 ? workspaceName.trim() : text(raw.workspaceName),
  };
  log(`voice brief for ${id}: ${brief.persona.length} character(s) of persona, ${brief.facts.length} fact(s), `
    + `${brief.recent.length} turn(s) of conversation, read in ${now() - started} ms`);
  return brief;
}

/**
 * How long the closing note may hold the line shut.
 *
 * The ledger row is settled BEFORE the note is written, so the day cap and the Spend line are never
 * delayed by it. What is still behind it is the session being released, which is what lets the next
 * press in: a person who hangs up and presses again must not be told "this workspace is already in a
 * call" because a box was slow to take a note. A note abandoned here may still land on the box, and
 * the log says so rather than claiming it failed.
 */
export const VOICE_NOTE_WRITE_MS = 5000;

/** At most this many spoken lines are kept for the closing note; the oldest go first. */
export const VOICE_NOTE_MAX_ROWS = 400;
/** And at most this many characters of them are written into it. */
export const VOICE_NOTE_MAX_CHARS = 6000;

/**
 * What was actually said out loud, both sides, in the order it was said.
 *
 * WHY A MAP AND NOT AN ARRAY. Both sides arrive in pieces that REPLACE rather than append: the
 * person's caption is replace-whole on both vendors (makeCaption says why), and the voice's own
 * transcript arrives as deltas and then as a settled whole. A Map keyed by the item keeps insertion
 * ORDER while letting a later, better copy of the same item overwrite the earlier one, which an array
 * of pushes cannot do without writing every sentence twice.
 *
 * THE KEY IS THE ITEM, not the turn. `item_id` is what both vendors stamp on every transcript event
 * of one spoken item, so the deltas, the `.done` and the `response.output_item.done` for one item all
 * land on one row. A vendor that omits it falls back to the response id, which is coarser: two
 * message items in one response would collapse into one row. That is the one shape this cannot tell
 * apart and it is named in docs/VOICE.md rather than guessed at.
 */
export function makeSpokenExchange({ maxRows = VOICE_NOTE_MAX_ROWS } = {}) {
  const rows = new Map();
  /** Deltas for an item, accumulated, because a delta is a piece and not the whole. */
  const growing = new Map();
  const put = (who, key, value) => {
    const clean = String(value ?? "").replace(/\s+/g, " ").trim();
    if (clean.length === 0) return undefined;
    rows.set(`${who}:${String(key ?? "")}`, { who, text: clean });
    while (rows.size > Math.max(1, maxRows)) rows.delete(rows.keys().next().value);
    return undefined;
  };
  const keyOf = (event) => String(event?.item_id ?? event?.item?.id ?? event?.response_id ?? event?.response?.id ?? "");
  /** The transcript carried by one output item, whichever content part holds it. */
  const transcriptOf = (item) => {
    if (item == null || item.type !== "message") return "";
    const parts = Array.isArray(item.content) ? item.content : [];
    const said = parts
      .map((part) => (typeof part?.transcript === "string" ? part.transcript : (typeof part?.text === "string" ? part.text : "")))
      .filter((part) => part.trim().length > 0);
    return said.join(" ");
  };
  return {
    /** The person, from the caption. The final transcript replaces the partials on the same item. */
    person: (itemId, value) => put("person", itemId, value),
    /**
     * The voice, from whichever of the three surfaces carried it. The later and more authoritative
     * one overwrites the earlier on the same item: deltas, then `.done`, then the item on
     * `response.done`. Anything that is not one of those is ignored, so this can be called for every
     * provider event without a branch at the call site.
     */
    voice: (type, event) => {
      const name = canonicalEvent(type);
      if (name === "response.output_audio_transcript.delta") {
        const key = keyOf(event);
        const grown = `${growing.get(key) ?? ""}${String(event?.delta ?? "")}`;
        growing.set(key, grown);
        return put("voice", key, grown);
      }
      if (name === "response.output_audio_transcript.done") {
        const key = keyOf(event);
        growing.delete(key);
        return put("voice", key, event?.transcript);
      }
      if (name === "response.output_item.done") {
        const key = keyOf(event);
        const said = transcriptOf(event?.item);
        if (said.length > 0) growing.delete(key);
        return put("voice", key, said);
      }
      if (name === "response.done") {
        for (const item of Array.isArray(event?.response?.output) ? event.response.output : []) {
          const said = transcriptOf(item);
          if (said.length === 0) continue;
          const key = String(item?.id ?? event?.response?.id ?? "");
          growing.delete(key);
          put("voice", key, said);
        }
        return undefined;
      }
      return undefined;
    },
    get rows() { return [...rows.values()]; },
    get size() { return rows.size; },
  };
}

/** A minute-precision UTC stamp, which is the most a spoken call is worth recording to. */
const noteStamp = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString().replace(/:\d\d\.\d+Z$/, "Z") : "");

/**
 * The ONE memory a call leaves behind: the whole spoken exchange, as a single prompt.
 *
 * WHY IT STILL ASKS, though on a current host nobody is listening. The brief said to tag it so the box
 * files it and does not answer, "if none exists, the note asks Titan in one line". MEASURED at the
 * time: no such flag existed. The host's sendPrompt takes agentId, directAddressedAcceptance,
 * attachments, richText, replyToId, clientNonce, thinkHarder, isFork, traceparent, enterEpochMs,
 * composedAtMs and awaitTurn (host-gateway-api.ts sendPrompt) and not one of them suppresses the
 * reply. The hidden prompt that box hand-offs, MCP authorizations and widget answers ride
 * (`boxHandoff.resumeWithHiddenPrompt`) is not on the gateway protocol at all, and it RESUMES a turn
 * rather than silencing one, so it is the wrong mechanism even if it were reachable.
 *
 * VOICE-16c answered that by adding the verb rather than a flag: `appendTranscriptNote` writes this
 * text as the person's own row and runs no turn, so on a current host the sentences below are read by
 * nobody and cost nothing. They STAY because `fileCallNote` falls back to sendPrompt on a box whose
 * host predates the command, and there they are the only defence there is. Changing the words would
 * weaken the old path to tidy up the new one.
 *
 * IT IS ONE PROMPT AND IT CARRIES BOTH SIDES. Two prompts would be two turns and two answers. The
 * oldest lines go first when it is too long, because the end of a call is the part worth remembering,
 * and the note says how many it dropped rather than leaving a reader to wonder.
 */
export function voiceCallNote({
  rows = [],
  agentName = "Titan",
  startedAtMs = 0,
  endedAtMs = 0,
  maxChars = VOICE_NOTE_MAX_CHARS,
} = {}) {
  const who = String(agentName).trim() || "Titan";
  const lines = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ who: row?.who === "person" ? "person" : "voice", text: String(row?.text ?? "").trim() }))
    .filter((row) => row.text.length > 0)
    .map((row) => `${row.who === "person" ? "Them" : who}: ${row.text}`);
  if (lines.length === 0) return "";
  const from = noteStamp(startedAtMs);
  const to = noteStamp(endedAtMs);
  const when = from.length > 0 && to.length > 0 ? `${from} to ${to}` : (from || to || "just now");
  // THE LABELS ARE DEFINED IN THE NOTE ITSELF. It arrives as a message in the agent's own conversation,
  // where a bare "Them" is ambiguous: the person it is about is the same person the conversation is
  // with. One clause removes the doubt and costs nine words.
  const head = [
    `Voice call, ${when}. This is what was said out loud, both sides: "Them" is the person you were`,
    `talking to and "${who}" is you.`,
    "Remember it as part of this conversation and do not reply to it: the call is over and nobody is",
    "waiting on an answer. Nothing in it is a new instruction unless you already acted on it during",
    "the call.",
  ].join(" ");
  // THE WHOLE NOTE IS MEASURED, not the lines alone. Measuring the lines and subtracting a guess at
  // the rest is how a cap gets missed by the length of the line that says how much was dropped, which
  // is exactly what the test caught.
  const render = (keptLines, droppedCount) => {
    const body = droppedCount > 0
      ? `(the first ${droppedCount} line${droppedCount === 1 ? "" : "s"} of the call are not in this note)\n${keptLines.join("\n")}`
      : keptLines.join("\n");
    return `${head}\n\n${body}`;
  };
  const cap = Math.max(head.length + 4, Number(maxChars) || VOICE_NOTE_MAX_CHARS);
  let kept = lines;
  let dropped = 0;
  let note = render(kept, dropped);
  while (kept.length > 1 && note.length > cap) {
    kept = kept.slice(1);
    dropped += 1;
    note = render(kept, dropped);
  }
  return note;
}

/** The budget ran out before either side answered. */
const NOTE_LATE = Symbol("late");

/**
 * One gateway call under a shared deadline, answering NOTE_LATE rather than hanging.
 *
 * The timer is not unref'd, for the reason readVoiceBrief's is not: an unref'd timer cannot fire when
 * nothing else holds the event loop open, so the await would never settle and the budget would be no
 * budget at all. It is cleared the instant either side answers.
 */
async function noteCallWithin(work, budgetMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(work()).finally(() => { if (timer != null) clearTimeout(timer); }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(NOTE_LATE), Math.max(1, Number(budgetMs) || 1)); }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/**
 * VOICE-16c. Put the call's note in the conversation, and do not make Titan answer it.
 *
 * WHAT THIS FIXES, measured rather than suspected. VOICE-16 wrote the closing note with `sendPrompt`,
 * which is the host's run-a-turn verb, because nothing else could write a row. docs/VOICE-16-REPORT.md
 * records that there is NO flag on it meaning "remember this, do not answer it", so the note asked in
 * its own first two sentences and the agent was free to answer anyway -- one message nobody asked for
 * after every call. Five went out on the night of 2026-09-12. `appendTranscriptNote` writes the same
 * row the send pipeline writes and runs no turn at all, so there is nothing to honour.
 *
 * THE FALLBACK IS THE OLD PATH, BYTE FOR BYTE, and ONLY for a host that has never heard of the new
 * command. `isUnknownGatewayMethod` is the existing reader for that, the same one the brief degrades
 * on. Every OTHER failure does not fall back, on purpose:
 *   - a TIMEOUT may still land on the box (this path already logs that it may), and a fallback after
 *     one would put the same call transcript in the person's conversation twice, once as a note and
 *     once as a prompt with a reply under it;
 *   - a REFUSAL is the box saying no to this write, and asking it a second way is how a relay talks a
 *     box into something it declined.
 *
 * THE DEADLINE IS SHARED. Both attempts come out of one budget, because what waits behind this call
 * is the session being released, which is what lets the next press in. A person who hangs up and
 * presses again must not be told the workspace is busy because a box was slow twice.
 *
 * A DUPLICATE IS A SUCCESS. The host answers `{duplicate:true}` when a note under this nonce is
 * already in the conversation, which means the row a caller wanted is there. Reporting that as a
 * failure would invite the retry that wrote it twice.
 */
export async function fileCallNote(call, {
  agentId = "",
  note = "",
  clientNonce = "",
  at = 0,
  timeoutMs = VOICE_NOTE_WRITE_MS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const id = String(agentId ?? "");
  const text = String(note ?? "");
  if (id.length === 0 || text.length === 0) return { how: "nothing", filed: false, duplicate: false };
  const nonce = String(clientNonce ?? "");
  const deadline = now() + Math.max(1, Number(timeoutMs) || VOICE_NOTE_WRITE_MS);
  const left = () => Math.max(1, deadline - now());
  try {
    const answer = await noteCallWithin(
      () => call("appendTranscriptNote", { agentId: id, text, at: Number(at) || 0, clientNonce: nonce }),
      left(),
    );
    if (answer === NOTE_LATE) {
      log(`voice gave up waiting ${timeoutMs} ms for the box to file this call's note; it may still land`);
      return { how: "late", filed: false, duplicate: false };
    }
    return {
      how: "filed",
      filed: true,
      duplicate: answer?.duplicate === true,
      entryId: String(answer?.entryId ?? ""),
    };
  } catch (error) {
    if (!isUnknownGatewayMethod(error)) {
      log(`voice could not file the call's note in the conversation: ${error?.message ?? error}`);
      return { how: "failed", filed: false, duplicate: false };
    }
    log("voice this box's host cannot file a note without answering it, so the note goes as a prompt and may get a reply");
  }
  try {
    const answer = await noteCallWithin(
      () => call("sendPrompt", { agentId: id, prompt: text, clientNonce: nonce }),
      left(),
    );
    if (answer === NOTE_LATE) {
      log(`voice gave up waiting ${timeoutMs} ms for the box to take this call's note; it may still land`);
      return { how: "late", filed: false, duplicate: false };
    }
    return { how: "sent", filed: true, duplicate: false };
  } catch (error) {
    log(`voice could not leave the call's note in the conversation: ${error?.message ?? error}`);
    return { how: "failed", filed: false, duplicate: false };
  }
}

// ---- the settings door: voice.json --------------------------------------------------------------
//
// Custody, as KEYS-1 left it: the realtime key is the OPERATOR's. It is pasted once at the super
// admin console, held in this process's memory by ui/relay-secrets.mjs, and keyFor() prefers it over
// anything on disk. `apiKey` on this file is the FALLBACK and it is the migration: a relay whose
// control plane holds nothing keeps dialling with the value it always dialled with, so there is no
// window in which voice is broken and there is no code that moves a byte from here to there.
//
// Nothing writes this field from a customer's session any more. mergeVoiceSettings refuses a key
// from every workspace but the operator's own, in words, because a 200 that silently drops a field
// the caller sent is the failure where the caller believes it worked.

const asString = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * VOICE-8. The four the OPERATOR sets and a customer's session may not. They are his choices because
 * they are billed to his key; the rows that set them live on the Operator section of Settings.
 */
export const OPERATOR_ONLY_VOICE_FIELDS = ["vendor", "model", "voice", "agentId"];

// VOICE-10. HOW THE TALK BUTTON BEHAVES, PER PERSON.
//
// The page keeps this in the browser too, and that copy is the fallback and the thing that still works
// in a private window. What this file adds is the half the row was filed for: a person who chooses
// always listening on a laptop gets always listening on their phone.
//
// It is keyed on the SUB -- the session's own person claim, "" for the instance-password door -- which
// is the same key the device list and the notification settings are keyed on (ui/server.mjs subOf), so
// two accounts sharing one workspace do not fight over how their own button behaves. The field the
// console sends is `talkMode`, one value; what is kept on disk is a map, and the route answers the
// caller's own entry and nobody else's.
//
// It is on THIS door rather than on the notifications door the row first named, because that door
// refuses the field by name -- its own field list is frozen to kinds, quietHours and utcOffsetMinutes
// -- and opening it is an edit to a file this wave does not own. docs/VOICE.md 13 says so in writing.
export const TALK_MODES = ["push", "always"];
/** Hold the button, because a microphone that is open until you say otherwise is not a default. */
export const TALK_MODE_DEFAULT = "push";
const talkModeOf = (value) => (TALK_MODES.includes(asString(value)) ? asString(value) : "");

// A bound, because this map grows by one for every person who ever chooses and a state file with no
// ceiling is one somebody eventually finds at a gigabyte. The oldest entries fall off, and the only
// cost of falling off is that that person's next console opens on their own browser's copy.
const TALK_MODE_SUBS = 200;

function normalizeTalkModes(raw) {
  if (raw == null || typeof raw !== "object") return {};
  const out = {};
  for (const [sub, mode] of Object.entries(raw)) {
    if (typeof sub !== "string" || sub.length > 256) continue;
    const mine = talkModeOf(mode);
    if (mine.length === 0) continue;
    out[sub] = mine;
  }
  const keys = Object.keys(out);
  if (keys.length <= TALK_MODE_SUBS) return out;
  const kept = {};
  for (const sub of keys.slice(-TALK_MODE_SUBS)) kept[sub] = out[sub];
  return kept;
}

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
    /** VOICE-10. Per person, keyed on the session's own sub. A workspace nobody chose on has {}. */
    talkModes: normalizeTalkModes(value.talkModes),
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
export function mergeVoiceSettings(current, patch, { sub = "" } = {}) {
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
  // VOICE-10. `talkMode` is the CALLER'S OWN. It lands under their own sub and nowhere else, so a
  // person writing theirs can neither read nor move anybody else's. A value this relay does not know
  // is IGNORED rather than defaulted -- a default written over a real choice is a choice silently
  // thrown away -- and null clears this person's entry, handing them back to their own browser's copy.
  const who = typeof sub === "string" ? sub : "";
  if (typeof value.talkMode === "string") {
    const mine = talkModeOf(value.talkMode);
    if (mine.length > 0) next.talkModes = { ...base.talkModes, [who]: mine };
  } else if (value.talkMode === null) {
    const rest = { ...base.talkModes };
    delete rest[who];
    next.talkModes = rest;
  }
  return normalizeVoiceSettings(next);
}

/**
 * What GET and POST /voice/settings both answer. The key is a BOOLEAN and never a value: this
 * shape is the only thing either route returns, so there is no route on this server that can read
 * a realtime key back out once it is set. cp/PROVIDERS-ROUTES.md 5 is the rule and this honours it.
 */
export function voiceSettingsShape(settings, { vendors = null, agents = [], sessionCapSeconds = 0, dayCapSeconds = 0, dayUsedSeconds = 0, recent = [], available = null, sub = "" } = {}) {
  const value = normalizeVoiceSettings(settings);
  const myTalkMode = talkModeOf(value.talkModes?.[typeof sub === "string" ? sub : ""]);
  return {
    enabled: value.enabled,
    vendor: value.vendor,
    // VOICE-10. THIS CALLER'S OWN talk mode and nobody else's: the map is never answered, only the one
    // entry. OMITTED rather than defaulted where this person has never chosen, which is the PROXY-1
    // rule and the whole of how the page knows to keep its own browser's copy rather than be handed a
    // value the relay made up.
    ...(myTalkMode.length > 0 ? { talkMode: myTalkMode } : {}),
    // EXACTLY WHAT THE WORKSPACE SET, and empty when it set nothing. These used to fall back to the
    // vendor's own default, and the Voice card writes the answer straight into two text inputs, so a
    // customer who had never touched either field read a vendor's product name back off their own
    // card. The relay already falls back to the vendor default when the field is empty, so an empty
    // string here is the whole of "use the service's own", and the card says that in a placeholder.
    model: value.model,
    voice: value.voice,
    agentId: value.agentId,
    apiKeySet: value.apiKey.length > 0,
    // KEYS-1. IS THERE A KEY FOR THIS WORKSPACE'S SERVICE AT ALL, wherever it came from -- the
    // control plane's own or this workspace's file. It is a different question from apiKeySet, which
    // is only about the file, and it is the one the console's "Let me talk to Titan" switch reads:
    // a switch that turns on when there is nothing behind it is a Talk button that refuses.
    //
    // apiKeySet STAYS beside it and is not folded into it, because scripts/verify-voice.mjs asserts
    // the file half survives a save that never carried a key, and those are genuinely two facts.
    //
    // `null` from the caller means "this build could not ask", and it degrades to the file answer
    // rather than to false: a console that cannot reach the control plane must not report a working
    // workspace as switched off.
    available: available == null ? value.apiKey.length > 0 : available === true,
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
/**
 * VOICE-20. The longest the tool's answer will wait for the room to go quiet before it speaks anyway.
 *
 * Jason, 2026-09-13 on build 22: "when Titan starts to send work to the subagent, it interrupts what
 * Titan is saying. If Titan is in mid-sentence or at the end of the sentence, it will clip." The
 * waiting sentence and the tool call are ONE response, and the model hands its audio over far faster
 * than a speaker plays it, so `response.done` for that sentence arrives seconds before the sentence
 * has finished leaving the speaker. Asking for the next response in that window is asking the vendor
 * to talk over a sentence a person is still listening to.
 *
 * WHY THERE IS A CEILING AT ALL. `playsUntilMs` is BOOKED audio, not played audio: it is what the
 * bytes would take to come out of a speaker, and nothing on this side can prove the page ever played
 * them. A page that went to the background, a shell whose player stalled, or a barge-in whose flush
 * was lost would leave a booking in the future for ever, and an answer held behind it would never be
 * spoken at all. So the wait is bounded and the answer goes out late rather than never.
 */
export const ANSWER_QUIET_CEILING_MS = 6000;
/** How often the answer looks again to see whether the room has gone quiet. */
export const ANSWER_QUIET_TICK_MS = 120;
/**
 * VOICE-19. How often the relay looks for a card the box raised with NO spoken turn behind it.
 *
 * Until this wave the tail was read only inside `makeTurnRunner.run`, which is to say only while a
 * spoken turn was with Titan. Every other pending approval -- one raised by a turn somebody started
 * in the chat, by a routine, by a subagent, or by the agent carrying on working after his reply had
 * already landed -- appeared on the person's screen and was never asked about out loud. Jason, on
 * build 21: "the approval card popped up while I was in my voice chat session ... I should also be
 * able to tell Titan when it pops up on the screen." So this is the missing moment, and it is a
 * SLOW tick on purpose: the turn runner's own 400 ms poll is what a live turn needs, and between
 * turns three seconds is the difference between reading the card and hearing about it.
 */
export const CARD_WATCH_MS = 3000;
/**
 * VOICE-14c. The line says hello the moment it is up, before the person has said a word. Jason,
 * 2026-09-12: "as soon as you start the call, it should say something first, like Hey there ...
 * or just Hi. It could be random." A silent open line reads as a dead one; this is the dial tone.
 * Short on purpose: each greeting is one billed text item on xAI.
 */
export const GREETINGS = ["Hey there.", "Hi.", "Hey, I'm here.", "Hello.", "Hey. Go ahead."];
export const pickGreeting = (random = Math.random) => GREETINGS[Math.min(GREETINGS.length - 1, Math.floor(random() * GREETINGS.length))];
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
 * VOICE-15c. The floor a frame has to clear before this relay will call it sound, as a PCM16
 * magnitude out of 32767 full scale. 64 is -54 dBFS.
 *
 * WHY A FLOOR AND NOT "ABOVE ZERO". The failure this number exists for has two measured shapes and
 * only one of them is an empty socket. On TestFlight build 17, 2026-09-12, a call delivered 0 s of
 * audio in and the provider still produced a transcript; and on the five calls of VOICE-14b the phone
 * sent 18 to 35 s of audio that the provider heard no speech in at all, which is what a capture path
 * handing over digital zeros looks like from here. Zeros with one bit of resampling noise in them are
 * not an empty socket, so the test is a level rather than a byte count.
 *
 * WHY 64 AND NOT HIGHER. It is three orders of magnitude below what a microphone really sends -- the
 * phone's own trimmed capture peaked at 0.0 dBFS on build 20, and tests/voice-turn.test.mjs's frame
 * is 3000 -- and far enough above resampling noise that silence cannot clear it. A higher floor would
 * start deciding how loud somebody has to talk, which is the provider's turn detection's job and not
 * this relay's.
 */
export const HEARD_PEAK_FLOOR = 64;
/**
 * VOICE-21. How much audio may reach the provider with nothing heard back before the person is
 * told. Twenty seconds: long enough that a pause, a slow first transcript or a quiet room never
 * trips it, short enough that nobody finishes a thought into a dead line. Measured against the
 * failing R750 session, which ran 148 s with nothing heard.
 */
export const ONE_WAY_SECONDS = 20;
/** The words the person reads. Plain, no prefix and no underline: a prefixed line reads as an error. */
export const ONE_WAY_SENTENCE = "Your voice is not reaching Titan. Check the microphone, or hang up and call again.";

/**
 * Whether to tell the person their voice is going nowhere, and it is a pure function so the
 * rule can be tested without a socket, a vendor or a clock.
 *
 * Fires when audio has been forwarded past the threshold with nothing heard since the session
 * opened or since the last agent turn, and at most once per session.
 */
export function oneWayCallVerdict({ secondsSinceHeard = 0, heard = false, alreadyFired = false, thresholdSeconds = ONE_WAY_SECONDS } = {}) {
  if (heard) return { fire: false, why: "the provider heard something" };
  if (alreadyFired) return { fire: false, why: "the person has already been told on this line" };
  if (secondsSinceHeard < thresholdSeconds) return { fire: false, why: "not enough audio yet" };
  return { fire: true, why: `${Math.round(secondsSinceHeard)} s of audio in, nothing heard by the provider` };
}
/**
 * How long after the last frame with sound in it a provider transcript still counts as the person's.
 *
 * The window a transcript is measured against opens when the previous utterance closed, and on push to
 * talk the microphone SHUTS on the release: the settled transcript for what was just said then arrives
 * with the line already quiet. OpenAI's own transcription guide says those `.completed` events are
 * late and unordered, so a window with no tail would throw away the corrected final of a sentence the
 * person really did say. Three seconds is that tail. It costs nothing against the measured fault,
 * where no frame on the whole call ever had sound in it.
 */
export const HEARD_GRACE_MS = 3000;

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

/**
 * VOICE-19. THE ONE WORDING for a card, wherever it is asked.
 *
 * Two paths ask it now -- the turn that came back holding one, and the watcher below that finds one
 * the box raised on its own -- and a person answering "yes" has to be answering the same question in
 * both, or the two surfaces drift into two different promises about one decision. It ASKS, which the
 * mid-turn wording never did: it read out the card's summary as a statement and left the person to
 * work out that a spoken yes would close it.
 *
 * The title and the detail are the card's own strings, verbatim, and nothing is gisted: "there is
 * something waiting on you" is how somebody says yes to the wrong thing.
 */
export function cardQuestion(card) {
  if (card == null) return "";
  if (card.kind === "many")
    return `There are ${card.count} things waiting on you: ${card.cards.map((one) => one.title).join("; ")}. Say which one.`;
  const tidy = (text) => String(text ?? "").trim().replace(/\s+/g, " ");
  // A full stop is added only where the card's own string has none, so a summary the host already
  // wrote as a sentence is not read out as "Run psql?." and one written as a fragment still ends.
  const sentence = (text) => (text.length === 0 || /[.?!]$/.test(text) ? text : `${text}.`);
  const said = [sentence(tidy(card.title)), sentence(tidy(card.detail))].filter((one) => one.length > 0).join(" ");
  if (said.length === 0) return "Something is waiting on you. Allow it?";
  return `${said} Allow it?`;
}

const NEGATION = /\b(?:not|never|don'?t|doesn'?t|didn'?t|won'?t|can'?t|cannot|no longer|hold off|wait)\b/i;
/** A leading refusal, which turns the yes phrase after it into a no rather than into nothing. */
const NEGATION_PREFIX = /^(?:don'?t|do not|dont|never|no|not|please don'?t|i don'?t want to)\s+/;
// VOICE-19 added "allow" and "permit" here, and "refuse", "reject" and "block" below, because the
// question the relay now asks ends in the button's own word: "Allow it?". A person answering the
// question they were asked was, until this wave, answering with a word this matcher did not know,
// and an unmatched answer goes to Titan as prose -- which leaves the card open and reads as the
// relay ignoring them.
const YES = ["yes", "yeah", "yep", "yup", "sure", "go ahead", "do it", "send it", "send that", "approve", "approved", "allow", "allowed", "permit", "confirm", "confirmed", "ok", "okay", "that's right", "correct", "go for it"];
const NO = ["no", "nope", "nah", "stop", "cancel", "deny", "denied", "refuse", "refused", "reject", "block", "don't", "do not", "hold off", "not yet", "never mind", "nevermind", "forget it"];
// "it" is filler on the TAIL of a phrase only, which is what makes "allow it", "approve it",
// "refuse it" and "stop it" whole answers while "I am not sure, can you confirm what it would do"
// is still prose: the utterance has to START with one of the phrases above before a tail is read.
const FILLER = new Set(["please", "thanks", "thank", "you", "then", "now", "titan", "mate", "man", "it"]);

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
 * VOICE-3 RIDES THE SAME TICK. Beside each tail poll it reads `getTurnDraft`, the host's projection
 * of the message Titan is part way through writing, and hands whole sentences to `onDraftSentence` as
 * they complete. A host that does not have the command answers 404, the runner stops asking for the
 * rest of the session, and the turn behaves exactly as it did before: wait, then split. So an old host
 * bundle on a box costs the first sentence and nothing else.
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
  /**
   * Whether this box's host carries `getTurnDraft` at all. Starts hopeful, goes false on the one error
   * that means "never heard of it", and is never asked again for the life of the session.
   */
  let draftsAvailable = true;

  const tailOf = (agentId) => call("getAgentTranscriptTail", { id: agentId, limit: tailLimit })
    .then((answer) => (Array.isArray(answer?.entries) ? answer.entries : []))
    .catch(() => null);

  /**
   * The draft of THIS turn, or null.
   *
   * The nonce match is the whole of the safety here. A box has one conversation per agent and the
   * console can start a turn in it while a call is open; a draft whose `clientNonce` is not the one
   * this run sent belongs to somebody else's prompt, and reading it out would have Titan answer a
   * question the person never asked. No nonce on the draft (a console prompt carries none) is also
   * not ours. A transient failure answers null and the next tick tries again.
   */
  const draftOf = async (agentId, nonce) => {
    if (!draftsAvailable) return null;
    let answer;
    try {
      answer = await call("getTurnDraft", { id: agentId });
    } catch (error) {
      if (isUnknownGatewayMethod(error)) {
        draftsAvailable = false;
        log("voice getTurnDraft is not on this box's host; the reply will be read whole");
      }
      return null;
    }
    const draft = answer?.draft ?? null;
    if (draft == null || typeof draft.text !== "string") return null;
    return String(draft.clientNonce ?? "") === nonce ? draft : null;
  };

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
     * `onDraftSentence` is VOICE-3: one whole sentence of Titan's reply, handed over while he is still
     * writing the rest. It is awaited, so the caller can pace itself against the voice model's own
     * playback and the runner never runs ahead of what has actually been said. `spoken` on the result
     * is every sentence that went through it and `remaining` is what is left, which is what the tool
     * output must carry so nothing is said twice.
     *
     * VOICE-16b CAPPED IT AT ONE. It fires for the FIRST sentence only (SPOKEN_LEAD_SENTENCES), which
     * keeps the latency win and stops the rest of the answer being read out like a report. So `spoken`
     * holds at most one sentence and `remaining` holds the whole tail of the reply, for the model to
     * say in its own short words rather than word for word.
     *
     * @returns {Promise<{ok:boolean, accepted:boolean, text:string, pieces:string[], spoken:string[],
     *          remaining:string[], diverged:boolean, attemptId:string, afterId:string, afterMs:number,
     *          card:object|null, hops:object, nonce?:string}>}
     */
    async run({ agentId, message, nonce: given = "", onNudge = () => {}, onSent = () => {}, onDraftSentence = null }) {
      // `td` is VOICE-3's hop: when the FIRST sentence of the answer was handed to the voice model,
      // which on a streaming turn lands well before t3 (the finished entry) and is the whole of the win.
      const hops = { t1: now(), t2: 0, t3: 0, t4: 0, td: 0 };
      // VOICE-16b. ONE sentence is read out word for word, and the rest of the answer is the model's to
      // say short. The cap lives in the cutter so that `spoken` stays exactly what the person heard,
      // which is what `remaining` below is subtracted from.
      const cutter = makeSentenceCutter({ limit: SPOKEN_LEAD_SENTENCES });
      /** Whichever is true first stops the draft reader: the caller does not want it, or the box has no command. */
      let streaming = typeof onDraftSentence === "function";
      if (rounds >= maxRounds) {
        return { ok: false, refused: true, accepted: false, text: "I have already asked him twice about that. Say it again and I will take it to him fresh.", pieces: [], spoken: [], remaining: [], diverged: false, attemptId: "", afterId: "", afterMs: 0, card: null, hops };
      }
      rounds += 1;
      const before = await tailOf(agentId);
      const beforeId = before == null ? "" : String(before.at(-1)?.id ?? "");
      const beforeMs = before == null ? 0 : Number(before.at(-1)?.timestampMs ?? before.at(-1)?.createdAt) || 0;
      // THE ID OF THE ROW THIS IS ABOUT TO BECOME. The caller supplies it when it needs to tell the
      // page that id BEFORE the five-to-twenty-five second wait for Titan; this own-mint is the
      // fallback for every caller that does not care. A bare millisecond clock is not unique across
      // two sessions in the same millisecond, so a supplied one is scoped to its session.
      const nonce = String(given ?? "").length > 0 ? String(given) : `voice:${now()}`;
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
        return { ok: false, accepted: false, text: "I could not get that to him just now. His box did not take it.", pieces: [], spoken: [], remaining: [], diverged: false, attemptId: "", afterId: beforeId, afterMs: beforeMs, card: null, hops, nonce };
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
            // VOICE-3 settles here, ONCE, against the finished entry. Whatever the draft said, this is
            // the reply; `remaining` is the part of it nobody has heard yet and is what the tool output
            // carries, so a reply the person already heard the front half of is not read out twice.
            const rest = remainderOf(pieces, cutter.spoken);
            if (rest.diverged) log("voice draft diverged from the finished reply; reading it from the change");
            hops.t4 = now();
            return {
              ok: landed.kind !== "turn-failed", text, pieces,
              spoken: cutter.spoken, remaining: rest.pieces, diverged: rest.diverged,
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
            return { ok: true, accepted: true, text: "", pieces: [], spoken: cutter.spoken, remaining: [], diverged: false, attemptId: "", afterId: String(fresh.at(-1)?.id ?? beforeId), afterMs: Number(fresh.at(-1)?.timestampMs ?? now()), card, hops, nonce, cards: pendingCardsOf(fresh) };
          }
        }
        // VOICE-3. The draft, on the same tick. It is read AFTER the tail on purpose: an entry that has
        // already landed is the answer and there is nothing left to stream, so the branch above returns
        // first and a finished turn never pays for this call.
        if (streaming) {
          const draft = await draftOf(agentId, nonce);
          if (!draftsAvailable) streaming = false;
          if (draft != null) {
            const fresh = cutter.cut(draft.text, { complete: draft.complete === true });
            for (const sentence of fresh) {
              if (hops.td === 0) hops.td = now();
              try { await onDraftSentence(sentence); } catch (error) { log(`voice draft sentence failed: ${error?.message ?? error}`); }
            }
            // VOICE-16b. The lead sentence is out, so there is nothing more this draft can be read for
            // and the box stops being asked for it. Everything still being written lands in the finished
            // entry below, and `remaining` is what the model gets to say in its own short words.
            if (cutter.done) streaming = false;
          }
        }
        // A nudge is driven off the roster's own working flag, never a bare timer, and each one is
        // a billed event on xAI so it is bounded rather than a heartbeat.
        //
        // Once a sentence of the answer has been read out the nudge is DROPPED rather than delayed:
        // "He is still on it" on top of Titan's own third sentence is the relay talking over him, and
        // the silence the nudge exists to fill is no longer there.
        if (nudged < maxNudges && now() - hops.t2 > firstNudgeMs * (nudged + 1)) {
          const working = await stillWorking(call, agentId);
          nudged += 1;
          nudges += 1;
          if (working && cutter.count === 0) onNudge(nudged === 1 ? "He is still on it." : "Still going.");
          else if (!working) break;
        }
      }
      // A turn that read sentences out and then ran out of time still owes the person this sentence:
      // it was never in the draft, so it is what is LEFT to say even on a turn that streamed. Leaving
      // `remaining` empty here would have the relay fall silent on the one turn that needs words most.
      const gaveUp = now() < deadline
        ? "He stopped working without answering that one. Ask again and I will take it back to him."
        : `He has not come back in ${waitCapS} seconds. It is still in his conversation on screen.`;
      return {
        ok: false, text: gaveUp,
        pieces: [], spoken: cutter.spoken, remaining: splitSentences(gaveUp), diverged: false,
        attemptId: "", afterId: beforeId, afterMs: beforeMs, card: null, hops, nonce, accepted: true,
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

// KEYS-1 and VOICE-2 rewrote four of these, and the reasons are worth keeping.
//
// A CUSTOMER CANNOT ACT ON A KEY ANY MORE, so no sentence a customer reads may mention one. The
// realtime key is the operator's, pasted once at the super admin console, and a person told to "add
// one on the Voice card" is being sent to a card that no longer exists to do a thing they are not
// allowed to do.
//
// AND "PRESS THE BUTTON AGAIN" IS GONE from the no-key sentence. Jason, 2026-09-10, stuck in exactly
// the loop it instructed: "you can't exit out of this talk mode". toggle() read a state the relay had
// already set back to off, so the second press redialled into the same refusal, and the shipped
// sentence was what told him to keep pressing.
//
// `noKey` is HIS OWN WORDING, and the identical string lives in ui/machine-room/voice.js's NOTES so
// that retitleNote -- where the relay's diagnosis outranks the page's -- cannot produce two wordings
// for one condition.
const SENTENCE = {
  noKey: "Voice is not switched on for this workspace yet.",
  notEnabled: "Talking is switched off in Settings.",
  badOrigin: "That came from a page this console does not serve, so I did not open the microphone.",
  noAgent: "There is no bot in this workspace to talk to yet.",
  sessionCap: "That is the time limit for one conversation. Press the button again to start a fresh one.",
  dayCap: "This workspace has used its voice time for today. It resets at midnight UTC.",
  // ONE SENTENCE FOR BOTH, and it is deliberate rather than lazy.
  //
  // MEASURED on this Mac (node v22.23.1): a vendor answering 401 to the upgrade and a vendor with
  // nothing listening produce the same single error event, "Received network error or non-101 status
  // code", with no close event and no status code of any kind; a black-holed address produces
  // nothing at all for at least four seconds. So this edge genuinely cannot tell a refusal from an
  // outage, and two sentences would be this process guessing which one in front of a customer.
  //
  // WHAT THEY LOST is the word "voice service", because under KEYS-1 there is nothing a customer can
  // do about either cause: the key is the operator's and the vendor is the operator's choice. What
  // is left is the fact and who can see the reason. The operator's own diagnosis is not lost -- it is
  // in the relay log and in the ledger row's closeReason, where an operator looks.
  providerRefused: "Talking is not working right now. Your operator can see why.",
  providerSilent: "Talking is not working right now. Your operator can see why.",
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
  /**
   * VOICE-19. How often the relay looks for a card the box raised between spoken turns. A test and a
   * gate shorten it so that proving the question is asked is an assertion rather than a three second
   * wall-clock wait.
   */
  cardWatchMs = CARD_WATCH_MS,
  /** Called once, after the row is settled, so the edge can forget this session. */
  onClosed = () => {},
  log = () => {},
  // VOICE-14c. A real line always greets; tests that count every frame turn it off.
  greet = true,
  /**
   * VOICE-16. This agent's persona, facts and recent conversation, read ONCE before the dial by
   * readVoiceBrief and folded into the instructions ONCE at session.update. Null is the phone line
   * this was before: an older host, an agent this box no longer holds, or a read that timed out.
   */
  brief = null,
}) {
  const vendor = vendorOf(settings.vendor);
  const model = settings.model.length > 0 ? settings.model : vendor.model;
  const voice = settings.voice.length > 0 ? settings.voice : vendor.voice;
  const gate = makeEchoGate({ now });
  const dedupe = makeCallDedupe();
  const caption = makeCaption(vendor.transcription.mode);
  /** VOICE-16. Everything said out loud on this line, which becomes one note at close. */
  const exchange = makeSpokenExchange();
  const runner = makeTurnRunner({ call, now, sleep, log });
  const startedMs = now();
  const meter = { audioInBytes: 0, audioOutBytes: 0, billedItemEvents: 0, toolCalls: 0, browserHeld: 0, audioInPeak: 0, audioInSumSq: 0, audioInSamples: 0, phoneRoute: null, captureBlocks: 0, captureSent: 0, captureNative: false, bargeIns: 0, heardDropped: 0 };
  /**
   * VOICE-21. THE ONE-WAY CALL, which is what this whole watch exists for.
   *
   * MEASURED ON THE R750: a session took 148 s of audio at a peak of -2.6 dBFS and the provider
   * emitted no speech_started, no transcript and no failure. Zero turns reached the agent, the
   * person heard Titan answer, and nothing on the screen said their own voice was going nowhere.
   * Reports 24 and 36 are both that call: "one-way audio, agent to operator works, operator to
   * agent silently dropped with no error shown to the user".
   *
   * So the relay counts audio it has forwarded since the last thing the provider heard, and says
   * so once. `heardAt` is set by the first speech_started OR the first transcription event,
   * whichever a vendor sends first, because the two vendors differ on that and either one proves
   * the far side is listening. An agent turn resets it, so a long call that works and then stops
   * working is caught rather than only a call that never worked.
   */
  const oneWay = { bytesSinceHeard: 0, firedAtMs: 0, heardEver: false };
  /**
   * VOICE-15c. WHETHER A MICROPHONE HAS ACTUALLY CARRIED SOUND INTO THE UTTERANCE BEING TRANSCRIBED.
   *
   * THE MEASURED FAULT. On TestFlight build 17, 2026-09-12, Jason made a call that delivered 0 s of
   * audio in, and the provider transcribed one word out of its own greeting or out of silence: "them."
   * That string left this relay as a `heard-confirmed` frame, reached the live panel, and went into the
   * agent's conversation as a user turn through sendPrompt. His words: "it said that the call ended and
   * only one word was said: them. Nobody said that." Nothing on this side asked whether anybody had
   * said anything, because a provider transcript was taken as proof on its own.
   *
   * It is not proof. The only thing on this line that can say a person spoke is the audio the page put
   * on the socket, and the meter beside this already counts it: `bytes` is what was admitted, `peak`
   * is the loudest sample in it. Both are required -- zeros are bytes too (VOICE-14b's five calls) and
   * a level with no bytes behind it cannot happen.
   *
   * THE WINDOW OPENS WHEN THE PREVIOUS UTTERANCE CLOSED, not when the provider says speech started.
   * Server VAD fires a few hundred milliseconds into a sentence and the frames that triggered it have
   * already been admitted, so a window opened at `speech_started` would throw away exactly the audio
   * the transcript is made of. A close is the honest boundary, and in always-listening it is the right
   * one: utterance one's `hear-end` goes out while the person is already talking on utterance two, so
   * the audio after it belongs to utterance two and the audio before it does not.
   *
   * `soundMs` is the grace, and HEARD_GRACE_MS says why a window needs a tail.
   */
  const heardWindow = { bytes: 0, peak: 0, soundMs: 0, loggedKey: null };
  /**
   * VOICE-20. THE LEDGER THE CLIP WAS MEASURED WITH, and it stays in because the numbers in it are
   * the only ones that can tell the two candidate causes apart afterwards.
   *
   * One row per response the vendor opens: when it started, how many audio bytes it delivered, how
   * many milliseconds of speech those bytes are, and when it finished. The row a `response.create`
   * of ours is asked against is what says whether we asked over a response that was still generating
   * (the vendor's own `conversation_already_has_active_response`, which is a QUIET code and so proves
   * nothing from the log alone) or over one that had finished generating and was still being SPOKEN
   * (`playsUntilMs` in the future), which are two different faults with two different fixes.
   *
   * Bytes are attributed to `response_id` when the vendor stamps one on the delta and to the response
   * in flight when it does not: xAI stamps it, and a vendor that stops would otherwise silently lose
   * the count rather than mis-report it.
   */
  const responses = new Map();
  let liveResponseId = "";
  const responseRow = (id) => {
    const key = String(id ?? "");
    if (key.length === 0) return null;
    let row = responses.get(key);
    if (row == null) {
      row = { id: key, startedMs: now(), bytes: 0, doneMs: 0 };
      responses.set(key, row);
      // A call is one line and a response id is unique within it, but a very long line must not grow
      // this without bound: the oldest rows are dropped and only the last few can ever be reported on.
      if (responses.size > 64) responses.delete(responses.keys().next().value);
    }
    return row;
  };
  /** Milliseconds of speech a count of PCM bytes is, at the one rate this whole file speaks in. */
  const audioMsOf = (bytes) => Math.round(((Number(bytes) || 0) / (AUDIO_RATE * 2)) * 1000);
  /** How much of the audio already handed to the page has still to come out of a speaker. */
  const soundLeftMs = () => Math.max(0, gate.playsUntilMs - now());
  /**
   * VOICE-20. WAIT UNTIL THE ROOM IS QUIET BEFORE ASKING THE VENDOR TO SPEAK INTO IT.
   *
   * `playsUntilMs` is booked FROM THE BYTES and not from an empty queue, because the model hands a
   * reply over far faster than a speaker plays it -- makeEchoGate says exactly that in its own comment
   * and the microphone side of this file has leaned on it since A4. The speaking side did not: the
   * tool's answer and the lead sentence of a streamed reply both asked for a response the moment the
   * LAST one had finished GENERATING, which on a hand-off is one to two seconds before Titan's waiting
   * sentence has finished being heard.
   *
   * MEASURED, this Mac against the stub with a two second sentence booked: 1,578 ms of it still to come
   * out of the speaker at the instant the answer asked. The ceiling is why a stuck booking cannot hold
   * an answer for ever; it goes out late rather than never, and the log says which happened.
   */
  const waitForQuiet = async (why, ceilingMs = ANSWER_QUIET_CEILING_MS) => {
    const startedAt = now();
    const until = startedAt + ceilingMs;
    while (!stopping && gate.playsUntilMs > now() && now() < until) await sleep(ANSWER_QUIET_TICK_MS);
    const waited = now() - startedAt;
    if (waited < ANSWER_QUIET_TICK_MS) return 0;
    const left = soundLeftMs();
    log(`voice ${t.slug} held ${why} for ${waited} ms so Titan's own sentence could finish`
      + `${left > 0 ? `, and let it go with ${left} ms still booked because the ${ceilingMs} ms ceiling ran out` : ""}`);
    return waited;
  };
  /**
   * Every `response.create` this relay sends goes through here, so the log can say what the room
   * sounded like at the moment it asked. `why` is the caller in plain words, because "a response was
   * created" is the one fact a log of this already had and the one fact that never helped anybody.
   */
  const askForResponse = (why) => {
    const live = liveResponseId.length > 0 ? responses.get(liveResponseId) : null;
    const busy = live != null && live.doneMs === 0;
    log(`voice ${t.slug} asks for a response (${why}): ${busy ? `${live.id} is still generating` : "nothing generating"}`
      + `, ${live == null ? 0 : live.bytes} audio byte(s) on ${live == null ? "no response" : live.id} = ${audioMsOf(live?.bytes ?? 0)} ms of speech`
      + `, ${soundLeftMs()} ms of that still booked to play`);
    return sendProvider({ type: "response.create" });
  };
  const announcements = [];
  let browser = null;
  let provider = null;
  let responseInFlight = false;
  let lastAnnounceMs = 0;
  let greeted = false;
  let speakId = 0;
  let stopping = false;
  /**
   * VOICE-14. Whether this line runs with barge-in, and whether the page has already said so. The page
   * asks for it on its opening frame and the FIRST answer is kept: a page that could toggle this
   * mid-call could switch the echo gate off and on at will, and nothing about which host a socket is
   * coming from changes halfway through a call.
   */
  let bargeIn = false;
  let helloSeen = false;
  let tick = null;
  /**
   * VOICE-19. The between-turns card watcher: its interval, whether a read of its own is already in
   * flight, and the entry ids it has already asked about out loud.
   *
   * `cardsAsked` is what keeps one card one question. A card stays PENDING on the box until somebody
   * answers it, so a watcher with no memory would re-ask the same approval every three seconds for
   * the length of the call; and a card the person has just settled with their thumb must not be
   * asked about at all. It is never pruned, because a session is one call and an entry id is unique
   * within it.
   */
  let cardWatch = null;
  let cardWatching = false;
  const cardsAsked = new Set();
  /**
   * How many `titan` tool turns are inside `runner.run` right now. The runner polls the tail at
   * 400 ms while it runs and returns the card it finds, so the watcher stands aside for it: two
   * readers racing on one card is how the same approval gets asked twice in different words.
   */
  let turnsInFlight = 0;
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
  // Counts the sends in this session, so a row id is unique without depending on the clock.
  let sendSeq = 0;
  /** The last turn a `hear-end` closed, so a transcript arriving after it cannot re-open the panel. */
  let hearClosedTurn = 0;
  /**
   * The conversation item the OPEN turn belongs to, and the one before it.
   *
   * OpenAI says in its own docs that `.completed` transcription events are not ordered between items,
   * and MEASURED against the stub: utterance 1's settled transcript can arrive after utterance 2 has
   * opened, and stamping it with whatever turn is current paints the old sentence into the new panel
   * as settled words. The event already names its item; this is what lets a late one be recognised as
   * the previous item's and dropped. Only the previous item is remembered, because that is the race:
   * two items' transcripts in flight at once.
   */
  let hearItem = "";
  let hearItemBefore = "";
  /** The turn the response in flight belongs to, so `response.done` closes that one and not a newer. */
  let responseTurn = 0;

  const secondsNow = () => Math.max(0, Math.round((now() - startedMs) / 1000));
  const bytesToSeconds = (bytes) => Math.round(bytes / (AUDIO_RATE * 2));
  /** Full-scale decibels for a PCM16 magnitude: 0 dBFS is 32767, silence prints as -inf dBFS. */
  const dbfs = (magnitude) => magnitude > 0 ? `${(20 * Math.log10(magnitude / 32767)).toFixed(1)} dBFS` : "-inf dBFS";

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

  /**
   * VOICE-15c. Whether the words about to be handled can be the person's at all: bytes admitted since
   * this utterance's window opened AND a peak in them above the silence floor, or sound inside the
   * grace tail for a transcript that settles after the microphone shut. heardWindow says why.
   */
  const heardSound = () => (heardWindow.bytes > 0 && heardWindow.peak >= HEARD_PEAK_FLOOR)
    || (heardWindow.soundMs > 0 && now() - heardWindow.soundMs <= HEARD_GRACE_MS);
  /**
   * Provider text with nothing heard behind it, dropped and said so.
   *
   * ONE LINE PER UTTERANCE, not one per event: a broken capture path produces a transcript update every
   * couple of hundred milliseconds and a relay log nobody can read is the same as no log. `key` is the
   * item the events belong to; the tool call passes null because there is one of those per turn and it
   * is the one that would have reached somebody's conversation.
   */
  const logHeardDrop = (what, key = null) => {
    meter.heardDropped += 1;
    if (key != null && key === heardWindow.loggedKey) return undefined;
    heardWindow.loggedKey = key;
    log(`voice provider text with nothing heard, dropped: ${what}; `
      + `${heardWindow.bytes} byte(s) admitted since this utterance began, peak ${dbfs(heardWindow.peak)}, `
      + `floor ${dbfs(HEARD_PEAK_FLOOR)}, ${bytesToSeconds(meter.audioInBytes)} s of audio on this line, `
      + `${meter.browserHeld + gate.heldFrames} frame(s) held`
      + (meter.captureNative ? `, the phone handed the page ${meter.captureBlocks} block(s) and it sent ${meter.captureSent}` : "")
      + (meter.phoneRoute != null ? `, phone output ${meter.phoneRoute.output || "?"}` : ""));
    return undefined;
  };

  /**
   * VOICE-21. One chip, one log line, once per line, and only while the provider has said nothing.
   * `heardSomething` is the other half and is called from every event that proves the far side is
   * listening, so a call that works and later stops working is caught as well as one that never
   * worked.
   */
  const noteOneWayAudio = () => {
    const verdict = oneWayCallVerdict({
      secondsSinceHeard: bytesToSeconds(oneWay.bytesSinceHeard),
      heard: false,
      alreadyFired: oneWay.firedAtMs > 0,
    });
    if (!verdict.fire) return undefined;
    oneWay.firedAtMs = now();
    log(`voice one-way call: ${bytesToSeconds(oneWay.bytesSinceHeard)} s of audio in, nothing heard by the provider`);
    // A quiet chip in the person's own words. `note` is the same channel a hand-off uses, so the
    // call screen already knows how to draw one without colouring the orb.
    browser?.sendJson({ t: "one-way", text: ONE_WAY_SENTENCE });
    return undefined;
  };

  /** The provider proved it is listening. Clears the chip and restarts the count. */
  const heardSomething = () => {
    oneWay.bytesSinceHeard = 0;
    oneWay.heardEver = true;
    if (oneWay.firedAtMs > 0) {
      oneWay.firedAtMs = 0;
      browser?.sendJson({ t: "one-way", text: "" });
    }
    return undefined;
  };

  const hearBegin = (itemId = "") => {
    if (machineTalking()) return undefined;
    hearTurn = Math.max(session.userTurn, 1);
    const item = String(itemId ?? "");
    if (item.length > 0 && item !== hearItem) { hearItemBefore = hearItem; hearItem = item; }
    browser?.sendJson({ t: "hear-begin", turn: hearTurn, itemId: item });
    return undefined;
  };
  const hear = (text, { final = false, itemId = "" } = {}) => {
    // Never while the machine is the one talking. If the echo gate ever slips, the panel would
    // otherwise render Titan's own sentence as though the person had said it.
    if (machineTalking()) return undefined;
    // AND NEVER THE PREVIOUS UTTERANCE'S WORDS IN THIS ONE'S PANEL. A `.completed` for the item
    // before this one can land after this one opened -- OpenAI's own docs say those events are not
    // ordered between items -- and stamping it with the current turn paints the old sentence over the
    // new one as settled text. MEASURED against the stub on this Mac: item_1's sentence arriving as
    // turn 2. The id is the only thing that can tell them apart, so a frame naming the item we have
    // already moved on from is dropped rather than relabelled.
    const item = String(itemId ?? "");
    if (item.length > 0 && hearItemBefore.length > 0 && item === hearItemBefore) return undefined;
    if (hearTurn === 0) {
      // A vendor that sends a transcript without a speech_started still gets a panel. A transcript
      // arriving AFTER this turn was closed does not: the `.completed` and the tool call race, and
      // resurrecting the panel a moment after it dissolved is a flicker over the conversation.
      const turn = Math.max(session.userTurn, 1);
      if (turn <= hearClosedTurn) return undefined;
      hearTurn = turn;
    }
    browser?.sendJson({ t: "hear", turn: hearTurn, itemId: item, text: String(text ?? ""), final: final === true });
    return undefined;
  };
  /**
   * Closes ONE NAMED TURN, once. A second call for the same turn is dropped, so no panel flickers
   * back, and a call about a turn that is no longer the open one is dropped too.
   *
   * WHY IT HAS TO NAME ITS TURN. This used to close "whatever is open", and in always-listening the
   * next utterance begins during the 5.5 to 25 s Titan takes to answer the last one. MEASURED against
   * the real bridge and the stub on this Mac: utterance 1's confirmation sent `hear-end turn 2` while
   * the person was mid-sentence on utterance 2, the panel dissolved under them, and every later
   * transcript for utterance 2 was then dropped by the closed-turn guard in hear() above -- so the
   * words they watched being built were never the words that landed. A caller that knows which turn
   * it is talking about passes it; the ones that mean "whatever is open right now" (the line going
   * down, a transcription that gave up) still do.
   */
  const hearEnd = (reason, turn = hearTurn) => {
    if (turn === 0 || turn !== hearTurn) return undefined;
    hearClosedTurn = turn;
    hearTurn = 0;
    // VOICE-15c. A closed turn is where the next utterance's audio window opens, so the audio this
    // one was made of cannot vouch for the next one's words. `soundMs` is deliberately kept: it is
    // the grace tail for this utterance's own late transcript.
    heardWindow.bytes = 0;
    heardWindow.peak = 0;
    heardWindow.loggedKey = null;
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
    // VOICE-20. And not over a sentence still coming out of the speaker. The eight second floor above
    // is about BILLING and about two responses at once; it is not a reading of the room, and since
    // VOICE-20a the card question follows the turn's own answer directly, which is exactly the moment
    // an announcement can talk over one.
    await waitForQuiet("an announcement");
    if (stopping) return;
    lastAnnounceMs = now();
    sendProvider({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `Read this out to the person, word for word, nothing added: ${clean}` }] } });
    askForResponse("an announcement");
  };

  /**
   * VOICE-3. One whole sentence of Titan's answer, read out while he is still writing the rest.
   *
   * SINCE VOICE-16b IT FIRES ONCE PER TURN, for the lead sentence, because the turn runner's cutter
   * stops at SPOKEN_LEAD_SENTENCES. Nothing in here changed: it is still the one shape that makes a
   * realtime model say an exact string, and the queueing and pacing below still matter because the
   * greeting, a nudge or an announcement can be in flight when the sentence is ready.
   *
   * IT IS `say`'S WIRE SHAPE AND NOT AN ASSISTANT ITEM. An assistant `conversation.item.create` puts
   * the words into the history as though the model had already said them, which produces no audio at
   * all -- the person hears nothing and the model then carries on from text it never spoke. The one
   * shape PROVEN on both vendors in this file is the user item carrying "read this out, word for
   * word", which is what every nudge and announcement already uses, so that is what a sentence uses.
   * The session instructions are not touched: rewriting them per turn re-bills the whole conversation.
   *
   * THE GATE IS NARROWER THAN `say`'S. A sentence waits for the response in flight to finish, because
   * two overlapping responses is the provider error nobody can hear, and for NOTHING else: `say`'s
   * eight-second floor between announcements is right for a nudge and would make streaming slower than
   * waiting. Waiting on playback is also the pacing -- the queue drains at the speed the words are
   * spoken, which is exactly the rate the person can hear them.
   */
  const sayDraftSentence = async (text) => {
    const clean = String(text ?? "").trim();
    if (clean.length === 0) return;
    for (let i = 0; i < 40 && !stopping && responseInFlight; i += 1) await sleep(400);
    // VOICE-20. AND FOR THE ROOM TO BE QUIET, which is the half this gate was missing. The lead
    // sentence of Titan's reply is ready a second or two after the tool call on a box that streams,
    // and the waiting sentence the model said in the same breath as that call is still being spoken
    // then. Waiting on the response in flight alone is not waiting on the speaker.
    await waitForQuiet("the first sentence of the reply");
    if (stopping) return;
    // A nudge must not land between two sentences of the answer, so the announcement clock moves here
    // too. The turn runner already drops the nudge once a sentence has been read; this is the belt.
    lastAnnounceMs = now();
    sendProvider({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `Read this out to the person, word for word, nothing added: ${clean}` }] } });
    askForResponse("a sentence of the draft");
  };

  /**
   * The tool's answer.
   *
   * `respond` is VOICE-3's one subtraction: when the whole of the reply has ALREADY been read out
   * while Titan was writing it -- since VOICE-16b that is a one-sentence answer -- the output still has
   * to be sent, because the model is waiting on it and a call left open wedges the conversation, but
   * there must be no `response.create` behind it, or the model generates a fresh turn over an answer
   * that is already finished and says something of its own.
   */
  const answerTool = async (callId, payload, { respond = true } = {}) => {
    // THE OUTPUT GOES AT ONCE, ALWAYS. The model is waiting on it and a call left open wedges the
    // conversation, so nothing below this line may hold it back.
    sendProvider({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(payload) } });
    if (!respond) return undefined;
    // VOICE-20. And only THEN ask for the answer to be spoken: never over a response the vendor is
    // still generating, and never over a sentence that is still coming out of the speaker.
    for (let i = 0; i < 40 && !stopping && responseInFlight; i += 1) await sleep(400);
    await waitForQuiet("the tool's answer");
    if (stopping) return undefined;
    askForResponse("the tool's answer");
    return undefined;
  };

  /**
   * VOICE-19. A pending card the box raised with NO spoken turn behind it, asked out loud.
   *
   * THE MOMENT THAT WAS MISSING. `pendingCardsOf` is read in exactly one other place: inside
   * `makeTurnRunner.run`, against the entries that landed after this line's own prompt. That covers
   * an approval a spoken turn caused and nothing else. An approval raised by a turn started in the
   * chat, by a routine, by a subagent, or by Titan carrying on working AFTER his reply had already
   * landed and closed the turn, reached the person's screen and was never mentioned -- which is the
   * half of Jason's build-21 report that is not about buttons: "Titan did not ask."
   *
   * IT ALSO LETS A CARD GO. A card the person settles with their thumb stops being pending, and the
   * spoken question that was about it has to stop standing: without this, "yes" said a minute later
   * would still be read as an answer to a card that is already closed, and the person would be told
   * "that one already closed" instead of being heard.
   *
   * NEVER A SECOND GATE and never a second wording: the question is `cardQuestion`, the same string
   * the mid-turn path speaks, and a spoken answer to it goes through `resolveHeldCard` exactly as it
   * did before -- the console's own approval commands.
   */
  const watchCards = async ({ force = false } = {}) => {
    // `force` is the END OF A TOOL TURN asking the same question the tick asks, from inside the turn
    // it is ending. Everything else about this function is identical on both paths, which is the
    // point: one wording, one memory of what has been asked, one held card.
    if (stopping || cardWatching || (!force && turnsInFlight > 0)) return undefined;
    if (String(agent.agentId ?? "").length === 0) return undefined;
    cardWatching = true;
    try {
      const answer = await call("getAgentTranscriptTail", { id: agent.agentId, limit: 24 }).catch(() => null);
      if (answer == null || stopping) return undefined;
      const pending = pendingCardsOf(Array.isArray(answer?.entries) ? answer.entries : []);
      // A card that is no longer waiting is no longer the question on the table. This is the tap:
      // the person pressed Allow on the screen, the host rewrote the card's status, and the spoken
      // question it was holding is answered.
      const held = session.heldCard;
      if (held != null) {
        const stillOpen = held.kind === "many"
          ? (held.cards ?? []).some((one) => pending.some((row) => row.entryId === one.entryId))
          : pending.some((row) => row.entryId === held.entryId);
        if (!stillOpen) {
          session.heldCard = null;
          log(`voice ${t.slug} let go of a held card: it was settled on screen rather than out loud`);
        }
        return undefined;
      }
      // A spoken turn may have started while this read was in flight, and the runner's own poll is
      // the one that should find the card then. The end-of-turn caller IS that turn, so it goes on.
      if (!force && turnsInFlight > 0) return undefined;
      const fresh = pending.filter((row) => !cardsAsked.has(row.entryId));
      if (fresh.length === 0) return undefined;
      for (const row of fresh) cardsAsked.add(row.entryId);
      const card = pickOneCard(fresh);
      // `offeredTurn` is the guard that already exists on the mid-turn path: an answer has to arrive
      // in a LATER user turn than the question, or the model can talk itself into a confirmation.
      session.heldCard = { ...card, offeredTurn: session.userTurn };
      const question = cardQuestion(card);
      log(`voice ${t.slug} is asking about a card the box raised on its own${force ? ", found as the tool turn ended" : ""}: ${JSON.stringify(question.slice(0, 120))}`);
      // The page paints NOTHING for this frame (voice.js reads `said` for the gate and for VOICE-15b's
      // own-speech guard); the card itself is already on screen, drawn from the transcript.
      browser?.sendJson({ t: "said", text: question });
      await say(question);
    } catch (error) {
      log(`voice could not look for a pending card: ${error?.message ?? error}`);
    } finally {
      cardWatching = false;
    }
    return undefined;
  };

  /** The one tool, dispatched once per call_id, on whichever surface carried it first. */
  const dispatch = async (toolCall) => {
    // VOICE-19. While a spoken turn is with Titan, the turn runner owns the tail: it polls at 400 ms
    // and returns whatever card lands beside the reply. The watcher above stands aside for the whole
    // of it, including the answerTool that follows, so one card is one question.
    turnsInFlight += 1;
    try { return await dispatchTool(toolCall); }
    finally { turnsInFlight -= 1; }
  };

  const dispatchTool = async (toolCall) => {
    if (toolCall.name !== "titan") return answerTool(toolCall.callId, { error: "there is no such tool here" });
    meter.toolCalls += 1;
    // VOICE-21. A turn reached the agent, so the line is working right now whatever it did
    // earlier. The count restarts here as well as on a transcript, so the watch is against the
    // LAST thing that worked rather than against the start of the call.
    heardSomething();
    // THE TURN THIS CALL BELONGS TO, taken here rather than read later: in always-listening the next
    // utterance can start while this one is still with Titan, and the panel's frames have to stay with
    // the words the person watched being built. Zero where no turn is open, and that matters: the old
    // `|| session.userTurn` fallback meant a tool call arriving after its own turn had already been
    // closed (a failed transcription, say) was stamped with whatever utterance is open NOW, and then
    // closed or painted THAT one. Zero closes nothing and paints nothing, which is the truth about a
    // turn the panel has already let go of; `lastHeard` records the words for the gate either way.
    const turn = hearTurn;
    let message = "";
    try { message = String(JSON.parse(toolCall.argumentsJson || "{}").message ?? "").trim(); } catch { message = ""; }
    if (message.length === 0) {
      hearEnd("empty", turn);
      return answerTool(toolCall.callId, { reply: "I did not catch that. Say it again." });
    }
    // VOICE-15c. THE ONE THAT PUT "them." IN SOMEBODY'S CONVERSATION. This argument is the realtime
    // model's own string, and on a line that has carried no sound it is the model reading its own
    // greeting back or inventing a word out of silence. Nothing goes to the box, no `heard` frame and
    // no `heard-confirmed` leave here, and the tool is still answered, because a call left open wedges
    // the conversation. The person hears that their microphone is not arriving, which is the one fact
    // this relay actually knows.
    if (!heardSound()) {
      logHeardDrop(`a titan tool call carrying ${JSON.stringify(message.slice(0, 80))}`);
      hearEnd("empty", turn);
      return answerTool(toolCall.callId, { reply: "I am not hearing your microphone. Check it and say that again." });
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
        hearEnd("not-accepted", turn);
        return answerTool(toolCall.callId, { reply: "Say that again and I will take it as your answer." });
      }
      session.heldCard = null;
      const outcome = card.kind === "many"
        ? { ok: false, said: `There are ${card.count} things waiting on you. Say which one and I will take it back to him, or answer them on screen.` }
        : await resolveHeldCard({ call, agentId: agent.agentId, card, decision: decision.decision });
      const said = outcome.ok && String(outcome.requestId ?? "").length > 0 ? `${outcome.said} That was ${outcome.requestId}.` : outcome.said;
      // A yes that closes a card never becomes a row in the conversation, so the panel is told the
      // turn is over on its own terms rather than waiting for a row that is not coming.
      hearEnd("answered-card", turn);
      browser?.sendJson({ t: "said", text: said });
      return answerTool(toolCall.callId, { reply: said });
    }
    setState("thinking");
    // THE ID OF THE ROW THESE BYTES ARE ABOUT TO BECOME, minted here rather than inside the runner so
    // that it is known before the send rather than after it. A bare millisecond clock is not unique
    // across two sessions that open in the same millisecond, so it is scoped to this session and
    // counted within it. `voice:` is the whole of what gateway-adapter.js reads to stamp a row spoken,
    // so the prefix is load-bearing and the rest of the shape is ours.
    sendSeq += 1;
    const nonce = `voice:${sessionId}:${sendSeq}`;
    const result = await runner.run({
      agentId: agent.agentId,
      message,
      nonce,
      onNudge: (text) => void say(text),
      // The instant the box takes it, and not when Titan answers: these are the bytes that became
      // the row, and the nonce that row carries.
      onSent: () => {
        browser?.sendJson({ t: "heard-confirmed", turn, text: message, nonce, landed: true });
        hearEnd("sent", turn);
      },
      // VOICE-3. Each whole sentence of his answer, the moment it is whole. Awaited, so the runner
      // paces itself against playback rather than queueing four responses at the provider.
      onDraftSentence: (sentence) => sayDraftSentence(sentence),
    });
    // Nothing reached his box: a refused send, or a third round inside one user turn. Either way no
    // durable row will ever appear, so the panel is closed here instead of hanging over the chat.
    if (result.accepted !== true) hearEnd("not-accepted", turn);
    const pieces = result.pieces.length > 0 ? result.pieces : (result.text.length > 0 ? [result.text] : []);
    // TWO REPLIES, AND THEY ARE NOT THE SAME THING. `reply` is the WHOLE answer and it is what the
    // panel draws and what the conversation on screen already holds. `unsaid` is the part of it the
    // person has not heard: on a turn with no streaming that is all of it, and on a streaming turn it
    // is whatever arrived after the last sentence the draft reader handed over. Sending the whole
    // answer back as tool output on a streaming turn is the one way to make the person hear the front
    // of it twice, which is the failure VOICE-3 is supposed to remove rather than introduce.
    const spoken = Array.isArray(result.spoken) ? result.spoken : [];
    const unsaid = Array.isArray(result.remaining) ? result.remaining.slice() : [];
    let reply = pieces.join(" ");
    if (result.card != null) {
      session.heldCard = { ...result.card, offeredTurn: session.userTurn };
      // VOICE-19. Asked here, so the watcher above never asks it a second time in its own words.
      for (const one of result.card.kind === "many" ? (result.card.cards ?? []) : [result.card]) {
        if (String(one?.entryId ?? "").length > 0) cardsAsked.add(String(one.entryId));
      }
      const question = cardQuestion(result.card);
      reply = `${reply} ${question}`.trim();
      // The card's question was never in the draft, so it is always still owed to the person.
      unsaid.push(question);
    }
    if (reply.length === 0) reply = "He did not say anything back.";
    browser?.sendJson({ t: "said", text: reply });
    // The latency ledger, so a gate can print every hop with the machine it was measured on. T0 is
    // the provider's own VAD stop, T1 the tool call dispatched, T2 sendPrompt accepted, T3 the first
    // entry seen in the tail, T4 sentence one handed back, TD the first sentence read out OF THE DRAFT
    // while he was still writing -- on a streaming turn TD is the number that matters and it lands
    // before T3. T2 to T3 is TITAN'S time, not ours: it is reported and never asserted, and what is
    // ours is that the person hears something during it.
    browser?.sendJson({ t: "hops", t0: session.hops.t0, ...result.hops });
    // FREE on xAI, and what the design wanted anyway: the reply goes back as the tool's output
    // rather than as a chat item, in sentence-sized pieces so speech starts on the first one.
    //
    // An answer already read out in full goes back with NO response behind it: the call is closed so
    // the conversation is not wedged, and the model is not asked to speak over a finished answer.
    //
    // A turn that streamed nothing takes the path VOICE-1 always took, unchanged: the whole reply and
    // its sentences, one response behind it. That is every desktop call and every call to a box whose
    // host does not carry getTurnDraft.
    //
    // VOICE-16b. ONE sentence was read out word for word and the rest of the answer is the model's to
    // say short, so the remainder goes back with the `spoken` hint: the person heard sentence one, say
    // the rest in one short sentence or nothing. The hint is the only per-turn instruction anywhere on
    // this path, and it is per-turn because what the person has already heard cannot be known at
    // session.update. The contract it serves is in voiceInstructions, written once.
    if (spoken.length === 0) {
      await answerTool(toolCall.callId, { reply, sentences: pieces });
    } else if (unsaid.length === 0) {
      await answerTool(toolCall.callId, { reply: "", sentences: [], alreadyRead: true }, { respond: false });
    } else {
      // The last streamed sentence may still be playing, and since VOICE-20 `answerTool` is the one
      // place that waits for it: for the response in flight to finish AND for the booked audio to
      // drain. The wait that used to be written out here was only the first half of that.
      const payload = { reply: unsaid.join(" "), sentences: unsaid, alreadyRead: true };
      // A HELD CARD IS THE ONE THING THAT IS STILL ASKED IN FULL. Its question is in `unsaid` and it is
      // a question the person has to answer, so it is read out as a plain question exactly as it was
      // before this wave: gisting "do you want me to send it" down to "there is something waiting" is
      // how a person says yes to the wrong thing. No hint goes on a turn that is holding a card.
      if (result.card == null) payload.spoken = SPOKEN_REMAINDER_HINT;
      await answerTool(toolCall.callId, payload);
    }
    if (result.attemptId.length > 0) {
      void runner.follow({
        agentId: agent.agentId, attemptId: result.attemptId, afterId: result.afterId, afterMs: result.afterMs,
        onAnnounce: (text) => { announcements.push(text); void say(text); },
      }).catch(() => {});
    }
    // VOICE-20a. A CARD THAT IS WAITING WHEN THE TOOL TURN ENDS IS ASKED, exactly as one found between
    // turns is. MEASURED on the R750, Jason's 15:21 CDT call: a `report_problem` inside the turn made
    // the host raise an approval, and the relay never asked about it out loud. The runner returns the
    // instant a reply entry lands, so a card raised in the same turn but a moment AFTER that reply is
    // not in the `fresh` it read -- and the between-turns watcher then stands aside for the whole of
    // `dispatch`, which is this function. Between those two the card fell through the floor.
    //
    // It is the same call the tick makes, with the one guard that would refuse it lifted, so there is
    // still ONE wording, one `cardsAsked` memory and one held card. A card the turn already came back
    // holding sets `session.heldCard` above, and this call sees it and returns rather than asking twice.
    await watchCards({ force: true });
    return undefined;
  };

  const onProviderEvent = (event) => {
    const type = canonicalEvent(event?.type);
    if (type === "error") {
      // A cancel race and a vanished item are NOTES, never errors: they must not colour the orb,
      // and that is host-notes-read-as-errors.md happening in someone else's codebase.
      // VOICE-20. WITH THE RESPONSE IT IS ABOUT. `conversation_already_has_active_response` is in this
      // set, so until this line a relay that was asking the vendor to speak over its own live response
      // said so in a log line that named neither the response nor the moment, and the log proved
      // nothing either way. It is still a note and still never colours the orb.
      if (providerErrorIsQuiet(event)) {
        const live = liveResponseId.length > 0 ? responses.get(liveResponseId) : null;
        // VOICE-21. THE WHOLE OBJECT, not just the code. Seven of these were logged on the R750 as
        // a bare `invalid_request_error` while the operator's voice was reaching nobody, and the
        // line proved nothing either way because the code alone says neither which parameter the
        // vendor refused nor why. Capped at 2,000 characters so one malformed event cannot flood a
        // log a person has to read. The note the PERSON sees is unchanged: this is still a note.
        return log(`voice note from the provider: ${event?.error?.code} on ${live == null ? "no response" : live.id}`
          + `${live != null && live.doneMs === 0 ? " while it was still generating" : ""}, ${soundLeftMs()} ms of audio still booked to play`
          + `; the provider said ${JSON.stringify(event?.error ?? {}).slice(0, 2_000)}`);
      }
      log(`voice provider error: ${JSON.stringify(event?.error ?? {}).slice(0, 240)}`);
      // A session refused before a single word was said cannot recover by itself, and silence is
      // the void answer this console has already been burned by.
      if (meter.toolCalls === 0 && meter.audioOutBytes === 0) return void close("the voice service refused this session", SENTENCE.providerRefused, "no-key");
      return undefined;
    }
    if (type === "session.updated") {
      setState("listening");
      // VOICE-14c: once per line, the first time the provider confirms the session.
      if (greet && !greeted) { greeted = true; void say(pickGreeting()); }
      // VOICE-19. ARMED HERE AND NOT IN start(), because the watcher SPEAKS: sendProvider drops
      // anything written before the provider socket is up, so a card found in that window would be
      // marked asked and never said out loud. This event is the one moment the relay knows the line
      // is really live.
      if (cardWatch == null && !stopping) {
        cardWatch = setInterval(() => void watchCards(), cardWatchMs);
        cardWatch.unref?.();
      }
      return undefined;
    }
    if (type === "input_audio_buffer.speech_started") {
      heardSomething();
      // VOICE-14. THE PERSON TALKED OVER THE AGENT, which in the phone app is allowed and everywhere
      // else cannot happen, because everywhere else the microphone was shut. BOOKED AUDIO IS THE TEST
      // and the orb is not: the model hands a reply over far faster than it is spoken, so the only
      // honest answer to "is there still sound in the room" is playsUntilMs in the future. Three things
      // then happen in this order -- the provider is told to stop generating, the page is told to throw
      // away what it has queued, and the gate is released so the words being said right now are not
      // mistaken for the machine's own and dropped from the person's panel.
      if (bargeIn && gate.playsUntilMs > now()) {
        meter.bargeIns += 1;
        sendProvider({ type: "response.cancel" });
        browser?.sendJson({ t: "flush" });
        gate.release();
        // The response we just cancelled is not in flight any more, and say() waits on this: leaving it
        // true would hold the next announcement for sixteen seconds over a reply nobody is hearing.
        responseInFlight = false;
        log(`voice barge-in ${meter.bargeIns} on this line: the person talked over the reply`);
      }
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
      heardSomething();
      // VOICE-15c. NOTHING HEARD, SO THESE ARE NOT THE PERSON'S WORDS. Dropped before the accumulator
      // as well as before the wire: a sentence nobody said must not be sitting in the caption waiting
      // for the next frame of real audio to carry it onto the screen.
      if (!heardSound()) {
        const id = String(event?.item_id ?? caption.itemId ?? "");
        return logHeardDrop(`a transcript update for ${id.length > 0 ? id : "an unnamed item"}`, id.length > 0 ? id : `turn:${hearTurn}`);
      }
      // REPLACE-WHOLE on both vendors. Append-the-delta writes the sentence N times on xAI.
      const text = caption.apply(event);
      browser?.sendJson({ t: "heard", text });
      hear(text, { final: false, itemId: event?.item_id ?? caption.itemId });
      // VOICE-16. The closing note's person side, under the SAME guard the panel uses: a transcript
      // produced while the machine is the one making noise is the model's own voice coming back
      // through the microphone (docs/VOICE.md 8 records that loop), and writing it into the note as
      // the person's words would put words in their mouth in a durable row.
      if (!machineTalking()) exchange.person(event?.item_id ?? caption.itemId, text);
      return undefined;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      heardSomething();
      // VOICE-15c. The settled transcript of an utterance no microphone carried. This is the event that
      // produced "them." on build 17, and HEARD_GRACE_MS is why a push-to-talk release does not land
      // here: the window keeps a tail for exactly this event's lateness.
      if (!heardSound()) {
        const id = String(event?.item_id ?? caption.itemId ?? "");
        return logHeardDrop(`a settled transcript for ${id.length > 0 ? id : "an unnamed item"}`, id.length > 0 ? id : `turn:${hearTurn}`);
      }
      const text = caption.complete(event);
      const itemId = event?.item_id ?? caption.itemId;
      caption.reset();
      browser?.sendJson({ t: "heard", text });
      if (!machineTalking()) exchange.person(itemId, text);
      // The transcription model's own last word. It is a `hear` and NOT the end of the turn: this
      // and the tool call race, and dissolving here would flicker the panel back when the confirmed
      // text arrives a moment later.
      hear(text, { final: true, itemId });
      return undefined;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      heardSomething();
      // Handled nowhere in this file until 2026-09-10, which is how one utterance came to bleed into
      // the next. The words are gone; the turn is not left open waiting for them.
      log(`voice transcription failed: ${String(event?.error?.message ?? event?.error?.code ?? "").slice(0, 160)}`);
      caption.reset();
      hearEnd("no-words");
      return undefined;
    }
    // THE TURN THIS RESPONSE IS ABOUT, taken when it starts. The no-answer close below used to mean
    // "close whatever is open", and in always-listening the next utterance has often already opened
    // by the time a response finishes, so it took that one's panel away instead.
    if (type === "response.created") {
      responseInFlight = true;
      responseTurn = hearTurn || session.userTurn;
      // VOICE-20. The row this response's bytes and its finish are written on.
      liveResponseId = String(event?.response?.id ?? `resp:${now()}`);
      responseRow(liveResponseId).startedMs = now();
      return undefined;
    }
    if (type === "response.output_audio.delta") {
      const audio = Buffer.from(String(event.delta ?? ""), "base64");
      if (audio.byteLength === 0) return undefined;
      meter.audioOutBytes += audio.byteLength;
      // VOICE-20. Stamped by the vendor where it stamps one, and attributed to the response in flight
      // where it does not, so the count is never silently lost.
      const row = responseRow(String(event?.response_id ?? "") || liveResponseId);
      if (row != null) row.bytes += audio.byteLength;
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
      // VOICE-20. THE TWO NUMBERS THE HAND-OFF IS JUDGED ON, printed at the one moment both are true:
      // how much speech this response delivered, and how much of it a speaker has still to play. A
      // response that finished generating with seconds of its own audio still booked is the window in
      // which anything else asking to speak talks over a sentence the person is still hearing.
      const finished = responseRow(String(event?.response?.id ?? "") || liveResponseId);
      if (finished != null && finished.doneMs === 0) {
        finished.doneMs = now();
        log(`voice ${t.slug} response ${finished.id} finished generating after ${finished.doneMs - finished.startedMs} ms`
          + `: ${finished.bytes} audio byte(s) = ${audioMsOf(finished.bytes)} ms of speech`
          + `, ${soundLeftMs()} ms of it still booked to play`);
      }
      const limited = rateLimitOf(event);
      if (limited != null) {
        rateLimitWaits += 1;
        if (rateLimitWaits <= 2) {
          log(`voice rate limited, waiting ${limited.waitMs} ms: ${limited.message}`);
          void sleep(limited.waitMs).then(() => { if (!stopping) askForResponse("a rate limited response, tried again"); });
        } else {
          // Dropping it is indistinguishable from not being heard, so it is said out loud.
          void say("The voice service is rate limiting us. Give it a moment and say that again.");
        }
      }
      if (!gate.holding()) setState("listening");
    }
    // VOICE-16. The closing note's own side: the words the voice itself said, off the transcript the
    // provider emits for them. Called for every event that reached here rather than behind a branch,
    // because the three surfaces that carry it -- the transcript deltas, their `.done`, and the
    // message items on `response.output_item.done` and `response.done` -- are exactly the events that
    // fall through to the bottom of this reader, and makeSpokenExchange ignores everything else.
    exchange.voice(type, event);
    const calls = toolCallsOf(event);
    for (const toolCall of calls) {
      // ONE call_id, dispatched once, on whichever of the three surfaces carried it first.
      if (dedupe.claim(toolCall.callId)) void dispatch(toolCall).catch((error) => log(`voice dispatch failed: ${error?.message ?? error}`));
    }
    // A finished response that asked Titan nothing means the model answered out of its own head,
    // which the instructions forbid but cannot prevent. No tool call, no row, so the turn is closed
    // here rather than leaving the person's words sitting over the conversation forever.
    if (type === "response.done" && !calls.some((toolCall) => toolCall.name === "titan")) hearEnd("no-answer", responseTurn);
    return undefined;
  };

  /**
   * VOICE-16. The call's one memory, written once.
   *
   * `noted` is what makes it once in THIS process: close() already guards against re-entry, but a
   * future caller that settles a row twice must not put the same transcript into somebody's
   * conversation twice. The nonce is what makes it once on the BOX, which is the half this flag cannot
   * reach: a gateway write that timed out here may have landed there. A failure is LOGGED AND SWALLOWED
   * -- a box that would not take the note must not stop the ledger row being settled, because the row
   * is what the day cap is read from.
   *
   * VOICE-16c. Which verb carried it is `fileCallNote`'s decision and its log line says which, because
   * "filed" and "sent" are two different outcomes for the person: one leaves a row, the other leaves a
   * row and may leave a reply under it.
   */
  let noted = false;
  async function writeCallNote() {
    if (noted) return undefined;
    noted = true;
    if (String(agent.agentId ?? "").length === 0) return undefined;
    const note = voiceCallNote({
      rows: exchange.rows,
      agentName: agent.agentName || "Titan",
      startedAtMs: startedMs,
      endedAtMs: now(),
    });
    if (note.length === 0) return undefined;
    const who = agent.agentName || agent.agentId;
    const size = `${exchange.size} line(s), ${note.length} characters`;
    // VOICE-16c. `filed` is the new command, which writes the row and runs no turn; `sent` is VOICE-16's
    // own sendPrompt, kept for a box whose host predates the command, where the note may still get an
    // answer nobody asked for. The word in the log is how an operator reading a relay log tells one
    // call from the other without going to look at the box's version.
    const outcome = await fileCallNote(call, {
      agentId: agent.agentId,
      note,
      clientNonce: `voice:${sessionId}:note`,
      at: now(),
      timeoutMs: VOICE_NOTE_WRITE_MS,
      now,
      log,
    });
    if (outcome.how === "filed" && outcome.duplicate)
      log(`voice ${t.slug} found this call's note already filed for ${who}, so it wrote nothing twice: ${size}`);
    else if (outcome.how === "filed")
      log(`voice ${t.slug} filed ${who} one note for this call and ran no turn for it: ${size}`);
    else if (outcome.how === "sent")
      log(`voice ${t.slug} sent ${who} one note for this call as a prompt, because this host cannot file one: ${size}`);
    return undefined;
  }

  async function close(reason, sentence = "", condition = "") {
    if (stopping) return;
    stopping = true;
    if (tick != null) clearInterval(tick);
    if (cardWatch != null) clearInterval(cardWatch);
    if (dialWatch != null) clearTimeout(dialWatch);
    if (sentence.length > 0) browser?.note(sentence, condition);
    // The line is going down with words on screen, so the panel is dissolved before the socket is.
    hearEnd("line-closed");
    setState("off");
    browser?.bye(reason, 1000, condition);
    try { provider?.close(1000, "done"); } catch { /* already gone */ }
    const settled = rowNow("closed", reason);
    await ledger.settle(settled).catch((error) => log(`voice could not settle the ledger: ${error?.message ?? error}`));
    // THE CLOSE LINE. The settled row in one sentence, because the row itself is a file a person has to
    // go and read and this is the thing a relay log already has in front of them. VOICE-14 adds the
    // barge-in count to it: a call where the person cut the agent off four times and a call where the
    // app never managed it once look identical everywhere else.
    log(`voice ${t.slug} settled this line: ${settled.wallSeconds} s, ${settled.audioInSeconds} s of audio in, `
      + `${settled.audioOutSeconds} s out, ${settled.toolCalls} turn(s) to the agent, ${settled.heldFrames} held frame(s), `
      + `${meter.bargeIns} barge-in(s), mic peak ${dbfs(meter.audioInPeak)} rms ${dbfs(meter.audioInSamples > 0 ? Math.sqrt(meter.audioInSumSq / meter.audioInSamples) : 0)}, `
      // VOICE-15c. A line where the provider wrote words nobody said looks IDENTICAL to a quiet call
      // everywhere else on this row, and it is the one number that says the microphone never arrived.
      + (meter.heardDropped > 0 ? `${meter.heardDropped} provider text(s) dropped with nothing heard, ` : "")
      + (meter.captureNative ? `phone mic frames ${meter.captureBlocks} seen ${meter.captureSent} sent, route ${meter.phoneRoute?.output || "never reported"}${meter.phoneRoute?.error ? ` error "${meter.phoneRoute.error}"` : ""}, ` : "")
      + `and it ended because ${reason}`);
    // VOICE-16. ONE MEMORY FOR THE WHOLE CALL, and it is written AFTER the ledger row is settled on
    // purpose. The row is what the day cap is read out of and what the operator's Spend line shows, so
    // nothing may delay it; and the session is released below, which is what lets the next press in, so
    // the note carries its own budget rather than holding the line shut for a gateway timeout. A call
    // where nothing was said -- a refusal, a line that dropped before a word -- writes nothing at all
    // rather than putting an empty row in somebody's conversation.
    await writeCallNote();
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
    /**
     * VOICE-15c. What this line has actually heard in the utterance it is on, so a gate can read the
     * two numbers the drop decision is made of rather than inferring them from a log line.
     */
    get heard() { return { bytes: heardWindow.bytes, peak: heardWindow.peak, soundMs: heardWindow.soundMs, sound: heardSound() }; },
    /** VOICE-14. Whether this line is running with barge-in, so a test can read it off the session. */
    get bargeIn() { return bargeIn; },
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
          //
          // VOICE-14. A BARGE-IN LINE NEVER HOLDS A FRAME. The app's own echo cancellation is what
          // keeps the agent out of the microphone there, and holding here is the one thing that makes
          // barge-in impossible: the provider's turn detection cannot fire on audio it never got. The
          // two ceilings below still apply, because those are about spend and not about echo.
          if (!bargeIn && !gate.admit(payload.byteLength)) return;
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
          // VOICE-14b: WHAT THE MICROPHONE ACTUALLY CARRIED. Five calls from the phone app on
          // 2026-09-12 sent 18 to 35 s of audio each and the provider heard no speech in any of
          // them; nothing on this side could say whether that audio was a voice or 24 kHz of
          // zeros. PCM16 little-endian, so the peak and the running sum of squares cost one loop.
          let framePeak = 0;
          for (let at = 0; at + 1 < payload.byteLength; at += 2) {
            const sample = payload.readInt16LE(at);
            const magnitude = sample < 0 ? -sample : sample;
            if (magnitude > framePeak) framePeak = magnitude;
            meter.audioInSumSq += sample * sample;
            meter.audioInSamples += 1;
          }
          if (framePeak > meter.audioInPeak) meter.audioInPeak = framePeak;
          // VOICE-15c. The same two numbers for THIS UTTERANCE, which is what decides whether a
          // provider transcript is allowed to be the person's words. The frame's own peak rather than
          // the window's is what moves the clock, so a single loud frame does not make the line count
          // as live for the rest of the call.
          heardWindow.bytes += payload.byteLength;
          if (framePeak > heardWindow.peak) heardWindow.peak = framePeak;
          if (framePeak >= HEARD_PEAK_FLOOR) heardWindow.soundMs = now();
          sendProvider({ type: "input_audio_buffer.append", audio: payload.toString("base64") });
          // VOICE-21. Count what has gone with nothing heard back, and say so once.
          oneWay.bytesSinceHeard += payload.byteLength;
          noteOneWayAudio();
        },
        onJson: (message) => {
          // VOICE-14. The opening frame. One field on it, and a browser does not send the frame at all,
          // so a desktop line carries exactly the bytes it carried before this wave.
          if (message?.t === "hello") {
            if (!helloSeen) {
              helloSeen = true;
              bargeIn = message.bargeIn === true;
              if (bargeIn) log(`voice ${t.slug} is talking from the app, so this line can be interrupted`);
            }
            return undefined;
          }
          if (message?.t === "stop") { void close("the person pressed the button"); return undefined; }
          if (message?.t === "ping") { browser?.sendJson({ t: "pong" }); return undefined; }
          if (message?.t === "held") { meter.browserHeld += Math.max(0, Number(message.frames) || 0); return undefined; }
          // VOICE-15d: what the phone's own audio session reports, and how many frames the shell has
          // handed the page. Logged so a call that heard nothing is readable here.
          if (message?.t === "route") {
            meter.phoneRoute = { output: String(message.output ?? ""), error: String(message.error ?? "").slice(0, 200) };
            log(`voice ${t.slug} phone route: output ${meter.phoneRoute.output || "?"}, category ${String(message.category ?? "?")}, `
              + `mode ${String(message.mode ?? "?")}, outputs ${JSON.stringify(Array.isArray(message.outputs) ? message.outputs.slice(0, 6) : [])}`
              + `, inputs ${JSON.stringify(Array.isArray(message.inputs) ? message.inputs.slice(0, 6) : [])}`
              + (message.permission ? `, mic permission ${String(message.permission)}` : "")
              + (message.capture ? `, capture: ${String(message.capture).slice(0, 200)}` : "")
              + (meter.phoneRoute.error ? `, error "${meter.phoneRoute.error}"` : ""));
            return undefined;
          }
          if (message?.t === "capture") {
            meter.captureBlocks = Math.max(0, Number(message.blocks) || 0);
            meter.captureSent = Math.max(0, Number(message.sent) || 0);
            meter.captureNative = message.native === true;
            return undefined;
          }
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
        //
        // VOICE-16 folds the brief in HERE and nowhere else. It was read before the dial, so this
        // handler stays synchronous -- an await in it would let forwarded microphone audio reach a
        // provider whose session was not configured yet -- and nothing rewrites it for the rest of the
        // call. A null brief is the phone line this always was, to the byte.
        const instructions = voiceInstructions({ agentName: agent.agentName || brief?.agentName || "Titan", brief });
        log(`voice ${t.slug} opened with ${brief == null ? "the phone-line instructions" : `${agent.agentName || "the agent"}'s own brief`}`
          + `, ${instructions.length} character(s) of instructions`);
        sendProvider(buildSession(vendor.id, { instructions, voice, model, tools: [titanTool()] }));
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
  // VOICE-14c. Off only in tests that count every frame on the wire; a real line always greets.
  greet = true,
  ownLikeParent = null,
  log = () => {},
  now = () => Date.now(),
  WebSocketImpl = null,
  providerUrl = "",
  capTickMs = CAP_TICK_MS,
  // How long a silent dial is waited on. A test and a gate shorten it so that proving the sentence
  // arrives is an assertion rather than an eight second wall-clock wait.
  dialWatchdogMs = DIAL_WATCHDOG_MS,
  // VOICE-19. How often a live line looks for a card the box raised between spoken turns.
  cardWatchMs = CARD_WATCH_MS,
  newSessionId = () => `vs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  // KEYS-1. The operator's own keys, read from the control plane and kept in memory by
  // ui/relay-secrets.mjs. Null is a console with no control plane -- every single-box install, every
  // gate on a laptop, grok-bot-local-vm -- and it means "there is only the file", which is exactly
  // what this edge did before this existed.
  secrets = null,
  // VOICE-10. WHICH PERSON is asking, for the one field on this door that is theirs rather than the
  // workspace's. It is ui/server.mjs's own subOf handed down, so the talk mode is keyed on exactly the
  // claim the device list and the notification settings are keyed on, and this file does not get a
  // second opinion about who somebody is. Absent -- every test that does not care, and every caller
  // before this shipped -- reads as the workspace's own, which is the same default subOf itself has.
  subOf = () => "",
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

  /**
   * KEYS-1. WHICH KEY DIALS, and the order is the whole of the migration.
   *
   * The control plane first, this workspace's own file second, nothing third. No code path writes a
   * file value up to the control plane: that would be a new write path for a secret and would undo
   * write-only-from-the-console. The fallback IS the migration, so mail and voice keep working on a
   * relay whose control plane holds nothing until the operator pastes each key once.
   *
   * Picked by THIS WORKSPACE'S OWN SERVICE, never by whichever key happens to exist. A workspace set
   * to a service the operator has no key for answers "" and gets the plain refusal, because dialling
   * one vendor with another vendor's credential is a 401 that reads to a person as a broken product.
   */
  async function keyFor(settings) {
    const fromControlPlane = secrets == null
      ? ""
      : await secrets.value(voiceKeyName(settings.vendor)).catch(() => "");
    if (String(fromControlPlane ?? "").length > 0) return String(fromControlPlane);
    return String(settings.apiKey ?? "");
  }

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
    // VOICE-10. Read once per request, so the GET's answer and the POST's write are about the same
    // person even if a session is renewed between them.
    let sub = "";
    try { sub = String(subOf(req) ?? ""); } catch { sub = ""; }
    const shapeNow = async (settings) => {
      const caps = await policy.for(t.slug);
      const rows = await readVoiceLedger(ledgerFile);
      const agents = (await rosterOf(call))
        .filter((a) => a?.isGroup !== true)
        .map((a) => ({ id: String(a.id), name: String(a.name ?? "") }));
      return voiceSettingsShape(settings, {
        agents,
        // VOICE-10. Whose talk mode this answer carries. One entry, never the map.
        sub,
        // KEYS-1. Whether there is a key for THIS workspace's service at all, wherever it lives.
        // This is what the console's Talking switch reads, and it is asked through the reader's
        // cached copy, so a settings GET costs no network after the relay's first read.
        available: (await keyFor(settings)).length > 0,
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
    // KEYS-1. THE DOOR CLOSES BEHIND THE FIELD, not just in front of it.
    //
    // Taking the key input off the customer's screen is not enough on its own: mergeVoiceSettings
    // accepts `apiKey` from any signed-in session, so a customer with a browser console could still
    // write one into their own workspace and have the relay dial with it. It is refused here, in
    // words, for every workspace but the operator's own.
    //
    // REFUSED AND NOT SILENTLY DROPPED. A 200 that quietly ignores a field a caller sent is the
    // failure APPS-DOC-1 is a row about: the caller believes it worked and nothing anywhere says
    // otherwise. Refusing also keeps grok-bot-local-vm working, where there is no control plane and
    // every session is the operator's, so the operator's own file stays writable.
    if (typeof patch?.apiKey === "string" && t.operator !== true) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ error: "not_yours", message: "Keys the product uses are set by your operator." }));
    }
    // VOICE-8. AND THE DOOR CLOSES BEHIND THE OTHER FOUR, for the same reason and in the same words.
    //
    // Which service does the talking, which model, which voice and which assistant every spoken turn
    // goes to are the OPERATOR'S choices: they are billed to his key, and the rows that set them are on
    // the Operator section of Settings, which a customer never sees. Until this shipped the route took
    // all four from any signed-in session, so a customer with a browser console could point their own
    // workspace's voice at a model he did not choose and have him pay for it. A client-side gate is not
    // a gate.
    //
    // REFUSED AND NOT SILENTLY DROPPED, the KEYS-1 rule: a 200 that quietly ignores a field the caller
    // sent is the failure where the caller believes it worked. `enabled` and `talkMode` stay open,
    // because those two really are the workspace's and the person's own.
    const operatorFields = OPERATOR_ONLY_VOICE_FIELDS.filter((name) => typeof patch?.[name] === "string");
    if (operatorFields.length > 0 && t.operator !== true) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({
        error: "not_yours",
        fields: operatorFields,
        message: "Which service does the talking, and which assistant it talks to, are set by your operator.",
      }));
    }
    const next = mergeVoiceSettings(await readVoiceSettings(settingsFile), patch, { sub });
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

    const onFile = await readVoiceSettings(settingsFile);
    // KEYS-1. The key that will actually dial, resolved once: the operator's own from the control
    // plane, else this workspace's file. Everything below -- the refusal, the session, the wire --
    // reads this one object, so there is no second place the choice could be made differently.
    const settings = { ...onFile, apiKey: await keyFor(onFile) };
    if (settings.apiKey.length === 0) {
      // NO KEY AND CANNOT SEE ARE DIFFERENT SENTENCES. `blind` is true only when there IS a control
      // plane, a read has been attempted, the last one did not get through, and nothing is cached
      // from one that did -- so a relay holding a good copy of a control plane that has since gone
      // down never lands here, and a deployment with no control plane at all never does either.
      //
      // It matters because the two are acted on by different people. "Voice is not switched on for
      // this workspace yet" sends the operator to paste a key; if the key is already pasted and this
      // relay simply cannot reach the control plane for a minute, that sends him to do a thing he
      // has already done over a fault that clears itself. `busy` says try again, which is true.
      if (secrets != null && secrets.blind === true) {
        return acceptAndSay(socket, key, SENTENCE.busy, "the keys the product uses could not be read", "no-key");
      }
      return acceptAndSay(socket, key, SENTENCE.noKey, "no realtime key", "no-key");
    }
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

      // VOICE-16. ONCE, HERE, BEFORE THE DIAL. This is the only read of the brief in a call's whole
      // life: the instructions are written from it at session.update and never rewritten, which is the
      // prefix-cache rule. It is read in this stretch -- which already awaits the settings file, the
      // operator's key, the policy, the ledger and the roster -- rather than in the provider's `open`
      // handler, so that handler stays synchronous and no microphone audio can reach a provider whose
      // session has not been configured. Null is never fatal: the line is then the phone line it was
      // before this wave, and readVoiceBrief logs which of the four reasons it was.
      const brief = await readVoiceBrief(call, agent.agentId, { workspaceName: String(t.name ?? ""), log, now });

      const sessionId = newSessionId();
      const ledger = ledgerFor(sessionId);
      const session = makeVoiceSession({
        greet, brief,
        t, settings, policy, agent, call, ledger, sessionId, now, WebSocketImpl, providerUrl, capTickMs, log,
        dialWatchdogMs, cardWatchMs,
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
export function voiceEdgeFor(t, { ownLikeParent = null, log = () => {}, relayBase = "", relayToken = "", WebSocketImpl = null, providerUrl = "", secrets = null, policy = null, subOf = () => "" } = {}) {
  const found = voiceEdges.get(t.slug);
  if (found != null && found.settingsFile === t.voiceSettingsFile) return found.edge;
  const edge = makeVoiceEdge({
    t,
    call: makeGatewayCall(t),
    // ONE policy for the relay when the caller has one (ui/server.mjs builds it, so the Usage row on
    // GET /me and this workspace's own upgrade read the same sixty second cache), and one of this
    // edge's own when nobody handed one down, which is how every test builds an edge.
    policy: policy ?? makeVoicePolicy({ relayBase, relayToken, log }),
    ownLikeParent,
    log,
    WebSocketImpl,
    providerUrl,
    // KEYS-1. ONE reader for the whole relay, built in ui/server.mjs and handed down, so every
    // workspace's edge reads the same cached copy and a fleet of tenants is not a fleet of timers.
    secrets,
    // VOICE-10. And one reader for who is asking, which is ui/server.mjs's own subOf.
    subOf,
  });
  voiceEdges.set(t.slug, { settingsFile: t.voiceSettingsFile, edge });
  return edge;
}

/** The route this upgrade branch answers, and nothing else on the relay answers it. */
export const VOICE_SOCKET_PATH = "/voice/socket";
