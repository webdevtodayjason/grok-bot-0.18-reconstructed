# The Providers panel's route contract (PROVIDERS-1, item B)

This file is published **first**, before the code it describes, so the page (item C) is not blocked
on the control plane. It is the contract between `cp/admin.mjs` and `cp/admin/admin.js`: field
names, shapes, and what each write actually does at the proxy.

Everything below is under `/v1/admin/`, needs a super admin, and answers JSON. The browser talks to
the control plane and **never** to the proxy: the admin page's CSP is `connect-src 'self'` and the
proxy is on the docker bridge with no published port.

Every number in the "measured" notes was taken on **this Mac, 2026-09-08**, against a throwaway
`docker.litellm.ai/berriai/litellm-database:v1.100.0` stack (the image the R750 runs) with Postgres
and `--num_workers 1`. None of it is an R750 number.

---

## 0. What the proxy actually supports, measured before any of this was written

Three things in the merged design were wrong about this build, and the routes below are shaped
around what it does rather than what was assumed.

| assumed | measured on this Mac 2026-09-08 | consequence |
| --- | --- | --- |
| `store_model_in_db` is readable from `GET /settings` | **it is not.** `/settings` answers `alerting` and the callback lists; `values` is `[]` and carries no such key | there is no cheap read that proves the flag. See §7 |
| `PATCH /credentials/{name}` takes the values alone | **422**, `body.credential_name` is required *in the body as well as the path* | the client sends both. The roll works: **0.033 s** |
| `/fallback` is CRUD with `{model_name, fallbacks}` | `POST /fallback` takes **`{model, fallback_models}`**; `GET /fallback` (no model) is **405**; the delete is **`DELETE /fallback/{model}?fallback_type=general`** and 404s without the query | there is no list-all. The control plane reconciles one alias at a time |

And four the design got right, all confirmed:

- `POST /model/new` with a duplicate `model_info.id` answers **500**, it does not upsert. So the
  control plane generates and tracks ids, and a timed-out add is checked against `/model/info`
  before any retry.
- `POST /model/update` **merges**: it changed `litellm_params.model` and left
  `litellm_credential_name` and every `tb_*` key intact.
- `POST /model/update` with only `model_info` answers **400 "litellm_params not provided"**.
  `PATCH /model/{id}/update` is the label edit and it works.
- `GET /config/pass_through_endpoint` returns headers **unmasked**. The panel must never render
  them. `/credentials` by contrast masks (`sk****AA`).

Two more worth having in front of you:

- **`model_info` round-trips arbitrary keys intact.** Every `tb_*` key below came back byte for
  byte, and `max_input_tokens` / `supports_vision` propagate into `/model_group/info`.
- **With the flag off, deployment writes refuse loudly and credential writes do not.**
  `POST /model/new` answers 500 `Set 'STORE_MODEL_IN_DB='True' in your env to enable this feature.`;
  `POST /credentials` answers 200 and the row really persists. And DB rows go **inert** when the
  flag goes off (`/v1/models` fell back to the file's list and came back when it was turned on), which
  is what makes the rollback in the ship plan a non-event rather than an outage.

---

## 1. `GET /v1/admin/providers` — the whole panel in one fetch

One call renders the page. Nothing else is needed to draw it.

```jsonc
{
  "configured": true,              // false when CP_PROXY_URL / CP_PROXY_MASTER_KEY are unset
  "why": "",                       // the sentence to print when configured is false
  "db": {                          // §7. Whether live changes will actually take
    "on": true,                    // true | false | null  (null = cannot be told apart yet)
    "why": "..."                   // always a sentence, including when on is true
  },
  "providers": [
    {
      "id": "zai",
      "name": "Z.AI",
      "kind": "openai",            // the litellm prefix a new plan model gets: openai/, minimax/, ...
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "health": { "reachable": true, "why": "", "checkedAt": "2026-09-08T12:00:00.000Z" },
      "catalog": {
        "models": ["glm-5.3", "glm-5.3-flash", "..."],
        "live": true,              // true = read from the vendor just now; false = the curated list
        "readAt": "2026-09-08T12:00:00.000Z",
        "why": "",                 // why it is curated rather than live, when it is
        // Said on the page in these words, because a refresh CANNOT infer either:
        "note": "This is a list of names. The context window and whether a model takes an image are things you set."
      },
      "keys": [
        {
          "slot": "zai-1",         // the credential_name at the proxy. Stable, and the handle for every write
          "label": "subscription one",
          "order": 1,
          "masked": "sk****AA",    // what the proxy returns. NEVER a key value
          "parked": false,         // parked = still stored, serving nothing
          "spend": { "month": 0.1234, "today": 0.0021, "requests": 412 },
          "lastError": { "at": "2026-09-08T11:59:00.000Z", "why": "..." },  // from /health/latest
          "serves": ["plan-zai", "plan-zai-vision"]
        }
      ]
    }
  ],
  "planModels": [
    {
      "alias": "plan-zai",             // what a box runs on. A contract. Created once, never renamed
      "provider": "zai",
      "vendorModel": "openai/glm-5.3", // what changes when a vendor retires one
      "customerName": "Z.AI GLM (included with your plan)",
      "customerLabel": "GLM-5.3",      // what the customer's Titan says it runs
      "servedBy": "Z.AI GLM",
      "contextWindow": 200000,         // null when unknown, and it renders as unknown
      "supportsVision": false,
      "visionFallback": "plan-zai-vision",
      "vision": { "ok": true, "at": "2026-09-08T11:00:00.000Z", "why": "" },  // the last vision-check
      "plans": ["included"],
      "customerVisible": true,
      "deployments": [ { "id": "tb-plan-zai-zai-1", "keySlot": "zai-1", "healthy": true } ],
      "workspaces": 3,                 // how many workspaces run this alias right now
      "labelBehind": 2                 // how many of those are still telling the customer an older label
    }
  ],
  "defaults": { "planModel": "plan-zai", "why": "" },
  "actions": [ /* the ten most recent ledger rows, same shape as §6 */ ],
  "measuredAt": "2026-09-08T12:00:00.000Z"
}
```

**Two rules the page must keep.** No field in this body is ever a key value — a test sweeps the
whole response for a planted one. And `masked` is the proxy's own mask, never something the page
reconstructs.

---

## 2. Providers and their key pools

| route | body | what it does at the proxy |
| --- | --- | --- |
| `POST /v1/admin/providers` | `{id, name, kind, baseUrl, catalogPath?, curated?: [ids]}` | registers a provider. No proxy call: a provider is a label until it has a key |
| `POST /v1/admin/providers/<id>/keys` | `{label, apiKey, order?}` | `POST /credentials`. Mints slot `<id>-<n>` |
| `POST /v1/admin/providers/<id>/keys/<slot>/roll` | `{apiKey}` | **`PATCH /credentials/<slot>`, in place.** The pool shape does not change, so no deployment is touched and no request can fall between two states. Measured at **0.033 s** on this Mac |
| `POST /v1/admin/providers/<id>/keys/<slot>/park` | `{parked: true\|false}` | takes the slot out of service by removing the deployments that reference it, keeping the credential. Refused when it would leave an alias with no deployment, naming the aliases |
| `POST /v1/admin/providers/<id>/keys/<slot>/remove` | `{confirm: "<slot>"}` | typed confirm. Refused while any deployment references it, naming them. Then `DELETE /credentials/<slot>` |
| `POST /v1/admin/providers/<id>/catalog/refresh` | `{}` | reads the vendor's own `/models` through a LiteLLM pass-through (`/catalog/<id>`), so the control plane gets a live list holding no vendor key. Falls back to the curated list, and says which it is |

**`apiKey` is write-only, end to end.** It arrives in a POST body and in nothing else: never a URL,
never a query string, never a GET response, never a ledger row, never a log line. The page clears
the field on success.

**Why roll is a PATCH and not delete-then-add.** A delete-then-add has a window where the pool is
short a key; an add-then-remove needs a deployment rewrite. The credential is a level of
indirection that already exists, so rolling the value under a stable name changes nothing about the
pool and every in-flight request keeps working. Where the pool shape *does* change (a new slot), it
is add, verify, then remove — in that order, never the reverse.

**The catalog pass-through is measured.** `POST /config/pass_through_endpoint` with
`{path: "/catalog/zai", target: "<vendor base>", headers: {authorization: "Bearer <key>"},
include_subpath: true}` registers, and `GET /catalog/zai/models` reached Z.AI and came back with
Z.AI's *own* `401 token expired or incorrect` on the throwaway key — the vendor answered, so the hop
works and the key rides on the far side. Measured on this Mac 2026-09-08. And `/models` there
answers **names only**: `id`, `object`, `created`, `owned_by`. There is no context window and no
vision flag in it, which is why those two are fields a person fills in.

---

## 3. Plan models

| route | body | what it does |
| --- | --- | --- |
| `POST /v1/admin/plan-models` | `{alias, provider, vendorModel, keySlots: [...], customerName, customerLabel, servedBy, contextWindow, visionFallback, plans, customerVisible}` | one `POST /model/new` per key slot, all sharing `model_name`. **That is the pool.** The control plane generates each `model_info.id` |
| `POST /v1/admin/plan-models/<alias>/update` | any of the above | `POST /model/update` for a vendor-model change (it merges, keeping the credential and every `tb_*`); `PATCH /model/<id>/update` for a label, window or visibility change, because POST refuses a `model_info`-only edit with 400 |
| `POST /v1/admin/plan-models/<alias>/vision-check` | `{}` | sends a 1x1 PNG part through the alias with the master key and records the answer and its time. A catalog refresh can never infer this, and PROXY-10 was a fleet-wide screenshot outage |
| `POST /v1/admin/plan-models/<alias>/apply` | `{}` | the `/key/update` sweep that widens every tenant key's `models` scope to include this alias. Writes **nothing** into a box. On the page: *"Give every workspace access to this model."* |
| `POST /v1/admin/plan-models/<alias>/push-label` | `{}` | pushes `customerLabel` into the boxes running this alias, through the relay's existing door. Carries the workspace count, because the label lives in each box |
| `POST /v1/admin/plan-models/<alias>/remove` | `{confirm: "<alias>"}` | typed confirm. **Refused while any box runs it**, naming them |

**Three clocks, and the copy has to say which.** A vendor-model change takes effect on the *next
request* at the proxy and the *next turn* in a box. A newly added plan model reaches a customer's
list within one registry cycle **plus** the apply sweep. A customer's open page updates on its next
hydrate, because nothing pushes to it. Never a bare "takes effect immediately".

**Next-request is literally true here, and it is a property of our deploy.** The proxy runs
`--num_workers 1`, pinned at `deploy/coolify/proxy.compose.yml:78`, so there is no second worker to
converge. `proxy_config_reload_interval_seconds` is still pinned at 10 so a future two-worker deploy
is bounded, but nothing here depends on the poll.

**Vision fallback is required, and the order matters.** Measured on this Mac: `POST /fallback`
validates that the fallback model *exists* (`Invalid fallback models: [...]`, listing what is
available), so the vision deployment is created before the fallback is set. `POST /fallback` on an
alias that already has one **overwrites** it, which is what makes a repoint one call.

---

## 4. Defaults and one workspace's model

| route | body | what it does |
| --- | --- | --- |
| `POST /v1/admin/defaults` | `{planModel}` | the plan model a NEW workspace gets. Stored in the control plane's own `admin_settings` |
| `POST /v1/admin/clients/<slug>/model` | `{planModel, pushLabel?: true}` | sets one workspace's model. With `pushLabel` the customer's Titan is told the new label in the same action |

The label the customer's Titan is told follows the model automatically: it is `customerLabel`, and
it is the same string on both routes.

---

## 5. What a key value may never touch

A test plants a real-shaped provider key through `POST /v1/admin/providers/<id>/keys` and then
sweeps every GET route in this file for its bytes. It must appear in none of them, and in no
`admin_actions` row. The page must also never render a pass-through's `headers`: unlike
`/credentials`, `GET /config/pass_through_endpoint` returns them in the clear (measured above).

---

## 6. `GET /v1/admin/actions` — what changed

```jsonc
{
  "rows": [
    {
      "id": 41,
      "at": 1757332800000,
      "actor": "jason@example.com",   // or "the operator token"
      "via": "console",               // or "cli"
      "ip": "203.0.113.9",
      "action": "provider.key.roll",
      "target": "zai/zai-1",
      "detail": "rolled the key in slot zai-1 (44 characters, sha256 18927beb)",
      "outcome": "ok"                 // "ok" | "failed: <sentence>" | "started"
    }
  ],
  "retention": "these rows are never pruned",
  "measuredAt": "..."
}
```

The row is written **before** the proxy call and finished after it, so a change that half succeeded
is still on the record with `outcome: "started"`. `admin_actions` is never pruned, and
`docs/ADMIN.md` says so. Query: `?sinceMs=`, `?limit=`.

The same rows are written by `cp/cli.mjs`, with `via: "cli"`, so a change made without a browser is
on the same record.

---

## 7. `db.on` — whether a change will actually take

There is no route on this build that reports `store_model_in_db` (measured, §0), so this field is
computed and it is honest about the case it cannot decide:

- **`true`** — at least one row in `/model/info` carries `model_info.db_model: true`. Proven.
- **`false`** — a deployment write came back with LiteLLM's own sentence,
  `Set 'STORE_MODEL_IN_DB='True' in your env to enable this feature.` Proven the hard way.
- **`null`** — nothing has been seeded yet, so the two look identical from a read. The page says
  *"Nothing has been added here yet, so this cannot be checked until the first change."*

`cp/cli.mjs proxy seed` refuses to run when this is `false`, and reports it rather than writing
half a configuration.

---

## 8. Errors

Every route answers the control plane's usual shape. A proxy that is down is
`{error, message}` with a sentence a person reads, never a stack trace and never `[object Object]`
(that regression is held by a test). HTTP: `400` a bad body, `404` no such provider, slot, alias or
workspace, `409` a refusal with a reason (removing a slot a deployment still uses, removing an alias
a box still runs, demoting the last of something), `502` the proxy said no.
