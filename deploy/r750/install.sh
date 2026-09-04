#!/usr/bin/env bash
# install.sh -- stand the box and the relay up on the R750. Runs ON THE SERVER, as sem, no sudo.
#
# Everything it creates is named titanbot-*: two containers, one network, four volumes, one image
# tag, and the tree under /home/sem/titanbot. It creates no Coolify object, writes no Traefik
# configuration, and by default attaches no Traefik labels, which matters because this machine
# also runs Jason's production Coolify stack and its proxy watches every container on the host.
#
# The public tb.semfreak.dev route is a separate, operator-run step: deploy/enable-route.sh. Until
# that has been run there is no titanbot router in Coolify's proxy at all. Once it has been run it
# leaves a marker file ($ROOT/route.enabled) and this script honours it, so a redeploy keeps the
# route instead of silently dropping it.
#
# It is idempotent by design. Re-running it recreates the two containers (their state lives in
# volumes, so nothing is lost), reuses the token and the credential file if they already exist,
# and skips the 5.2 GB image pull. The one thing it must never do twice is mint a new gateway
# token, because the box would then be holding a token the relay cannot read.
#
#   bash /home/sem/titanbot/deploy/install.sh
#
# Env overrides, all optional:
#   TITANBOT_ROOT         install tree, default /home/sem/titanbot
#   TITANBOT_RELAY_BIND   host IP the relay publishes on, default 100.110.83.82 (the tailnet address)
#   TITANBOT_RELAY_PORT   host port for the relay, default 7787
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

# Pinned by digest, not by tag. The :sand-box-latest tag has already moved once since the Mac
# pulled it, and an install that silently ships a different box than the one the host bundle was
# built against is a debugging nightmare nobody would think to look for.
BOX_IMAGE="public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:d0bb69285340df19d73f106492c7aabb723e8a950809b9f53a884888e2b4c709"

step "prerequisites"
command -v docker >/dev/null || die "docker is not on PATH"
docker info >/dev/null 2>&1 || die "docker is not usable by $(id -un) without sudo"
say "docker $(docker --version | awk '{print $3}' | tr -d ,) usable as $(id -un)"
command -v openssl >/dev/null || die "openssl is not on PATH (needed to mint the gateway token)"
command -v curl >/dev/null || die "curl is not on PATH (needed for the readiness probes)"

# Fail on a missing artifact here rather than after a 5 GB pull.
[ -f "$ROOT/runtime/host-main.cjs" ] || die "$ROOT/runtime/host-main.cjs is missing -- run deploy/r750/sync.sh from the Mac"
[ -f "$ROOT/runtime/box-exec-daemon/main.cjs" ] || die "$ROOT/runtime/box-exec-daemon/main.cjs is missing -- run deploy/r750/sync.sh from the Mac"
[ -f "$ROOT/deploy/apply-start-window-fix.sh" ] || die "$ROOT/deploy/apply-start-window-fix.sh is missing -- run deploy/r750/sync.sh from the Mac"
[ -f "$ROOT/ui/server.mjs" ] || die "$ROOT/ui/server.mjs is missing -- run deploy/r750/sync.sh from the Mac"
say "host bundle $(stat -c %s "$ROOT/runtime/host-main.cjs") bytes, sha256 $(sha256sum "$ROOT/runtime/host-main.cjs" | cut -c1-16)..."
say "exec daemon $(stat -c %s "$ROOT/runtime/box-exec-daemon/main.cjs") bytes, sha256 $(sha256sum "$ROOT/runtime/box-exec-daemon/main.cjs" | cut -c1-16)..."

# The relay publishes on the tailnet address specifically so it never appears on the LAN
# interface. If that address is not on this host the publish would fail with an opaque docker
# error, so check it by name first.
ip -o addr show 2>/dev/null | grep -qw "$RELAY_BIND" || die "$RELAY_BIND is not an address on this host; set TITANBOT_RELAY_BIND"
say "relay will publish on $RELAY_BIND:$RELAY_PORT"

if route_enabled; then
  say "route marker $ROUTE_MARKER is present, so the relay will be recreated WITH its Traefik"
  say "labels and reattached to the $ROUTE_NETWORK network"
else
  say "no route marker, so no Traefik label and no $ROUTE_NETWORK attachment (deploy/enable-route.sh turns that on)"
fi

step "gateway token"
mkdir -p "$ROOT/profile"
TOKEN_FILE="$ROOT/profile/local-docker-vm.json"
if [ -f "$TOKEN_FILE" ]; then
  # Reuse, always. Minting a second token would leave the running box authenticating with the
  # first one and every call through the relay answering 401.
  say "reusing the existing gateway token at $TOKEN_FILE (not printed)"
else
  ( umask 077; printf '{"schemaVersion":1,"token":"%s"}\n' "$(openssl rand -hex 32)" > "$TOKEN_FILE" )
  say "minted a fresh 64-hex gateway token at $TOKEN_FILE (not printed)"
fi
chmod 600 "$TOKEN_FILE"
# Read with sed rather than a JSON parser: the file is a one-line object this script wrote itself,
# and reaching for python3 here would add an unchecked prerequisite to a step that runs AFTER the
# token file exists, so a host without it would fail past the point of no return on every re-run.
TOKEN="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$TOKEN_FILE")"
[ "${#TOKEN}" -eq 64 ] || die "no 64-hex token could be read out of $TOKEN_FILE"
say "token length 64, file mode $(stat -c %a "$TOKEN_FILE")"

step "inference credential placeholder"
mkdir -p "$ROOT/credential"
CRED="$ROOT/credential/inference.json"
if [ -f "$CRED" ]; then
  say "keeping the existing $CRED"
else
  # The host boots without this file (auth-service logs that inference is unavailable and returns
  # normally), but box-store-sync's copy-in path throws when neither SAND_DEV_INFERENCE_TOKEN_FILE
  # nor SAND_INFERENCE_RENEWAL_CREDENTIAL is set and SAND_BOX_STORE_SYNC is on. A placeholder costs
  # nothing and sidesteps that one throw. Real inference comes from the endpoint picker, which
  # writes SAND_OPENAI_COMPATIBLE_* into the box's own secrets file.
  ( umask 077; printf '{"accessToken":"placeholder-not-a-credential","expiresAtMs":%s}\n' \
      "$(( ( $(date +%s) + 315360000 ) * 1000 ))" > "$CRED" )
  chmod 600 "$CRED"
  say "wrote a placeholder $CRED; it is NOT a credential, and real inference comes from the endpoint picker"
fi

step "network and volumes"
if docker network inspect "$NET" >/dev/null 2>&1; then say "network $NET already exists"
else docker network create "$NET" >/dev/null; say "created network $NET"; fi
for v in workspace data store chrome; do
  if docker volume inspect "titanbot-box-$v" >/dev/null 2>&1; then say "volume titanbot-box-$v already exists"
  else docker volume create "titanbot-box-$v" >/dev/null; say "created volume titanbot-box-$v"; fi
done

step "box image"
if docker image inspect "$BOX_IMAGE" >/dev/null 2>&1; then
  say "image already present, skipping the 5.2 GB pull"
else
  say "pulling $BOX_IMAGE (about 5.2 GB, first run only)"
  docker pull "$BOX_IMAGE"
fi

step "box container"
# `docker rm --force` exits 0 on a container that does not exist, so asking first is the only way
# this line can tell the truth on a fresh install.
if docker inspect "$BOX" >/dev/null 2>&1; then
  docker rm --force "$BOX" >/dev/null
  say "removed the previous $BOX (its data lives in the volumes, so nothing was lost)"
else
  say "no previous $BOX"
fi
# No --platform: the remote manifest is a single amd64 image and this host is x86_64, so the flag
# would be a no-op that only invites confusion.
# The published ports are on the server's own loopback. Nothing needs them (the relay reaches the
# gateway as http://titanbot-box:1340 over the titanbot network) but they make `ssh -L` debugging
# and the VNC desktop reachable without recreating the container.
docker run --detach --name "$BOX" \
  --network "$NET" \
  --restart unless-stopped \
  --label com.titanbot.role=box \
  --env SAND_SUPERVISOR_ENABLED=1 \
  --env SAND_BOX_AUTO_UPDATE=0 \
  --env SAND_USE_EXISTING_BOX_EXEC_DAEMON=1 \
  --env SAND_TREE_SITTER_NODE_DEPS=/home/box/deps \
  --env NODE_PATH=/home/box/deps \
  --env SAND_GATEWAY_BIND_HOST=0.0.0.0 \
  --env SAND_HOST_PORT=1340 \
  --env SAND_GATEWAY_TOKEN="$TOKEN" \
  --env SAND_BOX_STORE_SYNC=1 \
  --env SAND_BOX_STORE_LOCAL_DIR=/var/lib/sand-box-store \
  --env SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json \
  --env SAND_BACKEND_URL=https://api2.cursor.sh/ \
  --publish 127.0.0.1:1337:1337 \
  --publish 127.0.0.1:1339:1339 \
  --publish 127.0.0.1:1340:1340 \
  --publish 127.0.0.1:6080:6080 \
  --publish 127.0.0.1:6081:6081 \
  --publish 127.0.0.1:8790:8790 \
  --volume titanbot-box-workspace:/workspace \
  --volume titanbot-box-data:/home/box/sand-data \
  --volume titanbot-box-store:/var/lib/sand-box-store \
  --volume titanbot-box-chrome:/home/box/chrome-profile \
  --mount "type=bind,src=$ROOT/runtime/host-main.cjs,dst=/home/box/sand-host/host-main.cjs,readonly" \
  --mount "type=bind,src=$ROOT/runtime/box-exec-daemon,dst=/home/box/box-exec-daemon,readonly" \
  --mount "type=bind,src=$ROOT/credential,dst=/run/grok-bot,readonly" \
  "$BOX_IMAGE" >/dev/null
say "started $BOX on network $NET, gateway ports on 127.0.0.1 only"

step "box patches"
# The window-script repairs are a filesystem change inside the container: they survive a restart
# but not a recreate, which is exactly what just happened.
ok=no
for i in $(seq 1 60); do
  if docker exec "$BOX" test -f /usr/local/bin/start-window 2>/dev/null; then ok=yes; break; fi
  sleep 2
done
[ "$ok" = yes ] || { docker logs --tail 40 "$BOX"; die "/usr/local/bin/start-window never appeared in $BOX after 120 s"; }
say "start-window present after ~$(( i * 2 )) s"
sh "$ROOT/deploy/apply-start-window-fix.sh" "$BOX"
# learn-from-demonstration copies Chrome's History database and queries it with sqlite3, which the
# image does not ship.
if docker exec "$BOX" sh -c 'command -v sqlite3 >/dev/null 2>&1'; then
  say "sqlite3 already present in the box"
else
  docker exec "$BOX" sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq sqlite3' >/dev/null 2>&1 \
    && say "installed sqlite3 in the box" || say "WARNING: sqlite3 install failed; learn-from-demonstration's URL step will not work"
fi

step "gateway readiness"
# Probe the box directly first. If this fails the relay is not the problem, and saying so here
# saves an hour of looking at the wrong container.
code=000
for i in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' \
    http://127.0.0.1:1340/api/getHostStatus || true)"
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || { docker logs --tail 40 "$BOX"; die "the box gateway never answered getHostStatus with 200 (last: HTTP $code)"; }
say "box gateway answered getHostStatus 200 after ~$(( i * 2 )) s"

step "relay image"
docker build --quiet -t "$RELAY_IMAGE" -f "$ROOT/deploy/relay.Dockerfile" "$ROOT/deploy" >/dev/null \
  || die "the relay image failed to build; if apk could not find docker-cli, edit deploy/relay.Dockerfile per its comment"
say "built $RELAY_IMAGE"

step "relay container"
if [ ! -f "$ROOT/ui/endpoints.json" ]; then
  say "WARNING: $ROOT/ui/endpoints.json is missing, so the model picker will be empty and no agent"
  say "         can answer. See operator checklist item 6 in deploy/r750/README.md. The relay still starts."
fi
relay_run
relay_join_route_network

step "end-to-end readiness through the relay"
code=000
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST -H 'content-type: application/json' -d '{}' \
    "http://$RELAY_BIND:$RELAY_PORT/api/getHostStatus" || true)"
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || { docker logs --tail 40 "$RELAY"; die "getHostStatus through the relay never returned 200 (last: HTTP $code)"; }
# No authorization header was sent above, on purpose: a 200 proves the relay injected the bearer,
# which is the whole reason it exists -- and is also exactly why reaching the relay is equivalent
# to holding the gateway token. See route_exposure_warning in common.sh and README item 4.
say "getHostStatus through the relay: HTTP 200 with no client-side auth header, so the relay is injecting the bearer"
curl -s -m 5 -X POST -H 'content-type: application/json' -d '{}' \
  "http://$RELAY_BIND:$RELAY_PORT/api/getHostStatus" | head -c 300; echo
# The docker socket is the piece most likely to be silently broken, and its failure mode is an
# empty model picker rather than an error. Prove it here.
if [ "$(docker exec "$RELAY" docker inspect "$BOX" --format '{{.State.Running}}' 2>/dev/null)" = true ]; then
  say "the relay can drive docker (socket mount and CLI both work), so the endpoint picker will work"
else
  say "WARNING: the relay cannot run 'docker inspect'. The console will load but the model picker and"
  say "         the connector editor will silently return nothing."
fi

printf '\n== done\n'
say "console      http://$RELAY_BIND:$RELAY_PORT/"
say "operator     http://$RELAY_BIND:$RELAY_PORT/operator"
say "token file   $TOKEN_FILE  (mode $(stat -c %a "$TOKEN_FILE"), never printed)"
say "containers   $BOX, $RELAY  on network $NET"
if route_enabled; then
  say "route        ON: https://$ROUTE_HOST is served through Coolify's proxy"
else
  say "route        OFF: no titanbot router exists in Coolify's proxy"
fi
say "next         deploy/r750/README.md items 1-6 are the operator steps for $ROUTE_HOST"
