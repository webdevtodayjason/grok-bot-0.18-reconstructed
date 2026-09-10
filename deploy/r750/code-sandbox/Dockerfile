# deploy/r750/code-sandbox/Dockerfile -- the throwaway computer a coding task runs in (CODE-1).
#
# ONE IMAGE, NO KEYS. Nothing here is a credential and nothing here is per tenant: the model endpoint
# arrives as an environment value at create time and the model credential is piped in between create
# and start, into /run/code/env, which the entrypoint sources and then truncates. `docker inspect`
# on a running task therefore shows an endpoint and a model name and nothing else. MARKET-17 is the
# measured story of what happens when a key is on a command line instead.
#
# PINNED BY DIGEST. A tag moves. An image that silently changed under a wave that measured the old
# one is a debugging afternoon nobody would think to spend, and deploy/r750/install.sh already pins
# the box image this way for exactly that reason.
#
# node:22-bookworm-slim, 2026-09-09.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# apt, once, with the lists removed in the same layer so they are not in the image.
#
# ca-certificates   the proxy is plain http on an internal network, but npm and git need the store
#                   present or they fail in ways that read as network errors
# git               a task diffs and commits locally. It CANNOT clone: there is no egress. CODE-2
# ripgrep           how the agent reads a tree. Without it every search is a find|xargs grep
# python3 + venv    the other half of what a coding task is asked for
# curl, jq, less    the three things a shell task reaches for and then blames the image for
# procps           the agent shells out and reads its own process table
# python3-pytest   MEASURED ON THE R750 2026-09-10, on the first task that really finished. It was
#                  asked to "run the test", found no pytest, and could not install one -- there is no
#                  egress and that is deliberate -- so it wrote its own runner and said so. Honest,
#                  and still the wrong answer: running tests is the headline reason a job comes here,
#                  and the image is the only place a test runner can come from. It is apt's pytest
#                  rather than pip's for the same reason everything else here is: no network at build
#                  time beyond apt, and no pip cache in the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git ripgrep python3 python3-venv python3-pytest curl jq less procps \
 && rm -rf /var/lib/apt/lists/*

# THE CODING AGENT, pinned to an exact version. `@latest` in an image is the same class of mistake as
# a moving base tag: the version that answered the gate is not the version the next build installs.
# 2.1.267 is the version one headless turn was measured through the proxy on.
ARG CLAUDE_CODE_VERSION=2.1.267
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# The run user. node:22 already ships uid 1000 as `node`, which is the uid the box's own workspace
# is owned by, so an artifact this image writes is one the bot can open. The relay passes --user with
# the uid it read off the box, so this is the default rather than the rule.
#
# /run/code is 0711: the credential is copied in as root by the daemon and read by the run user by
# exact name. 0711 lets it traverse and not list, which is the weakest permission that still works.
RUN mkdir -p /run/code /task \
 && chmod 0711 /run/code \
 && chown 1000:1000 /task

COPY entrypoint.sh /usr/local/bin/code-task
RUN chmod 0755 /usr/local/bin/code-task

# Declared, not enforced: the relay passes --user and --workdir on every create, and a bare
# `docker run` of this image for a look around should behave the same way.
USER 1000:1000
WORKDIR /task
ENTRYPOINT ["/usr/local/bin/code-task"]
