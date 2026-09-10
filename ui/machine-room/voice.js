/*
 * VOICE-1 / VOICE-2 — the console's side of talking to your agent.
 * ----------------------------------------------------------------
 * One button beside the composer, one orb, a microphone, a speaker, and ONE capped line of live
 * words. Press to start; press again, or Escape, to leave. There is no wake word and nothing listens
 * when the button is off.
 *
 * VOICE-2, AND WHAT IT CHANGED. Talk mode used to be a room you could not leave. The live strip was
 * an unplaced child of the footer's grid, so one press moved six rects and took 45.5 px off the
 * conversation; a second press redialled instead of leaving, because it read a flag the relay had
 * already cleared; Escape did nothing; and no code path anywhere cleared a note, so the sentence sat
 * in the footer until the tab was reloaded. The Voice card went with it: a key belongs to the
 * operator and lives in the admin console, so this file publishes the four facts item A's Settings
 * rows read and holds no paste field of its own. The numbers are in the comments beside each fix.
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
 * On speakers that was never a feature: the thing being interrupted was the person. docs/VOICE.md
 * says so in one sentence, and so does the Settings row that switches talking on.
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
    //
    // VOICE-2. The shipped sentence ended "Add one on the Voice card in Settings and press the button
    // again", and the last clause INSTRUCTED THE LOOP Jason got stuck in: the press that reads this
    // line cannot succeed, so "press the button again" is the one thing a person must not be told to
    // do. The words are his own, and the relay says the same string, so retitleNote cannot put two
    // wordings on one row.
    "no-key": "Voice is not switched on for this workspace yet.",
    "day-cap": "This workspace has used all of today's talking time. It starts again at midnight UTC.",
    "session-cap": "That call reached its length limit. Press Talk to start another one.",
    "box-not-running": "Your agent's computer is not running, so there is nobody to talk to yet. Start it and press Talk again.",
    "line-dropped": "The line dropped. Press Talk to start again.",
  };
  // The one note that leads somewhere. There is no Voice card any more -- a key is the operator's and
  // lives in the admin console -- so this opens the workspace's own settings at the Talking row.
  // These words are the control's TITLE and not its label: the sentence itself is what a person
  // presses, because measured at 1440x900 a labelled button beside the sentence does not fit the
  // composer's row without taking the message box under 150 px.
  const NOTE_ACTIONS = { "no-key": "Open settings" };
  // A refusal the relay makes mid-call closes with a code, because by then there is no longer a
  // socket to send a frame down. The code names the condition so the right sentence -- and, for a
  // missing key, the right control -- can still be put in front of the person.
  const CLOSE_CONDITIONS = { 4001: "no-key", 4002: "day-cap", 4003: "session-cap", 4004: "box-not-running" };

  // THE LIVE LINE. One node, two homes, and it clears itself.
  //
  // WHY IT IS NOT A STRIP ANY MORE, and this is the whole of VOICE-2. The strip was inserted
  // `beforebegin` #composer, which made it a FOURTH auto-placed child of .control-shelf's
  // three-column grid with no grid-column of its own -- the third time that bug has been found in
  // this file (.composer-status and .attachment-tray each carry a written comment about it).
  // MEASURED on grok-bot-local-vm in real Chrome at 1440x900, one press of Talk on a workspace with
  // no voice: the shelf went 1392x106@24,776 to 1392x196.02@24,685.98, the composer 600x54@459 to
  // 407.98x54@991, the message box 370.05 to 178.03, .shelf-utilities wrapped to row two at x41,
  // .composer-aside rose 90 px onto the right rail's Skills row and the transcript lost 45.5 px. A
  // person could not read the sentence, leave the mode, or type.
  //
  // `grid-column: 1 / -1` where the strip sat is WORSE than shipped, not better: measured
  // 1392x208.55, three rows, the composer in column one, because the strip is mounted AFTER
  // #workspace-list and a full-width row there pushes everything onto a third. The two children that
  // DO span the shelf are its first two, which is why the phone home below is `afterbegin`.
  const LINE_ID = "voice-line";
  // The width at or below which the line takes a row of the shelf instead of a slot in the composer.
  // The phone composer is 358 px with a 178.98 px message box: there is no room in it for a sentence.
  const LINE_SHELF_WIDTH = 900;
  // How long a note stays before it takes itself away. Nothing used to clear one -- clearNotes ran
  // only from start() and the ready frame -- so the sentence sat in the footer for the life of the
  // tab and the only way out was a reload.
  const NOTE_DISMISS_MS = 6000;

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

    // deviceId is added ONLY when Settings holds one, so a workspace that never opened the row asks
    // for exactly what it always asked for and `exact` can never refuse a microphone nobody chose.
    const deviceId = String(options.deviceId ?? "").trim();
    const stream = source === "microphone"
      ? await getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
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

  // ------------------------------------------------------------------ the line a person reads
  //
  // The transcript is rebuilt wholesale on every render (app.js's renderAll), so nothing this file
  // draws can live inside it. The durable record of a spoken turn is the transcript row itself,
  // which carries the spoken chip because the relay sends the prompt under a "voice:" nonce. This
  // line is the LIVE half, and it is ONE capped line: what is being heard or said, or one note.
  //
  // TWO CHILDREN, EXACTLY ONE SHOWN. A sentence that leads somewhere IS the control -- the button
  // carries the sentence and NOTE_ACTIONS' words are its accessible name -- because a labelled
  // button beside the sentence does not fit the composer's row (see NOTE_ACTIONS above). A sentence
  // that leads nowhere is a span, because a status that cannot be pressed must not look pressable.
  function lineMarkup() {
    return `<span class="voice-line" id="${LINE_ID}" data-voice-line hidden>`
      + `<span class="voice-line-say" data-voice-line-say hidden></span>`
      + `<button class="voice-line-do" type="button" data-voice-line-do data-voice-open-settings hidden></button>`
      + `</span>`;
  }

  // What the line says and whether it leads anywhere, with no DOM in sight, so a test can pin the
  // words and item A can read the same two facts.
  function lineFor(notes, caption) {
    const first = Array.isArray(notes) ? notes[0] : null;
    if (first == null) return { text: String(caption ?? ""), action: null };
    const text = first.text != null && String(first.text).trim().length > 0
      ? String(first.text).trim()
      : sentenceFor(first.condition);
    return { text, action: NOTE_ACTIONS[first.condition] ?? null };
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
    /** The microphone the person picked in Settings, or "" for whichever the browser hands over. */
    micDeviceId: "",
    /** The relay's hop ledger for the last turn, when it sent one. Never drawn. */
    hops: null,
  };

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
    clearDismiss();
    state.notes = [];
    paint();
  }

  // ------------------------------------------------------------------ the note takes itself away
  //
  // Nothing ever cleared one. clearNotes ran from start() and from the ready frame and nowhere else,
  // so the sentence sat in the footer for the life of the tab: Jason's screenshot is a footer with a
  // note in it and no way out. The timer is the module's own global.setTimeout so the unit tests can
  // drive it, and it is unref'd where that exists because stop() is called six times in a row by
  // tests/machine-room-voice.test.mjs and a pending timer keeps a node test process alive. It also
  // fires from visibilitychange, pagehide and beforeunload, where a timer must not outlive the page.
  let dismissTimer = null;
  function clearDismiss() {
    if (dismissTimer == null) return;
    try { global.clearTimeout(dismissTimer); } catch { /* a fake window may not have one */ }
    dismissTimer = null;
  }

  function armDismiss() {
    clearDismiss();
    dismissTimer = global.setTimeout(() => { dismissTimer = null; state.notes = []; paint(); }, NOTE_DISMISS_MS);
    dismissTimer?.unref?.();
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
    const line = mountLine();
    if (line == null) return;
    const { text, action } = lineFor(state.notes, state.caption);
    const say = line.querySelector("[data-voice-line-say]");
    const does = line.querySelector("[data-voice-line-do]");
    const shown = action == null ? say : does;
    const other = action == null ? does : say;
    // EVERY WRITE IS GUARDED ON A CHANGE. The body-wide observer below watches childList, and
    // textContent replaces child nodes: an unguarded write repaints on its own mutation forever.
    if (shown != null && shown.textContent !== text) shown.textContent = text;
    if (other != null && other.textContent !== "") other.textContent = "";
    if (say != null) say.hidden = action != null || text.length === 0;
    if (does != null) {
      does.hidden = action == null;
      // NO aria-label HERE, on purpose. An aria-label REPLACES a button's own text for a screen
      // reader, so labelling this "Open settings" would read the control out and swallow the sentence
      // that is the whole reason it is on screen. The sentence is the accessible NAME; the action's
      // words are the title, which is the accessible DESCRIPTION beside it.
      if (action != null) does.setAttribute("title", action);
    }
    if (say != null) {
      if (text.length > 0) say.setAttribute("title", text); else say.removeAttribute("title");
    }
    line.hidden = text.length === 0;
    // THE FIFTH TRACK COSTS NOTHING AT REST. An unconditional empty track was measured to take 4 px
    // off the message box through the composer's own 4 px gap, so the attribute the track hangs on
    // is written only while the line is really in the form with something to say.
    const form = document_.getElementById("composer");
    if (form != null) {
      if (!line.hidden && line.parentElement === form) form.setAttribute("data-voice-line", "up");
      else form.removeAttribute("data-voice-line");
    }
  }

  // ------------------------------------------------------------------ where the line lives
  //
  // Two homes and no third. In the composer's own row the shelf does not move at all, which is the
  // whole point: at 1440x900 the shipped strip moved six rects and cost the transcript 45.5 px. On a
  // phone the composer is 358 px wide with a 178.98 px message box and there is no room in it for a
  // sentence, so the line takes the shelf's FIRST row, full width, beside .composer-status and
  // .attachment-tray -- the only two children of that grid already placed that way, and the only
  // placement measured not to open a row nobody asked for.
  //
  // It never replaces a node app.js owns: it inserts its own and moves its own.
  function mountLine() {
    const document_ = global.document;
    if (document_ == null) return null;
    const form = document_.getElementById("composer");
    const shelf = document_.querySelector(".control-shelf");
    const width = Number(global.innerWidth ?? 0);
    const inShelf = shelf != null && width > 0 && width <= LINE_SHELF_WIDTH;
    const host = inShelf ? shelf : form;
    if (host == null) return null;
    let line = document_.getElementById(LINE_ID);
    if (line == null) {
      const talk = inShelf ? null : form?.querySelector("[data-voice-talk]");
      if (talk != null) talk.insertAdjacentHTML("beforebegin", lineMarkup());
      else host.insertAdjacentHTML(inShelf ? "afterbegin" : "beforeend", lineMarkup());
      line = document_.getElementById(LINE_ID);
      if (line == null) return null;
    } else if (line.parentElement !== host) {
      const talk = inShelf ? null : form?.querySelector("[data-voice-talk]");
      try { host.insertBefore(line, inShelf ? host.firstChild : (talk ?? null)); }
      catch { /* a host that will not take it keeps the line where it already is */ }
    }
    line.classList.toggle("is-shelf", inShelf);
    return line;
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
        deviceId: state.micDeviceId,
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
    clearDismiss();
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
    if (reason && retitleNote(reason, relaySaidIt)) { armDismiss(); return; }
    if (reason) { note(reason, text, relaySaidIt); armDismiss(); return; }
    // Nothing new to say. An ordinary stop leaves nothing standing either, or a note the relay sent
    // mid-call outlives the call it was about: the button was pressed to leave, so leaving is what it
    // does. A stop that DOES carry a reason is the two lines above, and that sentence is the whole
    // point of the press.
    if (state.notes.length > 0) { clearNotes(); return; }
    paint();
  }

  // PRESSING IT AGAIN LEAVES. It used to read state.on, which the relay had already set false by the
  // time a person pressed a second time, so the second press called start() and redialled into the
  // same refusal -- and the sentence the page showed told them to do exactly that. Measured, the
  // geometry after a second press was byte-identical to the break. A note on screen IS the mode.
  function toggle() {
    if (state.on) return stop();
    if (state.notes.length > 0) { clearNotes(); return undefined; }
    return start();
  }

  // Escape leaves too, and it is guarded twice. app.js:6802 already owns a document-level Escape for
  // the drawer, and this console has native <dialog>s -- the settings panel, onboarding, the report
  // card -- that close on Escape; stealing it from one of those would read as a broken modal.
  function onKeyDown(event) {
    if (event?.key !== "Escape") return;
    if (!state.on && state.notes.length === 0) return;
    const document_ = global.document;
    if (document_?.querySelector?.("dialog[open]") != null) return;
    // stop() clears a standing note when it has nothing new to say, so both branches really leave.
    if (state.on) stop(); else clearNotes();
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

  // ------------------------------------------------------------------ what item A's rows read
  //
  // THE SEAM. There is no Voice card any more: a key belongs to the operator and lives in the admin
  // console, and a customer's own choices are rows in Settings. Those rows read these four things and
  // nothing else, so this file stays the only one that knows the relay's voice door.
  //
  // `available` is "a key exists for this workspace's service, wherever it came from" -- the control
  // plane's, or the relay's own file. An older relay answers only apiKeySet, which means the same
  // thing there, so the fallback keeps a workspace on the old answer working.
  async function getSettings() {
    try {
      state.settings = await readSettings();
    } catch {
      return { enabled: false, available: false };
    }
    const value = state.settings ?? {};
    return {
      enabled: value.enabled === true,
      available: value.available === true || (value.available == null && value.apiKeySet === true),
    };
  }

  async function setEnabled(on) {
    const saved = await writeSettings({ enabled: on === true });
    if (saved != null) state.settings = saved;
    return getSettings();
  }

  // A picker is drawn only when the browser can name the microphones. enumerateDevices exists on
  // every browser this console supports and answers empty labels until permission is given, which is
  // a list worth showing; a browser without it gets no row rather than a control that decides nothing.
  const supportsMicChoice = () => typeof global.navigator?.mediaDevices?.enumerateDevices === "function";
  const getMicDeviceId = () => state.micDeviceId;
  const setMicDeviceId = (id) => { state.micDeviceId = String(id ?? "").trim(); return state.micDeviceId; };

  function minutes(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0) / 60);
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} min`;
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

  // How the workspace's talking minutes read, in the words the Usage rows use. Item A draws them;
  // this file owns the numbers because it owns the door they come from.
  function usage() {
    const value = state.settings ?? {};
    return {
      dayUsedSeconds: Number(value.dayUsedSeconds) || 0,
      dayCapSeconds: Number(value.dayCapSeconds) || 0,
      sessionCapSeconds: Number(value.sessionCapSeconds) || 0,
    };
  }

  // ------------------------------------------------------------------ the way out of the note
  //
  // The line that says talking is not switched on IS the control that opens the row where it is.
  // window.__mrSettings is item A's; when it is not there yet, or throws, the gear a person would
  // press themselves is pressed instead, so this never leads nowhere.
  function openSettings() {
    const document_ = global.document;
    const surface = global.__mrSettings;
    if (surface != null && typeof surface.open === "function") {
      try { surface.open("general", "voice"); return; } catch { /* the gear below is the fallback */ }
    }
    if (document_ == null) return;
    const gear = document_.getElementById("settings-button") ?? document_.getElementById("shelf-settings");
    gear?.click?.();
  }

  function wire() {
    const document_ = global.document;
    if (document_ == null) return;
    document_.addEventListener("click", (event) => {
      const talk = event.target?.closest?.("[data-voice-talk]");
      if (talk != null) { event.preventDefault(); toggle(); return; }
      if (event.target?.closest?.("[data-voice-open-settings]") != null) { event.preventDefault(); openSettings(); }
    });
    document_.addEventListener("keydown", onKeyDown);
    // A tab nobody is looking at has no business holding a microphone open.
    document_.addEventListener("visibilitychange", () => { if (document_.hidden && state.on) stop(); });
    global.addEventListener?.("pagehide", () => { if (state.on) stop(); });
    global.addEventListener?.("beforeunload", () => { if (state.on) stop(); });
    // The line has two homes and the window's width picks one. Without this, a window dragged narrow
    // keeps a sentence inside a composer that no longer has room for it. Debounced to a frame, the
    // way the repaint observer below is, because a drag fires this continuously.
    let resizing = false;
    global.addEventListener?.("resize", () => {
      if (resizing) return;
      resizing = true;
      (global.requestAnimationFrame ?? ((fn) => global.setTimeout(fn, 16)))(() => { resizing = false; paint(); });
    });
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
        // paint() mounts the line and then fills it, and every write it makes is guarded on a
        // change, so putting it here cannot chase its own mutation round the loop.
        paint();
      });
    });
    observer.observe(document_.body, { childList: true, subtree: true });
  }

  // WHY THE BUTTON IS NOT DISABLED WHEN NO KEY IS SET, which B2 reads as if it should be. A
  // disabled control leads nowhere, and "nothing is set up yet" is precisely the case that has to
  // lead somewhere -- the sentence itself opens the row that fixes it. So the only thing that
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
    paint();
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
    // THE SEAM ITEM A DRAWS ITS ROWS FROM. General/System has two of them -- "Let me talk to Titan"
    // and "Microphone" -- and neither is drawn at all when this module is absent. readSettings and
    // saveSettings are here because the operator's own rows (which bot, which service, which voice)
    // moved out of this file with the card, and the relay's door should still have exactly one
    // caller in the console.
    getSettings,
    setEnabled,
    supportsMicChoice,
    getMicDeviceId,
    setMicDeviceId,
    usage,
    minutes,
    readSettings,
    saveSettings: writeSettings,
    agentChoices,
    openSettings,
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
    _NOTE_DISMISS_MS: NOTE_DISMISS_MS,
    _LINE_SHELF_WIDTH: LINE_SHELF_WIDTH,
    _sentenceFor: sentenceFor,
    _orbStateFor: orbStateFor,
    _agentChoices: agentChoices,
    _lineMarkup: lineMarkup,
    _lineFor: lineFor,
    _mountLine: mountLine,
    _onKeyDown: onKeyDown,
    // The pending dismiss timer, so a test can assert it was cleared rather than left to keep a
    // process alive, and a gate can tell "it went away" from "nothing ever drew it".
    _dismissTimer: () => dismissTimer,
    _echoGate: echoGate,
    _pcm16FromFloat32: pcm16FromFloat32,
    _float32FromPcm16: float32FromPcm16,
    _onMessage: onMessage,
    _onClose: onClose,
  };

  if (global.document != null) {
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window === "undefined" ? globalThis : window);
