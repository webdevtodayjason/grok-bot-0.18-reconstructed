# Reader output: w1:prompt-glue

## Scope

Four files read end to end (95 / 442 / 262 / 80 lines). Grep used only to chase references OUT (`system-prompt.ts`, `shell-terminal-watch.ts`, `system-prompt-assembly.ts`, `host-runner-composition.ts`, `extensions/forever-box/extension.ts`).

## 1. runner-prompt-glue.ts (95 lines) — thin adapter, no prompt text

Pure wiring. `createRunnerPromptGlue(owner)` builds a `PromptCollectorHost` whose every field is a **getter that reads through the owner at call time** (`source/host/runner/runner-prompt-glue.ts:51-75`), then delegates to `createPromptCollectorGlue` (`:76`). It adds exactly two things of its own: `createFileTransferController()` (`:79-85`, binds agentBox=remoteBox, boxId=`resolveBoxId()`, computerAgentId=`getConversationId()`) and `createMcpTextSpiller()` (`:86-93`), which returns `undefined` unless `isLargeOutputSpillEnabled()` (`:87`) and otherwise uploads spilled MCP text via `owner.box.uploadFile(ctx, agentId, relativePath, data)` (`:90-91`). No message roles, no prompt strings in this file.

## 2. prompt-collector-glue.ts (442 lines) — where the turn input is actually assembled

Two near-duplicate assemblers: `assembleTurnAction` (plain-object, `:334-369`) and `assembleGeneratedTurnAction` (protobuf, `:371-429`). Their text-building logic is **line-for-line parallel** (`:339-356` vs `:379-396`) — a real duplication, drift risk.

Text assembly order in one user message:
1. attachments staged into the box first: `uploadAttachmentsIntoBox(files)` gated on `getRemoteBoxAvailable?.() === true`, wrapped in `try{}catch{}` that **silently swallows failures** (`:341-343`, `:381-383`).
2. `[messageId]` address note + `[In reply to X: "quote"]` reply note, joined `\n` (`:344-346`, `:384-386`).
3. the user's trimmed prompt appended after `\n` (`:347`, `:387`).
4. attached-files note appended after a blank line (`:348-349`, `:388-389`).
5. automation status reminder — placed **above** the text when `options.isSilenceAllowed === true`, otherwise below (`:351-353`, `:391-393`).
6. agent-profile update text — same above/below rule (`:354`, `:394`).
7. `USER_MESSAGE_REPLY_REMINDER` appended iff `appendReplyReminder === true && hidden !== true` (`:355`, `:395`).
8. hidden/trusted markers **prefixed last** (`:356`, `:396`): `SAND_HIDDEN_PROMPT_MARKER` always when hidden; `SAND_TRUSTED_AUTOMATION_PROMPT_MARKER` added only when an automationWake exists and `containsUntrustedEventText !== true`.

Attachments (images/videos) never go into the text: they ride in `selectedContext` (`:363-367`, `:398-406`, `:416-421`). Videos for subagent runners are materialized to bytes (`:291-302`, `:304-332`), reading from the box only for paths under `SAND_BOX_WORKSPACE_ROOT`, ≤100 MB, and passing a container sniff (`:284-288`); unreadable videos throw `SandVideoAttachmentError` (`:298`, `:317-319`).

Prepended messages: `collectPrependUserMessages` (`:360`, `:408-413`); unanswered skipped+dismissed question prompts are appended as an **extra prepended user message**, not into the main text (`:361-362`, `:414-415`).

Prompt *sections* returned by this file (`getRemoteBoxSection` `:187-202`, computerUse variant `:203-208`, browserUse variant `:209-214`, `getComputerSection` `:216-280`, `getMcpCustomInstructionsSection` `:163-166`, `getMcpDiscoveryStatusSection` `:168-171`) are plain strings. They are pushed into the **system prompt string** by `system-prompt-assembly.ts:264`, wired at `host-runner-composition.ts:1384-1387` — i.e. concatenated prose, not role-tagged messages.

## 3. conversation-outline.ts (262 lines) — read-side projection only

Derives UI/telemetry outline items from `ConversationState`; injects nothing into any model turn. Consumers: `sand-agent-runner.ts:822`, `extensions/session/production.ts:110,218`. `stripHiddenMarker` strips hidden then trusted-automation markers in that order (`:94-101`); hidden user turns still surface as outline items flagged `hidden: true` when non-empty after stripping (`:226-236`). Shell turns become a synthetic `shellToolCall` outline item (`:242-254`). Tool args JSON is capped at 20 000 chars with a `… (truncated)` suffix (`:8`, `:145-150`); the `Buffer.from(slice,"utf8").toString("utf8")` round-trip at `:146-149` is a no-op copy. `stepToOutlineItem` hardcodes the event string `"toolCallCompleted"` when computing status (`:210`), so the `"pending"` branch of `getOutlineToolCallStatus` (`:162`) is unreachable from that path.

## 4. box-reference-docs.ts (80 lines) — docs land on disk, not in the prompt

Two markdown docs are defined as string constants: `SAND_BOX_DEBUGGING_REFERENCE_DOC` (`:20-31`) and `SAND_APP_UI_REFERENCE_DOC` (`:33-47`). `writeSandBoxReferenceDocs` atomically writes them into `/home/box/reference` (`:11`, `:54-65`). `provisionSandBoxPromptArtifacts` runs the alias + write + legacy-dir removal concurrently via `Promise.allSettled` and rethrows the first rejection (`:67-79`); it is called **only** when `process.env.SAND_HOST_IN_BOX === "1"` (`source/host/extensions/forever-box/extension.ts:23`). The model gets these docs by **being told to Read the paths** from the system prompt (`source/host/runner/system-prompt.ts:200,204`), not by injection.

## Role "system"

None of the four files emits a message with role `"system"`. The only occurrence is a **read-side guard**: `appendProfileUpdateToHistory` bails unless the history already contains a system message, and the message it appends is `role: "user"` (`prompt-collector-glue.ts:182-184`). Everything these files produce for the model is either a `"user"` message or a raw string concatenated into the system prompt elsewhere.

**Q: How do user messages, attachments, reply context, and box docs get injected into the turn input?**

All of it converges on ONE user message built by assembleTurnAction (prompt-collector-glue.ts:334-369) or its protobuf twin assembleGeneratedTurnAction (:371-429). Text order: [messageId] address note + [In reply to X: "quote"] reply note joined by newline (:344-346), then the trimmed user prompt (:347), then the attached-files note after a blank line (:348-349), then the automation status reminder and the agent-profile update — each placed ABOVE the text when options.isSilenceAllowed === true and below otherwise (:351-354), then the SendMessage reply reminder when appendReplyReminder && !hidden (:355), and finally the hidden/trusted markers PREFIXED to the whole string (:356). Attachments: file paths are first uploaded into the box (uploadAttachmentsIntoBox, gated on getRemoteBoxAvailable()===true, failures silently swallowed, :341-343); the resulting host-path -> box-path map feeds buildAttachedFilesNote (system-prompt.ts:23-41), which lists each path with size and box path. Images/videos never touch the text — they ride in selectedContext (:363-367, :398-406), with subagent-runner videos materialized to bytes from /workspace only, ≤100MB, container-sniffed (:282-302). Recent unconfirmed user messages become prependUserMessages (:360, :408-413), each itself prefixed with its own address note (shell-terminal-watch.ts:267-276); skipped/dismissed question prompts are appended as one extra prepended user message (:361-362, :414-415). Box docs are NOT injected: box-reference-docs.ts only writes debugging-the-box.md and app-ui.md to /home/box/reference (:54-65), provisioned only when SAND_HOST_IN_BOX==="1" (extensions/forever-box/extension.ts:23); the model is merely told those paths in the system prompt and instructed to Read them (system-prompt.ts:200,204). conversation-outline.ts injects nothing at all — it is a read-side projection of ConversationState for the UI (:219-261).

*Evidence:* prompt-collector-glue.ts:334-369, :371-429, :341-356, :360-367, :398-421; system-prompt.ts:23-53, :200-204; shell-terminal-watch.ts:267-276; box-reference-docs.ts:54-79; extensions/forever-box/extension.ts:23; conversation-outline.ts:219-261


**Q: Do any of these emit messages with role "system"? Where, gated by what?**

No. Zero role:"system" messages are constructed in any of the four files. The single occurrence of the string is a READ-side gate: appendProfileUpdateToHistory (prompt-collector-glue.ts:178-185) returns undefined unless the incoming history already contains at least one role==="system" message (:182) — and the message it then appends is role:"user" carrying renderAgentProfileUpdate(identity) (:184). Everything else the glue produces is either the single userMessageAction (:368, :422-427) or plain strings (getRemoteBoxSection :187-214, getComputerSection :216-280, getMcpCustomInstructionsSection :163-166, getMcpDiscoveryStatusSection :168-171) that are concatenated into the system prompt TEXT elsewhere — system-prompt-assembly.ts:264, wired at host-runner-composition.ts:1384-1387 — not tagged as system-role messages here. Note the <system_reminder> and <mcp_status> tags are literal text inside user-role/system-prompt strings, not roles (system-prompt.ts:6-8; prompt-collector-glue.ts:170).

*Evidence:* prompt-collector-glue.ts:182-184, :163-171, :368, :422-427; system-prompt-assembly.ts:264; host-runner-composition.ts:1384-1387; system-prompt.ts:6-8


## Claims

- createRunnerPromptGlue builds the PromptCollectorHost entirely from live getters on the owner rather than snapshotting values, then delegates to createPromptCollectorGlue.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/runner-prompt-glue.ts:51-76`
- createMcpTextSpiller returns undefined unless isLargeOutputSpillEnabled() is true, and otherwise uploads spilled text through owner.box.uploadFile keyed by the conversation id.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/runner-prompt-glue.ts:86-93`
- createFileTransferController binds the file-transfer surface to owner.remoteBox, resolveBoxId(), getConversationId(), and a boxIsPreparing check.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/runner-prompt-glue.ts:79-85`
- Attached files are uploaded into the box before text assembly, gated on getRemoteBoxAvailable() === true, and any upload failure is swallowed by an empty catch block so the turn proceeds with no box paths.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:341-343`
- The same upload-and-swallow pattern is duplicated verbatim in the protobuf assembler.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:381-383`
- The user message text starts with the address note ([messageId]) and reply-context note joined by a newline, with the user's trimmed prompt appended on the next line.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:344-347`
- The attached-files note is appended to the message text after a blank line.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:348-349`
- The automation status reminder is prepended above the user text when options.isSilenceAllowed === true and appended below it otherwise.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:351-353`
- The agent-profile update text follows the same above/below placement rule as the automation reminder.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:354`
- The SendMessage reply reminder is appended only when appendReplyReminder === true and the message is not hidden.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:355`
- Hidden messages are prefixed with SAND_HIDDEN_PROMPT_MARKER, plus SAND_TRUSTED_AUTOMATION_PROMPT_MARKER only when an automationWake is present and containsUntrustedEventText is not true.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:356`
- Selected images and videos are attached via a selectedContext field on the user message, never inlined into the text.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:363-367`
- The protobuf path builds SelectedImage objects with case "data" and a SelectedContext only when at least one image or video exists.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:398-406`
- Skipped and dismissed question prompts are emitted as an additional prepended user message titled "Unanswered questions:", not merged into the main message text.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:361-362`
- The protobuf assembler emits the unanswered-questions block as a UserMessage appended to prependUserMessages.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:414-415`
- Prepend user messages are collected through shellWatchHost's collectPrependUserMessages when available, otherwise through host.collectGeneratedPrependUserMessages, optionally wrapped in a traceSendPhase span.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:408-413`
- The final turn input is a ConversationAction with case "userMessageAction" carrying the assembled userMessage and prependUserMessages.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:422-427`
- Video attachments are only materialized for subagent runners; other runners pass videos through untouched.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:291-292`
- readBoxVideoBytes refuses any path outside SAND_BOX_WORKSPACE_ROOT, requires a desktop-capable remote box, and rejects payloads over 100 MB or failing a video-container sniff.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:282-289`
- An unreadable video attachment throws SandVideoAttachmentError rather than being dropped silently.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:298`
- appendProfileUpdateToHistory appends the profile update as a role "user" message and refuses to act unless the existing history already contains at least one role "system" message.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:182-184`
- The MCP discovery-failure notice is a literal <mcp_status> string returned only when the runner is not a subagent, MCP exists, and isMcpDiscoveryUnavailableForTurn() === true.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:168-171`
- getRemoteBoxSection branches to a computerUse variant, a browserUse variant, or the full main-agent box section.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:187-214`
- getComputerSection returns null when the remote box has no desktop, and returns null for generic subagent runners after the computerUse and browserUse branches.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:217,262`
- The desktop section text differs based on isBrowserUseSubagentEnabled(), offering browserUse-first guidance when enabled and computerUse-only guidance when not.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:263-273`
- The prompt sections produced by the glue are concatenated into the system prompt string by system-prompt-assembly, not emitted as role-tagged messages.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/system-prompt-assembly.ts:264`
- host-runner-composition wires the glue's four section getters into the system-prompt assembly deps.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/host-runner-composition.ts:1384-1387`
- buildUserMessageAddressNote renders the message id as a bracketed prefix and returns empty string when there is no id.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/system-prompt.ts:50-53`
- buildReplyContextNote emits [In reply to <targetId>: "<quote>"] and returns empty string unless both fields are non-empty strings.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/system-prompt.ts:44-49`
- buildAttachedFilesNote lists each attachment with an optional human-readable size and, when staged, the box path, and swaps its guidance sentence depending on whether any file was staged into the box.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/system-prompt.ts:23-41`
- The reply reminder is a <system_reminder> block appended to the user message text and is suppressed by the SAND_DISABLE_USER_REPLY_REMINDER=1 env var.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/system-prompt.ts:6-13`
- collectPrependUserMessages prefixes each selected recent message with its own bracketed address note and returns UserMessage protos.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/shell-terminal-watch.ts:267-276`
- Box reference docs are written to /home/box/reference as debugging-the-box.md and app-ui.md via atomic writes.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/box-reference-docs.ts:11-18,54-65`
- provisionSandBoxPromptArtifacts runs the data-root alias, the doc writes, and removal of the legacy /home/box/sand-reference dir concurrently and rethrows the first rejection.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/box-reference-docs.ts:67-79`
- provisionSandBoxPromptArtifacts is invoked only when process.env.SAND_HOST_IN_BOX === "1", from the forever-box extension start hook, with failures logged not thrown.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/extensions/forever-box/extension.ts:23`
- The box docs reach the model only as file paths named in the system prompt telling it to Read them, not as injected content.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/system-prompt.ts:200,204`
- conversation-outline is a read-side projection consumed by sand-agent-runner and the session extension; it produces no model input.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/conversation-outline.ts:219-261`
- stripHiddenMarker removes the hidden marker first and only then the trusted-automation marker, matching the prefix order written by the assemblers.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/conversation-outline.ts:94-101`
- Hidden user turns still appear in the outline as items flagged hidden:true whenever the marker-stripped text is non-empty.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/conversation-outline.ts:226-236`
- Shell conversation turns are projected as a synthetic tool-call item named shellToolCall with status "done" and the command as summary.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/conversation-outline.ts:242-254`
- Tool-call activity args are JSON-serialized and truncated at 20,000 chars with a trailing "… (truncated)" marker; the Buffer.from(...,"utf8").toString("utf8") round-trip in that path is a no-op copy.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/conversation-outline.ts:145-150`
- stepToOutlineItem hardcodes the event string "toolCallCompleted", so the "pending" branch of getOutlineToolCallStatus is unreachable through that call path.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/conversation-outline.ts:210`
- No message with role "system" is constructed anywhere in the four files; the only "system" reference is a guard predicate.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/prompt-collector-glue.ts:182`

## Did not verify

- What `trimmedPrompt` actually contains at the call site — it is passed in by the caller (production-turn-agent-owner.ts:112-129 was seen only in grep output, not read), so whether the raw user text is sanitized/trimmed upstream is unestablished.
- How `compactionEpoch()` is computed and when it advances; the reminder de-duplication at prompt-collector-glue.ts:156-160 depends entirely on that value.
- Whether `assembleTurnAction` (the non-protobuf variant, :334-369) is live in production or dead/test-only — grep showed no caller outside the glue's own return object at :440, while `assembleGeneratedTurnAction` has a clear production path via host-runner-composition.ts:2540.
- Whether the array returned by `appendProfileUpdateToHistory` is actually consumed and sent (turn-agent-composition.ts:239-266 was grepped, not read end to end).
- Whether `writeSandBoxReferenceDocs` is ever called with a non-default `referenceDir`, and whether anything ever verifies the docs exist before the system prompt tells the model to Read them — a missing /home/box/reference (host not running with SAND_HOST_IN_BOX=1) would leave the system prompt pointing at absent files.
- What `richText` is used for downstream and whether it can diverge from `text` in ways that matter for prompt content (prompt-collector-glue.ts:359, :407, :419).
- Whether `SelectedImage`/`SelectedVideo` payloads are size- or count-capped anywhere before hitting inference — the 100MB cap at :287 applies only to the box-read path, not to caller-supplied `data`/`blobId` videos or to any image.
- How `SAND_HIDDEN_PROMPT_MARKER` / `SAND_TRUSTED_AUTOMATION_PROMPT_MARKER` are consumed by the model-facing serializer — sand-prompt-markers.ts was not read, so whether hidden text is stripped before inference or only before UI display is unestablished.
- No tests were read for any of these files, so none of the behavioral claims above are cross-checked against expected-output fixtures.
- Whether the duplicated text-assembly logic in :339-356 and :379-396 has already drifted in ways beyond the type-level differences observed (they read identical, but only by inspection, not by a diff of a shared helper that does not exist).