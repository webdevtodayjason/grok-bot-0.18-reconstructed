import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build, transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadSource(relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const loadTransport = () => loadSource("source/host/extensions/inference/openai-compatible-chat.ts");

// provider-session.ts reaches installed SDKs, so it is exercised through a real bundle.
async function loadProviderSession() {
  const outfile = path.join(repoRoot, `.tmp-context-window-${randomUUID()}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/provider-session.ts")],
    bundle: true, format: "esm", platform: "node", target: "node22", packages: "external",
    outfile, logLevel: "silent",
  });
  return { module: await import(`file://${outfile}`), cleanup: () => rm(outfile, { force: true }) };
}

// A fake OpenAI-compatible server: `/v1/models` answers `models`, `/v1/chat/completions` answers
// whatever `chat` decides -- an SSE turn, or a non-2xx with a body, so the transport's error path
// is exercised with a real HTTP response rather than a thrown stub.
async function serve({ models, chat }) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.length > 0 ? JSON.parse(raw) : null;
      requests.push({ url: request.url, method: request.method, body });
      if (request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify(models));
      }
      const reply = chat(body, requests.length);
      if (reply.status !== undefined) {
        response.writeHead(reply.status, { "content-type": "application/json" });
        return response.end(JSON.stringify(reply.body));
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const event of reply.events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const TEXT_TURN = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "Hey." } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 3 } },
];

// Verbatim from a live xAI probe on 2026-09-01: a 5MB request against grok-4.6.
const XAI_OVERFLOW = { status: 400, body: { code: "invalid-argument", error: "This model's maximum prompt length is 500000 but the request contains 1427641 tokens." } };
// Also verbatim: the mid-stream failure a long-lived agent hit all afternoon. Not an overflow.
const XAI_INTERNAL = { status: 500, body: { message: "Internal error during token generation", type: "server_error", code: "internal" } };

async function runTurn(module, baseUrl, env = {}) {
  const previous = { ...process.env };
  process.env.SAND_OPENAI_COMPATIBLE_BASE_URL = baseUrl;
  process.env.SAND_OPENAI_COMPATIBLE_MODEL = "grok-4.6";
  delete process.env.SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW;
  Object.assign(process.env, env);
  try {
    const session = module.createProviderPromptSession("openai-compatible");
    const executor = session.getExecutor(undefined);
    executor.appendMessages([{ role: "user", content: "hi" }]);
    const result = executor.stream({}, `inv-${randomUUID()}`, undefined);
    // Every deferred the executor hands back is rejected on failure; the engine consumes them
    // all, this harness only reads two, and an unobserved rejection fails the test as an
    // uncaught exception rather than as the assertion it is meant to be.
    for (const pending of [result.usage, result.response, result.providerMetadata]) pending.catch(() => {});
    const parts = [];
    let streamError;
    try { for await (const part of result.fullStream) parts.push(part); } catch (error) { streamError = error; }
    const extended = await result.extendedUsage.catch((error) => ({ error }));
    return { parts, streamError, extended };
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

test("the context window setting parses from env or secrets, and rejects nonsense", async () => {
  const { resolveOpenAiCompatibleSettings } = await loadTransport();
  const base = { SAND_OPENAI_COMPATIBLE_MODEL: "m" };
  assert.equal(resolveOpenAiCompatibleSettings(base).contextWindow, null);
  assert.equal(resolveOpenAiCompatibleSettings({ ...base, SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW: "500000" }).contextWindow, 500000);
  assert.equal(resolveOpenAiCompatibleSettings(base, { SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW: "32000" }).contextWindow, 32000);
  assert.equal(resolveOpenAiCompatibleSettings({ ...base, SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW: "0" }).contextWindow, null);
  assert.equal(resolveOpenAiCompatibleSettings({ ...base, SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW: "lots" }).contextWindow, null);
});

test("the models endpoint is the chat endpoint's sibling for every base URL shape", async () => {
  const { openAiCompatibleModelsEndpoint } = await loadTransport();
  assert.equal(openAiCompatibleModelsEndpoint("https://api.x.ai/v1"), "https://api.x.ai/v1/models");
  assert.equal(openAiCompatibleModelsEndpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1/models");
  assert.equal(openAiCompatibleModelsEndpoint("http://box:8000/v1/chat/completions"), "http://box:8000/v1/models");
});

test("the probe reads the window the endpoint advertises, in the field each server uses", async () => {
  const { fetchOpenAiCompatibleContextWindow } = await loadTransport();
  const xai = await serve({ models: { data: [{ id: "grok-4.6", context_length: 500000 }] }, chat: () => ({ events: TEXT_TURN }) });
  const vllm = await serve({ models: { data: [{ id: "nemotron", max_model_len: 131072 }] }, chat: () => ({ events: TEXT_TURN }) });
  const bare = await serve({ models: { data: [{ id: "llama" }] }, chat: () => ({ events: TEXT_TURN }) });
  try {
    assert.equal(await fetchOpenAiCompatibleContextWindow(fetch, { baseUrl: xai.baseUrl, model: "grok-4.6", apiKey: "k" }), 500000);
    assert.equal(await fetchOpenAiCompatibleContextWindow(fetch, { baseUrl: vllm.baseUrl, model: "nemotron", apiKey: null }), 131072);
    assert.equal(await fetchOpenAiCompatibleContextWindow(fetch, { baseUrl: bare.baseUrl, model: "llama", apiKey: null }), null);
    assert.equal(await fetchOpenAiCompatibleContextWindow(fetch, { baseUrl: xai.baseUrl, model: "not-served", apiKey: null }), null);
    assert.equal(await fetchOpenAiCompatibleContextWindow(fetch, { baseUrl: "http://127.0.0.1:9", model: "x", apiKey: null }, 300), null);
  } finally { await Promise.all([xai.close(), vllm.close(), bare.close()]); }
});

test("a turn reports the advertised window instead of zero, so the compaction trigger can arm", async () => {
  const { module, cleanup } = await loadProviderSession();
  const server = await serve({ models: { data: [{ id: "grok-4.6", context_length: 4321 }] }, chat: () => ({ events: TEXT_TURN }) });
  try {
    const { extended, streamError } = await runTurn(module, server.baseUrl);
    assert.equal(streamError, undefined);
    assert.equal(extended.maxTokens, 4321);
    assert.ok(server.requests.some((r) => r.url.endsWith("/models")), "the endpoint was asked for its window");
  } finally { await server.close(); await cleanup(); }
});

test("an operator-configured window wins and the endpoint is not asked", async () => {
  const { module, cleanup } = await loadProviderSession();
  const server = await serve({ models: { data: [{ id: "grok-4.6", context_length: 4321 }] }, chat: () => ({ events: TEXT_TURN }) });
  try {
    const { extended } = await runTurn(module, server.baseUrl, { SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW: "9000" });
    assert.equal(extended.maxTokens, 9000);
    assert.ok(!server.requests.some((r) => r.url.endsWith("/models")), "no probe when configured");
  } finally { await server.close(); await cleanup(); }
});

test("a real xAI overflow becomes InputTokenLimitError, which is what the compact-and-retry rescue keys on", async () => {
  const { module, cleanup } = await loadProviderSession();
  const server = await serve({ models: { data: [{ id: "grok-4.6", context_length: 500000 }] }, chat: () => XAI_OVERFLOW });
  try {
    const { streamError, extended } = await runTurn(module, server.baseUrl);
    assert.ok(streamError instanceof Error);
    assert.equal(streamError.name, "InputTokenLimitError");
    assert.match(streamError.message, /maximum prompt length is 500000/);
    assert.equal(extended.error?.name, "InputTokenLimitError", "every rejected promise carries the classified error");
  } finally { await server.close(); await cleanup(); }
});

test("a genuine 500 is NOT dressed up as an overflow", async () => {
  const { module, cleanup } = await loadProviderSession();
  const server = await serve({ models: { data: [{ id: "grok-4.6", context_length: 500000 }] }, chat: () => XAI_INTERNAL });
  try {
    const { streamError } = await runTurn(module, server.baseUrl);
    assert.ok(streamError instanceof Error);
    assert.notEqual(streamError.name, "InputTokenLimitError");
    assert.match(streamError.message, /Internal error during token generation/);
  } finally { await server.close(); await cleanup(); }
});
