// The Responses transport (docs/SUBSCRIPTIONS-CONTRACT.md): the ChatGPT/Codex subscription backend
// speaks the OpenAI Responses API. Same events out, honest identification in, never a first-party
// client's name. The transport file has no imports, so it loads alone through esbuild.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function load(relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const transport = await load("source/host/extensions/inference/openai-compatible-chat.ts");

const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", {
  status: 200, headers: { "content-type": "text/event-stream" },
});
const collect = async (iterable) => { const out = []; for await (const event of iterable) out.push(event); return out; };

test("settings: transport, account id and originator appear only when configured", () => {
  const plain = transport.resolveOpenAiCompatibleSettings({}, { SAND_OPENAI_COMPATIBLE_BASE_URL: "http://x/v1", SAND_OPENAI_COMPATIBLE_MODEL: "m" });
  assert.equal("transport" in plain, false);
  const responses = transport.resolveOpenAiCompatibleSettings({}, {
    SAND_OPENAI_COMPATIBLE_BASE_URL: "https://chatgpt.com/backend-api/codex", SAND_OPENAI_COMPATIBLE_MODEL: "gpt-5-codex",
    SAND_OPENAI_COMPATIBLE_API_KEY: "tok", SAND_OPENAI_COMPATIBLE_TRANSPORT: "responses", SAND_OPENAI_COMPATIBLE_ACCOUNT_ID: "acct-1", SAND_OPENAI_COMPATIBLE_ORIGINATOR: "grok-bot",
  });
  assert.equal(responses.transport, "responses");
  assert.equal(responses.accountId, "acct-1");
  assert.equal(responses.originator, "grok-bot");
  assert.equal(transport.openAiResponsesEndpoint("https://chatgpt.com/backend-api/codex/"), "https://chatgpt.com/backend-api/codex/responses");
});

test("chat history becomes Responses items; the system prompt travels as instructions", () => {
  const items = transport.responsesInput([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "Shell", arguments: "{\"command\":\"ls\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "a.txt" },
    { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
  ]);
  assert.deepEqual(items[0], { role: "user", content: [{ type: "input_text", text: "hi" }] });
  assert.deepEqual(items[1], { role: "assistant", content: [{ type: "output_text", text: "ok" }] });
  assert.deepEqual(items[2], { type: "function_call", call_id: "c1", name: "Shell", arguments: "{\"command\":\"ls\"}" });
  assert.deepEqual(items[3], { type: "function_call_output", call_id: "c1", output: "a.txt" });
  assert.equal(items[4].content[1].type, "input_image");
  assert.equal(items.some((i) => i.role === "system"), false);
});

test("a responses turn: honest headers, store off, tool call and usage come back as the usual events", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return sse([
      { type: "response.output_text.delta", delta: "Checking. " },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"command\":" },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "\"ls -1 /workspace\"}" },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Shell", arguments: "{\"command\":\"ls -1 /workspace\"}" } },
      { type: "response.completed", response: { usage: { input_tokens: 1200, output_tokens: 30, input_tokens_details: { cached_tokens: 1000 } } } },
    ]);
  };
  const events = await collect(transport.streamOpenAiCompatibleChat({
    fetch: fetchImpl, baseUrl: "https://chatgpt.com/backend-api/codex", model: "gpt-5-codex", apiKey: "tok-123",
    transport: "responses", accountId: "acct-1", originator: "grok-bot",
    instructions: "You are the agent.", input: [{ role: "user", content: "list the workspace" }],
    tools: [{ name: "Shell", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } }, source: {} }],
  }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(seen[0].headers.originator, "grok-bot");
  assert.equal(seen[0].headers["chatgpt-account-id"], "acct-1");
  assert.equal(seen[0].headers.authorization, "Bearer tok-123");
  assert.equal(seen[0].headers["user-agent"], "grok-bot-router/1");
  assert.equal(/codex|claude-code|Codex Desktop/i.test(JSON.stringify(seen[0].headers)), false, "no first-party client name in the headers");
  assert.equal(seen[0].body.store, false);
  assert.equal(seen[0].body.stream, true);
  assert.equal(seen[0].body.instructions, "You are the agent.");
  assert.deepEqual(seen[0].body.tools[0], { type: "function", name: "Shell", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } }, strict: false });
  assert.deepEqual(events[0], { type: "text-delta", delta: "Checking. " });
  assert.deepEqual(events[1], { type: "tool-call", toolCallId: "call_1", toolName: "Shell", args: { command: "ls -1 /workspace" } });
  assert.equal(events[2].type, "done");
  assert.deepEqual(events[2].usage, { inputTokens: 1200, outputTokens: 30, cacheReadTokens: 1000, cacheWriteTokens: 0 });
});

test("a responses error event surfaces as a thrown failure, never a silent empty turn", async () => {
  const fetchImpl = async () => sse([{ type: "error", error: { message: "insufficient_quota" } }]);
  await assert.rejects(
    collect(transport.streamOpenAiCompatibleChat({ fetch: fetchImpl, baseUrl: "https://chatgpt.com/backend-api/codex", model: "m", apiKey: "t", transport: "responses", instructions: "x", input: [{ role: "user", content: "y" }] })),
    /insufficient_quota/,
  );
});

// --- the subscriptions module: store, refresh through the vendor's own endpoint, secret-free scan ---
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";


const dir = await mkdtemp(path.join(os.tmpdir(), "grokbot-subs-"));
process.env.GROK_BOT_SUBSCRIPTIONS_FILE = path.join(dir, "subscriptions.json");
const subs = await import("../ui/subscriptions.mjs");

test("a pasted key becomes a keyless endpoint row and a 0600 store entry", async () => {
  const row = await subs.adoptSubscription("zai", { apiKey: "zai-test-key-0123456789abcdef", model: "glm-4.7" }, {});
  assert.equal(row.id, "sub-zai");
  assert.equal(row.subscription, "zai");
  assert.equal("apiKey" in row, false);
  const mode = (await stat(process.env.GROK_BOT_SUBSCRIPTIONS_FILE)).mode & 0o777;
  assert.equal(mode, 0o600);
  const resolved = await subs.resolveSubscription("zai");
  assert.equal(resolved.apiKey, "zai-test-key-0123456789abcdef");
  assert.equal(resolved.transport, "chat");
  assert.equal(resolved.originator, "grok-bot");
});

test("MiniMax refresh goes to MiniMax's own token endpoint as grok-bot and updates only our store", async () => {
  const vendorFile = path.join(dir, "minimax-oauth_creds.json");
  await writeFile(vendorFile, JSON.stringify({ access_token: "old-access-token-000000", refresh_token: "old-refresh-token-0000", expiry_date: 1 }));
  const before = await readFile(vendorFile, "utf8");
  const store = await subs.readStore();
  store.minimax = { access: "old-access-token-000000", refresh: "old-refresh-token-0000", expires: Date.now() - 1, source: vendorFile };
  await subs.writeStore(store);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: "new-access-token-111111", refresh_token: "new-refresh-token-1111", expired_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const resolved = await subs.resolveSubscription("minimax");
    assert.equal(resolved.refreshed, true);
    assert.equal(resolved.apiKey, "new-access-token-111111");
    assert.equal(calls[0].url, "https://account.minimax.io/oauth2/token");
    assert.equal(calls[0].init.headers["user-agent"], "grok-bot/1");
    const body = new URLSearchParams(calls[0].init.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "old-refresh-token-0000");
    assert.equal(body.get("client_id"), "78257093-7e40-4613-99e0-527b14b39113");
    assert.equal((await subs.readStore()).minimax.refresh, "new-refresh-token-1111");
    assert.equal(await readFile(vendorFile, "utf8"), before, "the vendor's file is never written");
  } finally { globalThis.fetch = realFetch; }
});

test("Codex refresh goes to OpenAI's token endpoint with the Codex client id; the vendor file is untouched", async () => {
  const vendorFile = path.join(dir, "codex-auth.json");
  await writeFile(vendorFile, JSON.stringify({ tokens: { access_token: "x", refresh_token: "y" } }));
  const before = await readFile(vendorFile, "utf8");
  const store = await subs.readStore();
  store.codex = { access: "old-codex-access-000000", refresh: "old-codex-refresh-0000", accountId: "acct-1", email: "a@b", expires: Date.now() - 1, source: vendorFile };
  await subs.writeStore(store);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: "new-codex-access-111111", refresh_token: "new-codex-refresh-1111", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const resolved = await subs.resolveSubscription("codex");
    assert.equal(resolved.transport, "responses");
    assert.equal(resolved.accountId, "acct-1");
    assert.equal(calls[0].url, "https://auth.openai.com/oauth/token");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(await readFile(vendorFile, "utf8"), before);
  } finally { globalThis.fetch = realFetch; }
});

test("the scan never carries a secret and Claude comes from its CLI", async () => {
  const rows = await subs.scanSubscriptions({ ...process.env, ZAI_API_KEY: "zai-env-key-should-not-appear-0000" });
  const text = JSON.stringify(rows);
  assert.equal(text.includes("zai-env-key-should-not-appear-0000"), false);
  assert.equal(text.includes("new-access-token-111111"), false);
  assert.equal(text.includes("new-codex-access-111111"), false);
  assert.equal(rows.find((r) => r.id === "claude").source, "claude auth status --json");
  assert.match(rows.find((r) => r.id === "gemini").source, /existence only/);
  assert.equal(rows.find((r) => r.id === "zai").usable, true);
});
