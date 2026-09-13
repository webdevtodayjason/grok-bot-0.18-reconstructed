# VOICE-14: a phone call that sounds like one

Jason, 2026-09-12 20:08 CDT, on the iPhone build 15 call screen: "It's coming through in the
earpiece, not the speaker. Also why are we not doing real-time audio? I can't barge in. This is me
talking. It gets transcribed and then I hear audio back. That's not what this is supposed to be."
"go voice" at 20:21.

What is true today (measured on the R750 and on this Mac):

- The line IS streamed audio both ways: 24 kHz PCM16 from the mic to xAI `grok-voice-think-fast-2.0`
  over `ui/voice-edge.mjs`, audio deltas straight back into Web Audio in `ui/machine-room/voice.js`.
- The wait is the titan() tool call: every utterance goes to the box with sendPrompt and the reply
  lands as ONE complete `send-message` entry 5.5 to 25 s later (voice-edge.mjs header, point 2).
  The voice model says "on it" and reads the whole reply when it arrives. Filed as VOICE-3.
- Barge-in is off on purpose for desktop speakers: the mic is shut while the agent speaks
  (voice.js header "NO BARGE-IN", ECHO_TAIL_MS, relay-side `makeEchoGate`) because the interruption
  came from the speakers. On a phone the earpiece or iOS echo cancellation removes that reason.
- Build 15's `TitaniumVoice.swift` sets `.playAndRecord` + `.videoChat` + `overrideOutputAudioPort
  (.speaker)` once, in `activate()`. WebKit reconfigures the audio session when getUserMedia opens,
  so the audio ends up on the receiver. The override has to be re-applied on route change.

Three parts, three workers, one ship.

## Part 1: the speaker stays the speaker (app repo)

Repo /Users/sem/orca/workspaces/titanium-bot-app, file
`packages/titanium-bridge/ios/Sources/TitaniumBridgePlugin/TitaniumVoice.swift`, tests in
`packages/titanium-bridge/ios/Tests/.../TitaniumVoiceTests.swift`.

- While `audioActive`, observe `AVAudioSession.routeChangeNotification`; when the current route's
  output is the built-in receiver (or anything that is not speaker, Bluetooth or headphones), call
  `overrideOutputAudioPort(.speaker)` again. Headphones and Bluetooth win: never force the speaker
  over them.
- Keep the category `.playAndRecord`; mode back to `.voiceChat` (build 14 worked with it; build 15's
  `.videoChat` changed nothing audible). Options stay `[.defaultToSpeaker, .allowBluetooth,
  .allowBluetoothA2DP]`.
- Inject the observer through the same initializer seam the tests already use so a test can fire a
  fake route change and assert the override was asked for, and assert it is NOT asked for when the
  route is headphones.
- Commit on main, do not push. The TestFlight build is triggered by the operator after review.

## Part 2: barge-in on the phone (gb, ui only)

Files: `ui/machine-room/voice.js`, `ui/voice-edge.mjs`, `docs/VOICE.md`, tests
`tests/machine-room-voice.test.mjs`, `tests/voice-wire.test.mjs`, `tests/voice-turn.test.mjs`.

- The console knows it is inside the phone app from `window.__titanbotShell.platform === "ios"`
  (voice.js `shellHost()`). In that case, and ONLY in that case, the call runs with barge-in:
  the mic stays open during playback (no local echo gate), and the browser tells the relay on the
  session's opening JSON that it wants `bargeIn: true`.
- Relay, when `bargeIn` is on for a session: do not drop mic frames with the echo gate; on
  `input_audio_buffer.speech_started` while audio is still booked to be playing (`playsUntilMs` in
  the future) send the provider `response.cancel`, and send the browser a `flush` message so the
  Web Audio queue is emptied and `playsUntilMs` reset. Count each barge-in in the session meter and
  print it in the settled row's close line.
- Desktop behaviour is unchanged byte for byte: same gate, same held counts, same copy. Every
  existing test still passes.
- The two xAI quiet codes already in `QUIET_PROVIDER_CODES` cover a cancel that races a finished
  response.
- docs/VOICE.md: one paragraph under the interruption section saying barge-in is on inside the
  phone app and why it stays off on desktop speakers. No em dashes anywhere in copy or docs.

## Part 3: Titan's answer arrives in sentences (gb, host + relay), VOICE-3 made real

Files: host `source/host/...` (the transcript/turn projection), `ui/voice-edge.mjs` titan() path,
tests for both, `docs/VOICE.md`.

- Find where the host accumulates the assistant's streamed text during a turn (the OpenAI-compatible
  provider session streams deltas; the send pipeline in `source/host/extensions/transcript/` owns
  the turn). Project it as an in-progress draft the relay can read without polling the whole
  transcript: a gateway push event carrying `{conversationId, turnId, text}` as the text grows,
  or a gateway command `getTurnDraft(conversationId)` if pushing is not possible. Measure what
  exists first (`[sand][wire]` and the gateway protocol in source/host/host-gateway-api.ts) and
  write down in the report which you built and why.
- In voice-edge titan(): as the draft grows, cut complete sentences off the front and hand each to
  the voice model as soon as it is complete, so it starts speaking after the first sentence rather
  than after the whole reply. The realtime API takes one `function_call_output` per call; say in the
  report how the interim sentences are delivered (a `conversation.item.create` assistant item plus
  `response.create` per sentence is the known pattern) and make sure the final tool output does not
  re-read what was already spoken. Keep the existing whole-reply path as the fallback when the host
  sends no draft (old host bundle on a box).
- Both vendors (xAI flat session, OpenAI GA) keep working; the vendor map has one entry per event.
- Never rewrite `voiceInstructions` per turn (prefix cache).

## Rules for every worker

- Model: opus. Work only in your own tree. Commit on your branch with a plain-prose commit message.
  Do not push, do not touch the R750, do not restart anything on 127.0.0.1:7777, do not open a GUI
  browser (headless scripts under scripts/verify-*.mjs are fine).
- `node --test` the touched suites and paste the summary lines in the report. Host changes also run
  `npm run source:typecheck` and `node scripts/build-host.mjs --out /tmp/voice14-hostbuild`.
- Report at docs/VOICE-14-REPORT-<part>.md: what changed, what was measured, what is not proven.

## Ship (operator)

1. Merge parts 2 and 3 into webdevtodayjason/gb, run the voice suites once more.
2. Clean worktree, `bash deploy/r750/sync.sh --no-install`; relay restart LAST; host update by
   updateHostNow on the demo box then Jason's box only.
3. Push the app repo to main to trigger ios-testflight.yml, then Jason installs the new build.
4. Measure: Jason's phone call on speaker, a barge-in that cuts Titan off, and the first sentence
   spoken before the box's full reply lands (voice_sessions row plus the relay log line).
