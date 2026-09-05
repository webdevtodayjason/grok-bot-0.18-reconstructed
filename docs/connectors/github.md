## 1 Options

Research snapshot: 2026-09-05. Sizes below are package payloads, **not** total dependency/cache footprints; no packages were installed and no credentials were accessed.

| Candidate / maintainer | Transport / auth | Install size / latest release | Verdict |
| --- | --- | --- | --- |
| Official remote `github/github-mcp-server`, GitHub | Hosted Streamable HTTP at `https://api.githubcopilot.com/mcp/`; PAT as Bearer, or OAuth. [Auth](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/host-integration.md), [endpoint](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/remote-server.md) | No local GitHub server. Bridge `mcp-remote` by James Geelen: 0.8.3, 2026-08-31, 1,201,316 bytes unpacked excluding dependencies. Hosted deployment version/date is not published by these docs; upstream library release v1.12.0 is 2026-09-03. [npm metadata](https://registry.npmjs.org/mcp-remote), [release](https://github.com/github/github-mcp-server/releases/tag/v1.12.0) | **Choose**, bridged into the host's stdio interface; PAT avoids browser login. |
| Official local Go binary / container, GitHub | `github-mcp-server stdio`; `GITHUB_PERSONAL_ACCESS_TOKEN`; official image `ghcr.io/github/github-mcp-server`. [README](https://github.com/github/github-mcp-server/blob/v1.12.0/README.md) | v1.12.0, 2026-09-03. Linux x86-64 tar.gz 8,265,496 bytes; arm64 7,570,829 bytes, compressed. Installed binary and Docker image sizes not measured. [Asset metadata](https://api.github.com/repos/github/github-mcp-server/releases/tags/v1.12.0) | Valid fallback if operator provisions the matching executable; Docker route cannot run in this box. |
| Archived `@modelcontextprotocol/server-github`, Model Context Protocol project | npm/stdio via `npx -y @modelcontextprotocol/server-github`; `GITHUB_PERSONAL_ACCESS_TOKEN`. [README](https://github.com/modelcontextprotocol/servers-archived/blob/main/src/github/README.md) | 2025.4.8, 2025-04-08; 73,424 bytes unpacked excluding dependencies. npm explicitly marks it unsupported. [Registry](https://registry.npmjs.org/@modelcontextprotocol/server-github) | Reject for new integration: development moved to GitHub's official server. |

**Fine-grained PAT verdict: yes.** GitHub accepts a valid pre-generated PAT for remote authorization; its scope-filtering table explicitly supports fine-grained PATs, with API-enforced permissions. The remote configuration uses `Authorization: Bearer …`. This is documentation-backed, not an authenticated test in this research run. [Host integration](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/host-integration.md), [scope filtering](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/scope-filtering.md), [remote PAT example](https://github.com/github/github-mcp-server/blob/v1.12.0/README.md#remote-github-mcp-server)

## 2 The entry

Use this object as the GitHub connector entry in `connectors.json` under the supplied host contract. It enables repository, issue and PR reads plus the identity tool; all write tools are filtered out. Headers and individual tools are composable. [Server configuration](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/server-configuration.md)

```json
{
  "command": "npx",
  "args": [
    "-y",
    "mcp-remote@0.8.3",
    "https://api.githubcopilot.com/mcp/",
    "--transport",
    "http-only",
    "--header",
    "Authorization:Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}",
    "--header",
    "X-MCP-Toolsets:repos,issues,pull_requests",
    "--header",
    "X-MCP-Tools:get_me",
    "--header",
    "X-MCP-Readonly:true"
  ],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": ""
  }
}
```

The literal `${GITHUB_PERSONAL_ACCESS_TOKEN}` is expanded by `mcp-remote`, not a shell; repeated `--header` and `--transport http-only` are documented options. The bridge version is pinned to the verified npm release. [Bridge README](https://github.com/geelen/mcp-remote#readme), [npm](https://registry.npmjs.org/mcp-remote)

The empty env value is a credential slot: paste the token into Titanbot's console card, which injects the process env. That behavior is supplied by the task's host contract, not a GitHub feature. There are no other env keys in this entry.

## 3 Credentials

- `GITHUB_PERSONAL_ACCESS_TOKEN`: a GitHub PAT. In this remote setup the name is our bridge credential slot, matching the official local server's convention; the remote service receives the header, not the env name. [Local convention](https://github.com/github/github-mcp-server/blob/v1.12.0/README.md), [header interpolation](https://github.com/geelen/mcp-remote#readme)
- Create at [fine-grained token settings](https://github.com/settings/personal-access-tokens/new): Settings → Developer settings → Personal access tokens → Fine-grained tokens. Set expiry, one resource owner and only necessary repositories. Organization approval may be required; pending tokens can only read public resources. [GitHub token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- Minimum for `get_me` is a valid fine-grained PAT with no additional permissions. Public repository reads need no extra private-repository grant. For the intended private-repository workflow, select **Contents: read**, **Issues: read**, **Pull requests: read**, plus the automatically included **Metadata: read**. These are permissions, not classic PAT scope strings. [User endpoint](https://docs.github.com/en/rest/users/users#get-the-authenticated-user), [contents](https://docs.github.com/en/rest/repos/contents#get-repository-content), [issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues), [PRs](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request), [token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- Those baseline grants do not promise every method of every exposed tool: PR `get_status` additionally needs **Commit statuses: read**; organization issue-type listing needs **Issue Types: read**. Issue-field availability also depends on organization features and access. Grant extras only when needed. [Statuses](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference), [issue types](https://docs.github.com/en/rest/orgs/issue-types#list-issue-types-for-an-organization), [issue-field implementation](https://github.com/github/github-mcp-server/blob/v1.12.0/pkg/github/issue_fields.go)
- Fine-grained PAT limitations remain: GitHub's token guide lists Checks API access among gaps; do not promise PR `get_check_runs` works merely because `pull_request_read` is listed. Classic PAT fallback for private repositories uses the broad `repo` scope, and optional organization functions may require `read:org`; it cannot restrict access to selected repositories like a fine-grained token. [Limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [scope declarations](https://github.com/github/github-mcp-server/blob/v1.12.0/README.md#tools)
- Revoke by deleting the token under the same Personal access tokens settings; remove/replace the console credential and restart the connector. Deletion is GitHub's revocation mechanism; restarting is the operational step needed to replace the host-injected env. [Deletion instructions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#deleting-a-personal-access-token)

## 4 Smoke test

1. Start the connector after credential injection, initialize MCP and inspect `tools/list`. Expect `get_me`, the read tools below, and no `create_repository`, `issue_write` or `merge_pull_request`. Remote updates may change the list; read-only filtering overrides explicit tool selection. [Configuration](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/server-configuration.md)
2. First tool call: `get_me` with `{}`. Success is a user object containing the expected account login, numeric ID and profile URL; this establishes identity, not repository authorization. [Implementation](https://github.com/github/github-mcp-server/blob/v1.12.0/pkg/github/context_tools.go)
3. Then call `get_file_contents` with `{"owner":"github","repo":"github-mcp-server","path":"README.md"}`. Expect file content or the server's file/resource response. Repeat against a selected private repository to establish the private grant; a public read alone does not prove it. [Tool definition](https://github.com/github/github-mcp-server/blob/v1.12.0/pkg/github/repositories.go)
4. Invalid/expired/revoked credentials generally yield HTTP 401 or a tool error identifying bad credentials; the MCP wrapper's wording can vary. A valid token lacking resource access can instead yield 403 (`Resource not accessible by personal access token`) or a privacy-preserving 404. Check repository selection, expiry, organization approval and SSO before treating 404 as absence. [Troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api), [SSO policy](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/policies-and-governance.md)

No authenticated smoke test was performed: this assignment forbids reading credentials. The above is the operator's acceptance procedure, not a claim of a successful live connection.

## 5 Tool inventory

Expected tools for **this entry**, derived from the v1.12.0 tool catalog and read-only annotations; actual hosted `tools/list` is authoritative because its deployment is independently updated. This is not the full server's write/admin/Copilot catalog. [Catalog](https://github.com/github/github-mcp-server/blob/v1.12.0/README.md#tools), [annotation snapshots](https://github.com/github/github-mcp-server/tree/v1.12.0/pkg/github/__toolsnaps__), [hosted version relationship](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/remote-server.md)

- `get_me` — authenticated identity.
- `get_commit` — commit details and changes.
- `get_file_contents` — file or directory retrieval.
- `get_latest_release` — most recent release.
- `get_release_by_tag` — release identified by tag.
- `get_tag` — tag details.
- `list_branches` — repository branches.
- `list_commits` — commit history.
- `list_releases` — release history.
- `list_repository_collaborators` — repository collaborators.
- `list_tags` — repository tags.
- `search_code` — code search.
- `search_commits` — commit search.
- `search_repositories` — repository search.
- `get_label` — named repository label.
- `issue_read` — issue data selected by method.
- `list_issue_fields` — repository/organization issue-field definitions.
- `list_issue_types` — organization issue types.
- `list_issues` — filtered issue listing.
- `search_issues` — issue search.
- `list_pull_requests` — filtered PR listing.
- `pull_request_read` — PR details, changes, reviews, comments or status selected by method.
- `search_pull_requests` — PR search.

## 6 Caveats

- **Header controls:** `X-MCP-Toolsets` accepts comma-separated toolsets; empty means defaults and unknown names are silently ignored. `X-MCP-Readonly:true` filters write tools. Local equivalents are `--toolsets` / `GITHUB_TOOLSETS` and `--read-only` / `GITHUB_READ_ONLY`. `X-MCP-Tools` adds individual tools; `X-MCP-Exclude-Tools` excludes tools. [Remote headers](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/remote-server.md), [configuration](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/server-configuration.md)
- **Toolsets available at snapshot:** `context`, `actions`, `code_quality`, `code_security`, `copilot`, `copilot_issue_intents`, `dependabot`, `discussions`, `gists`, `git`, `governance`, `issues`, `labels`, `notifications`, `orgs`, `projects`, `pull_requests`, `repos`, `secret_protection`, `security_advisories`, `stargazers`, `users`; selectors `default` and `all`. Remote also documents `copilot_spaces` and `github_support_docs_search`, and additional remote Copilot tools. `context` supplies identity/team context; this entry explicitly adds only `get_me`. [Local catalog](https://github.com/github/github-mcp-server/blob/v1.12.0/README.md#available-toolsets), [remote catalog](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/remote-server.md)
- **URL controls:** `/mcp/readonly`, `/mcp/x/all/readonly`, or `/mcp/x/{toolset}/readonly`; the path accepts one toolset, so use the header for combinations. Insiders can be selected by `/insiders` or `X-MCP-Insiders:true`; avoid it for this baseline. [Paths](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/remote-server.md#url-path-parameters)
- **Tool visibility is not authorization:** fine-grained PATs do not support classic-scope detection, so tools can be listed but fail at execution. The header limits the server's offered tools; PAT permissions independently limit GitHub API access. [Scope filtering](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/scope-filtering.md)
- **Rate limits:** PAT REST requests normally share a 5,000 requests/hour user limit; search endpoints have tighter limits and secondary limits also apply. GraphQL normally has 5,000 points/hour/user. Obey `Retry-After` / rate reset headers; a tool may make multiple API requests. No separate fixed MCP quota was established by the reviewed sources. [REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- **Host compatibility:** supplied box has Node 22/npx, Python 3 and outbound network; no Docker daemon. Chosen bridge needs no Docker, Go, Python, uv or uvx. Local binary must be provisioned for the box architecture; building it requires Go, whose presence was not specified. uv/uvx availability is unknown but irrelevant to these candidates. [Bridge](https://github.com/geelen/mcp-remote#readme), [binary/Docker instructions](https://github.com/github/github-mcp-server/blob/v1.12.0/README.md#local-github-mcp-server)
- **OAuth:** supported as an alternative, not necessary for the chosen PAT route. Local releases also offer OAuth browser login if no PAT is supplied. Fine-grained tokens are restricted to one owner and remain subject to organization/SSO policies. Remote GitHub Enterprise Server hosting is unsupported; use local server for GHES. [OAuth](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/oauth-login.md), [governance](https://github.com/github/github-mcp-server/blob/v1.12.0/docs/policies-and-governance.md), [token limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

## 7 Sources

- https://github.com/github/github-mcp-server/blob/v1.12.0/README.md
- https://github.com/github/github-mcp-server/blob/v1.12.0/docs/remote-server.md
- https://github.com/github/github-mcp-server/blob/v1.12.0/docs/host-integration.md
- https://github.com/github/github-mcp-server/blob/v1.12.0/docs/server-configuration.md
- https://github.com/github/github-mcp-server/blob/v1.12.0/docs/scope-filtering.md
- https://github.com/github/github-mcp-server/blob/v1.12.0/docs/policies-and-governance.md
- https://github.com/github/github-mcp-server/blob/v1.12.0/docs/oauth-login.md
- https://github.com/github/github-mcp-server/releases/tag/v1.12.0
- https://api.github.com/repos/github/github-mcp-server/releases/tags/v1.12.0
- https://github.com/github/github-mcp-server/tree/v1.12.0/pkg/github/__toolsnaps__
- https://github.com/github/github-mcp-server/blob/v1.12.0/pkg/github/context_tools.go
- https://github.com/github/github-mcp-server/blob/v1.12.0/pkg/github/repositories.go
- https://github.com/github/github-mcp-server/blob/v1.12.0/pkg/github/issue_fields.go
- https://github.com/geelen/mcp-remote#readme
- https://registry.npmjs.org/mcp-remote
- https://registry.npmjs.org/@modelcontextprotocol/server-github
- https://github.com/modelcontextprotocol/servers-archived/blob/main/src/github/README.md
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- https://docs.github.com/en/rest/users/users#get-the-authenticated-user
- https://docs.github.com/en/rest/repos/contents#get-repository-content
- https://docs.github.com/en/rest/issues/issues#list-repository-issues
- https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
- https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference
- https://docs.github.com/en/rest/orgs/issue-types#list-issue-types-for-an-organization
- https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
