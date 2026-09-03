// Wave C2 (docs/GAP-ANALYSIS.md GW-01, GW-09, GW-11 item 2, GW-14, AUDIT-1 UI half): the gateway
// adapter behind the Machine Room, against a stub gateway that records every command. Pinned
// here is what the browser gate cannot see from the DOM: the command each control sends, its
// argument names (read from source/host/host-gateway-api.ts, never guessed), and that every
// write is read back before it is reported. Shapes are the live box's on 2026-09-03:
//   listAgents                       -> [{ id, name, title, description, avatarVersion, notifyOnUpdatesEnabled, isHiddenFromSidebar, isGroup, ... }]
//   updateAgent {id, profile:{name,title,description}}
//   setAgentAvatarBytes {id, pngBase64}     setAgentNotifyOnUpdates {id, isEnabled}
//   setAgentHiddenFromSidebar {id, isHidden} duplicateAgent {id}   deleteAgents {ids}
//   readAttachmentImage {path} -> {dataUrl,width,height}|null
//   readAttachmentText {path, agentId} -> {kind:"text",text,truncated,bytes}|{kind:"binary",bytes}|null
//   readAttachmentChunk {path, agentId, offset, length} -> {bytesBase64,totalSize,mime}
//   searchAgents {query,limit} -> [{agentId,entryId,role,timestampMs,snippet}]
//   searchMedia {query,limit}  -> [{agentId,entryId,fileName,kind,mime,timestampMs}]
//   dismissWidget {entryId, agentId} -> {accepted}
//   getAgentActionAudit {id, limit, before?} -> {rows, nextBefore}
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAdapter(answers = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { createGatewayAdapter, messagesOf, cardOf, identityOf };\n  global.__bootMachineRoom =",
  );
  const calls = [];
  const window = {
    createDemoAdapter: () => ({}),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: () => 0,
    clearInterval: () => {},
    EventSource: function () { return { onmessage: null }; },
    crypto: { randomUUID: () => "nonce-0001" },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    TextDecoder,
    open: () => {},
  };
  const defaults = { listAgents: [], getTrays: [], getAgentAutomations: [], getAgentWorkflows: [], getConversationOutline: [], getAgentTranscriptTail: { entries: [] } };
  const fetchStub = async (url, init) => {
    const method = String(url).startsWith("/api/") ? String(url).slice(5) : null;
    if (method == null) return { ok: true, text: async () => "{}", json: async () => ({}) };
    const args = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, args });
    const answer = answers[method] ?? defaults[method] ?? {};
    const value = typeof answer === "function" ? answer(args, calls) : answer;
    if (value instanceof Error) return { ok: false, status: 500, text: async () => JSON.stringify({ error: value.message }) };
    return { ok: true, text: async () => JSON.stringify(value) };
  };
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  return { ...fn(window, fetchStub), calls };
}

const summary = (over = {}) => ({ id: "w1", name: "Probe", title: "", description: "verify probe", avatarVersion: null, notifyOnUpdatesEnabled: true, isHiddenFromSidebar: false, isGroup: false, isRunning: false, unreadCount: 0, ...over });
const seed = () => ({
  activeContext: { kind: "worker", id: "w1" },
  openContexts: [{ kind: "worker", id: "w1" }],
  workers: [{ id: "w1", name: "Probe", role: "", description: "verify probe", avatar: "assets/avatar-chief.svg", avatarVersion: null, notify: true, hidden: false, status: "ready", statusText: "Ready", messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, hasOlder: false, composer: null }],
  rooms: [{ id: "r1", name: "Diag Room", role: "Group chat", description: "", memberIds: ["w1"], avatar: "assets/avatar-atera.svg", avatarVersion: null, notify: true, hidden: false, status: "ready", statusText: "Ready", messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, hasOlder: false, composer: null }],
  routines: [], plugins: [], models: { default: "d", available: [] },
  settings: { autoReview: { enabled: false, allow: [], block: [] }, localToolPermission: null, reachable: true },
  desktop: { paused: false, timeline: [] }, teaching: { active: false, workerId: null, startedAt: null },
  agentCount: 5, search: { enabled: true },
});
const only = (calls, method) => calls.filter((c) => c.method === method);

// -- GW-11 item 2

test("GW-11: the card × sends dismissWidget with the entry id and the agent, then refreshes", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({ dismissWidget: { accepted: true } });
  const state = seed();
  state.workers[0].messages.push({ id: "t9s0", authorId: "w1", authorName: "Probe", type: "decision", text: "", card: { kind: "widget", status: "pending", options: ["Yes", "No"] } });
  const adapter = createGatewayAdapter(state);
  const accepted = await adapter.dismissCard({ kind: "worker", id: "w1" }, "t9s0");
  const sent = only(calls, "dismissWidget");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args, { entryId: "t9s0", agentId: "w1" });
  assert.equal(accepted, true);
  assert.ok(only(calls, "getAgentTranscriptTail").length >= 1, "the card's status is read back from the transcript, not assumed");
  adapter.destroy();
});

test("GW-11: a card that is not a question cannot be dismissed, and a refused dismissal restores the card", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({ dismissWidget: new Error("no such widget") });
  const state = seed();
  state.workers[0].messages.push(
    { id: "a1", authorId: "w1", authorName: "Probe", type: "decision", text: "", card: { kind: "auto-review", status: "pending", requestId: "r" } },
    { id: "q1", authorId: "w1", authorName: "Probe", type: "decision", text: "", card: { kind: "widget", status: "pending", options: [] } },
  );
  const adapter = createGatewayAdapter(state);
  await assert.rejects(() => adapter.dismissCard(null, "a1"), /only a question card/);
  assert.equal(only(calls, "dismissWidget").length, 0);
  await assert.rejects(() => adapter.dismissCard(null, "q1"), /no such widget/);
  assert.equal(state.workers[0].messages.find((m) => m.id === "q1").card.status, "pending");
  adapter.destroy();
});

test("GW-11: cardOf reads the host's widgetDismissed and respondedValue stamps off the entry", async () => {
  const { cardOf } = await loadAdapter();
  const widget = (extra) => ({ kind: "send-message", id: "q", message: { type: "widget", widget: { prompt: "Proceed?", options: ["Yes", "No"] } }, ...extra });
  assert.equal(cardOf(widget({})).status, "pending");
  assert.equal(cardOf(widget({ widgetDismissed: true })).status, "dismissed");
  const answered = cardOf(widget({ respondedValue: "Yes" }));
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "Yes");
});

// -- GW-01

test("GW-01: updateProfile writes the whole profile with the host's current values for the rest, and reads it back", async () => {
  let held = summary();
  const { createGatewayAdapter, calls } = await loadAdapter({
    listAgents: () => [held],
    updateAgent: (args) => { held = { ...held, ...args.profile }; return {}; },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const saved = await adapter.updateProfile("w1", { name: " Renamed probe ", description: "does the gate" });
  const write = only(calls, "updateAgent");
  assert.equal(write.length, 1);
  assert.deepEqual(write[0].args, { id: "w1", profile: { name: "Renamed probe", description: "does the gate", title: "" } });
  assert.deepEqual(saved, { name: "Renamed probe", title: "", description: "does the gate" });
  assert.equal(state.workers[0].name, "Renamed probe");
  assert.equal(state.workers[0].description, "does the gate");
  // setRole is the same write with only the title changed; the name it just saved rides along.
  await adapter.setRole("w1", "Gate keeper");
  assert.deepEqual(only(calls, "updateAgent")[1].args.profile, { name: "Renamed probe", description: "does the gate", title: "Gate keeper" });
  assert.equal(state.workers[0].role, "Gate keeper");
  adapter.destroy();
});

test("GW-01: a profile write the host answered but did not keep is an error, not a success", async () => {
  const { createGatewayAdapter } = await loadAdapter({ listAgents: [summary()], updateAgent: {} });
  const adapter = createGatewayAdapter(seed());
  await assert.rejects(() => adapter.updateProfile("w1", { name: "Other" }), /kept the old name/);
  await assert.rejects(() => adapter.updateProfile("w1", { name: "   " }), /needs a name/);
  adapter.destroy();
});

test("GW-01: setAvatar sends pngBase64 and points the roster image at /avatars/<id>?v=<the new version>", async () => {
  // As the live box behaves: listAgents keeps answering avatarVersion null after the write and
  // getAgentAvatar is where the version is.
  let stored = null;
  const { createGatewayAdapter, calls, identityOf } = await loadAdapter({
    listAgents: () => [summary()],
    setAgentAvatarBytes: () => { stored = "v-7"; return {}; },
    getAgentAvatar: () => (stored ? { version: stored, dataUrl: "data:image/png;base64,AA==" } : { version: null, dataUrl: null }),
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const result = await adapter.setAvatar("w1", png);
  assert.deepEqual(only(calls, "setAgentAvatarBytes")[0].args, { id: "w1", pngBase64: png });
  assert.equal(result.version, "v-7");
  assert.equal(result.avatar, "/avatars/w1?v=v-7");
  assert.equal(state.workers[0].avatar, "/avatars/w1?v=v-7");
  // No version after the write means the host kept nothing.
  assert.equal(identityOf(summary()).avatar.startsWith("assets/"), true, "no avatar on the host means the placeholder, never a 404 URL");
  await assert.rejects(() => adapter.setAvatar("w1", ""), /pick a PNG/);
  adapter.destroy();
});

test("GW-01: a known avatar version survives the next identity write when listAgents carries none", async () => {
  // Regression: after setAvatar, a rename, a notifications toggle and a hide each read the row
  // back from listAgents, which answers avatarVersion null on this box. The version already held
  // must be kept, not reset to the placeholder, exactly as the roster tick keeps it.
  const row = { notify: true, hidden: false };
  const { createGatewayAdapter } = await loadAdapter({
    listAgents: () => [summary({ notifyOnUpdatesEnabled: row.notify, isHiddenFromSidebar: row.hidden })],
    setAgentAvatarBytes: {},
    getAgentAvatar: { version: "v-7", dataUrl: "data:image/png;base64,AA==" },
    updateAgent: {},
    setAgentNotifyOnUpdates: (args) => { row.notify = args.isEnabled; return {}; },
    setAgentHiddenFromSidebar: (args) => { row.hidden = args.isHidden; return {}; },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  await adapter.setAvatar("w1", "AAAA");
  assert.equal(state.workers[0].avatar, "/avatars/w1?v=v-7");
  await adapter.updateProfile("w1", { description: "verify probe" });
  assert.equal(state.workers[0].avatar, "/avatars/w1?v=v-7", "a profile save kept the avatar");
  assert.equal(state.workers[0].avatarVersion, "v-7");
  await adapter.setNotifications("w1", false);
  assert.equal(state.workers[0].avatar, "/avatars/w1?v=v-7", "a notifications toggle kept the avatar");
  await adapter.setHidden("w1", true);
  assert.equal(state.workers[0].avatar, "/avatars/w1?v=v-7", "a hide kept the avatar");
  assert.equal(state.workers[0].hidden, true);
  adapter.destroy();
});

test("GW-01: an avatar write the host answered with no new version is an error", async () => {
  const { createGatewayAdapter } = await loadAdapter({ listAgents: [summary()], setAgentAvatarBytes: {}, getAgentAvatar: { version: null, dataUrl: null } });
  const adapter = createGatewayAdapter(seed());
  await assert.rejects(() => adapter.setAvatar("w1", "AAAA"), /no new avatar version/);
  adapter.destroy();
});

test("GW-01: notifications and hide-from-sidebar send the host's own argument names and read back", async () => {
  let held = summary();
  const { createGatewayAdapter, calls } = await loadAdapter({
    listAgents: () => [held],
    setAgentNotifyOnUpdates: (args) => { held = { ...held, notifyOnUpdatesEnabled: args.isEnabled }; return {}; },
    setAgentHiddenFromSidebar: (args) => { held = { ...held, isHiddenFromSidebar: args.isHidden }; return {}; },
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  assert.equal(await adapter.setNotifications("w1", false), false);
  assert.deepEqual(only(calls, "setAgentNotifyOnUpdates")[0].args, { id: "w1", isEnabled: false });
  assert.equal(state.workers[0].notify, false);
  assert.equal(await adapter.setHidden("w1", true), true);
  assert.deepEqual(only(calls, "setAgentHiddenFromSidebar")[0].args, { id: "w1", isHidden: true });
  assert.equal(state.workers[0].hidden, true);
  assert.equal(await adapter.setHidden("w1", false), false);
  assert.equal(state.workers[0].hidden, false);
  adapter.destroy();
});

test("GW-01: a hide the host answered but did not store is an error", async () => {
  const { createGatewayAdapter } = await loadAdapter({ listAgents: [summary()], setAgentHiddenFromSidebar: {}, setAgentNotifyOnUpdates: {} });
  const adapter = createGatewayAdapter(seed());
  await assert.rejects(() => adapter.setHidden("w1", true), /did not hide/);
  await assert.rejects(() => adapter.setNotifications("w1", false), /did not turn notifications off/);
  adapter.destroy();
});

test("GW-01: duplicateAgent resolves with the agent listAgents holds afterwards and did not before; deleteAgent uses deleteAgents{ids}", async () => {
  let agents = [summary()];
  const { createGatewayAdapter, calls } = await loadAdapter({
    listAgents: () => agents,
    duplicateAgent: (args) => { agents = [...agents, summary({ id: "w1-copy", name: "Probe copy" })]; return { agent: { id: "w1-copy" } }; },
    deleteAgents: (args) => { agents = agents.filter((a) => !args.ids.includes(a.id)); return {}; },
    countAgents: () => agents.length,
    isGlobalSearchEnabled: true,
  });
  const adapter = createGatewayAdapter(seed());
  const copy = await adapter.duplicateAgent("w1");
  assert.deepEqual(only(calls, "duplicateAgent")[0].args, { id: "w1" });
  assert.deepEqual(copy, { id: "w1-copy", name: "Probe copy" });
  await assert.rejects(() => adapter.duplicateAgent("r1"), /only an agent/);
  assert.equal(await adapter.deleteAgent("w1-copy"), "Probe copy");
  assert.deepEqual(only(calls, "deleteAgents")[0].args, { ids: ["w1-copy"] });
  adapter.destroy();
});

test("GW-01: identityOf carries name, role, description, avatar version, notify and hidden off a listAgents row", async () => {
  const { identityOf } = await loadAdapter();
  const row = identityOf(summary({ title: " Ops ", avatarVersion: 3, notifyOnUpdatesEnabled: false, isHiddenFromSidebar: true }));
  assert.equal(row.role, "Ops");
  assert.equal(row.avatar, "/avatars/w1?v=3");
  assert.equal(row.avatarVersion, 3);
  // A version already known survives a listAgents row that carries none (this box's rows never do).
  assert.equal(identityOf(summary(), "kept-1").avatar, "/avatars/w1?v=kept-1");
  assert.equal(identityOf(summary({ avatarVersion: "fresh-2" }), "kept-1").avatar, "/avatars/w1?v=fresh-2");
  assert.equal(row.notify, false);
  assert.equal(row.hidden, true);
  assert.equal(identityOf(summary({ isGroup: true })).role, "Group chat");
});

// -- GW-09

test("GW-09: attachment entries become attachment messages, images by extension, file:// unwrapped", async () => {
  const { messagesOf } = await loadAdapter();
  const messages = messagesOf([
    { kind: "user-attachment", id: "u1", file_path: "/home/box/sand-data/agents/w1/attachments/abc.png", file_name: "shot.png", timestampMs: 1 },
    { kind: "user-attachment", id: "u2", file_path: "/home/box/sand-data/agents/w1/attachments/def.txt", timestampMs: 2 },
    { kind: "send-message", id: "s1", message: { type: "attachment", url: "file:///home/box/sand-data/agents/w1/assets/screen%20shot.png", alt: "the screen" }, timestampMs: 3 },
    { kind: "send-message", id: "s2", message: { type: "text", content: "done" }, timestampMs: 4 },
  ], "Probe", []);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0].attachment, { path: "/home/box/sand-data/agents/w1/attachments/abc.png", name: "shot.png", kind: "image" });
  assert.equal(messages[0].authorId, "you");
  assert.equal(messages[0].type, "attachment");
  assert.deepEqual(messages[1].attachment, { path: "/home/box/sand-data/agents/w1/attachments/def.txt", name: "def.txt", kind: "file" });
  assert.deepEqual(messages[2].attachment, { path: "/home/box/sand-data/agents/w1/assets/screen shot.png", name: "screen shot.png", kind: "image" });
  assert.equal(messages[2].text, "the screen");
  assert.notEqual(messages[2].authorId, "you");
  assert.equal(messages[3].type, "text");
});

test("GW-09: the three attachment reads send the host's argument names, cache by path, and decode a chunk", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    readAttachmentImage: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 1, height: 1 },
    readAttachmentText: { kind: "text", text: "line one\nline two", truncated: true, bytes: 70000 },
    readAttachmentChunk: (args) => ({ bytesBase64: Buffer.from(`chunk@${args.offset}`).toString("base64"), totalSize: 70000, mime: null }),
  });
  const adapter = createGatewayAdapter(seed());
  const image = await adapter.readAttachmentImage("/p/a.png", "w1");
  await adapter.readAttachmentImage("/p/a.png", "w1");
  assert.equal(only(calls, "readAttachmentImage").length, 1, "a second read of the same path is served from the cache");
  assert.deepEqual(only(calls, "readAttachmentImage")[0].args, { path: "/p/a.png", agentId: "w1" }, "the agent rides the image read too, for the host-side scoping to key on");
  assert.equal(image.dataUrl.startsWith("data:image/png"), true);
  const text = await adapter.readAttachmentText("w1", "/p/b.txt");
  assert.deepEqual(only(calls, "readAttachmentText")[0].args, { path: "/p/b.txt", agentId: "w1" });
  assert.equal(text.truncated, true);
  const chunk = await adapter.readAttachmentChunk("w1", "/p/b.txt", 65536, 16384);
  assert.deepEqual(only(calls, "readAttachmentChunk")[0].args, { path: "/p/b.txt", agentId: "w1", offset: 65536, length: 16384 });
  assert.equal(chunk.text, "chunk@65536");
  assert.equal(chunk.totalSize, 70000);
  adapter.destroy();
});

// -- GW-14

test("GW-14: search asks searchAgents and searchMedia with {query, limit}, names the agent on every hit, and matches bots on the roster", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    searchAgents: [{ agentId: "w1", entryId: "t3s0", role: "assistant", timestampMs: 5, snippet: "Hello." }, { agentId: "gone", entryId: "x", role: "user", timestampMs: 1, snippet: "orphan" }],
    searchMedia: [{ agentId: "r1", entryId: "u9", fileName: "shot.png", kind: "image", mime: "image/png", timestampMs: 4 }],
  });
  const adapter = createGatewayAdapter(seed());
  assert.equal(adapter.searchEnabled(), true);
  const hits = await adapter.search("hello", 7);
  assert.deepEqual(only(calls, "searchAgents")[0].args, { query: "hello", limit: 7 });
  assert.deepEqual(only(calls, "searchMedia")[0].args, { query: "hello", limit: 7 });
  assert.equal(hits.messages.length, 1, "a hit on an agent the roster does not hold is dropped");
  assert.deepEqual(hits.messages[0], { agentId: "w1", kind: "worker", agentName: "Probe", entryId: "t3s0", role: "assistant", timestampMs: 5, snippet: "Hello." });
  assert.deepEqual(hits.files[0], { agentId: "r1", kind: "room", agentName: "Diag Room", entryId: "u9", fileName: "shot.png", fileKind: "image", timestampMs: 4 });
  assert.equal(hits.bots.length, 0);
  const bots = await adapter.search("diag");
  assert.deepEqual(bots.bots, [{ agentId: "r1", kind: "room", name: "Diag Room", role: "Group chat", hidden: false }]);
  assert.deepEqual(await adapter.search("   "), { messages: [], bots: [], files: [] });
  adapter.destroy();
});

test("GW-14: revealEntry pages older entries in until the id is held, bounded, and emits transcript:reveal", async () => {
  const older = [{ kind: "message", id: "u0", role: "user", content: "hello there", timestampMs: 1 }];
  const { createGatewayAdapter, calls } = await loadAdapter({
    getAgentTranscriptTail: { entries: [{ kind: "send-message", id: "t5s0", message: { type: "text", content: "Hi." }, timestampMs: 9 }], nextBeforeSeq: 4 },
    getAgentTranscriptPage: (args) => (args.beforeSeq === 4 ? { entries: older, nextBeforeSeq: null } : { entries: [] }),
  });
  const state = seed();
  const adapter = createGatewayAdapter(state);
  const events = [];
  adapter.subscribe((e) => events.push(e.type));
  await adapter.refresh();
  assert.equal(await adapter.revealEntry({ kind: "worker", id: "w1" }, "u0"), true);
  assert.equal(only(calls, "getAgentTranscriptPage").length, 1);
  assert.ok(events.includes("transcript:reveal"));
  assert.ok(state.workers[0].messages.some((m) => m.id === "u0"));
  assert.equal(await adapter.revealEntry({ kind: "worker", id: "w1" }, "never"), false, "an id the host never pages in resolves false rather than looping");
  adapter.destroy();
});

// -- AUDIT-1 UI half

test("AUDIT-1: getActionAudit sends {id, limit, before?} and hands back rows and the cursor", async () => {
  const { createGatewayAdapter, calls } = await loadAdapter({
    getAgentActionAudit: (args) => ({ rows: [{ eventId: `e-${args.before ?? "top"}`, tool: "Shell", type: "tool_result", ok: true, bytes: 12, head: "ls" }], nextBefore: args.before ? null : "e-top" }),
  });
  const adapter = createGatewayAdapter(seed());
  const first = await adapter.getActionAudit("w1", { limit: 25 });
  assert.deepEqual(only(calls, "getAgentActionAudit")[0].args, { id: "w1", limit: 25 });
  assert.equal(first.rows[0].eventId, "e-top");
  assert.equal(first.nextBefore, "e-top");
  const next = await adapter.getActionAudit("w1", { limit: 25, before: first.nextBefore });
  assert.deepEqual(only(calls, "getAgentActionAudit")[1].args, { id: "w1", limit: 25, before: "e-top" });
  assert.equal(next.nextBefore, null);
  adapter.destroy();
});
