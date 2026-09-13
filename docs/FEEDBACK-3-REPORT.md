# FEEDBACK-3 report

Built 2026-09-13 on branch `day-feedback3`.

## What landed

`cp/testflight.mjs` now mints the App Store Connect ES256 JWT with Node crypto, refuses a private
key file that is not mode `0600`, resolves `bot.titanium.app`, and polls both
`betaFeedbackScreenshotSubmissions` and `betaFeedbackCrashSubmissions` once at boot and hourly.
The operator sets `testflight.keyId` and `testflight.issuerId`; the private key stays outside sqlite
at `<CP_DATA_DIR>/testflight.p8`.

`cp/store.mjs` has one new table, `testflight_feedback`. Apple's submission id is its primary key,
so reading the same Apple rows again creates no row and no second notification. It stores the
received time, build, device, OS, tester, comment, kind, and the two-state decision `new` or `seen`.

The Feedback panel reads the existing in-app rows and the TestFlight rows together, sorts both
sources by time, labels every card with an In-app or TestFlight source chip, and lets an operator
mark an Apple row seen. A narrow settings route and CLI verb configure the two Apple ids and
`feedback.notify`.

Both intake paths use the same feedback notifier. Each newly accepted in-app report and each newly
inserted Apple submission makes one `listAgents` call, chooses the bot called Titan, and makes one
`sendPrompt` call in the first enabled super admin's workspace. `feedback.notify=0` makes neither
call. A notification failure does not roll back a row that was already stored.

## Files changed

- `cp/testflight.mjs`: Apple client, JWT mint, key-file gate, poller, timer, and shared notifier.
- `cp/store.mjs`: one TestFlight table and its insert, list, count, and state methods.
- `cp/server.mjs`: shared notification wiring and the boot/hourly poll block.
- `cp/admin.mjs`: TestFlight list/seen routes and the three narrow scalar settings.
- `cp/admin/admin.js`, `cp/admin/admin.css`: the second source, source chips, card, and seen action.
- `cp/cli.mjs`: setting verbs for the two ids and notification switch.
- `tests/cp-testflight.test.mjs`, `tests/index.js`: the new suite and suite registration.
- `docs/ADMIN.md`: operator setup paragraph.
- `docs/FEEDBACK-3-REPORT.md`: this report.

## Simplifications

There is one notifier rather than one Apple notifier and one console-feedback notifier. There is
one fixed private-key path rather than a third path setting, and the key never enters the settings
table. The existing Feedback panel container and filters are reused, so no new panel or HTML
structure was added.

## Verification

Required focused run:

```text
node --test tests/cp-testflight.test.mjs tests/cp-support.test.mjs tests/cp-admin.test.mjs tests/cp-feedback.test.mjs
tests 98
pass 98
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 869.096458
```

Syntax checks:

```text
node --check: 8 files passed
```

Those eight files were `cp/testflight.mjs`, `cp/store.mjs`, `cp/server.mjs`, `cp/admin.mjs`,
`cp/admin/admin.js`, `cp/cli.mjs`, `tests/cp-testflight.test.mjs`, and `tests/index.js`.

The new tests use a generated EC key, a fake Apple server on a loopback port, and a fake box on a
loopback port. They prove JWT shape, the `0600` refusal, both Apple feedback endpoints, field
mapping, idempotent storage, both states, the notification switch, exactly one roster read and one
prompt for each new TestFlight row and each new in-app row, and the admin list/seen route.

## Not proven here

There is no App Store Connect key in this worktree, so no request was sent to Apple and the real
team's authorization, app lookup, included build/tester relationships, and current Apple response
shape were not measured. The hourly timer was wired and its poll function was exercised, but this
run did not wait an hour for a wall-clock tick. No GUI browser was launched, so the panel rendering
is covered by source assertions and API tests rather than a visual browser pass.
