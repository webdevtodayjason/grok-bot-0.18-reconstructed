# VOICE-16: the voice has Titan's brain, the box does the work

Branch `voice16-brain`. Jason's words that drove it, 2026-09-12: "Why can't the voice just be Titan?"

## The short version

The relay now reads one thing off the box before it dials: the agent's own persona, its remembered
facts, and the last twenty turns of the conversation it is already having with the person. Those become
the realtime session's instructions, written once at `session.update` and never rewritten during the
call. A question the agent already knows the answer to is answered by the voice itself, with no
`sendPrompt`, no round trip, and none of the 5.5 to 25 seconds that used to be the price of saying
anything at all.

The tool did not go away, it changed meaning. Anything that has to be done, looked up or checked still
goes to the box exactly as before, and so does every answer to a question that came back from there, so
a spoken yes still closes a held action through the approval path and never in the voice's own head.

At the close the whole spoken exchange goes into the conversation as one note, both sides of it, because
the turns the voice answers itself no longer leave a row of their own.

A box whose host has no `getVoiceBrief` dials the phone line it always dialled, byte for byte, and a
test asserts that string literally.

## What was measured before anything was built, and three of the four changed the design

**1. The host already holds all three pieces, and none of them needed a new store.** The persona is
`sessionStore.getAgentProfileText(agentId).description`, which `marketplace-bot-import.ts:203` calls in
writing "the host has ONE identity field, the agent's description" and which BOTS-4 composes a catalog
bot's persona into. The facts are `memory.list({agentId})`, which is exactly what the gateway's own
`getAgentMemories` serves (`transcript-manager.ts:374`) and what BOTS-4's Add button writes into. The
conversation is `sessions.getAgentTranscriptTail`, the same read the relay already polls every 400 ms.
So the new command reads three things that already existed and writes nothing anywhere.

**2. There is NO flag on `sendPrompt` that means "remember this, do not answer it", and the brief
allowed for that.** The host's `sendPrompt` takes `agentId`, `directAddressedAcceptance`,
`attachmentPaths`, `attachmentNames`, `richText`, `replyToId`, `clientNonce`, `thinkHarder`, `isFork`,
`traceparent`, `enterEpochMs`, `composedAtMs` and `awaitTurn` (`host-gateway-api.ts` `sendPrompt`), and
not one of them suppresses the reply. The hidden prompt that a box hand-off, an MCP authorization and a
widget answer all ride, `boxHandoff.resumeWithHiddenPrompt`, is not on the gateway protocol at all and
RESUMES a turn rather than silencing one, so it would be the wrong mechanism even if the relay could
reach it. So the note asks, in its own first two sentences, and whether the agent honours that is named
under "what is not proven" rather than claimed.

**3. `quotableEntryText` answers text for assistant prose too, and that would have had the voice read
the agent's scratch notes back as conversation.** `send-message-shaping.ts` `quotableEntryText` returns
`entry.content` for every `kind:"message"` row whatever its role, and on this host plain assistant text
reaches nobody: `turn-runtime.ts`'s own reply nudge says "Plain assistant text is NEVER shown to the
user; only a real SendMessage tool invocation reaches them". Reading the text alone therefore picked up
"let me look at the gate log" as a turn of the conversation. The builder checks the KIND and not only
the text, so exactly two kinds of row become a turn: a person's own message, and a message the agent
actually sent. This is the same decision `turn-draft.ts` exists to defend for the streaming draft, and
the first test in `tests/voice-brief.test.mjs` is the one that caught it.

**4. The host has no workspace name, but it has a box name.** Nothing in `source/host` carries a
`workspaceName`. What exists is `host-runner-composition.ts:1169`, `getBoxName: () =>
readSandBoxSetting("SAND_TENANT") ?? hostname()`, which the gateway command now reads the same way. The
relay prefers its OWN tenant display name over that, because the box's answer is a container name on
the R750 and the tenant name is what a person calls the place.

## The host surface that was added

One command, mirroring `getTurnDraft`. `getVoiceBrief`, taking `{id}` and answering `{brief}` or
`{brief: null}`.

```
POST <gateway>/api/getVoiceBrief   {"id": "<agentId>"}
->  { "brief": {
        "persona":       "You run a two-person managed services shop with Richard.",
        "facts":         ["the deploy gate runs on the R750", "..."],
        "recent":        [{ "role": "person", "text": "...", "at": 1757000000000 },
                          { "role": "agent",  "text": "...", "at": 1757000000100 }],
        "agentName":     "Titan",
        "workspaceName": "acme"
      } }
```

Files:

- `source/host/extensions/transcript/voice-brief.ts` (new). Pure: the shape, the caps, the trim order
  and the turn reader. It touches no filesystem, no network and no clock it does not own, which is why
  every cap and the whole trim order can be pinned without a box.
- `source/host/extensions/transcript/transcript-manager.ts`. One method, `getVoiceBrief(agentId,
  {workspaceName, redact})`, beside `getAgentMemories`. Three reads, each guarded separately.
- `source/host/host-gateway-api.ts`. The command, the box name, and the redactor.
- `source/host/gateway-protocol.ts`. The protocol entry.

Four design points worth arguing with:

- **The 12 KB cap is a guarantee and not a hope, and that is why the persona has a ceiling of its own.**
  The brief said "trim recent first, then facts, never the persona". Taken literally, a 200 KB
  description would blow the cap with nothing the trim order is allowed to touch, and every call would
  then carry an unbounded cached prefix. So the trim order never touches the persona, exactly as asked,
  and the persona separately cannot exceed the cap less a 2 KB envelope. No real persona comes near it;
  the test that proves it uses 200,000 characters.
- **Facts are trimmed from the TAIL.** `FileMemoryStore.listMemories` sorts profile facts first and then
  by most recent, so the tail is the least important end. Trimming the head would throw away the agent's
  standing rules and keep yesterday's detail.
- **An unknown agent answers null, and that is a fact rather than an error.** The relay resolves the
  agent from its own authenticated session, so a null means the id it resolved is no longer on this box,
  which is exactly when the voice should go back to being a phone line instead of claiming to be
  somebody.
- **Every read is guarded on its own.** A box with no memory service, a profile file that was never
  written, a conversation store mid-repair: each costs the brief that one part and not the call. A voice
  with a persona and no facts is still the agent.

No secrets can travel in it: the persona, every fact and every turn go through the box's own
`createBoxSecretRedactor`, the same redactor the conversation outline, the action audit and the evidence
ledger use. It redacts VALUES, not names, which is right here: "the mail connector is Anvil" is exactly
the kind of thing the agent is supposed to be able to say out loud.

## The relay side

`ui/voice-edge.mjs`. The brief reader, the instructions, the tool description, the spoken-exchange
recorder and the closing note. `ui/machine-room/*` was not touched, and neither was the VOICE-14
barge-in path, the VOICE-14c greeting or VOICE-3's sentence streaming.

**`voiceInstructions({agentName, brief})`.** With a brief it is the agent: who you are, what you
remember, what the two of you have been saying, when to use the tool, when not to, never make anything
up, and how you sound. With no brief it is `phoneLineInstructions(agentName)`, which is the old string
kept whole in its own exported function so the fallback is provably the same words rather than a
paraphrase of them. The string form `voiceInstructions("Titan")` still works, because `buildSession`'s
own default uses it.

**The one rule that survived word for word is the held card.** A question that came back from the box
asking the person to confirm, approve or choose is resolved by the relay through the approval path
(`dispatch` reads `matchYesNo` against `session.heldCard`), so the instructions say, in their own
paragraph, that an answer to such a question always goes back through the tool even when it is only yes
or no, and that a yes is never done until it has been back through there. A voice that approved
something in its own head would leave the card open with nothing approved, which is the worst outcome
anywhere on this path.

**`titanTool()` is a job now.** "Hand a job to the rest of yourself... call this to DO something, to
LOOK something up, or to CHECK something... Do NOT call it for ordinary conversation you can already
answer." The old description said "call this for EVERYTHING the person asks or tells you", which was the
whole reason a conversation was a sequence of pauses.

**`readVoiceBrief` runs in `handleUpgrade`, before the dial, and this is the one place the
implementation deviates from the brief's wording.** The brief said "fetched once at dial and folded into
the instructions once at session.update". It is fetched in the stretch that already awaits the settings
file, the operator's key, the policy, the ledger and the roster, which is immediately before the dial,
rather than inside the provider's `open` handler. The reason is measured rather than stylistic: that
handler sends `session.update` synchronously the instant the socket opens, and an `await` inside it would
let forwarded microphone audio reach a provider whose session had not been configured yet. Folding
happens at `session.update` exactly as asked.

It carries its own 2.5 second budget, because a wedged box answers a gateway read in 20 seconds
(`makeGatewayCall`'s own timeout) and nobody pressing a talk button should wait 20 seconds for a
microphone. Four things answer null and each logs which it was: a 404 from an older host
(`isUnknownGatewayMethod`, the reader VOICE-3 already added), `{brief:null}` from a box that does not
hold that agent, any other throw, and the budget running out.

**The timer behind that budget is deliberately NOT `unref`'d**, where every other timer in the file is.
An unref'd timer cannot fire when nothing else holds the event loop, so the await would never settle and
the budget would be no budget at all. It is cleared the moment either side answers. This was found by a
test, not by reading.

**`makeSpokenExchange` keeps what was actually said, both sides, in the order it was said.** A Map keyed
by the provider's `item_id`, because both sides arrive in pieces that REPLACE rather than append: the
person's caption is replace-whole on both vendors, and the voice's own transcript arrives as deltas and
then as a settled whole. A Map keeps insertion order while letting a later, better copy of one item
overwrite the earlier one, which an array of pushes cannot do without writing every sentence twice.

The voice's side is read off three surfaces, later overwriting earlier on the same item:
`response.output_audio_transcript.delta` accumulated, its `.done` whole, and the message items on
`response.output_item.done` and on `response.done`. The brief named `response.output_item.done` and that
is read; the other two are read beside it because the stub provider this wave's tests run against emits
the transcript deltas and not the message item, and `tests/helpers/stub-realtime.mjs` is a frozen shared
contract that another wave holds. The person's side is recorded under the SAME guard the panel uses:
nothing is recorded while the machine is the one making noise, because docs/VOICE.md 8 records a measured
loop where the model's own speech came back through the microphone and transcribed as a user turn, and
writing that into a durable row would put words in somebody's mouth.

**The closing note is one `sendPrompt` carrying both sides, written AFTER the ledger row is settled.**
The row is what the day cap is read out of and what the operator's Spend line shows, so nothing may
delay it. What is still behind the note is the session being released, which is what lets the next press
in, so the note carries a 5 second budget of its own rather than holding the line shut for a gateway
timeout; a note abandoned there may still land on the box and the log says so rather than claiming it
failed. A call where nothing was said writes nothing at all. The labels are defined inside the note
itself, because it arrives in the agent's own conversation where a bare "Them" is ambiguous: the person
it is about is the same person that conversation is with.

## Tests

All on this Mac, MacBook-Pro.local, darwin arm64, node v22.23.1, 2026-09-12.

| suite | result |
|---|---|
| `tests/voice-turn.test.mjs` | 70 of 70 (47 at the base commit) |
| `tests/voice-brief.test.mjs` (new) | 21 of 21 |
| `tests/voice-turn-draft.test.mjs` | 13 of 13 |
| `tests/voice-wire.test.mjs` | 12 of 12 |
| `tests/voice-transcription.test.mjs` | 15 of 15 |
| `tests/voice-caps-ledger.test.mjs` | 35 of 35 |
| `tests/cp-voice.test.mjs` | 27 of 27 |
| `tests/voice-socket.test.mjs`, `voice-frames`, `voice-capture` | 11, 14, 10 |
| `tests/machine-room-voice.test.mjs` | 85 of 85, untouched by this wave |
| the seven suites that bundle `transcript-manager`, `host-gateway-api` or `gateway-protocol` | 116 of 116 |
| `npm run source:typecheck` | clean |
| `node scripts/build-host.mjs --out /tmp/voice16-hostbuild` | `validated-clean-source clean=true` |
| `node --check ui/voice-edge.mjs` | clean |

`tests/voice-turn.test.mjs` grew from 47 to 70. The twenty-three new cases, in the order the brief asked
for them:

- The fallback, asserted against the literal 890-character phone-line string, through all four ways a
  caller can mean "no brief" including `buildSession`'s own default.
- The brief's persona, both facts and the last turn present in the instructions, with the person's and
  the agent's sides of the conversation labelled apart, and the old "you are the voice of" wording gone.
- The held-card rule still in the instructions, word for word.
- An empty brief still being the agent, with no empty headings.
- The tool re-described, with the old "EVERYTHING the person asks or tells you" gone.
- `readVoiceBrief` answering null for all four failures and logging which one; the 2.5 second budget
  against a read that never answers; the tenant name beating the box's; a malformed brief read without
  throwing and without carrying rubbish into the prompt.
- The exchange: order preserved, a later copy replacing an earlier one, the settled transcript
  overwriting the deltas without appearing twice, the items on `response.done` read, the legacy event
  name read, an event carrying nobody's words ignored, and the bound dropping the OLDEST lines.
- The note: one prompt, both sides, labelled, asking to be filed rather than answered; nothing said
  leaving no note; a long call keeping its end and saying how many lines it dropped.
- Four end to end through the real stub and a real websocket client: the brief reaching the provider
  inside the instructions with exactly ONE `getVoiceBrief` read and exactly ONE `session.update` for the
  life of the socket; a box with no command dialling the literal phone-line string; a turn the model
  answers itself sending NOTHING to the box while an action sends one; and the call leaving one note
  carrying both sides, stamped `voice:<session>:note`.

`tests/voice-brief.test.mjs` bundles two things. The pure builder, where the cap, the trim order, the
per-turn and per-fact clamps, the empty cases and the redaction are pinned with no box. And
`TranscriptManager` itself, driven against a fake session store, which is the only way to prove what the
wiring decides: an unknown agent answering null, the persona coming off the agent's own profile, a box
with no memory service still answering a brief, a memory service that throws costing the facts and not
the call, the tail being read with the window the brief asks for, and the redactor the gateway hands in
being the one that runs.

Sizes, measured on this Mac: the phone line is 890 characters; the instructions with a small real brief
are 2,496; the fixed scaffolding with an empty brief is 1,991; and a brief trimmed right up to the 12 KB
ceiling (11,990 bytes of JSON) produces 13,966 characters of instructions.

## What is NOT proven

Read this before believing anything about latency or behaviour.

1. **No real spoken turn was measured, on any box.** Nothing here names the R750 and nothing here names
   a real realtime model. The `T0 -> TB` row added to docs/VOICE.md 5 is marked not yet measured for
   that reason.

2. **Whether a real model actually answers out of the brief instead of calling the tool is NOT proven,
   and cannot be proved against a stub.** The stub provider emits whatever a test tells it to; it makes
   no decisions. What the end-to-end test pins is the relay's half: a turn that arrives with no `titan`
   call costs the box nothing and leaves no panel open, and a turn that arrives with one sends exactly
   one prompt. The choice belongs to the model and the instructions, and one real call on the demo box
   settles it: ask something the brief covers and read the relay log for a turn with no `sendPrompt`
   line in it.

3. **Whether the agent honours "do not reply to it" is NOT proven.** There is no flag that can enforce
   it, for the reasons measured above, so the note asks. If the agent answers it anyway, the answer lands
   in the conversation like any other and nothing is lost, but a person will see one extra message after
   every call. This is the single most likely thing to need a second pass.

4. **The `item_id` key on the spoken exchange has one shape it cannot tell apart.** Both vendors stamp
   `item_id` on every transcript event of one spoken item, which is why it is the key. A vendor that
   omitted it would fall back to the response id, and two message items in one response would then
   collapse into a single line of the note. No real wire has been checked for that.

5. **The brief's effect on the bill is not measured against an invoice.** A bigger cached prefix costs
   more on a vendor that bills tokens and nothing on a vendor that bills a flat minute; what it buys back
   is whole turns that never happen. docs/VOICE.md 7 states the trade and states that neither side of it
   has been measured.

6. **No gate leg was added to `scripts/verify-voice.mjs`.** Another worker holds that file this wave, as
   it did for VOICE-3. The operator's measurement is one real call.

7. **The console shows nothing different.** A turn the voice answers itself produces no row in the
   conversation while the call is open, and the note at the end is what puts it there. Telling the page
   about a self-answered turn would mean touching `ui/machine-room/*`, which belongs to VOICE-15 this
   wave.

## One tracker row this wave inherited and did not take

`docs/GAP-ANALYSIS.md` VOICE-13e names its owner as "the voice wave that next opens
`ui/voice-edge.mjs`", which is this one. It asks for a line TYPED on the phone call screen to be spoken
back, and it needs a new browser-to-relay frame plus the page half that sends it. The page half is in
`ui/machine-room/*`, which VOICE-15 holds this wave and which this wave's brief rules out by name, and a
frame nobody sends is dead code. So it is not taken, it is not quietly left either: the row already
carries an owner and a concrete next action, and this wave has added one clause to it recording that
VOICE-16 opened the file and why it passed.

A VOICE-16 row was added to the same table, because a wave that has landed with no row in the tracker is
the stale-tracker failure. Both edits are single rows, so a merge with the other workers on that file is
trivial.

## Files changed

```
source/host/extensions/transcript/voice-brief.ts        (new)
source/host/extensions/transcript/transcript-manager.ts
source/host/host-gateway-api.ts
source/host/gateway-protocol.ts
ui/voice-edge.mjs
tests/voice-brief.test.mjs                              (new)
tests/voice-turn.test.mjs
docs/VOICE.md
docs/GAP-ANALYSIS.md                                    (two rows)
tests/index.js                                          (two lines)
docs/VOICE-16-REPORT.md                                 (this file)
```

## For the operator

1. Merge, run the voice suites once more.
2. `updateHostNow` on the demo box, then Jason's box. The host half is the new command; the relay half
   is everything else, so restart the relay LAST.
3. One call. Ask something the brief covers, such as what the two of you decided last, and watch the
   relay log: a line reading `opened with <name>'s own brief` at the start of the call, and then NO
   `sendPrompt` for that question. Then ask for something that needs doing and watch exactly one go.
4. Hang up, and look at the conversation on screen. The note should be there, carrying both sides, and
   whether the agent answered it is the thing to report back.
