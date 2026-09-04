# The relay image. Two lines of substance, because ui/server.mjs has no npm dependencies at all:
# it imports only node builtins. There is no node_modules to ship and no build step to run.
#
# Pinned by digest for the same reason the box image is: this container holds the gateway token and
# a read-write docker socket, and a rebuild three months from now must not quietly ship a different
# node or a different libc into it. That digest is node:24-alpine as of 2026-09-04 (node v24.20.0).
# To move it deliberately: `docker buildx imagetools inspect node:24-alpine` and paste the digest.
FROM node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

# The docker CLI is not decoration. ui/server.mjs reaches the box's box-secrets.json (the model
# picker) and connectors.json exclusively through `docker exec`, because those files live in a
# docker volume with no path on the host. Without the CLI the console loads and the endpoint
# picker silently returns nothing, which is the worst possible failure: it looks fine.
#
# The package version is not pinned: it comes from the alpine branch of the base image above, so
# the digest pin is what actually fixes it, and an apk version pin would break the day the mirror
# drops that build. Printing the version puts it in the build log, so a change is visible.
RUN apk add --no-cache docker-cli && docker --version

# The relay's own files are bind-mounted at /app/ui by install.sh, so the image carries no app
# code. That is deliberate: re-shipping the UI is an rsync and a restart, not an image rebuild.
WORKDIR /app
CMD ["node", "/app/ui/server.mjs"]
