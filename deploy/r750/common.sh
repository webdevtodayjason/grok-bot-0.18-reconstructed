#!/usr/bin/env bash
# common.sh -- names, defaults, and the relay container definition. Sourced by install.sh,
# enable-route.sh and disable-route.sh. Never run on its own.
#
# The relay's `docker run` lives in one place for a concrete reason: docker labels cannot be
# changed after a container is created, so turning the public tb.semfreak.dev route on or off
# means recreating the relay. Two scripts therefore need the identical run line, and a second
# copy that drifted would quietly change the relay's mounts or environment at cutover time,
# which is the worst moment to discover it.

ROOT="${TITANBOT_ROOT:-/home/sem/titanbot}"
RELAY_BIND="${TITANBOT_RELAY_BIND:-100.110.83.82}"
RELAY_PORT="${TITANBOT_RELAY_PORT:-7787}"
NET=titanbot
BOX=titanbot-box
RELAY=titanbot-relay
RELAY_IMAGE=titanbot-relay:local

# The public route, all of it operator-owned. ROUTE_MARKER is the consent record: no marker, no
# Traefik labels on the container, and therefore no router in Coolify's proxy at all.
ROUTE_MARKER="$ROOT/route.enabled"
ROUTE_HOST="${TITANBOT_ROUTE_HOST:-tb.semfreak.dev}"
ROUTE_NETWORK="${TITANBOT_ROUTE_NETWORK:-coolify}"
# Coolify's proxy ships exactly one resolver and it is named `letsencrypt`; its own DNS-challenge
# documentation extends that resolver rather than adding a second one. The label must name the
# resolver that actually exists, or Traefik logs "nonexistent certificate resolver" on a loop and
# serves its self-signed default. Override only if you really did create a differently named one.
ROUTE_CERTRESOLVER="${TITANBOT_ROUTE_CERTRESOLVER:-letsencrypt}"
# 100.64.0.0/10 is the tailnet, 192.168.0.0/24 is the LAN.
ROUTE_ALLOW="${TITANBOT_ROUTE_ALLOW:-100.64.0.0/10,192.168.0.0/24}"

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

route_enabled() { [ -f "$ROUTE_MARKER" ]; }

# Recreate the relay. Its state is the token file and the UI tree on the host, so removing and
# recreating the container loses nothing.
relay_run() {
  local -a labels=( --label com.titanbot.role=relay )
  if route_enabled; then
    # Traefik's docker provider watches EVERY container on this docker host, not just the ones on
    # its own networks. These labels create a live router the moment the container is created, so
    # they are attached only when the operator has enabled the route.
    labels+=(
      --label traefik.enable=true
      --label "traefik.docker.network=$ROUTE_NETWORK"
      --label "traefik.http.routers.titanbot.rule=Host(\`$ROUTE_HOST\`)"
      --label traefik.http.routers.titanbot.entrypoints=https
      --label traefik.http.routers.titanbot.tls=true
      --label "traefik.http.routers.titanbot.tls.certresolver=$ROUTE_CERTRESOLVER"
      --label traefik.http.routers.titanbot.middlewares=titanbot-allow@docker
      --label traefik.http.services.titanbot.loadbalancer.server.port=7777
      --label "traefik.http.middlewares.titanbot-allow.ipallowlist.sourcerange=$ROUTE_ALLOW"
    )
  fi

  if docker inspect "$RELAY" >/dev/null 2>&1; then
    docker rm --force "$RELAY" >/dev/null
    say "removed the previous $RELAY"
  else
    say "no previous $RELAY"
  fi

  # The whole ui tree has to be mounted read-write, because server.mjs writes endpoints.json when
  # the operator saves a model. The password file is bound over the top of it read-only, so
  # nothing running in this container can rewrite the hash or the cookie signing secret. Only when
  # it exists: docker creates a DIRECTORY at a bind source that is missing, and a directory named
  # auth.json would fail to parse and take the relay down with it.
  local -a authmount=()
  if [ -f "$ROOT/ui/auth.json" ]; then
    authmount=( --mount "type=bind,src=$ROOT/ui/auth.json,dst=/app/ui/auth.json,readonly" )
  fi

  # The docker socket is mounted read-write and that makes this container root-equivalent on the
  # host. It is not optional: server.mjs reads and writes the box's secrets, connectors and window
  # surfaces exclusively through `docker exec`, because those files live in a volume with no host
  # path. README.md item 8 says this out loud so the decision is the operator's, not an accident.
  # The Titan Job Bus bearer (docs/JOB-BUS.md §2), passed through only when the operator set it in
  # this shell. An EMPTY variable is not the same as an absent one here: the relay's resolution
  # order is env, then the token file the console writes, then 503, and an exported empty string
  # would be an env value that resolves to nothing while the console's own file sat unread.
  local -a jobtoken=()
  if [ -n "${TITAN_JOB_TOKEN:-}" ]; then
    jobtoken=( --env "TITAN_JOB_TOKEN=$TITAN_JOB_TOKEN" )
    say "passing TITAN_JOB_TOKEN through to the relay (it wins over the console's token file)"
  fi

  docker run --detach --name "$RELAY" \
    --network "$NET" \
    --restart unless-stopped \
    "${labels[@]}" \
    ${jobtoken[@]+"${jobtoken[@]}"} \
    --publish "$RELAY_BIND:$RELAY_PORT:7777" \
    --env SAND_UI_PORT=7777 \
    --env SAND_UI_BIND_HOST=0.0.0.0 \
    --env SAND_HOST_GATEWAY_URL="http://$BOX:1340" \
    --env SAND_BOX_CONTAINER="$BOX" \
    --env SAND_PROFILE_DIRS=/profile \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "$ROOT/ui:/app/ui" \
    --volume "$ROOT/profile:/profile:ro" \
    ${authmount[@]+"${authmount[@]}"} \
    "$RELAY_IMAGE" node /app/ui/server.mjs >/dev/null

  if route_enabled; then
    say "started $RELAY WITH the $ROUTE_HOST Traefik labels (the route marker is present)"
  else
    say "started $RELAY with no Traefik labels, so Coolify's proxy has no titanbot router"
  fi
  say "published on $RELAY_BIND:$RELAY_PORT only"
}

# Rejoining the shared network belongs with the recreate: a redeploy that dropped the route would
# leave tb.semfreak.dev answering 404 with nothing in any log to say why.
relay_join_route_network() {
  route_enabled || return 0
  if docker network inspect "$ROUTE_NETWORK" --format '{{range $k, $v := .Containers}}{{$v.Name}} {{end}}' 2>/dev/null | grep -qw "$RELAY"; then
    say "$RELAY is already on the $ROUTE_NETWORK network"
  else
    docker network connect "$ROUTE_NETWORK" "$RELAY" || die "could not attach $RELAY to the $ROUTE_NETWORK network"
    say "attached $RELAY to the $ROUTE_NETWORK network"
  fi
}

# Printed wherever the route is turned on or off, because it is the one consequence that is not
# visible in any command's output.
route_exposure_warning() {
  say "the relay asks for a password ($ROOT/ui/auth.json) and injects the gateway bearer into"
  say "every /api call it forwards, so a caller needs the password or that bearer to reach the"
  say "gateway surface, including shell in the box. That gate applies to every caller equally:"
  say "the other containers on the $ROUTE_NETWORK network reach http://$RELAY:7777 directly,"
  say "and Traefik's IP allowlist never sees container-to-container traffic, so the password is"
  say "the only thing standing between them and the box. Guessing it is rate limited to five"
  say "tries per thirty seconds per source; its strength is the operator's decision."
  say "See deploy/r750/README.md item 4."
}
