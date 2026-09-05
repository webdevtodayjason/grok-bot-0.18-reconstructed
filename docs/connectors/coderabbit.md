## 1 Options

Research snapshot: 2026-09-05. Sizes are published payloads; no packages were installed and no credentials were accessed.

| Candidate / maintainer | Transport / auth | Install size / latest release | Verdict |
| --- | --- | --- | --- |
| Official CodeRabbit CLI (`coderabbit` / `cr`), CodeRabbit | Native binary, not MCP. Browser OAuth (`cr auth login`) or **Agentic API key** (`--api-key`) for headless. [CLI](https://docs.coderabbit.ai/cli/index.md), [headless](https://docs.coderabbit.ai/cli/headless-cli-integration.md), [reference](https://docs.coderabbit.ai/cli/reference.md) | Latest **0.7.6** (2026-09-04). Linux x64 zip **37,239,535** bytes (`https://cli.coderabbit.ai/releases/0.7.6/coderabbit-linux-x64.zip`). Homebrew cask also 0.7.6. [VERSION](https://cli.coderabbit.ai/releases/latest/VERSION), [changelog](https://docs.coderabbit.ai/changelog.md), [cask API](https://formulae.brew.sh/api/cask/coderabbit.json) | **Choose as agent skill**, not a connector. Official path for local/agent reviews; runs headless in a container with an Agentic API key. |
| Official CodeRabbit as MCP **client** | CodeRabbit consumes other MCP servers during PR review. Not a server Titanbot can spawn. [Integrate MCP](https://docs.coderabbit.ai/integrations/mcp-servers.md), [KB](https://docs.coderabbit.ai/knowledge-base/mcp-context.md) | N/A | Reject for Titanbot connectors. Wrong direction. |
| `coderabbitai-mcp` npm, bradthebeeble (README author: "Claude Code") | stdio via `npx coderabbitai-mcp@latest`; env `GITHUB_PAT` (GitHub PAT, not CodeRabbit). Reads existing CodeRabbit comments on GitHub PRs. [README](https://github.com/bradthebeeble/coderabbitai-mcp), [npm](https://registry.npmjs.org/coderabbitai-mcp) | 1.1.1, 2025-06-29; unpacked **138,466** bytes excluding deps. Last git push 2025-07-01. | Reject: unofficial, inactive, GitHub-only, does not run CodeRabbit reviews. |
| `hongkongkiwi/coderabbit-mcp-integration` | Clone + `node dist/cli.js`; `CODERABBIT_API_KEY` + `GITHUB_TOKEN`. Not on npm. [README](https://github.com/hongkongkiwi/coderabbit-mcp-integration) | Last push 2025-09-03; 0 stars. Uses deprecated `/v1/report.generate`. | Reject: unmaintained, not npx-installable. |
| `eHour/coderabbitai-github-mcp` (`mcp-coderabbit`) | GitHub PAT stdio; PR-comment workflow. [README](https://github.com/eHour/coderabbitai-github-mcp) | Archived 2026-06-18. `mcp-coderabbit` is not on npm. | Reject: archived. |
| npm `coderabbit` | N/A | `0.0.1-security.1` security holding package. [registry](https://registry.npmjs.org/coderabbit) | Never `npx coderabbit`. |

No official remote MCP URL or Bearer MCP server exists in CodeRabbit docs or the `coderabbitai` GitHub org.

## 2 The entry

**Do not add CodeRabbit to `connectors.json`.** There is no MCP server to spawn. The chosen integration is the official CLI as an agent skill.

Install on the Linux box (needs `curl` and `unzip`; defaults to `~/.local/bin`):

```bash
CI=1 curl -fsSL https://cli.coderabbit.ai/install.sh | sh
```

`CI=1` skips the post-install browser prompt. `CODERABBIT_API_KEY` in the installer env also skips that prompt; it does **not** by itself authenticate later reviews. [install.sh](https://cli.coderabbit.ai/install.sh)

Skill for agents (optional; wraps the same CLI):

```bash
npx skills add coderabbitai/skills -g
```

or interactive `coderabbit skills`. Non-interactive `coderabbit skills` does not write skill files. [skills](https://docs.coderabbit.ai/cli/skills.md), [repo](https://github.com/coderabbitai/skills)

Headless review (pass the key every time; box storage is ephemeral):

```bash
cr review --agent --api-key "$CODERABBIT_API_KEY"
# EU accounts:
cr review --agent --region eu --api-key "$CODERABBIT_API_KEY"
```

`--region` on `review` is rejected unless `--api-key` is also present. [reference](https://docs.coderabbit.ai/cli/reference.md)

There is no connectors.json JSON for this service.

## 3 Credentials

- `CODERABBIT_API_KEY`: convention from the headless guide for an **Agentic API key** (prefix shown in docs as `cr-************`). Pass it as `--api-key`; the CLI does not document auto-reading this env on `review`. A stored login from `cr auth login --api-key` is reused later, but ephemeral boxes should pass the flag each run. [headless](https://docs.coderabbit.ai/cli/headless-cli-integration.md)
- Create at [US API Keys](https://app.coderabbit.ai/settings/api-keys) or [EU API Keys](https://app.eu.coderabbit.ai/settings/api-keys): generate an **Agentic** key for the org that should bill CLI reviews. Requires an assigned seat. User/workspace/legacy org keys are a different product; the CLI rejects unsupported key types with a message that user API keys are not supported. Agentic keys cannot call Enterprise management APIs. [headless](https://docs.coderabbit.ai/cli/headless-cli-integration.md), [API](https://docs.coderabbit.ai/api/index.md)
- Minimum scopes: none published as OAuth scope strings. The key is org-bound. CLI reviews use that org and the assigned user's plan allowance first.
- Browser alternative: `cr auth login` opens a browser (US default; `--region eu` for EU). Disfavored in this box. `cr auth login --agent` is still browser OAuth with JSON events, not API-key login. [reference](https://docs.coderabbit.ai/cli/reference.md)
- Revoke: delete the key on the same API Keys page. CodeRabbit audit logs record `api_key_delete`. Then `cr auth logout` if a local session was stored. [audit logs](https://docs.coderabbit.ai/management/audit-logs.md)

Do not paste GitHub PATs as CodeRabbit credentials. The unofficial MCP's `GITHUB_PAT` is unrelated.

## 4 Smoke test

No live auth was performed.

1. `coderabbit --version` — expect `0.7.6` or newer (`--agent` needs ≥ 0.4.0). [skill](https://github.com/coderabbitai/skills/blob/main/skills/code-review/SKILL.md)
2. First cheap call: `cr auth status --agent`. Success is structured JSON showing an authenticated session/region. Then `cr doctor` (exit 1 if any check fails): runtime, local storage, auth, Git repo, backend HTTPS, WebSocket. [reference](https://docs.coderabbit.ai/cli/reference.md)
3. From an initialized Git worktree with a small tracked diff: `cr review --agent --api-key "$CODERABBIT_API_KEY"`. Good: NDJSON on stdout, one object per line; `type` values include `review_context`, `status`, `heartbeat`, `finding`, `complete` (and `error` on failure). A `finding` has `severity` (`critical`/`major`/`minor`/`trivial`/`info`/`none`), `fileName`, and `codegenInstructions` or `comment`. Empty scope: `complete` with `status: "review_skipped"`, `findings: 0`, `message: "No changes detected"`. Heartbeats are keep-alives. [reference](https://docs.coderabbit.ai/cli/reference.md)
4. Auth failure after the network path works: HTTP **401 or 403**; `cr doctor` can pass while review still fails. Missing stored key after a prior `auth login --api-key`: "no stored API key found". Wrong key type: user API keys not supported. Rate-limit / on-demand billing in agent mode: `action_required` with `status: "awaiting_confirmation"` (never waits for a TTY). [network](https://docs.coderabbit.ai/cli/network-requirements.md), [CLI on-demand](https://docs.coderabbit.ai/cli/index.md)

## 5 Tool inventory

Not MCP tools. Agent-facing CLI surface from the official reference:

- `cr` / `coderabbit` — default non-interactive plain-text review.
- `cr --agent` / `cr review --agent` — NDJSON review for agents (chosen).
- `cr review --light` — lighter local policy.
- `cr review --committed` / `--uncommitted` / `--include-untracked` — scope; contradictory flags are rejected.
- `cr review --base <branch>` / `--base-commit <sha>` / `--dir <path>` — comparison and subdirectory.
- `cr review findings` — replay last local findings without a new review.
- `cr auth login --api-key "<key>"` — headless store of an Agentic key.
- `cr auth status [--agent]` — auth JSON/text.
- `cr auth logout` — clear local session.
- `cr doctor` — connectivity/install smoke.
- `cr usage` — billing-period CLI usage (not self-hosted).
- `cr config validate` — YAML vs official schema (hits `www.coderabbit.ai`).
- `cr skills` — interactive skill install only.
- `cr stats`, `cr update`, `cr feedback` — local stats, updater, optional feedback.

## 6 Caveats

- **Not MCP.** Titanbot will not discover CodeRabbit tools via `tools/list`. Wire a skill or shell the CLI.
- **Headless yes**, with Agentic API key. Browser OAuth needs a GUI; `CI=1` / `CODERABBIT_API_KEY` only skip installer login.
- **Git required.** Run inside a Git worktree. Untracked files need `--include-untracked`.
- **Network:** outbound TCP 443 to `cli.coderabbit.ai` (install/update), `app.coderabbit.ai` (US auth/API) or `app.eu.coderabbit.ai`, and **WSS** to `ide.coderabbit.ai` / `ide.eu.coderabbit.ai` for every hosted review. Proxies that block WebSocket upgrades fail reviews (`1006`). [network](https://docs.coderabbit.ai/cli/network-requirements.md)
- **Rate limits (CLI reviews per developer per rolling hour):** Free 3, OSS 3, Essentials 5, Team 8, Advanced 10, Enterprise 12. Files/review 150 (Free/Essentials) or 300 (Team+). Reviews can take 7–30+ minutes. [plans](https://docs.coderabbit.ai/management/plans.md)
- **On-demand credits:** in `--agent` mode the CLI never auto-confirms paid overage; it returns `awaiting_confirmation`. Rerun with `--use-credits` only if the operator wants spend.
- **Installer needs unzip.** Default install dir `~/.local/bin`. Box has Node 22/npx, python3, outbound net, **no Docker**. uv/uvx unknown and unused. Homebrew is not the Linux-box path (`brew install coderabbit` is documented for macOS; Linux zip is official).
- **npm `coderabbit` is a stub.** Official binary is from `cli.coderabbit.ai`, not npm.
- **Self-hosted CLI** is a different `--self-hosted` login (Enterprise, ≥ 0.3.5); not this SaaS skill.

## 7 Sources

- https://docs.coderabbit.ai/cli/index.md
- https://docs.coderabbit.ai/cli/reference.md
- https://docs.coderabbit.ai/cli/headless-cli-integration.md
- https://docs.coderabbit.ai/cli/skills.md
- https://docs.coderabbit.ai/cli/network-requirements.md
- https://docs.coderabbit.ai/integrations/mcp-servers.md
- https://docs.coderabbit.ai/knowledge-base/mcp-context.md
- https://docs.coderabbit.ai/management/plans.md
- https://docs.coderabbit.ai/management/rate-limits.md
- https://docs.coderabbit.ai/management/audit-logs.md
- https://docs.coderabbit.ai/api/index.md
- https://docs.coderabbit.ai/changelog.md
- https://docs.coderabbit.ai/llms.txt
- https://cli.coderabbit.ai/install.sh
- https://cli.coderabbit.ai/releases/latest/VERSION
- https://formulae.brew.sh/api/cask/coderabbit.json
- https://github.com/coderabbitai/skills
- https://github.com/coderabbitai/skills/blob/main/skills/code-review/SKILL.md
- https://github.com/bradthebeeble/coderabbitai-mcp
- https://registry.npmjs.org/coderabbitai-mcp
- https://registry.npmjs.org/coderabbit
- https://github.com/hongkongkiwi/coderabbit-mcp-integration
- https://github.com/eHour/coderabbitai-github-mcp
- https://app.coderabbit.ai/settings/api-keys
- https://app.eu.coderabbit.ai/settings/api-keys
