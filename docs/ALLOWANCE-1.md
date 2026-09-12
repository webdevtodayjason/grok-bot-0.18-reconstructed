# ALLOWANCE-1: a token allowance per workspace, per 5-day cycle

Jason (2026-09-12): "give them a bar and have it be a 5-day cycle with a percentage of token usage across
5 days, so they can see what that cap is. That bar has to be able to change per user. We'll just pretend
there are multiple levels ... If somebody were to burn all their tokens in 1 day, that's just how it goes
... When they click on something, they can see their usage and the usage bar for this current cycle, as
well as how many days are left before the cycle resets."

Context: beta-36 spent 9.7M input tokens in 40 minutes through a computer-use subagent while the Spend
panel said "0% of the plan" (the gauge is dollars and these models cost $0 on the Z.AI plan). The
proxy's spend rows already carry prompt/completion tokens per call per workspace (cp/proxy.mjs ~780).

## Model
- Tokens = prompt + completion as the proxy records them (cached input counts as prompt).
- Cycle: 5 days, anchored at the tenant's createdAt; cycle n covers [createdAt + 5n days, + 5(n+1)).
  `cycleOf(tenant, now)` returns { index, startsAt, endsAt, daysLeft (ceil), pct }.
- Levels in cp settings (JSON, editable with `node cp/cli.mjs setting set allowance.levels ...` and
  from the admin Providers/Plans panel): `[{id:"seed",name:"Seed",tokens:25000000},{id:"sprout",
  name:"Sprout",tokens:75000000},{id:"grove",name:"Grove",tokens:200000000}]`. Default level for a
  new tenant: sprout. Per tenant: `allowance.level` and an optional `allowance.capOverride` (tokens).
- Usage: `usageFor(slug, cycle)` sums the proxy rows inside the cycle window (add a cached reader that
  refreshes every 60 s; never sums a missing token field as NaN). State: ok (< 80%), warning (80-99%),
  exhausted (>= 100%).

## Enforcement
- The control plane exposes GET /v1/tenants/<slug>/allowance (session or relay token) with { level,
  cap, used, pct, state, cycle }, and the relay caches it per tenant for 60 s.
- When exhausted, the box's model calls are refused at the relay's proxy edge with 429 and a JSON body
  { error: "allowance", resetsAt, daysLeft }, and Titan's turn ends with one plain sentence: "Your
  cycle's tokens are used up. They come back in <n> days, on <date>. Ask your admin if you need more
  now." Reading, search over past conversations, and settings keep working. Routines and subagents
  stop first: at 100% they are paused; the person's own chat is refused only after that.
- At 80% Titan says once per cycle, at the end of a turn: "Heads up, this cycle's tokens are at 80%."

## Customer console
- A slim bar in the console header (next to the workspace name): fill = pct, colours: mint under
  80, amber 80-99, berry at 100. Click opens a drawer: "<used> of <cap> tokens this cycle", the pct,
  "resets in <n> days (<date>)", the level name, and this cycle's top three models by tokens. Copy in
  plain words, no infra nouns. Phone width: the bar becomes a dot with the pct on tap.
- ui/machine-room adapter only (never app.js); the drawer follows the console's existing card style.

## Admin
- Clients panel: each row gets the same bar plus "Seed / Sprout / Grove" select and a cap override
  field; a change writes the tenant settings and the row re-reads. Spend panel: a "List price" column
  per model row (price table in settings `spend.prices` seeded with GLM-5.3 $1.40/$4.40 and
  GLM-5.3-Flash $0.15/$0.50 per 1M in/out; editable) and per workspace "this cycle: <pct> of <cap>,
  resets in <n> days".
- Every number on a screen is measured or says "not recorded". Nothing invented.

## Tests
Cycle math (edges at exactly 5 days, daysLeft rounding), usage sum with missing fields, state
thresholds, the 429 shape at the relay edge, the admin select writing settings, the console bar
rendering the three states from a fake answer. `node --test` for cp and ui suites that exist.

## Verify
`node --test tests/cp-*.test.mjs`, `node --test tests/machine-room-*.test.mjs` (whatever exists), `node
--check` on every touched file. Write docs/ALLOWANCE-1-REPORT.md (short). Only touch cp/, ui/ (never
ui/machine-room/app.js), and tests/. Never launch a browser, docker or any GUI. Do not commit.
