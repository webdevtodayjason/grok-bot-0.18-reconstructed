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
| **Teach this task** | ffmpeg records that worker's screen on the box. |
| **Plugins → Connect** | Opens the platform's own authorisation page. No credential passes through the browser. |
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
- **The agent does not watch your teach recording.** It is saved on the box, and the agent learns
  from the note you type plus the browsing it can see. Describe the task.

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
- **Asking a worker to use its browser does not work yet.** It dispatches a computerUse subagent,
  which finishes without driving anything, and the worker honestly tells you the pass returned
  nothing. Half the cause is fixed (the model could not receive a screenshot at all); the other
  half is the missing fork desktop above.
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
