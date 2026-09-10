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
test("VOICE-1 notes: a note paints a detail-less quiet row and does not colour the orb", async () => {
  const { voice } = await loadVoice();
  frame(voice, { t: "state", value: "listening" });
  frame(voice, { t: "note", text: "Your agent is still reading. One moment." });
  assert.equal(voice._state.notes.length, 1);
  assert.equal(voice._state.orb, "listening", "a note is not a state; it may never move the orb");
  const markup = voice._noteMarkup("relay", "Your agent is still reading. One moment.");
  assert.match(markup, /class="message-row is-system voice-note"/, "the console's own muted bubble");
  assert.doesNotMatch(markup, /is-turn-failed/, "none of these is a failed turn");
  // Detail-less on purpose: an expander here would put a machine's innards beside a conversation.
  assert.doesNotMatch(markup, /<details|<pre|<summary/);
  // A frame with nothing to say paints nothing rather than an empty row.
  voice._state.notes = [];
  frame(voice, { t: "note", text: "   " });
  assert.equal(voice._state.notes.length, 0);
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
    const markup = voice._noteMarkup(condition);
    assert.ok(markup.includes("is-system") && markup.includes("voice-note"), `${condition}: the quiet row's class`);
    assert.doesNotMatch(markup, /is-turn-failed/, `${condition}: never dressed as a failed turn`);
    // No vendor, no tool name, no machine's noun. These are the words a business owner reads.
    for (const leak of ["xai", "x\\.ai", "openai", "grok", "realtime", "websocket", "socket", "titan\\(", "sendPrompt",
      "function_call", "session\\.update", "pcm", "api", "token", "4001", "upgrade"]) {
      assert.doesNotMatch(sentence, new RegExp(leak, "i"), `${condition}: "${leak}" reached the page`);
    }
  }
  // And exactly one of them leads somewhere, because "nothing is set up yet" is the one condition a
  // person can fix from this page.
  assert.deepEqual(Object.keys(voice._NOTE_ACTIONS), ["no-key"]);
  assert.match(voice._noteMarkup("no-key"), /data-voice-open-settings/);
  assert.doesNotMatch(voice._noteMarkup("line-dropped"), /data-voice-open-settings/);
});

test("VOICE-1 notes: the relay's own sentence wins, and the close only names the condition", async () => {
  const { voice } = await loadVoice();
  // The refusal the design pins: accept the upgrade, say one sentence, say bye, close 1000.
  frame(voice, { t: "note", reason: "no-key", text: "Talking is not set up for this workspace yet." });
  frame(voice, { t: "bye", reason: "no-key" });
  voice._onClose({ code: 1000, reason: "" });
  assert.equal(voice._state.notes.length, 1, "one row, not the relay's sentence and then ours");
  assert.equal(voice._state.notes[0].text, "Talking is not set up for this workspace yet.");
  assert.equal(voice._state.notes[0].condition, "no-key", "so the row still offers the card that fixes it");
  assert.match(voice._noteMarkup("no-key", voice._state.notes[0].text), /data-voice-open-settings/);
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
  assert.match(voice._noteMarkup(voice._state.notes[0].condition, voice._state.notes[0].text), /data-voice-open-settings/,
    "so the control that opens the card is still there");

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
  const markup = voice._noteMarkup("session-cap", voice._state.notes[0].text);
  assert.match(markup, /thirty minutes/, "the relay's words are what the person reads");
  assert.doesNotMatch(markup, /is-turn-failed/);
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
  assert.match(voice._sentenceFor("no-key"), /not available/i);
  assert.match(voice._noteMarkup("no-key"), /data-voice-open-settings/, "and it leads somewhere");
});

// ------------------------------------------------------------------ the Voice card
test("VOICE-1 card: the key is paste-or-clear and no answer can show a value back", async () => {
  const { voice } = await loadVoice();
  const markup = voice._voiceCardMarkup();
  assert.match(markup, /type="password"/, "the field is never a text box a value could be read out of");
  assert.match(markup, /data-voice-key-set/);
  assert.match(markup, /data-voice-key-clear/);
  // Nothing in the card's markup asks for a value back, because the route only answers apiKeySet.
  assert.doesNotMatch(markup, /value="\$\{[^}]*apiKey/);
  // The one control that decides whether the first press reaches the head of the team.
  assert.match(markup, /data-voice-agent/);
  assert.match(markup, /Who you are talking to/);
  // No barge-in, said in words rather than left to be discovered.
  assert.match(markup, /microphone is shut while he talks/);
  // And no vendor or tool name anywhere on it.
  for (const leak of ["xAI", "x.ai", "OpenAI", "Grok", "websocket", "sendPrompt", "realtime"]) {
    assert.ok(!markup.includes(leak), `${leak} reached the card`);
  }
});

test("VOICE-1 card: a key that is set reads as set and never as a value", async () => {
  const { voice } = await loadVoice();
  const fields = new Map();
  const root = {
    querySelector: (selector) => fields.get(selector) ?? null,
  };
  for (const selector of ["[data-voice-key-note]", "[data-voice-enabled-note]", "[data-voice-usage]"]) {
    fields.set(selector, { textContent: "" });
  }
  for (const selector of ["[data-voice-model]", "[data-voice-voice]"]) fields.set(selector, { value: "" });
  for (const selector of ["[data-voice-vendor]", "[data-voice-agent]"]) fields.set(selector, { innerHTML: "" });
  fields.set("[data-voice-enabled]", { attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } });

  voice._paintCard(root, {
    enabled: true, vendor: "a", model: "m", voice: "v", agentId: "agent-1",
    apiKeySet: true, sessionCapSeconds: 1800, dayCapSeconds: 7200, dayUsedSeconds: 126,
    vendors: [{ id: "a", label: "The cheaper one" }], agents: [{ id: "agent-1", name: "Titan" }],
  });
  const note = fields.get("[data-voice-key-note]").textContent;
  assert.match(note, /A key is set/);
  assert.doesNotMatch(note, /sk-|xai-|\*\*\*\*/, "not even a masked value: the answer carries none");
  assert.equal(fields.get("[data-voice-enabled]").attributes["aria-pressed"], "true");
  // Minutes, in words a person predicts: wall time, which is what the caps count.
  assert.match(fields.get("[data-voice-usage]").textContent, /2\.1 min of 120 min today/);
  assert.match(fields.get("[data-voice-usage]").textContent, /30 min in one call/);
  assert.match(fields.get("[data-voice-agent]").innerHTML, /value="agent-1" selected>Titan</);
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
  // Every selector below the banner is this wave's own, with ONE allowed exception, declared here so
  // it cannot grow quietly: .composer's grid template. A fourth child of a three-track grid opens an
  // implicit second row and pushes Send off the line -- MEASURED at 390, 768 and 1440 CSS px. The
  // rule is re-declared by appending, never edited in place, so a rebase is still a clean append.
  const allowed = new Set([".composer"]);
  for (const selector of selectors) {
    for (const part of selector.split(",").map((one) => one.trim()).filter(Boolean)) {
      if (allowed.has(part)) continue;
      assert.match(part, /^\.voice-/, `${part} is not a selector this wave owns`);
    }
  }
  // And the exception may only move the grid track. Anything else in it would be this wave editing
  // another wave's composer.
  for (const match of after.matchAll(/^\s*\.composer\s*\{([^}]*)\}/gm)) {
    const properties = match[1].split(";").map((one) => one.split(":")[0].trim()).filter(Boolean);
    assert.deepEqual(properties, ["grid-template-columns"],
      `the .composer override carries more than the track it exists for: ${properties.join(", ")}`);
  }
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
  // only because that bit a shipped control (:3830, :4162, :4216). A strip that cannot hide is a
  // caption line above every composer on every page.
  assert.match(rules, /\.voice-strip:not\(\[hidden\]\)\s*\{/,
    "the strip's display rule has to lose to the hidden attribute, or it can never be hidden");
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
    const context = await browser.newContext({ userAgent: GATE_AGENT, permissions: ["microphone"] });
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

    // A real press at the real coordinates.
    await page.mouse.click(box.x, box.y);

    // Two things follow, and the second is the one a person sees. The page asked the relay for a
    // line; the relay here has no voice door, so it answers nothing -- and the page says so.
    let saw = null;
    for (let n = 0; n < 40; n += 1) {
      saw = await page.evaluate(() => {
        const strip = document.getElementById("voice-strip");
        const note = strip?.querySelector("[data-voice-note]");
        return {
          notes: window.__voice.stats().notes,
          text: note == null ? "" : note.textContent.replace(/\s+/g, " ").trim(),
          visible: note != null && note.getBoundingClientRect().height > 0,
          classes: note?.className ?? "",
          hasAction: note?.querySelector("[data-voice-open-settings]") != null,
          orb: document.querySelector("[data-voice-orb]")?.getAttribute("data-state") ?? "",
        };
      });
      if (saw.visible) break;
      await page.waitForTimeout(250);
    }
    assert.ok(upgrades.some((one) => one === "/voice/socket"), `the press opened no socket; saw ${JSON.stringify(upgrades)}`);
    assert.equal(saw.visible, true, `the person was left with nothing to read (${JSON.stringify(saw)})`);
    assert.ok(saw.text.length > 20, saw.text);
    assert.match(saw.classes, /is-system/);
    assert.doesNotMatch(saw.classes, /is-turn-failed/);
    // The sentence a refused line must produce, and the control that makes it lead somewhere. The
    // first version of this file said "the line dropped" here instead, with no control: Chrome fires
    // error AND close, and the close overwrote the useful sentence. No fake socket caught that.
    assert.deepEqual(saw.notes, ["no-key"], `the press led nowhere: ${JSON.stringify(saw)}`);
    assert.equal(saw.hasAction, true, "the one condition a person can fix from this page has to offer the card");
    assert.equal(saw.orb, "off", "the orb went back to off rather than spinning at a line that is not there");
    // getUserMedia on the fake device is the other half: a refused microphone is a different
    // sentence, so reading the no-key one proves the device resolved.
    assert.ok(!saw.notes.includes("no-microphone"), `the fake audio device was not accepted: ${JSON.stringify(saw.notes)}`);

    // THE COMPOSER STILL FITS ON ONE ROW, at three widths, because this wave added a child to
    // somebody else's grid. Without the restored track, MEASURED here: Send was pushed onto a row of
    // its own and the form grew from 54 to 104 px at every width. The console phone wave is live on
    // this branch, so breaking that row would be breaking their work, and a source test cannot see it.
    //
    // EACH WIDTH IS A FRESH LOAD, not a resize of this page. Resizing proved misleading: app.js sizes
    // the shelf once at load, so a page opened at 1280 and resized to 768 kept a 306 px composer and
    // the message box measured 76 px -- a number no person would ever see. A person opens the console
    // at their own size, so that is what is measured.
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
          const f = form.getBoundingClientRect();
          const t = talk.getBoundingClientRect();
          const s = send.getBoundingClientRect();
          const hit = document.elementFromPoint(Math.round(t.left + t.width / 2), Math.round(t.top + t.height / 2));
          return {
            formHeight: Math.round(f.height), formWidth: Math.round(f.width),
            talkWidth: Math.round(t.width), boxWidth: Math.round(box.getBoundingClientRect().width),
            insideForm: t.left >= f.left - 1 && t.right <= f.right + 1,
            sameRowAsSend: Math.abs(t.top - s.top) < 12,
            reachable: talk.contains(hit) || hit === talk,
            sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        });
        const where = `${size.width}px: ${JSON.stringify(row)}`;
        assert.equal(row.sameRowAsSend, true, `Send was pushed off the composer's row. ${where}`);
        assert.ok(row.formHeight <= 64, `the composer grew, so a row wrapped. ${where}`);
        assert.equal(row.insideForm, true, `the talk button overflows the composer. ${where}`);
        assert.equal(row.reachable, true, `a mouse cannot reach the talk button. ${where}`);
        assert.equal(row.sideways, false, `the page scrolls sideways. ${where}`);
        // The message box has to stay usable. On a phone the word goes and the orb stays, which is
        // what buys that back: the button is the same 38 px circle as the attach button beside it.
        assert.ok(row.boxWidth >= 150, `the message box is too narrow to type in. ${where}`);
        if (size.width <= 690) assert.equal(row.talkWidth, 38, `the phone button kept its label. ${where}`);
        else assert.ok(row.talkWidth > 60, `the desktop button lost its label. ${where}`);
      } finally {
        await sized.close();
      }
    }

    // THE CARD, in a real page, because it is the only way a key is ever set. A key pasted over ssh
    // would be the hand operation no-hand-operations-on-the-product forbids, so this control existing
    // on screen is the mechanism, not a convenience -- and it mounts itself into a panel app.js paints.
    await page.click("#shelf-settings");
    let card = null;
    for (let n = 0; n < 40; n += 1) {
      card = await page.evaluate(() => {
        const node = document.querySelector("[data-voice]");
        if (node == null) return null;
        const rect = node.getBoundingClientRect();
        const key = node.querySelector("[data-voice-key]");
        return {
          visible: rect.height > 0,
          agents: node.querySelector("[data-voice-agent]") != null,
          keyType: key?.getAttribute("type") ?? "",
          keyValue: key?.value ?? "",
          keyNote: node.querySelector("[data-voice-key-note]")?.textContent.trim() ?? "",
          text: node.textContent.replace(/\s+/g, " ").trim(),
        };
      });
      if (card?.visible) break;
      await page.waitForTimeout(250);
    }
    assert.ok(card?.visible, "the Voice card never appeared in the settings panel, so no key could ever be set from the product");
    assert.equal(card.agents, true, "the agent choice is what points the first press at the head of the team");
    assert.equal(card.keyType, "password");
    assert.equal(card.keyValue, "", "the card starts empty, because the answer carries no value to fill it with");
    assert.match(card.keyNote, /No key yet/, `the card read: ${card.keyNote}`);
    for (const leak of ["xAI", "OpenAI", "Grok", "sendPrompt", "websocket"]) {
      assert.ok(!card.text.includes(leak), `${leak} reached the card in a real page`);
    }

    const ours = failures.filter((one) => /voice/i.test(one));
    assert.deepEqual(ours, [], `voice.js threw in a real page: ${ours.join(" | ")}`);
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
