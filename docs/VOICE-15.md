# VOICE-15: the phone owns its own audio

Jason, 2026-09-12 21:23 CDT: "Just for clarification the forcing of the speaker has never worked.
It's always been the earpiece." Builds 15 and 16 set `.playAndRecord`, `.defaultToSpeaker`,
`overrideOutputAudioPort(.speaker)` and (16) re-applied it on every route change. None of it moved
the audio off the receiver.

Why, measured against WebKit's own record (bugs.webkit.org 196539, 230902 and the Cordova and
Zoom threads): while a WKWebView holds a getUserMedia capture, WebKit configures and owns the
AVAudioSession itself, and it routes a live capture's playback to the receiver. An app-level
override is reapplied under it and loses. Six calls on 2026-09-12 also opened with a live capture
that carried no speech at all (VOICE-14 mic peak line), which is the same WebKit capture path.
There is no reliable way to win the route from outside while WebKit's capture runs.

So the phone app stops using WebKit for audio. The page keeps the socket, the orb, the caption,
the barge-in and the whole call screen; the microphone frames come from the shell and the PCM to
play goes back to the shell. AVAudioSession is then the app's alone: loudspeaker by default, an
earpiece choice for the person, and a route line the page can show, so nobody guesses again.

## The contract between the page and the shell

Page to shell, through the existing `window.webkit.messageHandlers.titaniumVoice.postMessage`
(TitaniumVoice.swift `receive`), all with `action`:

| action | fields | meaning |
|---|---|---|
| `audioStart` | `sampleRate: 24000` | open the mic natively, mono PCM16 at that rate, and start posting frames |
| `audioStop` | | close the mic, stop playback |
| `audioPlay` | `pcm: <base64 PCM16 24 kHz mono>` | queue this audio for playback, in order |
| `audioFlush` | | drop everything queued and playing (barge-in) |
| `audioOutput` | `value: "speaker" \| "earpiece"` | the person's choice for this call; remembered for the next |

Shell to page, through `webView.evaluateJavaScript` (the path `stop()` already uses), into a
page-side object the console installs before any call: `window.__titanbotAudio`:

| call | meaning |
|---|---|
| `__titanbotAudio.frame("<base64>")` | one 100 ms mic frame, PCM16 24 kHz mono (4800 bytes) |
| `__titanbotAudio.route({category, mode, outputs: [portType...], output: "speaker" \| "earpiece" \| "headphones" \| "bluetooth" \| "other", error: "" })` | the session as it really is, on start and on every route change |
| `__titanbotAudio.playedMs(n)` | cumulative milliseconds of audio that have left the speaker, so the page's playsUntil booking stays honest |

The shell announces the capability once, in the injected script: `window.__titanbotShell.nativeAudio = true`.
A page without that flag (desktop, an old app build) is byte for byte what it is today.

## Part 1: the shell (app repo), worker `voice15-shell`

Repo /Users/sem/orca/workspaces/titanium-bot-app. New file
`packages/titanium-bridge/ios/Sources/TitaniumBridgePlugin/TitaniumAudio.swift`, wired from
`TitaniumVoice.swift` (which keeps the permission gate, keep-awake, and the console-origin checks).

- Capture: AVAudioEngine input node, converted to 24 kHz mono Int16, delivered as 100 ms frames
  (4800 bytes) via `evaluateJavaScript("window.__titanbotAudio.frame('...')")` on the main queue.
  Base64 the bytes; no JSON escaping problems that way.
- Playback: a single AVAudioPlayerNode (or the engine's output with a ring buffer) fed from
  `audioPlay` frames in order; `audioFlush` stops and empties. Report `playedMs` at least every
  250 ms while anything plays.
- Session: `.playAndRecord`, mode `.videoChat` (voice processing for echo cancellation, speaker by
  default), options `[.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP]`, then
  `overrideOutputAudioPort` per the person's `audioOutput` choice, re-applied on route change only
  when the route is the built-in receiver or speaker (headphones, Bluetooth, CarPlay, AirPlay win).
  The choice persists in UserDefaults.
- Route line: on start and on `AVAudioSession.routeChangeNotification`, post `route({...})` to the
  page with the real category, mode, outputs and any error.
- Never open the mic outside a call, never while suspended; `end()` tears the engine down.
- WebKit's own getUserMedia is not used at all on this path: the page will not call it when
  `nativeAudio` is true, and `requestMediaCapturePermission` still denies everything but the
  console origin as today.
- Tests through the same initializer seam pattern as TitaniumVoiceTests: a fake engine that yields
  known Int16 frames, assert the base64 the page receives and the 4800-byte framing; a fake route
  and assert the override rule; playback ordering and flush.
- Commit on main, do not push.

## Part 2: the page (gb, ui only), worker `voice15-page`

Files: `ui/machine-room/voice.js`, `ui/machine-room/index.html` and `styles.css` only for the two
new controls, `docs/VOICE.md`, `docs/APPS.md` (the shell contract section), tests in
`tests/machine-room-voice.test.mjs` and `tests/voice-capture.test.mjs`.

- Install `window.__titanbotAudio` at load with `frame`, `route`, `playedMs`; they are no-ops until a
  call is up.
- When `shellHost()?.nativeAudio === true`: `captureAudio` does NOT call getUserMedia or open an
  AudioContext; it sends `audioStart` and turns every `frame()` into the same 100 ms frames the
  socket already sends. The player sends `audioPlay` per PCM delta instead of scheduling
  AudioBufferSourceNodes, `audioFlush` on the barge-in flush, and books `playsUntilMs` from
  `playedMs`. `audioStop` on hang-up.
- Call screen: a speaker/earpiece toggle (two states, 44 px, aria-pressed), sending `audioOutput`,
  shown only when `nativeAudio` is true. Under it one quiet line from `route()`: the output as a
  word ("Speaker", "Earpiece", "Headphones", "Bluetooth") and, if error is non-empty, the error.
- Relay-down state (VOICE-15c, from the feedback rows of 2026-09-12): when the voice socket fails
  to open, errors, or closes without the person pressing the button, the call screen says in words
  that voice is unavailable and why ("the relay did not answer", "the line dropped"), the orb goes
  off, and the button reads "Try again". Today it sits on "Listening" with a dead mic.
- Desktop and any shell without `nativeAudio` are byte for byte unchanged; every existing test
  passes. New tests: the native path sends no getUserMedia and turns shell frames into socket
  frames; the player hands PCM to the shell and flushes; the toggle sends `audioOutput`; the
  relay-down sentence appears on a refused upgrade.

## Rules for both workers

- Model opus. Work only in your own tree. Commit with plain-prose messages, no em dashes anywhere.
  Do not push, do not touch the R750, do not restart anything on 127.0.0.1:7777, no GUI browser.
- Run the suites you touch and paste the summary lines in docs/VOICE-15-REPORT-<part>.md, with
  what is not proven (no phone is reachable from a worker).

## Ship (operator)

Relay first (page half is inert without the flag), then push the app repo for TestFlight build 17.
Measured on Jason's phone: the route line reads Speaker, a call completes turns, a barge-in cuts
Titan off, the toggle moves the audio to the earpiece and back, and the relay-down sentence shows
when the relay is restarted mid-call.

## VOICE-15b, filed 2026-09-12 22:30 CDT from Jason's TestFlight note on build 17

Owner: the next app build. Three call-screen faults on the phone, in his words: "there's no reason to
have a text box there for chatting in this view", "if you turn your phone sideways by accident, it
should not go into landscape mode. It should stay upright", "The buttons do not look so great ... the
shapes are wrong and they kind of overlap on the text." Plus the earlier build 15 note: "There's a
blue checkmark in the text box and I have no idea what that is." Portrait lock is the app's
Info.plist (UISupportedInterfaceOrientations, iPhone only); the other three are the console's call
screen at phone width, measured in WebKit at 390x844 before they ship.
