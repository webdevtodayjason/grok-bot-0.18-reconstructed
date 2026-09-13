# VOICE-15b part 2, the relay half: a provider transcript is not evidence that anybody spoke

Branch `night-voiceheard`. Files: `ui/voice-edge.mjs`, `tests/voice-transcription.test.mjs`,
`tests/voice-turn.test.mjs`, one paragraph in `docs/VOICE.md` section 3. Nothing in
`ui/machine-room/`, nothing in the app repo, nothing on the R750, nothing restarted on
127.0.0.1:7777, no GUI browser.

Jason, on TestFlight build 17, 2026-09-12: **"when it was done, it said that the call ended and only
one word was said: them. Nobody said that."** That call delivered 0 s of audio in. The provider
transcribed its own greeting, or silence, as one word, and this relay passed it on as his: a `heard`
frame, a `heard-confirmed` frame into the live speech panel, and a `sendPrompt` that put "them." into
the agent's conversation as a user turn. `docs/VOICE-15B-REPORT-page.md` stops the page painting it on
the ended card and files the rest here: "The relay is where `them.` came from, and it is not fixed."

This is that half. Nothing on this line could say whether a person had spoken, because a provider
transcript was taken as proof on its own. It is not proof. The audio the page puts on the socket is
the only thing here that is, and the relay was already counting it, frame by frame, for the Spend
line.

## The event path, measured on both vendors before anything was changed

There are two surfaces that carry words into this relay and they are not the same model. The
transcription model's words arrive as `conversation.item.input_audio_transcription.*`. The realtime
model's own string arrives as the `titan` tool call's `message` argument, and that second one is what
reaches the box. `canonicalEvent` holds aliases for the `response.*` GA renames only, so all three
transcription events are read under their literal names on both vendors:

| vendor | growing transcript | settled | gave up | what the relay does with it |
|---|---|---|---|---|
| xai (`grok-voice-think-fast-2.0`, `grok-transcribe`) | `conversation.item.input_audio_transcription.updated`, cumulative with corrections | `...completed` | `...failed` | `caption.apply` then `heard` + `hear` |
| openai (`gpt-realtime-2.1`, `gpt-4o-mini-transcribe`) | `conversation.item.input_audio_transcription.delta`, incremental | `...completed` | `...failed` | same branch, `makeCaption` normalises both to replace-whole |
| both | the realtime model's own argument on `response.function_call_arguments.done`, `response.output_item.done`, `response.done` | | | `dispatch`: `heard`, `sendPrompt`, `heard-confirmed`, `hear-end sent` |

Measured through the real relay and the real stub provider on MacBook-Pro.local (macOS 26.6.2, node
v22.23.1), one utterance per row, `speech_started` then one transcript update then `.completed` then
one `titan` call:

| vendor | microphone | `heard` | `hear` | `heard-confirmed` | `sendPrompt` | dropped |
|---|---|---|---|---|---|---|
| xai | nothing sent | 0 | 0 | 0 | 0 | 3 |
| xai | 4 frames of 3000 | 3 | 2 | 1 | 1 | 0 |
| openai | nothing sent | 0 | 0 | 0 | 0 | 3 |
| openai | 4 frames of 3000 | 3 | 2 | 1 | 1 | 0 |

The two silent rows are build 17. The same probe run against this file as it stood at HEAD, before
anything in this wave, reads 3 `heard`, 2 `hear`, 1 `heard-confirmed` and 1 `sendPrompt` on BOTH vendors
with no microphone at all, and the prompt that reached the fake box is the provider's own string. That
is the defect in one line: the relay could not tell the two cases apart, and the silent one cost a row
in somebody's conversation.

## What changed

**A transcript is the person's words only when the line has carried sound since this utterance
began.** Two numbers, both already in the meter, now kept for the utterance as well as the call:
bytes admitted, and the loudest sample in them. Both are required. Zeros are bytes too, which is the
shape of VOICE-14b's five calls from the phone on 2026-09-12: 18 to 35 s of audio each that the
provider heard no speech in at all.

**The window opens when the previous utterance closed, not at `speech_started`.** Server VAD fires a
few hundred milliseconds into a sentence and the frames that triggered it have already been admitted,
so a window opened on that event would throw away exactly the audio the transcript is made of. A close
is also the right boundary in always-listening, where utterance one's `hear-end` goes out while the
person is already talking on utterance two.

**The floor is 64 of 32767, which is -54.2 dBFS, and the grace tail is three seconds.** 64 is three
orders of magnitude below what a microphone really sends (the phone's own trimmed capture peaked at
0.0 dBFS on build 20) and far above resampling noise, so it separates silence from speech without
deciding how loudly anybody has to talk, which is the provider's turn detection's job. The tail exists
because push to talk shuts the microphone on the release and the settled transcript of what was just
said lands afterwards, on a line that is now quiet: OpenAI's own transcription guide says those
`.completed` events are late and unordered between items. Without the tail the corrected final of a
real sentence would be thrown away and the closing note would keep the half-built one instead.

**A dropped event produces nothing and says so.** No `hear`, no `heard`, no `heard-confirmed`, no
`sendPrompt`, and nothing in the caption accumulator either, so a sentence nobody said cannot sit there
waiting for the next frame of real audio to carry it onto the screen. The log line is
`voice provider text with nothing heard, dropped: ...`, once per utterance rather than once per event,
carrying the bytes, the peak, the floor, the audio seconds on the line, the held frames and, on a
native call, the phone's own block and sent counts. The settled close line gains
`N provider text(s) dropped with nothing heard`, because a call where the provider wrote words nobody
said looks identical to a quiet call everywhere else on that row.

**The tool call is still answered.** A `titan` call left open wedges the conversation, so the dropped
one is answered with "I am not hearing your microphone. Check it and say that again." and the turn is
closed as `empty`. The person hears the one fact this relay actually knows instead of a line that has
gone quiet.

**The greeting and the spoken sentences are untouched.** VOICE-14c's hello and VOICE-3's sentence reads
are the model's own output on the `say` path, never a heard event, and nothing about a microphone gates
either of them. A case drives a greeting on a line with no microphone at all and then has the provider
read that greeting back as the person: the hello goes out, the echo comes back, and the echo is
dropped.

**It is not a latch.** A microphone that comes back mid-call, which is the ordinary case on a phone
whose audio session was taken for a moment, makes the next turn land: a case proves the drop and then
the send on the same line.

## What was measured

```
node --test tests/voice-transcription.test.mjs tests/voice-turn.test.mjs tests/voice-wire.test.mjs \
  tests/voice-brief.test.mjs tests/voice-note.test.mjs
```

```
# tests 154
# suites 0
# pass 154
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 17042.763625
```

On MacBook-Pro.local (macOS 26.6.2, node v22.23.1). `node --check` is clean on `ui/voice-edge.mjs`,
`tests/voice-transcription.test.mjs` and `tests/voice-turn.test.mjs`. `tests/voice-caps-ledger.test.mjs`,
`tests/voice-socket.test.mjs`, `tests/voice-frames.test.mjs` and `tests/voice-turn-draft.test.mjs` were
run as well and are green; `tests/voice-capture.test.mjs` has one failure that is not this wave's, named
under NEEDS AN OWNER below.

The six new cases:

1. **a transcript on a line that carried no audio is dropped, and the log says so.** Build 17 in one
   case: no microphone at all, two transcript updates, one settled transcript, one `titan` call. Zero
   `hear`, zero `heard`, zero `heard-confirmed`, zero `sendPrompt`; the tool answered with the
   microphone sentence; `hear-end` reason `empty`; four events counted and two log lines, one for the
   utterance and one for the tool call.
2. **digital silence is bytes with no sound in them, and those words are dropped too.** 19,200 bytes
   admitted, peak 0, the log reading `peak -inf dBFS, floor -54.2 dBFS`.
3. **the same words after real audio land exactly as they did before.** Same events, same order, after
   0.4 s of audio at a peak of 3000: one partial, one final, three `heard`, the confirmation carrying
   the bytes `sendPrompt` was called with, `hear-end sent`, nothing dropped.
4. **a transcript that settles after the microphone shut is still the person's.** The send resets the
   window, the late `.completed` arrives on an empty window, and the three second tail is what still
   vouches for it.
5. **the greeting still goes out on a line nobody can be heard on**, and the provider reading that
   greeting back is not the person.
6. **end to end in `tests/voice-turn.test.mjs`:** a `titan` call with no audio sends nothing to the box,
   the microphone coming back makes the next turn land, and the settled close line carries
   `1 provider text(s) dropped with nothing heard`.

Every existing utterance in both suites now carries audio through a new `session.mic()` on the
harness, which sends four 100 ms frames and settles against the provider's own append count before the
words that lean on them are emitted. It waits out the echo window first, because a frame inside it is
dropped by the gate and never reaches the provider at all. No assertion was weakened to make the gate
pass: the two cases that used to prove an empty tool argument and the echo guard now send audio first,
so what they pin is still what they say they pin.

## What is NOT proven

- **No phone, and no realtime key.** Everything here is measured against
  `tests/helpers/stub-realtime.mjs`. No workspace on this product has a realtime key (VOICE-1's
  shipped R750 result is the no-key sentence, VOICE-2 is the row for fixing it), so what a real
  provider does with a real silent line is still read from the vendors' documentation, and the live
  proof of this fix is one call from the next TestFlight build with the microphone denied or broken:
  the relay log should carry the drop line and the agent's conversation should carry nothing.
- **The floor is not calibrated against a real microphone.** -54.2 dBFS is argued from the numbers in
  the reports (build 20's 0.0 dBFS peak, the phone's 0.5 capture trim) and from what resampling noise
  looks like, not measured against somebody talking quietly in a room two metres from a phone. If a
  real call is ever dropped with a non-zero peak in the log line, that number is the dial.
- **The phone's frame counts are in the log, not in the decision.** The task named them beside the two
  audio numbers. They are reported on every drop, and deliberately not part of the test: `blocks` and
  `sent` are cumulative for the whole call and cannot say anything about one utterance, and a page
  older than the `capture` frame sends none at all, so requiring them would refuse real lines from
  real phones. Flagged rather than quietly dropped.
- **`hear-begin` is still sent on a line with nothing heard.** It is the provider's turn detection
  speaking, not provider text, and the panel it opens is closed by the `empty` that follows. Gating it
  would also be the one thing that could stop a barge-in opening a panel.
- **Nothing was run in a browser.** The page half of this is VOICE-15b part 1 and is already landed.

## NEEDS AN OWNER

**1. `scripts/verify-voice.mjs`'s fake microphone stops after three seconds.** Three legs launch
Chromium with `--use-file-for-fake-audio-capture=${wav}%noloop` (lines 1187, 1450 and 1633) against a
WAV that is "three seconds of a 440 Hz tone". With `%noloop` the device goes silent after three
seconds, and any utterance those legs drive later than three seconds plus the grace now has no sound in
its window, so the relay will drop its transcript and the leg will wait for a panel that is never
painted. I could not measure which legs cross that line: those legs need Chromium through
playwright-core and this worker was told no GUI browser. Owner: whoever holds `scripts/verify-voice.mjs`
tonight, which is not this branch. Next action: drop `%noloop` in those three places so the tone loops,
which is also what a room with a sound in it looks like; the Chromium leg at line 2483 already does
exactly that, and the WebKit legs build their microphone out of Web Audio and are unaffected.

**2. `tests/voice-capture.test.mjs` has been failing since the page wave landed, and not because of
this one.** Commit 635c879 added `micPeak` to the capture stats in `ui/machine-room/voice.js` for the
ended card. `tests/voice-capture.test.mjs:238` asserts the exact key list of those stats and still
expects the old nine, so it fails with `micPeak` as the only difference: 10 of its 11 cases pass. It is outside this worker's declared files and a one-line edit in a shared test file is exactly
the collision the overnight file ownership exists to prevent, so it is filed rather than fixed. Owner:
whoever holds the VOICE-15b page files. Next action: add `'micPeak'` to the expected key list beside
`'micLevel'`, with the one-line comment the other two counters already carry.
