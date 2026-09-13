# KB-1f: an installed skill's name and description reach the prompt

Landed on branch `night-kb1f`, 2026-09-12. Every number below was measured on this Mac. No number
below came from a box, because a worker has no box; section 6 says exactly what that leaves unproven.

## 1. The fault, as it was

`SandRequestContextExecutor` (`source/host/runner/agent-adapters.ts:29`) has taken a
`resolveAgentSkills` callback since the reconstruction, and `createTurnLocalResourceProjection`
(`source/host/runner/turn-agent-composition.ts:1350`, `:1596`) has had a field to pass one. Nothing
ever passed one. So `agentSkills` on the `RequestContext` was an empty array on every turn of every
agent on every box, `buildAvailableSkillsPromptSection` returned no section because its count was
zero, and no installed skill's name or description reached any prompt.

`agentSkillsFromWorkflows` (`source/shared/workflow-model.ts:62`) already held the right rules for
which workflow is a skill, and was exported and called from nowhere in `source/`.

Two consequences, both recorded in the KB-1f row before this change:

- a seeded pack cost **zero** standing prompt bytes, and
- a seeded pack was **invisible** unless a path was written into the standing persona section by
  hand, which is why KB-1 spent 699 characters of its 700-character budget naming a single file.

## 2. What landed

`source/host/runner/agent-skills-resolver.ts` is the producer. It is wired once per runner in
`source/host/host-runner-composition.ts`, next to where `turnRequestContext` is bound, from the
session's own `FileWorkflowStore`, the same list the Skills panel shows: managed seeds, plugin
skills, and this agent's enabled library rows.

Seven rules it keeps, each with a case in `tests/agent-skill-catalog.test.mjs`:

1. **Name and description, never the body.** `AgentSkill` carries a `content` field; nothing in the
   prompt path or in the Read tool reads it, so it stays empty on purpose. A body in a standing
   section is paid on every turn of every agent forever, and the handbook index alone is over 5,000
   characters. The test asserts twelve of the index pack's own body lines are absent from the
   rendered section, and that the whole section is smaller than one pack's body.
2. **The path is the one the model can open.** The store's `filePath` on a box is under
   `/home/box/sand-data`. The path the model is given everywhere else is the `/home/box/agent-data`
   alias: in the persona's handbook sentence, in the workflows location, in the profile files. Every
   row goes through `toModelVisiblePath` the same way. A catalog naming the raw path would hand the
   model forty file names and no way to read any of them.
3. **A routine is not a skill.** A workflow with a trigger is a job that runs on its own, not a file
   the model may open; `agentSkillsFromWorkflows` already dropped those and is the filter used here.
4. **A skill switched off for this agent is not offered**, and a skill with no file on disk has no
   path to hand over. Same filter.
5. **Forty at most,** with the managed and plugin packs ordered first by `limitSurfacedWorkflows`, so
   the cap takes the tail of a user's library and never a seeded pack. The operator is told once per
   runner, on the host console, when the cap bites.
6. **Empty stays empty.** An agent with no skills resolves to `[]`, and
   `buildAvailableSkillsPromptSection` then returns no section at all rather than an empty one.
7. **It never throws.** An unreadable library is a missing prompt section, not a failed turn, and
   `agentSkillsInfoComplete` stays unset so the runner does not treat a capped list as a context it
   has to resolve again.

## 3. The standing cost

Measured on this Mac on 2026-09-12, rendering the real `<available_skills>` section through
`buildAvailableSkillsPromptSection` and `renderContent` with the ten seeds a box carries and their
real `/home/box/agent-data` paths. Estimated tokens are `estimateStringTokenCount`, the same
estimator the section's own budget uses.

| what is in the catalog | characters | estimated tokens |
|---|---|---|
| nothing (before this change: the section never rendered) | 0 | 0 |
| 1 skill | 886 | 222 |
| the 5 handbook packs alone | 2,516 | 629 |
| the 5 legacy seeds alone | 2,097 | 524 |
| **the 10 seeds a box carries** | **3,927** | **982** |
| 40 skills, the cap | 13,760 | 3,440 |

So the fixed preamble is about **700 characters**, and each further skill about **338 characters
(84 estimated tokens)**. A seeded pack is no longer free: it costs about 84 tokens of standing
prompt on every turn of every agent that has it.

Per seed, the two parts of a row:

| seed | path | description |
|---|---|---|
| add-connector | 65 | 92 |
| code | 56 | 221 |
| email | 57 | 256 |
| handbook-connect-an-app | 75 | 254 |
| handbook-never-ask | 70 | 280 |
| handbook-plain-words | 72 | 230 |
| handbook-starter-packs | 74 | 243 |
| handbook-what-i-can-do | 74 | 253 |
| learn-from-demonstration | 76 | 113 |
| onboarding | 62 | 208 |

The cap and the section's own token budget do not fight. `applySkillCatalogBudget` gives the catalog
2% of the agent token limit, which is 4,000 tokens at the 200,000 the host configures; forty rows of
real descriptions render at 3,440 and the strategy stays `under_budget`, so nothing is shortened at
the cap. Descriptions are capped at 1,536 characters by `WORKFLOW_MAX_DESCRIPTION_LENGTH`, so a box
whose skills all carry maximum-length descriptions would cross the budget and the existing
shorten-then-drop path would take over. That path is the product's, not this row's, and is untested
here.

## 4. Files

| file | what changed |
|---|---|
| `source/host/runner/agent-skills-resolver.ts` | new: the producer, the 40 cap, the path rewrite |
| `source/host/host-runner-composition.ts` | the wiring, once per runner, from `session.workflows` |
| `source/host/runner/standing-persona.ts` | two comments that said nothing supplies the callback |
| `tests/agent-skill-catalog.test.mjs` | new: 10 cases |
| `tests/index.js` | the new suite, so `node --test tests/` runs it |
| `tests/handbook-seeds.test.mjs` | the header comment that said the catalog never renders |
| `docs/HANDBOOK.md` | the same claim in three places, and the "five descriptions cost zero" row |
| `docs/GAP-ANALYSIS.md` | the KB-1f row |
| `tests/publication-packaging.test.mjs` | **out of slice, see section 7** |

`source/shared/workflow-model.ts` needed no change. Its `agentSkillsFromWorkflows` was already right
and already exported; it only lacked a caller.

## 5. What was run

| gate | result |
|---|---|
| `npm run source:typecheck` | clean |
| `node scripts/build-host.mjs --out /tmp/kb1f-hostbuild` | `validated-clean-source clean=true`, and the resolver is present in `host-main.cjs` |
| `node --test tests/agent-skill-catalog.test.mjs` | 10 pass, 0 fail |
| `npm test` (whole suite) | **3,366 pass, 0 fail**, 35 s |
| `node scripts/verify-handbook.mjs --offline` | OK, after the `docs/HANDBOOK.md` edits |

The ten cases drive the real chain rather than a stub of it: the real seeds written to a real
managed-skills directory the way `writeManagedSkillsCache` writes them, read back by a real
`FileWorkflowStore`, through the resolver, into the real prompt section builder and the real
renderer. One case drives `createTurnLocalResourceProjection` itself and asserts the skills arrive on
the `RequestContext` the prompt reads, because that was the step that was empty. One case reads
`host-runner-composition.ts` and fails if the producer is ever unplugged again, which is the exact
regression KB-1f was: every other case would have passed while no agent's prompt changed.

## 6. What is not proven

- **No live turn.** Nothing here was measured on a box, local or R750. A worker has no box, and this
  change alters what every agent's prompt carries, so the first box to see it should be a local one.
- **KB-1h is not answered.** The reason this row was owned by KB-1h is that the R750 demo tenant's
  `plan-qwen` opened no handbook pack across five owner questions while the local box's `glm-5.3`
  opened the index on its first. Whether a catalog row moves that model is unmeasured. The re-runs
  owed are `node scripts/verify-handbook.mjs --console a`, `--console b` and `--console c` on the
  demo tenant against the 32 line, and `--leg a/b/c` on the local box, after a swap.
- **The prefix cache.** Adding 982 estimated tokens to the front of every prompt re-primes a
  provider's prefix cache once, and on the M3 GLM path a cold prefix measured 240 s against 1.3 s
  cached. The catalog renders inside the user-info section, not ahead of the base prompt, so this
  should be a one-time cost per box rather than a per-turn one, but it was not measured.
- **Order stability.** The rows are in `FileWorkflowStore.list()` order, which is managed, then
  plugin, then library, managed in the order `cache.json` holds them and the library in the order the directory lists it. A library whose
  directory order changes between turns would churn the section and cost a cache miss each time.
  Unmeasured, and no case pins it.
- **A box over the cap.** No box has forty skills today, so the cap's warning line and the tail it
  drops have been exercised only in the test, never in a real library.
- **Subagents.** `displaySkills` is false for a subagent runner and for a shared-room runner, so the
  section does not render there even though the resolver is supplied. That is the product's existing
  gate and was not changed; a subagent's request context now carries the skills without rendering
  them, which costs nothing and was not measured either way.

## 7. Out of slice, and why

`tests/publication-packaging.test.mjs` was failing before this work and fails on every branch cut
from `webdevtodayjason/gb` today. ROUTER-1 (`0679508`, 2026-09-12 16:42) added a per-session options
argument to `createProviderPromptSession`, and two assertions in that test pinned the call by its
arity: `/createProviderPromptSession\(provider\)/` and
`/createProviderPromptSession\(inferenceProvider, input\.conversationId\)/`. Both now require a
literal closing paren that the source no longer has. The source is right and the assertions were
stale, so both regexes now end `[,)]` and pin the call by its provider instead of its arity.

This is two characters in a file outside the slice KB-1f was given. It is reported here rather than
left, because `npm test` was one of this row's gates and a red suite is not a gate. If another
overnight worker fixed the same two lines, the two changes are identical in intent and the conflict
is trivial.
