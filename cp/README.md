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
    export COOLIFY_URL=http://127.0.0.1:9   # nothing is listening there, and that is the point
    export COOLIFY_API_KEY=not-a-real-key
    export COOLIFY_PROJECT_UUID=local-project
    export COOLIFY_SERVER_UUID=local-server
    export COOLIFY_ENVIRONMENT_NAME=production
    export CP_ALLOW_NEW_TENANTS=1        # off in production. See "Building a new instance" below

    node cp/server.mjs

**Point a local run at the real Coolify only if you mean it.** With `COOLIFY_URL` and
`COOLIFY_API_KEY` set to the live values, a tenant create is a real service on the R750 and a
tenant delete is a real deletion. The url above goes to a closed port, so a local run can only ever
do dry runs, which is what you want while you are reading the output.

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

## Building a new instance

`POST /v1/tenants` answers `409 {"error":"new_tenants_off"}` unless `CP_ALLOW_NEW_TENANTS=1`. A
tenant relay mounts the operator's shared `ui` directory read-only, and the relay still reads
`endpoints.json` from beside its own code, which is where the provider API keys are. Until the relay
reads that file from the tenant's own state directory, a second customer's console could read the
first one's keys. Rehearsals, adopts and finishing a build that had already started are unaffected.

An adopted instance is one this service did not build. It will not rebuild one and it will not
delete one, and stopping it first does not change that: an adopted row keeps saying `adopted`
through a stop. On `titanium` those two calls would have been `console.titanium.bot`.

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

    node cp/cli.mjs account add <email> <tenant> [--name "..."]
    node cp/cli.mjs account list
    node cp/cli.mjs tenant add <slug> <name> [--dry-run]
    node cp/cli.mjs tenant list
    node cp/cli.mjs tenant adopt <slug> <coolify-uuid> <host>
    node cp/cli.mjs session verify <token>

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
and no log. `CP_SESSION_SECRET` and `CP_ADMIN_TOKEN` are read from the environment and are never
written to the store, never returned and never printed. The master session key never reaches a
tenant at all: what goes into a tenant's Coolify environment is that tenant's derived key. A tenant's gateway token goes to Coolify's
environment store and to the tenant's own profile file, and nowhere else. A tenant's relay password
is shown once, in the answer to the create that generated it, and is not kept in the ledger: if it
is lost, reset it rather than looking for it.

The gate's last leg is a search of every response body for three of those. Keep it that way when
you add a route.

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
