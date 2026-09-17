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

### 1a. Why plan-zai is two pools (2026-09-08 01:50 CDT)

Measured against the coding plan endpoint from the Mac: `glm-5.3`, `glm-5`, `glm-4.7` and `glm-4.6`
refuse an image part with code 1210 (`messages.content.type is invalid, allowed values: ['text']`);
`glm-5.3-flash` and `glm-4.6v` take one and answer. Every Titan conversation carries screenshots (the
operator's box showed 41 image parts on its last turns), so the first real turn through a text-only
plan model on the demo box was a 400 and the agent run failed. `plan-zai` is therefore the flagship
`glm-5.3` on both keys, and `plan-zai-vision` is `glm-5.3-flash` on both keys, joined by
`router_settings.fallbacks: [{plan-zai: [plan-zai-vision]}]`: a request the flagship refuses is
retried on the flash model before the customer sees anything. A conversation with a screenshot in
its history runs on the flash model for as long as that history is sent. The way back to what the
boxes ran before the proxy, `qwen3.8-max`, is `plan-qwen` (commented out in the config) once the
Qwen key is in `~/.api_keys` under `QWEN_API_KEY`.

## 2. The key names, end to end

Nothing in this table is a secret. It is the map from a name on your laptop to the thing it opens.

| `~/.api_keys` name | Coolify env on `titanbot-proxy` | `config.yaml` reference | what it opens |
| --- | --- | --- | --- |
| `ZAI_API_KEY` | `PROXY_ZAI_KEY_1` | `os.environ/PROXY_ZAI_KEY_1` | Z.AI coding plan, subscription one |
| `ZAI_API_KEY_JASON` | `PROXY_ZAI_KEY_2` | `os.environ/PROXY_ZAI_KEY_2` | Z.AI coding plan, subscription two |
| `MINIMAX_API_KEY` | `PROXY_MINIMAX_KEY` | `os.environ/PROXY_MINIMAX_KEY` | MiniMax |
| `QWEN_API_KEY` | `PROXY_QWEN_KEY` | `os.environ/PROXY_QWEN_KEY` | Qwen, when that name exists |
| *(none — see below)* | `PROXY_TINYFISH_KEY_1` | `os.environ/PROXY_TINYFISH_KEY_1` | TinyFish search, fetch and MCP |

### What a tenant's key carries

| field | where it comes from | what it does |
| --- | --- | --- |
| `key_alias` | `titanbot-<slug>` | the handle revocation and the spend panel both use |
| `models` | the `plan-` models the proxy serves | that key opens those and nothing else |
| `object_permission.mcp_servers` | `MCP_SERVERS` in `cp/proxy.mjs` | without it the MCP mount answers 200 with an empty tool list |
| `soft_budget` | `CP_PROXY_ALLOWANCE_USD` | advisory. Produces the number the 80 percent chip reads and **fails nothing** |
| `max_budget` | the same, when `CP_PROXY_ENFORCE` is set | the hard stop. Unset today, deliberately: observe mode first |
| `rpm_limit` | `CP_PROXY_RPM_LIMIT` | requests a minute for that workspace. **The only ceiling that exists while `CP_PROXY_ENFORCE` is empty** |

`CP_PROXY_RPM_LIMIT` is applied at mint. A key that already exists does not pick up a change to it,
so after changing any of the three run `node cp/cli.mjs proxy limits --all` inside `titanbot-cp`:
it sends `/key/update` for every workspace in the ledger, writes nothing into a box, mints nothing,
and is safe to run twice.

**Where the rate-limit number comes from, and what it is not.** It is an operator-set ceiling, not a
quota derived from the plan: Z.AI's coding plan is metered in prompts per five hours, which is not
an RPM and cannot be divided by a tenant count. The number's job is to stop one runaway agent loop
eating the shared subscription before anyone notices, not to be a customer's fair share. Raise it
when a customer hits it; the refusal reaches them as the plain "that is more than the plan allows
right now" sentence and nothing else.

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

## 3. How to add a provider, a key, or a plan model

**None of it is an edit to this file any more, and none of it is a restart.** It is the Providers
panel at `api.titanium.bot/admin`, or `cp/cli.mjs` if you would rather type. If you find yourself
opening `config.yaml` to add a model, stop: this file declares no model at all now.

**Add a provider.** Providers panel, *Add a provider*. The short name is what every key on it will
be called after (`zai` gives `zai-1`, `zai-2`) and it is on every spend row from then on, so it is
typed rather than guessed from the display name. The model list path is where that vendor publishes
what it serves; leave it empty and the Refresh button stays off and the list stays the one we keep
ourselves. Z.AI, MiniMax and Alibaba are already there as presets and need no registering.

**Add a key.** The provider's card, *Add this key*. The value crosses the browser once and comes
back out of nothing: no GET answers it, no ledger row holds it, no log line prints it. What you see
afterwards is the proxy's own mask (`c2****fj`).

**The key is proved with the vendor before it is stored, and a refusal stores nothing.** The same
request that proves it reads that vendor's model list, so adding a key and refreshing its catalog
are one hop. If the vendor says no you get the vendor's own sentence back and the pool is exactly as
it was. This is not decoration: MEASURED on the R750 2026-09-08 with a throwaway slot carrying no
plan alias and no tenant, patching a credential to a junk value answered 200, the next chat
completion **401'd 0.3 s later**, and the three after that got **429 "No deployments available,
cooldown_list=[...]"** for the router's 30 second cooldown. The old value is overwritten in place,
so there is nothing to undo it with. On a one-key pool an unchecked paste is an outage of that plan
model that outlasts the operator's next click.

**Where the vendor key is held, and for how long.** For the length of that one request and nowhere
else. This service stores no vendor key at all; the encrypted copy in the proxy's credentials table
is the only one. An earlier shape of this read the catalog through a LiteLLM pass-through carrying
the key as a header, on the reasoning that the key then lived at the proxy rather than here.
MEASURED on the R750 2026-09-08 that was worse, not better: the header sat in
`LiteLLM_Config.general_settings` in **cleartext**, with none of the encryption
`LiteLLM_CredentialsTable` gets under `PROXY_SALT_KEY`, and `GET /config/pass_through_endpoint`
handed it back **unmasked** to anything holding the master key. Two rows were live, and the MiniMax
one had been persisted for a catalog that had never been read once. Those doors are removed the
first time a key is added, rolled or a catalog refreshed on an install that still has them.

**Refresh the model list.** The provider's card, *Refresh the model list*. Paste the key beside it
and it reads the vendor live; leave it blank and it shows the names last read, with the date, and
says so. It cannot silently be live, because a page showing yesterday's names as though they were
today's is how a retired model gets picked.

**Add a second, third or fourth key to the same plan.** Add it to the provider, then edit the plan
model and select it as well: a plan model is one deployment per key, all sharing the alias, and that
is what makes a second subscription carry load and a rate limit on one key survivable. The new
deployment goes in before any old one comes out, so the pool is never short a key, and a change that
would leave the alias with nothing to run on is refused. MEASURED on the R750 2026-09-08 with two
Z.AI subscriptions on `plan-zai`: 51 requests through `zai-1` and 42 through `zai-2` in the same
window; and `plan-minimax` moved onto a second slot and back with the pool reported each way.

**Roll a key.** The key's row, *Roll*. The candidate is proved against the vendor FIRST and the
serving slot is only patched once it answers; a refusal changes nothing and says what the vendor
said. Then the credential is patched in place under a name that does not change, so no deployment is
touched and the pool never has a hole in it. MEASURED on the R750 2026-09-08: **0.26 s**, the slot's
mask moved to the other key's mask and back, and the load loop running one request every 500 ms
through that pool recorded **zero failures**. Nothing is written into any box and the customer sees
nothing: the alias did not change and neither did the label. **There is no grace period on the old
value** — the measurement under *Add a key* above is the same swap, and the new value serves the
very next request.

**Repoint an alias when a vendor retires a model.** Edit the plan model, pick the new vendor model.
The alias is a contract with every box already pointed at it and can never be renamed; the vendor
model behind it is the thing that changes. MEASURED on the R750 2026-09-08 out of the proxy's own
request log: `openai/glm-5.3` at 19:52:06, `openai/glm-4.7` at 19:53:22 after the change, and
`openai/glm-5.3` again at 19:53:37 after the change back, on the same deployment ids. That is the
next request, and it is literally the next request because `--num_workers 1` is pinned at
`deploy/coolify/proxy.compose.yml:78`, so there is no second worker to converge.

**Put a price on it, or the money columns are zeros.** The plan model form takes a cost per input
token and a cost per output token, and they are written into the deployment's `litellm_params`,
which is what the proxy bills from. LiteLLM carries no built-in price for a Z.AI or an Alibaba model
id, so nobody else supplies one: MEASURED on the R750 2026-09-08, 654 Z.AI spend rows all carried
`spend 0.000000` and a customer at 665,915 tokens read **$0.00**. Leave them blank for a
subscription that genuinely has no per-token price and every page says **not priced** instead of
drawing a zero — the two look identical on a screen and mean opposite things. A repoint keeps the
price, because `POST /model/update` merges.

**Whether a provider is well.** The chip on a provider's card has three states and they are three
different claims. *not checked* means nothing has checked — this install runs no background health
sweep on purpose, since a sweep a tenant can trigger spends the operator's money. *not answering*
means requests on that provider's own deployments really failed inside the window, counted out of
the proxy's request log, with the vendor's last message on the chip. *answering* means requests went
through and none failed, or somebody pressed *Check now*, which makes one real request per
deployment and costs the vendor one each time.

**Three clocks, and the page says which.** The proxy uses a change on the next request and a box
picks it up on its next turn. A NEW plan model reaches a customer's list within one registry cycle
*and* only after *Give every workspace access to this model*, which widens every tenant key's model
scope and writes nothing into a box. A customer's open page updates the next time that page loads,
because nothing pushes to it. There is no fourth clock and there is no bare "takes effect
immediately" anywhere on that page.

**What the customer's Titan says it runs** lives inside each box, and the panel now READS it: the
control plane has `/data/titanbot` mounted, so it opens each tenant's `box-secrets.json` and counts
the boxes whose label is not the one the plan model carries. A model with boxes behind it wears a
red *N behind on the name* chip. MEASURED on the R750 2026-09-08: before this wave no box carried
`SAND_OPENAI_COMPATIBLE_MODEL_LABEL` at all, so every Titan said `plan-zai`; demo was fixed first
and richard-avery and titanium were still behind when the panel started reporting it.

**Pushing a label writes inside a customer's box, so it always asks first.** The button sends an
empty request; the route answers with the workspaces it WOULD touch and changes nothing; you tick
the ones you mean. The boxes actually behind are ticked for you. That ceremony is not caution for
its own sake: the relay door this drives writes the base url, the key, the model, the endpoint name,
the served-by line, the context window and the label in one call, so it does not merely correct a
name — it MOVES that workspace onto this plan model. A customer who was deliberately put on
something else would otherwise be moved back by one click.

---

## 4. This file, and what is left in it

After PROVIDERS-1 `config.yaml` carries `general_settings` (no `allowed_routes`), `router_settings`
(no `fallbacks`), the TinyFish pass-throughs and `mcp_servers`. **A pass-through declared here whose
`os.environ` name is unset does not reach a customer.** MEASURED on the R750 2026-09-08:
`PROXY_TINYFISH_KEY_1` is a bare newline, so `/tinyfish/fetch` and `/tinyfish/search` were serving
with `x-api-key: ""` while every tenant key carried both paths — every box able to call a door that
could only fail upstream, booking a metered request at `cost_per_request 0.0001` each time. The
paths stay declared (they are where PROXY-7's key drops in) and the control plane decides: a mint,
and `node cp/cli.mjs proxy limits --all`, leave a path off a key while its credential header is
empty, and put it back the moment the key is really set, with no edit here and no restart. Beside it sits `bootstrap.json`,
which describes the providers, credential slots, plan models and fallback map a **fresh** install
seeds, by `os.environ` NAME only and holding no value. An install that already has rows is never
re-seeded. `config.stage1.yaml` is kept beside both: it is the one that still carries `model_list`,
and it is what a rollback reinstalls.

**Seeding a fresh install is TWO PASSES with the panel in between, and that is by design.** The
credential slots in `bootstrap.json` are named by their `os.environ` NAME, those variables live on
the **proxy** service, and this command runs inside the **control plane**, which deliberately
carries no vendor key at all — that is the whole point of the Providers panel. So on a genuinely
fresh install the first pass registers the providers and stops. Run it, put the keys in, run it
again:

```
docker exec titanbot-cp node cp/cli.mjs proxy seed        # pass one: providers registered,
                                                          # every keyless plan model named and skipped
# then, at api.titanium.bot/admin -> Providers, add each key. It is proved with the vendor as it goes in.
docker exec titanbot-cp node cp/cli.mjs proxy seed        # pass two: the plan models and the fallback map
```

The first pass ends by naming exactly which plan models it could not create and why. It does not
fail: it used to, because every deployment create answered 502 for want of a key and the CLI turned
that into a die, which left a proxy serving no plan model — and a proxy serving no plan model also
refuses to mint the first tenant ("the proxy serves no plan models, so there is nothing to mint a
key against"). Until pass two runs, that refusal is what a `tenant add` will say.

Both passes read what is really at the proxy first and skip every provider, slot and alias already
there, so a third run changes nothing and a run after somebody edited a model in the panel does not
put the file's version back.

**Rollback.** Anything wrong in the code is `git revert`, sync, and a control-plane rebuild, with no
proxy restart, because the proxy keeps serving from its database rows. Going back to a
file-configured proxy is a third restart and is an incident, not a plan: reinstall
`config.stage1.yaml`, which carries `model_list`, and turn `store_model_in_db` off in the same edit.
The database rows then go inert rather than causing an outage.

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

**Your own keys.** One row per provider id, and since PROVIDERS-1 the model on that row is a
**picker rather than a typed string** — see §6b.

Bringing your own key wins over the included set.

### 6a. The name a customer reads is never the routing alias

`plan-zai` is a **routing alias**. It exists so the proxy can pick a pool and it is the operator's
word, not the customer's. What the customer reads is `modelLabel`, which the control plane sets from
the plan model's `tb_customer_label` and which travels: control plane → `GET /v1/relay/tenants` →
`ui/tenant-registry.mjs` → `ui/server.mjs` → `SAND_OPENAI_COMPATIBLE_MODEL_LABEL` in the box's
`box-secrets.json`, where the host reads it into the persona fact its Titan answers with.

**That path was broken end to end until PROVIDERS-1, and both R750 boxes were wrong.**
`ui/tenant-registry.mjs`'s `includedOf` normalised each plan row to exactly
`{id, model, name, contextWindow, servedBy}` and dropped the label one function before it was used,
so `ui/server.mjs` read `undefined`, no box was ever given the variable, and demo's and Richard's
Titan both told their customer they run `plan-zai`. Both halves of the pin were green throughout:
the control-plane side asserted the field was SENT, and nothing asserted it was KEPT.

A customer reads the model's name in **four** places and only one of them is behind a Settings
visit, so all four are pinned now:

| where | built by | pinned by |
| --- | --- | --- |
| the agent context card, always on screen | `endpointModels` → `modelById` → `app.js` | `tests/machine-room-plugins.test.mjs`, `scripts/verify-models.mjs` |
| the agent profile panel | the same entry | the same two |
| Settings → Inference → Endpoint, and Currently answering | `app.js` `fillEndpoints` | `scripts/verify-models.mjs` |
| Settings → Included with your plan | `includedPlugins` | `tests/machine-room-plugins.test.mjs`, `scripts/verify-models.mjs` |

**MEASURED IN A REAL BROWSER ON THIS MAC, 2026-09-08** (`node scripts/verify-models.mjs`, Chrome
headless, a relay from this tree against the real `grok-bot-local-vm`): all four read
`Z.AI GLM (included with your plan) · GLM-5.3`, no string starting `plan-` appears on any of them,
and after clicking "Use this one" the box's own `box-secrets.json` carries
`SAND_OPENAI_COMPATIBLE_MODEL_LABEL=GLM-5.3`. The same run found and fixed a second thing: Currently
answering appended "(included with your plan)" to a name that already ended in those words, so every
customer on a plan read it twice.

**A plan model with no label falls back to its alias, on purpose.** That is the visible symptom of a
model nobody has named yet, and the operator's Providers panel is where it gets a name. Inventing a
prettier string would be a guess printed as a fact, and drawing nothing would hide the evidence —
today every plan model on the R750 is unnamed, so a console that dropped unnamed rows would show a
paying customer no plan at all. The rule that an unnamed or non-customer model never REACHES a
console belongs one layer up, in the control plane's `includedModelRows`; that is what stops
`plan-zai-vision` ever being minted on to a customer's screen.

**Changing the label reaches an existing box only when something writes that box's file.** The label
lives in `box-secrets.json`, so a panel edit moves the registry and the console immediately and the
BOX on its next `use-included` or Settings switch. Renaming a model and not pushing it leaves Titan
confidently saying the old name, which is the same class of quiet lie as `plan-zai` was.

### 6b. Picking a model on your own provider (MODELS-1)

The model on a bring-your-own-key card is a dropdown. Two sources, never merged, and **the card says
in one plain line which of the two it is showing**, because "this is what your provider says it has"
and "this is the list we shipped" are different claims and a person acts on them differently:

- **live** — that provider's own `/models`. `ui/server.mjs`'s `probe()` has returned it on every
  catalog row as `health.models` since TENANT-2 and nothing read it until this wave.
- **curated** — the list `ui/subscriptions.mjs` ships for that provider. It is the only answer for a
  provider with no list to read: Codex is transport `responses` against the Codex backend, is never
  probed, and is always curated. Alibaba's five model names used to be a sentence inside its posture
  string ending "type the model you want"; they are structure now.

The curated row is also where the FACTS live — a context window somebody actually measured, and
whether the model takes an image — because a live list is **names and only names**. The model the
box is currently on is always in the list even when the provider has stopped listing it, so the
picker can never quietly read back a model the box is not running.

**A model with no measured context window writes no context window.** `endpointEntry` used to stamp
the preset's number on whatever was chosen (measured on this Mac 2026-09-08: adopting `zai` with
`glm-5.3-flash` wrote `128000`, which is `glm-5.3`'s number). Leaving it out is not a degraded
answer — the host has its own default — whereas a wrong one is either a conversation compacted
before it needed to be or a prompt the vendor rejects on every single turn.

Choosing a model is `POST /subscriptions/adopt` with `{id, model}` and no key: a re-adopt with no key
keeps the stored one, so there is no new route and the credential never moves. If the box is already
answering through that provider the switch is applied to the box as well; if it is not, the card
says so rather than promising something it will not do.

**MEASURED IN A REAL BROWSER ON THIS MAC, 2026-09-08:** the Z.AI card offered six models, said
*"Z.AI GLM (coding plan)'s own list could not be read just now, so this is the list we ship for it"*,
said *"This box is answering somewhere else, so a change here waits until you pick this provider
above"*, and choosing `glm-5.3-flash` moved the stored endpoint and wrote **no** context window.

### 6c. The three clocks, and never "immediately"

"Takes effect with no restart" is three different sentences and the copy has to say which:

| what changed | when it takes effect |
| --- | --- |
| the vendor model behind an alias | the next request at the proxy, and the next turn in a box |
| a newly added plan model | within one registry cycle, plus the panel's "give every workspace access" step |
| a model or label written into a box | that box's next turn — the host re-reads `box-secrets.json` on every stream |
| the customer's open page | its next hydrate. `refreshSubscriptions` runs only after a local action and nothing pushes |

Never a bare "takes effect immediately."

### 6d. What a customer sees while you roll a key

**Nothing.** The alias does not change, the label does not change, and `box-secrets.json` is not
touched, so no box is written to and no page needs to redraw. That is the whole reason the roll is a
credential edit rather than a re-mint: a re-mint writes a new key into a box and drags in the
registry cycle with it, which is the hazard that put a revoked key into a snapshot on 2026-09-08.

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

> **The two entries were in the wrong place until 2026-09-08.** They sat at the TOP LEVEL of
> `config.yaml`; LiteLLM reads `pass_through_endpoints` from `general_settings` and nowhere else,
> so the block was parsed and discarded, the proxy listed no `/tinyfish` path in its own
> `openapi.json`, and every call to one answered `404 {"detail":"Not Found"}` on the R750 while the
> table below described a route that had never served a request there. The block is now under
> `general_settings`, `scripts/verify-proxy.mjs` asserts both the placement in the file and that the
> running proxy actually registered the route, and the table below is still a **measurement taken on
> this Mac against a stub** — the R750 leg of it is owed by `PROXY-7`, which also needs
> `PROXY_TINYFISH_KEY_1` set before any of it serves a customer.

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

### 6e. The fallback map, and where it really lives (BASELINE-1, 2026-09-16)

`plan-minimax` answered a real turn with `MinimaxException - invalid params, 400 (2013)` on the demo
box on 2026-09-15, and the customer saw "Agent failed to respond" because `Fallbacks` named only
`plan-zai`, so that group had nowhere to go. The 400 did not reproduce: 72 requests over four turns
the next day were all 200, so it is intermittent and provider-side, and a fallback is the right
answer precisely because the cause is not ours to fix.

Fallbacks are registered through `POST /fallback` on the running proxy rather than by editing this
file: the map moved into the database with PROVIDERS-1 and a `fallbacks` key in `config.yaml` would
duplicate it. No restart is needed. Persisted, read straight out of `LiteLLM_Config.router_settings`,
so it survives one.

**Every group now falls back across providers (2026-09-17).** The first map sent four groups to
`plan-zai` and sent `plan-zai` only to `plan-zai-vision`, which is the same provider and the same
balance. On 2026-09-17 that provider's balance ran out, and because every chain ended inside it
there was nowhere to go: `plan-zai` and `plan-zai-talk` returned 429 for staff and, by 18:08, for
`beta-36` as well. Jason's instruction was that all of them should have fallback providers, so each
chain now leaves the provider it started in:

```json
{"fallbacks": [{"plan-zai":        ["plan-zai-vision", "plan-qwen", "plan-minimax"]},
               {"plan-zai-vision": ["plan-qwen", "plan-minimax"]},
               {"plan-zai-talk":   ["plan-zai-vision", "plan-qwen", "plan-minimax"]},
               {"plan-zai-code":   ["plan-qwen", "plan-minimax"]},
               {"plan-qwen":       ["plan-zai", "plan-minimax"]},
               {"plan-minimax":    ["plan-qwen", "plan-zai"]}]}
```

`plan-zai-code` is a `hosted_vllm` alias and the proxy accepted a fallback on it like any other.
Measured immediately after the write, with the zai balance still spent: one `plan-zai` chat request
on the demo workspace's own key returned 200 served by `qwen3.8-max` in 8823 ms, and the same
request on beta-36's key returned 200 served by `qwen3.8-max` in 4253 ms. Both spend rows record
`model_group = plan-qwen`, so the spend log names the group that SERVED a request, not the one that
was asked for; a chain that fell through leaves no row for the legs that failed.

Two things to hold in mind. A chain that names a dead group first pays that group's attempts before
it falls through, which is where the 8823 ms above went. And these chains are mutual, so a provider
outage now spends the other providers' quota rather than failing: that is the trade Jason asked for,
and it is worth watching the daily totals per group after a long outage.

A fallback is per request, so a provider hiccup costs that one answer some speed instead of failing
it. Measured after the write, each alias still served itself: `plan-minimax` 1721 ms, `plan-qwen`
1934 ms, `plan-zai-talk` 2702 ms, `plan-zai` 1528 ms. To take one back out, POST the same shape with
an empty list, `{"model":"plan-minimax","fallback_models":[]}`, and read it back with
`GET /fallback/plan-minimax`.

---

### 7b. Putting a box on that route (BASELINE-1)

Until 2026-09-15 the three values above could only be written by a person with a shell inside
somebody's container. `tinyfish-route.ts` has always read them; nothing wrote them. So the host
carries two gateway commands and the control plane carries the verbs that call them.

```
node cp/cli.mjs websearch list                             # every workspace's route. Writes nothing.
node cp/cli.mjs websearch set <slug|--all> --dry-run       # what it would write, per workspace
node cp/cli.mjs websearch set <slug>                       # write it, then prove the door
node cp/cli.mjs websearch set <slug> --prove               # and ask that workspace's own bot
```

`getWebSearchRoute` answers with the route a box resolves (`connector`, `api` or `none`), the two
addresses it dials, whether those are the proxy or the vendor's own hosts, and the stored key's
length with twelve characters of its sha256. It never answers with a value. `setWebSearchRoute`
moves the credential and both addresses together, because a box holding a new key against old
addresses answers nothing and blames the site.

Neither goes through `setConnectorSecret`. That door resolves a connector out of `connectors.json`
and then refuses any field the entry does not declare as a credential; a box with no TinyFish
connector installed has neither, and two of the three fields are addresses rather than credentials,
so all three writes would be refused.

**It refuses when the proxy's doors are empty, and that is the state today.** Measured on the R750
2026-09-15: `PROXY_TINYFISH_KEY_1` and `PROXY_TINYFISH_KEY_2` are set as names and hold zero
characters, and `GET /config/pass_through_endpoint` reports `x-api-key` empty on both
`/tinyfish/fetch` and `/tinyfish/search`. Pointing a customer's box at that would replace "nothing
is set up here", which is true and actionable, with a failure upstream on every question that books
a metered request on the way. So the proxy is asked once, before the loop, and the refusal names
`PROXY_TINYFISH_KEY_1` and touches no workspace at all. This is `PROXY-7`, and it is the one thing
between this command and every tenant having search.

**Two proofs, and only one of them is free.** After a write, the command asks the proxy's own search
address the same question a box's host would ask it, on that box's own key, and counts the results:
a 200 carrying no results is what an empty credential returns, so the count decides and not the
status. `--prove` additionally asks that workspace's own bot a real question, which puts a visible
message in a customer's conversation and spends their allowance, so it is opt-in and the help says
why.

---

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

**Removal reaches four places, and the fourth is the one that was missed.** MEASURED ON THE R750
2026-09-08: the migration deleted the operator's provider key from `box-secrets.json` in all three
boxes and proved it gone by reading that file back — while a byte-identical copy sat in each box's
own content-addressed store at `/var/lib/sand-box-store/<store id>/blobs/<sha256>`, mode 0644
root:root, put there by `box-store-sync`. The agent host runs as root inside the box, so a shell
tool call could read it. Two changes: the host no longer offers `box-secrets.json` or
`connector-env-secrets.json` to the store at all, and `forget-provider-keys` now sweeps the store
and deletes the stored copies. **What it does NOT delete** is a store file that carries the value
and is not one of those two documents — a pack of unrelated files, an agent's conversation database,
an audit log. Those are named in the answer with their paths and left where they are, because
deleting one to chase a credential is the customer's data gone. **A credential that has been in a
box has to be rotated at the vendor.** The sweep is what stops it spreading; rotation is what ends
it.

**A rate limit is the only ceiling today.** `CP_PROXY_ENFORCE` is deliberately empty, so
`soft_budget` is advisory by LiteLLM's own definition and no request is ever refused for spend.
`CP_PROXY_RPM_LIMIT` is what stops one workspace consuming the pooled subscription; see §2 for what
that number is and is not. Until enforce is armed, "the plan is spent" is a fact on the admin
panel and not a thing that happens to a customer.

**The door list is global, so it cannot separate a tenant from the operator.**
`general_settings.allowed_routes` is checked before the key is looked up, which is what makes it
work on the open-source build and also what stops it being per-key. It closes `GET /health` — which
a tenant's key could call, and which makes a live call to every provider deployment on the
operator's subscriptions — and everything else the product does not call. It cannot close
`/key/info` or `/model/info`, because `cp/admin.mjs` and `cp/proxy.mjs` call both. On v1.100.0 a
virtual key that knows another tenant's key HASH can read that key's alias, models, spend and budget
from `/key/info`. Not guessable at 64 hex, so it needs a leak to exploit, and it is `PROXY-8`.

**PROVIDERS-1 moves that boundary from the global list to the key**, because a global list cannot
tell a tenant from the operator and two of the panel's central mechanisms are path-parameter routes
an exact-match list cannot express at all. The replacement is `allowed_routes` on each virtual key at
mint, plus a backfill over every key already in the field — and the ORDER is load bearing: keys in
the field today were minted with `allowed_routes []` and are unrestricted, so the backfill lands
BEFORE the global list is removed or there is a window where the admin surface is open to every box
on the bridge. **The per-key 403 and the backfill are measured by this wave's proxy and control-plane
items, on the R750, and their numbers belong in this section rather than a guess written ahead of
them.** Until those land, the paragraph above is the state of the machine.

One correction to that paragraph while it stands: the door list does **not** close everything.
**MEASURED ON THIS MAC, 2026-09-08, against LiteLLM v1.100.0 in Docker with NO `Authorization`
header:** `/public/providers`, `/public/providers/fields`, `/public/model_hub`,
`/public/litellm_model_cost_map` and `/health/readiness` all answered **200**, while `/model/info`
and `/key/info` answered 401. Those five are unauthenticated on this build, so no key-checking or
route-checking runs on them at all. None of them carries a customer's data or a key, which is why
this is a correction to the claim rather than a defect — but the claim was wrong, and the R750's own
run of the same seven requests belongs beside this line once the proxy item takes it.

---

## 9. Per-tenant rollback

`cp/cli.mjs proxy rollback <slug>` replays that box's pre-migration `box-secrets.json` from the
0600 snapshot taken during the migration, through the same door the migration used. The host
re-reads that file on every turn, so it takes effect on the next message: no restart, no recreate.

**The snapshot is written once and never overwritten.** MEASURED ON THE R750 2026-09-08: demo was
migrated twice inside a minute while a re-mint hazard was being fixed, and the second run
snapshotted what the first had left — a revoked virtual key pointed at the proxy. Rolling demo back
would have taken it off the air and reported success. `use-included` now writes the file only when
there is none, and takes none at all from a box that is already on a plan; its answer says which of
`written`, `kept` or `none` happened, and `proxy migrate` prints it.

**`node cp/cli.mjs proxy list` has a WAY BACK column**, and it is the thing to read before promising
anybody a rollback: `kept` is a true pre-migration state, `on-proxy` is a snapshot that would leave
the box on the proxy, `none` is a workspace with no snapshot at all.

**demo's snapshot was retired on the R750, 2026-09-08.** It held the state its FIRST migration left
— a revoked virtual key pointed at the proxy — so `proxy rollback demo` would have taken the box off
the air and reported success. It is now
`/data/titanbot/demo/profile/model-proxy-rollback.json.was-a-plan-state-20260908`, which the
rollback door does not read, so demo answers the honest 409 and rolls back through Settings like
`titanium`. Delete the retired file when the week is up.

**Jason's own workspace (`titanium`) has no snapshot and is not getting one.** Its pre-migration
state was the copied operator key that this wave exists to remove and that has to be rotated at the
vendor, so replaying it would put a dead credential back. `titanium` rolls back by picking an
endpoint of its own in the console's Settings, which is the same door any customer uses.

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
| one workspace runs away | that workspace is rate limited, everyone else is unaffected | raise `CP_PROXY_RPM_LIMIT` and run `proxy limits --all` |
| a tenant tree on disk the ledger does not know | it is invisible to migration, spend and revocation | `node cp/cli.mjs tenant orphans` names them; every fleet-wide proxy command prints them too |

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
