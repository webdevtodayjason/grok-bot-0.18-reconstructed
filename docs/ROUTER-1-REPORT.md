# ROUTER-1 implementation report

Implemented 2026-09-12 without committing or launching a browser/GUI.

## Result

- Tenant keys now grant each visible `plan-*` work alias and its `-talk` sibling on the same virtual key. Vision and customer-owned aliases are not expanded.
- OpenAI-compatible turns start on talk only when the exact talk alias is advertised by `/models`. A missing or unreadable talk deployment leaves the configured model unchanged.
- A code sandbox/coding-agent turn, a heavy routine, the first Shell/Write/Edit/Computer/code-task call, or two consecutive tool errors pins the remainder of that turn to work. Computer-use planning calls use work, while the single model call that reads a `Screenshot` result uses talk.
- The composer has a per-conversation **Think harder** switch. Its value is carried as control data through `sendPrompt`, never inserted into conversation text.
- The Clients panel has **Auto / Always work / Always talk**. The control plane persists the choice and the relay writes the effective pin into that workspace's `box-secrets.json`; the host's environment still has precedence over the file.
- Every routed OpenAI-compatible model call emits a `[sand][router]` log with conversation, tier, selected model, and reason.
- Spend model rows label owned plan aliases as `talk` or `work`; unrelated provider models are left unlabelled.

## Files changed

Host routing and turn propagation:

- `source/host/extensions/inference/model-tier-router.ts`
- `source/host/extensions/inference/openai-compatible-chat.ts`
- `source/host/extensions/inference/provider-session.ts`
- `source/host/extensions/inference/inference-service.ts`
- `source/host/host-gateway-api.ts`
- `source/host/host-runner-composition.ts`
- `source/host/runner/turn-run-shell.ts`
- `source/host/runner/production-turn-agent-owner.ts`
- `source/host/runner/sand-agent-runner.ts`
- `source/host/extensions/transcript/send-pipeline.ts`
- `source/host/extensions/transcript/send-turn-dispatch.ts`
- `source/host/extensions/transcript/turn-runtime.ts`
- `source/host/extensions/transcript/automation-run-path.ts`
- `source/host/automations/automation.ts`
- `source/host/automations/automation-store.ts`

Control plane and relay:

- `cp/proxy.mjs`
- `cp/admin.mjs`
- `cp/admin/admin.js`
- `cp/admin/admin.css`
- `ui/server.mjs`

Machine Room console (with `ui/machine-room/app.js` unchanged):

- `ui/machine-room/index.html`
- `ui/machine-room/styles.css`
- `ui/machine-room/adapter.js`
- `ui/machine-room/gateway-adapter.js`

Tests:

- `tests/model-tier-router.test.mjs`
- `tests/index.js`
- `tests/cp-proxy.test.mjs`
- `tests/cp-admin.test.mjs`
- `tests/machine-room-gateway.test.mjs`
- `tests/machine-room-voice.test.mjs`

## Verification

Passed:

- `npm run source:typecheck`
- `npm run typecheck`
- `node scripts/build-host.mjs --out /tmp/router-1-hostbuild`
- `node --check` on every touched `.mjs`/`.js` control-plane and UI server/adapter file
- `tests/model-tier-router.test.mjs` — 4/4
- focused ROUTER-1 Machine Room gateway test — 1/1
- focused control-plane pin/spend tests — 3/3
- focused proxy alias test — 1/1
- focused Machine Room composer/voice stylesheet test — 1/1

The requested network-backed CP, relay, and OpenAI-compatible suites were started, but this execution sandbox refuses loopback listeners with `listen EPERM: operation not permitted 127.0.0.1`. Those cases therefore could not execute here. The failures were environment bind failures, not assertion failures. Browser-bearing test cases were not run, per the instruction never to launch a browser or GUI.

## Rebuild and push

The production build command used by `deploy/r750/sync.sh` is:

```sh
node scripts/build-host.mjs --out .cache/hostbuild
```

It produces `.cache/hostbuild/dist/host/host-main.cjs`. The normal R750 ship path rebuilds the host, stages the versioned bundle, and copies the host plus relay/control-plane files:

```sh
bash deploy/r750/sync.sh --no-install
```

That script refuses a dirty tree unless `TITANBOT_ALLOW_DIRTY=1` is deliberately supplied. After shipping, update boxes one at a time through the documented host swap:

```sh
curl -sS -X POST \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{}' \
  https://tb.semfreak.dev/api/updateHostNow
```

Wait about 30 seconds, then verify `getHostStatus.hostVersion` and the host PID changed before updating the next box. For the non-host pieces, restart the named relay container after `ui/` is shipped, and run `deploy/control-plane-install.sh` followed by the control-plane restart after `cp/` is shipped, as printed by `deploy/r750/sync.sh`.

## Remaining risk

- Full socket-backed integration coverage still needs to run in an environment that permits loopback listeners.
- A talk deployment must exist and be advertised under the exact `<work-alias>-talk` name. Until it does, the host intentionally remains on work.
- The conversation switch is scoped to the current console session; the workspace admin pin is persistent.
