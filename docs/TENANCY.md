# One instance per customer

The decision this implements (Jason, 2026-09-06): every customer gets their own instance and their
own sandbox. Not one console with accounts in it. Their own box, their own relay, their own
workspace, their own agents, on their own hostname.

    titanium.bot                 the marketing site
    console.titanium.bot         Jason's own instance
    <slug>.titanium.bot          one customer

A customer signs in with an email address and a password and lands on their own console. Nothing
they do can reach another customer's instance, because there is no shared instance to reach: the
separation is two containers and a directory tree, not a `WHERE tenant_id = ?`.

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

## 2. What a tenant is, exactly

On Coolify: one service named `titanbot-<slug>`, in the project Titanium Computing, environment
production, on the R750, with two containers in it. Coolify renames the containers to
`<service>-<uuid>`, which is why nothing anywhere looks a container up by name and everything uses
the `com.titanbot.role` label instead.

On the disk, under `CP_TENANT_ROOT` (`/data/titanbot` on the R750):

    /data/titanbot/<slug>/
      profile/local-docker-vm.json     the tenant's gateway token, 0600
      credential/                      the inference placeholder the box needs to start
      state/                           the relay's writable files: auth, subscriptions, job bus, mail
      volumes/workspace/               the agents' files
      volumes/data/                    agents, transcripts, memory
      volumes/store/                   the box store, which is what survives a recreate
      volumes/chrome/                  the browser profile

On DNS: nothing per tenant. `*.titanium.bot` is a proxied wildcard A record to the R750, so
`acme.titanium.bot` resolves the day the tenant is created and Coolify's Traefik gets a certificate
for it on the first request.

The control plane's own sqlite store lives at `/data/titanbot/_control-plane`, under the same root
so one backup covers both. No tenant can ever collide with it: a slug is 3 to 32 characters of
`[a-z0-9-]`, so nothing can start with an underscore.

## 3. Signing in

    POST https://api.titanium.bot/v1/sessions
    {"email": "owner@acme.example", "password": "..."}

    200 {"token": "v1.<payload>.<signature>", "expiresAt": "...",
         "account": {...}, "tenant": {"slug": "acme", "host": "acme.titanium.bot", "status": "running"}}

The token is three parts: the literal `v1`, the payload as base64url JSON, and a base64url
HMAC-SHA256 of the payload part under `CP_SESSION_SECRET`. The payload carries `sub`, `email`,
`tenant`, `host`, `iat`, `exp` and `jti`, and `exp` is twelve hours after `iat`.

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

A wrong password and an email nobody has get the same answer, in the same shape:
`401 {"error":"invalid_login"}`. Ten failures in ten minutes, counted per email address and per
network address, get `429 {"error":"locked","retryAfter":...}` instead. What a person reads is
"That email address and password do not match" and "Too many tries. Wait a few minutes and try
again", in plain words, with nothing in either that says whether the address is a customer.

## 4. Deploy the control plane, once

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

## 5. Adopt Jason's instance as tenant `titanium`

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

## 6. Add an account

    node cp/cli.mjs account add owner@acme.example acme --name "A Business Owner"

It asks for the password on the terminal, twice, with the echo off. It does not take one as an
argument, because an argument is in the shell history and in `ps`. The password is hashed with
scrypt and a per-account salt before it reaches the store, and the hash appears in no route and no
log.

To reset one later: `POST /v1/accounts/{id}/password`. There is no self-service reset yet, and no
email is sent by this service at all.

## 7. Add a tenant

Read the plan first. This does every read and every render and creates nothing:

    node cp/cli.mjs tenant add acme "Acme Roofing" --dry-run

What comes back is the list of calls it would make, in order, with a preview of each body, and the
same plan is written to the ledger as JSON. Read the rendered compose in the create step: the four
data paths should be under `/data/titanbot/acme/volumes/`, the profile and credential paths should
be Acme's, and `runtime`, `deploy` and `ui` should still be the shared `/home/sem/titanbot` ones.

Then, without `--dry-run`, the real thing. Provisioning is four steps. Every one is idempotent and
every one is recorded in the ledger with the answer Coolify gave, so a failure stops on a named
step and `POST /v1/tenants/acme/provision` picks up from there rather than starting over.

1. **The directories.** `profile`, `credential`, `state` and the four `volumes` under
   `/data/titanbot/acme`.
2. **The secrets.** A gateway token, 32 random bytes as hex, written to
   `profile/local-docker-vm.json` in the shape the relay reads (`{"token": "..."}`, the file
   `tokenFromProfile` in `ui/server.mjs` opens). And a relay password, 24 url-safe bytes, written to
   `state/auth.json` through `ui/auth.mjs`, the same routine `ui/set-password.mjs` uses, at mode
   0600. **The relay password is in the answer to this call and nowhere else.** It is not in the
   ledger. If it is lost, reset it rather than looking for it.
3. **The Coolify service.** The compose is rendered from
   `deploy/coolify/docker-compose.yml` with the tenant's paths, `TENANT_ID=acme`, and the tenant's
   own gateway token, then:
   - `POST /services` with the compose base64 in `docker_compose_raw`, name `titanbot-acme`, the
     project, the environment and the server, and `instant_deploy: false`
   - `POST /services/{uuid}/envs` once per variable, including `TITANBOT_GATEWAY_TOKEN`, `CP_URL`
     and `CP_SESSION_SECRET`. Those live in Coolify's environment store, not in the compose text
   - `PATCH /services/{uuid}` with `urls: [{"name":"titanbot-relay","url":"https://acme.titanium.bot:7777"}]`
   - `POST /services/{uuid}/start`

   One thing to watch on the very first real create: the openapi lists `environment_uuid` in the
   required set for `POST /services` alongside `server_uuid`, `project_uuid` and
   `environment_name`. Send both the name and the uuid. If a create comes back 422 naming a
   missing field, that is the field, and `GET /projects/{uuid}/environments` is where the uuid is.
4. **Waiting.** Start is asynchronous. Coolify answers "Service starting request queued." straight
   away, so the status in the ledger is `provisioning` until the containers report running.

`GET /v1/tenants/acme` is the ledger row plus whatever Coolify says right now. One thing to know
about that: the documented Service object has no status field at all. The container states come
from `GET /services/{uuid}/applications`, which the openapi types as an untyped array, so treat a
missing or oddly shaped answer as "unknown" rather than as "stopped".

## 8. Stop, start, restart, delete

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
route sends them explicitly rather than letting the defaults stand, because a tenant's data
directories are bind mounts and Coolify keeps a storage record for each one. Sending nothing and
trusting a default is how "the api never deletes data" would quietly stop being true.

**It does not delete the customer's data, and no route in this api ever will.**
`/data/titanbot/acme` stays exactly where it is: the workspace, the agents, the transcripts, the
store. Deleting a customer's files is a decision a person makes on the server, on purpose, with
`rm -rf` and their own eyes on the path. It is not a thing an api call can do by accident at two in
the morning.

## 9. What the customer sees

They go to `acme.titanium.bot`, they get a sign-in page, they type the email address and password
you gave them, and they are in their own console. No relay password, no tailnet, no shared login.
The console is the same one Jason uses, on their own instance, with their own agents in it.

While an instance is still coming up, signing in works and their console says the machine is
starting. That is the honest answer and it is better than a login that hangs.

## 10. What the relay wave adds next

This wave defines the token. The relay side of it is TENANT-2 and is next:

- `SAND_UI_STATE_DIR`, so the relay's writable files (`auth.json`, `subscriptions.json`, the job bus
  token, mail) come out of the tenant's `state/` directory instead of out of `/app/ui`. That is what
  finally lets the shared `ui` mount be read-only for tenants, and until it lands the rendered
  compose says so in a comment rather than pretending otherwise.
- The relay accepting a control plane session in place of its own password: verify with
  `verifySessionToken` from `cp/session.mjs` against the `CP_SESSION_SECRET` it is given, check the
  `tenant` claim matches its own `TENANT_ID`, and refuse a token minted for somebody else even
  though the signature is good. That last check is the one that matters, because a valid session for
  another tenant is the only way one customer could ever reach another's console.
- Jason's own instance keeps its relay password as well, because it is adopted rather than built and
  he signs in from the tailnet too.

## 11. The gate

    node scripts/verify-control-plane.mjs

It starts the control plane itself on a free port, with a throwaway store, a throwaway tenant root
and a fake Coolify that records every call and answers the way the openapi says. Then it walks
health, the admin door, adding an account, minting a session and re-deriving its signature
independently, reading the session back, a tampered token, revoking, a tenant dry run that must
reach neither Coolify nor the disk, an adopt, and the reserved and malformed slugs. The last leg
searches every answer it saw for the session secret, the admin token and the password.

No box, no docker, no network. Exit 0 every leg passed, 1 a leg failed, 2 the server never started,
which is not a pass.

## 12. What counts as a secret here

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
