#!/usr/bin/env bash
# install.sh -- stand the box and the relay up on the R750. Runs ON THE SERVER, as sem, no sudo.
#
# Everything it creates is named titanbot-*: two containers, one network, four volumes, one image
# tag, and the tree under /home/sem/titanbot. It creates no Coolify object, writes no Traefik
# configuration, and by default attaches no Traefik labels, which matters because this machine
# also runs Jason's production Coolify stack and its proxy watches every container on the host.
#
# The public tb.semfreak.dev route is a separate, operator-run step: deploy/enable-route.sh. Until
# that has been run there is no titanbot router in Coolify's proxy at all. Once it has been run it
# leaves a marker file ($ROOT/route.enabled) and this script honours it, so a redeploy keeps the
# route instead of silently dropping it.
#
# It is idempotent by design. Re-running it recreates the two containers (their state lives in
# volumes, so nothing is lost), reuses the token and the credential file if they already exist,
# and skips the 5.2 GB image pull. The one thing it must never do twice is mint a new gateway
# token, because the box would then be holding a token the relay cannot read.
#
#   bash /home/sem/titanbot/deploy/install.sh
#
# Env overrides, all optional:
#   TITANBOT_ROOT         install tree, default /home/sem/titanbot
#   TITANBOT_RELAY_BIND   host IP the relay publishes on, default 100.110.83.82 (the tailnet address)
#   TITANBOT_RELAY_PORT   host port for the relay, default 7787
#   TITAN_JOB_TOKEN       the Titan Job Bus bearer (docs/JOB-BUS.md §2). Set only if you want the
#                         environment to hold it; unset is the normal case, and the console's
#                         Settings -> Job bus writes the token file instead
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

# Pinned by digest, not by tag. The :sand-box-latest tag has already moved once since the Mac
# pulled it, and an install that silently ships a different box than the one the host bundle was
# built against is a debugging nightmare nobody would think to look for.
BOX_IMAGE="public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:d0bb69285340df19d73f106492c7aabb723e8a950809b9f53a884888e2b4c709"

step "prerequisites"
command -v docker >/dev/null || die "docker is not on PATH"
docker info >/dev/null 2>&1 || die "docker is not usable by $(id -un) without sudo"
say "docker $(docker --version | awk '{print $3}' | tr -d ,) usable as $(id -un)"
command -v openssl >/dev/null || die "openssl is not on PATH (needed to mint the gateway token)"
command -v curl >/dev/null || die "curl is not on PATH (needed for the readiness probes)"

# Fail on a missing artifact here rather than after a 5 GB pull.
[ -f "$ROOT/runtime/host-main.cjs" ] || die "$ROOT/runtime/host-main.cjs is missing -- run deploy/r750/sync.sh from the Mac"
# SHIP-2: the version file is what the relay advertises and the box compares itself against. A ship
# writes it beside the bundle, so its absence means an old sync.sh put that bundle there.
[ -f "$ROOT/runtime/sand-host-bundle-latest.version" ] || die "$ROOT/runtime/sand-host-bundle-latest.version is missing -- run deploy/r750/sync.sh from the Mac (it stages the version beside the bundle)"
[ -f "$ROOT/runtime/box-exec-daemon/main.cjs" ] || die "$ROOT/runtime/box-exec-daemon/main.cjs is missing -- run deploy/r750/sync.sh from the Mac"
# BROWSER-1: the browser driver reaches a box through this same runtime mount, so a box installed
# without it has browser tools that cannot start. Checked here rather than discovered on the first
# page a person asks for. Two files, because they are the two ways in: cli.mjs is what an operator
# runs by hand, host-op.mjs is what Titan's browser tools run for every page they open.
[ -f "$ROOT/runtime/browser-driver/cli.mjs" ] || die "$ROOT/runtime/browser-driver/cli.mjs is missing -- run deploy/r750/sync.sh from the Mac (it ships runtime/browser-driver/ as a directory)"
[ -f "$ROOT/runtime/browser-driver/host-op.mjs" ] || die "$ROOT/runtime/browser-driver/host-op.mjs is missing -- run deploy/r750/sync.sh from the Mac (it ships runtime/browser-driver/ as a directory)"
[ -f "$ROOT/deploy/apply-start-window-fix.sh" ] || die "$ROOT/deploy/apply-start-window-fix.sh is missing -- run deploy/r750/sync.sh from the Mac"
# TENANT-4. The copy a BOX reads, in the one directory every box mounts read-only. The hand install
# below still applies the repair through the socket, because it has one and it is right there; a
# tenant's box has no socket and applies it to itself from its own entrypoint, and this is the file
# it reads. Both copies come from scripts/box-patches/apply-start-window-fix.sh in one sync.
[ -f "$ROOT/runtime/apply-start-window-fix.sh" ] || die "$ROOT/runtime/apply-start-window-fix.sh is missing -- run deploy/r750/sync.sh from the Mac (a customer's box repairs its own window from this copy)"
[ -f "$ROOT/ui/server.mjs" ] || die "$ROOT/ui/server.mjs is missing -- run deploy/r750/sync.sh from the Mac"
[ -f "$ROOT/ui/auth.mjs" ] || die "$ROOT/ui/auth.mjs is missing -- run deploy/r750/sync.sh from the Mac"
[ -f "$ROOT/ui/set-password.mjs" ] || die "$ROOT/ui/set-password.mjs is missing -- run deploy/r750/sync.sh from the Mac"
say "host bundle $(stat -c %s "$ROOT/runtime/host-main.cjs") bytes, sha256 $(sha256sum "$ROOT/runtime/host-main.cjs" | cut -c1-16)..."
say "exec daemon $(stat -c %s "$ROOT/runtime/box-exec-daemon/main.cjs") bytes, sha256 $(sha256sum "$ROOT/runtime/box-exec-daemon/main.cjs" | cut -c1-16)..."

# The relay publishes on the tailnet address specifically so it never appears on the LAN
# interface. If that address is not on this host the publish would fail with an opaque docker
# error, so check it by name first.
ip -o addr show 2>/dev/null | grep -qw "$RELAY_BIND" || die "$RELAY_BIND is not an address on this host; set TITANBOT_RELAY_BIND"
say "relay will publish on $RELAY_BIND:$RELAY_PORT"

if route_enabled; then
  say "route marker $ROUTE_MARKER is present, so the relay will be recreated WITH its Traefik"
  say "labels and reattached to the $ROUTE_NETWORK network"
else
  say "no route marker, so no Traefik label and no $ROUTE_NETWORK attachment (deploy/enable-route.sh turns that on)"
fi

step "gateway token"
mkdir -p "$ROOT/profile"
TOKEN_FILE="$ROOT/profile/local-docker-vm.json"
if [ -f "$TOKEN_FILE" ]; then
  # Reuse, always. Minting a second token would leave the running box authenticating with the
  # first one and every call through the relay answering 401.
  say "reusing the existing gateway token at $TOKEN_FILE (not printed)"
else
  ( umask 077; printf '{"schemaVersion":1,"token":"%s"}\n' "$(openssl rand -hex 32)" > "$TOKEN_FILE" )
  say "minted a fresh 64-hex gateway token at $TOKEN_FILE (not printed)"
fi
chmod 600 "$TOKEN_FILE"
# Read with sed rather than a JSON parser: the file is a one-line object this script wrote itself,
# and reaching for python3 here would add an unchecked prerequisite to a step that runs AFTER the
# token file exists, so a host without it would fail past the point of no return on every re-run.
TOKEN="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$TOKEN_FILE")"
[ "${#TOKEN}" -eq 64 ] || die "no 64-hex token could be read out of $TOKEN_FILE"
say "token length 64, file mode $(stat -c %a "$TOKEN_FILE")"

step "inference credential placeholder"
mkdir -p "$ROOT/credential"
CRED="$ROOT/credential/inference.json"
if [ -f "$CRED" ]; then
  say "keeping the existing $CRED"
else
  # The host boots without this file (auth-service logs that inference is unavailable and returns
  # normally), but box-store-sync's copy-in path throws when neither SAND_DEV_INFERENCE_TOKEN_FILE
  # nor SAND_INFERENCE_RENEWAL_CREDENTIAL is set and SAND_BOX_STORE_SYNC is on. A placeholder costs
  # nothing and sidesteps that one throw. Real inference comes from the endpoint picker, which
  # writes SAND_OPENAI_COMPATIBLE_* into the box's own secrets file.
  ( umask 077; printf '{"accessToken":"placeholder-not-a-credential","expiresAtMs":%s}\n' \
      "$(( ( $(date +%s) + 315360000 ) * 1000 ))" > "$CRED" )
  chmod 600 "$CRED"
  say "wrote a placeholder $CRED; it is NOT a credential, and real inference comes from the endpoint picker"
fi

step "network and volumes"
if docker network inspect "$NET" >/dev/null 2>&1; then say "network $NET already exists"
else docker network create "$NET" >/dev/null; say "created network $NET"; fi
for v in workspace data store chrome; do
  if docker volume inspect "titanbot-box-$v" >/dev/null 2>&1; then say "volume titanbot-box-$v already exists"
  else docker volume create "titanbot-box-$v" >/dev/null; say "created volume titanbot-box-$v"; fi
done

step "box image"
if docker image inspect "$BOX_IMAGE" >/dev/null 2>&1; then
  say "image already present, skipping the 5.2 GB pull"
else
  say "pulling $BOX_IMAGE (about 5.2 GB, first run only)"
  docker pull "$BOX_IMAGE"
fi

step "box container"
# `docker rm --force` exits 0 on a container that does not exist, so asking first is the only way
# this line can tell the truth on a fresh install.
if docker inspect "$BOX" >/dev/null 2>&1; then
  docker rm --force "$BOX" >/dev/null
  say "removed the previous $BOX (its data lives in the volumes, so nothing was lost)"
else
  say "no previous $BOX"
fi
# SHIP-2. host-main.cjs is COPIED into the box at start rather than bind-mounted over.
# A bind mount is a mount point, and the supervisor's bundle swap finishes with
# renameSync(staged, /home/box/sand-host/host-main.cjs) -- which cannot rename over a mount and
# fails the swap with EBUSY. Copying leaves an ordinary file the swap can replace, so a host-only
# ship works; the copy runs before the image's own entrypoint, so the box never executes the
# image's stock bundle even briefly, and a recreate puts the shipped bundle back. This is the same
# two lines deploy/coolify/docker-compose.yml already uses, for the same reason it uses them.
BOX_ENTRYPOINT='cp /opt/titanbot-runtime/host-main.cjs /home/box/sand-host/host-main.cjs || exit 1
exec /usr/local/bin/start-sand-box'

# No --platform: the remote manifest is a single amd64 image and this host is x86_64, so the flag
# would be a no-op that only invites confusion.
# The published ports are on the server's own loopback. Nothing needs them (the relay reaches the
# gateway as http://titanbot-box:1340 over the titanbot network) but they make `ssh -L` debugging
# and the VNC desktop reachable without recreating the container.
# CURSOR-4. No --env SAND_BACKEND_URL. It used to be https://api2.cursor.sh/ here, and because
# readSandBoxSetting reads the container environment before sand-host-settings.json, that made
# the file switch inert on every box: an operator could write a URL into the file and nothing
# read it. BOX-6 forbids recreating a live instance and docker restart does not re-read the
# environment, so the file has to be the switch. Unset is mode none, which is what a box with
# no backend of ours should be.
docker run --detach --name "$BOX" \
  --network "$NET" \
  --restart unless-stopped \
  --label com.titanbot.role=box \
  --env SAND_SUPERVISOR_ENABLED=1 --env SAND_DESKTOP_SUPERVISION_DISABLED=1 \
  --env SAND_BOX_AUTO_UPDATE=1 \
  --env SAND_BOX_STORE_COPY_IN=1 \
  --env "SAND_HOST_BUNDLE_S3_BASE_URL=http://$RELAY:7777/runtime/$TOKEN" \
  --env SAND_USE_EXISTING_BOX_EXEC_DAEMON=1 \
  --env SAND_TREE_SITTER_NODE_DEPS=/home/box/deps \
  --env NODE_PATH=/home/box/deps \
  --env SAND_GATEWAY_BIND_HOST=0.0.0.0 \
  --env SAND_HOST_PORT=1340 \
  --env SAND_GATEWAY_TOKEN="$TOKEN" \
  --env SAND_BOX_STORE_SYNC=1 \
  --env SAND_BOX_STORE_LOCAL_DIR=/var/lib/sand-box-store \
  --env SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json \
  --publish 127.0.0.1:1337:1337 \
  --publish 127.0.0.1:1339:1339 \
  --publish 127.0.0.1:1340:1340 \
  --publish 127.0.0.1:6080:6080 \
  --publish 127.0.0.1:6081:6081 \
  --publish 127.0.0.1:8790:8790 \
  --volume titanbot-box-workspace:/workspace \
  --volume titanbot-box-data:/home/box/sand-data \
  --volume titanbot-box-store:/var/lib/sand-box-store \
  --volume titanbot-box-chrome:/home/box/chrome-profile \
  --mount "type=bind,src=$ROOT/runtime,dst=/opt/titanbot-runtime,readonly" \
  --mount "type=bind,src=$ROOT/runtime/box-exec-daemon,dst=/home/box/box-exec-daemon,readonly" \
  --mount "type=bind,src=$ROOT/credential,dst=/run/grok-bot,readonly" \
  --entrypoint /bin/sh \
  "$BOX_IMAGE" -c "$BOX_ENTRYPOINT" >/dev/null
say "started $BOX on network $NET, gateway ports on 127.0.0.1 only"

step "box patches"
# The window-script repairs are a filesystem change inside the container: they survive a restart
# but not a recreate, which is exactly what just happened.
ok=no
for i in $(seq 1 60); do
  if docker exec "$BOX" test -f /usr/local/bin/start-window 2>/dev/null; then ok=yes; break; fi
  sleep 2
done
[ "$ok" = yes ] || { docker logs --tail 40 "$BOX"; die "/usr/local/bin/start-window never appeared in $BOX after 120 s"; }
say "start-window present after ~$(( i * 2 )) s"
sh "$ROOT/deploy/apply-start-window-fix.sh" "$BOX"
# learn-from-demonstration copies Chrome's History database and queries it with sqlite3, which the
# image does not ship.
if docker exec "$BOX" sh -c 'command -v sqlite3 >/dev/null 2>&1'; then
  say "sqlite3 already present in the box"
else
  docker exec "$BOX" sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq sqlite3' >/dev/null 2>&1 \
    && say "installed sqlite3 in the box" || say "WARNING: sqlite3 install failed; learn-from-demonstration's URL step will not work"
fi

step "gateway readiness"
# Probe the box directly first. If this fails the relay is not the problem, and saying so here
# saves an hour of looking at the wrong container.
code=000
for i in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' \
    http://127.0.0.1:1340/api/getHostStatus || true)"
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || { docker logs --tail 40 "$BOX"; die "the box gateway never answered getHostStatus with 200 (last: HTTP $code)"; }
say "box gateway answered getHostStatus 200 after ~$(( i * 2 )) s"

step "relay image"
docker build --quiet -t "$RELAY_IMAGE" -f "$ROOT/deploy/relay.Dockerfile" "$ROOT/deploy" >/dev/null \
  || die "the relay image failed to build; if apk could not find docker-cli, edit deploy/relay.Dockerfile per its comment"
say "built $RELAY_IMAGE"

step "relay login"
# The relay binds 0.0.0.0 inside its container, so it refuses to start without a password. That is
# by construction rather than by warning: reaching the relay is the same thing as holding the
# gateway token, and there is no configuration of a published relay that makes no password safe.
AUTH_JSON="$ROOT/ui/auth.json"
if [ -f "$AUTH_JSON" ]; then
  chmod 600 "$AUTH_JSON"
  say "password already set in $AUTH_JSON (mode $(stat -c %a "$AUTH_JSON"); scrypt hash and cookie secret, never printed)"
  say "to change it: node $ROOT/ui/set-password.mjs   then   docker restart $RELAY"
else
  say "NO PASSWORD IS SET, so the relay will start, refuse to bind, and exit. On this server, run:"
  say "    node $ROOT/ui/set-password.mjs          prompts twice, no echo"
  say "  or, with no terminal to prompt on, pipe it in:"
  say "    printf '%s' '<password>' | node $ROOT/ui/set-password.mjs"
  say "then re-run this script:  bash $ROOT/deploy/r750/install.sh"
  # Re-running is the documented path rather than a restart because the read-only bind of the
  # password file is added when the container is CREATED, and only when the file already exists.
  # A bare restart brings the relay up reading the same file through the read-write ui/ mount, so
  # the container could rewrite the hash and the cookie secret. It works; it is just weaker.
  say "  (docker restart $RELAY also starts it, but the password file is then writable inside"
  say "   the container until the next install.sh recreates it read-only)"
fi

step "relay container"
if [ ! -f "$ROOT/ui/endpoints.json" ]; then
  say "WARNING: $ROOT/ui/endpoints.json is missing, so the model picker will be empty and no agent"
  say "         can answer. See operator checklist item 6 in deploy/r750/README.md. The relay still starts."
fi
relay_run
relay_join_route_network

step "end-to-end readiness through the relay"
if [ ! -f "$AUTH_JSON" ]; then
  say "SKIPPED: no $AUTH_JSON, so the relay is refusing to bind on purpose. Its own words:"
  docker logs --tail 6 "$RELAY" 2>&1 | sed 's/^/      /'
  say "set a password (see the relay login step above), then re-run this script so the container"
  say "is recreated with that file mounted read-only."
else
code=000
for i in $(seq 1 30); do
  # The gateway bearer, because the relay now wants a password or that token. A browser has
  # neither and is sent to /login; scripts and gates carry the bearer, which is already full
  # access, so requiring a session of them as well would cost work and buy nothing.
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' \
    "http://$RELAY_BIND:$RELAY_PORT/api/getHostStatus" || true)"
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || { docker logs --tail 40 "$RELAY"; die "getHostStatus through the relay never returned 200 (last: HTTP $code)"; }
say "getHostStatus through the relay: HTTP 200"
curl -s -m 5 -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' \
  "http://$RELAY_BIND:$RELAY_PORT/api/getHostStatus" | head -c 300; echo
# The same call with NO credential at all. 401 is the whole of AUTH-1 in one line: before it, this
# returned 200 and anyone who could open the port held the gateway. That the relay still injects
# the bearer upstream is proved by scripts/verify-deploy.mjs, which logs in and repeats this call
# with a session cookie and no authorization header.
naked="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST -H 'content-type: application/json' -d '{}' \
  "http://$RELAY_BIND:$RELAY_PORT/api/getHostStatus" || true)"
[ "$naked" = 401 ] && say "the same call with no credential: HTTP 401, so the port is no longer the credential" \
  || say "WARNING: the same call with no credential returned HTTP $naked, expected 401"
fi
# The docker socket is the piece most likely to be silently broken, and its failure mode is an
# empty model picker rather than an error. Prove it here. A relay that is refusing to bind cannot
# run anything, so a failure there would be a second symptom of the missing password, not a socket
# problem, and saying "the socket is broken" would send the operator to the wrong place.
if [ ! -f "$AUTH_JSON" ]; then
  say "the docker socket check needs a running relay; set a password first"
elif [ "$(docker exec "$RELAY" docker inspect "$BOX" --format '{{.State.Running}}' 2>/dev/null)" = true ]; then
  say "the relay can drive docker (socket mount and CLI both work), so the endpoint picker will work"
else
  say "WARNING: the relay cannot run 'docker inspect'. The console will load but the model picker and"
  say "         the connector editor will silently return nothing."
fi

step "box isolation"
# TENANT-5 put every customer's box on one shared docker network, and containers on one bridge talk
# to each other freely: measured on the R750 2026-09-07, one customer's box reached another's VNC
# seat on 6080, which offers no password at all. deploy/r750/box-isolation.sh is the rule that a box
# reaches the relay's bundle route and nothing else on that bridge, and the timer reapplies it,
# because a box built by the control plane at three in the morning has to be covered too.
ISO_UNITS="$HOME/.config/systemd/user"
if [ -f "$ROOT/deploy/box-isolation.sh" ]; then
  mkdir -p "$ISO_UNITS"
  cp "$ROOT/deploy/titanbot-isolation.service" "$ROOT/deploy/titanbot-isolation.timer" "$ISO_UNITS/"
  if bash "$ROOT/deploy/box-isolation.sh" >/dev/null 2>&1; then
    say "box isolation applied to the shared network"
  else
    say "WARNING: could not apply the box isolation rules. Run it and read the reason:"
    say "    bash $ROOT/deploy/box-isolation.sh"
  fi
  if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now titanbot-isolation.timer 2>/dev/null; then
    say "titanbot-isolation.timer on: the rules are rebuilt every minute"
  else
    say "WARNING: could not enable titanbot-isolation.timer; run: systemctl --user enable --now titanbot-isolation.timer"
  fi
  say "check it:  bash $ROOT/deploy/box-isolation.sh --verify"
else
  say "WARNING: $ROOT/deploy/box-isolation.sh is missing, so one customer's box can reach another's."
  say "         Run deploy/r750/sync.sh from the Mac; it ships the script."
fi

step "coding sandbox image"
# CODE-1. The image a coding task runs in, built HERE rather than by hand. It was not in this script at
# all and it has already gone missing once on this very server: measured 2026-09-10, `docker image
# inspect titanbot/code-sandbox:1` answered "No such image" twenty minutes after a real task had run on
# it, because this host's Coolify has force_docker_cleanup on and its nightly image prune spares only
# the repos Coolify itself deploys. Every coding task on the machine was then refused with a sentence
# telling the customer the computer had not been built, which is exactly the hand operation
# no-hand-operations-on-the-product exists to stop. The script also leaves one never-started keeper
# container so a prune cannot take the image between ships.
#
# It builds on the HOST, starts nothing, restarts nothing, and touches no container, no network and no
# box, so it is safe here and safe to re-run on a live machine. A failure is a WARNING and not fatal:
# the relay and the boxes are the product, and a machine with no sandbox image refuses coding tasks with
# a plain sentence rather than breaking anything else.
if [ -f "$ROOT/deploy/code-sandbox/install.sh" ]; then
  if bash "$ROOT/deploy/code-sandbox/install.sh" 2>&1 | sed 's/^/    /'; then
    say "coding sandbox image built and kept"
  else
    say "WARNING: the coding sandbox image did not build, so coding tasks will be refused. Read the"
    say "         reason above, or run it again on its own:"
    say "    bash $ROOT/deploy/code-sandbox/install.sh"
  fi
else
  say "WARNING: $ROOT/deploy/code-sandbox/install.sh is missing, so no coding task can run here."
  say "         Run deploy/r750/sync.sh from the Mac; it ships the code-sandbox directory."
fi

step "nightly snapshot"
# BACKUP-1. There was no backup job of any kind on this server: a lost volume was a lost instance.
# USER units, because this whole install runs as sem with no sudo. The timer needs linger to fire
# when nobody is logged in, and enabling linger for one's own user is the one thing here that may
# ask for a password on a locked-down polkit -- so it is attempted, reported, and never fatal.
BACKUP_UNITS="$HOME/.config/systemd/user"
if [ -f "$ROOT/deploy/backup/snapshot.sh" ]; then
  mkdir -p "$BACKUP_UNITS"
  cp "$ROOT/deploy/backup/titanbot-backup.service" "$ROOT/deploy/backup/titanbot-backup.timer" "$BACKUP_UNITS/"
  # WHICH box the snapshot pauses. On a server with customers on it the role label matches every
  # customer's box as well as the operator's, and the snapshot now refuses rather than pausing an
  # arbitrary one. TITANBOT_SERVICE is the operator's own Coolify service uuid; set it in the
  # environment of this install and the unit carries it. Left unset on a hand-installed box, where
  # the container really is called titanbot-box and there is nothing to disambiguate.
  if [ -n "${TITANBOT_SERVICE:-}" ]; then
    printf 'Environment=TITANBOT_SERVICE=%s\n' "$TITANBOT_SERVICE" >> "$BACKUP_UNITS/titanbot-backup.service"
    say "the snapshot will pause the box of service $TITANBOT_SERVICE and no other"
  fi
  say "installed titanbot-backup.{service,timer} into $BACKUP_UNITS"
  if systemctl --user daemon-reload 2>/dev/null; then
    if systemctl --user enable --now titanbot-backup.timer 2>/dev/null; then
      say "timer enabled: $(systemctl --user list-timers titanbot-backup.timer --no-pager --no-legend 2>/dev/null | head -n 1)"
    else
      say "WARNING: could not enable the timer; run: systemctl --user enable --now titanbot-backup.timer"
    fi
    loginctl enable-linger "$(id -un)" 2>/dev/null \
      && say "linger on for $(id -un), so the timer fires with nobody logged in" \
      || say "WARNING: linger is NOT on; the timer only fires while $(id -un) has a session. Run: loginctl enable-linger $(id -un)"
  else
    say "no systemd --user here; the units are in place. Enable them yourself, or run the snapshot from cron:"
    say "    10 4 * * *  /bin/bash $ROOT/deploy/backup/snapshot.sh"
  fi
  say "first drill:  bash $ROOT/deploy/backup/restore-drill.sh"
else
  say "WARNING: $ROOT/deploy/backup/snapshot.sh is missing, so no nightly snapshot was installed."
  say "         Run deploy/r750/sync.sh from the Mac; it ships the backup directory."
fi

printf '\n== done\n'
say "console      http://$RELAY_BIND:$RELAY_PORT/"
say "operator     http://$RELAY_BIND:$RELAY_PORT/operator"
say "token file   $TOKEN_FILE  (mode $(stat -c %a "$TOKEN_FILE"), never printed)"
if [ -f "$AUTH_JSON" ]; then
  say "login        password set in $AUTH_JSON, mounted read-only into $RELAY; sessions last 12 h"
else
  say "login        NOT SET, so $RELAY will not bind. node $ROOT/ui/set-password.mjs, then docker restart $RELAY"
fi
say "containers   $BOX, $RELAY  on network $NET"
if route_enabled; then
  say "route        ON: https://$ROUTE_HOST is served through Coolify's proxy"
else
  say "route        OFF: no titanbot router exists in Coolify's proxy"
fi
say "next         deploy/r750/README.md items 1-6 are the operator steps for $ROUTE_HOST"
