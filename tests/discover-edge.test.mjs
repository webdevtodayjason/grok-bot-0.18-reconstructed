// The welcome bar's relay half (DISCOVER-1), against injected reads rather than a box.
//
// The claims worth a test here are the ones a checklist gets wrong in a way nobody notices:
//
//   A STEP IS NEVER TICKED BY A CALLER. There is no route that marks one done and no field in any
//   body that sets one, so the only way a step can go green is a read of something that happened.
//   That is asserted as an ABSENCE, because an absence is what will get edited away one day;
//
//   A READ THAT DID NOT ANSWER IS NOT-DONE AND IS NOT AN ERROR. A box that is slow, a host with no
//   such command, a control plane that is down: all of them draw an unticked row on a console that is
//   otherwise working, and none of them 500s the route the window bar polls every sixty seconds;
//
//   EVERY READ IS BOUNDED. A read that never settles cannot hold the answer, which is the whole of
//   the 1.5 s budget and is measured here with a dep that never resolves;
//
//   THE ANSWER IS PER PERSON. Two accounts share one workspace (accounts.tenant carries no UNIQUE
//   constraint, which is why ui/server.mjs has subOf at all), so one person's Hide, one person's
//   phones and one person's desktop flag are theirs and not their colleague's;
//
//   and the evidence is read off the RIGHT FIELD. A transcript entry the agent wrote is not a person
//   saying hello, and a connector field that MAY hold a credential is not one that does -- both of
//   those are real bugs that shipped in this product's own history, and both are pinned here.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DISCOVER_CONNECTOR_FANOUT,
  DISCOVER_READ_BUDGET_MS,
  DISCOVER_STATE_FILE,
  DISCOVER_STEPS,
  DISCOVER_STEP_IDS,
  DISCOVER_TAIL_LIMIT,
  answered,
  connectorsWithCredential,
  createDiscoverEdge,
  discoverShape,
  memoriesIn,
  normalizeDiscoverState,
  readDesktopFlags,
  readDiscoverState,
  titanOf,
  userMessagesIn,
  withBudget,
  writeDiscoverState,
} from "../ui/discover-edge.mjs";
// The chain this file's titanOf copies. Imported for ONE purpose: to pin the two together, the way
// tests/cp-voice.test.mjs imports the relay's vendor table to pin it to the control plane's.
import { resolveVoiceAgent } from "../ui/voice-edge.mjs";

// ---- the small readers ---------------------------------------------------------------------------

test("the six steps are the brief's six, in the brief's order", () => {
  assert.deepEqual(DISCOVER_STEP_IDS, ["hello", "voice", "connect", "memory", "screen", "pocket"]);
  assert.deepEqual(DISCOVER_STEPS.map((step) => step.label), [
    "Say hello to Titan", "Make a voice call", "Connect an app",
    "Give Titan a memory", "Watch his screen", "Put him in your pocket",
  ]);
  // One of anything is discovery. A step whose `of` drifted above 1 would be a quota wearing a
  // checklist, and the console draws this denominator rather than inventing one.
  for (const step of DISCOVER_STEPS) assert.equal(step.of, 1, `${step.id} is not a one-of-one step`);
});

test("a person's own message is the only thing that counts as saying hello", () => {
  // gateway-adapter.js:236: "send-message is the agent speaking, and is the agent's only voice;
  // message with role user is the operator. Everything else is machinery."
  const tail = {
    entries: [
      { kind: "send-message", message: { content: "Hello, I am Titan." } },
      { kind: "tool-row", text: "ran a command" },
      { kind: "message", role: "assistant", content: "not a person" },
      { kind: "turn-failed", text: "that turn did not finish" },
      { kind: "message", role: "user", content: "hello" },
      { kind: "message", role: "user", content: "are you there" },
    ],
    nextBeforeSeq: 40,
  };
  assert.equal(userMessagesIn(tail), 2);
  // A conversation the agent filled on a schedule and nobody ever typed into is NOT a hello.
  assert.equal(userMessagesIn({ entries: tail.entries.filter((e) => e.role !== "user") }), 0);
  // The bare-array form too: getAgentTranscriptTail answers {entries, nextBeforeSeq} and a caller
  // that handed the array straight over must not silently read as empty.
  assert.equal(userMessagesIn(tail.entries), 2);
  for (const junk of [null, undefined, 7, "entries", {}]) assert.equal(userMessagesIn(junk), 0);
});

test("only a connector the host reports HOLDING a value counts as connected", () => {
  // The bug this pins shipped once already: `fields` is the union of what MAY be stored and the env
  // keys an entry leaves empty, so a freshly added connector with no key in it carries a field name.
  // gateway-adapter.js:1646 records it, after the TinyFish card claimed a value nobody had entered.
  const rows = [
    { server: "tinyfish", fields: [{ name: "TINYFISH_API_KEY" }], stored: [] },
    { server: "github", fields: [{ name: "GITHUB_TOKEN" }], stored: [{ name: "GITHUB_TOKEN" }] },
    null,
    { server: "slack", fields: { stored: ["SLACK_TOKEN"] } },
  ];
  assert.equal(connectorsWithCredential(rows), 2);
  assert.equal(connectorsWithCredential([{ server: "a", stored: [] }, { server: "b" }]), 0);
  assert.equal(connectorsWithCredential(null), 0);
});

test("memories are counted in whichever shape a host answers", () => {
  assert.equal(memoriesIn([{ id: "1" }, { id: "2" }]), 2);
  assert.equal(memoriesIn({ memories: [{ id: "1" }] }), 1);
  assert.equal(memoriesIn({ facts: [{ id: "1" }, { id: "2" }, { id: "3" }] }), 3);
  assert.equal(memoriesIn(null), 0);
});

test("Titan is resolved by the same chain the voice and the mail land on", () => {
  const roster = [
    { id: "room-1", name: "Everyone", isGroup: true },
    { id: "a-2", name: "Researcher" },
    { id: "a-1", name: "Titan" },
  ];
  assert.deepEqual(titanOf(roster), { id: "a-1", name: "Titan" });
  // And the chain itself, pinned against ui/voice-edge.mjs, which is where it is written down. A
  // welcome bar reading a different conversation from the one the voice talks to would tick "Say
  // hello to Titan" off a conversation the person has never seen called Titan.
  for (const list of [roster, [{ id: "a-2", name: "Researcher" }], [{ id: "g", name: "Room", isGroup: true }]]) {
    assert.equal(titanOf(list).id, resolveVoiceAgent(list, {}).agentId, `the two chains disagree on ${JSON.stringify(list)}`);
  }
  // A bare array is the shape listAgents actually answers (measured on grok-bot-local-vm 2026-09-10);
  // the wrapped one is what a newer host might send.
  assert.equal(titanOf({ agents: roster }).id, "a-1");
  assert.deepEqual(titanOf([]), { id: "", name: "" });
});

// ---- the budget ----------------------------------------------------------------------------------

test("a read that never settles is missing rather than slow, and its signal is aborted", async () => {
  let sawAbort = false;
  const started = Date.now();
  const answer = await withBudget((signal) => new Promise(() => {
    signal.addEventListener("abort", () => { sawAbort = true; });
  }), { budgetMs: 30 });
  assert.equal(answered(answer), false);
  assert.equal(sawAbort, true, "the budget expired without aborting the read, so the socket is still held");
  assert.ok(Date.now() - started < 1_000, "the budget did not bound the wait");
});

test("a read that throws is missing, and the throw is offered to the caller rather than raised", async () => {
  const seen = [];
  const answer = await withBudget(() => { throw new Error("this host has no such command"); },
    { budgetMs: 50, onMiss: (error) => seen.push(String(error?.message ?? error)) });
  assert.equal(answered(answer), false);
  assert.deepEqual(seen, ["this host has no such command"]);
});

test("the budget is the brief's one and a half seconds", () => {
  assert.equal(DISCOVER_READ_BUDGET_MS, 1_500);
});

// ---- the shape -----------------------------------------------------------------------------------

test("a step that could not be read is not-done and says so, and it is not an error", () => {
  const shape = discoverShape({
    hello: { read: true, count: 3 },
    voice: { read: false, count: 0 },
    connect: { read: true, count: 0 },
    memory: { read: true, count: 1 },
    screen: { read: false, count: 0 },
    pocket: { read: true, count: 2 },
  });
  const by = Object.fromEntries(shape.steps.map((step) => [step.id, step]));
  assert.equal(by.hello.done, true);
  assert.equal(by.hello.count, 3);
  // Unreadable and zero are both not-done, and `read` is what tells them apart. Neither is an error
  // and neither carries one: this is drawn in the window bar of a console that is working.
  assert.equal(by.voice.done, false);
  assert.equal(by.voice.read, false);
  assert.equal(by.connect.done, false);
  assert.equal(by.connect.read, true);
  assert.equal(shape.done, 3);
  assert.equal(shape.of, 6);
  assert.equal(shape.pct, 50);
  assert.equal(shape.hidden, false);
  for (const step of shape.steps) assert.equal(Object.hasOwn(step, "error"), false, "a step carries an error field");
});

test("the bar is over steps and never over counts", () => {
  // Six memories is one step, not six. A bar weighted by how much somebody wrote would move when
  // nothing was discovered, which is the opposite of what the bar is for.
  const one = discoverShape({ memory: { read: true, count: 600 } });
  assert.equal(one.pct, 17);
  const all = discoverShape(Object.fromEntries(DISCOVER_STEP_IDS.map((id) => [id, { read: true, count: 1 }])));
  assert.equal(all.pct, 100);
  assert.equal(discoverShape({}).pct, 0);
});

// ---- the relay's own flag ------------------------------------------------------------------------

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discover-"));
  test.after?.(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("the desktop flag is written 0600 and is per person", async () => {
  const dir = await tempDir();
  const file = path.join(dir, DISCOVER_STATE_FILE);
  await writeDiscoverState({ desktop: { "acct-1": 1_700_000_000_000 } }, { file });
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, `the flag file is ${mode.toString(8)}, and it names who has opened a screen`);
  const back = await readDiscoverState(file);
  assert.equal(back.desktop["acct-1"], 1_700_000_000_000);
  assert.equal(back.desktop["acct-2"], undefined);
  // A file that is not there is an ANSWER on both readers: a workspace nobody has opened a screen on
  // has no file, and that is a measured no rather than a guess.
  assert.deepEqual(await readDiscoverState(path.join(dir, "nothing.json")), { desktop: {} });
  assert.deepEqual(await readDesktopFlags(path.join(dir, "nothing.json")), { desktop: {} });
  // A file that cannot be read is where the two part company, and the parting is the point. The
  // WRITE path takes an empty state so a screen being opened is always recorded; the ANSWER path
  // throws, so the step is drawn as unreadable rather than as a confident no on a broken volume.
  assert.deepEqual(await readDiscoverState(dir), { desktop: {} });
  await assert.rejects(() => readDesktopFlags(dir));
});

test("the desktop map is bounded, oldest out", () => {
  const desktop = {};
  for (let i = 0; i < 260; i += 1) desktop[`acct-${i}`] = 1_000 + i;
  const kept = normalizeDiscoverState({ desktop }).desktop;
  assert.equal(Object.keys(kept).length, 200);
  assert.equal(kept["acct-259"], 1_259, "the newest entry fell off");
  assert.equal(kept["acct-0"], undefined, "the oldest entry was kept");
  // Junk is dropped rather than stored: this file is read into an object that keys an answer.
  assert.deepEqual(normalizeDiscoverState({ desktop: { a: 0, b: "no", c: -1 } }).desktop, {});
  assert.deepEqual(normalizeDiscoverState(null), { desktop: {} });
  assert.deepEqual(normalizeDiscoverState({ desktop: ["a"] }), { desktop: {} });
});

// ---- the edge ------------------------------------------------------------------------------------

function fakeRes() {
  return {
    status: 0, headers: {}, body: null, ended: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = { ...this.headers, ...headers }; return this; },
    end(payload) { this.ended = true; this.body = payload == null ? null : JSON.parse(String(payload)); return this; },
  };
}

const fakeReq = (method = "GET") => ({ method, headers: {} });

/**
 * A box, a control plane and a workspace, all injected. `gateway` is a table keyed on the command, so
 * a case that wants one command to be absent says so and the rest of the path still runs; a function
 * value is called with the arguments, which is how the fan-out and the budget cases are driven.
 */
async function edgeWith({ gateway = {}, cp = null, devices = [], desktop = {}, budgetMs = 200 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discover-edge-"));
  const file = path.join(dir, DISCOVER_STATE_FILE);
  if (Object.keys(desktop).length > 0) await writeDiscoverState({ desktop }, { file });
  const seen = { commands: [], cpReads: [], cpWrites: [], logs: [] };
  const plane = cp === null ? null : cp;
  const edge = createDiscoverEdge({
    gatewayCall: async (t, command, args, { signal } = {}) => {
      seen.commands.push({ slug: t.slug, command, args, signal: signal ?? null });
      const found = gateway[command];
      if (found === undefined) throw new Error(`this host has no ${command}`);
      return typeof found === "function" ? await found(args, signal) : found;
    },
    cpRead: plane == null ? null : async ({ slug, sub, signal }) => {
      seen.cpReads.push({ slug, sub });
      return typeof plane.read === "function" ? await plane.read({ slug, sub, signal }) : plane.read;
    },
    cpWrite: plane == null ? null : async ({ slug, sub, hidden }) => {
      seen.cpWrites.push({ slug, sub, hidden });
      if (plane.writeFails === true) throw new Error("the control plane answered HTTP 502");
      return true;
    },
    devicesFor: (t, sub) => devices.filter((row) => String(row.sub ?? "") === String(sub)),
    stateFileFor: () => file,
    budgetMs,
    now: () => 1_700_000_000_000,
    log: (line) => seen.logs.push(line),
  });
  const t = { slug: "demo", gateway: "http://box.invalid:1340" };
  test.after?.(() => rm(dir, { recursive: true, force: true }));
  return { edge, t, seen, file };
}

/** A box where all four reads answer, so a case can take one of them away. */
const LIVE_BOX = {
  listAgents: [{ id: "a-1", name: "Titan" }],
  getAgentTranscriptTail: { entries: [{ kind: "message", role: "user", content: "hello" }], nextBeforeSeq: null },
  getAgentMemories: [{ id: "m-1", text: "he takes his coffee black" }],
  listInstalledMcpServers: [{ id: 1, name: "github" }],
  listConnectorSecretFields: { server: "github", fields: [{ name: "GITHUB_TOKEN" }], stored: [{ name: "GITHUB_TOKEN" }] },
};

test("six steps read from six surfaces, and a full bar is a hundred per cent", async () => {
  const { edge, t, seen } = await edgeWith({
    gateway: LIVE_BOX,
    cp: { read: { ok: true, tenant: "demo", hidden: false, voiceCalls: 1, voiceCallSeconds: 10 } },
    devices: [{ id: "dev_1", sub: "acct-1", revokedAt: null }],
    desktop: { "acct-1": 1_699_000_000_000 },
  });
  const answer = await edge.read({ t, sub: "acct-1" });
  assert.equal(answer.pct, 100, `not every step ticked: ${JSON.stringify(answer.steps)}`);
  assert.equal(answer.done, 6);
  for (const step of answer.steps) assert.equal(step.read, true, `${step.id} was not read`);
  // The tail is a BOUNDED read and not the whole history: a checkbox must not cost a year of
  // conversation on every console load.
  const tail = seen.commands.find((one) => one.command === "getAgentTranscriptTail");
  assert.equal(tail.args.limit, DISCOVER_TAIL_LIMIT);
  assert.equal(tail.args.id, "a-1");
  // listAgents is read ONCE for the two steps that need Titan, not twice.
  assert.equal(seen.commands.filter((one) => one.command === "listAgents").length, 1);
  // And the control plane was asked once, for both of the things it owns.
  assert.deepEqual(seen.cpReads, [{ slug: "demo", sub: "acct-1" }]);
});

test("a box that answers nothing draws an empty bar rather than an error", async () => {
  const { edge, t } = await edgeWith({ gateway: {}, cp: null });
  const answer = await edge.read({ t, sub: "acct-1" });
  assert.equal(answer.pct, 0);
  assert.equal(answer.hidden, false, "a control plane that is absent must not hide somebody's bar");
  const by = Object.fromEntries(answer.steps.map((step) => [step.id, step]));
  for (const id of ["hello", "voice", "connect", "memory"]) {
    assert.equal(by[id].done, false);
    assert.equal(by[id].read, false, `${id} claimed a read off a box that answered nothing`);
  }
  // The two this relay owns still answer, because neither needs the box or the control plane. That is
  // what keeps the bar drawable on a single-box install.
  assert.equal(by.screen.read, true);
  assert.equal(by.pocket.read, true);
});

test("a read that hangs cannot hold the answer, and the rest of the bar still draws", async () => {
  const { edge, t } = await edgeWith({
    gateway: { ...LIVE_BOX, listInstalledMcpServers: () => new Promise(() => {}) },
    cp: { read: { hidden: false, voiceCalls: 0 } },
    devices: [{ id: "dev_1", sub: "acct-1", revokedAt: null }],
    desktop: { "acct-1": 1_699_000_000_000 },
    budgetMs: 40,
  });
  const started = Date.now();
  const answer = await edge.read({ t, sub: "acct-1" });
  assert.ok(Date.now() - started < 2_000, "one hung read held the whole answer");
  const by = Object.fromEntries(answer.steps.map((step) => [step.id, step]));
  assert.equal(by.connect.read, false);
  assert.equal(by.connect.done, false);
  assert.equal(by.hello.done, true, "a hung connector read took the rest of the bar with it");
  assert.equal(by.pocket.done, true);
});

test("a control plane that is down leaves the voice step unread and the bar shown", async () => {
  const { edge, t } = await edgeWith({
    gateway: LIVE_BOX,
    cp: { read: () => { throw new Error("connect ECONNREFUSED"); } },
  });
  const answer = await edge.read({ t, sub: "acct-1" });
  const voice = answer.steps.find((step) => step.id === "voice");
  assert.equal(voice.read, false, "an outage was read as a workspace that has made no calls");
  assert.equal(voice.done, false);
  // Hidden fails OPEN. A person who pressed Hide sees the bar again while the control plane is down,
  // which is the honest cost of the two facts sharing one round trip; the alternative is a console
  // that hides a bar because a service is unreachable.
  assert.equal(answer.hidden, false);
});

test("a settled call over the threshold is the control plane's answer, not this relay's arithmetic", async () => {
  const { edge, t } = await edgeWith({ gateway: LIVE_BOX, cp: { read: { hidden: true, voiceCalls: 2 } } });
  const answer = await edge.read({ t, sub: "acct-1" });
  const voice = answer.steps.find((step) => step.id === "voice");
  assert.equal(voice.count, 2);
  assert.equal(voice.done, true);
  assert.equal(answer.hidden, true);
});

test("one person's phones, screen and Hide are not their colleague's", async () => {
  const { edge, t, seen } = await edgeWith({
    gateway: LIVE_BOX,
    cp: { read: ({ sub }) => ({ hidden: sub === "acct-1", voiceCalls: 0 }) },
    devices: [{ id: "dev_1", sub: "acct-1", revokedAt: null }],
    desktop: { "acct-1": 1_699_000_000_000 },
  });
  const mine = await edge.read({ t, sub: "acct-1" });
  const theirs = await edge.read({ t, sub: "acct-2" });
  const by = (answer) => Object.fromEntries(answer.steps.map((step) => [step.id, step]));
  assert.equal(by(mine).pocket.done, true);
  assert.equal(by(theirs).pocket.done, false, "one account's phone ticked another account's step");
  assert.equal(by(mine).screen.done, true);
  assert.equal(by(theirs).screen.done, false, "one account's desktop ticked another account's step");
  assert.equal(mine.hidden, true);
  assert.equal(theirs.hidden, false, "one person's Hide took the bar off another person's screen");
  // The person travels to the control plane on every read, because that is the only thing that makes
  // the row theirs.
  assert.deepEqual(seen.cpReads.map((one) => one.sub), ["acct-1", "acct-2"]);
});

test("a revoked phone is not a phone in anybody's pocket", async () => {
  const { edge, t } = await edgeWith({
    gateway: LIVE_BOX,
    cp: { read: { hidden: false, voiceCalls: 0 } },
    devices: [{ id: "dev_1", sub: "acct-1", revokedAt: 1_699_000_000_000 }],
  });
  const answer = await edge.read({ t, sub: "acct-1" });
  const pocket = answer.steps.find((step) => step.id === "pocket");
  assert.equal(pocket.read, true);
  assert.equal(pocket.count, 0);
  assert.equal(pocket.done, false);
});

test("the connector fan-out is bounded, and one connector that throws does not lose the rest", async () => {
  const asked = [];
  const { edge, t } = await edgeWith({
    gateway: {
      ...LIVE_BOX,
      listInstalledMcpServers: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `server-${i}` })),
      listConnectorSecretFields: (args) => {
        asked.push(args.server);
        // An installed server that is not in connectors.json genuinely throws here: an account server
        // has no stdio spec and no secret fields. One of those must not lose the whole step.
        if (args.server === "server-0") throw new Error("no such connector entry");
        return { server: args.server, stored: args.server === "server-3" ? [{ name: "TOKEN" }] : [] };
      },
    },
    cp: { read: { hidden: false, voiceCalls: 0 } },
  });
  const answer = await edge.read({ t, sub: "" });
  assert.equal(asked.length, DISCOVER_CONNECTOR_FANOUT, `asked ${asked.length} connectors inside one budget`);
  const connect = answer.steps.find((step) => step.id === "connect");
  assert.equal(connect.read, true);
  assert.equal(connect.count, 1);
  assert.equal(connect.done, true);
});

// ---- the routes ------------------------------------------------------------------------------------

test("GET /discover answers the bar and nothing else answers on that path", async () => {
  const { edge, t } = await edgeWith({ gateway: LIVE_BOX, cp: { read: { hidden: false, voiceCalls: 0 } } });
  const res = fakeRes();
  await edge.handle(fakeReq("GET"), res, new URL("http://relay.invalid/discover"), { t, sub: "acct-1" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(res.body.steps.map((step) => step.id), DISCOVER_STEP_IDS);
  assert.equal(typeof res.body.pct, "number");
  assert.equal(res.body.hidden, false);

  // A POST to the read is refused rather than treated as a write.
  const posted = fakeRes();
  await edge.handle(fakeReq("POST"), posted, new URL("http://relay.invalid/discover"), { t, sub: "acct-1" });
  assert.equal(posted.status, 405);
});

test("Hide and Show are the same write with two spellings, and both carry the person", async () => {
  const { edge, t, seen } = await edgeWith({ gateway: LIVE_BOX, cp: { read: { hidden: false, voiceCalls: 0 } } });
  const hid = fakeRes();
  await edge.handle(fakeReq("POST"), hid, new URL("http://relay.invalid/discover/hide"), { t, sub: "acct-1" });
  assert.equal(hid.status, 200);
  assert.deepEqual(hid.body, { ok: true, hidden: true });

  const shown = fakeRes();
  await edge.handle(fakeReq("POST"), shown, new URL("http://relay.invalid/discover/show"), { t, sub: "acct-1" });
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body, { ok: true, hidden: false });

  assert.deepEqual(seen.cpWrites, [
    { slug: "demo", sub: "acct-1", hidden: true },
    { slug: "demo", sub: "acct-1", hidden: false },
  ]);
  // A GET at either path is refused: they are verbs.
  for (const pathname of ["/discover/hide", "/discover/show"]) {
    const res = fakeRes();
    await edge.handle(fakeReq("GET"), res, new URL(`http://relay.invalid${pathname}`), { t, sub: "acct-1" });
    assert.equal(res.status, 405, `${pathname} answered a GET`);
  }
});

test("a Hide that did not reach the control plane says so rather than reporting success", async () => {
  const { edge, t } = await edgeWith({ gateway: LIVE_BOX, cp: { read: { hidden: false, voiceCalls: 0 }, writeFails: true } });
  const res = fakeRes();
  await edge.handle(fakeReq("POST"), res, new URL("http://relay.invalid/discover/hide"), { t, sub: "acct-1" });
  assert.equal(res.status, 503);
  assert.match(String(res.body.error), /not saved/);

  // And with no control plane at all, which is every single-box install: a sentence, not a 500 and
  // not a silent success on a choice that went nowhere.
  const single = await edgeWith({ gateway: LIVE_BOX, cp: null });
  const alone = fakeRes();
  await single.edge.handle(fakeReq("POST"), alone, new URL("http://relay.invalid/discover/hide"), { t: single.t, sub: "" });
  assert.equal(alone.status, 503);
  assert.match(String(alone.body.error), /no control plane/);
});

test("there is no route, body or field that marks a step done", async () => {
  const { edge, t, seen } = await edgeWith({ gateway: LIVE_BOX, cp: { read: { hidden: false, voiceCalls: 0 } } });
  // Every write this edge exposes, tried with a body that says every step is finished.
  for (const pathname of ["/discover", "/discover/hide", "/discover/show", "/discover/done", "/discover/step"]) {
    const res = fakeRes();
    const req = { method: "POST", headers: {}, body: { steps: DISCOVER_STEP_IDS.map((id) => ({ id, done: true })), pct: 100 } };
    await edge.handle(req, res, new URL(`http://relay.invalid${pathname}`), { t, sub: "acct-1" });
    assert.ok(res.status === 200 || res.status === 404 || res.status === 405, `${pathname} answered ${res.status}`);
  }
  // Nothing above reached the box or wrote a step anywhere, and the bar is still read from evidence.
  assert.equal(seen.commands.length, 0, "a write path made a box read, which means it computed a step");
  const after = await edge.read({ t, sub: "acct-1" });
  const by = Object.fromEntries(after.steps.map((step) => [step.id, step]));
  assert.equal(by.screen.done, false, "a body ticked a step");
  assert.equal(by.pocket.done, false, "a body ticked a step");
  // The edge's own surface, named: a read, a hide/show, and the desktop note the upgrade makes. No
  // fourth entry point, so there is nowhere else a step could be set from.
  assert.deepEqual(Object.keys(edge).sort(), ["handle", "noteDesktop", "read", "setHidden"]);
});

// ---- the desktop note ------------------------------------------------------------------------------

test("opening the desktop ticks the screen step for that person, once", async () => {
  const { edge, t, file } = await edgeWith({ gateway: LIVE_BOX, cp: { read: { hidden: false, voiceCalls: 0 } } });
  const before = await edge.read({ t, sub: "acct-1" });
  assert.equal(before.steps.find((step) => step.id === "screen").done, false);

  assert.equal(await edge.noteDesktop({ t, sub: "acct-1" }), true);
  const after = await edge.read({ t, sub: "acct-1" });
  assert.equal(after.steps.find((step) => step.id === "screen").done, true);
  assert.equal(after.steps.find((step) => step.id === "screen").count, 1);

  // A second open writes nothing: a person opening and closing the pane all afternoon is one write.
  const firstWrite = JSON.parse(await readFile(file, "utf8"));
  assert.equal(await edge.noteDesktop({ t, sub: "acct-1" }), false);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), firstWrite);

  // And it is that person's row alone.
  const theirs = await edge.read({ t, sub: "acct-2" });
  assert.equal(theirs.steps.find((step) => step.id === "screen").done, false);
});

test("a desktop note that cannot be written is a log line and never a throw", async () => {
  const { t, seen } = await edgeWith({ gateway: LIVE_BOX, cp: null });
  // A directory where the file should be: the write fails and the upgrade it was called from must
  // not care. That upgrade carries a person's screen and keyboard.
  const broken = createDiscoverEdge({
    gatewayCall: async () => { throw new Error("no box"); },
    stateFileFor: () => os.tmpdir(),
    log: (line) => seen.logs.push(line),
  });
  assert.equal(await broken.noteDesktop({ t, sub: "acct-1" }), false);
  assert.equal(seen.logs.length, 1);
  assert.match(seen.logs[0], /desktop flag could not be written/);
  // An edge with no state file at all answers false rather than throwing.
  assert.equal(await createDiscoverEdge({ gatewayCall: async () => ({}) }).noteDesktop({ t, sub: "" }), false);
  // And the same broken edge still READS: an unwritable flag file is five unticked rows and a bar at
  // nought per cent, not an exception on the route the window bar polls.
  const bar = await broken.read({ t, sub: "" });
  assert.equal(bar.pct, 0);
  assert.equal(bar.steps.find((step) => step.id === "screen").read, false);
});
