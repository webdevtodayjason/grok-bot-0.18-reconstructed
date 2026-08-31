# UI truth table — what is real, what is fiction

Produced 2026-08-30 by a 64-agent audit (7 region readers, one adversarial verifier per REAL
claim, one synthesis). 164 controls classified. Zero agent errors. The verifier's default was
"not real", so a REAL verdict had to survive an attempt to refute it.

Headline as found: **~29 REAL, ~8 LOCAL, ~39 MOCK, ~25 STUB, ~9 BROKEN.** The text plumbing is
genuine; nearly everything around it -- status, outcomes, policy, progress -- was fixture wearing
live styling. Wave 1 closed the tier that writes fiction into permanent records or vouches for
safety that does not exist. The rest of this list is the standing work queue.

# Machine Room UI — Operator's Truth Table

## 1. The honest headline

About a third of this UI is real, and it is not the third you would guess from looking at it. The plumbing that carries text is genuine: `listAgents`, `getAgentTranscript`, `sendPrompt`, `getAgentAutomations`, `createAgent`, `createGroup`, `setGroupMembers`, `runAgentAutomationNow` all reach the gateway with the correct argument names. Everything *around* that plumbing — status, progress, outcomes, policy, files, plugins, desktop, teaching — is either demo fixture, a wrong-key read of a good response, or a success toast fired over a `notWired()` no-op. Of ~110 distinct controls: **~29 REAL, ~8 LOCAL (honest browser-only), ~39 MOCK (fabricated data wearing live styling), ~25 STUB (inert), ~9 BROKEN root causes**. The dangerous part is the ratio *inside the confident-looking widgets*: every green pill, every progress ring, every "passed", every "is working", every safety-policy control in this build is paint. And the failure mode is inverted from what you would want — when the gateway is unreachable the app silently falls back to the demo adapter and renders a **more** convincing, fully-functional-looking machine than when it is connected.

One correction to the audit itself before you use it: the dock row "Dock button: Browser — REAL" and the desktop row "app preview: Terminal — REAL" are **stale**. Three independent live reproductions against the running box (POST returns `200 {"launched":"browser"}`, zero chrome processes at t+12s, `sh: 1: Syntax error: "then" unexpected`) refute both. Treat both as BROKEN. `docs/PLUMBING-AUDIT.md:576` ("The Terminal surface is real") is stale for the same reason and needs correcting.

---

## 2. Lies to fix first — every MOCK, ordered by how badly it misleads

### Tier 1 — writes fiction into a permanent record, or vouches for safety that does not exist

**1. Teach flow: the skill-draft card the agent "posts"** — `app.js:886`
- **You see:** a violet card in the real transcript, attributed to the real agent by name and avatar: title `"Task learned from screen recording"`, body `"I’ve attached the recording to a new skill draft."`, description `Analyzing actions and decision points inside ${contextName()}.`, tags `skill draft` / `recording attached` / `review required`.
- **It is:** fabricated locally after `finishTeaching()` returned `notWired("Teaching from a demonstration")`. The adapter's own anti-fabrication guard is `const fabricated = message.type === "text" && message.authorId && message.authorId !== "you"` (`gateway-adapter.js:400`) — this message is `type: "skill"`, so it walks straight through into the live transcript. Nothing was recorded. No skill exists. It vanishes on the next SSE `reloadActive()`, so you conclude the UI *lost* your skill.
- **Fix:** widen the guard to `message.authorId && message.authorId !== "you"` regardless of type, and delete the injection at `app.js:884-887`.

**2. Test-run result card + "✓ … passed in Xs" toast** — `gateway-adapter.js:363-368`, `app.js:951-953`
- **You see:** `✓ Weekly audit passed in 0.3s` as a toast, plus a green `routine-result` card in the agent's own transcript.
- **It is:** `routine.lastRun = { status: "passed", duration: \`${seconds}s\` }` written on *any* non-throwing response. `seconds` is the latency of the HTTP dispatch, not the run. The gateway is never asked whether the run passed. Same guard hole as above (`type: "routine-result"`).
- **Fix:** stop writing `status: "passed"`; render `dispatched` and nothing else until real run status comes back from `getAgentAutomations`.

**3. Natural-language auto-review toggle + rule textarea** — `gateway-adapter.js:126-129`
- **You see:** a switch reading ON with the rule `"Approve read-only tools. Ask me before external writes, purchases, deletions, or sending messages."` under the subtitle "Keep external writes and irreversible actions behind a human gate."
- **It is:** a client-side literal in `DEFAULTS`. No gateway command is ever asked for a policy. Clicking the switch does only `target.setAttribute("aria-pressed", ...)` (`app.js:968`) — it doesn't even update local state, so it resets to ON on the next render. There is no gate. Every action that sentence names is ungated.
- **Fix:** delete the section, or render it disabled with "no policy engine on this host".

**4. "Router online" status pill** — `app.js:798`
- **You see:** `<span class="status-pill success">Router online</span>` at the top of Operator settings.
- **It is:** a string literal. `GET /health` exists at `server.mjs:262` and the machine-room bundle never calls it. This pill is green when the gateway is dead — it renders identically in the demo-fallback path.
- **Fix:** wire it to `/health`, or remove it.

**5. Demo fallback with no visible mark** — `gateway-adapter.js:443-447`, `index.html:201-215`
- **You see:** on any hydrate failure, a completely normal-looking app: named workers, live statuses, an approval card awaiting your decision, and an agent reporting `"Reviewed 42 new tickets overnight. 3 are high priority..."`.
- **It is:** the hardcoded seed at `app.js:6-379`. The source comment claims this happens "with a visible mark, so a demo is never mistaken for the live machine" — there is no mark. `document.documentElement.dataset.demo = "true"` is set, and `grep data-demo` across `tokens.css`, `motion.css`, `styles.css`, `backgrounds.css` returns **nothing**. Kill the gateway and every control "works".
- **Fix:** add a full-width red banner keyed on `[data-demo="true"]`, or refuse to boot the demo adapter when a gateway URL is configured.

**6. Notifications panel** — `app.js:807`
- **You see:** `"Atera finished its previous ticket review. Context7 access is waiting for approval in MSP Team."`
- **It is:** one constant string. No feed, no state read, no gateway call. Names demo agents that need not exist on your gateway. Real activity and real approval requests never appear here.
- **Fix:** delete the panel until there is a notification source.

**7. Unread-notification dot** — `index.html:117`
- **You see:** a magenta unread badge on the ♧ button.
- **It is:** `<span class="notification-dot"></span>` shipped unconditionally; `grep notification-dot app.js` returns nothing. Lit on a freshly booted idle system, can never clear.
- **Fix:** delete the span.

**8. Teach dialog: record dot + "<agent> is watching and learning" + ticking timer + "Recording is local to this worker session."** — `index.html:176-191`, `app.js:868-877`
- **You see:** the real agent's name beside a red record dot, a live mm:ss counter, and a privacy assurance about where the recording is stored.
- **It is:** `grep` of the whole bundle finds **zero** `MediaRecorder`, `getDisplayMedia`, `getUserMedia`. The timer is `Math.floor((Date.now() - startedAt) / 1000)` — it measures how long the dialog has been open. The footer sentence is the thing that stops you from asking whether it's actually recording.
- **Fix:** remove the teach dialog entirely until there is a capture path.

**9. Teach canvas fake Atera ticket queue** — `index.html:181-186`
- **You see:** address bar `app.atera.com/tickets` with `VPN connectivity / High` and `Backup warning / Review`.
- **It is:** static markup. The CSS class is literally `fake-ticket`. Those are two of your real service-desk ticket types at real-looking priorities, on a real customer URL.
- **Fix:** delete, or mount the real `BOX_VNC` frame.

**10. Desktop "Sheets" working sheet** — `app.js:844-845`
- **You see:** `${record.name} working sheet`, a green `saved` pill, rows `1 / Review current state / <lead name> / Active` and `2 / Return outcome / <record name> / Queued`, captioned "Changes appear in this context's run timeline."
- **It is:** a template literal. No adapter method, no gateway call, no state read. Real agent names interpolated into invented rows.
- **Fix:** delete the Sheets surface.

### Tier 2 — misreports live machine state

**11. "Current run: Weekday ticket review"** — `index.html:162`. Hardcoded `<strong>` with no id; `renderDesktop` never touches it. It is `initialState.routines[1].name` from the demo seed. Every desktop dialog, every agent, always names a routine that may not exist on your gateway. **Fix:** bind to the active routine or delete the aside.

**12. Desktop run timeline** — `gateway-adapter.js:132-139`. Four hardcoded steps permanently frozen with `"Reviewing the current task"` marked `active` and `"Return outcome to conversation"` greyed. Identical for every agent, every room, every run, including agents that have never run anything. Nothing ever assigns to `state.desktop.timeline`. **Fix:** delete.

**13. Desktop footer "<name> is working"** — `app.js:839`. The words are chosen only by `state.desktop.paused` (a local flag). The real `lead.status === "working"` from `isRunning` drives the **dot colour only**. There is no state in which this line says the agent is idle. **Fix:** `${lead.status === "working" ? "is working" : "is ready"}`.

**14. Desktop title "<name>'s desktop" and capsule subtitle "<name> · private"** — `app.js:837-838`, `app.js:672`. There is one container and one X display. `mountBoxSurface` takes no agent id and always mounts the same `BOX_VNC` constant. The old UI refused to make this claim and said why: *"One container, one X display: every worker draws on the same screen. Saying so beats implying each has a private one."* (`ui/index.html:1196-1197`). You could type a credential into what this labels a private desktop while another session watches the same screen. **Fix:** copy the old UI's wording — "shared box display :1".

**15. Working/typing dots** — `gateway-adapter.js:229-244`. Means "you sent something and nothing newer has come back", not "the agent is running". A run started by a routine, Slack, or the desktop app produces no dots at all. A send the adapter *knows* failed (`.catch((error) => notWired(\`Sending failed: ${error.message}\`))`, `:305-307`) never clears the wait — `awaiting.delete` appears exactly once in the file, on the answered-or-expired path — so you get "Sending failed:" in the transcript **and** animated working dots for the full `AWAIT_CAP_MS = 5 * 60_000`, then a relabel to "No reply came back". **Fix:** clear on the catch; re-poll `listAgents` for `isRunning`.

**16. Room status dots (roster + right rail)** — `app.js:556`, `app.js:600`. `<i class="status-dot ready">` and `<span class="status-dot success">` are string literals sitting inches away from the agent dot on line 585, which *is* `statusClass(...)`. Same visual vocabulary, one is a reading and one is paint. `isRunning` is available on group agents in the same payload. **Fix:** use `statusClass(room.status)`.

**17. Voice meter bars** — `app.js:547` + `styles.css:511-525`. Four empty `<i>` elements at fixed CSS heights `8px / 17px / 12px / 20px`, identical on every card. No audio, no token stream, no activity feed anywhere in the bundle. **Fix:** delete.

**18. simulateReply flipping roster status on send** — `app.js:893, 908`. Send into a room and an arbitrary member's card lights `working / "Thinking through your request"` then falls to `"Ready for the next task"` after 1150 ms. That worker was never prompted — `sendPrompt` went to the group id. **Fix:** delete `simulateReply` (see BROKEN #9).

**19. Routine trigger tag "◷ On a schedule"** — `gateway-adapter.js:76`. `trigger: a.trigger?.summary ?? a.summary ?? "On a schedule"`. Neither field exists; the real ones are `triggerDescription` / `schedule`, and the old UI prints `"no trigger"` for exactly this case (`index.html:924`). Every webhook, event, and manual routine is labelled as scheduled. **Fix:** `a.triggerDescription || a.schedule || "no trigger"`.

**20. Routine "coordinates · X" / "runs as · Y" tags** — `gateway-adapter.js:73-74`. `coordinatorId: scope.id, delegatedToId: null` — an invented delegation graph. The gateway has no coordination concept in automations. **Fix:** delete both tags.

**21. Approval card** — `app.js:146-155`. The only approval that can render is the hardcoded `"Connect Context7"` demo card; `messagesOf()` stamps every real transcript entry `type: "text"` (`gateway-adapter.js:56`) so a real permission request can never surface. The gateway has no approval command at all. **Fix:** delete the card type.

**22. Avatars and accent colours** — `gateway-adapter.js:30-36, 155`. Five demo-persona SVGs picked by `[...String(id)].reduce((n,c) => n + c.charCodeAt(0), 0) % 5`. Each file carries a *different specific* agent's identity in its own markup (`aria-label="Chief of Staff"`, `"Atera Triage"`, `"ClientSync Tester"`, `"Coro Agent"`) — your real fleet names. Real per-agent avatars exist and are already proxied: `server.mjs:129 relayAvatar()` → `GET /avatars/<agentId>?v=<version>` → `getAgentAvatar`. Nothing in the UI requests it. With >5 agents, faces collide. **Fix:** `avatar: \`/avatars/${a.id}\``.

**23. "Role" detail row** — `gateway-adapter.js:153`. `role: a.isGroup ? "Group chat" : "Worker"` in a slot laid out as a per-agent configured field. Reads the literal `"Worker"` for every agent forever. The real `description` is fetched and spent on the status line instead.

**24. Files count badge "0"** — `gateway-adapter.js:158`. `files: []` hardcoded, rendered as `<b>0</b>`. This is not "the agent has no files", it is "nobody looked". No file command is called anywhere.

**25. Agent details panel / People-button-with-worker** — `app.js:778-782`. Four of six facts are dead constants: `${worker.model}` → `"default"`, `${worker.files.length} files` → `0`, `<span class="status-pill success">active</span>` (a literal, not a check), and the prose "The direct transcript, files, browser session, model, and routines shown here belong to this agent."

**26. "Browser · Open" row subtitle** — `gateway-adapter.js:159`. `browser: { label: ..., url: "" }` — blank, because nothing tracks what any agent has open. "Open" mounts the one shared display.

**27. Browser address bar** — `app.js:830`. A read-only `<div class="browser-address">` containing `Browser session on ${record.name}'s computer.` — not a URL, in the slot where a URL belongs, above a live screen. You cannot type into it; there is no way to navigate the remote browser from this UI.

**28. App-preview sublabels** — `index.html:154-157`. `<small>Context7</small>`, `<small>Reports</small>`, `<small>Ticket audit</small>`. Three of four are demo fiction; `app.js:840` only toggles the `active` class and never rewrites the text. "Ticket audit" reads as a named live document.

**29. Connector description / category / "OAuth connection"** — `gateway-adapter.js:99-103`. `category: "Connector"`, `description: p.description ?? "Connected through the host listener."`, `secretField: "OAuth connection"`. Gateway integrations carry `platform`, `isConnected`, `state` — no description, no credential-field metadata. Every connector card wears the same invented prose as its own.

**30. "Started moments ago"** — `app.js:686`. Bare literal on the running branch. Says the same thing at second 1 and minute 40. The `Scheduled in ${formatCountdown(...)}` branch beside it *is* computed, which makes the fabricated one look equally trustworthy.

**31. Up-next progress orbit (34%) and shelf ring arc (68%)** — `styles.css:1132-1142`, `styles.css:1373-1375`. Both are `conic-gradient` CSS literals. `grep progress-orbit app.js` returns nothing; JS touches `#schedule-button` only via `.textContent`, `aria-label`, `title`. The ring sits at 68% at boot, at one minute to the run, and in the no-schedule state where the label under it says "trigger / event routine" and there is nothing to be 68% of.

**32. Toast "<agent> will use <model> on the next turn"** — `app.js:982`. Fires unconditionally after `setModel()` returned `notWired("Per-worker model routing")`. A specific, testable claim about future behaviour. Nothing changed, and even the real mechanism (`POST /endpoints/use`, `server.mjs:243-256`) rewrites `SAND_OPENAI_COMPATIBLE_*` for the **whole box**, not per agent.

---

## 3. Dead controls — every STUB, grouped by the backend work each needs

**Needs a file/artifact API on the gateway (none exists):**
- Files dock button, Files app-preview, Files/Shared-files row click — all three land on `record.files` which is `files: []` at `gateway-adapter.js:159`. Only reachable output is `No files in this context yet.`
- Composer `＋` attachment panel — `simplePanel("attachments")`, copy `Attachments added here belong to ${contextName()}.`, no `<input type="file">`, no drop target, and `server.mjs` has no upload route at all (routes are `/api/*`, `/events`, `/avatars/`, `/box/launch`, `/endpoints*`, `/model`, `/health`).

**Needs a run-control command (gateway has none — the old UI said so and shipped a label instead):**
- Pause / Resume — `setRunPaused()` comment: *"Presentation only: this pauses the operator's view of the desktop, not the worker."* Old UI, `index.html:367-368`: *"a pause … needs a stop command the gateway does not have -- so this reports state rather than pretending to control it."* That UI rendered a non-clickable "Running" label. This one shipped the button.

**Needs a demonstration-capture pipeline (nothing exists, not even client-side):**
- "● Teach this task", "■ Finish recording", and Esc-cancel (`app.js:1102-1104` runs the identical `finishTeachMode()` path — abandoning the dialog is indistinguishable from completing it and still fabricates the skill card).

**Needs a policy/approval engine (gateway has no approval command; closest is host-wide `localToolPermission`):**
- "✓ Allow once" / "↗ Always allow" — `decideApproval()` → `notWired("Approval cards")`, then `app.js:1049` fires `"Approval rule saved for Context7"` regardless.
- "Save rule" — `setAutoReview()` → `notWired("Auto-review rules")`, then `showToast("Global auto-review rule saved")`.

**Needs plugin/integration commands (partially exist and are not called):**
- "Install package" — `setPluginState()` → `notWired`, then the unconditional `showToast("Plugin installed globally. Connect its account to enable tools.")` while the card still reads "available".
- Per-tool permission switches — `togglePluginTool()` → `notWired`, and unreachable anyway (`tools: []`).
- "Tools available for assignment — 0/0 enabled" and "Skills in package" headings — `tools: []`, `skills: []` hardcoded; the headings assert a fact the UI never checked.
- "Connect account" secret form — `submitSecret()` → `notWired("The secure credential bridge")`, correctly returns no `.accepted` so **no false toast fires**. This is the one control in the build that refuses honestly. Unreachable in practice (`pluginsOf` only ever emits `"connected"` or `"available"`, never `"installed"`). Real connector auth is `getListenerConnectUrl {platform}` (`index.html:1657`), never called here — there is no working way to connect a connector from the Machine Room.
- Plugins panel search input — `<input class="search-input" type="search" placeholder="Find a capability…">` with no listener anywhere.

**Needs a per-agent model routing command (does not exist at any layer):**
- Per-agent model dropdowns — `setModel()` → `notWired("Per-worker model routing")`. Section titled "Per-agent model routing" with copy "Changes apply on the next agent turn." False twice: the selection does nothing, and the real switch is one model for the whole box.

**Needs nothing but wiring (pure frontend omissions):**
- Mic button — `<button class="mic-button" type="button" aria-label="Voice input">◉</button>`, no id, no data-attr, zero references in the bundle. Doesn't even submit the form.
- "New activity ↓" (`#new-activity`) — shipped `hidden`, no code path unhides it. `grep new-activity app.js` returns nothing.
- Browser toolbar `‹ › ↻` and `⋮` — inert text in a `<div class="browser-controls">`, no handlers.
- Dismiss `×` on Now/Up-next — `classList.add("is-dismissed")`, undone by `renderNowAndSchedule()` line 681 on every adapter event and unconditionally every 30 s. The card resurrects itself.
- Read receipts `✓ / ✓✓` — the gateway adapter never sets `status`; only the demo seed carries `status: "read"`. No delivery feedback exists.
- `type: "system"` message branch — dead. `notWired()` pushes notices as `type: "text"` with `authorName: "Machine Room"`, so every "not wired" notice renders as an ordinary chat bubble from a fake participant, with no avatar (`workerById("system")` is undefined).
- Room/agent `•••` menu and "Continue in prototype" — `simplePanel("context")` advertising "Rename this room, manage its roster, and review room-owned routines", delivering `showToast("This control is mapped in the handoff adapter")`. That toast is itself a lie — no adapter method is called on that path.
- Missing entirely from the shelf: no "＋ new context" chip and no close/× on context pills. `contextChipMarkup` emits chips and nothing else; `openContexts` is reseeded to a single entry on every reload (`gateway-adapter.js:190`). The strip only grows.

---

## 4. Broken wiring — the exact defects

**B1. `/box/launch` runs a shell syntax error and returns 200** — `ui/server.mjs:163-177`
The find-or-launch script is assembled with `.join(" ")` at line 172, and element 166 is the bare string `` `done)` ``. Joined with a space:
```
win=$(for w in ...; do ...; done) if [ -n "$win" ]; then xdotool windowactivate $win; else setsid google-chrome ... fi
```
No `;` or newline between `done)` and `if`. Verified byte-exact against the running box: `sh: 1: Syntax error: "then" unexpected`, exit 2. Live: `POST /box/launch {"app":"browser"}` → `200 {"launched":"browser"}`, chrome process count **0 at every sample t+1s..t+12s**; same for `terminal`. `docker events` shows exec_create/exec_start firing, so it reaches docker — the script itself dies. Control test with a `;` added works and produces a window.
Failure is swallowed at three layers: `spawn(..., {stdio: "ignore"})`, only `child.on("error", () => {})` (fires on spawn failure, never a non-zero child exit), unconditional `res.writeHead(200)`, plus `.catch(() => {})` at `app.js:819`. The UI then mounts a real noVNC frame captioned `Browser session on <name>'s computer.` — so you watch a genuine live screen showing whatever happens to be on `:1` (Plank, or a leftover window) under a Browser label.
**Fix:** `.join("\n")`, and return non-200 on a non-zero exit.
Secondary defect on the same path: even when it works it launches the raw `google-chrome` binary with no `--user-data-dir` and no CDP port, while the box's own launcher `/usr/local/bin/box-chrome` uses `--user-data-dir=/home/box/chrome-profile` and CDP 9223. The box docs say launch via `box-chrome`, *"never a raw chrome binary"* (`source/host/runner/box-reference-docs.ts:26`). So the working version would still show a second Chrome the agent is not driving.

**B2. Plugins panel crashes on an empty list, and the list is always empty** — `gateway-adapter.js:89-92`, `app.js:772-773`
`pluginsOf` unwraps `Array.isArray(raw) / raw.platforms / raw.connections` and never reads `raw.integrations` — which is the envelope the reference UI uses: `const available = state.integrations?.integrations ?? []` (`index.html:889`). 200 response, wrong key, silent `[]`. Then `app.js:773` does `selectedPluginId = selected.id` where `selected = ... || state.plugins[0]` with no guard → `TypeError`, `openPanel` never runs. The Plugins button produces no dialog, no toast, no error. Also `selectedPluginId` defaults to the demo literal `"context7"` (`app.js:384`), which can never match a real integration id. Note the old UI's `renderTopbar` (`index.html:1036-1040`) carries the *same* wrong-key chain — the adapter copied the broken reader, not the working one.

**B3. Routine enabled state read from the wrong field** — `gateway-adapter.js:78`
`status: a.enabled === false ? "paused" : "ready"`. The gateway field is `isEnabled` (`index.html:923`, `:1667-1668 setAgentAutomationEnabled { id, automationId, isEnabled }`). `undefined === false` is false, so **every routine renders green `ready` with an enabled "Test run" button**. Worse, `scheduledRoutines()` (`app.js:489-493`) filters on `nextRunAt` alone — the old UI guards this exact case with `.filter((r) => r.isEnabled !== false && r.nextRunAt)` (`index.html:777`) — so a **disabled** routine takes over the "Up next" island and the shelf ring countdown. You are told a switched-off automation is about to fire.

**B4. Routine last-run status compared against a value the gateway never emits** — `gateway-adapter.js:80-82`, `app.js:746`
Adapter: `{ status: a.runs[a.runs.length-1].status ?? "passed", duration: "" }`. View: `status === "passed" ? "✓ Last run passed · …" : routine.lastRun ? "● Running now…" : ""`. The real vocabulary is `ok` / `success` / `completed` / `running` / `started` / error (`index.html:803-805`). The equality never holds, so **every routine with any run history permanently displays "● Running now…"** — a failure from yesterday, a success from last week, and an actual in-flight run are indistinguishable, and the most natural reading is the wrong one. `duration` is hardcoded `""`, and the real `lastRunAt` the old UI shows is dropped entirely.

**B5. The roster never re-hydrates** — `gateway-adapter.js:146, 261-267`
`listAgents` is called exactly three times in the file: `hydrate()` at boot, and after `addWorker` / `addRoom`. The `/events` SSE stream is wired but `reloadActive()` only re-reads `getAgentTranscript` and `getAgentAutomations`. Nothing re-reads `isRunning`, `name`, `description`, `memberIds`, or `lastActivityAt`. The reference UI polls every 15 s (`index.html:1768`). Consequence: the roster is a boot-time snapshot wearing a live-status animation — a worker that starts running from a routine or Slack never turns teal, card ordering by `lastActivityAt` never resorts, membership changed elsewhere never appears, and there is no staleness indicator. The dot at `app.js:546` is trustworthy for about one second per reload.

**B6. Room routine counts are always 0 except for the open room** — `app.js:553`
`routinesForContext({kind:"room", id})` reads `state.routines`, which the adapter only ever populates for the **active** context (`gateway-adapter.js:110-119, 253, 285`). `getAgentAutomations` is never called for the other roster rows. Scan the Rooms tab to find which rooms have automation attached and you get a confident, wrong zero on all of them.

**B7. Model is read before it is fetched** — `gateway-adapter.js:157 vs 180-184`
`shape()` sets `model: seed.models?.default ?? "default"` and is applied at line 164; the real model is not probed until lines 180-184 (`GET /model`). `seed` is `DEFAULTS`, whose `models.default` is the literal `"default"`. So every `worker.model === "default"`, `modelById("default")` misses in `models.available` (which holds the real id), and the row renders the word **"default"**. The dropdown's `worker.model === model.id ? "selected" : ""` never matches — it only looks right by accident because the probe returns exactly one option. Add a second endpoint and every agent shows the wrong model. Creating a worker or room re-runs `hydrate` with live state as seed, so the value silently becomes correct after an unrelated action — an intermittent that will burn debugging time.

**B8. The demo reply simulator still runs on every send** — `app.js:1026, 891-910`
Its fabricated reply is blocked by the adapter guard; two live effects are not.
- `app.js:899-901`: `if (lower.includes("title") || lower.includes("browser") || lower.includes("desktop")) { ... openDesktop("browser") }` → `mountBoxSurface` → `POST /box/launch` → `docker exec` in the box, plus a full-screen VNC modal over your conversation. **Typing the word "browser" in a message launches Chrome on the box and opens a modal you did not ask for**, which reads as the agent having opened a browser.
- `app.js:893`: `contextLead(context)` is `room.memberIds.includes("chief") ? "chief" : room.memberIds[0]` — a hardcoded demo id. On an empty or unresolvable room roster it returns undefined and `lead.id` throws a `TypeError` out of the submit handler, **after** the prompt has already gone out.

**B9. Failed runs leave no trace in the transcript**
The old UI renders gateway error trays into the stage and explains why: *"A failed run leaves no reply at all, so without this the send appears to vanish"* (`index.html:817`). This UI never calls `getTrays`. A turn that errors out is completely silent here — and because of the working-dots defect above, it animates as working for five minutes first.

---

## 5. Actually real — what you can trust

**REAL (gateway-backed, correct argument names, verified against `ui/index.html`):**
- Roster contents, names, member counts, avatar-stack *counts*, and ordering — `listAgents`, `memberIds: a.memberIds ?? []`, sorted by real `lastActivityAt`. **At page load only.**
- Worker/room status dot and status line — `isRunning`, `description`. **At page load only.** (`statusText` is the agent's static job description, not live status.)
- Selecting a worker or a room — `getAgentTranscript { id }` + `getAgentAutomations { id }`. Correct arg name `id`, not the `agentId` mismatch the old UI warns about at `index.html:567`.
- Transcript body and text bubbles — real content, correctly split on `kind === "send-message"` / `kind === "message" && role === "user"`. Two gaps: no error trays, and agent text is escaped and split on newlines (`app.js:616-618`) where the old UI runs `markdown()` — bullets, bold and code fences arrive as literal asterisks and backticks.
- Composer Send — `call("sendPrompt", { agentId: context.id, prompt: clean })`, byte-identical to `index.html:1630`. Works for rooms too. Failures surface honestly as `Sending failed: ${error.message}`.
- Context island header name and member count.
- Routine **list, names, and instructions** (`a.prompt`) — the container is real; the fields inside the card are not.
- Routine **"Next run in X"** and the countdown — `nextRunAt`, the one field on the card read correctly, ticked every 30 s. Degrades honestly to `"trigger" / "event routine"` with no schedule. Caveat: it will count down to a paused routine (B3).
- "Test run" **dispatch** — `runAgentAutomationNow { id, automationId }`, correct. The run genuinely fires. The reported outcome does not (MOCK #2).
- Create agent — `createAgent { name, description }`. Really creates. (`origin` and `isKickstartRequested` omitted vs `index.html:1616`.)
- Create room — `createGroup { name, description, memberAgentIds }`. Really creates.
- Add/remove room member, everywhere it appears (roster card ×, room context card, members panel, People button) — `setGroupMembers { id, memberAgentIds }`, byte-identical to `index.html:1697/1701`.
- "First member" select — options from live `listAgents`.
- The noVNC iframe itself — `http://127.0.0.1:6080/vnc_lite.html?autoconnect=1&resize=scale&reconnect=1` is a genuine live, **interactive** view of the box's display `:1`. Anyone with the dialog open can type into it. It is one shared display for every agent and every room.
- Shelf context pills (switching context), People button with a room active, next-routine ring click (opens the routines panel).

**LOCAL (browser-only and honest — not defects):**
- Plugin connector nav selection, Workers/Rooms tab switch, Hide/Show roster, all dialog closes and backdrop clicks.
- Theme toggle `◐` — `data-theme` flip between `dusk` and `mist`, both real. Not persisted, resets on reload.
- **Background swatches, "Upload a background", and remove ×** (`backgrounds.js`) — localStorage-scoped, canvas-downscaled to 1920px / JPEG 0.82 against a 4 MB budget, real errors surfaced into the note element instead of swallowed, and the panel says so on screen: *"Uploads are resized and kept in this browser only -- they do not sync to other machines, and clearing site data removes them."* This is the model every other unwired control in the build should have copied.
- The "Connect account" secret form is the one gateway-adjacent control that refuses honestly: no false toast, credential cleared, goes nowhere.

---

## 6. Frontend/backend disagreements — where the UI contradicts the machine

These are the ones that will cost you an incident.

| # | UI says | Backend says / does | Where |
|---|---|---|---|
| 1 | Toast: `"Plugin installed globally. Connect its account to enable tools."` | `setPluginState()` → `notWired("Installing and connecting plugins")` writes "…is not wired to the gateway yet." into the transcript in the same second. Card still reads "available". | `app.js:939` vs `gateway-adapter.js:387` |
| 2 | Toast: `"Global auto-review rule saved"` | `setAutoReview()` → `notWired`. Nothing persisted anywhere; reopening the panel shows the seed text. | `app.js:966` vs `:391` |
| 3 | Toast: `"<agent> will use <model> on the next turn"` | `setModel()` → `notWired`. And there is no per-agent model concept at any layer — the real switch is `POST /endpoints/use`, whole box. | `app.js:982` vs `:390` |
| 4 | Toast: `"Approved for this run only"` / `"Approval rule saved for Context7"` | `decideApproval()` → `notWired("Approval cards")`. No approval command exists on the gateway at all. | `app.js:1049` vs `:389` |
| 5 | Toast: `"Recording handed to <agent> as a skill draft"` + full recording UI with a live timer | `startTeaching()` / `finishTeaching()` → `notWired`. The honest line lands in the transcript **behind the modal**, where you cannot see it. | `app.js:868-888` vs `:392-393` |
| 6 | Toast: `"Context run paused"`, footer `"is paused"`, button flips to Resume | `setRunPaused()` touches only `state.desktop.paused`. The agent keeps running, keeps calling tools, keeps making external writes. The gateway has no stop command. | `app.js:1085-1088` vs `:379-383` |
| 7 | `200 {"launched":"browser"}` and a live desktop captioned "Browser session on X's computer" | The shell script is a syntax error; nothing launched. Failure swallowed at three layers. | `server.mjs:163-177` |
| 8 | Toast `"undefined created with a direct conversation"` / `"undefined room created"`, dialog closes, reads as success | `addWorker` returns `clone(state)`, so `worker.name` is undefined; and the toast fires **synchronously before** the fire-and-forget promise resolves — the same success message appears when `createAgent` 4xx/5xxs, with the failure surfacing later and quietly as a transcript line. | `app.js:1003, 1008` |
| 9 | Member removed / added, list updates instantly | `gateway-adapter.js:333-345` mutates and emits **before** the call settles and never rolls back. A rejected `setGroupMembers` leaves the UI showing the change until the next reload. Also: no last-member guard — the old UI hides Remove at `ids.length > 1` (`index.html:1231`); this one will happily send `memberAgentIds: []` and empty a room. And `createGroup` with an empty roster sends `memberAgentIds: [null]`. | `gateway-adapter.js:329-347`, `app.js:1004-1009` |
| 10 | Green `ready` pill on every routine; "Up next" counting down | The routine is **disabled** on the host (`isEnabled: false`). There is no surface in this UI where a paused routine looks paused. | `gateway-adapter.js:78` |
| 11 | `● Running now…` on a routine card | The last run **failed** yesterday. Or succeeded. Or is genuinely running. Indistinguishable. | `gateway-adapter.js:80-82` |
| 12 | Zero plugins / Plugins button does nothing | `getListenerIntegrations` answered 200 with connected platforms under `raw.integrations`. Thrown away, then crashes on `state.plugins[0].id`. | `gateway-adapter.js:89-92` |
| 13 | Every agent's model is `"default"` | `GET /model` resolved the real box model correctly at `gateway-adapter.js:180-184` — one line after `shape()` already stamped the literal. | `gateway-adapter.js:157` |
| 14 | Generic hash-picked demo face, some other agent's identity | `GET /avatars/<agentId>?v=<version>` is live and already proxied by `server.mjs:129`. The real app even lets operators *set* an avatar (`avatar-editor/controller.ts`). | `gateway-adapter.js:30-36` |
| 15 | Agent card reads calm `ready` | The old UI has a third real state this build discards: `if (a.awaitingUserResponse \|\| state.trays.some((t) => t.agentId === a.id)) return {key:"attention"}` (`index.html:773`). An agent **blocked waiting on you** shows green here. | `gateway-adapter.js:64-67` |
| 16 | Turn sent, nothing came back, no error anywhere | The gateway raised an error tray. `getTrays` is never called. Old UI comment: *"A failed run leaves no reply at all, so without this the send appears to vanish."* | `index.html:817` |
| 17 | `Router online`, named workers, live statuses, an agent reporting 42 overnight tickets | The gateway is dead and you are looking at `app.js:6-379`. The claimed "visible mark" does not exist in any stylesheet. | `gateway-adapter.js:443-447` |
| 18 | `"<name>'s desktop"`, `"<name> · private"` | One container, one X display `:1`, shared by every agent and every other client on the same gateway (`server.mjs:185-210` exists to count them). | `app.js:672, 837` |
| 19 | `app.js:1115` — merely **opening this UI** calls `renderDesktop("browser")`, which POSTs `/box/launch` and docker-execs Chrome on the box before you click anything. | | |

---

## 7. Ranked work list

| # | Work | Size | Why here |
|---|---|---|---|
| 1 | **Plug the fabrication guard hole.** `gateway-adapter.js:400` → drop the `message.type === "text" &&` condition. Then delete the injections at `app.js:884-887` (teach) and `app.js:951` (routine-result). | S — 30 min | Stops the UI writing fiction into permanent, agent-attributed transcripts. Two lines and two deletions. |
| 2 | **Delete the teach flow end to end.** Button, dialog, fake canvas, timer, footer note, toast, Esc path. | S — 1 h | 100% fiction, zero backend, and the highest-credibility lie in the build. |
| 3 | **Delete or hard-disable the auto-review section and the "Router online" pill.** | S — 30 min | A fabricated safety gate shown as ARMED by default. Someone leaves an agent unattended on the strength of it. |
| 4 | **Kill the Pause button** (or replace with the old UI's non-clickable "Running" label). | S — 15 min | Operator hits Pause on a bad run, gets confirmation, agent keeps writing externally. |
| 5 | **Fix the demo fallback mark.** Red banner keyed on `[data-demo="true"]`, or refuse to boot the demo adapter when a gateway is configured. | S — 30 min | Gateway down currently looks healthier than gateway up. |
| 6 | **Fix `/box/launch`:** `.join("\n")` at `server.mjs:172`, wait for the child exit code, return non-200 on failure, and surface it in the UI. Switch to `box-chrome` instead of the raw binary. Update the stale `docs/PLUMBING-AUDIT.md:576` row. | S — 1 h | One character for the syntax error; the honest-failure reporting is the other 45 min. |
| 7 | **Delete `simulateReply`** (`app.js:891-910`, call site `:1026`). | S — 20 min | Removes the unrequested Chrome launch on the word "browser", the fake roster status flip, and a TypeError thrown after a real send. |
| 8 | **Fix the three wrong-key reads:** `a.enabled` → `a.isEnabled`; `"passed"` → the real `ok/success/completed` vocabulary (and render failures as failures, with `lastRunAt`); `raw.integrations` in `pluginsOf`, plus guard `state.plugins[0]`. Add `isEnabled !== false` to `scheduledRoutines()`. | M — 3 h | Turns three confidently-wrong panels into correct ones with no new backend. |
| 9 | **Poll `listAgents` on the SSE stream** (or a 15 s interval, matching `index.html:1768`), and call `getAgentAutomations` for every roster row, not just the active one. | M — 3 h | Fixes B5 + B6 at once: live status, live ordering, live membership, real room routine counts. |
| 10 | **Fix the model ordering bug:** move the `/model` probe before `shape()`, or re-map `worker.model` after the probe. | S — 30 min | One-line ordering fix; kills an intermittent that will otherwise eat an afternoon. |
| 11 | **Use the real avatars:** `avatar: \`/avatars/${a.id}\`` with the current SVGs as fallback. | S — 30 min | Endpoint already proxied. Stops labelling one agent with another's face. |
| 12 | **Wire error trays:** call `getTrays`, render into the stage; clear the working bubble on the `sendPrompt` catch. | M — 3 h | Failed turns are currently invisible, then animate as working for five minutes. |
| 13 | **Replace every fabricated status string with the real one or nothing:** desktop footer wording, room status dots, `"Started moments ago"`, `Role` row, `"Weekday ticket review"`, the desktop timeline, the app-preview sublabels, the address-bar caption, the `active` pill, `coordinates ·` / `runs as ·`, connector descriptions. | M — 4 h | Bulk MOCK cleanup; mostly deletions. |
| 14 | **Fix the ownership/privacy language:** `"<name>'s desktop"` → shared display `:1`, `"· private"` → `"· shared"`, copy the old UI's sentence verbatim. | S — 30 min | Credential-exposure risk framed as a copy change. |
| 15 | **Delete the pure decorations:** voice meter, 34% orbit, 68% ring arc, notification dot, notifications panel, `0/0 enabled` headings, files count badge, `✓✓` receipts, the dead `system` branch. | S — 1 h | They carry zero information and cost credibility on every other widget. |
| 16 | **Remove or disable every inert control:** mic, browser toolbar `‹ › ↻ ⋮`, plugin search, `＋` attachment, `•••` menus, "Continue in prototype", `＋ New routine`, the self-resurrecting dismiss ×, `#new-activity`. | S — 2 h | If it can't act, it shouldn't look like a button. |
| 17 | **Fix the create/remove confirmations:** return the created record from `addWorker`/`addRoom` so the toast isn't `"undefined created"`, await the promise before toasting, roll back optimistic membership on failure, guard the last member, and stop sending `memberAgentIds: [null]`. | M — 3 h | Turns four REAL-but-lying controls into REAL. |
| 18 | **Then, real features, in this order:** `createAgentAutomation {id, spec}` behind "＋ New routine" (exists at `index.html:1583`, never called) → `setAgentAutomationEnabled` for a pause toggle → `getListenerConnectUrl {platform}` for connector auth → file listing and upload (needs new gateway commands) → run markdown on agent text. | L — 1-2 weeks | Everything above this line is honesty work. This line is capability work. Don't reverse the order. |