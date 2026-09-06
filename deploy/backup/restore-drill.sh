#!/usr/bin/env bash
# restore-drill.sh -- restore a snapshot into a temp directory and prove the stores open
# (docs/GAP-ANALYSIS.md BACKUP-1).
#
#   bash deploy/backup/restore-drill.sh                  the newest snapshot of the default instance
#   bash deploy/backup/restore-drill.sh <snapshot dir>   that one
#
# A backup nobody has restored is a hope, not a backup. This restores into a throwaway directory --
# it never touches the running instance -- and then asks sqlite the only question that matters:
# does each agent's store.db open and pass an integrity check. A torn copy answers "database disk
# image is malformed" here, months before an operator would have found out the hard way.
#
# It also re-hashes every store against the manifest, which is what catches a snapshot that was
# damaged AFTER it was taken (a bad disk, a partial rsync to somewhere else) rather than while it
# was being written.
#
# Env, all optional:
#   TITANBOT_BACKUP_DEST  where snapshots live, default /mnt/rosa-storage/archives/titanbot/backups
#   TITANBOT_INSTANCE     which instance, default titanbot
set -uo pipefail

DEST_ROOT="${TITANBOT_BACKUP_DEST:-/mnt/rosa-storage/archives/titanbot/backups}"
INSTANCE="${TITANBOT_INSTANCE:-titanbot}"

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

SNAP="${1:-}"
if [ -z "$SNAP" ]; then
  SNAP="$(ls -1d "$DEST_ROOT/$INSTANCE"/*/ 2>/dev/null | sort | tail -n 1)"
  [ -n "$SNAP" ] || die "no snapshot under $DEST_ROOT/$INSTANCE"
fi
SNAP="${SNAP%/}"
[ -d "$SNAP" ] || die "$SNAP is not a directory"
[ -f "$SNAP/manifest.json" ] || die "$SNAP has no manifest.json, so it is not a finished snapshot"

# sqlite3 if it is here, python3's own sqlite3 module if it is not. The R750's box installs the CLI
# but the relay image does not carry it, and a drill that cannot run is a drill nobody runs.
INTEGRITY=""
if command -v sqlite3 >/dev/null; then INTEGRITY=cli
elif command -v python3 >/dev/null; then INTEGRITY=python
else die "neither sqlite3 nor python3 is on PATH, so no store can be opened"; fi

# Opened READ-WRITE, on the throwaway copy, deliberately. These stores are in WAL mode, and a WAL
# database opened read-only with no -shm beside it cannot create one: sqlite answers "unable to open
# database file (14)" and a perfectly good store reads as corrupt. Measured on the first drill run,
# four of five stores failed that way purely because their -wal had been checkpointed away before
# the snapshot. On a copy this script deletes at the end there is nothing to protect by refusing to
# write.
integrity_check() {
  local db="$1"
  if [ "$INTEGRITY" = cli ]; then
    sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 | head -n 1
  else
    python3 - "$db" <<'PY' 2>&1 | head -n 1
import sqlite3, sys
try:
    with sqlite3.connect(sys.argv[1]) as db:
        print(db.execute("PRAGMA integrity_check").fetchone()[0])
except Exception as error:
    print(f"open failed: {error}")
PY
  fi
}

sha_of() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | awk '{print $1}'; }

# The hash recorded for ONE path, not "does this sha appear anywhere in the manifest". The loose
# form passed two stores that had been swapped between agent directories: both hashes were present,
# so both read "sha ok", while every agent was holding another agent's conversations. The relay
# entries carry no sha256 and so cannot match this pattern.
manifest_sha_for() {
  local want="$1" entry entry_path
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    entry_path="$(printf '%s' "$entry" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')"
    [ "$entry_path" = "$want" ] || continue
    printf '%s' "$entry" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p'
    return 0
  done <<INNER
$(grep -o '{"path":"[^"]*","bytes":[0-9]*,"sha256":"[^"]*"}' "$SNAP/manifest.json")
INNER
  return 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/titanbot-restore-drill-XXXXXX")" || die "could not make a work directory"
trap 'rm -rf "$WORK"' EXIT INT TERM

step "snapshot"
say "$SNAP"
# Read the manifest with the tools that are certainly here rather than a JSON parser: this script
# runs on a server whose only job is to have run the backup.
say "mode      $(sed -n 's/.*"mode"[^"]*"\([^"]*\)".*/\1/p' "$SNAP/manifest.json" | head -n 1)"
say "taken     $(sed -n 's/.*"takenAt"[^"]*"\([^"]*\)".*/\1/p' "$SNAP/manifest.json" | head -n 1)"
say "size      $(du -sk "$SNAP" | awk '{print $1}')K"
# How many stores the snapshot SAYS it holds. The drill used to count only what it happened to find,
# so a snapshot whose paused re-copy half-failed (snapshot.sh removes the live copy before retaking
# it, so a failure there takes both) could land with one store out of five, open that one, and print
# a green verdict on a backup that had lost four agents.
EXPECTED="$(sed -n 's/.*"storeDbCount"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$SNAP/manifest.json" | head -n 1)"
say "stores    ${EXPECTED:-unstated} in the manifest"

step "restore into $WORK"
cp -R "$SNAP/." "$WORK/" || die "the snapshot did not copy into $WORK"
RESTORED_KB="$(du -sk "$WORK" | awk '{print $1}')"
say "${RESTORED_KB}K restored, nothing on the live instance was touched"

step "stores"
printf '  %-40s %12s %10s  %s\n' AGENT BYTES SHA "INTEGRITY"
printf '  %-40s %12s %10s  %s\n' "----------------------------------------" "------------" "----------" "---------"
OK=0
BAD=0
while IFS= read -r db; do
  [ -n "$db" ] || continue
  agent="$(basename "$(dirname "$db")")"
  bytes="$(wc -c < "$db" | tr -d ' ')"
  sum="$(sha_of "$db")"
  # The manifest recorded the hash at the moment the copy was taken. A mismatch here is damage that
  # happened to the snapshot afterwards, which is a different fault from a torn copy and is worth
  # naming as one.
  rel="${db#"$WORK/"}"
  expected="$(manifest_sha_for "$rel")"
  if [ -z "$expected" ]; then hash_state="UNLISTED"
  elif [ "$expected" = "$sum" ]; then hash_state="ok"
  else hash_state="DRIFTED"; fi
  result="$(integrity_check "$db")"
  if [ "$result" = ok ] && [ "$hash_state" = ok ]; then OK=$(( OK + 1 )); else BAD=$(( BAD + 1 )); fi
  printf '  %-40s %12s %10s  %s\n' "$agent" "$bytes" "${sum:0:10}" "$result${hash_state:+ / sha $hash_state}"
done <<EOF
$(find "$WORK/volumes/data" -name store.db -type f 2>/dev/null | sort)
EOF

step "verdict"
say "$OK store(s) opened and passed, $BAD did not"
say "relay side: $(find "$WORK/relay" -type f 2>/dev/null | wc -l | tr -d ' ') file(s) restored"
[ "$BAD" -eq 0 ] || die "$BAD store(s) failed; this snapshot is not a restore point"
[ "$OK" -gt 0 ] || die "no agent store was found in the snapshot at all"
if [ -n "$EXPECTED" ] && [ "$(( OK + BAD ))" -ne "$EXPECTED" ]; then
  die "the manifest names $EXPECTED store.db and $(( OK + BAD )) were found; this snapshot is missing stores and is not a restore point"
fi
printf '\n== OK\n'
