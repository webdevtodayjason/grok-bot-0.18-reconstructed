// COST-1. ui/api-diet.mjs, pinned where it can do damage.
//
// THE ONE TEST THIS FILE EXISTS FOR is the first one: the outline projection is the single change in
// this wave that can silently break a transcript. It drops 559 of 1,578 items, rewrites the rest into
// one field each, and hashes the key the console matches on, all on the hot path of the only screen
// anybody looks at. So it is not checked against a hand-written outline. The REAL payload off
// grok-bot-local-vm is woven by the REAL weaveToolRows out of ui/machine-room/gateway-adapter.js,
// twice -- once as the host answers it and once as the relay would project it -- and the two row sets
// have to be identical: same rows, same positions, same text, same detail.
//
// tests/fixtures/outline-atera.json is that payload, 1,578 items and 1,239,452 bytes, saved from
// getConversationOutline { id: "28c1383e-12d0-4bf1-95b4-e9f762c4c141" } on 2026-09-09. To recapture
// it: POST /api/getConversationOutline to the local relay with that id and write the body here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DIGEST_HEADER,
  IF_DIGEST_HEADER,
  PROJECTION_HEADER,
  UNCHANGED_BODY,
  digestOf,
  hashOutlineKey,
  projectOutline,
  projectWorkflows,
  shapeApiAnswer,
} from "../ui/api-diet.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(await readFile(path.join(repoRoot, "tests/fixtures/outline-atera.json"), "utf8"));

// The adapter's own weaveToolRows and hashOutlineKey, out of the shipped file. Same trick
// tests/machine-room-gateway.test.mjs uses: the IIFE is given a stub window and asked to publish the
// two functions. Nothing is reimplemented here, which is the whole point -- a copy would pass while
// the console broke.
async function loadAdapterWeave() {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8");
  const body = source.slice(source.indexOf("(function attachGatewayAdapter"));
  const exposed = body.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { weaveToolRows, outlineKey, hashOutlineKey };\n  global.__bootMachineRoom =",
  );
  const window = {
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    EventSource: function () { return { onmessage: null, close() {} }; },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, removeAttribute() {} } },
  };
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  return fn(window, async () => ({ ok: true, text: async () => "{}" }));
}
const adapter = await loadAdapterWeave();

// A transcript whose entries are exactly the outline's own anchors, derived from the fixture rather
// than invented: every `user` item becomes the user entry it describes and every `send-message` item
// becomes the agent entry it describes. That is the shape weaveToolRows matches against, so a key
// algorithm that drifts by one character moves every row.
const transcriptFromOutline = (items) => items.flatMap((item, n) => {
  if (item.kind === "user") return [{ kind: "message", id: `e${n}`, role: "user", content: item.text, timestampMs: 1000 + n }];
  if (item.kind === "send-message") return [{ kind: "send-message", id: `e${n}`, message: item.message, timestampMs: 1000 + n }];
  return [];
});

// What the renderer actually shows out of a woven list: the tool rows, where they landed, and what
// they say. Anything this does not capture is something no person sees.
const toolRowsOf = (woven) => woven
  .map((entry, at) => ({ at, entry }))
  .filter(({ entry }) => entry?.kind === "tool-row")
  .map(({ at, entry }) => ({ at, id: entry.id, text: entry.text, detail: entry.detail, toolKind: entry.toolKind }));

test("the outline projection weaves the same tool rows at the same positions as the whole payload", () => {
  const transcript = transcriptFromOutline(fixture);
  const whole = adapter.weaveToolRows(transcript, fixture, false);
  const lean = adapter.weaveToolRows(transcript, projectOutline(fixture), false);
  const a = toolRowsOf(whole);
  const b = toolRowsOf(lean);
  assert.ok(a.length > 0, "the fixture has tool rows to compare");
  assert.equal(b.length, a.length, "the projection kept every tool row");
  assert.deepEqual(b, a, "the projection moved or changed a tool row");
  // And the transcript entries themselves are untouched by either pass.
  assert.equal(whole.length, lean.length);
});

test("and the same on a partial window, which is what a phone actually holds", () => {
  const full = transcriptFromOutline(fixture);
  // The host's tail is 150 entries; `partial` is what tells weaveToolRows that everything before the
  // window belongs to history off screen, and it is a branch of its own.
  const tail = full.slice(-150);
  const whole = adapter.weaveToolRows(tail, fixture, true);
  const lean = adapter.weaveToolRows(tail, projectOutline(fixture), true);
  assert.deepEqual(toolRowsOf(lean), toolRowsOf(whole));
});

test("the projection is the measured size, not a hopeful one", () => {
  const raw = JSON.stringify(fixture);
  const lean = JSON.stringify(projectOutline(fixture));
  assert.equal(Buffer.byteLength(raw), 1239452, "the fixture is the payload the numbers were measured on");
  // 40,707 bytes measured on grok-bot-local-vm on 2026-09-09. The bound is generous so a host that
  // adds a field does not fail this, and tight enough that losing the hash or the drop would.
  assert.ok(Buffer.byteLength(lean) < 80_000, `projected to ${Buffer.byteLength(lean)} bytes`);
  assert.ok(Buffer.byteLength(lean) * 10 < Buffer.byteLength(raw), "the projection saves an order of magnitude");
  // PER ITEM, which is the number the two byte ceilings in docs/APPS.md actually rest on. The host
  // ignores {limit}, {offset} and {afterId} (HOST-DELTA), so this is a projection and not paging: it
  // bounds what an ITEM costs and not what the payload costs, and both ceilings are therefore linear in
  // conversation length. 40,707 bytes over 1,578 items is 25.80 bytes an item, measured on
  // grok-bot-local-vm 2026-09-10, which puts the 250 KiB first-paint ceiling at about 9,900 items and
  // the 100 KiB idle ceiling at about 3,970 -- roughly 6x the longest conversation on that box. The
  // bound here is the rate, so a projection that grows per item fails HERE rather than waiting for
  // somebody to hold a 10,000-item conversation.
  const perItem = Buffer.byteLength(lean) / fixture.length;
  assert.ok(perItem <= 32, `${perItem.toFixed(2)} decoded bytes an item; the ceiling holds to ${Math.floor(250 * 1024 / perItem)} items`);
  const items = JSON.parse(lean);
  assert.equal(items.filter((i) => i.kind === "tool-call").length, fixture.filter((i) => i.kind === "tool-call").length);
  assert.equal(items.some((i) => i.kind === "assistant-text"), false, "assistant text is not sent");
  // No anchor carries text, a message or an id: a key is all weaveToolRows reads off one.
  for (const item of items) {
    if (item.kind === "tool-call") continue;
    assert.deepEqual(Object.keys(item), ["k"]);
    assert.match(item.k, /^[0-9a-f]{16}$/);
  }
});

test("the relay's hash and the console's hash are the same function", () => {
  for (const value of ["", "u:hello", "a:a longer thing the agent said", "u:\u00e9\u4e2d\u6587 \ud83d\ude80", "a:" + "x".repeat(5000)]) {
    assert.equal(adapter.hashOutlineKey(value), hashOutlineKey(value), `drifted on ${JSON.stringify(value.slice(0, 24))}`);
  }
  // And the key the adapter reads off a projected item is the one the relay put there.
  const projected = projectOutline(fixture);
  const anchors = projected.filter((i) => i.kind !== "tool-call");
  assert.equal(adapter.outlineKey(anchors[0]), anchors[0].k);
});

test("every outline key in the fixture hashes to its own value", () => {
  const seen = new Map();
  let collisions = 0;
  for (const item of fixture) {
    const key = item.kind === "user" ? `u:${String(item.text ?? "").trim()}`
      : item.kind === "send-message" ? (item.message?.type === "text" ? `a:${String(item.message.content ?? "").trim()}` : `a:${JSON.stringify(item.message ?? null)}`)
        : null;
    if (key == null) continue;
    const hash = hashOutlineKey(key);
    if (seen.has(hash) && seen.get(hash) !== key) collisions += 1;
    seen.set(hash, key);
  }
  assert.equal(collisions, 0, "two different outline keys hashed the same, which would move a tool row");
});

// ---- the workflows projection ------------------------------------------------------------------

const workflow = (id) => ({
  id, name: `skill ${id}`, description: "one line", body: "# the whole markdown recipe\n".repeat(40),
  isEnabledForAgent: true, source: "workflow", sourceRef: null, ownerAgentId: null,
  trigger: { schedule: "0 9 * * 1", isEnabled: true }, scheduleDescription: "Mondays at 9",
  lastRunAt: 172, helperScripts: ["one.sh"],
});

test("the workflows projection drops body and keeps every other field", () => {
  const list = [workflow("a"), workflow("b")];
  const lean = projectWorkflows(list);
  for (let i = 0; i < list.length; i += 1) {
    assert.equal("body" in lean[i], false, "a body came through");
    for (const key of Object.keys(list[i])) {
      if (key === "body") continue;
      assert.deepEqual(lean[i][key], list[i][key], `${key} was altered`);
    }
  }
  assert.ok(JSON.stringify(lean).length * 2 < JSON.stringify(list).length, "dropping the bodies saved the bytes");
});

test("x-titan-projection: full returns the body, lean does not, and no header is unchanged", () => {
  const body = JSON.stringify([workflow("a")]);
  const lean = shapeApiAnswer("getAgentWorkflows", {}, { [PROJECTION_HEADER]: "lean" }, body);
  assert.equal(JSON.parse(lean.bytes).some((row) => "body" in row), false);
  for (const header of [{ [PROJECTION_HEADER]: "full" }, {}]) {
    const full = shapeApiAnswer("getAgentWorkflows", {}, header, body);
    assert.equal(full.bytes, body, "an answer nobody asked to shrink came back shrunk");
  }
});

test("a request with no projection header gets the outline byte for byte", () => {
  const body = JSON.stringify(fixture);
  const answer = shapeApiAnswer("getConversationOutline", {}, {}, body);
  assert.equal(answer.bytes, body, "an old console would see a different conversation");
});

test("a method with no projection, an error envelope and a body that is not JSON all pass through", () => {
  assert.equal(shapeApiAnswer("listAgents", {}, { [PROJECTION_HEADER]: "lean" }, "[1,2,3]").bytes, "[1,2,3]");
  // The seam calls this only on a 200, so a refusal's own status never reaches here. A host that
  // answers 200 carrying an error envelope does, and that is an object where an array was expected:
  // the projection says "not a shape I know" rather than turning it into [].
  const envelope = '{"error":"the box is busy"}';
  assert.equal(shapeApiAnswer("getConversationOutline", {}, { [PROJECTION_HEADER]: "lean" }, envelope).bytes, envelope);
  assert.equal(shapeApiAnswer("getConversationOutline", {}, { [PROJECTION_HEADER]: "lean" }, "not json at all").bytes, "not json at all");
  assert.equal(shapeApiAnswer("getConversationOutline", {}, { [PROJECTION_HEADER]: "lean" }, "").bytes, "");
});

// ---- the unchanged-answer protocol --------------------------------------------------------------

test("the digest answer is unchanged only on byte-identical bytes, and the full body otherwise", () => {
  const one = JSON.stringify([{ id: "a", lastActivityAt: 1 }]);
  const first = shapeApiAnswer("listAgents", {}, {}, one);
  const digest = first.headers[DIGEST_HEADER];
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, digestOf(one));

  const same = shapeApiAnswer("listAgents", {}, { [IF_DIGEST_HEADER]: digest }, one);
  assert.equal(same.bytes, UNCHANGED_BODY);
  // Deliberately not a 304: /api is a POST, nothing caches it, and the seam carries no status for
  // this hook at all.
  assert.ok(Buffer.byteLength(UNCHANGED_BODY) < 32, "the unchanged answer has to be tiny to be worth anything");
  assert.equal(same.headers[DIGEST_HEADER], digest, "the held digest is restated, so the memo does not go blind");

  const moved = JSON.stringify([{ id: "a", lastActivityAt: 2 }]);
  const after = shapeApiAnswer("listAgents", {}, { [IF_DIGEST_HEADER]: digest }, moved);
  assert.equal(after.bytes, moved, "a changed answer must never be replayed");
  assert.notEqual(after.headers[DIGEST_HEADER], digest);

  // A wrong digest is a full answer, not an error.
  const wrong = shapeApiAnswer("listAgents", {}, { [IF_DIGEST_HEADER]: "0".repeat(64) }, one);
  assert.equal(wrong.bytes, one);
});

test("the digest is taken over the PROJECTED bytes, so a lean and a full read never collide", () => {
  const body = JSON.stringify(fixture);
  const lean = shapeApiAnswer("getConversationOutline", {}, { [PROJECTION_HEADER]: "lean" }, body);
  const full = shapeApiAnswer("getConversationOutline", {}, {}, body);
  assert.notEqual(lean.headers[DIGEST_HEADER], full.headers[DIGEST_HEADER]);
  // And a lean read that sends the lean digest is still answered unchanged.
  const again = shapeApiAnswer("getConversationOutline", {}, { [PROJECTION_HEADER]: "lean", [IF_DIGEST_HEADER]: lean.headers[DIGEST_HEADER] }, body);
  assert.equal(again.bytes, UNCHANGED_BODY);
});

// ---- compression, which moves the wire and never the ceiling -----------------------------------

test("the shaped body is always a string, because the seam writes it as one", () => {
  // ui/relay-hooks.mjs refuses anything whose `bytes` is not a string and falls back to the whole
  // answer, so a Buffer here would silently undo the whole projection. It is also why there is no
  // compression in this module: a gzip frame is not a string.
  const cases = [
    shapeApiAnswer("getConversationOutline", {}, { [PROJECTION_HEADER]: "lean" }, JSON.stringify(fixture)),
    shapeApiAnswer("getConversationOutline", {}, {}, JSON.stringify(fixture)),
    shapeApiAnswer("getAgentWorkflows", {}, { [PROJECTION_HEADER]: "lean" }, JSON.stringify([workflow("a")])),
    shapeApiAnswer("listAgents", {}, {}, "[]"),
    shapeApiAnswer("listAgents", {}, { [IF_DIGEST_HEADER]: digestOf("[]") }, "[]"),
  ];
  for (const one of cases) {
    assert.equal(typeof one.bytes, "string", "the seam would throw this whole answer away");
    assert.equal(one.headers["content-encoding"], undefined, "nothing here compresses: the edge does");
  }
});

test("nothing this module answers is ever cacheable by a shared cache", async () => {
  const source = await readFile(path.join(repoRoot, "ui/api-diet.mjs"), "utf8");
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.equal(/cache-control/i.test(code), false, "api-diet writes no cache-control at all; /api stays no-store");
  const answer = shapeApiAnswer("listAgents", {}, {}, "[]");
  assert.equal(Object.keys(answer.headers).some((name) => /^set-cookie$/i.test(name)), false);
  assert.equal(JSON.stringify(answer.headers).includes("public"), false);
});

// ================================================================================================
// THE CONSOLE'S HALF OF THE SAME CONTRACT
// ================================================================================================
//
// A projection nobody asks for saves nothing, and a digest the console does not echo saves nothing
// either, so the adapter's side is pinned here beside the relay's. The harness drives the shipped
// ui/machine-room/gateway-adapter.js against a stub gateway that records every call AND its request
// headers, which is the part a browser gate cannot see.
//
// The last test in this file is the one the absent-module case needs: a relay with no
// ui/api-diet.mjs sends no x-titan-digest, so nothing is remembered, nothing is echoed, and the
// console behaves exactly as it did before this wave. CONSOLE-4 is why that is a test and not a
// sentence in a comment.

const adapterSource = (await readFile(path.join(repoRoot, "ui/machine-room/gateway-adapter.js"), "utf8"));
const adapterBody = adapterSource.slice(adapterSource.indexOf("(function attachGatewayAdapter"));

function harness(answers = {}, options = {}) {
  const calls = [];
  const timers = { intervals: new Map(), nextId: 1 };
  const listeners = new Map();
  const stored = new Map(Object.entries(options.localStorage ?? {}));
  const window = {
    location: { search: options.search ?? "", href: `http://127.0.0.1/${options.search ?? ""}` },
    history: {
      replaceState: (_a, _b, url) => {
        const next = new URL(`http://127.0.0.1${url}`);
        window.location.href = next.href;
        window.location.search = next.search;
      },
    },
    URL,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 2)),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn) => { const id = (timers.nextId += 1); timers.intervals.set(id, fn); return id; },
    clearInterval: (id) => { timers.intervals.delete(id); },
    EventSource: function () {
      this.onmessage = null;
      this.closed = false;
      this.close = () => { this.closed = true; };
      window.__streams.push(this);
    },
    __streams: [],
    crypto: { randomUUID: () => "nonce-0001" },
    localStorage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: (k) => stored.delete(k) },
    addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) ?? []).filter((one) => one !== fn)); },
    document: {
      visibilityState: "visible",
      addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
      removeEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) ?? []).filter((one) => one !== fn)); },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, removeAttribute() {} },
      getElementById: () => null,
      // The pictures the roster has drawn. settleAvatars reads these to tell a remembered version that
      // still works from one the host has dropped, which is what keeps the check free.
      querySelectorAll: () => (options.images ?? []).map((one) => ({
        getAttribute: (name) => (name === "src" ? one.src : null),
        complete: one.complete !== false,
        naturalWidth: one.broken === true ? 0 : 64,
      })),
    },
    createDemoAdapter: () => ({}),
  };
  const defaults = { listAgents: [], getTrays: [], getAgentAutomations: [], getAgentWorkflows: [], getConversationOutline: [] };
  // The relay's own shaping, applied to the stub's answer, so the console is talking to something
  // that behaves like a relay with ui/api-diet.mjs loaded. `bare: true` is a relay without it.
  const fetchStub = async (url, init) => {
    const pathname = String(url).split("?")[0];
    const method = pathname.startsWith("/api/") ? pathname.slice(5) : null;
    const headers = init?.headers ?? {};
    if (method == null) {
      calls.push({ method: pathname, headers });
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) };
    }
    const args = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, args, headers });
    const answer = answers[method] ?? defaults[method] ?? {};
    const value = await (typeof answer === "function" ? answer(args, calls) : answer);
    if (value instanceof Error) return { ok: false, status: 500, headers: { get: () => null }, text: async () => JSON.stringify({ error: value.message }) };
    const upstream = JSON.stringify(value);
    if (options.bare === true) return { ok: true, status: 200, headers: { get: () => null }, text: async () => upstream };
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const shaped = shapeApiAnswer(method, args, lower, upstream);
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => shaped.headers[String(name).toLowerCase()] ?? null },
      text: async () => shaped.bytes,
    };
  };
  const exposed = adapterBody.replace(
    "  global.__bootMachineRoom =",
    "  global.__test = { createGatewayAdapter, hydrate };\n  global.__bootMachineRoom =",
  );
  const fn = new Function("window", "fetch", `${exposed}\nreturn window.__test;`);
  const api = fn(window, fetchStub);
  return {
    ...api,
    calls,
    window,
    stored,
    tick: async () => { for (const one of [...timers.intervals.values()]) await one(); },
    fire: async (type) => { for (const one of [...(listeners.get(type) ?? [])]) await one(); },
    headerOf: (method, name) => calls.filter((c) => c.method === method).map((c) => c.headers?.[name] ?? undefined),
  };
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const seedState = () => ({
  activeContext: { kind: "worker", id: "w1" },
  openContexts: [{ kind: "worker", id: "w1" }],
  workers: [{ id: "w1", name: "Probe", status: "ready", statusText: "Ready", messages: [], files: [], skills: [], channels: null, handoff: null, boxState: null, boxDisplay: null, hasOlder: false, composer: null }],
  rooms: [], routines: [], plugins: [], models: { default: "d", available: [] },
  settings: { autoReview: { enabled: false, allow: [], block: [] }, localToolPermission: null, reachable: true },
  desktop: { paused: false, timeline: [] }, teaching: { active: false, workerId: null, startedAt: null },
});

test("the tick asks the outline and the workflows lean, and the skills panel asks full", async () => {
  const h = harness({ getAgentTranscriptTail: { entries: [] }, getAgentWorkflows: [workflow("a")], getConversationOutline: [] });
  const adapter = h.createGatewayAdapter(seedState());
  await adapter.refresh();
  assert.deepEqual(h.headerOf("getConversationOutline", PROJECTION_HEADER), ["lean"]);
  assert.deepEqual(h.headerOf("getAgentWorkflows", PROJECTION_HEADER), ["lean"]);
  await adapter.getSkills("w1");
  assert.deepEqual(h.headerOf("getAgentWorkflows", PROJECTION_HEADER), ["lean", "full"]);
  // A command with no projection sends no header at all, so nothing else on the box is affected.
  assert.deepEqual(h.headerOf("listAgents", PROJECTION_HEADER), [undefined]);
  adapter.destroy();
});

test("a lean tick does not blank a skill body the panel already read", async () => {
  const h = harness({ getAgentTranscriptTail: { entries: [] }, getAgentWorkflows: [workflow("a")] });
  const state = seedState();
  const adapter = h.createGatewayAdapter(state);
  const read = await adapter.getSkills("w1");
  assert.ok(read[0].body.length > 0, "the panel's own read carries the recipe");
  await adapter.refresh();
  assert.equal(state.workers[0].skills[0].body, read[0].body, "a tick blanked the instructions under the skill's name");
  adapter.destroy();
});

test("the second read echoes the digest the relay handed back", async () => {
  const h = harness({ getAgentTranscriptTail: { entries: [] }, listAgents: [{ id: "w1", name: "Probe" }] });
  const adapter = h.createGatewayAdapter(seedState());
  await adapter.refresh();
  assert.deepEqual(h.headerOf("listAgents", IF_DIGEST_HEADER), [undefined], "nothing held yet, so nothing echoed");
  await adapter.refresh();
  const echoed = h.headerOf("listAgents", IF_DIGEST_HEADER);
  assert.equal(echoed.length, 2);
  assert.match(echoed[1], /^[0-9a-f]{64}$/, "the console did not send back the digest the relay handed it");
  adapter.destroy();
});

test("an unchanged answer is replayed as the same data, not as a sentinel the page would render", async () => {
  const entries = [{ kind: "message", id: "e1", role: "user", content: "hello", timestampMs: 1 }];
  const h = harness({ getAgentTranscriptTail: { entries }, listAgents: [{ id: "w1", name: "Probe" }] });
  const state = seedState();
  const adapter = h.createGatewayAdapter(state);
  await adapter.refresh();
  const first = state.workers[0].messages.length;
  assert.ok(first > 0);
  await adapter.refresh();
  await adapter.refresh();
  assert.equal(state.workers[0].messages.length, first, "an unchanged tail came back as something else");
  assert.equal(state.workers[0].name, "Probe");
  adapter.destroy();
});

test("an answer that moved is never replayed, whatever the console holds", async () => {
  let activity = 1;
  const h = harness({
    getAgentTranscriptTail: { entries: [] },
    listAgents: () => [{ id: "w1", name: "Probe", lastActivityAt: activity }],
    countAgents: () => activity,
  });
  const state = seedState();
  const adapter = h.createGatewayAdapter(state);
  await adapter.refresh();
  assert.equal(state.agentCount, 1);
  activity = 7;
  await adapter.refresh();
  assert.equal(state.agentCount, 7, "a changed answer was served out of a memo");
  adapter.destroy();
});

test("two reads of the same question at the same moment make one round trip", async () => {
  let release = null;
  const h = harness({
    getAgentTranscriptTail: { entries: [] },
    getHostStatus: () => new Promise((resolve) => { release = () => resolve({ capabilities: [] }); }),
    listAgents: [{ id: "w1", name: "Probe" }],
  });
  const pair = Promise.all([
    h.hydrate({ ...seedState(), activeContext: null, workers: [], rooms: [] }),
    h.hydrate({ ...seedState(), activeContext: null, workers: [], rooms: [] }),
  ]);
  await settle(20);
  if (release) release();
  await pair.catch(() => {});
  assert.equal(h.calls.filter((c) => c.method === "getHostStatus").length, 1, "the two overlapping reads each paid for their own round trip");
});

test("hidden stops the tick and closes the stream; visible reads once and opens a new one", async () => {
  const h = harness({ getAgentTranscriptTail: { entries: [] }, listAgents: [{ id: "w1", name: "Probe" }] });
  const adapter = h.createGatewayAdapter(seedState());
  await settle(20);
  assert.equal(h.window.__streams.length, 1);
  const before = h.calls.length;

  h.window.document.visibilityState = "hidden";
  await h.fire("visibilitychange");
  await settle(20);
  assert.equal(h.window.__streams[0].closed, true, "the stream was left open on a backgrounded page");
  await h.tick();
  await settle(30);
  assert.equal(h.calls.length, before, "a hidden page still asked the host for something");

  h.window.document.visibilityState = "visible";
  await h.fire("visibilitychange");
  await settle(60);
  assert.ok(h.calls.length > before, "coming back to the page read nothing, so it would show stale state");
  assert.equal(h.window.__streams.length, 2, "an EventSource closed here does not reconnect itself");
  adapter.destroy();
});

test("pagehide suspends too, and destroy leaves no listener behind", async () => {
  const h = harness({ getAgentTranscriptTail: { entries: [] } });
  const adapter = h.createGatewayAdapter(seedState());
  await settle(20);
  await h.fire("pagehide");
  await settle(20);
  assert.equal(h.window.__streams[0].closed, true);
  adapter.destroy();
  const before = h.calls.length;
  h.window.document.visibilityState = "visible";
  await h.fire("visibilitychange");
  await settle(40);
  assert.equal(h.calls.length, before, "a destroyed adapter still answered a visibility change");
});

test("the deep link decides the first paint, so only one conversation is ever loaded", async () => {
  const entries = [{ kind: "message", id: "e1", role: "user", content: "hello", timestampMs: 1 }];
  const h = harness({
    listAgents: [{ id: "w1", name: "One" }, { id: "w2", name: "Two", lastActivityAt: 99 }],
    getAgentTranscriptTail: { entries },
  }, { search: "?agent=w1&entry=e1" });
  const state = await h.hydrate({ ...seedState(), activeContext: null, workers: [], rooms: [] });
  // w2 is the most recently active, so without the deep link hydrate would land there.
  assert.deepEqual(state.activeContext, { kind: "worker", id: "w1" }, "the deep link did not decide the first paint");
  assert.deepEqual([...new Set(h.calls.filter((c) => c.method === "getAgentTranscriptTail").map((c) => c.args.id))], ["w1"],
    "a second conversation was loaded for a person who asked for one");
  const adapter = h.createGatewayAdapter(state);
  await settle(60);
  assert.equal(h.window.location.search.includes("agent="), false, "the query stayed, so a reload would re-navigate");
  adapter.destroy();
});

test("a deep link naming an agent this workspace does not have lands on the console, not an error", async () => {
  const h = harness({
    listAgents: [{ id: "w2", name: "Two", lastActivityAt: 99 }],
    getAgentTranscriptTail: { entries: [] },
  }, { search: "?agent=gone-for-good&entry=e9" });
  const state = await h.hydrate({ ...seedState(), activeContext: null, workers: [], rooms: [] });
  assert.deepEqual(state.activeContext, { kind: "worker", id: "w2" });
  const adapter = h.createGatewayAdapter(state);
  await settle(60);
  adapter.destroy();
});

test("a remembered avatar version is used without a call, and costs no request to check", async () => {
  const h = harness(
    { listAgents: [{ id: "w1", name: "One" }, { id: "w2", name: "Two" }], getAgentTranscriptTail: { entries: [] }, getAgentAvatar: { version: "aaaaaaaaaaaaaaaa" } },
    {
      localStorage: { "titanbot.avatarVersions": JSON.stringify({ w1: "1111111111111111", w2: null }) },
      images: [{ src: "/avatars/w1?v=1111111111111111" }],
    },
  );
  const state = await h.hydrate({ ...seedState(), activeContext: null, workers: [], rooms: [] });
  assert.equal(h.calls.filter((c) => c.method === "getAgentAvatar").length, 0, "the memo was there and the console downloaded every face anyway");
  assert.equal(state.workers.find((w) => w.id === "w1").avatar, "/avatars/w1?v=1111111111111111");
  // A remembered null is an answer, not a miss: that agent gets the placeholder and costs no call.
  assert.equal(state.workers.find((w) => w.id === "w2").avatar.startsWith("/avatars/"), false);
  const adapter = h.createGatewayAdapter(state);
  await settle(60);
  // The picture loaded, so there is nothing to correct -- and nothing was requested to learn that.
  assert.equal(h.calls.filter((c) => c.method.startsWith("/avatars/")).length, 0, "the check spent a request on a face that was already on screen");
  assert.equal(h.calls.filter((c) => c.method === "getAgentAvatar").length, 0);
  assert.equal(state.workers.find((w) => w.id === "w1").avatar, "/avatars/w1?v=1111111111111111");
  adapter.destroy();
});

test("a remembered version the host has dropped is forgotten, re-read and repainted", async () => {
  const h = harness(
    { listAgents: [{ id: "w1", name: "One" }], getAgentTranscriptTail: { entries: [] }, getAgentAvatar: { version: "bbbbbbbbbbbbbbbb" } },
    {
      localStorage: { "titanbot.avatarVersions": JSON.stringify({ w1: "staaaaaaaaaaaale" }) },
      // The browser finished loading that URL and got nothing: a 404 behind the remembered version.
      images: [{ src: "/avatars/w1?v=staaaaaaaaaaaale", broken: true }],
    },
  );
  const state = await h.hydrate({ ...seedState(), activeContext: null, workers: [], rooms: [] });
  assert.equal(state.workers[0].avatar, "/avatars/w1?v=staaaaaaaaaaaale");
  const adapter = h.createGatewayAdapter(state);
  await settle(80);
  assert.equal(state.workers[0].avatar, "/avatars/w1?v=bbbbbbbbbbbbbbbb", "the broken face was left on the roster");
  assert.equal(JSON.parse(h.stored.get("titanbot.avatarVersions")).w1, "bbbbbbbbbbbbbbbb");
  adapter.destroy();
});

test("a version nobody knows yet is learned AFTER first paint, not before it", async () => {
  const h = harness({ listAgents: [{ id: "w1", name: "One" }], getAgentTranscriptTail: { entries: [] }, getAgentAvatar: { version: "cccccccccccccccc" } });
  const state = await h.hydrate({ ...seedState(), activeContext: null, workers: [], rooms: [] });
  // Nothing downloaded to learn a string on the one path a person is waiting on, and the placeholder
  // face is drawn in the meantime -- the designed state for an agent with no version.
  assert.equal(h.calls.filter((c) => c.method === "getAgentAvatar").length, 0, "ten base64 avatars rode on first paint");
  assert.equal(state.workers[0].avatar.startsWith("/avatars/"), false);
  const adapter = h.createGatewayAdapter(state);
  await settle(80);
  assert.equal(h.calls.filter((c) => c.method === "getAgentAvatar").length, 1, "the version was never learned at all");
  assert.deepEqual(JSON.parse(h.stored.get("titanbot.avatarVersions")), { w1: "cccccccccccccccc" });
  assert.equal(state.workers[0].avatar, "/avatars/w1?v=cccccccccccccccc", "the real face never replaced the placeholder");
  adapter.destroy();
});

test("a relay with no ui/api-diet.mjs behaves exactly as it did before this wave", async () => {
  const bare = harness({
    listAgents: [{ id: "w1", name: "Probe" }],
    getAgentTranscriptTail: { entries: [{ kind: "message", id: "e1", role: "user", content: "hello", timestampMs: 1 }] },
    getConversationOutline: fixture.slice(0, 400),
    getAgentWorkflows: [workflow("a")],
  }, { bare: true });
  const state = seedState();
  const adapter = bare.createGatewayAdapter(state);
  await adapter.refresh();
  await adapter.refresh();
  // No digest came back, so none is ever echoed: nothing to go stale and nothing to replay.
  assert.deepEqual(bare.headerOf("listAgents", IF_DIGEST_HEADER), [undefined, undefined]);
  // The console still asks for lean; a relay that does not know the header ignores it and the whole
  // payload arrives, which weaveToolRows reads exactly as it always did.
  assert.equal(bare.headerOf("getConversationOutline", PROJECTION_HEADER)[0], "lean");
  assert.ok(state.workers[0].messages.length > 0, "the transcript came up empty against an old relay");
  // And the panel's body is there, because an old relay sends everything whatever was asked.
  const skills = await adapter.getSkills("w1");
  assert.ok(skills[0].body.length > 0);
  adapter.destroy();
});
