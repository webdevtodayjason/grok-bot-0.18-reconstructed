/**
 * VOICE-16c, the host's half: a note filed into an agent's conversation with NO turn run for it.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and it is not the arithmetic. VOICE-16 ends every voice call by
 * writing the whole spoken exchange into the agent's conversation, and it had exactly one verb to
 * write it with: `sendPrompt`, which runs a turn. docs/VOICE-16-REPORT.md records the measurement that
 * no flag on it means "remember this, do not answer it", so the note asked in its own first two
 * sentences and the agent was free to answer anyway. Five notes went out on the night of 2026-09-12.
 *
 * So the two ways to get THIS wrong are both worse than the bug it fixes. Write the wrong SHAPE of row
 * and the note is invisible: the console drops an entry kind it does not know one function before the
 * renderer (UX-ERR-1 is the tracker row where a failed turn showed nothing for exactly that reason),
 * and `send-turn-dispatch.ts`'s `recentUserMessages` filter drops a row that carries `fromAgent` or
 * `channel`, which is what would put the note out of the agent's reach forever. Write it to the wrong
 * STORE and one person's call transcript lands in another person's conversation.
 *
 * The load-bearing tests are therefore: the shape is the send pipeline's own user message; the row a
 * turn would pick up is the row this writes, proven against the real `selectUnconfirmedUserMessages`
 * the runner prepends with; and the on-screen guard is the send pipeline's two-part one and not the
 * automation path's one-part one.
 *
 * THREE BUNDLES, ON PURPOSE. transcript-note.ts is pure, so the shape, the cap and the dedupe are
 * pinned with no box, no filesystem and no clock. transcript-manager.ts driven against a fake session
 * store is the only way to prove what the wiring decides. And conversation-state.ts is bundled because
 * the claim "it is in Titan's context for his next real turn" is a claim about somebody else's code,
 * and asserting it against a copy of that code would prove nothing.
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
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".voice-note-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));

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
  MAX_TRANSCRIPT_NOTE_CHARS,
  findNoteByClientNonce,
  planTranscriptNote,
} = await bundled("source/host/extensions/transcript/transcript-note.ts", "transcript-note.cjs");

const { TranscriptManager } = await bundled(
  "source/host/extensions/transcript/transcript-manager.ts",
  "transcript-manager.cjs",
);

const { selectUnconfirmedUserMessages } = await bundled(
  "source/host/runner/conversation-state.ts",
  "conversation-state.cjs",
);

/** A row the person typed, as the send pipeline writes it. */
const typed = (id, content, timestampMs = 10) => ({
  kind: "message", id, role: "user", content, isStreaming: false, timestampMs,
});
/** A row the agent actually delivered. */
const sent = (id, content, timestampMs = 20) => ({
  kind: "send-message", id, message: { type: "text", content }, timestampMs,
});

// ---- the shape, with no box ----------------------------------------------------------------------

test("a note is the SAME row the send pipeline writes for a typed message, field for field", () => {
  const { entry } = planTranscriptNote({ entries: [], text: "Voice call. Them: hello.", at: 1_700_000_000_000 });
  assert.equal(entry.kind, "message");
  assert.equal(entry.role, "user");
  assert.equal(entry.content, "Voice call. Them: hello.");
  assert.equal(entry.isStreaming, false);
  assert.equal(entry.timestampMs, 1_700_000_000_000);
  // THE TWO ABSENCES ARE THE LOAD-BEARING PART. send-turn-dispatch.ts builds the next turn's
  // recentUserMessages by filtering for `fromAgent == null && channel == null`; a row carrying either
  // is a row the agent never sees. An agent-to-agent message carries fromAgent, which is why it is
  // NOT the shape to copy here even though it is the closest-looking one.
  assert.equal(entry.fromAgent, undefined, "a note is the person's own row and not another agent's");
  assert.equal(entry.channel, undefined, "and it did not come in over a channel");
});

test("`at` is the row's timestamp and never the composed-offline marker", () => {
  // createUserMessage's composedAtMs option sets the timestamp AND stamps sentWhileOfflineAtMs, which
  // send-turn-dispatch turns into a "you composed this while offline" preamble. A call that ended a
  // second ago was not composed offline, so the timestamp is set over the built row instead.
  const { entry } = planTranscriptNote({ text: "Voice call.", at: 1_700_000_000_000 });
  assert.equal(entry.timestampMs, 1_700_000_000_000);
  assert.equal(entry.sentWhileOfflineAtMs, undefined);
  // And a missing or nonsense stamp leaves the row with a real time rather than 1970.
  const now = Date.now();
  for (const at of [0, -1, Number.NaN, undefined]) {
    const row = planTranscriptNote({ text: "Voice call.", at }).entry;
    assert.ok(row.timestampMs >= now, `at=${String(at)} produced ${row.timestampMs}`);
    assert.equal(row.sentWhileOfflineAtMs, undefined);
  }
});

test("the id is the next one in the conversation's own sequence, so nothing downstream can tell it apart", () => {
  assert.equal(planTranscriptNote({ entries: [], text: "one" }).entry.id, "t0u");
  const after = planTranscriptNote({
    entries: [typed("t0u", "what is the gate doing"), sent("t0s0", "two legs are red")],
    text: "Voice call.",
  });
  assert.equal(after.entry.id, "t1u");
});

test("nothing was said, so nothing is planned -- an empty row reads as a call where the person was ignored", () => {
  assert.equal(planTranscriptNote({ text: "" }).entry, null);
  assert.equal(planTranscriptNote({ text: "   \n  " }).entry, null);
  assert.equal(planTranscriptNote().entry, null);
});

test("a note over the ceiling is REFUSED and both numbers are named, never stored short", () => {
  // A half a note read back as the record of a call is worse than no note: nobody can tell which half
  // is missing. The relay's own cap is 6 KB, so in the intended use this never bites; it is here
  // because a gateway write with no ceiling is how one wedged caller fills somebody's transcript.
  const tooBig = "x".repeat(MAX_TRANSCRIPT_NOTE_CHARS + 1);
  assert.throws(
    () => planTranscriptNote({ text: tooBig }),
    (error) => error.message.includes(String(MAX_TRANSCRIPT_NOTE_CHARS)) && error.message.includes(String(tooBig.length)),
  );
  // And exactly at the ceiling is allowed, because a cap that refuses its own limit is off by one.
  assert.ok(planTranscriptNote({ text: "x".repeat(MAX_TRANSCRIPT_NOTE_CHARS) }).entry != null);
});

test("a note already in the conversation under this nonce is found, and nothing plans a second copy", () => {
  const first = planTranscriptNote({ entries: [], text: "Voice call.", clientNonce: "voice:s1:note" });
  assert.equal(first.entry.clientNonce, "voice:s1:note");
  const again = planTranscriptNote({ entries: [first.entry], text: "Voice call.", clientNonce: "voice:s1:note" });
  assert.equal(again.entry, null);
  assert.equal(again.duplicateOf, first.entry.id);
});

test("a note with NO nonce is never treated as a duplicate of another, because it has nothing to match on", () => {
  const first = planTranscriptNote({ entries: [], text: "Voice call one." });
  const second = planTranscriptNote({ entries: [first.entry], text: "Voice call two." });
  assert.equal(second.duplicateOf, null);
  assert.equal(second.entry.id, "t1u");
  assert.equal(findNoteByClientNonce([first.entry], ""), null);
  assert.equal(findNoteByClientNonce([first.entry], "   "), null);
});

test("the nonce is only read off the person's own rows, not off whatever else carries one", () => {
  // Every send carries a clientNonce, the agent's deliveries included. A scan that matched any row
  // would read the nonce of the turn the note rode in on and refuse to write the note.
  const delivery = { ...sent("t0s0", "two legs are red"), clientNonce: "voice:s1:note" };
  assert.equal(findNoteByClientNonce([delivery], "voice:s1:note"), null);
  assert.equal(planTranscriptNote({ entries: [delivery], text: "Voice call.", clientNonce: "voice:s1:note" }).entry != null, true);
});

// ---- the claim that makes a row with no turn worth writing ---------------------------------------

test("a user row with no turn of its own IS prepended to the next real turn, which is what puts the note in context", () => {
  // This is the mechanism the whole command rests on, and it belongs to somebody else's code, so it is
  // asserted against that code and not a copy of it. send-turn-dispatch.ts hands runTurn the agent's
  // own user rows; shell-terminal-watch.ts's collectPrependUserMessages runs exactly this selection
  // over them against the runner's confirmed-user-turn watermark, and every row it returns becomes a
  // UserMessage prepended to the turn's prompt.
  const note = planTranscriptNote({ entries: [typed("t0u", "morning")], text: "Voice call. Them: hello.", at: 5 }).entry;
  const next = planTranscriptNote({ entries: [typed("t0u", "morning"), note], text: "so what did we decide", at: 6 }).entry;
  const recentUserMessages = [typed("t0u", "morning"), note, next]
    // The filter send-turn-dispatch.ts applies, by its own four conditions.
    .filter((entry) => entry.kind === "message" && entry.role === "user" && entry.fromAgent == null && entry.channel == null)
    .map((entry) => ({ id: entry.id, text: entry.content }));
  assert.equal(recentUserMessages.length, 3, "the note is in the list a real turn is built from");
  const selected = selectUnconfirmedUserMessages({
    recentUserMessages,
    currentMessageId: next.id,
    lastTurnUserMessageId: "t0u",
    hasConfirmedTurns: true,
  });
  assert.deepEqual(selected.map((message) => message.id), [note.id]);
  assert.equal(selected[0].text, "Voice call. Them: hello.");
});

// ---- the wiring: which store, and who is told ----------------------------------------------------

function fakeDb(entries = [], { durable = true } = {}) {
  const rows = [...entries];
  return {
    rows,
    getTranscriptEntries: () => [...rows],
    appendTranscriptEntry: (entry) => { if (durable) rows.push(entry); return durable; },
  };
}

/**
 * A manager holding ONE live session, with the roster's two outbound calls recorded.
 *
 * The roster is spied rather than driven because what is at stake is whether the console is told at
 * all and with which agent's name on it, not how the projection coalesces; and a real emit on a fake
 * store drags the whole boot path into a unit test and logs its own failures to the console, which
 * reads as a failing test to anybody scrolling past.
 */
function openManager({ entries = [], exists = () => true, durable = true } = {}) {
  const activity = [];
  const store = {
    agentExists: (id) => exists(id),
    markSessionActivity: (session) => activity.push(session.id),
    setMemory: () => {},
  };
  const manager = new TranscriptManager(store, {}, {});
  const db = fakeDb(entries, { durable });
  const session = { id: "a1", dbPath: "/tmp/a1/store.db", db };
  manager.sessions.liveSessions.set("a1", session);
  const emitted = [];
  const updated = [];
  manager.roster.emit = (event, owningAgentId) => emitted.push({ event, owningAgentId });
  manager.roster.emitAgentUpdate = async (agentId) => { updated.push(agentId); };
  return { manager, session, db, emitted, updated, activity };
}

test("a note for a conversation nobody is looking at goes to THAT agent's store, and the console is told with its name on it", async () => {
  const { manager, db, emitted, updated, activity } = openManager({ entries: [typed("t0u", "morning")] });
  const answer = await manager.appendTranscriptNote("a1", { text: "Voice call. Them: hello.", at: 1_700_000_000_000, clientNonce: "voice:s1:note" });
  assert.deepEqual(answer, { filed: true, entryId: "t1u", duplicate: false });
  assert.equal(db.rows.length, 2);
  assert.equal(db.rows[1].content, "Voice call. Them: hello.");
  assert.equal(db.rows[1].role, "user");
  // The entry is ADDRESSED to its owning agent. emitAcceptedSendEchoes does the same thing for the
  // same reason: the console can be showing this conversation without it being the in-memory one, and
  // a roster update alone shows a changed preview with no row under it.
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event.type, "appended");
  assert.equal(emitted[0].event.entry.id, "t1u");
  assert.equal(emitted[0].owningAgentId, "a1");
  assert.deepEqual(updated, ["a1"]);
  assert.deepEqual(activity, ["a1"], "the conversation moved, so the roster says it moved");
});

test("a note for the conversation ON SCREEN joins the transcript the person is reading, and the active store", async () => {
  const { manager, session, db, emitted } = openManager({ entries: [typed("t0u", "morning")] });
  manager.sessions.activeSession = session;
  manager.sessions.setActiveTranscript("a1", db.getTranscriptEntries());
  const answer = await manager.appendTranscriptNote("a1", { text: "Voice call. Them: hello.", at: 1_700_000_000_000 });
  assert.equal(answer.filed, true);
  assert.equal(manager.sessions.getEntries().at(-1).content, "Voice call. Them: hello.", "the row the person is reading");
  assert.equal(db.rows.at(-1).content, "Voice call. Them: hello.", "and the row that survives a restart");
  assert.equal(emitted.length, 1, "one appended event and not two");
  assert.equal(emitted[0].event.type, "appended");
});

test("the on-screen guard is the SEND PIPELINE's two-part one, so a note cannot land in another agent's open transcript", async () => {
  // sessions.appendEntry writes through the module-global in-memory transcript and persists to
  // activeSession.db. It is only correct for the agent whose conversation is BOTH active and in
  // memory. automation-run-path.ts checks activeSession alone; send-pipeline's own isOnScreen checks
  // both, and this is the condition that decides which of the two this command copied.
  const { manager, session, db } = openManager({ entries: [] });
  manager.sessions.activeSession = session;
  // Active, but the page is holding somebody ELSE's transcript in memory.
  manager.sessions.setActiveTranscript("b2", [typed("t0u", "another person's conversation")]);
  await manager.appendTranscriptNote("a1", { text: "Voice call. Them: hello." });
  assert.equal(db.rows.length, 1, "the note reached a1's own store");
  assert.deepEqual(
    manager.sessions.getEntries().map((entry) => entry.content),
    ["another person's conversation"],
    "and not the transcript b2 is holding",
  );
});

test("an id this box does not hold THROWS, because a caller recording what a person said must not be told it worked", async () => {
  const { manager } = openManager({ exists: () => false });
  manager.sessions.liveSessions.clear();
  await assert.rejects(() => manager.appendTranscriptNote("gone", { text: "Voice call." }), /no longer exists/);
  await assert.rejects(() => manager.appendTranscriptNote("", { text: "Voice call." }), /needs an agent/);
  await assert.rejects(() => manager.appendTranscriptNote(null, { text: "Voice call." }), /needs an agent/);
});

test("a store that will not persist THROWS rather than reporting a note that is not there", async () => {
  const { manager, emitted } = openManager({ durable: false });
  await assert.rejects(() => manager.appendTranscriptNote("a1", { text: "Voice call." }), /could not persist/);
  assert.equal(emitted.length, 0, "and nothing told the console about a row that was not written");
});

test("the same note twice writes once, and the second answer names the row that is already there", async () => {
  const { manager, db, emitted } = openManager();
  const first = await manager.appendTranscriptNote("a1", { text: "Voice call.", clientNonce: "voice:s1:note" });
  const second = await manager.appendTranscriptNote("a1", { text: "Voice call.", clientNonce: "voice:s1:note" });
  assert.deepEqual(first, { filed: true, entryId: "t0u", duplicate: false });
  assert.deepEqual(second, { filed: false, entryId: "t0u", duplicate: true });
  assert.equal(db.rows.length, 1, "one call, one row");
  assert.equal(emitted.length, 1, "and the console was told once");
});

test("a call where nothing was said files nothing and tells nobody", async () => {
  const { manager, db, emitted, updated } = openManager();
  assert.deepEqual(
    await manager.appendTranscriptNote("a1", { text: "   " }),
    { filed: false, entryId: null, duplicate: false },
  );
  assert.equal(db.rows.length, 0);
  assert.equal(emitted.length, 0);
  assert.deepEqual(updated, []);
});

test("filing a note runs NO turn: nothing on this path reaches the send pipeline or a runner", async () => {
  // The whole point of the command. If this ever regresses, the symptom is the bug it was written to
  // fix -- a message nobody asked for after every voice call.
  const { manager } = openManager();
  let sends = 0;
  manager.sendPipeline.sendPrompt = async () => { sends += 1; };
  let runs = 0;
  manager.turnRuntime.runTurn = async () => { runs += 1; };
  await manager.appendTranscriptNote("a1", { text: "Voice call. Them: hello." });
  assert.equal(sends, 0, "no prompt");
  assert.equal(runs, 0, "no turn");
});
