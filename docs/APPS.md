# The phone and desktop apps (DOOR-1, STORE-1, COST-1, PUSH-1)

This is the contract between the relay and the two app shells. The shells live in their own
repositories and are built by their own panes; this page is what they are built against, so a shell
author reads one document rather than three transcripts.

Jason, 2026-09-09 22:21: *"I don't want to do a PWA phone app. I want to do a real phone app wrapper
installed in the iOS App Store."* So the shells bundle their own assets, which makes them
cross-origin to `console.titanium.bot`, which is why every section below exists.

**What landed in this wave, and what did not.** The front door (DOOR-1) and the token door (STORE-1's
server half) are built and measured. The data diet (COST-1) and push (PUSH-1's server half) are the
other two items of the same wave and land through the same hook seam; the sections here marked
PLANNED describe the contract they are being built to, so a shell can be written against it now, and
they carry no measured numbers until they do. **Measured and planned are kept visibly apart on this
page and every number names the machine and the viewport it was taken on.**

---

## 1. The two credentials, and which one a shell holds

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
4. **Rotating the instance password kills every device token at once.** They are signed with the
   cookie secret, which `set-password.mjs` rewrites. That is deliberate: it is the operator's one
   revoke-everything lever, the same one the cookie already had.
5. **A device bearer is strictly less than the cookie.** It does not open `/v1` (the job bus keeps its
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

---

## 2. CORS: exactly these origins, and never credentials

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

## 3. The front door (DOOR-1) — MEASURED

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

## 4. The data diet (COST-1) — PLANNED

**Measured on grok-bot-local-vm at 390x844, 2026-09-09, decoded bytes**: first paint is 75 calls over
34 paths for **2,462 KiB of API** (`getConversationOutline` alone 1,210 KiB) on top of **1,547 KiB of
JS**; 60 s idle costs **139 requests and 1,623 KiB**; every asset answers `cache-control: no-store`
and, live, `cf-cache-status: DYNAMIC`.

The ceilings, which are Jason's default and which he can move: **250 KiB of API on first paint** and
**100 KiB per idle minute** at 390x844, on **decoded** bytes. Decoded, because that is what the phone
parses, and because production compresses while the local relay does not — one call measures 1,210
KiB locally and about 37 KiB live. Wire bytes are printed beside decoded; every pass or fail is
decided on decoded.

What a shell needs to know about it:

- The relay may answer a projection of a gateway command rather than the whole thing. Projections are
  opt-in per call and marked: an answer that was shaped carries **`x-titan-projection: <method>`**.
- A call may send **`x-titan-if-digest: <digest>`** to mean "I already hold this"; the answer then
  says so in its body rather than repeating a megabyte. The console's own reader does this; a shell
  that reuses the console's bundle gets it for free.
- Assets will answer a strong **`ETag`** with **`private, max-age=…`** — `private`, never `public`,
  because assets are behind the login and the relay writes no `Vary`, so a publicly cacheable answer
  would let an edge serve a signed-in 200, or a 401, to everybody. **Cloudflare will keep answering
  `cf-cache-status: BYPASS` on these, deliberately.** That is the intended outcome of private
  caching, not a failure.
- A shell that bundles the console's assets is not reading them over the network at all and is
  unaffected by the asset half.

Proof, when it lands: `scripts/verify-cost.mjs`, CDP network capture, first-paint and 60 s idle
decoded bytes at 390x844, failing above the ceilings, with the desktop layout unchanged.

---

## 5. Push (PUSH-1 server half) — PLANNED

Registration, behind the same device bearer:

```
POST /push/devices
Authorization: Bearer tbd1.…
Content-Type: application/json

{"platform": "ios", "token": "<the APNs or FCM token>", "deviceId": "dev_…"}
```

The trigger: when a **pending card** appears on a conversation — a decision, a hand-off, a report
offer, a needs-you — the relay sends **one push per card**, collapsed on the card id, so a card that
is seen twice does not arrive twice.

The payload carries a title, a reason clipped to **140 characters** (the host's own
`MAX_NOTIFICATION_BODY_LENGTH`), the ids, a deep link, and nothing else, under 4,096 bytes. **Nothing
a person did not ask to see on a lock screen.**

The deep link:

```
titaniumbot://card?tenant=<slug>&agent=<agent id>&entry=<entry id>&kind=<card kind>
```

with the https fallback `https://console.titanium.bot/?agent=<agent id>&entry=<entry id>` for a
device with no app installed. A badge count equals the person's pending cards.

Per-kind switches and quiet hours are per **account**, in the console's Settings. The APNs key (a
`.p8`, with its key and team and bundle ids) and the Firebase service account JSON are pasted once in
the admin console and stored the way a provider key is: **write-only, proved before stored, never
answered back, never pushed into a box.** The relay holds them in memory only.

Proof, when it lands: unit tests for the trigger and the collapse, plus
`scripts/verify-push.mjs` against stub senders that record what would have been sent.

**Two things a shell author should plan around.** Push latency is up to the sweep interval (PUSH-2
would cut it to about a second with a relay-held subscription per tenant, and is filed not built).
And the console's current needs-you count counts agents rather than cards and misses two of the six
card kinds, so it will disagree with a card-accurate badge until PUSH-3 lands.

---

## 6. What the shells do NOT get, and why

| | |
| --- | --- |
| **The live screen of the box** | The VNC websocket is the one route that carries a keyboard. A browser WebSocket cannot send a header, so a device bearer cannot open it. Not a gap to close later: a decision. |
| **The job bus (`/v1`)** | Its own token, its own door. A device bearer presented there is refused by shape and charges nothing. |
| **A session cookie** | A device bearer never mints one. A `Set-Cookie` on an asset response is also a Cloudflare cache bypass. |
| **Public asset URLs** | Assets are behind the login. `private` caching, not `public`. |

---

## 7. Config, for whoever deploys this

| variable | what it does |
| --- | --- |
| `SAND_UI_APP_ORIGINS` | comma-separated exact origins the shells run on. Empty, the default, is `capacitor://localhost,https://localhost`. A value with a trailing slash, a path or whitespace is dropped rather than half-honoured. |

Nothing else. No host change, no box swap: the token door is relay-side, and device and push rows live
beside `mail.json` in the tenant's own state directory (`devices.json`), which is why there is no
`cp/devices.mjs` — a device row is read on the hot path of every call a phone makes, and the control
plane is allowed to be down.

---

## 8. Where the code is

| | |
| --- | --- |
| `ui/auth-device.mjs` | the token format, the device rows, the CORS rules. The comment at the top is the argument for each choice. |
| `ui/server.mjs` | the login page template, `/auth/token`, `/auth/devices`, the CORS entry, the `tenantOf` arm, the `/admin/tenants/<slug>/devices` route |
| `ui/relay-hooks.mjs` | the seam `ui/api-diet.mjs`, `ui/asset-cache.mjs` and `ui/push-edge.mjs` land through: `shapeApiAnswer(method, args, headers, bytes) -> {bytes, headers}`, `assetPolicy(file, url, req) -> {headers, status}`, `stampHtml(html, url)`, and a push module's `handle({t, req, res, url, sub}) -> boolean` plus `sweepStart()`. Each module is optional; with none of them the relay answers bodies unchanged, assets `no-store`, and no push. |
| `cp/cli.mjs` | `device list`, `device revoke` |
| `tests/auth-device.test.mjs`, `tests/relay-device-bearer.test.mjs`, `tests/relay-door.test.mjs`, `tests/relay-hooks-absent.test.mjs` | 41 tests, all of them in `npm test` (2,301 / 2,301 on this Mac 2026-09-10) |
| `scripts/verify-door.mjs` | the door and the token door in a real browser at real phone sizes. `--all` is 96 PASS / 0 FAIL in 44 s wall, inside the 300 s ceiling; the budget clock starts when the shared box lock is acquired, not when the process does. |

---

## 9. What a shell author should measure, once there is a shell

The measured numbers on this page are the relay's. Three things only a real device can answer, and none
of them are claimed here:

- **the iOS zoom.** Chrome's `visualViewport.scale` stays 1 through focus, so an iPhone is the only
  thing that proves a 16 px control does not zoom.
- **push arriving with the app closed**, the tap landing on the right card, and the badge clearing on a
  second device.
- **the install rate on iOS**, which is the number that decides how much the store app is worth.
