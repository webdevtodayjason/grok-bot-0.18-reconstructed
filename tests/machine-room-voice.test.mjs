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
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");
const GATE_AGENT = "titanbot-gate/machine-room-voice.test.mjs";

// ------------------------------------------------------------------ loading the module
//
// A classic script on a window global. Handed a fake window with a document that answers nothing,
// which is what lets the message and close handlers be driven with no DOM at all: paint() asks for
// the talk button and the strip, gets null for both, and does nothing.
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
  const line = voice._lineFor(voice._state.notes, "");
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

test("VOICE-2 line: a caption and a note share the one line, and the note wins", async () => {
  const { voice } = await loadVoice();
  assert.deepEqual(voice._lineFor([], "what you just said"), { text: "what you just said", action: null });
  assert.deepEqual(voice._lineFor([], ""), { text: "", action: null }, "nothing to say draws nothing");
  // Fixing only the note would have left the identical break for everyone who actually talks:
  // MEASURED at 1440x900, a live caption alone with no note took the shelf 1392x106 -> 1392x168 and
  // the composer 600 -> 407.98. The caption and the note are the same node for that reason.
  const both = voice._lineFor([{ condition: "no-key" }], "a caption that was still on screen");
  assert.equal(both.text, voice._NOTES["no-key"], "the note is the newer fact and the only one shown");
  assert.equal(both.action, "Open settings");
});

test("VOICE-1 notes: each of the six conditions produces its own plain sentence", async () => {
  const { voice } = await loadVoice();
  const conditions = ["no-microphone", "no-key", "day-cap", "session-cap", "box-not-running", "line-dropped"];
  assert.deepEqual(Object.keys(voice._NOTES).sort(), [...conditions].sort(), "six conditions, no more and no fewer");
  for (const condition of conditions) {
    voice._state.notes = [];
    voice.stop(condition);
    assert.equal(voice._state.notes.length, 1, `${condition} left the person with nothing to read`);
    assert.equal(voice._state.notes[0].condition, condition);
    const sentence = voice._sentenceFor(condition);
    assert.ok(sentence.length > 20, `${condition}: "${sentence}" is not a sentence`);
    assert.match(sentence, /[.!]$/, `${condition}: a sentence ends`);
    assert.equal(voice._lineFor([{ condition }], "").text, sentence, `${condition}: the line says it`);
    // No vendor, no tool name, no machine's noun. These are the words a business owner reads.
    for (const leak of ["xai", "x\\.ai", "openai", "grok", "realtime", "websocket", "socket", "titan\\(", "sendPrompt",
      "function_call", "session\\.update", "pcm", "api", "token", "4001", "upgrade"]) {
      assert.doesNotMatch(sentence, new RegExp(leak, "i"), `${condition}: "${leak}" reached the page`);
    }
  }
  // And exactly one of them leads somewhere, because "nothing is set up yet" is the one condition a
  // person can fix from this page.
  assert.deepEqual(Object.keys(voice._NOTE_ACTIONS), ["no-key"]);
  assert.equal(voice._lineFor([{ condition: "no-key" }], "").action, "Open settings");
  assert.equal(voice._lineFor([{ condition: "line-dropped" }], "").action, null);
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
  assert.equal(voice._lineFor(voice._state.notes, "").action, "Open settings");
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
  assert.equal(voice._lineFor(voice._state.notes, "").action, "Open settings",
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
  assert.match(voice._lineFor(voice._state.notes, "").text, /thirty minutes/,
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
  assert.equal(voice._lineFor(voice._state.notes, "").action, "Open settings", "and it leads somewhere");
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
  // And the card's own container went with it, so nothing can mount one back by accident.
  for (const gone of ["voiceCardMarkup", "mountCard", "openCard", "settings-section"]) {
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
  const allowed = new Set([".composer", ".composer[data-voice-line]"]);
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
  // unconditional fifth track was MEASURED to take 4 px off the message box through .composer's own
  // 4 px gap, so the base rule must stay four tracks and the gated one five.
  const tracks = (selector) => {
    const rule = composerRules.find((one) => `.composer${one[1] ?? ""}` === selector);
    assert.ok(rule != null, `${selector} is not under the banner`);
    return rule[2].split(":")[1].trim().replace(/;$/, "").split(/\s+(?![^(]*\))/).length;
  };
  assert.equal(tracks(".composer"), 4, "at rest the composer is the four-track form it has always been");
  assert.equal(tracks(".composer[data-voice-line]"), 5, "and it grows a track only while the line is up");
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

    // The boot cover is opaque and on top until app.js paints or its 8 s ceiling expires. With no
    // gateway here it is the ceiling, so the box is POLLED rather than read once -- a control behind
    // a cover is not a control on the screen.
    let box = null;
    let reachable = false;
    for (let n = 0; n < 60 && !reachable; n += 1) {
      box = await page.evaluate(() => {
        const node = document.querySelector("[data-voice-talk]");
        if (node == null) return null;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        return { x, y, label: node.textContent.replace(/\s+/g, " ").trim(), reachable: node.contains(hit) || hit === node };
      });
      reachable = Boolean(box?.reachable);
      if (!reachable) await page.waitForTimeout(500);
    }
    assert.ok(box != null, "the talk button never got a size on the page");
    assert.equal(reachable, true, `a mouse cannot reach the talk button; elementFromPoint landed elsewhere (${JSON.stringify(box)})`);
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
    assert.equal(atRest.tracks, 4, `the composer has its four tracks at rest: ${JSON.stringify(atRest)}`);
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
    assert.equal(withLine.tracks, 5, "the fifth track is there while the line is up");
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

    // A LIVE CAPTION IS THE SAME NODE, which is the other half of the same bug: fixing only the note
    // would have left the identical break for everyone who actually talks. MEASURED before the fix, a
    // caption alone with no note took the shelf 1392x106 -> 1392x168 and the composer 600 -> 407.98.
    await page.evaluate(() => window.__voice._onMessage({
      data: JSON.stringify({ t: "heard", text: "what is the team working on this afternoon" }),
    }));
    await page.waitForTimeout(60);
    const captioned = await rects();
    for (const named of ["shelf", "composer", "utilities", "aside", "transcript"]) {
      assert.deepEqual(captioned[named], atRest[named],
        `${named} moved when a live caption came up: ${JSON.stringify(atRest[named])} -> ${JSON.stringify(captioned[named])}`);
    }
    await page.evaluate(() => window.__voice._onMessage({ data: JSON.stringify({ t: "heard", text: "" }) }));

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

      // The caption's own cost, measured separately, because it is the common case for anyone who can
      // actually talk and it carries no control.
      // toggle(), not stop(): an ordinary stop leaves a note standing on purpose (the relay's diagnosis
      // outranks anything that happens after it), and a note outranks a caption on the one line.
      await small.evaluate(() => window.__voice.toggle());
      await small.evaluate(() => window.__voice._onMessage({
        data: JSON.stringify({ t: "heard", text: "what is the team working on this afternoon" }),
      }));
      await small.waitForTimeout(60);
      const captionCost = await small.evaluate(() => Math.round(document.querySelector(".control-shelf").getBoundingClientRect().height * 100) / 100);
      console.log(`    VOICE-2 at 390x844: a live caption costs the shelf ${Math.round((captionCost - shelfBefore) * 100) / 100} px`);
      assert.ok(captionCost - shelfBefore <= 40,
        `a caption grew the shelf ${captionCost - shelfBefore} px, which is a row and a half of words`);
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
        assert.equal(row.tracks, 4, `the composer grew a track with the line down. ${where}`);
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
  const sent = { frames: 0, json: [] };
  class OpenSocket {
    constructor() { this.readyState = 1; this.handlers = {}; setTimeout(() => this.handlers.open?.({}), 0); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    send(payload) {
      sent.frames += 1;
      if (typeof payload === "string") { try { sent.json.push(JSON.parse(payload)); } catch { /* audio */ } }
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
  assert.equal(voice._state.caption, "I have asked him and he is on it.");

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
  assert.equal(voice._HEARD_STALE_MS, 8000);
  const source = await read("ui/machine-room/voice.js");
  const machine = source.slice(source.indexOf("function armStale"), source.indexOf("function paintOverlay"));
  assert.match(machine, /function overlayOpen[\s\S]*armStale\(\)/, "opening the panel arms the timer");
  assert.match(machine, /function overlayPartial[\s\S]*armStale\(\)/, "and every word puts it back");
  assert.match(machine, /function overlayConfirmed[\s\S]*disarmStale\(\)/, "and the bytes being known takes it away");
  assert.match(machine, /function overlayEnd[\s\S]*disarmStale\(\)/, "and so does the turn ending");
  assert.match(machine, /function closeOverlay[\s\S]*disarmStale\(\)/);
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
  const mount = source.slice(source.indexOf("function mountOverlay"), source.indexOf("function spaceMayTalk"));
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
  assert.match(wired, /if \(talkMode\(\) !== "push"\) toggle\(\)/,
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

test("VOICE-7 row: the choice is the person's and never the workspace's", async () => {
  // NOT THE WORKSPACE'S. /voice/settings is one file per workspace, and two people sharing one would
  // fight over how their own button behaves. So this value never goes near that route: it is
  // remembered in this browser, beside Theme, and the row reaches it through the module's own door.
  const box = new Map();
  const storage = { getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) };
  const { voice } = await loadVoice({ window: { localStorage: storage } });
  assert.equal(voice.getTalkMode(), "push", "nothing stored is push to talk, the mode that cannot leave a microphone open");
  assert.equal(voice.setTalkMode("always"), "always");
  assert.equal(box.get(voice._TALK_MODE_KEY), "always", "the choice was not remembered at all");
  // A second page in the same browser opens on the choice the first one made.
  const again = await loadVoice({ window: { localStorage: storage } });
  assert.equal(again.voice.getTalkMode(), "always");
  // And a value nobody offered is refused rather than stored.
  assert.equal(voice.setTalkMode("whenever"), "push");

  // The route this must never reach. The settings surface writes talking's own fields through
  // voice.saveSettings; the talk mode is not one of them and has no field on that door.
  const source = await read("ui/machine-room/voice.js");
  const writer = source.slice(source.indexOf("async function writeSettings"), source.indexOf("async function getSettings"));
  assert.ok(!writer.includes("talkMode"), "the talk mode reached the workspace's own settings file");
  // And no request body anywhere in this module carries it. The only places the name may appear are
  // the state field, the reader, the setter, and the stats the gate reads.
  for (const [, body] of source.matchAll(/JSON\.stringify\(([^)]*)\)/g)) {
    assert.ok(!body.includes("talkMode"), `a request body carries the talk mode: ${body}`);
  }
  assert.ok(source.includes("localStorage?.setItem(TALK_MODE_KEY"), "it is remembered in this browser and nowhere else");
});
