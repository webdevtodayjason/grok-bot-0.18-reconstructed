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
same console's **Keys** panel — section 2; it was appended to System health until KEYS-2 gave it its
own rail entry — which proves an xAI key against
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
timeout 300 node scripts/verify-voice.mjs --leg release   # the release, in two engines, counted at the vendor
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

**The release does not itself end the turn; the silence after it does, and since VOICE-11 the release
sends that silence.** See the section below, which is the whole of it. The service's own turn
detection is what decides an utterance is over, about seven tenths of a second after you stop making
noise, in both modes. The vendors document a tighter way — turn detection switched off and a manual
commit on release — and it is refused here, because it needs the session frame rewritten per mode and
this bridge writes that frame exactly once and byte-identically for the life of the socket. Rewriting
it re-bills the whole conversation every turn on one of the two services (section 7).

**Changing the mode ends the call you are in.** A live microphone whose control has just changed
meaning underneath you is a state nobody on screen can account for.

### What the release does, and what it used to do (VOICE-11)

**It used to do nothing.** Letting go shut the microphone and put not one byte on the wire, and the
only thing that ends a turn is the service's own turn detection — which is configured to call a turn
over after seven tenths of a second of silence, and which fires on **audio that keeps arriving**,
never on a wire that went quiet. So the words were said and nobody ever told the service the person
had stopped saying them.

**Measured on grok-bot-local-vm in Chromium and WebKit at 1440x900 and 390x844, before the fix:** a
900 ms hold and a release put **0 bytes and 0 JSON on the wire for the next 1.5 seconds**, while 15
captured frames were dropped by the page's own mute. At the 1.8 second dial `console.titanium.bot`
really has, a **tap** was worse: zero frames reached anybody and a whole line was opened anyway, and
it then sat there for its idle minute with nothing said into it.

**What it does now.** The release sends the silence a person really makes when they stop talking:
**eight 100 ms frames of zeroes, paced one per 100 ms**, which is 800 ms of quiet against the
service's 700 ms window. They go down the same door the microphone's own frames go down, so at a line
that is still opening they queue behind the words and arrive after them rather than ending a turn
that has not started. A new hold, a hang-up or a dropped line cancels whatever is left of one.

**A tap is not a hold.** A release before the first frame has gone keeps the microphone open until one
has gone or 300 ms have passed, whichever comes first. If nothing ever went, the line reads **"Hold
the button while you talk."** and no silence is sent, because there is nothing for it to end.

**A hold whose release never arrives closes itself after thirty seconds.** Six things end a hold and a
phone that backgrounds the tab mid-press delivers none of them; before this, nothing but a release
ever closed that microphone. Thirty seconds is already far longer than one utterance, so past it the
likely truth is a release that was lost. It ends the hold the ordinary way, so the words that were
said still become a turn and the line stays warm for the next press.

**And the press after a refusal now re-arms.** A sentence on screen makes the first press a "clear it"
press, which is the loop VOICE-6 was filed for; that was unconditional, so every start while a
sentence was up cost two presses with nothing on screen to say the first had been spent. A sentence
younger than a second and a half is still only cleared — that is what keeps the second event of one
thumb, and a reflex re-press, out of a refusal that has not changed. Older than that, one press clears
it and dials.

#### What the tail costs

| per hold | |
|---|---|
| frames | **8** |
| bytes | **38.4 KB** (8 × 4,800) |
| audio on the ledger | **0.8 s** |

The caps count wall seconds and the vendor bills audio seconds, so the 0.8 s is what the ledger sees:
**0.011% of a 7,200 second day per hold**, and about a tenth of a penny at the flat per-minute rate in
section 7. It is the price of a turn ever ending.

#### What was measured, and where

**MEASURED on MacBook-Pro.local (darwin arm64) 2026-09-11, `verify-voice --leg release`: 45 of 45,**
in real Chromium at 1440x900 and real WebKit at 390x844 with touch, against a relay on loopback and a
stub vendor, run once at the merged tip.

| | Chromium 1440x900 | WebKit 390x844 |
|---|---|---|
| the hold's own frames at the vendor | 11 in 1.2 s | 11 in 1.2 s |
| silence standing at the moment of the release | 0 | 0 |
| the release's frames at the vendor | **8, in 725 ms** | **8, in 727 ms** |
| what the page says it sent | `tailFrames` 8 | `tailFrames` 8 |
| silent frames at the end of the stream | 8 of 19 | 8 of 323 |
| a hold with no release | closed at 30,000 ms | closed at 30,000 ms |

**The eight frames are counted at the stub vendor, not on the page.** The page's own `tailFrames` is
asserted beside them, but a number a page reports about itself is not evidence that anything left it:
the stub counts all-zero `input_audio_buffer.append` frames arriving at the end of the stream, and the
leg asserts first that the microphone was still making sound at the moment of the release, so what
follows it can only be the release's own. The first run of that leg proved why: with a three second
microphone file that had run out, four frames of silence had already reached the vendor before the
release and the tail could not be told from the room.

**Two engines, and that is the point rather than a nicety.** The same root cause is why voice does
nothing in the iPhone app, which is a web view over `console.titanium.bot`: WebKit births an audio
context **suspended** and only a person's own press resumes one, and the press is spent by the first
`await` in the handler. The capture context is made and resumed inside the press now, before the
microphone is asked for, with nothing awaited above that ask. What the shell still has to do for
itself — the permission, the audio session, the origin, and the one line it injects — is
`docs/APPS.md` § 8b.

**The three ways a microphone can refuse now read three different sentences.** One sentence used to
serve all of them, and it told a device with no microphone at all to allow one:

- refused permission: **"This page has not been given the microphone yet. Allow it in your browser and press Talk again."**
- no device: **"No microphone was found on this device. Connect one and press Talk again."**
- a browser that cannot record: **"This browser cannot record sound, so there is no way to talk to your team in it."**

In the app the first of those names the app's own permission instead — **"This app has not been given
the microphone yet. Allow it in iPhone Settings and press Talk again."** — and it is the shell saying
which host it is, on `window.__titanbotShell`, never a user agent being sniffed. There is a fourth for
a microphone that opened and produces nothing at all, which is a live button over a dead device and
the worst of the four because nothing on screen looks wrong: **"The microphone is open but no sound is
reaching this page. Pick a different one in Settings and press Talk again."**

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
scroll that put the focus in that frame, Escape never arrived.

Half of that is now fixed and half of it is still true on purpose. Since SEAT-FOCUS-1 a picture nobody
can click no longer holds the keyboard: the small screens the console keeps reading in the background are
handed the keyboard back the moment they take it, so Escape leaves talk mode and the space bar talks while
those are on the page. The screen a person opened themselves still keeps what they put in it, because that
is the pane they are typing into, and the way out then is the button, which is always on the screen. The
rule and its measurement are in `docs/CONSOLE.md`.

### Where the choice is stored: the person, with this browser as the fallback (VOICE-10)

**It is yours, not your workspace's, and since VOICE-10 that means it follows you.** Choose always
listening on your laptop and the console on your phone opens on always listening, signed in as you.

It is kept on **this door** — `/voice/settings` — but not the way everything else on that door is kept.
Everything else there is one value per WORKSPACE; the talk mode is a map keyed on the session's own
person claim, the same key the device list and the notification settings use, so two accounts sharing a
workspace each keep their own and neither can read or move the other's. The route answers **the caller's
own entry and never the map**, and it **omits the field entirely** for somebody who has never chosen,
because a default arriving from a server is a choice nobody made written over a real one.

It is on this door rather than on the notifications door the row first named for a plain reason: that
door refuses the field by name — its field list is frozen to kinds, quiet hours and the offset — and
opening it was an edit to a file the wave that landed this did not own. The key is the same either way,
which is the part that matters.

**This browser's copy is still written, first, and it is the behaviour.** The button is live the moment
the console paints, long before any route has answered, and it has to know which of the two things it is
before the first press. So the page reads its own stored value first; the relay's answer arrives with the
settings read boot already makes and is adopted then. A relay that refuses, a relay that never answers,
a private window, a browser set to refuse site data: in every one of those the button does what was asked
of it and the only thing lost is that the choice does not travel. With nothing stored anywhere the answer
is **holding**, because a microphone that is open until you say otherwise is not a default.

**And an answer that was already in the air when you chose does not land at all.** The boot read of this
door and a press are two producers of one value, so the read carries the time it was asked at and an answer
older than this page's own choice is thrown away: nothing is stored, nothing is painted, and the door has
the newer value anyway because the press wrote it there. This is the same rule the settings surface holds
for its own rows (SETTINGS-3, `docs/SETTINGS.md`), one layer down, and it was found by measurement rather
than by reading: **MEASURED on MacBook-Pro.local, real Chrome, 2026-09-11, `verify-voice --leg overlay` at
1440x900 and 390x844** — both always-listening combinations came up in *holding* before the guard, with the
microphone shutting between presses and the Talk mode row reading *push to talk* while the door held always
listening. 4 of 137 checks before, **137 of 137** after. A unit case in `tests/machine-room-voice.test.mjs`
fails without it.

**An answer that lands never cuts a call in half.** The settings row reaches the value through one door,
`setTalkMode`, and that door ends the call you are in when the mode really changes — the alternative is a
live microphone whose control has changed meaning underneath you. A value arriving from the route goes
through a *different* door, because nobody pressed anything: a call that is up keeps the mode it was
opened under and the route's value is taken on the next load.

**MEASURED on grok-bot-local-vm (this Mac), real Chrome, 2026-09-10, `verify-voice --leg person`:** one
browser chooses always listening, its own storage holds it and `GET /voice/settings` answers it; a second
browser with nothing stored, signed in as the same person, is on always listening at first paint with no
press and no line opened, and the Talk mode row on it opens reading always listening; a third browser with
nothing stored and the settings door blocked outright opens on holding.

**The precondition on that second browser is read before any script runs** (fixed in review 2026-09-11).
The leg's own guard, *this browser really starts with nothing of its own*, used to read `localStorage`
after the page had booted, which raced the thing it was there to rule out: `probe()` fetches
`/voice/settings` and hands the answer to `adoptTalkMode`, which **writes** that key. On a busy Mac the
read landed after the write and the leg failed three runs out of three with nothing wrong with the
product. It is now captured in an `addInitScript` at document start, and the after-boot value is printed
beside it because what that one holds is the door's own write. **MEASURED on MacBook-Pro.local,
2026-09-11: 10 of 10 idle, and 10 of 10 on three consecutive runs at load average 9.7** with eight busy
processes on the machine, two of which read `always` from storage after boot, which is exactly the
reading the old check failed on.

**And MEASURED on the R750 2026-09-11 01:24 UTC** through `console.titanium.bot` as a throwaway customer
on the demo tenant, real headless Chromium at 1440x900, user agent `titanbot-gate/ship-customer-settings`:
one browser context chose always listening and its own storage and `GET /voice/settings` both read
`always`; a **second context signed in as the same person with nothing stored** opened reading *holding*
at first paint, reached always listening on the door's answer with **no line opened**, and its Talk mode
row then read always listening. Nothing threw in either context. That is the claim end to end on the live
console rather than on a local relay.

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

---

## 14. The call screen on the phone (VOICE-13)

Jason recorded ChatGPT's voice mode on his iPhone on 2026-09-10 and said **"this is what I want"**:
press Talk and a full-screen surface comes up over the chat, Titan large and alive in the middle,
hands free with no holding and no press per turn, a row at the bottom with somewhere to type, a mute
and a round X, one thin line when he is working, and End puts you back in the conversation with the
whole exchange in it.

That is what a press at phone width does now. A laptop keeps section 13's shape, the strip and the
words panel, unchanged.

### It is not a new talk mode

A phone call is always-listening with a different surface, and **the relay cannot tell the two
apart**: the session frame is written once and byte-identically for the life of a socket with server
turn detection at 700 ms of silence, and the only difference between push and always is the page's own
`muted()` callback. So this wave added **no frame, no field and no relay change**. `talkMode()` is not
touched either — Settings paints the Talk mode row from it, and a phone-shaped lie there would
contradict the person's stored choice (SETTINGS-3). On a phone that row governs their laptop, which is
a thing to say in a help line one day and not a reason to change the value.

### Which windows get one

`callWanted()` is a shell that names its own platform, **or** 690 px of width, **or** 500 px of
height, read live on every press and never cached. Both numbers are the console's own: 690 px is the
phone width four blocks of `styles.css` already use, and 500 px is the landscape-phone height the
sheet already has a block for — which is what keeps a call screen up when somebody turns the phone
mid-call.

`LINE_SHELF_WIDTH` stays 900 and answers a **different** question: "is there room in a 358 px composer
for a sentence" is not "is this a phone". A 740 px window gets the refusal line in the shelf and no
call screen, and `--leg overlay` measures exactly that width for exactly that reason.

`voice-call.css` carries **no breakpoint at all**. The module alone decides that the screen exists;
the sheet is driven by attributes and custom properties and sizes itself in `vw` and `min()`, so the
two cannot drift apart the way 690 and 900 already had.

### A refusal takes the screen away

This is the decision the wave turns on, and it is what makes opening the screen **optimistically**
safe at all. The screen is up in tens of milliseconds; the line takes 224 ms on loopback and 1.6 to
2.0 s through console.titanium.bot. Every refusal — no key, the day cap, a session cap, a box that is
not running, a dropped line — arrives through `stop()`, which is the call screen's one close funnel.
So the screen goes, and the sentence lands in its **one existing home** on the shelf's first row,
where the person is already looking.

The screen never carries a second copy of any refusal sentence. Two wordings for one condition drift;
one wording cannot. And there is no "press again" clause anywhere on it, because that clause is what
instructed the loop Jason was stuck in (VOICE-6). A press made while a refusal is standing **clears
the sentence** and opens nothing, exactly as a hold and a toggle already do, and VOICE-11's cooldown
is kept so a sentence somebody has had time to read is cleared **and** dialled by one press.

### Five words, and no sixth

| word | when |
|---|---|
| Connecting | the screen is up and the line is not yet |
| Listening | the line is open and nobody is talking yet, or the person is |
| Thinking | the person stopped and Titan is working |
| Talking | Titan is speaking (Jason's word, not the wire's) |
| Muted | the page's own fact, and it outranks the other four |

The brief names four. Connecting is the fifth because it is honest: Thinking before the line exists
would claim Titan is working on something nobody has said yet. The agent's reply is **never** drawn on
this screen: `footer-line-is-refusals-only.md`, and the measured defect behind that rule was
`#message-input` going 370.05 to 215.31 px at 1440x900.

### The avatar, and the one rule that shapes it

**Nothing in the mascot's ancestor chain is ever scaled.** The vendored kit sizes its canvas from
`host.getBoundingClientRect().width`, which is transform-aware, while the `ResizeObserver` it fires
from is not: with a scale on an ancestor and a resize landing, the kit read a 433.35 px host for a
390 px element and left Titan 5.6% vertically stretched for the rest of the call, and WebKit logged a
`ResizeObserver` error with it. So the two halo **siblings** take the transform and the opacity, and
the mascot takes opacity and a drop-shadow, neither of which changes the rect the kit measures. The
level is one custom property written once a frame on the screen, smoothed in JS because reduced motion
flattens every CSS transition to 1 ms globally.

Titan is `min(632px, 162vw)` wide, which is deliberate: his body is 0.422 of the canvas at every size
and **stops growing** where the canvas hits the kit's own 430 px height clamp — an element width of
632 px, giving 266.5 x 244 CSS px, 68% of a 390 px phone and the largest the shipped kit can draw. The
kit clamps its dpr at 2, so a real 3x iPhone screen upscales him 1.5x. His three moods are the kit's
own three and no others, because a fourth name **throws** a `RangeError`. Under
`prefers-reduced-motion` the screen draws the still PNG, runs no animation loop at all, and still
changes the still when the mood changes.

### How he morphs, and it is Titan's blob rather than an orb

Jason, on the avatar: *"We don't want ChatGPT's orb. We're going to have Titan's blob, the one already
on the homepage. That's what I want there, so it can react and act and morph."* So the middle of this
screen is the vendored kit's own `<titan-mascot>` — the same element the roster faces, the onboarding
face and the boot cover draw — and the level reaches **his body**, not just a ring around him.

Two mechanisms, both reading the kit rather than editing it. The kit is vendored byte for byte, its own
`ASSETS.md` forbids editing this copy, a test fails on drift, and the real change would move
titanium.bot's marketing site with it.

**1. The kit's own outline.** Read off its source: `strength` multiplies the three summed sine waves
and the swell that deform the 120-point superellipse contour — the silhouette's wobble *is* that
number — `speed` scales the clock those waves advance on, and `bob` the float. The only input to all
three is the mood, and its own frame loop eases toward the mood's triple at 0.035 a frame. So the
**level picks the mood**, with a hysteresis band, and Titan's body deforms more, and faster, the louder
the room is. calm is 0.8 strength, curious 1.3, excited 1.65. The mood is written only when it
changes: every write fires the kit's `attributeChangedCallback`, which dispatches a bubbling
`titan-statechange` on the document, and sixty of those a second would be this screen shouting at the
whole page.

**2. Squash and stretch, on the canvas inside the kit's own shadow root.** This is the seam that makes
per-frame deformation safe at all: `resize()` measures the **host**, and a child's transform does not
change its parent's layout box, so the kit's own measurement cannot see a transform on its canvas. The
canvas takes a volume-preserving squash from the level (7% across, 5.6% down), a slow breath at rest —
translateY -4px and 1.02 over 2600 ms, which is `boot.css`'s own `boot-sprite-breathe`, this console's
breathing vocabulary for Titan — and a degree of tilt on a slow sine so the **edge moves** rather than
the whole of him just inflating. The breath gets out of the way as soon as there is a voice to follow.
While he is thinking the breath is slower and deeper and the level is not read at all, which is on
purpose: a person should be able to hear that nothing is expected of them.

**The eye is the kit's own, and `tracking` stays off.** The kit's tracking follows a real pointer,
which a phone call does not have. With it off the eye keeps its own drift on two slow sines and its
5.6 second blink, which is the "tracking a little" that is true on a screen nobody is pointing at.

MEASURED in WebKit at 390x844 device scale 3 on MacBook-Pro.local, level driven 0 to 1:

| | measured |
|---|---|
| Titan's own body, across the row through its middle | **494 px of ink at rest, 437 with a voice on him**, in his own 1264x859 backing store |
| the kit's face | curious at rest, excited with a voice on him |
| the canvas transform | `translateY(-1.14px) rotate(0.36deg) scale(0.9935, 0.9911)` then `translateY(0px) rotate(1.11deg) scale(1.07, 0.944)` |
| the host element's own transform | `none` at both |
| the box the kit measures itself from | 631.8 x 429.61 at both, backing store 1264x859 at both, canvas CSS height 429.62px at both |
| six seconds of a live call with the morph running | **352 frames, 58.7 fps**, 3 over 20 ms, median 17 ms, against the same page with no call screen at 16 over 20 ms |

The two mechanisms are measured apart on purpose. The pixel count comes from `getImageData` on the
backing store, which is what the kit **drew** and is untouched by CSS, so it moves only when the kit's
own outline changes. The transform string is the squash on top of it. A ring pulsing around a still
Titan would have passed a halo check and failed his instruction.

**He is centred by margins and not by a transform.** A 632 px Titan on a 390 px phone is wider than
the screen, and laid out naively the grid track grows to fit him: MEASURED on the live server on the
first ship, his rect was 632x430 at x=16 — his left edge against the padding, and everything past
390 px clipped away, so half of him was off the phone. The two negative margins make his margin box
exactly the width of the face, so the track cannot grow, the surplus hangs off both sides evenly and
the screen's own overflow clips it. A transform would have done it too, and is deliberately not used:
every transform in that file is kept off the mascot and its ancestors on principle.

### The three things the recording had that the design did not

**A typed field.** A line typed on the call screen fills the console's own message box and submits the
composer, so the pin, the attachments and the adapter are all kept once rather than twice. **Its
answer is not spoken**, and that is a limit rather than a bug being hidden: the relay speaks a reply
because it is the side that handed the turn to the box, and a typed turn goes straight from this
console to the box with the relay not in it. The browser sends exactly three JSON shapes down the
voice socket and none of them carries text, so speaking a typed line would be a new wire frame. The
line and its answer are in the chat behind the screen, which is where a person looks when the call
ends.

**A status line.** The thin line under him while the word is Thinking is the chat's **own** tool
receipt — the adapter summarises a tool step into a system row, app.js draws it, and the screen reads
the newest one. A second source for that sentence would be a second wording to keep in step. Only a
row newer than the moment the call opened is ever shown: a receipt from this morning is not what Titan
is doing now.

**A card in the middle.** When a reply carries a card or a tool result, the card takes the middle and
Titan shrinks to a small orb above the bottom row, then grows back when the card is no longer the
newest thing. The shrink is a **width** change, which is safe for the same reason as above: nothing is
scaled, so the kit re-measures once and draws him smaller rather than stretched. The copy on the
screen has its **controls removed** — every card's buttons are wired against its row in the transcript
and carry its id, so the ones in the chat are the ones that work, and the copy is there to be read.

### Where it lives, and what it locks

A plain fixed div on `document.body` at `z-index: 80` — above the phone drawers at 70, below the toast
at 100, so a toast is still readable over a call. Not `.conversation-space`, whose layer measures
374x587 at 8,124 on a phone and covers the conversation only. Not a `<dialog>`, because the page
refuses to act on Escape while any `dialog[open]` stands, and a dialog screen would make Escape refuse
to end the call it is in. The five `showModal` dialogs live in the browser's top layer, so Settings
opened from a refusal still paints over everything.

While a call is up, `<body data-voice-call="up">` and the sheet's own rule lock the background, and
`.app-shell` is `inert`. Both are released by the one close funnel on every path — End, Escape,
`visibilitychange`, `pagehide`, `beforeunload`, the 4001-4004 refusals and the push idle timer all
already reach `stop()`. A person left on a chat they cannot scroll is worse than the bug this wave
fixes, which is why there is one release point rather than seven.

On close, one animation frame after the synchronous work, the transcript is pinned to the newest line.
An involuntary ending with no sentence to show raises one self-dismissing line in the conversation,
"The call ended." — **not** the toast, whose 2.8 s is shorter than unlocking a phone, which is the
exact case the note exists for. Its dismiss is armed on the next visible `visibilitychange` rather
than on the ending.

### One live defect this wave met and fixed, because a press that says nothing is the worst of them

Gating the screen on the R750 turned up a workspace where **pressing Talk said nothing at all**. The
demo tenant's talking door answers `{"status":200,"enabled":false,"available":true}` — a realtime key
exists and the customer's own switch is off — and the relay refuses that one with `acceptAndSay`, which
writes the note, the bye and the close **together**: `{t:"note",text:"Talking is switched off in
Settings."}`, then `{t:"bye",reason:""}` (that frame's `reason` field carries the **condition**, and
this refusal names none), then a clean 1000 close.

So the page's own `stop()` found no reason, took its "a person pressed the button to leave, so clear
what is standing" branch, and deleted the sentence the relay had written a few milliseconds earlier.
Before this wave that was a hold that did nothing; with a call screen it was a screen that appeared and
vanished with no explanation, which is how it was found.

The fix tells the two apart. A close the **relay** initiated leaves the relay's own sentence where the
relay put it, with its ordinary six-second dismiss; a person pressing the button to leave still clears
what is standing, which is what that branch was for. One wording, one home, and the condition the relay
could not name does not cost the person the sentence. `--leg nokey` stays 51 of 51 and a unit case
drives the exact four frames off the live wire in order.

### MEASURED, `--leg call`, WebKit 390x844 dpr 3 with touch, on MacBook-Pro.local (darwin arm64) against grok-bot-local-vm behind this leg's own relay and the stub vendor

62 of 62 checks.

| | measured |
|---|---|
| press to the screen being visible | **29 ms**, both stamps off the page's own clock |
| the screen's rect | 390x844 at 0,0, `position: fixed`, `z-index: 80`, a child of `<body>` |
| the line the press dialled | 1 session at the stub in 57 ms |
| the words observed across one turn | Connecting, Listening, Thinking, Talking, in that order |
| the halo with a level driven 0 to 1 | `--voice-level` 0.020 to 1.000, scale 1.004 to 1.18, opacity 0.358 to 0.75 |
| the mascot's own transform, at rest and at peak | `none` and `none`; canvas aspect 1.471 both times, backing store 2x both times |
| where Titan is | centred, his middle at 195 px of 390, 632 px wide with 137 px hanging off each side and clipped |
| the playback analyser on the stub's 20-frame reply | RMS 0.259 |
| six seconds of a live call with a level on it | 347 frames, **57.8 fps**, 4 frames over 20 ms, median 17 ms, worst 233 ms |
| the same page with no call screen on it | 267 frames, 44.5 fps, 12 over 20 ms, median 17 ms, worst 337 ms |
| mute | the word reads Muted and the page dropped 6 frames in the window, with nothing sent to the relay for it |
| the three controls | End 56x46, Mute 56x46, the text field 222x44, all fully on screen |
| End to the screen being gone | **61 ms** |
| the chat afterwards | the spoken line once with its chip, byte-identical to the confirmed bytes, 0 px from the bottom |
| the footer when the screen came up | shelf 390x133 at 0,711, composer 358x56 at 16,778, talk 44x44 at 245,784 — byte-identical to before the press |
| an app switch | the line closed, the screen went, one plain line in the conversation, the background released |

### MEASURED ON THE R750 THROUGH console.titanium.bot, 2026-09-11, as a throwaway customer on the demo tenant

`scripts/verify-voice-r750.mjs` **65 of 65**, minted inside the control plane's own container and
removed afterwards. Two engines, because each can measure a half the other cannot.

**The screen, in WebKit at 390x844 with device scale 3 and the iPhone's insets restated** (`--sat`
59px, `--sab` 34px, the way the phone-layout gate restates them): one press brought it up in **50 ms**,
390x844 at 0,0, `position: fixed`, `z-index: 80`; End 56x46, Mute 56x46 and the text field 222x44, all
at least 44 px and all on screen; the screen's own padding read 16 px top and 24 px bottom. WebKit
threw nothing.

**A real spoken turn through the real vendor, in Chromium at 390x844** with speech made on this Mac by
`say` as the capture device, because WebKit has no fake-capture switch. The person's line, as the
vendor transcribed it: *"Low Titan, in one short sentence, what is the team working on today?"* —
"Hello" misheard, which is the vendor on a synthetic voice and is quoted rather than tidied. Titan
answered out loud: *"I don't have any record of active team work today — nothing's been assigned or
reported to me..."*. The words on the screen went Connecting, Listening, Talking and Thinking across
it; End put the person back in the chat, the exchange is in the transcript with the **Spoken** chip on
the person's line, and the chat was scrolled to the newest line, 0 px from the bottom. Screenshots of
Connecting, Thinking, Talking and the chat afterwards are in the scratchpad.

**ONE turn, not two, and the reason is the gate's microphone rather than the product.** The capture
file plays **once** — `%noloop`, which matters: the first live attempt looped it, so the vendor heard
one sentence over and over with no gap and its own 700 ms silence detector never fired. Measured then:
the microphone level read 0.114, the word reached Listening, and nothing was ever confirmed in 150 s.
Played once there is exactly one utterance in the file, so there is exactly one turn.

**The workspace's own talking switch was off and the gate put it back.** The demo tenant's door
answers `{"enabled":false,"available":true}` — a realtime key is stored and the customer's switch is
off — so the gate turns that switch on as the customer whose account it is, takes the turn, and
restores the value it found, which it then re-reads and asserts. Five minutes of the day's 120 were
spent across both attempts. The first version of that restore ran **after** closing the browser, had
no page to run on, and left the switch on until it was put back by hand; it now runs first and is
checked.

**A screenshot artifact, named so nobody reads it as a defect:** WebKit's capture at device scale 3
paints the fixed bottom row a second time at the top of the image. The DOM says otherwise — one
`#voice-call`, one `.voice-call-controls` at y=774, measured through `elementFromPoint` and rects on
the live server — and the Chromium screenshot of the same screen shows one row.

**Injected, not measured:** the microphone level. WebKit ships no fake capture device and the leg's
microphone is built out of Web Audio, so the avatar's reaction to a person's own voice is driven
through `__voice._setCallLevels` and every line that reads it says "injected". The playback level in
the same table is the stub's real audio through the real analyser.

**Not measured by any browser:** the safe areas. `env(safe-area-inset-top)` and `-bottom` both compute
`0px` at 390x844 in both engines and Playwright has no inset control, so the leg injects `--sat` and
`--sab` the way the phone-layout gate does, asserts the house pattern in the **served** bytes of
`voice-call.css` off the live relay (8755 bytes, status 200), and prints that the R750 screenshots are
the only thing a person can actually look at.

**Not measured at all:** an iPhone. Every number above is this Mac at device scale 3 against a kit
that fills a 2x backing store. The frame budget is stated against the same page with no call screen on
it rather than against zero, because this console at dpr 3 in WebKit does not hold a clean 60 fps
idle either, and a "zero frames over 20 ms" claim would have been about this Mac's scheduler rather
than about the screen.

**The one-thumb case stays a Chromium measurement.** WebKit gives Playwright no CDP session, so a
press in this leg is `page.touchscreen.tap`. That one real press fires `pointerdown` **and**
`touchstart` is covered by a unit case instead: two `talkDown()` calls in one gesture open one screen
and dial one line, because `openCall()` is idempotent and `pressSpent` guards only the hold.

Section 13's 390x844 table was taken when a press at that width was a hold. Those numbers still
describe the refusal line's own shelf home, which has not changed; what a press does there is this
section.
