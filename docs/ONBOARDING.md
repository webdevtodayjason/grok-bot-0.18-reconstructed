# Onboarding: building a customer, and their first minute with Titan

**There are TWO onboardings and this page covers both.** They are easy to confuse and they happen in
this order:

| | Whose | What it is | Where |
|---|---|---|---|
| **The invite** | the operator's | one press on the Clients panel builds the account, the workspace, the box, the bots' email addresses, and sends the welcome mail | sections 10 to 14, gap row ONBOARD-2, shipped 2026-09-10 |
| **The first run** | the customer's | they open their workspace and Titan introduces himself, asks five short questions, and shows them what he can take on | sections 1 to 9, gap row ONBOARD-1, shipped 2026-09-07 |

The first nine sections are the first run: one flag on the box, three gateway commands, two tools, one
seed prompt, one dialog in the console and a ceiling of forty agents. Section 10 onward is the invite that
gets a customer to the point of having one, the mail that tells them about it, and the Remove that
takes them away again.

**What the first run is.** The first thing a person sees when they sign in to their own workspace, and
the contract the two halves of it are built to. Titan introduces himself, asks five short questions,
walks through what he can do, and asks what they want done first.

**Status, 2026-09-07: built and measured.** This document is the contract,
`scripts/verify-onboarding.mjs` is the gate written to it, and the gate now runs against the
product rather than against a stand-in. On this Mac, box `grok-bot-local-vm`, host bundle built
from the gb tip: **58 passed, 0 failed, 1 not measured** across all three arms, and `npm test` 1072
passed, 0 failed. What it was before, measured here the day it was written, is worth keeping beside
that: the box answered `unknown gateway method: getOnboardingState`, held 8 agents and 1 group,
had no agent named Titan, carried no `userTimeZone` at all, and enforced a limit of 50. Section 9
carries every number and what is still not measured. The gap rows `ONBOARD-1` and `AGENTS-CAP-1`
are landed.

## 1. What happens the first time somebody signs in

They land on the console the way they always will. Over the top of it, coming down from just below
the top bar and running the full width of the stage, is a dialog with Titan's face in the middle of
it. The chat is behind it and dimmed. He says who he is: their main Titan, the one they will talk
to, the one who runs the rest of the crew for them. Then he asks the five questions in section 2,
one at a time, in his own words, as a conversation and never as a form. Each answer is saved as it
arrives and lights up on a strip of five inside the dialog, so the person can see how far in they
are. When the questions are done he walks through what he can do (section 3) and closes by asking
what they want done first. The dialog closes and they are in the ordinary console with Titan
selected.

**Titan is what closes it.** The last thing the recipe tells him to do is call `finish_onboarding`,
which marks the box done; the console is asking the box every 2.5 seconds while the dialog is up, so
it sees `done: true` and closes. Nothing else on the box ever marks the record done, which is why the
tool exists: without it the only way out was the button, and a person who answered every question was
told they had skipped setup.

**Skip for now** is on the dialog from the first second, for the person who does not want to go
through with it. It closes the dialog and marks the box done, keeping whatever was answered before
they pressed it. Nobody is held in this. Once all five answers are in there is nothing left to skip,
so the same button reads **Done**, and the box is told which of the two it was.

**Titan speaks first, and the console is what makes him.** A fresh box's first agent is born in
`createFallbackSession` (`source/host/extensions/session/session-materialization.ts:98`), which goes
straight to `materializeSession` and never sets `introductionPending`. So `kickstartAgent`
(`agent-lifecycle.ts:120`) returns false on it and the opening turn nothing else would start has to
be started by the console when it opens the dialog. See section 6.

## 2. The five questions

| Field | What he asks | What he does with the answer |
|---|---|---|
| `name` | what to call them | saved to the state, and written to his own memory as a profile fact |
| `location` | where they are, so he can get the time zone right | saved, turned into an IANA zone, and applied to the box (section 4) |
| `business` | what kind of business they are in | saved, and written to his memory as a profile fact |
| `ownsBusiness` | whether they own it, yes or no | saved as a boolean |
| `workingStyle` | how they want to work with him: hands on, or hand things off | saved, and written to his memory as a profile fact |

One at a time. He asks the next one after the last is answered, not all five at once, and he takes
a person who answers two things in one sentence at their word rather than asking again.

Each answer reaches the box through the tool in section 5.4 the moment he has it, not in a batch at
the end. That is what makes the strip fill, and it is what makes a person who closes the tab halfway
through come back to a Titan who already knows their name.

## 3. What he walks them through

After the questions, in plain words, as things he can do for them rather than as a feature list:

- talk things through, and hand work to the rest of the crew
- browse the web and use a computer of his own
- run routines on a schedule, so a thing that has to happen every Monday happens every Monday
- read and send email, once mail is set up ([docs/MAIL.md](MAIL.md))
- create up to 12 more bots for particular jobs, each with its own conversation, files and screen
- the Marketplace, where plugins and ready-made bots come from ([docs/MARKETPLACE.md](MARKETPLACE.md))

Then: what do you want done first.

## 4. The state on the box

One object, `onboarding`, in the box's mutable settings document, `<sandRoot>/settings.json`, the one
`SandSettingsStore` writes atomically (`source/shared/node/settings/sand-settings-store.ts:93`) and
the gateway already reads and writes through `getHostSettings` and `setHostSettings`.

```json
{
  "onboarding": {
    "done": false,
    "startedAt": 1757260000000,
    "completedAt": null,
    "answers": {
      "name": "Jason",
      "location": "Fort Worth, Texas",
      "timeZone": "America/Chicago",
      "business": "managed IT services",
      "ownsBusiness": true,
      "workingStyle": "hand things off"
    }
  }
}
```

**The record carries no `agentId`, and nothing needs one.** This page used to say it did and that the
console bound the dialog's conversation to it. It does not: `onboardingTitan()`
(`ui/machine-room/app.js:7249`) finds him off the **roster**, taking the bot named Titan or failing that
the oldest non-group bot, and `sendOnboardingMessage` sends into whatever context that picks. Which is
the right shape, because the roster is a live read and a copied id goes stale the moment a bot is
deleted. Corrected 2026-09-10 under ONBOARD-2.

**Do not reuse `hasSeenOnboarding`.** `SandStoredSettings` already carries `hasSeenOnboarding` and
`hasSeenOnboardingAccountScope` (`sand-settings-store.ts:26`). Those belong to the desktop app's own
first run, they are account scoped, and `scopeToAccount` (`:134`) **deletes** them whenever the
account scope changes. A box-level flag kept there would silently reset itself. The `onboarding`
object above is its own key and nothing in `scopeToAccount` touches it.

**Not the operator switch file.** `sand-host-settings.json` is the other store, read by
`readSandBoxSetting` (`source/host/sand-box-setting.ts:70`). It holds string switches an operator
sets by hand. `SAND_MAX_AGENTS` and `SAND_TEST_HOOKS` live there. The onboarding state does not.

### The migration rule

**Jason's instance and this Mac must never be thrown into onboarding**, and neither must any box
that is already in use. So on the **first read** of the state, before anything is written, the host
decides for itself:

> If the `onboarding` object is absent, and the box has **more than one agent**, or **any agent with
> a prompted conversation**, then the box is already in use. Write `{done: true, startedAt: null,
> completedAt: <now>, answers: {}}` and answer that. Otherwise write `{done: false, startedAt: <now>,
> answers: {}}` and answer that.

Both signals are ones the host already computes, and they are used verbatim rather than
reimplemented:

- **agent count**: `countOwnedAgents()` (`session-materialization.ts:53`), the length of
  `listAgentRecordIds()` (`:52`), which excludes subagents and tombstoned agents. This is **not** the
  gateway's `countAgents`, which includes groups.
- **a prompted conversation**: `session.db.getTranscriptEntries().some(isUserMessageEntry)`, the
  exact predicate `agent-lifecycle.ts:136` uses, where `isUserMessageEntry` is
  `source/host/extensions/transcript/send-message-shaping.ts:19`.

Measured on this Mac's box today: 8 agents, several with prompted conversations, so it marks itself
done at the first read and no modal ever opens on it. That is the case the gate measures first, in
`--live`, because it is the one that can embarrass a customer.

### The time zone

`location` is a person's own words. The zone is an IANA name, and it goes to the box through
`setHostSettings { userTimeZone }`, which `SettingsService` validates with `isValidIanaTimeZone`
(`source/host/extensions/settings/settings-service.ts:11`) and applies at `:46`. It is a real setting
with real consequences: it reaches the model through `host-request-context.ts:5` and
`renderTimeZoneSystemPrompt`, and it anchors every cron a routine runs on. If the zone cannot be
worked out from what the person said, keep their words in `answers.location`, leave
`answers.timeZone` unset, and do not guess. There is no `TZ` variable and no `/etc/localtime`
handling anywhere in this tree: the container clock stays UTC, and only the prompt and the scheduler
carry the person's zone.

## 5. The gateway

### 5.1 `getOnboardingState`

No arguments. Answers the object in section 4, plus `maxAgents`. Runs the migration rule on the
first read. The console asks for it once at boot, inside `hydrate` (`gateway-adapter.js:1303`), and
asks with `tryCall`, so a host too old to have it answers `unknown gateway method`, the console
remembers the miss, and no modal is drawn. An old host degrades to no first run, never to a broken
console.

### 5.2 `completeOnboarding { answers, skipped }`

Marks `done: true`, stamps `completedAt`, and merges any answers it is handed over the ones already
saved. `skipped: true` records `doneReason: "skipped"`, anything else records `"completed"`.
Idempotent. This is the console's button and nothing else: **Skip for now** sends `skipped: true`,
**Done** sends no flag. The end of the conversation does not come through here at all, it comes
through the `finish_onboarding` tool in 5.5.

There is also `startOnboarding { agentId }`, which dispatches Titan's opening turn (section 7). It
fires once per box, not once per page load: the console asks for it every time it opens the modal,
so a host that dispatched blindly would drop a second "Let's get set up." on a half-finished
interview whenever somebody reloaded the page. An agent that already carries a message from the
person has already been asked, and the command answers `{ started: false, reason: "already-started" }`.

### 5.3 `resetOnboarding` (test only)

Refused unless `SAND_TEST_HOOKS` is `1` in `sand-host-settings.json`, and the refusal says so in
plain words. Two modes:

- `resetOnboarding {}` puts the box back to `{done: false}`, which is how the gate gets a modal to
  measure on a box that is not fresh.
- `resetOnboarding { clear: true }` removes the `onboarding` object entirely, so the **next** read
  runs the migration rule again. This is the only way to measure the rule on a real box, and the
  gate measures nothing more important.

### 5.4 `save_onboarding_answer { field, value }`

One of the two tools the onboarding prompt gives Titan, and offered only while the record says
`done: false`. `field` is one of the five in section 2. It writes the answer into the state, applies the time zone when the field is
`location` and a zone was worked out, and answers:

```
{ ok: true,  detail: "Saved your name." }
{ ok: false, reason: "That is not one of the five things I ask." }
```

**That result shape is load bearing.** The runner reads `detail` on success and `reason` on failure
(`source/host/runner/agent-state.ts:1-3`). A tool that answers `{ok, message}` instead makes every
successful call report `Cannot read properties of undefined (reading 'text')`, which is a bug this
repo has already had once and fixed.

### 5.5 `finish_onboarding {}`

The other one, and the interview's ending. No arguments: the record already holds every answer, and
this only says the conversation is over. It writes the same record `completeOnboarding` writes, with
`doneReason: "completed"`, and the console's poll closes the dialog on the `done: true` that comes
back. The recipe tells Titan to call it once, in the same turn he asks what they want handled first
(section 7 step 6).

**It is the only thing on the box that ends a finished interview.** Before it existed the record was
written by the console's button alone, so a person who answered all five questions could leave that
window only through a control that said they were skipping, and closing the tab instead reopened the
whole first run on the next load. Both tools disappear from the toolset the moment the record reads
`done: true`, so a finished box carries neither.

### 5.6 The cap, and where it really comes from

**`getHostStatus` carries neither `maxAgents` nor an `onboardingV1` capability.** This page used to say
it gained both. It did not, and the claim was self-confirming: the only `onboardingV1` string anywhere
in the tree is `scripts/verify-onboarding.mjs:289`, the gate's own fixture, so the leg that read it
passed on a value the gate supplied itself. Measured and corrected 2026-09-10 under ONBOARD-2.

The ceiling the console draws comes from **`getOnboardingState.maxAgents`**, which every box answers on
every read, first run or not. `applyReportedCap` (`ui/machine-room/app.js:7378`) installs it on every
load, so the roster header and the Add button draw the operator's own number rather than the built-in
default. Measured on a fresh box on this Mac 2026-09-10: `maxAgents` 40.

## 6. The console

The dialog is a new one, not `.panel-dialog`. Settings is a card in the middle of the screen; this
is a full-width sheet that comes down from under the top bar, which is what Jason asked for and what
makes it read as the product talking rather than a settings page. It is opened with `showModal()`,
so the chat behind it is dimmed by the dialog's own backdrop (`styles.css:1553`) and is inert while
it is up.

The transcript and the composer in the shell are singletons inside `.stage` and `.control-shelf`
(`#transcript`, `form#composer`), and `showModal()` makes everything outside the dialog inert, so
the dialog **cannot** reuse them where they stand. It renders `transcriptMarkup()` into its own
container and carries its own composer.

**The DOM contract.** These are the hooks `scripts/verify-onboarding.mjs` reads, and the shortest
statement of them is the `STAND_IN` function in that file, which builds the smallest page that
satisfies this list and is what `--self-test` measures the gate against.

| Hook | What it is |
|---|---|
| `#onboarding-dialog` | the `<dialog class="onboarding-dialog">`, opened with `showModal()` |
| `data-onboarding-agent` | on the dialog: the agent id the conversation is bound to |
| `[data-onboarding-face]` | holds the `<titan-mascot>` (or the still, under reduced motion), drawn large |
| `[data-onboarding-step]` | five of them, one per field name in section 2, each with `data-done="true\|false"` |
| `[data-onboarding-transcript]` | the conversation, inside the dialog |
| `[data-onboarding-composer]` | a form with a `textarea`; Enter sends, the way the shell composer does |
| `[data-onboarding-skip]` | the **Skip for now** button |

**The face and its moods.** `mascots.js` reads the mood off the agent record rather than taking one
(`moodFor`, `mascot-crew.js:172`): `needsYou: true` or a running status gives **curious**, a
celebration window gives **excited**, everything else gives **calm**. Waiting on the person, Titan is
curious. When an answer lands, `celebrationUntil` puts him in excited for six seconds. There are
three moods and no others; do not invent a fourth.

**The first message.** When the dialog opens on a box reporting `done: false`, the console sends
Titan's opening turn itself, with the marker that makes the host attach the onboarding prompt. The
marker is a workflow reference to the seed skill in section 7, carried in `richText`, which is the
same mechanism the Learn dialog already uses (`teach-recording-service.ts:61`) and needs no change
to `sendPrompt`, to `SendPromptOptions`, or to the runner. A host that implements the marker some
other way, such as a `startOnboarding` command shaped like `kickstartAgent`, still passes the gate:
what is measured is that the turn ran and that the model was offered `save_onboarding_answer`, not
how the prompt got there.

**When it closes.** `completeOnboarding` lands, the dialog closes, and the console is the ordinary
one with Titan selected.

**Where the console code is.**

- `ui/machine-room/index.html` — the `<dialog id="onboarding-dialog">`, and the count on the Add
  button.
- `ui/machine-room/onboarding.css` — everything the dialog is styled with, in its own file so it
  never collides with `styles.css`.
- `ui/machine-room/app.js` — one block, between `// ===== ONBOARD-1` and `// ===== end ONBOARD-1`,
  plus the `AGENTS-CAP-1` block for the cap.
- `ui/machine-room/gateway-adapter.js` — the calls, under `// ---- ONBOARD-1`.
- `ui/machine-room/adapter.js` — the offline fixture.
- `tests/machine-room-onboarding.test.mjs` — the unit tests, which run the shipped blocks.

**While the dialog is up the console asks the box again every 2.5 seconds**, because Titan writes
an answer the moment he gets it and nothing pushes that to the page. `done: true` coming back
closes the dialog on its own, which is how the interview ends: Titan's `finish_onboarding` (5.5) is
what puts it there. Escape does what the button does, and if the box refuses that write the dialog
stays open and says why: closing on a flag that did not move would bring the dialog back, which is
worse than not offering skip.

**The button's own label follows the strip.** `Skip for now` until all five answers are in, then
`Done`, and `completeOnboarding` is sent `skipped` to match. It is a way out, not the ending, so it
is the same control either way rather than a second one appearing beside it.

**Reading the dialog with no host.** `?onboarding=1` on the console URL arms the offline demo
adapter: it reports `done: false`, renames the first agent Titan and clears his conversation, so
the page looks like the box the dialog is really for. Without the flag nothing changes, which is
why every other offline view of the console still opens the way it did.
`window.__machineRoomOnboardingDemo = true` before boot does the same thing from a test.

## 7. The prompt

A seed skill, `source/host/extensions/managed-setup/seed-skills/onboarding/SKILL.md`, beside
the three that are already there. `node scripts/gen-seed-skills.mjs` bakes it into
`seed-skills.gen.ts`, because the host ships as one bundled file and cannot read the directory at
runtime. It has to make Titan:

1. say who he is, in one or two sentences: their main Titan, their AI lead, the one who runs the crew
2. ask the five questions in section 2, one at a time, in his own words, never as a form or a list
3. call `save_onboarding_answer` the moment he has each answer, before asking the next
4. walk through section 3
5. close by asking what they want done first
6. call `finish_onboarding` in that same turn, which is what closes the window on their screen
7. take **Skip for now** and a person who does not want to answer at their word, without pushing

**Do not use `HostRunnerOverrides.systemPrompt` for this.** It replaces the base prompt wholesale and
sets `isSystemPromptOverridden`, and `turn-toolset.ts:1560` withholds `update_state` entirely when
that flag is set. Titan's memory writes below depend on `update_state`, so an override would quietly
remove the tool the flow needs. The seed-skill route is additive and keeps the whole toolset.

**Not `SAND_ONBOARDING_KICKSTART_PROMPT`.** `source/shared/agents/onboarding.ts` already holds a
constant by that name. It is upstream's first-turn cue for **every** newly created agent, it is per
agent rather than per box, and reusing it would change the first turn of every bot anybody ever
makes. This is a separate prompt.

**What he keeps.** The name, the business and the working style go into his own memory through
`update_state` with `memory write`, tier `profile` (`source/host/runner/tools/sand-state-tool.ts:9`),
which is the tier kept in mind every turn. That is what makes him still know them tomorrow. The
state object in section 4 is the record of the interview; his memory is what he actually works from.

## 8. The ceiling: a default of forty, raised per workspace

**A box holds 40 bots by default: Titan and 39 more.** Jason decided the number on 2026-09-09,
against the 100 set the day before and the 13 before that. The reasoning is worth keeping because it
is not arbitrary: flat coordination holds to about fifty, one lead talking to every bot with nothing
structured underneath, and the hierarchy tooling that would carry more (TEAMS-1) does not exist yet.
Forty is the number a workspace can actually run, not the number it can hold.

**Forty is a default, not a ceiling.** The super admin raises a workspace from its row in the admin
console, which writes `SAND_MAX_AGENTS` into that box's `sand-host-settings.json`; the container
environment still wins over the file. The three live boxes on the R750 carry `"100"` there today, so
the default coming down cannot move a workspace somebody already set. Groups do not count. The
number is a ceiling, not a load: a bot costs nothing until it runs, and a desktop seat is opened
only for a bot that asks for one.

Two things about that setting are easy to get wrong, and both fail silently. The value must be a
**string**: the settings reader takes a value only when `typeof value === "string"`, so a JSON
number is ignored and the box drops to the default. And the range is **1..1000**, checked by
`resolveSandMaxAgents`, which fails **open** — anything outside it, or unparseable, is discarded and
the workspace runs at 40 with nothing saying why. So whatever offers the control validates the range
before it writes.

It is enforced at one place, `mintAgent` (`session-materialization.ts:81`), which both `createAgent`
and `duplicateAgent` funnel through. The refusal a person sees is one sentence:

> This workspace holds Titan and 39 more bots. Remove one to add another.

Templated from the ceiling in force, so a box with `SAND_MAX_AGENTS` set reads its own number. No
status code, no class name, nothing about limits or maximums. It reaches the console as HTTP 409
(`statusForCommandError`, `gateway-server.ts:15`) and the console shows the sentence as a toast. The
Add button carries the count: **n of 39**, where n is the agents besides Titan, and it follows a
raised workspace the same way the refusal does.

The roster header carries the same ceiling, `n / 40 bots`, counted off the roster the console can
see rather than off `countAgents`: a room is an agent to `countAgents` and is not a bot, so
counting rooms against a cap that excludes them would put two numbers that disagree side by side.
The host's own count is on the tooltip. Both numbers follow the ceiling the host reports on
`getOnboardingState` and `getAgentCapacity`, and fall back to the default only when no host answers.

The gates read that number off the box rather than carrying a literal (GATE-15). `verify-deploy` and
`verify-dashboard` both ask `getAgentCapacity` and require the console to **agree** with what the
box reports. A gate that pins a literal goes red the next time somebody deliberately changes the
ceiling, which is exactly what GATE-15 was filed as.

**One trap left, and one that is closed.**

The closed one, written down because it is what the shape of this code is explaining. The limit used
to live in two files that were not wired to each other: `session-materialization.ts` held
`MAX_AGENTS_PER_USER = 50` and its own `SandAgentLimitError`, `shared/agents/agents.ts` held a second
constant, a second class of the same name, and `SAND_AGENT_LIMIT_MESSAGE = "50 is the maximum"`.
There is one of each now. The default is `SAND_DEFAULT_MAX_AGENTS = 40` (`agents.ts:73`), the class is
declared once beside it (`agents.ts:83`) and re-exported from `session-materialization.ts:28` so the
old import path still works, and no `MAX_AGENTS_PER_USER` is left anywhere under `source/` (the only
mention now is the word list the gate uses to keep jargon out of the refusal a person reads).

The trap that is still live: `isSandAgentLimitError` (`agents.ts:98`) is what two callers use to
catch a limit, `tryEnsureSession` (`session-runtime.ts:417`) and the post-delete fallback
(`agent-lifecycle.ts:476`), and `statusForCommandError` (`gateway-server.ts:15`) is what turns it
into the 409 the console reads. All three test the error's **name**, not its message, so the refusal
sentence can be reworded freely. **What must not move is the name.** Rename the class, or throw a
plain `Error` from `mintAgent`, and all three quietly stop recognising the one condition they exist
to handle. The name and the matchers move together, or neither moves.

One more thing about a fresh box: when the cap is already reached, `createFallbackSession`
(`session-materialization.ts:98`) adopts an existing agent rather than minting, so the ceiling can
never leave a box with no agent at all.

## 9. Gates, and what is open

```sh
node scripts/verify-onboarding.mjs                # all three arms
node scripts/verify-onboarding.mjs --offline      # the modal from a fixture, needs nothing running
node scripts/verify-onboarding.mjs --live         # the loop on the box
node scripts/verify-onboarding.mjs --cap          # the ceiling
node scripts/verify-onboarding.mjs --self-test    # the gate measuring itself, see below
```

**The fixture arm** serves `ui/machine-room` off its own static server and answers `/api` from a
fixture, so the console hydrates live with no box behind it. It measures the modal: open below the
top bar, the width of the stage, modal so the chat behind is dimmed and inert, Titan's face large and
curious, the five questions on the strip, none ticked before a word is said, **Skip for now** in
those words, the conversation and composer inside the dialog, two of five ticked on a state with two
answers, and **no modal at all** on a box reporting `done: true`.

**The box arm** measures the migration rule first, then puts the flag back to first run through
`resetOnboarding`, checks that the same command is refused with `SAND_TEST_HOOKS` unset, points the
box at a stub model on the Mac the way `verify-loop.mjs` does, opens the console headless, and walks
the loop: the modal opens by itself, the console starts Titan's turn with nobody typing, **the setup
recipe's own lines are in the user half of that turn**, the model is offered
`save_onboarding_answer`, the typed name lights up the strip and lands in the box's own state,
**Skip for now** closes the dialog, and the flag reads done with the answer kept and
`doneReason: "skipped"`.

Then it measures the ending, which is the part no button is involved in. The flag goes back to first
run, the page is reloaded, and the box has to refuse to say Titan's opening a second time on a
conversation that already carries it. The stub then does what the recipe tells Titan to do at the
end of section 5 and calls `finish_onboarding`. What has to follow: the record reads `done: true`
with `doneReason: "completed"`, and the setup window closes with nobody pressing anything.

The recipe leg and the tool leg are two legs, under two labels, because they answer two questions.
The tool is on offer whenever the box's record reads `done: false`, which is true whether or not the
recipe ever reached the model; the recipe reaches it through `expandWorkflowReferences`, which is a
silent `continue` when the seed skill is not in that agent's workflow store. A box in that state
would ship a Titan who is handed "Let's get set up." and nothing else, so the stub keeps the user
content of the first turn and the gate reads the recipe's own lines out of it.

**The ceiling arm** fakes the roster by moving `SAND_MAX_AGENTS` down to the box's own count rather
than minting twelve agents. It reads the refusal, counts the number in the sentence against the
ceiling in force, checks there is no machine word in it, checks the 409, checks `duplicateAgent` is
refused the same way and that neither refusal left a half-made agent behind. Then it raises the
ceiling by one and the same create must succeed, which is the only honest way to show the group on
this box is not being counted, and it reads the console's toast in a browser.

**`--self-test`** injects a stand-in modal built to the DOM contract in section 6 and runs the
fixture arm's checks against it. It reports on the gate, never on the product, and its summary says
so. It exists because a gate written before the thing it measures can have every selector wrong and
look perfectly calm: a check that finds nothing passes nothing and fails nothing.

**Measured, 2026-09-07, this Mac (darwin 25.5.0) against the box `grok-bot-local-vm`, host bundle
built from the gb tip by `node scripts/build-host.mjs --deploy`:**

| What | What it answered |
|---|---|
| `verify-onboarding` all three arms | **58 passed, 0 failed, 1 not measured** |
| the fixture arm against the real console | passes. The dialog opens below the top bar at the width of the stage, the chat behind it is dimmed, Titan's face is live at 131px and curious, the five questions are on the strip with none ticked, **Skip for now** is there, and a state reporting `done:true` opens straight into the console with no modal |
| the box arm | passes. The flag went back to first run through `resetOnboarding`, the modal opened by itself, the console started Titan's turn with nobody typing (1 model call in 2s), that turn carried 5777 characters of user content holding the recipe's own `# First-time setup` and `Ask the five`, the turn was offered `save_onboarding_answer`, an answer typed in the dialog reached the box's own state, the strip read 1 of 5, **Skip for now** closed it, and the box read `done:true` with `doneReason:"skipped"` and the answer kept |
| the ending, on the box | passes. Put back to first run and reloaded, the modal came back and the box refused to say Titan's opening twice (1 opening line before the reload, 1 after). The stub called `finish_onboarding` once, the record went to `done:true` with `doneReason:"completed"`, and the dialog closed with nobody pressing anything |
| the migration rule on a used box | passes. 8 agents on this Mac and it answered `done:true`, `doneReason:"existing-box"`, at the first read. No agent was renamed and no modal opened |
| the ceiling arm | passes. Default 13 with nothing set; a room does not spend one of the thirteen (bots 9 → 9 while `countAgents` went 9 → 10); at the ceiling `createAgent` and `duplicateAgent` both answer HTTP 409 with "This workspace holds Titan and 8 more bots. Remove one to add another."; neither refusal left a half-made agent; one place under the ceiling the same create goes through; the console shows the same sentence as a toast |
| the location answer setting the box's time zone | **still not measured by any arm.** The box arm answers the name only, on purpose, because measuring the zone writes a real setting the scheduler on this Mac reads. The write itself is exercised by the unit tests; whoever wants it proved end to end has to say on which box |
| the gate itself | **`--self-test` 15 passed, 0 failed.** Kept, because it is what makes the fixture arm's selectors falsifiable |
| unit tests | `npm test` 1072 passed, 0 failed, including the state, the migration table, the first-agent rule, the cap, the two interview tools and the button that stops saying skip |

**Shipped, 2026-09-07, commit `345d601`.** Relay files and the host bundle by sync, then a docker restart of
Jason's relay container and `updateHostNow` inside his box. No Coolify recreate: a recreate runs the box store's
copy-in over the live agent databases, which is BOX-6. The quiet check first (6 agents, 0 mid-turn, 2 jobs, 0 open),
then the supervisor's own line, `post-swap watch disarmed: host up 60077ms on 345d6015a782 (healthy)`, then
`verify-deploy --url https://console.titanium.bot`: **59 legs, 0 failing, 2 inconclusive**.

His instance did not enter the first run, which is the migration rule doing its job on a live box rather than in a
test: it answers `done:true` with `doneReason:"existing-box"`, and headless Chrome pointed at his live box draws no
`[data-onboarding]` element at all, no open dialog, five roster cards reading Titan, Scribe, Instagram Marketer,
X Marketer, Facebook Marketer, a header of `5 / 13 bots`, and no page errors. Nothing was renamed. Richard's box and
the demo tenant were left on the previous bundle on purpose and take this one on their own daily update.

**The relay and a command's own refusal.** `resetOnboarding` is the first gateway command that
answers 403 on its own terms rather than on the bearer, and it found a fault in the relay: it
folded both 401 and 403 from the box into one sentence, "SAND_HOST_GATEWAY_TOKEN is stale or the
box was recreated". The gateway spends 401 on the bearer and 403 on a refusal a command made
(`resetOnboarding` without `SAND_TEST_HOOKS=1`, a browser Origin, an untrusted Host, a cross-site
avatar). So the guard leg of this gate was passing on a stale-token 502 and would have gone on
passing if the guard had been deleted. `ui/server.mjs` now passes 403 through with the gateway's
own words, 401 still answers as the deployment fault it is, `tests/relay-command-status.test.mjs`
pins both directions, and the gate leg asserts the 403 and the guard's own text.

---

## 10. The invite: one press builds a customer (ONBOARD-2)

Jason, 2026-09-10: *"Is the super admin panel ready in a state where I can invite a user and it will
handle the full onboarding process, including creating the account and workspace, creating a Docker
container for the AI agents, setting up their emails? Is the welcome email sent out?"*

Until ONBOARD-2 the answer was no on both counts. The panel's **Add a client** had never built a
tenant on the R750 (eight `client.add` rows on 2026-09-09, every one of them failing
`duplicate_email`), the only real onboarding, Richard's on 2026-09-07, went through the CLI, and its
welcome mail was a hand-run script that no longer exists on that server. The welcome checkbox was
present and disabled, because the control plane sent no mail at all.

### 10.1 The form

The person's name, their email, the company, the plan model, the bot ceiling (default 40), **send the
welcome email** on by default, and a quiet **send the welcome to a different address** that appears
only when the checkbox is on. Nothing else. The workspace name is derived from the company and the
operator never types a slug.

### 10.2 It is a job, not a request

`POST /v1/admin/clients` answers **202** the moment the tenant row and the account row exist, carrying
`{tenant, account, temporaryPassword, signIn, jobId, steps}`. The card then polls
`GET /v1/admin/clients/<slug>/onboarding` every 2 s for the first minute and every 5 s after that, to
a 10 minute ceiling.

It has to be a job, and the reason is measured. `api.titanium.bot` is behind Cloudflare (2026-09-10:
`server: cloudflare`, `cf-ray a38fb0ce0e2ec476-AUS`), which cuts a proxied request at about 100 s. The
route already blocked for up to `CP_BOX_READY_TIMEOUT_MS=90000` plus the Coolify calls plus two relay
round trips; adding a Titan wait, an address sweep and a mail send to that guarantees a 524 with a
half-built tenant behind it **and the temporary password lost with the response**, on the one screen
where losing it costs a customer their account.

**The temporary password is in that first answer and nowhere else.** It is a scrypt hash in the store
and no route can be asked for it again. It is in no ledger row, no log line and no mail header. The
card draws it always, whatever happens to the rest of the job.

Step state lives in the **existing provisioning ledger** (`store.recordStep` and `store.listSteps`,
free-form step names, no schema change), so a control plane restart loses nothing, a page reload
rejoins the job, and the poll route is a pure read.

### 10.3 The five steps, and the observable each one turns on

The labels are Jason's own words and the card shows exactly these.

| Step | What runs | What makes it green |
|---|---|---|
| **Creating the workspace** | `cp/signup.mjs`: the account, the slug from the company | done inside the 202. Every refusal happens here and creates nothing: bad email, empty company, duplicate email, a company whose slug will not derive, new tenants off |
| **Building the computer** | `provisionTenant`'s eight steps, then a direct probe of the box's own `GET /health` | ledger step `ready = ok` **and** `detail.how = "gateway"`. A `how` of `coolify` is **not** accepted: a created container is not a booted host. Then `/health` at 3 s intervals to a 10 minute budget, because `source/host/main.ts` awaits `host.start()` before it binds 1340, so anything answering there means the host booted and Titan exists |
| **Waking Titan** | the plan model is pushed **first**, then Titan is read | the model reads back from the relay's `running` **and** `listAgents` shows a bot named Titan **and** `getOnboardingState` answers `done:false` |
| **Giving the agents their addresses** | `POST /mail/sweep` with `{slug}` | not the sweep's 200, which can be cheerfully green over a workspace it never named: `cp/mail.mjs` `directory(slug)` in the control plane's own process showing at least one active row. Titan's `agent<code>@myagents.email` is read here and goes into the mail |
| **Sending the welcome** | `cp/welcome.mjs` mints the link, renders the mail, posts it to the relay | a Resend id in the `welcome_sends` row, shown on the client's row |

**The model goes before the read, and the order is not cosmetic.** `writeBoxDefaults` writes only
`gates.json` and `{"SAND_BACKEND_URL":""}`, so a box nobody pointed at a model has Titan awake and
**mute**. If the model did not apply the step goes amber and the job stops before the welcome with
"Titan is up but has no model yet, so he would not answer. Fix the model on this row, then press Send
the welcome."

**The `running` call is doing double duty.** It is the only relay call that reaches `contextOf`, which
is the only caller of `registry.miss()`, so it forces the relay's out-of-schedule registry refresh
instead of waiting up to its 60 s timer. That is why it goes before the sweep.

Every step is one of `waiting`, `running`, `ok`, `amber` (done with a named caveat) or `failed`
(stopped, with the one thing to press). A failed step offers **Retry**, which resumes at the first step
that is not `ok`. A step with no ledger write for 3 minutes reads as stalled with the same Retry. A
failed provision **keeps the account**, because a slow image pull must not cost a customer their
existence. Nothing is ever half-green.

**Measured on the R750's control-plane ledger 2026-09-07**, the only real provisioning before this
wave: `richard-avery` ran directories through start in 0.41 s and reported `ready how gateway waitedMs
12181`, whole box 12.6 s, with the image already on the server. **Measured on this Mac in
`grok-bot-local-vm` 2026-09-10** on a fresh `SAND_DATA_ROOT`: host start to first `/health` answer
1792 ms, Titan's record at 1304 ms, `getOnboardingState` answering `done:false` with `maxAgents` 40 at
172 ms after the port opened.

---

## 11. The welcome mail

**From** `Titanium Bot <welcome@titanium.bot>`, decided by the **relay** and never by the caller.
**Reply-To** the operator's support address, setting `mail.welcome.replyTo`, default
`support@titaniumcomputing.com`, read and written with `node cp/cli.mjs mail welcome-reply-to`.
**To** the owner's address, or the override when the operator set one. One recipient, never a bcc.
**Subject** `Your Titanium Bot workspace is ready`. Click tracking off for `titanium.bot`.

### 11.1 Why the relay owns the sender

Measured on the R750 2026-09-10, read only: the relay's stored Resend key is **account wide** and lists
39 of Jason's domains, with `titanium.bot` status `verified`, region `us-east-1`. So this From sends
today with the key already on the box, no new key and no DNS. And it is exactly why the From must never
be a request field: a route that takes a From from its caller is a route that will one day send as
`jason@titaniumcomputing.com` because a config value upstream was wrong. The relay holds the sender and
the control plane sends only words.

**MAIL-3's `POST /mail/send` cannot be reused**, for four independent reasons: its credential is a
**box's** gateway token, which the control plane does not hold; `buildFrom` forces the From to the
bot's own `agent<code>@myagents.email` and deliberately ignores a caller's; `reply_to` is hard-wired to
that same address; and `cp/mail.mjs` `openSend` refuses an empty `agentId`, which every product mail
has. Reusing it would also charge the new customer's own 30 an hour and 200 a day caps for their own
welcome and put a bot-less row in their own Sent list.

### 11.2 The words the customer reads

Plain words for a business owner. No vendor names, no em dashes, no bullet ceremony.

```
  [header band: the Ti mark and the Titanium Bot wordmark, drawn in HTML and CSS]

  Hi <first name>,

  Your Titanium Bot workspace for <Company> is ready. It is a private
  computer running a small team of bots that work for your business.
  They have their own machine, they remember what you tell them, and you
  can hand them real work.

        [  Open your workspace  ]

  That button signs you in. It works for the next 24 hours and it is only
  for you, so please do not forward this note. After that, go to
  console.titanium.bot and sign in with:

  Email: <their email>
  Temporary password: <password>

  Write to us when you want that password changed.

  Meet Titan
  Titan is the bot that leads the others. Say hello and tell him about
  your business. He will ask a few short questions, then show you what he
  can take off your hands. It takes about a minute.

  Your bots have their own email
  Every bot on your workspace has a real email address. Titan's is
  <titanAddress>. Write to him from your own mail and he will answer. The
  rest are on the Mail page inside your workspace.

  Need help?
  Write to <support address> and a person will answer.

  Titanium Bot
  You are getting this because a workspace was set up for you.
```

**Both shapes ship: the button AND the temporary password on a quiet second line.** That is a decision
and not a hedge. The sso link signs them in, but there is no customer-facing set-your-own-password door
anywhere in the product (`POST /v1/accounts/{id}/password` is behind `requireAdmin`), so a mail
promising "we will ask you to pick your own password" would be the product's first lie to a new
customer, and a link-only mail locks them out at hour 25 with the operator as the only recovery. The
missing door is filed as **ONBOARD-3**.

### 11.3 The sign-in link, and what it actually is

`cp/session.mjs` already re-exports `mintSessionToken` and `tenantSessionSecret`, and the relay already
consumes `GET /login?sso=<token>` (`ui/server.mjs:3840` into `handleSso`, verified by `ssoVerdict`
against that tenant's derived key). So the link is `https://<tenant.host>/login?sso=<token>` with the
account's own `sub`, `email`, `tenant`, `host`, a fresh `jti`, `iat` now and an explicit `exp` of now
plus 24 h. All seven required claims exist on a new row, so `ui/session-token.mjs` is not edited.

Understand what this is: **a stateless bearer credential in a URL that the relay never checks for
revocation**, that works as many times as it is clicked until `exp`, and that cannot be cancelled short
of rotating `CP_SESSION_SECRET`, which signs the whole fleet out. Therefore 24 hours is a ceiling and
not a target, the link is never written to the send row, the audit row, a log line, a screenshot or a
report, and click tracking is off so a scanner does not fetch it.

### 11.4 The row, and Send again

Its own table, **`welcome_sends`** (tenant, email, at, outcome, resend_id, shape, actor, detail),
deliberately not `mail_send_log`, keeping MAIL-3's split. It holds who, whom, when, the outcome and the
provider id, and **never** the password, the link, the subject or a body. It is shown on the client's
row with **Send again** beside it.

**Send again** mints a fresh link and leaves the password alone, because the original is a scrypt hash
nobody can ask back and changing it would lock out a customer who has already signed in. A tick **with
a new password** calls the existing reset-password and includes it. The row's `shape` column records
which of `link` or `link+password` went out.

**Idempotency key** `welcome:<slug>:<sha256(to) first 16>:<yyyymmddhh>`, so a double press inside the
hour cannot mail a real human twice. `ui/mail-edge.mjs:1041` `resendSend` already carries the header and
already caps it at 256.

### 11.5 Rendering, and the one line that must never be invisible

Measured on this Mac 2026-09-10 (node v22.23.1, playwright-core 1.62.1, `deviceScaleFactor` 2): a 596 px
card in a 620 px viewport, no horizontal scroll, ground `#F5F7FA` light and `#090D14` dark, card
`#FFFFFF` and `#172232`, the button 209x46 at `#00C8F0`. The first draft rendered the **temporary
password** at 1.11:1 in dark, invisible; fixing it took the contrast walk from 6 runs under 4.5:1 to
zero in both schemes.

Gmail ignores `prefers-color-scheme`, so every colour is set inline **as well as** in the media block
and no element's readability lives only inside the query. The mark is drawn in HTML and CSS, never an
image: SVG is dropped by every major client, a data URI in an `img` is stripped by Gmail, and
`titanium.bot` hosts no raster mark (measured: `logo.png` 404s). Brand tokens Midnight `#090D14`,
Graphite `#172232`, Titanium `#E6EBF2`, Signal Cyan `#00C8F0`, Cloud `#F5F7FA`, ink `#16181D`, quiet
`#5B6472` light and `#C3CDDB` dark, rule `#E3E7EC`. Arial and Helvetica for the body, because web fonts
do not load in mail.

---

## 12. Removing a client

On the client row: **Remove**, click-again-to-confirm, then the workspace name typed to match, then a
**delete their data** switch, default **off**. `node cp/cli.mjs tenant remove <slug> [--delete-data]
[--yes]` is the CLI twin; it prints each effect as it lands and **exits non-zero** on the
container-still-there state.

### 12.1 The refusals, and not one of them has an effect

| Refusal | When | Why it exists |
|---|---|---|
| `not_found` | no such slug | there is nothing to remove |
| `adopted` | `status === "adopted"` **or** an `adopt` ledger step | a tenant this service did not build is not its to delete. On `titanium` the Coolify service behind that row **is** the live console. It reads the ledger as well as the column because `tenantPower` writes `adopted` back over a stop, so a guard reading only the column could be walked around by stopping first |
| `operator_slug` | the slug is in `RESERVED_SLUGS` | the second layer, so `titanium` stays unremovable even if its adopt row were ever lost |
| `confirm_required` | the typed confirm is not exactly the slug | a typo here closes a real company's doors |

A refused removal is indistinguishable from never having been asked. Nothing above that line touches
Coolify, the proxy, the relay, the directory or the store.

### 12.2 The nine effects, in this order

Each one is a ledger step `remove:<name>`, and one `admin_actions` row is written at the end.

1. **disable-signins** - every account for the tenant is disabled first, so nobody can sign in during
   the teardown.
2. **addresses** - every active directory address for the slug is retired. **Nothing else ever will:**
   the sweep only retires codes for agents missing from a roster it could *read*, and it cannot read a
   box that no longer exists, so a removed tenant's `agent<code>@myagents.email` would keep routing for
   ever. Retiring is permanent by design, and that is right here.
3. **proxy-key** - the tenant's LiteLLM key is revoked **before** the container. A failed revoke carries
   on with a sentence naming `cp/cli.mjs proxy revoke <slug>`: a box that is up and cannot reach a model
   is visible, a box that is gone and can is not.
4. **stop** - `POST /services/{uuid}/stop`, then a bounded wait for Coolify to stop calling the service
   running. It does **not** wait for the container name to vanish: a stopped container keeps its name
   (`docker ps -a` lists it), so that wait would burn the budget every time and prove nothing.
5. **service** - `DELETE /services/{uuid}` with `delete_configurations=true`, `delete_volumes=false`,
   `delete_connected_networks=true` and **`docker_cleanup=false`**. See section 13 for why that last one
   changed.
6. **container-gone** - **the step that matters.** Poll until the container name is absent, asking the
   relay (which holds the docker socket), and accept `GET /services/{uuid}` answering 404 as a *second*
   proof, taken only when the relay could not be asked at all. Budget 120 s. The result records **which**
   of the two proved it. If neither does, the removal **stops here**, the tenant row is **not** deleted,
   and the card says "Coolify took the record and the container is still running" with the command that
   finishes it.
7. **data** - only when the switch is on, and only after step 6 proved the container gone. The relay
   does it: it resolves the path from its own tenant root, refuses a slug failing `validateSlug`'s shape
   rules, refuses a reserved or operator slug, refuses a slug its registry still knows as reachable,
   refuses anything whose realpath is not a direct child of the tenant root, measures the tree, removes
   it and answers the bytes freed. **It never takes a path from its caller.** With the switch off the
   card says what is true: "Their data is kept at /data/titanbot/&lt;slug&gt;. Nothing deletes it on a
   timer."
8. **accounts and the slug** - `store.deleteTenant` **first**, then `store.deleteAccount` for each, then
   `store.releaseSlug` as a belt. The order is load-bearing: `deleteTenant` inserts a `retired_slugs` row
   whenever an account still points at the slug, and `deleteAccount` clears that retirement only when the
   tenant row is already gone and no account is left. The accounts are *disabled* at step 1 so nobody
   signs in mid-teardown and *deleted* here so the name is genuinely free; the retirement exists to stop
   a new company inheriting a previous customer's sign-ins, and with the sign-ins deleted there is
   nothing to inherit.
9. **audit-ready** - one `admin_actions` row: who, when, whether the data went, which proof the
   container's absence rested on, and every address retired.

**What the ledger keeps.** `store.deleteTenant` also deletes the slug's ledger rows, so step 8 wipes
`remove:disable-signins` through `remove:data` on its way past. The durable record is the returned
`effects` list and the `admin_actions` row; the one row left behind, `remove:audit-ready`, is a
breadcrumb saying this name was removed once, which the next tenant built under it usefully carries.

**There is no thirty day retention, and the card does not claim one.** There is no reaper in this
product and nothing counts days. A card promising thirty days while nothing counts them is the product
lying to the operator. **ONBOARD-4** is filed for a real one.

`DELETE /v1/tenants/{slug}` stays untouched as the low-level door for a *stopped* tenant: it removes the
Coolify service and the row and nothing else. `DELETE /v1/admin/clients/{slug}` is the customer-shaped
one described above, and the two are not interchangeable.

---

## 13. What bites

Every one of these was measured, and each one shaped a decision above.

**The Cloudflare cut.** `api.titanium.bot` is proxied and cuts at about 100 s (2026-09-10: `server:
cloudflare`, `cf-ray a38fb0ce0e2ec476-AUS`). Any onboarding built as one synchronous request returns a
524 over a half-built tenant and loses the temporary password with the response. Hence the job.

**A Coolify 200 is not a removed container.** `DELETE /api/v1/services/{uuid}` answers 200 "Service
deletion request queued" and dispatches `DeleteResourceJob` later, whose remote block is wrapped in a
catch that logs "Remote cleanup failed, continuing with local deletion" and deletes the local record
anyway. So the failure that costs the most, Coolify forgetting the service while
`titanbot-box-<uuid>` keeps running with the customer's gateway token, answers **200** and looks
exactly like success. That is why step 6 polls and why a 404 from Coolify is only a fallback proof.

**`docker_cleanup=true` prunes the whole server.** It dispatches Coolify's `CleanupDocker`: container
prune, image prune, a broader image prune, `builder prune -af`. The R750 also runs ampcortex, anvil,
Coolify's own stack, every other customer's box and about twenty more services, plus Jason's images.
Fixed to `false` in ONBOARD-2.

**A relay 401 does not mean a route exists.** The pre-flight for the R750 run was written to prove
`POST /mail/product` and `POST /tenant/purge` were mounted by watching them answer 401
unauthenticated. They do — and so does `/definitely-not-a-route-xyz` (measured on the R750
2026-09-10, from inside the relay container). The relay refuses every unauthenticated request before
it routes, so that probe proves only that the relay is up. A route's presence is proved with a
credential, or by the thing it does.

**A cp restart during an invite wrote into a closed database.** The invite is the first piece of work
on this control plane that outlives the response that started it, and the shutdown closed the store
under it: `statement has been finalized` on stderr with nothing an operator could act on, and the
job's last ledger row — the row that says where it got to — lost. `createApp` hands out its
`onboarding` handle now and the shutdown settles it under a five second cap before closing the store.

**The control plane cannot delete a tenant's data.** Measured from inside `titanbot-cp` on the R750
2026-09-10: cp runs as uid 1001, the box's `volumes/{data,workspace,chrome}` are 0700 owned by uid 1000,
and both `ls` and `touch` answer Permission denied. Only the relay (root, `/data/titanbot` read-write,
`/var/run/docker.sock`) can. That is why the purge is a relay route and why it resolves its own paths.

**One prompt on a fresh box destroys the first run for ever.** `onboarding-state.ts:139` marks a box
`done:true`, `doneReason: "existing-box"` permanently if, at the **first read**, it holds more than one
bot or any agent with a prompted conversation. There is no error and no way back: `resetOnboarding`
answers 403 without `SAND_TEST_HOOKS`. So every box read the invite makes is `listAgents` and
`getOnboardingState`, **never** `sendPrompt` and never `createAgent`, and the gate fails if either
appears. The inverse is protective: a `getOnboardingState` read on a fresh box *writes* `done:false`
and locks the first run in, so the card doing it early is a feature.

**The relay's registry is up to 60 s stale.** Only the `running` call reaches `contextOf`, the only
caller of `registry.miss()`, so it is what forces an out-of-schedule refresh. It has to come before the
sweep, or the sweep runs over a registry that has never heard of the new workspace.

**The sweep is fleet-wide unless it is given a slug.** `mailMintSweep` walks `registry.all()` and makes
a `listAgents` and a `setAgentMail` call into **every other customer's box**, so onboarding one client
reaches into Richard's and Jason's, and the cost grows with the fleet. The per-slug shape is what the
invite uses; an empty body keeps today's fleet behaviour, so `cp mail sweep` is unchanged. A 503 "a
sweep is already running" is retry in a moment, never a failed onboarding: four tries with backoff.

**`/api/health` is not a path the host serves.** The readiness wait used to probe it and counted any
answer, which meant it counted the 404 too, so "the box is up" was a sentence about a path that does not
exist. Corrected to `/health`, which is what the relay's own per-tenant health proxy asks
(`ui/server.mjs:4444`), and the measured status now goes into the `ready` step's detail so a reader can
tell a real 200 from an answer that only proved the socket was open.

**The sign-in link is an unrevocable bearer.** See section 11.3. It works until `exp`, as many times as
it is clicked, and nothing short of rotating `CP_SESSION_SECRET` cancels it.

**There is no customer set-a-password door yet.** Filed as ONBOARD-3. It is why the welcome carries the
temporary password as well as the link.

**A half-provisioned orphan, and what the operator does about one.** `north-bay-roofing` is sitting on
the R750 with 6.2 MB of directories, a gateway token, **no tenant row and no ledger rows**, which is
exactly what a failed add used to leave behind. The recovery is the product's own and never a hand
cleanup: press **Retry** on the card, and if the tenant cannot be finished, **Remove** it with delete
their data on. For an orphan with no tenant row at all, `node cp/cli.mjs tenant orphans` lists the
directories the ledger has never heard of, and the relay's purge is what deletes one.

---

## 14. The invite's gates

```sh
node scripts/verify-onboard.mjs --remove-only   # the removal, driven straight at cp/decommission.mjs
node scripts/verify-onboard.mjs                 # the whole sequence as well, over the admin routes
node --test tests/cp-remove.test.mjs tests/cp-provision.test.mjs
```

`verify-onboard.mjs` stands up a fake Coolify, a fake relay, a stub Resend and a stub box **in its own
process**. Nothing repeatable ever touches `api.resend.com`. The sign-in link is read out of the
captured mail, exercised against the stub relay's `/login?sso=`, and then dropped: it is never written
to a file, a log line, a screenshot or the gate's own output.

Two things the gate is built to catch rather than to confirm:

- **The fake Coolify's DELETE is asynchronous, because the real one is.** `deleteDelayMs` makes the
  container linger after the 200, and `neverRemoves` models the catch-and-continue: the record goes and
  the container never does. Against `neverRemoves` the removal **must** report NOT ok. A gate that
  passed there would be certifying a removal over a live container holding a customer's gateway token.
- **The stub box counts every gateway call it is asked for.** A `sendPrompt`, a `createAgent`, a
  `duplicateAgent` or a `startOnboarding` fails the leg, because any one of them on a fresh box ends
  that customer's first run for ever.

**Measured on this Mac 2026-09-10, node v22.23.1, the removal arm:** `verify-onboard --remove-only`
**19 passed, 0 failed, 0 not measured**; `node --test tests/cp-remove.test.mjs` **24 passed, 0
failed**; `tests/cp-provision.test.mjs` **35 passed, 0 failed**. A delete whose remote half landed
150 ms late was waited for and reported `provedBy=docker` after 175 ms.

The whole-sequence arm reported **not measured** with the reason on a tip where `POST
/v1/admin/clients` was not yet the job-shaped route. On the merged tip it measures: **26 passed, 0
failed, 0 not measured** on this Mac, 2026-09-10, node v22.23.1.

Three things had to be true for that arm to measure anything at all, and none of them was obvious:

- **`CP_BOX_URL_OVERRIDE`** is how a gate points the sequence's box reads at a stub. A box answers at
  `http://titanbot-box-<uuid>:1340` on the docker bridge, which a gate running its own control-plane
  process has no route to. It goes through `loadConfig`, **not** `process.env`, because the gate builds
  its control plane in-process and never sets the ambient environment. It is empty on the R750 and the
  install never writes it; a production value would send every customer's box read to one address.
- **`tests/cp-support.mjs`'s fake relay answers `read: true`** on the ceiling and running routes,
  because the real relay does (`ui/server.mjs`, the ceiling route and the running route both carry
  it). It means THE BOX ANSWERED, as against the route merely working. Without it the fake looked
  healthy while the sequence correctly read every answer as "nothing could be read back" and stopped
  amber before the welcome.
- **That fake's sweep mints through the control plane's own door.** The real relay mints nothing
  itself: it reads the roster and POSTs it to `/v1/relay/mail/mint`, which writes the row that
  `cp/mail.mjs directory(slug)` later reads. A sweep that only answered 200 left step 4 retrying to
  its budget, which is right — step 4's green is a directory read and never the sweep's own answer.

### 14.1 The seam, and why it has its own file

`tests/onboard-seam.test.mjs` runs the real sequencer against the **real** welcome sender and the
**real** removal library, with nothing stubbed between them.

It exists because of what happened on the first merged tip. The wave was built as three items that
merge topologically, and each one's suite passes standalone by injecting a double for the other two.
All three were green and **both of the things this wave is for were broken**:

- `cp/onboard.mjs` looked for a flat `sendWelcome(asked)`; `cp/welcome.mjs` ships a `createWelcome()`
  factory whose `send()` takes the owner's address as `email` and returns the link as `signInUrl`.
  Every customer's welcome step would have gone amber.
- `cp/admin.mjs` looked for `removeClient`/`plan`; `cp/decommission.mjs` ships a
  `createDecommission()` factory returning `remove`/`plan`. Remove would have answered "this control
  plane has no removal in it" on every press.

Both call sites now accept the factory shape and the flat shape, so the doubles still work and the
product works. Three more spellings had drifted the same way: the state route emitted `key`/`state`
while `cp/cli.mjs`'s printer and the gate read `name`/`status` (both are carried now, or `signup add`
prints `undefined` five times and collapses the rows into one); the gate asked for `welcome: true`
where the route reads `sendWelcome`, so it ran five steps and mailed nobody; and the gate read the
**first** `ready` ledger row rather than the last, which is the provisioner's older opinion rather
than the box answering.

And one that a double could never have shown: the adapter's first cut took the person's name from
`plan.name`, which is the **company** — the invite route passes `name: company` when it starts the
job. The first line of the first thing the product ever sends a customer read **"Hi Acme,"**. The
greeting comes off the account row now.

The rule this leaves behind: **a wave built as parallel items needs one test that uses none of their
doubles.** Three green suites proved each item correct and proved nothing about the product.

**And that rule was not enough, which the review found the same day.** This file's seam test was
green, the four ONBOARD-2 suites were 78/78, and **Remove with "delete their data" on could not
delete data, ever.** `cp/decommission.mjs` sent `{slug}`; `ui/purge-edge.mjs` refuses anything whose
`confirm` is not the slug, needs the container name carried, and answers `removed`/`freedBytes` rather
than `deleted`/`bytesFreed`. So the request was a `400`, the success test was false even on success,
and the card told the operator their data could not be deleted. Nothing caught it because **both
fakes had been written from the caller's side**: `tests/cp-support.mjs` and this file's own relay each
hand-wrote a purge answer in the shape the caller expected, and `tests/relay-purge.test.mjs` asserted
the opposite on the other side of the same wire. "Nothing stubbed between them" was true of the two
libraries and false of the HTTP hop, and the break was on the hop.

So the rule grows a second half: **when a wave ships both ends of a new HTTP contract, the test that
joins them uses the REAL route, not a hand-written stand-in for it.** `tests/purge-double.mjs` builds
the `/tenant/purge` double out of `createTenantPurgeRoute` itself and injects only the three things a
test machine cannot have -- which containers are on the host, whether the console can still reach the
workspace, and how big a tree is. Every caller's test uses that one double, so a field changing on
either side fails every test that depends on it in the same commit. The body and the answer are
written down in docs/TENANCY.md §13.1, which is where they should have been on day one.
