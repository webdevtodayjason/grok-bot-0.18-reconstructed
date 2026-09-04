# TinyFish as a connector

TinyFish is the paid web-automation service: ranked search, page fetch, and a browser agent that
clicks through a real site. An agent in the box reaches it as MCP tools, the same way it reaches
the filesystem connector, once TinyFish is a connector on this box.

Everything below was measured on 2026-09-04 against the box on this Mac and against TinyFish's own
endpoints. The headline is a correction: **the TinyFish MCP endpoint does not accept an API key.**
It wants an OAuth bearer. Everything else follows from that.

## What the connector plane can and cannot do here

This build runs connectors as **local stdio servers only**. `connectors.json` under
`/home/box/sand-data` is the whole configuration surface:

    {
      "mcpServers": {
        "<name>": { "command": "...", "args": ["..."], "env": { } }
      }
    }

There is no entry shape for a remote HTTP MCP server, so anything remote has to be bridged by a
local process. `mcp-remote` is that process, and it runs in the box: node v20.19.2, measured.

Secrets do not go in that file. `setConnectorSecret {server, field, value}` puts them in
`/home/box/sand-data/connector-env-secrets.json` (0600), and the host hands them to the connector
process as environment variables when it spawns it. Measured, with an invented key: after storing
it, `grep -rl` across the whole of `/home/box/sand-data` found the value in
`connector-env-secrets.json` and nowhere else. Not in `connectors.json`, not in a per-agent tree,
not in a log.

## The measurement: X-API-Key is refused

TinyFish's REST endpoints take `X-API-Key` (`api.search.tinyfish.ai`, `api.fetch.tinyfish.ai`,
`agent.tinyfish.ai/v1/automation/run-sse`). Its **MCP** endpoint does not. From inside the box,
with an invented 43-character key:

    POST https://agent.tinyfish.ai/mcp   -H "X-API-Key: <invented>"
    401 {"jsonrpc":"2.0","error":{"code":-31001,
         "message":"Unauthorized: Valid OAuth Bearer token required"},"id":1}

The same call with `Authorization: Bearer <invented>` gets the same 401. A call with no credential
at all answers:

    www-authenticate: Bearer resource_metadata="https://agent.tinyfish.ai/.well-known/oauth-protected-resource/mcp"

and that document names the authorization server:

    {"resource":"https://agent.tinyfish.ai/mcp",
     "authorization_servers":["https://clerk.tinyfish.ai"], ...}

`https://clerk.tinyfish.ai/.well-known/oauth-authorization-server` then says what is possible:

    grant_types_supported:            ["authorization_code","refresh_token"]
    registration_endpoint:            https://clerk.tinyfish.ai/oauth/register
    token_endpoint_auth_methods:      ["client_secret_basic","none","client_secret_post"]

Two consequences worth reading twice. Dynamic registration is open and public clients are
accepted, so `mcp-remote` can register itself with no client id to obtain. And there is **no**
`device_authorization_endpoint`, so `mcp-remote --device-code` is not available: the only way to
get a token is a browser hitting a loopback redirect.

## What the bridge does with a key, end to end

The connector was added on this Mac's box with an invented key, exactly as the recipe below
describes, and then removed. The host's own report of that server:

    status:      error
    toolCount:   0
    statusDetail: MCP server connection timed out after 60000ms: tinyfish; stderr:
      Using transport strategy: http-only
      Using custom headers: X-API-Key
      Discovering OAuth server configuration...
      Discovered authorization server: [REDACTED]
      Connecting to remote server: https://agent.tinyfish.ai/mcp
      Please authorize this client by visiting:
        https://clerk.tinyfish.ai/oauth/authorize?response_type=code&client_id=...
        &redirect_uri=http%3A%2F%2Flocalhost%3A41257%2Foauth%2Fcallback&scope=openid+profile+email+offline_access
      Browser opened automatically.
      Authentication required. Waiting for authorization...

`listMcpServerTools` for it returned `[]`.

That failure is the proof the bridge works: it sent the `X-API-Key` header, reached
`agent.tinyfish.ai`, was refused, discovered the authorization server from the refusal, registered
itself, and sat waiting for a human to approve it. Nothing in that chain is broken except the
assumption that a key is a credential this endpoint understands.

## Recipe A: OAuth once, at the box's own desktop

The box has a browser and a screen, and `mcp-remote` binds its callback on the box's own loopback.
So the authorization can be completed without any of it leaving the container.

Connector entry:

    "tinyfish": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://agent.tinyfish.ai/mcp", "--transport", "http-only"],
      "env": { "MCP_REMOTE_CONFIG_DIR": "/home/box/sand-data/.mcp-auth" }
    }

`MCP_REMOTE_CONFIG_DIR` is not decoration. `mcp-remote` stores its tokens in `~/.mcp-auth` by
default, and `/home/box` is **not** one of the box's four volumes: `/workspace`,
`/home/box/sand-data`, `/var/lib/sand-box-store` and `/home/box/chrome-profile` are. A token in
the default location survives a restart and dies at the next recreate, which a redeploy does, and
the connector would silently go back to waiting for authorization. Putting the store inside
`sand-data` puts it in a volume.

Then, once:

1. Add the connector (Machine Room steps below). Its card goes to `error` after sixty seconds.
2. Read the authorize URL out of the server's `statusDetail` on that card.
3. Open the box's desktop from the console and paste that URL into the box's Chrome. The redirect
   goes to `http://localhost:<port>/oauth/callback`, which is the box's own loopback, so it has to
   be that browser and not one on the Mac.
4. Approve. The tokens land in `/home/box/sand-data/.mcp-auth` and the connector reconnects.

The refresh token is what makes this a one-time step. It is also the thing to remember when
rotating access: revoking that client at Clerk is what removes the box's access, not deleting a
key.

**Before doing step 3, know whose browser that is.** The box's Chrome is a long-lived signed-in
profile in the `titanbot-box-chrome` volume, and it is already signed in to TinyFish: the probe
that measured all of this let `mcp-remote` open its authorize URL, and the box's browser landed on
`accounts.tinyfish.ai` with the page title "My account", not on a sign-in form. The session is in
that profile, and `/home/box/sand-data/chrome-cookie-seed.json` carries the Clerk cookies for it.

That was fine while the console lived on the tailnet. It is a different fact once the console is
public with a password as the only lock: anyone through that password reaches the desktop surface,
and the desktop surface is a browser signed in as Jason wherever that profile is signed in. It is
not a reason to skip Recipe A, and it is a reason to decide deliberately what that profile stays
signed in to. Approving one more OAuth client in it adds a refresh token to the same pile.

## Recipe B: the key, against the REST APIs

If the point is the API key rather than the MCP endpoint, the bridge has to speak to the REST
endpoints, which do take `X-API-Key`. That means a small stdio MCP server that exposes
`search`, `fetch_content` and `run_web_automation` as tools and forwards them to
`api.search.tinyfish.ai`, `api.fetch.tinyfish.ai` and `agent.tinyfish.ai/v1/automation/run-sse`.

**This repo does not have one.** Writing it is maybe eighty lines against the shapes in
`docs.tinyfish.ai/{search-api,fetch-api,agent-api}`, and it is not written today, so this is a
plan and not a measurement. What it buys is the whole point of the key form: no browser step, no
refresh token, a credential that rotates by typing a new one. Its connector entry would be the
shape the rest of this document describes:

    "tinyfish": {
      "command": "node",
      "args": ["/workspace/tinyfish-mcp/main.mjs"],
      "env": { }
    }

with `TINYFISH_API_KEY` declared as an environment variable NAME and its value stored through the
key form.

For completeness, the `mcp-remote` form of a key header, which is what to use for any remote MCP
server that really does take one:

    "args": ["-y", "mcp-remote", "https://example/mcp", "--header", "X-API-Key:${TINYFISH_API_KEY}"]

`mcp-remote` expands `${NAME}` from its own environment, so the value still comes from the secret
store rather than from `connectors.json`. Write it with **no space** after the colon. That is the
form `mcp-remote`'s own README recommends for clients that mangle spaces inside arguments, and it
is required here for a second reason: the Machine Room's argument field splits on whitespace
(`app.js`, `args: String(...).trim().split(/\s+/)`), so `X-API-Key: ${...}` would arrive as two
arguments and the header would be lost.

## The Machine Room steps

**Add the connector.** Global capabilities -> *Plugins, connectors & skills* -> **Add or remove a
connector**:

| field | value |
| --- | --- |
| Name | `tinyfish` |
| Command | `npx` |
| Arguments | `-y mcp-remote https://agent.tinyfish.ai/mcp --transport http-only` |
| Environment variable names | `MCP_REMOTE_CONFIG_DIR` for recipe A, `TINYFISH_API_KEY` for recipe B |

Saving writes `connectors.json` on the box through the relay and calls `refreshMcp`, so the host
relaunches its stdio servers without a container restart. Only NAMES go in that last field; the
form says so, and it is the whole point of the split.

**Store the key.** On the connector's own card, *Credentials for tinyfish* -> one masked input per
name the host reported -> **Store on the host**. That calls `setConnectorSecret`, which writes the
0600 store and never the config file. A blank field leaves whatever the host already holds.

**Remove it.** *Remove this connector* on the card, or the row in the editor. That drops it from
`connectors.json` and re-reads the file. The stored secret is separate: `deleteConnectorSecret`
takes it out of the store.

## Which tools an agent would then see

Not measured, because nothing here authenticated. What TinyFish's MCP server exposes to a signed-in
client today, from this repository's own connection to it:

    search                     fetch_content              run_web_automation
    run_web_automation_async   get_run                    list_runs
    cancel_run                 guide_next_step            create_browser_session
    list_browser_sessions      close_browser_session      batch_status
    batch_cancel               get_wallet                 get_search_usage
    list_fetch_usage

Search and fetch are free per TinyFish's documentation; agent and browser runs are metered against
the wallet, which is why `get_wallet` and the usage tools are on that list at all.

## What this left behind on the box

Nothing. `connectors.json` was read first and restored byte for byte afterwards: sha256
`04f0f8b93419bee5eb4ed5b7c654ad5288c7ef80f565e3f740c0095c44f1f4d5`, 245 bytes, mode 600, identical
before and after. `connector-env-secrets.json` is back to `{"servers":{}}` at 20 bytes. The box's
connector roster reads `localfiles:connected:14`, which is what it read before any of this. The
box was not restarted.
