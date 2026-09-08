#!/usr/bin/env bash
# sync.sh -- build on the Mac, ship to the R750, install there. Runs ON THE MAC, from the repo root.
#
# The server has no checkout and no node_modules, so both artifacts are built here and copied.
# The build is not optional and not cached: the host bundle is compiled from source/ every time,
# and its sha256 is printed, so a deploy is anchored to an artifact rather than to a timestamp.
#
#   bash deploy/r750/sync.sh              build, ship, install
#   bash deploy/r750/sync.sh --no-install ship only, run install.sh yourself
#
# Env overrides:
#   TITANBOT_HOST   ssh destination, default dell-remote
#   TITANBOT_ROOT   install tree on the server, default /home/sem/titanbot
#
# Never copied: ui/endpoints.json, ui/subscriptions.json and ui/auth.json. The first carries API
# keys, the second adopted OAuth tokens, the third the relay's password hash and cookie secret, and
# none of them belongs on a machine the operator has not chosen to put them on. The Mac's gateway
# token is never copied either; install.sh mints the server its own, and the server's relay
# password is set on the server with ui/set-password.mjs.
#
# This does not publish anything. install.sh attaches no Traefik label unless the operator has
# already run deploy/enable-route.sh, so a redeploy cannot put a route live by surprise -- and,
# equally, cannot take a live one down.
set -euo pipefail

# What ships is what was verified. A dirty tree shipped mid-wave once (2026-09-04): production ran
# an unverified tool withhold and a runaway agent loop for an hour. Refuse unless told otherwise.
if [ "${TITANBOT_ALLOW_DIRTY:-0}" != "1" ] && [ -n "$(git -C "$(dirname "$0")/../.." status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  echo "sync.sh: refusing to ship a dirty tree; commit first, or build from a clean worktree of the commit, or set TITANBOT_ALLOW_DIRTY=1 for a deliberate exception" >&2
  exit 3
fi

HOST="${TITANBOT_HOST:-dell-remote}"
ROOT="${TITANBOT_ROOT:-/home/sem/titanbot}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$REPO/.cache/hostbuild"
INSTALL=yes
[ "${1:-}" = --no-install ] && INSTALL=no

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

cd "$REPO"

step "build the host bundle"
# buildProductionHostIfSupplied fails closed on unbound mandatory bindings or an unsupported
# runner activation, so a non-zero exit here means the tree is not shippable, not that the build
# tooling broke.
node scripts/build-host.mjs --out "$BUILD" || die "the host build did not come back clean; nothing was shipped"
BUNDLE="$BUILD/dist/host/host-main.cjs"
[ -f "$BUNDLE" ] || die "$BUNDLE was not produced"
say "host-main.cjs  $(wc -c < "$BUNDLE" | tr -d ' ') bytes  sha256 $(shasum -a 256 "$BUNDLE" | cut -d' ' -f1)"

step "build the box exec daemon"
# Built from this tree rather than copied out of the leaked profile: it is a plain esbuild CJS
# bundle with no architecture in it, and building it keeps the deploy sourced from source.
node scripts/build-box-exec-daemon.mjs "$BUILD/box-exec-daemon/main.cjs" >/dev/null || die "the exec daemon build failed"
DAEMON="$BUILD/box-exec-daemon/main.cjs"
say "box-exec-daemon/main.cjs  $(wc -c < "$DAEMON" | tr -d ' ') bytes  sha256 $(shasum -a 256 "$DAEMON" | cut -d' ' -f1)"

step "stage the host bundle version"
# SHIP-2. The box's own self-upgrade reads <base>/sand-host-bundle-latest.version and then
# <base>/sand-host-bundle-<version>.tgz, and the relay serves both out of this runtime directory.
# Only the version file is written here: the tarball is composed inside the box at request time,
# because the supervisor prunes every entry of /home/box/sand-host the archive does not carry and
# the parts of that tree this repo does not build come from the box image. ui/host-bundle.mjs says
# it in full. A clean tree's version is its short git sha; sync.sh already refuses a dirty one.
node scripts/stage-host-bundle.mjs --dir "$BUILD/dist/host" --host-main "$BUNDLE" \
  || die "the host bundle version could not be staged"
VERSION_FILE="$BUILD/dist/host/sand-host-bundle-latest.version"
[ -f "$VERSION_FILE" ] || die "$VERSION_FILE was not produced"
say "version $(cat "$VERSION_FILE")"

step "prepare the tree on $HOST"
ssh "$HOST" "mkdir -p '$ROOT/runtime' '$ROOT/profile' '$ROOT/credential' '$ROOT/ui' '$ROOT/deploy' && chmod 700 '$ROOT/profile' '$ROOT/credential'"
say "$ROOT/{runtime,profile,credential,ui,deploy}"

step "ship the artifacts"
rsync -a "$BUNDLE" "$HOST:$ROOT/runtime/host-main.cjs"
# Beside the bundle, always: install.sh refuses to run without it, and a relay advertising a version
# whose bytes are not the ones next to it is the one failure this pair exists to make impossible.
rsync -a "$VERSION_FILE" "$HOST:$ROOT/runtime/sand-host-bundle-latest.version"
# The DIRECTORY is what the box bind-mounts, so ship it as one and delete anything stale in it.
rsync -a --delete "$BUILD/box-exec-daemon/" "$HOST:$ROOT/runtime/box-exec-daemon/"
# BROWSER-1. The browser driver, straight from the repo rather than out of $BUILD: it is six plain
# .mjs files with no dependencies and no build step, which is the whole reason it is written that
# way. There is no npm install inside a box and no node_modules under the mount, so anything the
# driver needed would have to be vendored; instead it needs nothing, including a WebSocket, which it
# implements itself because the box's node 20 keeps the global one behind a flag.
#
# Nothing new has to be mounted for this to arrive. Every box already bind-mounts this whole
# directory read-only at /opt/titanbot-runtime (deploy/r750/install.sh, and the same line in
# deploy/coolify/box.compose.yml and docker-compose.yml), so these files land inside the box at
# /opt/titanbot-runtime/browser-driver/ and the tools run them from there. Read-only is correct:
# the driver writes nothing next to itself, only under /tmp/.titanbot-browser.
#
# --delete, like the daemon above, because a stale module left behind by an older ship is a file
# node will happily import.
[ -d "$REPO/runtime/browser-driver" ] || die "$REPO/runtime/browser-driver is missing; the box has no browser driver to mount"
rsync -a --delete "$REPO/runtime/browser-driver/" "$HOST:$ROOT/runtime/browser-driver/"

# TENANT-4. The start-window repair goes into the RUNTIME directory as well as into deploy/.
#
# deploy/ below is where the host-side copy lives, for init-box.sh and the hand install; a tenant's
# box has no socket and cannot be reached from there, so it runs the repair on itself from its own
# entrypoint and reads it from the one directory every box already mounts read-only,
# /opt/titanbot-runtime. Two copies of one file, and this is the one a customer's box uses.
rsync -a "$REPO/scripts/box-patches/apply-start-window-fix.sh" "$HOST:$ROOT/runtime/apply-start-window-fix.sh"
say "runtime/host-main.cjs, runtime/sand-host-bundle-latest.version, runtime/box-exec-daemon/, runtime/browser-driver/ and runtime/apply-start-window-fix.sh"

step "ship the relay"
# Named files, never the ui/ directory. That is the whole protection: ui/endpoints.json (API keys)
# and ui/subscriptions.json (adopted OAuth tokens) are not on this list, so they cannot be copied.
# There are deliberately no --exclude flags here; against an explicit file list they would match
# nothing and would only make it look as though a filter were doing the work. If anyone ever
# changes these arguments to ship "$REPO/ui/" wholesale, the excludes have to be added back at the
# same time, and machine-room/ below is the reminder of what a directory copy looks like.
# SHIP-3: every module beside the relay, not a hand-kept list. The list above missed
# vnc-bridge.mjs (qol/vnc-paste) and job-bus-edge.mjs (JOBBUS-2), both imported by server.mjs, and a
# ship of server.mjs without them takes the relay down at import. The glob is .mjs only, so the
# three do-not-ship .json files stay where they are.
rsync -a "$REPO"/ui/*.mjs "$REPO/ui/index.html" "$HOST:$ROOT/ui/"
rsync -a --delete "$REPO/ui/machine-room/" "$HOST:$ROOT/ui/machine-room/"
say "ui/{$(cd "$REPO/ui" && ls *.mjs | tr '\n' ',')index.html,machine-room/}"
# And prove the relay's own imports resolve on the server before anything restarts it: a missing
# module is an outage, and this is the moment it is still cheap to know.
for mod in $(grep -oE 'from "\./[A-Za-z0-9_-]+\.mjs"' "$REPO/ui/server.mjs" | grep -oE '[A-Za-z0-9_-]+\.mjs'); do
  ssh "$HOST" "test -f '$ROOT/ui/$mod'" || die "ui/server.mjs imports ./$mod but $ROOT/ui/$mod is not on the server after the sync"
done
say "every module ui/server.mjs imports is on the server"
# auth.json is the server's own password, set on the server by set-password.mjs and never held on
# this Mac. It is on the same do-not-ship footing as the two files above, for the same reason.
say "endpoints.json, subscriptions.json, auth.json and mail.json are not shipped"

step "ship the deploy scripts"
# control-plane-install.sh and proxy-install.sh are here rather than with the cp/ files below
# because they are deploy scripts that run ON the server, like the other five. Their other halves,
# deploy/r750/control-plane-coolify.mjs and deploy/r750/proxy-coolify.mjs, are deliberately NOT
# shipped: each holds the Coolify api key in its environment while it runs, and that key can delete
# every resource on this machine. Both run from the Mac.
rsync -a "$REPO/deploy/r750/common.sh" "$REPO/deploy/r750/install.sh" \
  "$REPO/deploy/r750/uninstall.sh" "$REPO/deploy/r750/enable-route.sh" \
  "$REPO/deploy/r750/disable-route.sh" "$REPO/deploy/r750/relay.Dockerfile" \
  "$REPO/deploy/r750/move-relay-state.sh" \
  "$REPO/deploy/r750/one-console-migrate.sh" \
  "$REPO/deploy/r750/box-isolation.sh" \
  "$REPO/deploy/r750/titanbot-isolation.service" "$REPO/deploy/r750/titanbot-isolation.timer" \
  "$REPO/deploy/r750/control-plane-install.sh" \
  "$REPO/deploy/r750/proxy-install.sh" "$HOST:$ROOT/deploy/"
rsync -a "$REPO/scripts/box-patches/apply-start-window-fix.sh" "$HOST:$ROOT/deploy/"
# TENANT-8. The settings a box starts with, and the one-off that adds them to a tenant provisioned
# before the provisioner wrote them. Both go to the server because the tenant trees are there:
# /data/titanbot/<slug>/volumes/data is the host side of each box's /home/box/sand-data. The
# backfill adds only what is missing, restarts nothing and recreates nothing, so it is safe to have
# sitting on the host between runs.
rsync -a --delete "$REPO/deploy/box-defaults/" "$HOST:$ROOT/deploy/box-defaults/"
rsync -a "$REPO/scripts/backfill-box-defaults.mjs" "$HOST:$ROOT/deploy/"
# The Coolify stack's init service runs this from the same directory, bind-mounted read-only. It
# lives here rather than under deploy/coolify on the server because that is the directory the
# compose file mounts and the only one the container can see.
rsync -a "$REPO/deploy/coolify/init-box.sh" "$HOST:$ROOT/deploy/"
# BACKUP-1: the snapshot job, its restore drill and the two systemd units install.sh copies into
# ~/.config/systemd/user. A directory, because the units name paths inside it.
ssh "$HOST" "mkdir -p '$ROOT/deploy/backup'"
rsync -a --delete "$REPO/deploy/backup/" "$HOST:$ROOT/deploy/backup/"
say "deploy/{common.sh,install.sh,uninstall.sh,enable-route.sh,disable-route.sh,relay.Dockerfile,move-relay-state.sh,one-console-migrate.sh,box-isolation.sh,titanbot-isolation.{service,timer},control-plane-install.sh,proxy-install.sh,apply-start-window-fix.sh,init-box.sh,backfill-box-defaults.mjs,box-defaults/,backup/}"

step "ship the control plane"
# TENANT-1. docs/TENANCY.md section 9 tells the operator to run this script and then build the
# control plane image on the server with `-f $ROOT/cp/Dockerfile $ROOT`. Nothing here shipped cp/
# or the two compose files, so that build could not run at all: the first documented step of the
# deploy had nothing to build from.
#
# The image's build context is $ROOT, and the Dockerfile copies cp/, ui/auth.mjs,
# ui/set-password.mjs (both already shipped above), deploy/coolify/box.compose.yml, which is the
# template every tenant is rendered from, and deploy/coolify/docker-compose.yml, which is the
# operator's own stack and the file the install script checks for. So all of them have to be here.
#
# box.compose.yml in particular: without it the image builds and then every provisioning run fails
# on the compose step with ENOENT, which is a deploy that looks fine until the first customer.
#
# cp/*.mjs and cp/*.md by glob and the Dockerfile by name, never the directory: cp/.data is the
# local sqlite store with account rows in it, and a directory copy would carry it to the server.
# The markdown glob is what stops the next document written beside the code being left behind: it
# is how PROVIDERS-1 added cp/PROVIDERS-ROUTES.md and the build context on the server stayed whole.
ssh "$HOST" "mkdir -p '$ROOT/cp' '$ROOT/cp/admin' '$ROOT/deploy/coolify'"
rsync -a "$REPO"/cp/*.mjs "$REPO"/cp/*.md "$REPO/cp/Dockerfile" "$HOST:$ROOT/cp/"
# ADMIN-1. The super admin console's three files. A directory of its own, with --delete, because it
# is the one place under cp/ that is a whole directory and nothing in it is a secret: the page shell
# carries no customer data at all, and everything it renders arrives from a route that refuses
# anything but a super admin.
#
# It is a separate line rather than a wider glob for the reason two comments up: cp/ itself is never
# copied as a directory, because cp/.data is the local sqlite store with account rows in it. Without
# this line the image builds, the service starts, and GET /admin answers 500 "the admin console's
# index.html is not in this image", which is a deploy that looks fine until somebody opens it.
rsync -a --delete "$REPO/cp/admin/" "$HOST:$ROOT/cp/admin/"
rsync -a "$REPO/deploy/coolify/docker-compose.yml" "$REPO/deploy/coolify/box.compose.yml" "$REPO/deploy/coolify/control-plane.compose.yml" "$REPO/deploy/coolify/proxy.compose.yml" "$HOST:$ROOT/deploy/coolify/"
# PROXY-1. The proxy's model list, as a DIRECTORY with --delete, because proxy-install.sh copies
# whatever is in it into /data/titanbot-proxy/config and a stale file left behind by an older ship
# is a model list the proxy would happily serve. Without this line the installer stops by name on a
# missing config.yaml, which is the right failure and still a failure.
ssh "$HOST" "mkdir -p '$ROOT/deploy/coolify/proxy-config'"
rsync -a --delete "$REPO/deploy/coolify/proxy-config/" "$HOST:$ROOT/deploy/coolify/proxy-config/"
say "cp/{$(cd "$REPO/cp" && ls *.mjs *.md | tr '\n' ',')Dockerfile}, cp/admin/ and deploy/coolify/{docker-compose.yml,box.compose.yml,control-plane.compose.yml,proxy.compose.yml,proxy-config/}"
# The control plane's own store is never shipped. It lives on the server under /data/titanbot and
# holds every customer's password hash.
say "cp/.data is not shipped"

if [ "$INSTALL" = no ]; then
  printf '\n== shipped, not installed\n'
  say "run it yourself: ssh $HOST bash $ROOT/deploy/install.sh"
  exit 0
fi

step "install on $HOST"
# install.sh builds a STANDALONE instance: one titanbot-relay and one titanbot-box of its own, on a
# network called titanbot. On a server that Coolify already runs the fleet on, that is a second,
# useless copy sitting beside the real one, and it is not obvious from the output that it happened.
#
# Measured on the R750 2026-09-08, doing exactly this: a plain `sync.sh` to ship the proxy wave
# created titanbot-relay and titanbot-box beside the three live customer boxes. Nothing live broke,
# because the names do not collide, but the stray relay sat there restarting every few seconds
# because it has no password file, and somebody reading `docker ps` at three in the morning now has
# two things called a relay. On this fleet the shipping step is `--no-install`.
if ssh "$HOST" 'docker ps --format "{{.Names}}" 2>/dev/null | grep -qE "^titanbot-relay-[a-z0-9]+$"'; then
  printf '\n== shipped, and NOT installed\n'
  say "this server already runs the Coolify fleet: a container named titanbot-relay-<service uuid> is up."
  say "install.sh would build a SECOND, standalone relay and box beside it, which is not what you want."
  say "the files are shipped. What to do next depends on what changed:"
  say "  ui/          docker restart titanbot-relay-<service uuid>     (by NAME, never through Coolify)"
  say "  cp/          ssh $HOST bash $ROOT/deploy/control-plane-install.sh, then restart titanbot-cp"
  say "  the bundle   POST /api/updateHostNow to each box, one at a time, and wait for the supervisor"
  say "to build a standalone instance here anyway: ssh $HOST bash $ROOT/deploy/install.sh"
  exit 0
fi
ssh "$HOST" "bash '$ROOT/deploy/install.sh'"
