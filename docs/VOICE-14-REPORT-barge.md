# VOICE-14 part 2: barge-in on the phone

Branch `voice14-barge`. UI only: `ui/machine-room/voice.js`, `ui/voice-edge.mjs`, `docs/VOICE.md`, and
the two test files that cover them. Nothing in `source/`, nothing in `ui/machine-room/app.js`, nothing
on the R750, nothing restarted on 127.0.0.1:7777.

Every number below was measured on this Mac (macOS 26.6.2, node v22.23.1), under `node --test`. None of
it was measured on a phone, on the R750, or against xAI.

## What changed

**The console asks for it, and only in the app.** `ui/machine-room/voice.js` reads
`window.__titanbotShell.platform === "ios"` through a new `bargeInWanted()` beside the shell readers it
already had. Nothing reads a user agent. When that is true, and only then, the page does three things
differently: it sends `{"t":"hello","bargeIn":true}` as the first frame after the socket opens, its
capture callback never consults the echo gate, and it handles a `flush` frame from the relay. A browser
sends no opening frame at all, so a desktop line carries the same bytes it carried before this wave.

**The player can be emptied.** Web Audio has no queue: every delta was already scheduled on its own
`AudioBufferSourceNode` at a time in the future and will play at that time whether or not anybody still
wants it. So the player now holds the nodes it started, drops them on `onended`, and `flush()` stops and
disconnects each one, resets the schedule to `currentTime`, and counts itself. The `AudioContext` is
deliberately KEPT: it was opened under a gesture, and WebKit will not resume one without another, so
closing it would cost the sentence after the interruption its voice. The `flush` frame also resets the
page's own echo gate, which is what puts `playsUntilMs` back to zero.

**The relay gives that line a different deal.** `ui/voice-edge.mjs` keeps a per-session `bargeIn` flag,
set from the first `hello` and never changed after it. While it is on, inbound microphone frames skip
`gate.admit()` entirely, so nothing is held and the provider's turn detection can actually fire. On
`input_audio_buffer.speech_started`, if `gate.playsUntilMs` is in the future, the relay sends the
provider `response.cancel`, sends the page `{"t":"flush"}`, releases the gate, clears `responseInFlight`
and counts the barge-in on the session meter. The two audio ceilings (the session cap and the three
second lead) still apply to a barge-in line, because those are about spend and not about echo.

**The count is on the close line.** `close()` now prints the settled row in one sentence, with the
barge-in count in it beside wall seconds, both audio meters, turns, and held frames. The LEDGER ROW
SCHEMA IS UNCHANGED on purpose: `tests/voice-caps-ledger.test.mjs` asserts the row's exact key set and
that file belongs to another wave, so adding a `bargeIns` column there is a separate, declared change.
What the brief asked for is the meter and the close line, and that is what is there.

**Why the phone and not a laptop**, written into both headers and into `docs/VOICE.md` section 8: the app
owns the audio session, asks iOS for the speaker and for voice-chat echo cancellation, and the microphone
it hands the page has already had the agent's own voice removed. In a browser the interruption still
comes out of the person's own speakers, which is the feedback loop the gate was built for.

## What was measured

`node --test tests/machine-room-voice.test.mjs tests/voice-wire.test.mjs tests/voice-turn.test.mjs
tests/voice-socket.test.mjs tests/voice-frames.test.mjs`

```
1..146
# tests 156
# suites 0
# pass 155
# fail 1
# duration_ms 13861.584375
```

The one failure is pre-existing and is not this wave's; it is named in the next section. The six new
cases, all green:

```
ok 1 - VOICE-14 barge-in: the opening frame asks for it inside the phone app, and a browser sends no such frame
ok 2 - VOICE-14 barge-in: the desktop holds frames while the agent speaks and the app sends them
ok 3 - VOICE-14 barge-in: a flush stops every buffer that was queued and puts the booked time back to zero
ok 4 - VOICE-14: the app's line cancels the reply, flushes the page, and counts the barge-in
ok 5 - VOICE-14: a browser's line is byte for byte what it was -- frames held, nothing cancelled
ok 6 - VOICE-14: an interruption with nothing playing cancels nothing, because there was nothing to interrupt
```

What each one really drives:

- The opening frame, under five hosts. One iOS shell sends exactly `{"t":"hello","bargeIn":true}`; a
  macOS shell, a Windows shell, a shell with no platform and no shell at all each send nothing, and the
  flag does not outlive `stop()`.
- The gate, through the real capture path and the worklet's own port. A desktop line with the gate
  holding drops the frame and counts it (`heldFrames` 1, nothing on the wire); the same line in the app
  holds nothing and the frame that goes is sound rather than silence.
- The flush, through the real player against a fake `AudioContext` that records `start` and `stop`.
  Three deltas became three scheduled buffers and 300 ms of booked time; the flush stopped all three,
  left the player holding none, and put `playsUntilMs` to 0 and `gate.holding()` to false. A fourth
  delta after the flush is still scheduled, which is the proof the context was not closed.
- The relay, end to end through `tests/helpers/stub-realtime.mjs` and a real `ws` client. Six seconds of
  reply (60 frames of 100 ms) reach the page, two microphone frames sent DURING that reply reach the
  provider with `heldFrames` still 0, and one `speech_started` then produces exactly one `response.cancel`
  to the provider, exactly one `flush` to the page, `playsUntilMs` 0, `bargeIns` 1, and a `hear-begin` so
  the person's own words get their own panel. The close line reads `1 barge-in(s)`.
- The browser's line, same fixture without the opening frame: two microphone frames are held by the
  relay and never reach the provider, `speech_started` produces no cancel and no flush, and `bargeIns`
  stays 0.
- A barge-in line with nothing playing: no cancel, no flush, not counted. The test is booked audio and
  not the orb, because `speech_started` sets the orb back to listening before anything else runs. A
  second `hello` mid-call is ignored, so a page cannot toggle the echo gate at will.

`node --check` is clean on `ui/machine-room/voice.js`, `ui/voice-edge.mjs` and both test files.

## Three pre-existing failures found and fixed on the way

The suite was already red at the branch tip, and two of the three were masking each other. All three
come from ROUTER-1 (0679508), which put the Think harder switch in the composer.

1. `styles.css gained only new selectors` failed on `.think-harder`: ROUTER-1 appended three rules and a
   fifth `.composer` track under the VOICE-1 banner without widening this case's declared exception
   list, which that list's own comment says to do in the commit that needs it. The list now names them,
   and the track assertion now asserts the DIFFERENCE (the gated rule adds exactly one track to the
   ungated one) rather than the two absolute numbers, which is what it was always about.
2. `in a real browser` never opened a socket. Push to talk became the default and a tap on a hold
   control is now a refusal in words, so the single `mouse.click` this leg uses stopped dialling. The leg
   asks for always-listening before it presses, because what it measures is a toggle.
3. The same leg then clicked 63 px away from the button. The Think harder switch arrives on a later
   paint than Talk does, so the button slides along the row after it is first reachable: measured here
   at 1440x900, centre x 918 on the first reachable read and 981 once the composer had settled. The poll
   now requires the same rect twice before the mouse is told where to go. Clicking by selector would
   have hidden that rather than fixed it, and a real mouse at real coordinates is the point of the leg.

## NEEDS AN OWNER: the message box is 90 px wide when a voice note is up

With those three out of the way the browser leg reaches a real, customer-visible defect and stops there:

```
the message box is too narrow to type in with the line up: 90.61 px (was 269.64)
```

Measured at 1440x900 on this Mac, and measured with `ui/machine-room/voice.js` and `ui/voice-edge.mjs`
reverted to the branch tip, so it is NOT this wave's: the composer now has five children of its own, and
the live line's extra track takes `#message-input` to 90.61 px, under the 150 px floor this leg has
asserted since VOICE-2. The floor was not relaxed and must not be.

The one-rule fix is probably `.composer[data-voice-line] .think-harder span { display: none; }`, which is
what ROUTER-1 already does to that label at phone width and would give the box back about 75 px. It is
not in this worker's files: it lands in `ui/machine-room/styles.css`, it is a visual decision about
another wave's control, and other panes may be holding that file this evening. So it is handed back
rather than taken: the cost is one appended CSS rule plus a re-measure of this leg.

## What is not proven

- **Nothing here was measured on a phone.** That iOS really keeps the agent out of the microphone at
  full speaker volume, and that a person can actually cut Titan off by talking, is Jason's own call on
  the TestFlight build. These cases prove the relay cancels and the page empties its player; they cannot
  prove the room is quiet enough for the provider's turn detection to hear a person over a speaker.
- **The relay takes the page's word for the host.** There is nothing on a socket that proves an app, so
  a patched page can ask for barge-in in a browser and make the model hear itself. What that buys is
  bounded by the two audio ceilings and by nothing else: it cannot raise a cap, spend another
  workspace's minutes, or reach a key. Left as it is deliberately, and said out loud in the header.
- **No real provider was dialled.** The cancel was measured against the stub, which answers
  `response_cancel_not_active` the way the real service does for a cancel that races a finished
  response. That code was already in `QUIET_PROVIDER_CODES`, so it is a note and never colours the orb.
- **The count is not durable.** Barge-ins are on the session meter and on the relay's close line, not on
  the ledger row and not at the control plane, for the reason in the first section.
- **The interruption's latency is unmeasured.** How long after a person starts talking the speaker
  actually goes quiet depends on the provider's turn detection and the phone, and nothing here times it.

## Operator follow-up (2026-09-12 20:55 CDT, after the merge)

The tripwire above was fixed in the same pass, in ui/machine-room/styles.css and the test's own
numbers, all measured by tests/machine-room-voice.test.mjs on this Mac at 1440x900 and 390x844:

- The line's track is the FOURTH column, not the third: index.html puts the Think harder switch
  before the Talk button and voice.js puts the line before Talk, so with the fr track third the
  switch took it and the line sat in an auto track sized to its sentence. Message box 90.61 px
  before, over the 150 px floor after.
- While the line is up on desktop the switch drops its word, the way a phone already did.
- On a phone the switch leaves the composer row entirely (message box was 123 px at rest with it
  in the row). Its track stays in the template so the count is five at every width.
- The at-rest track count in the browser leg is five since ROUTER-1, at every width.

Owned follow-up, filed here: ROUTER-1d, the phone gets Think harder back as a row of the + menu
(PHONE-CONSOLE-1's pattern for a control that only exists there). Owner: the next console wave.
