# Wave 5 — Ranked fixes (owner: next build session; nothing here was built in the audit)

1. ~~DONE 2026-08-30 (`1a8d2cc`)~~ **Unbreak Task dispatch** — reconcile schema-time vs execution-time `subagentConfigs`
   (closure wiring around `turn-agent-composition.ts:1690-1723`; error at
   `task-subagent-preparation.ts:494`). Unlocks generalPurpose subagents; P1's direct fix.
   Est: half-day incl. a wire-verified dispatch.
2. ~~DONE 2026-08-30 (`1a8d2cc` — configs supplied directly; desktop gate bypassed at the same site)~~ **Report the desktop to composition** — make the local connector satisfy
   `remoteBoxHasDesktop && getRemoteBoxAvailable()` (`turn-agent-composition.ts:1695`).
   Unlocks computerUse in Task's enum → desktop work, and is prerequisite to teach-a-task
   and per-agent screens. Est: 1–2 days (connector + verify against the box's real X/noVNC).
3. **Endpoint unpin recreate** (operator "go" pending): recreate the box without
   `SAND_OPENAI_COMPATIBLE_*` env so the Router→Endpoints panel becomes the live switch.
   Est: 30s downtime.
4. **Relay webhook receiver** — mint per-routine URLs at the relay, feed the gateway event
   path; replaces the cloud-minted `api2.cursor.sh` webhook (video 2). Est: 1 day.
5. **Relay OAuth callback (`:8767`-equivalent)** — implement the plugin auth loop the
   Electron main owned; `completeMcpOAuth` gateway stub is the seam (video 4). Est: 1–2 days.
6. **UI parity round** (from videos, all small): Test run button + per-run history rows;
   "Agent is working" status line; bot-to-bot sender attribution; threaded replies;
   reactions; routine created/updated chips; global search palette. Est: 1–2 days total.
7. **Remove the schema-repair round** in `openai-compatible-chat.ts` — likely dead since
   the serialization fix; wire shows clean tool calls. Verify by capture, then delete.
8. **Hygiene (from Wave 1 readers, deferred non-blocking)**: delete unreferenced
   `production-turn-input-projection.ts`; remove caller-less `createTurnToolSession`
   (`turn-agent-composition.ts:185-207`); fix duplicate `profilePromptSnapshot` key
   (`turn-run-shell.ts:249-256`). Owner: next session touching those files.
9. **Per-agent screens** — fork-window allocation on the local box (machinery:
   `box-windows.ts`, `sand-window-router.mjs`, token-routed :6081). Est: multi-day; after #2.
10. **Group UI depth** — sender labels, member management, serialized-round status in our
    dashboard, building on the wired host model. Est: 1 day.

11. **`runAgentAutomationNow` returns 500 ("Cannot read properties of undefined (reading
    'mapped')") while the run itself starts and completes fine** — found during the
    visibility round, host-side, reproducible on every manual run. Owner: next host
    session; Next: trace the handler at host-gateway-api.ts:433; Proof: the command
    returns 200 and `scripts/verify-routine-run.mjs` passes without its error-tolerance.

## Did not verify
- Estimates are judgment, not measurements. Items 1–2 carry wire-verifiable acceptance
  (a Task dispatch that runs; computerUse in the enum) — hold any fix session to those.
