# VOICE-15b part 1: the call screen on the phone, and Think harder on a phone at all

Branch `night-voice15b-page`. UI only: `ui/machine-room/voice.js`, `ui/machine-room/voice-call.css`,
`ui/machine-room/styles.css`, one row added to `ui/machine-room/index.html`, and
`tests/machine-room-voice.test.mjs`. Nothing in `app.js`, nothing in `ui/voice-edge.mjs` (another
worker holds it tonight), nothing on the R750, nothing restarted on 127.0.0.1:7777, no GUI browser.

Jason, on TestFlight build 17, is the whole brief:

- "there's no reason to have a text box there for chatting in this view"
- "The buttons do not look so great ... the shapes are wrong and they kind of overlap on the text"
- "when it was done, it said that the call ended and only one word was said: them. Nobody said that"

plus ROUTER-1d, owned by VOICE-14's own report: on a phone the Think harder switch had no home at all.

**EVERY NUMBER BELOW IS CHROME 153.0.8010.36 AT 390x844, dpr 1, touch, on MacBook-Pro.local
(macOS 26.6.2, node v22.23.1).** The phone's engine is WebKit and it is not available to a worker
here, so what these numbers settle is geometry, the cascade and the hidden attribute. They do not
settle how iOS lays out an emoji glyph, what the safe-area insets do to the bottom row, or anything
about `AVAudioSession`. Pictures: `reports/voice-15b/` (gitignored), `before-390-*.png` and
`after-390-*.png`, written by the suite's own leg and by the same probe run at the branch tip.

## The measurement that started it, and the cause no unit case could see

Before anything was changed, with the call screen up in the app at 390x844:

| control | box | radius | label | drawn? |
|---|---|---|---|---|
| the message box | 86 x 44 at 16,775.03 | 22px | reads "Type ins" | yes |
| speaker/earpiece | 56 x 45.94 at 114,774.06 | 28px | Speaker 42.72 px, Earpiece 45.59 px | **yes, with `hidden` set** |
| Mute | 56 x 45.94 at 182,774.06 | 28px | 26.5 px | **yes, with `hidden` set** |
| Try again | 56 x 45.94 at 250,774.06 | 28px | 48.05 px | **yes, on a live line** |
| End | 56 x 45.94 at 318,774.06 | 28px | 19.92 px | yes |

Two causes, and the first is the one fifty passing cases could not see.

**`[hidden]` did nothing to any of these controls.** `.voice-call-mute, .voice-call-end` in
voice-call.css and `.voice-call-output, .voice-call-retry` in styles.css both set `display: grid`
unconditionally, and an author display rule beats the hidden attribute. So the speaker toggle painted
in a plain browser, where WebKit owns the route and that control decides nothing, and Try again
painted on a live line beside Mute. Every existing case asserts `node.hidden === true`, which is the
module's own state and was always correct; the sheet was what put the control on the screen. This
sheet's own comment on `.voice-call:not([hidden])` and three rules in styles.css already record that
exact trap for other nodes. `verify-ui-in-a-real-browser.md`, paid for again.

**Five controls in 358 px, in pills whose corners curve through their own labels.** With all five
drawn the field was 86 px, and the 28 px radius on a 46 px-tall box is clamped to 22, so the flat
edge is gone exactly where an 11 px label sits: "Try again" is 48.05 px of text with 4 px of pill
each side of it. That is "the shapes are wrong and they kind of overlap on the text", measured.

## What changed

**The phone app's call screen has no message box on it.** `typedLineWanted()` reads the platform the
shell names, beside `bargeInWanted` and `nativeAudioWanted`, and `paintCall` hides the typed ROW (not
just the field inside it: a bare input left in a flex row is still a 44 px gap in the middle of the
controls). The screen carries `data-voice-call-host="app"` or `"browser"`. A phone in a plain browser
keeps VOICE-13's shape, which is what Jason's own recording asked for: "a row at the bottom with
somewhere to type", and the chat behind a browser's call screen is one swipe away rather than another
application. The typed line still leaves by the composer a person already uses, unchanged.

**One shape for the four controls, and the hidden attribute really hides.** Every control is
`display: none` with its shape on `:not([hidden])`, and all four share ONE rule, so "consistent
shapes" is a property of the sheet rather than of whoever edits it next: 72 px wide, a 44 px floor on
both axes, a 16 px rounded rect rather than a pill, an explicit 20 px glyph row, and
`white-space: nowrap` so a label can never wrap and grow the row under the screen's own bottom
padding. 72 is measured and not picked: the widest word any of them carries is "Try again" at
48.05 px, and 16 px corners leave 65 px of flat edge across the band the label sits in.

**The four VOICE-15 rules in styles.css have gone home.** VOICE-15 put the toggle and Try again in
styles.css because voice-call.css belonged to another wave at the time, which is how one shape came
to be written in two files with the copy that broke `[hidden]` in it.
`.voice-call-output`, `.voice-call-retry`, their glyph rule, the pressed fill and `.voice-call-route`
now live in voice-call.css beside the Mute and End they were meant to match. Nothing about the call
screen is styled from styles.css any more, and a case asserts it.

**The ended card says whose words those were.** `rememberHeard()` takes a string only when this page's
own microphone made the sound it was made of: `stats.sent > 0` (frames this page really put on the
socket) and `stats.micPeak > 0` (the loudest of them, a new additive field on both capture paths
beside `micLevel`, which answers a different question and could not answer this one). Anything Titan
said on the call is dropped as well, by exact match or by a short transcript sitting inside one of his
sentences, which is the shape "them." actually took. What is left is the person's own words, and the
card reads back the last of them, cut at 120 characters because the durable record of a spoken turn is
the two rows the relay writes. A call with nothing of the person's on it says **"Nothing was heard."**
in plain words. The list is emptied when a line starts, not when one closes: the card is painted one
frame after `closeCall()` has already run.

**ROUTER-1d: Think harder is a row of the + menu on a phone.** One row in the capability dock's own
markup, which is PHONE-CONSOLE-1's pattern and the same markup at both widths, so nothing is wired
twice; `display: none` above 690 px, where the composer's own switch is right there; drawn at 690 px
and below, where ROUTER-1 hides that switch. It carries **no `data-capability`**, deliberately:
app.js closes the sheet on any press that has one, and a switch a person has just flipped should show
its new state rather than take the menu away. There is one piece of state and the row is not it: the
row presses `#think-harder`, the checkbox `gateway-adapter.js` listens to, and fires that checkbox's
own `change`, so the phone and the laptop cannot hold two different answers. The row is read again
every time the menu opens, because the adapter writes that checkbox directly on a conversation switch
with no event on that path to follow. The desktop switch is untouched in markup, in CSS and in
behaviour.

## What was measured

```
node --test tests/machine-room-voice.test.mjs tests/machine-room-gateway.test.mjs
```

```
# tests 130
# suites 0
# pass 130
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 32714.290791
```

`# skipped 0` is the point: both real-browser legs ran, on Chrome through playwright-core.
`node --check` is clean on `ui/machine-room/voice.js` and `tests/machine-room-voice.test.mjs`.

The seven new cases, all green:

```
ok - VOICE-15b call: the phone app's call screen has no message box, and a phone in a browser keeps one
ok - VOICE-15b ended: a call nothing was heard on says so, and never reads the provider's own words back
ok - VOICE-15b ended: the card reads back the person's own words, and drops what Titan said
ok - ROUTER-1d: on a phone the Think harder switch is a row of the + menu, pressing the one switch the adapter reads
ok - ROUTER-1d source: the row is in the + menu's own markup, with no capability and no second switch
ok - VOICE-15b source: the call screen's controls are ONE shape, and the hidden attribute really hides
ok - VOICE-15b in a real browser at 390x844: one shape, no message box in the app, and a card that says what was heard
```

### The boxes, at 390x844 in Chrome, after

| state | control | box | radius | label inside it |
|---|---|---|---|---|
| live, in the app | Speaker / Earpiece | 72 x 50.19 at 75,769.81 | 16px | Earpiece 45.59 px, 0 px cut |
| live, in the app | Mute | 72 x 50.19 at 159,769.81 | 16px | 26.5 px |
| live, in the app | End | 72 x 50.19 at 243,769.81 | 16px | 19.92 px |
| live, in the app | the message box | **0 px, not drawn** | | |
| the line is down | Try again | 72 x 50.19 at 117,769.81 | 16px | 48.05 px |
| the line is down | End | 72 x 50.19 at 201,769.81 | 16px | 19.92 px |
| the line is down | Mute, speaker toggle | **0 px, not drawn** | | |
| a plain browser | the message box | **190 px** | 22px | |
| a plain browser | speaker toggle, Try again | **0 px, not drawn** | | |
| the ended card | nothing heard | 187 x 49.09 | | "The call ended. Nothing was heard." |
| the ended card | with words | 187 x 66.64 | | "The call ended. You said: ..." |
| ROUTER-1d | the + menu's row | 360 x 44 at 15,680 | | reachable at 195,702 |

Asserted rather than only printed, in every one of the three call-screen states: each drawn control is
at least 44x44; all of them share a width, a height and a border radius; each label's box is inside
its control's with 3 px of clearance on both sides and above the bottom edge, and is cut by 0 px; no
two controls overlap; the page does not scroll sideways; and a thumb landing where the console's
message box is hits the call screen rather than the composer, which is the other half of "the call
screen is the whole surface".

### Desktop, byte for byte

The suite's desktop measurements were compared against a clean extract of the branch tip
(`git archive HEAD ui tests`), run on this Mac minutes apart. Identical, to the character:

```
VOICE-2 at 1440x900: the line costs the message box 82.56 px (269.64 -> 187.08), nothing else in the footer moves, and the sentence is whole
VOICE-2 at 390x844: the line takes 68% of the shelf's width, the shelf grows 56 px (133 -> 189), the composer stays 358 px, the talk button is 44x44, the action is {"width":253,"height":44}
VOICE-7 at 390x844: the agent's reply costs the shelf 0 px
```

The composer keeps its five tracks at every width and the message box its 269.64 px at rest: the new
menu row is in the capability dock, not in the composer, and it is `display: none` above 690 px.
`tests/machine-room-mobile.test.mjs`, `machine-room-transcript-pin`, `machine-room-onboarding`,
`machine-room-boot`, `machine-room-settings`, `console-app-hooks`, `asset-cache`,
`ui-views-render`, `machine-room-markdown`, `machine-room-allowance` and `publication-bootstrap`
are 182 pass, 0 fail between them.

## What only a phone can prove

- **WebKit is not Chrome.** The emoji glyphs (`🔊`, `Ⓩ`, `↻`, `✕`) are laid out by the engine, and a
  glyph wider on iOS than here would change the row's height and nothing else, because the controls
  are a fixed width with a nowrap label. The safe-area insets are `env()` values a headless Chrome
  reports as 0; the screen's own padding already uses `max(18px, env(...))` at the bottom, so the row
  moves up on a real phone rather than resizing. Neither is measured here.
- **That a thumb can hit these.** 72 x 50.19 clears the 44 px floor this console enforces, and
  `elementFromPoint` at each centre lands on the control. A real thumb on a real phone is Jason's.
- **The card's own claim, on a call that really heard something.** The unit case drives a real frame
  of sound through the real capture path (2400 samples at 0.5, an RMS of 0.5) and the browser leg
  drives a call that heard nothing at all, which is build 17's call exactly. What no test here can
  produce is a provider transcribing its own greeting onto a real line.

## NEEDS AN OWNER, two of them

**1. The relay is where "them." came from, and it is not fixed.** This wave stops provider text
reaching the ended card as the person's words. It does not stop the relay sending it: on build 17 a
call with 0 s of audio in produced a `heard-confirmed` frame, and that frame is written in
`ui/voice-edge.mjs`, which another worker holds tonight. The same string still reaches the LIVE
speech panel mid-call (VOICE-7's overlay is deliberately untouched here, because gating it on the
microphone would break cases that drive frames with no capture in a fake window), and, more
importantly, still reaches the agent's own conversation as a user turn. Owner: the voice-edge wave.
Next action: in the vendor map, prove that no `response.output_audio_transcript.*` event can reach
`makeCaption` or the `heard`/`heard-confirmed` path, and drop a confirmed transcript for a turn whose
inbound audio was 0 ms. My page-side guard and its two numbers (`sent`, `micPeak`) are published on
`stats()` for that work to read.

**2. `docs/VOICE.md` sections 14 and 15 now describe a screen that changed.** Section 14 says the
call screen has "a row at the bottom with somewhere to type" without saying that the app no longer
does; section 15 says the toggle and the route line are styled from styles.css, which is no longer
true. That file is outside this worker's declared files and another wave may be in it tonight, so it
is filed rather than edited. Owner: whoever lands the next voice wave. Next action: one paragraph in
section 14 for the app's typed row and the one-shape control rule, and one line in section 15 moving
the CSS home to voice-call.css.
