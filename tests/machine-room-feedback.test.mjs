// FEEDBACK-1, the console half: the quiet chip, the offer, the card, and what leaves the workspace.
//
// The blocks are SLICED OUT of app.js and gateway-adapter.js and run here rather than copied. A
// copy would go on passing after the console changed, which on a custody promise is worse than no
// test at all.
//
// Each case is one of the faults Titan reported, or one the design would have shipped:
//
//   - "Titan tried to cover up failure." A failed turn has to produce the offer. MEASURED on
//     grok-bot-local-vm 2026-09-09: a model-endpoint failure writes NO turn-failed row -- the host
//     logged it in 3 s, the tray fired, both transcript reads came back with messages only, and the
//     page showed the person's own bubble and "Accepted by the host" for thirty seconds. So the
//     offer is built at tray-narration time, and these cases pin that.
//   - The line that used to go in its place, `That turn failed: Agent failed to respond — fetch
//     failed`, is the machine's own spelling of a problem the person can do exactly one thing
//     about. host-notes-read-as-errors.md bans that presentation, so no raw provider wording may
//     reach the conversation at all.
//   - Three failures of one tool produce ONE offer. Three cards for one bad afternoon is its own
//     fault.
//   - The reporting tool's row must render as one muted detail-less line with no tool name and no
//     arguments. The arguments are the agent's account of a fault the person is about to read in
//     full and edit; drawing them in an expander behind the chip would put the unedited version on
//     the page beside the edited one.
//   - A token-shaped run anywhere in what the card shows is masked before it is drawn, through the
//     page's own masker rather than a copy of its regex.
//   - What the custody line promises is what the send actually does. That is the one that matters:
//     a card that says "edit anything below" and then ships an uneditable copy of what you deleted
//     is a lie the product would be telling on every report.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(repoRoot, "ui/machine-room/app.js");
const adapterPath = path.join(repoRoot, "ui/machine-room/gateway-adapter.js");

const escapeForCard = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const between = (source, startMark, endMark, what) => {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + 1);
  assert.ok(start >= 0 && end > start, `${what} must be findable`);
  return source.slice(start, end);
};

// ---- the console block -------------------------------------------------------------------------
// It reaches escapeHtml, maskSecrets, the context helpers, the adapter and renderTranscript. Both
// escapers are the page's own source, not a copy: an escaping or masking check against a copy
// proves nothing.
async function loadFeedback({ messages = [], adapter = {}, contextId = "titan", contextLabel = "Titan" } = {}) {
  const source = await readFile(appPath, "utf8");
  const body = between(source, "  // ---- FEEDBACK-1: report a problem", "  // ---- end FEEDBACK-1", "the feedback block");
  const escaper = between(source, "  function escapeHtml(value) {", "  function sameContext(", "escapeHtml");
  const masker = between(source, "  const SECRETISH = ", "  // Only shell_command receipts carry", "maskSecrets");
  const renders = { count: 0 };
  const exports = `return {
    PROBLEM_TIERS, REPORT_CUSTODY, SELF_TEST_PROMPT, offerProblemReport, problemOffers: () => problemOffers,
    reportCardsMarkup, reportCardMarkup, reportBodyText, reportEvidence, problemReportPayload,
    sendProblemOffer, settleProblemOffer, problemOfferById, drainFailedTurnOffers,
    noteRepeatedToolFailures, openProblemReportCard, runSelfTest, drainPendingProblemReports,
    consoleBuild, loadConsoleBuild, loadHostBuild,
    problemOfferQueue, foldProblemOffer, watchPendingProblemReports, REPORT_FOLD_MS, PENDING_POLL_MS,
  };`;
  const pins = { count: 0 };
  const activeContext = () => ({ kind: "worker", id: contextId });
  const built = new Function(
    "escapeHtmlSource", "maskSource", "activeContext", "contextMessages", "contextName", "adapter",
    "renderTranscript", "showToast", "fetch", "crypto", "TextEncoder", "pinTranscriptToBottom",
    `${escaper}\n${masker}\n${body}\n${exports}`,
  );
  const api = built(
    undefined, undefined, activeContext,
    () => messages,
    () => contextLabel,
    adapter,
    () => { renders.count += 1; },
    () => {},
    globalThis.fetch,
    globalThis.crypto,
    globalThis.TextEncoder,
    () => { pins.count += 1; },
  );
  return { ...api, renders, get pins() { return pins.count; } };
}

// The extracted body declares escapeHtml and maskSecrets itself (they are prepended above), so the
// two unused parameters exist only to keep the argument list honest about what was injected.

// ---- the adapter's tray narration --------------------------------------------------------------
async function loadReloadTrays({ trays = [], workers = [] } = {}) {
  const source = await readFile(adapterPath, "utf8");
  const body = between(source, "    async function reloadTrays() {", "    // Every routine write re-reads", "reloadTrays");
  const state = { workers, rooms: [] };
  const attentionIds = new Set();
  const reportedTrays = new Set();
  const awaiting = new Map();
  const failedTurnReports = [];
  const call = async (method) => (method === "getTrays" ? trays : null);
  // BOX-6b: reloadTrays now asks the shared predicate whether this failure is a store that needs
  // repairing, so its block is prepended out of the adapter's own file rather than stubbed. A stub
  // here would let the narration go on passing after the predicate changed.
  const repairBlock = between(source, "  // ---- BOX-6b: a conversation store that needs repair", "  // ---- end BOX-6b", "the BOX-6b block");
  const run = new Function(
    "global", "call", "state", "attentionIds", "reportedTrays", "awaiting", "keyOf", "timeOf", "failedTurnReports",
    `${repairBlock}\n${body}\nreturn reloadTrays;`,
  )({}, call, state, attentionIds, reportedTrays, awaiting, (c) => `${c.kind}:${c.id}`, () => "now", failedTurnReports);
  await run();
  return { state, failedTurnReports, attentionIds };
}

// ---- the adapter's tool row --------------------------------------------------------------------
async function loadToolRow() {
  const source = await readFile(adapterPath, "utf8");
  const body = between(source, "  const PROBLEM_REPORT_TOOL_CALL =", "  const messageKey =", "the tool-row block");
  return new Function(`${body}\nreturn { toolRowText, TOOL_LABELS, PROBLEM_REPORT_TOOL_CALL, PROBLEM_REPORT_ROW_TEXT };`)();
}

// ---- how a system message is drawn -------------------------------------------------------------
async function loadMessageMarkup() {
  const source = await readFile(appPath, "utf8");
  const escaper = between(source, "  function escapeHtml(value) {", "  function sameContext(", "escapeHtml");
  const body = between(source, "  function messageMarkup(message) {", "\n  // The transcript is a tail window;", "messageMarkup");
  return new Function(`${escaper}\n${body}\nreturn messageMarkup;`)();
}

const row = (extra = {}) => ({ id: "m1", type: "system", text: "Shell · ls · failed", detail: "", kind: "Shell", ...extra });

// ================================================================================================

test("FEEDBACK-1: the reporting tool's row is one muted line with no tool name and no arguments", async () => {
  const { toolRowText, PROBLEM_REPORT_TOOL_CALL, PROBLEM_REPORT_ROW_TEXT } = await loadToolRow();
  const drawn = toolRowText({
    name: PROBLEM_REPORT_TOOL_CALL,
    status: "done",
    // What the outline would carry: the agent's own account, verbatim.
    summary: JSON.stringify({ title: "The shell refuses every command", severity: "critical", rationale: "Tools:\n- Shell · failed · exec daemon not reachable" }),
    output: "Written down and shown to the person in their console",
  });
  assert.equal(drawn.text, PROBLEM_REPORT_ROW_TEXT);
  assert.equal(drawn.text, "Reported a problem to the developers");
  assert.equal(drawn.detail, "", "an empty detail is what makes app.js draw a bubble and not an expander");
  // Not the tool's own name, not the proto case, and not one character of its arguments.
  for (const leak of ["report_problem", "reportBug", "PROBLEM_REPORT", "severity", "exec daemon"]) {
    assert.doesNotMatch(drawn.text + drawn.detail, new RegExp(leak, "i"), `${leak} must not reach the page`);
  }
});

test("FEEDBACK-1: an empty detail means a plain bubble, not an expandable receipt", async () => {
  const messageMarkup = await loadMessageMarkup();
  const drawn = messageMarkup({ id: "m1", type: "system", text: "Reported a problem to the developers", detail: "", kind: "Report" });
  assert.match(drawn, /message-bubble/);
  assert.doesNotMatch(drawn, /<details|tool-receipt/, "a detail-less row must not offer an expander with nothing behind it");
  // The contrast case: a shell row that does carry a receipt still opens.
  assert.match(messageMarkup({ id: "m2", type: "system", text: "Wrote notes.md", detail: "Shell · cat > notes.md" }), /<details/);
});

test("FEEDBACK-1: a failed turn narrates in plain words and carries no raw provider wording", async () => {
  const worker = { id: "titan", name: "Titan", messages: [] };
  const { state, failedTurnReports } = await loadReloadTrays({
    workers: [worker],
    trays: [{ id: "t1", kind: "error", agentId: "titan", title: "Agent failed to respond", detail: "fetch failed" }],
  });
  const said = state.workers[0].messages;
  assert.equal(said.length, 1);
  assert.equal(said[0].type, "system", "a quiet chip, not a bubble from somebody");
  assert.equal(said[0].text, "Titan could not finish that one. Ask again, or send the details to the developers.");
  // The whole conversation, not just this line: no raw provider wording anywhere in it.
  const everything = JSON.stringify(said);
  for (const raw of ["That turn failed", "Agent failed to respond", "fetch failed"]) {
    assert.ok(!everything.includes(raw), `"${raw}" must not reach the conversation`);
  }
  // The technical half is not thrown away. It goes on the seed, which becomes the card the person
  // reads and edits before deciding, which is where the developers' copy comes from.
  assert.equal(failedTurnReports.length, 1);
  assert.equal(failedTurnReports[0].agentId, "titan");
  assert.equal(failedTurnReports[0].title, "Agent failed to respond");
  assert.equal(failedTurnReports[0].detail, "fetch failed");
});

test("FEEDBACK-1: the same tray narrates once, however many times the page reloads", async () => {
  const worker = { id: "titan", name: "Titan", messages: [] };
  const source = await readFile(adapterPath, "utf8");
  const body = between(source, "    async function reloadTrays() {", "    // Every routine write re-reads", "reloadTrays");
  const state = { workers: [worker], rooms: [] };
  const failedTurnReports = [];
  const trays = [{ id: "t1", kind: "error", agentId: "titan", title: "Agent failed to respond", detail: "fetch failed" }];
  // BOX-6b, as in loadReloadTrays above: the predicate reloadTrays now consults comes out of the
  // adapter's own block rather than a stub of it.
  const repairBlock = between(source, "  // ---- BOX-6b: a conversation store that needs repair", "  // ---- end BOX-6b", "the BOX-6b block");
  const run = new Function(
    "global", "call", "state", "attentionIds", "reportedTrays", "awaiting", "keyOf", "timeOf", "failedTurnReports",
    `${repairBlock}\n${body}\nreturn reloadTrays;`,
  )({}, async () => trays, state, new Set(), new Set(), new Map(), (c) => `${c.kind}:${c.id}`, () => "now", failedTurnReports);
  await run();
  await run();
  await run();
  assert.equal(worker.messages.length, 1);
  assert.equal(failedTurnReports.length, 1, "a reload must not re-offer a failure the person already saw");
});

test("FEEDBACK-1: a failed turn becomes an offer the person can answer", async () => {
  const seeds = [{ trayId: "t1", agentId: "titan", agentName: "Titan", title: "Agent failed to respond", detail: "fetch failed", at: 0 }];
  const feedback = await loadFeedback({ adapter: { takeFailedTurnReports: () => seeds.splice(0) } });
  const made = feedback.drainFailedTurnOffers();
  assert.equal(made.length, 1);
  assert.equal(made[0].tier, "critical");
  assert.equal(made[0].status, "pending");
  const card = feedback.reportCardsMarkup();
  assert.match(card, /Would you like to send this to the developers\?/);
  assert.match(card, /data-report-send/);
  assert.match(card, /data-report-drop/);
  // The technical half IS on the card, where the person can read it and take it out before sending.
  assert.match(card, /Agent failed to respond/);
  assert.match(card, /fetch failed/);
  // Nothing more arrives on the second drain: the adapter's queue was emptied by the first.
  assert.equal(feedback.drainFailedTurnOffers().length, 0);
});

test("FEEDBACK-1: three failures of one tool make one offer, not three", async () => {
  const messages = [
    row({ id: "a", text: "Shell · ls · failed" }),
    row({ id: "b", text: "Shell · cat · failed" }),
    row({ id: "c", text: "Read · notes.md" }),
    row({ id: "d", text: "Shell · pwd · failed" }),
  ];
  const feedback = await loadFeedback({ messages });
  const first = feedback.noteRepeatedToolFailures();
  assert.equal(first.length, 1);
  assert.match(first[0].title, /Shell has failed 3 times here/);
  assert.equal(first[0].tier, "quality");
  // Called again on the next tick, and on every tick after that.
  assert.equal(feedback.noteRepeatedToolFailures().length, 0);
  assert.equal(feedback.noteRepeatedToolFailures().length, 0);
  assert.equal(feedback.problemOffers().length, 1);
});

test("FEEDBACK-1: two failures are not three, and a tool that succeeded is not counted", async () => {
  const feedback = await loadFeedback({ messages: [
    row({ id: "a", text: "Shell · ls · failed" }),
    row({ id: "b", text: "Shell · cat · failed" }),
    row({ id: "c", text: "Shell · pwd" }),
    row({ id: "d", kind: "Read", text: "Read · a · failed" }),
    row({ id: "e", kind: "Read", text: "Read · b · failed" }),
  ] });
  assert.deepEqual(feedback.noteRepeatedToolFailures(), []);
});

test("FEEDBACK-1: a token-shaped run is masked before the card is drawn", async () => {
  const secret = `sk-${"A1b2C3d4E5".repeat(4)}`;
  const feedback = await loadFeedback({ messages: [
    { id: "m1", type: "system", kind: "Shell", text: `Shell · curl -H "Authorization: Bearer ${secret}" · failed`, detail: `exit 22\n${secret}` },
    { id: "m2", type: "text", authorId: "titan", text: `I used the key ${secret} and it was refused.` },
  ] });
  const evidence = feedback.reportEvidence();
  const card = feedback.reportCardsMarkup.call(null) + JSON.stringify(evidence);
  feedback.openProblemReportCard();
  const drawn = feedback.reportCardsMarkup();
  for (const surface of [JSON.stringify(evidence), drawn, card]) {
    assert.ok(!surface.includes(secret), "the raw token must not reach the card or the payload");
  }
  assert.match(drawn, /redacted, \d+ chars/);
});

// The blocker this pins. Masking used to happen at DRAW time, on the evidence the page built for
// itself: an agent-written description quoting an env dump went to the card raw, and a tool's error
// was starred on screen and sent whole. So a customer's key could leave the workspace, land in the
// control plane's feedback table and be POSTed into a GitHub issue body without the person who
// pressed Send ever having seen it. Masking is at MINT time now: the card, the body the person
// edits and the payload are the same already-masked bytes.
test("FEEDBACK-1: a token an agent wrote is masked on the card AND on the wire", async () => {
  const secret = `sk-${"A1b2C3d4E5".repeat(4)}`;
  const hex = "f".repeat(64);
  const posted = [];
  const feedback = await loadFeedback({
    adapter: { sendProblemReport: (payload) => { posted.push(payload); return Promise.resolve({ id: "fb-1" }); } },
  });
  const offer = feedback.offerProblemReport({
    tier: "critical",
    category: "shell",
    title: `Shell refused with ${secret}`,
    description: `The environment printed OPENAI_API_KEY=${secret} and a session id ${hex}, and every command after that failed.`,
    steps: [`export OPENAI_API_KEY=${secret}`, "run anything"],
    tools: [{ name: "Shell", status: "failed", error: `auth failed for ${secret}` }],
  });
  const drawn = feedback.reportCardsMarkup();
  for (const [what, surface] of [["the card", drawn], ["the offer body", offer.body]]) {
    assert.ok(!surface.includes(secret), `${what} carries the raw key`);
    assert.ok(!surface.includes(hex), `${what} carries the raw session id`);
  }

  // Unedited, which is the case that used to leak: the structured copies ride along, so they have
  // to be the masked ones.
  await feedback.sendProblemOffer(offer.id, offer.body);
  const wire = JSON.stringify(posted[0]);
  assert.ok(!wire.includes(secret), "the raw key was sent");
  assert.ok(!wire.includes(hex), "the raw session id was sent");
  assert.match(posted[0].description, /redacted, \d+ chars/);
  assert.match(posted[0].tools[0].error, /redacted, \d+ chars/);
  assert.match(posted[0].steps[0], /redacted, \d+ chars/);
  // What is on screen and what is sent are the same bytes, which is what the custody line says.
  assert.equal(posted[0].tools[0].error, offer.tools[0].error);
  assert.ok(drawn.includes(escapeForCard(posted[0].tools[0].error.split(" ").pop())), "the card shows the masked run the wire carries");
});

test("FEEDBACK-1: the custody line promises exactly what the send does", async () => {
  const posted = [];
  const feedback = await loadFeedback({
    messages: [row({ id: "a", text: "Shell · ls · failed", detail: "exit 1" })],
    adapter: { sendProblemReport: (payload) => { posted.push(payload); return Promise.resolve({ id: "fb-1" }); } },
  });
  const offer = feedback.offerProblemReport({ tier: "quality", category: "shell", title: "Shell keeps failing", description: "It failed.", tools: [{ name: "Shell", status: "failed", error: "exit 1" }] });
  const drawn = feedback.reportCardsMarkup();
  assert.match(drawn, /What you see below is what is sent/);
  assert.match(drawn, /Your keys, your files and your other conversations are not sent/);
  assert.match(drawn, /if you change the text, only your version goes/);

  // Untouched: what the person approved is exactly what the agent wrote, so the developers get it
  // in both forms and the structured copies ride along.
  await feedback.sendProblemOffer(offer.id, offer.body);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].version, 1);
  assert.equal(posted[0].tier, "quality");
  assert.deepEqual(posted[0].tools, [{ name: "Shell", status: "failed", error: "exit 1" }]);
  assert.ok(Array.isArray(posted[0].evidence.calls), "the calls the body was built from ride along untouched");
  // No workspace anywhere: the relay stamps it from its own registry, so this page can neither name
  // its own tenant nor anyone else's.
  assert.equal("workspace" in posted[0], false);
  assert.equal(feedback.problemOfferById(offer.id).status, "sent");

  // Edited: the structured copies of what they were shown do NOT go behind their back.
  const second = feedback.offerProblemReport({ tier: "quality", category: "shell", title: "Again", description: "It failed.", steps: ["one"], tools: [{ name: "Shell", status: "failed", error: "exit 1" }] });
  await feedback.sendProblemOffer(second.id, "I took the error text out of this one.");
  const sent = posted[1];
  assert.equal(sent.description, "I took the error text out of this one.");
  assert.deepEqual(sent.steps, []);
  assert.deepEqual(sent.tools, [{ name: "Shell", status: "failed" }], "the tool's name survives, its answer does not");
  assert.equal("calls" in sent.evidence, false);
  assert.equal("messages" in sent.evidence, false);
});

test("FEEDBACK-1: Not now sends nothing and says so", async () => {
  const posted = [];
  const feedback = await loadFeedback({ adapter: { sendProblemReport: (p) => { posted.push(p); return Promise.resolve({}); } } });
  const offer = feedback.offerProblemReport({ title: "Something", description: "x" });
  feedback.settleProblemOffer(offer, "dropped");
  assert.equal(posted.length, 0);
  assert.match(feedback.reportCardsMarkup(), /Nothing left this workspace/);
});

// ---- FEEDBACK-2: the card has a life ------------------------------------------------------------
// Jason, 2026-09-09, on a card he had already answered: "that green box is not going away. It just
// stays there." A settled card had no timer, no dismiss control and no way off the page short of a
// reload, and it sat pinned above the composer for the life of the tab.

test("FEEDBACK-2: a settled card folds into one quiet transcript row and stops being a card", async () => {
  const feedback = await loadFeedback({ adapter: { sendProblemReport: () => Promise.resolve({ id: "fb-1" }) } });
  const offer = feedback.offerProblemReport({ title: "The shell refuses every command", description: "x" });
  await feedback.sendProblemOffer(offer.id, "x");
  assert.equal(feedback.problemOfferById(offer.id).status, "sent");
  assert.match(feedback.reportCardsMarkup(), /Sent\. The developers have it\./);
  // The claim the old copy made -- "you can see what you sent in your own copy above" -- was only
  // true while the card was on screen, and the card is about to leave.
  assert.doesNotMatch(feedback.reportCardsMarkup(), /your own copy above/);
  assert.match(feedback.reportCardsMarkup(), /data-report-dismiss/, "and it can be dismissed by hand");

  feedback.foldProblemOffer(feedback.problemOfferById(offer.id));
  const folded = feedback.reportCardsMarkup();
  assert.equal(feedback.problemOfferById(offer.id).status, "folded");
  assert.match(folded, /Sent to the developers: The shell refuses every command/);
  assert.doesNotMatch(folded, /inline-card/, "it is a quiet row now, not a card");
  assert.doesNotMatch(folded, /data-report-send|data-report-dismiss/, "with nothing left to press");
});

test("FEEDBACK-2: Not now folds to its own row, and the timer is a few seconds and not a minute", async () => {
  const feedback = await loadFeedback();
  const offer = feedback.offerProblemReport({ title: "Something", description: "x" });
  feedback.settleProblemOffer(offer, "dropped");
  feedback.foldProblemOffer(offer);
  assert.match(feedback.reportCardsMarkup(), /Kept to yourself: Something/);
  assert.ok(feedback.REPORT_FOLD_MS >= 2000 && feedback.REPORT_FOLD_MS <= 15000, `a card that folds after ${feedback.REPORT_FOLD_MS} ms is either unreadable or pinned`);
});

test("FEEDBACK-2: the box is told before the card folds, so the console never shows a decision the box has no record of", async () => {
  let tell = null;
  const feedback = await loadFeedback({
    adapter: {
      resolveProblemReport: () => new Promise((resolve) => { tell = resolve; }),
      sendProblemReport: () => Promise.resolve({}),
    },
  });
  const offer = feedback.offerProblemReport({ title: "Something", description: "x", pendingId: "pr-7" });
  const settled = feedback.settleProblemOffer(offer, "dropped");
  await new Promise((r) => setImmediate(r));
  assert.equal(offer.foldTimer, undefined, "nothing is scheduled while the box has not answered");
  tell({ resolved: true });
  await settled;
  await new Promise((r) => setImmediate(r));
  assert.notEqual(offer.foldTimer, undefined, "and the fold is scheduled once it has");
  clearTimeout(offer.foldTimer);
});

test("FEEDBACK-2: one card at a time, in the order the agent wrote them", async () => {
  const feedback = await loadFeedback({ adapter: { sendProblemReport: () => Promise.resolve({}) } });
  const first = feedback.offerProblemReport({ title: "Mobile console unusable", description: "a" });
  const second = feedback.offerProblemReport({ title: "No bot template system", description: "b" });
  const drawn = feedback.reportCardsMarkup();
  assert.match(drawn, /Mobile console unusable/);
  assert.doesNotMatch(drawn, /No bot template system/, "the second waits its turn rather than stacking");
  assert.equal(feedback.problemOfferQueue().length, 1);

  await feedback.sendProblemOffer(first.id, "a");
  feedback.foldProblemOffer(feedback.problemOfferById(first.id));
  const after = feedback.reportCardsMarkup();
  assert.match(after, /Sent to the developers: Mobile console unusable/, "the first is a quiet row where it happened");
  assert.match(after, /No bot template system/, "and the second is the card now");
  assert.ok(after.indexOf("Mobile console unusable") < after.indexOf("No bot template system"), "in order");
  assert.equal(second.status, "pending");
});

// ---- FEEDBACK-1b: the pending file is watched -----------------------------------------------------
// It used to be read exactly once, after first paint. An agent that filed while the person was
// sitting in front of the console drew its quiet row and no card, until a reload. Measured on
// grok-bot-local-vm 2026-09-09: two reports in the box's file at t+12 s, zero cards on the open
// page at 6, 12, 18, 24 and 30 s, and BOTH cards stacked after one reload.

test("FEEDBACK-1b: a report written while the page is open is drawn without a reload", async () => {
  const rows = [];
  const feedback = await loadFeedback({
    adapter: { listProblemReports: () => Promise.resolve([...rows]), resolveProblemReport: () => Promise.resolve({}) },
  });
  assert.equal((await feedback.watchPendingProblemReports(0)).length, 0, "nothing pending, nothing drawn");
  rows.push({ id: "pr-1", agentId: "titan", agentName: "Titan", report: { tier: "quality", category: "console", title: "Mobile console unusable", description: "a" } });
  const made = await feedback.watchPendingProblemReports(1_000_000);
  assert.equal(made.length, 1);
  assert.match(feedback.reportCardsMarkup(), /Mobile console unusable/);
  assert.ok(feedback.renders.count > 0, "and the transcript was redrawn for it");
});

test("FEEDBACK-1b: the watch has a floor under it, so a busy conversation does not ask the box every tick", async () => {
  let asked = 0;
  const feedback = await loadFeedback({
    adapter: { listProblemReports: () => { asked += 1; return Promise.resolve([]); } },
  });
  await feedback.watchPendingProblemReports(1_000_000);
  await feedback.watchPendingProblemReports(1_000_000 + 900);
  await feedback.watchPendingProblemReports(1_000_000 + 1800);
  assert.equal(asked, 1, "three SSE ticks inside the floor, one read of the box");
  await feedback.watchPendingProblemReports(1_000_000 + feedback.PENDING_POLL_MS + 1);
  assert.equal(asked, 2, "and one more once the floor has passed");
  assert.ok(feedback.PENDING_POLL_MS >= 1000 && feedback.PENDING_POLL_MS <= 20000, `a ${feedback.PENDING_POLL_MS} ms floor is either a hammer or a reload in disguise`);
});

test("FEEDBACK-1b: a second report arriving on the watch queues behind the first, and answering the first shows it", async () => {
  const rows = [
    { id: "pr-1", agentId: "titan", agentName: "Titan", report: { title: "Mobile console unusable", description: "a" } },
  ];
  const resolved = [];
  const feedback = await loadFeedback({
    adapter: {
      listProblemReports: () => Promise.resolve([...rows]),
      resolveProblemReport: (id, outcome) => { resolved.push([id, outcome]); return Promise.resolve({}); },
      sendProblemReport: () => Promise.resolve({ id: "fb-2" }),
    },
  });
  const first = (await feedback.watchPendingProblemReports(1_000_000))[0];
  rows.push({ id: "pr-2", agentId: "titan", agentName: "Titan", report: { title: "No bot template system", description: "b" } });
  const second = (await feedback.watchPendingProblemReports(2_000_000))[0];
  assert.equal(second.pendingId, "pr-2");
  assert.doesNotMatch(feedback.reportCardsMarkup(), /No bot template system/, "the second is written down but not drawn yet");

  await feedback.sendProblemOffer(first.id, first.body);
  feedback.foldProblemOffer(feedback.problemOfferById(first.id));
  assert.deepEqual(resolved, [["pr-1", "sent"]]);
  assert.match(feedback.reportCardsMarkup(), /No bot template system/, "answering the first brings the second forward");

  // The set that stops a report being offered twice must survive the fold, or the watch re-offers
  // what the person just answered on its next tick.
  assert.equal((await feedback.watchPendingProblemReports(3_000_000)).length, 0);
});

test("FEEDBACK-1: a send that fails leaves the card pending and says why", async () => {
  const feedback = await loadFeedback({
    adapter: { sendProblemReport: () => Promise.reject(new Error("the relay is not answering")) },
  });
  const offer = feedback.offerProblemReport({ title: "Something", description: "x" });
  await feedback.sendProblemOffer(offer.id, "x");
  const after = feedback.problemOfferById(offer.id);
  assert.equal(after.status, "pending");
  assert.match(after.note, /the relay is not answering/);
  assert.match(feedback.reportCardsMarkup(), /data-report-send/, "it is still answerable");
});

test("FEEDBACK-1: a report the agent wrote while nobody was watching is offered on load, and clears the box when answered", async () => {
  const resolved = [];
  const feedback = await loadFeedback({
    adapter: {
      listProblemReports: () => Promise.resolve([{
        id: "pr-1", at: "2026-09-09T00:00:00.000Z", agentId: "titan", agentName: "Titan",
        report: { version: 1, tier: "critical", category: "shell", title: "The shell refuses every command", description: "exec daemon not reachable", steps: ["ls /workspace"], tools: [{ name: "Shell", status: "failed", error: "exec daemon not reachable" }], at: "2026-09-09T00:00:00.000Z" },
      }]),
      resolveProblemReport: (id, outcome) => { resolved.push([id, outcome]); return Promise.resolve({}); },
      sendProblemReport: () => Promise.resolve({ id: "fb-9" }),
    },
  });
  const made = await feedback.drainPendingProblemReports();
  assert.equal(made.length, 1);
  assert.equal(made[0].pendingId, "pr-1");
  assert.match(feedback.reportCardsMarkup(), /The shell refuses every command/);
  // Read twice: a second load must not offer the same one again.
  assert.equal((await feedback.drainPendingProblemReports()).length, 0);
  await feedback.sendProblemOffer(made[0].id, made[0].body);
  assert.deepEqual(resolved, [["pr-1", "sent"]], "the box stops offering what the person answered");
});

test("FEEDBACK-1: the always-present control opens a card with nothing failed, and takes the reader to it", async () => {
  const feedback = await loadFeedback();
  feedback.openProblemReportCard();
  const drawn = feedback.reportCardsMarkup();
  assert.match(drawn, /A problem with this product/);
  assert.match(drawn, /Say what happened, what you expected/);
  assert.equal(feedback.renders.count, 1, "the card is drawn as soon as it is asked for");
  // FEEDBACK-2. The card is appended at the END of the transcript and renderTranscript only follows
  // a reader already at the bottom, so pressing this while scrolled back drew a correct card below
  // the fold. Measured on grok-bot-local-vm at 390x844: the card was on the page, 333 px wide, and
  // its Send was off screen with nothing saying where it had gone.
  assert.equal(feedback.pins, 1, "pressing the control pins the transcript to the bottom once");
});

test("FEEDBACK-1: the self-test asks for the six sections and stops teaching the boundary as a bug", async () => {
  const sent = [];
  const feedback = await loadFeedback({ adapter: { sendMessage: (context, text) => sent.push([context, text]) } });
  assert.ok(feedback.runSelfTest());
  assert.equal(sent.length, 1);
  const prompt = sent[0][1];
  for (const section of ["Shell and file I/O", "Web tools", "Connectors", "Desktop and browser", "State and memory", "Agent management"]) {
    assert.ok(prompt.includes(section), `the self-test must cover ${section}`);
  }
  assert.match(prompt, /Tool \| Status \| Error/);
  // TOOLS-READ-2: the checklist used to teach agents to file the sand-data refusal as a bug.
  assert.match(prompt, /Known and not a fault/);
  assert.match(prompt, /Do not report that refusal as a bug/);
  assert.match(prompt, /tier observation/);
});

test("FEEDBACK-1: the console's own build number is a digest of this file, not a literal", async () => {
  const feedback = await loadFeedback();
  assert.equal(feedback.consoleBuild(), null, "nothing is claimed before it has been read");
  const source = await readFile(appPath, "utf8");
  // The same computation the page does, against the same bytes.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
  assert.match(expected, /^[0-9a-f]{8}$/);
  assert.equal(expected.length, 8);
});
