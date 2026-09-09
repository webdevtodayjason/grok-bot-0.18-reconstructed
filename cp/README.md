# The control plane

One small service that knows three things: who the customers are, which instance each of them
belongs to, and how to ask Coolify for a new instance. Everything a customer sees on the way in
goes through it, and nothing else in this repo holds an account list.

It is Node with no npm dependencies. `node:sqlite` is the store, `node:crypto` does the password
hashing and signs the session tokens, `node:http` serves the api. That is the whole dependency
list, which is why the image in `cp/Dockerfile` is a base image and a `COPY`.

A customer signs in here with an email address and a password. What they get back is a session
token that names their tenant, signed with a secret their tenant's relay also holds, so the relay
can let them in without ever seeing the password. That relay side is the next wave. This one
defines the token it will verify.

Files:

| file | what it is |
| --- | --- |
| `cp/server.mjs` | the http api, and the only thing that listens |
| `cp/session.mjs` | a re-export of `ui/session-token.mjs`, which is where mint and verify live |
| `ui/session-token.mjs` | the token itself. It sits in `ui/` because that is the half that ships to every tenant relay, and both sides import the one file |
| `cp/store.mjs` | the sqlite store: accounts, tenants, revoked sessions, provisioning steps, login failures |
| `cp/provision.mjs` | the steps that turn a slug into a running instance on Coolify |
| `cp/cli.mjs` | the operator's commands, over http, against a running server |
| `cp/Dockerfile` | the image. Build from the repo root, not from here |
| `deploy/coolify/control-plane.compose.yml` | how it runs on the R750 |
| `docs/TENANCY.md` | the operator flow: deploy it, adopt Jason's instance, add a customer |
| `scripts/verify-control-plane.mjs` | the gate |

## Run it here first

Everything below is throwaway. A temporary store, a temporary tenant root, secrets generated on
the spot, and a Coolify url that points at nothing.

    export CP_PORT=7790
    export CP_DATA_DIR="$(mktemp -d)"
    export CP_TENANT_ROOT="$(mktemp -d)"
    export CP_SESSION_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
    export CP_ADMIN_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
    export CP_BASE_DOMAIN=titanium.bot
    export CP_PUBLIC_URL="http://127.0.0.1:$CP_PORT"
    export CP_RELEASE_ROOT=/home/sem/titanbot
    export CP_COOLIFY_URL=http://127.0.0.1:9   # nothing is listening there, and that is the point
    export COOLIFY_API_KEY=not-a-real-key
    export COOLIFY_PROJECT_UUID=local-project
    export COOLIFY_SERVER_UUID=local-server
    export COOLIFY_ENVIRONMENT_NAME=production
    export CP_ALLOW_NEW_TENANTS=1        # off in production. See "Building a new instance" below

    node cp/server.mjs

**Point a local run at the real Coolify only if you mean it.** With `CP_COOLIFY_URL` and
`COOLIFY_API_KEY` set to the live values, a tenant create is a real service on the R750 and a
tenant delete is a real deletion. The url above goes to a closed port, so a local run can only ever
do dry runs, which is what you want while you are reading the output.

The name is `CP_COOLIFY_URL`, not `COOLIFY_URL`: Coolify puts a `COOLIFY_URL` of its own into every
service container, holding that container's public address, and it wins over one an operator sets.
`COOLIFY_URL` is still read when `CP_COOLIFY_URL` is unset, so an older install keeps working.

Then, in a second terminal:

    # counts only, no bearer needed
    curl -s localhost:7790/v1/health

    # an account, through the CLI, which asks for the password rather than taking it as an argument
    node cp/cli.mjs account add owner@example.com acme --name "A Business Owner"

    # sign in the way a customer would
    curl -s localhost:7790/v1/sessions -H 'content-type: application/json' \
      -d '{"email":"owner@example.com","password":"the one you just typed"}'

    # what a new tenant would do, without doing any of it
    node cp/cli.mjs tenant add acme "Acme Roofing" --dry-run

When you are done, the two temporary directories are the only things to remove. Nothing was written
anywhere else.

## The routes

Public, no bearer:

| route | answer |
| --- | --- |
| `GET /v1/health` | `{ok, version, tenants, accounts}`. Counts only. It names nobody |
| `POST /v1/sessions` | `{token, expiresAt, account, tenant}`, or `401 {"error":"invalid_login"}` |
| `GET /v1/sessions/current` | the account and tenant behind a session token |
| `DELETE /v1/sessions/current` | signs that one token out |

Operator only, `Authorization: Bearer $CP_ADMIN_TOKEN`:

| route | answer |
| --- | --- |
| `POST /v1/accounts` | 201, 409 if the email is already there, 400 if the tenant it names does not exist yet |
| `GET /v1/accounts` | the list, without a hash and without a salt |
| `POST /v1/accounts/{id}/password` | 204. An operator reset |
| `POST /v1/tenants` | 201 and provisioning starts, or 409 `new_tenants_off`. `{"dryRun": true}` returns the plan and does nothing |
| `GET /v1/tenants`, `GET /v1/tenants/{slug}` | the ledger row plus Coolify's live state |
| `POST /v1/tenants/{slug}/adopt` | marks an instance that already exists as this tenant |
| `POST /v1/tenants/{slug}/provision` | runs the build again from where it stopped. 409 on an adopted instance |
| `POST /v1/tenants/{slug}/stop`, `/start`, `/restart` | passed through to Coolify |
| `DELETE /v1/tenants/{slug}` | only when it is stopped, and only with `{"confirm":"<slug>"}`. 409 on an adopted instance |

Either door, `Authorization: Bearer $CP_ADMIN_TOKEN` or nothing when `CP_ALLOW_SIGNUP=1`:

| route | answer |
| --- | --- |
| `POST /v1/signups` | `{email, password, company}`. 201 with the account and the workspace, or 403 `signup_closed`, 409 `duplicate_email`, 429 `locked` |

The console relay only, `Authorization: Bearer $CP_RELAY_TOKEN`:

| route | answer |
| --- | --- |
| `GET /v1/relay/tenants` | `{tenants, skipped}`. Per tenant: its box container, its gateway address, its gateway token, its derived session key, its two directories |

## What a tenant is

One container, the sandbox that customer's agents live in, plus one directory on the disk under
`CP_TENANT_ROOT`. There is one relay and one console at `console.titanium.bot` for everybody, and
the relay works out which box a request belongs to from the session. So a customer has no hostname,
nothing about them is public, and adding one is one more container rather than a second copy of
everything. Jason's words for why: "Every time we add somebody new, we're basically duplicating
everything. That sounds crazy."

Every box joins one shared docker network, `CP_SHARED_NETWORK`, made once on the server:

    docker network create titanbot-net

Coolify puts every service on a network of its own, so without that shared one the relay could not
reach anybody. `deploy/coolify/box.compose.yml` is the one-service template, and it declares that
network `external: true` so a deploy neither creates it nor renames it.

## Building a new workspace

`POST /v1/tenants` and `POST /v1/signups` both answer `409 {"error":"new_tenants_off"}` unless
`CP_ALLOW_NEW_TENANTS=1`. Every new customer is another 5.2 GB container on this server, so turning
them on is a decision somebody makes rather than a default. Rehearsals, adopts and finishing a build
that had already started are unaffected.

A build ends by waiting for the box to answer, up to `CP_BOX_READY_TIMEOUT_MS`. A timeout there is
not a failure: the image is large and a server that has never pulled it takes longer than any wait
worth putting a customer through, so the answer says the workspace is still starting and the `ready`
step is recorded as `waiting`, which means the next run waits again instead of assuming.

An adopted instance is one this service did not build. It will not rebuild one and it will not
delete one, and stopping it first does not change that: an adopted row keeps saying `adopted`
through a stop. `tenant adopt` is also how `titanium`, Jason's own instance, gets its box container
name and the directory its gateway token is read from into the registry above.

## Sessions are signed per tenant

`CP_SESSION_SECRET` here is a master. Each tenant relay is given only
`HMAC-SHA256(master, its own name)`, and that is the key that tenant's sessions are signed with. A
key sitting in a container's environment is readable by whatever runs in that container, so a shared
key would let any customer sign a session claiming any tenant. `node cp/cli.mjs session verify
<token>` derives the same key from the master and the tenant the token names.

A wrong email and a wrong password give the same answer, in the same shape, so the api never says
whether an address is a customer. Ten failures in ten minutes, counted per email and per address,
answer `429 {"error":"locked","retryAfter"}` instead.

## The CLI

It talks to a running server over http and reads `CP_ADMIN_TOKEN` from the environment. It never
takes a password as an argument, because an argument is in the shell history and in the process
list.

    node cp/cli.mjs signup add <email> <company> [--name "..."]
    node cp/cli.mjs account add <email> <tenant> [--name "..."]
    node cp/cli.mjs account list
    node cp/cli.mjs tenant add <slug> <name> [--dry-run]
    node cp/cli.mjs tenant list
    node cp/cli.mjs tenant adopt <slug> <coolify-uuid> <host> [--box <container>] [--state <dir>] [--profile <dir>]
    node cp/cli.mjs session verify <token>

`signup add` is the whole of adding a customer in one line: it makes the account, works the
workspace name out of the company name, and builds the box. "Acme Roofing & Sons" becomes
`acme-roofing-sons`, and a second company with the same name gets `acme-roofing-sons-2` rather than
somebody else's workspace. `account add` is the older two-step way, for adding a second person to a
workspace that already exists.

`session verify` prints the payload and says whether it is still good. It is the fastest way to
answer "why is this customer being asked to sign in again".

## The gate

    node scripts/verify-control-plane.mjs

It starts the server itself on a free port with a throwaway store, a throwaway tenant root and a
fake Coolify, and walks: health, the admin door with no bearer and with a wrong one, adding an
account, minting a session and re-deriving its signature independently, reading the session back,
a tampered token, revoking, a tenant dry run that must reach neither Coolify nor the disk, an
adopt, the reserved and malformed slugs, and a sweep of every answer it saw for the session
secret, the admin token and the password.

It needs no box, no docker and no network. Exit 0 means every leg passed, 1 means a leg failed,
and 2 means the server never started, which is not a pass: it is the gate saying it measured
nothing.

## Three things that will bite

**scrypt at N=32768 needs its memory cap raised.** The contract's parameters are N=2^15, r=8, p=1.
Scrypt's working set is 128 * N * r bytes, which is exactly 32 MiB, and node's default `maxmem` is
also exactly 32 MiB, so the call throws before it hashes anything:

    RangeError: Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded

Measured on node v22.23.1: 33554432 (32 MiB) throws, 34603008 (33 MiB) works. Pass
`maxmem: 64 * 1024 * 1024` with every hash and every verify, and pass the same value in both
places, or a verify will fail on a hash that was fine to write. This is also why the relay's own
`ui/auth.mjs` uses N=16384: it fits under the default and never had to think about it.

**Coolify builds an environment field's name from everything inside the braces.** `${CP_ADMIN_TOKEN:?}`
in a compose file becomes a field literally named `CP_ADMIN_TOKEN:?`, which is not a legal name, so
the line is dropped and the deploy fails on a variable no field in the UI can set. Use plain
`${VAR}` and refuse to start in the process instead. `deploy/coolify/docker-compose.yml` hit this
twice before this file existed.

**`node:sqlite` is still experimental.** It imports with no flag on node 22.23 and prints one
`ExperimentalWarning` on the first import. That warning in the container log is normal and is not
a failure. An older 22.x needs `--experimental-sqlite` back, which is why `cp/Dockerfile` pins the
image by digest and writes down the version it measured.

## What never leaves this service

The password, in any form. The scrypt hash and its salt stay in the store and appear in no answer
and no log. `CP_SESSION_SECRET`, `CP_ADMIN_TOKEN` and `CP_RELAY_TOKEN` are read from the environment
and are never written to the store, never returned and never printed.

One route is a deliberate exception and it is the only one: `GET /v1/relay/tenants`, behind
`CP_RELAY_TOKEN`, hands the one console relay each tenant's gateway token and each tenant's DERIVED
session key, because that relay serves every customer and has to reach every customer's box. What
it never hands over is the master those keys are derived from, and holding one tenant's key does
not walk back to the master or sideways to another tenant's. The admin token does not open that
route and the relay token opens nothing else.

There is no relay password any more. Provisioning used to generate one per tenant and show it once,
because each tenant had a console of its own. There is one console for everybody now, so that
password opened nothing, and a credential on disk that looks like a second door and is not one is
worse than none.

**One secret is HELD here, and it is the only one: the GitHub repository token** (FEEDBACK-1). It is
pasted once into the admin console's Feedback panel, proved against the repository before it is
stored, and kept in `admin_settings` under `github.token`. Three rules go with it. `listSettings`
returns it as an empty value with `redacted: true`, so no route that renders the settings can carry
it; only `getSetting` hands it over, to the one caller that files an issue. Every answer and every
ledger row carries `keyEvidence(value)` -- a length and eight hex characters of a digest -- and
nothing else. And it is never pushed into a box: every exec daemon in a customer's container runs as
uid 0, so a super admin's token inside one is readable by that customer's own agents through
`/proc/self/environ`. It is here rather than at the proxy because there is no proxy for a repo token
to hide behind.

The gate's last leg is a search of every response body for those secrets, including the two ways
the registry route can be asked with the wrong credential. Keep it that way when you add a route.

## The image

    docker build -t titanbot-cp:local -f cp/Dockerfile --build-arg UID=1001 --build-arg GID=1001 .

From the repo root, not from this directory: it copies `cp/`, `ui/auth.mjs`, `ui/set-password.mjs`
and `deploy/coolify/docker-compose.yml`. It runs as uid 1001, which is `sem` on the R750, so the
tenant directories it creates are files Jason can read over ssh without sudo. That number is a
build argument because it is a fact about the host rather than about the image: 1001 is what
`id -u sem` answers on the R750, measured on 2026-09-07. It is not 1000, which is what `node` is
inside the base image and what a first login account usually is elsewhere.

On the server, do not run that build by hand. `deploy/r750/control-plane-install.sh` runs it with
the same uid it just gave the tenant root, which is the pairing that has to hold.
