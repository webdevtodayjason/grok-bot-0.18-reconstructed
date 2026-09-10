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
- **Two ways to talk, and you choose which.** Hold the button while you speak and let go, or press
  once to start and press again to stop. Holding is the default. Section 13.
- **A panel over the conversation while you talk**, with your words appearing in it as you say them.
  When you stop, it dissolves and those words are the next line of the conversation. Section 13.
- There is no wake word and nothing is ever listening on its own.
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
- The day cap and the session cap are read per workspace, and only the operator can change one. Both
  are now **said on screen**: the Usage row in Settings reads *"4 of 30 minutes, up to 10 in one
  call"*, because the old Voice card carried the call ceiling on its usage line and the surface that
  replaced it said only the day pair, so nothing told a person a call has a maximum length at all
  (VOICE-8). `GET /voice/settings` already answered `sessionCapSeconds`; the module passes it on as
  `minutesCapPerCall`, and the caption omits it where a workspace has no per-call ceiling.
- A workspace that has spent its day is refused whichever key would have dialled.

So what is shared by this change is **the vendor's bill**, which the operator was always paying
anyway. What is not shared is any workspace's ability to spend past its own cap. If the caps were
not there, this change would be wrong; they are, and it is not.

### One key per service, and where it travels

The names are `keys.voice.xai` and `keys.voice.openai` — one per **service**, because the service is a
per-workspace choice and it decides which key dials. A workspace set to a service the operator has no
key for gets the plain refusal, never the other service's key aimed at the wrong vendor: that would
be a 401 a person reads as a broken product.

The relay reads them from `GET /v1/relay/keys` behind `CP_RELAY_TOKEN`, keeps them **in memory
only**, refreshes every **60 seconds** with a hard **6 second** timeout, and degrades to the last good
copy on an outage. Both numbers are shorter than the push credential reader's five minutes and ten
seconds, and the reason is that this one is woken by a person holding a button: a rotation that takes
five minutes to reach the relay is five minutes of a dial refused on a key the operator has already
replaced, and a ten second timeout on the upgrade path is ten seconds of a lit Talk button with
nothing said. Six seconds is thirty times the 194 ms relay-to-control-plane round trip measured on the
R750 on 2026-09-10, so it fires on an outage and never on a slow answer. It sends the
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

**Cannot see is not the same as not set.** The reader answers `blind` when there *is* a control plane,
a read has been attempted, the last one did not get through, and nothing is cached from one that did.
On that condition the press answers *"I could not start a voice session just now. Try again in a
moment."* rather than the no-key sentence — because the no-key sentence sends the operator to paste a
key, and if he has already pasted one and this relay simply cannot reach the control plane for a
minute, that sends him to do a thing he has done already over a fault that clears itself. A console
with no control plane is never blind (there is nothing there to be unable to reach), a control plane
that answers with no key at all is never blind (an empty answer is an answer), and a control plane too
old to have the route is never blind either (its files are the right home, and its mail sends
perfectly).

### Three places it still deliberately does not go

- **Not the super-admin Providers panel.** Those keys are global to the whole install, they live at
  the metering proxy as credentials, they read back masked, and that file's own rules forbid a key
  value in any answer with a test that plants one and sweeps every route for it. The realtime key is
  now global too, but it is not a *chat* credential and has no row there. The panel used to carry two
  cosmetic realtime cards; they are **deleted** — see section 10 for what pasting a key on one really
  did.
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
| Your own words, live | `conversation.item.input_audio_transcription.updated`: the **cumulative** transcript so far, which may correct itself and is explicitly **not** a delta; only when the transcription model is `grok-transcribe` | `conversation.item.input_audio_transcription.delta`: **newly available** text, which later deltas may revise |
| Turn-taking controls | turn detection only | also `turn_detection.interrupt_response` |
| Budget telemetry | **none at all** | `rate_limits.updated` every turn |

Two consequences worth spelling out:

- **What you said is normalised to replace-the-whole-line** before it reaches the page. On one vendor
  the transcript is cumulative with corrections, so appending each update writes the sentence over
  and over.
- **Both services send your words while you are still speaking**, which is what the panel in section
  13 is built out of, and their own documentation is where that is read from rather than measured
  here: xAI emits a cumulative, self-correcting transcript and says it is for live captions (its
  voice reference, page dated 2026-08-04, read 2026-09-10), and it only does so when the input
  transcription model is set, which this bridge already sets. OpenAI emits deltas of newly available
  text that later deltas may revise, inside an ordinary speech-to-speech session, and tells you to
  reconcile finals on the item id because their order between turns is not guaranteed (its realtime
  transcription and conversation guides, read 2026-09-10). **Neither has been observed on a live
  call from this product**, because no realtime key exists on any workspace to observe one with. The
  panel is measured against the stub that speaks both event shapes.
- **On xAI, holding the microphone shut is the only defence** against your team hearing itself. The
  other vendor has a switch for it; xAI documents no equivalent. Section 8.

**Both services do send your words as you speak them**, and both are asked for them in the session
frame this relay writes. The two shapes are genuinely different and the row above is the difference,
read from each vendor's own reference on 2026-09-10:

- xAI, `https://docs.x.ai/developers/rest-api-reference/inference/voice.md` (page dated 2026-08-04):
  "Emitted as the user speaks, providing the cumulative transcript so far before the final `completed`
  event. Note that this is the cumulative transcript which may have corrections to previous updated
  transcripts — this is different from a transcript delta." It arrives **only** when
  `audio.input.transcription.model` is `grok-transcribe`, which `ui/voice-edge.mjs` already sets.
- OpenAI, `https://developers.openai.com/api/docs/guides/realtime-transcription`: the `.delta` carries
  "newly available transcript text", and its own checklist says to decide "how your UI should revise
  partial text when later deltas correct earlier text" and to "use `item_id` to order and reconcile
  final transcripts". Ordering between two turns' completion events is explicitly not guaranteed. It
  streams inside an ordinary speech-to-speech session, not only a transcription-only one.

**Neither has been observed on a live key.** No workspace on this product has a realtime key to
measure with (VOICE-1's shipped R750 result is the no-key sentence, and VOICE-2 is the row for
fixing that), so both rows above are read from the vendors' documentation and everything below is
measured against the stub provider in `tests/helpers/stub-realtime.mjs`, which speaks both shapes.

`REALTIME_VENDORS` in `cp/voice.mjs` is the authoritative table: the wire shape, the address, the
default model, the voices and the published price with the date it was read. The CLI, the operator's
own settings and this document all name those rows.

### What the page is told while you are talking (VOICE-7)

Your words appear in a panel over the conversation while you speak, and when you stop it dissolves
and those words are the next line in the chat. That needs the page to know which words are still
being revised, which are finished, and which ones actually went to your team lead — three different
things that travelled on one indistinguishable frame until 2026-09-10. The relay now says which:

| frame | when | carries |
|---|---|---|
| `hear-begin` | you started talking | `turn`, `itemId` |
| `hear` | the words so far, replacing what was there | `turn`, `itemId`, `text`, `final` |
| `heard-confirmed` | your words went into your team lead's conversation | `turn`, `text`, `nonce`, `landed` |
| `hear-end` | this turn is over | `turn`, `reason` |

**`heard-confirmed` is the one that becomes the chat line, and it is not the same string as the last
`hear`.** What you watch being built is the transcription model's output. What lands in the
conversation is the realtime model's own tool argument, which is a second model reading the same
audio. So the panel's last paint is the confirmed text, and the `nonce` on it is the same
`voice:` nonce the durable entry is stamped with — which is what already draws the **Spoken** chip on
that row, so the page can tie the panel to the line it turns into rather than drawing a line of its
own.

**It is sent when your box takes the words, not when your team lead answers.** That is 6 to 14
milliseconds rather than 5.5 to 25 seconds, and a panel that waited for the answer would sit over the
conversation for the whole of his thinking time.

`hear-end` always arrives, including on the turns that never become a line at all, because a panel
waiting for a line that is not coming stays on screen forever:

| reason | what happened |
|---|---|
| `sent` | your words went in, and the line is on its way |
| `answered-card` | a spoken yes or no closed something waiting on you, which is an answer and not a message |
| `empty` | nothing intelligible came through |
| `not-accepted` | your box would not take it, so no line will ever appear |
| `no-words` | the transcription failed |
| `no-answer` | the model answered without asking your team lead, which the instructions forbid but cannot prevent |
| `line-closed` | the call ended with words still on screen |

**A turn is closed by name, and so is a late transcript.** Two utterances are in flight at once on
every ordinary call in always-listening: your team lead takes 5.5 to 25 seconds to answer the last
one, and you start the next one inside that window. Each `hear-end` therefore names the turn it
closes, and a close aimed at a turn that is no longer the open one is dropped — before that, utterance
one's confirmation dissolved utterance two's panel mid-sentence and every later word of it was thrown
away as belonging to a closed turn. The same goes for the words themselves: neither service orders its
"transcription completed" events between items (OpenAI says so in its own documentation), so the
sentence before last can arrive after this one's panel is up. Each of those events names its item, and
one naming the item the relay has moved on from is dropped rather than painted as this turn's settled
words. The page keeps the same guard on its own side.

Two more rules the panel depends on. **Nothing is painted while your team lead is speaking**: the
words the microphone picks up then are his own coming back through the speaker (section 8 has the
measured case), so the relay drops them for as long as the microphone is held shut, and the orb on
the button is the only sign while he talks. And **a new utterance starts empty**: the words are
cleared when speech starts and when a transcription fails, not only when one completes. Before
2026-09-10 an utterance whose completion never arrived bled into the next one — measured on this Mac
(node v22.23.1): "open the box" then "what time is it" read `open the boxwhat time is it`. A one-line
strip beside the box hid that. A panel over the conversation does not.

The older `heard` frame is still sent, unchanged, beside all of these, so a page loaded before a
relay restart keeps working for the rest of the call.

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

## 10. The two realtime cards on the Providers panel are GONE

They used to be there as labels: `xai-realtime` and `openai-realtime`, offering no model, holding no
key, minting nothing at the metering proxy, feeding nothing the relay reads. The idea was that the one
panel an operator goes to should not look like it has never heard of realtime.

**Jason measured what that actually cost, on 2026-09-10 at 07:49, in the live admin console.** He
pasted a real xAI realtime key on the "xAI realtime (voice)" row and read back:

```
xai-realtime     409  xAI realtime (voice) would not accept that key, so nothing was stored.
                      xAI realtime (voice) could not be reached (fetch failed)
```

Nothing was stored and nothing leaked, which was the part the old tests checked. What they did not
check is that the one person who holds the key had been sent to a control that can never succeed and
then told the vendor was down. That is worse than a cosmetic row: it is a wrong diagnosis printed in
the operator's own console.

The panel proves a key before storing it by fetching that row's catalog over HTTP. A realtime address
is a websocket, so with `catalogPath` empty the proof falls through to POSTing `wss://` — hence "fetch
failed". Both rows are **deleted** (PROVIDERS-10, closing VOICE-4), `tests/cp-voice.test.mjs` asserts
they are gone *and* that no row on that panel carries a `wss://` address or the word `realtime`, and
the panel carries one line saying where the key does go: the **"Keys the product uses"** block on the
same console's System health panel — section 2 — which proves an xAI key against
`https://api.x.ai/v1/models` and an OpenAI key against `https://api.openai.com/v1/models`. The same
key serves chat and realtime at both vendors.

`REALTIME_VENDORS` in `cp/voice.mjs` is, and always was, the authoritative table of what this product
can talk to. It is untouched.

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
timeout 300 node scripts/verify-voice.mjs --leg frames    # the words, labelled, at both viewports
timeout 300 node scripts/verify-voice.mjs --leg overlay   # the panel and the two talk modes, two sizes
node --test tests/voice-transcription.test.mjs           # the words at the socket, including the
                                                        # turns that never become a line
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

**The words of a spoken turn, this Mac (MacBook-Pro.local, darwin arm64), against grok-bot-local-vm
through a relay on loopback, 2026-09-10.** `--leg frames` **34 of 34**, run twice at two viewports in
real Chrome with a WAV file as the microphone, reading the frames off the **page's own** voice socket
rather than the relay's side of it. At **1440x900** and again at **390x844 with touch**, identically:
25 frames on that socket per turn, of which **4 partials whose text grew** (`what` → `what is the teen`
→ `what is the team` → `what is the team working on`, so the vendor's correction **replaced** the wrong
word instead of being appended to it), **1** frame saying the words were finished
(`What is the team working on?`), and **1** confirmation carrying the exact bytes that went into the
conversation plus the `voice:` nonce the durable row is stamped with. The confirmation arrived **before**
the dissolve, so it is the panel's last paint, and the row it became reads
`You · What is the team working on? · Spoken` — the same bytes on screen. An utterance the model made
nothing of closed its turn with the reason `empty` and confirmed nothing. The older `heard` frame went
out 6 times per turn, unchanged. `--leg browser` re-run at the same commit: still **28 of 28**, with the
tool call reaching `sendPrompt` in **9 ms** and the team's own thinking at **12,638 ms**.

The held-card yes, the third turn that never becomes a line, is measured at the socket instead
(`tests/voice-transcription.test.mjs`, 15 of 15 on this Mac): a real pending approval cannot be
manufactured on the shared local box inside the gate's 300 second ceiling.

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
- Talking switched off by the workspace itself: **"Talking is switched off in Settings."** This one a
  person *can* act on, and the sentence names exactly where: the switch in Settings under General.
- An upgrade from somewhere else: **"That came from a page this console does not serve, so I did not
  open the microphone."**
- Nobody to talk to: **"There is no bot in this workspace to talk to yet."**
- The session cap: **"That is the time limit for one conversation. Press the button again to start a
  fresh one."**
- The day is spent: **"This workspace has used its voice time for today. It resets at midnight UTC."**
- The call would not start, however it failed: **"Talking is not working right now. Your operator can
  see why."** ONE sentence covers the vendor refusing the line and the line never opening at all,
  because this edge genuinely cannot tell them apart — MEASURED on a Mac (node v22.23.1): a vendor
  answering 401 to the upgrade and a vendor with nothing listening produce the same single error
  event, no close and no status code. Two sentences would be the relay guessing which in front of a
  customer. And there is nothing a customer could act on either way after KEYS-1: the key and the
  choice of vendor are both the operator's. The operator's own diagnosis is not lost — it is in the
  relay log and in the ledger row's `closeReason`, which is where an operator looks.
- The relay could not read the keys the product uses: **"I could not start a voice session just now.
  Try again in a moment."** Not the no-key sentence, which would send the operator to paste a key he
  has already pasted over a fault that clears itself. See §2 on `blind`.
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

---

## 13. The panel over the conversation, and the two ways to talk (VOICE-7)

Jason, 2026-09-10: *"If we are showing what is being captured, a more elegant solution would be to
have a semi-transparent modal over the current chat window where that is being built out. We see the
words being created, and when it's done, that just becomes the next line ... Also the talk button
should be either: press it and it's on, so it's a toggle, on or off; or press and hold to talk and
let go. That should be a setting for the user."*

### What you see

While you are speaking, a panel floats over the conversation: a small orb that is plainly listening,
and your words appearing in it as you say them, each update replacing the last rather than adding to
it. When you stop, the panel dissolves and those words are the next line of the conversation, from
you, marked as spoken, exactly where a typed message would be. Your team lead answers underneath it
the way he always did, and while he is speaking there is no panel at all: the orb on the button is
the only sign.

There is no title on it, no icon, no close control and no border that looks like a dialog. It is
something to read while you talk, not something to dismiss, and the conversation underneath stays
clickable the whole time. That is deliberate: a machine-looking sheet over somebody's chat gets read
as something going wrong.

**Nothing in the footer changes size on an ordinary turn — yours or his.** Two separate reasons, and
both are measured rather than argued. The panel is a child of the conversation area, not of the row the
message box lives in, so there is no arrangement of it that could make the footer grow; the caption
strip it replaces was inserted next to the message box and therefore became part of that row's grid,
which is exactly why the footer used to get taller (VOICE-6). And **his reply is not written into the
footer at all.** It was, until the adversarial pass on this wave: the same one-line node carried it,
which meant the footer moved on *every* turn rather than only on a refused one — measured on this Mac
in real Chrome, `#message-input` 370.05 to 215.31 px at 1440x900 and `.control-shelf` 390x133 at y711
to 390x158 at y686 on a phone, standing there for the rest of the call because only starting or ending
a call ever cleared it. His reply is already a row in the conversation and is already read out loud, so
a third copy of it in the footer bought nothing and cost the one measurement this surface makes.

The one thing that still reaches that line is a **refusal** — talking not switched on, no key, a cap
spent, a microphone you did not allow. That is rare, it is the whole point of the line, and what it
costs is measured in VOICE-6: a slice of the message box's own spare width at 1440x900, one row of the
shelf on a phone, and it takes itself away after six seconds.

**The last words you read are the words that become the line.** Those two are not the same thing by
accident. What you watch being built comes from a transcription model; what actually reaches your
team lead comes from the realtime model's own tool call, and they are two models producing two
strings. So the panel's final paint is the second one — the bytes that were sent — and the gate
compares it, character for character, against the row that lands.

**Three turns produce no line, and the panel still goes.** A yes or no that closes an approval goes
through that approval and never becomes prose; an utterance nothing was heard in produces nothing;
and a transcription that gives up produces nothing. Each of those now says on the wire that no line
is coming, so the panel ends the turn instead of waiting for a row that will never arrive. A turn
that simply stops mid-way — a service that goes quiet without ever closing the turn — takes the panel
away after two minutes, which is the same ceiling the relay itself puts on waiting for one turn. It
used to be eight seconds, armed from the moment you started talking and put back only by a word
arriving: on a service that streams no live words at all (section 3), nothing put it back, so the panel
vanished eight seconds into a sentence and the words that turn produced could then never be shown.
They are now, even on a turn the ceiling took away: the confirmed words re-open the panel for that one
last paint, so the last thing you read is still the line you are about to see.

### The two ways to talk

In **Settings**, under **General** in the **System** group, beside Microphone and the talking
switch, one row, **Talk mode**:

| | what it does |
|---|---|
| **Push to talk** (the default) | Hold the button while you speak and let go. Or hold the space bar, when the message box is empty. |
| **Always listening** | Press once to start and press again to stop. Escape stops it too. |

**Push to talk is the default** because it is the one that cannot leave a microphone open by
accident.

Holding: the microphone opens on the press — before the line has finished opening, with the first
couple of seconds held and sent the moment it does, because the line takes one and a half to two
seconds to open through the console and the first words of a first hold would otherwise be lost every
time. On the release the microphone shuts. **The line itself stays up for a minute**, so the next
hold is instant rather than paying that wait again, and then it closes itself — the time limits count
wall clock rather than audio, so a press somebody walked away from would otherwise spend half an hour
of a two hour day with nobody in the room. Between holds the orb is dark, because an orb that says
listening while the microphone is shut is a lie.

Always listening: the microphone is open from the press to the next press and the service's own
turn-taking decides where one utterance ends and the next begins. The orb shows listening between
turns.

**In both modes the microphone is still held shut while your team is speaking**, plus the third of a
second in section 8. Nothing here weakens that, and the panel cannot open while he is talking either
— if that gate ever slipped, the panel would draw his own words coming back through your speakers as
though you had said them.

**The release does not itself end the turn; the silence after it does.** The service's own turn
detection is what decides an utterance is over, about seven tenths of a second after you stop making
noise, in both modes. The vendors document a tighter way — turn detection switched off and a manual
commit on release — and it is refused here, because it needs the session frame rewritten per mode and
this bridge writes that frame exactly once and byte-identically for the life of the socket. Rewriting
it re-bills the whole conversation every turn on one of the two services (section 7).

**Changing the mode ends the call you are in.** A live microphone whose control has just changed
meaning underneath you is a state nobody on screen can account for.

### The space bar, and what it is not allowed to interrupt

Holding the space bar is push-to-talk on a keyboard, and only when nothing else wants that key: not
while any field, box or dropdown has the focus, not while something is being edited in place, not
while a dialog or a drawer is open, not while the box's own screen has the keyboard (everything typed
there is meant for the machine on the other side), and not while there is a half-typed message in the
message box. A held key repeats, so the first press latches and every repeat until the release is
ignored. A window that loses focus never delivers the release, so losing focus is treated as one.

On a phone the button is a 44 px circle — the floor this console holds every control beside it to, and
what the gate enforces — and a press and hold on one of those is a long-press menu, a text selection
and a drag unless all three are turned off on that one control. They are, and the gate holds a real
touch on it rather than tapping.

**One thumb is one press.** A phone sends both a pointer event and a touch event for a single press and
both reach the button, which is fine for an ordinary hold and was not fine with a refusal standing: the
first of the two cleared the sentence and the second, finding none, dialled straight back into the same
refusal — the loop VOICE-6 was filed for, reappearing through the second event of one gesture. Measured
at 390x844 with a real touch hold. A press that clears a sentence is now spent for the rest of that
gesture, and the release ends it, so the next press opens a line normally.

**Escape has the same rule, and one thing it cannot do anything about.** A drawer or a dialog that is
open takes Escape first, which is right, and the call is still there afterwards. But when the box's
own screen has the keyboard, nothing typed reaches the console at all: the screen is a frame and the
browser hands every keystroke to the machine on the other side. Measured while building this: after a
scroll that put the focus in that frame, Escape never arrived. There is no fix for that and none is
wanted — the way out then is the button, which is always on the screen.

### Where the choice is stored, and the one thing about it that is not finished

**It is yours, not your workspace's, and today that means it is per browser.** Everything else about
talking is written to one settings file per workspace; two people sharing a workspace would then fight
over how their own button behaves, so this one row deliberately never goes through that door. No
request body in the page carries it. What holds it instead is this browser — the same place the
settings surface keeps Theme and the microphone choice, which are the two rows either side of it — so
it does not follow you to your phone and it is gone if you clear site data. It falls back to holding
when there is nothing stored, in a private window, and in a browser set to refuse site data.

**Per browser is not per person, and that is the unfinished part.** A person who sets always-listening
on their laptop gets holding again on their phone. The only per-person door on this product today is
the one Notifications uses; moving this row onto it is **filed as VOICE-10 in docs/GAP-ANALYSIS.md**,
with an owner, the cost and the proof step, rather than explained here and left to be discovered on a
second device.

The page keeps its own copy whatever happens to that, because the button is live the moment the
console paints, before any route has answered, and it has to know which of the two things it is before
the first press. The settings row reaches it through one door, `setTalkMode`, and that door is also
what ends the call you are in when you change the mode — the alternative is a live microphone whose
control has changed meaning underneath you.

The desktop app's global hotkey is a later wave. It presses this same control through the same pair of
entry points, so it inherits whichever mode is set rather than being a third behaviour to keep in
step.

### What was measured, and where

**On this Mac (MacBook-Pro.local, darwin arm64), 2026-09-10**, in headless Chrome through
playwright-core against grok-bot-local-vm, user agent `titanbot-gate/verify-voice.mjs`.
Two legs, run one at a time. `--leg overlay` drives the panel and the two modes in four
combinations — each viewport in each mode, with a real touch hold on the phone rather than a tap —
and measures the footer's rects before, during and after every turn. `--leg frames` reads the
labelled frames off the page's own voice socket at both viewports and proves the confirmed bytes and
the durable row are the same string. The line opened in tens to hundreds of milliseconds; the words
changed between reads rather than merely being present; and the spoken row landed exactly once per
turn carrying text byte-identical to the panel's last words, under a `voice:<session>:<n>` id.

One thing those legs had to work around, and it is **not** this wave's: at 390x844 the console hides
the gear on the shelf outright, and that gear is the only thing in the console a person can press to
open Settings. So on a phone there is no visible way into Settings at all — not to this row, not to
Inference, not to anything else on that surface. The legs open it by naming the section instead, and
each one reports which route a person really had at that width. Filed as CONSOLE-PHONE-SETTINGS-1 with
its owner and its proof; every settings card has been unreachable that way since voice first shipped.

**The rects below are read before the press, while the words are being built, after the turn ends, and
with the agent's reply up** — that last one is the state the first run of this leg never saw, because it
took its "after" reading within milliseconds of the tool call and the reply lands 5 to 25 seconds later.

| | 1440x900 | 390x844 |
|---|---|---|
| the footer, before / during / after a turn, and with his reply up | 1392x106 at y776, unchanged | 390x133 at y711, unchanged |
| the composer | 600x54 at 459,802, never moved | 358x56 at 16,778, never moved |
| the message box | 370.05 px wide, never narrowed | 177 px wide, never narrowed |
| the talk button | 74x38 at 881,810, never moved | 44x44 at 245,784, never moved |
| the panel | 544x64, centred over the conversation | 350x57 |
| the footer's own line, with his reply up | away, empty | away, empty |

`--leg overlay` **136 of 136** and `--leg nokey` **51 of 51** on that machine, each run on its own.

The numbers this replaces, measured the same way on the same machine: with the caption strip up, the
footer went to 1392x160 and then 1392x178 at 1440x900 while the message box narrowed to 568 px, and
to 390x199 and then 390x255 at 390x844. And with his reply in the footer's one line, which is where
this wave first shipped it: `#message-input` 370.05 to 215.31 px at 1440x900, and the shelf 390x133 at
y711 to 390x158 at y686 on a phone, for the rest of the call.

**On the production server, through console.titanium.bot, 2026-09-10**, as a throwaway customer on
the demo tenant, minted inside the control plane's own container and removed afterwards.
`scripts/verify-voice-r750.mjs`, **42 of 42**, at both sizes.

| | 1440x900 | 390x844 with a real touch hold |
|---|---|---|
| the panel | on the page, over the conversation, outside the footer | the same |
| the Talk mode row | on screen under General, 359 px wide | on screen, 329 px wide |
| the row's round trip | takes, and survives a reload of the console | the same |
| the hold | holds the microphone, and the button fills | holds, through a real touch and not a tap |
| the footer, with nothing standing | 1392x106 at y776, composer 600x54, button 74x38, unmoved | 390x133 at y711, composer 358x56, button 44x44, unmoved |

**Re-measured on the production server after the adversarial pass, 2026-09-10**, same method, a fresh
throwaway customer on the demo tenant minted inside the control plane's own container and removed
afterwards (throwaway accounts left behind: 0). `scripts/verify-voice-r750.mjs`, **48 of 48** (42
before; the six new ones are the agent's reply, measured at both sizes).

| | 1440x900 | 390x844 with a real touch hold |
|---|---|---|
| the footer with his reply up | shelf 1392x106 at 24,776, unchanged | shelf 390x133 at 0,711, unchanged |
| the message box with his reply up | 370.05 px, unchanged | 176.98 px, unchanged |
| the footer's line with his reply up | away, no words | away, no words |
| the panel while he speaks | not on screen; the orb is the only sign | the same |
| the talk button | 74x38 | 44x44 at 245,784, and a press at its middle really lands on it |

Still not measured, and for the same reason: a real spoken turn. The talking door for that customer
answered `{"status":200,"enabled":false,"available":false,"apiKeySet":false}`, so the line a hold opens
is refused a few hundred milliseconds later and every transcript event in every gate came from the stub.

**What that run could not show, and why.** The demo tenant has talking switched off and the operator
has pasted no realtime key, so the line a hold opens is refused a few hundred milliseconds later. The
hold itself is visible in that window — measured: held, the line opening, the orb reading as working at
40 ms and 120 ms, then the refusal and one plain sentence by 250 ms — and the refusal is correct
behaviour, not a defect. Whether a held line carries audio, and what the panel paints while somebody is
speaking, is measured against the stub on the local box.

One thing that run surfaced and it belongs to VOICE-6 rather than here: on a phone, one plain sentence
takes a row of the control shelf, 133 to 189 px, with the composer and the button not moving. That is
that wave's own shipped line and its own measured number on the same server. The panel was not on
screen at that moment. The panel itself cannot move the footer at any width, because it is not in that
box at all.

**Not measured:** a real spoken turn, on any machine. There is no realtime key on this Mac, and the
production server's operator keys door answers an empty set, so every transcript event in every gate
came from the stub that speaks both services' event shapes. What the two services do on a live call is
read from their documentation above and is marked as such.
