# Reader output: w2:tools-voiceb

SCOPE: read /Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/turn-toolset.ts end to end (1532 lines; the requested 1-820 span plus the remainder, because the actual registration gates live at 1293-1531 and would otherwise be unreadable). Name constants chased OUT of the file by grep only.

STRUCTURE OF THE FILE
- 1-134 imports. 136-149 external-machine label + Read tool descriptions. 151-176 allow-lists and dynamic-placement hints. 178-183 read formatting. 185-222 types.
- 278-386 shell auto-review (Smart Mode) projection helpers.
- 397-504 tool wrappers: withDynamicToolPlacement (397), withLocalToolScope (417), withRecordedToolCallNames (455), withToolTimeout (475).
- 506-798 factory-input contracts; 800-1044 concrete factory constructors; 1054-1248 factory assembly.
- 1250-1275 TurnToolsetHost (the capability surface every gate reads).
- 1293-1532 buildTurnTools — the ONLY place tools are actually offered.

THE ONE HARD GATE BEFORE ANY TOOL (1298-1304)
`if (host.isSubagentRunner && (host.isComputerUseSubagent || host.isBrowserUseSubagent) === false && turn.subagentConfigs === undefined) return fencedToolSet([], host.spotlightEnabled());` — a plain subagent runner with no subagentConfigs gets ZERO tools.

REGISTRATION ORDER AND GATES (all in buildTurnTools)
1. Task 1324-1364 — `!host.isSubagentRunner && !host.isSharedRoomRunner && turn.subagentConfigs != null`. When `props !== undefined` the builder bypasses `factories.task` and constructs the tool inline (1331-1362) with hard-coded options: readonlyShellEnabled false, allowCustomModelId false, includeExploreSubagent false, requireServerSideSubagent false, isModelBlocked ()=>false, isModelValid ()=>true, useClientSideSubagent true; the child's toolsGenerator is `() => fencedToolSet([], host.spotlightEnabled())` (1336) i.e. subagents spawned this way get no tools of their own.
2. Multitask/TodoWrite 1365-1372 — `!host.isSubagentRunner && !host.isSystemPromptOverridden && host.isMultitaskEnabled?.() === true`.
3-7. SendMessage/SendToAgent/ReactToMessage/CreateAgent/UpdateAgent 1373-1383 — single gate `!host.isSubagentRunner`.
8. update_state 1384-1387 — `!host.isSubagentRunner` AND `!host.isSystemPromptOverridden`.
9-13. ExternalShell/ExternalRead/ExternalAwaitShell/WebSearch/WebFetch 1407-1418 — `!host.isBoxScopedSubagent`. Note WebSearch and WebFetch are gated on the same box-scope flag as the external-machine tools, not on any web capability flag.
14. GenerateImage 1420-1423 — `!host.isSubagentRunner`.
15. CloudAgent 1425-1431 — `!host.isBoxScopedSubagent && !host.cloudAgentsDisabledByTeam()`.
16-19. Shell/Read (box) 1433-1437 — `host.getRemoteBoxAvailable()`; AwaitShell + CopyToBox/CopyFromBox 1438-1443 — additionally `!host.isBoxScopedSubagent`.
20. Computer 1446-1453 — `host.isComputerUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()`.
21. browser_* (16 tools) 1454-1461 — `host.isBrowserUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()`.
22-23. Screenshot + request_box_help 1462-1471 — `!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()`.
24. GetMcpTools + CallMcpTool 1476-1482 — `!host.isBoxScopedSubagent && (props?.mcp !== undefined || dynamicToolRegistry !== undefined)`. Comment at 1473-1475 states a supplied factory alone must stay dormant.
25. MCP management (12 tools) 1483-1485 — `!host.isSubagentRunner`.
26. CheckSubagent/MessageSubagent/StopSubagent 1486-1494 — `!host.isSubagentRunner && turn.subagentConfigs != null`; falls back to `props.hostDependencies.subagentManagement` when no factory (1488-1492).

POST-REGISTRATION FILTERS
- Shared-room allow-list 1497-1504: if `host.isSharedRoomRunner`, the whole list is filtered to SHARED_ROOM_TOOL_NAMES {SendMessage, Shell, Read, AwaitShell, "Screenshot"} (151-157), or to SHARED_ROOM_TEXT_ONLY_TOOL_NAMES {SendMessage} (158-160) when `host.isSharedRoomBoxToolsEnabled?.() === false`. Note the ternary at 1498 keys on `=== false`, so an ABSENT isSharedRoomBoxToolsEnabled method yields the full box set, not text-only.
- Dynamic placement 1506-1508, only when `dynamicToolsEnabled` = `!host.isSubagentRunner && !host.isSharedRoomRunner && !host.isBoxScopedSubagent && host.isDynamicToolsEnabled?.() === true` (1306-1310). withDynamicToolPlacement (397-415) forces update_state and ReactToMessage static (161-164), and demotes to dynamic only the 9 toolIdentifiers in SAND_DYNAMIC_TOOL_HINTS (166-176): CLOUD_AGENT, SEARCH_PLUGINS, AUTHENTICATE_MCP_SERVER, COPY_TO_BOX, COPY_FROM_BOX, REQUEST_BOX_HELP, CHECK_SUBAGENT, MESSAGE_SUBAGENT, STOP_SUBAGENT.
- Timeout wrapping 1509-1529: dynamic-invocation tools get wrapDynamicInvocationToolWithTimeout, everything else withToolTimeout(sandToolCallExecutionTimeoutMs(tool.name, host.isComputerUseSubagent)).

ASYMMETRIES / DEFECTS FOUND (evidence only, no fixes applied)
A. Local-permission action labels are asymmetric: ExternalShell gets action "run-command" (1408), ExternalRead "read-file" (1410), ExternalAwaitShell "read-file" (1412), but the box Shell (1434), box Read (1436) and AwaitShell (1439) are scoped with NO action argument. Any policy keyed on SandLocalToolAction therefore sees box shell execution as an unlabelled scope.
B. File-transfer tools bypass name recording: 1442 wraps CopyToBox/CopyFromBox with `withLocalToolScope(tool, agentId, host.localToolPermission)` directly instead of the `scoped()` helper (1391-1405), so `host.recordModelToolName` is never called for them. Computer (1451), browser_* (1460), Screenshot (1467), request_box_help (1469), MCP meta (1480), MCP management (1485) and subagent management (1493) are likewise never passed through `scoped()`.
C. Two divergent definitions of the external-await tool name exist in the tree: host/sand-activity.ts:5 `SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME = "ExternalAwaitShell"` versus shared/agents/agent-tool-names.ts:6 `SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME = "AwaitExternalShell"`. turn-toolset.ts:9-12 and host-runner-composition.ts:65-70 both import the host/sand-activity.ts copy, so the shipped name is "ExternalAwaitShell"; anything importing the shared copy compares against a string that is never produced. The other five constants agree across both files.
D. `multitask` is spread into the return value of createTurnToolsetFactories at 1069-1071 but is NOT in that function's declared Pick<...> return type (1056-1064), which lists task|mcpMeta|computer|browser|screenshot|fileTransfer|requestBoxHelp|generateImage|webSearch|webFetch|externalAwait|boxAwait|externalShell|externalRead|boxShell|boxRead|sendMessage|sendToAgent|reaction|createAgent|updateAgent|updateState|subagentManagement|mcpManagement|cloudAgent. The multitask factory is consumed at 1370 via `factories.multitask?.()` off the wider TurnToolFactories interface (521).
E. Smart Mode is fail-closed by construction: createTurnShellAutoReviewOptions returns the untouched options when `review === undefined` (344), and resolveTurnShellAutoReviewInputs returns undefined unless autoReview, requestContext and agentId are all present (286-288); modes of "off" produce no review object (296). smartModeApprovalProvider is only attached when mode === "enforce" AND a controller exists (351-360). Fixed hardening constants at 379-384: classifier max attempts, suppressSmartModeClassifierTelemetryIds true, loadSmartModeWorkspacePermissionFiles false, disableSmartModeAllowlistPrecheck true.
F. ToolFactoryContext.autoReviewModes (507-515) declares seven review surfaces — hostShell, boxShell, mcp, computer, automationWrite, cloudAgent, subagentLaunch — but only hostShell and boxShell are consumed anywhere in this file (323-324); mcp, computer, automationWrite, cloudAgent and subagentLaunch are read nowhere in the span. `enforceModelFacingShellUiAutomationGuard` falls back to `modes.hostShell === "enforce" || modes.computer === "enforce"` (318-320), the file's only use of modes.computer.
G. Hidden-prompt filter for the auto-review classifier (1279-1291) keeps user messages that begin with SAND_HIDDEN_PROMPT_MARKER+SAND_TRUSTED_AUTOMATION_PROMPT_MARKER and drops those beginning with SAND_HIDDEN_PROMPT_MARKER alone — the trusted-automation marker is a whitelist that lets injected content reach the classifier context.
H. asGeneratedMcpMetaToolOptions (812-848) always sets `enabled: true` (845) regardless of descriptor count, so an empty MCP projection still produces an enabled options object.

## Tool table

### Task (or "Subagent" on codex prompt versions, "mcp_task" on Composer; packages/agent/tools/task-tool-name.ts:9-14)
- defined: `source/host/runner/tools/turn-toolset.ts:1324-1364 (factory: 851-862)`
- gate: `!host.isSubagentRunner && !host.isSharedRoomRunner && turn.subagentConfigs != null` — turn-toolset.ts:1324-1328
- notes: When props !== undefined the factory slot is ignored and the tool is built inline (1331-1362); child agentConfig.toolsGenerator is `() => fencedToolSet([], host.spotlightEnabled())` (1336), so spawned subagents get no tools. trustedVideoAttachmentRoots = [SAND_BOX_WORKSPACE_ROOT] only when host.remoteBoxHasDesktop (1358-1360).

### TodoWrite (multitask; exact name from getToolName(promptVersion) at packages/agent/tools/core/todo/todo.ts:245-246)
- defined: `source/host/runner/tools/turn-toolset.ts:1365-1372 (factory: 866-873)`
- gate: `!host.isSubagentRunner && !host.isSystemPromptOverridden && host.isMultitaskEnabled?.() === true` — turn-toolset.ts:1365-1369
- notes: Wraps createSandMultitaskTodoTool (source/host/sand-multitask.ts:46-54) which overrides descriptionGenerator with SAND_MULTITASK_TODO_DESCRIPTION. Slot missing from the Pick<> return type at 1056-1064 though spread at 1069-1071.

### SendMessage
- defined: `source/host/runner/tools/turn-toolset.ts:1374-1375 (factory: 986-990; name const source/host/runner/tools/send-message-tool.ts:16)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1373
- notes: The only tool that survives the shared-room text-only filter (SHARED_ROOM_TEXT_ONLY_TOOL_NAMES, 158-160). Duplicate constant also declared at source/host/runner/send-message-reminder-middleware.ts:1.

### SendToAgent
- defined: `source/host/runner/tools/turn-toolset.ts:1376-1377 (factory: 992-996; name const source/host/agents/agent-messaging.ts:6)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1373
- notes: Filtered out entirely in shared-room runners (not in SHARED_ROOM_TOOL_NAMES, 151-157).

### ReactToMessage
- defined: `source/host/runner/tools/turn-toolset.ts:1378-1379 (factory: 998-1002; name const source/host/runner/tools/sand-reaction-tool.ts:6)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1373
- notes: Member of SAND_FORCED_STATIC_TOOL_NAMES (161-164), so withDynamicToolPlacement pins contextType {type:"static"} (398-403) even in dynamic mode.

### CreateAgent
- defined: `source/host/runner/tools/turn-toolset.ts:1380-1381 (factory: 1004-1008; name const source/host/agents/agent-messaging.ts:7)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1373
- notes: Offered only when factories.agentManagement inputs were supplied (1126-1131); createAgent and updateAgent are minted as a pair from the single agentManagement input.

### UpdateAgent
- defined: `source/host/runner/tools/turn-toolset.ts:1382-1383 (factory: 1010-1014; name const source/host/agents/agent-messaging.ts:8)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1373
- notes: Same paired-construction note as CreateAgent.

### update_state
- defined: `source/host/runner/tools/turn-toolset.ts:1384-1387 (factory: 1016-1020; name const source/host/runner/tools/sand-state-tool.ts:8)`
- gate: `!host.isSubagentRunner` (1373) AND `if (!host.isSystemPromptOverridden) {` — turn-toolset.ts:1384
- notes: Second member of SAND_FORCED_STATIC_TOOL_NAMES (161-164): always static placement. Snake_case name, unlike its neighbours.

### ExternalShell
- defined: `source/host/runner/tools/turn-toolset.ts:1408-1409 (factory: 966-973; name const source/host/sand-activity.ts:5, wired at source/host/runner/turn-agent-composition.ts:467)`
- gate: `if (!host.isBoxScopedSubagent) {` — turn-toolset.ts:1407
- notes: Scoped with SandLocalToolAction "run-command" (1408). createShellTool may return undefined (969-972), in which case nothing is pushed. Shell Smart Mode options come from createTurnShellAutoReviewOptions (338-386).

### ExternalRead
- defined: `source/host/runner/tools/turn-toolset.ts:1410-1411 (factory: 975-984; name const source/host/sand-activity.ts:5)`
- gate: `if (!host.isBoxScopedSubagent) {` — turn-toolset.ts:1407
- notes: Scoped with action "read-file". Model-facing description at 138-141 asserts the external machine is reached over a user-approved connection and steers to Read for /home/box.

### ExternalAwaitShell
- defined: `source/host/runner/tools/turn-toolset.ts:1412-1413 (factory: 956-964; name const source/host/sand-activity.ts:5, wired at source/host/host-runner-composition.ts:1151)`
- gate: `if (!host.isBoxScopedSubagent) {` — turn-toolset.ts:1407
- notes: Scoped with action "read-file" — the same action as a file read, though it polls a background shell. NAME CONFLICT: shared/agents/agent-tool-names.ts:6 defines the same constant as "AwaitExternalShell".

### WebSearch (packages/agent/tools/core/web-search.ts:317-318; name varies by promptVersion, "web_search" on dsv3-1018)
- defined: `source/host/runner/tools/turn-toolset.ts:1414-1415 (factory: 944-948)`
- gate: `if (!host.isBoxScopedSubagent) {` — turn-toolset.ts:1407
- notes: No web-specific capability flag anywhere in this file; availability is decided purely by box-scope plus whether the host supplied createWebSearchToolInputs (1190-1192).

### WebFetch (packages/agent/tools/core/web-fetch.ts:128-129; "mcp_web_fetch" on dsv3-1018/dsv3-1205 per web-fetch.ts:51-55)
- defined: `source/host/runner/tools/turn-toolset.ts:1416-1417 (factory: 950-954)`
- gate: `if (!host.isBoxScopedSubagent) {` — turn-toolset.ts:1407
- notes: Same observation as WebSearch. Not scoped through withLocalToolScope.

### GenerateImage (packages/agent/tools/core/generate-image.ts:655-656; "generate_image" on dsv3-1018)
- defined: `source/host/runner/tools/turn-toolset.ts:1421-1422 (factory: 938-942)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1420
- notes: Its own gate block, separate from the box-scope block above it; a box-scoped non-subagent runner still gets GenerateImage.

### CloudAgent
- defined: `source/host/runner/tools/turn-toolset.ts:1429-1430 (factory: 1040-1044; tool literal source/host/cloud-agents/cloud-agent-tool.ts:45)`
- gate: `!host.isBoxScopedSubagent && !host.cloudAgentsDisabledByTeam()` — turn-toolset.ts:1425-1428
- notes: toolIdentifier "CLOUD_AGENT" has a dynamic hint (167), so in dynamic mode it is demoted to dynamic placement with concise context "Launch and manage Cursor cloud coding agents for repository work." cloudAgentsDisabledByTeam is a required method on TurnToolsetHost (1261).

### Shell (box)
- defined: `source/host/runner/tools/turn-toolset.ts:1434-1435 (factory: 966-973; name const source/host/sand-activity.ts:5, wired at source/host/runner/turn-agent-composition.ts:500)`
- gate: `if (host.getRemoteBoxAvailable()) {` — turn-toolset.ts:1433
- notes: Available to box-scoped subagents (no isBoxScopedSubagent check). Scoped WITHOUT an action label, unlike ExternalShell's "run-command" (1408). Default underlying name would be "run-command"/"run_terminal_cmd" (packages/agent/tools/core/shell/create-shell-tool.ts:685) but the host overrides it to "Shell".

### Read (box)
- defined: `source/host/runner/tools/turn-toolset.ts:1436-1437 (factory: 975-984; name const source/host/sand-activity.ts:5, wired at source/host/host-runner-composition.ts:2099)`
- gate: `if (host.getRemoteBoxAvailable()) {` — turn-toolset.ts:1433
- notes: Scoped without an action label. Two distinct descriptions exist for it in this file: SAND_BOX_READ_TOOL_DESCRIPTION (142-145) and SAND_COMPUTER_USE_BOX_READ_TOOL_DESCRIPTION (146-149); neither is referenced anywhere inside turn-toolset.ts.

### AwaitShell
- defined: `source/host/runner/tools/turn-toolset.ts:1439-1440 (factory: 956-964; name const source/host/sand-activity.ts:5, wired at source/host/host-runner-composition.ts:2068)`
- gate: `host.getRemoteBoxAvailable()` (1433) AND `if (!host.isBoxScopedSubagent) {` — turn-toolset.ts:1438
- notes: Scoped without an action label. In SHARED_ROOM_TOOL_NAMES (155) so it survives the shared-room filter when box tools are enabled.

### CopyToBox
- defined: `source/host/runner/tools/turn-toolset.ts:1441-1442 (factory: 926-930; tool literal source/host/runner/tools/sand-file-transfer-tools.ts:150)`
- gate: `host.getRemoteBoxAvailable()` (1433) AND `!host.isBoxScopedSubagent` (1438)
- notes: Wrapped with withLocalToolScope directly at 1442, bypassing the scoped() helper, so host.recordModelToolName is never invoked for it. Dynamic hint COPY_TO_BOX at 170.

### CopyFromBox
- defined: `source/host/runner/tools/turn-toolset.ts:1441-1442 (factory: 926-930; tool literal source/host/runner/tools/sand-file-transfer-tools.ts:162)`
- gate: `host.getRemoteBoxAvailable()` (1433) AND `!host.isBoxScopedSubagent` (1438)
- notes: Same bypass of recordModelToolName as CopyToBox. Dynamic hint COPY_FROM_BOX at 171.

### Computer
- defined: `source/host/runner/tools/turn-toolset.ts:1451-1452 (factory: 908-912; tool literal source/host/runner/tools/sand-computer-tool.ts:252, id OPENAI_COMPUTER_USE)`
- gate: `host.isComputerUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()` — turn-toolset.ts:1446-1450
- notes: Only reachable by a computer-use subagent, which is also the one class of subagent runner that survives the early return at 1298-1304. host.isComputerUseSubagent additionally lengthens/handles tool timeouts at 1517 and 1522.

### browser_navigate, browser_snapshot, browser_click, browser_mouse_click_xy, browser_type, browser_fill, browser_select_option, browser_press_key, browser_scroll, browser_drag, browser_get_bounding_box, browser_highlight, browser_cdp, browser_tabs, browser_take_screenshot (15 specs)
- defined: `source/host/runner/tools/turn-toolset.ts:1459-1460 (factory: 920-924; specs source/host/runner/tools/sand-browser-tools.ts:552-566, built at 595)`
- gate: `host.isBrowserUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()` — turn-toolset.ts:1454-1458
- notes: Pushed as a spread with no local-tool scoping and no name recording (1460). browser_cdp explicitly denies CDP Input.*, browser-wide, storage, cookie, cache, permission and target-management commands per its description (sand-browser-tools.ts:564).

### Screenshot
- defined: `source/host/runner/tools/turn-toolset.ts:1467-1468 (factory: 914-918; tool literal source/host/runner/tools/sand-computer-tool.ts:239, id OPENAI_COMPUTER_USE)`
- gate: `!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()` — turn-toolset.ts:1462-1466
- notes: Listed by literal string in SHARED_ROOM_TOOL_NAMES (156) — the only entry there not sourced from a shared constant. Shares tool id OPENAI_COMPUTER_USE with Computer.

### request_box_help
- defined: `source/host/runner/tools/turn-toolset.ts:1469-1470 (factory: 932-936; tool literal source/host/runner/tools/box-help-tool.ts:78)`
- gate: `!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()` — turn-toolset.ts:1462-1466
- notes: Hands the box desktop to the user for sign-in/manual steps (hint at 172). Snake_case name. Dynamic hint key REQUEST_BOX_HELP.

### GetMcpTools (packages/agent/tools/mcp/get-mcp-tools.ts:26, 269, 389-391; dynamicToolMetaRole "discovery")
- defined: `source/host/runner/tools/turn-toolset.ts:1480-1481 (factory: 880-906)`
- gate: `!host.isBoxScopedSubagent && (props?.mcp !== undefined || dynamicToolRegistry !== undefined)` — turn-toolset.ts:1476-1479
- notes: Descriptors are regenerated per build from input.getMcpTools() (884) and always emitted with `enabled: true` (845). The comment at 1473-1475 states a supplied factory alone is not an MCP service and must stay dormant.

### CallMcpTool (packages/agent/tools/mcp/mcp.ts:447, 525-526)
- defined: `source/host/runner/tools/turn-toolset.ts:1480-1481 (factory: 880-906)`
- gate: `!host.isBoxScopedSubagent && (props?.mcp !== undefined || dynamicToolRegistry !== undefined)` — turn-toolset.ts:1476-1479
- notes: Built alongside GetMcpTools as a pair (904). In dynamic mode its invocation role routes through wrapDynamicInvocationToolWithTimeout (1509-1519) using resolveDynamicDispatchToolName (1317-1319).

### SearchPlugins
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (factory: 1028-1038; tool literal source/host/runner/tools/sand-mcp-management-tools.ts:315)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1483
- notes: toolIdentifier SEARCH_PLUGINS has a dynamic hint (168) so it is demoted to dynamic placement when dynamic mode is on.

### GetPlugin
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:324)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1483
- notes: Read-only detail lookup by stable plugin id.

### InstallPlugin
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:331)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1483
- notes: Mutates the user's account; its guardrail ("only call after the user has agreed") lives in the description string, not in a code gate in this file.

### AddMcpServer
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:343)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1483
- notes: Description states only remote http/sse MCP servers are supported and local/stdio are not (sand-mcp-management-tools.ts:343).

### UninstallMcpServer
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:356)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1483
- notes: Description text varies on a `multiAccount` flag internal to createMcpManagementTools (isMultiAccountEnabled, passed at 1035).

### UninstallPlugin
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:369)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1483
- notes: Destructive; also multiAccount-conditional description.

### GetMcpServerStatus
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:380)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1483
- notes: Read-only status listing.

### SetMcpInstructions
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:390)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1483
- notes: Persists per-connector custom instructions that the model then follows on later turns.

### RestartMcpServers
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:399)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1483
- notes: Empty parameter schema (z.object({})).

### AuthenticateMcpServer
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:405)`
- gate: `if (!host.isSubagentRunner) {` — turn-toolset.ts:1483
- notes: toolIdentifier AUTHENTICATE_MCP_SERVER has a dynamic hint (169). Registered at a different nesting level in sand-mcp-management-tools.ts (405) than the block at 315-399, so it may be unconditional while others are conditional — see unverified.

### RemoveMcpAccount
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:419)`
- gate: `!host.isSubagentRunner` (1483) plus an internal multi-account condition in sand-mcp-management-tools.ts around line 419
- notes: Indentation and the multiAccount-conditional sibling descriptions indicate a nested `if` I did not read line-by-line; see unverified.

### RenameMcpAccount
- defined: `source/host/runner/tools/turn-toolset.ts:1484-1485 (tool literal source/host/runner/tools/sand-mcp-management-tools.ts:429)`
- gate: `!host.isSubagentRunner` (1483) plus the same internal multi-account condition
- notes: Same caveat as RemoveMcpAccount.

### CheckSubagent
- defined: `source/host/runner/tools/turn-toolset.ts:1487-1493 (factory: 1022-1026; tool literal source/host/runner/tools/sand-subagent-management-tools.ts:90)`
- gate: `!host.isSubagentRunner` (1483) AND `if (turn.subagentConfigs != null) {` — turn-toolset.ts:1486
- notes: Falls back to constructing from props.hostDependencies.subagentManagement when factories.subagentManagement is absent (1488-1492). Dynamic hint CHECK_SUBAGENT at 173.

### MessageSubagent
- defined: `source/host/runner/tools/turn-toolset.ts:1487-1493 (tool literal source/host/runner/tools/sand-subagent-management-tools.ts:112)`
- gate: `!host.isSubagentRunner` (1483) AND `turn.subagentConfigs != null` (1486)
- notes: Dynamic hint MESSAGE_SUBAGENT at 174. Not scoped through scoped()/withLocalToolScope.

### StopSubagent
- defined: `source/host/runner/tools/turn-toolset.ts:1487-1493 (tool literal source/host/runner/tools/sand-subagent-management-tools.ts:132)`
- gate: `!host.isSubagentRunner` (1483) AND `turn.subagentConfigs != null` (1486)
- notes: Dynamic hint STOP_SUBAGENT at 175.


## Did not verify

- Exact model-facing names for Task, TodoWrite/multitask, WebSearch, GenerateImage, Read, AwaitShell and Shell depend on promptVersion / parentModelInfo / an options.toolName override resolved OUTSIDE this file (packages/agent/tools/task-tool-name.ts:9-14; core/todo/todo.ts:246; core/web-search.ts:191-197; core/generate-image.ts:205-211; core/read/read.ts:317; core/await.ts:346; core/shell/create-shell-tool.ts:685). I confirmed the host overrides Shell/ExternalShell (turn-agent-composition.ts:467,500) and the Read/Await names (host-runner-composition.ts:1151,2068,2081,2099) but did NOT read those call sites end to end, so the promptVersion-dependent variants for Task, TodoWrite, WebSearch and GenerateImage are not pinned.
- The internal conditional structure of createMcpManagementTools (source/host/runner/tools/sand-mcp-management-tools.ts) was grepped, not read end to end. AuthenticateMcpServer (line 405), RemoveMcpAccount (419) and RenameMcpAccount (429) sit at different indentation from the block at 315-399, which suggests per-tool `if` gates (likely on the multiAccount / isMultiAccountEnabled argument passed at turn-toolset.ts:1035), but I did not verify those conditions.
- sand-browser-tools.ts:552-566 lists 15 browser_* specs built through a loop at line 595; I read only the grep-matched spec lines, so I cannot rule out additional specs added elsewhere in that file or a filter applied inside createSandBrowserTools.
- Who sets host.isDynamicToolsEnabled, isMultitaskEnabled, isSharedRoomBoxToolsEnabled, isSystemPromptOverridden, isBoxScopedSubagent, isComputerUseSubagent, isBrowserUseSubagent, remoteBoxHasDesktop, getRemoteBoxAvailable and cloudAgentsDisabledByTeam — these are declared on TurnToolsetHost (1250-1275) but their production values come from host-runner-composition.ts / turn-agent-composition.ts, which I did not read. Every gate above is stated in terms of these flags, not in terms of the settings or entitlements behind them.
- Whether props.mcp being defined actually corresponds to a live MCP service (the gate at 1476-1479 only checks `props?.mcp !== undefined`); the shape and provenance of ProductionTurnToolInputs.mcp lives in source/host/runner-production-bridge.ts, unread.
- sandToolCallExecutionTimeoutMs and wrapDynamicInvocationToolWithTimeout (imported from ./mcp-meta-tools.js, used at 1514-1523) — the actual per-tool timeout values and the computer-use adjustment were not read.
- fencedToolSet (imported from ./sand-spotlight-tools.js, used at 1303, 1336, 1531) — whether it applies any further filtering or spotlight gating on top of the list built here was not verified.
- Whether the two divergent SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME definitions (host/sand-activity.ts:5 = "ExternalAwaitShell" vs shared/agents/agent-tool-names.ts:6 = "AwaitExternalShell") cause an actual runtime mismatch depends on which consumers import the shared copy; I confirmed the two definitions and the two importers I grepped (turn-toolset.ts, host-runner-composition.ts) both use the host copy, but did not enumerate every consumer of the shared copy.
- Whether the createTurnToolsetFactories Pick<> omission of "multitask" (1056-1064 vs 1069-1071) actually fails the TypeScript build — I did not run tsc (read-only constraint) and did not check for a build/CI log in the repo.