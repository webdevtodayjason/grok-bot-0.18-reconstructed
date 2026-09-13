// VOICE-1 — the console's side: the button, the orb, the notes, and the spoken chip.
//
// THE CHIP IS SLICED OUT OF THE LIVE FILES, never copied, the way tests/machine-room-mail-chip.test.mjs
// slices the mail row: "a copy would go on passing after the console changed, which on a promise
// about what a customer sees is worse than no test at all." The two lines this wave puts in other
// people's files are one in gateway-adapter.js and one in app.js, and both are read off disk here.
//
// WHY THE CHIP RIDES THE NONCE AND NOT PAGE STATE. app.js rebuilds the whole transcript on every
// render and there is no render-complete event, so nothing voice.js remembers could survive a
// repaint -- let alone a reload on another device. The host round-trips clientNonce verbatim onto the
// durable user entry (send-message-shaping.ts:99-101), so a "voice:" prefix is the only mark that
// does survive. The simulated wholesale re-render below is that claim, tested.
//
// WHY THE SENTENCES ARE PINNED ONE BY ONE. Six conditions can stop a spoken turn and every one of
// them used to be silence, which is the whole of UX-ERR-1: "it popped up like he was talking, then
// it went away. I don't see any errors." And none of the six may be dressed as a failure --
// host-notes-read-as-errors.md: a host line that looks like a stack trace gets read as one.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");
const GATE_AGENT = "titanbot-gate/machine-room-voice.test.mjs";

// ------------------------------------------------------------------ loading the module
//
// A classic script on a window global. Handed a fake window with a document that answers nothing,
// which is what lets the message and close handlers be driven with no DOM at all: paint() asks for
// the talk button and the strip, gets null for both, and does nothing.
// PRE-EXISTING, FOUND WHILE BUILDING VOICE-8/VOICE-10 AND FIXED HERE RATHER THAN WALKED PAST.
//
// `node --test tests/machine-room-voice.test.mjs` passed every case and then NEVER EXITED -- measured
// at the shared tip before any of this wave's edits: 53 ok, 0 not ok, no totals line, killed at 90 s.
// Every test that opens a line arms voice.js's own `heldTimer` -- a 2 s setInterval that reports dropped
// frames to the relay and is cleared only by stop() -- and a test that leaves the line up leaves that
// interval armed on the real `setInterval` the fake window is handed. `npm test` is one process over
// every suite (package.json, and tests/index.js imports them all), so one leaked interval here is the
// whole suite never exiting.
//
// The fix is the file's own: each module it loads is remembered, and one `after` hook ends them all.
// stop() is the module's single door for that and it is what a browser tab closing would do.
const LOADED = [];
after(() => {
  for (const one of LOADED) {
    try { one.stop(); } catch { /* a module with no page to paint is not a failure here */ }
  }
  LOADED.length = 0;
});

async function loadVoice(options = {}) {
  const source = await read("ui/machine-room/voice.js");
  const listeners = new Map();
  const fake = {
    ArrayBuffer,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { protocol: "https:", host: "console.example" },
    fetch: options.fetch ?? (async () => ({ ok: false, status: 404, json: async () => null })),
    document: {
      readyState: "complete",
      body: null,
      querySelector: () => null,
      getElementById: () => null,
      addEventListener: (name, fn) => { listeners.set(name, fn); },
    },
    addEventListener: () => {},
    ...options.window,
  };
  new Function("window", source)(fake);
  if (fake.__voice != null) LOADED.push(fake.__voice);
  return { voice: fake.__voice, fake, listeners };
}

const frame = (voice, object) => voice._onMessage({ data: JSON.stringify(object) });

// ------------------------------------------------------------------ the spoken chip
//
// Two slices. One line out of messagesOf's returned object, and one expression out of the
// messageMarkup return. Neither is retyped, so a change to either file fails here.
async function loadChip() {
  const adapter = await read("ui/machine-room/gateway-adapter.js");
  const app = await read("ui/machine-room/app.js");

  const spokenLine = adapter.split("\n").find((line) => line.includes('e.clientNonce.startsWith("voice:")'));
  assert.ok(spokenLine != null, "the adapter no longer lifts a voice nonce onto the message");
  const spreadOf = new Function("e", `return { ${spokenLine.trim().replace(/,\s*$/, "")} };`);

  const start = app.indexOf("${message.spoken ?");
  assert.ok(start >= 0, "app.js no longer draws the spoken chip");
  const end = app.indexOf(': ""}', start);
  assert.ok(end > start, "the chip expression in app.js is not shaped the way this test slices it");
  const expression = app.slice(start + 2, end + ': ""'.length);
  const chipOf = new Function("message", `return ${expression};`);

  return { spreadOf, chipOf, app, adapter };
}

test("VOICE-1 chip: a voice nonce draws the chip and an ordinary one does not", async () => {
  const { spreadOf, chipOf } = await loadChip();
  assert.deepEqual(spreadOf({ clientNonce: "voice:1757400000000" }), { spoken: true });
  // Every other sender this console has. None of them may pick the chip up.
  for (const nonce of ["mr-1757400000000-abc", "mail:42", "", undefined, null, 7, { voice: true }]) {
    assert.deepEqual(spreadOf({ clientNonce: nonce }), {}, `${JSON.stringify(nonce)} is not a spoken turn`);
  }
  const spoken = chipOf({ spoken: true });
  assert.match(spoken, /voice-spoken-chip/);
  assert.match(spoken, /Spoken/);
  assert.equal(chipOf({}), "", "a typed row carries no chip at all, not an empty span");
  assert.equal(chipOf({ spoken: false }), "");
});

test("VOICE-1 chip: it is re-derived from the entry, so a wholesale re-render puts it back", async () => {
  const { spreadOf, chipOf } = await loadChip();
  // The transcript entry as it comes back from the host after a reload: the nonce is on it, and
  // nothing in the page remembers anything.
  const entry = { id: "e1", clientNonce: "voice:1757400000000", content: "what is the team working on" };
  const first = chipOf({ ...spreadOf(entry) });
  // app.js's renderAll throws the whole transcript away and builds it again from the same entries.
  const second = chipOf({ ...spreadOf(entry) });
  assert.equal(first, second);
  assert.match(second, /voice-spoken-chip/, "the chip is back after the repaint, because it was never page state");
});

test("VOICE-1 chip: it lands inside the message block, beside the evidence chip", async () => {
  const { app } = await loadChip();
  const line = app.split("\n").find((one) => one.includes("voice-spoken-chip"));
  assert.ok(line.includes("evidenceChipMarkup(message)"),
    "the chip sits next to the evidence chip inside the message block, not loose in the row");
  // One line, which is the whole of this wave's claim on app.js.
  assert.equal(app.split("\n").filter((one) => one.includes("voice-spoken-chip")).length, 1,
    "exactly one line of app.js belongs to this wave");
  assert.equal(app.split("\n").filter((one) => one.includes("__voice")).length, 0,
    "and app.js never calls voice.js; the module finds its own hosts");
});

// ------------------------------------------------------------------ the orb
test("VOICE-1 orb: the four relay states map to the four orb states and nothing else", async () => {
  const { voice } = await loadVoice();
  assert.deepEqual(voice._ORB_STATES, ["off", "listening", "thinking", "speaking"]);
  for (const value of voice._ORB_STATES) assert.equal(voice._orbStateFor(value), value);
  // Anything else is ignored rather than guessed at. A wrong orb is worse than a still one, and a
  // relay a version ahead of this page will say things this page does not know.
  for (const value of ["Listening", "busy", "error", "", null, undefined, 3, {}, "speaking "]) {
    assert.equal(voice._orbStateFor(value), null, `${JSON.stringify(value)} must not move the orb`);
  }
});

test("VOICE-1 orb: a state frame moves it and an unknown one leaves it exactly where it was", async () => {
  const { voice } = await loadVoice();
  frame(voice, { t: "state", value: "listening" });
  assert.equal(voice._state.orb, "listening");
  frame(voice, { t: "state", value: "thinking" });
  assert.equal(voice._state.orb, "thinking");
  frame(voice, { t: "state", value: "transcribing" });
  assert.equal(voice._state.orb, "thinking", "an unknown word left it alone");
  frame(voice, { t: "state", value: "speaking" });
  assert.equal(voice._state.orb, "speaking");
});

// ------------------------------------------------------------------ the notes
test("VOICE-2 notes: a note is ONE capped line, never a row beside the composer", async () => {
  const { voice } = await loadVoice();
  frame(voice, { t: "state", value: "listening" });
  frame(voice, { t: "note", text: "Your agent is still reading. One moment." });
  assert.equal(voice._state.notes.length, 1);
  assert.equal(voice._state.orb, "listening", "a note is not a state; it may never move the orb");
  const line = voice._lineFor(voice._state.notes);
  assert.equal(line.text, "Your agent is still reading. One moment.");
  assert.equal(line.action, null, "this one leads nowhere, so it is a status and not a control");
  const markup = voice._lineMarkup();
  // Jason's screenshot of 2026-09-10 is a picture of the thing this assertion forbids: a wide grey
  // message bubble beside the message box, taking a column of the footer's grid.
  assert.doesNotMatch(markup, /message-row|message-bubble|is-turn-failed/,
    "the live half is a line in the composer's own row, not a bubble in the footer");
  // Detail-less on purpose: an expander here would put a machine's innards beside a conversation.
  assert.doesNotMatch(markup, /<details|<pre|<summary/);
  // Two children, exactly one shown, and both start hidden so an empty line cannot flash on load.
  assert.match(markup, /data-voice-line-say[^>]*hidden/);
  assert.match(markup, /data-voice-line-do[^>]*hidden/);
  assert.match(markup, /<span class="voice-line" id="voice-line" data-voice-line hidden>/);
  // A frame with nothing to say paints nothing rather than an empty row.
  voice._state.notes = [];
  frame(voice, { t: "note", text: "   " });
  assert.equal(voice._state.notes.length, 0);
});

test("VOICE-7: the line is refusals and NOTHING ELSE, so no ordinary turn can move the footer", async () => {
  const { voice } = await loadVoice();
  // It used to take a live caption too, and the agent's reply was written into it on every spoken
  // turn. MEASURED on this Mac in real Chrome, a reply in that line took #message-input 370.05 to
  // 215.31 px at 1440x900 and .control-shelf 390x133 at y711 to 390x158 at y686 at 390x844, and it
  // stood there for the rest of the call because only a start or a stop ever cleared it.
  assert.deepEqual(voice._lineFor([]), { text: "", action: null }, "nothing is wrong, so the footer says nothing");
  assert.equal(voice._lineFor.length, 1, "the line takes notes and nothing else now");
  const note = voice._lineFor([{ condition: "no-key" }]);
  assert.equal(note.text, voice._NOTES["no-key"], "a refusal is the one thing that reaches the footer");
  assert.equal(note.action, "Open settings");

  // And the reply frame paints nothing at all: it is already a row in the transcript and already
  // spoken out loud, and while the agent talks the orb on the button is the only sign.
  frame(voice, { t: "said", text: "I have asked him and he is on it." });
  assert.equal(voice._lineFor(voice._state.notes).text, "", "the agent's reply reached the footer");
  assert.equal(voice.stats().lastSaid, "I have asked him and he is on it.", "the gate can still read what he said");
  const source = await read("ui/machine-room/voice.js");
  assert.doesNotMatch(source, /case "said":\s*\n\s*caption\(/, "the reply is being painted into the footer again");
});

test("VOICE-1 notes: each condition produces its own plain sentence", async () => {
  const { voice } = await loadVoice();
  // VOICE-11 added four. Three of them split one shipped sentence that told a device with no
  // microphone at all to allow one, and the fourth is what a tap reads on a control whose whole
  // instruction is to hold it. The list is still exhaustive, because a condition with no sentence is
  // silence, which is the whole of UX-ERR-1.
  const conditions = ["no-microphone", "no-key", "day-cap", "session-cap", "box-not-running", "line-dropped",
    "no-microphone-device", "no-recording", "no-sound", "hold-to-talk"];
  assert.deepEqual(Object.keys(voice._NOTES).sort(), [...conditions].sort(), "every condition has a sentence, no more and no fewer");
  for (const condition of conditions) {
    voice._state.notes = [];
    voice.stop(condition);
    assert.equal(voice._state.notes.length, 1, `${condition} left the person with nothing to read`);
    assert.equal(voice._state.notes[0].condition, condition);
    const sentence = voice._sentenceFor(condition);
    assert.ok(sentence.length > 20, `${condition}: "${sentence}" is not a sentence`);
    assert.match(sentence, /[.!]$/, `${condition}: a sentence ends`);
    assert.equal(voice._lineFor([{ condition }]).text, sentence, `${condition}: the line says it`);
    // No vendor, no tool name, no machine's noun. These are the words a business owner reads.
    for (const leak of ["xai", "x\\.ai", "openai", "grok", "realtime", "websocket", "socket", "titan\\(", "sendPrompt",
      "function_call", "session\\.update", "pcm", "api", "token", "4001", "upgrade"]) {
      assert.doesNotMatch(sentence, new RegExp(leak, "i"), `${condition}: "${leak}" reached the page`);
    }
  }
  // And exactly one of them leads somewhere, because "nothing is set up yet" is the one condition a
  // person can fix from this page.
  assert.deepEqual(Object.keys(voice._NOTE_ACTIONS), ["no-key"]);
  assert.equal(voice._lineFor([{ condition: "no-key" }]).action, "Open settings");
  assert.equal(voice._lineFor([{ condition: "line-dropped" }]).action, null);
  assert.match(voice._lineMarkup(), /data-voice-open-settings/, "and the control that leads there exists");

  // VOICE-2, AND THIS IS THE SENTENCE JASON READ. The shipped one ended "Add one on the Voice card in
  // Settings and press the button again", which instructed the loop he got stuck in: the press that
  // produces this line cannot succeed, so a second press only produces it again. The relay says the
  // same string (ui/voice-edge.mjs), so retitleNote cannot put two wordings on one row.
  assert.equal(voice._NOTES["no-key"], "Voice is not switched on for this workspace yet.");
  for (const condition of conditions) {
    if (voice._NOTE_ACTIONS[condition] == null) continue;
    assert.doesNotMatch(voice._NOTES[condition], /press .*again/i,
      `${condition}: a sentence a person cannot act on must not tell them to press the button again`);
  }
});

test("VOICE-1 notes: the relay's own sentence wins, and the close only names the condition", async () => {
  const { voice } = await loadVoice();
  // The refusal the design pins: accept the upgrade, say one sentence, say bye, close 1000.
  frame(voice, { t: "note", reason: "no-key", text: "Talking is not set up for this workspace yet." });
  frame(voice, { t: "bye", reason: "no-key" });
  voice._onClose({ code: 1000, reason: "" });
  assert.equal(voice._state.notes.length, 1, "one row, not the relay's sentence and then ours");
  assert.equal(voice._state.notes[0].text, "Talking is not set up for this workspace yet.");
  assert.equal(voice._state.notes[0].condition, "no-key", "so the line still leads where it fixes it");
  assert.equal(voice._lineFor(voice._state.notes).action, "Open settings");
});

test("VOICE-1 notes: the relay's reason outranks the page's, so the way forward is not taken away", async () => {
  const { voice } = await loadVoice();
  voice._state.on = true;
  // MEASURED ON THE R750 2026-09-10, in real Chrome with no microphone permission on a workspace with
  // no realtime key. The relay refused the line and said so, drawing the one control that leads
  // anywhere; then the microphone failed and the page retitled the SAME row "no-microphone". The
  // person was left reading "add a key on the Voice card" with no way to open it, under a heading that
  // named the wrong cause. The relay knows why the line did not open; this page only knows about its
  // own microphone, and once the line was already refused that is the lesser fact.
  frame(voice, { t: "note", reason: "no-key", text: "This workspace has no realtime voice key yet." });
  frame(voice, { t: "bye", reason: "no-key" });
  voice.stop("no-microphone");
  assert.equal(voice._state.notes.length, 1, "still one row");
  assert.equal(voice._state.notes[0].condition, "no-key", "and it still names what the relay said");
  assert.equal(voice._state.notes[0].text, "This workspace has no realtime voice key yet.");
  assert.equal(voice._lineFor(voice._state.notes).action, "Open settings",
    "so the way into the row that fixes it is still there");

  // The other way round is NOT blocked: with nothing from the relay, the page's own microphone
  // condition is the only thing anybody knows, and it must still be said.
  const { voice: second } = await loadVoice();
  second._state.on = true;
  second.stop("no-microphone");
  assert.equal(second._state.notes[0].condition, "no-microphone");
  assert.match(second._sentenceFor("no-microphone"), /microphone/i);
});

test("VOICE-1 docs: every sentence docs/VOICE.md quotes is a sentence the code really says", async () => {
  // The document promised nine sentences a person would read and the code said nine different ones,
  // because nothing compared them. A quoted sentence that has drifted is worse than no quote: it is
  // what somebody answering a support question will read out. Whitespace is normalised because the
  // document wraps its lines and the code does not, and a sentence carrying a value is written as a
  // template in the document and matched on its two halves.
  const norm = (text) => String(text).replace(/\s+/g, " ").trim();
  const doc = await readFile(path.join(repoRoot, "docs", "VOICE.md"), "utf8");
  const code = norm(
    `${await readFile(path.join(repoRoot, "ui", "voice-edge.mjs"), "utf8")} `
    + `${await readFile(path.join(repoRoot, "ui", "machine-room", "voice.js"), "utf8")}`,
  );
  const quoted = [...doc.matchAll(/\*\*"([^"]{25,})"\*\*/g)].map((m) => norm(m[1]));
  assert.ok(quoted.length >= 10, `docs/VOICE.md quotes only ${quoted.length} sentences; section 12 lists more than that`);
  for (const sentence of quoted) {
    const halves = sentence.split("...").map((half) => half.trim()).filter((half) => half.length > 12);
    for (const half of halves) {
      assert.ok(code.includes(half),
        `docs/VOICE.md quotes "${half}" but no line of ui/voice-edge.mjs or ui/machine-room/voice.js says it`);
    }
  }
});

test("VOICE-1 notes: a 4003 close paints its own reason, not a generic failure", async () => {
  // A close only means anything on a live session, which is the precondition the guard in onClose
  // enforces -- so each case here arms one first.
  const live = async () => { const one = await loadVoice(); one.voice._state.on = true; return one.voice; };

  const voice = await live();
  voice._onClose({ code: 4003, reason: "That call reached thirty minutes. Press Talk to start another." });
  assert.equal(voice._state.notes[0].condition, "session-cap");
  assert.equal(voice._state.notes[0].text, "That call reached thirty minutes. Press Talk to start another.");
  assert.match(voice._lineFor(voice._state.notes).text, /thirty minutes/,
    "the relay's words are what the person reads");
  // The private range is a table, so a code this page does not know still says something true.
  assert.deepEqual(voice._CLOSE_CONDITIONS, { 4001: "no-key", 4002: "day-cap", 4003: "session-cap", 4004: "box-not-running" });

  const unknown = await live();
  unknown._onClose({ code: 4099, reason: "" });
  assert.equal(unknown._state.notes[0].condition, "line-dropped");

  const dropped = await live();
  dropped._onClose({ code: 1006, reason: "" });
  assert.equal(dropped._state.notes[0].condition, "line-dropped", "a line that went away without saying why");

  const stopped = await live();
  stopped._onClose({ code: 1000, reason: "stopped" });
  assert.equal(stopped._state.notes.length, 0, "pressing stop is not a note");

  // And the regression the browser leg found: a close arriving AFTER the session is already off has
  // nothing left to say, and must not replace a sentence that was already put in front of the person.
  const settled = await live();
  settled.stop("no-key");
  assert.equal(settled._state.on, false);
  settled._onClose({ code: 1006, reason: "" });
  assert.equal(settled._state.notes[0].condition, "no-key",
    "a trailing close overwrote the useful sentence with one that leads nowhere");
});

test("VOICE-1: the microphone being refused is one plain sentence, not a thrown error", async () => {
  // The real path: the socket comes up, the browser refuses the microphone, and the person reads a
  // sentence. Nothing throws out of start().
  let sent = 0;
  class FakeSocket {
    constructor() { this.readyState = 1; this.handlers = {}; setTimeout(() => this.handlers.open?.({}), 0); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    send() { sent += 1; }
    close() { this.readyState = 3; }
  }
  const { voice } = await loadVoice({
    window: {
      __voiceSocketClass: FakeSocket,
      AudioContext: class { constructor() { this.audioWorklet = { addModule: async () => {} }; } },
      AudioWorkletNode: class { constructor() { this.port = {}; } },
      Blob: class {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
      navigator: { mediaDevices: { getUserMedia: async () => { throw new Error("NotAllowedError"); } } },
    },
  });
  await voice.start();
  assert.equal(voice._state.on, false, "a refused microphone ends the session rather than half-opening it");
  assert.equal(voice._state.orb, "off");
  assert.equal(voice._state.notes[0].condition, "no-microphone");
  assert.match(voice._sentenceFor("no-microphone"), /microphone/i);
  assert.ok(sent >= 1, "and the relay was told to stop rather than left holding a line");
});

test("VOICE-1: a socket that errors with no close code still says something a person can act on", async () => {
  // THE EVENT ORDER HERE IS THE TEST. MEASURED in real Chrome against a refused upgrade: the socket
  // fires `error` and THEN `close` with code 1006. An earlier version of this fake fired only
  // `error`, passed, and shipped a bug only the browser leg found -- the trailing close replaced
  // "talking is not available yet", which carries the control that opens the card, with "the line
  // dropped", which leads nowhere. So the fake now does what the browser does.
  class DeadSocket {
    constructor() {
      this.readyState = 0;
      this.handlers = {};
      setTimeout(() => {
        this.handlers.error?.({});
        this.handlers.close?.({ code: 1006, reason: "" });
      }, 0);
    }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    send() {} close() {}
  }
  const { voice } = await loadVoice({ window: { __voiceSocketClass: DeadSocket } });
  await voice.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(voice._state.notes.length, 1, "one sentence, not one replaced by another");
  // MEASURED: an unknown upgrade path answers zero bytes with no status line and real Chrome reports
  // only onerror at 16 ms with no close code -- indistinguishable from the relay being down, which is
  // the void answer this console has already been burned by (handoff-screen-and-void-rpc.md).
  assert.equal(voice._state.notes[0].condition, "no-key");
  assert.match(voice._sentenceFor("no-key"), /not switched on/i);
  assert.equal(voice._lineFor(voice._state.notes).action, "Open settings", "and it leads somewhere");
});

// ------------------------------------------------------------------ VOICE-2: the way out
//
// Talk mode used to be a room with no door. These three legs are the door, and each names the
// measurement that found the room.
test("VOICE-2 leaving: a second press leaves the mode instead of redialling into the same refusal", async () => {
  const { voice } = await loadVoice();
  // The state a person is really in when they press again: the relay refused, so `on` is ALREADY
  // false and a note is on screen. toggle() read only `on`, so the second press called start() and
  // produced the identical sentence -- and the sentence itself told them to press the button again.
  // MEASURED at 1440x900: the geometry after the second press was byte-identical to the first break.
  voice._state.on = true;
  voice.stop("no-key");
  assert.equal(voice._state.on, false);
  assert.equal(voice._state.notes.length, 1, "the sentence is up, which IS the mode");

  voice.toggle();
  assert.equal(voice._state.notes.length, 0, "the second press cleared the line");
  // start() would have set both of these on its first statement, so this is the dial that did not
  // happen rather than a stub that was not called.
  assert.equal(voice._state.on, false, "and did not dial again");
  assert.equal(voice._state.orb, "off");
  assert.equal(voice._dismissTimer(), null, "and took the pending dismiss with it");

  // AND A PRESS THAT STOPS A LIVE CALL LEAVES JUST AS CLEANLY. The relay sends advisory notes mid
  // call ("Your agent is still reading. One moment."); without this, one of those outlived the call
  // it was about and sat in the footer, which is the same room with no door in a quieter form.
  voice._state.on = true;
  frame(voice, { t: "note", text: "Your agent is still reading. One moment." });
  assert.equal(voice._state.notes.length, 1);
  voice.toggle();
  assert.equal(voice._state.on, false);
  assert.equal(voice._state.notes.length, 0, "an ordinary stop leaves nothing standing either");

  // But a stop that DOES carry a reason keeps it, because that sentence is the whole point of the
  // press: a refused line has to say so.
  voice._state.on = true;
  voice.stop("box-not-running");
  assert.equal(voice._state.notes[0].condition, "box-not-running");
  assert.ok(voice._dismissTimer() != null, "and it goes on its own clock rather than never");
});

test("VOICE-2 leaving: Escape leaves, and never steals the key from a dialog", async () => {
  const { voice, listeners } = await loadVoice();
  const escape = listeners.get("keydown");
  assert.equal(typeof escape, "function", "nothing listened for Escape at all before this");

  voice._state.on = true;
  voice.stop("no-key");
  assert.equal(voice._state.notes.length, 1);
  escape({ key: "Escape" });
  assert.equal(voice._state.notes.length, 0, "Escape cleared the line");

  // Any other key is not a way out, or typing an e would end a call.
  voice._state.notes = [{ condition: "no-key", text: "", fromRelay: false }];
  escape({ key: "e" });
  assert.equal(voice._state.notes.length, 1);

  // And with nothing up it does nothing at all, so it cannot swallow an Escape somebody else wanted.
  voice._state.notes = [];
  voice._state.on = false;
  escape({ key: "Escape" });

  // app.js:6802 already owns a document-level Escape for the drawer, and this console has native
  // <dialog>s -- the settings panel, onboarding, the report card. Stealing Escape from one of those
  // would read as a modal that will not close.
  const { voice: withDialog } = await loadVoice({
    window: {
      document: {
        readyState: "complete", body: null, getElementById: () => null,
        querySelector: (selector) => (selector === "dialog[open]" ? { open: true } : null),
        addEventListener: () => {},
      },
    },
  });
  withDialog._state.notes = [{ condition: "no-key", text: "", fromRelay: false }];
  withDialog._onKeyDown({ key: "Escape" });
  assert.equal(withDialog._state.notes.length, 1, "a dialog was open, so Escape belonged to it");
});

test("VOICE-2 leaving: the note takes itself away, and every way back in clears it first", async () => {
  // A fake clock, so this asserts the note really goes rather than waiting six seconds to find out.
  const armed = [];
  let cleared = 0;
  const { voice } = await loadVoice({
    window: {
      setTimeout: (fn, ms) => { armed.push({ fn, ms }); return { id: armed.length, unref() {} }; },
      clearTimeout: () => { cleared += 1; },
    },
  });
  assert.equal(voice._NOTE_DISMISS_MS, 6000, "about six seconds, which is long enough to read a line");
  assert.equal(voice._dismissTimer(), null);

  voice._state.on = true;
  voice.stop("line-dropped");
  assert.equal(armed.length, 1, "nothing ever cleared a note before this: it sat in the footer until a reload");
  assert.equal(armed[0].ms, 6000);
  assert.equal(voice._state.notes.length, 1, "and not one moment before its time");
  armed[0].fn();
  assert.equal(voice._state.notes.length, 0, "the line took itself away");
  assert.equal(voice._dismissTimer(), null);

  // Every way back into the mode cancels a pending one, or a note armed six seconds ago wipes a
  // fresh line. `ready` is the same clearNotes() start() calls on its way in.
  voice._state.on = true;
  voice.stop("no-key");
  assert.ok(voice._dismissTimer() != null);
  frame(voice, { t: "ready", session: "one" });
  assert.equal(voice._state.notes.length, 0);
  assert.equal(voice._dismissTimer(), null, "a line that really came up cleared the pending dismiss");
  assert.ok(cleared > 0, "and cleared it through the window's own clearTimeout");

  voice.stop();
  assert.equal(voice._dismissTimer(), null, "an ordinary stop with nothing to say arms nothing");
});

test("VOICE-2 leaving: the dismiss timer does not hold a process open", async () => {
  // tests/machine-room-voice.test.mjs calls stop() six times in a row a few legs above this one, and
  // stop() also fires from visibilitychange, pagehide and beforeunload. A referenced timer there
  // keeps a node test run alive for six seconds per call and keeps a page alive past its own unload.
  const { voice } = await loadVoice();
  voice._state.on = true;
  voice.stop("line-dropped");
  const timer = voice._dismissTimer();
  assert.ok(timer != null);
  assert.equal(typeof timer.unref, "function");
  assert.equal(timer.hasRef?.(), false, "the timer is unref'd");
  voice._state.on = true;
  voice.stop();
  assert.equal(voice._dismissTimer(), null);
});

// ------------------------------------------------------------------ VOICE-2: the card is gone
//
// A customer never sees a key field. The realtime key belongs to the operator and is pasted once at
// the admin console; the relay fetches it and never hands it back. So this file holds no paste
// control, no Save key, no Clear, and no vendor's product name -- and the four things item A's
// Settings rows read are what took its place.
test("VOICE-2 keys: the console's own side of talking has no key field left in it", async () => {
  const source = await read("ui/machine-room/voice.js");
  for (const gone of ["data-voice-key", 'type="password"', "Save key", "Paste your key"]) {
    assert.ok(!source.includes(gone),
      `${gone} is still in voice.js; a key a customer can paste is a key the product asked a customer for`);
  }
  // apiKeySet is a boolean about whether one exists somewhere, which is the only thing about a key
  // this file is allowed to know. apiKey, the value, may not appear at all.
  assert.doesNotMatch(source, /\bapiKey\b(?!Set)/,
    "voice.js names the key itself somewhere, which means it can still write one");
  // And the card's own container went with it, so nothing can mount one back by accident. The banned
  // string is the card's own CLASS -- `<section class="settings-section" data-voice>` is what it used to
  // be -- and not the bare words: since VOICE-8 this file listens for the settings surface's own
  // "titanbot:settings-section" event, which is the sanctioned seam backgrounds.js mounts on too, and a
  // ban on the substring would have forbidden the very thing that replaced the card.
  for (const gone of ["voiceCardMarkup", "mountCard", "openCard", 'class="settings-section"', ".settings-section"]) {
    assert.ok(!source.includes(gone), `${gone} is still in voice.js`);
  }
  const { voice } = await loadVoice();
  assert.equal(voice._voiceCardMarkup, undefined, "the card is not exported either");
  assert.equal(voice._stripMarkup, undefined, "and neither is the strip that broke the footer");
});

test("VOICE-2 seam: what item A's rows read is two booleans, so no vendor can reach a customer's row", async () => {
  // MEASURED on this Mac 2026-09-10 against the shipped card: the relay's settings answer prefilled
  // Model with a vendor's product id and the Service dropdown named a vendor, both on a customer's
  // own card. The seam is two booleans for exactly that reason -- there is no string on it a vendor
  // name could ride in on.
  const answer = {
    enabled: true, vendor: "xai", model: "grok-voice-latest", voice: "ember", agentId: "agent-1",
    apiKeySet: true, sessionCapSeconds: 1800, dayCapSeconds: 7200, dayUsedSeconds: 126,
    vendors: [{ id: "xai", label: "Billed by the minute you talk" }], agents: [{ id: "agent-1", name: "Titan" }],
  };
  const { voice } = await loadVoice({
    fetch: async () => ({ ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) }),
  });
  const settings = await voice.getSettings();
  // Two booleans and, when this workspace has a day cap, the two numbers the Usage row draws a bar
  // from. NOT A STRING AMONG THEM, which is the claim this test exists to make: there is nothing on
  // this seam a vendor name, a model id or a voice name could ride in on, so no customer row can
  // render one by accident.
  // VOICE-8 adds the third number: how long ONE call may run, which the old card said beside the day
  // pair and which nothing said after the card was replaced. It is a number like the other two, so
  // the claim this test makes is unchanged.
  assert.deepEqual(Object.keys(settings).sort(),
    ["available", "enabled", "minutesCapPerCall", "minutesCapToday", "minutesUsedToday"]);
  assert.equal(settings.minutesCapPerCall, 30, "1800 seconds, in the minutes the caption shows");
  for (const [name, value] of Object.entries(settings)) {
    assert.ok(typeof value === "boolean" || typeof value === "number", `${name} is ${typeof value}, and a string is how a vendor name travels`);
  }
  assert.equal(settings.enabled, true);
  assert.equal(settings.available, true);
  assert.equal(settings.minutesUsedToday, 2.1, "126 seconds, in the minutes the row shows");
  assert.equal(settings.minutesCapToday, 120);
  const asText = JSON.stringify(settings);
  for (const leak of ["xai", "grok", "ember", "agent-1", "apiKey", "key"]) {
    assert.doesNotMatch(asText, new RegExp(leak, "i"), `"${leak}" reached the seam item A draws rows from`);
  }
});

test("VOICE-2 seam: `available` is a key existing anywhere, and an older relay's answer still reads true", async () => {
  // The control plane holds the key now, so the relay answers `available`. A relay that has not been
  // updated answers only apiKeySet, which means the same thing there, and a workspace on one must not
  // read as switched off.
  const shapes = [
    { body: { enabled: true, available: true, apiKeySet: false }, want: true, why: "the control plane has one" },
    { body: { enabled: true, available: false, apiKeySet: true }, want: false, why: "the control plane is the authority when it answers" },
    { body: { enabled: false, apiKeySet: true }, want: true, why: "an older relay answers only apiKeySet" },
    { body: { enabled: true, apiKeySet: false }, want: false, why: "and says so when there is none" },
  ];
  for (const shape of shapes) {
    const { voice } = await loadVoice({
      fetch: async () => ({ ok: true, status: 200, json: async () => shape.body }),
    });
    const settings = await voice.getSettings();
    assert.equal(settings.available, shape.want, shape.why);
    assert.equal(settings.enabled, shape.body.enabled === true);
  }
  // A relay that does not answer at all is not a workspace that is switched on.
  const { voice: down } = await loadVoice({ fetch: async () => { throw new Error("no relay"); } });
  assert.deepEqual(await down.getSettings(), { enabled: false, available: false });

  // NO DAY CAP MEANS NO NUMBERS, rather than a bar reading 0 of 0. The Usage row tests both fields
  // for a finite number and draws nothing without them, so omitting is what makes it draw nothing.
  const { voice: uncapped } = await loadVoice({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, available: true, dayUsedSeconds: 0, dayCapSeconds: 0 }) }),
  });
  assert.deepEqual(Object.keys(await uncapped.getSettings()).sort(), ["available", "enabled"]);
});

test("VOICE-2 seam: the microphone choice is offered only when the browser can name one, and it reaches getUserMedia", async () => {
  const { voice } = await loadVoice();
  // READ AS A PROPERTY, which is the shape the Settings rows test (`v.supportsMicChoice === true`).
  // It was a function here and a function is not `=== true`, so the Microphone row silently did not
  // draw at all; the seam is published both ways now and this is the half that pins the property.
  assert.equal(voice.supportsMicChoice, false, "a window with no mediaDevices gets no row rather than a dead control");
  const { voice: real } = await loadVoice({
    window: { navigator: { mediaDevices: { enumerateDevices: async () => [] } } },
  });
  assert.equal(real.supportsMicChoice, true);
  assert.equal(real.getMicDeviceId(), "", "and nothing is chosen until somebody chooses it");
  assert.equal(typeof real.micDeviceId, "function", "and the name the Settings row calls is a function");
  assert.equal(real.micDeviceId(), "", "answering the same thing the get/set pair does");
  real.setMicDeviceId("  mic-7  ");
  assert.equal(real.getMicDeviceId(), "mic-7");

  // The choice is worth nothing unless the capture asks for it. `exact` only ever appears when a
  // device was picked: asking exactly for "" refuses every microphone on the machine.
  let asked = null;
  const audio = {
    AudioContext: class { constructor(o) { this.options = o; this.audioWorklet = { addModule: async () => {} }; }
      createMediaStreamSource() { return { connect() {} }; } close() {} },
    AudioWorkletNode: class { constructor() { this.port = {}; } disconnect() {} },
    workletUrl: "fake://worklet",
    getUserMedia: async (constraints) => { asked = constraints; return { getTracks: () => [] }; },
  };
  await real.captureAudio({ source: "microphone", deviceId: "mic-7", audio });
  assert.deepEqual(asked.audio.deviceId, { exact: "mic-7" });
  await real.captureAudio({ source: "microphone", deviceId: "", audio });
  assert.equal(asked.audio.deviceId, undefined, "an empty choice asks for nothing, or it refuses every microphone");
});

// ------------------------------------------------------------------ the source legs
test("VOICE-1 source: the module is loaded beside its siblings and before app.js", async () => {
  const index = await read("ui/machine-room/index.html");
  assert.match(index, /<script src="voice\.js"><\/script>/);
  const at = index.indexOf('<script src="voice.js">');
  const cloud = index.indexOf('<script src="cloud-browser.js">');
  // app.js is not a tag: the page reads the gateway first and then injects it (index.html:445), so
  // "before app.js" means before the block that does the injecting.
  const app = index.indexOf('script.src = "app.js"');
  assert.ok(cloud >= 0 && at > cloud, "it loads with the other window-global modules");
  assert.ok(app >= 0 && at < app, "and before app.js paints, so the button is not added a tick late");
  const source = await read("ui/machine-room/voice.js");
  assert.match(source, /global\.__voice = \{/, "app.js does not call this module; it has to publish itself");
  assert.match(source, /addEventListener\("DOMContentLoaded", boot\)/);
  // It may add siblings of its own; it may never rewrite a node app.js owns.
  assert.ok(!/\.outerHTML\s*=/.test(source), "nothing here replaces somebody else's node");
});

test("VOICE-1 source: the talk button is in the composer, between the box and Send, and cannot submit it", async () => {
  const index = await read("ui/machine-room/index.html");
  const form = index.slice(index.indexOf('<form class="composer"'), index.indexOf("</form>"));
  const textarea = form.indexOf('id="message-input"');
  const talk = form.indexOf("data-voice-talk");
  const send = form.indexOf('class="send-button"');
  assert.ok(textarea >= 0 && talk > textarea, "after the message box");
  assert.ok(send > talk, "and before Send");
  const opens = form.lastIndexOf("<button", talk);
  const button = form.slice(opens, form.indexOf("</button>", opens) + "</button>".length);
  // Without type="button" a press inside a form submits it, which would send the composer every
  // time somebody pressed Talk.
  assert.match(button, /type="button"/);
  assert.match(button, /data-voice-orb/, "the orb lives inside the button, so there is one element to find");
  assert.match(button, /aria-pressed="false"/, "a toggle says whether it is on");
});

test("VOICE-1 source: styles.css gained only new selectors, under one banner", async () => {
  const css = await read("ui/machine-room/styles.css");
  const banners = css.split("/* VOICE-1 ").length - 1;
  assert.equal(banners, 1, "one banner, so a rebase is a clean append");
  const at = css.indexOf("/* VOICE-1 ");
  const before = css.slice(0, at);
  const after = css.slice(at);
  // Nothing this wave styles existed before it, which is what makes the append safe while two other
  // waves have this file open.
  assert.ok(!before.includes(".voice-"), "a .voice- selector above the banner means this wave edited somebody else's rules");
  assert.ok(!before.includes("voice-orb"));
  // And every selector below the banner is this wave's own.
  const selectors = [...after.matchAll(/^\s*([.#][^{\n]*?)\s*\{/gm)].map((m) => m[1].trim());
  assert.ok(selectors.length > 0, "the banner is not followed by any rules at all");
  // Every selector below the banner is this wave's own, with TWO allowed exceptions, declared here so
  // they cannot grow quietly: .composer's grid template, and the same rule gated on the state
  // attribute VOICE-2 hangs the live line's fifth track on. A fourth child of a three-track grid
  // opens an implicit second row and pushes Send off the line -- MEASURED at 390, 768 and 1440 CSS
  // px -- and a fifth child does it again. The rules are re-declared by appending, never edited in
  // place, so a rebase is still a clean append.
  //
  // THE LIST IS WIDENED IN THE COMMIT THAT NEEDS IT, deliberately, rather than discovered in CI by
  // whoever runs the suite next.
  //
  // AND WIDENED HERE, LATE, BY SOMEBODY ELSE'S WAVE. ROUTER-1 (0679508) appended the Think harder
  // switch's three rules into this same section and widened `.composer` to five tracks without
  // touching this list, so the suite on this branch arrived at VOICE-14 with this case already red.
  // The rules are an APPEND of new selectors, which is the thing this case exists to bless; what it
  // could not do is tell "below the VOICE-1 banner" from "a voice selector" once a later wave put its
  // own rules under that banner without one of its own. Declared rather than pattern-matched, so the
  // next wave that does this is a failure here again and not a quietly growing exception.
  const allowed = new Set([
    ".composer", ".composer[data-voice-line]",
    ".think-harder", ".think-harder input", ".think-harder span",
    // VOICE-14: the switch's word goes while the line is up, the way it already does on a phone.
    ".composer[data-voice-line] .think-harder", ".composer[data-voice-line] .think-harder span",
  ]);
  for (const selector of selectors) {
    for (const part of selector.split(",").map((one) => one.trim()).filter(Boolean)) {
      if (allowed.has(part)) continue;
      assert.match(part, /^\.voice-/, `${part} is not a selector this wave owns`);
    }
  }
  // And each exception may only move the grid track. Anything else in one would be this wave editing
  // another wave's composer.
  const composerRules = [...after.matchAll(/^\s*\.composer(\[data-voice-line\])?\s*\{([^}]*)\}/gm)];
  assert.ok(composerRules.length >= 2, "the fifth track's rule is missing, so the live line has no slot to sit in");
  for (const match of composerRules) {
    const properties = match[2].split(";").map((one) => one.split(":")[0].trim()).filter(Boolean);
    assert.deepEqual(properties, ["grid-template-columns"],
      `the .composer override carries more than the track it exists for: ${properties.join(", ")}`);
  }
  // The gated rule adds exactly one track to the ungated one, which is the whole of its job. An
  // unconditional extra track was MEASURED to take 4 px off the message box through .composer's own
  // 4 px gap, so what is asserted is the DIFFERENCE and not either number: the base rule carries one
  // track per child the composer has of its own, which was four when VOICE-2 measured it and is five
  // since ROUTER-1 (0679508) put the Think harder switch beside Send, and the gated rule carries one
  // more than that for the line.
  const tracks = (selector) => {
    const rule = composerRules.find((one) => `.composer${one[1] ?? ""}` === selector);
    assert.ok(rule != null, `${selector} is not under the banner`);
    return rule[2].split(":")[1].trim().replace(/;$/, "").split(/\s+(?![^(]*\))/).length;
  };
  assert.equal(tracks(".composer[data-voice-line]"), tracks(".composer") + 1,
    "the line's track is the ONE thing the gated rule adds, and at rest the composer is the form it has always been");
  for (const keyframes of [...after.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])) {
    assert.match(keyframes, /^voice-/, `${keyframes} could collide with another wave's animation`);
  }
  // The named deviation: the console's own palette, not the marketing board's. Read off the RULES
  // and not the banner, which names both hexes in order to explain why neither is used.
  const rules = after.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(rules.includes("--teal-500") && rules.includes("--teal-300"));
  for (const hex of ["#00C8F0", "#00c8f0", "#090D14", "#090d14"]) {
    assert.ok(!rules.includes(hex),
      `${hex} is titanium.bot's marketing board and appears nowhere in tokens.css; hardcoding it would make this the one control that does not match the console`);
  }
  assert.ok(after.includes("prefers-reduced-motion"), "the pulse drops for anyone who asked the OS for less of it");
  // [hidden] LOSES to an author display rule, and this file already carries three rules that exist
  // only because that bit a shipped control (:3830, :4162, :4216). A line that cannot hide is a
  // sentence sitting in every composer on every page, and at rest it would also be a fifth grid item
  // in a four-track form. The discipline moves with the node; the node it used to guard is gone.
  assert.match(rules, /\.voice-line:not\(\[hidden\]\)\s*\{/,
    "the line's display rule has to lose to the hidden attribute, or it can never be hidden");
  assert.ok(!rules.includes(".voice-strip"), "the strip that broke the footer left no rules behind");
  // The phone home spans every column. Anything else there opens a row the shelf did not have, which
  // is the bug this whole item exists to close.
  assert.match(rules, /\.voice-line\.is-shelf:not\(\[hidden\]\)\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
    "the shelf's copy of the line has to span the shelf, or it takes a column of it");
});

test("VOICE-1 source: the adapter gained one line and nothing else of this wave", async () => {
  const adapter = await read("ui/machine-room/gateway-adapter.js");
  const lines = adapter.split("\n").filter((one) => one.includes("voice:") && one.includes("spoken"));
  assert.equal(lines.length, 1, "one line in gateway-adapter.js, which is this wave's whole claim on it");
  assert.ok(!adapter.includes("__voice"), "the adapter never reaches into the voice module");
});

// ------------------------------------------------------------------ the real-Chrome smoke leg
//
// Everything above runs with no browser, which is the only way to pin words and arithmetic at this
// speed. This leg is here because verify-ui-in-a-real-browser.md is a lesson paid for twice: a page
// that parses is not a page a person can use, and a passing page.click() is not a click a mouse
// could make. So the button's box is POLLED rather than read once, and the press goes through
// elementFromPoint at the box centre.
//
// It is SKIPPED, with a sentence naming what it tried, when Chrome or playwright-core is absent --
// the resolver pattern scripts/verify-browser-tools.mjs:1301-1335 already uses.
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PLAYWRIGHT_CANDIDATES = [
  process.env.GROK_BOT_PLAYWRIGHT,
  path.join(repoRoot, ".cache/playwright/node_modules/playwright-core/index.mjs"),
  // A detached worktree has no .cache of its own; the shared checkout is where it was installed.
  "/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/.cache/playwright/node_modules/playwright-core/index.mjs",
].filter(Boolean);

// A second of 24 kHz mono PCM16, which is what --use-file-for-fake-audio-capture wants.
function wavBytes({ seconds = 1, rate = 24000, hz = 220 } = {}) {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };

// The console's own files, served flat, with no gateway behind them. That is on purpose: this leg
// asks whether the button and the strip are on the screen, and the gateway being absent is what
// makes the relay socket refuse -- which is the sentence the person has to read.
function serveConsole() {
  const root = path.join(repoRoot, "ui/machine-room");
  const upgrades = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    // The settings door, answered the way item A's relay answers it for a workspace nobody has set
    // up yet: the door exists, and apiKeySet is false. It matters that this is not a 404 -- a 404 is
    // an older relay with no voice at all, and the page disables the button for that, because a
    // press there could not produce a sentence let alone a way forward.
    if (url.pathname === "/voice/settings") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        enabled: true, vendor: "default", model: "", voice: "", agentId: "", apiKeySet: false,
        sessionCapSeconds: 1800, dayCapSeconds: 7200, dayUsedSeconds: 0, vendors: [], agents: [],
      }));
      return;
    }
    // SETTINGS-2: the session door. The Voice card is the OPERATOR's -- it holds a service, a model,
    // a voice and, until item C retires it, a key -- and the settings surface draws that section only
    // when the relay says this session is the operator's. Answered here the way a relay with no
    // password configured answers it, which is what this console has always been in a test.
    if (url.pathname === "/auth/state") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ required: false, authenticated: true, operator: true }));
      return;
    }
    const file = path.join(root, url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, ""));
    if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "application/json" }).end("{}");
    }
  });
  // The relay's voice door is item A's. Here the upgrade is recorded and refused, which is exactly
  // what a relay with no voice branch does -- and is the condition the page has to say out loud.
  server.on("upgrade", (request, socket) => { upgrades.push(request.url); socket.destroy(); });
  return { server, upgrades };
}

test("VOICE-1 in a real browser: the button is on screen, a mouse can press it, and the page speaks up", async (t) => {
  const playwright = PLAYWRIGHT_CANDIDATES.find((one) => existsSync(one));
  if (!existsSync(CHROME) || playwright == null) {
    t.skip(`tried Chrome at ${CHROME} and playwright-core at ${PLAYWRIGHT_CANDIDATES.join(", ")}; `
      + "set GROK_BOT_CHROME / GROK_BOT_PLAYWRIGHT to run the browser leg");
    return;
  }
  const { chromium } = await import(playwright);
  const work = await mkdtemp(path.join(tmpdir(), "voice-gate-"));
  const wav = path.join(work, "mic.wav");
  await writeFile(wav, wavBytes());

  const { server, upgrades } = serveConsole();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      // %noloop, because a looping file makes "did capture stop" unanswerable.
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  try {
    const context = await browser.newContext({ userAgent: GATE_AGENT, permissions: ["microphone"],
      viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });

    const mounted = await page.evaluate(() => typeof window.__voice === "object" && window.__voice != null);
    assert.equal(mounted, true, "the module did not mount in a real page");
    const tagged = await page.evaluate(() =>
      [...document.querySelectorAll("script[src]")].some((tag) => /voice\.js/.test(tag.getAttribute("src") || "")));
    assert.equal(tagged, true, "a module the page never loads is 300 lines that never run");

    // ALWAYS LISTENING, ASKED FOR OUT LOUD, because this leg measures a TOGGLE: one press opens the
    // line and the next press leaves it. Push to talk became the DEFAULT in VOICE-7 and VOICE-11 then
    // made a tap on a hold control a refusal in words, so the single click below quietly stopped
    // dialling anything and this case arrived at VOICE-14 red with "the press opened no socket" on a
    // branch where nothing about the toggle had changed. The hold gesture has its own cases above with
    // no browser in them; what only a browser can answer is the geometry, and that is the same either
    // way. The door the mode also travels on answers 404 here and is deliberately not waited for.
    await page.evaluate(() => window.__voice.setTalkMode("always"));

    // The boot cover is opaque and on top until app.js paints or its 8 s ceiling expires. With no
    // gateway here it is the ceiling, so the box is POLLED rather than read once -- a control behind
    // a cover is not a control on the screen.
    //
    // AND POLLED UNTIL IT STOPS MOVING, which is new and is what made this case flaky rather than red.
    // ROUTER-1 put the Think harder switch in the composer and it arrives on a later paint than the
    // Talk button does, so the button slides along the row AFTER it is first reachable: MEASURED here
    // at 1440x900, centre x 918 on the first reachable read and 981 once the composer had settled.
    // page.mouse.click goes to the coordinates it is given, so a click taken from the first read landed
    // 63 px away on whatever had taken that space, nothing happened, and the failure read "the press
    // opened no socket". Clicking it by SELECTOR would have hidden that rather than fixed it: the whole
    // point of this leg is a mouse at real coordinates, which is verify-ui-in-a-real-browser's rule. So
    // the same rect has to come back twice before the mouse is told where to go.
    let box = null;
    let steady = 0;
    const readBox = () => page.evaluate(() => {
      const node = document.querySelector("[data-voice-talk]");
      if (node == null) return null;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, label: node.textContent.replace(/\s+/g, " ").trim(), reachable: node.contains(hit) || hit === node };
    });
    for (let n = 0; n < 60 && steady < 2; n += 1) {
      const seen = await readBox();
      const same = seen != null && box != null && seen.x === box.x && seen.y === box.y;
      steady = seen?.reachable === true ? (same ? steady + 1 : 1) : 0;
      if (seen != null) box = seen;
      if (steady < 2) await page.waitForTimeout(500);
    }
    assert.ok(box != null, "the talk button never got a size on the page");
    assert.equal(box.reachable, true, `a mouse cannot reach the talk button; elementFromPoint landed elsewhere (${JSON.stringify(box)})`);
    assert.ok(steady >= 2, `the talk button never stopped moving, so there is nowhere to put a mouse: ${JSON.stringify(box)}`);
    assert.match(box.label, /Talk/, "the control says what it does in a word");

    // SIX RECTS BEFORE THE PRESS, read in one evaluate so they are one frame's truth. The whole of
    // VOICE-2 is that five of the six do not move, and the sixth -- the message box -- moves by the
    // width of the line and nothing more.
    const rects = () => page.evaluate(() => {
      const of = (selector) => {
        const node = document.querySelector(selector);
        if (node == null) return null;
        const r = node.getBoundingClientRect();
        return [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100,
          Math.round(r.left * 100) / 100, Math.round(r.top * 100) / 100];
      };
      const line = document.getElementById("voice-line");
      return {
        shelf: of(".control-shelf"), composer: of("#composer"), box: of("#message-input"),
        utilities: of(".shelf-utilities"), aside: of(".composer-aside"), transcript: of(".transcript"),
        tracks: getComputedStyle(document.getElementById("composer")).gridTemplateColumns.split(" ").length,
        lineIn: line?.parentElement?.id || line?.parentElement?.className || "",
        lineHidden: line == null ? null : line.hidden,
      };
    });

    const atRest = await rects();
    assert.equal(atRest.lineHidden, true, "the line is mounted and hidden before anything happens");
    // FIVE AT REST SINCE ROUTER-1 (0679508) PUT THE THINK HARDER SWITCH IN THE COMPOSER, which is a
    // fourth child and therefore a fifth track; it was four when VOICE-2 measured this and the number
    // was never moved, so this case arrived at VOICE-14 red. What is being measured has not changed and
    // is asserted below rather than here: the live line adds EXACTLY ONE track over whatever the
    // composer's own children need, and at rest the form is to the pixel what it was before the press.
    assert.equal(atRest.tracks, 5, `the composer has its five tracks at rest: ${JSON.stringify(atRest)}`);
    assert.equal(atRest.lineIn, "composer", `at this width the line lives in the composer: ${atRest.lineIn}`);

    // A real press at the real coordinates.
    await page.mouse.click(box.x, box.y);

    // Two things follow, and the second is the one a person sees. The page asked the relay for a
    // line; the relay here has no voice door, so it answers nothing -- and the page says so.
    const readLine = () => page.evaluate(() => {
      const line = document.getElementById("voice-line");
      const say = line?.querySelector("[data-voice-line-say]");
      const does = line?.querySelector("[data-voice-line-do]");
      const shown = [say, does].filter((one) => one != null && !one.hidden);
      return {
        notes: window.__voice.stats().notes,
        text: shown.map((one) => one.textContent.replace(/\s+/g, " ").trim()).join(" "),
        shown: shown.length,
        visible: line != null && !line.hidden && line.getBoundingClientRect().height > 0,
        classes: line?.className ?? "",
        hasAction: does != null && !does.hidden,
        actionName: does?.getAttribute("title") ?? "",
        actionReads: does == null ? "" : does.textContent.replace(/\s+/g, " ").trim(),
        orb: document.querySelector("[data-voice-orb]")?.getAttribute("data-state") ?? "",
      };
    });
    let saw = null;
    for (let n = 0; n < 16; n += 1) {
      saw = await readLine();
      if (saw.visible) break;
      await page.waitForTimeout(125);
    }
    assert.ok(upgrades.some((one) => one === "/voice/socket"), `the press opened no socket; saw ${JSON.stringify(upgrades)}`);
    assert.equal(saw.visible, true, `the person was left with nothing to read (${JSON.stringify(saw)})`);
    assert.ok(saw.text.length > 20, saw.text);
    assert.equal(saw.shown, 1, `one node shows at a time, not two: ${JSON.stringify(saw)}`);
    // The live half is a LINE, never the console's own message bubble. Jason's screenshot of
    // 2026-09-10 is a picture of that bubble taking a column of the footer.
    assert.doesNotMatch(saw.classes, /message-row|is-turn-failed/);
    // The sentence a refused line must produce, and the control that makes it lead somewhere. The
    // first version of this file said "the line dropped" here instead, with no control: Chrome fires
    // error AND close, and the close overwrote the useful sentence. No fake socket caught that.
    assert.deepEqual(saw.notes, ["no-key"], `the press led nowhere: ${JSON.stringify(saw)}`);
    assert.equal(saw.hasAction, true, "the one condition a person can fix from this page has to lead there");
    assert.equal(saw.actionName, "Open settings", "and the control says where it goes");
    // The control's own accessible name is the SENTENCE, not the action: an aria-label would replace
    // the button's text for a screen reader and swallow the one thing a person needs to hear.
    assert.equal(saw.actionReads, saw.text, "the control reads out as the sentence it carries");
    assert.equal(saw.orb, "off", "the orb went back to off rather than spinning at a line that is not there");
    // getUserMedia on the fake device is the other half: a refused microphone is a different
    // sentence, so reading the no-key one proves the device resolved.
    assert.ok(!saw.notes.includes("no-microphone"), `the fake audio device was not accepted: ${JSON.stringify(saw.notes)}`);

    // THE FOOTER DID NOT MOVE, which is the whole of VOICE-2 and the thing no test could see before.
    // MEASURED on this Mac before the fix, one press at 1440x900: .control-shelf 1392x106@24,776 ->
    // 1392x196.02@24,685.98, #composer 600x54@459 -> 407.98x54@991, #message-input 370.05 -> 178.03,
    // .shelf-utilities wrapped to row two at x41, .composer-aside rose 90 px onto the right rail and
    // .transcript lost 45.5 px. Five of those six are now unchanged TO THE PIXEL; the message box is
    // the one that gives up room, because the line has to come from somewhere.
    const withLine = await rects();
    for (const named of ["shelf", "composer", "utilities", "aside", "transcript"]) {
      assert.deepEqual(withLine[named], atRest[named],
        `${named} moved when the line came up: ${JSON.stringify(atRest[named])} -> ${JSON.stringify(withLine[named])}`);
    }
    assert.equal(withLine.tracks, atRest.tracks + 1, "the line's own track is there while the line is up");
    assert.ok(withLine.box[0] < atRest.box[0], "the message box is where the line's width came from");
    assert.ok(withLine.box[0] >= 150,
      `the message box is too narrow to type in with the line up: ${withLine.box[0]} px (was ${atRest.box[0]})`);
    // AND THE SENTENCE IS WHOLE. A capped line that ellipsises the one sentence a person has to read
    // is a truncated apology; two lines of 13 px inside a form that is 54 px tall is what buys the
    // words back without moving anything.
    const readable = await page.evaluate(() => {
      const node = document.querySelector("#voice-line [data-voice-line-do]:not([hidden])")
        ?? document.querySelector("#voice-line [data-voice-line-say]:not([hidden])");
      return { over: node.scrollWidth - node.clientWidth, tall: node.scrollHeight - node.clientHeight, text: node.textContent };
    });
    assert.ok(readable.over <= 1 && readable.tall <= 1,
      `the sentence is cut off in the composer: ${JSON.stringify(readable)}`);
    console.log(`    VOICE-2 at 1440x900: the line costs the message box ${Math.round((atRest.box[0] - withLine.box[0]) * 100) / 100} px `
      + `(${atRest.box[0]} -> ${withLine.box[0]}), nothing else in the footer moves, and the sentence is whole`);

    // A SECOND PRESS LEAVES. It used to call start() again, because toggle() read a flag the relay had
    // already cleared, and the geometry afterwards was byte-identical to the break.
    const before = upgrades.length;
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(250);
    const left = await readLine();
    assert.equal(left.visible, false, `the second press did not leave the mode: ${JSON.stringify(left)}`);
    assert.deepEqual(left.notes, [], "and the line really went, rather than being painted empty");
    assert.equal(upgrades.length, before, "and it did not redial into the same refusal");
    const afterLeaving = await rects();
    assert.deepEqual(afterLeaving, atRest, "and the footer is exactly what it was before the first press");

    // AND THE AGENT'S REPLY TOUCHES NOTHING. This is the other half of the same bug and the half that
    // happens on EVERY turn rather than only on a refusal: the reply used to be written into this same
    // line, which took #message-input 370.05 to 215.31 px here and 25 px of shelf height on a phone,
    // and it stood for the rest of the call. All six rects now, including the message box, because the
    // box is the one thing the line is allowed to take from when something IS wrong.
    await page.evaluate(() => window.__voice._onMessage({
      data: JSON.stringify({ t: "said", text: "The team is on the settings surface this afternoon." }),
    }));
    await page.waitForTimeout(60);
    const replied = await rects();
    for (const named of ["shelf", "composer", "box", "utilities", "aside", "transcript"]) {
      assert.deepEqual(replied[named], atRest[named],
        `${named} moved when the agent answered: ${JSON.stringify(atRest[named])} -> ${JSON.stringify(replied[named])}`);
    }
    assert.equal(replied.tracks, atRest.tracks, "the composer grew a track for the reply");

    // ESCAPE LEAVES TOO. Measured before the fix: Escape changed nothing at all.
    await page.mouse.click(box.x, box.y);
    await page.waitForFunction(() => document.getElementById("voice-line")?.hidden === false, null, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    assert.equal((await readLine()).visible, false, "Escape did not leave talk mode");

    // AND LEFT ALONE IT CLEARS ITSELF. Nothing ever cleared a note: clearNotes ran from start() and
    // the ready frame and nowhere else, so the sentence sat in the footer for the life of the tab.
    await page.mouse.click(box.x, box.y);
    await page.waitForFunction(() => document.getElementById("voice-line")?.hidden === false, null, { timeout: 10_000 });
    const armed = Date.now();
    await page.waitForFunction(() => document.getElementById("voice-line")?.hidden === true, null, { timeout: 12_000 });
    const waited = Date.now() - armed;
    assert.ok(waited >= 4000, `the line vanished in ${waited} ms, which is too fast to read`);
    console.log(`    VOICE-2: the line took itself away after ${waited} ms on this Mac`);

    // THE PHONE'S HOME, which is a different parent and not only a different width: in the composer
    // there is no room for a sentence beside a 178 px message box, so the line takes the shelf's first
    // row, full width, the way .composer-status and .attachment-tray already do.
    const phone = await browser.newContext({ userAgent: GATE_AGENT, viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true, permissions: ["microphone"] });
    try {
      const small = await phone.newPage();
      await small.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await small.waitForFunction(() => document.getElementById("voice-line") != null, null, { timeout: 15_000 });
      const shelfBefore = await small.evaluate(() => Math.round(document.querySelector(".control-shelf").getBoundingClientRect().height * 100) / 100);
      const talkBox = await small.evaluate(() => {
        const r = document.querySelector("[data-voice-talk]").getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      // styles.css:4641-4652 puts a 44 px floor under ten controls on this row. The talk button shipped
      // at 38x38 to match the attach button beside it, which is itself on that list.
      assert.ok(talkBox.width >= 44 && talkBox.height >= 44,
        `the talk button is ${talkBox.width}x${talkBox.height} on a phone, under the 44 px floor this file enforces`);
      await small.touchscreen.tap(talkBox.x, talkBox.y);
      await small.waitForFunction(() => document.getElementById("voice-line")?.hidden === false, null, { timeout: 10_000 });
      const onPhone = await small.evaluate(() => {
        const line = document.getElementById("voice-line");
        const shelf = document.querySelector(".control-shelf");
        const composer = document.getElementById("composer");
        const l = line.getBoundingClientRect();
        const s = shelf.getBoundingClientRect();
        const does = line.querySelector("[data-voice-line-do]");
        const d = does?.getBoundingClientRect();
        return {
          parent: line.parentElement.className, classes: line.className,
          full: Math.round((l.width / (s.width - 18)) * 100),
          shelfHeight: Math.round(s.height * 100) / 100,
          composerWidth: Math.round(composer.getBoundingClientRect().width),
          action: d == null ? null : { width: Math.round(d.width), height: Math.round(d.height) },
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      assert.match(onPhone.parent, /control-shelf/, `on a phone the line belongs to the shelf, not the composer: ${onPhone.parent}`);
      assert.match(onPhone.classes, /is-shelf/, "and it carries the class that spans the shelf's columns");
      assert.equal(onPhone.sideways, false, "and the page does not scroll sideways with it up");
      assert.ok(onPhone.action != null && onPhone.action.height >= 44,
        `the sentence that leads somewhere is a ${JSON.stringify(onPhone.action)} tap target`);
      const grew = Math.round((onPhone.shelfHeight - shelfBefore) * 100) / 100;
      console.log(`    VOICE-2 at 390x844: the line takes ${onPhone.full}% of the shelf's width, the shelf grows `
        + `${grew} px (${shelfBefore} -> ${onPhone.shelfHeight}), the composer stays ${onPhone.composerWidth} px, `
        + `the talk button is ${talkBox.width}x${talkBox.height}, the action is ${JSON.stringify(onPhone.action)}`);
      // A ROW, NOT A LAYOUT. The budget is the tap target plus the shelf's own 8 px row gap: this row
      // carries a control and the 44 px floor this file enforces for every other control beside it is
      // what sets the number. A caption, which leads nowhere and is text, costs a third of that.
      assert.ok(grew <= 60, `the shelf grew ${grew} px on a phone, which is a footer that moved rather than a line that appeared`);
      assert.equal(onPhone.composerWidth, 358, "and the composer is untouched, which is what the strip could never manage");

      // AND AN ORDINARY TURN COSTS NOTHING AT ALL, which is the number that matters to anyone who can
      // actually talk: a refusal is rare, and the agent answering is every single turn. The reply used
      // to be written into this same line and took this shelf from 390x133 at y711 to 390x158 at y686 --
      // 25 px taller and 25 px higher, standing for the rest of the call. Now it paints nothing.
      // toggle(), not stop(): an ordinary stop leaves a note standing on purpose, because the relay's
      // diagnosis outranks anything that happens after it.
      await small.evaluate(() => window.__voice.toggle());
      await small.waitForFunction(() => document.getElementById("voice-line")?.hidden === true, null, { timeout: 10_000 });
      await small.evaluate(() => window.__voice._onMessage({
        data: JSON.stringify({ t: "said", text: "The team is on the settings surface this afternoon." }),
      }));
      await small.waitForTimeout(60);
      const replyCost = await small.evaluate(() => Math.round(document.querySelector(".control-shelf").getBoundingClientRect().height * 100) / 100);
      console.log(`    VOICE-7 at 390x844: the agent's reply costs the shelf ${Math.round((replyCost - shelfBefore) * 100) / 100} px`);
      assert.equal(replyCost, shelfBefore,
        `the agent's reply grew the shelf ${replyCost - shelfBefore} px on a phone, and it does that on every turn`);
    } finally {
      await phone.close();
    }


    // THE COMPOSER STILL FITS ON ONE ROW AT REST, at three widths, because this wave has now added two
    // children to somebody else's grid. Without the tracks, MEASURED: Send was pushed onto a row of
    // its own and the form grew from 54 to 104 px at every width.
    //
    // EACH WIDTH IS A FRESH LOAD, not a resize of this page. Resizing proved misleading: app.js sizes
    // the shelf once at load, so a page opened at 1280 and resized to 768 kept a 306 px composer and
    // the message box measured 76 px -- a number no person would ever see.
    for (const size of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
      const sized = await browser.newContext({ userAgent: GATE_AGENT, viewport: size });
      try {
        const fresh = await sized.newPage();
        await fresh.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
        await fresh.waitForTimeout(600);
        const row = await fresh.evaluate(() => {
          const form = document.getElementById("composer");
          const talk = document.querySelector("[data-voice-talk]");
          const send = document.querySelector(".send-button");
          const box = document.getElementById("message-input");
          const line = document.getElementById("voice-line");
          const f = form.getBoundingClientRect();
          const t = talk.getBoundingClientRect();
          const s = send.getBoundingClientRect();
          const hit = document.elementFromPoint(Math.round(t.left + t.width / 2), Math.round(t.top + t.height / 2));
          return {
            formHeight: Math.round(f.height), formWidth: Math.round(f.width),
            talkWidth: Math.round(t.width), talkHeight: Math.round(t.height),
            boxWidth: Math.round(box.getBoundingClientRect().width),
            insideForm: t.left >= f.left - 1 && t.right <= f.right + 1,
            sameRowAsSend: Math.abs(t.top - s.top) < 12,
            reachable: talk.contains(hit) || hit === talk,
            sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            lineIn: line?.parentElement?.id || line?.parentElement?.className || "",
            lineHidden: line?.hidden,
            tracks: getComputedStyle(form).gridTemplateColumns.split(" ").length,
          };
        });
        const where = `${size.width}px: ${JSON.stringify(row)}`;
        assert.equal(row.sameRowAsSend, true, `Send was pushed off the composer's row. ${where}`);
        assert.ok(row.formHeight <= 64, `the composer grew, so a row wrapped. ${where}`);
        assert.equal(row.insideForm, true, `the talk button overflows the composer. ${where}`);
        assert.equal(row.reachable, true, `a mouse cannot reach the talk button. ${where}`);
        assert.equal(row.sideways, false, `the page scrolls sideways. ${where}`);
        assert.equal(row.lineHidden, true, `the line is showing with nothing to say. ${where}`);
        // Five since ROUTER-1: the Think harder switch has a track of its own at every width.
        assert.equal(row.tracks, 5, `the composer grew a track with the line down. ${where}`);
        // At rest the message box is exactly what it always was: the line costs nothing until it has
        // something to say, which is why the fifth track hangs off a state attribute.
        assert.ok(row.boxWidth >= 150, `the message box is too narrow to type in. ${where}`);
        // The line lives in the composer above 900 px and in the shelf at or below it, because a
        // 358 px composer has no room for a sentence beside a 176.98 px message box.
        if (size.width <= 900) assert.match(row.lineIn, /control-shelf/, `the line is not in the shelf. ${where}`);
        else assert.equal(row.lineIn, "composer", `the line is not in the composer. ${where}`);
        if (size.width <= 690) {
          assert.ok(row.talkWidth >= 44 && row.talkHeight >= 44, `the phone button is under the 44 px floor. ${where}`);
          assert.equal(row.talkWidth, row.talkHeight, `the phone button is not a circle. ${where}`);
        } else {
          assert.ok(row.talkWidth > 60, `the desktop button lost its label. ${where}`);
        }
      } finally {
        await sized.close();
      }
    }

    const ours = failures.filter((one) => /voice/i.test(one));
    assert.deepEqual(ours, [], `voice.js threw in a real page: ${ours.join(" | ")}`);
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test("VOICE-11 paint: a repaint that changes nothing writes nothing, so the observer cannot chase itself", async (t) => {
  // FOUND BY THE CONSOLE-6 FLICKER WORK, in this file rather than in theirs: the comment beside this
  // module's body-wide MutationObserver claims "every write it makes is guarded on a change, so
  // putting it here cannot chase its own mutation round the loop", and five of its writes were not
  // guarded. Setting an attribute to the value it already holds still emits a mutation record, and so
  // does assigning `.hidden` the boolean it already has. MEASURED on grok-bot-local-vm in real Chrome
  // at 1440x900 on an idle console: 453 records in 15 s on each of the talk button, its orb, the line
  // and the line's two spans -- 30 a second while another pane's repaint loop was running the page at
  // 60 Hz, and 5 a second after they fixed that. Nothing was broken by it and no node was replaced;
  // what was wrong was the claim, and a claim this file leans on to be allowed to live on that
  // observer at all.
  const playwright = PLAYWRIGHT_CANDIDATES.find((one) => existsSync(one));
  if (!existsSync(CHROME) || playwright == null) {
    t.skip(`tried Chrome at ${CHROME} and playwright-core at ${PLAYWRIGHT_CANDIDATES.join(", ")}`);
    return;
  }
  const { chromium } = await import(playwright);
  const { server } = serveConsole();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ userAgent: GATE_AGENT, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__voice != null && document.getElementById("voice-line") != null,
      null, { timeout: 30_000 });

    // The line is driven up and back down first, so every node this module owns has been painted at
    // least once and every attribute it writes is already at its settled value. A first paint writing
    // attributes is not the defect; a two hundredth one writing the same attributes is.
    await page.evaluate(() => { window.__voice.stop("no-key"); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__voice.stop(); });
    await page.waitForTimeout(400);

    const seen = await page.evaluate(async () => {
      const mine = ["[data-voice-talk]", "[data-voice-orb]", "#voice-line", "[data-voice-line-say]", "[data-voice-line-do]"];
      const nodes = mine.map((one) => document.querySelector(one)).filter((one) => one != null);
      const records = [];
      const observer = new MutationObserver((list) => {
        for (const record of list) {
          if (record.type !== "attributes") continue;
          if (!nodes.includes(record.target)) continue;
          records.push(`${record.target.id || record.target.className || record.target.tagName}.${record.attributeName}`);
        }
      });
      observer.observe(document.body, { attributes: true, subtree: true });
      // The module's own observer is what is being measured, so it is woken the way the console wakes
      // it: a mutation somewhere else on the page, once a frame apart so the wakes are not coalesced.
      const crumb = document.createElement("span");
      for (let i = 0; i < 20; i += 1) {
        document.body.appendChild(crumb);
        await new Promise((resolve) => setTimeout(resolve, 40));
        crumb.remove();
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      observer.disconnect();
      const counted = {};
      for (const one of records) counted[one] = (counted[one] ?? 0) + 1;
      return { total: records.length, counted, nodes: nodes.length };
    });
    assert.equal(seen.nodes, 5, "the five nodes this module owns are not all on the page");
    assert.deepEqual(seen.counted, {},
      `forty wakes of the observer rewrote attributes that had not changed: ${JSON.stringify(seen.counted)}`);
    assert.equal(seen.total, 0);
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

// ================================================================== VOICE-7
//
// Jason, 2026-09-10 11:09: "a semi-transparent modal over the current chat window where that is
// being built out. We see the words being created, and when it's done, that just becomes the next
// line ... Also the talk button should be either: press it and it's on, so it's a toggle, on or
// off; or press and hold to talk and let go. That should be a setting for the user."
//
// The panel's state machine and the two modes, driven with no browser through the same fake window
// the rest of this file uses. What only a browser can answer -- that the footer does not move and
// that a thumb can hold a 38 px circle -- is scripts/verify-voice.mjs --leg overlay.

/** The stub worklet's port, so a test can hand the capture a block of samples by hand. */
let capturePort = null;

/** A window with a document that has a body, which is what makes the observer run. */
const fakeDocument = (extra = {}) => ({
  readyState: "complete",
  body: { dataset: {} },
  activeElement: { tagName: "BODY" },
  querySelector: () => null,
  getElementById: () => null,
  addEventListener: () => {},
  ...extra,
});
const fakeAudioWindow = () => ({
  MutationObserver: class { observe() {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  AudioContext: class {
    constructor() { this.audioWorklet = { addModule: async () => {} }; this.currentTime = 0; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 2048, connect() {}, getFloatTimeDomainData() {} }; }
    close() {}
  },
  AudioWorkletNode: class { constructor() { this.port = {}; capturePort = this.port; } disconnect() {} },
  Blob: class {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
});

/** A voice with a socket that opens, a microphone that works, and a record of what reached the wire. */
async function loadTalking(extra = {}) {
  const sent = { frames: 0, json: [], audio: [] };
  class OpenSocket {
    constructor() { this.readyState = 1; this.handlers = {}; setTimeout(() => this.handlers.open?.({}), 0); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    send(payload) {
      sent.frames += 1;
      if (typeof payload === "string") { try { sent.json.push(JSON.parse(payload)); } catch { /* audio */ } }
      // VOICE-11 keeps the audio too, in order, because the release's tail is a claim about BYTES --
      // that they are zeroes, that there are eight of them, and that they came after the speech.
      else sent.audio.push(payload);
    }
    close() { this.readyState = 3; }
  }
  const loaded = await loadVoice({ window: { __voiceSocketClass: OpenSocket, ...fakeAudioWindow(), ...extra } });
  return { ...loaded, sent };
}

test("VOICE-7 panel: open, partials that REPLACE, and a final that dissolves into exactly one row", async () => {
  const { voice } = await loadVoice();
  const { makeCaption } = await import("../ui/voice-edge.mjs");

  // BOTH VENDORS FIRST, through the relay's own normaliser, because the panel is only allowed to be
  // this simple if replace-whole is true on either wire. One service's transcript is cumulative with
  // its own corrections; the other's is a delta that later deltas may revise.
  const cumulative = makeCaption("cumulative");
  const incremental = makeCaption("incremental");
  const xai = [cumulative.apply({ transcript: "open" }), cumulative.apply({ transcript: "open the" }), cumulative.apply({ transcript: "open the box" })];
  const openai = [incremental.apply({ delta: "open" }), incremental.apply({ delta: " the" }), incremental.apply({ delta: " box" })];
  assert.deepEqual(xai, ["open", "open the", "open the box"]);
  assert.deepEqual(openai, ["open", "open the", "open the box"], "the page sees the same three strings on either service");

  for (const words of [xai, openai]) {
    frame(voice, { t: "hear-begin", turn: 1, itemId: "item_user" });
    assert.equal(voice._state.heard.open, true, "the panel is up as soon as the person starts talking");
    assert.equal(voice._state.heard.text, "", "with no words yet, which is also all a service that sends none ever gives us");
    for (const one of words) frame(voice, { t: "hear", turn: 1, text: one, final: false });
    // REPLACED, never appended. Appending would read "openopen theopen the box".
    assert.equal(voice._state.heard.text, "open the box");
    assert.equal(voice._state.heard.phase, "partial");

    // The settled transcript is STILL a partial: it races the model's tool call, and dissolving here
    // would flash the panel back open a moment later.
    frame(voice, { t: "hear", turn: 1, text: "open the box", final: true });
    assert.equal(voice._state.heard.open, true);

    // The bytes that went to the agent. A different model produced them, which is exactly why the
    // panel's last paint has to be this one and not the transcript above.
    frame(voice, { t: "heard-confirmed", turn: 1, text: "open the box for me", nonce: "voice:s1:1", landed: true });
    frame(voice, { t: "hear-end", turn: 1, reason: "sent" });
    assert.equal(voice._state.heard.text, "open the box for me", "the last words a person reads are the ones that became the row");
    assert.equal(voice._state.lastHeard, "open the box for me");
    assert.equal(voice._state.lastNonce, "voice:s1:1");
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(voice._state.heard.open, false, "and then it is gone");
    // KEPT AFTER IT HAS GONE. The row lands through the ordinary transcript poll seconds later, and
    // proving the two are the same bytes needs the words to outlive the node they were drawn in.
    assert.equal(voice._state.lastHeard, "open the box for me");
  }
});

test("VOICE-7 panel: a late frame from the previous turn never paints over the new one", async () => {
  // One service does not guarantee that a completed transcript for one utterance arrives before the
  // next utterance's words, and says to reconcile on its item id. The relay stamps every frame with
  // its own utterance counter, which is that reconciliation.
  const { voice } = await loadVoice();
  frame(voice, { t: "hear-begin", turn: 1, itemId: "item_user" });
  frame(voice, { t: "hear", turn: 1, text: "open the box", final: false });
  frame(voice, { t: "heard-confirmed", turn: 1, text: "open the box", nonce: "voice:s1:1", landed: true });
  frame(voice, { t: "hear-end", turn: 1, reason: "sent" });
  await new Promise((resolve) => setTimeout(resolve, 260));

  frame(voice, { t: "hear-begin", turn: 2, itemId: "item_user" });
  frame(voice, { t: "hear", turn: 2, text: "what time is it", final: false });
  // The previous turn's settled transcript, arriving late.
  frame(voice, { t: "hear", turn: 1, text: "open the box", final: true });
  assert.equal(voice._state.heard.text, "what time is it", "an older turn painted over a newer one");
  // And a stale FINAL cannot dissolve the panel that is up either.
  frame(voice, { t: "heard-confirmed", turn: 1, text: "open the box", nonce: "voice:s1:1", landed: true });
  frame(voice, { t: "hear-end", turn: 1, reason: "sent" });
  assert.equal(voice._state.heard.open, true);
  assert.equal(voice._state.lastHeard, "open the box", "and the row that did land keeps its words");
});

test("VOICE-7 panel: the three turns that produce no row still take it away", async () => {
  // An empty utterance, a yes that closed a card, and a confirm arriving in the same turn as its own
  // question. Each now sends its own final frame with lands:false. Without them the panel sits over
  // the conversation with somebody's half sentence in it and nothing ever arrives to finish the turn.
  for (const one of [
    { text: "", lands: false, why: "not-caught" },
    { text: "yes", lands: false, why: "answered-a-card" },
    { text: "yes", lands: false, why: "same-turn" },
  ]) {
    const { voice } = await loadVoice();
    frame(voice, { t: "hear-begin", turn: 1, itemId: "item_user" });
    frame(voice, { t: "hear", turn: 1, text: "yes", final: false });
    frame(voice, { t: "hear-end", turn: 1, reason: one.why });
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(voice._state.heard.open, false, `a ${one.why} turn left the panel up`);
  }
});

test("VOICE-7 panel: nothing the agent says ever opens it, and his speaking closes it", async () => {
  const { voice } = await loadVoice();
  // His reply is the strip's own line. Until this split both went through one field, so his answer
  // painted over her sentence mid-turn.
  frame(voice, { t: "said", text: "I have asked him and he is on it." });
  assert.equal(voice._state.heard.open, false, "the agent's words opened a panel that is meant to be the person's");
  assert.equal(voice._state.lastSaid, "I have asked him and he is on it.", "kept for the gate to read");
  assert.equal(voice._lineFor(voice._state.notes).text, "", "and drawn nowhere: not in the panel and not in the footer");

  // And if the echo gate ever slipped, words arriving while he speaks would be his own coming back
  // through the speakers. A panel is not where anybody should find that out.
  frame(voice, { t: "hear-begin", turn: 1, itemId: "item_user" });
  frame(voice, { t: "hear", turn: 1, text: "half a sentence", final: false });
  assert.equal(voice._state.heard.open, true);
  frame(voice, { t: "state", value: "speaking" });
  assert.equal(voice._state.heard.open, false, "no panel while the agent is speaking; the orb is the only sign");
  // And nothing can open one while he is still speaking either.
  frame(voice, { t: "hear-begin", turn: 2, itemId: "item_user" });
  assert.equal(voice._state.heard.open, false);
});

test("VOICE-7 panel: a turn that simply stops has something that takes the panel away", async () => {
  // Three no-row turns send their own final frame, but a service that stops mid-turn sends nothing at
  // all. A panel with somebody's words in it may not sit over their conversation forever.
  const { voice } = await loadVoice();
  // NOT EIGHT SECONDS. It was, and eight seconds was armed from the START of the utterance and put
  // back only by a word arriving -- so on a service that streams no live words at all (which is what
  // docs/VOICE.md 3 marks as unobserved for xAI) the panel dissolved eight seconds into the sentence
  // and the confirmed words could never paint. The ceiling is the relay's own bound for a turn.
  assert.equal(voice._HEARD_STALE_MS, 120_000);
  const { TURN_WAIT_CAP_S } = await import("../ui/voice-edge.mjs");
  assert.equal(voice._HEARD_STALE_MS, TURN_WAIT_CAP_S * 1000,
    "the panel's patience and the relay's own wait for a turn are the same number");
  const source = await read("ui/machine-room/voice.js");
  const machine = source.slice(source.indexOf("function armStale"), source.indexOf("function paintOverlay"));
  assert.match(machine, /function overlayOpen[\s\S]*armStale\(\)/, "opening the panel arms the timer");
  assert.match(machine, /function overlayPartial[\s\S]*armStale\(\)/, "and every word puts it back");
  assert.match(machine, /function overlayConfirmed[\s\S]*armStale\(HEARD_CONFIRMED_STALE_MS\)/,
    "and the confirmed words leave a short window, so a lost hear-end cannot leave the panel up for the call");
  assert.match(machine, /function overlayEnd[\s\S]*disarmStale\(\)/, "and so does the turn ending");
  assert.match(machine, /function closeOverlay[\s\S]*disarmStale\(\)/);
});

test("VOICE-7 panel: a turn with NO live words still ends with the words it produced", async () => {
  // THE DOCUMENTED FALLBACK PATH, and the one the stale window used to break. A service that streams
  // no input transcription sends hear-begin and then nothing until the turn is over, so nothing put
  // the stale window back: the panel dissolved mid-sentence and `heard-confirmed` then returned at
  // the closed-panel guard, leaving the words the turn produced on screen nowhere at all.
  //
  // Driven on an injected clock rather than by waiting two minutes.
  const timers = [];
  const { voice } = await loadVoice({
    window: {
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
      clearTimeout: () => {},
    },
  });
  frame(voice, { t: "hear-begin", turn: 1, itemId: "item_user" });
  assert.equal(voice._state.heard.open, true);
  assert.equal(voice._state.heard.text, "", "no words, which is all this service ever gives while somebody talks");
  const armed = timers.filter((one) => one.ms === voice._HEARD_STALE_MS);
  assert.equal(armed.length, 1, `one stale window, armed once: ${JSON.stringify(timers.map((t) => t.ms))}`);

  // The window fires anyway -- a long turn, or a service that stopped -- and the confirmed words
  // still arrive afterwards. They are the last thing the person read, so they are painted.
  armed[0].fn();
  assert.equal(voice._state.heard.open, false, "the stale window took it away");
  frame(voice, { t: "heard-confirmed", turn: 1, text: "what is the team working on", nonce: "voice:s1:1", landed: true });
  assert.equal(voice._state.heard.text, "what is the team working on",
    "the words the turn produced never reached the panel");
  assert.equal(voice._state.heard.open, true, "and they are on screen to be read");
  frame(voice, { t: "hear-end", turn: 1, reason: "sent" });

  // ONLY STALENESS RE-OPENS IT. A person who pressed stop, or an agent who started speaking, must
  // never have a panel come back at them.
  const other = await loadVoice();
  frame(other.voice, { t: "hear-begin", turn: 1, itemId: "item_user" });
  frame(other.voice, { t: "state", value: "speaking" });
  assert.equal(other.voice._state.heard.open, false);
  frame(other.voice, { t: "heard-confirmed", turn: 1, text: "open the box", nonce: "voice:s1:1", landed: true });
  assert.equal(other.voice._state.heard.open, false, "a panel came back while the agent was speaking");
});

test("VOICE-7 panel: the previous utterance's settled words never paint into this one", async () => {
  // The relay drops a transcript belonging to the item it has moved on from, and this is the same
  // guard on the page: the services do not order `.completed` events between items, so utterance 1's
  // sentence can arrive after utterance 2's panel is up.
  const { voice } = await loadVoice();
  frame(voice, { t: "hear-begin", turn: 1, itemId: "item_1" });
  frame(voice, { t: "hear", turn: 1, text: "open the box", final: false, itemId: "item_1" });
  frame(voice, { t: "hear-end", turn: 1, reason: "sent" });
  frame(voice, { t: "hear-begin", turn: 2, itemId: "item_2" });
  frame(voice, { t: "hear", turn: 2, text: "what time is it", final: false, itemId: "item_2" });
  // Utterance 1's settled transcript, late, and stamped with the current turn by an older relay.
  frame(voice, { t: "hear", turn: 2, text: "open the box", final: true, itemId: "item_1" });
  assert.equal(voice._state.heard.text, "what time is it",
    "the sentence before last was painted over this one as settled words");
});

test("VOICE-7 panel: an older relay that sends only the three-in-one frame still shows the words", async () => {
  // A relay restart mid-call leaves an old page against a new relay, and a new page against an old
  // relay. The second one is this: the `heard` frame VOICE-1 shipped, carrying the partial transcript,
  // the settled one and the agent's own tool argument under a single shape, with nothing to tell them
  // apart. A person who is talking and seeing nothing is worse than a panel the stale timer has to
  // take away, so it still drives the panel.
  const { voice } = await loadVoice();
  frame(voice, { t: "heard", text: "open the box" });
  assert.equal(voice._state.heard.open, true, "the words are still shown");
  assert.equal(voice._state.heard.text, "open the box");

  // AND IT IS DROPPED THE MOMENT A LABELLED FRAME PROVES IT DOES NOT HAVE TO BE READ. The relay sends
  // both for this release, and painting both would put the same words on screen twice.
  const fresh = await loadVoice();
  frame(fresh.voice, { t: "hear-begin", turn: 1, itemId: "item_user" });
  frame(fresh.voice, { t: "hear", turn: 1, text: "what time is it", final: false });
  frame(fresh.voice, { t: "heard", text: "something else entirely" });
  assert.equal(fresh.voice._state.heard.text, "what time is it",
    "the old frame painted over the labelled one it is meant to defer to");
});

test("VOICE-7 panel: no title, no icon, no close control, nothing that reads as a failure", async () => {
  // host-notes-read-as-errors.md, and it is the reason this is not a dialog. A sheet over somebody's
  // conversation with machine wording on it gets read as something going wrong.
  const { voice } = await loadVoice();
  const markup = voice._overlayMarkup();
  assert.match(markup, /class="voice-overlay"/);
  assert.match(markup, /aria-live="polite"/, "the words reach a screen reader as they firm up");
  assert.match(markup, /hidden/, "and it starts away");
  for (const wrong of ["<h1", "<h2", "<h3", "<button", 'role="dialog"', 'role="alert"', "aria-modal", "Error", "Warning", "Failed"]) {
    assert.ok(!markup.includes(wrong), `${wrong} reached the panel, and it is neither a dialog nor a failure`);
  }
  assert.equal(voice._LISTENING_WORD, "Listening", "one plain word before the first one arrives, never a condition name");
  const styles = await read("ui/machine-room/styles.css");
  assert.match(styles, /\.voice-overlay:not\(\[hidden\]\)/, "[hidden] loses to an author display rule, which this file has been bitten by three times");
  assert.match(styles, /--glass-strong/, "the panel is the console's own glass rather than a new colour");
  assert.match(styles, /--blur-soft/);
  assert.match(styles, /prefers-reduced-motion[\s\S]*?\.voice-overlay-panel \{ transition: none/,
    "reduced motion skips the dissolve the way the orb animations already do");
  assert.match(styles, /\.voice-talk \{\n  touch-action: none;/, "a hold on a 38 px circle is otherwise a long-press menu");
});

test("VOICE-7 panel: it is mounted over the conversation and NEVER inside the footer's grid", async () => {
  // This is the whole of the footer proof and it is architectural rather than fought for. An element
  // inserted before #composer becomes a grid item of .control-shelf and adds a row to the footer,
  // which is the measured cause of VOICE-6. Nothing this panel does is inside that grid.
  const source = await read("ui/machine-room/voice.js");
  // The slice ends at the comment that follows mountOverlay rather than at the next function several
  // hundred lines away: VOICE-13's call screen now sits between the two, and it DOES read #composer --
  // a line typed on the call screen goes through the composer a person already uses -- which is a
  // different node for a different reason and was failing this claim about the panel.
  const mount = source.slice(source.indexOf("function mountOverlay"), source.indexOf("// ------------------------------------------------------- VOICE-7: the panel's state machine"));
  assert.match(mount, /querySelector\("\.conversation-space"\)/);
  assert.ok(!mount.includes('getElementById("composer")'), "the panel found its way into the composer's own row");
  assert.ok(!mount.includes("beforebegin"), "beforebegin on #composer is exactly what makes an element a grid item of the shelf");
  const html = await read("ui/machine-room/index.html");
  assert.match(html, /<section class="conversation-space"/, "the host this panel mounts into is gone");
});

// ------------------------------------------------------------------ the two talk modes
test("VOICE-7 modes: push to talk is the default, and nothing stored is still push to talk", async () => {
  const { voice } = await loadVoice();
  assert.deepEqual(voice._TALK_MODES, ["push", "always"]);
  assert.equal(voice._TALK_MODE_DEFAULT, "push");
  // The fake window has no localStorage at all, which is also a private window and a browser set to
  // refuse site data. The default is the answer in every one of those.
  assert.equal(voice.getTalkMode(), "push");
  const stored = await loadVoice({ window: { localStorage: { getItem: () => "whatever-mode", setItem: () => {} } } });
  assert.equal(stored.voice.getTalkMode(), "push", "a stored value nobody recognises is not obeyed");
});

test("VOICE-7 modes: the setting round-trips through the module's own door", async () => {
  const box = new Map();
  const storage = { getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) };
  const { voice } = await loadVoice({ window: { localStorage: storage } });
  assert.equal(voice.getTalkMode(), "push");
  assert.equal(voice.setTalkMode("always"), "always");
  assert.equal(voice.getTalkMode(), "always");
  assert.equal(box.get(voice._TALK_MODE_KEY), "always", "and it survives the next load of this page");
  const again = await loadVoice({ window: { localStorage: storage } });
  assert.equal(again.voice.getTalkMode(), "always");
  assert.equal(voice.setTalkMode("nonsense"), "push", "an unknown mode falls back rather than switching the button off");
});

test("VOICE-7 modes: always listening is a toggle, and one press ends the call once", async () => {
  const { voice, sent } = await loadTalking();
  voice.setTalkMode("always");
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(voice._state.on, true, "a press opens the line");
  assert.equal(voice._state.talking, true, "and the microphone is open, which is what the name says");
  // A release does nothing at all in this mode: the line is up until the next press.
  voice.talkUp();
  assert.equal(voice._state.on, true);
  await voice.talkDown();
  assert.equal(voice._state.on, false, "and a second press ends it");
  assert.equal(sent.json.filter((one) => one.t === "stop").length, 1, "the relay was told once, not twice");
});

test("VOICE-7 modes: push to talk holds while the button is down and shuts the microphone on the release", async () => {
  const { voice, sent } = await loadTalking();
  assert.equal(voice.getTalkMode(), "push");
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(voice._state.on, true, "the first hold opens the line");
  assert.equal(voice._state.held, true);
  assert.equal(voice._state.talking, true);

  // VOICE-11: a hold that said something. A release before the first frame has gone is a TAP and keeps
  // the microphone open for a moment longer, which is its own case below; this one is a real hold, so
  // one 100 ms frame goes through the capture first.
  capturePort.onmessage({ data: new Float32Array(2400) });
  voice.talkUp();
  assert.equal(voice._state.held, false);
  assert.equal(voice._state.talking, false, "the microphone shuts on the release");
  // THE LINE STAYS UP, so the second hold is instant rather than paying the dial again -- 1.6 to 2.0
  // seconds of it, measured through console.titanium.bot.
  assert.equal(voice._state.on, true);
  assert.equal(sent.json.filter((one) => one.t === "stop").length, 0, "a release is not a hang-up");

  // A second release with nothing held ends nothing twice.
  voice.talkUp();
  assert.equal(voice._state.talking, false);
  await voice.talkDown();
  assert.equal(voice._state.talking, true, "and the next hold opens it again with no second dial");
  assert.equal(voice._state.on, true);
  voice.stop();
  assert.equal(voice._state.held, false, "hanging up releases the hold as well");
});

test("VOICE-7 modes: one real press is ONE press, even though a phone sends two events for it", async () => {
  // A phone fires pointerdown AND touchstart for one thumb and both reach talkDown. MEASURED in real
  // Chrome at 390x844 with a real CDP touch hold and a refusal standing: the first of the two cleared
  // the note and the second found no note and dialled straight back into the same refusal -- the loop
  // Jason was stuck in ("you can't exit out of this talk mode"), reappearing through the second event
  // of the same gesture. The mouse, which fires only pointerdown, was correct.
  const { voice, sent, listeners } = await loadTalking();
  const button = { disabled: false };
  const event = { target: { closest: (selector) => (selector.includes("data-voice-talk") ? button : null) }, preventDefault() {} };
  const pointerdown = listeners.get("pointerdown");
  const touchstart = listeners.get("touchstart");
  const pointerup = listeners.get("pointerup");
  assert.equal(typeof pointerdown, "function");
  assert.equal(typeof touchstart, "function");

  // A refusal is standing, the way it is on a workspace with talking switched off.
  voice.stop("no-key");
  assert.deepEqual(voice.stats().notes, ["no-key"]);
  const dialsBefore = sent.json.length;

  // ONE press, two events.
  await pointerdown(event);
  await touchstart(event);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(voice._state.on, false, "the second event of one gesture redialled into the refusal it had just cleared");
  assert.equal(voice._state.held, false, "and it left the button drawn as held");
  assert.deepEqual(voice.stats().notes, [], "the press cleared the standing refusal, which is what it is for");
  assert.equal(sent.json.length, dialsBefore, "nothing was sent on a line that should never have opened");

  // AND THE NEXT PRESS WORKS. The gesture is spent by its own release, not for the life of the page.
  pointerup(event);
  await pointerdown(event);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(voice._state.on, true, "a fresh press after the release opens a line normally");
  assert.equal(voice._state.held, true);
  voice.stop();
});

test("VOICE-7 modes: push to talk captures BEFORE the line is up, and always listening does not", async () => {
  // The dial is 1.6 to 2.0 s through console.titanium.bot, and in push to talk the person is already
  // talking into a button they are holding down, so a capture that waited for the socket would lose
  // the first words of every first hold. Always listening keeps socket-first, because there a
  // refused line should never have touched the microphone at all.
  const source = await read("ui/machine-room/voice.js");
  const body = source.slice(source.indexOf("async function start("), source.indexOf("let heldTimer"));
  assert.match(body, /captureFirst/);
  assert.match(body, /PENDING_FRAME_CAP/, "the frames captured before the socket opened are bounded");
  assert.match(body, /if \(captureFirst\) \{\s*try \{ state\.capture = await beginCapture\(\)/,
    "push to talk opens the microphone first");
  assert.match(body, /await openSocket\(\);[\s\S]*if \(!captureFirst\)/, "and always listening opens the line first");
  const { voice } = await loadVoice();
  // Two seconds at a hundred milliseconds a frame, because the relay drops audio more than three
  // seconds ahead of its own wall clock and counts what it dropped as a held frame.
  assert.equal(voice._PENDING_FRAME_CAP, 20);
});

test("VOICE-7 modes: push to talk counts its silence apart from the echo gate's own drops", async () => {
  // The echo gate's number is the proof that the agent never hears himself, and the browser leg reads
  // it. Folding push-to-talk's between-holds silence into it would make that number unreadable the
  // moment anybody used the default.
  const { voice } = await loadTalking();
  const chunks = [];
  let talking = false;
  const capture = await voice.captureAudio({
    source: { getTracks: () => [] },
    frameBytes: 480,
    held: () => false,
    muted: () => talking !== true,
    onChunk: (buffer) => chunks.push(buffer),
    audio: {
      AudioContext: class {
        constructor() { this.audioWorklet = { addModule: async () => {} }; }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        close() {}
      },
      AudioWorkletNode: class { constructor() { this.port = {}; capturePort = this.port; } disconnect() {} },
      workletUrl: "blob:x",
    },
  });
  // Not talking: the frame is dropped and counted as muted, and it is not an echo hold.
  capturePort.onmessage({ data: new Float32Array(240) });
  assert.equal(capture.stats.mutedFrames, 1);
  assert.equal(capture.stats.heldFrames, 0, "silence between two holds is not the agent talking over somebody");
  assert.equal(chunks.length, 0);
  // Holding: it goes.
  talking = true;
  capturePort.onmessage({ data: new Float32Array(240) });
  assert.equal(chunks.length, 1);
  assert.equal(capture.stats.sent, 1);
  assert.equal(capture.stats.mutedFrames, 1, "and the muted count did not grow while somebody was talking");
  capture.stop();
});

test("VOICE-7 modes: the space bar bails on every other thing that wants it", async () => {
  // FIVE other keydown paths live on this document -- the transcript's own space handler, Escape
  // closing a drawer, the desktop chord, the composer's Enter and the command palette -- and the
  // box's screen is an iframe that takes keystrokes outright for the machine on the other side.
  const cases = [
    { what: "a text box", active: { tagName: "TEXTAREA" }, may: false },
    { what: "a field", active: { tagName: "INPUT" }, may: false },
    { what: "a dropdown", active: { tagName: "SELECT" }, may: false },
    { what: "the box's own screen", active: { tagName: "IFRAME" }, may: false },
    { what: "something being edited in place", active: { tagName: "DIV", isContentEditable: true }, may: false },
    { what: "another button", active: { tagName: "BUTTON", closest: () => null }, may: false },
    { what: "the talk button itself", active: { tagName: "BUTTON", closest: () => ({}) }, may: true },
    { what: "nothing at all", active: { tagName: "BODY" }, may: true },
  ];
  for (const one of cases) {
    const { voice } = await loadVoice({
      window: { MutationObserver: class { observe() {} }, document: fakeDocument({ activeElement: one.active }) },
    });
    assert.equal(voice._spaceMayTalk(), one.may, `the space bar with ${one.what} focused`);
  }
  const withDialog = await loadVoice({
    window: { MutationObserver: class { observe() {} }, document: fakeDocument({ querySelector: (s) => (s === "dialog[open]" ? {} : null) }) },
  });
  assert.equal(withDialog.voice._spaceMayTalk(), false, "an open dialog takes its own keys");
  const withDrawer = await loadVoice({
    window: { MutationObserver: class { observe() {} }, document: fakeDocument({ body: { dataset: { drawer: "people" } } }) },
  });
  assert.equal(withDrawer.voice._spaceMayTalk(), false, "and so does an open drawer");
  // And a half-typed message: a microphone opening on the same key as a sentence somebody is writing
  // is two things happening at once, and only one of them was asked for.
  const halfTyped = await loadVoice({
    window: { MutationObserver: class { observe() {} }, document: fakeDocument({ getElementById: (id) => (id === "message-input" ? { value: "half a thought" } : null) }) },
  });
  assert.equal(halfTyped.voice._spaceMayTalk(), false);
});

test("VOICE-7 modes: Escape ends the call, and never takes an Escape that belongs to somebody else", async () => {
  const { voice } = await loadTalking();
  voice.setTalkMode("always");
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(voice._state.on, true);
  assert.equal(voice._escapeStops(), true);
  assert.equal(voice._state.on, false, "Escape is the way out that needs no pointer");
  assert.equal(voice._escapeStops(), false, "and with nothing running there is nothing to stop");

  // app.js closes an open drawer on Escape and a dialog closes itself. Neither is ours to take.
  const drawer = await loadTalking({ document: fakeDocument({ body: { dataset: { drawer: "people" } } }) });
  drawer.voice._state.on = true;
  assert.equal(drawer.voice._escapeStops(), false, "an Escape meant for an open drawer ended a call instead");
  assert.equal(drawer.voice._state.on, true);
});

test("VOICE-7 modes: changing the mode ends the call rather than changing what the button means underneath it", async () => {
  const { voice } = await loadTalking();
  voice.setTalkMode("always");
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(voice._state.on, true);
  voice.setTalkMode("push");
  assert.equal(voice._state.on, false, "a live microphone whose control has changed meaning is a state nobody on screen can account for");
  assert.equal(voice.getTalkMode(), "push");
});

test("VOICE-7 modes: a forgotten hold does not spend a workspace's day", async () => {
  // The caps count WALL CLOCK, not audio. Push to talk keeps the line up between holds so the second
  // one is instant, so a press somebody walked away from would otherwise burn thirty minutes of a
  // hundred and twenty minute allowance with nobody in the room.
  const { voice } = await loadTalking();
  assert.equal(voice._PUSH_IDLE_CLOSE_MS, 60_000);
  const source = await read("ui/machine-room/voice.js");
  const idle = source.slice(source.indexOf("function armIdleClose"), source.indexOf("function socketUrl"));
  assert.match(idle, /if \(talkMode\(\) !== "push"\) return;/,
    "always listening has no such timer: there the line being up IS what the person asked for");
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 10));
  voice.talkUp();
  assert.equal(voice._state.on, true, "the line is warm for the next hold");
  voice.stop();

  const always = await loadTalking();
  always.voice.setTalkMode("always");
  await always.voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 10));
  always.voice.talkUp();
  assert.equal(always.voice._state.talking, true, "always listening does not shut the microphone on a release");
  always.voice.stop();
});

// ================================================================== VOICE-11
//
// THE RELEASE. holdEnd shut the microphone and sent nothing, and the only thing that ends a turn is
// the service's own turn detection, which fires on audio that keeps arriving. MEASURED on
// grok-bot-local-vm in Chromium and WebKit: a 900 ms hold and a release put 0 bytes and 0 JSON on the
// wire for 1.5 s while 15 captured frames were dropped. What a browser has to answer -- that a thumb's
// release really reaches the vendor, and that a phone's microphone context resumes inside the press --
// is scripts/verify-voice.mjs --leg release.

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** One 100 ms block of real sound, so a frame that is speech can be told from a frame that is silence. */
const loudBlock = () => {
  const block = new Float32Array(2400);
  for (let i = 0; i < block.length; i += 1) block[i] = 0.5;
  return block;
};
const isSilent = (buffer) => new Int16Array(buffer).every((sample) => sample === 0);

test("VOICE-11 release: the release sends the silence, eight frames of it, and they are really zeroes", async () => {
  const { voice, sent } = await loadTalking();
  await voice.talkDown();
  await settle(10);
  capturePort.onmessage({ data: loudBlock() });
  assert.equal(sent.audio.length, 1, "the hold's own frame went");
  assert.equal(isSilent(sent.audio[0]), false, "and it is sound, not silence");

  voice.talkUp();
  assert.equal(voice.stats().tailFrames, 1, "the first frame of it goes on the release itself, which is when the person stopped");
  await settle(900);
  assert.equal(voice.stats().tailFrames, voice._TAIL_FRAMES);
  const tail = sent.audio.slice(1);
  assert.equal(tail.length, 8, "eight frames, which is 800 ms against the relay's 700 ms window");
  for (const one of tail) {
    assert.equal(one.byteLength, voice._FRAME_BYTES, "a tail frame is the same 100 ms frame the microphone sends");
    assert.ok(isSilent(one), "a tail frame is silence, never a repeat of the last thing said");
  }
  assert.equal(voice.stats().sent, 1, "and the microphone's own count did not grow: nobody said these");
  assert.equal(sent.json.filter((one) => one.t === "stop").length, 0, "a release is still not a hang-up");
  voice.stop();
});

test("VOICE-11 release: the tail is longer than the window the relay asks the service to wait", async () => {
  const { voice } = await loadVoice();
  const { TURN_DETECTION } = await import("../ui/voice-edge.mjs");
  // READ OFF THE RELAY, not retyped. The whole point of the tail is that it outlasts the silence the
  // service is told to wait for, so the two numbers cannot be allowed to drift apart in two files.
  assert.ok(voice._RELEASE_TAIL_MS > TURN_DETECTION.silence_duration_ms,
    `the tail is ${voice._RELEASE_TAIL_MS} ms and the service waits ${TURN_DETECTION.silence_duration_ms} ms before it calls a turn over`);
  assert.equal(voice._FRAME_MS, 100, "the pacing is the frame, derived rather than repeated");
  assert.equal(voice._TAIL_FRAMES, Math.ceil(voice._RELEASE_TAIL_MS / voice._FRAME_MS));

  // AND IT IS NOT THE MANUAL COMMIT. Both vendors document one, and it needs turn detection switched
  // off in the session frame -- which this bridge writes once and byte-identically for the life of the
  // socket, because rewriting it re-bills the whole conversation on one of the two services.
  const source = await read("ui/machine-room/voice.js");
  assert.doesNotMatch(source, /["'`]input_audio_buffer\.commit/,
    "the page must not reach for the provider's manual commit; the silence is what ends the turn");
});

test("VOICE-11 release: a tap says something instead of dialling an empty line", async () => {
  const { voice, sent } = await loadTalking();
  await voice.talkDown();
  await settle(10);
  // Released before a single frame has gone, which at the 1800 ms dial console.titanium.bot has is
  // every tap: shipped, this opened a whole line and said nothing into it.
  voice.talkUp();
  assert.equal(voice._state.held, false, "the hold is over as far as the button is concerned");
  assert.equal(voice._state.talking, true, "but the microphone stays open until a frame has gone or the window ends");
  await settle(voice._MIN_HOLD_MS + 80);
  assert.equal(voice._state.talking, false);
  assert.equal(voice.stats().tailFrames, 0, "no silence is sent for a hold that said nothing");
  assert.equal(sent.audio.length, 0);
  assert.deepEqual(voice.stats().notes, ["hold-to-talk"]);
  assert.equal(voice._NOTES["hold-to-talk"], "Hold the button while you talk.");
  voice.stop();

  // AND A HOLD THAT WAS ONLY JUST LONG ENOUGH PAYS NOTHING FOR THAT RULE: the first frame closes the
  // window rather than the timer doing it.
  const second = await loadTalking();
  await second.voice.talkDown();
  await settle(10);
  second.voice.talkUp();
  capturePort.onmessage({ data: loudBlock() });
  assert.equal(second.voice._state.talking, false, "the frame closed the window");
  assert.equal(second.voice.stats().tailFrames, 1, "and the release sent its silence after it");
  assert.deepEqual(second.voice.stats().notes, [], "nothing was said to somebody who really did hold it");
  second.voice.stop();
});

test("VOICE-11 release: a new hold drops what is left of the last release's silence", async () => {
  const { voice } = await loadTalking();
  await voice.talkDown();
  await settle(10);
  capturePort.onmessage({ data: loudBlock() });
  voice.talkUp();
  await settle(150);
  const partway = voice.stats().tailFrames;
  assert.ok(partway >= 1 && partway < voice._TAIL_FRAMES, `the tail is part way through: ${partway} of ${voice._TAIL_FRAMES}`);
  await voice.talkDown();
  await settle(500);
  assert.equal(voice.stats().tailFrames, partway,
    "the rest of it was dropped: silence arriving under a new hold would end the turn the person is still speaking into");
  voice.stop();
});

test("VOICE-11 release: at a line that was still opening, the silence queues behind the words", async () => {
  // Push to talk captures BEFORE the line is up and the dial is 1.6 to 2.0 s, so a short hold is
  // entirely inside it: the words AND the release's silence are both queued, and the order is the
  // whole claim -- silence flushed before the words would end a turn that had not started.
  const sent = { frames: 0, json: [], audio: [] };
  class LateSocket {
    constructor() {
      this.readyState = 0;
      this.handlers = {};
      setTimeout(() => { this.readyState = 1; this.handlers.open?.({}); }, 300);
    }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    send(payload) {
      sent.frames += 1;
      if (typeof payload === "string") { try { sent.json.push(JSON.parse(payload)); } catch { /* audio */ } }
      else sent.audio.push(payload);
    }
    close() { this.readyState = 3; }
  }
  const { voice } = await loadVoice({ window: { __voiceSocketClass: LateSocket, ...fakeAudioWindow() } });
  void voice.talkDown();
  await settle(20);
  capturePort.onmessage({ data: loudBlock() });
  capturePort.onmessage({ data: loudBlock() });
  assert.equal(sent.audio.length, 0, "nothing has reached the wire yet, because the line is still opening");
  voice.talkUp();
  await settle(1200);

  assert.equal(sent.audio.length, 10, "two frames of speech and eight of silence");
  assert.deepEqual(sent.audio.map((one) => isSilent(one)),
    [false, false, true, true, true, true, true, true, true, true],
    "the words went first and the silence after them");
  voice.stop();
});

test("VOICE-11 re-arm: a refusal eats one press and no more", async () => {
  const { voice, listeners } = await loadTalking();
  const button = { disabled: false };
  const event = { target: { closest: (selector) => (selector.includes("data-voice-talk") ? button : null) }, preventDefault() {} };
  const down = listeners.get("pointerdown");
  const up = listeners.get("pointerup");

  voice.stop("no-key");
  assert.deepEqual(voice.stats().notes, ["no-key"]);
  await down(event);
  await settle(20);
  assert.equal(voice._state.on, false, "a press into a refusal that just went up clears it and does not dial back into it");
  assert.deepEqual(voice.stats().notes, []);
  up(event);

  // THE SAME REFUSAL, ONCE THE PERSON HAS HAD TIME TO READ IT. Shipped, this press was eaten too --
  // however long the sentence had been up -- so every start while one was standing cost two presses
  // with nothing on screen to say the first had been spent.
  voice.stop("no-key");
  voice._state.notes[0].at -= voice._REARM_COOLDOWN_MS + 100;
  await down(event);
  await settle(20);
  assert.equal(voice._state.on, true, "the next press clears the sentence AND opens a line, in one press");
  assert.deepEqual(voice.stats().notes, []);
  voice.stop();
});

test("VOICE-11 re-arm: a gesture whose release was lost does not eat every press after it", async () => {
  const { voice, listeners } = await loadTalking();
  const button = { disabled: false };
  const event = { target: { closest: (selector) => (selector.includes("data-voice-talk") ? button : null) }, preventDefault() {} };
  const down = listeners.get("pointerdown");

  voice.stop("no-key");
  // The press that clears the sentence, and no pointerup, touchend or blur ever arrives for it.
  await down(event);
  await settle(20);
  assert.equal(voice._state.on, false);
  await settle(voice._GESTURE_MS + 80);
  await down(event);
  await settle(20);
  assert.equal(voice._state.on, true,
    "a spent gesture with no release used to eat every press for the life of the page");
  voice.stop();

  // AND THE HOLD ITSELF. A talkDown arriving while a hold is already live is the second event of one
  // gesture if it is this close to it, and a NEW press whose predecessor's release was lost if it is not.
  const { voice: second } = await loadTalking();
  await second.talkDown();
  await settle(10);
  capturePort.onmessage({ data: loudBlock() });
  await second.talkDown();
  assert.equal(second.stats().tailFrames, 0, "the second event of one gesture does not end the hold it belongs to");
  await settle(second._GESTURE_MS + 80);
  await second.talkDown();
  assert.equal(second._state.held, true, "the new press is holding");
  assert.equal(second.stats().tailFrames, 1,
    "and the hold it replaced was ended properly rather than left open underneath it");
  second.stop();
});

test("VOICE-11 re-arm: a hold whose release never arrives closes the microphone on its own", async () => {
  // The window's own setTimeout is what the module takes its timers from, so thirty seconds can be
  // made to pass without waiting thirty of them. Only the ceiling is shortened; every other timer in
  // the module keeps its real number, and the constant is asserted here so a change to it fails loudly
  // rather than silently making this test measure a timer that no longer exists.
  const { voice } = await loadTalking({ setTimeout: (fn, ms) => setTimeout(fn, ms === 30_000 ? 30 : ms) });
  assert.equal(voice._MAX_HOLD_MS, 30_000);
  await voice.talkDown();
  await settle(10);
  capturePort.onmessage({ data: loudBlock() });
  // No pointerup, no touchend, no pointercancel, no blur, no keyup: a phone that backgrounded the tab
  // mid-hold delivers none of them, and nothing but a release ever closed this microphone.
  await settle(150);
  assert.equal(voice._state.held, false, "the ceiling ended the hold");
  assert.equal(voice._state.talking, false, "and closed the microphone");
  assert.ok(voice.stats().tailFrames >= 1, `the words that were said still became a turn (${voice.stats().tailFrames} frames of silence after them)`);
  assert.equal(voice._state.on, true, "and it is not a hang-up: the line is still warm for the next press");
  voice.stop();
});

test("VOICE-11 microphone: three ways it can refuse, three different sentences", async () => {
  const { voice } = await loadVoice();
  for (const [name, condition] of [
    ["NotAllowedError", "no-microphone"], ["SecurityError", "no-microphone"],
    ["NotFoundError", "no-microphone-device"], ["OverconstrainedError", "no-microphone-device"],
  ]) {
    assert.equal(voice._micConditionFor({ name }), condition, `${name} reads as ${condition}`);
  }
  assert.equal(voice._micConditionFor(Object.assign(new Error("no worklet"), { cannotRecord: true })), "no-recording");
  const three = new Set(["no-microphone", "no-microphone-device", "no-recording"].map((one) => voice._sentenceFor(one)));
  assert.equal(three.size, 3, "three conditions, three sentences, where one sentence used to serve all of them");

  // Through the real path, which is what shipped wrong: every one of these ended on the sentence that
  // tells somebody to allow a microphone they do not have.
  const absent = await loadTalking({
    navigator: { mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error("none"), { name: "NotFoundError" }); } } },
  });
  await absent.voice.talkDown();
  await settle(40);
  assert.deepEqual(absent.voice.stats().notes, ["no-microphone-device"]);

  const cannot = await loadTalking({ navigator: {} });
  await cannot.voice.talkDown();
  await settle(40);
  assert.deepEqual(cannot.voice.stats().notes, ["no-recording"],
    "a browser with no mediaDevices at all threw a TypeError on a property read, which reads as a bug in this file");
});

test("VOICE-11 microphone: in the app the denied sentence names iPhone Settings, and no user agent decides it", async () => {
  const { voice } = await loadVoice();
  const shell = await loadVoice({
    window: { __titanbotShell: { platform: "ios", build: "1", canOpenAppSettings: true } },
  });
  assert.match(voice._sentenceFor("no-microphone"), /browser/i, "in a browser it is the browser's permission");
  assert.match(shell.voice._sentenceFor("no-microphone"), /iPhone Settings/,
    "in the app it is the app's, and 'allow it in your browser' is advice nobody can follow there");
  assert.doesNotMatch(shell.voice._sentenceFor("no-microphone"), /browser/i);
  // A shell that cannot open its own settings gets the browser wording, because that is what it can do.
  const plain = await loadVoice({ window: { __titanbotShell: { platform: "macos", build: "1", canOpenAppSettings: false } } });
  assert.equal(plain.voice._sentenceFor("no-microphone"), voice._sentenceFor("no-microphone"));
  // And every other sentence is the same in both, because only this one is about a permission.
  for (const condition of Object.keys(voice._NOTES)) {
    if (condition === "no-microphone") continue;
    assert.equal(shell.voice._sentenceFor(condition), voice._sentenceFor(condition), `${condition} is the same in the app`);
  }
  const source = await read("ui/machine-room/voice.js");
  assert.doesNotMatch(source, /userAgent/, "which host this is, is a thing the host says, never a string that is sniffed");
});

test("VOICE-11 microphone: a microphone that opened and produces nothing says so", async () => {
  // A live button over a dead microphone is the worst of the microphone conditions, because nothing on
  // screen looks wrong. The worklet posts a block every 128 samples once the graph is running, so a
  // second with no block at all is a graph that is not running -- a context a phone never resumed.
  const { voice } = await loadTalking();
  await voice.talkDown();
  await settle(20);
  assert.deepEqual(voice.stats().notes, [], "nothing is said while the second is still running");
  await settle(voice._SOUND_WATCH_MS + 150);
  assert.deepEqual(voice.stats().notes, ["no-sound"]);
  voice.stop();

  const working = await loadTalking();
  await working.voice.talkDown();
  await settle(20);
  capturePort.onmessage({ data: loudBlock() });
  assert.equal(working.voice.stats().blocks, 1);
  await settle(working.voice._SOUND_WATCH_MS + 150);
  assert.deepEqual(working.voice.stats().notes, [], "and a microphone that is producing is left alone");
  working.voice.stop();
});

test("VOICE-11 capture: the audio context is made and resumed before the microphone is asked for", async () => {
  // WebKit births an AudioContext SUSPENDED and only a user gesture resumes one, and the gesture is
  // spent by the first await in the handler. A context created after `await getUserMedia` -- which is
  // what shipped -- stays suspended on a phone: the worklet never runs and the page draws a live button
  // over a microphone that produces nothing. This is the whole reason voice does nothing in the app.
  const order = [];
  let resumed = 0;
  class SuspendedContext {
    constructor() {
      order.push("context");
      this.state = "suspended";
      this.audioWorklet = { addModule: async () => { order.push("worklet"); } };
      this.currentTime = 0;
    }
    resume() { resumed += 1; this.state = "running"; order.push("resume"); return new Promise(() => {}); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 2048, connect() {}, getFloatTimeDomainData() {} }; }
    close() { order.push("close"); }
  }
  const { voice } = await loadTalking({
    AudioContext: SuspendedContext,
    navigator: { mediaDevices: { getUserMedia: async () => { order.push("getUserMedia"); return { getTracks: () => [] }; } } },
  });
  await voice.talkDown();
  await settle(30);
  assert.deepEqual(order.slice(0, 3), ["context", "resume", "getUserMedia"],
    "the context is born and resumed inside the press, and nothing is awaited above the microphone");
  assert.equal(resumed, 1);
  voice.stop();

  // AND A REFUSED PRESS GIVES THE CONTEXT BACK. It is made first now, so one suspended context per
  // refusal would be a leak somebody pays for in battery.
  order.length = 0;
  const refused = await loadTalking({
    AudioContext: SuspendedContext,
    navigator: { mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); } } },
  });
  await refused.voice.talkDown();
  await settle(40);
  assert.ok(order.includes("close"), "the context a refused press made was closed");
  assert.deepEqual(refused.voice.stats().notes, ["no-microphone"]);
});

test("VOICE-7 modes: one pair of entry points, so the desktop app's hotkey inherits the setting", async () => {
  // docs/APPS.md section 6: the shell's global hotkey is a later wave and it presses THIS control. A
  // hotkey with its own copy of the behaviour would be a third thing to keep in step with a setting a
  // person can change.
  const { voice } = await loadVoice();
  for (const door of ["talkDown", "talkUp", "setTalkMode", "getTalkMode"]) {
    assert.equal(typeof voice[door], "function", `${door} is the door the hotkey needs`);
  }
  const source = await read("ui/machine-room/voice.js");
  const wired = source.slice(source.indexOf("function wire()"), source.indexOf("// The console repaints wholesale"));
  for (const listener of ["pointerdown", "pointerup", "pointercancel", "touchstart", "touchend", "touchcancel", "contextmenu", "keydown", "keyup"]) {
    assert.ok(wired.includes(`"${listener}"`), `push to talk needs ${listener} and it is not wired`);
  }
  // The keydown path is a NAMED handler rather than an inline listener, because Escape and the space
  // bar are two questions about the same key and the console's own Escape already lived there.
  const keys = source.slice(source.indexOf("function onKeyDown"), source.indexOf("function onKeyUp"));
  assert.match(keys, /event\.repeat/, "a held key repeats, and without a latch the handler fires tens of times a second");
  assert.match(keys, /spaceMayTalk\(\)/, "the space bar must ask whether it is allowed to be the hold");
  assert.match(wired, /"blur", release/,
    "a window that loses focus never delivers the keyup for a space bar that is still down");
  // VOICE-13 sends this press through talkDown rather than straight to toggle(), so that a phone in
  // always listening opens a call screen by this road like every other road. The guard is the claim and
  // the guard is unchanged: in push to talk a click still does nothing on top of the hold.
  assert.match(wired, /if \(talkMode\(\) !== "push"\) void talkDown\(\)/,
    "a click in push to talk must not toggle on top of the hold that pointerdown already handled");
});

test("VOICE-7 modes: a key another handler already acted on is not also a microphone", async () => {
  // This listener is on the document, so it runs after every handler between it and the thing that was
  // focused. app.js's transcript handler opens an evidence row or an agent-to-agent blurb on the space
  // bar and calls preventDefault; the palette and the composer do the same with their own keys. Found
  // while reading app.js's five existing keydown paths, not after a bug report.
  const source = await read("ui/machine-room/voice.js");
  const wired = source.slice(source.indexOf("function wire()"), source.indexOf("// The console repaints wholesale"));
  assert.match(wired, /addEventListener\("keydown", onKeyDown\)/, "the keydown handler is not wired at all");
  const keydown = source.slice(source.indexOf("function onKeyDown"), source.indexOf("function onKeyUp"));
  assert.match(keydown, /if \(event\?\.defaultPrevented === true\) return;/,
    "the space bar would be taken from a control that had already acted on it");

  // And the transcript's own focusable rows, which are controls by their ROLE rather than their tag:
  // an agent-to-agent blurb is a div carrying role="button" and tabindex="0".
  const blurb = await loadVoice({
    window: {
      MutationObserver: class { observe() {} },
      document: fakeDocument({ activeElement: { tagName: "DIV", getAttribute: (name) => (name === "role" ? "button" : null), closest: () => null } }),
    },
  });
  assert.equal(blurb.voice._spaceMayTalk(), false, "a focusable transcript row had its space bar taken");
  const evidence = await loadVoice({
    window: {
      MutationObserver: class { observe() {} },
      document: fakeDocument({ activeElement: { tagName: "DIV", getAttribute: () => null, closest: (sel) => (sel.includes("data-evidence") ? {} : null) } }),
    },
  });
  assert.equal(evidence.voice._spaceMayTalk(), false);
  // The talk button still gets its own space bar even when it is a control by role.
  const talk = await loadVoice({
    window: {
      MutationObserver: class { observe() {} },
      document: fakeDocument({ activeElement: { tagName: "DIV", getAttribute: (name) => (name === "role" ? "button" : null), closest: (sel) => (sel.includes("data-voice-talk") ? {} : null) } }),
    },
  });
  assert.equal(talk.voice._spaceMayTalk(), true);
});

test("VOICE-7 panel: a long utterance keeps its newest words in view", async () => {
  // The panel has a ceiling so it can never cover the whole conversation, and nothing in it can be
  // scrolled by hand: pointer events are off on purpose so the chat underneath stays clickable while
  // somebody is talking. So the words being said right now are kept in view from the paint instead.
  const styles = await read("ui/machine-room/styles.css");
  assert.match(styles, /\.voice-overlay \{[\s\S]*?pointer-events: none;/, "the panel must not take clicks from the conversation");
  assert.match(styles, /\.voice-overlay-panel \{[\s\S]*?overflow-y: auto;/);
  const source = await read("ui/machine-room/voice.js");
  const paint = source.slice(source.indexOf("function paintOverlay"), source.indexOf("async function start("));
  assert.match(paint, /panel\.scrollTop = panel\.scrollHeight/,
    "a long utterance would scroll its newest words out of sight with no way to reach them");
});

test("VOICE-7 row: the choice is a row under General > System, in plain words", async () => {
  // WHERE THE ITEM ASKED FOR IT: "In Settings under General > System, a row 'Talk mode' with two
  // choices in plain words." The settings surface that landed beside this wave owns that section, so
  // the row is declared there, the way Theme and Microphone are, rather than on a card of voice's own.
  const source = await read("ui/machine-room/settings.js");
  const rows = new Function("window", source)({ document: undefined }) ?? null;
  const mr = rows ?? (() => { const stub = { document: undefined }; new Function("window", source)(stub); return stub.__mrSettings; })();
  const general = mr.rowsFor("general", { talkMode: "push" });
  const row = general.find((one) => one.id === "talk-mode");
  assert.ok(row != null, "there is no Talk mode row, so nobody can change how the button behaves");
  assert.equal(row.group, "system", "it belongs beside Microphone and the talking switch");
  assert.equal(row.label, "Talk mode");

  // ONE ROW, ONE CONTROL, which is the whole rule of this surface (docs/SETTINGS.md 1).
  assert.equal(row.control.kind, "select");
  assert.equal(row.control.action, "talk-mode");
  assert.deepEqual(row.control.options.map((one) => one.value), ["push", "always"]);
  assert.deepEqual(row.control.options.map((one) => one.label), [
    "Push to talk: hold the button while you speak",
    "Always listening: press once to start, press again to stop",
  ], "the two ways to talk, written out the way a person would say them");
  assert.equal(row.control.value, "push", "the row opens on the mode the page is really in");
  assert.equal(mr.rowsFor("general", { talkMode: "always" }).find((one) => one.id === "talk-mode").control.value, "always");

  // AND NOTHING, drawn on a console with no voice module at all: the PROXY-1 rule this surface keeps
  // everywhere else. A control that cannot do anything is worse than an absent one.
  assert.equal(mr.rowsFor("general", {}).find((one) => one.id === "talk-mode"), undefined);

  // Nothing in the row names a service, a model or a protocol -- the VOICE-1 rule, re-checked because
  // this row adds copy a customer reads.
  const words = `${row.label} ${row.line} ${row.control.options.map((one) => one.label).join(" ")}`;
  for (const leak of ["xAI", "OpenAI", "Grok", "sendPrompt", "websocket", "VAD", "turn_detection"]) {
    assert.ok(!words.includes(leak), `${leak} reached a row a customer reads`);
  }
});

test("VOICE-10 row: the choice is the PERSON's, with this browser as the fallback", async () => {
  // WHAT CHANGED AND WHY. Until VOICE-10 this value lived in the browser and nowhere else, and this
  // test said so: /voice/settings is one file per workspace and two people sharing one would have
  // fought over how their own button behaves. That reasoning was right about the FILE and wrong about
  // the door. The door now keys the value on the session's own person claim -- the same key the device
  // list and the notification settings use -- so two accounts on one workspace keep their own, and the
  // browser's copy is what still works in a private window and on a relay that has never heard of the
  // field.
  //
  // The order is the contract: this browser FIRST, always, and the route after. A relay that refuses or
  // never answers must leave the button doing what was asked of it.
  const box = new Map();
  const storage = { getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) };
  const asked = [];
  const fetch_ = async (path, init) => {
    asked.push({ path, body: init?.body == null ? null : JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
  };
  const { voice } = await loadVoice({ window: { localStorage: storage, fetch: fetch_ } });
  assert.equal(voice.getTalkMode(), "push", "nothing stored is push to talk, the mode that cannot leave a microphone open");
  assert.equal(voice.setTalkMode("always"), "always");
  assert.equal(box.get(voice._TALK_MODE_KEY), "always", "this browser's copy is written first and is the behaviour");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const write = asked.find((one) => one.body != null && one.body.talkMode != null);
  assert.ok(write != null, "the person's own door was never told, so the choice cannot follow them to a phone");
  assert.equal(write.path, "/voice/settings");
  assert.deepEqual(write.body, { talkMode: "always" }, "one field, and nothing else of the workspace's is touched");

  // A second page in the same browser opens on the choice the first one made.
  const again = await loadVoice({ window: { localStorage: storage, fetch: fetch_ } });
  assert.equal(again.voice.getTalkMode(), "always");
  // And a value nobody offered is refused rather than stored.
  assert.equal(voice.setTalkMode("whenever"), "push");
  const source = await read("ui/machine-room/voice.js");
  assert.ok(source.includes("localStorage?.setItem(TALK_MODE_KEY"), "this browser's copy is the fallback and it is still written");
});

test("VOICE-10 boot: a route that throws leaves this browser's stored value as the behaviour", async () => {
  // THE PRIVATE WINDOW AND THE OLD RELAY, which are the same case from the page's side: nothing comes
  // back, and the button still has to know which of the two things it is.
  const box = new Map([["titanbot.voice.talkMode", "always"]]);
  const storage = { getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) };
  const { voice } = await loadVoice({
    window: { localStorage: storage, fetch: async () => { throw new Error("the relay did not answer"); } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(voice.getTalkMode(), "always", "a read that threw took the person's own choice away with it");

  // And a relay that answers but has never heard of the field: an ABSENT talk mode is not a default
  // arriving, it is nobody having chosen, so this browser keeps what it holds.
  const older = await loadVoice({
    window: {
      localStorage: storage,
      fetch: async () => ({ ok: true, status: 200, text: async () => "{}", json: async () => ({ enabled: false, available: false }) }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(older.voice.getTalkMode(), "always", "an answer with no talk mode in it was read as a default and overwrote a real choice");
});

test("VOICE-10 boot: a value adopted from the route never ends the call somebody is in", async () => {
  // setTalkMode ENDS the call when the mode really changes, and that is right for a person choosing: a
  // line that is up while the control which opened it has changed meaning underneath them is a
  // microphone nobody on screen can account for. It is WRONG for an answer landing on its own, because
  // nobody pressed anything. So the adopt door is a different door, and this is the case that says so.
  const box = new Map();
  const storage = { getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) };
  const { voice, sent } = await loadTalking({ localStorage: storage });
  assert.equal(voice.getTalkMode(), "push");
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(voice._state.on, true, "the line is up for this case to be about anything");

  const stops = sent.json.filter((one) => one.t === "stop").length;
  assert.equal(voice._adoptTalkMode("always"), "push", "the mode a live call was opened under is the mode it keeps");
  assert.equal(voice._state.on, true, "a route answer cut a call in half");
  assert.equal(sent.json.filter((one) => one.t === "stop").length, stops, "and told the relay to stop");

  // With no call up it is taken, and remembered, so the next page in this browser opens on it too.
  voice.stop();
  assert.equal(voice._adoptTalkMode("always"), "always");
  assert.equal(voice.getTalkMode(), "always");
  assert.equal(box.get(voice._TALK_MODE_KEY), "always");
  // And nonsense from a relay is not a mode. It is NOT the default either: a default arriving would
  // overwrite a real choice with one nobody made.
  assert.equal(voice._adoptTalkMode("sideways"), "always");
  assert.equal(voice._adoptTalkMode(undefined), "always");
});

test("VOICE-10 boot: an answer already in the air when this page chose does not publish the older value", async () => {
  // THE DEFECT THIS PINS, and it shipped green through every unit suite. The boot read of the person's
  // own door and a press are two producers of one value. MEASURED on MacBook-Pro.local 2026-09-11 by
  // verify-voice --leg overlay at 1440x900 and 390x844: a combination that chose always listening after
  // that read had started came up in PUSH -- the microphone shut between presses and the Talk mode row
  // on screen read push -- at both viewports, while the door held always. Same shape as SETTINGS-3 one
  // layer down, and the rule is the same: a read that was in flight when the page chose loses.
  const box = new Map();
  const storage = { getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) };
  const { voice } = await loadTalking({ localStorage: storage });
  assert.equal(voice.getTalkMode(), "push");

  // The read starts, the person chooses, and only then does the answer land.
  const askedAt = Date.now();
  voice.setTalkMode("always");
  assert.equal(voice.getTalkMode(), "always", "the press itself did not take");
  assert.equal(voice._adoptTalkMode("push", askedAt), "always",
    "a door answer older than the page's own choice was published over it");
  assert.equal(voice.getTalkMode(), "always");
  assert.equal(box.get(voice._TALK_MODE_KEY), "always", "and it was stored over too");

  // An answer that was asked for AFTER the choice is a real answer and is taken: that is the same
  // person choosing somewhere else, which is the whole point of VOICE-10.
  assert.equal(voice._adoptTalkMode("push", Date.now() + 5), "push");
  assert.equal(voice.getTalkMode(), "push");
});

test("VOICE-8 rows: the operator's four, with the attributes the old card carried", async () => {
  const { voice } = await loadVoice();
  const rows = voice._TALKING_ROWS;
  assert.deepEqual(rows.map((one) => one.id), ["voice-service", "voice-model", "voice-voice", "voice-agent"]);
  assert.deepEqual(rows.map((one) => one.label), ["Service", "Model", "Voice", "Who you are talking to"]);
  // THE SAME FOUR ATTRIBUTES, so the gate's existing selectors measure the real thing rather than a new
  // name for it. The old card is at b1f9afa if anybody wants to read them side by side.
  const markup = rows.map((one) => one.control()).join("");
  for (const attribute of ["data-voice-vendor", "data-voice-model", "data-voice-voice", "data-voice-agent"]) {
    assert.ok(markup.includes(attribute), `${attribute} is not on any of the four controls`);
  }
  // ONE control each, and no data-settings-action on any of them: the surface's act() has no default
  // branch, so an action it does not know is swallowed with no error -- a control that looks wired and
  // is not.
  for (const row of rows) {
    const control = row.control();
    assert.equal(control.match(/class="setting-control/g).length, 1, `${row.id} draws more than one control slot`);
    assert.ok(!control.includes("data-settings-action"), `${row.id} carries a settings action the surface would swallow`);
    assert.ok(row.line.length > 0, `${row.id} has no explanation line`);
  }
  // An empty model or voice means the service's own, and the placeholder is where that is said.
  assert.ok(rows.find((one) => one.id === "voice-model").control().includes('placeholder="The service\'s own"'));
  // NO KEY FIELD, and no password field, came back with them.
  assert.ok(!markup.includes("password"), "a key field came back with the four rows");
  assert.ok(!/\bapiKey\b/.test(markup));
  // And no vendor's name on any of the copy: the Service labels come off the route, which names none.
  const words = rows.map((one) => `${one.label} ${one.line}`).join(" ");
  for (const leak of ["xAI", "OpenAI", "Grok", "realtime"]) assert.ok(!words.includes(leak), `${leak} is in the copy of these rows`);
});

test("VOICE-8 rows: they register into the operator section's Talking group and nowhere else", async () => {
  const registered = [];
  const { voice } = await loadVoice({
    window: { __mrSettings: { register: (entry) => { registered.push(entry); return true; } } },
  });
  assert.equal(registered.length, 4, "boot did not register the four rows");
  for (const entry of registered) {
    assert.equal(entry.section, "operator", `${entry.id} registered on a customer's section`);
    assert.equal(entry.group, "talking");
    assert.equal(entry.operatorOnly, true, `${entry.id} would be drawn for a customer`);
    assert.equal(typeof entry.markup, "function");
    assert.equal(typeof entry.fill, "function");
  }
  // ONCE. register() repaints the section when it is the one on screen, and a repaint dispatches the
  // surface's own section event -- which is what a console that served the two files in the other order
  // registers on. Calling again is a no-op rather than four more rows.
  assert.equal(voice._registerTalkingRows(), true);
  assert.equal(registered.length, 4, "a second call registered the rows again");
});

// ------------------------------------------------------------------ VOICE-13: the call screen
//
// Jason recorded ChatGPT's voice mode on his iPhone and said "this is what I want". These cases pin the
// four things that cannot be measured in a browser cheaply: which windows get a screen at all, which of
// the five words is true, that one thumb's two events open ONE screen and dial ONE line, and that every
// path out of a call puts the page back the way it found it.

/**
 * The smallest document this screen can be driven against. It is hand-rolled rather than a DOM library
 * because the module only ever asks for five things -- getElementById, querySelector, querySelectorAll,
 * body.insertAdjacentHTML and a node's attributes -- and a library would hide which of them the screen
 * really depends on.
 */
function callDom(options = {}) {
  const made = (attrs = {}) => {
    const self = {
      _attrs: { ...attrs }, _on: {}, _find: {}, _findAll: {}, _kids: [],
      hidden: false, textContent: "", value: "", inert: false, dataset: {},
      scrollHeight: 1000, scrollTop: 0,
      style: { setProperty() {}, removeProperty() {} },
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      getAttribute: (k) => (Object.hasOwn(self._attrs, k) ? self._attrs[k] : null),
      setAttribute: (k, v) => { self._attrs[k] = String(v); },
      removeAttribute: (k) => { delete self._attrs[k]; },
      addEventListener: (name, fn) => { (self._on[name] ??= []).push(fn); },
      appendChild: (node) => { self._kids.push(node); return node; },
      // Every node takes one and most do nothing with it: voice.js's own line mounts into #composer,
      // which this document really does answer, and a node that cannot take HTML throws there.
      insertAdjacentHTML: () => {},
      remove: () => {},
      cloneNode: () => made(self._attrs),
      closest: (sel) => self._closest?.[sel] ?? null,
      querySelector: (sel) => self._find[sel] ?? null,
      querySelectorAll: (sel) => self._findAll[sel] ?? [],
      fire: (name, event = {}) => { for (const fn of self._on[name] ?? []) fn({ preventDefault() {}, ...event }); },
    };
    return self;
  };
  const byId = new Map();
  const screen = made({ id: "voice-call" });
  for (const part of ["face", "halo", "status", "state", "mute", "card-slot", "input", "output", "route", "retry"]) {
    screen._find[`[data-voice-call-${part}]`] = made();
  }
  // VOICE-15. The toggle's label lives inside the toggle; the module reads it by its own attribute.
  screen._find["[data-voice-call-output]"]._find["[data-voice-call-output-label]"] = made();
  screen._find["[data-voice-call-card-slot]"] = made();
  const shell = made();
  const space = made();
  const transcript = made();
  const composer = made();
  const box = made();
  let submitted = null;
  composer.requestSubmit = () => { submitted = box.value; };
  const note = made({ id: "voice-call-ended" });
  note.hidden = true;
  space.insertAdjacentHTML = () => { byId.set("voice-call-ended", note); };
  const body = made();
  body.insertAdjacentHTML = () => { byId.set("voice-call", screen); };
  const document_ = {
    readyState: "complete",
    visibilityState: options.visibilityState ?? "visible",
    hidden: false,
    body,
    head: { appendChild() {} },
    createElement: () => made(),
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (sel) => ({
      ".app-shell": shell, ".conversation-space": space, "#composer": composer,
    }[sel] ?? null),
    querySelectorAll: (sel) => document_._rows[sel] ?? [],
    addEventListener: () => {},
    _rows: {},
  };
  byId.set("transcript", transcript);
  byId.set("composer", composer);
  byId.set("message-input", box);
  return { document: document_, screen, shell, space, transcript, box, note, made, submitted: () => submitted };
}

const systemRow = (make, id, words) => {
  const row = make({ "data-message-id": id, class: "message-row is-system" });
  const bubble = make();
  bubble.textContent = words;
  row._find[".message-bubble"] = bubble;
  return row;
};

test("VOICE-13 call: which windows get a screen, and LINE_SHELF_WIDTH is not the same question", async () => {
  const phone = await loadVoice({ window: { innerWidth: 390, innerHeight: 844 } });
  assert.equal(phone.voice._callWanted(), true, "an iPhone gets a call screen");
  const rotated = await loadVoice({ window: { innerWidth: 844, innerHeight: 390 } });
  assert.equal(rotated.voice._callWanted(), true, "and it keeps one when the phone is turned sideways, which is what the height leg is for");
  const laptop = await loadVoice({ window: { innerWidth: 1440, innerHeight: 900 } });
  assert.equal(laptop.voice._callWanted(), false, "a laptop keeps VOICE-7's strip and panel");
  // 740 px is BELOW LINE_SHELF_WIDTH and ABOVE the call width, which is the whole reason the two
  // numbers have to be different: a narrow window has no room in its composer for a sentence, and it
  // is still not a phone.
  const narrow = await loadVoice({ window: { innerWidth: 740, innerHeight: 900 } });
  assert.equal(narrow.voice._callWanted(), false, "a 740 px window is not a phone");
  assert.ok(740 <= narrow.voice._LINE_SHELF_WIDTH, "and the refusal line still takes a row of the shelf there");
  assert.equal(narrow.voice._CALL_WIDTH, 690);
  assert.equal(narrow.voice._CALL_HEIGHT, 500);
  // A web view the size of an iPad still gets a call screen, because the shell says what it is rather
  // than this module guessing from a user agent.
  const shell = await loadVoice({ window: { innerWidth: 1024, innerHeight: 1366, __titanbotShell: { platform: "ios" } } });
  assert.equal(shell.voice._callWanted(), true, "a shell that names its platform gets a call screen at any size");
  // And the sheet carries no breakpoint at all, so the two cannot disagree.
  const sheet = await read("ui/machine-room/voice-call.css");
  assert.ok(!/@media[^{]*width/.test(sheet), "voice-call.css grew a width breakpoint, which is the disagreement this design avoids");
});

test("VOICE-13 call: five words, Muted outranks the rest, and Connecting is honest", async () => {
  const { voice } = await loadVoice();
  assert.deepEqual(voice._CALL_WORDS, ["Connecting", "Listening", "Thinking", "Talking", "Muted"]);
  voice._state.on = true;
  voice._state.ready = null;
  assert.equal(voice._call.stateWord(), "Connecting", "the screen is up before the line is, and Thinking there would be a lie");
  voice._state.ready = { agentName: "Titan" };
  voice._state.orb = "listening";
  assert.equal(voice._call.stateWord(), "Listening");
  voice._state.orb = "thinking";
  assert.equal(voice._call.stateWord(), "Thinking");
  voice._state.orb = "speaking";
  assert.equal(voice._call.stateWord(), "Talking", "Jason's word, not the wire's");
  voice._call.mute(true);
  assert.equal(voice._call.stateWord(), "Muted", "and a muted microphone outranks whatever the line is doing");
  assert.equal(voice._state.talking, false, "which is state.talking and nothing else: no frame is sent to the relay for it");
  voice._call.mute(false);
  assert.equal(voice._state.talking, true);
  // Nothing a person reads on this screen names a condition, a vendor or a machine's noun.
  const words = [...voice._CALL_WORDS, voice._CALL_ENDED_SENTENCE].join(" ");
  for (const leak of ["xai", "openai", "grok", "realtime", "socket", "vad", "error", "failed", "4001"]) {
    assert.doesNotMatch(words, new RegExp(leak, "i"), `"${leak}" reached a word on the call screen`);
  }
  voice._state.on = false;
});

test("VOICE-13 call: one thumb's two events open ONE screen and dial ONE line", async () => {
  const dom = callDom();
  const { voice, sent } = await loadTalking({ innerWidth: 390, innerHeight: 844, document: dom.document });
  const dialsBefore = sent.json.length;
  // A phone fires pointerdown AND touchstart for one thumb, microseconds apart, and both reach
  // talkDown. pressSpent guards the HOLD only, so the call branch has to be idempotent itself.
  await voice.talkDown();
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(voice._call.isUp(), true, "the press opened the screen");
  assert.equal(dom.screen.hidden, false, "and the screen is really on the page rather than only in the module");
  assert.equal(voice._state.on, true, "and one line");
  assert.equal(voice._state.talking, true, "hands free: the microphone is open for the life of the screen, with no hold");
  assert.equal(voice._state.held, false, "and nothing is being held, because there is no button under a thumb any more");
  assert.equal(sent.json.length, dialsBefore, "no JSON went down a line that was only just opened");
  assert.equal(voice.stats().call.up, true);
  voice.stop();
});

test("VOICE-13 call: a press while a refusal is standing clears the sentence and opens nothing", async () => {
  const dom = callDom();
  const { voice, sent } = await loadTalking({ innerWidth: 390, innerHeight: 844, document: dom.document });
  voice.stop("no-key");
  assert.deepEqual(voice.stats().notes, ["no-key"], "a refusal is standing, the way it is on a workspace with talking switched off");
  const dials = sent.json.length;
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(voice._call.isUp(), false, "the screen did NOT open over the standing refusal");
  assert.deepEqual(voice.stats().notes, [], "the press cleared the sentence, which is what it is for (VOICE-6)");
  assert.equal(voice._state.on, false, "and nothing dialled back into the refusal it had just cleared");
  assert.equal(sent.json.filter((one) => one.t === "stop").length, sent.json.filter((one) => one.t === "stop").length);
  // VOICE-11's cooldown is kept rather than re-broken: a sentence a person has had TIME to read is
  // cleared and dialled by one press, so a refusal never costs two presses for ever.
  voice.stop("no-key");
  voice._state.notes[0].at = Date.now() - (voice._REARM_COOLDOWN_MS + 500);
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(voice._call.isUp(), true, "an old sentence is cleared AND the press opens a call");
  assert.ok(sent.json.length >= dials);
  voice.stop();
});

test("VOICE-13 call: every path out puts the page back, and the newest line is what a person lands on", async () => {
  for (const exit of ["end", "escape", "hidden", "refused"]) {
    const dom = callDom();
    const { voice } = await loadTalking({ innerWidth: 390, innerHeight: 844, document: dom.document, ...{} });
    await voice.talkDown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(voice._call.isUp(), true, `${exit}: the screen is up before it is closed`);
    assert.equal(dom.document.body.dataset.voiceCall, "up", `${exit}: the background is locked while a call is up`);
    assert.equal(dom.shell.inert, true, `${exit}: and the console behind it takes no presses`);
    dom.transcript.scrollTop = 0;
    if (exit === "end") dom.screen.fire("click", { target: { closest: (sel) => (sel.includes("voice-call-end") ? dom.screen : null) } });
    else if (exit === "escape") voice._escapeStops();
    else if (exit === "hidden") { dom.document.hidden = true; voice.stop(); }
    else voice.stop("no-key");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(voice._call.isUp(), false, `${exit}: the screen went`);
    assert.equal(dom.screen.hidden, true, `${exit}: and it is hidden on the page, not just in the module`);
    assert.equal(dom.document.body.dataset.voiceCall, undefined, `${exit}: the background is scrollable again -- a person left on a chat they cannot scroll is worse than the bug this wave fixes`);
    assert.equal(dom.shell.inert, false, `${exit}: and the console takes presses again`);
    assert.equal(dom.transcript.scrollTop, dom.transcript.scrollHeight, `${exit}: and the chat is at the newest line, which is where somebody who has just been talking is looking`);
    assert.equal(voice._call._endedTimer() == null || exit === "hidden", true, `${exit}: no timer was left armed`);
    if (exit === "refused") {
      assert.deepEqual(voice.stats().notes, ["no-key"], "a refusal takes the screen away and the sentence stands in its ONE home on the shelf");
      assert.equal(voice._call.endedNoteUp(), false, "and it gets no second copy of that sentence on the screen it just closed");
    }
    if (exit === "end" || exit === "escape") {
      assert.equal(voice._call.endedNoteUp(), false, "somebody who pressed End knows the call ended, so there is no note");
    }
    if (exit === "hidden") {
      assert.equal(voice._call.endedNoteUp(), true, "a phone that was locked mid-call says so, once, in plain words");
      assert.equal(dom.note.textContent, voice._CALL_ENDED_SENTENCE);
      voice._call.dismissEndedNote();
    }
  }
});

test("VOICE-13 call: a line typed on the call screen goes out through the composer a person already uses", async () => {
  const dom = callDom();
  const { voice } = await loadTalking({ innerWidth: 390, innerHeight: 844, document: dom.document });
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(voice._call.typed("what is the team working on"), true);
  assert.equal(dom.box.value, "what is the team working on", "the console's own message box is what carries it");
  assert.equal(dom.submitted(), "what is the team working on", "and the composer's own submit is what sends it, so the pin, the attachments and the adapter are kept once");
  voice.stop();
});

test("VOICE-13 call: the status line is the chat's own tool receipt, and never a stale one", async () => {
  const dom = callDom();
  const { voice } = await loadTalking({ innerWidth: 390, innerHeight: 844, document: dom.document });
  // A receipt from this morning is already on the page when the call opens.
  dom.document._rows["#transcript .message-row.is-system"] = [systemRow(dom.made, "old", "Searching 2 websites")];
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(voice._call.statusText(), "", "the row that was newest when the call opened is not what Titan is doing now");
  dom.document._rows["#transcript .message-row.is-system"].push(systemRow(dom.made, "new", "Searching 9 websites"));
  assert.equal(voice._call.statusText(), "Searching 9 websites", "and a receipt from THIS call is the line under him, in the words the chat already says");
  // It is drawn only while he is working: Listening and Talking are not a status.
  voice._state.ready = { agentName: "Titan" };
  voice._state.orb = "thinking";
  voice._paintCall();
  assert.equal(voice.stats().call.status, "Searching 9 websites");
  voice._state.orb = "listening";
  voice._paintCall();
  assert.equal(voice.stats().call.status, "", "nothing is under him while he is waiting for somebody to talk");
  voice.stop();
});

test("VOICE-13 call: a card takes the middle and the avatar shrinks, with the live controls left in the chat", async () => {
  const dom = callDom();
  const { voice } = await loadTalking({ innerWidth: 390, innerHeight: 844, document: dom.document });
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const card = dom.made({ "data-message-id": "reply-1", class: "message-row" });
  card._find[".inline-card, [data-attachment]"] = dom.made();
  let cleared = 0;
  card.cloneNode = () => {
    const copy = dom.made({ "data-message-id": "reply-1" });
    copy.querySelectorAll = () => [{ remove: () => { cleared += 1; } }];
    return copy;
  };
  dom.document._rows["#transcript .message-row:not(.is-user)"] = [card];
  voice._paintCall();
  assert.equal(voice.stats().call.card, "reply-1", "the newest card in a reply is the one on screen");
  assert.equal(dom.screen.getAttribute("data-voice-call-card"), "up", "which is what shrinks him to an orb above the bottom row");
  assert.ok(cleared > 0, "the copy's controls are left behind: the ones in the chat are the ones that work");
  // And he grows back when the card is no longer the newest thing in the conversation.
  dom.document._rows["#transcript .message-row:not(.is-user)"] = [];
  voice._paintCall();
  assert.equal(dom.screen.getAttribute("data-voice-call-card"), null, "and he grows back");
  voice.stop();
});

test("VOICE-13 call: the microphone has a level now, and the four numbers beside it did not move", async () => {
  const { voice } = await loadTalking();
  await voice.talkDown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stats = voice._state.capture.stats;
  assert.equal(stats.micLevel, 0, "nothing has been said yet");
  // A frame of a known amplitude: 2400 samples at 0.5 is an RMS of 0.5.
  const loud = new Float32Array(2400).fill(0.5);
  capturePort.onmessage({ data: loud });
  assert.ok(Math.abs(stats.micLevel - 0.5) < 1e-6, `the RMS of a 0.5 frame is 0.5, not ${stats.micLevel}`);
  assert.equal(stats.micFrames, 1);
  assert.equal(voice.stats().micLevel, stats.micLevel, "and it is published under micLevel, which is NOT stats().level -- that one is the playback analyser");
  const sent = stats.sent;
  const heldFrames = stats.heldFrames;
  const heldMs = stats.heldMs;
  const muted = stats.mutedFrames;
  // A MUTED FRAME READS ZERO, and so does one the echo gate held while Titan was speaking. That is the
  // truth of the frame rather than a missing reading, and it must not cost the other four numbers.
  voice._call.mute(true);
  capturePort.onmessage({ data: loud });
  assert.equal(stats.micLevel, 0, "a frame a mute dropped has no voice in it to read a level off");
  assert.equal(stats.mutedFrames, muted + 1, "and it is still counted as a muted frame, which is what --leg frames reads");
  assert.equal(stats.sent, sent, "sent did not move");
  assert.equal(stats.heldFrames, heldFrames, "heldFrames did not move");
  assert.equal(stats.heldMs, heldMs, "heldMs did not move");
  voice.stop();
});

test("VOICE-13 avatar: nothing in the mascot's chain is ever scaled, and the level is smoothed in JS", async () => {
  // THE ONE RULE. The vendored kit sizes its canvas from host.getBoundingClientRect().width, which is
  // transform-aware, so a resize landing while an ancestor is scaled leaves Titan 5.6% stretched for
  // the rest of the call and makes WebKit log a ResizeObserver error. MEASURED on both engines. This
  // case is the cheap half of that guard; --leg call reads the computed transform in a real browser.
  const source = await read("ui/machine-room/voice-call-avatar.js");
  const sheet = await read("ui/machine-room/voice-call.css");
  const painted = source.slice(source.indexOf("function paint()"), source.indexOf("function tick"));
  assert.ok(!/mascot\.style\.transform/.test(painted), "a transform on the mascot is the feedback bug");
  // JASON, ON THE AVATAR: "We don't want ChatGPT's orb. We're going to have Titan's blob ... so it can
  // react and act and morph." The morph is real and it is on the kit's own canvas, inside the shadow
  // root the kit opened -- resize() measures the HOST, and a child's transform does not change a
  // parent's layout box, so per-frame squash is safe exactly there and nowhere above it.
  const morphed = source.slice(source.indexOf("function morph("), source.indexOf("function tick"));
  assert.match(morphed, /shadowRoot\?\.querySelector\("canvas"\)/, "the morph has to reach the kit's own canvas");
  assert.match(morphed, /canvas\.style\.transform = next/, "and it is a transform on that canvas");
  assert.ok(!/host\.style|mascot\.style\.transform/.test(morphed), "and never on the host the kit measures itself from");
  assert.match(morphed, /if \(next === lastTransform\) return/, "a still frame writes nothing at all");
  assert.ok(!/mascot\.style\.width/.test(painted), "writing the level into his width measured 16.8% of the main thread with 1419 layouts");
  assert.match(painted, /halo\.style\.transform/, "the halo is the sibling that moves");
  assert.match(painted, /setProperty\("--voice-level"/, "and the level is one custom property, once a frame, on the screen");
  for (const rule of ["titan-mascot"]) assert.ok(sheet.includes(rule), `${rule} is not styled at all`);
  assert.ok(!/titan-mascot[^}]*transform:\s*scale/.test(sheet), "the sheet scales the mascot, which is the same bug from the other side");

  // The module runs on a fake window with no custom elements at all, which is also the reduced-motion
  // path: the still, no loop, and a frame counter that proves the loop is not running.
  const fake = {
    document: { createElement: (tag) => ({ tag, style: {}, setAttribute() {}, appendChild() {}, remove() {}, querySelector: () => null }) },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
  };
  new Function("window", await read("ui/machine-room/voice-call-avatar.js"))(fake);
  const avatar = fake.__voiceCallAvatar;
  const face = { appendChild() {}, querySelector: () => null, closest: () => null };
  assert.equal(avatar.mount(face, { levels: () => ({ mic: 1, out: 0 }) }), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(avatar.frames, 0, "with no custom elements there is a still PNG and no animation loop at all");
  avatar.release();

  // The smoothing: a fast rise, a slow fall, and a settle at exactly zero rather than an asymptote that
  // keeps writing for ever. It is in JS because reduced motion flattens every CSS transition to 1 ms.
  assert.ok(avatar._ATTACK > avatar._DECAY, "a voice arrives faster than it leaves");
  let level = 0;
  for (let i = 0; i < 40; i += 1) level = avatar._smooth(level, 1);
  assert.equal(level, 1, "a level held high settles at full scale");
  for (let i = 0; i < 200; i += 1) level = avatar._smooth(level, 0);
  assert.equal(level, 0, "and silence settles at exactly zero");

  // The kit has three moods and `set mood` THROWS a RangeError on a fourth, so every word this module
  // can be given has to map onto one of the three.
  for (const word of ["Connecting", "Listening", "Thinking", "Talking", "Muted"]) {
    assert.ok(["calm", "curious", "excited"].includes(avatar._moodFor(word, 0)), `${word} asked the kit for a mood it does not have`);
    assert.ok(["calm", "curious", "excited"].includes(avatar._moodFor(word, 1)), `${word} at a high level asked for a mood the kit does not have`);
  }
  assert.equal(avatar._moodFor("Listening", 0, "calm"), "calm");
  assert.equal(avatar._moodFor("Listening", 1, "calm"), "excited", "a voice right at him lights him up, which is the kit's own strongest outline");
  assert.equal(avatar._moodFor("Listening", 0.3, "calm"), "curious", "and a voice across the room is the middle one");
  // A BAND, NOT A POINT. Every mood write fires the kit's attributeChangedCallback, which dispatches a
  // bubbling titan-statechange on the document, so a level sitting on a threshold must not flap.
  const floor = avatar._LEVEL_FLOOR;
  assert.equal(avatar._moodFor("Listening", floor + 0.02, "calm"), "calm", "just over the floor, from below, is still calm");
  assert.equal(avatar._moodFor("Listening", floor - 0.02, "curious"), "curious", "and just under it, from above, is still curious");
  assert.equal(avatar._moodFor("Thinking", 1, "excited"), "curious", "while he is working the face is the same whatever the room is doing");
  assert.equal(avatar._moodFor("Muted", 1, "excited"), "calm");
  // Which number each state reads. The echo gate legitimately shuts the microphone while he speaks.
  assert.equal(avatar.levelFor("Listening", { mic: 0.4, out: 0.9 }), 0.4);
  assert.equal(avatar.levelFor("Talking", { mic: 0.4, out: 0.9 }), 0.9);
  assert.equal(avatar.levelFor("Muted", { mic: 0.4, out: 0.9 }), 0);
});

test("VOICE-13 refusal: the relay's own sentence survives the close that follows it", async () => {
  // MEASURED ON THE LIVE SERVER 2026-09-11, gating the call screen on a workspace whose talking switch
  // is off: its door answers {"enabled":false,"available":true} -- a key exists, the customer's switch
  // does not -- and the relay refuses that one with acceptAndSay, which writes the note, the bye and
  // the close together. The bye's `reason` field carries the CONDITION and that refusal names none, so
  // the page's own stop() found no reason, took its "an ordinary press to leave clears what is
  // standing" branch, and DELETED the sentence the relay had written milliseconds earlier. A person
  // pressed Talk and got nothing at all: no line, no words, and on a phone a call screen that appeared
  // and vanished. This is the exact sequence, in order, off the live wire.
  const { voice } = await loadVoice();
  voice._state.on = true;
  frame(voice, { t: "state", state: "off" });
  frame(voice, { t: "note", text: "Talking is switched off in Settings.", reason: "" });
  assert.equal(voice.stats().notes.length, 1, "the relay's sentence is standing");
  frame(voice, { t: "bye", reason: "", detail: "voice is switched off" });
  voice._onClose({ code: 1000, reason: "" });
  assert.equal(voice._state.on, false, "the line is down");
  assert.equal(voice.stats().notes.length, 1, "and the sentence the relay wrote is STILL on screen, which is the whole of the fix");
  assert.equal(voice._state.notes[0].text, "Talking is switched off in Settings.", "in the relay's own wording, which is the only wording for this condition");
  assert.ok(voice._dismissTimer() != null, "with its ordinary dismiss armed, so it takes itself away rather than sitting there for the life of the tab");
  voice.stop();

  // AND A PERSON PRESSING THE BUTTON TO LEAVE STILL CLEARS WHAT IS STANDING, which is what that branch
  // was for: a note the relay sent mid-call must not outlive the call it was about.
  const second = await loadVoice();
  second.voice._state.on = true;
  frame(second.voice, { t: "note", text: "Something the relay said mid-call.", reason: "" });
  assert.equal(second.voice.stats().notes.length, 1);
  second.voice.stop();
  assert.deepEqual(second.voice.stats().notes, [], "the press that leaves takes it with it");
});

// ================================================================== VOICE-14
//
// Jason, 2026-09-12 20:08, on the iPhone call screen: "why are we not doing real-time audio? I can't
// barge in. This is me talking. It gets transcribed and then I hear audio back. That's not what this
// is supposed to be."
//
// The line was always streamed audio both ways. What was missing is the interruption, and it was
// missing ON PURPOSE: the microphone is shut while the agent speaks because on a laptop the thing
// being interrupted was the person, through their own speakers. In the app that reason is gone, so
// barge-in is switched on THERE and only there, keyed on the one fact the host states about itself.
//
// What these cases pin is the switch, the flush and the desktop's unchanged gate. What only a phone
// can answer -- that iOS really does keep the agent out of the microphone at full speaker volume --
// is Jason's own call on the build, and the report says so.

test("VOICE-14 barge-in: the opening frame asks for it inside the phone app, and a browser sends no such frame", async () => {
  const app = await loadTalking({ __titanbotShell: { platform: "ios", build: "36", canOpenAppSettings: true } });
  await app.voice.start();
  await settle(10);
  assert.deepEqual(app.sent.json.filter((one) => one.t === "hello"), [{ t: "hello", bargeIn: true }],
    `the app's line did not ask for barge-in: ${JSON.stringify(app.sent.json)}`);
  assert.equal(app.voice.stats().bargeIn, true, "and the page knows which kind of line it is holding");
  app.voice.stop();
  assert.equal(app.voice.stats().bargeIn, false, "the flag does not outlive its own line");

  // EVERY OTHER HOST, and the list is the point: a shell that is not iOS, a shell that says nothing
  // about its platform, and no shell at all. None of them sends the frame, so a browser's line carries
  // exactly the bytes it carried before this wave.
  for (const shell of [null, { platform: "macos", build: "1" }, { platform: "windows" }, { canOpenAppSettings: true }, { platform: "" }]) {
    const other = await loadTalking(shell == null ? {} : { __titanbotShell: shell });
    assert.equal(other.voice._bargeInWanted(), false, `${JSON.stringify(shell)} must not get barge-in`);
    await other.voice.start();
    await settle(10);
    assert.deepEqual(other.voice.stats().bargeIn, false);
    assert.deepEqual(other.sent.json.filter((one) => one.t === "hello"), [],
      `${JSON.stringify(shell)} sent an opening frame: ${JSON.stringify(other.sent.json)}`);
    other.voice.stop();
  }
});

test("VOICE-14 barge-in: the desktop holds frames while the agent speaks and the app sends them", async () => {
  // The desktop half of this is the SHIPPED gate, asserted here beside the new behaviour rather than
  // taken on trust: the claim of this wave is that one host changed and the other did not.
  const desktop = await loadTalking();
  await desktop.voice.start({ handsFree: true });
  await settle(10);
  const before = desktop.sent.audio.length;
  desktop.voice._state.gate.begin();
  capturePort.onmessage({ data: loudBlock() });
  assert.equal(desktop.voice._state.capture.stats.heldFrames, 1, "a browser still drops the frame the agent would be heard in");
  assert.equal(desktop.sent.audio.length, before, "and nothing went to the relay");
  desktop.voice.stop();

  const app = await loadTalking({ __titanbotShell: { platform: "ios", build: "36" } });
  await app.voice.start({ handsFree: true });
  await settle(10);
  const sentBefore = app.sent.audio.length;
  app.voice._state.gate.begin();
  capturePort.onmessage({ data: loudBlock() });
  assert.equal(app.voice._state.capture.stats.heldFrames, 0, "in the app the microphone stays open while the agent speaks");
  assert.equal(app.sent.audio.length, sentBefore + 1, "and the frame the person talked into really goes");
  assert.equal(isSilent(app.sent.audio.at(-1)), false, "with sound in it, which is what the provider's turn detection fires on");
  app.voice.stop();
});

test("VOICE-14 barge-in: a flush stops every buffer that was queued and puts the booked time back to zero", async () => {
  // Web Audio has no queue to empty. Each delta is already scheduled on its own AudioBufferSourceNode
  // at a time in the future, and it will play at that time whether or not anybody wants it any more --
  // which is why the player has to hold them and stop each one by hand. The context is KEPT: it was
  // opened under a gesture and WebKit will not resume one without another.
  const stopped = [];
  const started = [];
  class PlayableContext {
    constructor() {
      this.audioWorklet = { addModule: async () => {} };
      this.currentTime = 0;
      this.state = "running";
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 2048, connect() {}, getFloatTimeDomainData() {} }; }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { duration: length / rate, length, copyToChannel: (samples) => data.set(samples), getChannelData: () => data };
    }
    createBufferSource() {
      const node = {
        buffer: null, onended: null,
        connect() {}, disconnect() {},
        start(at) { started.push(at); },
        stop() { stopped.push(true); },
      };
      return node;
    }
    resume() { this.state = "running"; }
    close() { this.state = "closed"; }
  }
  const { voice } = await loadTalking({ AudioContext: PlayableContext });
  await voice.start({ handsFree: true });
  await settle(10);

  // Three frames of the agent's voice, which is 300 ms of sound booked from the BYTES rather than from
  // whether the player is idle.
  frame(voice, { t: "speak-begin", id: 1 });
  for (let i = 0; i < 3; i += 1) voice._onMessage({ data: new Uint8Array(voice._FRAME_BYTES).buffer });
  assert.equal(voice.stats().playedBuffers, 3, "three deltas became three buffers");
  assert.equal(started.length, 3, "and all three were really scheduled");
  assert.equal(voice.stats().liveBuffers, 3, "the player is holding them so they can be stopped");
  assert.ok(voice.stats().playsUntilMs > Date.now(), "there is sound still to come out of the speaker");
  assert.equal(voice._state.gate.holding(), true);

  frame(voice, { t: "flush" });
  assert.equal(stopped.length, 3, "every buffer that had been queued was stopped");
  assert.equal(voice.stats().liveBuffers, 0, "and the player is holding none of them now");
  assert.equal(voice.stats().stoppedBuffers, 3);
  assert.equal(voice.stats().flushes, 1);
  assert.equal(voice.stats().playsUntilMs, 0, "the booked time is back to zero, so nothing reads the room as loud");
  assert.equal(voice._state.gate.holding(), false, "which is what lets the person's own words reach their own panel");

  // AND THE NEXT SENTENCE STILL PLAYS. A flush that closed the context would cost the reply after the
  // interruption its voice, on a phone, where only a gesture can open another one.
  voice._onMessage({ data: new Uint8Array(voice._FRAME_BYTES).buffer });
  assert.equal(started.length, 4, "the sentence after the interruption is scheduled like any other");
  assert.equal(voice.stats().liveBuffers, 1);
  voice.stop();
});

// ================================================================== VOICE-15
//
// Jason, 2026-09-12 21:23: "the forcing of the speaker has never worked. It's always been the
// earpiece." While a WKWebView holds a getUserMedia capture, WebKit owns the AVAudioSession and routes
// the playback to the receiver; an app-level override loses under it. So the phone app stops using
// WebKit for audio: the microphone frames come from the shell and the PCM to play goes back to it, and
// AVAudioSession is then the app's alone. The page keeps the socket, the orb, the caption, the barge-in
// and the whole call screen.
//
// What these cases pin is the switch between the two audio paths, the five shell messages, the toggle,
// and the relay-down sentence. What only a phone can answer -- that iOS really puts the call on the
// loudspeaker and keeps the agent out of the microphone -- is Jason's own call on the build, and the
// report says so.

// A native-audio shell: its own flag, and a bridge that records every message the page posts to it.
// getUserMedia is wrapped so a test can prove the native path never asks for it.
async function loadNativeCall(over = {}) {
  const shellMessages = [];
  let getUserMediaCalls = 0;
  const audio = fakeAudioWindow();
  audio.navigator = { mediaDevices: { getUserMedia: async () => { getUserMediaCalls += 1; return { getTracks: () => [] }; } } };
  const loaded = await loadTalking({
    ...audio,
    __titanbotShell: { platform: "ios", build: "17", canOpenAppSettings: true, nativeAudio: true },
    webkit: { messageHandlers: { titaniumVoice: { postMessage: (message) => shellMessages.push(message) } } },
    ...over,
  });
  return { ...loaded, shellMessages, getUserMediaCalls: () => getUserMediaCalls };
}

const actionsOf = (messages, action) => messages.filter((one) => one && one.action === action);

test("VOICE-15 native capture: the app opens the shell's mic, never getUserMedia, and a shell frame becomes one socket frame", async () => {
  const call = await loadNativeCall();
  await call.voice.start({ handsFree: true });
  await settle(10);
  // audioStart, with the 24 kHz the contract names, and no browser capture opened at all.
  assert.deepEqual(actionsOf(call.shellMessages, "audioStart"), [{ action: "audioStart", sampleRate: 24000 }],
    `the app did not ask the shell to open its mic: ${JSON.stringify(call.shellMessages)}`);
  assert.equal(call.getUserMediaCalls(), 0, "the native path never touches getUserMedia");

  // One 100 ms frame from the shell, base64, becomes one socket frame with the same sound in it.
  const loud = new Uint8Array(call.voice._FRAME_BYTES);
  for (let i = 0; i < loud.length; i += 2) { loud[i] = 0x00; loud[i + 1] = 0x40; } // 0x4000, real sound
  const before = call.sent.audio.length;
  call.fake.__titanbotAudio.frame(call.voice._base64FromBytes(loud));
  assert.equal(call.sent.audio.length, before + 1, "the shell's frame reached the relay as one socket frame");
  assert.equal(call.sent.audio.at(-1).byteLength, call.voice._FRAME_BYTES, "4800 bytes, the frame both sides count in");
  assert.equal(isSilent(call.sent.audio.at(-1)), false, "with the sound the shell captured still in it");
  assert.equal(call.voice._state.capture.stats.sent, 1, "and the capture counted it");
  assert.equal(call.voice._state.capture.stats.micFrames, 1, "with a mic level, which is the call avatar's reason to exist");

  // Muted: the page drops the frame the way the browser path drops a muted one, and does not send it.
  call.voice._call.mute(true);
  const beforeMute = call.sent.audio.length;
  call.fake.__titanbotAudio.frame(call.voice._base64FromBytes(loud));
  assert.equal(call.sent.audio.length, beforeMute, "a muted call sends nothing");
  assert.equal(call.voice._state.capture.stats.mutedFrames, 1, "and counts the drop as a mute, not as the echo gate");

  // A frame that arrives when no native capture is running is a no-op, not a throw.
  call.voice.stop();
  assert.deepEqual(actionsOf(call.shellMessages, "audioStop"), [{ action: "audioStop" }], "hang-up closes the shell's mic");
  const afterStop = call.sent.audio.length;
  call.fake.__titanbotAudio.frame(call.voice._base64FromBytes(loud));
  assert.equal(call.sent.audio.length, afterStop, "a frame after hang-up reaches nobody");
});

test("VOICE-15 native playback: each delta is an audioPlay, a flush is an audioFlush, and playedMs books the room", async () => {
  const call = await loadNativeCall();
  await call.voice.start({ handsFree: true });
  await settle(10);

  // Three deltas of the agent's voice become three audioPlay messages with base64 PCM on them.
  call.voice._onMessage({ data: JSON.stringify({ t: "speak-begin", id: 1 }) });
  for (let i = 0; i < 3; i += 1) call.voice._onMessage({ data: new Uint8Array(call.voice._FRAME_BYTES).buffer });
  const plays = actionsOf(call.shellMessages, "audioPlay");
  assert.equal(plays.length, 3, "three deltas, three audioPlay messages handed to the shell");
  assert.equal(call.voice._bytesFromBase64(plays[0].pcm).length, call.voice._FRAME_BYTES, "each carries its PCM as base64");
  assert.equal(call.voice.stats().playedBuffers, 3, "the player counted them");

  // playsUntilMs is booked from the shell's own playedMs, not from the bytes: nothing is booked until
  // the shell reports, and then the room is loud for as long as more was queued than has played.
  assert.equal(call.voice.stats().playsUntilMs, 0, "the page does not guess the clock from bytes it cannot see play");
  call.fake.__titanbotAudio.playedMs(100); // 100 ms of 300 ms queued has left the speaker
  assert.ok(call.voice.stats().playsUntilMs > Date.now(), "200 ms is still to come, so the room is still loud");
  assert.equal(call.voice._state.gate.holding(), true);
  call.fake.__titanbotAudio.playedMs(300); // all of it has played
  assert.ok(call.voice.stats().playsUntilMs <= Date.now() + 1, "and once it has all played the room is quiet");

  // A barge-in flush tells the shell to drop its queue and puts the booking honestly back to nothing.
  call.voice._onMessage({ data: JSON.stringify({ t: "speak-begin", id: 2 }) });
  call.voice._onMessage({ data: new Uint8Array(call.voice._FRAME_BYTES).buffer });
  call.voice._onMessage({ data: JSON.stringify({ t: "flush" }) });
  assert.deepEqual(actionsOf(call.shellMessages, "audioFlush"), [{ action: "audioFlush" }], "the shell is told to empty its queue");
  assert.equal(call.voice.stats().flushes, 1);
  assert.equal(call.voice.stats().playsUntilMs, 0, "and nothing reads the room as loud after a barge-in");
  assert.equal(call.voice._state.gate.holding(), false, "which is what lets the person's own words through");
  call.voice.stop();
});

test("VOICE-15 toggle: the speaker/earpiece control sends audioOutput, shows only in the app, and the route line reads the shell's truth", async () => {
  const dom = callDom();
  const call = await loadNativeCall({ document: dom.document });
  await call.voice._call.open();
  await settle(10);
  const toggle = dom.screen._find["[data-voice-call-output]"];
  const routeNode = dom.screen._find["[data-voice-call-route]"];
  assert.equal(toggle.hidden, false, "the toggle is shown when the shell owns the audio");
  assert.equal(toggle.getAttribute("aria-pressed"), "true", "speaker is the default, which is what a hands-free call wants");

  // A press flips the choice and tells the shell, which is the side that applies and remembers it.
  call.voice._toggleOutput();
  assert.deepEqual(actionsOf(call.shellMessages, "audioOutput").at(-1), { action: "audioOutput", value: "earpiece" });
  assert.equal(call.voice.stats().call.output, "earpiece");
  assert.equal(toggle.getAttribute("aria-pressed"), "false", "and the control shows the new state at once");

  // The shell's route report is the truth under the toggle, as one plain word and any error.
  call.fake.__titanbotAudio.route({ category: "playAndRecord", mode: "videoChat", outputs: ["Speaker"], output: "speaker", error: "" });
  assert.equal(call.voice.stats().call.output, "speaker", "the route corrected the choice to what the hardware settled on");
  assert.equal(routeNode.hidden, false);
  assert.equal(routeNode.textContent, "Speaker");
  call.fake.__titanbotAudio.route({ category: "playAndRecord", mode: "videoChat", outputs: ["BluetoothHFP"], output: "bluetooth", error: "headset battery low" });
  assert.equal(routeNode.textContent, "Bluetooth. headset battery low", "a route with an error says both, in plain words with no stack-trace dress");
  call.voice.stop();
});

test("VOICE-15 toggle: a browser keeps WebKit's own route, so neither the toggle nor the route line is there", async () => {
  const dom = callDom();
  // A phone-sized browser: a call screen, but no shell flag, so the audio path is unchanged.
  const { voice } = await loadTalking({ innerWidth: 390, innerHeight: 844, document: dom.document });
  await voice._call.open();
  await settle(10);
  assert.equal(dom.screen._find["[data-voice-call-output]"].hidden, true, "no speaker/earpiece toggle in a browser");
  assert.equal(dom.screen._find["[data-voice-call-route]"].hidden, true, "and no route line");
  assert.equal(voice._nativeAudioWanted(), false);
  voice.stop();
});

test("VOICE-15c relay-down: a refused upgrade keeps the call screen, says why, and Try again dials again", async () => {
  const dom = callDom();
  // Refused the first time, open the second: Try again has to actually recover, not just re-draw.
  let attempts = 0;
  class RetrySocket {
    constructor() {
      attempts += 1;
      const willOpen = attempts >= 2;
      this.readyState = 0;
      this.handlers = {};
      setTimeout(() => {
        if (willOpen) { this.readyState = 1; this.handlers.open?.({}); return; }
        // The browser's real order against a refused upgrade: error, then close 1006.
        this.handlers.error?.({});
        this.handlers.close?.({ code: 1006, reason: "" });
      }, 0);
    }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    send() {}
    close() { this.readyState = 3; }
  }
  const call = await loadNativeCall({ document: dom.document, __voiceSocketClass: RetrySocket });
  await call.voice._call.open();
  await settle(20);
  assert.equal(call.voice._call.isUp(), true, "the screen stays up instead of vanishing and hiding the reason");
  assert.equal(call.voice.stats().call.down, call.voice._CALL_DOWN_NO_ANSWER, "it says, in plain words, that the relay did not answer");
  assert.equal(dom.screen._find["[data-voice-call-state]"].textContent, call.voice._CALL_DOWN_NO_ANSWER, "and the sentence is on the prominent line");
  assert.equal(call.voice._state.orb, "off", "the orb is off: there is nothing live to animate");
  assert.equal(dom.screen._find["[data-voice-call-retry]"].hidden, false, "the Try again button is shown");
  assert.equal(dom.screen._find["[data-voice-call-mute]"].hidden, true, "and the mute control is gone, because a dead line has no mic to mute");
  assert.deepEqual(call.voice.stats().notes, [], "nothing lands on the shelf the full-screen surface would cover");

  // Try again dials a fresh line, and this one opens, so the call is live again on the screen that never went.
  call.voice._retryCall();
  await settle(20);
  assert.equal(call.voice.stats().call.down, "", "Try again cleared the down state");
  assert.equal(call.voice._call.isUp(), true, "the screen never went, so the person stayed in the call");
  assert.equal(call.voice._state.on, true, "and the second dial opened, so the line is live again");
  call.voice.stop();
});

test("VOICE-15c relay-down: a live line that drops mid-call says the line dropped, on the screen", async () => {
  const dom = callDom();
  const call = await loadNativeCall({ document: dom.document });
  await call.voice._call.open();
  await settle(10);
  assert.equal(call.voice._state.on, true, "the line is up");
  // The relay drops it without the person pressing End.
  call.voice._onClose({ code: 1006, reason: "" });
  assert.equal(call.voice._call.isUp(), true, "the screen stays up");
  assert.equal(call.voice.stats().call.down, call.voice._CALL_DOWN_DROPPED, "and it says the line dropped");
  assert.equal(dom.screen._find["[data-voice-call-state]"].textContent, call.voice._CALL_DOWN_DROPPED);
  assert.deepEqual(call.voice.stats().notes, [], "again nothing on the shelf");
  call.voice.stop();
});

test("VOICE-15c relay-down: a phone in a plain browser keeps VOICE-13's shelf behaviour, so nothing without the flag changes", async () => {
  const dom = callDom();
  class DeadSocket {
    constructor() {
      this.readyState = 0;
      this.handlers = {};
      setTimeout(() => { this.handlers.error?.({}); this.handlers.close?.({ code: 1006, reason: "" }); }, 0);
    }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    send() {} close() {}
  }
  // A phone-width browser, no shell flag: the call screen goes and the no-key sentence lands on the
  // shelf with its Open settings, exactly as VOICE-13 shipped. This is the case the native gate keeps.
  const { voice } = await loadVoice({ window: {
    ...fakeAudioWindow(),
    innerWidth: 390, innerHeight: 844,
    document: dom.document,
    __voiceSocketClass: DeadSocket,
  } });
  await voice._call.open();
  await settle(20);
  assert.equal(voice._call.isUp(), false, "the screen went away, the way a browser's refusal always has");
  assert.equal(voice.stats().call.down, "", "there is no relay-down state in a browser");
  assert.deepEqual(voice.stats().notes, ["no-key"], "and the sentence stands in its one home on the shelf");
  voice.stop();
});

test("VOICE-15 a browser line sends no shell audio messages and opens its own microphone", async () => {
  // The whole claim of this wave is that one host changed and the others did not.
  const shellMessages = [];
  let getUserMediaCalls = 0;
  const audio = fakeAudioWindow();
  audio.navigator = { mediaDevices: { getUserMedia: async () => { getUserMediaCalls += 1; return { getTracks: () => [] }; } } };
  const { voice } = await loadTalking({
    ...audio,
    // A shell that is iOS but an OLD build with no nativeAudio flag keeps the browser audio path.
    __titanbotShell: { platform: "ios", build: "16" },
    webkit: { messageHandlers: { titaniumVoice: { postMessage: (message) => shellMessages.push(message) } } },
  });
  await voice.start({ handsFree: true });
  await settle(10);
  assert.equal(voice._nativeAudioWanted(), false, "no flag, no native audio");
  assert.equal(getUserMediaCalls, 1, "the browser path opened its own microphone");
  assert.deepEqual(shellMessages, [], "and posted nothing to the shell's audio bridge");
  voice.stop();
});
