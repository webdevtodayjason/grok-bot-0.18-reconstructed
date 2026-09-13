# Runbook: picking this work up in a new session

Written 2026-09-13 07:50 CDT after a 420 hour session. Everything a fresh Claude session needs to
carry Titanium Bot forward without the old one. Read top to bottom once; the rest is reference.

## 1. Read these first, in this order (10 minutes)

1. The memory index for this project: `~/.claude-titanium/projects/-Users-sem-orca-grok-bot-0-18-reconstructed/memory/MEMORY.md`. Every line is one fact; open the ones named below.
2. `ORCHESTRATION.md` in this repo, from the bottom up: every ship since 2026-09-12 with its commit, what was measured and what was not.
3. `docs/OVERNIGHT-2026-09-12.md` and `docs/RUNBOOK-2026-09-13.md`: the last batch and today's board.
4. `docs/GAP-ANALYSIS.md`: the tracker. Open rows carry an owner and a next action.
5. The morning report page: https://artifacts.semfreak.dev/a/titanium-bot/morning-2026-09-13-5a86e248/

## 2. Where things are

| what | where |
|---|---|
| console repo, branch `webdevtodayjason/gb` | /Users/sem/orca/workspaces/grok-bot-0.18-reconstructed/gb (an Orca worktree; other panes may leave it dirty, ship from a clean worktree) |
| phone app, branch `main` | /Users/sem/orca/workspaces/titanium-bot-app (a push to main mints a TestFlight build; only ios/, www/, packages/, the workflow and package files trigger it) |
| farm | /Users/sem/code/tiinyapp-farm (Cloudflare Worker, deploy by hand: `python3 scripts/build-site.py && wrangler deploy`, then purge the zone cache) |
| Titan's Yard | /Users/sem/code/titan-yard |
| the R750 | `ssh dell-remote`; control plane `titanbot-cp-hnhzi0ongkw0gsg9k4flcv7d`, relay `titanbot-relay-p927bfqm83ioloibamlvyd7g`, proxy `titanbot-proxy-i14454v1njec3rmpyo7tyumi` (never restart the proxy), boxes `titanbot-box-<coolify uuid>`; demo box `atonqjq7zx593jsacaccpfau`, Jason's `p927bfqm83ioloibamlvyd7g`, Richard's `wepegxhh3fpvr83bubvz5xm5` is read-only |
| scratchpad | this session's worktrees and ship trees; a new session gets a new one, nothing there is load bearing |

## 3. The ship recipe (console, control plane, host)

1. Commit on `webdevtodayjason/gb`. Never ship a dirty tree.
2. `git worktree add --detach <scratch>/ship-<sha> <sha>`, then `ln -s <gb>/node_modules` and `ln -sfn <gb>/src/app/dist` into it (the bundle is gitignored).
3. `bash deploy/r750/sync.sh --no-install` from that worktree. It builds the host bundle and copies cp, ui, deploy and the runtime to the R750. Check for a running sync first with `pgrep -f "[s]ync.sh"` (the plain pattern matches its own command line).
4. Control plane changed: on the R750 `bash /home/sem/titanbot/deploy/control-plane-install.sh`, then `sudo -n sh -c "cd /data/coolify/services/hnhzi0ongkw0gsg9k4flcv7d && docker compose -p hnhzi0ongkw0gsg9k4flcv7d -f docker-compose.yml --env-file .env up -d --no-deps --force-recreate titanbot-cp"`. Only with no onboarding in flight (grep the cp log for "onboard" in the last 30 minutes).
5. Host changed: per box, `docker exec <box> /exec-daemon/node -e "fetch('http://127.0.0.1:1340/api/updateHostNow',{method:'POST',headers:{authorization:'Bearer '+process.env.SAND_GATEWAY_TOKEN,'content-type':'application/json'},body:'{}'})"`, then poll `getHostStatus` until `hostVersion` matches `runtime/sand-host-bundle-latest.version`. Demo first, then Jason's, then testers one at a time and only when idle (no sendPrompt or router lines in 30 minutes).
6. Relay changed: `docker restart titanbot-relay-…` LAST, and only with no voice call open (`voice_sessions` rows in state open in the cp database).
7. Log the ship in `ORCHESTRATION.md` with the time, the commit, and what was measured.

Admin reads and writes on the control plane: `docker exec <cp> node -e "fetch('http://127.0.0.1:7790/v1/admin/...',{headers:{authorization:'Bearer '+process.env.CP_ADMIN_TOKEN}})"`. The database is `$CP_DATA_DIR/control-plane.sqlite` inside the container, readable with `node:sqlite`.

## 4. The phone app

- Push to main = TestFlight build; the run number is the build number. Write `ios/WHAT-TO-TEST.md` first; the workflow attaches it. By hand: `source ~/.api_keys && node scripts/testflight-what-to-test.mjs --build <n> --notes-file ios/WHAT-TO-TEST.md`.
- TestFlight feedback: `source ~/.api_keys && node scripts/testflight-feedback.mjs --since YYYY-MM-DD`.
- The phone's audio report prints on the relay's voice settle line (`phone route`, `phone mic frames`, `mic peak`). Read it before theorising about a call.
- Xcode tests: `xcodebuild test -scheme TitaniumBotBridge -destination "id=<a shut-down iPhone simulator>"` in packages/titanium-bridge.

## 5. Workers, and keeping the token bill down

- Claude workers: the `implementer` agent, model opus, one worktree per worker (`git worktree add -b night-<name> <scratch>/night-<name> HEAD` plus the two symlinks), a brief in docs/<WAVE>.md, files owned per worker, no pushes, no R750, tests pasted in a report. Merge, run the suites, ship.
- Codex, headless, for self-contained builds (the yard, a scoped console change): `codex --disable browser_use --disable browser_use_external --disable computer_use exec -s workspace-write -C <dir> "<prompt>" < /dev/null`. Its sandbox cannot commit, bind a port or reach the network: commit for it, run its harness yourself. Without `< /dev/null` it waits on stdin forever.
- Codex and Grok through Orca for research and parallel scoped tasks: see the memory note `orca-orchestration-workers` (run-create, task-create, worker-start with `--agent codex|grok`, check with `--ack`). Grok launches reliably; start Codex workers one at a time.
- Rule of thumb: Claude for anything touching the host, the relay's voice path or the control plane's doors; Codex or Grok for docs, harnesses, the yard, research, and console-only changes with a browser leg to prove them.

## 6. Standing rules (verbatim from Jason, still in force)

- `~/.api_keys` is never used without permission. Authorised so far: Coolify (read-only), RESEND_API_KEY_TITANIUM, BROWSERBASE, ZAI, MINIMAX, QWEN, TINYFISH, OPENAI_API_KEY for farm art, PYPI_API_KEY for farm releases, the App Store Connect key on this Mac for TestFlight.
- Never read `~/.claude/.credentials.json`, the keychain, `~/.tinyfish`, `ui/endpoints.json`, `ui/subscriptions.json`, `ui/auth.json`, `ui/mail.json`, or cp.env beyond one named value. Never print a token. Never store a key pasted in chat. Bitwarden is the source of truth; pull by field name with a session file, lock after.
- Never sign in as Jason; throwaway accounts or CP_ADMIN_TOKEN inside the cp container.
- Never restart the proxy. Never recreate the cp with an onboarding in flight. Richard's box is read-only. Never kill the shared local relay on 127.0.0.1:7777. Never test Lite on port 7788.
- No em dashes in anything a person reads. Versions move the last number only. Verify UI in a real browser at 1440 and 390.
- ADHD mode: lead with the next action, numbered steps, five items at most, no preamble or closers. Ponytail: the smallest diff that works.

## 7. Watchers and loops

- Feedback watcher: a session Monitor polling the cp feedback table and TestFlight every 5 minutes. It dies with the session; re-arm it (the command is in ORCHESTRATION.md at 07:46 CDT 2026-09-13) or build FEEDBACK-3.
- Overnight autonomous mode: ScheduleWakeup with a prompt that names the batch doc and the recipes; workers report on their own; a morning report page with measured vs planned ends it.
