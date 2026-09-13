# VOICE-19 report: approve on the call screen, by tap or by saying so

Branch `voice-19`, worktree `wt-voice-19`, measured on **MacBook-Pro.local (darwin arm64, node
v22.23.1)** against **grok-bot-local-vm** and the stub vendor. Nothing in this wave touched the R750,
and nothing restarted the shared relay on 127.0.0.1:7777: every gate run stood up its own relay on
its own port.

## What changed

Five files, and two of the five changes are faults this wave found rather than faults it fixed for
itself. The full prose is docs/VOICE.md section 16.

1. **`ui/machine-room/voice.js`.** The copy of a **pending auto-review** card in the middle of the
   call screen keeps its Allow, Refuse and Always allow buttons. Every other card kind is still
   copied read-only. A press on a kept button finds the button it was cloned from in `#transcript`
   and clicks THAT one, so `app.js` keeps the only `adapter.decideApproval` call site in the console
   and nothing here is a second gate. Three supporting changes: a pending approval is exempt from
   VOICE-13's staleness rule, a card this call has already drawn stays drawn once it settles, and the
   copy is rebuilt when the card's state moves rather than only when the row's id does.
2. **`ui/machine-room/voice-call.css`.** The copy's card actions are at least 44 px with no width
   breakpoint, and the copy does not run the transcript's entry animation.
3. **`ui/voice-edge.mjs`.** A between-turns card watcher: a 3 s tick (`CARD_WATCH_MS`), armed on
   `session.updated` and cleared on close, that finds a pending card the box raised with no spoken
   turn behind it, asks about it out loud once, and holds it for a spoken yes or no through the
   existing `resolveHeldCard` path. It stands aside while a `titan` tool turn is in flight, remembers
   every card it has asked about by entry id, and lets a held card go when the person settles it on
   screen. `cardQuestion` is one wording for both paths and it now ASKS ("... Allow it?"), and
   `matchYesNo` learned the words that answer that question.
4. **`tests/machine-room-voice.test.mjs`, `tests/voice-turn.test.mjs`.** Eleven new cases.
5. **`scripts/verify-voice.mjs`.** The call leg gained a section that forces one **real** approval on
   the local box and answers it from the call screen, plus phase labels on page errors.

## The numbers

### Unit, `node --test` on this Mac

| Suite | Result |
| --- | --- |
| `tests/machine-room-voice.test.mjs` | 105 of 105, 0 skipped |
| `tests/voice-turn.test.mjs` | 90 of 90 |
| all twelve voice suites in one run | 376 of 376, 0 skipped |

### `node scripts/verify-voice.mjs --leg call`

WebKit 390x844, device scale 3, touch, iPhone insets restated, against grok-bot-local-vm behind this
leg's own relay and the stub vendor.

| | Before this wave | After |
| --- | --- | --- |
| checks | 64 of 66 | **87 of 89** |
| wall clock | 36 s | 90 to 99 s |

The new section, on the run of record (`call-final.txt`, 99 s):

| What | Measured |
| --- | --- |
| the host raising a real pending approval | 24 to 30 s across five runs, surface `box_shell` |
| the copy's buttons | **84x44 and 89x44**, at 47,233 and 141,233 of 390x844 |
| a thumb at each button's own centre | lands on `button.card-action`, both |
| other controls on the copy | 0 |
| `[data-needs-you-card]` nodes with the copy on screen | 1, the same as before the call |
| the relay asking out loud, nobody having started a turn | 1 question on the wire, in the read-this-out shape, naming the action |
| a tap on the COPY | the transcript row read `approved`, pill "Allowed once" |
| the copy afterwards | `approved`, 0 buttons |
| the call | still up through all of it |
| the box afterwards | block instruction gone, review mode back to what it was, scratch agent gone from the roster |

## Two faults this wave found, and neither was VOICE-19's

- **The copy was animating in.** `.message-row` carries `animation: float-in` (motion.css:
  `translateY(10px) scale(0.985)`, spring easing) and a fresh clone restarts it on every paint. So the
  copy's Allow button computed `min-height: 44px` with `box-sizing: border-box` and still **measured
  43.34 px**, which is 44 x 0.985, and `elementFromPoint` at its own centre returned the screen rather
  than the button. Fixed in `voice-call.css` for the copy only; the row in the transcript is
  untouched. This existed for every card VOICE-13 ever copied and nothing had a reason to measure it.
- **The copy carried the push hook.** `data-needs-you-card` marks every pending card in the open
  conversation and a shell with no bearer counts those nodes off the DOM (docs/APPS.md section 6,
  `scripts/verify-push.mjs`). A clone carried it too, so one approval with a call screen up counted as
  two. The six attributes are stripped from the copy.

## What is NOT proven

- **No real phone and no real vendor.** Everything above is WebKit on this Mac against a stub. Nobody
  has read the card on a handset at a real notch, and no realtime model has spoken the question.
- **The spoken ANSWER is not measured end to end in the browser.** "allow it" closing a real card is
  proved in `tests/voice-turn.test.mjs` against the real bridge with a stub vendor; the gate proves
  the question reaching the vendor and the TAP settling the row, not a voice saying yes to it. A
  microphone that can speak a chosen sentence into WebKit does not exist in this rig (VOICE-13c).
- **`always` is untested live.** The local box proposes no rule for a plain echo, so the third button
  never appeared on the live card. It is covered in unit tests only.
- **One box.** grok-bot-local-vm, one host bundle, one roster of 21.

## Still red in `--leg call`, and both are owned

**1. `and then Listening, Thinking and Talking in that order`.** PRE-EXISTING: it fails identically on
the pristine tree (baseline run before any VOICE-19 edit, 64 of 66). The observed sequence is
`["Connecting","Talking","Thinking","Talking"]`. The cause is VOICE-14c: the line now says hello the
moment the provider confirms the session, so the word after Connecting is Talking, and the gate row
predates the greeting. **This is a stale gate expectation, not a product fault, and re-cutting it is a
deliberate decision about what the product should do rather than a repair.** It was left alone on
purpose: the VOICE-19 brief permits touching `scripts/verify-voice.mjs` only to extend the call leg,
and loosening an existing assertion to green is the one thing a worker must not do quietly.
**Owner: the next voice wave that holds this gate.** Next action: decide whether the greeting should
be preceded by a Listening frame, or whether the row should read
`Connecting, Talking, Listening, Thinking, Talking`, and re-cut it with the reason written beside it.
Proof: the leg green with the greeting in place.

**2. `and the page threw nothing through any of it`.** Two WebKit notices, both
`ResizeObserver loop completed with undelivered notifications.`, one labelled `[VOICE-19 setup]` and
one `[VOICE-19 the call with a card on it]`. The phase labels are new in this wave and are what pinned
them down. Neither is a thrown error: it is the notification WebKit emits when an observer callback
dirties layout in the same frame, and every behavioural row around it is green, including the tap
settling the host's own card. It is intermittent and not exclusive to the call screen: the
`[VOICE-19 setup]` one fires while the page sits idle for 30 s waiting on the box, with no call screen
mounted at all. **One fix was attempted and reverted**: suppressing the face-width transition on the
frame a screen opens did not remove the notice and turned two other rows red, so it is not in this
branch. **Owner: whoever next holds `ui/machine-room/voice-call-avatar.js` or the vendored mascot
kit.** Next action: instrument which observer's callback is dirtying layout (the kit sizes its canvas
from its host's rect inside its own `ResizeObserver`, and the face carries a 260 ms width transition),
then either defer the kit's resize to a frame or drop the transition with the motion cost stated.
Proof: the leg green with a real card on the call screen, twice in a row.

## How to run it

```
SAND_PROFILE_DIRS=<the sand-data directory holding local-docker-vm.json> \
  node scripts/verify-voice.mjs --leg call
```

The section skips itself, with the reason named, on a box that answers no `autoReviewInstructions` or
whose model will not take the turn inside its budget (`VOICE_GATE_APPROVAL_MS`, default 170 s), and
the restore runs either way.
