# The standing persona

What an agent says about itself and its workspace, and where each of those facts comes from.

## Why it exists

In one conversation on the operator's own box, between 22:49 on 2026-09-08 and 06:11 on
2026-09-09, the lead agent said all of this:

- it had no email capability (mail had been live since 2026-09-07),
- the workspace held "up to 12 more agents" (`SAND_MAX_AGENTS` on that box said 100),
- repository work goes to a cloud agent on the dead upstream (that tool is withheld from the same
  turn's toolset, and the trace says so: `{tool:'CloudAgent', reason:'cloud_agents_unavailable'}`),
- the product is called something it is not,
- and there is no first-run interview (there is one; it just never ran on a box set up before it
  existed).

Every one of those was a sentence written down once — in the base prompt, in a profile
description, or in a memory the agent had written for itself — against a fact that moves. Nothing
was lying; nothing was reading the box either.

## What the section states

`renderStandingPersonaSection` (`source/host/runner/standing-persona.ts`) builds one section,
rendered fresh on every turn:

| Fact | Read from |
| --- | --- |
| the product's name | the literal `Titanium Bot`, the one place it is written |
| how many bots this workspace holds | `resolveSandMaxAgents()` — `SAND_MAX_AGENTS` in the environment, else `sand-host-settings.json`, else the product default |
| how many exist today | the agent directory the assembly already holds, plus this agent |
| this agent's own email address | `readAgentMail()` — `<sandRoot>/agent-mail.json`, the row for this agent id |
| whether it can send as well as receive | the same file's `canSend` |
| where repository work happens | stated: here, on this box, with the shell and the editor; E2B where configured |
| whether the first-run interview ran | `boxOnboardingService().currentRecord()` — the `onboarding` record in `<sandRoot>/settings.json` |
| how to run that interview again | the phrase `run first-time setup`, plus what to do when it is heard |
| whether this agent is the workspace's lead | `<sandRoot>/lead-agent.json` |

It closes with one line saying that if the agent's profile description, its stored memory, or
anything it has said before contradicts these facts, the facts are the live ones. That is not
politeness. The profile section and the profile-tier memories are injected on every turn too, and
on a box this wave does not swap they still carry the old numbers, so the section has to say which
one wins.

The lead paragraph — lead of the crew, the owner's main assistant, runs and watches the other
bots — renders only for the recorded lead.

## Why every fact is a synchronous, box-local read

Three constraints, and each one rules out a place the section could otherwise have lived:

1. **`getSystemPrompt()` is synchronous** (`system-prompt-assembly.ts`). So no fact may be awaited
   and none may come off the network. The control plane holds the mail directory and the relay
   holds the routing; neither is reachable from here, which is exactly why the relay pushes the
   addresses into `<sandRoot>/agent-mail.json` and this reads the file.
2. **The base prompt is frozen at import.** `DEFAULT_SAND_SYSTEM_PROMPT` is built once when the
   module loads and cached per option pair, so a live fact put there would be whatever the host
   process saw at boot, for the life of that process.
3. **The profile section is snapshot-cached per compaction epoch**
   (`sand-agent-profile-prompt.ts`), so a live fact put there would be whatever it was at the last
   compaction.

So the section is its own `add()` inside `getSystemPrompt`, after the profile. Each reader caches
its parse against the file's nanosecond mtime and size — the discipline `readSandBoxSetting` uses
— because a render happens every turn and a stat is the cheap half of a read. The nanosecond mtime
matters: rewriting one six-digit code, or flipping `canSend`, keeps the file's length.

## Who is the lead

`<sandRoot>/lead-agent.json`, written once and never moved:

- at mint, in `session-materialization.ts`, when a genuinely empty box gets its first agent — the
  one moment the host actually knows;
- at host start, in `provisionSandBoxPromptArtifacts`, for a box that predates the file: the
  oldest agent directory under `<sandRoot>/agents` is the workspace's first agent. That walk
  happens once per host start and never on the prompt path.

The prompt path only reads it. It never keys on an agent's name: `grok-bot-local-vm` has 22 bots
and none of them is called Titan, so a persona that recognised itself by name could not be
measured there at all.

## The retrigger, and the one thing it cannot do

The phrase is **`run first-time setup`**, and the section says both what it does and what it does
not do.

There was no shipped retrigger before this. `resetOnboarding` answers 403 without
`SAND_TEST_HOOKS`, and `startOnboarding` refuses any agent that has already been talked to — and
both are console commands anyway, while the person types the phrase into the chat. So the wiring
is the standing instruction itself.

**What it took to make that instruction actually fire, measured three times on
grok-bot-local-vm.** The first two shapes both failed the same way:

| UTC | The instruction | What the agent did |
| --- | --- | --- |
| 12:53 | "open the `onboarding` skill in your own skill library" | *"On it — starting the setup interview now."* then silence |
| 13:04 | the same, with the skill's exact path spelled out | *"On it — starting the setup interview now."* then silence |
| 13:2x | the first question written into the prompt, to send in the same message | the interview starts |

The path was never the problem. The shape was. The prompt's very first rule is to open every turn
with a plain acknowledgement before any tool call, so an instruction of the form *acknowledge, then
go and read a file, then ask* gives the model a turn it can satisfy by acknowledging alone — and
that is exactly what it did, twice, with two different wordings. "On it", then nothing, is the
worst of the three possible outcomes, worse than a refusal, because the person sits waiting for a
question that never comes.

So the first question — *"What should I call you?"* — is written into the section itself and has to
go in the same message. Nothing needs fetching before the interview can start; the skill file at
`<sandRoot>/managed-skills/skills/onboarding/SKILL.md` is where the rest of it comes from, read
while the person answers. `tests/standing-persona.test.mjs` pins the question and the
same-message rule, so a later edit that turns it back into "go and read this first" fails the
suite rather than the customer.

The general lesson is worth more than this one phrase: **an instruction that puts a tool call
between the person and the first visible thing they are waiting for is an instruction the model
can drop.** Put the visible part first.

That skill named two tools, `save_onboarding_answer` and `finish_onboarding`, which the toolset
offers only while the box's record says setup is open. On a workspace that has already finished
setup — which is every workspace where somebody would ask for this — they are simply not there.
The skill now says so and says to run the interview anyway, keeping the three answers that outlast
it in memory, which is the part that mattered.

**What it cannot do is reopen the setup window in the console.** That window is driven by the
box's `onboarding` record, and re-running the interview in chat does not reset it. The section
says that in the same sentence as the phrase, because promising a phrase that half works is the
same bug class as a fact being wrong.

## Adding a fact

One line in `renderStandingPersonaSection`, one reader if it needs a new file, and one case in
`tests/standing-persona.test.mjs`. The test's shape is the contract: write the fact into a fake
sand root, render, and assert the rendered words against the fact rather than against a golden
string. Two of its cases exist purely to keep numbers honest — one asserts that with no settings
file the only numbers in the whole section are the live ceiling and the live count, and one
asserts that neither seed skill carries a bot count of its own. A number that appears in the
prompt and in no file is the bug this whole section exists to prevent.

A fact that cannot be read synchronously off this box does not belong here. Push it into a file
the box holds — the way the mail directory is pushed in with `setAgentMail` — and read the file.


## Measured, 2026-09-09

`scripts/verify-persona.mjs` does not read the prompt. It mints a scratch agent, asks it the five
questions one at a time, reads each whole turn, and scores every answer against what the same box
says about itself in the same run — `getAgentCapacity`, `getAgentMail`, `getOnboardingState` — then
says the retrigger phrase once and checks the interview actually starts. The agent is deleted pass
or fail.

**And it gives that agent an address first.** A bot minted seconds ago holds no row in the
directory — the relay sweeps every five minutes — so left alone this gate could only ever measure
the "I have none yet" branch, which is not the sentence Jason's or Richard's Titan says. It reads
the box's own address list, pushes it back with one synthetic row for its scratch agent, asks the
question, and writes the original list back in cleanup. The first run of the answer that matters is
below.

**grok-bot-local-vm** (this Mac), 15:31Z, 91 s: 13 of 13 PASS, bundle `df1300366eb2`, model
glm-5.3. The box's facts that run were `maxAgents=40`, `doneReason=completed`,
`domain=verify-mail.invalid` with 8 addresses. Asked whether it has an email address of its own,
with a row of its own in the directory for the first time:

> "Yes, I do: agent346507@verify-mail.invalid. Mail sent there lands right here in our chat, and I
> can act on it."

— its exact address and no other bot's, out of the eight on that box.

**The R750 demo tenant** (`titanbot-box-atonqjq7zx593jsacaccpfau`, bundle `7d653c9283a4`, model
Qwen 3.8 Max), 17:39Z, 69 s: 13 of 13 PASS. The box's own facts that run were `maxAgents=40`,
`doneReason=existing-box`, `domain=myagents.email canSend=false` over 8 addresses. Asked whether it
has an address of its own, with a row of its own in the directory:

> "Yes, my email address is agent994656@myagents.email. I can receive mail there, though sending
> isn't wired up yet on this workspace."

— its exact address, none of the other eight, and the send path described as it actually is. The
first run at 14:25Z (bundle `3de23332477d`, ceiling 100) is below as it was recorded; its email row
was the no-address branch, which is the hole PERSONA-1b closed:

| question | answer | checked against |
| --- | --- | --- |
| do you have email | "I don't have an email address of my own yet. When one is set up for me, it'll appear in my profile automatically." | that scratch agent holds no row in the directory, and it does not claim it cannot do email at all |
| how many bots | "100" | `getAgentCapacity.maxAgents = 100`, and not the stale twelve |
| where does coding go | "The work happens right here on this box: I clone the repo into my workspace, read and edit it, run tests, and push from here." | names no outside vendor; this is CURSOR-1 part (f) closed in the answer rather than in the source |
| what is this called | "Titanium Bot" | the literal, and neither old name |
| did onboarding run | "The first-run interview never ran here because this workspace was set up before it existed. Just say \"run first-time setup\" and I'll run it right here in the chat." | `doneReason=existing-box`, and the phrase is exact |
| the retrigger | "On it! What should I call you?" | the phrase starts the interview in the SAME message, which is the whole point of the fix below |

The lead paragraph was measured separately, on the real demo Titan rather than a scratch agent: its
card in `console.titanium.bot` reads Role, "Main agent and lead of the crew".

**Richard Avery's box was not swapped**, so his Titan still runs the older bundle: it keeps the
twelve-bots sentence, and it cannot name its own address even though that address is minted and
routes. Routing is decided at the relay; only the sentence needs the swap.
