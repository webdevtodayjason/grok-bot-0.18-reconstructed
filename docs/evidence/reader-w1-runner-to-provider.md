# Reader output: w1:runner-to-provider

## Scope

Read end to end: `sand-agent-runner.ts` (1425 L), `turn-run-shell.ts` (842 L), `production-turn-input-projection.ts` (69 L), `turn-agent-composition.ts` (1742 L). References chased out of those four (read only as far as needed to answer): `provider-session.ts`, `production-turn-run-shell-adapter.ts`, `production-turn-agent-owner.ts`, `tools/turn-toolset.ts`, `packages/agent/tool-stream-executor.ts`, `packages/agent/actions/user-message-action/user-message-action-handler.ts`, `packages/chat-inference/base.ts`, `host-runner-composition.ts`.

## 1. Turn start → provider call

Call chain (each hop verified):

`SandAgentRunner.run` (sand-agent-runner.ts:1177) → early-returns into the production shell at 1213-1215 → `createTurnRunShell(...).run` (turn-run-shell.ts:534) → `host.prepareTurn` (turn-run-shell.ts:698) → `host.runPreparedTurn` (turn-run-shell.ts:747) → adapter `runPreparedTurn` (production-turn-run-shell-adapter.ts:303-332) → `createTurnAgentStreamStart` (turn-agent-composition.ts:642) → **`agent.runStream(attemptCtx, state, action, mcpTools, persistCheckpoint)`** (turn-agent-composition.ts:656-662). A second identical `runStream` call site exists in `buildAgentForRun` (turn-agent-composition.ts:776-784).

**The system prompt is never attached to a message array inside these four files.** It travels only as a function reference: `TurnAgentStaticConfigInputs.systemPromptGenerator` (turn-agent-composition.ts:230) → copied into the static config (296) → handed to `new AnysphereAgent(input.config, ...)` (884-892). Message attachment happens one layer out, inside the agent package: `newMessages.unshift({ role: "system", content: configAny.systemPromptGenerator({...}, toolSetHandle) })` (user-message-action-handler.ts:186-198), appended to the root prompt executor at 301 ahead of history at 302. Shape: a single `{role:"system", content}` message at index 0. The same pattern repeats in resume/summarize/shell-command/execute-plan handlers.

Below the executor, the message array is `BasePromptBuilder.messages` (base.ts:3-15). What the provider actually receives depends on the branch — see §3.

## 2. Toolset attachment and its type at the provider

Two separate channels, and they are not the same type.

**(a) Turn toolset.** `createTurnAgentToolsHandoff` (turn-agent-composition.ts:327-552) closes over the per-turn host and returns `toolsGenerator` (530-549), which is placed on the agent config in `createSandAgentStaticConfig` (300) via `buildAgentForRun` (768) or `createTurnAgentConstructorHandoff` (579). Declared type at that boundary: `(props: TurnToolsetBuildProps) => ReturnType<typeof buildTurnTools>` (231-233, 602-604) — i.e. `ToolSetHandle` (turn-toolset.ts:1293-1297). The agent calls it per action (user-message-action-handler.ts:116-130). By the time it reaches the provider it has been flattened: `toAgentTools(...)` → `executor.stream(ctx, invocationId, toolDefinitions, {...})` (tool-stream-executor.ts:904-914), forwarded as `readonly unknown[]` (tool-stream-executor.ts:1569-1575), and typed `definitions?: readonly Loose[]` where `Loose = Record<string, any>` at the provider (provider-session.ts:480, 20).

**(b) MCP tools.** Typed `readonly unknown[]` from creation and never narrowed: projection output (turn-agent-composition.ts:683), shell context (turn-run-shell.ts:373), stream input (turn-agent-composition.ts:613, 626, 726), forwarded by identity into `runStream`'s 4th positional slot (735, 660).

## 3. Branches that drop the prompt or the tools

Confirmed drops:

- **claude-code provider drops the entire toolset.** `provider-session.ts:483` calls `claudeExecutor(this.getMessages(), invocationId, this.onUsage)` — the `definitions` argument is simply not passed, and `claudeExecutor` has no `definitions` parameter at all (329). Its own SDK `tools` option is `[]` whenever `mcpServerUrl` is undefined (340), and `stream()` never supplies one. Every other branch (codex 482, openai-compatible 487, openrouter 488) forwards `definitions`.
- **claude-code also collapses the system prompt.** `providerPrompt` (177-183) renders every message as `"ROLE: content"` behind `GROK_ROUTER_SYSTEM_PROMPT`; the turn's own system message stops being a system-role message.
- **Subagent runners get an empty toolset.** `buildTurnTools` returns `fencedToolSet([], ...)` when `isSubagentRunner && !computerUse && !browserUse && subagentConfigs === undefined` (turn-toolset.ts:1298-1304).
- **Non-cursor provider swap.** `turn-run-shell.ts:185-188` reads `settings.json` synchronously per turn and, when `inferenceProvider !== "cursor"`, replaces the host-supplied session with `createProviderPromptSession(inferenceProvider) as unknown as TurnAgentPromptSession` — a double cast that bypasses the interface check. Same for summarization (196).
- **Static system prompt ignores tools.** The production generator is `() => productionSystemPromptAssembly?.getSystemPrompt() ?? DEFAULT_SAND_SYSTEM_PROMPT` (host-runner-composition.ts:2523) — it takes no parameters, so the `props` and `toolSetHandle` the agent passes (user-message-action-handler.ts:188-197) are discarded.

Fail-open, not drops:

- MCP discovery failure yields `mcpTools = []` (turn-agent-composition.ts:698-706) rather than aborting.
- In the shell, a `discoverMcpTools` throw leaves `context.mcpTools` unassigned (turn-run-shell.ts:672-691; the assignment at 675 is inside the `try`).
- The shell's discovered `mcpTools` are dead weight anyway: the adapter's `runPreparedTurn` names its context parameter `_context` (production-turn-run-shell-adapter.ts:305) and streams `owned.productionInput.mcpTools` (318) from the owner's own projection (production-turn-agent-owner.ts:138). Shell-side discovery only feeds `setMcpConnectedServerNamesForTurn` (turn-run-shell.ts:676-686).

Hard-fails rather than silent drops: inactive stream path throws (turn-run-shell.ts:817-821, 828-831; sand-agent-runner.ts:558-561, 568-571). Legacy runner with no `runStep` returns `undefined` with no provider call at all (sand-agent-runner.ts:1265). No branch omits `systemPromptGenerator` — it is a required field (turn-agent-composition.ts:230), always copied (296), and `agent-config-runtime.ts:13-14` throws if absent.

## Hygiene findings (evidence-backed, no fix applied — read-only task)

- `production-turn-input-projection.ts` is **entirely unreferenced**: repo-wide grep for `production-turn-input-projection` and `createProductionTurnAgentInputProjection` finds only the file itself. It is a passthrough over `createTurnAgentRunInputProjection` adding `ackToken`/`cancelThisRun`/`emitUpdate` (production-turn-input-projection.ts:59-68).
- `createTurnToolSession` (turn-agent-composition.ts:185-207) has no callers; its exact middleware order is duplicated inline at turn-run-shell.ts:213-230.
- `scope` object sets `profilePromptSnapshot` twice in the same literal (turn-run-shell.ts:249-251 and 256).
- Unused import: `BlobStore` (turn-run-shell.ts:39) — no other occurrence in the file.


**Q: Trace the path from turn start to the provider call: where is the system prompt attached to the outgoing message array, and with what role/shape?**

Path: SandAgentRunner.run (sand-agent-runner.ts:1177) → production shell delegation (sand-agent-runner.ts:1213-1215) → createTurnRunShell.run (turn-run-shell.ts:534) → host.prepareTurn (turn-run-shell.ts:698) → host.runPreparedTurn (turn-run-shell.ts:747) → adapter runPreparedTurn (production-turn-run-shell-adapter.ts:303-332) → createTurnAgentStreamStart.startStream (turn-agent-composition.ts:646-663) → agent.runStream(attemptCtx, state, action, mcpTools, persistCheckpoint) (turn-agent-composition.ts:656-662). Nowhere in the four audited files is the system prompt attached to a message array. It is carried only as the function reference `systemPromptGenerator` (turn-agent-composition.ts:230), copied into the static config (296), and handed to `new AnysphereAgent(config, ...)` (884-892). The actual attachment happens one layer out, in the agent package: `newMessages.unshift({ role: "system", content: configAny.systemPromptGenerator({requestContext, cursorRules, env, browserTools, cloudRule, mode, ...}, toolSetHandle) })` (user-message-action-handler.ts:186-198), then appended to the root prompt executor ahead of history (301-302). Shape: exactly one `{role:"system", content}` message at index 0 of the outgoing array. Below that, the message array is BasePromptBuilder.messages (base.ts:3-15), and what the provider sees varies by branch (provider-session.ts:127-150 for codex/openai-compatible, 373-378 for openrouter, 177-183 for claude-code).

*Evidence:* turn-agent-composition.ts:230,296,656-662,884-892; turn-run-shell.ts:534,698,747; sand-agent-runner.ts:1177,1213-1215; production-turn-run-shell-adapter.ts:303-332; packages/agent/actions/user-message-action/user-message-action-handler.ts:186-198,301-302; packages/chat-inference/base.ts:3-15


**Q: Where does the TOOLSET get attached to the turn, and what type does it have by the time it reaches the provider layer?**

Two channels. (a) Turn toolset: createTurnAgentToolsHandoff builds the lazy toolsGenerator (turn-agent-composition.ts:327-552, generator body 530-549); it is attached to the agent config in createSandAgentStaticConfig (300), wired by buildAgentForRun (760-769) or createTurnAgentConstructorHandoff (575-581). Declared type at the config boundary: `(props: TurnToolsetBuildProps) => ReturnType<typeof buildTurnTools>` (231-233, 602-604), i.e. a ToolSetHandle (turn-toolset.ts:1293-1297). The agent invokes it per action (user-message-action-handler.ts:116-130); before the provider request it is flattened by toAgentTools and handed to executor.stream as the third argument (tool-stream-executor.ts:904-914), forwarded as `readonly unknown[]` (tool-stream-executor.ts:1569-1576), and lands at the provider typed `definitions?: readonly Loose[]` with `Loose = Record<string, any>` (provider-session.ts:480, 20). So all structural typing is erased by the provider boundary. (b) MCP tools: created as `readonly unknown[]` (turn-agent-composition.ts:683), never narrowed, carried through TurnRunContext (turn-run-shell.ts:373) and TurnAgentStreamStartInput (626)/TurnAgentRunStreamInput (613), forwarded by identity into runStream's 4th positional slot (735, 660). The mcpTools that actually reach the stream come from the owner's own projection (production-turn-run-shell-adapter.ts:318), not from the shell context.

*Evidence:* turn-agent-composition.ts:231-233,300,327-552,602-604,613,626,660,683,735,760-769; tools/turn-toolset.ts:1293-1297; packages/agent/tool-stream-executor.ts:904-914,1569-1576; host/extensions/inference/provider-session.ts:20,480; production-turn-run-shell-adapter.ts:318


**Q: Is there any branch (provider kind, agent kind, inactive turn) that drops the system prompt or the tools before the provider sees them?**

Yes, three real drops. (1) Provider kind: the claude-code branch calls claudeExecutor without the tool definitions (provider-session.ts:483) — claudeExecutor has no definitions parameter at all (329) and sends `tools: []` unless an mcpServerUrl is supplied, which stream() never supplies (340). Same branch also collapses the system prompt: providerPrompt renders every message as "ROLE: content" behind GROK_ROUTER_SYSTEM_PROMPT (177-183), so the turn's system message stops being a system-role message. (2) Agent kind: a subagent runner that is neither computer-use nor browser-use and has no subagentConfigs gets fencedToolSet([]) — an empty toolset (turn-toolset.ts:1298-1304). (3) Effective prompt content: the production systemPromptGenerator is a zero-arg closure returning a fixed string (host-runner-composition.ts:2523), so the props and toolSetHandle the agent passes it (user-message-action-handler.ts:188-197) are discarded — the prompt cannot describe the tools. Also relevant but not drops: the non-cursor provider swap replaces the session via a double `as unknown as` cast (turn-run-shell.ts:185-196); MCP discovery failures fail open to `[]` (turn-agent-composition.ts:698-706) or leave context.mcpTools unassigned (turn-run-shell.ts:672-691) — harmless here because the adapter ignores the shell context entirely (production-turn-run-shell-adapter.ts:305,318); retries substitute RESUME_TURN_ACTION for the original action (turn-agent-composition.ts:1144-1152). Inactive turns throw rather than drop (turn-run-shell.ts:814-832; sand-agent-runner.ts:558-571), and the legacy runner with no runStep returns undefined without ever building a prompt or toolset (sand-agent-runner.ts:1265). No branch omits systemPromptGenerator itself: it is required (turn-agent-composition.ts:230), always copied (296), and agent-config-runtime.ts:13-14 throws when absent.

*Evidence:* host/extensions/inference/provider-session.ts:177-183,329,340,483; tools/turn-toolset.ts:1298-1304; host-runner-composition.ts:2523; turn-run-shell.ts:185-196,672-691,814-832; turn-agent-composition.ts:230,296,698-706,1144-1152; sand-agent-runner.ts:558-571,1265; packages/agent/agent-config-runtime.ts:13-14


## Claims

- The provider call is agent.runStream with five positional args: attemptCtx, redacted state, redacted action, mcpTools, persistCheckpoint.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:656-662`
- A second identical runStream call site exists inside buildAgentForRun's returned runStream closure.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:776-784`
- The system prompt is carried as a function reference (systemPromptGenerator), never as a message, in all four audited files.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:230`
- systemPromptGenerator is copied verbatim into the static agent config.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:296`
- The config carrying systemPromptGenerator is passed as the first constructor argument to AnysphereAgent.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:884-892`
- The system prompt becomes a {role:"system", content} message unshifted to index 0 of newMessages inside the agent package, with the toolSetHandle passed as the generator's second argument.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/packages/agent/actions/user-message-action/user-message-action-handler.ts:186-198`
- That system message is appended to rootPromptExecutor before conversation history.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/packages/agent/actions/user-message-action/user-message-action-handler.ts:301-302`
- The turn toolset is attached to the agent config as toolsGenerator, produced by createTurnAgentToolsHandoff.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:300`
- toolsGenerator's declared type is (props: TurnToolsetBuildProps) => ReturnType<typeof buildTurnTools>.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:231-233`
- buildTurnTools returns ToolSetHandle.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/turn-toolset.ts:1293-1297`
- buildAgentForRun installs the handoff's toolsGenerator into the static config it builds.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:760-769`
- The agent calls config.toolsGenerator once per action to obtain toolSetHandle, passing mergedMcpTools among the props.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/packages/agent/actions/user-message-action/user-message-action-handler.ts:116-130`
- Tools are converted to plain definitions via toAgentTools and passed as the third argument to executor.stream.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/packages/agent/tool-stream-executor.ts:904-914`
- SimplePromptToolExecutor.stream forwards tools to the inner executor typed as readonly unknown[].  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/packages/agent/tool-stream-executor.ts:1569-1576`
- At the provider boundary the toolset arrives as definitions?: readonly Loose[], where Loose = Record<string, any>.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/extensions/inference/provider-session.ts:480`
- mcpTools is typed readonly unknown[] at the projection, the shell context, and the stream input, and is forwarded by identity without narrowing.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:683`
- TurnRunContext declares mcpTools as an optional readonly unknown[].  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-run-shell.ts:373`
- The claude-code provider branch calls claudeExecutor without passing the tool definitions, so the turn toolset is dropped before the provider request.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/extensions/inference/provider-session.ts:483`
- claudeExecutor has no definitions parameter and sends tools: [] whenever mcpServerUrl is undefined.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/extensions/inference/provider-session.ts:329-340`
- On the claude-code branch the whole message array is flattened to a single string prefixed with GROK_ROUTER_SYSTEM_PROMPT, so the turn's system message is no longer a system-role message.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/extensions/inference/provider-session.ts:177-183`
- codex and openai-compatible branches extract system-role messages into an instructions string and fall back to GROK_AGENT_SYSTEM_PROMPT or GROK_ROUTER_SYSTEM_PROMPT when the conversation carries none.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/extensions/inference/provider-session.ts:127-150`
- The openrouter branch passes messages through raw and additionally sets system: GROK_ROUTER_SYSTEM_PROMPT on the streamText call.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/extensions/inference/provider-session.ts:373-378`
- A subagent runner that is neither computer-use nor browser-use and has no subagentConfigs receives an empty fenced toolset.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/tools/turn-toolset.ts:1298-1304`
- When the configured inference provider is not "cursor", the turn's agent session is replaced by createProviderPromptSession via a double `as unknown as` cast, bypassing the TurnAgentPromptSession interface.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-run-shell.ts:185-188`
- The summarization session is swapped the same way for non-cursor providers.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-run-shell.ts:189-196`
- createTurnAgentRunContext reads settings.json from disk synchronously on every turn to resolve the inference provider.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-run-shell.ts:185`
- MCP discovery failure inside the run-input projection leaves mcpTools as an empty array rather than aborting the turn.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:698-706`
- In the run shell, a discoverMcpTools throw leaves context.mcpTools unassigned because the assignment sits inside the try block.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-run-shell.ts:672-691`
- The production adapter ignores the shell's TurnRunContext (parameter named _context) and streams the owner projection's own mcpTools.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/production-turn-run-shell-adapter.ts:303-319`
- On a retry the projection substitutes the canonical empty RESUME_TURN_ACTION for the original action.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:1144-1152`
- SandAgentRunner.run delegates to the production turn shell and returns immediately when that shell is bound.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/sand-agent-runner.ts:1213-1215`
- Without a production shell and without options.runStep, SandAgentRunner.run returns undefined and never reaches a provider, system prompt, or toolset.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/sand-agent-runner.ts:1265`
- Inactive turn-agent stream paths throw rather than silently degrading.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-run-shell.ts:814-832`
- The production systemPromptGenerator is a zero-argument closure returning a fixed string, so the props and toolSetHandle supplied by the agent are discarded.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/host-runner-composition.ts:2523`
- createProductionTurnAgentInputProjection has no callers anywhere in the repo; the module is unreferenced dead code.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/production-turn-input-projection.ts:47-69`
- createTurnToolSession is exported but has no callers; its middleware order is duplicated inline in the run shell.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-agent-composition.ts:185-207`
- The duplicated inline tool-session middleware order lives in createTurnAgentRunContext.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-run-shell.ts:213-230`
- The turn scope object literal assigns profilePromptSnapshot twice.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-run-shell.ts:249-256`
- BlobStore is imported into turn-run-shell.ts but never used.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-run-shell.ts:39`
- createTurnAgentRunContext is called from exactly one place, the production turn agent owner.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/production-turn-agent-owner.ts:157`
- createProviderPromptSession's getExecutor treats its state argument as an initial message array only when it is an array, otherwise starts empty.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/extensions/inference/provider-session.ts:492-495`
- The run shell requests the agent executor with no state argument, so routed provider executors always start from an empty builder.  
  `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb/source/host/runner/turn-run-shell.ts:212`

## Did not verify

- Whether AnysphereAgent.runStream actually routes through the toolSession's SimplePromptToolExecutor for every action kind — I read the constructor wiring (turn-agent-composition.ts:884-892) and the user-message handler, but not index.ts's dispatch table or the other action handlers end to end.
- Which inference provider is configured in practice. turn-run-shell.ts:185 reads settings.json at runtime; I did not read any settings file or run the app, so I cannot say whether the tool-dropping claude-code branch is reachable in this deployment.
- Whether host-runner-composition.ts actually supplies options.productionTurnRunShell to SandAgentRunner in the live wiring — I read only lines 2500-2545 of that 2500+ line file, enough to confirm the staticConfig shape, not the full construction.
- The content of DEFAULT_SAND_SYSTEM_PROMPT and of productionSystemPromptAssembly.getSystemPrompt() — not read, so I cannot say what the system message actually contains or whether it names any tools.
- Whether the AI SDK's streamText tolerates both a `system` parameter and system-role entries inside `messages` on the openrouter branch (provider-session.ts:373-378), or silently drops one. That is library behavior I did not verify.
- Whether `mergeRequestContextTools` (user-message-action-handler.ts:115) alters or filters the mcpTools array between runStream and toolsGenerator — I saw the call but did not read the implementation.
- Runtime confirmation of any of this: I was read-only and did not execute the app or any tests, so every claim is static-source only.
- Whether the unreferenced production-turn-input-projection.ts is consumed by a build artifact, test harness, or generated bundle outside the source tree — my grep covered the repo excluding node_modules and found no importer.