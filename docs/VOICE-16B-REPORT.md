# VOICE-16b: on the phone he answers short, and the screen still has all of it

Branch `voice16b-spoken`. Jason's words that drove it, 2026-09-12 23:36 CDT, after the first working
call on build 20: "when we're in voice, Titan needs to be less verbose. It can be verbose in the text
that's being printed out, but it needs to be shorter and more conversational. Instead of repeating
everything it did, it can say, 'Yep, I did it. Okay, right?' ... less like a syllabus coming back every
time."

## The short version

Two things were making every spoken result a report. The instructions told the voice to read out what
came back, and VOICE-3's sentence streaming sent it every whole sentence of the written reply as "read
this out, word for word". So the mouth was reading the screen.

Now the instructions carry a spoken contract, written once per call like everything else in them: a
phone answer is one or two short sentences in plain words, no lists and no file paths, and a result
that comes back from the box is given as a gist rather than read out. And the reading is capped at the
FIRST sentence of the draft, which is the whole of VOICE-3's latency win and is untouched; the rest of
the answer goes back on the tool result with one line saying the person has already heard the first
sentence, so say the rest in one short sentence or nothing at all.

The text did not move at one single point. The page's `said` frame still carries the whole reply, the
conversation on screen still holds every word, and the only copy that got shorter is the provider's.

A held card, a spoken yes and a refusal are untouched, deliberately and with a guard of their own.

## What changed, all in `ui/voice-edge.mjs`

**1. The spoken contract, two sections at the end of `voiceInstructions`.** `HOW YOU SOUND` was one
sentence about punctuation and is now the contract: on a phone, one or two short conversational
sentences, no lists, headings, numbered steps, file paths, code or punctuation read aloud. Beside it,
`WHAT YOU SAY WHEN SOMETHING COMES BACK FROM THE titan FUNCTION`: do not repeat it and do not read it
out, give the gist in one breath ("Yep, did that." / "Done. The backup ran clean."), and only if there
is more to it than that, say in a few words that the rest is on the screen.

It is written ONCE, at `session.update`, because that is where the cached prefix lives and rewriting
instructions mid-call re-bills the whole conversation. A test counts the headings to prove it is once
and not once per section.

**2. The reading stops after the lead sentence.** `makeSentenceCutter` took a `limit`, the turn runner
builds it with `SPOKEN_LEAD_SENTENCES` (one), and once the cutter is `done` the runner stops reading
`getTurnDraft` for that turn. The remainder then goes back through the tool output as
`{reply, sentences, alreadyRead: true, spoken: SPOKEN_REMAINDER_HINT}`, with one `response.create`
behind it so the model actually says the gist.

**3. Nothing else on the result path moved.** A one-sentence answer still takes the VOICE-3 branch that
closes the call with `alreadyRead: true` and no `response.create`. A turn that streamed nothing still
takes the VOICE-1 branch byte for byte, which is every desktop call and every box with no draft
command. The greeting (VOICE-14c), the barge-in (VOICE-14), the nudges and the announcement queue are
all as they were.

### Three decisions worth arguing with

**The limit lives in the cutter, not in the loop.** `remainderOf` subtracts `spoken` from the finished
reply to work out what nobody has heard, so `spoken` has to mean "handed out", exactly. A loop that cut
three sentences and spoke only the first would record two sentences as said and the tool output would
then skip them, so nobody would ever hear them, on screen or off. Refusing to cut them is the only
shape where the record and the room agree. It has a side effect worth having: the box stops being asked
for the draft once the lead sentence is out, so a streamed turn now costs one `getTurnDraft` read
instead of one per 400 ms tick.

**A held card gets no brevity hint, and that is a guard rather than an oversight.** A card's question is
what the person answers yes or no to, and the relay closes that answer through the approval path. "Do
you want me to send it" gisted down to "there is something waiting on you" is how somebody says yes to
the wrong thing, so a turn holding a card gets the payload it got before this wave: the question in
`sentences`, and no `spoken` key at all. There is an end-to-end test for exactly that.

**Five words of the tool description changed, which is one clause more than the brief asked for.** It
finished "then read out what comes back", which is the precise behaviour the new contract forbids. A
tool description and a system prompt that contradict each other is a prompt arguing with itself, and
the model resolves that however it likes. It now says to say the gist of what comes back in one short
sentence. Nothing else in the description moved, and the three VOICE-16 assertions on it still hold. I
am naming it here rather than leaving it to be found in a diff.

**The phone line was deliberately NOT given the contract.** `phoneLineInstructions` is pinned literally
by a test as the string it has always been, for a box whose host has no `getVoiceBrief`. Back-porting
the contract into it would break that claim for a box nobody is tuning the voice of.

## What was measured

All on this Mac, MacBook-Pro.local, darwin arm64, node v22.23.1, 2026-09-12.

| suite | result |
|---|---|
| `tests/voice-turn.test.mjs` | 74 of 74 (70 at the base commit) |
| `tests/voice-brief.test.mjs` | 21 of 21 |
| `tests/voice-transcription.test.mjs` | 15 of 15 |
| `tests/voice-wire.test.mjs` | 12 of 12 |
| `tests/voice-caps-ledger.test.mjs` | 35 of 35 |
| the five together, one run | 157 of 157 |
| `tests/cp-voice.test.mjs`, `voice-socket`, `voice-frames`, `voice-capture`, `voice-turn-draft` | 27, 11, 14, 11, 13, all passing |
| `node --check ui/voice-edge.mjs` | clean |

`tests/voice-turn.test.mjs` went from 70 to 74. Two existing VOICE-3 cases changed, each with the
reason in its own assertion message, and four are new.

Changed:

- The unit case that was "a growing draft is spoken sentence by sentence" is now "the FIRST sentence is
  read out as it lands and the rest of the answer is not". Same fixture, a draft growing over three
  reads: `spoken` is one sentence where it was three, `remaining` is sentences two and three where it
  was empty, and `getTurnDraft` is read once where it was read every tick. `td` is still stamped and
  still lands before `t3`, which is the latency claim and it did not move.
- The end-to-end case is now "the lead sentence is read out, and the rest comes back for the model to
  say short". Through the real stub and a real websocket client: ONE text item on the wire where there
  were three, `billableItems` 1 where it was 3, and the tool output is the remaining two sentences plus
  `alreadyRead` plus the hint, where it was empty with `alreadyRead` alone. `response.create` is 2,
  one behind the sentence and one behind the output, where it was 3 with none behind the output. The
  `said` frame still carries the whole reply, asserted in the same test.

New:

- A cutter with a limit hands out that many sentences and then nothing ever, including when the draft
  arrives whole in one tick, and `spoken` is exactly what went out. The default cutter is unchanged.
- The instructions carry the contract ONCE (the two headings counted), say the four things they have to
  say, no longer contain "read out what comes back" in either the instructions or the tool description,
  and still carry the "checking the mail now" wait line once. The phone line is still byte for byte
  what it was and does not contain the contract.
- End to end: a one-sentence answer is said once, the tool output says there is nothing more
  (`alreadyRead: true`, no hint), and there is exactly one `response.create` for the whole turn.
- End to end: a turn holding a card carries no hint, still says `alreadyRead`, and the card's own
  question is what is left in `sentences`.

Prompt sizes, measured on this Mac with the same small real brief the VOICE-16 report used:

| | VOICE-16 | now |
|---|---|---|
| instructions with a small real brief | 2,496 chars | 3,119 chars |
| the fixed scaffolding with an empty brief | 1,991 chars | 2,614 chars |
| the phone line fallback | 890 chars | 890 chars |

So the contract costs 623 characters of prompt, once per call, cached after the first turn. What it
buys back on xAI is two fewer billed text items on a three-sentence answer, because each sentence that
is no longer read out was one flat item fee.

## What is NOT proven

1. **No real call, on any box.** Nothing here names the R750 and nothing here names a real realtime
   model. A worker does not dial a phone.
2. **Whether a real model actually obeys the contract is not proven and cannot be, against a stub.**
   The contract and the hint are prompt text; the stub says whatever a test tells it to. What is pinned
   is the relay's half: the contract is in the session exactly once, one sentence and not four is read
   out word for word, and the remainder and the hint are what the tool result carries. Whether the
   answer out loud is two sentences instead of five is a live call with a person listening, and it is
   the one thing to report back from it.
3. **The "it can be verbose on screen" half is unchanged rather than improved.** The page and the
   conversation carry the whole reply exactly as they did. Nothing here makes the written answer
   better, and nothing here makes it worse.
4. **The billing numbers are item counts, not an invoice.** One billed item instead of three on a
   three-sentence answer is counted on the session's Spend line and asserted in the test. Nobody has
   read it off an xAI bill.
5. **A long answer now says less out loud than it used to, and that is the intended trade.** The person
   hears the lead sentence and a one-sentence gist; the detail is on screen. If a real call shows that
   the gist is too thin for a result with several parts, the knob is `SPOKEN_LEAD_SENTENCES` and the
   wording of the hint, both in one file.
6. **No gate leg was added to `scripts/verify-voice.mjs`.** Another worker holds that file this wave,
   as in VOICE-3 and VOICE-16. The operator's measurement is one real call.
7. **No tracker row was added to `docs/GAP-ANALYSIS.md`.** That file is outside this wave's three files
   and is already modified by other workers in this tree, so a blind edit would collide with them. It
   needs one VOICE-16b row, and that is for whoever merges this wave: a wave that lands with no row in
   the tracker is the stale-tracker failure, and this is the one thing in this report that is flagged
   rather than done.

## Files changed

```
ui/voice-edge.mjs
tests/voice-turn.test.mjs
docs/VOICE.md
docs/VOICE-16B-REPORT.md   (this file)
```

`docs/VOICE.md` changes: section 1 gained the plain-words bullet about answering short out loud and
writing it all down; section 5's `TD` row, the draft paragraph and the billing paragraph now say one
sentence rather than every sentence; section 5 gained the subsection "He is short on the phone, and the
screen still has all of it (VOICE-16b)", with Jason's words, the two mechanisms, the held-card
exception and what is not proven; section 7's VOICE-3 cost bullet now prices one item instead of one
per sentence.

## For the operator

1. Merge, run the five voice suites once more.
2. The relay is the only half that changed, so no `updateHostNow` is needed for this. Restart the
   relay.
3. One call on the demo box. Ask for something that takes him a few sentences to write, like the last
   gate run. What to listen for: one short sentence as he starts writing, then one short sentence with
   the gist, and no list read out. Then look at the conversation on screen and check the whole reply is
   there, every word.
4. One call with a held action in it, such as sending mail. The question must still be asked in full,
   and a spoken yes must still close it.
5. If it is still too long, the two knobs are `SPOKEN_LEAD_SENTENCES` and the wording of
   `SPOKEN_REMAINDER_HINT`, and both are in `ui/voice-edge.mjs`.
