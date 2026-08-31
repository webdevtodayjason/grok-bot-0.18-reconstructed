#!/bin/sh
# Reapply the fork-session repair to a running box.
#
# The box's own /usr/local/bin/start-window treats a live X server as a live desktop. An Xvfb that
# survives a container restart keeps answering xdpyinfo while the session under it is gone: the
# dbus-session-address goes stale, Xfconf cannot connect, xfwm4 exits, and the display is left with
# no window manager. start-window then reports "already up" forever, so a forked agent gets a black
# screen and nothing ever repairs it.
#
# This adds a session check -- _NET_CLIENT_LIST is set by the window manager, so its absence is the
# honest health signal -- and tears down only that one display when X is up without a session.
#
# It survives `docker restart` (it is a filesystem change inside the container) but NOT a recreate,
# so re-run it after `recreate-box.sh`.
#
#   sh scripts/box-patches/apply-start-window-fix.sh [container]
set -eu
BOX="${1:-grok-bot-local-vm}"

docker exec "$BOX" sh -c 'test -f /usr/local/bin/start-window.orig || cp /usr/local/bin/start-window /usr/local/bin/start-window.orig'

docker exec "$BOX" python3 - <<'PY'
p = "/usr/local/bin/start-window"
s = open(p).read()
if "session_alive" in s:
    print("already patched")
    raise SystemExit(0)

old = 'display_alive() { xdpyinfo -display "${DISP}" >/dev/null 2>&1; }'
new = old + '''
# A live X server is not a live desktop. xprop exits 0 even when it prints "not found", so the
# exit code proves nothing -- grep the output. _NET_CLIENT_LIST is set by the window manager.
session_alive() { xprop -display "${DISP}" -root _NET_CLIENT_LIST 2>/dev/null | grep -q "0x"; }'''
assert old in s, "display_alive not found -- the box image changed"
s = s.replace(old, new, 1)

old2 = "if display_alive && daemon_alive; then"
assert old2 in s, "short-circuit not found -- the box image changed"
s = s.replace(old2, "if display_alive && session_alive && daemon_alive; then", 1)

old3 = '''if ! display_alive; then
\trm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"'''
new3 = '''if display_alive && ! session_alive; then
\t# Only this display. Never clear /tmp/.X11-unix wholesale: it takes the primary seat with it and
\t# leaves every Xvfb running with nothing able to connect.
\techo "sand window ${DISPLAY_NUM}: X is up but the session is dead; rebuilding" >&2
\tpkill -f "Xvfb :${DISPLAY_NUM} " 2>/dev/null || true
\trm -f "${BOX_USER_XDG_DIR:-/tmp/xdg-runtime-box-${DISPLAY_NUM}}/dbus-session-address" 2>/dev/null || true
\tsleep 1
fi

''' + old3
assert old3 in s, "bringup block not found -- the box image changed"
s = s.replace(old3, new3, 1)
open(p, "w").write(s)
print("patched")
PY

docker exec "$BOX" sh -n /usr/local/bin/start-window
echo "start-window patched and syntax-checked on $BOX"
