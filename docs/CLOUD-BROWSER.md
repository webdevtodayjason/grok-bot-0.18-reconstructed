# The cloud browser

CLOUD-BROWSER-1. Titan's four browser tools — `browser_open`, `browser_click`, `browser_type`,
`browser_screenshot` — can drive a browser somewhere else instead of the Chrome inside the box. The
tools do not change. Their names, their descriptions, their arguments and the rule about who gets
them are all exactly what they were. What changes is which browser is on the other end.

## Why there is a second engine at all

Marketing is the reason. Three things the box's own Chrome cannot do:

- **A residential exit.** A sign-up from a datacentre address is refused before the form is read.
- **A saved login that survives a box swap.** The box's Chrome profile is inside the box, and a
  recreate takes it with it.
- **A page a person can take over.** When a page asks for a phone code, an identity check or a
  captcha, the work has to reach a person *inside the same session* or it is lost.

A cloud browser is those three things. Everything else about it is worse than the box's own Chrome —
it costs money, it is slower to start, and its screen is not on the desktop the person is watching —
so the box stays the default and the cloud is where the box cannot go.

## Which browser runs a page

Three ways an engine is chosen, in this order:

1. **The operator pinned one** for this workspace.
2. **The site is on the workspace's cloud list.** Out of the box: `instagram.com`, `facebook.com`,
   `linkedin.com`.
3. **The box tried and came back with nothing usable** — a sign-in wall, a challenge page, or a page
   that loaded and said nothing.

That third one is new, and it exists because of a measurement. On grok-bot-local-vm, 2026-09-09,
`instagram.com/titaniumcomputing/` answered HTTP 200 in **3,259 ms** through the box's Chrome with
`needsLogin: false`, `blocked: false`, and Meta's footer chrome as its **entire text**. No follower
count, no bio, no posts. Neither of the two old verdicts fired, so the model was handed a footer and
would have summarised it as though it had read the page — and a router keyed on those two verdicts
would never have reached the cloud on exactly the pages a cloud browser is for. So the page reader
learned a third verdict, `emptyShell`, modelled on what WebFetch already had (`looksLikeShell`,
`looksLikeTitleOnly`): a big document that reduced to almost nothing, or to its own title, or to
menus and a footer and nothing else.

**Escalation happens at most once per tool call.** Not a loop, not a ladder, not "try the other
vendor as well". One page can cost one extra session and no more. There is a per-turn ceiling on top
of that, in code, defaulting to two.

The engine choice and the site list live in `browser-engines.json` under the sand root, re-read on
every routing decision, so an operator can change it on a running box without a recreate.

## What it costs, in minutes AND gigabytes

This is the part that is easy to get wrong by an order of magnitude.

| | browser time | residential proxy |
|---|---|---|
| Browser Use Cloud | $0.02 / hour | $5 / GB, **on by default** |
| Browserbase | $0.10–0.12 / hour | $10–12 / GB |

A ten-minute session is **$0.0033** of browser time and can carry **$0.10** of proxy traffic —
thirty times more. A ledger that counted only minutes would report a session as very nearly free.

So every session is a row in `/home/box/sand-data/cloud-browser-ledger.jsonl`, mode 0600, one JSON
object per line, no secrets in any field:

```
{ tenant, agentId, vendor, sessionId, startedAt, endedAt, minutes, proxyBytes|null,
  engine, reason, url }
```

`proxyBytes` is **null**, never zero, where the vendor publishes no figure. Browserbase's session
object carries it; Browser Use documents no per-browser traffic number at all. A zero there would
read as "this session used no proxy", and the admin view says *not reported by this vendor* instead.

The row's own `tenant` field is whatever the box calls itself — a box does not know its
control-plane slug, because nothing pushes one in. The relay stamps the authoritative slug on what
it serves, because the relay is the thing that knows which box belongs to whom.

## The stop rule

**Closing the connection does not stop the browser.** Browser Use's docs say so plainly: only the
stop action ends it. A session nobody stopped is a browser billing by the hour with nothing driving
it. So:

- the ledger row goes down **before** the connect, so a session orphaned by a crash can be found;
- the stop runs in a `finally` on **every** exit path, including a thrown tool error;
- a sweep at host start reads each unfinished session's state **from the vendor** and stops what is
  still running. It reads first, every time — no cloud call in this wave is retried or stopped
  without first asking the vendor what state the thing is in;
- one session per tool call, and a per-turn ceiling, in code.

## What a person sees

Two things, and neither is a new panel.

**In the Computer card**, a strip that says where the browser runs — this computer or a cloud one —
and what the month has cost in sessions, minutes and gigabytes.

**Beside the hand-off card**, a "Take over in the cloud browser" row, drawn only while that same
agent actually has a live session open. It is beside the card, never inside it: `request_box_help`
takes instruction, reason, domain and idp_domain and nothing else, and its thumbnail comes off the
box's own seat chosen from `boxSeat`. HANDBACK-2 is the row where painting the wrong seat showed a
person another agent's wallpaper and they made a decision on it, so this wave adds no parameter to
that tool and never repoints that seat. The live URL is a fact about the *agent*, answered by its own
gateway command.

Two consequences, said out loud:

- every box desktop mount is same-origin `${origin}/vnc/<display>/` on purpose, which is what makes
  its canvas readable for a thumbnail. A vendor live view is third-party, so **no thumbnail can be
  read from one** — the console shows a frame or a link, never a picture;
- a vendor may refuse framing. Browserbase documents an iframe embed verbatim with
  `sandbox="allow-same-origin allow-scripts"`; Browser Use's `liveUrl` is a page. Either could start
  sending `frame-ancestors` tomorrow, so the link is drawn **always**, not as an error state, and a
  refused frame is never left as a blank rectangle.

Nothing a person reads names a vendor. "A cloud browser" is what it is called.

## Where the keys live

Browser Use already has a catalog row with an MCP connector, so its key already lands in
`servers["browser-use"].BROWSER_USE_API_KEY` through the existing `setConnectorSecret` path. Nothing
new.

Browserbase has no honest connector to hang a credential on — its MCP repo is archived, its MCP key
travels as a URL query parameter the door refuses, and `assertConnectorCredentialField` refuses any
field no `connectors.json` entry declares empty. We did **not** invent a connectors.json entry so
there would be somewhere to put the key: that ships a connector which can only ever fail, which is
the live CONNECT-13 defect. Browserbase is a **credential-only row** — a masked field, no connector,
no shell tool.

Its key goes in a **third top-level section** of `connector-env-secrets.json`:

```json
{ "servers":      { "<connector>": { "<ENV>": "<value>" } },
  "shell":        { "<ENV>": "<value>" },
  "cloudBrowser": { "BROWSERBASE_API_KEY": "…", "BROWSERBASE_PROJECT_ID": "…" } }
```

Same file, same 0600, same temp-file-plus-rename, and `writeSecretsDocument` preserves the sections
it is not writing.

**It is not in the `shell` section, and that is the whole point.** `shell-secrets.ts`'s own header
says what that section is for: values merged into the environment of the box exec-daemon, the
process that spawns every `/bin/sh` the agent's shell tool runs — and it states the residual out
loud, that the agent's shell can read its own environment. That is correct for a credential the
agent is *meant* to type (`cr review --api-key "$…"`). It is exactly wrong for a cloud browser key,
which no agent ever types and which buys whoever holds it a browser on somebody else's bill. The
`cloudBrowser` section is read only in the host process, by the two vendor adapters, and merged into
no child environment ever. There is a test that asserts precisely that against
`buildShellSecretEnvironmentUpdate`.

## The custody residual, stated rather than papered over

The request the host sends the driver has always been **base64 in argv**. That is fine for a display
number and a web address. It is not fine for a cloud endpoint: that URL carries the session's own
credential, and argv is readable from any process in the box — the agent's own shell included. That
is MARKET-17 / MARKET-24 verbatim.

The box exec path cannot pipe stdin (`buildHostShellArgs` carries a command string and nothing
else), so a request that carries an endpoint travels in a **file**: written 0600 by the host, in a
0700 directory, and unlinked by the driver in a `finally` the moment it has been read. The driver
also accepts `--request-stdin` for any caller that *can* pipe.

**The residual:** between the write and the unlink, an agent's shell — which runs as root in the same
container — could read that file. That window is one tool call long, and the session it names is
minted with a short vendor-side timeout so a leaked endpoint is dead in minutes. What it replaces
was permanent: a credential sitting in a root process's argument list for anything running `ps`.
Custody is only really fixed by an unprivileged agent shell, which is not this layer's job.

The gate greps **every** process's argument list in the box after a cloud run and fails on any vendor
host, key or session id, and checks that no request file was left behind.

## Vendor facts, read 2026-09-09

- **Browser Use** authenticates with `X-Browser-Use-API-Key`. Its own docs contradict themselves on
  the version: the quickstart writes the browser endpoints under `/api/v4`, while
  `docs.browser-use.com/cloud/api-reference` gives the base URL as `/api/v3` and every deep link
  into `/api-reference/browsers/*` redirects to that index. The adapter asks v4 first and falls back
  to v3 **on a 404 of the collection only** — a 404 there means nothing was created, so the second
  ask is not a retry of anything and cannot double-spend. Every other status is reported as it came
  back. The verification job carries this contradiction as a named fact, so the day the vendor
  settles it the row says so instead of this code working by luck.
- **Browser Use profiles** are minted by hand in the vendor dashboard. There is no documented API to
  create one, so the docs say that rather than promising something that does not exist.
- **Browserbase** authenticates with `X-BB-API-Key`. `POST /v1/sessions` answers with `id`,
  `status`, `connectUrl` and `proxyBytes`; `GET /v1/sessions/{id}/debug` gives
  `debuggerFullscreenUrl`; `POST /v1/sessions/{id}` with `status: "REQUEST_RELEASE"` is the stop.
  The proxy figure is read from the session **after** the browsing — the number on the create answer
  is zero, because nothing has browsed yet.
- **Saved logins** on Browserbase are contexts: `browserSettings.context = { id, persist: true }`.

BYOK is the shipping default for both engines. The ledger is built anyway, because it is the thing
that tells you what "included" would have cost before you offer it.

## How it is built, and what was deliberately not touched

The cloud engine is a branch **inside** `SandBrowserDriver.run()` — the only place a browser action
reaches a page. `assertBrowsableUrl`, the auto-review preflight, `recordNavigation` and the
one-image render all sit above it, so all four are inherited rather than re-earned, and the tool
specs and `turn-toolset.ts` are untouched.

And the cloud browser is driven by the **same driver**. `runtime/browser-driver/` gained a `wss://`
leg over `node:tls` and an attach-by-URL entry point; nothing else changed. Same page-text
extractor, same JPEG-at-1280 pipeline, same verdicts, same one marked result line. The result shape
is identical **by construction** rather than because two implementations were kept in step — and,
critically, `checkPublicWebUrl` still runs on the cloud path, so the name-resolving second guard that
refuses a public host landing on a private address is still there. A host-side re-implementation
would have dropped it silently. That is why we did not write one.

The tool predicate is **not** widened. `turn-toolset.ts` still reads
`!isSubagentRunner && remoteBoxHasDesktop && getRemoteBoxAvailable()`. The cloud is a routing choice
on a box that already has a desktop, not a way to hand browser tools to a box with none — which
keeps the gate's desktop-invariant leg meaningful. Offering the four tools on a desktopless box is a
later slice with its own row.

## Running the gate

```
SAND_PROFILE_DIRS=… node scripts/verify-browser-tools.mjs --dry-run     # no box, ~1 s
SAND_PROFILE_DIRS=… node scripts/verify-browser-tools.mjs               # the box's own browser
SAND_PROFILE_DIRS=… node scripts/verify-browser-tools.mjs --cloud-shape # the cloud path, no bill
node scripts/verify-browser-tools.mjs --cloud-live                      # METERED, one run per vendor
```

`--cloud-shape` points the router at the box's **own** Chrome debugger endpoint through
`SAND_CLOUD_BROWSER_LOOPBACK_CDP`, so the whole cloud path runs — the request file, the
attach-by-URL, the same page reader, the same ledger row — with no vendor dialled and nothing spent.
The router refuses anything in that setting that is not `ws://` on 127.0.0.1, so it cannot become a
way to point the browser somewhere else. The gate restores the setting and the policy file in a
`finally`, whatever happened.

Warm the browser before timing anything: measured on this Mac 2026-09-09, a cold open is 45,561 ms
(Chrome launch) against 1,317 ms warm, and one screenshot is a 14,764-byte JPEG 1280 wide.
