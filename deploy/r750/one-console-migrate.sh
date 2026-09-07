#!/usr/bin/env bash
# one-console-migrate.sh -- move the R750 from one relay per customer to one console for everybody.
#
# TENANT-2 gave every customer their own relay on their own hostname. Jason read that shape back and
# said no: "In my mind there should only be one extra Docker container per tenant. Every time we add
# somebody new, we're basically duplicating everything. That sounds crazy." TENANT-5 is the answer.
# One relay, one console, one login page at console.titanium.bot, and a customer is one box
# container plus one data directory under /data/titanbot/<slug>/.
#
# For the relay to serve every customer it has to REACH every customer's box, and Coolify puts every
# resource on a network of its own. So there is one shared network, titanbot-net, that the relay,
# the control plane and every box join. That is the whole infrastructure change and it is what this
# script does.
#
# WHAT THIS SCRIPT DOES AND DOES NOT DO.
#
#   It does    create titanbot-net, check every precondition, print the exact text to paste into
#              Coolify, read back what the running containers actually did, and say which step is
#              next. Every check is read-only and every step is idempotent: run it again and it
#              tells you where you are rather than doing anything twice.
#
#   It does not click anything in Coolify, restart a service, or edit a running container. Coolify
#              owns those and a compose it did not store is a compose it will overwrite on the next
#              deploy. This script prints; the operator pastes and clicks; then this script reads
#              back whether it worked.
#
# THE ORDER MATTERS AND IT IS NOT NEGOTIABLE. The network attach and the code ship are two separate
# restarts, in that order, with a check in between. Two changes in one restart means a 502 cannot be
# attributed to either of them, and the one thing that can 502 here is the console Jason works in.
#
#   1  create titanbot-net                      no restart, safe at any hour
#   2  attach the relay and the box to it       ONE quiet-window restart of Jason's service
#      -> console.titanium.bot answers          if it does not, roll back (step 2's rollback below)
#   3  ship the relay and control plane code    the ordinary ship
#   4  set CP_RELAY_TOKEN on both, restart cp   the registry route starts answering
#   5  re-provision demo as one box             and retire its old two-container service
#   6  prove it in a browser, then the gates
#
# ROLLBACK FOR STEP 2, which is the only step that can take the console down. Three lines:
#
#   a  remove the two `networks:` lines from titanbot-relay in the compose (the service one and the
#      titanbot-net entry under it)
#   b  remove the traefik.docker.network label from titanbot-relay
#   c  redeploy the service
#
# The relay is then single-homed on Coolify's own network exactly as it was before TENANT-5 and
# console.titanium.bot routes the way it did yesterday. Nothing else has changed at that point,
# because step 3 has not run.
#
# PLAN B, if the relay cannot be multi-homed safely on this host at all. Leave the relay
# single-homed on its own Coolify network and put every tenant's BOX on THAT network instead of on
# a new shared one: the control plane renders CP_SHARED_NETWORK into each tenant's compose and the
# value is the relay resource's own network name. Same reachability, no second network on the
# relay, and therefore no Traefik ambiguity at all. It costs one thing: the boxes then live on a
# network Coolify created for a resource it can delete, so deleting the relay resource takes the
# customers' network with it. That is why it is plan B and not plan A.
#
# WHY THE TRAEFIK LABEL. Measured on this server 2026-09-07: coolify-proxy is traefik:v3.6 started
# with --providers.docker=true and NO --providers.docker.network, and the relay container carries no
# traefik.docker.network label of its own. For a container on several networks Traefik with no
# default network takes the first entry of a Go map, and Go randomises map iteration order, so which
# address it routes to is redecided on every provider refresh. Half of them would be titanbot-net,
# where the relay does answer, and half the Coolify one, where it also answers -- but a tenant BOX
# multi-homed the same way answers on neither, and the relay's own routing becomes a coin flip the
# day its address on one network changes. The label pins it. scripts/verify-deploy.mjs reads it back
# off the running container after every restart, so a Coolify rewrite that strips it is caught by a
# gate rather than by the console going down on a Tuesday.
#
#   bash deploy/r750/one-console-migrate.sh              run the checks, create the network, print
#   TITANBOT_DRY_RUN=1 bash deploy/r750/one-console-migrate.sh    print only, create nothing
#
# Env:
#   TITANBOT_ROOT           default /home/sem/titanbot
#   TITANBOT_NET            default titanbot-net
#   TITANBOT_RELAY_SERVICE  Jason's Coolify service uuid, default p927bfqm83ioloibamlvyd7g
#   TITANBOT_CP_SERVICE     the control plane's, default hnhzi0ongkw0gsg9k4flcv7d
#   TITANBOT_DEMO_SERVICE   the demo tenant's, default sy74dau8ilh1g4u7a9eaw8f8
#   TITANBOT_DRY_RUN=1      read and print, change nothing
set -eu

ROOT="${TITANBOT_ROOT:-/home/sem/titanbot}"
NET="${TITANBOT_NET:-titanbot-net}"
RELAY_SERVICE="${TITANBOT_RELAY_SERVICE:-p927bfqm83ioloibamlvyd7g}"
CP_SERVICE="${TITANBOT_CP_SERVICE:-hnhzi0ongkw0gsg9k4flcv7d}"
DEMO_SERVICE="${TITANBOT_DEMO_SERVICE:-sy74dau8ilh1g4u7a9eaw8f8}"
DRY="${TITANBOT_DRY_RUN:-}"
CONSOLE_URL="${TITANBOT_CONSOLE_URL:-https://console.titanium.bot}"
CP_URL="${TITANBOT_CP_URL:-https://api.titanium.bot}"

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf '  !! %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
todo() { printf '  ->  %s\n' "$*"; }

dry() { [ -n "$DRY" ]; }

if dry; then
  printf 'one-console-migrate.sh -- DRY RUN. Nothing on this server will be created or changed.\n'
else
  printf 'one-console-migrate.sh -- TENANT-5, one console for every customer.\n'
fi
say "server root      $ROOT"
say "shared network   $NET"
say "relay service    $RELAY_SERVICE"
say "control plane    $CP_SERVICE"

# ---- 0. is this the right machine ---------------------------------------------------------------
step "0. where am I"
command -v docker >/dev/null 2>&1 || die "docker is not on this PATH, so this is not the R750"
[ -d "$ROOT" ] || die "$ROOT is not here, so this is not the server the relay runs on"
say "docker $(docker --version | awk '{print $3}' | tr -d ,)"
say "$ROOT is here"

# The container names. By ROLE LABEL AND SERVICE UUID, never by label alone.
#
# This is the same bug TENANT-5 deletes from the relay, and it bit here first: every tenant's relay
# carries com.titanbot.role=relay and every tenant's box carries com.titanbot.role=box, so
# `docker ps --filter label=... | head -1` on a host with customers on it answers an ARBITRARY
# customer's container. Measured on the R750 2026-09-07, with the demo tenant running: this script
# read demo's relay, and step 2 therefore printed demo's network as TITANBOT_PROXY_NETWORK. Pasting
# that would have pinned Traefik to a network Jason's relay is not on, which is console.titanium.bot
# answering 502 on every request -- caused by the one step whose whole purpose is to prevent that.
#
# Coolify names a service's containers <compose service>-<service uuid>, so the uuid is what tells
# one customer's container from another's and the label only says what kind of thing it is.
by_role_in_service() {
  docker ps --filter "label=com.titanbot.role=$1" --format '{{.Names}}' | grep -- "-${2}\$" | head -n 1
}
RELAY_CONTAINER="$(by_role_in_service relay "$RELAY_SERVICE" || true)"
CP_CONTAINER="$(by_role_in_service control-plane "$CP_SERVICE" || true)"
[ -n "$RELAY_CONTAINER" ] || warn "no relay container belongs to $RELAY_SERVICE; is the console running?"
say "relay container  ${RELAY_CONTAINER:-(none running)}"
say "control plane    ${CP_CONTAINER:-(none running)}"

# Every box on this host, which is one per tenant plus the operator's own.
BOXES="$(docker ps --filter 'label=com.titanbot.role=box' --format '{{.Names}}' | sort || true)"
BOX_COUNT="$(printf '%s' "$BOXES" | grep -c . || true)"
say "boxes running    ${BOX_COUNT:-0}"
for name in $BOXES; do say "  $name"; done

# ---- 1. the shared network ----------------------------------------------------------------------
step "1. the shared network $NET"
if docker network inspect "$NET" >/dev/null 2>&1; then
  say "already exists"
else
  if dry; then
    todo "would run: docker network create $NET"
  else
    docker network create "$NET" >/dev/null || die "could not create $NET"
    say "created"
  fi
fi

if docker network inspect "$NET" >/dev/null 2>&1; then
  SUBNET="$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr -s ' ')"
  ATTACHED="$(docker network inspect "$NET" --format '{{range $k, $v := .Containers}}{{$v.Name}} {{end}}' | tr -s ' ')"
  say "subnet   ${SUBNET:-(none yet)}"
  say "attached ${ATTACHED:-(nothing yet)}"
fi

# It is never deleted by a deploy and it must not be: `external: true` in both compose files means
# docker attaches to what is here and creates nothing. If this network disappears every one of those
# deploys fails loudly, which is the right direction.
say "created once, by hand, and never by a deploy. Both compose files declare it external: true."

# ---- 2. what to paste, and where ----------------------------------------------------------------
step "2. Jason's own service ($RELAY_SERVICE): attach it to $NET"
say "This is the ONE step that can take console.titanium.bot down, so it goes in a quiet window of"
say "its own, and NOTHING else changes in the same restart."
printf '\n'
say "a. Coolify -> the console.titanium.bot service -> Environment Variables. Add or check:"
printf '\n'
if [ -n "$RELAY_CONTAINER" ]; then
  PROXY_NET="$(docker inspect "$RELAY_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
    | tr ' ' '\n' | grep -v "^$NET$" | grep -v '^$' | head -n 1 || true)"
  BOX_CONTAINER="$(printf '%s\n' $BOXES | grep -- "-${RELAY_SERVICE}\$" | head -n 1 || true)"
  # A pin that names a network this container is not on is worse than no pin at all, so the value
  # this script prints is read off the relay of THIS service and nowhere else.
else
  PROXY_NET=""
  BOX_CONTAINER=""
fi
printf '       TITANBOT_PROXY_NETWORK  = %s\n' "${PROXY_NET:-<the relay container network that is NOT $NET>}"
# No apostrophe inside these braces, ever: the word half of ${VAR:-word} is quote-processed even
# inside double quotes, so one in there opens a single-quoted string and takes the rest of the file
# with it.
printf '       TITANBOT_BOX_CONTAINER  = %s\n' "${BOX_CONTAINER:-<the titanbot-box-<uuid> container of this service>}"
printf '\n'
say "   TITANBOT_PROXY_NETWORK pins which of the relay's two addresses Coolify's Traefik routes to."
say "   Without it the console answers 502 on about half of Traefik's provider refreshes, hours"
say "   after a deploy that looked fine. Read the header of this script for why."
say "   TITANBOT_BOX_CONTAINER names the operator's own box for docker exec. It used to be found by"
say "   label; on a host with more than one box that found an arbitrary customer's container, so the"
say "   fallback is deleted and this value is how the name is known."
printf '\n'
say "b. Same service -> Configuration -> Docker Compose. Paste deploy/coolify/docker-compose.yml"
say "   from this release, whole. It is the same file with three additions: both services join"
say "   $NET, the relay carries traefik.docker.network, and the relay's tenancy variables are now"
say "   CP_URL and CP_RELAY_TOKEN (TENANT_ID and CP_SESSION_SECRET are gone)."
printf '\n'
say "c. Redeploy in a QUIET WINDOW. Check it is quiet first, against THIS service's own box by name,"
say "   because every customer's box carries the same role label:"
say "     docker exec ${BOX_CONTAINER:-<this service box>} sh -c 'curl -s -m 10 -X POST \\"
say "       http://127.0.0.1:1340/api/listAgents -H \"authorization: Bearer \$SAND_GATEWAY_TOKEN\" \\"
say "       -H \"content-type: application/json\" -d {}'"
say "   Nobody mid-turn and no open job is what a quiet window is."
say "   Copy-in is on (SAND_BOX_STORE_COPY_IN=1), so the box recreate restores the agents' CLI"
say "   logins and git config on the way back up. Give the box 90 seconds before any gate."
printf '\n'
say "d. Then, and only then, check the console:"
say "     curl -sS -o /dev/null -w '%{http_code}\\n' $CONSOLE_URL/login"
say "   200 is what you want. Anything else: roll back with the three lines in this script's header"
say "   and stop. Do not ship the code on top of a console that is not answering."

step "2b. read back what actually happened"
if [ -n "$RELAY_CONTAINER" ]; then
  NETS="$(docker inspect "$RELAY_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr -s ' ')"
  PIN="$(docker inspect "$RELAY_CONTAINER" --format '{{index .Config.Labels "traefik.docker.network"}}' 2>/dev/null || true)"
  say "relay networks   ${NETS:-(none)}"
  say "traefik pin      ${PIN:-(ABSENT)}"
  case "$NETS" in
    *"$NET"*)
      if [ -z "$PIN" ] || [ "$PIN" = "<no value>" ]; then
        warn "The relay is on $NET and carries NO traefik.docker.network label. This is the state"
        warn "the header of this script is about: console.titanium.bot will answer 502 at random."
        warn "Set TITANBOT_PROXY_NETWORK on the service and redeploy, or roll step 2 back."
      else
        case "$NETS" in
          *"$PIN"*) say "the pin names a network this container is actually on. Good." ;;
          *) warn "the pin names $PIN and this container is not on it. Traefik will find no address." ;;
        esac
      fi
      ;;
    *) todo "step 2 has not been applied yet: the relay is not on $NET" ;;
  esac
else
  say "no relay container to read"
fi

# ---- 3. the code --------------------------------------------------------------------------------
step "3. ship the relay and control plane code"
say "The ordinary ship, from the Mac:"
say "  bash deploy/r750/sync.sh"
say "then rebuild the two local images on this server, because both are built here by hand:"
say "  docker build -t titanbot-relay:local -f $ROOT/deploy/relay.Dockerfile $ROOT/deploy"
say "  docker build -t titanbot-cp:local -f $ROOT/cp/Dockerfile $ROOT"
say "and redeploy both services in Coolify. Separate from step 2, and after it."

# ---- 4. the relay credential --------------------------------------------------------------------
step "4. CP_RELAY_TOKEN, the credential for the registry route"
say "One value, on BOTH resources. It is not the admin token: the admin token creates and deletes"
say "customers, this one reads GET /v1/relay/tenants, and neither opens the other's routes."
printf '\n'
say "Generate it once, on this server, and never print it into a chat window:"
say "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\""
printf '\n'
say "Then set the SAME value in two places:"
say "  a. the control plane resource ($CP_SERVICE), environment variable CP_RELAY_TOKEN"
say "  b. the console resource ($RELAY_SERVICE), environment variable CP_RELAY_TOKEN"
say "  c. and CP_URL = $CP_URL on the console resource, if it is not there already"
say "Restart the control plane, then the console."
printf '\n'
say "Confirm the route answers, with the token in a shell variable and never on the command line:"
say "  read -r -s T; curl -sS -o /dev/null -w '%{http_code}\\n' -H \"authorization: Bearer \$T\" $CP_URL/v1/relay/tenants"
say "  200 with the relay token. 401 with no token and 401 with the ADMIN token: check both."

step "4b. read back"
if [ -n "$CP_CONTAINER" ]; then
  # Whether the variable is SET, never its value. `docker inspect` prints the environment of a
  # container in full, so this greps for the name and prints nothing else.
  if docker inspect "$CP_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^CP_RELAY_TOKEN=..'; then
    say "the control plane container has CP_RELAY_TOKEN set (value not read)"
  else
    todo "the control plane container has no CP_RELAY_TOKEN yet"
  fi
  NETS_CP="$(docker inspect "$CP_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr -s ' ')"
  say "control plane networks ${NETS_CP:-(none)}"
else
  say "no control plane container to read"
fi
if [ -n "$RELAY_CONTAINER" ]; then
  if docker inspect "$RELAY_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^CP_RELAY_TOKEN=..'; then
    say "the relay container has CP_RELAY_TOKEN set (value not read)"
  else
    todo "the relay container has no CP_RELAY_TOKEN yet"
  fi
  if docker inspect "$RELAY_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^TENANT_ID='; then
    warn "the relay container still carries TENANT_ID. Under TENANT-5 one relay serves every"
    warn "customer, so a single tenant id on it is either an old container or an environment value"
    warn "that was never removed. Take it off the resource and redeploy."
  fi
fi

# ---- 5. the demo tenant -------------------------------------------------------------------------
step "5. re-provision demo as ONE box, and retire the old two-container service"
say "The demo tenant is Coolify service $DEMO_SERVICE, and today it is a box AND a relay on"
say "demo.titanium.bot. Under TENANT-5 it is a box, on $NET, with no hostname of its own at all."
printf '\n'
say "Its DATA DIRECTORY stays. /data/titanbot/demo/{volumes,state,profile,credential} is where the"
say "agents, the transcripts and the gateway token live, and nothing here touches it: the new box"
say "mounts the same directories the old one did."
printf '\n'
say "  a. from the Mac, with the admin token in the environment:"
say "       node cp/cli.mjs tenant stop demo"
say "       node cp/cli.mjs tenant delete demo --confirm"
say "     (delete removes the Coolify SERVICE. It does not remove /data/titanbot/demo.)"
say "  b. then build it again on the one-service render:"
say "       node cp/cli.mjs tenant add demo Demo"
say "  c. and check the box came up on the shared network:"
say "       docker ps --filter label=com.titanbot.role=box --format '{{.Names}}'"
say "       docker network inspect $NET --format '{{range \$k, \$v := .Containers}}{{\$v.Name}}{{println}}{{end}}'"
printf '\n'
say "demo.titanium.bot is retired at that point. The wildcard DNS record can stay; nothing depends"
say "on it. Everybody, Jason included, signs in at $CONSOLE_URL."

step "5b. read back"
DEMO_BOX="$(printf '%s\n' $BOXES | grep -- "-${DEMO_SERVICE}\$" | head -n 1 || true)"
if [ -n "$DEMO_BOX" ]; then
  DEMO_NETS="$(docker inspect "$DEMO_BOX" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr -s ' ')"
  say "demo box     $DEMO_BOX"
  say "its networks ${DEMO_NETS:-(none)}"
  case "$DEMO_NETS" in
    *"$NET"*) say "on the shared network. The relay can reach it." ;;
    *) todo "not on $NET yet: the relay cannot reach this box" ;;
  esac
else
  say "no box is running for service $DEMO_SERVICE"
fi
if docker ps --filter "label=com.titanbot.role=relay" --format '{{.Names}}' | grep -q -- "-${DEMO_SERVICE}\$"; then
  todo "the demo tenant still has a relay container. Under TENANT-5 a tenant is a box and nothing"
  todo "else: this is the old two-container service, still to be retired."
else
  say "no relay container for the demo service. One container per tenant, which is the point."
fi

# ---- 6. the proofs ------------------------------------------------------------------------------
step "6. prove it"
say "In a real browser from the Mac, two browser contexts side by side, because two sessions in one"
say "jar prove nothing:"
say "  demo@titanium.bot signs in at $CONSOLE_URL and sees demo's agents"
say "  sign out; Jason's instance password signs in and sees Titan and Scribe"
say "  neither roster carries one name from the other"
printf '\n'
say "Then the gates, from the Mac, one at a time (they share this box and a run has a 300 s ceiling):"
say "  node scripts/verify-deploy.mjs --url $CONSOLE_URL"
say "  node scripts/verify-one-console.mjs --url $CONSOLE_URL --cp $CP_URL"
say "  node scripts/verify-mail.mjs --url $CONSOLE_URL   (read only)"
printf '\n'
say "verify-one-console needs credentials in its environment, never on its command line. Its --help"
say "names all seven. Without them it reports SKIP by name rather than passing on a leg it could not"
say "measure."

printf '\n'
if dry; then
  printf 'DRY RUN finished. Nothing was created or changed.\n'
else
  printf 'Checks finished. The steps marked -> are the ones still to do.\n'
fi
