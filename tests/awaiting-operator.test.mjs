// QOL-NEEDS-YOU: an agent that ends a turn asking the operator for something says so.
//
// Three halves are pinned here. The host's classifier -- the deterministic read of the turn's last
// delivered message that decides whether `awaitingUserResponse` goes up -- the host guard around
// it, which is what actually runs at the end of a turn, and the console's roster mapping, which
// turns that flag into the amber "Waiting on you" pill and the count that sits beside the agent
// count. The bug this covers: Scribe ended a turn asking the operator to sign in somewhere and the
// sidebar still read "Ready for the next task", because nothing but a box hand-off or an
// auto-review approval ever set the flag.
//
// The three false-badge cases the first cut shipped are pinned too, because each one is a NEW lie
// on a row that is supposed to be trustworthy: an unbounded read that re-lit an answered ask on
// any turn that delivered nothing new, a backwards sentence scan that read the agent's own
// rhetorical question as an ask, and a widget branch the host guard made unreachable.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundled = await build({
  entryPoints: [path.join(repoRoot, "source/shared/awaiting-operator.ts")],
  bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

// The host's own guard, bundled the same way. Every top-level await in this file happens here,
// before the first test is registered: the runner starts on registered tests while a module body
// with top-level await is still running, and an `after` hook that fires mid-body deletes the stage.
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".awaiting-operator-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const hostBundle = await build({
  entryPoints: [path.join(repoRoot, "source/host/extensions/transcript/turn-runtime.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser"], logLevel: "silent",
});
const hostBundlePath = path.join(stage, "turn-runtime.cjs");
writeFileSync(hostBundlePath, hostBundle.outputFiles[0].text, "utf8");
const { TurnRuntime } = createRequire(import.meta.url)(hostBundlePath);


const send = (id, content, extra = {}) => ({ kind: "send-message", id, message: { type: "text", content }, ...extra });
const widget = (id, prompt) => ({ kind: "send-message", id, message: { type: "widget", widget: { prompt, options: [] } } });
const user = (id, text) => ({ kind: "message", id, text });
// `null` for the turn boundary reads the whole list, which is what a first turn on an empty
// transcript does; the bounded cases below pass a real entry id.
const whole = (entries) => mod.operatorAskForTurn(entries, null);
const ask = (text) => whole([send("s1", text)]);

// ---------------------------------------------------------------- the classifier says yes
const ASKS = [
  ["the sign-in Scribe actually sent", "I've got the report ready but the dashboard logged me out. Can you sign in on the box and tell me when you're through?"],
  ["a bare closing question", "Both suites pass. Want me to push the branch?"],
  ["I need you to", "The deploy is staged. I need you to approve the change window before I run it."],
  ["you'll need to", "I can't reach the vendor portal from here. You'll need to enter the 2FA code on the box."],
  ["please sign in", "The session expired again. Please sign in to the console."],
  ["a bare operator imperative", "Everything else is done. Sign in to Okta and I'll pick it back up."],
  ["waiting on you", "I've stopped here — waiting on you for the credential."],
];
for (const [name, text] of ASKS) {
  test(`the classifier flags ${name}`, () => {
    const verdict = ask(text);
    assert.ok(verdict, `expected an ask for: ${text}`);
    assert.ok(verdict.reason.length > 0, "the badge carries the sentence that asked");
  });
}

test("a question widget is an ask, and its prompt is the reason", () => {
  const verdict = whole([widget("s1", "Which account should I use?")]);
  assert.deepEqual(verdict, { kind: "widget", reason: "Which account should I use?" });
});

test("the reason quotes the closing ask, not the first line of the report", () => {
  const verdict = ask("I read all 40 rows and rebuilt the index. The vendor portal wants a fresh login. Can you sign in?");
  assert.equal(verdict.kind, "question");
  assert.equal(verdict.reason, "Can you sign in?");
});

// ---------------------------------------------------------------- and the classifier says no
const QUIET = [
  ["a plain result", "Done. The index rebuilt in 4.2s and both suites pass."],
  ["a report that only mentions what the agent itself needs", "I need to rebuild the index first, so this will take another minute."],
  ["a question inside a code fence", "Here is the command I ran:\n```\ngrep -n \"why?\" ./src\n```\nIt matched nothing."],
  ["a question inside an inline span", "The literal string is `is it up?` and it never appears in the log."],
  ["an offer with no request in it", "Everything is deployed and green."],
  // The agent asking and answering its own question. The first cut scanned every sentence
  // backwards, so the "Why?" won and the row read "Waiting on you: Why?" while nothing was owed.
  ["a rhetorical question the agent answers itself", "The cache was cold. Why? Because the box restarted last night. Everything is green now."],
  ["a question quoted back before the answer", "You asked whether the deploy is safe. Is it safe? Yes, the rollback path is tested and green."],
];
for (const [name, text] of QUIET) {
  test(`the classifier leaves ${name} alone`, () => {
    assert.equal(ask(text), null, `expected no ask for: ${text}`);
  });
}

test("a hidden, threaded or peer-addressed message is not the operator's message", () => {
  assert.equal(whole([send("s1", "Can you sign in?", { hidden: true })]), null);
  assert.equal(whole([send("s1", "Can you sign in?", { branched: true })]), null);
  assert.equal(whole([send("s1", "Can you sign in?", { peerAgentId: "w2" })]), null);
});

test("only the LAST delivered message decides, so an answered question does not keep the badge up", () => {
  const entries = [send("s1", "Should I use the staging key?"), send("s2", "Never mind — the prod key was already on the box, so it is done.")];
  assert.equal(whole(entries), null);
  assert.equal(mod.lastAddressedMessage(entries).id, "s2");
});

test("an empty transcript asks nothing", () => {
  assert.equal(whole([]), null);
  assert.equal(mod.lastAddressedMessage([]), null);
});

test("the reason is capped so a whole essay never reaches the roster row", () => {
  const long = `${"the vendor portal wants a fresh login and ".repeat(20)}can you sign in?`;
  const verdict = ask(long);
  assert.ok(verdict.reason.length <= mod.OPERATOR_ASK_REASON_MAX, `reason was ${verdict.reason.length}`);
});

// The price of only reading the last sentence, written down so nobody "fixes" it back into a
// backwards scan without meeting the rhetorical-question cases above again. Missing this ask
// leaves the row saying "Ready for the next task", which is the old behaviour; the scan's failure
// put a wrong sentence on the row, which is worse.
test("an ask buried before a closing aside is missed, and that is the trade", () => {
  assert.equal(ask("Should I use the staging key? I'll hold until you say."), null);
});

// ---------------------------------------------------------------- one turn, not the conversation
// The read is given the id of the last entry from BEFORE the run, and classifies only what came
// after it. Without that bound every turn re-read the whole transcript, so a turn that delivered
// nothing to the operator re-lit an ask they had already answered -- and `isDeliveryOwed` is
// satisfied by a bare reaction, a peer message counts as a send, and a turn can end delivering
// nothing at all once the reply nudges give up. All three are ordinary turns.
const ANSWERED = [
  send("s1", "Can you sign in on the box?"),
  user("u1", "signed in, go ahead"),
];

test("a turn that delivered nothing does not re-raise the ask the operator already answered", () => {
  assert.equal(mod.operatorAskForTurn(ANSWERED, "u1"), null);
  // ...which is exactly what the unbounded read got wrong.
  assert.equal(whole(ANSWERED).reason, "Can you sign in on the box?");
});

test("a turn that only messaged a peer, or only reacted, raises nothing", () => {
  const peerOnly = [...ANSWERED, send("s2", "Can you sign in?", { peerAgentId: "w2" })];
  assert.equal(mod.operatorAskForTurn(peerOnly, "u1"), null);
  // A reaction stamps an existing entry rather than appending one, so the turn's window is empty.
  assert.equal(mod.operatorAskForTurn(ANSWERED, "u1"), null);
});

test("a NEW ask in the turn's own window still raises", () => {
  const entries = [...ANSWERED, send("s2", "The 2FA prompt is up. Can you enter the code?")];
  assert.equal(mod.operatorAskForTurn(entries, "u1").reason, "Can you enter the code?");
});

test("a boundary that is gone classifies nothing rather than guessing", () => {
  assert.equal(mod.entriesSinceTurnStart(ANSWERED, "cleared"), null);
  assert.equal(mod.operatorAskForTurn(ANSWERED, "cleared"), null);
});

// ---------------------------------------------------------------- through the host's own guard
// The cases above drive the classifier directly, which is how the widget branch shipped dead: the
// guard in turn-runtime returned early on `awaitingUserSelection`, and every widget send sets that
// flag, so the branch could never run in production however green its unit test was. These drive
// the real TurnRuntime.noteOperatorAsk -- the thing the end of a turn actually calls.
const DONE = { sentMessageCount: 1, reacted: false, aborted: false };
// A widget, a secret request and an auto-review approval all set this on the turn result.
const PARKED = { ...DONE, awaitingUserSelection: true };

function endTurn(entries, result, { epoch = 1, currentEpoch = 1, badge = null, since = "u1" } = {}) {
  let stored = badge;
  const session = {
    id: "w1",
    db: {
      getTranscriptEntries: () => entries,
      getAwaitingUserResponse: () => stored,
      setAwaitingUserResponse: (value) => { stored = value; },
    },
  };
  const runtime = new TurnRuntime({ sendPipeline: { currentTurnEpoch: () => currentEpoch } });
  runtime.noteOperatorAsk(session, result, epoch, since);
  return stored;
}

test("a question widget raises the badge through the guard that used to swallow it", () => {
  const raised = endTurn([...ANSWERED, widget("s2", "Which account should I use?")], PARKED);
  assert.equal(raised?.tabId, "turn-question");
  assert.equal(raised?.reason, "Which account should I use?");
});

test("a secret request or an approval parks the turn the same way but is not an ask", () => {
  const secret = { kind: "send-message", id: "s2", message: { type: "secret-request" } };
  const approval = { kind: "send-message", id: "s2", message: { type: "auto-review-approval" } };
  assert.equal(endTurn([...ANSWERED, secret], PARKED), null);
  assert.equal(endTurn([...ANSWERED, approval], PARKED), null);
});

test("a turn that delivered nothing leaves the row alone, answered ask and all", () => {
  assert.equal(endTurn(ANSWERED, { ...DONE, sentMessageCount: 0, reacted: true }), null);
  const peerOnly = [...ANSWERED, send("s2", "Can you sign in?", { peerAgentId: "w2" })];
  assert.equal(endTurn(peerOnly, DONE), null);
});

test("a new prose ask in the turn's window raises the badge", () => {
  const entries = [...ANSWERED, send("s2", "The 2FA prompt is up. Can you enter the code?")];
  assert.equal(endTurn(entries, DONE)?.reason, "Can you enter the code?");
});

test("an aborted turn, a superseded turn and a badge already up are all left alone", () => {
  const entries = [...ANSWERED, send("s2", "Can you enter the code?")];
  assert.equal(endTurn(entries, { ...DONE, aborted: true }), null);
  assert.equal(endTurn(entries, { ...DONE, quiescedForUpgrade: true }), null);
  assert.equal(endTurn(entries, DONE, { epoch: 1, currentEpoch: 2 }), null);
  const box = { tabId: "box", reason: "Sign in on the box", since: 1 };
  assert.deepEqual(endTurn(entries, DONE, { badge: box }), box);
});

// ---------------------------------------------------------------- the console's roster mapping
async function loadAdapter(answers = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { createGatewayAdapter };\n  global.__bootMachineRoom =",
  );
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: () => 0,
    clearInterval: () => {},
    EventSource: function () { return { onmessage: null }; },
    crypto: { randomUUID: () => "nonce-0001" },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, removeAttribute() {} } },
    open: () => {},
  };
  const defaults = { listAgents: [], getTrays: [], getAgentAutomations: [], getAgentWorkflows: [], getConversationOutline: [] };
  const fetchStub = async (url, init) => {
    const method = String(url).startsWith("/api/") ? String(url).slice(5) : null;
    if (method == null) return { ok: true, text: async () => "{}", json: async () => ({}) };
    const args = init?.body ? JSON.parse(init.body) : {};
    const answer = answers[method] ?? defaults[method] ?? {};
    const value = typeof answer === "function" ? await answer(args) : answer;
    return { ok: true, text: async () => JSON.stringify(value) };
  };
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  return fn(window, fetchStub);
}

const seed = () => ({
  activeContext: { kind: "worker", id: "w1" },
  openContexts: [{ kind: "worker", id: "w1" }],
  workers: [{ id: "w1", name: "Scribe", status: "ready", statusText: "Ready for the next task", messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, hasOlder: false, composer: null }],
  rooms: [], routines: [], plugins: [], models: { default: "d", available: [] },
  settings: { autoReview: { enabled: false, allow: [], block: [] }, localToolPermission: null, reachable: true },
  desktop: { paused: false, timeline: [] }, teaching: { active: false, workerId: null, startedAt: null },
});

const roster = (over = {}) => [{
  id: "w1", name: "Scribe", isRunning: false, isGroup: false, unreadCount: 0,
  lastActivityAt: 2, notifyOnUpdatesEnabled: true, isHiddenFromSidebar: false, ...over,
}];

test("the console reads the host's badge as needsYou, with the reason it carries", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    listAgents: roster({ awaitingUserResponse: { tabId: "turn-question", reason: "Can you sign in?", since: 1 } }),
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  const w = state.workers[0];
  assert.equal(w.status, "attention");
  assert.equal(w.statusText, "Waiting on you");
  assert.equal(w.needsYou, true);
  assert.equal(w.needsYouReason, "Can you sign in?");
  adapter.destroy();
});

test("a failed turn is attention but is NOT the operator's to answer, so it never inflates the count", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    listAgents: roster(),
    getTrays: [{ id: "t1", kind: "error", agentId: "w1", title: "Agent failed to respond" }],
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  const w = state.workers[0];
  assert.equal(w.status, "attention");
  assert.equal(w.statusText, "The last turn failed");
  assert.equal(w.needsYou, false);
  adapter.destroy();
});

test("the operator's reply drops the pill with the send, before the host's clear comes back", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    listAgents: roster({ awaitingUserResponse: { tabId: "turn-question", reason: "Can you sign in?", since: 1 } }),
    sendPrompt: { accepted: true },
    promptAcceptanceStatus: { outcome: "found", record: { status: "accepted", rejectionCode: null } },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  assert.equal(state.workers[0].needsYou, true);
  adapter.sendMessage({ kind: "worker", id: "w1" }, "signed in");
  assert.equal(state.workers[0].needsYou, false, "the pill goes on the send, not a heartbeat later");
  adapter.destroy();
});

// ---------------------------------------------------------------- the three console surfaces
// app.js is never evaluated by this suite (it wires a live DOM at load), so the surfaces are
// pinned against the source the browser gate then exercises -- the same way the marketplace
// click path is. A merge that drops one of the three would otherwise pass everything here.
test("the card, the header and the roster count all read the flag", async () => {
  const app = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const html = await readFile(path.join(repoRoot, "ui/machine-room/index.html"), "utf8");
  const css = await readFile(path.join(repoRoot, "ui/machine-room/styles.css"), "utf8");
  assert.match(app, /needsYouPillMarkup\(worker, "needs-you-pill"\)/, "the sidebar card draws the pill");
  assert.match(app, /renderNeedsYouCount\(\)/, "the roster heading draws the count");
  assert.match(app, /elements\.headerNeedsYou/, "the conversation header draws the pill");
  assert.match(html, /data-needs-you-count/, "index.html has the count slot");
  assert.match(html, /id="header-needs-you"/, "index.html has the header pill");
  assert.match(css, /\.needs-you-pill \{/, "the pill has a rule");
  assert.match(css, /\.roster-needs-you \{/, "the count has a rule");
});

test("a running agent is working, never waiting on you", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    listAgents: roster({ isRunning: true, awaitingUserResponse: { tabId: "box", reason: "sign in", since: 1 } }),
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  assert.equal(state.workers[0].status, "working");
  assert.equal(state.workers[0].needsYou, false);
  adapter.destroy();
});
