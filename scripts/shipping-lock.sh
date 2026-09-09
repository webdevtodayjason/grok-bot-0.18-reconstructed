#!/usr/bin/env bash
# The ship lock, with a stale holder no longer being a forty-minute wall.
#
# Three waves run on one branch and one R750. Before merging into the shared branch or touching the
# host, a wave takes a single lock file with `set -o noclobber` so two waves cannot both believe
# they have it, and releases it when the merge, the ship and the measurement are done.
#
# WHAT THIS FIXES. On 2026-09-08 twelve builders across three waves hit an account usage limit at
# 11:20 CDT and were killed mid-flight. One of them was holding the lock. The file survived, the
# process did not, and every wave after it polled a dead holder for forty minutes before giving up.
# A lock whose holder cannot be checked is not a lock, it is a timer. So the body carries the pid,
# and a waiter that finds a pid `kill -0` says nothing about takes the lock over and RECORDS THE
# TAKEOVER in the new body, so the next reader can see what happened rather than guessing.
#
# TWO CONDITIONS, NOT ONE, because an agent's shell is not the agent. Every tool call runs in a
# fresh shell, so the pid a `take` could record dies the moment `take` returns, and a pid check on
# its own would hand the lock to the next waiter thirty seconds later while the holder is still
# shipping. So the holder also KEEPS THE LOCK WARM -- `heartbeat` rewrites its timestamp -- and a
# waiter takes over only when the pid is dead AND the timestamp has not moved for the stale window.
# A wave killed by an account limit stops heartbeating and the lock frees itself; a wave that is
# working keeps it. TITANBOT_SHIP_LOCK_PID lets a caller record a pid that outlives the shell (the
# agent session's own), and then the pid check alone is enough.
#
#   scripts/shipping-lock.sh take <wave-name> [max-wait-seconds]   0 on success, 1 on timeout
#   scripts/shipping-lock.sh heartbeat <wave-name>                 call between long steps
#   scripts/shipping-lock.sh release <wave-name>                   only releases its own lock
#   scripts/shipping-lock.sh show
#
# TITANBOT_SHIP_LOCK sets the path. TITANBOT_SHIP_LOCK_STALE_S is the warm window, default 900.
set -uo pipefail

LOCK="${TITANBOT_SHIP_LOCK:?set TITANBOT_SHIP_LOCK to the .shipping path for this session}"
CMD="${1:-show}"
WAVE="${2:-unnamed}"
MAX="${3:-2400}"
STALE="${TITANBOT_SHIP_LOCK_STALE_S:-900}"

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
holder_pid() { sed -n 's/^pid=//p' "$LOCK" 2>/dev/null | head -n 1; }
holder_wave() { sed -n 's/^wave=//p' "$LOCK" 2>/dev/null | head -n 1; }

write_lock() {
  set -o noclobber
  { printf 'wave=%s\npid=%s\nutc=%s\n%s' "$WAVE" "${TITANBOT_SHIP_LOCK_PID:-$$}" "$(now_utc)" "${1:-}" > "$LOCK"; } 2>/dev/null
}

# Seconds since the lock was last written or heartbeated. `stat` differs between BSD and GNU and
# this runs on both, so try each rather than pick one.
lock_age_s() {
  m="$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null)"
  [ -n "$m" ] || { echo 0; return; }
  echo $(( $(date +%s) - m ))
}

case "$CMD" in
  show)
    if [ -e "$LOCK" ]; then cat "$LOCK"; p="$(holder_pid)"
      a="$(lock_age_s)"
      if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "holder pid $p is alive; last kept warm ${a}s ago"
      elif [ "$a" -lt "$STALE" ]; then echo "holder pid $p is gone but the lock was kept warm ${a}s ago (< ${STALE}s), so it is still held"
      else echo "holder pid $p is GONE and the lock has not been kept warm for ${a}s: takeable"; fi
    else echo "not held"; fi ;;
  heartbeat)
    [ -e "$LOCK" ] || { echo "not held; nothing to keep warm" >&2; exit 1; }
    [ "$(holder_wave)" = "$WAVE" ] || { echo "held by $(holder_wave), not $WAVE" >&2; exit 1; }
    touch "$LOCK"; echo "warm ($WAVE, age reset)" ;;
  release)
    if [ ! -e "$LOCK" ]; then echo "not held; nothing to release"; exit 0; fi
    if [ "$(holder_wave)" != "$WAVE" ]; then echo "held by $(holder_wave), not $WAVE; refusing to release another wave's lock" >&2; exit 1; fi
    rm -f "$LOCK"; echo "released" ;;
  take)
    mkdir -p "$(dirname "$LOCK")"
    seen_dead=""
    waited=0
    while :; do
      if write_lock ""; then echo "taken by $WAVE (pid $$)"; exit 0; fi
      p="$(holder_pid)"; w="$(holder_wave)"
      age="$(lock_age_s)"
      if { [ -n "$p" ] && kill -0 "$p" 2>/dev/null; } || [ "$age" -lt "$STALE" ]; then
        seen_dead=""
      else
        # Dead holder AND a lock nobody has kept warm for the stale window. Take it over on the
        # SECOND consecutive sighting, not the first.
        if [ -n "$seen_dead" ]; then
          rm -f "$LOCK"
          if write_lock "$(printf 'took-over-from=%s pid=%s (that process is gone)\n' "${w:-unknown}" "${p:-unknown}")"; then
            echo "took over a stale lock left by ${w:-unknown} (pid ${p:-unknown}, not running; not kept warm for ${age}s)"; exit 0
          fi
        fi
        seen_dead=1
      fi
      [ "$waited" -ge "$MAX" ] && { echo "still held by ${w:-unknown} (pid ${p:-unknown}, age ${age}s) after ${waited}s" >&2; exit 1; }
      sleep 30; waited=$((waited + 30))
    done ;;
  *) echo "usage: $0 take|heartbeat|release|show <wave> [max-wait-seconds]" >&2; exit 64 ;;
esac
