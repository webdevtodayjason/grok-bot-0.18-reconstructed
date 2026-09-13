# VOICE-20: the hand-off must not clip Titan, and a second card must reach the call screen

Jason, 2026-09-13 15:26 CDT, on build 22 with VOICE-19 live: "when Titan starts to send work to
the subagent, it interrupts what Titan is saying. If Titan is in mid-sentence or at the end of the
sentence, it will clip." And on the card: "I didn't get it to pop up once, but the other one didn't
pop up. It popped up underneath, so when I closed the chat I saw it in the normal chat to approve."
Feedback row 41 says the same clip: "Titan's voice clips/cuts off at the end when you switch over
to passing something off."

## Part 1: the clip at the hand-off (relay, `ui/voice-edge.mjs`)

What the code does today. The model says its waiting sentence ("checking the mail now") and calls
the `titan` tool in the same response. The box answers in a few seconds (VOICE-16). `answerTool`
then sends `function_call_output` and `response.create` AT ONCE, with no wait on
`responseInFlight` and no wait on playback (`gate.playsUntilMs`), while `say` and
`sayDraftSentence` both wait on `responseInFlight`. The lead sentence of the box's reply
(`sayDraftSentence`, VOICE-3) can also land while the waiting sentence is still leaving the
speaker. Two candidate causes, and the wave must MEASURE which before fixing: (a) a
`response.create` while the ack response is still generating makes the vendor cancel or truncate
the active response (its error for that case, `conversation_already_has_active_response`, is in
QUIET_PROVIDER_CODES and therefore never logged, so the log proves nothing today); (b) the page
throws queued audio away when a new response's audio starts (read `ui/machine-room/voice.js`'s
player and the shell's `audioPlay` / `audioFlush` path for anything keyed on the response id).

Instrument first: log, per response id, audio bytes delivered and the page's `playedMs` at the
moment each `response.create` is sent and each `response.done` arrives, and log the quiet codes
at debug level with their response id. Measure on the demo tenant through the real vendor with
`scripts/verify-voice-r750.mjs` (the leg that already makes one real spoken turn through the real
vendor with a fake microphone in Chromium; read its header for how it reaches the demo tenant and
turns the workspace's talking switch on and back off). Ask a question that makes Titan call the
tool ("check what is in the inbox") and read the numbers. Then fix the cause that the numbers
name: most likely `answerTool` waits, the way `sayDraftSentence` does, for the in-flight response
to finish AND for booked playback to drain (`gate.playsUntilMs <= now()`) before `response.create`,
with a ceiling so a stuck booking cannot hold the answer forever. The function_call_output itself
goes at once (the model is waiting on it). No new wire frame; instructions untouched.

## Part 2: the second card (console, `ui/machine-room/voice.js`)

VOICE-19 made a pending auto-review card exempt from the staleness rule and keeps a card this
call has drawn once it settles. The report says a second pending card raised after the first one
settled did not take the middle of the call screen; it was in the transcript when the call ended.
Find why (a settled card held in the middle outranking a newer pending one, or the pending card
not being "the newest thing", or the exemption keyed on the first card's id) and fix it: a NEW
pending approval always takes the middle, replacing a settled one; the settled one goes back to
being just a transcript row. Test in `tests/machine-room-voice.test.mjs` with two cards in
sequence, and extend `verify-voice --leg call` to force a second approval after settling the
first (the leg already forces one on the local box) and assert the copy in the middle is the
second card with its buttons at 44 px.

## Rules

Model opus. Own worktree, branch voice-20. Files: `ui/voice-edge.mjs`, `ui/machine-room/voice.js`,
`docs/VOICE.md`, `tests/voice-turn.test.mjs`, `tests/machine-room-voice.test.mjs`,
`scripts/verify-voice.mjs` and `scripts/verify-voice-r750.mjs` only to extend legs. No em dashes.
Never restart 127.0.0.1:7777, never restart or recreate anything on the R750 (the r750 gate reads
the live relay as a customer, it changes nothing), no GUI browser. The demo tenant's talking switch
must be restored to what the gate found. Report in docs/VOICE-20-REPORT.md with the per-response
numbers that named the cause, and what is not proven. Commit on the branch, do not push.
