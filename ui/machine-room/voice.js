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

  // ---------------------------------------------------------------- VOICE-7: the speech panel
  //
  // Jason, 2026-09-10 11:09: "a semi-transparent modal over the current chat window where that is
  // being built out. We see the words being created, and when it's done, that just becomes the next
  // line ... That modal goes away and that becomes the next line from whoever was speaking."
  //
  // It is mounted in <section class="conversation-space">, NOT before the composer the way the strip
  // is. That is the whole of the footer proof and it is architectural rather than fought for: the
  // strip is inserted with insertAdjacentHTML("beforebegin") on #composer, which makes it a grid ITEM
  // of .control-shelf, which is the measured cause of the footer growing (VOICE-6). Nothing this
  // panel does is inside that grid, so the footer's rect cannot move. .conversation-space is
  // position:relative and app.js's renderTranscript only ever rewrites .transcript's innerHTML, so
  // the panel also survives every wholesale repaint without an observer of its own.
  const OVERLAY_ID = "voice-overlay";
  // The fade in styles.css. Read once here so the node is not pulled out from under a transition
  // that is still running; under prefers-reduced-motion it is skipped entirely.
  const DISSOLVE_MS = 200;
  // A turn that never ends. Three of them exist on the wire and each now sends its own final frame
  // (an empty utterance, a yes that closed a card, a transcription that gave up), but a provider
  // that simply stops mid-turn sends nothing at all, and a panel with somebody's half sentence in it
  // sitting over their conversation forever is worse than losing the last few words.
  const HEARD_STALE_MS = 8000;
  // The one word the panel shows before the first word arrives, and on a provider that sends no live
  // transcript at all. Plain, lower-case-able English; never a condition name.
  const LISTENING_WORD = "Listening";

  // ---------------------------------------------------------------- VOICE-7: the two talk modes
  //
  // Jason, same message: "the talk button should be either: press it and it's on, so it's a toggle,
  // on or off; or press and hold to talk and let go. That should be a setting for the user."
  //
  // PUSH IS THE DEFAULT because it is the one that cannot leave a microphone open by accident.
  const TALK_MODES = ["push", "always"];
  const TALK_MODE_DEFAULT = "push";
  // Push to talk keeps the line up between holds so the second hold is instant -- the first one pays
  // the dial, which was measured at 1.6 to 2.0 s through console.titanium.bot. But the caps count
  // WALL CLOCK, not audio, so a line held open after somebody has walked away spends a workspace's
  // day: 30 minutes of a 120 minute allowance for one forgotten press. So it closes itself.
  const PUSH_IDLE_CLOSE_MS = 60_000;
  // Frames captured before the socket finished opening. Push to talk starts capturing on the press
  // and the dial is not instant, so without this the first words of the first hold are lost every
  // time. Bounded at two seconds because the relay drops audio more than three seconds ahead of its
  // own wall clock and counts it as a held frame.
  const PENDING_FRAME_CAP = 20;
  // Where the choice is remembered when the settings surface has no per-person door for it. Written
  // down in docs/VOICE.md rather than left as a surprise: per browser is not per person.
  const TALK_MODE_KEY = "titanbot.voice.talkMode";

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
    // VOICE-7. The SECOND reason a frame is dropped, and it is counted apart from the first on
    // purpose: `held` is the echo gate (the agent is speaking, so the microphone must not hear him)
    // and the gate's own proof reads that number. `muted` is push to talk between holds -- the
    // person simply is not talking. Folding the two together would make the echo gate's count
    // unreadable the moment anybody used push to talk, which is the default.
    const muted = typeof options.muted === "function" ? options.muted : () => false;
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

    const stats = { sent: 0, heldFrames: 0, heldMs: 0, mutedFrames: 0, bytes: 0 };
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
        // Asked before every chunk. A muted frame is never sent either, and it is asked FIRST: in
        // push to talk between two holds the person is not talking at all, and calling that an echo
        // hold would put every silent second on the echo gate's own ledger.
        if (muted()) { stats.mutedFrames += 1; continue; }
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

  // VOICE-7. The panel that floats over the conversation while the person is talking. No title, no
  // icon, no close control, no border that reads as dialog chrome, no condition name anywhere:
  // host-notes-read-as-errors.md is exactly the failure a machine-looking sheet over somebody's
  // chat would reproduce. An orb that is plainly listening, and the words being built. It dissolves
  // rather than closing, and what it leaves behind is the next line of the conversation.
  //
  // aria-live="polite" so the words reach a screen reader as they firm up, and pointer-events are
  // off in CSS so the conversation underneath stays usable while somebody is speaking.
  function overlayMarkup() {
    return `<div class="voice-overlay" id="${OVERLAY_ID}" data-voice-overlay hidden aria-live="polite">`
      + `<div class="voice-overlay-panel" data-voice-overlay-panel>`
      + `<span class="voice-overlay-orb" data-voice-overlay-orb></span>`
      + `<p class="voice-overlay-text" data-voice-overlay-text></p>`
      + `</div></div>`;
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
      // VOICE-7: TALK MODE, and it is the one control on this card that is YOURS rather than the
      // workspace's. Everything else here is written to /voice/settings, which is one file per
      // workspace -- two people sharing one would fight over how their own button behaves. So this
      // row never goes into cardValues() and never reaches that door; it goes through
      // setTalkMode(), and the Save button below cannot touch it.
      + `<div class="field"><label for="voice-talk-mode">Talk mode</label>`
      + `<select id="voice-talk-mode" data-voice-talk-mode>`
      + `<option value="push">Push to talk: hold the button while you speak</option>`
      + `<option value="always">Always listening: press once to start, press again to stop</option>`
      + `</select>`
      + `<small class="field-hint">Holding is the default, and it is the only one that cannot leave a microphone open by accident. On a keyboard you can hold the space bar instead, as long as the message box is empty. This is yours and not the workspace's, and changing it ends the call you are in.</small></div>`
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
    // VOICE-7. What the PERSON is saying, which is a different thing from state.caption -- that one
    // is what the agent is saying back, and until this split both went through one field, so his
    // reply overwrote her sentence. The panel shows only this one.
    heard: { open: false, text: "", turn: 0, phase: "", lands: false, nonce: "" },
    /** The last words the panel showed, KEPT after it has gone, because they are the row that
     *  landed and proving they are the same bytes is the whole promise. */
    lastHeard: "",
    /** The id that row carries, straight off the wire from the relay that sent it. */
    lastNonce: "",
    talkMode: TALK_MODE_DEFAULT,
    /** Push to talk: the button, or the space bar, is down right now. */
    held: false,
    /** Is the microphone open for the person? Always true in always-listening; only while held in
     *  push to talk. The echo gate is a SEPARATE reason and keeps its own count. */
    talking: false,
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
    // VOICE-7: while the agent is speaking there is no panel -- the orb on the button is the only
    // sign, which is what Jason asked for. It is also a belt on the echo gate: the microphone is
    // shut for the whole of his reply, so any words arriving here would be his own coming back
    // through the speakers, and the panel would draw them as the person's.
    if (next === "speaking" && state.heard.open) closeOverlay();
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
      // VOICE-7. AN ORB THAT SAYS LISTENING WHILE THE MICROPHONE IS SHUT IS A LIE, and push to talk
      // creates exactly that: the line stays up between holds so the next one is instant, and the
      // relay goes on saying "listening" because from its side nothing has changed. Between holds the
      // orb is dark. Thinking and speaking still show through, because those happen after a release
      // and they are the truth of that moment.
      const shown = talkMode() === "push" && !state.talking && state.orb === "listening" ? "off" : state.orb;
      if (node != null) node.setAttribute("data-state", shown);
      // Engaged means "the microphone is open for me". In push to talk that is the hold and not the
      // line, which outlives it by a minute.
      const engaged = talkMode() === "push" ? state.held : state.on;
      button.setAttribute("aria-pressed", engaged ? "true" : "false");
      button.classList.toggle("is-live", state.on);
      button.classList.toggle("is-held", state.held);
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

  // ------------------------------------------------------------------ VOICE-7: the panel's states
  //
  // open -> partial* -> final -> gone, and nothing else. Four rules it has to keep and each of them
  // is a measured or documented trap:
  //
  //   1. A PARTIAL REPLACES, never appends. One vendor's transcript is cumulative with its own
  //      corrections and the other's is a delta; the relay's makeCaption already normalises both to
  //      replace-whole, so this side can be simple and stay right on either.
  //   2. A LATE FRAME FROM THE PREVIOUS UTTERANCE IS DROPPED. One vendor does not guarantee that a
  //      completed transcript for one turn arrives before the next turn's words, and says to
  //      reconcile on its item id; the relay stamps every frame with its own utterance counter,
  //      which is that reconciliation, so an older turn can never paint over a newer one.
  //   3. THE FINAL IS THE ONE THE RELAY SENT TO THE AGENT, not the transcription model's last word.
  //      Those are two models and two strings. Dissolving on the settled transcript instead would
  //      leave the panel's last words different from the line it becomes, which is the one thing
  //      Jason asked for.
  //   4. NOTHING OPENS THIS PANEL WHILE THE AGENT IS SPEAKING. The microphone is shut then, so no
  //      words can honestly arrive; if the echo gate ever slipped, the panel would draw the
  //      machine's own sentence as the person's.
  let dissolveTimer = null;
  let staleTimer = null;

  const reducedMotion = () => {
    try { return global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true; }
    catch { return false; }
  };

  function armStale() {
    if (staleTimer != null) global.clearTimeout(staleTimer);
    staleTimer = global.setTimeout(() => { staleTimer = null; closeOverlay(); }, HEARD_STALE_MS);
  }
  function disarmStale() {
    if (staleTimer != null) { global.clearTimeout(staleTimer); staleTimer = null; }
  }

  /** The person started talking. No words yet, which is also the whole of what a provider that sends
   *  no live transcript ever gives us -- so the panel opens here rather than on the first word. */
  function overlayOpen(turn) {
    if (state.orb === "speaking") return;
    if (dissolveTimer != null) { global.clearTimeout(dissolveTimer); dissolveTimer = null; }
    state.heard = { open: true, text: "", turn: Number(turn) || 0, phase: "open", lands: false, nonce: "" };
    armStale();
    paintOverlay();
  }

  /** More of the sentence. Replace, never append. */
  function overlayPartial(text, turn) {
    const at = Number(turn) || 0;
    if (state.heard.open && at < state.heard.turn) return;
    if (!state.heard.open) overlayOpen(at);
    if (!state.heard.open) return;
    state.heard.turn = at;
    state.heard.text = String(text ?? "");
    state.heard.phase = "partial";
    armStale();
    paintOverlay();
  }

  /** The turn is over. These bytes are the row, when there is one. */
  function overlayFinal(text, frame) {
    const at = Number(frame?.turn) || 0;
    if (state.heard.open && at < state.heard.turn) return;
    const words = String(text ?? "");
    disarmStale();
    // Nothing was heard, so there is nothing to read and nothing to leave behind.
    if (words.length === 0) { closeOverlay(); return; }
    state.heard = { open: true, text: words, turn: at, phase: "final", lands: frame?.lands === true, nonce: String(frame?.nonce ?? "") };
    // Kept after the panel has gone, because this is the claim the gate proves: these words and the
    // row in the conversation are the same bytes.
    state.lastHeard = words;
    state.lastNonce = state.heard.nonce;
    paintOverlay();
    dissolve();
  }

  function dissolve() {
    if (dissolveTimer != null) global.clearTimeout(dissolveTimer);
    const document_ = global.document;
    const node = document_?.getElementById(OVERLAY_ID) ?? null;
    // Reduced motion skips the fade the way the orb animations already do: the panel is there, and
    // then it is not, and the row it became is the record either way.
    const wait = node == null || reducedMotion() ? 0 : DISSOLVE_MS;
    if (node != null && wait > 0) node.setAttribute("data-phase", "gone");
    dissolveTimer = global.setTimeout(() => { dissolveTimer = null; closeOverlay(); }, wait);
  }

  /** Gone, now, with no fade: pressing stop, the agent starting to speak, a turn that never ended. */
  function closeOverlay() {
    disarmStale();
    if (dissolveTimer != null) { global.clearTimeout(dissolveTimer); dissolveTimer = null; }
    state.heard = { open: false, text: "", turn: state.heard.turn, phase: "", lands: false, nonce: "" };
    paintOverlay();
  }

  function paintOverlay() {
    const document_ = global.document;
    if (document_ == null) return;
    const node = document_.getElementById(OVERLAY_ID);
    if (node == null) return;
    const words = state.heard.text;
    const text = node.querySelector("[data-voice-overlay-text]");
    if (text != null) {
      text.textContent = words.length > 0 ? words : LISTENING_WORD;
      // One word in the muted colour rather than an empty sheet, which is what a person sees for the
      // length of a turn on a provider that sends no live transcript.
      text.classList.toggle("voice-overlay-waiting", words.length === 0);
    }
    // A LONG UTTERANCE KEEPS ITS NEWEST WORDS ON SCREEN. The panel has a ceiling so it can never
    // cover the whole conversation, and nothing in it can be scrolled by hand -- pointer events are
    // off on purpose, so the chat underneath stays clickable while somebody is talking. So the words
    // being said right now are kept in view from here instead.
    const panel = node.querySelector("[data-voice-overlay-panel]");
    if (panel != null && typeof panel.scrollHeight === "number") panel.scrollTop = panel.scrollHeight;
    if (!state.heard.open) node.removeAttribute("data-phase");
    node.hidden = !state.heard.open;
  }

  async function start(options = {}) {
    if (state.on) return;
    state.on = true;
    state.byeReason = "";
    clearNotes();
    caption("");
    // PUSH TO TALK CAPTURES BEFORE THE LINE IS UP, and only push to talk does.
    //
    // The dial is not free -- 1.6 to 2.0 s through console.titanium.bot -- and in push to talk the
    // person is already talking into a button they are holding down, so a capture that waits for the
    // socket loses the first words of every first hold. The frames are held in a bounded queue and
    // flushed the instant the socket opens.
    //
    // ALWAYS LISTENING KEEPS THE OLD ORDER, socket first, because there the press is a toggle and a
    // line that is refused should never have touched the microphone at all. Holding a button down is
    // a different kind of consent from pressing one.
    const captureFirst = options.captureFirst === true;
    // In always listening the microphone is open for the whole call, and opening a line at all is
    // what asks for that. In push to talk the hold is what asks, and holdStart has already said so.
    if (talkMode() !== "push") state.talking = true;
    // The relay owns the orb once the line is up; until `ready` arrives there is no frame to obey,
    // and "thinking" is the honest one of the four for a line that is being dialled.
    orb("thinking");
    state.gate = echoGate({ sampleRate: SAMPLE_RATE });
    state.sound = player({ gate: state.gate });

    // The queue is bounded at two seconds. The relay drops audio more than three seconds ahead of its
    // own wall clock and counts it as a held frame, so a queue that grew without a ceiling would
    // arrive as a burst the relay throws away -- which looks exactly like a microphone that is not
    // working.
    let pending = [];
    const sendFrame = (buffer) => {
      const socket = state.socket;
      if (socket != null && socket.readyState === 1) {
        if (pending.length > 0) { const queued = pending; pending = []; for (const one of queued) { try { socket.send(one); } catch { /* the close handler has it */ } } }
        try { socket.send(buffer); } catch { /* the close handler has it */ }
        return;
      }
      if (!captureFirst) return;
      pending.push(buffer);
      while (pending.length > PENDING_FRAME_CAP) pending.shift();
    };
    const beginCapture = () => captureAudio({
      source: "microphone",
      sampleRate: SAMPLE_RATE,
      frameBytes: FRAME_BYTES,
      held: () => state.gate.holding(),
      // Push to talk between holds. In always listening nothing is ever muted this way, and the echo
      // gate above is the only thing that drops a frame.
      muted: () => !state.talking,
      onChunk: sendFrame,
    });

    if (captureFirst) {
      try { state.capture = await beginCapture(); }
      catch { stop("no-microphone"); return; }
    }
    try {
      await openSocket();
    } catch {
      // A socket that never opened is the void answer this console has been burned by before: a
      // relay that is down and a workspace that was never set up look identical from here. So the
      // page says the sentence that covers both and offers the card that fixes one of them.
      stop("no-key");
      return;
    }
    // WHATEVER WAS CAPTURED WHILE THE LINE WAS STILL OPENING GOES NOW, in order, and whether or not
    // the button is still down. Flushing it only on the next frame that is allowed through would
    // lose a hold SHORTER than the dial entirely: every frame after the release is muted, so the
    // queue would sit there full of the only words that were ever said and never be sent.
    if (pending.length > 0) {
      const queued = pending;
      pending = [];
      for (const one of queued) { try { state.socket?.send(one); } catch { /* the close handler has it */ } }
    }
    if (!captureFirst) {
      try { state.capture = await beginCapture(); }
      catch { stop("no-microphone"); return; }
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
    // VOICE-7. The line is down, so the microphone is not open for anybody, the button is not held,
    // nothing is waiting to close itself, and a panel left on screen would be words over a
    // conversation that nothing will ever finish.
    state.held = false;
    state.talking = false;
    clearIdleClose();
    closeOverlay();
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

  function toggle() {
    if (state.on) return stop();
    // Always listening: the line is open from the press to the next press, and the provider's own
    // turn detection decides where one utterance ends and the next begins. The microphone is open the
    // whole time, which is what the name says, and the echo gate still shuts it while the agent
    // speaks.
    state.talking = true;
    return start();
  }

  // ------------------------------------------------------------------ VOICE-7: the two talk modes
  //
  // ONE PAIR OF ENTRY POINTS, talkDown and talkUp, and everything reaches the microphone through
  // them: the button with a mouse, the button with a thumb, the space bar, and the desktop app's
  // global hotkey when that wave lands. A hotkey that had its own copy of this would be a third
  // behaviour to keep in step with a setting.
  function talkMode() { return TALK_MODES.includes(state.talkMode) ? state.talkMode : TALK_MODE_DEFAULT; }

  function talkDown() {
    if (talkMode() === "always") { toggle(); return undefined; }
    return holdStart();
  }
  function talkUp() {
    if (talkMode() === "always") return undefined;
    return holdEnd();
  }

  // Push to talk. The first hold opens the line; later holds are instant because it is still up.
  async function holdStart() {
    if (state.held) return;
    state.held = true;
    state.talking = true;
    clearIdleClose();
    paint();
    if (state.on) return;
    await start({ captureFirst: true });
  }

  function holdEnd() {
    if (!state.held) return;
    state.held = false;
    // The microphone closes on the release. The TURN then ends the way it ends in the other mode:
    // the provider's own turn detection notices the silence. We do not send the provider's manual
    // commit, because that needs turn detection switched off in the session frame, and this bridge
    // writes that frame exactly once and byte-identically for the life of the socket -- rewriting it
    // re-bills the whole conversation on one of the two services. docs/VOICE.md section 3 says so.
    state.talking = false;
    paint();
    armIdleClose();
  }

  // A line nobody has held for a minute closes itself. The caps count WALL CLOCK, so a forgotten
  // press in push to talk would otherwise spend thirty minutes of a hundred and twenty minute day
  // with nobody in the room. Always listening has no such timer: there the line being up IS what the
  // person asked for, and the way out is the button or Escape.
  let idleTimer = null;
  function clearIdleClose() {
    if (idleTimer != null) { global.clearTimeout(idleTimer); idleTimer = null; }
  }
  function armIdleClose() {
    clearIdleClose();
    if (talkMode() !== "push") return;
    idleTimer = global.setTimeout(() => {
      idleTimer = null;
      if (state.on && !state.held) stop();
    }, PUSH_IDLE_CLOSE_MS);
  }

  // ------------------------------------------------------------- VOICE-7: where the choice lives
  //
  // THIS BROWSER, AND TODAY THAT IS THE WHOLE OF IT. Not /voice/settings: that is one file per
  // WORKSPACE, and two people sharing one would fight over how their own button behaves. The only
  // per-person door on this product today is the one Notifications uses, and a talk mode belongs on
  // the settings surface being rebuilt beside this wave -- when that surface has a place for a
  // person's own preferences, the row moves there and this stays as the copy the FIRST PRESS reads,
  // because the button is live the moment the console paints and before any route has answered. The
  // row reconciles the two by calling setTalkMode() with whatever its own door said.
  // docs/VOICE.md 13 says all of that in the words a person would read.
  const talkModeOf = (value) => (TALK_MODES.includes(String(value)) ? String(value) : TALK_MODE_DEFAULT);

  function readStoredTalkMode() {
    try { return talkModeOf(global.localStorage?.getItem(TALK_MODE_KEY)); }
    catch { return TALK_MODE_DEFAULT; }
  }
  function writeStoredTalkMode(mode) {
    try { global.localStorage?.setItem(TALK_MODE_KEY, talkModeOf(mode)); }
    catch { /* a private window, and the default is the right answer there */ }
  }

  /**
   * The one door the settings row calls, and the only way this value is ever set.
   *
   * CHANGING THE MODE ENDS THE CALL YOU ARE IN. The alternative is a line that is up while the
   * control that opened it has changed meaning underneath the person -- a microphone whose state
   * nobody on screen can account for.
   */
  function setTalkMode(mode) {
    const next = talkModeOf(mode);
    const changed = next !== state.talkMode;
    state.talkMode = next;
    writeStoredTalkMode(next);
    if (changed && state.on) { stop(); return next; }
    paint();
    return next;
  }

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
      // WHAT THE PERSON SAID, which since VOICE-7 goes to the panel over the conversation and not to
      // the strip beside the composer. REPLACE-WHOLE on purpose: one vendor's transcription event is
      // cumulative with corrections and the other's is incremental, and the relay normalises both
      // before they get here.
      //
      // The `phase` field is what makes a panel possible at all. The same frame name used to carry
      // three different things -- a partial, the settled transcript, and the string the relay
      // actually handed to the agent -- with nothing to tell them apart, so nothing could know when
      // to dissolve. A frame with no phase on it is an older relay: it is drawn as a partial, which
      // degrades to the old behaviour of showing the words and leaving them there.
      case "heard":
        if (frame.phase === "open") overlayOpen(frame.turn);
        else if (frame.phase === "final") overlayFinal(String(frame.text ?? ""), frame);
        else overlayPartial(String(frame.text ?? ""), frame.turn);
        break;
      // WHAT THE AGENT SAID BACK, which is the strip's own line and never the panel's. Until VOICE-7
      // both went through one field, so his reply painted over her sentence mid-turn.
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
    // VOICE-7: painted from this page's own choice, not from the relay's answer. The settings file the
    // rest of this card reads is per workspace and this one is per person.
    set("[data-voice-talk-mode]", talkMode());
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

  // VOICE-7. Into .conversation-space, and DELIBERATELY NOT the road mountStrip takes above: an
  // element inserted before #composer becomes a grid item of .control-shelf and adds a whole row to
  // the footer, which is the measured cause of VOICE-6. The conversation space is position:relative
  // and app.js only ever rewrites .transcript's innerHTML inside it, so this node is over the chat,
  // is never rebuilt, and cannot reach the footer at all.
  function mountOverlay() {
    const document_ = global.document;
    if (document_ == null) return;
    if (document_.getElementById(OVERLAY_ID) != null) return;
    const space = document_.querySelector(".conversation-space");
    if (space == null) return;
    space.insertAdjacentHTML("beforeend", overlayMarkup());
    paintOverlay();
  }

  // ------------------------------------------------------- VOICE-7: what may hold the space bar
  //
  // FIVE OTHER KEYDOWN PATHS live on this document -- the transcript's own space handler for evidence
  // rows, Escape closing a drawer, the desktop chord, the composer's Enter, and the command palette --
  // and the box's screen takes keystrokes outright, because it is an iframe and everything typed into
  // it is meant for the machine on the other side. A space bar that opened a microphone through any
  // of those reads as a broken console.
  function spaceMayTalk() {
    const document_ = global.document;
    if (document_ == null) return false;
    const active = document_.activeElement;
    const tag = String(active?.tagName ?? "").toUpperCase();
    if (active?.isContentEditable === true) return false;
    if (/^(INPUT|TEXTAREA|SELECT|IFRAME)$/.test(tag)) return false;
    // A focused control takes its own space bar, which is how a keyboard works. The exception is this
    // one control, where the space bar IS the hold.
    if (/^(BUTTON|A|SUMMARY)$/.test(tag)) return active?.closest?.("[data-voice-talk]") != null;
    // And a control that is only a control by its role, which is what the transcript's own focusable
    // rows are: an agent-to-agent blurb carries role="button" and tabindex="0" so a keyboard can open
    // it, and app.js's transcript handler opens it on the space bar. Taking that key to open a
    // microphone instead would be this module reaching into somebody else's control.
    if (active?.getAttribute?.("role") === "button") return active?.closest?.("[data-voice-talk]") != null;
    if (active?.closest?.("[data-evidence],[data-exchange]") != null) return false;
    if (document_.querySelector("dialog[open]") != null) return false;
    if (document_.body?.dataset?.drawer) return false;
    // And only with the message box empty. A half-typed message and a microphone opening on the same
    // key is two things happening at once, and only one of them was asked for.
    const box = document_.getElementById("message-input");
    if (box != null && String(box.value ?? "").trim().length > 0) return false;
    return true;
  }

  // Escape stops the line, in either mode. It is the way out of always listening that needs no
  // pointer, and it must not take an Escape that belongs to somebody else: app.js closes an open
  // drawer with it and a dialog closes itself.
  function escapeStops() {
    const document_ = global.document;
    if (document_ == null || !state.on) return false;
    if (document_.querySelector("dialog[open]") != null) return false;
    if (document_.body?.dataset?.drawer) return false;
    stop();
    return true;
  }

  function wire() {
    const document_ = global.document;
    if (document_ == null) return;
    // VOICE-7. A CLICK IS THE ALWAYS-LISTENING PRESS AND NOTHING ELSE. In push to talk the hold has
    // already been handled by pointerdown and pointerup, and the click that follows them must not
    // toggle a second time on top of it.
    document_.addEventListener("click", (event) => {
      const talk = event.target?.closest?.("[data-voice-talk]");
      if (talk != null) { event.preventDefault(); if (talkMode() !== "push") toggle(); return; }
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
    // ---------------------------------------------------------- VOICE-7: press and hold
    //
    // The RELEASE listens on the document rather than on the button, because a thumb that slides off
    // a 38 px circle before it lifts would otherwise never end the turn and would leave a microphone
    // open with the button drawn as though it were not.
    const release = () => { if (state.held) void talkUp(); };
    const isTalk = (event) => {
      const talk = event.target?.closest?.("[data-voice-talk]");
      return talk != null && talk.disabled !== true ? talk : null;
    };

    document_.addEventListener("pointerdown", (event) => {
      if (talkMode() !== "push" || isTalk(event) == null) return;
      // No text selection, no drag, no focus ring flicker: a hold is a hold.
      event.preventDefault();
      void talkDown();
    });
    document_.addEventListener("pointerup", release);
    document_.addEventListener("pointercancel", release);
    // Touch as well as pointer. Both fire on a phone and both are guarded against a second start, and
    // the preventDefault here is the one that stops a long press from becoming the selection callout.
    document_.addEventListener("touchstart", (event) => {
      if (talkMode() !== "push" || isTalk(event) == null) return;
      event.preventDefault();
      void talkDown();
    }, { passive: false });
    document_.addEventListener("touchend", release);
    document_.addEventListener("touchcancel", release);
    document_.addEventListener("contextmenu", (event) => {
      if (talkMode() === "push" && isTalk(event) != null) event.preventDefault();
    });

    document_.addEventListener("keydown", (event) => {
      // SOMEBODY NEARER THE KEY ALREADY CLAIMED IT. This listener is on the document, so it runs after
      // every handler between here and the thing that was focused -- the transcript's own space
      // handler for its focusable rows, the composer's Enter, the palette. A key one of those has
      // already acted on is not also a microphone.
      if (event.defaultPrevented) return;
      if (event.key === "Escape") { escapeStops(); return; }
      if (event.key !== " " && event.code !== "Space") return;
      // THE LATCH. A held key repeats, and without this the handler would fire tens of times a second
      // for as long as somebody spoke.
      if (event.repeat || state.held) return;
      if (talkMode() !== "push" || !spaceMayTalk()) return;
      event.preventDefault();
      void talkDown();
    });
    document_.addEventListener("keyup", (event) => {
      if (event.key !== " " && event.code !== "Space") return;
      release();
    });

    // VOICE-7: the talk mode row. A <select> answers `change` and not `click`, and it is the one
    // control on that card that never reaches /voice/settings -- that file is per workspace and this
    // choice is per person, so it goes through setTalkMode() and the card's Save cannot touch it.
    document_.addEventListener("change", (event) => {
      const field = event.target?.closest?.("[data-voice-talk-mode]");
      if (field == null) return;
      setTalkMode(field.value);
      // Painted back from the module rather than left as typed, so a value it refused shows what it
      // really is rather than what was asked for.
      field.value = talkMode();
    });

    // A tab nobody is looking at has no business holding a microphone open.
    document_.addEventListener("visibilitychange", () => { if (document_.hidden && state.on) stop(); });
    // A window that loses focus never delivers the keyup for a space bar that is still down, and a
    // pointer released outside the window never delivers its up either. Both leave a microphone open.
    global.addEventListener?.("blur", release);
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
        mountOverlay();
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
    // Before anything is mounted: the button is live the moment the console paints, and it has to
    // know which of the two things it is before the first press.
    state.talkMode = readStoredTalkMode();
    mountStrip();
    mountOverlay();
    wire();
    observe();
    probe();
  }

  global.__voice = {
    start,
    stop,
    toggle,
    // VOICE-7. The ONE pair of entry points into the microphone. The button with a mouse, the button
    // with a thumb, the space bar and (when that wave lands) the desktop app's global hotkey all
    // arrive here, so the hotkey inherits whichever mode is set rather than carrying a third copy of
    // this behaviour.
    talkDown,
    talkUp,
    setTalkMode,
    getTalkMode: talkMode,
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
      // Push to talk between holds, counted apart from the echo gate's own drops above.
      mutedFrames: state.capture?.stats.mutedFrames ?? 0,
      playedBytes: state.sound?.stats().bytes ?? 0,
      playedBuffers: state.sound?.stats().buffers ?? 0,
      playerTime: state.sound?.currentTime() ?? 0,
      level: state.sound?.level() ?? 0,
      caption: state.caption,
      notes: state.notes.map((one) => one.condition),
      ready: state.ready,
      hops: state.hops,
      // VOICE-7, and what the gate compares against the row in the conversation. `lastHeard` is kept
      // AFTER the panel has gone, because "the panel's last words became that line" is a claim about
      // bytes and the node it was drawn in no longer exists by the time the row lands.
      talkMode: talkMode(),
      held: state.held,
      talking: state.talking,
      overlay: { open: state.heard.open, text: state.heard.text, phase: state.heard.phase, turn: state.heard.turn },
      lastHeard: state.lastHeard,
      lastNonce: state.lastNonce,
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
    _overlayMarkup: overlayMarkup,
    _TALK_MODES: TALK_MODES,
    _TALK_MODE_DEFAULT: TALK_MODE_DEFAULT,
    _TALK_MODE_KEY: TALK_MODE_KEY,
    _OVERLAY_ID: OVERLAY_ID,
    _LISTENING_WORD: LISTENING_WORD,
    _HEARD_STALE_MS: HEARD_STALE_MS,
    _PUSH_IDLE_CLOSE_MS: PUSH_IDLE_CLOSE_MS,
    _PENDING_FRAME_CAP: PENDING_FRAME_CAP,
    _spaceMayTalk: spaceMayTalk,
    _escapeStops: escapeStops,
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
