/**
 * VOICE-1 item A3 and A6: the turn, and the spoken yes.
 *
 * THE SEAM THIS PINS. The brief said the bridge "speaks the reply as it streams" and that speech
 * "starts on the first sentence". Measured on grok-bot-local-vm, that is not reachable on this host:
 * Titan's reply lands as ONE complete `send-message` entry 5.5 to 25 s after sendPrompt (50.6 s on
 * a cold box), with no partial text, no isStreaming flag and no in-place growth, because the host
 * deliberately drops the SendMessage tool call from every gateway surface. So titan() is a
 * WAIT-THEN-SPLIT seam and these tests assert exactly that: the FIRST entry closes the tool call so
 * speech can start, and every later entry of the same attempt becomes an announcement rather than
 * part of the tool result. Nothing here asserts streaming, because nothing here streams.
 *
 * Everything runs on a FAKE CLOCK. A real 400 ms poll loop against a real 120 s cap would make this
 * file the slowest in the suite for no extra confidence.
 */
import { strict as assert } from "node:assert";
import net from "node:net";
import test from "node:test";
import WebSocketClient from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStubRealtime } from "./helpers/stub-realtime.mjs";
import {
  MAX_TITAN_ROUNDS, TURN_WAIT_CAP_S,
  makeCallDedupe, makeTurnRunner, makeVoiceEdge, makeVoicePolicy, matchYesNo,
  pendingCardsOf, resolveHeldCard, resolveVoiceAgent, splitSentences, toolCallsOf, writeVoiceSettings,
} from "../ui/voice-edge.mjs";

// ---- a clock and a gateway nobody has to wait for -------------------------------------------------

function fakeClock() {
  let ms = 1_700_000_000_000;
  return {
    now: () => ms,
    advance: (by) => { ms += by; },
    sleep: async (by) => { ms += by; await new Promise((resolve) => setImmediate(resolve)); },
  };
}

/**
 * A gateway that answers the five commands this wave touches, out of a scripted tail. `script` is
 * consulted on every getAgentTranscriptTail so a test can make an entry land on the Nth poll.
 */
function fakeGateway({ agents = [{ id: "a1", name: "Chief of Staff", isRunning: true }], tail = () => [], fail = null } = {}) {
  const calls = [];
  let polls = 0;
  const call = async (command, args = {}) => {
    calls.push({ command, args });
    if (typeof fail === "function") {
      const thrown = fail(command, polls);
      if (thrown != null) throw thrown;
    }
    if (command === "listAgents") return { agents };
    if (command === "sendPrompt") return { accepted: true };
    if (command === "getAgentTranscriptTail") { polls += 1; return { entries: tail(polls) }; }
    if (command === "resolveAutoReviewApproval" || command === "resolveLocalToolPermission" || command === "respondToWidget") return { ok: true };
    return {};
  };
  return {
    call, calls,
    of: (command) => calls.filter((row) => row.command === command),
    get polls() { return polls; },
  };
}

const reply = (id, content, { attemptId = "att1", at = 1_700_000_000_500 } = {}) => ({
  id, kind: "send-message", timestampMs: at, evidence: { attemptId },
  message: { type: "text", content },
});

const approvalEntry = (id, requestId, { at = 1_700_000_000_400, summary = "Send the email to Richard" } = {}) => ({
  id, kind: "send-message", timestampMs: at,
  message: { type: "auto-review-approval", approval: { requestId, status: "pending", summary, reason: "it sends mail", command: "mail send" } },
});

// ---- the round trip ------------------------------------------------------------------------------

test("one sendPrompt, carrying a voice: nonce, and the reply read from message.content", async () => {
  const clock = fakeClock();
  const gw = fakeGateway({ tail: (n) => (n >= 2 ? [reply("e1", "The team is on the deploy gate.")] : []) });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const result = await runner.run({ agentId: "a1", message: "what is the team working on" });
  assert.equal(gw.of("sendPrompt").length, 1, "exactly one prompt went in");
  const sent = gw.of("sendPrompt")[0].args;
  assert.equal(sent.agentId, "a1");
  assert.equal(sent.prompt, "what is the team working on");
  // clientNonce round-trips verbatim onto the durable user entry, so a `voice:` prefix survives a
  // reload and shows the turn as spoken on every device. No host change was needed for that.
  assert.ok(sent.clientNonce.startsWith("voice:"), `the nonce is ${sent.clientNonce}`);
  assert.equal(result.ok, true);
  // Read from message.content. Reading `.text` returns empty and looks exactly like a stall.
  assert.equal(result.text, "The team is on the deploy gate.");
  assert.deepEqual(result.pieces, ["The team is on the deploy gate."]);
});

test("the first entry closes the call and the SECOND of the same attempt is an announcement, not the result", async () => {
  const clock = fakeClock();
  const first = reply("e1", "Starting on it now.", { at: 1_700_000_000_500 });
  const second = reply("e2", "Done, the gate is green.", { at: 1_700_000_001_500 });
  let released = false;
  const gw = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    tail: (n) => (n >= 2 ? (released ? [first, second] : [first]) : []),
  });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const result = await runner.run({ agentId: "a1", message: "run the gate" });
  assert.equal(result.text, "Starting on it now.", "the FIRST entry is the tool result, so speech starts");
  assert.ok(!result.text.includes("Done"), "the second entry is NOT part of the tool result");
  // "within 20 ms of detection": t4 is the split, t3 is the detection, and on this clock nothing
  // advances between them because nothing waits.
  assert.ok(result.hops.t4 - result.hops.t3 <= 20, `the split took ${result.hops.t4 - result.hops.t3} ms`);
  assert.equal(result.attemptId, "att1");

  released = true;
  const announced = [];
  await runner.follow({
    agentId: "a1", attemptId: result.attemptId, afterId: result.afterId, afterMs: result.afterMs,
    windowMs: 5000, onAnnounce: (text) => announced.push(text),
  });
  assert.deepEqual(announced, ["Done, the gate is green."], "the later entry arrives as an announcement");
});

test("an entry of a DIFFERENT attempt is not announced under this one", async () => {
  const clock = fakeClock();
  const mine = reply("e1", "On it.", { attemptId: "att1" });
  const someoneElses = reply("e2", "Unrelated reply from another turn.", { attemptId: "att2", at: 1_700_000_001_500 });
  const gw = fakeGateway({ tail: () => [mine, someoneElses] });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const announced = [];
  await runner.follow({ agentId: "a1", attemptId: "att1", afterId: "e1", afterMs: 1_700_000_000_500, windowMs: 3000, onAnnounce: (t) => announced.push(t) });
  assert.deepEqual(announced, [], "a reply belonging to another attempt is left alone");
});

test("a turn-failed entry is SPOKEN rather than becoming silence", async () => {
  // UX-ERR-1 in one line: a failed turn that is silence is a phone line that died.
  const clock = fakeClock();
  const failed = { id: "e9", kind: "turn-failed", timestampMs: 1_700_000_000_600, text: "the model ran out of context", cause: "context_length" };
  const gw = fakeGateway({ tail: (n) => (n >= 2 ? [failed] : []) });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const result = await runner.run({ agentId: "a1", message: "summarise the repo" });
  assert.equal(result.ok, false, "a failed turn is not reported as a success");
  assert.ok(result.text.length > 0, "and it is not silence");
  assert.ok(result.text.includes("did not finish"), result.text);
  assert.ok(result.text.includes("the model ran out of context"), "the host's own words reach the person");
});

test("a gateway that never answers RETURNS a sentence and does not throw", async () => {
  const clock = fakeClock();
  const gw = fakeGateway({ fail: (command) => (command === "getAgentTranscriptTail" ? new Error("ECONNRESET") : null) });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep, waitCapS: 5 });
  // A dead socket instead of a spoken fallback is the failure AmpCortex's own reference wrote a
  // comment about, and on a microphone it is a line that died in the middle of a question.
  const result = await runner.run({ agentId: "a1", message: "anything" });
  assert.equal(result.ok, false);
  assert.ok(result.text.length > 0, "there is always something to say");
  assert.ok(/has not come back|did not/.test(result.text), result.text);
});

test("a refused sendPrompt is a sentence too", async () => {
  const clock = fakeClock();
  const gw = fakeGateway({ fail: (command) => (command === "sendPrompt" ? new Error("HTTP 503") : null) });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const result = await runner.run({ agentId: "a1", message: "anything" });
  assert.equal(result.ok, false);
  assert.ok(result.text.includes("could not get that to him"), result.text);
});

test("the third titan round in one user turn is refused, and the next user turn resets it", async () => {
  // omarchy had a max_turns in its config and nothing enforced it, and a failing launch then looped
  // every thirty seconds opening terminals after listening was already off.
  const clock = fakeClock();
  const gw = fakeGateway({ tail: (n) => (n >= 2 ? [reply(`e${n}`, "Answer.", { at: clock.now() + 1 })] : []) });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  assert.equal(MAX_TITAN_ROUNDS, 2);
  for (let i = 0; i < MAX_TITAN_ROUNDS; i += 1) {
    const ok = await runner.run({ agentId: "a1", message: `round ${i}` });
    assert.equal(ok.refused, undefined, `round ${i + 1} went through`);
  }
  const third = await runner.run({ agentId: "a1", message: "round three" });
  assert.equal(third.refused, true);
  assert.ok(third.text.includes("twice"), third.text);
  assert.equal(gw.of("sendPrompt").length, MAX_TITAN_ROUNDS, "the refused round sent nothing");
  runner.newUserTurn();
  const afterReset = await runner.run({ agentId: "a1", message: "a fresh thing" });
  assert.equal(afterReset.refused, undefined, "a new user turn gets its rounds back");
});

test("nudges are driven off the roster's own working flag, not a bare timer", async () => {
  const clock = fakeClock();
  const gw = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [] });
  const nudges = [];
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep, waitCapS: 70, firstNudgeMs: 20000 });
  await runner.run({ agentId: "a1", message: "a long one", onNudge: (text) => nudges.push(text) });
  assert.ok(nudges.length > 0 && nudges.length <= 2, `got ${nudges.length} nudges`);
  assert.ok(gw.of("listAgents").length > 0, "the roster was actually read, rather than a timer trusted");
});

test("an agent that stopped working without answering ends the wait early and says so", async () => {
  const clock = fakeClock();
  const gw = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: false }], tail: () => [] });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep, waitCapS: 120, firstNudgeMs: 1000 });
  const result = await runner.run({ agentId: "a1", message: "anything" });
  assert.equal(result.ok, false);
  assert.ok(result.text.includes("stopped working"), result.text);
  assert.ok(clock.now() - result.hops.t2 < TURN_WAIT_CAP_S * 1000, "it did not sit out the whole cap");
});

test("the outline's assistant-text is never read, at any poll", async () => {
  // Measured twice: the outline's assistant-text is narration a WHOLE TURN behind, so reading it
  // aloud would answer the previous question.
  const clock = fakeClock();
  const tail = [
    { id: "o1", kind: "assistant-text", timestampMs: 1_700_000_000_450, text: "the answer to the PREVIOUS question" },
    reply("e1", "the answer to THIS question"),
  ];
  const gw = fakeGateway({ tail: (n) => (n >= 2 ? tail : []) });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const result = await runner.run({ agentId: "a1", message: "this question" });
  assert.equal(result.text, "the answer to THIS question");
  assert.ok(!result.text.includes("PREVIOUS"), "an assistant-text entry is not a reply");
});

// ---- one call_id, dispatched once -----------------------------------------------------------------

test("one call_id offered on all three surfaces is claimed exactly once", () => {
  const dedupe = makeCallDedupe();
  assert.equal(dedupe.claim("call_a"), true);
  assert.equal(dedupe.claim("call_a"), false);
  assert.equal(dedupe.claim("call_a"), false);
  assert.equal(dedupe.size, 1);
  // An empty id is never claimable, so a malformed event cannot take the slot of a real call.
  assert.equal(dedupe.claim(""), false);
  assert.equal(dedupe.claim(undefined), false);
});

test("all three arrival surfaces are read, and they carry the same call", () => {
  const args = JSON.stringify({ message: "what is the team working on" });
  const fromArgs = toolCallsOf({ type: "response.function_call_arguments.done", call_id: "c1", name: "titan", arguments: args });
  const fromItem = toolCallsOf({ type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "titan", arguments: args } });
  const fromDone = toolCallsOf({ type: "response.done", response: { output: [{ type: "function_call", call_id: "c1", name: "titan", arguments: args }] } });
  for (const found of [fromArgs, fromItem, fromDone]) {
    assert.equal(found.length, 1);
    assert.equal(found[0].callId, "c1");
    assert.equal(found[0].name, "titan");
    assert.equal(JSON.parse(found[0].argumentsJson).message, "what is the team working on");
  }
  // A non-function item in response.done is not a tool call.
  assert.deepEqual(toolCallsOf({ type: "response.done", response: { output: [{ type: "message" }] } }), []);
});

// ---- who Titan is --------------------------------------------------------------------------------

test("the agent chain is the configured one, then a bot called Titan, then the first, then a refusal", () => {
  const roster = [
    { id: "r1", name: "Weekly Room", isGroup: true },
    { id: "a1", name: "Chief of Staff" },
    { id: "a2", name: "Titan" },
  ];
  assert.equal(resolveVoiceAgent(roster, { agentId: "a1" }).agentId, "a1");
  assert.match(resolveVoiceAgent(roster, { agentId: "a1" }).why, /chose/);
  // A chosen agent that has since left the roster is a refusal, not a silent fall-through to
  // whoever happens to be first: the person picked a specific bot.
  assert.equal(resolveVoiceAgent(roster, { agentId: "gone" }).agentId, "");
  assert.equal(resolveVoiceAgent(roster, {}).agentId, "a2", "a bot called Titan wins, the way mail's own chain does");
  assert.equal(resolveVoiceAgent([{ id: "a1", name: "Chief of Staff" }], {}).agentId, "a1");
  assert.match(resolveVoiceAgent([{ id: "a1", name: "Chief of Staff" }], {}).why, /none is called Titan/);
  // A roster of nothing but rooms has no bot to talk to, and that is a plain sentence upstream.
  assert.equal(resolveVoiceAgent([{ id: "r1", name: "Room", isGroup: true }], {}).agentId, "");
  assert.equal(resolveVoiceAgent([], {}).agentId, "");
});

// ---- sentences -----------------------------------------------------------------------------------

test("a reply is split into sentences, and a fenced block is named rather than read out", () => {
  const pieces = splitSentences("The gate is green. Two legs failed earlier, both on the roster count. I re-ran them.");
  assert.equal(pieces.length, 3);
  assert.equal(pieces[0], "The gate is green.");
  const fenced = splitSentences("Here is the config.\n\n```json\n{\"a\":1}\n```\n\nThat is all of it.");
  const asText = fenced.join(" ");
  assert.ok(!asText.includes("```"), "nobody wants three backticks read out loud");
  assert.ok(asText.includes("block of code"), asText);
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences(null), []);
  // A single very long sentence is cut at a word boundary rather than mid-word.
  const long = splitSentences(`${"word ".repeat(200)}end.`, { max: 100 });
  assert.ok(long.length > 1);
  for (const piece of long) assert.ok(piece.length <= 100, `a piece was ${piece.length} long`);
  assert.ok(!long.some((piece) => /\bwor$|\bor\b$/.test(piece)), "no piece ends mid-word");
});

// ---- held actions (A6) ---------------------------------------------------------------------------

test("a whole-utterance yes or no is matched, and \"don't confirm\" is NOT a confirm", () => {
  // session.py's own _matches exists because substring search read "don't confirm" as confirm. On
  // this path that bug closes a held action nobody approved.
  assert.equal(matchYesNo("yes")?.decision, "yes");
  assert.equal(matchYesNo("Yes, please")?.decision, "yes");
  assert.equal(matchYesNo("go ahead")?.decision, "yes");
  assert.equal(matchYesNo("send it")?.decision, "yes");
  assert.equal(matchYesNo("no")?.decision, "no");
  assert.equal(matchYesNo("don't")?.decision, "no");
  assert.equal(matchYesNo("hold off")?.decision, "no");
  // The ones that must never read as a yes.
  assert.equal(matchYesNo("don't confirm")?.decision, "no", "a negation is a NO, never a yes");
  assert.notEqual(matchYesNo("don't confirm")?.decision, "yes");
  assert.equal(matchYesNo("do not send it")?.decision, "no");
  assert.equal(matchYesNo("I am not sure, can you confirm what it would do"), null, "a whole sentence is not a decision");
  assert.equal(matchYesNo("yes I want you to also delete the old one"), null, "a yes with a rider is not a bare yes");
  assert.equal(matchYesNo(""), null);
  assert.equal(matchYesNo(null), null);
});

test("a pending card is read out of the tail, and a settled one is not", () => {
  const pending = pendingCardsOf([approvalEntry("e1", "req1")]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "auto-review");
  assert.equal(pending[0].requestId, "req1");
  assert.equal(pending[0].entryId, "e1");
  assert.ok(pending[0].title.includes("Richard"));
  // Already answered, so there is nothing to ask about.
  const settled = [{ id: "e1", kind: "send-message", message: { type: "auto-review-approval", approval: { requestId: "req1", status: "approved", summary: "x" } } }];
  assert.deepEqual(pendingCardsOf(settled), []);
  // A local-tool ask and a widget, the other two kinds a spoken answer can close.
  const ask = pendingCardsOf([{ id: "e2", kind: "send-message", message: { type: "local-tool-permission", ask: { requestId: "r2", status: "pending", action: "Run", target: "psql" } } }]);
  assert.equal(ask[0].kind, "local-tool");
  const widget = pendingCardsOf([{ id: "e3", kind: "send-message", message: { type: "widget", widget: { prompt: "Which one?", options: ["a", "b"] } } }]);
  assert.equal(widget[0].kind, "widget");
  assert.deepEqual(widget[0].options, ["a", "b"]);
  // An answered widget carries the host's own stamp and is not pending.
  assert.deepEqual(pendingCardsOf([{ id: "e3", kind: "send-message", respondedValue: "a", message: { type: "widget", widget: { prompt: "Which one?" } } }]), []);
  // A credential request is deliberately NOT here: it takes a masked value, and there is no spoken
  // answer that could be one.
  assert.deepEqual(pendingCardsOf([{ id: "e4", kind: "send-message", message: { type: "secret-request", secretRequest: { field: "token" } } }]), []);
});

test("a card is re-read immediately before it is resolved, and an expired one reports no success", async () => {
  // An unknown requestId throws SAND_AUTO_REVIEW_STALE and every pending approval expires at
  // session end. Reporting success for a command that never ran is the worst outcome in this wave.
  const card = { kind: "auto-review", entryId: "e1", requestId: "req1" };
  const live = fakeGateway({ tail: () => [approvalEntry("e1", "req1")] });
  const ok = await resolveHeldCard({ call: live.call, agentId: "a1", card, decision: "yes" });
  assert.equal(ok.ok, true);
  assert.equal(live.of("resolveAutoReviewApproval").length, 1);
  assert.deepEqual(live.of("resolveAutoReviewApproval")[0].args, { agentId: "a1", entryId: "e1", requestId: "req1", resolution: "approved" });
  // The read happened BEFORE the resolve, which is the whole point of re-reading.
  assert.equal(live.calls[0].command, "getAgentTranscriptTail");

  const gone = fakeGateway({ tail: () => [] });
  const expired = await resolveHeldCard({ call: gone.call, agentId: "a1", card, decision: "yes" });
  assert.equal(expired.ok, false, "no success is reported");
  assert.ok(expired.said.includes("already closed"), expired.said);
  assert.equal(gone.of("resolveAutoReviewApproval").length, 0, "and nothing was sent");
});

test("a no goes through as a denial, and a failed resolve says so rather than claiming success", async () => {
  const card = { kind: "auto-review", entryId: "e1", requestId: "req1" };
  const gw = fakeGateway({ tail: () => [approvalEntry("e1", "req1")] });
  const denied = await resolveHeldCard({ call: gw.call, agentId: "a1", card, decision: "no" });
  assert.equal(denied.ok, true);
  assert.equal(gw.of("resolveAutoReviewApproval")[0].args.resolution, "denied");

  const broken = fakeGateway({ tail: () => [approvalEntry("e1", "req1")], fail: (command) => (command === "resolveAutoReviewApproval" ? new Error("HTTP 409") : null) });
  const failed = await resolveHeldCard({ call: broken.call, agentId: "a1", card, decision: "yes" });
  assert.equal(failed.ok, false);
  assert.ok(failed.said.includes("did not reach"), failed.said);
});

test("a local-tool ask and a widget are closed with their own vocabularies", async () => {
  const askEntry = { id: "e2", kind: "send-message", message: { type: "local-tool-permission", ask: { requestId: "r2", status: "pending", action: "Run", target: "psql" } } };
  const gw = fakeGateway({ tail: () => [askEntry] });
  await resolveHeldCard({ call: gw.call, agentId: "a1", card: { kind: "local-tool", entryId: "e2", requestId: "r2" }, decision: "yes" });
  assert.equal(gw.of("resolveLocalToolPermission")[0].args.resolution, "allow");

  const widgetEntry = { id: "e3", kind: "send-message", message: { type: "widget", widget: { prompt: "Which?", options: ["the first", "the second"] } } };
  const gw2 = fakeGateway({ tail: () => [widgetEntry] });
  await resolveHeldCard({ call: gw2.call, agentId: "a1", card: { kind: "widget", entryId: "e3", requestId: "", options: ["the first", "the second"] }, decision: "yes" });
  assert.deepEqual(gw2.of("respondToWidget")[0].args, { entryId: "e3", value: "the first", agentId: "a1" });
});

test("two pending cards are not guessed between, and the turn names them", async () => {
  const clock = fakeClock();
  const both = [approvalEntry("e1", "req1", { summary: "Send the email" }), approvalEntry("e2", "req2", { summary: "Restart the box" })];
  const gw = fakeGateway({ tail: (n) => (n >= 2 ? both : []) });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const result = await runner.run({ agentId: "a1", message: "what needs me" });
  assert.equal(result.card.kind, "many", "two cards is never resolved by guessing");
  assert.equal(result.card.count, 2);
  assert.deepEqual(result.card.cards.map((c) => c.requestId), ["req1", "req2"]);
});

// ---- the whole session, through a real stub and a real ws client ----------------------------------
//
// The harness below is duplicated in tests/voice-caps-ledger.test.mjs rather than shared, because
// this wave owns exactly one test helper (tests/helpers/stub-realtime.mjs, which item C imports) and
// adding a second would put a file in two waves' hands.

async function openSession({ stub, settings, gateway, dir }) {
  await writeVoiceSettings(settings, { file: path.join(dir, "voice.json") });
  const t = {
    slug: "acme", name: "Acme", operator: false,
    gateway: "http://127.0.0.1:1/unused",
    headers: () => ({}),
    ensureDir: () => {},
    voiceSettingsFile: path.join(dir, "voice.json"),
    voiceLedgerFile: path.join(dir, "voice-minutes.jsonl"),
  };
  // The relay's own log is kept, not thrown away: a gate that times out has to be able to say what
  // the relay thought was happening, or the next person debugs it by guessing.
  const logLines = [];
  const edge = makeVoiceEdge({
    t, call: gateway.call, policy: makeVoicePolicy({}), providerUrl: stub.url,
    log: (line) => logLines.push(String(line)),
  });
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  server.on("upgrade", () => {});
  server.on("connection", (socket) => {
    let head = "";
    const onData = (chunk) => {
      head += String(chunk);
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const headers = Object.fromEntries(head.split("\r\n").slice(1).filter((l) => l.includes(":"))
        .map((line) => [line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
        edge.handleUpgrade({ headers, method: "GET", url: "/voice/socket" }, socket, null, { origin: null })
        .catch((error) => logLines.push(`handleUpgrade threw: ${error?.stack ?? error}`));
    };
    socket.on("data", onData);
  });
  const client = new WebSocketClient(`ws://127.0.0.1:${port}/voice/socket`);
  const frames = { json: [], binary: [], log: logLines };
  client.on("message", (data, isBinary) => {
    if (isBinary) frames.binary.push(Buffer.from(data));
    else { try { frames.json.push(JSON.parse(String(data))); } catch { /* not JSON */ } }
  });
  await new Promise((resolve, reject) => {
    client.on("open", resolve);
    client.on("error", reject);
    const timer = setTimeout(() => reject(new Error("the voice socket never opened")), 6000);
    timer.unref();
  });
  const settle = async (predicate, label, tries = 200) => {
    for (let i = 0; i < tries; i += 1) {
      if (predicate()) return true;
      await new Promise((r) => { const timer = setTimeout(r, 20); timer.unref(); });
    }
    throw new Error([
      `timed out waiting for ${label}.`,
      `  frames to the page: ${JSON.stringify(frames.json).slice(0, 600)}`,
      `  the relay said: ${logLines.join(" | ").slice(0, 600)}`,
      `  the provider saw: ${JSON.stringify(stub.events.inbound).slice(0, 600)}`,
      `  the provider refused: ${JSON.stringify(stub.events.refusals)}`,
      `  counts: sessions=${stub.events.sessions.length} toolOutputs=${stub.events.toolOutputs.length} responseCreates=${stub.events.responseCreates} prompts=${gateway.of("sendPrompt").length}`,
    ].join("\n"));
  };
  return {
    client, frames, edge, settle,
    of: (kind) => frames.json.filter((f) => f.t === kind),
    close: async () => { client.terminate(); await new Promise((resolve) => server.close(resolve)); },
  };
}

test("a call_id on all three surfaces produces exactly ONE sendPrompt, end to end", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    // Empty on the BASELINE read and only then the reply. A fixture whose tail already holds the
    // answer before the prompt goes in is testing nothing: the runner anchors on the last entry it
    // saw before sending, exactly so an old reply is never read as a new one.
    tail: (n) => (n >= 2 ? [reply("e1", "We are on the deploy gate.")] : []),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0001" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    // ONE call, put on all three surfaces the way xAI really does it.
    stub.emitToolCall({ name: "titan", args: { message: "what is the team working on" }, triple: true });
    await session.settle(() => gateway.of("sendPrompt").length > 0, "the prompt into Titan's conversation");
    await session.settle(() => stub.events.toolOutputs.length > 0, "the tool output going back");
    // The whole point: three events, one prompt. Twice would put the sentence into his conversation
    // twice and he would answer it twice.
    assert.equal(gateway.of("sendPrompt").length, 1, `sendPrompt was called ${gateway.of("sendPrompt").length} times`);
    assert.ok(gateway.of("sendPrompt")[0].args.clientNonce.startsWith("voice:"));
    // The reply goes back as a function_call_output, which is FREE on xAI; a conversation.item.create
    // carrying it would be a billed text event per sentence.
    assert.equal(stub.events.toolOutputs.length, 1);
    assert.equal(JSON.parse(stub.events.toolOutputs[0].output).reply, "We are on the deploy gate.");
    assert.equal(stub.events.billableItems, 0, "Titan's reply cost no billed text items");
    // And the page was told what it heard and what was said, as ordinary rows.
    assert.equal(session.of("heard").at(-1).text, "what is the team working on");
    assert.equal(session.of("said").at(-1).text, "We are on the deploy gate.");
    assert.ok(session.of("state").some((f) => f.value === "thinking"), "the orb said thinking while he worked");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool call that is not titan is answered rather than dropped, and no prompt is sent", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0002" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    // The provider socket has to be UP before the stub can emit into it: the ready frame goes to the
    // page before the dial completes, so emitting on ready alone drops the event on the floor.
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    stub.emitToolCall({ name: "web_search", args: { q: "anything" }, triple: false });
    await session.settle(() => stub.events.toolOutputs.length > 0, "the refusal going back as an output");
    assert.equal(gateway.of("sendPrompt").length, 0, "a tool this bridge does not have reaches nothing");
    assert.match(JSON.parse(stub.events.toolOutputs[0].output).error, /no such tool/);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a spoken yes in the SAME turn as its own question is refused and needs a new user turn", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: (n) => (n >= 2 ? [approvalEntry("e1", "req1")] : []) });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0003" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    // The provider socket has to be UP before the stub can emit into it: the ready frame goes to the
    // page before the dial completes, so emitting on ready alone drops the event on the floor.
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    // Turn one: the card is read out as a question.
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "anything pending" }, callId: "c1", triple: false });
    await session.settle(() => stub.events.toolOutputs.length >= 1, "the card spoken back");
    assert.match(JSON.parse(stub.events.toolOutputs[0].output).reply, /Richard/, "the held action was read out as a question");
    // A yes arriving without a new user turn in between is refused: the model must not talk itself
    // into a confirmation for an action the person never answered.
    stub.emitToolCall({ name: "titan", args: { message: "yes" }, callId: "c2", triple: false });
    await session.settle(() => stub.events.toolOutputs.length >= 2, "the refusal of the same-turn yes");
    assert.match(JSON.parse(stub.events.toolOutputs[1].output).reply, /Say that again/);
    assert.equal(gateway.of("resolveAutoReviewApproval").length, 0, "nothing was closed");
    // Now a NEW user turn, and the same yes goes through.
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "yes" }, callId: "c3", triple: false });
    await session.settle(() => gateway.of("resolveAutoReviewApproval").length > 0, "the approval closing through the existing path");
    assert.equal(gateway.of("resolveAutoReviewApproval")[0].args.resolution, "approved");
    // Never a second gate: the command is the one the console's own buttons call.
    assert.equal(gateway.of("resolveAutoReviewApproval")[0].args.requestId, "req1");
    assert.match(JSON.parse(stub.events.toolOutputs[2].output).reply, /req1/, "the yes quotes back what it closed");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("\"don't confirm\" spoken at a pending card closes nothing as approved", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: (n) => (n >= 2 ? [approvalEntry("e1", "req1")] : []) });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0004" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    // The provider socket has to be UP before the stub can emit into it: the ready frame goes to the
    // page before the dial completes, so emitting on ready alone drops the event on the floor.
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "anything pending" }, callId: "c1", triple: false });
    await session.settle(() => stub.events.toolOutputs.length >= 1, "the card spoken back");
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "don't confirm" }, callId: "c2", triple: false });
    await session.settle(() => gateway.of("resolveAutoReviewApproval").length > 0, "the denial");
    assert.equal(gateway.of("resolveAutoReviewApproval")[0].args.resolution, "denied", "a negation is a denial and never an approval");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================== VOICE-7: the panel's own frames
//
// The `heard` frame has been on this wire since VOICE-1 and it carried THREE different things under
// one shape -- a partial transcript, the transcript the service settled on, and the string actually
// handed to Titan -- with nothing to tell them apart. A one-line caption strip could paint all three
// the same way; a panel that has to open, follow the words and then DISSOLVE cannot. These run end to
// end against the real bridge so the labels are measured on the wire rather than read off a diff.

test("VOICE-7: a turn reaches the page as open, partials, then ONE final carrying the row's own id", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    tail: (n) => (n >= 2 ? [reply("e1", "We are on the deploy gate.")] : []),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0007" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");

    stub.emitSpeechStart();
    await session.settle(() => session.of("hear-begin").length > 0, "the panel being opened");
    const opened = session.of("hear-begin").at(-1);
    assert.equal(opened.turn, 1, "the panel opens stamped with the utterance it belongs to");
    assert.equal(session.of("hear").length, 0, "and with no words, which is also all a service that sends none ever gives");

    // xAI's transcript is CUMULATIVE and self-correcting, so each of these carries the whole sentence
    // so far. The relay normalises it to replace-whole before it reaches the page.
    stub.emitUserTranscript("what is");
    stub.emitUserTranscript("what is the team");
    stub.emitUserTranscript("what is the team working on");
    await session.settle(() => session.of("hear").length >= 3, "three partials");
    const partials = session.of("hear").map((f) => f.text);
    assert.deepEqual(partials.slice(0, 3), ["what is", "what is the team", "what is the team working on"],
      "the words arrive as whole sentences to replace, not as pieces to append");
    assert.ok(session.of("hear").every((f) => f.turn === 1));
    assert.ok(session.of("hear").slice(0, 3).every((f) => f.final === false), "none of those is the settled one");

    // The settled transcript is ANOTHER PARTIAL on purpose: it races the tool call below, and a panel
    // that dissolved here would flash back open a moment later.
    stub.emitUserTranscriptDone("what is the team working on");
    await session.settle(() => session.of("hear").some((f) => f.final === true), "the settled transcript");
    assert.equal(session.of("hear-end").length, 0,
      "the settled transcript must not end the turn: the tool call does");
    assert.equal(session.of("heard-confirmed").length, 0);

    stub.emitSpeechStop();
    stub.emitToolCall({ name: "titan", args: { message: "what is the team working on" }, triple: true });
    await session.settle(() => session.of("heard-confirmed").length > 0, "the confirmation");
    const finals = session.of("heard-confirmed");
    assert.equal(finals.length, 1, "one call_id on three surfaces is still ONE confirmation, or the panel would dissolve twice");
    assert.equal(finals[0].landed, true, "these bytes become a row in the conversation");
    assert.equal(finals[0].text, "what is the team working on");
    // And the turn is closed exactly once, which is what actually takes the panel away.
    await session.settle(() => session.of("hear-end").length > 0, "the turn being closed");
    assert.equal(session.of("hear-end").length, 1);
    assert.equal(session.of("hear-end")[0].reason, "sent");

    // THE SAME BYTES. This is the whole promise: the last words the panel shows are the string the
    // relay handed to Titan, under the id the durable row will carry.
    await session.settle(() => gateway.of("sendPrompt").length > 0, "the prompt into Titan's conversation");
    const prompt = gateway.of("sendPrompt")[0].args;
    assert.equal(finals[0].text, prompt.prompt, "the panel's last words and the row are not the same bytes");
    assert.equal(finals[0].nonce, prompt.clientNonce, "the page cannot tell which row its panel became");
    assert.match(finals[0].nonce, /^voice:/, "gateway-adapter.js reads that prefix to draw the spoken chip");
    // The id is the session plus a counter, not a bare millisecond clock: two sessions started in the
    // same millisecond would otherwise mint the same one.
    assert.match(finals[0].nonce, /^voice:[^:]+:1$/);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-7: one utterance's words never bleed into the next one", async () => {
  // MEASURED on this Mac (node v22.23.1) 2026-09-10, driving makeCaption directly: on the incremental
  // service the accumulator was reset ONLY by the settled-transcript event, so an utterance whose
  // completion never arrived bled into the next -- "open the box" then "what time is it" read "open
  // the boxwhat time is it". A one-line strip hid that. A panel shows it for the whole of the second
  // utterance. The reset belongs on the utterance boundary, which is the speech-started event.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "openai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "openai", apiKey: "sk-test-key-0008" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");

    stub.emitSpeechStart();
    stub.emitUserTranscript("open ");
    stub.emitUserTranscript("the box");
    await session.settle(() => session.of("hear").some((f) => f.text === "open the box"), "the first utterance");
    // No settled transcript at all for that one, which is the case the defect needed.
    stub.emitSpeechStart();
    stub.emitUserTranscript("what ");
    stub.emitUserTranscript("time is it");
    await session.settle(() => session.of("hear").some((f) => f.turn === 2 && f.text.length > 0), "the second utterance");
    const second = session.of("hear").filter((f) => f.turn === 2).map((f) => f.text);
    assert.deepEqual(second, ["what ", "what time is it"], `the second utterance read ${JSON.stringify(second)}`);
    assert.ok(!second.some((one) => one.includes("box")), "the first utterance bled into the second");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-7: a transcription that gives up takes the panel away instead of leaving a half sentence over the chat", async () => {
  // Handled nowhere in the bridge until VOICE-7. With a panel on screen it is the difference between
  // a turn that ends and somebody's half sentence sitting over their conversation with nothing ever
  // coming to finish it.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0009" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    stub.emitSpeechStart();
    stub.emitUserTranscript("half a sent");
    await session.settle(() => session.of("hear").length > 0, "a partial");
    stub.emitUserTranscriptFailed();
    await session.settle(() => session.of("hear-end").length > 0, "the panel being taken away");
    const final = session.of("hear-end").at(-1);
    assert.equal(final.reason, "no-words", "the turn ends, and says which of the ways it could end this was");
    assert.equal(session.of("heard-confirmed").length, 0, "nothing was confirmed, so the panel has no row to wait for");
    assert.equal(gateway.of("sendPrompt").length, 0, "nothing reached Titan's conversation");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-7: a spoken yes that closes a card says plainly that no row is coming", async () => {
  // A whole-utterance yes while a card is on the table goes through the approval the console already
  // draws; it never becomes a line of prose. A panel that waited for a row here would hang on every
  // approval somebody answered out loud.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    tail: (n) => (n >= 2 ? [approvalEntry("e1", "req1")] : []),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0010" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    // Turn one puts the card on the table.
    stub.emitSpeechStart();
    stub.emitToolCall({ name: "titan", args: { message: "deploy the relay" }, callId: "call_one", triple: false });
    await session.settle(() => session.of("said").length > 0, "the card read out as a question");
    const firstFinal = session.of("heard-confirmed").at(-1);
    assert.equal(firstFinal.landed, true, "turn one did become a row");

    // TURN TWO WAITS FOR THE MICROPHONE TO BE OPEN AGAIN, which is not ceremony: the relay holds the
    // microphone shut for the whole of Titan reading the card out plus the echo tail, and refuses to
    // open a panel in that window, because words arriving then are his own coming back through the
    // speaker. So a yes spoken over the top of him is not heard by anybody, here or in a real room.
    // Measured on this Mac: without this wait the second turn's frames were suppressed and the test
    // was asserting against a panel the relay had correctly never opened.
    await session.settle(() => session.of("speak-end").length > 0, "Titan finishing the question");
    const holdUntil = Number(session.of("speak-end").at(-1).holdUntilMs ?? 0);
    await new Promise((resolve) => { const t = setTimeout(resolve, Math.max(0, holdUntil - Date.now()) + 60); t.unref(); });

    // Turn two is the answer, and it closes the card rather than becoming prose.
    stub.emitSpeechStart();
    await session.settle(() => session.of("hear-begin").length >= 2, "the panel opening for the answer");
    stub.emitToolCall({ name: "titan", args: { message: "yes" }, callId: "call_two", triple: false });
    await session.settle(() => session.of("hear-end").length >= 2, "the answer's own closing frame");
    const answer = session.of("hear-end").at(-1);
    assert.equal(answer.reason, "answered-card", "no row is coming, and the panel must not wait for one");
    assert.equal(session.of("heard-confirmed").length, 1, "the yes was not confirmed as a row, because it never became one");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-7: an empty utterance is a turn that ends, not a panel left open", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0011" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    stub.emitSpeechStart();
    stub.emitToolCall({ name: "titan", args: { message: "   " }, triple: false });
    await session.settle(() => session.of("hear-end").length > 0, "the turn ending");
    const final = session.of("hear-end").at(-1);
    assert.equal(final.reason, "empty");
    assert.equal(session.of("heard-confirmed").length, 0);
    assert.equal(gateway.of("sendPrompt").length, 0);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
