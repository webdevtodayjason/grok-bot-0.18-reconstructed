# Reader output: w2:tools-voicebb

EVIDENCE-GRADE READ — 9 files read end to end (all lines). References chased out with grep only.
Repo root: /Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb

=== A. FILE-BY-FILE FACTS ===

--- mcp-meta-tools.ts (151 lines) — NO tools defined here ---
1. Despite the name, this file defines zero model-facing tools. It holds: a timeout helper, a streaming-tool timeout wrapper, and a plain-object MCP descriptor builder (mcp-meta-tools.ts:6-151).
2. `sandToolCallExecutionTimeoutMs(toolName, isComputerUseSubagent)` returns `toolCallExecutionGuardMs(isComputerUseSubagent ? "subagent" : toolName, undefined)` (mcp-meta-tools.ts:6-11). Every tool in a computer-use subagent is therefore timed under the literal tier name "subagent", not its own name.
3. The second arg to `toolCallExecutionGuardMs` is hardcoded `undefined` (mcp-meta-tools.ts:10). In tool-execution-timeout.ts:41-48 that arg is what `parseBlockUntilMs(args)` reads, so the block_until_ms grace branch (line 44-47) can never fire through this path; every tool gets the flat `tierMs - TOOL_CALL_GUARD_HEADROOM_MS`. buildTurnTools uses exactly this helper for all non-dynamic tools (turn-toolset.ts:1543-1547).
4. `SandToolCallExecutionTimeoutError` renames itself to "ToolCallExecutionTimeoutError" via `override readonly name` (mcp-meta-tools.ts:13-21) — the class name and the reported name differ deliberately.
5. `wrapDynamicInvocationToolWithTimeout` (mcp-meta-tools.ts:56-92) fully drains the argument stream into a string BEFORE calling the wrapped tool (`for await ... rawArguments += chunk`, line 76), resolves the real tool name through `dynamicToolRegistry.resolveToolName(rawArguments)` (line 77), then replays the args as a single-chunk async generator (lines 82-84). Consequence, from the code: streaming is destroyed for dynamic-dispatch invocation tools — the wrapped tool always sees one chunk, and the timeout clock starts only after the model finished emitting arguments.
6. `withTimeout` (37-54) uses Promise.race + `timer.unref?.()`; it does NOT cancel the underlying operation on timeout — it only rejects the race (lines 44-53).
7. `createSandMcpMetaToolOptions` (mcp-meta-tools.ts:121-151) builds `{enabled:true, mcpDescriptors:[...]}` grouping tools by `providerIdentifier`, setting `serverName` = `providerIdentifier` (line 128), and sorting each server's tools by toolName (line 148). VERIFIED DEAD: repo-wide grep for `createSandMcpMetaToolOptions` returns exactly one hit, its own definition (mcp-meta-tools.ts:121). turn-toolset.ts imports only `sandToolCallExecutionTimeoutMs`, `wrapDynamicInvocationToolWithTimeout`, and `type McpToolForMeta` from this module (turn-toolset.ts:34-38) and reimplements the same grouping against proto classes as `asGeneratedMcpMetaToolOptions` (turn-toolset.ts:812-847). Two parallel implementations of the same grouping exist; only the proto one is live.

--- mcp-server-resolution.ts (5 lines, minified) ---
8. `resolveMcpServerRowsByIdentifierOrLegacyId` matches `serverIdentifier === token` first and only falls back to `id === token` when the identifier match is empty (line 2). Empty/whitespace token returns `[]` (line 2).
9. `readMcpInstalledListing` swallows every error into `{kind:"unreadable"}` (line 4) — a listing failure is indistinguishable from an empty listing to callers except via the kind tag.

--- sand-permission-request.ts (6 lines) — RETIRED SURFACE ---
10. The whole module is one function: `summarizePermissionRequest` returns "Legacy permission request (no longer actionable): {title} — {reason}" (sand-permission-request.ts:1-6).
11. There is NO permission-request tool and no agent-facing schema for it: `SEND_MESSAGE_TYPES` is `["text","attachment","widget","cursor-agent","secret-request"]` (send-message-schema.ts:3) — "permission-request" is absent. The only producer path is the encoder branch `case "permission-request"` (send-message-encoding.ts:34), reachable only for a message that already exists in a transcript.
12. Frontend confirms retirement: the leaf is `variant: "retired"`, wrapperClassName "sand-permission-request-wrap", and the comment states "this leaf deliberately has no bridge or action" (frontend/src/recovered/features/conversation/cards/permission-request/view.tsx:7-14). Shaping still carries it (send-message-shaping.ts:183-188), so old transcripts render, but nothing new can be created by the model.

--- sand-secret-request.ts (5 lines, minified) — THE SECRET CARD MECHANISM ---
13. Module exports only clamps + two strings: `SECRET_REQUEST_MAX_LABEL_LENGTH=120`, `SECRET_REQUEST_MAX_DESCRIPTION_LENGTH=400`, `clampSecretLabel` (clampLine, 120), `clampSecretDescription` (clampBlock, 400) (sand-secret-request.ts:1-2). NOTE: the clamp helpers hardcode 120/400 rather than referencing the exported constants (line 2) — the constants and the enforced limits are separately maintained.
14. There is NO RequestSecret tool. The secret card is produced entirely through SendMessage: `{"type":"secret-request","secret":{label,description?,connector,field}}` (send-message-schema.ts:46-51). buildSandSendMessage rewrites it into the internal shape `{type:"secret-request", secretRequest:{label:clampSecretLabel(...), description?:clampSecretDescription(...), target:{kind:"channel-credential", platform:secret.connector, field:secret.field}}}` (send-message-tool.ts:44). `target.kind` is hardcoded to "channel-credential" — the tool surface cannot address any other target kind.
15. Turn-ending is enforced in the runner, not the tool: on a send-message update whose message.type is "widget" | "secret-request" | "auto-review-approval", the runner sets `active.awaitingUserSelection = true; this.#awaitingUserSelection = true` (sand-agent-runner.ts:1100-1109).
16. Model-visible transcript text for a sent secret request is only `summarizeSecretRequest` = "Requested a secret from the user securely: {label}" (sand-secret-request.ts:3, wired at send-message-encoding.ts:33). The value never appears.
17. Submission path (host side): `submitSecret(entryId, value, agentId)` re-validates that the transcript entry is kind "send-message", message.type "secret-request", and not already `secretProvided` (widget-responses.ts:355-372); routes via `routeSecret` which refuses any `target.kind !== "channel-credential"` and calls `sessionStore.storeConnectorCredential(agentId, target.platform, target.field, value)` (widget-responses.ts:394-405); marks the entry `secretProvided:true` in roster + db (widget-responses.ts:381-387); then resumes the agent with a HIDDEN prompt built by `buildSecretProvidedAck` (widget-responses.ts:388-392).
18. `buildSecretProvidedAck` (sand-secret-request.ts:4) is the exact resumption text: "[The user securely provided the requested secret: \"{label}\". It was written straight to its destination ({target.kind}); you never see the value and it is not in this conversation.]" + "Confirm to the user that it is set, then continue. For a connector credential, the connection links within a few seconds, so you can check and report its status." Note it interpolates `target.kind` (always the literal "channel-credential"), not a human name.
19. Empty/whitespace-only submissions are silently dropped with no user feedback and no agent resume: `if (trimmed.length === 0) return;` (widget-responses.ts:361-362). A failed credential write pushes a tray error and returns WITHOUT resuming the agent (widget-responses.ts:374-380) — the agent stays parked awaiting user selection.

--- sand-reaction-tool.ts (43 lines) ---
20. Tool name `ReactToMessage`, tool id `SEND_TO_USER` (sand-reaction-tool.ts:6, 25-26). It shares the SEND_TO_USER client-side tool id with SendMessage's family (proto: tools_pb.ts:80 `"SEND_TO_USER": 65`).
21. Parameters: `message_address` (trimmed, min 1) and `emoji` (trimmed, min 1, MAX 16 chars) (sand-reaction-tool.ts:8-15). The 16-char cap is the only content validation — any string ≤16 chars passes; there is no emoji check.
22. Address validation is `isMessageAddress(address)` and on failure returns a plain error string, not a throw (sand-reaction-tool.ts:34-37).
23. Fire-and-forget by construction: `resolved.react(...)` returns void (interface at :17-19) and the tool immediately returns "Reacted {emoji} on {address}. (Reactions toggle: ...)" (line 40). The tool cannot observe whether the reaction landed. The runner separately tracks success out-of-band: `active.reacted = true` only when `transport.lastReactionApplied?.() === true` (sand-agent-runner.ts:1117-1123).
24. Wiring: composition supplies `react: args => turn.emitUpdate?.({type:"react-to-message", ...args})` (host-runner-composition.ts:2049-2055); a second emit site exists at host-runner-composition.ts:1826 (`hooks.transport.onUpdate({type:"react-to-message", ...args})`).
25. ReactToMessage is in `SAND_FORCED_STATIC_TOOL_NAMES` alongside UpdateState (turn-toolset.ts:161-164), so it is never hidden behind dynamic-tool placement.

--- box-help-tool.ts (116 lines) ---
26. Tool name `request_box_help` (lowercase, unlike every other tool here), id `REQUEST_BOX_HELP` (box-help-tool.ts:77-78). Registered async in the tool inventory (packages/agent/tools/all-tools.ts:99 `REQUEST_BOX_HELP: "async"`).
27. Params: `instruction` (required, min 1), `reason` enum auth|captcha|payment|other (optional, `.catch(undefined)`), `domain`, `idp_domain` (optional, `.catch(undefined)`) (box-help-tool.ts:6-22). `.catch(undefined)` means a malformed enum/host silently degrades instead of erroring.
28. `endTurn()` is called BEFORE `requestHelp()` (box-help-tool.ts:88 then :93) — the turn is ended even if the request subsequently reports already-pending or throws.
29. `invariant(agentId != null, "request_box_help was called outside an agent run.")` (box-help-tool.ts:87) throws; defineCommunicateTool catches it and converts it to an error result string (communicate-tool.ts:157-159).
30. `normalizeBoxHelpDomain` (box-help-tool.ts:50-60) lowercases, prefixes `https://` when no scheme, takes `hostname`, strips a leading `www.`, and returns undefined on any parse failure — telemetry silently loses an unparseable domain.
31. Duplicate-suppression: `outcome.kind === "already-pending"` returns a long refusal string and does NOT emit a chat message (box-help-tool.ts:102-104). Only the "started" branch calls `onSendMessage({type:"text",content:instruction}, now, {requestId, instruction})` (box-help-tool.ts:105-112) — i.e. the box-help instruction reaches chat as a plain TEXT message carrying requestId/instruction metadata, not as a bespoke card type.
32. CROSS-CONCERN ODDITY: `connectorCardEmissionToMessage` (box-help-tool.ts:62-73) builds the MCP `{type:"connector", connector, serverId, variant}` card message and is NOT used anywhere in box-help-tool.ts. Its only consumer is the MCP connector-card emitter in composition (host-runner-composition.ts:71 import, :2159-2165 use). The connector-card constructor lives in the box-help module for no reason visible in the code.
33. GATE STATUS — request_box_help is DORMANT in this reconstruction. buildTurnTools will offer it under `!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()` (turn-toolset.ts:1466-1473), but the factory only exists if `provider.createRequestBoxHelpToolInputs` is defined (turn-toolset.ts:1184-1186). Repo-wide grep for `createRequestBoxHelpToolInputs` returns only its two declaration/consumption sites inside turn-toolset.ts (:725, :1184) — host-runner-composition.ts never sets it. The system prompt nonetheless instructs the model to use request_box_help in four places (system-prompt.ts:190, :192, :195; prompt-collector-glue.ts:278) and SendMessage's own description points at it (send-message-tool.ts:17). Prompt references a tool the composition does not wire.

--- listener-connect-cards.ts (39 lines) ---
34. `surfaceListenerConnectCards` returns null (emits nothing) when `isListenerPlatformConnected == null`, when the trigger names no platforms, or when nothing is disconnected (listener-connect-cards.ts:16-27).
35. Per-platform connectivity probes are wrapped in `try {} catch {}` with an EMPTY catch (listener-connect-cards.ts:21-25): a probe that throws is treated as CONNECTED (the platform is not pushed to `disconnected`), so a failing probe silently suppresses the connect card.
36. Card emission is a direct `emit({type:"listener-connect", platform, reason:"so this routine can fire"})` per disconnected platform (listener-connect-cards.ts:28-34) — one card per platform, no dedupe against cards already in chat.
37. The returned string is agent-facing guidance ending "…don't paste a link or send them to settings, and don't ask them to report back: you're resumed automatically once it connects." (listener-connect-cards.ts:38).
38. It is NOT a tool. It is invoked as `onListenerRoutineSaved` from the state tool's routine write path (sand-state-tool.ts:250, appended to the write result at :251), wired in composition only when `listenerPlatformConnected !== undefined` (host-runner-composition.ts:1905-1929). The emit sink is `hooks.transport.onUpdate({type:"send-message", message: card, timestampMs: Date.now()})` (host-runner-composition.ts:1917-1923). displayName maps only slack→"Slack", everything else→"GitHub" (host-runner-composition.ts:1926) — same two-way assumption as the encoder (send-message-encoding.ts:39).

--- tool-input-error.ts (2 lines) ---
39. `SandToolInputError` is a bare Error subclass with `override readonly name="SandToolInputError"` (tool-input-error.ts:1). No code, no field, no structured payload. Consumers throw it for arg-shape violations: send-message-tool.ts:42-44 (widget/bcId/secret required), sand-computer-tool.ts:123, sand-state-tool.ts:201, 208, 217, 236, 287. Because defineCommunicateTool's catch is `error instanceof Error ? error.message : String(error)` (communicate-tool.ts:109-111, 157-159), a SandToolInputError is indistinguishable from any other Error at the model boundary — the type carries no signal past the throw site.

=== B. MCP MANAGEMENT TOOL TABLE (sand-mcp-management-tools.ts, 442 lines) ===
12 tools; 10 always, 2 multi-account-only. All built via defineCommunicateTool with dependency object `management` (sand-mcp-management-tools.ts:285-442). See the `tools` array for line numbers.

40. MUTATION GUARD: `guardMutation` short-circuits EVERY mutating tool with `MCP_AWAITING_SELECTION_MESSAGE` when `isAwaitingUserSelection?.() === true` (sand-mcp-management-tools.ts:293-295, message text at :240). Applied to: InstallPlugin, AddMcpServer, UninstallMcpServer, UninstallPlugin, SetMcpInstructions, RestartMcpServers, AuthenticateMcpServer, RemoveMcpAccount, RenameMcpAccount. NOT applied to SearchPlugins, GetPlugin, GetMcpServerStatus (read-only).
41. ID RESOLUTION: `resolveServerId` returns the token unchanged if it matches `/^[1-9]\d*$/` (isMcpServerId, mcp-server-id.ts:3) — i.e. a bare positive integer is trusted as a real DB id without checking it exists (sand-mcp-management-tools.ts:297-302). If the listing is unreadable it ALSO returns the raw token (line 301), so a listing failure degrades to passing an unvalidated string into deps.
42. MULTI-ACCOUNT IS LATCHED ONCE: `const multiAccount = isMultiAccountEnabled?.() === true` is evaluated at tool-construction time (sand-mcp-management-tools.ts:292) and drives (a) whether RemoveMcpAccount/RenameMcpAccount exist (:416-440), (b) AuthenticateMcpServer's parameter schema (:414), (c) whether `account_label` is honored or forced to "default" (:409), and (d) extra sentences appended to two descriptions (:356, :369). A flag flip mid-session does not change an already-built toolset.
43. When multiAccount is false, AuthenticateMcpServer hardcodes account "default" and ignores any supplied label (sand-mcp-management-tools.ts:409).
44. CONNECTOR CARD MECHANISM (the card-producing path for MCP): two emitters, both `emitConnectorCard(card: {connector, serverId, variant:"connect"|"connected"})`.
    (a) `emitAndDescribeAuthResult` — on `started` emits variant "connect" (:258-262); on `already-authenticated` emits variant "connected" (:263-265). The other three kinds (not-configured, not-supported, unreachable) emit NO card and return prose (:266-268).
    (b) `emitNeedsAuthCards` — diffs before/after listings via `newNeedsAuthRows` and emits one "connect" card per newly-appeared server whose status is exactly the string "needsAuth" (:242-249, :304-311). Used by InstallPlugin (:338) and AddMcpServer (:351) only.
    Sink: composition turns each emission into a chat message via `connectorCardEmissionToMessage` → `hooks.transport.onUpdate({type:"send-message", message:{type:"connector",...}, timestampMs})` (host-runner-composition.ts:2159-2165). Transcript shaping preserves connector/serverId/variant/reason/suggestions (send-message-shaping.ts:189-199).
45. `newNeedsAuthRows` keys the "prior" set by `serverIdentifier` but keys the emitted rows by `id` (sand-mcp-management-tools.ts:243-248) — a server whose identifier already existed before the install never gets a card even if its status flipped to needsAuth (the diff is existence-based, not status-transition-based).
46. Cards are emitted with `emitConnectorCard?.()` optional-call — when composition does not supply the emitter (`mcpManagement === undefined` branch, host-runner-composition.ts:2148), auth still starts and the SAME success prose containing CARD_SHOWN_NOTE is returned (:259-262), i.e. the model is told "Its connect card is now in the chat" even when no card was emitted. `emitNeedsAuthCards` is stricter — it returns null when `emitConnectorCard == null` (:306).
47. CARD_SHOWN_NOTE (:239) instructs the model: "Finish unrelated work, then end your turn — you're resumed automatically when the user authorizes. Don't send a link, another card, or reach the service another way meanwhile."
48. URL VALIDATION for AddMcpServer (`validateRemoteMcpUrl`, :139-153): rejects unparseable URLs, rejects non-http(s) protocols, and rejects any URL carrying `username`/`password` with a message telling the model to move credentials into headers. It does NOT require https despite the parameter description saying "(https)" (:102) and the error text saying "ask the user for an https endpoint" (:147) — plain `http:` passes (:146). Headers are passed through verbatim into the stored config JSON (`buildServerConfigJson`, :155-162), so secrets land in the server config.
49. DESTRUCTIVE-SCOPE ENFORCEMENT: UninstallMcpServer refuses when `row.pluginId != null` (redirect to UninstallPlugin, :361) and when `row.isTeamServer === true` (:362). UninstallPlugin refuses `installMode === "team-required"` (:374). Both are code-enforced, not prompt-only. The "confirm with a question widget first" requirement, however, is DESCRIPTION-ONLY — nothing in execute() checks that a confirmation happened (:331, :343, :356, :369, :419, :429).
50. SEARCH RANKING is purely lexical, no embeddings: tokens ≥3 chars, deduped, non-alphanumeric split (`tokenizePluginQuery`, :108-114); per-token score exact-name 8 / name-substring 5 / skill-name 3 / category 2 / description 1 (`scorePluginForToken`, :116-125); zero-score plugins are dropped entirely (:134), ties break on displayName (:129, :135). A query whose every token is <3 chars degrades to "list everything sorted by name" (:130).
51. `describeInstalled` (:169-184) leaks statusDetail (truncated to 200 chars, :179) and custom instructions (truncated 120, :180-182) into the model's context; instructions are suppressed when equal to `getDefaultMcpCustomInstruction(server.name)`.
52. `truncateOneLine` (:164-167) collapses whitespace then slices to `max-1` and appends "…".
53. SetMcpInstructions reports success using `args.server_id` (the raw token the model passed), not the resolved identifier (:395) — same for RemoveMcpAccount (:425) and RenameMcpAccount (:436).
54. RestartMcpServers reports "Restarted MCP servers." unconditionally before/around awaiting `deps.restart()` result (:400) — there is no failure branch.
55. InstallPlugin/UninstallPlugin verify the post-state and report a distinct "completed, but does not read as installed/still reads as installed" message rather than claiming success (:337, :364, :376).

=== C. OFFER GATES (turn-toolset.ts buildTurnTools) ===
56. Whole toolset is empty for a plain subagent: `isSubagentRunner && !(isComputerUseSubagent||isBrowserUseSubagent) && subagentConfigs===undefined` → `fencedToolSet([],…)` (turn-toolset.ts:1293-1299).
57. ReactToMessage: inside `if (!host.isSubagentRunner)` (turn-toolset.ts:1370-1376).
58. MCP management tools: inside `if (!host.isSubagentRunner)` (turn-toolset.ts:1479-1481).
59. request_box_help: `!isSubagentRunner && remoteBoxHasDesktop && getRemoteBoxAvailable()` (turn-toolset.ts:1466-1473) — dormant, see finding 33.
60. MCP discovery/call pair (GetMcpTools/CallMcpTool): `!isBoxScopedSubagent && (props?.mcp !== undefined || dynamicToolRegistry !== undefined)` — an explicit comment states "A supplied factory alone is not an MCP service and must remain dormant" (turn-toolset.ts:1470-1478).
61. SHARED-ROOM FILTER kills all of it: in a shared-room runner only `SHARED_ROOM_TOOL_NAMES` = {SendMessage, box shell, box read, box await, "Screenshot"} survive, or just {SendMessage} when box tools are disabled (turn-toolset.ts:151-160, 1494-1501). None of the MCP tools, ReactToMessage, or request_box_help are in either set.
62. Dynamic-tool mode requires `!isSubagentRunner && !isSharedRoomRunner && !isBoxScopedSubagent && isDynamicToolsEnabled?.()===true` (turn-toolset.ts:1301-1315); hints exist for SEARCH_PLUGINS, AUTHENTICATE_MCP_SERVER, REQUEST_BOX_HELP among others (turn-toolset.ts:166-176).

## Tool table

### SearchPlugins
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:315`
- gate: turn-toolset.ts:1479 `if (!host.isSubagentRunner)` → factories.mcpManagement; factory exists only if provider.createMcpManagementToolInputs is set (turn-toolset.ts:1234), which composition sets only when `mcpManagement !== undefined` (host-runner-composition.ts:2148-2150). Removed in shared rooms (turn-toolset.ts:1494-1501).
- notes: id SEARCH_PLUGINS. Read-only, NOT wrapped in guardMutation. Purely lexical ranking: tokens ≥3 chars, exact-name 8 / substring 5 / skill 3 / category 2 / description 1, zero-score dropped (sand-mcp-management-tools.ts:108-137). Has a dynamic-tool hint (turn-toolset.ts:168).

### GetPlugin
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:324`
- gate: same as SearchPlugins (turn-toolset.ts:1479)
- notes: Read-only, no guardMutation. Returns describePluginDetail incl. setup fields with required/secret flags (sand-mcp-management-tools.ts:218-237). Null plugin → `No plugin with id "x".`

### InstallPlugin
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:331`
- gate: turn-toolset.ts:1479 plus runtime guardMutation: returns MCP_AWAITING_SELECTION_MESSAGE if isAwaitingUserSelection?.()===true (sand-mcp-management-tools.ts:293-295, 332)
- notes: CARD PRODUCER: calls emitNeedsAuthCards(before.servers, after.servers) (:338) → one variant:"connect" card per newly-appeared server whose status string === "needsAuth" (:242-249, :304-311). Verifies post-state and reports 'completed, but does not read as installed yet' on mismatch (:337). 'confirm with a question widget first' is description-only, not enforced.

### AddMcpServer
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:343`
- gate: turn-toolset.ts:1479 plus guardMutation (:344)
- notes: CARD PRODUCER via emitNeedsAuthCards (:351). validateRemoteMcpUrl rejects unparseable URLs, non-http(s) schemes, and userinfo credentials — but ALLOWS plain http: despite description/error text saying https (:139-153, :102, :147). Headers written verbatim into config JSON (:155-162).

### UninstallMcpServer
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:356`
- gate: turn-toolset.ts:1479 plus guardMutation (:357)
- notes: Code-enforced refusals: pluginId != null → redirect to UninstallPlugin (:361); isTeamServer === true → refuse (:362). Description gains an extra RemoveMcpAccount sentence only when multiAccount latched true (:356). Widget confirmation is prompt-only.

### UninstallPlugin
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:369`
- gate: turn-toolset.ts:1479 plus guardMutation (:370)
- notes: Refuses installMode === "team-required" (:374) and not-installed (:373). Reports 'still reads as installed' on post-state mismatch (:376). Multi-account sentence appended only when multiAccount true (:369).

### GetMcpServerStatus
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:380`
- gate: turn-toolset.ts:1479; no guardMutation (read-only)
- notes: Resolution is serverIdentifier-first with legacy id fallback (mcp-server-resolution.ts:2). Leaks statusDetail (≤200 chars) and non-default customInstructions (≤120) into model context (:179-182).

### SetMcpInstructions
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:390`
- gate: turn-toolset.ts:1479 plus guardMutation (:391)
- notes: resolveServerId trusts any /^[1-9]\d*$/ token unvalidated, and returns the raw token when the listing is unreadable (:297-302). Confirmation string echoes args.server_id, not the resolved id (:395).

### RestartMcpServers
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:399`
- gate: turn-toolset.ts:1479 plus guardMutation (:400)
- notes: Empty z.object({}) params. Reports 'Restarted MCP servers.' with no failure branch (:400).

### AuthenticateMcpServer
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:405 (pushed at :414)`
- gate: turn-toolset.ts:1479 plus guardMutation (:406). Parameter schema chosen at build time by the latched `multiAccount` flag (:292, :414): multiAuthParameters (adds required account_label) vs authParameters.
- notes: PRIMARY CARD PRODUCER: emitAndDescribeAuthResult emits variant "connect" on kind 'started' (:258-262) and variant "connected" on 'already-authenticated' (:263-265); no card for not-configured/not-supported/unreachable (:266-268). When emitConnectorCard is undefined the optional call is skipped but the SAME CARD_SHOWN_NOTE prose is still returned, telling the model a card is in chat that was never emitted (:259-262 vs :239). account forced to 'default' when multiAccount false (:409). Has a dynamic-tool hint (turn-toolset.ts:169).

### RemoveMcpAccount
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:419`
- gate: Only pushed when the latched `multiAccount` is true (sand-mcp-management-tools.ts:292, 416-417), sourced from experiments.isMcpMultiAccountEnabled (host-runner-composition.ts:2157-2158); then turn-toolset.ts:1479 plus guardMutation (:420)
- notes: Destructive; widget confirmation is description-only. Success line echoes args.server_id, not the resolved id (:425).

### RenameMcpAccount
- defined: `source/host/runner/tools/sand-mcp-management-tools.ts:428`
- gate: same multiAccount latch as RemoveMcpAccount (:416-417) plus turn-toolset.ts:1479 and guardMutation (:430)
- notes: Description warns the server identifier changes with the label; no code enforces re-listing. Echoes args.server_id in the result (:436).

### request_box_help
- defined: `source/host/runner/tools/box-help-tool.ts:78 (createRequestBoxHelpTool at :75)`
- gate: turn-toolset.ts:1466-1473 `!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()`, AND factories.requestBoxHelp exists only if provider.createRequestBoxHelpToolInputs is defined (turn-toolset.ts:1184-1186). Repo-wide grep finds that provider key ONLY at turn-toolset.ts:725 and :1184 — host-runner-composition.ts never sets it.
- notes: DORMANT in this reconstruction while the system prompt still instructs its use (system-prompt.ts:190,192,195; prompt-collector-glue.ts:278; send-message-tool.ts:17). id REQUEST_BOX_HELP, registered 'async' (packages/agent/tools/all-tools.ts:99). endTurn() fires BEFORE requestHelp() (:88 vs :93). 'already-pending' returns a refusal and emits NO chat message (:102-104); only 'started' emits a plain type:'text' message carrying {requestId, instruction} metadata (:105-112). reason/domain/idp_domain use .catch(undefined) so malformed values degrade silently (:10-21).

### ReactToMessage
- defined: `source/host/runner/tools/sand-reaction-tool.ts:26 (createReactToMessageTool at :21)`
- gate: turn-toolset.ts:1370-1376 `if (!host.isSubagentRunner)`; factory needs provider.createReactionToolInputs, set unconditionally in composition (host-runner-composition.ts:2049-2055). Filtered out in shared rooms (turn-toolset.ts:1494-1501).
- notes: id SEND_TO_USER (shared with the SendMessage family; proto tools_pb.ts:80 = 65). emoji is only length-capped at 16 chars, no emoji validation (:12-14). Fire-and-forget: react() returns void, tool returns a success string it cannot verify (:18, :39-40); the runner separately sets active.reacted only when transport.lastReactionApplied()===true (sand-agent-runner.ts:1117-1123). Member of SAND_FORCED_STATIC_TOOL_NAMES so it never goes behind dynamic placement (turn-toolset.ts:161-164).

### GetMcpTools / CallMcpTool
- defined: `created in source/host/runner/tools/turn-toolset.ts:885 and :896 (implementations in packages/agent/tools/mcp/get-mcp-tools.ts and mcp.ts — outside the assigned read set)`
- gate: turn-toolset.ts:1470-1478 `!host.isBoxScopedSubagent && (props?.mcp !== undefined || dynamicToolRegistry !== undefined)`; the source comment states a supplied factory alone 'must remain dormant'.
- notes: Their descriptor payload is McpMetaToolOptions built by asGeneratedMcpMetaToolOptions (turn-toolset.ts:812-847), NOT by createSandMcpMetaToolOptions in mcp-meta-tools.ts:121 — that one is dead code (single repo-wide hit). CallMcpTool, when it carries dynamicToolMetaRole 'invocation', is wrapped by wrapDynamicInvocationToolWithTimeout (turn-toolset.ts:1533-1541), which buffers the entire argument stream before execution (mcp-meta-tools.ts:75-84).

### SendMessage {type:"secret-request"} — the secret card (not a separate tool)
- defined: `schema: source/host/runner/tools/send-message-schema.ts:46-51; normalization: source/host/runner/tools/send-message-tool.ts:44; clamps: source/host/runner/tools/sand-secret-request.ts:1-2`
- gate: Rides SendMessage, gated at turn-toolset.ts:1369-1372 `if (!host.isSubagentRunner)`. SendMessage survives the shared-room filter (turn-toolset.ts:151-160). No separate secret tool exists — 'permission-request' is not even in SEND_MESSAGE_TYPES (send-message-schema.ts:3).
- notes: CARD MECHANISM: model sends {label, description?, connector, field} → rewritten to {secretRequest:{label(≤120), description(≤400), target:{kind:'channel-credential', platform:connector, field}}} (send-message-tool.ts:44). Runner latches awaitingUserSelection on secret-request (sand-agent-runner.ts:1100-1109), which is exactly the flag guardMutation reads to block MCP mutations (sand-mcp-management-tools.ts:293-295). Submission: widget-responses.ts:355-392 validates entry/type/not-already-provided, routeSecret refuses any non-'channel-credential' target and writes via sessionStore.storeConnectorCredential (:394-405), marks secretProvided, then resumes with buildSecretProvidedAck as a HIDDEN prompt (sand-secret-request.ts:4). Empty submission returns silently with no resume (:361); a failed write pushes a tray error and also does not resume (:374-380). Model only ever sees summarizeSecretRequest 'Requested a secret from the user securely: {label}' (sand-secret-request.ts:3, send-message-encoding.ts:33).

### permission-request (RETIRED — no tool)
- defined: `source/host/runner/tools/sand-permission-request.ts:1-6`
- gate: Not offerable: 'permission-request' is absent from SEND_MESSAGE_TYPES (send-message-schema.ts:3) and no tool constructs it. Only reachable as an encoder branch for pre-existing transcript entries (send-message-encoding.ts:34).
- notes: summarizePermissionRequest returns 'Legacy permission request (no longer actionable): {title} — {reason}'. Frontend leaf is variant 'retired' with 'no bridge or action' (frontend/src/recovered/features/conversation/cards/permission-request/view.tsx:7-14). Shaping still passes it through (send-message-shaping.ts:183-188) so history renders.

### listener-connect card (helper, NOT a tool)
- defined: `source/host/runner/tools/listener-connect-cards.ts:13`
- gate: Invoked as deps.onListenerRoutineSaved from the routine-write path in the UpdateState tool (sand-state-tool.ts:250); composition supplies it only when `listenerPlatformConnected !== undefined` (host-runner-composition.ts:1905-1929). Inside the helper it self-gates: null if isListenerPlatformConnected == null, no platforms, or nothing disconnected (:16-27).
- notes: Emits one {type:'listener-connect', platform, reason:'so this routine can fire'} per disconnected platform (:28-34); sink is hooks.transport.onUpdate as a send-message (host-runner-composition.ts:1917-1923). Empty catch around each probe means a THROWING connectivity check is treated as connected and suppresses the card (:21-25). displayName and the encoder both assume only slack/github (host-runner-composition.ts:1926; send-message-encoding.ts:39). Returns agent-facing guidance appended to the state-write result (sand-state-tool.ts:251).


## Did not verify

- Whether request_box_help is genuinely unwired in the SHIPPED product or only in this reconstruction: I verified only that no source file in this repo assigns provider.createRequestBoxHelpToolInputs (grep across *.ts/*.tsx/*.js/*.md). A build-time or packaged path outside the repo could supply it.
- The concrete implementations behind McpManagementDependencies (listPlugins, install, add, removeServer, authenticate, removeAccount, renameAccount) — I read only the interface (sand-mcp-management-tools.ts:61-78) and the composition binding `management: mcpManagement`. Where mcpManagement is constructed, and whether authenticate() actually starts an OAuth flow, is unread.
- Whether emitConnectorCard is ever undefined in practice: composition always supplies it inside the `mcpManagement !== undefined` branch (host-runner-composition.ts:2148-2165), so the 'card claimed but not emitted' path (finding 46) is reachable only via another host that omits the emitter. I did not enumerate other hosts.
- The exact numeric timeout tiers: I read toolCallExecutionGuardMs and buildToolCallExecutionTimedOutMessage (tool-execution-timeout.ts:41-54) but not pickToolCallTimeoutTierMs / suggestedToolTimeoutMs / TOOL_CALL_GUARD_HEADROOM_MS values, so I cannot state what 'subagent' or any tool name resolves to in ms.
- isMessageAddress semantics (shared/message-reference.js) — I did not read it, so I cannot say which address forms ReactToMessage accepts or whether it distinguishes user messages from the agent's own sends (the description claims it must, sand-reaction-tool.ts:27, but no code in the read set enforces the user-vs-agent distinction).
- clampLine / clampBlock behavior in shared/sand-text.js — unread, so the truncation style for secret labels/descriptions (ellipsis? hard cut? multi-line collapse?) is unverified.
- decodeMcpAccountLabelArgument / encodeMcpAccountLabelForListing / formatMcpAccountLabelForPrompt (shared/mcp.js) — unread; the encoding/decoding round-trip for account labels is unverified.
- getDefaultMcpCustomInstruction (shared/mcp-custom-instructions.js) — unread; I cannot say what default guidance is suppressed at sand-mcp-management-tools.ts:180 or emitted at :213.
- Whether any test or runtime path exercises createSandMcpMetaToolOptions: I confirmed no *.ts/*.js/*.md reference outside its definition, but the repo may have no test suite at all — I did not check for a tests directory.
- Whether a widget confirmation is enforced anywhere upstream for the destructive MCP tools. I established it is not enforced inside execute(); a caller-side or client-side gate outside the read set was not searched for.
- The runner's isRunAwaitingUserSelection implementation (host-runner-composition.ts:2153-2156 reads it off builtRunner via an optional cast) — I read the sand-agent-runner latch at :1100-1109 but not the getter, so I cannot confirm the two are the same flag.
- Frontend rendering of the connector and listener-connect cards: I read only the permission-request leaf and grep hits for the others (protocol.ts, registry.ts, views/secret-request.tsx). Actual card UI behavior is unverified.