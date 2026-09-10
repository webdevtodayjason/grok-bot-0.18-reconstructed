# Talking to your team (VOICE-1)

You press a button in the console and talk. The head of your team answers out loud. It is the same
conversation you type in, the same memory, the same people, the same approvals: nothing about voice
is a second assistant with its own ideas.

> **Three sentences in the original design note are wrong, and this document is where that is
> recorded** rather than in a comment somebody walks past.
>
> 1. "Since both providers speak the same wire, one bridge serves both." Not as of September 2026.
>    The two vendors take different session frames and one of them refuses the other's outright. One
>    transport, two session builders. Section 3.
> 2. "It speaks the reply as it streams." Not reachable on this product's host. The reply arrives as
>    one finished message, 5.5 to 25 seconds after the question and 50.6 on a cold box, with no
>    partial text to speak. What carries that silence is the acknowledgement. Section 5.
> 3. "xAI is cheaper." Its realtime model is **$0.08 a minute** of audio. The $0.05 figure that gets
>    quoted belongs to a model that is deprecated. xAI is still the default, for **predictability**
>    rather than for the headline rate. Section 7.

---

## 1. What it is

The realtime model is a **mouth and ears, and not a second brain.** It has exactly one tool, which
puts what you said into your team lead's conversation and hands back the reply. It cannot search, it
cannot read a file, it cannot reach another workspace, and it has no memory of its own. Everything it
appears to know, it got by asking your team lead.

That is a decision and not a limitation we have not got round to. A realtime model that could search
would answer from outside your team's memory, in your team lead's voice, and you would have no way to
tell which answers were which.

What you get:

- A **talk button** beside the message box, and an orb beside it that shows off, listening, thinking
  or speaking.
- **Press to start, press to stop.** There is no wake word and nothing is ever listening on its own.
- Everything spoken lands in the **same conversation you type in**, marked as spoken, and it is there
  on your phone afterwards.
- A **held action** is read out as a question. "Send it?" A yes closes it through the same approval
  you would have clicked, and never a second one.
- **Your microphone is held shut while your team is speaking**, plus a third of a second for the room
  to go quiet. Section 8 is why.

What it is not, in this release: no hotkey in a desktop app, no wake word, nothing always-on, no
meeting transcription (that is MEETING-1 and shares only the capture code), voice for your team lead
and not for every bot you own, and no interrupting mid-sentence on speakers.

---

## 2. Where the key goes (rewritten 2026-09-10, KEYS-1)

**The realtime key belongs to the operator, and a customer never sees a key field.** The super admin
pastes it once at `api.titanium.bot/admin`, in the block called "Keys the product uses", and that is
the only place in this product a person ever types one.

This section used to say the opposite, and it is worth writing down why it changed rather than
quietly editing it. Until 2026-09-10 the key was a **per-workspace** secret a customer wrote on their
own Voice card. Jason, looking at that settings panel: *"A user is never going to put a resend key in.
That's on the backend."* He is right, and not only about taste. A key field on a customer's screen is
a key a customer can get wrong, a key that customer's own agents can be talked into reading out of
their own box, and a vendor bill nobody can attribute.

### Why one shared key is safe now, when it was not before

The old argument was: *"One value shared by every customer is the thing this whole product was rebuilt
to stop."* That argument was about **isolation**, and the isolation was never the key. It was the
metering and the caps, and both of those are per workspace on the control plane and have been since
VOICE-1:

- Every session claims a ledger row **before** the provider hears a byte, against that workspace's
  slug. Section 9 is that ledger.
- The day cap and the session cap are read per workspace, and only the operator can change one.
- A workspace that has spent its day is refused whichever key would have dialled.

So what is shared by this change is **the vendor's bill**, which the operator was always paying
anyway. What is not shared is any workspace's ability to spend past its own cap. If the caps were
not there, this change would be wrong; they are, and it is not.

### One key per service, and where it travels

The names are `keys.voice.xai` and `keys.voice.openai` — one per **service**, because the service is a
per-workspace choice and it decides which key dials. A workspace set to a service the operator has no
key for gets the plain refusal, never the other service's key aimed at the wrong vendor: that would
be a 401 a person reads as a broken product.

The relay reads them from `GET /v1/relay/secrets` behind `CP_RELAY_TOKEN`, keeps them **in memory
only**, refreshes every five minutes, and degrades to the last good copy on an outage. It sends the
key to the vendor as an `Authorization` header — never in a URL, never in a websocket subprotocol
(proxies log those), never in a log line, never in a ledger row. Tests plant a key and sweep the wire,
the ledger, every log line, every frame the browser was sent, and the workspace's own settings file
for its bytes and for a ten-character prefix of them.

### The migration is the fallback, and there is no migration code

The relay prefers the control plane's value and falls back to **the workspace's own file**. Nothing
anywhere pushes a file value up to the control plane: that would be a brand new write path for a
secret and would undo write-only-from-the-console.

Measured on the R750 on 2026-09-10: no `voice.json` exists anywhere on that machine, so no customer
has ever pasted a realtime key and the door starts empty. Paste it once at the admin console and
talking works; until then it is off, and it was off before too.

### Three places it still deliberately does not go

- **Not the super-admin Providers panel.** Those keys are global to the whole install, they live at
  the metering proxy as credentials, they read back masked, and that file's own rules forbid a key
  value in any answer with a test that plants one and sweeps every route for it. The realtime key is
  now global too, but it is not a *chat* credential and has no row there. The panel does carry two
  realtime cards, and they are **labels only** — see section 10.
- **Not the endpoints catalog.** That is the input to the *chat* model resolver: it fetches a model
  list against every row and pins the winner into your box. A realtime row there would be offered to
  you as a chat model and would fail every message you sent.
- **Not an environment variable on the relay or in your box.** An environment value is readable by
  anything in that container, and every exec daemon in a customer's box runs as uid 0.

### The browser path, refused on purpose

Both vendors ship a way for a browser to hold the socket itself — a short-lived client secret, and on
one of them WebRTC, which that vendor actively recommends for browsers. Both are faster to build and
both are refused here.

They put a real credential in the browser, they bypass the minutes ledger, and they make the daily
cap unenforceable. The relay holding the socket and counting the seconds **is** the reason this bridge
exists. The cost is that we own the jitter and the playback, and that is a real cost. We are paying it
knowingly.

---

## 3. The two providers, and why a URL swap is not a provider swap

Both speak a family of events with the same names. They do **not** take the same session frame.

| | xAI (the default) | OpenAI |
|---|---|---|
| Session frame | flat: `session.voice`, `session.turn_detection` at the top level, no `session.type` | typed: `session.type: "realtime"`, `audio.output.voice`, `audio.input.transcription` |
| The other one's frame | — | **refuses it**: `Unknown parameter: 'session.voice'` |
| `OpenAI-Beta` header | not used | must **not** be sent on the GA endpoint |
| What you heard, as text | cumulative and self-correcting | incremental deltas |
| Turn-taking controls | turn detection only | also `turn_detection.interrupt_response` |
| Budget telemetry | **none at all** | `rate_limits.updated` every turn |

Two consequences worth spelling out:

- **What you said is normalised to replace-the-whole-line** before it reaches the page. On one vendor
  the transcript is cumulative with corrections, so appending each update writes the sentence over
  and over.
- **On xAI, holding the microphone shut is the only defence** against your team hearing itself. The
  other vendor has a switch for it; xAI documents no equivalent. Section 8.

`REALTIME_VENDORS` in `cp/voice.mjs` is the authoritative table: the wire shape, the address, the
default model, the voices and the published price with the date it was read. The CLI, the operator's
own settings and this document all name those rows.

---

## 4. Who answers

Your team lead, resolved by the relay and never named by the model. In order: the agent you chose in
Settings; an agent whose email localpart is `titan`; the first worker on the roster; and if none of
those exists, a refusal in one plain sentence.

**The model never says which workspace or which agent.** Both come from your signed-in session. A
model-supplied agent id would be a cross-tenant read through an open microphone.

---

## 5. The honest latency, and the silence in the middle

Measured on `grok-bot-local-vm`, September 2026, against the real host:

| hop | what | measured |
|---|---|---|
| T0→T1 | you stop talking → the vendor decides it was a turn and calls the tool | vendor's |
| T1→T2 | the tool call reaches the host | **ours, 6–14 ms** |
| T2→T3 | **your team lead thinks** | **5.5–9.0 s** for a short question, **15–25 s** when it touches a shell, **50.6 s** on the first turn of a cold box |
| T3 | the reply is noticed | ours, ≤450 ms at a 400 ms poll |
| T3→T4 | the first sentence goes back to the vendor | **ours, ≤20 ms** |
| T5→T6 | the first sample is audible | **not measured** — see below |

**T5→T6 is not on this ledger and cannot be**, and it carried a number (≤120 ms) until 2026-09-10
that nothing had ever measured. The first sample becoming audible is the page's, playback is Web Audio,
and a Web Audio path has no `.played` to read a time off — section 11 says so in the gate's own words.
The evidence for that hop is what the gate really collects: the audio clock advancing, an analyser RMS
of 0.18 on real energy rather than a silent buffer, and the bytes queued. Every other number in this
table names the machine it was measured on; that one was borrowing the caption's authority.

**T2→T3 is the whole of it, and it is not ours.** The host emits the reply as one complete message:
there is no partial text, no growing message, nothing to speak early. It deliberately drops the
reply-sending step from every surface a console can read (`roster-projection.ts:420` projects fifteen
other cases and not that one), so "speaks the reply as it streams" is not a thing this product can do
today, and nothing in this release claims it.

What covers that silence is the realtime model's own acknowledgement — "on it" — and, past twenty
seconds, at most two "still going" nudges driven off the roster actually saying the turn is running
rather than off a bare timer. The relay then splits the finished reply into sentences and hands back
the first one immediately, so speech starts on a sentence rather than on a paragraph.

**VOICE-3** is the one host-side change that would make it real streaming: project that one step the
way the other fifteen are projected. It is filed, with its line number.

One more measured oddity, because it shapes the design: one prompt produced **two** replies seven
seconds apart under a single attempt id. So later messages of the same attempt go on an announcement
queue and are spoken between turns, never on top of one.

---

## 6. The caps, and who can change them

| | default | counted on |
|---|---|---|
| one session | **30 minutes** | wall clock |
| one workspace, one day | **120 minutes** | wall clock, UTC day |
| one workspace at a time | **one call** | live sockets on the relay |
| audio a page may send | **the session's own cap**, and never more than three seconds ahead of the clock | audio seconds |

**One call at a time for a workspace.** Press Talk in a second tab and it reads *"This workspace is
already in a call. Stop that one and press the button again."* The day cap is a number read off the
ledger when a socket is accepted, so without this N tabs opened together each read the same remaining
day and the cap multiplied by N — measured on this Mac at ten tabs against a twenty second day cap, all
ten accepted and two hundred seconds authorised. The reservation is taken in the same instant as the
check, because the accept path then reads a ledger, a roster and writes a claim, and nine of ten still
got in when only the set of live sessions was consulted.

**The audio has its own ceiling.** The caps count wall seconds and a vendor bills audio seconds, and a
page sets the rate it sends at: measured on this Mac, 14.4 MB (five minutes of audio) reached the vendor
in 0.15 s of wall clock with every cap on screen reading green. So the relay holds a session to its own
cap in audio as well, drops anything more than three seconds ahead of the wall clock, and counts what it
dropped as a held frame. Real capture sends 100 ms at a time and is never ahead; a page that is has been
patched or is broken, and neither needs forwarding. **VOICE-5** is still the row for caps in money rather
than in minutes.

**Wall clock, not audio seconds**, because a minute of wall clock is the only number you can predict
before you start talking. A provider bills on audio seconds, and the ledger records both.

**You cannot raise your own cap.** The minutes live on the control plane behind the operator's own
credential. A customer raising their own daily cap is unbounded spend on somebody else's invoice. Since
KEYS-1 the key is the operator's too, so both halves of the spend decision are on one side of one
door — which is the point, and is what makes one shared vendor key safe (section 2).

The operator changes them:

```
node cp/cli.mjs voice policy <slug>
node cp/cli.mjs voice cap <slug> --day-minutes 240 [--session-minutes 45] [--vendors xai,openai]
node cp/cli.mjs voice cap <slug> --vendors none        # voice off for that workspace, in one word
```

`--vendors none` is the deliberate off switch, and it is a word rather than a zero for a reason: a
minutes field that reads zero is far more likely to be a typo than a decision, so a zero falls back to
the default instead of silently switching a customer off. A provider list that names nothing this
product knows falls back the same way.

**The relay enforces on its own clock**, on a ten second tick, against its own ledger on its own disk.
It reads the numbers from the control plane, cached a minute, and falls back to the defaults when the
control plane cannot be reached — which is also how it behaves on a developer machine, where there is
no control plane at all. A control-plane outage costs a line on the Spend panel and never a cap.

Neither vendor's own warnings are relied on. xAI emits no budget telemetry at all, documents no
concurrency or duration limit, and the "25 minutes" people quote belongs to a different API. Our clock
is the only cap there is.

---

## 7. What it costs

Read 2026-09-09 from each vendor's own pricing page. **Vendor pages, not analysis.**

| | model | audio | other |
|---|---|---|---|
| xAI | `grok-voice-think-fast-2.0` — **the one the relay dials** | **$0.08 a minute** ($4.80 an hour) | **$0.004 per billable message** we send |
| xAI | `grok-voice-think-fast-1.0` | $0.05 a minute | **deprecated** — this is the number that gets quoted |
| OpenAI | `gpt-realtime-2.1` | $32.00 in / $64.00 out per million tokens | $0.40 per million text in |
| OpenAI | `gpt-realtime-2.1-mini` | $10.00 in / $20.00 out per million | $0.30 per million text in |

The relay dialled a moving alias (`grok-voice-latest`) until 2026-09-10 while this table priced the
pinned model, so the model being billed was not the model being quoted. Both sides now name the same
string, `cp/voice.mjs` is the one table it comes from, and `tests/cp-voice.test.mjs` fails if the two
drift apart again. A moving alias is also how a vendor changes what a minute costs without anything
here changing.

Any **per-minute** figure for OpenAI is third-party analysis: that vendor publishes tokens, not
minutes, and this product does not convert one into the other and present it as a price.

**xAI is the default for predictability, not for being cheaper.** A flat rate per minute, no context
re-billing, and a tool result costs nothing. Two disciplines fall out of that and both are in the
code:

- Your team lead's reply goes back as tool-result messages, which are **free** on xAI. Nudges are
  bounded because each one is a billed message rather than just a word.
- On OpenAI the base instructions are written **once** when the socket opens and are byte-identical
  for its whole life. Rewriting them invalidates the cached prefix and re-bills the entire
  conversation every turn. That was the single most expensive thing the reference implementation did.

---

## 8. Speakers, and your team hearing itself

If the voice comes out of speakers rather than headphones, it goes into the room and back into an open
microphone. The vendor's turn detection reads that as you talking: it cancels the reply it is halfway
through and transcribes its own words as your next instruction.

From the reference implementation's own session log, on a machine whose microphone and line out were
the same interface:

```
reply  'OH-mah, OH-mah, OH-mah.'
error  response cancelled: turn_detected
heard  '어마'                    <- its own name, back through the microphone
reply  'Yes, I'm here.'
```

And later its own sentence came back as two of the user's turns. **A fragment that transcribes as an
instruction is not merely noise**: one arrived as `'Бела.'` and pressed CTRL+R.

So the microphone is **held shut while your team is speaking, plus 350 ms** for the room to go quiet.
That is the default and there is nothing to configure.

**It is held on both sides.** The page stops capturing, so nothing is even sent; and the relay drops
any audio that arrives inside the same window, so a patched page cannot make the model hear itself.
The dropped-frame count is a number on the server, asserted by a test with no browser in it, and it
ends up on the session's ledger row.

The one thing it costs is interrupting mid-sentence, which on speakers never worked anyway, because
the interruption was coming from the speakers. On headphones it is still off in this release, and
turning it back on is not a setting: it is the defence described above.

When the audio is queued, "is the queue empty" is not the question. The model sends a reply far faster
than it is spoken, so how long sound will still be in the room is booked from the **bytes** handed
over, not from whether the player is idle.

---

## 9. What is written down, and what is not

One line per session, in your own workspace's state directory, and one row on the control plane for
the operator's Spend panel. A row holds: the session, the workspace, the agent, the vendor and model,
when it started and ended, wall seconds, audio seconds in and out, billable messages, how many turns
went to your team, how many microphone frames the echo gate dropped, and why it ended.

**No transcript, no audio, no key, nothing anybody said.** The readable record of what was said is
your conversation, on your own volume, in your own console. A count of dropped frames is not a
recording of them.

**The row is claimed before the socket is dialled**, not written when it closes. A row written on
close does not exist for a relay that crashed or a tab closed mid-sentence — and the daily cap is read
out of those same rows, so getting it backwards is unbounded spend rather than a missing report. A
session that is running right now counts at **what it has run so far**, which is the only way an
afternoon-long session counts toward the day at all.

Two details that are easy to get wrong and were, here, before they were measured:

- **A session that crosses midnight counts against both days, for the part that falls inside each.**
  The first version of this counted a session against the day its row was dated, so one that started
  at 23:59:30 and was still going at 00:05 counted against *neither*: today's sum only looked at rows
  dated today, and that row belongs to yesterday. A workspace could be talking, spending its minutes,
  and counting against no day at all. **This was true of the control plane's copy and not of the
  relay's own file until 2026-09-10** — the file that is the enforcement truth — so the fix was half
  applied while this paragraph read as though it were whole. Both halves now clip an open row to the
  day being asked about, whichever day it started on, and both still clamp it to the session cap.
- **A row left open by a relay that went away is clamped, and then settled.** A relay restart mid-call
  leaves a claim nobody will close. Both sides clamp such a row to the session cap, so it cannot grow,
  and the control plane settles anything older than that cap when it starts, with the reason *the relay
  went away* on the row. Unclamped, one orphan read 143 hours on the Spend line while the same
  service's day number read nought — measured on this Mac before the clamp — and it refused that
  workspace's voice for whole days.
- **A close that arrives twice leaves the settled row alone.** The relay reports the close best effort
  and retries, so a timeout after the write lands means it arrives again. The second one answers "yes,
  already done" and changes nothing. Before that guard a replay carrying a different number simply
  overwrote the first — and the daily cap is read out of these rows, so a number that can change after
  the fact is a cap that can.

The operator reads it:

```
node cp/cli.mjs voice usage [<slug>] [--day 2026-09-09]
```

**Every column says which meter it is.** Wall clock is what the caps count. Audio seconds in and out
are what a provider's invoice is built from, and they do not add up to wall clock. Billable messages
are the flat per-message fee on one vendor and nothing at all on the other. One "minutes" column would
reconcile against neither invoice, so there is no single minutes column.

With nothing ever reported, the Spend panel and the CLI both say **not measured, in words**. Never
"0 minutes". A zero from a meter nobody has ever read looks exactly like a zero from a meter that was
read, and the wrong one of those is the one that looks like data.

### Where the numbers travel

The relay reports each row open and each row closed to the control plane, best effort. The relay's own
file on its own disk is the enforcement truth. The control plane's copy is the Spend line. The relay
and the control plane do share a volume on the production server today, and a direct read of that file
would work — it is named here as the fallback and is deliberately **not** built, because it couples the
control plane to the relay's on-disk layout, and a door between them is the pattern this product
already states.

---

## 10. The two realtime cards on the Providers panel

The super-admin Providers panel lists `xai-realtime` and `openai-realtime`. **They are labels.** They
offer no model, hold no key, mint nothing at the metering proxy, and feed nothing the relay reads.
They exist so the one panel an operator goes to when they want to know what this product can talk to
does not look like it has never heard of realtime, and so the key-file slot names are written down
where every other vendor's are.

Measured on this Mac 2026-09-09: both rows answer **zero models and zero keys**, and a key pasted into
one is **refused and not stored** — the address is a websocket, so the panel's proof step cannot
complete against it:

```
xai-realtime     409  xAI realtime (voice) would not accept that key, so nothing was stored.
                      xAI realtime (voice) could not be reached (fetch failed)
```

Nothing is stored and nothing leaks, which is what matters. But "could not be reached" is a misleading
reason for a control that can never succeed, and a realtime key does not belong there anyway.
**VOICE-4** makes those two cards read-only and says where the key actually goes. Since KEYS-1 the
answer is the "Keys the product uses" block on the same console's System health panel — section 2.

---

## 11. Proving it

```
node --test tests/cp-voice.test.mjs                     # the caps, the ledger, the doors, the presets
timeout 300 node scripts/verify-voice.mjs --leg cp       # the control plane half, end to end
timeout 300 node scripts/verify-voice.mjs --leg relay    # an accepted socket and a row before the dial
timeout 300 node scripts/verify-voice.mjs --leg nokey     # no key: one plain sentence
timeout 300 node scripts/verify-voice.mjs --leg caps      # a spent day: a refusal in words
timeout 300 node scripts/verify-voice.mjs --leg origin    # a cross-origin upgrade: refused in words
timeout 300 node scripts/verify-voice.mjs --leg refused    # a vendor that says 401, and one that is not there
timeout 300 node scripts/verify-voice.mjs --leg browser   # real Chrome, a WAV as the microphone
```

One leg per run: the live legs hold the host's one active agent, and every gate here fits a 300 second
ceiling.

**A refusal is never a dead socket.** Measured on this Mac 2026-09-09: an unknown upgrade path on this
relay answers zero bytes with no status line at all, cookie or not, and real Chrome reports only an
error event at 16 ms with no close code — indistinguishable from the relay being down. So every
refusal, for any reason, is: accept the upgrade, send **one plain sentence**, say goodbye, close
cleanly. Five of the legs above exist to hold that line.

**A vendor that will not take the call is one of those refusals, and it was silence until 2026-09-10.**
Measured on this Mac (node v22.23.1): a vendor answering 401 to the upgrade and an address with nothing
behind it produce the *same* single error event — "Received network error or non-101 status code" — with
no close event and no status code, and a black-holed address produces nothing at all for seconds. Before
the fix, a typo'd key left the orb listening, the microphone live, the ledger row open and the Spend line
counting until the thirty minute session cap. Now the dial is watched for eight seconds, the error path
closes the same way a close does, and the person reads one sentence. `--leg refused` holds both arms.

**There are no `.played` ranges to check, and that is a design decision rather than a missing test.**
Playback is Web Audio — the audio is decoded into buffers and scheduled off the socket's message
handler, because draining a player inline is what froze the reference implementation's entire event
loop, tool calls included, for the length of every spoken reply. There is no media element, so there
is no `.played`. The evidence instead is the audio clock advancing, an analyser hearing real energy
rather than a silent buffer, bytes actually queued, and the held-frame counts from both the page and
the server.

**No key is ever pasted by a gate.** The vendor in every leg is a stub that speaks the event shape.
Setting a key over ssh would be exactly the by-hand operation this product is being rebuilt to end;
the mechanism is the "Keys the product uses" block in the super admin console.

### What the gates actually measured, 2026-09-10

Every number names the machine it came off. Nothing below is a projection.

**On this Mac (MacBook-Pro.local, darwin arm64), against grok-bot-local-vm.** `npm test` 2395 of 2395
and `npm run source:typecheck` clean at the merged commit. All six legs green, one at a time: cp 38/38,
relay 7/7, nokey 14/14, caps 5/5, origin 4/4, browser 28/28. The browser leg is the whole path in real
Chrome with a WAV file as the microphone — 201 frames (964,800 bytes) of microphone audio reached the
vendor through the relay, one `call_id` was answered exactly once across the three surfaces it can
arrive on, a real reply came back off the box, 288,000 bytes played through Web Audio at an analyser
RMS of 0.18, and the microphone was held for 21 frames over 2,100 ms with **zero** frames reaching the
vendor inside that window.

The hop ledger from that run: the tool call reaches `sendPrompt` in **12 ms**, the first sentence goes
back **0 ms** after the entry is seen, and the wait in the middle — the team's own thinking, which is
reported and never asserted — was **22,418 ms**. That middle number is section 5's whole point.

**On the R750 (jason-PowerEdge-R750), through console.titanium.bot in real Chrome**, signed in as a
throwaway customer minted inside the control-plane container and deleted afterwards. Console ready in
511–634 ms. The talk button is on the composer. `GET /voice/settings` answers 200 with `apiKeySet:
false` and no `apiKey` field at all. The press puts the sentence on screen in **1,654–2,069 ms**, with
the control beside it that opens Settings; the orb goes off → thinking → off; no session opens
and no ledger row is written, and the operator's read says *not measured* rather than zero.

A cross-origin upgrade carrying a **real session cookie** and `Origin: https://evil.example` was
accepted (101, 952 bytes) and refused **in words**, closing cleanly — while the same raw client with
the console's own Origin got the no-key sentence instead. The Origin check works through Cloudflare,
and neither answer was a destroyed socket.

**A real spoken turn on the R750 is not measured**, and the reason is not a hole in the work: no
realtime key exists on any workspace there. See the paragraph above about ssh.

---

## 12. The sentences a person reads, word for word

Nothing below names a vendor, a model, a setting, a tool or a protocol. Every one of them is something
you can act on. **These are copied from the code, not written for the document** — `SENTENCE` in
`ui/voice-edge.mjs` and `NOTES` in `ui/machine-room/voice.js` — and `tests/machine-room-voice.test.mjs`
sweeps each one for sixteen leak patterns.

From the relay, on the socket it accepted:

- Talking not switched on for this workspace: **"Voice is not switched on for this workspace yet."**
  Jason's own words, and the same string the page carries so the two cannot drift. It names no key
  and no card, because after KEYS-1 a customer cannot act on either, and it deliberately does **not**
  end "press the button again" — that clause is what instructed the loop he got stuck in on
  2026-09-10, pressing Talk over and over into an identical refusal.
- Talking switched off by the workspace itself: **"Talking is switched off for this workspace. Turn it
  on in Settings."** This one a person *can* act on: it is the switch in Settings under General.
- An upgrade from somewhere else: **"That came from a page this console does not serve, so I did not
  open the microphone."**
- Nobody to talk to: **"There is no bot in this workspace to talk to yet."**
- The session cap: **"That is the time limit for one conversation. Press the button again to start a
  fresh one."**
- The day is spent: **"This workspace has used its voice time for today. It resets at midnight UTC."**
- The service would not start the call: **"The voice service would not start this call. Tell your
  operator if it keeps happening."** This is a vendor that accepted the line and then dropped it
  without a word. Naming a key here would be pointing a person at something only the operator holds.
- The line never opened at all, which a wrong key and an unreachable service both look like from here:
  **"The voice service did not answer. Try again in a moment, and tell your operator if it keeps
  happening."**
- Already talking in another tab: **"This workspace is already in a call. Stop that one and press the
  button again."**
- The line went away: **"The voice line dropped. Press the button again."**
- Could not start at all: **"I could not start a voice session just now. Try again in a moment."**

From the page, when the page is the one that knows:

- No microphone permission: **"This page has not been given the microphone yet. Allow it in your
  browser and press Talk again."**

**When both have something to say, the relay wins.** Measured on the R750 with no microphone permission
on a workspace with no key: the page used to take the relay's row and retitle it as a microphone
problem, so the sentence still said to add a key while the control that would let you do it
disappeared and the row named the wrong cause. The relay knows why the line did not open; the page only
knows about its own microphone, and once the line has already been refused that is the lesser fact.

Spoken back by the model, which is a different voice and a different job:

- Asked the same thing twice: **"I have already asked him twice about that. Say it again and I will
  take it to him fresh."**
- He did not answer in time: **"He has not come back in ... seconds. It is still in his conversation on
  screen."** — the number is the wait cap, 120 seconds by default.
- He stopped without answering: **"He stopped working without answering that one. Ask again and I will
  take it back to him."**
- Two things waiting at once: the relay names them and says it will not guess which.
- A held action that has already closed: **"that one already closed."**
