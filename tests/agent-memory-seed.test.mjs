// BOTS-1 — seeding an agent's own remembered facts, and the one thing that must never happen.
//
// The catalog's Add button puts a bot's operating rules where the agent's own facts live. There was
// no write path for that at all: the host serves getAgentMemories, deleteAgentMemory and
// clearAgentMemories, and the only thing that ever ADDED a memory was the agent itself, mid-turn.
//
// The reason this file exists rather than a one-line handler: sand-memory.ts caps a fact at 500
// characters and normalizeMemoryContent collapses whitespace and then SLICES, with no signal of any
// kind. Measured on this Mac 2026-09-09 against the scraped pack, 85 of 444 memories are over the
// cap and 63,035 of 190,747 characters would have been cut mid sentence — on the persona and
// job-boundary paragraphs that are the whole identity of the worst-hit bots. So the seed path
// REFUSES a long fact by name and writes nothing, and these cases pin that: a truncated memory is a
// bug that reads as a working import, and nobody would ever find it from the outside.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".agent-memory-seed-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));

const load = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const file = path.join(stage, `${name}.cjs`);
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(file);
};

const seed = await load("source/host/agents/seed-agent-memories.ts", "seed-agent-memories");
const memory = await load("source/host/runner/sand-memory.ts", "sand-memory");
const { MEMORY_MAX_CONTENT_LENGTH } = memory;

/** A store with the slice of FileMemoryStore this path uses, recording every write. */
function fakeStore(existing = []) {
  const rows = existing.map((content) => ({ content }));
  const writes = [];
  return {
    rows,
    writes,
    listMemories() { return rows.map((row) => ({ ...row })); },
    addMemory(content, createdAt, kind) {
      writes.push({ content, createdAt, kind });
      // The real store answers null on a fact it already holds, silently. So does this one.
      if (rows.some((row) => memory.memoryDedupeKey(row.content) === memory.memoryDedupeKey(content))) return null;
      const record = { content, createdAt, kind };
      rows.push(record);
      return record;
    },
  };
}

const sentence = (n) => `${"a".repeat(Math.max(1, n - 1))}.`;

function apply(store, memories, options = {}) {
  const cleared = [];
  return seed.applyAgentMemorySeed(
    { store, clearPromptSnapshot: () => cleared.push(Date.now()), now: () => 1_700_000_000_000 },
    { memories, ...options },
  ).then((result) => ({ result, cleared }));
}

// ------------------------------------------------------------------ 1. the cap

test("a fact over the cap is refused by name and nothing is written for it", async () => {
  const store = fakeStore();
  const long = sentence(MEMORY_MAX_CONTENT_LENGTH + 1);
  assert.equal(long.length, 501, "the fixture is not one character over the cap");
  const { result } = await apply(store, ["a short one.", long]);
  assert.deepEqual(result.added, ["a short one."]);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].text, long);
  assert.match(result.rejected[0].why, /501 characters/);
  assert.match(result.rejected[0].why, /not shortened and not stored/);
  // The whole point: the store never saw it, so there is no cut version anywhere.
  assert.equal(store.writes.length, 1, "the long fact reached the store");
  assert.ok(!store.rows.some((row) => row.content.startsWith("aaa")), "a truncated fact was stored");
});

test("a fact exactly at the cap is stored whole, and one over it is not", async () => {
  const store = fakeStore();
  const exact = sentence(MEMORY_MAX_CONTENT_LENGTH);
  const over = sentence(MEMORY_MAX_CONTENT_LENGTH + 1);
  const { result } = await apply(store, [exact, over]);
  assert.deepEqual(result.added, [exact]);
  assert.equal(store.rows[0].content.length, MEMORY_MAX_CONTENT_LENGTH);
  assert.equal(result.rejected.length, 1);
});

test("the cap is measured after whitespace is collapsed, the way the store measures it", async () => {
  // A paragraph with newlines and runs of spaces is 600 raw characters and 480 real ones. Refusing
  // it on the raw length would refuse a fact that fits.
  const store = fakeStore();
  const padded = `${"word ".repeat(90)}\n\n${"   "}end.`;
  const collapsed = seed.normalizeSeedMemory(padded);
  assert.ok(padded.length > collapsed.length);
  assert.ok(collapsed.length <= MEMORY_MAX_CONTENT_LENGTH);
  const { result } = await apply(store, [padded]);
  assert.deepEqual(result.added, [collapsed], "the fact was measured before it was collapsed");
  assert.equal(store.rows[0].content, collapsed);
});

test("normalizeSeedMemory collapses and trims and never slices, which is where the store differs", () => {
  const long = sentence(MEMORY_MAX_CONTENT_LENGTH + 60);
  assert.equal(seed.normalizeSeedMemory(long).length, long.length, "the seed path shortened a fact");
  assert.equal(memory.normalizeMemoryContent(long).length, MEMORY_MAX_CONTENT_LENGTH, "sand-memory stopped slicing");
  assert.equal(seed.normalizeSeedMemory("  a\n  b  "), "a b");
  assert.equal(seed.normalizeSeedMemory(null), "");
  assert.equal(seed.normalizeSeedMemory(12), "");
});

// ------------------------------------------------------------------ 2. duplicates

test("a fact the store already holds is counted, not written", async () => {
  const store = fakeStore(["The team ships on Thursdays."]);
  const { result } = await apply(store, ["The team ships on Thursdays.", "New one."]);
  assert.deepEqual(result.added, ["New one."]);
  assert.equal(result.duplicates, 1);
  assert.equal(store.writes.length, 1, "the duplicate was sent to the store anyway");
  assert.equal(store.rows.length, 2);
});

test("the same fact twice in one call is written once", async () => {
  const store = fakeStore();
  const { result } = await apply(store, ["Same.", "  Same.  ", "Different."]);
  assert.deepEqual(result.added, ["Same.", "Different."]);
  assert.equal(result.duplicates, 1);
});

test("a store that answers null is counted as a duplicate rather than reported as an add", async () => {
  // FileMemoryStore.addMemory answers null on a fact it already holds and says nothing else. A
  // seed that reported its wish instead of the answer would claim facts the agent does not have.
  const store = fakeStore();
  store.addMemory = () => null;
  const { result } = await apply(store, ["One.", "Two."]);
  assert.deepEqual(result.added, []);
  assert.equal(result.duplicates, 2);
});

test("an empty fact is refused rather than written as an empty line", async () => {
  const store = fakeStore();
  const { result } = await apply(store, ["   ", "\n\n", "real."]);
  assert.deepEqual(result.added, ["real."]);
  assert.equal(result.rejected.length, 2);
  for (const row of result.rejected) assert.equal(row.why, "it is empty");
});

// ------------------------------------------------------------------ 3. the prompt snapshot

test("the prompt snapshot is cleared whenever a fact was written", async () => {
  // Without this the agent that was just seeded reads a frozen memory prompt for the rest of the
  // session and answers as though it remembers nothing, which reads as "Add did nothing".
  const { cleared } = await apply(fakeStore(), ["One.", "Two."]);
  assert.equal(cleared.length, 1);
});

test("a call that wrote nothing does not clear the snapshot", async () => {
  const store = fakeStore(["Held."]);
  const { result, cleared } = await apply(store, ["Held.", sentence(MEMORY_MAX_CONTENT_LENGTH + 1)]);
  assert.deepEqual(result.added, []);
  assert.equal(cleared.length, 0, "a snapshot was thrown away for a call that changed nothing");
});

test("one fact written among refusals still clears the snapshot", async () => {
  const { result, cleared } = await apply(fakeStore(), [sentence(900), "kept."]);
  assert.deepEqual(result.added, ["kept."]);
  assert.equal(cleared.length, 1);
});

// ------------------------------------------------------------------ 4. the call cap and the kind

test("everything past the hundredth fact is refused by name rather than dropped", async () => {
  const store = fakeStore();
  const memories = Array.from({ length: 103 }, (_, at) => `Fact number ${at + 1}.`);
  const { result } = await apply(store, memories);
  assert.equal(result.added.length, seed.SEED_AGENT_MEMORIES_MAX);
  assert.equal(result.rejected.length, 3);
  assert.match(result.rejected[0].why, /at most 100/);
  assert.equal(result.rejected[0].text, "Fact number 101.");
  assert.equal(store.rows.length, seed.SEED_AGENT_MEMORIES_MAX);
});

test("facts land as log by default and as profile when asked", async () => {
  const store = fakeStore();
  await apply(store, ["One."]);
  assert.equal(store.writes[0].kind, "log");
  const profile = fakeStore();
  await apply(profile, ["One."], { kind: "profile" });
  assert.equal(profile.writes[0].kind, "profile");
  const nonsense = fakeStore();
  await apply(nonsense, ["One."], { kind: "shouting" });
  assert.equal(nonsense.writes[0].kind, "log", "an unknown kind was passed through to the store");
});

test("the plan decides without a store, so the page can show it before the click", () => {
  const plan = seed.planAgentMemorySeed(
    [{ content: "Held." }],
    ["Held.", "New.", sentence(MEMORY_MAX_CONTENT_LENGTH + 1)],
  );
  assert.deepEqual(plan.write, ["New."]);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.rejected.length, 1);
});

// ------------------------------------------------------------------ 5. the verb is actually wired
//
// A pure function nothing routes to is a function that never runs. These two pins are cheap and
// catch the half-registration: a handler with no protocol row answers "unknown gateway method", and
// a protocol row with no handler answers a TypeError the console shows as a failed setup.

test("addAgentMemories is registered in the protocol and served by the gateway api", () => {
  const protocol = readFileSync(path.join(repoRoot, "source/host/gateway-protocol.ts"), "utf8");
  assert.match(protocol, /addAgentMemories: \(api: GatewayApi, body: string\) => api\.addAgentMemories\(parseCommandArgs\(body\)\)/);
  const api = readFileSync(path.join(repoRoot, "source/host/host-gateway-api.ts"), "utf8");
  assert.match(api, /addAgentMemories: \(args: any\) =>\s*\n?\s*method\(manager, "addAgentMemories"\)\(args\.id, args\.memories, args\.kind\)/);
});

test("the manager resolves the store through MemoryService and clears the snapshot", () => {
  const manager = readFileSync(path.join(repoRoot, "source/host/extensions/transcript/transcript-manager.ts"), "utf8");
  assert.match(manager, /async addAgentMemories\(/);
  assert.match(manager, /storeForAgent\(agentId\)/);
  assert.match(manager, /clearPromptSnapshot: \(\) => this\.clearMemoryPromptSnapshot\(agentId\)/);
  // NO_MEMORY has no store and unavailableMemoryStore answers null to every write, which this path
  // would otherwise report as "already known" on a box holding no memory at all.
  assert.match(manager, /this box is not holding memory for its agents/);
});
