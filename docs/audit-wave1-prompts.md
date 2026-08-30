# Wave 1 — Prompt assembly, proven

Sources: four exhaustive readers (`docs/evidence/reader-w1-*.md`, every claim file:line),
corroborated by the Wave 3 wire capture (`docs/evidence/assembled-system-prompt.txt`).

## The carrier path

1. **Assembly**: `createSystemPromptAssembly` → `getSystemPrompt()` joins up to 17 sections
   with `\n\n` (`system-prompt-assembly.ts:249-266`). Base prompt is
   `DEFAULT_SAND_SYSTEM_PROMPT` from the 281-line `system-prompt.ts` (`:267`), swapped for a
   cloud-agents-disabled variant when that team gate is on (`:250-251`).
2. **Wiring**: the ONLY production consumer is `host-runner-composition.ts:2523` —
   `systemPromptGenerator: () => productionSystemPromptAssembly?.getSystemPrompt() ?? DEFAULT_SAND_SYSTEM_PROMPT`
   — a zero-arg closure in the runner's staticConfig.
3. **Attachment**: one layer out, `user-message-action-handler.ts:186-198` unshifts
   `{role:"system", content: systemPromptGenerator(...)}` at index 0 of the turn's messages.
4. **Provider entry**: `conversationInput` (`provider-session.ts:127-155`) collects every
   non-blank system-role body into `own`, joins with `\n\n`, and uses it as `instructions`;
   the thin `GROK_AGENT_SYSTEM_PROMPT` fallback (`:153`) fires only when `own` is empty.
5. **Wire truth**: the capture shows `instructions` of **73,769 chars** beginning
   "You are Grok Bot, a warm, concise desktop assistant." — the real assembled prompt
   reaches the local model. The fallback is NOT in play. (Earlier session suspicion:
   falsified.)

## Section map (order + gates)

Base prompt → spotlight (`isSpotlightEnabled !== false`; production returns false unless
experiment on, so normally omitted) → agent profile (null-dropped; **shared-room runners
stop here**, `:256`) → user identity → multitask section (never passed in production) →
cloud-agents-disabled section (mutually exclusive with the base swap on
`isSystemPromptOverridden`) → MCP multi-account (experiment) → time zone (dropped for
box-scoped subagents) → memory (live render or frozen snapshot vs `compactionEpoch`;
user 50/15, project 25/10 cap 3, agent recall 30) → automations (≤100) → workflows →
channels (filtered to `connectorManifests` platforms) → agent directory (dropped for
subagents) → MCP custom instructions → MCP discovery status → remote box → computer.
Full detail with line numbers: `reader-w1-prompt-core.md`.

The base prompt's own 24 headings (identity → "How a turn works" → "SendMessage is your
only voice" → … → "Security", `system-prompt.ts:77-266`) are all present in the wire
capture, `cloudAgentsEnabled` variant selected.

## The three real drops found

1. **claude-code provider branch discards the toolset and collapses the system prompt**:
   `claudeExecutor` takes no definitions (`provider-session.ts:329,483`), sends `tools: []`
   unless an mcpServerUrl exists (never supplied by `stream()`, `:340`), and re-renders the
   whole conversation as "ROLE: content" prose behind `GROK_ROUTER_SYSTEM_PROMPT`
   (`:177-183`). Route an agent via claude-code and it loses both its tools and its prompt.
2. **Subagent runners can get an EMPTY toolset silently**: `fencedToolSet([])` when
   `isSubagentRunner && !computerUse && !browserUse && subagentConfigs === undefined`
   (`turn-toolset.ts:1298-1304`).
3. **The zero-arg generator cannot describe the toolset**: the agent passes props and a
   toolSetHandle to `systemPromptGenerator` (`user-message-action-handler.ts:188-197`) and
   the production closure ignores them (`host-runner-composition.ts:2523`) — the prompt
   cannot enumerate tools, matching Chief's refusal to list them.

## Glue findings (reader-w1-prompt-glue.md)

Reply context, attachment notes, and user-address notes are appended to USER messages
(`prompt-collector-glue.ts:344-355,384-395`), never as system messages — consistent with
the wire's role pattern (one system message, then user/assistant/tool history).

## Hygiene (encountered, not fixed — filed in Wave 5)

- `production-turn-input-projection.ts` is entirely unreferenced (repo-wide).
- `createTurnToolSession` (`turn-agent-composition.ts:185-207`) has no callers; its
  middleware order is duplicated inline at `turn-run-shell.ts:213-230`.
- `profilePromptSnapshot` set twice in one literal (`turn-run-shell.ts:249-251,256`).

## Did not verify

- Runtime values of the experiment gates (spotlight, MCP multi-account, multitask) on OUR
  box — inferred from composition defaults, not observed.
- The memory-freeze path (no compaction epoch has occurred on this box).
- The shared-room early-return path against a live shared room (`isEnabled:false` upstream).
- Claude-code branch behavior on the wire (traced in source only; we route openai-compatible).
