#!/usr/bin/env bash
# install.sh -- build the coding sandbox image on THIS machine (CODE-1, docs/CODE.md).
#
#   bash /home/sem/titanbot/deploy/code-sandbox/install.sh
#
# It builds one image and tags it. It starts nothing, restarts nothing, and touches no container, no
# network and no box: a task's container is made by the relay, one per task, and removed when the task
# ends. So this is safe to run on a live machine at any time, which is the point of it being its own
# script rather than a step inside a deploy.
#
# IT RUNS ON THE HOST AND NOT IN THE RELAY. The relay's image carries the docker CLI and no buildx,
# and its legacy builder is refused by a modern daemon, so a build from inside the relay fails with a
# message about a plugin rather than about anything real. deploy/r750/install.sh builds the relay image
# on the host for the same reason. The relay only ever RUNS this image.
#
# Env overrides:
#   TITANBOT_ROOT              install tree, default /home/sem/titanbot
#   TITANBOT_CODE_IMAGE        the tag, default titanbot/code-sandbox:1
#   TITANBOT_CODE_NO_CACHE=1   build from scratch, for when a pinned version moved under a tag
set -euo pipefail

ROOT="${TITANBOT_ROOT:-/home/sem/titanbot}"
IMAGE="${TITANBOT_CODE_IMAGE:-titanbot/code-sandbox:1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

step "prerequisites"
command -v docker >/dev/null || die "docker is not on PATH"
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
  || die "the docker daemon is not answering on this machine, so there is nothing to build with"
[ -r "$HERE/Dockerfile" ] || die "no Dockerfile beside this script ($HERE); run deploy/r750/sync.sh first"
[ -r "$HERE/entrypoint.sh" ] || die "no entrypoint.sh beside this script ($HERE); run deploy/r750/sync.sh first"
say "docker $(docker version --format '{{.Server.Version}}'), building from $HERE"

# The pinned base, read out of the Dockerfile rather than written twice. It goes in the output because
# "which base did this image come from" is the first question anybody asks about a sandbox.
BASE="$(awk '/^FROM /{print $2; exit}' "$HERE/Dockerfile")"
say "base $BASE"

step "build"
BUILD_ARGS=()
[ "${TITANBOT_CODE_NO_CACHE:-}" = "1" ] && BUILD_ARGS+=(--no-cache)

# buildx when it is there, the classic builder when it is not. Both produce an image with this tag in
# the local store, which is all the relay needs: nothing is pushed anywhere and there is no registry
# in this product's path at all.
START="$(date +%s)"
if docker buildx version >/dev/null 2>&1; then
  say "using buildx, loading into the local image store"
  docker buildx build --load "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" -t "$IMAGE" "$HERE" \
    || die "the sandbox image failed to build"
else
  say "no buildx on this machine, using the classic builder"
  docker build "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" -t "$IMAGE" "$HERE" \
    || die "the sandbox image failed to build"
fi
ELAPSED=$(( $(date +%s) - START ))

# ONE NEVER-STARTED CONTAINER, SO THE IMAGE CANNOT BE PRUNED AWAY.
#
# MEASURED ON THE R750 2026-09-10: `docker image inspect titanbot/code-sandbox:1` answered "No such
# image" about twenty minutes after a real task had run on it, so every coding task on the machine was
# refused with "The coding computer has not been built on this machine yet" and the only cure was a
# person running this script by hand. The cause is the server's own housekeeping: this host runs
# Jason's Coolify, whose row has force_docker_cleanup on and a nightly schedule, and its image prune
# spares only the repos Coolify itself deploys. A sandbox image is referenced by no container between
# tasks, which is exactly what a prune takes.
#
# `docker image prune -a` skips any image a container references, running or not, so one created and
# never started container is the whole fix. It costs nothing: it has no process, no network and no
# mount, it is never started, and the relay never lists it (the relay lists by the role label, which
# this does not carry).
step "keeper"
KEEPER="titanbot-code-image-keeper"
if [ -n "$(docker ps -aq --filter "name=^${KEEPER}$")" ]; then
  # Recreated rather than left alone: after a rebuild the old one holds the PREVIOUS image id, which is
  # then the thing the prune spares while the new one goes.
  docker rm -f "$KEEPER" >/dev/null 2>&1 || true
fi
if docker create --name "$KEEPER" "$IMAGE" true >/dev/null 2>&1; then
  say "$KEEPER created and never started, so an image prune cannot take $IMAGE"
else
  say "WARNING: could not create $KEEPER, so a docker cleanup on this host can prune $IMAGE and every"
  say "         coding task will then be refused until this script runs again."
fi

step "what was built"
SIZE="$(docker image inspect "$IMAGE" --format '{{.Size}}' 2>/dev/null || echo 0)"
SIZE_MB=$(( SIZE / 1000 / 1000 ))
AGENT="$(docker run --rm --entrypoint sh "$IMAGE" -c 'claude --version 2>/dev/null | head -1' 2>/dev/null || true)"
say "tag      $IMAGE"
say "base     $BASE"
say "size     ${SIZE_MB} MB"
say "build    ${ELAPSED} s on $(hostname -s 2>/dev/null || echo this machine)"
say "agent    ${AGENT:-could not be read}"
say ""
say "Nothing was started and nothing was restarted. The relay makes one container from this image per"
say "coding task and removes it when the task ends. $ROOT is untouched."
say ""
say "deploy/r750/install.sh runs this script, so a ship always restores the image. It is still safe to"
say "run on its own at any time, which is what to do if the relay logs that the image is not here."
