# Settings (SETTINGS-2)

Settings is where a person makes choices about their own workspace. It is not where the product is
configured, it is not where anything is pasted, and nobody should need to know how any of it works to
use it.

> Jason, 2026-09-10 05:53, looking at the old panel:
>
> *"This modal in the centre, going down, does not make a lot of sense. It's so busy, with so much
> stuff. A user is never going to put a resend key in. That's on the backend. There's just too much
> going on here. It's just supposed to be user-friendly and very simple. Now it's getting to the
> point where you've got to be a developer to understand what's going on."*

That is the whole brief. Everything below is a consequence of it.

---

## 1. The one rule

**A row is a label, at most one grey explanation line, and exactly one control.**

Nothing else goes on a row. No second button beside the control, no paragraph, no pair of fields, no
"advanced" fold inside a row. If something needs two controls it is two rows; if it needs a
paragraph it needs a different design.

This single rule is what makes the surface readable, and it is the rule the unit test pins. When a
row cannot be written that way, that is the signal the thing does not belong on a customer's
settings at all — it belongs in the Operator section or in the admin console.

The shape around the rows: a **left nav of sections**, one section shown on the right with a big
title and a one-line subtitle, and inside it **groups** — a small grey group label over a card of
rows. On a phone the same surface is a **full-height sheet**.

---

## 2. The sections, and who sees each one

Six. The first four and their group labels come from the original product's own settings, which is
the shape Jason asked for; Notifications is ours because the phone app needs it; Operator is ours
because a product with an operator has to put the operator's half somewhere a customer never sees.

| Section | Subtitle, as it reads on the screen | Who sees it |
| --- | --- | --- |
| **General** | Your account, how the console looks, and what your assistant is called. | everyone |
| **Computer** | The computer your assistants share. | everyone |
| **Usage & Billing** | What this workspace has used, and who to ask about the bill. | everyone |
| **Updates** | The console you are using, and the computer your assistants share. | everyone |
| **Notifications** | What wakes your phone, and the devices that get it. | everyone |
| **Operator** | Everything technical. Only you see this section. | the operator only |

Notifications and Operator carry no rows of their own: they are **mount points**. Notifications is
drawn by `push-settings.js` into the one body carrying `[data-push-mount]`, and Operator is drawn by
`app.js`'s `settingsPanel()`, unchanged in behaviour, which is how every old capability keeps working
without being rewritten.

**The two slots are different selectors on purpose.** `[data-push-mount]` is Notifications' and
nothing else on the surface carries it. `.settings-list` is the **Operator stack's** class — it is
what `voice.js` hunts for (`#panel-content .settings-list`, then after `[data-mail]`) — and **no
customer body carries it**, because a customer body that did would take the Voice card and its
technical rows onto a customer's screen. Measured on grok-bot-local-vm at 1440x900 and 390x844 as a
customer: `.settings-list` zero on all five customer sections, `[data-push-mount]` one on
Notifications and zero elsewhere, and the operator body `class="settings-list settings-operator-list"`.

### General

- **Account** — an identity header at the top of the card: the workspace's initial, its name, the
  signed-in email and a copy control, with the email and the control drawn only where there is one.
  Sign out, drawn only where signing out means something — the relay says whether this install has a
  password at all, and on a loopback console it does not. Devices signed in, a list with a Revoke per
  device on `GET /auth/devices` and `DELETE /auth/devices/<id>`, two routes that have existed for
  months and had never had a screen.
- **Appearance** — Theme (Follow system / Light / Dark, and the choice is remembered, which the old
  two-state flip never did). Language, which is one disabled row reading "English for now. More are
  coming." — the reference product has the row, and a row that says plainly what it is beats an empty
  promise. Background, a mount slot `backgrounds.js` fills with **one Choose control whose face names
  the plate that is chosen**, so a person reading General sees what the background is without opening
  anything. Pressing it opens the gallery as a **sub-view of General** — a back control that says it
  goes back to General, the title Background, and the same eighteen tiles with the upload and the
  storage note, uncapped, because in a sub-view the gallery is the whole body. Choosing a plate applies
  it at once; back is not a Save. **BG-PICKER-1 closed.** What it replaced was the grid inline in the
  row: measured on grok-bot-local-vm in real Chrome on 2026-09-10, the row was 816x441.63 at 1440x900
  and 360x361.63 at 390x844 with nineteen pressable faces in its one slot, and General was 1,250 px of
  scroll in a 676 px window (1.85x) and 1,537 px in 645 px (2.38x). After, same machine: **one face**,
  the row **63.63 px** and **70 px**, and General **872 px (1.29x)** and **1,256 px (1.95x)** — 378 px
  and 281 px back, with `verify-settings` 95 of 95 green at both widths.
- **System** — Microphone, drawn only when this browser can actually name one. Let me talk to Titan,
  a switch that writes whether talking is on for this workspace, disabled with the line "Your
  operator has not switched talking on yet" when no key exists for it anywhere.
- **Bot** — Titan's name (editable, with its Save). Titan's email address with a copy control, drawn
  only when email is switched on. Bots, "N of M", with the ask-your-operator line.

There is **no Add account** row: a control that can never become enabled on a console holding one
workspace per sign-in is a promise. There is **no hardware acceleration** row: this console is a web
page and nothing sits behind that switch — the reference product's row is a desktop application's
fact. Both absences are decisions, written here so nobody re-adds them.

### Computer

- **Computers** — Titan's computer, its name and whether it is running or asleep. **Execution on
  this computer**: *"Let Titan open files and run tasks on this computer. Auto-review still checks
  everything first."* — Always allow / Ask every time / Never allow, and this is the first time the
  console can **set** it rather than draw a read-only pill; the host takes exactly those three on
  `setHostSettings`, and where the operator caps the workspace the line says so. Ask me before…, the
  things Titan checks with you first, with its Save. How Titan answers, drawn **only** where the plan
  group has members, because a heading over an empty box is a promise with nothing behind it.

### Usage & Billing

- **Usage** — Talking time today, a meter reading "N of M minutes, up to K in one call" (the call
  ceiling is on the caption because the old Voice card said it and nothing said it afterwards —
  VOICE-8). Coding time this month, a **figure and not a bar**: nothing on this product caps coding by
  the month, so there is no second number for a bar to be drawn against, and it becomes a bar the day
  a monthly ceiling exists. Each drawn only where that number exists. Your plan, in a customer's words rather than a routing
  alias.
- **Manage plan** — Billing: *"Your operator handles billing. Ask them to change your plan or send an
  invoice."*

**No money figure.** There is no per-workspace spend a console can read today; the operator's ledger
is in the admin console and nowhere else. Inventing a number here would mean a new control-plane door
and a new relay route, and that is filed rather than guessed at (row SPEND-1).

### Updates

- **Titanium Bot updates** — Version, reading either "You're up to date" or "A newer version is
  ready", with a Check for updates button. Where the console cannot read a version at all, the row is
  one honest line.
- **Titan's computer** — Update Titan's computer: *"Updates the computer your assistants share. Your
  files and logins stay, but installed apps and packages are removed. All assistants update
  together."* One button, which on the first press becomes a red-outlined **Click Again to Confirm**.

  **Which command that is, because the two are easy to confuse and only one matches the words on the
  row.** It is the box **swap** — a fresh instance on the same volume, which is exactly "your files
  and logins stay, but installed apps and packages are removed". It is **not** the host-bundle move,
  which no adapter in this console exposes and which would have been new gateway surface behind a
  button whose copy describes something else. It is enabled only while a newer bundle is published,
  so a box carrying a local patch is never offered one: since `cc2de54` a swap installs the bundle's
  own box-scripts and the window repair patches that copy, so a swap is safe exactly when a newer
  bundle is the thing being swapped to.

**No Reset** on a customer's surface. Rebuilding a box is BOX-6's own hazard and a customer pressing
it loses whatever is not in the last snapshot; the operator keeps it in the Operator section
(row SETTINGS-2a). **No Update Track and no Automatic Updates** — those belong to a desktop client
and there is nothing behind them in a browser (row UPDATE-TRACK-1).

### Notifications

The six kinds, quiet hours, and the devices, unchanged. One copy change: *"An agent asked for a key
or a password before it can carry on"* becomes *"An agent needs a sign-in from you before it can
carry on."* The label above it stays as it was so the phone app's own copy still matches.

### Operator

Everything technical the old panel held, in one place a customer never reaches: which endpoint is
answering and its health, the chat listeners, what is included with the plan, the email plane
**minus its sending-key field**, the job bus with every attribute intact, this box's version and its
update and reset buttons, and one line saying keys the product uses live in the admin console.

One thing the email plane keeps, and keeps deliberately: the **webhook signing secret**. It is not a
vendor credential the product fetches, it is the routing discriminator that decides which workspace
a message claiming a shared mail domain belongs to, so one global value in front of every edge would
let the first claimant read another customer's mail. It stays on each workspace's own file.

**Two password fields are left on the whole surface and both are the operator's**, measured on
grok-bot-local-vm at 1440x900 with the Operator section painted: the webhook signing secret above,
and the **job bus token**, which is this workspace's own credential for its own bus and is typed by
whoever runs the bus. Neither is a vendor key the product fetches, which is the line KEYS-1 draws.
The claim that is measured and that matters: **zero password fields anywhere a customer can reach** —
zero on all five customer sections at both viewports.

### The Operator section's Talking group (VOICE-8, landed)

The technical half of talking — **Service, Model, Voice and Who you are talking to** — is four rows in
a *Talking* group on the Operator section. The old Voice card carried them beside its key field; the
key field is gone, correctly, and for a day the other four went with it, which left the capability
live on the server with no control on screen. That is the hand-operation shape: the only way to change
the voice service was to edit a file on the server.

Each is a label, one line and one control, like every other row on this surface:

| Row | Control | What an empty value means |
| --- | --- | --- |
| Service | a select off the two the route answers, whose labels are billing shapes and name no vendor | — |
| Model | a text field and a Save | the service's own default |
| Voice | a text field and a Save | the service's own default |
| Who you are talking to | a select off this workspace's own bots, plus *Whoever is leading the team* | the relay works it out and prints which |

They carry the same four attributes the card carried — `data-voice-vendor`, `data-voice-model`,
`data-voice-voice`, `data-voice-agent` — so the gate selectors measure the rows rather than a new name
for the same thing. They are **written back from the door's own answer** and never left as typed.

**Three things about how they get there are load-bearing.**

They are registered by `voice.js` through `__mrSettings.register({section: "operator", group:
"talking", operatorOnly: true})` — the registry, not a hunt for a panel by its title. That call did
nothing at all until this wave: `bodyMarkup` returned early for a section whose body another module
fills, so the entry was stored, its `fill` ran against the operator's body on every paint, and its
markup was never drawn, with no error and no failing test. The Operator section now names one group
and the contributed rows are painted in **their own container beside app.js's stack**, never inside it:
that stack is somebody else's markup and every gate reads its controls by id. A repaint rebuilds that
container only when the **set** of rows in it changed, so a half-typed field is not taken out of
somebody's hands by a refresh.

They carry **no `data-settings-action`**. The surface's `act()` has no default branch, so an action it
does not know is swallowed with no error and no toast — a control that looks wired and is not. Each
row wires its own listener inside `fill()`, idempotently, which is what `push-settings.js` already does.

And **the door is shut behind them as well as in front of them.** `POST /voice/settings` refuses
`vendor`, `model`, `voice` and `agentId` from any workspace that is not the operator's, in words, the
same way KEYS-1 refused `apiKey`. Until this wave it took all four from any signed-in session, so a
customer with a browser console could point their own workspace's voice at a model the operator did not
choose and have it billed to his key. A client-side gate is not a gate.

**MEASURED on grok-bot-local-vm (this Mac), real Chrome at 1440x900, behind the instance-password door,
2026-09-10:** the four controls are on the Operator section under one *Talking* heading, each enabled,
each one label and one control slot, with the Service options reading *"flat rate for each minute you
talk"* and *"charged by how much is said, not by the minute"*; choosing the other Service round-trips
through `GET /voice/settings`; and the four are on **none** of the five customer sections and `[data-voice]`
matches nothing anywhere on the page.

**And MEASURED on the R750 2026-09-11 01:24 UTC** through `console.titanium.bot` as a throwaway customer
on the demo tenant (minted for the run and removed after it), real headless Chromium, user agent
`titanbot-gate/ship-customer-settings`, at **1440x900 and 390x844**: the nav is the five customer sections
with **no Operator entry**, and `data-voice-vendor`, `data-voice-model`, `data-voice-voice` and
`data-voice-agent` each match **0** nodes, as does `[data-voice]`. That absence is the only thing that
server can show: operator-ness there is the WORKSPACE (section 3), and the demo tenant is not the
operator's.

---

## 3. Who is the operator

**The relay decides, and says so.** `GET /auth/state` answers `operator: true` — only to an
authenticated caller — when there is no control plane at all, when the session carries no tenant
claim, or when the session was minted by the instance password. An absent field means false.

**Operator-ness is the WORKSPACE and not the person.** It is `tenantOf(req) === OPERATOR_SLUG`, so
every session on the operator's own workspace is the operator's and no session on a customer's
workspace can be. That is why the Operator section and its Talking rows can only be proved PRESENT on
a local relay behind the instance-password door: on the R750 the demo tenant is not the operator's
workspace, and what a throwaway customer there proves is that the rows are absent. The one fact on this
door that IS a person's rather than a workspace's is the talk mode, which is keyed on the session's own
person claim — `docs/VOICE.md` 13.

The console never infers operator-ness from a URL, a hostname, a slug, or whether a route happened
to answer. A surface that guesses at privilege eventually guesses wrong in front of a customer.

The Operator section is **rendered whenever the operator opens Settings**, never built lazily when
the nav entry is pressed — see the render rule in section 6.

---

## 4. Why there is no key field on a customer's settings

A customer never sees a key. Not a realtime voice key, not a mail sending key, not a webhook secret.

The keys this product uses to reach a vendor belong to the **operator**, and they are pasted once in
the super admin console at `api.titanium.bot/admin`, in the block **"Keys the product uses"**. They
are stored write-only, exactly the way the repository token already is: the block says whether a key
is set and never shows one back. The relay fetches them when it needs them — at the start of a call
for voice, at send time for mail — through one control-plane door behind the relay's own credential,
and never writes them to its own disk.

That leaves four password fields on the old customer surface at zero, and moves two of them into the
admin console. The rest were the operator's already.

Read KEYS-1 in `docs/GAP-ANALYSIS.md`, and the key sections of `docs/VOICE.md` and `docs/MAIL.md`,
for the door itself and for the migration, which moves no bytes: nothing copies a value off the
relay's disk, and the operator re-pastes at leisure with no downtime.

A key a **customer brings to pay their own bill** would be a different thing, and the design allowed
for it as a collapsed disclosure in Usage & Billing. It is **not on the customer's surface in this
release**: the providers browser stayed on the Operator section, where it already was. So there is no
key field on a customer's settings at all, of any kind, which is a simpler rule than the one that was
planned and a stricter one.

---

## 5. The words

Copy on a customer's row is written for a business owner:

- no vendor names, no protocol names, no tool names, no route names;
- the words key, token, secret, endpoint, relay, proxy and webhook do not appear;
- the explanation line says what the control does for the person, not what it sets.

`settings.js` owns the list — `BANNED_WORDS`, `BANNED_VENDORS` and the `BANNED` regex built from
them — and publishes all three, so `scripts/verify-settings.mjs` and the unit test sweep the same list
the surface was written against rather than a second copy that drifts. Three details of that sweep
matter, and each is there because the naive version was measured to be wrong:

1. **Whole words, both ends.** The regex is `\b(...)\b`. A `\bkey` prefix match red-cards
   *"The keyboard, handed to you"*.
2. **The label, the explanation line and a button's own text — nothing else.** `customerCopy()` is
   what the sweep reads, and it walks the sections a NON-operator sees, their titles, subtitles,
   group labels and rows, plus the account menu. It never reads a row's whole `textContent`, because
   a scan of the whole row red-cards a row whose only hit is inside a collapsed `<select>`'s options.
3. **A machine value is not copy.** A box name, an email address, a model id or a version string is
   marked `machine: true` on its control and is never swept: those are values a person was handed,
   not words this product wrote, and holding them to a copy rule would mean refusing to display a
   customer's own data because of what it happens to be called. The **Operator** section is exempt
   whole, by design, and `sectionsFor(false)` is how the sweep never sees it.

The relay's spoken sentences are swept by the same rule and have the same owner. `verify-voice.mjs`
deliberately does **not** pin their wording: it holds the shape (one whole sentence, leaking no
vendor, leading somewhere a person can go) and leaves the words to the plain-words sweep, so there is
one owner for the copy and it is not the voice gate.

---

## 6. How it is built, for whoever opens this next

**One section is in the DOM at a time.** `paint()` replaces the body with the section that was asked
for; it does not render six and hide five. That decides something for every gate in this repository:
**a gate may not read a row without opening its section first.** Roughly twenty job-bus attributes,
the provider groups and the listener rows all live on Operator, so `verify-dashboard.mjs`,
`verify-push.mjs` and `verify-console-polish.mjs` each open the section they are about before they
read it. A gate that assumes it can query a row cold reads an empty body and reports the row missing,
which looks exactly like a regression and is not one.

Row data is **pure and separately readable** for the checks that do not need a browser: `rowsFor`
answers a section's rows as data with no document at all, so the unit test and the plain-words sweep
read the same list the surface renders instead of a second copy of it.

View state is two module-scope variables (section, query), a body function that switches on them, and
a paint cache so a background repaint updates one card in place instead of throwing the person back
to General. The marketplace panel is the only pattern in this codebase to copy for that.

**The panel title stopped being load-bearing.** `ui/machine-room/settings.js` publishes:

```
window.__mrSettings = {
  SECTIONS, sectionsFor(operator), rowsFor(sectionId, facts),   // pure: no document needed
  accountMenuRows(facts), customerCopy(row), BANNED, BANNED_WORDS, BANNED_VENDORS,
  open(sectionId = "general", rowId = null),                    // the one way in
  shown, refresh, paint, facts(),
}
```

The pure half takes no document at all, which is the contract `marketplace-bots.js` and
`push-settings.js` already keep: the unit test and the gate read `rowsFor` and `BANNED` rather than
re-implementing the row list or the word list, so there is one definition of each.

Sections are **declared in that file**, not registered by their owners. Modules that fill a slot —
`backgrounds.js` for the background picker, `push-settings.js` for Notifications, `app.js` for
Operator — mount on the surface's own `titanbot:settings-section` event. That replaced the guard
those modules used to keep, which hunted for the panel **by its title**: it would have failed
silently the moment this wave renamed the panel, with nothing in the suite pinning it.

`voice.js` reads its facts through `window.__voice` and opens the surface with
`__mrSettings.open("general", "voice")` — the row id of the Talking switch — and never synthesises a
click on a gear to get there.

`window.__mrUi.openSettings(sectionId)` is the **one** way in. Nothing synthesises a click on a gear
to get there: `#shelf-settings` computes `display: none` at 390x844 (measured), so a synthesised
click on it reports success and does nothing, which is why "Open voice settings" was dead on every
phone.

### The DOM contract

So that three builders and five gates agree on one set of names:

```
#panel-content > .settings-surface[data-settings-surface]
  nav      [data-settings-nav="general|computer|usage|updates|notifications|operator"]
           aria-selected="true" and class is-active on the open one
  search   [data-settings-search]
  body     [data-settings-body]                     the one node paint() replaces
  section  [data-settings-section="<id>"]           exactly one of these at a time
  head     [data-settings-title] + [data-settings-subtitle]
  group    [data-settings-group="<group id>"]  > .settings-group-label + .settings-card
  row      .setting-row[data-setting-row="<row id>"]
             = <div><strong>label</strong><small>line</small></div> + exactly one control
  action   [data-settings-action="<name>"]          every control that does something
  mount    [data-settings-mount="<name>"]           a slot another module fills

  sub-view [data-settings-subview="<id>"]           one module's whole body for one section
             also carries data-settings-section="<id>", so everything that asks which section
             is on screen keeps answering
  back     [data-settings-back]                     the way out, carrying NO action name
  body     [data-settings-subview-body]             where that module's markup goes
```

### A sub-view (BG-PICKER-1)

```
window.__mrSettings.openSubview({ id, section, title, markup, fill, onBack })
window.__mrSettings.closeSubview()
```

One at a time, and it belongs to one section. `markup()` draws it once; `fill(body)` runs on **every**
paint of that section, so a live value still lands and the owner's wiring has to be idempotent. While
it is open `paint()` does not rebuild the body — the same rule the two `mounts` shells get, and for the
same reason: `account-menu.js` calls `refresh()` 2.5 s after boot, `refresh()` calls `paint()`, and a
sub-view with no guard is wiped under the person's hand. A nav press (**including one naming its own
section**), a search that lands somewhere else, a paint of any other section, and `open()` all end it.
`register()` is untouched: a module that wants a sub-view draws its own control in its own mount slot
and wires its own press, which keeps this out of `act()` — `act()` has no default branch, so a control
routed through it would be swallowed in silence. The back control carries no action name for that
reason. The sub-view's body is **not** sent the `titanbot:settings-section` event: that event is the
section body's, and the section body is not on screen.

**Where the sub-view and the contributed rows meet, because two items of one wave landed in this one
branch.** `paint()` decides what the body is in three cases, in this order: a sub-view that is already on
screen is left exactly as it is, and one that is not is drawn; with no sub-view up an ordinary section's
body is rebuilt; and an owner's body (the two `mounts` shells) is kept, in which case the rows other
modules contributed to it are reconciled on their own and only when the SET of them changed. So a sub-view
never loses what the person was doing in it, a half-typed operator field survives a repaint, and neither
case can silently take the other's branch. The sub-view is also the reason the reconcile is skipped while
one is up: the contributed rows live beside the section body, which is not on screen.

The Notifications body carries `[data-push-mount]`, which is `push-settings.js`'s whole mount
contract and what its legs match on; `.settings-list` is the operator stack's class and appears on no
body this module draws. Modules that fill a slot listen for the
`titanbot:settings-section` event, whose detail carries the section id and the node to fill.

The account menu at the foot of the roster: `[data-account-foot]` wrapping `[data-account-tile]`,
which opens `[data-account-menu]` holding
`[data-account-row="update-banner|usage|mobile|support|feedback|self-test|about|settings|log-out"]`,
each acting row carrying `[data-account-action]`.

Session contract: `GET /auth/state` answers `operator` alongside what it already answered, only to an
authenticated caller. The surface reads **that merged with `GET /me`** — one adapter call,
`getWorkspaceIdentity()`. The session half says who is looking; `/me`, below the gate, is the only
thing that counts this workspace's own usage (talking minutes and their cap, the bot ceiling). Each
half degrades on its own, and both absent means not the operator and no usage rows.

The account menu's **Weekly usage row carries no percentage.** The original's reads "42%", a
percentage of a plan's weekly allowance, and this product has no plan allowance for a number to be a
percentage of. The row opens Usage & Billing, where the figures that exist are drawn; the percentage
arrives with the plan (row ME-PLAN-1).

---

## 7. On a phone

At 640px and under the surface is a full-height sheet — inset 0, the whole width and height, no
rounded corners — and every control on it clears 44px.

There are **two routes in**, and both are two taps or fewer:

1. the gear in the window bar, one tap;
2. the roster drawer's account strip, then Settings — two taps once the drawer is open.

`scripts/verify-mobile.mjs --settings` holds both, at 390x844 and 430x932, with a real touchscreen
tap rather than `page.click`.

**What MOBILE-2c used to say, and why it was wrong.** The row read "there is no route into Settings
on a phone at all" and named one binding. Re-measured on grok-bot-local-vm 2026-09-10 in real Chrome
at 390x844 with touch, device scale 3: there are two, and the window bar's gear is fine —
`#settings-button` is 44x44 at (336,42), nothing is drawn over it, and a real tap opens the panel.
What is dead is the shelf's gear. So the finding is the **length** of the sheet and the dead opener,
not the absence of a route.

---

## 8. Measured, and where

Every number here names the machine it was taken on. **grok-bot-local-vm** is this Mac
(MacBook-Pro.local, darwin arm64) behind a local relay, in real Chrome through playwright-core, the
gate knocking as `titanbot-gate/<script-name>`. Numbers taken there are **not** the R750's: this
Mac's adapter answers false to `getHostStatus`, `updateBox` and `resetBox`, so Updates and both box
buttons do not draw at all and the R750's panel is materially longer. Re-measure there.

**The live console, MEASURED on the R750 2026-09-11 01:24 UTC** as a throwaway customer on the demo
tenant through `console.titanium.bot`, real headless Chromium, user agent
`titanbot-gate/ship-customer-settings`:

| | 1440x900 | 390x844 |
| --- | --- | --- |
| General's own scroll | 937 px in a 676 px window (1.39x) | 1,380 px in a 645 px window (2.14x) |
| the Background row | 816x63.63 px | 360x70 px |
| what is in its control slot | 1 face, 0 tiles, 0 grids | 1 face, 0 tiles, 0 grids |
| the face | *Titan Nebula*, labelled "Choose a background, now Titan Nebula" | the same |
| pressing it | a sub-view of General: 18 tiles, back control *"← Back to General"*, title *Background*, 0 Background rows still painted | the same |
| going back | 0 sub-views, 0 grids, the row reading the plate the page is on | the same |
| the four Talking controls | 0 of them, and 0 `[data-voice]` | 0 and 0 |

Nothing threw at either viewport. Screenshots are in this session's scratchpad under `sf-r750/shots/`.

**The old panel, before this wave** (grok-bot-local-vm, signed in as the operator, `verify-mobile
--settings`):

| | 390x844 | 430x932 |
| --- | --- | --- |
| the panel | 354x744 at (18,50) in a 390x844 viewport | 394x744 at (18,94) in a 430x932 viewport |
| content a thumb drags through | **10,475 px** in a 660 px window | 7,905 px in a 660 px window |
| controls in it | 76, of which **31 are under 44x44** | 76, of which 31 are under 44x44 |

Not full width, not full height, and fifteen screens of content on a phone.

**The new sheet**, the same leg on the same box with the surface merged in (39 of 39 checks, none
skipped):

| | 390x844 | 430x932 |
| --- | --- | --- |
| the sheet | **390x844 at (0,0)** — full width, full height | **430x932 at (0,0)** |
| content a thumb drags through | **1,413 px** in a 645 px window | **1,395 px** in a 733 px window |
| controls in the open section | **28, none under 44x44** | **28, none under 44x44** |

10,475 px to 1,413 px is **86.5% less to drag through**, and the 31 controls a thumb could miss are
zero. Both routes in hold with a real touchscreen tap: the bar's gear in one, the roster's account
tile (290x44, at the foot of the drawer) then Settings in two.

One thing that run got right by being wrong-looking: the **Operator entry was absent**, on a box
where every local session is the operator's. That is correct. The nav is gated on `/auth/state`'s
`operator` field, a tree without it answers no field, and absent means false.

**The talk button, before and after VOICE-2** (grok-bot-local-vm, real Chrome, one press with no
voice switched on): before, at 1440x900, the shelf went 1392x106@24,776 to 1392x196.02@24,685.98, the
composer 600x54@459 to 407.98x54@991, the message box 370.05 to 178.03, the utilities wrapped to a
second row and the transcript lost 45.5 px. After, one press leaves the shelf, the composer, the
utilities, the aside and the transcript **unchanged to the pixel**; only the message box yields, 370.05
to 215.31, and comes straight back. See VOICE-2 in `docs/GAP-ANALYSIS.md`.

---

## 9. Shipped, and filed

| Filed, deliberately not built | Why |
| --- | --- |
| Reset the computer, on a customer's surface | a recreate is BOX-6's own hazard, and a customer pressing it loses very recent work. The operator keeps it. |
| A spend figure in Usage & Billing | there is no per-workspace spend the console can read; showing one needs a new control-plane door and a new relay route |
| Update Track, Automatic Updates | a desktop client's switches. Nothing sits behind them in a browser |
| Add account | one workspace per sign-in. A control that can never become enabled is a promise |
| Hardware acceleration | a desktop application's switch. This console is a web page; nothing sits behind it |

Language is the one borderline case and it went the other way: the row is **drawn and disabled**,
reading "English for now. More are coming.", because the reference product has it and a row that says
plainly what it is beats a gap where a person expects a control.

Each of those has a row in `docs/GAP-ANALYSIS.md` with an owner and a concrete next action. None of
them is a note.
