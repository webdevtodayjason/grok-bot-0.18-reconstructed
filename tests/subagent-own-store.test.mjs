// SUBAGENT-1. A background subagent's conversation has to live somewhere of its own.
//
// On both staff boxes a subagent directory held an audit ledger and nothing else: no store.db, no
// blobs, no transcript. The child was bound to its PARENT's store, so its turn was built on top of
// the parent's conversation and settled back into it, and its own directory stayed empty. These
// tests pin the store a child now owns, and the rules its life runs by: opened once and lazily,
// held for as long as the subagent exists, closed exactly once, and never written through after.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".subagent-store-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const entry = path.join(stage, "entry.ts");
const from = (relative) => JSON.stringify(path.join(repoRoot, relative));
writeFileSync(entry, [
  `export { SandSessionMaterialization } from ${from("source/host/extensions/session/session-materialization.js")};`,
  `export { SandAgentDb } from ${from("source/host/extensions/session/agent-db.js")};`,
  `export { liveDbHandleCount } from ${from("source/host/storage/store-db.js")};`,
  `export { createTurnSettle } from ${from("source/host/runner/turn-settle.js")};`,
  `export { createSubagentRuntime } from ${from("source/host/runner/subagent-runtime.js")};`,
  "",
].join("\n"), "utf8");
const built = await build({
  entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node",
  target: "es2022", external: ["jsonc-parser"], logLevel: "silent",
});
const bundlePath = path.join(stage, "subagent-store.cjs");
writeFileSync(bundlePath, built.outputFiles[0].text, "utf8");
const mod = createRequire(import.meta.url)(bundlePath);

const subagentId = () => `sand-subagent-${randomUUID()}`;
const dbPathOf = (root, id) => path.join(root, id, "store.db");

/** Stands in for AgentStore2: it only has to remember what was checkpointed into it. */
function fakeAgentStore() {
  const checkpoints = [], metadata = new Map();
  let disposals = 0;
  return {
    checkpoints,
    get disposals() { return disposals; },
    handleCheckpoint: async (_ctx, checkpoint) => { checkpoints.push(checkpoint); },
    getMetadata: (key) => metadata.get(key),
    setMetadata: (key, value) => { metadata.set(key, value); },
    getConversationStateStructure: () => ({ turns: [], summaryArchives: [], turnTimings: [] }),
    getFullConversation: async () => ({}),
    getBlobStore: () => ({}),
    resetFromDb: async () => {},
    dispose: async () => { disposals += 1; },
  };
}

function makeMaterialization() {
  const root = mkdtempSync(path.join(stage, "agents-"));
  const stores = new Map();
  const closedBlobStores = [];
  const materialization = new mod.SandSessionMaterialization({
    ctx: {},
    rootDir: root,
    createBlobWorkerPool: () => ({
      closeAll: async () => {},
      closeStore: async (blobDbPath) => { closedBlobStores.push(blobDbPath); },
    }),
    createAgentStore: ({ agentId }) => {
      const store = fakeAgentStore();
      stores.set(agentId, store);
      return store;
    },
    createMemoryStore: () => ({}),
    resolveUserTimeZone: () => undefined,
    agentExists: (id) => existsSync(dbPathOf(root, id)),
    getAgentDir: (id) => path.join(root, id),
    readActiveAgentId: () => null,
  });
  return { root, stores, closedBlobStores, materialization };
}

test("a subagent gets a store and nothing else a bot gets", async () => {
  const { root, materialization } = makeMaterialization();
  const id = subagentId();
  const storage = await materialization.openSubagentStorage(id);
  try {
    assert.equal(storage.id, id);
    assert.ok(existsSync(dbPathOf(root, id)), "the subagent has no database of its own");
    assert.ok(!existsSync(path.join(root, id, "profile.json")), "a subagent must not get a profile");
    assert.ok(!existsSync(path.join(root, id, "settings.json")), "a subagent must not get settings");
    assert.equal(storage.automations, undefined, "a subagent must not get an automation store");
    // And it is still not a bot: the roster and the cap both skip a sand-subagent- directory.
    assert.deepEqual(await materialization.listAgentRecordIds(), []);
    assert.equal(await materialization.countCapAgents(), 0);
  } finally {
    await storage.close();
  }
});

test("only a subagent id can come through this door", async () => {
  const { materialization } = makeMaterialization();
  await assert.rejects(
    () => materialization.openSubagentStorage(randomUUID()),
    /Not a subagent id/,
    "a bare uuid would mint a bot's directory with no profile and no cap check",
  );
});

test("a parent turn's checkpoints land in the parent store and a child turn's in the child store", async () => {
  const { materialization } = makeMaterialization();
  const parentStore = fakeAgentStore();
  const childId = subagentId();
  const childStorage = await materialization.openSubagentStorage(childId);
  try {
    // Built exactly the way the composition builds them: one owner per run shell, resolved late.
    const settleHostFor = (store, transcriptId) => ({
      isSubagentRunner: transcriptId !== "parent-agent",
      getTranscriptId: () => transcriptId,
      getBlobStore: () => ({}),
      agentStore: () => ({
        handleCheckpoint: (context, checkpoint) => store.handleCheckpoint(context, checkpoint),
        getMetadata: (key) => store.getMetadata(key),
      }),
      setLocalState: () => { throw new Error("the store is bound; nothing may fall back to local state"); },
      ownsRunner: () => true,
      isRunSuperseded: () => false,
      latestPromptMessages: () => [],
      persistAnnouncedAgentProfile: () => {},
    });
    const scope = (conversationId) => ({ conversationId, profilePromptSnapshots: {} });
    const checkpoint = () => ({ turns: [], summaryArchives: [], turnTimings: [] });

    const parentSettle = mod.createTurnSettle(settleHostFor(parentStore, "parent-agent"), scope("parent-agent"));
    await parentSettle.persistFinalState({}, checkpoint());
    const childSettle = mod.createTurnSettle(settleHostFor(childStorage.agentStore, childId), scope(childId));
    await childSettle.persistFinalState({}, checkpoint());

    assert.equal(parentStore.checkpoints.length, 1, "the parent's turn did not reach the parent's store");
    assert.equal(childStorage.agentStore.checkpoints.length, 1, "the child's turn did not reach the child's store");
    // The defect, stated as an assertion: the child's turn must not be in the parent's conversation.
    assert.equal(parentStore.checkpoints.length + childStorage.agentStore.checkpoints.length, 2);
  } finally {
    await childStorage.close();
  }
});

test("two children opened at once each get their own handle", async () => {
  const { root, materialization } = makeMaterialization();
  const [first, second] = [subagentId(), subagentId()];
  const [one, two] = await Promise.all([
    materialization.openSubagentStorage(first),
    materialization.openSubagentStorage(second),
  ]);
  try {
    assert.notEqual(one.dbPath, two.dbPath);
    assert.notEqual(one.agentStore, two.agentStore);
    assert.notEqual(one.db, two.db);
    assert.equal(mod.liveDbHandleCount(path.resolve(dbPathOf(root, first))), 1);
    assert.equal(mod.liveDbHandleCount(path.resolve(dbPathOf(root, second))), 1);
    // A row written through one is invisible to the other.
    one.db.appendTranscriptEntry({ kind: "message", id: "t0u", role: "user", content: "only mine" });
    assert.equal(one.db.getTranscriptEntries().length, 1);
    assert.equal(two.db.getTranscriptEntries().length, 0);
  } finally {
    await one.close();
    await two.close();
  }
});

test("the open-handle count before and after N children is the same", async () => {
  const { root, materialization, closedBlobStores } = makeMaterialization();
  const ids = Array.from({ length: 5 }, subagentId);
  const before = ids.map((id) => mod.liveDbHandleCount(path.resolve(dbPathOf(root, id))));
  assert.deepEqual(before, [0, 0, 0, 0, 0]);
  const open = [];
  for (const id of ids) open.push(await materialization.openSubagentStorage(id));
  assert.deepEqual(ids.map((id) => mod.liveDbHandleCount(path.resolve(dbPathOf(root, id)))), [1, 1, 1, 1, 1]);
  for (const storage of open) await storage.close();
  const after = ids.map((id) => mod.liveDbHandleCount(path.resolve(dbPathOf(root, id))));
  assert.deepEqual(after, before, "a stopped subagent left a sqlite handle open");
  for (const storage of open) assert.equal(storage.agentStore.disposals, 1, "the blob store was not disposed exactly once");
  // And each child's blob worker went with it, rather than waiting for the pool's idle sweep.
  assert.deepEqual(
    closedBlobStores.sort(),
    ids.map((id) => path.join(root, id, "conversation-blobs.db")).sort(),
    "a stopped subagent left its blob worker in the pool",
  );
});

test("a write cannot follow a close", async () => {
  const { root, materialization } = makeMaterialization();
  const id = subagentId();
  const storage = await materialization.openSubagentStorage(id);
  storage.db.appendTranscriptEntry({ kind: "message", id: "t0u", role: "user", content: "before the close" });
  await storage.close();
  // Closing twice is a no-op, and the store is disposed once however many times close is called.
  await storage.close();
  assert.equal(storage.agentStore.disposals, 1);
  assert.equal(storage.db.appendTranscriptEntry({ kind: "message", id: "t1u", role: "user", content: "after the close" }), false,
    "the closed database accepted a write");
  const reopened = new mod.SandAgentDb(dbPathOf(root, id));
  try {
    assert.deepEqual(reopened.getTranscriptEntries().map((row) => row.id), ["t0u"],
      "a row landed after the store was closed");
  } finally {
    reopened.close();
  }
  assert.equal(mod.liveDbHandleCount(path.resolve(dbPathOf(root, id))), 0);
});

test("a settled subagent is released once, and a steered one is not released between turns", async () => {
  const runtime = mod.createSubagentRuntime({
    getConversationId: () => "parent-agent",
    resolveBoxId: () => "box-1",
    emitAsyncTasksChanged: () => {},
    computerUse: { freeWindow: () => {} },
  });
  let releases = 0, runs = 0;
  const session = {
    getObservedToolCallCount: () => 1,
    getActivitySnapshot: () => [],
    getTranscriptPath: () => null,
    getResolvedOutline: async () => [],
    run: async () => { runs += 1; return { text: "did the work", aborted: false }; },
    interrupt: () => {},
    dispose: async () => { releases += 1; },
  };
  runtime.sessions.set("child-1", session);
  runtime.dispatchBackgroundSubagent({
    subagentAgentId: "child-1",
    subagentType: "generalPurpose",
    toolCallId: "call-1",
    prompt: "write the file",
    run: () => session.run(),
  });
  // A steer keeps the subagent alive, so its store must survive the turn boundary.
  assert.equal(runtime.steerSubagent("child-1", "and then check it"), "ok");
  await runtime.drainBackgroundSubagents();
  assert.equal(runs, 2, "the steer did not produce a second turn, so this measured nothing");
  assert.equal(releases, 1, `the child was released ${releases} time(s); it must be exactly one, at its last settlement`);
});

test("the run shell settles into the store its own owner resolves", () => {
  // A source check, because this line sits in a composition that needs the whole host to build.
  const source = readComposition();
  assert.match(source, /const createProductionTurnSettleHost = \(\s*owner: TurnOwner = sessionTurnOwner,\s*\): TurnSettleHost/);
  assert.match(source, /const store = owner\.resolveStore\(\);/);
  assert.match(source, /getTranscriptId: \(\) => owner\.transcriptId\(\)/);
  const settleHost = source.slice(source.indexOf("const createProductionTurnSettleHost = ("));
  assert.ok(!/session\.agentStore/.test(settleHost.slice(0, settleHost.indexOf("persistAnnouncedAgentProfile"))),
    "the settle host still reads the session's store, so every shell settles into the parent's conversation");
  assert.match(source, /createSettleHost: \(\) => createProductionTurnSettleHost\(shellTurnOwner\)/);
  assert.match(source, /const getProductionConversationState = conversationStateReaderFor\(shellTurnOwner\)/);
});

test("the child holds its own store, and drops it before it is closed", () => {
  const source = readComposition();
  const at = source.indexOf("function createSubagentRunner(");
  assert.ok(at > 0, "createSubagentRunner moved");
  const body = source.slice(at, at + 6_000);
  assert.match(body, /productionTurnRunShell: makeRunShell\(args\.subagentType, agentId, childTurnOwner\)/);
  assert.match(body, /child\.setAgentStore\(handle\.agentStore, hooks\.agentProfileProvider\)/);
  const release = body.slice(body.indexOf("const release = async ()"));
  const dropped = release.indexOf("child.setAgentStore(undefined, undefined)");
  const closed = release.indexOf("await handle.close()");
  assert.ok(dropped > 0 && closed > dropped,
    "the runner must drop the handle before the close, or a write can follow one");
  assert.ok(release.indexOf("storage = undefined") < dropped,
    "the owner must stop resolving the store before the runner lets go of it");
  assert.match(body, /appendSubagentTranscriptEntry\(handle, "user", prompt\)/);
  assert.match(body, /appendSubagentTranscriptEntry\(handle, "agent", text\)/);
});

function readComposition() {
  return require_fs().readFileSync(path.join(repoRoot, "source/host/host-runner-composition.ts"), "utf8");
}
function require_fs() {
  return createRequire(import.meta.url)("node:fs");
}
