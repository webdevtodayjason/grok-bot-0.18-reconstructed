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
  const probes = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      // The transport now asks GET /models for the model's context window before the first
      // turn; that request has no body and is not a chat completion.
      if (request.method === "GET") {
        // Recorded apart from the chat turns: `respond` numbers turns by requests.length, and the
        // probe would otherwise shift every turn by one.
        probes.push({ url: request.url, headers: request.headers });
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ data: [] }));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const event of respond(body, requests.length)) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { requests, probes, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
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
  assert.deepEqual(resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_MODEL: "qwen3-coder:30b" }), { baseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL, model: "qwen3-coder:30b", apiKey: null, contextWindow: null });
  assert.deepEqual(
    resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_BASE_URL: " http://spark.local:8000/v1 ", SAND_OPENAI_COMPATIBLE_MODEL: " glm-4.6 ", SAND_OPENAI_COMPATIBLE_API_KEY: " local-key " }),
    { baseUrl: "http://spark.local:8000/v1", model: "glm-4.6", apiKey: "local-key", contextWindow: null }
  );
  assert.deepEqual(
    resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_MODEL: "" }, { SAND_OPENAI_COMPATIBLE_BASE_URL: "http://r750.local:8000/v1", SAND_OPENAI_COMPATIBLE_MODEL: "llama-3.3-70b", SAND_OPENAI_COMPATIBLE_API_KEY: "" }),
    { baseUrl: "http://r750.local:8000/v1", model: "llama-3.3-70b", apiKey: null, contextWindow: null }
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

test("a tool call without an executor is surfaced, and a truncated stream fails closed", async () => {
  const { streamOpenAiCompatibleChat } = await loadTransport();
  // No inline executor means the caller owns the tool loop. On the agent path that
  // caller is the runner, which is the only thing that can run SendMessage. Throwing
  // here used to strand the turn; the calls must come out instead.
  const server = await serveOpenAiCompatible(() => TOOL_TURN);
  try {
    const events = [];
    for await (const event of streamOpenAiCompatibleChat({
      fetch,
      baseUrl: server.baseUrl,
      model: "qwen3-coder:30b",
      instructions: "Use connected tools",
      input: [{ role: "user", content: "latest email" }],
      tools: [{ name: "gmail_search", parameters: { type: "object" }, source: GMAIL_TOOL_DEFINITION }]
    })) events.push(event);
    const calls = events.filter(event => event.type === "tool-call");
    assert.equal(calls.length, 1, "the tool call should reach the caller");
    assert.equal(calls[0].toolName, "gmail_search");
    assert.ok(typeof calls[0].toolCallId === "string" && calls[0].toolCallId.length > 0);
    assert.deepEqual(calls[0].args, { query: "newer_than:1d" }, "args reassembled across delta chunks");
    assert.equal(events.at(-1).type, "done", "the step should still finish");
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


// ---- PROXY-1: the name a customer reads, and the words a refusal gets ---------------------------
//
// Two things a customer sees change when a box answers through the plan proxy, and both of them are
// decided by the HOST rather than by the model.
//
//   The persona note. It is the one thing standing between a model and inventing its own vendor,
//   and it printed the base URL's HOST. Pointed at the proxy that host is `titanbot-proxy`, a
//   container name on our own bridge: our plumbing, told to a customer, in the sentence they are
//   most likely to ask for.
//
//   The refusal. A provider body forwarded through the proxy names an alias, a dollar figure, a
//   vendor and sometimes a container. None of that is a customer's business or true in their
//   words, so four sentences replace it -- and only when servedBy is set, which is the marker the
//   relay writes with a plan endpoint and never with a customer's own key.

const PLAN_ENV = {
  SAND_OPENAI_COMPATIBLE_MODEL: "plan-zai",
  SAND_OPENAI_COMPATIBLE_API_KEY: "sk-a-virtual-key",
  SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: "Z.AI GLM (included with your plan)",
  SAND_OPENAI_COMPATIBLE_SERVED_BY: "Z.AI",
  // The name the customer hears for the model. Without it the note read `plan-zai` back to them,
  // which is a routing alias only the operator's proxy uses.
  SAND_OPENAI_COMPATIBLE_MODEL_LABEL: "GLM-4.6",
};

// Swaps the whole SAND_OPENAI_COMPATIBLE_ family for the turn and puts it back afterwards, so a
// case that sets SERVED_BY cannot leak it into the case that measures its absence.
function withEnv(t, values) {
  const names = ["SAND_DATA_ROOT", "SAND_OPENAI_COMPATIBLE_BASE_URL", "SAND_OPENAI_COMPATIBLE_MODEL",
    "SAND_OPENAI_COMPATIBLE_API_KEY", "SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME",
    "SAND_OPENAI_COMPATIBLE_SERVED_BY", "SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW",
    "SAND_OPENAI_COMPATIBLE_MODEL_LABEL"];
  const restore = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (restore[name] === undefined) delete process.env[name]; else process.env[name] = restore[name]; } });
  for (const name of names) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

// One failed turn, taken through the executor the runner actually uses rather than through
// runRoutedProviderText. Not a preference: a failed turn rejects five promises at once (usage,
// extended usage, metadata, the response and the stream), runRoutedProviderText awaits two of
// them, and the other three land as unhandled rejections that fail the whole file. The runner
// holds all five. So does this.
async function failedTurn(session) {
  const executor = session.module.createProviderPromptSession("openai-compatible")
    .getExecutor([{ role: "user", content: "hello" }]);
  const result = executor.stream(null, "an-invocation-id");
  for (const settled of [result.response, result.usage, result.extendedUsage, result.providerMetadata]) {
    settled.catch(() => {});
  }
  try { for await (const _event of result.fullStream) { /* drained */ } } catch (error) { return error; }
  return null;
}

// A server that refuses every chat turn with one status and one body, and still answers /models so
// the context window probe does not become the failure under test.
async function serveRefusal(status, body) {
  const server = createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ data: [] }));
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("SERVED_BY is resolved by the same env-then-secrets rule and is absent unless it is set", async () => {
  const { resolveOpenAiCompatibleSettings, DEFAULT_OPENAI_COMPATIBLE_BASE_URL } = await loadTransport();
  // Byte-equal for an endpoint that does not set one: the key is not present as null, it is not
  // present at all, which is what keeps every existing endpoint's settings exactly as they were.
  assert.deepEqual(
    resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_MODEL: "qwen3-coder:30b" }),
    { baseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL, model: "qwen3-coder:30b", apiKey: null, contextWindow: null },
  );
  assert.equal(resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_MODEL: "m", SAND_OPENAI_COMPATIBLE_SERVED_BY: " Z.AI " }).servedBy, "Z.AI");
  // The secrets file is where the relay actually writes it, and env still wins over it.
  assert.equal(resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_MODEL: "m" }, { SAND_OPENAI_COMPATIBLE_SERVED_BY: "MiniMax" }).servedBy, "MiniMax");
  assert.equal(resolveOpenAiCompatibleSettings({ SAND_OPENAI_COMPATIBLE_MODEL: "m", SAND_OPENAI_COMPATIBLE_SERVED_BY: "env" }, { SAND_OPENAI_COMPATIBLE_SERVED_BY: "secret" }).servedBy, "env");
});

test("the persona note names the plan, never the container the proxy runs in", async (t) => {
  const server = await serveOpenAiCompatible(() => TEXT_TURN);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "sand-plan-persona-"));
  const session = await loadProviderSession();
  t.after(async () => { await session.cleanup(); await server.close(); await rm(dataRoot, { recursive: true, force: true }); });
  withEnv(t, { ...PLAN_ENV, SAND_DATA_ROOT: dataRoot, SAND_OPENAI_COMPATIBLE_BASE_URL: server.baseUrl });

  await session.module.runRoutedProviderText("openai-compatible", [{ role: "user", content: "what do you run on" }]);
  const note = server.requests[0].body.messages[0].content;
  assert.match(note, /answering through "Z\.AI GLM \(included with your plan\)", model 'GLM-4\.6' at Z\.AI\./);
  // The routing alias is the operator's plumbing, and this note is the single place a customer is
  // most likely to ask. The four PLAN_REFUSAL sentences keep aliases out; so does this one now.
  assert.equal(note.includes("plan-zai"), false, "the persona note must not name the routing alias");
  // The base URL's host is a loopback address here and `titanbot-proxy` on the R750. Neither is a
  // thing to tell a customer, and the assertion is the address rather than the name so it measures
  // the substitution rather than a string that happens not to appear.
  assert.equal(note.includes("127.0.0.1"), false, "the persona note must not name where the proxy lives");
  assert.match(note, /never claim to be Grok, xAI, or any other model or vendor/, "the anti-hallucination fact is intact");
});

test("with no SERVED_BY the persona note is exactly the sentence it always was", async (t) => {
  const server = await serveOpenAiCompatible(() => TEXT_TURN);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "sand-own-persona-"));
  const session = await loadProviderSession();
  t.after(async () => { await session.cleanup(); await server.close(); await rm(dataRoot, { recursive: true, force: true }); });
  withEnv(t, {
    SAND_DATA_ROOT: dataRoot, SAND_OPENAI_COMPATIBLE_BASE_URL: server.baseUrl,
    SAND_OPENAI_COMPATIBLE_MODEL: "glm-4.6", SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME: "my own provider",
  });

  await session.module.runRoutedProviderText("openai-compatible", [{ role: "user", content: "hi" }]);
  const note = server.requests[0].body.messages[0].content;
  const host = new URL(server.baseUrl).host;
  assert.match(note, new RegExp(`answering through "my own provider", model 'glm-4\\.6' at ${host.replace(".", "\\.")}\\.`));
});

test("a plan refusal reaches the customer as one plain sentence, with no alias, no dollars and no vendor", async (t) => {
  const session = await loadProviderSession();
  t.after(() => session.cleanup());
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "sand-plan-refusal-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  // The three shapes, and the sentence each becomes. The bodies are the shape a proxy actually
  // forwards: an alias, a dollar figure and a vendor name in every one of them.
  const cases = [
    { status: 400, body: { error: { message: "Budget has been exceeded! Current cost: 12.4, Max budget: 10.0", type: "budget_exceeded" } },
      sentence: "You have used everything your plan includes this month. Add your own key under Settings and I will keep going, or ask for more." },
    { status: 429, body: { error: { message: "Max parallel request limit reached for key titanbot-demo" } },
      sentence: "That is more than the plan allows right now. Give me a moment and ask again." },
    { status: 503, body: { error: { message: "litellm.APIConnectionError: Z.AI is unreachable" } },
      sentence: "The model I answer through is not responding. Nothing you sent is lost. Try again in a minute, or pick a different model in Settings." },
  ];

  for (const item of cases) {
    const server = await serveRefusal(item.status, item.body);
    try {
      withEnv(t, { ...PLAN_ENV, SAND_DATA_ROOT: dataRoot, SAND_OPENAI_COMPATIBLE_BASE_URL: server.baseUrl });
      const failure = await failedTurn(session);
      assert.notEqual(failure, null, `HTTP ${item.status} should still fail the turn`);
      assert.equal(failure.message, item.sentence, `HTTP ${item.status}`);
      // The wording rule, checked against the message rather than trusted: no alias, no dollars,
      // no vendor, no tool name, and never "may be temporary".
      for (const forbidden of ["titanbot", "budget", "$", "12.4", "Z.AI", "litellm", "may be temporary", String(item.status)]) {
        assert.equal(failure.message.includes(forbidden), false, `"${forbidden}" reached the customer on HTTP ${item.status}`);
      }
      // The provider's own body is still readable by the host log, as the cause.
      assert.equal(typeof failure.cause?.message, "string");
      assert.match(failure.cause.message, new RegExp(String(item.status)));
    } finally { await server.close(); }
  }
});

test("a box on its own key keeps its own wording, and an error the plan does not recognise keeps its", async (t) => {
  const session = await loadProviderSession();
  t.after(() => session.cleanup());
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "sand-own-refusal-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  // The fourth case, unchanged: a customer's own key rejected by their own provider still names the
  // knob to fix, which is the only actionable thing to say to somebody who owns the key.
  const denied = await serveRefusal(401, { error: { message: "invalid api key" } });
  try {
    withEnv(t, {
      SAND_DATA_ROOT: dataRoot, SAND_OPENAI_COMPATIBLE_BASE_URL: denied.baseUrl,
      SAND_OPENAI_COMPATIBLE_MODEL: "glm-4.6", SAND_OPENAI_COMPATIBLE_API_KEY: "a key the customer owns",
    });
    const failure = await failedTurn(session);
    assert.match(failure.message, /rejected SAND_OPENAI_COMPATIBLE_API_KEY/);
  } finally { await denied.close(); }

  // And on the plan, a shape the translator does not recognise passes through as it always did. A
  // wrong plain sentence hides a real fault better than a raw one ever could.
  const malformed = await serveRefusal(200, "data: not json\n\n");
  try {
    withEnv(t, { ...PLAN_ENV, SAND_DATA_ROOT: dataRoot, SAND_OPENAI_COMPATIBLE_BASE_URL: malformed.baseUrl });
    const failure = await failedTurn(session);
    assert.match(failure.message, /malformed SSE JSON|did not contain any completion chunks/);
  } finally { await malformed.close(); }
});

test("a token overflow on the plan is still a token overflow, so compaction still fires", async (t) => {
  // The compact-and-retry rescue keys on InputTokenLimitError. Translating an overflow into "try
  // again in a minute" would take compaction off the turn and leave every following turn failing
  // identically, which is the exact bug the classifier was written to end.
  const session = await loadProviderSession();
  t.after(() => session.cleanup());
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "sand-plan-overflow-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const server = await serveRefusal(400, { error: { message: "This model's maximum prompt length is 200000 but the request contains 244118 tokens." } });
  try {
    withEnv(t, { ...PLAN_ENV, SAND_DATA_ROOT: dataRoot, SAND_OPENAI_COMPATIBLE_BASE_URL: server.baseUrl });
    const failure = await failedTurn(session);
    assert.equal(failure.name, "InputTokenLimitError", `an overflow became ${failure.name}: ${failure.message}`);
  } finally { await server.close(); }
});
