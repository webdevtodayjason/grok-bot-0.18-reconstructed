# Plumbing audit — working doc

**Status:** plan locked, waves not yet run. **Owner:** the session driving branch
`webdevtodayjason/gb`. **Written:** 2026-08-30, from the session that shipped
`44145cf..4a54e9c`.

This doc exists so the plan and the operating knowledge survive the session that wrote it.
It has three jobs: carry every hard-won fact with its evidence, name what is **not** known,
and hold the wave plan the next contract executes. If you are a fresh session: read this
before touching anything, and distrust any claim here that lacks a `file:line` or a date.

The failure this doc exists to prevent, named by the operator: **assumptions instead of
systematically going through the code.** Concrete instances from 2026-08-30 alone: a menu
called "fine" from a screenshot when five of its seven items were unclickable; "verified"
claimed twice while the agent view threw on every click; "only cron/slack/github triggers"
claimed when the parser supports seven kinds; three wrong root causes guessed for a wedged
agent before evidence was gathered. Every one was cured by measurement, none by reasoning.

---

## 1. System map

```
Browser ──► ui/server.mjs (127.0.0.1:7777, holds Bearer token)
                 │  relays /api/*, /events without an Origin header
                 ▼
        Host gateway (127.0.0.1:1340) ── 123 commands, POST /api/<cmd>, GET /events SSE
                 │
        host-main.cjs (patched bundle, runs in the box as root, log /tmp/sand-host.log)
                 │  spawns node:worker_threads per agent turn (SQLite isolation, NOT sandboxes)
                 ▼
        openai-compatible provider ──► whatever SAND_OPENAI_COMPATIBLE_* resolves to
```

- **The gateway 403s any request carrying an Origin header** (`source/host/gateway-server.ts:23`).
  A browser can never call it directly. `ui/server.mjs` is architectural, not a convenience.
- **An agent's only voice is SendMessage.** Transcript records replies as
  `kind: "send-message"` with the body under `message.content`. Plain assistant text is a
  private scratchpad. Counting `role:"assistant"` entries reports silence while the agent
  is replying — that mistake burned four hours once (`scripts/verify-local-turn.mjs` has
  the correct filter).
- **Endpoint resolution** (`provider-session.ts:384` → `openai-compatible-chat.ts:56-62`):
  `process.env[SAND_OPENAI_COMPATIBLE_*]` first, then the same names from
  `/home/box/sand-data/box-secrets.json`, which is **re-read with `readFileSync` on every
  request** (`provider-session.ts:161-169`). Writing that file is live config. The gateway's
  own `setBoxSecrets` refuses `SAND_`-prefixed names (`source/shared/box-secrets.ts`,
  `RESERVED_BOX_SECRET_PREFIXES = ["SAND_", "__CURSOR", "LD_"]`), which is why the relay
  writes the file directly via `docker exec` (see `ui/server.mjs`, `/endpoints/use`).
- **System prompt selection on the local path** (`provider-session.ts:153`): the request's
  `instructions` are the runner's own system messages if any survive mapping, else a thin
  fallback (`GROK_AGENT_SYSTEM_PROMPT`, :47) or router prompt (:55). **Whether the runner's
  real 281-line prompt reaches this branch is THE open question** — see §5 P1.
- **Tool loop:** `provider-session.ts:436-450` — tools via `openAiCompatibleTools`
  (AI-SDK `{jsonSchema}` envelope unwrapped by `withJsonSchemaParameters`), `maxSteps: 8`,
  runner owns SendMessage execution. `chat_template_kwargs: {enable_thinking:false}` is
  forwarded (`openai-compatible-chat.ts`), plus a bounded schema-repair round
  (`schemaProblems`/`repairToolCall`) that predates the serialization fix and is likely
  now redundant — candidate for removal after Wave 3 proves it idle.

## 2. Operating facts

**The box** — container `grok-bot-local-vm`, ports 1337/1339/1340/6080/6081/8790, all
loopback. Volumes (all survive recreate): `-workspace`→/workspace, `-data`→/home/box/sand-data,
`-store`→/var/lib/sand-box-store, `-chrome`→/home/box/chrome-profile. Bind mounts: the
patched `host-main.cjs` (read-only, from `gb/.cache/patched-host/host-main.cjs`),
box-exec-daemon and credential dirs from the gb-leaked profile, `~/.codex`, `~/.claude`.
Recreate: `bash .cache/patched-host/recreate-box.sh` (~30s to gateway-up; **currently still
carries `SAND_OPENAI_COMPATIBLE_*` env, which pins the endpoint and defeats the operator
panel — removing those lines is a pending operator decision, asked and not yet answered**).

**Rebuilding the host bundle** (for Wave 3 instrumentation): edit source, then
`scripts/host-production-activation.mjs` → `buildProductionHostIfSupplied({outputRoot})`
(needs `EXPERIMENTAL_BUILTINS = ["sqlite"]` — `node:sqlite` is real but absent from
`module.builtinModules`). The bundle is bind-mounted, so `docker restart grok-bot-local-vm`
picks it up. **A restart is not a recreate** — env and volumes untouched.

**The relay** — restart:
```sh
pkill -f "node ui/server.mjs"
SAND_PROFILE_DIRS=/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb-leaked/.cache/firstmate-profile/sand-data \
  nohup node ui/server.mjs > /tmp/ui-server.log 2>&1 &
```
Token auto-discovered from `local-docker-vm.json` under `SAND_PROFILE_DIRS`. Extra routes
beyond the proxy: `/clients`, `/model`, `/health`, `/endpoints` (GET probes each catalog
entry's `/v1/models` live; POST saves; `/endpoints/use` writes box-secrets). Catalog:
`ui/endpoints.json`; API keys live there, browser only ever sees `"set"`.

**Acceptance thermometer:** `SAND_PROFILE_DIRS=... node scripts/verify-local-turn.mjs`
— sends one prompt, exits 0 only when a `send-message` entry lands.

**Inference fleet, measured 2026-08-30 (from the Mac Studio M1? no — from macbook-pro, this Mac):**

| endpoint | serves | 26-tool schema | latency | note |
|---|---|---|---|---|
| Spark 4 vLLM `100.72.9.84:8000/v1` | Nemotron 3.5 Lightning 30B | **VALID** | 2.5s | **in use.** Was :8001 until 2026-08-30; the port moved and prompts went silently nowhere for 2 days |
| M3 LiteLLM `100.84.108.16:4000/v1` | `glm-m3` | **VALID** | 13.1s | :4000 is a **LiteLLM router** — names are aliases, served build unverified (operator believes GLM 5.3 Flash) |
| same | `qwen3.8` | timeout | >180s | |
| same | `deepseek` | backend unreachable | — | router lists it; backend down |
| Dell Ollama `100.110.83.82:11434/v1` | qwen2.5 family etc. | INVALID ≥6 tools | — | Ollama's tool shim is the limit, not model size (memory: `local-model-tool-schema-limits`) |
| Spark 2 `100.81.184.19:8000` | — | — | — | down when checked |

M3 other open ports: 1234 (silent), 3400 (TCU academy), 5000 (not OpenAI-shaped).

**Failure signatures worth knowing** (memories exist for both):
- *Silent worker:* `sendPrompt` returns `{accepted:true}` even when the endpoint is dead.
  First move is `curl <base>/v1/models`, never model debugging.
- *Wedged agent:* one agent silent while others answer; blob WAL grows with zero assistant
  output (2.5MB/123 blobs for 6 prompts). Fix: delete + recreate the agent. Root cause
  unknown; created-during-container-startup is the unconfirmed suspect.

## 3. Session ledger (what shipped, newest first)

- **2026-09-05 night (the job bus integrated, and the one seam that was not joined).** The three
  Titan Job Bus branches merged onto one trunk. Three conflicts, all of them two pieces appending to
  the same place: both deploy paths had grown their own way to pass `TITAN_JOB_TOKEN` (the compose
  had it twice as a repeated YAML key), and the console's stylesheet had two independent appends at
  the end of the file. `docs/JOB-BUS.md` gained section 10, the hardening pass, which is binding and
  wins over 1 to 9.

  The seam worth writing down: the store emits every transition as `{type:"job-bus", jobId, status}`
  through `deps.hostEvents.emit`, and the console's card listens on the gateway's `/events` stream.
  Those are two different buses. `hostEvents` is the push-notification fan-out and its only
  subscriber switches on `event.kind`, so every job transition landed there and stopped; the SSE
  stream is `SandHost.listeners`, reached through a `private emit` nothing outside the class can
  call. Both halves were written correctly to the contract and nothing joined them, which is exactly
  the shape of failure this document exists for. `wireEvents` now forwards a job-bus event onto the
  stream in its `{channel, payload}` envelope, so a client filtering with `?channels=job-bus` sees it
  and the console's `payload ?? envelope` reader gets the object the contract names either way.
  `tests/job-bus-event-stream.test.mjs` drives the real class and fails when the forward is removed.

  Measured in this worktree: 574 unit tests green, source typecheck clean, `verify-dashboard.mjs
  --offline` 22/22 against a relay on 127.0.0.1:7799. The box gates (`verify-job-bus.mjs`,
  `verify-deploy.mjs`) were not run here; the Mac box belongs to another wave. New row JOBBUS-5 in
  `GAP-ANALYSIS.md` §0 owns section 10, none of which is built yet.

- **2026-09-05 late (the Titan Job Bus, console, gates, deploy and docs).** `docs/JOB-BUS.md` is
  the contract and three pieces were built to it in parallel: the gateway's store, allowlist,
  worker and audit; the relay's `/v1` edge and its token; and this piece, the console card and the
  proof around it. Settings → Job bus reads `GET /job-bus/status` for the configured state and its
  source, mints a token that is shown exactly once beside a warning that it is never shown again,
  offers a curl example carrying `$TITAN_JOB_TOKEN` rather than a token, edits the worker mapping
  through `getHostSettings`/`setHostSettings` as `SAND_JOB_BUS_WORKERS`, and draws the jobs table
  from `jobBusList` with the contract's five status colours. The table redraws on the host's
  `job-bus` event and on nothing else, so a transition cannot throw away what the operator is
  typing into the card it is about. The adapter reads the SSE envelope by `type` and by `channel`,
  because the contract names the first and every other event on that stream carries the second.
  New gate `scripts/verify-job-bus.mjs` starts its own relay on 127.0.0.1:7791 with a random
  bearer and drives the public surface end to end, including the exact growth of
  `job-bus/audit.jsonl`; `verify-deploy.mjs` gained the two `/v1/health` checks (`401` or `503`
  without a bearer and never `200`, `200` with `--job-token`); `verify-dashboard.mjs --offline`
  renders the card in both states against the demo adapter, which grew a job bus of its own that
  reaches no network. Measured in the worktree: the offline arm green, 22/22. Rows JOBBUS-1..4 in
  `GAP-ANALYSIS.md` §0; JOBBUS-4 stays open until Jason smokes it from the CoS box.

- **2026-09-04 evening (Wave U2, and the first hours of public use).** Routines fire on the box's
  own clock with the real schedule trigger and a slot-derived run id; the trigger editor says which
  listener each event kind would need; the five local-machine tools are withheld unless the bridge
  reports a computer (30 on the wire on the R750); a rooms gate; the Learn note opens the learning
  turn; blank agents' windows released at start and orphan seats swept through the box shell. 27
  gates green, shipped to the R750 from the committed tree. The first real task on the public
  console found: the relay believing a container name docker never had (fixed), a bundle shipped
  from a dirty tree (sync.sh refuses now), Coolify pruning the locally built relay image during a
  restart (a keeper container pins it), a runaway SendMessage loop with no cap (LOOP-1) and the
  model's AddMcpServer tool crashing on a bundling slip (CONNECT-1); the last two are Wave U3.
  Coolify's service restart is asynchronous: poll the containers' start time before any gate.

- **2026-09-04 afternoon (Wave S2 and the public switch-over).** Jason's call: public on the
  domain with the relay password as the lock, inside Coolify. AUTH-3: the lockout keyed on the
  real visitor behind Traefik and Cloudflare (trusted ranges, Cloudflare edges, forged headers
  ignored, HSTS). The Coolify compose written against the parser as installed: no named volumes
  (renamed even when external, so Titan's data is mounted from the volumes' own directories), no
  single-file binds (copied into Coolify's records), no container names (overwritten; the relay
  finds the box by label), the bundle copied in by the entrypoint. Created and configured through
  the Coolify API (service, token, the relay's domain through the service `urls` field, since the
  sub-application route 404s on 4.0.0), the tailnet DNS record deleted, deployed; the public gate
  40/40 against https://tb.semfreak.dev. The TinyFish recipe in docs/CONNECTORS-TINYFISH.md.
  Also VNC-2 and AUTH-2 (the desktop through the relay; a bearer mints a session).

- **2026-09-04 morning to midday (Wave U1: login, memory, auto review; and the R750's first hours).**
  AUTH-1: a password on the relay (scrypt hash, signed session, lockout, bearer kept for scripts,
  refusal to bind off loopback without it), shipped to the R750 and proven by the deploy gate.
  MEMORY-1: `SAND_MEMORY_DREAMING` arms synthesis and the settle path finally hands the store to
  the turn; a stated fact is committed and read back in the next prompt (`verify-memory.mjs`).
  REVIEW-1: `SAND_AUTO_REVIEW` and `SAND_AUTO_REVIEW_MODE` read live, a local classifier
  (deterministic layer then model), a redacted trace, the host log no longer world-readable; in
  enforce a block instruction holds a command behind a real card (`verify-review.mjs`). The third
  verifier's newline bypass fixed by hand. Jason's first hours on the R750 found: no endpoint pin
  routed the provider (fixed: a pin routes by default), the classifier crash that hung a turn
  (fixed), the desktop frame reaching for the viewer's own machine (VNC-2, open), the composer
  status evicting the shelf utilities and a long endpoint name widening the Agent panel (both
  fixed with gate checks), the default agent renamed Titan. Setup page published.

- **2026-09-04 early morning (Wave T, teach mode; and the desktop wedge).** Learn was a Statsig
  gate with no local switch and a managed skill only Cursor hands out. `SAND_TEACH` host setting;
  the two real managed skills baked into the bundle and repaired by content in the cache; the
  recipe inlined whole (`WORKFLOW_INJECTED_BODY_LIMIT` 8000 to 16000, a noted divergence) with the
  teach queue scope; `[sand][workflow]` per invocation. Dashboard: modal only on the host's
  confirmation, refusal beside the button, cover-then-click screen, Discard and Finish through the
  host, a status poll that closes on the cap. Gates `verify-teach.mjs` (8 checks) and
  `verify-dashboard.mjs --teach`. The wave's fixer hit DISPLAY-4 for real: polls of a deleted
  agent's desktop brought windows up for nobody and their teardown stopped live agents' displays,
  then a foreign-token seat wedged every new agent until a restart. Fixed at three layers (refuse
  a gone agent before the box, tear down a window released mid-flight, the box script adopts a seat
  the host did not issue), gate `verify-windows.mjs`. Stale prompt-trace reports swept; sqlite3 in
  the box and the recreate script; the hidden blank agent's window released (DISPLAY-5 open).

- **2026-09-03 evening (Wave D1, connector plane).** Connector secrets into the server's process
  env from a host-owned 0600 store (never `connectors.json`); stable numeric ids for local
  connectors; per-tool switches and installed-server reads on the gateway; honest empty catalog;
  connector cards with real switches, a connectors editor, key forms, the masked secret card
  answered, local Connect/Disconnect. Gate `verify-connector-plane.mjs`. Residual owned:
  CUSTODY-1 (agent shell runs as root in the same container). Tools §2 corrected against the
  teardown's 40-function catalog; `AwaitExternalShell` restored as the wire name.

- **2026-09-03 (Wave C, dashboard).** Acceptance status after every send, transcript tail with
  paged scroll-back, Skills panel on the nine workflow commands, hand-back and Updates, channel
  state on cards, agent editing with avatars and toggles, inline attachments, Cmd-K search, widget
  dismiss. Security finding on the way: the recreate script mounted `~/.claude` and `~/.codex`
  read-write into the box (MOUNT-1 in GAP-ANALYSIS §0); mounts removed from the script, recreate
  pending. ENDPOINT-1 / §5 P3 closed on inspection: the live container has no endpoint env pin.
  The gate pass forced three host fixes: deleted agents now release their shared-desktop window
  (DISPLAY-1); deleted agents are tombstoned in `agents/deleted-agents.json`, readers skip them,
  the roster sweeps a resurrected directory, `withAgentDb` refuses them, ledger writers never
  recreate a deleted directory, `[sand][agents]` logs every mint and createSession with its
  caller (PHANTOM-2); the desktop capsule clamps long names (CAPSULE-1).

- **2026-09-03 (host wave E1, by hand during the Anthropic 529 outage).** Unread raise path fixed;
  `getAgentActionAudit` reads the action ledger; browser screenshots reach the model as image
  parts; `[sand][gates]` table at host start; maintenance switches (`SAND_STALE_ROOT_GC`,
  `SAND_RETIRE_LEGACY_STORE_BLOBS`, `SAND_CONVERSATION_GC`) read the host settings file; dead code
  gone; `agent-upserted` no longer fires for an unchanged summary; standalone box reports window 0;
  CloudAgent withheld unless `SAND_CLOUD_AGENTS=1` (it was silently dropped from the wire: 36 offered,
  35 sent). Gates: `verify-gateway-reads.mjs`, `verify-toolset --mcp-instructions`, chief mode asserts
  offered == sent. The ChatGPT/Codex backend answered 404 to the Codex CLI itself that morning, so the
  gate pass ran on the Alibaba subscription.

- **2026-09-03 (Waves A and B, `526a013` + browser follow-up).** GetMcpTools/CallMcpTool reach the
  model (the per-turn MCP projection is handed to the tools handoff); the production prompt carries
  memory, routines, skills and channels; per-turn connector instructions and the discovery notice
  are real; compaction epoch is real; computerUse subagent gets 3 tools; CloudAgent gate resolves;
  browserUse subagent offered behind `SAND_BROWSER_USE` and proven end to end after four further
  faults (prompt-glue identity, missing tool parameters, execute calling order, preflight
  failure shape — `docs/GAP-ANALYSIS.md` §0). Subagents get their own prompt assembly and audit
  identity. Machine Room: every modal truthful, Connectors group with real tool rows, evidence
  pill opens receipts, memory panel, unread clears. New host switches in
  `/home/box/sand-data/sand-host-settings.json` (`SAND_TOOL_TRACE`, `SAND_BROWSER_USE`); host-log
  lines `[sand][toolset]` (offered) and `[sand][wire]` (sent). Gate: `scripts/verify-toolset.mjs`
  (chief / --subagent / --connector / --browser). Suite 126/126. Regression caught by the gate
  pass and fixed: subagent ledger dirs surfaced as phantom "New Agent" rows because minted
  subagent ids (`subagent-`) never matched the shared `sand-subagent-` predicate; ids aligned,
  roster enumerations skip ledger dirs, gate asserts no phantom rows.

| commit | what |
|---|---|
| `4a54e9c` | Desktop iframe mounted once (no more VNC reconnect storm); `vnc_lite` (no control bar, interactive); Settings view (localToolPermission, auto-review, WebAuthn proxy, notifications, provider, TZ) |
| `74ee927` | Operator Endpoints panel (Router view): live probes, "Use this" writes box-secrets; pinned-by-env warning; dock refetch bug |
| `1048d8c` | Injection test: 8 hostile payloads through `markdown()` stay inert (esc-first is load-bearing) |
| `2b4f1d0` | Select fetches transcript (null ≠ empty); markdown renderer in bubbles; scroll padding |
| `5a35be6` | Trigger menu into the flow — 5/7 items were mouse-unreachable under `.sect{overflow:hidden}` with 14px rail travel; `page.click()` passed anyway (scrollIntoViewIfNeeded lies) |
| `0fe7408` | Rail accordion IA: click worker → others step aside, sections beneath (Persona/Listens on/Routines/Knows/Desktop); click again → roster back |
| `76a1f62` | Composer Talk-only… superseded by 0fe7408's IA; Enter-to-send; scroll anchored to real scroller |
| `fe5b544` | Restored `renderStage` (deleted 3 commits earlier, call site left; agent view dead the whole time) + `tests/ui-views-render.test.mjs` |
| `44145cf` | Trigger stack: all 7 kinds round-trip verified live; routine editing; client-side checks for what the host silently drops |

Tests: 48 passing (`npm test`); UI suite renders every view against a stub DOM and
adversarially tests the markdown renderer. Browser harness (Playwright) lives in the
session scratchpad `browsercheck/` — **scratchpad dies with the session**; the durable
technique is §4.

**2026-09-05, afternoon (measured on the Mac box, bundle 117b6235; the R750 receives it with the next ship).** CONNECT-3/4: TinyFish by API key with no bridge (mcp-remote with the key as a Bearer header from the secret store; the credential card offers only empty-valued env keys; the editor's Arguments field is quote-aware; a preset owning its name replaces an entry). Connectors wave: five primary-source reports by Orca workers (Codex, Grok) in docs/connectors/, a preset catalog (GitHub, Slack, Linear, Google Workspace, TinyFish), per-service gate arms, docs/CONNECTORS.md, and shell tools with their own secret store (CodeRabbit CLI, TinyFish CLI). CONNECT-12: the routed tools cache kept a starting server's empty answer for a day; fixed with a 5 s TTL for provisional answers. Process findings, each filed: two integrators on one box void each other (GATE-2, scripts/on-box.sh); a timeout kill skips a gate's cleanup (GATE-4); the model leg after the gate's own restart fails about half the time (GATE-5); a removed connector's secrets cannot be deleted (CONNECT-11); a message to a workflow subagent resumes a duplicate of it (memory). Gate tallies on the fixed bundle, first runs: --linear-key x2, --google-stdio x2, --tinyfish-key, --slack-stdio, --github-key, --shell-secrets, verify-toolset --connector, gateway-reads 11, windows 15 all green; the plain arm green on its third run.

**2026-09-05, evening (measured on the Mac box, bundle 50557b52 on the R750 since 21:16).** The Marketplace: one catalog (`source/shared/marketplace/catalog.ts`, nine plugins, six bot templates) served by `listMarketplace` and `getMarketplaceItem`; the console's Global capabilities panel became the Marketplace with Plugins and Bots tabs in the original product's shape; providers and chat listeners moved to Settings; the agents' SearchPlugins, GetPlugin, InstallPlugin and UninstallPlugin resolve against the same catalog (they had pointed at Cursor's marketplace, unreachable from this box); Import Bot mints an agent whose description carries the template's persona and imports its skills. Gates: --plugin-tools 27 ok, dashboard 221/221 clean, deploy gate green. Filed: BOTS-2, BOTS-3.

## 4. Verification doctrine (earned, not theoretical)

1. No claim without `file:line` or a captured artifact. "It seems" is not a finding.
2. Grep locates; only reading concludes. Files on a critical path get read end to end.
3. The wire outranks the source. Where they disagree, the capture wins.
4. `page.click()` passing is NOT evidence a human can click — Playwright's
   scrollIntoViewIfNeeded sets scrollTop even on `overflow:hidden`. The honest test is
   `elementFromPoint` at the element's centre after wheel-only scrolling.
5. A UI claim is verified in Chromium or it is unverified. `node --check` proves parsing;
   a deleted function with a live call site parses fine and dies on first click.
6. Every report carries an explicit "did not verify" list. Its absence means the report
   is wrong somewhere.
7. One tool proves nothing: probe models at the real tool count (26).
8. Re-measure when the serving stack changes — a conclusion about "local models" that was
   actually about Ollama's shim cost three days.

## 5. Open problems, ranked

**Ranked backlog moved 2026-09-02:** `docs/GAP-ANALYSIS.md` holds the 90-finding gap analysis
(87 verified, 3 refuted) with the wave plan. This section keeps the host rows and their history.

**P1 — CLOSED 2026-09-02, cause named.** Hypothesis (b) was the answer, twice over: the dispatch
tools were not in the toolset this path offered, and the computer tools sat behind a projection the
engine never populated (§6g, §6i; `host-runner-composition.ts:2505-2525`). The one remaining sliver
is the browserUse subagent, still not offered — tracked as SUB-1 / TOOLS-03 in GAP-ANALYSIS. Original
symptom, for the record: said *"Launching the browser subagent now"* while `getSubagents` → `[]`.
A second contributor was found by the 2026-09-02 audit and is P0 there (SP-1): the production
system prompt is handed null memory, routine, skill and channel providers, so the agent narrates
from a prompt that never shows it what it has.

**P1b — FIXED 2026-09-02 23:15 CDT (`token-limit-error-classification.ts`, four wordings added, unit cases for LiteLLM, OpenAI/vLLM, xAI; suite 111/111). Original entry follows.** The token-limit classifier knew only xAI's wording. LiteLLM says
`exceeds the available context size`, OpenAI/vLLM say `maximum context length is … resulted in`,
and none of them match `classifyTokenLimitErrorFromMessage`, so on every local endpoint an
oversized request errors the turn (`Agent failed to respond`) instead of entering the
rescue-and-compact path verified in §6j. Seen live twice on 2026-09-02: the 295k-token long-lived
agent, and fresh agents whose 35k base prompt exceeds the M3 router's 32k cap. **Owner:** Jason
(a Claude session executes). **Next action:** add the three phrasings to the classifier in
`source/packages/chat-inference/` (corrected path; the host only calls it), then run `verify-compaction --recover` through a proxy that
answers with each wording. **Proof of closure:** the long-lived agent recovers on `m3-glm` once the
router's cap is above the base prompt. Deferred from the evidence contract because that tree was a
named non-goal; nonblocking for that contract, blocking for long-lived agents on local models.
Mirrored to Dart when the token works again (the public API answered 401 on 2026-09-02).

**P1c — FIXED 2026-09-02 23:15 CDT (`send-message-tool.ts`: 20 sends per turn, consecutive duplicates suppressed, one host-log line each; replay round 4 delivers 1 of 30 identical sends with 29 cap lines). Original entry follows.** No per-turn cap on SendMessage. On the rubric's growth prompt
("run `seq 1 2000 …`, send me only the last line"), `grok-4.20-0309-reasoning` emitted hundreds of
identical `SendMessage` calls per completion: 1,012 sends in 8 turns, 371 items in one turn, one
message a second until the rubric was killed and the agent deleted. The host executed every call.
grok-4.6 and Nemotron never did this on the same prompt. **Owner:** Jason (a Claude session
executes). **Next action:** cap sends per step and drop consecutive identical messages in the
SendMessage tool path, with a host-log line when the cap trips; add a runaway guard to the rubric
(stop the agent when replies in one turn exceed 20). **Proof of closure:** the replay provider
returning 50 identical SendMessage calls in one response yields one delivered message and one
capped-line in the host log. Cost of the incident: a few dollars of xAI credit (bursts within
completions, not a thousand completions).

**P2 — DONE (wave 2, `docs/audit-wave2-toolset.md`).** 26 factory slots → 55 distinct tool names →
34 offered to a chief with the box up (CloudAgent is the 34th). Reconciled against the gateway's 123
commands in `docs/GAP-ANALYSIS.md` §2; the two real gaps are the MCP meta pair (TOOLS-01) and the
browserUse subagent (SUB-1).

**P3 — CLOSED 2026-09-03 on inspection: the live container carries no `SAND_OPENAI_COMPATIBLE_*` env (the 2026-08-30 recreate dropped it) and the relay's switch sticks. Original entry follows.** Endpoint pinned by container env. The operator panel is built and honest about
this (red banner). One recreate without the `SAND_OPENAI_COMPATIBLE_*` lines hands the
switch over permanently. Asked; awaiting "go". Structural, not just operational: container env
always beats the relay's switch (GAP-ANALYSIS ENDPOINT-1 offers the inverted-precedence alternative).

**P4 — Per-agent screens.** Upstream: "each Bot gets its own screen." Our box: one X
display (`/tmp/.X11-unix/X1`), the token-routed websockify on :6081 running with an
**empty** token dir. The fork machinery exists (`box-windows.ts` `runWindowScript`,
window indexes, "live fork owned by a different agent" error path; `sand-window-router.mjs
1339 1337 14000`). Real work, not a flag. **Owner: the box image (§6f), not host code** — the
host machinery is live; the standalone fallback that blanks the VNC url is a separate, smaller item
(GAP-ANALYSIS BOX-1).

**P5 — Event churn.** `agent-upserted` fires every few seconds idle. The UI diffs it away
now, but the host-side chatter is unexplained. Host-side fix named in GAP-ANALYSIS CHURN-1: compare
the rebuilt summary with the cached one and return early when nothing changed.

**P6 — cosmetic.** Trigger-row controls wrap loosely in the 432px rail. Now lives on the
secondary page (`/operator/`), which is why it stopped being noticed (GAP-ANALYSIS BL-P6).

**P7 — CLOSED 2026-09-03: the substrate was decided 2026-08-18 (OOMOL OpenConnector, pinned, as a sidecar; `docs/CONNECTOR-PLUGIN-PLANE.md` now points at the journeyman record). Original entry follows.** No decision existed anywhere in this repo
on whether this product owns its connector plane. Local stdio connectors work end to end today
(`connectors.json` → box process → 14 tools discovered) but nothing reaches the model until
TOOLS-01 lands, and every marketplace, OAuth and remote-server verb is a Cursor RPC on an expired
stub. **Owner:** Jason. **Next action:** choose stdio-only (works now, no marketplace) or a local
HTTP MCP client plus manifest catalog (owns the plane, L). **Proof of closure:**
`docs/CONNECTOR-PLUGIN-PLANE.md` exists and names the choice; Wave D is scheduled against it.

**Corrected 2026-09-02 (GAP-ANALYSIS MODEL-1):** `settings-service.ts:33` exposes
`agentDefaultModel` and `computerUseModel`, but on every routed (non-Cursor) provider the session
is created before those fields are consulted (`cursor-session.ts:115` returns to
`createProviderPromptSession` first; `provider-session.ts:552-553` fixes one model per provider).
Seniority-as-routing therefore needs a per-session model override threaded through the routed
branch — a design contract, not a half-hour wiring job. Schedule after Wave A; it is the token-bill lever.

## 6. Upstream intent (condensed from docs.x.ai/grok-bot, supplied 2026-08-30)

What the product is *supposed* to feel like — Wave 4's yardstick:

- One cloud computer per **user**; all Bots share files/sessions/logins; screens are
  work surfaces, **not** security boundaries. Bots ≤50/account.
- Work rhythm: acknowledge → work out loud → show proof (screenshots/files) → close the
  loop in SendMessage. Choices go through **widgets**, never prose menus.
- Credentials/2FA/CAPTCHA: Bot hands the human the computer (**takeover**), never chat.
  Secure secret requests are masked and bypass the model.
- **Connectors ("Plugins")** are account-wide; `@` attaches connectors/Bots/routines,
  `/` references skills. **Skills** = how; **routines** = when (≤50/Bot, 20 run records).
- Auto Review: Require-Approval rules beat Always-Allow. Local execution: ask/allow/never
  (all three now surfaced in our Settings view).
- Group chats: 2–6 Bots, `@`-directed, bot→group handoffs text-only; bot→bot DMs wake the
  receiver (async).
- Upstream has **no model picker** — our Endpoints panel is a deliberate divergence, since
  the entire point of this rebuild is owning the inference bill.
- Teach-a-task: ≤10min browser recording → draft skill. Recover < Update < Reset ordering
  for computer trouble.

Operator note: real-Grok-Bot screenshots were offered and requested (routine editor,
approval card, widget, Agent Computer + takeover, group chat, Settings→Plugins). Attach
them to Wave 4 when they arrive.

## 6b. Wave 4 evidence — real-product walkthroughs (2026-08-30, operator screen recordings)

Two narrated recordings of the operator's live Grok Bot deployment, dissected with
`scripts/dissect-video.sh`. These are ground truth for Wave 4; frames legible at full res.

**Video 1 — chief/desktop/routines tour (219s):**
- **Per-agent screens are real and central.** Each Bot's right rail shows *its own* live
  screen thumbnail + *its own* routines list ("Chief of Staff's screen" vs "Awesome3D Dev's
  screen", the latter with one paused routine). Thumbnail → hover **Open** → full-window
  interactive desktop (he drove Chrome and a Terminal, `box@cursor:/workspace`, Debian-ish,
  copy/paste works; desktop is minimal: file manager + console). Right rail toggles via a
  computer icon in the conversation header.
- **Teach a task** button lives in the desktop view's top bar. Operator: "I click this
  button and it'll start recording. I can narrate and go through a scenario… and it will
  turn that into a routine." Narrated recording → automation. (Our plumbing:
  `teach-recording/teach-recording-service.ts`.)
- Conversation: task cards (Done badge, "View PR ↗", "Open in Cursor"); bot-to-bot chatter
  collapses to "5 messages with ◆ 2 Bots" rows that **expand on click** into the inter-bot
  conversation; inline code chips; per-Bot settings panel (name, label, description, avatar
  with Bot/Generate-AI/Upload/Reset tabs, notifications toggle, **Share as template**).
- Routine rows read as name + humanized schedule; detail panel has **Test run**, Active
  toggle, Delete, and **run history with per-run rows + checkmarks** ("Last Friday at
  7:22 AM ✓"). Operator: bots are "very interactive in making their own routines all the
  time, and they're always active."

**Video 2 — creating a routine (240s):**
- **Routines are created conversationally, by the agent itself.** Operator asked Atera
  Agent in chat for an hourly weekday ticket watch; the agent named it, wrote its own
  safety-scoped instruction (read-only; no Passwords/API/secrets pages; no
  assign/close/comment; tight output list; cc Chief of Staff; "do not change the tickets"),
  materialized "hourly 8:28–6:28" as removable concrete times, emitted **"Created routine ◉"
  / "Updated routine ◉"** transcript chips, and confirmed in prose with a live pre-check
  ("Nothing named Brashear in Atera right now… which is what we want"). Plumbing hook:
  `sand-state-tool.ts` (`update_state`, cronTrigger) reaches the local model path: measured
  2026-09-04, `update_state` is among the 35 tools offered and sent on every chief turn, and the
  learn-from-demonstration recipe saves its skill through it.
- **Webhook triggers are minted server-side on save:** fields show "Loading…" then fill
  with `POST to https://api2.cursor.sh/automations/webh…`, a `crsr_…` key, and an
  `Authorization: Bearer` header. Production use: "Atera new-ticket dispatch — When a
  webhook fires." Local equivalent = relay mints URL + feeds the gateway event path
  (Wave 5 candidate).
- Trigger picker parity: same 8-item menu (incl. Webhook), same Linear
  created/status/end-of-cycle + projects/teams fields, Advanced = Months / Days / Times
  list. Chief's production routines span cron, Slack mention/keyword, GitHub PR events,
  and webhook — the full stack in daily use.
- Missing from our UI (now known targets): Test run, per-run history rows, "Agent is
  working" status line, "Message from Chief of Staff" attribution on bot-to-bot rows,
  unread "16 new messages" pill, expandable bot-to-bot rows, routine created/updated chips.

**Video 2 narration, three additions the frames could not show:**
- **Screens go dormant with their Bot.** "It doesn't always stay active… if they're dormant,
  I think their screen goes dormant." Per-agent screens are lifecycle-bound to activity —
  matches the fork-window claim/release machinery (`box-windows.ts`), not a static allocation.
- Operator reads the webhook plumbing the same way we do: "it looks like it's going through
  cursor to do that; that's probably built in."
- **Routine density is org design:** "the reason Chief has so many is because Chief is
  pretty much telling other people what to do, so they don't have to have a routine."
  Schedules concentrate at the manager; workers stay message-driven. That is the pattern the
  manager's-desk UI should make natural, not fight.

**Video 3 — plugins / connectors / skills / MCP, plus the config area (355s):**
- **A plugin is a bundle: MCP server + skills + connectors + accounts + per-tool toggles
  + setup values.** GitHub plugin detail: View Source ↗ / Uninstall; **Accounts** with
  labels and multi-account ("+ Add Another Account", Authorize); **Tools: 47 of 47
  enabled** with a per-tool switch each; **Setup Values** (Edit Values); **Connectors: 1**.
  Featured entries say it outright: Notion is "Notion Skills + Notion MCP server packaged
  as a Cursor plugin"; Slack is "Slack MCP server…".
- **The marketplace is the Claude Code plugin ecosystem.** His own CC plugins surface as
  Team plugins: ponytail, titanium-toolkit, claude-mem, hookify, plugin-dev, coderabbit,
  codex (3 skills listed), document-skills. Header: "21 installed · 12 private". Categories:
  Featured / Team / Agent Orchestration / Canvas / Customer Support / Data Analytics /
  Design / Documents & Files / Finance & Legal / Inbox & Collaboration / Infrastructure /
  MCP / Payments / Productivity / Research / Sales / Scheduling.
- **Skills a Bot saves become private plugins**: "Dark-web client notify — Created
  locally", "GDAP audit and plan — Created locally", "Operate Atera". The save-as-skill
  flow and the plugin surface are one system.
- Install = Add, or setup-values-first (HubSpot asks Client ID/Secret from "Development →
  MCP Auth Apps"). Installed list shows per-plugin status: Connected, or **Error** in red
  (Railway). "Create Plugin" is itself a marketplace plugin.
- **Config area (came free in this video):** Settings modal with General / Computer /
  Usage & Billing / Updates. Bot section: timezone auto-detect, **Auto-review** toggle and
  **natural-language per-action rules** — "When Grok Bot wants to: [text] It should:
  Allow automatically | Ask first", plus a live rules table (e.g. "Allow CDP
  Runtime.evaluate calls to read page state", "Allow shell commands to post SHORT hot
  ticket re-lights…") each with edit/delete. Footer: "These rules apply only to you.
  Built-in safety checks always apply." Security Key section below. Computer tab: current
  computer name + "Execution on this computer … Always allow" dropdown. Account menu:
  update banner, Weekly usage %, iOS app, Settings, About, Help Center, Send Feedback,
  Log out.
- **Our plumbing already models nearly all of this** (Wave 2 must confirm reach):
  `settings-service.ts` carries `autoReviewInstructions.{allowInstructions,blockInstructions}`
  (the NL rules lists), `mcpBoxServers`, `mcpDisabledToolsByServerId` (per-tool toggles),
  `mcpCustomInstructionsByServerId`; `extensions/mcp/{mcp-service,plugin-skills,
  skill-publish,production}.ts` and the `sand-auto-review*.ts` runner files exist unread.

**Video 4 — installing a plugin, the full auth lifecycle (136s):**
- Add → toast **"✓ Added Granola and 3 skills"** → detail shows Accounts "default —
  **Needs auth** [Authenticate]".
- Authenticate opens the **user's own system browser** at the vendor's hosted MCP auth
  (`mcp-auth.granola.ai/authorization_session…`) → vendor sign-in (SSO/Google/Microsoft) →
  Google account chooser → consent screen "**Cursor** would like access to your account"
  → redirect to **`localhost:8767/callback?code=…&state=…`** → "Authorization complete!
  You can close this tab." → app flips the account to **Connected**.
  The desktop app runs a local OAuth callback server on **:8767**. Our gateway's
  `completeMcpOAuth` is implemented (`host-gateway-api.ts:768-776` at 4f83232, validates stateId + code
  and calls `mcp.completeOAuth`); corrected 2026-09-02, it was recorded here as a stub. What is
  missing is the callback server itself, which lived in the Electron main — a local
  re-implementation belongs in the relay (GAP-ANALYSIS CP-06, after the CP-14 substrate decision).
- After connect: **Tools 6 of 6 enabled** (Query granola meetings, List meetings, List
  meeting folders, Get meetings, Get meeting transcript, Get account info), per-tool
  toggles; Connectors: 1 ("granola"); Skills: 3, each with claude-code-style activation
  guidance ("granola-context — …Use when someone asks about a past discussion…").
- Context7 installs with **no auth step** — Connected immediately, 2 tools, 1 skill
  ("context7-mcp — …Activates for set…"). Install counter ticked 22 → 24 across the video.
- Auth-needed vs auth-free is per-plugin; a not-yet-authed plugin sits installed with a
  "Needs auth / Reopen" chip rather than failing.

**Video 5 — the approval card, fired live (170s):**
- Card anatomy, inline in the conversation:
  `⚠ Allow Grok Bot and all Bots to run commands on your local computer?` /
  `MacBook-Pro.local` / "This applies to Grok Bot and every Bot. It can always be changed
  in Settings." / expandable **› Show the command** / **[Always allow] [Allow once]
  [Never]** / dismissable ×. After allowing, a status ribbon divider appears in the
  transcript: "Grok Bot can run commands on your computer."
- **Precedence lesson, demonstrated:** saved Always-allow auto-review rules keep matching
  even after the master execution setting flips to "Ask every time" — writes sailed
  through card-less until the leftover rules were deleted. The bot knew this and said so.
- **The bot orchestrated its own permission test**: wrote grok-bot-approval-test.txt to
  the Desktop, diagnosed why no card fired, told the operator exactly which two settings
  to flip, asked to be pinged, fired again. Working out loud at its best.
- **Settings deep-links inside bot prose**: "⚙ Execution on Local Computer" and
  "⚙ Auto-review" render as chips with a hover card ("Settings · Computer — … → Show me
  in Settings") that opens the exact settings row. Operator: "I love the fact that you can
  link internal settings with the cogwheel settings links." (Our plumbing:
  `send-message-shaping.ts`, `listener-connect-cards.ts` — unread, Wave 1/2.)
- **Threaded replies**: replying to a specific bot message quotes it above the composer,
  the exchange indents under the quoted message, and jumping to it flashes the original.
- Security Key setting sighted: "Use hardware security keys … (such as a YubiKey) … You'll
  be asked to approve each use" — the `webauthnProxyEnabled` surface.
- Gateway commands that must carry all this (Wave 2 targets): `resolveLocalToolPermission`,
  `resolveAutoReviewApproval`, `respondToWidget`, `promptAcceptanceStatus`,
  `sand-permission-request.ts`.

**Video 6 — the masked secret request, end to end (218s):**
- The bot explained its own secret model on camera, three paths: (1) connector sign-in —
  "I pop a connect card, you authorize in place, and the token never hits the transcript";
  (2) raw API token — "I send a masked field instead. That value goes straight into that
  connector's credential file. I only learn that you submitted it"; (3) console logins —
  "stay on my computer: you fill them from 1Password, including 2FA. I never see the
  password." Not a generic vault: a masked field is **tied to a connector + field name**.
- The card, live (after the bot looked up the real connector and field itself —
  "Connector is Context7, field is `CONTEXT7_API_KEY`. Don't paste the key in chat."):
  `Context7 API key` / "Paid Context7 key so lookups use your account, not the default." /
  masked input / **[Save securely]** / "🔒 Stored securely, never shown to your Bot."
  On submit it flips to **✓ Saved — "Saved securely and kept private."**
- **The bot then verified the secret took effect**: "Key's in. Checking that Context7
  actually picked it up." → "Connector shows connected, but a test lookup still hit the
  free quota. Restarting it so it can pick up the key." Closing the loop on a credential
  without ever seeing it.
- Plumbing map: `sand-secret-request.ts` (the tool that emits the card) and the gateway's
  `submitSecret(entryId, value, agentId)` both exist in our source — Wave 2 confirms reach.

**Video 7 — group chat (393s):**
- **Groups are "Channels"** (# icon). Create: + → New Channel → name + bot checkbox
  search, picks become removable chips → Create. He built "MSP Team" with six members
  live. Group rail: **Members** (avatars, hover → Remove, + Add Member) and the group's
  own **Routines** list with Create Routine — a group is an agent here too, matching our
  `isGroup`/`memberIds` model exactly.
- **Turn-taking is serialized rounds.** Roll call: "Chief of Staff is working…" → "here"
  → "Atera Agent is working…" → "here" → "ClientSync Tester is working…" — one bot at a
  time, in order. The operator had already noticed ("you take turns and seem to do it in
  rounds"). Maps to `group-chat.ts` GROUP_CHAT_TAG_PREFIX turn prompts in our source.
- **Bots @-mention each other as chips** and self-organize ownership: "🔶Titanium
  Marketing can say if that is the brief. 🔶Product Story owns the one-liners." The
  marketing channel produced a real converged brief ("No SEO rewrite. One product row on
  the MSP homepage. That is the brief.") with self-imposed approval boundaries ("Draft
  only. Git when you name it." / "The row stays honest until you say otherwise.") — and
  took a 🙏 reaction gracefully.
- Messages carry colored sender labels above bubbles; threaded replies work in groups;
  group settings panel has avatar (Generate/Upload), name, description.
- **Command palette**: global search with kind chips All / Messages / Bots / Channels /
  Files / Links / Routines / Actions — Actions rows are settings deep-links (Chat
  Settings, Settings: General/Computer/…, Plugins, Theme).
- Masked-field epilogue (precision worth keeping): the popup wrote a **channel
  credential**; the bot explained it does NOT inject into the docs plugin's setup values,
  and offered the reinstall-with-setup-field path — two distinct secret stores, named.

**Video 8 — teach-a-task, with the upstream prompt itself (160s + pasted artifact):**
- The operator captured the **verbatim learn-from-demonstration workflow prompt** — the
  only upstream orchestration prompt we hold in full. Preserved at
  `docs/upstream-teach-prompt.md`. Headlines: skills are written with **`update_state`
  (target "workflow")** and link as `sand-workflow:<id>`; a **`watchVideo` subagent**
  takes ≤15MB video attachments (lossless 12MB segment splits); a filesystem queue at
  `/workspace/teach-sessions/queues/<scope>/` with flock claims and 12h leases; read-only
  browser-evidence cross-check (DevTools `/json/list` + a *copy* of History sqlite, with
  explicit never-drive-Chrome rules); and the closing law: "**Execution and delegation
  are owned by the parent system prompt**" — direct confirmation the parent prompt exists
  and skills must not encode harness mechanics.
- The prompt is inspectable in-product: `learn-from-demonstration — Managed by Cursor`
  appears as a workflow with editable Name/Description/**Instructions** — that field is
  where the operator copied it from. Cursor ships managed workflows beside user ones.
- **The prompt ran on camera, beat for beat.** Recording UI: title bar "Marketing
  Channels is watching and learning" + red timer. On stop, a card lands: "The recording
  is finished. Learn the task from it. [⚙ Learn from demonstration]". The agent then
  narrated the numbered steps live: "Watching the demo now. **Claiming the recording
  first.**" (step 0) → "Got a 76-second recording. **Checking two frames** before I watch
  the whole thing." (step 1) → "Frames look real. **You signed into PressLoom**, then it
  started analyzing a site. Watching the full clip now." (step 2) — note the credential
  handled exactly per the sensitive-info rule: named as a sign-in, never transcribed.
- Graceful cancel: "Disregard that, it was a bad lesson" → "Canceling that one. I will
  not save a skill from it. Recreate whenever you are ready." Sidebar preview: "Dropped.
  Waiting on the new recording."
- The demo itself ran on the **agent's own screen** (Marketing Channels's screen
  thumbnail mirrored it) — teach recordings are per-agent-screen captures.

Raw narration transcripts and full frame sets live in the session scratchpad (`vid1/`,
`vid2/`); scratchpads die with the session, so anything load-bearing is written here.
Requested next recordings: Plugins (covers connectors), then the config area.

## 6c. Warmwind teardown — the frontend reference (2026-08-30, `Warmwind.mp4`, 319s)

Supplied after the coherence critique, to answer "what does elegant actually look like here."
Dissected with `scripts/dissect-video.sh`; narration in the operator's own words.

**The structural finding, which invalidated the first coherence pass.** Warmwind is not a
dashboard with panels. It is **one canvas**: a single rounded surface, inset from the window,
filled edge to edge with a photograph. Small glass objects float at the canvas edges; the middle
is deliberately left open for whatever the worker is doing. The first coherence pass built five
boxes in a CSS grid and darkened them, which is why it had dead space no colour change could fix
— a grid has to fill itself, a canvas does not.

**The parts, by position.**
- **Top centre** — a white dock pill hanging off the canvas edge: connected app icons plus a "+".
  Signed-out apps are greyscaled, never badged red.
- **Left edge** — a vertical stack of window thumbnails (Files, Gmail Webversion, Google Chrome,
  Wind Sheets), each a small titled card with a live screenshot. These are the windows open on the
  worker's computer. Clicking one brings it up full size in the middle.
- **Middle** — free. Holds whichever of three things is true: the finished report, the app the
  worker is driving, or nothing but wallpaper. The conversation floats over it in a ~460px centred
  column, masked so older turns fade upward rather than scrolling under a hard edge.
- **Right edge** — two narrow dark-glass cards: schedule state (with the pause control) and the
  plan, whose steps sit on a hairline rail with green checks and the app icon each step touches.
- **Canvas corners** — `History` bottom-left, `Hide chat ⌄` bottom-centre.
- **Below the canvas** — the worker bar on the app's own light ground: `+ New worker`, worker
  pills, and in the centre either the composer or the stop control.

**"Hide chat" is the answer to the desktop problem.** Dismissing the chat un-dims the wallpaper
and the desktop comes forward, sharp and full size. The desktop was never a thumbnail in a panel;
it is the ground the whole product stands on. Ours is a live VNC frame, so the same move works
verbatim: blurred and darkened behind the conversation, sharp and interactive when dismissed.

**Colour.** The entire product is white and black glass over a photograph — with exactly **one**
saturated colour, a hot pink, spent only on the stop control for a running worker. Its presence
alone reads the state from across the room. Nothing else competes.

**Contrast, which is what the operator flagged.** Text over a photograph gets its own ground: the
reading column sits on a soft dark scrim, and body copy carries a faint text-shadow. The dark
glass is for anything that must stay legible over a bright desktop; the light glass is for things
the eye should read as lifted toward it. Direction of conversation is encoded as *material* (dark
= worker, light = you), not as colour, so it survives any wallpaper.

**Motion** — the operator replayed the launch three times to make the point. Everything builds in:
opacity plus a small rise and scale, staggered ~55ms, with the right-hand cards springing in from
the edge on a slight overshoot. Nothing slides, nothing bounces hard. Thinking is a plain line of
text with a three-dot shimmer — *"Reasoning carefully…"* — not a card, because it is the worker
being quiet rather than a system event.

**Onboarding worth stealing later.** Creating a worker asks "Choose an intelligence level" —
Lite / Balanced / Pro, each with a price per hour. That is model selection stated as capability
and cost rather than model names, and it is the natural home for the per-agent provider+model
routing already queued as Wave 5 #12.

**Where this landed.** `ui/mock.html` — a standalone static mock of all four states (idle,
operating, background, completed) with no gateway, SSE or tests attached, so the design can be
judged without a live renderer fighting back. Published at
`https://artifacts.semfreak.dev/a/grok-bot-reconstructed/mock-2eb3180f/`. It is the design source
for the port onto `ui/index.html`; it is not wired to anything and must not be.

## 6d. The Machine Room frontend (vendored handoff, wired 2026-08-30)

The operator built and supplied `warmwind-agent-frontend-handoff-v2`: a framework-free frontend
carrying the approved design, our own vocabulary (Workers, Rooms, Machine Room), and — the part
that made it adoptable in an evening — an explicit adapter seam that deliberately invents no
gateway endpoint names. It supersedes `ui/mock.html`, which is deleted; one design source only.

**Where it lives.** Vendored verbatim at `ui/machine-room/`. `app.js`, `adapter.js` and every
stylesheet are byte-identical to the handoff, per its README. This repo authors exactly two
things inside that directory: `gateway-adapter.js`, and a five-line boot loader in `index.html`
that reads the gateway before `app.js` constructs its adapter.

**How it binds.** `gateway-adapter.js` loads after `adapter.js` and takes over the
`createDemoAdapter` factory `app.js` already calls, so no view code changed. The demo factory is
kept as `createDemoAdapterOffline`, and if the gateway is unreachable the page still comes up on
demo data with `data-demo="true"` stamped on `<html>` — a demo is never mistaken for the machine.

| Adapter method | Real gateway |
| --- | --- |
| `getSnapshot` / `subscribe` | `listAgents` + `getAgentTranscript` + SSE `/events` |
| `selectContext` | `getAgentTranscript` + `getAgentAutomations` for that context |
| `sendMessage` | `sendPrompt` |
| `addWorker` / `addRoom` | `createAgent` / `createGroup` |
| `addMember` / `removeMember` | `setGroupMembers` |
| `runRoutine` | `runAgentAutomationNow` |
| `setRunPaused` | local only — pauses the operator's view, not the worker |

**What is honestly unwired.** `submitSecret`, `setPluginState`, `togglePluginTool`,
`decideApproval`, `setModel`, `setAutoReview`, `startTeaching`, `finishTeaching`. Each writes a
line into the transcript saying so instead of reporting success. `submitSecret` refuses outright:
telling someone a credential was stored when it was not is worse than any missing feature. These
map to work the operator paused (plugins/OAuth) or that is already ranked (per-worker model
routing, Wave 5 #12).

**Two bugs found and fixed while binding, both worth remembering.**
1. `sendPrompt` takes `agentId`, not `id` — the same trap `getAgentTranscript` sets. The wrong key
   is accepted and answered, so the prompt vanishes with no error to notice. Symptom: the UI looks
   fine and the gateway transcript never grows.
2. `app.js` ships `simulateReply`, a demo affordance that writes a plausible worker answer 1.15s
   after send. Against real data that is the UI putting words in a worker's mouth. Since `app.js`
   stays unchanged, the refusal lives in the adapter: `addMessage` accepts the operator's own echo
   and the transient "working" bubble, and drops any text attributed to a worker.
3. The same 1.15s timer also owned the "working" dots, so they flashed and died while the real
   reply was still tens of seconds out and the operator waited in silence. The adapter now owns
   that bubble's lifetime: raised on send, re-hung after every transcript rebuild, and cleared
   only when a `send-message` newer than the send appears -- or after a five-minute cap, so it can
   never spin forever on a turn that died. `removeMessage` and `setWorkerStatus(ready)` decline
   the demo timer while a wait is genuinely open. Measured: dots up at t+1s, still up at t+4s,
   gone at t+6s as the real reply rendered.

**Backgrounds.** `backgrounds.js` + `backgrounds.css`, loaded after `app.js` so they can hang
their own listeners on the settings buttons and append a section to the panel once it is filled.
Six operator-supplied plates live in `assets/backgrounds/` as WebP at 1920px with 320px thumbs --
204KB for all six, down from 8.9MB of PNG. Selection and uploads are kept in `localStorage`:
uploads are downscaled in a canvas first, capped against the quota, and the panel says out loud
that they stay in this browser. There is no upload endpoint, and inventing one would mean writing
operator files into a served directory. Scoped to `html[data-bg]`, so with nothing chosen the
handoff's own plate ships untouched.

**One fix in `styles.css`** (so "byte-identical" now means `app.js` and `adapter.js` only):
`.context-detail-row strong` asks for an ellipsis but a flex child defaults to `min-width:auto`,
so it cannot shrink past its own text and widens the whole card instead. Surfaced as Chief's
agent panel running off-screen while Atera's was fine. Root cause was also ours: the adapter was
putting an agent's `description` -- a whole job brief -- into the one-word `Role` field. Role is a
label again; the description still shows as the line under the name.

**The desktop is real now.** `Browser` and `Terminal` in the desktop dialog mount one noVNC frame
against the box's display `:1` (`127.0.0.1:6080`, which serves x11vnc on rfbport 5900). The frame
is mounted once and reused when you switch surfaces -- replacing the element re-runs the whole RFB
handshake, which is what made the old desktop reconnect on every repaint. noVNC's own status strip
is clipped by pulling the frame up inside a hidden-overflow box, since it cannot be styled across
origins. `POST /box/launch` puts an app on that display through a **two-command allowlist**
(`google-chrome`, `xfce4-terminal`); no operator string ever reaches a shell, and the relay is
loopback-only. Launch is fire-and-forget: if the app is already running, Chrome just says
"Opening in existing browser session" and the view shows what is really there.

**What the box actually looks like inside** (probed, worth keeping): displays `:1` and `:2`, each
with its own `x11vnc` (rfbports 5900 and 5902). `websockify` on **6081** routes by token from
`/tmp/sand-novnc-tokens.d/` (a file per display), while **6080** serves display `:1` directly.
So per-agent desktops are native to the box -- but the gateway exposes no agent-to-display
mapping, so the UI shows `:1` today. Wiring per-agent views is a matter of surfacing that mapping,
not of building anything new. `wmctrl` is not installed; use `xdotool` to list windows.

**Wave 5 #11 closed: `runAgentAutomationNow` 500.** `analytics-service.ts` forwards ~30 telemetry
methods through `forward(name)`, which calls `telemetry[name](...)` and so keeps `this`.
`reportAutomationRun` alone was captured as a bare reference, so the method ran detached, `this`
was undefined, and `this.mapped` threw -- surfacing as a 500 on every manual routine run. Fixed by
calling it on `telemetry`; rebuilt and restarted, the call now answers 200.

**Wiring verified through the UI, not by inspection.** `addWorker` -> `createAgent`, `addRoom` ->
`createGroup`, `addMember`/`removeMember` -> `setGroupMembers`, `runRoutine` ->
`runAgentAutomationNow`. Finding: `createGroup` and `setGroupMembers` take **`memberAgentIds`**,
not `memberIds` -- the third instance of this family of trap, and the gateway answers 200 to the
wrong key, so rooms were created empty and roster edits silently did nothing. Also `runRoutine`
must return a **Promise resolving to the routine** (the view reads `lastRun.duration` off it); the
adapter now measures the real elapsed time instead of reporting the demo's invented 2.2s, and
`app.js` gained the error arm it never had, so a failed run says so instead of throwing.

**Desktop surfaces -- what is true as of 2026-08-30 23:00.** The Terminal surface is real: a live
`xfce4-terminal` on display `:1`, interactive through noVNC. **The Browser surface is not yet
real** -- `google-chrome` on `:1` exits within seconds and never enters `_NET_CLIENT_LIST`, so the
pane shows whatever else is on that display. Reproduce:
`docker exec -e DISPLAY=:1 grok-bot-local-vm google-chrome --no-sandbox --user-data-dir=/tmp/x about:blank`
returns exit 0 with no window; only dbus warnings in the output. A Chrome *was* seen on `:1`
earlier in the session (screenshotted, with Google loaded), so this is a state change, not a
missing capability. Suspects, untested: a singleton/profile lock left by the agent's own
computer-use Chrome, or the box's Chrome being managed by the host and refusing a second instance.

Two defects found and fixed while getting there:
- The VNC frame was rendering **900x30**. The clip wrapper used `flex:1` inside `.desktop-browser`,
  which is not a flex column with a definite height, so it collapsed and the operator saw the
  panel's own light background -- looking exactly like an empty browser page. The wrapper now sets
  `display:flex; flex-direction:column; height:100%` explicitly.
- `/box/launch` spawned a **new window on every switch**; the box had collected four terminals
  before anyone looked. It now finds the existing window by `WM_CLASS` in `_NET_CLIENT_LIST` and
  raises it with `xdotool windowactivate`, launching only when none exists. Class and command are
  server-side constants; no part of the request reaches the shell.

The address bar in the desktop dialog is **decorative** -- it is the prototype's drawn toolbar and
navigates nothing. Typing a URL does not browse. Same for the `Context7` / `Reports` /
`Ticket audit` sub-labels under the surface buttons: hardcoded strings from the mockup.

**Acceptance harness (contract 2026-08-30).** Six commands, all green as of wave 3:

```
PLAYWRIGHT_DIR=<node_modules with playwright> node scripts/verify-machine-room.mjs --assert-no-silent-mocks
PLAYWRIGHT_DIR=...                            node scripts/verify-machine-room.mjs --e2e
PLAYWRIGHT_DIR=...                            node scripts/verify-machine-room.mjs --surfaces
SAND_PROFILE_DIRS=...                         node scripts/verify-local-turn.mjs --rounds 5
                                              node scripts/verify-agent-identity.mjs
                                              node --test tests/*.test.mjs      # the glob matters
```

`node --test tests/` alone fails on this Node with `Cannot find module .../tests`; the suite is
fine, the command form is not. The mock list inside the harness is derived from the audit's 55
MOCK verdicts, not written from memory -- a hand-kept list is how a mock survives its own test.

**Wave 2-3 findings worth keeping.**
- The roster was hydrated once at boot and never re-read, so `isRunning` froze at load. That is why
  a worker sat on "Working now" indefinitely while answering normally -- frozen, not wedged. Now
  re-read on the SSE tick plus a 15s heartbeat.
- Failed turns left no trace anywhere in this UI: the transcript never grew and the working dots
  ran to their five-minute cap. The host records them as **error trays** (`getTrays`); they are
  read and written into the conversation now.
- **The Pause button stopped nothing** and said "Resume" -- a control that answers while doing
  nothing is worse than one that is missing. There is no host command to halt a turn in flight, so
  it is "Pause view".
- `getListenerIntegrations` answers `{integrations:[...]}` on this host, a third shape after
  `platforms` and `connections`. Missing it rendered "no connectors" on a box that has two. Each
  entry carries only `platform`, `isConnected`, `state`, `neededByCount` -- any category or blurb
  beyond that is invention.
- The `/model` probe ran *after* workers were shaped, so every worker wore the seed default while
  the picker showed the truth. Probe first.
- Paused routines kept their `nextRunAt`, so the countdown promised runs that would never fire.
- `/box/launch` is detached and answered 200 unconditionally -- it reported success all evening
  while a shell syntax error meant nothing launched. `GET /box/surface?app=` now reports whether
  the window is actually present, and the pane says so when it is not.

**The gateway registers 123 commands, and the first audit was wrong about several.** It claimed no
approval command, no policy engine, no capture path and no way to connect a connector. All four
were false, and acting on those claims made me label real capabilities "not wired" — a false
"unwired" misleads exactly as much as a false "working". `source/host/gateway-protocol.ts` is the
allowlist; read it before believing any absence claim.

Commands that turned out to be real and are now used: `listAllAutomations`, `getHostSettings` /
`setHostSettings` (a live `autoReviewInstructions` policy plus `localToolPermission`),
`startTeachRecording` / `stopTeachRecording` / `getTeachRecordingStatus` (a real ffmpeg recorder),
`resolveAutoReviewApproval` / `resolveLocalToolPermission` / `respondToWidget`,
`getListenerConnectUrl` / `disconnectChannel`, `uploadAttachment`, `createAgentAutomation`,
`ensureForeverBox`, `dismissTray`.

**Per-agent displays were there all along.** `SharedDesktopSandBox.assignWindow(agentId)` hands
each agent a fork index from 2 up and persists it to `/home/box/.sand-window-assignments.json`;
x11vnc serves one per display; websockify on 6081 routes by that index **as its token**, so the
token IS the display number. `ensureForeverBox {id}` returns that agent's `vncUrl`, allocating one
in ~10s if the agent has never had a screen. 6080 is the shared seat on `:1`. Chrome needs
`--user-data-dir` per display or the second instance attaches to the first and opens no window.

**Per-agent models do not exist.** `updateAgent` accepts only `{name, description, title}`; there
is no `agentDefaultModel`; `computerUseModel` is global; and `resolveOpenAiCompatibleSettings`
takes no agent argument. One endpoint serves the whole box, switchable via the relay's
`/endpoints/use`. Do not plan a per-worker model feature without host work in the inference path.

**Approval entries carry no `.content`.** `auto-review-approval`, `local-tool-permission` and
`widget` all arrive as `send-message` entries whose payload is `message.approval` / `message.ask` /
`message.widget`. Any transcript reader that keys on `message.content` drops them, and the agent
blocks forever with nothing on screen. Resolution vocabularies: `approved|denied` for auto-review
(`runner/sand-auto-review.ts:9`), `allow-once|deny|always|never` for a local tool.

**Automation payload facts.** `runs[]` is **newest-first**; success is `"ok"`, not `"passed"`;
`triggerDescription` is the human string; `isEnabled` (not `enabled`) gates it; `lastRunAt` and the
per-run `startedAt`/`finishedAt` give a real measured duration.

**There is no per-worker directory.** Every worker's Shell runs in one shared `/workspace`
(`EXEC_DAEMON_CWD`). The only per-agent file record is the transcript's attachment entries.

**Computer use: root-caused, half-fixed, and the remaining half is named.** The operator's report
— "the agent says it is going to do something and never comes back" — reproduces exactly: ask a
worker to open a page on its computer and it dispatches `computerUse`, the subagent reports
`done` in seconds, nothing is driven, and the agent honestly answers "the first pass didn't return
a title" and dispatches again, in a loop.

Two distinct causes, found by working down the stack. Everything below was measured, not inferred.

1. **The provider could not send an image at all.** `openai-compatible-chat.ts` had zero image
   handling — no `image_url`, no base64 — and `executeToolCalls` JSON-stringified every tool
   result. A screenshot comes back as `{kind:"image", text, imageB64}`, so the model received a
   megabyte of base64 **text** and had nothing it could see. **Fixed:** images are lifted out of
   the tool result and follow as a `role:"user"` message with `image_url` parts, which is the shape
   every OpenAI-compatible vision endpoint takes; the base64 is stripped from the tool message so
   it is not sent twice. Blast radius is exactly the broken path — only computer-use results carry
   images, so no turn that works today changes. Eight tests in
   `tests/openai-compatible-images.test.mjs`.

2. **The fork window's desktop session does not come up.** Still open, and now diagnosed to the
   line. `start-desktop.sh` does relaunch D-Bus correctly when it runs: as root it removes
   `${BOX_USER_XDG_DIR}/dbus-session-address` and re-launches. The problem is that it never runs
   again. `start-window` short-circuits on `if display_alive && daemon_alive; then ... exit 0`, and
   **an Xvfb that survived a box restart counts as alive** — so after a restart the display is up,
   the session under it is dead, and nothing ever repairs it. Measured on the fork:
   `/tmp/xdg-runtime-box-3/dbus-session-address` points at `/tmp/dbus-D43YLAu6jZ`, the socket file
   still exists, and connecting to it gives **Connection refused** — a stale address whose daemon
   died. Xfconf cannot connect, `xfwm4` exits with "Xfconf could not be initialized", no window
   manager is left, and `_NET_CLIENT_LIST` on `:2`/`:3` reads "not found" while `:1` is fine.

   **Fixed, in the box.** `scripts/box-patches/apply-start-window-fix.sh` adds a `session_alive`
   check to `start-window` and, when X is up without a session, tears down **only that display** so
   the bringup path runs again. Verified: a fork with a dead session logs "X is up but the session
   is dead; rebuilding" and comes back with a real desktop, and after a container restart a single
   `ensureForeverBox` self-repairs it. The patch survives `docker restart` but **not** a recreate,
   so re-run the script after `recreate-box.sh`; the original is kept beside it as
   `start-window.original`.

   One trap inside the fix worth remembering: `xprop` exits **0** even when it prints "not found",
   so the exit code proves nothing and the check has to grep the output. The first version of this
   patch passed on every display and repaired nothing.

   **This did not make computer use work — but the third cause is now found, by measurement.** A
   temporary wire tap on `streamOpenAiCompatibleChat` logged the tool list of every request. The
   result is unambiguous: **every turn is offered the same 26 tools, and not one of them is a
   computer tool.**

   ```
   AddMcpServer, AuthenticateMcpServer, AwaitShell, CreateAgent, ExternalAwaitShell, ExternalRead,
   ExternalShell, GetMcpServerStatus, GetPlugin, InstallPlugin, ReactToMessage, Read,
   RestartMcpServers, SearchPlugins, SendMessage, SendToAgent, SetMcpInstructions, Shell, Task,
   TodoWrite, UninstallMcpServer, UninstallPlugin, UpdateAgent, WebFetch, WebSearch, update_state
   ```

   No `Screenshot`, no `Computer`. So a `computerUse` subagent is asked to drive a desktop with no
   means to do it; it answers conversationally ("I'll take a screenshot of the desktop and describe
   what's on it"), returns that string, and is marked `done`. The parent reads an acknowledgement
   where it expected a result, says the pass returned nothing, and dispatches again. That loop is
   the whole of "the agent says it will do something and never comes back".

   **This is not subagent-specific.** The main agent's turns carry the same 26 tools. Whatever is
   broken is broken for everyone, which makes it one break rather than three.

   **The break is one line, and here it is.** `createProductionTurnToolsetHost`
   (`runner-production-bridge.ts:244`) opens with:

   ```js
   const factories = !("props" in input) ? {} : createTurnToolsetFactoriesForTurn(...)
   ```

   The lazy tool host the production run shell uses (`host-runner-composition.ts:2333`, consumed at
   `:2544` as `toolHost: lazyToolHost()`) passes `turn` and `factoryProvider` but **no `props`** —
   so `factories` is `{}` and every factory-built tool disappears. Computer, Screenshot and Browser
   are all factory-built; the 26 that survive are the static ones. That is the whole defect.

   The projections themselves are fine. `createTurnToolInputs` (`:2204`) returns exactly the right
   shape — the projected inputs including `createComputerToolDependencies`, plus a
   `turnToolsetFactoryProvider` built from them. It is simply never handed to anything: its only
   consumer is the `deps.createRunStep` branch at `:2607`, guarded by
   `runnerOptions.productionTurnRunShell === undefined`, and the run shell **is** defined (set at
   `:2367`). So the branch never runs and the projections are dropped on the floor.

   **The fix**, for whoever picks this up: give `lazyToolHost` the per-turn inputs. `baseAccessor`
   is already in scope at the `:2544` call site, so `lazyToolHost` can take a
   `ProductionTurnToolInputs`, call `createTurnToolInputs` on it, and pass the result as `props`
   together with the returned `turnToolsetFactoryProvider`. Assemble the full
   `ProductionTurnToolInputs` there (it needs more than the accessor — `cancelThisRun` and
   `emitUpdate` are already destructured in `createAgentOwnerInput` a few lines above).

   **Treat this as high-risk.** It is the code path every turn runs through, so a mistake takes out
   ordinary conversation as well as computer use. Verify with `scripts/verify-local-turn.mjs
   --rounds 5` before anything else, and confirm the fix by re-adding the tool wire tap (see the
   commit "Find the real reason computer use does nothing") and checking that `Screenshot` and
   `Computer` appear in the tool list.

   The pieces all exist: `runner/tools/sand-computer-tool.ts:239` defines the `Screenshot` tool
   (`id: "OPENAI_COMPUTER_USE"`), `turn-toolset.ts` wires `createComputerToolInputs` /
   `createScreenshotToolInputs`, and `host-runner-composition.ts:1020` builds
   `createComputerToolDependencies` inside a `projection`. The tools only appear when
   `props.createComputerToolDependencies !== undefined` (`turn-agent-composition.ts:352`), so the
   break is that this projection never reaches the turn props. **That is the next thing to fix, and
   it is the only thing between here and a working computer-use agent.**

   Two subagent facts worth keeping, both measured: children **do** run turns and **do** call the
   model (a `generalPurpose` child returned "I'll send exactly that."), and parent and child share
   the same system-prompt prefix, so requests can only be told apart by their first user message —
   which is what made an earlier reading of this log wrong.

   **Repair procedure, until then:** `docker restart grok-bot-local-vm` rebuilds every session
   cleanly. Do **not** try to tear down one display by hand — deleting `/tmp/.X11-unix/X3` takes
   out the socket directory for `:1` and `:2` as well, leaving three Xvfb processes running that
   nothing can connect to. A restart is the recovery from that too.

   Original evidence retained: The X display exists
   (`/tmp/.X11-unix/X3`), the assignment is persisted, the fork router routes correctly (404 with
   the owner token, 403 without — so auth and routing both work), and the fork exec daemons listen
   on 14002/14003. But `_NET_CLIENT_LIST` on `:3` is **empty** — no window manager, no dock, no
   Chrome — and `/tmp/xfwm4:3.log` reads `xfwm4-CRITICAL: Xfconf could not be initialized`. So the
   session bringup fails on the fork displays while `:1` is fine. That is a box-image problem, not
   host code.

Ruled out along the way, so nobody re-checks them: shared-desktop mode is ON
(`SAND_USE_EXISTING_BOX_EXEC_DAEMON=1` → `standalone=false` → `sharedDesktop=true`); the runner and
the forever-box share one box instance (`const remoteBox = foreverBox.box`); the window router is
alive (the EADDRINUSE lines in its log are failed *duplicate* launches after the first bound);
`box-chrome --sand-prepare` runs clean and opens CDP on 9222+N.

**Launch `box-chrome`, never the raw binary.** `box-reference-docs.ts:26` says so explicitly, and
it matters: the raw binary came up on the right screen with a different profile and no debug port,
so the operator watched one browser while the agent tried to drive another.

**Run it.**

```
pkill -f "node ui/server.mjs"
SAND_PROFILE_DIRS=/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb-leaked/.cache/firstmate-profile/sand-data \
  nohup node ui/server.mjs > /tmp/ui-server.log 2>&1 &
open http://127.0.0.1:7777/machine-room/
```

Without `SAND_PROFILE_DIRS` the relay starts and logs `(no auth)`, every gateway call answers 401,
and the page silently falls back to demo data. Check the first two lines of the log.

**Verified on the wire, not by inspection.** Typed the probe into the real composer, pressed
Enter, and Atera Triage answered "Atera Triage is live." at 10:06 PM through SSE — real roster,
real transcript timestamps, real routine countdown ("Nightly ticket sweep, in 9h 58m"), zero page
errors.

## 6g. Computer use — how it actually works (root-caused 2026-08-31)

**The main agent never touches the desktop.** `turn-toolset.ts` pushes the `Computer` tool only
when `host.isComputerUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()`, and
`Browser` only under `isBrowserUseSubagent`. Chief's job is to dispatch `Task` with
`subagent_type: "computerUse"` (registered in `host-runner-composition.ts`, described by
`sand-computer-use-subagent.ts`); that child is the only thing given hands. Only one may run at a
time — they share the single screen — and it runs headless, so on a password/2FA/captcha it stops
and reports back for `request_box_help`.

Three reconstruction defects stacked on top of each other, each hiding the next:

1. **No provider entry** (fixed `bae7f7a`) — `Computer`/`Screenshot` had no
   `create*ToolInputs`, so every turn fell through to `props.createComputerToolDependencies`,
   which the Agent engine never sets. Built per turn from `props.resourceAccessor` instead.
2. **`isComputerUseSubagent` hardcoded `false`** at every composition site, and children reused
   *the parent's* run shell — so the toolHost was built once, with the parent's flags, and the
   gate above could never pass. The shell is now a factory (`makeRunShell(subagentKind)`) and the
   child gets its own. A computerUse child now declares **9 tools including `Computer`**
   (`Shell, Read, AwaitShell, External*, WebSearch, WebFetch, Computer`) versus the parent's 27.
3. **Six host tools never defined `serializeError`** (Computer, the browser pair, file transfer,
   box help, MCP management, subagent management). It is called from `executeToolResultOrError`'s
   **catch block**, so any throw was replaced by `tool.serializeError is not a function` — the
   reporting path destroyed the error it existed to report, and the subagent surfaced only as
   status `error` with nothing to read. `asTurnTool` now supplies a fallback.

**What remains is model capability, not plumbing.** With the chain open, the local model calls
`Computer` and omits the required `action`, failing zod parse. The declared JSON Schema is
correct (the `action` enum is right there), and the provider's `repairToolCall` retry exists for
exactly this. Worth re-testing against a stronger endpoint before any further host work.

**Known defect, owned:** the `asTurnTool` fallback returns a task-shaped `ToolCall`, but
`renderToolResultOrError` calls `tool.render(ctx, output.result, props)` and the computer tool's
`describeOutcome` expects a `ComputerUseResult` — so a Computer *error* now raises
`Cannot read properties of undefined (reading 'case')`. Next action: give
`sand-computer-tool.ts` its own `serializeError` returning a computer-shaped result. Owner: Claude.

## 6h. The stall: what is ruled out (2026-09-01)

**Retraction first.** Commit `8d8df88`'s message, and an earlier version of the published audit,
claimed the model never receives its own tool calls or results. **That is wrong.** It generalised
from a sample of the last twelve messages, which in that run happened to be all text. Anyone
reading that commit message should stop here instead.

Measured on the live box, all of these are RULED OUT as the cause:

- **Tool execution.** Asked to `touch /workspace/proof-<token>.txt`, the file appears. The shell
  tool runs correctly.
- **Tool results reaching the model.** The history handed to the provider contains
  `assistant[tool-call]` and `tool[tool-result]` parts.
- **The id filter** at `provider-session.ts` `conversationInput` — `offered` ids and result ids
  match exactly, `kept=130/130`.
- **Redaction of result content.** A sampled result reads
  `<cursor_untrusted_data_1337 source="SendMessage">Message sent to user…</cursor_untrusted_data_1337>` —
  intact, not a privacy-mode placeholder, despite the privacy lookup failing over to its safe default.
- **Step ceilings.** `SAND_AGENT_MAX_STEPS` is 5000; the openai-compatible provider loops to 8.

What is established and still unexplained: the agent acknowledges, runs the work tool, and the turn
ends with no reporting step. Ordering is confirmed — `sendMessageToolCall` then `shellToolCall`,
then nothing.

**Reproduction:** `scripts/verify-work-report.mjs` writes a random sentinel into `/workspace` and
asserts the agent names it back. It cannot be satisfied from training or prompt, and it fails
consistently. Use it rather than judging message text by eye.

**FIXED 2026-09-01.** `tool-stream-executor.ts` assembles the turn's response messages and chose
between the provider's own messages and a message synthesized from the streamed content buffer. A
provider can return the narration text without the tool calls it streamed; text alone satisfies
`hasMeaningfulResponseMessageContent`, so that branch won and the streamed tool-call parts were
dropped. `runStep`'s `containsToolCall(response.messages)` then read false, the step loop broke, and
the turn ended with the work done and never reported. The buffer already held those parts (they are
pushed at ~:977) -- the fix prefers the synthesized message whenever the stream saw a tool call the
response did not carry. `scripts/verify-work-report.mjs` goes 2/2.

**MEASURED 2026-09-01, cause located.** The provider surfaces tool calls correctly and the agent
never sees them:

```
SANDSTREAM surfaced=1 entries=["0:name=\"SendMessage\":args=52"]
SANDSTEP   hasToolCall=false tools=[]
SANDSTREAM surfaced=1 entries=["0:name=\"Shell\":args=78"]
SANDSTEP   hasToolCall=false tools=[]
```

`runStep` decides whether the turn continues with
`const hasToolCall = containsToolCall(response.messages)` (~:2138). Our openai-compatible bridge
never puts the surfaced tool calls into `response.messages`, so that is false, the loop breaks after
one step, and no reporting step ever runs. The tools still execute over the stream path -- which is
why a `touch` lands and the ack is delivered while the agent goes quiet.

The same file already knows about this hazard: at ~:1779 it guards with
`sawToolCall || containsToolCall(response.messages)`, tracking calls observed in the stream because
`response.messages` may not carry them. `runStep` has no equivalent. Fix candidates, in order:
populate `response.messages` in the bridge (correct, and fixes every consumer), or give `runStep` a
stream-observed signal like the one at :1758.

**Superseded next measurement:** the runner's own step loop — `sand-agent-runner.ts:1269` and
`abstract-user-message-action-handler.ts:2598`. After the work tool executes, does the model get
another step, and what does it emit there? Do not claim a cause before that is instrumented; this
failure has already produced two confident wrong answers.

## 6i. Computer use: verified once, then blocked by a request-shape error (2026-09-02)

`scripts/verify-computer-use.mjs` passed cleanly once -- screenshot artifacts 0 -> 1 with a real
`computerUse` subagent -- which confirms the four fixes underneath it (engine adapter, box resource
accessor, result parts, subagent toolset gate) are all real.

Subsequent runs abort. The host log shows the model API returning
`{"message":"Internal error during token generation","type":"server_error","code":"internal"}`.

**Do not write this off as provider flakiness.** Direct `grok-4.6` completions from inside the same
box, using the same key, succeed 3/3. Something about the request this stack builds triggers it.
Untested candidates, in order of suspicion: the parent turn declares **33 tools**; its history has
accumulated **130+ tool results**; the tool JSON Schemas may contain a construct the endpoint rejects
only in combination.

**BISECTED 2026-09-02. It is the history, not the tools and not the provider.** The same gate run
against a FRESH agent passes immediately (artifacts 1 -> 2, subagent running), while the long-lived
test agent -- 130+ accumulated tool results -- aborts every time. Tool count is identical in both
cases, so 33 tools is exonerated; direct completions to the same endpoint succeed 3/3, so the
provider is exonerated.

**This is a product problem, not a test artifact.** Every agent accumulates history, so every agent
walks toward the point where its turns start failing with an opaque
`Internal error during token generation`. Whatever should be trimming or compacting that history is
either absent or not firing on the local-provider route. Worth its own investigation: find the
compaction path, check whether it runs here at all, and establish the practical ceiling.

**A second way a subagent aborts, observed 2026-09-01:** sending a new prompt to an agent while its
`computerUse` subagent is mid-flight aborts the subagent. Two verification gates briefly shared one
agent -- the desktop gate dispatching a subagent, the work-report gate sending sentinel prompts --
and every subagent came back `aborted` with no artifact. Whether that is intended (a new instruction
supersedes in-flight work) or a defect is undecided; it is the same hazard the local schedule tick's
busy guard exists to avoid, and it means any abort must be read against what else was driving that
agent before blaming history or the provider.

Practical consequence, now built in: `scripts/verify-computer-use.mjs` creates its own fresh agent
for each run and deletes it afterward, so it measures the desktop path and nothing else. Pass
`--agent <id>` only when you specifically want to test a long-lived agent -- and expect the
history failure when you do.

## 6j. History and context: the two-tier design, and why compaction never fires here (2026-09-01)

Scouted by four read-only lanes with a refutation pass each; the load-bearing lines were then
re-read by hand. **The operator's model is exactly right.**

**Tier 1 -- kept forever, on disk.** `transcript_entries` (the UI scrollback) has no cap, TTL, or
retention: `session/agent-db-schema.ts:15-19`; the only removal is a wholesale
`clearTranscriptEntries` at `:65`. Every prompt message, turn, and summary archive is also a
content-addressed blob in `conversation-blobs.db`.

**Tier 2 -- what the model sees.** One field, `rootPromptMessagesJson`. On every action the agent
rebuilds the prompt from ALL loaded blobs (`packages/agent/state.ts:1470-1484`,
`rootPromptBuilder.clearMessages(); appendMessages(rootPromptMessages)`) -- no slice, no window --
and the local provider serializes the whole thing to the wire (`provider-session.ts:127-155`).

**The only thing that shortens it is compaction rewriting that field in place**
(`packages/agent/summarization-orchestrator.ts:762-765`): the context collapses to
`[system, userInfo, summary, ...preservedTail]` (`agent-summarization/summarization-handler.ts:1113-1123`)
while the transcript on disk is untouched, and the collapsed turns are recorded in
`summaryArchives` so the UI can still show them (`agent-transcript/index.ts:166-180`).

**No "new chat" is design, not a gap.** No gateway command clears a conversation
(`gateway-protocol.ts:4-127`); the product's own error copy says "Start a new conversation with
this agent" (`session/conversation-size-limits.ts:37`). The working wipe primitive,
`SandAgentDb.clearConversation()` (`session/agent-db.ts:264`), is reached only through
**`duplicateAgent`** (`gateway-protocol.ts:34` -> `agents/agent-clone.ts:24`, `includesChatHistory`
typed as literal `false`). That is today's "new chat": same profile, settings, and routines, empty
conversation, new id.

**Why compaction never fires on our route -- verified by hand:**

1. `provider-session.ts:469` (openai-compatible), and `:317`/`:348`/`:378` for the other local
   executors, resolve usage as `{ ...event.usage, maxTokens: 0 }` -- the literal follows the spread,
   so the context window is always zero. A real window only ever arrives from the Cursor backend
   (`chat-inference-proto/client.ts:243`).
2. `agent-summarization/background-summarization.ts:27`: `if (maxTokens <= 0) return undefined;` --
   so `shouldStartBackgroundSummarization` is always false. The thresholds themselves are live and
   sane: 10,000 tokens / 10% to start, 5,000 / 5% to persist (`runner/turn-agent-composition.ts:209-216`).
3. The last-ditch "provider rejected the prompt, compact and retry" rescue
   (`abstract-user-message-action-handler.ts:2511-2529`) keys on `error instanceof InputTokenLimitError`.
   Our transport wraps everything in a bare `Error` (`openai-compatible-chat.ts:167-178`), and the
   string classifier (`chat-inference/token-limit-error-classification.ts:38-43`) is only called on the
   Cursor RPC route. So `Internal error during token generation` misses the rescue and is rethrown;
   same input next turn, same death. That is the forever-failure loop of 6i.

**Correction to the obvious theory:** `NoopConversationActionReceiver` is real and `summarizeAction`
is dead twice over (nothing constructs one; the queue is a no-op), but automatic compaction never
used that queue -- it calls `orchestrator.handleSummarization` directly at nine sites on the turn
path. Reviving the queue buys a manual `/compact`; it does not fix this.

**The fix, ~1 day:** (a) report a real context window from the openai-compatible executor -- xAI's
`/v1/models` advertises `context_length` (500000 for grok-4.6), so read it rather than guess; do the
same for the other three executors. (b) Recognise the local transport's overflow failure as
`InputTokenLimitError` so the rescue path fires; the existing phrase classifier does not match this
message, so it needs a recogniser for the actual shape. **Must not:** truncate at load in
`state.ts:1483` (destroys what the summary should capture), add a clear-conversation command (a
departure from the design), touch the transcript layer, or repoint `agentTokenLimit`
(`host-runner-composition.ts:2754`, which budgets the skill catalogue).

**Free proof of the summarizer:** `shouldForceSummarizationForTesting`
(`summarization-handler.ts:737-792`) runs every iteration of the turn loop and is gated only on
`NODE_ENV === "production"`, which the running host does not set. Writing `next-human` to
`$HOME/debug-summarization-strategy.txt` in the host's home forces one blocking compaction on the
next user message. Remove the file afterwards.

**Measured 2026-09-01, after the scouting:** arming `next-human` and sending a prompt to the
long-lived agent produced **no rewrite** -- a tap on the `clearMessages` / `appendMessages` block in
`summarization-orchestrator.ts:762-765`, confirmed present in the bundle, never fired. The turn
itself completed normally (the agent answered `READY`). Two consequences, stated exactly:

- The long-lived agent now completes turns **without any compaction having occurred**, so an
  earlier inference that a forced compaction had unwedged it is withdrawn. The cause of that
  agent's afternoon of `Internal error during token generation` failures is therefore **unproven**:
  a fresh agent worked and an old one failed on the same afternoon, and now the old one works. Do
  not cite history size as the established cause until a request-size measurement ties them.
- The forced path did not run the summarizer. A verified candidate: `resolveSummaryTokenLimit`
  (`summarization-orchestrator.ts:307-311`) returns `undefined` unless `maxTokens > 0` or an eval
  override is set -- so the zero window plausibly disables even manual compaction. Not measured.
  The efficient next step is not more taps on the debug hook; it is fix (a), a real context
  window, which makes both the automatic and the forced path testable.

**FIX SHIPPED 2026-09-01.** Three changes:

1. `openai-compatible-chat.ts` -- the settings gain `contextWindow` from
   `SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW` (env or `box-secrets.json`, re-read on every call, so
   no restart), plus `fetchOpenAiCompatibleContextWindow`, a no-throw probe of `GET /models` that
   reads `context_length` (xAI, OpenRouter), `max_model_len` (vLLM), `max_context_length` or
   `context_window`. Default when nothing is configured or advertised: 32,000 -- modest on
   purpose, since a window set *larger* than the real one leaves compaction dead until the
   provider rejects the prompt.
2. `provider-session.ts` -- the openai-compatible executor resolves that window once per
   endpoint (advertised figures cached for the host lifetime, defaults rechecked every 10
   minutes) and reports it as `maxTokens` instead of `0`. Its catch runs the transport's error
   through the shared `classifyTokenLimitErrorFromMessage`, so a real xAI overflow -- measured
   live as HTTP 400 `This model's maximum prompt length is 500000 but the request contains
   1427641 tokens.` -- becomes `InputTokenLimitError`, which is what the compact-and-retry rescue
   at `abstract-user-message-action-handler.ts:2511` and the summarizer's own reduce-inputs retry
   (`agent-summarization/error-handling.ts:122`) both key on. A genuine 500 (`Internal error
   during token generation`) is deliberately NOT classified; it passes through unchanged.
3. `runner/turn-settle.ts` -- one `[sand][turn] conversation compacted` line when a checkpoint
   carries a new summary archive. The transcript keeps every turn by design, so this is the only
   operator-visible trace that the model's window shrank.

Not touched, on purpose: `state.ts` load (no truncation; the prompt is authoritative state), the
transcript layer, `agentTokenLimit`, and no clear-conversation command. The other three local
executors (`codex`, `claude-code`, `openrouter`) still report `maxTokens: 0`; they are unused here
and are noted rather than fixed.

**Verification:** `scripts/verify-compaction.mjs` runs the box's traffic through a small proxy
INSIDE the container that forwards to the real endpoint unchanged (authorization header included,
never read) and, with `--recover`, enforces a small prompt cap by answering with the verbatim xAI
overflow body. Real model, real tools, real summarizer; only the limit is small, so a run costs
cents rather than the ~$10 a genuine 500k accumulation would. Ground truth is the compacted line
plus a transcript that did not shrink -- never a turn merely succeeding. It backs up
`box-secrets.json` first and restores it on every exit path.

**MEASURED 2026-09-01, acceptance 1 -- automatic compaction fires on the local route.** Against
the box's configured endpoint at the time (the Spark 4 Nemotron 30B, so every request was free), a
fresh agent's base prompt was 37,099 tokens; the window was set to 61,099 (start at 51,099, persist
at 56,099) and growth turns carried the prompt to 51,656 then 66,172 tokens. On the third turn the
host printed

```
[sand][turn] conversation compacted: 1 summary archive(s); usedTokens before compaction=80512 of maxTokens=61099
```

and that turn's prompt was **37,431 tokens** -- the rewrite, measured at the checkpoint rather than
inferred from a turn succeeding. The transcript kept every turn (1 -> 5 messages). `box-secrets.json`
was restored and the backup removed on exit.

**MEASURED 2026-09-01, acceptance 2 -- an overflowing agent recovers.** Same endpoint. With the
proxy cap armed 16,000 chars above the first prompt (75,541 chars), growth turn 1 was accepted at
46,390 tokens; growth turn 2's tool-result step was rejected with the verbatim xAI 400, the rescue
ran, the host printed `conversation compacted: 1 summary archive(s)`, and the retried turn
completed with its sentinel. Transcript kept every turn (0 -> 2). Wall-clock **94s**, inside the
verify runner's 300s ceiling. The compacted line reads `usedTokens before compaction=0 of
maxTokens=0` on this path: the rescue compacts after a rejected step, when the checkpoint carries no
fresh token details -- cosmetic, the archive count is the signal.

**Regression sweep 2026-09-01, and a model-dependence finding.** Unit suite 93/93 and
`verify-local-turn --rounds 3` 3/3 on the Spark endpoint. `verify-work-report --rounds 2` went 1/2
in the sweep and then **0/2 on a clean workspace** against the long-lived `Atera Triage` agent on
the Spark's Nemotron 30B, and the failure signature is unambiguous: the workspace held
`grokbot-verify-hvtewbsc.txt` and the agent answered `grokbot-verify-x1ipm3y.txt` -- a name that
exists nowhere, in the shape of earlier listings. The model fabricated the listing without calling
the tool, and on the clean-workspace run both rounds returned that same fabricated listing verbatim. When it does call the tool (the passing rounds) the report comes through, so the Phase 1
fix holds; the miss is model judgment. The same gate passed 2/2 in four separate runs earlier the
same day on grok-4.6. A **fresh agent on the same Spark endpoint passed 2/2**, so it is neither the model in general nor
this change: it is the long-lived agent's history (~636 transcript entries, ~100k tokens) on a 30B
model. That is history rot in a second form -- and it exposes a limit of the fix as shipped: the
Spark advertises a 1,048,576-token window, so compaction keyed on the advertised maximum never
fires at 100k, long after a small model has stopped behaving. For local models set
`SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW` to a *behavioural* window (64k is a sane start for a 30B
model) rather than trusting the advertised one; the override is the recommended setting, not a
fallback. Attribution closed by running the **same long-lived agent on grok-4.6 with the same new bundle:
2/2 PASS** (125s), the box switched there and back through the operator's own
`POST /endpoints/use`. So new-bundle + grok + long-lived passes, new-bundle + Spark + fresh passes,
and only new-bundle + Spark + long-lived fails: the change is not the variable. Treat
`verify-work-report` as model-dependent: it measures whether the model
chooses to act, which a 30B local model does less reliably than the frontier model, and read a
failure against the transcript (fabricated name = model, real listing missing the sentinel =
plumbing) before blaming the host.

**Found while sizing the recovery test -- the base prompt dominates the window.** A fresh agent's
first request on this box is **75,541 chars / ~37,000 tokens before a single word of conversation**:
the system prompt plus 33 tool descriptions. Compaction rewrites only the conversation, so it can
never bring a request below that floor. Two consequences: (1) a provider window smaller than
base-plus-one-tool-result cannot be recovered by compaction at all -- the rescue rejects, compacts,
retries, re-overflows, and after five attempts the turn fails (`StepRetriesExhaustedError`); the
first recovery run reproduced exactly that with a cap 8,000 chars above the base prompt. (2) On a
32k default window the trigger fires on the very first turn. The lever is the system prompt and
tool count, not compaction; worth its own item.

**Why the Machine Room scrolls everything in:** `gateway-adapter.js:243` and `ui/index.html:570` call
`getAgentTranscript`, whose SQL is `SELECT entry FROM transcript_entries ORDER BY seq` with no LIMIT
(`agent-db-schema.ts:59`), then rebuild the DOM with `innerHTML` and refetch on every event. **The
gateway already pages** -- `getAgentTranscriptTail`, `openAgentTail`, `getAgentTranscriptWindow` with a
`beforeSeq`/`nextBeforeSeq` cursor (`agent-db-transcript-pages.ts:9-16`) -- and the shipped Electron
client uses them (`frontend/src/production/ProductionRenderer.tsx:978`, `:2231`). Porting touches only
`gateway-adapter.js` and `app.js`; `getAgentTranscriptPage` is the better command because its filter
matches the adapter's own `messagesOf`. This is a read path: it makes the tab fast and does nothing
for the model's context.

## 6k. Governance: nothing ties a claim to evidence (2026-09-01)

**The question.** `verify-work-report` failed against the long-lived agent on the Spark's 30B
model, and the failure was first read as "the model hallucinated". Jason asked the sharper question:
what enforcement exists between *the model says it observed X* and *the system has evidence X
occurred*? Traced below, with the action-audit ledger as the primary witness.

**What actually happened, from the ledger (`/home/box/sand-data/agents/<id>/audit.jsonl`).** In the
fabricated rounds the agent **did run** `ls -1 /workspace` -- `shell_command` records at 01:42:46Z,
01:47:49Z and 01:51:51Z -- and then delivered a listing that was not what the tool returned (the
file on disk was `grokbot-verify-hvtewbsc.txt`; it reported `grokbot-verify-x1ipm3y.txt`).
**Corrected the same evening, after cross-checking the ledger against `getConversationOutline`:**
the tool ran in *every* fabricated round -- round 2 at 01:51:51Z returned
`grokbot-verify-cfrl743s.txt` and the report was again `x1ipm3y`. That name appears in no tool
output anywhere in the agent's state: it was invented in round 1 and repeated in round 2. The
earlier reading of a final round with no shell record was wrong. So the *recorded* failure mode is
one: *tool ran, result ignored, a report invented or repeated*. The second mode, *no tool, report
parroted*, was never observed here and is kept as a constructed regression case only.

**The path by which both counted as completed work:**

1. The model emits `SendMessage` with the listing. The send pipeline writes
   `{kind: "send-message", id, message, timestampMs}` (`roster-projection.ts:448`) -- no request
   id, no turn epoch, no pointer to any tool execution.
2. The turn loop ends when a step has no tool call (`abstract-user-message-action-handler.ts`).
   `turn-settle` reports `sentMessageCount=1` and `madeWorkToolCall` (true in every recorded
   round; it would be false in the constructed no-tool case).
3. `turn-runtime`'s post-run checks: `isDeliveryOwed` false (it spoke); `isReportOwed` false (the
   report followed the work, or there was none); `isWorkOwed` false -- `requestImpliesAction`
   requires the prompt to *start* with an imperative, and "The contents of /workspace have just
   changed…" does not, so the one work check was switched off by prompt shape. Outcome: success.
4. Nothing, anywhere, compared the delivered message to a tool result. The gate failed the claim
   only because its sentinel is unfakeable; a request without one would have surfaced the
   fabrications as finished work with no signal.

**What exists, and where each stops short:**

- *Speech checks* -- delivery-owed, the ack reminder, the closing-send nudge -- are about silence.
- *Work checks* -- `isWorkOwed` / `isReportOwed` -- are about whether a tool ran and in what
  order. Regex-gated on the prompt's first word; blind to whether the report derives from the result.
- *Auto-review* -- permission to **act**, not attestation of **claims**.
- *The action-audit ledger* -- the receipt for invocation. Exists, populated, local JSONL per agent
  (`action-audit-service.ts:9`), records `shellCommand`, `mcpToolCall`, `browserNavigation`,
  `computerUse…` with agent id and time. Three gaps: main-agent shell records carry **no `turnId`**
  (the call site at `host-runner-composition.ts:1017` builds the record without one; only subagents
  get `subagent:<callId>`), records hold the **command, never the result**, and **nothing reads it**
  -- not the completion checks, not the transcript, not the gateway (no command exposes it), not
  the UI.
- *Conversation state* holds every tool result as a `tool-result` part (measured: `kept=130/130`),
  but `transcript_entries` never receives tool calls, the mirror keeps only `toolName` of a result
  (`legacy-transcript-mirror.ts:211`), and no gateway surface reaches the state.

So the invariant is **absent by construction, not broken**: invocation evidence exists but is
unlinked to any claim; result evidence exists only inside the model's own context; no field on a
delivered message points at either.

**Smallest architectural fix, in leverage order (not implemented; needs its own contract):**

1. **Key the receipt to the attempt.** Add `turnId` (the turn's request id, which `turn-runtime`
   already tracks in `lastRequestIdBySession`) to the shell audit record at
   `host-runner-composition.ts:1017`. That is the nonce.
2. **Record result provenance on the receipt.** Extend the shell record with `resultSha256`,
   `resultBytes` and a bounded snippet; the executor holds the output when it returns.
3. **Stamp evidence on the delivered message.** When the send pipeline writes a `send-message`
   entry, attach `evidence: { requestId, workToolCalls, lastWork: { tool, eventId } }` from
   `turn-runtime`'s per-turn counters (the writer already holds `this.tm.turnRuntime`). Any reader
   can then render a report that follows zero tool executions as **unverified** -- the visible
   signal that was missing.
4. **Expose the ledger read-only on the gateway** (`getAgentActionAudit`), so verifiers and the
   Machine Room consult receipts instead of text.

With 1-3 a work/report contract becomes machine-checkable: pass iff the delivered message carries
the sentinel **and** a receipt exists with `turnId == this request` **and** that receipt's result
digest shows the result contained it. Invoked, during this attempt, result is the source, cannot
pass without it, nonce -- each of the five requirements maps to one field. It does not make prose
truthful in general; it makes claims checkable and flagged, which is the honest scope of governance.

**Separately, hygiene:** a behavioural window for local models (`SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW`
= 64k for a 30B model) reduces how often a degraded context produces this; it does not restore the
invariant. A model can fabricate at 20k.

## 6l. What upstream had instead, and the visibility restored (2026-09-01)

**The question.** What in the original plumbing kept this from happening? **Nothing enforced it.**
Upstream relied on two things that made the invariant unnecessary at its scale, plus advisories:

- *A frontier model.* The same bundle on grok-4.6 passed `verify-work-report` 2/2, twice.
- *Tool calls shown next to claims.* The desktop transcript renders `tool-call` rows from
  `getConversationOutline` (`transcript.tsx:707`, `TranscriptToolCallRow`: name, status, summary,
  expandable result card). A listing with no Shell card above it is visibly a parrot; a card whose
  result differs from the reply is visibly a fabrication. The Machine Room never called that command
  -- its adapter kept only sent messages and user messages -- so here both rounds looked identical.
- *The prompt's "## Never fabricate data" section* -- advisory; the 30B model walked past it.
- *`turn-observation` empty-delivery telemetry* -- measures silence, not fabrication; its counter
  has no callers in the reconstruction, so it always reports zero.
- *Auto-review* (permission to act, not attestation) and *the ledger forward to Cursor* (unread).

Characterisation, agreed with Jason: **the local model exposed an assumption in the original
architecture, not a regression in it.**

**What the outline actually carried** (measured on the long-lived agent: 1,503 items, 64 tool rows):
rows and status, yes; `summary` only for Task rows -- `getOutlineToolCallSummary` was Task-only by
upstream design -- and `toolResult` never populated host-side. The desktop's result cards come from
the ClientSideToolV2 projection over the live stream (`agent-adapters.ts`), which no gateway command
exposes. So "already exposes the command summary and result cards" was half true.

**Restored.** Host `conversation-outline.ts`: shell rows now carry `summary` = the command and two
additive fields, `output` (head of stdout/stderr, 600 chars) and `exitCode`, from the shell result;
other tools get their bounded args as summary. The desktop renderer ignores the new fields. Machine
Room `gateway-adapter.js`: `loadContext` also fetches the outline; `weaveToolRows` places each tool
row before the next transcript entry the outline shares (same sent-message content or user text),
and trailing rows at the end -- which is what "worked and never reported" looks like. Rows render as
the operator app's existing `system` pill; `app.js` and the stylesheets are untouched.

**Measured** (this Mac, headless Chrome through Playwright in the session scratchpad, long-lived
agent, after a wheel-scroll to the tail): 684 rows, 64 system rows, 28 `Shell · ls -1 /workspace`
rows; the row immediately before the first fabricated report reads
`Shell · ls -1 /workspace → grokbot-verify-hvtewbsc.txt · proof-1788287229.txt · teach-sessions`;
zero page errors. Unit suite 93/93; `verify-local-turn --rounds 1` PASS on the rebuilt bundle.

**Limits, stated.** The outline is the model's prompt state: no timestamps, and compaction rewrites
it, so rows older than the last compaction vanish while the transcript keeps the messages. Upstream
has the same limit. And rows are visibility, not enforcement: the evidence layer from §6k is drafted
separately, as an extension beyond Grok Bot, in `docs/EVIDENCE-CONTRACT.md`.

## 6m. The evidence layer, implemented and measured (2026-09-02)

Contract `docs/EVIDENCE-CONTRACT.md`, armed 03:23Z, implemented in `29d9ef7`. Three layers, each
in its own place: **receipts** at the existing audit sites (`sand-agent-runner.ts` shell,
`host-runner-composition.ts` shell, `sand-action-audit.ts` MCP) now carry `attemptId` and
`turnEpoch`; **attestations** are written by `withAttestedResult` in `turn-toolset.ts`, which wraps
every work tool at the one point the toolset is finalised, and appends `tool_result` lines (sha256,
bytes, 8 KB head) to the per-agent ledger through `evidence-registry.ts` -- never through the
auditor, so a head cannot reach the Cursor forwarder; **provenance** is stamped by the transcript
store (`agent-db.ts`, in place, because the active session serves the same object from memory) from
`evidence-verdict.ts`, a zero-import module the unit test loads alone. The attempt opens in
`send-pipeline.ts` when the epoch moves; `turnId` stays unset because the request id is assigned
inside `turn-runtime.ts`, a named non-goal, and `attemptId` is the nonce anyway.

**Measured, all on this Mac + the box:**

- Unit: 99/99 (six new, over `docs/evidence/nemotron-fabrication-2026-09-02.json`).
- Replay (`verify-evidence-replay`, canned provider inside the box, real shell): round 1 recorded
  fabrication -> `unsupported`, missing `grokbot-verify-x1ipm3y.txt`, one attestation holding the real
  listing; round 2 constructed no-tool -> `unverified`, zero attestations; round 3 control ->
  `evidenced`. 25 s wall-clock, model-free.
- Live, first Nemotron round after the build (long-lived agent, before Spark went down): the reply
  named `grokbot-verify-7k475tk0.txt`, the attested listing held `ftmyb32d`; stamped `unsupported`,
  the Machine Room shows the pill under it. A fresh fabrication caught in real time.
- grok-4.6, long-lived agent, `--require-evidence`: 2/2 `evidenced`, attestation holds the sentinel,
  126 s.
- Compat: 456 pre-feature replies across three agents, none stamped; outline shape unchanged;
  no `tool_result` in the forward outbox; ledger files 0600 once the registry has written to them.

**Two findings on the way:**

- The long-lived agent's prompt is now **295,101 tokens**. Only xAI's 500k window still runs it.
  The M3 router (32k) refused it with LiteLLM's wording, `exceeds the available context size`,
  which the host's token-limit classifier does not recognise (it knows xAI's `maximum prompt
  length … request contains … tokens`), so the rescue-and-compact path never engaged and the turn
  errored. Filed as follow-up work: teach the classifier the LiteLLM, vLLM and OpenAI phrasings.
  Lives under `source/host/extensions/inference/`, a named non-goal of the armed contract.
- Spark 4's Nemotron stopped answering at 03:5xZ after a vLLM `EngineCore encountered an issue`
  500 seen in the host log. The endpoint needs a restart on the Spark.

**Budget, stated:** the contract said twelve files; the diff touches sixteen, because gateway
registration is two files, receipts have three call sites, and the scripts, test, registry and
docs each count. Reported here rather than trimmed.

## 6n. The model rubric: which model works, measured (2026-09-02)

`scripts/model-rubric.mjs` runs one scored battery per model on a **fresh** throwaway agent: reach
(10), speak (2 turns echoing an unfakeable token, 20), work (2 rounds of
`verify-work-report --require-evidence`, 40), history (4 growth turns of ~3k tokens of tool output,
then one more evidence-required round, 20), latency (median speak turn, 10). Cost class is shown,
never scored. Results in `docs/evidence/model-rubric-2026-09-02.json`; page: https://artifacts.semfreak.dev/a/grok-bot-reconstructed/model-rubric-61040c12/

| endpoint · model | score | cost | speak | work | history | median turn | what the host log says |
|---|---|---|---|---|---|---|---|
| m3-glm · glm-m3 | 10 | free | 0/2 | – | – | – | 35k fresh-agent request > 32,768 router cap |
| m3-qwen · qwen3.8 | 10 | free | 0/2 | – | – | – | router 500, qwen backend unreachable |
| m3-qwen · deepseek | 10 | free | 0/2 | – | – | – | no turn completed in 60 s (same router) |
| dell-qwen32b · qwen2.5:32b | 10 | free | 0/2 | – | – | – | prose about "a mistake in formatting"; no valid tool call (Ollama shim, 33 tools) |
| dell-qwen32b · qwen2.5:14b | 0 | free | – | – | – | – | not run; rubric tag bug, fixed `4344517` |
| xai-grok · grok-4.20-0309-reasoning | 10 | paid | ? | ? | runaway | – | 1,012 duplicate sends in 8 turns; killed (P1c) |
| xai-grok · grok-4.6 | **95** | paid | 2/2 | 2/2 | 1/1 | 22 s | 102 s wall, every reply `evidenced` |
| spark4-nemotron · Nemotron 30B | **70** | free | 2/2 | 1/2 | 1/1 | 30 s | rerun 06:10Z after the restart, 150 s turn timeout; one silent work round, truthful after growth |

**Reading it, updated 06:15Z.** With Spark back, Nemotron is the one free model that runs the product, at 70: it speaks, it stays truthful under history load now that the evidence layer checks it, and it still goes silent on one work round in two. Overnight no free local model could run at all, and in every case the
reason is configuration or serving, not model quality: the M3 router caps GLM below the product's
own base prompt, its qwen backend is off, the Dell serves through Ollama whose tool-call shim cannot
carry 33 tools, and the Spark, the one endpoint with a window large enough, is down. Nemotron, when
it was up, fabricated under history load; the evidence layer now labels that instead of trusting
it. The rubric is the instrument to re-run after each operator fix: restart the Spark, raise GLM's
router context to at least 64k (the model supports 128k), and put a vLLM or llama.cpp server in
front of the Dell's weights instead of Ollama. grok-4.6 is the control and the reference score.

## 6o. The M3 as a GLM host: prefix caching makes it viable (measured 2026-09-02 06:05Z)

The other agent's question: the M3 Studio holds GLM at 256K context but prefills at ~200 tokens/s,
so a 40K prompt costs three minutes; does llama.cpp's prefix cache make that a one-time cost? Measured
from this Mac through the LiteLLM router at `100.84.108.16:4000` (glm-m3 → llama.cpp on the M3 at
port 8940), a 47,073-token prompt, `max_tokens` 8, four calls in a row:

| call | prompt | wall | llama.cpp timings |
|---|---|---|---|
| 1, cold | 47,073 tokens | 240.6 s | `cache_n` 9, `prompt_n` 47,064, 197 tokens/s |
| 2, identical | same | 1.3 s | `cache_n` 47,069, `prompt_n` 4 |
| 3, same prefix, new user message | same | 1.3 s | `cache_n` 47,069, `prompt_n` 4 |
| 4, identical to 1 | same | 1.3 s | `cache_n` 47,069, `prompt_n` 4 |

The cache survives the router, and the product's pattern (a stable ~35K base prompt with a new tail
each call) hits it. So the M3 pays the prefill once per server lifetime and per distinct prefix, then
turns in about a second plus generation. Two design consequences: keep the stable part of the prompt
first and byte-identical across calls (agent-specific text after the shared base), and remember the
cache is per llama.cpp slot, so several agents with different prefixes will evict each other unless
the server runs enough parallel slots. The router's 32,768 cap seen at 03:5xZ is gone; the same
route now accepts 47K.

## 6p. Subscriptions: discover, adopt honestly, score (2026-09-02, contract steps 1–4)

Contract `docs/SUBSCRIPTIONS-CONTRACT.md`, armed 06:53 CDT. Built on the Mac side, where the vendor
stores live: `ui/subscriptions.mjs` (scan, adopt, refresh, resolve), relay routes
`GET /subscriptions`, `POST /subscriptions/adopt`, `POST /subscriptions/forget`, and a
"Found on this machine" section in the operator page's Endpoints panel. Adopted secrets live in
`ui/subscriptions.json` (0600, gitignored); an adopted endpoint row carries `subscription: <id>`
and no key; `/endpoints/use` resolves the live token at switch time, refreshing through the
vendor's own endpoint when it is within ten minutes of expiry, and writes the box's secrets with
`SAND_OPENAI_COMPATIBLE_TRANSPORT`, `_ACCOUNT_ID`, `_ORIGINATOR` and `_CONTEXT_WINDOW`. Host side:
the OpenAI-compatible transport gained a Responses mode (`openai-compatible-chat.ts`), chosen by
`SAND_OPENAI_COMPATIBLE_TRANSPORT=responses`: chat history becomes Responses items, the system
prompt travels as `instructions`, `store: false`, tools as top-level function tools, and the
request identifies as `originator: grok-bot` with `chatgpt-account-id`; the same events come out.

**Measured, this Mac + the box:**

- Scan: Codex present and usable (identity `jbrashear@titaniumcomputing.com · pro plan`, expiry
  2026-09-05; the relay's environment sets `CODEX_HOME` to Orca's managed Codex home, which the
  CLI's own override rules honour), MiniMax absent (no CLI login here), Gemini present by
  existence only, Claude present via `claude auth status --json` (`jason@webdevtoday.com · max
  plan`). No token-shaped string and no stored secret in the output.
- Leak gate: three adopted secrets held; none in `ui/endpoints.json`, the host log, three agents'
  transcripts, or the scan output; store mode 600.
- Codex adoption gate: adopted as a keyless Responses row (model follows the CLI's own
  `config.toml`, `gpt-5.6-sol`; the guessed `gpt-5-codex` family is refused for ChatGPT accounts);
  box on `transport=responses`, `originator=grok-bot`, account id set; rubric on a fresh agent
  **95/100**: speak 2/2 (16 s, 6 s), work 2/2 evidenced, history 1/1 evidenced, 155 s wall;
  `~/.codex/auth.json` sha256 unchanged before and after.
- Pasted-key plumbing (Z.AI, throwaway key): adopt → keyless row → use writes key and 128k window
  to the box → 0 occurrences in `endpoints.json` → leak gate clean → forget removes the row → box
  restored with transport and originator cleared.
- Unit: 107/107 (eight new: Responses transport headers, body, events and error; store mode; MiniMax
  and Codex refresh against a mocked vendor, vendor file untouched; secret-free scan).

**Operator-blocked, honestly:** the Z.AI and MiniMax acceptance lines need a Z.AI coding-plan key
and a MiniMax CLI login that only Jason has; both paths are exercised end to end with mocks and a
throwaway key, and `--models subscription:zai` fails cleanly with "needs an API key" until then.
Kimi Code's token here is expired; Kimi runs by pasted key. Grok's CLI store carries an ArgentOS
identity and an expired token; Grok stays on the xAI key.

**Addendum 21:58 CDT, keys in.** Jason pasted the Z.AI and Kimi keys in the dashboard (Plugins,
provider cards; the paste needed two submits until the adapter emitted an event type the app
redraws on, fixed in `2d89358`). Battery on fresh agents, work rounds evidence-required:

| provider | model | score | speak | work | history | median turn | note |
|---|---|---|---|---|---|---|---|
| Z.AI coding plan | glm-5.3 | **90** | 2/2 | 2/2 | 1/1 | 38 s | the free-ish local answer is now a plan answer |
| Kimi (Moonshot platform key) | kimi-k3 | 10 | 0/2 | – | – | – | HTTP 429 "account suspended due to insufficient balance"; the coding-plan host rejects that key. Billing, not the model |
| ChatGPT Pro (Codex login) | gpt-5.6-sol | **95** | 2/2 | 2/2 | 1/1 | 20 s | second run, same score |

Leak gate after the battery: three secrets held, none in `endpoints.json`, the host log, the
transcripts or the scan. The box switches endpoints while the battery runs; the agent card now
follows the live endpoint on every tick (`5fc7eb5`) so the card and the settings panel agree.

**Persona finding.** Asked "what AI model backend are you", the agent answered "I'm Grok Bot,
running on Grok, the LLM built by xAI" while the box was on glm-5.3. That is the upstream system
prompt's persona, not knowledge: nothing tells the model which backend it is on. A one-line
prompt addition naming the live endpoint and model would make that answer truthful; filed as
the next small host item, not done here.

## 7. The wave plan

**Closed 2026-09-02: waves 1–5 delivered (`docs/audit-wave1-prompts.md` … `audit-wave5-fixes.md`).
The scope discipline below applied to the audit only and ended 2026-08-30; every commit since is
feature work under its own contract. §5 and `docs/GAP-ANALYSIS.md` are the live backlog; this
section is history.**

Scope discipline: **read-and-prove only.** No features, no drive-by fixes; the sole
mutation allowed is Wave 3's temporary wire tap, which is removed after capture.

- **Wave 1 — Prompt assembly, exhaustively.** Read end-to-end: `system-prompt.ts`,
  `system-prompt-assembly.ts`, `sand-agent-profile-prompt.ts`, `runner-prompt-glue.ts`,
  `prompt-collector-glue.ts`, `turn-agent-composition.ts`, `conversation-outline.ts`,
  `agent-state.ts`, `box-reference-docs.ts`, and the path from `sand-agent-runner.ts`
  into `provider-session.ts`. **Done =** a call graph turn-start→provider naming every
  section that can enter the system prompt, its gate, and where it can be dropped —
  every node with `file:line`.
- **Wave 2 — Toolset assembly, exhaustively.** `turn-toolset.ts` + all 23 tool files.
  **Done =** table `tool → gate condition → reaches openai-compatible path?`, and a
  verdict on whether Chief *could* have dispatched a subagent.
- **Wave 3 — The wire.** Tap the outgoing request in the patched bundle (full
  instructions, tool names, roles → file), rebuild, `docker restart`, one prompt, read
  the capture, remove the tap. **Done =** Waves 1–2 upgraded from "read" to "proven",
  P1 hypothesis selected by evidence.
- **Wave 4 — Diff vs upstream intent (§6).** Each capability marked wired / partial /
  absent, with evidence per row. Screenshots folded in when supplied.
- **Wave 5 — Ranked fix list.** Written only after 1–4; each item carries its evidence
  trail and a cost estimate. Nothing is built inside these waves.

Contract acceptance candidates (for the operator's contract step): Wave 1+2 documents
committed with every claim carrying `file:line`; Wave 3 capture file exists and is quoted
in the findings; P1 closed with a named cause; explicit unverified-list present in each
wave's output; `npm test` still green; zero UI/feature diffs outside `docs/`.

## 8. Where things live

- **The desktop through the relay (2026-09-04):** `ui/server.mjs` serves `/vnc/<display>/` from the
  box's noVNC and proxies `/vnc/<display>/websockify` (6080 for the primary, 6081 with the token
  for a fork display), authenticated like every other route; the adapter builds the frame on the
  page's own origin. A gateway bearer on a page request mints the session cookie, which is how
  `verify-deploy.mjs` logs in without a password.
- **More host switches (2026-09-04, Wave U1):** `SAND_MEMORY_DREAMING` (start-time: read once when
  the memory extension starts, so a restart applies it), `SAND_AUTO_REVIEW` (enforce override,
  live per call) and `SAND_AUTO_REVIEW_MODE` (off, shadow, enforce; live). The gates table marks
  live rows with `live: true`. Auto-review's own trace lines (`[sand][auto-review]`) appear only
  with `SAND_TOOL_TRACE=1` and carry a redacted subject.
- **Host switches (2026-09-04):** `/home/box/sand-data/sand-host-settings.json` (0600, flat
  `{"NAME":"value"}`), re-read per call, so `SAND_TOOL_TRACE=1`, `SAND_BROWSER_USE=1` and
  `SAND_TEACH=1` flip on a running box. Never in `box-secrets.json`: the `SAND_` prefix is reserved there and a key with it
  silently disables persisted box-secret injection (GAP-ANALYSIS ENDPOINT-2). Trace lines:
  `[sand][toolset]` = what buildTurnTools offered (conversationId, flags, tool names),
  `[sand][wire]` = what actually left for the provider (transport, model, offered, sent, names);
  `sand-system-prompt-<agentId>.json` beside the settings file = section-presence report only, never
  prompt text. `[sand][workflow]` = one line per workflow reference an invocation expanded into the
  turn's prompt (conversationId, skill id, source, body head, `bodyChars` how long the recipe is,
  `inlinedChars` how much of it the model was handed, `isTruncated`, block size, teach queue
  scope): the outline stores the message that was sent, not the expansion, and the wire trace
  deliberately carries no message content, so this is the only place that shows a recipe actually
  reached a turn. Gate for all of it: `scripts/verify-toolset.mjs`.
- **Fork windows (2026-09-04):** the host is the only allocator. `ForeverBoxService.ensure`
  refuses an agent that is deleted or tombstoned before the box is touched; `SharedDesktopSandBox`
  tears down a window whose assignment vanished while it was starting; `start-window` in the box
  tears down and adopts any live seat whose token the host did not issue (the old refusal wedged
  the lowest free index until a container restart). `verify-windows.mjs` proves all three. Blank
  agents are hidden by the roster but still hold windows (DISPLAY-5).
- **Prompt-trace reports:** `sand-system-prompt-<id>.json` is swept on the first write per host
  life for agents whose directory is gone, and unlinked when an agent is deleted.
- **sqlite3** is installed in the box by `recreate-box.sh` after the window patch; the learn
  recipe's history step needs it.
- **Teach by demonstration (2026-09-04):** two things kept it off this box, both fixed.
  `sand_teach_by_demonstration` is a Statsig gate that never bootstraps without a Cursor login, so
  `SAND_TEACH` now resolves it the way `SAND_BROWSER_USE` resolves the browser subagent (read live
  on every `isEnabled` call, so no restart). And stop-with-save calls
  `ensureManagedSkill("learn-from-demonstration")`, a skill that only ever arrives from Cursor's
  dashboard, so saving died at "learning workflow is unavailable". The two real managed skills are
  now baked into the bundle (`source/host/extensions/managed-setup/seed-skills/<id>/SKILL.md` plus
  `scripts/gen-seed-skills.mjs` emitting `seed-skills.gen.ts`) and every managed-skills cache write
  is the union of seeds and fetched, fetched winning on an id collision. The seed write runs at
  `managed-setup` start regardless of auth, because the skills service itself only starts once an
  access token exists. The cache is two files and `ensureSeeds` repairs both: `cache.json`, which
  is where an invocation reads the recipe, and `skills/<id>/SKILL.md`, which is the path the agent
  is handed and the only copy it can read for itself. Both halves are checked **by content**:
  `withSeedSkillsRestored` replaces any seed row that no longer matches the bundled copy and
  `managedSkillFilesMatch` compares each file to the bytes its row would write. Checking that the
  id was listed and the file existed was not enough - an edited recipe never reached a box that
  already held the old one, a hand-mangled `cache.json` row stayed mangled, and a deleted skill
  file stayed missing, all across every restart with nothing in the log to say so. A dashboard
  copy is still not lost to this: the startup refresh follows the seed write and puts the fetched
  version back on top.
- **A dispatched recipe arrives whole (2026-09-04):** `buildWorkflowRunPrompt` inlines the skill
  body capped at `WORKFLOW_INJECTED_BODY_LIMIT`, which was 8000 against a 9985-character
  learn-from-demonstration recipe. The cut landed mid-sentence inside step 5 and dropped both the
  write-the-skill payload and section 6, the only place that tells the agent to release the queue
  file it claimed, so a teach run claimed work it was never told to finish or release. The cap is
  16000, big enough for a real managed skill, and past it `injectedWorkflowBody`
  (`source/shared/workflow-model.ts`) stops on a line break and says how much is shown and which
  file holds the rest. That 16000 is a **deliberate divergence from the shipped bundle**, which
  pins `WORKFLOW_INJECTED_BODY_LIMIT = 8e3` and cuts with the same bare slice: the product
  truncates its own recipe, and a diff against it will show 8000 on that line by design, not by
  transcription error. Gate: `scripts/verify-teach.mjs` (`--keep-setting` leaves `SAND_TEACH="1"`),
  which fails unless the two on-box copies of the recipe are the same text, unless
  `inlinedChars === bodyChars`, and unless the agent claims the queue file.
- **Agent lifecycle facts (2026-09-03):** an agent is a directory under `agents/` with `store.db`;
  `deleted-agents.json` beside them is the tombstone list every reader consults; subagent ledgers
  live at `agents/sand-subagent-<id>/audit.jsonl` and are not agents; shared-desktop window
  assignments persist in `/home/box/.sand-window-assignments.json` and are released on delete.
  Every gate that mints a probe deletes it and reports any agent that appeared during its run.


- The console draws a snapshot the adapter hands it on an event, and the adapter's 15 s heartbeat emits only when its signature of the active record moved (`recordSig`, plus `routinesSig` since AUTOMATION-3). Anything the host writes on its own that a view shows must be in one of those signatures or the operator never sees it; the dashboard gate's planted-routine check is the proof for routines.
- Connectors, as of 2026-09-05 afternoon: a connector entry in `connectors.json` is {command,args,env}; an env key with an EMPTY value is a credential field (host rule in `connector-secrets.ts`, mirrored by the console card), a key with a value is configuration and is never offered for a paste; the value goes through setConnectorSecret into `connector-env-secrets.json` (0600) and is merged into the connector process env at launch; the connector editor's preset catalog (gateway-adapter.js, exported data) fills GitHub, Slack, Linear, Google Workspace and TinyFish; the editor's Arguments field is quote-aware so a header with a space survives; a preset that owns its name replaces an existing entry of that name (spec.replace). Remote servers ride `npx -y mcp-remote@0.8.3 <url> --transport http-only --header "Authorization:Bearer ${VAR}"`. Shell tools (CodeRabbit CLI, TinyFish CLI) use a separate shell-secret store merged into the agent shell's env, with install commands run in the box as user box. Receipts: `verify-connector-plane.mjs` arms --tinyfish-key, --github-key, --linear-key (stub MCP server in the box that demands the Bearer), --slack-stdio, --google-stdio (real pinned packages with invented tokens), --shell-secrets, --stalled-server; the operator index is docs/CONNECTORS.md and the research is docs/connectors/.
- The box supervisor's receipts: `/tmp/sand-supervisor.log` (its own starts, "desktop: restarted" and "crash-looping" lines), `/tmp/sand-box-telemetry.log` (`supervisor_restart` events with the wrapper's cause, `status_stale` means the 180 s heartbeat kill), `/tmp/sand-host-profiles/*.cpuprofile` (written by the host's pressure profiler before each kill; summarize by self time, the host was idle in every one). The desktop registry is `/tmp/sand-desktop/<group>/<component>.json` plus a pid file; it survives `docker restart`. The switch that turns the respawn engine off is `SAND_DESKTOP_SUPERVISION_DISABLED=1` in the box env (BOX-4), and the start line `[sand-supervisor] started (... desktop supervision off)` is the proof it took.
- Worktree `/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb`, branch `webdevtodayjason/gb`.
- Session memories: `~/.claude-titanium/projects/-Users-sem-orca-grok-bot-0-18-reconstructed/memory/`
  (index `MEMORY.md`; the tool-schema, wedged-agent, box-operating-facts and
  browser-verification entries carry the detail behind §2 and §4).
- Research teardown of the original app: `~/grock bot research/` — check before source-diving.
- Live artifacts (republish same slug to update): runbook `grok-bot-reconstructed/runbook-bd5d9282`,
  motion notes `motion-runbook-5a002f54`, capability audit `plumbing-f6eae393`.
- The upstream product docs quoted in §6 arrived as a paste from docs.x.ai/grok-bot
  (overview, get-started, bots, chat, files, computer-and-apps, skills-routines,
  approvals-security, teams, FAQ, troubleshooting) — 2026-08-30.
