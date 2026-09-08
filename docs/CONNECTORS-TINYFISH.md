# TinyFish as a connector

**The index for every connector on this box is [docs/CONNECTORS.md](CONNECTORS.md)** — GitHub,
Slack, Linear, Google Workspace, TinyFish and CodeRabbit, one operator walk-through each, and the
"How it works" head that explains the entry, the credential card and the secret store once for all
of them. This page is TinyFish's own report in full: the measurements, the OAuth alternative, and
what the probe left behind.

TinyFish is the paid web-automation service: ranked search, page fetch, and a browser agent that
clicks through a real site. An agent in the box reaches it as MCP tools, the same way it reaches
the filesystem connector, once TinyFish is a connector on this box.

There are two ways to make it one, and the key is now the first of them. The operator pastes an API
key into the connector's credential card and the box does the rest; the OAuth route, which is what
this document used to lead with, is kept below as the alternative. Everything measured is dated and
says which machine it was measured on; everything that is a contract the code implements rather
than an observation is labelled as such.

## What the connector plane can and cannot do here

This build runs connectors as **local stdio servers only**. `connectors.json` under
`/home/box/sand-data` is the whole configuration surface:

    {
      "mcpServers": {
        "<name>": { "command": "...", "args": ["..."], "env": { } }
      }
    }

There is no entry shape for a remote HTTP MCP server, so anything remote has to be bridged by a
local process. `mcp-remote` is that process, and it runs in the box: node v20.19.2, measured on
this Mac's box 2026-09-04.

Secrets do not go in that file. `setConnectorSecret {server, field, value}` puts them in
`/home/box/sand-data/connector-env-secrets.json` (0600), and the host hands them to the connector
process as environment variables when it spawns it. Measured on this Mac's box, with an invented
key: after storing it, `grep -rl` across the whole of `/home/box/sand-data` found the value in
`connector-env-secrets.json` and nowhere else. Not in `connectors.json`, not in a per-agent tree,
not in a log.

## The measurement: X-API-Key is refused, the bearer is the one it takes

TinyFish's REST endpoints take `X-API-Key` (`api.search.tinyfish.ai`, `api.fetch.tinyfish.ai`,
`agent.tinyfish.ai/v1/automation/run-sse`). Its **MCP** endpoint does not. From inside the box on
2026-09-04, with an invented 43-character key:

    POST https://agent.tinyfish.ai/mcp   -H "X-API-Key: <invented>"
    401 {"jsonrpc":"2.0","error":{"code":-31001,
         "message":"Unauthorized: Valid OAuth Bearer token required"},"id":1}

An invented key gets the same 401 as `Authorization: Bearer`, which is what an invented key should
get. What the header name has to be is not a guess: TinyFish's own CLI documents it. `npm
@tiny-fish/cli`, the "Connect Grok" section, connects a client to the same endpoint by passing the
account's API key as `Authorization: Bearer <key>`. So the credential this endpoint understands is
the API key, carried in the bearer header — not in `X-API-Key`, which is the REST-side name and the
one that was tried first here.

A call with no credential at all answers:

    www-authenticate: Bearer resource_metadata="https://agent.tinyfish.ai/.well-known/oauth-protected-resource/mcp"

and that document names the authorization server (`https://clerk.tinyfish.ai`), which is what the
alternative recipe at the bottom of this page uses.

**Not measured here, and deliberately:** nobody in this repository has driven the bearer path
against `agent.tinyfish.ai` with a real key. Tests and gates use an invented key against a stub MCP
server started inside the box, so no real credential is ever read, logged, or committed. What the
gate proves is the mechanism end to end — the entry, the header, the secret store, the restart, the
tool list, a tool call. What TinyFish's docs supply is the header name.

## The entry

    "tinyfish": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://agent.tinyfish.ai/mcp",
               "--transport", "http-only",
               "--header", "Authorization:Bearer ${TINYFISH_API_KEY}"],
      "env": { "TINYFISH_API_KEY": "" }
    }

Every part of that is load-bearing:

- `mcp-remote` passes a custom header with `--header "Name: value"` and **expands `${VAR}` in the
  value from its own environment** (its README). So the literal text `${TINYFISH_API_KEY}` is what
  goes into `connectors.json`, unexpanded. The key itself never enters that file: the host merges
  the stored secret into the connector process's environment when it launches it, and `mcp-remote`
  expands the placeholder at start.
- **No space after the colon.** That is the form `mcp-remote`'s README asks for from clients that
  mangle spaces inside an argument; it trims the value itself.
- `"TINYFISH_API_KEY": ""` — the empty value is not decoration either. An env key whose value in
  the entry is the empty string is a **credential field**: the card offers it as "Enter securely",
  `setConnectorSecret` stores it, `listConnectorSecretFields` reports it. An env key that carries a
  value is **configuration** and is never offered as somewhere to paste a key. That rule exists
  because the OAuth entry below declares `MCP_REMOTE_CONFIG_DIR`, which is a path, the card offered
  it, and a pasted key went into it.
- One TinyFish per box. Filling the preset over an entry already called `tinyfish` — the OAuth one
  — replaces it whole, `MCP_REMOTE_CONFIG_DIR` included.

## The tenant entry: the same preset, bridged to the proxy (PROXY-1)

Everything above is the operator install and stays the operator install. A customer whose plan
includes web search and page fetch gets a different far end from the **same catalog entry**, so
there is one preset and not two lists that drift:

    "tinyfish": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://titanbot-proxy:4000/mcp/",
               "--transport", "http-only",
               "--header", "x-litellm-api-key:Bearer ${TINYFISH_API_KEY}",
               "--header", "x-mcp-servers:tinyfish"],
      "env": { "TINYFISH_API_KEY": "" }
    }

Three deliberate differences and one deliberate sameness.

- **`x-litellm-api-key`, not `Authorization`.** `mcp-remote` owns the `Authorization` header for its
  own OAuth discovery, which is exactly why the proxy offers a second name. Measured on this Mac
  2026-09-08 against LiteLLM v1.100.0: it accepts the key with or without the `Bearer ` prefix, and
  also accepts `Authorization` directly; the entry uses the documented form.
- **`x-mcp-servers: tinyfish`** names which of the services mounted at that one URL this connector
  is.
- **`http://`, not `https://`.** That is fine here and is not the endpoint guard's business: the
  guard lives in the relay's endpoint save, and an included route never passes through it.
- **The env name does not move.** `TINYFISH_API_KEY` still holds the credential; what changes is
  whose it is. On a tenant box it holds that box's own virtual key, minted per customer, budgeted
  and revocable, and the operator's real TinyFish key is added by the proxy on the far side and
  never enters the box at all.

**Measured, and worth knowing before you rely on it** (this Mac, 2026-09-08, LiteLLM v1.100.0 in
Docker with a stub upstream, no real TinyFish key involved):

| claim | result |
| --- | --- |
| `mcp-remote` 0.8.4 carries unchanged | connects, initializes and lists tools, about 1 s from spawn |
| a virtual key with no MCP permission | **empty tool list, HTTP 200, no error.** The mint must carry `object_permission: {mcp_servers: ["tinyfish"]}`; `allowed_mcp_servers` is silently ignored |
| the tool names | listed **prefixed**: `tinyfish-search`, `tinyfish-fetch_content`. A `tools/call` on the unprefixed name still resolves and the upstream receives the unprefixed name |
| revocation | 401 immediately after `/key/delete` |
| metering | **none.** Spend stayed 0 after three tool calls; the REST pass-through recorded 0.004 for two |

So this route keeps a customer's TinyFish *tools* alive once the operator's key leaves their box,
and the REST pass-through behind WebFetch and WebSearch is the route that counts. Both are in
[docs/PROXY.md](PROXY.md) §7, with the two gap rows the measurement opened (PROXY-4, PROXY-5).

## Operator: paste the key

**Marketplace** → *Plugins* → **Add** on the TinyFish card, or the **Add or remove a connector**
editor at the bottom of the same tab.

1. Click **TinyFish (API key)**. It fills the four fields with the entry above and writes nothing:

   | field | filled with |
   | --- | --- |
   | Name | `tinyfish` |
   | Command | `npx` |
   | Arguments | `-y mcp-remote https://agent.tinyfish.ai/mcp --transport http-only --header "Authorization:Bearer ${TINYFISH_API_KEY}"` |
   | Environment variable names | `TINYFISH_API_KEY` |

   The header is quoted because it is one argument that holds a space. The argument field groups on
   quotes; unquoted, it splits on whitespace, and the header would arrive as two arguments and be
   lost.

2. Press **Add connector**. That writes `connectors.json` on the box through the relay and calls
   `refreshMcp`, so the host relaunches its stdio servers without a container restart. If a
   `tinyfish` entry was already there, this replaces it.

3. The connector's card appears with the box still starting it. **Credentials for tinyfish** offers
   one masked input, `TINYFISH_API_KEY`, and no other — `MCP_REMOTE_CONFIG_DIR` is not a credential
   and is not offered. Paste the key and press **Store on the host**. That calls
   `setConnectorSecret`, which writes the 0600 store and never the config file, and restarts the
   connector.

4. The card polls until the box reports the server connected and its tools are listed. Until the
   key is stored the connector cannot authenticate, so it sits at initializing or error — the card
   says so and nothing blocks on it.

Removing it: **Remove this connector** on the card, or the row in the editor. That drops it from
`connectors.json` and re-reads the file. The stored secret is separate: `deleteConnectorSecret`
takes it out of the store, and the field stays on the card as an empty one to fill again.

The gate for this path is `scripts/verify-connector-plane.mjs --tinyfish-key`, which runs the same
entry against a stub MCP server inside the box with an invented key, and
`scripts/verify-dashboard.mjs`, which checks in a real browser that the preset button fills exactly
the entry above and saves nothing on the click.

## Agent: AddMcpServer

An agent adds the same entry itself with **AddMcpServer** — same name, same command, same
arguments, same environment variable name — after confirming with the user, the way
`source/host/extensions/managed-setup/seed-skills/add-connector/SKILL.md` describes for a server
the catalog does not know.

What the agent cannot do is set the key. `setConnectorSecret` is a console command, not an agent
tool, and that is deliberate: a key typed into a conversation is in the transcript, the model's
context and the window it was compacted into. So the split is:

- the agent installs the connector,
- the operator pastes the key on the connector's card in the console,
- a tool call made before the key is stored answers with an error that names that card, rather than
  a bare transport failure the agent cannot act on.

That last line is the contract the agent-side piece of CONNECT-3 implements; it is the behaviour to
check when reading this, not an observation. Note also what `AddMcpServer` accepts today in
`source/host/runner/tools/sand-mcp-management-tools.ts`: `name`, `url`, `headers` — the local
command form the skill describes needs the `command`/`args`/`env` arguments that piece adds.

## Alternative: OAuth once, at the box's own desktop

This is the route that was measured working end to end first, and it is still the one to use if the
account should authorize a client rather than hand out a key.

The box has a browser and a screen, and `mcp-remote` binds its callback on the box's own loopback,
so the authorization can be completed without any of it leaving the container.

Connector entry:

    "tinyfish": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://agent.tinyfish.ai/mcp", "--transport", "http-only"],
      "env": { "MCP_REMOTE_CONFIG_DIR": "/home/box/sand-data/.mcp-auth" }
    }

`MCP_REMOTE_CONFIG_DIR` is not decoration. `mcp-remote` stores its tokens in `~/.mcp-auth` by
default, and `/home/box` is **not** one of the box's four volumes: `/workspace`,
`/home/box/sand-data`, `/var/lib/sand-box-store` and `/home/box/chrome-profile` are. A token in the
default location survives a restart and dies at the next recreate, which a redeploy does, and the
connector would silently go back to waiting for authorization. Putting the store inside `sand-data`
puts it in a volume. It is also configuration, not a credential: it carries a value, so the card
does not offer it as a place to paste anything.

Then, once:

1. Add the connector with the editor (name `tinyfish`, command `npx`, the arguments above,
   environment variable name `MCP_REMOTE_CONFIG_DIR`). Its card goes to `error` after sixty seconds.
2. Read the authorize URL out of the server's `statusDetail` on that card.
3. Open the box's desktop from the console and paste that URL into the box's Chrome. The redirect
   goes to `http://localhost:<port>/oauth/callback`, which is the box's own loopback, so it has to
   be that browser and not one on the Mac.
4. Approve. The tokens land in `/home/box/sand-data/.mcp-auth` and the connector reconnects.

The refresh token is what makes this a one-time step. It is also the thing to remember when
rotating access: revoking that client at Clerk is what removes the box's access, not deleting a key.

`clerk.tinyfish.ai`'s `.well-known/oauth-authorization-server` says what is possible here:
`grant_types_supported` is `["authorization_code","refresh_token"]`, `registration_endpoint` is
open and public clients are accepted (so `mcp-remote` can register itself with no client id to
obtain), and there is **no** `device_authorization_endpoint` — so `mcp-remote --device-code` is not
available and a browser hitting a loopback redirect is the only way to a token.

**Before doing step 3, know whose browser that is.** The box's Chrome is a long-lived signed-in
profile, and on this Mac's box it is already signed in to TinyFish: the probe that measured all of
this let `mcp-remote` open its authorize URL, and the box's browser landed on `accounts.tinyfish.ai`
with the page title "My account", not on a sign-in form. That was fine while the console lived on
the tailnet. It is a different fact once the console is public with a password as the only lock:
anyone through that password reaches the desktop surface, and the desktop surface is a browser
signed in wherever that profile is signed in. It is not a reason to skip this recipe, and it is a
reason to decide deliberately what that profile stays signed in to. Approving one more OAuth client
in it adds a refresh token to the same pile.

### Measured install on the R750, 2026-09-05 11:45 CDT

This recipe worked end to end once the sign-in was approved in that box's own Chrome: the bridge
(`npx -y mcp-remote https://agent.tinyfish.ai/mcp 41257 --transport http-only` with
`MCP_REMOTE_CONFIG_DIR=/home/box/sand-data/.mcp-auth`) wrote `mcp-remote-v1/<id>_tokens.json`, the
entry went into `connectors.json` as user box (0600), `refreshMcp` was called, and ten seconds later
`listInstalledMcpServers` said connected and `listMcpServerTools` (by `serverId`, not by name)
listed 19 tools. Two things the recipe did not say: the token directory was root-owned from the
manual bridge and needed `chown -R box:box` before the connector, which runs as box, could read it;
and a Coolify restart kills the manual bridge, so the sign-in has to be re-armed after every ship
until the tokens exist. The tokens live on the data volume and survive restarts.

## Which tools an agent then sees

Measured on the R750 install above: 19 tools. From this repository's own connection to the same
service:

    search                     fetch_content              run_web_automation
    run_web_automation_async   get_run                    list_runs
    cancel_run                 guide_next_step            create_browser_session
    list_browser_sessions      close_browser_session      batch_status
    batch_cancel               get_wallet                 get_search_usage
    list_fetch_usage

Search and fetch are free per TinyFish's documentation; agent and browser runs are metered against
the wallet, which is why `get_wallet` and the usage tools are on that list at all.

## What the 2026-09-04 probe left behind on this Mac's box

Nothing. `connectors.json` was read first and restored byte for byte afterwards: sha256
`04f0f8b93419bee5eb4ed5b7c654ad5288c7ef80f565e3f740c0095c44f1f4d5`, 245 bytes, mode 600, identical
before and after. `connector-env-secrets.json` is back to `{"servers":{}}` at 20 bytes. The box's
connector roster reads `localfiles:connected:14`, which is what it read before any of this. The box
was not restarted. `scripts/verify-connector-plane.mjs --tinyfish-key` holds itself to the same
standard: both files byte-identical before and after, on failure as well as success.
