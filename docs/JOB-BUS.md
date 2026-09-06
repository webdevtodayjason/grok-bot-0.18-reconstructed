# Titan Job Bus (Machine Room side)

**Status:** contract written 2026-09-05 22:20 from Jason's spec (`nextgen-training` commit 8abeaed,
`docs/TITAN-JOB-BUS.md` and `docs/TITAN-JOB-BUS-CLAUDE-CODE.md`). The client is the Grok Bot Chief of
Staff (CoS); this repository implements the server: an allowlisted job API that returns attested results
without exposing shell, CDP, VNC or the desktop. Rows JOBBUS-1..4 in `GAP-ANALYSIS.md` track the build.

This file is both the operator README and the contract the pieces are built to. Every name below is
binding: routes, status codes, gateway command names, file paths, settings names, and the two fenced
blocks a worker agent answers with.

## 1. Where it lives

```
CoS ──HTTPS──► relay (ui/server.mjs, tb.semfreak.dev)      edge: TLS, bearer, rate limit, /v1 only
                  │  gateway token, POST /api/jobBus*
                  ▼
              gateway (host bundle in the box)             queue, allowlist, idempotency, audit, worker
                  │  sendPrompt into the worker agent's own conversation
                  ▼
              worker agent (Scribe by default)             does the work in its sandbox, replies with a result block
                  │
              evidence layer (docs/EVIDENCE-CONTRACT.md)   receipts + attestations of that attempt → job attestation
```

- **Relay** (`ui/server.mjs`): the only public surface. `/v1/*` is authenticated with the job-bus bearer,
  never with the console session, and forwards to the gateway commands below with the relay's own
  gateway token. Nothing else on the relay is reachable with the job-bus bearer.
- **Gateway** (host bundle): `source/host/extensions/job-bus/` owns the store, the allowlist, the worker
  and the audit log. Commands are registered in `gateway-protocol.ts` and implemented in
  `host-gateway-api.ts` like every other command.
- **State** on the box data volume: `<sand-data>/job-bus/jobs.json` (all jobs, written atomically with
  `source/shared/node/atomic-write.ts`; the last 500 terminal jobs are kept) and
  `<sand-data>/job-bus/audit.jsonl` (append-only; never rewritten).

## 2. Token

The bearer CoS presents is `TITAN_JOB_TOKEN`. The relay resolves it in this order and fails closed:

1. env `TITAN_JOB_TOKEN` (Coolify: an environment variable on the `titanbot` resource; the compose file
   passes it through as `TITAN_JOB_TOKEN: ${TITAN_JOB_TOKEN:-}`),
2. `<first SAND_PROFILE_DIRS entry>/job-bus.json` as `{ "token": "…" }`, mode 0600, written by the console.
3. Neither → every `/v1/*` request answers `503 {"error":"job bus not configured"}`.

The console (Settings → Job bus) can **generate** a token (48 hex, shown once), **set** one the operator
pastes, or **clear** it. When the env variable is set the console says so and refuses to write the file,
because the env would win anyway. Console routes on the relay, console-session authenticated like the
rest of the console: `GET /job-bus/status` → `{configured, source: "env"|"file"|null, base_url}`,
`POST /job-bus/token` `{token}` (≥ 32 chars), `POST /job-bus/token/generate` → `{token}` once,
`POST /job-bus/token/clear`.

Tokens compare in constant time. The token never appears in logs, audit rows, transcripts or job bodies.

## 3. HTTP API (relay, `/v1`)

Common: JSON in and out. `Authorization: Bearer <TITAN_JOB_TOKEN>` on **every** `/v1` route including
health (Jason: health is authenticated on the public host). Missing or wrong bearer →
`401 {"error":"unauthorized"}` with `www-authenticate: Bearer realm="titan-job-bus"`. Bodies over 64 KB →
`413`. More than 120 requests a minute from one client → `429` with `retry-after`. Unknown `/v1` path →
`404`. Wrong method → `405`.

| Route | Gateway command | Answers |
|---|---|---|
| `GET /v1/health` | `jobBusHealth` | `200 {"ok":true,"queue_depth":n,"version":"<package.json version>","workers":{"nextgen.chapter":"Scribe"}}` |
| `POST /v1/jobs` | `jobBusCreate` | `201` job summary; duplicate idempotency key → `200` with the existing job; unknown `type` → `400 {"error":"unknown job type","allowed":[…]}`; missing idempotency key → `400`; invalid payload → `400 {"error":"invalid payload","detail":"…"}`; secret-looking payload → `400 {"error":"secrets are not accepted in job payloads"}` |
| `GET /v1/jobs/{id}` | `jobBusGet` | `200` full job or `404` |
| `POST /v1/jobs/{id}/cancel` | `jobBusCancel` | `200 {"id","status":"cancelled"}`; already terminal → `409`; `404` |
| `GET /v1/jobs/{id}/artifacts` | `jobBusArtifacts` | `200 {"id","status","pull_from":"github"|null,"repo","branch","commits":[…],"artifacts":[…]}`; not done → `409` |

The idempotency key is the `Idempotency-Key` header when present, else the body's `idempotency_key`.
The relay adds `submitter: "cos"` (the bearer's label) to the create call; CoS never names itself.

Secret detection on create (fail closed): any payload key matching `/token|secret|password|passwd|cookie|api[_-]?key|authorization/i`,
or any string value matching `/^(ghp_|github_pat_|gho_|xox[abp]-|sk-|AKIA)/`.

### Job record (what `GET /v1/jobs/{id}` returns)

```json
{
  "id": "job_<time36><12hex>",
  "type": "nextgen.chapter",
  "status": "queued|running|needs_human|done|failed|cancelled",
  "idempotency_key": "c05-ch2-2026-09-05",
  "payload": { "course_slug": "…", "chapter": 2, "repo": "owner/name", "branch": "main", "rules_ref": "EXTERNAL-BOT-HANDOFF.md" },
  "policy": { "no_final_assessment": true, "no_placeholder": true, "require_attestation": true },
  "callback_url": null,
  "submitter": "cos",
  "created_at": "…Z", "updated_at": "…Z", "started_at": null, "finished_at": null,
  "worker": { "agentId": "…", "agentName": "Scribe" },
  "events": [ { "at": "…Z", "status": "queued", "note": "…" } ],
  "result": null,
  "error": null,
  "needs_human": null
}
```

`result` on `done` (and on `failed` when the worker answered but attestation did not hold):

```json
{
  "summary": "Course 05 Ch2 notes on main",
  "commits": ["<full sha>"],
  "artifacts": [ { "path": "notes/…/02-….md", "sha256": "…", "bytes": 18000 } ],
  "attestation": { "attempt_id": "<attemptId>", "receipts": ["shell:<eventId>", "browser:<eventId>"], "unsupported_claims": [] }
}
```

`needs_human` is `{ "reason": "lms_login|github_auth|approval|no_worker|other", "detail": "…" }`.

## 4. Job types (allowlist)

| type | worker | what happens |
|---|---|---|
| `health.ping` | the host itself | finishes in-process: `done`, `result.summary = "pong"`, attestation `{attempt_id: <job id>, receipts: ["jobbus:<audit eventId>"], unsupported_claims: []}` |
| `nextgen.chapter` | the agent named in `SAND_JOB_BUS_WORKERS` (default `{"nextgen.chapter":"Scribe"}`) | payload validated (`course_slug` non-empty string, `chapter` positive integer, `repo` `owner/name`, `branch` non-empty, `rules_ref` optional string, default `EXTERNAL-BOT-HANDOFF.md`); dispatched as one prompt into the worker's conversation; the reply is attested |

Everything else → `400`. There is no `shell` job type and never will be over this bus.

Settings (in `sand-host-settings.json`, readable and writable through `getHostSettings`/`setHostSettings`
and the console): `SAND_JOB_BUS_WORKERS` (JSON object type → agent name), `SAND_JOB_BUS_TIMEOUT_MIN`
(default 180), `SAND_JOB_BUS_ENABLED` (default on; off → `jobBusCreate` answers 503 and the worker idles).

## 5. The worker

One in-host loop, started with the gateway, one running job per worker agent, oldest queued first.

For `nextgen.chapter`:

1. Resolve the worker agent by name (`listAgentsSync`, not a group). None → `needs_human {reason:"no_worker"}`.
2. If the agent is mid-turn (`isRunning`), wait; the job stays `queued`.
3. `running`: record `started_at`, the transcript's send-message count as the baseline, then
   `manager.sendPrompt(prompt, { agentId })` with the prompt in section 6.
4. Watch the transcript (poll every 5 s) for the first send-message entry after the baseline whose content
   carries a `titan-job-result` or `titan-job-blocked` fenced block. Past `SAND_JOB_BUS_TIMEOUT_MIN` →
   `failed {error:"timed out"}`.
5. `titan-job-blocked` → `needs_human` with its reason and detail; the agent is marked unread so the
   console's attention signal fires (wire to the needs-you mechanism from ATTN-1 once it lands).
6. `titan-job-result` → attest: `readAgentEvidence(agentId, { attemptId: reply.evidence.attemptId, entries })`
   gives this attempt's attestations. `receipts` = one `<kind>:<eventId>` per attestation, kind from the tool
   name (`shell`, `browser`, `computer`, `read`, `mcp`). `unsupported_claims`:
   - `summary` when the reply's evidence verdict is not `evidenced`;
   - `commit:<sha>` for every claimed commit whose sha (first 7+ chars) appears in no attestation head;
   - `artifact:<path>` for every claimed artifact whose path appears in no attestation head.
   `done` only when `unsupported_claims` is empty (or `policy.require_attestation === false`, which CoS
   does not send); otherwise `failed {error:"attestation did not hold"}` with the result attached so CoS
   can see exactly which claims were unsupported. The model never decides its own verdict.
7. Cancel: `queued` → `cancelled`. `running` → `cancelled` at once, and the agent gets one prompt telling it the
   job was cancelled, to stop and not push. Terminal states refuse (`409`).
8. On host start, a job left `running` is re-attested from the transcript if a result block exists after its
   baseline, otherwise `failed {error:"host restarted mid-job"}`.

Every transition appends one audit row: `{at, event, jobId, type, submitter, policy_version:"v1", worker,
receipts?, unsupported_claims?, ok}`. The host also emits a gateway event `{type:"job-bus", jobId, status}`
on every transition so the console updates live.

## 6. The prompt the worker receives (binding)

```
Titan Job Bus job <id> (type nextgen.chapter), submitted by the Chief of Staff.

Payload: course_slug=<…> chapter=<n> repo=<owner/name> branch=<branch> rules_ref=<rules_ref>
Policy: no_final_assessment=<bool> no_placeholder=<bool>

Do this in your sandbox, in /workspace:
1. Clone or update https://github.com/<repo> on branch <branch>. Use the credential already on this
   machine. If git or gh cannot authenticate, stop and answer with the blocked block below with reason
   github_auth. Never ask the submitter for a token and never accept one.
2. Read <rules_ref> at the repository root and follow it. Use scripts/capture-cues.py for captions
   (it has the 3-tier fallback). If the LMS needs a login you do not have, stop and answer blocked with
   reason lms_login.
3. Write the full notes body and the lesson JSON for chapter <n>. Never write PLACEHOLDER_LOAD_FROM_DISK
   or any placeholder. <when no_final_assessment: Do not touch final-assessment material.>
4. Commit and push to <branch>. Then run `git log -1 --format=%H`, `wc -c` and `sha256sum` on each file you
   wrote, in this turn, and report only what those commands printed. The bus checks every commit sha and
   every artifact path against the receipts of tools you ran this turn; a fact without a receipt fails the job.
5. Answer with exactly one of these fenced blocks and nothing after it:

```titan-job-result
{"summary":"<one line>","commits":["<full sha>"],"artifacts":[{"path":"<repo-relative path>","bytes":<n>,"sha256":"<hex>"}]}
```

```titan-job-blocked
{"reason":"lms_login|github_auth|approval|other","detail":"<what a human must do>"}
```
```

## 7. Console

Settings → **Job bus** card: configured state and source, the base URL (`https://<host>/v1`), Generate /
Set / Clear token, a curl example, the worker mapping (editable), and a compact jobs table (id, type,
status, worker, created, one-line result or needs-human detail) fed by `jobBusList` and refreshed on the
`job-bus` gateway event. No other console surface.

## 8. Operator setup on the R750

1. Set `TITAN_JOB_TOKEN` on the `titanbot` Coolify resource **or** generate one in Settings → Job bus.
2. Make sure an agent named **Scribe** exists (or set `SAND_JOB_BUS_WORKERS`), and that the box has a GitHub
   credential (Settings → Connectors → GitHub; the `gh` shell tool) so the worker can push.
3. Smoke from the CoS box:

```bash
export TITAN_JOB_BASE_URL=https://tb.semfreak.dev TITAN_JOB_TOKEN=…
curl -sS -H "Authorization: Bearer $TITAN_JOB_TOKEN" "$TITAN_JOB_BASE_URL/v1/health"
curl -sS -X POST "$TITAN_JOB_BASE_URL/v1/jobs" -H "Authorization: Bearer $TITAN_JOB_TOKEN" \
  -H "Idempotency-Key: health-1" -H "Content-Type: application/json" \
  -d '{"type":"health.ping","idempotency_key":"health-1","payload":{}}'
curl -sS -H "Authorization: Bearer $TITAN_JOB_TOKEN" "$TITAN_JOB_BASE_URL/v1/jobs/<id>"
```

Tailscale: if the relay is reachable only on the tailnet, an ACL that allows the CoS box and Jason to
`tb:443` is enough; the bearer still applies. The relay publishes nothing else: CDP, noVNC and the desktop
stay on loopback (`scripts/verify-deploy.mjs` asserts the port bindings).

## 9. Gates

- `npm test`: the store (allowlist, idempotency, transitions, audit append, the 500-terminal cap), the relay's
  `/v1` layer (503 unconfigured, 401, 413, 429, 404/405, secret detection, header-vs-body idempotency), the
  worker (`health.ping` done with attestation; `nextgen.chapter` with a fake transcript: result → done, result
  with an unreceipted commit → failed with `commit:<sha>` unsupported, blocked → needs_human, timeout → failed,
  cancel mid-run), the token resolution order.
- `scripts/verify-job-bus.mjs` (box gate, through `scripts/on-box.sh`): starts its own relay on
  `127.0.0.1:7791` with a random `TITAN_JOB_TOKEN` against the local gateway, then drives the API end to end:
  401 without and with a wrong bearer, health 200 and shape, unknown type 400, secret payload 400, missing key
  400, `health.ping` 201 → `done` with a non-empty receipt list within 30 s, duplicate key → same id, a
  `nextgen.chapter` job against a worker name that does not exist → `needs_human {no_worker}` → cancel →
  `cancelled` → cancel again → 409, artifacts of the done ping → 200, unknown id → 404, and the audit file grew
  by exactly the expected rows.
- `scripts/verify-dashboard.mjs --offline`: the Job bus card renders unconfigured and configured.
- `scripts/verify-deploy.mjs --url …`: `/v1/health` without a bearer is 401 or 503, never 200; with
  `--job-token` it is 200.
