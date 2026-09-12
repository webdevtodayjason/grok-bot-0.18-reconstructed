# BOX-HEALTH-2: the health sweep stops running out of time

Measured on the R750 2026-09-12: nine workspaces, the relay's box health sweep (ui/box-health.mjs,
readBoxHealth) probes them one at a time under one SWEEP_BUDGET_MS = 8 s for the whole fleet, so the
last three registered (beta-34, 35, 36) come back "not measured" on every admin load, while their
containers are healthy. The control plane reads the report through /admin/boxes (ui/server.mjs,
sharedBoxHealth) with a 5 s cache.

## Change
- A background sweep in the relay: every 30 s, probe every workspace in parallel with a per-workspace
  budget (8 s each; the disk du keeps its own 20 s cap but runs off the critical path and reuses the
  last value when it is still running), never more than 4 workspaces at once. Keep the last report per
  workspace with its measuredAt.
- /admin/boxes answers instantly from the last sweep; each row carries `measuredAt` and `ageMs`; a
  row older than 90 s says so in containerStateWhy ("last measured 2 minutes ago"); a workspace the
  sweep has never reached says "not measured yet" with the reason. The first admin load after a relay
  start triggers a sweep immediately rather than waiting 30 s.
- The admin Box health panel (cp/admin/admin.js) shows the age beside each row in plain words and the
  header says when the fleet was last swept.
- Tests: the sweep with a slow workspace does not delay the others; the report carries ages; the
  first read triggers a sweep; the panel renders the age. Existing tests for readBoxHealth keep passing
  (its signature stays; the scheduler wraps it).

## Verify
`node --test tests/box-health*.test.mjs tests/cp-admin.test.mjs` and whatever relay tests touch
/admin/boxes; `node --check` on touched files. Only touch ui/box-health.mjs, ui/server.mjs,
cp/admin/admin.js, cp/admin.mjs if needed, and tests/. Never launch a browser, docker or any GUI. Do
not commit.
