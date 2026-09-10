/*
 * VOICE-1 — the console's side of talking to your agent.
 * ------------------------------------------------------
 * One button beside the composer, one orb, a microphone, a speaker, and a live caption. Press to
 * start, press to stop. There is no wake word and nothing listens when the button is off.
 *
 * WHAT THIS FILE IS NOT. It is not a voice assistant. The realtime model on the other end of the
 * relay is a mouth and a pair of ears; it holds exactly one tool, which puts what you said into
 * your agent's own conversation and reads his answer back. Memory, persona, the team and every
 * approval stay his. So nothing here decides anything, nothing here knows which provider is in
 * use, and nothing here is told a model name. The orb's four states arrive as words from the
 * relay, because only the relay knows when the agent is working.
 *
 * WHY IT IS ITS OWN FILE. Three waves paint this console at once. cloud-browser.js already proved
 * the shape and index.html:400-422 writes the contract down: an IIFE that publishes its global at
 * load, reads window.__machineRoomAdapter and window.__mrUi LAZILY, finds its own hosts in the DOM,
 * and no-ops entirely when either is absent. Nothing in app.js calls this file. The only lines this
 * wave puts in anyone else's file are the <script> tag, the talk button, one line in
 * gateway-adapter.js and one line in app.js for the spoken chip.
 *
 * THE ECHO GATE, AND WHY IT IS HERE AS WELL AS ON THE RELAY. A speaker plays into a microphone. The
 * reference this design came from (wombatoperator/omarchy-voice) has ECHO_TAIL_SECONDS = 0.35, a
 * Speaker.is_playing(tail) and a _held_frames counter in its source, and none of the three is ever
 * called: input_audio_buffer.append fires for every frame unconditionally. Her own session log is
 * what the 350 ms is for -- her name came back through the microphone as a user turn, and a
 * fragment transcribed as an instruction pressed a key. So the gate is written here and asserted by
 * a test that frames were DROPPED, not that a constant exists. The relay drops the same window
 * again, so a patched page cannot make the model hear itself.
 *
 * playsUntilMs IS BOOKED FROM BYTES, never from "is the queue empty". The model sends a reply far
 * faster than it is spoken; the question is whether sound is still in the room (realtime.py:278-282
 * says exactly this in its own comment).
 *
 * NO BARGE-IN. Speaking while your agent speaks interrupts nothing, because the microphone is shut.
 * On speakers that was never a feature: the thing being interrupted was the person. The Voice card
 * says so in one sentence.
 *
 * PLAYBACK IS WEB AUDIO, which is a design decision with a cost. PCM16 deltas become AudioBuffers
 * on AudioBufferSourceNodes, scheduled OFF the socket's onmessage path -- draining the player inline
 * is what froze omarchy's event handling, tool calls included, for the length of every spoken reply
 * (realtime.py:270-276). The cost is that there is no HTMLMediaElement and therefore no `.played`
 * TimeRanges for a gate to read. What a gate reads instead: ctx.currentTime advancing, an
 * AnalyserNode's RMS above a floor, bytes queued, and the held counts from both sides.
 */
(function attachVoice(global) {
  "use strict";

  // 24 kHz mono PCM16. 4800 bytes = 2400 samples = 100 ms, which is the frame both sides count in.
  const SAMPLE_RATE = 24000;
  const FRAME_BYTES = 4800;
  // The tail the microphone stays shut for after the last sound has left the speaker.
  const ECHO_TAIL_MS = 350;

  // The orb has four states and no others. They arrive from the relay as words; anything else is
  // ignored rather than guessed at, because a wrong orb is worse than a still one.
  const ORB_STATES = ["off", "listening", "thinking", "speaking"];

  // Every sentence a person can read on this control. Plain words: no prefix, no underline, no
  // vendor, no tool name, no machine's noun. host-notes-read-as-errors.md is the rule -- a line
  // that looks like a stack trace gets read as one, so none of these is styled as a failure.
  //
  // Six conditions. Two are the browser's own (the microphone, a line that went away); the other
  // four arrive from the relay, which sends its own wording and falls back to these.
  const NOTES = {
    "no-microphone": "This page has not been given the microphone yet. Allow it in your browser and press Talk again.",
    // No second clause telling the person to open settings: the control beside this sentence is that
    // clause, and MEASURED on screen the two together read as the same words twice.
    "no-key": "Talking is not available on this workspace yet.",
    "day-cap": "This workspace has used all of today's talking time. It starts again at midnight UTC.",
    "session-cap": "That call reached its length limit. Press Talk to start another one.",
    "box-not-running": "Your agent's computer is not running, so there is nobody to talk to yet. Start it and press Talk again.",
    "line-dropped": "The line dropped. Press Talk to start again.",
  };
  // The one note that leads somewhere: nothing is set up, so offer the card that sets it up.
  const NOTE_ACTIONS = { "no-key": "Open voice settings" };
  // A refusal the relay makes mid-call closes with a code, because by then there is no longer a
  // socket to send a frame down. The code names the condition so the right sentence -- and, for a
  // missing key, the right control -- can still be put in front of the person.
  const CLOSE_CONDITIONS = { 4001: "no-key", 4002: "day-cap", 4003: "session-cap", 4004: "box-not-running" };

  const STRIP_ID = "voice-strip";
  const CARD_ATTRIBUTE = "data-voice";

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const sentenceFor = (condition) => NOTES[condition] ?? NOTES["line-dropped"];
  const orbStateFor = (value) => (ORB_STATES.includes(String(value)) ? String(value) : null);

  // ------------------------------------------------------------------ the echo gate
  //
  // Held from speak-begin to speak-end + 350 ms, where the end is whichever comes later: the
  // relay saying the reply is over, or the last byte we queued finishing its way out of the
  // speaker. Booked from bytes so a reply that arrived in one burst is still held while it plays.
  function echoGate(options = {}) {
    const now = options.now ?? (() => Date.now());
    const rate = options.sampleRate ?? SAMPLE_RATE;
    let speaking = false;
    let playsUntilMs = 0;
    let endedAtMs = 0;
    const gate = {
      begin() { speaking = true; },
      end() { speaking = false; endedAtMs = now(); },
      // Bytes queued, not a queue-empty check. Returns when the sound will have finished.
      queue(bytes) {
        const startAt = Math.max(now(), playsUntilMs);
        playsUntilMs = startAt + (bytes / (rate * 2)) * 1000;
        return playsUntilMs;
      },
      playsUntilMs: () => playsUntilMs,
      holdUntilMs: () => Math.max(playsUntilMs, endedAtMs) + ECHO_TAIL_MS,
      holding() { return speaking || now() < gate.holdUntilMs(); },
      // The DROPS are counted by the capture that did the dropping, not here: MEETING-1 hands one
      // gate to two captures, and a shared counter could not say which source was held.
      stats: () => ({ speaking, playsUntilMs }),
      reset() { speaking = false; playsUntilMs = 0; endedAtMs = 0; },
    };
    return gate;
  }

  // ------------------------------------------------------------------ PCM
  function pcm16FromFloat32(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const clamped = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return out;
  }

  function float32FromPcm16(buffer) {
    const view = new Int16Array(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, Math.floor((buffer.byteLength ?? buffer.length) / 2));
    const out = new Float32Array(view.length);
    for (let i = 0; i < view.length; i += 1) out[i] = view[i] / 0x8000;
    return out;
  }

  // The worklet is three lines and lives here rather than in a file of its own, because a second
  // network fetch is a second way for this control to be half-loaded. It posts the raw Float32
  // block; all the arithmetic is on the main thread where the tests can reach it.
  const WORKLET_SOURCE = `
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("voice-capture", VoiceCaptureProcessor);
`;

  // ------------------------------------------------------------------ capture
  //
  // MEETING-1 shares this function rather than forking it, which is why `source` is either the
  // string "microphone" or a MediaStream (a meeting needs system audio too) and why `held` is a
  // CALLBACK ASKED BEFORE EVERY CHUNK rather than a global somebody has to remember to set.
  //
  // The resample is the AudioContext's, not the track's. MEASURED: getUserMedia({audio:{sampleRate:
  // 24000}}) hands back a 48000 track whatever you ask for, so capture written against the track's
  // own settings ships double-speed audio -- which sounds like a bad model rather than a bad rate,
  // and is therefore the kind of bug that gets chased in the wrong place for a day.
  //
  // echoCancellation / noiseSuppression / autoGainControl are all off. Chromium's own switch list
  // warns that the fake-audio file is mangled by audio processing, so the gate's WAV would arrive
  // unusable otherwise -- and on a real microphone the gate above is the defence, not the browser's.
  async function captureAudio(options = {}) {
    const sampleRate = options.sampleRate ?? SAMPLE_RATE;
    const frameBytes = options.frameBytes ?? FRAME_BYTES;
    const frameSamples = frameBytes / 2;
    const held = typeof options.held === "function" ? options.held : () => false;
    const onChunk = typeof options.onChunk === "function" ? options.onChunk : () => {};
    const source = options.source ?? "microphone";
    const audio = options.audio ?? {};
    const AudioContextClass = audio.AudioContext ?? global.AudioContext ?? global.webkitAudioContext;
    const AudioWorkletNodeClass = audio.AudioWorkletNode ?? global.AudioWorkletNode;
    const getUserMedia = audio.getUserMedia
      ?? ((constraints) => global.navigator.mediaDevices.getUserMedia(constraints));
    const moduleUrl = audio.workletUrl ?? null;
    const now = audio.now ?? (() => Date.now());
    if (AudioContextClass == null || AudioWorkletNodeClass == null) {
      throw new Error("this browser has no audio worklet");
    }

    const stream = source === "microphone"
      ? await getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      })
      : source;

    const context = new AudioContextClass({ sampleRate });
    const url = moduleUrl ?? blobUrlFor(WORKLET_SOURCE);
    await context.audioWorklet.addModule(url);
    const node = new AudioWorkletNodeClass(context, "voice-capture");
    const input = context.createMediaStreamSource(stream);
    input.connect(node);

    const stats = { sent: 0, heldFrames: 0, heldMs: 0, bytes: 0 };
    let pending = new Float32Array(0);
    let stopped = false;

    node.port.onmessage = (event) => {
      if (stopped) return;
      const block = event.data;
      if (block == null || block.length === 0) return;
      const joined = new Float32Array(pending.length + block.length);
      joined.set(pending, 0);
      joined.set(block, pending.length);
      pending = joined;
      while (pending.length >= frameSamples) {
        const frame = pending.subarray(0, frameSamples);
        pending = pending.slice(frameSamples);
        // Asked before every chunk. A held frame is never sent -- not muted on the wire, not
        // zero-filled, not queued for later: dropped, and counted.
        if (held()) {
          stats.heldFrames += 1;
          stats.heldMs += (frameSamples / sampleRate) * 1000;
          continue;
        }
        const pcm = pcm16FromFloat32(frame);
        stats.sent += 1;
        stats.bytes += pcm.byteLength;
        onChunk(pcm.buffer, { at: now(), bytes: pcm.byteLength });
      }
    };

    return {
      stats,
      stop() {
        if (stopped) return;
        stopped = true;
        try { node.port.onmessage = null; } catch { /* a fake node may not allow it */ }
        try { input.disconnect(); } catch { /* already gone */ }
        try { node.disconnect(); } catch { /* already gone */ }
        if (source === "microphone") {
          for (const track of stream.getTracks?.() ?? []) { try { track.stop(); } catch { /* already stopped */ } }
        }
        try { context.close?.(); } catch { /* already closed */ }
        if (moduleUrl == null && url.startsWith?.("blob:")) { try { global.URL.revokeObjectURL(url); } catch { /* fine */ } }
      },
    };
  }

  function blobUrlFor(source) {
    const blob = new global.Blob([source], { type: "text/javascript" });
    return global.URL.createObjectURL(blob);
  }

  // ------------------------------------------------------------------ playback
  //
  // Scheduled, never drained inline. Each delta is one AudioBuffer on one source node, started at
  // whichever is later: now, or the end of what is already booked. The analyser is there so a gate
  // can tell real sound from a silent buffer of the right length.
  function player(options = {}) {
    const gate = options.gate;
    const AudioContextClass = options.AudioContext ?? global.AudioContext ?? global.webkitAudioContext;
    const sampleRate = options.sampleRate ?? SAMPLE_RATE;
    let context = null;
    let analyser = null;
    let nextAt = 0;
    const stats = { bytes: 0, buffers: 0 };

    function ensure() {
      if (context != null) return context;
      context = new AudioContextClass({ sampleRate });
      if (typeof context.createAnalyser === "function") {
        analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.connect(context.destination);
      }
      nextAt = context.currentTime;
      return context;
    }

    return {
      // Returns when this chunk will have finished, which is what the echo gate books from.
      push(bytes) {
        const ctx = ensure();
        if (ctx.state === "suspended") ctx.resume?.();
        const samples = float32FromPcm16(bytes);
        if (samples.length === 0) return gate?.playsUntilMs?.() ?? 0;
        const buffer = ctx.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel ? buffer.copyToChannel(samples, 0) : buffer.getChannelData(0).set(samples);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(analyser ?? ctx.destination);
        const at = Math.max(ctx.currentTime, nextAt);
        node.start(at);
        nextAt = at + buffer.duration;
        stats.bytes += bytes.byteLength ?? bytes.length ?? 0;
        stats.buffers += 1;
        return gate?.queue?.(bytes.byteLength ?? bytes.length ?? 0) ?? 0;
      },
      // What a gate reads instead of HTMLMediaElement.played: the clock moving, and real energy.
      level() {
        if (analyser == null) return 0;
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData?.(data);
        let sum = 0;
        for (const value of data) sum += value * value;
        return Math.sqrt(sum / data.length);
      },
      currentTime: () => context?.currentTime ?? 0,
      stats: () => ({ ...stats }),
      close() {
        try { context?.close?.(); } catch { /* already closed */ }
        context = null; analyser = null; nextAt = 0;
      },
    };
  }

  // ------------------------------------------------------------------ the strip a person reads
  //
  // The transcript is rebuilt wholesale on every render (app.js's renderAll), so nothing this file
  // draws can live inside it. The durable record of a spoken turn is the transcript row itself,
  // which carries the spoken chip because the relay sends the prompt under a "voice:" nonce. This
  // strip is the LIVE half: what is being heard, what is being said, and any note.
  function stripMarkup() {
    return `<div class="voice-strip" id="${STRIP_ID}" data-voice-strip hidden>`
      + `<p class="voice-caption" data-voice-caption></p>`
      + `<div class="voice-notes" data-voice-notes></div>`
      + `</div>`;
  }

  // A quiet row. Detail-less on purpose: an expander here would be a machine's innards beside a
  // conversation. is-system is the console's own muted bubble; is-turn-failed is the one class this
  // row may never carry, because none of these six sentences is a failed turn.
  function noteMarkup(condition, text) {
    const sentence = text && String(text).trim().length > 0 ? String(text).trim() : sentenceFor(condition);
    const action = NOTE_ACTIONS[condition];
    return `<article class="message-row is-system voice-note" data-voice-note="${escapeHtml(condition)}">`
      + `<div class="message-bubble">${escapeHtml(sentence)}`
      + (action ? `<button class="quiet-button voice-note-action" type="button" data-voice-open-settings>${escapeHtml(action)}</button>` : "")
      + `</div></article>`;
  }

  // ------------------------------------------------------------------ the Voice card
  //
  // Rendered into the settings panel this file finds itself, the road cloud-browser.js takes. It
  // reads and writes /voice/settings on the relay; the answer only ever carries apiKeySet, so the
  // field is paste-or-clear and can never show a value back.
  //
  // The agent choice is the one control that decides whether the first press reaches the head of
  // the team or a narrow worker, so it is a list of names and not a box to type an id into.
  function voiceCardMarkup() {
    return `<section class="settings-section" ${CARD_ATTRIBUTE}><h3>Talking</h3>`
      + `<p>Press Talk beside the message box and say what you want. What you say goes into your agent's own conversation and he answers out loud, so it is the same thread you type in and the same memory. He is the only one who can act on it.</p>`
      + `<div class="setting-row"><div><strong>Talking</strong><small data-voice-enabled-note>Reading from the relay…</small></div><button class="switch" type="button" data-voice-enabled aria-pressed="false"></button></div>`
      + `<div class="field"><label for="voice-agent">Who you are talking to</label><select id="voice-agent" data-voice-agent></select><small class="field-hint">The head of your team, normally. Everything you say goes to this one agent.</small></div>`
      // Model and Voice are PLACEHOLDERS and are never prefilled. The relay falls back to the
      // service's own default when either is empty, so an empty field is the whole of "use theirs" --
      // and a prefilled one put a vendor's product name on a customer's own card, which is the one
      // place in this product that names no vendor anywhere else.
      + `<div class="voice-grid"><label>Service<select data-voice-vendor></select></label><label>Model<input type="text" autocomplete="off" placeholder="The service's own" data-voice-model /></label><label>Voice<input type="text" autocomplete="off" placeholder="The service's own" data-voice-voice /></label></div>`
      + `<div class="mail-block"><strong>Key</strong><small class="field-hint" data-voice-key-note>Reading from the relay…</small><div class="mail-secret-row"><input type="password" autocomplete="off" placeholder="Paste your key" data-voice-key /><button class="ghost-button" type="button" data-voice-key-set>Save key</button><button class="danger-button" type="button" data-voice-key-clear>Clear</button></div><small class="field-hint">The key stays on the relay and never reaches this page again. Nothing is spoken to the service from your browser; the relay holds that line, which is how the minutes below can be counted at all.</small></div>`
      + `<div class="setting-row"><div><strong>Time used today</strong><small data-voice-usage>Reading from the relay…</small></div></div>`
      + `<p class="field-hint">Speaking while your agent is speaking interrupts nothing: the microphone is shut while he talks, and for a third of a second after, so he never hears himself through your speakers. Wait for him to finish.</p>`
      + `<div class="form-actions"><button class="primary-button" type="button" data-voice-save>Save</button></div>`
      + `</section>`;
  }

  // ------------------------------------------------------------------ the session
  const state = {
    socket: null,
    capture: null,
    gate: null,
    sound: null,
    on: false,
    orb: "off",
    ready: null,
    heldReported: 0,
    notes: [],
    caption: "",
    settings: null,
    byeReason: "",
    available: null,
    /** The relay's hop ledger for the last turn, when it sent one. Never drawn. */
    hops: null,
  };

  function ui() { return global.__mrUi ?? null; }
  function adapter() { return global.__machineRoomAdapter ?? null; }

  function relayFetch(path, init) {
    return global.fetch(path, init);
  }

  function orb(value) {
    const next = orbStateFor(value);
    if (next == null) return;
    state.orb = next;
    paint();
  }

  function note(condition, text, fromRelay = false) {
    state.notes = [{ condition, text, fromRelay }];
    paint();
  }

  // A refusal arrives as a note frame carrying the relay's own sentence and then a bye naming the
  // condition. The sentence the relay wrote is the one the person reads -- only the condition is
  // taken from the bye, which is what decides whether the row offers a way forward.
  function retitleNote(condition, fromRelay = false) {
    if (state.notes.length === 0 || !NOTES[condition]) return false;
    // THE RELAY'S DIAGNOSIS OUTRANKS THE PAGE'S. MEASURED on the R750 2026-09-10, in a browser with
    // no microphone permission on a workspace with no realtime key: the relay said no-key and drew the
    // control that opens the card, then the microphone failed and the page retitled the same row
    // no-microphone. The sentence on screen still said to add a key, the control that would let the
    // person do it was gone, and the row named the wrong cause. The relay knows why the line did not
    // open; this page only knows about its own microphone, and that is the lesser fact once the line
    // was already refused.
    if (state.notes[0].fromRelay && !fromRelay) return true;
    state.notes = [{ condition, text: state.notes[0].text, fromRelay: state.notes[0].fromRelay }];
    paint();
    return true;
  }

  function clearNotes() {
    state.notes = [];
    paint();
  }

  function caption(text) {
    state.caption = String(text ?? "");
    paint();
  }

  function paint() {
    const document_ = global.document;
    if (document_ == null) return;
    const button = document_.querySelector("[data-voice-talk]");
    if (button != null) {
      const node = button.querySelector("[data-voice-orb]");
      if (node != null) node.setAttribute("data-state", state.orb);
      button.setAttribute("aria-pressed", state.on ? "true" : "false");
      button.classList.toggle("is-live", state.on);
    }
    const strip = document_.getElementById(STRIP_ID);
    if (strip == null) return;
    const captionNode = strip.querySelector("[data-voice-caption]");
    if (captionNode != null) captionNode.textContent = state.caption;
    const notesNode = strip.querySelector("[data-voice-notes]");
    if (notesNode != null) notesNode.innerHTML = state.notes.map((one) => noteMarkup(one.condition, one.text)).join("");
    const empty = state.caption.length === 0 && state.notes.length === 0;
    strip.hidden = empty;
  }

  async function start() {
    if (state.on) return;
    state.on = true;
    state.byeReason = "";
    clearNotes();
    caption("");
    // The relay owns the orb once the line is up; until `ready` arrives there is no frame to obey,
    // and "thinking" is the honest one of the four for a line that is being dialled.
    orb("thinking");
    state.gate = echoGate({ sampleRate: SAMPLE_RATE });
    state.sound = player({ gate: state.gate });
    try {
      await openSocket();
    } catch {
      // A socket that never opened is the void answer this console has been burned by before: a
      // relay that is down and a workspace that was never set up look identical from here. So the
      // page says the sentence that covers both and offers the card that fixes one of them.
      stop("no-key");
      return;
    }
    try {
      state.capture = await captureAudio({
        source: "microphone",
        sampleRate: SAMPLE_RATE,
        frameBytes: FRAME_BYTES,
        held: () => state.gate.holding(),
        onChunk: (buffer) => {
          if (state.socket != null && state.socket.readyState === 1) state.socket.send(buffer);
        },
      });
    } catch {
      stop("no-microphone");
      return;
    }
    reportHeld();
  }

  // The held count the page actually dropped, sent to the relay so one number can be reconciled
  // against the relay's own. Advisory: the relay drops the same window again on its side.
  let heldTimer = null;
  function reportHeld() {
    if (heldTimer != null) return;
    heldTimer = global.setInterval(() => {
      const stats = state.capture?.stats;
      if (stats == null || state.socket == null || state.socket.readyState !== 1) return;
      if (stats.heldFrames === state.heldReported) return;
      state.heldReported = stats.heldFrames;
      send({ t: "held", frames: stats.heldFrames, ms: Math.round(stats.heldMs) });
    }, 2000);
  }

  function send(message) {
    if (state.socket == null || state.socket.readyState !== 1) return;
    try { state.socket.send(JSON.stringify(message)); } catch { /* the close handler has it */ }
  }

  function stop(condition, text) {
    if (heldTimer != null) { global.clearInterval(heldTimer); heldTimer = null; }
    send({ t: "stop" });
    try { state.capture?.stop(); } catch { /* already stopped */ }
    state.capture = null;
    try { state.sound?.close(); } catch { /* already closed */ }
    state.sound = null;
    const socket = state.socket;
    state.socket = null;
    try { socket?.close(1000, "stopped"); } catch { /* already closed */ }
    state.on = false;
    state.ready = null;
    state.hops = null;
    state.orb = "off";
    caption("");
    const reason = condition || state.byeReason;
    // stop() is also called with no argument at all, for an ordinary press of the button.
    const relaySaidIt = String(condition ?? "").length === 0 && state.byeReason.length > 0;
    state.byeReason = "";
    // The relay's own sentence, already on screen, wins over ours; only the condition is taken from
    // the close, so the row can offer the card when nothing is set up.
    if (reason && retitleNote(reason, relaySaidIt)) return;
    if (reason) note(reason, text, relaySaidIt); else paint();
  }

  function toggle() { return state.on ? stop() : start(); }

  function socketUrl() {
    const location = global.location;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${location.host}/voice/socket`;
  }

  function openSocket() {
    return new Promise((resolve, reject) => {
      const SocketClass = global.__voiceSocketClass ?? global.WebSocket;
      if (SocketClass == null) { reject(new Error("no websocket")); return; }
      const socket = new SocketClass(socketUrl());
      socket.binaryType = "arraybuffer";
      let settled = false;
      socket.addEventListener("open", () => { settled = true; state.socket = socket; resolve(socket); });
      // An error with no close code is indistinguishable from the relay being down. MEASURED: an
      // unknown upgrade path answers zero bytes with no status line and Chrome reports only
      // onerror. So the refusal this page shows is words either way, never silence.
      socket.addEventListener("error", () => { if (!settled) { settled = true; reject(new Error("socket error")); } });
      socket.addEventListener("close", (event) => {
        if (!settled) { settled = true; reject(new Error("socket closed")); return; }
        onClose(event);
      });
      socket.addEventListener("message", (event) => onMessage(event));
    });
  }

  function onClose(event) {
    // MEASURED in real Chrome against a refused upgrade: the socket fires `error` AND THEN `close`
    // with code 1006. Without this guard the close arrives after start() has already said the useful
    // sentence -- "talking is not available yet", with the control that opens the card -- and
    // replaces it with "the line dropped", which leads nowhere. The fake socket in the unit tests
    // fired only `error`, so only a browser could find this. Once the session is off, a trailing
    // close event has nothing left to say.
    if (!state.on) return;
    const code = Number(event?.code ?? 0);
    const reason = String(event?.reason ?? "").trim();
    // A refusal in the private range carries its own sentence. That sentence is what the person
    // reads; the page does not paper over it with a generic failure.
    const named = CLOSE_CONDITIONS[code];
    if (code >= 4000) { stop(named ?? "line-dropped", reason.length > 0 ? reason : undefined); return; }
    if (code === 1000) { stop(); return; }
    // 1006 and friends: the line went away without saying why, which is its own sentence.
    stop(state.byeReason || "line-dropped");
  }

  function onMessage(event) {
    const data = event?.data;
    if (data == null) return;
    if (typeof data !== "string") {
      // Audio to play. Scheduling happens inside the player, which does not block this handler.
      const bytes = data instanceof global.ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data);
      state.sound?.push(bytes);
      return;
    }
    let frame;
    try { frame = JSON.parse(data); } catch { return; }
    if (frame == null || typeof frame !== "object") return;
    switch (frame.t) {
      case "ready":
        state.ready = frame;
        clearNotes();
        orb("listening");
        break;
      case "state":
        orb(frame.value);
        break;
      // REPLACE-WHOLE on purpose. One vendor's transcription event is cumulative with corrections
      // and the other's is incremental; appending a delta writes the sentence N times on the first.
      case "heard":
        caption(String(frame.text ?? ""));
        break;
      case "said":
        caption(String(frame.text ?? ""));
        break;
      case "speak-begin":
        state.gate?.begin();
        break;
      case "speak-end":
        state.gate?.end();
        break;
      // A note is a quiet row and nothing else: it never colours the orb, never opens an expander,
      // and a frame with nothing to say paints no row rather than an empty one.
      case "note":
        if (String(frame.text ?? "").trim().length > 0) note(String(frame.reason ?? "relay"), frame.text, true);
        break;
      // The relay's own latency ledger for the turn just taken. Nothing on screen: it is for the gate
      // and for a support question about why a reply felt slow, and the only number in it the page
      // owns is how long the first sample took to become audible here.
      case "hops":
        state.hops = frame;
        break;
      case "bye":
        state.byeReason = String(frame.reason ?? "");
        break;
      default:
        // An unknown text frame is ignored, never drawn. A future relay may say more than this
        // page understands and that is not something to put in front of a person.
        break;
    }
  }

  // ------------------------------------------------------------------ settings
  async function readSettings() {
    const response = await relayFetch("/voice/settings", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`voice settings unavailable (${response.status})`);
    return response.json();
  }

  async function writeSettings(body) {
    const response = await relayFetch("/voice/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!response.ok) throw new Error((parsed && parsed.error) || `could not save (${response.status})`);
    return parsed;
  }

  function minutes(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0) / 60);
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} min`;
  }

  function paintCard(root, settings) {
    if (root == null || settings == null) return;
    const set = (selector, value) => { const field = root.querySelector(selector); if (field) field.value = value ?? ""; };
    const say = (selector, text) => { const field = root.querySelector(selector); if (field) field.textContent = text; };
    const toggleNode = root.querySelector("[data-voice-enabled]");
    if (toggleNode != null) toggleNode.setAttribute("aria-pressed", settings.enabled ? "true" : "false");
    say("[data-voice-enabled-note]", settings.enabled
      ? "On. The Talk button beside the message box is live."
      : "Off. The Talk button is there but will not open a line.");
    const vendor = root.querySelector("[data-voice-vendor]");
    if (vendor != null) {
      vendor.innerHTML = (settings.vendors ?? []).map((one) =>
        `<option value="${escapeHtml(one.id)}"${one.id === settings.vendor ? " selected" : ""}>${escapeHtml(one.label)}</option>`).join("");
    }
    const agent = root.querySelector("[data-voice-agent]");
    if (agent != null) {
      agent.innerHTML = agentChoices(settings).map((one) =>
        `<option value="${escapeHtml(one.id)}"${one.id === settings.agentId ? " selected" : ""}>${escapeHtml(one.name)}</option>`).join("");
    }
    set("[data-voice-model]", settings.model);
    set("[data-voice-voice]", settings.voice);
    say("[data-voice-key-note]", settings.apiKeySet
      ? "A key is set. Paste a new one to replace it, or clear it."
      : "No key yet. Talking will say so in plain words until one is set.");
    say("[data-voice-usage]", `${minutes(settings.dayUsedSeconds)} of ${minutes(settings.dayCapSeconds)} today · up to ${minutes(settings.sessionCapSeconds)} in one call`);
  }

  function cardValues(root) {
    return {
      enabled: root.querySelector("[data-voice-enabled]")?.getAttribute("aria-pressed") === "true",
      vendor: root.querySelector("[data-voice-vendor]")?.value ?? "",
      model: root.querySelector("[data-voice-model]")?.value.trim() ?? "",
      voice: root.querySelector("[data-voice-voice]")?.value.trim() ?? "",
      agentId: root.querySelector("[data-voice-agent]")?.value ?? "",
    };
  }

  // The roster the relay names, falling back to the console's own. The relay is the authority --
  // it is the side that resolves who Titan is when the line opens -- but a card that cannot offer a
  // name is a card nobody can point at the head of their team with, so the adapter fills in.
  function agentChoices(settings) {
    const named = Array.isArray(settings?.agents) ? settings.agents : [];
    if (named.length > 0) return named;
    const roster = adapter()?.state?.workers ?? adapter()?.workers ?? [];
    return (Array.isArray(roster) ? roster : []).map((one) => ({ id: one.id, name: one.name }));
  }

  // The settings panel repaints whenever app.js fills one of its cards, and the observer below puts
  // this card back each time. So a cached answer is painted rather than refetched: a card that asked
  // the relay on every repaint would be a request loop nobody asked for.
  async function fillCard(options = {}) {
    const document_ = global.document;
    const root = document_?.querySelector(`[${CARD_ATTRIBUTE}]`);
    if (root == null) return;
    if (!options.force && state.settings != null) { paintCard(root, state.settings); return; }
    try {
      state.settings = await readSettings();
      paintCard(root, state.settings);
    } catch {
      const note_ = root.querySelector("[data-voice-key-note]");
      if (note_ != null) note_.textContent = "The relay did not answer about talking. Try again in a moment.";
    }
  }

  function openCard() {
    const document_ = global.document;
    if (document_ == null) return;
    // The road cloud-browser.js takes: find the control a person would press, press it, then put
    // the card back when the panel has painted. Nothing in app.js has to know this file exists.
    const settings = document_.getElementById("shelf-settings");
    if (settings != null) settings.click();
    else ui()?.openPanel?.("Global router & policy", "Operator settings", "");
    global.setTimeout(() => { mountCard(); }, 0);
  }

  function mountCard() {
    const document_ = global.document;
    if (document_ == null) return false;
    if (document_.querySelector(`[${CARD_ATTRIBUTE}]`) != null) return true;
    const list = document_.querySelector("#panel-content .settings-list");
    if (list == null) return false;
    const mail = list.querySelector("[data-mail]");
    if (mail != null) mail.insertAdjacentHTML("afterend", voiceCardMarkup());
    else list.insertAdjacentHTML("beforeend", voiceCardMarkup());
    fillCard();
    return true;
  }

  // ------------------------------------------------------------------ mounting
  function mountStrip() {
    const document_ = global.document;
    if (document_ == null) return;
    if (document_.getElementById(STRIP_ID) != null) return;
    const composer = document_.getElementById("composer");
    if (composer == null) return;
    composer.insertAdjacentHTML("beforebegin", stripMarkup());
    paint();
  }

  function wire() {
    const document_ = global.document;
    if (document_ == null) return;
    document_.addEventListener("click", (event) => {
      const talk = event.target?.closest?.("[data-voice-talk]");
      if (talk != null) { event.preventDefault(); toggle(); return; }
      if (event.target?.closest?.("[data-voice-open-settings]") != null) { event.preventDefault(); openCard(); return; }
      const card = event.target?.closest?.(`[${CARD_ATTRIBUTE}]`);
      if (card == null) return;
      const switchNode = event.target.closest("[data-voice-enabled]");
      if (switchNode != null) {
        const on = switchNode.getAttribute("aria-pressed") === "true";
        switchNode.setAttribute("aria-pressed", on ? "false" : "true");
        return;
      }
      if (event.target.closest("[data-voice-save]") != null) {
        writeSettings(cardValues(card)).then(() => fillCard({ force: true })).catch(() => {});
        return;
      }
      if (event.target.closest("[data-voice-key-set]") != null) {
        const field = card.querySelector("[data-voice-key]");
        const value = field?.value ?? "";
        if (value.trim().length === 0) return;
        if (field != null) field.value = "";
        writeSettings({ ...cardValues(card), apiKey: value }).then(() => fillCard({ force: true })).catch(() => {});
        return;
      }
      if (event.target.closest("[data-voice-key-clear]") != null) {
        writeSettings({ ...cardValues(card), apiKey: "" }).then(() => fillCard({ force: true })).catch(() => {});
      }
    });
    // A tab nobody is looking at has no business holding a microphone open.
    document_.addEventListener("visibilitychange", () => { if (document_.hidden && state.on) stop(); });
    global.addEventListener?.("pagehide", () => { if (state.on) stop(); });
    global.addEventListener?.("beforeunload", () => { if (state.on) stop(); });
  }

  // The console repaints wholesale, which takes the strip with it; one observer puts it back. It is
  // debounced to a frame because a transcript repaint fires many mutations.
  let scheduled = false;
  function observe() {
    const document_ = global.document;
    if (document_?.body == null) return;
    const observer = new global.MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      (global.requestAnimationFrame ?? ((fn) => global.setTimeout(fn, 16)))(() => {
        scheduled = false;
        mountStrip();
        mountCard();
      });
    });
    observer.observe(document_.body, { childList: true, subtree: true });
  }

  // WHY THE BUTTON IS NOT DISABLED WHEN NO KEY IS SET, which B2 reads as if it should be. A
  // disabled control leads nowhere, and "nothing is set up yet" is precisely the case that has to
  // lead somewhere -- the note carries the control that opens the card. So the only thing that
  // disables the button is a relay with no voice door at all (an older one, answering 404): there
  // the press could not produce a sentence, let alone a way forward.
  async function probe() {
    const document_ = global.document;
    const button = document_?.querySelector("[data-voice-talk]");
    if (button == null) return;
    let available = true;
    try {
      const response = await relayFetch("/voice/settings", { headers: { accept: "application/json" } });
      available = response.status !== 404;
      if (response.ok) state.settings = await response.json().catch(() => null);
    } catch {
      // A relay that did not answer at all may answer in a second. Leaving the button live is the
      // choice that lets the person find out in words rather than looking at a dead control.
      available = true;
    }
    state.available = available;
    button.disabled = !available;
    if (!available) button.title = "This workspace is on an older relay that cannot talk yet.";
    else button.removeAttribute("title");
  }

  function boot() {
    mountStrip();
    wire();
    observe();
    probe();
  }

  global.__voice = {
    start,
    stop,
    toggle,
    captureAudio,
    player,
    // The gate reads these from the page, beside the relay's own ledger row, because a held frame
    // is the one claim that needs proving on both sides of the wire.
    stats: () => ({
      on: state.on,
      orb: state.orb,
      sent: state.capture?.stats.sent ?? 0,
      heldFrames: state.capture?.stats.heldFrames ?? 0,
      heldMs: Math.round(state.capture?.stats.heldMs ?? 0),
      playedBytes: state.sound?.stats().bytes ?? 0,
      playedBuffers: state.sound?.stats().buffers ?? 0,
      playerTime: state.sound?.currentTime() ?? 0,
      level: state.sound?.level() ?? 0,
      caption: state.caption,
      notes: state.notes.map((one) => one.condition),
      ready: state.ready,
      hops: state.hops,
    }),
    // Exposed so a test can pin the words and the arithmetic without a browser, which is the
    // contract marketplace-bots.js and cloud-browser.js already keep.
    _state: state,
    _NOTES: NOTES,
    _NOTE_ACTIONS: NOTE_ACTIONS,
    _ORB_STATES: ORB_STATES,
    _ECHO_TAIL_MS: ECHO_TAIL_MS,
    _FRAME_BYTES: FRAME_BYTES,
    _SAMPLE_RATE: SAMPLE_RATE,
    _CLOSE_CONDITIONS: CLOSE_CONDITIONS,
    _sentenceFor: sentenceFor,
    _orbStateFor: orbStateFor,
    _agentChoices: agentChoices,
    _noteMarkup: noteMarkup,
    _stripMarkup: stripMarkup,
    _voiceCardMarkup: voiceCardMarkup,
    _paintCard: paintCard,
    _cardValues: cardValues,
    _echoGate: echoGate,
    _pcm16FromFloat32: pcm16FromFloat32,
    _float32FromPcm16: float32FromPcm16,
    _onMessage: onMessage,
    _onClose: onClose,
    _minutes: minutes,
  };

  if (global.document != null) {
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window === "undefined" ? globalThis : window);
