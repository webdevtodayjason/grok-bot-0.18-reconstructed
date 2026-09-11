// ONBOARD-1 and AGENTS-CAP-1: the console's first-run dialog, and the cap it draws beside Add.
//
// Both blocks are sliced out of app.js and RUN here rather than copied, the way the Email card and
// the trigger editor are tested: a copy in this file would go on passing after the console changed.
//
// What is worth pinning, because each of these is a way the dialog could lie:
//   - the five questions are a contract with the host. save_onboarding_answer stores an answer
//     under one of these field names, so a rename here that the host does not know about leaves a
//     strip that never fills. The order is Titan's asking order.
//   - the dialog opens on ONE fact: the box saying done:false. A host too old for the command
//     answers null, and null is "this box cannot say", which is not a first run.
//   - Skip for now has to reach the box. A skip that closes the dialog on a flag that did not move
//     brings the dialog back on the next load, which is worse than not offering skip at all.
//   - an answer someone typed is drawn into the strip, so it goes through the page's own escaper.
//   - the cap counts BOTS. Rooms are not bots and the host does not count them against the cap, so
//     a console that counted them would refuse at twelve and blame the host.
//   - AGENTS-CAP-2: the default is 40 (Jason, 2026-09-09 06:34), and it is a FALLBACK. Every box
//     reports its own ceiling and applyReportedCap installs it, so a workspace the super admin
//     raised draws its own number. The cap-from-the-host case below is what proves that.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(repoRoot, "ui/machine-room/app.js");

const between = (source, startMark, endMark, what) => {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark);
  assert.ok(start > 0 && end > start, `${what} must be findable in app.js`);
  return source.slice(start, end);
};

// ---- the smallest DOM the two blocks touch -----------------------------------------------------
// Neither block walks a tree: it asks for an element by selector, then reads or writes text, HTML,
// a dataset key, a value or hidden. So a node is a bag with those on it.
function node(extra = {}) {
  const self = {
    textContent: "", innerHTML: "", value: "", title: "", hidden: false, disabled: false, focused: false,
    dataset: {}, attrs: {}, listeners: {}, open: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    focus() { self.focused = true; },
    setAttribute(name, value) { self.attrs[name] = String(value); },
    getAttribute(name) { return self.attrs[name] ?? null; },
    addEventListener(type, handler) { (self.listeners[type] ??= []).push(handler); },
    querySelector(selector) { return self.nodes?.[selector] ?? null; },
    querySelectorAll() { return []; },
    showModal() { self.open = true; },
    close() { self.open = false; },
    ...extra,
  };
  return self;
}

// The document the blocks reach through document.querySelector: the roster count and the Add badge.
function makeDocument() {
  const nodes = {
    "[data-agent-count]": node(),
    '[data-capability="add"] [data-add-count]': node(),
  };
  return { nodes, querySelector: (selector) => nodes[selector] ?? null };
}

// ---- the cap block -----------------------------------------------------------------------------
//
// AGENTS-CAP-2 and GATE-15. This file used to pin the literals 100 and 99. The default came down to
// 40 on 2026-09-09 and the ceiling is per workspace now -- the super admin raises one from its row
// in the admin console -- so a literal here is wrong for every workspace that has been raised, and
// editing the literal only moves the failure to the next decision. The number comes out of app.js,
// which is the file this suite is testing; what is pinned is the SHAPE and the arithmetic, which is
// what could actually lie to a person: bots against the ceiling, rooms left out, and Titan holding
// one of the seats.
//
// The marker is matched loosely for the same reason: the block's own comment names whichever row
// last moved the number, and a suite that broke because a comment was reworded would be pinning
// prose rather than behaviour.
const CAP_START = /[ \t]*\/\/ ---- AGENTS-CAP-\d[^\n]*\n/;
const CAP_END = "  // ---- end AGENTS-CAP";

/** The ceiling the console falls back to when no host has told it one. Read, never assumed. */
async function declaredCapDefault() {
  const source = await readFile(appPath, "utf8");
  const declared = Number(/AGENT_CAP_DEFAULT\s*=\s*(\d+)/.exec(source)?.[1]);
  assert.ok(Number.isInteger(declared) && declared > 1,
    "app.js must declare AGENT_CAP_DEFAULT: it is the number the console draws with no host behind it");
  return declared;
}

async function loadCap({ workers = [], rooms = [], agentCount = null, agentCap } = {}) {
  const source = await readFile(appPath, "utf8");
  const startMatch = CAP_START.exec(source);
  assert.ok(startMatch != null, "the cap block must be findable in app.js");
  const body = between(source, startMatch[0], CAP_END, "the cap block");
  const state = { workers, rooms, agentCount, ...(agentCap === undefined ? {} : { agentCap }) };
  const doc = makeDocument();
  const exports = "return { renderAgentCount, agentCapRefusal, agentCapRefusalText, agentCap, botCount, extraBotCount, extraBotCap };";
  const cap = new Function("state", "document", `${body}\n${exports}`)(state, doc);
  return { ...cap, doc, state, capDefault: await declaredCapDefault() };
}

const bot = (id, extra = {}) => ({ id, name: id, isGroup: false, ...extra });

test("AGENTS-CAP-2: the header and the Add button count bots against the console's ceiling", async () => {
  const { renderAgentCount, doc, capDefault } = await loadCap({
    workers: [bot("titan"), bot("books"), bot("inbox")],
    rooms: [{ id: "room", name: "Diag Room", isGroup: true }],
    agentCount: 4,
  });
  renderAgentCount();
  assert.equal(doc.nodes["[data-agent-count]"].textContent, `3 / ${capDefault} bots`);
  // Titan holds one of the seats, so two of the rest are taken.
  assert.equal(doc.nodes['[data-capability="add"] [data-add-count]'].textContent, `2 of ${capDefault - 1}`);
  // The host's own number counts the room, and it is on the tooltip rather than in the count.
  assert.match(doc.nodes["[data-agent-count]"].title, /The host counts 4, rooms included\./);
  assert.match(doc.nodes["[data-agent-count]"].title,
    new RegExp(`Titan and ${capDefault - 1} more bots\\. Rooms do not count\\.`));
});

test("AGENTS-CAP-2: a room is not a bot and does not eat a slot", async () => {
  const rooms = Array.from({ length: 6 }, (unused, i) => ({ id: `r${i}`, isGroup: true }));
  const { renderAgentCount, doc, capDefault } = await loadCap({ workers: [bot("titan")], rooms, agentCount: 7 });
  renderAgentCount();
  assert.equal(doc.nodes["[data-agent-count]"].textContent, `1 / ${capDefault} bots`);
  assert.equal(doc.nodes['[data-capability="add"] [data-add-count]'].textContent, `0 of ${capDefault - 1}`);
});

// The one that matters most now that the ceiling is per workspace: a raised workspace is a number
// the HOST reports, and the console has to draw that rather than its own fallback.
test("AGENTS-CAP-2: a cap the host reports wins over the console's default", async () => {
  const { renderAgentCount, doc, agentCapRefusalText } = await loadCap({
    workers: [bot("titan"), bot("books")], agentCount: 2, agentCap: 5,
  });
  renderAgentCount();
  assert.equal(doc.nodes["[data-agent-count]"].textContent, "2 / 5 bots");
  assert.equal(doc.nodes['[data-capability="add"] [data-add-count]'].textContent, "1 of 4");
  // The sentence is read at the moment of the refusal, so it names the cap the box is holding to
  // rather than the one this file was loaded with.
  assert.equal(agentCapRefusalText(), "This workspace holds Titan and 4 more bots. Remove one to add another, or ask the operator to raise this workspace's ceiling.");
});

test("AGENTS-CAP-2: with no cap from the host the sentence names the console's own default", async () => {
  const { agentCapRefusalText, capDefault } = await loadCap({ workers: [bot("titan")], agentCount: 1 });
  assert.equal(agentCapRefusalText(),
    `This workspace holds Titan and ${capDefault - 1} more bots. Remove one to add another, or ask the operator to raise this workspace's ceiling.`);
});

test("AGENTS-CAP-2: an empty roster with no answer from the host draws nothing", async () => {
  const { renderAgentCount, doc } = await loadCap({ workers: [], rooms: [], agentCount: null });
  renderAgentCount();
  assert.equal(doc.nodes["[data-agent-count]"].hidden, true);
  assert.equal(doc.nodes["[data-agent-count]"].textContent, "");
});

test("AGENTS-CAP-2: the host's own refusal is what the toast says", async () => {
  const { agentCapRefusal, capDefault } = await loadCap({ workers: [bot("titan")] });
  // Word for word, because the host is the one that knows what the ceiling is on this box, and on a
  // workspace the super admin raised that number is not the console's default. A hundred here is a
  // raised workspace's sentence, passed through untouched.
  const said = "This workspace holds Titan and 99 more bots. Remove one to add another.";
  assert.equal(agentCapRefusal(new Error(said)), said);
  // A host that refuses with something less readable still gets a plain sentence, and with nothing
  // readable to go on the console falls back to its own default rather than inventing a number.
  assert.equal(agentCapRefusal(new Error("Agent limit of 100 reached")),
    `This workspace holds Titan and ${capDefault - 1} more bots. Remove one to add another, or ask the operator to raise this workspace's ceiling.`);
  // Anything that is not a cap refusal is left alone, so a real failure is not dressed as one.
  assert.equal(agentCapRefusal(new Error("the host answered 502")), "");
  assert.equal(agentCapRefusal(null), "");
});

// ---- the onboarding block ----------------------------------------------------------------------
async function loadOnboarding({
  workers = [], rooms = [], activeId = null, adapter = {}, messages = [], live = true,
} = {}) {
  const source = await readFile(appPath, "utf8");
  const body = between(source, "  // ===== ONBOARD-1: the first-run setup with Titan", "  // ===== end ONBOARD-1", "the onboarding block");
  // The page's own escaper, not a copy: an escaping check against a copy proves nothing.
  const escaper = between(source, "  function escapeHtml(value) {", "  function sameContext(", "escapeHtml");

  const state = { workers, rooms, activeContext: { kind: "worker", id: activeId ?? workers[0]?.id ?? "" } };
  const transcript = node();
  const input = node();
  const content = node({ nodes: { "#onboarding-transcript": transcript, "#onboarding-input": input, ".onboarding-face": null } });
  const dialog = node({ nodes: { "[data-onboarding-skip]": node() } });
  const elements = { onboardingDialog: dialog, onboardingContent: content, transcript: node() };

  const calls = { sent: [], toasts: [], selected: [], simulated: [] };
  const timers = [];
  const win = {
    __machineRoomLive: live,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    setInterval: () => 1,
    clearInterval: () => {},
    TitanCrew: { indexOfCharacter: () => 0, stillFor: (i, mood) => `still-${i}-${mood}` },
    __titanMascots: { afterRender: () => {} },
  };
  const stubs = {
    adapter,
    state,
    elements,
    window: win,
    document: makeDocument(),
    Element: function Element() {},
    avatarMarkup: (worker, className) => `<span class="${className}" data-titan-character="Titan" data-titan-mood="calm"><titan-mascot></titan-mascot></span>`,
    messageMarkup: (message) => `<article class="message-row">${message.text}</article>`,
    contextMessages: () => messages,
    activeContext: () => state.activeContext,
    sameContext: (left, right) => Boolean(left && right && left.kind === right.kind && left.id === right.id),
    selectContext: (kind, id) => { calls.selected.push({ kind, id }); state.activeContext = { kind, id }; },
    showToast: (text) => calls.toasts.push(text),
    simulateReply: (context, text) => calls.simulated.push({ context, text }),
    fillAttachments: () => {},
    requestAnimationFrame: () => {},
  };
  const exports = "return { ONBOARDING_STEPS, onboardingTitan, onboardingMarkup, onboardingMood,"
    + " renderOnboarding, maybeOpenOnboarding, openOnboarding, closeOnboarding, closeOnboardingFromButton,"
    + " sendOnboardingMessage, refreshOnboardingState };";
  const names = Object.keys(stubs);
  const block = new Function(...names, `${escaper}\n${body}\n${exports}`)(...names.map((name) => stubs[name]));
  return { ...block, calls, dialog, content, transcript, input, state, timers };
}

const seeded = (name, createdAt) => ({ id: name.toLowerCase(), name, createdAt, isGroup: false, status: "ready" });

test("ONBOARD-1: the five things Titan keeps are the host's own fields, in his order", async () => {
  const { ONBOARDING_STEPS } = await loadOnboarding({ workers: [seeded("Titan", 1)] });
  // These field names are the keys the host stores an answer under. Renaming one here without
  // renaming it there leaves a strip that never fills, so this list is the contract.
  assert.deepEqual(ONBOARDING_STEPS.map((step) => step.field),
    ["name", "location", "business", "ownsBusiness", "workingStyle"]);
  // Plain words, the way a business owner reads them: no field names, no jargon on screen. FIRSTRUN-2
  // made the interview open, so each label names the thing Titan is keeping rather than a question he
  // may never put: one paragraph can fill three of these at once and no question of their own is
  // asked for the ones it covered.
  assert.deepEqual(ONBOARDING_STEPS.map((step) => step.label),
    ["What to call you", "Where you are", "Your background and what you do", "Whether you own it", "How you want me to work"]);
});

test("ONBOARD-1: the face is Titan's, the same way the roster picks him", async () => {
  const byName = await loadOnboarding({ workers: [seeded("Books", 1), seeded("Titan", 9)] });
  assert.equal(byName.onboardingTitan().name, "Titan", "the agent actually named Titan wins");

  const byAge = await loadOnboarding({ workers: [seeded("Books", 9), seeded("Inbox", 2)] });
  assert.equal(byAge.onboardingTitan().name, "Inbox", "with nobody named Titan, the oldest agent is him");

  const rooms = await loadOnboarding({ workers: [], rooms: [{ id: "r", isGroup: true }] });
  assert.equal(rooms.onboardingTitan(), null, "a room is nobody's first agent");
});

test("ONBOARD-1: the strip draws the five questions and fills as answers land", async () => {
  const load = await loadOnboarding({ workers: [seeded("Titan", 1)] });
  const empty = load.onboardingMarkup(load.onboardingTitan());
  for (const field of ["name", "location", "business", "ownsBusiness", "workingStyle"]) {
    assert.match(empty, new RegExp(`data-onboarding-step="${field}"`), `${field} is on the strip`);
  }
  assert.match(empty, />0 of 5 answered</);
  assert.equal((empty.match(/onboarding-step/g) ?? []).length > 4, true);
  assert.doesNotMatch(empty, /is-done/, "nothing is ticked before an answer arrives");
  assert.match(empty, /onboarding-face/, "Titan's face is in it");
  assert.match(empty, /data-onboarding-composer/, "and a box to answer him in");

  // The answers the host reports. Two in, three to go.
  const filled = await loadOnboarding({
    workers: [seeded("Titan", 1)],
    adapter: { getOnboardingState: async () => ({ done: false, answers: { name: "Jason", location: "Texas" } }) },
  });
  filled.dialog.open = true;
  await filled.refreshOnboardingState();
  const markup = filled.onboardingMarkup(filled.onboardingTitan());
  assert.match(markup, />2 of 5 answered</);
  assert.match(markup, /data-onboarding-step="name"[^]*?is-done|is-done[^]*?data-onboarding-step="name"/);
  assert.match(markup, /Jason/, "the answer is shown back on the chip");
  assert.doesNotMatch(markup, /data-onboarding-step="business"[^]*?is-done/);
});

test("ONBOARD-1: an answer someone typed goes through the page's own escaper", async () => {
  const load = await loadOnboarding({
    workers: [seeded("Titan", 1)],
    adapter: { getOnboardingState: async () => ({ done: false, answers: { name: "<img src=x onerror=alert(1)>" } }) },
  });
  load.dialog.open = true;
  await load.refreshOnboardingState();
  const markup = load.onboardingMarkup(load.onboardingTitan());
  assert.doesNotMatch(markup, /<img src=x/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("ONBOARD-1: the dialog opens only on a box that says setup is not done", async () => {
  // The console opened on somebody else, which is what a box with a roster does.
  const opens = await loadOnboarding({
    workers: [seeded("Titan", 1), seeded("Books", 2)],
    activeId: "books",
    adapter: { getOnboardingState: async () => ({ done: false, answers: {} }), startOnboarding: async () => ({ started: true }) },
  });
  opens.maybeOpenOnboarding();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens.dialog.open, true);
  // The dialog is bound to HIS conversation, and the console is left on it when the dialog closes.
  assert.deepEqual(opens.calls.selected.at(-1), { kind: "worker", id: "titan" });
  assert.deepEqual(opens.state.activeContext, { kind: "worker", id: "titan" });
  // The body is filled after showModal, so without this the browser's first focus lands on Skip
  // for now, which is the one control in the dialog at that moment.
  assert.equal(opens.input.focused, true, "the caret is in the box the person answers in");

  const done = await loadOnboarding({
    workers: [seeded("Titan", 1)],
    adapter: { getOnboardingState: async () => ({ done: true, answers: {} }) },
  });
  done.maybeOpenOnboarding();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done.dialog.open, false, "a box that has been set up opens nothing");

  // A host older than this wave. tryCall answers null, which says this box cannot report a first
  // run -- not that it is in one.
  const old = await loadOnboarding({
    workers: [seeded("Titan", 1)],
    adapter: { getOnboardingState: async () => null },
  });
  old.maybeOpenOnboarding();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(old.dialog.open, false, "a host that cannot answer opens nothing");

  // An adapter with no such method at all, which is the offline demo before it is armed.
  const absent = await loadOnboarding({ workers: [seeded("Titan", 1)], adapter: {} });
  absent.maybeOpenOnboarding();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(absent.dialog.open, false);
});

test("ONBOARD-1: the console asks for Titan's opening line itself, once", async () => {
  const started = [];
  const load = await loadOnboarding({
    workers: [seeded("Titan", 1)],
    adapter: {
      getOnboardingState: async () => ({ done: false, answers: {} }),
      startOnboarding: async (id) => { started.push(id); return { started: true }; },
    },
  });
  load.openOnboarding();
  await new Promise((resolve) => setImmediate(resolve));
  load.closeOnboarding();
  load.openOnboarding();
  await new Promise((resolve) => setImmediate(resolve));
  // The fresh-box first agent never gets the host's own kickstart, so this send is the only thing
  // that opens the conversation -- and a second open must not fire a second one at it.
  assert.deepEqual(started, ["titan"]);
});

test("ONBOARD-1: an answer is sent to Titan and he looks pleased about it", async () => {
  const sent = [];
  const load = await loadOnboarding({
    workers: [seeded("Titan", 1)],
    adapter: { sendMessage: (context, text) => sent.push({ context, text }) },
  });
  assert.equal(load.onboardingMood(), "curious", "he is curious while he waits");
  load.sendOnboardingMessage("  Jason  ");
  assert.deepEqual(sent, [{ context: { kind: "worker", id: "titan" }, text: "Jason" }]);
  assert.equal(load.onboardingMood(), "excited", "and pleased the moment an answer lands");
  // Live, Titan answers for himself; a simulated reply would talk over him.
  assert.equal(load.calls.simulated.length, 0);

  const empty = await loadOnboarding({ workers: [seeded("Titan", 1)], adapter: { sendMessage: () => sent.push("no") } });
  empty.sendOnboardingMessage("   ");
  assert.equal(sent.length, 1, "an empty box sends nothing");
});

test("ONBOARD-1: offline, the demo answers because there is no host to", async () => {
  const load = await loadOnboarding({
    workers: [seeded("Titan", 1)], live: false, adapter: { sendMessage: () => {} },
  });
  load.sendOnboardingMessage("Jason");
  assert.equal(load.calls.simulated.length, 1);
});

test("ONBOARD-1: Skip for now reaches the box and takes the answers with it", async () => {
  const completed = [];
  const load = await loadOnboarding({
    workers: [seeded("Titan", 1)],
    adapter: {
      getOnboardingState: async () => ({ done: false, answers: { name: "Jason" } }),
      completeOnboarding: async (answers, options) => { completed.push({ answers, options }); return { done: true, answers }; },
    },
  });
  load.maybeOpenOnboarding();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(load.dialog.open, true);
  const button = load.dialog.nodes["[data-onboarding-skip]"];
  assert.equal(button.textContent, "Skip for now", "one answer in, so there is still something to skip");
  load.closeOnboardingFromButton(button);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // Whatever Titan captured before the click goes with it: a person who skips halfway keeps what
  // they already said. And the box is told it was a skip, so the record can tell the two apart.
  assert.deepEqual(completed, [{ answers: { name: "Jason" }, options: { skipped: true } }]);
  assert.equal(load.dialog.open, false);
  assert.match(load.calls.toasts.join(" "), /Setup closed\./);
});

// The bug this pins: completeOnboarding used to be reachable ONLY from a button that says the
// person skipped, so somebody who answered all five was told they had given up on setup, and
// closing the tab instead reopened the whole first run on the next load. Titan closes it himself
// now (finish_onboarding, which the box reports on the next poll); this is the other half, the way
// out the person holds, and once there is nothing left to skip it stops claiming there is.
test("ONBOARD-1: with all five answered the way out says Done, and the box is not told it was skipped", async () => {
  const completed = [];
  const answers = {
    name: "Jason", location: "Fort Worth, Texas", business: "an MSP",
    ownsBusiness: "yes", workingStyle: "hand it off",
  };
  const load = await loadOnboarding({
    workers: [seeded("Titan", 1)],
    adapter: {
      getOnboardingState: async () => ({ done: false, answers }),
      completeOnboarding: async (given, options) => { completed.push({ given, options }); return { done: true, answers: given }; },
    },
  });
  load.maybeOpenOnboarding();
  await new Promise((resolve) => setImmediate(resolve));
  const button = load.dialog.nodes["[data-onboarding-skip]"];
  assert.equal(button.textContent, "Done");
  load.closeOnboardingFromButton(button);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed, [{ given: answers, options: { skipped: false } }]);
  assert.equal(load.dialog.open, false);
  assert.match(load.calls.toasts.join(" "), /Setup is done\./);
});

test("ONBOARD-1: a skip the box refused leaves the dialog open and says so", async () => {
  const load = await loadOnboarding({
    workers: [seeded("Titan", 1)],
    adapter: {
      getOnboardingState: async () => ({ done: false, answers: {} }),
      completeOnboarding: async () => { throw new Error("the host answered 500"); },
    },
  });
  load.maybeOpenOnboarding();
  await new Promise((resolve) => setImmediate(resolve));
  const button = load.dialog.nodes["[data-onboarding-skip]"];
  load.closeOnboardingFromButton(button);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // Closing on a flag that did not move brings the dialog back on the next load, which is the one
  // outcome worse than not offering skip at all.
  assert.equal(load.dialog.open, true);
  assert.equal(button.disabled, false, "and the button can be tried again");
  assert.match(load.calls.toasts.join(" "), /Setup was not closed: the host answered 500/);
});

test("ONBOARD-1: the box reporting done closes the dialog on its own", async () => {
  let done = false;
  const load = await loadOnboarding({
    workers: [seeded("Titan", 1)],
    adapter: {
      getOnboardingState: async () => ({ done, answers: {} }),
      startOnboarding: async () => ({ started: true }),
    },
  });
  load.maybeOpenOnboarding();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(load.dialog.open, true);
  // completeOnboarding landing from Titan's own side, which is how the interview ends.
  done = true;
  await load.refreshOnboardingState();
  assert.equal(load.dialog.open, false);
});
