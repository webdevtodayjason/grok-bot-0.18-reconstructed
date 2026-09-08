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
# TENANT-4. IT ALSO RUNS FROM INSIDE THE BOX, and that is not a convenience.
#
# Every line below used to go through `docker exec`, and a tenant's box has no docker socket by
# design (TENANT-2: a socket in that container is root on the host). So this repair reached exactly
# one box on the R750 -- the operator's, the one with the socket -- and both customer boxes ran the
# stock start-window. Measured 2026-09-08: md5 99a90e45... with 3 `session_alive` on Jason's box,
# d69219af... with 0 on Richard's and on the demo tenant's. A forked agent on a customer box met
# the black screen DISPLAY-2 is about, right then.
#
# `run` is the whole change: inside the container it runs the command directly, outside it runs the
# same command through `docker exec`. The box's own entrypoint calls this with TITANBOT_IN_BOX=1
# before `exec /usr/local/bin/start-sand-box`, the way the sqlite3 install already does, and it has
# to run on EVERY start because the edit is a filesystem change in the container and a recreate
# throws it away.
#
#   sh scripts/box-patches/apply-start-window-fix.sh [container]   from the host, through the socket
#   TITANBOT_IN_BOX=1 sh /opt/titanbot-runtime/apply-start-window-fix.sh   from inside the box
set -eu
BOX="${1:-grok-bot-local-vm}"
IN_BOX="${TITANBOT_IN_BOX:-0}"

# One wrapper over what used to be seven `docker exec` call sites. `run` takes a command; `run_stdin`
# is the same thing for the heredocs, which are the reason this could not just be an alias.
if [ "$IN_BOX" = 1 ]; then
  run() { "$@"; }
  run_stdin() { "$@"; }
  WHERE="this box"
else
  command -v docker >/dev/null 2>&1 || { echo "no docker CLI and TITANBOT_IN_BOX is not set; this cannot reach a box" >&2; exit 1; }
  run() { docker exec "$BOX" "$@"; }
  run_stdin() { docker exec -i "$BOX" "$@"; }
  WHERE="$BOX"
fi

run sh -c 'test -f /usr/local/bin/start-window.orig || cp /usr/local/bin/start-window /usr/local/bin/start-window.orig'

run_stdin python3 - <<'PY'
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

run_stdin python3 - <<'PY'
# DISPLAY-1 (2026-09-03). stop-window removes the owner token and kills by port, but an X server
# holds no port, so a released fork's Xvfb lived on as an orphan with no token; start-window then
# read "no token" as "someone else's token" and refused the display to the next agent
# ("start-window failed"). An alive display with no owner is torn down and rebuilt; a display
# owned by a different live token is still refused.
p = "/usr/local/bin/start-window"
s = open(p).read()
if "orphan display with no owner" in s:
    print("orphan branch already patched")
else:
    old = '''\tif [ "${current_binding}" != "${OWNER_TOKEN}" ]; then
\t\techo "sand window ${DISPLAY_NUM}: display owned by a different token; refusing to adopt" >&2'''
    new = '''\tif [ -z "${current_binding}" ]; then
\t\techo "sand window ${DISPLAY_NUM}: orphan display with no owner; tearing it down" >&2
\t\tpkill -f "Xvfb :${DISPLAY_NUM} " 2>/dev/null || true
\t\tpkill -f "DISPLAY=:${DISPLAY_NUM}" 2>/dev/null || true
\t\tsleep 1
\t\trm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
\telif [ "${current_binding}" != "${OWNER_TOKEN}" ]; then
\t\techo "sand window ${DISPLAY_NUM}: display owned by a different token; refusing to adopt" >&2'''
    assert old in s, "refusal branch not found -- the box image changed"
    s = s.replace(old, new, 1)
    open(p, "w").write(s)
    print("orphan branch patched")
q = "/usr/local/bin/stop-window"
w = open(q).read()
if "Xvfb :${DISPLAY_NUM} " in w:
    print("stop-window already kills Xvfb")
else:
    w = w.rstrip("\n") + '''
# DISPLAY-1 (2026-09-03): the X server holds no port, so the port sweep above never reached it.
pkill -f "Xvfb :${DISPLAY_NUM} " 2>/dev/null || true
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
'''
    open(q, "w").write(w)
    print("stop-window patched")
PY

run_stdin python3 - <<'PY'
# DISPLAY-2, second rule (2026-09-03). A display owned by another token is refused only while its
# exec daemon answers; a seat whose daemon is dead is an orphan whatever token it carries (a
# subagent's seat after its run, a stopped fork that came back), and is torn down and rebuilt.
p = "/usr/local/bin/start-window"
s = open(p).read()
if "refuse only a live seat" in s or "adopting the seat" in s:
    print("live-seat rule already patched")
else:
    old = '''\telif [ "${current_binding}" != "${OWNER_TOKEN}" ]; then
\t\techo "sand window ${DISPLAY_NUM}: display owned by a different token; refusing to adopt" >&2'''
    new = '''\telif [ "${current_binding}" != "${OWNER_TOKEN}" ] && daemon_alive; then
\t\t# refuse only a live seat: a dead daemon means nobody is driving this display
\t\techo "sand window ${DISPLAY_NUM}: display owned by a different token; refusing to adopt" >&2'''
    assert old in s, "refusal branch (orphan form) not found"
    s = s.replace(old, new, 1)
    old2 = '''\t\texit "${WINDOW_UNAVAILABLE_EXIT_CODE}"
\tfi
fi'''
    new2 = '''\t\texit "${WINDOW_UNAVAILABLE_EXIT_CODE}"
\telif [ "${current_binding}" != "${OWNER_TOKEN}" ]; then
\t\techo "sand window ${DISPLAY_NUM}: display held by a dead seat (token differs, no daemon); tearing it down" >&2
\t\tpkill -f "Xvfb :${DISPLAY_NUM} " 2>/dev/null || true
\t\tpkill -f "DISPLAY=:${DISPLAY_NUM}" 2>/dev/null || true
\t\tsleep 1
\t\trm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
\tfi
fi'''
    assert old2 in s, "refusal exit not found"
    s = s.replace(old2, new2, 1)
    open(p, "w").write(s)
    print("live-seat rule patched")
PY

run sh -n /usr/local/bin/start-window
run sh -n /usr/local/bin/stop-window
echo "start-window and stop-window patched and syntax-checked on $WHERE"

run_stdin python3 - <<'PY'
# DISPLAY-4 (2026-09-04). The host is the only allocator of fork windows, so a live seat whose token
# the host did not issue is one the host lost (a bring-up that outlived its agent's deletion, or a
# host restart that could not read its assignments). Refusing it wedged every new agent onto the
# same lowest free index until the container restarted. Adopt it: tear the seat down and rebuild.
p = "/usr/local/bin/start-window"
s = open(p).read()
if "adopting the seat" in s:
    print("adopt rule already patched")
else:
    old = '''\telif [ "${current_binding}" != "${OWNER_TOKEN}" ] && daemon_alive; then
\t\t# refuse only a live seat: a dead daemon means nobody is driving this display
\t\techo "sand window ${DISPLAY_NUM}: display owned by a different token; refusing to adopt" >&2
\t\texit "${WINDOW_UNAVAILABLE_EXIT_CODE}"
\telif [ "${current_binding}" != "${OWNER_TOKEN}" ]; then
\t\techo "sand window ${DISPLAY_NUM}: display held by a dead seat (token differs, no daemon); tearing it down" >&2'''
    new = '''\telif [ "${current_binding}" != "${OWNER_TOKEN}" ]; then
\t\t# the host is the only allocator: a seat it did not issue is one it lost, whether or not a daemon answers
\t\techo "sand window ${DISPLAY_NUM}: display held by a token the host did not issue; tearing it down and adopting the seat" >&2'''
    assert old in s, "live-seat refusal not found"
    s = s.replace(old, new, 1)
    open(p, "w").write(s)
    print("adopt rule patched")
PY
