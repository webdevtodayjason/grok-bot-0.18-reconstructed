// QOL-NEEDS-YOU: an agent that ends a turn asking the operator for something says so.
//
// Two halves are pinned here. The host's classifier -- the deterministic read of the turn's last
// delivered message that decides whether `awaitingUserResponse` goes up -- and the console's
// roster mapping, which turns that flag into the amber "Waiting on you" pill and the count that
// sits beside the agent count. The bug this covers: Scribe ended a turn asking the operator to
// sign in somewhere and the sidebar still read "Ready for the next task", because nothing but a
// box hand-off or an auto-review approval ever set the flag.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundled = await build({
  entryPoints: [path.join(repoRoot, "source/shared/awaiting-operator.ts")],
  bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

const send = (id, content, extra = {}) => ({ kind: "send-message", id, message: { type: "text", content }, ...extra });
const widget = (id, prompt) => ({ kind: "send-message", id, message: { type: "widget", widget: { prompt, options: [] } } });
const ask = (text) => mod.operatorAskFromTranscript([send("s1", text)]);

// ---------------------------------------------------------------- the classifier says yes
const ASKS = [
  ["the sign-in Scribe actually sent", "I've got the report ready but the dashboard logged me out. Can you sign in on the box and tell me when you're through?"],
  ["a bare closing question", "Both suites pass. Want me to push the branch?"],
  ["I need you to", "The deploy is staged. I need you to approve the change window before I run it."],
  ["you'll need to", "I can't reach the vendor portal from here. You'll need to enter the 2FA code on the box."],
  ["please sign in", "The session expired again. Please sign in to the console."],
  ["a bare operator imperative", "Everything else is done. Sign in to Okta and I'll pick it back up."],
  ["waiting on you", "I've stopped here — waiting on you for the credential."],
  ["a question that is not the last sentence", "Should I use the staging key? I'll hold until you say."],
];
for (const [name, text] of ASKS) {
  test(`the classifier flags ${name}`, () => {
    const verdict = ask(text);
    assert.ok(verdict, `expected an ask for: ${text}`);
    assert.ok(verdict.reason.length > 0, "the badge carries the sentence that asked");
  });
}

test("a question widget is an ask, and its prompt is the reason", () => {
  const verdict = mod.operatorAskFromTranscript([widget("s1", "Which account should I use?")]);
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
];
for (const [name, text] of QUIET) {
  test(`the classifier leaves ${name} alone`, () => {
    assert.equal(ask(text), null, `expected no ask for: ${text}`);
  });
}

test("a hidden, threaded or peer-addressed message is not the operator's message", () => {
  assert.equal(mod.operatorAskFromTranscript([send("s1", "Can you sign in?", { hidden: true })]), null);
  assert.equal(mod.operatorAskFromTranscript([send("s1", "Can you sign in?", { branched: true })]), null);
  assert.equal(mod.operatorAskFromTranscript([send("s1", "Can you sign in?", { peerAgentId: "w2" })]), null);
});

test("only the LAST delivered message decides, so an answered question does not keep the badge up", () => {
  const entries = [send("s1", "Should I use the staging key?"), send("s2", "Never mind — the prod key was already on the box, so it is done.")];
  assert.equal(mod.operatorAskFromTranscript(entries), null);
  assert.equal(mod.lastAddressedMessage(entries).id, "s2");
});

test("an empty transcript asks nothing", () => {
  assert.equal(mod.operatorAskFromTranscript([]), null);
  assert.equal(mod.lastAddressedMessage([]), null);
});

test("the reason is capped so a whole essay never reaches the roster row", () => {
  const long = `${"the vendor portal wants a fresh login and ".repeat(20)}can you sign in?`;
  const verdict = ask(long);
  assert.ok(verdict.reason.length <= mod.OPERATOR_ASK_REASON_MAX, `reason was ${verdict.reason.length}`);
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
