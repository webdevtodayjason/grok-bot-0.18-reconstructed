# DISCOVER-1, relay and control plane: the welcome bar's six steps

Branch `day-discover1-relay`. The brief is docs/DISCOVER-1.md. The console half is somebody else's
item and is built against the same `/discover` answer; nothing in that shape changed while this was
written, and the three routes below are the whole contract.

## The short version

`GET /discover` answers `{steps:[{id, label, done, count, of, read}], done, of, pct, hidden}` for the
signed-in person, and every one of the six steps is ticked from something that can be read saying it
happened. There is no route, no body and no field anywhere in this that marks a step done, which is
asserted as an absence in the tests because an absence is the thing that gets edited away.

`POST /discover/hide` and `POST /discover/show` are one write with two spellings. The flag lands on the
control plane in a new `person_flags` table keyed on the workspace, the person and the flag's name.

Five of the six steps are read from the box or from this relay, so the bar draws on a single-box
install with no control plane at all. The sixth, voice, reads as unreadable there rather than as zero.

## Where each of the six evidence reads actually lives

Measured before anything was built. **Three of the six are not where the brief put them**, and two of
those three are corrections rather than choices.

| # | Step | Surface it is read from | How |
|---|---|---|---|
| 1 | Say hello to Titan | the **box**, over the gateway | `listAgents` then `getAgentTranscriptTail {id, limit: 200}` |
| 2 | Make a voice call | the **control plane**, `voice_sessions` | new `GET /v1/relay/discover` |
| 3 | Connect an app | the **box**, over the gateway | `listInstalledMcpServers` then `listConnectorSecretFields {server}` |
| 4 | Give Titan a memory | the **box**, over the gateway | `getAgentMemories {id}` |
| 5 | Watch his screen | **this relay**, the tenant's own state directory | `discover.json`, written at the desktop websocket upgrade |
| 6 | Put him in your pocket | **this relay**, the tenant's own state directory | the device store `forSub(sub)` |

### The three that were not where the brief said

**Step 6 is not on the control plane, and there is no table there for it to be on.** The brief says
"a device bearer for this account (cp device sessions)". A device bearer is a signed payload plus a
row in the tenant's own state directory (`ui/auth-device.mjs`, rule 2), and `cp/cli.mjs:1646` states
it in one sentence: *"device list and device revoke go through the relay too: a device row lives in
the tenant's state directory, not in this container."* `grep -i device cp/store.mjs` finds nothing.
It cannot move either: `ui/session-token.mjs` forbids the relay asking the control plane to validate
anything on a request path, and the third rule of `ui/tenant-login.mjs` says the control plane is
allowed to be down. So the read is the relay's own device store, scoped by person, and revoked rows
do not count.

**Step 5's flag did not exist, so this wave writes it.** The brief calls it "a per-person flag the
relay stores", which was a description of something that was not there. The honest place to set it is
the moment the screen actually opens, which is the VNC websocket upgrade in `ui/server.mjs` and is the
only place in this product that knows it happened. That is one added line in the upgrade handler,
after both of its refusals so a socket that was turned away never ticks a step, never awaited, and
unable to fail the upgrade.

**The per-person flag pattern the dispatch named does not live on the control plane.** The dispatch
said to copy how VOICE-10's talk-mode row is stored per person, "cp route + store". VOICE-10's row is
**not on the control plane**: it is a `talkModes` map inside each workspace's own `voice.json` on the
relay, keyed on `sub` (`ui/voice-edge.mjs:1245-1283`, and its own comment records that it went on the
voice door because the notifications door refuses the field by name). What was copied from it is the
shape rather than the address: keyed on the relay's `sub`, `""` meaning the instance-password door,
bounded, one person's entry answered and never the map. The **address** is the brief's, which says the
flag goes on the control plane, and that is where it went: a person's account is there, and
`accounts.tenant` carries no `UNIQUE` constraint, so a workspace-level setting would take the bar off
a colleague's screen.

### What each read is actually looking at

**A person's own message is `kind: "message"` with `role: "user"`, and nothing else.**
`gateway-adapter.js:236` is where this is written down: *"send-message is the agent speaking, and is
the agent's only voice; message with role user is the operator. Everything else is machinery."*
Counting a `send-message` entry would tick "say hello" for a workspace whose only activity was an
automation firing on a schedule.

**A connector counts when the host's store reports HOLDING a value, not when it offers a field.**
`listConnectorSecretFields` answers two lists and they answer two different questions: `fields` is the
union of what may be stored and the env keys an entry leaves empty, `stored` is what the 0600 store
actually holds. `gateway-adapter.js:1646` records the bug from reading the wrong one, on the very card
the TinyFish preset exists to get a key into. This reads `stored`.

**A voice call is a settled row of at least ten seconds.** An open row has no `wall_seconds` until the
settle writes one, and `cp/voice.mjs` carries a sweep because rows get left open by relays that went
away, so counting an open row would tick the step on a pressed button. Ten seconds is the brief's
number and it earns its place: a press and a change of mind leaves a two-second settled row behind it.

## The budget

Every read is wrapped in `withBudget`, which races the read against 1,500 ms and **aborts its signal**
on expiry rather than leaving a socket held. A read that times out and a read that throws are the same
answer: the step is not done. Neither is ever an error, because this is drawn in the window bar of a
console that is otherwise working, and a red badge there over a slow box would be a false alarm on a
product that is fine.

The six reads run together, so the whole answer costs one budget and not six. Two economies inside
that: `listAgents` is read **once** and serves both steps that need Titan's id, and the control plane
answers its two facts (the voice count and this person's Hide) in **one** round trip.

`read` is on the wire beside `done` as the honest third state: not-done because nothing could be read,
as against not-done because it has not happened. Both draw an unticked row; only one of them is
truthful about why, and the difference is what stops a broken volume from looking like a person who
never pressed the button.

**The cost of the shared control-plane round trip, stated rather than hidden:** with the control plane
down, a person who pressed Hide sees the bar again. Hidden fails open. The alternative is a console
that hides a bar because a service is unreachable, which is worse.

## Who Titan is

`titanOf` walks the same chain `ui/voice-edge.mjs resolveVoiceAgent` walks: a bot whose name reduces to
`titan`, else the first non-group bot on the roster, else nobody. A welcome bar reading a different
conversation from the one the voice and the mail land on would tick "Say hello to Titan" off a
conversation the person has never seen called Titan. The two are pinned together by a test that runs
both chains over the same rosters rather than by an import, because `ui/voice-edge.mjs` is four
thousand lines of realtime bridge and this file is reached on every console load.

## What was built

| File | What |
|---|---|
| `ui/discover-edge.mjs` | new. Every rule, every budget, the six reads, the three routes and the desktop flag |
| `ui/server.mjs` | the import, one factory, one route block beside `/voice/settings`, one line in the desktop upgrade |
| `cp/store.mjs` | the `person_flags` table, `setPersonFlag`, `getPersonFlag`, `countSettledVoiceSessions`, three bounds |
| `cp/server.mjs` | `GET` and `POST /v1/relay/discover` behind `requireRelay`, and the two constants |
| `tests/discover-edge.test.mjs` | new, 26 tests |
| `tests/cp-discover.test.mjs` | new, 9 tests |

The three relay routes sit behind the session exactly as `/voice/settings` does, resolved to the
request's own workspace, and keyed on the same `subOf` the device list and the talk mode are keyed on.

`person_flags` is `(tenant, sub, name)` with a text value, a table rather than a column on `accounts`
for the same reason `admin_settings` is a table: the next per-person flag has no other home either, and
a column per checkbox is an `ALTER` on a live database every time somebody adds one. `Show` clears the
row rather than writing a false, because never-chosen and chose-the-default are one fact.

## The tests, and what they are for

The claims worth pinning are the ones a checklist gets wrong in a way nobody notices.

- **No caller can tick a step.** Every path is tried with a body that declares all six done; nothing
  reaches the box, nothing is written, and the bar afterwards is unchanged. The edge's whole surface is
  asserted by name, so there is no fourth entry point a step could be set from.
- **A read that never settles cannot hold the answer**, and its signal is aborted. Driven with a
  dependency that never resolves.
- **A box that answers nothing draws an empty bar**, not an error, and the two steps this relay owns
  still answer, which is what keeps a single-box install drawable.
- **Per person.** One account's phones, desktop flag and Hide do not reach a colleague's bar, on both
  halves.
- **Off the right field.** A `send-message` entry is not a hello; a connector field that may hold a
  credential is not one that does; a revoked phone is not a phone in a pocket; an open or three-second
  voice row is not a call.
- **`person_flags` lands on a database that already holds the other tables**, built by cutting this
  wave's DDL out of the real `SCHEMA` rather than hand-writing an old one. Same test `cp-voice` writes
  for `voice_sessions`, and for the same reason: `CREATE TABLE IF NOT EXISTS` does nothing to a
  database it is not run against, and the R750's is live.

### The run

Local, on this Mac, `node --test`:

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| `tests/discover-edge.test.mjs` | 26 | 26 | 0 |
| `tests/cp-discover.test.mjs` | 9 | 9 | 0 |
| `tests/relay-auth.test.mjs` | 22 | 22 | 0 |
| `tests/cp-admin.test.mjs` | 44 | 44 | 0 |
| `cp-store`, `cp-voice`, `cp-server`, `cp-relay-registry`, `auth-device` | 131 | 131 | 0 |

`node --check` clean on all six touched files.

## What is not proven

**No box and no control plane were touched.** Every read in this item is exercised against injected
dependencies; the gateway command names and their answer shapes come from `source/host/gateway-protocol.ts`
and from the console's own adapter, not from a live host. A box whose host predates
`listInstalledMcpServers` or `listConnectorSecretFields` draws step 3 unticked, which is the designed
fallback, but that path has not been watched on a real box.

**The transcript tail is a window.** A conversation whose last 200 entries are all the agent's own work
would read as "no user message" and step 1 would untick. A turn is bounded by the person who started
it, so 200 entries covers many turns, but a workspace running heavy automation is the case that could
prove this wrong.

**The desktop flag is not locked.** Two upgrades in the same millisecond can lose one of two entries.
The cost is one person's row unticking until they next open the pane.

**The connector fan-out is capped at 16.** A box with more connectors than that, all of whose
credentials sit on the seventeenth onwards, would draw step 3 unticked. One connector with a key is
enough for the tick, so this only bites at a shape nobody has.
