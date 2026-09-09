// BOX-6b, the console half: the sentence, the pill, the control, and what the control says after.
//
// The failure this is about, measured on the demo tenant's box `titanbot-box-atonqjq7zx593jsacaccpfau`
// on 2026-09-09: agent c63fdce4-4fc0-4ea7-8a1b-93657df2c6c5 had failed EVERY turn since
// 2026-09-07 23:00Z with
//
//   [sand][turn] agent run failed for c63fdce4-… TranscriptJournalCorruptionError:
//   transcript checkpoint must recover before preparing
//
// and the console said, each time, "Titan could not finish that one. Ask again, or send the details
// to the developers." Asking again fails identically for ever, so that sentence sent a person to
// retry a thing that cannot work, eighteen times.
//
// Nothing here is a copy: every block is SLICED out of ui/machine-room/app.js and
// ui/machine-room/gateway-adapter.js and run. A copy would go on passing after the console changed,
// and the whole point of these cases is that the words a person reads are the words that shipped.
//
// What the browser gate proves instead, and why it is not duplicated here:
// scripts/verify-transcript-repair.mjs presses Repair at real screen coordinates in real Chrome
// (verify-ui-in-a-real-browser.md: a passing page.click() is not evidence a human can click).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(repoRoot, "ui/machine-room/app.js");
const adapterPath = path.join(repoRoot, "ui/machine-room/gateway-adapter.js");

const between = (source, startMark, endMark, what) => {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + 1);
  assert.ok(start >= 0 && end > start, `${what} must be findable`);
  return source.slice(start, end);
};

// The demo Titan's own error, word for word out of /tmp/sand-host.log on that box.
const DEMO_TITAN_ERROR = "TranscriptJournalCorruptionError: transcript checkpoint must recover before preparing";
const SENTENCE = "This agent's conversation store needs repair. Repair it from the agent's details panel.";

// ---- the shared predicate ----------------------------------------------------------------------

async function loadPredicate() {
  const source = await readFile(adapterPath, "utf8");
  const block = between(source, "  // ---- BOX-6b: a conversation store that needs repair", "  // ---- end BOX-6b", "the adapter's BOX-6b block");
  const global = {};
  const api = new Function("global", `${block}\nreturn { TRANSCRIPT_REPAIR_SENTENCE, transcriptRepairWordsSeen, repairFlagOf, repairWorked, repairCleared };`)(global);
  return { ...api, global };
}

// ---- statusOf, which carries the flag onto the roster record -------------------------------------

async function loadStatusOf({ attention = [] } = {}) {
  const source = await readFile(adapterPath, "utf8");
  const block = between(source, "  // ---- BOX-6b: a conversation store that needs repair", "  // ---- end BOX-6b", "the adapter's BOX-6b block");
  const body = between(source, "  function statusOf(agent) {", "\n  // The automation record carries", "statusOf");
  return new Function("global", "attentionIds", `${block}\n${body}\nreturn statusOf;`)({}, new Set(attention));
}

// ---- the tray narration, the line a person actually reads ----------------------------------------

async function loadReloadTrays({ trays = [], workers = [] } = {}) {
  const source = await readFile(adapterPath, "utf8");
  const block = between(source, "  // ---- BOX-6b: a conversation store that needs repair", "  // ---- end BOX-6b", "the adapter's BOX-6b block");
  const body = between(source, "    async function reloadTrays() {", "    // Every routine write re-reads", "reloadTrays");
  const state = { workers, rooms: [] };
  const failedTurnReports = [];
  // The whole predicate block is prepended rather than injected name by name: reloadTrays reaches
  // the sentence, the word test AND the remembered set, and a stub of any of the three would let
  // the narration go on passing after the predicate changed.
  const shared = {};
  const run = new Function(
    "global", "call", "state", "attentionIds", "reportedTrays", "awaiting", "keyOf", "timeOf", "failedTurnReports",
    `${block}\n${body}\nreturn reloadTrays;`,
  )(
    shared, async (method) => (method === "getTrays" ? trays : null),
    state, new Set(), new Set(), new Map(), (c) => `${c.kind}:${c.id}`, () => "now", failedTurnReports,
  );
  await run();
  return { state, failedTurnReports, shared };
}

// ---- the adapter's two doors ---------------------------------------------------------------------

async function loadRepairDoors({ answer = null, missing = false, thrown = null } = {}) {
  const source = await readFile(adapterPath, "utf8");
  // The doors reach the predicate block's `repairIds` and `repairWorked`, so both come from the
  // file rather than a stub: the clearing rule and the panel's wording must be judged by one
  // function, and a stub here would let them drift apart unnoticed.
  const predicate = between(source, "  // ---- BOX-6b: a conversation store that needs repair", "  // ---- end BOX-6b", "the adapter's BOX-6b block");
  const block = between(source, "      // ---------------------------------------------------------------- BOX-6b", "      // ---------------------------------------------------------------- FEEDBACK-1", "the adapter's repair doors");
  const asked = [];
  const tryCall = async (method, args) => {
    asked.push([method, args]);
    if (thrown) throw thrown;
    return missing ? null : answer;
  };
  const api = new Function("global", "tryCall", "commandMissing",
    `${predicate}\nreturn { doors: ({\n${block}\n}), shared: global.__transcriptRepair };`)({}, tryCall, () => missing);
  return { ...api.doors, shared: api.shared, asked };
}

// ---- app.js: the words a failed turn becomes -----------------------------------------------------

async function loadFailedTurnWords({ repairAvailable = true } = {}) {
  const source = await readFile(appPath, "utf8");
  const adapterSource = await readFile(adapterPath, "utf8");
  const block = between(adapterSource, "  // ---- BOX-6b: a conversation store that needs repair", "  // ---- end BOX-6b", "the adapter's BOX-6b block");
  const shared = {};
  new Function("global", block)(shared);
  const body = between(source, "  // BOX-6b. A failed turn is not always \"ask again\".", "  function drainFailedTurnOffers() {", "failedTurnWords");
  // The page reads the predicate off `window`. A page with no adapter block on it -- the offline
  // demo -- must still produce the old words rather than throwing, which is what this switch pins.
  const win = repairAvailable ? { __transcriptRepair: shared.__transcriptRepair } : {};
  return new Function("window", `${body}\nreturn failedTurnWords;`)(win);
}

// ---- app.js: the pill ----------------------------------------------------------------------------

async function loadPill() {
  const source = await readFile(appPath, "utf8");
  const escaper = between(source, "  function escapeHtml(value) {", "  function sameContext(", "escapeHtml");
  const body = between(source, "  // ---- BOX-6b: an agent whose conversation store needs repair", "  // ---- end BOX-6b", "the pill block");
  return new Function(`${escaper}\n${body}\nreturn { needsRepair, needsRepairPillMarkup };`)();
}

// ---- app.js: the panel section and what Repair says after -----------------------------------------

async function loadPanel({ adapter = {} } = {}) {
  const source = await readFile(appPath, "utf8");
  const escaper = between(source, "  function escapeHtml(value) {", "  function sameContext(", "escapeHtml");
  const pill = between(source, "  // ---- BOX-6b: an agent whose conversation store needs repair", "  // ---- end BOX-6b", "the pill block");
  const body = between(source, "  function agentProfilePanel(worker) {", "\n  // The two async fills the panel above leaves placeholders for.", "agentProfilePanel");
  return new Function(
    "adapter", "modelById", "routinesForContext", "avatarMarkup", "statusClass",
    `${escaper}\n${pill}\n${body}\nreturn agentProfilePanel;`,
  )(adapter, () => ({ name: "gate-model" }), () => [], () => "", () => "ready");
}

async function loadRepairPress({ adapter = {}, worker = null } = {}) {
  const source = await readFile(appPath, "utf8");
  const adapterSource = await readFile(adapterPath, "utf8");
  // The panel's wording asks the ADAPTER whether the repair worked. That judge comes out of the
  // adapter file here, not a stub, because it is the same one the adapter uses to decide whether
  // to drop the pill: if the two ever disagreed, the button and the roster would say different
  // things about one press.
  const predicate = between(adapterSource, "  // ---- BOX-6b: a conversation store that needs repair", "  // ---- end BOX-6b", "the adapter's BOX-6b block");
  const shared = {};
  new Function("global", predicate)(shared);
  const body = between(source, "  // ---- BOX-6b: pressing Repair", "  // ---- end BOX-6b", "the press block");
  const said = [];
  const note = { hidden: true, set textContent(value) { said.push(value); }, get textContent() { return said.at(-1) ?? ""; } };
  const elements = { panelContent: { querySelector: (sel) => (sel === "[data-repair-note]" ? note : null) } };
  const rendered = { roster: 0, header: 0 };
  const api = new Function(
    "window", "adapter", "elements", "workerById", "contextRecord", "renderRoster", "renderConversationHeader",
    `${body}\nreturn { repairTranscriptFromPanel, repairOutcomeWords };`,
  )(
    { __transcriptRepair: shared.__transcriptRepair }, adapter, elements, () => worker, () => worker,
    () => { rendered.roster += 1; }, () => { rendered.header += 1; },
  );
  return { ...api, said, note, rendered };
}

const button = () => ({
  disabled: false, textContent: "Repair", removed: false,
  remove() { this.removed = true; },
});

// ==================================================================================================
// The predicate
// ==================================================================================================

test("BOX-6b: the predicate fires on the demo Titan's own error, word for word", async () => {
  const { transcriptRepairWordsSeen, TRANSCRIPT_REPAIR_SENTENCE } = await loadPredicate();
  assert.equal(TRANSCRIPT_REPAIR_SENTENCE, SENTENCE, "the sentence is the one the brief asked for, exactly");
  assert.equal(transcriptRepairWordsSeen("Agent failed to respond", DEMO_TITAN_ERROR), true);
  // The other half of what the box says about the same failure.
  assert.equal(transcriptRepairWordsSeen(DEMO_TITAN_ERROR, null), true);
  assert.equal(transcriptRepairWordsSeen(null, "transcript checkpoint must recover before preparing"), true);
});

test("BOX-6b: BOX-6's own sqlite damage counts too, and an ordinary failure does not", async () => {
  const { transcriptRepairWordsSeen } = await loadPredicate();
  // BOX-6's shape. The host's turn-failed classifier already names it; the console must agree.
  for (const said of [
    "database disk image is malformed",
    "SQLITE_CORRUPT: database disk image is malformed",
    "file is not a database",
    "malformed database schema",
    "the conversation store needs repair",
  ]) assert.equal(transcriptRepairWordsSeen("Agent failed to respond", said), true, said);
  // The commonest failure there is. It must keep the old words: asking again really does work.
  for (const said of ["fetch failed", "the model is busy right now", "context length exceeded", ""]) {
    assert.equal(transcriptRepairWordsSeen("Agent failed to respond", said), false, said);
  }
  assert.equal(transcriptRepairWordsSeen(undefined, undefined), false);
});

test("BOX-6b: the host's own verdict is read in both the shapes it can arrive in", async () => {
  const { repairFlagOf } = await loadPredicate();
  assert.deepEqual(repairFlagOf({ transcriptNeedsRepair: true }), { needsRepair: true, needsRepairReason: "" });
  assert.deepEqual(
    repairFlagOf({ transcriptNeedsRepair: { reason: "the checkpoint could not be rebuilt from the journal" } }),
    { needsRepair: true, needsRepairReason: "the checkpoint could not be rebuilt from the journal" },
  );
  // A box on an older bundle sends neither, and that is not a broken agent.
  assert.equal(repairFlagOf({}).needsRepair, false);
  assert.equal(repairFlagOf(undefined).needsRepair, false);
});

test("BOX-6b: the predicate is published once, so app.js reads it rather than a copy", async () => {
  const { global } = await loadPredicate();
  assert.equal(typeof global.__transcriptRepair?.wordsSeen, "function");
  assert.equal(global.__transcriptRepair.SENTENCE, SENTENCE);
});

// ==================================================================================================
// The roster record
// ==================================================================================================

test("BOX-6b: needs-repair rides on the roster record without inflating the need-you count", async () => {
  const statusOf = await loadStatusOf();
  const broken = statusOf({ id: "titan", transcriptNeedsRepair: true });
  assert.equal(broken.needsRepair, true);
  // The count beside the agent count is a queue of things a PERSON was asked. A stopped machine
  // is not one of them, and putting it there would make the count mean two things.
  assert.equal(broken.needsYou, false, "a store that needs repair must never reach the need-you count");
  const healthy = statusOf({ id: "scribe" });
  assert.equal(healthy.needsRepair, false);
  assert.equal(healthy.needsYouReason, "");
});

test("BOX-6b: the state survives every branch of statusOf, including a working agent", async () => {
  const statusOf = await loadStatusOf({ attention: ["titan"] });
  assert.equal(statusOf({ id: "titan", isRunning: true, transcriptNeedsRepair: true }).needsRepair, true,
    "an agent mid-turn on a store that needs repair is still on a store that needs repair");
  // The attention branch: its status line names the repair rather than the generic failure, since
  // "The last turn failed" is true of a one-off and this is not one.
  const attention = statusOf({ id: "titan", transcriptNeedsRepair: true });
  assert.equal(attention.status, "attention");
  assert.match(attention.statusText, /conversation store needs repair/);
  // And blocked-on-you still wins the status line, because that one is answerable in the composer.
  const waiting = statusOf({ id: "titan", transcriptNeedsRepair: true, awaitingUserResponse: { reason: "which file?" } });
  assert.equal(waiting.statusText, "Waiting on you");
  assert.equal(waiting.needsYou, true);
  assert.equal(waiting.needsRepair, true);
});

// ==================================================================================================
// The line in the conversation
// ==================================================================================================

test("BOX-6b: the failed turn's line names the repair instead of telling the person to ask again", async () => {
  const worker = { id: "titan", name: "Titan", messages: [] };
  const { state, failedTurnReports } = await loadReloadTrays({
    workers: [worker],
    trays: [{ id: "t1", kind: "error", agentId: "titan", title: "Agent failed to respond", detail: DEMO_TITAN_ERROR }],
  });
  const line = state.workers[0].messages.at(-1).text;
  assert.equal(line, SENTENCE);
  // The sentence the demo tenant read eighteen times. It must not be what this failure says.
  assert.doesNotMatch(line, /could not finish that one/);
  assert.doesNotMatch(line, /Ask again/);
  // Nor may the machine's own spelling reach the page (host-notes-read-as-errors.md).
  assert.doesNotMatch(line, /TranscriptJournalCorruptionError/);
  assert.doesNotMatch(line, /^\[/, "no prefixed verdict line: Jason reads those as errors");
  // The card app.js keeps gets the verdict, so it does not have to decide it a second time.
  assert.equal(failedTurnReports[0].needsRepair, true);
  // And the roster row wears the pill from this tick rather than the next heartbeat.
  assert.equal(state.workers[0].needsRepair, true);
});

test("BOX-6b: an ordinary failed turn keeps the words it had", async () => {
  const worker = { id: "titan", name: "Titan", messages: [] };
  const { state, failedTurnReports } = await loadReloadTrays({
    workers: [worker],
    trays: [{ id: "t1", kind: "error", agentId: "titan", title: "Agent failed to respond", detail: "fetch failed" }],
  });
  assert.equal(state.workers[0].messages.at(-1).text,
    "Titan could not finish that one. Ask again, or send the details to the developers.");
  assert.equal(failedTurnReports[0].needsRepair, false);
  assert.notEqual(state.workers[0].needsRepair, true, "an ordinary failure must not put a repair pill on the roster");
});

// ==================================================================================================
// The card
// ==================================================================================================

test("BOX-6b: the card leads with the repair sentence and says the retry is pointless", async () => {
  const failedTurnWords = await loadFailedTurnWords();
  const words = failedTurnWords({ agentName: "Titan", title: "Agent failed to respond", detail: DEMO_TITAN_ERROR });
  assert.equal(words.needsRepair, true);
  assert.ok(words.description.startsWith(SENTENCE), "the clause comes first, because it is the only part that says what to do");
  assert.match(words.description, /every turn for Titan will end this way/);
  assert.match(words.title, /Titan needs its conversation store repaired/);
  // The technical half still reaches the card, where it is editable and where the developers need
  // it. It is the CONVERSATION that must not carry it.
  assert.match(words.description, /TranscriptJournalCorruptionError/);
});

test("BOX-6b: the card takes the host's verdict even when the wording says nothing", async () => {
  const failedTurnWords = await loadFailedTurnWords();
  // A host that raised transcriptNeedsRepair but described the failure some other way.
  const words = failedTurnWords({ agentName: "Titan", title: "Agent failed to respond", detail: "prepare failed", needsRepair: true });
  assert.equal(words.needsRepair, true);
  assert.ok(words.description.startsWith(SENTENCE));
});

test("BOX-6b: an ordinary failure keeps the old card, and a page with no predicate still works", async () => {
  const failedTurnWords = await loadFailedTurnWords();
  const ordinary = failedTurnWords({ agentName: "Titan", title: "Agent failed to respond", detail: "fetch failed" });
  assert.equal(ordinary.needsRepair, false);
  assert.equal(ordinary.title, "Titan could not finish that one");
  assert.match(ordinary.description, /turn ended without an answer/);
  // The offline demo: no adapter block on the page at all. It must degrade, not throw.
  const offline = await loadFailedTurnWords({ repairAvailable: false });
  const still = offline({ agentName: "Titan", title: "Agent failed to respond", detail: DEMO_TITAN_ERROR });
  assert.equal(still.needsRepair, false);
  assert.equal(still.title, "Titan could not finish that one");
  // And the host's own flag still gets through, with the fallback sentence.
  const flagged = offline({ agentName: "Titan", title: "x", detail: "y", needsRepair: true });
  assert.ok(flagged.description.startsWith(SENTENCE));
});

// ==================================================================================================
// The pill
// ==================================================================================================

test("BOX-6b: the pill is drawn only for an agent in that state, and says so in plain words", async () => {
  const { needsRepair, needsRepairPillMarkup } = await loadPill();
  assert.equal(needsRepairPillMarkup({ id: "scribe" }, "needs-repair-pill"), "");
  const drawn = needsRepairPillMarkup({ id: "titan", needsRepair: true }, "needs-repair-pill");
  assert.match(drawn, /class="needs-repair-pill"/);
  assert.match(drawn, />Needs repair</);
  assert.match(drawn, /Open Agent details to repair it/);
  assert.equal(needsRepair({ needsRepair: true }), true);
  assert.equal(needsRepair(null), false);
});

test("BOX-6b: the host's reason reaches the pill's title, escaped", async () => {
  const { needsRepairPillMarkup } = await loadPill();
  const drawn = needsRepairPillMarkup({ needsRepair: true, needsRepairReason: 'the checkpoint <b>"x"</b> could not be rebuilt' }, "needs-repair-pill");
  assert.match(drawn, /&lt;b&gt;/);
  assert.doesNotMatch(drawn, /<b>/);
});

// ==================================================================================================
// The control
// ==================================================================================================

test("BOX-6b: the Repair control is drawn only where the host has the verb and the agent needs it", async () => {
  const worker = { id: "titan", name: "Titan", role: "", model: "m", files: [], browser: { screen: "" }, status: "attention", statusText: "x" };
  const withVerb = { repairTranscript: () => null, canRepairTranscript: () => true };

  const broken = await loadPanel({ adapter: withVerb });
  assert.match(broken({ ...worker, needsRepair: true }), /data-repair-transcript="titan"/);

  // A healthy agent is not offered a recovery it does not need.
  assert.doesNotMatch(broken({ ...worker }), /data-repair-transcript/);

  // A box on an older bundle that has already answered "unknown gateway method".
  const stale = await loadPanel({ adapter: { repairTranscript: () => null, canRepairTranscript: () => false } });
  assert.doesNotMatch(stale({ ...worker, needsRepair: true }), /data-repair-transcript/);

  // And an adapter with no such method at all, which is the offline demo.
  const none = await loadPanel({ adapter: {} });
  assert.doesNotMatch(none({ ...worker, needsRepair: true }), /data-repair-transcript/);
});

test("BOX-6b: the control's own words promise what the repair actually does", async () => {
  const worker = { id: "titan", name: "Titan", role: "", model: "m", files: [], browser: { screen: "" }, status: "attention", statusText: "x", needsRepair: true };
  const panel = await loadPanel({ adapter: { repairTranscript: () => null } });
  const drawn = panel(worker);
  // What it DOES, not what it would be nice if it did. The verb sets the stuck state aside; the
  // message after it is what rebuilds. A card that promised a rebuild is the false promise the
  // review round found in the operator doc, and it was on this card too.
  assert.match(drawn, /the next message can rebuild/);
  assert.doesNotMatch(drawn, /Repairing rebuilds it/);
  assert.match(drawn, /Nothing is deleted/);
  assert.match(drawn, /data-repair-note/);
  // The host's own reason replaces the generic sentence when it sent one.
  const withReason = panel({ ...worker, needsRepairReason: "the journal has no checkpoint to recover from" });
  assert.match(withReason, /the journal has no checkpoint to recover from/);
});

// ==================================================================================================
// What the control says afterwards
// ==================================================================================================

test("BOX-6b: a repair that worked leaves the quiet line, with the count", async () => {
  const worker = { id: "titan", needsRepair: true, needsRepairReason: "x" };
  const press = await loadRepairPress({
    worker,
    adapter: { repairTranscript: async () => ({ before: 115, after: 115, quarantined: [], outcome: "repaired", reason: "" }) },
  });
  const btn = button();
  await press.repairTranscriptFromPanel(btn, "titan");
  assert.match(press.note.textContent, /^Repaired, 115 entries kept\./);
  assert.equal(btn.removed, true, "a repaired agent is not offered the repair again");
  assert.equal(worker.needsRepair, false, "and the pill goes now rather than on the next heartbeat");
  assert.equal(press.rendered.roster, 1);
  // No toast, no prefix, no underline: host-notes-read-as-errors.md.
  assert.doesNotMatch(press.note.textContent, /^\[|^[A-Z]+:/);
});

test("BOX-6b: 'nothing to quarantine' is a normal answer, not a failure", async () => {
  // The one real case in production. Both of the demo Titan's databases passed
  // PRAGMA integrity_check on 2026-09-09, so there was no damaged file to move aside. A console
  // that read the null as a failure would report the repair as broken while it had worked.
  const press = await loadRepairPress({
    worker: { id: "titan", needsRepair: true },
    adapter: { repairTranscript: async () => ({ before: 0, after: 115, quarantined: [], outcome: "recovered", reason: "" }) },
  });
  const btn = button();
  await press.repairTranscriptFromPanel(btn, "titan");
  assert.match(press.note.textContent, /Repaired, 115 entries kept\./);
  assert.doesNotMatch(press.note.textContent, /set aside/);
  assert.doesNotMatch(press.note.textContent, /did not repair/);
  assert.equal(btn.removed, true);
});

test("BOX-6b: a quarantine is named, and entries that could not be read back are counted", async () => {
  const press = await loadRepairPress({
    worker: { id: "titan", needsRepair: true },
    adapter: { repairTranscript: async () => ({ before: 120, after: 115, quarantined: ["checkpoint.corrupt-2026-09-09T18-00-00Z"], outcome: "repaired", reason: "" }) },
  });
  await press.repairTranscriptFromPanel(button(), "titan");
  assert.match(press.note.textContent, /Repaired, 115 entries kept\./);
  assert.match(press.note.textContent, /5 could not be read back/);
  assert.match(press.note.textContent, /set aside as checkpoint\.corrupt-2026-09-09T18-00-00Z; nothing was deleted/);
});

test("BOX-6b: a refusal says what the host said and leaves the button pressable", async () => {
  const worker = { id: "titan", needsRepair: true };
  const press = await loadRepairPress({
    worker,
    adapter: { repairTranscript: async () => ({ before: 115, after: null, quarantined: [], outcome: "refused", reason: "the pending write-ahead log does not match the durable checkpoint" }) },
  });
  const btn = button();
  await press.repairTranscriptFromPanel(btn, "titan");
  assert.match(press.note.textContent, /the pending write-ahead log does not match the durable checkpoint/);
  assert.doesNotMatch(press.note.textContent, /Repaired,/);
  assert.equal(btn.removed, false, "a refusal leaves the control there to try again");
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, "Repair");
  assert.equal(worker.needsRepair, true, "and the agent is still in that state, because it is");
});

test("BOX-6b: an outcome word the console does not know is never translated into success", async () => {
  const press = await loadRepairPress({
    worker: { id: "titan", needsRepair: true },
    adapter: { repairTranscript: async () => ({ before: 115, after: 115, quarantined: [], outcome: "deferred", reason: "" }) },
  });
  const btn = button();
  await press.repairTranscriptFromPanel(btn, "titan");
  assert.doesNotMatch(press.note.textContent, /Repaired,/);
  assert.match(press.note.textContent, /did not repair it: deferred/);
  assert.equal(btn.removed, false);
});

test("BOX-6b: a box without the verb says so and takes the control away", async () => {
  const press = await loadRepairPress({
    worker: { id: "titan", needsRepair: true },
    adapter: { repairTranscript: async () => null },
  });
  const btn = button();
  await press.repairTranscriptFromPanel(btn, "titan");
  assert.match(press.note.textContent, /does not have the repair yet/);
  assert.equal(btn.removed, true);
});

test("BOX-6b: a thrown refusal reaches the person, and says nothing was changed", async () => {
  const press = await loadRepairPress({
    worker: { id: "titan", needsRepair: true },
    adapter: { repairTranscript: async () => { throw new Error("the host is busy with a turn."); } },
  });
  const btn = button();
  await press.repairTranscriptFromPanel(btn, "titan");
  assert.match(press.note.textContent, /the host is busy with a turn\. Nothing was changed\./);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, "Repair");
});

test("BOX-6b: the button says it is working while it works", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const press = await loadRepairPress({
    worker: { id: "titan", needsRepair: true },
    adapter: { repairTranscript: () => held },
  });
  const btn = button();
  const running = press.repairTranscriptFromPanel(btn, "titan");
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, "Repairing…");
  assert.match(press.note.textContent, /Repairing this agent's conversation store/);
  release({ before: 115, after: 115, quarantined: [], outcome: "repaired", reason: "" });
  await running;
});

// ==================================================================================================
// The adapter's doors
// ==================================================================================================

test("BOX-6b: the verb is asked under the key the gateway reads, and shaped for the panel", async () => {
  const doors = await loadRepairDoors({
    answer: { before: "115", after: 115, quarantined: ["  cp.corrupt-1  "], outcome: " repaired ", reason: "" },
  });
  const answer = await doors.repairTranscript("c63fdce4");
  assert.deepEqual(doors.asked[0], ["repairAgentTranscript", { id: "c63fdce4", agentId: "c63fdce4" }]);
  assert.deepEqual(answer, { before: 115, after: 115, quarantined: ["cp.corrupt-1"], outcome: "repaired", reason: "" });
});

test("BOX-6b: an empty quarantine and a missing count are read as what they are", async () => {
  // MEASURED against the host on grok-bot-local-vm 2026-09-09: nothing to move aside arrives as
  // `[]`, not as null and not as a missing key.
  const doors = await loadRepairDoors({ answer: { before: null, after: 115, quarantined: [], outcome: "recovered" } });
  const answer = await doors.repairTranscript("titan");
  assert.deepEqual(answer.quarantined, []);
  assert.equal(answer.before, null, "an unknown before is not a before of 0");
  assert.equal(answer.after, 115);
  // A lone string is accepted rather than dropped, and a blank one is nothing moved aside.
  const one = await loadRepairDoors({ answer: { after: 1, quarantined: "cp.corrupt-2", outcome: "ok" } });
  assert.deepEqual((await one.repairTranscript("titan")).quarantined, ["cp.corrupt-2"]);
  const blank = await loadRepairDoors({ answer: { after: 1, quarantined: "   ", outcome: "ok" } });
  assert.deepEqual((await blank.repairTranscript("titan")).quarantined, []);
});

test("BOX-6b: the host's own answer for a store with nothing wrong with it reads right", async () => {
  // The exact answer measured on grok-bot-local-vm 2026-09-09. "Repaired, 0 entries kept" would be
  // a strange thing to read after pressing Repair, so this case says what actually happened.
  const press = await loadRepairPress({
    worker: { id: "titan", needsRepair: true },
    adapter: { repairTranscript: async () => ({ agentId: "titan", before: 0, after: 0, quarantined: [], outcome: "already-healthy", reason: "this conversation store had nothing to repair" }) },
  });
  const btn = button();
  await press.repairTranscriptFromPanel(btn, "titan");
  assert.match(press.note.textContent, /^There was nothing to repair here\./);
  assert.doesNotMatch(press.note.textContent, /Repaired, 0/);
  assert.doesNotMatch(press.note.textContent, /did not repair/, "a reason on a success is an explanation, not a refusal");
  assert.equal(btn.removed, true);
});

test("BOX-6b: a box on an older bundle yields null and then stops offering the control", async () => {
  const doors = await loadRepairDoors({ missing: true });
  assert.equal(await doors.repairTranscript("titan"), null);
  assert.equal(doors.canRepairTranscript(), false);
  // Before anything has been asked, the control is offered: the gateway carries no capability list
  // for this, and never drawing it would be worse than drawing it once.
  const fresh = await loadRepairDoors({ answer: { after: 1, outcome: "ok" } });
  assert.equal(fresh.canRepairTranscript(), true);
});

test("BOX-6b: a refusal from the host is thrown rather than swallowed", async () => {
  const doors = await loadRepairDoors({ thrown: new Error("repairAgentTranscript -> 500 the host refused") });
  await assert.rejects(() => doors.repairTranscript("titan"), /the host refused/);
});

// ==================================================================================================
// The state has to outlive the tray
// ==================================================================================================

test("BOX-6b: the pill survives the roster read a moment later, on a box with no host flag", async () => {
  // attentionIds is cleared and rebuilt on every reloadTrays and the tray is dismissed as it is
  // read, so "attention" lasts one tick. This state must not: the agent will fail every turn until
  // somebody repairs it, and reloadRoster runs immediately after reloadTrays.
  const { repairFlagOf, global } = await loadPredicate();
  assert.equal(repairFlagOf({ id: "titan" }).needsRepair, false);
  global.__transcriptRepair.remember("titan");
  assert.equal(repairFlagOf({ id: "titan" }).needsRepair, true, "a listAgents answer with no flag must not paint the pill straight back off");
  assert.equal(repairFlagOf({ id: "scribe" }).needsRepair, false, "and only for the agent that failed");
  global.__transcriptRepair.forget("titan");
  assert.equal(repairFlagOf({ id: "titan" }).needsRepair, false);
});

test("BOX-6b: only a repair the host stood behind forgets the failure this page saw", async () => {
  const worked = await loadRepairDoors({ answer: { before: 115, after: 115, quarantined: [], outcome: "repaired" } });
  worked.shared.remember("titan");
  await worked.repairTranscript("titan");
  assert.equal(worked.shared.flagOf({ id: "titan" }).needsRepair, false, "a repair that worked drops the pill");

  const refused = await loadRepairDoors({ answer: { before: 115, after: null, quarantined: [], outcome: "refused", reason: "the pending write-ahead log matches nothing" } });
  refused.shared.remember("titan");
  await refused.repairTranscript("titan");
  assert.equal(refused.shared.flagOf({ id: "titan" }).needsRepair, true, "a refusal leaves it exactly where it was, which is the truth");
});

test("BOX-6b: one judge decides both the pill and the button's words", async () => {
  const { global } = await loadPredicate();
  const judge = global.__transcriptRepair.worked;
  assert.equal(judge({ after: 115, outcome: "repaired", reason: "" }), true);
  assert.equal(judge({ after: 115, outcome: "", reason: "" }), true, "a host that counted and said nothing else did the job");
  assert.equal(judge({ after: 115, outcome: "deferred", reason: "" }), false, "an outcome word we do not know is never read as success");
  // MEASURED against the host on grok-bot-local-vm: a clean repair carries a reason too ("this
  // conversation store had nothing to repair"), so a reason EXPLAINS and never refuses. Reading one
  // as a refusal would have reported every clean repair in production as broken.
  assert.equal(judge({ after: 115, outcome: "recovered", reason: "the checkpoint was rebuilt from the journal" }), true);
  assert.equal(judge({ after: 0, outcome: "refused", reason: "the pending log matches nothing" }), false);
  assert.equal(judge({ after: null, outcome: "", reason: "" }), false);
  assert.equal(judge(null), false);
  // The one real case in production: nothing to quarantine, and it worked.
  assert.equal(judge({ before: 0, after: 115, quarantined: [], outcome: "recovered" }), true);
  assert.equal(judge({ before: 0, after: 0, quarantined: [], outcome: "already-healthy", reason: "this conversation store had nothing to repair" }), true);
  // The host's fourth word, for a checkpoint it had to rebuild from nothing.
  assert.equal(judge({ after: 0, outcome: "reset" }), true);
});

// ==================================================================================================
// The review's false success: an on-demand repair whose only act was turning the stuck state off
// answered "recovered", and the panel said "Repaired, 0 entries kept." on the one case the state
// exists for. It has its own word now, and its own sentence.
// ==================================================================================================

test("BOX-6b: clearing the stuck state says so, and never claims a count it did not keep", async () => {
  const press = await loadRepairPress({
    worker: { id: "titan", needsRepair: true },
    adapter: {
      repairTranscript: async () => ({
        agentId: "titan", before: 0, after: 0, quarantined: [], outcome: "cleared",
        reason: "the conversation blobs are not readable",
      }),
    },
  });
  const btn = button();
  await press.repairTranscriptFromPanel(btn, "titan");
  assert.match(press.note.textContent, /^Cleared the stuck state\./);
  assert.match(press.note.textContent, /Send this agent one message/);
  assert.match(press.note.textContent, /the conversation blobs are not readable/);
  assert.doesNotMatch(press.note.textContent, /Repaired/, "nothing was repaired");
  assert.doesNotMatch(press.note.textContent, /entries kept/);
  assert.doesNotMatch(press.note.textContent, /did not repair it/, "the state really is off");
  // The state is off, so the control and the pill go with it; the next message puts them back if
  // the store is still broken.
  assert.equal(btn.removed, true);
  assert.equal(press.rendered.roster >= 1, true);
});

test("BOX-6b: cleared is not a success word for the judge that clears the pill by itself", async () => {
  const { repairWorked, repairCleared } = await loadPredicate();
  assert.equal(repairWorked({ before: 0, after: 0, outcome: "cleared" }), false,
    "a repair that repaired nothing must not read as one");
  assert.equal(repairCleared({ before: 0, after: 0, outcome: "cleared" }), true);
  assert.equal(repairCleared({ outcome: "recovered" }), false);
  assert.equal(repairCleared(null), false);
  // The refusal the second press gets, once a person has cleared it once.
  assert.equal(repairWorked({ outcome: "needs-attention", reason: "this was cleared once already and came straight back, so it needs a person: the conversation blobs are not readable" }), false);
});

test("BOX-6b: a second press, refused by the host, reads as a refusal with the original reason", async () => {
  const press = await loadRepairPress({
    worker: { id: "titan", needsRepair: true },
    adapter: {
      repairTranscript: async () => ({
        agentId: "titan", before: 0, after: 0, quarantined: [], outcome: "needs-attention",
        reason: "this was cleared once already and came straight back, so it needs a person: the conversation blobs are not readable",
      }),
    },
  });
  const btn = button();
  await press.repairTranscriptFromPanel(btn, "titan");
  assert.match(press.note.textContent, /^That did not repair it: this was cleared once already/);
  assert.equal(btn.removed, false, "the button stays, because the state is still true");
  assert.equal(btn.disabled, false);
});
