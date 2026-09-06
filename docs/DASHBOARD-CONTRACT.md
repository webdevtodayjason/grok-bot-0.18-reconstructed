# Dashboard Contract — Providers panel and the view-only exchange viewer

Armed 2026-09-02 22:50 CDT on Jason's "Go"; built and browser-verified the same hour (`9970c67`): nine checks pass, the switch moves the box and the gate restores it, no secret in the DOM. This one edits the handoff's own layout
(`ui/machine-room/app.js`, `styles.css`), which every earlier round left byte-identical; that is
the point of the contract. Verification is a real browser, headless Chrome through Playwright from
`.cache/playwright` (`scripts/setup-gates.sh` installs it; `GROK_BOT_PLAYWRIGHT_DIR` overrides), never a dependency in the repo.

=== LOCKED CONTRACT ===
GOAL: The dashboard has a Providers section: the subscriptions found on this machine as cards
with their key field, adoption state, and a switch that makes one the box's endpoint, listed
before connectors; and an agent-to-agent blurb opens a view-only exchange viewer instead of
bleeding into the user's chat. Both proven in a real browser.
ACCEPTANCE:
  - Providers section, key field, endpoint switch and the exchange viewer render and work in headless Chrome with no page errors: `node scripts/verify-dashboard.mjs`
  - no adopted secret appears in the dashboard DOM or the usual surfaces: `node scripts/verify-dashboard.mjs --leaks`
  - the existing suite stays green: `node tests/index.js`
NON-GOALS:
  - `source/**` (no host change)
  - `ui/subscriptions.mjs` semantics and `ui/server.mjs` routes
  - usage and reset-window display (next round)
  - any new entry in `package.json`
BUDGET: ≤5 files, ~half a day: app.js, styles.css, gateway-adapter.js, the verify script, this doc.
TRIPWIRE: At the budget, or if the exchange viewer needs host data the transcript does not carry,
or if any change outside ui/ tempts: STOP and report before continuing.
DISPOSITION: Before declaring done, emit DISPOSITION LOG — every condition encountered
(failing test, error, stub/FIXME/TODO, dead code, stale doc, type debt), each closed with one of:
[FIXED] / [FIXED_NOW] / [VERIFIED_CLOSED] (resolved now, with evidence),
[DEFERRED_NONBLOCKING] (does not block this goal AND filed with Owner + Next + Proof),
[OPERATOR_BLOCKED] (requires human access/decision; Owner + Next + Proof), or
[FALSE_POSITIVE]/[HISTORICAL_FALSE_POSITIVE] (witness matched noise/history, explain why).
If the gate blocks and lists witness keys, each closing line must contain the condition's
key AND its tag on the same line. [OWNED] is NOT a final disposition. Empty log is legal ONLY
if nothing was encountered.
RULES: Restate this contract before the first action. Check every step against GOAL +
NON-GOALS. Report against ACCEPTANCE at the budget and before declaring done. Emit the
DISPOSITION LOG as the last action before done — done is not claimable without it.
=== Work only to this contract. ===

## As built

- Marketplace: two pill tabs, Plugins and Bots, opening on Plugins (`renderMarketplacePanel`).
  The Plugins tab is the host's catalog (`listMarketplace`) with an installed strip, a search
  field, category chips and a card per plugin; a card opens that plugin's page with its Accounts
  and Connectors boxes. Providers and chat listeners are NOT in it — they are Settings sections
  (`pluginGroupSection`, Providers directly under Inference), drawn from the same cards; one card
  is open at a time, so only the section holding the selection draws a detail pane. Provider
  cards get a "Use this endpoint" button when adopted and an "answering now" pill when live
  (`pluginDetailMarkup`, `handlePanelClick` → `adapter.setModel`, box-wide). See
  [docs/MARKETPLACE.md](MARKETPLACE.md).
- System rows that carry an exchange are clickable (`data-exchange`); the transcript click handler
  opens `openExchangeViewer`, which renders the exchange in the panel dialog with a view-only footer.
- Adapter: provider plugins carry `group`, `endpointId`, `live`; blurbs carry `exchange`, `self`,
  `peer`. Verified with `scripts/verify-dashboard.mjs` (playwright-core from
  `GROK_BOT_PLAYWRIGHT_DIR`, Chrome from `GROK_BOT_CHROME`).
- Not in this round: usage and reset windows per plan; a Providers panel of its own outside Plugins.
