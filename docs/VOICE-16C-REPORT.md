# VOICE-16c: the call's closing note is filed, not asked

Branch `night-voice16c`. The condition that drove it, from docs/VOICE-16-REPORT.md's own "what is not
proven": *"Whether the agent honours 'do not reply to it' is NOT proven. There is no flag that can
enforce it, so the note asks. If the agent answers it anyway, a person will see one extra message after
every call. This is the single most likely thing to need a second pass."* Five notes went out on the
night of 2026-09-12.

## The short version

A voice call's closing note is no longer a prompt. The host has a new command that writes the note into
the agent's conversation as the person's own row and runs no turn for it: no model call, no reply, no
bill. The relay uses it when the box has it and sends the old prompt only when the box's host has never
heard of the command, and the relay log says which of the two happened.

The row it writes is the row the send pipeline already writes for a typed message, which is what makes
this small. The console draws it as the existing "You" bubble with no page change, and the next real
turn carries it into the agent's context through a mechanism that already existed for user messages
that were never answered.

## What was measured before anything was built, and two of the four changed the design

**1. A transcript row is enough, because an unanswered user row is already prepended to the next turn.**
This is the measurement the whole command rests on, and without it "filed without a turn" would have
meant "filed where the model never looks". Two hops, both of them already in the host:

- `send-turn-dispatch.ts` builds `recentUserMessages` for every real send by filtering the agent's own
  transcript for `kind === "message" && role === "user" && fromAgent == null && channel == null`, and
  hands the list to `runTurn`.
- `shell-terminal-watch.ts` `collectPrependUserMessages` runs `selectUnconfirmedUserMessages`
  (`source/host/runner/conversation-state.ts`) over that list against the runner's own
  confirmed-user-turn watermark. Every user row that was never confirmed into a turn becomes a
  `UserMessage` PREPENDED to the next turn's prompt, stamped with its entry id by
  `buildUserMessageAddressNote` as `[t1u]`.

So the note is in the agent's context the next time the person actually says something, which is exactly
what a closing note is for: background for the next real turn, never a turn of its own. The test that
pins this drives the real `selectUnconfirmedUserMessages`, not a copy of it, because the claim is about
somebody else's code.

**2. The store and the entry kind are the send pipeline's own, and this is what kept the page out of
it.** `send-pipeline.ts` writes a typed message as `createUserMessage(nextEntryId(entries,
"user-message"), text, options)` from `send-message-shaping.ts`, which is
`{kind:"message", role:"user", content, isStreaming:false, timestampMs}`. It persists either through
`sessions.appendEntry` (when that conversation is on screen) or `session.db.appendTranscriptEntry`
(when it is not), and tells the console with `roster.emit({type:"appended", entry})`.
`ui/machine-room/gateway-adapter.js:652` keeps `kind === "message" && role === "user"` in its projection
filter and draws it as the "You" bubble, because `mine = e.kind !== "send-message"`. A new entry kind
would have been thrown away one function before the renderer, which is the failure UX-ERR-1 records for
a failed turn. **Store used: the agent's own transcript store, the same rows `getAgentTranscriptTail`
reads. Entry kind used: `message` with `role:"user"`, minted by `createUserMessage` and `nextEntryId`.**

**3. `createUserMessage`'s `composedAtMs` option is the wrong way to set the timestamp, and it would
have put a false sentence in front of the note.** Besides setting `timestampMs` it stamps
`sentWhileOfflineAtMs`, and `send-turn-dispatch.ts` turns that into a "you composed this while offline"
preamble on the prompt (`buildComposedOfflineNote`). A call that ended a second ago was not composed
offline. So `at` is applied over the built row and the offline marker never appears. A test pins that,
including for a missing or nonsense stamp.

**4. The on-screen guard had two candidates in the tree and only one of them is correct.**
`sessions.appendEntry` writes through a module-global in-memory transcript and persists to
`activeSession.db`, so it is only right for the agent whose conversation is BOTH the active session and
the in-memory one. `automation-run-path.ts` checks `activeSession` alone; `send-pipeline.ts`'s own
`isOnScreen` checks both. This copied the send pipeline's. Getting it wrong writes one person's call
transcript into another person's open transcript, and the test for it asserts exactly that case.

## The host surface that was added

One command, mirroring `getTurnDraft` and `getVoiceBrief`.

```
POST <gateway>/api/appendTranscriptNote
  {"agentId": "<id>", "text": "Voice call, ...", "at": 1757000000000, "clientNonce": "voice:<session>:note"}
->  { "filed": true, "entryId": "t7u", "duplicate": false }
```

Files:

- `source/host/extensions/transcript/transcript-note.ts` (new). Pure: the cap, the nonce dedupe, and
  the entry plan. It touches no filesystem, no network and no clock it does not own, so the shape and
  the refusals are pinned without a box.
- `source/host/extensions/transcript/transcript-manager.ts`. One method, `appendTranscriptNote(agentId,
  {text, at, clientNonce})`, beside `getVoiceBrief`.
- `source/host/host-gateway-api.ts`. The command.
- `source/host/gateway-protocol.ts`. The protocol entry.

Four decisions worth arguing with:

- **A missing agent THROWS, where `getVoiceBrief` answers null.** A read that degrades is a voice that
  goes back to being a phone line, which is fine. A write that silently did nothing would tell a caller
  that a person's words were recorded when they were not. `sessions.resolveBackgroundSession` throws
  `AgentGoneError` for an id this box does not hold, and the gateway hands that back as the error it is.
  A store that refuses to persist throws `SandSendNotPersistedError` for the same reason, and nothing
  tells the console about a row that was not written.
- **A note over the ceiling is refused and both numbers are named, never stored short.** Half a note
  read back as the record of a call is worse than none, because nobody can tell which half is missing.
  The ceiling is 16 KB; the relay caps its own note at 6 KB and drops the oldest spoken lines to get
  there, so in the intended use this never bites. It is here because a gateway write with no ceiling is
  how one wedged caller fills somebody's transcript.
- **The nonce dedupe reads only the person's own rows.** Every send carries a `clientNonce`, the
  agent's deliveries included, so a scan that matched any row would find the nonce of whatever the note
  rode in beside and refuse to write the note. The scan goes through `isUserMessageEntry`.
- **A duplicate is a success.** The command answers `{filed:false, entryId:<the existing row>,
  duplicate:true}` and the relay reports that as filed, because the row the caller wanted is there.
  Reporting it as a failure invites the retry that wrote it twice.

## The relay side

`ui/voice-edge.mjs`, and only the closing-note path. `ui/machine-room/*` was not touched.

**`fileCallNote(call, {agentId, note, clientNonce, at, timeoutMs, now, log})`** is the whole change, with
`writeCallNote` reduced to building the note and logging the outcome. The note's TEXT is unchanged,
byte for byte, including the two sentences asking not to be answered: they are dead weight on the new
path and the only defence on the old one, and rewriting them to suit the new path would have weakened
the fallback to tidy up the success case.

**The fallback is `isUnknownGatewayMethod` and nothing else**, and the two conditions it deliberately
does not cover are the interesting part:

- a TIMEOUT may still have landed on the box, which this path already logged before this wave ("it may
  still land"), so falling back would put one call transcript into a conversation twice, once as a row
  and once as a prompt with a reply under it;
- a REFUSAL is the box answering no to this write, and asking it a second way is a relay talking a box
  into something it declined.

**Both attempts come out of ONE budget.** What waits behind this call is the session being released,
which is what lets the next press in. A person who hangs up and presses again must not be told the
workspace is busy because a box was slow twice. The budget is still `VOICE_NOTE_WRITE_MS`, 5 s, and the
timer behind it is not `unref`'d for the reason `readVoiceBrief`'s is not: an unref'd timer cannot fire
when nothing else holds the event loop, so the await would never settle.

**The log line keeps its shape and gains the word.** `filed ... and ran no turn for it` when the row
went in on its own, `sent ... as a prompt, because this host cannot file one` on the fallback, and a
third line when the box already had the note under that nonce. An operator reading a relay log can tell
a call that can still produce an unasked-for reply from one that cannot, without going to look at the
box's version.

## Tests

All on this Mac, MacBook-Pro.local, darwin arm64, node v22.23.1, 2026-09-13.

| suite | result |
|---|---|
| `tests/voice-turn.test.mjs` | 83 of 83 (70 at the base commit) |
| `tests/voice-note.test.mjs` (new) | 17 of 17 |
| `tests/voice-brief.test.mjs` | 21 of 21 |
| `tests/voice-turn-draft.test.mjs` | 13 of 13 |
| `tests/voice-wire.test.mjs` | 12 of 12 |
| `tests/voice-transcription.test.mjs` | 15 of 15 |
| `tests/voice-caps-ledger.test.mjs` | 35 of 35 |
| `tests/voice-socket` / `voice-frames` / `voice-capture` | 11, 14, 11 |
| `tests/cp-voice.test.mjs` | 27 of 27 |
| `tests/machine-room-voice.test.mjs` | 93 of 93, untouched by this wave |
| the seven other suites bundling `transcript-manager`, `host-gateway-api` or `gateway-protocol` | 16, 3, 10, 3, 35, 17, 32 |
| `npm run source:typecheck` | clean |
| `node scripts/build-host.mjs --out /tmp/voice16c-hostbuild` | `validated-clean-source clean=true` |
| `node --check ui/voice-edge.mjs` | clean |

`tests/voice-turn.test.mjs` grew from 70 to 83. The thirteen new cases:

- The note is filed as a row, and a host that can file one is never also sent a prompt. This is the
  assertion the whole wave exists for.
- A host with no `appendTranscriptNote` gets the note as VOICE-16's prompt, in the `prompt` field, under
  the same nonce, and the log says the reply is back on that box.
- A refusal is not asked a second way; a timeout is not written a second way; the two attempts share one
  budget.
- A note already filed under this nonce is a success and nothing retries it.
- Nothing to file makes no gateway call at all, on an empty note or an unresolved agent.
- The write budget is still the 5 s VOICE-16 measured.
- Two end to end through the real stub and a real websocket client: the call leaves ONE note through
  `appendTranscriptNote` carrying both sides, stamped `voice:<session>:note`, with ZERO `sendPrompt` on
  the whole line; and a box whose host answers 404 tries the command once and then sends the prompt
  once, with the please-do-not-answer sentence still in it.
- The two pre-existing end-to-end note tests were rewritten to read the new command rather than
  `sendPrompt`, which is the same assertion against the new wire.

`tests/voice-note.test.mjs` bundles three things. `transcript-note.ts`, pure, where the entry shape, the
two absences that make the row eligible for the next turn, the timestamp, the id sequence, the cap
refusal and the nonce dedupe are pinned with no box. `transcript-manager.ts` against a fake session
store, which is the only way to prove what the wiring decides: which store the row lands in, that the
entry is addressed to its owning agent when the conversation is off screen, that the on-screen guard is
the two-part one, that a gone agent and a store that will not persist both throw, and that nothing on
this path reaches the send pipeline or a runner. And `conversation-state.ts`, because the claim that the
note reaches the agent's next turn belongs to somebody else's code.

## What is NOT proven

1. **No box, no relay and no real call.** A worker has no box. That the row appears in a live console
   and that Titan's next real turn carries it are proven against a fake session store and the real
   `selectUnconfirmedUserMessages`, not against a running host.

2. **The host half must be on the box before the relay half ships.** A relay with this change against a
   host without it falls back to `sendPrompt` on every call, which is exactly today's behaviour, so
   nothing breaks; but nothing improves either, and the log will say `sent` every time. Host first,
   relay last.

3. **Whether the agent mentions the note unprompted on its next turn is not proven.** It is in the
   prompt as an unconfirmed user message, which means the model sees it; what a model does with a row
   that says "the call is over and nobody is waiting on an answer" is the model's call. What IS now
   certain is that no turn runs for the note itself, which is the bug that was reported.

4. **The `[t1u]` address note in front of the prepended text was read, not tested here.**
   `buildUserMessageAddressNote` stamps the entry id ahead of the note's own first line when the runner
   prepends it. Nothing in this wave changes it and nothing here asserts how it reads out loud.

5. **The duplicate guard was not exercised against a real concurrent write.** It is a scan of the rows
   this command can see, which is the agent's own transcript, and it closes the retry-after-timeout case
   by construction rather than by measurement.

6. **No gate leg was added to `scripts/verify-voice.mjs`.** Another worker holds that file this wave, as
   it did for VOICE-3 and VOICE-16. The operator's measurement is one real call.

## Files changed

```
source/host/extensions/transcript/transcript-note.ts     (new)
source/host/extensions/transcript/transcript-manager.ts
source/host/host-gateway-api.ts
source/host/gateway-protocol.ts
ui/voice-edge.mjs
tests/voice-note.test.mjs                                (new)
tests/voice-turn.test.mjs
tests/index.js                                           (one entry)
docs/VOICE.md                                            (section 9)
docs/GAP-ANALYSIS.md                                     (one new row, one clause on the VOICE-16 row)
docs/VOICE-16C-REPORT.md                                 (this file)
```

## For the operator

1. Merge, run the voice suites once more.
2. `updateHostNow` on the demo box, then Jason's box. The host half is the new command, the relay half
   is everything else, so restart the relay LAST. A relay ahead of a host falls back to the old prompt
   on every call and the log says `sent`.
3. One call. Say a couple of things, hang up, and read the relay log for the closing line. It should
   read `filed ... one note for this call and ran no turn for it`.
4. Look at the conversation on screen. The note should be there as your own bubble, with NOTHING under
   it. An answer under it after this ships is the thing to report back, and it would mean the note
   travelled as a prompt, which the log line will have already said.
