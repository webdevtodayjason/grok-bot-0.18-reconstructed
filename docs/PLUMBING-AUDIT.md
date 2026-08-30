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

Raw narration transcripts and full frame sets live in the session scratchpad (`vid1/`,
`vid2/`); scratchpads die with the session, so anything load-bearing is written here.
Requested next recordings: Plugins (covers connectors), then the config area.

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
