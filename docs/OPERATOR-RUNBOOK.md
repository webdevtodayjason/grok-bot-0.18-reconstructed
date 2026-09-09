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
| **Ask a worker to read a web page** | It opens the page in the box's own Chrome, the same one the Browser tab shows and on the same profile, and tells you what the page says. It tries a plain web fetch first because that is faster. The browser is for a page that refused the fetch, one that needs your login, or one you need to see. If the page wants a sign-in it says so and waits: sign in yourself in the Browser tab and tell it to carry on. Long multi-step jobs still go to a desktop worker. Switch it off per box with `SAND_BROWSER_TOOLS=0` in `sand-host-settings.json`; it is on by default. The whole design: [docs/BROWSER.md](BROWSER.md). |
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
- **Asking a worker to read a web page works now.** It has its own browser tools, it opens the page
  in the box's Chrome on the same profile the Browser tab shows, and it tells you what the page
  says. See the table above and [docs/BROWSER.md](BROWSER.md). This bullet used to say the opposite,
  and that was true until BROWSER-1 landed.
- **A routine card saying "Dispatched · outcome not reported yet"** means exactly that. The
  outcome replaces it when the host records one.

## When something is wrong

- **An agent is quiet.** Its card says why: "Waiting on you" means a decision card is in the
  transcript. "The last turn failed" means the host raised an error tray, and the failure is
  written into the conversation.
- **The desktop pane shows the wrong app.** Browser and Terminal share that worker's screen;
  whichever was raised last is on top. Click the surface again.
- **Everything looks perfect and nothing responds.** Check the red demo banner first.
- **Every agent, on every customer, errors at once.** That is the proxy, and it is the one thing in
  this system that can do that: since the migration it is a single point of failure for everybody's
  inference. Check it in this order. (1) `docker ps | grep titanbot-proxy` — if it is not running,
  `docker start titanbot-proxy` and every box recovers on its next message, with no restart and no
  recreate. (2) `curl -s http://titanbot-proxy:4000/health/readiness` from inside the relay
  container — `{"status":"healthy","db":"connected"}` is the answer; anything mentioning the
  database means `titanbot-proxy-db` and not the proxy. (3) `deploy/r750/box-isolation.sh --verify`
  — a missing rule shows as boxes erroring while the proxy is healthy, and the timer reapplies
  within 60 s. (4) If it is genuinely broken and a customer cannot wait, `cp/cli.mjs proxy rollback
  <slug>` puts that one box back on its pre-migration credential; it takes effect on their next
  message. Full failure table: `docs/PROXY.md` §9.

## Verify it yourself

```sh
node scripts/verify-machine-room.mjs --all
SAND_PROFILE_DIRS=... node scripts/verify-local-turn.mjs --rounds 5
node scripts/verify-agent-identity.mjs
node scripts/verify-onboarding.mjs
node scripts/verify-admin.mjs
SAND_PROFILE_DIRS=... node scripts/verify-browser-tools.mjs
node --test tests/*.test.mjs
```

**The glob matters, and it used to be missing here.** `node --test tests/*.test.mjs` is what
`npm test` runs and it gives each suite its own process. `node --test tests/` loads
`tests/index.js` instead, a hand-written list of imports that had drifted: measured on this Mac
2026-09-07 it named 79 of the 101 suites, so the directory form ran 891 tests where the glob ran
1101. The 210 in the gap were not failing and not skipped, they simply were not run, and the
coverage read as green. The list is complete now and `tests/test-index-covers-the-suite.test.mjs`
fails the suite if it drifts again, but the glob is still the form to use: the directory form runs
every suite in one process, where a file that awaits at the top can lose the registration race.

`verify-agent-identity` is worth re-running after any model switch: on the frontier model both
agents name themselves correctly; on Nemotron they do not answer the question at all, which is
the "agents think they are Grok" report and is a model-quality problem, not a prompt bug.

`verify-admin` measures the super admin console at `api.titanium.bot/admin`: the flag, the door
against a normal customer's own valid session, the failed sign-in ledger and its keyed hash, the
attack rule, and all five panels rendered in headless Chrome from a fixture it carries. It starts its
own control plane on a free port with a throwaway data directory, a fake Coolify and a fake relay, so
it needs no box, no docker and no network, and it touches nothing on the R750. Pass `--no-browser` to
skip the page leg. The whole design, including which numbers on that console are **not measured** and
what would fix each one, is [docs/ADMIN.md](ADMIN.md), and so are the two commands that give Jason
his own account: `account add jason@... titanium` then `account promote jason@...`.

`verify-onboarding` measures the first run a new customer gets, and the ceiling of thirteen agents
per box. All three arms are live: measured on this Mac 2026-09-07 against `grok-bot-local-vm`,
**50 passed, 0 failed, 1 not measured** (the time-zone leg, skipped on purpose: the box arm answers
the name only, because writing a real zone on this Mac moves the scheduler). It moves
`SAND_MAX_AGENTS` and `SAND_TEST_HOOKS` in `sand-host-settings.json` while it runs and puts both
back, and its box arm points the box at a stub model on this Mac for one turn and repins the
endpoint it found. Run it on its own, not alongside another gate. The whole design is
[docs/ONBOARDING.md](ONBOARDING.md).

`verify-browser-tools` measures the browser a worker now drives itself: that the four tools reach
the main agent and leave for the provider, that a real page comes back as words and one picture,
that a login-walled page says so in plain words, that typing and clicking change a page the gate
serves itself, that the audit ledger gained a row per page, and that the Browser tab still shows
the same Chrome rather than a second one nobody can see. It repins the box's model endpoint for the
length of the run and points it at a stub on this Mac, so **run it on its own**, not alongside
another gate; it puts the pin, `SAND_TOOL_TRACE` and `SAND_BROWSER_TOOLS` back whatever happened.
Pass `--offline` to skip the two public pages. `--dry-run` needs no box at all and proves the gate
itself works before you spend seven minutes on one. The whole design is
[docs/BROWSER.md](BROWSER.md). **Not yet run against a box.** The row in
[docs/GAP-ANALYSIS.md](GAP-ANALYSIS.md) says so and carries the next action.

An existing box never enters the first run. The migration rule marks any box done at the first read
if it holds more than one agent or any conversation with a person's message in it, so no agent on a
working instance is renamed and no modal opens on one. This Mac read `done:true` with
`doneReason:"existing-box"` on 9 agents, and Jason's instance is the same shape.

## Your own instance on the R750

The install lives in `deploy/r750/` and its README is the checklist: `sync.sh` from this Mac builds
and ships everything and runs the install over ssh; `enable-route.sh` on the server publishes
`tb.semfreak.dev` through Coolify's proxy after the DNS-01 resolver exists; `disable-route.sh`
takes it down; `scripts/verify-deploy.mjs` proves the instance from here. Until `ui/endpoints.json`
exists on the server no agent can answer.

**A customer is one extra container and nothing else**, and `docs/TENANCY.md` is the whole of it.
There is one relay, one console and one login page at `console.titanium.bot`, for everybody. Adding
a customer adds one box container and one directory under `/data/titanbot/<slug>/`; it does not add
a console, a hostname, a certificate or a password anyone has to be handed. Which customer a request
belongs to is decided by the session cookie, and the relay looks that up in a registry it reads from
the control plane every sixty seconds.

    node cp/cli.mjs signup add owner@theircompany.com "Their Company"

That one line makes the account, works the workspace name out of the company name, and builds the
box. Measured on the R750 on 2026-09-07: **16 seconds**, end to end.

Taking one away is two commands, and they are separate on purpose:

    node cp/cli.mjs tenant list                     # find the slug
    # stop it, then delete it: the container goes, /data/titanbot/<slug>/ stays
    node cp/cli.mjs account remove owner@theircompany.com

Deleting a workspace does **not** delete the sign-ins that point at it, and the delete answer names
them. That is deliberate: building the workspace again under the same name gives those people their
access back exactly as it was, which is how the demo workspace was moved onto this shape. Until you
build it again or remove the accounts, those people are told the workspace is not available. And
nothing ever deletes `/data/titanbot/<slug>/`; that is yours to remove when you are sure.

`deploy/r750/control-plane-install.sh` on the server makes `/data/titanbot`, builds `titanbot-cp:local`
and generates the secrets into `/home/sem/titanbot/cp.env`, then
`node deploy/r750/control-plane-coolify.mjs` from this Mac makes the Coolify service, sets its
environment, gives it `https://api.titanium.bot:7790` and starts it. Both are idempotent and both
take `--dry-run` or `TITANBOT_DRY_RUN=1`, so read the plan before you run either.

All of that is live as of 2026-09-07. The server runs five containers: your relay (the one console),
your box, the control plane, demo's box and richard-avery's box. The demo account is
`demo@titanium.bot` with its password in `cp.env` as `DEMO_PASSWORD`, and it signs in at
`console.titanium.bot` like any customer.
`verify-deploy` passes 59 legs with none failing there and two inconclusive, `scripts/verify-one-console.mjs` proves two customers get two
rosters, and `scripts/verify-one-console-browser.mjs` proves it in a real browser in two contexts.

Shipping a change that touches both halves is two deploys, and they are not interchangeable. The
console is `bash deploy/r750/sync.sh` from a clean checkout, then `docker restart` of the relay
container by name. The control plane is `bash /home/sem/titanbot/deploy/control-plane-install.sh` on
the server, which rebuilds `titanbot-cp:local` from whatever the sync just shipped and leaves
`cp.env` exactly as it found it, then a Coolify **restart** of the titanbot-cp service. Restart, not
recreate: a recreate of a service that holds a box corrupts the agent stores (BOX-6), and while the
control plane holds no agents, keeping one verb for both halves is what stops the wrong one being
used on the wrong service. The super admin console shipped this way on 2026-09-07, and afterwards
`GET /admin` answered 200 and `/v1/admin/system` reported the R750's own load, memory and disk.

Three things to remember when you change something on a Coolify service. **An environment value the
compose file does not name never reaches the container**, so push the current compose as well as
setting the value, then restart. **A variable inside a `labels:` block never resolves at all** —
Coolify escapes the dollar, and the label arrives as the variable's own name in plain text, which is
how `console.titanium.bot` would go back to answering 502 at random; the Traefik pin is a literal for
that reason and `verify-deploy` reads it back off the running container after every restart. And
**never pick a container by its role label alone** on this machine: every customer's box carries
`com.titanbot.role=box` and every relay carries `com.titanbot.role=relay`, so "the first one" is an
arbitrary customer's container. Match the Coolify service uuid at the end of the name. Give a box
ninety seconds after a recreate before you believe a gate run against it.

## Updating without restarting anyone (SHIP-2)

A ship used to recreate both containers, which cut every turn in flight and wiped whatever the
agents had installed inside the container. It does not have to: the host can be swapped on its own,
in place, and the container never restarts.

The pieces, once `sync.sh` has run:

- `sync.sh` writes two files into `/home/sem/titanbot/runtime`: `host-main.cjs` and
  `sand-host-bundle-latest.version`. The version is the tree's short git sha (a dirty tree gets the
  bundle's own sha256 prefix instead, and the run says so).
- The relay serves them back to the box at `/runtime/<gateway token>/…`. That route is mounted
  read-only from the same directory and is answered before the console's login, because the caller
  is the box's own `fetch` and can carry neither a cookie nor a header; the token is the path
  segment. A wrong one gets `404`.
- The box asks for the tarball, and the relay composes it inside the box from the box's own
  `/home/box/sand-host`, replacing `host-main.cjs` and the version marker. That detour is not
  optional: the in-box supervisor deletes every entry of that directory the archive did not carry,
  and most of that directory comes from the box image rather than from this repo.

To ship the host and nothing else:

```sh
bash deploy/r750/sync.sh --no-install                      # build, stage, copy
curl -sS -X POST -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{}' \
     https://tb.semfreak.dev/api/updateHostNow             # fetch, stage, swap
```

`updateHostNow` answers `{"started":true,"version":"<sha>"}`. Thirty seconds later
`getHostStatus` reports the new `hostVersion`, the host process has a new pid, and
`docker inspect` shows the same container with the same `StartedAt`. Desktops stay up, shell
secrets stay set, and turns in flight are resumed rather than cut.

`{"started":false,"reason":"already-latest"}` naming a version that is NOT the one you just staged
means the box is running a bundle from before 2026-09-06: those cache the version lookup for ten
minutes. Wait it out once; the bundle you are installing fixes it.

The host also watches for a new bundle on its own, once a day with a random offset
(`SAND_BOX_AUTO_UPDATE=1`). That same flag is what stops the OTHER updater — the one that recreates
the container for a new box image — from ever running.

To verify the whole path on the dev box:

```sh
SAND_PROFILE_DIRS=... node scripts/verify-host-upgrade.mjs
```

It takes `/tmp/titanbot-box.lock` itself and swaps the host, so run it directly, never through
`scripts/on-box.sh`. On this Mac the relay it talks to is the one the gate starts on
`127.0.0.1:7787` for the length of the run, which is what the box's
`SAND_HOST_BUNDLE_S3_BASE_URL` points at; between runs the daily watch simply finds nothing there.

## Surviving a recreate (PERSIST-1)

The four volumes survive a recreate by construction. The container's own filesystem does not, and
that is where `/home/box/cli-config` lives: the agents' CLI logins, `~/.ssh`, `~/.aws`, git identity,
and every `~/.config/<tool>` the image's `persist-cli-auth` mirrors there every 30 s. The box store
has been copying all of it out on every sync cycle for as long as this deployment has existed;
nothing ever copied it back, because the restore only runs when `SAND_BOX_STORE_COPY_IN` is set and
no deploy path set it.

It is set now, in `deploy/coolify/docker-compose.yml`, `deploy/r750/install.sh` and the dev box's
recreate script. **The R750 owes one recreate for it to take effect** — the variable is read at
container start. Afterwards `/tmp/sand-copy-in-status.json` inside the box records what was
restored, e.g. `{"phase":"done","restored":1386,"total":1386,"bytes":251298815,"outcome":"hydrated"}`.

To verify on the dev box (**this recreates the box**, takes the lock itself, run it directly):

```sh
SAND_PROFILE_DIRS=... node scripts/verify-persistence.mjs
```

What it does NOT cover: `~/.local`, `~/.cache` and the pip user site are in no store category, so a
`pip install --user` still does not survive a recreate. `persist-cli-auth` sweeps `~/.config/*` and
its own credential list, and nothing else.

### What a recreate no longer does to an agent's store (BOX-6)

Until 2026-09-08 the copy-in restored `store.db` and `conversation-blobs.db` over the live files on
the persistent mount, first and alone, because they were named CRITICAL. The store's copy of a busy
SQLite file is stale by construction, so what came back were pages that no longer matched the live
WAL, and every turn after that failed with `database disk image is malformed`. It happened twice on
the R750 and it is what the old advice "no Coolify recreate of a running instance" was protecting
against.

An agent database that already exists on the mount is no longer a copy-in candidate at all. A box
with no sand-data yet still hydrates from the store; a box that has one keeps what it wrote. You can
see it in the box's own log at start:

```
[box-copy-in] copy-in left 20 live agent database(s) as they are: home/box/sand-data/agents/…/store.db, …
[box-copy-in] result outcome=hydrated store_entries=1668 files=1648 …
```

`files` being lower than `store_entries` by exactly the number left alone is correct and is not a
partial hydrate.

**The advice is still to ship with `updateHostNow` and relay restarts rather than a recreate,** for
the reasons in SHIP-2 above. What changed is that a recreate is no longer the thing that eats an
agent's history.

If a store is already damaged, the host now tries `REINDEX` before it quarantines anything, and
`sqlite3 .recover` before falling back to copying salvageable rows one at a time. The row-by-row
salvage stops at the first page it cannot read, which is how a 2,940-row file once came back with 5.

### Repairing a store by hand, without a recreate

**The console does this now (BOX-6b).** Open the agent, open Agent details, press **Repair** on the
Conversation store card; or `POST /api/repairAgentTranscript {"id":"<agent id>"}` at the box
gateway. **It does not rebuild the conversation itself:** it turns the stuck state off, sets aside
a write-ahead copy that cannot be read (renamed, never deleted, and one that still reads is left
alone because it is holding a turn) and reindexes a database that will not open — the message you
send afterwards is what runs the host's own recovery and rebuilds. It answers
`{before, after, quarantined, outcome}`; an empty `quarantined` is a normal answer, `cleared` means
the state is off and nothing else happened yet, and a second press on a state already cleared once
is refused on purpose. Back the agent's directory up with `cp -a` inside the box first.
**docs/BOX-STORE.md** has the whole thing, including how to tell the two damage shapes apart
read-only and why removing a `.journal-mode` marker is not the fix.

What follows is for the case where the console and the gateway are both out of reach.

```sh
# read-only first, and name the agent before touching anything
docker exec <box> sqlite3 "file:/home/box/sand-data/agents/<id>/conversation-blobs.db?mode=ro" \
  "PRAGMA integrity_check; select count(*) from blobs;"
# rebuild beside it
docker exec <box> sh -c 'sqlite3 /home/box/sand-data/agents/<id>/conversation-blobs.db .recover \
  | sqlite3 /home/box/sand-data/agents/<id>/conversation-blobs.db.recovered'
# count the rebuilt file, then swap it in during the host's SIGTERM window of an updateHostNow swap
```

Swap during the swap window, never under a running host, and never by recreating the container.

## Keeping a customer's box off the host (TENANT-3)

`deploy/r750/box-isolation.sh` does two things. Box to box has been live since 2026-09-07. Box to
**host** is new on 2026-09-08, and it starts in shadow rather than dropping anything.

What was open, measured from inside the demo tenant's box: **22, 47291, 8000, 80, 443, 2049, 445,
11434 and 5000**, on each of four host addresses. That is both sshd ports, Coolify, the machine's NFS
and Samba exports and its local model server, reachable from any tenant's agent shell.

```sh
sudo bash /home/sem/titanbot/deploy/box-isolation.sh            # apply (shadow by default)
sudo bash /home/sem/titanbot/deploy/box-isolation.sh --counters  # what has hit each port
sudo bash /home/sem/titanbot/deploy/box-isolation.sh --verify    # probe box to box AND box to host
```

**Shadow first, and read the counters before you drop anything.** In `shadow` the same rules are
installed with counters and no verdict, so nothing is taken away and you can see what a real day
looks like. The rules also log in shadow, rate limited, so `journalctl -k | grep titanbot-host-guard`
names the source address of anything that hits them — a number tells you a port was used, and what
you need to know is which container will break.

The counters accumulate: a re-apply that would change nothing leaves them running, and only a real
change to the policy resets them. Leave it for at least half an hour with the boxes doing their
normal work, then:

```sh
sudo bash /home/sem/titanbot/deploy/box-isolation.sh --counters
```

The line you are looking for first is the exempt one. Coolify drives this host over SSH from inside
its own container, so its traffic must be counted on the `accept` rule and not on the 22 rule. If it
is on the 22 rule, the exemption did not resolve and turning on drop would take the hosting panel's
hands off the machine, every sixty seconds, until you turned it back.

**Coolify is more than one container, and the shadow pass is how we learned it.** Measured
2026-09-08: port 8000 counted one packet a minute from something that was neither `coolify` nor the
control plane, and the log named it — `coolify-sentinel` at `10.0.0.3`, polling the host's own API
from the default bridge. Every container whose name begins with `coolify` is exempt now, which on
that host is 23 addresses across six containers. If you add a Coolify component, it is exempt by
name on the next tick; if you add something of your own that needs the host, it is not, and the
shadow counters are where you will see it.

**What that host read after the exemptions were right**, over an accumulating window with all three
tenant boxes running: `22` **0**, `47291` **0**, `8000` **0**, and every watch-only port — 2049,
445, 11434, 5000, 80, 443 — **0**, while the exempt rule counted Coolify's own traffic steadily.
Nothing that is not exempt touches a guarded port on this host today.

To turn on the drop:

```sh
sudo mkdir -p /etc/titanbot
echo drop | sudo tee /etc/titanbot/host-guard.mode
sudo bash /home/sem/titanbot/deploy/box-isolation.sh
```

`mkdir -p` because `/etc/titanbot` does not exist on a host that has never been told a mode, and
`tee` into a missing directory fails while `box-isolation.sh` carries on in shadow — which reads as
"the drop did not work" and is really "the mode was never written". Check the line it prints: it
says which mode it applied.

The mode file is what the 60-second timer reads, so this survives the next tick. The way back is one
word and the same command:

```sh
echo shadow | sudo tee /etc/titanbot/host-guard.mode
sudo bash /home/sem/titanbot/deploy/box-isolation.sh
```

Or, if you cannot wait for the tick and want it gone this second:
`sudo nft delete table inet titanbot_host`. The timer puts it back in whatever the mode file says
within sixty seconds, so change the file first.

`2049`, `445`, `11434`, `5000`, `80` and `443` are counted and never dropped until you add them to
`TITANBOT_HOST_GUARD_DROP_PORTS`, and the rule for that is their counter reading zero over a real
window, not a guess about who uses them.

### Read the counters before you believe them (2026-09-09)

Until 2026-09-09 the counters on this host were worth nothing, and nothing said so. The fingerprint
that lets a tick keep the table it already installed was written to `/run/titanbot`, which is
root-owned; this runs as a `systemd --user` unit as you, asking for root only for `nft`, so both the
`mkdir` and the write failed and were swallowed. The table was rebuilt every 60 seconds and every
counter only ever showed the last minute. Measured: the fingerprint file did not exist, and the
accept rule's handle walked 2086 to 2088 to 2090 across 90 seconds. The boundary held the whole
time; only the instrument was dead.

It is fixed, and this is how you check it is still working before you trust a window:

```sh
sudo nft -a list table inet titanbot_host | grep 'the hosting panel'   # note the handle
sleep 130                                                             # two timer ticks
sudo nft -a list table inet titanbot_host | grep 'the hosting panel'   # same handle = accumulating
journalctl --user -u titanbot-isolation.service -n 20 | grep 'counters were left running'
```

A handle that changes, or a `WARNING cannot write` line from the service, means you are reading the
last minute and not a window. `2049`, `445` and `11434` were moved back to watch-only on 2026-09-09
for exactly this reason: the window quoted for them could not have existed.

### The exemptions are per address family, and that matters here

The drop lines match on `iifname`, which has no address family, so they cover IPv4 and IPv6 alike.
An exemption has to be written per family or it only covers v4. On this host that is not academic:
Coolify's own bridge carries a global IPv6 prefix, five Coolify containers hold addresses on it, and
sshd listens on `[::]:22`. Before 2026-09-09 the exemption was v4 only, so Coolify was exempt over
v4 and dropped over v6 — measured from inside its container, `10.0.0.1:22` gave the SSH banner and
`[fdb8:a9ef:e4a4::1]:22` gave nothing. Nothing had broken only because Coolify addresses this host
by its v4 address today.

If you ever have to check this in a hurry, from the host:

```sh
docker exec coolify sh -c 'curl -s --max-time 6 telnet://10.0.0.1:22 | head -c 40'
docker exec coolify sh -c 'curl -s --max-time 6 "telnet://[fdb8:a9ef:e4a4::1]:22" | head -c 40'
```

Both must print an `SSH-2.0-` banner. One banner and one silence is the boundary eating the panel
you administer this machine from, and the way back in would be that same panel.

If the exemption cannot be resolved the script installs **nothing** and exits non-zero, on purpose. A
half-installed drop set is worse than none.

### An exemption is bound to the bridge its address lives on (2026-09-09)

Until this date the exemptions accepted on source address alone with no input interface, and
`coolify-proxy` holds an address on the same bridge as a customer's box (192.168.32.3 where the demo
box is .2). Docker grants NET_RAW by default and these boxes drop no capabilities, so a tenant with
root inside its own box could have claimed an exempt source on a segment it already shares. Each
exemption is now emitted as `iifname "<bridge>" ip saddr <addr> accept`, one line per bridge, and a
bridge name that is not an interface on this host trips the fail-closed latch. The control plane is
unaffected: its default route is 192.168.16.1, not titanbot-net.

### NFS and SMB are dropped for boxes only (2026-09-09)

Measured from inside the demo box on the R750: the host answered a customer's sandbox on **2049
(NFS) and 445 (SMB) on all seven of its addresses**, including the tailnet address. Those two cannot
go into the blanket drop set — about sixty containers on this host belong to other products and
their counters are not zero — so they are dropped for the **box addresses only**, in the same
`guarded` chain:

```sh
TITANBOT_HOST_GUARD_BOX_DROP_PORTS=2049,445     # the default
```

11434 (this machine's own model server) and 5000 (an unidentified python service) stay watch-only
until 5000 is identified. **After the change, same probe, same box:** 2049 and 445 refused on all
seven host addresses; 80, 443, 11434 and 5000 still answer, which is what watch-only means; 22,
47291 and 8000 still refused; the 1.1.1.1:443 sanity leg still open; a new connection from inside
the coolify container to `10.0.0.1:22` still opens; console.titanium.bot 401, api.titanium.bot 404,
titanium.bot 200, unchanged either side; all three boxes' `StartedAt` unchanged.

### --verify knocks on every door, not only the bridge gateways (2026-09-09)

The box-to-host leg used to probe only what a box can work out from inside itself — its default
gateway and each attached subnet's `.1` — so every address it named was a bridge gateway and the
tailnet and LAN doors were never touched. It now also discovers the host's own addresses on the host
side (`ip -o -4 addr show`, minus bridge, veth, docker0 and lo) and probes them in the same loop.
On the R750 that took the leg from 6 probes to **18** across three boxes.

## A box started before the entrypoint that repairs its windows (TENANT-4)

`/usr/local/bin/start-window` in the box image treats a live X server as a live desktop, so a forked
agent on an unrepaired box gets a black screen and nothing ever fixes it. The repair is applied by
the box's own entrypoint on every start, from `/opt/titanbot-runtime/apply-start-window-fix.sh`,
which every box mounts read-only. A box that was **started before that entrypoint existed** does not
have it, and a container recreate is what picks up the new command.

Until you redeploy, put it in effect without one. The script runs inside the box and uses no docker
socket — the boxes have no docker CLI at all, which is what makes it socket-free rather than merely
socket-less:

```sh
for B in $(docker ps --filter label=com.titanbot.role=box --format '{{.Names}}'); do
  docker exec -e TITANBOT_IN_BOX=1 "$B" sh /opt/titanbot-runtime/apply-start-window-fix.sh
  docker exec "$B" sh -c 'md5sum /usr/local/bin/start-window; grep -c session_alive /usr/local/bin/start-window'
done
```

It is idempotent (a second run says `already patched` for every step), it keeps the original beside
it as `start-window.orig`, and it syntax-checks what it wrote. A repaired file reads
`99a90e45a5b5c18ec18da4c5c61a08e4` with 3 hits; the stock one reads `d69219afc86a297d16bee3d97b120095`
with 0. The edit is a filesystem change in the container, so a recreate throws it away — which is why
the entrypoint reapplies it on every start.

`scripts/verify-deploy.mjs` reports this per box by name, so the gate says which boxes carry it
rather than assuming the fleet does. **Measured on the R750 2026-09-09:** all three boxes were stock
before, all three read `99a90e45` with 3 hits after, and the gate went from
`3 of 3 box(es) run the stock start-window` to naming all three repaired.

## Backups (BACKUP-1)

`deploy/backup/snapshot.sh` copies all six places an instance lives — the four volumes, the relay
side, and the tenant root at `/data/titanbot` — into `<dest>/<instance>/<YYYY-MM-DD-HHMM>/` with a
manifest, and keeps the last 14.
`install.sh` installs it as a systemd **user** timer at 04:10 (the whole install runs as `sem` with
no sudo), so after the next install:

```sh
systemctl --user list-timers titanbot-backup.timer
loginctl enable-linger sem            # or the timer only fires while sem has a session
```

Two refusals to know about. It will not run when the destination is not a mount point — an
unmounted `/mnt/rosa-storage` is an ordinary directory, and filling it would put the only copy of
the data on the disk the copy exists to survive. And it will not run without room for twice the last
snapshot. `TITANBOT_BACKUP_REQUIRE_MOUNT=0` is the deliberate override, and it is how the dev box
runs it.

The box is paused for about a second, not for the length of the copy: everything is copied live,
then `sand-data` and `workspace` — the volumes holding the agents' sqlite stores — are retaken with
the box frozen. Each source in the manifest says which it was (`capturedWhile`), and the snapshot as
a whole is `"mode": "consistent"` only when that second pass ran.

The tenant root is the control plane's own sqlite store — every account, every tenant, the
provisioning ledger — plus one directory per customer. It was in no snapshot at all until
2026-09-07: the newest one on the array held `manifest.json`, `relay/` and `volumes/` and nothing
else, so losing that disk meant losing every customer with no way to say who they had been. It is
copied live, and the control plane's own directory is then retaken with its container paused, the
same way and for the same reason as the agents' stores. A customer's own data is a live copy and
the manifest says so per tenant. `"controlPlane"` in the manifest is `paused`, `live` or `absent`,
and a `live` one downgrades the whole run, because that store is the one thing nothing else can
rebuild.

Two things that follow from it. A snapshot is now the size of every customer's data as well as
Jason's, fourteen times over at the default retention, so watch the array and lower
`TITANBOT_BACKUP_KEEP` before the free-space guard starts refusing runs. And a host with no control
plane — a plain single instance — reports `absent` and is a complete snapshot, not a degraded one.

Restore drills are the point of having it:

```sh
bash deploy/backup/restore-drill.sh          # newest snapshot
bash deploy/backup/restore-drill.sh <dir>    # a specific one
```

It restores into a throwaway directory, never touching the live instance, opens every
`agents/<id>/store.db` and prints a table of size, hash and `PRAGMA integrity_check`. A store that
does not open, or whose hash has drifted from the manifest, fails the run. It then opens the control
plane's own store the same way and counts the tenant directories: a snapshot whose manifest says the
account store was captured and does not carry one, or carries one that will not open, is refused as
a restore point, because it could not bring the customers back.

On the dev box there is no array and no `mountpoint(1)`, so a run there looks like:

```sh
TITANBOT_BACKUP_DEST=/tmp/backups TITANBOT_INSTANCE=grok-bot-local-vm \
TITANBOT_BOX=grok-bot-local-vm TITANBOT_VOLUME_PREFIX=grok-bot-local-vm \
TITANBOT_ROOT=/tmp/relay-root TITANBOT_BACKUP_REQUIRE_MOUNT=0 \
  bash scripts/on-box.sh bash deploy/backup/snapshot.sh
```

There is no launchd job for it and there should not be: the Mac is a dev box, its volumes are
scratch, and a nightly pause of the box everybody is testing against would be a nuisance. Run it by
hand when you want a restore point before something risky. On the Mac the volume directories are
inside Docker Desktop's VM and cannot be reached from the host at all, so the script streams each
volume out through the daemon instead of rsyncing it; the manifest records which method it used.

## The job bus, if the Chief of Staff is going to call this instance

The contract, top to bottom, is [docs/JOB-BUS.md](JOB-BUS.md). Section 10 is the binding one
wherever it and the sections above it disagree. Four steps on your own instance:

1. **A token.** Either set `TITAN_JOB_TOKEN` on the `titanbot` Coolify resource, or open
   **Settings → Job bus** in the console and press **Generate**. The generated value is shown
   once, in a field you copy, and the console writes it to `job-bus.json` beside the relay's
   profile at mode 0600. The environment wins over the file, and when it is set the card says so
   and refuses to write one. With neither, every `/v1` request answers `401`, the same answer a
   wrong bearer gets, on purpose, so nobody can probe the host to find out whether you have set
   one yet (§10.6).
2. **Turn it on.** A token is not an open bus. §10.7 keeps the bus disabled until you say
   otherwise, and until then every create answers `503 {"error":"job bus is disabled"}`. The
   **Enabled** switch on the same card is the switch; generating or setting a token there already
   flips it, so this step is for the instance whose token came from the Coolify field.
3. **A worker, and what it is allowed to touch.** All of this is the same card, and all of it is
   written to the bus's own settings file, not to `sand-host-settings.json`:
   - **Workers**: pick the agent that runs `nextgen.chapter` off the roster. The bus stores its
     **id**, and it never sends the prompt into that agent's own conversation: it clones the agent
     per job (`<name> · job <last 6 of the id>`), strips every connector but the ones under
     **Connectors the clone keeps** (default `github`), and deletes the clone when the job ends.
     The jobs table's Worker column is that clone, and its tooltip names the agent it came from. A
     type pointing at no agent on this box stops its jobs on `needs_human {reason: "no_worker"}`,
     which is a stuck job rather than work done somewhere nobody chose.
   - **Repositories**: the only repositories a job may name, default
     `webdevtodayjason/nextgen-training`. Anything else is `400` before a worker sees it.
   - **Limits**: queue timeout (default 60 min), run timeout (120 min), max open jobs (20). A
     create beyond the last answers `429 {"error":"queue full"}`.
   - Give the box a GitHub credential as well, through **Settings → Connectors → GitHub** and the
     `gh` shell tool. Without it the worker stops on `needs_human {reason: "github_auth"}` rather
     than pushing, and the bus's own out-of-band check of the commits and files a job claims
     (§10.4) reports `verification:github_credential_missing` instead of confirming them.
4. **Smoke it from the CoS box.** Health first, then one `health.ping` job, then read that job
   back:

```sh
export TITAN_JOB_BASE_URL=https://tb.semfreak.dev TITAN_JOB_TOKEN=…
curl -sS -H "Authorization: Bearer $TITAN_JOB_TOKEN" "$TITAN_JOB_BASE_URL/v1/health"
curl -sS -X POST "$TITAN_JOB_BASE_URL/v1/jobs" -H "Authorization: Bearer $TITAN_JOB_TOKEN" \
  -H "Idempotency-Key: health-1" -H "Content-Type: application/json" \
  -d '{"type":"health.ping","idempotency_key":"health-1","payload":{}}'
curl -sS -H "Authorization: Bearer $TITAN_JOB_TOKEN" "$TITAN_JOB_BASE_URL/v1/jobs/<id>"
```

Health is authenticated too, on purpose: this is a public host. A `401` on the first line means no
token or the wrong one; a `503 job bus is disabled` on the second means step 2 is still undone.
The jobs table on the same console card shows every job the bus has run, and it updates as the
host reports transitions, so the smoke above should appear on screen without a reload.

If the relay is only on the tailnet, an ACL letting the CoS box and you reach `tb:443` is enough;
the bearer still applies. Nothing else on the relay is reachable with that bearer, and
`--job-token` makes `scripts/verify-deploy.mjs` prove it on `/api/listAgents`, `/`, `/vnc/1/` and
`/box/surface`. CDP, noVNC and the desktop stay on loopback: the same gate asserts the port
bindings when it is run against the server, and says so when it is handed only a URL.

## Email for your agents

Every agent can have an address at your own domain, and mail sent to it arrives in that agent's
conversation. The whole thing, including the DNS records and the two values you paste, is
[docs/MAIL.md](MAIL.md). The short version:

1. Verify your domain in Resend, turn inbound on, and add the MX record Resend shows you at the
   apex of the domain. If you already read mail at that domain, use one you do not.
2. In Resend, create a webhook for the `email.received` event and paste the address the Email card
   shows under **Settings**, which is `https://<your console>/hooks/resend`.
3. Paste the signing secret Resend gives you, and a Resend API key, into the two fields on that
   card. Both are write-only: the card says Saved or Not saved yet, and nothing on this server can
   read either back.
4. Type your domain, pick who gets mail nobody else is named for, and turn **Receiving** on. Each
   agent gets `agent<six digits>@<your domain>`, minted for it by the control plane and printed on
   that bot's own card and on the Email card's list. The digits are not its name on purpose: a name
   changes, and an address that changed with it would stop working.
5. There is nothing to do for sending. The key you pasted in step 3 stays on the relay and is never
   copied anywhere, and a bot that asks to send goes through the relay, which puts its own address
   on the message. It is worth knowing why: a key scoped to your domain can send as **any** address
   at that domain, so a copy inside one customer's box could send as every other customer and as
   your own Titan. If you set `RESEND_API_KEY` on a box before this, nothing reads it any more —
   clear it from that bot's **Secrets** card.

`node scripts/verify-mail.mjs --url <your console> --stub` measures the whole path against a stub
Resend, but it only runs against a scratch relay on the same machine that has no Resend key or
signing secret saved (it clears both when it finishes, and a signing secret cannot be got back), so
never point it at your working console with `--stub`. Without `--stub` it runs only the legs that change
nothing, which is what you want against an instance already carrying mail.

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

## The proxy: install, migrate, roll back

The whole design and every measured number is in `docs/PROXY.md`. This is the short operator path.

**Install.** Once, on the R750, and it touches no running customer:

```sh
ssh dell-remote TITANBOT_DRY_RUN=1 bash /home/sem/titanbot/deploy/proxy-install.sh   # read it first
ssh dell-remote bash /home/sem/titanbot/deploy/proxy-install.sh
node deploy/r750/proxy-coolify.mjs                                                   # from the Mac, ~/.api_keys sourced
```

Then deploy the service in Coolify and check three things before going further: the network alias
answers `/health/readiness` from inside the relay container, `docker port` shows **nothing**
published, and `deploy/r750/box-isolation.sh --verify` passes. `PROXY_TINYFISH_KEY_1` is the one
value the installer cannot fill in for you — there is no TinyFish name in `~/.api_keys` — so set it
by hand in Coolify or the web fetch route stays on the old path.

**Migrate**, one customer at a time, and this is the only step that changes what anybody uses:

```sh
cp/cli.mjs proxy migrate --dry-run          # prints what each box holds now, by name, length and hash prefix
cp/cli.mjs proxy migrate demo               # nobody is using demo, so it goes first
cp/cli.mjs proxy migrate richard-avery      # tell Richard BEFORE, not after
cp/cli.mjs proxy migrate titanium           # your own instance last
```

After each one, check four things on that box and not on any other: the operator key's hash prefix
is gone from `box-secrets.json` and `connector-env-secrets.json`, the new key's prefix differs from
every other tenant's, both files are 0600, and the box answers a message. The migration takes effect
on the next message — the host re-reads that file every turn, so no restart and no recreate, which
is what BOX-6 requires.

**Roll back**, per customer, from the 0600 snapshot the migration took:

```sh
cp/cli.mjs proxy rollback richard-avery
```

Keep those snapshots for the first week and then delete them. From the migration onward the proxy is
a single point of failure for every customer's inference — see the entry above under "When something
is wrong".
