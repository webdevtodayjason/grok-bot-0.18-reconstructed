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
# ---- TENANT-3, the second thing this script does: a box cannot reach the HOST either -------------
#
# The rules above are box-to-box. This is box-to-host, and it is a different table because it is a
# different problem in a different netfilter family.
#
# WHAT WAS MEASURED, from inside the demo tenant's box on the R750 2026-09-08, with bash /dev/tcp
# (an earlier pass used `sh`, which is dash on this image and has no /dev/tcp, so it read every port
# as shut -- that run was a false negative and is discarded). Sanity leg 1.1.1.1:443 OPEN. Then OPEN
# on 22, 47291, 8000, 80, 443, 2049, 445, 11434 and 5000 against EACH of four host addresses: the
# box's default gateway 192.168.32.1, its titanbot-net gateway 192.168.48.1, the tailnet address
# 100.110.83.82 and docker0 172.17.0.1. `ss -lntp` on the host names them: sshd on 22 and 47291,
# docker-proxy on 8000 (Coolify), smbd on 445, ollama on 11434, a python service on 5000 and NFS on
# 2049. Between a customer's agent and the machine that runs every other customer there was nothing
# but two login prompts, the hosting panel, the machine's file exports and its local model server.
# The box has no IPv6 default route today, so v6 is not a current path OUT of a box -- but a bridge
# on this host already has v6, and that turned out to matter in the other direction. Measured on the
# R750 2026-09-09: the coolify bridge carries a global IPv6 prefix, its gateway address on that
# bridge answers `fib daddr type local`, and sshd listens on [::]:22 and [::]:47291 with
# docker-proxy on [::]:8000. So the guard's DROP already covers v6 (it matches on iifname, which has
# no family) while its EXEMPTION did not (`ip saddr` in an inet table is IPv4 only). That asymmetry
# is why addrs6_of_container exists; see the note there.
#
# WHY IT IS PREROUTING AND NOT INPUT, which is the part the docs got wrong. For 22 and 47291 the
# INPUT reasoning is right: a packet from a container to its own gateway address terminates on the
# host, so it goes through INPUT and not FORWARD, and DOCKER-USER never sees it. For 8000 -- the
# port the whole row is about -- it is wrong. Measured: `iptables -t nat -S` carries
# `-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER` and then
# `-A DOCKER ! -i br-7ef42af3f026 -p tcp --dport 8000 -j DNAT --to-destination 10.0.2.5:8080`.
# br-7ef42af3f026 is Coolify's OWN bridge, so a packet arriving from a box bridge is not excluded:
# its destination is rewritten to Coolify's container before INPUT is consulted and it is then
# FORWARDED, never delivered locally. An INPUT rule would correctly drop 22 and 47291 and silently
# do nothing for 8000. A prerouting hook at priority -250 runs BEFORE docker's nat prerouting at
# -100, so it sees the original destination, and `fib daddr type local` is what says "this address
# is one of ours" without naming a single gateway that changes every time a network is made.
#
# THE EXEMPTIONS FAIL CLOSED, and that is not caution for its own sake. Coolify drives this host
# over SSH from inside its own container: measured, four established sessions from 10.0.2.5 to
# 10.0.0.1:22. It arrives on a docker bridge exactly like a customer's box does, so `iifname br-*`
# covers it too, and a blanket drop on 22 would take away the hosting panel's ability to do
# anything -- re-applied every 60 seconds by the timer, so it would not be an event an operator
# could wait out. So the coolify container's addresses are DISCOVERED at apply time, by name, and
# if a coolify container exists and its addresses cannot be resolved this script installs NOTHING
# and exits non-zero. Same for the control plane, discovered by its role label.
#
# IT SHADOWS BEFORE IT DROPS. TITANBOT_HOST_GUARD=shadow (the default, and what a fresh install
# gets) installs the same matches as counter-only rules and drops nothing, so an operator can read
# for himself which ports a box actually uses before anything is taken away. Only when he is
# satisfied does he set the mode to drop. The counters are per port, which is what lets 2049, 445
# and 11434 be added to the drop set once their shadow counters read zero rather than on a guess.
#
#   sudo bash box-isolation.sh            apply, and print what it applied
#   sudo bash box-isolation.sh --verify   scan box to box AND box to host, and fail on any open port
#   sudo bash box-isolation.sh --counters print the host-guard counters, per port
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
#   TITANBOT_HOST_GUARD       off | shadow | drop. Default: the mode file below, else shadow.
#   TITANBOT_HOST_GUARD_MODE_FILE  where the mode is remembered so the timer reads the same one,
#                                  default /etc/titanbot/host-guard.mode
#   TITANBOT_HOST_GUARD_DROP_PORTS    dropped in drop mode, default 22,47291,8000
#   TITANBOT_HOST_GUARD_WATCH_PORTS   counted but never dropped, default 2049,445,11434,5000,80,443
#   TITANBOT_HOST_GUARD_BOX_DROP_PORTS  dropped for BOX SOURCES ONLY, default 2049,445 (the host's
#                                  NFS and SMB: a customer's sandbox has no business reaching them,
#                                  and other containers on this shared host do, so it is scoped)
#   TITANBOT_HOST_TABLE       the nft table, default titanbot_host
set -uo pipefail

NET="${TITANBOT_NET:-titanbot-net}"
TABLE="${TITANBOT_TABLE:-titanbot_isolation}"
RELAY_PORT="${TITANBOT_RELAY_PORT:-7777}"
PROXY_PORT="${TITANBOT_PROXY_PORT:-4000}"
PROXY_DB_PORT="${TITANBOT_PROXY_DB_PORT:-5432}"
HOST_TABLE="${TITANBOT_HOST_TABLE:-titanbot_host}"
HOST_GUARD_MODE_FILE="${TITANBOT_HOST_GUARD_MODE_FILE:-/etc/titanbot/host-guard.mode}"
# Where the last-installed policy is remembered, so a re-apply that would change nothing leaves the
# counters running. Under /run on purpose: nftables rules do not survive a reboot either.
# WHERE THE FINGERPRINT IS REMEMBERED, and it has to be somewhere the process can actually write.
# This runs as a systemd --user unit as the operator's own user and asks for root only for nft, so
# /run/titanbot -- root-owned 0755, as root's own earlier run left it -- was not writable, and both
# the mkdir and the write were swallowed by `|| true`. The fingerprint was therefore never stored,
# every tick read an empty PREVIOUS, and the table was rebuilt every 60 seconds. Measured on the
# R750 2026-09-09: /run/titanbot/host-guard.fingerprint did not exist, and the accept rule's handle
# walked 2086 -> 2088 -> 2090 over 90 seconds with its counter resetting each time. That is the
# whole instrument the shadow pass depends on, silently reading "the last minute" while looking like
# an accumulating window.
#
# XDG_RUNTIME_DIR is the user manager's own runtime directory (/run/user/1001 here), user-writable
# and cleared on reboot, which is the same property /run was chosen for: nftables rules do not
# survive a reboot either, so the memory and the thing it remembers disappear together. A root run
# has no XDG_RUNTIME_DIR and falls back to /run, which root can write.
HOST_GUARD_STATE="${TITANBOT_HOST_GUARD_STATE:-${XDG_RUNTIME_DIR:-/run}/titanbot/host-guard.fingerprint}"
SHASUM="$(command -v sha256sum || command -v shasum)"
# shadow by default, and by default on a host that has never been told otherwise. A first apply that
# silently started dropping traffic on a live machine would be the wrong way round: the counters
# come first, an operator reads them, and only then is anything taken away.
HOST_GUARD="${TITANBOT_HOST_GUARD:-}"
if [ -z "$HOST_GUARD" ] && [ -r "$HOST_GUARD_MODE_FILE" ]; then
  HOST_GUARD="$(tr -d '[:space:]' < "$HOST_GUARD_MODE_FILE" 2>/dev/null)"
fi
HOST_GUARD="${HOST_GUARD:-shadow}"
case "$HOST_GUARD" in off|shadow|drop) ;; *) echo "TITANBOT_HOST_GUARD must be off, shadow or drop (got '$HOST_GUARD')" >&2; exit 64 ;; esac
# 2049, 445 and 11434 were moved into the drop set on 2026-09-08 on the strength of "their shadow
# counters read zero over a 31 minute accumulating window". They are moved back out here, and the
# reason is not a change of mind about NFS, Samba and ollama: there was no accumulating window. The
# fingerprint that keeps a table across a tick could not be written (see HOST_GUARD_STATE above), so
# the table was rebuilt every 60 seconds and every counter on this host has only ever shown the last
# minute. That expansion never reached the R750 -- the live table still reads them watch-only -- so
# nothing is being taken away here; what is being removed is a default that would have applied a
# restrictive change to a shared host on evidence that was not what it said it was.
#
# The rule this file set for itself stands and is now measurable for the first time: a port joins
# the drop set after its counter has read zero across a window it was actually accumulating over.
# Re-decide these three on such a window. The blast radius is worth stating plainly, because it is
# why this is not a formality: about sixty containers that are nothing to do with this product share
# this host, and 11434 is the machine's own model server.
#
# 80, 443 and 5000 stay watch-only, and that is a decision rather than an oversight. 80 and 443 on
# the host are Coolify's own proxy, which is how everything published on this machine is served, and
# taking those away from a container is a bigger blast radius than this row is about. 5000 is a
# python service nobody has identified yet, and it can join the set the day somebody can say what it
# is.
DROP_PORTS="${TITANBOT_HOST_GUARD_DROP_PORTS:-22,47291,8000}"
WATCH_PORTS="${TITANBOT_HOST_GUARD_WATCH_PORTS:-2049,445,11434,5000,80,443}"
# Dropped for BOXES ONLY, whatever the counters say for the rest of the host. See the box-scoped
# rule below for why these two are decidable today and 11434 and 5000 are not.
BOX_DROP_PORTS="${TITANBOT_HOST_GUARD_BOX_DROP_PORTS:-2049,445}"

MODE=apply
case "${1:-}" in
  --verify) MODE=verify ;;
  --show) MODE=show ;;
  --counters) MODE=counters ;;
  "") MODE=apply ;;
  *) echo "usage: $0 [--verify|--show|--counters]" >&2; exit 64 ;;
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

# Every IPv4 address a container holds, across every network it is on.
addrs_of_container() {
  docker inspect "$1" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$v.IPAddress}}{{println}}{{end}}' 2>/dev/null \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u
}

# The same, but paired with the BRIDGE each address actually lives on. This is what turns an
# exemption from "anyone claiming this source address" into "this address, arriving on the interface
# it belongs to".
#
# WHY IT MATTERS: coolify-proxy holds 192.168.32.3, and the demo box is 192.168.32.2 on that same
# bridge. The exemptions accepted on `ip saddr` alone with no input interface, so a tenant with root
# in its own box -- docker grants NET_RAW by default and these boxes drop no capabilities -- could
# forge that source from the segment it already shares and be accepted for the whole drop set.
# Binding each exemption to its own bridge costs the control plane nothing: its default route is
# 192.168.16.1, not titanbot-net.
bridge_of_network() {
  name="$(docker network inspect "$1" --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null)"
  if [ -n "$name" ] && [ "$name" != "<no value>" ]; then printf '%s\n' "$name"; else printf 'br-%s\n' "$(printf '%s' "$1" | cut -c1-12)"; fi
}

# "<bridge> <address>" per network the container is on, for each family.
pairs_of_container() {
  docker inspect "$1" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$v.NetworkID}} {{$v.IPAddress}} {{$v.GlobalIPv6Address}}{{println}}{{end}}' 2>/dev/null \
    | while read -r netid v4 v6; do
        [ -n "$netid" ] || continue
        br="$(bridge_of_network "$netid")"
        [ -n "$br" ] || continue
        case "$v4" in [0-9]*.[0-9]*.[0-9]*.[0-9]*) printf '4 %s %s\n' "$br" "$v4" ;; esac
        case "$v6" in *:*) printf '6 %s %s\n' "$br" "$v6" ;; esac
      done | sort -u
}

# And every GLOBAL IPv6 address, the same way. This is not decoration and it is not symmetry for its
# own sake: `ip saddr` in an inet table matches IPv4 ONLY, while the two drop lines below match on
# iifname and so cover both families. An exemption written only as `ip saddr` therefore lets an
# exempt container past on IPv4 and drops it on IPv6 -- the one asymmetry that can take away the
# panel this machine is administered from, with the way back in being the panel that just stopped
# working. Measured on the R750 2026-09-09 while the guard was already in drop mode: the coolify
# bridge carries a global IPv6 prefix, its own gateway address on that bridge is `fib daddr type
# local`, sshd listens on [::]:22 and [::]:47291 and docker-proxy on [::]:8000, and five coolify
# containers hold global IPv6 addresses there. Nothing had hit it yet only because Coolify happens
# to address this host by its IPv4 address today; one AAAA answer would have changed that.
# A container with no IPv6 gets no IPv6 line: docker prints an absent address as Go's "invalid IP",
# and a rule built out of that would match nothing while looking like it worked. The grep for a
# colon is what keeps that string out.
addrs6_of_container() {
  docker inspect "$1" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$v.GlobalIPv6Address}}{{println}}{{end}}' 2>/dev/null \
    | grep -E '^[0-9a-fA-F:]+:[0-9a-fA-F:]*$' | sort -u
}

# The boxes, by the label every install carries, intersected with what is actually on this network.
mapfile -t BOX_NAMES < <(docker ps --filter label=com.titanbot.role=box --format '{{.Names}}' | sort)
BOX_ADDRS=()
BOX_LIST=()
# EVERY address a box holds, not only its address on this network. The bridge table below is about
# this network, so BOX_ADDRS stays as it was; the host guard's box-scoped drop is about the host,
# which a box reaches from whichever of its addresses it likes, so that one needs all of them.
BOX_ALL_ADDRS=()
for name in "${BOX_NAMES[@]}"; do
  mapfile -t box_every < <(addrs_of_container "$name")
  for a in "${box_every[@]}"; do [ -n "$a" ] && BOX_ALL_ADDRS+=("$a"); done
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

# ---- TENANT-3: what may still reach the host, discovered rather than written down ----------------
#
# Two exemptions, both by ADDRESS and both found at apply time. A name or a bridge would be wrong
# for the same reason the proxy's address is discovered above: Coolify renames containers and docker
# hands out fresh addresses, and a rule that quietly stops matching here does not fail loudly, it
# takes away Jason's hosting panel every sixty seconds.
#
# HOST_GUARD_BLOCKED is the fail-closed latch. If a container that must be exempt is present but its
# addresses cannot be read, nothing is installed at all and the run exits non-zero. Absent is fine:
# a host with no Coolify has nothing to exempt. Unreadable is not.
HOST_GUARD_BLOCKED=""
EXEMPT_ADDRS=()
EXEMPT_ADDRS6=()
EXEMPT_PAIRS=()
EXEMPT_PAIRS6=()


exempt_container() {
  name="$1"; why="$2"
  [ -n "$name" ] || return 0
  mapfile -t found < <(addrs_of_container "$name")
  if [ "${#found[@]}" -eq 0 ]; then
    HOST_GUARD_BLOCKED="$why: the container $name is running and docker would not tell me its addresses"
    return 0
  fi
  for a in "${found[@]}"; do EXEMPT_ADDRS+=("$a"); done
  # And the bridge each of them arrives on. A bridge name that is not an interface on this host is
  # the fail-closed case: installing an exemption that cannot match is how the hosting panel this
  # machine is administered from goes away sixty seconds later.
  mapfile -t pairs < <(pairs_of_container "$name")
  for pair in "${pairs[@]}"; do
    fam="${pair%% *}"; rest="${pair#* }"; br="${rest%% *}"; addr="${rest#* }"
    if ! ip link show "$br" >/dev/null 2>&1; then
      HOST_GUARD_BLOCKED="$why: $name holds $addr on a network whose bridge I read as $br, and there is no such interface"
      continue
    fi
    if [ "$fam" = 4 ]; then EXEMPT_PAIRS+=("$br $addr"); say "exempt $addr on $br ($why, $name)"
    else EXEMPT_PAIRS6+=("$br $addr"); say "exempt $addr on $br ($why, $name, IPv6)"; fi
  done
  # An absent IPv6 address is not a failure and must never trip the fail-closed latch: most
  # containers on this host have none, and refusing to install the guard because a container is
  # IPv4-only would take the boundary away for a reason that is not a fault.
  mapfile -t found6 < <(addrs6_of_container "$name")
  if [ "${#found6[@]}" -gt 0 ]; then
    for a in "${found6[@]}"; do EXEMPT_ADDRS6+=("$a"); done
  fi
}

if [ "$HOST_GUARD" != off ]; then
  step "host guard: $HOST_GUARD"
  # Coolify, by container name rather than by label: they are not our containers and carry no label
  # of ours. ALL of them, not just the one called `coolify`. It SSHes into this host from inside its
  # own container (measured: 10.0.2.5 -> 10.0.0.1:22, four live sessions), and its sentinel polls the
  # host's own API (measured 2026-09-08 by the shadow pass: coolify-sentinel at 10.0.0.3 opening
  # 10.0.0.1:8000 once a minute, from the DEFAULT bridge, which is docker0 and therefore matched).
  # That second one is why the prefix is `coolify` and not `^coolify$`: a drop set built on the
  # obvious name alone would have taken out Coolify's monitoring and looked like a Coolify bug.
  # This is the whole reason the shadow pass runs before the drop.
  mapfile -t COOLIFY_NAMES < <(
    if [ -n "${TITANBOT_COOLIFY:-}" ]; then printf '%s\n' "$TITANBOT_COOLIFY"
    else docker ps --format '{{.Names}}' | grep -E '^coolify(-|$)' | sort; fi
  )
  if [ "${#COOLIFY_NAMES[@]}" -gt 0 ]; then
    for name in "${COOLIFY_NAMES[@]}"; do exempt_container "$name" "the hosting panel and its own agents"; done
  else say "no coolify container on this host, so there is nothing to exempt for it"; fi
  # The control plane, by our own role label. It calls Coolify's API on the host's published port to
  # build a customer's box, so it needs 8000 for the same reason a box must not have it.
  CP_NAME="${TITANBOT_CONTROL_PLANE:-$(docker ps --filter label=com.titanbot.role=control-plane --format '{{.Names}}' | head -n 1)}"
  if [ -n "$CP_NAME" ]; then exempt_container "$CP_NAME" "the control plane builds boxes through the hosting panel"
  else say "no control plane container on this host, so there is nothing to exempt for it"; fi
fi

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
  step "host guard"
  "${NFT[@]}" list table inet "$HOST_TABLE" 2>/dev/null || say "the table inet $HOST_TABLE is not installed"
  exit 0
fi

# The counters, per port, which is the whole point of the shadow pass: 2049, 445 and 11434 join the
# drop set once their counters read zero over a real window, not because somebody was fairly sure.
if [ "$MODE" = counters ]; then
  step "host guard counters"
  if ! "${NFT[@]}" list table inet "$HOST_TABLE" >/dev/null 2>&1; then
    say "the table inet $HOST_TABLE is not installed, so nothing has been counted"
    exit 0
  fi
  "${NFT[@]}" -a list table inet "$HOST_TABLE" | grep -E 'counter packets|comment' | sed 's/^[[:space:]]*/  /'
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

  # ---- TENANT-3: box to HOST, and this is the leg that fails ------------------------------------
  #
  # Until 2026-09-08 --verify scanned box to box and nothing else, so the deploy gate's isolation
  # leg reported PASS while every host port stood open to every tenant. A green leg over an open
  # door is worse than no leg: it reads as a proof.
  #
  # bash /dev/tcp EXPLICITLY, never sh. The box image's /bin/sh is dash, which has no /dev/tcp, so a
  # probe written with sh reads every port as shut and the leg passes for the wrong reason. That
  # false negative is on the record; this is the line that prevents it, and the sanity leg below is
  # what proves the probe can still see an open port at all.
  step "box to host"
  if [ "${#BOX_LIST[@]}" -eq 0 ]; then
    say "no box on this network, so there is nothing to probe the host from"
  else
  for from in "${BOX_LIST[@]}"; do
    from_name="${from%% *}"
    # Every host address this box can name, discovered from inside it: its default gateway, the
    # gateway of every other bridge it is on, and docker0. Written down here they would be four
    # literals that stop being true the next time a network is made.
    mapfile -t host_addrs < <(docker exec "$from_name" bash -c '
      ip route | awk "/^default/ {print \$3}"
      ip route | awk "/proto kernel/ {print \$1}" | while read -r net; do
        printf "%s\n" "${net%%/*}" | awk -F. "{print \$1\".\"\$2\".\"\$3\".1\"}"
      done' 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u)
    for extra in ${TITANBOT_HOST_ADDRS:-}; do host_addrs+=("$extra"); done
    # AND THE HOST'S OWN ADDRESSES, discovered on the host side, where this script already runs as
    # root. Everything the box can work out from inside itself is a bridge gateway -- its default
    # gateway and each attached subnet's .1 -- so until this line the leg knocked on four doors and
    # called the house locked. The rule is written on `fib daddr type local`, which covers every
    # address this machine answers on: the tailnet address and the LAN addresses are doors too, and
    # if the rule were ever narrowed to a bridge gateway this leg would still have printed PASS.
    # Measured on the R750 2026-09-08: --verify named 192.168.32.1, 192.168.48.1, 172.31.0.1 and
    # 192.168.64.1 and never touched 100.110.83.82 or 192.168.0.9/.12/.98, all four of which had to
    # be probed by hand to establish the drop set actually holds.
    #
    # Bridges and veths are left out: a br-* gateway is already in the box-derived list above, and a
    # veth address is one end of a pair rather than a door. That also keeps the probe inside the
    # gate's time budget on a host with sixty containers on it.
    mapfile -t host_own < <(ip -o -4 addr show 2>/dev/null \
      | awk '$2 !~ /^(br-|veth|docker0|lo)/ { print $4 }' | cut -d/ -f1 \
      | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u)
    for extra in "${host_own[@]}"; do [ -n "$extra" ] && host_addrs+=("$extra"); done
    mapfile -t host_addrs < <(printf '%s\n' "${host_addrs[@]}" | grep -v '^$' | sort -u)
    if [ "${#host_addrs[@]}" -eq 0 ]; then
      say "BROKEN could not work out any host address from inside $from_name, so this leg proved nothing"
      bad=$((bad + 1))
      continue
    fi
    # The sanity leg. If this cannot open a socket to something that is definitely listening, every
    # "closed" below means "the probe is broken", not "the host is unreachable".
    if ! docker exec "$from_name" bash -c 'timeout 4 bash -c "exec 3<>/dev/tcp/1.1.1.1/443"' 2>/dev/null; then
      say "note   $from_name could not open 1.1.1.1:443 either, so it may have no egress; the closed results below are weaker than they look"
    fi
    guard_ports="$(printf '%s,%s' "$DROP_PORTS" "$WATCH_PORTS" | tr ',' ' ')"
    for addr in "${host_addrs[@]}"; do
      open="$(docker exec "$from_name" bash -c '
        for p in '"$guard_ports"'; do
          timeout 2 bash -c "exec 3<>/dev/tcp/'"$addr"'/$p" 2>/dev/null && printf "%s " "$p"
        done' 2>/dev/null)"
      open="$(printf '%s' "$open" | sed 's/ *$//')"
      if [ -n "$open" ]; then
        # A drop-set port open is the finding. A watch-only port open is what the shadow pass is
        # for, so it is said plainly and does not fail the run until it joins the drop set.
        # A box-scoped drop port counts as hard here too: this leg probes FROM A BOX, which is
        # exactly the source that rule drops, so an open 2049 or 445 from a box is a finding and
        # not a shadow counter.
        hard=""; watched=""
        for p in $open; do
          case ",$DROP_PORTS,$BOX_DROP_PORTS," in
            *",$p,"*) hard="$hard $p" ;;
            *) watched="$watched $p" ;;
          esac
        done
        if [ -n "$hard" ]; then
          say "OPEN   $from_name -> host $addr on$hard; a customer's agent reaches the machine that runs every other customer"
          bad=$((bad + 1))
        fi
        [ -n "$watched" ] && say "note   $from_name -> host $addr also answers on$watched (watch-only; add to the drop set once its shadow counter reads zero)"
      else
        say "closed $from_name -> host $addr: nothing answered on $guard_ports"
      fi
    done
  done
  fi

  [ "$bad" = 0 ] || die "$bad path(s) are open that should not be, or a box lost a path it needs"
  [ "$broken" = 0 ] || die "$broken box(es) cannot be reached by the console on 1340; their owners see an empty console"
  printf '\nPASS  no box reaches another box or the host on the drop set, every box reaches the relay and the proxy, and nothing reaches the proxy database\n'
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

# ---- TENANT-3: the host guard --------------------------------------------------------------------
step "host guard"
if [ -n "$HOST_GUARD_BLOCKED" ]; then
  die "refusing to install the host guard: $HOST_GUARD_BLOCKED. Nothing was changed. Fix the lookup or set TITANBOT_HOST_GUARD=off, and do not install a drop set without its exemptions."
fi
if [ "$HOST_GUARD" = off ]; then
  "${NFT[@]}" delete table inet "$HOST_TABLE" >/dev/null 2>&1 && say "removed the host guard table (mode off)" \
    || say "mode off and no host guard table installed"
else
  # The rule set, in one nft transaction like the bridge table above.
  #
  #   type filter hook prerouting priority -250   before docker's nat prerouting at -100, so the
  #                                               destination is still the host's own address and
  #                                               not yet Coolify's container
  #   fib daddr type local                        "addressed to this machine", without naming a
  #                                               gateway that changes whenever a network is made
  #   iifname { "br-*", "docker0" }               every docker bridge on this host, present or
  #                                               future, and nothing that is not one
  #   tcp flags syn / syn,ack                     only the opening packet: counting or dropping an
  #                                               established stream's every packet is noise, and a
  #                                               connection that cannot open never has one
  #
  # The exemptions come FIRST and accept, so nothing below can reach the packets they match. In
  # shadow mode the drop rules are counters with no verdict, which is what makes "shadow" honest
  # rather than a name: the same matches, the same order, no verdict.
  HOST_RULES="$(mktemp)"
  VERDICT=""
  [ "$HOST_GUARD" = drop ] && VERDICT=" drop"
  # In shadow, SAY WHO. A counter answers "something used this port" and the question an operator
  # actually has is "what will I break if I turn this on". Measured on the R750 2026-09-08: 8000 was
  # counting one packet a minute from a docker bridge that is neither Coolify nor the control plane,
  # and with counters alone there is no way to find out which of the other 68 containers it is.
  # Rate limited, because this is a prerouting hook on a busy host and a log that floods is a log
  # nobody reads. Nothing is logged in drop mode: by then the question has been answered.
  LOGRULE=""
  [ "$HOST_GUARD" = shadow ] && LOGRULE=' limit rate 10/minute log prefix "titanbot-host-guard "'
  {
    printf 'table inet %s { }\n' "$HOST_TABLE"
    printf 'delete table inet %s\n' "$HOST_TABLE"
    printf 'table inet %s {\n' "$HOST_TABLE"
    # Two chains rather than one, and positively matched rather than negated. `iifname "br-*"` is
    # a wildcard match nft has had for years; `iifname != { "br-*", "docker0" }` is a negated set OF
    # wildcards, which is exactly the sort of thing that parses on one nft and not on another. The
    # entry chain decides "did this arrive on a docker bridge and is it a new TCP connection to this
    # machine", and jumps; the guarded chain holds the exemptions and the ports.
    printf '  chain guarded {\n'
    # One accept per bridge, not one flat address set. See pairs_of_container: an exemption matched
    # on source address alone is claimable by any container that shares that address's L2 segment,
    # and a box does share one with coolify-proxy.
    if [ "${#EXEMPT_PAIRS[@]}" -gt 0 ]; then
      for br in $(printf '%s\n' "${EXEMPT_PAIRS[@]}" | awk '{print $1}' | sort -u); do
        set4="$(printf '%s\n' "${EXEMPT_PAIRS[@]}" | awk -v b="$br" '$1 == b { print $2 }' | sort -u | tr '\n' ',' | sed 's/,$//')"
        [ -n "$set4" ] || continue
        printf '    iifname "%s" ip saddr { %s } counter accept comment "the hosting panel and the control plane keep their way in, on the bridge that address lives on"\n' "$br" "$set4"
      done
    fi
    # One line per address family, because one line cannot cover both. See addrs6_of_container.
    if [ "${#EXEMPT_PAIRS6[@]}" -gt 0 ]; then
      for br in $(printf '%s\n' "${EXEMPT_PAIRS6[@]}" | awk '{print $1}' | sort -u); do
        set6="$(printf '%s\n' "${EXEMPT_PAIRS6[@]}" | awk -v b="$br" '$1 == b { print $2 }' | sort -u | tr '\n' ',' | sed 's/,$//')"
        [ -n "$set6" ] || continue
        printf '    iifname "%s" ip6 saddr { %s } counter accept comment "the same containers, over IPv6, on their own bridge"\n' "$br" "$set6"
      done
    fi
    # THE BOX-SCOPED DROP. Measured from inside the demo box on the R750 2026-09-08: the host
    # answers a customer's sandbox on 2049 (NFS) and 445 (SMB) on all seven of its addresses. Those
    # two cannot join DROP_PORTS, because the counters on this host are NOT zero -- other containers
    # among the ~60 sharing this machine really do use them -- and a blanket drop would take file
    # sharing away from somebody else's service. Scoped to the box addresses it costs nobody else
    # anything: a customer's agent has no business reaching the host's file exports, and every box
    # address is already enumerated here. 11434 (the machine's model server) and 5000 (an
    # unidentified python service) stay watch-only until 5000 is identified.
    if [ "${#BOX_ALL_ADDRS[@]}" -gt 0 ] && [ -n "$BOX_DROP_PORTS" ]; then
      BOX_SET="$(printf '%s\n' "${BOX_ALL_ADDRS[@]}" | sort -u | tr '\n' ',' | sed 's/,$//')"
      for port in $(printf '%s' "$BOX_DROP_PORTS" | tr ',' ' '); do
        printf '    ip saddr { %s } tcp dport %s counter%s%s comment "box-scoped %s"\n' "$BOX_SET" "$port" "$LOGRULE" "$VERDICT" "$port"
      done
    fi
    # One rule per port so the counters are per port. That is the difference between "something
    # used the guard set 4,000 times" and "nothing has touched 11434 in half an hour".
    for port in $(printf '%s' "$DROP_PORTS" | tr ',' ' '); do
      printf '    tcp dport %s counter%s%s comment "drop-set %s"\n' "$port" "$LOGRULE" "$VERDICT" "$port"
    done
    for port in $(printf '%s' "$WATCH_PORTS" | tr ',' ' '); do
      printf '    tcp dport %s counter%s comment "watch-only %s"\n' "$port" "$LOGRULE" "$port"
    done
    printf '  }\n'
    printf '  chain host {\n'
    printf '    type filter hook prerouting priority -250; policy accept;\n'
    printf '    fib daddr type local tcp flags syn / syn,ack iifname "br-*" jump guarded\n'
    printf '    fib daddr type local tcp flags syn / syn,ack iifname "docker0" jump guarded\n'
    printf '  }\n}\n'
  } > "$HOST_RULES"
  # RELOAD ONLY WHEN THE POLICY WOULD CHANGE. nft resets a counter when its rule is replaced, and
  # this runs every 60 seconds from a timer, so rebuilding the table unconditionally meant every
  # counter read as "the last minute" -- which makes the shadow pass, whose entire purpose is to
  # accumulate evidence before anything is taken away, worth nothing. Found by reading counters on
  # the R750 2026-09-08 that would not add up.
  #
  # The comparison is a fingerprint of the rules THIS RUN would install, remembered in a file,
  # rather than a diff against `nft list`: the listing is nft's own rendering of the policy and
  # differs from the input in whitespace and set formatting, so a text comparison would never match
  # and would reload every minute anyway. The file lives under /run because nftables rules do not
  # survive a reboot either, so the memory and the thing it remembers disappear together. The table
  # still has to be present -- a fingerprint on its own would happily skip re-installing a policy
  # somebody had flushed by hand.
  FINGERPRINT="$(sed -e "/^table inet $HOST_TABLE { }$/d" -e "/^delete table inet $HOST_TABLE$/d" "$HOST_RULES" | "$SHASUM" | awk '{print $1}')"
  PREVIOUS=""
  [ -r "$HOST_GUARD_STATE" ] && PREVIOUS="$(cat "$HOST_GUARD_STATE" 2>/dev/null)"
  if [ "$FINGERPRINT" = "$PREVIOUS" ] && "${NFT[@]}" list table inet "$HOST_TABLE" >/dev/null 2>&1; then
    say "mode $HOST_GUARD; the installed policy is already this one, so the counters were left running"
  else
    "${NFT[@]}" -f "$HOST_RULES" || die "nft would not load the host guard (root? does this kernel have fib expressions?)"
    # Say so when the fingerprint cannot be kept. Silent failure here does not break the boundary,
    # which is why it went unnoticed for a day, but it quietly destroys the counters -- and the
    # counters are the only evidence anybody has for whether a port can join the drop set.
    if ! { mkdir -p "$(dirname "$HOST_GUARD_STATE")" 2>/dev/null && printf '%s\n' "$FINGERPRINT" > "$HOST_GUARD_STATE" 2>/dev/null; }; then
      say "WARNING cannot write $HOST_GUARD_STATE, so this table will be rebuilt every tick and its counters will never accumulate"
    fi
    say "mode $HOST_GUARD; drop set $DROP_PORTS; watch-only $WATCH_PORTS; ${#EXEMPT_ADDRS[@]} exempt address(es)"
  fi
  rm -f "$HOST_RULES"
  [ "$HOST_GUARD" = shadow ] && say "nothing is being dropped: read the counters with --counters, then set the mode to drop"
  "${NFT[@]}" list table inet "$HOST_TABLE" | sed 's/^/  /'
fi
