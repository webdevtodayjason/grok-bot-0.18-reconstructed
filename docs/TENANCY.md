# One console, one container per customer

**Status:** the shape is decided and the code is landing. TENANT-1 built the control plane and
TENANT-2 built one relay per customer on one hostname per customer. Jason read that shape back on
2026-09-07 and said no, in these words:

> The tenant console, if somebody's logged in to the console, is the same no matter what. Depending
> on their login, they get a specific set of agents in their own sandbox Docker container. Each
> tenant should have an agent set with its own sandbox Docker container that the agents live in.
> That's it. In my mind there should only be one extra Docker container per tenant. Every time we
> add somebody new, we're basically duplicating everything. That sounds crazy.

So TENANT-5 is that. One relay, one console, one login page, and a customer is one box container
plus one directory. Section 15 is what changed from TENANT-2 and why, and section 22 is the
migration as it was run.

    titanium.bot                 the marketing site
    console.titanium.bot         THE console. Everybody signs in here, Jason included.
    api.titanium.bot             the control plane, this document
    <slug>.titanium.bot          retired. No tenant has a hostname of its own any more.

A customer signs in with an email address and a password at `console.titanium.bot` and lands on
their own agents. Which customer they are is decided by their session, and everything the request
touches after that is resolved from it: which box, which gateway token, which directory. The
separation is a container and a directory tree per customer, not a `WHERE tenant_id = ?` and not a
second copy of the console.

    console.titanium.bot  ->  the one relay  ->  Acme's box       Acme's agents and files
                                            ->  Bolt's box       Bolt's agents and files
                                            ->  Jason's box      Titan and Scribe

Three words used throughout:

- **account** a person. An email address, a password and the tenant they belong to.
- **tenant** a customer. A short name, a box container, a directory on the server, and a row in the
  control plane. Not a hostname and not a console.
- **session** the twelve hour proof that a person signed in, signed by the control plane and
  checked by the relay with that tenant's own key.

---

## 1. The four parts

| part | how many | where |
| --- | --- | --- |
| the control plane | one | `cp/` in this repo, a Coolify service at `api.titanium.bot` |
| the console | **one, for everybody** | the relay from `deploy/coolify/docker-compose.yml`, Coolify service `p927bfqm83ioloibamlvyd7g`, `console.titanium.bot` |
| a tenant | one box container per customer | rendered by the control plane, a Coolify service each |
| the shared release files | one copy | `/home/sem/titanbot/{runtime,deploy,ui}` on the R750 |

The control plane holds the accounts, mints the sessions, asks Coolify for boxes, and tells the
relay which customer has which box. `cp/README.md` is how to run it and what its routes are.

The console is Jason's existing relay. It was not rebuilt or duplicated; it grew a per-request
tenant. That is the whole of the change on the relay side and it is why there is nothing new to
deploy on a machine with one box on it.

The release files are shared on purpose. A ship is an rsync and a restart, once, and every customer
gets it. Per-tenant copies of a 19 MB host bundle would mean a ship that is done for some customers
and not others, which is the failure nobody notices until one of them reports a bug that was fixed a
week ago.

### The control plane's own files

| file | what it is |
| --- | --- |
| `cp/server.mjs` | the HTTP API |
| `ui/session-token.mjs` | the session token itself: mint, verify, and each tenant's derived key. Node builtins only, so both sides can import it |
| `cp/session.mjs` | a re-export of the file above, so the control plane's imports read as its own |
| `cp/store.mjs` | the sqlite store and the password hashing |
| `cp/provision.mjs` | turning a name into a running box |
| `cp/cli.mjs` | the operator's commands |
| `cp/Dockerfile` | the image |
| `deploy/coolify/control-plane.compose.yml` | the Coolify resource |
| `scripts/verify-control-plane.mjs` | the gate |

Node 22 or newer and no dependencies at all: the store is `node:sqlite`, the passwords are
`node:crypto` scrypt, the API is `node:http`. There is no `package.json` in the image and no
`node_modules`, which is the point.

### What the control plane reads from the environment

| name | default | what it is |
| --- | --- | --- |
| `CP_PORT` | `7790` | the port it listens on |
| `CP_DATA_DIR` | `/data/titanbot/_control-plane` | the directory holding the sqlite file |
| `CP_SESSION_SECRET` | none | 32 bytes or more, the master key. Never handed to a tenant and never handed to a browser. Required. |
| `CP_ADMIN_TOKEN` | none | the operator bearer for the account and tenant routes. Required. |
| `CP_RELAY_TOKEN` | none | **new in TENANT-5.** The bearer for `GET /v1/relay/tenants` and nothing else. The admin token does not open that route and this one opens no other. 32 characters or more. |
| `CP_BASE_DOMAIN` | `titanium.bot` | kept for the console's own address; no tenant hostname is built from it any more |
| `CP_COOLIFY_URL` | none | this Coolify's api address. **Not** `COOLIFY_URL`: Coolify puts one of its own into every service container and it wins |
| `COOLIFY_API_KEY` | none | an API token with write access to the project |
| `COOLIFY_PROJECT_UUID` | none | the project new tenants are created in |
| `COOLIFY_SERVER_UUID` | none | the server they run on |
| `COOLIFY_ENVIRONMENT_NAME` | `production` | the environment inside that project |
| `COOLIFY_ENVIRONMENT_UUID` | none | sent alongside the name only when set |
| `CP_TENANT_ROOT` | `/data/titanbot` | the directory holding every tenant's own tree |
| `CP_RELEASE_ROOT` | `/home/sem/titanbot` | the shared release: runtime, deploy, ui |
| `CP_PUBLIC_URL` | `https://api.titanium.bot` | where this service answers |
| `CP_DRY_RUN` | unset | when `1`, every tenant create is a rehearsal |
| `CP_ALLOW_NEW_TENANTS` | unset | when `1`, this service may build new customer boxes |
| `CP_ALLOW_SIGNUP` | unset | when `1`, `POST /v1/signups` is open without the admin token, behind the same lockout |
| `CP_TRUSTED_PROXIES` | none | the CIDRs whose `X-Forwarded-For` may say who the visitor is |
| `CP_CLOUDFLARE_RANGES` | none | which of those may hand over a `CF-Connecting-IP` |
| `CP_RELAY_PEERS` | none | the CIDRs whose sign-ins are the relay forwarding a customer. Their failures are counted by email only |

`CP_SESSION_SECRET` and `CP_ADMIN_TOKEN` are required and the service says so and stops if either is
missing. With no Coolify settings it still runs: tenants can be recorded and adopted, they just
cannot be built.

### What the relay reads, now that there is one of it

| name | what it is |
| --- | --- |
| `CP_URL` | the control plane. Empty means no control plane at all, which is the single-box console |
| `CP_RELAY_TOKEN` | the credential for the registry route. The same value as on the control plane |
| `SAND_BOX_CONTAINER` | **required now.** The operator's own box container, for `docker exec` |
| `SAND_HOST_GATEWAY_URL` | the operator's own box gateway, `http://titanbot-box:1340` |
| `SAND_UI_STATE_DIR` | the operator's own writable files |
| `SAND_PROFILE_DIRS` | where the operator's own gateway token file is |

`TENANT_ID` and `CP_SESSION_SECRET` are **gone from the relay**. `TENANT_ID` said "this whole
process belongs to one customer", which is the sentence that stopped being true.
`CP_SESSION_SECRET` was one tenant's derived key; the relay now receives every tenant's derived key
on the registry route.

`SAND_BOX_CONTAINER` used to be deliberately unset, with the relay falling back to
`docker ps --filter label=com.titanbot.role=box` and taking the first name back. On a host with one
box that is a convenience. On a host with twenty it is an arbitrary customer's container, and the
operator's model picker, connector editor and desktop buttons would have been reaching into it. The
fallback is deleted. A box name that is not a container on this host is never guessed at: that
customer's requests answer the sentence in section 6.

---

## 2. What a tenant is, exactly

**One container and one directory.** That is the whole definition and it is the thing Jason asked
for.

On Coolify: one service named `titanbot-<slug>` in the project Titanium Computing, environment
production, on the R750, with **one** container in it, the box. No relay, no hostname, no domain,
no certificate. Coolify names that container `titanbot-box-<service uuid>`, which is measured, not
assumed: both live boxes on the R750 are exactly that shape.

On the disk, under `CP_TENANT_ROOT` (`/data/titanbot` on the R750):

    /data/titanbot/<slug>/
      profile/local-docker-vm.json     the tenant's gateway token, 0600
      credential/                      the inference placeholder the box needs to start
      state/                           this tenant's own settings: endpoints, mail, the job bus token
      volumes/workspace/               the agents' files
      volumes/data/                    agents, transcripts, memory
      volumes/store/                   the box store, which is what survives a recreate
      volumes/chrome/                  the browser profile

`state/auth.json` is gone. It held a per-tenant relay password, and under TENANT-5 there is no
per-tenant relay for it to open: one console, one operator password file. Provisioning stopped
writing it and the CLI stopped printing one. A customer must never be handed a password that opens
nothing.

On DNS: nothing at all. The proxied wildcard `*.titanium.bot` can stay where it is; no tenant
depends on it and no tenant is reachable from outside the host.

The control plane's own sqlite store lives at `/data/titanbot/_control-plane`, under the same root
so one backup covers both. No tenant can collide with it: a slug is 3 to 32 characters of
`[a-z0-9-]` that cannot begin or end with a dash, so nothing can start with an underscore.

That backup is `deploy/backup/snapshot.sh`. It copies the whole root live, and retakes the control
plane's own directory with that container paused, because a sqlite file copied mid-write restores
without complaint and is still wrong. `deploy/backup/restore-drill.sh` opens it.

---

## 3. The shared network

One relay serving every customer has to reach every customer's box, and Coolify puts every resource
on a network of its own. So there is one external network, created once on the host and never by a
deploy:

    docker network create titanbot-net

The relay, the control plane and every box join it. Both compose files declare it `external: true`,
which means docker attaches to what is already there and creates nothing; if the network is missing
the deploy fails loudly, which is the right direction. Coolify's parser leaves a top-level network
entry alone when the compose already declares it, and it merges its own per-resource network in
beside whatever a service declares, so both networks end up attached.

The relay reaches a customer's box at `http://<that customer's box container>:1340` with that
customer's own gateway token.

### The trap, and the label that closes it

**This is the one thing in TENANT-5 that can take Jason's console down, so it is written out in
full.** Measured on the R750, 2026-09-07: `coolify-proxy` is `traefik:v3.6` started with
`--providers.docker=true` and **no** `--providers.docker.network`, and the relay container carried
no `traefik.docker.network` label of its own.

For a container on more than one network, Traefik with no default network takes the first entry of
the container's network map. Go randomises map iteration order, so which address it routes to is
redecided on every provider refresh. The symptom is `console.titanium.bot` answering 502 at random,
hours after a deploy that looked fine, and it is not reproducible and not attributable to the change
that caused it.

The fix is one label on the relay, pinning which of its two addresses Traefik routes to:

    traefik.docker.network: titanbot-net

**A literal, and it has to be one.** The first attempt at this on the live server wrote the label as
`${TITANBOT_PROXY_NETWORK}` and set that variable on the resource. It did not work, and the way it
failed is worth knowing, because it fails silently. Coolify's parser rewrites every `${...}` inside
a `labels:` block to `$${...}` on its way to the generated compose, which docker reads as an escaped
dollar. Read back off the running container, the label was the twenty-six literal characters of the
variable's own name. The variable was set, it was in the `.env` Coolify wrote beside the file, and
none of that mattered. That outcome is worse than having no label at all: the pin is present, it
names no network, and the console is back on the coin flip after a deploy that read as clean.

`titanbot-net` is the right literal because it is the one network name the file itself declares and
every service in it joins, and Coolify attaches `coolify-proxy` to it on deploy (read back after the
first one: `coolify-proxy` sits on `titanbot-net` beside the relay and the box). The alternative was
Coolify's own per-resource network, whose name is the resource's uuid, and a file cannot know its
own uuid.

The control plane needs no pin: `api.titanium.bot` is not routed through a second address the way
the console is. It joins `titanbot-net` for one reason of its own, which is that it waits for a new
customer's box to answer on `http://titanbot-box-<uuid>:1340` before it calls the workspace ready,
and that address exists only on the shared network.

**And the label is gated, not trusted.** Coolify does not deploy the compose it is given: it parses
it, rewrites parts of it and deploys the result. Custom labels are believed to survive that rewrite
(`com.titanbot.role` does), but that is one sample of one label. So `scripts/verify-deploy.mjs`
reads the label back off the running container after every restart and fails loudly when the relay
is on more than one network without a pin, or with a pin naming a network it is not on. A stripped
label is caught by a gate, not by the console going down on a Tuesday.

### Plan B, if the relay cannot be multi-homed here

Leave the relay single-homed on its own Coolify network and put every tenant's box on **that**
network instead of on a new shared one: the control plane renders `CP_SHARED_NETWORK` into each
tenant's compose and the value is the relay resource's own network name. Same reachability, no
second network on the relay, and therefore no Traefik ambiguity at all.

It costs one thing, which is why it is plan B: the boxes then live on a network Coolify created for
a resource it can delete, so deleting the relay resource takes the customers' network with it.

---

## 4. The registry: how the relay knows which box is whose

The control plane is the source of truth. The relay reads it once a minute and holds it in memory.

    GET https://api.titanium.bot/v1/relay/tenants
    authorization: Bearer <CP_RELAY_TOKEN>

    200 {
      "tenants": [
        { "slug": "acme", "name": "Acme Roofing", "status": "running",
          "box": "titanbot-box-<uuid>", "gateway": "http://titanbot-box-<uuid>:1340",
          "token": "<that tenant's gateway token>",
          "sessionKey": "<that tenant's derived session key>",
          "stateDir": "/data/titanbot/acme/state",
          "profileDir": "/data/titanbot/acme/profile" },

        { "slug": "titanium",
          "sessionKey": "<that tenant's derived session key>" }
      ],
      "skipped": [
        { "slug": "halfbuilt", "why": "no gateway token on disk yet" },
        { "slug": "titanium", "what": "tenant",
          "why": "this workspace has no gateway token on this server" }
      ]
    }

The second row is the operator's own, and it is a different shape on purpose: an **adopted**
workspace, where this service holds no box, no gateway token and no directories, gets a row carrying
only the fields the relay cannot build for itself. Today that is two: `sessionKey` (SIGNIN-2) and
`included` when a plan is on (PROXY-1). The rest of the row really is absent, so it is also named in
`skipped` saying why, and the relay is deliberately quiet about that one line rather than reading it
as a fault every sixty seconds.

`box` is computed as `titanbot-box-<coolify service uuid>`, which is measured on this host rather
than assumed, so no schema change was needed to carry it. `token` is read off that tenant's own
`profile/local-docker-vm.json`, the file `ensureSecrets` already writes at 0600. `sessionKey` is
`tenantSessionSecret(master, slug)`.

A row with no Coolify service uuid, no token file, or status `failed` is left out of `tenants` and
named in `skipped`, so the relay can log **why** a customer is missing rather than answering them a
bare 404.

### Two doors, and neither holds the other's key

`CP_RELAY_TOKEN` opens this route and nothing else. `CP_ADMIN_TOKEN`, which can create and delete
customers, does **not** open this route. That is deliberate: this is the one place in the control
plane where a gateway token or a session key leaves the service, so it has a credential of its own.

**This amends a rule.** The header of `cp/server.mjs` says this service never returns
`CP_SESSION_SECRET` and that a test walks every route asserting it. That sentence is still true and
it gains one clause: this route returns per-tenant **derived** keys and per-tenant gateway tokens,
to the relay credential and to nothing else. The master never leaves. Amending it deliberately, with
a gate that names it, is the difference between a design decision and a fleet-wide key leak, so
`scripts/verify-one-console.mjs` asserts all four cases end to end: 401 with no bearer, 401 with the
admin token, 200 with the relay token, and the master's own bytes appearing nowhere in the body.

### The operator's own entry is built here, and two fields are merged onto it

Tenant `titanium` is the relay's own. It seeds that entry at boot from the environment it already
has: `SAND_BOX_CONTAINER`, `SAND_HOST_GATEWAY_URL`, its gateway token, `SAND_UI_STATE_DIR` and the
first `SAND_PROFILE_DIRS` entry.

That is the whole compatibility story, and it is load bearing three times over:

- With no `CP_URL` the registry holds exactly **one** entry, every seam resolves to it, and the
  relay behaves on a developer Mac and on a single-box install precisely as it did before TENANT-5.
- A control plane that is down, or slow, or being redeployed, cannot take Jason's console with it.
  That is rule 3 of `ui/tenant-login.mjs` restated: the control plane is allowed to be down.
- A refresh never overwrites what the environment decided. `box`, `gateway`, `token`, `stateDir` and
  `profileDir` are not read off a `titanium` row at all, so a control plane with one of those fields
  wrong still cannot point Jason's console at somebody else's box.

**Two fields are merged on, and both for the same reason: nothing in the relay's own environment can
produce them.**

| field | why only the control plane has it |
| --- | --- |
| `included` | PROXY-1. The virtual key is minted at the metering proxy with a master the relay does not hold, and it arrives on this row and on no other route. |
| `sessionKey` | SIGNIN-2. It is `tenantSessionSecret(master, "titanium")`, and that master never leaves the control plane, so there is nothing here to derive it from. |

Both are assigned **unconditionally**, so the control plane turning one off turns it off here rather
than leaving this console serving a dead value. A control plane that is merely **down** is a
different case and a safe one: no row arrives at all, the entry keeps its last good key, and nobody
is signed out over it.

Before SIGNIN-2 the key was not merged, and the cost was specific. MEASURED on the R750
2026-09-10: the control plane's row for `titanium` carried `slug` and `included` and nothing else,
`registry.sessionKeyOf("titanium")` was therefore `""`, and an account on Jason's own workspace met
**503 "That workspace is not available right now."** with a correct password while the
byte-identical account on `demo` signed in at once. One missing field, and the only visible symptom
was a sentence about availability.

### Cache, refresh and box verification

A refresh is a 10 second GET. On success the map is rebuilt, always re-inserting the env-seeded
operator entry. On failure the last good map is kept and one line is logged per failure streak, so
a control plane outage is a log line rather than an outage:

    reg  could not reach the control plane (timed out); serving the 3 tenants last read at 09:41

Every 60 seconds, plus a refresh on a miss, rate limited to one per 10 seconds so a stranger with an
old signed cookie naming a made-up slug cannot pump the control plane.

Each refresh runs **one** `docker ps` for the whole fleet and builds a name set. A registry entry
whose box is not in that set is marked unreachable and its requests answer the sentence in section
6. A name is never guessed at, and because Coolify names by uuid a name can never be reused across
customers.

`SAND_UI_TENANTS_FILE` reads a JSON file in place of the control plane, the same kind of documented
override as `SAND_UI_AUTH_FILE`. It is what makes the registry, including the unknown-tenant answer,
testable with no control plane and no network.

---

## 5. One request, one tenant

The session cookie carries the tenant slug, and every request resolves exactly one tenant from it,
once, at the top of the handler.

| how somebody arrives | which tenant |
| --- | --- |
| an account sign-in | the `tenant` claim on the verified control plane token |
| the instance password | `titanium`, the operator |
| the gateway bearer | `titanium`, the operator |
| `GET /login?sso=<token>` | the tenant the token claims, after its signature verifies under that tenant's key |
| a cookie with no tenant claim | `titanium`, the operator. This is what keeps Jason signed in across the deploy |

From that one slug the request gets its gateway URL, its gateway token, its box container name, its
state directory and its profile directory. Everything downstream takes them as parameters rather
than reading a module-level constant:

| surface | what it resolves per tenant |
| --- | --- |
| `POST /api/<command>` | that tenant's gateway, that tenant's token |
| `GET /events` | the same |
| the VNC and desktop bridge | that tenant's box container, by name, over `docker exec` |
| `/endpoints`, `/endpoints/use` | that tenant's `endpoints.json`, that tenant's box |
| `/v1`, the job bus | that tenant's `profile/job-bus.json` |
| mail | that tenant's `mail.json` and `mail-inbox.jsonl` |
| the runtime bundle route | that tenant's box |
| the login lockout | shared, keyed by address, exactly as before |
| subscriptions | **operator only.** See below |

**Subscriptions are operator only.** `/subscriptions`, `/subscriptions/adopt` and
`/subscriptions/forget` scan the operator's own machine credentials, the Codex and Claude logins on
the host. A customer gets an empty list and the two POSTs answer the ordinary not-available refusal.
That is both safer and a smaller change than threading a file through a module that has one store.

**The relay keeps the docker socket, and that is the point.** It is ours, it is not a customer's
container, and it is the one process that reaches into every box. A customer never gets a socket
because a customer never gets a relay.

### Mail, and the one thing that was refused

`/hooks/resend` carries no session, so the tenant has to come from the message. The scheme first
proposed was a shared domain with a unique agent name per tenant, and it is **refused as unsound**:
agent names are not unique across customers, and the moment two of them each have a Titan,
`titan@titanium.bot` is ambiguous, which is the wrong kind of ambiguity to have in a mail router.

What is sound and costs one lookup is routing by **domain**. `mail.json` already lives per state
directory and already carries the domain. The webhook reads the recipient domain out of the
unverified body, picks the tenant whose `mail.json` names that domain, and **that tenant's own
webhook secret then verifies the signature before anything else is read**. Choosing a key from an
unverified claim and then verifying under it is the pattern `ui/session-token.mjs` already blesses:
a liar picks a key the message was not signed under and the check fails. A domain is verified inside
exactly one Resend account, so a tie is impossible. No tenant owning the domain answers
`200 {"ignored":"no_tenant"}`, never a retry over a decision.

**If that proves flaky in the gate, mail stays operator only and `docs/MAIL.md` says so.** That is
the documented fallback and it is not a failure: mail is the one surface where an ambiguous route is
worse than no route.

---

## 6. What a customer sees when their workspace is not there

A session naming a tenant the registry does not know gets the login page, 503, and one sentence:

> That workspace is not available right now.

**The cookie is deliberately not cleared.** A tenant is unknown while its box is being built, while
Coolify is recreating it, and while the control plane is restarting. Signing a customer out over a
transient state is worse than the sentence, and a person who comes back in two minutes should find
themselves still signed in.

Not a 500, not a stack trace, not somebody else's console, and not a bare 404.

---

## 7. The routes

Open to anybody:

| route | what it does |
| --- | --- |
| `GET /v1/health` | `{ok, version, tenants, accounts}`. Counts only |
| `POST /v1/sessions` | `{email, password}` in, a session out |
| `GET /v1/sessions/current` | who this session is, with the session as the bearer |
| `DELETE /v1/sessions/current` | sign out, which revokes this session here |
| `POST /v1/signups` | `{email, password, company}`, open only when `CP_ALLOW_SIGNUP=1` |

Behind `CP_RELAY_TOKEN`:

| route | what it does |
| --- | --- |
| `GET /v1/relay/tenants` | the registry. Section 4 |

Behind `CP_ADMIN_TOKEN`:

| route | what it does |
| --- | --- |
| `POST /v1/accounts` | add a person: `{email, password, name, tenant}` |
| `GET /v1/accounts` | list them, never with a hash |
| `POST /v1/accounts/{id}/password` | an operator reset |
| `POST /v1/signups` | the same route, with the admin token instead of the open flag |
| `POST /v1/tenants` | add a customer and start building their box |
| `GET /v1/tenants`, `GET /v1/tenants/{slug}` | the record, plus what Coolify says right now |
| `POST /v1/tenants/{slug}/adopt` | claim a box that already exists |
| `POST /v1/tenants/{slug}/provision` | run the build again, from wherever it stopped |
| `POST /v1/tenants/{slug}/stop`, `/start`, `/restart` | pass it on to Coolify |
| `DELETE /v1/tenants/{slug}` | remove the Coolify service. The data directory is kept |

### Signing up

    POST https://api.titanium.bot/v1/signups
    {"email": "owner@acme.example", "password": "...", "company": "Acme Roofing"}

One call creates the account and the tenant and starts building the box. The slug is derived from
the company name, made unique, and checked against the reserved list. Open without the admin token
only when `CP_ALLOW_SIGNUP=1`, and behind the same lockout that protects sign-in.

From the operator's side it is one command, and the password is prompted rather than typed on the
command line, because an argument is in the shell history and in `ps` output:

    node cp/cli.mjs signup add owner@acmeroofing.com "Acme Roofing"

### The session

    v1.<the claims, base64url>.<HMAC-SHA256 of that text with that tenant's own key, base64url>

The claims are the account id, the email, the tenant name, the host, when it was issued, when it
expires and a unique id for this session. It lasts twelve hours.

**One key per tenant, and the master never leaves the control plane.** Each tenant's key is
`HMAC-SHA256(master, "titanbot-tenant-session-v1:<slug>")`. Under TENANT-2 that key was written into
each tenant's Coolify environment, where anything running in that container could read it, and the
derivation is what stopped one customer signing a token claiming another. Under TENANT-5 no customer
has a container that holds a key at all: the keys go to the relay, over the relay credential, and
the relay is ours.

Rotating the master signs everybody out of everything at once and the relay picks up the new keys on
its next refresh.

Two sides check a token, and they check different amounts:

- **the control plane** verifies the signature, the expiry and the `jti` against its revocation
  table, because it has the store in front of it.
- **the relay** verifies the signature and the expiry only. It has no database and it is not going
  to call home on every request. So a signed-out session can still open the console for up to twelve
  hours, and the way to end one sooner is to rotate `CP_SESSION_SECRET`.

Both use the same code: `ui/session-token.mjs`, re-exported by `cp/session.mjs`, so there is one
file and not two. Two implementations of one signature is how a customer ends up locked out of their
own console on a Sunday.

    node cp/cli.mjs session verify <token>

---

## 8. Passwords

A customer's password is stored as scrypt with a salt of its own: N 32768, r 8, p 1, and a 64 byte
key. The hash is written by the store and read by the store, and no route on this service returns
it. There is a test that walks every route and asserts that.

The console has exactly one other password, the operator's own, in the relay's `auth.json`. It is
the way in when the control plane is not answering and the way in from the tailnet. It is not
something a customer is ever given, and under TENANT-5 there is no second one to give: the
per-tenant `state/auth.json` is gone (section 2).

---

## 9. Deploy the control plane, once

Two scripts, in this order. Both are idempotent, so re-running either one is the normal way to fix a
half-finished run.

**Step 1, on the Mac.** Put the files on the server:

    bash deploy/r750/sync.sh --no-install

**Step 2, on the server.** This makes the tenant root, builds the image and generates the secrets.
Run it as `sem`, not with sudo. It calls sudo itself for the one step that needs it.

    ssh dell-remote
    TITANBOT_DRY_RUN=1 bash /home/sem/titanbot/deploy/control-plane-install.sh   # read it first
    bash /home/sem/titanbot/deploy/control-plane-install.sh

What it does:

- `/data/titanbot` and `/data/titanbot/_control-plane`, owned by `sem` at mode 0750. `/data` is this
  host's docker data root and the disk with room on it, which is why the tenants live there rather
  than under `/home/sem`.
- `docker build -t titanbot-cp:local` from `/home/sem/titanbot`, with `--build-arg UID` and
  `--build-arg GID` set to the same uid it just gave those directories. Coolify cannot do this build
  itself: a Docker Compose Empty resource has no build context.
- `CP_SESSION_SECRET` and `CP_ADMIN_TOKEN` into `/home/sem/titanbot/cp.env` at mode 0600, once.
  Neither is ever printed. An existing value is kept and never rewritten, because a second master
  signs sessions nobody will accept.

The uid matters more than it looks. `id -u sem` on the R750 answers **1001**, not the 1000 a first
login account usually is and that `node` happens to be inside the base image. The image and the
tenant root have to agree on that number, so one script does both and passes the same pair to each.

**Step 3, on the Mac.** This makes the Coolify service. It reads the secrets off the server into
your shell rather than into a file, and it needs the Coolify pair from wherever you keep yours.

    export CP_SESSION_SECRET="$(ssh dell-remote "grep '^CP_SESSION_SECRET=' /home/sem/titanbot/cp.env | cut -d= -f2-")"
    export CP_ADMIN_TOKEN="$(ssh dell-remote "grep '^CP_ADMIN_TOKEN=' /home/sem/titanbot/cp.env | cut -d= -f2-")"
    export CP_RELAY_TOKEN=...                      # section 4. The same value goes on the console
    export CP_RELAY_PEERS=...                      # the server's own outbound address, /32
    export COOLIFY_URL=... COOLIFY_API_KEY=...     # your own shell's names; the tool writes
                                                   # CP_COOLIFY_URL onto the service

    node deploy/r750/control-plane-coolify.mjs --dry-run     # the plan, calling nothing
    node deploy/r750/control-plane-coolify.mjs

It creates or updates one service named `titanbot-cp` in the project Titanium Computing, environment
production, on server `zl2ti5llrtpx83918j8arb9f`, from `deploy/coolify/control-plane.compose.yml`
sent as base64 in `docker_compose_raw`. Then it sets the environment, sets the address to
`https://api.titanium.bot:7790` and starts it.

The environment it sets is read out of that compose file rather than listed in the script, so the
file an operator reviews is the file that ships. A value written `${NAME}` comes from your shell or,
for the three uuids, from the lookups the tool does. Two values deliberately differ from the file:

| key | in the file | what the script sets | why |
| --- | --- | --- | --- |
| `CP_ALLOW_NEW_TENANTS` | `0` | `1` | The file is the safe default for anyone pasting it by hand. Set `CP_ALLOW_NEW_TENANTS=0` in your shell to keep it off. |
| `COOLIFY_ENVIRONMENT_UUID` | not there | looked up | Coolify's openapi lists it in the required set for `POST /services` while its own description says the name will do, so both are sent. |

Nothing it prints carries a secret. Every secret prints as `(set, N characters, not printed)` and
every line goes through a redactor first, so a value cannot reach the terminal inside an error
quoted back from Coolify either. A dry run is safe to paste into a ticket.

**Step 4.** Coolify queues a start rather than doing one, so give it a minute, then check it before
trusting it:

    curl -s https://api.titanium.bot/v1/health
    # {"ok":true,"version":"...","tenants":0,"accounts":0}

Health needs no bearer and returns counts only. If it answers with anything more than those four
fields, stop and read the code: that route is the one place a mistake is public.

**Measured on the R750, 2026-09-07.** The install script made both directories owned by `sem`
(1001:1001, mode 0750), built `titanbot-cp:local` at 165 MB running as 1001:1001, and wrote `cp.env`
at mode 0600. A second run rebuilt the image and kept both secrets. The Coolify tool created service
**`hnhzi0ongkw0gsg9k4flcv7d`** in project `Titanium Computing` (`c24e2ulqhmgn4d0c5lx43i63`),
environment `production` (`fvp4fn26eqc1kfzg63yjvvzv`), and health answered on the first poll about
ten seconds after the start was queued, with no wait for a certificate.

Two things the first real run found, both fixed in the files above, both worth knowing because they
are the shape of mistake this pair of scripts exists to stop:

- **`COOLIFY_URL` is a name Coolify has already taken.** It puts its own into every service
  container, holding that container's public address, and its value beats an environment record set
  with the same name. The setting is `CP_COOLIFY_URL` now.
- **A running service takes a restart, not a start.** Coolify answers `400 Service is already
  running.` to a second start, and a service that is already up keeps running the compose and the
  environment it started with.

---

## 10. Adopt Jason's instance as tenant `titanium`

`console.titanium.bot` already exists, has been running for weeks, and has all of his agents in it.
It must not be created, rendered or rebuilt. Adopt writes a ledger row for an instance that is
already there:

    node cp/cli.mjs tenant adopt titanium p927bfqm83ioloibamlvyd7g console.titanium.bot

The row comes back with status `adopted`, which is its own status and not `running`, so a reader can
always tell which instances this service built and which it inherited. Nothing is created on
Coolify and no directory is made.

`titanium` is on the reserved list, so no customer can ever claim that name. Adopt does not consult
that list, because the whole point of the route is the operator taking a reserved name for the
instance that already exists.

**The adoption is a ledger row and nothing more.** It holds a uuid and a host. It carries no gateway
token and no directories, which is why the relay cannot get its own registry entry from it and seeds
that entry from its own environment instead (section 4). Under TENANT-2 this section also set three
tenancy variables on that service; under TENANT-5 there is nothing to set, because the relay is no
longer one customer's.

---

## 11. Adding a customer

    export CP_PUBLIC_URL=https://api.titanium.bot
    export CP_ADMIN_TOKEN=...        # from cp.env on the R750

    # rehearse it: this reads and renders everything and creates nothing
    node cp/cli.mjs signup add owner@acmeroofing.com "Acme Roofing" --dry-run
    node cp/cli.mjs signup add owner@acmeroofing.com "Acme Roofing"

Then hand the customer two things: `https://console.titanium.bot` and their email address. They set
nothing up, they install nothing, they never hear the word tenant, and there is no per-customer
address to get wrong.

Adding more people to the same customer is the account command with the same slug:

    node cp/cli.mjs account add somebody@acmeroofing.com acme --name "Somebody Else"

It asks for the password on the terminal, twice, with the echo off, and never takes one as an
argument.

### Your own account

Jason's instance is the tenant `titanium`, adopted rather than built, and it has **two** doors.

**The instance password** is the one that needs nothing else to be working. It carries no tenant
claim, so it resolves to `titanium` (section 5), and it keeps working when the control plane is down,
being redeployed, or not configured at all. It is the door to fix a stopped box from.

**An account on the `titanium` workspace** signs in at `console.titanium.bot` like any customer's,
since SIGNIN-2. Two things to know before adding one:

- **There is no lesser role on that workspace.** An account on `titanium` is an operator-level user.
  It gets Jason's box, his agents, his settings and his connectors, because `titanium` is the same
  workspace the instance password resolves to. Add one for a person you would hand the instance
  password to, and nobody else.
- **Removing the account does not end a session it already minted.** The relay holds no revocation
  table, so a cookie already issued keeps working until it expires, which is at most 12 hours. The
  control plane says so itself in the answer to `DELETE /v1/accounts/<email>`.

HISTORY, and it is why the two paragraphs above are new. Both halves were measured on
jason-PowerEdge-R750 on 2026-09-10 with the same throwaway account, either side of the ship.

**BEFORE, 08:16:11Z.** That account posted the real sign-in form at `console.titanium.bot` and read
**503 `{"error":"that workspace is not available right now"}`** in 0.41 s, while the byte-identical
throwaway on `demo` was signed in at once. The cause was the session key, not the account and not
adoption: the control plane's registry row for that slug carried `included` and `slug` and nothing
else, so `sessionKeyOf("titanium")` answered `""`, `verdictForToken` in `ui/tenant-login.mjs` had no
key to check the token with and answered `unknown`, and `ui/server.mjs` turned that into the
availability sentence.

**AFTER, 08:17:46Z**, one minute and thirty-five seconds later, the same account and the same
password: **302 to `/` with one `gb_session` cookie**. In real Chromium it reached the login page in
185 ms, was on the console 614 ms after the submit, and painted the operator's own Machine Room --
`6 / 40 BOTS`, Titan, Scribe, Instagram Marketer, X Marketer, Facebook Marketer, and Titan's screen
panel. The account was removed in the same pass and the control plane went back to its three real
accounts. Jason's own account was never signed in to, no box was swapped or written, and all three
boxes still read `Up 2 days` afterwards.

Adding one is the account command with the operator's slug:

    node cp/cli.mjs account add somebody@titaniumcomputing.com titanium --name "Somebody"

And `account add` for a customer workspace is the same command with theirs:

    ssh dell-remote
    cd /home/sem/titanbot
    export CP_ADMIN_TOKEN="$(grep '^CP_ADMIN_TOKEN=' cp.env | cut -d= -f2-)"
    node cp/cli.mjs account add somebody@their-company.com <their-workspace> --name "Their Name"

---

## 12. What the customer sees

They go to `https://console.titanium.bot`, they get a sign-in page, they type the email address and
password you gave them, and they are in their own console with their own agents. The page is the
same page Jason signs in on. Their agents are not.

While a box is still coming up, signing in works and the console says the machine is starting. That
is the honest answer and it is better than a login that hangs.

One thing to know before showing it to anybody: **the agent on a brand new box is called "New
Bot"**, not Titan. That is `SAND_DEFAULT_AGENT_NAME` in `source/shared/agents/agents.ts` and it is
upstream's name for an agent nobody has named yet. Titan is the name Jason gave his own.

---

## 13. Stop, start, restart, delete

**Deleting a workspace leaves its sign-ins standing, and says so.** The delete answer carries
`accountsLeft` and names every address that pointed at that workspace. Cascading would have been the
obvious thing and it is wrong: building the workspace again under the same slug restores those
people's access exactly as it was, which is how the demo workspace was moved onto the one-console
shape, and cascading would have locked them out to tidy up a row. Until the workspace is rebuilt or
the accounts removed, those people meet "That workspace is not available right now."

Removing one is its own command, and it asks for the address to be typed back:

    node cp/cli.mjs account remove owner@theircompany.com

It closes one door and touches nothing else. Not the workspace, not `/data/titanbot/<slug>/`, and
not the login-failure rows, which are the lockout's memory and belong to the address rather than to
the account. A session that person already holds keeps working until it expires, because a session
is a signed token this service does not hold; twelve hours is the ceiling. So this is the shape for
"they have left" and not for "they are hostile", and the answer says as much.

    POST /v1/tenants/{slug}/stop        POST /v1/tenants/{slug}/start
    POST /v1/tenants/{slug}/restart

All three are passed through to Coolify and all three are queued, not immediate. A restart recreates
the box, which is fine and is what the copy-in on the box start is for.

    DELETE /v1/tenants/{slug}
    {"confirm": "acme"}

It only works when the tenant is stopped, and only with the slug repeated in the body. It deletes
the Coolify service.

**Not on an adopted instance.** A tenant this service did not build is not this service's to delete
or to rebuild, so `DELETE /v1/tenants/{slug}` and `POST /v1/tenants/{slug}/provision` both answer
`409 {"error":"adopted"}` on one. On `titanium` those two calls would have been the live
`console.titanium.bot`. Stopping it first is not a way around either one: an adopted row keeps saying
`adopted` through a stop, because that is how it got here and not a container state.

Coolify's own delete takes four query flags, `delete_configurations`, `delete_volumes`,
`docker_cleanup` and `delete_connected_networks`, and **every one of them defaults to true**. This
route sends all four explicitly, with `delete_volumes=false`, rather than letting the defaults stand,
because a tenant's data directories are bind mounts and Coolify keeps a storage record for each one.
`delete_connected_networks=false` matters more under TENANT-5 than it did: `titanbot-net` is shared
by the whole fleet, and a delete that took it would take every customer's box off the relay at once.

**It does not delete the customer's data, and no route in this api ever will.**
`/data/titanbot/acme` stays exactly where it is: the workspace, the agents, the transcripts, the
store. Deleting a customer's files is a decision a person makes on the server, on purpose, with
`rm -rf` and their own eyes on the path, with a backup taken first. It is not a thing an api call
can do by accident at two in the morning.

---

## 14. Provisioning

Seven idempotent steps, written to a ledger, with a retry that starts at the step that failed rather
than building a second instance beside the first or minting a second gateway token. TENANT-5 changes
what is built, not how:

| step | what changed |
| --- | --- |
| directories | `state/auth.json` is no longer written. The rest is unchanged |
| secrets | the gateway token, still 0600, still never in compose text. No relay password |
| compose | renders `deploy/coolify/box.compose.yml`, **one service**, joining `titanbot-net` |
| service | created through Coolify as before |
| envs | the gateway token, as a Coolify environment value |
| urls | **gone.** A tenant has no hostname |
| start | waits for that box's gateway to answer on the shared network |

The box container name is `titanbot-box-<service uuid>`, computed and then verified against
`docker ps` rather than trusted. The ledger stores it.

`--dry-run` does every read and every render and creates nothing.

### Next step: a new box starts with our settings, not with a rollout

Not yet wired. This is CURSOR-1 item 5, and it is filed as `TENANT-8` in `docs/GAP-ANALYSIS.md`
because `cp/` is being changed for the admin console at the same time and two hands in one file is
how a provisioner stops being idempotent.

What is missing: a new tenant's box comes up with no settings of its own, so every gate falls
through to whatever the bundled table says. Measured on the R750 on 2026-09-07, the same host
bundle read `sand_auto_review` as true on the demo box and false on the other two, and on the box
where it read true the agent could not run a single Shell command. Nothing in the product decided
that, and nothing in the product could see it: all three rows printed `"source":"bundled default"`.

The settings a box should start with are written down, in `deploy/box-defaults/`. That directory's
README says what each pin is and why. The provisioner's job is only to copy them.

**Landed 2026-09-08.** The hook is in the `directories` step of `cp/provision.mjs`, right after
`for (const directory of tenantDirectoryList(slug, config)) mkdirSync(...)`:

```js
const defaults = writeBoxDefaults(tenantPaths(slug, config).data);
```

`writeBoxDefaults(dataDir)` copies every file in `deploy/box-defaults/` into `dataDir` at mode
0600 and **skips any file that is already there**. Skipping matters more than copying: the step is
retried from the point it failed, and a customer or an operator may have edited a switch by hand
since the box was built. A provisioner that overwrote those on a retry would silently undo somebody
else's decision, which is the same class of bug as the rollout this is fixing.

`paths.data` is already `tenantPaths(slug, config).data`, and it is the host side of the box's
`/home/box/sand-data`, so the files land where `readSandBoxSetting` and the gate pin reader look
for them. The step's ledger detail should name the files written and the files skipped, so a retry
that changed nothing says so.

Nothing here needs a container recreate. On a box that already exists the files are added to the
tenant's data directory, which is the host side of that same bind mount, and picked up on the box's
next ordinary restart — which is what BOX-6 allows and a recreate is what BOX-6 forbids.

**The tenants provisioned before this existed** are backfilled by
`node scripts/backfill-box-defaults.mjs` (`--dry-run` first). It adds only what is missing, names
what it skipped, restarts nothing and recreates nothing, and prints names only — two of the
neighbours in that directory are `box-secrets.json` and `connector-env-secrets.json`. Measured on the
R750 2026-09-08 before the backfill: `gates.json` was missing from all three of
`/data/titanbot/{demo,richard-avery,north-bay-roofing}/volumes/data`, and
`sand-host-settings.json` was missing from `north-bay-roofing`.

**It discovers boxes, not directory trees, and that is not a detail.** The first version listed
`/data/titanbot/*/volumes/data`, and Jason's own box does not live there: its sand-data is the named
docker volume `titanbot-box-data` at `/data/docker/volumes/titanbot-box-data/_data`. So the one box
the backfill could never see was the operator's, and it was the only box on the R750 still without a
`gates.json` — which means the CURSOR-1 pins, `sand_auto_review: false` among them, were not applied
on it. It now enumerates `docker ps --filter label=com.titanbot.role=box` and resolves each box's own
`/home/box/sand-data` mount `Source` out of `docker inspect`, and keeps the tenant-tree walk as a
second source so a tenant that is provisioned but not running is still covered; duplicates fold by
resolved path, and the report says which source found each one. A missing `/data/titanbot` is a note
rather than a failure, because a host with running boxes on named volumes and no tenant tree is
exactly the host this has to work on.

**Measured on the R750 2026-09-09.** The dry run named four targets: `north-bay-roofing` (tenant
tree), the demo box and Richard's (running box, tenant tree — the same directory found twice and
folded), and Jason's box (running box, the named volume). It would add one file. The run added it:
`gates.json` at 0600, uid 1000 to match the directory's owner, on
`/data/docker/volumes/titanbot-box-data/_data`, 645 bytes, carrying `sand_auto_review` and the other
seventeen pins. Everything else skipped, nothing restarted, nothing recreated.

---

## 15. What changed from TENANT-2, and why

TENANT-2 shipped one relay per customer on one hostname per customer, and it worked: a customer
signed in at `demo.titanium.bot` and saw their own agents. It is superseded because of what it cost,
which is exactly what Jason named. Every new customer meant a second container, a second hostname, a
second certificate, a second copy of the console's environment, a second `auth.json` with a password
somebody had to be given, and a second thing to redeploy on every ship.

| TENANT-2 | TENANT-5 |
| --- | --- |
| a relay and a box per customer | a box per customer |
| `<slug>.titanium.bot` per customer | `console.titanium.bot` for everybody |
| `TENANT_ID` says which customer this process is | the session says which customer this request is |
| each tenant's derived key in that tenant's container | every tenant's derived key in the relay, over the relay credential |
| a per-tenant relay password in `state/auth.json` | one operator password. The per-tenant file is deleted |
| a tenant relay has no docker socket, so four features are absent there | the one relay has the socket and does `docker exec` per tenant, so nothing is absent |
| the sso redirect sends a customer to their own host | there is one host, so there is nothing to redirect to |
| endpoints must be public because a tenant relay could scan the private network | still true, and now it is decided per request rather than per process |

What did **not** change: the token, the derivation, the store, the scrypt parameters, the lockout,
the account routes, the shared release directory, the backup, and the plain-word copy a customer
reads on every refusal.

The endpoint guard is worth a sentence because it moved rather than went away. `POST /endpoints`
saves a base URL and the health probe behind `GET /endpoints` fetches `<baseUrl>/models` with the
key saved beside it. On the operator's own request that is a feature: it is his machine and the box
next door is a legitimate endpoint. On a customer's request it is a request generator inside the
R750's private network aimed by whoever holds that session. The guard used to key off "is this
process a tenant"; it now keys off "is this request the operator's", which is the correct reading of
it either way. The refusals are unchanged:

| what was sent | the sentence |
| --- | --- |
| an address inside this machine's networks, by literal or by name | That address is inside this server's own network, so it cannot be used here. |
| `http://` | Endpoints on this instance have to start with https:// |
| a host name nothing answers for | That host name could not be looked up, so nothing can be saved for it. |
| not a URL at all | That is not a web address. It should start with https:// and then the host name. |

---

## 16. The gates

    node scripts/verify-control-plane.mjs
    node scripts/verify-one-console.mjs
    node scripts/verify-deploy.mjs --url https://console.titanium.bot

`verify-control-plane` starts the control plane itself on a free port with a throwaway store, a
throwaway tenant root and a fake Coolify that records every call. Unchanged by TENANT-5 except for
the new route.

`verify-one-console` is the TENANT-5 gate. With no `--url` it starts a fake control plane serving the
registry route, two fake gateways standing in for two customers' boxes, a stub `docker` on `PATH`
that answers the box-name lookup, and two relay copies of its own. No network, no docker, no box and
no control plane. It mints and forges its own session tokens with `node:crypto` from the contract's
description, never by importing the module under test, so a signature that verifies inside the
process and not on the wire fails here rather than on the day a customer signs in.

Four suites, and `--only <suite>` runs one:

- **registry** the four cases of section 4: no bearer is 401, the **admin** token is 401, the relay
  token is 200, every CUSTOMER row carries a box and a gateway and a token and a session key, a
  skipped list exists, each row's key is that tenant's own derived key, and the master's own bytes
  are nowhere in the body. The operator's own row is a different shape and is measured as its own
  leg: it carries that slug's derived key, `included` when a plan is on, and **nothing else** -- no
  box, no gateway, no token, no directories. That leg replaces one that asserted the operator was
  absent from the rows, which had been FAILing against the live control plane since PROXY-1.
- **rosters** two customers sign in at the **same** address in two cookie jars; each one's
  `POST /api/listAgents` answers with their own agents; neither roster carries one name from the
  other; each customer's own box was the container asked; each was asked with that customer's own
  gateway token; and neither token was ever presented to the other customer's box. That last pair is
  the difference between a relay that routes and a relay that filters, and a filter is what leaks
  the day it has an edge case.
- **unknown** a session naming a tenant the registry does not know gets the sentence, no roster, and
  no sign-out.
- **operator** the instance password still works and reaches the operator's own box with no
  customer's agent on it; an ACCOUNT on the operator's own workspace signs in and lands on that same
  workspace (SIGNIN-2); and a copy with **no** control plane at all comes up with the login page it
  always had, signs in on the password and serves its roster. Plus: the relay called the control
  plane on its own relay routes and the sign-in and nothing a relay has no business on, and no
  gateway token, relay credential, master, derived key or password is anywhere in its log.

  Live, the account leg mints a THROWAWAY through the control plane, signs it in, proves the
  workspace by comparing its roster against the operator's own -- read with the box's gateway
  bearer, which asks for no password of Jason's, or with the instance password when that is what was
  given -- and removes the account in a `finally`. A removal that did not happen is a FAIL, because
  what is left behind is a working operator-level sign-in.

Against the live console the legs that need a credential run only when one is given, in the
environment rather than on the command line: `ONE_CONSOLE_RELAY_TOKEN`, `ONE_CONSOLE_ADMIN_TOKEN`,
`ONE_CONSOLE_EMAIL_A`, `ONE_CONSOLE_PASSWORD_A`, `ONE_CONSOLE_EMAIL_B`, `ONE_CONSOLE_PASSWORD_B`,
`ONE_CONSOLE_INSTANCE_PASSWORD`. A leg with no credential prints `SKIP` with its own name and the
reason, and the run says how many were not measured. A gate that quietly shrinks is a gate nobody
reads.

Exit 0 no leg failed, 1 a leg failed, 2 nothing could be measured, which is not a pass.

`verify-deploy` gained one leg: the relay's network pin (section 3). One network and no label is the
state before the migration and passes. Two networks and no label fails with the sentence that says
what to set.

`scripts/verify-tenant.mjs` is gone. It was the TENANT-2 gate and it measured a relay in tenant
mode, which is a mode that no longer exists: it expected one relay per customer, each on its own
hostname, and a sign-in for another customer redirected to that customer's host. Every leg of it
that is still true is measured somewhere else now, so nothing was dropped on the floor. Its login
suite is replaced by `scripts/verify-one-console.mjs`. Its docker suite, the plain-word refusals a
relay with no docker gives, is `tests/relay-docker-absent.test.mjs` (10 tests, in `npm test`). Its
runtime-bundle legs are in `tests/relay-one-console.test.mjs`, per workspace, and its endpoint guard
is in `tests/relay-tenant-endpoints.test.mjs`.

`scripts/verify-tenant-browser.mjs` is gone with it, for the same reason: it drove a real Chrome at
`demo.titanium.bot` and measured an account typed into the wrong per-customer hostname being
redirected to its own, and there are no per-customer hostnames. Its replacement is
`scripts/verify-one-console-browser.mjs`, which is section 22's browser proof.

`tests/cp-relay-pair.test.mjs` is the one that has no gate above it and is worth naming here. Every
other suite tests one half of TENANT-5 against the other's contract: the relay suites feed a fake
control plane, the control plane suites answer a fake relay. That is the arrangement in which two
correct halves disagree, because the relay reads `sessionKey` and the control plane could have
called it `key` with every test still green. This one starts the real control plane and a real relay
and points the second at the first.

**Run the gates one at a time, a minute apart.** The relay's login throttle is five failures per
address per 30 seconds, the account door and the password door share it, and every gate here fills
it on purpose. Run them back to back from one Mac and the next one is measuring its own lockout.
They share one box besides, and a gate run has a 300 second ceiling.

---

## 17. What counts as a secret here

| secret | where it lives | who sees it |
| --- | --- | --- |
| a customer's password | nowhere. Only the scrypt hash and salt, in the store | nobody |
| `CP_SESSION_SECRET`, the master | the control plane's environment only | operator only |
| a tenant's derived session key | the control plane, and the relay's memory | the relay |
| `CP_ADMIN_TOKEN` | the control plane's environment | operator only |
| `CP_RELAY_TOKEN` | the control plane's and the relay's environment | those two containers |
| `COOLIFY_API_KEY` | the control plane's environment, and Coolify | operator only |
| a tenant's gateway token | that tenant's `profile/local-docker-vm.json` at 0600, Coolify's env store, and the relay's memory | that tenant's box, and the relay |
| the operator's console password | `state/auth.json` as a scrypt hash | operator only |
| `CP_PROXY_MASTER_KEY`, the proxy's master | the proxy's environment and the control plane's, and nowhere else | operator only |
| `PROXY_SALT_KEY`, the proxy's salt | the proxy's environment, appended once to `cp.env` and never rewritten | operator only |
| the operator's provider keys (Z.AI, MiniMax, Qwen, TinyFish) | the proxy's environment only. **This is the change PROXY-1 exists for**: they used to be copied into every box | operator only |
| a tenant's proxy virtual key | that tenant's `profile/model-proxy.json` at 0600, the relay's memory, and that tenant's own box | that tenant's box, and the relay |

None of them is ever a query parameter, ever in a log line, or ever in an answer. The last leg of
the control plane gate and the log leg of `verify-one-console` are there to keep that true after the
next route is added.

Two of those rows moved in TENANT-5 and both moved toward the relay and away from customers. A
derived session key used to sit in a customer's container where anything running in it could read
it; a gateway token still does, but only that customer's own. Neither ever reaches a browser.

**Two things PROXY-1 changed here, and one of them widens a blast radius.**

The good half: the operator's own provider keys were in every box and now are in none. A customer's
box holds a credential that is theirs alone, budgeted and revocable, so a key read out of one box
buys that customer's own allowance and nothing else. It is still readable by that customer's own
agents — anything in the box can read a 0600 file it owns — and `docs/PROXY.md` §8 says so out loud
rather than leaving it to be discovered. The value is metering and revocation, not secrecy.

The half that costs something: `GET /v1/relay/tenants` is the one route on the control plane that
deliberately answers with secrets, and it now hands the relay **every customer's inference
credential** as well as their gateway token. A leaked `CP_RELAY_TOKEN` was already worth every box's
gateway token; it is now worth every box's provider access too, until those keys are re-minted. That
is not a reason to move the credential elsewhere — the relay has to serve it to the box somehow —
but it is a reason to treat `CP_RELAY_TOKEN` as the highest-value string in the system after the
session secret, and to re-mint every virtual key rather than only rotating the relay token if it
ever leaks.

### What PROVIDERS-1 makes restore-critical

From this wave the operator's provider keys live in the **proxy's own database**, entered through
the admin console and encrypted under `PROXY_SALT_KEY`. The control plane receives a key from the
browser, hands it to the proxy, and forgets it: it renders the mask the proxy returns and holds no
value. That is a deliberate trade and it is stated here rather than discovered later.

**Two things become restore-critical together, and losing either costs the same thing:**

| what | where | what losing it costs |
| --- | --- | --- |
| `/data/titanbot-proxy/postgres` | the proxy's Postgres directory bind | every provider key, every plan model and every virtual key |
| `PROXY_SALT_KEY` | `cp.env`, appended once and never rewritten | the stored credentials are unreadable ciphertext; the rows survive and the values do not |

Either way the recovery is the same: **re-enter every provider key by hand in the Providers panel**,
which lists exactly which slots are empty. Minutes of work, and only if somebody knows to do it.

There is deliberately **no second encrypted copy in the control plane's sqlite.** It would double
the blast radius of a control-plane compromise — that database already holds the session secret and
every customer's account — to buy back a five-minute operation. One copy, backed up, is the trade.

**The backup already carries both; the drill does not exercise either.** VERIFIED 2026-09-08:
`deploy/backup/snapshot.sh` copies `cp.env` (which holds `PROXY_SALT_KEY`) in its relay file loop,
and `pg_dump`s the proxy database to `proxy/litellm.sql`. `deploy/backup/restore-drill.sh` mentions
neither — a grep for `SALT`, `postgres`, `proxy` and `cp.env` over that file returns nothing. So the
bytes are being taken and nobody has ever proved they come back. That mattered less when the proxy's
database held only virtual keys that `proxy mint --all` could rebuild from the tenant ledger; it
matters now that it holds the only copy of the provider keys. Extending the drill is filed as
`BACKUP-DRILL-1`.

---

## 18. What one relay with a socket does and does not change

Under TENANT-2 a tenant's relay had no docker socket, and four console features were honestly absent
there. Under TENANT-5 a customer has no relay at all, and the one relay is ours and keeps the
socket, so those four features work for every customer. `dockerAvailable()` still decides, and it
still answers no on a developer Mac with no docker, which is the case that keeps the refusal copy
alive.

| route | with no docker on the relay | the sentence |
| --- | --- | --- |
| `POST /endpoints/use` | 409 | This instance cannot switch models from the console yet. |
| `GET /box/surface`, `POST /box/launch` | 409 | The desktop view is not available on this instance yet. |
| `GET /connectors`, `POST /connectors` | 409 | This instance cannot edit connectors from the console yet. |
| `GET /runtime/<token>/…tgz` | 409 | This instance cannot build a host update of its own. |
| `GET /endpoints` | 200, plus `liveNote` and `switchable: false` | This instance does not report which model is answering yet. |
| `GET /model` | 200 with nulls, plus `note` | the same sentence |

The last two answer rather than refuse on purpose. The console asks for both on every page load, and
a refusal in that position is an error badge on a page that is working perfectly well.

### The two box repairs

| repair | where it happens | on a customer's box |
| --- | --- | --- |
| sqlite3, which `learn-from-demonstration` needs to read Chrome's history | the box's own entrypoint, in the background, swallowing its own failures | yes |
| `apply-start-window-fix.sh`, which edits `/usr/local/bin/start-window` inside the box | the box's own entrypoint, from `/opt/titanbot-runtime`, in the background | yes, since 2026-09-08 |

The sqlite3 loss was measured: on the R750, 2026-09-07, `command -v sqlite3` answered on the
operator's box and reported MISSING on the demo tenant's. It moved into the box's entrypoint because
that runs inside the container and needs no socket at all.

The start-window repair does real work: on the operator's own box, 2026-09-07, it reported `patched`,
`orphan branch patched`, `stop-window patched`, `live-seat rule patched` and `adopt rule patched`.
Without it a forked agent gets the black screen DISPLAY-2 is about.

**TENANT-4, closed 2026-09-08.** It ran only through the socket, so it reached the operator's box and
neither customer's. Measured on the R750 that morning, by `md5sum /usr/local/bin/start-window` and
`grep -c session_alive` inside each box: Jason's `99a90e45a5b5c18ec18da4c5c61a08e4`, 3 occurrences,
patched; Richard's and the demo tenant's both `d69219afc86a297d16bee3d97b120095`, 0 occurrences,
stock. A forked agent on a customer box met the black screen right then.

The script now has an in-box mode: one `run` wrapper over what were seven `docker exec` call sites,
which runs the command directly when `TITANBOT_IN_BOX=1`. `deploy/r750/sync.sh` ships it into
`runtime/`, which every box already mounts read-only at `/opt/titanbot-runtime`, and the box's own
entrypoint waits for `/usr/local/bin/start-window` to appear and then applies it — in the background,
swallowing its own failures, exactly like the sqlite3 install beside it, because a box whose job is
to boot must never fail to boot over a repair. It runs on **every** start, because the edit is a
filesystem change in the container and a recreate throws it away.

Measured on grok-bot-local-vm 2026-09-08: the box was reset to the stock `start-window`
(`d69219af…`, 0 `session_alive`), the script was run from inside the container with
`TITANBOT_IN_BOX=1`, and the result was `99a90e45a5b5c18ec18da4c5c61a08e4` with 3 occurrences — byte
for byte what the socket path produces. A second run reported `already patched` for every step. That
box has no `docker` CLI in it at all, which is what makes the run socket-free rather than merely
socket-less.

---

## 19. What the shared network did not close

A customer's box is not privileged, has no added capabilities and holds no docker socket. What is
left is the network, and TENANT-5 changed its shape: the box is now deliberately on a network with
the relay and the control plane on it. That is by design. The relay has to reach the box, and the
control plane has to wait for a box it just built.

### 19.1 What it opened between customers, and what closed it

The first version of this section only looked at the host, and that was the wrong half. Containers
on one bridge talk to each other freely, so putting every customer's box on `titanbot-net` made
every customer's box a peer of every other customer's box. Measured from the demo tenant's box on
the R750, 2026-09-07:

| from demo's box | answer |
| --- | --- |
| the operator's box `192.168.48.3`, ports 1340, 6080, 6081 | all three **OPEN** |
| `1340` with no bearer | `401`, which is correct |
| `6080` `GET /websockify` with the plain websocket headers | `101 Switching Protocols`, first frame `RFB 003.008`, security types `01 01` — **type 1, None** |
| `6081?token=3` (a fork display, where the token is the display number) | `101` |
| the control plane `192.168.48.5:7790` `GET /v1/health` | `200 {"ok":true,...}` |
| the relay `192.168.48.4:7777` `GET /login` | `200` |

The scan is symmetric: the same three ports answered from the operator's box against demo's. So one
customer could drive another customer's screen and keyboard with no credential at all, which is the
opposite of the sentence this whole wave rests on. The control plane was reachable too, and it is
never called by a box: the box fetches its bundle from `titanbot-relay:7777` and that is the only
thing it has to say on that network.

**What closed it: `deploy/r750/box-isolation.sh`.** A box has one thing to say on that network, its
host bundle fetch from `titanbot-relay:7777`, so the rule is that shape: from a box, on this bridge,
the relay's bundle port and nothing else.

**It has to be the bridge family, and the first attempt got that wrong.** Two containers on one
docker network are in one subnet on one bridge, so their packets are *switched* at layer 2 and never
routed. Netfilter's ip hooks -- where iptables, `DOCKER-USER` and docker's own `icc` rules all live
-- see bridged frames only when `br_netfilter` is loaded, and on this host it is not:
`/proc/sys/net/bridge` does not exist. Measured 2026-09-07, an iptables `DROP` in `DOCKER-USER`
matching exactly this traffic counted **zero packets** while the scan above still answered OPEN.
Loading `br_netfilter` would have put every other bridge on the machine through a `FORWARD` chain
whose policy is `DROP`, which is a large blast radius for a two-line rule.

nftables' **bridge** family hooks the bridge's own forward path, so it sees the frames without
`br_netfilter` and touches no other bridge:

    table bridge titanbot_isolation {
      chain boxes {
        type filter hook forward priority -300; policy accept;
        meta ibrname "br-<net>" ip saddr @boxes ip daddr <relay> tcp dport 7777 accept
        meta ibrname "br-<net>" ip saddr @boxes drop
      }
    }

The bridge forward hook is container-to-container on that bridge and nothing else, so a box's route
to the internet, to its own Coolify network and to the host are all untouched: those leave the
bridge rather than crossing it. Replies from the relay are not matched, because the source of a
reply is the relay. ARP is not matched either (an ARP frame has no `ip saddr`), so a box still
resolves names and simply times out on the addresses it may not have. Traffic between *different*
docker bridges was already dropped by docker's own `DOCKER-ISOLATION-STAGE` chains, because that
traffic is routed and does reach the ip hooks; the same-bridge case is the one docker does not
cover, and it is the one TENANT-5 created.

Measured after applying it, 2026-09-07: from demo's box, the operator's box answered on nothing
(1340, 6080, 6081 all closed), the control plane closed, `coolify-proxy` closed, the relay's 7777
still open, and `https://api.resend.com/` still `200` so egress is untouched. Symmetric from the
operator's box.

`titanbot-isolation.timer` reapplies it every minute and at boot, because a box the control plane
builds at three in the morning has to be covered without anybody being awake. The control plane has
no route to the host's firewall, which is why this is a timer and not a provisioning step. The whole
table is replaced in one `nft` transaction each run, so there is never a moment with half a policy
in place, a box that has appeared is covered and a box that has gone leaves no rule behind.

The gate is `bash deploy/r750/box-isolation.sh --verify`, which runs the scan above from every box
against every other box, and `scripts/verify-deploy.mjs` carries it as a leg so a green deploy means
the boundary was measured and not assumed.

### 19.2 The host, and the guard in front of it

What the box must not reach is the **host**.

**The exposure, re-measured 2026-09-08 and wider than the first pass said.** The 2026-09-07 note
read "a TCP connect succeeds on 22, 80, 443 and 8000 and is refused on 2375, 5432 and 6379". The
refused list is still true. The open list was short because those were the only ports probed. From
inside the demo tenant's box on the R750, with `bash` `/dev/tcp` and a 1.1.1.1:443 sanity leg first,
a TCP connect succeeds on **22, 47291, 8000, 80, 443, 2049, 445, 11434 and 5000**, against **each of
four host addresses**: the box's default gateway `192.168.32.1`, its `titanbot-net` gateway
`192.168.48.1`, the tailnet address `100.110.83.82` and docker0 `172.17.0.1`. `ss -lntp` on the host
names them: sshd on 22 **and 47291**, docker-proxy on 8000 (Coolify), smbd on 445, ollama on 11434, a
python service on 5000, NFS on 2049. `http://192.168.32.1:8000/` answers a 302 to its own `/login`
and `/api/v1/servers` answers `401 {"message":"Unauthenticated."}`, which is Coolify — the thing that
creates and deletes every resource on this machine, with `COOLIFY_API_KEY` in the control plane's
environment on the same host.

So it is not two login prompts and a hosting panel. It is those plus the machine's file exports and
its local model server. The box has no IPv6 default route today, so v6 is a future path rather than a
current one — but sshd and Coolify both listen on `[::]`, so it becomes one the moment a bridge gets
v6.

**Use `bash`, never `sh`, to probe this.** The box image's `/bin/sh` is dash, which has no
`/dev/tcp`, so a probe written with `sh` reads every port as shut. One pass did exactly that and
recorded a clean result that was a false negative.

**Why the remedy is PREROUTING and not INPUT.** An earlier version of this section prescribed
`-i br-<id> -d <that bridge's gateway> -j DROP` in `INPUT`, and reasoned that container-to-gateway
traffic terminates on the host so it goes through `INPUT` and not `FORWARD`. That reasoning is right
in general and right for 22 and 47291. **It is wrong for 8000, which is the port the row is about.**
Measured: `iptables -t nat -S` carries `-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER` and
then `-A DOCKER ! -i br-7ef42af3f026 -p tcp --dport 8000 -j DNAT --to-destination 10.0.2.5:8080`.
`br-7ef42af3f026` is Coolify's **own** bridge, so a packet arriving from a box bridge is not
excluded: its destination is rewritten to Coolify's container before `INPUT` is consulted, and it is
then forwarded rather than delivered locally. An `INPUT` rule would correctly drop 22 and 47291 and
silently do nothing for 8000. 8000 is a published container port; only a prerouting hook that runs
before docker's nat prerouting catches it.

**What is installed.** `deploy/r750/box-isolation.sh` builds a second table beside the bridge one:

```
table inet titanbot_host {
  chain guarded {
    ip saddr { <coolify>, <control plane> } counter accept
    tcp dport 22    counter [drop]     # drop set
    tcp dport 47291 counter [drop]
    tcp dport 8000  counter [drop]
    tcp dport 2049  counter            # watch-only until its counter reads zero
    tcp dport 445   counter
    tcp dport 11434 counter
    tcp dport 5000  counter
    tcp dport 80    counter
    tcp dport 443   counter
  }
  chain host {
    type filter hook prerouting priority -250; policy accept;
    fib daddr type local tcp flags syn / syn,ack iifname "br-*"   jump guarded
    fib daddr type local tcp flags syn / syn,ack iifname "docker0" jump guarded
  }
}
```

Priority −250 runs before docker's nat prerouting at −100, so the destination is still the host's own
address. `fib daddr type local` says "addressed to this machine" without naming a gateway that
changes every time a network is made. `iifname "br-*"` plus `docker0` is every docker bridge on the
host, present or future. Only SYN is matched: a connection that cannot open never has anything else.

**Two exemptions, discovered at apply time, failing closed.** Coolify drives this host over SSH from
inside its own container — measured, four established sessions from `10.0.2.5` to `10.0.0.1:22` — so
it arrives on a docker bridge exactly like a customer's box does and `iifname "br-*"` covers it too.
A blanket drop on 22 would take away the hosting panel's ability to do anything, re-applied every
sixty seconds by the timer. So the coolify container and the control plane are resolved to addresses
at apply time, and **if a container that must be exempt is present but its addresses cannot be read,
the script installs nothing and exits non-zero.** Absent is fine; unreadable is not.

**It shadows before it drops.** `TITANBOT_HOST_GUARD` is `shadow` by default and on a fresh install:
the same matches, the same order, counters and no verdict. `--counters` prints them per port.
2049, 445 and 11434 join the drop set only once their counters have read zero over a real window.
Setting the mode to `drop` (or writing it to `/etc/titanbot/host-guard.mode`, which the timer reads)
is an operator action, and `--verify` then probes box to host from every box and fails on any
drop-set port that answers.

**The alternative that was not taken.** Binding Coolify off `0.0.0.0` is a smaller change and closes
one of the nine ports. It is still worth doing, and it is a Coolify setting rather than a firewall
rule; it is not a substitute for the guard, because sshd, NFS, Samba and ollama are not Coolify.

Everything else on a customer's box is unchanged. The gateway answers, and the job bus, mail and
subscriptions all work the way section 5 routes them. The one thing a box does reach on
`titanbot-net` is `titanbot-relay:7777`, which is where its host bundle comes from, and 19.1 is why
that is the only thing.

### 19.3 A box is not a proxy

The shared network had a second consequence, on the relay rather than between boxes.
`SAND_UI_TRUSTED_PROXIES` and `CP_TRUSTED_PROXIES` name the docker private ranges, because Coolify
allocates a fresh network per resource and its address is not knowable in advance. Under TENANT-2
the only peers inside those ranges were Traefik and the operator's own box. TENANT-5 put every
customer's box inside them, so every customer's agents became a trusted forwarder: measured from
demo's box on the R750, 2026-09-07, a request carrying `X-Forwarded-Proto: https` came back with
HSTS, and two wrong-password sign-ins carrying forged `X-Forwarded-For` values were logged and
counted against the addresses the box chose. The login lockout is keyed on that value, so it stopped
bounding guessing from inside a box, and it could be aimed at the operator's own address to hold him
out of the console and of `/v1`.

Narrowing the ranges does not fix it. The relay's Traefik pin is `titanbot-net` itself
(section 6), so the proxy reaches the relay from the same subnet the boxes are on, and any subnet
that keeps the proxy keeps the boxes.

So the rule is written where it is true: **an address that belongs to a box is never a proxy.**
`ui/auth.mjs` `createBoxPeers` holds that set, the relay refreshes it on the tenant registry's own
cycle from the box container names it already carries, and the control plane refreshes it every
minute from `box_container` in its ledger. Docker's own resolver turns a container name into the
address that container reaches us from. A refresh that resolves nothing keeps the last good set,
for the same reason the box-name sweep does. The relay says the size at boot:

    peer 2 box address(es) held untrusted as forwarders

---

## 20. Reading the relay's own answers

Two lines worth recognising in the console's log, because both are normal and one looks alarming:

    reg  could not reach the control plane (timed out); serving the 3 tenants last read at 09:41

The control plane is down or restarting. Nobody is signed out, the operator's console is unaffected,
and customers whose entries were already read keep working. This is the designed behaviour, not a
fault.

    reg  the control plane returned a row for titanium; dropped

Somebody adopted the operator's own instance into the tenant list. The relay's own environment wins
and always will. Worth looking at, not worth waking up for.

---

## 21. The demo tenant

There is a real customer on the R750 that belongs to nobody, called `demo`. It exists so the thing
being described here can be shown rather than explained, and so the first real customer is not the
first time any of it ran.

    slug            demo
    console         https://console.titanium.bot   (the same one Jason uses)
    account         demo@titanium.bot
    password        DEMO_PASSWORD in /home/sem/titanbot/cp.env, mode 0600
    data            /data/titanbot/demo/

To read the password without it going through a chat window:

    ssh dell-remote "grep '^DEMO_PASSWORD=' /home/sem/titanbot/cp.env | cut -d= -f2-"

It is a real box, not a mock, so treat it the way you would treat a customer's: do not put anything
in it you would not put in theirs.

Its old Coolify service (`sy74dau8ilh1g4u7a9eaw8f8`, box **and** relay, `demo.titanium.bot`) is
retired by the migration in section 22. Its data directory is untouched by that: the new box mounts
the same directories the old one did.

---

## 22. The migration, as run

Six steps, in this order, each one measured before the next begins. **The order is not negotiable.**
The network attach and the code ship are two separate restarts with a check between them, because
two changes in one restart means a 502 cannot be attributed to either, and the one thing that can
502 here is the console Jason works in.

`deploy/r750/one-console-migrate.sh` is the script. It is idempotent, every check is read-only, and
it **prints rather than clicks**: Coolify owns the compose and a compose it did not store is one it
overwrites on the next deploy. `TITANBOT_DRY_RUN=1` changes nothing at all.

    bash deploy/r750/one-console-migrate.sh

**Run on the R750 on 2026-09-07 between 04:59 and 06:00 CDT, from this Mac (Darwin 25.5.0, node
22.23.1, docker 29.0.0 on the server).** Every row below is what happened, not what was planned.

| step | what it is | measured |
| --- | --- | --- |
| a | `docker network create titanbot-net`. No restart, safe at any hour | created, subnet `192.168.48.0/20`, nothing attached yet. The script found Jason's relay only after it was fixed to match on the service uuid: with demo running it had read **demo's** relay and printed demo's network as the pin, which is the one value that would have taken the console down |
| b | paste the new compose, set `TITANBOT_BOX_CONTAINER`, ONE quiet-window restart, then check `console.titanium.bot` answers | quiet first (Titan and Scribe, 0 mid-turn, 0 open jobs). Console back to 200 within **50 seconds**. Took **two** restarts, not one, and why is section 3: the first paste's pin was a variable and Coolify escapes it inside a labels block, so the label arrived as the literal text `${TITANBOT_PROXY_NETWORK}`. Second paste, literal `titanbot-net`, read back off the running container: networks `p927bfqm83ioloibamlvyd7g titanbot-net`, pin `titanbot-net`, `coolify-proxy` attached to `titanbot-net`. `verify-deploy` green |
| c | ship the relay and control plane source, rebuild both local images, redeploy | `deploy/r750/sync.sh`, host bundle sha256 `054d26c6bd2e4d31…`, then a plain `docker restart` of the relay container, because `ui/` is a bind mount and its code does not live in the image. Relay boot: `box container titanbot-box-p927bfqm83ioloibamlvyd7g`, `work 1: titanium`, and `reg could not reach the control plane (HTTP 404)`, which is right: the control plane was still on the old image. Console 200 throughout |
| d | `CP_RELAY_TOKEN` on both resources; restart the control plane; `GET /v1/relay/tenants` answers the relay and refuses the admin token | generated on the server with `openssl rand -hex 32` into `/home/sem/titanbot/cp.env`, set on both Coolify resources, control plane image rebuilt on the server and redeployed. Health `{"ok":true,"version":"1.0.0","tenants":2,"accounts":1}`. The route: **401** with no bearer, **401** with the admin token, **200** with the relay credential. Relay after its restart: `work 2: demo, titanium` |
| e | re-provision demo as one box on the shared network; stop and delete the old two-container service, keeping its data directory | stopped (45 s to reconcile), deleted with `{"confirm":"demo"}`, `/data/titanbot/demo` kept (41 MB, `credential profile state volumes`). Provisioned again: **23 seconds** from the call to `status running, boxReady true`. One container, `titanbot-box-atonqjq7zx593jsacaccpfau`, on `atonqjq7zx593jsacaccpfau` and `titanbot-net`. The dry run first, which planned `directories, secrets, compose, service, envs, start, ready` and **no urls step** |
| f | the browser proof (two customers, two rosters, two contexts), then `verify-deploy`, `verify-one-console`, `verify-mail` | a second customer was signed up to have two: `POST /v1/signups` with `owner@northbay.test` and company `North Bay Roofing` made the account, derived the slug `north-bay-roofing` and built the box in **16 seconds**. Browser, headless Chrome, two contexts: **17 PASS 0 FAIL**, no agent id on both rosters (`c63fdce4…` and `d7df78a5…`). `verify-one-console` live, with both customers, **18 PASS 0 FAIL 8 SKIP**, and after the proof customer was retired, **17 PASS 0 FAIL 9 SKIP** with the operator standing in as the second party. `verify-deploy` **58 PASS 0 FAIL 2 inconclusive** (the two inconclusive ones want the job bus bearer, which the gate was not given; and 58 rather than the 56 this gate used to report, because the relay is on two networks now and both network-pin legs apply). `verify-mail` read-only **16 PASS 0 FAIL**. Over HTTP, three rosters from one console: demo `New Bot c63fdce4…`, north-bay `New Bot d7df78a5…`, the operator over the gateway bearer `Titan 96a720b6…, Scribe f97bfb2e…`. The proof customer was then stopped and deleted; its data directory stays |

### The gates, run one at a time at the end

Every one of these was run once, from this Mac, spaced at least a minute apart, because the console's
login throttle is five failures per address per 30 seconds and several of these fill it on purpose.
Run back to back they measure their own lockout, which is what a run reporting 49 of 58 means.

| gate | where | result |
| --- | --- | --- |
| `npm test` | this Mac | **972 pass, 0 fail**, 31 s |
| `verify-dashboard --offline` | this Mac | **58 PASS 0 FAIL** |
| `verify-control-plane` | this Mac | **115 PASS 0 FAIL** |
| `verify-one-console` | this Mac, everything it needs started by itself | **48 PASS 0 FAIL 0 SKIP** |
| `verify-deploy --url https://console.titanium.bot` | live | **58 PASS 0 FAIL**, 2 inconclusive (no job bus bearer given) |
| `verify-one-console --url … --cp …` | live | **17 PASS 0 FAIL 9 SKIP** |
| `verify-one-console-browser` | live, headless Chrome | **8 PASS 0 FAIL 3 SKIP** with one customer; **17 PASS 0 FAIL** earlier with two |
| `verify-mail --url https://console.titanium.bot` | live, read-only | **16 PASS 0 FAIL** |

### What the server looks like now

Four containers, and Jason's sentence is the shape of them:

    titanbot-relay-p927bfqm83ioloibamlvyd7g   the one console, for everybody
    titanbot-box-p927bfqm83ioloibamlvyd7g     Jason's own sandbox
    titanbot-cp-hnhzi0ongkw0gsg9k4flcv7d      the control plane
    titanbot-box-atonqjq7zx593jsacaccpfau     demo's sandbox, and that is all a customer is

`titanbot-net` carries all four plus `coolify-proxy`. Adding a customer adds one line to that list.

### Two things worth knowing before the next customer

**A brand new workspace can answer "not available" for up to a minute.** The relay reads the
registry every 60 seconds, and the container has to exist when it looks. Provisioning now waits for
the box to answer before it reports the workspace ready, so the gap is the relay's refresh and not
the build. It closes itself.

**The instance-password legs of `verify-one-console` were not measured**, because Jason's own
console password is not written down anywhere a script can read and should not be. Set
`ONE_CONSOLE_INSTANCE_PASSWORD` to measure that half.

The gate does not need it for the cross-check, though, and this is worth knowing because a real
server usually has one customer on it and not two. Give it `ONE_CONSOLE_GATEWAY_TOKEN` and the
OPERATOR becomes the second party: a customer's roster and Jason's, from the one console, compared
on agent **ids**. That is the proof the contract asks for in its own words, and it is what was
measured here:

    ONE_CONSOLE_EMAIL_A=demo@titanium.bot ONE_CONSOLE_PASSWORD_A=... \
    ONE_CONSOLE_RELAY_TOKEN=... ONE_CONSOLE_ADMIN_TOKEN=... \
    ONE_CONSOLE_GATEWAY_TOKEN="$(ssh dell-remote 'docker exec titanbot-box-<uuid> printenv SAND_GATEWAY_TOKEN')" \
      node scripts/verify-one-console.mjs --url https://console.titanium.bot --cp https://api.titanium.bot

The customer's roster had 1 agent, the operator's had 2, and none in common.

**The network goes on before the code, which reverses the order this was first planned in.** The
reason is attribution. Step b changes the container's networks and nothing else: the relay image, the
relay's code and its behaviour are all the ones already running. So a 502 after step b is the
Traefik question and nothing else, and the rollback below fixes it in three lines. Do it the other
way round and a 502 has two candidates and no way to tell them apart, at the one moment when the
thing that is down is the console Jason works in.

Step **b** is the one with a rollback, and it is three lines:

1. remove the two `networks:` lines from `titanbot-relay` in the compose
2. remove the `traefik.docker.network` label from `titanbot-relay`
3. redeploy the service

The relay is then single-homed on Coolify's own network exactly as it was, and
`console.titanium.bot` routes the way it did yesterday. Nothing else has changed at that point,
because step **c** has not run.

Before any restart of Jason's service, check it is quiet, **against that service's own box by
name**. Every customer's box carries `com.titanbot.role=box`, so a check that filters on the label
and takes the first name is asking an arbitrary customer whether Jason is busy:

    docker exec titanbot-box-<this service uuid> sh -c \
      'curl -s -m 10 -X POST http://127.0.0.1:1340/api/listAgents \
         -H "authorization: Bearer $SAND_GATEWAY_TOKEN" -H "content-type: application/json" -d {}'

Nobody mid-turn and no open job is what a quiet window is.

Copy-in is on (`SAND_BOX_STORE_COPY_IN=1`), so the box recreate restores the agents' CLI logins and
git config on the way back up. **Wait 90 seconds or more for the box before any gate.** A deploy gate
run too early fails on the roster with `no .worker-card[data-context-id] after 30 s`, which is the
box still loading agents and not a fault.

### The browser proof, in words, because this is the thing that matters

Two browser contexts side by side, because two sessions in one cookie jar prove nothing:

1. One customer signs in at `console.titanium.bot` and sees their own agents.
2. A second customer signs in at the **same address**, in a second context, and sees theirs.
3. Neither roster carries one agent from the other's box.

`scripts/verify-one-console-browser.mjs` is that run, and it compares agent **ids**, not names. This
matters more than it looks: every fresh box calls its first agent `New Bot`, so two properly
isolated customers have rosters that read identically. A cross-check on names would pass whether the
isolation worked or not. On the run above both customers showed one card reading `New Bot`, and the
ids were `c63fdce4-4fc0-4ea7-8a1b-93657df2c6c5` and `d7df78a5-3c3d-471d-9d13-ef3d9535f9e8`.

    ONE_CONSOLE_EMAIL_A=demo@titanium.bot ONE_CONSOLE_PASSWORD_A=... \
    ONE_CONSOLE_EMAIL_B=... ONE_CONSOLE_PASSWORD_B=... \
      node scripts/verify-one-console-browser.mjs

`scripts/verify-one-console.mjs` does the same over HTTP, plus the registry route's four auth cases
and the unknown-tenant answer. The browser run is what proves a person can do it; the HTTP run is
what proves the status codes and the copy.

---

## 23. The first hour, in order

```bash
# On the Mac, then on the R750, then on the Mac again.

# 1. the shared network and the relay's place on it. Section 22, steps a and b.
bash deploy/r750/one-console-migrate.sh          # on the R750; prints what to paste

# 2. the relay credential, one value on two resources. Section 22, step d.
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

# 3. claim Jason's own instance, if it is not already claimed
node cp/cli.mjs tenant adopt titanium p927bfqm83ioloibamlvyd7g console.titanium.bot

# 4. an account on it. Run this ON the R750 so the password is typed on the machine that keeps its
#    hash. It asks twice and echoes neither. Section 11.
ssh dell-remote      # then: cd /home/sem/titanbot && node cp/cli.mjs account add ... <a customer workspace>

# 5. rehearse a customer, then build them
node cp/cli.mjs signup add owner@acmeroofing.com "Acme Roofing" --dry-run
node cp/cli.mjs signup add owner@acmeroofing.com "Acme Roofing"

node cp/cli.mjs tenant list
node cp/cli.mjs account list
```

Hand the customer `https://console.titanium.bot` and their email address. That is the whole handover.
