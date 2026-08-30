# Reader output: w1:provider-entry

## Scope

Read end to end: `source/host/extensions/inference/provider-session.ts` (521 lines), `source/host/extensions/inference/openai-compatible-chat.ts` (357 lines), `source/host/extensions/inference/extension.ts` (52 lines). References chased out of them (not read end to end): `packages/chat-inference/base.ts`, `host/host-gateway-api.ts` (150-200), `node-agent-coordinator/inference-router.ts` (160-200), `host/runner/system-prompt.ts` (head + exports).

## 1. The instructions channel — `own`

`conversationInput` (provider-session.ts:127-155) is the single place instructions are chosen. `own` = flattened text of every message whose *normalized* role is `"system"` and whose text is non-blank after trim (`:135`), joined with `"\n\n"`. Normalization (`:129-131`) promotes only literal `role === "system"`; everything unrecognized collapses to `"user"`. Flattening (`:92-125`) reads a string content directly, or an array of parts taking only `part.text`.

Fallback (`:153`): empty `own` → `GROK_AGENT_SYSTEM_PROMPT` (5 lines, `:47-53`) when `hasSendMessage`, else `GROK_ROUTER_SYSTEM_PROMPT` (`:55-60`). `hasSendMessage` is computed from the **tool list**, not the conversation: `(tools ?? []).some(t => t.name === "SendMessage")` (`:309` codex, `:445` openai-compatible). With `definitions` undefined, `tools` is undefined and the ROUTER prompt wins — the one that tells the model to "respond directly to the user in natural language," which the file's own comment (`:62-71`) identifies as the silence bug.

**To get the 281-line prompt in**: the runner must put it in the executor's message array as `{role: "system", content: <string>}` (or parts with `.text`). The array comes only from `BasePromptBuilder` — the `state` argument of `getExecutor` (`:494`, only if `Array.isArray`) or `appendMessages` (base.ts:8-11, :19). No systemPromptGenerator, profile, or assembly output is consulted anywhere in these three files. The 281-line prompt is `source/host/runner/system-prompt.ts` (exactly 281 lines; `DEFAULT_SAND_SYSTEM_PROMPT` at :267), which `host-runner-composition.ts:2523` exposes as a `systemPromptGenerator` callback — a shape that does **not** by itself become a system-role message.

Two additional traps in the same path:
- `flattenParts` checks `part.text` **before** `part.type === "tool-call"` (`:104-112`), so a tool-call part carrying a text field is converted to prose and its call is lost.
- `conversationInput` is called twice per request (`:309`/`:310`, `:445`/`:446`), re-running the whole map/flatten. Behavior is identical (only `.input` is used from the second call) but the work is duplicated.

## 2. Tool definitions: receipt → transform → wire

Received as `definitions?: readonly Loose[]`, the third positional arg of `stream` (`:480`) — the `tools` slot the chat-inference middleware chain forwards (tracing-middleware.ts:119, image-resizing-middleware.ts:130) — or as `options.tools` on `runRoutedProviderText` (`:499`).

`withJsonSchemaParameters` (`:416-434`) is declared **inside** `openAiCompatibleExecutor`'s body, between its `deferred()` setup and its use at `:436`. Per definition: null schema → unchanged (`:420`); AI-SDK `jsonSchema()` wrapper → unwrap `.jsonSchema`, strip, emit `{...def, inputSchema: undefined, parameters: stripped}` (`:426-428`); Zod (`safeParse` fn or `_def !== undefined`) → `zodToJsonSchema` then strip (`:429-431`); conversion throw → **silently unchanged** (`:432`). `stripSchemaArtifacts` (`:407-414`) recursively deletes `$schema`, `default`, `definitions`, `markdownDescription`, `additionalProperties`.

This transform is **openai-compatible only**. `codexTools` (`:279-291`) and `toToolSet` (`:356-371`) take `inputSchema ?? parameters` raw — a Zod schema handed to codex or openrouter is not converted here.

Forwarding: `openAiCompatibleTools` (openai-compatible-chat.ts:77-89) → `{name, description?, parameters, source}` with `source` preserving the original definition (this is what carries `providerIdentifier`/`toolName` back to the MCP executor); `requestTools` (`:249-252`) → OpenAI function shape; body sends `tools` + `tool_choice: "auto"` (`:292`).

**Filtering**: structural only. A definition is dropped iff `name` is not a non-empty string, or `inputSchema ?? parameters` is null — openai-compatible-chat.ts:81, provider-session.ts:283, provider-session.ts:360-362. Total drop yields `undefined` (not `[]`), which collapses `maxSteps` 8→1 (`:313`, `:449`) and omits `tools`/`tool_choice` entirely. **There is no name-based allow/deny list in any of the three files.** SendMessage is only ever *detected* (`:309`, `:445`), never removed.

## 3. executeTool and the runner/provider split

Two layers. The host-level `RoutedToolExecutor` (`:24`) is a module global set by `setHostRoutedToolExecutor` (`:33-39`); the only registration read is host-gateway-api.ts:170-177, forwarding `{providerIdentifier, name, toolName, args, toolCallId}` to `executeRoutedMcpTool`, which runs the call through the mcp extension's executor (host-gateway-api.ts:154-164). The transport-level `options.executeTool` (openai-compatible-chat.ts:41) is invoked by `executeToolCalls` (`:254-267`) — sequential, and every outcome becomes a `{role:"tool", tool_call_id, name, content}` message: unknown name → isError (`:259`), unparsable args → isError (`:262`), success/throw → safeJson (`:263-264`). The bridge between layers is `:448` (and `:312`): `executeTool(selected.source, args, toolCallId)` — unwrapping to the original definition.

Per-provider dispatch in `stream` (`:480-489`, `execute = hostRoutedToolExecutor` at `:481`):

| provider | executor passed | who runs tools | steps |
|---|---|---|---|
| openai-compatible | **`undefined`** (`:487`) | **RUNNER** | 1 transport step, calls surfaced |
| codex | `execute` (`:482`, `:312`) | provider loop | 8 (`:313`) |
| openrouter | `execute` (`:488`, via `:367`) | provider loop | 8 (`:377`) |
| claude-code | none, and no definitions (`:483`) | nobody — `tools: []`, `maxTurns: 1` (`:340`) | 1 |

On the openai-compatible path the transport takes the no-executor branch (openai-compatible-chat.ts:331-348): repair-if-invalid, yield one `tool-call` per call, yield `done`, **return after one step**. provider-session.ts:455-464 then re-emits each as `tool-call-streaming-start` → `tool-call-delta` (full args text) → `tool-call`, because the runner dispatches on first sight and would otherwise run with `{}`. So the runner executes everything here, SendMessage included — which is exactly what the comments at `:452-454` and `:484-486` say is required for the turn to have a voice.

When the provider *does* own the loop (openai-compatible-chat.ts:350-356) it appends the assistant `tool_calls` message plus tool results and iterates, throwing an explicit step-limit error at `maxSteps`.

`runRoutedProviderText` (`:497-511`) is the separate one-shot entry; the caller supplies `executeTool` (inference-router.ts:174-181 passes a `dispatchRemote("executeRoutedMcpTool")` closure). **It consumes only `text-delta` (`:513-518`)** — a caller that omits `executeTool` there loses every tool call silently.

## 4. Argument repair (local-model workaround)

`schemaProblems` (openai-compatible-chat.ts:102-119) checks only a top-level object schema: missing/blank required properties, and keys not in `properties`. It returns clean when either side is not a plain object — so nested-schema violations are invisible. On problems, `repairToolCall` (`:121-165`) re-asks non-streamed with **only the offending tool** declared plus an injected isError tool message quoting the schema (`:130-144`); a still-invalid repair returns `undefined` and the original args pass through unchanged (`:341-344`), keeping the failure visible.

## 5. extension.ts

Effectively a type file plus one line. All runtime is `:52`: `isReady` = mock env set, OR provider !== "cursor", OR an access token exists; `port` = `context.createPort(notify)`; plus web-search/web-fetch pass-throughs and a model-experiment listener set. Nothing on the prompt or tool path.

**Q: In conversationInput, what exactly lands in `own` (the instructions), and what would the runner have to send for the real 281-line prompt to be used instead of GROK_AGENT_SYSTEM_PROMPT?**

`own` is the list of flattened text bodies of every message whose NORMALIZED role is exactly "system" and whose flattened text is non-blank after trim; those bodies are joined with "\n\n" to become `instructions`. Role normalization (provider-session.ts:129-131) maps only `message.role === "system"` to "system" — everything that is not assistant/system/tool becomes "user". Flattening (provider-session.ts:92-125) accepts a plain string, or an array of parts from which it takes only `part.text` strings; a system message whose parts carry no `.text` flattens to "" and is dropped by the `.trim().length > 0` guard at provider-session.ts:135.

Fallback (provider-session.ts:153): if `own.length === 0`, instructions become GROK_AGENT_SYSTEM_PROMPT (5 lines, provider-session.ts:47-53) when `hasSendMessage` is true, otherwise GROK_ROUTER_SYSTEM_PROMPT (provider-session.ts:55-60). `hasSendMessage` is not derived from the conversation at all — it is computed at the call sites from the TOOL list: `(tools ?? []).some(tool => tool.name === "SendMessage")` (provider-session.ts:309 for codex, provider-session.ts:445 for openai-compatible).

For the real 281-line prompt to be used, the runner must place it in the executor's message array as a message with `role: "system"` whose content is a string (or parts array with a non-empty `.text`). The executor's messages come only from `BasePromptBuilder` — either the `state` seeded via `getExecutor(state)` (provider-session.ts:494, base.ts:5-7) or `appendMessages` (base.ts:8-11, base.ts:19). So concretely: `executor.appendMessages({ role: "system", content: DEFAULT_SAND_SYSTEM_PROMPT })`, or include that message in the array passed as `state`. Nothing in these three files reads a systemPromptGenerator, a profile, or any prompt-assembly output — the ONLY channel is a system-role message in the message array. The 281-line prompt is source/host/runner/system-prompt.ts (exactly 281 lines; DEFAULT_SAND_SYSTEM_PROMPT exported at line 267), and host-runner-composition.ts:2523 wires it as `systemPromptGenerator`, but whether that generator's output ever becomes a system-role ProviderMessage is NOT established by these files.

Secondary detail: if multiple system messages are present they are ALL concatenated, in order, with a blank line between (provider-session.ts:135, 153). System messages are then excluded from `input` (provider-session.ts:139) so they appear once, as the leading system message the transport builds (openai-compatible-chat.ts:275).

*Evidence:* provider-session.ts:127-155 (conversationInput), :135 (own filter), :153 (fallback ternary), :47-53 (GROK_AGENT_SYSTEM_PROMPT), :55-60 (GROK_ROUTER_SYSTEM_PROMPT), :309 and :445 (hasSendMessage from tools), :92-125 (flattenParts), :479/:494 (builder seeding); base.ts:5-11,19; system-prompt.ts:267 + 281-line file length; host-runner-composition.ts:2523


**Q: How are tool definitions received, transformed (withJsonSchemaParameters), and forwarded — and is any tool filtered out on this path?**

RECEIVED: as `definitions?: readonly Loose[]` — the third positional argument to `ProviderPromptExecutor.stream(_ctx, invocationId, definitions)` (provider-session.ts:480), which is the `tools` slot the chat-inference middleware chain passes through (chat-inference/middleware/tracing-middleware.ts:119, image-resizing-middleware.ts:130). On the one-shot path they arrive as `options.tools` of runRoutedProviderText (provider-session.ts:499). Each definition is a loose record; the code reads `name`, `description`, and `inputSchema ?? parameters`, and downstream consumers also read `providerIdentifier` and `toolName` (host-gateway-api.ts:172-174).

TRANSFORMED (openai-compatible only) by withJsonSchemaParameters (provider-session.ts:416-434), a function DECLARED INSIDE the body of openAiCompatibleExecutor (between its deferred() setup at :393-396 and its use at :436): for each definition it takes `inputSchema ?? parameters`; null → returned unchanged (:420); an AI-SDK `jsonSchema()` wrapper (has `.jsonSchema`) → unwrapped, stripped, returned as `{...definition, inputSchema: undefined, parameters: stripped}` (:426-428); a Zod schema (has `safeParse` function or `_def !== undefined`) → `zodToJsonSchema()` then stripped, same shape (:429-431); a thrown conversion → definition returned unchanged (:432). stripSchemaArtifacts (provider-session.ts:407-414) recursively deletes `$schema`, `default`, `definitions`, `markdownDescription`, and `additionalProperties` at every level.

FORWARDED: `openAiCompatibleTools(withJsonSchemaParameters(definitions))` (provider-session.ts:436) → openai-compatible-chat.ts:77-89 builds `{name, description?, parameters, source}` keeping the ORIGINAL definition as `source`; requestTools (openai-compatible-chat.ts:249-252) wraps each into `{type:"function", function:{name, description?, parameters}}`; the request body sends `tools` plus `tool_choice: "auto"` (openai-compatible-chat.ts:292). Codex uses the parallel codexTools (provider-session.ts:279-291) — note codex does NOT go through withJsonSchemaParameters. OpenRouter uses toToolSet (provider-session.ts:356-371) wrapping parameters in the AI SDK's `jsonSchema()` — also NOT through withJsonSchemaParameters.

FILTERED: only structurally, never by name. A definition is dropped iff `name` is not a non-empty string, or `inputSchema ?? parameters` is null — openai-compatible-chat.ts:80-86, and identically toToolSet (provider-session.ts:360-362) and codexTools (provider-session.ts:283). If everything is dropped the result is `undefined` rather than an empty list (openai-compatible-chat.ts:88, provider-session.ts:290, :370), and `tools == null` collapses maxSteps to 1 (provider-session.ts:313, :449) and omits the `tools`/`tool_choice` keys entirely (openai-compatible-chat.ts:273, :292). There is NO allow-list, deny-list, or name-based exclusion in any of the three files; SendMessage is only ever DETECTED (provider-session.ts:309, :445), never removed.

*Evidence:* provider-session.ts:480, :499, :416-434, :407-414, :436, :279-291, :356-371, :313, :449, :309, :445; openai-compatible-chat.ts:77-89, :249-252, :273, :292; host-gateway-api.ts:172-174; chat-inference/middleware/tracing-middleware.ts:119


**Q: What does executeTool do with a tool call, and which tools does the RUNNER execute vs the provider loop?**

WHAT executeTool DOES. Two layers. (1) The host-level RoutedToolExecutor type `(tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>` (provider-session.ts:24) lives in a module-global `hostRoutedToolExecutor` set by setHostRoutedToolExecutor (provider-session.ts:33-39); the only registration read is host-gateway-api.ts:170-177, which forwards `{providerIdentifier, name, toolName, args, toolCallId}` to executeRoutedMcpTool — i.e. it runs MCP tools through the mcp extension's executor (host-gateway-api.ts:154-164). (2) Inside the transport, `options.executeTool` (openai-compatible-chat.ts:41) is invoked by executeToolCalls (openai-compatible-chat.ts:254-267), which runs calls SEQUENTIALLY and always produces a `{role:"tool", tool_call_id, name, content}` message: unknown tool name → `{isError:true, error:"Unknown Grok Bot tool: …"}` (:259); unparsable arguments → `{isError:true, error:"Tool arguments were not valid JSON."}` (:262); success or thrown error → safeJson of the result / the error message (:263-264). The adapter between the two is provider-session.ts:448 (and :312 for codex): `async (selected, args, toolCallId) => executeTool(selected.source, args, toolCallId)` — it unwraps back to the ORIGINAL definition so providerIdentifier/toolName survive.

WHO EXECUTES. Decided per provider in ProviderPromptExecutor.stream (provider-session.ts:480-489) where `execute = hostRoutedToolExecutor` (:481):
- openai-compatible → executeTool is explicitly `undefined` (provider-session.ts:487, with the comment at :484-486 stating tool calls belong to the runner). The provider loop therefore takes the no-executor branch (openai-compatible-chat.ts:331-348): it optionally repairs bad arguments, yields a `tool-call` event per call, yields `done`, and RETURNS after a single step. provider-session.ts:455-464 then re-emits each such event as the three-chunk streaming sequence (`tool-call-streaming-start`, `tool-call-delta` carrying the full args text, `tool-call`) because the runner starts a tool as soon as it sees the call. So on this path the RUNNER executes every tool, SendMessage included.
- codex → gets `execute` (provider-session.ts:482, :312) — the PROVIDER loop executes, up to maxSteps 8 (:313).
- openrouter → gets `execute` (provider-session.ts:488) via toToolSet's `routedTool.execute` (:367) — PROVIDER loop executes, maxSteps 8 (:377).
- claude-code → passed NEITHER definitions NOR an executor (provider-session.ts:483); claudeExecutor with `mcpServerUrl == null` sets `tools: []` and `maxTurns: 1` (:340), so no tools run at all on that path.

On the separate one-shot entry point runRoutedProviderText (provider-session.ts:497-511) the caller supplies executeTool — node-agent-coordinator/inference-router.ts:174-181 passes a dispatchRemote→executeRoutedMcpTool closure — so there the PROVIDER loop executes. Note that runRoutedProviderText consumes only `text-delta` events (provider-session.ts:513-518); any `tool-call` event is silently discarded, so a caller that omits executeTool on that path loses the calls.

LOOP MECHANICS when the provider does execute (openai-compatible-chat.ts:279-356): each step POSTs, merges fragmented tool_call deltas by index (:230-243, :322), and if there are no calls yields `done` and returns (:326-330); otherwise it appends the assistant message with `tool_calls` plus the tool result messages and iterates (:350-354), throwing `exceeded Grok Bot's N-step tool limit` if maxSteps is reached (:356).

*Evidence:* provider-session.ts:24, :33-39, :312, :448, :455-464, :480-489, :484-487, :340, :367, :377, :497-511, :513-518; openai-compatible-chat.ts:41, :254-267, :279-356, :331-348, :350-354, :356; host-gateway-api.ts:154-164, :170-177; node-agent-coordinator/inference-router.ts:172-183


## Claims

- conversationInput's `own` collects the flattened text of every message whose normalized role is "system" and whose text is non-blank after trim, and joins them with a blank line.  
  `source/host/extensions/inference/provider-session.ts:135`
- When no system message survives that filter, instructions fall back to GROK_AGENT_SYSTEM_PROMPT if hasSendMessage is true, else GROK_ROUTER_SYSTEM_PROMPT.  
  `source/host/extensions/inference/provider-session.ts:153`
- GROK_AGENT_SYSTEM_PROMPT is a 5-element string array joined with newlines — 5 lines of text total.  
  `source/host/extensions/inference/provider-session.ts:47-53`
- Only `message.role === "system"` normalizes to "system"; assistant and tool map to themselves and every other role collapses to "user".  
  `source/host/extensions/inference/provider-session.ts:129-131`
- flattenParts extracts text only from a string content or from array parts carrying a non-empty string `.text`; a system message made only of non-text parts flattens to "" and is therefore dropped from `own`.  
  `source/host/extensions/inference/provider-session.ts:92-125`
- flattenParts checks `part.text` BEFORE checking `part.type === "tool-call"`, so a tool-call part that also carries a non-empty string `text` field is turned into assistant text and its tool call is lost.  
  `source/host/extensions/inference/provider-session.ts:104-112`
- System messages are skipped when building `input`, so they reach the model only through the `instructions` string.  
  `source/host/extensions/inference/provider-session.ts:139`
- conversationInput drops any tool-result message whose tool_call_id does not match a tool call present in the assembled input.  
  `source/host/extensions/inference/provider-session.ts:149-150`
- `hasSendMessage` is derived from the TOOL list (a tool literally named "SendMessage"), not from the conversation.  
  `source/host/extensions/inference/provider-session.ts:309`
- conversationInput is invoked twice per request — once for instructions and once for input — duplicating the whole mapping/flattening pass; the second call omits hasSendMessage but only its `.input` is used, so behavior is unchanged.  
  `source/host/extensions/inference/provider-session.ts:445-446`
- The executor's message list originates solely from BasePromptBuilder — seeded by the `state` argument of getExecutor or grown via appendMessages.  
  `source/host/extensions/inference/provider-session.ts:479`
- createProviderPromptSession seeds the executor with `state` only when it is an Array, otherwise the builder starts empty.  
  `source/host/extensions/inference/provider-session.ts:494`
- BasePromptBuilder accepts any message shape and appendMessages does no role validation, so a `{role:"system", content:<prompt>}` message is sufficient to reach `own`.  
  `source/packages/chat-inference/base.ts:5-11`
- The 281-line prompt referenced by the audit is source/host/runner/system-prompt.ts, which exports DEFAULT_SAND_SYSTEM_PROMPT built by buildSandBaseSystemPrompt.  
  `source/host/runner/system-prompt.ts:267`
- host-runner-composition wires DEFAULT_SAND_SYSTEM_PROMPT behind a `systemPromptGenerator` callback, not as a system-role message.  
  `source/host/host-runner-composition.ts:2523`
- Tool definitions reach the provider as the third positional argument `definitions` of ProviderPromptExecutor.stream.  
  `source/host/extensions/inference/provider-session.ts:480`
- withJsonSchemaParameters is declared inside the body of openAiCompatibleExecutor, after that function's deferred() setup and before its `tools` assignment.  
  `source/host/extensions/inference/provider-session.ts:416-434`
- withJsonSchemaParameters unwraps an AI-SDK jsonSchema() wrapper by reading `.jsonSchema`, then sets inputSchema to undefined and parameters to the stripped schema.  
  `source/host/extensions/inference/provider-session.ts:426-428`
- withJsonSchemaParameters detects Zod by `typeof candidate.safeParse === "function" || candidate._def !== undefined` and converts with zodToJsonSchema; a non-Zod, non-wrapper schema is returned unchanged.  
  `source/host/extensions/inference/provider-session.ts:429-431`
- A zodToJsonSchema conversion failure is swallowed and the original definition is forwarded unconverted.  
  `source/host/extensions/inference/provider-session.ts:431-432`
- stripSchemaArtifacts recursively removes $schema, default, definitions, markdownDescription and additionalProperties from the schema.  
  `source/host/extensions/inference/provider-session.ts:407-414`
- Only the openai-compatible path runs withJsonSchemaParameters; codexTools and toToolSet consume `inputSchema ?? parameters` raw.  
  `source/host/extensions/inference/provider-session.ts:436`
- openAiCompatibleTools drops a definition only when its name is not a non-empty string or `inputSchema ?? parameters` is null, and preserves the original definition as `source`.  
  `source/host/extensions/inference/openai-compatible-chat.ts:79-87`
- toToolSet applies the same two structural drops (missing name, missing parameters) and no name-based filter.  
  `source/host/extensions/inference/provider-session.ts:359-362`
- codexTools applies the same two structural drops and no name-based filter.  
  `source/host/extensions/inference/provider-session.ts:281-289`
- When every definition is dropped, the tool builders return undefined rather than an empty array, which collapses maxSteps from 8 to 1.  
  `source/host/extensions/inference/provider-session.ts:449`
- requestTools emits standard OpenAI function-tool shape and the request sends tool_choice "auto" whenever tools exist.  
  `source/host/extensions/inference/openai-compatible-chat.ts:249-252`
- The transport builds its message list as a leading `{role:"system", content: instructions}` followed by shallow copies of the input messages.  
  `source/host/extensions/inference/openai-compatible-chat.ts:275`
- The transport disables reasoning by default via `chat_template_kwargs: {enable_thinking:false}` unless SAND_OPENAI_COMPATIBLE_THINKING is "1".  
  `source/host/extensions/inference/openai-compatible-chat.ts:295-297`
- RoutedToolExecutor is typed `(tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>` and is held in a module-global set by setHostRoutedToolExecutor.  
  `source/host/extensions/inference/provider-session.ts:24`
- The only registration of the host routed tool executor forwards providerIdentifier/name/toolName/args/toolCallId to executeRoutedMcpTool, which runs the call through the mcp extension's executor.  
  `source/host/host-gateway-api.ts:170-177`
- The executeTool adapter passes `selected.source` — the original definition — so providerIdentifier and toolName survive the transform.  
  `source/host/extensions/inference/provider-session.ts:448`
- For provider "openai-compatible" the ProviderPromptExecutor deliberately passes `undefined` as the executor, so the runner owns the tool loop.  
  `source/host/extensions/inference/provider-session.ts:487`
- codex and openrouter both receive the host routed tool executor, so their provider loops execute tool calls in-process.  
  `source/host/extensions/inference/provider-session.ts:482-488`
- claude-code is called with neither definitions nor an executor from ProviderPromptExecutor.stream.  
  `source/host/extensions/inference/provider-session.ts:483`
- claudeExecutor with no mcpServerUrl passes `tools: []` and `maxTurns: 1` to the Claude Agent SDK, so no tools can run on that path.  
  `source/host/extensions/inference/provider-session.ts:340`
- When options.executeTool is null the transport repairs bad arguments, yields one tool-call event per call, yields done, and returns after a single step rather than continuing the loop.  
  `source/host/extensions/inference/openai-compatible-chat.ts:331-348`
- provider-session re-emits each transport tool-call as tool-call-streaming-start, tool-call-delta carrying the full argument text, then tool-call, because the runner dispatches on first sight of a call.  
  `source/host/extensions/inference/provider-session.ts:455-464`
- executeToolCalls runs calls sequentially and converts unknown tool names, invalid JSON arguments, and thrown errors into isError tool-result messages rather than aborting the turn.  
  `source/host/extensions/inference/openai-compatible-chat.ts:254-267`
- When the provider loop does execute, it appends the assistant message with tool_calls plus the tool results and iterates, throwing an explicit step-limit error at maxSteps.  
  `source/host/extensions/inference/openai-compatible-chat.ts:350-356`
- Argument repair fires only when the tool is known and schemaProblems reports missing required properties or undeclared properties; a still-invalid repair is passed through unchanged.  
  `source/host/extensions/inference/openai-compatible-chat.ts:340-344`
- schemaProblems only inspects a top-level object schema's `properties` and `required`; it returns no problems when either the args or the schema is not a plain object.  
  `source/host/extensions/inference/openai-compatible-chat.ts:102-119`
- repairToolCall re-asks the endpoint non-streamed with ONLY the offending tool declared and an injected isError tool message quoting the schema.  
  `source/host/extensions/inference/openai-compatible-chat.ts:130-144`
- runRoutedProviderText consumes only text-delta events from the stream; tool-call events are discarded.  
  `source/host/extensions/inference/provider-session.ts:513-518`
- The coordinator's inference-router supplies its own executeTool to runRoutedProviderText via dispatchRemote("executeRoutedMcpTool"), so on that path the provider loop executes tools.  
  `source/node-agent-coordinator/inference-router.ts:172-183`
- resolveOpenAiCompatibleSettings requires a model name and throws if SAND_OPENAI_COMPATIBLE_MODEL resolves empty from both env and persisted secrets.  
  `source/host/extensions/inference/openai-compatible-chat.ts:59-60`
- The default OpenAI-compatible base URL is http://127.0.0.1:11434/v1 and the endpoint resolver accepts a root, a /v1 root, or a full completions URL.  
  `source/host/extensions/inference/openai-compatible-chat.ts:66-75`
- Secrets are read from the box secrets store file and only string values are kept; any read/parse failure yields an empty map.  
  `source/host/extensions/inference/provider-session.ts:161-169`
- inferenceExtension.isReady returns true when SAND_AGENT_MOCK_RESPONSE is set, or the configured provider is not "cursor", or an access token is present.  
  `source/host/extensions/inference/extension.ts:52`
- extension.ts's entire runtime is a single 1-line export at line 52; the rest of the file is type declarations and one pass-through helper.  
  `source/host/extensions/inference/extension.ts:44-52`

## Did not verify

- Whether the runner ever appends a `{role:"system", ...}` message carrying DEFAULT_SAND_SYSTEM_PROMPT to this executor. host-runner-composition.ts:2523 wires it as a `systemPromptGenerator` callback, but I did not read turn-run-shell.ts, host-runner-composition.ts, production-turn-agent-owner.ts, or turn-agent-composition.ts end to end, so I cannot say whether that generator's output reaches the ProviderMessage array.
- The actual content of the 281-line system prompt beyond its file length, its exports (buildSandBaseSystemPrompt at :77, DEFAULT_SAND_SYSTEM_PROMPT at :267), and the first ~60 lines I sampled.
- Whether the runner's registered tool is literally named "SendMessage" at the point `definitions` are built — the hasSendMessage check is an exact string match, but the registration site was not read.
- What the runner's tool-stream-executor does with the re-emitted tool-call triad, and whether it in fact executes SendMessage. The comments at provider-session.ts:452-454 and :484-486 assert this; the consuming code was not read.
- Whether streamCodexDirectResponses (codex-direct-responses.ts) applies any further tool filtering or schema conversion; only its call site was read.
- Whether setHostRoutedToolExecutor is actually invoked in every process that constructs a ProviderPromptExecutor. host-gateway-api.ts:170 is the only registration I found, but I read only lines 150-200 of that file and did not confirm the surrounding function always runs.
- Whether `stream` is ever called with a non-undefined `definitions` on the openai-compatible path in practice — only middleware signatures (tracing-middleware.ts:119, image-resizing-middleware.ts:130) were confirmed to forward a third `tools` argument.
- Runtime behavior of any kind: nothing was executed, no request was made, no test was run. All claims are static reads.
- Whether zodToJsonSchema conversion actually succeeds for SendMessage's `objectSchema.superRefine(...)` schema described in the comment at provider-session.ts:398-402 — the catch at :432 silently falls back and I cannot observe which branch fires.
- Whether any tool filtering happens UPSTREAM of these files (e.g. in listRoutedMcpTools at host-gateway-api.ts:145-152, or in the agent toolset construction). I verified no filtering inside the three files only.