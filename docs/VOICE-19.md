# VOICE-19: approve on the call screen, by tap or by saying so

Jason, 2026-09-13 13:25 CDT, on build 21: "The approval card popped up while I was in my voice
chat session, which is beautiful, but it did not have an approve or deny button in that view. When
I closed or ended the call, it was there in my chat, and I was able to click approve. ... it
doesn't exist inside the voice chat and it should. I should also be able to tell Titan when it pops
up on the screen ... I approve it and let Titan approve it through my verbal approval."

## What is true today (measured 2026-09-13)

- A pending auto-review card in the transcript has Allow and Refuse, 73x44 and 77x44 at 390 in
  WebKit (`decisionMarkup` in `ui/machine-room/app.js`, `.inline-card-actions .card-action`).
- The call screen (`ui/machine-room/voice.js`, VOICE-13) copies the newest card into the middle and
  REMOVES its controls, by design: "every card's buttons are wired against its row in the
  transcript and the ones in the chat are the ones that work". That is the card Jason saw with no
  buttons.
- The relay (`ui/voice-edge.mjs`) turns a pending `auto-review-approval` outline entry into a held
  card (around line 1705), speaks it, and closes it through the console's own approval commands on
  a spoken yes or no (around line 2084, "never a second gate"). Whether that path fires for an
  approval the box raises in the middle of a `titan` tool turn during a live call, on the R750
  with the real host, has not been measured. Jason did not hear Titan ask.

## What changes

1. **The call screen card keeps its buttons.** For an `auto-review` decision card, the copy in the
   middle of the call screen carries the same Allow / Refuse (and Always allow when a rule exists)
   controls, at least 44 px, wired to the SAME adapter call the transcript row uses (find the
   `data-decide` handler in app.js and call through it, do not add a second decide path). After a
   tap the copy shows the settled state the transcript shows. Other card kinds stay as they are.
2. **Titan asks out loud and a yes settles it.** When a pending approval appears during a call,
   the voice says one short sentence naming the action ("Titan wants to run a command: echo hello.
   Allow it?") and a spoken yes / approve / go ahead / do it settles it as Allow, a no / refuse /
   stop as Refuse, through the existing held-card path. Make it fire for an approval raised inside
   a tool turn as well as between turns; if the outline read that finds pending cards runs only at
   certain moments, add the moment. The card on screen and the spoken question are the same card:
   a tap settles the spoken question, a spoken yes settles the card on screen.
3. **Nothing else moves.** No new frame to the vendor, instructions still written once per call,
   the transcript row stays the source of truth.

## Tests and measurement

- `tests/machine-room-voice.test.mjs`: the call-screen copy of a pending auto-review card has the
  buttons, they call the same adapter method as the row's, a settled card loses them.
- `tests/voice-turn.test.mjs`: a pending approval arriving mid tool-turn produces one spoken
  question and one held card; "yes" produces one approval command and no sendPrompt; "no" one
  refusal; a tap-settled card is not asked again.
- `node scripts/verify-voice.mjs --leg call` in WebKit 390x844 against the local box with the
  stub vendor: a forced approval (the rig in `scripts/verify-console-polish.mjs --approval` arms
  SAND_AUTO_REVIEW_MODE=enforce on the local box) shows the card on the call screen with two
  buttons at least 44 px, the stub hears the question, a tap settles it and the transcript row
  agrees. Paste the numbers in docs/VOICE-19-REPORT.md with what is not proven (no real phone,
  no real vendor from a worker).

## Rules

Model opus. Own worktree, branch voice-19. Files: `ui/machine-room/voice.js`, `ui/voice-edge.mjs`,
`ui/machine-room/voice-call.css` if the buttons need room, `docs/VOICE.md`, the two test files,
`scripts/verify-voice.mjs` only to extend the call leg. Never touch app.js's decide handler beyond
calling it. No em dashes anywhere. Never restart 127.0.0.1:7777, never touch the R750, no GUI
browser. Commit on the branch, do not push.
