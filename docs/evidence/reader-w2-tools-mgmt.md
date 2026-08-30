# Reader output: w2:tools-mgmt

# Evidence-grade read: 4 sand tool files (agent mgmt, subagent mgmt, file transfer, spotlight)

All four files read end to end (170 / 143 / 173 / 37 lines). Repo root `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb`. Paths below are absolute-relative to that root as `source/...`.

## 1. Shared construction mechanism

- All 8 tools in these files are built by `defineCommunicateTool(dependencies, spec)` — `source/host/runner/tools/communicate-tool.ts:124`. It calls `createZodAgentTool(spec.id, {...})` (`source/packages/agent/tools/common.ts:114`), so **`spec.id` becomes `toolIdentifier`** and `spec.name` becomes the model-visible tool name.
- Every such tool's transport is the protobuf `CommunicateUpdateToolCall` (`communicate-tool.ts:23-32, 69-79`). Args are marshalled as a JSON "sand step" tagged `__sand_tool__` (`communicate-tool.ts:15,19-21`).
- `execute` is wrapped in try/catch → any thrown error becomes a **model-visible string** via `buildErrorResult` (`communicate-tool.ts:154-156`, `109-111`). So `BoxTransferError` messages reach the model verbatim.
- `describeActivity` emits an in-flight "executing" card with optional `detail`/`target` (`communicate-tool.ts:139-146`).
- Render is `makeRender()` → `createStringResult(raw)` (`communicate-tool.ts:113-121`), and `createStringResult` returns `{content:[{type:"text",...}]}` (`source/packages/chat-inference/prompt-executor.ts:3`). **Consequence: every one of these tools' results is an array, so spotlight fencing always applies to them when enabled** (see §5).
- Per-call execution guard: `sandToolCallExecutionTimeoutMs` (`source/host/runner/tools/mcp-meta-tools.ts:6-11`) → `toolCallExecutionGuardMs` (`source/packages/agent/tools/tool-execution-timeout.ts:41-48`). None of these 8 names is in `LONG_RUNNING_TOOL_NAMES` (`tool-execution-timeout.ts:1`), so all get the SHORT tier 15 min minus 60 s headroom = **840 000 ms (14 min)**.

## 2. Agent creation / editing / peer messaging — `source/host/runner/tools/sand-agent-management-tools.ts`

Tool names come from constants: `SendToAgent`, `CreateAgent`, `UpdateAgent` (`source/host/agents/agent-messaging.ts:6-8`).

**SendToAgent** (`:99-128`, id `SEND_TO_TASK` at `:103`)
- Params (`:45-68`): `target_id` (required, "agent OR GROUP you belong to… not a name"), `message` (required), `images[]` (optional `{url, alt}`), `priority` (optional boolean).
- Image URLs validated by `isValidAttachmentUrl` — accepts **only `file:` or `https:` protocols** (`source/host/runner/tools/send-message-schema.ts:13`), enforced in a `superRefine` (`:58-68`).
- Self-send guard: if `getSelfAgentId()` equals `target_id`, returns a refusal string, no side effect (`:111-114`).
- `priority` is normalized to `true | undefined` before hitting the dependency (`:124`); the dependency signature types it `priority?: true` (`:23`).
- Images pass through optional `resolveImageSource(context, url)` per image (`resolveSendToAgentImages`, `:83-97`); `alt` is dropped when empty (`:93-94`). Empty array is sent as `undefined` (`:123`).
- Description (`:105`) states: fire-and-forget/async, does **not** return a reply, peer messages run ahead of automations, `priority=true` interrupts the recipient's current non-user turn (1:1 only, ignored for groups), groups are **text-only** (images not delivered), and instructs against fan-out without explicit user consent and against relaying the user's unfiltered words.
- `describeActivity` surfaces `target: target_id` (`:107-109`).

**CreateAgent** (`:130-144`, id `CREATE_TASK` at `:132`)
- Params (`:70-75`): `name` (required, min 1), `description` (`.default("")` — optional, empty string when omitted).
- Calls `management.create({name, description})` and returns `Created agent "<name>" (id: <id>). Message it with SendToAgent using that id.` (`:141`).
- Description explicitly states **there is no delete tool**; deletion is a user action from the sidebar right-click → "Delete" (`:134`; corroborated in the prompt text at `source/host/agents/agent-messaging.ts:47`).
- No `describeActivity` → no target/detail on the in-flight card, unlike the other two.

**UpdateAgent** (`:146-170`, id `PLATFORM_ACTION` at `:148`)
- Params (`:77-81`): `agent_id` required; `name`/`description` both optional and **not** `.min(1)`-constrained at the schema level.
- Execute builds a sparse patch, skipping empty strings (`:157-160`) — so a whitespace-only value cannot blank a field. If both are absent/empty it returns `"Nothing to update: provide a new name and/or description."` with no call to `update` (`:161-163`).
- `update` returning `null` yields `No agent found with id <id>.` (`:165-167`).
- No clear/delete path exists through this tool (`:150`).

**Wiring/gate for all three**: `createTurnToolFactories` maps `input.agentManagement` → both `createAgent` and `updateAgent` factories (`source/host/runner/tools/turn-toolset.ts:1126-1131`); the provider path is `createAgentManagementToolInputs` (`turn-toolset.ts:1223-1225`), supplied in production at `source/host/host-runner-composition.ts:2057-2059` from `dependencies.agentManagement` (contract at `source/host/runner-production-bridge.ts:302-311`). `sendToAgent` factory is supplied at `host-runner-composition.ts:2046-2048`. Offer gate is a single `if (!host.isSubagentRunner)` block that pushes SendMessage, SendToAgent, Reaction, CreateAgent, UpdateAgent (`turn-toolset.ts:1370-1382`). **Subagents never get any of them.**

## 3. Subagent dispatch control — `source/host/runner/tools/sand-subagent-management-tools.ts`

Controller contract `SubagentManagementController` (`:15-24`): `listRunningSubagents`, `getRunningSubagent`, `steerSubagent`, `abortSubagent`, plus an **optional `reviewSteer`** auto-review hook.

**CheckSubagent** (`:88-109`, id `CHECK_SUBAGENT`)
- Param `subagent_id` optional; omitted → list mode (`:26-30`, `:94-103`).
- List mode returns count + one header line per running subagent (`describeRunningSubagent` non-detailed, `:59-60`), plus a nudge to pass an id.
- Detail mode adds recent activity oldest→newest and, when present, `transcriptPath` labelled "Full transcript (read it for the complete play-by-play)" (`:62-70`). **This hands the parent a filesystem path to read the subagent's live transcript.**
- Header format includes id, subagentType, quoted title, `elapsedLabel` and tool-call count (`:59`). `elapsedLabel` (`:47-53`): `<90 s` → seconds; otherwise `Nm` or `Nm Ss`.
- Explicitly documented as read-only and NOT a completion poll (`:91`).

**MessageSubagent** (`:110-129`, id `MESSAGE_SUBAGENT`)
- Params: `subagent_id` + `message`, both required min 1 (`:32-39`).
- **Auto-review gate**: if `reviewSteer` is present it is awaited first with `{subagentId, message, toolCallId}`; `allowed === false` short-circuits and returns `review.reason` as the tool result — no steer occurs (`:116-123`). `toolCallId` is injected by `defineCommunicateTool` (`communicate-tool.ts:155`).
- `steerSubagent(...) === "not-running"` → `notRunningMessage(...)`; any other return value is treated as success (`:124-127`). Note the controller type allows an arbitrary `string` return (`:18`) and only the literal `"not-running"` is checked.
- Success string tells the parent the subagent keeps its context and not to wait (`:127`).
- Description says post-completion follow-up must use `Task` with `resume` instead (`:113`).

**StopSubagent** (`:130-141`, id `STOP_SUBAGENT`)
- Param `subagent_id` required (`:41-45`). Same `"not-running"`-only check (`:136-138`).
- Description: tears the subagent down, frees its box desktop window, no separate revival — this tool result is the confirmation (`:133`).

**`notRunningMessage`** (`:74-82`) leaks the full list of currently running subagent ids into the error text.

**Gate**: offered only when `!host.isSubagentRunner` AND `turn.subagentConfigs != null` (`turn-toolset.ts:1481,1484`). Factory resolution has a fallback: `factories.subagentManagement?.()` else build one from `props.hostDependencies.subagentManagement` (`turn-toolset.ts:1486-1493`). Production controller is `createRunnerSubagentManagement(builtRunner)` (`host-runner-composition.ts:1956`, defined `:777-786`), which forwards to `SandAgentRunner` (`source/host/runner/sand-agent-runner.ts:789-803`) → `subagent-runtime.ts:412,425,441`.
- **Finding: `reviewSteer` has no producer anywhere in this tree.** Only three occurrences exist, all inside the tool file (`:20`, `:116`, `:117`), and `createRunnerSubagentManagement` (`host-runner-composition.ts:781-785`) supplies exactly four methods, not `reviewSteer`. So MessageSubagent auto-review is dead in the reconstruction.

## 4. File transfer — `source/host/runner/tools/sand-file-transfer-tools.ts`

**CopyToBox** (`:148-159`, id `COPY_TO_BOX`)
- Params (`:32-42`): `computer_path` required absolute path on the user's machine; `box_path` optional; `computer` optional selector.
- Default destination: `/workspace/uploads/<posix.basename(computer_path)>` (`:99-102`, `SAND_BOX_UPLOADS_DIR = "/workspace/uploads"` at `source/host/box/box-transfer.ts:4`). Relative `box_path` resolves against `/workspace` (`resolveBoxWorkspacePath`, `box-transfer.ts:7`).
- Success string reports source, computer label, destination path and human-formatted size (`:117`).

**CopyFromBox** (`:160-171`, id `COPY_FROM_BOX`)
- Params (`:44-54`): `box_path` required (globs must be pre-expanded by the model); `computer_path` optional; `computer` optional.
- Default destination on the computer is `posix.basename(boxPath)` — a bare relative name, landing in the ExternalShell cwd (`:128`, description at `:49`).

**Shared preconditions**
- `assertBoxReady` throws `BoxTransferError(SAND_BOX_NOT_READY_MESSAGE)` when `isBoxPreparing()` (`:88-90`; message text at `source/host/ports/box.ts:1`).
- `resolveComputerOrThrow` (`:68-86`) distinguishes "no computer connected" from "unknown computer id", and **both error strings enumerate every known computer id with an `(offline)` marker** (`:75-85`). The no-computer message names the product: "the Grok Bot desktop app must be open and online" (`:80`).
- `describeActivity` surfaces only the basename via `fileBasename` (`:153-156`, `:165-168`).

**Contradiction between description and implementation**: both tool descriptions promise "Any file type and any size" (`:151`, `:163`, and params `:34`, `:46`), but `transferFileBetweenBoxes` buffers the whole file into a `Uint8Array` and rejects anything over `DEFAULT_BOX_TRANSFER_MAX_BYTES` = **256 MiB** (`source/host/box/box-transfer.ts:10,15`). Transfer is download-then-upload in host memory, not streamed.

**`formatBytes`** (`:56-66`): under 1024 → `"N bytes"`; otherwise KB/MB/GB only, capping at GB; 0 decimals when the value is ≥10 or integral, else 1 decimal.

**Gate**: pushed only inside `if (host.getRemoteBoxAvailable())` and then `if (!host.isBoxScopedSubagent)` (`turn-toolset.ts:1428,1438-1442`), each tool wrapped with `withLocalToolScope(tool, agentId, host.localToolPermission)` — **with no `action` argument**, unlike ExternalShell (`"run-command"`) and ExternalRead (`"read-file"`) at `turn-toolset.ts:1408-1412`. `withLocalToolScope` omits `action` from the scope object when undefined (`turn-toolset.ts:437-438`).
- **Finding: nothing in this tree supplies the file-transfer controller to the toolset.** `createFileTransferController` is defined once (`source/host/runner/runner-prompt-glue.ts:79-85`) and has **zero consumers** (grep across `source/`), and no provider implements `createFileTransferToolInputs` (`turn-toolset.ts:721` declares it; only `turn-toolset.ts:1181-1183` reads it). So `factories.fileTransfer` is always undefined and **CopyToBox/CopyFromBox are unreachable in the reconstructed wiring**.

## 5. Spotlight / tool-set fencing — `source/host/runner/tools/sand-spotlight-tools.ts`

- `withSpotlightedToolResult` (`:15-27`): returns the tool unchanged if it has no `render`; otherwise wraps `render` so an **array** `result.content` is passed through `spotlightToolResultContent(tool.name, ...)`. Non-array content is passed through untouched (`:21-23`).
- Fence mechanics live in `source/shared/sand-spotlight.ts`: tag is `cursor_untrusted_data_1337` (`:1`); adjacent text parts are merged and any literal tag occurrence inside the payload is rewritten to `cursor_untrusted_data_redacted` (`:3`, `:11-12`); the source attribute is sanitized of `"`, `<`, `>` (`:4`); an open part and close part bracket the body (`:13`). Empty content is returned unfenced (`:9`).
- **The fence source is `tool.name`** (`:22`). Because communicate-tool results are always text arrays (§1), an agent's own confirmations — e.g. `Created agent "X" (id: …)` — get wrapped in the untrusted-data fence too.
- `fencedToolSet(tools, enabled, dynamicToolRegistry?)` (`:28-37`): when `enabled` is false it copies the array and applies **no** fencing (`:33`). Without a registry it returns `ToolSetHandle.fromTools(finalTools)`; with one it splits via `partitionDynamicTools(finalTools, "final")` and builds the static/dynamic handle (`:34-36`).
- `enabled` comes from `host.spotlightEnabled()` (`turn-toolset.ts:1303,1336,1531`), backed by `experiments.isSpotlightEnabled?.() ?? false` (`host-runner-composition.ts:2321`) or `host.isSpotlightEnabled?.() !== false` (`source/host/runner/prompt-collector-glue.ts:435`) — two different defaults on the two paths (false vs true).
- The matching system-prompt section is `spotlightPromptSection` (`source/shared/sand-spotlight.ts:16-19`) — fenced content is data, never instructions; forged fences/claims of being the user are called out; one carve-out for Auto-review notices about the agent's own tool call.

## 6. Cross-cutting placement facts

- **Dynamic offload**: `partitionDynamicTools(..., "final")` (`source/packages/agent/tools/exclude-tools.ts:62-85`) sends any tool to the dynamic set unless its identifier is `ASK_QUESTION` or in `BASE_STATIC_NATIVE_TOOL_IDENTIFIERS` (`exclude-tools.ts:17-35`). **None** of `SEND_TO_TASK`, `CREATE_TASK`, `PLATFORM_ACTION`, `COPY_TO_BOX`, `COPY_FROM_BOX`, `CHECK_SUBAGENT`, `MESSAGE_SUBAGENT`, `STOP_SUBAGENT` is in that set, so all eight are offload-eligible.
- **Hint asymmetry**: `SAND_DYNAMIC_TOOL_HINTS` (`turn-toolset.ts:166-176`) has entries for `COPY_TO_BOX`, `COPY_FROM_BOX`, `CHECK_SUBAGENT`, `MESSAGE_SUBAGENT`, `STOP_SUBAGENT` — but **not** for `SEND_TO_TASK`, `CREATE_TASK`, or `PLATFORM_ACTION`. `withDynamicToolPlacement` (`turn-toolset.ts:397-415`) only assigns `contextType: {type:"dynamic", conciseStaticContext: hint}` when a hint exists, so SendToAgent/CreateAgent/UpdateAgent go dynamic with no static context line.
- `UpdateAgent` carries identifier `PLATFORM_ACTION`, which has a special static-pin branch in `partitionDynamicTools` (`exclude-tools.ts:71-72`) keyed on `isSubagentExcludedPlatformCommunicationToolName(tool.name)`. That set is Slack/Teams/PR names only (`source/packages/agent/automations/platform-communication-tools.ts:29-38`) — `"UpdateAgent"` is not in it, so the pin does not apply.
- **Shared-room filter**: when `host.isSharedRoomRunner`, the offered set is intersected with `SHARED_ROOM_TOOL_NAMES` = SendMessage, box Shell, box Read, box Await, `"Screenshot"` (`turn-toolset.ts:151-157`, applied `:1496-1503`). **All eight tools here are filtered out in shared rooms**, and the text-only variant keeps SendMessage alone (`:158-160`).
- **Empty toolset short-circuit**: a plain (non-computerUse/non-browserUse) subagent with no `subagentConfigs` gets `fencedToolSet([], …)` — zero tools (`turn-toolset.ts:1298-1304`).
- Identifier lineage is Cursor-flavored and does not match the user-facing names: `SendToAgent`→`SEND_TO_TASK`, `CreateAgent`→`CREATE_TASK`, `UpdateAgent`→`PLATFORM_ACTION` (`sand-agent-management-tools.ts:103,132,148`). Telemetry spans are attributed by identifier, not name (`source/packages/agent/tools/common.ts:130`).

## 7. Smaller observations (factual, from the read)

- `sand-file-transfer-tools.ts:101` uses `posix.basename` on `computer_path`, which the schema describes as a path on the **user's computer** (`:34`). A backslash-separated path would not be split by `posix.basename`.
- `SandTool` in `sand-spotlight-tools.ts:9` declares `dynamic?: boolean`, but `fencedToolSet`/`withSpotlightedToolResult` never read it (`:15-37`).
- `sand-spotlight-tools.ts` uses a non-null assertion `tool.render!` at `:20` after the `undefined` guard at `:16`.
- `SendToAgentDependencies` and `SubagentManagementController` both carry an unused `_Context` type parameter (`sand-agent-management-tools.ts:16`, `sand-subagent-management-tools.ts:15`).
- `AgentImage` (`sand-agent-management-tools.ts:11-14`) is the exported shape the send path receives — `{url, alt?}` only; no mime/size metadata.

## Tool table

### SendToAgent
- defined: `source/host/runner/tools/sand-agent-management-tools.ts:99-128 (name const source/host/agents/agent-messaging.ts:6)`
- gate: `if (!host.isSubagentRunner)` block — `const sendToAgent = factories.sendToAgent?.(); if (sendToAgent !== undefined) tools.push(sendToAgent);` at source/host/runner/tools/turn-toolset.ts:1370,1373-1374. Factory exists only when `input.sendToAgent !== undefined` (turn-toolset.ts:1120-1122), supplied by `createSendToAgentToolInputs` at source/host/host-runner-composition.ts:2046-2048. Also filtered out entirely in shared rooms (turn-toolset.ts:151-157,1496-1503).
- notes: toolIdentifier SEND_TO_TASK (:103). Params target_id/message/images[]/priority (:45-68). Image urls restricted to file:/https: via isValidAttachmentUrl (source/host/runner/tools/send-message-schema.ts:13). Self-send blocked (:111-114). priority normalized to true|undefined (:124). Fire-and-forget; groups are text-only (no images) per description (:105). describeActivity target=target_id (:107-109). No SAND_DYNAMIC_TOOL_HINTS entry, so dynamic placement gets no conciseStaticContext (turn-toolset.ts:166-176,404-407).

### CreateAgent
- defined: `source/host/runner/tools/sand-agent-management-tools.ts:130-144 (name const source/host/agents/agent-messaging.ts:7)`
- gate: Same `if (!host.isSubagentRunner)` block, turn-toolset.ts:1370,1377-1378. Factory pair created only when `input.agentManagement !== undefined` (turn-toolset.ts:1126-1131); provider `createAgentManagementToolInputs` supplied at host-runner-composition.ts:2057-2059 from `dependencies.agentManagement` (contract runner-production-bridge.ts:302-311).
- notes: toolIdentifier CREATE_TASK (:132). Params: name required min1; description `.default("")` (:70-75). Returns `Created agent "<name>" (id: <id>)...` (:141). Description states no delete tool exists; user deletes from sidebar right-click (:134; echoed agent-messaging.ts:47). No describeActivity, so its in-flight card carries no target/detail.

### UpdateAgent
- defined: `source/host/runner/tools/sand-agent-management-tools.ts:146-170 (name const source/host/agents/agent-messaging.ts:8)`
- gate: Same `if (!host.isSubagentRunner)` block, turn-toolset.ts:1370,1379-1380; same agentManagement input gate (turn-toolset.ts:1126-1131).
- notes: toolIdentifier PLATFORM_ACTION (:148) — not pinned static because `"UpdateAgent"` is absent from isSubagentExcludedPlatformCommunicationToolName's set (exclude-tools.ts:71-72; platform-communication-tools.ts:29-38). Sparse patch: empty strings skipped (:157-160); both empty → "Nothing to update" with no update call (:161-163); null result → "No agent found with id" (:165-167). No clear/delete path (:150). describeActivity target=agent_id (:152-154).

### CheckSubagent
- defined: `source/host/runner/tools/sand-subagent-management-tools.ts:88-109`
- gate: `if (!host.isSubagentRunner) { ... if (turn.subagentConfigs != null) { ... push subagent mgmt tools } }` — turn-toolset.ts:1481,1484-1493. Controller resolved from `factories.subagentManagement?.()` or fallback `props.hostDependencies.subagentManagement` (turn-toolset.ts:1486-1492); production controller createRunnerSubagentManagement(builtRunner) at host-runner-composition.ts:1956 (def :777-786).
- notes: toolIdentifier CHECK_SUBAGENT. subagent_id optional → list mode vs detail mode (:26-30,:94-107). Detail mode exposes recentActivity and a transcriptPath the parent is told to Read (:62-70). Header format at :59; elapsedLabel at :47-53. Read-only, explicitly not a completion poll (:91). Has a dynamic hint entry (turn-toolset.ts:172).

### MessageSubagent
- defined: `source/host/runner/tools/sand-subagent-management-tools.ts:110-129`
- gate: Same gate as CheckSubagent (turn-toolset.ts:1481,1484-1493).
- notes: toolIdentifier MESSAGE_SUBAGENT. Optional auto-review pre-gate `reviewSteer(context,{subagentId,message,toolCallId})`; !allowed returns review.reason and skips the steer (:116-123). FINDING: reviewSteer has no producer in this tree — only 3 occurrences, all in this file (:20,:116,:117); createRunnerSubagentManagement supplies only 4 methods (host-runner-composition.ts:781-785). Only the literal "not-running" is treated as failure (:124-126) though the controller type permits arbitrary string (:18). Description routes post-completion follow-up to Task+resume (:113). Dynamic hint at turn-toolset.ts:173.

### StopSubagent
- defined: `source/host/runner/tools/sand-subagent-management-tools.ts:130-141`
- gate: Same gate as CheckSubagent (turn-toolset.ts:1481,1484-1493).
- notes: toolIdentifier STOP_SUBAGENT. abortSubagent; only "not-running" checked (:136-138). Description: tears down the subagent, frees its box desktop window, no separate revival — the tool result is the confirmation (:133). No auto-review hook of any kind on this destructive path (contrast MessageSubagent's reviewSteer). Dynamic hint at turn-toolset.ts:174.

### CopyToBox
- defined: `source/host/runner/tools/sand-file-transfer-tools.ts:148-159`
- gate: `if (host.getRemoteBoxAvailable()) { ... if (!host.isBoxScopedSubagent) { ... const fileTransfer = factories.fileTransfer?.(); if (fileTransfer !== undefined) tools.push(...) } }` — turn-toolset.ts:1428,1438,1441-1442. FINDING: no provider supplies fileTransfer inputs in this tree — createFileTransferToolInputs is declared (turn-toolset.ts:721) and read (1181-1183) but never implemented, and createFileTransferController (source/host/runner/runner-prompt-glue.ts:79-85) has zero consumers. So the gate is never satisfied here.
- notes: toolIdentifier COPY_TO_BOX. Params computer_path (req), box_path (opt), computer (opt) at :32-42. Defaults to /workspace/uploads/<posix.basename(computer_path)> (:99-102; SAND_BOX_UPLOADS_DIR box-transfer.ts:4); relative box_path resolves under /workspace (box-transfer.ts:7). Preconditions: assertBoxReady (:88-90) and resolveComputerOrThrow (:68-86), whose errors enumerate all known computer ids with (offline) markers and name the Grok Bot desktop app (:80). Description claims "any size" but transferFileBetweenBoxes caps at 256 MiB and buffers whole file in memory (box-transfer.ts:10,15). Wrapped with withLocalToolScope WITHOUT an action arg (turn-toolset.ts:1442), unlike ExternalShell/ExternalRead (:1408-1411).

### CopyFromBox
- defined: `source/host/runner/tools/sand-file-transfer-tools.ts:160-171`
- gate: Identical to CopyToBox — same getRemoteBoxAvailable + !isBoxScopedSubagent + factories.fileTransfer block at turn-toolset.ts:1428,1438,1441-1442; same unwired-controller finding.
- notes: toolIdentifier COPY_FROM_BOX. Params box_path (req), computer_path (opt), computer (opt) at :44-54; model told to pre-expand globs (:46). Default destination is posix.basename(boxPath) — bare relative name landing in the ExternalShell cwd (:128). Same 256 MiB cap and "any size" description mismatch. describeActivity emits basename only (:165-168). Dynamic hint at turn-toolset.ts:171.


## Did not verify

- Whether CopyToBox/CopyFromBox are actually reachable in the real shipped 0.18 build. In THIS tree they are provably unwired (no createFileTransferToolInputs implementation; createFileTransferController at source/host/runner/runner-prompt-glue.ts:79 has zero consumers), but I cannot tell whether that is a reconstruction gap or the shipped state.
- Whether reviewSteer (source/host/runner/tools/sand-subagent-management-tools.ts:20) is supplied by anything outside source/ (e.g. a compiled bundle or an installer artifact). I only grepped source/**/*.ts.
- Downstream consequence of SEND_TO_TASK / CREATE_TASK / PLATFORM_ACTION having no SAND_DYNAMIC_TOOL_HINTS entry — I did not read the prompt-rendering code that consumes contextType/conciseStaticContext, so I cannot say whether SendToAgent/CreateAgent/UpdateAgent become invisible, unlabeled, or unaffected when dynamic tools are enabled.
- Runtime behavior of dependencies.sendToAgent (delivery, group fan-out, priority interruption, whether images actually reach a 1:1 recipient). I read only the tool-side contract at sand-agent-management-tools.ts:16-25 and its wiring point at host-runner-composition.ts:2046.
- Actual semantics of steerSubagent/abortSubagent/listRunningSubagents in source/host/runner/subagent-runtime.ts:412,425,441 — I confirmed the call chain but did not read those function bodies end to end, so 'context preserved', 'frees its box desktop window', and the meaning of non-"not-running" return strings are description claims, not verified behavior.
- Whether transcriptPath returned by CheckSubagent is readable by the parent's Read tool (path scope/permission), and whether it can point outside the agent's sandbox.
- Whether resolveImageSource is ever supplied in production (it is optional at sand-agent-management-tools.ts:18); I did not trace the sendToAgent dependency object's fields.
- Group messaging: ListGroups, group id resolution, and whether target_id ambiguity between agent ids and group ids is disambiguated anywhere. Not read.
- Auto-review coverage for CopyToBox/CopyFromBox and for CreateAgent/UpdateAgent — I found no reviewer hook in these files, but I did not audit the auto-review controller (turn-toolset.ts:283 props.hostDependencies?.autoReview) to see whether it intercepts by tool name elsewhere.
- Which of the two spotlightEnabled defaults is live in production (host-runner-composition.ts:2321 defaults false; source/host/runner/prompt-collector-glue.ts:435 defaults true). I did not determine which path builds the production host.
- Whether the SandTool.dynamic field (source/host/runner/tools/sand-spotlight-tools.ts:9) is set by any producer — it is unread within this file, but I did not grep repo-wide for a writer.
- Behavior of ToolSetHandle.fromTools' object-form overload and the DynamicToolRegistry.replaceTools contract beyond the class body at source/packages/agent/tools/core.ts:60-100.
- Whether the posix.basename call on a Windows-style computer_path (sand-file-transfer-tools.ts:101) is a real defect — depends on whether the desktop app ever runs on Windows, which I did not establish.