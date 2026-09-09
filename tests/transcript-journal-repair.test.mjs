// BOX-6b. The conversation store repair, over the shipped files rather than a copy of them.
//
// WHAT THIS ROW IS ABOUT, measured on the R750 demo box titanbot-box-atonqjq7zx593jsacaccpfau
// 2026-09-09: the demo tenant's Titan had failed every turn since 2026-09-07 23:00:44Z with
// "transcript checkpoint must recover before preparing", 18 times in one host log, and nothing on
// disk was damaged. Both databases passed integrity_check, there was no quarantine anywhere, and
// the whole transcript directory held a single 2-byte `<id>.journal-mode` marker. The conversation
// file had never been written, because the only thing that writes it is a recovery, and no code
// path on a production turn could ask for one.
//
// So the shape under test is the marker with no conversation file, not a corrupt database. The
// second shape (a stale write-ahead copy that matches nothing) is here too, because that is what
// the repair has to set aside rather than delete, and the third is a recovery that cannot succeed:
// it must latch, fail the turn once, and NOT try again on every following turn.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".transcript-repair-"));
after(() => rmSync(stage, { recursive: true, force: true }));

const sandRoot = mkdtempSync(path.join(os.tmpdir(), "sand-transcript-repair-"));
after(() => rmSync(sandRoot, { recursive: true, force: true }));
process.env.SAND_DATA_ROOT = sandRoot;

const load = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
  });
  const file = path.join(stage, `${name}.cjs`);
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return createRequire(import.meta.url)(file);
};

const mirrorModule = await load("source/host/transcript-mirror/transcript-mirror.ts", "transcript-mirror");
const repairModule = await load("source/host/transcript-mirror/transcript-journal-repair.ts", "transcript-journal-repair");
const failedEntry = await load("source/host/extensions/transcript/turn-failed-entry.ts", "turn-failed-entry");
const verbModule = await load("source/host/extensions/transcript/repair-agent-transcript.ts", "repair-agent-transcript");

const CTX = {};
const STORE = { async getBlob() { return new Uint8Array([1]); } };
const CHECKPOINT = { turns: [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)] };

const lineFor = (index) => JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `turn ${index}` }] } });

function countingDeriver(options = {}) {
  const calls = { initial: 0, derive: 0 };
  return {
    calls,
    async initial(_ctx, _store, checkpoint) {
      calls.initial += 1;
      if (options.initialThrows === true) throw new Error("the conversation blobs are not readable");
      return checkpoint.turns.map((_turn, index) => ({ id: `t${index}`, line: lineFor(index) }));
    },
    async derive(_ctx, _store, previous, checkpoint) {
      calls.derive += 1;
      const occurrences = [];
      for (let index = previous.turns.length; index < checkpoint.turns.length; index += 1) {
        occurrences.push({ id: `t${index}`, line: lineFor(index) });
      }
      return { occurrences };
    },
  };
}

/** A conversation the journal already owns: the 2-byte mode marker, and nothing else. */
function claimedConversation(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const id = "c63fdce4-4fc0-4ea7-8a1b-93657df2c6c5";
  mkdirSync(path.join(dir, id), { recursive: true });
  writeFileSync(path.join(dir, id, `${id}.journal-mode`), "1\n", "utf8");
  return { transcriptsDir: dir, id, dirOf: (name) => path.join(dir, id, `${id}.${name}`) };
}

function routedMirror(transcriptsDir, deriver) {
  const journal = new mirrorModule.FileTranscriptMirror(transcriptsDir, () => {}, deriver);
  return { journal, routed: journal.routed({ async write() {} }, async () => true) };
}

/** The host log is where the gate on the box reads the counts, so capture it the same way. */
async function captureLog(run) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  try { return { result: await run(), lines }; }
  catch (error) { return { error, lines }; }
  finally { console.log = original; }
}

const entriesIn = (file) => readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);

test("a claimed conversation with no conversation file recovers itself and the prepare succeeds", async () => {
  const conversation = claimedConversation("sand-journal-marker");
  const deriver = countingDeriver();
  const { routed } = routedMirror(conversation.transcriptsDir, deriver);

  const { result, error, lines } = await captureLog(() =>
    routed.prepareCheckpoint(CTX, conversation.id, CHECKPOINT, STORE, false));
  assert.equal(error, undefined, `prepare should have recovered: ${error?.message ?? ""}`);
  assert.equal(result, undefined);

  const jsonl = conversation.dirOf("jsonl");
  assert.deepEqual(entriesIn(jsonl), [lineFor(0), lineFor(1), lineFor(2)]);
  assert.equal(deriver.calls.initial, 1, "the rebuild runs once, not once per attempt");

  const repaired = lines.find((line) => line.startsWith("[sand][transcript] repaired"));
  assert.ok(repaired, `expected one repair line, got ${JSON.stringify(lines)}`);
  assert.match(repaired, /0 entries before, 3 after/);
  // Nothing to set aside is the normal outcome: the one real case in production had no stale files.
  assert.match(repaired, /nothing set aside/);
  assert.equal(lines.filter((line) => line.startsWith("[sand][transcript]")).length, 1, "one line, not a stream");
});

test("a stale write-ahead copy is set aside, kept, and the entries already on disk survive", async () => {
  const conversation = claimedConversation("sand-journal-stale-wal");
  const deriver = countingDeriver();
  const jsonl = conversation.dirOf("jsonl");
  writeFileSync(jsonl, `${[lineFor(0), lineFor(1), lineFor(2)].join("\n")}\n`, "utf8");

  const hash = (seed) => seed.repeat(64).slice(0, 64);
  writeFileSync(conversation.dirOf("journal-pending.json"), JSON.stringify({
    version: 1,
    previousCheckpointHash: hash("a"),
    checkpointHash: hash("b"),
    appendOffset: 0,
    fileDevice: "1",
    fileInode: "2",
    lines: [lineFor(9)],
    cursor: { turnCount: 3 },
  }), "utf8");
  writeFileSync(conversation.dirOf("journal-cursor.json"), JSON.stringify({ turnIndex: 0, stepIndex: 0 }), "utf8");

  const { routed } = routedMirror(conversation.transcriptsDir, deriver);
  const { error, lines } = await captureLog(() =>
    routed.prepareCheckpoint(CTX, conversation.id, CHECKPOINT, STORE, false));
  assert.equal(error, undefined, `prepare should have recovered: ${error?.message ?? ""}`);

  const dir = path.join(conversation.transcriptsDir, conversation.id);
  const setAside = readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  assert.equal(setAside.length, 2, `expected the pending copy and its cursor kept, got ${JSON.stringify(readdirSync(dir))}`);
  assert.ok(setAside.some((name) => name.startsWith(`${conversation.id}.journal-pending.json.corrupt-`)));
  // Kept, not deleted: the file an operator may want to read is still there afterwards.
  assert.ok(readFileSync(path.join(dir, setAside[0]), "utf8").length > 0);

  assert.deepEqual(entriesIn(jsonl), [lineFor(0), lineFor(1), lineFor(2)], "no entry was lost");
  assert.equal(deriver.calls.initial, 0, "an intact conversation file is not rebuilt");
  assert.ok(lines.some((line) => /repaired the conversation store .*3 entries before, 3 after/.test(line)));
});

test("a recovery that cannot succeed latches, fails the turn once, and does not try again", async () => {
  const conversation = claimedConversation("sand-journal-hopeless");
  const deriver = countingDeriver({ initialThrows: true });
  const { routed } = routedMirror(conversation.transcriptsDir, deriver);

  const first = await captureLog(() => routed.prepareCheckpoint(CTX, conversation.id, CHECKPOINT, STORE, false));
  assert.ok(first.error, "the turn must fail rather than pretend");
  assert.equal(deriver.calls.initial, 1, "nothing was in the way, so there is no second attempt");
  assert.equal(
    failedEntry.plainWordsForTurnFailure(first.error),
    "the conversation store needs repair",
    "the person is told what to do, not that something went wrong",
  );
  assert.ok(first.lines.some((line) => line.startsWith("[sand][transcript] could not repair")));

  const need = JSON.parse(readFileSync(conversation.dirOf("journal-needs-repair.json"), "utf8"));
  assert.match(need.reason, /conversation blobs are not readable/);
  assert.ok(Date.parse(need.at) > 0);

  // The latch: every turn after this one fails fast, without another rebuild attempt.
  const second = await captureLog(() => routed.prepareCheckpoint(CTX, conversation.id, CHECKPOINT, STORE, false));
  assert.ok(second.error);
  assert.equal(deriver.calls.initial, 1, "a repair that retries its own failure spins for the life of the box");
  assert.equal(
    failedEntry.plainWordsForTurnFailure(second.error),
    "the conversation store needs repair",
  );
});

test("the repair reports the four fields and an untouched conversation reads already-healthy", async () => {
  const conversation = claimedConversation("sand-journal-healthy");
  writeFileSync(conversation.dirOf("jsonl"), `${[lineFor(0), lineFor(1), lineFor(2)].join("\n")}\n`, "utf8");
  const { journal } = routedMirror(conversation.transcriptsDir, countingDeriver());

  const report = await journal.repairConversation(CTX, conversation.id, CHECKPOINT, STORE);
  assert.deepEqual(
    { before: report.before, after: report.after, quarantined: report.quarantined, outcome: report.outcome },
    { before: 3, after: 3, quarantined: [], outcome: "already-healthy" },
  );
});

test("the verb returns the four fields, clears the latch, and writes exactly one ledger row", async (t) => {
  // The ledger path is resolved when the row is written, and other suites in this process move
  // SAND_DATA_ROOT for their own fixtures. Pin it for the length of this test and put it back.
  const previousRoot = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = sandRoot;
  t.after(() => { if (previousRoot == null) delete process.env.SAND_DATA_ROOT; else process.env.SAND_DATA_ROOT = previousRoot; });

  const agentId = "c63fdce4-4fc0-4ea7-8a1b-93657df2c6c5";
  const agentDir = path.join(sandRoot, "agents", agentId);
  const transcriptsDir = path.join(sandRoot, "agent-transcripts");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(path.join(transcriptsDir, agentId), { recursive: true });
  const at = (name) => path.join(transcriptsDir, agentId, `${agentId}.${name}`);
  writeFileSync(at("journal-mode"), "1\n", "utf8");
  writeFileSync(at("jsonl"), `${[lineFor(0), lineFor(1)].join("\n")}\n`, "utf8");
  writeFileSync(at("journal-pending.json"), "{}", "utf8");
  await repairModule.writeTranscriptRepairNeed(transcriptsDir, agentId, "the conversation blobs are not readable");

  const lines = [];
  const result = await verbModule.repairAgentTranscript({ agentId, agentDir, log: (line) => lines.push(line) });

  assert.equal(result.agentId, agentId);
  assert.equal(result.before, 2);
  assert.equal(result.after, 2, "the verb never rewrites the conversation file, so no entry can be lost");
  assert.equal(result.quarantined.length, 1);
  assert.match(result.quarantined[0], /journal-pending\.json\.corrupt-/);
  assert.equal(result.outcome, "recovered");
  assert.ok(result.reason.length > 0);
  assert.equal(lines.length, 1, "one line in the host log, in plain words");
  assert.doesNotMatch(lines[0], /Error|Transcript[A-Z]/, "no class names in what a person reads");

  // The latch is gone, so the next message runs the recovery again.
  assert.equal(await repairModule.readTranscriptRepairNeed(transcriptsDir, agentId), null);
  // And the mode marker is still there: removing it would move the conversation to the old writer.
  assert.ok(readdirSync(path.join(transcriptsDir, agentId)).includes(`${agentId}.journal-mode`));

  const ledger = path.join(agentDir, "audit.jsonl");
  let rows = [];
  for (let attempt = 0; attempt < 100 && rows.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    try { rows = entriesIn(ledger); } catch { rows = []; }
  }
  assert.equal(rows.length, 1, "one receipt for one repair");
  const row = JSON.parse(rows[0]);
  assert.equal(row.type, "transcript_repair");
  assert.equal(row.agentId, agentId);
  assert.equal(row.outcome, "recovered");
  assert.equal(row.before, 2);
  assert.equal(row.after, 2);
  assert.ok(typeof row.eventId === "string" && row.eventId.length > 0);
});

// Measured on grok-bot-local-vm 2026-09-09: the first cut of the verb ran REINDEX on the agent's
// databases unconditionally and read its own success as evidence of damage, so a store with nothing
// wrong with it came back "recovered". On the demo tenant's box that is 157 MB of conversation
// blobs rebuilt on every press of Repair, to report a repair that did not happen.
test("a conversation with nothing wrong reads already-healthy, and no database is touched", async (t) => {
  const previousRoot = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = sandRoot;
  t.after(() => { if (previousRoot == null) delete process.env.SAND_DATA_ROOT; else process.env.SAND_DATA_ROOT = previousRoot; });

  const agentId = "5d166033-0000-4000-8000-000000000001";
  const agentDir = path.join(sandRoot, "agents", agentId);
  const transcriptsDir = path.join(sandRoot, "agent-transcripts");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(path.join(transcriptsDir, agentId), { recursive: true });
  writeFileSync(path.join(transcriptsDir, agentId, `${agentId}.journal-mode`), "1\n", "utf8");
  writeFileSync(path.join(transcriptsDir, agentId, `${agentId}.jsonl`), `${lineFor(0)}\n`, "utf8");

  const result = await verbModule.repairAgentTranscript({ agentId, agentDir, log: () => {} });
  assert.equal(result.outcome, "already-healthy");
  assert.equal(result.before, 1);
  assert.equal(result.after, 1);
  assert.deepEqual(result.quarantined, []);
  // A missing database must not be conjured into existence by the readable test.
  assert.deepEqual(readdirSync(agentDir).filter((name) => name.endsWith(".db")), []);
});

test("an unknown agent id is refused rather than resolved to a path", async () => {
  const result = await verbModule.repairAgentTranscript({ agentId: "../../etc" });
  assert.equal(result.outcome, "needs-attention");
  assert.equal(result.reason, "that is not an agent this box knows");
});

// ================================================================================================
// The review's blocker, pinned. Pressing Repair used to rename ANY <id>.journal-pending.json to
// .corrupt-<stamp> without reading it, so a press during a live turn threw away the turn that WAL
// was holding and the console reported it as "kept". Measured on this Mac before the fix: a
// 3-line conversation came back 2 lines and the verb answered before 2, after 2, "recovered".
// ================================================================================================

test("a write-ahead copy that parses is left where it is, so the turn it holds still lands", async () => {
  const conversation = claimedConversation("sand-journal-live-wal");
  const deriver = countingDeriver();
  const { journal } = routedMirror(conversation.transcriptsDir, deriver);
  const TWO = { turns: [Uint8Array.of(1), Uint8Array.of(2)] };

  // Two durable lines, then a third turn prepared and NOT yet committed: a real pending WAL.
  await journal.recover(CTX, conversation.id, TWO, STORE);
  await journal.prepareCheckpoint(CTX, conversation.id, CHECKPOINT, STORE, false);
  const jsonl = conversation.dirOf("jsonl");
  assert.equal(entriesIn(jsonl).length, 2, "the third line is in the write-ahead copy, not the file yet");

  const report = await repairModule.repairTranscriptFiles({
    transcriptsDir: conversation.transcriptsDir,
    conversationId: conversation.id,
    log: () => {},
  });
  assert.deepEqual(report.quarantined, [], "a valid write-ahead copy is not damage and is not moved");
  assert.equal(report.outcome, "already-healthy");

  const dir = path.join(conversation.transcriptsDir, conversation.id);
  assert.equal(readdirSync(dir).filter((name) => name.includes(".corrupt-")).length, 0);

  // A fresh mirror, the way a restarted host meets it: the pending copy replays and the line lands.
  const next = routedMirror(conversation.transcriptsDir, countingDeriver());
  await next.journal.recover(CTX, conversation.id, CHECKPOINT, STORE);
  assert.equal(entriesIn(jsonl).length, 3, "the turn the write-ahead copy was holding reached the file");
});

test("a write-ahead copy that cannot be parsed is still set aside", async () => {
  const conversation = claimedConversation("sand-journal-broken-wal");
  writeFileSync(conversation.dirOf("jsonl"), `${lineFor(0)}\n`, "utf8");
  writeFileSync(conversation.dirOf("journal-pending.json"), "{ not json", "utf8");

  const report = await repairModule.repairTranscriptFiles({
    transcriptsDir: conversation.transcriptsDir,
    conversationId: conversation.id,
    log: () => {},
  });
  assert.equal(report.quarantined.length, 1);
  assert.match(report.quarantined[0], /journal-pending\.json\.corrupt-/);
  assert.equal(report.outcome, "recovered");
  assert.equal(report.after, 1, "the conversation file is never rewritten by the on-demand repair");
});

test("clearing the stuck state answers cleared, not repaired, and the second clear is refused", async () => {
  const conversation = claimedConversation("sand-journal-latch-only");
  const reason = "the conversation blobs are not readable";
  await repairModule.writeTranscriptRepairNeed(conversation.transcriptsDir, conversation.id, reason);

  const lines = [];
  const first = await repairModule.repairTranscriptFiles({
    transcriptsDir: conversation.transcriptsDir,
    conversationId: conversation.id,
    log: (line) => lines.push(line),
  });
  assert.equal(first.outcome, "cleared", "nothing was repaired, so it must not say recovered");
  assert.equal(first.reason, reason, "the console needs the original reason to print it");
  assert.equal(await repairModule.readTranscriptRepairNeed(conversation.transcriptsDir, conversation.id), null);
  assert.ok(lines.some((line) => /cleared the stuck state on the conversation store/.test(line)));

  // The next message fails the same way and latches again. The clear count survives the clearing.
  await repairModule.writeTranscriptRepairNeed(conversation.transcriptsDir, conversation.id, reason);
  const again = await repairModule.readTranscriptRepairNeed(conversation.transcriptsDir, conversation.id);
  assert.equal(again.clears, 1, "the marker remembers that a person already cleared it once");

  const second = await repairModule.repairTranscriptFiles({
    transcriptsDir: conversation.transcriptsDir,
    conversationId: conversation.id,
    log: () => {},
  });
  assert.equal(second.outcome, "needs-attention", "a second clear would be a loop with a green tick");
  assert.match(second.reason, /cleared once already/);
  assert.match(second.reason, /conversation blobs are not readable/);
  assert.ok(await repairModule.readTranscriptRepairNeed(conversation.transcriptsDir, conversation.id) != null,
    "the state stays on, because it is true");
});

test("a recovery that works forgets the clear count, so the next episode gets its clear back", async () => {
  const conversation = claimedConversation("sand-journal-history-reset");
  await repairModule.writeTranscriptRepairNeed(conversation.transcriptsDir, conversation.id, "something old");
  await repairModule.clearTranscriptRepairNeed(conversation.transcriptsDir, conversation.id);

  const { routed } = routedMirror(conversation.transcriptsDir, countingDeriver());
  const { error } = await captureLog(() => routed.prepareCheckpoint(CTX, conversation.id, CHECKPOINT, STORE, false));
  assert.equal(error, undefined, `prepare should have recovered: ${error?.message ?? ""}`);

  await repairModule.writeTranscriptRepairNeed(conversation.transcriptsDir, conversation.id, "something new");
  const need = await repairModule.readTranscriptRepairNeed(conversation.transcriptsDir, conversation.id);
  assert.equal(need.clears, 0, "the recovery ended the old episode, so the count went with it");
});

test("the stuck state still lands when the conversation directory cannot be written", async (t) => {
  const conversation = claimedConversation("sand-journal-unwritable");
  const dir = path.join(conversation.transcriptsDir, conversation.id);
  chmodSync(dir, 0o500);
  t.after(() => { try { chmodSync(dir, 0o700); } catch { /* already gone */ } });

  await repairModule.writeTranscriptRepairNeed(conversation.transcriptsDir, conversation.id, "the directory is read-only");
  const need = await repairModule.readTranscriptRepairNeed(conversation.transcriptsDir, conversation.id);
  assert.ok(need != null, "a latch that cannot be written is a turn that fails for ever with no pill");
  assert.equal(need.reason, "the directory is read-only");
  // Beside the transcripts directory, not inside the one that refused the write.
  assert.ok(readdirSync(conversation.transcriptsDir).some((name) => name.endsWith(".journal-needs-repair.json")));

  chmodSync(dir, 0o700);
  const report = await repairModule.repairTranscriptFiles({
    transcriptsDir: conversation.transcriptsDir,
    conversationId: conversation.id,
    log: () => {},
  });
  assert.equal(report.outcome, "cleared");
  assert.equal(await repairModule.readTranscriptRepairNeed(conversation.transcriptsDir, conversation.id), null);
});
