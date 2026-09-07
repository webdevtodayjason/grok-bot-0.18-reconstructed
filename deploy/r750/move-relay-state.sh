#!/usr/bin/env bash
# move-relay-state.sh -- take the operator's own writable files out of the shared release directory.
#
# The problem, measured on the R750 2026-09-07. Every tenant's relay mounts
# /home/sem/titanbot/ui, and the operator's own auth.json, endpoints.json and subscriptions.json sit
# in there beside the code. The mount is read-only, which stops a customer WRITING them and does
# nothing at all about reading them: from inside the demo tenant's relay container, running as root,
# /app/ui/auth.json (the console password hash AND the cookie secret that signs every
# console.titanium.bot session), /app/ui/endpoints.json (provider API keys) and
# /app/ui/subscriptions.json (adopted provider tokens) were all readable.
#
# No console route serves those paths today, so this is one file-read bug away rather than open now.
# The fix is to stop shipping the operator's secrets to every customer at all: ui/ becomes code, and
# the writable files move to a directory only this instance mounts. SAND_UI_STATE_DIR is the switch
# that already exists for exactly this (ui/state-dir.mjs); it has simply never been set on the
# operator's own instance.
#
# TWO STAGES, on purpose, so that nothing is unrecoverable at any point:
#
#   copy   (default) copy the five files into $ROOT/state. Nothing is removed and nothing that is
#          running changes, so this is safe to run at any time, including on a live console.
#          Then paste deploy/coolify/docker-compose.yml into Coolify and redeploy: the relay comes
#          up with SAND_UI_STATE_DIR=/state and reads the copies.
#
#   clean  once the console is verified on the new files, remove the originals from ui/. Refuses
#          unless every file it would remove is already in $ROOT/state with identical bytes, so it
#          cannot be the step that loses a password.
#
# Between the two stages the console works either way, and rolling the compose back works too. That
# is the whole reason it is not one step.
#
#   bash deploy/r750/move-relay-state.sh          copy
#   bash deploy/r750/move-relay-state.sh clean    remove the originals
#
# Env: TITANBOT_ROOT (default /home/sem/titanbot).
set -eu

ROOT="${TITANBOT_ROOT:-/home/sem/titanbot}"
STAGE="${1:-copy}"
STATE="$ROOT/state"
FILES="auth.json endpoints.json subscriptions.json mail.json mail-inbox.jsonl"

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

sum_of() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | awk '{print $1}'; }

[ -d "$ROOT/ui" ] || die "$ROOT/ui is not here, so this is not the server the relay runs on"

case "$STAGE" in
  copy)
    step "the state directory"
    mkdir -p "$STATE" || die "could not create $STATE"
    # 0700: it holds the password hash, the cookie signing secret, the provider API keys and the
    # adopted provider tokens. The whole point of this script is that fewer things can read them.
    chmod 700 "$STATE"
    say "$STATE (mode $(stat -c %a "$STATE" 2>/dev/null || stat -f %Lp "$STATE"))"

    step "copy"
    copied=0
    for name in $FILES; do
      src="$ROOT/ui/$name"
      dst="$STATE/$name"
      if [ ! -f "$src" ]; then say "$name is not in ui/, nothing to copy"; continue; fi
      if [ -f "$dst" ] && [ "$(sum_of "$src")" = "$(sum_of "$dst")" ]; then say "$name is already in state/ and identical"; continue; fi
      [ -f "$dst" ] && die "$STATE/$name already exists and is DIFFERENT; look at both before this script touches either"
      cp -p "$src" "$dst" || die "could not copy $name"
      chmod 600 "$dst"
      copied=$(( copied + 1 ))
      say "$name -> state/$name  ($(sum_of "$dst" | cut -c1-12))"
    done
    say "$copied file(s) copied; nothing was removed and nothing running has changed"

    step "next"
    say "1. paste deploy/coolify/docker-compose.yml into the Coolify resource and redeploy."
    say "   It sets SAND_UI_STATE_DIR=/state and mounts $STATE there."
    say "2. sign in to the console and check the model picker still lists your endpoints."
    say "3. then: bash $ROOT/deploy/move-relay-state.sh clean"
    ;;

  clean)
    step "check before removing anything"
    [ -d "$STATE" ] || die "$STATE does not exist; run the copy stage first"
    removable=""
    for name in $FILES; do
      src="$ROOT/ui/$name"
      [ -f "$src" ] || continue
      dst="$STATE/$name"
      [ -f "$dst" ] || die "$name is still in ui/ and is NOT in state/; run the copy stage first"
      [ "$(sum_of "$src")" = "$(sum_of "$dst")" ] || die "ui/$name and state/$name are different; the relay has been writing to one of them, so look at both by hand"
      removable="$removable $name"
    done
    if [ -z "$removable" ]; then
      say "ui/ already holds none of these files, so there is nothing to remove"
      exit 0
    fi
    say "every file below is in state/ with identical bytes:$removable"

    step "remove the originals"
    for name in $removable; do
      rm -f "$ROOT/ui/$name"
      say "removed ui/$name"
    done
    say "ui/ is code now, which is what every tenant's relay mounts"
    ;;

  *) die "usage: move-relay-state.sh [copy|clean]" ;;
esac

printf '\n== done\n'
