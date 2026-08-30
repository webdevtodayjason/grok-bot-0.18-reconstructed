# Wave 3 — The wire

Method: a temporary tap in `streamOpenAiCompatibleChat` appended every outgoing request
(instructions, tool names, message roles, first tool schema) to a JSONL inside the box;
bundle rebuilt via `buildProductionHostIfSupplied`, `docker restart` (not recreate), six
requests captured across three prompts, tap reverted, pristine bundle restored, capture
deleted from the box. Evidence: `docs/evidence/wire-request-{0..5}.json`,
`docs/evidence/wire-capture-raw.jsonl`, `docs/evidence/assembled-system-prompt.txt`.

## What the wire proves

1. **The full assembled prompt reaches the model**: `instructions` = 73,769 chars,
   opening "You are Grok Bot, a warm, concise desktop assistant." and closing with the
   computer-use takeover guidance. The thin-fallback hypothesis is dead.
2. **26 tools, stable across requests**, `tool_choice: auto`, streaming, thinking off.
3. **History is intact**: system + interleaved user/assistant/tool roles, tool_calls and
   matched tool results present (the a65023f/92db71a serialization fixes are working).
4. Tool results are fenced as `<cursor_untrusted_data_1337 source="...">` — untrusted-data
   isolation is live on the local path.

## P1 reproduced live, with the model exonerated

Prompt: "Open titaniumcomputing.com in your browser and tell me the exact page title."
The capture shows, in order:

1. `Task({description:"Open website and capture screenshot", prompt:"Open the browser on
   the box desktop…"})` → tool result: `Error: Invalid arguments: subagent_type: Invalid
   value. Expected one of: generalPurpose`
2. Retry → `Error: No subagent types are available.`
3. Retry with `subagent_type:"generalPurpose"` — exactly what the error demanded —
   → `Error: No subagent types are available.`
4. The agent then told the user the truth: "The subagent launch failed - no subagent
   types are available." and offered alternatives.

**P1 verdict: the model was compliant all along.** It received the full prompt, chose the
right tool, obeyed the error's own instruction, and reported the failure honestly. The
fault is the reconstruction's host: (a) the Task **schema** was built from a config list
containing `generalPurpose` (the validation enum proves it), while (b) Task **execution**
received an empty `subagentConfigs` list, hitting
`task-subagent-preparation.ts:494` — a schema/execution inconsistency in the run wiring.
Compounding it, `computerUse` never enters the enum because
`turn-agent-composition.ts:1695` requires `remoteBoxHasDesktop && getRemoteBoxAvailable()`
and our box connector evidently reports no desktop, despite the box running X + noVNC.
The earlier "Chief narrates actions it does not take" reading — and the session's harsher
"Chief lied" — were wrong: the narration was an accurate account of a failed dispatch.
Chief's refusal to enumerate its tools also matches the prompt's own security section
plus the fact that the zero-arg prompt generator cannot see the toolset (Wave 1, drop 3).

## Did not verify

- The exact assignment site where execution-time `subagentConfigs` diverges from the
  schema-time list (closure `subagentConfigsForRun` in `turn-agent-composition.ts:1690` is
  the suspect; not chased to the assignment under the tripwire — filed as Wave 5 fix #1).
- Whether `getSubagentConfigs?.()` (the base supplier) is empty or absent on our box.
- Behavior under the cursor/codex/openrouter provider branches (only openai-compatible taped).
