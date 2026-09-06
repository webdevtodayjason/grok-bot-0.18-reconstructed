#!/usr/bin/env bash
# snapshot.sh -- one consistent copy of everything an instance is (docs/GAP-ANALYSIS.md BACKUP-1).
#
# An instance is five things: the four docker volumes (workspace, sand-data, box store, chrome
# profile) and the relay side on the host (ui/auth.json, ui/endpoints.json, ui/subscriptions.json,
# profile/, credential/). Until this script there was no backup job of any kind on the R750, so a
# lost volume was a lost instance: every agent, every transcript, every credential.
#
#   bash deploy/backup/snapshot.sh
#
# Env, all optional:
#   TITANBOT_BACKUP_DEST     where snapshots go, default /mnt/rosa-storage/archives/titanbot/backups
#   TITANBOT_INSTANCE        the subdirectory under it, default titanbot
#   TITANBOT_BOX             box container, default titanbot-box
#   TITANBOT_VOLUME_PREFIX   volume names, default titanbot-box (so titanbot-box-data etc.)
#   TITANBOT_ROOT            the relay side, default /home/sem/titanbot
#   TITANBOT_BACKUP_KEEP     snapshots kept per instance, default 14
#   TITANBOT_BACKUP_REQUIRE_MOUNT  1 (default) refuses a destination that is not a mount point
#
# Two guards, both refusals rather than warnings, because the failure they prevent is silent:
#
#   the destination must be a MOUNT POINT.  /mnt/rosa-storage with the array unmounted is an empty
#   directory on the root filesystem, and a nightly job would happily fill it with the only copy of
#   the data, on the disk the copy exists to survive. The check: the destination must lie on a
#   mounted filesystem other than the root one (the nearest existing ancestor's mount point, via
#   POSIX `df -P`, must not be "/"; TITANBOT_BACKUP_MOUNT pins which mount). Demanding that the
#   destination directory itself be a mount point refused every sensible path under the array
#   (2026-09-06, /mnt/rosa-storage/archives/titanbot/backups). The dev box has no array;
#   TITANBOT_BACKUP_REQUIRE_MOUNT=0 is how the gate says so out loud.
#
#   there must be room for TWICE the last snapshot.  A snapshot that runs out of space part way
#   through is a torn copy that looks like a snapshot, and it lands next to good ones with the same
#   name shape. Twice, not once, because the copy is written before the retention sweep runs.
#
# THE PAUSE IS SHORT ON PURPOSE, and that shapes the whole script. Freezing the box for the length
# of a full copy would mean minutes of a dead instance every night: measured on the dev box, the
# four volumes are 2.9 GB and the box store alone is 2.6 GB. So the copy runs in two passes.
#
#   pass 1, LIVE: every volume and the relay side, with the box running. Minutes, no freeze.
#   pass 2, PAUSED: sand-data and workspace again -- 15 MB, seconds. These are the volumes that hold
#     the agents' sqlite stores, which are the only files here that can tear: a store copied during a
#     write restores without complaint and is still wrong. Everything else (the box store, which is
#     itself a mirror, and the chrome profile, whose session databases the box store stages
#     separately) keeps its live copy and is MARKED live in the manifest.
#
# The unpause is a trap on every exit path including a signal, because a snapshot that dies half way
# through must not leave the instance frozen. The manifest's top-level "mode" is "consistent" only
# when the paused pass actually ran; every source also carries its own capturedWhile.
set -uo pipefail

DEST_ROOT="${TITANBOT_BACKUP_DEST:-/mnt/rosa-storage/archives/titanbot/backups}"
INSTANCE="${TITANBOT_INSTANCE:-titanbot}"
BOX="${TITANBOT_BOX:-titanbot-box}"
VOLUME_PREFIX="${TITANBOT_VOLUME_PREFIX:-titanbot-box}"
ROOT="${TITANBOT_ROOT:-/home/sem/titanbot}"
KEEP="${TITANBOT_BACKUP_KEEP:-14}"
REQUIRE_MOUNT="${TITANBOT_BACKUP_REQUIRE_MOUNT:-1}"

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not on PATH"
command -v rsync >/dev/null || die "rsync is not on PATH"

step "destination"
mkdir -p "$DEST_ROOT/$INSTANCE" || die "could not create $DEST_ROOT/$INSTANCE"
if [ "$REQUIRE_MOUNT" = 1 ]; then
  probe="$DEST_ROOT"; while [ ! -e "$probe" ]; do probe="$(dirname "$probe")"; done
  mount_of="$(df -P "$probe" 2>/dev/null | awk 'NR==2 { print $6 }')"   # POSIX df: column 6 is the mount point, on Linux and macOS alike
  [ -n "$mount_of" ] || die "could not tell which filesystem holds $DEST_ROOT; set TITANBOT_BACKUP_REQUIRE_MOUNT=0 only for a dev box with no array"
  [ "$mount_of" != "/" ] || die "$DEST_ROOT is on the root filesystem. If the array is unmounted this job would write the only copy of the data onto the disk it exists to survive; set TITANBOT_BACKUP_REQUIRE_MOUNT=0 only for a dev box with no array"
  if [ -n "${TITANBOT_BACKUP_MOUNT:-}" ] && [ "$mount_of" != "$TITANBOT_BACKUP_MOUNT" ]; then die "$DEST_ROOT is on $mount_of, not on the expected mount $TITANBOT_BACKUP_MOUNT"; fi
  say "destination is on the mounted filesystem $mount_of"
  say "$DEST_ROOT is a mount point"
else
  say "MOUNT CHECK OFF (TITANBOT_BACKUP_REQUIRE_MOUNT=0): $DEST_ROOT is not required to be a separate filesystem"
fi

# The previous snapshot sizes the free-space guard. du -sk, not the manifest's own number, so a
# manifest that was never written (a torn run) still counts against the next one.
PREV="$(ls -1d "$DEST_ROOT/$INSTANCE"/*/ 2>/dev/null | sort | tail -n 1)"
AVAIL_KB="$(df -Pk "$DEST_ROOT" | awk 'NR==2{print $4}')"
if [ -n "$PREV" ]; then
  PREV_KB="$(du -sk "$PREV" | awk '{print $1}')"
  NEED_KB=$(( PREV_KB * 2 ))
  [ "$AVAIL_KB" -ge "$NEED_KB" ] || die "$DEST_ROOT has ${AVAIL_KB}K free and the last snapshot was ${PREV_KB}K; twice that (${NEED_KB}K) is the floor, because the copy is written before the retention sweep"
  say "free ${AVAIL_KB}K, last snapshot ${PREV_KB}K, floor ${NEED_KB}K"
else
  say "free ${AVAIL_KB}K, no previous snapshot to size the floor from"
fi

STAMP="$(date +%Y-%m-%d-%H%M)"
OUT="$DEST_ROOT/$INSTANCE/$STAMP"
[ -e "$OUT" ] && die "$OUT already exists; a snapshot in the same minute is a re-run, not a new one"
mkdir -p "$OUT" || die "could not create $OUT"

# Unpause on EVERY exit path. A snapshot that dies half way through must not leave the instance
# frozen: a paused box answers nothing and looks like a hung host.
PAUSED=no
unpause() { if [ "$PAUSED" = yes ]; then docker unpause "$BOX" >/dev/null 2>&1 && PAUSED=no; fi; }
trap 'unpause' EXIT INT TERM

# Copy one source. Two methods, and the manifest records which was used:
#
#   rsync, when the volume's own _data directory is readable on this host. That is the R750, and it
#   is the fast, incremental one.
#
#   a stream through the docker daemon, when it is not. On a Mac the daemon runs in a VM and
#   /var/lib/docker does not exist on the host at all, so `docker volume inspect` names a path
#   nothing here can open. Streaming a tar out of a throwaway container that mounts the volume
#   read-only works on both, which is what makes the dev box able to prove this script at all.
COPY_METHOD=""
copy_volume() {
  local volume="$1" target="$2" path
  path="$(docker volume inspect "$volume" --format '{{.Mountpoint}}' 2>/dev/null)"
  mkdir -p "$target"
  if [ -n "$path" ] && [ -d "$path" ]; then
    COPY_METHOD=rsync
    rsync -a --delete "$path/" "$target/"
    return $?
  fi
  COPY_METHOD=docker-stream
  # --entrypoint tar: the box image ships its own entrypoint, and this container must do one thing.
  docker run --rm --entrypoint tar \
    --volume "$volume:/src:ro" \
    "$(docker inspect "$BOX" --format '{{.Config.Image}}' 2>/dev/null || echo alpine)" \
    -C /src -cf - . 2>/dev/null | tar -xf - -C "$target"
  return $?
}

# The volumes whose copy is retaken under the pause: the agents' sqlite stores live in sand-data,
# and /workspace is what the agents write files into. Both are small.
PAUSED_VOLUMES=" data workspace "

step "volumes, live pass"
FAILED=no
for name in workspace data store chrome; do
  volume="$VOLUME_PREFIX-$name"
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    say "volume $volume does not exist, skipped"
    continue
  fi
  if copy_volume "$volume" "$OUT/volumes/$name"; then
    say "$volume -> volumes/$name  $(du -sk "$OUT/volumes/$name" | awk '{print $1}')K via $COPY_METHOD"
  else
    FAILED=yes
    say "WARNING: $volume did not copy cleanly"
  fi
done

step "volumes, paused pass"
PAUSE_START=$(date +%s)
if docker inspect "$BOX" >/dev/null 2>&1; then
  if docker pause "$BOX" >/dev/null 2>&1; then PAUSED=yes; say "paused $BOX"; else say "WARNING: could not pause $BOX"; fi
else
  say "WARNING: no container named $BOX"
fi
for name in workspace data; do
  volume="$VOLUME_PREFIX-$name"
  docker volume inspect "$volume" >/dev/null 2>&1 || continue
  [ "$PAUSED" = yes ] || continue
  rm -rf "$OUT/volumes/$name"
  copy_volume "$volume" "$OUT/volumes/$name" || { FAILED=yes; say "WARNING: $volume did not re-copy under the pause"; }
done
PAUSE_HELD="$PAUSED"
unpause
PAUSE_S=$(( $(date +%s) - PAUSE_START ))
say "the box was paused for ${PAUSE_S}s"

VOLUME_ENTRIES=""
for name in workspace data store chrome; do
  volume="$VOLUME_PREFIX-$name"
  [ -d "$OUT/volumes/$name" ] || continue
  kb="$(du -sk "$OUT/volumes/$name" | awk '{print $1}')"
  files="$(find "$OUT/volumes/$name" -type f | wc -l | tr -d ' ')"
  case "$PAUSED_VOLUMES" in *" $name "*) when=$([ "$PAUSE_HELD" = yes ] && echo paused || echo live) ;; *) when=live ;; esac
  say "volumes/$name  ${kb}K, $files files, captured $when"
  VOLUME_ENTRIES="$VOLUME_ENTRIES{\"name\":\"$name\",\"volume\":\"$volume\",\"capturedWhile\":\"$when\",\"kb\":$kb,\"files\":$files},"
done

step "relay side"
RELAY_ENTRIES=""
mkdir -p "$OUT/relay"
for rel in ui/auth.json ui/endpoints.json ui/subscriptions.json ui/job-bus.json profile credential; do
  src="$ROOT/$rel"
  if [ ! -e "$src" ]; then say "$rel absent, skipped"; continue; fi
  mkdir -p "$OUT/relay/$(dirname "$rel")"
  if rsync -a "$src" "$OUT/relay/$(dirname "$rel")/"; then
    kb="$(du -sk "$OUT/relay/$rel" | awk '{print $1}')"
    say "$rel -> relay/$rel  ${kb}K"
    RELAY_ENTRIES="$RELAY_ENTRIES{\"path\":\"$rel\",\"kb\":$kb},"
  else
    say "WARNING: $rel did not copy cleanly"
  fi
done
# These carry the password hash, the API keys, the adopted OAuth tokens and the gateway token.
chmod -R go-rwx "$OUT/relay" 2>/dev/null || true

step "manifest"
# Every agent store, by sha256. This is the line a restore drill checks against, and the reason a
# torn copy cannot pass for a good one.
STORE_ENTRIES=""
STORE_COUNT=0
while IFS= read -r db; do
  [ -n "$db" ] || continue
  sum="$( (sha256sum "$db" 2>/dev/null || shasum -a 256 "$db") | awk '{print $1}')"
  bytes="$(wc -c < "$db" | tr -d ' ')"
  rel="${db#"$OUT/"}"
  STORE_ENTRIES="$STORE_ENTRIES{\"path\":\"$rel\",\"bytes\":$bytes,\"sha256\":\"$sum\"},"
  STORE_COUNT=$(( STORE_COUNT + 1 ))
done <<EOF
$(find "$OUT/volumes/data" -name store.db -type f 2>/dev/null | sort)
EOF

TOTAL_KB="$(du -sk "$OUT" | awk '{print $1}')"
# "consistent" only when the pause held for the whole copy AND every volume copied cleanly. A copy
# taken from a running box is a LIVE copy and must say so: a sqlite store copied mid-write restores
# without complaint and is still wrong, and the only defence against that is the label.
MODE=live
if [ "$PAUSE_HELD" = yes ] && [ "$FAILED" = no ]; then
  MODE=consistent
fi
cat > "$OUT/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "instance": "$INSTANCE",
  "stamp": "$STAMP",
  "takenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(hostname)",
  "mode": "$MODE",
  "pauseSeconds": $PAUSE_S,
  "pausedVolumes": ["data", "workspace"],
  "copyMethod": "$COPY_METHOD",
  "totalKb": $TOTAL_KB,
  "volumes": [${VOLUME_ENTRIES%,}],
  "relay": [${RELAY_ENTRIES%,}],
  "storeDbCount": $STORE_COUNT,
  "storeDbs": [${STORE_ENTRIES%,}]
}
EOF
say "$OUT/manifest.json: mode $MODE, ${TOTAL_KB}K, $STORE_COUNT store.db"

step "retention"
# Oldest first, keep the newest $KEEP. The names sort lexically because they are
# YYYY-MM-DD-HHMM, which is the only reason this is safe to do with ls.
# `ls | head` rather than an array: the dev box's /bin/bash is 3.2, which has no mapfile, and this
# script must be runnable on the machine it is proved on.
COUNT="$(ls -1d "$DEST_ROOT/$INSTANCE"/*/ 2>/dev/null | wc -l | tr -d ' ')"
# The newest CONSISTENT snapshot is never swept, whatever its age. Retention used to evict strictly
# by name, and every directory counted the same: a "live" snapshot (the pause did not hold, or a
# volume did not copy cleanly) and a torn run that never got as far as a manifest both take a slot.
# With KEEP=14 and a nightly timer, fourteen degraded runs in a row would delete the last snapshot
# anyone could actually restore from, silently, one night at a time.
KEEPER=""
for dir in $(ls -1d "$DEST_ROOT/$INSTANCE"/*/ 2>/dev/null | sort); do
  [ -f "$dir/manifest.json" ] || continue
  grep -q '"mode"[[:space:]]*:[[:space:]]*"consistent"' "$dir/manifest.json" && KEEPER="$dir"
done
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1d "$DEST_ROOT/$INSTANCE"/*/ 2>/dev/null | sort | head -n "$(( COUNT - KEEP ))" | while IFS= read -r old; do
    if [ -n "$KEEPER" ] && [ "$old" = "$KEEPER" ]; then
      say "kept $(basename "$old"): the newest consistent snapshot, which retention never sweeps"
      continue
    fi
    rm -rf "$old" && say "removed $(basename "$old")"
  done
fi
say "$(ls -1d "$DEST_ROOT/$INSTANCE"/*/ 2>/dev/null | wc -l | tr -d ' ') snapshots kept (limit $KEEP)"

printf '\n== done\n'
say "$OUT"
