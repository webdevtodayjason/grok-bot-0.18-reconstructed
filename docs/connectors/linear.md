## 1 Options

Research snapshot: 2026-09-05. Sizes below are package payloads, **not** total dependency/cache footprints; no packages were installed and no credentials were accessed.

| Candidate / maintainer | Transport / auth | Install size / latest release | Verdict |
| --- | --- | --- | --- |
| Official remote MCP, Linear | Hosted Streamable HTTP at `https://mcp.linear.app/mcp` (read-write) or `https://mcp.linear.app/mcp/readonly` (read tools only). Interactive OAuth 2.1 with dynamic client registration, **or** `Authorization: Bearer <token>` with a Linear API key or OAuth access token. SSE `https://mcp.linear.app/sse` is a deprecated fallback. [MCP docs](https://linear.app/docs/mcp) | No local Linear server. Bridge `mcp-remote` 0.8.3, 2026-08-31, 1,201,316 bytes unpacked excluding dependencies. Hosted MCP version/date is not published; the product launched 2025-05-01. [npm](https://registry.npmjs.org/mcp-remote), [changelog](https://linear.app/changelog/2025-05-01-mcp) | **Choose**, bridged into the host's stdio interface. Linear documents API-key Bearer auth, so this is the preferred official remote + token path. |
| `@tacticlaunch/mcp-linear`, tacticlaunch | Local stdio via `npx -y @tacticlaunch/mcp-linear`; `LINEAR_API_TOKEN` or `--token`. Optional `LINEAR_OAUTH_ACCESS_TOKEN` for managed-child OAuth tools. Node `>=20`. [README](https://github.com/tacticlaunch/mcp-linear/blob/v1.4.3/README.md) | 1.4.3, 2026-08-29, 810,782 bytes unpacked excluding dependencies. GitHub last push 2026-08-29, not archived. [npm](https://registry.npmjs.org/@tacticlaunch/mcp-linear), [release](https://github.com/tacticlaunch/mcp-linear/releases/tag/v1.4.3) | Maintained community stdio fallback if the operator refuses a remote hop. Env name is `LINEAR_API_TOKEN`, not `LINEAR_API_KEY`. Large local tool surface. |
| `linear-mcp-server`, jerhadf | Local stdio via `npx -y linear-mcp-server`; `LINEAR_API_KEY`. [README](https://github.com/jerhadf/linear-mcp-server/blob/main/README.md) | 0.1.0, 2025-02-17, 46,309 bytes unpacked excluding dependencies. Last commit 2025-05-01 is the deprecation notice. [npm](https://registry.npmjs.org/linear-mcp-server), [commit](https://github.com/jerhadf/linear-mcp-server/commit/5e2cb621) | Reject. Author-deprecated in favor of Linear's official remote MCP. |
| `linear-mcp` (unscoped npm) | Local stdio; `LINEAR_ACCESS_TOKEN`. [npm](https://www.npmjs.com/package/linear-mcp) | 1.2.0, 2025-03-08, 179,589 bytes unpacked excluding dependencies. [registry](https://registry.npmjs.org/linear-mcp) | Reject. Unmaintained relative to tacticlaunch and the official remote. |

**API-key Bearer verdict: yes.** Linear's MCP FAQ states the server accepts OAuth tokens and API keys in `Authorization: Bearer <yourtoken>` instead of the interactive flow, including a Read-only personal API key. This is documentation-backed, not an authenticated test in this research run. [FAQ](https://linear.app/docs/mcp)

## 2 The entry

Use this object as the Linear connector entry in `connectors.json` under the supplied host contract. It targets Linear's current Streamable HTTP endpoint. Restrict the API key to **Read** unless writes are intended; switch the URL to `https://mcp.linear.app/mcp/readonly` if write tools must never appear. [MCP docs](https://linear.app/docs/mcp)

```json
{
  "command": "npx",
  "args": [
    "-y",
    "mcp-remote@0.8.3",
    "https://mcp.linear.app/mcp",
    "--transport",
    "http-only",
    "--header",
    "Authorization:Bearer ${LINEAR_API_KEY}"
  ],
  "env": {
    "LINEAR_API_KEY": ""
  }
}
```

The literal `${LINEAR_API_KEY}` is expanded by `mcp-remote`, not a shell. `--transport http-only` matches Linear's primary transport and avoids the deprecated `/sse` path. The bridge version is pinned to the verified npm release. [Bridge README](https://github.com/geelen/mcp-remote#readme), [npm](https://registry.npmjs.org/mcp-remote)

The empty env value is a credential slot: paste the key into Titanbot's console card, which injects the process env. That behavior is supplied by the task's host contract, not a Linear feature. There are no other env keys in this entry. Omitting the header would fall through to mcp-remote's browser OAuth flow, which is disfavored here.

## 3 Credentials

- `LINEAR_API_KEY`: a Linear personal API key. In this remote setup the name is our bridge credential slot; the remote MCP receives the Bearer header, not the env name. Linear's GraphQL API documents personal keys as `Authorization: <API_KEY>` **without** `Bearer`; the MCP FAQ is the source for the Bearer form used here. [MCP FAQ](https://linear.app/docs/mcp), [GraphQL auth](https://linear.app/developers/graphql)
- Create at [Security & access](https://linear.app/settings/account/security): Settings → Account → Security & Access → Personal API keys → New API key. Copy once; Linear will not show it again. Workspace admins can disable member-created keys under Settings → Administration → API → Member API keys. [API keys](https://linear.app/docs/api-and-webhooks), [Security & Access](https://linear.app/docs/security-and-access)
- Permissions on each key: **Read**, **Write**, **Admin**, **Create issues**, **Create comments**, plus optional team restriction. The key also cannot exceed the creating user's workspace access. [API keys](https://linear.app/docs/api-and-webhooks)
- Minimum for the smoke test (`list_teams` / `list_issues` reads): **Read** only. Linear's MCP FAQ recommends a Read-only key for a read-only integration. Write tools on `/mcp` need **Write**, or the narrower **Create issues** / **Create comments** if that is all the agent should do. Do not grant **Admin** unless webhook/admin surfaces are required. [MCP FAQ](https://linear.app/docs/mcp), [API keys](https://linear.app/docs/api-and-webhooks)
- OAuth is not required for this entry. If an operator later uses Linear OAuth instead of a personal key, Linear's scopes are `read` (always present), `write`, `issues:create`, `comments:create`, `timeSchedule:write`, `admin`. Revoke OAuth apps under Authorized applications on the same Security & Access page, or `POST https://api.linear.app/oauth/revoke`. [OAuth](https://linear.app/developers/oauth-2-0-authentication)
- Revoke a personal API key from the same Security & Access page, or from workspace Settings → Administration → API (admins can revoke workspace keys). Then remove/replace the console credential and restart the connector. [API keys](https://linear.app/docs/api-and-webhooks)

## 4 Smoke test

1. Start the connector after credential injection, initialize MCP and inspect `tools/list`. Expect the inventory in §5 (or the read-only subset on `/mcp/readonly`). Linear updates the hosted catalog independently; `tools/list` is authoritative. [MCP docs](https://linear.app/docs/mcp)
2. First tool call: `list_teams` with `{}`. Success is a list of workspace teams (id/name at minimum). That proves the Bearer key is accepted and the user can see teams. [Speakeasy catalog](https://www.speakeasy.com/product/mcp-gateway/catalog/linear)
3. Then call `list_issues` with `{"assignee":"me"}`. Expect the caller's assigned issues. `"me"` is documented on that tool; a public-looking empty list can still be a valid empty inbox. [Speakeasy catalog](https://www.speakeasy.com/product/mcp-gateway/catalog/linear)
4. Invalid/empty/revoked credentials: Linear's GraphQL API returns failures in the `errors` array (check `extensions` for codes such as authentication / `RATELIMITED`). MCP clients wrapping `mcp.linear.app` have reported HTTP 401 and wording like `Authentication required, not authenticated` on `list_issues`. Treat 401 / authentication errors as a bad key; a valid Read-only key calling a write tool is a permission failure, not a missing key. OAuth/mcp-remote cache problems are a different class (`rm -rf ~/.mcp-auth`). [GraphQL errors](https://linear.app/developers/graphql), [rate-limit errors](https://linear.app/developers/rate-limiting), [MCP FAQ](https://linear.app/docs/mcp)

No authenticated smoke test was performed: this assignment forbids reading credentials. The above is the operator's acceptance procedure, not a claim of a successful live connection.

## 5 Tool inventory

Expected tools for **this `/mcp` entry**, from Speakeasy's official Linear MCP catalog snapshot dated 2026-09-03 (31 tools). Hosted `tools/list` can differ; Claude/ChatGPT connector listings also diverge (older `create_issue` names vs current `save_*`, plus extra ChatGPT-only tools). `/mcp/readonly` exposes only read tools. [Speakeasy](https://www.speakeasy.com/product/mcp-gateway/catalog/linear), [Portkey (older names)](https://portkey.ai/docs/integrations/mcp-servers/linear-mcp-server)

- `get_attachment` — attachment content by ID.
- `create_attachment` — attach base64 content to an issue.
- `delete_attachment` — delete an attachment.
- `list_comments` — comments on an issue.
- `save_comment` — create or update a comment.
- `delete_comment` — delete a comment.
- `list_cycles` — cycles for a team.
- `get_document` — document by ID or slug.
- `list_documents` — workspace documents.
- `create_document` — create a document.
- `update_document` — update a document.
- `extract_images` — fetch images embedded in Linear markdown.
- `get_issue` — issue details, attachments, git branch name.
- `list_issues` — filtered issue list; assignee `"me"` or `"null"`.
- `save_issue` — create or update an issue (`title` + `team` on create).
- `list_issue_statuses` — workflow states for a team.
- `get_issue_status` — status by name or ID.
- `list_issue_labels` — issue labels.
- `create_issue_label` — create an issue label.
- `list_projects` — workspace projects.
- `get_project` — project details.
- `save_project` — create or update a project.
- `list_project_labels` — project labels.
- `list_milestones` — milestones in a project.
- `get_milestone` — milestone by ID or name.
- `save_milestone` — create or update a milestone.
- `list_teams` — workspace teams.
- `get_team` — team details.
- `list_users` — workspace users.
- `get_user` — user details.
- `search_documentation` — Linear product docs search.

## 6 Caveats

- **Read-only options:** `https://mcp.linear.app/mcp/readonly` never exposes write tools. Alternatively keep `/mcp` and issue a key with only **Read**. Requesting only the OAuth `read` scope is the third documented path; this entry does not use OAuth. [MCP docs](https://linear.app/docs/mcp)
- **SSE:** `/sse` is deprecated. Do not point new entries there. [MCP FAQ](https://linear.app/docs/mcp)
- **Header vs GraphQL:** MCP wants `Authorization: Bearer <key>`. Direct GraphQL personal-key calls use `Authorization: <key>` without Bearer. Do not mix the two conventions. [MCP FAQ](https://linear.app/docs/mcp), [GraphQL](https://linear.app/developers/graphql)
- **Rate limits (GraphQL API the MCP sits on):** API key 2,500 requests/hour/user (all keys for that user share the bucket) and 3,000,000 complexity points/hour; max single-query complexity 10,000; OAuth apps 5,000 requests/hour and 2,000,000 complexity points/hour. Some endpoints have tighter windows. Over-limit GraphQL responses use `errors.extensions.code = RATELIMITED` (HTTP 400). No separate fixed MCP quota was published in the reviewed Linear MCP page. [Rate limiting](https://linear.app/developers/rate-limiting)
- **Host compatibility:** supplied box has Node 22/npx, Python 3, outbound network; no Docker daemon. Chosen bridge needs no Docker, Go, Python, uv or uvx. tacticlaunch needs Node 20+ (satisfied) and no Docker. uv/uvx availability is unknown and unused by these candidates.
- **OAuth-in-the-box:** works via mcp-remote if the Bearer header is omitted; Linear's default client examples do that. Disfavored here. mcp-remote then stores auth under `~/.mcp-auth` (or `MCP_REMOTE_CONFIG_DIR`). [MCP FAQ](https://linear.app/docs/mcp), [bridge](https://github.com/geelen/mcp-remote#readme)
- **Community stdio:** tacticlaunch is the maintained npm stdio server (`LINEAR_API_TOKEN`). jerhadf's `linear-mcp-server` is deprecated. Neither is official.

## 7 Sources

- https://linear.app/docs/mcp
- https://linear.app/changelog/2025-05-01-mcp
- https://linear.app/docs/api-and-webhooks
- https://linear.app/docs/security-and-access
- https://linear.app/developers/graphql
- https://linear.app/developers/rate-limiting
- https://linear.app/developers/oauth-2-0-authentication
- https://linear.app/settings/account/security
- https://github.com/geelen/mcp-remote#readme
- https://registry.npmjs.org/mcp-remote
- https://www.speakeasy.com/product/mcp-gateway/catalog/linear
- https://portkey.ai/docs/integrations/mcp-servers/linear-mcp-server
- https://github.com/tacticlaunch/mcp-linear/blob/v1.4.3/README.md
- https://github.com/tacticlaunch/mcp-linear/blob/v1.4.3/TOOLS.md
- https://github.com/tacticlaunch/mcp-linear/releases/tag/v1.4.3
- https://registry.npmjs.org/@tacticlaunch/mcp-linear
- https://github.com/jerhadf/linear-mcp-server/blob/main/README.md
- https://registry.npmjs.org/linear-mcp-server
- https://registry.npmjs.org/linear-mcp
