# The console, from the first pixel

*Gap row CONSOLE-4. Four things Jason reported on 2026-09-08 about console.titanium.bot, each
fixed at its cause rather than papered over.*

Five sections. Section 1 is the boot: the plate before the first pixel, the cover, the picker's
headings and the transcript that settles. Then the between-chats badge, the rail's screen tile and
the files viewer, and last the gate that measures all four in a real browser.

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
- **`backgrounds.js` guards `window.__mrBg` before it destructures it.** Reading the constants from
  one file coupled the picker to that file loading, and the destructure was at module top level:
  measured on `console.titanium.bot` on 2026-09-08 with only `bg-boot.js` blocked in the browser,
  the page threw *Cannot destructure property 'CHOICE_KEY' of 'boot' as it is undefined* and
  **Operator settings opened with no `.bg-grid` at all** — no way to pick a plate and nothing saying
  why, because the module's own `window.__machineRoomBackgrounds` publication is three hundred lines
  below the throw. The guard publishes an empty set under that name and puts one line where the tiles
  would be (*"The plate list did not load with this page …"*). Deliberately **not** a fallback copy of
  the default and the list: that is the second copy the rule above exists to prevent.

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

It is opaque over the whole shell on purpose, and **the shell under it now ships blank**. It used to
carry design copy in every field a person reads — "MSP Team", "3 members · ready", "2h 14m", "Ask MSP
Team…", "Atera Triage's desktop" — which is fiction on a real box, and another company's product name
in a paying customer's markup. An opaque cover hides that for as long as it is up, and no longer:
measured on `console.titanium.bot` on 2026-09-08 with `/api/**` stalled in the browser only,
`__bootMachineRoom()` never resolved, so **app.js never loaded at all**, the cover came off at its
ceiling at **8,675 ms**, and at 14 s the page still named that team, that agent and that routine with
nothing saying anything was wrong. `#room-title`, `#room-subtitle`, `#capability-scope`,
`#desktop-capsule-scope`, `#next-routine-countdown`, `#next-routine-label`, `#desktop-title`, the
`.desktop-live` line and the composer's placeholder are all empty in the markup and filled by
`app.js`; a test pins that none of them ships words. Do not put copy back in them.

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
What the lift uncovers depends on what was drawn. Roster and rows both there: the real console,
nothing written. Roster there, rows not: the transcript column says *Still opening this
conversation…*. **Neither**, which is the stalled boot above: the transcript says *Still reaching this
box. Nothing on this page has loaded yet.* and the room capsule reads *Still connecting · this
console has not reached your box yet*. In the `demo` case the red DEMO DATA bar already says the box
was not reached, so the cover does not say it a second time.

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

> "All the shell commands and everything that happens in between chats, while the agent is doing
> work, can live inside a badge, right? If I want, I can click the badge to expand it or just leave
> it shrunk inside the badge."

Everything between two chat messages folds into **one badge per gap**, collapsed by default.

**The gap predicate is nearly one line**, because the vocabulary is smaller than it looks. Every
between-chats row is type `system` in three shapes: a plain tool row, a `SHOT-4` receipt row, and a
Messaged row. Every card that must stay outside the badge — decision, secret, connector, hand-off,
turn-failed, attachment, the working bubble — is **already another type**, so "never hide a card"
needs no special casing at all. Evidence chips render inside the reply's own row.

The one thing `type === "system"` alone got wrong is that **the adapter also speaks to the person in
system rows**: `notWired` ("… is not wired to the gateway yet."), `failed`, the send-failure push
("Sending failed: …") and the connect-approval push. Those are messages, not work, and the first
build folded them into the body with nothing in the headline counting them. A step is nobody's
message — no tool row and no exchange row carries an author — and all four notice sites stamp
`authorId: "system"` / `authorName: "Machine Room"`, so `isChat` reads the author: a system row that
names one ends the gap and is drawn where the person can read it.

**The head** reads like `Worked for 2 min · 14 steps` with the kinds summarised (`6 commands, 5
files read, 3 browser steps`). The words are a table in `gap-badge.js`, not the `kind` field: that
field is `TOOL_LABELS`' label lowercased, or the tool's own name with `ToolCall` cut off it, so
printing it raw put `shell 4, websearch 3, webfetch 1` on Jason's own console. Anything the table
does not know prints its kind unchanged rather than being guessed a plural. Where both bounding chat
entries exist the badge says the span; where one is missing it says the step count alone. It cannot
do better: **no tool row carries a timestamp of any kind**, and `messagesOf` keeps only a
minute-resolution string.

**Open by click, and the preference sticks.** `button.gap-badge-head[data-gap-toggle]` carries
`aria-expanded`; the rows appear in a sibling `div.gap-badge-body[aria-live="off"]` exactly as they
render today, so receipts stay one click away (`SHOT-4`). `DASH-FOLD-1`'s step-count folding lives
inside the expanded view, unchanged.

**The preference is this browser only.** It is a `localStorage` key per gap anchor, not a host
setting, and it does not follow the person to another machine. Badge state cannot live in the DOM:
measured on a working turn, `#transcript` was wiped **five times in 36 s** and an opened receipt
snapped shut within 2 s.

**The live gap stays open while the agent works** and collapses when the reply lands, so the person
sees it move. One known limit behind that: `loadContext` caches the outline on the transcript tail
signature, and an agent at work writes no transcript entry — measured, **7 shell steps over 48 s
added zero rows and all landed in one paint**. The adapter refetches the outline while the record's
status is `working` and the last read is older than 5 s, which is what makes the live gap move at
all.

---

## 3. The rail's screen tile

The broken image and the picture behind it were two separate faults. The markup fault first:

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

> "The Titan screen at the top right says 'Click to open,' but there's a broken image there. I think
> that's supposed to be a screenshot of what's on the browser at that moment."

He was right about what it is for, and there were **two causes** behind the one glyph.

**Cause one, the glyph itself.** `renderScreenTile` always emitted the `<img>` and marked it
`hidden`, while `styles.css` says `.rail-screen-button img { display: block }`. That is one class and
one type; the UA sheet's `[hidden] { display: none }` is one attribute, so the display rule won, the
element went on being laid out, and **an `<img>` being laid out with no `src` is exactly where Chrome
paints its own broken-image glyph and the alt text**. Measured on his console 2026-09-08 on Titan's
tile: `hidden` true, computed `display` block, no `src`, `naturalWidth` 0, a **231x75** box.
Reproduced on `grok-bot-local-vm` the same day at **231x86**.

Two halves to the fix, and both shipped: `renderScreenTile` emits **no `<img>` at all until it has a
frame**, and `screen-tile.css` carries the belt — `.rail-screen-button img[hidden]`, `img:not([src])`
and `img[src=""]` are all `display: none` — so no future path can re-open the trap whatever `app.js`
emits. The same stylesheet already carries exactly this belt one screen up for
`.handoff-thumb[hidden]` and `.handoff-island[hidden]`.

**Cause two, there was nothing to show.** `HANDBACK-1`'s reader only ever mounts while a hand-off is
**pending**, so an idle agent — which is what Titan is nearly all day — had no frame in memory, none
in storage, and no client running to make one. `ui/machine-room/screen-tile.js` is that half.

### The seat

The host answers which screen an agent is on. **`getForeverBoxStatus` takes `{ id }`, never
`{ agentId }`** — this is the trap in this whole area and the gate asserts it rather than trusting
it. The host adds `boxSeat` only when it has an agent to add it for, so the `agentId` form answers a
stub with **no `boxSeat` field at all**, and a probe using it would conclude the host cannot say
which screen anyone is on. Measured on `grok-bot-local-vm` 2026-09-08:

| asked | answer | `boxSeat` |
|---|---|---|
| `{ id }` | 289 B | `3` |
| `{ agentId }` | 71 B | **the key is not there** |

Three answers, three behaviours:

| `boxSeat` | means | the tile |
|---|---|---|
| a number above 1 | the agent's own seat | a picture of that display |
| `null` | no seat of its own, which **is** the shared screen | a picture of display 1, captioned as the shared screen |
| the field is absent | this host cannot say | **nothing is drawn**; the plate says so |

A wrong screen is worse than no screen. That is the same rule `HANDBACK-2` set and the reason the
absent case draws nothing rather than guessing display 1.

### The reader's life

`window.__screenTile.sync({ agentId, seat, status, visible })` owns one hidden `view_only` noVNC
client, built exactly the way `boxHandoffEnsureThumb` builds one: off-screen at a real 1280x800
framebuffer size (noVNC scales what it is given, and a 1px client hands back a 1px picture), on the
**page's** origin through the relay's `/vnc/<display>/` proxy, and `vnc.html` rather than `vnc_lite`
because the lite client ignores `resize=scale` and paints the top-left corner only.

Five rules, each one load-bearing:

- **One reader at a time.** `HANDBACK-1`'s reader owns the agent while a hand-off is pending; this
  one stands down for it (read through `window.__machineRoomHandoff.screen().readerDisplay`) rather
  than opening a second websocket to the same seat.
- **Three cadences, not a still.** See *The tile keeps up* below. `CONSOLE-4` shipped this module
  with a rule called **a still by default** — one frame for an idle agent, then let the client go —
  and `SCREEN-TILE-1` reversed it on Jason's ask. The half of that rule that survives is that an
  idle agent is **photographed and never streamed**.
- **Never torn down on a render that merely carried no display.** The roster is rebuilt from
  `listAgents` and the box status is a separate read, so a record is briefly seatless between the
  two. Tearing down there restarted noVNC's handshake on every heartbeat and took the first frame
  from about **1.4 s to 33 s**.
- **A hidden tab drops it to zero.** A paused desktop dialog does not: that is a pause, because the
  dialog closes in seconds and remounting costs the handshake again.
- **A frame that cannot be told from blank is refused.** A client caught mid-handshake paints a white
  rectangle, and a confident white rectangle reads worse than a plate. The first sample on Titan's
  seat was **1,043 characters of solid white**; the next was **7,591 of the real desktop**. Length
  alone is a weak test — a genuinely dark screen compresses small too — so the guard reads the
  **colour spread off the thumbnail's own pixels** before it encodes, and needs both: at least 2,048
  characters and a luminance spread of at least 10 out of 255.
- **A picture nobody can click never holds the keyboard** (SEAT-FOCUS-1). See below.

### The seat's keyboard (SEAT-FOCUS-1)

**A picture nobody can click never holds the keyboard. The pane a person opened does.**

There are two off-screen readers — `screen-tile.js`'s (`[data-screen-tile-source]`) and `app.js`'s
hand-off thumb (`[data-box-handoff-thumb-source]`). Both are 1280x800 noVNC clients parked at
`left: -10000px` with `pointer-events: none`, `opacity: 0`, `aria-hidden` and `view_only=1`. About two
seconds after every mount the client focuses its own canvas and `document.activeElement` becomes the
**iframe**: from that moment every document-level key goes into the frame and never reaches the page.
MEASURED on grok-bot-local-vm in real Chrome at 1440x900, 2026-09-10: with a reader focused, a real
Escape and a real space bar produced **zero** keydown events on a capture-phase listener on `document`,
so `voice.js`'s handlers never ran — **Escape did not leave talk mode, the space bar did not talk** —
and an **open desktop dialog did not close on Escape** either. That last one is the seat's own frame
rather than a reader, and it is fixed separately under SEAT-FOCUS-1b below. Nothing was logged and
nothing on screen said why. An idle reader mounts, grabs and releases in about 2–3 s every 30 s and a working agent's
client is held for the whole turn, which is the one-in-three flakiness `verify-voice --leg nokey` had.

So `screen-tile.js` arms a **hand-back** for each reader frame it creates, and `boxHandoffEnsureThumb`
borrows the same function rather than keeping a second copy: if `document.activeElement` is that frame,
`frame.blur()`. Two things drive it, because one of them is not always available:

- a `focusin` listener installed on the **frame's own document**, which is readable because both
  readers build their `src` on `window.location.origin` — the reader is **same origin by
  construction**. In a harness this handed the keyboard back before a poll saw anything at all.
- a **250 ms poll** for the frame's lifetime, which catches the steal within a quarter second. It stays
  even though the listener works: if a future image ever served the client from the box's own address
  the listener would silently stop installing, and this is what is left.

Three things the filed row had wrong, each measured rather than argued: the thief is the off-screen
**reader**, not the desktop dialog's seat; the frame is **same origin**, not cross-origin; and the
mechanism it proposed — a `focus` listener on the iframe element — **does not fire at all** for a focus
that lands inside the frame (0 in the product, 0 in an isolated harness; `inert` on the frame does not
stop the steal either). `blur()` is enough and it sticks — `activeElement` stayed `BODY` for 14 s and
the client never took it back, which is narrower than the blanket claim beside `app.js`'s teach frame:
that one holds for a frame a **person** clicks, whose pointer events re-focus it.

**Scoped to those two attributes and nothing else.** The seat inside the desktop dialog
(`iframe[data-box-vnc]`) is the pane a person opened, is meant to hold the keys, says so in its own copy
("⌘/Ctrl + V pastes into the box while this pane has the keyboard"), and the paste bridge depends on it.
Because the readers are unreachable by any pointer the rule needs no "unless the person put it there"
exception — which is just as well, since a **pointerdown inside an iframe is invisible to the parent
document**, so that exception could not have been implemented for an interactive frame anyway.

**MEASURED on grok-bot-local-vm, real Chrome 1440x900, 2026-09-10, `verify-console-polish --keys`
7 of 7 with a reader held on Chief of staff's seat (:6):** the reader took the keyboard and was handed
it back inside the first read (**2 hand-backs** over the run, poll every 250 ms), **20 of 20** real
`keyboard.press("Escape")` reached a capture-phase listener on `document`, `document.activeElement` was
**never an iframe across 24 samples**, a real space bar reached the module and opened the line, and
Escape then left talk mode. `--tile-live` in the same pass: the tile still followed a real page change
in **1.01 s** (1.81 s counting the gate's own `docker exec`) for **120.5 KiB over 86 websocket frames**,
so the hand-back costs the picture nothing.

**And MEASURED on the live R750 demo tenant 2026-09-11 01:26 UTC** through `console.titanium.bot` as a
throwaway customer (minted for the run and removed after it), real headless Chromium at 1440x1000, user
agent `titanbot-gate/ship-seat-keyboard`: `window.__screenTile.keepKeyboardOff` is on the page with the
poll at **250 ms** and both reader attributes published; a reader mounted and **1 hand-back** was
recorded; `document.activeElement` was **never an iframe across 31 samples** and read `BODY` at the end;
and **20 of 20** real `keyboard.press("Escape")` reached a capture-phase listener on `document`. A real
space bar also reached the document there and opened nothing, which is correct on that tenant and worth
saying plainly: `GET /voice/settings` answers `enabled: false, available: false` for the demo workspace,
so there is nothing for the space bar to open. What the run proves is the thing SEAT-FOCUS-1 is about —
the keys reach the page instead of disappearing into a picture nobody can click.

`window.__screenTile.handBacks()` counts them, and `state().handBacks` carries the same number, so a
gate can prove it **reproduced** the steal rather than measuring an empty page. That matters: one run
in the reader pass had no reader on the page during the Escape loop and reported 20 of 20 with the
defect present and unfixed.

### Escape still closes the agent's screen (SEAT-FOCUS-1b)

**The seat keeps every key except the one that is the pane's own way out.**

The hand-back above is scoped to the two off-screen readers on purpose, so it never touched the seat in
the desktop dialog, and that left one of the symptoms listed above still live. A `<dialog>` closes on
Escape only when the key reaches the document the dialog is in, so once the seat connected there was no
keyboard way out of the agent's screen at all. MEASURED on grok-bot-local-vm in review, 2026-09-11: with
the dialog open and its seat connected, `document.activeElement` was the `[data-box-vnc]` **iframe**, a
real Escape reached a capture-phase listener on `document` **0 times**, and the dialog **did not close**.

The fix is the reach-in `keepKeyboardOff` already uses, pointed at this frame: the seat's `src` is built
on `window.location.origin`, so its document is readable, and `openDesktop` installs a **capture-phase
`keydown` listener on the seat's own document** that closes `#desktop-dialog` on **Escape and nothing
else**. It is re-installed by a 250 ms poll for as long as the pane is open, because the client's
document arrives after the mount returns and the frame is replaced whenever the display changes, and it
goes out on the dialog's `close` event however it was closed. Every other key, the space bar included,
stays with the box, which is the whole reason this frame is exempt from the readers' rule.

**And the keyboard is handed back when the pane closes**, which is the half one machine would have got
wrong. On grok-bot-local-vm the browser did it on its own inside a quarter second and a `blur()` at the
`close` event fired against `BODY`. On the **live R750**, at the same commit with the same gate, through
`console.titanium.bot` as a throwaway customer, `document.activeElement` was **still the
`[data-box-vnc]` frame six seconds after the pane closed** and the next real Escape reached the page's
own document **0 times**, so talk mode could not be left at all. So the close handler hands it back
rather than hoping: `frame.blur()` now, and again on a 250 ms poll for two seconds, because the client
can re-focus its own canvas after the dialog has stopped being rendered. It is bounded, and it stops
early if the pane is opened again, because a frame nobody can see is not worth an interval for the life
of the page.

**MEASURED on grok-bot-local-vm, real Chrome 1440x1000, 2026-09-11, `verify-console-polish
--seat-escape`, 8 of 8, three runs in a row:** the screen tile hit-tests to itself (233x146), the pane
opens, the seat's client takes the keyboard (`activeElement` is the `data-box-vnc` frame, src
`/vnc/9/vnc.html`), **one** real `keyboard.press("Escape")` closes the pane while the page's own document
sees **0** Escapes, which is the proof the close came from inside the seat, the keyboard is back on the
page (`BODY`, **102 ms** after the pane closed) and the **next** real Escape does reach the page's
document, which is what leaves talk mode. Then a click inside the seat and an ordinary key
leave the pane open with the keyboard still in the frame, so working on the agent's screen is unchanged.
**With the fix switched off in the same tree the leg fails on exactly that check** ("the dialog stayed
open: the page's own document saw 0 Escape(s)"), so the leg measures the product and not the page.
`--keys` in the same pass still reads 7 of 7.

### The tile keeps up (SCREEN-TILE-1)

Jason, 2026-09-10 10:55:

> "The AI's desktop in the right-hand corner has a screenshot that does not stay up to date. It gets
> recorded once and stays that way. It never updates. For instance, Titan was on a different web
> page, but when I looked at it on my desktop, I saw the original web page it loaded with."

**Reproduced on `grok-bot-local-vm` before a line was changed.** 25 s after the box's browser moved
from `example.com` to `wikipedia.org` the tile still drew Example Domain and the frame string was
**byte-identical at 4,143 characters**, with no reader mounted.

**The cause was two lines and a stale key.** One dropped the client after a single good frame for
anything that was not `working`; the other then refused to mount at all for an idle agent that
already had a frame — and that frame is persisted under `mr-screen-tile-frame:<agentId>`, so it
survived reloads. "It gets recorded once and stays that way" is exactly what the code did.

**A third cause, found while building the fix and measured:** `renderScreenTile` preferred a
hand-off's frozen still over the live frame *unconditionally*. So for any agent that had ever handed
something back, every render put the old still back over the moving one, for ever — a 2,511-character
hand-off still re-painted over a 4,200-character live frame on every heartbeat. The frozen still now
wins only while the hand-off is **pending**, which is the case `HANDBACK-1` owns and the case where
this module stands down anyway.

**The three cadences.**

| | when | what it does |
|---|---|---|
| **live** | the record's status is `working`, **or** the newest tool row was a browser or desktop action inside the last 60 s | holds the client and captures every **3 s** |
| **idle** | anything else, with a conversation open and the tab visible | every **30 s**: mount, take one frame that passes the blank guard, release the client |
| **off** | a hidden tab, no conversation, a room, or `HANDBACK-1` holding the agent | no client, no wake, no caption clock. The desktop dialog is a **pause**, not a teardown |

**The activity half of "live" is load-bearing.** `status` is `agent.isRunning`, which is only ever
true *during* a turn — and Jason looks at the tile *between* turns. So `app.js` hands the newest tool
row over on the sync object (`activity`), the module stamps first sight itself (a tool row carries no
timestamp of its own; the outline they are woven from has none), and `Computer` or a shell row
headlined `Opened <host>` keeps the tile live for a minute. A `Fetched` row does not: `curl` changes
no screen.

**The idle wake is the module's own clock.** `sync()` only ever runs from a render and the adapter's
heartbeat is 15 s, so a cadence recomputed per render would be pushed back for ever and never fire.
`nextIdleAt` is an absolute timestamp with one `setTimeout` behind it; a render that arrives while it
is armed does nothing. There is a test named for that failure.

**The privacy rule, reversed on purpose and written down as a reversal.** `CONSOLE-4` made the still
a privacy decision, not a performance one: the seat read on 2026-09-08 had Gmail, a GitHub account
and a YouTube channel open on it, and a tile that keeps repainting an idle desktop is a standing
screen-share nobody asked for. Jason has now asked for the live tile, so the reversal is his. It is
**bounded rather than abandoned**: a working agent is watched, an idle agent is photographed every
30 s by a client that mounts, grabs and lets go. An idle agent is never a standing stream.

### What it costs

**Measured on `grok-bot-local-vm` (this Mac) at 1440x1000 in real Chrome via playwright-core, with
CDP websocket frame accounting, 2026-09-10.** `scripts/verify-cost.mjs` sums `Network.dataReceived`,
which is HTTP only — so these bytes are counted nowhere else, which is a reason to print them here
and not a reason to treat them as free.

| | measured |
|---|---|
| one mount to a real frame, `&quality=0&compression=9` | **17.5 KiB**, 1,267 ms |
| the same at the client's default quality | **51.9 KiB**, 1,275 ms |
| holding a client on a settled screen, 20 s | **0 bytes** |
| the tile following a whole page change | **3.56 s** from the launcher returning, **21.4 KiB** over 17 frames |
| a forced working minute | **6.2 KiB** to **137.1 KiB** across runs — it is whatever the screen did |
| an idle minute, one grab | **18.3 KiB**; at the steady two grabs a minute, **36.6 KiB** |
| one grab over a photo-heavy page | **75.0 KiB** |
| a hidden tab, 10 s | **0 bytes**, 0 readers |
| at 390x844 with the rail drawer shut, 8 s, agent held live | **0 bytes**, 0 readers |

The page-change latency is measured **from the moment `box-chrome` returns**, not from the moment the
gate reached for `docker exec`: that exec is the gate's own instrumentation, it measured 1.24 s on
this Mac, and an agent on the box calls the launcher directly and pays none of it. The full
gate-side number was 4.80 s. The tile's own share is bounded by the 3 s live cadence.

**The live cadence is bounded only by what the screen does.** A held client streams whatever is on it:
a settled screen costs nothing, a whole page change cost 11.7 KiB here and 323.7 KiB on a heavier page
during the design pass, and an agent watching a video would be unbounded. That is what the 600 KiB
working figure is for, and `--tile-live` prints the working minute against it every run.

`&quality=0&compression=9` on the reader's URL is what makes the 30 s idle cadence affordable, and
the 390x244 thumbnail is not visibly worse for it (4,207 characters against 4,263 at the default).
The desktop dialog's own client is untouched.

**What those numbers are not.** `docs/APPS.md`'s **100 KiB idle** and **600 KiB working** ceilings
are *decoded API bytes at 390x844, device scale 3, touch*, and they exclude noVNC **by name** as
`COST-2`. It publishes no desktop idle ceiling at all. The gate prints the tile against those figures
because that is the only honest way to say whether it is large, not because they are the same budget.
At two grabs a minute the idle tile is **36.6 to 37.7 KiB** of websocket on a settled desktop at
1440x1000 across runs, and a grab over a photo-heavy page measured 75.0 KiB, which at two a minute
would be over the phone figure on its own. **A grab is a whole framebuffer and costs whatever is on
the screen.** If Jason wants that number lower, the lever is the cadence, and the numbers to move it
with are in this table.

**These bytes are not added to the adapter's.** An earlier version of this paragraph and of the gate's
own INFO line summed the tile's 1440x1000 websocket bytes with the adapter's measured **56.1 KiB** idle
minute to get a "92.7 KiB all in" — but that 56.1 KiB is measured at **390x844**, the width at which
this tile's own measurement is **0 B**, so the sum described no machine. Both halves are now printed
with the viewport they were measured at and nothing is added across them.

**Where that ceiling really applies, this costs nothing.** At phone width the rails are drawers, and a
shut drawer is `visibility: hidden` and translated off the right edge — so the tile's **bounding box
still measures 274x172** and only `checkVisibility()` tells the truth about it. The module asks that
question and refuses to open a websocket for a picture the browser is not painting. Measured at
390x844 with the agent held **live** (which at desktop width is a client up 100% of the time):
**0 bytes over 8 s and 0 readers**, and a reader back within 15 s of the window returning to 1440.

**Two things the gate had to learn to measure this honestly**, both worth keeping in mind for any
later leg. Websocket accounting over a **short** window under-counts: CDP delivers frame events in
batches, and a 1.4 s window read 0 bytes while the minute after it read 101.8 KiB — so the byte claim
and the latency claim use different windows. And the screen has to be **settled** before "the frame
changed" can be attributed to the page: a held client re-encodes every 3 s and a caret blinking in a
URL bar moves the bytes on its own, so the leg reads the frame twice four seconds apart first and
prints whether it settled.

**The cheapest frame source is not reachable from the console.** A 390x244 frame taken inside the box
with `ffmpeg x11grab` costs **918 B in 315 ms** — about twenty times cheaper per frame than a VNC
mount. Nothing carries it: none of the 180 commands in `source/host/gateway-protocol.ts` captures a
screen, and the relay has no such route. Wiring one means a new route in `ui/server.mjs`, which
`SCREEN-TILE-1` did not own. It is filed on the row.

### How old the picture is

Every accepted frame stamps `capturedAt`, kept in a parallel storage key
(`mr-screen-tile-frame-at:<agentId>`) so the frame value and `HANDBACK-1`'s eviction index are both
untouched. A **refused** frame never moves the stamp, so the caption always dates the last picture a
person could actually see.

A one-second clock writes **"as of 3 s ago"** onto the picture — seconds up to a minute, then "a
minute ago", "2 min ago", "an hour ago". It is re-added after every render on purpose:
`renderScreenTile` rewrites the whole tile's `innerHTML` at least once a heartbeat, so a caption
emitted once would blink out and stay out. It is laid out **absolutely** over the bottom of the
picture, so it appears and disappears without moving a pixel of the rail, and it is never drawn over
a plate — a plate is the absence of a picture, not a stale one, and dating it would read as a picture
that failed to load.

### Storage

Idle stills live under their own prefix (`mr-screen-tile-frame:<agentId>`) and their own index,
capped at three. That separation is the point: `HANDBACK-1` evicts down to its newest eight by
walking **its** index, so a key that is not in that index can never be chosen for eviction, and a
hand-off frame a resolved card still draws from can never be pushed out by a tile still. A measured
idle frame is about 5.7 KB, so the two stores together sit near 63 KB.

### The plate

When there is genuinely no picture, the three wordings `HANDBACK-2` set are unchanged — "This
computer did not say which screen this agent is on", "Connecting", "Click to open this computer's
screen" — drawn on the product's own mark rather than a bare dark box: the Ti tile inline as a
data-URI SVG at low alpha, over a faint cyan halo on Midnight. Never the broken glyph, never an
empty `<img>`, and never "Connecting" when nothing is connecting.

### Two things the integration found, and both are in the module now

Folding the three items of console polish 3 together on one tree turned up two holes in the live
tile that neither builder could see alone. Both were found by a gate leg going red, both are fixed in
`screen-tile.js`, and both are pinned by a unit test whose title says where it came from.

- **The module kept a picture nothing could take away.** A frame lives in `localStorage` *and* in an
  in-memory `Map`, and only the storage half could be cleared from outside. So "this agent has no
  picture yet" — the state the plate exists for — was unreachable the moment the tile had painted
  once. `forget(agentId)` drops both halves and the agent's entry in the idle index. Nothing in the
  app calls it; the gate and the unit tests do, to set up that state honestly.
- **The plate never came back.** `paint()` hides the plate when it draws a picture, and nothing put
  the words back. An agent with no picture in hand therefore kept the **last** picture on the glass
  until `app.js` happened to re-render — and for an agent whose card never opened, never. A `sync()`
  with nothing in hand now removes the stale `<img>` and shows the plate again. The `<img>` is
  removed rather than hidden, because `.rail-screen-button img { display: block }` outranks `[hidden]`
  — the same CONSOLE-4 broken-glyph trap, one file over. With no plate span to put back (`app.js`
  emits one only when it rendered without a frame) nothing is touched: an empty tile reads worse than
  a picture a few seconds old, and the next render rebuilds it anyway.

### What clicking it does

Clicking the tile opens the desktop view. **That click is a write** — `data-handoff-action="open"`
reaches `mountBoxSurface`, which POSTs `/box/launch` and opens an app on the agent's seat — so the
gate leg that proves it runs on the local box only and is refused outright in read-only mode against
a live console.

---

## 4. The files viewer

The dead click first, because it is what Jason actually put his mouse on:

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

> "When there is a file and I click Files, like when Titan created a Markdown file for me, I can't do
> anything with it. If I go to his desktop and click Files, it shows me files we've created, but I
> can't click, open, or view it. If I click Files in the top nav, it shows Titan Files, but I can't
> click it to open it."

**Three breaks in one path**, and wiring a viewer onto the old list would have shipped a button that
opened 1 file of 11 and then failed on it.

1. The file tile was a plain `<div>` with no handler.
2. `filesOf` counted only `message.type === "attachment"`, while **10 of Titan's 11 transcript files
   ride the `{type:"text", images:[...]}` carrier** that `SendMessage`'s own tool description tells
   the model to use — and nothing in `ui/machine-room` read `.images` anywhere.
3. `filesOf` stored the raw `file://` URL, for which the host answers `null` (4 bytes on the wire)
   while the bare path answers 2,712.

**No new gateway command was needed.** `readAttachmentText`, `readAttachmentChunk` and
`readAttachmentImage` already exist, are wired through `gateway-protocol.ts`, carry a real path
check, and were measured live on Jason's box returning `rsi-vs-agi-notes.md` in **165 ms cold and
52 ms warm**. That is what makes this wave a relay-only ship: no `source/` change, no host bundle, no
`updateHostNow`, no box touched.

**The viewer.** `openPanel` is the modal the evidence and exchange viewers already use.
`paragraphMarkup` already renders headings, bullets, numbered lists and inline marks, so Markdown
needs no library. `maskSecrets` is already applied to attachment text and stays applied inside the
viewer. Markdown renders; text and code show as text; images inline; PDFs go to the browser's own
viewer; anything else is offered as a download. Every row carries a Download.

**The route.** `GET /files?agent=&path=&download=1` on the relay, which goes through the gateway
read commands above — never a `docker exec` from the relay.

**What is out of scope, on purpose.** `/workspace` is not listed: 65 entries on Jason's box shared by
every agent with no per-agent directory, so the attachments path check cannot be reused, and a
listing command would turn a relay restart into a three-box host swap. It has its own gap row. The
Files panel copy changed with the list, because it used to claim the host keeps no per-worker
directory — true of `/workspace`, false of `attachments/` and `assets/`, where every file in the list
actually lives.

---

## 5. The gate

```
node scripts/verify-console-polish.mjs --boot     the plate is on <html> before first paint; the cover lifts
                                       --scroll   the transcript stays where the person left it
                                       --picker   no tile-shaped blanks; the default is Titan Nebula
                                       --badge    a gap is one row, and it opens and shuts again
                                       --tile     a picture or a plate, and never a broken image
                                       --tile-live the tile follows the agent's screen, and what that costs
                                       --keys     the reader never holds the keyboard: Escape leaves talk mode, the space bar talks
                                       --seat-escape  Escape still closes the agent's screen once its seat has the keyboard
                                       --files    a file row opens a viewer and downloads
                                       --chips    a backticked span is a chip a mouse can press, and pressing it copies (§8)
                                       --approval the auto-review card in every state, and one real forced approval
                                       --all      every leg in sequence, one browser
```

Every leg sends `titanbot-gate/verify-console-polish`, on the API calls and as the browser's real
`userAgent`. It did not until CONSOLE-5, which made a run against a live console indistinguishable
from a person and meant nothing could be excluded from a traffic reading afterwards.

Add `--url https://console.titanium.bot` with `CONSOLE_BEARER` in the environment for a read-only
pass against a live console. In that mode nothing is created, nothing is prompted, and every leg that
would write is refused with its reason. The bearer is never printed and never written to disk.

Five rules the script is written under, each paid for by an earlier gate that lied:

- **A click that resolved is not evidence.** `page.click()` calls `scrollIntoViewIfNeeded` first and
  has passed on menu items no mouse could reach. Everything that claims a person can use a control
  hit-tests it: a box with area, and the element under its own centre is that element or something
  inside it.
- **Nothing is read before the adapter exists.** The static shell satisfies selectors with markup
  `app.js` has not filled yet. (It used to satisfy them with seed COPY, which the review pass
  emptied — see §1.)
- **The rail tile's click is a write**, so that leg is local-box only. `--tile-live` drives the
  box's own browser with `box-chrome` and holds a reader on a real seat, so it is local-box only for
  the same reason and is refused outright in read-only mode. So is `--approval`, which arms the
  box's own review mode, forces a real approval and presses its buttons.
- **A cadence measured through `app.js`'s own render loop is not a cadence.** `renderBoxHandoffSurfaces`
  calls `sync` on every heartbeat with the record's *real* status, which retimes the reader underneath
  any probe holding it at another one — measured while building `--tile-live`. So that leg pins the
  state the module is driven with for the length of a measurement, puts it back afterwards, and says
  in its own output that the cadence was **forced**. The local box's model endpoint does not take
  turns (`docs/APPS.md`), so a forced cadence is the strongest claim this machine can make and the
  real-turn proof belongs on the R750 demo tenant.
- **The tile has to be showing the agent the leg measures.** `screen-tile.js` refuses to paint into a
  tile carrying another agent's id, so a leg measuring one agent while the console has another open
  reads a stamp that moves and a picture that never changes — measured, when Playwright's element
  click on a roster card silently did not take. `--tile-live` clicks the card in the page as a
  fallback and then asserts the tile's own `data-agent-id`.
- **Websocket bytes are invisible to `scripts/verify-cost.mjs`**, which sums `Network.dataReceived`
  and therefore counts HTTP only. `--tile-live` counts `Network.webSocketFrameReceived` and prints
  the tile against the same figures `docs/APPS.md` sets, with what those figures are and are not
  spelled out in §3.
- **Opening a conversation is two clicks, not one.** Playwright's element click on a roster card
  silently does not take on this box, and every assertion afterwards then reads whichever
  conversation *was* open — which is how the integration read a plate off another agent's tile three
  runs in a row. `openConversation` now falls back to clicking in the page and confirms the card went
  active; a leg that still cannot open the card says so and skips the claims that depend on it, by
  name, rather than failing them.
- **A leg that arms the box puts it back in a `finally`.** `--approval` sets
  `SAND_AUTO_REVIEW_MODE=enforce` in the box's settings file and adds one block instruction through
  `setHostSettings`. A run that died between those two writes and its restore would leave every
  other wave's gate on that box looking at a host that refuses every command, so the restore covers
  the settings file, the operator's instructions, any card still pending and the scratch agent, and
  each of those is checked rather than assumed.
- **`getForeverBoxStatus` takes `{ id }`**, and the tile leg asserts the difference between the two
  argument shapes rather than assuming it.
- **A leg opens a conversation that HAS the thing it measures.** The badge, files and scroll legs
  used to open `roster[0]` and skip when it came up empty, which on `grok-bot-local-vm` reported
  "the module has not merged" about a module that was loaded and working: the first agent there has
  a five-row transcript with no run of system rows and no file in it, and a five-row transcript
  cannot drift because it does not overflow. They now walk the roster until the page shows the
  shape, print how many they opened, and the scroll leg prints the transcript's height and row
  count beside the drift so a reader can see what the number was measured on.

Screenshots land in `$GROK_BOT_SHOT_DIR` and every one is named in the output.

`scripts/verify-handoff.mjs --console` covers the same reader from the hand-off side and stays green;
`scripts/verify-dashboard.mjs` covers the rest of the console.

| Gate | What it covers |
|---|---|
| `node --test tests/machine-room-boot.test.mjs` | the plate, the floor, the series headings, the cover's lift decision **and what it uncovers**, that no field in the shell ships copy, the picker surviving a missing `bg-boot.js`, the scroll table, the four seams with their modules absent, the adapter's data shapes |
| `node --test tests/titan-crew.test.mjs` | `backgrounds.js` still publishes the list the console knows it by, loaded the way the browser loads it |
| `node --test tests/machine-room-transcript-fold.test.mjs` | DASH-FOLD-1's fold still runs before the badge sees the rows |
| `scripts/verify-console-polish.mjs` | the browser legs, on `grok-bot-local-vm` and then read-only on Jason's console |
| `scripts/verify-mobile.mjs` | the same console at 390x844 and 430x932 with touch, and a 1440x900 leg that fails on a changed pixel (§7) |
| `node --test tests/machine-room-mobile.test.mjs` | that the phone pass stayed inside `@media (max-width: 690px)` (§7) |
| `node --test tests/machine-room-gap-badge.test.mjs` | the gap predicate (**including that an adapter notice ends a gap and is never folded away**), the headline, its kinds line in plain words and its span ceiling, the preference store, the receipt that survives a rebuild, and that the module is loaded ahead of app.js |
| `node --test tests/machine-room-screen-tile.test.mjs` | the blank-frame refusal, the reader's life, the seat argument shape, the stylesheet's `[hidden]` belt, and `SCREEN-TILE-1`'s three cadences — the idle remount, that a render never pushes the wake back, the hidden tab, the cheap reader URL, `capturedAt` and the age wording |
| `node --test tests/machine-room-files.test.mjs` | the viewer's five branches, the masking, and the `/files` route's fences against a real relay and a real gateway |
| `node --test tests/console-approval-card.test.mjs` | the approval card: four pill states, the 400-character elision and its count, the stripped location clause, the conditional rule paragraph and Always-allow button, the settled branches keeping the command, and the order of the two calls behind Always allow (§9) |
| `scripts/verify-dashboard.mjs` | unchanged by this wave, and NOT green on `grok-bot-local-vm`. It leaves its own probe agents behind and they then fail its avatar and bot-cap legs (GATE-14), so the honest way to read it on this box is to diff its failure list against a run of the previous commit rather than to read its tally |

The CONSOLE-4 ship was **relay-only by construction**: everything in that wave was `ui/`, tests,
scripts and docs, and `git diff <pre-wave>..HEAD -- source/ deploy/` had to be empty before shipping.

**That stopped being true with CONSOLE-5.** The chip is worth nothing if the model never reaches for
backticks, and the habit that fills it is one sentence in `source/host/runner/standing-persona.ts` —
which is the host bundle. So the console-polish 3 wave is a **host ship**: one sentence in `source/`,
and with it the two-box swap (the demo box and Jason's box, never Richard's) and the post-swap watch.
The assertion above becomes: `git diff <pre-wave>..HEAD -- source/ deploy/` touches
`standing-persona.ts` **and nothing else**. If it touches anything more, stop and re-scope — the
budget for this wave was exactly that one sentence.

Nothing in §8 or §9 is part of that host change. The chip and the approval card are `ui/` alone.

---

## 6. What the ship measured

Shipped 2026-09-09 03:30 UTC as merge commit `4b0c769`: a relay sync and one relay restart, nothing
else. `git diff <pre-wave>..HEAD -- source/ deploy/` was empty, so the host bundle did not need to
move and no box was touched — all three on the R750 were up 32, 32 and 41 hours afterwards. Every
shipped file was hashed inside the relay container against the worktree and all fifteen matched.

**One caveat worth knowing before the next ship.** `sync.sh` rebuilds the host bundle and restages
`sand-host-bundle-latest.version` from the tree's git sha even when `source/` has not moved, and the
rebuild is not byte-reproducible. Every box on this host runs `SAND_BOX_AUTO_UPDATE=1`, so leaving a
new version string beside a bundle built from identical source would walk three boxes — one of them
a paying customer's — through a host swap that changes nothing. This ship put the previous version
string back afterwards, so no box swapped. A wave that really changes `source/` wants the opposite:
leave the new version and do the documented `updateHostNow` in each box.

### Before and after, on Jason's own console, read-only, across the same ship

| | before | after |
|---|---|---|
| the plate at 50 ms | `data-bg` null, no cover | `data-bg="titan-nebula"`, cover showing "Reaching this box" |
| the picker's series headings | Habitat and The Lab drawn 182x102, one tile's cell each | 20 cells, every heading spans the grid |
| Titan's transcript, parked 5 s | — | 183 rows, 34,217 px in a 668 px viewport, parked at 11,406, **drift 0 px** over eleven samples |
| the rail tile | one laid-out `<img>`, no src, `naturalWidth` 0, `display: block`, 231x75, alt "Titan's screen" | **0 broken images**, the plate, then a real 7,611-character webp off seat :3 in 1.2 s drawn 390 px wide. The rail tile emits no `<img>` until it has a frame; the one remaining src-less `<img>` on the page is `HANDBACK-1`'s hand-off thumb (`app.js`, alt "What is on this agent's screen right now"), emitted `hidden` and laid out 0x0 by `styles.css` `.handoff-thumb[hidden] { display: none }` |
| a run of work between two chats | every row full height | one collapsed row: "Worked for 7 sec · 8 steps · 4 commands, 3 web searches, 1 page read", 0 px of body, opening to 106 px on a click. (Measured as `shell 4, websearch 3, webfetch 1`; the plain-words table landed in the review pass that followed) |
| the Agent panel's file count | **Files 1** | **Files 10** |
| `rsi-vs-agi-notes.md` | nothing happened on a click | rendered Markdown, 2,529 characters, 20 list items, 9 paragraphs, a secret still masked; Download carries its own filename; the route answers 200, 2,614 B, `text/markdown` |

On `grok-bot-local-vm`: `npm test` 1,682 PASS / 0 FAIL, typecheck clean, the six polish legs
20 PASS / 0 FAIL / 1 SKIP (files, because no conversation on that box carries one), and
`verify-dashboard` reached **40 more checks inside the same 290 s with a byte-identical failure
list** — 123 checks / 12 FAIL before, 163 / 12 after.

### Three gate faults only a live console could find

Each of these passed over loopback and lied over the internet, and each is fixed in
`verify-console-polish.mjs`:

- **`document.body` at 50 ms.** After `waitUntil: "commit"` on a real connection the parser may not
  have reached `<body>`, so `getComputedStyle(document.body)` threw. A head-only document is not a
  failure of the boot claim — it is the strongest form of it.
- **`elementFromPoint` outside the viewport.** It answers null, so the badge in a 34,217 px
  transcript read "under its centre is nothing" while being perfectly clickable. The hit test scrolls
  an offscreen control into view first and still reads what is under its centre afterwards, so a
  covered control fails as before.
- **Looking for file rows on the shell.** They are drawn in the desktop's Files view, which is the
  thing Jason clicks in his complaint. The leg reported "no conversation carries a file" against a
  console whose Agent panel said Files 1.

### The review pass, shipped and measured on his console (2026-09-09 04:40 UTC)

Commit `7a3ea50`, relay-only again: `git diff e6a2c5d..HEAD -- source/ deploy/` empty, `sync.sh
--no-install`, then one `docker restart` of the relay. No box was touched. `sync.sh` restaged the
version string and rebuilt the bundle as the caveat above says it would, so both were put back
exactly as they were — `sand-host-bundle-latest.version` at `e6a2c5d38993` and `host-main.cjs` at
sha `cb42714d…`, which is the byte-for-byte bundle all three boxes are running — and no box swapped.
`index.html`, `backgrounds.js` and `gap-badge.js` hash-identical inside the relay container against
the worktree.

| | before | after |
|---|---|---|
| the stalled boot (`/api/**` stalled **in my browser only**, nothing on his box touched) | cover gone at 8,675 ms, then at 14 s the page read "MSP Team", "3 members · ready", "2h 14m", "Atera Triage's desktop" with nothing marking it | cover at **207 ms**, gone at **8,721 ms**, and at 14 s: room title "Still connecting", subtitle "this console has not reached your box yet", transcript "Still reaching this box. Nothing on this page has loaded yet.", every other field empty, **no "MSP Team" and no "Atera Triage" anywhere in the body** |
| the normal boot | — | `data-bg="titan-nebula"` at the first sample there was a root to carry it (**245 ms**), cover gone at **2,804 ms** onto his own console: "Titan", "Agent · Ready for the next task", "Titan tools", "4h 23m", "Ask Titan…", 6 workers |
| the badge's kinds line | "shell 4, websearch 3, webfetch 1" | "5 commands, 1 message, 1 page read" (X Marketer), "15 commands, 1 computer step" and "12 commands, 2 files read" (Titan), "5 commands, 1 message, 1 file read" (Instagram Marketer) — **no tool identifier on any of them** |
| src-less `<img>` | the doc claimed none page-wide | Titan's conversation: 4 images, **0 src-less, 0 broken**, the rail carrying a real frame. Scribe's: **1 src-less** — the hand-off thumb, `hidden`, `display: none`, laid out **0x0** — and still 0 broken |

Same run on `grok-bot-local-vm`: the stalled boot gives cover at **91 ms**, gone at **8,555 ms**, the
same three honest lines and nothing else; `npm test` **1,696 PASS / 0 FAIL**; typecheck clean;
`verify-console-polish --all` **34 PASS / 0 FAIL / 1 SKIP**
(the badge leg, because no conversation on that box has a run of two system rows — it is measured on
Jason's console instead, above); `verify-dashboard` **164 PASS / 13 FAIL**, and not one of the
thirteen is in a surface this pass touched: three avatar legs and three bot-cap legs are `GATE-14`'s
leftover probe agents, three attachment legs are a probe turn that did not come back inside the 60 s
budget, three are the marketplace legs belonging to the wave editing that code, and the last is the
gate's own summary line.

---

## 7. On a phone

Titan filed it as report #4 in the control plane on 2026-09-09, in the person's own words:

> The mobile version of the console does not work: cannot scroll or move around, content is too
> large for the mobile viewport. User was trying to read chat on a phone and could not navigate at
> all.

### One cause, and it was not the scrolling

`.app-shell` is a grid. It had rows and **no column track**, so its single implicit column was
`auto` and sized to the widest child's min-content. That child is `.window-bar`, whose three tracks
resolved to **88 + 273 + 134.406 px plus 20 px of padding = 515.406 px**, and the 273 px in the
middle is the automatic minimum of `.capability-dock` — six capability buttons with no `min-width: 0`
anywhere under them.

So at a 390 px viewport the whole console laid itself out at 515.406 px and `.app-shell`'s
`overflow: hidden` clipped the other **125 px** with no scrollbar and no pan. Measured on
`grok-bot-local-vm` in real Chrome at 390x844, device scale 3, touch, an iPhone user agent:

| | before | after |
|---|---|---|
| `getComputedStyle('.app-shell').gridTemplateColumns` | `515.406px` | `390px` |
| elements a person cannot reach past the right edge | 402 at 390, 392 at 430 | **0** at both |
| `document.scrollingElement.scrollWidth` | 390 (nothing gave the 125 px back) | 390 |
| `.send-button` | x 425..500, `elementFromPoint` → `null` | x 293..368, 75x44, hit-tests clean |
| `#settings-button` | x 476..505, off screen | x 336..380, 44x44 |
| `#theme-toggle` | x 436..465, off screen | x 288..332, 44x44 |
| the roster and the agent rail | `display: none` | drawers, behind a handle each |
| `#message-input` font | 15px — iOS zooms the layout viewport on focus | 16px, line 22, eight-line cap 176 |
| `env(safe-area-inset-*)` in the whole console | none, anywhere | on the bar and the shelf |
| controls under 44 px in the visible band | 24, swept rather than listed — see the note below | **0** at both device sizes, at rest and with the desktop view open |
| a report card opened by hand | 442 px wide at x 0, an 11px box to type into | 333 px, 0 descendants past the edge, 16px |
| settings panel, descendants past the edge | 31, worst right edge 692 px | 43 rects, **0** of them outside a sideways scroller |
| sideways, at 844x390 | shell 650 px tall, composer bottom 394 in a 390 px viewport | shell 390, composer on screen |

**The 44 px floor is swept, not listed, and the first pass of it was a list.** The phone block named
nine selectors, and nine selectors is as good as whoever wrote them. A sweep of every visible button,
link, input, select and `[role=button]` with a non-zero rect, at the same moment on the same page,
found eight more: the **five capability buttons** at 39x44, 40x44, 32x44, 39x44 and 36x44 — the whole
of the phone's navigation, given `min-height` with `min-width: 0`, so tall enough and too narrow to
hit; the **evidence chip** at 159x25 and 200x25, the second of those being the *"1 detail not backed by
a tool result"* chip in Jason's own screenshot of 2026-09-09; a **secret-request field** at 228x42; and
in the desktop view the **dialog close** at 37x37 and the hand-off banner's **"Skip this step"** and
**"I'm done, continue"** at 103x33 and 130x33 — the only two controls that answer a hand-off, which is
the one thing a person must be able to do from a phone.

Seven more came with them, all inside the conversation and all older than the phone pass: *"Show
earlier messages"* 155.89x34, the between-chats badge **43.34** tall (0.66 px short, which is the kind
of miss only a sweep finds), a peer-exchange row 178.02x29.94 (it carries `role="button"` and opens the
exchange, so it is a control), and **Open**, **Download** and **Show more** on an attachment at
49.08x34, 74.11x34 and 251.16x34 — the three ways a person gets at a file from a phone.

`verify-mobile --reach` sweeps now, at both device sizes, at rest and again with the desktop view and
the hand-off banner open: **42 and 48 visible controls, 0 under 44x44**. The leg's own hit test lost a
clause while this was being fixed — `at.contains(el)` was true whenever the element under a target's
centre was an *ancestor* of it, and `body` and `html` are ancestors of everything, so a control under a
full-screen overlay reported a clean hit. That is the exact trap the file's header says it exists to
close.

**With the box down, both drawer handles were unpressable.** `gateway-adapter` stamps `data-demo` on
the root when hydration fails and `backgrounds.css` paints a fixed caption across the top at
`z-index: 9999` — the only fixed overlay this console draws. On a phone the window bar's first row *is*
the two drawer handles. Measured on this Mac at 390x844 with touch and no gateway credential: the
caption computed 47.6 px tall, both handles are laid out at y 8 with a 44 px box, `elementsFromPoint`
at each centre answered `body` first, three consecutive touch taps left `body.dataset.drawer` empty,
and `page.click("#roster-drawer")` timed out with *"&lt;body&gt; intercepts pointer events"*. A person
whose box is down is exactly the person who wants to switch conversations to see what else is broken.
The caption is a caption now (`pointer-events: none`) and the bar starts below it, and
`verify-mobile --demo` forces that state and taps a handle for real.

**The transcript was never the thing that could not scroll.** It is the only scroller in the chain
and it worked: 14,527 px of content in a 625 px band, and a real CDP thumb drag moved it 447 px. What
could not be scrolled or panned was the 125 px of console hanging off the right, which is the "cannot
move around" half of the report. The fold, the paging and the scroll pin CONSOLE-4 landed are
untouched; the phone adds `overscroll-behavior: contain` so a drag at either end does not chain into
a document that cannot move.

### The rule: desktop widths do not change

Everything the phone pass adds lives inside `@media (max-width: 690px)`, or in a
`@media (max-height: 500px)` block for a phone turned sideways. **One rule is outside it**, and it is
the only one:

```css
.icon-button.drawer-toggle, .drawer-scrim { display: none; }   /* nodes that only exist on a phone */
```

`tests/machine-room-mobile.test.mjs` parses the sheet and fails if a second one appears.

**The shell's column track was the second one until the gate caught it, and this is the useful part
of the story.** `.app-shell { grid-template-columns: minmax(0, 1fr) }` is the cause's fix, and it was
written in the base rule on the reading that it is a no-op above the breakpoint, since the implicit
column already computes to `1440px` at 1440x900. The reading was wrong and the A/B leg measured it:
reverting the rule moved **five rects** — `TITAN-MASCOT`, and `.room-capsule` with its `#room-title`
and `#room-subtitle` — the capsule **227 px wide with the rule against 268 px and 20 px further left
without it**. An `auto` column lets a child's own intrinsic width feed back into the window bar's
`1fr` track in a way a `1fr` column does not; a computed column of `1440px` in both states says
nothing about how the track below it resolves. The rule is inside `@media (max-width: 690px)` now, so
desktop widths cannot be reached by it at all, and the claim is structural rather than a measurement
that has to be repeated.

**THE FIRST CUT OF THIS CLAIM WAS NOT EVIDENCE FOR IT, AND THE SHIP MOVED THE DESKTOP BY 31.94 px.**
Said first because it is the lesson. The leg fingerprinted the shipped page, drew the two drawer nodes,
hid them again, and required the shipped fingerprint back. Both sides of that comparison are the same
tree: it proves the fingerprint is deterministic and that the one base rule it names is reversible, and
it says nothing whatever about whether this tree's desktop matches the tree before it. It reported
*"997 of 997 rects identical"* while `.control-shelf` was **31.94 px taller** than it had been and
`.transcript` 31.94 px shorter, because FEEDBACK-2 moved `.composer-aside` into the shelf's grid and,
unlike the send status and the attachment tray, it never collapses. At 900x800 fourteen of
twenty-four named rects had moved. docs/FEEDBACK.md §6 carries the numbers and the fix.

So the claim is measured the way the claim is worded. `verify-mobile --desktop` runs **two legs**:

- **The A/B across two trees.** A second relay is spawned from a detached worktree at `--baseline
  <sha>` (default `2d58c8b`, the commit before the phone pass landed), pointed at this worktree's own
  writable state so both pages see the same local box, the same account and the same conversations —
  the only difference between them is the code. One browser, three viewports (1440x900, 1100x820 and
  900x800), and a **named list of 24 structural rects** required equal rect for rect. Named rather than
  "every element in the document", because the shared branch carries other waves between the baseline
  and the tip and a whole-document diff across two trees would report their rows as this wave's
  movement. Both sides open the same conversation first, by the page's own click on the first roster
  card: two relays are two origins, each keeps its own `localStorage` and picks its own agent, and
  `.room-capsule` sizes to its own title and status sentence — the first cut of this failed at 1100x820
  on the capsule alone, 227 px against 272.89, which is two pages looking at different agents and not a
  layout difference. `localStorage` is cleared before the first paint on both for the same reason: the
  room strip is the shelf's **first grid track**, so one extra chip of page-local "open rooms" moved
  `.composer` 20.2 px and `#message-input` with it. Each width asserts the two pages are on the same
  conversation, by id, room title and chip count, **before** it compares a single rect. Measured on this
  Mac: **20 of 24 exist on both sides and all 20 are identical at all three widths**, including `.control-shelf`, `.transcript`, `.composer`, `.send-button` and
  `.composer-aside`. A zero-rect element's `position` keyword is excluded on purpose: the status and
  the tray went from `absolute` to full-width rows in this pass, and at rest both are hidden with a
  0x0 rect, so the keyword differs while nothing has moved by a pixel. **And the A/B proves its own
  sensitivity:** the old grid row is injected back into the shipped page and the rects must move —
  measured, it moves 6, including `.stage`, `.transcript` and `.control-shelf`.
- **Sensitivity and return, within one tree.** The old leg, kept for what it actually proves: that the
  fingerprint is deterministic, that it can see a change at all, and that the one base rule this pass
  puts outside the breakpoint is reversible.

**What a pixel claim can be on this console, and what it cannot.** The first cut of that leg
screenshotted the full page twice a few seconds apart and failed by 11 KB on a page nobody had
touched. With every animation and transition forced off, measured on this Mac in headless Chrome:
`.window-bar` and `#transcript` come back byte-identical shot after shot, and **every panel carrying
`backdrop-filter: blur() saturate()`** — the roster, the room capsule, the agent rail, the shelf —
differs by about a hundred bytes in a hundred kilobytes each time. That is the compositor
re-rasterising a blur, not the layout moving, and no amount of waiting settles it. A leg that
insisted on full-page byte equality would fail on an unchanged console, which is a gate that lies in
the other direction.

So the leg makes two claims instead of one bad one:

- **The geometry, exactly.** Every element in the document, by tag, id, class and rounded rect. One
  element moving one pixel changes it. This is what says the fingerprint itself does not drift, and it
  is deterministic — with one honest subtraction, measured in the same run:
  the fingerprint is taken **twice in the same state first**, and anything that moved on its own
  with nothing changed is named, counted and left out. On a busy box that is the agent rail
  redrawing its screen tile and its browser strip on the adapter's beat, which is not evidence
  about a stylesheet rule in either direction. Everything else has to match exactly.
- **The pixels, where pixels are stable.** `.window-bar` and `#transcript` are shot in both states
  and compared byte for byte, and each region's own noise floor is measured first, in the same run.
  A region that will not hold still is named and skipped rather than quietly dropped.

Reverting the base rule first is part of the second leg: the drawer handles coming back must change
the fingerprint, which is what shows the comparison can see a change at all. Measured on
`grok-bot-local-vm`, 1440x900: drawing the drawer nodes changed **13** rects; hiding them again
returned **every** rect in the document to the shipped one — **1,196 of 1,196**, with **0** moving on
their own in the same state. That is a claim about determinism, not about the tree before this one;
the A/B above is the claim about the tree before this one. `.window-bar` and `#transcript` came
back byte-identical in both states (88,886 and 317,964 bytes; the counts move with the conversation on screen, so the
claim is the equality, not the number). The leg also re-reads the three numbers the same box
gave before the ship: shell column `1440px`, `.composer` bottom **856**, `.send-button` x
**959..1053**. Both full-page screenshots are saved anyway, for a person to look at.

### The bar is two rows, and the rails are drawers

The bar was the widest thing in the shell, so the phone pass had to take things off it rather than
add to it. The traffic lights and the product mark go (the mark is on the boot cover, in the tab
title and on the sign-in page), the ⌘K hint goes on a device with no keyboard, and the six capability
buttons move to their own full-width second row. Squeezed into one row beside five 44 px targets the
dock's track measured **94 px against a 280 px strip** — two and a half of six capabilities behind a
sideways scroll nobody would find.

`justify-self: center` is why `min-width: 0` alone did not help: a centred grid item sizes to its
content, and the first candidate measured the dock still 273 px wide inside a 112 px track with its
buttons drawn on top of the theme and settings buttons. It stretches now, and still scrolls with a
fade at either end if a longer set of capabilities ever does not fit.

The two rails were `display: none` at this width, so a person on a phone could not change agent,
change room, or open an agent's screen at all — `#rail-screen` laid out at 0x0 because its parent was
hidden, and a script could open the desktop dialog while a thumb had nothing to press. They are
off-canvas drawers now, one behind a handle top-left and one top-right, and the agent's screen tile
is reachable by hand for the first time (measured 274x172 at 390x844).

The scrim lives **inside** `.stage`. `.stage` is `position: relative; z-index: 2`, which makes it a
stacking context, so a drawer inside it cannot be raised above a sibling of the stage however high
its `z-index` goes: the first cut put the scrim next to the stage and the drawer opened *under* its
own scrim, dimmed by it, in real Chrome.

`app.js` gains 27 lines of code and nothing else: which drawer is open, Escape and a scrim tap closing it,
closing behind a chosen conversation, and handing the keyboard back to the handle that opened it. The
sliding, the scrim and the visibility are CSS. The unit test caps that block's line count, so "the
smallest addition" is a measured claim and not an intention.

### The keyboard, and what is not measured

`index.html`'s viewport meta gains `viewport-fit=cover` — without it every `env(safe-area-inset-*)`
resolves to 0 and the composer sits under the home indicator — and `interactive-widget=resizes-content`.
Chrome honours that second one; **iOS Safari does not**, so `app.js` also sets a `--kb` custom
property from a `visualViewport` resize listener and the shelf pads by it. Measured with a
keyboard-sized visual viewport simulated in Chrome: the shelf's bottom padding went 10 → 310 px and
the composer came off the bottom.

**The iPhone's own keyboard is unmeasured.** Chrome cannot raise one. This is built to the platform
rule and asserted against a simulated resize, and that is the whole of the claim.

### The three hooks a shell reads off this page (CONSOLE-ATTR-1)

Both app shells load this console rather than shipping a copy of it, and the desktop one has a reader:
until a device is signed in it has no bearer and no route, so a small injected script reads the DOM
and raises a tray event with what it found. Three attributes are the whole of what it is allowed to
read, and they are in this repository because they are this page's contract and not the shell's:

| Attribute | Where it is | Written by |
|---|---|---|
| `data-needs-you-count` | the roster's needs-you pill, `index.html` | `renderNeedsYouCount` writes the **number** as the value, on every roster change |
| `data-needs-you-card` | every **pending** card, carrying `<conversation id>:<entry id>`, with `data-card-id` (the same string), `data-card-kind`, `data-agent`, `data-title` and `data-href` beside it | `needsYouCardAttrs` in `app.js`, called from the pending branch of `decisionMarkup`, `handoffCardMarkup` and `reportCardMarkup` and nowhere else |
| `data-talk-button` | the talk button, `index.html` | static markup, so it is there before `voice.js` boots and stays there when `probe()` disables the button |

**The count attribute existed with no value, and an empty attribute was worse than none.** The
shell's reader falls back to the number of elements its selector matched, and this pill is in the
markup and matches even while it is hidden and empty — so a console with **zero** agents waiting
reported **1**. Measured on this Mac 2026-09-10 by running that reader verbatim against the shipped
markup: 0 → **1**, 3 → 3; with the value written, 0 → 0. A quiet console put a phantom 1 on the tray.

Three rules the card attributes keep, each of them a way to be wrong quietly:

- **Only a pending card carries them.** Every settled branch, every answer in flight, the skill card,
  and the rail's second drawing of the same hand-off carry nothing — the rail one because attributing
  both copies would count every open hand-off twice.
- **A card with no durable id carries none of them.** The adapter falls back to the literal `"agent"`
  when the host sent no author and to `entry-<n>` when it sent no entry id; either would mint a deep
  link that lands on nothing, so the whole set is dropped instead.
- **`data-title` on a hand-off is the relay's own fixed sentence**, `Take the keyboard for <agent>`,
  and never the agent-written instruction the card shows on screen. That is `ui/push-edge.mjs` rule 5
  reaching one surface further out.

The node list is only the open conversation, by construction, so it is a partial picture of what is
waiting; `GET /push/pending` is the authority and these are the fallback for a shell with no bearer
yet. The full contract, with the shapes, is **docs/APPS.md** section 6 and section 15.
`tests/console-needs-you-attributes.test.mjs` pins all three out of the shipped files.

**The phone shell reads no page at all today** — it holds a bearer and calls the routes. Only the
desktop has a reader, and only because its window opens before anybody has signed in.

### Boy-scout, inside these files

The settings panel had 31 descendants past the right edge at 390 px — the Job Bus table is 631 px
wide and reached x 692, and the provider tiles under "Your own keys" were sliced mid-word. Two rules:
`min-width: 0` on the settings list and its sections, and one column for the provider grid. The
tables were already wrapped in `overflow-x: auto`; what was missing was letting the wrapper shrink.
After it, 43 rects still report a right edge past 390 — every one of them inside a sideways scroller
a thumb can drag — and **0** that nobody can reach.

Two dead rules went with it. `.window-actions .icon-button:first-child { display: none }` matched
nothing (the first child of `.window-actions` is `#palette-hint`, a `.quiet-button`), so the theme
toggle it meant to drop had been on the bar the whole time, off the right edge of it. And
`.capability-dock`/`.capability-button` were set twice in the same breakpoint, decided by which was
further down the file; the phone's copy is the measured one, so the older pair went.

### The gate

```
node scripts/verify-mobile.mjs --width     the shell's column is the viewport; nothing hangs off the edge
                               --reach     every control on screen, 44x44, and nothing on top of it
                               --scroll    a real touch drag moves the transcript; the document never moves
                               --send      a tapped Send lands a message
                               --drawers   both drawers open, work, and close
                               --panels    the marketplace, a bot page and settings fit
                               --attach    a staged picture's chip is on screen and unclipped
                               --card      a report card opened by hand fits, and its Send is a real target
                               --fonts     every text input ≥ 16px; the meta covers the notch
                               --land      a phone turned sideways keeps its composer
                               --desktop   1440x900 does not move by one pixel
                               --all       every leg, one browser, one relay
```

Every phone leg runs at **both** 390x844 and 430x932, device scale 3, `isMobile`, `hasTouch` and an
iPhone user agent carrying `titanbot-gate/verify-mobile.mjs`. The default target is a relay spawned
from the worktree under test against `grok-bot-local-vm`, so the gate measures the tree it lives in
rather than whatever tree the 7777 server was started from; it holds the shared box lock while it
does, and the run budget starts when the lock is in hand. `--url https://console.titanium.bot` with
`CONSOLE_BEARER` runs read-only and refuses the two legs that write. Screenshots land in
`$GROK_BOT_SHOT_DIR` and every one is named in the output.

Two things the gate does deliberately, and says so in its own header:

- **The overflow count only counts what nobody can reach.** An element inside a container that
  scrolls sideways can be dragged into view, and a drawer parked off canvas at `visibility: hidden`
  is not on the page. Both are excluded, and the raw count is printed beside the real one so the two
  are never confused.
- **Nothing is scrolled before a control is hit-tested.** A control a person needs at all times has
  to be where they can press it, and "it works once you scroll to it" is the failure this gate
  exists to catch.

**One baseline in it was an absolute pixel, and it stopped being one on 2026-09-10.** The desktop leg
pinned where Send sits at 1440x900. It went red twice for things that were not regressions: 959..1053
was measured at `3bfaca9` (2026-09-09 20:53), the Talk button landed beside the message box at
`c57dac3` and moved Send to **1022..1116**, that was re-baselined, and then the same leg read
**959..1053 again** later the same day with the Talk button still in place. The cause is the routine
chip at the far right of that row: it draws either a countdown with "next routine" under it or the word
"trigger" with "event routine" under it (`ui/machine-room/app.js`), and those are different widths. Which
one is drawn depends on whether the **open conversation happens to have a timed routine** — box state
that differs from run to run — so Send's absolute x is not a property of the layout and no baseline can
be right for both. The leg now asserts what it is actually for: Send's **width** (94 px — a Send that
changes size at a desktop width is the regression this row exists for) and the **order** of the three
controls, that Send sits between Talk and the routine chip. The absolute position is reported as an INFO
line with the reason it moves. Measured on grok-bot-local-vm 2026-09-10: Talk ends 955, Send
959..1053, the chip starts 1229. `verify-mobile --width --desktop`: **29 passed, 0 failed** on this
Mac after the correction (it was 27 passed and 1 failed against the pixel baseline; the position
assertion became two, the width and the order).

**The budget is the ceiling, and the tail legs can run into it.** Eleven legs at two device sizes do
not always fit the 260 s that keeps the gate inside the 300 s run ceiling, and the two that wait on
the box — attach and send — are the last before the desktop leg. On the first full run they were
handed a 1 ms wait and reported a tray that never rendered and a message that never landed: a failure
about the product for a fault in the gate's own clock. Both now say how much budget is left and skip,
and they are measured in a run of their own.

Measured on `grok-bot-local-vm`, this Mac, 2026-09-10: `verify-mobile --all` **133 passed, 0 failed,
1 skipped** (at 430x932 that conversation was shorter than the viewport, so there was nothing to
scroll), and `verify-mobile --attach --send` **13 passed, 0 failed** with the budget to itself. Two
runs, each inside the ceiling.

**On the R750 demo tenant through https://console.titanium.bot**, real Chrome, 2026-09-10 01:57Z,
signed in as a throwaway customer account minted in the cp container and removed afterwards. At
**1440x900**: shell column `1440px`, `.composer` bottom **856**, `.send-button` x **959..1053** — the
same three numbers the local box gives, and the third of them moves with the routine chip's text rather
than with the layout, which is why the gate asserts Send's width and its order and not its x; both drawer handles in the DOM and **neither laid out**; the
scrim inside the stage; 0 unreachable past the right edge. At **390x844**, device scale 3, touch,
iPhone UA: shell column **390px**, **0** unreachable, document exactly the viewport wide, the viewport
meta carrying `viewport-fit=cover` and `interactive-widget=resizes-content`, the composer at **16px**,
every control on screen at ≥ 44x44 hit-testing to itself, a real thumb drag moving a **21,453 px**
transcript in a 512 px band while the document stayed at 0, both drawers opening with a thumb landing
in the drawer rather than on the shelf above it, the uncovered sliver beside each really being the
scrim and closing on a tap, and the marketplace 354 px wide with 24 rows and 0 unreachable. **21
checks at the phone size, 6 at desktop, 0 failures.** One thing that run corrected about the gate
rather than the product: a scrim tap aimed at the scrim's own centre lands on the open drawer, so the
point has to be the sliver on the far side — which is what `verify-mobile` already does.

| Gate | What it covers |
|---|---|
| `node --test tests/machine-room-mobile.test.mjs` | that the phone pass stayed inside its breakpoint: exactly one base rule, the shell's column track inside it and not outside, the dock really shrinkable, the composer's font and its eight-line cap moving together, the viewport meta, the scrim inside the stage, and a line-count ceiling on `app.js`'s share |
| `node scripts/verify-mobile.mjs --all` | the browser legs at both device sizes on `grok-bot-local-vm`, then read-only on `console.titanium.bot` |
| `node --test tests/machine-room-transcript-pin.test.mjs` | PHONE-CONSOLE-1's own half: the pin is lost by scrolling up and by nothing else, the re-pin cannot feed itself, the two files agree on 90 px, the keyboard's ceiling and the composer's cap while it is up |
| `node scripts/verify-mobile.mjs --phone-app` | the iPhone app's own layout, in WebKit at 390x844 in two passes, insets restated at 59/34 and at 0. Not part of `--all`: it opens a second browser engine and `--all` is already at its budget ceiling. It needs a live gateway (`SAND_PROFILE_DIRS` in the environment), and says so rather than measuring a demo page |

### The console inside the iPhone app (PHONE-CONSOLE-1)

Jason, 2026-09-11: *"we're going to need to address how this is laid out on Apple mobile."* The phone
pass above made the console fit a phone-sized window. It did not make it a phone layout, and the app
is where that shows: a Capacitor WKWebView over `https://console.titanium.bot` at 402x874 points with
safe-area insets of 62 top and 34 bottom.

Everything below was measured in **WebKit at 390x844, device scale 3, touch**, on
`grok-bot-local-vm`, with the phone's insets restated (59 top, 34 bottom — 59 rather than 62 because
it is the conservative number). WebKit and not Chromium, because the app is a WKWebView and mobile
Safari is WebKit; a phone-sized Chromium is a phone-sized Chromium.

**258 px of chrome stood above the first message on an 844 px screen.** 59 of status bar, 8 of bar
padding, a 44 px identity row, a 6 px row gap, a 56 px capability dock **on its own row**, 10 of stage
padding, a 62 px room capsule and 13 px of transcript margin. It is **155 px** now, and the
conversation went from 512 px to 556.

| | Before | After |
|---|---|---|
| Chrome above the conversation, insets included | 258 px | 155 px |
| The bar's own strip, below the notch | 103 px, two rows | 44 px, one row |
| The room capsule | 62 px, name over status | 32 px, name and status on one line |
| The transcript's `scrollWidth` against a 374 px client, one long URL | 585 px | 374 px |
| The same, a long chip sent through the composer | 747 px | 374 px |
| The roster drawer, open | 147.5 px tall, `#worker-stack` 0 px against 1547 px of cards | 844 px tall, 514 px of the same 1547 scrolling |
| A reader at the newest line after typing a long message | 132 px away from it | 0 px |
| The conversation band with a 336 px keyboard up | 54 px | 202 px |

**The capability dock is the composer's + menu.** Taking the dock off the bar is the only move that
buys the second row back, and squeezing it into the first was measured at 94 px of track for six
buttons — three and a half of them, behind a sideways scroll nobody would find. So the same markup is
drawn as a sheet above the shelf: seven full-width 44 px rows with their words back, the Add count
with them, and an **Attach a file** row that is the job the + button used to do by itself. Nothing
about the dock's wiring changes — every button keeps the handler `app.js` bound to it at boot — and
above the breakpoint the dock is the bar's second row exactly as it was.

The `z-index` for that sheet is on `.window-bar`, not on the dock. The bar is `position: relative;
z-index: 20`, which makes it a stacking context, so no `z-index` on a descendant can lift the sheet
above `.stage` (60) or the shelf (30) — the same trap the drawer scrim records. The bar goes to 90
while the menu is open and the scrim at 65 sits between the two.

**The insets are variables now, because a gate cannot set `env()`.** A headless browser answers 0 to
every `env(safe-area-inset-*)`, so nothing had ever measured this console on a device with a notch.
The phone block reads the four values once into `--sat`/`--sab`/`--sal`/`--sar` and uses those, and
the gate restates them with an injected `:root` rule. `env()` is still the only source of the real
number. Rules elsewhere in the sheet that still call `env()` directly — the shelf's own bottom
padding — read 0 in both gate passes, which is stated rather than hidden.

**The floor under the bar is 59 px and not the inset alone.** A shell that reports no inset on a
device that has one drew the bar's first row at y 8..52, entirely under a 59 px status band: both
drawer handles, the theme toggle and the gear. `max(calc(8px + var(--sat)), 59px)` is 67 on a phone
that answers 59 and 59 on one that answers nothing. The drawers carry the same floor, so the roster's
head clears the band in both passes (73 with insets, 59 without). The spec for this wave said 56 px;
56 leaves the row's top 3 px inside the band the gate measures, so the floor is the band.

**The room capsule keeps its 44 px targets by letting them overhang it.** 32 px of strip with a 44 px
`•••` centred in it: `.icon-button.compact` is transparent and frameless, so what a person sees is a
glyph on a strip and what a thumb gets is a full target. The overhang ends exactly where the
transcript's 6 px margin begins, so it covers no message.

**The transcript panned sideways because of a flexbox default.** `.message-row` is a flex row and its
children keep `min-width: auto`, which is min-content, so one unbreakable URL beat the row's 94 %
max-width. `min-width: 0` on the row's children with `overflow-wrap: anywhere` on the bubble is the
fix. The code chips are deliberately not in it: a command is read by copying it, not by wrapping it.

**The roster drawer was 148 px tall.** `align-self: start` at `.worker-roster` is the desktop
column's rule, and on an absolutely positioned box with `top` and `bottom` both 0 it means *do not
stretch* — the drawer shrank to its content and `#worker-stack` laid out at height 0 with 1547 px of
cards inside it. `align-self: stretch` at phone width is what `top: 0; bottom: 0` was written to mean.

#### The pin, and the keyboard's ceiling

`renderTranscript`'s own rule (CONSOLE-4) is correct and was not touched: a tapped Send still lands 0
to 1 px from the bottom, and the report that it did not does not reproduce. What was missing is that
**nothing watched the box's own height.** Typing a long message grows the composer 44 → 176 px, which
shrinks the transcript under a reader who was at the newest line and leaves him 132 px from it; a
keyboard leaves him further still.

A `ResizeObserver` on `#transcript` re-pins him, a frame later, writing `scrollTop` and nothing else —
WebKit throws *"ResizeObserver loop completed with undelivered notifications"* at a callback that
resizes anything, and a one-frame deferral with a single in-flight guard keeps this out of that class.

The rule that took two cuts: **the pin is lost by scrolling up and by nothing else.** The first cut
recomputed "is he at the bottom" on every scroll event, and measured 22 scroll events and 26 re-pins
that each landed 0 px from the bottom with the reader still ending 132 px away — because the box
shrinking under him leaves his `scrollTop` where it was and moves the bottom further down, the scroll
event that follows reports a gap, and reading that gap as *he scrolled up* skipped the 147 re-pins
after it. `scrollTop` going **down** is the reader's own drag and nothing else does it.

`--kb` is written with a ceiling: whatever leaves the conversation 180 px with the composer at its
own keyboard cap of three lines. Unclamped it wrote 336 px of shelf padding and left a 54 px band of
chat. The CSS is unchanged and still reads `var(--kb, 0px)`.

**The iPhone's own keyboard is still unmeasured.** No headless browser can raise one. The clamp is
built to the platform rule and asserted against a simulated `visualViewport` resize, the same way
MOBILE-1's own keyboard leg is, and that is the whole of the claim.

**A way back to the newest line**, which this console never had: a `Newest` button in
`.conversation-space` — which is `position: relative` and which `renderTranscript` never rebuilds —
shown only while the reader is parked up **and** a row has arrived since, toggled by `hidden` and
never by `style.display`. Not in `.voice-overlay`, which is `pointer-events: none` and could not be
pressed, and not in the composer's grid, which is what moves the footer.

#### What this leg does not cover

The code chips in the transcript measure 118x18 and 176x18 at phone width, under the 44 px floor the
rest of the console now keeps. That is **pre-existing** — it reproduces on the tree before this wave,
on the same box and the same conversation — and the honest fix is a design decision about an inline
chip inside a sentence, which belongs to the wave that owns those rules. It is filed as
**PHONE-CHIP-1** in `docs/GAP-ANALYSIS.md` rather than fixed here.


---

## 8. Inline code, and copying it

Jason, 2026-09-10, with a screenshot of the original bot's transcript beside our own: the original
writes ids, emails, channels, hostnames and whole draft lines in backticks, and each span is painted
as a small rounded chip — monospace, red-pink on a dark pill — so it stands out from white prose and
copies clean. The bot leans on it to draw the eye: *"Chief alert is in `#grok-bot-alerts`"*, and a
whole draft reply as one long chip.

Ours had the backticks and none of the chip.

**Measured before, on `grok-bot-local-vm`, this Mac, in Chrome at 1440x1000 on a live agent reply and
at 900x1400 on a static fixture, 2026-09-10 16:03–16:07 UTC:** `color rgba(255, 255, 255, 0.94)`,
`background rgba(255, 255, 255, 0.10)`, `13.8px`, `border-radius 5px`, **no border**, `overflow-wrap
normal`. That is body white on a white wash — a channel name that does not read as different from the
sentence holding it, which is exactly the complaint.

**Measured after, same box, same browser, 1440x1000, 2026-09-10:** `color rgb(255, 107, 107)` on
`rgba(10, 16, 20, 0.62)`, `1px` border `rgba(255, 107, 107, 0.3)`, `border-radius 5px`, `11.96px
ui-monospace`, `overflow-wrap anywhere`, `cursor pointer`. A 125-character draft line drew **770x36**
inside an 810 px panel: two lines, wrapped, not clipped and not overflowing.

### What changed, and what deliberately did not

`inlineMarkup` in `app.js` emits `<code class="code-chip" tabindex="0" role="button" aria-label="Copy
<the code>">`. **That is the whole renderer change.** No linkifier, no fenced-code block handler — both
are obvious, neither was asked for, and both are new behaviour rather than preserved behaviour. A bare
URL and a markdown link render exactly as they did before this wave, which is to say plainly, brackets
and all; a fenced block is still literal paragraphs. If either of those is wanted it is its own gap row,
with its own before-and-after.

**The code comes out of the line before the emphasis passes and goes back after them.** Each backticked
span is replaced by a NUL-wrapped index, the bold and italic patterns run over what is left, and the
chips are built from the captured strings at the end. The first build of this did the chip replace
first and left the chip's own contents in front of those patterns, so

```
`chmod +x *.sh *.py`   ->   <code class="code-chip" …>chmod +x <em>.sh </em>.py</code>
`**bold draft**`       ->   <code class="code-chip" …><strong>bold draft</strong></code>
```

and a click copied `chmod +x .sh .py` — a command a person would paste and run, silently missing two
globs. Two globs in one command and a quoted draft holding `**bold**` are exactly what the persona
sentence below asks an agent to put in backticks, so this was the common case and not a corner. Any NUL
the agent wrote is dropped before the pass, so a sentence that already held one cannot name a chip that
is not there. **A chip's text is the agent's text, byte for byte** — that is the whole point of the
copy, and `verify-console-polish --chips` now presses a chip holding two globs and compares the
clipboard string to what was between the backticks.

**The accessible name is the code itself**, built inside the replace while the raw string is in hand.
It was `aria-label="Copy this"` for one build, and an `aria-label` *replaces* the element's contents as
its accessible name — so every chip in a transcript announced itself as the same anonymous "Copy this,
button" and the address, channel or hostname inside it was unreachable from a screen reader. Chrome's
own accessibility tree now computes `Copy chmod +x *.sh *.py`, read over CDP in the gate rather than
trusted off the attribute.

Proving that is `tests/machine-room-code-chip-pixels.test.mjs`. It renders one fixture transcript
twice in the same browser at 900x1400 over the shipped stylesheets — once through the renderer as it
stood at `b1f9afa` and once through the working tree's — and asserts that **every** `p`, `li`, `ul`,
`ol`, `strong`, `em` and heading lands on the same pixel, the same tag, the same text. A golden-string
test would not catch a linkifier creeping in. This does: the paragraph holding the bare URL would grow
an `<a>` and its children would move.

Two things that test forced, and both are in the shipped CSS on purpose:

- **The chip occupies the old box exactly.** `padding: 1px 5px` with no border became `padding: 0 4px`
  with a `1px` one — the same 5 px across and 1 px down. Without that the chip's own border pushes
  every line holding a chip 2 px taller, and "the prose did not move" stops being provable.
- **Motion is off in the fixture.** A message row arrives on a scale-and-fade; measured mid-flight the
  whole bubble reads about 0.995 of itself and every rect in it drifts by the same ratio. The first
  run of that suite failed on precisely this.

### The copy

A click on a chip copies **that chip's text and nothing else**. It copies `textContent`, never a data
attribute: `escapeHtml` runs before the backtick pass, so the markup holds `&amp;` and `&lt;` while
`textContent` is the original the agent wrote — and nothing is painted *inside* a chip, so there is no
`<em>` for `textContent` to drop on the way out. `navigator.clipboard.writeText` with a
`document.execCommand("copy")` fallback, because a relay reached over plain http on a LAN address is
not a secure context and the promise there never arrives; when both fail the chip says so with a `✕`
rather than showing a tick that lied.

The tick is **quiet and local** — a `✓` painted by `::after` on the chip for 1.2 s, not the global
toast. A person who clicked the thing they wanted does not need a banner over the conversation. The
word "Copied" goes into an off-screen `aria-live="polite"` region so a screen reader hears it; it is
set immediately when the word changes and cleared-then-set only for a repeat, because a region that is
empty for even a frame reads as nothing said. The gate caught that one.

The chip carries `tabindex="0"` and `role="button"`, so **Enter and Space copy too** — a focusable
control that does nothing on Enter is the bug the transcript's keydown listener was written to fix in
the first place.

### One rule, everywhere, including the files viewer

`files-viewer.js` draws a markdown file through this same renderer (`paragraphMarkup`, off
`window.__mrUi`), so chips appear inside the panel as well. **They copy there too**: `app.js` binds the
same delegated click and keydown to `#panel-content` as to `#transcript`. The alternative was a chip
carrying `role="button"` in one place and inert in the other, which is a control that lies to a
keyboard.

Two rules that used to paint a `<code>` are gone with this wave: `.message-bubble code` in
`backgrounds.css` and `.file-viewer-markdown code` in `files-viewer.css`. Both are dead now — every
`<code>` the console draws comes out of `inlineMarkup` and carries the class — and leaving them would
have been two rules arguing over one element with the later stylesheet winning by accident.
`backgrounds.css` loads **after** `styles.css`, which is why this is worth saying out loud.

### The colour

`--code-chip-fg: #8fd9e6` in ink, `#065561` on the light plates. They are defined local to the
CONSOLE-5 block in `styles.css`, not in `tokens.css`, which is shared and would be a needless
collision.

**CONSOLE-5b, 2026-09-10.** The first build copied the original's red-pink, `#ff6b6b`. Jason, looking
at it on his own transcript: *"change that highlighted color to something different, one of the
complementary colors we've got here, something that makes sense but blends and doesn't stand out so
harsh."* So the chip is a muted cyan now, desaturated so a paragraph carrying five chips does not
glow. It sits in the same hue family as the rest of the product instead of the one hot hue on the
page, and it reads quieter than the prose holding it rather than louder.

Be exact about where that colour comes from, because the first write-up of 5b was not. It said the
chip takes the colour the *"Accepted by the host"* chip text and the Talk button already use. It does
not. Those two are `--teal-300` and `--teal-500`, `#7fe3dc` and `#31b6b8`, about thirteen degrees of
hue away from this. What IS the brand's own is the chip's **edge**: `rgba(0, 200, 240, 0.25)` is
Signal Cyan `#00C8F0` at a quarter. The foreground `#8fd9e6` is a new value in that same family, and
it is the hex Jason's ask named. Same family and same intent as the claim; one literal more than the
claim allowed for.

They are **not** `--danger-500` (`#ff6f72`), the error colour, which the red-pink sat one shade from.
Every identifier painted in the error colour would read to Jason as a failed turn, the exact trap
`host-notes-read-as-errors.md` is about. The gate asserts the difference rather than trusting it.

A pale cyan washes out on a light plate, so the light surfaces take a deep teal of the same hue. It
has to clear the floor on **both** light plates a chip can land on, and they are not equally light:
mist's own card, and, in ink, the operator's cream bubble. **Measured on the R750 at 1440x900**,
through `https://console.titanium.bot`, 2026-09-11, on the plates those chips really land on:
`#065561` reads **5.78:1** on the mist plate `rgb(195, 218, 218)` and **5.97:1** on the dusk cream
plate `rgb(207, 220, 209)`, that second one off the painted pixels. The `#0b7a8f` the ask sketched for
the light theme is **3.42:1** and **3.53:1** on those same two plates. That second pair is arithmetic
for a colour that was never shipped, not a reading off any screen, and it is why the shipped light
value is darker than the ask. The operator's bubble is a cream plate in ink and a **dark slate** one in
mist, so in mist it takes the ink values back; without that rule the deep teal sits on that slate at
**2.12:1** by the same arithmetic, and the rose before it sat in the same place. That is a chip nobody
could read, on the one surface only an operator who writes backticks ever reaches.

**The floor is 4.5:1 and it is measured, not eyeballed.** `verify-console-polish --chips` composites
the pill down over whatever sits behind it, because the pill is half transparent and the colour
Chrome reports for its background is not the colour an eye compares the text against, and it checks
the ratio in both themes, flipping `data-theme` on the root the way the toggle does.

**That walk skips a gradient, and the operator's own bubble is one**, so for a day the single surface
5b's mist rule exists to protect was the single surface no check could read: the walk falls through
the dusk bubble to the plate behind it and reports 1.55:1 where a person gets 5.97:1. CONSOLE-5's
rose broke that same surface and the gate said nothing. So the leg has a third
contrast check now, on a chip the **operator** typed, and it reads the pixels Chrome painted instead
of the computed styles: the shot is clipped to the chip's own box, the colours are counted in the
page, the commonest is the plate and the 2nd percentile of luminance is the ink. The ASK the leg
sends now carries its own backticks, which is what puts three chips on the operator's row for it to
photograph.

**Measured after 5b, on `grok-bot-local-vm`, this Mac, in Chrome at 1440x1000, 2026-09-10:** the chip
is `rgb(143, 217, 230)` on `rgba(10, 16, 20, 0.62)`, border `rgba(0, 200, 240, 0.25)`, radius 5 px,
11.96 px `ui-monospace`, `overflow-wrap anywhere`, which is the CONSOLE-5 box to the pixel. In the
panel the ink chip clears **11.6:1** against a pill that composites to `rgb(14, 21, 25)`, and the
mist chip `rgb(6, 85, 97)` clears **5.78:1** on `rgb(195, 218, 218)`. On a live agent reply carrying
three chips, on the agent's own bubble: **11.44:1** on `rgb(15, 23, 27)`. The white prose beside it
composites to 14.5:1, which is the point: the chip is the quieter thing in the paragraph, not the
louder one.

**Measured on the R750**, through `https://console.titanium.bot` in real Chrome at **1440x900**, as a
throwaway customer on the demo tenant, 2026-09-10, on a reply this run asked for (*"Alerts go to
`#titan-alerts` on `titan-box-01` and mail lands at `titan@myagents.email`."*): three chips at
`rgb(143, 217, 230)` on `rgba(10, 16, 20, 0.62)`, `1px` border `rgba(0, 200, 240, 0.25)`, radius
5 px, 13.8 px `ui-monospace`, `overflow-wrap anywhere`, `cursor pointer`, the first one 118x18. Ink
**11.44:1** against a pill compositing to `rgb(15, 23, 27)`; flipped to mist on the same row,
`rgb(6, 85, 97)` on `rgb(195, 218, 218)`, **5.78:1**. Shipped relay-only: no host bundle change, no
box swap, the relay restarted last.

**Review pass, 2026-09-10.** Three things in the paragraphs above were wrong and are corrected here:
the chip's provenance (it is a new value in the cyan family, not the colour two existing controls
use), four contrast figures that were arithmetic rather than readings, and a gate that could not see
the operator's own bubble at all. Only prose and the gate changed; the four tokens are the ones that
shipped. **Measured on `grok-bot-local-vm`**, this Mac, real Chrome at 1440x1000, against a local
relay on a spare port serving this tree: `verify-console-polish --chips` **27 passed, 0 failed, 0
skipped**, the two new checks reading a chip on the operator's own row off the painted pixels at
**5.97:1** in dusk, ink `rgb(9, 87, 99)` on plate `rgb(210, 223, 212)`, and **11:1** in mist, ink
`rgb(141, 214, 227)` on plate `rgb(16, 24, 28)`, 1596 pixels each. That plate moves a shade with
whichever background picture the console happened to draw, so the dusk figure wobbles by a few
hundredths between runs: the run before this one read 6.03:1 on `rgb(211, 224, 214)`.
`tests/machine-room-code-chip-pixels.test.mjs` still passes.

**Re-shipped relay-only and re-measured on the R750**, through `https://console.titanium.bot` in real
Chrome at **1440x900**, as a throwaway customer on the demo tenant, 2026-09-11, on a reply this run
asked for (*"The channel is `#chip5c-c5c208`, the host is `chip5c-box-01` and the address is
`chip5c@myagents.email`."*): the served `styles.css` is 160,808 bytes and carries `#8fd9e6`, `#065561`,
`#8fd9e6` as its three chip foregrounds, the agent's three chips are `rgb(143, 217, 230)` on
`rgba(10, 16, 20, 0.62)` with a `rgba(0, 200, 240, 0.25)` hairline, radius 5 px, 13.8 px
`ui-monospace`, `overflow-wrap anywhere`, `cursor pointer`, the first 126x18, and a press put
`#chip5c-c5c208` on the clipboard with the green tick and a *"Copied"* in the live region. On the
agent's bubble: **11.44:1** computed, **11.58:1** painted in dusk; **5.78:1** computed, **5.65:1**
painted in mist. On the **operator's own** bubble, the surface the new checks exist for: dusk
**5.97:1** painted, ink `rgb(6, 85, 97)` on plate `rgb(207, 220, 209)`, where the composite walk says
1.55:1 because it cannot see the gradient; mist **11.33:1** painted, ink `rgb(143, 217, 230)` on plate
`rgb(15, 24, 28)`, **11.28:1** computed. Both themes, both bubbles, over the 4.5:1 floor. Shipped
relay-only: no host bundle installed, no box swap, no Coolify action, the relay restarted last, and
the throwaway account removed afterwards.

Nothing else about the chip moved with 5b: the box, the radius, the monospace stack, the wrapping, the
click that copies, the tick and the accessible name are the CONSOLE-5 values, and
`tests/machine-room-code-chip-pixels.test.mjs` still holds every other node on its old pixel.

### The habit that fills the chips

A chip is only worth having if the model reaches for backticks. One sentence went into the standing
persona's general block, next to the marketplace paragraph, since both are habits rather than facts:

> Identifiers, addresses, channels, hostnames, file names and any draft I am quoting back go in
> backticks, so they stand out from what I am saying and copy clean; ordinary prose stays plain.

It names no colour, no chip and no console. Naming a surface in the prompt is how a tool name ends up
on somebody's screen, which is the PERSONA-1 failure that file exists to stop.

**This sentence lives in the host bundle**, so it is the one thing in this wave that is not
relay-only — see the note in §5. Until a box takes the swap, the chips are there and the model has to
be asked for backticks to fill them.

### The gate

```
node scripts/verify-console-polish.mjs --chips
```

Two sub-legs, because they prove different things:

- **The panel, always.** The markup is rendered by the *page's own* `paragraphMarkup` into the panel
  the files viewer uses — a real surface with the real delegated handler, and unlike the transcript it
  is not wiped by the next render poll, so a hit test and a clipboard read mean something. The press
  is a real mouse at the chip's own centre after a hit test, not `page.click()`.
- **The live reply, when the box answers.** It asks an agent for a channel, a hostname and an address
  in backticks and measures the chips in the real transcript. It prints, in the run, that it is
  proving the *renderer* against a prompted reply — the habit is the persona sentence and belongs to
  the swap. When no reply arrives inside the budget it **skips with that reason**, never a pass.

The leg also prints which build it ran against. The local relay serves whatever checkout it was
started from; when that is an older build the leg serves `app.js`, `styles.css`, `backgrounds.css` and
`files-viewer.css` out of the working tree and **says so**, because "it works when I serve it" and "it
works on the page" are two different claims. It matches those files with a RegExp rather than a glob,
since `index.html` stamps a cache-busting `?v=` on every stylesheet — the first run of this leg served
its own `app.js` and the relay's older CSS and reported the chip as body white with no border, which
was the old rule and not this build at all.

**Measured on `grok-bot-local-vm`, this Mac, Chrome 1440x1000, 2026-09-10: 22 passed, 0 failed, 0
skipped**, including a real agent's reply drawing six chips at `rgb(255, 107, 107)`, a mouse press
putting `#titan-alerts` on the clipboard, a press on `chmod +x *.sh *.py` putting that command on the
clipboard whole, and Chrome computing the accessible name `Copy chmod +x *.sh *.py`.

`verify-console-polish.mjs` also gained the gate user agent it never sent. It now identifies itself as
`titanbot-gate/verify-console-polish` on every API call and as the browser's real `userAgent`, so a
traffic or cost reading taken afterwards can tell a gate from a person. It was the only gate in the
repo importing nothing from `scripts/gate-agent.mjs`.

| Gate | What it covers |
|---|---|
| `node --test tests/machine-room-markdown.test.mjs` | the renderer's own shape: the chip's class and its keyboard attributes, that the accessible name is the code, that a chip holding asterisks keeps them and holds no tags, that a chip is still escaped inside itself, that `overflow-wrap: anywhere` and `cursor: pointer` are in the shipped rule, that the chip is never `--danger-500`, and that nothing else styles a bare `code` any more |
| `node --test tests/machine-room-code-chip-pixels.test.mjs` | before and after in one browser: every non-chip element on the same pixel, no linkifier, no fenced-code handler, the chips the only nodes whose colour moved, and the long chip wrapping inside the bubble |
| `node --test tests/machine-room-files.test.mjs` | that the viewer still renders through the same renderer |
| `node --test tests/standing-persona.test.mjs` | that every agent, not only the lead, is told to use backticks, and that the sentence names no surface |
| `node scripts/verify-console-polish.mjs --chips` | the chip in a real browser: its paint against the measured before, a real mouse press, the clipboard read back, the tick, the live region, Enter on a focused chip, and a real agent's reply |

## 9. The approval card (COMMAND-CARD-1)

Jason kept a screenshot of the original product's card for a shell command and said "which I thought
was cool." Ours carried the request and two buttons and nothing else. Measured on
`grok-bot-local-vm` in real Chrome at 1440x1000 on 2026-09-10 at 16:05 UTC, against an approval
really forced out of the host rather than a mock, the old card was **498x132** and read:

> Echo hello-from-rac in shell on Grok Bot's computer | Violates the instruction to ask the user
> before running any shell command. — echo hello-from-rac | Approve | Deny

No pill, no line saying whose computer it runs on, no disclosure, no elision, no always-allow, and
the dead upstream's name on a customer's screen. Once answered it collapsed to the title plus "You
approved this", so a person had no way to see afterwards what it was they had allowed.

### The shape, and where each line comes from

```
  Titan wants to run a command                        [ Needs your yes ]
  Runs on Titan's computer
  Post Chief Sentry decision alert to Jason
  Violates the instruction to ask the user before running any shell command.
  Always allow adds this rule to your Auto-review settings: "…"
  > Show the command
  [ ✓ Allow ]  [ ↗ Always allow ]  [ ✕ Refuse ]
```

| Element | Source |
|---|---|
| The title | `approval.surface`, turned into a plain sentence and never shown as a token. `host_shell` and `box_shell` are "wants to run a command"; `mcp` a connector; `computer` the computer; `browser` the browser; `automation_write` a routine; `cloud_agent` a cloud agent; `subagent` a task. A surface this console has never heard of reads "wants your review" |
| The pill | `approval.status`, and for the two green ones the host's saved allow list as well |
| "Runs on X's computer" | `approval.surface` again: `host_shell` is the person's own machine ("Runs on your computer"), everything else is the agent's box |
| The request sentence | `approval.summary`, with its trailing location clause stripped — see below |
| The grey "why" line | `approval.reason`, and **only while the card is pending**. On a card the person has answered, the reason it was asked reads as a complaint about their answer |
| The rule paragraph | `approval.proposedRule`, and only when there is one. Most approvals have none |
| The disclosure | `approval.command`, capped at 400 characters shown |
| The buttons | `DECISION_ACTIONS["auto-review"]`, with Always allow filtered out when there is no rule to save |

`cardOf` in `ui/machine-room/gateway-adapter.js` used to join the reason and the command into one
`detail` string, which is why the card could draw neither as its own thing. It now carries
`command`, `reason` and `surface` as their own fields; `detail` stays for anything still reading it.

### The five pill states

| Pill | When | Colour |
|---|---|---|
| Needs your yes | pending | `.status-pill attention`, the amber the needs-you pill already uses |
| Always allowed | approved, **and** this approval's own proposed rule is on the host's `allowInstructions` | `.status-pill success` |
| Allowed once | approved, with no such rule on the list | `.status-pill success` |
| Refused | denied, and **only** denied | `.status-pill muted` |
| No longer waiting | anything else the host settled it as — `expired`, `error`, `cancelled`, `timeout` — with the line "The host closed this without an answer." under the request | `.status-pill muted` |

**Only a refusal reads Refused.** `expired` is a status the host writes by itself and in bulk:
`expireAllPendingAutoReviewApprovalCards()` runs at **host start**, so a bundle swap, a restart, a
session end, a settings change or a cancel turns every unanswered auto-review card in a transcript into
one. For one build this page drew those as "Refused", which tells a person they refused something they
never saw — and this wave's own ship, `updateHostNow` inside two boxes, is exactly the event that
produces them. The sibling kinds in `decisionMarkup` were already honest about it ("Closed by the host
— expired"); this card now says the same thing in its own words.

Nothing on this card is painted in the error colour. An approval that is merely waiting is not a
failure, and a coloured line under a reply gets read as one.

"Always allowed" is derived from the host's live settings rather than remembered from the button
press, so it survives a reload and stays true. The edge that buys: if a person granted the same rule
on an *earlier* approval and then answers a second one by hand, the second card reads "Always
allowed" too. The sentence it prints is still true — a rule always allowing this really is in their
Auto-review settings — and the alternative, a flag that dies with the page, would be false after
every reload.

### The location clause, and the old product's name

The host writes the location into its own summary, and it writes it with the **old** product's name:
`source/host/runner/sand-auto-review-summaries.ts` says "on Grok Bot's computer" in five places. That
summary is the card's title and is also what a push notification puts on a lock screen. The console
strips `on <someone>'s computer` (or `on your local computer`) off the summary to get the request
sentence, and draws the clause itself as the grey line with **this agent's** name in it. That is both
the original's own shape and the console half of taking a dead vendor's name off a customer's screen.

**It is not anchored at the end,** because two of the host's five summaries do not put the location
there. The subagent one writes `Run a task on Grok Bot's computer: “<instruction>”`
(`sand-auto-review-summaries.ts:249`), the surface this card knows by name as "Titan wants to start a
task" — so an end anchor left the card reading "Run a task on Grok Bot's computer: “check the mail”".
And the shell one, which is the commonest card there is, appends the working directory **after** the
clause: `describeSandShellAutoReviewAction` builds `` `${head} ${location} from ${cwd}` `` whenever the
agent passed a cwd, so "Echo hello on Grok Bot's computer from /workspace" walked past both the end
anchor and the build after it that only looked for a colon or a comma. The clause comes off in the
three shapes the host actually writes — at the end of the sentence, where it takes its full stop with
it; before a colon or a comma; and before the ` from <cwd>` the host writes after it. A following word
the host does **not** write is left alone, so nothing that merely contains those words is touched:

| summary the host writes | request sentence |
|---|---|
| `Run a command on your local computer` | Run a command |
| `Post an alert to Jason on Titan's computer.` | Post an alert to Jason |
| `Run a task on Grok Bot's computer: “check the mail”` | Run a task: “check the mail” |
| `Echo hello-from-rac in shell on Grok Bot's computer from /home/sem/work` | Echo hello-from-rac in shell from /home/sem/work |
| `Walk on Titan's computer floor` | unchanged — only a location comes off, not any run of those words |

**And the answer in flight is the same card's words.** While a press is on its way to the host,
`decisionMarkup` draws a one-line "Sending your answer…" card — held for a whole round trip on Allow
and Refuse and for three sequential gateway calls on Always allow (`getHostSettings`,
`setHostSettings`, `resolveAutoReviewApproval`), so it is a screen a person reads rather than a flicker.
It printed `card.title` raw for one build, which put "on Grok Bot's computer" back on the screen on
every press; it now prints `cardPushTitle(card)`, the same helper the lock-screen title uses.

The five host strings are **NAME-1's**, not this card's, and they are still there.

### The disclosure and the elision

`<details class="tool-receipt approval-command">`, the same disclosure the tool receipts use, so it
inherits the hidden marker, the wrapping `<pre>` and its 220px clip. Its two words swap on `[open]`
in the stylesheet with no script behind them: the transcript wipes its own `innerHTML` on every
render, so a handler bound to that element would not survive one poll.

400 characters are shown and the rest is counted in the original's own words, head and tail around
the label rather than a truncation, because the end of a long command is where the interesting
argument is:

```
<first 200 characters>
...[N chars omitted]...
<last 200 characters>
```

`N` is the real remainder, so what is shown plus what is counted adds back up to the command. A
766-character command elides to `...[366 chars omitted]...`, measured in the browser.

The disclosure is drawn in **every** state, not only while pending. The branch this replaced threw
the command, the rule and the request away the moment a person answered.

### Always allow is two calls, and the order matters

The host's resolution vocabulary is `"approved" | "denied"` and nothing else
(`source/host/runner/sand-auto-review.ts`), so always-allow is not a resolution. It is:

1. `getHostSettings` — read the instructions **live**, in the same breath. `setHostSettings` replaces
   the whole `autoReviewInstructions` object, and the settings panel may have a block list in
   flight; writing from this page's copy would silently undo it.
2. `setHostSettings` — the same object with the proposed rule appended to `allowInstructions`.
3. `resolveAutoReviewApproval` with `"approved"`.

If the settings write fails nothing is resolved: the card goes back to pending and says the rule was
not saved. Approving anyway would grant the action while quietly dropping the standing permission
the person actually asked for. And with no proposed rule there is no Always-allow button at all,
because there would be nothing to write.

### What was measured, and where

On **`grok-bot-local-vm`** (this Mac, real Chrome through `playwright-core`, 1440x1000,
2026-09-10), `node scripts/verify-console-polish.mjs --approval`: **51 passed, 0 failed, 0 skipped**.

- The five states, drawn by `app.js`'s own `decisionMarkup` sliced out of the shipped file and run
  on the shipped stylesheet — not a mock of it. Card heights at 1440x1000: pending with a rule
  512x257, pending without 512x218, always-allowed 512x180, allowed-once 512x141, refused 512x141.
  Pill colours `rgb(231,162,60)` amber, `rgb(166,233,185)` green, `rgba(233,239,239,0.46)` grey.
  Every button hit-tested where it lands: Allow 73x34, Always allow 112x34, Refuse 79x34, and the
  disclosure's summary 460x15. Picture: `approval-states.png`.
- **One real approval**, forced end to end. The box was armed the way `scripts/verify-review.mjs`
  proved — `SAND_AUTO_REVIEW_MODE=enforce` in its settings file, which REVIEW-1 made resolve per
  call so nothing restarts, plus one block instruction through `setHostSettings`. A scratch agent
  asked to run `echo hello-from-command-card` raised a pending approval in **27.1 s**, surface
  `box_shell`, **no proposed rule** (which is the ordinary case). The console drew the new card at
  **460x226**, reading "probe-command-card-2kmme wants to run a command", "Runs on
  probe-command-card-2kmme's computer", the request, the reason, the disclosure with the command in
  it, and Allow / Refuse. Allow was hit-tested and then really pressed; the card came back
  **approved / "Allowed once"** with the command and the request still on it and no buttons.
  Pictures: `approval-live-pending.png`, `approval-live-settled.png`.
- **The two calls behind Always allow**, made against the live host in the adapter's own order: the
  rule landed in `allowInstructions` and the block list the settings panel owns survived the write.
  This is the settings half, not a button press — the host proposes no rule for a plain `echo`, so
  there was no live Always-allow card to press, and the leg says so in its own output.
- The box was put back and checked: no gate instruction left in the allow or block lists, the review
  mode back at its original value, the scratch agent gone from the roster.

**The gate needs the files under test to be the files being served.** The relay on `127.0.0.1:7777`
serves the shared checkout, so a first run measured the injected renderer against the *old*
stylesheet and reported the disclosure toggle broken and the live card missing. The leg was re-run
against a second relay started from the worktree
(`SAND_UI_PORT=7788`, `SAND_UI_STATE_DIR` pointed outside the tree) with
`SAND_GATEWAY_URL=http://127.0.0.1:7788`. Both relays talk to the same box. That is the honest way
to read any browser leg on this branch while several waves share one checkout.

Still to measure: one turn on the R750 demo tenant through `console.titanium.bot` as a throwaway
customer. That is the ship's leg, not the builder's.

---

## 10. What the console polish 3 ship measured

Shipped 2026-09-10 as merge commit `be6d4b0`. Unlike CONSOLE-4 this one moves the host bundle, for
one sentence: the standing persona's backticks line. So the ship was a relay sync, then
`updateHostNow` inside **exactly two boxes** — the demo box `titanbot-box-atonqjq7zx593jsacaccpfau`
and Jason's box `titanbot-box-p927bfqm83ioloibamlvyd7g` — and the relay restarted **last**.
Richard's box was not touched and answered `f82ee6bf780a` afterwards, the version it was already on.
Both swapped boxes wrote their own line: `post-swap watch disarmed: host up 60075ms on
be6d4b071c58 (healthy)` and `... 60079ms on be6d4b071c58 (healthy)`, and both then reported
`hostVersion be6d4b071c58` with `hostUpdateAvailable false`. Neither box was recreated, redeployed or
restarted through Coolify, and no box had an agent mid-turn when it took the swap.

### On this Mac, `grok-bot-local-vm`, real Chrome through playwright-core at 1440x1000

| Gate | Result |
|---|---|
| `npm test` | **3,087 passed, 0 failed, 0 skipped** on the merged tree |
| `npm run source:typecheck` | clean |
| `git diff <shared tip>..<merge> -- source/ deploy/` | one file, `standing-persona.ts`, 9 lines |
| `verify-console-polish --chips` | **17 passed, 0 failed** |
| `verify-console-polish --approval` | **51 passed, 0 failed**, including one real forced approval end to end |
| `verify-console-polish --tile-live` | **12 passed, 0 failed**; the tile followed a page change in **1.01 s**, and the bytes are a range rather than a number — see below |
| `verify-console-polish --tile --files` | **24 + 4 passed, 0 failed** after the integration fix below |
| `verify-console-polish --boot --scroll --picker --badge` | **10 passed, 0 failed** |
| `verify-persona` | **13 of 13**, 63 s. An earlier run in the same hour reported one failure — the last question's turn timed out at 93 s while three gates were sharing this box — and that is the box's endpoint, not the prompt |
| `verify-dashboard` | **158 passed, 16 failed**, and the SAME sixteen in the same order on a clean tree at the shared tip. Not one of them belongs to this wave; DASH-7 carries the list |

**The tile's bytes swing, so they are quoted as a range with the run that produced each one.** Every
figure here is websocket bytes at **1440x1000 on `grok-bot-local-vm`, this Mac**, through
playwright-core with CDP frame accounting. A grab is a whole framebuffer and costs whatever is on the
screen, which is why a single run is not a number to plan with:

| | across runs | the ship's run | reruns the same day |
|---|---|---|---|
| a forced working minute | **6.2 to 137.1 KiB** (§3) | 18.8 KiB | 9.5 KiB, and 16.0 KiB over 11 frames on a third run |
| one whole page change | **21.4 to 104.0 KiB**, over 17 to 62 frames | 21.4 KiB / 17 frames | 104.0 KiB / 62 frames, and 24.2 KiB / 21 frames on a third run |
| an idle grab | **17.5 to 18.8 KiB** on a settled desktop, 75.0 KiB over a photo-heavy page | 18.6 KiB | 18.8 KiB |
| a hidden tab, and the rail at 390x844 | **0 B**, 0 readers, every run | 0 B | 0 B |

The latency is the stable half: **0.76 s to 1.01 s** from the launcher returning to a changed frame,
across the same runs, bounded by the 3 s live cadence. The earlier version of this table printed one
run's working minute and idle grab as if they were the quantity, with §3 a thousand lines up being
honest about the spread; the table is where a reader stops, so the spread belongs here.

### On the R750, through `https://console.titanium.bot` at 1440x1000

Signed in as a **throwaway customer account** minted inside the cp container on the demo workspace
and removed afterwards. The console answered on bundle `be6d4b071c58` throughout.

**The chips, and the habit behind them.** Titan was asked for its address and the hostname of its
computer. Nothing in the ask mentioned formatting, and the reply came back *"My email address is
`agent247758@myagents.email`. The hostname of the computer I'm on is `0e6e57702ef1`."* — the persona
sentence doing its work on a live instance. The console drew two chips in that reply at
`rgb(255, 107, 107)` on `rgba(10, 16, 20, 0.62)`, `1px` border `rgba(255, 107, 107, 0.3)`, 13.8px
ui-monospace, `overflow-wrap: anywhere`, `cursor: pointer`, 226x18. A real mouse press at the chip's
own centre put exactly `agent247758@myagents.email` on the clipboard, and the chip showed its own
tick rather than a banner.

**The tile.** A picture landed in the tile with nobody clicking it, captioned "as of 1 s ago". A real
turn then moved the screen — the customer asked for `example.com`, then for the Wikipedia article —
and the tile followed with no click; both frames were written to disk and looked at, and they are
Example Domain and then the Titanium article, which is Jason's complaint in reverse.

Two numbers, and they measure different things:

- **0.51 s**, the tile's own latency, measured the only way it can be measured honestly: by driving
  the demo box's browser directly so the moment of the change is known, with the screen settled first
  (two reads four seconds apart, 4,983 characters both times). 1.08 s counting the probe's own ssh
  and `docker exec`, which an agent on the box does not pay.
- **12.9 s** from the ask, through a real turn. That is the model deciding and the page loading, and
  it is *not* the tile. Through a turn there is no observable instant at which the screen changed —
  the transcript row does not name the page — so a turn cannot produce the five-second number, and
  the honest thing is two numbers rather than one flattering one.

Between turns a reader was up for **20% of the samples over 30 s**, where a held stream would be
100%: the idle tile really is a photograph every half minute rather than a standing stream of
somebody's desktop.

**The approval card, and the half of it the R750 could not show.** The five states were drawn by the
`app.js` the R750 itself serves (536,383 characters, fetched from `https://console.titanium.bot/app.js`)
on the live stylesheet inside the live console: pending-with-rule **512x257**, pending-without
**512x218**, always-allowed **512x180**, allowed-once **512x141**, refused **512x141**; pill colours
amber `rgb(231,162,60)`, green `rgb(166,233,185)`, grey `rgba(233,239,239,0.46)`; "Runs on Titan's
computer"; a 766-character command elided to `...[366 chars omitted]...`; and the dead upstream's
name on none of the five.

A live card from a real turn **could not be measured**, and the reason is a defect worth more than
the measurement was. Armed the way the local gate arms — enforce in the box's own settings file, one
block instruction through `setHostSettings` — a scratch agent asked to run `echo hello-from-the-ship`
was told *"Auto-review blocked ... An error occured while classifying this action. Please review
manually"*, twice, and an explicit escalation with `request_smart_mode_approval: true` came back
rejected the same way. The box's own log says why, and it is not the network:

```
[sand][auto-review] {"action":"shell","layer":"model","decision":"error","ms":1,
                     "why":"Cannot read properties of undefined (reading 'map')"}
```

One to two milliseconds, seven times: it throws before any inference call. The same forced approval
on `grok-bot-local-vm` raises a card in 24 to 27 s, and the demo box's log holds no successful
`layer:"model"` line in its entire history — nobody had ever exercised that path on a tenant box.
The customer-visible shape of it is worse than a missing gate leg: a person who turns Auto-review on
and writes one rule gets every command refused with a sentence telling them to review manually, and
nothing to review. Filed as **AUTOREV-CLASSIFIER-1**, owned, with the next action on the row.

Everything the probe armed was put back and checked afterwards: no allow or block instruction left on
the host, `SAND_AUTO_REVIEW_MODE` removed from the demo box's settings file (back to its original 71
bytes), every scratch agent deleted, and the throwaway account removed from the workspace.

### What the integration itself changed

Merging the three items onto one tree turned the old `--tile` leg red, and two real holes were under
it rather than a stale expectation — `forget()` and the plate that never came back. Both are in §3.
The gate also learned to open a conversation with a second click, because Playwright's element click
on a roster card silently does not take on this box and three runs read a plate off another agent's
tile before that was named.

### The review pass over this ship, and what it found (2026-09-10, after `be6d4b0`)

A skeptic read the shipped files rather than the claims, and six things came back. Five were in the
first pass, `280d412`:

- **A chip holding asterisks was rewritten by the passes after it.** The chip replace ran first, so
  the bold and italic patterns then ran over the chip's own contents: `` `chmod +x *.sh *.py` `` drew
  as `chmod +x <em>.sh </em>.py` and a click put `chmod +x .sh .py` on the clipboard — a command a
  person would paste and run. §8's promise that a click copies the chip's text and nothing else was
  false for exactly the input the persona sentence asks for ("file names and quoted drafts"), and no
  fixture in the gate had an asterisk in it. The code now comes out of the line as a NUL-delimited
  placeholder before the emphasis passes and goes back after them.
- **A chip's accessible name was "Copy this".** `aria-label` replaces an element's contents as its
  name, so every chip in a transcript announced itself as the same anonymous button and the address,
  channel or hostname inside it was unreachable. The name is built from the code now, and the gate
  reads it out of Chrome's own accessibility tree over CDP.
- **An approval nobody answered said they had refused it** — the pill table above, now honest about
  `expired`.
- **The answer in flight printed the host's raw summary**, which put "on Grok Bot's computer" back on
  the screen on every press of Allow, Always allow and Refuse, and that sixth state was in no gate.
- **The tile's cost table quoted single runs** of a quantity §3 had already measured swinging five- to
  twenty-fold, and the gate's INFO line added a 1440x1000 figure to a 390x844 one to get an "all in"
  number that described no machine. §10's table is ranges with the run that produced each, and
  nothing is added across viewports.

The sixth is this pass. **The clause strip was still leaving the old name on the commonest card there
is.** The first fix let the clause come off before a colon or a comma as well as at the end, which
covered the subagent summary — but `describeSandShellAutoReviewAction` appends the working directory
*after* the location, `` `${head} ${location} from ${cwd}` ``, whenever the agent passed a cwd. So
"Echo hello-from-rac in shell on Grok Bot's computer from /home/sem/work" kept the vendor's name in
the request line of every shell approval that ran somewhere in particular, and the gate's five (then
six) fixture states all used the no-cwd title, so it passed. The strip now also comes off before the
` from <cwd>` the host writes, which is the third and last shape the host has; a following word the
host does not write is still left alone, so "Walk on Titan's computer floor" keeps every word.

**Measured on `grok-bot-local-vm`, this Mac, real Chrome through `playwright-core` at 1440x1000,
2026-09-10 21:0x UTC:** `npm test` **3,112 passed, 0 failed, 0 skipped**; `verify-console-polish
--approval` **60 passed, 0 failed, 0 skipped** — seven drawn states now (the seventh is `with-cwd`,
512x218, whose request line reads "Echo hello-from-command-card in shell from /workspace"), the
"dead upstream's name is on none of the seven" leg over all of them, plus one real forced approval
end to end: the host raised a pending card in **24.1 s**, the console drew it at 498x242, Allow was
hit-tested at 72x33 and pressed, and it came back "Allowed once" with the command still readable. The
box was put back — 0 allow, 0 block, `SAND_AUTO_REVIEW_MODE` back to null, scratch agent deleted.
`verify-console-polish --chips` **22 passed, 0 failed**, including Chrome computing the chip's name as
`Copy chmod +x *.sh *.py` and a real mouse press putting that command on the clipboard whole. Without
the one-line regex change `tests/console-approval-card.test.mjs` is 26 passed / **1 failed**, so the
new cases are load-bearing rather than decorative.

**Measured on the R750, through `https://console.titanium.bot` at 1440x1000, signed in as a throwaway
customer account minted inside the cp container on the demo workspace and removed afterwards (0 rows
left for that address):** 21 passed, 0 failed, 0 skipped, every assertion drawn by the `app.js` the
R750 itself serves (540,934 characters, fetched from the page). The nine states: pending-with-rule
512x257, pending-without 512x218, always-allowed 512x180, allowed-once 512x141, refused 512x141,
closed-by-host 512x165, sending 512x67, subagent 512x218, **with-cwd 512x218 whose request line reads
"Echo hello-from-the-review in shell from /workspace"** — the directory kept, the location gone, the
grey line still "Runs on Titan's computer". Pills amber `rgb(231,162,60)`, green `rgb(166,233,185)`,
grey `rgba(233,239,239,0.46)` for both Refused and No longer waiting, and the dead upstream's name on
none of the nine. The chip was re-read on the live page in the same session: `chmod +x *.sh *.py` with
no tags inside it, Chrome computing its name as `Copy chmod +x *.sh *.py`, and a real mouse press at a
138x16 chip putting the command on the clipboard whole.

**A live approval card from a real turn still cannot be measured on that tenant.** The demo box's
classifier throws before any inference call (`AUTOREV-CLASSIFIER-1`), so no card can be raised there at
all; the local box raises one in 24 s and that is where the end-to-end press is measured. The leg that
is blocked is named on the row rather than quietly skipped.
