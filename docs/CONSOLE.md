# The console: how it comes up, what it folds away, what it shows of a screen, and how a file opens

Gap row `CONSOLE-4`. Four things Jason wrote down on 2026-09-08 after using
`console.titanium.bot` for a day, and what the console does about each of them now. His words are
quoted where they set the requirement, because they are the requirement.

This document covers the boot sequence, the between-chats badge, the rail's screen tile and the
files viewer. The hand-off card those last two sit beside is `docs/HANDOFF.md`; the console's wider
contract is `docs/DASHBOARD-CONTRACT.md`.

Gate: `scripts/verify-console-polish.mjs`, one leg per complaint, in a real browser.

---

## 1. Boot

> "When the page loads, console.titanium.bot initially shows the original background with the
> mountains, then reloads with whatever background the user chose."

**The cause was load order, not the default.** `backgrounds.js` has read `titan-nebula` since
`5637e4b` and the relay serves that byte for byte. But `index.html` chained
`__bootMachineRoom -> app.js -> backgrounds.js`, so nothing set `data-bg` until fourteen serial
gateway round trips had finished, and `styles.css` painted `assets/warmwind-landscape.svg` for the
whole of that. Measured on `grok-bot-local-vm` over loopback on a warm box: **1,183 ms of mountains
with no saved choice, 1,309 ms with `habitat-3` saved**. His console runs those round trips at 77 to
128 ms TTFB rather than loopback, so his flash was longer than either number.

**The sequence now.**

1. A blocking `<script>` in `<head>`, **before the stylesheet links**, reads the saved choice out of
   `localStorage` and stamps `data-bg` and `--machine-room-bg` on `<html>`. Before the links and not
   after: a classic script placed after a `<link>` waits for that stylesheet to load, which would
   put it back behind the paint it is there to beat.
2. `styles.css`'s floor is flat brand Midnight, not a photograph. A browser with site data blocked,
   or one that throws on the storage accessor, gets a dark ground rather than somebody else's
   mountains.
3. `#boot-cover` is **static markup in `index.html`**, so it paints with the first paint: the crew's
   Titan sprite, "Setting up your console", and one quiet step line in `[data-boot-step]`. It is
   opaque over the whole shell on purpose — `index.html` ships seed copy that is fiction on a real
   box ("MSP Team", "3 members ready", "2h 14m"), all of it on screen at 500 ms today on a box that
   has none of it.
4. It lifts on **what a person can see**, not on a promise: observers for the first roster card and
   the first transcript row.
5. **Its ceiling is its own timer**, a `setTimeout` armed at parse time, about 8 s, never chained to
   `hydrate`'s promise. `hydrate` has no `AbortController` and no per-call timeout anywhere, awaits
   every connector before it asks for the first conversation, and `CHAT-LONG-1` measured **46.3 s to
   live with one cold stdio connector**. A cover that waited on that would be a wall.
6. It carries its own failure rather than sitting over the red DEMO DATA bar: when boot resolves
   unlive it says the console could not reach this box, and lifts at once.

Reduced motion is respected: the lift is a state change rather than a transition.

**Three exits, and only three:** the console is ready, the ceiling fires, or boot resolved unlive.

**One thing deliberately not built.** A repo-wide grep for `machineRoom.background` returns two
lines, both inside `backgrounds.js`, and `getHostSettings` on Jason's box carries no background
field. There is nothing to reconcile a browser-local choice against, so the plate stays browser-local
this wave and the host-stored choice has its own gap row.

### The picker

> "Two of the backgrounds come up and you can't see them ... One just says 'The Lab', the other one
> just says 'Habitat' ... they're just blank spots."

Not blank plates — **headings wearing a tile's box**. `backgrounds.js` drew each series name as
`<p class="field-hint bg-series" style="flex-basis:100%">` inside `.bg-grid`, and `.bg-grid` is
`display: grid`, where `flex-basis` does nothing at all. Measured in real Chrome on
`grok-bot-local-vm` 2026-09-08: two `<p>` elements at **182x102** each, "Habitat" and "The Lab",
sitting in the grid between the tiles as if they were tiles. A series is a real heading row now:
`grid-column: 1 / -1`, small caps, a hairline, and the inline style gone.

The default is `titan-nebula`, the product's own plate. Measured on this Mac 2026-09-08, mean
thumbnail luminance out of 255: `crystal-dunes` 67.8, `titan-nebula` 68.6, `deep-current` 70.2,
`habitat-1` 70.4 — within a point of the darkest, and it is ours. `original` stays in the picker for
anyone who wants the mountains.

---

## 2. The between-chats badge

> "All the shell commands and everything that happens in between chats, while the agent is doing
> work, can live inside a badge, right? If I want, I can click the badge to expand it or just leave
> it shrunk inside the badge."

Everything between two chat messages folds into **one badge per gap**, collapsed by default.

**The gap predicate is one line**, because the vocabulary is smaller than it looks. Every
between-chats row is type `system` in three shapes: a plain tool row, a `SHOT-4` receipt row, and a
Messaged row. Every card that must stay outside the badge — decision, secret, connector, hand-off,
turn-failed, attachment, the working bubble — is **already another type**, so "never hide a card"
needs no special casing at all. Evidence chips render inside the reply's own row and notices are
toasts outside the transcript, so neither is between-chats content either.

**The head** reads like `Worked for 2 min · 14 steps` with the kinds summarised (`shell 6, browser 3,
read 5`). Where both bounding chat entries exist the badge says the span; where one is missing it
says the step count alone. It cannot do better: **no tool row carries a timestamp of any kind**, and
`messagesOf` keeps only a minute-resolution string.

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

Four rules the script is written under, each paid for by an earlier gate that lied:

- **A click that resolved is not evidence.** `page.click()` calls `scrollIntoViewIfNeeded` first and
  has passed on menu items no mouse could reach. Everything that claims a person can use a control
  hit-tests it: a box with area, and the element under its own centre is that element or something
  inside it.
- **Nothing is read before the adapter exists.** The static shell satisfies selectors with seed copy.
- **The rail tile's click is a write**, so that leg is local-box only.
- **`getForeverBoxStatus` takes `{ id }`**, and the tile leg asserts the difference between the two
  argument shapes rather than assuming it.

Screenshots land in `$GROK_BOT_SHOT_DIR` and every one is named in the output.

`scripts/verify-handoff.mjs --console` covers the same reader from the hand-off side and stays green;
`scripts/verify-dashboard.mjs` covers the rest of the console.
