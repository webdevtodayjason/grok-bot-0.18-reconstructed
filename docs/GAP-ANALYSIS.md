# Gap analysis — Titanbot (Grok Bot 0.18 reconstruction)

**Measured 2026-09-02 on this Mac + the box `grok-bot-local-vm`, at commit `9875728`.** Ten audit
agents read five planes independently (dashboard surfaces, gateway coverage, connectors and plugins,
the model toolset, host stubs). Every finding was then handed to a second agent instructed to refute
it. 90 findings; 87 survived; 3 were refuted (two because the fix had already landed in `09753d6`
while the audit ran, one because its headline inference was wrong). The raw findings with verifier
notes live in the session record; the ids below (`MR-`, `GW-`, `CP-`, `TOOLS-`, `SP-`, `BL-`) are
stable so a wave can cite them.

This document is the ranked backlog. `docs/PLUMBING-AUDIT.md` §5 remains the live open-problems
ledger for the *host* and now points here; the living dashboard carries the current position.

## 0. Status, 2026-09-03 03:00 CDT (measured on this Mac + the box, bundle from the working tree after `526a013`)

**Waves A and B landed** (`526a013`, plus the browser-subagent follow-up commit). Every proof in
§5 for those two waves ran green on the live box in one sequential pass: unit 126/126, source
typecheck, `verify-toolset` in all four modes (chief 36 tools with GetMcpTools and CallMcpTool;
computerUse child 3 tools; connector round trip stamped evidenced; browserUse child reads
example.com and the parent reports "Example Domain"), subagent dispatch, evidence replay, work
report with evidence required, dashboard 35 checks plus its leak arm, subscription leak scan.

**Landed rows** are marked "landed" in §4. Left open from those waves, now their own rows:

| Id | Finding | Next | Size |
|---|---|---|---|
| SP-1b | User and project memory stay null in the prompt: `createUserMemory` / `createProjectMemory` exist on no api; the two candidate classes have mismatched recall signatures | Decide whether the product wants user/project memory sections; if so, write the two factories against the memory service and re-hoist | M |
| TOOLS-13 | The SetMcpInstructions round trip has no runnable proof: the prompt is never written out (by design, it carries memory), and the section report has no marker for connector instructions | Add an `mcpCustomInstructions` marker to the section report and a `verify-toolset --mcp-instructions` mode; needs CP-07 so `local:` ids validate | S |
| SUB-2 | Browser tools return text only; the per-action screenshot the driver captures stays on the box | Carry `imageB64` as an image part the way the Computer adapter does (`createImageResult`) | S |
| ENDPOINT-2 | The relay writes the `SAND_OPENAI_COMPATIBLE_*` pin into `box-secrets.json`, a store whose `SAND_` prefix is reserved, so `BoxSecretsApplier.applyPersisted` has always bailed on this box and no real box secret is ever injected | Move the pin to `sand-host-settings.json` in `provider-session.ts` and repoint `ui/server.mjs` at the same file in one change. Proof: `box-secrets.json` holds no `SAND_` key and the host log prints "applying N persisted box secret(s)" | M |
| GW-15 | `setAgentUnread{isUnread:true}` errors with "this.tm.sessionStore.seedSessionActivityFromDbMtime is not a function"; the clear direction works, which is all MR-06 needs | Trace the session store method on the raise path; one host fix | S |
| MR-11, MR-15 | Not in Wave B: the run rail's synthetic timeline, and the credential card (needs the secret-card work in Wave D1) | Wave C / Wave D1 | S / M |

**Regression caught by the final gate pass, fixed before commit.** Giving subagents their own
audit identity created `agents/subagent-<id>/audit.jsonl` beside the real agents, and the roster
enumerates every directory there and *recovers* a missing database into a new agent: seventeen
phantom "New Agent" rows appeared with materialized databases. Root cause underneath: the
reconstruction minted subagent ids as `subagent-<uuid>` while the shared predicate
`isSandSubagentId` expects `sand-subagent-`, so upstream's own guards (roster projection, the
subagent branch of `getConversationOutline`) never matched. Ids now carry the shared prefix, the
three directory enumerations skip subagent ledgers, and `verify-toolset` asserts the roster holds
no subagent id after any subagent run. Side effect worth having: the conversation outline for a
subagent id now answers.

**How the browser subagent was actually broken, four faults deep.** The audit's "gated off" was
the first layer only. With the gate open: (1) the prompt glue was built once with every identity
flag false, so the child got the chief's desktop prompt with no Browser section and a ban on
driving Chrome from Shell; (2) the fifteen browser tools declared no `parameters`, and the
OpenAI-compatible executor silently drops such tools, so on the wire the child held Shell and Read
only, which is why it truthfully said its browser tools were unavailable; (3) the tools kept
Cursor's `execute(context, args, metadata)` order while this core calls `execute(ctx,
interactionHandler, args, meta)`, so every call failed "url is required"; (4) the auto-review
preflight probes Chrome on the agent's display before the driver has launched it, and this box's
shell executor reports the refused connection as `failure` with an exit code, which the preflight
read as a capture error instead of its own chrome-unreachable path. Each layer was found by
instrumenting, not by reading: the `[sand][toolset]` line (what buildTurnTools offered), the new
`[sand][wire]` line (what actually left for the provider), the child's own audit ledger, and a
logged cause in the preflight. Both switches live in `/home/box/sand-data/sand-host-settings.json`
(`SAND_TOOL_TRACE`, `SAND_BROWSER_USE`) and flip on a running box.

## 1. Executive summary

The reconstruction is far more complete than a stub grep suggests, and the damage has one shape:
**things that are built and wired to nothing, or wired to a constant.** Every one of the 123 gateway
commands resolves to a real implementation. The host's memory, routines, skills, channel and
connector code all exist. The Machine Room's wired surfaces are genuinely wired. What is broken is
the handoff between layers:

- **The model never sees seven things the host computes for it.** The production system-prompt
  assembly is handed null providers for memory (agent, user, project), routines, skills, and
  channels (SP-1), and constants for connector instructions and the discovery-unavailable notice
  (SP-2). The dashboard reads all of those through the gateway. The agent does not. This is the
  same defect class the audit already caught once for the agent directory and fixed; seven
  siblings in the same object literal were left behind.
- **A connector's tools can never reach the model.** Local stdio connectors work end to end
  today (`connectors.json` → box process → discovery → 14 tools with schemas), and the discovery/call
  pair the model would use is never constructed because the `mcpMeta` projection is read in two
  places and written in none (TOOLS-01, CP-01, TOOLS-10). Ten tools for managing MCP servers, zero
  for using one.
- **63 working gateway commands have no surface.** The two UIs call 41 of 123. Of the 82 unused,
  about 19 are dead ends on this box (Cursor or xAI account required); the other ~63 are local,
  implemented, and would work today: the whole skills family (9 commands), transcript paging and
  tailing, the evidence read, attachment reads, box lifecycle including hand-back, and the per-agent
  identity write path.
- **The dashboard's empty modals are five specific surfaces**, all cheap: the room ••• menu
  (hardcoded copy, dead button), the Plugins panel's Tools and Skills sections (builders hardcode
  empty arrays), the Browser row in Agent details (adapter writes an empty URL), the Unread modal
  (nothing ever marks a conversation viewed), and the "Now" island (the host never reports a routine
  as running through that path). Two trust defects sit beside them: the key form says the key was
  discarded while the relay stores it, and "Connect" on a not-yet-usable provider card sends a
  connector command that always fails behind a green toast.

The two numbers the operator asked about reconcile as follows.

## 2. Thirty-four tools versus "a hundred and twenty"

**The 120-something is the gateway, not a toolset.** `SAND_GATEWAY_COMMANDS` registers exactly 123
entries (`source/host/gateway-protocol.ts:4-128`), served as `POST /api/<command>` to the desktop
app and the Machine Room. That is the operator API. The model never sees it, and the two UIs call 41
of them. Its gap is a UI-wiring gap (section 4, GW-*), not a model-capability gap.

**The model's ceiling in this role is about 36, and we offer 34.** `TurnToolFactories`
(`turn-toolset.ts:551-578`) declares 26 factory slots. Five expand to arrays, so the whole tree
defines 55 distinct model-facing tool names across all agent roles. No single agent can ever see all
55: the chief, the computerUse subagent, the browserUse subagent and a group bot each get a
different projection. For the chief with the box up, `buildTurnTools` offers 34:

| Group | Count | Tools |
|---|---|---|
| Conversational | 8 | Task, TodoWrite, SendMessage, SendToAgent, ReactToMessage, CreateAgent, UpdateAgent, update_state |
| External and web | 5 | ExternalShell, ExternalRead, ExternalAwaitShell, WebSearch, WebFetch |
| Box | 3 | Shell, Read, AwaitShell |
| File transfer | 2 | CopyToBox, CopyFromBox |
| Desktop | 2 | Screenshot, request_box_help |
| MCP management | 10 | SearchPlugins, GetPlugin, InstallPlugin, UninstallPlugin, AddMcpServer, UninstallMcpServer, GetMcpServerStatus, SetMcpInstructions, RestartMcpServers, AuthenticateMcpServer |
| Subagent management | 3 | CheckSubagent, MessageSubagent, StopSubagent |
| Cloud | 1 | CloudAgent (the unnamed 34th; its team-policy gate never resolves, TOOLS-09) |

The 26 in `docs/evidence/wire-request-0.json` were captured before the box was up; the eight added
since are exactly the box-gated and subagent-management tools plus CloudAgent.

**The 21 withheld, and why:**

| Tools | Count | Why | Verdict |
|---|---|---|---|
| Computer | 1 | By design: only the computerUse subagent gets it, via Task | correct (TOOLS-04) |
| browser_* | 15 | The browserUse subagent is never offered in Task's enum, and its Statsig gate defaults false with no env override | **gap** (TOOLS-03, SUB-1) |
| GetMcpTools, CallMcpTool | 2 | `mcpMeta` is never populated on the production projection | **the real gap** (TOOLS-01, CP-01) |
| generate_image | 1 | No provider anywhere in the tree | decision (TOOLS-05) |
| RemoveMcpAccount, RenameMcpAccount | 2 | `mcp_multi_account` must stay off until a backend index exists | correct (TOOLS-06) |

Connector tools never appear as individual functions on the wire, in this codebase or upstream's
design. They ride inside the two-tool meta pair (`mcp-tool-registry.ts:17-38`): GetMcpTools lists
them, CallMcpTool invokes them. A fully connected upstream agent in this role therefore sees ~36
tools, not 120. Dynamic-tools mode (`grok_bot_dynamic_tools`, default false) moves tools *out* of
the wire list behind a dispatch pair and lowers the count further. Group bots are filtered to 5
tools (or 1 for text-only rooms) by `SHARED_ROOM_TOOL_NAMES` (TOOLS-07).

So: the real tool gap is **two tools** (the MCP meta pair, which unlocks every connector) plus the
**browser subagent** behind a gate. Everything else the operator remembers as "tools" is either the
gateway (section 4) or the seven prompt sections the model is not shown (section 3).

## 3. The shape of the damage

Six classes, ranked by how much product each unblocks.

**A. Constant providers on the production route (host).** SP-1 (memory, routines, skills, channels
handed `() => null` at `host-runner-composition.ts:1414-1418` and `:1431-1433`, while `:1702-1717`
passes the real stores to the gateway), SP-2 (`mcpConnectedServerNamesForTurn: () => []`,
`mcpCustomInstructionsForTurn: () => new Map()`, `isMcpDiscoveryUnavailableForTurn: () => false` at
`:1318-1320`; the three per-turn setters the run shell calls have no implementation), COMPACT-1
(`compactionEpoch: () => 0` at `:1414` and `:2781`, live now that compaction fires), TOOLS-02
(`isBoxScopedSubagent: false` at all three toolset-host sites, so a computerUse subagent gets the
user's machine, the web and CloudAgent instead of Shell, Read, Computer), TOOLS-09 (CloudAgent's
gate reads an experiments method that does not exist).

**B. The connector path stops one step short of the model.** TOOLS-01/CP-01 (meta pair never
built), TOOLS-10 (servers discovered every turn, injected into the prompt as names only), CP-10
(a submitted secret lands in `connector-secrets/<agentId>/<platform>.json`, a chat-channel store no
MCP path reads, and fabricates a phantom channel connection), CP-07 (`local:<name>` ids fail the
server-id validator, so instructions and per-tool toggles reject exactly the connectors that work),
CP-08 (per-tool permissions are enforced and stored but have no read command).

**C. Working gateway commands with no surface (dashboard).** GW-13 (the evidence read is called
only by verification scripts), GW-05 (all nine workflow/skills commands), GW-03 (acceptance status,
tail, page, thread, react), GW-01 (updateAgent, avatars, notifications, unread, duplicate), GW-06
(memory, present on the operator page only), GW-08 (six MCP reads including the tool list the
adapter claims does not exist), GW-09 (three attachment reads), GW-10 (hand-back after a takeover,
update, reset), GW-11 (secret card, dismiss), GW-14 (global search, index built and queried by
nobody).

**D. Dashboard surfaces with hardcoded or empty data.** MR-01 (••• menu), MR-02 (Tools/Skills
sections), MR-03 (key form says discarded), MR-05 (Browser row), MR-06 (unread never clears),
MR-04 (Connect on a non-adoptable card), MR-07 ("Now" unreachable), MR-08 (Model row is box-wide,
Role reads "not set" and cannot be edited), MR-09 (Files tab labelled "Not wired yet" over a working
view), MR-14 (a recording in progress is read from the host and never shown), MR-15 (credential
card with no answerable field), MR-10..13 (Sheets placeholder, synthetic run timeline, pause-view
toast, unreachable panel builders).

**E. Gates that never bootstrap.** This deployment never gets an authenticated Statsig bootstrap, so
every gate sits at its compiled default. TOOLS-03/SUB-1 (browser use, no env override unlike
multitask and spotlight), GC-1 (stale-root GC unreachable; conversation GC and blob retirement
off), GW-07 (teach recording throws at the gate), TOOLS-12 (multitask ships on while its comment
says off), FLAGS-1 (no startup log of the resolved gate table).

**F. The Cursor-bound half, and the missing decision.** CP-04 (Connect opens cursor.com), CP-05
(marketplace, install, uninstall are Cursor RPCs against an expired 13-character stub; the catalog
throws instead of returning empty), CP-06 (OAuth callback server was Electron-only), CP-13 (remote
http/sse servers execute through Cursor's backend; only stdio runs offline), CP-15 (skill sync on a
24h timer against a dead account), BACKEND-1 (sixteen host modules reach the xAI/Cursor backend).
CP-14: no substrate decision for this plane exists anywhere in the repo. That decision gates CP-05,
CP-06, CP-13 and CP-15 and is the one item in this document only the operator can close.

Backlog hygiene (BL-*, DEAD-1, BL-W5, BL-W7) is closed in the same commit as this document; see
section 6.

## 4. Findings, ranked

Sizes: S under an hour, M a session, L a design item spanning sessions. Duplicate root causes are
merged into one row and both ids kept.

### P0 — blocks the product's promise (15)

| Id | Finding | Fix | Size |
|---|---|---|---|
| TOOLS-01 · CP-01 · TOOLS-10 · **landed** | GetMcpTools/CallMcpTool never built; connector tools discovered per turn and dropped | Bind an `mcp` projection on the production path from the per-turn discovered tools and the MCP executor (`createSandMcpMetaToolOptions` exists). Proof: wire shows the pair; a fresh agent reads a file through the localfiles server with evidence | M |
| SP-1 · **landed** (memory, routines, skills, channels; user/project memory is SP-1b) | Memory, routines, skills, channels nulled in the production system prompt | Hoist the seven providers the way the agent directory was hoisted at `:1358-1395`; pass `session.memory`, snapshots, user/project memory, automations, workflows, channels. Proof: assembled prompt diff shows the sections | M |
| SP-2 · **landed** | Connector custom instructions and the discovery-unavailable notice never reach the model | Implement the three per-turn setters on the production turn owner; read that state instead of constants. Proof: SetMcpInstructions round-trips into the next prompt | M |
| TOOLS-02 · **landed** | computerUse subagent offered 12 tools instead of 3 | Derive `isBoxScopedSubagent` from the normalized subagent kind at `:2542` and `:2759`. Proof: subagent wire capture shows Shell, Read, Computer | S |
| CP-10 | A submitted connector secret is stored where nothing reads it | Make `routeSecret` connector-aware: merge into that server's `env` in `connectors.json` (0600, atomic) and restart it; keep the channel branch for slack/github | M |
| GW-13 · **landed** | Evidence verdicts exist, are measured, and no UI shows the receipts behind them | Disclosure behind the pill: `getAgentEvidence{id, attemptId}` → receipt count, tool names, attestation heads | S |
| GW-05 | Nine working skills commands called by nothing; teach has no product it can produce | Skills panel per agent mirroring Routines: list, enable, edit, delete, run, import text/URL | M |
| GW-03 | Only the flat whole-transcript read is used; acceptance never checked | Poll `promptAcceptanceStatus` after every send; tail on refresh, page on scrollback; thread and react later | M |
| MR-01 · **landed** | Room ••• menu is hardcoded copy with a dead button | Point it at `agentProfilePanel` / `membersPanel`, which are live, or delete it | S |
| MR-02 · **landed** | Plugins Tools/Skills sections structurally empty | Fill Tools from `listRoutedMcpTools` matched by server name; give Skills the same empty-state sentence or drop it | M |
| MR-03 · **landed** | Key form says the value is discarded; the relay stores it | Branch the hint and the toast on `group === "Providers"`; report the adoption result the adapter awaits | S |
| MR-05 · **landed** | Browser row renders blank on every agent | Show the screen fact from `ensureForeverBox` or drop the sub-line | S |
| MR-06 · **landed** | Unread counts never clear | Call `openAgent{id}` (or `setAgentUnread`) after the transcript loads in `selectContext` | S |

### P1 — wrong, misleading, or withheld (32 after the 3 refuted)

| Id | Finding | Fix | Size |
|---|---|---|---|
| SUB-1 · TOOLS-03 · **landed** (four faults, §0) | browserUse subagent unreachable; 15 browser tools dead | Third `subagentConfigs` entry from `createSandBrowserUseSubagentConfig`; `SAND_BROWSER_USE` env override mirroring `resolveMultitaskEnabled`. Proof: a dispatch returns a page read | M |
| TOOLS-09 · **landed** | CloudAgent's team gate never resolves | Point `cloudAgentsDisabledByTeam` at the cloud-agents service's `isDisabledByTeamAdmin` | S |
| MODEL-1 | Per-agent and per-subagent model dead on every routed provider; §5's "no new plumbing" was wrong | Per-session model override in `createProviderPromptSession`, `resolveSandRequestedModel` threaded through the routed branch keyed on subagent kind and stored settings. Design item; enables seniority routing against the rubric | L |
| COMPACT-1 · **landed** | `compactionEpoch` hardcoded 0 at both sites | Per-session counter incremented where turn-settle logs "conversation compacted"; must land with SP-1 | S |
| GC-1 | Stale-root GC unreachable on a self-hosted box | Env override matching the other two; decide local defaults | S |
| GW-01 | Agent identity write path unwired: no edit, avatar, notifications, hygiene | Agent-detail panel on `updateAgent`, `setAgentAvatarBytes`, notify setters, hidden/unread, duplicate | M |
| GW-06 · **landed** | Memory only on the operator page | Port the three call sites into the Machine Room agent-detail panel | S |
| GW-07 | Teach recording throws at a default-off gate | Dev-flags row through `setHostSettings{featureFlagOverrides}`; then settle the fork-window contradiction with one live call | M |
| GW-08 | Six MCP reads unused; adapter's "no tool list" claim is false | `togglePluginTool` on `listRoutedMcpTools` + `listBoxMcpServers` + `setHostSettings{mcpDisabledToolsByServerId}`; `getAgentChannels` on the cards | M |
| GW-09 | Attachments uploaded but never rendered | `readAttachmentImage` inline for screenshots, text/chunk previews; `searchMedia` behind Files | S |
| GW-10 | No hand-back after a takeover; no update/reset panel | Hand-back control driven by `pendingHandoff`; Updates panel on `getHostStatus` + `updateForeverBox` + `resetForeverBox` | M |
| GW-11 · CP-09 · MR-15 | The masked secret card is complete on the host and dead in every UI | Carry `entryId` through `cardOf`, masked input, `submitSecret{entryId,value,agentId}`; wire `dismissWidget` on × | M |
| GW-14 | Global search index built and queried by nobody | Cmd-K palette on `isGlobalSearchEnabled`, `searchAgents`, `searchMedia` | M |
| CP-03 | The one real connected connector is invisible in the UI | Three read commands wired to `mcp.management` (listInstalled, listPlugins, getPlugin); cards from listInstalled; listener rows in their own section | M |
| CP-04 | Connect opens cursor.com for an account we do not own | Token form calling `connectChannel{id,platform,token}`; label the Cursor route honestly | S |
| CP-05 | Marketplace/install are Cursor RPCs on an expired stub; catalog throws | Short term: return `[]` on catalog failure. Real: local manifest index + install into the plugin cache, routed at the connectors.json writer. Gated on CP-14 | L |
| CP-06 | OAuth callback server was Electron-only | ~40 lines in the relay on 127.0.0.1:8787 → `completeMcpOAuth`. Only after CP-05 | M |
| CP-07 | `local:<name>` ids fail the validator | Stable numeric ids per local server, persisted beside connectors.json | S |
| CP-08 | Per-tool permissions have no read surface | `listMcpServerTools`, `toggleMcpToolDisabled` forwarding to the existing instructions-and-toggles methods; depends on CP-07 | M |
| CP-13 | Remote http/sse servers run through Cursor's backend | Extend local-connectors to `{url,type,headers}` and add an HTTP transport to the box exec daemon; the only route to Cursor-free remote connectors. Gated on CP-14 | L |
| MR-04 · **landed** | Connect on a non-adoptable provider card always fails behind a success toast | Suppress the button for Providers with a non-adoptable route; move the toast to the resolution path | S |
| MR-07 · **landed** | "Now" island can never show a running routine | Derive running from `lastRun.status` or the owner's `isRunning`; otherwise delete the branch | S |
| MR-08 · **landed** | Model row is box-wide, Role reads "not set" and cannot be set | Label "Endpoint (box-wide)"; Role editable through `updateAgent` | S |
| MR-09 · **landed** | Files tab labelled "Not wired yet" over a working view | One-line label change | S |
| MR-14 · **landed** | A recording in progress is never surfaced after reload | On boot, if `state.teaching.active`, open teach mode seeded with the host's `startedAt` | S |
| TOOLS-11 | The 34-vs-120 reconciliation was undocumented | Section 2 of this document; the audit doc's two "122" corrected to 123 | S |
| BL-P1 · BL-W5 · BL-W7 | Backlog rows stale: P1 closed but written open; wave-5 item 11 fixed but open; §7 reads as standing policy | Closed in this commit, section 6 | S |

Refuted, kept for the record: **TOOLS-08** (the empty `toolsGenerator` at `turn-toolset.ts:1459` is
inside a config path Task never uses for dispatched subagents; the silent-empty fence at `:1421` is
by design), **BL-P1b** and **BL-P1c** (both fixes were committed in `09753d6` with the runaway
brake in `scripts/model-rubric.mjs:83-85`; the audit read a stale tree).

### P2 — decisions, hygiene, and confirmations (40)

Confirmed wired, no fix: MR-16..25 (roster, transcript with receipts and evidence pills, decision
cards, routines, settings, add agent/room, composer, live box, schedule, demo fallback), OP-01,
GW-04 (routines fully wired; run history needs a new host read), CP-02 (local stdio connectors are
the spine), TOOLS-04, TOOLS-07, BL-P2.

Decisions (operator): **CP-14** closed, the substrate was decided 2026-08-18 (section 7, `docs/CONNECTOR-PLUGIN-PLANE.md`); **ENDPOINT-1 / BL-P3** recreate the box
without the env lines or invert precedence; **TOOLS-12** keep multitask on and fix the comment;
**TOOLS-05** generate_image only if an image model is wanted; **GW-02 / GW-12 / TOOLS-06 /
BACKEND-1 / CP-15** stay out of scope, said so here.

Hygiene (S each): MR-10 remove the Sheets tab (landed); MR-11 feed the outline's tool rows into the run
rail; MR-12 toast string (landed); MR-13 delete the unreachable builders (landed); CP-11 connectors editor on the
relay's existing `/connectors` route with a `refreshMcp` follow-up; CP-12 pass the agent id to
`disconnectChannel`; DEAD-1 delete `production-turn-input-projection.ts`, `createTurnToolSession`,
the duplicate spread; CHURN-1 / BL-P5 compare summaries before emitting `agent-upserted`; BOX-1 log
once that the standalone box has no windows or VNC; AUDIT-1 one `getAgentActionAudit` command beside
the evidence panel; FLAGS-1 log the resolved gate table at startup; BL-P4 / BL-P6 rewordings.

## 5. Wave plan

Each wave is one contract with a runnable proof, sized to a session, files bounded. Waves A and B
touch disjoint trees and can run in parallel; their verification shares the one box and runs
sequentially. Nothing goes live until the proof passes.

**Wave A — landed 2026-09-03 — the model gets what the host already has (host).** TOOLS-01/CP-01, SP-1, SP-2, COMPACT-1,
TOOLS-02, TOOLS-09, SUB-1/TOOLS-03. Files: `host-runner-composition.ts`, `turn-agent-composition.ts`,
the sand-multitask-style flag helper, tests. Proof: `scripts/verify-toolset.mjs` (new) captures a
chief wire request and asserts GetMcpTools and CallMcpTool are present and the count is 36; a fresh
agent reads `/workspace` through the localfiles server with an `evidenced` verdict; the assembled
prompt contains the memory and routines sections; a computerUse subagent wire shows three tools;
suite green.

**Wave B — landed 2026-09-03 — the modals tell the truth (Machine Room).** MR-01, MR-02, MR-03, MR-04, MR-05, MR-06,
MR-07, MR-08, MR-09, MR-10, MR-12, MR-13, MR-14, GW-13 disclosure, GW-06 memory port. Files:
`app.js`, `gateway-adapter.js`, `index.html`, `styles.css`, `verify-dashboard.mjs`. Proof:
`verify-dashboard.mjs` in headless Chrome asserts none of the strings "Standalone demo",
"Not wired yet", "Continue in prototype" render; unread clears after selecting a conversation; the
Browser row carries text; the evidence pill opens a disclosure with a receipt count; a Providers card
with a non-adoptable route shows no Connect button.

**Wave C — next — the working commands get a surface (Machine Room).** GW-03 (acceptance + tail), GW-05
(Skills panel), GW-01 (agent detail edit), GW-09 (inline attachments), GW-10 (hand-back, Updates),
GW-14 (palette), GW-08 (tool switches). Two sessions; C1 = GW-03, GW-05, GW-10 hand-back; C2 = the
rest. Proof per command: the call appears in the adapter and a headless check exercises it against
the live box.

**Wave D — own the connector plane on OpenConnector (`docs/CONNECTOR-PLUGIN-PLANE.md`).** D1 (no decision needed): CP-10, CP-07, CP-08,
CP-03, CP-11, CP-12, CP-04, CP-05 short-term, secret card (GW-11/CP-09/MR-15). D2:
OpenConnector as a stdio sidecar in the box, CP-13 local HTTP transport, CP-05 catalog through OpenConnector, CP-06 callback. Proof: a secret submitted from the
Machine Room lands in that server's env and the server restarts with it; the connected connector
shows on a card with its tool switches.

**Wave E — gates, hygiene, and the model item.** FLAGS-1, GC-1, TOOLS-12, DEAD-1, CHURN-1, BOX-1,
AUDIT-1, ENDPOINT-1 once the box is recreated, then MODEL-1 as its own design contract, tied to the
rubric (chief on the highest-scoring endpoint, workers on cheap ones).

## 6. Closed in the same commit as this document

- `PLUMBING-AUDIT.md` §5: P1 rewritten as closed with the cause named (§6g, §6i; browserUse
  remainder is SUB-1); P1b's stated directory corrected to `source/packages/chat-inference/`; P2
  struck as done; P4 names the box image as owner; P5 and P6 point at CHURN-1 and BL-P6; the
  "Opportunity" paragraph corrected (MODEL-1); a CP-14 substrate row added; a pointer to this
  document.
- `PLUMBING-AUDIT.md`: "122 commands" → 123 at both sites; the `completeMcpOAuth` stub claim
  corrected (it is implemented at `host-gateway-api.ts:683-691`; the callback server is the gap).
- `PLUMBING-AUDIT.md` §7: closed with a dated line so the read-and-prove scope discipline stops
  reading as standing policy.
- `audit-wave5-fixes.md`: item 11 struck with the `analytics-service.ts:68-76` citation.

## 7. What only the operator can decide

1. **CP-14, the connector substrate — already decided, not a question.** OOMOL OpenConnector
   (`oomol-lab/open-connector`) was locked on 2026-08-18 in the journeyman repo as the pinned,
   self-hosted catalog and local executor; Activepieces supplements, the MCP Registry is a
   discovery feed, Composio and the rest were evaluated and not chosen. This repo now carries the
   pointer in `docs/CONNECTOR-PLUGIN-PLANE.md`. The 2026-09-02 audit searched only this tree and
   filed it as open. What remains is engineering: run OpenConnector as a stdio sidecar in the box
   first (D2), or make the HTTP MCP path execute locally (CP-13); inject secrets into the server
   env at spawn (CP-10). Wave D1 needs none of it and starts now.
2. **ENDPOINT-1.** Recreate the box without the `SAND_OPENAI_COMPATIBLE_*` env lines (30 s
   downtime, the relay switch becomes permanent). Recommendation: yes, at the next quiet moment.
3. **MODEL-1 timing.** Per-agent model is a design contract, not a wiring job. Recommendation: after
   Wave A, before Wave C2, because it is the token-bill lever.
