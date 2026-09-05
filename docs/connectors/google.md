## 1 Options

Research snapshot: 2026-09-05. Sizes below are package payloads, **not** total dependency/cache footprints; no packages were installed and no credentials were accessed. There is no long-lived Gmail/Docs PAT. Official remote MCP accepts a short-lived OAuth **access** token as `Authorization: Bearer`, not a durable Titanbot credential. [Gmail tool curl](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/get_message), [Cloud MCP auth](https://docs.cloud.google.com/mcp/authenticate-mcp)

| Candidate / maintainer | Transport / auth | Install size / latest release | Verdict |
| --- | --- | --- | --- |
| Official remote Gmail + Docs MCP, Google | HTTP at `https://gmailmcp.googleapis.com/mcp/v1` and `https://docsmcp.googleapis.com/mcp/v1`. OAuth 2.0 client ID/secret + user consent. Bearer access tokens (~1h) also documented. No DCR. Developer Preview. [Configure](https://developers.google.com/workspace/guides/configure-mcp-servers), [DCR](https://docs.cloud.google.com/mcp/authenticate-mcp) | No local Google server. Bridge `mcp-remote` 0.8.3, 2026-08-31, 1,201,316 bytes unpacked excluding dependencies. [npm](https://registry.npmjs.org/mcp-remote) | Reject as the Titanbot entry: two product endpoints, no durable token, OAuth-in-the-box or hourly token refresh. Prefer for hosts that speak MCP HTTP OAuth natively. |
| `workspace-mcp` / taylorwilsdon/google_workspace_mcp | stdio (legacy) or streamable HTTP. OAuth client ID/secret + consent, or service-account JSON + domain-wide delegation. Launch via `uvx workspace-mcp`. Python ≥3.10. [README](https://github.com/taylorwilsdon/google_workspace_mcp/blob/main/README.md), [quick start](https://workspacemcp.com/quick-start), [DWD](https://workspacemcp.com/docs) | v1.25.2, 2026-08-28. Wheel 440,785 bytes; sdist 428,934 bytes, excluding dependencies. [PyPI](https://pypi.org/pypi/workspace-mcp/json), [release](https://github.com/taylorwilsdon/google_workspace_mcp/releases/tag/v1.25.2) | Strongest community server and the DWD/no-consent path. Not chosen: recommended install is `uvx`, and uv/uvx availability on this box is unknown. Docker image exists; this box has no Docker daemon. |
| `google-workspace-mcp-server`, nityeshaga / EveryInc | npm/stdio via `npx`; `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. Consent once (OAuth Playground), then the process refreshes access tokens. [README](https://github.com/EveryInc/google-workspace-mcp-server) | 1.4.3, 2026-03-10, 353,797 bytes unpacked excluding dependencies. [npm](https://registry.npmjs.org/google-workspace-mcp-server) | **Choose.** One stdio process covers Gmail and Docs, matches the host's npx contract, and uses a durable token env instead of a browser at spawn. |
| `@googleworkspace/developer-mcp`, Google Workspace GitHub org | npx stdio; no Gmail/Docs user data — Workspace **documentation** search only. Archived 2025-11-19. [repo](https://github.com/googleworkspace/developer-mcp) | 0.7.1, 2025-09-08, 24,468 bytes unpacked. [npm](https://registry.npmjs.org/@googleworkspace/developer-mcp) | Reject: wrong product; archived. |
| `gws-mcp-server` wrapping `@googleworkspace/cli` | npx stdio over the `gws` CLI; requires `gws auth login` (browser) and a global CLI. [Libraries.io](https://libraries.io/npm/gws-mcp-server) | 0.4.0, 2026-07-08, 142,084 bytes unpacked. CLI `@googleworkspace/cli` 0.22.5, 2026-03-31. [npm gws](https://registry.npmjs.org/gws-mcp-server), [npm cli](https://registry.npmjs.org/@googleworkspace/cli) | Reject: extra global CLI plus a login flow this box cannot keep. |

## 2 The entry

Use this object as the Google connector entry in `connectors.json` under the supplied host contract. Empty env values are credential slots: paste into Titanbot's console card, which injects process env. No real secrets belong in the file.

```json
{
  "command": "npx",
  "args": ["-y", "google-workspace-mcp-server@1.4.3"],
  "env": {
    "GOOGLE_CLIENT_ID": "",
    "GOOGLE_CLIENT_SECRET": "",
    "GOOGLE_REFRESH_TOKEN": ""
  }
}
```

The package is pinned to the verified npm release. The server reads those three env names and uses the refresh token to mint access tokens at runtime. [README](https://github.com/EveryInc/google-workspace-mcp-server), [npm](https://registry.npmjs.org/google-workspace-mcp-server)

## 3 Credentials

Least painful flow for this box (Linux container; only browser is agent Chrome; localhost OAuth callbacks inside the box are a poor fit): **do consent once against Google's OAuth Playground, not against a loopback port in the container.** Agent Chrome can open Cloud Console and Playground. After the refresh token is pasted, spawn needs no browser. [Playground](https://developers.google.com/oauthplayground/), [README setup](https://github.com/EveryInc/google-workspace-mcp-server)

1. Create a Google Cloud project. Enable **Gmail API**, **Google Docs API**, and **Google Drive API** (Docs tools sit on Drive IDs). [Create a project](https://developers.google.com/workspace/guides/create-project), [Docs MCP APIs](https://developers.google.com/workspace/docs/api/guides/configure-mcp-server)
2. Configure the OAuth consent screen. Audience **Internal** for a Workspace domain (no test-user list). **External** for consumer Gmail; add the operator as a test user until the app is verified. [Gmail MCP consent](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)
3. Create an OAuth **Web application** client. Authorized redirect URI: `https://developers.google.com/oauthplayground`. Copy client ID and secret. [README](https://github.com/EveryInc/google-workspace-mcp-server)
4. In [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/): gear → **Use your own OAuth credentials** → paste ID/secret. Select the scopes below → **Authorize APIs** → sign in → **Exchange authorization code for tokens** → copy the **Refresh Token**, not the access token.

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: OAuth client from APIs & Services → Credentials. [Google Auth Platform clients](https://console.cloud.google.com/auth/clients/create)
- `GOOGLE_REFRESH_TOKEN`: long-lived token from the Playground exchange. The server refreshes access tokens from this; a revoked refresh token looks like an expired-access error until replaced. [README troubleshooting](https://github.com/EveryInc/google-workspace-mcp-server)

**Minimum scopes for reading Gmail and reading/writing Docs** (Playground + consent screen). Official Gmail MCP also lists `gmail.compose` because it drafts; this chosen server's Gmail tools are read + draft, so include compose if you want `gmail_create_draft`. [Official Gmail scopes](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server), [Official Docs scopes](https://developers.google.com/workspace/docs/api/guides/configure-mcp-server), [get_message scopes](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/get_message)

- Gmail read: `https://www.googleapis.com/auth/gmail.readonly`
- Gmail drafts (this server): `https://www.googleapis.com/auth/gmail.compose`
- Docs read + write: `https://www.googleapis.com/auth/documents` (covers read/write; official Docs MCP also lists `documents.readonly`)
- Drive (Docs file IDs): `https://www.googleapis.com/auth/drive.file` plus `https://www.googleapis.com/auth/drive.readonly` as listed by official Docs MCP. The npm README uses the broader `https://www.googleapis.com/auth/drive` for its Drive tools; grant `drive` only if you will use those Drive tools.

`gmail.readonly` is a **restricted** Gmail scope. External/production apps need Google's restricted-scope verification; Internal Workspace apps do not. [Restricted scopes](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

**Service account + domain-wide delegation does avoid per-user consent for a Workspace domain**, as 2LO impersonation: Admin console → Security → Access and data control → API Controls → Domain-wide delegation, authorize the **numeric** service-account client ID with the same scopes, then impersonate `user@domain` via JWT `sub`. Not available for consumer `@gmail.com`. Official remote Workspace MCP docs do **not** document this path. This chosen npm server does **not** document DWD; use `workspace-mcp` env `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` or `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` plus `USER_GOOGLE_EMAIL` (optional `DWD_ALLOWED_DOMAINS`) if you need it. [DWD](https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority), [Admin DWD](https://support.google.com/a/answer/162106), [workspace-mcp DWD](https://workspacemcp.com/docs)

**Revoke:** user → [Google Account third-party access](https://myaccount.google.com/permissions) and remove the app; or POST the token to Google's revoke endpoint. Delete or rotate the OAuth client under Credentials. For DWD, remove the client ID from Domain-wide delegation. Then replace/clear the Titanbot console credentials and restart the connector. [Revoke](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke)

## 4 Smoke test

No authenticated smoke test was performed: this assignment forbids reading credentials. Operator acceptance:

1. After credential injection, initialize MCP and `tools/list`. Expect the Gmail/Docs names in §5 (plus Sheets/Drive/Calendar extras this package also registers).
2. First call: `gmail_list_labels` with `{}`. Success is a list of label objects with `id` and `name` (system labels such as `INBOX` / `UNREAD`). Needs no message or doc ID. [README](https://github.com/EveryInc/google-workspace-mcp-server)
3. Then `gmail_list_messages` with a query such as `{"q":"is:unread","maxResults":5}` (parameter names follow the live tool schema). Success is message IDs; follow with `gmail_get_message` on one ID and expect subject/snippet/body fields.
4. Docs write/read: `docs_create_document` then `docs_get_document` with that ID; expect title and body content. Official remote equivalent is `read_doc` / `update_doc`. [Docs MCP test](https://developers.google.com/workspace/docs/api/guides/configure-mcp-server)

Auth failure: missing/invalid client or refresh token typically yields Google `401` / `invalid_grant` / "Access token expired" (README: re-run Playground if the refresh token was revoked). Missing scope or API not enabled: `403` insufficient permissions. Unverified External app: Playground/consent "app not verified" until Advanced → continue, or add test users. [README](https://github.com/EveryInc/google-workspace-mcp-server), [Gmail errors](https://developers.google.com/workspace/gmail/api/guides/handle-errors)

## 5 Tool inventory

Chosen package 1.4.3 as documented in its README (authoritative `tools/list` may add fields). Official remote names differ and are listed after for comparison.

**Gmail:** `gmail_list_messages` — list/search messages; `gmail_get_message` — full message; `gmail_list_threads` — threads; `gmail_get_thread` — thread messages; `gmail_list_labels` — labels; `gmail_create_draft` — draft, not send; `gmail_list_attachments` — attachment list; `gmail_get_attachment` — download attachment.

**Docs:** `docs_get_document` — read by ID; `docs_create_document` — create; `docs_batch_update` — insert/update/delete text, formatting, images, tables.

**Also registered (same process):** Sheets `sheets_get_spreadsheet`, `sheets_get_values`, `sheets_batch_get_values`, `sheets_update_values`, `sheets_append_values`, `sheets_create_spreadsheet`, `sheets_batch_update`, `sheets_clear_values`, `sheets_duplicate_sheet`; Drive `drive_get_file`, `drive_list_files`, `drive_search_files`, `drive_copy_file`, `drive_list_comments`, `drive_create_comment`, `drive_reply_to_comment`, `drive_resolve_comment`, `drive_delete_comment`; Calendar `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`, `calendar_freebusy_query`. [README](https://github.com/EveryInc/google-workspace-mcp-server)

**Official remote (not this entry):** Gmail `create_draft`, `get_message`, `get_thread`, `label_message`, `label_thread`, `list_drafts`, `list_labels`, `search_threads`, `unlabel_message`, `unlabel_thread`. Docs `read_doc`, `update_doc`. The Gmail configure page omits `get_message`; the product tool list and MCP reference include it. [Supported products](https://developers.google.com/workspace/guides/configure-mcp-servers#support-products)

## 6 Caveats

- **OAuth is required** for user Gmail/Docs on every candidate except Workspace-domain DWD (community `workspace-mcp` only). Official remote does not support Dynamic Client Registration or Client ID Metadata Documents. [Cloud MCP limitations](https://docs.cloud.google.com/mcp/authenticate-mcp)
- **Bearer on official MCP** is an OAuth access token (default ~1 hour, extendable up to 12 hours via `gcloud` lifetime flags in Cloud MCP docs). API keys are for services that do not require a principal; Gmail/Docs do. [Set up auth](https://docs.cloud.google.com/mcp/set-up-authentication-mcp-servers)
- **Rate limits (Gmail API / Gmail MCP, new projects from 2026-05-01):** 1,200,000 quota units/min/project and 6,000/min/user/project; daily billing threshold 80,000,000 units/project. MCP examples: `list_labels` 1, `search_threads` 10, `get_thread` 40, `create_draft` 10. REST `messages.get` is 20 units. Older projects that used the API Nov 2025–Apr 2026 keep prior quotas. [Gmail quotas](https://developers.google.com/workspace/gmail/api/reference/quota)
- **Docs MCP:** `read_doc` costs 1 read request; `update_doc` 1 write request. Numeric project/user RPM figures were not published as numbers on the Docs limits page at this snapshot (table headers only). 429 → exponential backoff. [Docs limits](https://developers.google.com/workspace/docs/api/limits)
- **Box:** Node 22/npx, python3, outbound network; no Docker. Chosen entry needs none of Docker, uv, or uvx. `workspace-mcp` wants `uvx` (unknown here) or `pip install workspace-mcp` (pip presence unknown). Official remote via `mcp-remote` would need either a 1h Bearer or OAuth with `--static-oauth-client-info` because Google rejects DCR; loopback OAuth in the container is the disfavored agent-Chrome path (`--device-code` only if the authorization server advertises a device endpoint, which Workspace MCP docs do not mention). [mcp-remote](https://www.npmjs.com/package/mcp-remote)
- **Prompt injection:** mail and docs are untrusted input; Google documents this for the official MCP servers. [Gmail MCP security](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)
- Official Workspace MCP is **Developer Preview** (Workspace Developer Preview Program). [Configure](https://developers.google.com/workspace/guides/configure-mcp-servers)

## 7 Sources

- https://developers.google.com/workspace/guides/configure-mcp-servers
- https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server
- https://developers.google.com/workspace/gmail/api/reference/mcp
- https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/get_message
- https://developers.google.com/workspace/gmail/api/reference/quota
- https://developers.google.com/workspace/docs/api/guides/configure-mcp-server
- https://developers.google.com/workspace/docs/api/reference/mcp
- https://developers.google.com/workspace/docs/api/limits
- https://docs.cloud.google.com/mcp/overview
- https://docs.cloud.google.com/mcp/authenticate-mcp
- https://docs.cloud.google.com/mcp/set-up-authentication-mcp-servers
- https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html
- https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority
- https://support.google.com/a/answer/162106
- https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- https://developers.google.com/oauthplayground/
- https://myaccount.google.com/permissions
- https://github.com/taylorwilsdon/google_workspace_mcp/blob/main/README.md
- https://github.com/taylorwilsdon/google_workspace_mcp/releases/tag/v1.25.2
- https://pypi.org/pypi/workspace-mcp/json
- https://workspacemcp.com/quick-start
- https://workspacemcp.com/docs
- https://github.com/EveryInc/google-workspace-mcp-server
- https://registry.npmjs.org/google-workspace-mcp-server
- https://github.com/googleworkspace/developer-mcp
- https://registry.npmjs.org/@googleworkspace/developer-mcp
- https://registry.npmjs.org/gws-mcp-server
- https://registry.npmjs.org/@googleworkspace/cli
- https://registry.npmjs.org/mcp-remote
- https://www.npmjs.com/package/mcp-remote
