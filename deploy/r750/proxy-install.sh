#!/usr/bin/env bash
# proxy-install.sh -- the part of the proxy deploy that has to happen ON THE R750 (PROXY-1).
#
# Three things live on the server and nowhere else: the two directories the proxy binds, the config
# file that goes in one of them, and the three secrets. This script makes all of them and then
# stops. It creates no Coolify object at all: deploy/r750/proxy-coolify.mjs does that half, from the
# Mac, and docs/PROXY.md runs the two in order.
#
#   bash /home/sem/titanbot/deploy/proxy-install.sh
#   bash /home/sem/titanbot/deploy/proxy-install.sh --pin-url   # AFTER the service is up
#
# Run it as sem, not with sudo. It calls sudo itself for the steps that need root (the directories
# live on the docker data disk, which sem does not own) and nothing else, because the whole
# ownership design here is that the operator can read what this makes over ssh without sudo.
#
# There is NO image build, and that is the one place this is simpler than its control-plane
# counterpart: the proxy runs a public image pinned by tag, so Coolify pulls it.
#
# It is idempotent. A second run re-makes directories that already exist, re-copies config.yaml
# (which is code, shipped by sync.sh, and is meant to be replaced), and leaves cp.env exactly as it
# found it. The thing it must never do twice is mint a second PROXY_MASTER_KEY or PROXY_SALT_KEY:
# the master is what the control plane authenticates with, and rotating the salt makes every stored
# credential unreadable. So an existing value is KEPT and a missing one is added, and no line that
# is already in that file is ever rewritten.
#
# ---- --pin-url ------------------------------------------------------------------------------------
# The second mode, run after the Coolify service exists. It reads the network alias docker ACTUALLY
# gave the proxy container -- not the compose's service key, which is a guess -- and writes
# CP_PROXY_URL into cp.env with the /v1 postfix, which is what the control plane is then given. If
# CP_PROXY_URL is already there it is kept and reported, like every other line in that file.
#
# Env overrides, all optional:
#   TITANBOT_ROOT         the release tree, default /home/sem/titanbot
#   TITANBOT_PROXY_ROOT   the proxy's storage, default /data/titanbot-proxy
#   TITANBOT_UID          uid to own the config directory, default `id -u`
#   TITANBOT_GID          gid, default `id -g`
#   TITANBOT_PROXY_DB_UID uid to own the Postgres directory, default 999 (the postgres image's own)
#   TITANBOT_PROXY_PORT   the port inside the bridge, default 4000
#   TITANBOT_DRY_RUN=1    print every command it would run and change nothing
set -euo pipefail

ROOT="${TITANBOT_ROOT:-/home/sem/titanbot}"
# A SIBLING of /data/titanbot, never a child. deploy/backup/snapshot.sh walks the tenant root one
# directory at a time and skips exactly one name; a proxy directory under there would be reported as
# a customer in every manifest and its Postgres taken as a torn file copy.
PROXY_ROOT="${TITANBOT_PROXY_ROOT:-/data/titanbot-proxy}"
CONFIG_DIR="$PROXY_ROOT/config"
PG_DIR="$PROXY_ROOT/postgres"
CP_ENV="$ROOT/cp.env"
PROXY_PORT="${TITANBOT_PROXY_PORT:-4000}"
DRY="${TITANBOT_DRY_RUN:-0}"

UID_WANT="${TITANBOT_UID:-$(id -u)}"
GID_WANT="${TITANBOT_GID:-$(id -g)}"
# The postgres image drops to uid 999 before initdb and does NOT chown a bind mount (measured on
# this Mac 2026-09-08: `id postgres` inside postgres:16 answers uid=999 gid=999). A data directory
# owned by sem therefore means initdb fails on permission and the proxy never gets a database. This
# is the one directory in this wave that is not owned by the invoking user.
PG_UID="${TITANBOT_PROXY_DB_UID:-999}"
PG_GID="${TITANBOT_PROXY_DB_GID:-999}"

MODE=install
case "${1:-}" in
  --pin-url) MODE=pin-url ;;
  "") MODE=install ;;
  *) echo "usage: $0 [--pin-url]" >&2; exit 64 ;;
esac

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

# ---- --pin-url ------------------------------------------------------------------------------------

if [ "$MODE" = pin-url ]; then
  step "the alias docker actually gave the proxy"
  command -v docker >/dev/null || die "docker is not on PATH"
  NAME="$(docker ps --filter label=com.titanbot.role=proxy --format '{{.Names}}' | head -n 1)"
  [ -n "$NAME" ] || die "no running container carries com.titanbot.role=proxy. Deploy the service in Coolify first, then run this again"
  say "container $NAME"
  # The aliases docker recorded for this container ON THE SHARED NETWORK, read back rather than
  # assumed from the compose's service key. Coolify renames the container, so the alias is the only
  # name the control plane and the boxes can rely on.
  NET="${TITANBOT_NET:-titanbot-net}"
  ALIAS="$(docker inspect "$NAME" --format "{{with index .NetworkSettings.Networks \"$NET\"}}{{range .Aliases}}{{.}} {{end}}{{end}}" 2>/dev/null | tr ' ' '\n' | grep -v '^$' | grep -v "^${NAME}\$" | head -n 1)"
  [ -n "$ALIAS" ] || die "$NAME is not on $NET, or has no alias there. The compose declares one; check the deploy"
  say "alias   $ALIAS on $NET"
  URL="http://$ALIAS:$PROXY_PORT/v1"
  say "url     $URL"

  step "cp.env"
  if [ "$DRY" = 1 ]; then
    say "would add CP_PROXY_URL=$URL to $CP_ENV if it is not already there"
    exit 0
  fi
  ( umask 077; : >> "$CP_ENV" )
  chmod 600 "$CP_ENV"
  if grep -q '^CP_PROXY_URL=' "$CP_ENV"; then
    say "CP_PROXY_URL is already in $CP_ENV, kept: $(grep '^CP_PROXY_URL=' "$CP_ENV" | cut -d= -f2-)"
    say "if that is not $URL, edit the line by hand: this script never rewrites one"
  else
    printf 'CP_PROXY_URL=%s\n' "$URL" >> "$CP_ENV"
    say "CP_PROXY_URL=$URL added"
  fi
  printf '\n== done\n'
  say "Next, from the Mac, so the control plane is given it:"
  say "  export CP_PROXY_URL=\"\$(ssh dell-remote \"grep '^CP_PROXY_URL=' $CP_ENV | cut -d= -f2-\")\""
  say "  export CP_PROXY_MASTER_KEY=\"\$(ssh dell-remote \"grep '^PROXY_MASTER_KEY=' $CP_ENV | cut -d= -f2-\")\""
  say "  node deploy/r750/control-plane-coolify.mjs"
  exit 0
fi

# ---- install --------------------------------------------------------------------------------------

step "prerequisites"
[ "$UID_WANT" != 0 ] || die "run this as sem, not as root: everything it makes would come out root-owned"
say "will own $CONFIG_DIR as uid $UID_WANT gid $GID_WANT, and $PG_DIR as $PG_UID:$PG_GID (the postgres image's own uid)"

command -v sudo >/dev/null || die "sudo is not on PATH (needed to make $PROXY_ROOT on the docker data disk)"
command -v openssl >/dev/null || die "openssl is not on PATH (needed to generate the three secrets)"

# The config file is shipped by deploy/r750/sync.sh. Fail here, by name, rather than making empty
# directories and leaving a proxy that starts and serves no model.
SRC_CONFIG="$ROOT/deploy/coolify/proxy-config/config.yaml"
[ -f "$SRC_CONFIG" ] || die "$SRC_CONFIG is missing -- run deploy/r750/sync.sh from the Mac, which ships it"
say "config source $SRC_CONFIG ($(wc -c < "$SRC_CONFIG" | tr -d ' ') bytes)"

step "the storage"
# install -d is the idempotent form on purpose: it makes the directory when it is missing and sets
# the owner and the mode either way, so a second run repairs ownership rather than failing on
# "file exists".
run sudo install -d -o "$UID_WANT" -g "$GID_WANT" -m 0750 "$PROXY_ROOT"
say "$PROXY_ROOT owned by $UID_WANT:$GID_WANT, mode 0750"
# 0755 on the config directory and 0644 on the file, because they hold no secret at all -- every
# credential in config.yaml is an os.environ reference -- and the proxy image's own user has to be
# able to read them whatever uid it runs as.
run sudo install -d -o "$UID_WANT" -g "$GID_WANT" -m 0755 "$CONFIG_DIR"
say "$CONFIG_DIR owned by $UID_WANT:$GID_WANT, mode 0755 (it holds no key, only os.environ names)"
# 0700, which is what postgres insists on: it refuses to start on a data directory with any group or
# other permission bit set.
run sudo install -d -o "$PG_UID" -g "$PG_GID" -m 0700 "$PG_DIR"
say "$PG_DIR owned by $PG_UID:$PG_GID, mode 0700 (postgres refuses a data directory any wider)"

step "the config"
run sudo install -o "$UID_WANT" -g "$GID_WANT" -m 0644 "$SRC_CONFIG" "$CONFIG_DIR/config.yaml"
say "$CONFIG_DIR/config.yaml"
if [ "$DRY" != 1 ]; then
  # What the operator has to have set for this file to serve anything. Names only: this script never
  # sees a value and never prints one.
  NEEDED="$(grep -oE 'os\.environ/[A-Z0-9_]+' "$CONFIG_DIR/config.yaml" | cut -d/ -f2 | sort -u | tr '\n' ' ')"
  say "it refers to these environment names, which proxy-coolify.mjs sets on the service: $NEEDED"
  MODELS="$(grep -oE '^  - model_name: [a-z0-9-]+' "$CONFIG_DIR/config.yaml" | awk '{print $3}' | sort -u | tr '\n' ' ')"
  say "and serves these model names, which are a contract with every box pointed at them: $MODELS"
fi

step "the three secrets"
# Generated once, here, and read back by proxy-coolify.mjs over ssh. They are never printed by this
# script and never leave this file except into Coolify's own environment store.
#
#   PROXY_MASTER_KEY   opens /key/generate and every admin route on the proxy. It goes to exactly
#                      two places: the proxy's own environment, and the control plane's as
#                      CP_PROXY_MASTER_KEY. Never a box. It is sk- prefixed because LiteLLM's own
#                      tooling and half its error messages assume that shape.
#   PROXY_SALT_KEY     the one-way key stored credentials are encrypted under. Rotating it makes
#                      them unreadable, which is why an existing value is never rewritten. With
#                      store_model_in_db false there is nothing stored yet, and PROXY-2 is the wave
#                      that changes that.
#   PROXY_DB_PASSWORD  the Postgres password. It is in the database's environment and inside
#                      PROXY_DATABASE_URL, and both come from this one line.
if [ "$DRY" = 1 ]; then
  if [ -f "$CP_ENV" ]; then
    say "would keep the existing $CP_ENV and add only the keys it is missing"
  else
    say "would create $CP_ENV at mode 0600 with PROXY_MASTER_KEY, PROXY_SALT_KEY and PROXY_DB_PASSWORD"
  fi
else
  # umask before the file exists, so it is never readable by anyone else for even an instant. On the
  # R750 this file already exists and already holds CP_SESSION_SECRET, CP_ADMIN_TOKEN and
  # CP_RELAY_TOKEN; this appends to it and touches no line that is there.
  ( umask 077; : >> "$CP_ENV" )
  chmod 600 "$CP_ENV"
  added=""
  for key in PROXY_MASTER_KEY PROXY_SALT_KEY PROXY_DB_PASSWORD; do
    if grep -q "^$key=" "$CP_ENV"; then
      say "$key is already in $CP_ENV, kept"
      continue
    fi
    case "$key" in
      PROXY_MASTER_KEY) value="sk-$(openssl rand -hex 24)" ;;
      *) value="$(openssl rand -hex 32)" ;;
    esac
    printf '%s=%s\n' "$key" "$value" >> "$CP_ENV"
    added="$added $key"
    say "$key generated"
  done
  [ -n "$added" ] || say "nothing added, $CP_ENV already had all three"
fi

printf '\n== done on the server\n'
say "storage   $PROXY_ROOT (config/ and postgres/)"
say "config    $CONFIG_DIR/config.yaml"
say "secrets   $CP_ENV (mode 0600, values not printed anywhere)"
say "no image build: the proxy runs a public image pinned by tag, so Coolify pulls it"
printf '\nNext, from the Mac, in this order:\n\n'
cat <<'NEXT'
  1. Create or update the Coolify service and set its environment. It reads the three secrets out
     of cp.env over ssh and the provider keys out of ~/.api_keys by exact name:

       node deploy/r750/proxy-coolify.mjs --dry-run     # read the plan first
       node deploy/r750/proxy-coolify.mjs

  2. Deploy the service in Coolify, then measure the alias and pin the url the control plane uses:

       ssh dell-remote bash /home/sem/titanbot/deploy/proxy-install.sh --pin-url

  3. Prove it is reachable from inside the bridge and published nowhere:

       docker exec <the relay container> curl -sf http://titanbot-proxy:4000/health/readiness
       docker port <the proxy container>      # must print nothing

  4. Open the one path a box needs, and check the rest is still shut:

       sudo systemctl start titanbot-isolation.service
       sudo bash /home/sem/titanbot/deploy/box-isolation.sh --verify

  docs/PROXY.md is the same list with the reasoning.
NEXT
