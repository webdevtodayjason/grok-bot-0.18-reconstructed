# VOICE-20 report: the hand-off does not clip him, and the newest question is the one on the screen

Branch `voice-20`, worktree `wt-voice-20`, measured on **MacBook-Pro.local (darwin arm64, node
v22.23.1)** against **grok-bot-local-vm** and the stub vendor, and on the **R750
(jason-PowerEdge-R750)** through **console.titanium.bot** as a throwaway customer on the demo tenant.
Nothing on the R750 was restarted or recreated: the gate signs in at the front door, presses what a
customer presses, and puts the workspace's talking switch back. The shared relay on 127.0.0.1:7777 was
never touched; every local run stood up its own relay on its own port.

## Part 1: the clip at the hand-off

### The numbers that named the cause

The wave measured both candidate causes before changing anything, and **both are ruled out**.

| What was measured | Where | Result |
| --- | --- | --- |
| `conversation_already_has_active_response` on a live line | the R750 relay's whole retained log | **0 occurrences**. There are 7 quiet provider notes in it and every one is the barge-in cancel race, `Cancellation failed: no active response found` |
| a `response.create` sent over a response still generating | the new ledger, this Mac, at the hand-off | the log reads **nothing generating** |
| the page throwing queued audio away | the R750, one real hand-off through the real vendor | **0 flushes, 0 scheduled buffers stopped**, 13 buffers scheduled, 4,050 ms of speech delivered and every byte scheduled in order |
| **Titan's own sentence still to come out of the speaker when the answer asked** | this Mac, real bridge, stub vendor, a 2,000 ms sentence booked | **1,578 ms of 2,000** |
| the same, on the live R750 turn | the box took 26,423 ms to answer | **0 ms**, because the room had long gone quiet |

So the fault is neither of the two things the brief named. It is the **overlap**: `answerTool` and
`sayDraftSentence` asked the vendor to speak into a room where Titan's own waiting sentence was still
being heard. `playsUntilMs` is booked FROM THE BYTES precisely because a model hands a reply over far
faster than a speaker plays it, and the microphone side of `ui/voice-edge.mjs` has read that number
since A4. The speaking side never did.

The live R750 turn did not overlap because the demo box took **26.4 s**. The window is the fast path:
a box with the answer to hand, and VOICE-3's lead sentence, which is ready a second or two after the
tool call and whose only gate was `responseInFlight`.

### What changed

`ui/voice-edge.mjs`. One helper, `waitForQuiet`, used by two doors.

- **`answerTool`** sends the `function_call_output` **at once** and only then waits for the response in
  flight to finish and for `gate.playsUntilMs` to drain before asking for the answer to be spoken. The
  output cannot wait: the model is blocked on it and a call left open wedges the conversation.
- **`sayDraftSentence`** gained the same second half.
- **A ceiling, `ANSWER_QUIET_CEILING_MS` (6 s)**, because `playsUntilMs` is booked audio and not played
  audio. A page in the background, a stalled shell player or a lost flush would leave a booking in the
  future for ever. The answer goes out late rather than never, and the log says which happened.
- **A per-response ledger, and it stays in.** One row per response the vendor opens: when it started,
  how many audio bytes it delivered, how many milliseconds of speech that is, and when it finished.
  Every `response.create` this relay sends now names its caller and prints what the room sounded like
  at that instant. The quiet provider codes now carry the response they are about, which is the line
  that made the first table above possible.

No new wire frame. The instructions are untouched.

### The link to what Jason heard, and it is correlation rather than proof

A phone line runs with barge-in (`bargeIn: true` on the app's opening frame), which means its
microphone frames are **never** held by the echo gate. Two overlapping utterances in the room are
therefore two utterances the vendor's own VAD can hear, and every barge-in sends `response.cancel` and
a `flush` that throws away everything still booked, which is a clip by construction. The live relay
log records **3 barge-ins on a 3-turn call and 2 on a 2-turn call, both on route speaker**, against
**1 turn and 0 barge-ins** on the one earpiece call in the same log. That is a correlation this wave
did not prove and does not claim; the fix removes the overlap, which is the only half of it that
belongs to this relay.

## Part 2: the second card

### It did not reproduce

`--leg call` now forces a **second** real approval while the call is still up, with no reload and no
second call, and on the local box **it already worked**: the host raised it in 24 to 30 s across three
runs, the console drew it in the transcript under the first, and it took the middle of the call screen
with its own Allow and Refuse at **84x44 and 89x44**, each naming the second row. So the sequence Jason described is not, on
its own, enough to produce what he saw.

### What was actually wrong, and it is a rule rather than a bug

The middle of the call screen was "the newest row in the conversation with a card in it". That is the
right rule for a weather card and the wrong one for a question. VOICE-19 keeps a card this call has
drawn once it settles, so a settled card, a tool receipt with an attachment, a widget or a report offer
landing after a question all take the middle away from the one card the person has to answer. On a call
there is nowhere else to answer it: the chat behind the screen is `inert`.

`callCardRow` in `ui/machine-room/voice.js` now returns the **newest pending approval** when there is
one, and the newest card otherwise. A question jumps the queue; with nothing waiting the rule is
exactly what VOICE-13 wrote.

## VOICE-20a: a card waiting when the tool turn ends

Live data from the team lead, off the R750 relay log: Jason's call of 2026-09-13 15:21 CDT, 133 s, 2
turns to the agent, 2 barge-ins, and **no "asking about a card" line anywhere in it**. The approval was
raised by Titan's own `report_problem` INSIDE a `titan` tool turn. *"while the agent was filing a
report, the approval box popped up ... no approve or reject buttons."*

**Why the turn did not hold it.** `makeTurnRunner.run` returns the instant a reply entry lands, and its
`card` is `pickOneCard(pendingCardsOf(fresh))` against the tail it had read at THAT moment. A card the
same turn raises a beat after the reply is not in that read. The between-turns watcher would be the
other reader, and it returns early while `turnsInFlight > 0`, which is the whole of `dispatch`. So the
card belonged to neither.

**The fix.** The end of a tool turn calls `watchCards({ force: true })`: the same function, with the one
guard that would refuse it lifted. One wording, one `cardsAsked` memory, one held card, and a turn that
already came back holding a card short-circuits it. `say` also waits for booked playback now, because
the question follows the turn's own answer directly.

**The honest caveat, and it matters.** With the tick left on its production three seconds, a
reproduction of that ordering IS asked about, one tick late. So the hole alone does not explain a call
with **no** asked line at all, and there is a second candidate that does: `pendingCardsOf` knows three
kinds only (auto-review, local-tool, widget), and the problem-report offer is neither. It is not even a
transcript entry: the console builds it from `adapter.listProblemReports()`, the box's own pending file
(`drainPendingProblemReports` in app.js). Nothing on the voice path can see one. If that is the card
Jason saw, this change does not reach it, and extending the voice to report and secret cards is its own
decision (a secret card cannot be answered by voice at all). Which of the two it was cannot be settled
from outside his own conversation, and this wave did not read it.

**The test is decisive rather than merely green.** `tests/voice-turn.test.mjs` disarms the tick at ten
minutes for that case, so the end of the turn is the only thing left that can ask. With the fix removed,
nothing asks at all and the case fails on the wait; with the production tick left armed it would pass
against a relay that still had the hole, which is the shape of a test that proves nothing.

## The counts

| Suite or gate | Result |
| --- | --- |
| all twelve voice suites, `node --test` on this Mac | **383 of 383, 0 skipped** (376 before this wave) |
| `tests/voice-turn.test.mjs` | 94 of 94 |
| `tests/machine-room-voice.test.mjs` | 108 of 108 |
| `node scripts/verify-voice.mjs --leg call` | **97 of 98**, up from 90 checks before this wave, and the one red row is the pre-existing VOICE-19a browser notice |
| `node scripts/verify-voice-r750.mjs` | **65 pass, 2 fail**, and both failures are pre-existing and named below |

## The gate's own microphone was the first thing this wave had to fix

Chromium starts the fake capture file the moment the page opens the microphone, and since VOICE-14c the
line says hello the instant the provider confirms the session, so the echo gate holds the microphone
shut for the whole greeting. Played once (`%noloop`), the sentence was gone by the time the gate opened.
MEASURED on the first live run: microphone level **0.0005**, the words reached Listening and Talking,
and nothing was confirmed in 150 s, at a cost of 2.5 of the day's 120 minutes. The file now carries
**six seconds of silence in front of the sentence**, which is a person waiting for the greeting to
finish, and the turn landed: heard *"check what is in the inbox and tell me in one short sentence."*,
answered out loud off the box's own inbox, hops **t1 1,126 ms / t2 +56 ms / t3 26,423 ms**.

The spoken sentence is now a question that forces a hand-off, because a question Titan answers out of
his own head never reaches the box and never reaches the moment this wave is about.

## What is NOT proven

- **The fix is not measured on the live vendor.** The R750 gate reads the **deployed** relay as a
  customer, and this branch is not deployed. The before is measured there; the after is measured on
  this Mac against the stub. Nothing on the R750 was restarted to change that, on purpose.
- **The clip itself was never reproduced.** No run of any gate in this tree produced audio that stopped
  part way through a sentence. What is measured is the overlap that precedes it and the barge-in
  machinery that would turn an overlap into a clip on a phone. A recording of a real call on a real
  handset is the only thing that would close it.
- **No phone.** Every number here is Chromium or WebKit on this Mac. The shell's own player, which is
  what schedules audio on an iPhone, is outside this repo; the contract in `docs/APPS.md` section 8 says
  `audioPlay` queues in order, and this wave took that on trust.
- **The second card fault is not reproduced.** The fix is a rule that holds for shapes the live gate
  cannot build (a newer non-approval card burying a question), proved in unit tests. Whether that is
  what buried Jason's second card is not known.
- **One box and one tenant.** grok-bot-local-vm for the local legs, the demo tenant for the live one.

## Two conditions this wave found and did not cause

1. **`verify-voice-r750.mjs`, at 740x900: a press at the middle of the talk button lands on the
   composer's textarea.** MEASURED twice, both runs: `elementFromPoint` at the button's own centre
   answers `TEXTAREA`, and the hold that follows holds nothing (`held false, on false, orb off`). The
   two rects the same run reads disagree about where the button is (x 836 early, x 525.65 after the
   reload), so the composer reflows under it. It is at 740x900 only; 1440x900 and 390x844 both pass.
   Not a VOICE-20 behaviour and not in any file this wave may touch. **Owner: whoever next holds the
   console's composer layout.** Next action: read both rects in the same frame after the reload and
   find which element the reflow puts over the button.
2. **`--leg call`, section F: an intermittent ended note after Escape.** The row *"and gets no note
   either, because a person pressed a key to leave"* was RED on 2 of 7 runs of this leg, with the note
   standing and reading "The call ended. Nothing was heard.", which is the note a call that ended NOT
   by a person raises. It cannot be this wave's: section F runs before any approval is armed, so
   neither `callCardRow` nor `answerTool` is reached on that path. The likeliest cause is the one VOICE-19 already wrote down: the relay
   releases a session only after this call's note is written, and the next press inside that window is
   refused. It is the section before this one ending a call and this one dialling immediately.
   **Owner: whoever next holds `scripts/verify-voice.mjs`.** Next action: wait on the relay having
   released the previous line before section F presses, the way section H's own leaving step does.

## One gate flake this wave DID fix, because it was measuring a frame nobody presses in

The row *"a thumb at each button's own centre really lands on it"* went red on one run with the copy's
buttons at **y=249** and `elementFromPoint` answering `div.voice-call`, against **y=233** and a clean
hit on the runs either side. The card takes the middle, the avatar shrinks to make room for it, and the
spoken question moves him again; a hit-test fired inside that is reading a frame that is still moving.
The leg now waits for two consecutive equal reads of the button's own top, 200 ms apart, before it
measures and hit-tests. **It narrows nothing**: every run still asserts that a thumb at each button's
own centre lands on the button, at 44 px, on screen. Green on both runs since.

## One hand operation, and it was mine to undo

A run of `--leg call` was killed part way through by this session, so its `finally` never ran and the
local box was left armed: `SAND_AUTO_REVIEW_MODE` at `enforce`, the gate's block instruction stored,
and one scratch agent on the roster. All three were put back through the product's own shapes rather
than around them. `autoReviewInstructions` was DELETED from `settings.json`, which is exactly what
`setAutoReviewInstructions` does with that value itself: `sand-settings-store.ts` drops the key when the
instructions are enabled with both lists empty, and `getAutoReviewInstructions` then answers
`DEFAULT_SAND_AUTO_REVIEW_INSTRUCTIONS`, which is `{ isEnabled: true, allowInstructions: [],
blockInstructions: [] }` and is the baseline every clean run of this leg restored. `SAND_AUTO_REVIEW_MODE`
was removed from the host settings file the way the leg's own `writeBoxSetting` removes it, and the
scratch agent was removed with the gateway's own `deleteAgents`. The roster is back to **21**, which is
the number every clean run of this leg reports.
