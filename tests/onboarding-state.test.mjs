// ONBOARD-1. First run at the box level: the flag, the migration rule, and the answers.
//
// The rule these cases exist to protect is the one that can hurt somebody: a box that has already
// been used must NEVER be thrown into a first-time interview. Two signals decide it -- more than
// one bot, or any agent with a message the person sent -- and they are consulted exactly once, on
// a box whose settings document carries no onboarding record at all.
//
// The subtle half is the second read. The moment the person answers Titan's first question they
// have a prompted conversation, so a rule that ran again would close setup underneath them. The
// record therefore wins over the signals forever after it exists, and the last case here pins it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".onboarding-state-test-"));
// The box store reads SAND_DATA_ROOT on every call, and under a runner that loads every suite into
// one process another file's root would otherwise win.
//
// That is what used to happen. The assignment below sat at module top level, which under
// tests/index.js runs while the imports are still being resolved -- so every suite imported after
// this one overwrote it, and by the time these tests actually executed the box store was reading
// somebody else's directory. `isOnboardingActive` then answered from a settings file this suite
// had never written. It was invisible for as long as it existed, because tests/index.js was also
// importing a file that does not exist on this branch, so `node --test tests/` died at resolution
// and never ran any of it (found while landing CONSOLE-4, which fixed that import).
//
// So the root is pinned before each read instead, which is what the paragraph above always meant.
const boxRoot = mkdtempSync(path.join(tmpdir(), "onboarding-box-"));
const pinBoxRoot = () => { process.env.SAND_DATA_ROOT = boxRoot; };
pinBoxRoot();
after(() => {
  rmSync(stage, { recursive: true, force: true });
  rmSync(boxRoot, { recursive: true, force: true });
  delete process.env.SAND_DATA_ROOT;
});

const load = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, `${name}.cjs`);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(bundlePath);
};

const state = await load("source/host/extensions/onboarding/onboarding-state.ts", "onboarding-state");
const service = await load("source/host/extensions/onboarding/onboarding-service.ts", "onboarding-service");
const probeModule = await load("source/host/extensions/onboarding/onboarding-probe.ts", "onboarding-probe");
const boxStore = await load("source/host/extensions/onboarding/onboarding-box-store.ts", "onboarding-box-store");

const NOW = 1_757_000_000_000;

const memoryStore = (initial) => {
  let value = initial;
  return { read: () => value, write: (next) => { value = next; }, peek: () => value };
};

const fakeProbe = (botIds, prompted = new Set()) => ({
  listBotIds: async () => botIds,
  hasPromptedConversation: async (id) => prompted.has(id),
});

const makeService = (options = {}) => {
  const store = options.store ?? memoryStore(undefined);
  const applied = [];
  const svc = service.createOnboardingService({
    store,
    probe: options.probe ?? fakeProbe([]),
    maxAgents: () => options.maxAgents ?? 13,
    applyTimeZone: (zone) => applied.push(zone),
    isValidTimeZone: options.isValidTimeZone ?? (() => true),
    now: () => options.now ?? NOW,
  });
  return { svc, store, applied };
};

test("a fresh box reports done:false and writes the record it just resolved", async () => {
  const { svc, store } = makeService({ probe: fakeProbe([]) });
  const view = await svc.getState();
  assert.equal(view.done, false);
  assert.equal(view.startedAt, NOW);
  assert.deepEqual(view.answers, {});
  assert.deepEqual([...view.fields], ["name", "location", "business", "ownsBusiness", "workingStyle"]);
  assert.deepEqual([...view.remaining], [...view.fields], "nothing answered yet");
  assert.equal(view.maxAgents, 13);
  // Written, not just computed: the probe must not run a second time on this box.
  assert.equal(store.peek().done, false);
});

test("a box with one bot and no messages is still fresh", async () => {
  // This is the shape a brand new box has the instant the seed mints Titan: one agent, silent.
  const { svc } = makeService({ probe: fakeProbe(["titan"]) });
  assert.equal((await svc.getState()).done, false);
});

test("MIGRATION (a): more than one bot marks the box done at first read", async () => {
  // Jason's own instance and the Mac dev box are this shape -- 8 bots on the Mac box, measured
  // 2026-09-07 -- so neither is ever thrown into onboarding.
  const { svc, store } = makeService({ probe: fakeProbe(["a", "b"]) });
  const view = await svc.getState();
  assert.equal(view.done, true);
  assert.equal(view.doneReason, "existing-box");
  assert.equal(store.peek().done, true, "the answer is persisted, so the probe runs once");
});

test("MIGRATION (b): one bot with a message the person sent marks the box done", async () => {
  const { svc } = makeService({ probe: fakeProbe(["only"], new Set(["only"])) });
  const view = await svc.getState();
  assert.equal(view.done, true);
  assert.equal(view.doneReason, "existing-box");
});

test("the migration rule never runs again once a record exists", async () => {
  // The trap: answering Titan's first question gives the box a prompted conversation. If the rule
  // re-ran, setup would close underneath the person mid-interview.
  const store = memoryStore({ done: false, startedAt: NOW, answers: { name: "Jason" } });
  const { svc } = makeService({ store, probe: fakeProbe(["a", "b", "c"], new Set(["a"])) });
  const view = await svc.getState();
  assert.equal(view.done, false, "a busy-looking box with a record in progress stays in progress");
  assert.deepEqual(view.answers, { name: "Jason" });
  assert.deepEqual([...view.answered], ["name"]);
  assert.deepEqual([...view.remaining], ["location", "business", "ownsBusiness", "workingStyle"]);
});

test("the probe short-circuits: two bots never opens a conversation", async () => {
  let reads = 0;
  const signals = await probeModule.readBoxUseSignals({
    listBotIds: async () => ["a", "b", "c"],
    hasPromptedConversation: async () => { reads += 1; return false; },
  });
  assert.deepEqual(signals, { agentCount: 3, hasPromptedConversation: true });
  assert.equal(reads, 0);
});

test("a conversation the probe cannot read counts as used, not as fresh", async () => {
  const probe = probeModule.createHostBoxUseProbe({
    listAgentRecordIds: async () => ["one"],
    getAgentDir: (id) => `/agents/${id}`,
    isGroupDir: () => false,
    readTranscriptEntries: async () => { throw new Error("store is quarantined"); },
  });
  assert.equal(await probe.hasPromptedConversation("one"), true);
});

test("groups are not bots, so a group directory is not counted", async () => {
  const probe = probeModule.createHostBoxUseProbe({
    listAgentRecordIds: async () => ["bot", "room"],
    getAgentDir: (id) => `/agents/${id}`,
    isGroupDir: (dir) => dir.endsWith("room"),
    readTranscriptEntries: async () => [],
  });
  assert.deepEqual([...await probe.listBotIds()], ["bot"]);
});

test("an answer is saved, trimmed, and reflected in the progress strip", async () => {
  const { svc, store } = makeService();
  await svc.getState();
  assert.deepEqual(svc.saveAnswer({ field: "name", value: "  Jason  " }), { ok: true, detail: "Saved name." });
  assert.equal(store.peek().answers.name, "Jason");
  const view = await svc.getState();
  assert.deepEqual([...view.answered], ["name"]);
});

test("a save answers the shape the runner reads: detail on success, reason on failure", () => {
  // The runner reads `detail` on ok and `reason` on failure. A tool that answered {ok, message}
  // made every SUCCESSFUL write report "Cannot read properties of undefined (reading 'text')".
  const { svc } = makeService();
  const good = svc.saveAnswer({ field: "business", value: "managed IT" });
  assert.equal(good.ok, true);
  assert.equal(typeof good.detail, "string");
  const bad = svc.saveAnswer({ field: "favourite_colour", value: "blue" });
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.reason, "string");
  assert.equal(svc.saveAnswer({ field: "name", value: "   " }).ok, false, "an empty answer is not state");
});

test("the time zone answer is applied to the box as it arrives", () => {
  const { svc, applied } = makeService();
  svc.saveAnswer({ field: "timeZone", value: "America/Chicago" });
  assert.deepEqual(applied, ["America/Chicago"]);
});

test("a time zone that is not a real IANA name is stored but never applied", () => {
  const { svc, applied, store } = makeService({ isValidTimeZone: (zone) => zone === "America/Chicago" });
  svc.saveAnswer({ field: "timeZone", value: "Middle Earth" });
  assert.deepEqual(applied, []);
  assert.equal(store.peek().answers.timeZone, "Middle Earth", "kept, so the console can show what he heard");
});

test("Skip for now closes it and keeps whatever was captured", async () => {
  const { svc } = makeService();
  await svc.getState();
  svc.saveAnswer({ field: "name", value: "Jason" });
  const view = svc.complete({ skipped: true });
  assert.equal(view.done, true);
  assert.equal(view.doneReason, "skipped");
  assert.equal(view.completedAt, NOW);
  assert.equal(view.answers.name, "Jason");
});

test("completing re-applies the time zone through the settings service", async () => {
  const { svc, applied } = makeService();
  await svc.getState();
  svc.complete({ answers: { timeZone: "Europe/London", name: "Jason" } });
  // Once as it arrived is not enough: the second write is the one that fires the userTimeZone
  // listeners, which is what re-anchors routines to the person's own clock.
  assert.deepEqual(applied, ["Europe/London"]);
});

test("a finished box refuses further answers", async () => {
  const { svc } = makeService();
  await svc.getState();
  svc.complete({});
  const result = svc.saveAnswer({ field: "name", value: "Jason" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /already finished/);
});

test("the test hook reopens a scratch box", async () => {
  const { svc } = makeService();
  await svc.getState();
  svc.complete({});
  assert.equal(svc.reset().done, false);
  assert.equal((await svc.getState()).done, false);
});

test("a settings document holding junk under `onboarding` reads as no record", () => {
  for (const junk of [null, "done", [], 7, {}, { done: "yes" }]) {
    assert.equal(state.parseOnboardingRecord(junk), undefined, `${JSON.stringify(junk)} is not a record`);
  }
  assert.deepEqual(state.parseOnboardingRecord({ done: false, answers: { name: "Jason", nope: 1 } }), {
    done: false, answers: { name: "Jason" },
  });
});

test("an answer cannot become a paste the box has to carry forever", () => {
  const long = "x".repeat(state.ONBOARDING_ANSWER_MAX_CHARS + 500);
  assert.equal(state.normalizeOnboardingAnswer(long).length, state.ONBOARDING_ANSWER_MAX_CHARS);
});

// The tool gate. `save_onboarding_answer` is offered only while the box's record says done:false,
// and `buildTurnTools` asks this on every tool build, so the answer is cached against the settings
// file's stamp. The default has to be "no": an unreadable settings file must not hand a finished
// box a tool for a conversation that already happened.
const writeBoxSettings = (onboarding) => {
  pinBoxRoot();
  const document = { version: 1, ...(onboarding === undefined ? {} : { onboarding }) };
  writeFileSync(path.join(boxRoot, "settings.json"), JSON.stringify(document, null, 2));
};

test("the tool gate is off on a box with no settings file at all", () => {
  pinBoxRoot();
  rmSync(path.join(boxRoot, "settings.json"), { force: true });
  assert.equal(boxStore.isOnboardingActive(), false);
});

test("the tool gate follows the record, and notices when it flips", () => {
  writeBoxSettings({ done: false, answers: {} });
  assert.equal(boxStore.isOnboardingActive(), true);
  // Same file, a different length AND a different mtime, so the stamp cache cannot answer stale.
  writeBoxSettings({ done: true, doneReason: "completed", answers: { name: "Jason" } });
  assert.equal(boxStore.isOnboardingActive(), false);
});

test("a settings file with no onboarding record leaves the gate off", () => {
  writeBoxSettings(undefined);
  assert.equal(boxStore.isOnboardingActive(), false);
});

test("an unreadable settings file leaves the gate off, and does not throw a turn", () => {
  pinBoxRoot();
  writeFileSync(path.join(boxRoot, "settings.json"), "{ half written");
  assert.equal(boxStore.isOnboardingActive(), false);
});

test("the rule itself, as a table", () => {
  const rows = [
    { signals: { agentCount: 0, hasPromptedConversation: false }, done: false },
    { signals: { agentCount: 1, hasPromptedConversation: false }, done: false },
    { signals: { agentCount: 1, hasPromptedConversation: true }, done: true },
    { signals: { agentCount: 2, hasPromptedConversation: false }, done: true },
    { signals: { agentCount: 9, hasPromptedConversation: true }, done: true },
  ];
  for (const row of rows) {
    const resolved = state.resolveOnboardingState({ stored: undefined, signals: row.signals, now: NOW });
    assert.equal(resolved.record.done, row.done, JSON.stringify(row.signals));
    assert.equal(resolved.shouldPersist, true, "a first read always writes its answer");
  }
  const stored = { done: false, answers: {} };
  const kept = state.resolveOnboardingState({
    stored, signals: { agentCount: 99, hasPromptedConversation: true }, now: NOW,
  });
  assert.equal(kept.record, stored);
  assert.equal(kept.shouldPersist, false);
});
