# Reporting a problem to the developers

**Status:** built by Wave C, 2026-09-09. Row `FEEDBACK-1` in `GAP-ANALYSIS.md`. This file is the
contract: every name below is binding — the payload's field names, the gateway command names, the
relay route, and the words the person reads.

Jason, 2026-09-07: *"Titan tried to cover up failure. We need to instill in the agents that failure
must be reported... 'Would you like to submit this feedback to the developers?' ... it should come in
somewhere and then become a GitHub issue."*

Titan's own design, from the morning of 2026-09-09, added the shape: three tiers with automatic
routing, a structured payload, and one constraint that decided the whole architecture — **it never
goes around the operator.**

## 1. Two gates, and "operator" means the first of them

| | who | what they see | what they decide |
|---|---|---|---|
| **First gate** | the **workspace operator** — the person in the console. Jason, or a customer | every report an agent writes, in full | edit it, add context, send it, or drop it. Nothing leaves the workspace until they press Send |
| **Second gate** | the **super admin** — the developers | only what was sent, in the admin console's Feedback panel | edit, suppress, or turn it into a GitHub issue |

Tiers change **how loudly a report is shown, how it filters, and how the digest batches it, and
nothing else.** Critical, quality-of-life and observation all pass through both gates. There is no
tier that skips a person.

## 2. Why that is topology and not a rule

The agent's tool **posts nothing anywhere.** It writes a pending report into the box's own store and
returns a sentence. The console — already authenticated as the tenant — draws it, and is the only
thing that POSTs. Three guarantees fall out of that for free, and none of them is a check anyone can
forget to write:

- **No control-plane credential is ever inside a customer's container.** Both cp doors are fatal
  there: `CP_RELAY_TOKEN` reads every tenant's gateway token and derived session key, and
  `CP_ADMIN_TOKEN` deletes services. Every exec daemon in a box runs as uid 0, so a token in that
  container is readable by that customer's own agents through `/proc/self/environ`.
- **A box cannot file as another tenant,** because it never names one. The relay stamps `workspace`
  from its own registry and ignores anything in the body.
- **"The operator saw it before it left" is true by construction,** not by review.

```
agent  ──report_problem──►  <sand-data>/problem-reports.json      the box. no network.
                                    │  listProblemReports
                                    ▼
console (signed in as the tenant)   the card: editable, custody line, Send / Not now
                                    │  POST /feedback           same origin, the person's own session
                                    ▼
relay (ui/server.mjs)               stamps `workspace` from its registry, adds CP_RELAY_TOKEN
                                    ▼
control plane                       POST /v1/feedback → the Feedback panel → GitHub issue
```

## 3. ProblemReport v1

Minted identically by the agent's tool, by the automatic offer, and by the self-test.

```jsonc
{
  "version": 1,
  "tier": "critical" | "quality" | "observation",
  "category": "shell",                    // one or two words the person would recognise
  "title": "The shell refuses every command",
  "description": "…",                     // what the person read and may have edited
  "steps": ["…"],
  "tools": [{ "name": "Shell", "status": "failed", "error": "…" }],
  "evidence": {
    "agent": "<agent id>", "agentName": "Titan", "conversation": "<agent id>",
    "hostVersion": "…", "consoleVersion": "…",
    "calls":    [{ "name": "Shell", "status": "failed", "summary": "…", "output": "…" }],
    "messages": [{ "role": "you" | "agent", "text": "…" }]
  },
  "at": "2026-09-09T…Z"
}
```

`workspace` is **absent on purpose** and is filled by the relay and by nothing else.

`evidence` is built **only from the conversation outline and the transcript** — never from a file,
never from an environment, never from the two secret stores. Token-shaped runs are masked by the
page's own masker (`maskSecrets`) before the card is drawn, so what is on screen and what is sent are
the same bytes.

### What "you can edit it" actually means

The card says *"What you see below is what is sent."* That claim is kept, and it costs something:

- **Untouched** — the person approved exactly what the agent wrote, so `steps`, `tools` and
  `evidence.calls` / `evidence.messages` ride along in structured form as well as in the body.
- **Edited** — `steps` is emptied, each tool keeps its `name` and `status` but loses its `error`, and
  `evidence.calls` / `evidence.messages` are **dropped entirely.** Only the text the person left goes.

A card that says "edit anything below" and then ships an uneditable copy of what you just deleted is
a custody lie, and it is the same class of lie the credential card was rewritten to stop telling
(SECRET-1). Pinned by `tests/machine-room-feedback.test.mjs`.

## 4. The agent's tool

`source/host/runner/tools/problem-report-tool.ts`. Tool id `PROBLEM_REPORT`, name `report_problem`.

**The tool's name is never shown to the person.** In the transcript it is one quiet muted line —
`Reported a problem to the developers` — with an empty detail, so no expander and no arguments.

It is a **plain zod agent tool, not a `defineCommunicateTool` one,** and that is load-bearing. A
communicate-wrapped tool lands in the outline as `communicateUpdateToolCall`, and the console's
`NOT_A_RECEIPT` filter drops every row whose name matches `/communicate|update_state|todo|…/`. The
box-help template — otherwise the closest shape in the tree — would have produced **no chip at all,**
which is the very failure this item exists to fix. It rides the protocol's `reportBugToolCall` case,
whose fields (`title`, `description`, `severity`, `category`, `rationale`) already fit the payload.
`tests/problem-report-tool.test.mjs` pins the outline name against that filter.

**Registration** is eight edits in `turn-toolset.ts` (import, hint, factory input, provider hook,
factory, wiring, projection, push) plus the provider hook in `host-runner-composition.ts`. The push
is **unguarded**: a subagent, a box-scoped runner and a desktop-less box all have faults worth
reporting, and each is exactly where "Titan tried to cover up failure" came from. A shared-room
member is the one exception, filtered out by `SHARED_ROOM_TOOL_NAMES` — a room is cross-user, and a
report there would be about someone else's product.

**The sentence the model reads back** never says anyone has received it, because nobody has:

> Written down and shown to the person in their console, where they decide whether it goes to the
> developers. Nobody has received it yet, so do not say that anyone has.

## 5. The pending store

`<sand-data>/problem-reports.json`, mode 0600, `{ "version": 1, "reports": [...] }`, capped at 50
with the oldest dropped. `source/host/extensions/feedback/problem-reports.ts`.

It sits under the sand-data root on purpose: the Read tool refuses that whole root (TOOLS-READ-2), so
one agent's quoted tool output does not become another agent's context through a file it could read
back. It is not a secret store — nothing in a report is a credential — but it is 0600 anyway, because
a report quotes tool output and tool output is not always as harmless as the model thought.

Two gateway commands, both reads or removals, neither of which sends anything anywhere:

- `listProblemReports {}` → `{ reports: [...] }`
- `resolveProblemReport { id, outcome: "sent" | "dropped" }` → `{ id, outcome, resolved }`

`sent` and `dropped` clear the same row. This file is the box's queue of what the operator has not
seen yet; once they have seen it, the box has no further part in it. What happened to a sent report
is the control plane's record.

## 6. The console

### The two controls that are always there

Beside the composer: **Report a problem** and **Run a self-test.** They are there whether or not
anything has gone wrong, which matters because of §6.3.

### The automatic offer, and the measurement that shaped it

**MEASURED on `grok-bot-local-vm`, 2026-09-09:** a model-endpoint failure writes **no `turn-failed`
row.** The host logged the failure in 3 s, the tray fired, both transcript reads came back with
messages only, and the page showed the person's own bubble plus "Accepted by the host" for thirty
seconds with the roster card still green. An offer keyed on the `turn-failed` entry would therefore
**never fire on the commonest failure there is.**

So the offer is built at **tray-narration time** (`reloadTrays`, `gateway-adapter.js`). Two things
changed there and nothing else:

1. The line pushed into the conversation was `That turn failed: ${title} - ${detail}` — literally
   `That turn failed: Agent failed to respond — fetch failed`. That is the machine's own spelling of
   a problem the person can do exactly one thing about, and it is the presentation
   `host-notes-read-as-errors.md` bans. It is now: *"Titan could not finish that one. Ask again, or
   send the details to the developers."* **No raw provider wording reaches the conversation at all.**
2. The tray's own words become a **report seed**, which the page turns into the offer card. The
   technical half is not thrown away — it is on the card, where the person can read it, edit it, and
   decide.

**The second trigger** is the same tool failing three times in one conversation, counted off the
woven tool rows. It fires **once per tool per conversation,** not once per failure.

### An unanswered offer dies with the page

Said plainly because it is a real limit and not a bug to be discovered later. The offer cards are
**page-local by construction**: they are not transcript entries, and the box's transcript has no
record of them. Close the tab on an unanswered offer and it is gone.

Two things make that survivable, and both are why they exist:

- The **box's own pending file** is re-read on every load, so anything an agent wrote through the
  tool is offered again. Only the two console-side triggers (a failed turn, a repeated tool failure)
  are lost.
- The **always-present Report a problem control** means the door is never closed.

**And the sharp edge of that, said here rather than discovered.** "Re-read on every load" is exactly
and only what it says: `drainPendingProblemReports()` runs once, at first paint, and nothing polls
afterwards. So when an agent calls the tool while the person is already sitting in front of the
console, the transcript draws its quiet "Reported a problem to the developers" row within the turn
and **the card does not arrive until the page is loaded again.** Measured on
https://console.titanium.bot as the demo customer, 2026-09-09: the chip was there inside the turn and
no card had appeared 275 seconds later; one reload and the card was there, editable, and it sent.
Nothing is lost — the report is in the box's own file until somebody answers it — but the person is
shown a chip with no card behind it, which reads as the product swallowing the report. That is the
one shape of this feature that still looks like the complaint it was built to answer, so it is filed
as its own owned row, **FEEDBACK-1b**, with the call site named.

### The console's own build number

Did not exist before this. It is the first 8 hex of a sha256 over the page's own `app.js`, computed
once at load and cached in memory. Self-maintaining and true, where a hand-kept literal goes stale on
the first ship. It needs nothing from the relay.

### The self-test

**Run a self-test** sends a fixed prompt carrying Titan's own six sections — shell and file I/O, web
tools, connectors, desktop and browser, state and memory, and agent management (read-only; nothing is
created, changed or deleted without being asked) — and its reporting table `Tool | Status | Error`.
The agent answers, then offers the answer as a report at tier `observation`.

Its known-limitation line is worded to match the Read tool's refusal (TOOLS-READ-2), so the checklist
**stops teaching agents to file a deliberate boundary as a bug** — which is exactly how TOOLS-READ-1
and TOOLS-READ-2 came to be filed.

## 7. Tier routing, as it actually behaves today

Measured against what is built, not against what is planned:

| tier | today | planned |
|---|---|---|
| **critical** | raises the count on the admin console's Feedback panel and sorts to the top | notify the super admin out of band |
| **quality** | batched by a CLI verb (`cp/cli.mjs`) into a digest, run by hand | the same digest on a timer |
| **observation** | sits in the panel as backlog, filterable by tier | a monthly summary |

**Nothing sends mail.** Mail is Wave A's, and a tier that promised an email nobody wired would be the
same class of claim this whole item exists to stop.

## 8. The persona sentence — **Wave A's to paste, verbatim**

This belongs in `system-prompt.ts`, which Wave C does not touch. It is written here so it is not
paraphrased on the way across:

> When a tool fails, say which one and what it answered, and say what you will try next. Do not call
> a failure temporary unless that same step has succeeded before. Do not present a workaround as a
> success. If the failure blocks the work, offer to report it to the developers and use the
> reporting tool when the person agrees.

## 9. TOOLS-READ-2, decided

The Read tool refuses `/home/box/sand-data/…` while the Shell tool reads the same file. Titan filed
that as inconsistent access control, and it was — the refusal protected nothing while a root shell in
the same container could `cat` it.

**No shell fence ships,** and the reasoning is stated rather than buried:

- The shell deny list the brief assumed **does not exist.** The shell executors are registered with
  no guard; the only deny list in the tree is a network one for the macOS sandbox. The honest seam is
  a preflight hook passed in a file this wave does not own.
- Every exec daemon runs as **uid 0**, so any command-text glob is bypassed with `base64` or
  `python`. A fence that a two-character change defeats is theatre with a maintenance cost.

What ships is the **refusal reworded in plain words**, true of the whole sand-data root rather than
pretending it is only about secrets, plus a test that states the Read/Shell asymmetry as intended.
**CUSTODY-1 is the real fix** — run the agent shell as an unprivileged uid — and it is a box-image
change, not a tool change. TOOLS-READ-1 is the same condition (`agent-data` is a symlink to
`sand-data` and the guard resolves realpaths) and closes with it.

## 10. Files

| what | where |
|---|---|
| the tool | `source/host/runner/tools/problem-report-tool.ts` |
| registration | `source/host/runner/tools/turn-toolset.ts`, `source/host/host-runner-composition.ts` |
| the pending store | `source/host/extensions/feedback/problem-reports.ts` |
| the two commands | `source/host/gateway-protocol.ts`, `source/host/host-gateway-api.ts` |
| the quiet chip | `ui/machine-room/gateway-adapter.js` (`TOOL_LABELS`, `toolRowText`) |
| the offer seed | `ui/machine-room/gateway-adapter.js` (`reloadTrays`) |
| the card, the triggers, the self-test | `ui/machine-room/app.js` (the `FEEDBACK-1` block) |
| the controls | `ui/machine-room/index.html`, `ui/machine-room/styles.css` |
| the relay door | `ui/server.mjs` (`POST /feedback`) — Wave C item A |
| the control plane | `cp/feedback.mjs`, `cp/server.mjs`, `cp/store.mjs`, `cp/cli.mjs`, `cp/admin.mjs` — Wave C item A |
| tests | `tests/problem-report-tool.test.mjs`, `tests/machine-room-feedback.test.mjs` |
| the gate | `scripts/verify-feedback.mjs` |
| the panel | `docs/ADMIN.md` §Feedback |

---

## 11. Measured

Every number names the machine it was measured on. Nothing here is planned.

**On the R750, through the customer's own door** (https://console.titanium.bot signed in as the demo
account in real headless Chrome, bundle `7af8ac2316fd`, 2026-09-09):

- The demo bot called the tool. The transcript drew **exactly one muted row, "Reported a problem to
  the developers"**, and the tool's own name appears nowhere in the rendered page text.
- On the next load the card carried the agent's own title, its tier chip, the custody line and an
  **editable** body. The person added a line, pressed Send, and **one** POST left the page.
- Within one reload the report was listed at https://api.titanium.bot/admin: tier `critical`,
  workspace `demo` (stamped by the relay, never read from the body), state `new`. The panel is the
  seventh section and the page draws seven panels and no more.
- **Approve** wrote `approved` with who decided and when. **Create GitHub issue** answered, in these
  words, *"the issue body is ready; paste a repo token in the Feedback panel and press this again"*,
  with the whole issue body rendered and **zero requests sent anywhere**. The door is proven and
  unfired because no repository token has been pasted, and none is ever pushed into a box.
- The **automatic offer** was measured the same day on the same console on a genuinely failed turn
  (BOX-6 transcript corruption on the demo Titan): the card appeared with the plain-words sentence
  "Titan could not finish that one", the raw provider wording was nowhere in the conversation, and it
  sent. It is report #1 in the panel.

**On grok-bot-local-vm** (bundle `df1300366eb2`, 2026-09-09):

- `verify-feedback` (the console arc in real Chrome, POST body captured): **27 passed, 0 failed**.
- `verify-feedback --box` (the pending file and the two gateway commands): **5 passed, 0 failed, 1
  skipped** (the toolset-trace leg, which needs `SAND_TOOL_TRACE`).
- `verify-feedback --agent` (a real scratch agent calls the tool, then is deleted): **4 passed, 0
  failed** — the pending file carried ProblemReport v1 with the agent's own title.

**On this Mac:** `verify-admin` **300 PASS, 0 FAIL** over the control plane, the panel, the two
gates on every report, the credential refusal and the leak sweep.

**Still wave A's to land:** the persona sentence in §8. It is not in the standing role yet, checked
in the merged tree 2026-09-09. Filed as **FEEDBACK-1c**.
