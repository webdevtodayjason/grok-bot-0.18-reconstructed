#!/usr/bin/env bash
# enable-route.sh -- publish the relay at https://tb.semfreak.dev through Coolify's Traefik.
# Runs ON THE SERVER, as sem, no sudo. This is the cutover, and it is deliberately not part of
# install.sh.
#
# Why it is separate: Traefik's docker provider watches EVERY container on this docker host, not
# only the containers on its own networks. A `traefik.*` label therefore creates a live router the
# instant the container is created, whether or not it is reachable and whether or not the operator
# was ready. Keeping the labels out of install.sh is what makes "installed" and "published" two
# different states.
#
# What it changes, and nothing else:
#   1. writes the marker file $ROOT/route.enabled
#   2. recreates titanbot-relay with its Traefik labels (labels cannot be added to a live container)
#   3. attaches titanbot-relay to the coolify network so Traefik can reach it by name
# It writes no Coolify record, no compose file and no Traefik configuration file.
#
#   bash /home/sem/titanbot/deploy/enable-route.sh          asks first
#   bash /home/sem/titanbot/deploy/enable-route.sh --yes    for a scripted cutover
#
# Undo: deploy/disable-route.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

ASSUME_YES=no
[ "${1:-}" = --yes ] && ASSUME_YES=yes

step "preconditions"
docker inspect "$RELAY" >/dev/null 2>&1 || die "$RELAY does not exist; run install.sh first"
docker network inspect "$ROUTE_NETWORK" >/dev/null 2>&1 || die "there is no $ROUTE_NETWORK network on this host"
say "$RELAY exists and the $ROUTE_NETWORK network is present"

# The certificate resolver named in the label has to be one the proxy actually has, or Traefik logs
# "Router uses a nonexistent certificate resolver" on a loop into a production proxy's log and
# serves its self-signed default. Read the proxy's own command line rather than trusting the docs.
PROXY="${TITANBOT_PROXY_CONTAINER:-coolify-proxy}"
if docker inspect "$PROXY" >/dev/null 2>&1; then
  CMD="$(docker inspect "$PROXY" --format '{{json .Config.Cmd}}')"
  if printf '%s' "$CMD" | grep -q "certificatesresolvers\.$ROUTE_CERTRESOLVER\.acme"; then
    say "$PROXY has a resolver named $ROUTE_CERTRESOLVER"
  else
    say "WARNING: $PROXY has NO resolver named $ROUTE_CERTRESOLVER. Traefik will log"
    say "         'nonexistent certificate resolver' every few seconds and serve its self-signed"
    say "         default certificate. Fix README item 1 first, or set TITANBOT_ROUTE_CERTRESOLVER"
    say "         to the resolver the proxy really has."
  fi
  if printf '%s' "$CMD" | grep -q "certificatesresolvers\.$ROUTE_CERTRESOLVER\.acme\.dnschallenge"; then
    say "that resolver uses a DNS-01 challenge, which is the only kind that can work for $ROUTE_HOST"
  else
    say "WARNING: resolver $ROUTE_CERTRESOLVER has no dnschallenge. $ROUTE_HOST resolves to a tailnet"
    say "         address Let's Encrypt cannot reach, so an HTTP-01 challenge fails every time."
  fi
else
  say "WARNING: no $PROXY container, so the resolver could not be checked"
fi

step "what this exposes"
route_exposure_warning
say ""
say "Traefik's ipallowlist ($ROUTE_ALLOW) covers traffic that arrives through the proxy on 443."
say "It does NOT cover the other containers on the $ROUTE_NETWORK network: they reach"
say "http://$RELAY:7777/api/* directly, with no middleware in the path. What they still have to"
say "get past is the relay's own login, which is the same password a person types."
say "$(docker network inspect "$ROUTE_NETWORK" --format '{{len .Containers}}') containers are on that network right now."

if [ "$ASSUME_YES" = no ]; then
  printf '\n  publish %s and accept the above? type exactly "enable" to confirm: ' "$ROUTE_HOST"
  read -r answer || answer=""
  [ "$answer" = enable ] || { printf '\n'; say "nothing changed"; exit 1; }
fi

step "enable"
: > "$ROUTE_MARKER"
say "wrote $ROUTE_MARKER, so install.sh will keep the route on every future redeploy"
relay_run
relay_join_route_network

step "verify"
# From inside the proxy, by container name: this is the exact path Traefik will use, so a failure
# here is the failure the browser would have seen.
if docker exec "$PROXY" wget -qO- --timeout=5 "http://$RELAY:7777/" >/dev/null 2>&1; then
  say "$PROXY can reach http://$RELAY:7777/"
else
  say "WARNING: $PROXY could not fetch http://$RELAY:7777/. The route will 502."
fi
code="$(curl -sk -o /dev/null -w '%{http_code}' -m 10 --resolve "$ROUTE_HOST:443:127.0.0.1" "https://$ROUTE_HOST/" || true)"
say "https://$ROUTE_HOST/ from this host (which is not in the allowlist as 127.0.0.1): HTTP $code"
say "  403 means the router and its IP allowlist are both live, which is the expected answer here"
say "  404 or 503 means Traefik has not picked the container up yet; give it a few seconds"

printf '\n== done\n'
say "route ON. Undo with: bash $HERE/disable-route.sh"
say "still untested from here: a request from an address that is neither tailnet nor LAN must 403,"
say "and the certificate must be one a browser accepts rather than Traefik's default."
