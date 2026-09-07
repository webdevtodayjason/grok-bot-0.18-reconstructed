# One instance per customer

**Status:** TENANT-1, the control plane, is built. TENANT-2, the relay accepting the session this
file describes, is the next wave and is not done. Until it lands a customer's relay still asks for
its own relay password, the one printed once when their tenant was created. Everything below about
accounts, tenants, sessions and provisioning is live today.

The decision this implements (Jason, 2026-09-06): every customer gets their own instance and their
own sandbox. Not one console with accounts in it. Their own box, their own relay, their own
workspace, their own agents, on their own hostname.

    titanium.bot                 the marketing site
    console.titanium.bot         Jason's own instance
    api.titanium.bot             the control plane, this document
    <slug>.titanium.bot          one customer

A customer signs in with an email address and a password and lands on their own console. Nothing
they do can reach another customer's instance, because there is no shared instance to reach: the
separation is two containers and a directory tree, not a `WHERE tenant_id = ?`.

```
                     api.titanium.bot          accounts, tenants, sessions
                            |
   a customer  ----------->  signs in with an email and a password
                            |  gets back a signed session that names their instance
                            v
   acme.titanium.bot   -->  their relay  -->  their box     their agents, their files
   roofing.titanium.bot --> their relay  -->  their box     nobody else can see either
   console.titanium.bot --> Jason's relay --> Jason's box
```

Three words used throughout:

- **account** a person. An email address, a password and the tenant they belong to.
- **tenant** a customer's instance. A short name, a web address, a Coolify service and a directory
  on the server that holds everything the instance writes.
- **session** the twelve hour proof that a person signed in, signed by the control plane and
  checked by that customer's own relay.

## 1. The three parts

| part | how many | where |
| --- | --- | --- |
| the control plane | one | `cp/` in this repo, a Coolify service at `api.titanium.bot` |
| a tenant instance | one per customer | the box and the relay from `deploy/coolify/docker-compose.yml`, a Coolify service each |
| the shared release files | one copy | `/home/sem/titanbot/{runtime,deploy,ui}` on the R750, mounted into every tenant |

The control plane holds the accounts, mints the sessions and asks Coolify for instances. It is the
only piece that knows the customer list. `cp/README.md` is how to run it and what its routes are.

A tenant instance is the stack that is already running as `console.titanium.bot`, with its paths
pointed somewhere else. Same image, same entrypoint, same relay, same labels.

The release files are shared on purpose. A ship is an rsync and a restart, once, and every tenant
gets it. Per-tenant copies of a 19 MB host bundle would mean a ship that is done for some customers
and not others, which is the failure nobody would notice until one of them reports a bug that was
fixed a week ago.

### The control plane's own files

| file | what it is |
| --- | --- |
| `cp/server.mjs` | the HTTP API |
| `cp/session.mjs` | the session token, minted here and verified by every tenant relay |
| `cp/store.mjs` | the sqlite store and the password hashing |
| `cp/provision.mjs` | turning a name into a running instance |
| `cp/cli.mjs` | the operator's commands |
| `cp/Dockerfile` | the image |
| `deploy/coolify/control-plane.compose.yml` | the Coolify resource |
| `scripts/verify-control-plane.mjs` | the gate |

Node 22 or newer, and no dependencies at all: the store is `node:sqlite`, the passwords are
`node:crypto` scrypt, the API is `node:http`. There is no `package.json` in the image and no
`node_modules`, which is the point.

### What it reads from the environment

| name | default | what it is |
| --- | --- | --- |
| `CP_PORT` | `7790` | the port it listens on |
| `CP_DATA_DIR` | `/data/titanbot/_control-plane` in the image | the directory holding the sqlite file |
| `CP_SESSION_SECRET` | none | 32 bytes or more, shared with every tenant relay. Required. |
| `CP_ADMIN_TOKEN` | none | the operator bearer for the account and tenant routes. Required. |
| `CP_BASE_DOMAIN` | `titanium.bot` | what a customer's address is built from |
| `COOLIFY_URL` | none | this Coolify's address |
| `COOLIFY_API_KEY` | none | an API token with write access to the project |
| `COOLIFY_PROJECT_UUID` | none | the project new tenants are created in |
| `COOLIFY_SERVER_UUID` | none | the server they run on |
| `COOLIFY_ENVIRONMENT_NAME` | `production` | the environment inside that project |
| `COOLIFY_ENVIRONMENT_UUID` | none | sent alongside the name only when it is set, because the openapi lists it as required while its own description says either will do |
| `CP_TENANT_ROOT` | `/data/titanbot` | the directory holding every tenant's own tree |
| `CP_RELEASE_ROOT` | `/home/sem/titanbot` | the shared release: runtime, deploy, ui |
| `CP_PUBLIC_URL` | `https://api.titanium.bot` | where this service answers |
| `CP_DRY_RUN` | unset | when `1`, every tenant create is a rehearsal |

Two of those are required and the service says so and stops if either is missing. With no Coolify
settings it still runs: tenants can be recorded and adopted, they just cannot be created.

## 2. What a tenant is, exactly

On Coolify: one service named `titanbot-<slug>`, in the project Titanium Computing, environment
production, on the R750, with two containers in it. Coolify renames the containers to
`<service>-<uuid>`, which is why nothing anywhere looks a container up by name and everything uses
the `com.titanbot.role` label instead.

On the disk, under `CP_TENANT_ROOT` (`/data/titanbot` on the R750):

    /data/titanbot/<slug>/
      profile/local-docker-vm.json     the tenant's gateway token, 0600
      credential/                      the inference placeholder the box needs to start
      state/auth.json                  their relay password as a scrypt hash, 0600
      state/                           the rest of the relay's writable files: subscriptions, job bus, mail
      volumes/workspace/               the agents' files
      volumes/data/                    agents, transcripts, memory
      volumes/store/                   the box store, which is what survives a recreate
      volumes/chrome/                  the browser profile

Everything an instance *runs* lives under `CP_RELEASE_ROOT` and is shared by every customer on the
server: `runtime` (the host bundle and the exec daemon), `deploy` (the box repairs) and `ui` (the
relay). One copy, so an update is one ship rather than one ship per customer.

On DNS: nothing per tenant. `*.titanium.bot` is a proxied wildcard A record to the R750, so
`acme.titanium.bot` resolves the day the tenant is created and Coolify's Traefik gets a certificate
for it on the first request.

The control plane's own sqlite store lives at `/data/titanbot/_control-plane`, under the same root
so one backup covers both. No tenant can ever collide with it: a slug is 3 to 32 characters of
`[a-z0-9-]` that cannot begin or end with a dash, so nothing can start with an underscore.

## 3. The routes

Open to anybody:

| route | what it does |
| --- | --- |
| `GET /v1/health` | `{ok, version, tenants, accounts}`. Counts only. |
| `POST /v1/sessions` | `{email, password}` in, a session out |
| `GET /v1/sessions/current` | who this session is, with the session as the bearer |
| `DELETE /v1/sessions/current` | sign out, which revokes this session here |

Behind `CP_ADMIN_TOKEN`:

| route | what it does |
| --- | --- |
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

    POST https://api.titanium.bot/v1/sessions
    {"email": "owner@acme.example", "password": "..."}

    200 {"token": "v1.<payload>.<signature>", "expiresAt": "...",
         "account": {...}, "tenant": {"slug": "acme", "host": "acme.titanium.bot", "status": "running"}}

A wrong password and an email nobody has get the same answer, in the same shape:
`401 {"error":"invalid_login"}`, and they take the same time, because an address that has no
account still costs a full password derivation. Neither can be used to find out who has an account
here. Ten failures in ten minutes, counted per email address and per network address, get
`429 {"error":"locked","retryAfter":...}` instead, with the seconds until it is worth trying again;
a successful sign-in clears both counters. What a person reads is "That email address and password
do not match" and "Too many tries. Wait a few minutes and try again", in plain words, with nothing
in either that says whether the address is a customer.

### The session

    v1.<the claims, base64url>.<HMAC-SHA256 of that text with CP_SESSION_SECRET, base64url>

The claims are the account id, the email, the tenant name, the host that tenant answers on, when it
was issued, when it expires and a unique id for this session. It lasts twelve hours.

Two sides check it, and they check different amounts:

- **the control plane** verifies the signature, the expiry, and the `jti` against its revocation
  table, because it has the store in front of it.
- **the tenant relay** verifies the signature and the expiry only. It has no database and it is not
  going to call home on every request. So a signed-out session can still open a relay for up to
  twelve hours, and the way to end one sooner is to rotate `CP_SESSION_SECRET`, which signs
  everybody out of everything at once.

Both use the same code: `cp/session.mjs` exports `verifySessionToken(token, secret, now)` and the
relay imports that file rather than reimplementing it. Two implementations of one signature is how
a customer ends up locked out of their own console on a Sunday.

`node cp/cli.mjs session verify <token>` prints the claims and says whether it is still good, which
is the same check a relay makes.

## 4. Passwords

A customer's password is stored as scrypt with a salt of its own: N 32768, r 8, p 1, and a 64 byte
key. The hash is written by the store and read by the store, and no route on this service returns
it. There is a test that walks every route and asserts that.

That is the control plane's password. A tenant's relay has a second one, its own relay password,
written into `<tenant>/state/auth.json` in exactly the format `ui/set-password.mjs` writes, by
importing the relay's own routine (`ui/auth.mjs`) so the two cannot drift. The relay's file is
written at the relay's own scrypt parameters, N 16384, because `ui/server.mjs` is what has to read
it. Once TENANT-2 lands a customer signs in with the first and never sees the second; until then
the relay password is how they get in, which is why it is printed once when the tenant is created.

## 5. Deploy the control plane, once

On the Mac, from this repo:

    bash deploy/r750/sync.sh --no-install

Then on the server:

    ssh dell-remote

    # the directory that holds every tenant and the control plane's own store.
    # uid 1000 is sem, which is the uid the image runs as. cp/Dockerfile says why.
    sudo install -d -o 1000 -g 1000 -m 0750 /data/titanbot

    # the image. Coolify cannot build it: a Docker Compose Empty resource has no build context.
    docker build -t titanbot-cp:local -f /home/sem/titanbot/cp/Dockerfile /home/sem/titanbot

Then in Coolify, in the project Titanium Computing, environment production:

1. New Resource, Docker Compose Empty, paste `deploy/coolify/control-plane.compose.yml`.
2. Set the six environment fields the file leaves as `${...}`:
   - `CP_SESSION_SECRET`, 32 bytes or more, generated once and never written down anywhere else.
     `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`
   - `CP_ADMIN_TOKEN`, the operator bearer. Same generator, 24 bytes is plenty.
   - `COOLIFY_URL` and `COOLIFY_API_KEY`, from Keys and Tokens. This key can create and delete
     services on this server, so it lives in exactly two places: Coolify's own store and this
     service's environment.
   - `COOLIFY_PROJECT_UUID` and `COOLIFY_SERVER_UUID`. Both are on the resource page of
     console.titanium.bot, or from `GET /projects` and `GET /servers`.
3. Set Domains on `titanbot-cp` to `https://api.titanium.bot:7790`. The `:7790` is the container
   port for the proxy. The public url is plain `https://api.titanium.bot`.
4. Deploy.

Check it before trusting it:

    curl -s https://api.titanium.bot/v1/health
    # {"ok":true,"version":"...","tenants":0,"accounts":0}

Health needs no bearer and returns counts only. If it answers with anything more than those four
fields, stop and read the code: that route is the one place a mistake is public.

## 6. Adopt Jason's instance as tenant `titanium`

`console.titanium.bot` already exists, has been running for weeks, and has all of his agents in it.
It must not be created, rendered, restarted or touched. Adopt is the route that writes a ledger row
for an instance that is already there:

    curl -s -X POST https://api.titanium.bot/v1/tenants/titanium/adopt \
      -H "authorization: Bearer $CP_ADMIN_TOKEN" -H 'content-type: application/json' \
      -d '{"coolifyServiceUuid":"p927bfqm83ioloibamlvyd7g","host":"console.titanium.bot"}'

Or `node cp/cli.mjs tenant adopt titanium p927bfqm83ioloibamlvyd7g console.titanium.bot`.

The row comes back with status `adopted`, which is its own status and not `running`, so a reader
can always tell which instances this service built and which it inherited. Nothing is created on
Coolify, no directory is made, and that instance keeps its own relay password until the relay wave
teaches it to accept a session.

`titanium` is on the reserved list, so no customer can ever claim that name. Adopt does not consult
that list, because the whole point of the route is the operator taking a reserved name for the
instance that already exists.

## 7. Add an account

    node cp/cli.mjs account add owner@acme.example acme --name "A Business Owner"

It asks for the password on the terminal, twice, with the echo off. It does not take one as an
argument, because an argument is in the shell history and in `ps`. The tenant has to exist first,
or the answer says so in a sentence: an account whose instance does not exist is an account that
signs in and lands nowhere.

To reset one later: `POST /v1/accounts/{id}/password`. There is no self-service reset yet, and no
email is sent by this service at all.

## 8. Add a tenant

Read the plan first. This does every read and every render and creates nothing, on Coolify or on
disk, and does not write a tenant row either:

    node cp/cli.mjs tenant add acme "Acme Roofing" --dry-run

What comes back is the list of calls it would make, in order, with a preview of each body, and the
plan is written to the ledger as JSON so it can be read back later. There are no values in a plan,
only the names of the keys, so a dry run is safe to paste into a ticket. Read the rendered compose
in the create step: the four data paths should be under `/data/titanbot/acme/volumes/`, the profile
and credential paths should be Acme's, and `runtime`, `deploy` and `ui` should still be the shared
`/home/sem/titanbot` ones.

Then, without `--dry-run`, the real thing. Provisioning is seven steps. Every one is idempotent and
every one is recorded in the ledger with the answer Coolify gave, so a failure stops on a named step
and `POST /v1/tenants/acme/provision` picks up from there rather than starting over.

1. **directories** `profile`, `credential`, `state` and the four `volumes` under `/data/titanbot/acme`.
2. **secrets** a gateway token, 32 random bytes as hex, written to `profile/local-docker-vm.json` in
   the shape the relay reads (`{"token": "..."}`, the file `tokenFromProfile` in `ui/server.mjs`
   opens). And a relay password, 24 url-safe bytes, written to `state/auth.json` through
   `ui/auth.mjs` at mode 0600. **The relay password is in the answer to this call and nowhere
   else.** It is not in the ledger. If it is lost, reset it rather than looking for it. On a retry
   an existing gateway token is read back off disk, never minted again: a second token leaves the
   box authenticating with the first and the relay presenting the second, and the symptom is a
   console that answers 401 to everything with nothing in any log to say why.
3. **compose** `deploy/coolify/docker-compose.yml`, re-pointed at that tree, with `TENANT_ID=acme`.
4. **service** `POST /services` with the compose base64 in `docker_compose_raw`, name
   `titanbot-acme`, the project, the environment and the server, and `instant_deploy: false`.
5. **envs** `POST /services/{uuid}/envs` once per variable, including `TITANBOT_GATEWAY_TOKEN`,
   `CP_URL` and `CP_SESSION_SECRET`. Those live in Coolify's environment store, not in the compose
   text.
6. **urls** `PATCH /services/{uuid}` with
   `urls: [{"name":"titanbot-relay","url":"https://acme.titanium.bot:7777"}]`, which is what puts
   the address on the relay.
7. **start** `POST /services/{uuid}/start`.

One thing to watch on the very first real create: the openapi lists `environment_uuid` in the
required set for `POST /services` alongside `server_uuid`, `project_uuid` and `environment_name`,
while its own description says either the name or the uuid will do. Set
`COOLIFY_ENVIRONMENT_UUID` and both are sent. If a create comes back 422 naming a missing field,
that is the field, and `GET /projects/{uuid}/environments` is where the uuid is.

Start is asynchronous. Coolify answers "Service starting request queued." straight away, so the
status in the ledger is `provisioning` until the containers report running. `GET /v1/tenants/acme`
is the ledger row plus whatever Coolify says right now. One thing to know about that: the
documented Service object has no status field at all. The container states come from
`GET /services/{uuid}/applications`, which the openapi types as an untyped array, so a missing or
oddly shaped answer is treated as unknown rather than as stopped.

## 9. Stop, start, restart, delete

    POST /v1/tenants/{slug}/stop        POST /v1/tenants/{slug}/start
    POST /v1/tenants/{slug}/restart

All three are passed through to Coolify and all three are queued, not immediate. A restart recreates
both containers, which is fine and is what the copy-in on the box start is for.

    DELETE /v1/tenants/{slug}
    {"confirm": "acme"}

It only works when the tenant is stopped, and only with the slug repeated in the body. It deletes
the Coolify service.

Coolify's own delete takes four query flags, `delete_configurations`, `delete_volumes`,
`docker_cleanup` and `delete_connected_networks`, and **every one of them defaults to true**. This
route sends all four explicitly, with `delete_volumes=false`, rather than letting the defaults
stand, because a tenant's data directories are bind mounts and Coolify keeps a storage record for
each one. Sending nothing and trusting a default is how "the api never deletes data" would quietly
stop being true.

**It does not delete the customer's data, and no route in this api ever will.**
`/data/titanbot/acme` stays exactly where it is: the workspace, the agents, the transcripts, the
store. Deleting a customer's files is a decision a person makes on the server, on purpose, with
`rm -rf` and their own eyes on the path, with a backup taken first. It is not a thing an api call
can do by accident at two in the morning.

## 10. The operator's first hour, in order

```sh
export CP_PUBLIC_URL=https://api.titanium.bot
export CP_ADMIN_TOKEN=...            # the value generated in section 5

# 1. claim Jason's own instance, without touching it
node cp/cli.mjs tenant adopt titanium p927bfqm83ioloibamlvyd7g console.titanium.bot

# 2. an account on it. It asks for the password on the terminal and does not echo it
node cp/cli.mjs account add jason@webdevtoday.com titanium --name "Jason Brashear"

# 3. rehearse a customer
node cp/cli.mjs tenant add acme "Acme Roofing" --dry-run

# 4. build them. It prints the relay password once. Write it down.
node cp/cli.mjs tenant add acme "Acme Roofing"

# 5. their people
node cp/cli.mjs account add owner@acmeroofing.com acme --name "The Owner"

node cp/cli.mjs tenant list
node cp/cli.mjs account list
```

## 11. What the customer sees

They go to `https://acme.titanium.bot`, they get a sign-in page, they type the email address and
password you gave them, and they are in their own console with their own agents. No relay password,
no tailnet, no shared login. They never see the control plane and they never see a tenant name, and
nothing on their instance can reach anybody else's.

While an instance is still coming up, signing in works and their console says the machine is
starting. That is the honest answer and it is better than a login that hangs.

Until TENANT-2 lands they type the relay password instead, the one printed when their tenant was
created.

## 12. What the relay wave adds next

This wave defines the token. The relay side of it is TENANT-2 and is next:

- `SAND_UI_STATE_DIR`, so the relay's writable files (`auth.json`, `subscriptions.json`, the job bus
  token, mail) come out of the tenant's `state/` directory instead of out of `/app/ui`. That is what
  finally lets the shared `ui` mount be read-only for tenants, and until it lands the rendered
  compose says so in a comment rather than pretending otherwise. The rendered compose already sets
  `SAND_UI_AUTH_FILE`, which exists in `ui/server.mjs` today and is what makes each tenant's relay
  password their own before the rest of it moves.
- The relay accepting a control plane session in place of its own password: verify with
  `verifySessionToken` from `cp/session.mjs` against the `CP_SESSION_SECRET` it is given, check the
  `tenant` claim matches its own `TENANT_ID`, and refuse a token minted for somebody else even
  though the signature is good. That last check is the one that matters, because a valid session for
  another tenant is the only way one customer could ever reach another's console.
- Jason's own instance keeps its relay password as well, because it is adopted rather than built and
  he signs in from the tailnet too.

Nothing in this document changes when that lands. The token this service already mints is the token
the relay will verify.

## 13. The gate

    node scripts/verify-control-plane.mjs

It starts the control plane itself on a free port, with a throwaway store, a throwaway tenant root
and a fake Coolify that records every call and answers the way the openapi says. Then it walks
health, the admin door, adding an account, minting a session and re-deriving its signature
independently, reading the session back, a tampered token, revoking, a tenant dry run that must
reach neither Coolify nor the disk, an adopt, and the reserved and malformed slugs. The last leg
searches every answer it saw for the session secret, the admin token and the password.

No box, no docker, no network. Exit 0 every leg passed, 1 a leg failed, 2 the server never started,
which is not a pass.

## 14. What counts as a secret here

| secret | where it lives | who sees it |
| --- | --- | --- |
| a customer's password | nowhere. Only the scrypt hash and salt, in the store | nobody |
| `CP_SESSION_SECRET` | the control plane's environment, and every tenant relay's | operator only |
| `CP_ADMIN_TOKEN` | the control plane's environment | operator only |
| `COOLIFY_API_KEY` | the control plane's environment, and Coolify | operator only |
| a tenant's gateway token | that tenant's `profile/local-docker-vm.json` at 0600, and Coolify's env store | that tenant's containers |
| a tenant's relay password | that tenant's `state/auth.json` as a scrypt hash | shown once, at creation |

None of them is ever a query parameter, ever in a log line, or ever in an answer. The last leg of
the gate is there to keep that true after the next route is added.
