# VOICE-16b: on the phone, Titan talks like a person

Jason, 2026-09-12 23:36 CDT, after the first working call on build 20: "when we're in voice, Titan
needs to be less verbose. It can be verbose in the text that's being printed out, but it needs to
be shorter and more conversational. Instead of repeating everything it did, it can say, 'Yep, I
did it. Okay, right?' ... less like a syllabus coming back every time."

Today (VOICE-16 + VOICE-3): the voice answers conversation itself from the brief, and for an action
the box's whole written reply is cut into sentences and each one is sent as "read this out, word
for word". So every result is read like a report. The text on screen is right; the spoken version
is the problem. Relay only, no app build.

## What changes, all in `ui/voice-edge.mjs`

1. **The instructions carry a spoken-voice contract**, written once per call as before. In
   `voiceInstructions({agentName, brief})`: you are on a phone, so everything you say is one or
   two short sentences in plain conversational words; no lists, headings, file paths, or code read
   aloud; when a result comes back from the box, give the gist in one breath ("Done. The backup ran
   clean.") and, only if there is more, say the rest is on the screen. Keep the greeting, the
   barge-in, and the "say what you are doing while you wait" line.
2. **The box's reply is no longer read verbatim.** In the titan() result path: the FIRST sentence
   of the draft is still spoken as it lands (that is the latency win of VOICE-3 and it stays), and
   everything after it goes into the `function_call_output` with a `spoken` hint: "the person heard
   the first sentence; say the rest in one short spoken sentence, or nothing if the first sentence
   already covered it". The page and the conversation still get the whole text; only the
   provider's copy is trimmed.
3. **A held card, a yes/no, and a refusal are unchanged**: those already speak one sentence.

## Tests (`tests/voice-turn.test.mjs`, the VOICE-3 cases)

- The instructions string contains the spoken contract, once, and `phoneLineInstructions` (the
  fallback for an old host) is untouched byte for byte.
- A three-sentence reply produces ONE read-this-out item (the first sentence) plus one tool output
  carrying the remaining two sentences and the spoken hint; billed items and response.create counts
  updated accordingly, with the numbers explained in the assertion messages.
- A one-sentence reply produces one read-this-out item and a tool output that says there is nothing
  more (`alreadyRead: true` as today).
- The page's `said` frame still carries the whole reply.

## Rules

- Model opus, own worktree, only `ui/voice-edge.mjs`, `docs/VOICE.md`, `tests/voice-turn.test.mjs`.
  Never rewrite instructions mid-call. No em dashes. `node --test` on voice-turn, voice-brief,
  voice-transcription, voice-wire, voice-caps-ledger; paste the summaries in
  docs/VOICE-16B-REPORT.md with what is not proven (no real call from a worker). Commit on the
  branch, do not push, do not touch the R750.
