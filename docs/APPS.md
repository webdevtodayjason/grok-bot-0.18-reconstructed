# The apps: what the phone and desktop shells get from the relay

This is the contract between the relay and the two app shells, which live in their own repositories
and are built by their own panes. It is written from landed code and saved gate output, not from a
plan. Anything in it that has not been measured says so.

Jason, 2026-09-09 22:21: *"I don't want to do a PWA phone app. I want to do a real phone app wrapper
installed in the iOS App Store."* So the shells bundle their own assets, which makes them
cross-origin to `console.titanium.bot`, which is why every section below exists. What is in this
repository is everything those shells need from the server: a door they can hold a token at, a cost
the phone can afford to keep open, and a way for a card that needs a person to reach the person.

**All four items of this wave landed together**: the front door (DOOR-1), the token door (STORE-1's
server half), the data diet (COST-1) and push (PUSH-1's server half). Every number below names the
machine it was measured on and, where it is a layout number, the viewport. **Measured** and
**planned** are kept visibly apart, because mixing them is what makes an update unreadable. The
app halves of STORE-1 and PUSH-1 belong to the phone and desktop panes and are not claimed here.


### Every gate, in one table

All of these ran on **grok-bot-local-vm (this Mac)** on **2026-09-10**, against a relay spawned from the
merged tree, one at a time behind the shared box lock, each inside the 300 s ceiling, each sending the
user agent `titanbot-gate/<script>`. Phone legs at **390x844** and **430x932**, device scale 3, touch,
iPhone UA, real Chrome through playwright-core.

| Gate | Result | What it is |
| --- | --- | --- |
| `npm test` | **2,689 pass, 0 fail** | the whole suite, not only the new files |
| `verify-door.mjs --all` | **96 pass, 0 fail, 0 skip** | the door at both phone widths, CORS, and a real page on a second origin minting, reading, holding `/events` 30 s and revoking |
| `verify-cost.mjs` (3 runs) | **15 pass, 0 fail, 1 skip** | first paint, idle, hidden, resume, the asset cache, noVNC printed by name, the desktop A/B |
| `verify-push.mjs --host` | **32 pass, 0 fail, 1 skip** | a real pending hand-off to exactly one recorded send, collapse, quiet hours, the badge, revoke |
| `verify-push.mjs --console` | **16 pass, 0 fail, 4 skip** | the Notifications card at 390x844 and the absent-module case |
| the bearer-to-push composition | **11 pass, 0 fail** | the one thing no single item could measure: a bearer from `/auth/token` is what opens `/push/devices`, and revoking it closes both |
| `verify-mobile.mjs --width --fonts --desktop` | **36 pass, 0 fail** | regression, including the desktop baseline this wave repaired |
| `verify-machine-room.mjs` | **clean** | regression |
| `verify-dashboard.mjs` | **163 pass, 7 fail** | regression. **All seven reproduce byte for byte on a clean worktree at the shared tip with none of this wave in it**, and they are the local box's model endpoint not answering (no reply, so no rendered attachment) plus its noVNC canvases. Not this wave's, and proved so rather than assumed |

**About the skips.** The cost gate's one skip is the working ceiling (section 5). The push gate's
skips are all the same shape and none of them survives the merge: `--host` and `--console` both target
a live relay on this machine that serves the shared working copy rather than the merged tree, so they
skip the mint door and the console's `?agent=`/`?entry=` boot parse by name rather than claim them.
Both are proved elsewhere on the merged tree: the mint door by `verify-door` and by the
bearer-to-push composition above, and the boot parse by `verify-cost --paint`, which reports **first
paint landed on the conversation the link named** — the deep link decided the first paint rather than
a second navigation after it. The remaining `--console` skip is a real gap in the product and not in
the gate: at 390x844 there is no route into Settings at all (section 8).

---

## 1. The one fact that shaped all of it

Measured, and verified in source: the relay emitted **zero** CORS headers, auth was the `gb_session`
cookie set `HttpOnly; SameSite=Strict`, and the gateway behind the relay **403s any request carrying
an `Origin` header** (`source/host/gateway-server.ts:25`, which is the whole reason the relay
exists). A shell that bundles its own assets is cross-origin, so before this wave it could not call
`/api`, hold `/events` open, or even preload the page's own code — `app.js` answers 401
unauthenticated.

So there are exactly two shapes a shell can take, and this wave builds the plumbing for the second:

- **A web view on the tenant origin.** Inherits the cookie, works with no server change at all.
- **A shell with its own bundled assets.** Needs a token door, CORS for its own origin, and asset
  reads that carry a bearer. That is the token door below.

---

## 2. The token door: the two credentials, and which one a shell holds

A browser on `console.titanium.bot` holds the `gb_session` cookie. That cookie is
`Path=/; HttpOnly; SameSite=Strict`, and `SameSite=Strict` is this console's entire CSRF answer
(`ui/auth.mjs`). A browser never sends it from another origin, so **a bundled shell cannot use the
cookie and no amount of CORS configuration would change that.**

So a shell holds a **device bearer**: a named, revocable, 30-day token it sends as
`Authorization: Bearer …` on every call.

```
POST /auth/token
Content-Type: application/json

{"email": "owner@example.com", "password": "…", "device": {"id": "…", "name": "Jason's iPhone", "platform": "ios"}}
```

Three bodies are accepted and nothing else:

| body | what it is |
| --- | --- |
| `{email, password, device}` | an account sign-in, decided by the control plane exactly as the login page's is |
| `{password, device}` | the instance password, the operator's door, which still works when the control plane does not answer |
| `{device}` **plus a live bearer in `Authorization`** | a silent re-mint for the same device |

`device` is optional in all three. `platform` is `ios`, `android` or `desktop`. `id` should be a value
the app keeps in its keychain so a re-mint refreshes the same row instead of making a twenty-first
device; anything that is not `[A-Za-z0-9_.:-]{4,64}` is replaced with a fresh id rather than refused,
because a mint that fails over bookkeeping is a customer who cannot sign in.

**One spelling to know about, because getting it wrong used to fail silently.** This door writes the
id as `device: {"id": …}` and `POST /push/devices` writes it as a top-level `deviceId`, and a shell is
told to use the **same** id at both. Sending the push spelling here once minted a bearer for a
*freshly generated* id instead of refusing, so the bearer and the push row keyed on different devices
and revoking the bearer left the push row behind, notifying a phone somebody had signed out of.
**Both spellings are accepted here now** (`device.id` wins when both are sent), and the answer always
names the id it actually used — read it back rather than assuming.

The answer:

```json
{"token": "tbd1.…", "expiresAt": 1791606000000, "renewed": false, "tenant": "demo",
 "device": {"id": "dev_…", "name": "Jason's iPhone", "platform": "ios", "createdAt": …, "lastSeenAt": …, "revokedAt": null}}
```

**The token is answered once, here, and never read back anywhere.** Put it in the keychain or the
platform credential store. Never in a URL, never in a log line, never in a query string.

### Rules a shell has to hold to

1. **On a 401, stop. Re-mint ONCE. Then ask the person. Never loop.** A failed *mint* charges the same
   lockout the login page charges, so a loop of mints locks the customer out of his own console for
   thirty seconds at a time. A failed *use* does not charge that lockout — it has its own limit of 60
   a minute per address — but a loop still gets you nothing and the person a spinner.
2. **Every refusal from us carries `x-relay-auth: required`.** That header is how you tell our refusal
   from the gateway's. A request carrying an `Authorization` header is **never** redirected into the
   login page, whatever its `Accept` says, so a 401 is always a 401 and always JSON.
3. **`/events` is read with `fetch` plus a stream reader, never `EventSource`.** EventSource cannot
   carry a header. Same for images: fetch with the bearer and make a blob URL, never a bare `<img
   src>` — Chrome's Opaque Response Blocking turns our JSON 401 into `net::ERR_BLOCKED_BY_ORB`, which
   your page cannot see.
4. **A token never rides in a URL.** No events ticket, no query-string credential, no token in a log
   line. That is why `/events` is read with `fetch` and images are turned into blob URLs rather than
   given a signed URL each.
5. **Rotating the instance password kills every device token at once.** They are signed with the
   cookie secret, which `set-password.mjs` rewrites. That is deliberate: it is the operator's one
   revoke-everything lever, the same one the cookie already had.
6. **A device bearer is strictly less than the cookie.** It does not open `/v1` (the job bus keeps its
   own token), it never mints a cookie, and it cannot open the websocket upgrade at all, because a
   browser WebSocket carries no headers. **So a phone gets no live screen of the box.** That is by
   construction as well as by design.

### The device list

| route | what it does |
| --- | --- |
| `GET /auth/devices` | this person's devices. A revoked one stays on the list, stamped, so it is visible that it was taken away. |
| `DELETE /auth/devices/<id>` | revoke one. The next call from it is refused within **2 seconds**. |

Scoped to the **person**, not the workspace: two accounts can share one workspace
(`accounts.tenant` has no UNIQUE constraint), and one customer's phone list is not the other's. A
session from the instance password, and the operator's, sees the workspace's own rows.

For a phone a customer has lost and cannot sign in to kill himself, the operator has
`node cp/cli.mjs device list <slug>` and `node cp/cli.mjs device revoke <slug> <device id>`, which go
through the relay's own admin route on `CP_RELAY_TOKEN`.

### What a device bearer cannot do, by construction as well as by design

- **No `/v1`.** The job bus keeps its own token and the two doors never see each other's credential.
- **No websocket upgrade.** A browser `WebSocket` carries no header, so there is nothing for a
  bearer to ride on.
- **Therefore no live screen from a phone.** That is a consequence of the two lines above, not a
  policy bolted on top, and it is written down here rather than discovered by a shell author.
- **Never more than the cookie, and strictly less.** It is one new arm in `tenantOf` and nothing
  else. It never reaches `mintSessionFromBearer`, which stamps an operator cookie on any non-`/api`
  request carrying the operator bearer.

### Refusals, and the retry rule

Every 401 from us carries `x-relay-auth: required` and **never redirects a bearer request into
HTML**. Two things were measured broken before this wave and both are fixed: `denyUnauthenticated`
302'd any GET whose `Accept` contained `text/html`, so a cross-origin fetch that lost its bearer
followed a redirect into the login page instead of reading a 401; and it answered non-HTML with
`application/json`, which Chrome's ORB turns into `net::ERR_BLOCKED_BY_ORB` for a bare `<script>` or
`<img>`.

So the shells' rule is:

1. On a 401, **stop**.
2. Re-mint **once**.
3. If that 401s too, ask the person.
4. **Never loop.**

A bad bearer **use** is rate limited but does not charge the password lockout. A failed **mint**
does, and it is the same lockout `/login` and `/v1` share.

### One thing to know about the instance-password door

A bearer minted with the instance password is **workspace-wide**, because that door has no person
behind it. Per-person settings keyed on it mean the workspace. That is the same precedent the tenant
claim already sets for a cookie minted before the deploy.

---

## 3. CORS: exactly these origins, and never credentials

| | |
| --- | --- |
| allowed origins | `capacitor://localhost`, `https://localhost`, plus whatever `SAND_UI_APP_ORIGINS` names (comma separated, exact strings) |
| `Access-Control-Allow-Credentials` | **never sent, on any answer** |
| allowed headers | `authorization, content-type, x-titan-projection, x-titan-if-digest` |
| allowed methods | `GET, POST, DELETE, OPTIONS` |
| exposed headers | `x-relay-auth, etag` |
| preflight cache | 600 s |
| `Vary` | `origin`, on every answer that saw an Origin, including a refused one |

Three things worth knowing:

- **It is an exact-string set.** Never a reflected Origin, never a prefix, never a regex. A prefix
  match on `https://localhost` would also match `https://localhost.evil.example`.
- **No credentials, deliberately.** The cookie is `SameSite=Strict` and a browser never sends it
  cross-site, so allowing credentials would buy a shell nothing and would trade away the console's
  CSRF answer. The bearer is the entire mechanism.
- **An allowed Origin is never a *requirement*.** A native HTTP client sends no Origin at all; the
  allow-list only decides which access-control headers come back. A preflight from an origin nobody
  named gets 403 and no access-control headers. The desktop shell's origin is **one
  `SAND_UI_APP_ORIGINS` line**, not a code change.

The gateway inside the box still 403s any request carrying an Origin header
(`source/host/gateway-server.ts:25`). That is unchanged and is the reason the relay exists. CORS is
answered by the relay, in front of it.

---

## 4. The front door (DOOR-1) — MEASURED

`console.titanium.bot/login` is the first screen a customer meets, including the one a shell sends a
person to when a re-mint fails. It is one template string in `ui/server.mjs`, and it now holds to
four rules that a shell's own sign-in screen should match:

- every control computes **at least 16 px**, because iOS Safari zooms the page when a focused
  control's text is smaller;
- **no `autofocus` attribute anywhere**, so nothing is focused and nothing zooms on arrival;
- `viewport-fit=cover` plus `env(safe-area-inset-*)` padding;
- every control at least **44 px** tall.

Palette: Midnight `#090D14` ground, Graphite `#172232` surface, Titanium `#E6EBF2` text, Signal Cyan
`#00C8F0` accent. The Ti mark is inline SVG — the page serves no asset at all, because an asset path
exempted from the session check would be a hole in the thing the page exists to close.

**Measured on grok-bot-local-vm (this Mac), real Chrome through playwright-core, device scale 3,
touch, iPhone UA, 2026-09-09 and 2026-09-10.** `node scripts/verify-door.mjs --all`:
**96 PASS / 0 FAIL / 0 SKIP in 44 s wall** (the door legs at both widths, CORS, the second-origin
shell, and `verify-mobile --width` as a regression).

| | before (32f4007) | after |
| --- | --- | --- |
| document scrollWidth at a 390 px device | **400** | 390 |
| `window.innerWidth` at the same moment | **400** (Chrome grew it to match) | 390 |
| `visualViewport.width` | 390 | 390 |
| computed font-size, password / button | 14 px / 14 px | 16 px / 16 px |
| control heights | 43 px / 41 px | 48 px / 46 px |
| `[autofocus]` elements | 1 | 0 |
| body background | `rgb(15, 21, 26)` | `rgb(9, 13, 20)` |
| button background | `rgb(139, 105, 234)` | `rgb(0, 200, 240)` |
| title / h1 | "Sign in - Machine Room" / "Machine Room" | "Sign in - Titanium Bot" / "Titanium Bot" |

**Why the innerWidth row matters to a gate author.** `scrollWidth <= innerWidth` PASSED on the broken
page, because both were 400. Every width assertion in this repo now compares against
`visualViewport.width`, which stayed 390 — the screen the thumb is actually on.
`scripts/verify-mobile.mjs` documented the wrong rule until this ship and documents this one now.

**What no gate here can prove.** `visualViewport.scale` stayed 1 through focus at both phone widths
in real headless Chrome, so **no gate in this repo measures the iOS zoom.** The evidence for it is the
computed font-size plus the absent attribute, which are the two things the behaviour is defined in
terms of. An iPhone is the only thing that proves the rest.

---

## 5. The data diet (COST-1) — MEASURED

**Why this is in a contract about apps at all.** A phone pays for every byte twice, in a data plan and
in a battery, and a console left open in a pocket is the worst case: before this wave, 60 idle seconds
cost 139 requests and 1,623 KiB, about 97 MB an hour on a page nobody was touching.

**The ceilings, which are Jason's default and which he can move**: **250 KiB of API on first paint**
and **100 KiB per idle minute** at 390x844, on **decoded** bytes. Decoded, because that is what the
phone parses, and because production compresses while the local relay does not — one call measured
1,210 KiB locally and about 37 KiB live, so a ceiling on wire bytes would not compare across the two
machines. Wire is printed beside decoded on every gate run; every pass or fail is decided on decoded.
A third ceiling, **600 KiB a minute while an agent is working**, is gated but has not been exercised
(see below).

**Measured on grok-bot-local-vm (this Mac) at 390x844, device scale 3, touch, iPhone UA, real Chrome
via playwright-core with CDP network capture, 2026-09-10, on the MERGED tree with `ui/relay-hooks.mjs`
wired — so these are the bytes the relay actually sends, not a shaping proxy standing in for it. All
figures decoded bytes.**

| | before (32f4007) | after | ceiling |
| --- | --- | --- | --- |
| first paint, API | **548.7 KiB over 47 calls**, plus **1,683.7 KiB** more on selecting a named agent | **163.8 KiB over 33 calls** | 250 KiB |
| `getConversationOutline`, one read | **1,210.4 KiB** | **39.8 KiB** | — |
| duplicate `/api` keys in the paint window | **12** | **4** (`getHostStatus`, `listMcpServerTools`, `listConnectorSecretFields`, `readAttachmentText` — none of them this adapter's) | — |
| 60 s idle | **646.7 KiB over 4 ticks**, 161.7 KiB a tick | **56.1 KiB over 4 ticks**, 14.0 KiB a tick, at the busier of two quiet windows | 100 KiB |
| 60 s with the page hidden | **44 requests, 654.8 KiB** | **0 requests** from this adapter (8 from timers it does not own) | — |
| coming back from hidden | — | **1** catch-up read inside 600 ms, 2 reloads in 4 s, 27.8 KiB | — |
| second boot, asset wire | **1,479.4 KiB** | **1.2 KiB**, a 99.9% fall, one 304 | — |
| asset answers | `no-store` on every one | 28 `immutable`, 7 revalidating, **0** `no-store`, **0** `public` | — |
| desktop shell at 1440x900 | — | **0 px** of movement over 211 rects, 190 messages drawn either way | unchanged |
| noVNC at phone width, printed and excluded by name | — | 165 requests, 1,575.4 KiB, 41% of the boot (**COST-2**) | not in the ceiling |

`node scripts/verify-cost.mjs` ran in three invocations to stay inside the 300 s gate ceiling:
`--paint` 3 pass / 0 fail, `--idle` 4 pass / 0 fail, `--working --cache --novnc --desktop` 8 pass /
0 fail / 1 skip. **15 pass, 0 fail, 1 skip**, and the skip is the working ceiling, below.

### What a shell needs to know about it

- **Projections are opt-in and marked.** A call may send **`x-titan-projection: lean`** to ask for a
  shaped answer; no header, or `full`, means the payload is unchanged. Opt-in rather than opt-out is
  deliberate: it is the only shape that cannot silently starve a caller that did not ask.
- **`x-titan-if-digest: <digest>`** means "I already hold this"; the answer then says so instead of
  repeating a megabyte. The relay returns **`x-titan-digest`** on a shaped answer so the next call
  has something to send. The console's own reader does all of this, so a shell that loads the
  console's bundle gets it for free.
- **The outline projection discards what the console already throws away.** `weaveToolRows` emits
  rows only for `kind: tool-call` and `outlineKey` returns null for anything that is not a user or
  send-message item, so 1,239,452 bytes of outline become 57,777 with nothing lost that the page
  draws. The outline key is **hashed** rather than carried verbatim, because an outline key *is* the
  message text: verbatim keys are 416,598 bytes and would blow the 250 KiB ceiling on their own.
- **Assets answer `private`, never `public`.** A stamped URL gets `private, max-age=31536000,
  immutable`; an unstamped read gets a strong `ETag` and `private, no-cache`, so the repeat read is a
  304. `private` because assets are behind the login and the relay writes no `Vary` — a publicly
  cacheable answer would let an edge serve a signed-in 200, or a 401, to everybody. **Cloudflare will
  keep answering `cf-cache-status: BYPASS` on these, deliberately.** That is what private caching
  looks like from the edge, not a failure.
- **The stamping is a rewrite on the way out**, of `index.html`'s 22 asset references, the way
  `sameOriginDesktop` already rewrites that HTML. No file on disk is renamed, so there is no
  content-hashed build step to integrate with.
- **A shell that bundles the console's assets** is not reading them over the network and is unaffected
  by the asset half. It still wants the projection headers.
- **`?agent=` and `?entry=` decide the FIRST paint.** The console's boot honours them rather than
  selecting afterwards, which is worth about 120 KiB of API on the one screen that has to be cheap,
  and it clears the query with `history.replaceState` so a reload does not re-navigate. An agent id
  the workspace does not have is ignored and the console opens normally — which is what a push for a
  deleted agent, or a link opened against the wrong workspace, has to do.

### Two things this section does not claim

- **The 600 KiB working ceiling is gated but not exercised.** Three attempts: the local box's model
  endpoint never took the turn, so the agent reported working for 0 s of the minute, and the leg skips
  by name rather than passing on an idle minute wearing a working label. The arithmetic, **planned and
  not measured**: one projected outline read on that agent is 39.8 KiB, the host's own
  `OUTLINE_WORKING_MAX_AGE_MS` allows about twelve a minute, so about 477 KiB plus about 56 KiB of
  tick traffic, against 14.5 MiB unprojected.
- **The desktop layout is unchanged to 0 px.** The A/B compares the **shell** at 1440x900: worst
  difference **0 px over 211 rects**, and 190 messages drawn, live with both modules absent and with
  both active. The transcript's contents are not compared in the browser because two boots 40 s apart
  on a shared box draw different numbers of messages; what the projection does to a transcript is
  pinned exactly by a unit test that weaves the real 1,578-item payload both ways.

---

## 6. Push (PUSH-1 server half) — MEASURED with stub senders

### Registering

```
POST /push/devices
{ "platform": "ios" | "android" | "desktop",
  "token": "<whatever the platform SDK handed back>",
  "deviceId": "<the same stable id the bearer was minted for>",
  "name": "Jason's iPhone",
  "env": "production" | "sandbox" }
→ 200 { "deviceId": "...", "platform": "...", "replaced": true|false, "message": "..." }

GET    /push/devices              → the person's devices, with NO token on any row
DELETE /push/devices/<deviceId>   → stops notifying it at once
GET    /push/settings             → { settings, kinds, scope }
PUT    /push/settings             → the per-kind switches, quiet hours and one UTC offset
```

Behind the device bearer for an app, or the session cookie for the console's own Settings card.
Registering the same `deviceId` twice **updates** the row rather than adding one, and the token's
timestamp is refreshed on every upload.

Whatever the client hands back is stored **verbatim**. FCM's registration field `token` is deprecated
in favour of `fid`, and `fid` accepts a registration token through the transition, so the relay does
not get to have an opinion about which form a vendor's SDK is on this month.

Revoking a device bearer removes its push row in the same action. A vendor answering `410`,
`Unregistered`, `ExpiredToken`, FCM's `404 UNREGISTERED` or a `400 INVALID_ARGUMENT` on a payload we
already size-checked **prunes the row permanently**: a dead token retried forever is how a sender
gets itself rate limited over a customer who changed phones.

Device and push rows live in the tenant's own state directory (`push.json`, `push-sent.json`),
beside `mail.json` and through the same `t.file()` helper. **The control plane holds no device rows
at all** — only the two push credentials.

### The six card kinds, and the one that is never pushed

| Kind | What it is | Its id | Expires |
|---|---|---|---|
| `auto-review` | an action the review rule held back | entry id + `approval.requestId` | 10 minutes |
| `local-tool` | permission to run something on the box | entry id + `ask.requestId` | 10 minutes |
| `widget` | a multiple-choice question | entry id | waits for a person |
| `secret` | a credential the agent needs | entry id | waits for a person |
| `box-handoff` | the keyboard, handed to the person | entry id + `boxRequestId` | waits for a person |
| `report` | a problem the agent wrote up | the problem-report row id | waits for a person |

The seventh thing that looks like a card is the **failed-turn report offer**. It is page-local
(`offer-<seq>`, minted in `app.js` and dead with the page), so it has no durable id to collapse on
and is **never pushed**.

Pending versus answered is readable from any transcript read, because the host rewrites the stamp in
place rather than appending: `respondedValue`, `widgetDismissed`, `secretProvided` and
`boxResolution` on the entry, `approval.status` and `ask.status` on the message.

### What a push carries, and nothing else

A title, a reason clipped to **140 characters** (the host's own `MAX_NOTIFICATION_BODY_LENGTH`), the
ids, a deep link, under **4096 bytes**. No transcript prose past that reason. A secret request's
reason is a fixed sentence and never the model's own description, because a model can name the value
it is asking about and a lock screen is not the place to read it.

APNs payload shape: `aps.alert` as `{title, subtitle, body}` where the subtitle is the agent's name,
`aps.badge` a number, `aps.thread-id` the agent id, and `cardKey`, `kind`, `tenant`, `agent`,
`entry`, `request`, `link`, `web` as **peers of `aps`, never inside it**.

### The two collapse rules, which are NOT one rule

- **iOS:** `apns-collapse-id` is a 32-character hash of tenant + agent + entry, inside the 64-byte
  limit. The same value **merges** rather than stacks.
- **Android:** `android.notification.tag` is that same per-card key, because the tag is what replaces
  a notification already in the drawer. `collapse_key` is **not** the card kind: FCM guarantees at
  most **four** different collapse keys at any one time and silently loses the guarantee at the
  fifth, and there are **six** kinds. So the six fold onto exactly four buckets, and the fold is the
  one a person would make:

  | Bucket | Kinds | Why together |
  |---|---|---|
  | `decision` | `auto-review`, `local-tool` | both approve-or-deny, both die in 10 minutes |
  | `question` | `widget`, `secret` | both are "the agent asked you something" |
  | `keyboard` | `box-handoff` | nothing else asks for the computer |
  | `report` | `report` | nothing else is the person sending something onward |

  Two cards in the same bucket still replace each other correctly, by `tag`; the bucket only decides
  which of them Android is willing to guarantee.

One push per card, deduped from a ledger **on disk** (`push-sent.json`, last 200 keys or 7 days). An
in-memory map would re-notify a customer about yesterday's cards on the next redeploy, and a redeploy
restarts the relay.

### Expiry, quiet hours and the badge

The two self-expiring kinds carry `apns-expiration` at the card's own deadline and `android.ttl` the
remaining seconds. When a card is answered or expires, **one silent update** goes out on the same
collapse key (`aps.content-available: 1`, no alert, no sound, `apns-priority 5`) so every other
device's badge drops without a person acting.

Quiet hours hold the **alert** and never the silent badge update — a badge makes no sound. A card
still pending when the window ends gets **exactly one** catch-up alert, on the same collapse key.
Quiet hours are whole hours plus one UTC offset per account, which the app uploads; the cost of an
offset rather than a zone name is that a daylight-saving change is an hour out until the app next
opens.

The badge is the count of **pending cards**.

### The badge and the console's needs-you count will disagree

The console's own needs-you number counts **agents**, at most one per agent, and reads
`awaitingUserResponse`, which is never raised for a local-tool permission ask or a secret request
(`turn-runtime.ts:721-725`). So it misses two of the six kinds and under-counts whenever one agent
holds two cards.

**Measured on grok-bot-local-vm, 2026-09-10:** with a real pending hand-off on a scratch agent plus
two other waves' pending cards on the same box, the badge said **3** and the console's needs-you
count said **1**. They are both correct about what they count; they are counting different things.
Filed as **PUSH-3**, owner the phone pane. The console's own Notifications card says so in plain
words, where a customer comparing the two numbers can read it.

### The deep link

```
titaniumbot://card?tenant=<slug>&agent=<id>&entry=<id>&kind=<kind>
https://<host>/?agent=<id>&entry=<id>                  # the fallback
```

The app scheme first and the https fallback second, because a card can be tapped on a phone that has
since had the app removed and a dead custom scheme is a dead end. Both carry the entry, so the
console lands on the card and not merely on the conversation.

**A card may already be expired when the link is tapped.** An auto-review approval and a local-tool
ask both die in ten minutes; the app has to handle landing on a card that is no longer answerable,
and the notification for those two carries its own expiry so the system drops it rather than leaving
a tap that goes nowhere.

### The trigger, and what it costs a customer with no phone

A relay-side sweep every 15 s. **Its first act is a file read, not a gateway call:** a workspace with
no registered push device is skipped entirely, so the whole mechanism costs nothing for every
customer without a phone. Measured: the sweep makes **zero** gateway calls for such a workspace, and
the gate counts them to prove it.

For a workspace with a device: one `listAgents` and one `listProblemReports`, then one
`getAgentTranscriptTail {id, limit: 5}` for each agent whose roster row moved **or** that still has
an open card this relay alerted about. The roster is the change **detector** only; the tail read is
the authority on what the card is, because `awaitingUserResponse` is a single slot per agent with
first-tab-wins precedence, carries no card id, and is never raised for two of the six kinds.

Error trays are never read: `reloadTrays` dismisses each tray as it narrates, so a server-side reader
would race the console and consume the signal. Report offers come from `listProblemReports`, which is
durable, idempotent, stable-id, 0600 and capped at 50.

**Measured call sizes on grok-bot-local-vm, 2026-09-10, a box with 9 to 12 agents:**

| Call | Decoded bytes |
|---|---|
| `listAgents` | 11,857 |
| `listProblemReports` (empty) | 14 |
| `getAgentTranscriptTail {limit: 5}` | 1,535 |

**A wire shape that cost a gate run to find, recorded so nobody else pays for it:** `listAgents`
answers a **bare array**, while `listProblemReports` beside it answers `{reports: [...]}` and
`getAgentTranscriptTail` answers `{entries, nextBeforeSeq}`. Reading `roster.agents` gave an empty
roster on a box with twelve agents, so every pending card went unnoticed and the sweep reported a
clean zero — not red, not skipped, **absent**, which is the worst shape a failure can take. Both
forms are read now, and both are pinned in `tests/push-edge.test.mjs`.

### The credentials, and what runs without them

The Apple `.p8` signing key and the Firebase service account JSON are pasted **once** into the super
admin console (`api.titanium.bot/admin`, System health, "Waking a phone"), proved with the vendor
before they are stored, and never answered back. The relay reads them through
`GET /v1/relay/push/credentials` behind `CP_RELAY_TOKEN`, at boot and every 5 minutes, keeping the
last good copy in memory so a control-plane outage degrades to the stub rather than to an exception.
They are never written to disk by the relay and never pushed into a box.

**With neither credential stored the whole mechanism still runs** and records what it would have
sent, one JSON line per send. That is what every gate in this wave measured, because this wave held
no Apple or Firebase credential.

---

## 7. What push measured, on what, at what

Everything in this section ran on **grok-bot-local-vm on this Mac** on **2026-09-10**, against a
relay talking to that box, with the gate user agent `titanbot-gate/verify-push.mjs`. Phone legs ran
at **390x844, device scale 3, touch, iPhone UA, real Chrome via playwright-core**.

`node scripts/verify-push.mjs --host` — **32 pass, 0 fail, 1 skip** (re-run on the merged tree,
2026-09-10)

- A device registers, a second registration of the same `deviceId` updates rather than duplicating,
  and neither the registration answer nor the device list carries a token.
- A **real pending hand-off** on the box (20.1 s from prompt to pending) produced **exactly one**
  recorded send for that card: title `Take the keyboard for <agent>`, a 62-character reason, collapse
  id `d6a325d5713e8b038b0d582fb726f1e2`, `apns-push-type: alert` at priority 10, 687 bytes of 4096,
  both deep links present as peers of `aps`.
- Badge **3**, against the gate's own independent count of 3 pending cards across 12 agents read
  straight from the box. The console's needs-you count said 1 (see PUSH-3 above).
- The same card on a second pass: **nothing**.
- Quiet hours held it; the window ending released **exactly one** catch-up on the same collapse key,
  and one only across two further passes.
- Handing back dropped the badge from 3 to 2 through a **silent** send on the same collapse key, with
  no alert, no sound, and no second alert for that card in the whole run.
- Revoking removed the row from the workspace's own file; a revoked device got no send; a workspace
  with no device reached its box **zero** times.
- Every recorded payload and every log line swept clean of a device token, a private key, a bearer
  and a gateway token. Longest notification body 72 characters.
- **Skipped inside the gate:** minting through `POST /auth/token`, because this gate targets a live
  relay on this machine that serves the shared working copy rather than the merged tree. **That skip
  is closed separately, and it is the one composition neither builder could measure alone:** against a
  relay spawned from the merged tree, a device bearer minted at `POST /auth/token` is what opens
  `POST /push/devices` (HTTP 200, the push token never handed back), reads `GET /push/devices` and
  `GET /push/settings`, and — once that bearer is revoked at `DELETE /auth/devices/<id>` — no longer
  opens push at all (HTTP 401, `x-relay-auth: required`). Eleven assertions, all green, on
  grok-bot-local-vm 2026-09-10.

`node scripts/verify-push.mjs --console` — **16 pass, 0 fail, 4 skip**

- The console boots with the module loaded and the module publishes itself on the seam.
- The Notifications card appears inside Settings, with a switch for every one of the six kinds, each
  answering its **own centre** under `elementFromPoint` at 390x844 (38x22 each).
- Every control on the card computes **16px or more**, so iOS does not zoom the page. The gate caught
  the quiet-hours selects at **13px** and they were fixed to 16.
- Saving answers in one word and the switches come back off the relay rather than out of the page,
  with the browser's own UTC offset (−300 minutes) stored alongside.
- The device list shows the registered phone with **no token anywhere on screen**, and the card
  carries the badge-divergence sentence in plain words.
- The https deep link opens the console.
- With `push-settings.js` blocked at the network, the console still boots, Settings simply has one
  fewer card, and nothing threw.
- **Skipped, each naming its owner:** the bearer door (item A); the deep link selecting the named
  conversation and revealing the entry (item B's boot parse); and the card being openable by a thumb
  at 390x844 — see the next section, which is the one thing this wave measured and did not fix.

`node --test` over the whole suite — **2,689 pass, 0 fail** on the merged tree, including 29 tests of the decider, the
collapse rules, quiet hours, the expiry, the ledger's survival across a restart, the pruning table
and the zero-gateway-call case, plus 11 of the four routes and the absent-module fallback, plus 7 of
the two control-plane credential doors.

### Four things the gates and the review pass caught, which would otherwise have shipped

1. **`listAgents` answers a bare array.** Reading `roster.agents` gave an empty roster on a box with
   twelve agents, so every pending card went unnoticed and the sweep reported a clean zero. Both
   forms are read now and both are pinned in the suite.
2. **The quiet-hours `<select>` computed 13px.** iOS zooms the layout viewport on focus for any form
   control under 16px, which is the exact defect DOOR-1 fixes one screen earlier. Now 16px, and the
   gate measures the computed size of every control on the card.
3. **`collapse_key` was the card kind, and six kinds exceed FCM's four-key guarantee.** Folded onto
   the four buckets above.
4. **A dead desktop token was never pruned.** `prunesDevice` matched only `ios`, so a Mac's 410 fell
   through to the Firebase table where a 410 means nothing, and the row stayed. The test is now
   `platform !== "android"`, written that way so a fourth platform added later cannot fall through
   either.

### Not measured

- **A real iPhone or a real Android phone.** Chrome is not iOS. Nothing above claims a notification
  arrived on a device; what is claimed is that one send was recorded with the right collapse key,
  title, badge and link.
- **A real APNs or FCM send.** No credential exists yet.
- **A browser page on a second origin, on the R750.** That needs an allowed origin a browser can
  actually be served from, and adding one to a running deployment is an env change this wave is not
  permitted to make. The browser path end to end — mint, read a conversation, hold `/events` 30 s,
  fetch an avatar with the bearer, revoke, then read the 401 — is measured on grok-bot-local-vm from a
  real page on a genuinely different origin with Chrome's web security ON, and on the R750 the same
  door is proved from a native client sending `Origin: capacitor://localhost`, which is the shape an
  iOS shell actually sends.

---

## 8. The thing a phone cannot do today, and it is not push

**Measured on grok-bot-local-vm at 390x844, 2026-09-10:** at phone width `.shelf-utilities` computes
`display: none`, and the gear is the only control bound to `openSettings`. So **there is no route
into Settings on a phone at all** — not a cramped one, none. That is as true of the Mail card, the
job bus card and the endpoint picker as it is of the Notifications card this wave added.

It is pre-existing, it lives in `app.js` and `styles.css`, and it already has owners: **MOBILE-2**
moves the needs-you count into the window bar and **PHONE-IA-1** is the six-screen phone shape. It is
filed as **MOBILE-2c** with the phone pane as owner. The Notifications card itself was measured at a
phone viewport by opening Settings at a desktop width and then taking the viewport down, which is
honest about what was and was not proved.

---

## 9. What the shells do NOT get, and why

| | |
| --- | --- |
| **The live screen of the box** | The VNC websocket is the one route that carries a keyboard. A browser WebSocket cannot send a header, so a device bearer cannot open it. Not a gap to close later: a decision. |
| **The job bus (`/v1`)** | Its own token, its own door. A device bearer presented there is refused by shape and charges nothing. |
| **A session cookie** | A device bearer never mints one. A `Set-Cookie` on an asset response is also a Cloudflare cache bypass. |
| **Public asset URLs** | Assets are behind the login. `private` caching, not `public`. |

---

## 10. Filed, not fixed, with the cost of each named

| Row | What | Why it was not done here | Owner |
|---|---|---|---|
| **PUSH-2** | Push latency is up to 15 s, the sweep interval. A relay-held SSE subscription per tenant would bring it to about 1 s | New long-lived state in a process that holds one loop today | the phone pane |
| **PUSH-3** | The console's needs-you count counts agents, at most one each, and misses two of the six kinds, so it disagrees with a card-accurate badge in front of a customer | The count lives in `app.js`, which this item does not own | the phone pane |
| **MOBILE-2c** | Settings has no phone entry point at all: `.shelf-utilities` is `display:none` at 390px and the gear is the only opener | Two files this item does not own, and MOBILE-2 and PHONE-IA-1 already cover the shape | the phone pane |
| **HOST-PUSH-1** | The host's own `mobile-push-notifier` is bound in production and aimed at the old upstream, silent today only because no backend is configured. It becomes an egress of conversation previews the day a box gets one, and its copy says the wrong product name | The host bundle is not this wave's to change, and no box was swapped | whoever next swaps the host |
| **COST-2** | Two complete noVNC clients mount at phone width, 165 requests and 1,575.4 KiB, 39% of boot | About three lines of guard in a file the standing rule says not to author | the console pane |
| **HOST-DELTA** | A real delta stream, so the console stops re-reading ten things a tick | The one change in this whole design that genuinely wants a host verb | the host pane |

---

## 11. Config, for whoever deploys this

| variable | what it does |
| --- | --- |
| `SAND_UI_APP_ORIGINS` | comma-separated exact origins the shells run on. Empty, the default, is `capacitor://localhost,https://localhost`. A value with a trailing slash, a path or whitespace is dropped rather than half-honoured. |

Nothing else. No host change, no box swap: the token door is relay-side, and device and push rows live
beside `mail.json` in the tenant's own state directory (`devices.json`), which is why there is no
`cp/devices.mjs` — a device row is read on the hot path of every call a phone makes, and the control
plane is allowed to be down.

---

## 12. Where the code is

| | |
| --- | --- |
| `ui/auth-device.mjs` | the token format, the device rows, the CORS rules. The comment at the top is the argument for each choice. |
| `ui/server.mjs` | the login page template, `/auth/token`, `/auth/devices`, the CORS entry, the `tenantOf` arm, the `/admin/tenants/<slug>/devices` route |
| `ui/relay-hooks.mjs` | the seam `ui/api-diet.mjs`, `ui/asset-cache.mjs` and `ui/push-edge.mjs` land through: `shapeApiAnswer(method, args, headers, bytes) -> {bytes, headers}`, `assetPolicy(file, url, req) -> {headers, status}`, `stampHtml(html, url)`, and a push module's `handle({t, req, res, url, sub}) -> boolean` plus `sweepStart()`. Each module is optional; with none of them the relay answers bodies unchanged, assets `no-store`, and no push. |
| `ui/api-diet.mjs` | the outline and workflow projections, the digest protocol, the hashed outline key |
| `ui/asset-cache.mjs` | the asset policy: stamped URLs immutable, unstamped strong-ETag, `private` on both, and the `index.html` rewrite that does the stamping |
| `ui/machine-room/gateway-adapter.js` | the console's half: the projection headers, the single-flight refresh, the `visibilitychange` and `pagehide` pausing, the catch-up on resume, the avatar settle pass off first paint, and the `?agent=`/`?entry=` boot parse |
| `ui/push-edge.mjs` | the card decider, the six kinds, the two collapse rules, quiet hours, the badge, the ledger, the APNs and FCM senders and the stub |
| `ui/machine-room/push-settings.js`, `push-settings.css` | the console's Notifications card, mounted by its own `<link>` so `styles.css` is untouched |
| `cp/push.mjs`, `cp/admin.mjs`, `cp/admin/admin.js` | the two credential doors: the parsers, the vendor verdict tables, and the admin paste block under System health |
| `cp/cli.mjs` | `device list`, `device revoke` |
| tests | `auth-device`, `relay-device-bearer`, `relay-door`, `relay-hooks-absent`, `api-diet`, `asset-cache`, `push-edge`, `relay-push-routes`, `cp-admin` — all of them inside `npm test` |
| `scripts/verify-door.mjs` | the door and the token door in a real browser at real phone sizes. The budget clock starts when the shared box lock is acquired, not when the process does, which is the bug that made an earlier run report a fault it had not seen. |
| `scripts/verify-cost.mjs` | `--paint`, `--idle`, `--cache`, `--novnc`, `--desktop`, `--working`, with CDP network capture. Split across invocations to fit the 300 s ceiling. |
| `scripts/verify-push.mjs` | `--host` (the sweep against a real pending card with the stub sender) and `--console` (the Notifications card in a real browser at 390x844) |

---

## 13. What a shell author should measure, once there is a shell

The measured numbers on this page are the relay's. Three things only a real device can answer, and none
of them are claimed here:

- **the iOS zoom.** Chrome's `visualViewport.scale` stays 1 through focus, so an iPhone is the only
  thing that proves a 16 px control does not zoom.
- **push arriving with the app closed**, the tap landing on the right card, and the badge clearing on a
  second device.
- **the install rate on iOS**, which is the number that decides how much the store app is worth.

---

## 14. For the shell authors, in one paragraph

`POST /auth/token` returns a named, revocable, 30-day device bearer from an account sign-in or the
instance password, and re-mints silently for the same device when it carries a live bearer. That
bearer goes in `Authorization` on `/api` and on `/events` read with `fetch` plus a stream reader,
never `EventSource`. CORS answers only `capacitor://localhost` and `https://localhost` plus whatever
`SAND_UI_APP_ORIGINS` names, with no credentials. Images are fetched with the bearer and turned into
blob URLs. A 401 from us always carries `x-relay-auth: required` and never redirects a bearer request
into HTML; a bad bearer use is rate limited but does not charge the password lockout, while a failed
mint does, so stop on a 401, re-mint once, then ask the person, and never loop. A device bearer opens
no `/v1` and no websocket, so there is no live screen from a phone. Push registration is
`POST /push/devices` behind the same bearer, one push per card, collapsed per card on iOS and per
kind on Android, quiet hours holding the alert but never the badge. The deep link is
`titaniumbot://card?tenant=&agent=&entry=&kind=` with the https fallback `/?agent=&entry=`, and the
card it names may already have expired by the time a thumb reaches it.
