# BOOT-1: the console no longer draws after the connectors, it draws before them

Row: `docs/GAP-ANALYSIS.md`, grep `BOOT-1`. Brief: `docs/BOOT-1.md`. Branch: `day-boot1`.
Files touched: `ui/machine-room/gateway-adapter.js`, `tests/machine-room-gateway.test.mjs`,
this report, and the BOOT-1 and BOOT-1b gap rows. One more, outside the brief's list and flagged
in section 4: `tests/browser-driver-protocol.test.mjs`, a pre-existing race in a test the full
suite surfaced. `ui/machine-room/app.js` is byte for byte untouched, as are
`tests/machine-room-voice.test.mjs`, `tests/machine-room-mobile.test.mjs` and
`tests/console-app-hooks.test.mjs`.

## 1. What was wrong

`hydrate()` read the roster, then `await connectorPlugins()`, and only then called `loadContext`.
`connectorPlugins` asks every installed connector for `listMcpServerTools`, and `call()` has no
deadline of its own. So the transcript was not even *asked for* until every connector had
answered, and a connector that never answered was a page that never came up. Two rows already
carried the measurement from the live product: BOOT-1 on `grok-bot-local-vm` (live at 46,318 ms
and first row at 93,680 ms with one cold stdio connector held at 45 s, against 1,083 ms and
1,099 ms with the read started and not awaited), and BOOT-1b through a customer's own door on
`console.titanium.bot`, where `verify-deploy --url` found no roster card after 30 s on a box
whose connectors had just gone cold.

## 2. What was built

Five hunks in `ui/machine-room/gateway-adapter.js`, all of them in the adapter and none in
`app.js`.

1. **A module-level pending read.** `connectorGeneration`, `pendingConnectors`,
   `startConnectors()`, `supersedeConnectors()` and `adoptConnectorsInto(built, generation)` sit
   next to `connectorPlugins`. `startConnectors` fires the read and hands back a generation
   number; nothing awaits it.
2. **`hydrate` starts the read first and awaits it nowhere.** It goes out before the roster read
   rather than after it, because the sooner it leaves the sooner it lands and it is no longer on
   the path to the first conversation. `loadContext` now runs at the first opportunity.
3. **Adoption, not a rebuild.** When the answer lands, `adoptConnectorsInto` swaps the `mcp:` and
   `shell:` cards into whatever plugin list is on screen by then and leaves the Provider and
   Listener cards alone. A whole-list rebuild would drop cards drawn from answers this read knows
   nothing about.
4. **A later hydrate wins.** `hydrate` is re-run in place at seven call sites. Each run takes a
   new generation, and an older read's answer is dropped on arrival rather than written over the
   current one. `refreshConnectors` supersedes an outstanding read the same way, so a boot read
   landing late cannot put the pre-write cards back over a connectors.json write.
5. **A rebuild does not blank the group.** `hydrate` carries the connector cards the seed already
   holds forward while its own read is out, so creating an agent or unbinding a listener no longer
   empties the Connectors group for the length of a round trip. A boot carries none, because
   `DEFAULTS` has none.

The adapter registers `announceConnectors` after `emit` is defined and clears it in `destroy`, and
that hook fires only for the state the adapter is currently showing. While the page is still
booting the hook is null, which is correct: `app.js` has not constructed the adapter yet, nothing
is subscribed, and the cards only have to be in the state object `hydrate` is about to hand over.

Out of scope and deliberately not taken: the per-method call budget and the UX-ERR-1 half of the
branch the row names. Those are already landed by other work and must not be taken twice.

## 3. Measurement

### The instrument

`scratchpad/boot1-measure.mjs` boots the adapter exactly the way `__bootMachineRoom` does, against
a stub gateway. Every gateway round trip answers in 5 ms except `listMcpServerTools` on the one
installed stdio connector, which answers after **5,000 ms**. Roster of 10 agents, 20 rows in the
conversation the console lands on. Five runs per reading, median reported.

Three marks, all from the instant `hydrate` is called:

| mark | what it is |
| --- | --- |
| asked | the first `getAgentTranscriptTail` request leaves the page |
| live | `hydrate` resolves, which is when `__bootMachineRoom` hands `createDemoAdapter` over and `app.js` can render the first row |
| adopted | the connector cards are in the adapter's snapshot |

**Machine: this MacBook Pro (Apple M5 Max, 128 GB, macOS 26.6.2, node v22.23.1), not
`grok-bot-local-vm` and not the R750.** This is a node harness, not a browser: it measures when
the console can draw, not when a pixel changed. The 46,318 ms and 93,680 ms in the gap row are a
different machine and a different instrument and are not comparable to the numbers below. What is
comparable is before against after here, same machine, same harness, same run.

### Before and after

| mark | before | after |
| --- | --- | --- |
| asked | 5,041.7 ms | 17.6 ms |
| live | 5,065.8 ms | 44.0 ms |
| adopted | 5,066.3 ms | 5,028.6 ms |

Both readings drew 20 transcript rows, so nothing was bought by drawing less.

Read it this way. Before, the cold connector was in front of everything: the console did not ask
for the conversation for five seconds and went live a few milliseconds after the connector
answered. After, the conversation is asked for at 17.6 ms and the console is live at 44.0 ms,
while the connector is still cold. The connector cards appear at 5,028.6 ms, which is when the box
finally answers, and the page has been usable for five seconds by then.

Raw runs: `scratchpad/before.json` and `scratchpad/after.json`.

## 4. Gates

| suite | result |
| --- | --- |
| `tests/machine-room-gateway.test.mjs` | 35 pass, 0 fail (30 before, 5 new) |
| `tests/machine-room-voice.test.mjs` | 100 pass, 0 fail |
| `tests/machine-room-mobile.test.mjs` | 16 pass, 0 fail |
| `tests/console-app-hooks.test.mjs` | 23 pass, 0 fail |
| the ten connector, plugin, marketplace and boot suites | 217 pass, 0 fail |
| `node --test tests/` | 3,488 pass, 0 fail |
| `npm run source:typecheck` | clean |

The five new tests in `tests/machine-room-gateway.test.mjs` pin, in order: the conversation is
asked for and drawn while the connector is still cold; the tools are adopted when they land and a
card already drawn from another group survives it; a hydrate started while a read is out wins and
the older answer is dropped; a connector that never answers leaves the page complete; and a
rebuild keeps the connector cards on screen while its own read is out. `loadAdapter` in that file
now exposes `hydrate` and `DEFAULTS` alongside `createGatewayAdapter`, which is the only change to
the existing harness; no existing test body was touched.

### One file outside the brief's list, and why

`tests/browser-driver-protocol.test.mjs` is not on the brief's file list and was changed anyway.
Flagging it rather than leaving it quiet. The first full-suite run came back **3,487 pass / 1
fail**, and the failure was "events reach the listener with the session they belong to", which
loads nothing this wave touched and passed three times out of three when run alone. It is a race
in the test, not in the product: the fake browser writes the attach reply and two `Page.loadEventFired`
frames back to back, the test waits only for the S1 event, and then asserts that the S2 event has
already been seen. Back to back is not the same read, so under a loaded full-suite run the S2
frame had not been parsed yet and `seen` held one row instead of two. The fix waits for the S2
event too, with the same 3 s deadline, so a genuinely lost or mis-routed event still fails the
test. The assertion's claim is unchanged: both events arrived, each under its own session. Nothing
was weakened, skipped or deleted.

## 5. What a person sees that they did not before

A box with a cold or dead connector now opens on the roster and the conversation, with the
Connectors group empty until the box answers for it, rather than on nothing at all. A box with
warm connectors is unchanged: the cards land within a round trip of the first paint, which is
where they already were.

What this does not fix: `call()` still has no deadline, so a gateway command on the boot path
other than the connector read can still hold the page. That belongs to the per-method budget work,
not here.
