#!/usr/bin/env bash
# proxy-install.sh -- the part of the proxy deploy that has to happen ON THE R750 (PROXY-1).
#
# Three things live on the server and nowhere else: the two directories the proxy binds, the config
# file that goes in one of them, and the three secrets. This script makes all of them and then
# stops. It creates no Coolify object at all: deploy/r750/proxy-coolify.mjs does that half, from the
# Mac, and docs/PROXY.md runs the two in order.
#
#   bash /home/sem/titanbot/deploy/proxy-install.sh                # stage 2, the steady state
#   bash /home/sem/titanbot/deploy/proxy-install.sh --stage 1      # the first restart of the move
#   bash /home/sem/titanbot/deploy/proxy-install.sh --pin-url      # AFTER the service is up
#
# ---- WHY THERE IS A --stage (PROVIDERS-1) ---------------------------------------------------------
# Providers, their keys and the plan models customers run on moved out of config.yaml and into the
# proxy's own Postgres, managed live from the Providers panel. That move is TWO restarts of a service
# every tenant's inference goes through, so there are two forms of the file and this script installs
# both into the config directory every time. --stage picks which one is ACTIVE:
#
#   --stage 1   config.stage1.yaml becomes config.yaml. store_model_in_db goes on and the global
#               allowed_routes list goes away, but model_list and the fallback map STAY, so the fleet
#               keeps serving from the file across the restart. Then, from inside titanbot-cp:
#                 node cp/cli.mjs proxy seed
#               which reads bootstrap.json beside the config and writes the credentials, the
#               deployments and the fallback map. It runs once on a fresh install and refuses to run
#               if store_model_in_db did not actually take.
#   --stage 2   config.yaml (the steady state) becomes active. model_list and the fallback map are
#               gone from the file and the proxy serves the rows seeded above. This is the default.
#
# THE ORDER BEFORE STAGE 1 IS LOAD BEARING. Every virtual key already in the field was minted with
# allowed_routes [] and is therefore unrestricted, and stage 1 is the restart that removes the global
# list. So run the per-key backfill FIRST, from inside titanbot-cp:
#   node cp/cli.mjs proxy limits --all
# It needs no restart and writes nothing into any box. Doing it afterwards leaves a window in which
# the whole admin surface is open to every box on the bridge.
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
# Which of the two staged forms becomes the ACTIVE config.yaml. Both are always installed; this
# picks. 2 is the steady state, so it is the default and nobody has to remember a flag after the
# move is done.
STAGE="${TITANBOT_PROXY_STAGE:-2}"
while [ $# -gt 0 ]; do
  case "$1" in
    --pin-url) MODE=pin-url; shift ;;
    --stage) STAGE="${2:-}"; shift 2 ;;
    --stage=*) STAGE="${1#--stage=}"; shift ;;
    *) echo "usage: $0 [--pin-url] [--stage 1|2]" >&2; exit 64 ;;
  esac
done
case "$STAGE" in
  1|2) ;;
  *) echo "usage: $0 [--pin-url] [--stage 1|2]  (--stage was '$STAGE')" >&2; exit 64 ;;
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

# The config files are shipped by deploy/r750/sync.sh. Fail here, by name, rather than making empty
# directories and leaving a proxy that starts and serves no model. All three are required: the two
# staged forms and the bootstrap the seed reads.
SRC_DIR="$ROOT/deploy/coolify/proxy-config"
SRC_STAGE2="$SRC_DIR/config.yaml"
SRC_STAGE1="$SRC_DIR/config.stage1.yaml"
SRC_BOOTSTRAP="$SRC_DIR/bootstrap.json"
for f in "$SRC_STAGE2" "$SRC_STAGE1" "$SRC_BOOTSTRAP"; do
  [ -f "$f" ] || die "$f is missing -- run deploy/r750/sync.sh from the Mac, which ships it"
done
case "$STAGE" in
  1) SRC_CONFIG="$SRC_STAGE1" ;;
  2) SRC_CONFIG="$SRC_STAGE2" ;;
esac
say "config source $SRC_CONFIG ($(wc -c < "$SRC_CONFIG" | tr -d ' ') bytes), installing as stage $STAGE"
say "both staged forms and bootstrap.json are copied whichever stage is active"

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
say "$CONFIG_DIR/config.yaml   (stage $STAGE)"
# Both forms and the bootstrap go in beside it, always. The one that is not active is what a rollback
# reinstalls, and having to fetch it during an incident is how an incident gets longer.
run sudo install -o "$UID_WANT" -g "$GID_WANT" -m 0644 "$SRC_STAGE1" "$CONFIG_DIR/config.stage1.yaml"
run sudo install -o "$UID_WANT" -g "$GID_WANT" -m 0644 "$SRC_STAGE2" "$CONFIG_DIR/config.stage2.yaml"
run sudo install -o "$UID_WANT" -g "$GID_WANT" -m 0644 "$SRC_BOOTSTRAP" "$CONFIG_DIR/bootstrap.json"
say "$CONFIG_DIR/config.stage1.yaml, config.stage2.yaml and bootstrap.json are here too"
if [ "$DRY" != 1 ]; then
  # What the operator has to have set for this file to serve anything. Names only: this script never
  # sees a value and never prints one. As of PROVIDERS-1 these names are the FRESH-INSTALL BOOTSTRAP
  # ONLY: a live key is added, rolled and removed from the Providers panel, and an environment field
  # is never the way to change one on a running install.
  # Both files are read STRUCTURALLY, never scraped, and that is a fix rather than a preference. The
  # first version of this line ran `grep -o 'os\.environ/[A-Z0-9_]+'` over both whole files, which
  # also matched the PROSE in them -- bootstrap.json explains that an unset pass-through forwards the
  # literal string 'os.environ/NAME', so the installer printed `NAME` as an environment name the
  # operator had to set. It also picked up PROXY_BROWSER_KEY out of the commented-out cloud-browser
  # stub, which nothing reads. An install report that names a variable that does not exist is worse
  # than one that says nothing, so: from the YAML only a line that is a real mapping (no leading #),
  # and from the JSON only the "env" fields, which are the schema's own answer to this question.
  CFG_NAMES="$(grep -E '^[^#]*: *os\.environ/[A-Z0-9_]+' "$CONFIG_DIR/config.yaml" 2>/dev/null \
    | grep -oE 'os\.environ/[A-Z0-9_]+' | cut -d/ -f2 || true)"
  ENV_NAMES="$(grep -oE '"env": "[A-Z0-9_]+"' "$CONFIG_DIR/bootstrap.json" 2>/dev/null | cut -d'"' -f4 || true)"
  NEEDED="$(printf '%s\n%s\n' "$CFG_NAMES" "$ENV_NAMES" | grep -v '^$' | sort -u | tr '\n' ' ' || true)"
  say "it refers to these environment names, which proxy-coolify.mjs sets on the service: $NEEDED"
  say "those names are the FRESH-INSTALL bootstrap only; a live key goes in through the Providers panel"
  MODELS="$(grep -oE '"modelName": "[a-z0-9-]+"' "$CONFIG_DIR/bootstrap.json" 2>/dev/null | cut -d'"' -f4 | sort -u | tr '\n' ' ' || true)"
  say "a fresh install seeds these plan model names, which are a contract with every box pointed at them: $MODELS"
  # || true, because the shipped config.yaml declares NO model at all and grep exits 1 on no match,
  # which under set -e would end the install on the one line that is meant to report good news.
  FILE_MODELS="$(grep -oE '^  - model_name: [a-z0-9-]+' "$CONFIG_DIR/config.yaml" 2>/dev/null | awk '{print $3}' | sort -u | tr '\n' ' ' || true)"
  if [ -n "$FILE_MODELS" ]; then
    say "and THIS FILE still declares: $FILE_MODELS   (stage 1 does; stage 2 declares none, by design)"
  else
    say "and this file declares no model at all, which is stage 2: the deployments are database rows"
  fi
fi

step "the seed, which is a separate step and runs once"
say "config.yaml is a BOOTSTRAP now, not the model list. What a fresh install puts in the database is"
say "bootstrap.json, and the step that reads it runs from inside the control-plane container:"
say "  docker exec -it titanbot-cp node cp/cli.mjs proxy seed"
say "It is idempotent by refusal, not by overwriting: an install that already has rows is never"
say "re-seeded, and it stops if store_model_in_db did not actually take."
if [ "$STAGE" = 1 ]; then
  say ""
  say "STAGE 1, so read this order before you restart anything:"
  say "  1. node cp/cli.mjs proxy limits --all   FIRST. Every key already in the field was minted"
  say "     with no per-key route list, and this restart removes the global one. No restart needed,"
  say "     and it writes nothing into any box."
  say "  2. restart the proxy so this file takes effect. MEASURED on a Mac 2026-09-08, against a"
  say "     NON-EMPTY database and this exact file: readiness at 12.6 s, the first routed request at"
  say "     14.4 s. Budget about 20 s of failed turns fleet-wide and expect the R750 to be slower."
  say "  3. node cp/cli.mjs proxy seed"
  say "  4. for a short window each alias carries this file's deployments AND the database's. That is"
  say "     measured behaviour, not a fault: same keys, same models, a wider pool."
fi

step "what the backup covers, since this database now holds every provider key"
say "PROXY_SALT_KEY in $CP_ENV and /data/titanbot-proxy/postgres are the crown jewels: the control"
say "plane keeps NO second copy of any provider key, so losing either means re-entering them by hand."
say "Verified 2026-09-08: deploy/backup/snapshot.sh copies cp.env and pg_dumps the proxy database in"
say "a pass of its own, and deploy/backup/restore-drill.sh now restores the two TOGETHER and proves a"
say "credential decrypts. A dump without its salt is ciphertext nobody can read."

step "the three secrets"
# Generated once, here, and read back by proxy-coolify.mjs over ssh. They are never printed by this
# script and never leave this file except into Coolify's own environment store.
#
#   PROXY_MASTER_KEY   opens /key/generate and every admin route on the proxy. It goes to exactly
#                      two places: the proxy's own environment, and the control plane's as
#                      CP_PROXY_MASTER_KEY. Never a box. It is sk- prefixed because LiteLLM's own
#                      tooling and half its error messages assume that shape.
#   PROXY_SALT_KEY     the one-way key stored credentials are encrypted under. As of PROVIDERS-1
#                      that is EVERY PROVIDER SUBSCRIPTION THE OPERATOR HOLDS, and the control plane
#                      keeps no second copy of any of them by design. Rotating this value makes all
#                      of them unreadable, which is why an existing one is never rewritten, and why
#                      it is backed up with the proxy's pg_dump rather than beside it.
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
say "config    $CONFIG_DIR/config.yaml   (stage $STAGE; both forms and bootstrap.json are beside it)"
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

       # the relay image has no curl, so ask node, which it does have
       docker exec <the relay container> node -e 'fetch("http://titanbot-proxy:4000/health/readiness").then(r=>r.text()).then(console.log)'
       docker port <the proxy container>      # must print nothing

  4. Open the one path a box needs, and check the rest is still shut:

       systemctl --user start titanbot-isolation.service   # a USER unit; sudo says not found
       sudo bash /home/sem/titanbot/deploy/box-isolation.sh --verify

  5. Put the providers, their keys and the plan models INTO the database, which is where they live
     now. From inside the control-plane container, once:

       docker exec -it titanbot-cp node cp/cli.mjs proxy seed

     After that, adding a provider, adding a second or third key, rolling a key, repointing an alias
     at a new vendor model and setting what a customer's Titan calls it are all done from the
     Providers panel at api.titanium.bot/admin. None of them is an edit to config.yaml and none of
     them is a restart. If you find yourself editing that file to add a model, stop.

  docs/PROXY.md is the same list with the reasoning, and carries the rollback.
NEXT
