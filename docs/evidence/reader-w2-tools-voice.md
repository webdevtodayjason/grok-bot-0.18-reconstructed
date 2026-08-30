# Reader output: w2:tools-voice

SCOPE: all five files read end to end (134 / 53 / 55 / 336 / 181 lines). Paths below are relative to /Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb.

== TOOL TABLE (these 5 files) ==
Exactly TWO model-facing tools are defined across the five files.
1. `SendMessage` — source/host/runner/tools/send-message-tool.ts:101, agent-tool id "SEND_MESSAGE".
2. `update_state` — source/host/runner/tools/sand-state-tool.ts:315, agent-tool id "PLATFORM_ACTION".
Zero tools in the other three files:
- send-message-schema.ts defines only the zod schema + cross-field refiner (no tool).
- send-message-encoding.ts defines only proto encoders/helpers (no tool).
- communicate-tool.ts defines the shared FACTORY `defineCommunicateTool` (:124) used by 9+ other tool modules (sand-agent-management-tools.ts:102/131/147, sand-subagent-management-tools.ts:88/110/130, sand-reaction-tool.ts:24, box-help-tool.ts:76, sand-file-transfer-tools.ts:148/160, sand-mcp-management-tools.ts:314-428, sand-state-tool.ts:325) — it registers no tool of its own.

== update_state: TARGETS AND ACTIONS (sand-state-tool.ts:9-37) ==
8 targets, 16 valid target.action routes. Verbatim inventory with line numbers:
- memory.write (:11) — fact, tier, optional scope. scope "agent" (default) = own memory; "user" = shared user-memory; "project" requires project=<slug>. tier "profile" (kept in mind every turn) | "log" (default, dated history) | "note" (fades fast). Facts deduped.
- memory.forget (:12) — drop a fact by EXACT recorded text, same scope/project.
- routine.create (:15) — name, prompt, and either schedule or trigger.
- routine.update (:16) — id + any of name/prompt/schedule/trigger/enabled; omitted fields keep current values.
- routine.pause (:17) — id.
- routine.resume (:18) — id.
- routine.delete (:19) — id.
- workflow.write (:22) — name, description (REQUIRED), body; id to rewrite. Text explicitly: "A workflow has no trigger — a saved task that runs on a schedule is a routine."
- workflow.delete (:23) — id. "Cursor-managed skills can't be edited or deleted."
- profile.set (:25) — name and/or description.
- settings.set (:26) — hidden_from_sidebar, notify_on_updates.
- channel.disconnect (:27) — platform.
- project.create (:29) — project slug, name, optional description; create-is-join if slug exists.
- project.join (:30), project.leave (:31) — project slug.
- avatar.set (:34) — path to an image on box or host (/workspace path OK).
- avatar.clear (:35).
So: YES routines (5 actions), YES workflows (2), YES memory (2), plus profile/settings/channel/project/avatar.

TARGETS derived at :41 (Object.keys(OPERATIONS)); ACTIONS at :42 is a DEDUPED FLAT UNION of all action keys — 12 unique strings: write, forget, create, update, pause, resume, delete, set, disconnect, join, leave, clear.
CONSEQUENCE (atomic): the zod schema exposes `target` and `action` as two INDEPENDENT enums (:132-133), so a cross-product of 8×12 = 96 combinations validates at the schema layer; only 16 are real. Invalid combos are caught at runtime by isSandStateRoute (:276-279) and rejected in applySandStateUpdate (:287) with SandToolInputError `'<action>' is not an action on <target>. <target> takes: ...`.

== update_state: EXACT SCHEMA (sand-state-tool.ts:131-150) ==
18 fields, all optional except target/action:
- target: z.enum(TARGETS) (:132)
- action: z.enum(ACTIONS) (:133); description is generated per-target ("memory: write | forget. routine: create | update | pause | resume | delete. ...").
- fact: string.trim().min(1) — memory only (:134)
- tier: enum ["profile","log","note"] — memory write only, defaults log (:135)
- scope: enum ["agent","user","project"] — memory only, defaults agent (:136)
- project: string — required for memory scope "project" and every project action (:137)
- id: string — "The routine's folder or the workflow's id" (:138)
- name: string (:139)
- prompt: string — routine only; description instructs INTENT not frozen tool recipe (:140)
- schedule: string — routine only, cron shorthand, user local time; "Use this OR trigger, never both" (:141)
- trigger: triggerSchema (:142, schema at :122-129)
- enabled: boolean — routine create/update only; defaults true on create (:143)
- description: string — REQUIRED for workflow write; also profile description / project summary (:144)
- body: string.min(1) — workflow write only, markdown (:145)
- hidden_from_sidebar: boolean — settings set only (:146)
- notify_on_updates: boolean — settings set only (:147)
- platform: string — channel disconnect only (:148)
- path: string — avatar set only; "png/jpg/webp/gif/svg under 5 MB" (:149)

TRIGGER UNION (:66-129), 7 concrete listener types + group + bare-array shorthand:
- cron (:66-69): schedule string, 5-field cron or @hourly/@daily/@weekly/@monthly/"@every 30m".
- slack (:70-83): channel ("#eng" | "@dana" | "*"); match discriminated on kind = mention | keyword(keyword) | message | reaction(emoji[]?, bySelf?).
- github (:84-90): repo "owner/name" (no wildcards); events[] from GITHUB_EVENT_KINDS; userAllowlist[]?; ciBranch REQUIRED when events includes ci-passed/ci-failed.
- microsoftTeams (:91-100): tenantId; teamId or teamIds (at least one); channelIds?; messageContains?; messageContainsIsRegex?; blockUnauthenticatedTeamsUsers?.
- linear (:101-110): event discriminated on case ∈ issueCreated|statusChanged(statusIds?)|endOfCycle(cycleIds?); projectIds?; teamIds?.
- sentry (:111-115): event.case ∈ SENTRY_EVENT_CASES; projectIds?.
- pagerduty (:116-120): event.case ∈ PAGERDUTY_EVENT_CASES; serviceIds?.
- group (:126): { type:"group", listeners: triggerMember[].min(1) }.
- bare array shorthand (:128) → normalized to group in resolveTrigger (:211-213).
Enum values pulled from source/shared/automations.ts:1 — GITHUB_EVENT_KINDS = pr-opened, pr-pushed, pr-merged, review-requested, review-approved, review-changes-requested, review-commented, pr-comment, inline-review-comment, review-thread-resolved, review-thread-unresolved, issue-assigned, ci-passed, ci-failed. LINEAR_EVENT_CASES = issueCreated, statusChanged, endOfCycle. SENTRY_EVENT_CASES = issueCreated, issueResolved, issueAssigned, issueArchived, issueUnresolved, issueAny. PAGERDUTY_EVENT_CASES = incidentTriggered, incidentAcknowledged, incidentResolved, incidentEscalated, incidentAny.

== update_state: DISPATCH + WRITER SURFACE ==
- applySandStateUpdate (:285-307) is a 16-arm switch on `${target}.${action}`; each arm maps to one SandStateWriter method (:170-187: writeMemory, removeMemory, createAutomation, updateAutomation, setAutomationEnabled, deleteAutomation, writeWorkflow, deleteWorkflow, updateProfile, updateSettings, disconnectChannel, createProject, joinProject, leaveProject, setAvatar, clearAvatar).
- resolveTrigger (:207-221): throws if BOTH schedule and trigger passed (:208); schedule → {type:"cron",schedule} (:205,:209); array → group (:211-213); deps.parseTrigger overrides validation when supplied (:214-216); null parse → SandToolInputError naming channel/repo/events/ciBranch/tenantId (:217).
- writeAutomation (:232-252): update requires id (:234); if automationStore is wired and no routine matches the id it throws `no routine with folder "<id>" exists` (:236); name/prompt fall back to the existing record (:238-239); isEnabled defaults true on create only (:241).
- HUMAN-CONFIRMATION GATE for routines: deps.reviewAutomationWrite is awaited before the write (:243-247); `!review.allowed` returns {ok:false, reason} which renders as "Not saved — <reason>" (:333). Tool description states this at :323 ("Creating or changing a ROUTINE may ask the user to confirm ... they'll see a card and you'll get their answer back as the tool result").
- writeWorkflow (:254-274) requires name, body AND description (:255-257) — description is mandatory even on a rewrite. Workflow id = args.id ?? existing.id ?? slugifyWorkflowName(name) (:259). A workflow write ALSO goes through reviewAutomationWrite with operation "workflow_body" (:265-271) but ONLY when at least one existing routine's prompt references the workflow.
- promptReferencesWorkflow (:223-226) is a naive case-insensitive SUBSTRING test of the routine prompt against the workflow id OR name. A short/common workflow name (e.g. "test", "deploy") will match unrelated routine prompts and drag them into the review path.
- onListenerRoutineSaved hook appends a note to the success detail (:250-251).
- assertNoPendingAutoReviewApproval is called before every state update (:331).

== SendMessage: SCHEMA (send-message-schema.ts) ==
- SEND_MESSAGE_TYPES (:3) = text | attachment | widget | cursor-agent | secret-request.
- Field/type matrix TYPE_FIELDS (:15-18): content→text, url→attachment, alt→attachment, widget→widget, bcId→cursor-agent, secret→secret-request.
- refineSendMessage (:19-32) rejects: field-on-wrong-type with a long "Nothing was sent. Re-send as separate SendMessage calls" message (:21); channel on non-text/attachment (:22); images on non-text (:23); missing content on text (:25); non file:/https: image urls (:26); missing/invalid url on attachment (:28-29).
- isValidAttachmentUrl (:13) allows only file: and https: protocols.
- reply_to addressing scheme documented at :42 — "t3u" = user message in turn 3, "t3s1" = second SendMessage in turn 3.
- channel (:43): "shaped platform:chat, the address shown to you in an [inbound] wake"; omit for in-app chat.
- widget = sandWidgetSchema (source/shared/sand-widgets.ts:19-34): prompt (min 1), helpText?, options 1..6 (max enforced at :22), allowCustom?, dismissOnMoveOn?; each option = label (min 1), value?, description?, style ∈ default|primary|danger.
- secret (:46-51): label, description?, connector, field — all trimmed, label/connector/field min(1).

== SendMessage: BEHAVIOR (send-message-tool.ts) ==
- buildSandSendMessage (:39-48) re-parses input through sendMessageParameters (:40) — validation runs twice (once in withSafeParsedArgs, once here).
- text branch (:41) resolves every image through resolveAttachmentSource and attaches measured width/height.
- widget/cursor-agent/secret-request branches throw SandToolInputError on the missing discriminant field (:42, :43, :44) — redundant with the zod refiner but a real second gate.
- secret-request maps to `secretRequest: { label, description?, target: { kind: "channel-credential", platform: <connector>, field } }` (:44). label clamped to 120 chars, description to 400 (sand-secret-request.ts:1-2).
- ATTACHMENT DOWNGRADE (:46): an https: url that deps.classifyAttachment classifies as "file" is silently converted into a `type:"text"` message whose content is the bare URL — the model asked for an attachment and gets a text message.
- resolveAttachmentSource (:30-37): file:// path → deps.getIngestAttachment() ingest (errors swallowed by bare `catch {}` at :35) → falls back to deps.resolveBoxAttachment → falls back to the original url. A failed ingest degrades silently to a possibly-unreachable local path.
- resolveCloudAgentTitle failure is also swallowed (`catch {}` :43).
- Awaiting-user block (:18, :78-80): if isAwaitingUserSelection() is true the message is NOT delivered and the model gets SAND_AWAITING_USER_SEND_MESSAGE_BLOCKED as an error result.
- messageId comes back from deps.onSendMessage (:82) and is surfaced to the model as "(id: <id>)" (:125); production wires it to hooks.transport.lastSentMessageId() (host-runner-composition.ts:2042).

== SendMessage: ENCODING (send-message-encoding.ts) ==
- ATOMIC FINDING: encodeSendMessage (:27-49) handles 13 message types, but only 5 are model-callable. The 8 host-only types are: permission-request (:34), auto-review-approval (:35), local-tool-permission (:36), connector (:37), connectors (:38), listener-connect (:39), email-draft (:40-44), slack-draft (:45-48). Unknown type → `throw new Error("Unsupported send-message type: ...")` (:49).
- ATOMIC FINDING: images are re-encoded as MARKDOWN into the transcript text (:22-26 encodeTextContent → `![alt](<url>)` appended after two newlines), even though the tool description at send-message-tool.ts:17 instructs the model "Never embed images as markdown ![](...) in content." The host does exactly that at encode time; the prohibition is about the model's own content string only.
- encodeMarkdownImageDestination (:21) angle-bracket-wraps the url and percent-encodes `<`, `>`, CR, LF.
- Non-text types are flattened to a one-line text SUMMARY in the proto args (widget → summarizeWidget :31; cursor-agent → "Referenced Cursor cloud agent <bcId> (<title>)" :32; secret-request → summarizeSecretRequest :33), so the model's own transcript never carries the structured payload back.
- resolveBoxMediaAttachment (:52-54) only fires when remoteBoxHasDesktop AND isBoxRootPath; all failures return null via a bare catch (:54).

== communicate-tool.ts (shared factory) ==
- SAND_TOOL_MARKER = "__sand_tool__" (:15); every communicate-tool payload is JSON with that marker key set true (:19-21).
- All communicate tools share one proto case, "communicateUpdateToolCall" (:26, :35, :75, :172) — they are indistinguishable at the proto layer; the actual tool name only survives inside the JSON `tool` field of the executing payload (:143).
- Executing payload shape (:141-146): { phase: "executing", tool: <name>, detail?, target? } from spec.describeActivity.
- ERROR SWALLOWING: spec.execute is wrapped in try/catch (:152-159) and every throw becomes buildErrorResult(message) — so SandToolInputError from update_state surfaces as a normal tool result string, not an exception.
- ATOMIC FINDING (inconsistency): makeRender's error branch (:115-117) calls `createStringResult(\`Error: ${...}\`)` with NO second argument, and createStringResult's signature is `(content: string, isError = false)` (source/packages/chat-inference/prompt-executor.ts:3). So every communicate-tool error (including all update_state failures) is returned to the model with isError=false. SendMessage's own render explicitly passes `true` (send-message-tool.ts:113-118). update_state failures are therefore marked as successful tool results.
- Note the SEPARATE failure path: "Not saved — <reason>" (sand-state-tool.ts:333) is returned as a SUCCESS string, not an error, by design.
- Communicate tools opt OUT of the initial partial tool call (:165 `emitInitialPartialToolCall: false`); the default in common.ts:206 is to emit, which SendMessage uses.
- Empty currentStep renders as "Tool completed." (:120).

== CROSS-FILE / REGISTRATION ==
- SendMessage is treated as a delivery tool in turn shaping: DELIVERY_TOOL_NAMES = { SendMessage, ReactToMessage } (source/host/runner/turn-shape.ts:5-8).
- The literal "SendMessage" is DUPLICATED as its own constant in source/host/runner/send-message-reminder-middleware.ts:1 rather than imported from send-message-tool.ts:16 — two independent definitions of the same tool name string that could drift.
- Both tools are excluded from subagent runners (turn-toolset.ts:1373); update_state is additionally excluded when the system prompt is overridden (turn-toolset.ts:1383).

== NOTABLE GAPS FOUND WHILE READING ==
- source/shared/automations.ts:1 defines TRIGGER_MAX_GROUP_LISTENERS = 8, TRIGGER_MAX_REACTION_EMOJI = 8 and REACTION_EMOJI_PATTERN = /^[a-z0-9_+-]+$/, but sand-state-tool.ts imports NONE of them (import list at :2 is GITHUB_EVENT_KINDS, LINEAR_EVENT_CASES, PAGERDUTY_EVENT_CASES, SENTRY_EVENT_CASES only). The group listeners array (:126) and the bare-array shorthand (:128) carry only .min(1) — no .max(8). The slack reaction emoji array (:79) has no .max(8) and no pattern check. Whether deps.parseTrigger (:194, :216) enforces these caps downstream is NOT established from these files.
- sand-state-tool.ts:264 `if (anchor == null) throw new Error();` throws an Error with an empty message; via communicate-tool.ts:110 that renders to the model as the literal string "Error: ".
- sand-state-tool.ts:305 and :49 (send-message path is fine) — applySandStateUpdate's `default: throw new Error();` is likewise message-less.

## Tool table

### SendMessage
- defined: `source/host/runner/tools/send-message-tool.ts:101 (createZodAgentTool("SEND_MESSAGE", {...}); name constant at :16)`
- gate: Registered only when NOT a subagent runner: turn-toolset.ts:1373 `if (!host.isSubagentRunner) {` → :1374-1375 `const sendMessage = factories.sendMessage?.(); if (sendMessage !== undefined) tools.push(sendMessage);`. Factory exists only if `input.sendMessage !== undefined` (turn-toolset.ts:1117-1119), which is populated only if `provider.createSendMessageToolInputs !== undefined` (turn-toolset.ts:1214-1216); production composition always defines it (host-runner-composition.ts:2028). Additional RUNTIME gate inside execute: send-message-tool.ts:78-80 `if (deps.isAwaitingUserSelection?.() === true) return errorResult(SAND_AWAITING_USER_SEND_MESSAGE_BLOCKED)`.
- notes: Params = sendMessageParameters (send-message-schema.ts:33-53). 5 model-callable types (schema:3): text | attachment | widget | cursor-agent | secret-request. 18 lines of prose description at send-message-tool.ts:17. Emits an initial partial tool call (withSafeParsedArgs called without options at :105-109; default is emit — common.ts:206). Success render "Message sent to user. (id: <id>)" (:120-127); error render passes isError=true (:113-118).

### update_state
- defined: `source/host/runner/tools/sand-state-tool.ts:315 createSandStateTool → defineCommunicateTool with id "PLATFORM_ACTION" (:326); name constant SAND_UPDATE_STATE_TOOL_NAME = "update_state" at :8`
- gate: Two AND-ed host flags plus a dependency check. turn-toolset.ts:1373 `if (!host.isSubagentRunner) {` AND :1383 `if (!host.isSystemPromptOverridden) {` → :1385-1386 `const updateState = factories.updateState?.(); if (updateState !== undefined) tools.push(updateState);`. Factory exists only if `input.state !== undefined` (turn-toolset.ts:1132-1134) ← `provider.createStateToolInputs` (turn-toolset.ts:1226-1228) ← host-runner-composition.ts:2191-2197 `const state = dependencies.state; if (state === undefined) return provider;` i.e. the tool is omitted entirely when no state writer is wired.
- notes: Params = sandUpdateStateParameters (sand-state-tool.ts:131-150), 18 fields. 8 targets × flat action enum; 16 valid target.action routes (OPERATIONS, :9-37). Description is generated at :316-324 from OPERATIONS. Runs through the communicate-tool wrapper, so it does NOT emit an initial partial tool call (communicate-tool.ts:165 `emitInitialPartialToolCall: false`).


## Did not verify

- Whether deps.parseTrigger actually enforces TRIGGER_MAX_GROUP_LISTENERS (8), TRIGGER_MAX_REACTION_EMOJI (8) or REACTION_EMOJI_PATTERN — I read the constants in source/shared/automations.ts:1 and confirmed sand-state-tool.ts does not import them, but I did not read the parseTrigger implementation.
- The concrete implementation of SandStateWriter (writeMemory/createAutomation/writeWorkflow/etc.) — I read only the interface at sand-state-tool.ts:170-187 and the composition hookup point (host-runner-composition.ts:2191-2197). Where memory/routines/workflows are actually persisted on disk is not established.
- The implementation of reviewAutomationWrite — whether the routine-confirmation card is always shown, is user-configurable, or can be auto-approved. Only the call sites (sand-state-tool.ts:243-247, :265-271) and its return shape were read.
- The values of host.isSubagentRunner and host.isSystemPromptOverridden at runtime, and under what product conditions dependencies.state is undefined (which removes update_state entirely).
- deps.classifyAttachment's rule for returning "file" vs "media" — the https-attachment-to-text downgrade at send-message-tool.ts:46 depends entirely on it and I did not read its implementation.
- deps.getIngestAttachment / resolveBoxAttachment / readMediaDimensions implementations — the silent-fallback behavior I describe follows from send-message-tool.ts:30-38 control flow, but the failure modes of the injected functions are unread.
- summarizeWidget, summarizeSecretRequest and summarizePermissionRequest bodies (only their call sites in send-message-encoding.ts:31/33/34 and summarizeWidget's first line were read).
- Which code path emits each of the 8 host-only send-message types (permission-request, auto-review-approval, local-tool-permission, connector, connectors, listener-connect, email-draft, slack-draft). I established they are encodable (send-message-encoding.ts:34-48) and not model-callable (send-message-schema.ts:3); their producers are unread.
- Whether any other tool module besides send-message-tool.ts and sand-state-tool.ts is affected by the isError=false render bug in communicate-tool.ts:115-117 in a user-visible way — I confirmed the shared code path and the createStringResult signature but did not audit each consumer's error semantics.
- slugifyWorkflowName's exact behavior (source/shared/workflow-model.js), which determines the generated workflow id at sand-state-tool.ts:259.
- The prompt-version / description-generation layer: whether SAND_SEND_MESSAGE_TOOL_DESCRIPTION (send-message-tool.ts:17) or the generated update_state description (sand-state-tool.ts:317-324) is post-processed or truncated before reaching the model.