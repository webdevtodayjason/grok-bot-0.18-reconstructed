#!/usr/bin/env bash
# uninstall.sh -- remove everything this deploy created, and nothing else. Runs ON THE SERVER.
#
# The volumes hold every agent, transcript and workspace the box has, so they are NOT removed
# without being asked for. Everything else goes: two containers, the relay image tag, the network,
# and the install tree. The pinned box image is 5.2 GB and re-pulling it is slow, so it stays
# unless --purge-image is passed.
#
#   bash /home/sem/titanbot/deploy/uninstall.sh                 containers, network, tree; volumes prompted
#   bash /home/sem/titanbot/deploy/uninstall.sh --keep-volumes  never asks, keeps the data
#   bash /home/sem/titanbot/deploy/uninstall.sh --volumes       never asks, DELETES the data
#   bash /home/sem/titanbot/deploy/uninstall.sh --purge-image   also drops the 5.2 GB box image
#
# It writes no Traefik configuration file, creates no Coolify record, and touches no DNS entry or
# certificate. It does end the tb.semfreak.dev route, because that route is nothing but labels on
# titanbot-relay: removing the container removes the labels, and the router disappears with them.
# Everything else about the proxy is an operator object; the last thing this prints is what is
# left for the operator to undo by hand.
set -euo pipefail

ROOT="${TITANBOT_ROOT:-/home/sem/titanbot}"
BOX=titanbot-box
RELAY=titanbot-relay
NET=titanbot
RELAY_IMAGE=titanbot-relay:local
BOX_IMAGE="public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:d0bb69285340df19d73f106492c7aabb723e8a950809b9f53a884888e2b4c709"
VOLUMES="titanbot-box-workspace titanbot-box-data titanbot-box-store titanbot-box-chrome"

# This script deletes $ROOT, so it must not be standing in it. Its own file lives under $ROOT and
# gets unlinked at the end; bash keeps reading through the open descriptor, which is why that is
# the last step rather than the first.
cd /

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

DROP_VOLUMES=ask
PURGE_IMAGE=no
for arg in "$@"; do
  case "$arg" in
    --volumes) DROP_VOLUMES=yes ;;
    --keep-volumes) DROP_VOLUMES=no ;;
    --purge-image) PURGE_IMAGE=yes ;;
    *) printf 'unknown flag: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

step "containers"
for c in "$RELAY" "$BOX"; do
  if docker inspect "$c" >/dev/null 2>&1; then docker rm --force "$c" >/dev/null; say "removed container $c"
  else say "no container $c"; fi
done

step "relay image"
if docker image inspect "$RELAY_IMAGE" >/dev/null 2>&1; then docker rmi "$RELAY_IMAGE" >/dev/null; say "removed image $RELAY_IMAGE"
else say "no image $RELAY_IMAGE"; fi

step "network"
if docker network inspect "$NET" >/dev/null 2>&1; then docker network rm "$NET" >/dev/null; say "removed network $NET"
else say "no network $NET"; fi

step "volumes"
present=""
for v in $VOLUMES; do docker volume inspect "$v" >/dev/null 2>&1 && present="$present $v"; done
if [ -z "$present" ]; then
  say "none of the titanbot volumes exist"
else
  if [ "$DROP_VOLUMES" = ask ]; then
    # These carry every agent and transcript on the box. Asking is the point.
    printf '  these volumes hold ALL agent data, transcripts and workspaces:%s\n' "$present"
    printf '  delete them? type exactly "delete" to confirm: '
    read -r answer || answer=""
    [ "$answer" = delete ] && DROP_VOLUMES=yes || DROP_VOLUMES=no
  fi
  if [ "$DROP_VOLUMES" = yes ]; then
    for v in $present; do docker volume rm "$v" >/dev/null; say "removed volume $v"; done
  else
    say "kept:$present  (a later install.sh will adopt them again)"
  fi
fi

step "box image"
if [ "$PURGE_IMAGE" = yes ]; then
  docker rmi "$BOX_IMAGE" >/dev/null 2>&1 && say "removed the 5.2 GB box image" || say "the box image was not present"
else
  say "kept the 5.2 GB box image; pass --purge-image to drop it"
fi

step "install tree"
if [ -d "$ROOT" ]; then
  rm -rf "$ROOT"
  say "removed $ROOT (including the gateway token file; a later install mints a new one)"
else
  say "no $ROOT"
fi

printf '\n== what this did and did not touch\n'
say "the tb.semfreak.dev route is GONE: it lived only as Traefik labels on the titanbot-relay"
say "container, and Traefik's docker provider drops a router as soon as its container does."
say "the coolify network itself is untouched; the relay simply is not on it any more."
printf '\n== operator undo, which this script will not do for you\n'
say "1. the DNS-01 certificate resolver you added to coolify-proxy for tb.semfreak.dev is still"
say "   there, and so is its CF_DNS_API_TOKEN. Remove them if this install is not coming back."
say "2. the tb.semfreak.dev DNS record still points at 100.110.83.82."
say "3. the Cloudflare API token you minted is still valid. Revoke it if it was only for this."
say "no Coolify record was created or deleted, no Traefik configuration file was written or read,"
say "and no container, volume or network not named titanbot-* was changed."
