# First run: the setup conversation with Titan (ONBOARD-1)

The first time somebody opens the console on a new box, Titan introduces himself and asks five
short questions. This file is the contract between the console and the host. The console half is
built; the host half lands beside it, and the section at the foot says exactly what the console is
calling.

## What a person sees

A dialog opens under the window bar, the width of the stage, with the chat still there behind it.
In it: Titan's own face, large and live; a line saying who he is; the five questions as a strip
that fills in as he gets each answer; his conversation, with a box to answer him in; and **Skip for
now**.

Titan speaks first. He says he is the person's main Titan, the bot that leads the rest of them on
the box, then asks, one at a time and in plain words:

| The strip says | The host stores it under |
| --- | --- |
| Your name | `name` |
| Where you are | `location` |
| What kind of work | `business` |
| Whether you own it | `ownsBusiness` |
| How you want to work | `workingStyle` |

Then he walks through what he can do, and closes by asking what they want done first.

**Skip for now** closes the dialog and tells the box setup is finished, keeping whatever he already
captured. Escape does the same thing, so a dismissed dialog never comes back on the next load with
nothing recorded. If the box refuses the write, the dialog stays open and says why: closing on a
flag that did not move would bring the dialog back, which is worse than not offering skip.

## Where the console code is

- `ui/machine-room/index.html` — the `<dialog id="onboarding-dialog">`, and the count on the Add
  button.
- `ui/machine-room/onboarding.css` — everything the dialog is styled with, in its own file so it
  never collides with `styles.css`.
- `ui/machine-room/app.js` — one block, between `// ===== ONBOARD-1` and `// ===== end ONBOARD-1`,
  plus the `AGENTS-CAP-1` block for the cap.
- `ui/machine-room/gateway-adapter.js` — the three calls, under `// ---- ONBOARD-1`.
- `ui/machine-room/adapter.js` — the offline fixture.
- `tests/machine-room-onboarding.test.mjs` — the unit tests, which run the shipped blocks.
- `scripts/verify-dashboard.mjs --offline` — the dialog rendered in a real browser with no host.

## What the console calls, and what it does when the answer is missing

**`getOnboardingState()` → `{ done, startedAt, answers }`.** Read once at boot. The dialog opens on
`done === false` and nothing else. It is called through `tryCall`, so a host that does not know the
command answers `null` — which means *this box cannot say*, not *this box is in its first run* —
and the console opens nothing at all. While the dialog is open the console asks again every 2.5
seconds, because Titan writes an answer the moment he gets it and nothing pushes that to the page.
`done: true` coming back closes the dialog on its own, which is how the interview ends.

**`completeOnboarding({ answers })`.** Skip for now, and Escape. The answers the console holds go
with it.

**`sendPrompt` with `onboarding: true`.** Titan's opening line. The console sends this itself,
because the fresh-box first agent is minted through `createFallbackSession` rather than
`mintAgentSession`, so `setIntroductionPending` is never set and the host's own kickstart will not
fire on it. The marker is what tells the host to put the onboarding prompt on the turn. The prompt
text the console sends is a cue, not a script: the words Titan says are the host's. A host that
does not know the marker forwards the send without it and Titan answers as himself, which is a
plainer first turn rather than a wrong one. Once the conversation is running, the person's replies
go through the ordinary `sendPrompt` — the host keeps the onboarding prompt on while the flag is
`false`.

## The cap: Titan and twelve more (AGENTS-CAP-1)

A box holds 13 bots. The console draws that in two places:

- the roster header, `n / 13 bots`. The number is the bots the console can see, **not**
  `countAgents`: a room is an agent to `countAgents` and is not a bot, so counting rooms against a
  cap that excludes them would put two numbers that disagree side by side. The host's own count is
  on the tooltip.
- the Add button, `n of 12` — how many of the twelve beside Titan are taken, said before anyone
  clicks rather than after they are refused.

Both follow `state.agentCap` when the host reports one, and fall back to 13.

When `createAgent` is refused, the console shows the host's own sentence as a toast, word for word.
If an older host refuses with something less readable, the console says the plain one instead:

> This workspace holds Titan and 12 more bots. Remove one to add another.

## Reading the dialog with no host

`?onboarding=1` on the console URL arms the offline demo adapter: it reports `done: false`, renames
the first agent Titan and clears his conversation, so the page looks like the box the dialog is
really for. Without the flag nothing changes, which is why every other offline view of the console
still opens the way it did. `window.__machineRoomOnboardingDemo = true` before boot does the same
thing from a test.

## What the host still owes this console

1. `getOnboardingState` and `completeOnboarding` as gateway commands, over a box-level
   `onboarding: { done, startedAt, answers }` in `settings.json`.
2. The migration rule, so an existing box is never thrown into setup.
3. The `onboarding` marker honoured on `sendPrompt`, and the seed prompt behind it.
4. `save_onboarding_answer { field, value }` writing the five field names in the table above. A
   rename on either side leaves a strip that never fills.
5. `SAND_MAX_AGENTS` (default 13) enforced in `createAgent` / `duplicateAgent`, refusing with the
   sentence above and not counting groups. Reporting the number as `agentCap` lets the console draw
   a cap the operator changed.
