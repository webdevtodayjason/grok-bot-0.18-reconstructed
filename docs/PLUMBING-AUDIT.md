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
        Host gateway (127.0.0.1:1340) ── 122 commands, POST /api/<cmd>, GET /events SSE
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

**P1 — Chief narrates actions it does not take.** Said *"Launching the browser subagent
now"*; `getSubagents` → `[]`, `getAsyncTasks` → `[]`. Also refuses tool-list diagnostics
with invented policy, and offers bulleted menus where the upstream prompt demands widgets.
Three hypotheses, none proven: (a) the 281-line runner prompt never reaches the
openai-compatible branch and the thin fallback lets the model improvise; (b) the dispatch
tools (`computerUse`/`browserUse` subagent configs exist — `sand-computer-use-subagent.ts`,
`sand-browser-use-subagent.ts`) are not in the toolset this path offers; (c) tools offered,
model emits prose anyway. **Wave 3 decides.** Note `listRoutedMcpTools` returning `[]`
concerns MCP tools only — it says nothing about the turn toolset.

**P2 — The turn toolset has never been enumerated.** `turn-toolset.ts` is 1,532 lines plus
23 tool files, unread. Everything said so far about "what tools the agent has" is inference.

**P3 — Endpoint pinned by container env.** The operator panel is built and honest about
this (red banner). One recreate without the `SAND_OPENAI_COMPATIBLE_*` lines hands the
switch over permanently. Asked; awaiting "go".

**P4 — Per-agent screens.** Upstream: "each Bot gets its own screen." Our box: one X
display (`/tmp/.X11-unix/X1`), the token-routed websockify on :6081 running with an
**empty** token dir. The fork machinery exists (`box-windows.ts` `runWindowScript`,
window indexes, "live fork owned by a different agent" error path; `sand-window-router.mjs
1339 1337 14000`). Real work, not a flag.

**P5 — Event churn.** `agent-upserted` fires every few seconds idle. The UI diffs it away
now, but the host-side chatter is unexplained.

**P6 — cosmetic.** Trigger-row controls wrap loosely in the 432px rail.

**Opportunity, not a problem:** `settings-service.ts:33` exposes `agentDefaultModel` and
`computerUseModel` — per-agent model fields already in the settings store. That is the
hook for seniority-as-routing (chief on Nemotron, cheap workers on small models) with no
new plumbing.

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
  `sand-state-tool.ts` (`update_state`, cronTrigger) — whether it reaches the local model
  path is a Wave 2/3 question.
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
  `completeMcpOAuth` is a stub (`host-gateway-api.ts`, `async () => undefined`) — the
  callback server lived in the Electron main, so a local re-implementation belongs in the
  relay (Wave 5 candidate).
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

**The gateway registers 122 commands, and the first audit was wrong about several.** It claimed no
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

Practical note: use a fresh agent for desktop checks, or the gate reports a capability failure that
is really a context-length failure.

## 7. The wave plan

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
