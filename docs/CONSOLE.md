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
- **A still by default.** It refreshes about every 5 s **only while the record's status is
  `working`**; otherwise it takes one frame and lets the client go. The alternative is a standing
  screen-share of the operator's own browsing — the seat read on 2026-09-08 had Gmail, a GitHub
  account and a YouTube channel open on it. That is a privacy decision, not a performance one.
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
                                       --files    a file row opens a viewer and downloads
                                       --all      every leg in sequence, one browser
```

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
- **The rail tile's click is a write**, so that leg is local-box only.
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
| `node --test tests/machine-room-gap-badge.test.mjs` | the gap predicate (**including that an adapter notice ends a gap and is never folded away**), the headline, its kinds line in plain words and its span ceiling, the preference store, the receipt that survives a rebuild, and that the module is loaded ahead of app.js |
| `node --test tests/machine-room-screen-tile.test.mjs` | the blank-frame refusal, the reader's life, the seat argument shape, and the stylesheet's `[hidden]` belt |
| `node --test tests/machine-room-files.test.mjs` | the viewer's five branches, the masking, and the `/files` route's fences against a real relay and a real gateway |
| `scripts/verify-dashboard.mjs` | unchanged by this wave, and NOT green on `grok-bot-local-vm`. It leaves its own probe agents behind and they then fail its avatar and bot-cap legs (GATE-14), so the honest way to read it on this box is to diff its failure list against a run of the previous commit rather than to read its tally |

The ship is **relay-only by construction**: everything in this wave is `ui/`, tests, scripts and
docs. `git diff <pre-wave>..HEAD -- source/ deploy/` must be empty before shipping. If it is not,
stop and re-scope — a host swap is a different ship with a different risk.

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
