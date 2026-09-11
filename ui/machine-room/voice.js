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
    // VOICE-11. THE MICROPHONE REFUSES IN THREE DIFFERENT WAYS and shipped they all read the one
    // sentence above -- so a device with no microphone at all was told to allow one, which is advice
    // that cannot be taken. Denied is the sentence above; these two are the other two, and the browser
    // tells them apart by the name it puts on the error it throws.
    "no-microphone-device": "No microphone was found on this device. Connect one and press Talk again.",
    "no-recording": "This browser cannot record sound, so there is no way to talk to your team in it.",
    "no-sound": "The microphone is open but no sound is reaching this page. Pick a different one in Settings and press Talk again.",
    // A tap, on a control whose whole instruction is to hold it.
    "hold-to-talk": "Hold the button while you talk.",
  };
  // THE SAME CONDITION, IN AN APP RATHER THAN A BROWSER. The iPhone shell is a web view over
  // console.titanium.bot, so "allow it in your browser" is advice nobody can follow there: the
  // permission belongs to the app and is granted in iPhone Settings. The shell says so about itself --
  // window.__titanbotShell, injected before first paint, docs/APPS.md -- and NOTHING here reads a user
  // agent, which would be a guess about a browser rather than a fact about a host.
  const SHELL_NOTES = {
    "no-microphone": "This app has not been given the microphone yet. Allow it in iPhone Settings and press Talk again.",
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

  // ---------------------------------------------------------------- VOICE-7: the speech panel
  //
  // Jason, 2026-09-10 11:09: "a semi-transparent modal over the current chat window where that is
  // being built out. We see the words being created, and when it's done, that just becomes the next
  // line ... That modal goes away and that becomes the next line from whoever was speaking."
  //
  // It is mounted in <section class="conversation-space">, and NOT on the road the line above takes.
  // That is the whole of the footer proof and it is architectural rather than fought for: the line is
  // a child of the composer or of the shelf, which is the box VOICE-6 had to measure its way out of.
  // Nothing this panel does is inside that box, so the footer's rect cannot move whatever the panel
  // says. .conversation-space is position:relative and app.js's renderTranscript only ever rewrites
  // .transcript's innerHTML, so the panel also survives every wholesale repaint on its own.
  const OVERLAY_ID = "voice-overlay";
  // The fade in styles.css. Read once here so the node is not pulled out from under a transition that
  // is still running; under prefers-reduced-motion it is skipped entirely.
  const DISSOLVE_MS = 200;
  // A turn that never ends. Every turn the relay knows about is closed by a hear-end frame, including
  // the ones that produce no row at all, but a provider that simply stops mid-turn sends nothing --
  // and somebody's half sentence sitting over their conversation forever is worse than losing the
  // last few words of it.
  //
  // EIGHT SECONDS WAS WRONG, and it was wrong in exactly the case the panel was built for. It was armed
  // from the start of the utterance and re-armed only by a word arriving, so on a service that streams
  // NO live transcript -- which is what docs/VOICE.md 3 marks as unobserved for xAI -- nothing re-armed
  // it: the panel dissolved eight seconds into the sentence, mid-speech, and the confirmed words could
  // then never paint because the panel was shut. MEASURED on this Mac against an injected clock: one
  // timer, 8000 ms from hear-begin, and `heard-confirmed` afterwards left the panel's text empty. So
  // the ceiling is the relay's own honest bound for a turn (TURN_WAIT_CAP_S, 120 s) rather than a guess
  // about how long a person talks, and a turn closed by it can still be re-opened for one final paint.
  const HEARD_STALE_MS = 120_000;
  // And once the confirmed words are up, the dissolve is milliseconds away: if its frame never comes,
  // the panel still goes, with the words that landed as its last paint.
  const HEARD_CONFIRMED_STALE_MS = 2500;
  // The one word the panel shows before the first word arrives, and for the whole of a turn on a
  // provider that sends no live transcript. Plain English; never a condition name.
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
  // the dial, measured at 1.6 to 2.0 s through console.titanium.bot. But the caps count WALL CLOCK,
  // not audio, so a line left up after somebody walked away spends a workspace's day: thirty minutes
  // of a hundred and twenty minute allowance for one forgotten press. So it closes itself.
  const PUSH_IDLE_CLOSE_MS = 60_000;

  // ------------------------------------------------- VOICE-11: the release has to send something
  //
  // THE RELEASE USED TO SEND NOTHING AT ALL. holdEnd shut the microphone and that was the whole of
  // it, and the only thing that ends a turn is the service's own turn detection -- which the relay
  // configures with silence_duration_ms 700 (ui/voice-edge.mjs, TURN_DETECTION) and which fires on
  // AUDIO THAT KEEPS ARRIVING, never on a wire that went quiet. MEASURED on grok-bot-local-vm in
  // Chromium and WebKit at 1440x900 and 390x844: a 900 ms hold and a release put 0 bytes and 0 JSON
  // on the wire for the next 1.5 s while 15 captured frames were dropped by muted(). The words were
  // said and nobody was ever told the person had stopped saying them.
  //
  // So the release sends the silence a person really makes when they stop talking: eight 100 ms
  // frames of zeroes, paced one per 100 ms the way real capture paces them, which is 800 ms of quiet
  // against the relay's 700 ms window. It is NOT input_audio_buffer.commit -- both vendors document
  // that and this bridge refuses it for the reason docs/VOICE.md 13 already gives: a manual commit
  // needs turn detection switched OFF in the session frame, and that frame is written exactly once
  // and byte-identically for the life of the socket.
  const RELEASE_TAIL_MS = 800;
  // 100 ms, which is what FRAME_BYTES is at SAMPLE_RATE. Derived rather than repeated, so a change to
  // the frame cannot leave the pacing behind.
  const FRAME_MS = (FRAME_BYTES / 2 / SAMPLE_RATE) * 1000;
  const TAIL_FRAMES = Math.ceil(RELEASE_TAIL_MS / FRAME_MS);
  // A TAP IS NOT A HOLD. At the 1800 ms dial console.titanium.bot really has, a tap sent zero frames
  // and still opened a line, which then sat there for the idle minute with nothing said into it. So a
  // release before the first frame has gone keeps the microphone open until one has gone or until
  // this long has passed -- three frames' worth, so a hold that produced sound is never cut short and
  // one that produced none is never dialled into silence.
  const MIN_HOLD_MS = 300;
  // A HOLD WHOSE RELEASE NEVER ARRIVES. pointerup, touchend, pointercancel, blur and the space bar's
  // keyup all end one, and a phone that backgrounds the tab mid-hold delivers none of them. Nothing
  // but a release ever closed the microphone, so the ceiling is here. Thirty seconds is already far
  // longer than one utterance -- the turn ends seven tenths of a second after a person stops making
  // noise -- so past it the likely truth is a release that was lost, not somebody still talking. It
  // ends the hold the ordinary way, so the words that were said still go.
  const MAX_HOLD_MS = 30_000;
  // HOW LONG A REFUSAL EATS THE NEXT PRESS. A sentence on screen makes the first press a "clear it"
  // press, which is VOICE-6's loop being prevented; shipped, that was unconditional, so every start
  // while a sentence was up cost two presses and there was nothing on screen to say why the first did
  // nothing. Now the press that clears a FRESH refusal only clears, and a press this long after it
  // clears AND dials -- long enough that the second event of one gesture cannot dial back into the
  // refusal it just cleared, short enough that somebody who read the sentence and pressed again
  // gets a line.
  const REARM_COOLDOWN_MS = 1500;
  // ONE GESTURE'S EVENTS ARRIVE INSIDE THIS WINDOW: a phone sends pointerdown AND touchstart for one
  // thumb, microseconds apart. Two things read it -- a press that spent itself clearing a sentence,
  // and a talkDown that arrives while a hold is already live. Past it, a second press is a NEW press
  // whose predecessor's release was lost. Neither had any expiry when this shipped: a lost release
  // left the spent flag true and ate every press after it for the life of the page.
  const GESTURE_MS = 400;
  // A MICROPHONE THAT OPENED AND PRODUCES NOTHING. The worklet posts a block every 128 samples once
  // the graph is running, so a second of no block at all means the graph is not running -- a context
  // a phone never resumed, or a device that was handed over and then never fed. A live button over
  // that is the worst of the microphone conditions, because nothing on screen looks wrong.
  const SOUND_WATCH_MS = 1000;

  // Frames captured before the socket finished opening. Push to talk starts capturing on the press and
  // the dial is not instant, so without this the first words of the first hold are lost every time.
  // Bounded at two seconds, because the relay drops audio more than three seconds ahead of its own
  // wall clock and counts it as a held frame.
  const PENDING_FRAME_CAP = 20;
  // Where the choice is remembered IN THIS BROWSER, beside Theme and Microphone on the same settings
  // section. Since VOICE-10 this is the FALLBACK rather than the whole of it: the value also travels on
  // the person's own key on /voice/settings, so a choice made on a laptop is there on a phone. This copy
  // is what still works in a private window, in a browser that refuses site data, and against a relay
  // that has never heard of the field -- and it is written FIRST, because the button is live before any
  // route has answered. docs/VOICE.md 13 says which half is which.
  const TALK_MODE_KEY = "titanbot.voice.talkMode";

  // What the page is running inside, as the host itself declares it. Absent in every browser, which is
  // why every read of it is a `=== true` rather than a truthiness test.
  const shellHost = () => global.__titanbotShell ?? null;
  const shellOpensSettings = () => shellHost()?.canOpenAppSettings === true;
  const sentenceFor = (condition) =>
    (shellOpensSettings() ? SHELL_NOTES[condition] : null) ?? NOTES[condition] ?? NOTES["line-dropped"];
  const orbStateFor = (value) => (ORB_STATES.includes(String(value)) ? String(value) : null);

  // VOICE-11. WHICH OF THE THREE THE BROWSER ACTUALLY SAID. The names are the ones both engines throw:
  // a refused permission is NotAllowedError (SecurityError on a page served insecurely), no device at
  // all is NotFoundError (OverconstrainedError when a remembered device is gone), and a browser with
  // no mediaDevices and no AudioWorklet cannot record at all and says so before it asks for anything.
  // Anything else -- most often a device another application is holding -- keeps the shipped sentence,
  // which is the honest one for a cause this page cannot name.
  function micConditionFor(error) {
    if (error?.cannotRecord === true) return "no-recording";
    const name = String(error?.name ?? "");
    if (name === "NotFoundError" || name === "OverconstrainedError") return "no-microphone-device";
    return "no-microphone";
  }

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
  // A browser that cannot record at all, marked as such rather than guessed at by its message. The
  // classifier above reads the mark; nothing reads the string, which is for a developer's console.
  function cannotRecord(message) {
    const error = new Error(message);
    error.cannotRecord = true;
    return error;
  }

  async function captureAudio(options = {}) {
    const sampleRate = options.sampleRate ?? SAMPLE_RATE;
    const frameBytes = options.frameBytes ?? FRAME_BYTES;
    const frameSamples = frameBytes / 2;
    const held = typeof options.held === "function" ? options.held : () => false;
    // HELD AND MUTED ARE TWO DIFFERENT FACTS and are counted apart. `held` is the echo gate: the
    // agent is making noise and the microphone must not hear it, which is a condition the gate's own
    // proof reads a number off. `muted` is push to talk between holds -- the person simply is not
    // talking. Folding them together would make the gate's count unreadable the moment anybody used
    // push to talk, which is the default mode.
    const muted = typeof options.muted === "function" ? options.muted : () => false;
    const onChunk = typeof options.onChunk === "function" ? options.onChunk : () => {};
    const source = options.source ?? "microphone";
    const audio = options.audio ?? {};
    const AudioContextClass = audio.AudioContext ?? global.AudioContext ?? global.webkitAudioContext;
    const AudioWorkletNodeClass = audio.AudioWorkletNode ?? global.AudioWorkletNode;
    const getUserMedia = audio.getUserMedia
      ?? ((constraints) => {
        // A browser with no mediaDevices at all throws a TypeError on the property read, which reads
        // as a bug in this file rather than as a browser that cannot record. It says so instead.
        const devices = global.navigator?.mediaDevices;
        if (devices?.getUserMedia == null) throw cannotRecord("this browser cannot open a microphone");
        return devices.getUserMedia(constraints);
      });
    const moduleUrl = audio.workletUrl ?? null;
    const now = audio.now ?? (() => Date.now());
    if (AudioContextClass == null || AudioWorkletNodeClass == null) {
      throw cannotRecord("this browser has no audio worklet");
    }

    // deviceId is added ONLY when Settings holds one, so a workspace that never opened the row asks
    // for exactly what it always asked for and `exact` can never refuse a microphone nobody chose.
    const deviceId = String(options.deviceId ?? "").trim();

    // VOICE-11. THE CONTEXT IS BORN AND RESUMED BEFORE THE MICROPHONE IS ASKED FOR, and there is no
    // `await` of any kind between the press and that ask. WebKit births an AudioContext SUSPENDED and
    // only a user gesture resumes one; the gesture is spent by the first await in the handler, so a
    // context created AFTER `await getUserMedia` -- which is what shipped -- stays suspended on a
    // phone, the worklet never runs, and the page draws a live button over a microphone that produces
    // nothing. The playback half of this file has resumed its own context since VOICE-1 and the
    // capture half never did. resume() is deliberately not awaited, for the same reason.
    const context = new AudioContextClass({ sampleRate });
    if (context.state === "suspended") {
      try { context.resume?.(); } catch { /* a context that will not resume is the sound watchdog's */ }
    }

    let stream = null;
    try {
      stream = source === "microphone"
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
    } catch (error) {
      // The context is made first now, so it has to be given back first: one suspended context per
      // refused press is a leak somebody pays for in battery.
      try { context.close?.(); } catch { /* already closed */ }
      throw error;
    }

    const url = moduleUrl ?? blobUrlFor(WORKLET_SOURCE);
    await context.audioWorklet.addModule(url);
    const node = new AudioWorkletNodeClass(context, "voice-capture");
    const input = context.createMediaStreamSource(stream);
    input.connect(node);

    // `blocks` is every block the worklet posted, counted BEFORE any gate, because the one question it
    // answers is whether the audio graph is running at all. A block that is muted or held is still a
    // microphone that works.
    const stats = { sent: 0, heldFrames: 0, heldMs: 0, mutedFrames: 0, bytes: 0, blocks: 0 };
    let pending = new Float32Array(0);
    let stopped = false;

    node.port.onmessage = (event) => {
      if (stopped) return;
      const block = event.data;
      if (block == null || block.length === 0) return;
      stats.blocks += 1;
      const joined = new Float32Array(pending.length + block.length);
      joined.set(pending, 0);
      joined.set(block, pending.length);
      pending = joined;
      while (pending.length >= frameSamples) {
        const frame = pending.subarray(0, frameSamples);
        pending = pending.slice(frameSamples);
        // Asked FIRST, and before the gate: in push to talk between holds there is nobody talking,
        // so this is not the gate holding anything and must not be counted as though it were.
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
  //
  // NOTES ONLY, since VOICE-7 ADVERSARIAL. It used to take a live caption as well, and the agent's
  // reply was written into it on every spoken turn -- which put words in the footer for the whole of
  // that turn and therefore moved the footer, in the one place VOICE-6 had just finished measuring:
  // MEASURED on this Mac in real Chrome, a reply caption at 1440x900 took #message-input 370.05 to
  // 215.31 px, and at 390x844 took .control-shelf 390x133 at y711 to 390x158 at y686. His reply is
  // already a durable row in the transcript and is spoken out loud; a second copy of it in the footer
  // bought nothing and cost the only measurement this wave makes. So the line is refusals and nothing
  // else, and it only comes up when something is actually wrong.
  function lineFor(notes) {
    const first = Array.isArray(notes) ? notes[0] : null;
    if (first == null) return { text: "", action: null };
    const text = first.text != null && String(first.text).trim().length > 0
      ? String(first.text).trim()
      : sentenceFor(first.condition);
    return { text, action: NOTE_ACTIONS[first.condition] ?? null };
  }

  // ------------------------------------------------------------------ VOICE-7: the speech panel
  //
  // No title, no icon, no close control, no border that reads as dialog chrome, and no condition name
  // anywhere: host-notes-read-as-errors.md is exactly the failure a machine-looking sheet over
  // somebody's chat would reproduce. An orb that is plainly listening, and the words being built.
  // It dissolves rather than closing, and what it leaves behind is the next line of the conversation.
  //
  // aria-live="polite" so the words reach a screen reader as they firm up, and pointer-events are off
  // in CSS so the conversation underneath stays usable while somebody is speaking.
  function overlayMarkup() {
    return `<div class="voice-overlay" id="${OVERLAY_ID}" data-voice-overlay hidden aria-live="polite">`
      + `<div class="voice-overlay-panel" data-voice-overlay-panel>`
      + `<span class="voice-overlay-orb" data-voice-overlay-orb></span>`
      + `<p class="voice-overlay-text" data-voice-overlay-text></p>`
      + `</div></div>`;
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
    settings: null,
    byeReason: "",
    available: null,
    /** The microphone the person picked in Settings, or "" for whichever the browser hands over. */
    micDeviceId: "",
    /** The relay's hop ledger for the last turn, when it sent one. Never drawn. */
    hops: null,
    /**
     * VOICE-7. The speech panel, which is the person's OWN words and never the agent's. The line
     * above is shared by both directions, and a reply painting over a half-finished sentence is
     * exactly what that sharing used to do mid-turn.
     */
    heard: { open: false, text: "", turn: 0, phase: "", lands: false, nonce: "", itemId: "" },
    /** The last confirmed words and the id of the row they became. Kept for the gate to compare. */
    lastHeard: "",
    /** The agent's last reply, as it came off the wire. Read by the gate; drawn nowhere. */
    lastSaid: "",
    lastNonce: "",
    /**
     * Whether this relay has sent a LABELLED frame on this line. A relay older than VOICE-7 sends only
     * the three-in-one `heard`, and a page that ignored it would show a person nothing at all while
     * they spoke. So the old frame still drives the panel, until a labelled one proves it does not
     * have to -- and then it is dropped rather than painting the same words twice.
     */
    labelled: false,
    /** Which of the two talk modes this browser is set to. */
    talkMode: TALK_MODE_DEFAULT,
    /** Push to talk: is the button (or the space bar) down right now. */
    held: false,
    /** Whether the microphone may send at all. False in push to talk between holds. */
    talking: false,
    /**
     * VOICE-11. The one door audio leaves by, published here so the release can use the SAME one the
     * capture uses -- the queue it flushes, the socket it checks, the order it keeps. A tail sent down
     * a socket read straight off `state` would jump the frames still waiting for the line to open.
     */
    sendAudio: null,
    /** Zero-filled frames sent after a release, counted apart from the microphone's own. */
    tailFrames: 0,
  };

  function adapter() { return global.__machineRoomAdapter ?? null; }

  function relayFetch(path, init) {
    return global.fetch(path, init);
  }

  function orb(value) {
    const next = orbStateFor(value);
    if (next == null) return;
    state.orb = next;
    // WHILE THE AGENT SPEAKS THERE IS NO PANEL, which is the spec in one line: the orb on the button
    // is the only sign. The relay suppresses the frames too, so this is the second of two guards, and
    // it is the one that holds if the echo gate ever slips.
    if (next === "speaking" && state.heard.open) closeOverlay();
    paint();
  }

  // `at` is when this sentence went up, and the press that clears it reads it: a refusal a person has
  // had time to read is not a reason to eat their next press (VOICE-11, REARM_COOLDOWN_MS).
  function note(condition, text, fromRelay = false) {
    state.notes = [{ condition, text, fromRelay, at: clockNow() }];
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
    // The row is the same row, so it keeps the time it went up: a retitle is not a fresh refusal.
    state.notes = [{ condition, text: state.notes[0].text, fromRelay: state.notes[0].fromRelay, at: state.notes[0].at ?? clockNow() }];
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

  function paint() {
    const document_ = global.document;
    if (document_ == null) return;
    const button = document_.querySelector("[data-voice-talk]");
    if (button != null) {
      const node = button.querySelector("[data-voice-orb]");
      // VOICE-7. AN ORB THAT SAYS LISTENING WHILE THE MICROPHONE IS SHUT IS A LIE, and push to talk
      // creates exactly that: the line stays up between holds so the next one is instant, and the relay
      // goes on saying "listening" because from its side nothing has changed. Between holds the orb is
      // dark. Thinking and speaking still show through, because those happen after a release and they
      // are the truth of that moment.
      const shown = talkMode() === "push" && !state.talking && state.orb === "listening" ? "off" : state.orb;
      if (node != null && node.getAttribute("data-state") !== shown) node.setAttribute("data-state", shown);
      // Engaged means "the microphone is open for me". In push to talk that is the hold and not the
      // line, which outlives it by a minute.
      const engaged = talkMode() === "push" ? state.held : state.on;
      const pressed = engaged ? "true" : "false";
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
      button.classList.toggle("is-live", state.on);
      button.classList.toggle("is-held", state.held);
    }
    const line = mountLine();
    if (line == null) return;
    const { text, action } = lineFor(state.notes);
    const say = line.querySelector("[data-voice-line-say]");
    const does = line.querySelector("[data-voice-line-do]");
    const shown = action == null ? say : does;
    const other = action == null ? does : say;
    // EVERY WRITE IS GUARDED ON A CHANGE. The body-wide observer below watches childList, and
    // textContent replaces child nodes: an unguarded write repaints on its own mutation forever.
    if (shown != null && shown.textContent !== text) shown.textContent = text;
    if (other != null && other.textContent !== "") other.textContent = "";
    // AND SO IS EVERY ATTRIBUTE, which is the other half of that rule and was missing until VOICE-11.
    // `hidden` is an attribute wearing a property's clothes: assigning it the boolean it already holds
    // still calls setAttribute, and setting an attribute to the value it already has still emits a
    // mutation record. MEASURED in real Chrome at 1440x900 on an idle console: forty wakes of the
    // observer below produced forty records on each of five nodes, one per wake, for a paint that
    // changed nothing. Nothing was broken by it -- no node is replaced and there is no flicker -- but
    // it is exactly the "chasing its own mutation" the comment on that observer promises cannot
    // happen, and a debounce is the only reason it did not.
    if (say != null) hide(say, action != null || text.length === 0);
    if (does != null) {
      hide(does, action == null);
      // NO aria-label HERE, on purpose. An aria-label REPLACES a button's own text for a screen
      // reader, so labelling this "Open settings" would read the control out and swallow the sentence
      // that is the whole reason it is on screen. The sentence is the accessible NAME; the action's
      // words are the title, which is the accessible DESCRIPTION beside it.
      if (action != null && does.getAttribute("title") !== action) does.setAttribute("title", action);
    }
    if (say != null) {
      if (text.length === 0) say.removeAttribute("title");
      else if (say.getAttribute("title") !== text) say.setAttribute("title", text);
    }
    hide(line, text.length === 0);
    // THE FIFTH TRACK COSTS NOTHING AT REST. An unconditional empty track was measured to take 4 px
    // off the message box through the composer's own 4 px gap, so the attribute the track hangs on
    // is written only while the line is really in the form with something to say.
    const form = document_.getElementById("composer");
    if (form != null) {
      if (!line.hidden && line.parentElement === form) {
        if (form.getAttribute("data-voice-line") !== "up") form.setAttribute("data-voice-line", "up");
      } else form.removeAttribute("data-voice-line");
    }
  }

  // `node.hidden = value` is a setAttribute in disguise and fires a mutation record even when the
  // value does not change. One helper rather than three inline comparisons, because the next person
  // to add a hidden node to this file will copy whichever line is nearest.
  function hide(node, hidden) {
    if (node == null || node.hidden === hidden) return;
    node.hidden = hidden;
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

  // VOICE-7. Into .conversation-space, and DELIBERATELY NOT the road mountLine takes above: a node in
  // the composer or the shelf is inside the box whose geometry VOICE-6 had to measure, and this panel
  // must not be able to move the footer at all. The conversation space is position:relative and app.js
  // only ever rewrites .transcript's innerHTML inside it, so this node is over the chat, is never
  // rebuilt, and cannot reach the footer.
  function mountOverlay() {
    const document_ = global.document;
    if (document_ == null) return;
    if (document_.getElementById(OVERLAY_ID) != null) return;
    const space = document_.querySelector(".conversation-space");
    if (space == null) return;
    space.insertAdjacentHTML("beforeend", overlayMarkup());
    paintOverlay();
  }

  // ------------------------------------------------------- VOICE-7: the panel's state machine
  //
  // FOUR FRAMES DRIVE IT and the relay labels every one of them, which is the whole reason the panel
  // can exist: until this wave the wire had a single `heard` frame carrying three different things
  // under one shape (the partial transcript, the settled transcript, and the string the agent was
  // actually handed), and a strip could paint all three the same way. A panel that has to open,
  // follow the words and then DISSOLVE cannot.
  //
  //   hear-begin       the person started talking; no words yet.
  //   hear             the transcript so far, replace-whole. `final` marks the settled one.
  //   heard-confirmed  the bytes that went into the agent's conversation, and the id of the row.
  //   hear-end         this turn is over, and why.
  //
  // FOUR THINGS THAT LOOK LIKE DETAIL AND ARE NOT:
  //   1. REPLACE, NEVER APPEND. One service sends a cumulative transcript that corrects itself and
  //      the other sends deltas; the relay hides that difference, and appending would write the
  //      sentence N times on the first of them.
  //   2. AN OLDER TURN MAY NEVER PAINT OVER A NEWER ONE. The settled transcript for one utterance is
  //      not guaranteed to arrive before the next utterance's partials, so every frame carries the
  //      relay's own utterance counter and a late one is dropped.
  //   3. THE LAST WORDS ARE THE CONFIRMED ONES, not the transcription model's last word. Those are two
  //      models and two strings. Dissolving on the settled transcript would leave the panel's last
  //      words different from the line it becomes, which is the one thing Jason asked for.
  //   4. IT DISSOLVES ON hear-end AND NEVER ON THE ROW APPEARING. The confirmation lands in
  //      milliseconds; the agent's reply lands five to twenty-five seconds later and is not the
  //      panel's business.
  let dissolveTimer = null;
  let staleTimer = null;

  const reducedMotion = () => {
    try { return global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true; }
    catch { return false; }
  };

  // Which turn the stale window took away, so the words that turn produced can still be painted once
  // if they arrive after it. Never any other closing: a person who pressed stop, or an agent who
  // started speaking, must not have a panel come back at them.
  let staleClosedTurn = 0;
  function armStale(ms = HEARD_STALE_MS) {
    if (staleTimer != null) global.clearTimeout(staleTimer);
    const turn = state.heard.turn;
    staleTimer = global.setTimeout(() => { staleTimer = null; staleClosedTurn = turn; closeOverlay(); }, ms);
  }
  function disarmStale() {
    if (staleTimer != null) { global.clearTimeout(staleTimer); staleTimer = null; }
  }

  /**
   * The person started talking. No words yet, which is also the whole of what a provider that sends
   * no live transcript ever gives us -- so the panel opens here rather than on the first word, and a
   * person pressing Talk always gets something honest on screen.
   */
  function overlayOpen(turn, itemId = "") {
    if (state.orb === "speaking") return;
    if (dissolveTimer != null) { global.clearTimeout(dissolveTimer); dissolveTimer = null; }
    state.heard = { open: true, text: "", turn: Number(turn) || 0, phase: "open", lands: false, nonce: "", itemId: String(itemId ?? "") };
    armStale();
    paintOverlay();
  }

  /** More of the sentence. Replace, never append. */
  function overlayPartial(text, turn, itemId = "") {
    const at = Number(turn) || 0;
    if (state.heard.open && at < state.heard.turn) return;
    // AND NEVER ANOTHER UTTERANCE'S WORDS. The relay drops a transcript belonging to the item it has
    // moved on from, and this is the same guard on this side of the wire: the settled transcript of the
    // sentence before can arrive after this one opened, and it names its own item.
    const item = String(itemId ?? "");
    if (state.heard.open && item.length > 0 && state.heard.itemId.length > 0 && item !== state.heard.itemId) return;
    if (!state.heard.open) overlayOpen(at, item);
    if (!state.heard.open) return;
    state.heard.turn = at;
    state.heard.text = String(text ?? "");
    state.heard.phase = "partial";
    armStale();
    paintOverlay();
  }

  /**
   * The bytes that went into the agent's conversation. This is the panel's LAST paint, and it is what
   * makes "the words you were watching become the next line" true in bytes rather than approximately:
   * the row in the transcript is built from this same string, under this same id.
   *
   * It does not dissolve. hear-end does, and it arrives immediately after this.
   */
  function overlayConfirmed(text, frame) {
    const at = Number(frame?.turn) || 0;
    if (state.heard.open && at < state.heard.turn) return;
    const words = String(text ?? "");
    // Kept after the panel has gone, because this is the claim the gate proves.
    state.lastHeard = words;
    state.lastNonce = String(frame?.nonce ?? "");
    // THE ONE PANEL THAT MAY COME BACK. A turn the stale window took away still produced words, and
    // this item promises those words are what the person last read. So the panel re-opens for this
    // single final paint -- for that turn only, and only where staleness is what shut it.
    if (!state.heard.open && at > 0 && at === staleClosedTurn && words.length > 0) {
      state.heard = { open: true, text: "", turn: at, phase: "open", lands: false, nonce: "", itemId: state.heard.itemId };
      staleClosedTurn = 0;
    }
    if (!state.heard.open) return;
    if (words.length === 0) return;
    state.heard.turn = at;
    state.heard.text = words;
    state.heard.phase = "final";
    state.heard.lands = frame?.landed === true;
    state.heard.nonce = state.lastNonce;
    // NOT disarmed. hear-end arrives milliseconds after this and dissolves the panel, but if it never
    // arrives the panel would otherwise stand over the conversation for the rest of the call.
    armStale(HEARD_CONFIRMED_STALE_MS);
    paintOverlay();
  }

  /**
   * This turn is over. Three turns produce no row at all -- an empty utterance, a yes that closed a
   * card, a send the box refused -- and each of them arrives here with its own reason rather than
   * leaving the panel waiting for a row that is never coming. The reason is not drawn: a person who
   * just spoke does not need the machine's word for what happened to it.
   */
  function overlayEnd(turn) {
    const at = Number(turn) || 0;
    if (!state.heard.open) return;
    if (at > 0 && at < state.heard.turn) return;
    disarmStale();
    // Nothing was heard, so there is nothing to read and nothing to leave behind.
    if (state.heard.text.length === 0) { closeOverlay(); return; }
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
    state.heard = { open: false, text: "", turn: state.heard.turn, phase: "", lands: false, nonce: "", itemId: state.heard.itemId };
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
      const shown = words.length > 0 ? words : LISTENING_WORD;
      // EVERY WRITE IS GUARDED ON A CHANGE, the same rule paint() keeps: the body-wide observer below
      // watches childList, and textContent replaces child nodes, so an unguarded write repaints on its
      // own mutation forever.
      if (text.textContent !== shown) text.textContent = shown;
      // One word in the muted colour rather than an empty sheet, which is what a person sees for the
      // length of a turn on a provider that sends no live transcript.
      text.classList.toggle("voice-overlay-waiting", words.length === 0);
    }
    // A LONG UTTERANCE KEEPS ITS NEWEST WORDS ON SCREEN. The panel has a ceiling so it can never cover
    // the whole conversation, and nothing in it can be scrolled by hand -- pointer events are off on
    // purpose so the chat underneath stays clickable while somebody is talking. So the words being
    // said right now are kept in view from here instead.
    const panel = node.querySelector("[data-voice-overlay-panel]");
    if (panel != null && typeof panel.scrollHeight === "number") panel.scrollTop = panel.scrollHeight;
    if (!state.heard.open) node.removeAttribute("data-phase");
    hide(node, !state.heard.open);
  }

  async function start(options = {}) {
    if (state.on) return;
    state.on = true;
    state.byeReason = "";
    // Asked again on every line, because the relay on the other end of the next one may not be the
    // relay that answered the last.
    state.labelled = false;
    clearNotes();
    // The relay owns the orb once the line is up; until `ready` arrives there is no frame to obey,
    // and "thinking" is the honest one of the four for a line that is being dialled.
    // PUSH TO TALK CAPTURES BEFORE THE LINE IS UP, and only push to talk does.
    //
    // The dial is not free -- 1.6 to 2.0 s through console.titanium.bot -- and in push to talk the
    // person is already talking into a button they are holding down, so a capture that waited for the
    // socket would lose the first words of every first hold. Those frames go into a bounded queue and
    // are flushed the instant the socket opens.
    //
    // ALWAYS LISTENING KEEPS THE OLD ORDER, socket first, because there the press is a toggle and a
    // line that is refused should never have touched the microphone at all. Holding a button down is a
    // different kind of consent from pressing one.
    const captureFirst = options.captureFirst === true;
    // In always listening the microphone is open for the whole call and opening the line is what asks
    // for that. In push to talk the hold is what asks, and holdStart has already said so.
    if (talkMode() !== "push") state.talking = true;
    // The relay owns the orb once the line is up; until `ready` arrives there is no frame to obey,
    // and "thinking" is the honest one of the four for a line that is being dialled.
    orb("thinking");
    state.gate = echoGate({ sampleRate: SAMPLE_RATE });
    state.sound = player({ gate: state.gate });
    state.tailFrames = 0;

    // The queue is bounded at two seconds. The relay drops audio more than three seconds ahead of its
    // own wall clock and counts it as a held frame, so a queue that grew without a ceiling would arrive
    // as a burst the relay throws away -- which looks exactly like a microphone that is not working.
    let pending = [];
    const sendFrame = (buffer) => {
      const socket = state.socket;
      if (socket != null && socket.readyState === 1) {
        if (pending.length > 0) {
          const queued = pending;
          pending = [];
          for (const one of queued) { try { socket.send(one); } catch { /* the close handler has it */ } }
        }
        try { socket.send(buffer); } catch { /* the close handler has it */ }
        return;
      }
      if (!captureFirst) return;
      pending.push(buffer);
      while (pending.length > PENDING_FRAME_CAP) pending.shift();
    };
    // VOICE-11. The release sends through this same door, so its silence queues behind whatever the
    // hold captured before the line was up and arrives in the order it was made.
    state.sendAudio = sendFrame;
    const beginCapture = () => captureAudio({
      source: "microphone",
      deviceId: state.micDeviceId,
      sampleRate: SAMPLE_RATE,
      frameBytes: FRAME_BYTES,
      held: () => state.gate.holding(),
      // Push to talk between holds. In always listening nothing is ever muted this way and the echo
      // gate is the only thing that drops a frame.
      muted: () => !state.talking,
      onChunk: (buffer) => {
        sendFrame(buffer);
        // The tap window below closes on the FIRST frame rather than on its timer, so a hold that was
        // only just long enough pays nothing at all for the rule that catches a tap.
        if (graceOpen()) finishHold();
      },
    });

    if (captureFirst) {
      try { state.capture = await beginCapture(); watchForSound(); }
      catch (error) { stop(micConditionFor(error)); return; }
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
    // WHATEVER WAS CAPTURED WHILE THE LINE WAS STILL OPENING GOES NOW, in order, and whether or not the
    // button is still down. Flushing it only on the next frame that is allowed through would lose a
    // hold SHORTER than the dial entirely: every frame after the release is muted, so the queue would
    // sit there holding the only words that were ever said and never send them.
    if (pending.length > 0) {
      const queued = pending;
      pending = [];
      for (const one of queued) { try { state.socket?.send(one); } catch { /* the close handler has it */ } }
    }
    if (!captureFirst) {
      try { state.capture = await beginCapture(); watchForSound(); }
      catch (error) { stop(micConditionFor(error)); return; }
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
    // VOICE-11. Everything this wave arms comes down here, and BEFORE the socket goes: a tail still
    // being paced onto a closing line, a tap window still waiting for a frame that will never come,
    // and a hold ceiling for a hold that is over.
    cancelTail();
    clearGrace();
    clearMaxHold();
    clearSoundWatch();
    state.sendAudio = null;
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
    // The line is down, so nothing more is coming for whatever is on the panel. It goes at once
    // rather than fading, and the hold goes with it: a button drawn as held after the line has
    // dropped is a microphone a person believes is open.
    closeOverlay();
    clearIdleClose();
    state.held = false;
    state.talking = false;
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
    // Always listening: the line is open from this press to the next one, and the provider's own turn
    // detection decides where one utterance ends and the next begins. The microphone is open the whole
    // time, which is what the name says, and the echo gate still shuts it while the agent speaks.
    state.talking = true;
    return start();
  }

  // ------------------------------------------------------------------ VOICE-7: the two talk modes
  //
  // ONE PAIR OF ENTRY POINTS, talkDown and talkUp, and everything reaches the microphone through
  // them: the button with a mouse, the button with a thumb, the space bar, and the desktop app's
  // global hotkey when that wave lands. A hotkey with its own copy of this would be a third behaviour
  // to keep in step with a setting.
  function talkMode() { return TALK_MODES.includes(state.talkMode) ? state.talkMode : TALK_MODE_DEFAULT; }

  function talkDown() {
    if (talkMode() === "always") { toggle(); return undefined; }
    return holdStart();
  }
  function talkUp() {
    if (talkMode() === "always") return undefined;
    return holdEnd();
  }

  // ONE REAL PRESS IS ONE PRESS, whatever the browser sends for it. A phone fires pointerdown AND
  // touchstart for one thumb, and both reach talkDown: MEASURED in real Chrome at 390x844 with a real
  // CDP touch hold, with a refusal standing, the first of the two cleared the note and the second then
  // found no note and dialled straight back into the same refusal -- the loop the line below exists to
  // prevent, reappearing through the second event of the same gesture. The desktop mouse path, which
  // fires only pointerdown, was correct. So the gesture remembers that it has already been spent, and
  // the next release clears it.
  //
  // VOICE-11 GAVE BOTH OF THESE AN EXPIRY. A gesture whose release never arrived left `pressSpent`
  // true for the life of the page and ate every press after it, and a hold whose release never
  // arrived made every later press a no-op because `state.held` was still true. Time is what tells
  // the second event of ONE gesture from a NEW press: the first pair arrive microseconds apart.
  let pressSpentAt = 0;
  let heldAtMs = 0;
  /** What the capture had sent when this hold began, so "did this hold say anything" is a subtraction. */
  let holdSentBase = 0;
  const pressIsSpent = () => pressSpentAt > 0 && clockNow() - pressSpentAt < GESTURE_MS;
  const framesThisHold = () => Math.max(0, (state.capture?.stats.sent ?? 0) - holdSentBase);
  function pressDone() { pressSpentAt = 0; }

  // Push to talk. The first hold opens the line; later holds are instant because it is still up.
  async function holdStart() {
    if (state.held) {
      // Two events of ONE gesture land in the same few milliseconds, and the second must never end the
      // first. A press this long after the hold began is a NEW press whose predecessor's release was
      // lost, so that hold is ended properly -- tail and all -- rather than left open underneath it.
      if (clockNow() - heldAtMs < GESTURE_MS) return;
      holdEnd();
    }
    if (pressIsSpent()) return;
    // A NOTE ON SCREEN IS THE MODE, which is the same rule the toggle keeps and for the same reason.
    // While a refusal is standing the first press CLEARS it rather than dialling into the refusal
    // again; without this, holding the button on a workspace with talking switched off redials every
    // time and there is no way out of it. That loop is what Jason was stuck in: "you can't exit out of
    // this talk mode" (VOICE-6).
    //
    // VOICE-11: only while the refusal is FRESH. Shipped, that press never dialled however old the
    // sentence was, so after a refusal -- or a dropped line -- every start cost two presses, with
    // nothing on screen to say the first had been spent. A sentence the person has had time to read is
    // cleared AND dialled by one press; a sentence younger than the cooldown is only cleared, which is
    // what keeps the second event of one gesture, and a reflex re-press, out of the same refusal.
    if (!state.on && state.notes.length > 0) {
      const standing = state.notes[0];
      const fresh = clockNow() - Number(standing?.at ?? 0) < REARM_COOLDOWN_MS;
      pressSpentAt = clockNow();
      clearNotes();
      if (fresh) return;
    }
    state.held = true;
    heldAtMs = clockNow();
    holdSentBase = state.capture?.stats.sent ?? 0;
    state.talking = true;
    clearGrace();
    cancelTail();
    clearIdleClose();
    armMaxHold();
    paint();
    if (state.on) return;
    await start({ captureFirst: true });
  }

  function holdEnd() {
    if (!state.held) return;
    state.held = false;
    clearMaxHold();
    // A RELEASE BEFORE THE FIRST FRAME HAS GONE IS A TAP, and a tap used to shut the microphone having
    // sent nothing at all -- at the 1800 ms dial console.titanium.bot has, a tap opened a whole line
    // and said nothing into it. So the microphone stays open until one frame has gone or MIN_HOLD_MS
    // has passed, whichever comes first, and `talking` stays true through that window because it is
    // what lets a frame go at all. The button is repainted at once: the hold really is over.
    if (state.talking && framesThisHold() === 0) {
      paint();
      openGrace();
      return;
    }
    finishHold();
  }

  // The end of a hold, by whichever of the three roads got here: an ordinary release, the tap window
  // expiring, or the first frame arriving inside it.
  function finishHold() {
    clearGrace();
    state.talking = false;
    // The TURN ends the way it ends in the other mode: the provider's own turn detection notices the
    // silence. We do NOT send the provider's manual commit, because that needs turn detection switched
    // off in the session frame, and this bridge writes that frame exactly once and byte-identically
    // for the life of the socket -- rewriting it re-bills the whole conversation on one of the two
    // services. What VOICE-11 changed is that the silence is now SENT: turn detection fires on audio
    // that keeps arriving, and a wire that simply stopped is not silence to it.
    if (framesThisHold() > 0) sendReleaseTail();
    else { note("hold-to-talk"); armDismiss(); }
    paint();
    armIdleClose();
  }

  // ------------------------------------------------------------- VOICE-11: the tail, and the tap
  let tailTimer = null;
  let tailLeft = 0;
  function cancelTail() {
    if (tailTimer != null) { global.clearTimeout(tailTimer); tailTimer = null; }
    tailLeft = 0;
  }

  /**
   * Eight 100 ms frames of zeroes after a release, down the same door the capture uses.
   *
   * PACED, NEVER BURST. The relay drops audio more than three seconds ahead of its own wall clock and
   * counts what it dropped as a held frame, and 800 ms of silence arriving in one packet is not a
   * person falling quiet to a service's turn detection either. One frame goes at once, because the
   * release is the moment the person stopped, and the other seven follow a frame apart.
   */
  function sendReleaseTail() {
    cancelTail();
    tailLeft = TAIL_FRAMES;
    const one = () => {
      tailTimer = null;
      if (tailLeft <= 0) return;
      const send = state.sendAudio;
      // The line went while the tail was being paced. What is left of it is dropped rather than
      // queued: there is nothing on the other end to hear it.
      if (send == null) { tailLeft = 0; return; }
      tailLeft -= 1;
      try { send(new ArrayBuffer(FRAME_BYTES)); }
      catch { tailLeft = 0; return; }
      state.tailFrames += 1;
      if (tailLeft > 0) { tailTimer = global.setTimeout(one, FRAME_MS); tailTimer?.unref?.(); }
    };
    one();
  }

  let graceTimer = null;
  const graceOpen = () => graceTimer != null;
  function clearGrace() {
    if (graceTimer != null) { global.clearTimeout(graceTimer); graceTimer = null; }
  }
  function openGrace() {
    clearGrace();
    graceTimer = global.setTimeout(() => { graceTimer = null; finishHold(); }, MIN_HOLD_MS);
    graceTimer?.unref?.();
  }

  // A hold whose release was lost. It ends the hold rather than hanging up, so the words that were
  // said still become a turn and the line is still warm for the next press.
  let maxHoldTimer = null;
  function clearMaxHold() {
    if (maxHoldTimer != null) { global.clearTimeout(maxHoldTimer); maxHoldTimer = null; }
  }
  function armMaxHold() {
    clearMaxHold();
    maxHoldTimer = global.setTimeout(() => { maxHoldTimer = null; if (state.held) holdEnd(); }, MAX_HOLD_MS);
    maxHoldTimer?.unref?.();
  }

  // The microphone opened and the audio graph is not running. Asked once a second after the capture
  // starts, and only about `blocks`, which counts what the worklet posted before any gate touches it.
  let soundTimer = null;
  function clearSoundWatch() {
    if (soundTimer != null) { global.clearTimeout(soundTimer); soundTimer = null; }
  }
  function watchForSound() {
    clearSoundWatch();
    soundTimer = global.setTimeout(() => {
      soundTimer = null;
      if (!state.on || state.capture == null) return;
      if ((state.capture.stats.blocks ?? 0) > 0) return;
      note("no-sound");
      armDismiss();
    }, SOUND_WATCH_MS);
    soundTimer?.unref?.();
  }

  // A line nobody has held for a minute closes itself. The caps count WALL CLOCK, so a forgotten press
  // in push to talk would otherwise spend thirty minutes of a hundred and twenty minute day with
  // nobody in the room. Always listening has no such timer: there the line being up IS what the person
  // asked for, and the way out is the button or Escape.
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
  // THIS BROWSER, and the row that sets it sits under General > System beside Theme and Microphone,
  // which are remembered the same way. It is deliberately NOT /voice/settings: that is one file per
  // WORKSPACE, and two people sharing one would fight over how their own button behaves. VOICE-10 is what
  // closed that: the value travels on that door keyed on the session's own PERSON claim -- the same key
  // the device list and the notification settings use -- so the file is still one per workspace and the
  // choice is still one per person. This browser's copy below stays as the fallback.
  //
  // The module owns the value rather than the row, because the button is live the moment the console
  // paints and long before any settings surface has been opened.
  const talkModeOf = (value) => (TALK_MODES.includes(String(value)) ? String(value) : TALK_MODE_DEFAULT);
  // VOICE-10 / SETTINGS-3, the same defect in the voice module: boot asks the person's own door and the
  // answer can land AFTER a press has already chosen, in which case adopting it puts the older value
  // under the person's hand with nothing on screen to say why. MEASURED on MacBook-Pro.local 2026-09-11,
  // --leg overlay at 1440x900 and 390x844: a combination that set always listening after the boot read
  // had started came up in push -- the microphone shut between presses and the Talk mode row read push --
  // 2 of 2 viewports. So a read carries the time it was ASKED at, and an answer older than this page's
  // own choice is no answer at all.
  let talkModeChosenAt = 0;
  const clockNow = () => (typeof Date.now === "function" ? Date.now() : 0);

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
   * CHANGING THE MODE ENDS THE CALL YOU ARE IN. The alternative is a line that is up while the control
   * that opened it has changed meaning underneath the person -- a microphone whose state nobody on
   * screen can account for.
   */
  function setTalkMode(mode) {
    const next = talkModeOf(mode);
    const changed = next !== state.talkMode;
    state.talkMode = next;
    // WHEN THIS PAGE LAST CHOSE, so an answer that was already in the air when the person chose cannot
    // publish an older value over it. The same rule the settings surface holds for its own rows, one
    // layer down, because the door's answer and the press are two producers of one value.
    talkModeChosenAt = clockNow();
    writeStoredTalkMode(next);
    // VOICE-10. AND ON THE PERSON'S OWN DOOR, so the choice follows them to their phone.
    //
    // This browser's copy above is written FIRST and is the behaviour. The route is told after, never
    // waited for, and never able to fail the press: a relay that refuses, a relay that never answers, a
    // private window that refuses site data -- each of those leaves the button doing exactly what was
    // asked of it, and the only thing lost is that the choice does not travel. docs/VOICE.md 13 says
    // which half is which.
    void writeSettings({ talkMode: next }).then((saved) => { if (saved != null) state.settings = saved; }).catch(() => {});
    if (changed && state.on) { stop(); return next; }
    paint();
    return next;
  }

  /**
   * VOICE-10. A talk mode that arrived from the person's own door rather than from a press.
   *
   * It deliberately does NOT go through setTalkMode. That door ends the call you are in when the mode
   * really changes, which is right for a person choosing and wrong for an answer landing on its own --
   * nobody pressed anything, and cutting a live call because a route answered is a microphone closing
   * for no reason a person on the page could account for. A call that is up keeps the mode it was opened
   * under and the answer is taken on the next boot.
   *
   * An unknown or absent value is no answer at all: this person has never chosen, and what this browser
   * holds stays the behaviour.
   */
  function adoptTalkMode(mode, askedAt = clockNow()) {
    if (!TALK_MODES.includes(String(mode ?? ""))) return state.talkMode;
    const next = talkModeOf(mode);
    if (next === state.talkMode) return next;
    if (state.on) return state.talkMode;
    // A READ THAT WAS ALREADY IN FLIGHT WHEN THIS PAGE CHOSE LOSES. Nothing is stored and nothing is
    // painted: the person's own choice stands, and the door has the newer value anyway because
    // setTalkMode wrote it there.
    if (talkModeChosenAt > 0 && askedAt <= talkModeChosenAt) return state.talkMode;
    state.talkMode = next;
    writeStoredTalkMode(next);
    paint();
    return next;
  }

  // Escape leaves too, and it is guarded twice. app.js:6802 already owns a document-level Escape for
  // the drawer, and this console has native <dialog>s -- the settings panel, onboarding, the report
  // card -- that close on Escape; stealing it from one of those would read as a broken modal.
  function onKeyDown(event) {
    // SOMEBODY NEARER THE KEY ALREADY CLAIMED IT. This listener is on the document, so it runs after
    // every handler between here and whatever was focused -- the transcript's own space handler for
    // its focusable rows, the composer's Enter, the command palette. A key one of those has already
    // acted on is not also a microphone.
    if (event?.defaultPrevented === true) return;
    if (event?.key === "Escape") { escapeStops(); return; }
    if (event?.key !== " " && event?.code !== "Space") return;
    // THE LATCH. A held key repeats, and without this the handler would fire tens of times a second
    // for as long as somebody spoke.
    if (event.repeat === true || state.held) return;
    if (talkMode() !== "push" || !spaceMayTalk()) return;
    event.preventDefault?.();
    void talkDown();
  }

  /**
   * ESCAPE LEAVES, in either mode, and it is guarded twice. app.js already owns a document-level
   * Escape for the drawer and this console has native <dialog>s -- the settings panel, onboarding, the
   * report card -- that close on Escape; stealing it from one of those would read as a broken modal.
   *
   * Its own function rather than a branch inside the listener, because it is also the way out of
   * always listening that needs no pointer, and a test has to be able to ask this one question.
   */
  function escapeStops() {
    // ENGAGED IS MORE THAN `on`. Between the press and the relay's answer the session is DIALLING:
    // `on` is still false and no note has been raised yet, and an Escape in that window used to do
    // nothing at all -- and then the refusal landed a moment later and the person was back in the mode
    // they had just left. MEASURED on grok-bot-local-vm in real Chrome at 1440x900: pressing Escape
    // while the dial was in flight left `{"on":false,"notes":["no-key"]}` a breath later with the line
    // up, which is the "you can't exit out of this talk mode" shape all over again. `talking` is set by
    // the press itself and `socket` as soon as the line is accepted, so between them they cover it.
    const engaged = state.on || state.talking || state.socket != null;
    if (!engaged && state.notes.length === 0) return false;
    const document_ = global.document;
    if (document_?.querySelector?.("dialog[open]") != null) return false;
    if (document_?.body?.dataset?.drawer) return false;
    // stop() clears a standing note when it has nothing new to say, so both branches really leave, and
    // it leaves `on` false, which is what makes onClose ignore the close that follows our own.
    if (engaged) stop(); else clearNotes();
    return true;
  }

  function onKeyUp(event) {
    if (event?.key !== " " && event?.code !== "Space") return;
    const wasHeld = state.held;
    // The space bar is a gesture too, and one that only cleared a standing refusal has to be spent by
    // its own release or the next press of it would do nothing at all.
    pressDone();
    if (wasHeld) void talkUp();
  }

  // ------------------------------------------------------- VOICE-7: what may hold the space bar
  //
  // FIVE OTHER KEYDOWN PATHS live on this document -- the transcript's own space handler for evidence
  // rows, Escape closing a drawer, the desktop chord, the composer's Enter, and the command palette --
  // and the box's screen takes keystrokes outright, because it is an iframe and everything typed into
  // it is meant for the machine on the other side. A space bar that opened a microphone through any of
  // those reads as a broken console.
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
      // VOICE-7. The four labelled frames the speech panel is built out of. See the state machine
      // above for what each one means and why the panel dissolves on the last of them.
      case "hear-begin":
        state.labelled = true;
        overlayOpen(frame.turn, frame.itemId);
        break;
      // REPLACE-WHOLE on purpose. One vendor's transcription event is cumulative with corrections and
      // the other's is incremental; appending a delta writes the sentence N times on the first. The
      // settled transcript (`final`) is deliberately painted as another partial: it races the agent's
      // own tool call, and dissolving here would flash the panel back a moment later.
      case "hear":
        state.labelled = true;
        overlayPartial(String(frame.text ?? ""), frame.turn, frame.itemId);
        break;
      // The bytes that went into the agent's conversation, and the id of the row they became. This is
      // the panel's last paint, and it is what makes the words a person watched being built the same
      // bytes as the line they turn into.
      case "heard-confirmed":
        state.labelled = true;
        overlayConfirmed(String(frame.text ?? ""), frame);
        break;
      case "hear-end":
        state.labelled = true;
        overlayEnd(frame.turn);
        break;
      // THE THREE-IN-ONE FRAME VOICE-1 SHIPPED, which carried the partial transcript, the settled one
      // and the agent's own tool argument under a single shape. A relay restart mid-call can leave a
      // new page against an OLD relay, and that relay sends only this -- so it still drives the panel,
      // because a person who is talking and seeing nothing is worse than a panel with no end frame
      // (the stale timer takes that one away). Once a labelled frame has arrived, this is dropped:
      // painting both would put the same words on screen twice.
      case "heard":
        if (!state.labelled) overlayPartial(String(frame.text ?? ""), state.heard.open ? state.heard.turn : 1);
        break;
      // The agent's reply. IT PAINTS NOTHING. It is already a durable row in the transcript, it is
      // already spoken out loud, and the only other sign a person needs while he is talking is the orb
      // on the button -- which is what this item asked for in those words. Writing it into the footer
      // line as well was the last thing in this file that could move the footer during a turn, and it
      // moved it on EVERY turn: measured, #message-input 370.05 -> 215.31 px at 1440x900 and the shelf
      // 25 px taller and 25 px higher at 390x844, standing for the rest of the call because only a
      // start or a stop ever cleared it. The text is kept for the gate to read and for nothing else.
      case "said":
        state.lastSaid = String(frame.text ?? "");
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
    const capSeconds = Number(value.dayCapSeconds) || 0;
    return {
      enabled: value.enabled === true,
      available: value.available === true || (value.available == null && value.apiKeySet === true),
      // THE MINUTES TRAVEL WITH THE ANSWER, because the row that draws them is one read away in
      // Settings and a second round trip for two numbers the relay already sent is a second chance
      // to disagree with itself. They are OMITTED, not zeroed, when this workspace has no day cap:
      // the Usage row tests both for a finite number and draws no bar at all without them, and a bar
      // reading 0 of 0 is a measurement nobody took.
      ...(capSeconds > 0 ? {
        minutesUsedToday: Math.round(((Number(value.dayUsedSeconds) || 0) / 60) * 10) / 10,
        minutesCapToday: Math.round((capSeconds / 60) * 10) / 10,
      } : {}),
      // AND THE LENGTH OF ONE CALL, which the old card said on the same line as the day pair --
      // "4 of 30 today, up to 10 in one call" -- and which nothing said after the card was replaced.
      // A call ending at its ceiling is the thing a person most needs told in advance, so the cap
      // travels with the answer and the Usage row prints it in the meter's own caption (VOICE-8).
      // Omitted, not zeroed, where this workspace has no per-call ceiling.
      ...(Number(value.sessionCapSeconds) > 0
        ? { minutesCapPerCall: Math.round((Number(value.sessionCapSeconds) / 60) * 10) / 10 }
        : {}),
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
  // Published BOTH ways on purpose, and the reason is worth the two lines. The rows in Settings test
  // `supportsMicChoice === true` and call `micDeviceId()`, because that is the shape every other fact
  // that surface reads already has; this file's own callers and its tests use the function and the
  // get/set pair. A silent mismatch here does not throw -- it draws no Microphone row at all and
  // reports the chosen device as "System default" forever -- which is exactly the class of seam that
  // gets found in front of a customer rather than in a suite.
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

  // ------------------------------------------------------------------ VOICE-8: the operator's four rows
  //
  // WHAT WAS LOST AND WHY IT IS HERE. KEYS-1 deleted the Voice card whole, correctly: the key field on
  // it was the operator's and belongs in the super admin console. Four operator controls went with it --
  // which service does the talking, which model, which voice, and which assistant every spoken turn goes
  // to -- and only two customer rows replaced them. The relay never stopped accepting those four writes,
  // so for a day the only way to change the voice service was to edit a file on the server, which is
  // exactly the hand operation the product is not allowed to need.
  //
  // They come back as ROWS on the settings surface's own registry, in the Operator section's Talking
  // group, `operatorOnly`, so a customer never sees them. They carry the SAME four attributes the old
  // card carried -- data-voice-vendor, data-voice-model, data-voice-voice, data-voice-agent -- so the
  // gate's existing selectors measure the real thing rather than a new name for it.
  //
  // THEY CARRY NO data-settings-action, on purpose. The surface's act() has no default branch: an action
  // it does not know is swallowed with no error and no toast, which is a control that looks wired and is
  // not. So each one wires its own listener inside fill(), idempotently, which is the precedent
  // push-settings.js set with its own bind().
  //
  // AND THE DOOR BEHIND THEM IS SHUT THE SAME WAY: ui/voice-edge.mjs refuses all four from a workspace
  // that is not the operator's, in words. A client-side gate is not a gate -- these four are billed to
  // his key.
  const TALKING_ROWS = [
    {
      id: "voice-service", order: 10, label: "Service",
      line: "Which service does the talking. The two are billed differently.",
      // The labels come off the route and name no vendor: "flat rate for each minute you talk" and
      // "charged by how much is said, not by the minute". That is a billing shape and not a comparison.
      control: () => `<div class="setting-control"><select aria-label="Service" data-voice-vendor></select></div>`,
    },
    {
      id: "voice-model", order: 20, label: "Model",
      line: "Leave it empty and the service uses its own.",
      control: () => `<div class="setting-control setting-control-field">`
        + `<input type="text" autocomplete="off" placeholder="The service's own" aria-label="Model" data-voice-model data-settings-value />`
        + `<button class="ghost-button" type="button" data-voice-save="model">Save</button></div>`,
    },
    {
      id: "voice-voice", order: 30, label: "Voice",
      line: "The voice it answers in. Leave it empty and the service uses its own.",
      control: () => `<div class="setting-control setting-control-field">`
        + `<input type="text" autocomplete="off" placeholder="The service's own" aria-label="Voice" data-voice-voice data-settings-value />`
        + `<button class="ghost-button" type="button" data-voice-save="voice">Save</button></div>`,
    },
    {
      id: "voice-agent", order: 40, label: "Who you are talking to",
      line: "The head of your team, normally. Everything you say goes to this one assistant.",
      control: () => `<div class="setting-control"><select aria-label="Who you are talking to" data-voice-agent></select></div>`,
    },
  ];

  // What an empty agentId means, said out loud on the control rather than left as a blank option
  // nobody can read. The relay works it out and prints which one it chose.
  const ANY_AGENT = "Whoever is leading the team";

  const escapeForRow = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // ONE read for the four rows, not four. Every contributed row's fill() runs on every paint of its
  // section, so four rows asking the door themselves would be four requests per paint. The answer is
  // held for three seconds, which covers one paint and the repaint the settings surface fires when its
  // facts land, and a save replaces it with what the door answered.
  let talkingAsk = null;
  let talkingAskAt = 0;
  function talkingSettings(force = false) {
    const nowMs = Date.now();
    if (!force && talkingAsk != null && nowMs - talkingAskAt < 3000) return talkingAsk;
    talkingAskAt = nowMs;
    talkingAsk = readSettings().then((answer) => { state.settings = answer; return answer; }).catch(() => null);
    return talkingAsk;
  }

  /**
   * The values, from the door's own answer.
   *
   * A TEXT FIELD SOMEBODY IS TYPING IN IS LEFT ALONE, because a repaint landing mid-word would take the
   * half-typed value out of their hands -- the same failure the settings surface's own keep rule exists
   * to stop. A select is different: its value is one of a fixed set and the door's answer is the truth
   * about which, so it is always written.
   */
  function paintTalking(root, settings) {
    if (root == null || settings == null) return;
    const focused = global.document?.activeElement ?? null;
    const vendor = root.querySelector("[data-voice-vendor]");
    if (vendor != null) {
      const options = (Array.isArray(settings.vendors) ? settings.vendors : []).map((one) =>
        `<option value="${escapeForRow(one.id)}"${one.id === settings.vendor ? " selected" : ""}>${escapeForRow(one.label)}</option>`).join("");
      if (options.length > 0) { vendor.innerHTML = options; vendor.value = String(settings.vendor ?? ""); }
    }
    const agent = root.querySelector("[data-voice-agent]");
    if (agent != null) {
      const rows = [{ id: "", name: ANY_AGENT }, ...agentChoices(settings)];
      agent.innerHTML = rows.map((one) =>
        `<option value="${escapeForRow(one.id)}"${String(one.id) === String(settings.agentId ?? "") ? " selected" : ""}>${escapeForRow(one.name)}</option>`).join("");
      agent.value = String(settings.agentId ?? "");
    }
    for (const [selector, field] of [["[data-voice-model]", "model"], ["[data-voice-voice]", "voice"]]) {
      const node = root.querySelector(selector);
      if (node == null || node === focused) continue;
      node.value = String(settings[field] ?? "");
    }
  }

  /**
   * A save, and then the door's own answer back into the controls -- never what was typed. A field the
   * relay refused or trimmed has to show what it really is, which is the KEYS-1 rule about a 200 that
   * quietly drops a field, read from the other side.
   */
  async function saveTalking(patch, root) {
    const say = (words) => { try { global.__mrUi?.showToast?.(words); } catch { /* a toast is not the save */ } };
    try {
      const saved = await writeSettings(patch);
      if (saved != null) {
        state.settings = saved;
        talkingAsk = Promise.resolve(saved);
        talkingAskAt = Date.now();
        paintTalking(root, saved);
      }
      say("Saved.");
    } catch (error) {
      say(`That was not saved: ${error?.message ?? error}`);
      const answer = await talkingSettings(true);
      if (answer != null) paintTalking(root, answer);
    }
  }

  function wireTalking(root) {
    const once = (node, type, handler) => {
      if (node == null || node.dataset.voiceWired === "1") return;
      node.dataset.voiceWired = "1";
      node.addEventListener(type, handler);
    };
    once(root.querySelector("[data-voice-vendor]"), "change", (event) => void saveTalking({ vendor: event.target.value }, root));
    once(root.querySelector("[data-voice-agent]"), "change", (event) => void saveTalking({ agentId: event.target.value }, root));
    for (const button of root.querySelectorAll("[data-voice-save]")) {
      once(button, "click", (event) => {
        const which = event.currentTarget.dataset.voiceSave === "model" ? "model" : "voice";
        const field = root.querySelector(which === "model" ? "[data-voice-model]" : "[data-voice-voice]");
        void saveTalking({ [which]: String(field?.value ?? "").trim() }, root);
      });
    }
  }

  /** Called with the painted body of the section these rows are on, after every paint of it. */
  function fillTalking(root) {
    if (root == null || typeof root.querySelector !== "function") return;
    const mine = root.querySelector("[data-voice-vendor], [data-voice-model], [data-voice-voice], [data-voice-agent]");
    if (mine == null) return;
    wireTalking(root);
    void talkingSettings().then((answer) => { if (answer != null) paintTalking(root, answer); });
  }

  /**
   * Registered from boot() and not at load: index.html serves voice.js before settings.js, so
   * window.__mrSettings does not exist while this file's own IIFE is running. It does by
   * DOMContentLoaded, which is when boot() runs.
   *
   * ONCE, AND THE FLAG IS SET BEFORE THE FIRST register(). register() repaints the section when that
   * section is the one on screen, and a repaint dispatches the surface's own section event -- which is
   * what a console that served the two files in the other order registers on. Without the flag first
   * that is a loop through this function four levels deep for no gain.
   */
  let talkingRegistered = false;
  function registerTalkingRows() {
    if (talkingRegistered) return true;
    const surface = global.__mrSettings;
    if (surface == null || typeof surface.register !== "function") return false;
    talkingRegistered = true;
    let ok = true;
    for (const row of TALKING_ROWS) {
      const drawn = surface.register({
        id: row.id,
        section: "operator",
        group: "talking",
        order: row.order,
        operatorOnly: true,
        markup: () => `<div><strong>${escapeForRow(row.label)}</strong><small>${escapeForRow(row.line)}</small></div>${row.control()}`,
        fill: fillTalking,
      });
      ok = drawn === true && ok;
    }
    return ok;
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
    // VOICE-7. A CLICK IS THE ALWAYS-LISTENING PRESS AND NOTHING ELSE. In push to talk the hold has
    // already been handled by pointerdown and pointerup, and the click that follows them must not
    // toggle a second time on top of it.
    document_.addEventListener("click", (event) => {
      const talk = event.target?.closest?.("[data-voice-talk]");
      if (talk != null) { event.preventDefault(); if (talkMode() !== "push") toggle(); return; }
      if (event.target?.closest?.("[data-voice-open-settings]") != null) { event.preventDefault(); openSettings(); }
    });
    // ---------------------------------------------------------- VOICE-7: press and hold
    //
    // The RELEASE listens on the document rather than on the button, because a thumb that slides off a
    // 38 px circle before it lifts would otherwise never end the turn and would leave a microphone
    // open with the button drawn as though it were not.
    // The release ends the hold AND spends the gesture: a press that only cleared a standing refusal
    // never set `held`, so without this the flag would outlive its own gesture.
    const release = () => { const wasHeld = state.held; pressDone(); if (wasHeld) void talkUp(); };
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
    // the preventDefault here is the one that stops a long press becoming the selection callout.
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
    document_.addEventListener("keydown", onKeyDown);
    document_.addEventListener("keyup", onKeyUp);
    // A window that loses focus never delivers the keyup for a space bar that is still down, and a
    // pointer released outside the window never delivers its up either. Both leave a microphone open.
    global.addEventListener?.("blur", release);
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
        // paint() mounts the line and then fills it, and every write it makes -- text AND attributes,
        // `hidden` included -- is guarded on a change, so putting it here cannot chase its own
        // mutation round the loop. The attribute half of that was NOT true until VOICE-11: five nodes
        // were rewritten once per wake with the values they already held, and only the debounce above
        // kept it off the loop it describes.
        paint();
        // The panel lives in .conversation-space, which app.js never rebuilds -- but the space itself
        // is not on screen until the console has booted, so it is mounted here rather than once.
        mountOverlay();
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
    let available = true;
    // The moment this read was ASKED at, carried down to the adopt so a press made while it was in the
    // air wins. docs/VOICE.md 13.
    const askedAt = clockNow();
    try {
      const response = await relayFetch("/voice/settings", { headers: { accept: "application/json" } });
      available = response.status !== 404;
      if (response.ok) {
        state.settings = await response.json().catch(() => null);
        // VOICE-10. The person's own talk mode, adopted HERE rather than read on its own: boot already
        // asks this door, and a second request for one field is a second chance for the two answers to
        // disagree about the same thing. Absent -- an older relay, or a person who has never chosen --
        // leaves this browser's stored value as the behaviour, which boot() already applied.
        adoptTalkMode(state.settings?.talkMode, askedAt);
      }
    } catch {
      // A relay that did not answer at all may answer in a second. Leaving the button live is the
      // choice that lets the person find out in words rather than looking at a dead control.
      available = true;
    }
    if (button == null) return;
    state.available = available;
    button.disabled = !available;
    if (!available) button.title = "This workspace is on an older relay that cannot talk yet.";
    else button.removeAttribute("title");
  }

  function boot() {
    // BEFORE THE FIRST PAINT. The button is live the moment the console draws, and a person whose
    // choice is "always listening" must not get one hold's worth of the other behaviour while a
    // settings surface they have not opened catches up.
    state.talkMode = readStoredTalkMode();
    paint();
    mountOverlay();
    wire();
    observe();
    // VOICE-8. The operator's four rows, onto the settings surface's own registry. Here rather than at
    // load, because index.html serves this file before settings.js.
    //
    // AND IF THAT SURFACE IS NOT THERE YET, on the event it already dispatches when it paints a section
    // -- not on a timer. A module that polls is a module that keeps a test's process open and a phone's
    // radio awake for a row nobody is looking at, and a console that never serves the surface has no
    // section to put these rows on anyway.
    if (!registerTalkingRows()) {
      const late = () => {
        global.document?.removeEventListener?.("titanbot:settings-section", late);
        if (!registerTalkingRows()) global.document?.addEventListener?.("titanbot:settings-section", late);
      };
      global.document?.addEventListener?.("titanbot:settings-section", late);
    }
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
    get supportsMicChoice() { return supportsMicChoice(); },
    micDeviceId: getMicDeviceId,
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
      lastSaid: state.lastSaid,
      mutedFrames: state.capture?.stats.mutedFrames ?? 0,
      // VOICE-11. The zero-filled frames the release sent, counted apart from the microphone's own so
      // one number cannot be read as the other, and the blocks the worklet posted, which is the only
      // honest answer to "is this microphone producing anything at all".
      tailFrames: state.tailFrames,
      blocks: state.capture?.stats.blocks ?? 0,
      // VOICE-7. What the panel is showing right now, the words it last confirmed, and the id of the
      // row those words became -- which is what lets a gate prove the panel's last words and the chat
      // line are the same bytes without reading the DOM twice.
      overlay: { open: state.heard.open, text: state.heard.text, phase: state.heard.phase, turn: state.heard.turn },
      lastHeard: state.lastHeard,
      lastNonce: state.lastNonce,
      talkMode: talkMode(),
      held: state.held,
      talking: state.talking,
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
    // VOICE-7. The panel, the two modes, and the one door the settings row calls.
    talkMode,
    // VOICE-8. The operator's four rows, so a gate can assert they registered and a unit case can read
    // their words without a browser.
    _TALKING_ROWS: TALKING_ROWS,
    _ANY_AGENT: ANY_AGENT,
    _registerTalkingRows: registerTalkingRows,
    _fillTalking: fillTalking,
    _paintTalking: paintTalking,
    _saveTalking: saveTalking,
    // VOICE-10. The door that takes a value the person did not press for, and the one that does.
    _adoptTalkMode: adoptTalkMode,
    // The same reader under the name docs/APPS.md gives the desktop shell's hotkey contract. One
    // function, two names, rather than two readers that could disagree.
    getTalkMode: talkMode,
    setTalkMode,
    talkDown,
    talkUp,
    _TALK_MODES: TALK_MODES,
    _TALK_MODE_DEFAULT: TALK_MODE_DEFAULT,
    _TALK_MODE_KEY: TALK_MODE_KEY,
    _PUSH_IDLE_CLOSE_MS: PUSH_IDLE_CLOSE_MS,
    _PENDING_FRAME_CAP: PENDING_FRAME_CAP,
    // VOICE-11. The release's own numbers, the two windows around a press, and the classifier that
    // decides which of the three microphone sentences a person reads.
    _RELEASE_TAIL_MS: RELEASE_TAIL_MS,
    _FRAME_MS: FRAME_MS,
    _TAIL_FRAMES: TAIL_FRAMES,
    _MIN_HOLD_MS: MIN_HOLD_MS,
    _MAX_HOLD_MS: MAX_HOLD_MS,
    _REARM_COOLDOWN_MS: REARM_COOLDOWN_MS,
    _GESTURE_MS: GESTURE_MS,
    _SOUND_WATCH_MS: SOUND_WATCH_MS,
    _SHELL_NOTES: SHELL_NOTES,
    _micConditionFor: micConditionFor,
    _OVERLAY_ID: OVERLAY_ID,
    _DISSOLVE_MS: DISSOLVE_MS,
    _HEARD_STALE_MS: HEARD_STALE_MS,
    _LISTENING_WORD: LISTENING_WORD,
    _overlayMarkup: overlayMarkup,
    _mountOverlay: mountOverlay,
    _closeOverlay: closeOverlay,
    _spaceMayTalk: spaceMayTalk,
    _escapeStops: escapeStops,
    _onKeyUp: onKeyUp,
  };

  if (global.document != null) {
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window === "undefined" ? globalThis : window);
