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
 * and the streaming path is proved beside it -- sentences handed out in order as the draft grows, and
 * a tool output that carries only what is LEFT so the front of the answer is never read twice.
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
  GREETINGS, MAX_TITAN_ROUNDS, TURN_WAIT_CAP_S, pickGreeting,
  isUnknownGatewayMethod, makeCallDedupe, makeSentenceCutter, makeTurnRunner, makeVoiceEdge,
  makeVoicePolicy, matchYesNo, pendingCardsOf, remainderOf, resolveHeldCard, resolveVoiceAgent,
  splitSentences, toolCallsOf, writeVoiceSettings,
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
function fakeGateway({ agents = [{ id: "a1", name: "Chief of Staff", isRunning: true }], tail = () => [], fail = null, draft = null } = {}) {
  const calls = [];
  let polls = 0;
  let draftReads = 0;
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
    if (command === "resolveAutoReviewApproval" || command === "resolveLocalToolPermission" || command === "respondToWidget") return { ok: true };
    return {};
  };
  return {
    call, calls,
    of: (command) => calls.filter((row) => row.command === command),
    get polls() { return polls; },
    get draftReads() { return draftReads; },
  };
}

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

test("a growing draft is spoken sentence by sentence, and the tool result carries only what is left", async () => {
  const clock = fakeClock();
  const whole = "The gate is green. Two legs failed earlier. I re-ran both of them.";
  // The draft grows over three reads and the finished entry lands on the fourth tail poll, which is
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
  assert.deepEqual(spoken, ["The gate is green.", "Two legs failed earlier.", "I re-ran both of them."],
    `spoken was ${JSON.stringify(spoken)}; the relay said nothing else`);
  assert.deepEqual(result.spoken, spoken);
  assert.deepEqual(result.remaining, [], "every sentence was already read out, so nothing is owed");
  assert.equal(result.diverged, false);
  // The whole reply is still the result, because the panel and the conversation hold the whole reply.
  assert.equal(result.text, whole);
  assert.deepEqual(result.pieces, splitSentences(whole));
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

async function openSession({ stub, settings, gateway, dir, greet = false }) {
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

test("VOICE-3 end to end: each sentence is read out as it lands and the tool output adds nothing", async () => {
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
    stub.emitToolCall({ name: "titan", args: { message: "how did the gate go" }, triple: true });
    await session.settle(() => stub.events.toolOutputs.length > 0, "the tool output going back", 900);

    // THREE sentences went out as text items, in order, each one a "read this out" the model speaks.
    // On xAI each of these is a billed flat fee, which is the price of the first sentence arriving
    // twenty seconds early and is why docs/VOICE.md says so out loud.
    const spokenItems = stub.events.inbound
      .filter((event) => event.type === "conversation.item.create" && event.item?.type === "message")
      .map((event) => String(event.item.content?.[0]?.text ?? ""));
    assert.equal(spokenItems.length, 3, `the relay sent ${spokenItems.length} text items: ${JSON.stringify(spokenItems)}`);
    assert.ok(spokenItems[0].endsWith("The gate is green."), spokenItems[0]);
    assert.ok(spokenItems[1].endsWith("Two legs failed earlier."), spokenItems[1]);
    assert.ok(spokenItems[2].endsWith("I re-ran both of them."), spokenItems[2]);
    assert.equal(stub.events.billableItems, 3, "one billed item per sentence, counted on the Spend line");

    // And the tool output adds NOTHING, because there is nothing left the person has not heard. The
    // call is still closed -- a function_call_output the model never gets wedges the conversation --
    // and there is no response.create behind it, so the model is not asked to talk over a finished
    // answer. Three response.create, one per sentence, and not a fourth.
    assert.equal(stub.events.toolOutputs.length, 1);
    const output = JSON.parse(stub.events.toolOutputs[0].output);
    assert.deepEqual(output, { reply: "", sentences: [], alreadyRead: true });
    assert.equal(stub.events.responseCreates, 3, `there were ${stub.events.responseCreates} response.create`);

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
    stub.emitSpeechStarted({ itemId: "item_1" });
    await session.settle(() => session.of("hear-begin").length > 0, "the panel for the first utterance");
    stub.emitUserTranscript("what is the team working on", { itemId: "item_1" });
    stub.emitUserTranscriptDone("what is the team working on", { itemId: "item_1" });
    stub.emitSpeechStop();
    stub.emitToolCall({ name: "titan", args: { message: "what is the team working on" }, callId: "c1", triple: false });
    await session.settle(() => gateway.of("sendPrompt").length > 0, "the first utterance reaching Titan");

    // ---- utterance 2 begins while Titan still has the first.
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

    stub.emitSpeechStarted({ itemId: "item_1" });
    stub.emitUserTranscript("open the box", { itemId: "item_1" });
    await session.settle(() => session.of("hear").length > 0, "the first utterance's words");
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

// ---- VOICE-14: barge-in, and only for the phone app ----------------------------------------------
//
// Jason, 2026-09-12 on the iPhone call screen: "I can't barge in." The microphone was shut while the
// agent spoke, on purpose, because on a laptop the interruption comes out of the speakers and the
// thing being interrupted is the person. In the app iOS owns the audio session and takes the agent's
// voice out of the microphone, so the page asks for barge-in on its opening frame and this relay
// gives it a different line: no echo gate, and a reply that is cancelled the moment somebody talks
// over it. Everything here is driven through the real stub provider and a real browser socket,
// because the claim is about what leaves this relay in which direction.

/** One 100 ms frame of something that is not silence, which is what a microphone really sends. */
const micFrame = () => {
  const out = Buffer.alloc(4800);
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE(3000, i);
  return out;
};

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
