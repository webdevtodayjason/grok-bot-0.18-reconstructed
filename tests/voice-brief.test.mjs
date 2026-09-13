/**
 * VOICE-16, the host's half: who an agent is, what it remembers and what the two of you were just
 * saying, projected for a voice session to be built out of.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and it is not the arithmetic. Everything this projects lands in a
 * realtime session's instructions, which are billed as a cached prefix and which nothing may rewrite
 * mid-call. So the two ways to get this wrong are both expensive: blow the cap and every call carries
 * an unbounded prefix; trim the wrong thing and the voice stops being the agent, which is the whole
 * point of the wave. The cap and the TRIM ORDER are therefore the load-bearing tests, and the order is
 * the brief's own -- the oldest turn of the conversation goes first, then the least important fact, and
 * the persona never goes at all.
 *
 * TWO BUNDLES, ON PURPOSE. The first is voice-brief.ts, which is pure, so the caps and the trim order
 * are pinned with no box, no filesystem and no clock. The second is transcript-manager.ts driven
 * against a fake session store, which is the only way to prove the three things the wiring decides:
 * that an unknown agent answers null rather than an empty brief, that the persona comes off the agent's
 * own profile, and that a box holding no memory service still answers a brief instead of throwing.
 * tests/voice-turn-draft.test.mjs established the bundle-and-require pattern; this follows it.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".voice-brief-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));

/**
 * The bundle is written under node_modules so the few things left external to it -- the protobuf
 * runtime the manager's own imports reach for -- resolve the way they do in the host.
 */
async function bundled(entry, name) {
  const built = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
    external: ["better-sqlite3"],
  });
  const file = path.join(stage, name);
  writeFileSync(file, built.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(file);
}

const {
  MAX_VOICE_BRIEF_BYTES,
  MAX_VOICE_BRIEF_FACT_CHARS,
  MAX_VOICE_BRIEF_TURN_CHARS,
  VOICE_BRIEF_RECENT_TURNS,
  VOICE_BRIEF_TAIL_LIMIT,
  buildVoiceBrief,
  voiceBriefBytes,
  voiceBriefTurnsOf,
} = await bundled("source/host/extensions/transcript/voice-brief.ts", "voice-brief.cjs");

const { TranscriptManager } = await bundled(
  "source/host/extensions/transcript/transcript-manager.ts",
  "transcript-manager.cjs",
);

/** A person's row, exactly as send-pipeline.ts writes it through createUserMessage. */
const said = (content, at = 1_700_000_000_000) => ({ kind: "message", id: `t${at}u`, role: "user", content, timestampMs: at });
/** The agent's DELIVERED message, which is the only thing it says that ever reaches a person. */
const replied = (content, at = 1_700_000_000_100) => ({ kind: "send-message", id: `t${at}s0`, message: { type: "text", content }, timestampMs: at });

// ------------------------------------------------------------------ what a conversation looks like

test("the turns are the person's rows and the agent's DELIVERED messages, and nothing else in between", () => {
  const turns = voiceBriefTurnsOf([
    said("what is the gate doing", 10),
    // Assistant prose. It reaches nobody on this product and must not be read out as a turn, the same
    // rule turn-draft.ts exists to defend for the streaming draft.
    { kind: "message", id: "t0a0", role: "assistant", content: "let me look at the gate log" },
    { kind: "tool-call", id: "t0c0", name: "shellToolCall", args: "{}" },
    replied("two legs are red", 20),
    said("fix them", 30),
  ]);
  assert.deepEqual(turns, [
    { role: "person", text: "what is the gate doing", at: 10 },
    { role: "agent", text: "two legs are red", at: 20 },
    { role: "person", text: "fix them", at: 30 },
  ]);
});

test("an entry with no clock is carried with at 0 rather than dropped or stamped with now", () => {
  const turns = voiceBriefTurnsOf([{ kind: "message", id: "t0u", role: "user", content: "hello" }]);
  assert.deepEqual(turns, [{ role: "person", text: "hello", at: 0 }]);
});

test("only the last twenty turns are carried, and they are the LAST twenty", () => {
  const entries = [];
  for (let i = 0; i < 50; i += 1) entries.push(said(`line ${i}`, 1_000 + i));
  const turns = voiceBriefTurnsOf(entries);
  assert.equal(turns.length, VOICE_BRIEF_RECENT_TURNS);
  assert.equal(turns[0].text, "line 30");
  assert.equal(turns.at(-1).text, "line 49");
});

test("a wall of text is one clamped turn, so it cannot spend the whole brief on itself", () => {
  const [turn] = voiceBriefTurnsOf([said("x".repeat(5_000), 10)]);
  assert.equal(turn.text.length, MAX_VOICE_BRIEF_TURN_CHARS + 1, "clamped, plus the one-character marker");
  assert.ok(turn.text.endsWith("…"));
});

// --------------------------------------------------------------------- the cap and the trim order

test("a brief that fits is handed over whole", () => {
  const brief = buildVoiceBrief({
    persona: "You run a two-person managed services shop.",
    agentName: "Titan",
    workspaceName: "acme",
    facts: ["the gate runs on the R750", "Richard is the partner"],
    entries: [said("what is up", 10), replied("the gate is green", 20)],
  });
  assert.equal(brief.persona, "You run a two-person managed services shop.");
  assert.deepEqual(brief.facts, ["the gate runs on the R750", "Richard is the partner"]);
  assert.equal(brief.recent.length, 2);
  assert.ok(voiceBriefBytes(brief) < MAX_VOICE_BRIEF_BYTES);
});

test("THE TRIM ORDER: the oldest turn goes first, then the last fact, and the persona never goes", () => {
  const persona = "You run the shop. ".repeat(10).trim();
  const facts = [];
  for (let i = 0; i < 40 // 40 facts of 400 characters is 16 KB of facts alone
    ; i += 1) facts.push(`fact ${i} ${"f".repeat(400)}`);
  const entries = [];
  for (let i = 0; i < 20; i += 1) entries.push(said(`turn ${i} ${"t".repeat(400)}`, 1_000 + i));
  const brief = buildVoiceBrief({ persona, agentName: "Titan", workspaceName: "acme", facts, entries });
  assert.ok(voiceBriefBytes(brief) <= MAX_VOICE_BRIEF_BYTES, `the brief is ${voiceBriefBytes(brief)} bytes`);
  // The persona is untouched. A voice without it is not the agent, which is the whole point.
  assert.equal(brief.persona, persona);
  // Turns went before facts, and the ones that survived are the NEWEST.
  assert.ok(brief.recent.length < 20, "turns were trimmed");
  if (brief.recent.length > 0) assert.ok(brief.recent.at(-1).text.startsWith("turn 19"), "the newest turn survived");
  // Facts are trimmed from the TAIL, because listMemories hands out profile facts first and then the
  // most recent, so the tail is the least important end.
  assert.ok(brief.facts.length < 40, "facts were trimmed");
  assert.ok(brief.facts[0].startsWith("fact 0"), "the most important fact survived");
});

test("the turns go entirely before one fact is dropped", () => {
  const facts = [];
  for (let i = 0; i < 30; i += 1) facts.push(`fact ${i} ${"f".repeat(400)}`);
  const entries = [said("a short question", 10)];
  const brief = buildVoiceBrief({ persona: "You run the shop.", facts, entries, agentName: "Titan" });
  assert.ok(voiceBriefBytes(brief) <= MAX_VOICE_BRIEF_BYTES);
  assert.equal(brief.recent.length, 0, "the conversation went first");
  assert.ok(brief.facts.length > 0 && brief.facts.length < 30, "and then facts, from the tail");
});

test("a persona far larger than the whole cap is clamped, which is what makes the cap a guarantee", () => {
  const brief = buildVoiceBrief({ persona: "p".repeat(200_000), agentName: "Titan", facts: ["one"], entries: [said("hi", 10)] });
  assert.ok(voiceBriefBytes(brief) <= MAX_VOICE_BRIEF_BYTES, `the brief is ${voiceBriefBytes(brief)} bytes`);
  assert.ok(brief.persona.endsWith("…"), "and it says it was cut");
});

test("a fact longer than the store's own cap is clamped rather than carried whole", () => {
  const brief = buildVoiceBrief({ persona: "", facts: ["f".repeat(5_000)], entries: [] });
  assert.equal(brief.facts[0].length, MAX_VOICE_BRIEF_FACT_CHARS + 1);
});

test("an empty memory, an empty conversation and no persona are a brief and not a failure", () => {
  const brief = buildVoiceBrief({ persona: "", agentName: "Titan", workspaceName: "acme", facts: [], entries: [] });
  assert.deepEqual(brief, { persona: "", facts: [], recent: [], agentName: "Titan", workspaceName: "acme" });
});

test("nothing at all still answers the shape, so a caller never has to guard every field", () => {
  assert.deepEqual(buildVoiceBrief({}), { persona: "", facts: [], recent: [], agentName: "", workspaceName: "" });
});

// ------------------------------------------------------------------------------------- no secrets

test("the redactor runs over the persona, every fact and every turn", () => {
  const brief = buildVoiceBrief({
    persona: "Your key is sk-live-0001.",
    facts: ["the mail token is sk-live-0001"],
    entries: [said("use sk-live-0001", 10), replied("done with sk-live-0001", 20)],
    agentName: "Titan",
    workspaceName: "sk-live-0001",
    redact: (value) => value.replaceAll("sk-live-0001", "[redacted]"),
  });
  const whole = JSON.stringify(brief);
  assert.ok(!whole.includes("sk-live-0001"), `a secret survived: ${whole}`);
  assert.ok(whole.includes("[redacted]"));
});

test("a redactor that throws drops the value it could not clear rather than passing it through", () => {
  const brief = buildVoiceBrief({
    persona: "Your key is sk-live-0001.",
    facts: ["keep nothing"],
    entries: [said("use sk-live-0001", 10)],
    redact: () => { throw new Error("the secret store is unreadable"); },
  });
  assert.equal(brief.persona, "");
  assert.deepEqual(brief.facts, []);
  assert.deepEqual(brief.recent, []);
});

// ------------------------------------------------------- the wiring: what the gateway actually asks

/** Only the slice of the session store this read touches. */
function fakeStore({ profile = null, entries = [], tailQueries = [] } = {}) {
  return {
    getAgentProfileText: (id) => (id === "a1" ? profile : null),
    readAgentTranscriptTail: (id, query) => { tailQueries.push({ id, query }); return { entries }; },
    // setMemory hands the service down to the store as well as keeping it on the manager.
    setMemory: () => {},
  };
}

test("an unknown agent answers null, which is what makes the gateway answer {brief: null}", async () => {
  const manager = new TranscriptManager(fakeStore({ profile: { name: "Titan", description: "You run the shop." } }), {}, {});
  assert.equal(await manager.getVoiceBrief("nobody"), null);
  assert.equal(await manager.getVoiceBrief(""), null);
  assert.equal(await manager.getVoiceBrief(null), null);
});

test("the persona is the agent's own profile description, and the name comes with it", async () => {
  const manager = new TranscriptManager(
    fakeStore({ profile: { name: "Titan", description: "You run a two-person managed services shop." } }),
    {}, {},
  );
  const brief = await manager.getVoiceBrief("a1", { workspaceName: "acme" });
  assert.equal(brief.persona, "You run a two-person managed services shop.");
  assert.equal(brief.agentName, "Titan");
  assert.equal(brief.workspaceName, "acme");
});

test("a box holding NO memory service answers a brief with no facts, not an error", async () => {
  // NO_MEMORY is what `this.memory` is until setMemory runs, and its list() answers []. A box mid-boot
  // or one built without the memory extension must still be able to put a voice on the phone.
  const manager = new TranscriptManager(fakeStore({ profile: { name: "Titan", description: "You run the shop." } }), {}, {});
  const brief = await manager.getVoiceBrief("a1");
  assert.deepEqual(brief.facts, []);
  assert.equal(brief.persona, "You run the shop.");
});

test("the facts are the same list getAgentMemories serves, in the order the store hands them out", async () => {
  const manager = new TranscriptManager(fakeStore({ profile: { name: "Titan", description: "You run the shop." } }), {}, {});
  manager.setMemory({
    list: ({ agentId }) => (agentId === "a1"
      ? [{ id: "m1", content: "the gate runs on the R750", createdAt: 1, kind: "profile" },
        { id: "m2", content: "Richard is the partner", createdAt: 2, kind: "log" }]
      : []),
  });
  const brief = await manager.getVoiceBrief("a1");
  assert.deepEqual(brief.facts, ["the gate runs on the R750", "Richard is the partner"]);
});

test("a memory service that throws costs the brief its facts and not the call", async () => {
  const manager = new TranscriptManager(fakeStore({ profile: { name: "Titan", description: "You run the shop." } }), {}, {});
  manager.setMemory({ list: () => { throw new Error("the memory directory is gone"); } });
  const brief = await manager.getVoiceBrief("a1");
  assert.deepEqual(brief.facts, []);
  assert.equal(brief.persona, "You run the shop.");
});

test("the conversation is read off the same transcript tail the relay already polls", async () => {
  const tailQueries = [];
  const manager = new TranscriptManager(
    fakeStore({
      profile: { name: "Titan", description: "You run the shop." },
      entries: [said("what is the gate doing", 10), replied("two legs are red", 20)],
      tailQueries,
    }),
    {}, {},
  );
  const brief = await manager.getVoiceBrief("a1");
  assert.deepEqual(brief.recent, [
    { role: "person", text: "what is the gate doing", at: 10 },
    { role: "agent", text: "two legs are red", at: 20 },
  ]);
  assert.equal(tailQueries.length, 1);
  assert.equal(tailQueries[0].id, "a1");
  // A window wide enough to find twenty TURNS in a conversation that is mostly neither.
  assert.equal(tailQueries[0].query.limit, VOICE_BRIEF_TAIL_LIMIT);
});

test("a conversation store that throws costs the brief its turns and not the call", async () => {
  const manager = new TranscriptManager(
    {
      getAgentProfileText: () => ({ name: "Titan", description: "You run the shop." }),
      readAgentTranscriptTail: () => { throw new Error("the conversation store is being repaired"); },
    },
    {}, {},
  );
  const brief = await manager.getVoiceBrief("a1");
  assert.deepEqual(brief.recent, []);
  assert.equal(brief.persona, "You run the shop.");
});

test("the redactor the gateway hands in is the one that runs", async () => {
  const manager = new TranscriptManager(
    fakeStore({ profile: { name: "Titan", description: "Your key is sk-live-0001." } }),
    {}, {},
  );
  const brief = await manager.getVoiceBrief("a1", { redact: (value) => value.replaceAll("sk-live-0001", "[redacted]") });
  assert.equal(brief.persona, "Your key is [redacted].");
});
