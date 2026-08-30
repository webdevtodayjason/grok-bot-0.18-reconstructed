# Reader output: w1:prompt-core

## Scope

Read end to end: `source/host/runner/system-prompt.ts` (281 lines), `source/host/runner/system-prompt-assembly.ts` (272 lines), `source/host/runner/sand-agent-profile-prompt.ts` (10 lines, minified single-line style). References chased out via grep into `host-runner-composition.ts`, `turn-run-shell.ts`, `prompt-collector-glue.ts`, `shell-terminal-watch.ts`, `box-reference-docs.ts`, `sand-prompt-markers.ts`, `shared/sand-spotlight.ts`.

## The three files, in one line each

- **system-prompt.ts** — the static prompt text. One builder `buildSandBaseSystemPrompt({cloudAgentsEnabled})` (`:77-266`) plus two frozen constants built at module load (`:267-272`), three standalone sections, a subagent prompt builder, and four per-message note helpers.
- **system-prompt-assembly.ts** — the runtime assembler. `createSystemPromptAssembly(deps)` (`:119`) closes over 30 injected dependencies (`:58-98`) and exposes `getSystemPrompt` (`:249`) plus three profile-snapshot functions (`:268-271`).
- **sand-agent-profile-prompt.ts** — snapshot/identity plumbing for the Agent profile section: normalize, compare, epoch-gated snapshot resolution, and the base64url-marked `<agent_profile_update>` message.

## Assembly order (system-prompt-assembly.ts:249-266)

| # | Section | Gate | Line |
|---|---|---|---|
| 1 | Base prompt | always; body swapped to cloud-agents-disabled variant iff `!isSystemPromptOverridden && cloudDisabled` | 250-252 |
| 2 | `## Untrusted content` (spotlight) | `isSpotlightEnabled?.() !== false` — absent dep means INCLUDED | 253 |
| 3 | `Agent profile:` | non-null `profileSection`; shared-room variant recomputed, else snapshot value | 254-255 |
| — | **early return for shared-room runners** | `isSharedRoomRunner` | 256 |
| 4 | User identity | non-empty render | 258 |
| 5 | Multitask | `!subagent && !overridden && isMultitaskEnabled?.()===true` | 259 |
| 6 | Cloud agents disabled | `overridden && !subagent && cloudDisabled` | 260 |
| 7 | MCP multi-account | `!subagent && mcpManagement()!=null && isMcpMultiAccountEnabled?.()===true` | 261 |
| 8 | Time zone | `!isBoxScopedSubagent()` | 262 / 196-200 |
| 9 | Memory (user → project → agent) | `memoryStore()!=null`; sub-blocks gated on `userMemory()`/`projectMemory()` | 263 / 155-194 |
| 10 | Automations | `automationStore()!=null`, ≤100 records | 263 / 207-216 |
| 11 | Workflows | `workflowStore()!=null` | 263 / 218-223 |
| 12 | Channels | `channelStore()!=null`, filtered by connector manifests | 263 / 225-236 |
| 13 | Agent directory | `!subagent && (sendToAgentImpl \|\| agentManagement)` | 263 / 238-247 |
| 14 | MCP custom instructions | dep returns non-empty | 264 |
| 15 | MCP discovery status | dep returns non-empty | 264 |
| 16 | Remote box | dep returns non-empty (defaults `""`) | 264 |
| 17 | Computer | dep returns non-empty | 264 |

Joined with `"\n\n"` (`:265`). Everything from #4 down passes through `add()` (`:257`), which drops null/undefined/empty **silently** — no marker, no log.

## Base prompt internals (system-prompt.ts:77-266)

24 markdown sections in fixed order: identity line, How a turn works, SendMessage is your only voice, Reply first, Tone, Reply length and shape, Showing your work, Never fabricate data, Asking for decisions, Threaded replies, Where you work, Long-running commands, Delegating background work, Managing plugins and MCP servers, Reaching services that have no connector, Debugging the box, The Grok Bot app UI, Matching the user's writing style, Cursor Origin, Code changes, Autonomy, Initiative, When your own action needs approval, Security.

The only build-time variable is `cloudAgentsEnabled`. It swaps the entire Code changes body between a "cloud agents are disabled, don't clone repos, point at Cursor" block (`:216-221`) and a "hand ALL non-trivial repo work to CloudAgent" block (`:222-235`), and rewrites inline clauses at `:104`, `:136-138`, `:161`, `:251`, `:255`. Two on-box doc paths are interpolated: `/home/box/reference/debugging-the-box.md` and `/home/box/reference/app-ui.md` (`:200`, `:204`, from `box-reference-docs.ts:15-18`).

## Exit path

`getSystemPrompt` (`:249`, returns at `:265`, or `:256` on the shared-room short-circuit) is the sole text carrier. Single external consumer:

```
host-runner-composition.ts:2523
  systemPromptGenerator: () => productionSystemPromptAssembly?.getSystemPrompt() ?? DEFAULT_SAND_SYSTEM_PROMPT,
```

placed in the runner's `staticConfig` (`:2515-2524`). It is called **with no snapshot argument**, so the profile section is recomputed live each turn rather than served from the persisted snapshot (`system-prompt-assembly.ts:254`). `turn-run-shell.ts:116-121` deliberately takes only the two profile-snapshot functions, with the comment "prompt assembly stays there" (`:115`).

## Production wiring reality check (host-runner-composition.ts:1336-1388)

Roughly a third of the assembler's capability is dead in this wiring:

- `memoryStore`, `memorySnapshots`, `userMemory`, `projectMemory`, `automationStore`, `workflowStore`, `channelStore` are all literal `() => null` (`:1354-1357`, `:1370-1372`) → sections 9-12 never appear.
- `agentDirectory`/`agentGroups` are `() => []` (`:1376-1377`).
- `compactionEpoch: () => 0` (`:1353`) → the profile snapshot never invalidates.
- `isSpotlightEnabled` defaults to `false` (`:1379`) → the untrusted-content section is omitted unless the experiment is on.
- `multitaskSection` is never passed at all → the enabled branch adds `undefined`.
- `remoteBoxSection` defaults to `""` (`:1386`).

So the shipped prompt is effectively: base + optional profile + user identity + timezone + optional MCP sections + mcp instructions/discovery + computer.

## Empty / skipped

Three real paths, detailed in answer 3: an empty-string `overrides.systemPrompt` passes the `typeof === "string"` test with no non-empty guard (`:1340-1342`) and produces an empty base; a missing `productionContext`/`productionRequestContext` bypasses the assembler entirely for the frozen `DEFAULT_SAND_SYSTEM_PROMPT` (`:1336-1338`, `:2523`); and a shared-room runner truncates at three sections (`system-prompt-assembly.ts:256`).

## Side helpers in system-prompt.ts (not part of the system prompt)

`appendUserReplyReminder` (`:10-13`, killable with `SAND_DISABLE_USER_REPLY_REMINDER=1`), `buildAttachedFilesNote` (`:23-41`), `buildReplyContextNote` (`:44-49`), `buildUserMessageAddressNote` (`:50-53`) are per-*message* decorations consumed by `prompt-collector-glue.ts:13,344-355,384-395` and `shell-terminal-watch.ts:11,267`. `buildSandSubagentSystemPrompt` (`:66-74`) and `isMediaReviewSubagentType` (`:54-57`) had no importer in the grep.

**Q: What are ALL the sections of the assembled system prompt, in order, and what gates each one (flags, capabilities, profile, memory)?**

Assembly happens in getSystemPrompt (system-prompt-assembly.ts:249-266). Sections are pushed into one array and joined with "\n\n" (line 265). In order:

1. BASE PROMPT (line 252, value chosen at 250-251). Gate: if isSystemPromptOverridden is false AND isCloudAgentsDisabledByTeam?.() === true, the base is SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED; otherwise deps.basePrompt. Always pushed unconditionally.
2. SPOTLIGHT / "## Untrusted content" (line 253) via spotlightPromptSection({canSendMessage: !deps.isSubagentRunner}). Gate: deps.isSpotlightEnabled?.() !== false — i.e. included when the dep is absent or returns anything but false. In the production wiring it returns false unless the experiment is on (host-runner-composition.ts:1379), so it is normally OMITTED there.
3. AGENT PROFILE (lines 254-255). Shared-room runner recomputes profileSection(profile, true); otherwise uses snapshot?.profileSection, falling back to profileSection(profile, false). Gate: non-null only (profileSection returns null when profile is null or every line is empty — lines 101, 116).
   -> EARLY RETURN at line 256: if deps.isSharedRoomRunner, the prompt is base + spotlight + profile only; every section below is skipped.
All remaining sections go through add() (line 257), which drops null/undefined/empty strings.
4. USER IDENTITY (line 258) — renderUserIdentitySystemPrompt(requestContext.resolve().userFullName); dropped if it renders empty (202-205).
5. MULTITASK SECTION (line 259) — gated on !isSubagentRunner && !isSystemPromptOverridden && isMultitaskEnabled?.() === true. Content is deps.multitaskSection, which the production composition never passes (absent from host-runner-composition.ts:1339-1388), so add() drops it there.
6. CLOUD AGENTS DISABLED SECTION (line 260) — SAND_CLOUD_AGENTS_DISABLED_PROMPT_SECTION, gated on isSystemPromptOverridden && !isSubagentRunner && cloudDisabled. This is the override-path counterpart to the base swap in #1; the two are mutually exclusive on isSystemPromptOverridden.
7. MCP MULTI-ACCOUNT SECTION (line 261) — SAND_MCP_MULTI_ACCOUNT_PROMPT_SECTION, gated on !isSubagentRunner && deps.mcpManagement() != null && isMcpMultiAccountEnabled?.() === true.
8. TIME ZONE (line 262 -> 196-200) — null when deps.isBoxScopedSubagent() is true; otherwise renderTimeZoneSystemPrompt(timeZone), dropped if empty.
9. MEMORY (line 263 -> 155-194) — null when deps.memoryStore() is null. When present it renders up to three blocks joined by "\n\n": user memory (only if deps.userMemory() != null; recall limits profileLimit 50 / recentLimit 15, line 164), project memory (only if deps.projectMemory() != null; limits 25/10 with cap 3, line 171), then agent memory (store.recall(30), line 159/184). Freeze path: if deps.memorySnapshots() is non-null AND (deps.isMemoryFreezeEnabled?.() ?? isMemoryFreezeEnabled()) is not false, the frozen snapshot resolved against compactionEpoch is used instead of the live render (188-193).
10. AUTOMATIONS (line 263 -> 207-216) — null when deps.automationStore() is null; renders at most 100 records (listDefinitions?.() ?? list(), .slice(0,100)).
11. WORKFLOWS (line 263 -> 218-223) — null when deps.workflowStore() is null.
12. CHANNELS (line 263 -> 225-236) — null when deps.channelStore() is null; connections are filtered to platforms present in deps.connectorManifests (228-229).
13. AGENT DIRECTORY (line 263 -> 238-247) — null when deps.isSubagentRunner, or when BOTH deps.sendToAgentImpl and deps.agentManagement are null.
14. MCP CUSTOM INSTRUCTIONS (line 264) — deps.mcpCustomInstructionsSection().
15. MCP DISCOVERY STATUS (line 264) — deps.mcpDiscoveryStatusSection().
16. REMOTE BOX (line 264) — deps.remoteBoxSection() (returns "" when absent, so add() drops it).
17. COMPUTER (line 264) — deps.computerSection().

The base prompt itself (buildSandBaseSystemPrompt, system-prompt.ts:77-266) has its own fixed internal headings in this order: opening identity line (80), "## How a turn works" (82), "## SendMessage is your only voice" (90), "## Reply first, then keep the user posted" (103), "## Tone" (113), "## Reply length and shape" (122), "## Showing your work" (132), "## Never fabricate data" (143), "## Asking for decisions" (146), "## Threaded replies" (154), "## Where you work" (158), "## Long-running commands" (169), "## Delegating background work" (176), "## Managing plugins and MCP servers" (184), "## Reaching services that have no connector" (188), "## Debugging the box" (199), "## The Grok Bot app UI" (203), "## Matching the user's writing style" (207), "## Cursor Origin" (210), "## Code changes" (215), "## Autonomy" (236), "## Initiative" (242), "## When your own action needs approval" (250), "## Security" (262). The single build-time flag inside it is cloudAgentsEnabled, which swaps the "## Code changes" body (216-235) and rewrites clauses at 104, 136-138, 161, 251, 255.

*Evidence:* system-prompt-assembly.ts:249-266 (assembly + order), :250-251 (base swap), :253 (spotlight gate), :254-256 (profile + shared-room early return), :257 (add() drops empty), :258-264 (remaining sections); :100-117 (profileSection null cases); :155-194 (memory), :196-200 (timezone), :207-216 (automations), :218-223 (workflows), :225-236 (channels), :238-247 (agent directory); system-prompt.ts:77-266 (base prompt headings), :267-272 (both base variants)


**Q: What EXACT function/value carries the final assembled prompt text out of these files, and who imports it?**

The final assembled text is returned by the closure `getSystemPrompt(snapshot?: AgentProfilePromptSnapshot): string` defined at system-prompt-assembly.ts:249 and exposed on the object returned by `createSystemPromptAssembly` (system-prompt-assembly.ts:119, returned at :268-271). It returns `sections.join("\n\n")` at :265 (or at :256 on the shared-room path).

The only importer of createSystemPromptAssembly is /Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/host-runner-composition.ts:120,122, which constructs it at :1339-1388 as `productionSystemPromptAssembly`. The only call site of getSystemPrompt outside the file is host-runner-composition.ts:2523: `systemPromptGenerator: () => productionSystemPromptAssembly?.getSystemPrompt() ?? DEFAULT_SAND_SYSTEM_PROMPT`, placed inside the runner's `staticConfig` (:2515-2524). Note it is called with NO snapshot argument there, so the profile section is recomputed live rather than taken from the snapshot (assembly :254).

Two other files touch the module but not the text: turn-run-shell.ts:29 imports types from it and :116-121 accepts only the `prepareAgentProfilePromptSnapshot` | `getAgentProfileUpdateForTurn` slice (explicitly commented "prompt assembly stays there", :115); production-turn-agent-owner.ts:28 imports only the `PromptSnapshotStore` type.

Separate exit paths for raw strings from system-prompt.ts: `DEFAULT_SAND_SYSTEM_PROMPT` (:267-269) is imported by host-runner-composition.ts:118 and used as basePrompt (:1342) and as the fallback prompt (:2523). `SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED`, `SAND_CLOUD_AGENTS_DISABLED_PROMPT_SECTION`, `SAND_MCP_MULTI_ACCOUNT_PROMPT_SECTION` are imported only by system-prompt-assembly.ts:24-26. The per-message helpers `appendUserReplyReminder`, `buildAttachedFilesNote`, `buildReplyContextNote`, `buildUserMessageAddressNote` are imported by runner/prompt-collector-glue.ts:13 (used at :344-355 and :384-395), and `buildUserMessageAddressNote` also by runner/shell-terminal-watch.ts:11 (used :267). From sand-agent-profile-prompt.ts, system-prompt-assembly.ts:1-8 imports five symbols; the type AgentProfilePromptSnapshot is also imported by host-runner-composition.ts:155, turn-run-shell.ts:34, production-turn-agent-owner.ts:27, turn-settle.ts:8, and AgentProfileIdentity by runner-prompt-glue.ts:5.

*Evidence:* system-prompt-assembly.ts:249,:256,:265,:268-271,:119; host-runner-composition.ts:118,120,122,1339-1342,2515-2524; turn-run-shell.ts:29,115-121; production-turn-agent-owner.ts:27-28; prompt-collector-glue.ts:11,13,344-355,384-395; shell-terminal-watch.ts:11,267


**Q: Under what conditions would the assembled prompt be empty or skipped entirely?**

getSystemPrompt can never return an empty string on its own unless the base itself is empty: `sections` is seeded unconditionally with `base` (system-prompt-assembly.ts:252) and everything after is additive. The concrete ways the output is empty or the assembly is bypassed:

1. EMPTY BASE. `base` is deps.basePrompt whenever isSystemPromptOverridden is true or cloud agents are not disabled (:250-251). In the production wiring, basePrompt is `overrides.systemPrompt` whenever that is `typeof === "string"` (host-runner-composition.ts:1340-1342) — an empty-string override passes that typeof test, so basePrompt would be "" and, with no other section qualifying, getSystemPrompt returns "". There is no non-empty guard on basePrompt anywhere in the three files.
2. ASSEMBLY BYPASSED ENTIRELY. `productionSystemPromptAssembly` is undefined when `productionContext === undefined || productionRequestContext === undefined` (host-runner-composition.ts:1336-1338); the generator then falls back to the constant DEFAULT_SAND_SYSTEM_PROMPT (:2523) and none of the dynamic sections are assembled.
3. TRUNCATED (not empty) ON SHARED ROOM. deps.isSharedRoomRunner returns at :256 with only base + spotlight + profile; sections 4-17 are never evaluated.

Section-level skips, all silent: add() at :257 drops any null/undefined/zero-length value, so a store returning null or a renderer returning "" removes its section with no marker. In the production wiring memoryStore, memorySnapshots, userMemory, projectMemory, automationStore, workflowStore and channelStore are all hardcoded `() => null` (host-runner-composition.ts:1354-1357, 1370-1372), so memory, automations, workflows and channels are unconditionally absent from that assembly; agentDirectory/agentGroups are `() => []` (:1376-1377) and multitaskSection is never passed at all.

The agent-profile snapshot path can also be skipped: prepareAgentProfilePromptSnapshot returns undefined when deps.isSubagentRunner is true or deps.agentProfileProvider() is null (:130), and again when profile or section is null (:133) — getSystemPrompt then falls back to computing profileSection live (:254). getAgentProfileUpdateForTurn returns null when the snapshot or profile is missing, or when identities compare equal (:148-153).

*Evidence:* system-prompt-assembly.ts:250-252,:256,:257; host-runner-composition.ts:1336-1342,1354-1357,1370-1372,1376-1377,2523; system-prompt-assembly.ts:129-139,148-153


## Claims

- getSystemPrompt seeds the section array with the base prompt unconditionally and returns the sections joined by a blank line  
  `source/host/runner/system-prompt-assembly.ts:252,265`
- The base prompt is swapped to SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED only when the system prompt is NOT overridden and isCloudAgentsDisabledByTeam?.() === true; otherwise deps.basePrompt is used verbatim  
  `source/host/runner/system-prompt-assembly.ts:250-251`
- The spotlight/untrusted-content section is pushed whenever deps.isSpotlightEnabled?.() !== false, so an absent dep means it IS included  
  `source/host/runner/system-prompt-assembly.ts:253`
- spotlightPromptSection is called with canSendMessage: !deps.isSubagentRunner, which switches the escalation sentence between SendMessage and final-answer reporting  
  `source/host/runner/system-prompt-assembly.ts:253`
- A shared-room runner returns early with only base + spotlight + profile; user identity, multitask, MCP, timezone, memory, automations, workflows, channels, agent directory, remote box and computer sections are never added  
  `source/host/runner/system-prompt-assembly.ts:256`
- add() silently drops any section value that is null, undefined, or zero-length  
  `source/host/runner/system-prompt-assembly.ts:257`
- The multitask section requires !isSubagentRunner && !isSystemPromptOverridden && isMultitaskEnabled?.() === true  
  `source/host/runner/system-prompt-assembly.ts:259`
- SAND_CLOUD_AGENTS_DISABLED_PROMPT_SECTION is added only on the overridden-prompt path (isSystemPromptOverridden && !isSubagentRunner && cloudDisabled), making it mutually exclusive with the base swap  
  `source/host/runner/system-prompt-assembly.ts:251,260`
- The MCP multi-account section requires !isSubagentRunner, a non-null deps.mcpManagement(), and isMcpMultiAccountEnabled?.() === true  
  `source/host/runner/system-prompt-assembly.ts:261`
- The timezone section is suppressed for box-scoped subagents  
  `source/host/runner/system-prompt-assembly.ts:197`
- The memory section returns null outright when deps.memoryStore() is null, before any user or project memory is consulted  
  `source/host/runner/system-prompt-assembly.ts:156-157`
- Memory recall limits are hardcoded: agent memory 30, user memory profile 50 / recent 15, project memory profile 25 / recent 10 with a cap of 3 injected blocks  
  `source/host/runner/system-prompt-assembly.ts:159,164,171`
- The frozen-memory path is used only when deps.memorySnapshots() is non-null AND the freeze flag is not false; otherwise the live render is used  
  `source/host/runner/system-prompt-assembly.ts:188-193`
- The automations section renders at most 100 automation records  
  `source/host/runner/system-prompt-assembly.ts:211`
- Channel connections are filtered to platforms present in deps.connectorManifests before rendering  
  `source/host/runner/system-prompt-assembly.ts:228-229`
- The agent directory section is null for subagent runners, and also null when both sendToAgentImpl and agentManagement are null  
  `source/host/runner/system-prompt-assembly.ts:239-240`
- profileSection returns null when the profile is null or when no line was produced, and omits the self-naming line, the profile-file line and the settings-file line in shared-room mode  
  `source/host/runner/system-prompt-assembly.ts:101,106,109,113,116`
- resolveProfileForPrompt falls back to a name-only profile built from agentStore.getMetadata("name") with empty description and empty file paths when agentProfileProvider returns null  
  `source/host/runner/system-prompt-assembly.ts:122-127`
- prepareAgentProfilePromptSnapshot returns undefined for subagent runners and when agentProfileProvider() is null  
  `source/host/runner/system-prompt-assembly.ts:130`
- The profile snapshot is reused only while the compactionEpoch matches; a changed epoch mints a fresh snapshot whose announcedIdentity is reset to the current identity  
  `source/host/runner/sand-agent-profile-prompt.ts:7`
- The agent profile update message is emitted only when the current identity differs from the snapshot's announcedIdentity  
  `source/host/runner/system-prompt-assembly.ts:148-153`
- The profile-update message is prefixed with the hidden prompt marker plus a base64url-encoded identity payload and declares itself authoritative over the system prompt's Agent profile section  
  `source/host/runner/sand-agent-profile-prompt.ts:8`
- createSystemPromptAssembly returns exactly four functions plus resetProfileSnapshotFallback; getSystemPrompt is the only one that produces prompt text  
  `source/host/runner/system-prompt-assembly.ts:268-271`
- host-runner-composition.ts is the only importer of createSystemPromptAssembly and the only external caller of getSystemPrompt  
  `source/host/host-runner-composition.ts:120,122,1339,2523`
- getSystemPrompt is invoked at the runner boundary with no snapshot argument, so the profile section is computed live rather than read from the persisted snapshot  
  `source/host/host-runner-composition.ts:2523`
- When productionContext or productionRequestContext is undefined, no assembly is created and the runner falls back to the static DEFAULT_SAND_SYSTEM_PROMPT with no dynamic sections  
  `source/host/host-runner-composition.ts:1336-1338,2523`
- basePrompt is overrides.systemPrompt whenever that value is typeof string, with no non-empty check, so an empty-string override yields an empty base  
  `source/host/host-runner-composition.ts:1340-1342`
- In the production wiring memoryStore, memorySnapshots, userMemory, projectMemory, automationStore, workflowStore and channelStore are all hardcoded to return null, so those five sections are always absent there  
  `source/host/host-runner-composition.ts:1354-1357,1370-1372`
- In the production wiring compactionEpoch is hardcoded to 0, so the profile snapshot never invalidates on epoch change  
  `source/host/host-runner-composition.ts:1353`
- In the production wiring isSpotlightEnabled defaults to false when the experiment method is missing, so the untrusted-content section is omitted unless the experiment is on  
  `source/host/host-runner-composition.ts:1379`
- multitaskSection is never passed in the production wiring, so the multitask branch adds undefined even when the experiment is enabled  
  `source/host/host-runner-composition.ts:1339-1388,1380`
- remoteBoxSection defaults to an empty string in the production wiring, which add() then drops  
  `source/host/host-runner-composition.ts:1386`
- turn-run-shell only receives the two profile-snapshot functions from the assembly, with an explicit comment that prompt assembly stays in the assembly module  
  `source/host/runner/turn-run-shell.ts:115-121`
- buildSandBaseSystemPrompt takes a single flag, cloudAgentsEnabled, which rewrites the Code changes section and five other passages  
  `source/host/runner/system-prompt.ts:77-78,104,136-138,161,216-235,251,255`
- Both prompt constants are built at module load: DEFAULT_SAND_SYSTEM_PROMPT with cloudAgentsEnabled true and SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED with it false  
  `source/host/runner/system-prompt.ts:267-272`
- The base prompt embeds two on-box reference doc paths resolving to /home/box/reference/debugging-the-box.md and /home/box/reference/app-ui.md  
  `source/host/runner/system-prompt.ts:1-4,200,204`
- appendUserReplyReminder is a no-op when the environment variable SAND_DISABLE_USER_REPLY_REMINDER equals "1"  
  `source/host/runner/system-prompt.ts:10-13`
- The user reply reminder instructs the model that plain assistant text is never delivered and only a real SendMessage tool call reaches the user  
  `source/host/runner/system-prompt.ts:6-8`
- buildSandSubagentSystemPrompt composes a subagent prompt from an identity line, autonomy instructions, an optional readonly line, and SAND_SUBAGENT_SAFETY_PROMPT_SECTION  
  `source/host/runner/system-prompt.ts:66-74`
- isMediaReviewSubagentType matches only the normalized strings "watchvideo" and "videoreview" after stripping non-alphabetic characters  
  `source/host/runner/system-prompt.ts:54-57`
- buildAttachedFilesNote returns an empty string for an empty/whitespace-only path list and switches its guidance text based on whether any file was staged into the box  
  `source/host/runner/system-prompt.ts:28-40`
- buildReplyContextNote returns an empty string unless replyContext is an object with string targetId and quote fields that are both non-empty after trimming  
  `source/host/runner/system-prompt.ts:44-49`
- parseLatestAgentProfileUpdate scans for every profile-update marker and returns the last well-formed one, swallowing JSON/base64 parse errors  
  `source/host/runner/sand-agent-profile-prompt.ts:9`

## Did not verify

- The rendered CONTENT of every delegated section — renderUserIdentitySystemPrompt, renderTimeZoneSystemPrompt, renderMemorySystemPrompt / renderUserMemorySystemPrompt / renderProjectMemorySystemPrompt, renderAutomationsSystemPrompt, renderWorkflowsSystemPrompt, renderChannelsSystemPrompt, renderAgentDirectorySystemPrompt — lives in other modules I was not asked to read, so I can state only their gating and arguments, never their text or their empty-return conditions.
- Whether isMemoryFreezeEnabled() (the module-level default in sand-memory.js used at system-prompt-assembly.ts:189) returns true or false by default, and what resolveFrozenMemoryPrompt does when the epoch differs — not read.
- The actual runtime values of the experiment flags (isSpotlightEnabled, isMultitaskEnabled, isMcpMultiAccountEnabled, isCloudAgentsDisabledByTeam). I verified only their default-when-missing values in host-runner-composition.ts:1379-1383; the experiments object itself was not read.
- Whether overrides.systemPrompt can in practice be an empty string. I verified only that host-runner-composition.ts:1340-1345 applies no non-empty check to it; where `overrides` originates was not traced.
- Whether any other composition site (tests, a dev/subagent runner, a non-production path) constructs createSystemPromptAssembly with non-null memory/automation/workflow/channel stores. Grep found only the one construction at host-runner-composition.ts:1339, but grep covered only *.ts and *.js under the repo and excluded node_modules.
- Who, if anyone, calls buildSandSubagentSystemPrompt and isMediaReviewSubagentType. Grep found no importer; they may be dead code in this reconstruction, or reached through a path grep did not cover (dynamic import, bundled dist, non-.ts/.js file).
- Whether prepareAgentProfilePromptSnapshot / getAgentProfileUpdateForTurn actually run per turn and whether the persisted snapshot's profileSection ever reaches the prompt — the single getSystemPrompt call site passes no snapshot, and I did not read turn-run-shell.ts end to end to see how the snapshot is otherwise consumed.
- Token cost / size of the assembled prompt. I read the text but did not measure or estimate its token count.
- Whether SAND_DISABLE_USER_REPLY_REMINDER is set anywhere in the deployed environment.
- The order in which sections appear in the ACTUAL final prompt string as sent to the model — I verified the array order in source, not a captured runtime prompt.