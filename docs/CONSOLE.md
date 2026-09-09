# The console, from the first pixel

*Gap row CONSOLE-4. Four things Jason reported on 2026-09-08 about console.titanium.bot, each
fixed at its cause rather than papered over.*

This file is written in four sections because the wave was built by four people against one set of
seams. Section 1 is the boot: the plate, the cover, and the transcript that settles. Sections 2, 3
and 4 are the badge, the screen tile and the file viewer, each owned by the item that built it.

---

## 1. Boot

### The plate, before the first pixel

Jason: *"When the page loads, console.titanium.bot initially shows the original background with the
mountains, then reloads with whatever background the user chose."*

The choice was never wrong. `backgrounds.js` has answered the nebula since 5637e4b and the relay
serves that byte for byte. The bug was load order: `index.html` chained
`__bootMachineRoom` → `app.js` → `backgrounds.js`, so nothing set `data-bg` until fourteen serial
gateway round trips had finished, and `styles.css` painted `assets/warmwind-landscape.svg` for the
whole of that.

So the plate is now decided by one file that runs before anything paints.

| Step | Where |
|---|---|
| `<script src="bg-boot.js">` in `<head>`, **before the first `<link rel=stylesheet>`** | `index.html` |
| reads `machineRoom.background` in a try/catch, falls back to the default | `bg-boot.js` |
| stamps `data-bg` and `--machine-room-bg` on `<html>` | `bg-boot.js` |
| the plate itself | `backgrounds.css`, scoped to `html[data-bg]` |
| the floor, for a browser with no plate at all | `styles.css`, flat brand Midnight |

Three rules that are load-bearing and easy to undo by accident:

- **The script goes before the stylesheet links, not after.** A classic script placed after a
  `<link>` waits for that stylesheet to load before it executes, which is exactly the cost this
  removes.
- **The default, the built-in list and the id-to-file rule live only in `bg-boot.js`.**
  `backgrounds.js` reads them off `window.__mrBg`. Two copies means a plate added to one of them
  flashes twice, which is worse than the bug being fixed. A test pins that the literal
  `titan-nebula` appears exactly once across the two files, and the default is read off the entry
  marked `default: true` rather than written a second time.
- **`machineRoom.backgrounds.custom` is read only when the chosen id starts with `custom-`.** That
  array holds data URLs up to 4,000,000 bytes; `JSON.parse`ing it unconditionally in `<head>` would
  block the first paint by the cost this whole arrangement saves.

`apply()` sets `data-bg` for **every** id, `original` included. It used to remove the attribute for
`original` and let the stylesheet's own mountains stand in as the default — which is why a browser
with nothing stored, and a browser whose storage throws, opened on a photograph. Picking Original
still gives the mountains, through `html[data-bg="original"]` in `backgrounds.css`.

**Measured on `grok-bot-local-vm` (this Mac), warm box, over loopback, sampling the shell's computed
background every 25 ms:**

| | before | after |
|---|---|---|
| mountains on screen, nothing saved | 1,247 ms | 0 ms (220 samples) |
| mountains on screen, `habitat-3` saved | 861 ms | 0 ms (220 samples) |
| `data-bg` at `readyState === "interactive"` | not set | the chosen id |

### The picker's series headings

Jason: *"Two of the backgrounds come up and you can't see them ... One just says 'The Lab', the
other one just says 'Habitat' ... they're just blank spots."*

They were headings wearing a tile's box. `backgrounds.js` drew each series name as a `<p>` carrying
an inline `flex-basis:100%`, and `.bg-grid` is `display:grid`, where `flex-basis` does nothing. Each
heading took one cell in the run of tiles. Measured before, on `grok-bot-local-vm`: "Habitat" and
"The Lab" each **185 x 104**, one tile's cell, between two real tiles. After: **776 x 23**, the full
grid width, with a hairline under it. The span lives in `backgrounds.css` (`grid-column: 1 / -1`),
where the grid is; the inline style is gone.

### The cover

Jason: *"Is there a way that, when you first load the page, you see a sprite or something like a
loading console, then it loads everything in the background, and then, boom, everything is as it
should be?"*

`#boot-cover` is **static markup, the first child of `<body>`**, so it is on screen with the first
paint rather than after a script has decided to draw it. It holds the crew's Titan sprite (the
kit's own still, which needs no script; upgraded to a live `<titan-mascot>` once the element is
defined and the person has not asked for less motion), the line *Setting up your console*, a step
line, and a progress hint that is a hint and not a percentage — nothing here knows how far along the
boot is.

It is opaque over the whole shell on purpose. `index.html` ships seed copy — "MSP Team",
"3 members · ready", "2h 14m", "Atera Triage's desktop" — which is fiction on a real box and was all
on screen at 500 ms on a box that has none of it.

**When it lifts** is a pure function of four things, in `index.html`'s own IIFE:

```
shouldLiftCover({ roster, rows, demo, elapsed })
  demo                -> lift now
  elapsed >= 8000     -> lift now
  roster && rows      -> lift
  otherwise           -> stay
```

- `roster` is the first `.worker-card`; seeing it also sets the step line to *Opening `<name>`*.
- `rows` is the first `.message-row`. The roster and the transcript are painted in the same
  synchronous `renderAll`, so a worker card on screen with an empty transcript means a conversation
  with nothing in it — which is how an empty conversation resolves without waiting out the ceiling.
- `demo` is `documentElement.dataset.demo`, set when the gateway was unreachable. The cover then
  says *This console could not reach this box* and gets out of the way, rather than sitting friendly
  on top of the red DEMO DATA bar it is about to uncover.

**The ceiling is a `setTimeout` armed at parse time and is never chained to `hydrate()`'s promise.**
`gateway-adapter.js` has no `AbortController` and no per-call timeout anywhere, and it awaits every
installed connector before it asks for the first conversation — BOOT-1 measured **46,318 ms** to
live with one cold stdio connector. A cover that waits on that promise is a cover that never lifts.
If the ceiling fires with no rows, the transcript column says it is still opening the conversation
rather than uncovering an empty page pretending to be finished.

Under `prefers-reduced-motion: reduce` the node is removed outright — no fade, no sprite pulse, no
transition to wait for. There is also a 900 ms belt on the `transitionend` listener, so a transition
that never fires cannot leave an opaque cover over the console.

**Measured on `grok-bot-local-vm`:** cover on screen at 50 ms, gone at **1,065 ms** with nothing
saved and **1,143 ms** with `habitat-3` saved. Ceiling never reached.

### The transcript that settles

Jason: *"The chat for Titan just scrolls forever."*

Two causes, and both had to go.

1. `renderTranscript` computed `wasNearBottom` and then threw it away: the condition was
   `(!keepScroll || wasNearBottom)`, and **every `message:created` arrives with `keepScroll` false**,
   so every stream tick dragged the reader to the bottom whatever they were reading.
2. `.transcript` carried `scroll-behavior: smooth`, so each of those writes was an animation across
   the full height of the conversation.

Ruled out by measurement, so none of them was touched: scroll-to-top paging (already on `wheel`,
fired zero times), image height shift (`scrollHeight` constant), the `foldRepeatedRows` rebuild.

The rule now:

> Follow a reader who is already at the bottom. Never move one who is not. Pin to the bottom once,
> for a deliberate event.

The pin is a module flag set at exactly three moments — first paint, a conversation change (both
`selectContext` and the adapter's `context:selected`, which is the palette's jump and the landing
after a create), and the reader's own send. It is spent by the render it fires on. `keepScroll`
stays in the signature and is deliberately no longer consulted; it distinguished nothing worth
keeping.

`scroll-behavior` is gone from the container. `flashEntry` opts back into `{ behavior: "smooth" }`
at its own call site, reading the reduced-motion query — that is the one scroll a person actually
asked for. `renderTranscriptKeepingOffset`'s restore is a direct assignment and is now instant,
which also removed the jump after *Show earlier messages*.

**Measured on `grok-bot-local-vm` in real Chrome, on Atera Triage (190 rows, 15,908 px in a 668 px
viewport), reader parked and left alone for five seconds:**

| | before | after |
|---|---|---|
| drift | 5,334 → 15,164 (**9,830 px**) | 5,334 → 5,334 (**0 px**) |
| frames in motion | **27.9 %** of 301 | **0.0 %** of 301 |
| *Show earlier messages* | 5,334 → 28,177 (thrown to the foot) | 7,620 → 20,557 (held on the line) |
| reader parked at the foot | still followed | still followed |

### The seams

Item A is the only editor of `index.html`, `app.js`, `gateway-adapter.js`, `styles.css`,
`backgrounds.js` and `backgrounds.css` in this wave. It lands its own fixes and installs the seams
the other three plug into as sibling modules, so they never open a contended file. This is the
console's existing pattern — `window.__marketplaceBots`, `window.__titanMascots`,
`window.__machineRoomHandoff`.

| Seam | Filled by | Falls back to |
|---|---|---|
| `window.__mrUi = { openPanel, paragraphMarkup, maskSecrets, escapeHtml, renderAll }` | published by `app.js` | — |
| `window.__mrBg = { CHOICE_KEY, CUSTOM_KEY, DEFAULT_CHOICE, BUILT_IN, urlFor, apply }` | published by `bg-boot.js` | — |
| `__gapBadge.render(rows, messageMarkup, { agentId, working })` | `gap-badge.js` | `rows.map(messageMarkup)` |
| `__gapBadge.toggle(el)` via a delegated `[data-gap-toggle]` listener | `gap-badge.js` | no-op |
| `__screenTile.frameFor(agentId)` / `.sync({ agentId, seat, status, visible })` | `screen-tile.js` | the hand-off's own frame, then a plate |
| `__filesViewer.open({ path, agentId, name, download })` | `files-viewer.js` | no-op |

Every seam is exercised in `tests/machine-room-boot.test.mjs` **with its module absent**, because
item A merges before items B, C and D exist. The three modules load beside `marketplace-bots.js`,
ahead of `app.js`, because `app.js` consults all three inside its first `renderAll`.

### The adapter's data shapes

Four changes in `gateway-adapter.js`, all inside their own function bodies because that file is
contended.

- **`toolRowText` returns `kind`**, taken from the `TOOL_LABELS` table and never re-parsed from the
  row's text — a shell row headlined *Wrote notes.md* still reports `Shell`.
- **`messagesOf` carries `kind` on tool rows and `timestampMs` on chat rows.** `time` is already
  formatted for a person and cannot be subtracted. No tool row carries a timestamp of any kind, so a
  badge can only give a duration where both bounding chat entries exist.
- **`filesOf` and `isAttachmentEntry` read the `{type:"text", images:[{url, alt}]}` carrier**, which
  is what SendMessage's own schema tells the model to use and how ten of Titan's eleven transcript
  files actually arrive. Nothing read `.images` anywhere before, which is why a list of eleven files
  showed one. Every path returned goes through `localPathOf`: the host answers `null` for the
  `file://` form and the file for the bare path. A message carrying several files renders a figure
  for each (`attachments`), and keeps its own sentence.
- **The outline is refetched while an agent is working**, once the held copy is older than 5 s. An
  agent doing tool calls writes no transcript entry, so the tail signature does not move and the
  cache answered the same outline for a whole turn — a badge with nothing to move in it. The cache
  is kept, not dropped: the `/events` tick is debounced at 900 ms and the long agent's outline is
  1,578 items.

---

## 2. The between-chats badge

*Owner: CONSOLE-4 item B. `ui/machine-room/gap-badge.js`, `gap-badge.css`.*

To be written by item B. The seam and the two facts it has to build around are in the header of
`ui/machine-room/gap-badge.js`.

---

## 3. The rail's screen tile

*Owner: CONSOLE-4 item C. `ui/machine-room/screen-tile.js`, `screen-tile.css`.*

The broken image itself is fixed and is section 1's work, so it is recorded here:

Jason: *"The Titan screen at the top right says 'Click to open,' but there's a broken image there."*

`renderScreenTile` always emitted the `<img>` and marked it hidden — and
`.rail-screen-button img { display: block }` outranks the UA sheet's `[hidden]` on specificity, so
Chrome painted its own broken-image glyph over the alt text. It is the same trap the
`.handoff-island[hidden]` rule one screen up in `styles.css` exists for. The tile now emits **no
`<img>` without a `src`**; with no frame it is the plate alone, which says what clicking does.
`styles.css` carries `.rail-screen-button img[hidden] { display: none }` so the trap cannot be
re-set by a later edit.

**Measured on `grok-bot-local-vm` across the first eight agents on the box:** before, **8 of 8**
tiles carried an `<img>` with `src` null, `naturalWidth` 0 and computed `display: block`. After,
**0 broken, 8 plates**.

The picture behind it is item C's, and its three load-bearing controls are in the header of
`ui/machine-room/screen-tile.js`.

---

## 4. The file viewer

*Owner: CONSOLE-4 item D. `ui/machine-room/files-viewer.js`, `files-viewer.css`.*

The controls are in place and are section 1's work:

Jason: *"If I go to his desktop and click Files, it shows me files we've created, but I can't click,
open, or view it."*

The desktop's file tile was a `<div>` with no handler anywhere. Every row is a `<button
data-file-open>` now, a transcript attachment carries `Open` and `Download`, and all three route
through one delegated funnel to `window.__filesViewer.open`, so a file cannot open one way from one
list and another way from the other. The Files panel copy no longer claims the host keeps no
per-worker directory: that is true of `/workspace` and false of the attachments every row in that
list actually lives in.

**Measured on `grok-bot-local-vm`:** before, rows were `DIV`, `cursor: auto`, 0 of 2 carrying a path.
After, `BUTTON`, `cursor: pointer`, 2 of 2 carrying a bare path, both transcript controls
hit-testable to themselves.

The viewer is item D's, and what it may and may not open is in the header of
`ui/machine-room/files-viewer.js`.

---

## Gates

| Gate | What it covers |
|---|---|
| `node --test tests/machine-room-boot.test.mjs` | the plate, the floor, the series headings, the cover's lift decision, the scroll table, the four seams with their modules absent, the adapter's data shapes |
| `node --test tests/titan-crew.test.mjs` | `backgrounds.js` still publishes the list the console knows it by, loaded the way the browser loads it |
| `node --test tests/machine-room-transcript-fold.test.mjs` | DASH-FOLD-1's fold still runs before the badge sees the rows |
| `scripts/verify-console-polish.mjs` | the browser legs, on `grok-bot-local-vm` and then read-only on Jason's console |
| `scripts/verify-dashboard.mjs` | unchanged, and must stay green |

The ship is **relay-only by construction**: everything in this wave is `ui/`, tests, scripts and
docs. `git diff <pre-wave>..HEAD -- source/ deploy/` must be empty before shipping. If it is not,
stop and re-scope — a host swap is a different ship with a different risk.
