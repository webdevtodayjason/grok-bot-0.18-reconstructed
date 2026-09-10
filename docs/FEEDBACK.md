# Reporting a problem to the developers

**Status:** built by Wave C, 2026-09-09. Row `FEEDBACK-1` in `GAP-ANALYSIS.md`. This file is the
contract: every name below is binding — the payload's field names, the gateway command names, the
relay route, and the words the person reads.

Jason, 2026-09-07: *"Titan tried to cover up failure. We need to instill in the agents that failure
must be reported... 'Would you like to submit this feedback to the developers?' ... it should come in
somewhere and then become a GitHub issue."*

Titan's own design, from the morning of 2026-09-09, added the shape: three tiers with automatic
routing, a structured payload, and one constraint that decided the whole architecture — **it never
goes around the operator.**

## 1. Two gates, and "operator" means the first of them

| | who | what they see | what they decide |
|---|---|---|---|
| **First gate** | the **workspace operator** — the person in the console. Jason, or a customer | every report an agent writes, in full | edit it, add context, send it, or drop it. Nothing leaves the workspace until they press Send |
| **Second gate** | the **super admin** — the developers | only what was sent, in the admin console's Feedback panel | edit, suppress, or turn it into a GitHub issue |

Tiers change **how loudly a report is shown, how it filters, and how the digest batches it, and
nothing else.** Critical, quality-of-life and observation all pass through both gates. There is no
tier that skips a person.

## 2. Why that is topology and not a rule

The agent's tool **posts nothing anywhere.** It writes a pending report into the box's own store and
returns a sentence. The console — already authenticated as the tenant — draws it, and is the only
thing that POSTs. Three guarantees fall out of that for free, and none of them is a check anyone can
forget to write:

- **No control-plane credential is ever inside a customer's container.** Both cp doors are fatal
  there: `CP_RELAY_TOKEN` reads every tenant's gateway token and derived session key, and
  `CP_ADMIN_TOKEN` deletes services. Every exec daemon in a box runs as uid 0, so a token in that
  container is readable by that customer's own agents through `/proc/self/environ`.
- **A box cannot file as another tenant,** because it never names one. The relay stamps `workspace`
  from its own registry and ignores anything in the body.
- **"The operator saw it before it left" is true by construction,** not by review.

```
agent  ──report_problem──►  <sand-data>/problem-reports.json      the box. no network.
                                    │  listProblemReports
                                    ▼
console (signed in as the tenant)   the card: editable, custody line, Send / Not now
                                    │  POST /feedback           same origin, the person's own session
                                    ▼
relay (ui/server.mjs)               stamps `workspace` from its registry, adds CP_RELAY_TOKEN
                                    ▼
control plane                       POST /v1/feedback → the Feedback panel → GitHub issue
```

## 3. ProblemReport v1

Minted identically by the agent's tool, by the automatic offer, and by the self-test.

```jsonc
{
  "version": 1,
  "tier": "critical" | "quality" | "observation",
  "category": "shell",                    // one or two words the person would recognise
  "title": "The shell refuses every command",
  "description": "…",                     // what the person read and may have edited
  "steps": ["…"],
  "tools": [{ "name": "Shell", "status": "failed", "error": "…" }],
  "evidence": {
    "agent": "<agent id>", "agentName": "Titan", "conversation": "<agent id>",
    "hostVersion": "…", "consoleVersion": "…",
    "calls":    [{ "name": "Shell", "status": "failed", "summary": "…", "output": "…" }],
    "messages": [{ "role": "you" | "agent", "text": "…" }]
  },
  "at": "2026-09-09T…Z"
}
```

`workspace` is **absent on purpose** and is filled by the relay and by nothing else.

`evidence` is built **only from the conversation outline and the transcript** — never from a file,
never from an environment, never from the two secret stores.

**Token-shaped runs are masked once, at mint time, and nowhere else.** `offerProblemReport` puts the
title, the description, every step, every tool's answer and the whole of `evidence` through the
page's own masker (`maskSecrets`) *before* they go on the offer, so the card, the body the person
edits and the payload the relay is handed are the same already-masked bytes. That is a correction:
masking used to happen at draw time, on the evidence the page built for itself, so a key an **agent**
quoted in its description or in a tool's answer was starred on screen and **sent whole** — into the
control plane's feedback table and from there into a GitHub issue body, without the person who
pressed Send ever having seen it. Measured on this Mac 2026-09-09 and pinned by
`tests/machine-room-feedback.test.mjs` ("a token an agent wrote is masked on the card AND on the
wire"), which fails against the code as it was.

**No image is carried.** The design named an optional screenshot on the card; it is not built and
nothing in the payload can hold one. A screenshot is the one piece of evidence nobody can read before
it is sent — the masker cannot see into a PNG, so the custody line above ("what you see is what is
sent, and no secret goes") would stop being true the moment one rode along. Filed as **FEEDBACK-1d**
with what it would take to do it honestly. Today: paste the words instead.

### What is carried, and what happens when it does not fit

| field | at most | over it |
|---|---|---|
| `title`, `category`, `evidence` names | 200 / 60 / 200 characters | **clamped** — they name a report rather than carry its evidence, and the person cannot edit a title on the card |
| `description` | 32,000 characters | **refused** |
| `steps` | 12, each 400 | **refused** |
| `tools` | 10, each answer 300 | **refused** |
| `evidence.calls` | 12, summary 400, output 1,200 | **refused** |
| `evidence.messages` | 6, each 800 | **refused** |

Every number is the console's own maximum or larger, and the whole point of the list is that a
console minting inside it always lands. **A field over its limit is refused with a sentence naming
it, never cut down to fit.** That is also a correction: the intake used to keep 8,000 characters of
an ordinary 15,296-character shell-failure report, drop two of the twelve calls the console mints,
cut each call's output from 1,200 to 800 — and answer 201, with nothing on any screen saying so. A
report cut in half reads as a whole one and sends whoever reads it looking for a step that was never
written down. `cp/feedback.mjs` `INTAKE_BYTES` (96 KB) is what the control plane and the relay both
read up to; a report at every limit at once is 65,671 bytes measured on this Mac, and
`tests/cp-feedback.test.mjs` fails if that stops fitting.

### What "you can edit it" actually means

The card says *"What you see below is what is sent."* That claim is kept, and it costs something:

- **Untouched** — the person approved exactly what the agent wrote, so `steps`, `tools` and
  `evidence.calls` / `evidence.messages` ride along in structured form as well as in the body.
- **Edited** — `steps` is emptied, each tool keeps its `name` and `status` but loses its `error`, and
  `evidence.calls` / `evidence.messages` are **dropped entirely.** Only the text the person left goes.

A card that says "edit anything below" and then ships an uneditable copy of what you just deleted is
a custody lie, and it is the same class of lie the credential card was rewritten to stop telling
(SECRET-1). Pinned by `tests/machine-room-feedback.test.mjs`.

## 4. The agent's tool

`source/host/runner/tools/problem-report-tool.ts`. Tool id `PROBLEM_REPORT`, name `report_problem`.

**The tool's name is never shown to the person.** In the transcript it is one quiet muted line —
`Reported a problem to the developers` — with an empty detail, so no expander and no arguments.

It is a **plain zod agent tool, not a `defineCommunicateTool` one,** and that is load-bearing. A
communicate-wrapped tool lands in the outline as `communicateUpdateToolCall`, and the console's
`NOT_A_RECEIPT` filter drops every row whose name matches `/communicate|update_state|todo|…/`. The
box-help template — otherwise the closest shape in the tree — would have produced **no chip at all,**
which is the very failure this item exists to fix. It rides the protocol's `reportBugToolCall` case,
whose fields (`title`, `description`, `severity`, `category`, `rationale`) already fit the payload.
`tests/problem-report-tool.test.mjs` pins the outline name against that filter.

**Registration** is eight edits in `turn-toolset.ts` (import, hint, factory input, provider hook,
factory, wiring, projection, push) plus the provider hook in `host-runner-composition.ts`. The push
is **unguarded**: a subagent, a box-scoped runner and a desktop-less box all have faults worth
reporting, and each is exactly where "Titan tried to cover up failure" came from. A shared-room
member is the one exception, filtered out by `SHARED_ROOM_TOOL_NAMES` — a room is cross-user, and a
report there would be about someone else's product.

**The sentence the model reads back** never says anyone has received it, because nobody has:

> Written down and shown to the person in their console, where they decide whether it goes to the
> developers. Nobody has received it yet, so do not say that anyone has.

## 5. The pending store

`<sand-data>/problem-reports.json`, mode 0600, `{ "version": 1, "reports": [...] }`, capped at 50
with the oldest dropped. `source/host/extensions/feedback/problem-reports.ts`.

It sits under the sand-data root on purpose: the Read tool refuses that whole root (TOOLS-READ-2), so
one agent's quoted tool output does not become another agent's context through a file it could read
back. It is not a secret store — nothing in a report is a credential — but it is 0600 anyway, because
a report quotes tool output and tool output is not always as harmless as the model thought.

Two gateway commands, both reads or removals, neither of which sends anything anywhere:

- `listProblemReports {}` → `{ reports: [...] }`
- `resolveProblemReport { id, outcome: "sent" | "dropped" }` → `{ id, outcome, resolved }`

`sent` and `dropped` clear the same row. This file is the box's queue of what the operator has not
seen yet; once they have seen it, the box has no further part in it. What happened to a sent report
is the control plane's record.

## 6. The console

### The two controls that are always there

Beside the composer: **Report a problem** and **Run a self-test.** They are there whether or not
anything has gone wrong, which matters because of §6.3.

### The automatic offer, and the measurement that shaped it

**MEASURED on `grok-bot-local-vm`, 2026-09-09:** a model-endpoint failure writes **no `turn-failed`
row.** The host logged the failure in 3 s, the tray fired, both transcript reads came back with
messages only, and the page showed the person's own bubble plus "Accepted by the host" for thirty
seconds with the roster card still green. An offer keyed on the `turn-failed` entry would therefore
**never fire on the commonest failure there is.**

So the offer is built at **tray-narration time** (`reloadTrays`, `gateway-adapter.js`). Two things
changed there and nothing else:

1. The line pushed into the conversation was `That turn failed: ${title} - ${detail}` — literally
   `That turn failed: Agent failed to respond — fetch failed`. That is the machine's own spelling of
   a problem the person can do exactly one thing about, and it is the presentation
   `host-notes-read-as-errors.md` bans. It is now: *"Titan could not finish that one. Ask again, or
   send the details to the developers."* **No raw provider wording reaches the conversation at all.**
2. The tray's own words become a **report seed**, which the page turns into the offer card. The
   technical half is not thrown away — it is on the card, where the person can read it, edit it, and
   decide.

**The second trigger** is the same tool failing three times in one conversation, counted off the
woven tool rows. It fires **once per tool per conversation,** not once per failure.

### The card has a life: pending, sending, settled, folded

Jason, 2026-09-09 17:39, with a screenshot of his own console open on two reports Titan had just
filed: *"Titan was able to submit two issues to you and that green box is not going away. It just
stays there."* Both halves of that were code.

**A settled card used to be permanent.** `settleProblemOffer` flipped a status and re-drew; the offer
stayed in the page's own list for the life of the tab and `reportCardsMarkup` put it back at the end
of the transcript on every render. There was no timer, no dismiss control, and nothing but a reload
took it off the screen. Measured on `grok-bot-local-vm` in real Chrome, on the same build his
screenshot was taken against (`consoleVersion` **cf783fc0**): the settled card was still pinned above
the composer at +2 s, +20 s and +60 s.

Now the card has four states and an end:

| state | what the person sees | what it does next |
|---|---|---|
| **pending** | the title, the tier chips, the editable body, the custody line, Send and Not now | waits |
| **sending** | *"Sending this to the developers…"* | the POST |
| **settled** | *"Sent. The developers have it."* or *"Kept to yourself. Nothing left this workspace."*, with a **Dismiss** | folds itself after `REPORT_FOLD_MS` (6 s), or when Dismiss is pressed |
| **folded** | one quiet transcript row: *"Sent to the developers: &lt;title&gt;"* or *"Kept to yourself: &lt;title&gt;"* | nothing. It is a row like any other |

The settled copy changed with the fold, deliberately: it used to end *"…and you can see what you sent
in your own copy above"*, which was only true while the card was on screen and stopped being true the
moment the card left.

**The fold waits for the box, and a refusal cancels it.** `resolveProblemReport` used to be
fire-and-forget, which was harmless while a settled card sat there for ever. With a fold it is not:
taking the row off the screen while the box still held the report would show a decision the box has
no record of, and the same report would be handed back on the next load with nothing on the page
explaining it. So the fold is scheduled when that call *succeeds*, and not before. When the box
refuses it, the card stays up and says why — *"This box still holds its own copy, so it will be
offered again next time you open the console"* — with its Dismiss still there for a person who would
rather have the space back.

**And the fold is drawn by the card path, not spliced into the transcript.** `contextMessages` is the
box's own transcript and the adapter replaces it wholesale on every re-read, so a page-local row
written into that array is wiped on the next tick. The offer cards survive precisely because they are
appended outside it. There is also no per-report row to fold back into: `foldRepeatedRows` collapses
two consecutive tool rows with the same text into one — Jason's two reports drew a single
*"Reported a problem to the developers · 2 steps"* — so the quiet row is minted by the card path, in
the offers' own order.

**And the control takes you to the card.** The card is appended at the *end* of the transcript, and
`renderTranscript` only follows a reader who is already at the bottom (CONSOLE-4). So pressing
**Report a problem** while scrolled back drew a perfectly correct card below the fold with nothing
saying where it had gone — found by the phone gate at 390x844, where the card was 333 px wide and
right in every respect and its Send was off screen. Pressing a button that opens a card is one of the
moments a person expects to be taken to the newest line, so it uses the same one-shot pin a roster
click and a send use. Nothing else moves the reader: a card that arrives on the watch does **not**
yank someone who is reading history.

### One card at a time

Two reports used to be drawn as a stack of editable cards, each with its own Send. A person answering
the second has already lost track of which body belongs to which title. The transcript now draws
every folded row plus **at most one live card**; the rest wait, and the next one arrives as soon as
the one in front of it is answered.

One exception, and it is the same failure this item is about: a card the person opened themselves
with **Report a problem** goes to the head. A button that draws nothing because an agent's report
happens to be queued in front of it is exactly the "I pressed it and nothing happened" that started
this.

### The pending file is watched, not read once

`drainPendingProblemReports()` used to be called from exactly one place: after first paint. So when
an agent used the tool while the person was already looking at the console, the transcript drew its
quiet *"Reported a problem to the developers"* row inside the turn and **no card came until the page
was loaded again.**

That is what happened to Jason. Titan filed two reports; the control plane has **one**. Report #4,
"Mobile console unusable, no scroll, layout too large for viewport", was drawn and sent. The second,
"No bot template system visible to Titan, BOTS-1 not yet landed", went into the box's pending file
and nothing on his screen ever drew a card for it — while the first report's sent card sat pinned
above the composer, telling him something had worked.

Measured on `grok-bot-local-vm` 2026-09-09: a scratch agent wrote two reports in one turn, both were
in the box's file at **t+12 s**, and the open page showed **0 cards at 6, 12, 18, 24 and 30 s**. One
reload drew **both at once**, stacked.

The drain now rides the beat the console already runs — the adapter's `subscribe`, which fires on the
900 ms debounced re-read and on the 15 s heartbeat — behind a **4 s floor** (`PENDING_POLL_MS`),
because a drain is a gateway round trip and a busy conversation would otherwise ask the box for its
pending file several times a second. `seenPendingReports` is what stops the same report being offered
twice, and it deliberately survives the fold: anything that cleared it would re-offer the card the
person just answered on the next tick.

Two things fall out of the watch for free. A drained report's evidence is built at drain time, so
watching makes it closer to the report's own moment (before, the second report of a turn carried the
first report's tool rows as "what ran just before"). And **a reload now shows exactly what is still
pending and no settled card**, because the offers were always page-local and the box's row is cleared
on either outcome.

### An unanswered offer still dies with the page

Said plainly because it is a real limit and not a bug to be discovered later. The offer cards are
**page-local by construction**: they are not transcript entries, and the box's transcript has no
record of them. Close the tab on an unanswered offer and it is gone.

Two things make that survivable, and both are why they exist:

- The **box's own pending file** is watched, so anything an agent wrote through the tool is offered
  again. Only the two console-side triggers (a failed turn, a repeated tool failure) are lost.
- The **always-present Report a problem control** means the door is never closed.

### Where a chip may not be drawn

The card is the transcript's last child, and three pieces of shelf furniture used to float over the
transcript's bottom band at `bottom: calc(100% + 6px)`: the send-acceptance chip, the attachment tray
and the two always-present controls. Measured at 1440x900 with one file staged — Jason's screenshot
exactly, attachment chip included — the *"Accepted by the host"* chip ran **706–733** against a card
at **384–738**, twenty-seven pixels of overlap, and `elementFromPoint` at the chip's centre answered
the card's own Send / Not now row. `pointer-events: none` meant it did not block the click, only the
reading.

All three are rows in the shelf's own grid now, spanning its columns, collapsing to nothing when they
are hidden or empty. The reason they were floated in the first place — an unstyled fourth item
wrapping the utilities onto a second row and sliding the composer into their column — is answered by
spanning the row rather than by leaving the flow. `.composer` bottom at 1440x900 is unchanged at
**856**.

### The console's own build number

Did not exist before this. It is the first 8 hex of a sha256 over the page's own `app.js`, computed
once at load and cached in memory. Self-maintaining and true, where a hand-kept literal goes stale on
the first ship. It needs nothing from the relay.

### The self-test

**Run a self-test** sends a fixed prompt carrying Titan's own six sections — shell and file I/O, web
tools, connectors, desktop and browser, state and memory, and agent management (read-only; nothing is
created, changed or deleted without being asked) — and its reporting table `Tool | Status | Error`.
The agent answers, then offers the answer as a report at tier `observation`.

Its known-limitation line is worded to match the Read tool's refusal (TOOLS-READ-2), so the checklist
**stops teaching agents to file a deliberate boundary as a bug** — which is exactly how TOOLS-READ-1
and TOOLS-READ-2 came to be filed.

## 7. Tier routing, as it actually behaves today

Measured against what is built, not against what is planned:

| tier | today | planned |
|---|---|---|
| **critical** | raises the count on the admin console's Feedback panel and sorts to the top | notify the super admin out of band |
| **quality** | batched by a CLI verb (`cp/cli.mjs`) into a digest, run by hand | the same digest on a timer |
| **observation** | sits in the panel as backlog, filterable by tier | a monthly summary |

**Nothing sends mail.** Mail is Wave A's, and a tier that promised an email nobody wired would be the
same class of claim this whole item exists to stop.

## 8. The persona sentence — **Wave A's to paste, verbatim**

This belongs in `system-prompt.ts`, which Wave C does not touch. It is written here so it is not
paraphrased on the way across:

> When a tool fails, say which one and what it answered, and say what you will try next. Do not call
> a failure temporary unless that same step has succeeded before. Do not present a workaround as a
> success. If the failure blocks the work, offer to report it to the developers and use the
> reporting tool when the person agrees.

## 9. TOOLS-READ-2, decided

The Read tool refuses `/home/box/sand-data/…` while the Shell tool reads the same file. Titan filed
that as inconsistent access control, and it was — the refusal protected nothing while a root shell in
the same container could `cat` it.

**No shell fence ships,** and the reasoning is stated rather than buried:

- The shell deny list the brief assumed **does not exist.** The shell executors are registered with
  no guard; the only deny list in the tree is a network one for the macOS sandbox. The honest seam is
  a preflight hook passed in a file this wave does not own.
- Every exec daemon runs as **uid 0**, so any command-text glob is bypassed with `base64` or
  `python`. A fence that a two-character change defeats is theatre with a maintenance cost.

What ships is the **refusal reworded in plain words**, true of the whole sand-data root rather than
pretending it is only about secrets, plus a test that states the Read/Shell asymmetry as intended.
**CUSTODY-1 is the real fix** — run the agent shell as an unprivileged uid — and it is a box-image
change, not a tool change. TOOLS-READ-1 is the same condition (`agent-data` is a symlink to
`sand-data` and the guard resolves realpaths) and closes with it.

## 10. Files

| what | where |
|---|---|
| the tool | `source/host/runner/tools/problem-report-tool.ts` |
| registration | `source/host/runner/tools/turn-toolset.ts`, `source/host/host-runner-composition.ts` |
| the pending store | `source/host/extensions/feedback/problem-reports.ts` |
| the two commands | `source/host/gateway-protocol.ts`, `source/host/host-gateway-api.ts` |
| the quiet chip | `ui/machine-room/gateway-adapter.js` (`TOOL_LABELS`, `toolRowText`) |
| the offer seed | `ui/machine-room/gateway-adapter.js` (`reloadTrays`) |
| the card, the triggers, the self-test | `ui/machine-room/app.js` (the `FEEDBACK-1` block) |
| the controls | `ui/machine-room/index.html`, `ui/machine-room/styles.css` |
| the relay door | `ui/server.mjs` (`POST /feedback`) — Wave C item A |
| the control plane | `cp/feedback.mjs`, `cp/server.mjs`, `cp/store.mjs`, `cp/cli.mjs`, `cp/admin.mjs` — Wave C item A |
| tests | `tests/problem-report-tool.test.mjs`, `tests/machine-room-feedback.test.mjs` |
| the gate | `scripts/verify-feedback.mjs` |
| the panel | `docs/ADMIN.md` §Feedback |

---

## 11. Measured

Every number names the machine it was measured on. Nothing here is planned.

**On the R750, through the customer's own door** (https://console.titanium.bot signed in as the demo
account in real headless Chrome, bundle `7af8ac2316fd`, 2026-09-09):

- The demo bot called the tool. The transcript drew **exactly one muted row, "Reported a problem to
  the developers"**, and the tool's own name appears nowhere in the rendered page text.
- On the next load the card carried the agent's own title, its tier chip, the custody line and an
  **editable** body. The person added a line, pressed Send, and **one** POST left the page.
- Within one reload the report was listed at https://api.titanium.bot/admin: tier `critical`,
  workspace `demo` (stamped by the relay, never read from the body), state `new`. The panel is the
  seventh section and the page draws seven panels and no more.
- **Approve** wrote `approved` with who decided and when. **Create GitHub issue** answered, in these
  words, *"the issue body is ready; paste a repo token in the Feedback panel and press this again"*,
  with the whole issue body rendered and **zero requests sent anywhere**. The door is proven and
  unfired because no repository token has been pasted, and none is ever pushed into a box.
- The **automatic offer** was measured the same day on the same console on a genuinely failed turn
  (BOX-6 transcript corruption on the demo Titan): the card appeared with the plain-words sentence
  "Titan could not finish that one", the raw provider wording was nowhere in the conversation, and it
  sent. It is report #1 in the panel.

**On grok-bot-local-vm** (bundle `df1300366eb2`, 2026-09-09):

- `verify-feedback` (the console arc in real Chrome, POST body captured): **27 passed, 0 failed**.
- `verify-feedback --box` (the pending file and the two gateway commands): **5 passed, 0 failed, 1
  skipped** (the toolset-trace leg, which needs `SAND_TOOL_TRACE`).
- `verify-feedback --agent` (a real scratch agent calls the tool, then is deleted): **4 passed, 0
  failed** — the pending file carried ProblemReport v1 with the agent's own title.

**On this Mac:** `verify-admin` **300 PASS, 0 FAIL** over the control plane, the panel, the two
gates on every report, the credential refusal and the leak sweep.

**The card's life and the watch (FEEDBACK-2, FEEDBACK-1b), on grok-bot-local-vm, real Chrome, this
Mac, 2026-09-09:**

- `verify-feedback` (the console arc, a stub relay, real mouse coordinates): **45 passed, 0 failed,
  0 skipped** — up from 27. The new checks are the ones that would have caught Jason's screenshot:
  only one card is drawn at each step; the sent card carries a Dismiss and no longer promises a copy
  above; it folds inside twelve seconds into "Sent to the developers: &lt;title&gt;" with the pinned
  card gone; the next report comes forward on its own; a report written into the box's file **with
  the page open and never reloaded** draws its own card, waits its turn behind the one already
  there, and clears the box's row when answered; and a reload draws exactly what is still pending,
  with no settled card and no fold row.
- `node --test tests/machine-room-feedback.test.mjs`: **28 passed, 0 failed** (16 before). Twelve new
  cases, including that the fold is not scheduled until `resolveProblemReport` has **succeeded** and
  that a resolve the box refused leaves the card drawn saying so, that a stray Dismiss never folds a
  pending card, that three SSE ticks inside the 4 s floor read the box once **and that the standing
  beat exists as well as the subscribe one**, that a card the person opened themselves goes to the
  head of the queue, and that the id set which stops a report being offered twice survives the fold.
- `verify-feedback --agent` on grok-bot-local-vm: **10 passed, 0 failed**. A real scratch agent was
  asked for **two** reports in one turn and wrote both; the box handed them back oldest first
  (`01:22:43.666Z` then `01:22:43.669Z`), each with an id of its own, each ProblemReport v1 with the
  agent's own title; both were resolved and the box was put back the way the leg found it.

**The green Sent state, on the R750 demo tenant through https://console.titanium.bot, real Chrome at
1440x900, 2026-09-10 01:59Z, signed in as a throwaway customer account minted in the cp container and
removed afterwards.** This is the only place it can be measured: the local relay has no control plane
wired, so the local proof of the settled arc goes through the identical drop branch. **14 checks, 0
failures.** Report a problem drew exactly one pending card with its Send on screen; Send settled it in
**0.1 s** to *"Sent. The developers have it."*, with a Dismiss, no "copy above" promise and no "still
holds its own copy" line; it folded itself into *"Sent to the developers: A problem with this
product"* **5.8 s** after the settle; a reload showed neither the settled card nor its fold row and
nothing still pending. The report is **#7** in the control plane and was suppressed afterwards.
**Report #4 was not touched** and still reads `new`.

**And the watch proved itself in production inside five minutes of the ship.** The relay was restarted
at about 01:52Z on 2026-09-10. At **01:56:56Z** the control plane took report **#5**, `titanium`, *"No
bot template system visible to Titan — BOTS-1 not yet landed"* — the exact report that never drew a
card on Jason's screen. At **01:57:21Z**, twenty-five seconds later, report **#6**, *"No X/Twitter API
connector available"*, a **third** stranded report nobody knew was in that box's pending file. Both
had been sitting there since 2026-09-09. A send only ever happens when a person presses Send on a
card, so those two rows are the watch drawing cards that did not exist before this ship, one at a
time in the box's own order, and somebody answering them. The control plane had one of Titan's three
reports before the ship. It has all three now.
- `verify-mobile --card` on a phone (390x844 and 430x932): the card a person opens by hand is **333
  px** wide with **0** descendants past the edge and a 16px box to type into (442 px wide at x 0 and
  an 11px box before this ship), its Send is a 44x44 target with nothing on top of it, and **Not now
  folds it into a quiet row** instead of pinning it above the composer.
- The two assertions in `verify-dashboard.mjs` that pinned the old floating furniture — "the status
  floats above the shelf", "it floats above the shelf instead" — were rewritten to the new
  invariant: a row of the shelf, still not taking the composer's column.

**Still wave A's to land:** the persona sentence in §8. It is not in the standing role yet, checked
in the merged tree 2026-09-09. Filed as **FEEDBACK-1c**.
