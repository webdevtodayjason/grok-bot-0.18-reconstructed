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

step "prepare the tree on $HOST"
ssh "$HOST" "mkdir -p '$ROOT/runtime' '$ROOT/profile' '$ROOT/credential' '$ROOT/ui' '$ROOT/deploy' && chmod 700 '$ROOT/profile' '$ROOT/credential'"
say "$ROOT/{runtime,profile,credential,ui,deploy}"

step "ship the artifacts"
rsync -a "$BUNDLE" "$HOST:$ROOT/runtime/host-main.cjs"
# The DIRECTORY is what the box bind-mounts, so ship it as one and delete anything stale in it.
rsync -a --delete "$BUILD/box-exec-daemon/" "$HOST:$ROOT/runtime/box-exec-daemon/"
say "runtime/host-main.cjs and runtime/box-exec-daemon/"

step "ship the relay"
# Named files, never the ui/ directory. That is the whole protection: ui/endpoints.json (API keys)
# and ui/subscriptions.json (adopted OAuth tokens) are not on this list, so they cannot be copied.
# There are deliberately no --exclude flags here; against an explicit file list they would match
# nothing and would only make it look as though a filter were doing the work. If anyone ever
# changes these arguments to ship "$REPO/ui/" wholesale, the excludes have to be added back at the
# same time, and machine-room/ below is the reminder of what a directory copy looks like.
rsync -a "$REPO/ui/server.mjs" "$REPO/ui/subscriptions.mjs" "$REPO/ui/auth.mjs" \
  "$REPO/ui/set-password.mjs" "$REPO/ui/index.html" "$HOST:$ROOT/ui/"
rsync -a --delete "$REPO/ui/machine-room/" "$HOST:$ROOT/ui/machine-room/"
say "ui/{server.mjs,subscriptions.mjs,auth.mjs,set-password.mjs,index.html,machine-room/}"
# auth.json is the server's own password, set on the server by set-password.mjs and never held on
# this Mac. It is on the same do-not-ship footing as the two files above, for the same reason.
say "endpoints.json, subscriptions.json and auth.json are not shipped"

step "ship the deploy scripts"
rsync -a "$REPO/deploy/r750/common.sh" "$REPO/deploy/r750/install.sh" \
  "$REPO/deploy/r750/uninstall.sh" "$REPO/deploy/r750/enable-route.sh" \
  "$REPO/deploy/r750/disable-route.sh" "$REPO/deploy/r750/relay.Dockerfile" "$HOST:$ROOT/deploy/"
rsync -a "$REPO/scripts/box-patches/apply-start-window-fix.sh" "$HOST:$ROOT/deploy/"
# The Coolify stack's init service runs this from the same directory, bind-mounted read-only. It
# lives here rather than under deploy/coolify on the server because that is the directory the
# compose file mounts and the only one the container can see.
rsync -a "$REPO/deploy/coolify/init-box.sh" "$HOST:$ROOT/deploy/"
say "deploy/{common.sh,install.sh,uninstall.sh,enable-route.sh,disable-route.sh,relay.Dockerfile,apply-start-window-fix.sh,init-box.sh}"

if [ "$INSTALL" = no ]; then
  printf '\n== shipped, not installed\n'
  say "run it yourself: ssh $HOST bash $ROOT/deploy/install.sh"
  exit 0
fi

step "install on $HOST"
ssh "$HOST" "bash '$ROOT/deploy/install.sh'"
