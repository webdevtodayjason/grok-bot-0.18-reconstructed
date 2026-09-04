#!/usr/bin/env bash
# disable-route.sh -- take https://tb.semfreak.dev back down. Runs ON THE SERVER, as sem, no sudo.
#
# This is the complete rollback of enable-route.sh, and it exists because the obvious half-measure
# is not one. `docker network disconnect coolify titanbot-relay` only makes the backend
# unreachable: Traefik's docker provider still sees the container's labels, so the router and its
# middleware stay registered and the host keeps answering (with a 502 instead of a 403). The router
# goes away only when the labels do, and labels can only be removed by recreating the container.
#
#   bash /home/sem/titanbot/deploy/disable-route.sh
#
# Leaves the relay running and still reachable on the tailnet at 100.110.83.82:7787.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

step "marker"
if [ -f "$ROUTE_MARKER" ]; then rm -f "$ROUTE_MARKER"; say "removed $ROUTE_MARKER"
else say "no $ROUTE_MARKER, so the route was already off"; fi

step "detach from the $ROUTE_NETWORK network"
if docker inspect "$RELAY" >/dev/null 2>&1 \
  && docker network inspect "$ROUTE_NETWORK" --format '{{range $k, $v := .Containers}}{{$v.Name}} {{end}}' 2>/dev/null | grep -qw "$RELAY"; then
  docker network disconnect "$ROUTE_NETWORK" "$RELAY"
  say "disconnected $RELAY from $ROUTE_NETWORK"
else
  say "$RELAY was not on the $ROUTE_NETWORK network"
fi

step "recreate the relay without its Traefik labels"
if docker inspect "$RELAY" >/dev/null 2>&1; then
  relay_run
else
  say "no $RELAY container to recreate; the labels are gone with it"
fi

step "verify the router is gone"
PROXY="${TITANBOT_PROXY_CONTAINER:-coolify-proxy}"
code="$(curl -sk -o /dev/null -w '%{http_code}' -m 10 --resolve "$ROUTE_HOST:443:127.0.0.1" "https://$ROUTE_HOST/" || true)"
say "https://$ROUTE_HOST/ from this host: HTTP $code"
say "  503 or 404 is the answer for a host with no router, which is what you want here"
say "  403 means a titanbot router is still registered; check 'docker inspect $RELAY' for traefik labels"
if docker inspect "$PROXY" >/dev/null 2>&1; then
  # Match on titanbot@docker alone: Traefik colourises its log, so an ANSI escape sits between
  # `routerName=` and the value and a longer pattern silently matches nothing.
  n="$(docker logs --since 60s "$PROXY" 2>&1 | grep -c 'titanbot@docker' || true)"
  say "titanbot router lines in the last 60 s of $PROXY's log: $n (0 is the goal; Traefik can take"
  say "  a minute to converge, so a few trailing lines right after this run are normal)"
fi

printf '\n== done\n'
say "route OFF. The relay is still up on http://$RELAY_BIND:$RELAY_PORT/"
