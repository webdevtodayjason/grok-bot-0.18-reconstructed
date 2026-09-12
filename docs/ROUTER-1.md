# ROUTER-1: talk on Flash, work on GLM-5.3

Jason (2026-09-12): route regular talking and research to the cheaper model and switch to the
expensive one for coding and heavy work, without people losing capability.

Today every box carries one model alias (SAND_OPENAI_COMPATIBLE_MODEL, e.g. plan-zai; see
cp/proxy.mjs around line 52 and source/host/extensions/inference/openai-compatible-chat.ts). The
proxy (LiteLLM on the R750, config in cp/proxy.mjs) maps aliases to deployments per tenant key.

## Design
- Two tiers per plan alias: `<alias>` stays the work tier (GLM-5.3) and `<alias>-talk` is the talk
  tier (GLM-5.3-Flash). cp/proxy.mjs mints both routes for every tenant key (same key, two aliases);
  the vision alias stays as is. `node cp/cli.mjs proxy sync` (or whatever the existing mint path is)
  writes them; existing tenants get the talk alias on the next sync.
- The host decides per model call, in the inference layer, with these rules in order:
  1. A call inside a code sandbox task, a file edit tool, or the coding agent runs on work.
  2. A turn starts on talk when its request carries no heavy tool call yet (chat, web search,
     memory, mail reading, the handbook).
  3. The first heavy tool call in a turn (Shell, code sandbox, Write/Edit, Computer) upgrades the
     rest of that turn to work; the computer-use subagent's screenshot reads stay on talk, its
     planning calls go to work.
  4. Two consecutive tool errors in a turn upgrade the rest of the turn to work.
  5. Routines run on talk unless the routine is marked heavy.
- Pins: a conversation-level "Think harder" switch on the composer (console adapter, never app.js)
  pins work for that conversation; an admin pin per workspace (Clients panel: Auto / Always work /
  Always talk) wins over everything.
- Every call logs which tier it used (the spend rows already carry the model, so the Spend panel's
  per-model rows show the mix without new columns; add a "talk / work" label beside the model name
  when the alias is one of ours).
- Nothing changes for a box whose plan has no talk deployment: the router sees one tier and uses it.

## Verify
Host: `pnpm test` (or the existing vitest suites) for the inference layer with new tests for the five
rules and the pins; cp: `node --test tests/cp-proxy*.test.mjs tests/cp-admin.test.mjs`; console:
the machine-room suites. `node --check`/`tsc --noEmit` on touched files. Write docs/ROUTER-1-REPORT.md
naming the exact files and how the host bundle is rebuilt and pushed (scripts under deploy/ and the
updateHostNow path in docs). Never launch a browser, docker or any GUI. Do not commit.
