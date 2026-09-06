# Machine Room — operator runbook

Everything below was verified against the running box, not read off the source. Where something
is not real, this says so; that is the whole point of the document.

## Start it

```sh
pkill -f "node ui/server.mjs"
SAND_PROFILE_DIRS=/Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb-leaked/.cache/firstmate-profile/sand-data \
  nohup node ui/server.mjs > /tmp/ui-server.log 2>&1 &
open http://127.0.0.1:7777/machine-room/
```

The first two lines of `/tmp/ui-server.log` must read `gw ... (bearer)`. If they say `(no auth)`
the token was not found, every gateway call answers 401, and the page falls back to demo data
behind a red banner reading **DEMO DATA — the gateway is unreachable**. That banner is the single
thing to check before trusting anything on screen.

## What is real

| You do this | What actually happens |
| --- | --- |
| Type in the composer, press Enter | `sendPrompt`. The dots stay up until the worker really answers, or until a failure is reported. |
| Pick a worker or room | Its real transcript, routines, files and screen. |
| Workers / Rooms tabs | `listAgents`, split by `isGroup`. Re-read every 15s. |
| **＋ → Create agent / Create room** | `createAgent` / `createGroup`. The toast names the agent the host returned, or the error it refused with. |
| Room roster add / remove | `setGroupMembers`. Rolls back if the write is rejected. The last member cannot be removed. |
| **Routines → ＋ New routine** | `createAgentAutomation`. Seven trigger kinds — schedule, Slack, Git, Linear, Sentry, PagerDuty, Teams — and several at once become a group. The host validates and describes them back. |
| Routines → Test run | `runAgentAutomationNow`, then the card shows the host's own outcome and measured duration. |
| **Browser / Terminal** | That worker's own X display when it has a desktop session; otherwise the shared screen, and the caption says which. |
| **Learn this task** | ffmpeg records that worker's screen on the box, and the dialog opens only once the host reports the recording running. Finish recording queues the video and dispatches the learning turn; Discard and Escape both stop the recording on the box. Clicking outside the dialog does nothing, on purpose: the dialog is modal, so a mis-aimed click anywhere on the page used to land on it and throw a live demonstration away. The dialog opens with a cover where the screen goes and **no client behind it**, so the note, Escape and the buttons all get your keys. Clicking the cover connects the live screen, and from then on the keyboard is the box's, Escape included, so stop with the buttons; clicking anywhere else in the dialog disconnects it and takes the keys back. Needs `SAND_TEACH=1` in `sand-host-settings.json` and a desktop window for that agent. |
| **Marketplace → Plugins → Add** | Writes that plugin's connector entry into `connectors.json` and calls `refreshMcp`, then opens the plugin page; the key goes into that page's Accounts card, never into the entry. Providers and chat listeners are Settings sections now. The whole surface: [docs/MARKETPLACE.md](MARKETPLACE.md). |
| **Settings → Model** | Switches the whole box's inference endpoint. Takes effect on the next message. |
| **Settings → auto-review** | Writes a real policy the host enforces. |
| **Composer ＋** | Uploads on pick, sends with the message. 8MB cap, direct conversations only. |
| Notifications (♧) | The host's own unread counts and previews. |
| Approve / Deny on a card | `resolveAutoReviewApproval` / `resolveLocalToolPermission` / `respondToWidget`. |

## What is not real, and says so on screen

- **Files** lists what passed through the conversation. This host keeps **no per-worker
  directory** — everything a worker writes with Shell lands in one shared `/workspace`.
- **Sheets** is not wired. There is no host command behind it.
- **Per-agent models do not exist.** `updateAgent` takes only name, description and title, and
  there is no `agentDefaultModel`. One endpoint serves the whole box.
- **A saved teach recording leaves the box.** The recipe the host seeds extracts two frames and
  hands the video to a subagent, and both are read by the model this box talks to, which is a
  remote provider. Discard keeps the recording on the box and sends nothing.
- **The note you type is not part of the recipe.** `learn-from-demonstration` never mentions it,
  and the host dispatches the learning turn from inside `stopTeachRecording` before the page sends
  the note at all. It arrives as an ordinary message to the agent, possibly after the skill has
  already been written.
- **A recording that runs to the ten-minute cap is saved, not dropped.** The cap fires on the box
  and stops the recording with `save:true`. The dialog polls `getTeachRecordingStatus` and closes
  itself when that happens; a stop clicked afterwards reports that the box had already finished it
  rather than claiming a save or a discard of its own.

## Things that will look like bugs and are not

- **A worker's first Browser/Terminal takes about ten seconds.** The host is allocating it an X
  display. After that it is instant.
- **"not set" under Role** is honest — the host's per-agent `title` field is empty on this box.
- **Two workers show different screens.** Correct: the host assigns one display per agent
  (`/home/box/.sand-window-assignments.json`).
- **"...has no desktop session — showing the shared screen instead."** True and current. On this
  box image the fork displays start an X server but no window manager (`xfwm4` fails with "Xfconf
  could not be initialized"), so only `:1` has a usable desktop. The UI says so rather than
  showing you an empty grey rectangle. Fixing it is box-image work, written up in
  `docs/PLUMBING-AUDIT.md` §6f.
- **Asking a worker to use its browser does not work yet, and the reason is now known.** No turn
  on this host is given a computer tool — no `Screenshot`, no `Computer`, for the main agent or a
  subagent. So a worker asked to drive a desktop answers conversationally and reports back nothing.
  It is one missing argument in the toolset host, written up with the fix in
  `docs/PLUMBING-AUDIT.md` §6f. Two contributing causes underneath it are already fixed: the model
  could not receive a screenshot at all, and the fork displays had no desktop session.
- **A routine card saying "Dispatched · outcome not reported yet"** means exactly that. The
  outcome replaces it when the host records one.

## When something is wrong

- **An agent is quiet.** Its card says why: "Waiting on you" means a decision card is in the
  transcript. "The last turn failed" means the host raised an error tray, and the failure is
  written into the conversation.
- **The desktop pane shows the wrong app.** Browser and Terminal share that worker's screen;
  whichever was raised last is on top. Click the surface again.
- **Everything looks perfect and nothing responds.** Check the red demo banner first.

## Verify it yourself

```sh
PLAYWRIGHT_DIR=<node_modules with playwright> node scripts/verify-machine-room.mjs --all
SAND_PROFILE_DIRS=... node scripts/verify-local-turn.mjs --rounds 5
node scripts/verify-agent-identity.mjs
node --test tests/
```

`verify-agent-identity` is worth re-running after any model switch: on the frontier model both
agents name themselves correctly; on Nemotron they do not answer the question at all, which is
the "agents think they are Grok" report and is a model-quality problem, not a prompt bug.

## Your own instance on the R750

The install lives in `deploy/r750/` and its README is the checklist: `sync.sh` from this Mac builds
and ships everything and runs the install over ssh; `enable-route.sh` on the server publishes
`tb.semfreak.dev` through Coolify's proxy after the DNS-01 resolver exists; `disable-route.sh`
takes it down; `scripts/verify-deploy.mjs` proves the instance from here. Until `ui/endpoints.json`
exists on the server no agent can answer.

## The job bus, if the Chief of Staff is going to call this instance

The contract, top to bottom, is [docs/JOB-BUS.md](JOB-BUS.md). Three steps on your own instance:

1. **A token.** Either set `TITAN_JOB_TOKEN` on the `titanbot` Coolify resource, or open
   **Settings → Job bus** in the console and press **Generate**. The generated value is shown
   once, in a field you copy, and the console writes it to `job-bus.json` beside the relay's
   profile at mode 0600. The environment wins over the file, and when it is set the card says so
   and refuses to write one. With neither, every `/v1` request answers
   `503 {"error":"job bus not configured"}`.
2. **A worker.** Make sure an agent named **Scribe** exists, or set the mapping in the same card
   (it writes `SAND_JOB_BUS_WORKERS` in `sand-host-settings.json`). Give the box a GitHub
   credential as well, through **Settings → Connectors → GitHub** and the `gh` shell tool, or the
   worker will stop on `needs_human {reason: "github_auth"}` rather than pushing.
3. **Smoke it from the CoS box.** Health first, then one `health.ping` job, then read that job
   back:

```sh
export TITAN_JOB_BASE_URL=https://tb.semfreak.dev TITAN_JOB_TOKEN=…
curl -sS -H "Authorization: Bearer $TITAN_JOB_TOKEN" "$TITAN_JOB_BASE_URL/v1/health"
curl -sS -X POST "$TITAN_JOB_BASE_URL/v1/jobs" -H "Authorization: Bearer $TITAN_JOB_TOKEN" \
  -H "Idempotency-Key: health-1" -H "Content-Type: application/json" \
  -d '{"type":"health.ping","idempotency_key":"health-1","payload":{}}'
curl -sS -H "Authorization: Bearer $TITAN_JOB_TOKEN" "$TITAN_JOB_BASE_URL/v1/jobs/<id>"
```

Health is authenticated too, on purpose: this is a public host. The jobs table on the same
console card shows every job the bus has run, and it updates as the host reports transitions, so
the smoke above should appear on screen without a reload.

If the relay is only on the tailnet, an ACL letting the CoS box and you reach `tb:443` is enough;
the bearer still applies. Nothing else on the relay is reachable with that bearer, and CDP, noVNC
and the desktop stay on loopback (`scripts/verify-deploy.mjs` asserts the port bindings, and
`--job-token` makes it assert the bus's door as well).

## Your own skills after you deploy

The August 15 backup of the original install holds eleven global workflow skills written for
Titanium Computing (Operate Atera, Operate Huntress, Operate Coro, Operate SpearTip, Titanium
Backup agent jobs, SaaS Alerts OVA triage, GDAP audit and plan, Dark-web client notify, Ticket
customer ack, Technician guide standard, Titanium ops chain of command). They are operator data,
not product: four drive live vendor consoles and three send client mail, so they are not in this
tree and never seeded. After you stand up your own instance, restore them one of two ways:

- Copy each `workflows/<id>/SKILL.md` from the backup into the box at
  `/home/box/sand-data/workflows/<id>/SKILL.md` (the global workflow library; every agent sees it,
  and the Skills panel lists it with its switch).
- Or paste each file's text into the Skills panel's import, which calls `importAgentWorkflowText`.

Agents keep the ability to write skills themselves: the model's `update_state` tool with target
`workflow` is on the wire (it is how the learn-from-demonstration recipe saves what it learned),
and a saved skill shows in the Skills panel and runs by `@name` mention or from the panel.
