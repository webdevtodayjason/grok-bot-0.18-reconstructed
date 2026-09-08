# Every place this product can reach Cursor

CURSOR-1. This is the inventory. It covers the source overlay in `source/`, the built host bundle
(upstream code we do not hold as source), the compose files, and the box image's own scripts. Every
row says where it is, what it does, when it fires, what a person sees when it fails today, and the
decision: replace, switch off, or keep.

Two rules for reading it. Every number says which machine it was measured on. Measured findings and
planned work are in separate columns and never mixed.

The machines named below:

- **grok-bot-local-vm**, the Mac box. Numbers taken there on 2026-09-07.
- **the R750**, three live boxes (Jason's, Richard's, the demo box). Numbers taken there on
  2026-09-07 between 18:19 and 18:21.
- **this checkout**, for counts taken from the built bundle at `.cache/patched-host/host-main.cjs`.

## The short version

A box we ship talks to `https://api2.cursor.sh` because that is the last-resort value of one
constant, and because all three of our install paths set `SAND_BACKEND_URL` to it explicitly. That
host is not dead. Measured from inside the box on grok-bot-local-vm: `GET https://api2.cursor.sh/`
answers HTTP 200 in 0.20 seconds, and `POST aiserver.v1.DashboardService/GetUserPrivacyMode`
answers HTTP 401. The boxes were not failing to reach a broken server. They were authenticating
against somebody else's product and being turned away, once per turn, forever.

So "is a backend configured" was never the right question. A URL is always configured. The question
this work added is whether the configured host is one we own.

`source/shared/node/backend-mode.ts` answers it:

- **none**: `SAND_BACKEND_URL` is unset, empty, unparseable, or points at a Cursor or Anysphere
  host. This is every box we ship today.
- **ours**: it names some other host.

Unset means none, never Cursor. The read goes through `readSandBoxSetting`, so the container
environment wins and `sand-host-settings.json` is the fallback. That matters because BOX-6 forbids
recreating a live instance, and `docker restart` re-reads the bundle but not the environment. A
compose-only switch would mean "recreate the box to change your mind". A settings file write plus a
relay restart moves a running box instead.

## What landed here, and what is still owned elsewhere

| Landed in this change | Still owned by another row |
| --- | --- |
| Local gate pins with the product's defaults baked in, plus `gates.json` for the operator | The shared RPC transport rejecting in mode none |
| The Statsig bootstrap, its poll, and its last egress path, all off | The `DEFAULT_CURSOR_BACKEND_URL` constant itself |
| The privacy-mode lookup off | The compose files and the installer placeholder |
| The credential renewer off | The Cursor Origin section of the system prompt |
| Codebase telemetry off above the capability check | The auto-review router inversion |
| Host tracing, structured logs and product analytics off | The account MCP, marketplace, automations and cloud-agent RPCs |
| The gates line reporting the layer that actually decided | The `cursor.com` links in the Help menu and the integrations dashboard |
| `WebFetch` and `WebSearch` becoming ours, behind the same two names | |
| What a new box starts with, in `deploy/box-defaults/` | |
| The gate, `scripts/verify-cursor-free.mjs` | |

Rows marked "still owned" are named in the tables below with the reason they were left alone, so
nobody reads this file and concludes the work is finished.

## 1. The backend RPC client and its method surface

| Locator | What it does | When it fires | What a person sees today | Decision |
| --- | --- | --- | --- | --- |
| `source/shared/node/cursor-backend/cursor-inference.ts`, `createSandBackendTransport` / `createSandCursorBackendClient` / `createSandInferenceInterceptor` | The single Connect RPC client factory the host uses. Stamps `authorization`, `x-cursor-checksum`, `x-cursor-client-type`, `x-cursor-client-version`, `x-sand-box-namespace`, `x-ghost-mode`, `x-request-id`. Fifteen host modules build clients on it. | Whenever any of those modules calls a method. | Every call answers 401. Callers wait out a request timeout first. | **Replace**, and still open. In mode none it should hand back a client whose every method rejects with `SandBackendDisabledError`, so callers fail fast and locally. Not done here: the blast radius covers connectors and backend MCP, and this change was scoped to the loops. Every loop that used it is switched off at its own call site instead, so nothing dials out today. |
| Same file, the RPC method names reachable through it | `getUserPrivacyMode`, `classifySandAutoReview`, `runWebSearch`, `runWebFetch`, `runGenerateImage`, `recordSandAuditEvents`, `getMe`, `availableModels`, `getSignedUrlForAttachedMedia`, `getEffectiveUserPlugins`, `installUserPlugin`, `publishPlugin`, `unpublishPlugin`, `getTeams`, `getAvailableMcpServers`, `getMcpConfig`, `listSandMcpTools`, `executeSandMcpTool`, `checkHttpMcpStatus`, `completeMcpOAuth`, `deleteMcpOAuthAccount`, `deleteMcpOAuthToken`, `renameMcpOAuthAccount`, `validateMcpOAuthTokens`, `getScmConnectionStatus`, `getSlackInstallUrl`, `getSlackUserSettings`, `createAutomation`, `updateAutomation`, `deleteAutomation`, `listSandAutomations`, `recordPostTurnLabeling`, `recordAgentPostTurnLabeling`, `recordFollowupClassification`, `recordAgentFollowupClassification`. Plus `BootstrapStatsig` over plain fetch and the fourteen `BackgroundComposerService` methods. | Per feature. | Each fails in its own way. The ones a person meets are the web tools and the classifier, below. | **Replace** as above. Listed in full so nobody has to rediscover the surface. |
| `source/shared/node/marketplace/cursor-marketplace-client.ts` and `source/host/extensions/managed-setup/production.ts` | A **second**, independent Connect transport. `createDashboardClient` calls `createConnectTransport` directly with its own checksum interceptor, not through `createSandCursorBackendClient`. Fetches managed skills, marketplace plugins and team rules. | On first credential and on every renewal. | Nothing visible. The fetch fails and the seeded skills are used. | **Switch off**, still open. Name it here because any claim that "we removed the Cursor client" that only touches `createSandCursorBackendClient` misses this one. |
| `source/host/extensions/inference/sand-labeling.ts` | Post-turn labeling. Sends the turn's transcript to `InferenceService` for classification and prompt-quality collection. | After every turn, unless skipped. | Nothing. It does not run today, and only because of a provider early return two lines away. | **Switch off**, still open. Of everything in this sweep this is the one a business owner would object to hardest: their conversations sent to a third party for that company's model quality work. It is luck, not a decision, that it is quiet. |

### Where those methods are called from

The method list above is a surface. This is where the product reaches for it, so nobody has to
rediscover it. None of these dials out today, because in mode none every loop that would have is
switched off at its own call site, but each one is still built and still points at the wrong place.

| Locator | Method | What a person meets | Decision |
| --- | --- | --- | --- |
| `source/shared/node/cursor-backend/account-mcp.ts` | `getAvailableMcpServers`, `getMcpConfig` | The connector list would come from a Cursor account. | **Replaced already** by `source/host/extensions/mcp/local-connectors.ts`, which owns connectors from a local file. Finish it by not building the account client at all. |
| `source/shared/node/cursor-backend/backend-mcp-exec.ts` | `listSandMcpTools`, `executeSandMcpTool`, `checkHttpMcpStatus` | Remote MCP execution. | **Switch off**, still open. stdio servers run inside the box through `boxMcpExec` with Cursor in none of it. |
| `source/host/extensions/mcp/mcp-service.ts` | `completeMcpOAuth`, `deleteMcpOAuthAccount`, `deleteMcpOAuthToken`, `renameMcpOAuthAccount`, `validateMcpOAuthTokens` | Connector Authorize hands the operator to `cursor.com`. | **Switch off**, still open. Our own presets use a header and a connector secret, not OAuth. |
| `source/host/extensions/mcp/plugin-skills.ts`, `skill-publish.ts` | `getEffectiveUserPlugins`, `installUserPlugin`, `publishPlugin`, `unpublishPlugin`, `getTeams`, `getMe` | The marketplace. | **Replace**, still open, with ours. |
| `source/host/extensions/cloud-agents/cloud-agents-service.ts`, `cloud-agent-poll-loop.ts`, `cloud-agent-tool.ts` | Cloud agents, plus `cursor.com/agents/<id>` links and "create one from the Cloud Agents dashboard on cursor.com" | A whole feature that is somebody else's product, offered to our customer. | **Switch off**, still open. Drop the tool from the toolset. |
| `source/host/extensions/cloud-agents/model-catalog-fetch.ts` | `availableModels` | The model list would be Cursor's catalog. | **Replace**, still open, with `ui/endpoints.json`, which is where our models already live. |
| `source/shared/node/cursor-backend/cursor-generate-image.ts` | `runGenerateImage` | The `GenerateImage` tool is offered today and cannot work. | **Replace** or drop the tool, still open. |
| `source/host/extensions/automations/extension.ts` | `createAutomation`, `updateAutomation`, `deleteAutomation`, `listSandAutomations` | A customer's automations stored on Cursor. | **Replace**, still open, with local storage. |
| `source/host/extensions/notifications/extension.ts` and `box-lifecycle/extension.ts` | `GrokBotService` mobile push and box lifecycle | Push through Cursor; box lifecycle owned upstream when ours is Coolify. | **Switch off**, still open. |
| `source/host/extensions/auth/user-full-name-service.ts` | `getMe` | The display name. | **Switch off**, still open. |

## 2. The privacy-mode lookup

This was 99.9 percent of the noise.

| Locator | What it does | When it fires | Measured | Decision |
| --- | --- | --- | --- | --- |
| `source/shared/node/cursor-backend/cursor-inference.ts`, `resolveSandRunPrivacyMode`, `resolveSandPrivacyMode`, `settlePrivacyMode`, `resolveCachedSandPrivacyMode` | Asks the backend for the account's ghost-mode setting so the `x-ghost-mode` header can be stamped. Timeout 3 seconds. A success caches 5 minutes, a failure caches 10 seconds, so the worse it goes the harder it retries. | Once per turn, and again per subagent host run. It sits on the inference object **before** the provider branch, so it fired the same on a box routed entirely to xAI or to a local endpoint. | On grok-bot-local-vm, `/tmp/sand-host.log` was 2,947,354 bytes and held 1740 `[sand:privacy] privacy-mode lookup failed, using privacy-safe fallback backend=https://api2.cursor.sh/ error=ConnectError` lines, out of 1742 lines containing the word cursor at all. Jason saw the same line running continuously on all three R750 boxes. | **Switched off.** In mode none both resolvers return `SAND_RUN_PRIVACY_MODE_FALLBACK` (`NO_TRAINING`) with no network call and no log line. That is exactly what the failure path already returned, so nothing downstream changes. What goes away is the 3 second stall at the head of every turn and the log. The function, its cache and the header stay for the day a backend of ours exists. |

## 3. Feature gates and Statsig

This is the one that cost a customer the use of the product.

| Locator | What it does | When it fires | Measured | Decision |
| --- | --- | --- | --- | --- |
| `source/shared/node/experiments/cursor-experiments.ts`, `start()` | Hydrates a `StatsigClient` from `sand-statsig-bootstrap.json` on disk **before any network call**, then starts a poll. | Host start, then every 5 minutes packaged or every 30 seconds unpackaged, and again on every credential renewal. | On grok-bot-local-vm `SAND_PACKAGED` is not set, so every one of our boxes was on the 30 second cadence. `/home/box/sand-data/sand-statsig-bootstrap.json` does not exist there, so the bootstrap has never succeeded on that box. From inside the box, `api3.cursor.sh` answers HTTP 403. | **Switched off.** Nothing starts in mode none: no cached hydrate, no poll, no `StatsigClient`. `handleAuthChange` and `refresh` are guarded too, because `refreshNow` is public and the renewal listener calls in. |
| `source/shared/node/experiments/statsig-bootstrap.ts`, `STATSIG_CLIENT_KEY` and `STATSIG_LOG_EVENT_PROXY_URL` | Cursor's hardcoded Statsig client key, and a second Cursor host, `https://api3.cursor.sh/tev1/v1`, as the destination for exposure and diagnostic events. | With the client. | See above. | **Switched off** with the client. Nothing about a self-hosted box needs a remote flag service. |
| Same file, `sandStatsigNetworkUrlAllowed` | A network filter on the Statsig SDK. It passed any URL containing `/rgstr` to real fetch and answered everything else with a synthetic 204. `/rgstr` is Statsig's **event upload**, so the filter blocked config fetches and permitted event uploads. | Any SDK network call. | Inert today only because the client never hydrated. Inert by accident is not a setting. | **Replaced.** It returns false for every URL. The 204 shim stays so the SDK is happy if a client is ever built against a backend of ours. |
| `source/shared/node/experiments/feature-flag-overrides.ts` | Persists per-gate overrides to `sand-feature-flag-overrides.json`. Had a 24 hour expiry per entry, and hydrated from disk only on a dev build or an Anysphere account. | On read and on write. | On grok-bot-local-vm the file held `{"sand_teach_by_demonstration":{"value":true,"expiresAtMs":1788238328389}}`, which lapsed on 2026-09-01 at 04:52 UTC, six days before it was read. A gate somebody had deliberately pinned on had turned itself off with the clock and nothing said so. Teach still ran only because `SAND_TEACH=1` sits separately in `sand-host-settings.json`. | **Replaced.** Entries no longer expire. Reads are no longer gated on the build type, so an override cannot sit on disk being ignored on the box it was written for. Writes stay behind the dev panel's capability. An old file with `expiresAtMs` in it still loads, and the value is used. |
| `source/host/extensions/experiments/extension.ts`, the `[sand][gates]` table | Prints one line at host start naming each gate, its value and where the value came from. | Host start. | On the R750, three boxes on **one bundle** printed three different tables. The demo box printed `sand_auto_review` true with source `bundled default`, and the bundled default is false. The label had no word for "a client hydrated from a cached bootstrap file", so it said the wrong thing. | **Replaced.** `resolveFeatureGate` now returns the value together with the layer that decided it, and the table prints that. A row that came from a pin also carries `pin`, which is `file` for `gates.json` and `host` for the table in the bundle. Every gate the product pins gets a row, not just the fifteen somebody once picked. |
| `source/shared/node/experiments/experiment-config.gen.ts` | The bundled defaults. 608 flags, mechanically recovered from the 0.18 bundle. | Last resort for any gate. | These are Cursor's rollout positions for Cursor's product. | **Keep** as the last-resort constant. Do not hand-edit it. The product's decisions live in `gate-pins.ts` instead. |

### The pin file

`gates.json` in the sand data root. Either shape works:

```json
{ "sand_auto_review": false, "sand_browser_use_subagent": true }
```

```json
{ "gates": { "sand_auto_review": false } }
```

Booleans and the words `1 0 true false on off yes no` are all accepted. A name that is not a real
gate is dropped, and so is a value that is neither, because a typo must not be able to arm a gate.
The read is cached against the file's nanosecond mtime and size, so a live box picks up an edit
without a restart, and two edits inside one millisecond cannot read stale.

Precedence, highest first:

1. `gates.json` (`source` reads `local pin`, `pin` reads `file`)
2. the override store, `sand-feature-flag-overrides.json` (`override store`)
3. `SAND_FEATURE_GATE_OVERRIDES` in the environment (`env`)
4. the product's table in the bundle (`local pin`, `pin` reads `host`)
5. a live Statsig evaluation (`statsig`), which in mode none can no longer happen at all
6. the bundled default (`bundled default`)

The product's decisions sit below the operator layers on purpose. A pin nobody can move is a
rollout with our name on it, and that is the thing being fixed. They sit above Statsig so that no
two boxes on one bundle can ever differ because of a remote flag.

### The gates, their bundled defaults, and what the product pins

`default` is Cursor's position in the bundle. `pinned` is ours. A blank pin means the product has no
opinion and the gate falls through to its own switch or to the default.

| Gate | Default | Pinned | Why |
| --- | --- | --- | --- |
| `sand_auto_review` | false | **false** | The classifier behind it is an upstream RPC we cannot call. When the gate is on and the RPC fails the agent is refused every command. REVIEW-1's local classifier is reached through `SAND_AUTO_REVIEW_MODE` instead. |
| `sand_browser_use_subagent` | false | **true** | Titan holds the browser himself (BROWSER-1). The new fetch failure text tells a person to open the page in a browser, which is only honest if he can hold one. |
| `grok_bot_dynamic_tools` | false | **false** | It gates a dynamic tool registry and tool placement for the main agent only. MCP tools already reach the model without it. With 26 tools offered and local models breaking above 6 schemas, a placement change is a fleet measurement, not a rollout. |
| `sand_product_analytics` | true | **false** | Product analytics to a third party. |
| `sand_codebase_telemetry` | false | **false** | Ships snapshots of the customer's code off the box. Off by decision now, not by a missing binary. |
| `codebase_telemetry_v2` | true | **false** | Same family. No reader in the source overlay, present in the flag table. |
| `codebase_telemetry_v2_git_history` | true | **false** | Same. |
| `codebase_telemetry_v2_agent_dot_dirs` | true | **false** | Same. |
| `sand_action_audit_logs` | false | **false** | Forwards the action-audit ledger to the backend. |
| `sand_notify_bus` | false | **false** | A push bus on the backend. |
| `sand_notify_safety_poll` | true | **false** | Its poll fallback. Both consumers are backend relays. |
| `sand_enable_pressure_cpu_profiler` | true | **false** | CPU profiles collected for upload with the structured logs. |
| `sand_box_egress_tunnel` | false | **false** | No reader in the source overlay. |
| `sand_auto_update_when_idle` | false | **false** | Updates are ours, in `docs/OPERATOR-RUNBOOK.md`, not an upstream idle check. |
| `sand_multitask` | true | **true** | Load-bearing. Pinned on so a live evaluation can never take it away. |
| `sand_spotlight` | true | **true** | Load-bearing. |
| `sand_global_search` | true | **true** | Load-bearing. |
| `sand_computer_use_playwright` | true | **true** | Load-bearing. |
| `sand_teach_by_demonstration` | false | | Its switch is `SAND_TEACH` in the settings file, which already works on a live box. |
| `sand_memory_dreaming` | false | | Its switch is `SAND_MEMORY_DREAMING`. |
| `sand_agent_network` | false | | No product decision yet. |
| `sand_stale_root_gc` | false | | Its switch is `SAND_STALE_ROOT_GC`. |
| `grok_bot_conversation_gc` | false | | Its switch is `SAND_CONVERSATION_GC`. |
| `sand_legacy_store_blob_retirement` | false | | Its switch is `SAND_RETIRE_LEGACY_STORE_BLOBS`. |

The table holds 608 flags in all. The 24 above are the ones the boot line prints or the product
pins. The rest are unchanged, and the guarantee that matters is the same for every one of them: with
no live evaluation possible, every box on one bundle now answers every gate identically.

## 4. Telemetry, and codebase telemetry

| Locator | What it does | When it fires | What a person sees today | Decision |
| --- | --- | --- | --- | --- |
| `source/host/extensions/telemetry/host-tracing.ts` and `host-telemetry-service.ts` | An OTLP span exporter at `${backendUrl}/v1/traces` with `x-ghost-mode: false`, registered as the global tracer provider with a batch processor. | Continuously, from host start. | Nothing. Export failures are swallowed by a try/catch. | **Switched off**, and an ordering bug fixed with it. The tracer was built in the constructor and `SAND_DISABLE_TELEMETRY` was only read further down in `start()`, so the disable switch never actually stopped the tracer being built and registered. The check now runs before the constructor, and covers backend mode. `x-ghost-mode: false` is worth naming on its own: it tells the receiving end this box's traces may be retained. |
| `source/host/extensions/telemetry/structured-log-telemetry.ts` | Builds an `AnalyticsService` client on the backend and flushes structured logs to it on a poll. | Continuously. | Nothing. | **Switched off.** The transport is now `disabled` whenever telemetry is off or the backend is not ours. |
| `source/shared/node/analytics/product-analytics.ts` | Product analytics events to `AnalyticsService`, gated on `sand_product_analytics`, whose bundled default is true. | On user actions and on a buffer flush. | Nothing. | **Switched off.** `isAnalyticsOptedOut` now covers backend mode, and the gate is pinned false besides. A gate is a value; this is the wire. |
| `source/host/extensions/telemetry/host-telemetry-service.ts`, `start()` | Also gates the event-loop telemetry, the pressure CPU profiler and the desktop health poll. | Continuously. | Nothing. | **Switched off** with the rest. All three feed the structured log transport, which is Cursor bound. |
| `source/host/extensions/codebase-telemetry/` (9 files) | A second privacy-mode loader on a 5 minute poll, plus a snapshot uploader that ships **codebase snapshots** to the backend with `x-cursor-checksum` and `x-ghost-mode: false`, on a 5 minute upload poll. | Continuously, when armed. | Nothing. It was off for two accidental reasons: the gate defaults false, and the image carries no `csnaps` binary. | **Switched off** as a decision, above the capability check, and the four gates pinned false. Shipping a customer's source code to a third party must never come back because somebody added a binary to the image. |

## 5. The auto-review and smart-mode classifier

This is the row that stopped a customer working.

| Locator | What it does | When it fires | Measured | Decision |
| --- | --- | --- | --- | --- |
| `source/host/extensions/auto-review/sand-backend-smart-mode-classifier-exec.ts` | Calls `DashboardService.ClassifySandAutoReview`, the upstream smart-mode classifier. | Once per Shell command, browser navigation and MCP call, while auto-review is armed. | On the R750 demo box, where `sand_auto_review` read true, **every** Shell command and browser navigation answered `Rejected: An error occured while classifying this action. Please review manually.` The agent could not run one command. Jason mitigated it by hand at 18:21 by putting `SAND_AUTO_REVIEW_MODE=shadow` in each box's `sand-host-settings.json`. | **Switch off**, still open here. What landed instead is the gate pin: `sand_auto_review` is pinned false, so the arm never happens on a stock box and the demo box's state cannot recur from a remote flag. The executor should still be deleted from the default wiring. |
| `source/host/extensions/auto-review/sand-local-auto-review-classifier.ts` and `auto-review/extension.ts` | The router reads `credentialed = options.hasBackendCredential()` and picks the backend classifier when true, the local one when false. `hasBackendCredential` is `auth.peekAccessToken?.() != null`. | Every classification. | On grok-bot-local-vm, `/run/grok-bot/inference.json` holds a 13 character token that expired on 2026-08-26 at 22:03 UTC, so `peekAccessToken()` is null there, the local classifier runs, and no rejections appear. Same bundle, opposite behaviour, decided by a file we wrote. | **Replace**, still open. Local should be the default and the only path, with the backend branch reachable only from an explicit operator setting. A credential file is not a capability test. What landed that helps: the renewer no longer runs in mode none, so `peekAccessToken()` cannot become non-null by accident. |

## 6. WebFetch and WebSearch

These two are ours now. The tool names, argument schemas, renderers and console tool rows are
unchanged, so the model's habits and the console's tool rows keep working.

| Locator | What it does | When it fires | Measured | Decision |
| --- | --- | --- | --- | --- |
| `source/host/extensions/inference/web-tools.ts`, `createSandWebFetchService` / `createSandWebSearchService`, wired from `production.ts` | Replaces `cursor-web-tools.ts`, which is deleted. `WebFetch` reads the page from the box itself: a browser-like User-Agent, redirects followed, a 25 MB cap, HTML reduced to text. It falls through to the backup only when the site refuses, and "refuses" is four measured cases, not one: a non-2xx, a body that reduces to nothing because the page only draws itself in a browser, content that is not text, and a page that answered 200 and is still a wall. | Every `WebFetch` and `WebSearch` call. | Before, on the R750, every call answered `Error: Tool failed; this may be temporary. Try again.` After, on grok-bot-local-vm with the road to Cursor closed, a turn asking for the heading of `https://example.com` came back "The heading on example.com is \"Example Domain\"", and a turn asking for the first thing on `https://www.linkedin.com/company/anthropic` came back with that page's own "Agree & Join" text. | **Replaced.** |
| Same file, `looksLikeWall` | A login wall is not a status code. Measured from this Mac 2026-09-07: `linkedin.com/feed` answers HTTP 200 with 792 characters that are entirely a sign-in form. The detector needs both halves, text under 1,200 characters and one of seventeen markers, and a wall is never thrown away: if the backup cannot beat it the wall text is returned, because a sign-in page is worse than an article and better than an error. | On every direct read that answered. | See the LinkedIn measurement above. | **Keep.** |
| `source/host/extensions/inference/tinyfish-route.ts` and `box-connector-tools.ts` | The backup. First the `tinyfish` connector's own `fetch_content` and `search` through the box's MCP client when that connector is installed, and otherwise the REST fetch and search APIs with the key already in the connector secret store. Nothing reads a key file on the operator's machine. | Only after a direct read was refused. | On grok-bot-local-vm no TinyFish connector is installed and no key is stored, so the backup is correctly absent, and the search failure below is what a box in that state says. | **Keep.** TinyFish is behind the scenes: it is a supplier, not a feature the person is shown. |
| `source/packages/agent/tools/core/web-fetch.ts` and `web-search.ts` | The tool shells: names, schemas, descriptions, truncation, the localhost and private-IP refusal, the rendering. | Same. | Unchanged except two description strings that stopped being true once the fetch runs on the box, and the private-IP refusal's wording, which said the tool "runs from an isolated server" and was backwards. | **Keep** both files and both names. |
| The failure words | `webFetchFailureMessage` and `webSearchFailureMessage`, ten messages in all, one per combination. None says "may be temporary". Each names what was tried, says that trying again will not help, and ends on the one thing that still works. | On any failure. | Measured on grok-bot-local-vm: the search on a box with no backup answered `Could not run that search. No web search service is set up on this machine. Ask whoever set this up to add one under Settings, or search for it in your browser.` No tool name, no service name, no vendor name. | **Replaced.** `tests/cursor-free.test.mjs` builds all ten and checks every one. |
| `source/packages/agent/tools/core/connect-error.ts` | Five more copies of "this may be temporary", on the RPC error path. | Any failed RPC. | No web tool reaches it now. | **Replace**, still open. It is no longer on the path a person meets through the web tools, but it is still the sentence any other failing RPC hands out. |


## 7. The credential renewer

| Locator | What it does | When it fires | Measured | Decision |
| --- | --- | --- | --- | --- |
| `source/host/extensions/auth/credential-renewer.ts` and `auth-service.ts` | With `SAND_DEV_INFERENCE_TOKEN_FILE` set it reads a JSON file; without it, it posts `/sand-box/inference-credential` to the backend. A forever loop, backing off between 30 seconds and 30 minutes. | From host boot. | On the R750, tenant boxes logged `inference-credential renewal failed (streak N): ENOENT` until the credential file was copied in by hand. Its only real effect on our boxes was to make `peekAccessToken()` non-null, which is what selected the upstream classifier over the local one. | **Switched off** in mode none. The ENOENT streak goes with it. Real inference credentials come from the endpoint picker, which writes `SAND_OPENAI_COMPATIBLE_*` into the box's own secrets file and never touches this loop. |
| `source/host/extensions/auth/auth-service.ts`, `getValidAccessToken` | Returns any unexpired token, and does not care that the token's text is a sentence saying it is not a credential. | Every "are we logged in" check. | See the installer row below. | **Replace**, still open. The store should reject a token that does not parse as a JWT. |
| `deploy/r750/install.sh` lines 96 to 105 | Writes `{"accessToken":"placeholder-not-a-credential","expiresAtMs":<now plus 10 years>}` so `box-store-sync`'s copy-in does not throw when no real credential is set. | Install time. | Combined with the two rows above, our own installer is what selected the upstream classifier on a tenant box, for ten years. | **Replace**, still open. Stop writing the placeholder and fix the throw it papers over. Until then, write it with an expiry in the past so it can never be mistaken for a credential. |

## 8. Every Cursor URL and domain string

### In the source overlay

| String | Locator | Decision |
| --- | --- | --- |
| `https://api2.cursor.sh` | `source/shared/node/cursor-token.ts`, `DEFAULT_CURSOR_BACKEND_URL` | **Replace**, still open. Should become our control-plane base, with `CURSOR_API_BASE_URL` and the `dev-staging.cursor.sh` host test dropped. Left alone here because in mode none nothing dials it, and the change is broad. |
| `https://api3.cursor.sh/tev1/v1` | `source/shared/node/experiments/statsig-bootstrap.ts`, `STATSIG_LOG_EVENT_PROXY_URL` | **Switched off.** No client is built in mode none, and the network filter now refuses every URL. |
| `https://9fb7a1b8cb70c207a28a00476311bd40@metrics.cursor.sh/...` | `source/shared/observability/sentry.ts`, `SAND_SENTRY_DSN` | See section 9. |
| `https://api2.cursor.sh/updates` | `source/electron-main/update/update-feed.ts`, `DEFAULT_UPDATE_BASE_URL` | See section 9. |
| `https://cursor.com` | `source/shared/deep-link.ts`, `SAND_HTTPS_DEEP_LINK_ORIGIN` | **Replace**, still open. A deep link origin that is not ours. |
| `https://cursor.com` | `source/host/extensions/transcript/agent-run-error.ts`, `CURSOR_WEBSITE_ORIGIN` | **Replace**, still open. |
| `https://cursor.com` | `source/electron-main/account/cursor-auth.ts`, `DEFAULT_CURSOR_WEBSITE_URL` | **Replace**, still open. |
| `https://cursor.com/dashboard?tab=integrations` | `source/host/extensions/automations/listener-integrations.ts` | **Replace**, still open. Sends a customer to a competitor's dashboard to fix their own integration. |
| `https://cursor.com/agents/<id>` | `source/host/extensions/cloud-agents/cloud-agents-service.ts`, `cloudAgentUrl` | **Switch off**, still open. Describes a capability this box does not have. |
| `https://cursor.com/help` | `source/electron-main/application-menu.ts` | **Replace**, still open. The Help menu item opens a competitor's help site. |
| `api2.cursor.sh` | `source/node-agent-coordinator/gateway/gateway-dns-diagnostics.ts`, `GENERAL_CONTROL_HOSTNAME` | **Replace**, still open. When gateway DNS fails, the probe that decides whether the network is at fault resolves Cursor's hostname. It diagnoses our product by asking whether a competitor is reachable, at most once every 60 seconds. |
| `playground.cursor.sh` | `source/host/extensions/box-store-sync/agent-store-sand-files.ts` | **Keep** for now. A hostname test, no call. |
| `cursor.com` | `source/shared/webauthn-gateway.ts` | **Keep** for now. A hostname classifier, no call. |
| `https://cursor.com/codebase/...`, `/opt/cursor/artifacts/`, the "Cursor Origin" section | `source/host/runner/system-prompt.ts` lines 152 and 239 to 261 | **Switch off**, still open. The base prompt teaches the model about Cursor by name on every turn of every box, describes a source-control platform this box cannot reach, and tells the agent to hand repository work to a Cursor cloud agent. It puts a competitor's brand in Titan's mouth in front of a business owner. |
| `curl https://cursor.com/install`, `defaultUrl: "https://cursor.com"` | `source/shared/node/experiments/experiment-config.gen.ts` | **Keep**. Data inside the recovered flag table, not a call. Do not hand-edit that file. |
| `com.anysphere.sand.reconstructed` | `scripts/lib/config.mjs` | **Keep**. A bundle identifier for the reconstruction, not a call. |
| `https://downloads.cursor.com/grokbot/...dmg` | `scripts/lib/config.mjs`, `dmgUrl` | **Keep**. The provenance source for the reconstruction, used at build time by a developer, never by a box. |

### In the built bundle

Counts taken from `.cache/patched-host/host-main.cjs` in this checkout, 20,399,582 bytes, one line.
Read with a bounded scanner that prints counts only.

| String | Count | Note |
| --- | --- | --- |
| `api2.cursor.sh` | 1 | The default backend constant. |
| `api3.cursor.sh` | 1 | The Statsig event proxy. |
| `metrics.cursor.sh` | 0 | The Sentry DSN is desktop-side, not in the host bundle. |
| `cursor.com` | 22 | Prompt text, deep links, dashboard and help links. |
| `anysphere` | 41 | Identifiers and account checks. |
| `playground.cursor.sh` | 2 | The hostname test. |
| `dev-staging.cursor.sh` | 0 | Not in the built host. |
| `/opt/cursor` | 3 | The cloud-agent artifact paths named in the prompt. |
| `x-cursor-checksum` | 4 | The four transports that stamp it. |
| `x-ghost-mode` | 5 | |
| `BootstrapStatsig` | 29 | |
| `GetUserPrivacyMode` | 35 | |
| `ClassifySandAutoReview` | 34 | |
| `RunWebSearch` | 29 | |
| `RunWebFetch` | 55 | |
| `sand-box/inference-credential` | 1 | The renewal path. |
| `/v1/traces` | 1 | The OTLP exporter path. |
| `/rgstr` | 1 | The Statsig event upload path. |

The bundle references 4,881 distinct `aiserver.v1.*` and `agent.v1.*` type names. The heaviest are
`aiserver.v1.DashboardService` (603 references), `BackgroundComposerService` (195),
`AiService` (193), `AutomationsService` (43), `GrokBotService` (31), `agent.v1.ControlService` (26),
`agent.v1.AgentService` (17) and `AnalyticsService` (11). Most of those names are message types
rather than call sites, so the count is a measure of surface, not of traffic. We do not hold this
code as source, which is why the switches above are placed at our own call sites and at the shared
transport rather than inside it.

## 9. Crash reporting, source maps, update checks and desktop links

| Locator | What it does | When it fires | What a person sees today | Decision |
| --- | --- | --- | --- | --- |
| `source/shared/observability/sentry.ts`, `SAND_SENTRY_DSN` pointing at `metrics.cursor.sh` | Crash and warning reports to a Sentry project that is not ours. Privacy-tiered and scrubbed, but still theirs. | On crashes and captured warnings, desktop side. | Nothing. | **Switch off**, and already off for the reconstruction: `scripts/lib/build-asar.mjs` prepends `process.env.SAND_DISABLE_SENTRY ??= "1"` to the packaged electron main, alongside `SAND_DISABLE_UPDATES` and `SAND_DISABLE_TELEMETRY`. That guard is asserted by `tests/reconstructed-updater-guard.test.mjs`. **Still open**: the DSN constant should be replaced or emptied, so the switch is not the only thing standing between a customer and a third party's crash pipeline. |
| Source map upload | Not present. | | | **Keep.** Checked because the contract asked, and the honest answer is that there is nothing to switch off. No upload step exists anywhere in `scripts/`, and the three build entry points that could produce maps (`scripts/electron-main-production-activation.mjs`, `scripts/host-production-activation.mjs`, `scripts/lib/clean-build.mjs`) all set `sourcemap: false`, so no map is generated in the first place. |
| `source/electron-main/update/update-feed.ts`, `DEFAULT_UPDATE_BASE_URL` = `https://api2.cursor.sh/updates` | The desktop app's update feed. Builds `/api/update/<platform>/<app>/<version>/<machineId>/stable`. Note it sends the machine id to a third party on every check. | On the desktop app's update schedule. | Nothing on a box. This is desktop side. | **Switch off**, already off for the reconstruction through `SAND_DISABLE_UPDATES ??= "1"`. **Still open**: the constant should point at our own feed or be removed. Our own update path is the host bundle URL plus `updateHostNow`, in `docs/OPERATOR-RUNBOOK.md`, and is unrelated to this. |
| `source/electron-main/application-menu.ts`, `source/electron-main/main-edge.ts`, `source/host/cloud-agents/` | Menu and UI links out to `cursor.com`: Help, the cloud agent opener, the integrations dashboard. | When a person clicks. | A person clicks Help in our product and lands on a competitor's website. | **Replace**, still open. Grouped with the prompt row in section 8, because they are one job: the product must not send a customer to somebody else's brand. |
| `source/electron-main/feedback/feedback-report.ts` | Posts `/sand/feedback` to the backend with a bearer token, a checksum, the app version, the platform, the OS version, the conversation id and any recent Sentry event ids. | When a person submits feedback. | It asks for the access token first, and on a box with none it returns `not-signed-in`. So a person who types feedback into our product is told they are not signed in to a service they never signed up for. | **Replace**, still open. FEEDBACK-1 owns the local path. |

## 10. Compose files, the installer, and the box image

| Locator | What it does | Measured | Decision |
| --- | --- | --- | --- |
| `deploy/coolify/docker-compose.yml` line 153, `deploy/coolify/box.compose.yml` line 112, `deploy/r750/install.sh` line 165 | Three copies of `SAND_BACKEND_URL=https://api2.cursor.sh/`. Every box created by any of the three paths points at Cursor. | Present in the running container environment on grok-bot-local-vm, and Jason reports the same on all three R750 boxes. | **Switch off**, still open. Delete all three lines. Because BOX-6 forbids recreating a live box and `docker restart` does not re-read the environment, the same effect is reachable today from `sand-host-settings.json`: `SAND_BACKEND_URL` is read through `readSandBoxSetting`, and any Cursor host, or no value at all, means mode none. So a live box already behaves correctly without a recreate. |
| Same three files, `SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json` | Points the renewer at a file. | See section 7. | **Switch off**, still open. Harmless now that the renewer does not start in mode none, but it should not be there. |
| `public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:d0bb69...` in both compose files, `install.sh` line 37 and `uninstall.sh` line 33 | The box image itself, pulled from Cursor's public ECR. | Pinned by digest, so it cannot change under us. | **Keep**, for now, with the reason stated: this is the environment image the whole product is built on, it is pinned by digest, and it is a pull at create time rather than a call at run time. Replacing it is its own project, not part of this sweep. It is named here so nobody believes the dependency is gone. |
| `scripts/box-patches/apply-start-window-fix.sh` | The only script under `scripts/box-patches`. Applies a start-window fix inside a container. | No Cursor call. | **Keep.** Checked because the contract asked. It reaches nothing outside the box. |

### What a new box starts with

`deploy/box-defaults/` is the answer to "where do the product's decisions live for a customer we
have never met". Two files, with a README saying why each pin is what it is:

| file | lands at | what it is |
| --- | --- | --- |
| `gates.json` | `/home/box/sand-data/gates.json` | eighteen gate pins. Wins over the bundled default and over any live evaluation |
| `sand-host-settings.json` | `/home/box/sand-data/sand-host-settings.json` | `SAND_BACKEND_URL` empty, so a new box is in mode none from its first boot |

Both land in the tenant's own data directory, which the provisioner already creates. The template
deliberately does **not** carry `SAND_AUTO_REVIEW_MODE`: the mode override beats the enforce switch,
so a `"shadow"` written there would look harmless and would quietly swallow an operator's later
decision to turn review on. The pin says off; the operator's switch still means what it says.

The provisioner hook itself is a next step in `docs/TENANCY.md` and a gap row, `TENANT-8`, not a
change made here. `cp/` is being edited for the admin console right now, and two hands in one
provisioner is how it stops being idempotent.

## 11. What must stay for the box to boot, and why

Nothing in this list dials Cursor. It is here so the answer to "why is that still there" is written
down rather than rediscovered.

- **`getConfiguredBackendUrl` and `DEFAULT_CURSOR_BACKEND_URL`.** Still resolve to a Cursor host
  when nothing else is set. Left in place because in mode none no caller reaches the network, and
  because replacing the constant is its own row with a broad blast radius. It is not load bearing;
  it is unfinished.
- **The privacy-mode function, its cache, and the `x-ghost-mode` header.** Kept whole. The header is
  still stamped, and still stamped privacy-safe, because a backend of ours may want it one day.
- **The Statsig 204 shim.** Kept so the SDK does not error if a client is ever built against a
  backend of ours. It now answers 204 for every URL rather than passing event uploads through.
- **The flag table, all 608 entries.** Kept as the last-resort constant. It is mechanically
  recovered from the bundle and must be regenerated, never hand-edited.
- **The box image from Cursor's ECR.** Pinned by digest. The product is built on it.

## 12. How to check this on a box

The gates line at host start is the one place the whole gate story is visible:

```
[sand][gates] {"sand_auto_review":{"value":false,"source":"local pin","pin":"host","live":true}, ...}
```

On a stock box every pinned gate reads `"source":"local pin"`. A row that reads `"source":"statsig"`
means the box has a backend of ours configured and is evaluating live, which on a customer box is a
misconfiguration. A row that reads `"source":"bundled default"` is a gate the product has no opinion
about.

A row marked `"live":true` is re-resolved by its consumer on every call, so an operator who writes
its switch into the settings file changes behaviour on a running box while the printed value stays
as it was. A row without the mark is armed once, at start, and only a restart moves it.

### The gate

`scripts/verify-cursor-free.mjs` asks the only question a customer can feel: with the road to Cursor
closed, does the box still do the work, and does it stay quiet. It cuts the box off two ways at
once, because either alone can be argued with. `SAND_BACKEND_URL` in the settings file goes to the
discard port, which is the switch a live box can take without the container recreate BOX-6 forbids,
and `/etc/hosts` blackholes twelve Cursor hosts so anything that ignored the setting and dialled a
literal URL is refused on the spot rather than hanging. A box that went quiet because the calls
quietly succeeded would prove nothing.

```
timeout 280 node scripts/verify-cursor-free.mjs            the pins, two real turns, and the window they cover
timeout 330 node scripts/verify-cursor-free.mjs --quiet    five idle minutes on their own
```

Measured on grok-bot-local-vm, 2026-09-07, on the bundle this change built:

- **16 PASS, 0 FAIL, 1 not reached** in 70 seconds. The one not reached is the since-start arm,
  which needs the host to have been up five minutes, and the gate's own restore restarts it.
- The eighteen pinned gates all agree with `deploy/box-defaults/gates.json` on **value and source**,
  and every one reads `"source":"local pin"`.
- A Shell command ran. On the R750 demo box, before this, the classifier refused every one.
- `WebFetch` of `https://example.com` came back with the page's own heading. `WebFetch` of
  `https://www.linkedin.com/company/anthropic`, a page that walls a plain fetch, came back with that
  page's own text.
- `WebSearch` on a box with no backup configured failed in plain words, naming the next thing the
  person can do, with no tool name, no service name and no vendor name in it.
- **51 host log lines over 67 seconds of real work, none mentioning cursor.** The `--quiet` arm:
  **2 lines over five idle minutes, none mentioning cursor.** Before this change the same log on the
  same box held 1,740 `[sand:privacy]` lines out of 1,742 lines mentioning cursor at all.

The gate says out loud what it does not prove. It fails on a vendor name in a reply, because that
comes from the product. It prints tool-name mentions as INFO, because those come from the model's
style, and a gate whose verdict is a model's word choice is not a gate.

`tests/cursor-free.test.mjs` is the unit half: the pin file, the fetch fallback order, and the
error text, ten cases, none skipped.

## 13. Gap rows

- **CURSOR-1** is this document plus the changes it records. Landed and measured on
  grok-bot-local-vm: the gate pins and the gates line, the loops, the web tools, the box defaults,
  and the gate itself. Still open, each named in the tables above: the shared transport, the second
  marketplace transport, post-turn labeling, the `DEFAULT_CURSOR_BACKEND_URL` constant, the prompt's
  Cursor Origin section, the auto-review router inversion, the installer's placeholder credential,
  the three compose lines, the account MCP and marketplace RPCs, and the `cursor.com` links.
- **TOOLS-FETCH-1** part (2) is closed by section 6, measured. Parts (1) and (3) stay where they
  are: the standing role on the R750 boxes, and onboarding.
- **REVIEW-2** is section 5. Amended: `sand_auto_review` is pinned false locally, so the demo box's
  state cannot recur from a remote flag. The router inversion is still owed.
- **REVIEW-3** recorded the remote flag that rejected every command on the demo box. This change is
  its durable fix: with no live evaluation possible, the flag can no longer be set remotely at all.
- **TENANT-8** is the provisioner hook that copies `deploy/box-defaults/` into a new tenant's data
  directory. Filed rather than made, because `cp/` is being edited right now.
