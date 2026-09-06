#!/bin/bash
# bundle-identity.sh -- print the sha256 of the host bundle at each of the three places it lives,
# and say whether the box is running the bundle this tree built.
#
# Every ledger line in docs/PLUMBING-AUDIT.md names the bundle its gates ran on ("measured on the
# Mac box, bundle b035b9fe"). That short sha is an identity claim about the running box, and it was
# being written from memory: build-host.mjs --deploy prints a path and "restarted", never a hash, so
# the claim had no artifact behind it and nobody reading the ledger could check it. This is the
# artifact. Run it through scripts/on-box.sh (it uses docker) and keep the log:
#
#   bash scripts/on-box.sh bash scripts/bundle-identity.sh | tee <log>
#
# Only hashes are read out, never the bundle: it is ~20MB and has no business in a terminal.
set -u
repo="$(cd "$(dirname "$0")/.." && pwd)"
container="${SAND_BOX_CONTAINER:-grok-bot-local-vm}"
built="$repo/.cache/hostbuild/dist/host/host-main.cjs"
deployed="$repo/.cache/patched-host/host-main.cjs"
inbox="/home/box/sand-host/host-main.cjs"

hash_local() { [ -f "$1" ] && shasum -a 256 "$1" | cut -d' ' -f1 || echo "MISSING"; }
built_sha="$(hash_local "$built")"
deployed_sha="$(hash_local "$deployed")"
box_sha="$(docker exec "$container" sha256sum "$inbox" 2>/dev/null | cut -d' ' -f1)"
[ -n "$box_sha" ] || box_sha="UNREACHABLE"

echo "built     $built_sha  $built"
echo "deployed  $deployed_sha  $deployed"
echo "in box    $box_sha  $container:$inbox"

# The claim the ledger makes is about the box, so that is what the exit code answers: the running
# box carries the bundle this tree deployed. A built copy that has drifted ahead of the deployed one
# is an un-deployed build, worth saying out loud but not a mismatch of the claim.
if [ "$deployed_sha" = "MISSING" ] || [ "$box_sha" = "UNREACHABLE" ]; then
  echo "VERDICT: cannot compare (deployed=$deployed_sha box=$box_sha)"
  exit 2
fi
if [ "$deployed_sha" != "$box_sha" ]; then
  echo "VERDICT: MISMATCH -- the box is not running the deployed bundle"
  exit 1
fi
echo "bundle ${box_sha:0:8}: the box is running the deployed bundle"
if [ "$built_sha" != "$deployed_sha" ]; then
  echo "VERDICT: match, but this tree has built ${built_sha:0:8} and not deployed it"
  exit 0
fi
echo "VERDICT: match -- built, deployed and running are all ${box_sha:0:8}"
