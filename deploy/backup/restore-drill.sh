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
# ---- AND THE PROXY, SINCE PROVIDERS-1 -------------------------------------------------------------
# This drill used to mention neither the proxy's pg_dump nor cp.env, and snapshot.sh has captured
# both for a while: cp.env in the per-instance file list, the proxy database as a pg_dump in a pass
# of its own. That gap did not matter much while the proxy's database held virtual keys and spend
# rows. It matters now: every provider subscription the operator holds lives in that database,
# encrypted under PROXY_SALT_KEY, which is a line in cp.env, and the control plane keeps NO second
# copy of any of them by design.
#
# So the two are restored TOGETHER and the drill asks the only question that matters about them: does
# a credential in that dump DECRYPT with the salt in that cp.env. A dump without its salt is
# ciphertext nobody can read, and a drill that reported a green verdict on one would be reporting on
# a backup that cannot bring the operator's providers back.
#
# The decrypt is done by the litellm image itself rather than by re-implementing its crypto here,
# and it needs docker and that image. If either is missing the drill says SKIPPED by name and keeps
# going -- but a snapshot whose MANIFEST says a proxy dump was captured and which has no dump, or has
# a dump and no salt, FAILS, because that is a broken snapshot rather than a missing tool.
#
# Env, all optional:
#   TITANBOT_BACKUP_DEST  where snapshots live, default /mnt/rosa-storage/archives/titanbot/backups
#   TITANBOT_INSTANCE     which instance, default titanbot
#   TITANBOT_PROXY_IMAGE  the image to decrypt with, default docker.litellm.ai/berriai/litellm-database:v1.100.0
#   TITANBOT_DRILL_SKIP_PROXY_DECRYPT=1   check the files are present and paired, do not run docker
set -uo pipefail

DEST_ROOT="${TITANBOT_BACKUP_DEST:-/mnt/rosa-storage/archives/titanbot/backups}"
INSTANCE="${TITANBOT_INSTANCE:-titanbot}"
PROXY_IMAGE="${TITANBOT_PROXY_IMAGE:-docker.litellm.ai/berriai/litellm-database:v1.100.0}"

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

step "the control plane"
# The account store is the one file in a snapshot that nothing else can rebuild: every account,
# every tenant, the provisioning ledger. A drill that opened every agent's store and never opened
# this one would print a green verdict on a backup that could not bring the customers back.
CP_STATE="$(sed -n 's/.*"controlPlane"[^"]*"\([^"]*\)".*/\1/p' "$SNAP/manifest.json" | head -n 1)"
TENANTS="$(sed -n 's/.*"tenantCount"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$SNAP/manifest.json" | head -n 1)"
say "manifest  control plane ${CP_STATE:-unstated}, ${TENANTS:-0} tenant(s)"
CP_BAD=0
if [ "${CP_STATE:-absent}" = absent ]; then
  say "this snapshot is a single instance with no control plane, which is complete as it is"
else
  found=0
  while IFS= read -r db; do
    [ -n "$db" ] || continue
    found=$(( found + 1 ))
    result="$(integrity_check "$db")"
    printf '  %-40s %12s  %s\n' "$(basename "$db")" "$(wc -c < "$db" | tr -d ' ')" "$result"
    [ "$result" = ok ] || CP_BAD=$(( CP_BAD + 1 ))
  done <<EOF
$(find "$WORK/tenants/_control-plane" -name '*.sqlite' -type f 2>/dev/null | sort)
EOF
  [ "$found" -gt 0 ] || die "the manifest says the control plane store was captured $CP_STATE and none is in the snapshot"
  say "$(find "$WORK/tenants" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -cv '_control-plane$' | tr -d ' ') tenant director(ies) restored"
fi

step "the proxy, and the salt that makes its dump readable"
# PROVIDERS-1. Every provider subscription the operator holds lives in the proxy's database,
# encrypted under PROXY_SALT_KEY, and the control plane keeps no second copy. So the question here is
# not "is there a dump", it is "does a credential in this dump decrypt with the salt in this
# snapshot". A dump without its salt restores cleanly and is still worthless.
PROXY_STATE="$(sed -n 's/.*"proxy"[^"]*"\([^"]*\)".*/\1/p' "$SNAP/manifest.json" | head -n 1)"
PROXY_DUMP="$WORK/proxy/litellm.sql"
CP_ENV_FILE="$WORK/relay/cp.env"
PROXY_BAD=0
PROXY_WHY=""
say "manifest  proxy ${PROXY_STATE:-unstated}"
if [ "${PROXY_STATE:-absent}" = absent ]; then
  say "no proxy database in this snapshot, which is complete for an instance that runs no proxy"
else
  if [ ! -f "$PROXY_DUMP" ]; then
    PROXY_BAD=1
    PROXY_WHY="the manifest says the proxy database was captured ($PROXY_STATE) and proxy/litellm.sql is not in the snapshot"
    say "the manifest says the proxy was captured $PROXY_STATE and proxy/litellm.sql is not in the snapshot"
  else
    say "dump      proxy/litellm.sql  $(wc -c < "$PROXY_DUMP" | tr -d ' ') bytes"
    # The salt is a line in cp.env. Read into a variable, never printed, and reported by length and
    # hash prefix only -- the same rule every script in this repo follows for a secret.
    SALT=""
    if [ -f "$CP_ENV_FILE" ]; then
      SALT="$(sed -n 's/^PROXY_SALT_KEY=//p' "$CP_ENV_FILE" | head -n 1)"
    fi
    if [ -z "$SALT" ]; then
      PROXY_BAD=1
      PROXY_WHY="the proxy dump is here and PROXY_SALT_KEY is not, so the dump is ciphertext nobody can read"
      say "cp.env is missing or carries no PROXY_SALT_KEY, so this dump is ciphertext nobody can read"
      say "  looked in $CP_ENV_FILE"
    else
      say "salt      PROXY_SALT_KEY present, ${#SALT} characters, sha256 $( (printf '%s' "$SALT" | sha256sum 2>/dev/null || printf '%s' "$SALT" | shasum -a 256) | cut -c1-12)"
      # One ciphertext out of the credentials table's COPY block. pg_dump writes that data as plain
      # text, so this needs no database at all to get at -- which is the point: the drill does not
      # have to stand a Postgres up to answer the question.
      CIPHER="$(grep -o '{"api_key": "[^"]*"}' "$PROXY_DUMP" | head -n 1 | sed 's/.*"api_key": "//; s/"}//')"
      CREDS="$(grep -c '{"api_key": "' "$PROXY_DUMP" 2>/dev/null || true)"
      say "credentials in the dump: ${CREDS:-0}"
      if [ -z "$CIPHER" ]; then
        # Not a failure. A snapshot taken before the seed legitimately has no credential row, and
        # calling that a broken backup would make the drill cry wolf on day one.
        say "SKIPPED: this dump holds no credential row yet, so there is nothing to decrypt"
      elif [ "${TITANBOT_DRILL_SKIP_PROXY_DECRYPT:-0}" = 1 ]; then
        say "SKIPPED by TITANBOT_DRILL_SKIP_PROXY_DECRYPT: the dump and the salt are both here and paired"
      elif ! command -v docker >/dev/null; then
        say "SKIPPED: docker is not on PATH, so the decrypt cannot be run. The dump and the salt are both here."
      else
        # Decrypted BY THE IMAGE ITSELF rather than by re-implementing its crypto here. v1.100.0
        # carries two formats (a versioned AES-256-GCM and the older nacl one) and a drill that
        # guessed wrong would report a good backup as bad. The value is passed in the environment and
        # only its LENGTH ever comes back out.
        DECRYPT_OUT="$(TB_SALT="$SALT" TB_CIPHER="$CIPHER" docker run --rm --entrypoint python3 \
          -e "LITELLM_SALT_KEY=$SALT" -e "TB_CIPHER=$CIPHER" "$PROXY_IMAGE" -c '
import os
from litellm.proxy.common_utils.encrypt_decrypt_utils import decrypt_value_helper
v = decrypt_value_helper(os.environ["TB_CIPHER"], "api_key", exception_type="debug", return_original_value=False)
ok = isinstance(v, str) and len(v) > 0 and v != os.environ["TB_CIPHER"]
print(("DECRYPTED %d" % len(v)) if ok else "FAILED 0")
' 2>/dev/null | tail -n 1)"
        case "$DECRYPT_OUT" in
          DECRYPTED*)
            say "decrypt   ok: one credential decrypted with this snapshot's own salt, $(printf '%s' "$DECRYPT_OUT" | awk '{print $2}') characters (value not printed)"
            ;;
          FAILED*)
            PROXY_BAD=1
            PROXY_WHY="the proxy dump and the PROXY_SALT_KEY in this snapshot are not a pair"
            say "decrypt   FAILED: the credential did not decrypt with this snapshot's PROXY_SALT_KEY."
            say "          The dump and the salt in this snapshot do not belong together, so restoring it"
            say "          would bring back every provider key unreadable. That is not a restore point."
            ;;
          *)
            say "SKIPPED: could not run the decrypt (is $PROXY_IMAGE pulled?). The dump and the salt are both here."
            ;;
        esac
      fi
    fi
  fi
fi

step "verdict"
say "$OK store(s) opened and passed, $BAD did not"
say "relay side: $(find "$WORK/relay" -type f 2>/dev/null | wc -l | tr -d ' ') file(s) restored"
[ "$PROXY_BAD" -eq 0 ] || die "$PROXY_WHY; every provider key would come back unreadable, so this is not a restore point"
[ "$CP_BAD" -eq 0 ] || die "the control plane store did not open; this snapshot cannot bring the customers back and is not a restore point"
[ "$BAD" -eq 0 ] || die "$BAD store(s) failed; this snapshot is not a restore point"
[ "$OK" -gt 0 ] || die "no agent store was found in the snapshot at all"
if [ -n "$EXPECTED" ] && [ "$(( OK + BAD ))" -ne "$EXPECTED" ]; then
  die "the manifest names $EXPECTED store.db and $(( OK + BAD )) were found; this snapshot is missing stores and is not a restore point"
fi
printf '\n== OK\n'
