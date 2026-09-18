# JEV-1: Jev judgments inside Titan's loop (plan, eval harness first)

Status: approved by Jason 2026-09-17 for request interpretation (judgment 1) and the claim check (judgment 3), wired behind SAND_JEV, off by default, and turned on only for Titanium staff workspaces (the ones Jason owns). No external beta tester workspace gets the flag. Sufficiency (judgment 2) is held: the page-fetch rung failed the blind held-out set, and it is being replaced by constraint-confirmation nouls (judgment 2b) tested against a fresh blind set before it is considered. The eval harness is offline and reads TYPESAFE_API_KEY from the environment only.

Source of truth for the API: https://docs.typesafe.ai/api.md (POST https://api.typesafe.ai/v1/systemone, Bearer key, body {state, model, questions}; answers keyed by question id; noul answers carry `noul` 0..1; choice answers carry `choice`, `probabilities`, `confidence`; score answers carry `score`, `legend`, `probabilities`, `confidence`; `usage.input_tokens` and `output_tokens`; 401/422/429/529). Model: `jev-latest` -> `jev-1.13.0`; pin `jev-1.13.0` once thresholds are tuned. Price $0.042 per million input tokens, output free. Limits: 64k tokens for state plus all questions, 32k for state plus the longest question. Known jagged edges (docs/model-jaggedness/jev-1.13): literal reading, no counting or arithmetic, no date maths, indirection, distracting state, adversarial state. Every design below keeps counts, prices, distances and dates in code.

## Stack

Host is TypeScript on Node 24. The harness and the later host module use plain `fetch` against the HTTP API with retry on 429/529 (about 40 lines), not the SDK, so the host gains no dependency. If we later want typed helpers, `@typesafe-ai/sdk` 0.6.0 (`new TypeSafeClient().systemOne({state, questions})`, helpers `choice`, `noul`, `score`) is the documented alternative.

Shared client, one function: `askJev(state, questions, {model})` returns `{answers, usage, model, latencyMs}`. Every call logs model id, latency and input tokens, never the state.

## Where each judgment hooks into the loop (later, behind SAND_JEV, default off)

| # | Judgment | Hook point in the host | What code does with the answer |
|---|---|---|---|
| 1 | Request interpretation | per-turn handoff in `source/host/runner/turn-agent-composition.ts`, before the first step, only when the turn's user message is a question | Writes a "constraints" note into the turn (scope, named stores, location, pack size present) that the research seed and the planner must respect; never rewrites the user's words |
| 2 | Result sufficiency and next step | the web_search and web_fetch wrappers in `source/host/runner/tools/turn-toolset.ts`, after each result | Appends one line to the tool result: "these results do not satisfy pack size; escalate to site-scoped search / fetch / TinyFish / browser" when confidence is high, nothing when low |
| 3 | Claim check before replying | the SendMessage wrapper (already special-cased in `buildTurnTools`) or `turn-settle.ts`, on the final message of a turn | Sentences carrying a negative are extracted in code (regex on nobody / no one / none / no store / does not carry / not available); each is judged against the turn's retrieved evidence; unsupported negatives are returned to the model as a tool error "unsupported claim, soften or search again" |
| 4 | Result reranking | web_search wrapper | Score each result against the constraints, spend fetch and browser calls on the top ones |
| 5 | Feedback triage | `cp/feedback.mjs` on arrival, internal only | Category and severity on the admin console row; nothing reaches a tester |

Recommended order: 1, then 3, then 2. The Kelley failure was altitude first (a local question answered nationally) and an unsupported negative second; 1 and 3 are those two faults, and 2 is the escalation that only matters once 1 has named the constraints.

## 1. Request interpretation

State (object, small, only the question and what code already knows):

```json
{
  "request": "Who carries 3/8 in. x 8 in. hot-dip galvanized hex bolts in packs of 10 or 25 in Leander or Cedar Park, TX, at local stores?",
  "workspace_location": "Leander, TX"
}
```

Questions, all in one request, evaluated in parallel:

- `scope` (choice): "What does the person want to know about where to get this item?" criteria: `local_in_store`: "which physical stores near a named or implied place have it on the shelf or for pickup today"; `online_ship`: "where it can be ordered online and shipped, place does not matter"; `national_price`: "what it costs in general, comparing prices, no store or place named"; `informational`: "what the item is, how it works, or advice, not where to buy"; `unclear`: "the request does not say enough to tell". Unclear is the no-match outcome.
- `names_stores` (noul): "Does the request name one or more specific retailers or store chains by name?" true: "at least one retailer or chain is named, such as Home Depot or Ace"; false: "no retailer or chain is named".
- `names_location` (noul): "Does the request name a city, town, ZIP code, neighbourhood, or say 'near me' or 'local'?" true/false spelled out the same way.
- `names_quantity` (noul): "Does the request state a required quantity, pack size, or count per package?" true: "a number of units or a pack size is stated, such as packs of 10"; false: "no quantity or pack size is stated".
- `substitutes_ok` (noul): "Does the request allow a different size, finish, or pack than the one stated?" true: "the person says a substitute, similar item, or any size is fine"; false: "the request asks for the exact item as stated, or says nothing about substitutes".

Why: choice for scope because the options compete; noul for each constraint because several may hold at once and each is used independently by code. Code combines: scope local_in_store with confidence >= 0.7 plus names_location >= 0.7 means the browser rung is the floor; names_quantity >= 0.7 means every result must carry a pack-size match or be marked unmatched.

## 2. Result sufficiency and next step

State (built in code, filtered, at most ten results, titles and snippets only):

```json
{
  "constraints": {"item": "3/8 x 8 in hot-dip galvanized hex bolt", "pack_sizes": [10, 25], "location": "Leander or Cedar Park, TX", "stores_named": ["Home Depot", "Lowe's", "Ace"]},
  "tool_used": "web_search",
  "results": [
    {"source": "homedepot.com", "title": "...", "snippet": "...", "pack_size_seen": "10", "store_level": false},
    {"source": "lowes.com", "title": "...", "snippet": "...", "pack_size_seen": "1", "store_level": false}
  ]
}
```

`pack_size_seen` and `store_level` are filled by code (regex on the snippet, whether a store was set), because Jev does not count or compare numbers.

- `satisfies` (choice): "Do the results answer the request as constrained?" criteria: `fully`: "at least one result is a listing at a named store, in the stated pack size, with stock or pickup for the stated place"; `partially`: "results show the item or the pack size but not for a specific store near the place, or for a store not named"; `no`: "no result shows the item in any stated pack size"; `cannot_tell`: "the snippets do not say enough to judge". cannot_tell is the no-match outcome.
- One noul per rung, not a choice, so Jev never applies an ordering: `can_answer_now` ("Do the results already give a store-level answer for every named store in the stated pack size?"), `needs_more_sources` ("Is a named store missing from the results entirely?"), `needs_page_fetch` ("Does a result's page likely carry the pack size or store pickup detail its snippet lacks?"), `needs_tinyfish` ("Did a needed page refuse a plain fetch or need rendering?"), `needs_desktop_browser` ("Does a store-level stock answer need a store to be selected on the site?"). Each has true and false criteria spelled out. Code holds the rung order (search more, fetch, TinyFish, browser) and picks the cheapest rung whose noul is at or above 0.6, never below the floor the constraints set. The fetch rung is NOT asked as a rung: instead judgment 2b asks one noul per extracted constraint about the best candidate result (confirms_item, confirms_pack_size, confirms_store, confirms_stock_for_location, each about `result.snippet` and `result.title` by path), and code fetches when any required constraint is unconfirmed (below 0.6).
- One noul per named store: "Is there a result from `stores_named[i]`?" so a dropped source (R5) is caught by code counting the answers, not by the model counting.

## 3. Claim check before replying

Claims are extracted in code from the draft answer: any sentence containing a negative marker, plus the ANSWER line. Evidence is the turn's retrieved snippets and fetched page text, trimmed to the pieces that mention the claim's store or item (filter in code first; Jev loses accuracy on distracting state). One request per claim, or several claims against the same evidence in one request.

State:

```json
{
  "claim": "Nobody in Leander or Cedar Park stocks a 25-pack of this bolt.",
  "evidence": [
    {"source": "homedepot.com", "text": "... 3/8 in.-16 x 8 in. Hot Dipped Galvanized Hex Bolt (10-Pack) ... Cedar Park store: in stock ..."},
    {"source": "lowes.com", "text": "... Hillman 3/8-in x 8-in hex bolt, 1 each ..."}
  ],
  "sources_checked": ["Home Depot", "Lowe's"],
  "sources_named_in_request": ["Home Depot", "Lowe's", "Ace"]
}
```

- `support` (choice): "How does the evidence relate to the claim?" criteria: `supports`: "the evidence states the claim or directly implies it"; `contradicts`: "the evidence states the opposite or shows a case the claim rules out"; `no_evidence`: "the evidence does not speak to the claim either way". no_evidence is the no-match outcome. (This is the citation-check cookbook's shape.)
- `is_universal_negative` (noul): "Does the claim say that no store, nobody, or no source at all has the item, rather than that the checked sources did not show it?" true: "the claim is about everyone or everywhere"; false: "the claim is scoped to the sources named as checked, or is not a negative".
- `covers_all_named` is computed in code: sources_checked contains sources_named_in_request. Jev does not count.

Code rule: a claim with is_universal_negative >= 0.7 is always returned to the model to be scoped to the sources checked ("Confirmed at none of the N sources checked"), whatever `support` says, because evidence from N stores can never support "nobody"; the tuned set showed Jev calling two above-price listings "supports" for a nobody claim at 0.85 confidence, which no confidence rule catches. For scoped negatives and positive claims, support != supports at confidence >= 0.6, or covers_all_named false, returns the claim as unsupported to soften or to trigger one more search of the missing source.

## 4 and 5, sketched

Reranking: score per result, "How likely is this result to be the item, at a named store, for the stated place?" levels: not the item / the item but no store or place / the item at a named store / the item at a named store with stock or pickup for the place. Feedback triage: choice over bug / wrong_answer / missed_source / feature_request / praise / unclear, and a score for severity over four concrete levels; internal only, and the report text is scrubbed of usernames in code before it is sent.

## Eval harness (deliverables 2 and 3)

- Two case sets, reported separately. The tuned set, `tests/fixtures/jev-cases.json` (about 30 cases plus about 15 universal-negative claim cases reported as their own slice), is what the question wording was adjusted against. The held-out set, `tests/fixtures/jev-heldout-cases.json` (about 40 cases), is written by a different agent who never saw the question wording or any result, and nothing is tuned against it. Any label correction is logged with the accuracy before and after.
- `tests/fixtures/jev-cases.json`: about 30 synthetic cases, labelled by hand, covering judgments 1 and 3 (and 2 where the case carries results). The Kelley case plus variants: a Lowe's result added, Home Depot removed, pack size changed to 50, location dropped, substitutes allowed, an online-only phrasing, a national price phrasing, an informational phrasing, and claims that are supported, contradicted, scoped negatives and universal negatives.
- `scripts/jev-eval.mjs`: runs every case, one request per case per judgment set, reads TYPESAFE_API_KEY from the environment (exits with a plain message if unset), retries 429/529 with backoff, and prints: accuracy per judgment, accuracy by confidence bucket (0.5-0.7, 0.7-0.9, 0.9-1.0) with the count per bucket, latency p50 and p95, input tokens total and cost at $0.042 per million, and the model id that answered. Output is written to `tests/fixtures/jev-eval-out.json`, which is gitignored: results stay internal.
- Nothing in the harness imports host code, so it cannot reach a tester.

## Constraints honoured

Agreement: flag SAND_JEV off by default; Jason turns it on himself, and only on Titanium staff workspaces. No customer, tester or Discord data: every case is synthetic, and the future feedback triage scrubs usernames in code first. No published results: the eval output file is gitignored and this document carries no numbers. Key only from TYPESAFE_API_KEY; never logged, never in a client bundle.

## Wiring conditions (Jason, 2026-09-17 07:52 CDT)

- Fallback per judgment. Interpretation below 0.9 confidence: named store, location and quantity stay hard constraints; scope is not guessed ("not determined, do not assume"). Claim check below 0.9: the claim is treated as unsupported and softened or the missing source searched. Low confidence never produces a confident line.
- Timeout 750 ms, no retries. Timeout or any error falls back to current behaviour. SAND_JEV is read per turn, so it is a runtime kill switch.
- Every decision is logged internally to agents/<id>/jev.jsonl: judgment, answer, confidence, band, action taken, model, latency; never the state. A staff "this was wrong" control writes a wrong marker next to the decision.
- Judgment 2 keeps "the results match the request" (can_answer_now) separate from "an honest and complete answer can be written now" (answerable_now), so "that colour does not exist" counts as answerable.
- Scope: flag off by default, on only for Titanium staff workspaces, never an external tester.
