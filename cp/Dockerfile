# The control plane image. Like the relay's, it has two lines of substance, because cp/ has no npm
# dependencies at all: node builtins only, node:sqlite for the store and node:crypto for the
# passwords and the session signatures. There is no node_modules to ship and no build step to run.
#
# Build it from the REPO ROOT, not from this directory, because it copies ui/ as well as cp/:
#
#   docker build -t titanbot-cp:local -f cp/Dockerfile .
#
# Pinned by digest for the same reason deploy/r750/relay.Dockerfile is: this container holds the
# Coolify api key and the session secret every tenant relay trusts, and a rebuild six months from
# now must not quietly ship a different node or a different libc into it.
#
# That digest is the node:22-alpine multi-arch index as of 2026-09-06. Measured by running it:
#
#   node --version                     v22.23.2
#   import("node:sqlite")              resolves with no flag (it prints an ExperimentalWarning)
#   id node                            uid=1000(node) gid=1000(node)
#   alpine base                        3.24
#
# The node:sqlite line is the one worth keeping. It arrived in 22.5.0 behind --experimental-sqlite,
# and on this image the flag is no longer needed. An older 22.x pin would need it back, so if you
# ever move this digest downward, check that import before trusting the build.
# To move it deliberately: `docker buildx imagetools inspect node:22-alpine` and paste the digest.
FROM node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

WORKDIR /app

# cp/ is the whole service: server.mjs, session.mjs, store.mjs, provision.mjs, cli.mjs.
COPY cp/ /app/cp/

# ui/auth.mjs is copied because the provisioner writes each tenant's own auth.json with the
# routine the relay already reads: newAuthRecord and writeAuthFile. The relay parses that file at
# boot and throws on a shape it does not recognise, so the file format is not a thing to reimplement
# from memory. Copying the module means the two can never drift.
#
# ui/set-password.mjs is copied for the operator, not for the code. It is a script with top-level
# prompts, so nothing imports it; it is here so a password can be reset by hand from inside this
# container:
#
#   docker exec -it <cp container> node /app/ui/set-password.mjs /data/titanbot/<slug>/state/auth.json
COPY ui/auth.mjs /app/ui/auth.mjs
COPY ui/set-password.mjs /app/ui/set-password.mjs

# The template every tenant's compose is rendered from. The renderer replaces the four data-volume
# paths and the profile and credential paths with the tenant's own, keeps runtime, deploy and ui
# shared, and sets TENANT_ID. Shipping the template inside the image means a tenant created today
# is rendered from the file that was reviewed with this image, not from whatever is on the server.
COPY deploy/coolify/docker-compose.yml /app/deploy/coolify/docker-compose.yml

# ---- the defaults ------------------------------------------------------------------------------
# Set here as well as in control-plane.compose.yml so the image is honest on its own: a plain
# `docker run titanbot-cp:local` with only the two secrets given still starts, writes its store
# inside the tenant root, and does not try to make a directory under /app that this user does not
# own. The compose sets the same values again, which is what an operator reads and changes.
ENV CP_PORT=7790 \
    CP_DATA_DIR=/data/titanbot/_control-plane \
    CP_TENANT_ROOT=/data/titanbot \
    CP_RELEASE_ROOT=/home/sem/titanbot \
    CP_BASE_DOMAIN=titanium.bot \
    CP_PUBLIC_URL=https://api.titanium.bot \
    COOLIFY_ENVIRONMENT_NAME=production

# Documentation, not a published port: this service publishes nothing. Coolify's Traefik reaches it
# on the stack's own network, which is why control-plane.compose.yml has no `ports:` either.
EXPOSE 7790

# ---- the user ---------------------------------------------------------------------------------
# uid 1000, which the base image already carries as `node`.
#
# Why 1000 and not root: this process creates and writes every tenant's directories under
# CP_TENANT_ROOT, and those directories hold a tenant's gateway token and its relay password file.
# Running as root would make them root-owned on the host, which means the release files (owned by
# sem) and the tenant files (owned by root) end up in two ownership worlds on one disk, and a
# backup or an rsync run as sem starts failing on files it cannot read.
#
# Why 1000 specifically: it is the first login account on the R750, which is `sem`, the account
# that owns /home/sem/titanbot and runs every other deploy step there. Same uid inside the
# container and outside it means a file this service writes is a file Jason can read over ssh
# without sudo.
#
# The one thing to check before the first deploy, because it is the thing that would silently break
# this: `id -u sem` on the R750 must be 1000. If it is not, set `user: "<uid>:<gid>"` on the service
# in deploy/coolify/control-plane.compose.yml instead of changing this line, and the image stays
# the same for everyone.
#
# The tenant root has to exist and be writable before the first start. Once, on the server:
#
#   sudo install -d -o 1000 -g 1000 -m 0750 /data/titanbot
USER node

CMD ["node", "/app/cp/server.mjs"]
