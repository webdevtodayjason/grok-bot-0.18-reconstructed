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
**PUSH-1 merge (`b8c5efc`)** and recorded at `d0827bb` — section 15's numbers are a later tree and name
their own commit, which is why the two `npm test` totals in this document differ — one at a time behind the shared box lock, each
inside the 300 s ceiling, each sending the user agent `titanbot-gate/<script>`. Phone legs at **390x844** and **430x932**, device scale 3, touch,
iPhone UA, real Chrome through playwright-core.

| Gate | Result | What it is |
| --- | --- | --- |
| `npm test` | **2,719 pass, 0 fail** | the whole suite, not only the new files |
| `verify-door.mjs --all` | **96 pass, 0 fail, 0 skip**, then after the review pass added seven legs: **`--cors` 25 pass, `--app` 15 pass, 0 fail** | the door at both phone widths, CORS, and a real page on a second origin minting, reading, holding `/events` 30 s and revoking |
| `verify-cost.mjs` (3 runs) | **15 pass, 0 fail, 1 skip** | first paint, idle, hidden, resume, the asset cache, noVNC printed by name, the desktop A/B |
| `verify-push.mjs --host` | **32 pass, 0 fail, 1 skip**, re-run unchanged after the review pass. **Since grown to 49 pass, 0 fail, 1 skip** by the app-contract follow-up, whose own legs and numbers are in section 15 | a real pending hand-off to exactly one recorded send, collapse, quiet hours, the badge, revoke, and since section 15 the desktop transport and the pending route |
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

### What the review pass found after all of that passed, and what it cost to fix

Six conditions, every one of them in a mechanism a gate was already green on. They are written up where
they belong (sections 3, 5 and 6) and the measurements are below. The shape worth keeping: **four of
the six were invisible to every gate because every gate measured the console's own origin**, and the
whole point of this wave is the origin that is not the console's.

| What | Measured | Now |
| --- | --- | --- |
| `x-titan-digest` was not exposed to cross-origin JavaScript, so the unchanged-answer protocol was dead on a bundled origin | live R750 preflight answered `access-control-expose-headers: x-relay-auth, etag`; in real Chrome on this Mac a cross-origin page saw `content-type` alone and `headers.get("x-titan-digest")` answered `null` | on the list, asserted by name in `verify-door --cors`, and `verify-door --app` now reads the digest off a real cross-origin answer (`628a2846…`, headers visible to the page: `content-type, x-titan-digest`) and proves the second identical read costs **20 bytes instead of 40,703** |
| CORS was granted on every route on the relay, not on the console API | live R750: `OPTIONS /v1/jobs`, `/admin/login-ledger`, `/mail/send`, `/code/start` each answered 204 with `access-control-allow-origin: capacitor://localhost` | `corsPath` names the paths in section 3 and nothing else; the four refused paths are asserted by name (401/404/405/401, no access-control headers) |
| an auto-review push put the command in the notification body, and auto-review exists because the command is risky | calling the shipped builders on this Mac with a realistic approval produced an `aps.alert.body` carrying a live `Authorization: Bearer sk_live_…` | six fixed sentences, one per kind; a test builds all six from model-written fields carrying a token-shaped string and asserts it reaches neither body |
| push device rows were keyed on `deviceId` alone, so one account could take over or silence another's phone | on this Mac: one account registering another's device id rewrote the row to its own token, and its `DELETE` of that id answered `removed: true` | keyed on (account, deviceId); `forget` and `prune` take the caller's account; the test now drives the case its own title claimed |
| a card no device would alert on was recorded `held` for ever, re-decided every 15 s, keeping its agent in the open set | on this Mac: five passes, `held` every time, `heldUntil` 0 every time, one tail read per pass | `muted` / `held` / `failed` split out, with the open set and the backoff to match; two tests drive five passes and a refusing sender |
| the ceilings are linear in conversation length, the break-even was written nowhere, and one stated figure was wrong | 1,239,452 bytes project to 40,707 over 1,578 items, **25.80 bytes an item**, so 250 KiB holds to about **9,900 items** | the break-even is beside the ceilings in section 5, asserted per item by `tests/api-diet.test.mjs`, printed with its break-even by `verify-cost --paint` (**25.80 bytes/item over 1,578 items, ceiling holds to 9,923**), and bounding the projection is filed as **COST-4** |

#### And the same six on the R750, through console.titanium.bot

Measured 2026-09-10 between 10:40Z and 10:58Z. Shipped with `deploy/r750/sync.sh --no-install` from a
detached clean worktree at the merged commit, relay restarted last, **no box swapped** (no `source/`
file changed) and **no control plane rebuilt** (no `cp/` file changed). The account legs ran as **two
throwaway customer accounts** on the demo workspace, removed afterwards with every device row they
made; never Jason's account and never Richard's.

| Leg | Before, on the same live host | After |
| --- | --- | --- |
| the expose list | `access-control-expose-headers: x-relay-auth, etag` | `x-relay-auth, etag, x-titan-digest`, with `vary: origin` on both answers |
| CORS on the rest of the relay | `OPTIONS /v1/jobs`, `/admin/login-ledger`, `/mail/send`, `/code/start` each **204 with `access-control-allow-origin: capacitor://localhost`** | **401 / 405 / 405 / 401 and zero access-control headers**, and `https://evil.example` still **403** with none |
| one device id, two accounts | — | both registered; each list showed **one row, its own**; account B's `DELETE` took B's row and left A's (`removed: true` then `removed: false` on a second try); A's own `DELETE` then took A's. This is the take-over that was possible before |
| the digest, cross-origin, on a real conversation | — | `x-titan-digest` readable under the new expose list; first read **38,735 decoded bytes**, second read carrying that digest **20 bytes** (`{"__unchanged":true}`) |
| `verify-door --url https://console.titanium.bot --cors` | — | **25 pass, 0 fail, 0 skip** |

**One thing to read carefully in section 5.** The idle figures, **56.1 KiB a minute local and 67.3 KiB
on the R750**, were measured **same-origin**, which before the first row above was the only
configuration where the digest memo worked at all. They are still same-origin numbers: what is proved
cross-origin is the mechanism, by `verify-door --app`, one conversation at a time rather than a
whole idle minute. A shell author measuring an idle minute from a bundled origin should expect the
local figure and should check the digest first if they do not get it.


### And on the R750, through console.titanium.bot, which is the only thing that makes any of it done

Measured 2026-09-10 between 07:34Z and 07:55Z as a **throwaway customer account** on the demo
workspace, removed afterwards along with every device and push row it made. Never Jason's account and
never Richard's. **No box was swapped**: this wave changes no `source/` file, so `updateHostNow` was
not run anywhere.

| Leg | Result |
| --- | --- |
| the door, `verify-door --url` at 390x844 and 430x932 | **48 pass, 0 fail** — every control 16 px and 48/48/46 px tall, 0 `[autofocus]`, `viewport-fit=cover`, `scrollWidth` equals `visualViewport.width` at both widths, Midnight ground, Signal Cyan button, the inline Ti mark, "Sign in - Titanium Bot", and the string "Machine Room" gone. **Before this ship, on the same live host:** 2,748 bytes titled "Sign in - Machine Room", 1 `[autofocus]`, no `viewport-fit`, button `#8b69ea`, no Signal Cyan and no Midnight |
| the token door and CORS, from a native client | **28 pass, 0 fail** — a preflight from `capacitor://localhost` answers **204** naming exactly that origin with **no allow-credentials**; `https://evil.example`, `https://localhost.evil.example` and `null` each get **403 and zero access-control headers**. **Before this ship the same preflight answered 401 with zero CORS headers of any kind.** |
| a bearer, end to end | minted for the throwaway account (251 chars, `tbd1.` prefix, never printed and never in a URL), read the roster cross-origin, held `/events` for **30,007 ms** with `fetch` plus a stream reader, revoked, and the next call was **401 with `x-relay-auth: required` and `redirected: false`** |
| the projection, live | `getConversationOutline` **37.8 KiB projected against 66.3 KiB whole** (wire, as the edge compresses), carrying `x-titan-digest` |
| the asset policy, live | `private, no-cache` plus a strong ETag, and a repeat read is a **304**. `cf-cache-status: BYPASS` on both, which is what private caching looks like from an edge |
| first paint at 390x844 | **173.0 KiB decoded over 33 calls, 46.6 KiB wire**, against the 250 KiB ceiling. Landed on the conversation the `?agent=` link named |
| 60 s idle at 390x844 | **67.3 KiB decoded, 21.5 KiB wire, 4 ticks**, against the 100 KiB ceiling. 60 s hidden: **0 calls** from this adapter. Coming back: **1** catch-up read |
| push | registration behind the device bearer (the token never handed back), the per-person switches, and the sweep running with **no credential stored, so a send is recorded by the stub rather than delivered** — the state Jason's paste changes and nothing else about the path |

**One defect only the R750 found, fixed and re-shipped inside this pass.** A device bearer revoked at
`DELETE /auth/devices/<id>` left its row in the workspace's `push.json`, so a phone a customer revoked
*because they lost it* went on being notified. `ui/push-edge.mjs` had written `forgetDevice` for
exactly this and named the revoke as its caller in a comment; nothing called it. Proved fixed on the
live host: after the fix, revoking `r750-revoke-proof` removed its row and the relay logged
*"device r750-revoke-proof will not be notified on demo either"*.

**One thing the live host does that this page did not know about.** Cloudflare Web Analytics injects
`static.cloudflareinsights.com/beacon.min.js` into every page on the zone, including the sign-in page,
and the page then posts a beacon to `/cdn-cgi/rum`. The door's own markup asks for **no** asset at all
(its favicon is a `data:` URI and the Ti mark is inline). It is the zone's setting, not this page's
markup, and it is printed by the gate rather than failed on — but it is worth knowing that the one
screen which is a credential form loads a third-party script.
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
| exposed headers | `x-relay-auth, etag, x-titan-digest` |
| paths it is on | `/api/*`, `/events`, `/auth/token`, `/auth/devices[/<id>]`, `/push/*`, `/avatars/*`, and the static console (`/`, `/index.html`, `/machine-room/*`, any asset extension). **Nothing else** |
| preflight cache | 600 s |
| `Vary` | `origin`, on every answer that saw an Origin, including a refused one |

Three things worth knowing:

- **It is an exact-string set.** Never a reflected Origin, never a prefix, never a regex. A prefix
  match on `https://localhost` would also match `https://localhost.evil.example`.
- **No credentials, deliberately.** The cookie is `SameSite=Strict` and a browser never sends it
  cross-site, so allowing credentials would buy a shell nothing and would trade away the console's
  CSRF answer. The bearer is the entire mechanism.
- **`x-titan-digest` is on the exposed list, and it has to be.** Only the names on that line are
  readable by cross-origin JavaScript; everything else the browser drops before the page sees it, with
  no error anywhere. It was missing until the review pass, which meant the unchanged-answer protocol
  below — the mechanism the 100 KiB idle ceiling rests on — was dead in exactly the shells this door
  exists for. Measured in real Chrome on this Mac 2026-09-10 against the live header set: the headers
  JS could see were `content-type` alone and `headers.get("x-titan-digest")` answered `null`.
- **CORS is on the console API and nowhere else.** The paths are the row above. The job bus (`/v1`),
  the relay's admin reads (`/admin`), the mail webhook and send routes and the code edge answer an app
  origin's preflight with **no access-control headers at all**, as they did before this wave. Nothing
  was exploitable when they did answer — no cookie is ever sent cross-site and each of those doors
  wants a credential a page does not hold — but `https://localhost` is on the default allow-list and is
  the commonest dev origin on a customer's own machine, so the blast radius of any future credential a
  page could hold belongs on `/api`, not on the whole relay.
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

**How far those ceilings hold, which is a property of today's data and not of the design.** The outline
is the one payload that grows without bound with a conversation, and it is projected rather than paged:
the host ignores `{limit}`, `{offset}` and `{afterId}` (measured — see the filed row **HOST-DELTA**),
so the projection shrinks a payload and does not bound one. Measured over
`tests/fixtures/outline-atera.json`, the real 1,578-item outline this wave captured, on grok-bot-local-vm
2026-09-10: **1,239,452 bytes become 40,707, which is 25.80 decoded bytes an item.** At that rate the
outline alone reaches the **250 KiB first-paint ceiling at about 9,900 items** and 100 KiB at about
3,970. Jason's longest conversation is the 1,578 in that fixture, so the first-paint ceiling holds to
roughly **6x today's worst case** and then stops holding, with no cap in the code. Bounding the
projection — every tool-call row plus the newest N anchors, a `truncated` marker, and the older span
fetched only when somebody scrolls into it — is filed as **COST-4**, not built here. The per-item figure
is asserted by `tests/api-diet.test.mjs` and printed by `scripts/verify-cost.mjs --paint`, so a
projection that grows per item fails a gate rather than waiting for a long conversation to find it.

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
  repeating a megabyte (20 bytes, `{"__unchanged":true}`). The relay returns **`x-titan-digest`** on
  every shaped answer so the next call has something to send. The console's own reader does all of
  this, and a shell that loads the console's bundle inherits it — **but only because
  `x-titan-digest` is on the exposed-headers line in section 3.** Cross-origin JavaScript cannot read
  a header that is not exposed, and it fails silently: `headers.get` answers `null`, the memo is never
  filled, nothing is ever sent back, and every idempotent read is downloaded whole on every tick. That
  was the state of this door until the review pass. If you are writing a shell and the digest comes
  back `null`, the relay's allow-list is the thing to check, not your code.
- **The outline projection discards what the console already throws away.** `weaveToolRows` emits
  rows only for `kind: tool-call` and `outlineKey` returns null for anything that is not a user or
  send-message item, so the outline shrinks by about 97% with nothing lost that the page draws:
  **1,239,452 bytes become 40,707** over `tests/fixtures/outline-atera.json` (1,578 items), measured on
  grok-bot-local-vm 2026-09-10, and **1,210.4 KiB became 39.8 KiB** on the same conversation read
  through the relay in the gate. (An earlier draft of this section said 57,777 with no machine and no
  payload named; it is 40,707 on the payload named here, which is what `ui/api-diet.mjs` and
  `tests/api-diet.test.mjs` have said all along.) The outline key is **hashed** rather than carried verbatim, because an outline key *is* the
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

**Every body and every answer on these routes is spelled out field by field in section 15, and a test
round-trips each one through the live route.** Read that section before writing a client: this block is
the map and section 15 is the wire. The prose here was not enough once already — see APPS-DOC-1.

```
POST /push/devices
{ "platform": "ios" | "android" | "desktop",
  "token": "<whatever the platform SDK handed back>",
  "deviceId": "<the same stable id the bearer was minted for>",
  "name": "Jason's iPhone",
  "env": "production" | "sandbox" }
→ 200 { "deviceId": "...", "platform": "...", "replaced": true|false, "message": "..." }

GET    /push/devices              → the person's devices, with NO token on any row
DELETE /push/devices/<deviceId>   → stops notifying it at once, and only the person's own rows
GET    /push/settings             → { settings, kinds, scope }   — scope is "person" or "workspace"
PUT    /push/settings             → kinds as a MAP of kind to boolean, quietHours {on, from, to},
                                    utcOffsetMinutes at the TOP LEVEL. A field left out is unchanged;
                                    an unknown field or a wrong type is a 400 naming it. PUT only.
GET    /push/pending              → what is waiting, decided by this relay (section 15, PUSH-5)
GET    /push/events               → the same cards as they change, for a desktop (section 15, PUSH-4)
```

**A row is keyed on (account, deviceId), and both halves matter.** The `deviceId` is chosen by the app
and is readable by anybody signed into the workspace, and two accounts share one workspace — which is
the whole reason the relay has a `sub` at all. So one physical phone signed into two accounts is **two
rows**, each carrying that account's cards, and a `DELETE` carries the caller's account: measured on
this Mac 2026-09-10 against the first draft, which keyed on `deviceId` alone, one person registering
another's device id rewrote that row to his own token — the other phone stopped being notified, left
its owner's list, and his `DELETE` of an id he had only read off the list answered `removed: true`.
A list shows exactly what a delete can remove, and nothing else.

**The instance-password door is the exception, deliberately.** That door has no person behind it, its
`sub` is `""`, and it sees and can clear **every** row in the workspace. It is the workspace itself: it
already listed every row before this, it is the operator holding the instance password, and it is the
only door that can clear a device whose account is gone.

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

A title, **one of six fixed sentences as the body**, the ids, a deep link, under **4096 bytes**.

**No field a model wrote ever reaches a notification body.** Not the approval's reason, not the
command it is about, not the box instruction, not a report's description. The body is whichever of
these six sentences the kind names (`CARD_BODY` in `ui/push-edge.mjs`), and nothing else:

| Kind | The body, every time |
|---|---|
| `auto-review` | Open it to read the command before you allow it. |
| `local-tool` | This runs on the box itself, not in a sandbox. |
| `widget` | Open it to answer. |
| `secret` | It needs a credential before it can carry on. |
| `box-handoff` | Open it to read what it needs done. |
| `report` | Open it to read the report before it goes. |

This is tighter than the first draft of this wave, which put the approval's reason and
`approval.command` verbatim in the body. Auto-review exists *because* a command is risky, which is the
same population of commands that carry credentials: measured on this Mac 2026-09-10, a realistic
approval produced an alert body carrying a live `Authorization: Bearer sk_live_…` on its way to Apple
and Google and onto a locked screen. The ids are in the payload, so **the app fetches the detail with
its own bearer and draws it inside the app, behind the device unlock**, which is where a command
belongs. The titles are unchanged: the host already shows the person's own summary line there, and a
title with no subject is unreadable on a phone.

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

**The ledger's state IS the retry policy, and "nothing went out" is three different facts.** A first
draft wrote `held` for all of them, so a card nobody would ever be alerted to was re-decided every
15 s for as long as it stayed unanswered and kept earning its agent a transcript-tail read — measured
on this Mac 2026-09-10: five passes, state `held` every time, `heldUntil` 0 every time, which at the
sweep interval is 5,760 re-decisions and 5,760 tail reads a day for one switched-off card.

| State | What it means | Retried |
|---|---|---|
| `alerted` | an alert went out | never (one push per card) |
| `held` | **quiet hours** held it; `heldUntil` says when the window ends | exactly once, on the first pass after `heldUntil` |
| `muted` | no device wanted it: every device's per-kind switch said no, or there is no device | **never**, and its agent leaves the open set so it stops costing a tail read |
| `failed` | a **vendor** refused it; `attempts` and `retryAt` carry the backoff | a minute, doubling to half an hour, six attempts, then it gives up and says so in the log |
| `closed` | answered or expired, and the silent badge update went out | never |

A transient APNs 500 retried every 15 s for ever is how a sender gets itself rate limited, which is
the same failure the prune rules exist to avoid; a switch the customer turned off is not a failure at
all and has nothing to retry.

**And `muted` is reopened by the one event that can change the answer**, which is the person saving
their own switches: `PUT /push/settings` drops this workspace's `muted` rows and clears any `heldUntil`,
so the cards already waiting are decided once on the next pass rather than only the next new one. A
switch still turned off puts them straight back to `muted`. One decision per save, not one every
fifteen seconds.

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

**That holding is the vendor path's, and on the desktop transport the tray is the surface that has to
stay silent.** `GET /push/events` and `GET /push/pending` carry every pending card whatever the
switches say, because a card list that went quiet would disagree with itself; the two fields that
decide whether a tray may make a sound are **`muted`** (the caller's per-kind switch) and **`quiet`**
with **`quietUntil`** (the caller's quiet window, open now, and when it ends). A shell that draws the
list but alerts on those rows is one customer getting a laptop notification their phone deliberately
did not make.

**A window that starts and ends at the same hour is refused at the wire**, 400 naming `quietHours.to`.
`9` to `9` holds nothing — an ambiguous window reads as off — so a person who meant "all day" would
otherwise be told it saved and get no quiet hours at all.

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

### The three attributes on the console's own page, for a shell that reads the DOM

**CONSOLE-ATTR-1.** The desktop shell loads `console.titanium.bot` in its window, and until a device
is signed in it has no bearer and no route — so a small injected script reads the page instead. Three
attributes are the contract for that, and they are the only three:

| Attribute | Where | What it carries |
|---|---|---|
| `data-needs-you-count` | the roster's needs-you pill | the number, as the attribute's **value** |
| `data-needs-you-card` | every **pending** card in the open conversation | `<conversation id>:<entry id>`, and `data-card-id` carries the same string, so neither side parses anything |
| `data-card-kind` | beside it | one of the six kinds, spelled the way the relay spells it |
| `data-agent` | beside it | the conversation's display name, falling back to its id, never empty |
| `data-title` | beside it | the relay's own title for that card, which is a **template** for `box-handoff` and `report` and the host's own summary line — **written by the model** — for `auto-review`, `local-tool`, `widget` and `secret`, exactly as section 6's "What a push carries" says. The **fixed** sentence is `data-card-kind`'s body, not the title |
| `data-href` | beside it | `/?agent=<id>&entry=<id>` — a console path, which is the only shape the shell's reader accepts |
| `data-talk-button` | the console's talk button | present |

**The count attribute already existed with no value, and that was actively wrong.** The slot is
`<span class="roster-needs-you" data-needs-you-count hidden>` and only its `textContent` was ever
written. The desktop's reader tries, in order, the attribute's value, then a number anywhere in the
text, then **the number of elements the selector matched** — and a hidden, empty pill matches, so with
**zero** agents needing a person it reported **1**, indistinguishable from a real count of 1. Measured
on this Mac 2026-09-10 by running that reader verbatim against the shipped markup: count 0 → **1**,
count 3 → 3. With the value written: 0 → 0, 3 → 3. A quiet console put a phantom 1 on the tray for
ever, and a real 1 could not be told from it.

**Three things a shell author has to know about the card attributes**, because each of them is a way to
be wrong quietly:

- **The card list is only the OPEN conversation, by construction.** The console draws cards for the
  active context alone, so `[data-needs-you-card]` is a partial list whose length changes when the
  person clicks around, while the count attribute is workspace-wide. **`GET /push/pending` is the
  authority** and these attributes are the fallback for a shell that has no bearer yet.
- **`data-title` is the title a push carries, and only two of the six kinds template it.** On a
  hand-off it is the relay's own sentence — `Take the keyboard for <agent>` — and
  never the agent-written instruction the card displays on screen, which is the field rule 5 keeps off a
  lock screen. **The other four kinds are the exception and not the rule**: `auto-review`, `local-tool`,
  `widget` and `secret` all carry the host's own summary line, which a model wrote, so a shell rendering
  `data-title` into a tray is rendering model prose four times out of six. The part rule 5 guarantees is
  the **body** — one of six fixed sentences — and a tray is a lock screen with a different shape.
- **A card with no durable id carries none of them.** An agent id the adapter could not resolve, an
  index-based `entry-<n>` id that is not stable across a re-read, and a page-local report offer that
  the relay will never push are all skipped outright rather than given a dead deep link. So the
  absence of the attribute means **the relay cannot push this card**, never "this card is not
  pending".
- **The id is the CONVERSATION and the entry, not the author and the entry.** The relay reads one
  transcript tail per row of `listAgents`, and a room is a row, so a card raised inside a room is a
  card on the room. The page's two obvious values are both wrong there — the entry's author is the
  member agent that raised it, and the first member is whoever happens to be first — and either one
  would open the console somewhere the card is not. The conversation opens the card where the person
  can answer it, which is what the link is for.

Settled cards, cards with an answer in flight, the skill card and the rail's copy of the hand-off carry
nothing: the rail card is the same hand-off drawn a second time, and attributing both would make every
open hand-off count twice.

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

**And the same rule one line further on, since PUSH-4.** A registered *desktop* reaches no vendor, so
on its own it must not arm this loop either: a workspace whose only device is a desktop, with nobody
connected to `GET /push/events`, also reaches its box **zero** times. With a stream open the pass runs,
because a card a tray has to hear about is what it is for. Both halves are counted by the gate, because
"one device registered and zero calls made" is the claim that makes registering a desktop safe.

For a workspace with a phone: one `listAgents` and one `listProblemReports`, then one
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
admin console (`api.titanium.bot/admin`, Keys, "Waking a phone"; the block sat on System health until
KEYS-2 gave the five paste forms their own rail entry), proved with the vendor
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

`node --test` over the whole suite — **2,719 pass, 0 fail** at the PUSH-1 merge (`b8c5efc`), including 29 tests of the decider, the
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
   either. **Since PUSH-4 a desktop reaches no vendor at all** (section 15, "the desktop transport"),
   so nothing on that table ever answers about one — but the `!== "android"` *shape* is what stopped
   the defect and is what the suite pins, because the next platform somebody adds is the one that
   would otherwise fall through. And the exit was worse than "the row stayed": a desktop row holds a
   device id where an APNs token belongs, Apple answers `BadDeviceToken` for that, and
   `BadDeviceToken` deliberately does not prune — so a registered desktop burned six attempts on the
   backoff, gave up, and kept its row for ever.

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

### The insets the shell reports, and the floor the console keeps anyway (PHONE-CONSOLE-1)

The shell is full-bleed over a `viewport-fit=cover` page and reports real safe-area insets: measured
on an iPhone 17 simulator, iOS 26.4, `env(safe-area-inset-top)` resolves to **62** and
`env(safe-area-inset-bottom)` to **34**, and Capacitor's `contentInset` moves nothing on such a page,
so `always` and `never` measure identically. The console now reads those four values into
`--sat`/`--sab`/`--sal`/`--sar` at phone width and pads the window bar and the two drawers with
`max(calc(8px + var(--sat)), 59px)`. The floor is what a shell that reports **nothing** gets: mobile
Safari, or any web view whose insets come back 0. Without it the bar's first row draws at y 8..52,
entirely under a 59 px status band — both drawer handles, the theme toggle and the gear. Measured in
WebKit at 390x844 in both states: 67 px of padding with the insets restated, 59 px without, and the
bar's own strip 44 px either way. A shell author has nothing to do for this; a shell that starts
reporting insets it did not report before simply gets the larger of the two.

---

## 8b. What the shell must give voice (VOICE-11)

Voice does nothing in the iPhone app today, and one root cause covers most of it: a `WKWebView` is
WebKit, and WebKit births an `AudioContext` **suspended**. Since VOICE-11 the console makes and
resumes its capture context synchronously inside the press, before it asks for the microphone
(`ui/machine-room/voice.js:406-408`, with the ask at `:414`) — there is no `await` above that ask,
because the user gesture is spent by the first one and iOS will not resume the context afterwards.
That is the page's half. These five are the shell's, and none of them can be done from inside the
page.

**1. Keep the remote origin.** Load `https://console.titanium.bot` in the web view. Do not serve the
console from a local bundle, a `file://` URL or a custom scheme: the voice socket is admitted only
when the `Origin` host equals the request host (`ui/voice-edge.mjs:377-387`, `originAllowed`), and a
page served from anywhere else is refused in words — "That came from a page this console does not
serve, so I did not open the microphone." (`ui/voice-edge.mjs:1480`). The refusal is correct and the
shell cannot argue with it.

**2. Grant the capture permission in `WKUIDelegate`.** Implement
`webView(_:requestMediaCapturePermissionFor:initiatedByFrame:type:decisionHandler:)` and answer
`.grant` for `.microphone`. Without it `getUserMedia` (`ui/machine-room/voice.js:414`) rejects with
`NotAllowedError` and the person reads the permission sentence forever, because the app has no
browser address bar to allow it in. Add `NSMicrophoneUsageDescription` to the app's Info.plist in the
same pass; a missing one is a launch-time crash, not a refusal.

**3. Inject `window.__titanbotShell` before first paint**, with
`WKUserScript(source:injectionTime: .atDocumentStart, forMainFrameOnly: false)`:

```js
window.__titanbotShell = { platform: "ios", build: "1.4.2", canOpenAppSettings: true };
```

`canOpenAppSettings` is true only when the shell really can open
`UIApplication.openSettingsURLString`. The console reads it at `ui/machine-room/voice.js:262-266` and
nowhere else, and it changes exactly one sentence: the denied-microphone line names **iPhone
Settings** instead of the browser. Nothing sniffs a user agent — which host this is, is a thing the
host says.

**4. Configure the audio session for both directions.** `AVAudioSession` category `.playAndRecord`
with options `[.defaultToSpeaker, .allowBluetooth]`, mode `.voiceChat`, activated before the first
press and deactivated when the call ends. Set `allowsInlineMediaPlayback = true` and
`mediaTypesRequiringUserActionForPlayback = []` on the `WKWebViewConfiguration`, or the reply plays
nowhere: playback is Web Audio scheduled off the socket (`ui/machine-room/voice.js:525`), not an
`<audio>` element a tap can start. Without `.defaultToSpeaker` the reply comes out of the earpiece at
a volume people report as "it didn't work".

**5. End the call when the app leaves the foreground.** The page already closes on
`visibilitychange`, `pagehide` and `beforeunload`, and the hold has a thirty second ceiling behind
that (`ui/machine-room/voice.js:226`) — but a shell that suspends the web view without firing those
should call `window.__voice.stop()` from `sceneWillResignActive`.

### What the simulator pass looks for

Run it on a real device as well; the simulator has no microphone worth the name. In order, and each
one is a thing a person does:

| | what a pass looks like |
|---|---|
| First press | the permission sheet appears **once**, on the first press only, and never again on later presses of the same install |
| A 1.2 s hold | the words become a chat line in the conversation within the turn window, and the reply is audible **on the speaker** |
| A tap | one plain sentence, "Hold the button while you talk.", and no line is opened |
| After a refusal | the press that clears the sentence, then a press a second later that really dials — with no reload and no app restart |
| Backgrounding mid-hold | the line closes; coming back to the foreground shows a button that is not drawn as held |

---

## 8c. What the shell must give the call screen (VOICE-13)

On a phone a press of Talk no longer opens a strip: it brings up a full-screen call screen, hands
free, and the page runs the whole of it over its own socket to `/voice/socket`. So the shells get **no
new route, no new token and no push** for this. Five asks, each one line, and none of them can be done
from inside the page.

**1. Everything in 8b still applies, first.** The remote origin, the `WKUIDelegate` capture grant with
`NSMicrophoneUsageDescription` beside it, and the audio session. Without the grant the press ends on
"This app has not been given the microphone yet" — MEASURED in WebKit with the grant withheld — which
a careless reading takes for a broken product rather than a permission nobody answered.

**2. `AVAudioSession` matters more here than it did for a hold.** A call is hands free and the phone is
likely on a table, so `.playAndRecord` with `[.defaultToSpeaker, .allowBluetooth]` is the difference
between a conversation and a reply nobody can hear out of the earpiece.

**3. Keep the screen awake while a call is up, if the shell can.** The one thing to watch is
`<body data-voice-call="up">`, which the page sets while the screen is up and removes on every path
out of it. The page also asks `navigator.wakeLock` and an optional
`window.__titanbotShell.setKeepAwake(true | false)` on its own, both in a `try`, so a shell that
implements neither is not a refused call — it is a screen that dims mid-sentence.

**4. `window.__titanbotShell = { platform: "ios" }`, injected at document start**, is what gives an
iPad-sized web view a call screen. The fallback without it is the 690 px width / 500 px height
predicate, which is a guess about a window rather than a fact about a host.

**5. A real phone call interrupting the audio needs no shell signal.** The page sees
`visibilitychange`, ends the call cleanly and leaves one plain line in the conversation. A shell that
suspends the web view without firing it should still call `window.__voice.stop()`.

### The behaviour change the desktop shell has to be told about

`data-talk-button` is still **exactly one** element — the count at section 11 holds, and neither the
call screen's Mute nor its End carries it. But the shell's global hotkey presses that one element, and
in a window **narrower than 690 px or shorter than 500 px** that press now opens a call screen rather
than toggling a strip. A second press of the hotkey while a call is up does nothing on purpose: the way
out is the End control on the screen, or Escape, which the page already honours.

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

---

## 15. The wire shapes, exactly

**Why this section exists at all.** Every field in it was named in prose somewhere above, and prose
was not enough. The phone app read section 6's sentence "the per-kind switches, quiet hours and one
UTC offset" and sent `{enabled, kinds: ["widget"], quietHours: {enabled, fromHour, toHour}}`. The
relay answered **200 `{"message":"Saved."}`** and stored none of it — and, measured on
grok-bot-local-vm 2026-09-10 against the real handler, did not merely ignore it but **overwrote**: a
workspace holding two muted kinds and quiet hours 23..6 came back with every kind on, quiet hours
**off** at the default 22..7, and the offset 0. A phone "saving quiet hours" turned the customer's
quiet hours off. A 200 that ignores a body is the worst shape a mismatch can take, and a document that
describes a field without spelling it is how one is built.

So this section is the spelling, and it is **pinned by a test rather than by discipline**:
`tests/apps-wire-shapes.test.mjs` reads every example below out of this file, starts a real relay from
a copy of `ui/`, mints a real bearer, drives each documented body through the live route, and asserts
the answer has **exactly** the keys the documented answer has — no key missing, no key extra, at every
level. An example edited here that the relay does not actually answer turns that test red.

Filed as **APPS-DOC-1**.

### How to read it

Every heading below is `METHOD path — what it is`, and the block under it is the literal JSON. Values
that change per call (tokens, ids, timestamps) are shown as a realistic example; the **keys and the
types** are the contract. Every route below is behind a device bearer for a shell, or the session
cookie for the console's own panel; none of them checks a credential itself.

### The token door

##### `POST /auth/token` — the body, an account sign-in
```json
{"email": "owner@example.com", "password": "the account's own password", "device": {"id": "dev_mac_9f2", "name": "Jason's iPhone", "platform": "ios"}}
```

##### `POST /auth/token` — the body, the instance-password door
```json
{"password": "the instance password", "device": {"id": "dev_mac_9f2", "name": "the operator's laptop", "platform": "desktop"}}
```

##### `POST /auth/token` — the body, a silent re-mint for the same device
```json
{"device": {"id": "dev_mac_9f2"}}
```

The re-mint carries the live bearer in `Authorization`. `device` is optional in all three bodies, and
`platform` is `ios`, `android` or `desktop` and nothing else. A `deviceId` at the top level is
accepted as well as `device.id`, because the push route spells it that way and sending the push
spelling here once minted a bearer for a freshly generated id instead of refusing. **Read the id off
the answer rather than assuming it.**

##### `POST /auth/token` — the answer
```json
{"token": "tbd1.…", "expiresAt": 1791606000000, "renewed": false, "tenant": "demo",
 "device": {"id": "dev_mac_9f2", "name": "Jason's iPhone", "platform": "ios", "createdAt": 1789000000000, "lastSeenAt": 1789000000000, "revokedAt": null}}
```

The token is answered **once, here**, and is never read back on any other route.

##### `GET /auth/devices` — the answer
```json
{"tenant": "demo",
 "devices": [{"id": "dev_mac_9f2", "name": "Jason's iPhone", "platform": "ios", "createdAt": 1789000000000, "lastSeenAt": 1789000300000, "revokedAt": null}]}
```

A revoked device stays on this list with `revokedAt` stamped, so it is visible that it was taken away.
**No row on this list carries a token**, here or on the push list below.

##### `DELETE /auth/devices/<id>` — the answer
```json
{"revoked": "dev_mac_9f2", "tenant": "demo"}
```

**`revoked` is the id, not a boolean** — the push route's `removed` beside it *is* a boolean, and the
two routes are spelled differently. This is the kind of thing a document written from prose gets wrong:
the first draft of this section said `{"id": …, "revoked": true}` and the round-trip test caught it
before a shell author did.

### Registering for notifications

##### `POST /push/devices` — the body
```json
{"platform": "ios", "token": "whatever the platform SDK handed back", "deviceId": "dev_mac_9f2", "name": "Jason's iPhone", "env": "production"}
```

`deviceId` is the **same** stable id the bearer was minted for. `env` is `production` or `sandbox` and
defaults to production. `platform` is `ios`, `android` or `desktop`; a desktop row is carried by
`GET /push/events` below and reaches no vendor. Anything else is a 400 that says so, and the row is
keyed on **(account, deviceId)**, so one physical machine signed into two accounts is two rows.

##### `POST /push/devices` — the answer
```json
{"deviceId": "dev_mac_9f2", "platform": "ios", "replaced": false, "message": "That device will be notified from now on."}
```

`replaced` is true when the same account registered the same `deviceId` before. **The token is never
answered back, here or anywhere.**

##### `GET /push/devices` — the answer
```json
{"devices": [{"deviceId": "dev_mac_9f2", "platform": "ios", "name": "Jason's iPhone", "env": "production", "createdAt": 1789000000000, "updatedAt": 1789000300000, "tokenAt": 1789000300000}]}
```

A list shows exactly what a `DELETE` can remove and nothing else: this person's own rows, or every row
in the workspace for the instance-password door.

##### `DELETE /push/devices/<deviceId>` — the answer
```json
{"deviceId": "dev_mac_9f2", "removed": true, "message": "That device will not be notified again."}
```

`removed` is false with the same 200 when there was no such row, because "there is nothing here by
that name" is an answer and not a failure.

### The switches

##### `GET /push/settings` — the answer
```json
{"settings": {"kinds": {"auto-review": true, "local-tool": true, "widget": true, "secret": true, "box-handoff": true, "report": true},
              "quietHours": {"on": false, "from": 22, "to": 7},
              "utcOffsetMinutes": 0},
 "kinds": ["auto-review", "local-tool", "widget", "secret", "box-handoff", "report"],
 "scope": "person"}
```

Three things a shell author gets wrong from the prose and will not get wrong from this:

- **`kinds` on the settings object is a MAP of kind to boolean.** A list of the kinds you want on is
  not read at all. The `kinds` beside it, at the top level, is the flat list of the six the server
  knows, so a panel draws the server's kinds rather than inventing its own.
- **`quietHours` is `{on, from, to}`**, whole hours, and **`utcOffsetMinutes` is at the TOP LEVEL** of
  the settings object rather than inside `quietHours`.
- **`scope` is `"person"` or `"workspace"`**, never `"account"`. A named account is a person; the
  instance-password door and the operator have nobody behind them, so their settings mean the whole
  workspace.

**There is no master switch.** The relay holds the six per-kind switches, quiet hours and the offset,
and nothing that means "none of it". A shell that wants one sends every kind `false`, which is the
mechanism this relay actually has; turning it back on sends them all `true`, so nobody is left with
six off switches behind an on switch.

##### `PUT /push/settings` — the body
```json
{"kinds": {"widget": false, "secret": false}, "quietHours": {"on": true, "from": 23, "to": 6}, "utcOffsetMinutes": -300}
```

**A field you leave out is left as it was.** This route is a merge and not a replace, so a panel may
`PUT` only what the person touched — `{"kinds": {"report": false}}` is a complete, valid body, and so
is `{}`. It was a full replace until this ship, which is the other half of why a phone saving quiet
hours un-muted two kinds: the body it sent carried no `kinds` and the route wrote the defaults.

`utcOffsetMinutes` is what a browser's `getTimezoneOffset()` answers, **negated** (the console sends
`-300` for US Central daylight time). The cost of an offset rather than a zone name is that a
daylight-saving change is an hour out until the app next opens.

##### `PUT /push/settings` — the answer
```json
{"settings": {"kinds": {"auto-review": true, "local-tool": true, "widget": false, "secret": false, "box-handoff": true, "report": true},
              "quietHours": {"on": true, "from": 23, "to": 6},
              "utcOffsetMinutes": -300},
 "message": "Saved."}
```

The switches come back off the relay rather than out of the page, so a panel draws what was stored.

##### `PUT /push/settings` — the refusal
```json
{"error": "bad_request", "field": "enabled", "message": "There is no setting called \"enabled\". This route takes kinds, quietHours and utcOffsetMinutes, and a field you leave out is left as it was. Nothing was stored."}
```

**400 and the field's name, never 200 and something else stored.** What is refused, and why each one
is a refusal rather than a quiet coercion — every line of this was measured on grok-bot-local-vm
2026-09-10 against the route as it was:

| Sent | Was | Is now |
|---|---|---|
| a field this route does not have (`enabled`), or a body with no known field at all | 200, and the defaults written over everything | 400 naming the field |
| a body that is not an object (a list, a string, `null`) | 200 `"Saved."`, defaults written | 400 saying the body has to be an object |
| `kinds` as a list | 200, every kind left on | 400 saying `kinds` is a map |
| a kind the server does not have (`kinds.mentions`) | 200, silently dropped | 400 naming `kinds.mentions` and listing the six |
| `kinds: {"widget": "false"}` | **stayed ON** — only a strict `false` mutes | 400 naming `kinds.widget` |
| `quietHours: {"on": "true"}` | **read OFF** — only a strict `true` arms | 400 naming `quietHours.on` |
| `utcOffsetMinutes: "-300"` | **honoured**, because `Number()` took it | 400 naming `utcOffsetMinutes` |
| `quietHours: {"from": 99}` | stored as **3** — `clampHour` is a modulo | 400 saying a whole hour from 0 to 23 |
| `quietHours: {"to": -4}` | stored as **20** | 400, the same |
| `quietHours: {"fromHour": 1}` | 200, silently dropped | 400 naming `quietHours.fromHour` and saying where the offset lives |
| a `POST` instead of a `PUT` | **accepted and saved**, while the route's own refusal sentence said "GET or PUT" | 405 `{"error": "GET or PUT"}` |
| a body that is **not JSON at all** (`{not json`) | 400 `{"error": "that was not JSON"}` — the one refusal with no `field` and an `error` that is not `bad_request`, so a shell switching on `error === "bad_request"` to point at a form control missed exactly the refusal it hits while its serialiser is still wrong | 400 `{"error": "bad_request", "field": "body", …}`, the same shape as every other refusal here. `POST /push/devices` answers the same way, with its own sentence |
| `quietHours: {"on": true, "from": 9, "to": 9}` | **200, and stored** — and then held nothing, for ever, silently, because an ambiguous window reads as off | 400 naming `quietHours.to`. Checked on the **merged** result rather than the body, because `from` and `to` can arrive one at a time in a patch, and only when the body touches `quietHours`, so a row already on disk that reads 9 to 9 cannot lock a panel out of every other save |

One loosely typed body used to produce three different outcomes — honoured, ignored, inverted — and
the server complained about none of them. That is the thing the strictness is for. The store still
reads a row already on disk forgivingly, because a stored row has to stay readable; the **wire**
refuses, because a wire has a client on the other end who can be told.

**Saving reopens what was muted.** A `PUT` here drops this workspace's `muted` ledger rows and clears
any quiet-hours deadline, so cards already waiting are decided once on the next pass rather than only
the next new one. Registering a device does the same thing, for the same reason.

### What is waiting, without deciding it yourself

##### `GET /push/pending` — the answer
```json
{"at": 1789000300000, "ageMs": 0, "memoMs": 5000, "agents": 12, "badge": 3,
 "cards": [{"key": "d6a325d5713e8b038b0d582fb726f1e2",
            "kind": "box-handoff",
            "agent": {"id": "agent_7c1", "name": "Books"},
            "entry": "t14s0",
            "requestId": "box-1",
            "title": "Take the keyboard for Books",
            "body": "Open it to read what it needs done.",
            "link": {"app": "titaniumbot://card?tenant=demo&agent=agent_7c1&entry=t14s0&kind=box-handoff",
                     "web": "https://console.titanium.bot/?agent=agent_7c1&entry=t14s0"},
            "at": 1789000290000,
            "deadlineMs": 0,
            "pending": true,
            "muted": false,
            "quiet": false,
            "quietUntil": 0}]}
```

**PUSH-5.** No route answered this, so the badge and the card decision existed only inside a push
payload — and the desktop shell ported the whole decider, the six kinds and the collapse hash
included, into its own Rust and polled the three underlying calls. Two copies of one rule drift, and
the copy on the shell is the one nobody notices has drifted.

What each field means, and the three that are easy to misread:

- **`key` is the collapse key**, and it is the same 32-hex value `apns-collapse-id` and Android's
  `notification.tag` carry for that card, so a tray and a lock screen are talking about one thing.
- **`body` is one of the six fixed sentences**, chosen by kind, and never a field a model wrote. This
  route is a notification body with a different shape and it keeps the same rule.
- **`title` is the title a push carries, and for four of the six kinds a model wrote it.**
  `box-handoff` and `report` are templates (`Take the keyboard for <agent>`); `auto-review`,
  `local-tool`, `widget` and `secret` carry the host's own summary line, which is model prose — see
  section 6's "What a push carries". It is **never** the agent-written *instruction* a hand-off card
  displays on screen, which is the field rule 5 keeps off a lock screen. The **fixed** sentence is
  `body`, not `title`.
- **`pending`** is false for a card that has been answered, dismissed or has expired. The list carries
  those too, so a tray can take a notification down rather than waiting for it to vanish.
- **`muted`, `quiet` and `quietUntil` are the three decorations, and they are what decides whether a
  tray may make a sound.** `muted` is the caller's own per-kind switch for this kind. `quiet` is true
  while the caller's own quiet window is open, and `quietUntil` is when that window ends in ms, or 0.
  All three decorate a row and **none of them changes `badge`**, because a badge counts cards that are
  waiting and a switch only decides whether anybody was told about them. A tray that alerts on a row
  carrying `muted` or `quiet` true is a notification on a laptop that the same customer's phone
  deliberately did not make — the relay refuses a muted kind and holds a quiet one on the vendor path,
  and this wire says so rather than leaving a shell to read the settings route and re-implement the
  window.
- **`deadlineMs`** is non-zero only for `auto-review` and `local-tool`, the two kinds that die in ten
  minutes. A card may already have expired by the time a thumb reaches it.
- **`ageMs` and `memoMs`**: how old this picture is, and how long one stands in for the next request.

**`badge` is the workspace's unfiltered pending count** — the same number the push payload carries —
**and it is not the console's needs-you pill.** The pill counts *agents*, at most one per agent, off
`awaitingUserResponse`, which is never raised for a local-tool permission ask or a secret request. So
it misses two of the six kinds and under-counts whenever one agent holds two cards. Measured on
grok-bot-local-vm 2026-09-10 with a real pending hand-off plus two other waves' cards on the same box:
**badge 3, pill 1**. Both are right about what they count. That is **PUSH-3**, it is not closed by this
route, and a shell that shows both numbers should expect them to differ.

**What it costs, and why there is a memo.** A full collection is **1 + 1 + N** gateway calls —
`listAgents`, `listProblemReports`, then one `getAgentTranscriptTail {limit: 5}` per agent. **Measured
on grok-bot-local-vm 2026-09-10** by `verify-push --host` against the live twelve-agent box: **14
gateway calls** upstream, about **30 KB decoded** off the box (11,857 + 14 + 12 × 1,535), and a
**1,757-byte** answer out to the caller — the answer is small because it is ids and six fixed
sentences; the cost is the reading. The sweep only stays cheap because it reads the tails of agents
whose roster row moved; a route has no previous roster to diff against. So one collected picture stands
in for the next **5 seconds** with its age on the answer: measured in the same run, a second read
inside the window cost **0 gateway calls** and answered the same picture 71 ms old. A client polling
once a second therefore gets a rising `ageMs` rather than fourteen calls a second, and without the memo
this route would be a worse cost than the polling it replaces.

**A box that does not answer is a 503, never an empty list**, because an empty list tells a tray that
everything has been answered:

##### `GET /push/pending` — the refusal when the box is unreachable
```json
{"error": "no_answer", "message": "That box did not answer, so there is nothing to say about what is waiting."}
```

### The desktop transport, which needs no vendor

##### `GET /push/events` — the response headers
```
content-type: text/event-stream
cache-control: no-cache
connection: keep-alive
x-accel-buffering: no
```

**Two of those four do not reach a shell, and a shell author checking for them will think the route is
broken.** They are hints addressed to whatever proxy sits in front of the relay, not to a client, and
**Cloudflare strips them**: measured on the R750 2026-09-10, `GET /push/events` through
`console.titanium.bot` answers HTTP/2 200 with `content-type: text/event-stream` and
`cache-control: no-cache` and **no `x-accel-buffering` and no `connection`** — while the same handler
on this Mac answers all four (`verify-push --host`). What has to survive the edge is the content type,
the no-cache, and that the bytes actually flow; the other two are there so they are never the reason
the bytes do not.

**PUSH-4.** `POST /push/devices` accepted `platform: desktop` from the first day and then routed it to
the **APNs** sender, on the reasoning that a desktop app is signed by the same Apple account. That is
not a transport. Windows has no APNs at all, and macOS needs an `aps-environment` entitlement and an
embedded provisioning profile, the same restricted class that stops an ad hoc build launching. So the
desktop shell left registration switched off and polled.

And registering anyway was **worse than not registering**, in a way worth writing down because the
filed row understated it. A desktop row holds a device id where an APNs token belongs, and Apple's
answer to that is `BadDeviceToken` — which `prunesDevice` deliberately does **not** prune, because a
bad token is our bug and not the device's. Measured on this Mac 2026-09-10: 400 `BadDeviceToken`,
403 `InvalidProviderToken`, 400 `DeviceTokenNotForTopic` and 500 all answer "". So every card went
`failed`, burned six attempts on the backoff, gave up, and the row stayed in `push.json` for ever.
There was no exit at all.

So a desktop is carried here instead. **What registration now means for a desktop:**

- the row is recorded exactly as any other, keyed on (account, deviceId), and `token` may be the
  machine's own stable id — nothing is ever sent to it;
- **no vendor is ever asked about it**, for the alert and for the silent badge update alike;
- **on its own it does not arm the 15-second sweep.** A workspace whose only device is a desktop, with
  nobody connected, reaches its box **zero times** — the same assertion the no-device case carries.
  With a stream open the pass runs, because a card a tray has to hear about is what it is for.

On connect the stream writes **the cards as they stand**, one frame each, so a tray that has just
started knows what is waiting without a card having to move first. After that it re-reads when the
box's own `/events` moves (debounced, and never more often than once a second), and on a slow refresh
as a fallback for a box whose stream this relay cannot hold.

##### `GET /push/events` — a pending frame
```json
{"channel": "push-card",
 "payload": {"state": "pending", "badge": 3, "ageMs": 0,
             "key": "d6a325d5713e8b038b0d582fb726f1e2",
             "kind": "box-handoff",
             "agent": {"id": "agent_7c1", "name": "Books"},
             "entry": "t14s0",
             "requestId": "box-1",
             "title": "Take the keyboard for Books",
             "body": "Open it to read what it needs done.",
             "link": {"app": "titaniumbot://card?tenant=demo&agent=agent_7c1&entry=t14s0&kind=box-handoff",
                      "web": "https://console.titanium.bot/?agent=agent_7c1&entry=t14s0"},
             "at": 1789000290000, "deadlineMs": 0, "pending": true,
             "muted": false, "quiet": false, "quietUntil": 0}}
```

##### `GET /push/events` — a closed frame
```json
{"channel": "push-card",
 "payload": {"state": "closed", "badge": 2, "ageMs": 0,
             "key": "d6a325d5713e8b038b0d582fb726f1e2",
             "kind": "box-handoff",
             "agent": {"id": "agent_7c1", "name": "Books"},
             "entry": "t14s0"}}
```

The payload inside a `pending` frame is the **same row** `GET /push/pending` answers, with `state` and
`badge` on it, so a tray has one shape to draw and not two. A `closed` frame is the same `key`, so the
notification it closes is the one that comes down rather than a second one appearing about it.

Six rules a shell author should know about this stream:

1. **The dedupe is per connection, and this path never writes `push-sent.json`.** `alerted` is
   terminal for every device in that ledger, so recording a tray delivery there would silence the same
   card for a phone that registered afterwards. Two trays both get the whole picture on connect.
2. **The collapse key and the six sentences are a push's**, so what a tray shows is what a lock screen
   would have shown.
3. **Read it with `fetch` plus a stream reader, never `EventSource`**, for the same reason `/events`
   says so: `EventSource` cannot carry the `Authorization` header.
4. **It is not the relay's `GET /events`.** That one is the box's own frame stream, piped through
   unchanged, and it carries no cards. This one is at `/push/events`, is answered by the push module
   itself, and carries nothing but cards.
5. **This stream is a data feed and the tray is the surface that has to stay silent.** Every pending
   card arrives here, a muted kind and a quiet window included, because a card list that went quiet
   inside a quiet window would disagree with `GET /push/pending`, which is the authority. The two
   fields that decide whether the shell may make a sound are **`muted`** (this caller's per-kind
   switch) and **`quiet`** with **`quietUntil`** (this caller's quiet window, open now, and when it
   ends). On the vendor path the relay itself refuses a muted kind and holds a quiet one with exactly
   one catch-up; here it tells the shell instead, and a shell that ignores both gives one customer a
   laptop notification their phone deliberately did not make.
6. **The connection lives as long as its credential, not as long as its socket.** The bearer is
   re-checked on the heartbeat and before every projection, so a revoked device's stream ends within
   one heartbeat rather than running on. The stream also ends on its own after **15 minutes** whatever
   else happens. Both endings look the same to a shell — the stream closes — so **reopen it**; a `:
   gone` or `: time` comment says which it was for anybody reading a live stream by hand.

### What this section measured, on what, at what

**grok-bot-local-vm on this Mac, 2026-09-10**, against a relay spawned from this worktree talking to
that box, one gate at a time behind the shared box lock, gate user agent
`titanbot-gate/verify-push.mjs`. `node scripts/verify-push.mjs --host` — **49 pass, 0 fail, 1 skip**
(the skip is the mint door, which this relay does not serve; it is closed separately by
`tests/apps-wire-shapes.test.mjs`, which mints a real bearer through it).

| Leg | Result |
| --- | --- |
| a registered desktop, nobody connected | **0 gateway calls**, the pass saying `only a desktop is registered and none is listening`, with the row on disk (devices 1, carried 1, listening 0) and nothing handed to a sender |
| a tray connecting | `GET /push/events` answered **200** with `text/event-stream`, `no-cache`, `x-accel-buffering: no`; the pass then ran (listening 1) and still reached no vendor. With the tray gone: back to **0 calls** |
| `GET /push/pending` against a real pending hand-off | **badge 3**, against the gate's own independent count of **3** read straight from the box across 12 agents. The row carried the push's own collapse key, `Take the keyboard for <agent>`, and `Open it to read what it needs done.` |
| what one collection costs | **14 gateway calls over 12 agents**, a **1,757-byte** answer; a second read inside the memo window **0 calls**, the same picture 71 ms old |
| the tray and the card | the pending frame **2 ms** after the connection opened, on channel `push-card`, carrying the same row the route answers; the **closed** frame on the same key **4 s** after the hand-back |
| what was written down | 4 tray frames swept beside every recorded send and log line for a device token, a private key, a bearer and a gateway token: **clean**. Longest notification body 45 characters |

`npm test` over the whole suite: **2,803 pass, 0 fail** in 33.4 s on the same machine at the app-contract
merge (`77cf3f5`, the tree this section was measured at — the gate table near the top of this document
is the earlier PUSH-1 merge and says so), including the wire-shape round-trips through a real relay and the 35 that pin the three page
attributes out of the shipped files. The other gates on the same box, one at a time: `verify-push
--console` real Chrome at 390x844 scale 3 touch **21 pass, 0 fail, 3 skip**; `verify-mobile --width
--desktop` **27 pass, 0 fail, 1 skip**; `verify-door --door --cors --app` **93 pass, 0 fail, 1 skip**.

### And on the R750, through console.titanium.bot, which is what makes it done

Shipped with `deploy/r750/sync.sh --no-install` from a detached clean worktree at the merged commit
(host bundle `77cf3f55e148`), relay restarted **last**, **no box swapped** and **no control plane
rebuilt** — this wave changes no `source/` and no `cp/` file. Measured between **12:21Z and 12:31Z on
2026-09-10** as a **throwaway customer account on the demo workspace**, removed afterwards with every
device row and bearer it made. Never Jason's account and never Richard's.

| Leg | Before, on the same live host | After |
| --- | --- | --- |
| the prose body the phone app sent | **200 `"Saved."`** — and the account's stored settings became the DEFAULTS: `widget` back **on**, quiet hours **off at 22 to 7**, offset **0**, all of it read back off the live route | **400** naming `enabled`, and the stored settings byte for byte unchanged (`widget` still off, quiet hours still on 23 to 6, offset still -300) |
| six other wrong shapes (`kinds.widget: "false"`, `quietHours.on: "true"`, `from: 99`, `fromHour: 1`, `utcOffsetMinutes: "-300"`, a JSON list) | **200** on every one | **400** on every one, each naming its own field |
| `POST /push/settings` | **200, and it saved** | **405 `{"error": "GET or PUT"}`** |
| a partial body `{kinds: {report: false}}` | 200, and it reset everything else to the defaults | 200, `report` off and **nothing else moved** |
| the documented body | 200 | 200, round-tripping byte for byte, `scope` `person` |
| `GET /push/pending` | **404** | **200** with exactly the six documented keys; on a real pending hand-off **badge 1** over 9 agents in a **670-byte** answer, the row carrying the push's own collapse key `fcfe865fea4964bc07e7d506cecc55f4`, `Take the keyboard for <agent>` and `Open it to read what it needs done.` The agent's own 38-character instruction appears **nowhere** on the row (rule 5) |
| the memo, back to back through Cloudflare | — | first read **97 ms** and `ageMs 0` (a collection), the next three **32 to 34 ms** with `ageMs` 95, 130, 163 against `memoMs 5000` |
| `GET /push/events` | **404** | **200 `text/event-stream`, `no-cache`**; a real pending card arrived as a `push-card` frame on the same key the route answers, `state pending`, `badge 1` |
| the three page attributes, real Chrome at 390x844 and 1440x900 | — | **10 pass, 0 fail**: `data-needs-you-count="0"` on the roster pill, and the desktop shell's own reader run verbatim against the live page answers **0** where the same page answers **1** with the value removed. `data-talk-button` on one element, id `voice-talk`. No page error at either size |

**One thing the live host corrected about this document**, and it is the kind of thing that only the
edge can tell you: `x-accel-buffering` and `connection` do not survive Cloudflare. The header block
above now says so.

### One thing this section does not document

**A real APNs or FCM send.** No credential exists yet, so every measured number in this document came
off the stub sender, which records exactly what would have gone out. The day a credential lands,
nothing in this section changes except which sender the edge picks.

**A pending card of every kind on the R750.** The live leg made a real `box-handoff` and read it
through both new routes. The other five kinds were measured on grok-bot-local-vm only, because each one
needs a model to reach for a particular tool and the card decision is the same code for all six.

### 16. The review pass over this section, and what the live host said about it

Six conditions, filed together as **PUSH-7**, all fixed at **`9e2512e`**. One was a blocker and the rest
were a wire that said less than it should have.

**A revoked bearer kept the card stream it was already holding.** `GET /push/events` authenticated once,
at connect, and never again, so a revoked laptop went on receiving every pending card in the workspace —
title, agent, entry id and deep link — for as long as it held the connection, which the 25 s heartbeat
kept alive indefinitely. Revoke is the lost-laptop control and section 2 sells it as one. The relay now
re-reads the caller's credential before every projection and on every heartbeat, with a **fresh**
device-session read rather than the memoised one (an SSE request lives as long as the tray, so the memo
would answer with the row as it was at connect for ever), and closes the connection when the credential
is gone or the check throws. **Fail closed**, because the shell reopens through the door where the
credential is checked properly. Beside it, a **15-minute** hard lifetime so a relay whose reader is the
default still bounds how long a credential's reach outlives the credential.

**The desktop transport honoured neither switch** the settings route exists to hold, while the vendor path
refuses a muted kind and holds a quiet one with one catch-up — one customer, one set of switches, two
different answers. The decision is that **the stream is the list and the tray is the surface that stays
silent**: every pending card still arrives, and `quiet` with `quietUntil` joins `muted` on the row so the
shell knows. Stream rules 5 and 6 above say so, and so does "Expiry, quiet hours and the badge".

**The other four:** the title is called fixed in two places and for four of the six kinds a model wrote it
(corrected in the attribute table, the bullet under it and the relay's own comment); a body that was not
JSON at all was the one refusal without `field` and with an `error` that is not `bad_request`, on the
settings route and the device route alike; a quiet window whose `from` equals its `to` stored with 200 and
then held nothing, for ever, silently; and this document gave the whole-suite number twice for one machine
with two different values and no commit on either.

**Measured on grok-bot-local-vm (this Mac), 2026-09-10, at `9e2512e`:** `npm test` **2,808 pass, 0 fail** in
33.7 s. `node scripts/verify-push.mjs --host` **59 pass, 0 fail, 1 skip** (the same skip, the mint door),
with the revoked tray's stream **ending 0.6 s after the revoke**, **0 frames** on it afterwards, and the
tray beside it untouched — 2 streams open before, 1 after, which is the half that proves a revoke reaches
one connection and not every tray on the workspace.

**Measured on the R750 through `https://console.titanium.bot`, 2026-09-10 15:56Z to 15:57Z**, shipped with
`deploy/r750/sync.sh --no-install` from the clean tree at this commit (host bundle `35937d3480ed`), relay
restarted **last**, **no box swapped** and **no control plane rebuilt**. A **throwaway customer account on
the demo workspace**, removed afterwards with every device row and bearer it made. Never Jason's account
and never Richard's.

| Leg | Measured |
| --- | --- |
| a bearer opens `GET /push/events`, then is revoked | **200 `text/event-stream`**; `DELETE /auth/devices/<id>` answered **200**, the same bearer then **401** on `GET /push/pending`, and the relay **ended the held stream 11.0 s later** (the slow refresh's own cadence) with **0 card frames** on it after the revoke. Before this ship the same bearer's stream delivered a card **5 s after** the revoke |
| a row inside a live quiet window | `quietHours` saved as **15:00 to 16:00 UTC** with the offset at 0 at UTC hour 15; `GET /push/pending` answered **badge 1** over 9 agents in **637 bytes**, and the row carried **`quiet: true`** with **`quietUntil` 2026-09-10T16:00:00.000Z** — **14 keys**, the two new ones included, where the frame measured before the fix had 15 keys and none matching /quiet/i |
| a body that is not JSON | **400**, `error` **bad_request** and `field` **body**, on `PUT /push/settings` **and** on `POST /push/devices`, where both answered `error` "that was not JSON" with no field before |
| `quietHours` on, from 9, to 9 | **400 naming `quietHours.to`** and nothing stored (read back off at 22 to 7), where it was 200 and stored before. And it is the **merged** window that is checked: a real 23-to-6 window saved 200, then a patch moving only `to` onto the stored `from` was **400** |
| the three page attributes, real Chrome at 1440x900 | **11 pass, 0 fail** on a real **widget** card: `data-needs-you-card` naming the same `<agent>:<entry>` the route names, `data-card-kind` `widget`, `data-talk-button` on exactly one element, `data-needs-you-count="1"` beside the pill text "1 needs you", no page error. And `data-title` carried the model's own sentence — `Shall I proceed with CANARY-o0cc3v?` — byte for byte what `GET /push/pending` answered, which is the thing the attribute table now says out loud |

**One thing this run left behind, and it is PUSH-6's.** The throwaway account's device rows were removed
with it, but its per-person **settings** row stays in the tenant's `push.json` keyed on a sub that no
longer has an account, because nothing removes one. That is exactly the condition PUSH-6 is filed for,
owner the next push wave, and this run made one more of them rather than fixing it out of scope.
