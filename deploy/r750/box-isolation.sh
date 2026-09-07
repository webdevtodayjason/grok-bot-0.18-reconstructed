#!/usr/bin/env bash
# box-isolation.sh -- one customer's box cannot reach another customer's box.
#
# THE HOLE THIS CLOSES, measured on the R750 2026-09-07. TENANT-5 put every customer's box on one
# shared docker network, titanbot-net, because one relay now serves everybody and has to reach
# every box. Containers on one bridge talk to each other freely. From inside the demo tenant's box,
# a bounded port scan of the operator's box answered OPEN on 1340, 6080 and 6081. 1340 is the
# gateway and correctly refuses without a bearer. 6080 does not: a plain websocket GET /websockify
# answered "101 Switching Protocols", the first frame back was "RFB 003.008" and the server offered
# security type 1, None. That is one customer holding another customer's screen and keyboard with
# no credential at all, and the scan is symmetric. The same bridge also carried the control plane,
# whose /v1/health answered, and Coolify's own proxy.
#
# So the tenant boundary the whole contract rests on -- "one box container is what makes one
# customer's agents unreachable from another's" -- did not hold on that network, and nothing in
# the wave measured it.
#
# WHAT THIS DOES. A box has exactly one thing to say on that network: it fetches its host bundle
# from http://titanbot-relay:7777/runtime/<token>. Nothing else on the bridge is a peer it needs --
# the relay reaches the box, the control plane waits for a box, and neither is ever called by one.
# So the rule is that shape: from a box, on this bridge, the relay's port 7777 and nothing else.
#
#   iptables -N TITANBOT-ISO
#   -i br-<net> -o br-<net> -s <each box> -d <relay> -p tcp --dport 7777 -j RETURN
#   -i br-<net> -o br-<net> -s <each box>                              -j DROP
#   DOCKER-USER jumps to it, first, so an earlier RETURN cannot let something past.
#
# Both -i and -o name the shared bridge, so nothing here touches a box's route to the internet, to
# its own Coolify network, or to the host. Traffic between DIFFERENT docker bridges is already
# dropped by docker's own DOCKER-ISOLATION-STAGE chains; this is the same-bridge case docker does
# not cover. Replies from the relay are not matched, because the source of a reply is the relay.
#
#   sudo bash box-isolation.sh            apply, and print what it applied
#   sudo bash box-isolation.sh --verify   scan every box from every other box and fail on any port
#   bash box-isolation.sh --show          print the rules that are installed, no root needed
#
# It is idempotent: the chain is flushed and rebuilt every run, so a box that appeared since the
# last run is covered and a box that has gone leaves no rule behind. That is why it runs on a
# timer (deploy/r750/titanbot-isolation.timer): a box created by the control plane at 03:00 has to
# be covered without anybody being awake, and the control plane has no route to the host's
# firewall.
#
# Env, all optional:
#   TITANBOT_NET     the shared network, default titanbot-net
#   TITANBOT_RELAY   the relay container, default the one carrying com.titanbot.role=relay
#   TITANBOT_CHAIN   the iptables chain, default TITANBOT-ISO
#   TITANBOT_RELAY_PORT  default 7777
set -uo pipefail

NET="${TITANBOT_NET:-titanbot-net}"
CHAIN="${TITANBOT_CHAIN:-TITANBOT-ISO}"
RELAY_PORT="${TITANBOT_RELAY_PORT:-7777}"
MODE=apply
case "${1:-}" in
  --verify) MODE=verify ;;
  --show) MODE=show ;;
  "") MODE=apply ;;
  *) echo "usage: $0 [--verify|--show]" >&2; exit 64 ;;
esac

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not on PATH"

# sudo -n when this is not already root, so the timer's unit and a hand run read the same.
IPT=(iptables)
if [ "$(id -u)" != 0 ]; then IPT=(sudo -n iptables); fi

# The bridge docker made for this network. Its name is br-<first 12 of the network id> unless the
# operator named it, in which case docker records the name in the network's options.
NET_ID="$(docker network inspect "$NET" --format '{{.Id}}' 2>/dev/null)"
[ -n "$NET_ID" ] || die "there is no docker network called $NET on this host"
BR="$(docker network inspect "$NET" --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null)"
[ -n "$BR" ] && [ "$BR" != "<no value>" ] || BR="br-${NET_ID:0:12}"
ip link show "$BR" >/dev/null 2>&1 || die "$NET is network $NET_ID but there is no interface called $BR"

# Every container on this network, name and address. One call, docker's own view.
mapfile -t ON_NET < <(docker network inspect "$NET" \
  --format '{{range $id, $c := .Containers}}{{$c.Name}} {{$c.IPv4Address}}{{println}}{{end}}' \
  | sed 's#/[0-9]*$##' | grep -v '^ *$' | sort)

address_of() { printf '%s\n' "${ON_NET[@]}" | awk -v n="$1" '$1 == n { print $2 }' | head -n 1; }

# The boxes, by the label every install carries, intersected with what is actually on this network.
mapfile -t BOX_NAMES < <(docker ps --filter label=com.titanbot.role=box --format '{{.Names}}' | sort)
BOX_ADDRS=()
BOX_LIST=()
for name in "${BOX_NAMES[@]}"; do
  addr="$(address_of "$name")"
  [ -n "$addr" ] || continue
  BOX_ADDRS+=("$addr")
  BOX_LIST+=("$name $addr")
done

RELAY_NAME="${TITANBOT_RELAY:-$(docker ps --filter label=com.titanbot.role=relay --format '{{.Names}}' | head -n 1)}"
RELAY_ADDR="$(address_of "$RELAY_NAME")"

step "$NET on $BR"
say "network $NET_ID"
say "relay   ${RELAY_NAME:-none} ${RELAY_ADDR:-(not on this network)}"
if [ "${#BOX_LIST[@]}" -eq 0 ]; then say "boxes   none on this network"; else
  for row in "${BOX_LIST[@]}"; do say "box     $row"; done
fi

if [ "$MODE" = show ]; then
  step "installed rules"
  "${IPT[@]}" -S "$CHAIN" 2>/dev/null || say "the chain $CHAIN is not installed"
  exit 0
fi

if [ "$MODE" = verify ]; then
  # The scan the reviewer ran, run from every box against every other box. A box that can open a
  # TCP connection to another box on any of these ports is the finding, not a warning: 6080 is the
  # shared VNC seat and it offers security type None.
  step "cross-box scan"
  [ "${#BOX_LIST[@]}" -ge 2 ] || { say "only ${#BOX_LIST[@]} box on this network, so there is no pair to scan"; exit 0; }
  bad=0
  for from in "${BOX_LIST[@]}"; do
    from_name="${from%% *}"; from_addr="${from##* }"
    for to in "${BOX_LIST[@]}"; do
      to_name="${to%% *}"; to_addr="${to##* }"
      [ "$from_name" = "$to_name" ] && continue
      open="$(docker exec "$from_name" bash -c '
        for p in 1340 6080 6081; do
          timeout 2 bash -c "exec 3<>/dev/tcp/'"$to_addr"'/$p" 2>/dev/null && printf "%s " "$p"
        done' 2>/dev/null)"
      if [ -n "$(printf '%s' "$open" | tr -d ' ')" ]; then
        say "OPEN  $from_name -> $to_name ($to_addr): $open"
        bad=$((bad + 1))
      else
        say "closed $from_name -> $to_name ($to_addr): nothing answered on 1340, 6080, 6081"
      fi
    done
  done
  # And the one thing a box IS allowed: its own bundle route on the relay.
  if [ -n "$RELAY_ADDR" ]; then
    for from in "${BOX_LIST[@]}"; do
      from_name="${from%% *}"
      if docker exec "$from_name" bash -c "timeout 2 bash -c 'exec 3<>/dev/tcp/$RELAY_ADDR/$RELAY_PORT'" 2>/dev/null; then
        say "ok     $from_name reaches the relay on $RELAY_PORT, which is where its host bundle comes from"
      else
        say "BROKEN $from_name cannot reach the relay on $RELAY_PORT; its host bundle will never update"
        bad=$((bad + 1))
      fi
    done
  fi
  [ "$bad" = 0 ] || die "$bad box-to-box path(s) are open, or a box lost the one path it needs"
  printf '\nPASS  no box reaches another box, and every box reaches the relay\n'
  exit 0
fi

# ---- apply -------------------------------------------------------------------------------------
step "rules"
"${IPT[@]}" -n -L "$CHAIN" >/dev/null 2>&1 || "${IPT[@]}" -N "$CHAIN" || die "could not create the chain $CHAIN (root?)"
"${IPT[@]}" -F "$CHAIN" || die "could not flush $CHAIN"

if [ -n "$RELAY_ADDR" ]; then
  for addr in "${BOX_ADDRS[@]}"; do
    "${IPT[@]}" -A "$CHAIN" -i "$BR" -o "$BR" -s "$addr" -d "$RELAY_ADDR" -p tcp --dport "$RELAY_PORT" \
      -m comment --comment "titanbot: a box fetches its host bundle" -j RETURN \
      || die "could not add the relay exception for $addr"
  done
else
  say "WARNING: no relay on this network, so no box will be able to fetch a host bundle"
fi
for addr in "${BOX_ADDRS[@]}"; do
  "${IPT[@]}" -A "$CHAIN" -i "$BR" -o "$BR" -s "$addr" \
    -m comment --comment "titanbot: one customer's box reaches nothing else on this bridge" -j DROP \
    || die "could not add the drop for $addr"
done

# First in DOCKER-USER, so a RETURN somebody added earlier cannot carry box-to-box traffic past it.
"${IPT[@]}" -C DOCKER-USER -j "$CHAIN" >/dev/null 2>&1 || "${IPT[@]}" -I DOCKER-USER 1 -j "$CHAIN" \
  || die "could not hook $CHAIN into DOCKER-USER"

"${IPT[@]}" -S "$CHAIN" | sed 's/^/  /'
say "${#BOX_ADDRS[@]} box(es) isolated on $BR"
