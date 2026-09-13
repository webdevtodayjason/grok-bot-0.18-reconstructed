# VOICE-15 part 2: the page, native audio

Branch `voice15-page`. UI only: `ui/machine-room/voice.js`, `ui/machine-room/styles.css` (the two new
call-screen controls and the route line, under the VOICE banner), `docs/VOICE.md`, `docs/APPS.md` (the
shell contract), and the two test files that cover them. Nothing in `ui/machine-room/app.js`, nothing in
`ui/voice-edge.mjs`, nothing in `ui/machine-room/voice-call.css` (another wave's file), nothing in
`index.html`, nothing on the R750, nothing restarted on 127.0.0.1:7777, no GUI browser.

Every number below was measured on this Mac (macOS 26.6.2, node v22.23.1) under `node --test`. None of
it was measured on a phone, on the R750, or against a real `AVAudioSession`.

## What changed

**`window.__titanbotAudio` is installed at load, and no-ops until a call is up.** Three handlers:
`frame(base64)` feeds the native capture if one is running, `route(info)` moves the toggle and the line
if a call is up, and `playedMs(n)` books the gate through the native player if one is in use. In a
browser none of the three ever has anything to act on, so each is a quiet no-op there.

**When `shellHost()?.nativeAudio === true` the capture is the shell's.** `captureAudio` is not called:
no `getUserMedia`, no `AudioContext`. `startNativeCapture` sends the shell `audioStart` with
`sampleRate: 24000`, and each 100 ms frame the shell hands back through `__titanbotAudio.frame` becomes
one 4800-byte socket frame, through the same `held` and `muted` callbacks the worklet path uses, so a
muted call drops frames on the page the way a browser call does. It exposes the same `stats` shape, so
`state.capture` reads identically whichever path opened it. `audioStop` goes on hang-up, from the
capture's own `stop()`, and it closes the mic and the playback together per the contract.

**The native player hands PCM to the shell instead of scheduling Web Audio.** Each delta is one
`audioPlay` with base64 PCM16; a barge-in flush is one `audioFlush`; and `playsUntilMs` is booked from
the shell's `playedMs` report, not from the bytes handed over, because the page is not the thing
scheduling the audio any more. A new `echoGate.remaining(ms)` sets `playsUntilMs` that far ahead of now.

**The base64 codec is the module's own.** A pure-JS pair rather than `atob`/`btoa`, because the module
runs under a bare window in its tests and under WebKit in the app, and a codec present in one and
missing in the other would be the kind of bug that only a phone finds. Round-trips at lengths 0 through
4800 and against the RFC 4648 vectors.

**The call screen gained a speaker/earpiece toggle and a route line, native audio only.** The toggle is
44 px, `aria-pressed`, speaker by default; a press sends `audioOutput` and reflects the choice at once,
and the shell's `route()` corrects it to whatever the hardware settled on. Under it one quiet line reads
the output as a plain word, with the error after it if the shell reported one. A browser keeps WebKit's
own route and neither control is shown. CSS for both, plus the Try again button below, is in
`styles.css` under a `VOICE-15` banner: all `.voice-` selectors, the console's teal token, no marketing
hex, which is what the existing "styles.css gained only new selectors" case enforces.

**The relay-down state (VOICE-15c).** When the voice socket fails to open, errors, or drops without the
person pressing End, the call screen now stays up, turns the orb off, swaps Mute for Try again, and
reads a plain sentence: "Voice is unavailable: the relay did not answer" for a line that never opened,
"…the line dropped" for one that did and then went. Try again dials a fresh line on the screen that
never went. This is gated on `nativeAudio`: a phone in a plain browser keeps VOICE-13's behaviour, the
sentence on the shelf and the screen gone, which is what keeps every existing test green and every shell
without the flag byte for byte unchanged.

## What was measured

```
node --test tests/machine-room-voice.test.mjs tests/voice-capture.test.mjs tests/voice-wire.test.mjs tests/voice-turn.test.mjs
```

```
# tests 163
# suites 0
# pass 163
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 24534.6185
```

`# skipped 0` is the point: the `machine-room-voice` real-browser leg ran, on Chrome through
playwright-core, and passed. The broader voice set (`voice-socket`, `voice-frames`, `voice-caps-ledger`,
`voice-transcription`, `voice-turn-draft`, `cp-voice` on top of the four above) is 278 pass, 0 fail, 0
skipped. `node --check` is clean on `ui/machine-room/voice.js`, `tests/machine-room-voice.test.mjs` and
`tests/voice-capture.test.mjs`.

The nine new cases, all green:

```
ok - VOICE-15 base64: PCM survives the shell bridge in both directions, padding and all
ok - VOICE-15 native capture: the app opens the shell's mic, never getUserMedia, and a shell frame becomes one socket frame
ok - VOICE-15 native playback: each delta is an audioPlay, a flush is an audioFlush, and playedMs books the room
ok - VOICE-15 toggle: the speaker/earpiece control sends audioOutput, shows only in the app, and the route line reads the shell's truth
ok - VOICE-15 toggle: a browser keeps WebKit's own route, so neither the toggle nor the route line is there
ok - VOICE-15c relay-down: a refused upgrade keeps the call screen, says why, and Try again dials again
ok - VOICE-15c relay-down: a live line that drops mid-call says the line dropped, on the screen
ok - VOICE-15c relay-down: a phone in a plain browser keeps VOICE-13's shelf behaviour, so nothing without the flag changes
ok - VOICE-15 a browser line sends no shell audio messages and opens its own microphone
```

What each one really drives:

- **base64**, both directions, at lengths 0 through 4800 and against "Man"/"Ma"/"M", plus the whitespace
  a bridge might insert being dropped rather than decoded to a stray byte.
- **Native capture**, end to end: `audioStart` with the 24 kHz the contract names, zero `getUserMedia`
  calls, one base64 shell frame arriving as one 4800-byte socket frame with its sound still in it, a
  muted call dropping the frame and counting it as a mute rather than the echo gate, and a frame after
  hang-up reaching nobody. `audioStop` goes on hang-up.
- **Native player**: three deltas become three `audioPlay` messages each carrying its PCM; `playsUntilMs`
  is 0 until the shell reports, then tracks `queued minus played`, and a barge-in `flush` sends one
  `audioFlush`, puts `playsUntilMs` back to 0 and `gate.holding()` to false.
- **The toggle** sends `audioOutput` with the flipped value and shows the new state at once; the shell's
  `route()` is the truth under it, as a plain word, and a route with an error reads both in plain words;
  a browser shows neither the toggle nor the line.
- **Relay-down**, three cases: a refused upgrade in the app keeps the screen, says the relay did not
  answer, turns the orb off, shows Try again and hides Mute, puts nothing on the shelf, and Try again
  dials a fresh line that recovers; a live line that drops mid-call says the line dropped on the screen;
  and a phone in a plain browser still closes the screen and lands the no-key sentence on the shelf.
- **The browser line** sends nothing to the shell's bridge and opens its own microphone, even inside a
  shell that is iOS but an old build with no `nativeAudio` flag.

## One deviation from the brief, declared

The brief's Part 2 says the relay-down state applies when "the voice socket fails to open, errors, or
closes without the person pressing the button", without naming a host. I gated it on `nativeAudio`,
because the brief's own "Rules" also say "Desktop and any shell without the flag stay byte for byte
unchanged and every existing test passes", and an existing browser-leg case
(`VOICE-1 in a real browser …`) taps Talk on a 390x844 browser and asserts the failed dial closes the
screen and lands the no-key sentence on the shelf. Applying relay-down to every call screen broke that
case. Gating on `nativeAudio` keeps the phone-browser path exactly as VOICE-13 shipped and puts the
relay-down screen where the feedback rows found the bug: the full-screen native app, which has no shelf
behind it to read. The new "phone in a plain browser keeps VOICE-13's shelf behaviour" case pins that
boundary.

## What is not proven

- **No phone.** That iOS really keeps the call on the loudspeaker at full volume, and that a person can
  cut Titan off by talking over the shell's own echo-cancelled microphone, is Jason's call on the
  TestFlight build. These cases prove the switch between the two audio paths, the five shell messages,
  the toggle and the two relay-down sentences against a fake shell bridge; they cannot prove the route
  the shell gets from `AVAudioSession`.
- **The `playedMs` contract across a flush.** The page books `playsUntilMs` from the shell's cumulative
  `playedMs`, and on a barge-in it sets its own queued total to the last played figure so the booking is
  honest again at once. That assumes the shell's `playedMs` is cumulative for the whole call and is not
  reset on `audioFlush`. The contract table says "cumulative", which I read as not-reset; the
  `voice15-shell` worker has to implement it that way. On iOS the mic is not gated on `playsUntilMs` at
  all (barge-in), so any disagreement here is cosmetic, affecting only the reported number, never whether
  a frame is sent.
- **No real `audioPlay` was drained.** The player was measured against a recording bridge, not an
  `AVAudioPlayerNode`. Ordering and the base64 payload are proven; that the shell plays them in order
  and reports `playedMs` honestly is the shell worker's leg.
- **`index.html` was not touched.** The two new controls are generated in `callMarkup()` in `voice.js`,
  so no markup landed in `index.html`. The brief allowed an `index.html` edit for the controls; none was
  needed.
