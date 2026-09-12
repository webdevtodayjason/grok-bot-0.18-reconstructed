type Loose = Record<string, any>;

export const OPENAI_COMPATIBLE_BASE_URL_ENV = "SAND_OPENAI_COMPATIBLE_BASE_URL";
export const OPENAI_COMPATIBLE_MODEL_ENV = "SAND_OPENAI_COMPATIBLE_MODEL";
export const OPENAI_COMPATIBLE_API_KEY_ENV = "SAND_OPENAI_COMPATIBLE_API_KEY";
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:11434/v1";
export const OPENAI_COMPATIBLE_CONTEXT_WINDOW_ENV = "SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW";
/**
 * Used only when the endpoint does not advertise a window and none is configured. Deliberately
 * modest: compaction firing early on a large model wastes a summary, while a window set larger
 * than the real one leaves compaction dead until the provider rejects the prompt -- which is
 * the failure this whole path exists to prevent. The 32k figure is where local runtimes that
 * advertise nothing (Ollama, LM Studio) tend to sit.
 */
export const DEFAULT_OPENAI_COMPATIBLE_CONTEXT_WINDOW = 32_000;

export type OpenAiCompatibleUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

export type OpenAiCompatibleTool = {
  readonly name: string;
  readonly description?: string;
  readonly parameters: unknown;
  readonly source: Loose;
};

export type OpenAiCompatibleSettings = {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string | null;
  /** Operator-configured context window in tokens, or null to ask the endpoint. */
  readonly contextWindow: number | null;
  /** "responses" speaks the OpenAI Responses API (the ChatGPT/Codex subscription backend); absent means chat completions. */
  readonly transport?: "chat" | "responses";
  /** ChatGPT account id sent as `chatgpt-account-id` on the responses transport. */
  readonly accountId?: string | null;
  /** How this product names itself to the vendor; never a first-party client's name. */
  readonly originator?: string | null;
  /** The operator-facing name of the endpoint, so the agent can say truthfully what it runs on. */
  readonly endpointName?: string | null;
  /**
   * PROXY-1. Who is actually serving this model, when the base URL cannot say so honestly.
   *
   * Pointed at the plan proxy, the base URL's host is `titanbot-proxy`: a container name on our
   * own bridge, which means nothing to the person asking and names our plumbing to a customer.
   * This is the name the box was told to say instead. It is also the marker for the plan-worded
   * refusals, so a box answering on a customer's own key never gets plan wording.
   *
   * Absent unless configured, so settings stay byte-equal for every endpoint that does not set it.
   */
  readonly servedBy?: string | null;
  /**
   * PROXY-1. What this model is CALLED to the person, when its routing id is not a name they own.
   *
   * On the plan the model id is `plan-zai`: a string that exists so the proxy can pick a pool and
   * so the console can tell an included row from a customer's own. Asked what it runs on, the
   * persona note read that id straight back to the customer, which hands them an internal routing
   * alias as the answer to the one question this note exists to answer honestly. This is the label
   * that goes in the sentence instead. Absent unless configured, so a customer on their own key
   * still hears their own model name and the sentence is byte-equal for every endpoint that does
   * not set one.
   */
  readonly modelLabel?: string | null;
};
export const OPENAI_COMPATIBLE_ENDPOINT_NAME_ENV = "SAND_OPENAI_COMPATIBLE_ENDPOINT_NAME";
export const OPENAI_COMPATIBLE_TRANSPORT_ENV = "SAND_OPENAI_COMPATIBLE_TRANSPORT";
export const OPENAI_COMPATIBLE_ACCOUNT_ID_ENV = "SAND_OPENAI_COMPATIBLE_ACCOUNT_ID";
export const OPENAI_COMPATIBLE_ORIGINATOR_ENV = "SAND_OPENAI_COMPATIBLE_ORIGINATOR";
export const OPENAI_COMPATIBLE_SERVED_BY_ENV = "SAND_OPENAI_COMPATIBLE_SERVED_BY";
export const OPENAI_COMPATIBLE_MODEL_LABEL_ENV = "SAND_OPENAI_COMPATIBLE_MODEL_LABEL";

export type OpenAiCompatibleEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly type: "done"; readonly text: string; readonly usage: OpenAiCompatibleUsage };

export type OpenAiCompatibleOptions = {
  readonly fetch: typeof fetch;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string | null;
  readonly instructions: string;
  readonly input: readonly Loose[];
  readonly tools?: readonly OpenAiCompatibleTool[];
  readonly executeTool?: (tool: OpenAiCompatibleTool, args: unknown, toolCallId: string) => Promise<unknown>;
  readonly maxSteps?: number;
  readonly transport?: "chat" | "responses";
  readonly accountId?: string | null;
  readonly originator?: string | null;
};

type PendingToolCall = { id: string; name: string; arguments: string };

function record(value: unknown): Loose | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Loose : null;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? "null"; }
  catch (error) { return JSON.stringify({ isError: true, error: error instanceof Error ? error.message : String(error) }); }
}

/** Resolves the endpoint, model and optional key from the environment first, then Grok Bot's persisted secrets. */
export function resolveOpenAiCompatibleSettings(env: Readonly<Record<string, string | undefined>>, secrets: Readonly<Record<string, string>> = {}): OpenAiCompatibleSettings {
  const configured = (name: string): string => env[name]?.trim() || secrets[name]?.trim() || "";
  const model = configured(OPENAI_COMPATIBLE_MODEL_ENV);
  if (model.length === 0) throw new Error(`An OpenAI-compatible endpoint needs a model name. Set ${OPENAI_COMPATIBLE_MODEL_ENV} to a model your server serves.`);
  const apiKey = configured(OPENAI_COMPATIBLE_API_KEY_ENV);
  const contextWindow = Number.parseInt(configured(OPENAI_COMPATIBLE_CONTEXT_WINDOW_ENV), 10);
  return {
    baseUrl: configured(OPENAI_COMPATIBLE_BASE_URL_ENV) || DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    model,
    apiKey: apiKey.length === 0 ? null : apiKey,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    // Only present when configured, so settings stay byte-equal for every chat-completions endpoint.
    ...(configured(OPENAI_COMPATIBLE_TRANSPORT_ENV).toLowerCase() === "responses" ? { transport: "responses" as const } : {}),
    ...(configured(OPENAI_COMPATIBLE_ACCOUNT_ID_ENV).length > 0 ? { accountId: configured(OPENAI_COMPATIBLE_ACCOUNT_ID_ENV) } : {}),
    ...(configured(OPENAI_COMPATIBLE_ORIGINATOR_ENV).length > 0 ? { originator: configured(OPENAI_COMPATIBLE_ORIGINATOR_ENV) } : {}),
    ...(configured(OPENAI_COMPATIBLE_ENDPOINT_NAME_ENV).length > 0 ? { endpointName: configured(OPENAI_COMPATIBLE_ENDPOINT_NAME_ENV) } : {}),
    ...(configured(OPENAI_COMPATIBLE_SERVED_BY_ENV).length > 0 ? { servedBy: configured(OPENAI_COMPATIBLE_SERVED_BY_ENV) } : {}),
    ...(configured(OPENAI_COMPATIBLE_MODEL_LABEL_ENV).length > 0 ? { modelLabel: configured(OPENAI_COMPATIBLE_MODEL_LABEL_ENV) } : {}),
  };
}

/** The sibling of the chat endpoint: same root, `/models` instead of `/chat/completions`. */
export function openAiCompatibleModelsEndpoint(baseUrl: string): string {
  const chat = openAiCompatibleChatEndpoint(baseUrl);
  return `${chat.slice(0, -"/chat/completions".length)}/models`;
}

/** The exact ids this credential can currently route to. An unreadable catalog is no evidence. */
export async function fetchOpenAiCompatibleModelIds(
  fetchImpl: typeof fetch,
  settings: Pick<OpenAiCompatibleSettings, "baseUrl" | "apiKey">,
  timeoutMs = 5_000,
): Promise<readonly string[] | null> {
  try {
    const response = await fetchImpl(openAiCompatibleModelsEndpoint(settings.baseUrl), {
      headers: settings.apiKey == null ? {} : { authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = record(await response.json());
    const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    return [...new Set(entries.flatMap((raw: unknown) => {
      const entry = record(raw);
      if (entry == null) return [];
      const ids = [entry.id, entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
      return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    }))];
  } catch {
    return null;
  }
}

/**
 * Every local inference executor used to report a context window of zero, and the compaction
 * trigger's first line is `if (maxTokens <= 0) return` -- so a conversation on this route grew
 * until the provider rejected the prompt, then failed identically every turn. The window is a
 * real number that OpenAI-compatible servers mostly advertise on `/models` (xAI and OpenRouter as
 * `context_length`, vLLM as `max_model_len`), so ask for it. Never throws: a server that does not
 * answer, or answers without a figure, yields null and the caller falls back.
 */
export async function fetchOpenAiCompatibleContextWindow(
  fetchImpl: typeof fetch,
  settings: Pick<OpenAiCompatibleSettings, "baseUrl" | "model" | "apiKey">,
  timeoutMs = 5_000,
): Promise<number | null> {
  try {
    const response = await fetchImpl(openAiCompatibleModelsEndpoint(settings.baseUrl), {
      headers: settings.apiKey == null ? {} : { authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = record(await response.json());
    const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const matches = (entry: Loose): boolean => entry.id === settings.model
      || (Array.isArray(entry.aliases) && entry.aliases.includes(settings.model))
      || entry.name === settings.model;
    const entry = entries.map(record).find((candidate) => candidate != null && matches(candidate));
    if (entry == null) return null;
    for (const field of ["context_length", "max_model_len", "max_context_length", "context_window"]) {
      const value = entry[field];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
    }
    return null;
  } catch {
    return null;
  }
}

/** Accepts a server root, a `/v1` root, or a full completions URL so every local runtime's advertised address works verbatim. */
export function openAiCompatibleChatEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error(`${OPENAI_COMPATIBLE_BASE_URL_ENV} is not a valid URL: ${baseUrl}`); }
  // `host:port` parses as an opaque scheme, so an omitted protocol has to be rejected here
  // rather than surfacing much later as an unreadable fetch failure.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${OPENAI_COMPATIBLE_BASE_URL_ENV} must be an http:// or https:// URL: ${baseUrl}`);
  if (parsed.pathname.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}${parsed.pathname === "/" ? "/v1" : ""}/chat/completions`;
}

export function openAiCompatibleTools(definitions: readonly Loose[] | undefined): OpenAiCompatibleTool[] | undefined {
  if (definitions == null) return undefined;
  const tools = definitions.flatMap((source): OpenAiCompatibleTool[] => {
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

/**
 * Small local models pick the right tool and then get its arguments wrong: they invent property
 * names ("message", "text", "userId", "format") and drop required ones. Measured on 2026-08-27,
 * schema adherence falls apart somewhere between one and six declared tools, on every local model
 * tried -- yet the same model answers correctly when the failing tool is the only one on the table.
 *
 * So when a call does not fit its schema, ask once more with just that tool and the specific
 * problem. This is adapter work, not prompt tuning: the arguments are repaired against the
 * schema the tool itself declared, and a call that still does not fit is passed through unchanged
 * so the failure stays visible rather than being papered over.
 */
function schemaProblems(args: unknown, schema: unknown): string[] {
  const shape = record(schema);
  const value = record(args);
  if (shape == null || value == null) return [];
  const properties = record(shape.properties);
  if (properties == null) return [];
  const problems: string[] = [];
  const required = Array.isArray(shape.required) ? shape.required.filter((name): name is string => typeof name === "string") : [];
  for (const name of required) {
    if (value[name] == null || (typeof value[name] === "string" && value[name].trim().length === 0)) {
      problems.push(`required property "${name}" is missing`);
    }
  }
  for (const name of Object.keys(value)) {
    if (!(name in properties)) problems.push(`"${name}" is not a declared property`);
  }
  return problems;
}

async function repairToolCall(
  options: OpenAiCompatibleOptions,
  endpoint: string,
  apiKey: string,
  messages: readonly Loose[],
  tool: OpenAiCompatibleTool,
  call: PendingToolCall,
  problems: readonly string[],
): Promise<unknown | undefined> {
  const body = {
    model: options.model,
    messages: [
      ...messages,
      { role: "assistant", tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] },
      { role: "tool", tool_call_id: call.id, content: safeJson({
        isError: true,
        error: `Invalid arguments for ${call.name}: ${problems.join("; ")}. Call ${call.name} again using only its declared properties.`,
        schema: tool.parameters,
      }) },
    ],
    tools: [{ type: "function", function: { name: tool.name, ...(tool.description == null ? {} : { description: tool.description }), parameters: tool.parameters } }],
    tool_choice: "auto",
    stream: false,
  };
  const response = await options.fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "grok-bot-router/1",
      ...(apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return undefined;
  const payload = record(await response.json().catch(() => null));
  const choice = record(Array.isArray(payload?.choices) ? payload.choices[0] : null);
  const message = record(choice?.message);
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const repaired = record(calls[0]);
  const fn = record(repaired?.function);
  if (typeof fn?.arguments !== "string") return undefined;
  let parsed: unknown;
  try { parsed = fn.arguments.length > 0 ? JSON.parse(fn.arguments) : {}; } catch { return undefined; }
  return schemaProblems(parsed, tool.parameters).length === 0 ? parsed : undefined;
}

/** Read once. The image guard has to see the body BEFORE deciding whether this is an error at all. */
async function bodyText(response: Response): Promise<string> {
  try { return (await response.text()).slice(0, 4_096).trim(); } catch { return ""; }
}

async function responseError(response: Response, hasApiKey: boolean): Promise<Error> {
  return errorFromResponse(response.status, await bodyText(response), hasApiKey);
}

function errorFromResponse(status: number, detail: string, hasApiKey: boolean): Error {
  const suffix = `(${status}${detail.length === 0 ? "" : `: ${detail}`})`;
  // A key-guarded server (LM Studio, a fronted vLLM) answers 401/403 rather than anything
  // provider-shaped, so the actionable instruction has to be synthesized here.
  if (status === 401 || status === 403) {
    return new Error(hasApiKey
      ? `The OpenAI-compatible endpoint rejected ${OPENAI_COMPATIBLE_API_KEY_ENV}. Check the key in Settings → Router. ${suffix}`
      : `The OpenAI-compatible endpoint needs ${OPENAI_COMPATIBLE_API_KEY_ENV}. Add it in Settings → Router. ${suffix}`);
  }
  return new Error(`OpenAI-compatible request failed ${suffix}.`);
}

async function* sseEvents(response: Response): AsyncGenerator<Loose> {
  if (response.body == null) throw new Error("OpenAI-compatible response did not include a stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary).replaceAll("\r", "");
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data.length === 0 || data === "[DONE]") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(data); }
      catch { throw new Error("OpenAI-compatible response contained malformed SSE JSON."); }
      const event = record(parsed);
      if (event != null) yield event;
    }
    if (done) break;
  }
  if (buffer.trim().length > 0 && buffer.trim() !== "data: [DONE]") throw new Error("OpenAI-compatible response ended with an incomplete SSE event.");
}

function usageOf(chunk: Loose): OpenAiCompatibleUsage | null {
  const usage = record(chunk.usage);
  if (usage == null) return null;
  const details = record(usage.prompt_tokens_details) ?? {};
  return {
    inputTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0,
    outputTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0,
    cacheReadTokens: Number.isFinite(details.cached_tokens) ? details.cached_tokens : 0,
    cacheWriteTokens: 0,
  };
}

function addUsage(total: OpenAiCompatibleUsage, next: OpenAiCompatibleUsage): OpenAiCompatibleUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
  };
}

// Chat-completions streams fragment one tool call across many deltas: the id and name
// arrive once, the JSON arguments arrive character-group by character-group, and the
// only stable correlation is the delta index.
function mergeToolCalls(pending: Map<number, PendingToolCall>, deltas: readonly unknown[]): void {
  for (const raw of deltas) {
    const delta = record(raw);
    if (delta == null) continue;
    const index = Number.isFinite(delta.index) ? Number(delta.index) : pending.size;
    const current = pending.get(index) ?? { id: "", name: "", arguments: "" };
    const call = record(delta.function) ?? {};
    pending.set(index, {
      id: typeof delta.id === "string" && delta.id.length > 0 ? delta.id : current.id,
      name: current.name.length > 0 ? current.name : typeof call.name === "string" ? call.name : "",
      arguments: current.arguments + (typeof call.arguments === "string" ? call.arguments : ""),
    });
  }
}

function pendingToolCalls(pending: ReadonlyMap<number, PendingToolCall>): PendingToolCall[] {
  return [...pending.entries()].sort(([left], [right]) => left - right).flatMap(([index, call]) => call.name.length === 0 ? [] : [{ ...call, id: call.id.length > 0 ? call.id : `call_${index}` }]);
}

function requestTools(tools: readonly OpenAiCompatibleTool[] | undefined): Loose[] | undefined {
  if (tools == null || tools.length === 0) return undefined;
  return tools.map(tool => ({ type: "function", function: { name: tool.name, ...(tool.description == null ? {} : { description: tool.description }), parameters: tool.parameters } }));
}

/**
 * A screenshot in a tool result reaches the model as a picture, not as a base64 string.
 *
 * Tool results were unconditionally JSON-stringified, so a computerUse screenshot -- which comes
 * back as `{kind:"image", text, imageB64}` -- arrived as a megabyte of base64 TEXT. The model had
 * nothing it could see, so every computerUse subagent finished immediately having driven nothing,
 * reported "done", and the agent honestly said the pass returned no result and dispatched again.
 *
 * The OpenAI tool-message role cannot carry an image, so the picture follows as a user message,
 * which is the shape every OpenAI-compatible vision endpoint accepts. The base64 is stripped from
 * the tool message itself -- sending it twice would double an already large payload.
 *
 * The note here used to say the blast radius was exactly the broken path, because only computer-use
 * tool results carried images and an endpoint with no vision therefore saw no change on a turn that
 * works today. MEASURED FALSE on grok-bot-local-vm, 2026-09-09: a person's own attachment now takes
 * this same channel, and glm-5.3 answers an image_url part with 400 code 1210 "messages.content.type
 * is invalid, allowed values: ['text']" -- three times out of three, killing the turn with nothing
 * written to the transcript. That is what the refusal memory further down exists to survive.
 */
const IMAGE_BYTES_MAX = 6_000_000;

function imagePartsFrom(value: unknown): Array<{ b64: string; mediaType: string }> {
  if (value == null || typeof value !== "object") return [];
  const record = value as Loose;
  const found: Array<{ b64: string; mediaType: string }> = [];
  const push = (b64: unknown, mediaType: unknown) => {
    if (typeof b64 !== "string" || b64.length === 0) return;
    if (b64.length > IMAGE_BYTES_MAX) return;
    found.push({ b64, mediaType: typeof mediaType === "string" && mediaType.startsWith("image/") ? mediaType : "image/png" });
  };
  push(record.imageB64, record.mediaType);
  if (record.image != null && typeof record.image === "object") {
    const image = record.image as Loose;
    push(image.base64 ?? image.imageB64 ?? image.data, image.mediaType ?? image.mimeType);
  }
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part != null && typeof part === "object") {
        const item = part as Loose;
        push(item.imageB64 ?? item.base64 ?? item.data, item.mediaType ?? item.mimeType);
      }
    }
  }
  return found;
}

function withoutImageBytes(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  const { imageB64: _b64, ...rest } = value as Loose;
  if (rest.image != null && typeof rest.image === "object") {
    const { base64: _a, data: _d, imageB64: _i, ...imageRest } = rest.image as Loose;
    return { ...rest, image: imageRest };
  }
  return rest;
}

async function executeToolCalls(calls: readonly PendingToolCall[], toolsByName: ReadonlyMap<string, OpenAiCompatibleTool>, executeTool: NonNullable<OpenAiCompatibleOptions["executeTool"]>): Promise<Loose[]> {
  const results: Loose[] = [];
  const images: Array<{ b64: string; mediaType: string }> = [];
  for (const call of calls) {
    const result = (output: string): Loose => ({ role: "tool", tool_call_id: call.id, name: call.name, content: output });
    const selected = toolsByName.get(call.name);
    if (selected == null) { results.push(result(safeJson({ isError: true, error: `Unknown Titanium Bot tool: ${call.name}` }))); continue; }
    let args: unknown = {};
    try { args = call.arguments.trim().length > 0 ? JSON.parse(call.arguments) : {}; }
    catch { results.push(result(safeJson({ isError: true, error: "Tool arguments were not valid JSON." }))); continue; }
    try {
      const output = await executeTool(selected, args, call.id);
      const parts = imagePartsFrom(output);
      images.push(...parts);
      results.push(result(safeJson(parts.length === 0 ? output : withoutImageBytes(output))));
    }
    catch (error) { results.push(result(safeJson({ isError: true, error: error instanceof Error ? error.message : String(error) }))); }
  }
  if (images.length > 0) {
    results.push({
      role: "user",
      content: [
        { type: "text", text: images.length === 1 ? "Screenshot from the tool call above." : `${images.length} screenshots from the tool calls above.` },
        ...images.map(image => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.b64}` } })),
      ],
    });
  }
  return results;
}

/**
 * The per-image ceiling, named for the request builder that has to respect it. Kept as a separate
 * export so IMAGE_BYTES_MAX itself stays a plain const: tests/openai-compatible-images.test.mjs
 * lifts the helpers above out of this file and runs them, and an `export` in that slice is a syntax
 * error inside the function it builds.
 */
export const IMAGE_PART_BYTES_MAX = IMAGE_BYTES_MAX;

/**
 * An endpoint that will not read a picture is remembered for the life of this host process, keyed by
 * base URL and model, so the next turn does not spend the bytes and the round trip to learn it
 * again. Deliberately NOT persisted: a restart re-measures rather than inheriting a verdict about an
 * endpoint that may have been given vision since, and nothing here writes a file another wave owns.
 */
const imageRefusals = new Set<string>();
const refusalKey = (baseUrl: string, model: string): string => `${baseUrl.trim().replace(/\/+$/, "")} :: ${model.trim()}`;
export function endpointRefusesImages(baseUrl: string, model: string): boolean { return imageRefusals.has(refusalKey(baseUrl, model)); }
export function noteEndpointRefusesImages(baseUrl: string, model: string): void { imageRefusals.add(refusalKey(baseUrl, model)); }
/** For tests and gates, so one case cannot decide the next. */
export function forgetImageRefusals(): void { imageRefusals.clear(); }

/**
 * How a server says it will not take a picture. Only consulted on a 400 for a request that actually
 * carried one, so a 400 about anything else can never be read as a vision refusal. The first pattern
 * is the measured glm-5.3 wording; the rest are how other servers put it.
 */
const IMAGE_REFUSAL_PATTERNS: readonly RegExp[] = [
  /content\.type is invalid/i,
  /image[_ ]?url/i,
  /unsupported[^.]{0,32}image/i,
  /image[^.]{0,32}not supported/i,
  /(?:does not|doesn't) support[^.]{0,16}(?:image|vision)/i,
  /invalid[^.]{0,16}content type/i,
];
export function looksLikeImageRefusal(status: number, body: string): boolean {
  return status === 400 && IMAGE_REFUSAL_PATTERNS.some(pattern => pattern.test(body));
}

/** True when this request would hand the server a picture. */
export function carriesImageParts(messages: readonly Loose[]): boolean {
  return messages.some(message => Array.isArray(message.content) && message.content.some((part: unknown) => record(part)?.type === "image_url"));
}
/**
 * The same request with the pictures taken out and one plain line put where they were, so the model
 * is told what it cannot see instead of the turn dying. Plain words on purpose: this sentence is what
 * the agent then repeats to the person.
 */
export function withoutImageParts(messages: readonly Loose[]): Loose[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    const kept = message.content.filter((part: unknown) => record(part)?.type !== "image_url");
    const dropped = message.content.length - kept.length;
    if (dropped === 0) return message;
    const text = kept.map((part: unknown) => { const held = record(part); return typeof held?.text === "string" ? held.text : ""; }).filter(Boolean).join("\n");
    const one = dropped === 1;
    const note = `[The ${one ? "picture" : "pictures"} attached here could not be sent to this model, which does not accept images, so you cannot see ${one ? "it" : "them"}. Any file path listed above is where ${one ? "it is" : "they are"} on this box. Tell the person plainly that you cannot see ${one ? "it" : "them"} rather than guessing what ${one ? "it shows" : "they show"}.]`;
    return { ...message, content: text.length > 0 ? `${text}\n\n${note}` : note };
  });
}

// --- the Responses transport: the same events, spoken to the OpenAI Responses API ----------------
// Chat-shaped history in, Responses items out. The system prompt travels as `instructions`.
export function openAiResponsesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/responses") ? trimmed : `${trimmed}/responses`;
}
function responsesUserParts(content: unknown): Loose[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [{ type: "input_text", text: safeJson(content) }];
  return content.map((part: unknown) => {
    const p = record(part) ?? {};
    if (p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : String(record(p.image_url)?.url ?? "");
      return { type: "input_image", image_url: url, detail: "auto" };
    }
    return { type: "input_text", text: typeof p.text === "string" ? p.text : safeJson(part) };
  });
}
export function responsesInput(messages: readonly Loose[]): Loose[] {
  const items: Loose[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") { items.push({ role: "user", content: responsesUserParts(message.content) }); continue; }
    if (message.role === "assistant") {
      if (typeof message.content === "string" && message.content.length > 0) items.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const c = record(call) ?? {};
          const fn = record(c.function) ?? {};
          items.push({ type: "function_call", call_id: String(c.id ?? ""), name: String(fn.name ?? ""), arguments: typeof fn.arguments === "string" ? fn.arguments : safeJson(fn.arguments ?? {}) });
        }
      }
      continue;
    }
    if (message.role === "tool") items.push({ type: "function_call_output", call_id: String(message.tool_call_id ?? ""), output: typeof message.content === "string" ? message.content : safeJson(message.content) });
  }
  return items;
}
function responsesTools(tools: readonly OpenAiCompatibleTool[] | undefined): Loose[] | undefined {
  if (tools == null) return undefined;
  return tools.map(tool => ({ type: "function", name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} }, strict: false }));
}
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

async function* streamOpenAiResponses(options: OpenAiCompatibleOptions): AsyncGenerator<OpenAiCompatibleEvent> {
  const endpoint = openAiResponsesEndpoint(options.baseUrl);
  const apiKey = options.apiKey?.trim() ?? "";
  const maxSteps = options.maxSteps ?? 8;
  const declaredTools = responsesTools(options.tools);
  const toolsByName = new Map((options.tools ?? []).map(tool => [tool.name, tool]));
  let messages: Loose[] = options.input.map(item => ({ ...item }));
  let text = "";
  let usage: OpenAiCompatibleUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for (let step = 0; step < maxSteps; step += 1) {
    const response = await options.fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "user-agent": "grok-bot-router/1",
        "openai-beta": "responses=experimental",
        // Honest identification: this product's own name, never a first-party client's.
        originator: options.originator?.trim() || "grok-bot",
        ...(options.accountId ? { "chatgpt-account-id": options.accountId } : {}),
        ...(apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: options.model,
        instructions: options.instructions,
        input: responsesInput(messages),
        ...(declaredTools == null ? {} : { tools: declaredTools, tool_choice: "auto", parallel_tool_calls: true }),
        stream: true,
        store: false,
      }),
    });
    if (!response.ok) throw await responseError(response, apiKey.length > 0);

    const pending = new Map<string, PendingToolCall>();
    let stepUsage: OpenAiCompatibleUsage | null = null;
    let stepText = "";
    let chunks = 0;
    for await (const chunk of sseEvents(response)) {
      chunks += 1;
      const type = String(chunk.type ?? "");
      if (type === "error" || type === "response.failed") {
        const failure = record(chunk.error) ?? record(record(chunk.response)?.error) ?? chunk;
        throw new Error(`OpenAI Responses request failed: ${safeJson(failure).slice(0, 4_096)}`);
      }
      if (type === "response.output_text.delta" && typeof chunk.delta === "string" && chunk.delta.length > 0) {
        stepText += chunk.delta;
        text += chunk.delta;
        yield { type: "text-delta", delta: chunk.delta };
        continue;
      }
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const item = record(chunk.item);
        if (item?.type === "function_call") {
          const key = String(item.id ?? chunk.output_index ?? pending.size);
          const previous = pending.get(key);
          pending.set(key, {
            id: String(item.call_id ?? item.id ?? key),
            name: String(item.name ?? previous?.name ?? ""),
            arguments: typeof item.arguments === "string" && item.arguments.length > 0 ? item.arguments : previous?.arguments ?? "",
          });
        }
        continue;
      }
      if (type === "response.function_call_arguments.delta" && typeof chunk.delta === "string") {
        const current = pending.get(String(chunk.item_id));
        if (current != null) current.arguments += chunk.delta;
        continue;
      }
      if (type === "response.completed" || type === "response.incomplete") {
        const reported = record(record(chunk.response)?.usage);
        if (reported != null) {
          stepUsage = {
            inputTokens: count(reported.input_tokens),
            outputTokens: count(reported.output_tokens),
            cacheReadTokens: count(record(reported.input_tokens_details)?.cached_tokens),
            cacheWriteTokens: 0,
          };
        }
      }
    }
    if (chunks === 0) throw new Error("OpenAI Responses stream did not contain any events.");
    if (stepUsage != null) usage = addUsage(usage, stepUsage);
    const calls = [...pending.values()];
    if (calls.length === 0) {
      yield { type: "done", text, usage };
      return;
    }
    if (options.executeTool == null) {
      for (const call of calls) {
        let args: unknown = {};
        try { args = call.arguments.length > 0 ? JSON.parse(call.arguments) : {}; } catch { args = {}; }
        yield { type: "tool-call", toolCallId: call.id, toolName: call.name, args };
      }
      yield { type: "done", text, usage };
      return;
    }
    messages = [
      ...messages,
      { role: "assistant", content: stepText.length === 0 ? null : stepText, tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) },
      ...await executeToolCalls(calls, toolsByName, options.executeTool),
    ];
  }
  throw new Error(`The OpenAI Responses endpoint exceeded Titanium Bot's ${maxSteps}-step tool limit.`);
}

export async function* streamOpenAiCompatibleChat(options: OpenAiCompatibleOptions): AsyncGenerator<OpenAiCompatibleEvent> {
  if (options.transport === "responses") { yield* streamOpenAiResponses(options); return; }
  const maxSteps = options.maxSteps ?? 8;
  const endpoint = openAiCompatibleChatEndpoint(options.baseUrl);
  const toolsByName = new Map((options.tools ?? []).map(tool => [tool.name, tool]));
  const declaredTools = requestTools(options.tools);
  const apiKey = options.apiKey?.trim() ?? "";
  let messages: Loose[] = [{ role: "system", content: options.instructions }, ...options.input.map(item => ({ ...item }))];
  let text = "";
  let usage: OpenAiCompatibleUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  const post = (payload: readonly Loose[]) => options.fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": "grok-bot-router/1",
      // Local runtimes usually serve unauthenticated, so an absent key must not become an empty bearer.
      ...(apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({
      model: options.model,
      messages: payload,
      ...(declaredTools == null ? {} : { tools: declaredTools, tool_choice: "auto" }),
      // Reasoning models burn the whole budget thinking unless told not to, and the switch
      // lives here rather than at the top level, where it is silently ignored.
      ...(process.env.SAND_OPENAI_COMPATIBLE_THINKING?.trim() === "1"
        ? {}
        : { chat_template_kwargs: { enable_thinking: false } }),
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  for (let step = 0; step < maxSteps; step += 1) {
    // Known refusal: skip the bytes with no round trip. The picture is replaced by the sentence
    // before the request is built, so the model still knows a file was attached.
    if (endpointRefusesImages(options.baseUrl, options.model) && carriesImageParts(messages)) messages = withoutImageParts(messages);
    let response = await post(messages);
    if (!response.ok) {
      const detail = await bodyText(response);
      // The turn does not get to die because the endpoint has no eyes. Remember the refusal, put the
      // sentence where the picture was, and ask the same question again -- once.
      if (carriesImageParts(messages) && looksLikeImageRefusal(response.status, detail)) {
        noteEndpointRefusesImages(options.baseUrl, options.model);
        console.info(`[sand-host] ${options.model} refused an attached picture, so it travels as a sentence from here on (${detail.slice(0, 200)})`);
        messages = withoutImageParts(messages);
        response = await post(messages);
        if (!response.ok) throw errorFromResponse(response.status, await bodyText(response), apiKey.length > 0);
      } else {
        throw errorFromResponse(response.status, detail, apiKey.length > 0);
      }
    }

    const pending = new Map<number, PendingToolCall>();
    let stepUsage: OpenAiCompatibleUsage | null = null;
    let stepText = "";
    let chunks = 0;
    for await (const chunk of sseEvents(response)) {
      chunks += 1;
      const failure = record(chunk.error) ?? (typeof chunk.error === "string" ? { message: chunk.error } : null);
      if (failure != null) throw new Error(`OpenAI-compatible response failed: ${safeJson(failure).slice(0, 4_096)}`);
      const reported = usageOf(chunk);
      if (reported != null) stepUsage = reported;
      const choice = record(Array.isArray(chunk.choices) ? chunk.choices[0] : null);
      if (choice == null) continue;
      const delta = record(choice.delta) ?? record(choice.message) ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        stepText += delta.content;
        text += delta.content;
        yield { type: "text-delta", delta: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) mergeToolCalls(pending, delta.tool_calls);
    }
    if (chunks === 0) throw new Error("OpenAI-compatible response did not contain any completion chunks.");
    if (stepUsage != null) usage = addUsage(usage, stepUsage);
    const calls = pendingToolCalls(pending);
    if (calls.length === 0) {
      yield { type: "done", text, usage };
      return;
    }
    if (options.executeTool == null) {
      // No inline executor means the caller owns the tool loop -- which is the agent
      // runner, and the only place tools like SendMessage can run at all, since they
      // need the live turn. Surface the calls and let it drive the next step; running
      // them here against a narrower executor is how a turn ends up silent.
      for (const call of calls) {
        let args: unknown = {};
        try { args = call.arguments.length > 0 ? JSON.parse(call.arguments) : {}; } catch { args = {}; }
        const selected = toolsByName.get(call.name);
        const problems = selected == null ? [] : schemaProblems(args, selected.parameters);
        if (selected != null && problems.length > 0) {
          const repaired = await repairToolCall(options, endpoint, apiKey, messages, selected, call, problems);
          if (repaired !== undefined) args = repaired;
        }
        yield { type: "tool-call", toolCallId: call.id, toolName: call.name, args };
      }
      yield { type: "done", text, usage };
      return;
    }
    messages = [
      ...messages,
      { role: "assistant", content: stepText.length === 0 ? null : stepText, tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) },
      ...await executeToolCalls(calls, toolsByName, options.executeTool),
    ];
  }
  throw new Error(`The OpenAI-compatible endpoint exceeded Titanium Bot's ${maxSteps}-step tool limit.`);
}
