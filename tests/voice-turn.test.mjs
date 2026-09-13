/**
 * VOICE-1 item A3 and A6: the turn, and the spoken yes. VOICE-3: the reply arriving in sentences.
 *
 * THE SEAM THIS PINS, AND HOW IT MOVED. VOICE-1 measured that Titan's reply lands as ONE complete
 * `send-message` entry 5.5 to 25 s after sendPrompt (50.6 s on a cold box), with no partial text and
 * no in-place growth on ANY gateway surface, so titan() was a WAIT-THEN-SPLIT seam and this file said
 * in writing that nothing here streams. VOICE-3 built the missing surface: the host now projects the
 * message the agent is part way through writing behind the `getTurnDraft` command
 * (source/host/extensions/transcript/turn-draft.ts), and the runner reads it on the same 400 ms tick
 * it already polls the tail on.
 *
 * So BOTH shapes are pinned here now. The wait-then-split path is unchanged and still proved, because
 * it is what every box without that host bundle does and what every desktop call with no draft does;
 * and the streaming path is proved beside it -- the lead sentence handed out the moment it is whole, and
 * a tool output that carries only what is LEFT so the front of the answer is never said twice.
 *
 * VOICE-16b CAPPED THE READING AT THAT ONE SENTENCE. Jason, after the first working call: "it needs to be
 * shorter and more conversational ... less like a syllabus coming back every time." So the assertions
 * about how many sentences are read out, how many text items that costs and how many response.create go
 * with them all moved in this wave, each one with the reason in its own message; and the tool output now
 * carries the remainder plus one line asking for it short. The text on screen did not move at all, which
 * is why every `said` frame in here still carries the whole reply.
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
  CARD_WATCH_MS, GREETINGS, MAX_TITAN_ROUNDS, SPOKEN_LEAD_SENTENCES, SPOKEN_REMAINDER_HINT,
  TURN_WAIT_CAP_S, VOICE_NOTE_MAX_CHARS, VOICE_NOTE_WRITE_MS, cardQuestion, fileCallNote, pickGreeting,
  isUnknownGatewayMethod, makeCallDedupe, makeSentenceCutter, makeSpokenExchange, makeTurnRunner,
  makeVoiceEdge, makeVoicePolicy, matchYesNo, pendingCardsOf, phoneLineInstructions, readVoiceBrief,
  remainderOf, resolveHeldCard, resolveVoiceAgent, splitSentences, titanTool, toolCallsOf,
  voiceCallNote, voiceInstructions, writeVoiceSettings,
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
 *
 * VOICE-3 adds `draft`, consulted on every getTurnDraft the same way: `draft(nthDraftRead, nonce)`
 * answers the projection the host would hand out, or null for "no turn open". A box whose host does
 * not carry the command is spelled `draft: "unknown"`, which throws the 404 the real gateway throws.
 */
function fakeGateway({ agents = [{ id: "a1", name: "Chief of Staff", isRunning: true }], tail = () => [], fail = null, draft = null, brief = null, note = null } = {}) {
  const calls = [];
  let polls = 0;
  let draftReads = 0;
  let briefReads = 0;
  let noteWrites = 0;
  const call = async (command, args = {}) => {
    calls.push({ command, args });
    if (typeof fail === "function") {
      const thrown = fail(command, polls);
      if (thrown != null) throw thrown;
    }
    if (command === "listAgents") return { agents };
    if (command === "sendPrompt") return { accepted: true };
    if (command === "getAgentTranscriptTail") { polls += 1; return { entries: tail(polls) }; }
    if (command === "getTurnDraft") {
      draftReads += 1;
      if (draft === "unknown") throw new Error("getTurnDraft answered HTTP 404: unknown gateway method: getTurnDraft");
      return { draft: typeof draft === "function" ? draft(draftReads, args) : null };
    }
    // VOICE-16. The same two shapes as the draft: `"unknown"` is a host that predates the command and
    // throws the 404 the real gateway throws; anything else is what the host would hand out, and null
    // is a box that does not hold that agent. The DEFAULT IS null, so every test written before this
    // wave still exercises the phone line it was written against.
    if (command === "getVoiceBrief") {
      briefReads += 1;
      if (brief === "unknown") throw new Error("getVoiceBrief answered HTTP 404: unknown gateway method: getVoiceBrief");
      return { brief: typeof brief === "function" ? brief(args, briefReads) : brief };
    }
    // VOICE-16c. The write that files a note and runs no turn. `"unknown"` is a host that predates the
    // command and throws the 404 the real gateway throws, which is the ONLY condition the relay falls
    // back to sendPrompt on. The DEFAULT is the host's own success shape, so a test that does not care
    // how the note travelled still gets the new path.
    if (command === "appendTranscriptNote") {
      noteWrites += 1;
      if (note === "unknown") throw new Error("appendTranscriptNote answered HTTP 404: unknown gateway method: appendTranscriptNote");
      if (typeof note === "function") return note(args, noteWrites);
      return note ?? { filed: true, entryId: `t${noteWrites}u`, duplicate: false };
    }
    if (command === "resolveAutoReviewApproval" || command === "resolveLocalToolPermission" || command === "respondToWidget") return { ok: true };
    return {};
  };
  return {
    call, calls,
    of: (command) => calls.filter((row) => row.command === command),
    get polls() { return polls; },
    get draftReads() { return draftReads; },
    get briefReads() { return briefReads; },
    get noteWrites() { return noteWrites; },
  };
}

/** The shape source/host/extensions/transcript/voice-brief.ts projects. */
const briefRow = ({
  persona = "You run a two-person managed services shop with Richard.",
  facts = ["the deploy gate runs on the R750", "Richard Avery is the business partner"],
  recent = [
    { role: "person", text: "did the gate go green in the end", at: 1_700_000_000_000 },
    { role: "agent", text: "it did, both legs passed on the second run", at: 1_700_000_000_100 },
  ],
  agentName = "Titan",
  workspaceName = "Acme",
} = {}) => ({ persona, facts, recent, agentName, workspaceName });

/** The shape source/host/extensions/transcript/turn-draft.ts projects. */
const draftRow = (text, { nonce = "", complete = false, turnId = "att1", turnEpoch = 1 } = {}) => ({
  conversationId: "a1", turnId, turnEpoch, clientNonce: nonce.length > 0 ? nonce : null,
  text, complete, sends: complete ? 1 : 0, updatedAtMs: 1_700_000_000_200,
});

/**
 * The same gateway, with `sendPrompt` held open until the test lets it go. That is the only way to
 * reproduce what always-listening does every single call: Titan takes 5.5 to 25 s to answer, and the
 * next utterance begins inside that window.
 */
function gatewayHoldingSend(options = {}) {
  const gw = fakeGateway(options);
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  const call = async (command, args = {}) => {
    if (command === "sendPrompt") { const answer = await gw.call(command, args); await held; return answer; }
    return gw.call(command, args);
  };
  return { ...gw, call, of: gw.of, release: () => release() };
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

// ---- VOICE-3: the reply arriving in sentences -----------------------------------------------------

test("the cutter hands out whole sentences only, once each, and holds the trailing fragment back", () => {
  const cutter = makeSentenceCutter();
  // Nothing yet: one fragment with nothing behind it could be a short sentence or the first four
  // words of a long one, and reading it out is how a voice says half a thought.
  assert.deepEqual(cutter.cut("The gate is"), []);
  assert.deepEqual(cutter.cut("The gate is green."), [], "a terminator with nothing behind it still waits");
  assert.deepEqual(cutter.cut("The gate is green. Two legs"), ["The gate is green."]);
  assert.deepEqual(cutter.cut("The gate is green. Two legs failed."), [], "nothing new is whole yet");
  assert.deepEqual(cutter.cut("The gate is green. Two legs failed. I re-ran"), ["Two legs failed."]);
  // The host says the message is finished, so the last piece has no doubt left in it.
  assert.deepEqual(cutter.cut("The gate is green. Two legs failed. I re-ran them.", { complete: true }), ["I re-ran them."]);
  assert.deepEqual(cutter.spoken, ["The gate is green.", "Two legs failed.", "I re-ran them."]);
  assert.equal(cutter.count, 3);
  // And a repeat read of the same draft says nothing twice.
  assert.deepEqual(cutter.cut("The gate is green. Two legs failed. I re-ran them.", { complete: true }), []);
});

test("VOICE-16b: a cutter with a limit hands out that many sentences and then nothing, ever", () => {
  // THE LIMIT IS WHY `spoken` CAN BE TRUSTED. remainderOf subtracts `spoken` from the finished reply to
  // work out what the person has not heard, so a cutter that cut three sentences while the caller spoke
  // one would record two sentences as said that nobody ever heard, and the tool output would skip them.
  // So the cap refuses to cut them rather than cutting and discarding.
  const cutter = makeSentenceCutter({ limit: 1 });
  assert.deepEqual(cutter.cut("The gate is green. Two legs"), ["The gate is green."]);
  assert.equal(cutter.done, true, "one sentence is the whole of what this cutter will ever hand out");
  // A draft that grew by two whole sentences in one tick still hands out nothing: the person heard one.
  assert.deepEqual(cutter.cut("The gate is green. Two legs failed. I re-ran them.", { complete: true }), [],
    "the limit holds even when the draft arrives whole in one tick");
  assert.deepEqual(cutter.spoken, ["The gate is green."], "and `spoken` is exactly what was said out loud");
  assert.equal(cutter.count, 1);
  // The default is unchanged, which is what keeps the helper honest for any other caller.
  assert.equal(makeSentenceCutter().done, false);
});

test("the remainder is what is LEFT of the finished reply, and a revised draft is repaired from the change", () => {
  const all = ["One.", "Two.", "Three."];
  assert.deepEqual(remainderOf(all, []), { pieces: all, diverged: false });
  assert.deepEqual(remainderOf(all, ["One."]), { pieces: ["Two.", "Three."], diverged: false });
  assert.deepEqual(remainderOf(all, all), { pieces: [], diverged: false });
  // The model rewrote sentence two while it was still writing. Sentence one was said and is right;
  // everything from the change onwards is still owed, and the caller is told it diverged.
  assert.deepEqual(
    remainderOf(all, ["One.", "Twwo."]),
    { pieces: ["Two.", "Three."], diverged: true },
  );
  assert.deepEqual(remainderOf([], ["One."]), { pieces: [], diverged: true });
});

test("only a 404 turns the draft reader off; a timeout does not", () => {
  assert.equal(isUnknownGatewayMethod(new Error("getTurnDraft answered HTTP 404: unknown gateway method: getTurnDraft")), true);
  assert.equal(isUnknownGatewayMethod(new Error("unknown gateway method: getTurnDraft")), true);
  assert.equal(isUnknownGatewayMethod(new Error("The operation was aborted due to timeout")), false);
  assert.equal(isUnknownGatewayMethod(new Error("getTurnDraft answered HTTP 503: upstream busy")), false);
  assert.equal(isUnknownGatewayMethod(null), false);
});

test("VOICE-16b: the FIRST sentence is read out as it lands and the rest of the answer is not", async () => {
  // WHAT THIS USED TO ASSERT, AND WHY IT MOVED. Until VOICE-16b every whole sentence of the draft was
  // handed over as "read this out, word for word", so a three-sentence answer was read like a report.
  // Jason, 2026-09-12, after the first working call: "it needs to be shorter and more conversational
  // ... less like a syllabus coming back every time." So the lead sentence still goes out the instant
  // it is whole -- that is the twenty-second latency win and it is untouched -- and sentences two and
  // three are left to the model to say short, through the tool output.
  const clock = fakeClock();
  const whole = "The gate is green. Two legs failed earlier. I re-ran both of them.";
  // The draft grows over three reads and the finished entry lands on the fifth tail poll, which is
  // the real ordering: the host writes the partial tool call long before the entry is persisted.
  const steps = ["The gate is green. Two", "The gate is green. Two legs failed earlier. I", whole];
  let nonceSeen = "";
  const gw = fakeGateway({
    tail: (n) => (n >= 5 ? [reply("e1", whole)] : []),
    draft: (n, args) => {
      nonceSeen = String(args.id ?? "");
      const text = steps[Math.min(n, steps.length) - 1];
      return draftRow(text, { nonce: draftNonce, complete: n >= steps.length });
    },
  });
  let draftNonce = "";
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  // The runner mints the nonce itself, so the fixture is told it the way the host would learn it.
  const spoken = [];
  const result = await runner.run({
    agentId: "a1", message: "how did the gate go",
    onSent: ({ nonce }) => { draftNonce = nonce; },
    onDraftSentence: (sentence) => { spoken.push(sentence); },
  });
  assert.equal(nonceSeen, "a1", "the draft is asked for by agent id");
  assert.deepEqual(spoken, ["The gate is green."],
    `spoken was ${JSON.stringify(spoken)}; only the lead sentence is ever read out word for word now`);
  assert.deepEqual(result.spoken, spoken);
  assert.deepEqual(result.remaining, ["Two legs failed earlier.", "I re-ran both of them."],
    "sentences two and three are what the tool output carries, for the model to say short");
  assert.equal(result.diverged, false);
  // The whole reply is still the result, because the panel and the conversation hold the whole reply.
  assert.equal(result.text, whole);
  assert.deepEqual(result.pieces, splitSentences(whole));
  // And the box stops being asked for a draft once the lead sentence is out: there is nothing left it
  // could be read for. One read is the one that produced the sentence.
  assert.equal(gw.draftReads, 1, `getTurnDraft was read ${gw.draftReads} times after the lead sentence`);
  // THE WIN, and the only number in this file that is about latency: the first sentence was handed
  // over BEFORE the finished entry was ever seen.
  assert.ok(result.hops.td > 0, "td was never stamped");
  assert.ok(result.hops.td < result.hops.t3, `td ${result.hops.td} was not before t3 ${result.hops.t3}`);
});

test("a draft the person is half way through hearing leaves the rest of the reply to the tool output", async () => {
  const clock = fakeClock();
  const whole = "The gate is green. Two legs failed earlier. I re-ran both of them.";
  let draftNonce = "";
  const gw = fakeGateway({
    // The entry lands while the draft is still only one sentence old.
    tail: (n) => (n >= 3 ? [reply("e1", whole)] : []),
    draft: () => draftRow("The gate is green. Two legs", { nonce: draftNonce }),
  });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const spoken = [];
  const result = await runner.run({
    agentId: "a1", message: "how did the gate go",
    onSent: ({ nonce }) => { draftNonce = nonce; },
    onDraftSentence: (sentence) => { spoken.push(sentence); },
  });
  assert.deepEqual(spoken, ["The gate is green."]);
  assert.deepEqual(result.remaining, ["Two legs failed earlier.", "I re-ran both of them."]);
  assert.equal(result.diverged, false);
});

test("a draft carrying somebody else's nonce is never read out", async () => {
  const clock = fakeClock();
  const whole = "That one is yours, not his.";
  const gw = fakeGateway({
    tail: (n) => (n >= 4 ? [reply("e1", whole)] : []),
    // A turn the CONSOLE started in the same conversation while the call was open. Reading this out
    // would have Titan answer a question the person on the phone never asked.
    draft: () => draftRow("Richard's invoice went out this morning. It was", { nonce: "voice:someone-else:9" }),
  });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const spoken = [];
  const result = await runner.run({ agentId: "a1", message: "anything from richard", onDraftSentence: (s) => spoken.push(s) });
  assert.deepEqual(spoken, [], "a draft with another turn's nonce is not ours");
  assert.deepEqual(result.spoken, []);
  assert.equal(result.text, whole);
  // And the whole-reply path is what answers, exactly as it did before VOICE-3.
  assert.deepEqual(result.pieces, [whole]);
});

test("a console prompt's draft carries no nonce at all, and is not read out either", async () => {
  const clock = fakeClock();
  const gw = fakeGateway({
    tail: (n) => (n >= 3 ? [reply("e1", "Done.")] : []),
    draft: () => draftRow("Typing something for the person at the keyboard. And", { nonce: "" }),
  });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const spoken = [];
  await runner.run({ agentId: "a1", message: "anything", onDraftSentence: (s) => spoken.push(s) });
  assert.deepEqual(spoken, []);
});

test("a host with no getTurnDraft is asked ONCE and the turn behaves exactly as it did before", async () => {
  const clock = fakeClock();
  const whole = "Still the old bundle on this box.";
  const gw = fakeGateway({ tail: (n) => (n >= 6 ? [reply("e1", whole)] : []), draft: "unknown" });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep });
  const spoken = [];
  const result = await runner.run({ agentId: "a1", message: "how did the gate go", onDraftSentence: (s) => spoken.push(s) });
  assert.equal(gw.draftReads, 1, `getTurnDraft was called ${gw.draftReads} times after a 404`);
  assert.deepEqual(spoken, []);
  assert.equal(result.text, whole);
  assert.deepEqual(result.pieces, [whole]);
  // `remaining` is always what is LEFT to say, so with nothing streamed it is the whole reply. The
  // dispatch path does not read it on this turn: a turn that streamed nothing takes the VOICE-1 path
  // and sends `pieces`, which is why the two are asserted to be the same thing here.
  assert.deepEqual(result.remaining, result.pieces);
  assert.equal(result.hops.td, 0, "nothing was streamed, so there is no td to report");
});

test("a draft that has started does NOT get a nudge on top of it", async () => {
  const clock = fakeClock();
  let draftNonce = "";
  const gw = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    // Nothing ever lands, so the wait runs long enough for both nudges to come due.
    tail: () => [],
    draft: (n) => draftRow(n >= 2 ? "He is reading the log now. Then" : "He is", { nonce: draftNonce }),
  });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep, waitCapS: 70 });
  const nudged = [];
  const spoken = [];
  await runner.run({
    agentId: "a1", message: "what is he doing",
    onSent: ({ nonce }) => { draftNonce = nonce; },
    onNudge: (text) => nudged.push(text),
    onDraftSentence: (s) => spoken.push(s),
  });
  assert.deepEqual(spoken, ["He is reading the log now."]);
  assert.deepEqual(nudged, [], "the silence the nudge fills was not there");
});

test("a streamed turn that runs out of time still owes the person the sentence saying so", async () => {
  const clock = fakeClock();
  let draftNonce = "";
  const gw = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    tail: () => [],
    draft: () => draftRow("He is reading the log now. Then", { nonce: draftNonce }),
  });
  const runner = makeTurnRunner({ call: gw.call, now: clock.now, sleep: clock.sleep, waitCapS: 5 });
  const spoken = [];
  const result = await runner.run({
    agentId: "a1", message: "what is he doing",
    onSent: ({ nonce }) => { draftNonce = nonce; },
    onDraftSentence: (s) => spoken.push(s),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(spoken, ["He is reading the log now."]);
  // The giving-up sentence was never in the draft, so it is still owed however much was streamed.
  // An empty `remaining` here would have the relay fall silent on the turn that needs words most.
  assert.ok(result.text.includes("5 seconds"), result.text);
  assert.deepEqual(result.remaining, splitSentences(result.text));
});

// ---- VOICE-16: the voice has the agent's brain ----------------------------------------------------
//
// THE PHONE LINE, LITERALLY. This is the string every voice session was given until VOICE-16 and the
// string a box whose host has no `getVoiceBrief` is still given. It is written out here rather than
// compared against the function that produces it, because the claim being pinned is "byte for byte
// what it was", and a test that called the same function would pass through any rewrite of it.
const PHONE_LINE_TITAN = "You are the voice of Titan. You are his mouth and his ears and nothing else."
  + " You have no memory, no tools and no knowledge of your own. Every single thing the person says"
  + " goes to him through the titan function, including short answers like yes, no, that one, or go"
  + " ahead. Never answer from your own knowledge, never guess, never make something up to fill a"
  + " silence. He can take five to twenty-five seconds. Say one short natural thing while you wait and"
  + " then read out exactly what comes back, in a normal speaking voice, without reading out"
  + " punctuation, headings, file paths character by character, or anything that sounds like a screen"
  + " being read. If he asks the person to confirm something, read it out as a plain question and send"
  + " their answer straight back to him. If you get told something went wrong, say so plainly. Keep"
  + " your own words short. You are a phone line, not a participant.";

test("no brief is the phone line, byte for byte, whichever way it is asked for", () => {
  assert.equal(phoneLineInstructions("Titan"), PHONE_LINE_TITAN);
  assert.equal(voiceInstructions({ agentName: "Titan", brief: null }), PHONE_LINE_TITAN);
  // The three other ways a caller can mean "no brief", including buildSession's own default.
  assert.equal(voiceInstructions({ agentName: "Titan" }), PHONE_LINE_TITAN);
  assert.equal(voiceInstructions("Titan"), PHONE_LINE_TITAN);
  assert.equal(voiceInstructions(), PHONE_LINE_TITAN);
});

test("the brief's persona, facts and last turn are all in the instructions", () => {
  const said = voiceInstructions({ agentName: "Titan", brief: briefRow() });
  assert.ok(said.includes("You run a two-person managed services shop with Richard."), "the persona");
  assert.ok(said.includes("the deploy gate runs on the R750"), "the first fact");
  assert.ok(said.includes("Richard Avery is the business partner"), "the second fact");
  assert.ok(said.includes("it did, both legs passed on the second run"), "the last turn");
  assert.ok(said.includes("Them: did the gate go green in the end"), "the person's side of it, labelled");
  assert.ok(said.includes("You: it did, both legs passed on the second run"), "and the agent's own");
  // And it is the agent, not a line for the agent. The old wording is gone.
  assert.ok(said.startsWith("You are Titan, and you are talking out loud"));
  assert.ok(!said.includes("You are the voice of Titan"));
  assert.ok(!said.includes("you have no memory"));
});

test("the instructions still say that an answer to a question goes back through the tool", () => {
  // THE ONE RULE THAT CANNOT MOVE. A spoken yes against a held card is resolved by the relay through
  // the approval path (dispatch reads matchYesNo against session.heldCard), so a voice that answered
  // "yes, go ahead" out of its own head would leave the card open with nothing approved.
  const said = voiceInstructions({ agentName: "Titan", brief: briefRow() });
  assert.match(said, /confirm, approve or choose/);
  assert.match(said, /even when it is only yes or no/);
  assert.match(said, /Never treat a yes as done yourself/);
});

test("VOICE-16b: the instructions carry the spoken contract ONCE, and the phone line is still untouched", () => {
  // Jason, 2026-09-12, after the first working call on build 20: "when we're in voice, Titan needs to be
  // less verbose. It can be verbose in the text that's being printed out, but it needs to be shorter and
  // more conversational ... less like a syllabus coming back every time." The contract is prompt text, so
  // what can be pinned here is that it IS in the instructions, that it says the four things it has to
  // say, and that it is written exactly once. Whether a real model obeys it is a live call, not a test.
  const said = voiceInstructions({ agentName: "Titan", brief: briefRow() });
  const times = (haystack, needle) => haystack.split(needle).length - 1;
  assert.equal(times(said, "HOW YOU SOUND"), 1, "the spoken contract is written once, not once per section");
  assert.equal(times(said, "WHAT YOU SAY WHEN SOMETHING COMES BACK"), 1, "and so is the result rule");
  assert.match(said, /one or two short sentences in plain conversational words/);
  assert.match(said, /No lists, no headings, no numbered steps, no file paths, no code/);
  assert.match(said, /Give the gist in one breath/);
  assert.match(said, /the rest is on the screen/);
  assert.match(said, /never say it twice/);
  // THE LINE THAT HAD TO GO. "Read out what comes back" is the behaviour being removed, and it was in
  // both the instructions and the tool description; a prompt that says both things argues with itself.
  assert.ok(!/read out what comes back/.test(said), "the old read-it-out instruction is gone");
  assert.ok(!/read out what comes back/.test(titanTool().description), "and gone from the tool description too");
  // AND THE WAIT LINE STAYS, because a silent line is the other failure: the voice says what it is
  // doing before the five to twenty-five seconds, and that is unchanged.
  assert.match(said, /checking the mail now/);
  assert.equal(times(said, "so the line is not silent"), 1);
  // The fallback for an old host is byte for byte what it always was, contract and all: it is pinned
  // literally above, and the contract is deliberately NOT back-ported into it.
  assert.equal(phoneLineInstructions("Titan"), PHONE_LINE_TITAN);
  assert.ok(!phoneLineInstructions("Titan").includes("one or two short sentences"));
  assert.equal(SPOKEN_LEAD_SENTENCES, 1, "one sentence is read out word for word; the rest is the model's to say short");
});

test("an empty brief is still the agent and never the phone line", () => {
  // A brand new bot with no description, no facts and no conversation. There is nothing to put in the
  // three sections, and the voice must still be told it IS the agent rather than a line for one.
  const said = voiceInstructions({ agentName: "Nova", brief: { persona: "", facts: [], recent: [], agentName: "Nova", workspaceName: "" } });
  assert.ok(said.startsWith("You are Nova, and you are talking out loud"));
  assert.ok(!said.includes("WHO YOU ARE"), "no empty heading");
  assert.ok(!said.includes("WHAT YOU REMEMBER"));
  assert.ok(!said.includes("WHAT THE TWO OF YOU HAVE BEEN SAYING"));
  assert.ok(said.includes("WHEN TO USE THE titan FUNCTION"));
});

test("the tool is a job now: do it, look it up, or check it, and not every syllable", () => {
  const tool = titanTool();
  assert.equal(tool.name, "titan");
  assert.match(tool.description, /DO something, to LOOK something up, or to CHECK something/);
  assert.match(tool.description, /Do NOT call it for ordinary conversation/);
  // The old instruction is gone, and it was the whole reason a conversation was a sequence of pauses.
  assert.ok(!/EVERYTHING the person asks or tells you/.test(tool.description));
});

test("readVoiceBrief answers null for every way it can fail, and logs which one", async () => {
  const lines = [];
  const log = (line) => lines.push(String(line));
  // An older host. `isUnknownGatewayMethod` is the existing reader and the only 404 that counts.
  const old = fakeGateway({ brief: "unknown" });
  assert.equal(await readVoiceBrief(old.call, "a1", { log }), null);
  assert.ok(lines.some((line) => line.includes("not on this box's host")), lines.join(" | "));
  // A box that does not hold that agent. The host answers this as a fact, not an error.
  const none = fakeGateway({ brief: null });
  assert.equal(await readVoiceBrief(none.call, "a1", { log }), null);
  assert.ok(lines.some((line) => line.includes("holds no brief for that agent")), lines.join(" | "));
  // A read that throws for any other reason is not a 404 and says so differently.
  const broken = { call: async () => { throw new Error("the box answered HTTP 503"); } };
  assert.equal(await readVoiceBrief(broken.call, "a1", { log }), null);
  assert.ok(lines.some((line) => line.includes("could not read the brief")), lines.join(" | "));
  // And no agent at all never asks.
  const unused = fakeGateway({ brief: briefRow() });
  assert.equal(await readVoiceBrief(unused.call, "", { log }), null);
  assert.equal(unused.briefReads, 0);
});

test("a wedged box does not hold the microphone up: the brief read has its own budget", async () => {
  const lines = [];
  // A read that never answers, which is what a wedged box does for the 20 s of makeGatewayCall's own
  // timeout. A person pressing the talk button must not wait that long for a microphone.
  const hung = { call: () => new Promise(() => {}) };
  const started = Date.now();
  assert.equal(await readVoiceBrief(hung.call, "a1", { timeoutMs: 30, log: (line) => lines.push(String(line)) }), null);
  assert.ok(Date.now() - started < 2000, "it gave up rather than waiting on the box");
  assert.ok(lines.some((line) => line.includes("gave up on the brief")), lines.join(" | "));
});

test("the workspace's own name beats the box's, because the box answers a container name", async () => {
  const gw = fakeGateway({ brief: briefRow({ workspaceName: "titanbot-acme-abc123" }) });
  const mine = await readVoiceBrief(gw.call, "a1", { workspaceName: "Acme" });
  assert.equal(mine.workspaceName, "Acme");
  // And with no tenant name to hand, the box's own answer is better than nothing.
  const theirs = await readVoiceBrief(gw.call, "a1", {});
  assert.equal(theirs.workspaceName, "titanbot-acme-abc123");
});

test("a malformed brief is read without throwing and without carrying rubbish into the prompt", async () => {
  const gw = fakeGateway({ brief: { persona: 7, facts: ["ok", "", null, 3], recent: [{ role: "nonsense", text: "kept" }, { text: "" }, null], agentName: null } });
  const brief = await readVoiceBrief(gw.call, "a1", {});
  assert.equal(brief.persona, "");
  assert.deepEqual(brief.facts, ["ok"]);
  assert.deepEqual(brief.recent, [{ role: "agent", text: "kept", at: 0 }]);
  assert.equal(brief.agentName, "");
});

// ---- VOICE-16: the one memory a call leaves behind ------------------------------------------------

test("the exchange keeps both sides in the order they were said, and a later copy replaces an earlier", () => {
  const exchange = makeSpokenExchange();
  exchange.person("item_1", "what is the");
  exchange.person("item_1", "what is the gate doing");
  exchange.voice("response.output_audio_transcript.delta", { item_id: "item_2", delta: "Two legs " });
  exchange.voice("response.output_audio_transcript.delta", { item_id: "item_2", delta: "are red." });
  exchange.person("item_3", "fix them");
  assert.deepEqual(exchange.rows, [
    { who: "person", text: "what is the gate doing" },
    { who: "voice", text: "Two legs are red." },
    { who: "person", text: "fix them" },
  ]);
});

test("the settled transcript of an item overwrites the deltas rather than appearing twice", () => {
  const exchange = makeSpokenExchange();
  exchange.voice("response.output_audio_transcript.delta", { item_id: "item_1", delta: "Two legs are re" });
  // The brief named `response.output_item.done`, and both vendors emit it for a spoken message. It
  // carries the WHOLE transcript, so it replaces what the deltas had built on the same item.
  exchange.voice("response.output_item.done", {
    response_id: "resp_1",
    item: { id: "item_1", type: "message", role: "assistant", content: [{ type: "audio", transcript: "Two legs are red." }] },
  });
  assert.deepEqual(exchange.rows, [{ who: "voice", text: "Two legs are red." }]);
});

test("the items on response.done are read too, and a function call among them is not a spoken word", () => {
  const exchange = makeSpokenExchange();
  exchange.voice("response.done", {
    response: {
      id: "resp_1",
      output: [
        { id: "item_1", type: "message", content: [{ type: "output_audio", transcript: "On it." }] },
        { id: "item_2", type: "function_call", call_id: "c1", name: "titan", arguments: "{}" },
      ],
    },
  });
  assert.deepEqual(exchange.rows, [{ who: "voice", text: "On it." }]);
});

test("the legacy event name is read as well, because a provider mid-migration sends either", () => {
  const exchange = makeSpokenExchange();
  exchange.voice("response.audio_transcript.done", { item_id: "item_1", transcript: "All right." });
  assert.deepEqual(exchange.rows, [{ who: "voice", text: "All right." }]);
});

test("an event that carries nobody's words is ignored, so the reader needs no branch at the call site", () => {
  const exchange = makeSpokenExchange();
  exchange.voice("response.output_audio.delta", { delta: "AAAA" });
  exchange.voice("session.updated", { session: {} });
  exchange.voice("rate_limits.updated", { rate_limits: [] });
  exchange.voice("response.output_item.done", { item: { id: "i", type: "function_call", call_id: "c", name: "titan", arguments: "{}" } });
  assert.equal(exchange.size, 0);
});

test("the exchange is bounded, and it is the OLDEST lines that go", () => {
  const exchange = makeSpokenExchange({ maxRows: 3 });
  for (let i = 0; i < 10; i += 1) exchange.person(`item_${i}`, `line ${i}`);
  assert.deepEqual(exchange.rows.map((row) => row.text), ["line 7", "line 8", "line 9"]);
});

test("the note is one prompt carrying both sides, labelled, asking to be filed and not answered", () => {
  const note = voiceCallNote({
    rows: [
      { who: "person", text: "what is the gate doing" },
      { who: "voice", text: "Two legs are red." },
      { who: "person", text: "fix them" },
      { who: "voice", text: "Running them again now." },
    ],
    agentName: "Titan",
    startedAtMs: Date.UTC(2026, 8, 12, 21, 32, 4),
    endedAtMs: Date.UTC(2026, 8, 12, 21, 41, 18),
  });
  assert.ok(note.includes("Voice call, 2026-09-12T21:32Z to 2026-09-12T21:41Z."));
  assert.ok(note.includes("do not reply to it"), "the one-line ask, because no flag on sendPrompt can say it");
  // The labels are defined IN the note. It lands in the agent's own conversation, where a bare "Them"
  // is ambiguous: the person it is about is the same person that conversation is with.
  assert.ok(note.includes('"Them" is the person you were talking to and "Titan" is you.'));
  assert.ok(note.includes("Them: what is the gate doing"));
  assert.ok(note.includes("Titan: Two legs are red."));
  assert.ok(note.includes("Them: fix them"));
  assert.ok(note.includes("Titan: Running them again now."));
  // One prompt, in order, and the person's side and the agent's side are told apart.
  assert.ok(note.indexOf("Them: what is the gate doing") < note.indexOf("Titan: Two legs are red."));
});

test("a call where nothing was said leaves no note at all, rather than an empty row", () => {
  assert.equal(voiceCallNote({ rows: [], agentName: "Titan", startedAtMs: 1, endedAtMs: 2 }), "");
  assert.equal(voiceCallNote({ rows: [{ who: "person", text: "   " }] }), "");
  assert.equal(voiceCallNote(), "");
});

test("a long call keeps the END of itself and says how many lines it dropped", () => {
  const rows = [];
  for (let i = 0; i < 400; i += 1) rows.push({ who: i % 2 === 0 ? "person" : "voice", text: `line ${i} ${"x".repeat(100)}` });
  const note = voiceCallNote({ rows, agentName: "Titan", startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_600_000 });
  assert.ok(note.length <= VOICE_NOTE_MAX_CHARS, `the note is ${note.length} characters`);
  assert.ok(note.includes("line 399"), "the end of the call survived");
  assert.ok(!note.includes("line 0 "), "and the start of it did not");
  assert.match(note, /\(the first \d+ lines of the call are not in this note\)/);
});

// ---- VOICE-16c: the note is FILED, and only an older host gets asked to answer one ----------------
//
// WHAT IS ACTUALLY AT RISK HERE. Until this, the closing note was a `sendPrompt`, which is the host's
// run-a-turn verb, and "do not reply to this" was a sentence inside the prompt rather than a property
// of the call. Five notes went out on the night of 2026-09-12 with nothing but that politeness between
// the person and a message nobody asked for. So the load-bearing assertions below are which command
// went, and which did NOT: a host that can file one must never also be sent a prompt, and a host that
// cannot must still end up with the note in the conversation.
//
// The second risk is the retry. A note that may have landed must not be written a second way, so only
// a 404 falls back; a timeout and a refusal do not. That is three tests, not one.

/** A `call` that records every command and answers from a script keyed by command name. */
function noteGateway(answers = {}) {
  const calls = [];
  const call = async (command, args = {}) => {
    calls.push({ command, args });
    const scripted = answers[command];
    if (typeof scripted === "function") return scripted(args, calls);
    if (scripted instanceof Error) throw scripted;
    return scripted ?? {};
  };
  return { call, calls, of: (command) => calls.filter((row) => row.command === command) };
}

const unknownMethod = (command) => new Error(`${command} answered HTTP 404: unknown gateway method: ${command}`);

test("the note is filed as a row, and a host that can file one is never sent a prompt as well", async () => {
  const gw = noteGateway({ appendTranscriptNote: { filed: true, entryId: "t4u", duplicate: false } });
  const lines = [];
  const outcome = await fileCallNote(gw.call, {
    agentId: "a1", note: "Voice call. Them: hello. Titan: hello.", clientNonce: "voice:s1:note", at: 1_700_000_000_000,
    log: (line) => lines.push(line),
  });
  assert.equal(outcome.how, "filed");
  assert.equal(outcome.filed, true);
  assert.equal(outcome.entryId, "t4u");
  assert.equal(gw.of("appendTranscriptNote").length, 1);
  assert.equal(gw.of("sendPrompt").length, 0, "a filed note must not also be asked as a question");
  const sent = gw.of("appendTranscriptNote")[0].args;
  assert.equal(sent.agentId, "a1");
  assert.equal(sent.text, "Voice call. Them: hello. Titan: hello.");
  assert.equal(sent.clientNonce, "voice:s1:note");
  assert.equal(sent.at, 1_700_000_000_000);
  assert.deepEqual(lines, [], "a note that filed cleanly says nothing in the log on its own behalf");
});

test("a host with no appendTranscriptNote gets the note as the prompt VOICE-16 sent, unchanged", async () => {
  const gw = noteGateway({ appendTranscriptNote: unknownMethod("appendTranscriptNote"), sendPrompt: { accepted: true } });
  const lines = [];
  const outcome = await fileCallNote(gw.call, {
    agentId: "a1", note: "Voice call. Them: hello.", clientNonce: "voice:s1:note", log: (line) => lines.push(line),
  });
  assert.equal(outcome.how, "sent");
  assert.equal(outcome.filed, true);
  assert.equal(gw.of("sendPrompt").length, 1);
  const sent = gw.of("sendPrompt")[0].args;
  assert.equal(sent.agentId, "a1");
  // The PROMPT field, not `text`, and the same nonce, so the fallback is the call VOICE-16 made.
  assert.equal(sent.prompt, "Voice call. Them: hello.");
  assert.equal(sent.clientNonce, "voice:s1:note");
  assert.ok(
    lines.some((line) => line.includes("cannot file a note") && line.includes("may get a reply")),
    `the log has to say the reply is back on this box: ${JSON.stringify(lines)}`,
  );
});

test("a note the host REFUSED is not asked a second way, because a refusal is an answer", async () => {
  const gw = noteGateway({ appendTranscriptNote: new Error("Agent a1 no longer exists") });
  const lines = [];
  const outcome = await fileCallNote(gw.call, { agentId: "a1", note: "Voice call.", log: (line) => lines.push(line) });
  assert.equal(outcome.how, "failed");
  assert.equal(outcome.filed, false);
  assert.equal(gw.of("sendPrompt").length, 0, "talking a box into a write it declined is not a fallback");
  assert.ok(lines.some((line) => line.includes("could not file the call's note")), JSON.stringify(lines));
});

test("a note that TIMED OUT is not written a second way, because it may already have landed", async () => {
  // A box that never answers. The budget is what ends this call, not the box.
  const gw = noteGateway({ appendTranscriptNote: () => new Promise(() => {}) });
  const lines = [];
  const outcome = await fileCallNote(gw.call, {
    agentId: "a1", note: "Voice call.", timeoutMs: 30, log: (line) => lines.push(line),
  });
  assert.equal(outcome.how, "late");
  assert.equal(outcome.filed, false);
  assert.equal(gw.of("sendPrompt").length, 0, "one call transcript must not land twice in one conversation");
  assert.ok(lines.some((line) => line.includes("gave up waiting") && line.includes("it may still land")), JSON.stringify(lines));
});

test("the two attempts share ONE budget, so a slow box cannot hold the line shut twice over", async () => {
  // The 404 is instant; what is slow is the fallback. The whole call still settles inside the budget,
  // which is what lets the next press in: the session is released behind this await.
  const gw = noteGateway({
    appendTranscriptNote: unknownMethod("appendTranscriptNote"),
    sendPrompt: () => new Promise(() => {}),
  });
  const started = Date.now();
  const outcome = await fileCallNote(gw.call, { agentId: "a1", note: "Voice call.", timeoutMs: 40 });
  assert.equal(outcome.how, "late");
  assert.ok(Date.now() - started < 40 * 4, `the shared budget was spent twice over: ${Date.now() - started} ms`);
});

test("a note already filed under this nonce is a SUCCESS, so nothing retries it into the transcript twice", async () => {
  const gw = noteGateway({ appendTranscriptNote: { filed: false, entryId: "t4u", duplicate: true } });
  const outcome = await fileCallNote(gw.call, { agentId: "a1", note: "Voice call.", clientNonce: "voice:s1:note" });
  assert.equal(outcome.how, "filed");
  assert.equal(outcome.filed, true);
  assert.equal(outcome.duplicate, true);
  assert.equal(outcome.entryId, "t4u");
  assert.equal(gw.of("sendPrompt").length, 0);
});

test("nothing to file writes nothing, and that includes an agent the edge never resolved", async () => {
  const gw = noteGateway();
  assert.equal((await fileCallNote(gw.call, { agentId: "a1", note: "" })).how, "nothing");
  assert.equal((await fileCallNote(gw.call, { agentId: "", note: "Voice call." })).how, "nothing");
  assert.equal(gw.calls.length, 0, "no gateway call at all, on either");
});

test("the note write budget is the one VOICE-16 measured, so the session release is not held longer", () => {
  assert.equal(VOICE_NOTE_WRITE_MS, 5000);
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

/**
 * One 100 ms frame of something that is not silence, which is what a microphone really sends.
 *
 * VOICE-15c made this load-bearing for every utterance in this file and not just for barge-in: the
 * relay will not treat a provider transcript or a titan tool call as the person's words unless the
 * line has carried sound since the utterance's window opened. A turn driven with no frames behind it
 * is the measured fault, not a shortcut, and it has its own cases at the end of this file.
 */
const micFrame = () => {
  const out = Buffer.alloc(4800);
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE(3000, i);
  return out;
};

async function openSession({ stub, settings, gateway, dir, greet = false, cardWatchMs = undefined }) {
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
    t, call: gateway.call, policy: makeVoicePolicy({}), providerUrl: stub.url, greet,
    // VOICE-19. Left undefined by every case that predates the watcher, so those lines poll on the
    // production three seconds and never fire inside a test's own lifetime.
    ...(cardWatchMs == null ? {} : { cardWatchMs }),
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
    /**
     * VOICE-15c. The person's microphone carrying real sound into the utterance about to be
     * transcribed or tool-called, settled against the PROVIDER'S OWN append count rather than a sleep,
     * so the bytes are metered before the words that lean on them arrive.
     *
     * It waits out the echo window first: a frame inside it is dropped by the gate and never reaches
     * the provider at all, which is the relay behaving correctly and a test hanging for no reason.
     */
    mic: async (count = 4) => {
      const holdUntil = Number(frames.json.filter((f) => f.t === "speak-end").at(-1)?.holdUntilMs ?? 0);
      if (holdUntil > Date.now()) {
        await new Promise((resolve) => { const timer = setTimeout(resolve, holdUntil - Date.now() + 60); timer.unref(); });
      }
      const before = stub.events.appendFrames;
      for (let i = 0; i < count; i += 1) client.send(micFrame());
      await settle(() => stub.events.appendFrames >= before + count, `${count} microphone frame(s) reaching the provider`);
    },
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
    // The microphone first: since VOICE-15c a tool call on a line that has carried no sound is
    // dropped rather than sent, which is this file's own last section.
    await session.mic();
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
    await session.mic();
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
    await session.mic();
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "anything pending" }, callId: "c1", triple: false });
    await session.settle(() => stub.events.toolOutputs.length >= 1, "the card spoken back");
    assert.match(JSON.parse(stub.events.toolOutputs[0].output).reply, /Richard/, "the held action was read out as a question");
    // A yes arriving without a new user turn in between is refused: the model must not talk itself
    // into a confirmation for an action the person never answered.
    await session.mic();
    stub.emitToolCall({ name: "titan", args: { message: "yes" }, callId: "c2", triple: false });
    await session.settle(() => stub.events.toolOutputs.length >= 2, "the refusal of the same-turn yes");
    assert.match(JSON.parse(stub.events.toolOutputs[1].output).reply, /Say that again/);
    assert.equal(gateway.of("resolveAutoReviewApproval").length, 0, "nothing was closed");
    // Now a NEW user turn, and the same yes goes through.
    await session.mic();
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
    await session.mic();
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "anything pending" }, callId: "c1", triple: false });
    await session.settle(() => stub.events.toolOutputs.length >= 1, "the card spoken back");
    await session.mic();
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

// ================================================== VOICE-19: the card the box raised on its own
//
// Jason, 2026-09-13 on build 21: "the approval card popped up while I was in my voice chat session
// ... I should also be able to tell Titan when it pops up on the screen ... I approve it and let
// Titan approve it through my verbal approval." Half of that is the screen (the buttons, in
// tests/machine-room-voice.test.mjs); this half is the relay noticing a card at all.
//
// WHAT WAS MISSING. `pendingCardsOf` was read in exactly ONE place -- inside makeTurnRunner.run,
// against the entries that landed after this line's own prompt -- so the only approval that was ever
// asked about out loud was one a spoken turn had caused. An approval raised by a turn started in the
// chat, by a routine, by a subagent, or by Titan carrying on working after his reply had closed the
// turn, reached the person's screen and was never mentioned. The watcher below is the moment that was
// missing, and every case here is end to end through the real bridge.

const settledApproval = (id, requestId, { status = "approved", summary = "Send the email to Richard" } = {}) => ({
  id, kind: "send-message", timestampMs: 1_700_000_000_400,
  message: { type: "auto-review-approval", approval: { requestId, status, summary, reason: "it sends mail", command: "mail send" } },
});

const spokenQuestions = (session) => session.of("said").map((one) => String(one.text ?? "")).filter((one) => one.includes("Allow it?"));

test("VOICE-19: one wording for a card, and it ASKS rather than reads a summary out", () => {
  const card = { kind: "auto-review", title: "Echo hello on Titan's computer", detail: "it runs a shell command - echo hello" };
  assert.equal(cardQuestion(card), "Echo hello on Titan's computer. it runs a shell command - echo hello. Allow it?");
  // The detail is optional and the question still ends in the button's own word.
  assert.equal(cardQuestion({ kind: "auto-review", title: "Send the email to Richard" }), "Send the email to Richard. Allow it?");
  // A card whose own string already ends is not given a second full stop.
  assert.equal(cardQuestion({ kind: "local-tool", title: "Run psql?" }), "Run psql? Allow it?");
  // Two cards are never guessed between, and that sentence is deliberately NOT the Allow it? one.
  const many = cardQuestion({ kind: "many", count: 2, cards: [{ title: "one" }, { title: "two" }] });
  assert.match(many, /There are 2 things waiting on you: one; two\. Say which one\./);
  assert.doesNotMatch(many, /Allow it\?/);
  assert.equal(cardQuestion(null), "");
  // And the production tick is the between-turns one, not the turn runner's 400 ms.
  assert.equal(CARD_WATCH_MS, 3000);
});

test("VOICE-19: the words a person actually answers \"Allow it?\" with are a decision", () => {
  // The question now ends in the button's own word, so the matcher has to know that word. Before this
  // wave "allow it" was prose: it went to Titan as a message and left the card open.
  for (const yes of ["allow", "allow it", "allowed", "permit", "approve it", "yes", "go ahead", "do it"]) {
    assert.equal(matchYesNo(yes)?.decision, "yes", `${JSON.stringify(yes)} is a yes`);
  }
  for (const no of ["refuse", "refuse it", "reject", "block", "deny it", "stop it", "no", "cancel"]) {
    assert.equal(matchYesNo(no)?.decision, "no", `${JSON.stringify(no)} is a no`);
  }
  // And the guard that all of this hangs on did not move: a negation is never an approval, and a
  // sentence that merely contains one of these words is still prose.
  assert.equal(matchYesNo("don't allow it")?.decision, "no");
  assert.equal(matchYesNo("do not approve it")?.decision, "no");
  assert.equal(matchYesNo("I am not sure, can you confirm what it would do"), null);
  assert.equal(matchYesNo("allow the second one only"), null, "a rider is not a bare answer");
});

test("VOICE-19: a card the box raised with no spoken turn behind it is asked ONCE, and a spoken allow closes it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  // The card is in the tail from the first read. Nobody has said a word to Titan on this line, which
  // is the whole point: no sendPrompt has ever gone out, so the turn runner has never polled.
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [approvalEntry("e1", "req1")] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0019" }, gateway, dir, cardWatchMs: 60 });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    await session.settle(() => spokenQuestions(session).length > 0, "the card being asked about out loud");
    const asked = spokenQuestions(session)[0];
    assert.match(asked, /Send the email to Richard/, "the question names the action rather than gisting it");
    assert.match(asked, /Allow it\?$/, "and it asks");
    // The words really went to the vendor, as the one shape that makes a realtime model say a string.
    const read = stub.events.inbound.filter((event) => event.type === "conversation.item.create"
      && String(event.item?.content?.[0]?.text ?? "").includes("Send the email to Richard"));
    assert.equal(read.length, 1, "one item carrying the question, and one only");
    assert.match(String(read[0].item.content[0].text), /^Read this out to the person, word for word/);
    assert.equal(gateway.of("sendPrompt").length, 0, "and nothing about the card went into the conversation as prose");
    // ONE QUESTION AND NOT A NAG. The card stays pending on the box until somebody answers it, so a
    // watcher with no memory would ask again every tick for the length of the call.
    const pollsAfter = gateway.polls;
    await session.settle(() => gateway.polls >= pollsAfter + 4, "four more ticks of the watcher");
    assert.equal(spokenQuestions(session).length, 1, "it was asked once, however many times it was seen");
    // A NEW user turn, and the answer goes through the console's own approval command.
    await session.mic();
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "allow it" }, callId: "c1", triple: false });
    await session.settle(() => gateway.of("resolveAutoReviewApproval").length > 0, "the approval closing");
    const closed = gateway.of("resolveAutoReviewApproval")[0].args;
    assert.equal(closed.resolution, "approved");
    assert.equal(closed.requestId, "req1", "never a second gate: it is the command the console's own button calls");
    assert.equal(gateway.of("sendPrompt").length, 0, "a yes that closes a card is not also a message to Titan");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-19: a spoken no at a card the box raised is a refusal, and nothing is approved", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [approvalEntry("e1", "req1")] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0020" }, gateway, dir, cardWatchMs: 60 });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    await session.settle(() => spokenQuestions(session).length > 0, "the card being asked about out loud");
    await session.mic();
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "refuse it" }, callId: "c1", triple: false });
    await session.settle(() => gateway.of("resolveAutoReviewApproval").length > 0, "the refusal");
    assert.equal(gateway.of("resolveAutoReviewApproval")[0].args.resolution, "denied");
    assert.equal(gateway.of("sendPrompt").length, 0);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-19: a card settled on screen lets the spoken question go, and is never asked again", async () => {
  // THE TAP. The card on the call screen and the question in the person's ear are the same card, so a
  // thumb on Allow answers both: the host rewrites the card's status, the watcher sees it is no longer
  // pending, and the held question stops standing. Without this a "yes" said a minute later would be
  // read as an answer to a decision that was already made.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  let tapped = false;
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    tail: () => (tapped ? [settledApproval("e1", "req1")] : [approvalEntry("e1", "req1")]),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0021" }, gateway, dir, cardWatchMs: 60 });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    await session.settle(() => spokenQuestions(session).length > 0, "the card being asked about out loud");
    tapped = true;
    await session.settle(() => session.frames.log.some((line) => line.includes("settled on screen rather than out loud")),
      "the relay letting go of a card the person answered with their thumb");
    const pollsAfter = gateway.polls;
    await session.settle(() => gateway.polls >= pollsAfter + 4, "four more ticks of the watcher");
    assert.equal(spokenQuestions(session).length, 1, "a settled card is not asked about again");
    // And a yes after the tap is a message to Titan rather than an answer to a closed decision.
    await session.mic();
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "yes" }, callId: "c1", triple: false });
    await session.settle(() => gateway.of("sendPrompt").length > 0, "the yes reaching Titan as prose");
    assert.equal(gateway.of("resolveAutoReviewApproval").length, 0, "nothing was closed by it");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-19: an approval raised inside a tool turn is asked ONCE, by the turn and not also by the watcher", async () => {
  // Both readers are live on this line and both can see the same card. The turn runner owns the tail
  // while a turn is with Titan -- it polls at 400 ms and returns whatever card lands beside the reply
  // -- and the watcher stands aside for the whole of it. Two readers racing on one card is how the
  // same approval gets asked twice in two different sentences.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai", audioFrames: 1 });
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    // Nothing until the turn is in flight, and then the card with no reply beside it: he is waiting
    // on the person, which is the runner's own card branch.
    tail: (n) => (n >= 3 ? [approvalEntry("e1", "req1")] : []),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0022" }, gateway, dir, cardWatchMs: 60 });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    await session.mic();
    stub.emitSpeechStopped();
    stub.emitToolCall({ name: "titan", args: { message: "send richard the invoice" }, callId: "c1", triple: false });
    await session.settle(() => stub.events.toolOutputs.length > 0, "the tool output carrying the question");
    assert.match(JSON.parse(stub.events.toolOutputs[0].output).reply, /Send the email to Richard\. it sends mail - mail send\. Allow it\?/,
      "the turn asked it, in the one wording");
    const pollsAfter = gateway.polls;
    await session.settle(() => gateway.polls >= pollsAfter + 4, "four more ticks of the watcher over the same pending card");
    assert.equal(spokenQuestions(session).length, 1, "and the watcher did not ask it a second time");
    assert.equal(session.of("said").length, 1, "one said frame for the turn, and none of its own");
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

test("VOICE-16b end to end: the lead sentence is read out, and the rest comes back for the model to say short", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai", audioFrames: 1 });
  const whole = "The gate is green. Two legs failed earlier. I re-ran both of them.";
  const steps = ["The gate is green. Two", "The gate is green. Two legs failed earlier. I", whole];
  let nonce = "";
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    // The finished entry does not land until the draft has been read out in full, which is the
    // ordering VOICE-3 exists for: the host persists the entry after the tool call completes.
    tail: (n) => (n >= 8 ? [reply("e1", whole)] : []),
    draft: (n, args) => {
      nonce = String(gateway.of("sendPrompt")[0]?.args?.clientNonce ?? "");
      void args;
      const text = steps[Math.min(n, steps.length) - 1];
      return draftRow(text, { nonce, complete: n >= steps.length });
    },
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0001" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    await session.mic();
    stub.emitToolCall({ name: "titan", args: { message: "how did the gate go" }, triple: true });
    await session.settle(() => stub.events.toolOutputs.length > 0, "the tool output going back", 900);

    // ONE sentence went out as a text item, and it is the lead sentence. Until VOICE-16b this was
    // three, one per sentence of the answer, which is the "syllabus coming back" Jason asked to stop.
    // On xAI each text item is a billed flat fee, so the two that are gone are two fees that are gone
    // with them: the Spend line counts 1 where it used to count 3.
    const spokenItems = stub.events.inbound
      .filter((event) => event.type === "conversation.item.create" && event.item?.type === "message")
      .map((event) => String(event.item.content?.[0]?.text ?? ""));
    assert.equal(spokenItems.length, 1,
      `the relay sent ${spokenItems.length} text items: ${JSON.stringify(spokenItems)}; only the lead sentence is read out`);
    assert.ok(spokenItems[0].endsWith("The gate is green."), spokenItems[0]);
    assert.equal(stub.events.billableItems, 1, "one billed item for the lead sentence, where VOICE-3 billed one per sentence");

    // And the REST of the answer comes back on the tool output with the spoken hint, so the model says
    // it in its own short words instead of reading it. `alreadyRead` still says the front of it was
    // heard, `sentences` is exactly what is left, and `reply` is those sentences and nothing else.
    assert.equal(stub.events.toolOutputs.length, 1);
    const output = JSON.parse(stub.events.toolOutputs[0].output);
    assert.deepEqual(output, {
      reply: "Two legs failed earlier. I re-ran both of them.",
      sentences: ["Two legs failed earlier.", "I re-ran both of them."],
      alreadyRead: true,
      spoken: SPOKEN_REMAINDER_HINT,
    });
    // TWO response.create: one behind the lead sentence, one behind the tool output so the model
    // actually says the gist. It was three before -- one per sentence -- with none behind the output.
    assert.equal(stub.events.responseCreates, 2, `there were ${stub.events.responseCreates} response.create`);

    // The page still gets the WHOLE answer: the panel and the conversation hold all of it, and only
    // the provider's copy is trimmed.
    assert.equal(session.of("said").at(-1).text, whole);
    const hops = session.of("hops").at(-1);
    assert.ok(hops.td > 0 && hops.td < hops.t3, `td ${hops.td} t3 ${hops.t3}`);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-16b end to end: a one-sentence answer is said once and the tool output says there is nothing more", async () => {
  // THE SHAPE JASON ASKED FOR, ALL THE WAY THROUGH. "Yep, I did it." is the whole answer: it is read out
  // as it lands, and the tool output closes the call while telling the model there is nothing left to
  // say. No second response.create, so nothing is generated over a finished answer. This branch is
  // unchanged from VOICE-3 and is here because the common case now ENDS here rather than passing through.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai", audioFrames: 1 });
  const whole = "Yep, did that.";
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    tail: (n) => (n >= 5 ? [reply("e1", whole)] : []),
    // The host marks the draft complete when the message is delivered, which is what lets a single
    // sentence be read out at all: an unfinished draft always holds its last fragment back.
    draft: () => draftRow(whole, { nonce: String(gateway.of("sendPrompt")[0]?.args?.clientNonce ?? ""), complete: true }),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0001" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    await session.mic();
    stub.emitToolCall({ name: "titan", args: { message: "did the backup run" }, triple: true });
    await session.settle(() => stub.events.toolOutputs.length > 0, "the tool output going back", 900);
    const spokenItems = stub.events.inbound
      .filter((event) => event.type === "conversation.item.create" && event.item?.type === "message")
      .map((event) => String(event.item.content?.[0]?.text ?? ""));
    assert.equal(spokenItems.length, 1, `the relay sent ${spokenItems.length} text items: ${JSON.stringify(spokenItems)}`);
    assert.ok(spokenItems[0].endsWith(whole), spokenItems[0]);
    const output = JSON.parse(stub.events.toolOutputs[0].output);
    assert.deepEqual(output, { reply: "", sentences: [], alreadyRead: true },
      "nothing is owed, so no remainder and no spoken hint: the hint exists only to shorten a remainder");
    assert.equal(stub.events.responseCreates, 1,
      `there were ${stub.events.responseCreates} response.create; the one behind the sentence, and none behind the output`);
    assert.equal(session.of("said").at(-1).text, whole, "the page still gets the whole reply");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-16b end to end: a held card's question is still asked in full, with no shorten-it hint on it", async () => {
  // THE ONE THING THE CONTRACT MUST NOT TOUCH. A card's question is what the person answers yes or no
  // to, and the relay resolves that answer through the approval path. A question gisted down to "there
  // is something waiting on you" is how somebody says yes to the wrong thing, so a turn that is holding
  // a card gets the old payload exactly: the question in `sentences`, and no `spoken` hint.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai", audioFrames: 1 });
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    // The card lands with no reply entry beside it, which is the runner's card branch: he is waiting
    // on the person. The draft streamed one sentence before it, which is what makes this the branch
    // where a hint would otherwise be attached.
    tail: (n) => (n >= 5 ? [approvalEntry("e1", "req-77")] : []),
    draft: () => draftRow("I have the mail ready to go.", { nonce: String(gateway.of("sendPrompt")[0]?.args?.clientNonce ?? ""), complete: true }),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0001" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    await session.mic();
    stub.emitToolCall({ name: "titan", args: { message: "send richard the invoice" }, triple: true });
    await session.settle(() => stub.events.toolOutputs.length > 0, "the tool output going back", 900);
    const output = JSON.parse(stub.events.toolOutputs[0].output);
    assert.equal(output.spoken, undefined, "a turn holding a card carries no shorten-it hint");
    assert.equal(output.alreadyRead, true, "the lead sentence was read out, and the output still says so");
    assert.ok(output.sentences.some((piece) => piece.includes("Send the email to Richard")),
      `the card's own question is what is left to ask: ${JSON.stringify(output.sentences)}`);
    assert.equal(stub.events.responseCreates, 2, "one behind the lead sentence, one behind the question");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-14c: the line says hello first, once, before the person has said a word", async () => {
  // Jason, 2026-09-12: "as soon as you start the call, it should say something first". The greeting
  // is the first text item and the first response.create on the wire, sent when the provider
  // confirms the session and never again for the life of the line.
  assert.equal(pickGreeting(() => 0), GREETINGS[0]);
  assert.equal(pickGreeting(() => 0.999), GREETINGS.at(-1));
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai", audioFrames: 1 });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [], draft: "unknown" });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0001" }, gateway, dir, greet: true });
    await session.settle(() => stub.events.responseCreates > 0, "the greeting's response.create");
    const items = stub.events.inbound
      .filter((event) => event.type === "conversation.item.create" && event.item?.type === "message")
      .map((event) => String(event.item.content?.[0]?.text ?? ""));
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.ok(GREETINGS.some((greeting) => items[0].endsWith(greeting)), items[0]);
    assert.equal(stub.events.responseCreates, 1);
    assert.equal(stub.events.toolOutputs.length, 0, "nothing went to Titan: the greeting is the line's own");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-3 is OFF on a box whose host has no draft, and that turn is byte for byte the old one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai", audioFrames: 1 });
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    // Late enough that the draft reader gets its one turn to ask and be refused.
    tail: (n) => (n >= 4 ? [reply("e1", "The gate is green. I re-ran both legs.")] : []),
    draft: "unknown",
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0001" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    await session.mic();
    stub.emitToolCall({ name: "titan", args: { message: "how did the gate go" }, triple: true });
    await session.settle(() => stub.events.toolOutputs.length > 0, "the tool output going back");
    const output = JSON.parse(stub.events.toolOutputs[0].output);
    assert.equal(output.reply, "The gate is green. I re-ran both legs.");
    assert.deepEqual(output.sentences, ["The gate is green.", "I re-ran both legs."]);
    assert.equal(output.alreadyRead, undefined, "nothing was read out early, so nothing says it was");
    assert.equal(stub.events.billableItems, 0, "the old path costs no billed text items at all");
    assert.equal(stub.events.responseCreates, 1, "one response, behind the one tool output");
    assert.equal(gateway.draftReads, 1, "the 404 was taken as an answer and never asked again");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

    await session.mic();
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

    await session.mic();
    stub.emitSpeechStart();
    stub.emitUserTranscript("open ");
    stub.emitUserTranscript("the box");
    await session.settle(() => session.of("hear").some((f) => f.text === "open the box"), "the first utterance");
    // No settled transcript at all for that one, which is the case the defect needed.
    await session.mic();
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
    await session.mic();
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
    await session.mic();
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
    await session.mic();
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
    // Sound on the line, so what this pins is the EMPTY ARGUMENT and not the nothing-heard guard.
    await session.mic();
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

// ============================================ VOICE-7 ADVERSARIAL: two utterances in flight at once
//
// `hear-end` used to close "whatever turn is open" rather than the turn it was about. In always
// listening the next utterance begins during the 5.5 to 25 s Titan takes to answer the last one, and
// in push to talk a second hold does the same -- so utterance 1's confirmation dissolved utterance 2's
// panel mid-sentence, and every later transcript for utterance 2 was then dropped as belonging to a
// closed turn. The person watched their words vanish and the row that landed was never the words they
// had read.

test("VOICE-7: a second utterance while the first is still with Titan keeps its own panel", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = gatewayHoldingSend({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    tail: (n) => (n >= 2 ? [reply("e1", "We are on the deploy gate.")] : []),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0012" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");

    // ---- utterance 1, all the way to the send, which is then held open.
    await session.mic();
    stub.emitSpeechStarted({ itemId: "item_1" });
    await session.settle(() => session.of("hear-begin").length > 0, "the panel for the first utterance");
    stub.emitUserTranscript("what is the team working on", { itemId: "item_1" });
    stub.emitUserTranscriptDone("what is the team working on", { itemId: "item_1" });
    stub.emitSpeechStop();
    stub.emitToolCall({ name: "titan", args: { message: "what is the team working on" }, callId: "c1", triple: false });
    await session.settle(() => gateway.of("sendPrompt").length > 0, "the first utterance reaching Titan");

    // ---- utterance 2 begins while Titan still has the first.
    await session.mic();
    stub.emitSpeechStarted({ itemId: "item_2" });
    await session.settle(() => session.of("hear-begin").length >= 2, "the panel for the second utterance");
    assert.equal(session.of("hear-begin").at(-1).turn, 2);
    stub.emitUserTranscript("and what about the deploy", { itemId: "item_2" });
    await session.settle(() => session.of("hear").some((f) => f.turn === 2), "the second utterance's words");

    // ---- and now Titan takes the first one's words.
    gateway.release();
    await session.settle(() => session.of("heard-confirmed").length > 0, "the first utterance's confirmation");
    assert.equal(session.of("heard-confirmed").at(-1).turn, 1, "the confirmation belongs to the utterance it confirms");
    const ends = session.of("hear-end");
    assert.ok(!ends.some((f) => f.turn === 2),
      `closing the first utterance closed the second one's panel mid-sentence: ${JSON.stringify(ends)}`);

    // And the second utterance's words keep flowing, which the closed-turn guard used to stop.
    const before = session.of("hear").filter((f) => f.turn === 2).length;
    // Utterance one's close reset the audio window, and the person is still talking: this is the
    // microphone carrying utterance two's own sound after that close.
    await session.mic();
    stub.emitUserTranscript("and what about the deploy gate", { itemId: "item_2" });
    await session.settle(() => session.of("hear").filter((f) => f.turn === 2).length > before,
      "the second utterance still being heard");

    // It closes on its own terms, with its own turn on it.
    stub.emitSpeechStop();
    stub.emitToolCall({ name: "titan", args: { message: "and what about the deploy gate" }, callId: "c2", triple: false });
    await session.settle(() => session.of("hear-end").some((f) => f.turn === 2), "the second utterance's own closing frame");
    assert.equal(session.of("hear-end").filter((f) => f.turn === 2).length, 1);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-7: a transcript for the utterance before this one never paints into this one", async () => {
  // Neither service orders `.completed` transcription events between items -- OpenAI says so in its
  // own documentation -- so utterance 1's settled sentence can arrive after utterance 2 has opened.
  // Stamping it with whatever turn is current painted the old sentence into the new panel as settled
  // words. The event names its own item, which is the only thing that can tell them apart.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0013" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");

    await session.mic();
    stub.emitSpeechStarted({ itemId: "item_1" });
    stub.emitUserTranscript("open the box", { itemId: "item_1" });
    await session.settle(() => session.of("hear").length > 0, "the first utterance's words");
    await session.mic();
    stub.emitSpeechStarted({ itemId: "item_2" });
    await session.settle(() => session.of("hear-begin").length >= 2, "the second utterance opening");
    stub.emitUserTranscript("what time is it", { itemId: "item_2" });
    await session.settle(() => session.of("hear").some((f) => f.turn === 2), "the second utterance's words");

    // The late settled transcript of the FIRST item, which is the documented race.
    stub.emitUserTranscriptDone("open the box", { itemId: "item_1" });
    await new Promise((resolve) => { const timer = setTimeout(resolve, 200); timer.unref(); });
    const late = session.of("hear").filter((f) => f.itemId === "item_1" && f.turn === 2);
    assert.deepEqual(late, [], `the previous utterance's sentence was sent as this one's: ${JSON.stringify(late)}`);
    assert.equal(session.of("hear").filter((f) => f.turn === 2).at(-1).text, "what time is it",
      "the open panel's last words are still its own");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- VOICE-16 end to end: the brief on the wire, and the note at the end --------------------------

test("VOICE-16 end to end: the brief reaches the provider ONCE, inside the instructions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    brief: briefRow(),
    tail: (n) => (n >= 2 ? [reply("e1", "Nothing new in the mail.")] : []),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0016" }, gateway, dir });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    const instructions = String(stub.events.sessions[0].instructions ?? "");
    assert.ok(instructions.includes("You run a two-person managed services shop with Richard."), "the persona is on the wire");
    assert.ok(instructions.includes("the deploy gate runs on the R750"), "and the facts");
    assert.ok(instructions.includes("it did, both legs passed on the second run"), "and the last turn");
    assert.ok(instructions.startsWith("You are Titan, and you are talking out loud"));
    // READ ONCE AND WRITTEN ONCE. The prefix cache is the whole reason: rewriting the instructions
    // mid-call re-bills the conversation every turn, and asking the box again every turn would put the
    // round trip back that this wave exists to remove.
    assert.equal(gateway.briefReads, 1, `the brief was read ${gateway.briefReads} times`);
    assert.equal(gateway.of("getVoiceBrief")[0].args.id, "a1");
    // And nothing sends a second session.update for the life of the socket.
    await session.mic();
    stub.emitToolCall({ name: "titan", args: { message: "check the mail" }, triple: false });
    await session.settle(() => stub.events.toolOutputs.length > 0, "the turn going round");
    assert.equal(stub.events.sessions.length, 1, "one session.update and no more");
    assert.equal(stub.events.inbound.filter((event) => event.type === "session.update").length, 1);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-16 end to end: a box with no getVoiceBrief dials the phone line, byte for byte", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], brief: "unknown", tail: () => [] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0017" }, gateway, dir });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    // THE WHOLE FALLBACK, ON THE WIRE. Not "close to" the old instructions: the same bytes.
    assert.equal(String(stub.events.sessions[0].instructions ?? ""), PHONE_LINE_TITAN);
    assert.equal(gateway.briefReads, 1, "asked once, and a 404 is not worth asking twice");
    assert.ok(session.frames.log.some((line) => line.includes("not on this box's host")), session.frames.log.join(" | "));
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-16 end to end: a turn the model answers itself sends NOTHING to the box, and an action sends one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    brief: briefRow(),
    tail: (n) => (n >= 2 ? [reply("e1", "Nothing new in the mail.")] : []),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0018" }, gateway, dir });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");

    // A CONVERSATIONAL TURN. The person speaks and the model answers out of the brief, which on the
    // wire is a finished response with NO function call in it. What this pins is the relay's half: a
    // turn with no titan call costs the box nothing and leaves no panel open. Whether a real model
    // CHOOSES to answer rather than call the tool is a property of the model and the instructions and
    // cannot be proved against a stub; docs/VOICE-16-REPORT.md says so.
    await session.mic();
    stub.emitSpeechStarted({ itemId: "item_1" });
    await stub.emitUserTranscript("how are you doing today", { itemId: "item_1" });
    stub.emitUserTranscriptDone("how are you doing today", { itemId: "item_1" });
    await session.settle(() => session.of("hear").some((frame) => frame.final === true), "the person's settled words");
    await stub.speak("All good here, thanks.");
    await session.settle(() => session.of("hear-end").some((frame) => frame.reason === "no-answer"), "the panel closing on its own");
    assert.equal(gateway.of("sendPrompt").length, 0, "a conversational turn never reached the box");

    // AN ACTION. One titan call, one sendPrompt, and the reply comes back the way it always did.
    await session.mic();
    stub.emitToolCall({ name: "titan", args: { message: "check the mail" }, triple: false });
    await session.settle(() => gateway.of("sendPrompt").length > 0, "the job going to the box");
    await session.settle(() => stub.events.toolOutputs.length > 0, "and his answer coming back");
    assert.equal(gateway.of("sendPrompt").length, 1);
    assert.equal(gateway.of("sendPrompt")[0].args.prompt, "check the mail");
    assert.equal(JSON.parse(stub.events.toolOutputs[0].output).reply, "Nothing new in the mail.");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-16 end to end: the call leaves ONE note carrying both sides of what was said", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    brief: briefRow(),
    tail: (n) => (n >= 2 ? [reply("e1", "Nothing new in the mail.")] : []),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0019" }, gateway, dir });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    const sessionId = String(session.of("ready")[0].sessionId ?? "");

    await session.mic();
    stub.emitSpeechStarted({ itemId: "item_1" });
    await stub.emitUserTranscript("did the mail ever come through", { itemId: "item_1" });
    stub.emitUserTranscriptDone("did the mail ever come through", { itemId: "item_1" });
    await session.settle(() => session.of("hear").some((frame) => frame.final === true), "the person's settled words");
    // The voice's own words, which are what `response.output_audio_transcript` carries on both vendors.
    await stub.speak("Nothing new in the mail.");
    await session.settle(() => session.frames.binary.length > 0, "the voice actually speaking");

    // The person hangs up.
    session.client.send(JSON.stringify({ t: "stop" }));
    await session.settle(() => gateway.of("appendTranscriptNote").length > 0, "the call's note reaching the conversation");
    const notes = gateway.of("appendTranscriptNote");
    assert.equal(notes.length, 1, "one note for the whole call and not one per turn");
    const note = String(notes[0].args.text ?? "");
    assert.ok(note.startsWith("Voice call, "), note.slice(0, 120));
    assert.ok(note.includes("Them: did the mail ever come through"), `the person's side is missing: ${note}`);
    assert.ok(note.includes("Titan: Nothing new in the mail."), `the voice's side is missing: ${note}`);
    assert.ok(note.includes("do not reply to it"), "and it asks to be filed rather than answered");
    // It is stamped the way every other voice row is, so the console marks it spoken.
    assert.equal(notes[0].args.clientNonce, `voice:${sessionId}:note`);
    assert.equal(notes[0].args.agentId, "a1");
    // VOICE-16c. THE WHOLE POINT: the note is a row and not a turn. The only sendPrompt on this line
    // was the one the action took, and there was no action, so there is none at all.
    assert.equal(gateway.of("sendPrompt").length, 0, "the note ran no turn, so it asked for no reply");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-16 end to end: a line that said nothing leaves no note behind", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], brief: briefRow(), tail: () => [] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0020" }, gateway, dir });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    session.client.send(JSON.stringify({ t: "stop" }));
    await session.settle(() => session.of("bye").length > 0, "the line going down");
    assert.equal(gateway.of("appendTranscriptNote").length, 0, "nothing was said, so nothing was written");
    assert.equal(gateway.of("sendPrompt").length, 0, "and nothing fell back to a prompt either");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-16c end to end: a box whose host cannot file a note still gets it, as the old prompt", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  // The host predates the command. Everything else about this line is the line above.
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    brief: briefRow(),
    note: "unknown",
    tail: () => [],
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0031" }, gateway, dir });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    const sessionId = String(session.of("ready")[0].sessionId ?? "");

    await session.mic();
    stub.emitSpeechStarted({ itemId: "item_1" });
    await stub.emitUserTranscript("did the mail ever come through", { itemId: "item_1" });
    stub.emitUserTranscriptDone("did the mail ever come through", { itemId: "item_1" });
    await session.settle(() => session.of("hear").some((frame) => frame.final === true), "the person's settled words");

    session.client.send(JSON.stringify({ t: "stop" }));
    await session.settle(() => gateway.of("sendPrompt").length > 0, "the note falling back to a prompt");
    // It was TRIED the new way first, once, and then sent the old way, once.
    assert.equal(gateway.of("appendTranscriptNote").length, 1);
    const notes = gateway.of("sendPrompt");
    assert.equal(notes.length, 1, "one note, and the fallback did not double it");
    const note = String(notes[0].args.prompt ?? "");
    assert.ok(note.includes("Them: did the mail ever come through"), `the person's side is missing: ${note}`);
    // On this path the sentence asking not to be answered is the ONLY defence there is, so it is here.
    assert.ok(note.includes("do not reply to it"), note.slice(0, 200));
    assert.equal(notes[0].args.clientNonce, `voice:${sessionId}:note`);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- VOICE-14: barge-in, and only for the phone app ----------------------------------------------
//
// Jason, 2026-09-12 on the iPhone call screen: "I can't barge in." The microphone was shut while the
// agent spoke, on purpose, because on a laptop the interruption comes out of the speakers and the
// thing being interrupted is the person. In the app iOS owns the audio session and takes the agent's
// voice out of the microphone, so the page asks for barge-in on its opening frame and this relay
// gives it a different line: no echo gate, and a reply that is cancelled the moment somebody talks
// over it. Everything here is driven through the real stub provider and a real browser socket,
// because the claim is about what leaves this relay in which direction.

test("VOICE-14: the app's line cancels the reply, flushes the page, and counts the barge-in", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-barge-"));
  // SIX SECONDS OF REPLY IN ONE GO, so the booked time is still well in the future when the person
  // starts talking. The stub's default is three frames, and 300 ms is a race rather than a test.
  const stub = await startStubRealtime({ vendor: "xai", audioFrames: 60 });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0014" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    session.client.send(JSON.stringify({ t: "hello", bargeIn: true }));
    await session.settle(() => session.edge.sessions[0]?.bargeIn === true, "the relay taking the opening frame");
    const live = session.edge.sessions[0];

    await stub.speak("This is the long answer somebody is about to talk straight over.");
    await session.settle(() => session.frames.binary.length >= 60, "the reply reaching the page");
    assert.ok(live.gate.playsUntilMs > Date.now(), "there is sound still booked to come out of the speaker");

    // THE MICROPHONE IS OPEN WHILE THAT SOUND IS STILL BOOKED, which is the half of barge-in this
    // relay owns: a frame held here is a frame the provider's turn detection never sees, and then no
    // interruption is possible whatever the app does with its audio session.
    const appended = stub.events.appendFrames;
    session.client.send(micFrame());
    session.client.send(micFrame());
    await session.settle(() => stub.events.appendFrames >= appended + 2, "the person's own frames reaching the provider mid-reply");
    assert.equal(live.gate.heldFrames, 0, "a barge-in line holds nothing");

    stub.emitSpeechStarted({ itemId: "item_barge" });
    await session.settle(() => session.of("flush").length > 0, "the flush going to the page");
    assert.ok(stub.events.inbound.some((one) => one.type === "response.cancel"),
      `the provider was never told to stop: ${JSON.stringify(stub.events.inbound.map((one) => one.type))}`);
    assert.equal(session.of("flush").length, 1, "one flush, not one per frame that was queued");
    assert.equal(live.meter.bargeIns, 1, "and the session counted it");
    assert.equal(live.gate.playsUntilMs, 0, "the room is quiet as far as this relay is concerned");
    // AND THE PERSON'S OWN WORDS GET THEIR OWN PANEL. Without the release above, the gate still reads
    // as holding, hear-begin is dropped as the machine's own noise, and somebody talks into nothing.
    await session.settle(() => session.of("hear-begin").length > 0, "the person's panel opening on the interruption");

    // THE CLOSE LINE. The settled row in one sentence, with the barge-in count in it, because a call
    // where the person cut the agent off and one where the app never managed it look identical
    // everywhere else.
    await live.close("the gate closed this line");
    const closeLine = session.frames.log.find((one) => one.includes("settled this line"));
    assert.ok(closeLine != null, `no close line was printed: ${session.frames.log.join(" | ").slice(0, 400)}`);
    assert.match(closeLine, /1 barge-in\(s\)/);
    assert.match(closeLine, /ended because the gate closed this line/);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-14: a browser's line is byte for byte what it was -- frames held, nothing cancelled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-barge-"));
  const stub = await startStubRealtime({ vendor: "xai", audioFrames: 60 });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [] });
  let session = null;
  try {
    // NO OPENING FRAME AT ALL, which is what a browser sends: ui/machine-room/voice.js writes it only
    // when window.__titanbotShell.platform is "ios".
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0015" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    const live = session.edge.sessions[0];
    assert.equal(live.bargeIn, false, "a line nobody asked for barge-in on does not get it");

    await stub.speak("The reply a browser is not allowed to talk over.");
    await session.settle(() => session.frames.binary.length >= 60, "the reply reaching the page");
    const appended = stub.events.appendFrames;
    session.client.send(micFrame());
    session.client.send(micFrame());
    await session.settle(() => live.gate.heldFrames >= 2, "the relay dropping the frames the agent would be heard in");
    assert.equal(stub.events.appendFrames, appended, "and not one of them reached the provider");

    stub.emitSpeechStarted({ itemId: "item_desktop" });
    await new Promise((resolve) => { const timer = setTimeout(resolve, 250); timer.unref(); });
    assert.deepEqual(session.of("flush"), [], "a browser is never told to throw its playback away");
    assert.ok(!stub.events.inbound.some((one) => one.type === "response.cancel"),
      "and the provider is never told to stop mid-reply");
    assert.equal(live.meter.bargeIns, 0);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VOICE-14: an interruption with nothing playing cancels nothing, because there was nothing to interrupt", async () => {
  // The test is BOOKED AUDIO and not the orb: a speech_started sets the orb back to listening before
  // anything else runs, so a guard on the orb would cancel a response that had not made a sound yet,
  // on the one utterance a person says into a silent room.
  const dir = mkdtempSync(path.join(tmpdir(), "voice-barge-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({ agents: [{ id: "a1", name: "Titan", isRunning: true }], tail: () => [] });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0016" }, gateway, dir });
    await session.settle(() => session.of("ready").length > 0, "the ready frame");
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    session.client.send(JSON.stringify({ t: "hello", bargeIn: true }));
    await session.settle(() => session.edge.sessions[0]?.bargeIn === true, "the relay taking the opening frame");
    const live = session.edge.sessions[0];
    assert.equal(live.gate.playsUntilMs, 0, "nothing has been spoken on this line yet");

    stub.emitSpeechStarted({ itemId: "item_quiet" });
    await session.settle(() => session.of("hear-begin").length > 0, "the panel opening on an ordinary utterance");
    assert.deepEqual(session.of("flush"), [], "there was nothing queued to flush");
    assert.ok(!stub.events.inbound.some((one) => one.type === "response.cancel"), "and nothing to cancel");
    assert.equal(live.meter.bargeIns, 0, "so this was not a barge-in and is not counted as one");

    // AND A SECOND OPENING FRAME CANNOT CHANGE THE LINE MID-CALL. A page that could toggle this could
    // switch the echo gate off and on at will, and nothing about which host a socket came from changes
    // halfway through a call.
    session.client.send(JSON.stringify({ t: "hello", bargeIn: false }));
    await new Promise((resolve) => { const timer = setTimeout(resolve, 150); timer.unref(); });
    assert.equal(live.bargeIn, true, "the first opening frame is the one that decides");
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- VOICE-15c: nothing heard, nothing sent -------------------------------------------------------
//
// Jason, on TestFlight build 17, 2026-09-12: "when it was done, it said that the call ended and only
// one word was said: them. Nobody said that." The call had delivered 0 s of audio in; the provider
// produced one word out of its own greeting or out of silence, and this relay put it into Titan's
// conversation as a user turn through sendPrompt. tests/voice-transcription.test.mjs pins the frames
// this relay stops sending. What is pinned here is the end of the path that actually cost something:
// the box, and the line an operator reads afterwards.

test("VOICE-15c: a titan call on a line with no audio sends nothing to the box, and the close line says so", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-turn-"));
  const stub = await startStubRealtime({ vendor: "xai" });
  const gateway = fakeGateway({
    agents: [{ id: "a1", name: "Titan", isRunning: true }],
    tail: (n) => (n >= 2 ? [reply("e1", "Nothing new.")] : []),
  });
  let session = null;
  try {
    session = await openSession({ stub, settings: { enabled: true, vendor: "xai", apiKey: "xai-test-key-0019" }, gateway, dir });
    await session.settle(() => stub.events.sessions.length > 0, "the session.update reaching the provider");
    const live = session.edge.sessions[0];

    // NO MICROPHONE AT ALL, which is build 17.
    stub.emitToolCall({ name: "titan", args: { message: "them." }, callId: "c_silent", triple: false });
    await session.settle(() => stub.events.toolOutputs.length > 0, "the tool call being answered");
    assert.equal(gateway.of("sendPrompt").length, 0, "nothing reached his box");
    assert.deepEqual(session.of("heard-confirmed"), [], "and nothing was confirmed to the page");
    assert.match(JSON.parse(stub.events.toolOutputs[0].output).reply, /not hearing your microphone/);
    assert.equal(live.meter.heardDropped, 1);

    // AND IT IS NOT A LATCH. The microphone coming back mid-call is the ordinary case on a phone whose
    // audio session was taken by something else for a moment, and the next thing said has to land.
    await session.mic();
    stub.emitToolCall({ name: "titan", args: { message: "did the backup run" }, callId: "c_heard", triple: false });
    await session.settle(() => gateway.of("sendPrompt").length > 0, "the turn after the microphone came back");
    assert.equal(gateway.of("sendPrompt")[0].args.prompt, "did the backup run");
    assert.equal(live.meter.heardDropped, 1, "and nothing else was dropped");

    // THE LINE AN OPERATOR READS. A call where the provider wrote words nobody said looks identical to
    // a quiet call everywhere else on the settled row.
    await live.close("the gate closed this line");
    const closeLine = session.frames.log.find((one) => one.includes("settled this line"));
    assert.ok(closeLine != null, `no close line was printed: ${session.frames.log.join(" | ").slice(0, 400)}`);
    assert.match(closeLine, /1 provider text\(s\) dropped with nothing heard/);
  } finally {
    await session?.close();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
