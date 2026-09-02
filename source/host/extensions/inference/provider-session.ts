import { zodToJsonSchema } from "zod-to-json-schema";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { query as queryClaude, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai";

import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.js";
import { classifyTokenLimitErrorFromMessage } from "../../../packages/chat-inference/token-limit-error-classification.js";
import type { SandInferenceProvider } from "../../../shared/inference-router.js";
import { resolveClaudeCodeCliPath } from "../../../shared/node/inference-router-local.js";
import { getSandRootDir } from "../../host-paths.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getBoxSecretsStorePath } from "../secrets/secrets-service.js";
import { streamCodexDirectResponses, type CodexDirectTool } from "./codex-direct-responses.js";
import { DEFAULT_OPENAI_COMPATIBLE_CONTEXT_WINDOW, OPENAI_COMPATIBLE_CONTEXT_WINDOW_ENV, fetchOpenAiCompatibleContextWindow, openAiCompatibleTools, resolveOpenAiCompatibleSettings, streamOpenAiCompatibleChat, type OpenAiCompatibleSettings } from "./openai-compatible-chat.js";
import type { LabelMessage, PromptExecutor } from "./sand-labeling.js";

type Loose = Record<string, any>;
interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
type RoutedProvider = Exclude<SandInferenceProvider, "cursor">;
type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type RoutedToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;

// The routed providers advertise the agent's tools to the model and then have nowhere
// to run what it picks: every provider took `undefined` in the executor position, so the
// first tool call ended the turn with "did not provide an executor". The coordinator
// supplies one by dispatching executeRoutedMcpTool; the host, which serves that very
// command, supplied nothing. createProviderPromptSession is called from five places, so
// the host registers the executor once here rather than threading a parameter through
// all of them. Unset outside the box (the coordinator passes its own explicitly).
let hostRoutedToolExecutor: RoutedToolExecutor | undefined;
export function setHostRoutedToolExecutor(executor: RoutedToolExecutor | undefined): void {
  hostRoutedToolExecutor = executor;
}
export function getHostRoutedToolExecutor(): RoutedToolExecutor | undefined {
  return hostRoutedToolExecutor;
}

/**
 * On the agent path the model is not addressing the user directly: plain assistant text is a
 * private scratchpad and SendMessage is the only thing the user ever sees. Telling it to
 * "respond directly in natural language" -- which the router prompt does, correctly, for the
 * coordinator's one-shot text calls -- guarantees a silent turn.
 */
const GROK_AGENT_SYSTEM_PROMPT = [
  "You are Grok Bot, a warm, concise desktop assistant.",
  "The user cannot see your plain replies. Your assistant text is a private scratchpad.",
  "SendMessage is your only voice: a reply counts only once it is inside a SendMessage call.",
  "To answer, call SendMessage with type set to \"text\" and content set to what you want to say.",
  "The tools supplied with this request are Grok Bot's already-connected plugins and accounts. Use them when relevant instead of claiming a plugin is unavailable.",
].join("\n");

const GROK_ROUTER_SYSTEM_PROMPT = [
  "You are Grok Bot, a warm, concise desktop assistant.",
  "You are running inside Grok Bot, not inside Codex CLI or Claude Code.",
  "The tools supplied with this request are Grok Bot's already-connected plugins and accounts. Use them whenever they are relevant instead of claiming that a plugin is unavailable or asking the user to reconnect it.",
  "Never ask for an API key for an already-connected plugin. Respond directly to the user in natural language after completing any necessary tool calls.",
].join("\n");

/**
 * The routed system prompt tells the model to "respond directly to the user in natural
 * language", which is right for the coordinator's one-shot text calls and exactly wrong on
 * the agent path: there, plain assistant text is a private scratchpad and SendMessage is the
 * agent's only voice. Worse, injecting it replaced the turn's own system prompt -- the one
 * that explains that -- and every system message was being remapped to `user`, so the model
 * was told to do the one thing that produces silence.
 *
 * Keep system messages as system, and only fall back to the router prompt when the
 * conversation carries no instructions of its own.
 */
/**
 * A turn's messages carry content as an array of parts, so JSON.stringify-ing them sent the
 * model its own transcript as Vercel-shaped JSON: every user turn arrived as
 * `[{"type":"text","text":"..."}]` and every assistant turn as the literal string `[]`.
 * Shown that pattern often enough, the model reproduces it -- answering with a JSON array of
 * tool-call objects as plain text instead of calling a tool. Verified on Nemotron: the same
 * request with tools and tool_choice returns a structured tool_calls array when the history is
 * plain text, and prose imitating the transcript when it is not.
 *
 * Flatten the parts to text, carry real tool calls in the field built for them, and drop turns
 * that flatten to nothing rather than teaching the model that assistants reply with "[]".
 */
function asRecord(value: unknown): Loose | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Loose : null;
}
function stringifyArgs(value: unknown): string {
  try { return JSON.stringify(value) ?? "{}"; } catch { return "{}"; }
}

function flattenParts(content: unknown): { text: string; toolCalls: Loose[]; results: Loose[] } {
  if (typeof content === "string") return { text: content, toolCalls: [], results: [] };
  if (!Array.isArray(content)) {
    const single = asRecord(content);
    return { text: typeof single?.text === "string" ? single.text : "", toolCalls: [], results: [] };
  }
  const text: string[] = [];
  const toolCalls: Loose[] = [];
  const results: Loose[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (part == null) continue;
    if (typeof part.text === "string" && part.text.length > 0) { text.push(part.text); continue; }
    if (part.type === "tool-call" && typeof part.toolName === "string") {
      toolCalls.push({
        id: typeof part.toolCallId === "string" ? part.toolCallId : `call_${toolCalls.length}`,
        type: "function",
        function: { name: part.toolName, arguments: stringifyArgs(part.args ?? {}) },
      });
      continue;
    }
    // A tool result is its own message with the id of the call it answers. Folded into the
    // previous user turn it reads as the user narrating tool output back at the model, which
    // is why the model kept saying the conversation had been interrupted.
    if (part.type === "tool-result") {
      results.push({
        role: "tool",
        tool_call_id: typeof part.toolCallId === "string" ? part.toolCallId : "",
        content: typeof part.result === "string" ? part.result : stringifyArgs(part.result ?? ""),
      });
    }
  }
  return { text: text.join("\n"), toolCalls, results };
}

function conversationInput(messages: readonly ProviderMessage[], hasSendMessage = false): { input: Loose[]; instructions: string } {
  const mapped = messages.map(message => {
    const role = message.role === "assistant" ? "assistant"
      : message.role === "system" ? "system"
      : message.role === "tool" ? "tool" : "user";
    const { text, toolCalls, results } = flattenParts(message.content);
    return { role, content: text, toolCalls, results };
  });
  const own = mapped.filter(message => message.role === "system" && message.content.trim().length > 0).map(message => message.content);

  const input: Loose[] = [];
  for (const message of mapped) {
    if (message.role === "system") continue;
    if (message.role === "tool") { input.push(...message.results); continue; }
    if (message.toolCalls.length > 0) {
      input.push({ role: message.role, content: message.content.length > 0 ? message.content : null, tool_calls: message.toolCalls });
      continue;
    }
    if (message.content.trim().length > 0) input.push({ role: message.role, content: message.content });
  }
  // A tool result whose call never made it into the request is rejected by the server, so
  // only keep results that answer a call actually present above them.
  const offered = new Set(input.flatMap(m => Array.isArray(m.tool_calls) ? m.tool_calls.map((c: Loose) => c.id) : []));
  const cleaned = input.filter(m => m.role !== "tool" || offered.has(m.tool_call_id));
  return {
    input: cleaned,
    instructions: own.length > 0 ? own.join("\n\n") : hasSendMessage ? GROK_AGENT_SYSTEM_PROMPT : GROK_ROUTER_SYSTEM_PROMPT,
  };
}

function recordRoutedUsage(provider: RoutedProvider, usage: UsageRecord): void {
  new SandSettingsStore(join(getSandRootDir(), "settings.json")).recordInferenceUsage(provider, usage);
}

function persistedSecrets(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(getBoxSecretsStorePath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
    const secrets = (parsed as { secrets?: unknown }).secrets;
    if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
    return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

function openRouterCredential(): string {
  const value = process.env.OPENROUTER_API_KEY?.trim() || persistedSecrets().OPENROUTER_API_KEY?.trim();
  if (value == null || value.length === 0) throw new Error("OpenRouter needs OPENROUTER_API_KEY. Add it in Settings → Router.");
  return value;
}

function providerPrompt(messages: readonly ProviderMessage[]): string {
  const rendered = messages.map(message => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return `${message.role.toUpperCase()}: ${content}`;
  }).join("\n\n");
  return `${GROK_ROUTER_SYSTEM_PROMPT}\n\nContinue this Grok Bot conversation.\n\n${rendered}`;
}

function deferred<T>() { return Promise.withResolvers<T>(); }

function response(text: string, id: string, modelId: string) {
  return { id, modelId, timestamp: new Date(), headers: {}, messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
}

type CodexCredentials = { accessToken: string; refreshToken: string; idToken: string; accountId: string; path: string; document: Loose };

function codexCredentials(): CodexCredentials {
  const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Codex login credentials must be a private direct regular file.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Loose;
  const accessToken = parsed?.tokens?.access_token;
  const refreshToken = parsed?.tokens?.refresh_token;
  const idToken = parsed?.tokens?.id_token;
  const accountId = parsed?.tokens?.account_id;
  if (parsed?.auth_mode !== "chatgpt" || typeof accessToken !== "string" || accessToken.length === 0 || typeof refreshToken !== "string" || refreshToken.length === 0 || typeof idToken !== "string" || idToken.length === 0 || typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Codex is not signed in with ChatGPT. Run `codex login`, then reopen Grok Bot.");
  }
  return { accessToken, refreshToken, idToken, accountId, path, document: parsed };
}

function jwtAudience(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Loose;
    const audience = payload.aud;
    return typeof audience === "string" ? audience : Array.isArray(audience) ? audience.find((value): value is string => typeof value === "string") ?? null : null;
  } catch { return null; }
}

async function refreshCodexCredentials(current: CodexCredentials): Promise<CodexCredentials> {
  const clientId = jwtAudience(current.idToken);
  if (clientId == null) throw new Error("Codex login expired and its refresh identity is invalid. Run `codex login` again.");
  const refresh = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: clientId }),
  });
  if (!refresh.ok) throw new Error("Codex login expired and could not be refreshed. Run `codex login` again.");
  const payload = await refresh.json() as Loose;
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) throw new Error("Codex returned an invalid refreshed login. Run `codex login` again.");
  const document = {
    ...current.document,
    tokens: {
      ...current.document.tokens,
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : current.refreshToken,
      id_token: typeof payload.id_token === "string" && payload.id_token.length > 0 ? payload.id_token : current.idToken,
    },
    last_refresh: new Date().toISOString(),
  };
  const temporary = `${current.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, current.path);
  return codexCredentials();
}

function codexAuthenticatedFetch(initial: CodexCredentials): typeof fetch {
  let credentials = initial;
  return async (input, init) => {
    const perform = () => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credentials.accessToken}`);
      headers.set("ChatGPT-Account-Id", credentials.accountId);
      return fetch(input, { ...init, headers });
    };
    let result = await perform();
    if (result.status !== 401) return result;
    credentials = await refreshCodexCredentials(credentials);
    result = await perform();
    return result;
  };
}

function configuredCodexModel(): string {
  const selected = process.env.SAND_CODEX_MODEL?.trim();
  if (selected) return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim() || "gpt-5.4";
  } catch { return "gpt-5.4"; }
}

function configuredCodexReasoningEffort(): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const selected = process.env.SAND_CODEX_REASONING_EFFORT?.trim();
  if (selected === "minimal" || selected === "low" || selected === "medium" || selected === "high" || selected === "xhigh") return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    const value = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim();
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
  } catch { return undefined; }
}

function codexTools(definitions: readonly Loose[] | undefined): CodexDirectTool[] | undefined {
  if (definitions == null) return undefined;
  const tools = definitions.flatMap((source): CodexDirectTool[] => {
    const parameters = source.inputSchema ?? source.parameters;
    return typeof source.name === "string" && source.name.length > 0 && parameters != null ? [{
      name: source.name,
      ...(typeof source.description === "string" ? { description: source.description } : {}),
      parameters,
      source,
    }] : [];
  });
  return tools.length === 0 ? undefined : tools;
}

function codexExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const credentials = codexCredentials();
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredCodexModel();
  const tools = codexTools(definitions);
  const fullStream = (async function* () {
    let text = "";
    try {
      for await (const event of streamCodexDirectResponses({
        fetch: codexAuthenticatedFetch(credentials),
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model,
        ...(configuredCodexReasoningEffort() == null ? {} : { reasoningEffort: configuredCodexReasoningEffort()! }),
        instructions: conversationInput(messages, (tools ?? []).some((tool: Loose) => tool.name === "SendMessage")).instructions,
        input: conversationInput(messages).input,
        ...(tools == null ? {} : { tools }),
        ...(executeTool == null ? {} : { executeTool: async (selected, args, toolCallId) => await executeTool(selected.source, args, toolCallId) }),
        maxSteps: tools == null ? 1 : 8,
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        const basic = { promptTokens: event.usage.inputTokens, completionTokens: event.usage.outputTokens, totalTokens: event.usage.inputTokens + event.usage.outputTokens };
        const extended = { ...event.usage, maxTokens: 0 };
        onUsage?.(event.usage);
        usage.resolve(basic);
        extendedUsage.resolve(extended);
        metadata.resolve({ openai: { responseId: event.responseId, direct: true } });
        resultResponse.resolve(response(text, invocationId, model));
      }
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error; }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function claudeExecutor(messages: readonly ProviderMessage[], invocationId: string, onUsage?: (usage: UsageRecord) => void, mcpServerUrl?: string) {
  const executable = resolveClaudeCodeCliPath();
  if (executable == null) throw new Error("Claude Code is not installed. Install and sign in to Claude Code, then reopen Grok Bot.");
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const fullStream = (async function* () {
    try {
      let final: SDKResultMessage | undefined;
      const selectedModel = process.env.SAND_CLAUDE_MODEL?.trim();
      for await (const message of queryClaude({ prompt: providerPrompt(messages), options: { pathToClaudeCodeExecutable: executable, cwd: getSandRootDir(), tools: mcpServerUrl == null ? [] : ["mcp__grok_bot_plugins__*"], ...(mcpServerUrl == null ? {} : { mcpServers: { grok_bot_plugins: { type: "http" as const, url: mcpServerUrl } }, strictMcpConfig: true }), permissionMode: "default", maxTurns: mcpServerUrl == null ? 1 : 8, persistSession: false, ...(selectedModel == null || selectedModel.length === 0 ? {} : { model: selectedModel }) } })) if (message.type === "result") final = message;
      if (final == null) throw new Error("Claude Code ended without a result.");
      if (final.subtype !== "success") throw new Error(final.errors.join("\n") || `Claude Code failed (${final.subtype}).`);
      const text = final.result;
      if (text.length > 0) yield { type: "text-delta" as const, textDelta: text };
      const input = final.usage.input_tokens, output = final.usage.output_tokens, cacheRead = final.usage.cache_read_input_tokens ?? 0, cacheWrite = final.usage.cache_creation_input_tokens ?? 0;
      onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
      usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
      extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: 0 });
      metadata.resolve({ anthropic: { sessionId: final.session_id, totalCostUsd: final.total_cost_usd } });
      resultResponse.resolve(response(text, invocationId, "claude-code"));
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error; }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function toToolSet(definitions: readonly Loose[] | undefined, executeTool?: RoutedToolExecutor): ToolSet | undefined {
  if (definitions == null || definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue;
    const parameters = definition.inputSchema ?? definition.parameters;
    if (parameters == null) continue;
    const routedTool: any = {
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      parameters: jsonSchema(parameters),
    };
    if (executeTool != null) routedTool.execute = async (args: unknown, options: { toolCallId: string }) => await executeTool(definition, args, options.toolCallId);
    tools[definition.name] = tool(routedTool);
  }
  return Object.keys(tools).length === 0 ? undefined : tools;
}

function openRouterExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const id = process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  const model: LanguageModelV1 = createOpenAI({ apiKey: openRouterCredential(), baseURL: "https://openrouter.ai/api/v1", compatibility: "compatible", name: "openrouter", headers: { "HTTP-Referer": "https://github.com/grok-bot-reconstructed", "X-Title": "Grok Bot Reconstructed" } }).chat(id as any);
  const tools = toToolSet(definitions, executeTool);
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages: messages as CoreMessage[], ...(tools === undefined ? {} : { tools }), toolCallStreaming: true, maxSteps: tools === undefined ? 1 : 8 });
  const extendedUsage = result.usage.then(value => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}

function openAiCompatibleSettings(): OpenAiCompatibleSettings {
  return resolveOpenAiCompatibleSettings(process.env, persistedSecrets());
}

/**
 * Every local executor reported a context window of zero, and the compaction trigger's first
 * line is `if (maxTokens <= 0) return` -- so a conversation on this route grew until the provider
 * rejected the prompt, then failed identically every turn after. The window is a real number:
 * the operator's setting wins, otherwise the endpoint is asked once. Only an advertised figure is
 * cached, because pinning the default for the host's lifetime after one transient `/models`
 * failure would fire compaction at 22k on a 500k model every turn.
 */
const DEFAULT_CONTEXT_WINDOW_RECHECK_MS = 10 * 60 * 1000;
const resolvedContextWindows = new Map<string, { readonly value: number; readonly expiresAt: number }>();
const announcedContextWindows = new Map<string, number>();
async function resolveOpenAiCompatibleContextWindow(settings: OpenAiCompatibleSettings): Promise<number> {
  if (settings.contextWindow != null) return settings.contextWindow;
  const key = `${settings.baseUrl}\n${settings.model}`;
  const cached = resolvedContextWindows.get(key);
  if (cached !== undefined && Date.now() < cached.expiresAt) return cached.value;
  const advertised = await fetchOpenAiCompatibleContextWindow(fetch, settings);
  const resolved = advertised ?? DEFAULT_OPENAI_COMPATIBLE_CONTEXT_WINDOW;
  // An advertised figure is good for the host's lifetime; a default is rechecked after a while,
  // so an endpoint that was merely down for a moment is not pinned to 32k until restart, and one
  // that never advertises is not asked on every single turn either.
  resolvedContextWindows.set(key, { value: resolved, expiresAt: advertised == null ? Date.now() + DEFAULT_CONTEXT_WINDOW_RECHECK_MS : Number.POSITIVE_INFINITY });
  if (announcedContextWindows.get(key) !== resolved) {
    announcedContextWindows.set(key, resolved);
    console.info(`[sand-host] context window for ${settings.model}: ${resolved} tokens (${advertised == null ? `default; the endpoint did not advertise one, set ${OPENAI_COMPATIBLE_CONTEXT_WINDOW_ENV} to override` : "advertised by the endpoint"})`);
  }
  return resolved;
}

/**
 * The compact-and-retry rescue keys on `InputTokenLimitError`, and the string classifier that
 * produces it only had callers on the Cursor RPC route. The transport wraps every failure in a
 * bare Error whose message carries the provider's body, so classify here by that message, with
 * the same observed-phrase list every other route uses -- an xAI overflow reads "This model's
 * maximum prompt length is N but the request contains M tokens." Anything unrecognised, including
 * a genuine 500, passes through unchanged rather than being guessed at.
 */
function classifyProviderFailure(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return classifyTokenLimitErrorFromMessage(error.message) ?? error;
}

function configuredOpenAiCompatibleModel(): string {
  try { return openAiCompatibleSettings().model; } catch { return "openai-compatible"; }
}

function openAiCompatibleExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const settings = openAiCompatibleSettings();
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
/**
 * Tool parameters arrive as whatever the tool declared, and Grok Bot's own tools declare Zod
 * schemas -- SendMessage is `objectSchema.superRefine(...)`. A Zod object does not serialize to
 * anything a model can read, so the request carried an empty shape and the model invented its
 * arguments: {"message": "..."} where SendMessage requires {type, content}. Every call then
 * failed validation and the turn had nothing to say.
 *
 * Converted here rather than inside the transport: the transport is loaded as a data: URL
 * module by its tests, which cannot resolve a bare specifier like zod-to-json-schema.
 */
function stripSchemaArtifacts(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripSchemaArtifacts);
  const { $schema: _s, default: _d, definitions: _defs, markdownDescription: _m, additionalProperties: _a, ...rest } = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(rest)) result[key] = stripSchemaArtifacts(child);
  return result;
}

function withJsonSchemaParameters(definitions: readonly Loose[] | undefined): readonly Loose[] | undefined {
  if (definitions == null) return undefined;
  return definitions.map(definition => {
    const raw = definition.inputSchema ?? definition.parameters;
    if (raw == null) return definition;
    const candidate = raw as { readonly _def?: unknown; readonly safeParse?: unknown; readonly jsonSchema?: unknown };
    // The agent toolset wraps schemas with the AI SDK's jsonSchema() helper, so `parameters`
    // is {jsonSchema: {...}} rather than a schema. Sent as-is the model sees an object with
    // no type and no properties, and invents argument names -- {message}, {recipient, text} --
    // none of which SendMessage accepts. Unwrap first, then convert Zod if that is what it is.
    if (candidate.jsonSchema != null) {
      return { ...definition, inputSchema: undefined, parameters: stripSchemaArtifacts(candidate.jsonSchema) };
    }
    const isZod = typeof candidate.safeParse === "function" || candidate._def !== undefined;
    if (!isZod) return definition;
    try { return { ...definition, inputSchema: undefined, parameters: stripSchemaArtifacts(zodToJsonSchema(raw as Parameters<typeof zodToJsonSchema>[0])) }; }
    catch { return definition; }
  });
}

  const tools = openAiCompatibleTools(withJsonSchemaParameters(definitions));
  const fullStream = (async function* () {
    let text = "";
    try {
      const contextWindow = await resolveOpenAiCompatibleContextWindow(settings);
      for await (const event of streamOpenAiCompatibleChat({
        fetch,
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: settings.apiKey,
        ...(settings.transport == null ? {} : { transport: settings.transport }),
        ...(settings.accountId == null ? {} : { accountId: settings.accountId }),
        ...(settings.originator == null ? {} : { originator: settings.originator }),
        instructions: conversationInput(messages, (tools ?? []).some((tool: Loose) => tool.name === "SendMessage")).instructions,
        input: conversationInput(messages).input,
        ...(tools == null ? {} : { tools }),
        ...(executeTool == null ? {} : { executeTool: async (selected, args, toolCallId) => await executeTool(selected.source, args, toolCallId) }),
        maxSteps: tools == null ? 1 : 8,
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        // The runner owns the tool loop: it holds the turn, so it is the only thing that
        // can run SendMessage, which is the agent's only voice. Pass the call through in
        // the vocabulary tool-stream-executor already reads.
        if (event.type === "tool-call") {
          // The runner starts the tool as soon as it sees a call and expects the arguments
          // to arrive as a stream: a lone tool-call chunk only resolves its args when the
          // stream closes, which is after dispatch, so the tool ran with {} every time.
          // Emit the sequence a streaming provider emits and the args land before the call.
          const argsText = typeof event.args === "string" ? event.args : JSON.stringify(event.args ?? {});
          yield { type: "tool-call-streaming-start" as const, toolCallId: event.toolCallId, toolName: event.toolName };
          yield { type: "tool-call-delta" as const, toolCallId: event.toolCallId, toolName: event.toolName, argsTextDelta: argsText };
          yield { type: "tool-call" as const, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
          continue;
        }
        const basic = { promptTokens: event.usage.inputTokens, completionTokens: event.usage.outputTokens, totalTokens: event.usage.inputTokens + event.usage.outputTokens };
        onUsage?.(event.usage);
        usage.resolve(basic);
        extendedUsage.resolve({ ...event.usage, maxTokens: contextWindow });
        metadata.resolve({ openaiCompatible: { baseUrl: settings.baseUrl, model: settings.model } });
        resultResponse.resolve(response(text, invocationId, settings.model));
      }
    } catch (raw) {
      const error = classifyProviderFailure(raw);
      usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error;
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void) { super(new BasePromptBuilder(initialMessages)); }
  stream(_ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[]) {
    const execute = hostRoutedToolExecutor;
    if (this.provider === "codex") return codexExecutor(this.getMessages(), invocationId, definitions, execute, this.onUsage);
    if (this.provider === "claude-code") return claudeExecutor(this.getMessages(), invocationId, this.onUsage);
    // Deliberately no inline executor here: on the runner path tool calls belong to the
    // runner. Handing this one the routed-MCP executor made "did not provide an executor"
    // disappear while leaving every SendMessage unrunnable, so the turn finished silent.
    if (this.provider === "openai-compatible") return openAiCompatibleExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage);
    return openRouterExecutor(this.getMessages(), invocationId, definitions, execute, this.onUsage);
  }
}

export function createProviderPromptSession(provider: RoutedProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : provider === "openai-compatible" ? configuredOpenAiCompatibleModel() : process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  return { getModelId: () => modelId, getExecutor: state => new ProviderPromptExecutor(provider, Array.isArray(state) ? state as ProviderMessage[] : undefined, usage => recordRoutedUsage(provider, usage)) };
}

export async function runRoutedProviderText(provider: RoutedProvider, messages: readonly ProviderMessage[], options?: {
  readonly mcpServerUrl?: string;
  readonly tools?: readonly Loose[];
  readonly executeTool?: RoutedToolExecutor;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
}): Promise<string> {
  const invocationId = crypto.randomUUID();
  const onUsage = (usage: UsageRecord) => recordRoutedUsage(provider, usage);
  const result = provider === "codex"
    ? codexExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage)
    : provider === "claude-code"
      ? claudeExecutor(messages, invocationId, onUsage, options?.mcpServerUrl)
      : provider === "openai-compatible"
        ? openAiCompatibleExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage)
        : openRouterExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage);
  let text = "";
  for await (const event of result.fullStream) {
    if (event.type === "text-delta" && typeof event.textDelta === "string") {
      text += event.textDelta;
      options?.onTextDelta?.(event.textDelta, text);
    }
  }
  await result.response;
  return text;
}
