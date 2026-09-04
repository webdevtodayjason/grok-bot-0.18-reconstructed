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
| `/home/sem/titanbot` | the host bundle, the exec daemon, the token file, the credential placeholder, the UI |

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
`ui/subscriptions.json`, or the Mac's gateway token. `install.sh` mints the server its own.

Re-running it is the redeploy path: it rebuilds, re-ships, and recreates both containers. The
volumes are untouched, so nothing is lost. A redeploy cannot publish anything by surprise, and
cannot take a published route down either: `install.sh` attaches Traefik labels only when
`/home/sem/titanbot/route.enabled` exists, which is the marker `enable-route.sh` writes.

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
docker exec coolify-proxy wget -qO- http://titanbot-relay:7777/ | head -c 100
```

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

`ui/server.mjs` has no authentication of its own. It injects the gateway bearer into every `/api`
call it forwards, and forwards any method name it is given. **Anything that can open a TCP
connection to the relay therefore holds the full 122-command gateway surface**, including
`createAgent`, `deleteAgent`, shell inside the box, and connector and secret writes. That is the
whole point of the relay (the browser must never see the token) and it is also its whole risk.

Before step 3 that surface is bounded by the publish: `100.110.83.82:7787`, tailnet only.

After step 3 there are two more ways in:

- **through Traefik on 443**, where the `ipallowlist` middleware in item 5 is the only gate; and
- **from any other container on the `coolify` network**, at `http://titanbot-relay:7777/api/*`,
  with no credential. Container-to-container traffic never passes through Traefik, so the
  allowlist does not apply to it at all. There are 36 containers on that network today. A single
  compromised production app container reaches the relay, and the relay mounts the docker socket
  read-write (item 8), so that is a path to root on the host.

There is no mitigation in this deploy for the second one beyond not running step 3. Decide with
that in view, the same way item 8 asks you to decide about the socket. If you want the console
published but not that exposure, the honest answers are a separate proxy container on the coolify
network that forwards to the relay with its own auth, or an auth layer inside `ui/server.mjs`.
Neither exists today.

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

### 9. Optional: the `/operator` desktop

`ui/index.html` hardcodes `http://127.0.0.1:6080/vnc_lite.html`, so the embedded desktop on
`/operator` is dead through `tb.semfreak.dev`. The box publishes 6080 on the server's loopback, so
the working route today is an ssh tunnel:

```
ssh -L 6080:localhost:6080 dell-remote
```

then open `/operator` from the Mac. The Machine Room at `/` does not need any of this. The real
fix is a relay route for the VNC path.

## What to verify

`node scripts/verify-deploy.mjs` from the Mac covers, in order:

1. both containers running; the relay published on `100.110.83.82:7787` and nothing else; every
   box port on `127.0.0.1`; nothing on `0.0.0.0`; the token file 64 hex characters at mode 0600
2. `getHostStatus` 200 with a `hostVersion` through `http://100.110.83.82:7787`, and the same call
   with no authorization header also 200, which is what proves the relay is injecting the bearer
3. `listAgents` 200; a probe agent created, seen in the roster, deleted, the roster back to its
   baseline with no strays, and exactly one new id in the box's `deleted-agents.json`, which is
   the permanent residue every probe run leaves
4. the Machine Room loaded in real headless Chrome: the roster paints cards from the live gateway,
   the cards carry names, the header shows the host's agent count, and no console error or failed
   `/api` request mentions the gateway

Exit 0 is a pass. It reads the server's bearer token over ssh at test time and holds it in memory
only; it never writes it to the Mac's disk and never prints it.

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
