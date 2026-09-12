// Wave C1 (docs/GAP-ANALYSIS.md GW-03, GW-05, GW-08 item 2, GW-10): the gateway adapter behind
// the Machine Room, driven against a stub gateway that records every command it is sent. What is
// pinned here is the part a browser gate cannot see from the DOM: which command was called, with
// which arguments, and what the adapter did with the answer. Shapes are the ones the live box
// answered on 2026-09-03:
//   getAgentTranscriptTail {id,limit}            -> { entries, nextBeforeSeq? }
//   getAgentTranscriptPage {id,beforeSeq,untilMs,limit} -> { entries, nextBeforeSeq? }
//   promptAcceptanceStatus {accountSlot,clientNonce} -> { outcome:"found", record:{status,rejectionCode} } | { outcome:"not-found" }
//   getForeverBoxStatus {id}                     -> { agentId, state, vncUrl, handoff: null | { requestId, instruction, startedAt, snapshotAt? } }
//   skipBoxHandoff {id}                          -> {ok:true} (HANDBACK-1; an older host answers
//                                                   "unknown gateway method", and a host from before the fix
//                                                   answers a bare `null`, which is what this stub sends)
//   handBackForeverBox {id,trigger}              -> {ok:true}, and `null` on a host from before the fix
// HANDBACK-1 changed that `handoff` shape: it used to forward the whole PendingHandoff including
// snapshotDataUrl, which put a base64 screenshot on every 15 s heartbeat. It carries no image now.
//   getAgentWorkflows {id}                       -> WorkflowRecord[] (shared/workflow-model.ts)
//   getAgentChannels {id}                        -> { manifests:[{platform}], connections:[{platform,...}] }
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const entry = (id, kind, text, ms, extra = {}) => (kind === "user"
  ? { kind: "message", id, role: "user", content: text, timestampMs: ms, ...extra }
  : { kind: "send-message", id, message: { type: "text", content: text }, timestampMs: ms, ...extra });

async function loadAdapter(answers = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { createGatewayAdapter, messagesOf, weaveToolRows, skillsOf, channelsOf, describeAcceptance, boxHandoffOf, displayOfVncUrl, recordSig };\n  global.__bootMachineRoom =",
  );
  const calls = [];
  const window = {
    createDemoAdapter: () => ({}),
    // Real, short: acceptanceOf sleeps between ledger reads. The heartbeat must never run here.
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
    calls.push({ method, args });
    const answer = answers[method] ?? defaults[method] ?? {};
    // An async answer holds the call open, so a test can drive a second read through the adapter
    // while the first is in flight.
    const value = await (typeof answer === "function" ? answer(args, calls) : answer);
    if (value instanceof Error) return { ok: false, status: 500, text: async () => JSON.stringify({ error: value.message }) };
    return { ok: true, text: async () => JSON.stringify(value) };
  };
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  return { ...fn(window, fetchStub), calls };
}

const seed = () => ({
  activeContext: { kind: "worker", id: "w1" },
  openContexts: [{ kind: "worker", id: "w1" }],
  workers: [{ id: "w1", name: "Probe", status: "ready", statusText: "Ready", messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, boxDisplay: null, hasOlder: false, composer: null }],
  rooms: [], routines: [], plugins: [], models: { default: "d", available: [] },
  settings: { autoReview: { enabled: false, allow: [], block: [] }, localToolPermission: null, reachable: true },
  desktop: { paused: false, timeline: [] }, teaching: { active: false, workerId: null, startedAt: null },
});

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const only = (calls, method) => calls.filter((c) => c.method === method);

test("GW-03: a send carries a nonce and the composer state is the ledger's answer, not the click", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    sendPrompt: { accepted: true },
    promptAcceptanceStatus: { outcome: "found", record: { status: "accepted", rejectionCode: null } },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  adapter.sendMessage({ kind: "worker", id: "w1" }, "Reply with the single word: ready.");
  const w = state.workers[0];
  assert.equal(w.composer.state, "sending");
  await settle(60);
  const sent = only(calls, "sendPrompt");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].args.agentId, "w1");
  assert.equal(sent[0].args.clientNonce, "nonce-0001");
  const asked = only(calls, "promptAcceptanceStatus");
  assert.ok(asked.length >= 1, "promptAcceptanceStatus was polled after the send");
  assert.deepEqual(asked[0].args, { accountSlot: "host", clientNonce: "nonce-0001" });
  assert.equal(w.composer.state, "accepted");
  assert.equal(w.composer.text, "Accepted by the host");
  assert.equal(w.composer.nonce, "nonce-0001");
  // The dots stay up: the send was taken, the reply is what clears them.
  assert.ok(w.messages.some((m) => m.type === "working"));
  assert.equal(only(calls, "getAgentTranscript").length, 0, "the refresh after a send reads the tail, never the whole transcript");
  assert.ok(only(calls, "getAgentTranscriptTail").length >= 1);
  adapter.destroy();
});

test("ROUTER-1: Think harder is pinned per conversation and reaches sendPrompt", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    sendPrompt: { accepted: true },
    promptAcceptanceStatus: { outcome: "found", record: { status: "accepted", rejectionCode: null } },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  state.workers.push({ ...state.workers[0], id: "w2", name: "Second", messages: [] });
  const adapter = createGatewayAdapter(state);
  adapter.setThinkHarder({ kind: "worker", id: "w1" }, true);
  assert.equal(adapter.getThinkHarder({ kind: "worker", id: "w1" }), true);
  assert.equal(adapter.getThinkHarder({ kind: "worker", id: "w2" }), false);
  adapter.sendMessage({ kind: "worker", id: "w1" }, "hard");
  adapter.sendMessage({ kind: "worker", id: "w2" }, "light");
  await settle(60);
  const sent = only(calls, "sendPrompt");
  assert.equal(sent.find((row) => row.args.agentId === "w1").args.thinkHarder, true);
  assert.equal(Object.hasOwn(sent.find((row) => row.args.agentId === "w2").args, "thinkHarder"), false);
  adapter.destroy();
});

test("GW-03: a send the host did not accept says so, with the host's reason, and drops the dots", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    sendPrompt: { accepted: true },
    promptAcceptanceStatus: { outcome: "found", record: { status: "rejected", rejectionCode: "runner-unattached" } },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  adapter.sendMessage({ kind: "worker", id: "w1" }, "hello");
  await settle(60);
  const w = state.workers[0];
  assert.equal(w.composer.state, "not-accepted");
  assert.match(w.composer.text, /^Not accepted — runner-unattached/);
  assert.equal(w.messages.some((m) => m.type === "working"), false, "no dots for a send the host refused");
  assert.equal(w.status, "attention");
  adapter.destroy();
});

test("GW-03: no ledger record after a send the gateway answered is reported, not shrugged off", async () => {
  const { createGatewayAdapter, describeAcceptance } = await loadAdapter({
    sendPrompt: { accepted: true },
    promptAcceptanceStatus: { outcome: "not-found" },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  adapter.sendMessage({ kind: "worker", id: "w1" }, "hello");
  await settle(80);
  assert.equal(state.workers[0].composer.state, "not-accepted");
  assert.match(state.workers[0].composer.text, /holds no record/);
  assert.equal(describeAcceptance({ outcome: "unknown-durability" }).state, "not-accepted");
  assert.equal(describeAcceptance({ outcome: "found", record: { status: "accepted" } }).state, "accepted");
  adapter.destroy();
});

test("GW-03: a send the gateway threw on is 'Sending failed', not 'not wired', and a failed refresh cannot undo an acceptance", async () => {
  const { createGatewayAdapter } = await loadAdapter({
    sendPrompt: new Error("endpoint unreachable"),
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  adapter.sendMessage({ kind: "worker", id: "w1" }, "hello");
  await settle(80);
  const w = state.workers[0];
  assert.equal(w.composer.state, "not-accepted");
  assert.match(w.composer.text, /^Not accepted — .*endpoint unreachable/);
  const rows = w.messages.filter((m) => m.type === "system").map((m) => m.text);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^Sending failed: .*endpoint unreachable/);
  assert.ok(!rows.some((t) => /not wired/.test(t)), "a refused send is not a missing wire");
  adapter.destroy();

  // Accepted, then the refresh rejects: the verdict on screen stays the host's.
  const second = await loadAdapter({
    sendPrompt: { accepted: true },
    promptAcceptanceStatus: { outcome: "found", record: { status: "accepted", rejectionCode: null } },
    getAgentTranscriptTail: new Error("tail unavailable"),
  });
  const state2 = seed();
  const adapter2 = second.createGatewayAdapter(state2);
  adapter2.sendMessage({ kind: "worker", id: "w1" }, "hello");
  await settle(120);
  assert.equal(state2.workers[0].composer.state, "accepted");
  assert.equal(state2.workers[0].messages.filter((m) => m.type === "system").length, 0);
  adapter2.destroy();
});

test("GW-03: refresh reads a bounded tail and scrolling back pages older entries in through getAgentTranscriptPage", async () => {
  const tail = { entries: [entry("t5", "user", "five", 5), entry("t6", "agent", "six", 6, { evidence: { attemptId: "att-6", verdict: "evidenced", receipts: 1, missing: [] } })], nextBeforeSeq: 5 };
  const page = { entries: [entry("t3", "user", "three", 3), entry("t4", "agent", "four", 4)], nextBeforeSeq: 3 };
  const lastPage = { entries: [entry("t1", "user", "one", 1), entry("t2", "agent", "two", 2)] };
  const { createGatewayAdapter, calls } = await loadAdapter({
    getAgentTranscriptTail: tail,
    getAgentTranscriptPage: (args) => (args.beforeSeq === 5 ? page : lastPage),
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const events = [];
  adapter.subscribe((e) => events.push(e.type));
  await adapter.refresh();
  const w = state.workers[0];
  assert.deepEqual(only(calls, "getAgentTranscript"), []);
  assert.deepEqual(only(calls, "getAgentTranscriptTail")[0].args, { id: "w1", limit: 150 });
  assert.deepEqual(w.messages.filter((m) => m.type !== "system").map((m) => m.text), ["five", "six"]);
  // The verdict rides on the reply itself and the view draws it as a chip inside that reply's row.
  // It is deliberately not a system line any more: the synthesized "Evidence: <verdict> · <why>"
  // row read as an error under a reply that had been delivered (EVID-UX-1).
  assert.equal(w.messages.find((m) => m.text === "six")?.evidence?.verdict, "evidenced", "the tail-loaded reply keeps its stamp");
  assert.ok(!w.messages.some((m) => m.type === "system" && /^Evidence:/.test(m.text)), "and no system line is synthesized beside it");
  assert.equal(w.hasOlder, true);

  const first = await adapter.loadOlderMessages({ kind: "worker", id: "w1" });
  assert.deepEqual(first, { loaded: 2, more: true });
  const paged = only(calls, "getAgentTranscriptPage");
  assert.equal(paged.length, 1);
  assert.equal(paged[0].args.id, "w1");
  assert.equal(paged[0].args.beforeSeq, 5);
  assert.equal(paged[0].args.limit, 150);
  assert.ok(Number.isFinite(paged[0].args.untilMs));
  assert.deepEqual(w.messages.filter((m) => m.type !== "system").map((m) => m.text), ["three", "four", "five", "six"]);
  assert.equal(events.at(-1), "transcript:older");

  const second = await adapter.loadOlderMessages({ kind: "worker", id: "w1" });
  assert.deepEqual(second, { loaded: 2, more: false });
  assert.equal(w.hasOlder, false);
  assert.deepEqual(w.messages.filter((m) => m.type !== "system").map((m) => m.text), ["one", "two", "three", "four", "five", "six"]);
  // A refresh re-reads the tail and splices it over the window; the pages scrolled up for stay.
  await adapter.refresh();
  assert.deepEqual(w.messages.filter((m) => m.type !== "system").map((m) => m.text), ["one", "two", "three", "four", "five", "six"]);
  const third = await adapter.loadOlderMessages({ kind: "worker", id: "w1" });
  assert.deepEqual(third, { loaded: 0, more: false });
  assert.equal(only(calls, "getAgentTranscriptPage").length, 2, "no page is asked for once the host has no cursor");
  adapter.destroy();
});

test("GW-03: outline tool rows weave into a tail window without dragging the whole history in", async () => {
  const { weaveToolRows } = await loadAdapter();
  const outline = [
    { kind: "user", text: "one" }, { kind: "tool-call", id: "a", name: "shellToolCall", summary: "ls" },
    { kind: "send-message", message: { type: "text", content: "two" } },
    { kind: "user", text: "five" }, { kind: "tool-call", id: "b", name: "readToolCall", summary: "cat x" },
    { kind: "send-message", message: { type: "text", content: "six" } },
  ];
  const window = [entry("t5", "user", "five", 5), entry("t6", "agent", "six", 6)];
  const partial = weaveToolRows(window, outline, true).map((e) => e.id ?? e.kind);
  assert.deepEqual(partial, ["t5", "tool-b", "t6"], "only the row between entries the window holds is placed");
  const whole = weaveToolRows([entry("t1", "user", "one", 1), entry("t2", "agent", "two", 2), ...window], outline, false).map((e) => e.id);
  assert.deepEqual(whole, ["t1", "tool-a", "t2", "t5", "tool-b", "t6"]);
});

test("GW-10: the hand-back control calls handBackForeverBox {id, trigger:'button'} and reads the box back", async () => {
  let handoff = { requestId: "r1", instruction: "log in to the portal" };
  const { createGatewayAdapter, calls } = await loadAdapter({
    getForeverBoxStatus: () => ({ agentId: "w1", state: "running", handoff }),
    // WHAT THE HOST REALLY ANSWERS. endHandoff returns void, so until this wave a successful
    // hand-back and a successful skip both came back as the four bytes `null` -- the same answer a
    // client gets for a command the host has never heard of. The stub used to send `{}`, which is
    // why the test suite was green while every Skip on every box told the person their software was
    // too old. Both commands answer {ok:true} now; the stubs stay on `null` because that is what a
    // box still running the older host sends and it must keep working.
    handBackForeverBox: () => { handoff = null; return null; },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  assert.deepEqual(state.workers[0].handoff, { requestId: "r1", instruction: "log in to the portal" });
  const result = await adapter.handBack("w1");
  assert.deepEqual(only(calls, "handBackForeverBox")[0].args, { id: "w1", trigger: "button" });
  assert.deepEqual(result, { pending: false });
  assert.equal(state.workers[0].handoff, null);
  adapter.destroy();
});

test("GW-10: the Updates panel reads getHostStatus and its two writes are updateForeverBox / resetForeverBox", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    getHostStatus: { hostVersion: "2fcb12d", latestHostVersion: "dd30753", hostUpdateAvailable: true, isBusy: false, capabilities: ["sendAcceptanceV1"] },
    updateForeverBox: { state: "recreating" },
    resetForeverBox: { state: "recreating" },
  });
  const adapter = createGatewayAdapter(seed());
  const status = await adapter.getHostStatus();
  assert.equal(status.hostVersion, "2fcb12d");
  assert.equal(status.hostUpdateAvailable, true);
  assert.deepEqual((await adapter.updateBox("w1")).state, "recreating");
  assert.deepEqual(only(calls, "updateForeverBox")[0].args, { id: "w1" });
  assert.deepEqual((await adapter.resetBox("w1")).state, "recreating");
  assert.deepEqual(only(calls, "resetForeverBox")[0].args, { id: "w1" });
  assert.equal(only(calls, "updateHostNow").length, 0, "updateHostNow is not wired: this box runs a locally patched bundle");
  adapter.destroy();
});

test("GW-05: skills are the host's workflows, every write read back, and a run is addressed to this agent", async () => {
  const record = (over = {}) => ({ id: "gate-probe", name: "Gate probe", description: "d", body: "Reply with the single word: done.", trigger: null, source: "workflow", sourceRef: null, isEnabledForAgent: true, createdAt: 1, helperScripts: [], filePath: "/x/SKILL.md", ...over });
  let rows = [record(), record({ id: "nightly", name: "Nightly", source: "automation", trigger: { schedule: "0 8 * * *", isEnabled: true } })];
  const { createGatewayAdapter, calls, skillsOf } = await loadAdapter({
    getAgentWorkflows: () => rows,
    setAgentWorkflowEnabled: (args) => { rows = rows.map((r) => (r.id === args.workflowId ? { ...r, isEnabledForAgent: args.isEnabled } : r)); return rows; },
    deleteAgentWorkflow: (args) => { rows = rows.filter((r) => r.id !== args.workflowId); return rows; },
    importAgentWorkflowText: (args) => { rows = [...rows, record({ id: "pasted", name: "Pasted skill", body: args.markdown })]; return { workflows: rows, result: { imported: [{ id: "pasted", name: "Pasted skill" }], skipped: [] } }; },
    portAgentLocalSkills: () => ({ workflows: rows, result: { imported: [{ id: "claude-memory", name: "Claude memory" }], skipped: [{ source: "/home/box/AGENTS.md", reason: "could not link" }] } }),
    sendPrompt: { accepted: true },
    runAgentWorkflowNow: {},
    getAgentTranscriptTail: { entries: [] },
  });
  // A routine created on the Routines panel is listed by the host as source "automation"; it
  // stays on that panel rather than being drawn twice.
  assert.deepEqual(skillsOf(rows).map((s) => s.id), ["gate-probe"]);
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  assert.deepEqual(state.workers[0].skills.map((s) => `${s.id}:${s.enabled}`), ["gate-probe:true"]);

  const off = await adapter.setSkillEnabled("w1", "gate-probe", false);
  assert.deepEqual(only(calls, "setAgentWorkflowEnabled")[0].args, { id: "w1", workflowId: "gate-probe", isEnabled: false });
  assert.equal(off.enabled, false);
  assert.equal(state.workers[0].skills[0].enabled, false);
  const on = await adapter.setSkillEnabled("w1", "gate-probe", true);
  assert.equal(on.enabled, true);

  const imported = await adapter.importSkillText("w1", "---\nname: Pasted skill\n---\nReply with the single word: done.");
  assert.equal(only(calls, "importAgentWorkflowText")[0].args.id, "w1");
  assert.match(only(calls, "importAgentWorkflowText")[0].args.markdown, /Pasted skill/);
  assert.deepEqual(imported.imported, ["Pasted skill"]);
  assert.deepEqual(imported.skipped, []);

  // Unscheduled: the host's own runAgentWorkflowNow sends "@name" with no agentId, to whichever
  // agent it has active. The adapter sends the same reference prompt, addressed to this agent.
  const run = await adapter.runSkill("w1", "gate-probe");
  assert.equal(run.via, "sendPrompt");
  const sent = only(calls, "sendPrompt").at(-1).args;
  assert.equal(sent.agentId, "w1");
  assert.equal(sent.prompt, "@Gate probe");
  assert.match(sent.richText, /"workflowReference"/);
  assert.match(sent.richText, /"gate-probe"/);
  assert.equal(only(calls, "runAgentWorkflowNow").length, 0);

  // portAgentLocalSkills answers the same { workflows, result } shape as the imports.
  rows = [...rows, record({ id: "claude-memory", name: "Claude memory", sourceRef: "/home/box/CLAUDE.md" })];
  const ported = await adapter.portLocalSkills("w1");
  assert.deepEqual(only(calls, "portAgentLocalSkills")[0].args, { id: "w1" });
  assert.deepEqual(ported.imported, ["Claude memory"]);
  assert.deepEqual(ported.skipped, [{ source: "/home/box/AGENTS.md", reason: "could not link" }]);

  const name = await adapter.deleteSkill("w1", "gate-probe");
  assert.equal(name, "Gate probe");
  assert.deepEqual(only(calls, "deleteAgentWorkflow")[0].args, { id: "w1", workflowId: "gate-probe" });
  assert.deepEqual(state.workers[0].skills.map((s) => s.id), ["pasted", "claude-memory"]);
  adapter.destroy();
});

test("GW-05: a scheduled skill runs through runAgentWorkflowNow, and a write the host declined is an error", async () => {
  const rows = [{ id: "sweep", name: "Sweep", description: "", body: "sweep", trigger: { schedule: "0 8 * * 1-5", isEnabled: true }, source: "workflow", sourceRef: null, isEnabledForAgent: true, createdAt: 1, helperScripts: [], filePath: "/x/SKILL.md" }];
  const { createGatewayAdapter, calls } = await loadAdapter({
    getAgentWorkflows: rows,
    runAgentWorkflowNow: {},
    setAgentWorkflowEnabled: rows, // answers 200, keeps the flag
    deleteAgentWorkflow: rows, // answers 200, keeps the row
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  const run = await adapter.runSkill("w1", "sweep");
  assert.equal(run.via, "runAgentWorkflowNow");
  assert.deepEqual(only(calls, "runAgentWorkflowNow")[0].args, { id: "w1", workflowId: "sweep" });
  await assert.rejects(() => adapter.setSkillEnabled("w1", "sweep", false), /did not disable/);
  await assert.rejects(() => adapter.deleteSkill("w1", "sweep"), /still there/);
  adapter.destroy();
});

test("GW-08 item 2: a listener card's per-agent state comes from getAgentChannels for the agent on screen", async () => {
  const { createGatewayAdapter, calls, channelsOf } = await loadAdapter({
    getAgentChannels: { manifests: [{ platform: "slack" }, { platform: "github" }], connections: [{ platform: "slack", name: "titanium" }] },
    getAgentTranscriptTail: { entries: [] },
  });
  assert.deepEqual(channelsOf({ manifests: [{ platform: "slack" }], connections: [] }), [{ platform: "slack", connected: false, detail: "" }]);
  const state = seed();
  const adapter = createGatewayAdapter(state);
  assert.equal(state.workers[0].channels, null, "null until read: 'not read yet' is not 'none'");
  await adapter.refresh();
  assert.deepEqual(only(calls, "getAgentChannels")[0].args, { id: "w1" });
  assert.deepEqual(state.workers[0].channels, [
    { platform: "slack", connected: true, detail: "titanium" },
    { platform: "github", connected: false, detail: "" },
  ]);
  adapter.destroy();
});

// -- Review fixes (Wave C), each pinned against the stub gateway.

test("review: updateSkill sends a paused schedule back paused; a typo fix does not re-arm it", async () => {
  let rows = [{ id: "sweep", name: "Sweep", description: "", body: "sweep", trigger: { schedule: "0 8 * * 1-5", isEnabled: false }, source: "workflow", sourceRef: null, isEnabledForAgent: true, createdAt: 1, helperScripts: [], filePath: "/x/SKILL.md" }];
  const { createGatewayAdapter, calls, skillsOf } = await loadAdapter({
    getAgentWorkflows: () => rows,
    updateAgentWorkflow: (args) => { rows = rows.map((r) => (r.id === args.workflowId ? { ...r, ...args.spec } : r)); return rows; },
    getAgentTranscriptTail: { entries: [] },
  });
  assert.equal(skillsOf(rows)[0].triggerEnabled, false);
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  const saved = await adapter.updateSkill("w1", "sweep", { name: "Sweep", description: "", body: "sweep the tickets" });
  assert.deepEqual(only(calls, "updateAgentWorkflow")[0].args.spec.trigger, { schedule: "0 8 * * 1-5", isEnabled: false });
  assert.equal(saved.body, "sweep the tickets");
  assert.equal(saved.triggerEnabled, false);
  adapter.destroy();
});

test("review: an older page read while a refresh replaced the tail still lands on the window on screen", async () => {
  const tail = { entries: [entry("t5", "user", "five", 5), entry("t6", "agent", "six", 6)], nextBeforeSeq: 5 };
  const page = { entries: [entry("t3", "user", "three", 3), entry("t4", "agent", "four", 4)], nextBeforeSeq: 3 };
  let release;
  const gate = new Promise((r) => { release = r; });
  const { createGatewayAdapter, calls } = await loadAdapter({
    getAgentTranscriptTail: () => tail,
    // The page answer waits until the test has driven a refresh through the adapter.
    getAgentTranscriptPage: async () => { await gate; return page; },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  const w = state.workers[0];
  const older = adapter.loadOlderMessages({ kind: "worker", id: "w1" });
  await settle(5);
  await adapter.refresh();
  release();
  assert.deepEqual(await older, { loaded: 2, more: true });
  assert.deepEqual(w.messages.filter((m) => m.type !== "system").map((m) => m.text), ["three", "four", "five", "six"]);
  assert.equal(w.hasOlder, true);
  assert.equal(only(calls, "getAgentTranscriptPage").length, 1);
  adapter.destroy();
});

test("review: a reveal asked for right after selectContext waits for that load instead of a timer", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const tail = { entries: [entry("t5", "user", "five", 5), entry("t6", "agent", "six", 6)], nextBeforeSeq: 5 };
  const page = { entries: [entry("t3", "user", "three", 3), entry("t4", "agent", "four", 4)] };
  let tailReads = 0;
  const { createGatewayAdapter } = await loadAdapter({
    listAgents: [{ id: "w1", name: "Probe" }, { id: "w2", name: "Other" }],
    getAgentTranscriptTail: async (args) => { if (args.id === "w2") { tailReads += 1; await gate; return tail; } return { entries: [] }; },
    getAgentTranscriptPage: page,
  });
  const state = seed();
  state.workers.push({ ...seed().workers[0], id: "w2", name: "Other" });
  const adapter = createGatewayAdapter(state);
  const events = [];
  adapter.subscribe((e) => events.push(e.type));
  adapter.selectContext({ kind: "worker", id: "w2" });
  const reveal = adapter.revealEntry({ kind: "worker", id: "w2" }, "t3");
  await settle(5);
  assert.equal(tailReads, 1, "the select's read is in flight");
  assert.ok(!events.includes("transcript:reveal"), "nothing is revealed against an empty window");
  release();
  assert.equal(await reveal, true);
  assert.equal(events.at(-1), "transcript:reveal");
  assert.deepEqual(state.workers[1].messages.filter((m) => m.type !== "system").map((m) => m.text), ["three", "four", "five", "six"]);
  adapter.destroy();
});

test("review: a host whose capabilities list no acceptance ledger gets 'taken by the gateway', not 'not accepted'", async () => {
  let agents = [{ id: "w1", name: "Probe" }];
  const { createGatewayAdapter, calls } = await loadAdapter({
    getHostStatus: { hostVersion: "x", capabilities: [] },
    listAgents: () => agents,
    duplicateAgent: () => { agents = [...agents, { id: "w1-copy", name: "Probe copy" }]; return {}; },
    sendPrompt: { accepted: true },
    getAgentTranscriptTail: { entries: [] },
  });
  const adapter = createGatewayAdapter(seed());
  // hydrate runs at boot and on every rebuild; a duplicate is the rebuild the adapter exposes.
  await adapter.duplicateAgent("w1");
  assert.equal(adapter.getSnapshot().host.sendAcceptance, false);
  adapter.sendMessage({ kind: "worker", id: "w1" }, "hello", []);
  await settle(40);
  assert.equal(only(calls, "promptAcceptanceStatus").length, 0, "a host without the ledger is not asked for one");
  const composer = adapter.getSnapshot().workers.find((w) => w.id === "w1").composer;
  assert.equal(composer?.state, "sent");
  assert.match(composer?.text ?? "", /keeps no acceptance ledger/);
  adapter.destroy();
});

test("review: a rebuild keeps the conversation on screen and the open tabs when those agents still exist", async () => {
  let agents = [{ id: "w1", name: "Probe", lastActivityAt: 1 }, { id: "w2", name: "Newer", lastActivityAt: 9 }];
  const { createGatewayAdapter, calls } = await loadAdapter({
    listAgents: () => agents,
    duplicateAgent: () => { agents = [...agents, { id: "w1-copy", name: "Probe copy", lastActivityAt: 10 }]; return {}; },
    getHostStatus: { capabilities: ["sendAcceptanceV1"] },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  state.workers.push({ ...seed().workers[0], id: "w2", name: "Newer" });
  state.openContexts = [{ kind: "worker", id: "w2" }, { kind: "worker", id: "w1" }];
  const adapter = createGatewayAdapter(state);
  const copy = await adapter.duplicateAgent("w1");
  assert.equal(copy.id, "w1-copy");
  const after = adapter.getSnapshot();
  assert.deepEqual(after.activeContext, { kind: "worker", id: "w1" }, "the duplicate does not move the operator to another conversation");
  assert.deepEqual(after.openContexts.map((c) => c.id), ["w2", "w1"]);
  assert.equal(after.host.sendAcceptance, true);
  assert.equal(only(calls, "getHostStatus").length, 1, "capabilities are read once per hydrate");
  adapter.destroy();
});

test("review: a known avatar version is carried into the next rebuild instead of re-reading every avatar", async () => {
  let agents = [{ id: "w1", name: "Probe", avatarVersion: null }, { id: "w2", name: "Two", avatarVersion: null }];
  const { createGatewayAdapter, calls } = await loadAdapter({
    listAgents: () => agents,
    duplicateAgent: () => { agents = [...agents, { id: "w1-copy", name: "Probe copy", avatarVersion: null }]; return {}; },
    getAgentAvatar: (args) => ({ version: `v-${args.id}`, dataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  state.workers[0].avatarVersion = "v-w1";
  state.workers.push({ ...seed().workers[0], id: "w2", name: "Two" });
  const adapter = createGatewayAdapter(state);
  await adapter.duplicateAgent("w1");
  const reads = only(calls, "getAgentAvatar").map((c) => c.args.id).sort();
  assert.deepEqual(reads, ["w1-copy", "w2"], "w1's version was known from the previous state; only the rows without one are asked");
  const after = adapter.getSnapshot();
  assert.equal(after.workers.find((w) => w.id === "w1").avatarVersion, "v-w1");
  assert.equal(after.workers.find((w) => w.id === "w2").avatarVersion, "v-w2");
  adapter.destroy();
});

// MR-36 fixer: handBackForeverBox ends the hand-off and then AWAITS the turn it revived
// (resumeAfterBoxHandoff), so its answer can be a whole turn away. The host has already cleared
// the hand-off by then. Hanging the control on that answer left "Hand the computer back" on
// screen for the length of the revived turn -- a button offering the thing it had just done.
test("GW-10: the hand-back control follows the host's status, not the RPC that revives the turn", async () => {
  let handoff = { requestId: "r1", instruction: "log in to the portal" };
  let release = null;
  const { createGatewayAdapter } = await loadAdapter({
    getForeverBoxStatus: () => ({ agentId: "w1", state: "running", handoff }),
    // The host clears the hand-off immediately and answers only when the revived turn is done.
    handBackForeverBox: () => { handoff = null; return new Promise((resolve) => { release = () => resolve({}); }); },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  assert.deepEqual(state.workers[0].handoff, { requestId: "r1", instruction: "log in to the portal" });
  const answer = adapter.handBack("w1");
  for (let i = 0; i < 200 && state.workers[0].handoff != null; i += 1) await settle(5);
  assert.equal(state.workers[0].handoff, null, "the control cleared before handBackForeverBox answered");
  assert.equal(release != null, true, "the RPC is still in flight");
  release();
  assert.deepEqual(await answer, { pending: false });
  adapter.destroy();
});

// MR-36 fixer: the roster read and the transcript read are two different conversations with the
// host. A tail read that threw used to take the roster's answer with it -- countAgents had come
// back with the new number, `rosterChanged` was set, and nothing was emitted -- so the header kept
// a count the host had already contradicted until some later tick happened to succeed.
test("a transcript read that fails does not swallow the roster's own answer", async () => {
  let count = 11;
  let tailFails = false;
  const { createGatewayAdapter } = await loadAdapter({
    listAgents: [{ id: "w1", name: "Probe" }],
    countAgents: () => count,
    getAgentTranscriptTail: () => (tailFails ? new Error("the host is busy") : { entries: [] }),
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const seen = [];
  adapter.subscribe((event) => seen.push(event.snapshot.agentCount));
  await adapter.refresh();
  assert.equal(state.agentCount, 11);
  count = 10;
  tailFails = true;
  await adapter.refresh().catch(() => {});
  assert.equal(state.agentCount, 10, "the roster read still landed");
  assert.equal(seen.at(-1), 10, "and the page was told about it, transcript read or no transcript read");
  adapter.destroy();
});

// ---- HANDBACK-1 ------------------------------------------------------------------------------
// The host writes the instruction as an ORDINARY send-message and stamps the box fields on that
// same entry. Before this, messagesOf threw all three away: the instruction landed as a plain
// agent bubble and the only control anywhere was a button in the footer of a centred dialog.

const boxEntry = (id, text, ms, box) => ({
  kind: "send-message", id, message: { type: "text", content: text }, timestampMs: ms, ...box,
});

test("HANDBACK-1: a box entry becomes ONE hand-off row, with no duplicate text bubble", async () => {
  const { messagesOf } = await loadAdapter();
  const rows = messagesOf([
    entry("a1", "agent", "On it, handing you the computer now.", 1),
    boxEntry("a2", "Sign in to clientsync.dev as super_admin, then hand back", 2, {
      boxRequestId: "req-7", boxInstruction: "Sign in to clientsync.dev as super_admin, then hand back",
    }),
  ], "Probe", null);
  assert.equal(rows.length, 2, "the lead-in and the card, and nothing else");
  assert.equal(rows[0].type, "text");
  assert.equal(rows[1].type, "handoff");
  assert.deepEqual(rows[1].handoff, {
    requestId: "req-7", instruction: "Sign in to clientsync.dev as super_admin, then hand back", resolution: null,
  });
  // The instruction IS this entry's own send-message text. Drawing the card AND the bubble is the
  // person reading the same sentence twice.
  assert.equal(rows[1].text, "");
});

test("HANDBACK-1: the trailing filter keeps a row that has a card and no text", async () => {
  const { messagesOf } = await loadAdapter();
  const rows = messagesOf([boxEntry("a1", "do the thing", 1, { boxRequestId: "r1", boxInstruction: "do the thing" })], "Probe", null);
  assert.equal(rows.length, 1, "the only row saying a person is needed must not be dropped");
});

test("HANDBACK-1: the entry carries its resolution, and an unstamped entry carries null", async () => {
  const { boxHandoffOf } = await loadAdapter();
  assert.deepEqual(boxHandoffOf({ boxRequestId: "r1", boxInstruction: "sign in", boxResolution: "handed_back" }),
    { requestId: "r1", instruction: "sign in", resolution: "handed_back" });
  assert.equal(boxHandoffOf({ boxRequestId: "r1", boxInstruction: "sign in", boxResolution: "" }).resolution, null);
  assert.equal(boxHandoffOf({ message: { type: "text", content: "hello" } }), null);
  assert.equal(boxHandoffOf({ boxRequestId: "" }), null);
});

// The display the thumbnail is read from. ensureForeverBox would answer the same question and
// ALLOCATE a seat doing it (measured 16,277 ms cold on grok-bot-local-vm), so the number is taken
// off the status the adapter already reads -- and only the number, because the URL names the
// host's own loopback, which through the relay is the viewer's machine (VNC-2).
test("HANDBACK-1: the display is parsed from the status, and nothing allocates a seat for a picture", async () => {
  const { displayOfVncUrl, createGatewayAdapter, calls } = await loadAdapter({
    getForeverBoxStatus: () => ({ agentId: "w1", state: "running", vncUrl: "http://127.0.0.1:6081/vnc.html?path=websockify%3Ftoken%3D4", handoff: { requestId: "r1", instruction: "sign in" } }),
    getAgentTranscriptTail: { entries: [] },
  });
  assert.equal(displayOfVncUrl("http://127.0.0.1:6081/vnc.html?path=websockify%3Ftoken%3D4"), 4);
  assert.equal(displayOfVncUrl("http://127.0.0.1:6081/vnc.html?token=11"), 11);
  assert.equal(displayOfVncUrl(null), null);
  assert.equal(displayOfVncUrl("http://127.0.0.1:6081/vnc.html"), null, "a shared seat has no token; guessing 1 here would name the wrong screen");
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  assert.equal(state.workers[0].boxDisplay, 4);
  assert.equal(only(calls, "ensureForeverBox").length, 0, "reading a display must never be what hands one out");
  adapter.destroy();
});

// The seat, which is the answer vncUrl could not give: an agent whose screen nobody has opened
// reports state absent with a null vncUrl while it works on display :5, and the console drew :1 for
// it under a caption naming that agent. boxSeat comes straight off the box's assignment map, and it
// is read passively -- if it were ensureForeverBox it would hand out a seat to draw a picture.
test("HANDBACK-1: the seat rides on the status, and an absent field is not a seat of null", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    getForeverBoxStatus: () => ({ agentId: "w1", state: "absent", vncUrl: null, boxSeat: 5, handoff: { requestId: "r1", instruction: "sign in" } }),
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  assert.equal(state.workers[0].boxSeat, 5, "the agent's own seat, with no vncUrl anywhere");
  assert.equal(state.workers[0].boxDisplay, null);
  assert.equal(only(calls, "ensureForeverBox").length, 0);
  adapter.destroy();

  const older = await loadAdapter({
    getForeverBoxStatus: () => ({ agentId: "w1", state: "absent", vncUrl: null, handoff: null }),
    getAgentTranscriptTail: { entries: [] },
  });
  const state2 = seed();
  const adapter2 = older.createGatewayAdapter(state2);
  await adapter2.refresh();
  assert.equal(state2.workers[0].boxSeat, undefined, "a host that does not send the field must not read as 'no seat'");
  adapter2.destroy();
});

// The single highest-value line in the console half. recordSig is what reloadActive compares to
// decide whether the app redraws; the pending-to-done flip keeps the SAME requestId and changes a
// field inside an existing message, so nothing in the old signature moved and the card never
// repainted -- the person was left looking at Action needed on a step they had finished.
test("HANDBACK-1: the signature moves when a resolution flips under the same request id", async () => {
  const { recordSig } = await loadAdapter();
  const base = { messages: [{ id: "m1", type: "handoff", handoff: { requestId: "r1", instruction: "sign in", resolution: null } }] };
  const pending = recordSig({ ...base, handoff: { requestId: "r1", instruction: "sign in" }, boxState: "running", boxDisplay: 4 });
  const done = recordSig({
    messages: [{ id: "m1", type: "handoff", handoff: { requestId: "r1", instruction: "sign in", resolution: "handed_back" } }],
    handoff: null, boxState: "running", boxDisplay: 4,
  });
  assert.notEqual(pending, done, "the flip must move the signature or the card never repaints");
  // The instruction changing is a second request with the same everything else.
  assert.notEqual(
    recordSig({ ...base, handoff: { requestId: "r1", instruction: "sign in" }, boxState: "running", boxDisplay: 4 }),
    recordSig({ ...base, handoff: { requestId: "r1", instruction: "sign in to the OTHER site" }, boxState: "running", boxDisplay: 4 }),
  );
  // And the display, because the thumbnail is read from it.
  assert.notEqual(pending, recordSig({ ...base, handoff: { requestId: "r1", instruction: "sign in" }, boxState: "running", boxDisplay: 5 }));
});

test("HANDBACK-1: skipHandoff calls skipBoxHandoff {id} and reads the box back", async () => {
  let handoff = { requestId: "r1", instruction: "sign in" };
  const { createGatewayAdapter, calls } = await loadAdapter({
    getForeverBoxStatus: () => ({ agentId: "w1", state: "running", handoff }),
    skipBoxHandoff: () => { handoff = null; return null; },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  const result = await adapter.skipHandoff("w1");
  assert.deepEqual(only(calls, "skipBoxHandoff")[0].args, { id: "w1" });
  assert.deepEqual(result, { supported: true, pending: false });
  assert.equal(state.workers[0].handoff, null);
  adapter.destroy();
});

// The blocker this pair pins. A void command answers `null` on the wire and so does a command the
// host does not have, so support can never be read off the answer -- it is read off tryCall's own
// record of which commands came back "unknown gateway method". Measured live in real Chrome on
// 2026-09-08 before the fix: Skip worked, the card flipped to Skipped in 1.0 s and the agent
// resumed with the declined prompt, and the toast on screen said "This computer's software is too
// old to skip a step", after which no Skip control was drawn anywhere for the rest of the session.
test("HANDBACK-1: a host that answers a bare null has still skipped, and Skip stays on screen", async () => {
  let handoff = { requestId: "r1", instruction: "sign in" };
  const { createGatewayAdapter } = await loadAdapter({
    getForeverBoxStatus: () => ({ agentId: "w1", state: "running", handoff }),
    skipBoxHandoff: () => { handoff = null; return null; },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  assert.deepEqual(await adapter.skipHandoff("w1"), { supported: true, pending: false });
  // And it is still supported on the next hand-off, which is what the console reads to decide
  // whether to draw a Skip control at all.
  handoff = { requestId: "r2", instruction: "sign in again" };
  await adapter.refresh();
  assert.deepEqual(await adapter.skipHandoff("w1"), { supported: true, pending: false });
  adapter.destroy();
});

test("HANDBACK-1: a host that answers {ok:true} is read the same way", async () => {
  let handoff = { requestId: "r1", instruction: "sign in" };
  const { createGatewayAdapter } = await loadAdapter({
    getForeverBoxStatus: () => ({ agentId: "w1", state: "running", handoff }),
    skipBoxHandoff: () => { handoff = null; return { ok: true }; },
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  assert.deepEqual(await adapter.skipHandoff("w1"), { supported: true, pending: false });
  adapter.destroy();
});

// The tempting fallback is handBackForeverBox {trigger:"dismissed"}: it reaches the declined resume
// prompt on an old host, but stamps the entry "completed", so the card would then read Done on a
// step nobody did. A control that lies about what happened is worse than one that is not drawn.
test("HANDBACK-1: an un-upgraded host reports unsupported and is never handed a hand-back instead", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    getForeverBoxStatus: () => ({ agentId: "w1", state: "running", handoff: { requestId: "r1", instruction: "sign in" } }),
    skipBoxHandoff: () => new Error("unknown gateway method: skipBoxHandoff"),
    getAgentTranscriptTail: { entries: [] },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.refresh();
  assert.deepEqual(await adapter.skipHandoff("w1"), { supported: false });
  assert.equal(only(calls, "handBackForeverBox").length, 0, "a skip must never become a hand-back");
  assert.deepEqual(state.workers[0].handoff, { requestId: "r1", instruction: "sign in" }, "nothing was skipped, so nothing changed");
  // Asked once. A card that re-asks every tick would put an unknown-command round trip on every
  // heartbeat for the life of the page.
  const before = only(calls, "skipBoxHandoff").length;
  assert.deepEqual(await adapter.skipHandoff("w1"), { supported: false });
  assert.equal(only(calls, "skipBoxHandoff").length, before);
  adapter.destroy();
});
