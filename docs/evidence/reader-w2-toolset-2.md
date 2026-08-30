# Reader output: w2:tools-voicebbb

## Scope read

`/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/turn-toolset.ts` — file is 1532 lines total. I read the requested span 780–1532 end to end, plus 1–780 (needed to answer "what does the file EXPORT" and to resolve `TurnToolFactories` / `SHARED_ROOM_TOOL_NAMES` / `TurnTool`). Reference-chasing out of the file: `fencedToolSet`, `ToolSetHandle`, and every `create*Tool` module, to recover the concrete tool NAMES the model sees (they are not literals in turn-toolset.ts).

## Answer 1 — final toolset shape: NOT a name→definition map, and NOT a bare array

`buildTurnTools` returns `ToolSetHandle` (turn-toolset.ts:1297), produced by `fencedToolSet(guarded, host.spotlightEnabled(), dynamicToolRegistry)` (turn-toolset.ts:1531).

- `fencedToolSet` (sand-spotlight-tools.ts:28-37) takes `readonly T[]`, optionally wraps each in `withSpotlightedToolResult` when `enabled`, then either `ToolSetHandle.fromTools(finalTools)` (array form) or, when a `dynamicToolRegistry` is present, partitions into `{ staticTools, dynamicTools, dynamicToolRegistry }`.
- `ToolSetHandle` (packages/agent/tools/core.ts:60-126) is a **class**, not a plain object. Internally it holds THREE things: `allToolsByIdentifier: Map<string, AnyTool[]>` (keyed on `tool.toolIdentifier`, **not** `tool.name`, and the value is an ARRAY because identifiers can collide — core.ts:113-115), plus separate `staticTools[]` and `dynamicTools[]` arrays.
- Lookup by name only happens in `resolveToolCallIdentity` via a linear `.find(tool => tool.name === toolName)` over staticTools then dynamicTools (core.ts:70-75). `getTool(identifier)` / `getStaticTool(identifier)` are identifier-keyed (core.ts:69, 78).
- Ordering is not source order: `ToolSetHandle.fromTools` runs `stabilizeMcpToolOrder(effectiveStaticTools)` before building the map (core.ts:111).
- Dynamic split is conditional: dynamic tools are only actually exposed as dynamic when the set contains BOTH a `dynamicToolMetaRole === "discovery"` tool AND an `"invocation"` tool; otherwise everything is flattened into static (core.ts:104-107).

Inside `buildTurnTools` the intermediate accumulator IS a plain array: `const tools: TurnTool[] = []` (turn-toolset.ts:1321), pushed to in gate order, then filtered/mapped through three post-passes before being handed to `fencedToolSet`.

## Answer 2 — what the file EXPORTS (79 export statements)

**Constants (9):** `SAND_EXTERNAL_MACHINE` (:136), `SAND_EXTERNAL_READ_TOOL_DESCRIPTION` (:138), `SAND_BOX_READ_TOOL_DESCRIPTION` (:142), `SAND_COMPUTER_USE_BOX_READ_TOOL_DESCRIPTION` (:146), `SHARED_ROOM_TOOL_NAMES` (:151), `SHARED_ROOM_TEXT_ONLY_TOOL_NAMES` (:158), `SAND_FORCED_STATIC_TOOL_NAMES` (:161), `SAND_DYNAMIC_TOOL_HINTS` (:166), `SAND_READ_FORMATTING_OPTIONS` (:178).

**Types/interfaces (33):** `ToolExecutionContext` (:185), `ToolMetadata` (:191), `TurnTool` (:197), `TurnToolsetBuildProps` (:224, alias of `ProductionTurnToolInputs`), `TurnToolsetTurnInput` (:226), `TurnShellAutoReviewInput` (:256), `LocalToolPermission` (:388), `ToolFactoryContext` (:506), `TurnToolFactories` (:519), `TurnTaskToolParameters` (:548), the 20 `Turn*ToolFactoryInput` interfaces (:555–:665), `TurnToolsetFactoryInputs` (:667), `TurnToolsetHostFactoryProvider` (:696), `TurnToolsetHost` (:1250), `TurnToolsetInput` (:1277, alias of `TurnToolsetTurnInput`).

**Wrapper/decorator functions (4):** `withDynamicToolPlacement` (:397), `withLocalToolScope` (:417), `withRecordedToolCallNames` (:455), `withToolTimeout` (:475).

**Shell auto-review helpers (2):** `resolveTurnShellAutoReviewInputs` (:278), `createTurnShellAutoReviewOptions` (:338).

**Per-tool factory builders (20, all in the audited span):** `createTurnTaskToolFactory` (:851), `createTurnMultitaskToolFactory` (:866), `createTurnMcpMetaToolFactory` (:880), `createTurnComputerToolFactory` (:908), `createTurnScreenshotToolFactory` (:914), `createTurnBrowserToolFactory` (:920), `createTurnFileTransferToolFactory` (:926), `createTurnBoxHelpToolFactory` (:932), `createTurnGenerateImageToolFactory` (:938), `createTurnWebSearchToolFactory` (:944), `createTurnWebFetchToolFactory` (:950), `createTurnAwaitToolFactory` (:956), `createTurnShellToolFactory` (:966), `createTurnReadToolFactory` (:975), `createTurnSendMessageToolFactory` (:986), `createTurnSendToAgentToolFactory` (:992), `createTurnReactionToolFactory` (:998), `createTurnCreateAgentToolFactory` (:1004), `createTurnUpdateAgentToolFactory` (:1010), `createTurnStateToolFactory` (:1016), `createTurnSubagentManagementToolFactory` (:1022), `createTurnMcpManagementToolFactory` (:1028), `createTurnCloudAgentToolFactory` (:1040).

**Assembly entry points (3):** `createTurnToolsetFactories` (:1054), `createTurnToolsetFactoriesForTurn` (:1153), `buildTurnTools` (:1293).

**Unrelated helper (1):** `extractSandAutoReviewClassifierContext` (:1279) — message filter for the auto-review classifier; lives in this file but touches no tool.

## Answer 3 — registration pipeline (3 post-passes after the push loop)

1. **Shared-room fence** (:1497-1504). If `host.isSharedRoomRunner`, keep only tools whose `.name` is in `SHARED_ROOM_TEXT_ONLY_TOOL_NAMES` (`{SendMessage}`) when `isSharedRoomBoxToolsEnabled?.() === false`, else `SHARED_ROOM_TOOL_NAMES` (`{SendMessage, Shell, Read, AwaitShell, "Screenshot"}`, :151-157). Non-shared-room turns are unfiltered.
2. **Dynamic placement** (:1506-1508). When `dynamicToolsEnabled`, every offered tool is mapped through `withDynamicToolPlacement` (:397-415), which forces `contextType: {type:"static"}` for `update_state` and `ReactToMessage`, and stamps `contextType: {type:"dynamic", conciseStaticContext: hint}` for the 9 identifiers in `SAND_DYNAMIC_TOOL_HINTS` (:166-176).
3. **Timeout guard** (:1509-1529). Invocation-role tools go through `wrapDynamicInvocationToolWithTimeout`; everything else through `withToolTimeout(tool, sandToolCallExecutionTimeoutMs(tool.name, host.isComputerUseSubagent), …)`.

`dynamicToolsEnabled` requires `!isSubagentRunner && !isSharedRoomRunner && !isBoxScopedSubagent && host.isDynamicToolsEnabled?.() === true` (:1306-1310).

## Findings worth the lead's attention

**F1 — `createTurnToolsetFactories` return type omits `multitask`, but the body returns it.** The `Pick<TurnToolFactories, …>` union at :1056-1064 lists 24 keys and does NOT include `"multitask"`; the body sets `multitask: createTurnMultitaskToolFactory(input.multitask)` at :1069-1071. Callers that type against the declared return lose the multitask factory statically even though it is present at runtime. `createTurnToolsetFactoriesForTurn` (:1153-1157) declares `ReturnType<typeof createTurnToolsetFactories>`, so the loss propagates.

**F2 — box tools get no `SandLocalToolAction`, external tools do.** `scoped(factories.externalShell?.(), "run-command")` (:1408) and `scoped(factories.externalRead?.(), "read-file")` (:1410) pass an action; `scoped(factories.boxShell?.())` (:1434), `scoped(factories.boxRead?.())` (:1436), `scoped(factories.boxAwait?.())` (:1439) pass none, so `withLocalToolScope` builds a scope with no `action` key (:439).

**F3 — `externalAwait` is scoped as `"read-file"`** (:1412), not as a shell/command action, despite being the await-shell polling tool.

**F4 — fileTransfer bypasses `withRecordedToolCallNames`.** Line :1442 calls `withLocalToolScope(tool, agentId, host.localToolPermission)` directly rather than the local `scoped()` helper (:1391-1405), so CopyToBox/CopyFromBox never invoke `host.recordModelToolName`. Every other permission-scoped tool does.

**F5 — most tools are never scoped at all.** `webSearch`, `webFetch`, `generateImage`, `cloudAgent`, `computer`, `browser`, `screenshot`, `requestBoxHelp`, `mcpMeta`, `mcpManagement`, `subagentManagement`, `task`, `multitask`, `sendMessage`, `sendToAgent`, `reaction`, `createAgent`, `updateAgent`, `updateState` are pushed raw (:1370-1387, :1414-1431, :1451-1494). They get neither `withLocalToolScope` nor `withRecordedToolCallNames`; only the timeout wrapper at :1509-1529.

**F6 — `host.toolExecutionTimeoutMs` is declared but never called.** Declared at :1267 and threaded through `runner-production-bridge.ts:232,268`, yet `buildTurnTools` computes timeouts from the module-level `sandToolCallExecutionTimeoutMs(tool.name, host.isComputerUseSubagent)` at :1520. No call site exists (grep over `source/` returns only those three declaration lines).

**F7 — `SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME` is imported and never used** (imported :9; the only other occurrences in the file are none). It also has two divergent definitions in the tree: `host/sand-activity.ts:5` = `"ExternalAwaitShell"` vs `shared/agents/agent-tool-names.ts:6` = `"AwaitExternalShell"`. turn-toolset.ts imports the `sand-activity.js` variant.

**F8 — `Computer` and `Screenshot` share `id: "OPENAI_COMPUTER_USE"`** (sand-computer-tool.ts:239 and :252). `ToolSetHandle.allToolsByIdentifier` buckets by identifier into arrays (core.ts:113-115) and `getTool()` returns `.at(0)`, so if both ever landed in one set, identifier lookup would be ambiguous. Their gates in buildTurnTools differ (`isComputerUseSubagent` at :1447 vs `!isSubagentRunner` at :1463) — whether those are mutually exclusive is not established here.

**F9 — `"Screenshot"` is a hardcoded string literal in `SHARED_ROOM_TOOL_NAMES`** (:156) while the other four entries are imported constants. A rename of the Screenshot tool would silently drop it from the shared-room allowlist.

**F10 — `mcpMeta` is deliberately fail-closed on a supplied factory alone.** Comment at :1473-1475 and gate at :1476-1479: the pair is only offered when `props?.mcp !== undefined || dynamicToolRegistry !== undefined`. A factory present in `host.factories` without a live per-turn MCP projection stays dormant.

**F11 — `subagentManagement` has a props fallback that no other tool has.** :1487-1492: if `factories.subagentManagement?.()` is undefined it reconstructs the factory inline from `props.hostDependencies.subagentManagement`.

**F12 — `task` has a hardcoded options block when `props` is supplied.** :1331-1362 bypasses `factories.task` entirely and builds the Task tool inline with 13 hardcoded option values (`readonlyShellEnabled: false`, `allowCustomModelId: false`, `includeExploreSubagent: false`, `requireServerSideSubagent: false`, `compareModelCosts: () => 0`, `isModelBlocked: () => false`, `isModelValid: () => true`, `useClientSideSubagent: true`, `enableAgentChatLinks: false`, …), cast through `as unknown as TaskToolParameters[5]`. The nested subagent gets `toolsGenerator: () => fencedToolSet([], …)` — an empty toolset (:1336).

**F13 — `TaskToolSurface` type (:214) is declared and never referenced** anywhere in the file.

**F14 — `turn` input is barely consumed by buildTurnTools.** Only `turn.subagentConfigs` (:1301, :1327, :1343, :1486) and `turn.geminiVideoAttachedMediaUrlProvider` (:1356) are read. The other 12 declared members of `TurnToolsetTurnInput` (:226-254) — `emitUpdate`, `remoteBoxResourceAccessor`, `autoReviewModes`, `stateHandler`, `toolSession`, `config`, `summarizationHandler`, `parentModelInfo`, `subagentModels`, `cancelThisRun`, `ackToken`, `pauseThisRun`, `isRunAwaitingUserSelection`, `endThisRunAwaitingUser`, `mcpTools`, `shellAutoReview` — are consumed elsewhere (the provider projection at :1158-1247, or by callers), not by the builder itself.

**F15 — early bail returns an empty fenced toolset, not an error.** :1298-1304: a subagent runner that is neither computer-use nor browser-use and has no `subagentConfigs` gets `fencedToolSet([], host.spotlightEnabled())` — zero tools, silently.

## Callers (chased out of file)

`buildTurnTools` is called from `host/runner/turn-agent-composition.ts:544`; `createTurnToolsetFactoriesForTurn` from `turn-agent-composition.ts:513` and `host/runner-production-bridge.ts:246`.

## Tool table

### Task | Subagent | mcp_task (resolved at runtime by getTaskToolName)
- defined: `turn-toolset.ts:1324-1363 (registration); factory turn-toolset.ts:851-862; underlying createTaskTool at packages/agent/tools/task.ts:475 with name = getTaskToolName(parentModelInfo), packages/agent/tools/task-tool-name.ts:9-14`
- gate: `!host.isSubagentRunner && !host.isSharedRoomRunner && turn.subagentConfigs != null` — turn-toolset.ts:1324-1328
- notes: Two paths: if `props === undefined` uses `factories.task?.()`; otherwise IGNORES the host factory and builds inline via createTurnTaskToolFactory with 13 hardcoded options cast `as unknown as TaskToolParameters[5]` (turn-toolset.ts:1329-1362). Nested subagent gets an EMPTY toolset: `toolsGenerator: () => fencedToolSet([], host.spotlightEnabled())` (:1336). Name is "mcp_task" for Composer models, "Subagent" for codex prompt versions, else "Task". NOT scoped (no withLocalToolScope / no recordModelToolName).

### TodoWrite | todo_write (toolIdentifier TODO_WRITE)
- defined: `turn-toolset.ts:1365-1372 (registration); factory turn-toolset.ts:866-873; createSandMultitaskTodoTool at host/sand-multitask.ts:46-54 wrapping createUpdateTodosTool (packages/agent/tools/core/todo/todo.ts:122, createZodAgentTool("TODO_WRITE", { name: getToolName(promptVersion) }) at :245-246)`
- gate: `!host.isSubagentRunner && !host.isSystemPromptOverridden && host.isMultitaskEnabled?.() === true` — turn-toolset.ts:1365-1369
- notes: Only reachable via `factories.multitask?.()`; there is NO props fallback. Note F1: `createTurnToolsetFactories`'s declared `Pick<...>` return type at turn-toolset.ts:1056-1064 omits "multitask" even though the body sets it at :1069-1071. Name is "todo_write" for promptVersion dsv3-1018, otherwise the default from todo.ts:26-30. Overrides descriptionGenerator with SAND_MULTITASK_TODO_DESCRIPTION (sand-multitask.ts:52,56).

### SendMessage
- defined: `turn-toolset.ts:1374-1375 (registration); factory turn-toolset.ts:986-990; createSendMessageTool at host/runner/tools/send-message-tool.ts:102 (name: SAND_SEND_MESSAGE_TOOL_NAME = "SendMessage", send-message-tool.ts:16)`
- gate: `!host.isSubagentRunner` — turn-toolset.ts:1373
- notes: Not scoped. The only tool that survives the text-only shared-room fence: SHARED_ROOM_TEXT_ONLY_TOOL_NAMES = {SAND_SEND_MESSAGE_TOOL_NAME} (turn-toolset.ts:158-160). Name constant is duplicated in two modules: send-message-tool.ts:16 and host/runner/send-message-reminder-middleware.ts:1, both "SendMessage".

### SendToAgent
- defined: `turn-toolset.ts:1376-1377 (registration); factory turn-toolset.ts:992-996; createSendToAgentTool at host/runner/tools/sand-agent-management-tools.ts:104 (name: SAND_SEND_TO_AGENT_TOOL_NAME = "SendToAgent", host/agents/agent-messaging.ts:6)`
- gate: `!host.isSubagentRunner` — turn-toolset.ts:1373
- notes: Not scoped, no timeout beyond the generic withToolTimeout pass at :1509-1529. Not in either SHARED_ROOM allowlist, so dropped for shared-room runners.

### ReactToMessage
- defined: `turn-toolset.ts:1378-1379 (registration); factory turn-toolset.ts:998-1002; createReactToMessageTool at host/runner/tools/sand-reaction-tool.ts:26 (name: SAND_REACT_TO_MESSAGE_TOOL_NAME = "ReactToMessage", sand-reaction-tool.ts:6)`
- gate: `!host.isSubagentRunner` — turn-toolset.ts:1373
- notes: Member of SAND_FORCED_STATIC_TOOL_NAMES (turn-toolset.ts:161-164), so withDynamicToolPlacement forces `contextType: {type:"static"}` on it even in dynamic-tools mode (turn-toolset.ts:397-403). Not scoped.

### CreateAgent
- defined: `turn-toolset.ts:1380-1381 (registration); factory turn-toolset.ts:1004-1008; createCreateAgentTool at host/runner/tools/sand-agent-management-tools.ts:133 (name: SAND_CREATE_AGENT_TOOL_NAME = "CreateAgent", host/agents/agent-messaging.ts:7)`
- gate: `!host.isSubagentRunner` — turn-toolset.ts:1373
- notes: createAgent and updateAgent share ONE input object: `input.agentManagement` produces both factories in createTurnToolsetFactories (turn-toolset.ts:1126-1131), and the provider supplies them via a single createAgentManagementToolInputs call (:1223-1225). Not scoped.

### UpdateAgent
- defined: `turn-toolset.ts:1382-1383 (registration); factory turn-toolset.ts:1010-1014; createUpdateAgentTool at host/runner/tools/sand-agent-management-tools.ts:149 (name: SAND_UPDATE_AGENT_TOOL_NAME = "UpdateAgent", host/agents/agent-messaging.ts:8)`
- gate: `!host.isSubagentRunner` — turn-toolset.ts:1373
- notes: Paired with CreateAgent off the same TurnAgentManagementToolFactoryInput (turn-toolset.ts:643-645). Not scoped.

### update_state
- defined: `turn-toolset.ts:1384-1387 (registration); factory turn-toolset.ts:1016-1020; createSandStateTool at host/runner/tools/sand-state-tool.ts (SAND_UPDATE_STATE_TOOL_NAME = "update_state", sand-state-tool.ts:8)`
- gate: `!host.isSubagentRunner` (outer, :1373) AND `!host.isSystemPromptOverridden` (inner, turn-toolset.ts:1384)
- notes: Only tool inside the !isSubagentRunner block with a second gate. Member of SAND_FORCED_STATIC_TOOL_NAMES (turn-toolset.ts:161-164) → forced `contextType: {type:"static"}` under dynamic placement. Not scoped. Note the name is snake_case while its siblings are PascalCase.

### ExternalShell (name comes from options.toolName; create-shell-tool default is "run-command" for isolated_box / "run_terminal_cmd" otherwise)
- defined: `turn-toolset.ts:1408-1409 (registration); factory turn-toolset.ts:966-973; createShellTool at packages/agent/tools/core/shell/create-shell-tool.ts:685-687`
- gate: `!host.isBoxScopedSubagent` — turn-toolset.ts:1407
- notes: Factory may return undefined (`createTurnShellToolFactory` returns `() => TurnTool | undefined`, :968-973) and the push is guarded (:1409). Scoped WITH action "run-command" via scoped() → withRecordedToolCallNames + withLocalToolScope (turn-toolset.ts:1391-1405). SAND_EXTERNAL_SHELL_TOOL_NAME = "ExternalShell" (host/sand-activity.ts:5) is only used in a description string at turn-toolset.ts:139, not to name the tool.

### ExternalRead (name from ReadToolOptions; toolIdentifier defaults to "READ")
- defined: `turn-toolset.ts:1410-1411 (registration); factory turn-toolset.ts:975-984; createReadTool at packages/agent/tools/core/read/read.ts:481-488 (createZodAgentTool(options.toolIdentifier ?? "READ", { name, ... }))`
- gate: `!host.isBoxScopedSubagent` — turn-toolset.ts:1407
- notes: Scoped WITH action "read-file". Its model-facing description is SAND_EXTERNAL_READ_TOOL_DESCRIPTION (turn-toolset.ts:138-141), which interpolates SAND_EXTERNAL_MACHINE.label and warns the machine is NOT the agent's own computer. Formatting comes from SAND_READ_FORMATTING_OPTIONS (:178-183): enableLineNumbers true, gpt5StyleLineNumbers/gpt5CodexCatN/shouldUseFormatCodeblock false.

### ExternalAwaitShell / AwaitExternalShell (name from AwaitToolOptions.toolName; toolIdentifier defaults to "AWAIT")
- defined: `turn-toolset.ts:1412-1413 (registration); factory turn-toolset.ts:956-964; createAwaitTool at packages/agent/tools/core/await.ts:342-346, :409`
- gate: `!host.isBoxScopedSubagent` — turn-toolset.ts:1407
- notes: F3: scoped with action "read-file" (turn-toolset.ts:1412), not a command action, even though it polls backgrounded shell jobs. F7: name constant diverges across the tree — host/sand-activity.ts:5 says "ExternalAwaitShell", shared/agents/agent-tool-names.ts:6 says "AwaitExternalShell"; turn-toolset.ts imports the sand-activity variant at :9 and never uses it. Shares TurnAwaitToolFactoryInput and createTurnAwaitToolFactory with boxAwait (turn-toolset.ts:1099-1104).

### WebSearch (toolIdentifier WEB_SEARCH)
- defined: `turn-toolset.ts:1414-1415 (registration); factory turn-toolset.ts:944-948; createWebSearchTool at packages/agent/tools/core/web-search.ts:318 (createZodAgentTool("WEB_SEARCH", ...)), toolName "WebSearch" at :292`
- gate: `!host.isBoxScopedSubagent` — turn-toolset.ts:1407
- notes: NOT scoped — pushed raw at :1415, so no local-tool-permission scope and no recordModelToolName, unlike the three tools registered immediately above it in the same block.

### WebFetch | mcp_web_fetch (toolIdentifier from createWebFetchTool)
- defined: `turn-toolset.ts:1416-1417 (registration); factory turn-toolset.ts:950-954; createWebFetchTool at packages/agent/tools/core/web-fetch.ts:129 (name: toolName(promptVersion)), name fn at web-fetch.ts:51-55`
- gate: `!host.isBoxScopedSubagent` — turn-toolset.ts:1407
- notes: NOT scoped. Name is "mcp_web_fetch" for promptVersion dsv3-1018/dsv3-1205, "WebFetch" for cursor-0226/latest/gpt5-codex/codex-cloud/haiku; any other promptVersion THROWS (web-fetch.ts:54).

### GenerateImage | generate_image (name from getToolName(promptVersion))
- defined: `turn-toolset.ts:1420-1423 (registration); factory turn-toolset.ts:938-942; createGenerateImageTool at packages/agent/tools/core/generate-image.ts:656 (name: getToolName(version)), name fn at generate-image.ts:205-212`
- gate: `!host.isSubagentRunner` — turn-toolset.ts:1420 (its OWN if-block, separate from the box-scoped block above and the cloud-agent block below)
- notes: NOT scoped. Name is "generate_image" for dsv3-1018; other promptVersions fall through a switch at generate-image.ts:205-212. Notably this is the only tool whose gate is a standalone `!host.isSubagentRunner` block sitting between two `!host.isBoxScopedSubagent` blocks.

### CloudAgent (id/toolIdentifier CLOUD_AGENT)
- defined: `turn-toolset.ts:1425-1431 (registration); factory turn-toolset.ts:1040-1044; createCloudAgentTool at host/cloud-agents/cloud-agent-tool.ts:45`
- gate: `!host.isBoxScopedSubagent && !host.cloudAgentsDisabledByTeam()` — turn-toolset.ts:1425-1428
- notes: Only tool gated on a team-policy predicate. NOT scoped. Has a SAND_DYNAMIC_TOOL_HINTS entry ("Launch and manage Cursor cloud coding agents for repository work.", turn-toolset.ts:167), so under dynamic-tools mode withDynamicToolPlacement stamps it `contextType: {type:"dynamic", conciseStaticContext: hint}` (:406-414). Description references "Cursor cloud agents" (cloud-agent-tool.ts:45).

### Shell (box shell; name from options.toolName, SAND_BOX_SHELL_TOOL_NAME = "Shell")
- defined: `turn-toolset.ts:1433-1435 (registration); factory turn-toolset.ts:966-973; createShellTool at packages/agent/tools/core/shell/create-shell-tool.ts:685-687; name constant host/sand-activity.ts:5 and shared/agents/agent-tool-names.ts:1`
- gate: `host.getRemoteBoxAvailable()` — turn-toolset.ts:1433
- notes: F2: scoped with NO SandLocalToolAction — `scoped(factories.boxShell?.())` at :1434, so withLocalToolScope builds a scope object with no `action` key (:439), unlike ExternalShell's "run-command". Factory can return undefined; push is guarded. In SHARED_ROOM_TOOL_NAMES (:153).

### Read (box read; SAND_BOX_READ_TOOL_NAME = "Read")
- defined: `turn-toolset.ts:1436-1437 (registration); factory turn-toolset.ts:975-984; createReadTool at packages/agent/tools/core/read/read.ts:481; name constant host/sand-activity.ts:5, shared/agents/agent-tool-names.ts:2`
- gate: `host.getRemoteBoxAvailable()` — turn-toolset.ts:1433
- notes: F2: scoped with NO action (:1436). Two distinct descriptions exist for it: SAND_BOX_READ_TOOL_DESCRIPTION (turn-toolset.ts:142-145, references CopyToBox and /home/box) and SAND_COMPUTER_USE_BOX_READ_TOOL_DESCRIPTION (:146-149, shorter, no ExternalRead cross-reference) — turn-toolset.ts exports both but selects neither; selection happens in the caller. In SHARED_ROOM_TOOL_NAMES (:154).

### AwaitShell (SAND_BOX_AWAIT_SHELL_TOOL_NAME = "AwaitShell")
- defined: `turn-toolset.ts:1438-1440 (registration); factory turn-toolset.ts:956-964; createAwaitTool at packages/agent/tools/core/await.ts:409; name constant host/sand-activity.ts:5, shared/agents/agent-tool-names.ts:3`
- gate: `host.getRemoteBoxAvailable()` (outer, :1433) AND `!host.isBoxScopedSubagent` (inner, turn-toolset.ts:1438)
- notes: F2: scoped with NO action (:1439). Unlike boxShell/boxRead it carries the extra !isBoxScopedSubagent gate, so a box-scoped subagent gets Shell and Read but cannot poll them. In SHARED_ROOM_TOOL_NAMES (:155).

### CopyToBox, CopyFromBox (array of 2)
- defined: `turn-toolset.ts:1441-1442 (registration); factory turn-toolset.ts:926-930; createFileTransferTools at host/runner/tools/sand-file-transfer-tools.ts:150 ("CopyToBox") and :162 ("CopyFromBox")`
- gate: `host.getRemoteBoxAvailable()` (outer, :1433) AND `!host.isBoxScopedSubagent` (inner, :1438)
- notes: F4: does NOT use the local scoped() helper. Line 1442 calls `withLocalToolScope(tool, agentId, host.localToolPermission)` directly, so these two tools skip withRecordedToolCallNames and never call host.recordModelToolName — the only permission-scoped tools with that gap. Both have SAND_DYNAMIC_TOOL_HINTS entries (COPY_TO_BOX, COPY_FROM_BOX, turn-toolset.ts:170-171).

### Computer (id OPENAI_COMPUTER_USE)
- defined: `turn-toolset.ts:1446-1453 (registration); factory turn-toolset.ts:908-912; createComputerTool at host/runner/tools/sand-computer-tool.ts:252 (`id: "OPENAI_COMPUTER_USE", name: "Computer"`)`
- gate: `host.isComputerUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()` — turn-toolset.ts:1446-1450
- notes: F8: shares `id: "OPENAI_COMPUTER_USE"` with the Screenshot tool (sand-computer-tool.ts:239 vs :252); ToolSetHandle buckets by toolIdentifier into arrays and getTool() returns .at(0) (core.ts:113-115, :69). NOT scoped. `host.isComputerUseSubagent` is also threaded into the timeout computation at :1520-1523 and into wrapDynamicInvocationToolWithTimeout at :1517.

### browser_navigate, browser_snapshot, browser_click, browser_mouse_click_xy, browser_type, browser_fill, browser_select_option, browser_press_key, browser_scroll, browser_drag, browser_get_bounding_box, browser_highlight, browser_cdp, browser_tabs, browser_take_screenshot (array of 15)
- defined: `turn-toolset.ts:1454-1461 (registration); factory turn-toolset.ts:920-924; BROWSER_TOOL_SPECS at host/runner/tools/sand-browser-tools.ts:551-567, mapped by createSandBrowserTools at sand-browser-tools.ts:593-600`
- gate: `host.isBrowserUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()` — turn-toolset.ts:1454-1458
- notes: Largest single registration: 15 tools spread via `tools.push(...browser)` (:1460). NOT scoped. Ids are BROWSER_NAVIGATE…BROWSER_TAKE_SCREENSHOT; none appear in SAND_DYNAMIC_TOOL_HINTS, so they get no dynamic contextType. browser_cdp is flagged canNavigate and denies CDP Input.* / browser-wide / storage / cookie / cache / permission / target-management commands (sand-browser-tools.ts:555).

### Screenshot (id OPENAI_COMPUTER_USE)
- defined: `turn-toolset.ts:1462-1468 (registration); factory turn-toolset.ts:914-918; createScreenshotTool at host/runner/tools/sand-computer-tool.ts:239 (`id: "OPENAI_COMPUTER_USE", name: "Screenshot"`)`
- gate: `!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()` — turn-toolset.ts:1462-1466
- notes: F8 (id collision with Computer) and F9: it is the ONLY entry in SHARED_ROOM_TOOL_NAMES written as a bare string literal `"Screenshot"` (turn-toolset.ts:156) rather than an imported constant — a rename would silently drop it from the shared-room allowlist. Its factory input type is TurnComputerToolFactoryInput, shared with Computer (turn-toolset.ts:673, :914-918). NOT scoped.

### request_box_help
- defined: `turn-toolset.ts:1469-1470 (registration); factory turn-toolset.ts:932-936; createRequestBoxHelpTool at host/runner/tools/box-help-tool.ts:78 (name: "request_box_help")`
- gate: `!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()` — turn-toolset.ts:1462-1466 (same block as Screenshot)
- notes: NOT scoped. snake_case name, unlike its block-mate Screenshot. Has a SAND_DYNAMIC_TOOL_HINTS entry under identifier REQUEST_BOX_HELP: "Hand your box's desktop to the user for a sign-in or manual step." (turn-toolset.ts:172).

### GetMcpTools + the MCP call tool (array of 2; toolIdentifier "MCP" for the call half)
- defined: `turn-toolset.ts:1476-1482 (registration); factory turn-toolset.ts:880-906; createGetMcpToolsTool at packages/agent/tools/mcp/get-mcp-tools.ts:269 (DEFAULT_GET_MCP_TOOLS_NAME = "GetMcpTools", get-mcp-tools.ts:26); createCallMcpTool at packages/agent/tools/mcp/mcp.ts:425-426`
- gate: `!host.isBoxScopedSubagent && (props?.mcp !== undefined || dynamicToolRegistry !== undefined)` — turn-toolset.ts:1476-1479
- notes: F10: the source comment at :1473-1475 states explicitly that a supplied factory alone is NOT an MCP service and must stay dormant. Unique signature: the ONLY factory taking an argument — `mcpMeta?(dynamicToolRegistry?: DynamicToolRegistry)` (turn-toolset.ts:543), invoked as `factories.mcpMeta?.(dynamicToolRegistry)` (:1480). Descriptors are rebuilt on every call from `input.getMcpTools()` via asGeneratedMcpMetaToolOptions (:812-848, :884), which groups by providerIdentifier and sorts each server's tools by toolName (:842). These two carry the discovery/invocation dynamicToolMetaRoles that ToolSetHandle.fromTools requires before it will expose any dynamic tools at all (core.ts:104-107). NOT scoped.

### SearchPlugins, GetPlugin, InstallPlugin, AddMcpServer, UninstallMcpServer, UninstallPlugin, GetMcpServerStatus, SetMcpInstructions, RestartMcpServers, AuthenticateMcpServer, RemoveMcpAccount*, RenameMcpAccount* (array; last two only when multiAccount)
- defined: `turn-toolset.ts:1483-1485 (registration); factory turn-toolset.ts:1028-1038; host/runner/tools/sand-mcp-management-tools.ts:315, 324, 331, 343, 356, 369, 380, 390, 399, 405, 419, 429`
- gate: `!host.isSubagentRunner` — turn-toolset.ts:1483
- notes: Factory forwards five positional args (management, getRequestingAgentId, isAwaitingUserSelection, isMultiAccountEnabled, emitConnectorCard — turn-toolset.ts:1031-1037), four of which are optional in TurnMcpManagementToolFactoryInput (:655-661), so undefined is passed positionally when absent. RemoveMcpAccount (:419) and RenameMcpAccount (:429) are conditional on the multiAccount flag. SearchPlugins and AuthenticateMcpServer have SAND_DYNAMIC_TOOL_HINTS entries (turn-toolset.ts:168-169). Descriptions name "Cursor account" (sand-mcp-management-tools.ts:331, 343) and state Grok Bot supports only remote http/sse MCP servers (:343). NOT scoped.

### CheckSubagent, MessageSubagent, StopSubagent (array of 3)
- defined: `turn-toolset.ts:1486-1494 (registration); factory turn-toolset.ts:1022-1026; createSubagentManagementTools at host/runner/tools/sand-subagent-management-tools.ts:90, :112, :132`
- gate: `!host.isSubagentRunner` (outer, :1483) AND `turn.subagentConfigs != null` (inner, turn-toolset.ts:1486)
- notes: F11: the ONLY tool group with a props fallback — if `factories.subagentManagement?.()` is undefined it rebuilds the factory inline from `props?.hostDependencies?.subagentManagement` (turn-toolset.ts:1487-1492). All three have SAND_DYNAMIC_TOOL_HINTS entries under CHECK_SUBAGENT / MESSAGE_SUBAGENT / STOP_SUBAGENT (turn-toolset.ts:173-175). Shares the `turn.subagentConfigs != null` precondition with the Task tool (:1327), so Task and these three are co-gated. NOT scoped.


## Did not verify

- Whether `host.isComputerUseSubagent` implies `host.isSubagentRunner === true`. This determines whether the Computer tool (gated on isComputerUseSubagent, turn-toolset.ts:1447) and the Screenshot tool (gated on !isSubagentRunner, :1463) can ever coexist in one toolset — which would matter because they share `id: "OPENAI_COMPUTER_USE"` (sand-computer-tool.ts:239, :252) and ToolSetHandle keys by toolIdentifier. I did not read the host implementation that sets these flags.
- Whether `tool.toolIdentifier` is always defined on the objects this file pushes. `TurnTool` declares it optional (turn-toolset.ts:201) and `withDynamicToolPlacement` early-returns when it is undefined (:405), but `ToolSetHandle.fromTools` indexes `allToolsByIdentifier.set(tool.toolIdentifier, ...)` unconditionally (core.ts:113-114). I did not verify every create*Tool sets it.
- The concrete runtime NAME of ExternalShell, ExternalRead, ExternalAwaitShell, box Shell, box Read, and box AwaitShell as registered here. All six take their name from `options.toolName` passed into createShellTool/createReadTool/createAwaitTool (create-shell-tool.ts:685, read.ts:481-482, await.ts:346), and those options come from the host factory provider, not from turn-toolset.ts. I read the constants (host/sand-activity.ts:5) but did not trace the provider that supplies options.toolName.
- Whether the box Read tool gets SAND_BOX_READ_TOOL_DESCRIPTION or SAND_COMPUTER_USE_BOX_READ_TOOL_DESCRIPTION. turn-toolset.ts exports both (:142, :146) and selects neither; selection is in the caller I did not read.
- Whether F1 (the `multitask` key missing from `createTurnToolsetFactories`'s `Pick<...>` return type at :1056-1064 while the body sets it at :1069-1071) actually produces a TypeScript error or is silently accepted because the property arrives via a conditional spread. I did not run tsc — I am read-only and did not build the project.
- Whether `props?.mcp` (the mcpMeta gate at :1478) is ever populated in practice. `TurnToolsetBuildProps` aliases `ProductionTurnToolInputs` (:224) from host/runner-production-bridge.ts, which I did not read end to end.
- The exact behavior of `withSpotlightedToolResult` and `partitionDynamicTools` (sand-spotlight-tools.ts:33-36) — I read fencedToolSet's body but not those two helpers, so I cannot describe how spotlight mutates a tool's result or how the static/dynamic partition decides.
- Whether `sandToolCallExecutionTimeoutMs` (mcp-meta-tools.ts, called at :1520) returns per-tool-name values or a constant. I confirmed host.toolExecutionTimeoutMs is never called (F6) but did not read the timeout function's body.
- Whether any caller relies on `extractSandAutoReviewClassifierContext` (:1279-1291) or on the exported wrapper functions individually. I confirmed callers only for buildTurnTools and createTurnToolsetFactoriesForTurn.