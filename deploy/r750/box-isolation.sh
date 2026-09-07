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
# IT HAS TO BE THE BRIDGE FAMILY, and the first attempt got that wrong. Two containers on one
# docker network are in one subnet on one bridge, so their packets are SWITCHED at layer 2 and
# never routed. Netfilter's ip hooks (which is where iptables, DOCKER-USER and docker's own
# icc rules all live) see bridged frames only when br_netfilter is loaded, and on this host it is
# not: /proc/sys/net/bridge does not exist. Measured 2026-09-07, an iptables DROP in DOCKER-USER
# matching exactly this traffic counted zero packets while the scan above still answered OPEN.
#
# nftables' BRIDGE family hooks the bridge's own forward path, so it sees the frames without
# br_netfilter and without touching any other bridge on the machine:
#
#   table bridge titanbot_isolation {
#     chain boxes {
#       type filter hook forward priority -300; policy accept;
#       meta ibrname "br-<net>" ip saddr @boxes ip daddr <relay> tcp dport 7777 accept
#       meta ibrname "br-<net>" ip saddr @boxes drop
#     }
#   }
#
# The bridge forward hook is container-to-container on that bridge and nothing else, so a box's
# route to the internet, to its own Coolify network and to the host are all untouched: those leave
# the bridge rather than crossing it. Replies from the relay are not matched, because the source of
# a reply is the relay. ARP is not matched either (an ARP frame has no ip saddr), so a box still
# resolves names and simply times out on the addresses it may not have.
#
#   sudo bash box-isolation.sh            apply, and print what it applied
#   sudo bash box-isolation.sh --verify   scan every box from every other box and fail on any port
#   bash box-isolation.sh --show          print the rules that are installed
#
# It is idempotent: the whole table is replaced in one nft transaction every run, so a box that
# appeared since the last run is covered and a box that has gone leaves no rule behind. That is why
# it runs on a timer (deploy/r750/titanbot-isolation.timer): a box created by the control plane at
# 03:00 has to be covered without anybody being awake, and the control plane has no route to the
# host's firewall.
#
# Env, all optional:
#   TITANBOT_NET     the shared network, default titanbot-net
#   TITANBOT_RELAY   the relay container, default the one carrying com.titanbot.role=relay
#   TITANBOT_TABLE   the nft table, default titanbot_isolation
#   TITANBOT_RELAY_PORT  default 7777
set -uo pipefail

NET="${TITANBOT_NET:-titanbot-net}"
TABLE="${TITANBOT_TABLE:-titanbot_isolation}"
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
command -v nft >/dev/null || die "nft is not on PATH; this needs nftables (the bridge family is what sees bridged frames)"

# sudo -n when this is not already root, so the timer's unit and a hand run read the same.
NFT=(nft)
if [ "$(id -u)" != 0 ]; then NFT=(sudo -n nft); fi

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
  "${NFT[@]}" list table bridge "$TABLE" 2>/dev/null || say "the table bridge $TABLE is not installed"
  exit 0
fi

if [ "$MODE" = verify ]; then
  # The scan the reviewer ran, run from every box against every other box. A box that can open a
  # TCP connection to another box on any of these ports is the finding, not a warning: 6080 is the
  # shared VNC seat and it offers security type None.
  step "cross-box scan"
  [ "${#BOX_LIST[@]}" -ge 2 ] || { say "only ${#BOX_LIST[@]} box on this network, so there is no pair to scan"; printf '\nPASS  nothing to scan\n'; exit 0; }
  bad=0
  for from in "${BOX_LIST[@]}"; do
    from_name="${from%% *}"
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
      if docker exec "$from_name" bash -c "timeout 3 bash -c 'exec 3<>/dev/tcp/$RELAY_ADDR/$RELAY_PORT'" 2>/dev/null; then
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
if [ "${#BOX_ADDRS[@]}" -eq 0 ]; then
  say "no box on this network, so there is nothing to isolate"
fi
SET="$(IFS=, ; printf '%s' "${BOX_ADDRS[*]:-}")"
{
  # The add-then-delete pair makes this work whether or not the table is already there, and nft
  # applies the whole file as one transaction, so there is no moment with half a policy in place.
  printf 'table bridge %s { }\n' "$TABLE"
  printf 'delete table bridge %s\n' "$TABLE"
  printf 'table bridge %s {\n' "$TABLE"
  printf '  chain boxes {\n'
  printf '    type filter hook forward priority -300; policy accept;\n'
  if [ -n "$SET" ]; then
    if [ -n "$RELAY_ADDR" ]; then
      printf '    meta ibrname "%s" ip saddr { %s } ip daddr %s tcp dport %s accept comment "a box fetches its host bundle"\n' \
        "$BR" "$SET" "$RELAY_ADDR" "$RELAY_PORT"
    fi
    printf '    meta ibrname "%s" ip saddr { %s } drop comment "one customer box reaches nothing else on this bridge"\n' \
      "$BR" "$SET"
  fi
  printf '  }\n}\n'
} | "${NFT[@]}" -f - || die "nft would not load the rules (root? nftables bridge support?)"

# The first version of this script wrote an iptables chain, which counted zero packets because
# bridged frames never reach the ip hooks on this host. Taken out here so a machine that ran it
# once is not left carrying a chain that does nothing.
if [ "$(id -u)" = 0 ]; then IPT=(iptables); else IPT=(sudo -n iptables); fi
if "${IPT[@]}" -n -L TITANBOT-ISO >/dev/null 2>&1; then
  "${IPT[@]}" -D DOCKER-USER -j TITANBOT-ISO >/dev/null 2>&1
  "${IPT[@]}" -F TITANBOT-ISO >/dev/null 2>&1 && "${IPT[@]}" -X TITANBOT-ISO >/dev/null 2>&1 \
    && say "removed the old iptables chain, which never saw a bridged frame"
fi

"${NFT[@]}" list table bridge "$TABLE" | sed 's/^/  /'
say "${#BOX_ADDRS[@]} box(es) isolated on $BR"
