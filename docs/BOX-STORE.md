# The box store, and repairing an agent's conversation

Everything a box remembers about an agent lives on the persistent mount under
`/home/box/sand-data`. Two files per agent carry the conversation itself:

| file | what it is |
| --- | --- |
| `agents/<id>/store.db` | the agent's own SQLite store: `transcript_entries`, `kv`, `blobs` |
| `agents/<id>/conversation-blobs.db` | the large parts of the conversation, out of line |
| `agent-transcripts/<id>/<id>.jsonl` | the flat mirror the host reads a conversation back from |
| `agent-transcripts/<id>/<id>.journal-mode` | a two-byte marker: this conversation is on the journal route |

`agent-transcripts` is a MIRROR. The databases are the record; the `.jsonl` beside them is derived
from the store and the blobs, and the host will rebuild it when it is missing.

This page covers the two ways that can break and the two ways it is now fixed. Neither of them
needs a container recreate, and neither of them needs anybody on the box.

---

## What a recreate no longer does (BOX-6)

Until 2026-09-08 the box store's copy-in restored `store.db` and `conversation-blobs.db` over the
live files at container start, first and alone. A store's copy of a busy SQLite file is stale by
construction, so what came back were pages that no longer matched the live write-ahead log, and
every turn after that failed with `database disk image is malformed`.

**That door is closed.** An agent database that already exists on the mount is not a copy-in
candidate at all, in any phase, including the symlink phase. A box with no sand-data still hydrates
from the store; a box that has one keeps what it wrote. The box's own log at start says so:

```
[box-copy-in] copy-in left 20 live agent database(s) as they are: home/box/sand-data/agents/…/store.db, …
[box-copy-in] result outcome=hydrated store_entries=1668 files=1648 …
```

`files` being lower than `store_entries` by exactly the number left alone is correct.

**Closing the door did not undo the damage already done.** That is what the rest of this page is
about.

---

## The two damage shapes

They look identical to the person using the product — the agent answers nothing, every time — and
they have nothing else in common.

### Shape one: the databases really are corrupt

`PRAGMA integrity_check` fails. The turn dies with `database disk image is malformed`,
`SQLITE_CORRUPT`, or `file is not a database`. This is BOX-6's shape, and it is what a stale
copy-in used to produce.

### Shape two: the conversation is pinned to a route the turn path cannot recover

Nothing on disk is damaged. `PRAGMA integrity_check` says `ok` on both databases, there is no
quarantine file anywhere, and the transcript directory holds only the `.journal-mode` marker: no
`.jsonl`, no pending log, no cursor. Every turn ends with

```
[sand][turn] agent run failed for <id> TranscriptJournalCorruptionError:
transcript checkpoint must recover before preparing
```

**Measured on the demo tenant's box `titanbot-box-atonqjq7zx593jsacaccpfau`, 2026-09-09, read-only.**
Agent `c63fdce4-4fc0-4ea7-8a1b-93657df2c6c5` had failed every turn since 2026-09-07 23:00:44Z,
eighteen times in one log, and it was the only such failure on the box. Its store held **115
transcript entries** and its blob database **5,002 blobs**; both passed `integrity_check`. Its
transcript directory held exactly one file, the 2-byte marker. Of the box's eight transcript
directories, that one was the only one carrying a marker; the other seven held ordinary `.jsonl`
files. Jason's box and Richard's box carried no marker and no such log line at all.

So the damage was not damage. A route marker written once pinned the conversation to the journal
mirror for ever, and the recovery that route needs was never called on the turn path, so the first
checkpoint of every host process threw and every turn failed after it.

---

## Repairing it from the product

**This is the route. The two by-hand recipes below exist for the case where the console cannot
reach the box at all.**

### From the console

1. Open the agent. The conversation says, in place of the old "could not finish that one":

   > This agent's conversation store needs repair. Repair it from the agent's details panel.

   Its roster row carries a red **Needs repair** pill, and so does the conversation header. The
   pill is deliberately not counted in the "N need you" number beside the agent count: that number
   is a queue of things a person was asked, and this is a machine that has stopped.

2. Open **Agent details**. The first card is **Conversation store**, carrying the host's own reason
   for the state and a **Repair** button.

3. Press it. It rebuilds the conversation from what the box already holds, keeps every entry it
   can, and moves nothing to the bin — a file it cannot use is renamed with a timestamp, never
   deleted. The panel then says what happened, with the count:

   > Repaired, 115 entries kept. Ask this agent something and it should answer now.

   A store that turned out to have nothing wrong with it says so instead — *There was nothing to
   repair here.* A refusal says what the host said, in the host's own words, and leaves the button
   where it was.

4. Ask the agent something. That is the only proof that counts.

The control is drawn only where the box's host carries the verb and only for an agent in that
state. A box on an older bundle draws no button; press it on a box that has just been downgraded
and it says so and takes itself away.

### From the gateway

The same recovery, on demand, for a box whose console cannot be reached:

```sh
curl -s -X POST http://127.0.0.1:1340/api/repairAgentTranscript \
  -H "authorization: Bearer $SAND_GATEWAY_TOKEN" \
  -H "content-type: application/json" \
  -H "user-agent: titanbot-operator" \
  -d '{"id":"<agent id>"}'
```

It answers `{agentId, before, after, quarantined, outcome, reason}` and writes an audit row into
`agents/<id>/audit.jsonl`. Measured on grok-bot-local-vm 2026-09-09, against a store with nothing
wrong with it:

```json
{"agentId":"6fc65d2b-…","before":0,"after":0,"quarantined":[],
 "outcome":"already-healthy","reason":"this conversation store had nothing to repair"}
```

Two things to read correctly, because both are easy to get backwards:

- **An empty `quarantined` is a normal answer, not a failure.** It arrives as `[]`, and in the one
  case this has been run against in production both databases were healthy and there was nothing
  to set aside. Read `after` for what was kept and `outcome` for what happened.
- **`reason` explains; it does not refuse.** The host sends one on a success as well. The outcome
  word is the verdict: `already-healthy`, `recovered` and `reset` are repairs that worked,
  `refused` is not.

### Before you repair a real customer's agent

Back the whole agent directory up first, inside the box, on the same volume:

```sh
docker exec <box> sh -c 'mkdir -p /home/box/sand-data/agent-backups && \
  cp -a /home/box/sand-data/agents/<id> \
        /home/box/sand-data/agent-backups/<id>-$(date -u +%Y-%m-%dT%H-%M-%SZ)'
```

Not under `agents/`. A directory there is scanned as an agent, and a copy with a store in it would
draw a second row on the roster wearing the same conversation. `agent-backups/` is on the same
volume and nothing walks it.

The demo Titan's directory is 221 MB against 1.9 T free on that filesystem, so space is not the
constraint, but the copy is not instant and it must finish before anything else runs. Name the path
you used in whatever you write up afterwards.

---

## Repairing a store by hand, without a recreate

Only when the console and the gateway are both out of reach. Read-only first, always.

```sh
# name the agent before touching anything
docker exec <box> sqlite3 "file:/home/box/sand-data/agents/<id>/conversation-blobs.db?mode=ro" \
  "PRAGMA integrity_check; select count(*) from blobs;"
# rebuild beside it
docker exec <box> sh -c 'sqlite3 /home/box/sand-data/agents/<id>/conversation-blobs.db .recover \
  | sqlite3 /home/box/sand-data/agents/<id>/conversation-blobs.db.recovered'
# count the rebuilt file, then swap it in during the host's SIGTERM window of an updateHostNow swap
```

Swap during the swap window, never under a running host, and never by recreating the container.

`REINDEX` before `.recover` before a row-by-row salvage: the salvage stops at the first page it
cannot read, which is how a 2,940-row file once came back with 5.

For shape two there is nothing to run sqlite against. Removing the `.journal-mode` marker also
makes the agent answer again — and it is the wrong fix, and the product does not do it: it silently
moves the conversation back to the older mirror and changes how it is persisted behind the
operator's back. The repair recovers the route it is on and says so.

---

## Telling the two shapes apart, read-only

```sh
# is anything actually corrupt?
docker exec <box> sqlite3 "file:/home/box/sand-data/agents/<id>/store.db?mode=ro" "PRAGMA integrity_check;"
docker exec <box> sqlite3 "file:/home/box/sand-data/agents/<id>/conversation-blobs.db?mode=ro" "PRAGMA integrity_check;"
# what is in the transcript directory?
docker exec <box> ls -la /home/box/sand-data/agent-transcripts/<id>/
# how many conversations on this box are on the journal route at all?
docker exec <box> sh -c 'find /home/box/sand-data/agent-transcripts -name "*.journal-mode" | wc -l'
```

Two `ok`s and a directory holding only a `.journal-mode` marker is shape two. A failing
`integrity_check` is shape one. `sqlite3` is inside the box; it is not on the R750 host.

---

## The gate

```sh
node scripts/verify-transcript-repair.mjs                  # the console, real Chrome, no box needed
node scripts/verify-transcript-repair.mjs --box            # grok-bot-local-vm: the verb, self-recovery
node scripts/verify-transcript-repair.mjs --box --refuse   # and the shape recovery has to refuse
node scripts/verify-transcript-repair.mjs --all
```

Measured on grok-bot-local-vm 2026-09-09: console **26 PASS / 0 FAIL / 0 SKIP**, box **12 PASS /
0 FAIL / 0 SKIP**. On the box leg the scratch agent held a turn (0 → 2 entries), was damaged with
the marker, and the host recovered on its own on the next turn (2 → 4) with the entries it already
had kept; the verb then answered `already-healthy` and the turn after that completed (4 → 6). The
refusal shape is behind its own flag because a fourth model turn does not fit the 300 s ceiling
beside the other three.

The console leg stands up a stub relay, boots the real page in real Chrome, and presses **Repair**
at the control's own screen coordinates after hit-testing what a pointer would land on there — a
passing `page.click()` is not evidence a human can click. The box leg creates a scratch agent,
damages it with the marker exactly the way the demo Titan was damaged, and proves the host recovers
on its own; it deletes the agent afterwards, because a roster that grows during a gate run is a bug.

The R750 leg is run by hand, once, against the real agent: back it up, repair it through the
product, send it a message, read the answer.

---

## What that leg measured, 2026-09-09

On the R750, demo box `titanbot-box-atonqjq7zx593jsacaccpfau`, agent
`c63fdce4-4fc0-4ea7-8a1b-93657df2c6c5`, on bundle `39f588dbc57d`.

Backup first, and it is where it says:
`/home/box/sand-data/agent-backups/c63fdce4-4fc0-4ea7-8a1b-93657df2c6c5-2026-09-09T20-41-53Z`,
221 MB, carrying 118 transcript entries and 5,023 conversation blobs.

Before the repair the transcript directory held one file, the 2-byte `.journal-mode` marker written
2026-09-07 23:00:44Z. No conversation file at all. The store held 118 entries, both databases passed
`integrity_check`, and the host log carried 19 `TranscriptJournalCorruptionError` lines, every one of
them this agent.

`repairAgentTranscript` answered
`{"before":0,"after":0,"quarantined":[],"outcome":"already-healthy","reason":"this conversation store had nothing to repair"}`
and wrote one `transcript_repair` row into that agent's ledger at 20:46:27.956Z. That is the honest
answer for this shape: there was no stale write-ahead copy to set aside and no unreadable database to
reindex. The verb clears the way; the rebuild happens on the next message.

The message went in at 20:46:27Z. The host log gained one line and no new failure:

```
[sand][transcript] repaired the conversation store for c63fdce4-…: 0 entries before, 8 after, nothing set aside
```

After it: the conversation file exists, 4,217 bytes, 11 entries; the store 118 → 120 entries;
conversation blobs 5,023 → 5,042; `TranscriptJournalCorruptionError` still 19, so not one more since
the bundle landed. Asked "Titan, are you back? Answer in one short sentence", it answered **"Yes, I'm
here."** six seconds later, and then worked through the backlog the failed turns had left it.

The same verb answers at the console's own address. `POST https://console.titanium.bot/api/repairAgentTranscript`
for the operator's own Titan returned `{"before":750,"after":750,"quarantined":[],"outcome":"already-healthy"}` —
the identical call the Repair button makes, over the production edge.

Richard's box `titanbot-box-wepegxhh3fpvr83bubvz5xm5` carries no marker and no such failure. It
needs nothing from any of this and no wave touches it.
