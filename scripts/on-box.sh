#!/bin/bash
# on-box.sh <command...> -- run one command that uses the shared local box, one at a time.
# The lock is a directory (mkdir is atomic on macOS, which ships no flock). A stale lock older
# than 15 minutes whose owner pid is gone is removed. GATE-2.
LOCK="${BOX_LOCK_DIR:-/tmp/titanbot-box.lock}"
WAIT="${BOX_LOCK_WAIT_S:-1500}"
start=$(date +%s)
while ! mkdir "$LOCK" 2>/dev/null; do
  owner=$(cat "$LOCK/pid" 2>/dev/null); age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null && [ "$age" -gt 900 ]; then rm -rf "$LOCK"; continue; fi
  if [ $(( $(date +%s) - start )) -ge "$WAIT" ]; then echo "on-box: gave up waiting for $LOCK (held by pid ${owner:-?}, ${age}s)" >&2; exit 75; fi
  sleep 5
done
echo $$ > "$LOCK/pid"; echo "$*" > "$LOCK/cmd"
trap 'rm -rf "$LOCK"' EXIT INT TERM
"$@"
