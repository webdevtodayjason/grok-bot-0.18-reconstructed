# VOICE-16: the voice has Titan's brain, the box does the work

Jason, 2026-09-12 21:32 CDT: "What are we going to do about real-time voice versus constantly
having to pause, offload, and not carry on the conversation? It just feels so broken."

Today the voice model is a phone line with no knowledge (ui/voice-edge.mjs `voiceInstructions`,
`titanTool`): every utterance goes to the box through sendPrompt, the box answers in 5 to 25 s, and
the voice reads it back. VOICE-14 part 3 streams that answer in sentences and the talk tier makes
the box faster; neither removes the round trip. This wave removes it for conversation and keeps it
for actions.

## What changes

1. **A voice brief from the box, once per call.** A new gateway read `getVoiceBrief({agentId})`
   on the host answers `{ persona, facts[], recent[] , agentName, workspaceName }`: the agent's
   persona text, its memory facts (the same store the handbook reads), and the last 20 turns of
   its conversation as `{role, text, at}`. Cap the whole brief at 12 KB; trim recent first, then
   facts, never the persona. Measure what exists on the host first (handbook/memory reads used by
   KB-1 and BOTS-4, the transcript tail voice-edge already reads) and reuse it; write down in the
   report which surfaces it came from.
2. **The instructions are built from the brief, once, at session.update.** `voiceInstructions`
   becomes `voiceInstructions({ agentName, brief })`: the voice IS Titan on the phone; it answers
   from the brief and the conversation for anything conversational; it calls the `titan` tool for
   an action, a lookup, a file, a machine, a number it does not have, or anything it is not sure of,
   and says in one short sentence what it is doing while it waits ("checking the mail now"). The
   prefix rule holds: the instructions are written once per call and never rewritten during it.
3. **The tool changes meaning.** `titanTool` description: do this, look this up, or check this;
   not "everything the person says". The tool result path (VOICE-3 sentence streaming, held cards,
   yes/no) is unchanged.
4. **One memory.** At close, the relay hands the whole spoken exchange to the box as a single
   transcript note through the existing sendPrompt seam: "Voice call <start> to <end>: <person>: ...
   <Titan>: ..." tagged so the box files it as a transcript entry and does NOT answer it (find or
   add the right flag on sendPrompt; if none exists, the note asks Titan in one line to file it and
   reply nothing). The caption (`makeCaption`) already holds the person's words; the voice's own
   words come from `response.output_item.done` transcript events (both vendors emit them; the
   vendor map has one entry per event).
5. **The dial tone stays** (VOICE-14c greeting) and barge-in stays (VOICE-14 part 2).

## Tests

- `tests/voice-turn.test.mjs`: a call whose stub gateway serves a brief gets instructions that
  contain the persona and the facts and the last turn; the instructions frame is sent once; a
  conversational utterance answered by the model directly produces NO sendPrompt; an action
  utterance produces one; the closing transcript note is one sendPrompt carrying both sides.
- A host test next to the existing transcript tests for `getVoiceBrief` (cap, trimming order,
  empty memory, unknown agent answers `{brief:null}`).
- Old host without the command: `isUnknownGatewayMethod` path, the voice falls back to today's
  phone-line instructions, byte for byte, and the test proves it.

## Rules

- Model opus. Own tree: the worktree named in your prompt. Files: `ui/voice-edge.mjs` (the
  instructions, tool, brief reader, close note), `source/host/` (the new read command and its
  wiring in host-gateway-api.ts and gateway-protocol.ts, mirroring `getTurnDraft` from VOICE-14
  part 3), `docs/VOICE.md`, the tests above. Do NOT touch ui/machine-room/* (VOICE-15 owns it).
- Never rewrite instructions mid-call. Never put a secret in the brief (the memory store may hold
  connector names; never values).
- `npm run source:typecheck`, `node scripts/build-host.mjs --out /tmp/voice16-hostbuild`,
  `node --test` on every touched suite. Report in docs/VOICE-16-REPORT.md with what is not proven.
- Commit on your branch, do not push, do not touch the R750, no GUI browser, no em dashes.

## Ship (operator)

Relay restart, then host update demo box then Jason's box. Measured: a conversational question
answered in under two seconds with no sendPrompt in the relay log; an action question producing
one; the call's transcript note visible in Titan's conversation afterwards.
