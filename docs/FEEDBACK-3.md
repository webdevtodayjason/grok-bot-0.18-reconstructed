# FEEDBACK-3: TestFlight feedback on the Feedback panel, and a ping for every new row

Jason, 2026-09-13 07:45: a watcher for feedback from the phone app and from the console. Today the
console's rows land in the cp feedback table (FEEDBACK-1) and TestFlight rows are read by hand
with scripts/testflight-feedback.mjs in the app repo.

Build on the control plane, modelled on cp/support.mjs: cp/testflight.mjs polls App Store Connect
hourly (betaFeedbackScreenshotSubmissions and betaFeedbackCrashSubmissions for bundle
bot.titanium.app) with a key held as cp settings `testflight.keyId`, `testflight.issuerId` and a
0600 file the operator places (the JWT mint is the same as the app repo's scripts/asc-api.mjs;
copy the 40 lines, no dependency); stores each submission once by its id in a `testflight_feedback`
table (received_at, build, device, os, tester, comment, kind, state new/seen); the Feedback panel
shows them as a second source beside the in-app rows with a source chip; and every new row of
EITHER source pings Titan on the operator's workspace the way support mail does (one listAgents +
one sendPrompt, `feedback.notify` setting to switch off). Tests with a fake Apple answering the two
endpoints and a fake box. Report in docs/FEEDBACK-3-REPORT.md with what is not proven (no key here).
Rules: worktree only, cp/*.mjs and cp/admin/*, no push, no R750, no em dashes.
