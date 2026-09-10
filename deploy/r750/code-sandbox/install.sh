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
