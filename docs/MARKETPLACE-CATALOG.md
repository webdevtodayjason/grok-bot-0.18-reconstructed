# The Marketplace catalog, row by row

What every plugin in `source/shared/marketplace/catalog.ts` is, how it is reached, which key it
needs and where that key is minted with the least permission that works, the first tool call that
proves it, what bites, and how we know it works.

`docs/MARKETPLACE.md` is the panel and the install flow. `docs/CONNECTORS.md` is the connector
plane and its custody rules. **This file is the catalog itself** — twenty-four rows, up from ten.

Five of them are the marketing rows Wave B added on 2026-09-09, and they carry a **second dated
block**: `docs[]`, the vendor facts each row depends on, re-read on a schedule by
`cp/verification.mjs`. "We ran it" and "the vendor still documents it" are two different claims
and they stay in two different places. See **Marketing** below.

---

## How to read the verification stamp

Every row carries one, and `validateMarketplaceCatalog` refuses a row without it.
`tests/connector-spec.test.mjs` and `tests/marketplace-catalog.test.mjs` are the enforcement, so an
unverified row cannot reach a card by anybody's good intentions.

| Stamp | What was actually done | What it does NOT prove |
| --- | --- | --- |
| `tools-listed` | The spec was spawned or called on a box and `tools/list` came back with tools. | For a keyed row, that the key is any good — most servers check the key on the first call, not at listing. |
| `endpoint-answered` | The endpoint answered and named its refusal (a 401 against a key we do not own). | That the tools are what we think. It proves the address, the transport and the auth scheme. |
| `vendor-installer` | There is no endpoint to call: the row installs a command-line tool, and its installer is the vendor's own documented one, re-read on the stamped date. | Anything about a running process. Refused outright on any row that installs a connector. |
| `documented` | **Refused by the validator.** Reading a vendor's docs is not evidence. | — |

**Everything below was measured on `grok-bot-local-vm` (this Mac, Docker) on 2026-09-08**, by
spawning or calling each row's spec exactly as the catalog materialises it and reading the reply.
`connectors.json` and `connector-env-secrets.json` were sha256'd before and after the whole run and
were byte-identical (`d936a3c6…` and `96f5ab7a…`): nothing was written to the box to measure this.

Numbers below are **warm** — the npx cache already held the package. Cold first-run times are
called out where they matter, because the host gives a connector 60 seconds to come up.

---

## The custody rule every row obeys

No row contains a credential, and no row can. A header value is a `${FIELD}` placeholder naming a
field of the 0600 store, never a literal; every credential env value is the empty string, which is
exactly how the host recognises a credential field; and a URL that carries its own key in the
userinfo or the query string is refused at the door, because a URL is written to `connectors.json`
in the clear where the store's protection does not reach.

A row declares a **spec** — a program, or an endpoint. It never declares a bridge, a bridge version
or a command line. `connectorEntryFromSpec` is the single function in the tree that knows how a
remote endpoint is actually reached today, so the day that changes, one function changes and no row
does.

---

## Development

### GitHub
Repositories, issues and pull requests, plus `gh` in the agent's shell so git inside the box has a
credential to push with. One token, two destinations — which is the whole of MARKET-5 in one row.

- **Transport** — endpoint, `https://api.githubcopilot.com/mcp/`
- **Also installs** — the `github-cli` shell tool
- **Credential** — `GITHUB_PERSONAL_ACCESS_TOKEN`, a fine-grained PAT from
  github.com/settings/personal-access-tokens/new. Least that works: Contents: read, Issues: read,
  Pull requests: read (Metadata: read comes along automatically). Contents: **write** only if you
  want the box to push. One stored value reaches the connector as
  `GITHUB_PERSONAL_ACCESS_TOKEN`, the endpoint as an `Authorization` bearer, and the shell as
  `GITHUB_TOKEN` — the two env names differ, which is precisely what the old one-hint-per-env-name
  shape could not express without asking for the same string twice.
- **First call that proves it** — `get_me`, which needs no repository at all.
- **What bites** — the entry pins `X-MCP-Readonly: true` and a toolset filter. Those are
  configuration headers, not secrets, and the validator allows a literal there while refusing
  anything key-shaped. A malformed token gets a **400**, not a 401: the server parses the header
  before it authenticates.
- **Verified** — `endpoint-answered`. A well-formed but invented token got HTTP 401
  `unauthorized: AuthenticateToken authentication failed` in 0.4 s.

### Context7
Current documentation for any library, so the agent writes against what a package does today rather
than what it did when the model was trained. **No key at all.**

- **Transport** — endpoint, `https://mcp.context7.com/mcp`
- **Credential** — none.
- **First call** — `resolve-library-id` with a library name, then `query-docs`.
- **Verified** — `tools-listed`. 2 tools in 0.6 s, anonymously.

### DeepWiki
Ask questions about a public GitHub repository with the structure already indexed — useful when
somebody hands you a dependency and you need to know what it does before you trust it. **No key.**

- **Transport** — endpoint, `https://mcp.deepwiki.com/mcp`
- **Credential** — none.
- **First call** — ask a question about a well-known public repository.
- **What bites** — the vendor also publishes an `/sse` path; it answers **410** and is not what the
  row uses.
- **Verified** — `tools-listed`. 3 tools in 1.5 s (0.6 s warm), anonymously.

### Cloudflare docs
Searches Cloudflare's own documentation. No account, no zone, no API token — which is why it is the
row used to prove the remote path on a live customer box without anybody minting anything.

- **Transport** — endpoint, `https://docs.mcp.cloudflare.com/mcp`
- **Credential** — none.
- **First call** — `search_cloudflare_documentation`.
- **What bites** — Cloudflare's *other* servers (bindings, observability) are **OAuth-only**. A
  bearer against `bindings.mcp.cloudflare.com` answers 401 *"Access token appears malformed"*
  because it wants an OAuth-issued token, not an API token. Only the docs server is keyless, and
  only the docs server is in the catalog.
- **Verified** — `tools-listed`. 2 tools in 0.2 s, anonymously.

### Add your own
Not a vendor: the card that opens the editor. Two shapes — a **link** (an address, and a key if it
needs one) or a **program** (a command the box runs). Covered by `docs/CONNECTORS.md`.

---

## Communication

### Slack
Channels, threads and search, acting as the installing user so search actually works. Posting stays
off — that is the server's own default, not a header the entry sets. Not the Slack chat listener.

- **Transport** — program, `npx -y slack-mcp-server@1.3.0 --transport stdio`
- **Credential** — `SLACK_MCP_XOXP_TOKEN`, a **user** OAuth token (`xoxp-`). Create the app at
  api.slack.com/apps, add User Token Scopes, Install to Workspace, copy the User OAuth Token.
  `channels:read` alone lists public channels; reading and search also want `channels:history`,
  `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`,
  `users:read`, `search:read`.
- **First call** — list channels.
- **What bites** — this server **checks the token at startup** and exits 1 if it is bad, which is
  unusual and is why its stamp is `endpoint-answered` rather than `tools-listed`. A bot token
  (`xoxb-`) will not do: search is a user-token API.
- **Verified** — `endpoint-answered`. An invented `xoxp-` token produced a named refusal,
  *"Authentication failed - check your Slack tokens"*, `invalid_auth` — the program downloaded and
  ran; it did not crash and npm did not 404.

---

## Project management

### Linear
Issues, projects and cycles.

- **Transport** — endpoint, `https://mcp.linear.app/mcp`
- **Credential** — `LINEAR_API_KEY`, a personal API key from
  linear.app/settings/account/security. **Read** is the only permission the read tools need, and
  Linear's own guidance recommends a read-only key.
- **First call** — list your teams.
- **What bites** — with no key the bridge falls through to a **browser sign-in**, and the box has
  no browser a person can finish one in. That is why the key is not optional here.
- **Verified** — `endpoint-answered`. An invented bearer got HTTP 401 `invalid_token` in 0.5 s.

### Todoist
Tasks and projects.

- **Transport** — program, `npx -y @doist/todoist-mcp@13.2.3`
- **Credential** — `TODOIST_API_KEY`, from Todoist under Settings → Integrations → Developer.
- **First call** — list projects.
- **What bites** — the token is **account-wide and cannot be narrowed**. Add this on an account
  whose whole task list you are willing to expose. Cold first run took **24.9 s** on an empty npx
  cache (2.1 s warm) — inside the 60 s connect timeout, but not by a lot.
- **Verified** — `tools-listed`. 47 tools.

---

## Business

### Stripe
Customers, invoices and payments — who paid, what is outstanding, send this invoice.

- **Transport** — endpoint, `https://mcp.stripe.com`
- **Credential** — `STRIPE_API_KEY`, a **restricted** key (`rk_…`) from Developers → API keys →
  Create restricted key. Not your secret key. Read on Customers, Invoices and Charges and nothing
  else; add write only for the objects you want the agent to create.
- **First call** — list customers.
- **What bites** — Stripe also supports an OAuth flow, which this box cannot complete; the
  restricted-key bearer is the headless path and the row uses it deliberately.
- **Verified** — `endpoint-answered`. An invented restricted key got HTTP 401
  `Unauthorized. See https://docs.stripe.com/mcp for usage instructions.` in 0.6 s.

### Resend
Sends email from a domain you have verified, rather than from a mailbox the agent logs into.

- **Transport** — endpoint, `https://mcp.resend.com/mcp`
- **Credential** — `RESEND_API_KEY` from resend.com/api-keys. Choose **Sending access**, not Full
  access, and restrict it to the one verified domain — a Full access key can also read and delete
  your domains.
- **First call** — send a test message to yourself.
- **What bites** — the endpoint **lists tools without checking the key**: an invented bearer still
  returned 103 tools. So a green health line here means the address and the transport are right, and
  says nothing about whether the key works. The first send is the real test.
- **Verified** — `tools-listed`, with that caveat recorded in the stamp itself. 103 tools in 0.3 s.

### Airtable
Bases, tables and records — the spreadsheet-shaped database a lot of small businesses run on.

- **Transport** — program, `npx -y airtable-mcp-server@1.14.0`
- **Credential** — `AIRTABLE_API_KEY`, a personal access token (`pat…`) from
  airtable.com/create/tokens, **scoped to the bases you want reachable**. `schema.bases:read` and
  `data.records:read` are enough to read; add `data.records:write` only to let the agent change
  records.
- **First call** — list bases.
- **What bites** — the token is checked on the first call, not at startup, so a bad token still
  produces a healthy-looking connector.
- **Verified** — `tools-listed`. 16 tools in 2.4 s.

---

## Documents & Files

### Notion
Pages and databases.

- **Transport** — program, `npx -y @notionhq/notion-mcp-server@2.5.1`
- **Credential** — `NOTION_TOKEN`, an internal integration token (`ntn_…`) from
  notion.so/profile/integrations. **The permission model is what you share**: create the
  integration, then open each page or database and use ••• → Connections → your integration.
  Nothing you do not connect is visible, so connect the smallest set that works.
- **First call** — search for a page you connected.
- **What bites** — **cold start took 36.2 s** on an empty npx cache (3.4 s warm). That is the
  closest row in the catalog to the 60 s connect timeout, and on a fresh box the first Add is the
  slow one. A second attempt is instant.
- **Verified** — `tools-listed`. 24 tools.

### Google Workspace
Gmail and Docs through one process.

- **Transport** — program, `npx -y google-workspace-mcp-server@1.4.3`
- **Credential** — three fields, not one: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REFRESH_TOKEN`. Create an OAuth **Web application** client in Google Cloud with
  `https://developers.google.com/oauthplayground` as an authorized redirect URI, on a project with
  the Gmail, Docs and Drive APIs enabled; then mint the refresh token in the OAuth 2.0 Playground
  (gear → Use your own OAuth credentials → Authorize APIs → Exchange authorization code for
  tokens). Authorize `gmail.readonly` for reads, `gmail.compose` for drafts, `documents` for Docs,
  and `drive.file` plus `drive.readonly` for the Docs file IDs.
- **First call** — list recent Gmail threads.
- **What bites** — consent happens **once, in a browser you own**, and the refresh token is what
  the box holds; nothing afterwards needs a browser inside the box. Take the refresh token, not the
  access token.
- **Verified** — `tools-listed`. 34 tools in 2.5 s with invented credentials — it defers Google's
  own auth to the first call.

### Filesystem
Read and write files under `/workspace` inside the box.

- **Transport** — program, `npx -y @modelcontextprotocol/server-filesystem@2026.8.31 /workspace`
- **Credential** — none. The box's own filesystem is the whole permission model.
- **First call** — list `/workspace`.
- **What bites** — this package ships a **rolling date version**. It was unpinned before MARKET-6,
  which meant a different program every few weeks; it is now pinned to the dated release that
  resolved on 2026-09-08.
- **Verified** — `tools-listed`. 14 tools in 1.9 s.

---

## Web & Search

### TinyFish
Web search, page fetch and browser automation — one product, one place to put a key. The stored
value feeds both the connector and the CLI in the agent's shell.

- **Transport** — endpoint, `https://agent.tinyfish.ai/mcp`
- **Also installs** — the `tinyfish-cli` shell tool
- **Credential** — `TINYFISH_API_KEY` from the dashboard at agent.tinyfish.ai. Account-wide; no
  separate scopes. **If web search and page fetch are included with your plan you need no key here
  at all** — the box is given one of its own and the card stays empty (PROXY-7).
- **First call** — a search.
- **What bites** — the key is carried as an `Authorization` **bearer**. `X-API-Key` is the
  REST-side name and this endpoint refuses it. Before MARKET-6 this was two cards for one product,
  each warning that the other's value did not reach it; that is the complaint MARKET-5 names, and
  folding the CLI row in is the fix.
- **Verified** — `endpoint-answered`. An invented bearer got HTTP 401
  `Unauthorized: Valid OAuth Bearer token required` in 0.6 s.

### Exa
Search that returns the contents of the pages, not a list of links to fetch separately. **No key**
on the public endpoint.

- **Transport** — endpoint, `https://mcp.exa.ai/mcp`
- **Credential** — none for the public endpoint. (Exa's keyed REST API uses `x-api-key`, not a
  bearer — worth knowing, and not what this row uses.)
- **First call** — a search.
- **Verified** — `tools-listed`. 2 tools in 0.4 s, anonymously.

### Playwright browser
A real Chromium the agent opens pages in, for sites with no API. Headless and isolated, so each
session starts clean and nothing is saved.

- **Transport** — program, `npx -y @playwright/mcp@0.0.80 --headless --isolated`
- **Credential** — none. The browser is the permission model.
- **First call** — navigate to a page and take a snapshot.
- **What bites** — listing tools does **not** download a browser; the first page it opens does, and
  that download is slower than the first connect. A connector that comes up healthy in 1.6 s can
  still take a while on its first real call.
- **Verified** — `tools-listed`. 24 tools in 1.6 s.

### Browser Use
Hands a browsing job described in words to a hosted agent, so the box does not run a browser
itself. The alternative to Playwright when the job is a goal rather than a script.

- **Transport** — endpoint, `https://api.browser-use.com/mcp`
- **Credential** — `BROWSER_USE_API_KEY`, carried in the **`X-Browser-Use-API-Key`** header, not an
  Authorization bearer. From cloud.browser-use.com under Billing → API keys.
- **First call** — start a small task and read the result.
- **What bites** — the key is account-wide and **spends your balance on every run**; put it on an
  account with a cap you are comfortable with. Like Resend, the endpoint lists tools without
  checking the key.
- **Verified** — `tools-listed`. 6 tools in 0.3 s with an invented key.

---

## Marketing

Read against each vendor's own documentation on **2026-09-09**, and every endpoint below was called
from inside `grok-bot-local-vm` on the same day with an invented token, so the verification stamps
are measurements rather than readings.

**The one thing to know before reading any of these rows.** *No official MCP server publishes an
organic post anywhere.* Meta's Social Technologies MCP manages apps and webhooks. Meta's Ads MCP
manages ads. X's hosted MCP reads posts and writes only bookmarks and Articles. So on Meta, X and
LinkedIn **the connector and the posting path are different things**, and these rows say so instead
of shipping a card that looks like it posts. Posting today is the customer's own developer app, or
Buffer, or the browser.

Three of these rows install nothing, and that is deliberate. A row whose only honest content is
"here is what this vendor requires of you first" is a page, not an entry. `installsNothing` is how
the console knows to draw the steps and no Add button, and `validateMarketplaceCatalog` makes such a
row carry first steps and at least one dated source — so a row that installs nothing cannot also say
nothing. None of the three carries a masked key box either: there is nowhere for a Meta token to go
today, and a box for a value nothing reads is the same lie one level up as a connector that can only
ever fail (which is the live `CONNECT-13` defect).

### How to read the second dated block

These four rows carry `docs[]` as well as `verification`, and the two must not be confused.

| Block | The claim | Who writes it |
| --- | --- | --- |
| `verification` | We ran this against the vendor on that date, from a box. | A person, when the row is added or re-run. |
| `docs[]` | The vendor still documents what this row assumes, on that date. | `cp/verification.mjs`, weekly and on release. |

They stay apart because re-reading a web page produces only doc-grade evidence, which is exactly the
`proof: "documented"` the validator has always refused. A doc result can never raise a row's proof —
`tests/marketplace-verification.test.mjs` asserts it — and the recurring job is described in
`docs/CONNECTORS.md`.

`recheckDays` is what the customer's page runs on. Nothing pushes control-plane state into a running
box, so between releases the console goes by **age**: it draws "Checked 9 Sep 2026" until the row's
own dates are older than `recheckDays`, and "Under review — hold off installing" after that. It
never blocks Install; it says so before the person commits.

### Meta: Facebook Pages and Instagram

Installs nothing. Graph API **v26.0**.

- **Transport** — none. Your own developer app against `graph.facebook.com`.
- **Credential** — none on this row. There is nowhere for a Meta token to go today.
- **What bites, in order of how much time it costs you.**
  1. **Two logins, two different permission sets.** Instagram Login wants
     `instagram_business_basic` and `instagram_business_content_publish`. Facebook Login wants
     `instagram_basic`, `instagram_content_publish` and `pages_read_engagement`. Picking one decides
     every permission name after it, and they are not interchangeable.
  2. **Standard Access is free and nearly useless for an agency.** It posts only to accounts whose
     staff hold a role on your app — your own accounts. The moment you post for a client who does
     not, you need **Advanced Access**: Business Verification, App Review *per permission*, and an
     **annual Data Use Checkup** that keeps the access alive. Weeks, not an afternoon.
  3. **Do not copy `pages_manage_read_engagement`** from Meta's Pages getting-started page. The
     Permissions Reference does not contain it (checked 2026-09-09). `pages_manage_posts` is the one
     that creates a Page post, and it depends on `pages_read_engagement` and `pages_show_list`.
  4. **The publishing limit is documented twice, differently.** The Rate Limit section says 100
     API-published posts in a 24-hour moving period; the carousel section on the same page says 50.
     Plan against 50, and read the account's own `/content_publishing_limit` before a batch. It is on
     the row as `knownContradiction`, so the console says it too.
- **Verified** — `endpoint-answered`. `GET /v26.0/me` with an invented token: HTTP 400
  `OAuthException` code 190, "Invalid OAuth access token", in 0.20 s.

### X

Installs nothing. No tiers, no application, no app review — and a per-post price.

- **Transport** — none. Your own developer app against `api.x.com/2`.
- **Credential** — none on this row.
- **What bites.**
  - **Pay-per-usage, and the link surcharge is thirteenfold.** `Post: Create` is **$0.015** a
    request; `Post: Create (with URL)` is **$0.200**. A marketing habit is mostly the second one.
    Set a spending limit on the app before anyone uses it, and keep X posting off until somebody has
    agreed a per-post ceiling for the client.
  - **The hosted MCP cannot create an ordinary post**, and `POST /2/tweets` refuses an app-only
    bearer outright — measured, see below. It needs OAuth 2.0 user context with `tweet.write`,
    `tweet.read`, `users.read` and `offline.access`, which means a local stdio bridge rather than a
    remote connector row.
  - Quote-posting through `quote_tweet_id` is Enterprise-only on the same page that documents the
    parameter. On the row as `knownContradiction`.
- **Verified** — `endpoint-answered`. `POST /2/tweets` with an invented bearer: HTTP 403
  "Unsupported Authentication … Supported authentication types are [OAuth 1.0a User Context, OAuth
  2.0 User Context]", in 0.19 s. That refusal *is* the row's own point, measured.

### LinkedIn

Installs nothing. The slowest of the three to get into, and the one most likely to stop working
quietly.

- **Transport** — none. Your own approved app against `api.linkedin.com/rest`.
- **Credential** — none on this row.
- **What bites.**
  - **The Page has to exist before the app can.** An app is attached to a Page and verified by that
    Page's admin, so this needs somebody at the client, not just you.
  - **Community Management access is an application with a review.** Every app starts in the
    **Development tier** meanwhile: 500 calls per app per day, 100 per member per day. Enough to
    build against, not enough to run twenty clients on.
  - **Tokens expire every 60 days and refresh tokens are reserved for approved partners.** For most
    apps, renewal is re-authorising by hand. Put a reminder in the calendar for day fifty-five.
  - `w_organization_social` posts as the organisation, `r_organization_social` reads it back, and the
    authenticated person needs an admin role on the Page whatever the app was granted.
  - **LinkedIn publishes no rate limits**, by its own statement. That fact is recorded on the row as
    a terminal `not-published` state so the weekly re-read does not report LinkedIn's policy as news
    every seven days.
  - Every LinkedIn Marketing page still renders a deprecation banner for a sunset date **three weeks
    in the past** (Marketing Version 202508, 17 August 2026, read 2026-09-09). It is boilerplate; the
    verification job strips it before comparing anything.
- **Verified** — `endpoint-answered`. `GET /rest/posts` with an invented bearer and
  `Linkedin-Version: 202608`: HTTP 401 `INVALID_ACCESS_TOKEN`, in 0.36 s.

### Buffer

**The only scheduler with a day-one path**, and the row that actually posts.

- **Transport** — endpoint, `https://mcp.buffer.com/mcp`, `Authorization: Bearer`.
- **Credential** — `BUFFER_API_KEY`, minted by you in Buffer under **Settings → API**. No
  application, no review.
- **First call** — `list_channels`, then `create_post`.
- **What bites.**
  - **The key is account-wide.** There is no per-organisation scoping, so a key made on an agency
    account reaches every client channel on that account. That sentence is on the masked field, not
    only here.
  - **`schedulingType: "notification"` is a first-class path, and it is the one that matters.** It
    schedules a post as a *reminder to a person* instead of publishing it, which maps straight onto
    the hand-off card — so a network we cannot post to for this client yet still gets scheduled work.
  - `create_post` reaches Instagram, Facebook, Twitter, LinkedIn, Pinterest, YouTube, Google
    Business, Mastodon, TikTok, Threads, Bluesky and Buffer's own Start Page.
  - **Free plan: 100 requests per 15 minutes, 250 a day, 3,000 a month**, per client, shared across
    every request rather than counted per tool. A conversation that lists posts, reads a few and
    edits one has already spent several.
- **Verified** — `endpoint-answered`. MCP `initialize` with an invented bearer: HTTP 401
  `{"error":"Unauthorized: Invalid or expired token"}` in 0.33 s.

### Browserbase (Web & Search)

Installs nothing, and carries a key the **host** reads. `CLOUD-BROWSER-1`'s second engine: the same
four browsing tools, pointed at a browser running in Browserbase instead of the one in the box.

- **Transport** — none, and no connector. Its own MCP repo is archived and its MCP key is a URL
  query parameter, which the custody rule refuses at the door.
- **Credential** — `BROWSERBASE_API_KEY`, with the new **`cloud-browser`** consumer. It is read only
  in the host process, out of the `cloudBrowser` section of `connector-env-secrets.json`, and merged
  into no child environment ever. Deliberately **not** a `shell` consumer: shell-secrets values are
  merged into the environment of the box exec daemon — the process that spawns every `/bin/sh` the
  agent's shell tool runs — and an agent can read its own environment.
- **What bites** — without the paid plan this is a cloud Chrome with **no residential proxy** and
  **15-minute sessions**, which is not the thing that gets past a sign-up page. `proxies` defaults
  to false and the built-in ones are the paid, residential ones.
- **Verified** — `endpoint-answered`. `POST /v1/sessions` with an invented key in `X-BB-API-Key`:
  HTTP 401 in 0.33 s. **No session was started, so nothing was billed.**

### What we deliberately did not ship this release

| Candidate | Why not | What would change it |
| --- | --- | --- |
| **Later** | `later.com/api` 404s today. There is no public API to write a row against. | A public API. Not expected. |
| **Canva** | No day-one path below Enterprise: the Connect APIs need a public integration to be reviewed by Canva before anybody but your own team can use it. | An Enterprise account, or a self-serve tier. Filed as roadmap. |
| **A per-tenant OAuth callback for Meta, X and LinkedIn** | Out of scope for this release, which is why all three rows say "bring your own app" in plain words. | The callback, which is its own row. |

---

## Code review

### CodeRabbit CLI
There is no CodeRabbit MCP server — the official product is an MCP *client*, and the community
servers are unmaintained or read GitHub comments rather than run reviews. The integration is the
official CLI.

- **Transport** — none. A shell tool, run as `cr review --agent`.
- **Credential** — `CODERABBIT_API_KEY`, an **Agentic** API key from
  app.coderabbit.ai/settings/api-keys (app.eu.coderabbit.ai for EU accounts), stored for the
  agent's shell.
- **What bites** — User and workspace keys are a different product and the CLI refuses them. The
  key is org-bound and that org is billed for CLI reviews.
- **Verified** — `vendor-installer`. There is no endpoint to call; the install command is
  CodeRabbit's own documented one, re-read on 2026-09-08, and the gate never runs it because it is
  a curl-to-shell on a shared box.

---

## What we could not ship yet, and why

Each of these was actually tried on `grok-bot-local-vm` on 2026-09-08. None of them reaches a card,
because a row that cannot be verified does not get one.

| Candidate | What happened | What would change it |
| --- | --- | --- |
| **Postgres** (`uvx postgres-mcp==0.3.0`) | Does not start. `uv` resolves it fine — 67 packages installed in 137 ms — and then it dies on import: `from mcp.server.fastmcp import FastMCP` inside `postgres_mcp/server.py` raises against the `mcp` Python SDK it resolves today. Not a credential problem; the program is broken on this box. | A postgres-mcp release that pins a working `mcp` SDK, or a pinned SDK alongside it. Worth retrying — a database row is the one obvious gap in the Business category. |
| **Cloudflare API** (bindings, observability) | `api.mcp.cloudflare.com` does not resolve. `bindings.mcp.cloudflare.com` answers **401 "Access token appears malformed; reauthenticate"** — it wants an OAuth-issued access token, not an API token. | Cloudflare offering an API-token bearer, or a headless OAuth path. Only the keyless **docs** server shipped. |
| **Zapier** | 401 `Invalid authorization token` against `mcp.zapier.com/api/mcp/mcp` — the endpoint is live and takes a bearer. Zapier's documented per-user URL, however, carries the key **in the path**, which the custody rule refuses: the URL is written to `connectors.json` in the clear. | Confirmation from Zapier that the generic endpoint plus a bearer is supported, and a decision from Jason (it was already pending). |
| **HubSpot (hosted)** | OAuth-only, no device-code grant. | A headless auth path. |
| **Notion (hosted)**, **Sentry**, **Semgrep** | 401 `invalid_token` — live endpoints, all OAuth-issued tokens. Notion ships as a **local program** instead, which is the row that shipped. | — |
| **Asana, Trello, HubSpot** | OAuth-only, no device grant, no headless path. | — |
| **Browserbase** (as a connector) | Its MCP key is a **URL query parameter**, so the link itself is the credential — refused by the custody rule at the door. Its MCP repo is also archived. **It ships anyway, as a credential-only row**: the cloud-browser engine reads its key in the host process, which needs no connector at all. See Marketing above. | A header-based MCP auth scheme, if a connector is ever wanted. |
| **PayPal, Shopify** | 404 at the URLs tried. Not chased further. | Correct endpoints. |
| **Hugging Face** | Works keyless (4 tools in 0.2 s) but is not a small-business tool; left out to keep the catalog from bloating rather than because it failed. | A reason an owner would want it. |

**OAuth-protected remote servers are a named non-goal.** Not one hosted candidate advertises a
`device_authorization_endpoint`, so there is no headless flow to drive. What a bridge does instead
is open a browser on the box desktop and wait — one such process on this box had been waiting
**9 h 51 m**. The Add-your-own card refuses an OAuth-only server at the door with one sentence
naming the desktop step, rather than letting it hang.

---

## The three constraints a new row has to clear

1. **It runs.** Spawn or call it on a box, read the reply, and write what came back into
   `verification.how`. Keyless rows must list real tools; keyed rows must give a nameable refusal
   such as a 401 — never a crash, never an npm 404.
2. **Its tagline answers no pinned search.** `linear`, `pull requests`, `code review` and
   `kubernetes` are pinned with `deepEqual` by the plugin-tool suite, and a fourteenth tagline
   carrying one of them changes what `SearchPlugins` answers for a query nobody re-ran. The
   validator refuses it by name. The words owners actually type — "crm", "invoice", "database" —
   go in `keywords`, which those searches do not read and the console's search does.
3. **Its package is pinned.** One rule, both package managers: `npx -y name@version`,
   `uvx name==version`. A bare package argument is a different program every morning; before
   MARKET-6 `mcp-remote` was pinned at 0.8.3 twice and bare twice, and the filesystem server was
   unpinned against a rolling date-versioned release.

A new logo is a fourth: **letter tiles are the default**, and a vendor mark ships only when that
vendor's own brand terms have been read and the permission quoted in
`ui/machine-room/marketplace/logos/NOTICE.md`. CC0 on an SVG path is not a trademark licence. None
of the eleven new rows ships a mark.
