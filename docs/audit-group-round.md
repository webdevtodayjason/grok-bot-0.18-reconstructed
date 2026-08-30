# Group round — findings

Companion to the group-chat contract of 2026-08-30 evening. Everything here is
wire-measured on the local box (MacBook Pro) against Nemotron 3.5 Lightning 30B on
Spark 4; the member-turn tap quoted below was temporary and is reverted.

## Silent-member verdict: the model hand-writes the tool call as text

Atera Triage's group-member turns run to completion — the wire shows her request going
out (group persona prompt, ~16K chars) and the model answering, every time, with exactly:

```
{
"name": "SendMessage",
"arguments": {
"text": "here"
}
}
```

**as plain text, not a tool call** (wrong argument name too — `text` for `content`).
vLLM's tool parser never sees it, the room's transport only accepts real SendMessage
calls, and a text-only member turn is treated as a pass by design — so the room hears
nothing. Chief of staff, same room, same prompt shape, emits native
`SendMessage {"content": "Chief of staff: here."}` calls every round, and even sends a
correct `"(pass)"` when he has nothing to add.

Reproduced deterministically across four tapped rounds. This is per-persona
tool-adherence variance in the model under the group-member override prompt — the same
failure family as the old Ollama tool-shim findings, resurfacing for one persona in one
context. It is NOT: member resolution (clean), the nested-group filter (no stray
group.json, zero warnings), run-lifecycle contention (`beginSessionRun` never throws;
her turn visibly ran at t=150s in the quiet-start watch), or runner structure
(`createRunner` rebuilds per session identically for member turns).

## Fix attempt, measured

A one-file prompt nudge in `buildGroupMemberSystemPrompt` ("never write a JSON object or
tool-call syntax as text") was applied, deployed, and retested: **no effect** — her
output stayed byte-identical. Reverted rather than shipped. Two robust fixes filed as
Wave 5 #13:

1. **Text-shaped tool-call adapter**: in the member-turn path, parse a text-only
   completion that is a lone `{"name": "SendMessage", ...}` object and treat it as the
   call it plainly is (arg-name tolerant, member turns only).
2. **Member model routing**: run group member turns on a stronger tool-calling model —
   converges with Wave 5 #12 (per-agent provider/model).

## Also observed on the wire

- The pass protocol works end to end: `SendMessage("(pass)")` accepted and filtered.
- After a delivered message, the member model appends `<system_reminder>` self-notes as
  trailing text — harmless, dropped, but visible in captures.
- Once, an untapped rerun posted her raw JSON text INTO the room (nondeterminism at the
  drop boundary) — the adapter fix would make that impossible as well as unnecessary.

## Did not verify

- Whether other personas beyond these two exhibit the text-call behavior.
- Behavior under a different tool-capable model (blocked on Wave 5 #12/#13).
- Shared/cross-user room paths (out of contract).
