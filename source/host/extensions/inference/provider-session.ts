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
import { isSandBoxSettingEnabled, SAND_TOOL_TRACE_SETTING } from "../../sand-box-setting.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getBoxSecretsStorePath } from "../secrets/secrets-service.js";
import { streamCodexDirectResponses, type CodexDirectTool } from "./codex-direct-responses.js";
import { DEFAULT_OPENAI_COMPATIBLE_CONTEXT_WINDOW, IMAGE_PART_BYTES_MAX, OPENAI_COMPATIBLE_CONTEXT_WINDOW_ENV, endpointRefusesImages, fetchOpenAiCompatibleContextWindow, fetchOpenAiCompatibleModelIds, lastAnsweredModel, openAiCompatibleTools, resolveOpenAiCompatibleSettings, streamOpenAiCompatibleChat, type OpenAiCompatibleSettings } from "./openai-compatible-chat.js";
import { ModelTierTurnRouter, talkModelFor, type ModelTierTurnContext } from "./model-tier-router.js";
import type { LabelMessage, PromptExecutor } from "./sand-labeling.js";

type Loose = Record<string, any>;
interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
type RoutedProvider = Exclude<SandInferenceProvider, "cursor">;
type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type RoutedToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;
export interface ProviderSessionOptions extends ModelTierTurnContext {}

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
  "You are Titanium Bot, a warm, concise desktop assistant.",
  "The user cannot see your plain replies. Your assistant text is a private scratchpad.",
  "SendMessage is your only voice: a reply counts only once it is inside a SendMessage call.",
  "To answer, call SendMessage with type set to \"text\" and content set to what you want to say.",
  "The tools supplied with this request are Titanium Bot's already-connected plugins and accounts. Use them when relevant instead of claiming a plugin is unavailable.",
].join("\n");

const GROK_ROUTER_SYSTEM_PROMPT = [
  "You are Titanium Bot, a warm, concise desktop assistant.",
  "You are running inside Titanium Bot, not inside Codex CLI or Claude Code.",
  "The tools supplied with this request are Titanium Bot's already-connected plugins and accounts. Use them whenever they are relevant instead of claiming that a plugin is unavailable or asking the user to reconnect it.",
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

/**
 * ATTACH-1. The picture a person attaches is the user message's OWN part, and it looks like
 * `{type:"image", image:Uint8Array, mimeType}` -- context-processing pushes exactly that shape once
 * the blob is hydrated. This loop knew text, tool-call and tool-result and nothing else, so the part
 * fell straight through, conversationInput emitted a plain string, and the picture was gone.
 * Measured twice on Jason's box on 2026-09-09: the console leg was clean end to end, the bytes
 * arrived byte-identical in the agent's attachments folder, the containment check passed -- which is
 * why he saw his own screenshot -- and the model was still sent no image at all.
 */
type WireImage = { readonly b64: string; readonly mediaType: string; readonly name: string; readonly oversize?: boolean };

/** The transport's own per-image ceiling, so one attachment cannot blow the whole request. */
const USER_IMAGE_B64_MAX = IMAGE_PART_BYTES_MAX;

function imageMediaType(part: Loose): string {
  const declared = typeof part.mimeType === "string" ? part.mimeType : typeof part.mediaType === "string" ? part.mediaType : "";
  return declared.startsWith("image/") ? declared : "image/png";
}
/** Whatever the picture can be called in a sentence. Often empty: the console carries no filename this far. */
function imageName(part: Loose): string {
  for (const key of ["filename", "fileName", "path", "name"]) {
    const value = part[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}
/** Size once encoded, whatever container the bytes arrived in. A base64 string is measured as itself. */
function imagePayloadLength(payload: unknown): number | null {
  if (typeof payload === "string") return payload.length === 0 ? null : payload.length;
  if (payload instanceof Uint8Array) return payload.byteLength === 0 ? null : Math.ceil(payload.byteLength / 3) * 4;
  if (payload instanceof ArrayBuffer) return payload.byteLength === 0 ? null : Math.ceil(payload.byteLength / 3) * 4;
  return null;
}
function imageBase64(payload: unknown): string | null {
  if (typeof payload === "string") return payload.length === 0 ? null : payload;
  // Buffer is a Uint8Array, so this covers both of them.
  if (payload instanceof Uint8Array) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("base64");
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString("base64");
  return null;
}
/** True without converting anything, so the trace counter can count without paying for base64. */
function hasUserImagePayload(part: Loose): boolean {
  return part.type === "image" && imagePayloadLength(part.image ?? part.data) != null;
}
/**
 * An over-cap image comes back MARKED rather than dropped. It still has to be named to the model:
 * a picture that is silently not there is the whole failure this item exists to end.
 */
function userImagePart(raw: unknown): WireImage | null {
  const part = asRecord(raw);
  if (part == null || part.type !== "image") return null;
  const payload = part.image ?? part.data;
  const length = imagePayloadLength(payload);
  if (length == null) return null;
  const mediaType = imageMediaType(part), name = imageName(part);
  if (length > USER_IMAGE_B64_MAX) return { b64: "", mediaType, name, oversize: true };
  const b64 = imageBase64(payload);
  return b64 == null ? null : { b64, mediaType, name };
}

/** Named so the model can say which picture is missing. The console has no filename, so this counts instead. */
function namesOf(images: readonly WireImage[], from: number): string {
  return images.map((image, index) => (image.name.length > 0 ? image.name : `image ${from + index + 1}`)).join(", ");
}
/**
 * A picture that could not travel says so, in words, in the message it belonged to. The two reasons
 * read differently and neither claims more than was measured: "too large" is our own cap, and the
 * other case deliberately does not blame the model, because the same line covers a transport that
 * has no image channel at all.
 */
function withheldImageNote(images: readonly WireImage[], from: number, reason: "size" | "unsent"): string {
  const one = images.length === 1, named = namesOf(images, from);
  const it = one ? "it" : "them", shows = one ? "it shows" : "they show";
  return reason === "size"
    ? `[${named} ${one ? "was" : "were"} too large to send with this message, so ${one ? "it was" : "they were"} left out. Say so rather than guessing what ${shows}.]`
    : `[The ${one ? "picture" : "pictures"} attached to this message could not be sent, so you cannot see ${it}: ${named}. Any file path listed above is where ${one ? "it is" : "they are"} on this box. Say plainly that you cannot see ${it} rather than guessing what ${shows}.]`;
}

function flattenParts(content: unknown): { text: string; toolCalls: Loose[]; results: Loose[]; images: WireImage[] } {
  if (typeof content === "string") return { text: content, toolCalls: [], results: [], images: [] };
  if (!Array.isArray(content)) {
    const single = asRecord(content);
    return { text: typeof single?.text === "string" ? single.text : "", toolCalls: [], results: [], images: [] };
  }
  const text: string[] = [];
  const toolCalls: Loose[] = [];
  const results: Loose[] = [];
  const images: WireImage[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (part == null) continue;
    if (typeof part.text === "string" && part.text.length > 0) { text.push(part.text); continue; }
    if (part.type === "image") { const image = userImagePart(part); if (image != null) images.push(image); continue; }
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
      // SUB-2b. The screenshot a browser or computer tool rendered lives in `experimental_content`,
      // not in `result`, and this flattener dropped it: 2 image parts in the history, 0 on the
      // wire, measured. A tool message cannot carry an image, so it goes the way the transport's
      // own in-line path sends one: a user message of image_url parts right after the result.
      const images = historyImageParts(part.experimental_content);
      if (images.length > 0) {
        results.push({
          role: "user",
          content: [
            { type: "text", text: images.length === 1 ? "Screenshot from the tool call above." : `${images.length} screenshots from the tool calls above.` },
            ...images.map(image => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.b64}` } })),
          ],
        });
      }
    }
  }
  return { text: text.join("\n"), toolCalls, results, images };
}

/**
 * SUB-2b. `[sand][image] carried ...` is printed where a tool RENDERS its result, which proves the
 * render and nothing about the request. These two counts are about the request: how many image
 * parts the turn's message history holds, and how many survived into what leaves for the provider.
 * They are reported side by side on the [sand][wire] line precisely because they can disagree.
 */
const HISTORY_IMAGE_B64_MAX = 8 * 1024 * 1024;
/** The image parts a tool result rendered, in the shape the request needs. Oversized ones are left out rather than sent. */
function historyImageParts(value: unknown): Array<{ b64: string; mediaType: string }> {
  if (!Array.isArray(value)) return [];
  const found: Array<{ b64: string; mediaType: string }> = [];
  for (const raw of value) {
    const part = asRecord(raw);
    if (part == null || part.type !== "image") continue;
    const b64 = typeof part.data === "string" ? part.data : typeof part.base64 === "string" ? part.base64 : typeof part.imageB64 === "string" ? part.imageB64 : "";
    if (b64.length === 0 || b64.length > HISTORY_IMAGE_B64_MAX) continue;
    const mediaType = typeof part.mimeType === "string" && part.mimeType.startsWith("image/") ? part.mimeType : typeof part.mediaType === "string" && part.mediaType.startsWith("image/") ? part.mediaType : "image/png";
    found.push({ b64, mediaType });
  }
  return found;
}
function countHistoryImageParts(messages: readonly ProviderMessage[]): number {
  let found = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    const part = asRecord(value);
    if (part == null) return;
    // ATTACH-1. This counted only `{type:"image", data:"<base64>"}`, the shape a tool result renders,
    // so a person's own attachment -- `{type:"image", image:Uint8Array}` -- read 0 and AGREED with
    // the wire count at 0. The trace hid exactly the drop it exists to expose.
    if (part.type === "image" && hasUserImagePayload(part)) { found += 1; return; }
    // A tool result keeps its text in `result` and its rendered parts in `experimental_content`
    // (tool-stream-executor). An image only ever lives in the latter.
    if (part.type === "tool-result") { walk(part.experimental_content); walk(asRecord(part.result)?.content); }
  };
  for (const message of messages) walk(message.content);
  return found;
}

function countWireImageParts(input: readonly Loose[]): number {
  let found = 0;
  for (const message of input) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) if (asRecord(part)?.type === "image_url") found += 1;
  }
  return found;
}

/**
 * `imagesAllowed` is false for a transport with no image channel of its own and for an endpoint that
 * has already refused one this process. It is not a preference: the same request that carries a
 * picture to a vision endpoint kills the turn outright on glm-5.3, so the choice between sending the
 * bytes and sending a sentence has to be made here, where the message is still editable.
 */
function conversationInput(messages: readonly ProviderMessage[], hasSendMessage = false, imagesAllowed = true): { input: Loose[]; instructions: string } {
  const mapped = messages.map(message => {
    const role = message.role === "assistant" ? "assistant"
      : message.role === "system" ? "system"
      : message.role === "tool" ? "tool" : "user";
    const { text, toolCalls, results, images } = flattenParts(message.content);
    return { role, content: text, toolCalls, results, images };
  });
  const own = mapped.filter(message => message.role === "system" && message.content.trim().length > 0).map(message => message.content);

  const input: Loose[] = [];
  // One budget for the whole turn, spent in order, so a long history of screenshots cannot push the
  // request past what the endpoint will read while the newest picture is the one that gets dropped.
  let budget = HISTORY_IMAGE_B64_MAX;
  let seen = 0;
  for (const message of mapped) {
    if (message.role === "system") continue;
    if (message.role === "tool") { input.push(...message.results); continue; }
    if (message.toolCalls.length > 0) {
      input.push({ role: message.role, content: message.content.length > 0 ? message.content : null, tool_calls: message.toolCalls });
      continue;
    }
    if (message.images.length > 0) {
      const from = seen;
      seen += message.images.length;
      const sendable: WireImage[] = [], withheld: WireImage[] = [];
      for (const image of message.images) {
        if (!imagesAllowed || image.oversize === true || image.b64.length > budget) { withheld.push(image); continue; }
        budget -= image.b64.length;
        sendable.push(image);
      }
      let text = message.content;
      if (withheld.length > 0) {
        const note = withheldImageNote(withheld, from, imagesAllowed ? "size" : "unsent");
        text = text.length > 0 ? `${text}\n\n${note}` : note;
      }
      if (sendable.length > 0) {
        input.push({
          role: message.role,
          content: [
            ...(text.trim().length > 0 ? [{ type: "text", text }] : []),
            ...sendable.map(image => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.b64}` } })),
          ],
        });
        continue;
      }
      if (text.trim().length > 0) input.push({ role: message.role, content: text });
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

/** True when the relay has pinned an OpenAI-compatible endpoint into the box's secrets store. */
export function hasOpenAiCompatiblePin(): boolean { return (persistedSecrets().SAND_OPENAI_COMPATIBLE_BASE_URL ?? "").trim().length > 0; }
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
  return `${GROK_ROUTER_SYSTEM_PROMPT}\n\nContinue this Titanium Bot conversation.\n\n${rendered}`;
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
    throw new Error("Codex is not signed in with ChatGPT. Run `codex login`, then reopen Titanium Bot.");
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
  // This route hands `input` to the Responses API verbatim, which spells a picture `input_image`
  // and rejects the chat-shaped `image_url` part outright. Until that mapping exists here, an
  // attached picture travels as the sentence rather than as bytes, which is honest and not silent.
  const codexConversation = conversationInput(messages, (tools ?? []).some((tool: Loose) => tool.name === "SendMessage"), false);
  const fullStream = (async function* () {
    let text = "";
    try {
      for await (const event of streamCodexDirectResponses({
        fetch: codexAuthenticatedFetch(credentials),
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model,
        ...(configuredCodexReasoningEffort() == null ? {} : { reasoningEffort: configuredCodexReasoningEffort()! }),
        // Pre-existing: `settings` was not in scope on this branch, so every codex-direct
        // turn threw a ReferenceError before it reached the backend. The note wants the
        // endpoint that is actually answering, and on this route that is fixed and known.
        instructions: withBackendNote(codexConversation.instructions, { baseUrl: "https://chatgpt.com/backend-api/codex", model, apiKey: null, contextWindow: null, endpointName: "the ChatGPT/Codex subscription backend" }),
        input: codexConversation.input,
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
  if (executable == null) throw new Error("Claude Code is not installed. Install and sign in to Claude Code, then reopen Titanium Bot.");
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

// The persona is a name, not knowledge: without this a model on any backend answers "which model
// are you" from the prompt's name (glm-5.3 once said it was Grok, built by xAI). Appended to every
// instruction set this route sends, so the answer is the endpoint that is actually answering.
function withBackendNote(instructions: string, settings: OpenAiCompatibleSettings): string {
  let host = settings.baseUrl;
  try { host = new URL(settings.baseUrl).host; } catch { /* keep the raw value */ }
  // PROXY-1. Pointed at the plan proxy the base URL's host is `titanbot-proxy`, so this note --
  // the one thing standing between a model and inventing its own vendor -- would have had Titan
  // tell a customer it runs at a container on our bridge. servedBy is what the box was told to
  // say instead; with none set the host is still the answer, so the sentence is byte-equal for
  // every endpoint that does not set one.
  const where = (settings.servedBy ?? "").length > 0 ? settings.servedBy : host;
  // And the same reasoning one field along. On the plan `settings.model` is `plan-zai`, a routing
  // alias only the operator's proxy uses, and this sentence is the single place a customer is most
  // likely to read it: the four PLAN_REFUSAL sentences are careful to keep aliases and vendor names
  // out, and the persona note put both straight back. modelLabel is the name the box was told to
  // say; with none set the model id is still the answer, so nothing changes for a customer on their
  // own key.
  const called = (settings.modelLabel ?? "").length > 0 ? settings.modelLabel : settings.model;
  const through = settings.endpointName ? `"${settings.endpointName}"` : "an OpenAI-compatible endpoint";
  // MODEL-1c. WHAT ACTUALLY ANSWERED LAST, when it was not what this box is pinned to. A screenshot
  // on a text-only plan is routed to the vision model, and without this sentence Titan would go on
  // naming the pin on the very turn a different model read the picture -- which is the one thing
  // this note exists to stop, in a new place. Silent when they agree, which is every ordinary turn,
  // so the sentence is byte-equal for every box that has never been rerouted.
  const answered = lastAnsweredModel();
  const alsoAnswered = answered.length > 0 && answered !== settings.model
    ? ` Your last call was answered by '${answered}' rather than the model you are pinned to; if asked, say you are pinned to '${called}' and that '${answered}' answered the most recent call.`
    : "";
  return `${instructions}\n\n## Your backend\nYou are Titanbot. Right now you are answering through ${through}, model '${called}' at ${where}.${alsoAnswered} If asked which model, provider or company is behind you, say exactly that; never claim to be Grok, xAI, or any other model or vendor.`;
}

/**
 * PROXY-1. What a customer on the included plan reads when the plan itself refuses the turn.
 *
 * Every one of these is decided by the HOST, never by the model: a provider body forwarded through
 * the proxy names an alias, a dollar figure, a vendor and sometimes a container, and none of that
 * is a customer's business or true in their words. Four sentences, and no fifth -- an error this
 * does not recognise passes through exactly as it did before, because a wrong plain sentence hides
 * a real fault better than a raw one ever could.
 *
 * Active only when servedBy is set, which is the marker the relay writes with the plan endpoint
 * and never with a customer's own key. A box on its own key keeps today's wording, including the
 * "check the key in Settings" one, which is the fourth case and needs nothing done to it here.
 *
 * The wording rule from TOOLS-FETCH-1 holds: no alias, no dollars, no vendor, no tool name, and
 * never "may be temporary".
 */
const PLAN_REFUSAL = {
  spent: "You have used everything your plan includes this month. Add your own key under Settings and I will keep going, or ask for more.",
  rateLimited: "That is more than the plan allows right now. Give me a moment and ask again.",
  down: "The model I answer through is not responding. Nothing you sent is lost. Try again in a minute, or pick a different model in Settings.",
} as const;

/** The status the transport put in its message: `... (429: {body})` or `... (503)`. */
function providerFailureStatus(message: string): number | null {
  const found = /\((\d{3})[:)]/.exec(message);
  const status = found == null ? Number.NaN : Number(found[1]);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

// A failure with no status at all: DNS, a refused connection, a dead socket, or our own abort.
// Matched by name rather than assumed, so a malformed-SSE or step-limit error -- which are faults
// worth reading, not outages -- keeps its own words.
const TRANSPORT_FAILURE = /fetch failed|timed out|TimeoutError|AbortError|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed|terminated/i;

function planRefusalSentence(message: string): string | null {
  const status = providerFailureStatus(message);
  // The proxy refuses a spent budget with 400 and a body that says so, and refuses a key it no
  // longer holds with 401. Revocation is the second one, and this wave mints soft budgets only --
  // so on the R750 today 401 is the only way this sentence is reached. Both are the same thing to
  // the person reading it, and the two actions it names are right either way.
  if (status === 401 || status === 403) return PLAN_REFUSAL.spent;
  if (status === 400 && /budget|exceed|quota|spend|limit/i.test(message)) return PLAN_REFUSAL.spent;
  if (status === 429) return PLAN_REFUSAL.rateLimited;
  if (status != null && status >= 500) return PLAN_REFUSAL.down;
  return status == null && TRANSPORT_FAILURE.test(message) ? PLAN_REFUSAL.down : null;
}

/**
 * The classified failure, then the plan's own words over it. Order matters: the compact-and-retry
 * rescue keys on InputTokenLimitError, so anything the classifier recognised is passed straight
 * through -- translating an overflow into "try again in a minute" would take compaction off the
 * turn and leave every following turn failing identically.
 */
function translateProviderFailure(raw: unknown, settings: OpenAiCompatibleSettings): unknown {
  const classified = classifyProviderFailure(raw);
  if (classified !== raw || !(raw instanceof Error)) return classified;
  if ((settings.servedBy ?? "").length === 0) return classified;
  const sentence = planRefusalSentence(raw.message);
  if (sentence == null) return classified;
  // The provider's own body is kept as the cause, so the host log still says what actually
  // happened while the person reads a sentence written for them.
  return Object.assign(new Error(sentence), { cause: raw });
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
const TALK_CATALOG_CACHE_MS = 60_000;
const talkCatalogs = new Map<string, { readonly ids: readonly string[] | null; readonly expiresAt: number }>();
async function talkModelAvailable(settings: OpenAiCompatibleSettings): Promise<boolean> {
  const talkModel = talkModelFor(settings.model);
  if (talkModel == null) return false;
  const key = `${settings.baseUrl}\n${settings.model}`;
  const cached = talkCatalogs.get(key);
  if (cached !== undefined && Date.now() < cached.expiresAt) return cached.ids?.includes(talkModel) === true;
  const ids = await fetchOpenAiCompatibleModelIds(fetch, settings);
  talkCatalogs.set(key, { ids, expiresAt: Date.now() + TALK_CATALOG_CACHE_MS });
  return ids?.includes(talkModel) === true;
}
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

function openAiCompatibleExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void, conversationId?: string, router?: ModelTierTurnRouter) {
  let settings = openAiCompatibleSettings();
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
      if (router != null) {
        const workSettings = settings;
        const choice = router.choose({
          workModel: workSettings.model,
          talkAvailable: await talkModelAvailable(workSettings),
          workspacePin: process.env.SAND_MODEL_ROUTER_PIN ?? persistedSecrets().SAND_MODEL_ROUTER_PIN,
        });
        settings = choice.model === workSettings.model ? workSettings : {
          ...workSettings,
          model: choice.model,
          ...((workSettings.modelLabel ?? "").length === 0 ? {} : { modelLabel: `${workSettings.modelLabel} Flash` }),
        };
        console.info(`[sand][router] ${JSON.stringify({ conversationId: conversationId ?? null, tier: choice.tier, model: choice.model, reason: choice.reason })}`);
      }
      // Once for the model step: request, instructions and trace share one encoded conversation.
      const imagesAllowed = !endpointRefusesImages(settings.baseUrl, settings.model);
      const conversation = conversationInput(messages, (tools ?? []).some((tool: Loose) => tool.name === "SendMessage"), imagesAllowed);
      if (isSandBoxSettingEnabled(SAND_TOOL_TRACE_SETTING)) {
        console.log(`[sand][wire] ${JSON.stringify({
          conversationId: conversationId ?? null,
          transport: settings.transport ?? "chat", model: settings.model,
          offered: (definitions ?? []).length, sent: (tools ?? []).length,
          historyImageParts: countHistoryImageParts(messages),
          imageParts: countWireImageParts(conversation.input), imagesAllowed,
          tools: (tools ?? []).map(tool => tool.name),
        })}`);
      }
      const contextWindow = await resolveOpenAiCompatibleContextWindow(settings);
      for await (const event of streamOpenAiCompatibleChat({
        fetch,
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: settings.apiKey,
        ...(settings.transport == null ? {} : { transport: settings.transport }),
        ...(settings.accountId == null ? {} : { accountId: settings.accountId }),
        ...(settings.originator == null ? {} : { originator: settings.originator }),
        // MODEL-1c. The vision route travels with the request so a screenshot skips a pin that
        // cannot read one, rather than paying the refusal and being turned into a sentence.
        ...(settings.visionFallback == null ? {} : { visionFallback: settings.visionFallback }),
        instructions: withBackendNote(conversation.instructions, settings),
        input: conversation.input,
        ...(tools == null ? {} : { tools }),
        ...(executeTool == null ? {} : { executeTool: async (selected, args, toolCallId) => await executeTool(selected.source, args, toolCallId) }),
        maxSteps: tools == null ? 1 : 8,
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        // The runner owns the tool loop: it holds the turn, so it is the only thing that
        // can run SendMessage, which is the agent's only voice. Pass the call through in
        // the vocabulary tool-stream-executor already reads.
        if (event.type === "tool-call") {
          router?.observeToolCall(event.toolName);
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
      const error = translateProviderFailure(raw, settings);
      usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error;
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  readonly tierRouter: ModelTierTurnRouter;
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void, readonly conversationId?: string, readonly sessionOptions: ProviderSessionOptions = {}) {
    super(new BasePromptBuilder(initialMessages));
    this.tierRouter = new ModelTierTurnRouter(sessionOptions);
  }
  appendMessages(messages: ProviderMessage | readonly ProviderMessage[]) {
    this.tierRouter.observeMessages(messages);
    return super.appendMessages(messages);
  }
  stream(_ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[]) {
    const execute = hostRoutedToolExecutor;
    if (this.provider === "codex") return codexExecutor(this.getMessages(), invocationId, definitions, execute, this.onUsage);
    if (this.provider === "claude-code") return claudeExecutor(this.getMessages(), invocationId, this.onUsage);
    // Deliberately no inline executor here: on the runner path tool calls belong to the
    // runner. Handing this one the routed-MCP executor made "did not provide an executor"
    // disappear while leaving every SendMessage unrunnable, so the turn finished silent.
    if (this.provider === "openai-compatible") return openAiCompatibleExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage, this.conversationId, this.tierRouter);
    return openRouterExecutor(this.getMessages(), invocationId, definitions, execute, this.onUsage);
  }
}

export function createProviderPromptSession(provider: RoutedProvider, conversationId?: string, sessionOptions: ProviderSessionOptions = {}): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : provider === "openai-compatible" ? configuredOpenAiCompatibleModel() : process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  return { getModelId: () => modelId, getExecutor: state => new ProviderPromptExecutor(provider, Array.isArray(state) ? state as ProviderMessage[] : undefined, usage => recordRoutedUsage(provider, usage), conversationId, sessionOptions) };
}

export async function runRoutedProviderText(provider: RoutedProvider, messages: readonly ProviderMessage[], options?: {
  readonly mcpServerUrl?: string;
  readonly tools?: readonly Loose[];
  readonly executeTool?: RoutedToolExecutor;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
  readonly routerContext?: ProviderSessionOptions;
}): Promise<string> {
  const invocationId = crypto.randomUUID();
  const onUsage = (usage: UsageRecord) => recordRoutedUsage(provider, usage);
  const result = provider === "codex"
    ? codexExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage)
    : provider === "claude-code"
      ? claudeExecutor(messages, invocationId, onUsage, options?.mcpServerUrl)
      : provider === "openai-compatible"
        ? openAiCompatibleExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage, undefined, new ModelTierTurnRouter(options?.routerContext))
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
