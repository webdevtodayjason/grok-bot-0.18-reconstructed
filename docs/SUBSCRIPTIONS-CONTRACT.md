# Subscriptions Contract — discover, adopt honestly, score

**Status: DRAFT, not armed, not implemented.** Written 2026-09-02 for Jason's review after two
read-only scouts: Orca 1.4.195 (extracted from `/Applications/Orca.app`, MIT) and OpenClaw
v2026.8.1, the release branded 2.0 (source downloaded, MIT). Scout reports:
`scratchpad/orca-accounts-report.md`, `scratchpad/openclaw-auth-report.md`.

**The goal, in Jason's words:** the subscriptions already authenticated on a person's computer
(Claude, ChatGPT/Codex, Gemini, Z.AI GLM, MiniMax, Kimi, Grok) should be found and used, and the
rubric should then say which of them a user could actually run this product on.

## 1. What the two references actually do

They disagree on the one thing that matters most, and the disagreement is the design decision.

| | Orca 1.4.195 | OpenClaw 2.0 (v2026.8.1) |
|---|---|---|
| Claude | Reads the Claude Code OAuth token from the keychain (`Claude Code-credentials`, or the `-<hash>` scoped item) or `~/.claude/.credentials.json`, replays it to `api.anthropic.com` with `anthropic-beta: oauth-2025-04-20` and `User-Agent: claude-code/2.1.0`, refreshes at `platform.claude.com/v1/oauth/token` with Claude Code's client id, reads `/api/oauth/usage`; last resort spawns the `claude` binary under a pty and screen-scrapes `/usage` | **Removed token replay in 2.0.** Probes `claude auth status --json` and reads only `loggedIn`; runs the subscription as a subprocess `claude -p --output-format stream-json … --setting-sources user --allowedTools mcp__openclaw__*`, exposing its own tools to Claude Code over MCP, environment scrubbed of `ANTHROPIC_*` keys, sessions resumed by id |
| Codex / ChatGPT | Reads `~/.codex/auth.json`, calls `chatgpt.com/backend-api/wham` with `User-Agent: codex-cli`, `originator: Codex Desktop`, `ChatGPT-Account-Id`; never refreshes (refuses the app-server's refresh with a JSON-RPC error and lets the CLI do it); usage via `codex app-server` JSON-RPC `account/rateLimits/read` | Reads the `Codex Auth` keychain item (`cli\|<sha256(codexHome)[0:16]>`) or `$CODEX_HOME/auth.json`, expiry from the JWT `exp`; **bootstrap-only** adoption (seeds a profile once, never overwrites a locally refreshed token); refreshes at `auth.openai.com/oauth/token` with Codex's client id; requests to `chatgpt.com/backend-api/codex` with a bearer, `ChatGPT-Account-Id`, and an honest `originator: openclaw` |
| Gemini | OpenCode's `auth.json` if it holds a Google OAuth entry, else `~/.gemini/oauth_creds.json`; labelled "experimental, may break, use at your own risk" in Orca's own UI | Presence only, for onboarding detection; **the client-secret harvesting from the installed Gemini binary is gone**; runs the Gemini CLI as a subprocess with `--allowed-mcp-server-names` |
| MiniMax | supported (details in the Orca report) | `~/.minimax/oauth_creds.json`, bearer to `api.minimax.io`, refresh at `account.minimax.io/oauth2/token` (device-code grant, MiniMax's client id), usage `/v1/token_plan/remains` |
| Z.AI GLM | absent | API key only, `api.z.ai/api/coding/paas/v4` for the coding plan, usage `api.z.ai/api/monitor/usage/quota/limit` |
| Kimi | supported (Orca report) | API key from `KIMI_API_KEY` / `KIMICODE_API_KEY`, no discovery |
| Grok | supported (Orca report) | xAI API key only; a SuperGrok subscription has no API |

**One nuance, so nobody over-reads the table.** OpenClaw 2.0 still ships its *own* Anthropic OAuth
login (`src/llm/utils/oauth/anthropic.ts`: PKCE at `claude.ai/oauth/authorize`, scopes including
`user:inference`), and it does so under Claude Code's client id, so a user can bind a Claude
subscription to OpenClaw through a flow that presents itself to Anthropic's OAuth service as Claude
Code. What 2.0 removed is adopting tokens the Claude CLI minted. The scout's own words on that
login: "decide the posture before copying, not after." This contract decides: not copied. The
subprocess route gives subscription access with no token custody at all.

**Reading it.** Orca gets more subscriptions working by borrowing first-party tokens and posing as
the first-party client. OpenClaw 2.0 deliberately backed away from that for Anthropic and Google,
kept token adoption only where the vendor's own CLI stores tokens for exactly that reuse (Codex,
MiniMax), and identifies itself honestly. Anthropic's consumer terms restrict Claude subscription
use to Claude's own apps and Claude Code; OpenAI tolerates Codex-CLI OAuth in third-party tools that
identify themselves; Google's Gemini CLI credentials are unofficial for anything but the CLI. Orca's
approach on Jason's own machine is Jason's risk. Shipped to a hundred downloaders it is their
accounts and this product's reputation. **This contract takes OpenClaw's line.**

## 2. Architecture: two kinds of subscription route

The host speaks one thing to a model: an OpenAI-compatible chat completion with 33 tools, executed
by the host. A subscription fits that shape or it does not, and the two shapes get different
treatment.

**Model endpoints** (the host stays the agent; the subscription is the model):

| Provider | Discovery on this machine | Route | Auth | Honest client id |
|---|---|---|---|---|
| ChatGPT / Codex | `~/.codex/auth.json` or the `Codex Auth` keychain item, presence and expiry only | Responses API at `chatgpt.com/backend-api/codex` (needs a Responses transport; the host has chat-completions only) | bearer, `ChatGPT-Account-Id`, bootstrap-only adoption, refresh via Codex's own flow | `originator: grok-bot` |
| MiniMax | `~/.minimax/oauth_creds.json` | OpenAI-compatible chat at `api.minimax.io/v1` | bearer, refresh at `account.minimax.io/oauth2/token` | user agent names this product |
| Z.AI GLM coding plan | `ZAI_API_KEY` or a key the user pastes | OpenAI-compatible chat at `api.z.ai/api/coding/paas/v4` | static key | — |
| Kimi | `KIMI_API_KEY` or pasted | OpenAI-compatible chat at Moonshot | static key | — |
| Grok | xAI key, already an endpoint | as today | static key | — |

**Agent runtimes** (the subscription's own CLI is the agent; the host's tools reach it over MCP):

| Provider | Presence check | Route | What the host does |
|---|---|---|---|
| Claude subscription | `claude auth status --json` → `loggedIn` | `claude -p --output-format stream-json --setting-sources user --allowedTools mcp__grokbot__*`, env scrubbed of `ANTHROPIC_*` | serves its box tools (Shell, Read, SendMessage …) as an MCP server the subprocess may call; resumes by session id |
| Gemini subscription | `gemini` on PATH and `~/.gemini/oauth_creds.json` present | `gemini -p … --allowed-mcp-server-names grokbot` | same |
| Codex as a runtime | as above | `codex exec` with an MCP config pointing at the host | same, optional; the endpoint route above is the primary Codex path |

An agent runtime is not a drop-in model: the subprocess runs its own turn loop, so the host's
completion checks, the evidence layer's attestation wrapper, and the rubric's work tier do not apply
unchanged. The evidence layer still applies at the boundary: every MCP tool call the subprocess makes
into the host is a receipt and an attestation like any other, and its final text is stamped like any
reply. That is why the MCP route is not a downgrade in governance.

## 3. Discovery: a scanner, not a harvester

One module, `subscription-scan.ts`, read-only, no network, no secret ever leaves it:

- For each provider, report `{present, usable, identity?, expiresAt?, source}` where `source` is
  the path or keychain service that was checked. Identity is the email or workspace name if the
  vendor's own store carries it in the clear (Codex's `id_token` claims do); never decoded from a
  token we then keep.
- Claude and Gemini are checked by their CLIs, not by reading their credential files.
- Results surface in the Endpoints panel as "Found on this machine", with a one-click "use as
  endpoint" for model-endpoint providers and "use as worker" for agent runtimes. Nothing is enabled
  without the click. The scan runs on demand and on host start, never on a timer.
- Secrets adopted for model-endpoint providers go into `box-secrets.json` with the same 0600
  handling as today, never into `endpoints.json`, never into the transcript, prompts, logs or
  analytics.

## 4. The rubric, extended

`scripts/model-rubric.mjs` already scores any OpenAI-compatible endpoint on fresh agents. Two additions:

- A `subscription:` entry kind that resolves through the scanner, so `--models subscription:codex,
  subscription:minimax, subscription:zai` runs the same battery against adopted subscriptions.
- A runtime tier for agent runtimes: the same sentinel task issued to the subprocess through the
  MCP route, scored on the same evidence verdicts. Reported in a separate column, never blended with
  the model-endpoint score, because it measures a different thing.

Cost class gains a third value, `subscription`, with the reset window and percent used when the
vendor exposes them (Codex `chatgpt.com/backend-api/wham/usage`, MiniMax `/v1/token_plan/remains`,
Z.AI `api/monitor/usage/quota/limit`; OpenClaw's `src/infra/provider-usage.fetch.*.ts` are the
copyable readers). The rubric page shows it so the judgment "which one a user could use" includes what
it costs them in plan quota, not only whether it works.

## 5. What is copied, what is reimplemented

From OpenClaw 2.0, MIT, with attribution in `THIRD_PARTY_NOTICES.md`:

- `src/agents/cli-credentials.ts` readers for Codex (keychain + file, JWT expiry) and MiniMax, about
  200 lines after trimming caching and Gemini.
- `extensions/minimax/oauth.ts` refresh definitions, and the Codex refresh from `extensions/openai/`.
- The `claude -p` argument vector and the environment scrub list from
  `extensions/anthropic/cli-backend.ts` and `cli-constants.ts`.

Reimplemented here: the Responses-API transport for Codex (the host has chat-completions only; about
300 lines beside `openai-compatible-chat.ts`), the MCP server that exposes box tools to a subprocess
(the host already has an MCP client stack; the server side is new), the scanner, and the Endpoints
panel surface. Not copied: anything from Orca's Claude or Gemini paths.

## 6. Compatibility and risk

- Additive. New providers are new `endpoints.json` kinds and new box-secret keys; the existing
  five endpoints and the xAI route are untouched.
- Bootstrap-only adoption means this product never fights the vendor's CLI over a refreshed token:
  a Codex profile is seeded once from the CLI's store and, once this product holds its own refresh
  token, the CLI's state can never replace it (OpenClaw's `bootstrapOnly` guard). An identity
  check (account id, then email) blocks adoption when the CLI has since logged into a different
  account. Both rules are copied; the store around them is not.
- Discovery is never a blanket sweep. OpenClaw only probes providers the user has configured;
  here the equivalent is the explicit "Scan this machine" action and per-provider opt-in. Read-only
  status paths never trigger a keychain prompt.
- Every outbound request identifies this product. No first-party user agents, no first-party
  originators.
- Per-provider opt-in with the vendor's own posture shown next to the switch: Codex and MiniMax
  "supported by the vendor's CLI for reuse", Z.AI and Kimi "API key from your plan", Claude and
  Gemini "runs your CLI; your plan's terms apply", Grok "API key only, your SuperGrok plan does not
  include API access".
- The scanner never phones home and never logs a secret; the compat gate greps the host log and the
  transcript for adopted secrets after a run.

## 7. Migration path, each step shippable alone

| Step | Change | Files | Proof |
|---|---|---|---|
| 1 | Scanner + Endpoints panel "Found on this machine" | 3 | `node scripts/verify-subscription-scan.mjs` reports Codex, Gemini, Claude presence on this Mac, no secret in output |
| 2 | Z.AI and Kimi as pasted-key endpoints; rubric `subscription:` kind | 2 | rubric runs `subscription:zai` end to end |
| 3 | MiniMax adoption with refresh | 2 | rubric runs `subscription:minimax`; a forced-expired token refreshes once |
| 4 | Codex adoption + Responses transport | 3 | rubric runs `subscription:codex`; requests carry `originator: grok-bot`; a refreshed token is never written back |
| 5 | MCP server for box tools + `claude -p` runtime + runtime tier | 4 | a sentinel task through the runtime yields an `evidenced` stamp on its final message |
| 6 | Gemini runtime | 1 | same, through `gemini -p` |

Steps 1 to 4 are one contract, about two days. Steps 5 and 6 are a second contract; they change
what "the agent" is and deserve their own acceptance.

## 8. Locked contract, steps 1 to 4, ready to paste

```
=== LOCKED CONTRACT ===
GOAL: Subscriptions already authenticated on this machine are discovered without reading
secrets we do not need, adopted only where the vendor's own CLI stores tokens for reuse, used
with honest client identification, and scored by the rubric so the choice of model is measured.
ACCEPTANCE:
  - the scanner reports presence and expiry for Codex, MiniMax, Gemini and Claude on this Mac with no secret in its output: `node scripts/verify-subscription-scan.mjs`
  - Z.AI and Kimi run as pasted-key endpoints through the rubric: `node scripts/model-rubric.mjs --models subscription:zai --turn-timeout-ms 150000`
  - MiniMax adoption refreshes a forced-expired token once and runs the rubric: `node scripts/model-rubric.mjs --models subscription:minimax --turn-timeout-ms 150000`
  - Codex adoption runs the rubric through the Responses transport with an honest originator and never writes a token back: `node scripts/verify-codex-adoption.mjs`
  - no adopted secret reaches the host log, the transcript, or endpoints.json: `node scripts/verify-subscription-scan.mjs --leaks`
  - the existing suite and the evidence replay stay green: `node tests/index.js`
NON-GOALS:
  - any read of `~/.claude/.credentials.json` or the `Claude Code-credentials` keychain item
  - any read of `~/.gemini/oauth_creds.json` beyond existence
  - first-party user agents or originators
  - `ui/machine-room/app.js`, `ui/machine-room/styles.css`
  - the agent-runtime route (steps 5 and 6)
  - `source/host/extensions/evidence/**` and `source/host/extensions/transcript/turn-runtime.ts`
BUDGET: ≤14 files, ~2 days, behind the existing endpoints panel, box-secrets handling and rubric.
TRIPWIRE: At the budget, or if a vendor route needs anything but its documented OAuth refresh,
or if any change to the evidence layer tempts: STOP and report before continuing.
DISPOSITION: Before declaring done, emit DISPOSITION LOG — every condition encountered
(failing test, error, stub/FIXME/TODO, dead code, stale doc, type debt), each closed with one of:
[FIXED] / [FIXED_NOW] / [VERIFIED_CLOSED] (resolved now, with evidence),
[DEFERRED_NONBLOCKING] (does not block this goal AND filed with Owner + Next + Proof),
[OPERATOR_BLOCKED] (requires human access/decision; Owner + Next + Proof), or
[FALSE_POSITIVE]/[HISTORICAL_FALSE_POSITIVE] (witness matched noise/history, explain why).
If the gate blocks and lists witness keys, each closing line must contain the condition's
key AND its tag on the same line. [OWNED] is NOT a final disposition. Empty log is legal ONLY
if nothing was encountered.
RULES: Restate this contract before the first action. Check every step against GOAL +
NON-GOALS. Report against ACCEPTANCE at the budget and before declaring done. Emit the
DISPOSITION LOG as the last action before done — done is not claimable without it.
=== Work only to this contract. ===
```

Notes for arming: the rubric's subscription runs spend plan quota on Jason's accounts; each is
one fresh agent, about ten requests. The Z.AI and Kimi keys come from Jason; the contract does not
read `~/.api_keys`.
