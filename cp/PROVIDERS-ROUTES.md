# The Providers panel's route contract (PROVIDERS-1, item B)

This file was published **first**, before the code it describes, so the page (item C) was not
blocked on the control plane. It is the contract between `cp/admin.mjs` and `cp/admin/admin.js`:
field names, shapes, and what each write actually does at the proxy.

**It has been revised once, after the code landed**, and every change is additive except the two
marked CHANGED in §9. Read §9 first if you have already built against the first version.

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
| `POST /v1/admin/providers/<id>/keys/<slot>/quota` | `{total, unit, window?, resetAt?}` | the vendor's plan window for this subscription, read off the vendor's own page and typed in once. See §10 |

**Unparking is the same route as parking**, with `{parked: false}`. Parking writes the deployments it
removes into the control plane's own settings first, so unparking rebuilds exactly what was taken
away rather than something reconstructed from a sibling.

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
| `POST /v1/admin/plan-models/<alias>/keys` | `{keySlots: [...]}` | the pool itself: one deployment per key. Adds the ones that are missing FIRST, then removes the ones that are gone, and refuses a change that would leave the alias with nothing to run on. This is how a subscription that arrives after the model was created gets attached to it, without deleting the model and making it again |
| `POST /v1/admin/plan-models/<alias>/vision-check` | `{}` | sends a 1x1 PNG part through the alias with the master key and records the answer and its time. A catalog refresh can never infer this, and PROXY-10 was a fleet-wide screenshot outage |
| `POST /v1/admin/plan-models/<alias>/apply` | `{}` | the `/key/update` sweep that widens every tenant key's `models` scope to include this alias. Writes **nothing** into a box. On the page: *"Give every workspace access to this model."* |
| `POST /v1/admin/plan-models/<alias>/push-label` | `{slugs: [...]}` or `{all: true}` | pushes `customerLabel` into the workspaces NAMED, through the relay's `use-included` door. **With neither it answers 409 and changes nothing**, listing the candidates. See §9 |
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

---

## 9. What changed after the code was measured

Two CHANGED, and both because the first version would have been wrong in a way a page could not
recover from.

**CHANGED: `push-label` will not act on a workspace nobody named.** The relay door it drives,
`POST /admin/tenants/<slug>/use-included`, writes the base url, the model, the endpoint name, the
served-by line, the context window AND the label in ONE write. There is no label-only door. So a
push aimed at a box that is running something else would MOVE that customer onto this model without
being asked, and on the R750 one of those boxes is a real customer. The route therefore takes
`{slugs: [...]}`, or `{all: true}` meaning the workspaces measured to have run this alias, and with
neither it answers `409 {error: "name_them", candidates: [...]}` and does nothing. The page should
show the candidates and make the operator tick them.

**CHANGED: `workspaces` is a measurement, and it joins on the DEPLOYMENT ID.** `workspaces` counts
the workspaces whose traffic ran on one of this alias's deployments inside the current spend window,
`workspaceSlugs` names them, and `workspacesWhy` says that in words. The first version matched the
alias against the spend log's `model` string, which is the VENDOR model: on the R750 2026-09-08
`select model,count(*) from "LiteLLM_SpendLogs"` answered `openai/glm-5.3` 596 times and the alias
`plan-zai` three times in the whole log, so the panel reported plan-zai as run by `demo` alone while
`richard-avery` and `titanium` were on it. That list is the input to the remove guard, so deleting
the alias would have been allowed and would have failed every turn in two live boxes, one of them a
paying customer's. The join is `deployments[].id` now, with the model-name match kept as a union
because a false positive is the safe direction for a guard that refuses a destructive change.

**CHANGED: `labelBehind` is a NUMBER, measured off each box's own file.** The control plane has
`/data/titanbot` bind mounted — it is where it writes every tenant's directory — so it reads each
tenant's `box-secrets.json` and reports `runningHere` (the boxes pointed at this alias),
`labelBehind` (how many of those say something other than `customerLabel`, the empty label
included) and `labelBehindSlugs`. It used to be `null` forever, which is how richard-avery's Titan
went on calling itself `plan-zai` for two days while his own console said GLM-5.3. A file that
cannot be read is reported as unknown in `labelBehindWhy`, never as up to date.

**CHANGED: `push-label` candidates include the boxes POINTED at the alias.** A box with a stale
label may not have sent a request this month, and it is exactly the box this route exists to repair.
The candidate list is the union of the boxes running the alias and the workspaces measured to have
run it.

Additive, and safe to ignore until the page wants them:

- every plan model carries **`shownToCustomers`**, which is the one rule that keeps a routing alias
  off a customer's Settings page: `customerVisible` true AND a customer label AND a customer name.
  The same rule runs inside `includedModelRows`, so a row the panel shows as not-shown is a row a
  customer really does not have. `plan-zai-vision` is the case it was written for.
- every plan model carries **`deployments[].fromDb`**, so the page can show which rows came from the
  database and which the proxy still reads out of its config file. During the ship plan's stage 1
  both are served at once, deliberately, and this is how that window is visible rather than
  confusing.
- every provider's catalog carries **`ready`** (there is an address and a path to read),
  **`liveNeedsKey`** (a live read goes through the vendor with the key, which this service keeps no
  copy of, so Refresh takes an optional `apiKey` and otherwise returns the stored list with its
  date), and **`leftoverDoor`** (a `/catalog/<id>` pass-through an older install still carries,
  which should always be false).
- **GONE: `backsCatalog`, and the `/catalog/<id>` pass-through behind it.** That door carried the
  vendor key as a header, and MEASURED ON THE R750 2026-09-08 LiteLLM stored it in
  `LiteLLM_Config.general_settings` in cleartext, with none of the encryption
  `LiteLLM_CredentialsTable` gets under `PROXY_SALT_KEY`, and handed it back unmasked from
  `GET /config/pass_through_endpoint`. Two rows were live and the MiniMax one had never served a
  read. The catalog is read from the control plane DIRECTLY now, at the two moments the operator
  has just handed it the key, and any leftover row is deleted the next time a key is added, rolled
  or a catalog refreshed.
- every plan model carries **`inputCostPerToken`**, **`outputCostPerToken`**, **`priced`** and
  **`pricedWhy`**, and every key's `spend` carries **`priced`**. LiteLLM has no built-in price for a
  Z.AI or Alibaba model id, so an unpriced deployment bills every request at zero: on the R750
  2026-09-08, 654 Z.AI spend rows all read `spend 0.000000` and a customer at 665,915 tokens showed
  `$0.00`. The page prints **not priced** rather than a dollar sign in front of a zero.
- a provider's `health` has THREE states and `reachable` may be **`null`**, meaning nothing has
  checked. Nothing checks in the background on this install (`background_health_checks: false`, on
  purpose), and `GET /health/latest` answered `{"latest_health_checks":{},"total_models":0}` on the
  R750, so the old `keys.every(row => row.lastError == null)` could only ever be `true`. `false`
  comes from failures counted in the proxy's own request log; `true` from traffic with no failures,
  or from `POST /v1/admin/providers/:id/health`, which makes one real request per deployment and is
  a button because each one costs the vendor a request. `checkedAt` is stamped from the evidence,
  never from `now()`.
- **`POST /v1/admin/providers/:id/keys` and `.../roll` PROVE the value with the vendor first** and
  refuse with the vendor's own sentence, storing nothing and leaving a serving pool untouched.
  Measured on the R750 2026-09-08 on a throwaway slot: an unchecked swap 401s on the very next
  request 0.3 s later and then puts the deployment in the router's 30 s cooldown, with the old value
  overwritten in place and nothing to undo it with.
- `GET /v1/admin/providers` carries **`window.month`**, the spend window the per-key numbers and the
  quota bars are measured over.
- `POST /v1/admin/clients/<slug>/model` answers with **`wrote`**, the relay's own evidence: names,
  lengths and sha256 prefixes of what was written into that box. No value comes back.

---

## 10. The vendor's plan window, per subscription key

Jason, 2026-09-08, over a screenshot of Alibaba Model Studio's Token Plan Usage page showing
"Remaining 42.9% of Total 40,000, resets 2026-09-09 22:37": *"WE need to be tracking this. and
tracking per account."*

Two facts are being asked for and they come from different places, so the answer keeps them apart.

**What we count is ours and it is exact.** `quota.used` comes from the proxy's per-key request log,
filtered to the deployments this key slot serves, in the vendor's own unit: tokens for a token plan,
prompts or requests for the others. `quota.byWorkspace` is the same number split per customer,
which is the "per account" half, and it is why `spendReport` groups by `model_id` as well as by
`api_key`.

**What the vendor allows is theirs, and this build cannot read it.** MEASURED on this Mac 2026-09-08
with the real keys from `~/.api_keys`, values never printed:

| probe | answer |
| --- | --- |
| `GET https://api.z.ai/api/coding/paas/v4/usage` | 404 `{"error":"Not Found","path":"/v4/usage"}` |
| `GET https://api.z.ai/api/coding/paas/v4/subscription` | 404, the same shape |
| `GET https://api.z.ai/api/monitoring/v1/usage` | 200 carrying `{"code":500,"msg":"404 NOT_FOUND"}` |
| `GET https://api.minimax.io/v1/usage` | 404 `404 page not found` |
| `GET .../models` on both | **200**, so the keys are live and the paths are not there |

Alibaba was not probed: Jason has rotated that key and the new one is not synced yet.

So `total`, `window` and `resetAt` are typed in once by the operator off the vendor's own page,
through `POST /v1/admin/providers/<id>/keys/<slot>/quota`, and stored in the control plane. The bar
is drawn from our count against their total, `quota.live` is **false**, and `quota.why` says so in
words wherever it is drawn. It raises the same 80 percent chip the allowance uses, through
`quota.warn`. When a vendor endpoint is found, filling in `usagePath` in `PROVIDER_QUOTA`
(`cp/proxy.mjs`) is the whole change and the bar becomes the vendor's own number.

```jsonc
"quota": {
  "unit": "thousands of tokens",
  "window": "7 days",
  "used": 17140,
  "total": 40000,
  "remaining": 22860,
  "pct": 43,
  "resetAt": "2026-09-09T22:37:00Z",
  "warn": false,
  "live": false,               // never true on this build, and it is a field so the page needs no edit
  "why": "Our own count of what went through this key, ...",
  "byWorkspace": [ { "slug": "demo", "requests": 412, "tokens": 17140, "dollars": 0.12 } ]
}
```

With nothing set, `total` is `null`, `pct` is `null` and `why` tells the operator to read the total
and the reset off the vendor's page. The page should draw no bar at all rather than a bar at zero.

---

## 11. The Anthropic surface, which exists on this proxy and is not on the tenant list

CODE-1 needs a coding agent, and a coding agent speaks the Anthropic wire: `POST /v1/messages` with
`x-api-key` and `anthropic-version`, not `chat/completions`. The deployed proxy **does** register
that surface, and it is deliberately absent from `TENANT_ALLOWED_ROUTES` (`cp/proxy.mjs`).

**What is measured about it, against LiteLLM v1.100.0, which is the build the R750 runs:**

| leg | answer |
| --- | --- |
| `/v1/messages` registered on the proxy | **yes** |
| on an `openai/<model>` deployment | the proxy drives the vendor's **`/responses`** endpoint; the Anthropic surface comes back **HTTP 200 carrying an error body**, which a model narrates as itself refusing |
| declared **`hosted_vllm/<the same model>`** against the same `api_base` and the same credential | **correct.** Text, system, tools, `tool_use` and `tool_result` round trip, the full SSE sequence arrives, and `count_tokens` answers |
| a key minted with `TENANT_ALLOWED_ROUTES` | **403** on `/v1/messages`, "Virtual key is not allowed to call this route" |

So the vendor prefix on `plan-zai-code` is a **routing choice made for LiteLLM's translation
behaviour** and says nothing about the upstream, which is the same Z.AI endpoint `plan-zai` uses.
Tidying it to `openai/` to match the row it was derived from breaks every coding task into a 200 with
an error inside it, and nothing goes red. `tests/cp-code-key.test.mjs` asserts the string for that
reason.

**Why the two paths are not on the tenant list and will not be put there.** The one-line version of
this feature is adding `/v1/messages` and `/v1/messages/count_tokens` to `TENANT_ALLOWED_ROUTES`. That
hands **every box on the bridge** an Anthropic door on the operator's own subscriptions, with no
per-task cap and nothing to revoke. They ride a **per-task key instead** (`cp/code.mjs`
`CODE_TASK_ROUTES` = the tenant list plus those two), minted per coding task with:

- `key_alias` `titanbot-<slug>-code-<taskId>`, so a tenant revoke can never take a task key and a
  task revoke can never take the box's key. `cp/proxy.mjs deleteKeyByAlias` posts `titanbot-<slug>`
  and nothing else.
- `models` exactly `[plan-zai-code]`.
- **`max_budget` always and never `soft_budget`**, whatever `CP_PROXY_ENFORCE` says. A soft budget by
  LiteLLM's own definition never fails a request, and a cap that cannot stop a runaway coding agent is
  a reading rather than a stop. Observe mode is a deliberate half measure for a *tenant's allowance*;
  it governs nothing here.
- no MCP grant and no rpm limit: a sandbox has no egress, so a web tool on this key is a door to
  nowhere.

`plan-zai-code` also carries **its own `timeout` and `stream_timeout` of 600**, because
`litellm_settings.request_timeout` is **60** (`deploy/coolify/proxy-config/config.yaml`) and nobody
restarts the proxy to change it. A coding turn longer than a minute would otherwise come back as a
provider error. It carries **no `tb_customer_visible` key**, so it can never appear in a customer's
Settings: `normalizeDeployment` defaults an unknown row to not visible, which is what that default is
for.

**Spend on a task key is read from `GET /key/info`, before the revoke, and the read has to WAIT.**

The merged design said `/key/info` was "immediate and correct". **Measured on this Mac against the
deployed image, it is correct and it is not immediate.** A turn the per-token prices say cost
**$0.1211** read back as `spend 0` at +7 ms and at every second out to +12 s, and came back as exactly
**0.1211 at +15 s**: a key's own spend is booked by the same batch writer `/spend/logs` is filled
from (`proxy_batch_write_at`, ten seconds on this install).

So `readSpend` polls to a bounded budget (**20 s**, sized off that 15), stops at the first figure
above zero, and on timeout records **NULL** with the reason. **A zero is never written**, because on a
screen it is indistinguishable from a task that cost nothing — which is the same rule the Spend panel
already keeps about an unmeasured workspace. A task that genuinely made no model call also ends as
null, and that is honest: from the control plane those two are the same observation.

Two consequences the relay has to know about, and they are why the close is shaped the way it is:

- **`POST /v1/relay/code/task/close` can take up to about twenty seconds.** A relay that gives up
  early and retries is fine: the row's `ended_at` is written **before** the wait, so the retry hits the
  already-settled guard and answers `{ok: true, already: true}` at once rather than starting a second
  wait against the same key.
- A close interrupted mid-wait leaves a **closed row with `spend_usd` null and `revoked` 0**, which is
  exactly the shape `sweepTaskKeys` picks up: it finds the key still at the proxy against a closed row
  and revokes it. That is the recovery path, and it is the reason the row is closed first.

`/spend/logs` is still not used for this. In the same measurement it carried **no rows at all** for
priced `/v1/messages` calls through three minutes of polling, and it carries no key alias on the rows
it does hold for them.

```
POST /v1/relay/code/task/open   { slug, agentId, taskId, provider? }
  -> 200 { ok, id, key, alias, model, provider, capUsd, minutesCap, cpus, memoryGb, e2bKey? }
  -> 429 { error: "rate_limited", scope, cap, message }      a cap; no row written
  -> 400 { error: "bad_request", message }                   a malformed claim
  -> 502 { error: "no_credential" | "no_provider", message }  this side could not do its job
POST /v1/relay/code/task/close  { id, outcome, minutes, detail }
  -> 200 { ok, id, spendUsd, spendWhy, revoked, revokeWhy }
GET  /v1/code/tasks[?slug=&limit=]   requireSuperAdmin   { measuredAt, tenants[], rows[], settings }
POST /v1/code/settings               requireSuperAdmin   { ok, written[], settings }
```

`/v1/code` and not `/v1/admin/code`, for the reason §9 gives about `/v1/mail/sends`: `cp/admin.mjs`
claims every `/v1/admin/*` path and 404s what it does not match itself. The guard is that file's own
`requireSuperAdmin` rather than `cp/server.mjs`'s `requireAdmin`, because the super admin console is a
browser holding a session and `requireAdmin` takes the operator bearer only — a route the panel cannot
read is a panel that draws nothing.

**The E2B account is write only.** It is an `admin_settings` row whose name `cp/code.mjs` adds to
`SECRET_SETTINGS` at import, so `listSettings` hands the name back and never the value. It leaves this
service in exactly one place: inside an `open` answer for a workspace set to `e2b`. No route reads it,
no panel renders it, no verb prints it, and `code e2b-key` takes it on stdin and prints a length and a
sha256 prefix.
