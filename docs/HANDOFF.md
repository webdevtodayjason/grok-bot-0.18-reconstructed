# The computer hand-off

*Gap row HANDBACK-1. Supersedes GW-10, which was the footer button this replaces.*

An agent hits a step only a person can do: a sign-in, an SSO prompt, a 2FA code, a captcha, a card
confirmation. It calls `request_box_help`, its turn ends, and the person takes the keyboard on the
agent's own computer. When they are finished they hand it back and the agent picks up where it
stopped. If they would rather not do the step, they skip it and the agent is told so plainly.

This file is what that looks like from all three sides: what the person sees, what the agent is
told, and what survives a reload, a restart and a compaction.

---

## 1. What the person sees

Three places, all driven by the same one pending hand-off. Never two sources, never a control in one
place that the other two do not know about.

### The card in the conversation

A row in the transcript, in the agent's own column, where the instruction landed.

| Slot | What it says |
|---|---|
| Header, left | `Computer` |
| Header, right | the state pill (below) |
| Body | the instruction, in the agent's own words, clamped to two lines |
| Under it | a live picture of the agent's screen, 390 x 244, rounded |
| Buttons, while pending | `Take over` (primary), `I'm done` (secondary), `Skip` (text, right-aligned) |
| Button, once decided | `Open computer`, with a monitor icon |

The four pill labels, and nothing else is ever drawn there:

| State | Pill | Colour | Picture | Controls |
|---|---|---|---|---|
| `pending` | `Action needed` | amber, with a spinner | live, refreshed every 3 s | Take over · I'm done · Skip |
| `done` | `Done` | green | frozen at the last frame | Open computer |
| `skipped` | `Skipped` | muted | frozen at the last frame | Open computer |
| `closed` | `No longer waiting` | muted | frozen at the last frame | Open computer |

The DOM is frozen so three builders could work at once, and gates and tests point at it:
`.handoff-card[data-handoff-card][data-request-id][data-state]`, the pill at `[data-handoff-pill]`,
the instruction at `[data-handoff-instruction]`, the picture at `img[data-handoff-thumb]`, and each
button at `[data-handoff-action=take-over|done|skip|open]` carrying `data-agent-id` and
`data-request-id`.

### The card in the right rail

While a step is pending, the top of the agent panel carries an amber card, above everything else:

- title `Needs your attention`
- the same instruction, word for word
- two buttons: `Skip this step`, then `I'm done, continue` (filled)

Under it, always, is the agent's screen tile captioned `<name>'s screen`: live while the step is
pending, a still otherwise, and the plate `Bringing the screen up` while the seat is being
allocated. The existing context card, the Now island, the desktop capsule and Routines keep their
order below it. Ids: `#rail-handoff`, then `#rail-screen` with `#rail-screen-caption`.

The roster row's needs-you pill and the conversation header's pill are the same pending hand-off,
read the same way. They were already there; they now appear and disappear with the card.

### The desktop view, after Take over

`Take over` opens the desktop view full-window with the app dimmed behind it
(`#desktop-dialog[data-takeover="1"]`). Across the top is a translucent amber banner,
`#handoff-banner`, as a third fixed row above the workspace:

- left: the instruction, in amber, clamped to two lines (`#hand-back-note`)
- right: `Skip this step` (`#handoff-skip`), then `I'm done, continue`, filled (`#hand-back`)

`I'm done, continue` hands the computer back and closes the view. `Skip this step` skips and closes.
The collapse arrow at the top right closes the view **without deciding**: the hand-off stays
pending, the card stays on `Action needed`, and the rail card stays up. That is deliberate. Closing
a window is not an answer to a question.

The view keeps its ordinary centred shape for ordinary use (the rail's desktop capsule). Only a
takeover goes full-window.

### What happens after the decision

The card flips to `Done` or `Skipped` with a single `Open computer` button, the rail's amber card
disappears, and the agent's next message arrives in the transcript **with no reload**: the console's
own tick brings it in. On a hand-back that next message is usually the agent saying what it found on
the desktop, because the first thing it is told to do is look.

---

## 2. What the agent is told

The prompt the agent is resumed with is chosen by the **resolution**, never by a raw trigger string.
That mattered: before HANDBACK-1, a skip wrote the resolution `cancelled` and resumed with the
handed-back prompt, so a skip and a done were the same thing on the wire and the agent carried on as
if the sign-in had happened.

The three prompts, verbatim. They are hidden turns: the person never sees them in the conversation,
but they do appear in the conversation outline as hidden user rows, which is how a gate can tell a
skip from a done. `source/host/extensions/transcript/box-handoff-resume.ts` is the authority; if you
are reading this after that file moved, believe the file.

**Handed back** (`handed_back`; the person clicked `I'm done` or `I'm done, continue`):

> `[The user handed the box back to you. Please continue your task — start with the read-only Screenshot tool to see the current state of the box desktop.]`

**Skipped** (`dismissed`; the person clicked `Skip` or `Skip this step`):

> `[The user dismissed your box help request without doing the step you asked for. Treat it as declined: do not assume the step happened, and do not immediately request the box again for the same step. Continue the task without it if you can — skip the step or find another way. If the task cannot proceed without it, send the user a brief message saying what is blocked, then stop and wait for their reply.]`

**Viewer closed** (`viewer-closed`; a client that closed the desktop without saying which it meant):

> `[The user closed the box desktop viewer without explicitly handing control back, so they may or may not have finished the step you asked for. Start with the read-only Screenshot tool to check the current state of the box desktop. If the step is clearly done, continue the task. If you can't tell, send the user a brief message asking whether they finished so you can keep going.]`

The console never sends the third one. The collapse arrow leaves the hand-off pending rather than
resolving it as an ambiguity, which is the honest reading of a closed window. It is kept because
other clients of the same host can send it and because a future viewer may need it.

Asking twice is refused rather than duplicated. A second `request_box_help` while one is still
pending answers the agent with the instruction it already sent and tells it not to ask again.

---

## 3. The state machine

State is a function of two things, never of one:

```
state = f(entry.boxResolution, the live pending hand-off for this agent)
```

| Live pending hand-off | Entry's resolution | State |
|---|---|---|
| its `requestId` equals the entry's | anything | `pending` |
| none matching | `handed_back` (alias: `completed`) | `done` |
| none matching | `dismissed` (alias: `cancelled`) | `skipped` |
| none matching | null, or a word nobody in this path set | `closed` |

**Resolutions written from now on are `handed_back` and `dismissed`.** `completed` and `cancelled`
are read-side aliases, because rows written before this wave are already on customers' boxes. Nothing
is rewritten on disk: the alias is four lines in the host and four in the console, and a migration
would be risk for no gain.

### Why `closed` exists

It is not decoration. Three real ways an entry ends up with no live hand-off and no resolution this
path wrote:

1. `box-request-entries.ts` silently resolves a prior entry as `dismissed` when a second request
   lands, so an entry can be resolved by a request it has never heard of.
2. The sidecar holding the live pending record can be lost (a wiped home directory on a box
   recreate, a disk that filled).
3. Old rows carry words no one in the hand-back path sets.

Without a fourth state the card has two ways to lie. It shows `Action needed` forever with three
buttons aimed at a host that has forgotten the request, or it reads `Done` on a step nobody did. The
original product had the same escape hatch and called it `Status unavailable`. We say `No longer
waiting` instead, because a person reads a status line like that as a failure (see the memory note
`host-notes-read-as-errors`).

---

## 4. What survives what

**The transcript entry is the record.** The instruction is an ordinary `send-message` entry stamped
`boxRequestId` and `boxInstruction`, later stamped `boxResolution`. It is in the agent's own
database, so it survives a reload, a host restart, a box restart and a compaction. Measured on
grok-bot-local-vm during the design pass: the entry read back after a hand-back carried its
`boxResolution`.

**The live pending record is a sidecar the hand-off service owns.** `agentId -> {requestId,
instruction, startedAt}`, written temp-file-plus-rename at 0600, removed on end and on forget, read
**synchronously** in the constructor. Synchronous is not a preference: `decorateForeverBoxStatus` in
`sand-host.ts` calls `pendingHandoff()` from a non-async method, and making that path async ripples
into every status read on the box.

`awaitingUserResponse` is already persisted in the agent's own database, so the roster's needs-you
pill already survived a restart. After this wave the card and the pill come back together.

**No picture survives anything.** The snapshot is deliberately not persisted and, since HANDBACK-1,
does not ride on the wire either. If the sidecar is lost and the entry is unresolved, the card draws
`closed` and says `No longer waiting`. That is the honest answer, not a guess.

**The status carries no image.** `getForeverBoxStatus.handoff` is
`{requestId, instruction, startedAt, snapshotAt?}` or `null`. Measured on grok-bot-local-vm:
`getForeverBoxStatus` went from 284 B to 10,013 B while a hand-off was pending **on a blank screen**,
and this box's own real screenshots are 47 to 52 KB (about 70 KB once base64'd). That payload was
pulled by `loadContext` on every 15 s heartbeat and every 900 ms-debounced stream tick. It was also
provably stale: the host still reported `about:blank` while a live read of the same seat showed the
site the agent had navigated to. `captureSnapshot` and its telemetry are untouched. It just stopped
riding the wire.

---

## 5. The thumbnail

The picture in the card and the tile in the rail are the box's own screen, read through the relay.

**How.** The relay proxies the box's noVNC at `/vnc/<display>/`, so a client mounted there is same
origin as the console and its canvas is untainted. One hidden client per open conversation with a
pending hand-off, ticked every 3 s on its own timer, pushing its data URL into a plain fixed-size
`<img>` in the card and the same one into the rail tile.

**Rules, each of them load-bearing:**

- **The card never contains the client itself.** `transcriptMarkup` rebuilds the whole list, and
  noVNC re-runs its handshake whenever its element is replaced. That is the scar `mountBoxSurface`
  already carries: it is why the desktop frame is mounted once and left alone.
- **The frozen frame is the last frame.** Kept in memory and mirrored to `localStorage` keyed
  `agentId + requestId`, so a reload still shows a `done` card's picture.
- **The display number is parsed from `getForeverBoxStatus.vncUrl`'s token and re-read on every
  mount.** Seats churn under the display number.
- **The URL is built on the page's own origin**, never the host's `127.0.0.1` form. Building it the
  host's way is the bug VNC-2 closed: through the R750 it sent the operator's browser at his own Mac
  and the frame read "Failed to connect to downstream server".
- **No seat means no picture, not a seat.** If the status has no `vncUrl`, the plate says
  `Bringing the screen up`. We never call `ensureForeverBox` to get a picture: it allocates a seat,
  and on a cold box it takes time (below). `Take over` is what allocates the seat, which is where
  that cost belongs.
- **It never blocks the transcript.** The tick runs on its own timer; a frame that does not arrive
  leaves the previous one on screen.

**Measured, all on grok-bot-local-vm (this Mac), during the HANDBACK-1 design pass:**

| Thing | Number |
|---|---|
| Time to a painted framebuffer on the agent's own seat | 1,350 ms |
| Per 390 x 244 webp at q0.6 | 5 ms, about 7 KB |
| One live client's cost | 5.8 % of one core |
| A `display:none` client | keeps painting |
| A second viewer on the same seat | does not kick the first |
| `ensureForeverBox` on a cold box | 16,277 ms, and it allocates a seat |

**Not yet measured on the R750.** Nothing in this table has been re-measured through
`console.titanium.bot` against the demo tenant box. When it is, the numbers go in the HANDBACK-1 gap
row with the machine named, separately from these.

---

## 6. The gates

`scripts/verify-handoff.mjs`, three modes, each inside the 300 s ceiling, run **one at a time**
because they share the box, the login throttle and the display. Each creates its own scratch agent
and deletes it on every exit path, including a `SIGTERM` from the `timeout` they run under.

```
node scripts/verify-handoff.mjs --host      the wire, the entry, skip, hand back. No browser.
node scripts/verify-handoff.mjs --console   the card, the rail card, the banner. A real browser.
node scripts/verify-handoff.mjs --restart   opt-in, under the shipping lock. A host restart.
```

Each mode writes its own one-page sign-in form and copies it into the box. `--host` then asks for
the hand-off and asserts on `getForeverBoxStatus.handoff` and on the transcript entry. `--console`
spends one extra best-effort turn getting that form onto the screen first, because it is the only
mode that reads a picture; it then polls for `window.__machineRoomAdapter` before reading anything
and hit-tests every control with `elementFromPoint` rather than trusting a click. `--restart` kills
the host process inside the box and asserts the same `requestId` comes back.

**The ask is one sentence and it is measured, not written.** Folding "open this page first" into it
made the agent spend the whole turn in the browser and hand nothing over, twice on
grok-bot-local-vm. The wording that works, in about 15 to 30 seconds on that box:

> I need to sign in to something on your computer myself. Hand the computer over to me for the sign-in with a one-line instruction and wait for me. Do not try to sign in yourself.

**The gate distinguishes the box, the provider and the product**, because on a shared box those get
confused constantly. `skipBoxHandoff` being unknown is the single probe for "this host predates the
wave", and on such a host every leg that measures something this wave introduced is a printed SKIP
naming it: `startedAt`, the picture on the wire, the status size, the skip itself, and the
resolution word, since `completed` is what an old host is supposed to write. A host being restarted
under the run points at the supervisor log. A full roster names the ONBOARD-1 cap. A provider that
does not answer prints its own number. And a read that FAILED is never reported as an empty answer.

`scripts/verify-dashboard.mjs` keeps its GW-10 leg, pointed at the same `#hand-back` and
`#hand-back-note` ids the banner inherited. It reads visibility through the element's ancestors now,
because the banner carries the hidden state, and it asserts the desktop view is open when it
measures so "hidden while nothing is pending" cannot pass on a closed dialog.

---

## 7. What bites

Eight things, each of which cost someone time already.

**The outline cannot carry the card.** `getConversationOutline` is prompt state: it is the model's
own turn state and compaction rewrites it. Its `send-message` rows carry no box fields and cannot be
made to, except by matching on content, which breaks the moment an instruction is compacted or
repeated. Measured while a hand-off was pending on grok-bot-local-vm: the outline held the user row,
a lead-in `send-message` and the interrupted tool call, and the instruction entry was **not in it at
all**. So the transcript tail entry is the card's home. What the outline does carry truthfully is the
END of a hand-off, because the resume arrives as a hidden user row and the skipped and handed-back
prompts are different text.

**The host's own snapshot is stale, and it is off the wire now.** Do not reach for
`handoff.snapshotDataUrl`. It is gone from the status by design, and while it was there it showed
`about:blank` on a seat that had navigated away.

**The hand-back answer time is not a signal.** `handBackForeverBox` used to await the whole revived
turn. Two readers measured the same path on the same box at 663 ms on one run and at 9,866 ms with
the socket closed at 58,917 ms on another. It is fire-and-forget after the entry is stamped and the
status emitted, so it should answer in about a second now. Do not build a wait on that number; the
console polls `getForeverBoxStatus` alongside the call and treats an RPC rejection as unknown,
re-reads the status, and never as a failure.

**A cold box takes 16 s to hand out a seat.** `ensureForeverBox` measured 16,277 ms cold on
grok-bot-local-vm, and it allocates a display. Never call it to draw a picture.

**The agent denies the tool when you ask for it by name.** Asked to call `request_box_help`, the
agent has answered that the tool was not available while the host's own `[sand][toolset]` line
listed it. Ask for the OUTCOME ("hand the computer over so I can sign in") and assert on
`getForeverBoxStatus.handoff`, never on the agent's prose. Both gates do this.

**An interrupt-and-resume can leave a conversation silent.** Measured once: after a resume, three
prompts produced nothing while a fresh control agent answered in 8 s on the same box. That is
UX-ERR-1 in a new place, and every other leg would be green on it, so both gate modes end with an
ordinary prompt that has to get a reply.

**Playwright's `page.route` wedges the console's boot.** Reproduced twice. A gate that has to doctor
an answer patches `window.fetch` through `addInitScript` instead. And a gate that reads the static
shell will happily pass against placeholder markup, so poll for `window.__machineRoomAdapter` first.

**A host that predates this wave has no Skip, and the control is hidden there rather than faked.**
`skipBoxHandoff` is a new command; if it is unknown, no Skip is drawn in the card, the rail or the
banner. The tempting fallback, `handBackForeverBox {trigger:"dismissed"}`, does reach the declined
prompt on an old host but stamps the entry `completed`, so the card would read `Done` on a step
nobody did. Every box gets the host update in this ship, so hiding only ever applies to a box someone
chose not to update.

---

## 8. The wire and DOM contract

Frozen here so it can be built against rather than discovered.

**Wire**

- `getForeverBoxStatus.handoff` = `{requestId, instruction, startedAt, snapshotAt?}` or `null`.
  No image, ever.
- `handBackForeverBox {id, trigger}` keeps its exact shape. Any trigger string other than `cancel`
  or `dismissed` means `handed_back`.
- `skipBoxHandoff {id}` is new. Resolution `dismissed`, trigger `dismissed`.
- Entry resolutions written from now on: `handed_back`, `dismissed`. Read-side aliases:
  `completed` reads as done, `cancelled` reads as skipped.

**DOM**

- Card: `.handoff-card[data-handoff-card][data-request-id][data-state=pending|done|skipped|closed]`;
  `[data-handoff-pill]`; `[data-handoff-instruction]`; `img[data-handoff-thumb][data-agent-id]` at a
  fixed 390 x 244; `[data-handoff-action=take-over|done|skip|open]`, each carrying `data-agent-id`
  and `data-request-id`.
- Rail, in this order above the existing context card: `#rail-handoff` (hidden unless pending), then
  `#rail-screen` with `#rail-screen-caption`. The context card, the Now island and the desktop
  capsule keep their order below, and no new Routines list is built.
- Banner: `#handoff-banner`, `#hand-back-note`, `#hand-back` (primary), `#handoff-skip`. Dialog:
  `#desktop-dialog[data-takeover="1"]`.

Every instruction slot and every `title` attribute goes through `escapeHtml`. The instruction is
model-written text and this card puts it in four new places.

**A naming trap.** In `ui/machine-room/gateway-adapter.js` the word *handoff* already means the
operator-supplied Machine Room frontend handoff (the file header says so). Every symbol this wave
adds to the console is prefixed `boxHandoff` or `handoffCard` so a reader six months from now cannot
confuse the two.
