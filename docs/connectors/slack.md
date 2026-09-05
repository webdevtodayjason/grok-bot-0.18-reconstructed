## 1 Options

Research snapshot: 2026-09-05. Sizes are package payloads, **not** total cache footprints; no packages were installed and no credentials were accessed.

This host already has a **Slack listener** (chat platform, console currently Not connected). That is not this connector. The listener binds inbound events to an agent; this connector is outbound MCP tools in the user box. They share a vendor, not a process. [Host isolation](../GAP-ANALYSIS.md) (CP-10: Slack/GitHub channel tokens cannot land in a connector process).

| Candidate / maintainer | Transport / auth | Install size / latest release | Verdict |
| --- | --- | --- | --- |
| Official remote Slack MCP, Slack | Streamable HTTP `https://mcp.slack.com/mcp`. Confidential OAuth (`client_id` + `client_secret`); no Dynamic Client Registration; MCP client must be a registered Slack app with a hardcoded app ID. Partner no-code clients: Claude, Claude Code, Perplexity, Cursor. Metadata advertises Bearer-in-header **after** OAuth; docs do **not** document pasting an `xoxb`/`xoxp` as a standalone Bearer PAT. [Overview](https://docs.slack.dev/ai/slack-mcp-server), [resource metadata](https://mcp.slack.com/.well-known/oauth-protected-resource) | No local Slack server. Bridge `mcp-remote` 0.8.3, 2026-08-31, 1,201,316 bytes unpacked excluding dependencies. Hosted version/date unpublished. [npm](https://registry.npmjs.org/mcp-remote) | Reject for this host: OAuth-in-the-box is disfavored, DCR is unsupported, Titanbot is not a listed partner client. |
| `@modelcontextprotocol/server-slack`, Model Context Protocol project (archived) | npm/stdio via `npx -y @modelcontextprotocol/server-slack`; `SLACK_BOT_TOKEN` (`xoxb-`) + `SLACK_TEAM_ID` (`T…`); optional `SLACK_CHANNEL_IDS`. [README](https://github.com/modelcontextprotocol/servers-archived/blob/main/src/slack/README.md) | 2025.4.25, 2025-04-25; 26,516 bytes unpacked excluding dependencies. npm: "Package no longer supported." Repo archived 2025-05-29. [Registry](https://registry.npmjs.org/@modelcontextprotocol/server-slack) | Reject for new integration: archived and deprecated. |
| `slack-mcp-server`, Dmitry Korotovsky (`korotovsky/slack-mcp-server`) | npm/stdio: `npx -y slack-mcp-server@1.3.0 --transport stdio`. Token env: `SLACK_MCP_XOXP_TOKEN` (`xoxp-`), `SLACK_MCP_XOXB_TOKEN` (`xoxb-`), or stealth `SLACK_MCP_XOXC_TOKEN`+`SLACK_MCP_XOXD_TOKEN` (browser session). Priority `xoxp` > `xoxb` > `xoxc`/`xoxd`. Docker image exists; not usable here. [README](https://github.com/korotovsky/slack-mcp-server/blob/master/README.md), [auth](https://github.com/korotovsky/slack-mcp-server/blob/master/docs/01-authentication-setup.md), [npx](https://github.com/korotovsky/slack-mcp-server/blob/master/docs/03-configuration-and-usage.md) | Wrapper 1.3.0, 2026-05-14, 36,689 bytes unpacked; optional `slack-mcp-server-linux-amd64@1.3.0` 16,699,937 bytes unpacked (GitHub linux-amd64 asset 16,699,576 bytes). Master commit same day; GitHub release v1.3.0. [npm](https://registry.npmjs.org/slack-mcp-server), [platform pkg](https://registry.npmjs.org/slack-mcp-server-linux-amd64), [release](https://github.com/korotovsky/slack-mcp-server/releases/tag/v1.3.0) | **Choose.** Maintained stdio npm server with a pasteable token env. Prefer `xoxp` so search works. |

**Listener vs tools (do not conflate).** Console listener Connect is `connectChannel {platform:"slack", token}` — one token string, labelled "Slack token" in the dashboard. The shared channel-manifest label for Slack is "app token." [Dashboard](../../ui/machine-room/app.js), [manifest](../../source/shared/channels.ts), [gateway](../../source/host/host-gateway-api.ts)

A real Slack **inbound** bot (Socket Mode, typical for a chat-platform bind) needs **both**: app-level token `xapp-` (`connections:write`, `apps.connections.open`) **and** bot token `xoxb-`, Socket Mode enabled, plus bot event subscriptions (at least `app_mention`; message/reaction events for routine triggers). Bolt env names: `SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN`. [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode), [tokens](https://docs.slack.dev/authentication/tokens)

**One Slack app can serve both planes** (Socket Mode + bot scopes for the listener; User Token Scopes for this MCP entry). Tokens still get pasted twice: listener via Connect, connector via the connector card. Do not reuse stealth `xoxc`/`xoxd` as a listener token.

## 2 The entry

Use this object as the Slack connector entry in `connectors.json`. Posting stays off (server default). Pin the verified npm release. `--transport stdio` is required. [npx config](https://github.com/korotovsky/slack-mcp-server/blob/master/docs/03-configuration-and-usage.md)

```json
{
  "command": "npx",
  "args": [
    "-y",
    "slack-mcp-server@1.3.0",
    "--transport",
    "stdio"
  ],
  "env": {
    "SLACK_MCP_XOXP_TOKEN": ""
  }
}
```

Empty env value is a credential slot: paste the user OAuth token into Titanbot's console card; the host injects process env. That behavior is the host contract, not a Slack feature. Do not put an `xoxb` in this slot unless you accept no `search.messages`. Alternative env names (`SLACK_MCP_XOXB_TOKEN`, `SLACK_MCP_XOXC_TOKEN`, `SLACK_MCP_XOXD_TOKEN`) are documented on the server; they are not in this entry.

## 3 Credentials

- `SLACK_MCP_XOXP_TOKEN`: Slack **user** OAuth token (`xoxp-`). Acts as the installing user. [Tokens](https://docs.slack.dev/authentication/tokens), [server auth](https://github.com/korotovsky/slack-mcp-server/blob/master/docs/01-authentication-setup.md)
- Create at [api.slack.com/apps](https://api.slack.com/apps): Create New App → From scratch (or the server's user-scope manifest). **OAuth & Permissions → User Token Scopes**, then **Install to Workspace**. Copy **User OAuth Token**.
- Minimum for the smoke test (`channels_list` of public channels): `channels:read`. For the intended read+search workflow add: `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`, `search:read`. Usergroups tools need `usergroups:read` (and `usergroups:write` to mutate). Enable posting later with `chat:write` **and** `SLACK_MCP_ADD_MESSAGE_TOOL=true` (configuration, not a credential). DMs as the user also want `im:write` / `mpim:write`. `channels:write` is listed by the server for joining public channels. [Auth doc](https://github.com/korotovsky/slack-mcp-server/blob/master/docs/01-authentication-setup.md)
- Bot-token fallback `SLACK_MCP_XOXB_TOKEN`: same history/read scopes on **Bot Token Scopes**, but replace `search:read` with `search:read.public` and `channels:write` with `channels:join` + `channels:manage`. Invite the bot to every channel it should read. `conversations_search_messages` is unavailable on `xoxb`.
- Stealth `xoxc`+`xoxd`: extracted from a logged-in Slack browser session; no app install. Session cookies, not OAuth. Do not use as the Titanbot default.
- Revoke: app settings → OAuth & Permissions → revoke/reinstall, or uninstall the app from the workspace; `auth.revoke` also invalidates a token. Then clear/replace the console credential and restart the connector. Listener disconnect is a separate `disconnectChannel`. [auth.revoke](https://docs.slack.dev/reference/methods/auth.revoke.md), [tokens](https://docs.slack.dev/authentication/tokens)

## 4 Smoke test

No authenticated smoke test was performed (this assignment forbids reading credentials). Operator procedure:

1. Inject `SLACK_MCP_XOXP_TOKEN`, start the connector, MCP `initialize`, `tools/list`. Expect the read tools in §5. Do **not** expect `conversations_add_message`, `reactions_add`, `reactions_remove`, `conversations_mark`, or `attachment_get_data` unless their enable env is set. With `xoxp`, do not expect `saved_*` (those need `xoxc`/`xoxd`).
2. First tool: `channels_list` with `{"channel_types":"public_channel","limit":5}`. Success is a CSV directory of channels (id, name, topic/purpose, memberCount). [Tool](https://github.com/korotovsky/slack-mcp-server/blob/master/README.md#5-channels_list)
3. Optional second call: `conversations_search_messages` with a known public-channel keyword. Proves `search:read`. Skip if using `xoxb`.
4. Auth failure: Slack `auth.test` returns `{"ok":false,"error":"invalid_auth"}` for a bad token and `not_authed` when none is sent; `token_revoked` / `account_inactive` / `token_expired` for other dead credentials. The MCP wrapper surfaces that as a tool/error payload (wording can vary). Missing scope is `missing_scope`. [auth.test](https://docs.slack.dev/reference/methods/auth.test)

## 5 Tool inventory

Expected for **this `xoxp` entry** from the v1.3.0 README. `tools/list` is authoritative after spawn. Write tools stay unregistered until their env flags. [README tools](https://github.com/korotovsky/slack-mcp-server/blob/master/README.md#tools)

- `channels_list` — list public/private/IM/MPIM channels (needs cache for `#name` lookup).
- `conversations_history` — channel/DM history by id or `#name`/`@user`.
- `conversations_replies` — thread by `channel_id` + `thread_ts`.
- `conversations_search_messages` — `search.messages` filters (not on `xoxb`).
- `conversations_unreads` — unread summary; slower fallback on `xoxp` than on browser tokens; not on `xoxb`.
- `users_search` — name/email/display match against the users cache (OAuth path).
- `usergroups_list` / `usergroups_me` — list groups; list/join/leave self.
- `usergroups_create` / `usergroups_update` / `usergroups_users_update` — mutate groups (`usergroups:write`).
- `conversations_add_message` — post; off unless `SLACK_MCP_ADD_MESSAGE_TOOL` or listed in `SLACK_MCP_ENABLED_TOOLS`.
- `reactions_add` / `reactions_remove` — off unless `SLACK_MCP_REACTION_TOOL`.
- `conversations_mark` — mark read; off unless `SLACK_MCP_MARK_TOOL`.
- `attachment_get_data` — off unless `SLACK_MCP_ATTACHMENT_TOOL`.
- `saved_list` / `saved_update` / `saved_clear_completed` — Save for Later; `xoxc`/`xoxd` only.

Resources (not tools): `slack://<workspace>/channels`, `slack://<workspace>/users`.

## 6 Caveats

- **Listener ≠ connector.** Connecting Slack in the console does not start this MCP server. Event routines need the listener; model tools need this entry. One app, two paste sites, isolated env namespaces.
- **Official remote MCP** exists (GA 2026-02-17) and is the right path for Cursor/Claude. It is OAuth, admin-approved, user-token scopes such as `search:read.public`. Tool names there (`slack_search_public`, `slack_send_message`, `slack_read_channel`, `slack_get_file_upload_url`, …) are **not** this server's names. [GA](https://docs.slack.dev/changelog/2026/02/17/slack-mcp/), [overview](https://docs.slack.dev/ai/slack-mcp-server), [skills plugin](https://github.com/slackapi/slack-skills-plugin)
- **Rate limits:** this server calls Slack Web API. Typical: Tier 2 `20+/min` (`conversations.list`), Tier 3 `50+/min` (many history/list methods), `chat.postMessage` special ~1/sec/channel. HTTP 429 + `Retry-After`. Non-Marketplace commercially distributed apps face tighter `conversations.history` / `conversations.replies` limits since 2025-05-29. No separate MCP quota documented for korotovsky. [Web API limits](https://docs.slack.dev/apis/web-api/rate-limits), [official MCP tool tiers](https://docs.slack.dev/ai/slack-mcp-server#rate-limits)
- **Cache:** without users+channels cache, `#name`/`@handle` lookup and `channels_list` degrade. Linux default `~/.cache/slack-mcp-server/`.
- **Host box:** Node 22/npx, Python 3, outbound network; **no Docker**. Chosen path uses npx + optional Linux binary; **no uv/uvx** (availability unknown, unused). Docker/DXT routes are documented but unusable here.
- **OAuth:** creating the `xoxp` is a one-time install in the browser on api.slack.com, then paste. No in-box OAuth. Stealth mode avoids the app but uses session cookies.
- **Safety:** posting/reactions/mark-read are off until you set configuration env (non-empty values, not credential slots).

## 7 Sources

- https://docs.slack.dev/ai/slack-mcp-server
- https://docs.slack.dev/changelog/2026/02/17/slack-mcp/
- https://mcp.slack.com/.well-known/oauth-protected-resource
- https://mcp.slack.com/.well-known/oauth-authorization-server
- https://github.com/slackapi/slack-skills-plugin
- https://github.com/korotovsky/slack-mcp-server/blob/master/README.md
- https://github.com/korotovsky/slack-mcp-server/blob/master/docs/01-authentication-setup.md
- https://github.com/korotovsky/slack-mcp-server/blob/master/docs/03-configuration-and-usage.md
- https://github.com/korotovsky/slack-mcp-server/releases/tag/v1.3.0
- https://registry.npmjs.org/slack-mcp-server
- https://registry.npmjs.org/slack-mcp-server-linux-amd64
- https://registry.npmjs.org/@modelcontextprotocol/server-slack
- https://github.com/modelcontextprotocol/servers-archived/blob/main/src/slack/README.md
- https://docs.slack.dev/authentication/tokens
- https://docs.slack.dev/apis/events-api/using-socket-mode
- https://docs.slack.dev/reference/methods/auth.test
- https://docs.slack.dev/reference/methods/auth.revoke.md
- https://docs.slack.dev/apis/web-api/rate-limits
- https://registry.npmjs.org/mcp-remote
- https://api.slack.com/apps
