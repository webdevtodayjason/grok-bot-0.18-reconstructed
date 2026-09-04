# Titanbot on the R750

Two containers on their own docker network, installed under names nothing else on the box uses.
The R750 also runs Jason's production Coolify stack, so every object this deploy creates is named
`titanbot-*` and lives under `/home/sem/titanbot`.

| object | what it is |
| --- | --- |
| `titanbot-box` | the sand box image, pinned by digest, with the host bundle bind-mounted over it |
| `titanbot-relay` | `ui/server.mjs` in a node container, holding the gateway token and serving the Machine Room |
| `titanbot` | a bridge network, so the relay reaches the box as `http://titanbot-box:1340` |
| `titanbot-box-{workspace,data,store,chrome}` | four volumes; all agent data lives here |
| `/home/sem/titanbot` | the host bundle, the exec daemon, the token file, the credential placeholder, the UI, and `ui/auth.json`, the console's login |

What it touches outside that list: the docker daemon (it creates the objects above and mounts
`/var/run/docker.sock` into the relay, see item 8), and, **only after you run
`deploy/enable-route.sh`**, the `coolify` docker network, which it joins so Traefik can reach the
relay by name. It creates no Coolify application record, writes no Traefik configuration file, and
changes no DNS entry or certificate at any point.

The relay publishes on `100.110.83.82:7787` only, which is the tailnet address. The box publishes
its six ports on the server's `127.0.0.1` only. No titanbot port is published on `0.0.0.0`. Inside
its own container the relay process binds `0.0.0.0:7777`, because `127.0.0.1` there would be the
container's private loopback and even the published port could not reach it; what the host exposes
is still the single tailnet binding.

## Deploy it

From the Mac, at the repo root:

```
bash deploy/r750/sync.sh
```

That builds the host bundle from `source/` (printing its sha256, so the deploy is anchored to an
artifact rather than a timestamp), builds the box exec daemon, rsyncs both plus the relay's files
to `/home/sem/titanbot`, and runs `install.sh` over ssh. It never copies `ui/endpoints.json`,
`ui/subscriptions.json`, `ui/auth.json`, or the Mac's gateway token. `install.sh` mints the server
its own token, and the console password is set on the server (item 4).

Re-running it is the redeploy path: it rebuilds, re-ships, and recreates both containers. The
volumes are untouched, so nothing is lost. A redeploy cannot publish anything by surprise, and
cannot take a published route down either: `install.sh` attaches Traefik labels only when
`/home/sem/titanbot/route.enabled` exists, which is the marker `enable-route.sh` writes.

A fresh install has no password, and the relay will not bind without one (item 4). `install.sh`
says so and prints the command; set it on the server, then run `install.sh` again:

```
ssh dell-remote
node /home/sem/titanbot/ui/set-password.mjs
bash /home/sem/titanbot/deploy/r750/install.sh
```

`docker restart titanbot-relay` also brings it up, and is the right move for a password change on
an install that already has one. It is the weaker move on a first install: the read-only bind of
`ui/auth.json` is attached when the container is created, and only if the file exists by then, so
a container created before the password was set can rewrite its own hash until `install.sh`
recreates it.

Verify from the Mac:

```
node scripts/verify-deploy.mjs
```

Undo, on the server:

```
bash /home/sem/titanbot/deploy/uninstall.sh
```

It removes the containers, the relay image, the network and the tree, and asks before touching the
volumes. Removing the relay container also removes the labels that were the route, so
`tb.semfreak.dev` stops resolving to anything in Traefik. It does not touch Coolify's own objects,
DNS or the certificate resolver you added.

## Operator checklist

Everything above runs as `sem` with no sudo. Everything below needs Jason, either because it
touches Coolify-owned objects or because it involves a secret an agent must not hold. In order.

### 1. Give Traefik a DNS-01 challenge

This is the hard blocker for `tb.semfreak.dev`. `coolify-proxy` today has exactly one resolver, it
is named `letsencrypt`, and it is HTTP-01:

```
--certificatesresolvers.letsencrypt.acme.httpchallenge=true
--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=http
--certificatesresolvers.letsencrypt.acme.storage=/traefik/acme.json
```

`tb.semfreak.dev` resolves to `100.110.83.82`, a tailnet address Let's Encrypt cannot reach, so
the HTTP-01 challenge fails every time.

Coolify's own documentation
(<https://coolify.io/docs/knowledge-base/proxy/traefik/dns-challenge>, Cloudflare tab) extends the
**existing** `letsencrypt` resolver rather than adding a second one. Follow that shape. In Coolify
go to **Servers -> the R750 -> Proxy -> Configuration**, keep the three lines above, and add:

```
--certificatesresolvers.letsencrypt.acme.dnschallenge=true
--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare
--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=0
```

plus, in the same compose file's `environment:` block for the proxy:

```
- CF_DNS_API_TOKEN=<token from step 2>
```

Then redeploy the proxy from that same page.

**The resolver name and the container label have to be the same string.** The relay labels itself
`traefik.http.routers.titanbot.tls.certresolver=letsencrypt`, which matches the resolver above. If
you instead create a separately named resolver (say `cloudflare`), set
`TITANBOT_ROUTE_CERTRESOLVER=cloudflare` before running `enable-route.sh`, or Traefik logs
`Router uses a nonexistent certificate resolver` every few seconds into your production proxy's
log and serves its self-signed default. `enable-route.sh` reads the proxy's real command line and
warns if the name does not exist, but it cannot fix it for you.

**Redeploying the proxy restarts `coolify-proxy`, which owns ports 80 and 443 for every app on the
box.** Every production app is briefly down. Schedule it.

If you skip this step entirely: `tb.semfreak.dev` serves Traefik's self-signed default certificate
and every browser hard-warns. The tailnet URL `http://100.110.83.82:7787/` works either way and
needs none of this.

### 2. Mint the Cloudflare API token

At dash.cloudflare.com: **My Profile -> API Tokens -> Create Token -> Edit zone DNS**, scoped to
the `semfreak.dev` zone. It needs `Zone:DNS:Edit` and `Zone:Zone:Read`. Use a zone-scoped token,
not the global key.

It goes into the `coolify-proxy` environment in step 1 and nowhere else. Not into the repo, not
into `/home/sem/titanbot`, not into a chat with an agent.

### 3. Publish the route

```
bash /home/sem/titanbot/deploy/enable-route.sh
```

It prints what publishing exposes, asks for a typed confirmation, then does three things and
nothing else: writes the marker `/home/sem/titanbot/route.enabled`, recreates `titanbot-relay`
with its Traefik labels, and attaches it to the `coolify` network. No Coolify application record,
no compose file, no write to Coolify's database.

Why this is a separate script and not part of the install: **Traefik's docker provider watches
every container on the docker host, not only the containers on its own networks.** A `traefik.*`
label creates a live router the instant the container is created. Joining the `coolify` network
decides only whether Traefik can *reach* the backend, not whether the router exists. So labels at
install time would mean a router in production before any operator step, answering requests (403
from the IP allowlist, or 502 with no backend) and, if the certresolver name is wrong, spamming
the proxy log. Keeping the labels behind this script is what makes "installed" and "published" two
different states.

Verify:

```
docker exec coolify-proxy wget -qSO- --header='Accept: text/html' http://titanbot-relay:7777/ 2>&1 | head -5
```

Expect `HTTP/1.1 302 Found` with `Location: /login`: the proxy can reach the relay and the relay
does not know it. The `Accept` header is what asks for that shape; without it the same request
answers `401 {"error":"not signed in"}` with an `x-relay-auth: required` header, which proves the
same thing. That header is also what the console keys on: it goes to `/login` only for a 401 the
relay itself raised. A 401 the gateway raised instead (a stale `SAND_HOST_GATEWAY_TOKEN`, or the
box recreated under a running relay) is a different fault, so the relay answers those `502` saying
so rather than sending an operator who typed the right password back to the login forever. What would be a finding is a
`200` carrying console HTML, because that would mean a relay running with no password, and item 4
says this bind cannot start that way.

Undo:

```
bash /home/sem/titanbot/deploy/disable-route.sh
```

`docker network disconnect coolify titanbot-relay` on its own is **not** a rollback. It removes the
backend but leaves the labels, so the router and its middleware stay registered and the host keeps
answering, now with a 502. The router goes away only when the labels do, and labels can only be
removed by recreating the container, which is what `disable-route.sh` does.

Note that Coolify's docker provider runs with `--providers.docker.exposedbydefault=false`, which
is why the container carries `traefik.enable=true` explicitly.

### 4. Know what publishing exposes

The relay injects the gateway bearer into every `/api` call it forwards and forwards any method
name it is given, so getting past it means holding the full 122-command gateway surface, including
`createAgent`, `deleteAgent`, shell inside the box, and connector and secret writes. That is the
whole point of the relay (the browser must never see the token) and it is also its whole risk.

**What now stands in front of that is a password.** `ui/server.mjs` requires either a signed
session cookie or the gateway bearer on every route except the login itself. A browser with no
session is redirected to `/login`; an `/api` call with no credential gets `401`. The password lives
in `/home/sem/titanbot/ui/auth.json` (mode 0600, a scrypt hash and a cookie signing secret, never
the password itself) and it is set on the server, never shipped from the Mac:

```
ssh dell-remote
node /home/sem/titanbot/ui/set-password.mjs        # prompts twice, no echo
docker restart titanbot-relay                      # it is read at boot
```

`install.sh` binds that file into the relay container read-only, so nothing running in there can
rewrite the hash or the cookie secret. The bind is attached at container creation and only when
the file already exists, so on a FIRST install the order matters: set the password, then run
`install.sh` again. Between those two the relay still reads the file through the read-write `ui/`
mount, which works and is how a plain `docker restart` comes up, but leaves it writable from
inside a container that also holds the docker socket.

The relay **refuses to start** when it is told to bind anything but loopback and that file is
missing, which is exactly the case here: inside its container it binds `0.0.0.0:7777`. So a
titanbot install with no password does not serve an open console, it serves nothing, and
`install.sh` prints the command above. On the Mac, where the relay binds `127.0.0.1` and there is
no `ui/auth.json`, nothing changed.

Sessions last 12 hours. The cookie is `HttpOnly`, `SameSite=Strict` (which is also the CSRF
answer: a cross-site POST carries no cookie at all) and `Secure` whenever the request arrived over
TLS or through a proxy that says so. Failed logins are rate limited to five per source address,
then a 30 second wait that refuses the right password too. The console has a Log out control, and
`POST /logout` clears the cookie.

Before step 3 the surface is bounded by the publish as well: `100.110.83.82:7787`, tailnet only.

After step 3 there are two more ways in, and the password is what each of them meets:

- **through Traefik on 443**, where the `ipallowlist` middleware in item 5 is a second gate in
  front of the login; and
- **from any other container on the `coolify` network**, at `http://titanbot-relay:7777/api/*`.
  Container-to-container traffic never passes through Traefik, so the allowlist does not apply to
  it at all and the login is the only thing in the way. There are 36 containers on that network
  today, and the relay mounts the docker socket read-write (item 8), so a compromised production
  app container that guesses the password reaches root on the host.

That last sentence is the reason to choose a real password rather than one you would type twice a
day. The rate limit makes online guessing slow, not impossible, and there is nothing else behind
it: no second factor, no per-user accounts, one shared password for whoever holds the console.
Decide with that in view, the same way item 8 asks you to decide about the socket.

Rotating it is `set-password.mjs` again plus `docker restart titanbot-relay`; that also mints a new
cookie secret, which signs every outstanding session out. There is no other revocation, and that
is worth being precise about on a shared console: sessions are signed payloads, not rows in a
table, so **Log out clears the cookie in that browser and nothing else.** A cookie value someone
copied stays good for the rest of its 12 hours. Rotating the password is the only way to end it.

### 5. Check the IP allowlist is tight enough

Once step 3 has run, the relay carries these labels:

```
traefik.http.routers.titanbot.middlewares=titanbot-allow@docker
traefik.http.middlewares.titanbot-allow.ipallowlist.sourcerange=100.64.0.0/10,192.168.0.0/24
```

`100.64.0.0/10` is the tailnet, `192.168.0.0/24` is the LAN. Traefik v3 spells it `ipallowlist`;
v2's `ipwhitelist` is gone and would silently not apply.

This matters because ports 80 and 443 are bound on `0.0.0.0`. Without the middleware, anything
that can reach the host on 443 and send the right `Host` header gets the console. To tighten it,
run `enable-route.sh` with `TITANBOT_ROUTE_ALLOW=100.64.0.0/10` to drop the LAN range. **Test it
from an address that is neither on the tailnet nor on the LAN: it must return 403.** Until that
test has been run, treat the allowlist as unproven.

### 6. Supply `ui/endpoints.json`

Nothing in the repo carries API keys and nothing may. Without this file the relay starts and the
Machine Room loads, but the model picker is empty and no agent can answer.

Write it on the server so no key crosses a laptop:

```
ssh dell-remote
cat > /home/sem/titanbot/ui/endpoints.json <<'JSON'
{"endpoints":[{"id":"xai-grok","name":"xAI - Grok 4.6 (frontier)","baseUrl":"https://api.x.ai/v1","model":"grok-4.6","apiKey":"<xai key>"}]}
JSON
chmod 600 /home/sem/titanbot/ui/endpoints.json
docker restart titanbot-relay
```

It has to be an API-key endpoint. Codex adoption reads `~/.codex` on the machine running the relay
(`ui/subscriptions.mjs`), and there is no Codex login on the R750, so the Mac's subscription route
does not exist there.

The R750's own ollama on `11434` works as a keyless smoke-test endpoint
(`http://127.0.0.1:11434/v1`) if you only want to prove the picker paints. It is not good enough
for real work: Ollama's tool-schema shim breaks past about six tools, and this host registers far
more than that.

### 7. Restore your own skills

The seed skills (learn-from-demonstration and friends) are compiled into the host bundle at build
time and ship automatically. Nothing to do for those.

The eleven Titanium workflow skills are operator data, not product, and are not in this tree. Per
`docs/OPERATOR-RUNBOOK.md`, restore them either way:

- copy each `workflows/<id>/SKILL.md` from the August 15 backup into the box at
  `/home/box/sand-data/workflows/<id>/SKILL.md`, which on this install is
  `docker cp <extracted dir>/. titanbot-box:/home/box/sand-data/workflows/` then
  `docker restart titanbot-box`
- or paste each file's text into the Skills panel's import, which calls `importAgentWorkflowText`

The backup archive is not in this workspace and I could not find it. Name the path and the
`docker cp` line above is the whole restore.

### 8. Decide about the docker socket

`titanbot-relay` mounts `/var/run/docker.sock` read-write, which makes that container
root-equivalent on a host that also runs your production Coolify apps.

It is not optional. `ui/server.mjs` reaches the box's `box-secrets.json` (the model picker),
`connectors.json`, and the window and terminal surfaces exclusively through `docker exec`, because
those files live in a docker volume with no path on the host. Remove the mount and the console
loads with an empty model picker and a connector editor that saves nothing, with no error.

Know this before cutover rather than after. It is also what makes item 4's second path serious.

### 9. The desktop, and the one page that still needs a tunnel

The Machine Room's desktop needs nothing from you. The relay proxies it: the frame is asked for at
`/vnc/<display>/vnc.html` on whatever origin the page itself is on, the relay serves the box's own
noVNC through, and `/vnc/<display>/websockify` carries the socket to the box's websockify (6080 for
the shared seat on `:1`, 6081 with the display as its token for every agent's own screen). Both
halves sit behind the same login as the rest of the console, the upgrade included, and nothing is
copied out of the box image.

That is a change from what this file used to say. The host answers `ensureForeverBox` with a URL on
its OWN loopback (`http://127.0.0.1:6081/...`), which is the right address only for a browser
running on the server. Jason's browser resolved it against his Mac, which runs a box of its own on
6081, and got the wrong machine's screen or `Failed to connect to downstream server`. **No ssh
tunnel is needed for the Machine Room desktop, and none ever helped: the address was wrong, not
unreachable.**

The `/operator` page is the exception. `ui/index.html` still hardcodes
`http://127.0.0.1:6080/vnc_lite.html`, so its embedded desktop is dead through `tb.semfreak.dev`
and an ssh tunnel (`ssh -L 6080:localhost:6080 dell-remote`) is still the only way to see it. The
Machine Room at `/` is the console; `/operator` is the older page kept beside it.

## What to verify

`node scripts/verify-deploy.mjs` from the Mac covers, in order:

1. both containers running; the relay published on `100.110.83.82:7787` and nothing else; every
   box port on `127.0.0.1`; nothing on `0.0.0.0`; the token file 64 hex characters at mode 0600
2. `getHostStatus` 200 with a `hostVersion` through `http://100.110.83.82:7787` with the bearer,
   `401` for the same call with no credential at all, and `x-relay-auth: required` on that refusal
3. the login: the relay reports a password is configured, an unauthenticated browser asking for
   `/` is redirected to `/login`, the page renders one password field, a wrong password is refused
   with no cookie, a login body too large to be a password is refused `413` rather than buffered,
   a page request carrying the gateway bearer is served AND given an `HttpOnly; SameSite=Strict;
   Max-Age=43200` cookie while an `/api` call with the same bearer is given none, and that cookie
   reaches `getHostStatus` with no authorization header of its own, which is what proves the relay
   is still injecting the bearer. `POST /logout` clears the cookie
4. `listAgents` 200; a probe agent created, seen in the roster, deleted, the roster back to its
   baseline with no strays, and exactly one new id in the box's `deleted-agents.json`, which is
   the permanent residue every probe run leaves
5. the Machine Room in real headless Chrome: a browser carrying the bearer lands on the console
   rather than the login and is holding the session the relay minted, the roster paints cards from
   the live gateway, the cards carry names, the header shows the host's agent count, the Log out
   control is on screen, and no console error or failed `/api` request mentions the gateway
6. the desktop: a second probe agent is created, the host gives it a screen, the console opens it,
   and the frame is on the page's own origin under `/vnc/` (not on the viewer's `127.0.0.1`),
   carries the box's own noVNC, draws a framebuffer, and a websocket to
   `/vnc/<display>/websockify` reaches open state. Sixty seconds, then the probe is deleted
7. the lockout: wrong passwords refused until the fifth failure from this address (the login step
   above already spent two of the five, and only a successful login clears them, which this gate
   cannot do), then rate limited with a `Retry-After`, a
   request that answered `413` a moment earlier refused unread with a `429` while it holds (which
   is how a gate that does not know the password still proves the lockout stops the source rather
   than judging the password), and the gateway bearer unaffected by any of it

Exit 0 is a pass. It reads the server's bearer token over ssh at test time and holds it in memory
only; it never writes it to the Mac's disk and never prints it.

The gate does not know the console password and no longer asks for one. It used to read a copy from
`/home/sem/titanbot/profile/ui-password.probe`, which was a second secret to keep in step with the
real one, and it drifted the first time the password changed. Delete that file if it is still
there; nothing reads it. What the gate proves now is the shape of the door -- the wrong password
refused, the lockout holding -- and it gets in with the gateway bearer, which it reads over ssh
anyway and which is already full access. The last step leaves this Mac's address locked out of the
login for 30 seconds, so a second gate run started immediately will fail its login step; wait half
a minute.

Each run creates two probe agents and deletes both, so it adds two ids to the box's
`deleted-agents.json`, which is permanent by design.

The header can read `0 / 50 agents` with a card on screen. That is not a phantom: `countAgents` is
`sessionStore.listAgents()` with no active-agent id, and a blank, unnamed, non-active agent is
filtered out of that call by `buildSummary`, while the card comes from the same store call made
*with* the active id. Same directory, different argument. See the comments in
`scripts/verify-deploy.mjs`.

After the operator steps, add by hand:

- `curl -sI https://tb.semfreak.dev/` from the tailnet returns 200 with a certificate the browser
  accepts, not Traefik's self-signed default
- the same request from off-tailnet returns 403, which is the only real proof of item 5
- the model picker in the console lists the endpoint from item 6 and reports it reachable
