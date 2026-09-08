# The proxy

**What it is for, in one sentence.** Until this wave every customer's box carried a byte-identical
copy of one of your own provider keys, so a customer's spend was invisible, their limit was your
limit, and taking their access away meant rotating a key that every other customer also held. The
proxy replaces that copy with a credential minted per box: metered, budgeted, and revocable on its
own without touching anybody else.

**The word.** *Proxy* is this thing: the service `titanbot-proxy`, `CP_PROXY_*` in the control
plane's environment, `model-proxy.json` in a tenant's profile, `proxy` in `cp/cli.mjs`. *Gateway*
keeps the meaning it already had on this product: the host gateway inside a box on port 1340, with
`TITANBOT_GATEWAY_TOKEN`. They are different things and this document never mixes them.

Every number below names the machine it was measured on. Anything not yet measured says so in the
same sentence.

---

## 1. What runs where

Two new containers on `titanbot-net`, beside the relay, the control plane and the boxes.

| container | image | ports | storage |
| --- | --- | --- | --- |
| `titanbot-proxy` | `docker.litellm.ai/berriai/litellm-database` pinned to a bare version | none published | `/data/titanbot-proxy/config` bound as a directory |
| `titanbot-proxy-db` | `postgres:16` | none published | `/data/titanbot-proxy/postgres` bound as a directory |

Three things about that table are decisions rather than details.

**No published port, ever.** Measured from Richard's box on the R750: the host answers on 22, 80,
443, 8000 and 3000, because container-to-bridge-gateway traffic lands on `INPUT` where no bridge
rule can see it (TENANT-3). A `ports:` line would therefore hand the proxy to every box on the
machine with no virtual key involved. It is reached by its network alias only.

**No Domain, so traefik never routes it.** Internet-unreachable by construction, not by a rule
somebody has to maintain.

**Host-path directory binds, never named volumes and never a single file.** Coolify renames named
volumes and can recreate them empty, and a single-file bind becomes a `LocalFileVolume` row that one
Save in the Storages UI writes back over the real file.

`/data/titanbot-proxy` is a **sibling** of `/data/titanbot`, not a child. `snapshot.sh`'s tenant loop
skips exactly one name; under `/data/titanbot` the proxy would be backed up as if it were a customer
and its Postgres taken as a torn copy.

---

## 2. The key names, end to end

Nothing in this table is a secret. It is the map from a name on your laptop to the thing it opens.

| `~/.api_keys` name | Coolify env on `titanbot-proxy` | `config.yaml` reference | what it opens |
| --- | --- | --- | --- |
| `ZAI_API_KEY` | `PROXY_ZAI_KEY_1` | `os.environ/PROXY_ZAI_KEY_1` | Z.AI coding plan, subscription one |
| `ZAI_API_KEY_JASON` | `PROXY_ZAI_KEY_2` | `os.environ/PROXY_ZAI_KEY_2` | Z.AI coding plan, subscription two |
| `MINIMAX_API_KEY` | `PROXY_MINIMAX_KEY` | `os.environ/PROXY_MINIMAX_KEY` | MiniMax |
| `QWEN_API_KEY` | `PROXY_QWEN_KEY` | `os.environ/PROXY_QWEN_KEY` | Qwen, when that name exists |
| *(none — see below)* | `PROXY_TINYFISH_KEY_1` | `os.environ/PROXY_TINYFISH_KEY_1` | TinyFish search, fetch and MCP |

Two names generated on the server, appended to `/home/sem/titanbot/cp.env` and never rewritten:
`PROXY_MASTER_KEY` (`sk-` prefixed) and `PROXY_SALT_KEY`. The master key goes to exactly two places,
the proxy's own environment and the control plane's as `CP_PROXY_MASTER_KEY`. Never a box, never
git, never the sync payload.

**Open question, answered by measurement (this Mac, 2026-09-08): there is no TinyFish name in
`~/.api_keys` to load.** `grep -o '^[A-Z_0-9]*=' ~/.api_keys` lists 80 names and the only one
matching "tiny" is `TINYMCE_API_KEY`, which is a different service. The operator's TinyFish key
lives at `~/.tinyfish`, which the installer is not permitted to read. So `PROXY_TINYFISH_KEY_1` is
the one value the install script cannot fill in by itself: it is set by hand once, in Coolify, and
the installer says so rather than pretending. Until it is set, a box on the plan gets the plain
sentence for "provider down" on a web fetch and nothing worse.

The same sentence covers the second TinyFish key: pooling two of them is **not** something the
pass-through does, so one key ships and the pool is filed as `PROXY-3` rather than invented here.

---

## 3. How to add a provider

Three edits, all in `deploy/`, none in a box.

1. One `model_list` entry in `config.yaml` with a `model_name` a box will name, and
   `api_key: os.environ/PROXY_<THING>_KEY`.
2. One env name on the proxy service, carried from `~/.api_keys` by the Mac-side script the way
   `COOLIFY_API_KEY` already is.
3. One line in the installer naming it, so a fresh install fills it too.

Then the model name goes in the mint's `models` list, or the key cannot use it.

## 4. How to add a second subscription to a pool

**A second `model_list` entry with the SAME `model_name` and the other key.** That is the whole
mechanism, and it is also MARKET-5's answer: two subscriptions of one provider have exactly one
home, here, and the console side needs no second key field because the second key never reaches it.

```yaml
model_list:
  - model_name: plan-zai
    litellm_params: {model: openai/glm-4.6, api_key: os.environ/PROXY_ZAI_KEY_1, api_base: https://api.z.ai/api/coding/paas/v4}
  - model_name: plan-zai
    litellm_params: {model: openai/glm-4.6, api_key: os.environ/PROXY_ZAI_KEY_2, api_base: https://api.z.ai/api/coding/paas/v4}
```

`routing_strategy: simple-shuffle` with `num_retries: 2`, `allowed_fails: 3` and
`cooldown_time: 30`, so a dead key drains to the other rather than failing the customer.

---

## 5. How revocation works, and its real floor

`cp/cli.mjs proxy revoke <slug>` deletes that tenant's virtual key by alias (`titanbot-<slug>`).
From that moment the proxy refuses it.

Two honesty notes, both of which decide how the gate is written.

**Revocation is measured as the PROXY rejecting the old key, never as the relay having stopped
serving it.** The registry deliberately keeps its last good answer, so a relay that still hands out
a stale row proves nothing either way.

**The floor is the proxy's own key cache**, set explicitly to `user_api_key_cache_ttl: 30`. The
default is 60, and "revocation within a minute" would otherwise be satisfied by luck. It is not the
relay's registry refresh, which is a different clock entirely.

**Measured on this Mac, 2026-09-08 (LiteLLM v1.100.0 in Docker 29.5.3, node 22.23.1):** after
`/key/delete` the next request on the deleted key was refused **immediately — 0.0 s**, on both the
REST pass-through (`/tinyfish/search` → the plan sentence) and the MCP mount (401). The delete
appears to flush the cache rather than wait it out. Treat 30 s as the number you promise and 0 s as
what it did here; the R750 measurement is the one that counts and is recorded in `GAP-ANALYSIS`
`PROXY-1`.

---

## 6. What a customer sees

Settings keeps one Providers area, split in two.

**Included with your plan.** Read-only cards, no key field, a "Use this one" action, and one plain
line: *"You have used 12 percent of what your plan includes this month."* Percent and words on the
customer's side. Dollars only in your admin console.

**Your own keys.** Exactly today's surface, unchanged, one row per provider id. Bringing your own
key wins over the included set.

When something goes wrong the box decides the words, never the model. Four sentences, and no alias,
no dollars, no vendor name, no tool name, and never "may be temporary":

- **Plan spent.** "You have used everything your plan includes this month. Add your own key under
  Settings and I will keep going, or ask for more."
- **Rate limited.** "That is more than the plan allows right now. Give me a moment and ask again."
- **Provider down.** "The model I answer through is not responding. Nothing you sent is lost. Try
  again in a minute, or pick a different model in Settings."
- **Their own key wrong.** Unchanged from today.

The marker for that translator is `SAND_OPENAI_COMPATIBLE_SERVED_BY`. A box on the customer's own
key never gets plan wording, because it has no `SERVED_BY` set.

---

## 7. TinyFish through the proxy

TinyFish is the one included service that is not a chat model, so it rides two different mounts and
this section is the record of which one does what. Both were **measured on this Mac, 2026-09-08,
against LiteLLM v1.100.0 in Docker with stub upstreams** — a real TinyFish key was not available to
the measurement (see §2), so the numbers below are the proxy hop, not TinyFish's own time.

### The REST pass-through — the metered route, and the default

Two `pass_through_endpoints` entries, `/tinyfish/fetch` (POST) and `/tinyfish/search` (GET),
targeting `api.fetch.tinyfish.ai` and `api.search.tinyfish.ai` with `x-api-key` set from
`os.environ/PROXY_TINYFISH_KEY_1`. Those two paths are pinned in
`source/host/extensions/inference/tinyfish-route.ts` as `PROXY_TINYFISH_FETCH_PATH` and
`PROXY_TINYFISH_SEARCH_PATH`, so the proxy's config, the control plane's writer and the box's caller
cannot drift.

A box holds three values in one 0600 file (`connector-env-secrets.json`, server `tinyfish`):
`TINYFISH_API_KEY` (its own virtual key), `TINYFISH_FETCH_ENDPOINT` and `TINYFISH_SEARCH_ENDPOINT`.
With none of them set, the box behaves exactly as it did before this wave.

Measured:

| claim | result |
| --- | --- |
| the pass-through answers | fetch **16 ms**, search **8 ms** (proxy hop, stub upstream) |
| the OPERATOR key is added on the far side | the upstream saw `x-api-key` = the operator key (44 chars, sha256 `18927beb`) |
| the box's own key never leaves the box | the virtual key appeared in nothing the upstream received |
| the query survives the hop | `?query=bank+holidays` arrived intact |
| it meters against the CALLING key | spend **0.004** on that key after the batch window; **0** on a second tenant's key minted alongside it |
| a revoked key is refused | **0.0 s** after `/key/delete` |

**The header shape, and why both are in the file.** TinyFish's own REST endpoints require
`X-API-Key`; the pass-through authenticates and meters on an `Authorization` bearer. The endpoint
decides which one is sent — a host under `tinyfish.ai` gets the key header, anything else gets the
bearer — so there is no flag anybody has to keep in step, and a box pointed back at TinyFish
recovers today's behaviour with no other change.

### The MCP mount — it works, and it does not meter

The tenant form of the connector preset bridges `mcp-remote` to the proxy's `/mcp/` with
`x-litellm-api-key: Bearer ${TINYFISH_API_KEY}` and `x-mcp-servers: tinyfish`. `Authorization` is
deliberately left alone: `mcp-remote` uses it for its own OAuth discovery, which is exactly why
LiteLLM offers the alternate header name.

Measured, and four things are worth knowing before anyone relies on it:

1. **`mcp-remote` (0.8.4) carries unchanged.** It connected to the mount over streamable HTTP,
   initialized, and returned `tools/list` in about **1 s** end to end from spawn. The wave's named
   fallback — *drop leg one if the mount does not carry mcp-remote* — therefore did not fire.
2. **A plain virtual key sees an EMPTY tool list, with HTTP 200 and no error.** The key must be
   minted with `object_permission: {mcp_servers: ["tinyfish"]}`. `allowed_mcp_servers` is accepted
   by the mint and then silently ignored. This is the worst failure shape there is — a success code
   and nothing in it — so the provisioning step asserts a non-empty tool list rather than a 200.
3. **The mount renames the tools.** `search` and `fetch_content` are listed as `tinyfish-search`
   and `tinyfish-fetch_content`. A `tools/call` on the *unprefixed* name still resolves, and the
   upstream receives the unprefixed name, so the host's own fallback (which calls `fetch_content`
   by name) is not broken. What does change is the names the customer's agent sees in its tool list.
4. **It does not meter.** After three tool calls through the mount, the calling key's spend was
   still **0** fifteen seconds later, where the pass-through recorded 0.004 for two calls. Filed as
   `PROXY-4`.

**So: the pass-through is the route the product relies on, and the MCP mount ships beside it.** The
mount is not decoration — it is the only thing that keeps a tenant's TinyFish *tools* (browser
automation, sessions, the wallet) alive once the operator's key is taken out of their box. It is
just not the thing that counts the money.

### Honesty caveats you will otherwise trip over

- **Spend is batch-written.** `proxy_batch_write_at: 10` (not the production page's 60) so the
  panel and the gate see numbers promptly, and the gate still prints which window it waited for. A
  number read too early reads low.
- **The TinyFish column is requests, not dollars.** It is metered with `cost_per_request`, a flat
  figure per call, because the pass-through cannot see TinyFish's own pricing. Read that column as
  a count with a price stapled to it.
- **The 100 percent stop is a stop, not an exact cap.** The spend counter chain can read stale-low,
  so a customer may go slightly past their allowance before the stop lands. This sentence is in the
  admin panel as well as here.
- **`tags` on a mint is an enterprise feature.** Measured 2026-09-08: `/key/generate` with `tags`
  answers `403 ... only available for LiteLLM Enterprise users: tags`. The tenant is therefore
  carried in `key_alias` and `metadata`, which is where the panel reads it from anyway — metering
  was always going to hang off the virtual key, never off tags.
- **So is `/global/spend/report`, and it is the one the panel was built on.** Measured on the R750
  2026-09-08: it answers `400 ... You must be a LiteLLM Enterprise user to use this feature`. Both
  spend windows now come from `/spend/logs`, which is open and answers one row per request carrying
  the key hash, the dollars, the model and the timestamp, so the windows and the per-model
  breakdown are computed from the same rows. It is called with **no date parameters on purpose**:
  adding them changes the answer shape from a list of requests to a per-day table with one column
  per key. The filtering is done on the timestamp instead. **The bound this leaves unset:** the
  call fetches the recent log rather than a window, so on a busy fleet this is the first thing to
  page. `PROXY-6` owns it.
- **A customer who spent nothing is absent from the report, not present with a zero.** The log
  covers the whole window, so absent means zero, and the panel writes that zero out rather than
  showing a hole.
- **Dollars are zero for a subscription model, and that is correct.** Measured on the R750
  2026-09-08: `plan-zai` requests record `$0` because a Z.AI coding-plan model has no per-token
  price in LiteLLM's cost map; `plan-minimax` records real fractions of a cent. Read the
  **requests** column as the load signal for anything on a flat subscription. The percentage a
  customer sees is against `CP_PROXY_ALLOWANCE_USD`, which is the control plane's own number and
  not read back from the proxy, so the chip works either way.
- **`soft_budget` does not come back on `/key/info`.** Measured on the R750: the mint sends it and
  LiteLLM stores it behind a `budget_id`, so the key reads back with `soft_budget: null`. Nothing
  depends on reading it back — the panel's denominator is `CP_PROXY_ALLOWANCE_USD`.
- **After a re-mint, the console keeps handing out the old key for up to a minute.** The relay
  refreshes its registry on a ~60 s cycle and `use-included` writes the key the *relay* holds.
  Measured on the R750 2026-09-08: a revoke-then-mint followed by a migrate wrote the **revoked**
  key back into the box and reported success. `proxy migrate` now compares the hash the relay says
  it wrote against the key it just minted, waits for the refresh, and deletes nothing until they
  agree.

---

## 8. What the proxy does not fix

**Boxes have open internet egress.** `api.z.ai:443` answers from Richard's box, and
`box-isolation.sh` filters the bridge family only. Pointing a box at the proxy forces nothing.

**Removing the key is the control.** That is why the migration's removal step is the security work,
and why the proof is a read of the box's own files — name, mode, length, sha256 prefix — rather than
a claim about the network.

**A virtual key inside a box is not a secret from that customer's own agents.** Anything running in
that box can read the 0600 file, by design: the agent's tools are supposed to reach the box's
filesystem. Its value is that it is *per box, metered and revocable*, not that it is hidden. Say
that out loud to anyone who asks; do not let it be discovered later.

---

## 9. Per-tenant rollback

`cp/cli.mjs proxy rollback <slug>` replays that box's pre-migration `box-secrets.json` from the
0600 snapshot taken during the migration, through the same door the migration used. The host
re-reads that file on every turn, so it takes effect on the next message: no restart, no recreate.

Keep the snapshots for the first week, then delete them in a follow-up row. From the migration
onward the proxy is a **single point of failure for every tenant's inference**, which is a change in
the failure model and not only in key custody.

| failure | what a customer sees | what to do |
| --- | --- | --- |
| proxy container down | every tenant errors on the next turn | `docker start titanbot-proxy`, or roll back per tenant |
| Postgres directory lost or converted to a named volume | every key gone, boxes get 401 | `proxy mint --all`; spend history is gone and the panel says so |
| salt rotated | stored credentials unreadable | prevented: the installer never rewrites an existing key |
| nft rule missing | boxes error, proxy healthy | `box-isolation.sh --verify` names it; the timer reapplies within 60 s |
| budget hit | the plain "plan spent" sentence | raise the allowance, or the customer adds their own key |
| control plane down | nothing | the relay keeps the last good registry answer |
| key stolen from inside a box | that tenant's own budget only | revoke and re-mint from the admin console |

---

## 10. Cloud browsers ride this later (CLOUD-BROWSER-1)

Reserved, not designed out. The cloud browser is a CDP endpoint plus a live URL plus a stop, keyed
at the super admin and metered per customer by session minutes and fetches — which is the same
shape as the TinyFish pass-through and belongs in the same block of `config.yaml`, under a
`/browser/` prefix with `include_subpath: true`. The commented stub is in the config for that
reason. Nothing in this wave decides the adapter or the vendor; `CLOUD-BROWSER-1` still owns that.

---

## See also

- `docs/TENANCY.md` §17 — what counts as a secret, now including the master key, the salt and the
  per-tenant virtual key.
- `docs/ADMIN.md` — the Spend panel.
- `docs/OPERATOR-RUNBOOK.md` — install, migrate, roll back, and what to check when every agent
  errors at once.
- `docs/CONNECTORS-TINYFISH.md` — the TinyFish connector in full, including its tenant form.
