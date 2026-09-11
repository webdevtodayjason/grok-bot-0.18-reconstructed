// VOICE-1 — the microphone half, pinned without a browser.
//
// WHY THIS FILE IS LONGER THAN THE CODE IT TESTS. Every assertion here is a bug that has already
// shipped somewhere, and two of them shipped in the reference this design came from:
//
//   - THE GATE IS ASSERTED BY COUNTING DROPPED FRAMES, not by checking a constant exists.
//     wombatoperator/omarchy-voice has ECHO_TAIL_SECONDS = 0.35 at realtime.py:51, a
//     Speaker.is_playing(tail) at :284 and a self._held_frames = 0 at :389 -- and
//     input_audio_buffer.append appears exactly once, at :653, firing for every frame
//     unconditionally. `.is_playing(` has no call sites and _held_frames is never incremented. A
//     test that read the constant would have passed on that code, and her own session log is what
//     the 350 ms is for: her name came back through the microphone as a user turn, and a fragment
//     transcribed as an instruction pressed a key.
//
//   - THE RATE IS THE CONTEXT'S, NOT THE TRACK'S. MEASURED in Chrome:
//     getUserMedia({audio:{sampleRate:24000}}) hands back a 48000 track whatever is asked for.
//     Capture written against the track's own settings ships double-speed audio, which sounds like
//     a bad model rather than a bad rate -- so it is the kind of bug that gets chased for a day in
//     the wrong place. The fake stream here reports 48000 on purpose.
//
//   - THE TAIL IS THE PART MOST LIKELY TO BE WRONG AND LEAST LIKELY TO BE CAUGHT. An off-by-one on
//     the comparison, or a tail measured from the wrong end, leaves a window where the speaker is
//     still audible and the microphone is open. So 349 ms and 351 ms are both pinned, and pinned by
//     driving real frames through the real capture function rather than by reading the predicate.
//
//   - playsUntilMs IS BOOKED FROM BYTES. "Is the queue empty" is the wrong question; the model
//     sends a reply far faster than it is spoken (realtime.py:278-282 says so in its own comment).
//
//   - `held` IS A PARAMETER. MEETING-1 shares this function, and two captures running at once --
//     a microphone and the system audio of a meeting -- must not share one gate by accident.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voicePath = path.join(repoRoot, "ui/machine-room/voice.js");

// The module is a classic script, the same contract cloud-browser.js keeps, so it is loaded by
// handing it a fake window rather than imported. `document` is left undefined, which is what stops
// it mounting itself into a page that is not there.
async function loadVoice(extra = {}) {
  const source = await readFile(voicePath, "utf8");
  const fake = {
    ArrayBuffer,
    setTimeout, clearTimeout, setInterval, clearInterval,
    ...extra,
  };
  new Function("window", source)(fake);
  return fake.__voice;
}

// ------------------------------------------------------------------ fakes
class FakeAudioContext {
  static made = [];
  constructor(options = {}) {
    this.options = options;
    // The whole point: whatever the track says, this is the rate the samples arrive at.
    this.sampleRate = options.sampleRate;
    this.currentTime = 0;
    this.closed = false;
    this.audioWorklet = { addModule: async (url) => { this.module = url; } };
    FakeAudioContext.made.push(this);
  }
  createMediaStreamSource(stream) {
    this.stream = stream;
    return { connect: () => { this.connected = true; }, disconnect: () => {} };
  }
  close() { this.closed = true; }
}

const nodes = [];
class FakeAudioWorkletNode {
  constructor(context, name) {
    this.context = context;
    this.name = name;
    this.port = { onmessage: null };
    nodes.push(this);
  }
  disconnect() {}
}
// The node the capture made is the one whose context is the one it made, so the test can reach the
// port the code wired without the code having to hand it back.
const findNode = (context) => nodes.filter((one) => one.context === context).at(-1) ?? null;

// A track that insists it is 48 kHz, which is what Chrome actually does.
const fakeStream = (rate = 48000) => ({
  getTracks: () => [{ stop() {}, getSettings: () => ({ sampleRate: rate, channelCount: 1 }) }],
  getAudioTracks: () => [{ getSettings: () => ({ sampleRate: rate }) }],
});

async function openCapture(voice, options = {}) {
  FakeAudioContext.made.length = 0;
  let asked = null;
  const capture = await voice.captureAudio({
    source: options.source ?? "microphone",
    sampleRate: 24000,
    frameBytes: 4800,
    held: options.held ?? (() => false),
    onChunk: options.onChunk ?? (() => {}),
    audio: {
      AudioContext: FakeAudioContext,
      AudioWorkletNode: FakeAudioWorkletNode,
      workletUrl: "fake://worklet",
      getUserMedia: async (constraints) => { asked = constraints; return fakeStream(); },
      now: options.now ?? (() => 0),
    },
  });
  const context = FakeAudioContext.made.at(-1);
  // The worklet node the capture made is the one holding the port the test feeds.
  const node = context == null ? null : findNode(context);
  return { capture, context, node, asked };
}

const feed = (node, samples) => node.port.onmessage({ data: samples });

test("VOICE-1 capture: the rate is the context's, so a 48 kHz track still yields 24 kHz frames of exactly 4800 bytes", async () => {
  const voice = await loadVoice();
  const chunks = [];
  const { context, node, asked } = await openCapture(voice, { onChunk: (buffer) => chunks.push(buffer) });
  assert.equal(context.options.sampleRate, 24000, "the AudioContext is asked for 24 kHz; the browser resamples into it");
  assert.equal(context.sampleRate, 24000);
  // The track said 48000 and nothing read it. A capture that trusted the track would be here.
  assert.equal(context.stream.getAudioTracks()[0].getSettings().sampleRate, 48000,
    "the fake track reports 48 kHz on purpose, because a real one does");
  // Chromium's own switch list warns the fake-audio file is mangled by audio processing, and on a
  // real microphone the echo gate is the defence rather than the browser's canceller.
  assert.equal(asked.audio.echoCancellation, false);
  assert.equal(asked.audio.noiseSuppression, false);
  assert.equal(asked.audio.autoGainControl, false);

  // 2400 samples is one frame. Fed as 128-sample blocks, the way a worklet actually delivers them,
  // so the accumulator is exercised and not bypassed.
  for (let n = 0; n < 19; n += 1) feed(node, new Float32Array(128).fill(0.5));
  assert.equal(chunks.length, 1, "2432 samples is one whole frame and part of the next");
  assert.equal(chunks[0].byteLength, 4800, "4800 bytes, never 4799 and never a short last frame");
  const view = new Int16Array(chunks[0]);
  assert.equal(view.length, 2400);
  assert.ok(view[0] > 16000 && view[0] < 16500, `0.5 is about half of full scale, got ${view[0]}`);
});

test("VOICE-1 capture: with the gate open every frame reaches the wire", async () => {
  const voice = await loadVoice();
  const chunks = [];
  const { capture, node } = await openCapture(voice, { held: () => false, onChunk: (b) => chunks.push(b) });
  for (let n = 0; n < 3; n += 1) feed(node, new Float32Array(2400).fill(0.1));
  assert.equal(chunks.length, 3);
  assert.equal(capture.stats.sent, 3);
  assert.equal(capture.stats.heldFrames, 0);
  assert.equal(capture.stats.bytes, 14400);
});

test("VOICE-1 capture: with the gate shut NOTHING reaches the wire, and the drops are counted", async () => {
  const voice = await loadVoice();
  const chunks = [];
  const { capture, node } = await openCapture(voice, { held: () => true, onChunk: (b) => chunks.push(b) });
  for (let n = 0; n < 5; n += 1) feed(node, new Float32Array(2400).fill(0.9));
  // Dropped: not muted on the wire, not zero-filled, not queued for later. This is the assertion
  // that would have failed on the reference implementation.
  assert.equal(chunks.length, 0, "a held frame is never sent");
  assert.equal(capture.stats.sent, 0, "and `sent` stays flat, so the two numbers cannot both be right");
  assert.equal(capture.stats.heldFrames, 5);
  assert.equal(Math.round(capture.stats.heldMs), 500, "five 100 ms frames");
});

test("VOICE-1 gate: a frame at speak-end + 349 ms is still held and one at +351 ms is sent", async () => {
  const voice = await loadVoice();
  let clock = 0;
  const gate = voice._echoGate({ now: () => clock, sampleRate: 24000 });
  const chunks = [];
  const { capture, node } = await openCapture(voice, {
    held: () => gate.holding(),
    onChunk: (b) => chunks.push(b),
    now: () => clock,
  });

  // Your agent starts speaking. Nothing leaves the page while he does.
  gate.begin();
  clock = 500;
  feed(node, new Float32Array(2400).fill(0.4));
  assert.equal(chunks.length, 0, "the microphone is shut for the whole spoken reply");

  clock = 1000;
  gate.end();
  assert.equal(gate.holdUntilMs(), 1350, "the tail runs from the end of the sound, not from the frame");

  clock = 1349;
  feed(node, new Float32Array(2400).fill(0.4));
  assert.equal(chunks.length, 0, "one millisecond inside the tail is inside the tail");
  assert.equal(capture.stats.heldFrames, 2);

  clock = 1351;
  feed(node, new Float32Array(2400).fill(0.4));
  assert.equal(chunks.length, 1, "and one millisecond past it, the microphone is open again");
  assert.equal(capture.stats.sent, 1);
  assert.equal(voice._ECHO_TAIL_MS, 350);
});

test("VOICE-1 gate: playsUntilMs is booked from bytes, not from an empty queue", async () => {
  const voice = await loadVoice();
  let clock = 0;
  const gate = voice._echoGate({ now: () => clock, sampleRate: 24000 });
  // 4800 bytes of 24 kHz mono PCM16 is 100 ms: bytes / (rate * 2) * 1000.
  assert.equal(gate.queue(4800), 100);
  // A second chunk handed over 10 ms later does NOT finish at 110. The model sends far faster than
  // the speaker plays, so the second chunk starts where the first one ends.
  clock = 10;
  assert.equal(gate.queue(4800), 200);
  assert.equal(gate.playsUntilMs(), 200);
  // Which is also why the gate is still shut at 150, with an empty queue and sound in the room.
  clock = 150;
  assert.equal(gate.holding(), true, "sound is still coming out of the speaker");
  clock = 549;
  assert.equal(gate.holding(), true, "200 + 350");
  clock = 551;
  assert.equal(gate.holding(), false);
});

test("VOICE-1 capture: two captures with different gates do not interfere, which is what MEETING-1 needs", async () => {
  const voice = await loadVoice();
  const mic = [];
  const room = [];
  let micShut = true;
  const a = await openCapture(voice, { held: () => micShut, onChunk: (b) => mic.push(b) });
  const b = await openCapture(voice, { source: fakeStream(), held: () => false, onChunk: (c) => room.push(c) });
  feed(a.node, new Float32Array(2400).fill(0.2));
  feed(b.node, new Float32Array(2400).fill(0.2));
  assert.equal(mic.length, 0, "one capture's gate is shut");
  assert.equal(room.length, 1, "and the other's is open, at the same instant");
  micShut = false;
  feed(a.node, new Float32Array(2400).fill(0.2));
  assert.equal(mic.length, 1);
  assert.equal(a.capture.stats.heldFrames, 1);
  assert.equal(b.capture.stats.heldFrames, 0, "the counts are per capture, never shared");
});

test("VOICE-1 capture: a MediaStream source is accepted whole, so a meeting need not fork this", async () => {
  const voice = await loadVoice();
  let askedForMicrophone = false;
  const stream = fakeStream();
  const capture = await voice.captureAudio({
    source: stream,
    sampleRate: 24000,
    frameBytes: 4800,
    held: () => false,
    onChunk: () => {},
    audio: {
      AudioContext: FakeAudioContext,
      AudioWorkletNode: FakeAudioWorkletNode,
      workletUrl: "fake://worklet",
      getUserMedia: async () => { askedForMicrophone = true; return stream; },
    },
  });
  assert.equal(askedForMicrophone, false, "a stream that was handed over is not asked for again");
  assert.equal(FakeAudioContext.made.at(-1).stream, stream, "and it is the stream that was connected");
  // mutedFrames is VOICE-7's: push to talk drops every frame between two holds, and those are counted
  // APART from heldFrames, which is the echo gate's own number and the proof that the agent never
  // hears himself. One counter for both would make that proof unreadable the moment anybody used the
  // default mode.
  // `blocks` is VOICE-11's, and it is asked before any gate: it is the only honest answer to "is this
  // microphone producing anything at all", which is what a phone that hands over a device and then
  // never feeds it looks like from here.
  // `micLevel` and `micFrames` are VOICE-13's, and they are the call screen's reason to exist at all:
  // the microphone had no level anywhere in this console (stats().level is the PLAYBACK analyser), so
  // the avatar on a phone call had nothing to react to while somebody was talking. It is an RMS of the
  // frame that is about to go, taken inside this same loop, and it reads 0 for a frame a mute or the
  // echo gate dropped. The four numbers above it are untouched, which is asserted in
  // tests/machine-room-voice.test.mjs across a muted frame.
  assert.deepEqual(Object.keys(capture.stats).sort(),
    ["blocks", "bytes", "heldFrames", "heldMs", "micFrames", "micLevel", "mutedFrames", "sent"]);
  assert.equal(typeof capture.stop, "function");
});

test("VOICE-1 capture: stopping releases the microphone and the context", async () => {
  const voice = await loadVoice();
  const chunks = [];
  const { capture, context, node } = await openCapture(voice, { onChunk: (b) => chunks.push(b) });
  capture.stop();
  // A stopped capture that still answers its port is a microphone nobody thinks is open.
  if (node.port.onmessage != null) feed(node, new Float32Array(2400).fill(0.5));
  assert.equal(chunks.length, 0);
  assert.equal(context.closed, true);
});

test("VOICE-1 playback: it schedules ahead, books the gate from bytes, and never blocks the socket", async () => {
  const voice = await loadVoice();
  let clock = 0;
  const gate = voice._echoGate({ now: () => clock, sampleRate: 24000 });
  const started = [];
  class PlaybackContext {
    constructor(options) { this.sampleRate = options.sampleRate; this.currentTime = 0; this.destination = {}; }
    createBuffer(channels, length, rate) {
      return { length, duration: length / rate, copyToChannel(data) { this.data = data; } };
    }
    createBufferSource() {
      const node = { connect: () => {}, start: (at) => { started.push(at); } };
      return node;
    }
    createAnalyser() { return { fftSize: 2048, connect: () => {}, getFloatTimeDomainData: (d) => d.fill(0.3) }; }
    close() { this.closed = true; }
  }
  const sound = voice.player({ gate, AudioContext: PlaybackContext, sampleRate: 24000 });

  // 100 ms of audio, then another 100 ms that arrived instantly after it -- which is what a realtime
  // model actually does. The second must be scheduled where the first ends, not played over it.
  const chunk = new Uint8Array(4800);
  assert.equal(sound.push(chunk), 100, "the gate is booked from the bytes that were queued");
  assert.equal(sound.push(chunk), 200, "and the second chunk lands after the first, not on top of it");
  assert.deepEqual(started, [0, 0.1], "scheduled ahead on the audio clock, which is what stops the stutter");
  assert.equal(sound.stats().bytes, 9600);
  assert.equal(sound.stats().buffers, 2);

  // And the microphone stays shut for all of it plus the tail, with an empty queue the whole time.
  clock = 199;
  assert.equal(gate.holding(), true, "sound is still in the room");
  clock = 549;
  assert.equal(gate.holding(), true);
  clock = 551;
  assert.equal(gate.holding(), false);

  // Real energy, not a silent buffer of the right length. This is the observable that replaces
  // HTMLMediaElement.played, which a Web Audio path does not have.
  assert.ok(sound.level() > 0.25, `RMS should be about 0.3, got ${sound.level()}`);
  sound.close();
});

test("VOICE-1: PCM16 round-trips, because a sign error here is audible and silent in a diff", async () => {
  const voice = await loadVoice();
  const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const pcm = voice._pcm16FromFloat32(input);
  assert.equal(pcm.length, 5);
  assert.equal(pcm[0], 0);
  assert.equal(pcm[3], 32767);
  assert.equal(pcm[4], -32768);
  const back = voice._float32FromPcm16(new Uint8Array(pcm.buffer));
  assert.equal(back.length, 5);
  for (let i = 0; i < 5; i += 1) assert.ok(Math.abs(back[i] - input[i]) < 0.001, `sample ${i}: ${back[i]} vs ${input[i]}`);
  // Anything past full scale is clamped rather than wrapped. A wrap is a loud click.
  const loud = voice._pcm16FromFloat32(new Float32Array([4, -4]));
  assert.equal(loud[0], 32767);
  assert.equal(loud[1], -32768);
});
