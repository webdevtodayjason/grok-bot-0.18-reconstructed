# First run: meeting Titan

**What this is.** The first thing a person sees when they sign in to their own instance, and the
contract the two halves of it are built to. Titan introduces himself, asks five short questions,
walks through what he can do, and asks what they want done first. Underneath it: one flag on the
box, three gateway commands, two tools, one seed prompt, one dialog in the console, and a ceiling of
thirteen agents.

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
    "agentId": "…",
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

`agentId` is Titan's, and it is what the console binds the dialog's conversation to.

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

### 5.6 The cap and the capability

`getHostStatus` gains `maxAgents` and lists `onboardingV1` among its `capabilities`, beside
`sendAcceptanceV1`. The console reads that status at boot already, so the Add button gets the number
it counts against with no second call.

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

## 8. The ceiling: Titan and twelve

**A box holds 13 agents: Titan and 12 more.** `SAND_MAX_AGENTS` in `sand-host-settings.json`
overrides it; the default is 13. Groups do not count. The crew this console draws faces from is
exactly Titan plus twelve companions (`mascot-crew.js:33-47`), so thirteen is the size the product
was already drawn at.

It is enforced at one place, `mintAgent` (`session-materialization.ts:81`), which both `createAgent`
and `duplicateAgent` funnel through. The refusal a person sees is one sentence:

> This workspace holds Titan and 12 more bots. Remove one to add another.

Templated from the ceiling in force, so a box with `SAND_MAX_AGENTS` set reads its own number. No
status code, no class name, nothing about limits or maximums. It reaches the console as HTTP 409
(`statusForCommandError`, `gateway-server.ts:15`) and the console shows the sentence as a toast. The
Add button carries the count: **n of 12**, where n is the agents besides Titan.

The roster header carries the same ceiling, `n / 13 bots`, counted off the roster the console can
see rather than off `countAgents`: a room is an agent to `countAgents` and is not a bot, so
counting rooms against a cap that excludes them would put two numbers that disagree side by side.
The host's own count is on the tooltip. Both numbers follow the ceiling the host reports on
`getOnboardingState`, and fall back to 13.

**One trap left, and one that is closed.**

The closed one, written down because it is what the shape of this code is explaining. The limit used
to live in two files that were not wired to each other: `session-materialization.ts` held
`MAX_AGENTS_PER_USER = 50` and its own `SandAgentLimitError`, `shared/agents/agents.ts` held a second
constant, a second class of the same name, and `SAND_AGENT_LIMIT_MESSAGE = "50 is the maximum"`.
There is one of each now. The ceiling is `SAND_DEFAULT_MAX_AGENTS = 13` (`agents.ts:64`), the class is
declared once beside it (`agents.ts:74`) and re-exported from `session-materialization.ts:28` so the
old import path still works, and no `MAX_AGENTS_PER_USER` is left anywhere under `source/` (the only
mention now is the word list the gate uses to keep jargon out of the refusal a person reads).

The trap that is still live: `isSandAgentLimitError` (`agents.ts:89`) is what two callers use to
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
