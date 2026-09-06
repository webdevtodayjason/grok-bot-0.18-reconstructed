# The console on the domain, inside Coolify

The decision this implements (Jason, 2026-09-04): the Machine Room goes public on the domain with
the relay's password as the only lock. No Cloudflare Access, no IP allowlist, and it runs as a
Coolify resource rather than as hand-run containers.

The domain is a variable because it has been typed both ways. Everything below uses `$DOMAIN`:

    DOMAIN=tb.semfreak.dev        # or tc.semfreak.dev, if that is the one Jason meant

Same host, same volumes, same box. What changes is who owns the containers (Coolify, not
`install.sh`), where the port is (nowhere: only Traefik reaches the relay), and who can knock on
the door (anyone).

## 1. The DNS record (done through the Cloudflare API, not on this server)

Measured 2026-09-04 against 1.1.1.1:

| name | answer today | what it means |
| --- | --- | --- |
| `tb.semfreak.dev` | `100.110.83.82` | a DNS-only A record to the tailnet address. Unroutable from the internet. |
| `tc.semfreak.dev` | `104.21.46.39`, `172.67.223.39` | no record of its own; the proxied `*.semfreak.dev` wildcard answers. |
| `artifacts.semfreak.dev` | the same pair | a subdomain already served this way, with a valid Cloudflare edge certificate. |

So there are two ways to make `$DOMAIN` reach the R750, and exactly one of them is needed:

- **If `$DOMAIN` is `tb`:** either change the A record to `66.90.191.45` **proxied**, or delete the
  record entirely and let the proxied wildcard answer. Deleting is the smaller change and gives the
  same result.
- **If `$DOMAIN` is `tc`:** nothing to do. The wildcard already answers it, proxied, at the R750.

Leaving the tailnet record in place is the one thing that cannot work: Traefik never sees the
request, because the name resolves to an address the internet cannot route.

## 2. Before the first deploy

**Start on the Mac, not the server.** Everything the compose file mounts and everything the commands
below call lives in `/home/sem/titanbot`, and what is there right now is older than this repo. Two
things break if you skip this:

- `/home/sem/titanbot/deploy/uninstall.sh` on the server today does not know `--keep-tree`. It
  exits 2 with `unknown flag: --keep-tree` before doing anything, and the obvious recovery, dropping
  the flag, is the run that deletes `ui/auth.json` and `profile/local-docker-vm.json` with the tree.
- `/home/sem/titanbot/ui/server.mjs` and `ui/auth.mjs` on the server are from before the console was
  ever meant to be public. They have never heard of `SAND_UI_TRUSTED_PROXIES`, they send no HSTS,
  and their login lockout is the single shared bucket described in section 7. Deploying the new
  compose on top of them comes up looking perfectly fine, with nothing anywhere to say the lock is
  the wrong one.

So, from the repo on the Mac:

    bash deploy/r750/sync.sh --no-install

If the change touches this compose file (an env var, a mount, a label), Coolify has to be told,
because it deploys the compose it stores, not the file in this repo. Push the file as base64 and
then restart; the stored copy is Coolify's rewritten form, so compare env keys, not text:

    B64=$(base64 < deploy/coolify/docker-compose.yml | tr -d '\n')
    curl -X PATCH $COOLIFY_URL/api/v1/services/<uuid> -H "Authorization: Bearer $COOLIFY_API_KEY" \
      -H 'content-type: application/json' -d "{\"docker_compose_raw\":\"$B64\"}"

Measured 2026-09-05 09:19: this is how `SAND_DESKTOP_SUPERVISION_DISABLED` (BOX-4) reached the
R750; the response echoes the uuid and the domains, and the next restart recreated both
containers with the new env.

That builds `host-main.cjs` and the exec daemon and copies them, `ui/` (server, auth, the Machine
Room), `deploy/r750/{common,install,uninstall}.sh`, `init-box.sh` and `apply-start-window-fix.sh` to
`/home/sem/titanbot`. `--no-install` matters: without it `sync.sh` ends by running `install.sh` and
you get a second set of hand-run containers colliding on the names. It does not restart anything,
so the console stays up on the tailnet until step 4.

Then four commands on the server, in this order.

    ssh dell-remote

    # a. the gateway token, to paste into Coolify in step 4. It is the token the CURRENT install
    #    minted and the box in the volumes already authenticates with. Do not generate a new one.
    grep -o '"token":"[0-9a-f]*"' /home/sem/titanbot/profile/local-docker-vm.json

    # b. the four data paths the compose file hardcodes. They must come back exactly as they are
    #    written in docker-compose.yml. They are this docker daemon's data-root plus the volume
    #    name, and if docker is ever moved to a different root they go stale silently -- docker
    #    would create empty directories and the console would come up with no agents on it.
    docker volume inspect titanbot-box-workspace titanbot-box-data titanbot-box-store \
      titanbot-box-chrome --format '{{.Name}} {{.Mountpoint}}'
    # expected, measured 2026-09-04:
    #   titanbot-box-workspace /data/docker/volumes/titanbot-box-workspace/_data
    #   titanbot-box-data      /data/docker/volumes/titanbot-box-data/_data
    #   titanbot-box-store     /data/docker/volumes/titanbot-box-store/_data
    #   titanbot-box-chrome    /data/docker/volumes/titanbot-box-chrome/_data

    # c. the hand-run containers have to go first: they hold the names titanbot-box and
    #    titanbot-relay and the four volumes, and a deploy that collides with them fails halfway.
    #    Both flags matter. --keep-volumes keeps every agent, transcript and workspace.
    #    --keep-tree keeps /home/sem/titanbot, which the compose file MOUNTS: the runtime bundle,
    #    ui/auth.json (the console password), profile/local-docker-vm.json (the token) and the
    #    credential placeholder all stay where they are. Without it the uninstall deletes the
    #    password and the token along with the tree.
    bash /home/sem/titanbot/deploy/uninstall.sh --keep-volumes --keep-tree

    # d. the relay image, AFTER the uninstall, which drops the titanbot-relay:local tag.
    #    Coolify cannot build it: a "Docker Compose Empty" resource is a user-defined Service with
    #    no Git source and no build context on disk, so a build: section has nothing to build
    #    from. Built here, the compose file's pull_policy: never keeps Coolify's pull step from
    #    going looking for it in a registry.
    docker build -t titanbot-relay:local -f /home/sem/titanbot/deploy/relay.Dockerfile /home/sem/titanbot/deploy

The console is down between (c) and a successful deploy. That is the whole outage.

## 3. The compose file, and the two Coolify rewrites that shape it

`deploy/coolify/docker-compose.yml` in this repo, pasted whole. Validated on the R750 with
`docker compose config` (v2.40.3): exit 0.

Read the header of that file before pasting it. The short version, because it is the difference
between a working cutover and a console with none of Jason's agents on it: **Coolify does not deploy
the file you paste.** It parses it, rewrites parts of it, and deploys the result. Two rewrites
matter, and both were read out of the parser running on this server (Coolify 4.0.0,
`/var/www/html/bootstrap/helpers/shared.php`), not out of documentation.

- **Named volumes are renamed.** Any named volume becomes `{service-uuid}_{slug}` and is created
  empty. `external: true` is not read at all; the only exemption in that branch is a `cifs` driver.
  A compose naming `titanbot-box-data` therefore gets a brand new empty one. So the four data mounts
  are host **paths** instead: the existing volumes' own directories, the ones step 2b printed. The
  hand install still mounts the same volumes by name, so both deployments address identical bytes
  and neither can drift from the other. That is what makes the rollback in section 8 free.
- **Every bind becomes a Coolify storage record**, except `/var/run/docker.sock` and `/tmp`. A
  short-syntax bind is assumed to be a directory, which for a directory means the record's save runs
  `mkdir -p` on something that already exists -- harmless. For a **file** it is not harmless:
  `LocalFileVolume::saveStorageOnServer` cats the file into Coolify's database and throws. A
  434-byte `ui/auth.json` would land in that database as the scrypt password hash and the cookie
  signing secret, visible in Coolify's Storages UI; the 19 MB `host-main.cjs` would land there as
  the literal string `[binary file]`, and one Save from that UI would write those 13 bytes over the
  bundle and stop the box from booting. **So there is not one file bind in the compose file.**

That second rule is why `host-main.cjs` gets there a different way than it does under `install.sh`.
The whole `runtime` directory is mounted read-only at `/opt/titanbot-runtime`, and the box's
entrypoint copies the one file into `/home/box/sand-host/` before handing off to the image's own
`/usr/local/bin/start-sand-box`. It runs before the supervisor, so the box never executes the stock
bundle even briefly. Measured on the R750 against this image: the image ships `host-main.cjs` with
sha256 `a69652a8dcc33682...`, and after the copy it is `b64262cf76022754...`, which is what
`sync.sh` put on the server.

It is also why `ui/auth.json` is no longer bind-mounted read-only over the top of the `ui` directory
the way `install.sh` does it. What protects it is what protected it before the relay was ever put in
a container: it is 0600 on the host, the relay only reads it, and nothing in the console's surface
writes it.

Two more things the compose does not have. **No container names**: Coolify overwrites
`container_name` with `<service>-<resource uuid>` unconditionally, so both services carry a
`com.titanbot.role` label instead, and `init-box.sh`, `ui/server.mjs` and `scripts/verify-deploy.mjs`
all find their container by that label. Custom labels survive the rewrite; so does the service name
as a network alias, which is why `http://titanbot-box:1340` still resolves. And **no ports, no
networks, no traefik labels**: Coolify makes the network, attaches its proxy to it, and writes the
router and certificate labels from the Domains field.

The two post-start box repairs that `install.sh` does inline -- reapplying the start-window fix and
installing `sqlite3` -- run from the relay's own start command, in the background, through
`init-box.sh`. They belong on every deploy, not just the first: the start-window fix is a filesystem
change inside the box container, so it survives a restart and does not survive a recreate, and a
Coolify redeploy recreates (`docker compose up -d --force-recreate`). Both steps check before
acting; measured on the R750 the script printed "already patched" and exited 0 without changing
anything.

They are not a separate one-shot service on purpose. A service that runs and exits is permanently
"exited" on a platform whose health display does not expect that, and Coolify's own key for the
case, `exclude_from_hc: true`, is an extension plain compose rejects: measured with docker compose
v2.40.3 on the R750 and v5.1.4 on the Mac, a file carrying it fails validation outright, so it could
never be checked before being pasted.

## 4. The Coolify clicks

1. Open the project, **+ New Resource** -> **Docker Compose Empty**.
2. **Edit Compose File**, paste `deploy/coolify/docker-compose.yml`, save.
3. **Environment Variables**: `TITANBOT_GATEWAY_TOKEN` = the 64-hex token from step 2a. Coolify
   creates the field from the `${TITANBOT_GATEWAY_TOKEN}` in the compose and leaves it empty. It
   does **not** mark it required, and it cannot be made to: Coolify builds the variable's name from
   everything between the braces, so a `${...:?}` would produce the name
   `TITANBOT_GATEWAY_TOKEN:?`, which is not a legal shell name and would leave the deploy demanding
   a variable no field can set. The box's entrypoint refuses to start on an empty token instead and
   says so in its log.
4. On the **titanbot-relay** service, **Domains**: `https://$DOMAIN:7777`. The `:7777` is not a
   public port; it tells Coolify's proxy which container port receives the request. The public URL
   is plain `https://$DOMAIN`.
5. Leave `titanbot-box` with no domain. It must not be reachable from outside.
6. **Deploy**.
7. The job bus token, if you want the Chief of Staff to reach this instance
   (`docs/JOB-BUS.md` §8). Two ways, and only one of them is needed:
   - **Environment Variables**: `TITAN_JOB_TOKEN` = a value you mint yourself
     (`openssl rand -hex 24`). The compose passes it through as `${TITAN_JOB_TOKEN}`, with no `:-`
     default: Coolify builds a field's NAME from everything between the braces, so the defaulted
     form comes out as a field literally named `TITAN_JOB_TOKEN:-` and your value never reaches the
     relay. Leaving the field empty still deploys; compose resolves it to the empty string and says
     so in the build log.
   - **Settings → Job bus → Generate** in the console. The token is shown once, and it is written
     to `job-bus.json` in the mounted profile directory at mode 0600. This is the way that needs
     no Coolify field at all, and it is the one to use if the env field came out misnamed.

   With neither, `/v1` answers `503 {"error":"job bus not configured"}` and nothing else on the
   relay is reachable with a job bus bearer. The console card says which of the two is in force.

Coolify will also list ten **Storages** entries for this resource, one per bind: seven on the box
(the four data directories, `runtime`, `runtime/box-exec-daemon` and `credential`) and three on the
relay (`ui`, `profile` and `deploy`; the docker socket is exempt). They are all directories, so the
records hold a path and nothing else. Leave them alone. Opening one and pressing Save is a write,
not a read.

## 5. Check it before trusting it

From the Mac, and this is the whole check:

    node scripts/verify-deploy.mjs --url https://$DOMAIN

It reads the bearer over ssh, finds both containers **by their `com.titanbot.role` label** rather
than by name (Coolify's names are `titanbot-box-<uuid>`, so a check written against the plain names
would answer "No such object" and prove nothing), and among its checks are the two that fail
silently in every other way:

- **the box's four data mounts are the titanbot volumes' own directories.** This is the volume
  rename from section 3, caught. If it fails, the console will still load, the gateway will still
  answer, and the roster will simply be empty. Stop and roll back (section 8): nothing is lost at
  that point, the real volumes are still there, and only the stack is pointed at the wrong ones.
- **the box is running the host bundle that is on the server.** That is the entrypoint copy, caught.
  A box quietly running the image's stock bundle looks entirely healthy from outside.

It also checks the certificate and its name, HSTS on a TLS response, that a forged `X-Forwarded-For`
buys no fresh lockout bucket, and that a forged `CF-Connecting-IP` sent straight to the origin at
`66.90.191.45` does not either. That last one prints `INCONCLUSIVE` rather than a pass if this Mac
cannot reach the origin at all, because a timeout here says nothing about what a guesser elsewhere
can reach.

On the server, the one thing the gate does not read is the relay's opinion of its own configuration:

    docker logs "$(docker ps --filter label=com.titanbot.role=relay --format '{{.Names}}')" 2>&1 | head -6

`prox` must read `4 trusted range(s) from SAND_UI_TRUSTED_PROXIES` and `cfip` must read
`22 Cloudflare range(s) from SAND_UI_CLOUDFLARE_RANGES`. If either line is missing entirely, the
container is running the old `ui/server.mjs`: run `sync.sh --no-install` from section 2 and redeploy.
If `cfip` reads `none`, the environment did not reach the container and the lockout is keyed on
Cloudflare's edges rather than on visitors, which is the section 7 shared bucket.

If you set a job bus token in step 4.7, add it to the gate and it checks the bus's door as well:

    node scripts/verify-deploy.mjs --url https://$DOMAIN --job-token "$TITAN_JOB_TOKEN"

Without the flag the gate still asserts that `/v1/health` is `401` or `503` and never `200`
without a bearer, and reports the other half `INCONCLUSIVE` rather than skipping it. Then the
smoke from `docs/JOB-BUS.md` §8 is the end-to-end proof: health, a `health.ping` job, and the read
back of that job.

## 6. How updates ship afterwards

The same first command as section 2, then a button:

    bash deploy/r750/sync.sh --no-install     # from the repo on the Mac
    # then in Coolify: Redeploy

The runtime is mounted, not baked into an image, and the redeploy recreates the box, so the
entrypoint copies the new bundle in on the way up. A new host bundle needs no image build at all.
Only a change to `relay.Dockerfile` does, and that is the `docker build` in step 2d again.

A Git-backed resource would replace this with a push, at the cost of a repository Coolify can read
and a build context for the relay image. Worth doing later; it is not needed for the cutover.

## 7. What is public now, and what stands in front of it

Public, to anyone on the internet who knows the name:

- **The password.** scrypt (N=16384), one field on the login page. Sessions are signed cookies,
  HttpOnly, SameSite=Strict, Secure behind TLS, 12 hours. Its strength is Jason's decision and it
  is now the only thing between a stranger and shell inside the box, because every `/api` call the
  relay forwards carries the gateway bearer.
- **The lockout**, five failures then thirty seconds, per **real** client address. Behind two
  proxies the socket address is Traefik's, one address for the whole internet, so a lockout keyed on
  it would be a single bucket everyone shares. `SAND_UI_TRUSTED_PROXIES` in the compose is what lets
  the relay read a forwarded address at all, and it takes the one Traefik itself wrote into
  `X-Forwarded-For`. Measured against `traefik:v3.6` started with this server's own arguments: a
  request carrying `X-Forwarded-For: 1.2.3.4, 5.6.7.8, 9.9.9.9` reached the backend as
  `X-Forwarded-For: <the caller's real address>`, the forged list gone, and a forged
  `X-Forwarded-Proto: https` over a plain connection arrived as `http`. Those two are Traefik's
  observations, not the caller's claims.
- **`SAND_UI_CLOUDFLARE_RANGES`**, which is the line that decides whether the lockout can be walked
  around at all, and it deserves its own bullet. `CF-Connecting-IP` is *not* in the `X-Forwarded-*`
  family, so Traefik passes it through byte for byte -- measured in the same run: the forged
  `CF-Connecting-IP: 5.6.7.8` arrived untouched. And nothing forces a visitor through Cloudflare.
  This origin answers on `66.90.191.45` for any proxied `*.semfreak.dev` name over a valid
  certificate, its address is in certificate transparency, and it is shared with three dozen other
  containers. A guesser who connects straight there and writes a fresh `CF-Connecting-IP` per
  attempt would never be locked out at all if that header were believed on its own. So it is read
  only when the address Traefik observed is itself inside Cloudflare's published ranges, which is
  the one path on which Cloudflare rather than the caller wrote it. On the direct path the client is
  the address Traefik observed, which is the guesser's own, and five wrong passwords lock it.

  What that still does not stop is somebody with many source addresses: every per-address lockout
  gives one bucket per address. A cap that ignored the address would bound it, and would also let
  any stranger lock Jason out by burning it, which is the failure this whole design starts from. The
  password carries that weight.
- **TLS**, twice: Cloudflare's edge certificate at the front (Google Trust Services, valid, as on
  `artifacts.semfreak.dev` today) and Coolify's own `letsencrypt` resolver at the origin. Responses
  that arrived over TLS carry `Strict-Transport-Security: max-age=31536000; includeSubDomains`, and
  neither page the relay serves embeds an http-only asset, which is asserted in the test suite.
- **Cloudflare's proxy**, which hides the origin address and absorbs the obvious volumetric noise.
  It is not an authenticator. Nothing here checks who you are before the password does.

Two things are now stored somewhere they were not before.

**The gateway token.** The box takes it only as an environment variable, so `TITANBOT_GATEWAY_TOKEN`
lives in Coolify's environment store and shows up in `docker inspect` on the box container. It is
root-equivalent on this host. The relay is deliberately not given it that way -- it reads the same
value out of the 0600 `profile/local-docker-vm.json` mounted read-only -- so the blast radius is
Coolify's own store and anyone who already has the docker socket, which is the same set that could
read the file.

**Ten paths, in Coolify's Storages records.** Every bind except the docker socket becomes a row in
Coolify's database holding the path. Only the path: the content column stays empty for a directory,
which is why the compose has no file binds at all. `/home/sem/titanbot/ui` is one of those rows and
`ui/auth.json` is inside it, so the row names the directory the password lives in without holding
the password.

And one thing that is easy to miss: **the other containers on the server can reach the relay
directly**. Coolify puts its proxy on this stack's network, and any resource configured to connect
to a predefined network reaches `http://titanbot-relay:7777` with no Traefik and no middleware in
the path. What they still meet is the password wall, and they meet it on easier terms than a person
does: their address is inside `SAND_UI_TRUSTED_PROXIES`, because Traefik's address on a
Coolify-allocated network is not knowable in advance and the ranges have to be wide enough to cover
it, so a container on that network can write its own `X-Forwarded-For` and get a fresh lockout
bucket per value. Unlimited guesses, in other words, for anything already running on this host.

That is not a hole this file can close: narrowing the ranges to one address means knowing an address
Coolify picks at deploy time. It is a statement about the trust boundary. Everything with a foothold
on the R750's docker networks is already inside it, and the day that stops being an acceptable
sentence is the day the console needs a second factor rather than a wider CIDR list.

## 8. Rollback

The hand-run install is still the fallback and it comes back in one command:

    ssh dell-remote
    # stop the Coolify resource first, or the names and volumes collide
    bash /home/sem/titanbot/deploy/install.sh

That returns the console to `http://100.110.83.82:7787`, on the tailnet, with no public route: the
route was never anything but Traefik labels, and there are none in the compose file. Reverse the
DNS change from section 1 and `$DOMAIN` stops answering as well.

Nothing is copied or migrated in either direction, which is the point of mounting the volumes'
own directories rather than copies of them: whichever of the two is running, the agents are the same
bytes in the same place, and anything written under Coolify is there when `install.sh` comes back.
