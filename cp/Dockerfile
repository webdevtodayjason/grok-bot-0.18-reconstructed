# The control plane, as one small image.
#
#   docker build -t titanbot-cp:local -f cp/Dockerfile .
#
# Build it from the repository root, not from cp/, because the image needs three things from
# outside this directory: the base compose every tenant is rendered from, ui/auth.mjs (the relay's
# own password routine, imported rather than copied so a tenant's auth.json cannot drift from what
# the relay reads at boot), and nothing else.
#
# node:22-alpine, and no npm install step at all. This service has no dependencies: node:sqlite for
# the store, node:crypto for the passwords and the signatures, node:http for the API. There is no
# package.json in the image and no node_modules, which is the point.
FROM node:22-alpine

# ---- the uid ------------------------------------------------------------------------------------
#
# This process has to write two places: the sqlite file under CP_DATA_DIR, and every tenant's
# directory tree under CP_TENANT_ROOT. Both are bind mounts from the host, so the uid in here has to
# be a uid that owns those directories out there. Running as root would make that trivially true and
# would also mean a flaw in this service is root on the host's /data/titanbot, which holds every
# customer's agents and transcripts.
#
# So: uid 10001, a number picked to be above every system account on Ubuntu 24.04 (which allocates
# real users from 1000 and system accounts below it) and unlikely to collide with a person. The
# operator makes the directories match once, at install:
#
#   sudo mkdir -p /data/titanbot
#   sudo chown -R 10001:10001 /data/titanbot
#
# The node image already ships a "node" user at uid 1000. It is deliberately not used: 1000 is the
# first human account on that server, and a container writing as the operator's own uid is the kind
# of thing that looks fine until someone wonders why root-owned files appeared in their home.
RUN addgroup -g 10001 -S titanbot && adduser -u 10001 -S -G titanbot titanbot

WORKDIR /app
COPY cp/ /app/cp/
COPY ui/auth.mjs /app/ui/auth.mjs
COPY deploy/coolify/docker-compose.yml /app/deploy/coolify/docker-compose.yml

# The data directory is created here so a first start on an empty mount does not depend on the
# host's permissions being exactly right before anything has run.
RUN mkdir -p /data/cp && chown -R titanbot:titanbot /app /data/cp

USER titanbot

ENV CP_PORT=7790 \
    CP_DATA_DIR=/data/cp \
    CP_TENANT_ROOT=/data/titanbot \
    CP_RELEASE_ROOT=/home/sem/titanbot \
    CP_BASE_DOMAIN=titanium.bot \
    COOLIFY_ENVIRONMENT_NAME=production

EXPOSE 7790

# No health check here. Coolify's own container health display is what an operator watches, and
# GET /v1/health is the endpoint for anything else that wants to ask.
CMD ["node", "/app/cp/server.mjs"]
