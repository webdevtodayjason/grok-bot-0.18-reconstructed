/**
 * VOICE-3, the host's half: the reply an agent is still writing, projected for the gateway.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and it is not the arithmetic. The draft decides what a voice reads
 * out loud, so the one way to get this wrong is to project text that is not the reply. This host has
 * two streams of model output and only ONE of them reaches a person: turn-runtime.ts's own reply-nudge
 * prompt says "Plain assistant text is NEVER shown to the user; only a real SendMessage tool
 * invocation reaches them". So the first test below is the load-bearing one -- a turn that streams
 * prose and then delivers a different message must project the DELIVERED message and nothing else, or
 * Titan reads his own scratch notes out over the phone and then reads the answer a second time.
 *
 * The rest pins the lifetime: one message per turn, a second message does not reopen the draft, a turn
 * that ends takes the draft with it, and a truncated or half-written args string is read without
 * throwing. Every case is driven through TurnDraftStore exactly as handleAgentUpdate drives it.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".voice-turn-draft-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const bundled = await build({
  entryPoints: [path.join(repoRoot, "source/host/extensions/transcript/turn-draft.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", logLevel: "silent",
});
const bundlePath = path.join(stage, "turn-draft.cjs");
writeFileSync(bundlePath, bundled.outputFiles[0].text, "utf8");
const {
  MAX_TURN_DRAFT_CHARS,
  SEND_MESSAGE_TOOL_CALL_NAME,
  TurnDraftStore,
  readSendMessageDraftText,
} = createRequire(import.meta.url)(bundlePath);

/** The forwarded update shape agent-adapters.ts builds for a send-message tool call. */
const sendCall = (content, status = "pending") => ({
  type: "tool-call", id: "call_1", name: SEND_MESSAGE_TOOL_CALL_NAME, status,
  args: JSON.stringify({ text: { content } }),
});
const prose = (text) => ({ type: "text-delta", text });
const delivered = () => ({ type: "send-message", message: { type: "text", content: "whatever" } });

function openStore(nonce = "voice:s1:1") {
  let clock = 1_700_000_000_000;
  const store = new TurnDraftStore(() => (clock += 10));
  store.openTurn({ conversationId: "a1", turnId: "att-1", turnEpoch: 4, clientNonce: nonce });
  return store;
}

// ------------------------------------------------- the one that decides what a voice says out loud

test("the draft is the DELIVERED message, and the model's own prose never enters it", () => {
  const store = openStore();
  // The model thinking out loud. None of this reaches a person on any surface of this product.
  assert.equal(store.applyUpdate("a1", prose("Let me check the gate log. ")), null);
  assert.equal(store.applyUpdate("a1", prose("Two legs look red, I should re-run them.")), null);
  assert.equal(store.read("a1").text, "", "not one character of assistant prose is in the draft");
  // And then the message it actually sends.
  const grown = store.applyUpdate("a1", sendCall("The gate is green."));
  assert.equal(grown.text, "The gate is green.");
  assert.equal(store.read("a1").text, "The gate is green.");
});

test("a draft opens empty, so a reader can tell a turn that has said nothing from no turn at all", () => {
  const store = openStore();
  const open = store.read("a1");
  assert.equal(open.text, "");
  assert.equal(open.complete, false);
  assert.equal(open.sends, 0);
  assert.equal(open.conversationId, "a1");
  assert.equal(open.turnId, "att-1");
  assert.equal(open.turnEpoch, 4);
  assert.equal(open.clientNonce, "voice:s1:1");
  assert.equal(store.read("b2"), null, "an agent with no turn open has no draft");
});

test("the nonce is echoed verbatim, and a turn started without one carries null", () => {
  assert.equal(openStore("voice:abc:7").read("a1").clientNonce, "voice:abc:7");
  assert.equal(openStore("").read("a1").clientNonce, null);
  const store = new TurnDraftStore();
  store.openTurn({ conversationId: "a1", turnId: "t", turnEpoch: 1 });
  assert.equal(store.read("a1").clientNonce, null);
});

// ------------------------------------------------------------------------------- growth and closing

test("partial args REPLACE the text rather than appending, and an unchanged read reports no change", () => {
  const store = openStore();
  assert.equal(store.applyUpdate("a1", sendCall("The gate")).text, "The gate");
  assert.equal(store.applyUpdate("a1", sendCall("The gate is")).text, "The gate is");
  // The same partial arriving twice must not write "The gate isThe gate is": the forwarded args are
  // the WHOLE partial message every time.
  assert.equal(store.applyUpdate("a1", sendCall("The gate is")), null);
  assert.equal(store.read("a1").text, "The gate is");
  assert.equal(store.applyUpdate("a1", sendCall("The gate is green.", "done")).complete, true);
});

test("a completed tool call closes the draft, and so does a delivery that streamed no partial at all", () => {
  const viaTool = openStore();
  viaTool.applyUpdate("a1", sendCall("Done.", "done"));
  assert.equal(viaTool.read("a1").complete, true);

  // A model that emitted the whole call in one event: no partial ever arrived, the delivery is the
  // first thing the store hears about, and the draft still closes rather than staying open forever.
  const viaDelivery = openStore();
  const closed = viaDelivery.applyUpdate("a1", delivered());
  assert.equal(closed.complete, true);
  assert.equal(closed.sends, 1);
  assert.equal(closed.text, "", "there was nothing to project, and the caller reads the entry instead");
});

test("a SECOND message of the same turn does not reopen the draft", () => {
  const store = openStore();
  store.applyUpdate("a1", sendCall("Starting on it now.", "done"));
  store.applyUpdate("a1", delivered());
  // The turn carries on working and sends a follow-up. That one is an announcement on the caller's
  // side, read whole from the transcript; growing the draft into it would have the voice start
  // message two while it was still handing message one back.
  assert.equal(store.applyUpdate("a1", { type: "tool-call", id: "call_2", name: SEND_MESSAGE_TOOL_CALL_NAME, status: "pending", args: JSON.stringify({ text: { content: "Done, the gate is green." } }) }), null);
  assert.equal(store.applyUpdate("a1", delivered()), null, "the second delivery changes nothing worth telling anybody");
  const draft = store.read("a1");
  assert.equal(draft.text, "Starting on it now.");
  assert.equal(draft.sends, 2, "both deliveries are counted even though only the first is projected");
});

test("a closed turn takes its draft with it", () => {
  const store = openStore();
  store.applyUpdate("a1", sendCall("Half a sen"));
  store.closeTurn("a1");
  assert.equal(store.read("a1"), null);
  assert.equal(store.applyUpdate("a1", sendCall("anything")), null, "an update after the turn is dropped");
  // The next turn starts clean rather than inheriting the last one's words.
  store.openTurn({ conversationId: "a1", turnId: "att-2", turnEpoch: 5, clientNonce: "voice:s1:2" });
  assert.equal(store.read("a1").text, "");
  assert.equal(store.read("a1").turnId, "att-2");
});

test("a turn on another agent is a separate draft", () => {
  const store = openStore();
  store.openTurn({ conversationId: "b2", turnId: "att-9", turnEpoch: 1, clientNonce: "voice:other:1" });
  store.applyUpdate("a1", sendCall("His answer."));
  store.applyUpdate("b2", sendCall("Her answer."));
  assert.equal(store.read("a1").text, "His answer.");
  assert.equal(store.read("b2").text, "Her answer.");
  store.closeTurn("a1");
  assert.equal(store.read("b2").text, "Her answer.", "closing one turn does not touch the other");
});

// ----------------------------------------------------------------------------- reading the args

test("every args shape that is not a text message reads as nothing to say", () => {
  assert.equal(readSendMessageDraftText(JSON.stringify({ text: { content: "Hello." } })), "Hello.");
  // Before the model has written a character.
  assert.equal(readSendMessageDraftText("{}"), "");
  // A picture, a widget, a card: all real messages, none of them something to read out mid-turn.
  assert.equal(readSendMessageDraftText(JSON.stringify({ attachment: { url: "/box/shot.png" } })), "");
  assert.equal(readSendMessageDraftText(JSON.stringify({ text: {} })), "");
  assert.equal(readSendMessageDraftText(JSON.stringify({ text: { content: 7 } })), "");
  // And the shapes that would throw if this were a bare JSON.parse.
  assert.equal(readSendMessageDraftText("not json at all"), "");
  assert.equal(readSendMessageDraftText(undefined), "");
  assert.equal(readSendMessageDraftText(null), "");
  assert.equal(readSendMessageDraftText(""), "");
  assert.equal(readSendMessageDraftText(JSON.stringify("a bare string")), "");
  assert.equal(readSendMessageDraftText(JSON.stringify(null)), "");
});

test("the truncation conversation-outline.ts appends is stripped before the parse, not after it", () => {
  // getToolCallActivityArgs caps at MAX_TOOL_ACTIVITY_ARGS_CHARS and appends its own marker, which
  // makes the string no longer JSON. A reply long enough to hit that loses its tail here and the
  // caller's read of the finished entry is what puts it back.
  const body = JSON.stringify({ text: { content: "The gate is green." } });
  assert.equal(readSendMessageDraftText(`${body}\n… (truncated)`), "The gate is green.");
  assert.equal(readSendMessageDraftText(`${body.slice(0, 20)}\n… (truncated)`), "", "a cut in the middle of the JSON is not guessed at");
});

test("the text a draft carries is bounded", () => {
  const long = "x".repeat(MAX_TURN_DRAFT_CHARS + 500);
  const read = readSendMessageDraftText(JSON.stringify({ text: { content: long } }));
  assert.equal(read.length, MAX_TURN_DRAFT_CHARS);
  const store = openStore();
  assert.equal(store.applyUpdate("a1", sendCall(long)).text.length, MAX_TURN_DRAFT_CHARS);
});

test("an update for an agent with no open turn is dropped rather than opening one", () => {
  const store = new TurnDraftStore();
  assert.equal(store.applyUpdate("a1", sendCall("nobody asked")), null);
  assert.equal(store.read("a1"), null);
  // And a turn cannot be opened for nothing.
  store.openTurn({ conversationId: "", turnId: "t", turnEpoch: 1 });
  assert.equal(store.read(""), null);
});

test("only the send-message tool call feeds the draft; every other tool is ignored", () => {
  const store = openStore();
  assert.equal(store.applyUpdate("a1", { type: "tool-call", id: "c9", name: "shellToolCall", status: "pending", args: JSON.stringify({ text: { content: "rm -rf /" } }) }), null);
  assert.equal(store.applyUpdate("a1", { type: "thinking-delta", text: "hmm" }), null);
  assert.equal(store.applyUpdate("a1", { type: "turn-ended" }), null);
  assert.equal(store.read("a1").text, "");
});
