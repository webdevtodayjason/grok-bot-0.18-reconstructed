# Connectors: the operator index

Six services, in the order the operator asked for them: GitHub and Slack first, then Linear,
CodeRabbit and Google, with TinyFish already landed in the middle as the reference. Each section
below is the whole walk-through for one service — which preset fills the form, which credential to
mint and with what permissions, the first tool call and the answer that means it worked, and the
two or three things that bite. Every fact here comes from that service's report in
`docs/connectors/` (TinyFish's is `docs/CONNECTORS-TINYFISH.md`); the reports carry the sources,
the version pins and the reasoning, and nothing is claimed here that is not in one of them.

A last section covers the **GitHub CLI (gh)**, which is not one of the six and not a connector at
all: it is the shell tool that gives `git` inside the box a credential, so an agent that commits can
also push.

## How it works

A connector is one entry in `/home/box/sand-data/connectors.json`, and that file is the whole
configuration surface: a name, a `command`, its `args`, and an `env` map. The box runs the process
as user `box` and the host discovers its tools. This build runs local stdio servers only, so a
service whose MCP endpoint is remote is bridged by a local `mcp-remote` process carrying the token
in an `Authorization` header; `mcp-remote` expands `${NAME}` inside a `--header` value from its own
environment, so the literal `${...}` text is what lands in the file and the key does not.

**No credential ever goes in that file.** An env key whose value in the entry is the **empty
string** is a credential field: the connector's card draws one masked "Enter securely" input per
such key, `setConnectorSecret` writes the value into `/home/box/sand-data/connector-env-secrets.json`
(0600, host-owned), and the host merges it into the connector process's environment when it spawns
it. An env key that carries a value is configuration and is never offered as a place to paste
anything — that rule exists because the TinyFish OAuth entry declared a directory path, the card
offered it, and a pasted API key went into it (CONNECT-4). The host is the authority on that
distinction: `listConnectorSecretFields` answers `fields` (the union of what is stored and what the
entry leaves empty) and `stored` (the names the 0600 store actually holds), and the card may only
say the host holds a value from the second list. That same 0600 file carries a second top-level
`shell` section for command-line tools that have no `connectors.json` entry to hang an empty env key
on, whose values are merged into the environment of the box shell the agent runs commands in rather
than into any connector process, and those tools sit under **Shell tools** in the same panel.

**Where this is in the UI now.** The panel is the **Marketplace** (it was called Global
capabilities), and its Plugins tab is the catalog these six services are in: one card each, an
**Add** button that writes the entry below, and a plugin page carrying the credential card and the
connector's status. [MARKETPLACE.md](MARKETPLACE.md) is that surface end to end — what the two tabs
are, what Add and Import do, where the providers went, the catalog schema, and how to add a plugin
or a bot. This file stays the per-service walk-through: what to mint, with which permissions, and
what bites.

The operator's route is **Marketplace** → **Plugins** → **Add** on the service's card, which writes
that entry and opens its plugin page. Anything with no card goes through the connector editor, which
is the **Custom MCP server** card and the **Add or remove a connector** box at the bottom of the same
Plugins list. The preset row at the top of that card is a row of buttons, one per service; clicking
one **fills the four fields and writes nothing**. Pressing **Add connector** writes
`connectors.json` through the relay and calls `refreshMcp`, so the host relaunches its stdio servers
with no container restart. The connector's card then appears with its **Credentials for
&lt;name&gt;** form; paste the key, press **Store on the host**, and the card polls until the box
reports the server connected and lists its tools. Until the key is stored the connector cannot
authenticate, so it sits at initializing or error and says so. The tables below give exactly what
each preset fills, so the form can be read before it is written — and typed by hand if a preset is
missing.

An agent can install the same entry itself with **AddMcpServer** after confirming with the user,
the way `source/host/extensions/managed-setup/seed-skills/add-connector/SKILL.md` describes for a
server the catalog does not know. What an agent **cannot** do is hold the key: `setConnectorSecret`
is a console command and not an agent tool, deliberately, because a key typed into a conversation
is in the transcript, the model's context and whatever window that was compacted into. It can
**ask** for one, through the masked card in the next section, and that path keeps the same rule:
the value goes from the input to the store and is never in the conversation. So the split is always
the same. The agent installs the connector and may ask for its key, the operator is the only one
who ever sees the value, and a tool call made before the key is stored answers with an error naming
that card rather than a bare transport failure. (Note what `AddMcpServer` accepts on this bundle: `name`, `url`, `headers`. The
local `command`/`args`/`env` form the skill describes is the piece CONNECT-3 adds.)

Removing a connector: **Remove this connector** on its card, or its row in the editor, drops it from
`connectors.json` and re-reads the file. The stored secret is separate — `deleteConnectorSecret`
takes it out of the store and the field stays on the card as an empty one to fill again.

## Ask for a secret inline

An agent does not have to send the operator to a panel. It can raise a masked card in the
conversation itself: `SendMessage` with `type: "secret-request"` and

```json
{ "label": "Titan Job Bus token",
  "description": "Temporary Titan Job Bus bearer token for the CoS dry-run. Never share in chat.",
  "connector": "shell",
  "field": "TITAN_JOB_TOKEN" }
```

The console draws that as a card with the label as its title, the description under it, a masked
password field, and a **Save securely** button. On a successful save the card collapses to **Saved
securely and kept private.** with a green ✓ Saved pill. The value goes from the input straight to
`submitSecret` and into its store: it is never written into the page's markup and never into the
transcript.

**The hint under the field is not the same line for every destination**, because the custody is not
the same. A connector or chat credential lands in somebody else's process, so that card is hinted
**Stored securely, never shown to your agent.** A `shell` request like the one above lands in the
environment of the shell the agent runs its commands in, where `echo $TITAN_JOB_TOKEN` returns it,
so that card is hinted **Stored securely and never shown in this chat. It becomes
$TITAN_JOB_TOKEN in this agent's shell, so commands it runs can read it.** The agent's own
acknowledgement splits the same way: every other route tells the model it never sees the value, and
the shell route tells it the value is reachable only as that variable. Neither the card nor the ack
promises a custody the `shell` route does not keep.

**Where each `connector` name lands.** One namespace, three destinations, and the host picks in
this order (`widget-responses.ts` `routeSecret`):

| `connector` | Destination |
| --- | --- |
| `shell` (reserved) | **The agent's own box shell environment.** `field` is the environment variable name, so `TITAN_JOB_TOKEN` becomes `$TITAN_JOB_TOKEN` in every command that agent runs from then on. Same 0600 store and same push as the console's Shell tools card. |
| `slack`, `github` | The chat-channel credential store for that platform. These two win the name race against a local connector of the same name, deliberately: a GitHub channel token that landed in an MCP server's env would leave the channel silently unconnected. |
| any other name | That local stdio connector's process environment, and the connector is restarted so it picks the value up. The name must be a connector this box actually has; if it is not one, the value falls through to the per-agent channel store. |

**The `shell` field rule.** Because the value becomes part of the shell the agent runs commands in,
the variable name must be **UPPERCASE** (`A-Z`, `0-9`, `_`), and three families are refused:
process control (`PATH`, `NODE_OPTIONS`, `LD_*`, anything `*_PRELOAD`), the shell's own identity
(`HOME`, `PWD`, `USER`, `SHELL`, `TERM`, `TMPDIR`), and the host's own `SAND_*` switches. A refused
name is caught at the tool boundary, so the card is never drawn; if one gets through anyway, nothing
is stored anywhere and the agent is told the request went unanswered. The rule lives in
`source/host/extensions/shell-tools/shell-secret-field.ts` and is the same one the console's
`setShellSecret` enforces.

**The box has more than one shell, and the value goes to all of them.** An agent with its own
desktop window runs every command through that window's exec daemon, and each daemon holds its own
environment: a push that only reached the box's primary daemon left the agent's `printenv` reading
nothing while the console reported the key applied (ENV-1). So `setShellSecret`, `deleteShellSecret`
and the card's own route push the update to the primary daemon **and to every open window**, and
answer `applied: true` only when all of them took it; a window that did not is named in
`pendingWindows`, and the ack the model reads says so rather than promising a shell that has
nothing. A window opened later is given the stored credentials before it is handed back, so a
desktop started after a key was stored never runs a command without it.

The gate is `scripts/verify-connector-plane.mjs --shell-secrets`, legs (m) and (m2): a probe agent
is asked to raise the card, the value is submitted through `submitSecret` the way the console does,
and **both** shells are then asked whether they have the variable -- the primary daemon, and the
asking agent's own window through `probeShellSecret {field, agentId}`, which answers with the
`shell` and `windowIndex` it asked. The store's sha256 is compared against what was submitted, so
the legs prove the same value arrived without printing it, and the value is held out of the host
log as well as out of the transcript.

## GitHub

**Preset.** Click **GitHub (PAT, read-only)**. It fills:

| field | filled with |
| --- | --- |
| Name | `github` |
| Command | `npx` |
| Arguments | `-y mcp-remote@0.8.3 https://api.githubcopilot.com/mcp/ --transport http-only --header "Authorization:Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" --header X-MCP-Toolsets:repos,issues,pull_requests --header X-MCP-Tools:get_me --header X-MCP-Readonly:true` |
| Environment variable names | `GITHUB_PERSONAL_ACCESS_TOKEN` |

This is GitHub's own hosted server at `api.githubcopilot.com/mcp/`, bridged into stdio. The three
`X-MCP-*` headers are what make it read-only: toolsets `repos,issues,pull_requests`, plus `get_me`
by name, with `X-MCP-Readonly:true` filtering every write tool. The header argument is quoted
because it holds a space; unquoted, the argument field splits on whitespace and the header is lost.

**The credential.** A GitHub **fine-grained personal access token**, created at
<https://github.com/settings/personal-access-tokens/new> (Settings → Developer settings → Personal
access tokens → Fine-grained tokens). Set an expiry there — fine-grained tokens carry one — pick a
single resource owner, and select only the repositories this box should reach. Organization
approval may be required, and a token still pending approval reads public resources only. For a
read-only check, a valid fine-grained PAT with **no permissions at all** is enough: that covers
`get_me` and public repository reads. For the intended private-repository workflow, grant
**Contents: read**, **Issues: read**, **Pull requests: read**, plus the **Metadata: read** GitHub
includes automatically. These are permissions, not classic scope strings. Add extras only when a
tool needs them: PR `get_status` also wants **Commit statuses: read**, and organization issue-type
listing wants **Issue Types: read**. Revoke by deleting the token on the same settings page, then
remove or replace the value on the connector's credential card and let it restart.

**First call.** `get_me` with `{}`. A good answer is a user object carrying the expected account
login, its numeric id and the profile URL — that proves the token is accepted, not that any
repository is reachable. Follow with `get_file_contents`
`{"owner":"github","repo":"github-mcp-server","path":"README.md"}` for the public path, then the
same call against one of the selected private repositories, because a public read alone does not
prove the private grant.

**What bites.**

- **A listed tool is not an authorized one.** Fine-grained PATs do not support classic-scope
  detection, so the headers decide which tools the server offers while the token's permissions
  independently decide which API calls succeed. Expect tools that list and then fail.
- **A 404 can be a permission error.** A valid token without access to a resource answers 403
  (`Resource not accessible by personal access token`) or a privacy-preserving 404; check
  repository selection, expiry, organization approval and SSO before concluding the thing is gone.
- **Rate limits are shared and search is tighter.** PAT REST requests share the 5,000/hour user
  limit, search endpoints are lower, secondary limits apply, and one tool call can make several API
  requests. Also: the remote server does not host GitHub Enterprise Server; GHES needs the local
  binary.

Full report: [docs/connectors/github.md](connectors/github.md).

**If you are here because a job stopped on `github_auth`:** that is the Titan Job Bus saying its
worker could not authenticate `git` or `gh` inside the sandbox, and it never asks the submitter
for a token. The credential it needs is the one above, or the `gh` login on the box's shell tool.
The contract is [docs/JOB-BUS.md](JOB-BUS.md) §5, and the blocked job is in the console at
Settings → Job bus.

## Slack

**Preset.** Click **Slack (user token)**. It fills:

| field | filled with |
| --- | --- |
| Name | `slack` |
| Command | `npx` |
| Arguments | `-y slack-mcp-server@1.3.0 --transport stdio` |
| Environment variable names | `SLACK_MCP_XOXP_TOKEN` |

This one runs entirely in the box — `korotovsky/slack-mcp-server`, a maintained stdio server that
takes a pasteable token. `--transport stdio` is required. Posting stays off: the write tools are
not registered at all until their own configuration env is set.

**The credential.** A Slack **user OAuth token** (`xoxp-`), which acts as the installing user.
Create the app at <https://api.slack.com/apps> → Create New App → From scratch, then **OAuth &
Permissions → User Token Scopes**, then **Install to Workspace**, and copy the **User OAuth Token**.
The minimum that passes the smoke test is `channels:read`. The working read-and-search set adds
`channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`,
`mpim:history`, `users:read` and `search:read`; `usergroups:read` covers the usergroup tools. If you
later want the agent to post, that is `chat:write` **and** `SLACK_MCP_ADD_MESSAGE_TOOL=true` — the
second is configuration, not a credential, so it carries a value in the entry and the card will not
offer it. Revoke by revoking or reinstalling under the app's OAuth & Permissions, by uninstalling
the app from the workspace, or with `auth.revoke`; then clear or replace the console credential and
let the connector restart.

**First call.** `channels_list` with `{"channel_types":"public_channel","limit":5}`. A good answer
is a CSV directory of channels with id, name, topic or purpose and member count. If you took the
`xoxp` route, `conversations_search_messages` against a known public-channel keyword is the second
call worth making: it is what proves `search:read`. A dead token shows up as Slack's `invalid_auth`
(or `not_authed`, `token_revoked`, `account_inactive`, `token_expired`) inside the tool error; a
missing scope is `missing_scope`.

**What bites.**

- **The listener is not this connector.** The host's Slack listener binds inbound events to an
  agent; this entry is outbound MCP tools in the box. Connecting Slack in the console does not start
  this server. One Slack app can serve both planes, but the token gets pasted twice — the listener
  through Connect, the connector through its credential card.
- **A bot token costs you search.** `SLACK_MCP_XOXB_TOKEN` works, but `conversations_search_messages`
  is unavailable on `xoxb`, `search:read` becomes `search:read.public`, and the bot must be invited
  to every channel it should read.
- **The cache is load-bearing.** Without the users and channels cache (`~/.cache/slack-mcp-server/`
  on Linux), `#name` and `@handle` lookups and `channels_list` degrade.

Full report: [docs/connectors/slack.md](connectors/slack.md).

## Linear

**Preset.** Click **Linear (API key)**. It fills:

| field | filled with |
| --- | --- |
| Name | `linear` |
| Command | `npx` |
| Arguments | `-y mcp-remote@0.8.3 https://mcp.linear.app/mcp --transport http-only --header "Authorization:Bearer ${LINEAR_API_KEY}"` |
| Environment variable names | `LINEAR_API_KEY` |

Linear's own hosted server, bridged. Linear documents that the endpoint accepts an API key in
`Authorization: Bearer` instead of the interactive OAuth flow, which is what makes this a paste
rather than a browser session in the box. If write tools must never even appear, point the same
entry at `https://mcp.linear.app/mcp/readonly` instead.

**The credential.** A Linear **personal API key**, created at
<https://linear.app/settings/account/security> (Settings → Account → Security & Access → Personal
API keys → New API key). Copy it on creation; Linear will not show it again. Each key carries
permissions — Read, Write, Admin, Create issues, Create comments — plus an optional team
restriction, and can never exceed the creating user's own workspace access. For the read-only
configuration grant **Read** and nothing else; Linear's own MCP FAQ recommends exactly that for a
read-only integration. For a working agent that files things, add **Write**, or the narrower
**Create issues** / **Create comments** if that is all it should do. Do not grant **Admin** unless
you need the webhook and admin surfaces. Revoke from the same Security & Access page, or from
workspace Settings → Administration → API where an admin can revoke workspace keys; then remove or
replace the console credential and let the connector restart. (Workspace admins can also disable
member-created keys entirely, which is worth checking before blaming the entry.)

**First call.** `list_teams` with `{}`. A good answer is the workspace's teams with at least id and
name — that proves the Bearer key is accepted and the user can see teams. Then `list_issues` with
`{"assignee":"me"}` for the caller's assigned issues; an empty list can be a genuinely empty inbox,
so do not read it as a failure. A bad key reads as HTTP 401 or an authentication error; a Read-only
key calling a write tool is a permission failure, which is a different thing.

**What bites.**

- **Two auth conventions, one key.** MCP wants `Authorization: Bearer <key>`. Direct Linear GraphQL
  calls use `Authorization: <key>` with no `Bearer`. Do not mix them.
- **Drop the header and you get a browser.** Omitting the `--header` argument falls through to
  `mcp-remote`'s OAuth flow, which wants a browser in the box and stores its tokens under
  `~/.mcp-auth`. That is the disfavored path here. `/sse` is deprecated; do not point new entries
  at it.
- **The rate limit is per user, not per key.** 2,500 requests/hour and 3,000,000 complexity
  points/hour for API keys, shared across every key that user holds; over-limit answers arrive as
  GraphQL `errors.extensions.code = RATELIMITED` on HTTP 400.

Full report: [docs/connectors/linear.md](connectors/linear.md).

## Google Workspace

**Preset.** Click **Google Workspace (OAuth refresh token)**. It fills:

| field | filled with |
| --- | --- |
| Name | `google` |
| Command | `npx` |
| Arguments | `-y google-workspace-mcp-server@1.4.3` |
| Environment variable names | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |

Three empty env values means **three credential cards** on the connector, and the process cannot
authenticate until all three are stored. Google's own 2026 remote MCP was not chosen: it is two
product endpoints, it accepts only a roughly one-hour OAuth access token as a Bearer, and there is
no durable token to paste. This npm server takes a refresh token and mints access tokens itself, so
spawning needs no browser.

**The credential.** There is no long-lived Gmail or Docs PAT, so the one-time browser work happens
against Google's OAuth Playground rather than a loopback port inside the container.

1. Create a Google Cloud project and enable the **Gmail API**, **Google Docs API** and **Google
   Drive API** (the Docs tools address Drive file ids).
2. Configure the OAuth consent screen: **Internal** for a Workspace domain, which needs no test-user
   list; **External** for consumer Gmail, adding the operator as a test user until the app is
   verified.
3. Create an OAuth **Web application** client with `https://developers.google.com/oauthplayground`
   as an authorized redirect URI, and copy the client id and secret.
4. In the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/): gear → **Use your
   own OAuth credentials** → paste the id and secret → select the scopes → **Authorize APIs** →
   sign in → **Exchange authorization code for tokens** → copy the **Refresh Token**, not the
   access token.

For reading only, that is `https://www.googleapis.com/auth/gmail.readonly` plus
`https://www.googleapis.com/auth/drive.readonly` (official Docs MCP also lists
`documents.readonly`). For the working configuration — read mail, read and write Docs — add
`https://www.googleapis.com/auth/gmail.compose` if you want `gmail_create_draft`,
`https://www.googleapis.com/auth/documents` for Docs read and write, and
`https://www.googleapis.com/auth/drive.file`; grant the broad
`https://www.googleapis.com/auth/drive` only if you will actually use this server's Drive tools.
Note that `gmail.readonly` is a **restricted** scope: an External or production app needs Google's
restricted-scope verification, an Internal Workspace app does not. Revoke by removing the app under
<https://myaccount.google.com/permissions> or POSTing the token to Google's revoke endpoint, and
delete or rotate the OAuth client under Credentials; then replace or clear the three console
credentials and let the connector restart.

**First call.** `gmail_list_labels` with `{}` — it needs no message or document id. A good answer is
a list of label objects with `id` and `name`, including system labels such as `INBOX` and `UNREAD`.
Then `gmail_list_messages` with something like `{"q":"is:unread","maxResults":5}` and
`gmail_get_message` on one of the returned ids; for the Docs half, `docs_create_document` followed
by `docs_get_document` on that id should come back with the title and body.

**What bites.**

- **A revoked refresh token does not look revoked.** It surfaces as a `401` / `invalid_grant` /
  "Access token expired" until you mint a new one in the Playground. A missing scope or a disabled
  API is `403` instead.
- **Mail and documents are untrusted input.** Google documents prompt injection as a risk for its
  own Workspace MCP servers; treat anything the agent reads out of this connector the same way.
- **More tools than scopes.** The same process also registers Sheets, Drive and Calendar tools, and
  Google's official Workspace MCP is still Developer Preview. Grant only the scopes you mean to
  use — a registered tool with no scope behind it just fails at call time.

Full report: [docs/connectors/google.md](connectors/google.md).

## TinyFish

**Preset.** Click **TinyFish (API key)** — the reference preset this whole mechanism was built
around. It fills:

| field | filled with |
| --- | --- |
| Name | `tinyfish` |
| Command | `npx` |
| Arguments | `-y mcp-remote https://agent.tinyfish.ai/mcp --transport http-only --header "Authorization:Bearer ${TINYFISH_API_KEY}"` |
| Environment variable names | `TINYFISH_API_KEY` |

A box wants one TinyFish, so this preset replaces an entry already named `tinyfish` — including the
older OAuth one — rather than being refused as a duplicate.

**The credential.** The account's TinyFish API key, pasted into the single `TINYFISH_API_KEY` card.
It goes in the **`Authorization: Bearer`** header, not `X-API-Key`: measured from inside the box on
2026-09-04 with an invented key, the MCP endpoint answers
`401 Unauthorized: Valid OAuth Bearer token required` to `X-API-Key`, and the bearer form is what
TinyFish's own CLI documentation uses for the same endpoint. `X-API-Key` remains correct for
TinyFish's REST endpoints, which is why it was tried first. To rotate, store a new value on the
card; to remove access, take the value out with the card's delete and rotate the key at TinyFish —
the field stays on the card as an empty one to fill again.

**First call.** The card polls by itself: a good answer is it leaving initializing and listing the
server's tools. Nineteen were listed on the R750 install, and from this repository's own connection
to the same service the names are `search`, `fetch_content`, `run_web_automation`,
`run_web_automation_async`, `get_run`, `list_runs`, `cancel_run`, `guide_next_step`,
`create_browser_session`, `list_browser_sessions`, `close_browser_session`, `batch_status`,
`batch_cancel`, `get_wallet`, `get_search_usage` and `list_fetch_usage`. Make the first call
`search` or `fetch_content`: those are free per TinyFish's documentation, while agent and browser
runs are metered against the wallet.

**What bites.**

- **The header form is exact.** No space after the colon — that is the form `mcp-remote`'s README
  asks for from clients that mangle spaces inside an argument, and it trims the value itself. And
  the whole header must stay one quoted argument in the console's argument field, or it arrives as
  two arguments and is lost.
- **The OAuth alternative signs the box's own Chrome in.** The other recipe completes authorization
  in the box's browser, which is a long-lived signed-in profile reachable by anyone who gets through
  the console's password. Revoking that path means revoking the client at Clerk, not deleting a key.
- **`~/.mcp-auth` does not survive a recreate.** On the OAuth path, `/home/box` is not one of the
  box's volumes, so the token store has to be pointed into `sand-data` or the connector silently
  goes back to waiting for authorization after the next redeploy.

**The TinyFish CLI is a different thing, and it lives under Shell tools.** The connector above is
an MCP server the host spawns; the CLI is a program the agent runs itself. **Marketplace** →
**Plugins** → **TinyFish CLI** → **Install in the box** runs
`pip install cli-anything-tinyfish` in the box as user `box`, capped at five minutes, and shows the
tail of its output on the card. Then paste the same TinyFish key into that card's
`TINYFISH_API_KEY` field — a key stored on the `tinyfish` connector card does not reach the CLI,
because a connector's environment and the box shell's are two different environments — and press
**Teach the active agent**, which imports the CLI's own published `SKILL.md` as a workflow for the
agent on screen. Removing the stored key leaves the name in that shell with an empty value until
the box restarts: the host can set a variable in the running shell, it cannot unset one.

Full report: [docs/CONNECTORS-TINYFISH.md](CONNECTORS-TINYFISH.md), which also carries the OAuth
recipe, the measured R750 install and what the probe left behind on the Mac's box (nothing).

## CodeRabbit

**No preset, and no entry in `connectors.json`.** CodeRabbit ships no MCP server — it is an MCP
*client*, consuming other people's servers during a PR review — so there is nothing for the host to
spawn and nothing will ever appear in `tools/list`. The integration is the official CLI, installed
and keyed from the console's **Shell tools** group — the same shape as the TinyFish CLI: an install,
a credential card, and the agent's shell inheriting the key. Every unofficial CodeRabbit MCP package
on npm was rejected in the report as unofficial, inactive, archived, or a security holding stub.

**Install it from the console.** **Marketplace** → **Plugins** → **CodeRabbit CLI** → **Install in
the box**. That button runs

```bash
CI=1 curl -fsSL https://cli.coderabbit.ai/install.sh | sh
```

in the box as user `box`, capped at five minutes, and shows the tail of its output on the card; the
installer wants `curl` and `unzip` and defaults to `~/.local/bin`, and `CI=1` skips the post-install
browser prompt. Then paste the Agentic key into that same card's `CODERABBIT_API_KEY` field: the
host puts it in the `shell` section of the 0600 store and merges it into the environment of the box
shell the agent runs commands in. Taking that key back out empties the variable rather than removing
it — the name stays in the running box shell with an empty value until the box restarts, which the
CLI treats the same as no key at all. Reviews then run as
`cr review --agent --api-key "$CODERABBIT_API_KEY"` (add `--region eu` for EU accounts, which is
only accepted alongside `--api-key`). The key is passed on every run rather than left with the CLI:
box storage is ephemeral.

**The credential.** An **Agentic API key** — CodeRabbit's docs show the prefix as `cr-…` — created
at <https://app.coderabbit.ai/settings/api-keys> (EU:
<https://app.eu.coderabbit.ai/settings/api-keys>) for the organization that should bill CLI reviews.
It requires an assigned seat. There are no OAuth scope strings to choose: the key is org-bound, and
the CLI rejects the other key types outright with a message that user API keys are not supported.
The browser alternative, `cr auth login`, wants a GUI and is the wrong shape here. Revoke by
deleting the key on the same page — CodeRabbit's audit log records `api_key_delete` — and run
`cr auth logout` if a session was ever stored locally. Do not paste a GitHub PAT here; that belongs
to the unofficial package the report rejected.

**First call.** `coderabbit --version` first: expect 0.7.6 or newer, and `--agent` needs at least
0.4.0. Then `cr auth status --agent`, whose good answer is structured JSON naming an authenticated
session and its region, followed by `cr doctor`, which exits 1 if any of runtime, local storage,
auth, git repo, backend HTTPS or WebSocket fails. The real one is `cr review --agent --api-key …`
from an initialized git worktree with a small tracked diff: a good answer is NDJSON on stdout, one
object per line, with `type` values `review_context`, `status`, `heartbeat`, `finding` and
`complete`; a `finding` carries `severity`, `fileName` and either `codegenInstructions` or
`comment`. An empty scope answers `complete` with `status: "review_skipped"`, `findings: 0` and
`"No changes detected"` — that is a pass, not a failure.

**What bites.**

- **`cr doctor` can pass while a review fails.** Auth failures after the network path is good come
  back as HTTP 401 or 403; a key of the wrong type comes back as "user API keys not supported".
- **It needs git, and WebSockets.** Run inside a git worktree, and add `--include-untracked` for
  untracked files. Every hosted review opens **WSS** to `ide.coderabbit.ai` (or the EU host); a
  proxy that blocks WebSocket upgrades fails the review with a `1006`.
- **Reviews are slow and rationed.** Three to twelve CLI reviews per developer per rolling hour
  depending on plan, 150 or 300 files per review, and 7 to 30+ minutes each. In `--agent` mode the
  CLI never auto-confirms paid overage: it returns `action_required` with
  `status: "awaiting_confirmation"` and waits for `--use-credits`.

Full report: [docs/connectors/coderabbit.md](connectors/coderabbit.md).

## GitHub CLI (gh)

**No preset, and no entry in `connectors.json`.** This is a shell tool, like the CodeRabbit and
TinyFish CLIs: a program the agent runs itself, with its credential in the box shell's environment.
It is not the **GitHub** plugin above and does not replace it — that one is an MCP server the model
calls, read-only by construction; this one is for `git`.

**The problem it fixes.** An agent committed inside the box and then could not push. `git pull`
answered:

```
fatal: could not read Username for 'https://github.com': No such device or address
```

That is not a missing token, it is a missing *credential helper*. Git over https asks a helper for a
username and password; with none configured it falls back to prompting on a terminal, and the box's
shell has nobody typing at it. Setting `GITHUB_TOKEN` alone changes nothing, because plain `git` has
never read that variable.

**Install it from the console.** **Marketplace** → **Plugins** → **GitHub CLI (gh)** → **Install in
the box**. That button runs GitHub's own documented Linux install
([cli/cli docs/install_linux.md](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)) in the
box as the host's user, capped at five minutes, and shows the tail of its output on the card. It
picks one of two documented routes, because one container is not every container:

- the official **apt repository** — the `githubcli-archive-keyring.gpg` keyring under
  `/etc/apt/keyrings`, a `signed-by=` line in `/etc/apt/sources.list.d/github-cli.list`, then
  `apt-get install -y gh` — used when `apt-get` is present *and* this user can reach root without a
  password;
- otherwise the official **precompiled tarball** for the box's architecture, unpacked into
  `~/.local/bin/gh`. That is the same directory the CodeRabbit installer uses, and the reason the
  host probes for a shell tool with `/bin/sh -lc` from the user's home.

An already-installed `gh` is left alone. Either way the install then runs the step the whole entry
exists for:

```bash
gh auth setup-git --hostname github.com
```

which writes `credential."https://github.com".helper = !gh auth git-credential` into that user's
global git config. From then on every https fetch and push asks `gh` for the credential, and `gh`
reads `GITHUB_TOKEN` out of its own environment. If the token has not been stored yet, `setup-git`
has no host to name and exits non-zero; the install writes the same helper line by hand instead,
because the helper does not need the token until git actually calls it. The last line of the install
reads the key back with `git config --global --get-regexp`, so an install that did not leave a
helper behind fails on the card rather than leaving `git push` to discover it.

**The credential.** A **fine-grained personal access token** minted at
<https://github.com/settings/personal-access-tokens/new>: one resource owner, only the repositories
it may touch, an expiry, and **Contents: write** on those repositories for pushing (**Metadata:
read** comes with it automatically). The same permissions table as the GitHub connector's token
(`docs/connectors/github.md`), one grant wider because that connector is read-only and this one
pushes. Organization approval may be required, and a pending token can only read public resources.

Paste it into the card's `GITHUB_TOKEN` field. It goes into the `shell` section of the same 0600
store, and the host merges it into the environment of the box shell the agent runs commands in —
**not** into any connector process. Note the two names are different on purpose: the GitHub
connector's slot is `GITHUB_PERSONAL_ACCESS_TOKEN` in a connector's environment, this is
`GITHUB_TOKEN` in the shell's, and filling one does not fill the other. Revoke by deleting the token
on the same settings page. Taking it back out of the card empties the variable rather than removing
it — the name stays in the running box shell with an empty value until the box restarts, which `gh`
treats as no token at all.

**First call.** `gh --version`, then `gh auth status` (expect it to report the token came from the
`GITHUB_TOKEN` environment variable), then the one that matters:

```bash
git ls-remote https://github.com/cli/cli-credential-probe
```

That path does not exist, and that is the point: github.com answers 401 for it, so git has to ask
the credential helper. A public URL would be read anonymously and would say nothing about the
helper. A good answer is `remote: Repository not found` or `fatal: Authentication failed` — both
mean a credential was handed over and github.com answered on it, which is the plumbing working.
What must never come back is `could not read Username`: that is the original bug, and it means the
helper is not configured.

**What bites.**

- **`gh` and `git` read different variables.** `gh` accepts `GH_TOKEN` first and `GITHUB_TOKEN`
  second; `git` reads neither. Only the credential helper connects them, so an install that skipped
  `gh auth setup-git` looks completely healthy from `gh auth status` and still cannot push.
- **The helper is per-user, and so is `~/.local/bin`.** The install runs as whoever the host runs
  as. A shell running as a different user in the same container has a different `HOME`, a different
  global git config, and no `gh` on its `PATH`.
- **ssh remotes are not covered.** This is an https credential helper. A repository cloned from
  `git@github.com:` never asks it; change the remote to the https URL or add a key.
- **Fine-grained tokens are per-owner.** One token cannot push to repositories owned by two
  different accounts or organizations. Nothing warns you; the second push 403s.
- **Box storage is ephemeral.** The token is re-merged into the shell environment on every box
  bring-up from the host's store, but `gh`'s own installed binary is not: after a box rebuild the
  card's **Install in the box** has to run again, and the credential-helper line goes with it.

Source: [cli/cli `docs/install_linux.md`](https://github.com/cli/cli/blob/trunk/docs/install_linux.md).
Token permissions: [docs/connectors/github.md](connectors/github.md).
