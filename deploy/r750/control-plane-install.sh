#!/usr/bin/env bash
# control-plane-install.sh -- the part of the control plane deploy that has to happen ON THE R750.
#
# Two things live on the server and nowhere else: the directory every tenant is written into, and
# the image Coolify starts. This script makes both, generates the three secrets once, and then stops.
# It creates no Coolify object at all. deploy/r750/control-plane-coolify.mjs does that half, from
# the Mac, and docs/TENANCY.md section 9 runs the two in order.
#
#   bash /home/sem/titanbot/deploy/control-plane-install.sh
#
# Run it as sem, not with sudo. It calls sudo itself for the one step that needs root (making
# /data/titanbot, which lives on the docker data disk that sem does not own), and every other step
# is deliberately a step sem can do, because the whole ownership design here is that the control
# plane writes files Jason can read over ssh without sudo.
#
# It is idempotent. Re-running it re-makes two directories that already exist, rebuilds the image
# from whatever sync.sh last shipped, and leaves cp.env exactly as it found it. The one thing it
# must never do twice is mint a second CP_SESSION_SECRET: every tenant relay is holding a key
# derived from the first one, and a new master signs sessions none of them will accept. So an
# existing value in cp.env is kept and a missing one is added, and nothing in this script rewrites
# a line that is already there.
#
# Env overrides, all optional:
#   TITANBOT_ROOT        the release tree, default /home/sem/titanbot
#   TITANBOT_TENANT_ROOT the tenant root, default /data/titanbot
#   TITANBOT_UID         uid to own the tenant root and run the image as, default `id -u`
#   TITANBOT_GID         gid, default `id -g`
#   TITANBOT_DRY_RUN=1   print every command it would run and change nothing
set -euo pipefail

ROOT="${TITANBOT_ROOT:-/home/sem/titanbot}"
TENANT_ROOT="${TITANBOT_TENANT_ROOT:-/data/titanbot}"
CP_DATA_DIR="$TENANT_ROOT/_control-plane"
CP_ENV="$ROOT/cp.env"
IMAGE=titanbot-cp:local
DRY="${TITANBOT_DRY_RUN:-0}"

# The uid the tenant root is owned by and the uid the image runs as, which have to be the same
# number or the service cannot write the directories it just made. Defaulting to the invoking
# user rather than to a literal 1001 because the literal is what went wrong the first time: sem on
# this machine is 1001, not the 1000 that "the first login account" usually is, and a number
# nobody measured is a number that silently owns files under an account that does not exist.
UID_WANT="${TITANBOT_UID:-$(id -u)}"
GID_WANT="${TITANBOT_GID:-$(id -g)}"

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

# Every command that changes something goes through this, so TITANBOT_DRY_RUN=1 is a real rehearsal
# rather than a comment in the header that drifted. In dry mode it prints and returns 0.
run() {
  if [ "$DRY" = 1 ]; then
    printf '  would run: %s\n' "$*"
    return 0
  fi
  "$@"
}

if [ "$DRY" = 1 ]; then
  printf '\n(dry run: nothing below is executed)\n'
fi

step "prerequisites"
[ "$UID_WANT" != 0 ] || die "run this as sem, not as root: everything it makes would come out root-owned"
say "will own $TENANT_ROOT as uid $UID_WANT gid $GID_WANT, and build the image to run as the same pair"

command -v docker >/dev/null || die "docker is not on PATH"
if [ "$DRY" != 1 ]; then
  docker info >/dev/null 2>&1 || die "docker is not usable by $(id -un) without sudo"
fi
command -v sudo >/dev/null || die "sudo is not on PATH (needed once, to make $TENANT_ROOT)"
command -v openssl >/dev/null || die "openssl is not on PATH (needed to generate the two secrets)"

# The build context is $ROOT and the Dockerfile copies several things out of it. Fail here, by name,
# rather than after a build that ends in a COPY error nobody can read.
for needed in cp/Dockerfile cp/server.mjs ui/auth.mjs ui/set-password.mjs deploy/coolify/docker-compose.yml deploy/coolify/box.compose.yml; do
  [ -f "$ROOT/$needed" ] || die "$ROOT/$needed is missing -- run deploy/r750/sync.sh from the Mac"
done
say "build context $ROOT has cp/, ui/auth.mjs, ui/set-password.mjs and the tenant compose template"

step "the tenant root"
# install -d is the idempotent form on purpose: it makes the directory when it is missing and sets
# the owner and the mode either way, so a second run repairs ownership rather than failing on
# "file exists". 0750 because the tenant directories under here hold gateway tokens and password
# files, and nothing but this uid and this group has any business reading them.
run sudo install -d -o "$UID_WANT" -g "$GID_WANT" -m 0750 "$TENANT_ROOT"
say "$TENANT_ROOT owned by $UID_WANT:$GID_WANT, mode 0750"
# The sqlite store. Under the tenant root so one bind mount and one backup cover both, and named
# with a leading underscore so no slug can ever collide with it.
run sudo install -d -o "$UID_WANT" -g "$GID_WANT" -m 0750 "$CP_DATA_DIR"
say "$CP_DATA_DIR owned by $UID_WANT:$GID_WANT, mode 0750"

step "the image"
# Coolify cannot build this: a Docker Compose Empty resource has no build context. So it is built
# here, by hand, from the tree sync.sh put on this server, and control-plane.compose.yml carries
# `pull_policy: never` so Coolify does not go looking for the tag in a registry.
run docker build -t "$IMAGE" -f "$ROOT/cp/Dockerfile" \
  --build-arg "UID=$UID_WANT" --build-arg "GID=$GID_WANT" "$ROOT"
say "built $IMAGE running as $UID_WANT:$GID_WANT"

step "the three secrets"
# Generated once, here, and read back by control-plane-coolify.mjs over ssh. They are never printed
# by this script and never leave this file except into Coolify's own environment store.
#
#   CP_SESSION_SECRET  the master every tenant's session key is derived from. Rotating it signs
#                      every customer out of every instance at once and needs every tenant relay
#                      given a new derived key in the same pass, so it is generated once and left
#                      alone.
#   CP_ADMIN_TOKEN     the operator bearer for the admin routes. Not a customer credential.
#   CP_RELAY_TOKEN     the console relay's own bearer, and the only thing that opens
#                      GET /v1/relay/tenants. That route hands the relay every customer's gateway
#                      token, so this is not the admin token and the admin token does not open it.
#                      The same value goes on the relay: one value, two places.
if [ "$DRY" = 1 ]; then
  if [ -f "$CP_ENV" ]; then
    say "would keep the existing $CP_ENV and add only the keys it is missing"
  else
    say "would create $CP_ENV at mode 0600 with CP_SESSION_SECRET, CP_ADMIN_TOKEN and CP_RELAY_TOKEN"
  fi
else
  # umask before the file exists, so it is never readable by anyone else for even an instant.
  ( umask 077; : >> "$CP_ENV" )
  chmod 600 "$CP_ENV"
  added=""
  for pair in "CP_SESSION_SECRET:32" "CP_ADMIN_TOKEN:24" "CP_RELAY_TOKEN:32"; do
    key="${pair%%:*}"
    bytes="${pair##*:}"
    if grep -q "^$key=" "$CP_ENV"; then
      say "$key is already in $CP_ENV, kept"
    else
      printf '%s=%s\n' "$key" "$(openssl rand -hex "$bytes")" >> "$CP_ENV"
      added="$added $key"
      say "$key generated"
    fi
  done
  [ -n "$added" ] || say "nothing added, $CP_ENV was already complete"
fi

printf '\n== done on the server\n'
say "tenant root  $TENANT_ROOT"
say "store        $CP_DATA_DIR"
say "image        $IMAGE"
say "secrets      $CP_ENV (mode 0600, values not printed anywhere)"
printf '\nNext, from the Mac, in this order:\n\n'
cat <<'NEXT'
  1. Create or update the Coolify service, set its environment, give it its address and start it.
     It reads the secrets out of cp.env over ssh and the Coolify pair out of your own shell:

       node deploy/r750/control-plane-coolify.mjs --dry-run     # read the plan first
       node deploy/r750/control-plane-coolify.mjs

  2. Check it answers, which needs no bearer and returns counts only:

       curl -s https://api.titanium.bot/v1/health

  3. Claim the instance that already exists, once. An adopted row with no box recorded is the
     normal shape of your own workspace: the relay builds that entry from its own environment.

       node cp/cli.mjs tenant adopt titanium p927bfqm83ioloibamlvyd7g console.titanium.bot

     You sign in to your own console with the INSTANCE PASSWORD, not with an account. An account on
     the `titanium` workspace cannot sign in today and reads "That workspace is not available right
     now": that slug has no derived session key on the relay on purpose, which is SIGNIN-2 in
     docs/GAP-ANALYSIS.md. `account add` is for a customer workspace, and it asks for the password
     on the terminal so nobody else ever sees it:

       node cp/cli.mjs account add them@example.com <their-workspace> --name "Their Name"

  docs/TENANCY.md section 9 is the same list with the reasoning.
NEXT
