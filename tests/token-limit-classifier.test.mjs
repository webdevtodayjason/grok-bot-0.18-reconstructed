// P1b: the token-limit classifier must recognise the wordings local routes use, or an oversized
// history errors the turn instead of entering rescue-and-compact. Bundled with esbuild because the
// module imports its error classes.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({ entryPoints: [path.join(repoRoot, "source/packages/chat-inference/token-limit-error-classification.ts")], bundle: true, write: false, format: "esm", platform: "node", target: "es2022" });
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

const cases = [
  ["LiteLLM over llama.cpp", 'litellm.ContextWindowExceededError: litellm.BadRequestError: ContextWindowExceededError: OpenAIException - request (295101 tokens) exceeds the available context size (32768 tokens), try increasing it'],
  ["OpenAI / vLLM", "This model's maximum context length is 128000 tokens. However, you requested 140212 tokens (139212 in the messages, 1000 in the completion). Please reduce the length of the messages or completion."],
  ["xAI", "This model's maximum prompt length is 500000 but the request contains 1427641 tokens."],
];
for (const [name, message] of cases) {
  test(`${name} overflow classifies as an input token limit error`, () => {
    const error = mod.classifyTokenLimitErrorFromMessage(message);
    assert.ok(error, "classified");
    assert.equal(error.constructor.name, "InputTokenLimitError");
  });
}
test("a plain server error is not an overflow", () => {
  assert.equal(mod.classifyTokenLimitErrorFromMessage("Internal error during token generation"), undefined);
});
