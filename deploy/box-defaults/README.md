# Box defaults: what a new customer's box starts with

Two files. They are the product's own settings for a box, and they are what the control plane's
provisioner copies into a new tenant's `sand-data` directory so a customer box boots with our
decisions rather than with whatever a remote feature service happens to be rolling out that day.

This is CURSOR-1 item 5. The measurement behind it, 2026-09-07 on the R750: the same host bundle
read `sand_auto_review` as true on the demo box and false on the other two, both printing
`"source":"bundled default"`, and on the box where it read true every Shell command and every
browser navigation came back "Rejected: An error occured while classifying this action. Please
review manually." Three boxes, one bundle, three behaviours. Nothing in the product decided that.

| file | lands at | what it is |
| --- | --- | --- |
| `gates.json` | `/home/box/sand-data/gates.json` | the feature pins. Wins over the bundled default and over any live evaluation |
| `sand-host-settings.json` | `/home/box/sand-data/sand-host-settings.json` | the named operator switches, in the file that already exists for them |

Both directories are the tenant's own. `/home/box/sand-data` is the container side of
`<tenant root>/volumes/data`, which the provisioner already creates in its `directories` step
(`cp/provision.mjs`, `tenantPaths().data`).

## Why each pin

Off, because the thing behind it is not ours and cannot be made ours:

- `sand_auto_review`. The classifier this gate arms is a Cursor RPC. With it on and the backend
  gone, every reviewed action is refused. REVIEW-1's local classifier stays available: an operator
  who wants enforcing review writes `SAND_AUTO_REVIEW` into `sand-host-settings.json` and gets the
  local one. That is why this template does **not** write `SAND_AUTO_REVIEW_MODE`: the mode
  override beats the enforce switch (`resolveSandAutoReviewModes`, `localOverride` before
  `enforceEnabled`), so a `"shadow"` in the template would silently swallow the operator's later
  decision to turn review on. The pin says off; the operator's switch still means what it says.
- `sand_product_analytics`, `sand_codebase_telemetry`, `codebase_telemetry_v2` and its two
  children, `sand_action_audit_logs`, `sand_notify_bus`, `sand_notify_safety_poll`,
  `sand_enable_pressure_cpu_profiler`. Telemetry and event reporting bound for a third party.
  `sand_codebase_telemetry` uploads codebase snapshots; it is off today only because the image
  happens not to carry the binary it needs, and a pin is the difference between a decision and an
  accident.
- `sand_box_egress_tunnel`, `sand_auto_update_when_idle`. Network and update paths that are not
  ours to point.
- `grok_bot_dynamic_tools`. It gates a dynamic tool registry and a placement change for the main
  agent only. MCP tools already reach the model without it, and with 26 tools offered and local
  models breaking above 6 schemas, moving tool placement is a fleet measurement, not a rollout.

On, because the product needs them and a live evaluation must never be able to take them away:

- `sand_browser_use_subagent`. Titan has to be able to hold a browser. The new fetch failure
  sentence tells a person to open the page in their browser, and that is only honest if Titan can
  open one too. BROWSER-1 builds on this same tool code.
- `sand_multitask`, `sand_spotlight`, `sand_global_search`, `sand_computer_use_playwright`. Load
  bearing features that are already shipped and already relied on.

## What is not pinned, and why that is safe

Gates not named in `gates.json` fall through to the bundled default, as before. That is fine once
the Statsig client never hydrates: with no remote evaluation there is nothing left that can make
one box differ from another. The pins are the product's decisions, not a firewall. If a gate later
turns out to need a decision, it gets a row here and a line in `docs/CURSOR-CALLS.md`.

## `SAND_BACKEND_URL`

Empty means we have no backend of our own, and nothing tries to reach one. Empty and absent read
the same (`readSandBoxSetting` ignores an empty value), so the key is in the template mostly so an
operator can see the switch exists and type a URL into it.

The key matters most on a box that already exists. The same value is also a compose environment
variable, and `docker restart` does not re-read the environment, so changing an existing box that
way needs a container recreate, which BOX-6 forbids on a live instance. Written here it takes
effect on a file write plus a relay restart.

## If the pin reader lands as one file instead of two

The plan allows the pins to live under a `gates` key inside `sand-host-settings.json` rather than
in their own file. If that is what ships, `gates.json`'s object is nested under `"gates"` and the
provisioner writes one file instead of two. One thing to know before choosing: the existing
settings reader keeps string values only (`sand-box-setting.ts`, `readSettingsFile`), so a nested
object needs its own read either way.

## Copying by hand

On the Mac box or any box already running:

    docker cp deploy/box-defaults/gates.json <container>:/home/box/sand-data/gates.json
    docker exec <container> chmod 600 /home/box/sand-data/gates.json

Then restart the relay. `scripts/verify-cursor-free.mjs` reads `gates.json` from this directory and
checks the box's `[sand][gates]` line against it, so the two cannot drift.
