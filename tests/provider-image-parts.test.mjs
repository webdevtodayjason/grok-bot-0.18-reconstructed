// ATTACH-1. A picture a person attaches has to reach the model, or the agent has to say plainly that
// it could not.
//
// The console leg was never the problem. Measured on Jason's box, 2026-09-09: the PNG arrived
// byte-identical in the agent's attachments folder, the host's containment check passed -- which is
// why he saw his own screenshot in his own message, twice -- and the model was sent nothing. It died
// in flattenParts, whose loop knew text, tool-call and tool-result and had no branch for a user
// message's own {type:"image"} part, so conversationInput emitted a plain string.
//
// This runs that seam in isolation: the slice of provider-session.ts from asRecord through
// conversationInput is lifted out with esbuild and executed. Reading the shipped file keeps the test
// honest about what actually runs, and running it rather than matching on its text is what makes the
// five cases below mean anything.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(repoRoot, "source/host/extensions/inference/provider-session.ts");

// The slice is self-contained except for four things it reads from the module around it. Those are
// stubbed rather than imported, because importing provider-session.ts drags in the Claude Agent SDK,
// the AI SDK and the box's own settings store, none of which this seam touches.
async function loadSeam() {
  const source = await readFile(SOURCE, "utf8");
  const start = source.indexOf("function asRecord(value: unknown): Loose | null {");
  const end = source.indexOf("function recordRoutedUsage(");
  assert.ok(start > 0 && end > start, "the message-flattening seam must still be findable in provider-session.ts");
  const slice = source.slice(start, end);
  assert.match(slice, /function conversationInput\(/, "the slice must reach conversationInput");
  assert.match(slice, /function flattenParts\(/, "the slice must include flattenParts");
  const preamble = [
    "type Loose = Record<string, any>;",
    "const IMAGE_PART_BYTES_MAX = 6_000_000;",
    "const GROK_AGENT_SYSTEM_PROMPT = 'AGENT_PROMPT';",
    "const GROK_ROUTER_SYSTEM_PROMPT = 'ROUTER_PROMPT';",
  ].join("\n");
  const exports = "export { flattenParts, conversationInput, countHistoryImageParts, countWireImageParts, USER_IMAGE_B64_MAX, HISTORY_IMAGE_B64_MAX };";
  const { code } = await transform(`${preamble}\n${slice}\n${exports}\n`, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const seam = await loadSeam();
const { conversationInput, countHistoryImageParts, countWireImageParts, USER_IMAGE_B64_MAX } = seam;

const bytes = (...values) => Uint8Array.from(values);
/** The shape context-processing pushes onto a user message once the attachment blob is hydrated. */
const attachment = (data, extra = {}) => ({ type: "image", image: data, mimeType: "image/png", ...extra });
const userTurn = (text, ...images) => ({ role: "user", content: [{ type: "text", text }, ...images] });
const imageUrls = (input) => input.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  .filter((part) => part?.type === "image_url")
  .map((part) => part.image_url.url);

test("an attached picture becomes exactly one image_url part, and both counters agree it is there", async () => {
  const messages = [userTurn("Reply with the one colour word that describes the attached image.", attachment(bytes(137, 80, 78, 71)))];
  const { input } = conversationInput(messages);

  const urls = imageUrls(input);
  assert.equal(urls.length, 1, "the operator's own attachment has to leave as a picture");
  assert.equal(urls[0], `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`);
  assert.equal(input.length, 1);
  assert.equal(input[0].role, "user");
  assert.equal(input[0].content[0].type, "text", "the person's own words travel beside the picture");
  assert.match(input[0].content[0].text, /one colour word/);

  // The trace counted only the shape a TOOL result renders, so an attachment read 0 and agreed with
  // the wire count at 0. Agreement at zero is exactly how this bug stayed invisible.
  assert.equal(countHistoryImageParts(messages), 1, "the history counter must know the attachment shape");
  assert.equal(countWireImageParts(input), 1, "and the wire counter must see it leave");
});

test("two attachments become two image_url parts, in the order they were attached", async () => {
  const first = bytes(1, 2, 3), second = bytes(9, 9, 9, 9);
  const { input } = conversationInput([userTurn("Two shots.", attachment(first), attachment(second, { mimeType: "image/jpeg" }))]);

  const urls = imageUrls(input);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], `data:image/png;base64,${Buffer.from(first).toString("base64")}`);
  assert.equal(urls[1], `data:image/jpeg;base64,${Buffer.from(second).toString("base64")}`, "the second image keeps its own media type");
  assert.equal(countHistoryImageParts([userTurn("Two shots.", attachment(first), attachment(second))]), 2);
});

test("an over-cap image is left out and NAMED, never silently dropped", async () => {
  // Comfortably past the per-image ceiling once base64 has grown it by a third.
  const huge = new Uint8Array(Math.ceil((USER_IMAGE_B64_MAX * 3) / 4) + 1_000);
  const small = bytes(4, 5, 6);
  const messages = [userTurn("Look at both.", attachment(huge, { filename: "huge.png" }), attachment(small, { filename: "small.png" }))];
  const { input } = conversationInput(messages);

  const urls = imageUrls(input);
  assert.equal(urls.length, 1, "only the one that fits is sent");
  assert.equal(urls[0], `data:image/png;base64,${Buffer.from(small).toString("base64")}`);
  const text = input[0].content.find((part) => part.type === "text").text;
  assert.match(text, /huge\.png/, "the picture that did not travel is named to the model");
  assert.match(text, /too large/i);
  assert.doesNotMatch(text, /small\.png/, "the one that did travel is not announced as missing");
});

test("a tool-result screenshot still becomes the SUB-2b user message, unchanged", async () => {
  const screenshot = Buffer.from("a screenshot").toString("base64");
  const messages = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "Computer", args: { action: "screenshot" } }] },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call_1",
        result: "clicked",
        experimental_content: [{ type: "image", data: screenshot, mimeType: "image/png" }],
      }],
    },
  ];
  const { input } = conversationInput(messages);

  const toolMessage = input.find((message) => message.role === "tool");
  assert.equal(toolMessage.tool_call_id, "call_1");
  assert.equal(toolMessage.content, "clicked");
  const follower = input[input.indexOf(toolMessage) + 1];
  assert.equal(follower.role, "user", "the picture follows the tool result as its own user message");
  assert.equal(follower.content[0].text, "Screenshot from the tool call above.");
  assert.equal(follower.content[1].image_url.url, `data:image/png;base64,${screenshot}`);
  assert.equal(countWireImageParts(input), 1);
});

test("when the endpoint has refused a picture, none is sent and the model is told so in words", async () => {
  const messages = [userTurn("What colour is this?", attachment(bytes(137, 80, 78, 71), { filename: "solid-blue.png" }))];
  const { input } = conversationInput(messages, false, false);

  assert.equal(imageUrls(input).length, 0, "a refused endpoint gets no bytes at all, not even to be rejected again");
  assert.equal(typeof input[0].content, "string", "with nothing to carry, the message goes back to being plain text");
  assert.match(input[0].content, /What colour is this\?/, "the person's question survives");
  assert.match(input[0].content, /solid-blue\.png/, "and the picture it could not see is named");
  assert.match(input[0].content, /could not be sent/i);
  assert.match(input[0].content, /rather than guessing/i, "the model is told to say so rather than invent an answer");
  // The counters still disagree, and that disagreement is the honest reading: the history holds a
  // picture, the wire carries none.
  assert.equal(countHistoryImageParts(messages), 1);
  assert.equal(countWireImageParts(input), 0);
});

test("a turn with no pictures is byte-identical to what it was before any of this", async () => {
  const messages = [
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ];
  const { input, instructions } = conversationInput(messages);
  assert.deepEqual(input, [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
  assert.equal(instructions, "Be brief.");
});

// --- B3, the guard: sending the picture must not turn a silent miss into a dead turn -------------
//
// MEASURED on grok-bot-local-vm, 2026-09-09: glm-5.3 answers an image_url part with 400 code 1210,
// "messages.content.type is invalid, allowed values: ['text']", three times out of three, and the
// turn ends with nothing in the transcript. So the transport catches that family once, remembers the
// refusal for the life of the process, and asks the same question again with a sentence where the
// picture was. Working picture, or an honest sentence, never a dead turn.
const TRANSPORT = path.join(repoRoot, "source/host/extensions/inference/openai-compatible-chat.ts");
async function loadTransport() {
  const { code } = await transform(await readFile(TRANSPORT, "utf8"), { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const transport = await loadTransport();

function chatStream(text) {
  const events = [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const GLM_1210 = JSON.stringify({ error: { code: "1210", message: "messages.content.type is invalid, allowed values: ['text']" } });
const pictureTurn = () => [{
  role: "user",
  content: [
    { type: "text", text: "The user attached a file.\n- /home/box/sand-data/attachments/solid-blue.png (2 KB)" },
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ],
}];
async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("a model that refuses pictures gets the same question again, with a sentence where the image was", async () => {
  transport.forgetImageRefusals();
  const sent = [];
  const fetchStub = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return sent.length === 1
      ? new Response(GLM_1210, { status: 400 })
      : chatStream("I cannot see the picture on this model.");
  };
  const events = await drain(transport.streamOpenAiCompatibleChat({
    fetch: fetchStub, baseUrl: "http://127.0.0.1:11434/v1", model: "glm-5.3",
    instructions: "be brief", input: pictureTurn(),
  }));

  assert.equal(sent.length, 2, "the turn is asked again rather than dying");
  assert.equal(events.at(-1).type, "done", "and it completes");
  assert.ok(transport.carriesImageParts(sent[0].messages), "the first attempt did carry the picture");
  assert.ok(!transport.carriesImageParts(sent[1].messages), "the retry does not");
  const retried = sent[1].messages.find((message) => typeof message.content === "string" && message.content.includes("solid-blue.png"));
  assert.ok(retried != null, "the file and its path on this box survive the retry");
  assert.match(retried.content, /could not be sent to this model/i);
  assert.match(retried.content, /rather than guessing/i, "so the agent says so instead of inventing what it shows");
  assert.ok(transport.endpointRefusesImages("http://127.0.0.1:11434/v1", "glm-5.3"), "the refusal is remembered");
});

test("once it has refused, the bytes are not spent again on that endpoint and model", async () => {
  transport.forgetImageRefusals();
  transport.noteEndpointRefusesImages("http://127.0.0.1:11434/v1", "glm-5.3");
  const sent = [];
  const fetchStub = async (_url, init) => { sent.push(JSON.parse(init.body)); return chatStream("noted"); };
  await drain(transport.streamOpenAiCompatibleChat({
    fetch: fetchStub, baseUrl: "http://127.0.0.1:11434/v1/", model: "glm-5.3",
    instructions: "be brief", input: pictureTurn(),
  }));

  assert.equal(sent.length, 1, "no round trip is spent learning what is already known");
  assert.ok(!transport.carriesImageParts(sent[0].messages));
  // A trailing slash on the base URL is the same endpoint, not a second one to re-learn.
  assert.ok(transport.endpointRefusesImages("http://127.0.0.1:11434/v1", "glm-5.3"));
  // Another model on the same server has said nothing, so it still gets its picture.
  assert.ok(!transport.endpointRefusesImages("http://127.0.0.1:11434/v1", "qwen3-vl"));
});

test("a 400 that is not about pictures is still a failure, not a reason to strip them", async () => {
  transport.forgetImageRefusals();
  let calls = 0;
  const fetchStub = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "context length exceeded" } }), { status: 400 }); };
  await assert.rejects(
    drain(transport.streamOpenAiCompatibleChat({
      fetch: fetchStub, baseUrl: "http://127.0.0.1:11434/v1", model: "glm-5.3",
      instructions: "be brief", input: pictureTurn(),
    })),
    /context length exceeded/,
  );
  assert.equal(calls, 1, "an unrelated 400 is not retried");
  assert.ok(!transport.endpointRefusesImages("http://127.0.0.1:11434/v1", "glm-5.3"), "and does not blame the picture");
  transport.forgetImageRefusals();
});
