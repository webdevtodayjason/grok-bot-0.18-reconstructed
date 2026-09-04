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
typecheck, `verify-toolset` in all four modes (chief 36 tools with GetMcpTools and CallMcpTool, 35 once CLOUD-1 withheld CloudAgent;
computerUse child 3 tools; connector round trip stamped evidenced; browserUse child reads
example.com and the parent reports "Example Domain"), subagent dispatch, evidence replay, work
report with evidence required, dashboard 35 checks plus its leak arm, subscription leak scan.

**Landed rows** are marked "landed" in §4. Left open from those waves, now their own rows:

| Id | Finding | Next | Size |
|---|---|---|---|
| SP-1b | User and project memory stay null in the prompt: `createUserMemory` / `createProjectMemory` exist on no api; the two candidate classes have mismatched recall signatures | Decide whether the product wants user/project memory sections; if so, write the two factories against the memory service and re-hoist | M |
| TOOLS-13 · **landed** | The SetMcpInstructions round trip has no runnable proof: the prompt is never written out (by design, it carries memory), and the section report has no marker for connector instructions | Add an `mcpCustomInstructions` marker to the section report and a `verify-toolset --mcp-instructions` mode; needs CP-07 so `local:` ids validate | S |
| SUB-2 · **landed, on the wire** (the history flattener dropped every rendered image before the request left, measured 2 in history and 0 on the wire; fixed 2026-09-04, the browser gate now asserts 1 in history and 1 on the wire) | Browser tools return text only; the per-action screenshot the driver captures stays on the box | Carry `imageB64` as an image part the way the Computer adapter does (`createImageResult`) | S |
| ENDPOINT-2 | The relay writes the `SAND_OPENAI_COMPATIBLE_*` pin into `box-secrets.json`, a store whose `SAND_` prefix is reserved, so `BoxSecretsApplier.applyPersisted` has always bailed on this box and no real box secret is ever injected | Move the pin to `sand-host-settings.json` in `provider-session.ts` and repoint `ui/server.mjs` at the same file in one change. Proof: `box-secrets.json` holds no `SAND_` key and the host log prints "applying N persisted box secret(s)" | M |
| GW-15 · **landed** | `setAgentUnread{isUnread:true}` errors with "this.tm.sessionStore.seedSessionActivityFromDbMtime is not a function"; the clear direction works, which is all MR-06 needs | Trace the session store method on the raise path; one host fix | S |
| MR-11, MR-15 · **landed** | The run rail's synthetic timeline, and the credential card | Both landed in D1: the rail shows the turn's tool rows in order; the secret request renders as its own masked card answered through `submitSecret`. Sweep 2026-09-04 measured both live | S / M |

**Wave D1 landed 2026-09-03 (Opus workflow, host and dashboard in parallel, each adversarially
verified then reviewed and fixed; the full gate set re-run by the orchestrator).** The connector
plane now runs on its own stdio spine. CP-10: a submitted connector secret goes into a host-owned
`connector-env-secrets.json` (0600, written temp-file plus rename) and into that server's process
env at spawn, never into `connectors.json`, never into a per-agent store, never into a log; the
gateway gains `setConnectorSecret`, `deleteConnectorSecret` and `listConnectorSecretFields`
(names only); process-control env names are refused; the chat platforms (slack, github) win the
shared namespace so a channel token can never land in a connector process. CP-07: local
connectors get stable numeric ids derived from their name, persisted beside `connectors.json`, so
instructions, per-tool toggles and authenticate reach them for the first time. CP-08:
`listMcpServerTools` and `toggleMcpToolDisabled`; a disabled tool vanishes from routed tools and
from GetMcpTools. CP-03: `listInstalledMcpServers`, `listMcpPlugins`, `getMcpPlugin`. CP-05
short term: the catalog path answers empty instead of throwing at the model. CP-12: disconnect
requires the agent id. Dashboard: connector cards from the installed list with real per-tool
switches, a connectors editor on the relay route with `refreshMcp` after a write, a key form per
connector, the masked secret-request card answered through `submitSecret`, listener Connect
through a local token form and a labelled Cursor link, Disconnect with the agent id, and the run
rail shows the turn's tool rows (MR-11). The relay answers 503 when the box cannot be read instead
of an empty map, and the installed-server id is a number on the wire. New gate:
`scripts/verify-connector-plane.mjs`.

**Wave T landed 2026-09-04 (teach by demonstration; Opus workflow, host then dashboard, each
adversarially verified with fix rounds, two review lenses, a review fix; the full gate set re-run
by the orchestrator).** Learn was never a stub: it was real code behind a Statsig gate this box can
never bootstrap, and its stop-and-save needed a managed skill only Cursor's dashboard hands out.
Host: `SAND_TEACH` in the host settings file resolves the gate the way `SAND_BROWSER_USE` does,
read live on every start, and the `[sand][gates]` line names it as the source. The two real
managed skills from the August backup (`learn-from-demonstration`, `add-connector`) are baked
into the bundle as seeds; every managed-skills cache write is the union of seeds and fetched
(fetched wins on an id), and `ensureSeeds` repairs `cache.json` and `skills/<id>/SKILL.md` by
content at start (a hand-mangled row and a deleted file were both repaired live, measured by
mutation). The learning turn arrives whole: `WORKFLOW_INJECTED_BODY_LIMIT` is raised from the
shipped bundle's 8000 to 16000 (a knowing divergence, noted at the constant; the product truncates
its own 9985-character recipe), the teach queue scope is injected, and one `[sand][workflow]` line
per invocation records how much of the recipe the model was handed. Gate
`scripts/verify-teach.mjs`, 8 checks on the live box: refused with the gate off; recording on the
probe's own display with ffmpeg writing `demo.mp4`; discard leaves no session and no queue entry;
save writes `session.json` and one signed queue entry and dispatches the learning turn carrying the
whole recipe and the scope; the agent claimed the queue file within about two minutes on the box's
live model. Dashboard: the modal opens only when the host confirms a recording, the reason sits
beside the Learn button when it cannot (gate off, or the host's own message); the screen starts as a
cover so the dialog keeps the keyboard, and a click connects the live desktop; Discard and Finish
both call the host, are disabled while the call is in flight, and show a host error inside the
dialog; a status poll every five seconds closes the dialog when the box ends the recording on its
own and says that the cap is a save; the operator's note goes as an ordinary message once the
learning turn is already dispatched, and the copy says the recipe does not read it; the button is
"Learn this task"; the frame lays out its footer inside the dialog at three viewports. Gate
`scripts/verify-dashboard.mjs --teach`. Also landed in this pass: DISPLAY-4 (below), a sweep of
stale prompt-trace reports, sqlite3 in the box for the recipe's history step. Left open, own rows
below: TEACH-2, TEACH-3, DISPLAY-5.

**Closure sweep 2026-09-04 05:28 CDT (Opus workflow: one verifier per plane, one skeptic per plane
attacking every row called good, one completeness critic; 13 agents, read-mostly on the box,
this morning's 20-gate log as the evidence for the heavy gates).** 98 rows measured: 75 landed
rows hold on the box today; 4 open rows had been fixed along the way (MR-11, MR-15, GW-07,
TOOLS-11, corrected above); 18 stay open (each row's next action rewritten from the measurement);
1 landed row regressed (REPORTS-1: the report of an agent deleted while active survives; fix in
flight). The skeptics overturned five verifier calls, recorded on their rows: SUB-2 proved the
render and not the wire (SUB-2b), DISPLAY-1's loader still admits the key "undefined"
(DISPLAY-1b), GW-07 landed by a different fix than the row named, GW-04's residual was obsolete,
and one P2 evidence anchor was wrong. The critic found eleven things no row named; the two that
block the promise are the same shape Learn was: a Statsig gate this box can never bootstrap.
Twelve cheap fixes from the sweep landed the same morning (REPORTS-1, TOOLS-12, WORKFLOW-1,
SP-3, FLAGS-2, TOOLS-16, the Now island's invented copy that painted for a second before the
host answered, DISPLAY-1b, the toolset gate now selecting the wire line by conversation id and
asserting offered equals sent equals the toolset, two gate comments, and GW-16 with the real
takeover path). SUB-2b turned out to be a product defect, not a gate gap: the history flattener
dropped every rendered screenshot before the request left (2 in history, 0 on the wire); fixed
by emitting the image as an image part after its tool result, the way the transport's own path
does, and the browser gate now fails if a rendered image does not leave. The rest are rows below.

**Wave S landed 2026-09-04 06:25 CDT (Opus workflow: scout, implementer, verifier, one fix round,
verifier).** The install is in `deploy/r750/` (README with the operator checklist). Measured on
the R750: the box boots the pinned image digest with the fresh token and the placeholder
credential, the gateway answers `getHostStatus` two seconds after start, the relay injects the
bearer, the Machine Room renders over the tailnet in real Chrome, a probe agent is created and
deleted three times, install re-runs are idempotent, uninstall keeps the volumes and a reinstall
adopts them. Operator steps left, in the README: the DNS-01 resolver on Coolify's `letsencrypt`
(needs a Cloudflare token scoped to DNS edit), `enable-route.sh` for the domain, an off-tailnet
request to prove the allowlist, `ui/endpoints.json` with an API-key endpoint (no model until then),
the skills restore. Found on the way and filed: AUTH-1, VNC-1, SOCKET-1.

| Id | Finding (measured by the critic) | Next | Size |
|---|---|---|---|
| MEMORY-1 | Durable memory can never be written on this box: synthesis is pinned to the `sand_memory_dreaming` Statsig gate, which never bootstraps without a Cursor login, and no agent has ever had a memory here | Resolve it the way GW-07 was: a `SAND_MEMORY_DREAMING` host setting beside `SAND_TEACH`, the gates table naming it, then a gate that runs one synthesis and reads the memory back in the prompt report | M |
| REVIEW-1 | Auto review never enforces: settings say enabled, the runtime is in shadow mode (`SAND_AUTO_REVIEW_MODE` read from the process env only), and the classifier is a Cursor backend RPC | Make the mode a host setting readable on a running box; then a local classifier (the deterministic allowlist evaluator the plan already names) so a review can block an action here | M |
| AUTOMATION-1 | Locally scheduled routines fire through the manual path, so every scheduled run is recorded and prompted as "manual", and at least one fire left no run record | Give the local tick its own entry point beside the manual one, record the run with its trigger, and assert it in a gate | S |
| AUTOMATION-2 | Event-triggered routines can only be fed by Cursor's backend relay: no local event source, no listener connected, nothing proves the path | A local event source next to the schedule tick that turns an inbound listener message into a fire; gate it once a listener exists | M |
| TOOLS-15 | Five of the 35 offered tools reach the operator's own computer (ExternalShell, ExternalRead, AwaitExternalShell, CopyToBox, CopyFromBox) and this deployment registers no such computer | Decide per deployment; then either withhold the five when no local machine is registered (one guard in the toolset, like CLOUD-1) or register one | S |
| TOOLS-17 | Group rooms have no gate: the shared-room runner never appeared in 3,145 traced toolsets; the only proof is a hand-driven session from 2026-08-30 | A room arm in `verify-toolset`: a two-member room on probes, one message, the `isSharedRoomRunner` toolset line and both members' receipts | S |
| GW-16 · **landed** | The takeover path (request_box_help, pending handoff, the operator sees the box) was proven nowhere; the dashboard gate forced the visible state. Now the gate asks the probe to call request_box_help, waits for the host's pending handoff, asserts the button appears by itself, clicks it, and asserts the handoff clears | Drive the real path once in the gate: the host writes the pending handoff, the button appears by itself, the click clears it | S |
| SP-3 · **landed** | The untrusted-data fence is the product's only tool-result control and nothing proves it reaches the model | A `spotlight` marker in the section report and the toolset gate asserting it when the flag is on | S |
| TOOLS-16 · **landed** (both sentences dropped; the prompt is a module constant that cannot see the offered set, said at the site) | The system prompt tells the model to use GenerateImage, which is not on the wire | Condition or drop the sentence until TOOLS-05 lands | S |
| FLAGS-2 · **landed** (measured after: both false, bundled default, on this box) | Two gates that decide whether shipped features run (memory dreaming, auto review) are missing from the startup table | Add both rows with their source | S |
| TOOLS-14 · decided | SendFeedback is in the real product's 40 and absent here | Cursor product feedback; absent on purpose (§4 P2) | S |

| Id | Finding | Next | Size |
|---|---|---|---|
| CUSTODY-1 | The whole guarantee today is "the value is in exactly one 0600 file and the process env". The agent's shell runs as root in the same container, so `/proc/<pid>/environ` and that file are readable by the agent. This is the real custody fix and it is a box change | Run the agent shell as an unprivileged uid; keep connector processes and the sand-data root under another uid; extend `verify-connector-plane.mjs` (c) with a read of the connector's environ *as the agent shell* that must fail with EACCES | M, box image |
| DISPLAY-3 · **landed** | A page kept asking for a probe's desktop while a gate deleted it; the bring-up outlived the delete and wrote an assignment nobody would release, leaving X servers and tokens behind (found in the D1 pass: two tombstoned ids still held windows) | A window brought up for an agent that is now gone is released at once and the call fails honestly; every ensure and status call reconciles assignments against the agents that still exist and logs each release | S |
| DISPLAY-4 · **landed** | Measured by the Wave T fixer: after a probe was deleted its page kept polling `ensureForeverBox`; every poll brought a window up for nobody and the teardown that followed stopped `:7` under the live agent that had inherited it; the orphan seat's foreign token then made `start-window` refuse every new agent on the lowest free index until a container restart | Three fixes: a gone agent is refused before the box is touched; a window released while it was starting is torn down instead of orphaned; the box script adopts a seat the host did not issue (tears it down and rebuilds) instead of refusing it, since the host is the only allocator. Gate `scripts/verify-windows.mjs`. Residual: an X server can still outlive its agent with no assignment (`:8` after the 2026-09-04 gate pass); it wedges nothing now and is adopted by the next agent on that index, but costs memory until then (DISPLAY-6) | S |
| DISPLAY-5 | Agent `12863856` ("Grok", blank, created 2026-08-26) is hidden by the roster (`includeBlank: false`) but real on disk; it held window `:5` and cost an Xvfb at every boot. Released once by hand in the Wave T pass | Decide whether a hidden blank agent may hold a window; the cheap rule is to release at host start any window whose agent has no conversation | S |
| DISPLAY-6 | An orphan X server with a token and no assignment can survive a probe's deletion (seen on `:8` after the full gate pass). Harmless since the adopt rule, but it holds memory until an agent lands on that index | Host reconcile sweeps token-holding seats that hold no assignment, running `stop-window <n>` through the box shell the way the teach service runs its commands | S |
| SKILLS-1 · **decided** | Jason's eleven backup workflow skills are Titanium Computing operations (live vendor consoles, client mail), not product | Excluded from the release tree and never seeded; restore on his own deployment per `docs/OPERATOR-RUNBOOK.md` "Your own skills after you deploy" | S |
| DEPLOY-1 · **installed 2026-09-04, tailnet only** | Jason's own instance on the R750 (Ubuntu 24.04, docker 29, node 24, A40, 72 cores, 2 TB; Coolify present). Wave S: `deploy/r750/sync.sh` builds the bundle and the exec daemon from this tree, ships them, and runs an idempotent install under isolated names (containers titanbot-box and titanbot-relay, network titanbot, four volumes, a fresh gateway token per server, a placeholder inference credential, the window patch and sqlite3 applied). Live now at `http://100.110.83.82:7787` on the tailnet; `scripts/verify-deploy.mjs` 21/21 from this Mac; the R750 byte-identical before and after apart from the titanbot objects. Publishing on `tb.semfreak.dev` is `deploy/r750/enable-route.sh`, a separate operator step with a typed confirmation, because the first install attached the Traefik labels at install time and put a live router on the production proxy for a few minutes (undone, verified) | Wave S: an install script for a Linux docker host (box, patched bundle, relay, Machine Room behind auth on the tailnet), the recreate script generalised, a first-run checklist; then the skills restore | M |
| AUTH-1 | The relay (`ui/server.mjs`) has no authentication: reaching it equals holding the gateway token (create and delete agents, shell in the box, connector and secret writes). On this Mac that is loopback; on the R750 it is the tailnet; once published through Coolify it is every container on the coolify network as well | A login on the relay before any publish: an operator password or Tailscale identity headers, sessions, and the API behind it; a P0 for a general release, not only for the R750 | M |
| VNC-2 | The host hands the page a loopback VNC address (`http://127.0.0.1:6081/vnc.html?...token=N`), so on the R750 the Machine Room's desktop frame reaches for the viewer's own machine: Jason's browser hit his Mac's box and got "Failed to connect to downstream server" | The relay proxies the VNC websocket and page (`/vnc/...` to the box's 6081, `titanbot-box` on the server, loopback on the Mac) and the adapter rewrites a loopback vncUrl to the page's own origin when the page is not on loopback; then `verify-deploy.mjs` opens the desktop | S |
| VNC-1 | The operator page hardcodes `http://127.0.0.1:6080/vnc_lite.html`, so its embedded desktop is dead through any non-loopback URL (the Machine Room's desktop goes through the relay and works) | A relay route for the VNC path, or drop the operator page's embed | S |
| SOCKET-1 | The relay container mounts the docker socket read-write (it reaches box files and window surfaces through `docker exec`), which makes it root-equivalent on a host running production apps | Move the relay's docker needs behind gateway commands (`readBoxFile`, window surfaces) and drop the socket; until then the README says it plainly | M |
| TEACH-2 | The operator's note in the Learn dialog is not read by the recipe: it is sent as an ordinary message after the learning turn is already dispatched (the copy now says so) | Thread the note through `stopTeachRecording` into the learning dispatch so the recipe gets it as an input; host change | S |
| TEACH-3 | The recipe's outcome past the queue claim is unmeasured: the probe claimed the file within about two minutes, but ffprobe, the frame walk and the written skill happen after the gate's budget, on a probe the gate deletes | A long-running probe outside the 280 s budget, kept until the learned skill appears in `listWorkflows`; then the Skills panel proof | M |
| REPORTS-1 · **landed** (regression fixed 2026-09-04) | 91 `sand-system-prompt-<id>.json` trace reports for agents that no longer existed; the sweep found the unlink missed the delete-while-active branch, which every create-then-delete probe takes | Swept on the first write per host life and unlinked on both delete branches; regression test drives both | S |
| BOX-3 · **landed** | The recipe's URL step queries Chrome's History with `sqlite3`, which the image does not ship | Installed in the running box; `recreate-box.sh` installs it after the window patch | S |
| SECRET-KIND-1 | The secret request's `target.platform` is one namespace for chat credentials and connectors, resolved by a hardcoded platform list | Give the request a `target.kind` decided when it is built; route on it; delete the list | S |

**Wave C landed 2026-09-03 (two slices under the Fable workflow, each adversarially verified,
then reviewed and fixed, then every gate re-run by the orchestrator).** GW-03 acceptance status
after every send (composer reads `promptAcceptanceStatus`, "not accepted" carries the host's reason)
and the transcript loads by tail with paged scroll-back; GW-05 a Skills panel on all nine workflow
commands (list, enable, edit, delete, run, import text/URL, port); GW-10 a hand-back control while a
takeover is pending and an Updates panel on update/reset, with the host bundle update deliberately
left out; GW-08 channel state on listener cards; GW-01 name/description editing, avatar upload to
`/avatars/<id>`, notifications and hide toggles, Duplicate, the agent count against the cap; GW-09
inline images and bounded text previews through the attachment reads; GW-14 a Cmd-K palette on
`isGlobalSearchEnabled` / `searchAgents` / `searchMedia`; GW-11 the widget × reaches `dismissWidget`.
Left for later: `reactToMessage` and `getAgentThread` (GW-03 third item), per-tool connector switches
(blocked on CP-07), the secret card (Wave D1). The dashboard gate grew from 35 to about 70 checks and
now sweeps the skills it imports out of the shared library.

| Id | Finding | Next | Size |
|---|---|---|---|
| MOUNT-1 (P0, security) | The recreate script bind-mounts `~/.codex` and `~/.claude` **read-write** at `/root` in the box; the agent's shell runs as root there. Upstream's own connector asks for these mounts read-only. Nothing in the box uses them: Codex is adopted by the relay from the Mac, and the Claude/Gemini in-box route is not built. Found because `portAgentLocalSkills` discovered Jason's private global CLAUDE.md as a "skill" and six enabled copies accumulated in the shared library (cleaned) | Recreate the box from the updated `recreate-box.sh` (mounts removed 2026-09-03). Proof: `docker inspect` shows no `/root/.claude` or `/root/.codex` mount and the roster's skills list carries no "Claude memory" | operator, 30 s |
| BOX-2 | `updateForeverBox` / `resetForeverBox` are wired in the Updates panel but the loopback backend defines no `recreateInBox`, so both throw "This box backend does not support an in-box recreate" (rewrapped as "Couldn't reach the service that updates this computer") | Say so in the panel, or implement recreate for the docker box (it is `recreate-box.sh`) behind the gateway | S / M |
| WORKFLOW-1 · **landed** | `runAgentWorkflowNow` dropped the agent id for an unscheduled workflow, so the run landed on the active agent; measured: created B then A (active), ran on B, landed on B | Host fix in `workflow-commands.ts:259-285` | S |
| DISPLAY-1 · **landed; loader guard DISPLAY-1b landed** (owner ids validated as agent or subagent ids; `undefined` rejected, tested) | Deleted agents kept their shared-desktop window in `/home/box/.sand-window-assignments.json` (one entry sat under the key "undefined"); after enough probe agents a fresh one could not get a window and its browser child failed with "could not identify this agent's own display" | `deleteAgents` now calls the forever-box `releaseAgent`; `ensureForeverBox` refuses a call with no agent id; the assignments loader drops keys that are not agent ids; the live file was rewritten to the four live agents once | S |
| DISPLAY-2 · **landed** | Releasing a window removed its owner token and killed by port, but an X server holds no port, so the fork's Xvfb lived on as an orphan; the next agent assigned that display was refused because the start script read "no token" as "someone else's token" ("start-window failed") | `stop-window` also kills the X server and clears its lock and socket; `start-window` tears down an alive display with no owner and rebuilds it; both applied through `scripts/box-patches/apply-start-window-fix.sh`, which `recreate-box.sh` now re-runs, because the patch lives inside the container | S |
| PHANTOM-2 · **landed** | Eight phantom agents (seven "New Agent", one named after a replay prompt) appeared with real ids during the gate pass: the audit ledger and the evidence stamp append with `mkdir -p`, a write landing after `deleteAgent` recreated `agents/<id>/`, and the roster recovered the directory into an agent, naming it from whatever it found | Tombstones: `deleteSession` records the id in `agents/deleted-agents.json`; every reader skips a tombstoned id, the roster sweeps a resurrected directory on sight, `withAgentDb` refuses it. Also: both ledger writers refuse to recreate a deleted top-level agent's directory, the roster recovers a directory only when a profile says an agent lived there, `[sand][agents]` logs every mint and every createSession with its caller. The eight were deleted | S |
| CAPSULE-1 · **landed** | The desktop capsule had no width clamp, so an agent with a 65-character name pushed it under the shelf utilities and no click reached it (the dashboard gate's `#open-desktop` click timed out) | `max-width: 380px` and ellipsis on the label | S |
| AVATAR-1 | `listAgents` reports `avatarVersion` null right after `setAgentAvatarBytes` stored one; `getAgentAvatar` carries the version. The adapter works around it | Carry the version in the roster summary | S |

**Host wave E1 landed 2026-09-03 (done by hand in the main session during Anthropic's 529 outage,
gate-verified the same way).** GW-15 the unread raise path (the session store never had
`seedSessionActivityFromDbMtime`); AUDIT-1 `getAgentActionAudit{id,limit,before}` reads the
per-agent ledger newest-first, paged; SUB-2 browser screenshots reach the model as image parts
(`[sand][image]` line under the trace switch); TOOLS-13 an `mcpCustomInstructions` prompt marker
and `verify-toolset --mcp-instructions`; FLAGS-1 one `[sand][gates]` table line at host start with
value and source per gate; GC-1 stale-root GC reads the existing `SAND_STALE_ROOT_GC` helper and all
three maintenance switches read the host settings file; DEAD-1 the unreferenced projection file,
the caller-less `createTurnToolSession` and the duplicate spread are gone; CHURN-1 an unchanged
summary no longer emits `agent-upserted` (idle roster: 0 events in 30 s); BOX-1 the standalone box
reports window 0 and logs its limits once. New gate: `scripts/verify-gateway-reads.mjs`.
Model note from the pass: on qwen3.8-max the browser child navigated, snapshotted and finished,
but the parent never spoke again after its subagent reported (7 minutes); the same run on grok-4.6
answered "Example Domain" with the screenshot carried, as Codex did earlier. A revival-reply gap
worth a rubric row for the next model pass.

| Id | Finding | Fix | Size |
|---|---|---|---|
| CLOUD-1 · **landed** | CloudAgent declared no parameters and kept Cursor's argument order, so the executor dropped it from every request: 36 offered, 35 sent, for as long as the wire trace existed. It manages Cursor cloud agents this box cannot reach | Withheld unless `SAND_CLOUD_AGENTS=1` in the host settings file; the chief gate now asserts offered equals sent. The chief's wire count is 35 | S |

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

## 2. Thirty-five tools versus "a hundred and twenty", corrected against the primary source

**Correction 2026-09-03 19:30 CDT.** The first version of this section put the real product's
ceiling at "about 36" from this codebase's factory table. The research folder holds the primary
source: `~/grock bot research/01-grok-bot-teardown.md` §7.5, the live product's catalog printed by
its own agent on 2026-08-15, **40 functions verbatim**. The audit did not consult it. Here is the
reconciliation against what this box offers today.

**The 120-something is two things, neither a chief toolset.** `SAND_GATEWAY_COMMANDS` registers
123 operator commands (`gateway-protocol.ts:4-128`), which the model never sees. And the real
product's connector tools ride inside the two-function meta pair (GetMcpTools, CallMcpTool); the
teardown observed 22 MCP servers on the account, so the tools reachable *through* that pair ran to
a hundred or more. Both are real; neither is a function on the wire.

**Name by name, real product (40) against this box (35 offered, 35 sent since CLOUD-1; 36 offered before it):**

| Real product, 2026-08-15 | This box | Status |
|---|---|---|
| Task, TodoWrite, SendMessage, SendToAgent, ReactToMessage, CreateAgent, UpdateAgent, update_state | same | present |
| ExternalShell, ExternalRead, **AwaitExternalShell**, WebSearch, WebFetch | same, but the third had drifted to `ExternalAwaitShell` | renamed to match 2026-09-03 |
| Shell, Read, AwaitShell, CopyToBox, CopyFromBox, Screenshot, request_box_help | same | present |
| GetMcpTools, CallMcpTool | same, since Wave A | present |
| SearchPlugins, GetPlugin, InstallPlugin, AddMcpServer, UninstallMcpServer, UninstallPlugin, GetMcpServerStatus, SetMcpInstructions, RestartMcpServers, AuthenticateMcpServer | same | present (Cursor-backed verbs answer empty or error here, CP-05) |
| CheckSubagent, MessageSubagent, StopSubagent | same | present |
| CloudAgent | withheld unless `SAND_CLOUD_AGENTS=1` | Cursor-only; was silently dropped from the wire anyway (CLOUD-1) |
| **GenerateImage** | factory exists, no provider bound | **real gap**, TOOLS-05 (decision: only if an image model is wanted): the prompt told the model to use it (`system-prompt.ts:139-140`) while it is not offered, which TOOLS-16 removes; needs an image endpoint on the routed path (xAI or Alibaba both serve one) |
| **SendFeedback** | absent from the tree | Cursor product feedback; not worth a local stub. Filed as TOOLS-14 in §4 P2 |
| **RemoveMcpAccount, RenameMcpAccount** | withheld by `mcp_multi_account` | Cursor account plumbing; the real product had them on by 2026-08-15 (TOOLS-06) |

So the honest count: the real product offers 40 to its chief; this box offers 35 on the wire. Of
the five missing, one is a functional gap in a feature the prompt promises (GenerateImage), one is
a deliberate withhold of a tool that cannot work here (CloudAgent), and three are Cursor account
or product surfaces (SendFeedback, the two account verbs). The 15 `browser_*` tools and Computer
are not in the real chief catalog either: there, as here, they belong to the Task subtypes.

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
| CP-10 · **landed** | A submitted connector secret is stored where nothing reads it | Shipped design differs from the audit's suggestion: the value lives in a host-owned `connector-env-secrets.json` and the server's process env at spawn, never in `connectors.json` (`docs/CONNECTOR-PLUGIN-PLANE.md`). Residual: CUSTODY-1 | M |
| GW-13 · **landed** | Evidence verdicts exist, are measured, and no UI shows the receipts behind them | Disclosure behind the pill: `getAgentEvidence{id, attemptId}` → receipt count, tool names, attestation heads | S |
| GW-05 · **landed** | Nine working skills commands called by nothing; teach has no product it can produce | Skills panel mirroring Routines: list, enable, edit, delete, run, import text/URL. The library is box-wide (measured: a skill created on one agent appears in every agent's list), so the panel is a view of one shelf, not a per-agent set | M |
| GW-03 · **landed** (acceptance, tail, page; react/thread later) | Only the flat whole-transcript read is used; acceptance never checked | Poll `promptAcceptanceStatus` after every send; tail on refresh, page on scrollback; thread and react later | M |
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
| GC-1 · **landed** | Stale-root GC unreachable on a self-hosted box | Env override matching the other two; decide local defaults | S |
| GW-01 · **landed** | Agent identity write path unwired: no edit, avatar, notifications, hygiene | Agent-detail panel on `updateAgent`, `setAgentAvatarBytes`, notify setters, hidden/unread, duplicate | M |
| GW-06 · **landed** | Memory only on the operator page | Port the three call sites into the Machine Room agent-detail panel | S |
| GW-07 · **landed** (Wave T) | Teach recording throws at a default-off gate | Not by the fix named here: `SAND_TEACH` in the host settings file resolves the gate live and the refusal names it. The fork-window contradiction is settled by measurement: the host allocates a fork window on demand, so a fresh agent is recorded, not refused | M |
| GW-08 · **landed** (switches live since D1) | Six MCP reads unused; adapter's "no tool list" claim is false | Shipped path (D1): `listInstalledMcpServers` + `listMcpServerTools` + `toggleMcpToolDisabled` writing `mcpDisabledToolsByServerId`; `getAgentChannels` on the cards | M |
| GW-09 · **landed** | Attachments uploaded but never rendered | `readAttachmentImage` inline for screenshots, text/chunk previews; `searchMedia` behind Files | S |
| GW-10 · **landed** (see BOX-2) | No hand-back after a takeover; no update/reset panel | Hand-back control driven by `pendingHandoff`; Updates panel on `getHostStatus` + `updateForeverBox` + `resetForeverBox` | M |
| GW-11 · CP-09 · MR-15 · **landed** | The masked secret card is complete on the host and dead in every UI | Carry `entryId` through `cardOf`, masked input, `submitSecret{entryId,value,agentId}`; wire `dismissWidget` on × | M |
| GW-14 · **landed** | Global search index built and queried by nobody | Cmd-K palette on `isGlobalSearchEnabled`, `searchAgents`, `searchMedia` | M |
| CP-03 · **landed** | The one real connected connector is invisible in the UI | Three read commands wired to `mcp.management` (listInstalled, listPlugins, getPlugin); cards from listInstalled; listener rows in their own section | M |
| CP-04 · **landed** | Connect opens cursor.com for an account we do not own | Token form calling `connectChannel{id,platform,token}`; label the Cursor route honestly | S |
| CP-05 · **short term landed** (local catalog is D2) | Marketplace/install are Cursor RPCs on an expired stub; catalog throws. Sweep 2026-09-04: the catalog path in fact reaches Cursor's public marketplace unauthenticated (291 entries live), so what the cards offer to install is Cursor's list, and install still needs a local path | Short term: return `[]` on catalog failure. Real: local manifest index + install into the plugin cache, routed at the connectors.json writer. Gated on CP-14 | L |
| CP-06 | OAuth callback server was Electron-only | ~40 lines in the relay on 127.0.0.1:8787 → `completeMcpOAuth`. Only after CP-05 | M |
| CP-07 · **landed** | `local:<name>` ids fail the validator | Stable numeric ids per local server, persisted beside connectors.json: a persisted id always wins (localfiles keeps 1000000 from before the FNV-1a mint), new names get the hashed number | S |
| CP-08 · **landed** | Per-tool permissions have no read surface | `listMcpServerTools`, `toggleMcpToolDisabled` forwarding to the existing instructions-and-toggles methods; depends on CP-07 | M |
| CP-13 | Remote http/sse servers run through Cursor's backend | Extend local-connectors to `{url,type,headers}` and add an HTTP transport to the box exec daemon; the only route to Cursor-free remote connectors. Gated on CP-14 | L |
| MR-04 · **landed** | Connect on a non-adoptable provider card always fails behind a success toast | Suppress the button for Providers with a non-adoptable route; move the toast to the resolution path | S |
| MR-07 · **landed** | "Now" island can never show a running routine | Derive running from `lastRun.status` or the owner's `isRunning`; otherwise delete the branch | S |
| MR-08 · **landed** | Model row is box-wide, Role reads "not set" and cannot be set | Label "Endpoint (box-wide)"; Role editable through `updateAgent` | S |
| MR-09 · **landed** | Files tab labelled "Not wired yet" over a working view | One-line label change | S |
| MR-14 · **landed** | A recording in progress is never surfaced after reload | On boot, if `state.teaching.active`, open teach mode seeded with the host's `startedAt` | S |
| TOOLS-11 · **landed** | The 34-vs-120 reconciliation was undocumented, and its first version missed the primary source | Section 2, corrected against the teardown's 40-function catalog in 376e72c | S |
| BL-P1 · BL-W5 · BL-W7 | Backlog rows stale: P1 closed but written open; wave-5 item 11 fixed but open; §7 reads as standing policy | Closed in this commit, section 6 | S |

Refuted, kept for the record: **TOOLS-08** (the empty `toolsGenerator` at `turn-toolset.ts:1459` is
inside a config path Task never uses for dispatched subagents; the silent-empty fence at `:1421` is
by design), **BL-P1b** and **BL-P1c** (both fixes were committed in `09753d6` with the runaway
brake in `scripts/model-rubric.mjs:83-85`; the audit read a stale tree).

### P2 — decisions, hygiene, and confirmations (40)

Confirmed wired, no fix: MR-16..25 (roster, transcript with receipts and evidence pills, decision
cards, routines, settings, add agent/room, composer, live box, schedule, demo fallback), OP-01,
GW-04 (routines fully wired; run history is already on the wire in `getAgentAutomations` `runs[]`, so the residual noted here earlier is obsolete), CP-02 (local stdio connectors are
the spine), TOOLS-04, TOOLS-07, BL-P2.

Decisions (operator): **CP-14** closed, the substrate was decided 2026-08-18 (section 7, `docs/CONNECTOR-PLUGIN-PLANE.md`); **ENDPOINT-1 / BL-P3** closed on inspection 2026-09-03: the live container carries no `SAND_OPENAI_COMPATIBLE_*` env (the 2026-08-30 recreate dropped it), so the relay's switch already sticks; **MOUNT-1** (§0) is the recreate that remains; **TOOLS-12** keep multitask on and fix the comment;
**TOOLS-05** generate_image only if an image model is wanted; **TOOLS-14** SendFeedback is Cursor product feedback, absent here on purpose; **GW-02 / GW-12 / TOOLS-06 /
BACKEND-1 / CP-15** stay out of scope, said so here.

Hygiene (S each): MR-10 remove the Sheets tab (landed); MR-11 feed the outline's tool rows into the run
rail; MR-12 toast string (landed); MR-13 delete the unreachable builders (landed); DEAD-1, CHURN-1 / BL-P5, BOX-1, AUDIT-1, FLAGS-1 (all landed in E1); CP-11 connectors editor (landed in D1); CP-12 disconnect with the agent id (landed in D1); CHURN-1 / BL-P5 compare summaries before emitting `agent-upserted`; BOX-1 log
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

**Wave C — landed 2026-09-03 — the working commands get a surface (Machine Room).** GW-03 (acceptance + tail), GW-05
(Skills panel), GW-01 (agent detail edit), GW-09 (inline attachments), GW-10 (hand-back, Updates),
GW-14 (palette), GW-08 (tool switches). Two sessions; C1 = GW-03, GW-05, GW-10 hand-back; C2 = the
rest. Proof per command: the call appears in the adapter and a headless check exercises it against
the live box.

**Wave D — own the connector plane on OpenConnector (`docs/CONNECTOR-PLUGIN-PLANE.md`).** D1 landed 2026-09-03: CP-10, CP-07, CP-08,
CP-03, CP-11, CP-12, CP-04, CP-05 short-term, secret card (GW-11/CP-09/MR-15). D2:
OpenConnector as a stdio sidecar in the box, CP-13 local HTTP transport, CP-05 catalog through OpenConnector, CP-06 callback. Proof: a secret submitted from the
Machine Room lands in that server's env and the server restarts with it; the connected connector
shows on a card with its tool switches.

**Wave T — teach by demonstration works end to end.** Landed 2026-09-04: `SAND_TEACH`, seeded
managed skills with content repair, the recipe inlined whole with its queue scope, the honest
dialog with Discard, `verify-teach.mjs` and `verify-dashboard.mjs --teach`. Open: TEACH-2 (the
note into the dispatch), TEACH-3 (the learned skill measured on a long-running probe).

**Wave S — Jason's own instance on the R750 (DEPLOY-1, decided 2026-09-04).** An install
script for a Linux docker host (the box, the patched bundle, the relay and Machine Room as a
Coolify app on `tb.semfreak.dev`, DNS-only to the tailnet address, the certificate by DNS
challenge, an IP allowlist as the second lock), the recreate script generalised, a first-run
checklist; then the Titanium skills restored per the runbook (SKILLS-1). Proof: the page answers on
the tailnet and not from the internet; a teach recording and a routine run on the new box.

**Wave U — the promise on a box without Cursor (from the closure sweep).** MEMORY-1, REVIEW-1,
AUTOMATION-1, AUTOMATION-2, TOOLS-15 decision, TOOLS-17, GW-16, then TEACH-2 and TEACH-3. Proof
per row is in its table above; each gets a gate.

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
2. **MOUNT-1 (was ENDPOINT-1).** The env pin was already gone; what the recreate now fixes is the
   read-write mount of `~/.claude` and `~/.codex` into the box. Run `.cache/patched-host/recreate-box.sh`
   (mounts removed): 30 s of downtime. Recommendation: today.
3. **MODEL-1 timing.** Per-agent model is a design contract, not a wiring job. Recommendation: after
   Wave A, before Wave C2, because it is the token-bill lever.
