#!/usr/bin/env bash
# The browser gates (verify-dashboard, verify-deploy, verify-review) drive headless Chrome through
# playwright-core, which is deliberately not a dependency of this repo. It lives under .cache/playwright
# (gitignored); GROK_BOT_PLAYWRIGHT_DIR points the gates elsewhere. Until 2026-09-06 the default was one
# session's scratchpad directory, which no other machine or session had.
set -euo pipefail
cd "$(dirname "$0")/.."
npm install --prefix .cache/playwright --no-audit --no-fund --no-save playwright-core@1.62.1
node -e 'const {createRequire}=require("node:module");const r=createRequire(process.cwd()+"/.cache/playwright/package.json");r("playwright-core");console.log("playwright-core ready in .cache/playwright")'
