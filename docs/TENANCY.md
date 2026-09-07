# One instance per customer

**Status:** live on the R750 since 2026-09-07. TENANT-1 built the control plane. TENANT-2 built the
relay side of it and put both on the machine: a customer signs in with an email address and a
password, a tenant writes its own settings files instead of the operator's, and a tenant relay no
longer gets the docker socket. The control plane answers at `https://api.titanium.bot`, Jason's own
instance is the tenant `titanium` and is in tenant mode, and there is a real second instance at
`https://demo.titanium.bot` that a browser has signed in to. Section 12 is what that wave changed
and section 18 is the demo instance it was proved on.

A relay is in tenant mode only when `TENANT_ID`, `CP_URL` and `CP_SESSION_SECRET` are all set. An
instance without them, which is any instance nobody has migrated, keeps the single password box it
always had.

The decision this implements (Jason, 2026-09-06): every customer gets their own instance and their
own sandbox. Not one console with accounts in it. Their own box, their own relay, their own
workspace, their own agents, on their own hostname.

    titanium.bot                 the marketing site
    console.titanium.bot         Jason's own instance
    api.titanium.bot             the control plane, this document
    <slug>.titanium.bot          one customer

A customer signs in with an email address and a password and lands on their own console. The
separation is two containers and a directory tree, not a `WHERE tenant_id = ?`.

Two things are shared, and neither is a hole any more. Section 12 is the detail of how each stopped
being one:

- **the release `ui` directory.** Every tenant relay mounts the operator's own
  `/home/sem/titanbot/ui`, read-only, and that is now only the code. `endpoints.json` in that
  directory holds the provider API keys, and TENANT-2 gave the relay `SAND_UI_ENDPOINTS_FILE` so a
  tenant reads and writes its own copy under `/state` instead. That was the condition
  `CP_ALLOW_NEW_TENANTS` was waiting on, and it is why building a second instance is on now.
- **the host.** The tenants are containers on one server. A tenant relay no longer gets the docker
  socket, which is what used to make that a hole rather than a boundary. Section 15 is what a relay
  cannot do without it, and what it says instead of failing.

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
| `ui/session-token.mjs` | the session token itself: mint, verify, and each tenant's derived key. Node builtins only, so both sides can import it |
| `cp/session.mjs` | a re-export of the file above, so the control plane's imports read as its own |
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
| `CP_SESSION_SECRET` | none | 32 bytes or more, the master key. Never handed to a tenant: each relay gets its own key derived from this one. Required. |
| `CP_ADMIN_TOKEN` | none | the operator bearer for the account and tenant routes. Required. |
| `CP_BASE_DOMAIN` | `titanium.bot` | what a customer's address is built from |
| `CP_COOLIFY_URL` | none | this Coolify's api address. **Not** `COOLIFY_URL`: Coolify puts one of its own into every service container, holding that container's public address, and it wins. `COOLIFY_URL` is still read when this is unset. |
| `COOLIFY_API_KEY` | none | an API token with write access to the project |
| `COOLIFY_PROJECT_UUID` | none | the project new tenants are created in |
| `COOLIFY_SERVER_UUID` | none | the server they run on |
| `COOLIFY_ENVIRONMENT_NAME` | `production` | the environment inside that project |
| `COOLIFY_ENVIRONMENT_UUID` | none | sent alongside the name only when it is set, because the openapi lists it as required while its own description says either will do |
| `CP_TENANT_ROOT` | `/data/titanbot` | the directory holding every tenant's own tree |
| `CP_RELEASE_ROOT` | `/home/sem/titanbot` | the shared release: runtime, deploy, ui |
| `CP_PUBLIC_URL` | `https://api.titanium.bot` | where this service answers |
| `CP_DRY_RUN` | unset | when `1`, every tenant create is a rehearsal |
| `CP_ALLOW_NEW_TENANTS` | unset | when `1`, this service may build new customer instances. Off until the relay reads its settings from each customer's own state directory. |
| `CP_TRUSTED_PROXIES` | none | the CIDRs whose `X-Forwarded-For` may say who the visitor is. Empty means the socket address is the visitor. |
| `CP_CLOUDFLARE_RANGES` | none | which of those may hand over a `CF-Connecting-IP`. Empty means that header is never read. |
| `CP_RELAY_PEERS` | none | the CIDRs whose sign-ins are a relay forwarding a customer, not a customer. Their failures are counted by email only. Empty means the address bucket applies to them too, which is one bucket for the whole fleet. |

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

That backup is `deploy/backup/snapshot.sh`, and it did not cover this root until 2026-09-07: the
newest snapshot on the array held the relay side and the operator's own four volumes and nothing
under `/data/titanbot`, so every account and every customer's instance was unprotected. It copies
the whole root now, live, and retakes the control plane's own directory with that container paused,
because a sqlite file copied mid-write restores without complaint and is still wrong.
`deploy/backup/restore-drill.sh` opens it. docs/OPERATOR-RUNBOOK.md has the sizing note.

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
a successful sign-in clears the rows for that
address and that email together, and nobody else's. What a person reads is "That email address and password
do not match" and "Too many tries. Wait a few minutes and try again", in plain words, with nothing
in either that says whether the address is a customer.

### The session

    v1.<the claims, base64url>.<HMAC-SHA256 of that text with that tenant's own key, base64url>

The claims are the account id, the email, the tenant name, the host that tenant answers on, when it
was issued, when it expires and a unique id for this session. It lasts twelve hours.

**One key per tenant.** `CP_SESSION_SECRET` on the control plane is a master and it never leaves
that container. Each tenant relay is given only `HMAC-SHA256(master, its own name)`, which is what
the control plane signs that tenant's sessions with, and it is what is written into that tenant's
Coolify environment. That matters because a key in a container's environment is readable by anything
running in that container: with one shared key, any customer could sign a token claiming any tenant
they liked, `console.titanium.bot` included, and the relay's check of the `tenant` claim would be no
defence, because they would simply write the claim it wants. With a derived key they can sign for
themselves and for nothing else.

Rotating the master changes every tenant's key at once, so it signs everybody out of everything and
every relay has to be given its new value in the same pass.

Two sides check it, and they check different amounts:

- **the control plane** verifies the signature, the expiry, and the `jti` against its revocation
  table, because it has the store in front of it.
- **the tenant relay** verifies the signature and the expiry only. It has no database and it is not
  going to call home on every request. So a signed-out session can still open a relay for up to
  twelve hours, and the way to end one sooner is to rotate `CP_SESSION_SECRET`, which signs
  everybody out of everything at once.

Both use the same code. `ui/session-token.mjs` exports `verifySessionToken(token, secret, now)` and
`tenantSessionSecret(master, slug)`, and `cp/session.mjs` re-exports it, so there is one file and not
two. It lives under `ui/` because that is the half `deploy/r750/sync.sh` already ships to every
relay, and it imports nothing but node builtins so the control plane's image can copy it beside
`ui/auth.mjs`. Two implementations of one signature is how a customer ends up locked out of their
own console on a Sunday.

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

Two scripts, in this order. Everything below used to be a dozen clicks in the Coolify UI and two
commands typed into a live server, which is a deploy nobody can repeat and nobody can review. Both
scripts are idempotent, so re-running either one is the normal way to fix a half-finished run.

**Step 1, on the Mac.** Put the files on the server:

    bash deploy/r750/sync.sh --no-install

**Step 2, on the server.** This makes the tenant root, builds the image and generates the two
secrets. Run it as `sem`, not with sudo. It calls sudo itself for the one step that needs it.

    ssh dell-remote
    TITANBOT_DRY_RUN=1 bash /home/sem/titanbot/deploy/control-plane-install.sh   # read it first
    bash /home/sem/titanbot/deploy/control-plane-install.sh

What it does:

- `/data/titanbot` and `/data/titanbot/_control-plane`, owned by `sem` at mode 0750. `/data` is
  this host's docker data root and the disk with room on it, which is why the tenants live there
  rather than under `/home/sem`.
- `docker build -t titanbot-cp:local` from `/home/sem/titanbot`, with `--build-arg UID` and
  `--build-arg GID` set to the same uid it just gave those directories. Coolify cannot do this
  build itself: a Docker Compose Empty resource has no build context.
- `CP_SESSION_SECRET` and `CP_ADMIN_TOKEN` into `/home/sem/titanbot/cp.env` at mode 0600, once.
  Neither is ever printed. An existing value is kept and never rewritten, because every tenant
  relay is already holding a key derived from the first master, and a second master signs sessions
  none of them will accept.

The uid matters more than it looks. `id -u sem` on the R750 answers **1001**, not the 1000 that a
first login account usually is and that `node` happens to be inside the base image. The image and
the tenant root have to agree on that number or the control plane cannot write the directories it
just made, so one script does both and passes the same pair to each.

**Step 3, on the Mac.** This makes the Coolify service. It reads the two secrets off the server
into your shell rather than into a file, and it needs the Coolify pair from wherever you keep
yours. No uuid has to be in your shell: the server is a constant in the script, the project is
found by its name, and the environment is found inside the project.

    export CP_SESSION_SECRET="$(ssh dell-remote "grep '^CP_SESSION_SECRET=' /home/sem/titanbot/cp.env | cut -d= -f2-")"
    export CP_ADMIN_TOKEN="$(ssh dell-remote "grep '^CP_ADMIN_TOKEN=' /home/sem/titanbot/cp.env | cut -d= -f2-")"
    export COOLIFY_URL=... COOLIFY_API_KEY=...    # your own shell's names; the tool writes
                                                 # CP_COOLIFY_URL onto the service

    node deploy/r750/control-plane-coolify.mjs --dry-run     # the plan, calling nothing
    node deploy/r750/control-plane-coolify.mjs

It creates or updates one service named `titanbot-cp` in the project Titanium Computing,
environment production, on server `zl2ti5llrtpx83918j8arb9f`, from
`deploy/coolify/control-plane.compose.yml` sent as base64 in `docker_compose_raw`. Then it sets the
environment, sets the address to `https://api.titanium.bot:7790` and starts it.

The environment it sets is read out of that compose file rather than listed in the script, so the
file an operator reviews is the file that ships. Sixteen keys come from it, plus
`COOLIFY_ENVIRONMENT_UUID`, which the compose does not carry. A value written `${NAME}` comes from
your shell or, for the three uuids, from the lookups above. Two values deliberately differ from the
file:

| key | in the file | what the script sets | why |
| --- | --- | --- | --- |
| `CP_ALLOW_NEW_TENANTS` | `0` | `1` | The file is the safe default for anyone pasting it by hand. The script is run by the operator standing the service up, after the relay reads its settings out of each tenant's own state directory. Set `CP_ALLOW_NEW_TENANTS=0` in your shell to keep it off. |
| `COOLIFY_ENVIRONMENT_UUID` | not there | looked up | Coolify's openapi lists it in the required set for `POST /services` while its own description says the name will do, so both are sent. |

Nothing it prints carries a secret. `CP_SESSION_SECRET`, `CP_ADMIN_TOKEN`, `COOLIFY_API_KEY` and
`CP_COOLIFY_URL` print as `(set, N characters, not printed)`, and every line goes through a redactor
first, so a value cannot reach the terminal inside an error quoted back from Coolify either. A dry
run is safe to paste into a ticket.

The address is set as a `urls` PATCH on the service, naming the compose's service name. The `:7790`
in it is the **container** port for the proxy, not a published one. The public url is plain
`https://api.titanium.bot`.

**Step 4.** Coolify queues a start rather than doing one, so give it a minute, then check it before
trusting it:

    curl -s https://api.titanium.bot/v1/health
    # {"ok":true,"version":"...","tenants":0,"accounts":0}

Health needs no bearer and returns counts only. If it answers with anything more than those four
fields, stop and read the code: that route is the one place a mistake is public.

**Measured on the R750, 2026-09-07.** The install script made `/data/titanbot` and
`/data/titanbot/_control-plane` owned by `sem` (1001:1001, mode 0750), built `titanbot-cp:local` at
165 MB running as 1001:1001, and wrote `cp.env` at mode 0600 with the two secrets. A second run
rebuilt the image and kept both secrets, printing `is already in cp.env, kept` for each. The Coolify
tool created service **`hnhzi0ongkw0gsg9k4flcv7d`** in project `Titanium Computing`
(`c24e2ulqhmgn4d0c5lx43i63`), environment `production` (`fvp4fn26eqc1kfzg63yjvvzv`), set 17
environment values and gave it `https://api.titanium.bot:7790`. Health answered on the first poll,
about ten seconds after the start was queued, with no wait for a certificate:
`{"ok":true,"version":"1.0.0","tenants":0,"accounts":0}`.

Two things the first real run found, both now fixed in the files above, both worth knowing because
they are the shape of mistake this pair of scripts exists to stop:

- **`COOLIFY_URL` is a name Coolify has already taken.** It puts its own `COOLIFY_URL` into every
  service container, holding that container's public address, and its value beats an environment
  record set with the same name. The control plane was handed the Coolify api's address and read
  back `https://api.titanium.bot`, its own front door, so every `POST /services` answered 404. The
  setting is `CP_COOLIFY_URL` now. `COOLIFY_URL` is still read when that is unset.
- **A running service takes a restart, not a start.** Coolify answers `400 Service is already
  running.` to a second start, and a service that is already up keeps running the compose and the
  environment it started with. The tool restarts a running service, which is also the call that
  makes what it just wrote the thing that is running.

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

### Putting that instance in tenant mode

An adopted instance is not rendered by the control plane, so nothing set the three variables that
turn the account sign-in on. They go on once, on Coolify service `p927bfqm83ioloibamlvyd7g`:

| key | value |
| --- | --- |
| `TENANT_ID` | `titanium` |
| `CP_URL` | `https://api.titanium.bot` |
| `CP_SESSION_SECRET` | the key derived for `titanium`, not the master |

That third one is the whole design in one line. Each tenant is given a key derived from the master
and its own name, so whoever can read that container's environment can sign a session for that
tenant and for nothing else. Derive it on the R750, where the master already is, and read it
straight into the Coolify field:

    ssh dell-remote
    cd /home/sem/titanbot
    node -e 'import("./ui/session-token.mjs").then(m => console.log(m.tenantSessionSecret(process.env.M, "titanium")))' \
      M="$(grep '^CP_SESSION_SECRET=' cp.env | cut -d= -f2-)"

Set the three through the Coolify environment api (`POST /services/{uuid}/envs`, and `PATCH` on the
409 if a key is already there), then **push the compose as well**. That second half is not optional
and it is the part that is easy to miss:

> **An environment value a compose file does not name never reaches the container.** Coolify writes
> a resource's environment values into the `.env` it reads the compose with. A compose service gets
> what its own `environment:` block lists and nothing else. `deploy/coolify/docker-compose.yml`
> names all three as `${VAR}` for exactly this reason, so setting the values in Coolify is enough
> **once the stored compose is the current one**. Measured here on 2026-09-07: setting the three
> values alone changed nothing at all, and the relay came up saying `tnnt not a tenant`.

Then restart the service. Two things about that restart, both of which have bitten this stack
before:

- **Wait for a quiet window.** A restart recreates both containers. Do not do it while an agent is
  mid-turn. `ship-r750.sh quiet` is the check.
- **Copy-in makes the recreate safe**, and the box takes a minute to finish it. Poll the
  containers' `StartedAt` and give it 60 seconds before running any gate against the instance.

His relay password keeps working through all of it, and the tenant gate is what proves that rather
than a hope.

**Measured on the R750, 2026-09-07.** Adopt answered
`titanium now points at Coolify service p927bfqm83ioloibamlvyd7g on console.titanium.bot` and
`nothing on that service was changed`, and the row read `adopted`. The three environment values were
created (201 each), the compose was pushed, and the restart recreated both containers inside one
second of each other. The relay's boot line then read:

    tnnt titanium, accounts sign in through https://api.titanium.bot
    state /app/ui (beside the code, SAND_UI_STATE_DIR is unset)

That second line is the one to check on his instance. `SAND_UI_STATE_DIR` is deliberately **not**
set there: his `auth.json` lives beside the code, and moving the default without moving the file
would bring the relay up with no password at all.

`node scripts/verify-deploy.mjs --url https://console.titanium.bot` then passed **56 of 56**, with
the password door among them, so tenant mode cost him nothing. It failed twice on the first attempt
after the restart, both on the roster, because the box had not finished loading its agents yet;
ninety seconds later it was clean. Wait for the box, not just the container.

## 7. Add an account

    node cp/cli.mjs account add owner@acme.example acme --name "A Business Owner"

It asks for the password on the terminal, twice, with the echo off. It does not take one as an
argument, because an argument is in the shell history and in `ps`. The tenant has to exist first,
or the answer says so in a sentence: an account whose instance does not exist is an account that
signs in and lands nowhere.

To reset one later: `POST /v1/accounts/{id}/password`. There is no self-service reset yet, and no
email is sent by this service at all.

## 8. Add a tenant

Building a new instance is on, and `deploy/r750/control-plane-coolify.mjs` sets
`CP_ALLOW_NEW_TENANTS=1` when it stands the service up. It was off through TENANT-1 because a
customer's console would have read the operator's `endpoints.json` out of the shared `ui`
directory, which is where the provider API keys are. TENANT-2 gave every tenant its own settings
directory, which is the condition that gate was about. Section 12 has the detail.

To turn it off again, set `CP_ALLOW_NEW_TENANTS=0` on the control plane resource. The answer while
it is off says so:

    409 {"error":"new_tenants_off","message":"New customer instances are turned off. ..."}

A rehearsal (`--dry-run`) and an adopt both work either way, and so does finishing a build that had
already started.

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
5. **envs** `TITANBOT_GATEWAY_TOKEN` and `CP_SESSION_SECRET`, which live in Coolify's environment
   store rather than in the compose text. The `CP_SESSION_SECRET` written here is **this tenant's
   own derived key**, never the master. It is a `POST` that falls back to a `PATCH` on a 409:
   Coolify reads the compose when it creates a service and makes an empty field for every `${VAR}`
   in it, so both of these fields already exist and only a `PATCH` fills them. Measured 2026-09-07,
   and it is what failed the first real tenant build:
   `409 Environment variable already exists. Use PATCH request to update it.`
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
is the ledger row plus whatever Coolify says right now. One thing to know about that, measured on
the R750's Coolify 4.0.0 on 2026-09-07: `GET /services/{uuid}/applications`, which the openapi
documents as the place a container status lives, answers `404 {"message":"Not found."}` on that
build, the same way the per-component PATCH did in DOMAIN-1. What it does return is a service
object richer than the documented one: a service-level `status` like `running:unknown`, a
`server_status` boolean, and an inline `applications` array of `{uuid, name, fqdn, status}` per
container. So the service object is read first and the sub-route is only asked when that object
carries nothing, and an answer in a shape nobody recognises is reported as unknown rather than as
stopped.

## 9. Stop, start, restart, delete

    POST /v1/tenants/{slug}/stop        POST /v1/tenants/{slug}/start
    POST /v1/tenants/{slug}/restart

All three are passed through to Coolify and all three are queued, not immediate. A restart recreates
both containers, which is fine and is what the copy-in on the box start is for.

    DELETE /v1/tenants/{slug}
    {"confirm": "acme"}

It only works when the tenant is stopped, and only with the slug repeated in the body. It deletes
the Coolify service.

**Not on an adopted instance.** A tenant this service did not build is not this service's to delete
or to rebuild, so `DELETE /v1/tenants/{slug}` and `POST /v1/tenants/{slug}/provision` both answer
`409 {"error":"adopted"}` on one. On `titanium` those two calls would have been the live
`console.titanium.bot`: the delete would have handed its Coolify service to Coolify's own delete,
and the provision would have built a second stack beside it, with a second container carrying the
`com.titanbot.role=box` label the relay resolves its box by, and rewritten the hostname to
`titanium.titanium.bot`, which does not exist. Stopping it first is not a way around either one: an
adopted row keeps saying `adopted` through a stop, because that is how it got here and not a
container state. Remove it in Coolify if that is really what you want.

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
# On the Mac, then on the R750, then on the Mac again. Section 5 is these three with the reasoning.
bash deploy/r750/sync.sh --no-install
ssh dell-remote bash /home/sem/titanbot/deploy/control-plane-install.sh
node deploy/r750/control-plane-coolify.mjs --dry-run && node deploy/r750/control-plane-coolify.mjs
curl -s https://api.titanium.bot/v1/health

export CP_PUBLIC_URL=https://api.titanium.bot
export CP_ADMIN_TOKEN="$(ssh dell-remote "grep '^CP_ADMIN_TOKEN=' /home/sem/titanbot/cp.env | cut -d= -f2-")"

# 1. claim Jason's own instance, without touching it
node cp/cli.mjs tenant adopt titanium p927bfqm83ioloibamlvyd7g console.titanium.bot

# 2. an account on it. Run this ON the R750 so the password is typed on the machine that keeps its
#    hash. It asks twice and echoes neither. Section 17.
ssh dell-remote      # then: cd /home/sem/titanbot && node cp/cli.mjs account add ... titanium

# 3. put that instance in tenant mode: TENANT_ID=titanium, CP_URL and its own derived
#    CP_SESSION_SECRET on Coolify service p927bfqm83ioloibamlvyd7g, AND push the current compose
#    (an environment value the compose does not name never reaches the container), then a restart
#    in a quiet window. His relay password keeps working through it. Section 6.

# 4. rehearse a customer
node cp/cli.mjs tenant add acme "Acme Roofing" --dry-run

# 5. build them. It prints the relay password once. Write it down.
node cp/cli.mjs tenant add acme "Acme Roofing"

# 6. their people
node cp/cli.mjs account add owner@acmeroofing.com acme --name "The Owner"

node cp/cli.mjs tenant list
node cp/cli.mjs account list
```

## 11. What the customer sees

They go to `https://acme.titanium.bot`, they get a sign-in page, they type the email address and
password you gave them, and they are in their own console with their own agents. No relay password,
no tailnet, no shared login. They never see the control plane and they never see a tenant name.

While an instance is still coming up, signing in works and their console says the machine is
starting. That is the honest answer and it is better than a login that hangs.

The relay password still exists on every instance and still works. It is the operator's way in when
the control plane is down, not something a customer is ever given.

## 12. What TENANT-2 changed, on the relay side

TENANT-1 built the control plane and defined the token. TENANT-2 is the relay learning to accept
it, plus the two things that had to be true first: a tenant writes its own files, and a tenant is
not root on the host.

Nothing in sections 1 to 11 changed. The token this service mints is the token the relay verifies.

### The sign-in page

A relay is in **tenant mode** when all three of `TENANT_ID`, `CP_URL` and `CP_SESSION_SECRET` are
set. The control plane renders those into every tenant's compose. Jason's instance was given them
by hand, once, because it was adopted rather than built.

Without tenant mode the page is exactly what it was: one password box.

In tenant mode the page gains an email field above it. One form, one button:

    Sign in with your Titanium Bot account
      [ email ]
      [ password ]
    or the instance password
      [ password ]

With an email filled in, the relay posts `{email, password}` to `CP_URL/v1/sessions` with a 15
second timeout, and never logs the password. What comes back decides:

| answer | what the relay does |
| --- | --- |
| 200, token names **this** tenant | verify it with this relay's own `CP_SESSION_SECRET`, mint the session cookie, in you go. The cookie lives as long as the token's `exp`, or the relay's own limit, whichever is shorter |
| 200, token names **another** tenant | 302 to `https://<that tenant's host>/login?sso=<token>`. That is a person who typed the wrong address, and sending them to their own console is more useful than refusing them |
| 401 | "That email or password is not right." |
| the control plane cannot be reached | "Titanium Bot sign-in is not answering right now. The instance password still works." |

`GET /login?sso=<token>` is the other end of that redirect. The relay checks the signature, the
expiry and that the `tenant` claim is its own, mints the session and sends you to `/`. A token that
fails any of those three shows the sign-in page with "That sign-in link is not valid here."

Three things it deliberately does not do. It never stores the control plane's token, only its own
cookie. It never calls the control plane for anything but a sign-in. And the console header shows
nothing new: signing in with an account looks the same as signing in with the password, which is
the point.

The lockout counts email attempts the same way it counts password attempts, keyed on the visitor's
address, so the account door is not a way around the door beside it.

Logging out works as it always did.

### Where a tenant's files go

`SAND_UI_STATE_DIR` is the one setting that moves all of them. When it is set, every file the relay
writes defaults under it, and each of the older, single-file settings still wins if it is set:

| file | its own setting, which still wins |
| --- | --- |
| `auth.json` | `SAND_UI_AUTH_FILE` |
| `endpoints.json` | `SAND_UI_ENDPOINTS_FILE` (new in this wave) |
| `subscriptions.json` | `GROK_BOT_SUBSCRIPTIONS_FILE` |
| `mail.json` | `GROK_BOT_MAIL_FILE` |
| `mail-inbox.jsonl` | `GROK_BOT_MAIL_LEDGER_FILE` |

Files written there are given the owner of the directory they land in, the same way the relay
already does for the files it writes beside its own code. That habit exists because the relay runs
as root in its container, and a root-owned settings file breaks the operator's own backup.

Unset, nothing changes. Jason's instance kept writing exactly where it was writing.

This is the change that unblocks building a second instance. The old blocker was that every tenant
relay mounted the operator's shared `ui` directory and read `endpoints.json` out of it, and that
file holds the provider API keys. Now a tenant reads its own.

### What a tenant does not have, because it has no docker socket

The control plane renders a tenant's compose **without** `/var/run/docker.sock`. A socket in that
container is root on the R750, which is every other customer's files, the account store and the
Coolify api key. Jason's own stack still has one, because it was not rendered by the control plane
and because the model picker and the desktop buttons on his instance reach the box with
`docker exec`.

So a tenant relay has to come up and stay useful with no docker at all. One helper,
`dockerAvailable()`, probes once and remembers, and every surface that used to shell out answers in
plain words instead of hanging or returning a 500 with nothing in it:

| surface | on a tenant |
| --- | --- |
| `POST /endpoints/use` | `409 {"error":"not_available","detail":"This instance cannot switch models from the console yet."}` |
| the desktop frame | "The desktop view is not available on this instance yet." |
| the runtime bundle at `/runtime/<token>` | served from the mounted runtime directory, so the host can still upgrade itself |
| everything else | a quiet absence rather than an error |

The offline dashboard gate still passes, which is the check that this did not change the console
for Jason.

**To be measured** by the integrator: the exact list of surfaces that came back as a refusal versus
a quiet absence, and whether the runtime bundle route needed docker after all.

## 13. The gate

    node scripts/verify-control-plane.mjs

It starts the control plane itself on a free port, with a throwaway store, a throwaway tenant root
and a fake Coolify that records every call and answers the way the openapi says. Then it walks
health, the admin door, adding an account, minting a session and re-deriving its signature
independently, reading the session back, a tampered token, revoking, a tenant dry run that must
reach neither Coolify nor the disk, an adopt, the two refusals that protect an adopted instance, the
refusal to build a new one while `CP_ALLOW_NEW_TENANTS` is unset, and the reserved and malformed
slugs. The signature leg re-derives the tenant's own key from the master and the tenant name, so a
service that went back to signing under the master fails here rather than in production. The last
leg searches every answer it saw for the session secret, the admin token and the password.

No box, no docker, no network. Exit 0 every leg passed, 1 a leg failed, 2 the server never started,
which is not a pass.

The relay side has its own:

    node scripts/verify-tenant.mjs --url <relay> [--cp <url>]

Without `--cp` it starts a fake control plane of its own, so it needs nothing running. It measures
the sign-in page carrying the email field in tenant mode and not carrying it otherwise, a wrong
email answering in plain words, a right email for this tenant minting a session that opens `/`, a
right email for another tenant answering 302 to that tenant's host with `?sso=`, a valid `?sso=`
signing in, a forged one refused, the instance password still working, and a relay with no docker
answering 409 on `/endpoints/use` while `/` still answers 200. PASS and FAIL lines like the other
gates, and a non-zero exit on any FAIL.

Against the live instances, both of these have to pass and neither is allowed to cost Jason his
own console:

    node scripts/verify-deploy.mjs --url https://console.titanium.bot
    node scripts/verify-tenant.mjs --url https://demo.titanium.bot --cp https://api.titanium.bot

## 14. What counts as a secret here

| secret | where it lives | who sees it |
| --- | --- | --- |
| a customer's password | nowhere. Only the scrypt hash and salt, in the store | nobody |
| `CP_SESSION_SECRET`, the master | the control plane's environment only | operator only |
| a tenant's session key | that tenant's Coolify environment and its relay | that tenant's containers |
| `CP_ADMIN_TOKEN` | the control plane's environment | operator only |
| `COOLIFY_API_KEY` | the control plane's environment, and Coolify | operator only |
| a tenant's gateway token | that tenant's `profile/local-docker-vm.json` at 0600, and Coolify's env store | that tenant's containers |
| a tenant's relay password | that tenant's `state/auth.json` as a scrypt hash | shown once, at creation |

None of them is ever a query parameter, ever in a log line, or ever in an answer. The last leg of
the gate is there to keep that true after the next route is added.

## 15. An instance without the docker socket

TENANT-2 item 4. A tenant's compose is rendered without `/var/run/docker.sock`, so its relay has no
docker at all. Four console features reach the box with `docker exec` and therefore cannot work
there. They are absent on purpose, and they say so.

One probe decides, `dockerAvailable()` in `ui/docker-edge.mjs`. It runs `docker version --format
{{.Server.Version}}` once, on the relay's own boot, and remembers the answer, so a cold start with
twenty requests on it shells out once rather than twenty times. It asks for the SERVER version
because plenty of machines carry the client and cannot reach a daemon, and "the binary is
installed" is not the question. A relay that answers no prints one line in its log:

    box  no docker on this relay, so the model picker, the connectors editor and the desktop view
         say so rather than failing

What each route does when the answer is no. Every refusal is the same body, `{"error":
"not_available", "detail": "<a sentence>"}`, and 409 rather than 503, because nothing is
temporarily down: the instance does not carry the feature and a retry will not change that.

| route | answer | the sentence the console shows |
| --- | --- | --- |
| `POST /endpoints/use` | 409 | This instance cannot switch models from the console yet. |
| `GET /box/surface`, `POST /box/launch` | 409 | The desktop view is not available on this instance yet. |
| `GET /connectors`, `POST /connectors` | 409 | This instance cannot edit connectors from the console yet. |
| `GET /runtime/<token>/…tgz` | 409 | This instance cannot build a host update of its own. |
| `GET /endpoints` | 200, plus `liveNote` and `switchable: false` | This instance does not report which model is answering yet. |
| `GET /model` | 200 with nulls, plus `note` | the same sentence |

The last two answer rather than refuse on purpose. The console asks for both on every page load, and
a refusal in that position is an error badge on a page that is working perfectly well. What they
must not do is present an unknown live row as a configured one, which is what a bare null did.

The host bundle is the one place where the split is not obvious. The version file at
`/runtime/<token>/sand-host-bundle-latest.version` is read straight off the mounted runtime
directory and answers on every instance. The tarball genuinely needs docker: the archive is composed
INSIDE the box from the box's own `/home/box/sand-host`, because the in-box supervisor prunes every
entry the archive did not carry, and a tarball built anywhere else would delete the parts of the
bundle that come from the image. So a tenant's box does not self-upgrade its host; it gets the host
its image was deployed with. Read `ui/host-bundle.mjs` for the layout rules behind that.

The desktop pane deserves a word, because half of it would technically still work. `/vnc/<display>/`
proxies the box's own noVNC over the compose network and needs no socket at all, so the picture
would come through. What does not come through is putting anything ON that picture: finding a
window, raising it and starting Chrome or a terminal are all `docker exec`. A pane showing an empty
screen with buttons that do nothing is the failure this whole item exists to stop, so the console
puts the sentence in the pane instead of the frame.

### The two box repairs, and where they happen now

Two repairs used to run from OUTSIDE the box, from the relay's start command, through the socket
(`deploy/coolify/init-box.sh`). On a tenant there is no socket, so neither happened, and the script
died with a `FAILED:` line at the top of every customer's log, one line above the correct sentence
saying this console has no docker. That reads as a broken deploy and is not one.

| repair | where it happens | on a tenant |
| --- | --- | --- |
| sqlite3, which `learn-from-demonstration` needs to read Chrome's history database | the box's own entrypoint, in the background, swallowing its own failures | yes, since 2026-09-07 |
| `apply-start-window-fix.sh`, which edits `/usr/local/bin/start-window` inside the box | `init-box.sh` and `deploy/r750/install.sh`, both of which need the socket | no |
| `init-box.sh` itself, on an instance with no socket | one plain sentence, exit 0 | says "this instance runs its box repairs from its own container, not from here" |

The sqlite3 loss was measured: on the R750, 2026-09-07, `command -v sqlite3` answered on the
operator's box and reported MISSING on the demo tenant's. It moved into the box's entrypoint
because that runs inside the container and needs no socket at all. It is backgrounded and every
failure is swallowed into one line on stderr, because a box whose job is to boot must not be held
up, or stopped, by a package that is a nice-to-have.

The start-window repair is still socket-only, and on the same day it measured as a no-op on both
boxes: `/usr/local/bin/start-window` was md5 `d69219afc86a297d16bee3d97b120095` on the demo tenant's
box and on the operator's. So a tenant is not missing anything today. What it is missing is a
mechanism, and the honest place for that is the box image rather than a patch applied from outside
it. Until that lands, a tenant whose box needs the window repair has no way to get it.

### Where a tenant may point a provider endpoint

`POST /endpoints` saves a base URL, and the health probe behind `GET /endpoints` then fetches
`<baseUrl>/models` with the API key saved beside it and hands back the status, the latency and the
model list. On the operator's own instance that is a feature: it is his machine and the box next
door is a legitimate endpoint. On a tenant it is a request generator inside the R750's private
network, aimed by whoever holds that customer's session, with an `Authorization` header they chose.

Measured from a signed-in tenant session, 2026-09-07, before the guard: `http://192.168.32.3:7777`
answered HTTP 401 (the relay itself), `http://titanbot-box:1340` HTTP 404 (the box gateway),
`http://192.168.32.1:8000` refused (the host) and `http://titanbot-cp:7790/v1` timed out
(off-network). Four answers that far apart are a working port scan.

So on a tenant, and only on a tenant, a base URL has to be `https://` and has to resolve to a public
address. Every address a name resolves to is checked, not the first. The refusals are the sentences
the console shows on the endpoint row:

| what was sent | the sentence |
| --- | --- |
| an address inside this machine's networks, by literal or by name | That address is inside this server's own network, so it cannot be used here. |
| `http://` | Endpoints on this instance have to start with https:// |
| a host name nothing answers for | That host name could not be looked up, so nothing can be saved for it. |
| not a URL at all | That is not a web address. It should start with https:// and then the host name. |

The blocked set is wider than RFC1918: `100.64/10` (carrier NAT, and every tailnet address),
`169.254/16` (link local, where cloud metadata services sit), `0.0.0.0/8`, `198.18/15`, multicast
and the v6 unique-local and link-local ranges. `ui/auth.mjs`'s `isPrivateAddress` is the list. The
one thing this does not close is a name whose DNS answer changes between the check and the fetch;
closing that means pinning the resolved address into the connection, which node's `fetch` has no
supported way to do.

Everything else on a tenant is unchanged. The console loads, the gateway answers, and the job bus,
mail and subscriptions all work: none of those goes through the socket.

## 16. The tenant gate

    node scripts/verify-tenant.mjs
    node scripts/verify-tenant.mjs --url https://demo.titanium.bot --cp https://api.titanium.bot

With no `--url` it needs nothing at all: it starts a FAKE control plane, then three relay copies of
its own, each with an empty directory as its `PATH` so `docker` is genuinely not findable. One copy
is in tenant mode against the fake plane, one has no tenant environment (the control that proves the
email field appears BECAUSE of tenant mode rather than always), and one is in tenant mode pointed at
a dead port (the control plane that is not answering). It mints and forges its own session tokens
with `node:crypto` from the contract's description, never by importing the module under test, so a
signature that verifies inside the process and not on the wire fails here rather than on the day a
customer signs in.

Two suites, and `--only login` or `--only docker` runs one:

- **login**: the page carries an email field in tenant mode and not otherwise; a wrong email gets
  the plain sentence; the right email for this tenant mints a session that opens the console; the
  right email for ANOTHER tenant is a 302 to that tenant's own host with `?sso=`, signed with THAT
  tenant's key; the link signs in; an expired one, another tenant's one and a forged one are all
  refused; the instance password still works; a control plane that is not answering says so and the
  instance password still gets in; the relay called the plane for sign-in and nothing else; neither
  password is anywhere in the relay's log; and a run of wrong emails hits the same lockout a run of
  wrong passwords does.
- **docker**: the table in section 15, leg by leg, plus the console answering 200 underneath the
  refusals and the version file being served while the tarball is refused.

Against a live instance, the legs that need a credential run only when one is given, in the
environment rather than on the command line: `TENANT_GATE_EMAIL`, `TENANT_GATE_PASSWORD`,
`TENANT_GATE_OTHER_EMAIL`, `TENANT_GATE_OTHER_PASSWORD`, `TENANT_GATE_RELAY_PASSWORD`. A leg with no
credential prints `SKIP` with its own name and the reason, and the run says how many were not
measured. A gate that quietly shrinks is a gate nobody reads.

Exit 0 no leg failed, 1 a leg failed, 2 nothing could be measured, which is not a pass.
## 17. Adding a customer, and adding yourself

A customer is two things: an instance, and a person who can sign in to it. In that order, because
an account whose instance does not exist signs in and lands nowhere, and the control plane refuses
that on purpose.

    export CP_PUBLIC_URL=https://api.titanium.bot
    export CP_ADMIN_TOKEN=...        # from cp.env on the R750

    # 1. the instance. Rehearse it first: this reads and renders everything and creates nothing.
    node cp/cli.mjs tenant add acme "Acme Roofing" --dry-run
    node cp/cli.mjs tenant add acme "Acme Roofing"

    # 2. the person. It asks for the password on the terminal, twice, with the echo off.
    node cp/cli.mjs account add owner@acmeroofing.com acme --name "The Owner"

Step 1 prints the relay password once and nothing can print it again. Write it down or throw it
away on purpose: it is the back door for that instance, not the customer's credential. The customer
never needs it.

Step 2 does not take a password as an argument, ever. An argument is in the shell history and in
`ps` output and in the scrollback of whoever is watching.

Then hand the customer two things: `https://acme.titanium.bot` and their email address. They set
nothing up, they install nothing, and they never hear the word tenant.

Adding more people to the same instance is step 2 again with a different address.

### Your own account

Jason's instance is the tenant `titanium`, adopted rather than built. Give yourself an account on
it the same way, and run it **on the R750** so the password is typed on the machine that stores its
hash and is seen by nobody in between:

    ssh dell-remote
    cd /home/sem/titanbot
    export CP_ADMIN_TOKEN="$(grep '^CP_ADMIN_TOKEN=' cp.env | cut -d= -f2-)"
    node cp/cli.mjs account add jason@webdevtoday.com titanium --name "Jason Brashear"

It prompts for the password twice and echoes neither. From then on `https://console.titanium.bot`
takes that email and password.

The relay password on that instance keeps working too, and that is deliberate: it is the way in
when the control plane is down, and it is the way in from the tailnet.

## 18. The demo tenant

There is a real customer instance on the R750 that belongs to nobody, called `demo`. It exists so
that the thing being described here can be shown rather than explained, and so the first real
customer is not the first time any of it ran.

    slug            demo
    console         https://demo.titanium.bot
    coolify service g9n30z67ddxks4a22o9e152z
    account         demo@titanium.bot
    password        DEMO_PASSWORD in /home/sem/titanbot/cp.env, mode 0600

The password is generated and written straight to that file so nobody has to read it out in a chat
window. To use it:

    ssh dell-remote "grep '^DEMO_PASSWORD=' /home/sem/titanbot/cp.env | cut -d= -f2-"

It is a real instance with a real box, not a mock, so treat it the way you would treat a customer's:
do not put anything in it you would not put in theirs.

**Measured on the R750, 2026-09-07.** From the provisioning call to both containers reporting
running: **61 seconds**, polled every 20 seconds. The box image was already on the machine, so that
number is a start and not a pull; the first tenant on a fresh server will be slower by whatever the
pull costs. `https://demo.titanium.bot/login` answered 200 on the first request after that, with no
wait for a certificate, because the wildcard `*.titanium.bot` was already in place.

The three things the browser proved, from this Mac (Darwin 25.5.0) with playwright-core 1.62.1
driving the real Chrome headless, 14 checks, 0 failing. It is a script rather than a session, so it
can be run again:

    DEMO_PASSWORD="$(ssh dell-remote "grep '^DEMO_PASSWORD=' /home/sem/titanbot/cp.env | cut -d= -f2-")" \
      node scripts/verify-tenant-browser.mjs

It exists beside `scripts/verify-tenant.mjs` and not inside it because the HTTP gate is the right
tool for status codes, headers and copy, and cannot tell you a person can sign in: a form posting
the wrong field name, a button that is not a submit and a redirect a browser will not follow all
answer 200 to curl.

**Run the gates one at a time, a minute apart.** The relay's login throttle is five failures per
address per 30 seconds, the account door and the password door share it, and `verify-deploy`,
`verify-tenant` and this script all fill it on purpose. Run them back to back from one Mac and the
next one is measuring its own lockout. Every gate here says so by name when it hits that, rather
than failing as though the product were broken, but the cure is to wait.

1. `https://demo.titanium.bot/login` shows the email field and the sentence above it.
2. Signing in as `demo@titanium.bot` lands on `/` with a session cookie of that instance's own, and
   the roster draws a card from that instance's own box.
3. Signing in as `demo@titanium.bot` at `https://console.titanium.bot/login` redirects to
   `demo.titanium.bot` and lands signed in there, which is the wrong-address case from section 12.
   A wrong password gets `That email or password is not right.`, no status code, no session.

One thing to know before showing it to anybody: **the agent on a brand new instance is called
"New Bot"**, not Titan. That is `SAND_DEFAULT_AGENT_NAME` in `source/shared/agents/agents.ts` and it
is upstream's name for an agent nobody has named yet. Titan is the name Jason gave his own. A
customer's first screen therefore says "New Bot", which is a copy decision nobody has made rather
than anything tenancy did.

And the gates afterwards, because none of this is allowed to cost Jason his own instance:

    node scripts/verify-deploy.mjs --url https://console.titanium.bot
    # 56 PASS / 0 FAIL / 2 inconclusive, with his instance in tenant mode

    node scripts/verify-tenant.mjs --url https://demo.titanium.bot --cp https://api.titanium.bot
    # 26 PASS / 0 FAIL / 7 SKIP, each skip named

    node scripts/verify-mail.mjs --url https://demo.titanium.bot
    # 16 PASS / 0 FAIL, read-only, with the demo bearer from its own profile directory
    # (SAND_HOST_GATEWAY_TOKEN, read over ssh from /data/titanbot/demo/profile/local-docker-vm.json)

    node scripts/verify-tenant-browser.mjs
    # 14 PASS / 0 FAIL, the three customer journeys in a real browser

The seven skips are the legs that need something this run did not have: a relay the gate starts
itself (three of them), a second tenant's account, this tenant's relay password, and the fake
control plane's own recorder. Each prints its own name and reason. A gate that quietly shrinks is a
gate nobody reads.

The deploy gate failed twice on the first run after the restart, both times on the roster
(`no .worker-card[data-context-id] after 30 s`). That was the box still coming up: the gateway had
loaded no agents yet. Ninety seconds later the same gate passed 56 of 56. **Wait for the box, not
just the container**, before believing a gate run after a recreate.
