# BOOT-1: the console draws before the connectors answer

Row in docs/GAP-ANALYSIS.md (grep BOOT-1): `hydrate()` in ui/machine-room/gateway-adapter.js reads
the roster, then awaits every installed connector's `listMcpServerTools`, and only then calls
`loadContext`; `call()` has no deadline. Measured on grok-bot-local-vm: a cold connector held at
45 s put the first row on screen at 93,680 ms; with the call started and not awaited, 1,099 ms.

Build the fix the row already names, in ui/machine-room/gateway-adapter.js only (never app.js):
a module-level `pendingConnectors` promise; hydrate starts the connector reads and returns without
awaiting them; loadContext runs at once; when the connector answers land, the tool list is adopted
by whichever hydrate is current (a later hydrate wins) and the cards already drawn are rebuilt
with the tools, not redrawn from scratch. A connector that never answers never blocks the page.

Tests: tests/machine-room-gateway.test.mjs (a fake gateway whose listMcpServerTools resolves after
the transcript: first row before the tools; tools adopted after; a second hydrate during the wait
wins; a connector that never resolves leaves the page complete). The browser leg in
tests/machine-room-voice.test.mjs and the console suites stay byte for byte. Measure before and
after with a 5 s delayed fake connector and put both numbers in docs/BOOT-1-REPORT.md.
Rules: worktree only, no push, no R750, no GUI browser (headless legs fine), no em dashes.
