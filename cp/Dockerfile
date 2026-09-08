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

# cp/ is the whole service: server.mjs, session.mjs (a re-export), store.mjs, provision.mjs,
# admin.mjs and the admin/ page it serves, proxy.mjs, and cli.mjs.
#
# The DIRECTORY is copied, not a list of files, and that is worth saying out loud because a list is
# how a new module gets left out: the image would build cleanly and the service would fail at import
# on the first request that reached the route needing it. Adding a file to cp/ needs no change here.
COPY cp/ /app/cp/

# ui/auth.mjs is copied because cp/server.mjs imports clientAddress and parseTrustedProxies from it:
# the login lockout counts against the address the relay's own code decides on, and two
# implementations of that answer is how one of them goes stale.
#
# ui/set-password.mjs is copied for the operator, not for the code. It is a script with top-level
# prompts, so nothing imports it; it is here so the operator's own console password can be reset by
# hand from inside a container that has the release directory mounted. A tenant has no password file
# of its own any more: there is one relay, one operator auth.json, and a customer signs in with the
# account this service holds.
COPY ui/auth.mjs /app/ui/auth.mjs
COPY ui/set-password.mjs /app/ui/set-password.mjs

# ui/session-token.mjs is the mint and the verify. It is copied because cp/session.mjs is now a
# re-export of it (`export * from "../ui/session-token.mjs"`), which is what keeps one verifier in
# the tree instead of two: ui/ is the half that ships to every tenant relay, so the file has to live
# there, and the control plane reads the same bytes rather than its own copy of them. Without this
# line the image builds and then fails at import on the first sign-in.
COPY ui/session-token.mjs /app/ui/session-token.mjs

# ui/login-ledger.mjs is copied because cp/admin.mjs imports the keyed hash and the row shape from
# it. Both services write down who tried to sign in, and the super admin console shows the two
# ledgers as one list, so the row shape has to be one shape and the hash has to be one function.
#
# The SALTS stay separate and that is deliberate: the relay's salt lives in its state directory and
# this service's lives in CP_DATA_DIR, so a hash from one is never comparable to a hash from the
# other, and stealing either file does not widen the other's blast radius. The console counts
# distinct passwords per source for exactly that reason. ADMIN-1.
COPY ui/login-ledger.mjs /app/ui/login-ledger.mjs

# The template every tenant's compose is rendered from: ONE service, the box, on the shared network.
# The renderer replaces the four data-volume paths and the credential path with the tenant's own,
# keeps the runtime directory shared, writes the tenant's name into TENANT_ID and into its network
# alias, and stops rather than guessing if any of that is not where it expects. Shipping the
# template inside the image means a tenant created today is rendered from the file that was reviewed
# with this image, not from whatever is on the server.
#
# Without this line the image builds and then every provisioning run fails on the compose step with
# ENOENT, which is a build that looks fine until the first customer.
COPY deploy/coolify/box.compose.yml /app/deploy/coolify/box.compose.yml

# The operator's own two-container stack. Nothing here renders it any more; it is copied because
# deploy/r750/control-plane-install.sh checks for it before it will build, and because it is the
# file the box template above was cut from and a reader in this container will want it.
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
# Not root, and not the image's own `node` account either.
#
# Why not root: this process creates and writes every tenant's directories under CP_TENANT_ROOT, and
# those directories hold a tenant's gateway token and its relay password file. Running as root would
# make them root-owned on the host, which means the release files (owned by sem) and the tenant files
# (owned by root) end up in two ownership worlds on one disk, and a backup or an rsync run as sem
# starts failing on files it cannot read.
#
# Why an ARG rather than a number written in: the uid has to match the account that owns
# /home/sem/titanbot and runs every other deploy step on the server, and that account is not the same
# number everywhere. The image's `node` user is 1000, and this file used to say USER node believing
# 1000 was sem. Measured on the R750 on 2026-09-07: `id -u sem` is 1001, so the old line would have
# written every tenant directory as uid 1000, which on that box is somebody else entirely.
#
# The default is 1001 because that is the R750. Build it for a server where sem is a different
# number by passing the number:
#
#   docker build -t titanbot-cp:local -f cp/Dockerfile --build-arg UID=1001 .
#
# 1001 has no passwd entry in this image, which node does not need: it writes only CP_DATA_DIR and
# the tenant root, both given by env and both bind mounts from the host.
#
# The tenant root has to exist and be writable before the first start, owned by the same uid. Once,
# on the server (deploy/r750/control-plane-install.sh does this):
#
#   sudo install -d -o 1001 -g 1001 -m 0750 /data/titanbot
ARG UID=1001
ARG GID=1001
USER ${UID}:${GID}

CMD ["node", "/app/cp/server.mjs"]
