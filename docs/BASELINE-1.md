# BASELINE-1: research is the first baseline skill, and search works for every tenant

Jason, 2026-09-15: "TinyFish as the default search service for every tenant: yes, unless asked to use the
browser in the agent's desktop. Ship wave 1 to the testers this week: yes." Ranking of the baseline list
(research, read and explain, draft, remind, remember, do it on a website, hand to the desk, say what went
wrong): "that is good." Review page: https://artifacts.semfreak.dev/a/titanium-bot/baseline-skills-1056502f/

## Measured before this wave (2026-09-15, R750)
- 10 tenants. Boxes with a connectors file: titanium, demo, richard-avery, web-dev-today. No connectors at all:
  titanium-2, beta-33, beta-34, beta-35, beta-36, beta-36-2. On those, WebSearch answers "No web search
  service is set up on this machine" (report #35).
- The host takes search from a TinyFish connector or from a TinyFish key + fetch/search endpoints in the
  box's connector-env-secrets.json (source/host/extensions/inference/tinyfish-route.ts). The metering
  proxy already has per-tenant /tinyfish/search and /tinyfish/fetch routes (cp/proxy.mjs, PROXY-1).
- Ten managed seed skills (source/host/extensions/managed-setup/seed-skills/); none about research.
- The research skill written for Kelley's case is on Jason's box only:
  /home/box/sand-data/workflows/research-multi-source/SKILL.md (report #44 has the summary and the
  acceptance test).

## Four pieces, one wave
1. Search for every tenant (cp): a control-plane command that writes the TinyFish section (key from the
   proxy's per-tenant route, fetch and search endpoints at http://titanbot-proxy:4000/tinyfish/...) into
   every box's secrets file, idempotent, one tenant at a time, with `--dry-run` and a per-box proof
   (the box's own WebSearch tool answering a real query). "Unless asked to use the browser" is already the
   ladder's shape: search first, browser when the question needs interaction or the user asks.
2. The research skill as the eleventh managed seed: copy Jason's SKILL.md into seed-skills/research/,
   owner the product, regenerate seed-skills.gen.ts, and make the handbook's "what I can do" name it.
3. Base rules below the skill layer: R1 (a site's own search is not its catalog), R2 (no universal
   negatives; "I couldn't find" is the strongest form), R4 (answer at the altitude asked), R5 (every
   source the user named appears in the answer) into the persona/team rules so a Titan with no skills
   still obeys them. Keep it to those four sentences.
4. Soft-failure trigger in the ladder text: results came back but none match the parsed ask (qualifier,
   geography, done-when) escalates like a hard failure, and the cheapest escalation is a better query
   (format, vocabulary, site-scoped) before a bigger tool.

## Acceptance
Ask a tester box Kelley's exact question: "Who carries 3/8 in. x 8 in. hot-dip galvanized hex bolts in
packs of 10 or 25 in Leander or Cedar Park, TX, at local stores?" Pass: a store-level table across Home
Depot, Lowe's, Ace and two fastener suppliers, a qualifier-match column, stock and date checked, no
universal negative, a COULDN'T ESTABLISH section with phone numbers. Fail: one retailer's price with
"nobody" anywhere. Run it on the demo box, then Jason's, then one tester, with the transcript kept.

## Ship order and rules
Host bundle: demo box first, then Jason's, then testers one at a time (the ship recipe in
docs/RUNBOOK-SESSION.md). Control plane: compose recreate on the R750 with no onboarding in flight.
No relay change. Measure per-box before and after with the acceptance question. Report measured facts
separately from plans.
