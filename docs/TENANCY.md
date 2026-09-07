# Tenancy: one instance per customer

**Status:** TENANT-1 (the control plane) built 2026-09-06. TENANT-2 (the relay accepting the
session this file describes) is the next wave and is not done. Until it lands, a customer's relay
still asks for the relay password; everything below about accounts, tenants and provisioning is
live, and the session token is minted and verified today.

## 1. The shape

`titanium.bot` is the marketing site. `console.titanium.bot` is Jason's own instance. Every other
customer gets their own instance: the same two containers, the box and the relay, on the R750,
reached at `https://<name>.titanium.bot`. A wildcard DNS record already points every name under
`titanium.bot` at that server, so adding a customer needs no DNS work at all.

Each customer gets their own instance and their own sandbox. Nothing is shared between two
customers except the release files themselves, which are the same bytes for everybody and are read
only.

```
                     api.titanium.bot          the control plane (this document)
                            │                  accounts, tenants, sessions
                            │
   a customer  ────────────►│  signs in with an email and a password
                            │  gets back a signed session that names their instance
                            ▼
   acme.titanium.bot   ──►  their relay  ──►  their box     their agents, their files
   roofing.titanium.bot ──► their relay  ──►  their box     nobody else can see either
   console.titanium.bot ──► Jason's relay ──► Jason's box
```

Three words used throughout:

- **account** a person. An email address, a password and the tenant they belong to.
- **tenant** a customer's instance. A short name, a web address, a Coolify service and a directory
  on the server that holds everything the instance writes.
- **session** the twelve hour proof that a person signed in, signed by the control plane and
  checked by that customer's own relay.

## 2. The control plane

One small service in `cp/` of this repository. Node 22 or newer, and no dependencies at all: the
store is `node:sqlite`, the passwords are `node:crypto` scrypt, the API is `node:http`. It runs on
the R750 as a Coolify resource of its own, at `https://api.titanium.bot`.

| file | what it is |
|---|---|
| `cp/server.mjs` | the HTTP API |
| `cp/session.mjs` | the session token, minted here and verified by every tenant relay |
| `cp/store.mjs` | the sqlite store and the password hashing |
| `cp/provision.mjs` | turning a name into a running instance |
| `cp/cli.mjs` | the operator's commands |
| `cp/Dockerfile` | the image |
| `deploy/coolify/control-plane.compose.yml` | the Coolify resource |

### What it reads from the environment

| name | default | what it is |
|---|---|---|
| `CP_PORT` | `7790` | the port it listens on |
| `CP_DATA_DIR` | none | the directory holding the sqlite file |
| `CP_SESSION_SECRET` | none | 32 bytes or more, shared with every tenant relay. Required. |
| `CP_ADMIN_TOKEN` | none | the operator bearer for the account and tenant routes. Required. |
| `CP_BASE_DOMAIN` | `titanium.bot` | what a customer's address is built from |
| `COOLIFY_URL` | none | this Coolify's address |
| `COOLIFY_API_KEY` | none | an API token with write access to the project |
| `COOLIFY_PROJECT_UUID` | none | the project new tenants are created in |
| `COOLIFY_SERVER_UUID` | none | the server they run on |
| `COOLIFY_ENVIRONMENT_NAME` | `production` | the environment inside that project |
| `CP_TENANT_ROOT` | `/data/titanbot` | the directory holding every tenant's own tree |
| `CP_RELEASE_ROOT` | `/home/sem/titanbot` | the shared release: runtime, deploy, ui |
| `CP_PUBLIC_URL` | `https://api.titanium.bot` | where this service answers |

Two of those are required and the service says so and stops if either is missing. With no Coolify
settings it still runs: tenants can be recorded and adopted, they just cannot be created.

## 3. The routes

Open to anybody:

| route | what it does |
|---|---|
| `GET /v1/health` | `{ok, version, tenants, accounts}`. Counts only. |
| `POST /v1/sessions` | `{email, password}` in, a session out |
| `GET /v1/sessions/current` | who this session is, with the session as the bearer |
| `DELETE /v1/sessions/current` | sign out, which revokes this session here |

Behind `CP_ADMIN_TOKEN`:

| route | what it does |
|---|---|
| `POST /v1/accounts` | add a person: `{email, password, name, tenant}` |
| `GET /v1/accounts` | list them, never with a hash |
| `POST /v1/accounts/{id}/password` | an operator reset |
| `POST /v1/tenants` | add a customer and start building their instance |
| `GET /v1/tenants`, `GET /v1/tenants/{slug}` | the record, plus what Coolify says right now |
| `POST /v1/tenants/{slug}/adopt` | claim an instance that already exists |
| `POST /v1/tenants/{slug}/provision` | run the build again, from wherever it stopped |
| `POST /v1/tenants/{slug}/stop`, `/start`, `/restart` | pass it on to Coolify |
| `DELETE /v1/tenants/{slug}` | remove the Coolify service. The data is kept. |

### Signing in

A wrong email address and a wrong password get the same answer, `401 {"error":"invalid_login"}`,
and take the same time, because an address that has no account still costs a full password
derivation. Neither can be used to find out who has an account here.

Ten failures on one email address, or ten from one visitor, inside ten minutes, and the next try
gets `429 {"error":"locked","retryAfter"}` with the number of seconds until it is worth trying
again. A successful sign-in clears both counters.

### The session

```
v1.<the claims, base64url>.<HMAC-SHA256 of that text with CP_SESSION_SECRET, base64url>
```

The claims are the account id, the email, the tenant name, the host that tenant answers on, when it
was issued, when it expires and a unique id for this session. It lasts twelve hours.

Both sides run the same code: `verifySessionToken` in `cp/session.mjs` is what the relay wave will
import. The relay checks the signature and the expiry and nothing else. Signing out records the
session id here, so this service stops accepting it, but a relay has no such list. That is why the
life is twelve hours rather than a week.

`node cp/cli.mjs session verify <token>` prints the claims and says whether it is still good, which
is the same check a relay makes.

## 4. Passwords

A customer's password is stored as scrypt with a salt of its own: N 32768, r 8, p 1, and a 64 byte
key. The hash is written by the store and read by the store, and no route on this service returns
it. There is a test that walks every route and asserts that.

That is the control plane's password. A tenant's relay has a second one, its own relay password,
written into `<tenant>/state/auth.json` in exactly the format `ui/set-password.mjs` writes, by
importing the relay's own routine so the two cannot drift. Once TENANT-2 lands, a customer signs in
with the first and never sees the second; until then, the relay password is how they get in, which
is why it is printed once when the tenant is created.

## 5. What a customer's instance is made of

Everything an instance writes lives under `CP_TENANT_ROOT/<name>`:

```
/data/titanbot/acme/
  profile/local-docker-vm.json      their gateway token, 0600
  credential/                       the placeholder inference file the box needs to start
  state/auth.json                   their relay password, 0600
  volumes/workspace                 the agents' working files
  volumes/data                      agents, transcripts, memory
  volumes/store                     the box store
  volumes/chrome                    the browser profile
```

Everything an instance *runs* lives under `CP_RELEASE_ROOT` and is shared by every customer on the
server: `runtime` (the host bundle and the exec daemon), `deploy` (the box repairs) and `ui` (the
relay). One copy, so an update is one ship rather than one ship per customer.

The relay's writable files move to `state/` through `SAND_UI_STATE_DIR`, which is the variable the
relay wave adds next. The rendered compose sets it already, along with `SAND_UI_AUTH_FILE`, which
exists today and is what makes each tenant's password their own. Once `SAND_UI_STATE_DIR` lands the
shared `ui` mount becomes read only for tenants; the rendered compose carries a note where that
change goes.

Every tenant gets their own gateway token, 32 random bytes, and their own relay password, 24 random
bytes. Neither is ever written into the compose text: the compose refers to
`${TITANBOT_GATEWAY_TOKEN}` and `${CP_SESSION_SECRET}` and the values live in Coolify's environment
store for that resource. The relay password is not stored anywhere at all, only its hash, and it is
printed once, in the answer to the request that created the tenant.

## 6. Building an instance

Seven steps, in order, each one written to the record with the answer Coolify gave:

1. **directories** the tenant's tree above
2. **secrets** the gateway token and the relay password
3. **compose** `deploy/coolify/docker-compose.yml`, re-pointed at that tree
4. **service** `POST /services` with the compose base64 encoded, named `titanbot-<name>`, not
   started yet
5. **envs** the two values the compose refers to
6. **urls** `PATCH /services/{uuid}` with `https://<name>.titanium.bot:7777`, which is what puts the
   address on the relay
7. **start** `POST /services/{uuid}/start`

Coolify queues the start rather than doing it, so the tenant sits at `provisioning` until the
containers report themselves. `GET /v1/tenants/{slug}` is what says when that has happened: it
answers with the record and, alongside it, what Coolify says about the containers right now.

Every step is safe to run twice. If one fails, the tenant is marked `failed` with the message and
`POST /v1/tenants/{slug}/provision` picks up at the step that failed. It does not build a second
instance beside the first, and it does not mint a second gateway token: a second token would leave
the box authenticating with the first one and the relay presenting the second, and the symptom is a
console that answers 401 to everything with nothing in any log to say why.

### Rehearsing it

`--dry-run` on the CLI, or `{"dryRun": true}` in the body, does every read and every render and
creates nothing: no Coolify resource, no directories, no tenant record. It answers with the plan,
step by step, and writes the plan to the record so it can be read back later. There are no values in
a plan, only the names of the keys, so a dry run is safe to paste into a ticket.

## 7. The operator's flow

Once, on the R750:

```sh
# the directories, owned by the uid the image runs as (cp/Dockerfile says why 10001)
sudo mkdir -p /data/titanbot-cp /data/titanbot
sudo chown -R 10001:10001 /data/titanbot-cp /data/titanbot
sudo chmod 700 /data/titanbot-cp

# the image
docker build -t titanbot-cp:local -f /home/sem/titanbot/cp/Dockerfile /home/sem/titanbot

# the two secrets, generated once and kept
openssl rand -hex 32   # CP_SESSION_SECRET
openssl rand -hex 24   # CP_ADMIN_TOKEN
```

Then in Coolify: New Resource, Docker Compose Empty, paste
`deploy/coolify/control-plane.compose.yml`, fill in `CP_SESSION_SECRET`, `CP_ADMIN_TOKEN`,
`COOLIFY_URL`, `COOLIFY_API_KEY`, `COOLIFY_PROJECT_UUID` and `COOLIFY_SERVER_UUID`, set the domain
on `titanbot-cp` to `https://api.titanium.bot:7790`, deploy. The `:7777`-style port on the domain is
the container port for the proxy; the public address is plain `https://api.titanium.bot`.

Check it: `curl https://api.titanium.bot/v1/health`.

Then, from anywhere with the two environment variables set:

```sh
export CP_PUBLIC_URL=https://api.titanium.bot
export CP_ADMIN_TOKEN=…            # the value you generated

# 1. claim Jason's own instance, without touching it
node cp/cli.mjs tenant adopt titanium p927bfqm83ioloibamlvyd7g console.titanium.bot

# 2. an account on it
node cp/cli.mjs account add jason@webdevtoday.com titanium --name "Jason Brashear"
#    it asks for the password on the terminal and does not echo it

# 3. rehearse a customer
node cp/cli.mjs tenant add acme "Acme Roofing" --dry-run

# 4. build them
node cp/cli.mjs tenant add acme "Acme Roofing"
#    it prints the relay password once. Write it down.

# 5. their people
node cp/cli.mjs account add owner@acmeroofing.com acme --name "The Owner"

node cp/cli.mjs tenant list
node cp/cli.mjs account list
```

`titanium` is on the reserved list, so no customer can ever claim that name. Adopt does not consult
the list, because the whole point of that route is the operator taking a reserved name for the
instance that already exists.

### What the customer sees

They go to `https://acme.titanium.bot`, type their email address and their password, and they are in
their own console with their own agents. They never see the control plane, they never see a tenant
name, and nothing on their instance can reach anybody else's.

Until TENANT-2 lands they type the relay password instead, the one printed when their tenant was
created.

## 8. Removing a customer

Stop the tenant first, then remove it, and type the name back:

```sh
curl -X POST  -H "authorization: Bearer $CP_ADMIN_TOKEN" https://api.titanium.bot/v1/tenants/acme/stop
curl -X DELETE -H "authorization: Bearer $CP_ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"confirm":"acme"}' https://api.titanium.bot/v1/tenants/acme
```

**No route on this service deletes a customer's data.** Removing a tenant removes the Coolify
service and nothing else. The directories under `/data/titanbot/acme` are left exactly as they were,
Coolify is told to keep its volumes, and the answer says where the data still is. Deleting it is a
deliberate act by a person on the server, with a backup taken first.

## 9. What the relay wave adds next

TENANT-2, the other half:

- the relay reads `CP_SESSION_SECRET` and accepts a control plane session in place of its own
  password, checking the signature, the expiry and that the token's `host` claim is this instance
- `SAND_UI_STATE_DIR`, moving auth, subscriptions, the job bus and mail into the tenant's `state`
  directory, which is what lets the shared `ui` mount become read only
- the sign-in page pointing at `api.titanium.bot` instead of asking for a shared password

Nothing in this document changes when that lands. The token this service already mints is the token
the relay will verify.
