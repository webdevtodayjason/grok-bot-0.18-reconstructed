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
# WHAT THIS DOES. A box has exactly two things to say on that network: it fetches its host bundle
# from http://titanbot-relay:7777/runtime/<token>, and since PROXY-1 it asks the proxy for an answer
# at http://titanbot-proxy:4000. Nothing else on the bridge is a peer it needs -- the relay reaches
# the box, the control plane waits for a box, and neither is ever called by one. So the rule is that
# shape: from a box, on this bridge, those two addresses and ports, and nothing else.
#
# THE PROXY IS FOUND BY ITS LABEL, never by an address written down here. Coolify renames the
# container on every redeploy and docker hands out a fresh bridge address, so a literal in this file
# would be a rule that silently stops matching the day the service is rebuilt -- and the failure
# would be every customer's inference, not a log line. The relay has been discovered this way since
# this script was written; the proxy is discovered the same way, from com.titanbot.role=proxy.
#
# ITS DATABASE IS NOT ON THIS BRIDGE AT ALL. deploy/coolify/proxy.compose.yml puts titanbot-proxy-db
# on Coolify's own per-service network only, so a box has no route to it rather than a route with
# one rule standing in front. --verify measures that anyway: nothing on 5432.
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
#       meta ibrname "br-<net>" ip saddr @boxes ip daddr <proxy> tcp dport 4000 accept
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
#   TITANBOT_PROXY   the proxy container, default the one carrying com.titanbot.role=proxy
#   TITANBOT_TABLE   the nft table, default titanbot_isolation
#   TITANBOT_RELAY_PORT  default 7777
#   TITANBOT_PROXY_PORT  default 4000
#   TITANBOT_PROXY_DB_PORT  the port --verify proves a box CANNOT reach, default 5432
set -uo pipefail

NET="${TITANBOT_NET:-titanbot-net}"
TABLE="${TITANBOT_TABLE:-titanbot_isolation}"
RELAY_PORT="${TITANBOT_RELAY_PORT:-7777}"
PROXY_PORT="${TITANBOT_PROXY_PORT:-4000}"
PROXY_DB_PORT="${TITANBOT_PROXY_DB_PORT:-5432}"
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

# PROXY-1. Discovered exactly the way the relay is, from its role label, because Coolify renames the
# container on every redeploy and docker hands out a fresh address with it. An address written into
# this file would be a rule that quietly stops matching, and the symptom would be every customer's
# inference rather than a log line. Absent is not an error: on a host where the proxy has not been
# stood up yet there is simply no accept rule for it, and every box behaves exactly as it did before.
PROXY_NAME="${TITANBOT_PROXY:-$(docker ps --filter label=com.titanbot.role=proxy --format '{{.Names}}' | head -n 1)}"
PROXY_ADDR="$(address_of "$PROXY_NAME")"

step "$NET on $BR"
say "network $NET_ID"
say "relay   ${RELAY_NAME:-none} ${RELAY_ADDR:-(not on this network)}"
say "proxy   ${PROXY_NAME:-none} ${PROXY_ADDR:-(not on this network)}"
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
  # `broken` used to be counted with no starting value and never read, so every "BROKEN the console
  # cannot reach ..." line was printed and then thrown away: a run with a customer's console dead
  # still exited PASS. Initialised here and folded into the verdict below, which is what the line
  # said it was doing all along.
  broken=0
  bad=0
  if [ "${#BOX_LIST[@]}" -lt 2 ]; then
    say "only ${#BOX_LIST[@]} box on this network, so there is no pair to scan"
  else
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
  fi
  # And the one thing a box IS allowed: its own bundle route on the relay.
  #
  # The box-count guard is not decoration. The cross-box scan used to exit the whole run early when
  # there were fewer than two boxes, which meant these legs only ever ran with two; now that they run
  # with one box (where they are still worth running) they can also be reached with none, and
  # "${BOX_LIST[@]}" on an empty array under `set -u` is an unbound variable on bash 4.3 and older.
  if [ -n "$RELAY_ADDR" ] && [ "${#BOX_LIST[@]}" -gt 0 ]; then
    for from in "${BOX_LIST[@]}"; do
      from_name="${from%% *}"
      if docker exec "$RELAY_NAME" node -e "fetch('http://$(address_of "$from_name"):1340/api/getHostStatus',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
        say "ok     the console reaches $from_name on 1340, so its owner's roster can load"
      else
        say "BROKEN the console cannot reach $from_name on 1340; its owner sees an empty console"; broken=$((broken+1))
      fi
      if docker exec "$from_name" bash -c "timeout 3 bash -c 'exec 3<>/dev/tcp/$RELAY_ADDR/$RELAY_PORT'" 2>/dev/null; then
        say "ok     $from_name reaches the relay on $RELAY_PORT, which is where its host bundle comes from"
      else
        say "BROKEN $from_name cannot reach the relay on $RELAY_PORT; its host bundle will never update"
        bad=$((bad + 1))
      fi
    done
  fi

  # PROXY-1. The second thing a box IS allowed, and the one thing next to it that it must not have.
  #
  # Both legs matter and they fail in opposite directions. Without the accept rule every tenant's
  # inference stops on the next message, which looks like a provider outage and is not one. With the
  # database reachable, a customer's own agents could read every tenant's spend rows and virtual key
  # records, which is the whole ledger this wave exists to keep.
  #
  # The database leg is aimed at the PROXY's address on 5432 rather than at the database's, because
  # the database is deliberately not on this bridge at all (deploy/coolify/proxy.compose.yml) and
  # there is no address here to aim at. What it proves is that nothing on the proxy's address
  # answers on that port -- which is what would change if somebody put a ports line in that compose
  # or moved the database onto this network.
  step "the proxy"
  if [ -z "$PROXY_ADDR" ]; then
    say "no container carrying com.titanbot.role=proxy is on $NET, so there is nothing to reach yet"
    say "(that is the shape of this host before PROXY-1 is deployed, and every box behaves as it did)"
  elif [ "${#BOX_LIST[@]}" -eq 0 ]; then
    say "the proxy is on this network and no box is, so there is nothing to check from"
  else
    for from in "${BOX_LIST[@]}"; do
      from_name="${from%% *}"
      if docker exec "$from_name" bash -c "timeout 3 bash -c 'exec 3<>/dev/tcp/$PROXY_ADDR/$PROXY_PORT'" 2>/dev/null; then
        say "ok     $from_name reaches the proxy on $PROXY_PORT, which is where its answers come from"
      else
        say "BROKEN $from_name cannot reach the proxy on $PROXY_PORT; that tenant gets no answer at all"
        bad=$((bad + 1))
      fi
      if docker exec "$from_name" bash -c "timeout 3 bash -c 'exec 3<>/dev/tcp/$PROXY_ADDR/$PROXY_DB_PORT'" 2>/dev/null; then
        say "OPEN   $from_name reaches $PROXY_DB_PORT on the proxy address; every tenant's spend and key rows are readable from a customer's sandbox"
        bad=$((bad + 1))
      else
        say "closed $from_name -> the proxy on $PROXY_DB_PORT: nothing answered, which is right"
      fi
    done
  fi

  [ "$bad" = 0 ] || die "$bad path(s) are open that should not be, or a box lost a path it needs"
  [ "$broken" = 0 ] || die "$broken box(es) cannot be reached by the console on 1340; their owners see an empty console"
  printf '\nPASS  no box reaches another box, every box reaches the relay and the proxy, and nothing reaches the proxy database\n'
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
    # PROXY-1. The second and last thing a box may say on this bridge: ask the proxy for an answer.
    # ONE accept line, ahead of the drop, aimed at the address the label lookup found rather than at
    # anything written down. No return rule is needed and none is added: the drop below matches only
    # `ip saddr` in the box set, and the chain's policy is accept, so the proxy's replies were never
    # in the way. No second network either -- the chain is scoped by `meta ibrname`, and a second
    # bridge would reopen box-to-box, which is the hole this whole script closed.
    if [ -n "$PROXY_ADDR" ]; then
      printf '    meta ibrname "%s" ip saddr { %s } ip daddr %s tcp dport %s accept comment "a box asks the proxy for an answer"\n' \
        "$BR" "$SET" "$PROXY_ADDR" "$PROXY_PORT"
    fi
    # The bridge family has no connection tracking here, so a box's ANSWERS to the console and the
    # control plane have to be let through by port: the gateway (1340) and the desktop bridges
    # (6080, 6081) answer from those ports, and only to addresses that are not boxes. Found
    # 2026-09-07 with Richard's workspace: without this the console's own connection to a customer
    # box timed out, and every customer console was dead while the rule stood.
    printf '    meta ibrname "%s" ip saddr { %s } ip daddr != { %s } tcp sport { 1340, 6080, 6081 } accept comment "a box answers the console and the control plane"\n' \
      "$BR" "$SET" "$SET"
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
