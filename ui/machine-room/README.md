# Warmwind Machine Room frontend handoff

This directory is a framework-free, standalone frontend prototype. It translates the approved Warmwind design into local assets, separated style sheets, semantic HTML, and an adapter-driven JavaScript interaction layer. No build step, account, network request, or backend is required for the demo.

## Core context model

The prototype deliberately separates two conversation types:

- **Agent context** — a direct operator-to-agent conversation. The agent owns its transcript, model, files, browser session, desktop, and routines. It is not represented as a one-person room.
- **Room context** — a multi-agent group chat with a truthful member roster. The room owns its shared transcript, files, browser state, and room routines.

The active context drives the three contextual capabilities in the top dock: **Files, Browser, and Routines**. **Plugins and Add** are global Machine Room capabilities.

## Run it

From this directory:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`. `index.html` also works when opened directly from disk in a modern browser.

## Pages

- `index.html` — interactive Machine Room prototype
- `components.html` — component, token, motion, and asset guide

## File map

- `tokens.css` — palette, spacing, radii, type, shadow, blur, and timing primitives
- `styles.css` — application layout and component styling
- `motion.css` — purposeful state transitions and reduced-motion behavior
- `components.css` — presentation-only styles for the component guide
- `adapter.js` — stable frontend/backend boundary plus safe in-memory demo adapter
- `app.js` — demo data, render functions, and interaction orchestration
- `assets/` — local SVG avatars, scenic plate, approved reference, and asset notes

## What is functional

- Switch the left browser between Workers and Rooms, then select either a direct agent or group chat.
- Add or remove truthful room members.
- Send a message and observe working/reply states.
- Resolve inline connector approvals once or persistently.
- Install plugins, provide a demo secure value, and toggle exposed tools.
- View and test only the routines attached to the active agent or room, with a visible pass receipt and duration.
- Switch provider/model per worker without rebuilding.
- Apply a natural-language auto-review rule.
- Expand shared desktop browser/files/sheet views and pause/resume the run.
- Record a simulated teaching session and hand it back as a skill draft.
- Create workers and rooms.
- See a live countdown to the next scheduled routine attached to the active context.
- Toggle dusk/mist atmospheres and responsive layouts.

## Backend integration boundary

Keep the view code in `app.js` and replace `window.createDemoAdapter` with a gateway-backed implementation exposing the same methods:

```js
const adapter = {
  getSnapshot(),
  subscribe(listener),
  selectContext({ kind, id }),
  sendMessage({ kind, id }, text),
  decideApproval({ kind, id }, messageId, decision),
  addMember(roomId, workerId),
  removeMember(roomId, workerId),
  addWorker(worker),
  addRoom(room),
  runRoutine(routineId),
  setPluginState(pluginId, status),
  togglePluginTool(pluginId, toolId),
  submitSecret(pluginId, fieldName, secretValue),
  setModel(workerId, modelId),
  setAutoReview(enabled, rule),
  startTeaching(workerId),
  finishTeaching(),
  setRunPaused(paused),
};
```

`subscribe` receives `{ type, detail, snapshot }`. The snapshot shape is represented by `initialState` at the top of `app.js`. `activeContext` and `openContexts` use `{ kind: "worker" | "room", id }`. Worker records hold direct-message history; room records hold group history. Map actual gateway/SSE events into that shape rather than teaching the DOM about transport details.

## Non-negotiable security behavior

`submitSecret` is a capability boundary, not a chat action. The demo adapter immediately overwrites the local function argument and stores only `{ pluginId, fieldName, accepted }`. The production adapter must pass the value directly to the platform’s secure credential bridge. It must never enter:

- the room transcript;
- a model prompt or tool result;
- client state, local storage, or replay data;
- analytics, debug logs, errors, or event payloads.

Approvals are different: the decision belongs in the audit transcript, but the credential does not.

## Porting notes

The prototype intentionally uses semantic identifiers (`room:selected`, `routine:completed`, `plugin:tool-toggled`) and does not guess the Grok Bot gateway’s endpoint names. During integration, bind each adapter method to the corresponding real endpoint or SSE channel and keep the DOM/event layer unchanged.

The desktop surface is conditional. It should occupy the center only while computer use is active or the operator explicitly expands it. In every other state, the conversation remains the stage. The desktop, file list, browser session, routines, and next-run countdown must always resolve from `activeContext`.

The approved full-frame design is retained at `assets/design-reference.png` for comparison. It is not used as the live background. The live background is the separable `assets/warmwind-landscape.svg` plate.
