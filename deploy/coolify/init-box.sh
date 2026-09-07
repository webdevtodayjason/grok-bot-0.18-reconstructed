#!/bin/sh
# init-box.sh -- the two post-start repairs, run once per deploy from inside a container.
#
# The hand install does these itself, right after `docker run`, because it is a script and can just
# keep going (deploy/r750/install.sh, "box patches"). A compose file has no "and then" step, so
# under Coolify the same work runs in the background from the relay container's start command and
# talks to the box through the docker socket:
#
#   1. apply-start-window-fix.sh, which edits /usr/local/bin/start-window INSIDE the box. That is a
#      filesystem change in the container, so it survives a restart and does NOT survive a
#      recreate -- and a Coolify redeploy recreates. Without it a forked agent gets a black screen.
#   2. sqlite3, which the image does not ship and learn-from-demonstration needs to read Chrome's
#      history database.
#
# Both steps check before they act, so running this on an already-repaired box changes nothing and
# says so. That is what makes it safe to run on every deploy.
#
# The box is found by LABEL, never by name. Coolify names a compose service's container after its
# own resource id, so `titanbot-box` may not be what the container is called; com.titanbot.role=box
# is set by the compose file and survives the renaming.
#
# On an instance with NO socket -- every tenant -- this script says so in one sentence and exits 0.
# Its two steps have somewhere else to happen: the box's own entrypoint installs sqlite3, and the
# start-window repair needs the socket and is applied only where there is one.
#
#   sh init-box.sh            wait for the box, then repair it
#   TITANBOT_DRY_RUN=1 ...    resolve and report only, change nothing
set -eu

FIX="${TITANBOT_FIX:-/init/apply-start-window-fix.sh}"
DEADLINE="${TITANBOT_INIT_TIMEOUT:-180}"
DRY_RUN="${TITANBOT_DRY_RUN:-0}"
# Overridable so the test can measure the no-socket path on a machine that has one.
SOCK="${TITANBOT_DOCKER_SOCK:-/var/run/docker.sock}"

say() { printf '  %s\n' "$*"; }
die() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

# No socket is not a failure, it is a customer's instance.
#
# A tenant's compose is rendered without /var/run/docker.sock on purpose (cp/provision.mjs), and
# this script runs from the relay's start command on every instance, tenant or not. Dying here put
# a FAILED line at the top of every tenant's log, directly above the correct sentence saying the
# console has no docker, which reads as a broken deploy and is not one. So it says what is true in
# one plain sentence and stops with a zero.
#
# What a tenant's box gets instead: sqlite3 is installed by the box's own entrypoint, which needs no
# socket, and the start-window repair is applied only where a socket exists. docs/TENANCY.md section
# 18 has the table.
if [ ! -S "$SOCK" ]; then
  say "this instance runs its box repairs from its own container, not from here"
  exit 0
fi

command -v docker >/dev/null || die "no docker CLI in this image; the init service needs one"
[ -f "$FIX" ] || die "$FIX is missing; deploy/r750/sync.sh ships it to /home/sem/titanbot/deploy"

BOX=""
i=0
while [ "$i" -lt "$DEADLINE" ]; do
  BOX="$(docker ps --filter label=com.titanbot.role=box --format '{{.Names}}' | head -n 1)"
  # The container existing is not the box being up. start-window is written by the image's own
  # boot, so its presence is the honest signal that there is something to repair.
  if [ -n "$BOX" ] && docker exec "$BOX" test -f /usr/local/bin/start-window 2>/dev/null; then break; fi
  BOX=""
  i=$((i + 2))
  sleep 2
done
[ -n "$BOX" ] || die "no container with label com.titanbot.role=box became ready within ${DEADLINE}s"
say "box container $BOX, ready after about ${i}s"

if [ "$DRY_RUN" = 1 ]; then
  say "DRY RUN: would run $FIX $BOX and install sqlite3 if it is missing"
  docker exec "$BOX" sh -c 'command -v sqlite3 >/dev/null && echo "  sqlite3 is already present" || echo "  sqlite3 would be installed"'
  exit 0
fi

sh "$FIX" "$BOX"

if docker exec "$BOX" sh -c 'command -v sqlite3 >/dev/null 2>&1'; then
  say "sqlite3 already present"
else
  docker exec "$BOX" sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq sqlite3' >/dev/null 2>&1 \
    && say "installed sqlite3" \
    || say "WARNING: the sqlite3 install failed; learn-from-demonstration's URL step will not work"
fi

say "done; nothing here runs again until the next deploy"
