import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
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

// provider-session.ts reaches the installed SDKs and Grok Bot's own modules, so the routed
// turn is exercised through a real bundle rather than a single-file transform.
async function loadProviderSession() {
  const outfile = path.join(repoRoot, `.tmp-openai-compatible-${randomUUID()}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/provider-session.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
    outfile,
    logLevel: "silent"
  });
  return { module: await import(`file://${outfile}`), cleanup: () => rm(outfile, { force: true }) };
}

async function serveOpenAiCompatible(respond) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const event of respond(body, requests.length)) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

const TEXT_TURN = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "Local" } }] },
  { choices: [{ index: 0, delta: { content: " model" } }] },
  { choices: [{ index: 0, delta: { content: " ready" } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } } }
];

const TOOL_TURN = [
  { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "gmail_search", arguments: "{\"query\":" } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"newer_than:1d\"}" } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } }
];

const TOOL_ANSWER = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "Newest thread: " } }] },
  { choices: [{ index: 0, delta: { content: "Router spike" } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }
];

const GMAIL_TOOL_DEFINITION = { name: "gmail_search", description: "Search Gmail", inputSchema: { type: "object", properties: { query: { type: "string" } } }, providerIdentifier: "user-Gmail", toolName: "search_threads" };

test("router usage tracking covers the openai-compatible provider", async () => {
  const shared = await loadSource("source/shared/inference-router.ts");
  assert.deepEqual([...shared.SAND_INFERENCE_PROVIDERS], ["cursor", "claude-code", "codex", "openrouter", "openai-compatible"]);
  assert.equal(shared.isSandInferenceProvider("openai-compatible"), true);
  const usage = shared.emptySandInferenceRouterUsage();
  assert.deepEqual(Object.keys(usage.providers).sort(), [...shared.SAND_INFERENCE_PROVIDERS].sort());
  for (const provider of shared.SAND_INFERENCE_PROVIDERS) {
    assert.deepEqual(usage.providers[provider], { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null });
  }
});

test("endpoint and model come from configuration, with the API key optional", async () => {
  const { resolveOpenAiCompatibleSettings, DEFAULT_OPENAI_COMPATIBLE_BASE_URL } = await loadTransport();
  assert.deepEqual(resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_MODEL: "qwen3-coder:30b" }), { baseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL, model: "qwen3-coder:30b", apiKey: null });
  assert.deepEqual(
    resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_BASE_URL: " http://spark.local:8000/v1 ", SAND_OPENAI_COMPATIBLE_MODEL: " glm-4.6 ", SAND_OPENAI_COMPATIBLE_API_KEY: " local-key " }),
    { baseUrl: "http://spark.local:8000/v1", model: "glm-4.6", apiKey: "local-key" }
  );
  assert.deepEqual(
    resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_MODEL: "" }, { SAND_OPENAI_COMPATIBLE_BASE_URL: "http://r750.local:8000/v1", SAND_OPENAI_COMPATIBLE_MODEL: "llama-3.3-70b", SAND_OPENAI_COMPATIBLE_API_KEY: "" }),
    { baseUrl: "http://r750.local:8000/v1", model: "llama-3.3-70b", apiKey: null }
  );
  assert.equal(resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_MODEL: "env-wins" }, { SAND_OPENAI_COMPATIBLE_MODEL: "secret-loses" }).model, "env-wins");
  assert.throws(() => resolveOpenAiCompatibleSettings({}), /SAND_OPENAI_COMPATIBLE_MODEL/);
});

test("every advertised local server address normalizes onto one chat completions endpoint", async () => {
  const { openAiCompatibleChatEndpoint } = await loadTransport();
  assert.equal(openAiCompatibleChatEndpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(openAiCompatibleChatEndpoint("http://127.0.0.1:11434/"), "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(openAiCompatibleChatEndpoint("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(openAiCompatibleChatEndpoint("http://spark.local:8000/v1/"), "http://spark.local:8000/v1/chat/completions");
  assert.equal(openAiCompatibleChatEndpoint("https://r750.local/openai/v1/chat/completions"), "https://r750.local/openai/v1/chat/completions");
  assert.throws(() => openAiCompatibleChatEndpoint("r750.local:8000"), /must be an http:\/\/ or https:\/\/ URL/);
  assert.throws(() => openAiCompatibleChatEndpoint("not a url"), /not a valid URL/);
});

test("streams chat completion deltas from an unauthenticated local endpoint", async () => {
  const { streamOpenAiCompatibleChat } = await loadTransport();
  const server = await serveOpenAiCompatible(() => TEXT_TURN);
  try {
    const events = [];
    for await (const event of streamOpenAiCompatibleChat({
      fetch,
      baseUrl: server.baseUrl,
      model: "qwen3-coder:30b",
      instructions: "You are Grok Bot",
      input: [{ role: "user", content: "are you up" }]
    })) events.push(event);

    assert.deepEqual(events, [
      { type: "text-delta", delta: "Local" },
      { type: "text-delta", delta: " model" },
      { type: "text-delta", delta: " ready" },
      { type: "done", text: "Local model ready", usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 0 } }
    ]);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].url, "/v1/chat/completions");
    assert.equal(server.requests[0].headers.authorization, undefined);
    assert.equal(server.requests[0].body.stream, true);
    assert.equal(server.requests[0].body.model, "qwen3-coder:30b");
    assert.equal(server.requests[0].body.tools, undefined);
    assert.deepEqual(server.requests[0].body.messages, [{ role: "system", content: "You are Grok Bot" }, { role: "user", content: "are you up" }]);
  } finally { await server.close(); }
});

test("a configured key becomes a bearer token", async () => {
  const { streamOpenAiCompatibleChat } = await loadTransport();
  const server = await serveOpenAiCompatible(() => TEXT_TURN);
  try {
    for await (const _event of streamOpenAiCompatibleChat({
      fetch,
      baseUrl: `${server.baseUrl}/v1`,
      model: "glm-4.6",
      apiKey: "spark-key",
      instructions: "You are Grok Bot",
      input: [{ role: "user", content: "hi" }]
    })) {}
    assert.equal(server.requests[0].headers.authorization, "Bearer spark-key");
  } finally { await server.close(); }
});

test("fragmented tool calls are reassembled, executed and fed back into the turn", async () => {
  const { streamOpenAiCompatibleChat, openAiCompatibleTools } = await loadTransport();
  const server = await serveOpenAiCompatible((_body, count) => count === 1 ? TOOL_TURN : TOOL_ANSWER);
  let execution = null;
  try {
    const tools = openAiCompatibleTools([GMAIL_TOOL_DEFINITION]);
    assert.deepEqual(tools, [{ name: "gmail_search", description: "Search Gmail", parameters: GMAIL_TOOL_DEFINITION.inputSchema, source: GMAIL_TOOL_DEFINITION }]);
    const events = [];
    for await (const event of streamOpenAiCompatibleChat({
      fetch,
      baseUrl: server.baseUrl,
      model: "qwen3-coder:30b",
      instructions: "Use connected tools",
      input: [{ role: "user", content: "latest email" }],
      tools,
      executeTool: async (tool, args, toolCallId) => {
        execution = { source: tool.source, args, toolCallId };
        return { result: { case: "success", value: { subject: "Router spike" } } };
      }
    })) events.push(event);

    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests[0].body.tools, [{ type: "function", function: { name: "gmail_search", description: "Search Gmail", parameters: GMAIL_TOOL_DEFINITION.inputSchema } }]);
    assert.equal(server.requests[0].body.tool_choice, "auto");
    assert.deepEqual(execution, { source: GMAIL_TOOL_DEFINITION, args: { query: "newer_than:1d" }, toolCallId: "call_1" });
    assert.deepEqual(server.requests[1].body.messages.at(-2), { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "gmail_search", arguments: "{\"query\":\"newer_than:1d\"}" } }] });
    assert.deepEqual(server.requests[1].body.messages.at(-1), { role: "tool", tool_call_id: "call_1", name: "gmail_search", content: JSON.stringify({ result: { case: "success", value: { subject: "Router spike" } } }) });
    assert.deepEqual(events, [
      { type: "text-delta", delta: "Newest thread: " },
      { type: "text-delta", delta: "Router spike" },
      { type: "done", text: "Newest thread: Router spike", usage: { inputTokens: 28, outputTokens: 8, cacheReadTokens: 6, cacheWriteTokens: 0 } }
    ]);
  } finally { await server.close(); }
});

test("a tool call without an executor and a truncated stream both fail closed", async () => {
  const { streamOpenAiCompatibleChat } = await loadTransport();
  const server = await serveOpenAiCompatible(() => TOOL_TURN);
  try {
    await assert.rejects(async () => {
      for await (const _event of streamOpenAiCompatibleChat({
        fetch,
        baseUrl: server.baseUrl,
        model: "qwen3-coder:30b",
        instructions: "Use connected tools",
        input: [{ role: "user", content: "latest email" }],
        tools: [{ name: "gmail_search", parameters: { type: "object" }, source: GMAIL_TOOL_DEFINITION }]
      })) {}
    }, /did not provide an executor/);
  } finally { await server.close(); }

  const truncated = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: {\"choices\":[{\"delta\":{\"content\":\"Loc");
  });
  await new Promise(resolve => truncated.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(async () => {
      for await (const _event of streamOpenAiCompatibleChat({
        fetch,
        baseUrl: `http://127.0.0.1:${truncated.address().port}`,
        model: "qwen3-coder:30b",
        instructions: "You are Grok Bot",
        input: [{ role: "user", content: "hi" }]
      })) {}
    }, /incomplete SSE event/);
  } finally { await new Promise(resolve => truncated.close(resolve)); }
});

test("a routed openai-compatible turn streams, calls a Grok Bot tool and records usage", async (t) => {
  const server = await serveOpenAiCompatible((_body, count) => count === 1 ? TOOL_TURN : TOOL_ANSWER);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "sand-openai-compatible-"));
  const session = await loadProviderSession();
  const restore = { ...process.env };
  t.after(async () => {
    for (const key of ["SAND_DATA_ROOT", "SAND_OPENAI_COMPATIBLE_BASE_URL", "SAND_OPENAI_COMPATIBLE_MODEL", "SAND_OPENAI_COMPATIBLE_API_KEY"]) {
      if (restore[key] === undefined) delete process.env[key]; else process.env[key] = restore[key];
    }
    await session.cleanup();
    await server.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  process.env.SAND_DATA_ROOT = dataRoot;
  process.env.SAND_OPENAI_COMPATIBLE_BASE_URL = server.baseUrl;
  process.env.SAND_OPENAI_COMPATIBLE_MODEL = "qwen3-coder:30b";
  delete process.env.SAND_OPENAI_COMPATIBLE_API_KEY;

  const streamed = [];
  const executed = [];
  const text = await session.module.runRoutedProviderText("openai-compatible", [{ role: "user", content: "latest email" }], {
    tools: [GMAIL_TOOL_DEFINITION],
    executeTool: async (definition, args, toolCallId) => {
      executed.push({ providerIdentifier: definition.providerIdentifier, toolName: definition.toolName, args, toolCallId });
      return { result: { case: "success", value: { subject: "Router spike" } } };
    },
    onTextDelta: (delta, accumulated) => streamed.push([delta, accumulated])
  });

  assert.equal(text, "Newest thread: Router spike");
  assert.deepEqual(streamed, [["Newest thread: ", "Newest thread: "], ["Router spike", "Newest thread: Router spike"]]);
  assert.deepEqual(executed, [{ providerIdentifier: "user-Gmail", toolName: "search_threads", args: { query: "newer_than:1d" }, toolCallId: "call_1" }]);
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0].body.model, "qwen3-coder:30b");
  assert.match(server.requests[0].body.messages[0].content, /You are Grok Bot/);

  const stored = JSON.parse(await readFile(path.join(dataRoot, "settings.json"), "utf8"));
  const recorded = stored.inferenceRouterUsage.providers["openai-compatible"];
  assert.equal(recorded.requests, 1);
  assert.equal(recorded.inputTokens, 28);
  assert.equal(recorded.outputTokens, 8);
  assert.equal(recorded.cacheReadTokens, 6);
  assert.equal(typeof recorded.lastUsedAt, "string");

  const idle = session.module.createProviderPromptSession("openai-compatible");
  assert.equal(idle.getModelId(), "qwen3-coder:30b");
});

test("a key-guarded endpoint names the exact knob to set, for a missing and for a rejected key", async () => {
  const { streamOpenAiCompatibleChat } = await loadTransport();
  const denied = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "An LM Studio API token is required to access this endpoint. Provide it using the Authorization header using the 'Bearer' scheme", code: "invalid_api_key" }));
  });
  await new Promise(resolve => denied.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${denied.address().port}`;
  const turn = apiKey => async () => {
    for await (const _event of streamOpenAiCompatibleChat({
      fetch,
      baseUrl,
      model: "qwen3-coder-30b",
      instructions: "You are Grok Bot",
      input: [{ role: "user", content: "hi" }],
      ...(apiKey === undefined ? {} : { apiKey })
    })) {}
  };
  try {
    await assert.rejects(turn(undefined), /needs SAND_OPENAI_COMPATIBLE_API_KEY\. Add it in Settings → Router\./);
    await assert.rejects(turn(undefined), /invalid_api_key/);
    await assert.rejects(turn("wrong-key"), /rejected SAND_OPENAI_COMPATIBLE_API_KEY\. Check the key in Settings → Router\./);
  } finally { await new Promise(resolve => denied.close(resolve)); }
});

test("inference readiness stops requiring a Cursor token once a local provider is routed", async (t) => {
  const { inferenceExtension } = await loadSource("source/host/extensions/inference/extension.ts");
  const { TurnExecutionRegistry } = await loadSource("source/host/extensions/turn-execution/turn-execution-service.ts");
  const { SAND_INFERENCE_PROVIDERS } = await loadSource("source/shared/inference-router.ts");
  const mockResponse = process.env.SAND_AGENT_MOCK_RESPONSE;
  delete process.env.SAND_AGENT_MOCK_RESPONSE;
  t.after(() => { if (mockResponse === undefined) delete process.env.SAND_AGENT_MOCK_RESPONSE; else process.env.SAND_AGENT_MOCK_RESPONSE = mockResponse; });

  const readiness = (provider, accessToken) => inferenceExtension.start({
    deps: {
      auth: { peekAccessToken: () => accessToken, getAccessToken: async () => "", getMachineId: () => "" },
      experiments: {},
      settings: { getInferenceProvider: () => provider }
    },
    createPort: () => ({}),
    createWebSearch: () => ({}),
    createWebFetch: () => ({})
  }).isReady();

  // Cursor routing is unchanged: it still needs the cached account token.
  assert.equal(await readiness("cursor", null), false);
  assert.equal(await readiness("cursor", "cached-token"), true);

  // Every routed provider must run on a machine that has never signed into Cursor.
  for (const provider of SAND_INFERENCE_PROVIDERS.filter(candidate => candidate !== "cursor")) {
    assert.equal(await readiness(provider, null), true, `${provider} must be ready without a Cursor token`);
  }

  // isRunReady is the gate that stands the automation and trigger surface down; it must follow.
  const local = new TurnExecutionRegistry();
  local.bindExecutor({ isInferenceReady: () => readiness("openai-compatible", null), createRunner: () => ({}), createGroupMemberRunner: () => ({}) });
  assert.equal(await local.isRunReady(), true);

  const cursor = new TurnExecutionRegistry();
  cursor.bindExecutor({ isInferenceReady: () => readiness("cursor", null), createRunner: () => ({}), createGroupMemberRunner: () => ({}) });
  assert.equal(await cursor.isRunReady(), false);
});
