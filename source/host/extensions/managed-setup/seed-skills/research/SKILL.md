---
name: research
description: >-
  Use when a question needs finding something out beyond what you already know:
  availability, pricing, sourcing, facts, comparisons, who, where, how much. It
  carries the rules that stop a confident answer to a slightly different
  question, the escalation triggers, and the shape the answer has to come back in.
---
# Research

Your job is not to find *a* result. It is to answer *the question that was asked*, and to be honest about how sure you are.

Most bad research answers are not wrong facts. They are correct facts answering a slightly different question, or confident claims resting on one thin lookup. This skill exists to prevent both.

## 1. Rules that override everything else

**R1. A site's own search is not authoritative about that site's catalog.** Retailer and distributor search boxes match tokens against a merchandising index and routinely fail to surface live pages. "Their search didn't find it" is evidence about their search, not their inventory. Never report the former as the latter.

**R2. Never assert a universal negative from a failed search.** "Nobody carries X" requires exhausting every named source AND a general web-index fallback against each, and even then write "I couldn't find", not "there is none". One failed search earns exactly: *"I couldn't find X at Y. Their site search misses items regularly, so it's worth a call."*

**R3. Absence costs more evidence than presence.** One page proves a thing exists. Nothing short of an exhaustive check disproves it. If your answer contains a negative claim, most of your work should have gone into trying to falsify it.

**R4. Answer at the altitude the question was asked.** If the user said *local*, the answer resolves to specific stores with stock status, not a national catalog price. If they said *who carries it*, the answer is a vendor list, not a price. Re-read the question before writing the summary.

**R5. Every source the user named appears in your output.** Including as "checked, nothing found". Silently dropping a named source reads as "not available there", which you did not establish. An "etc." means YOU pick additional sources and say which.

**R6. Distinguish what you saw from what you inferred.** Report the page you actually read. If reasoning past it, say so in the line where you do it.

## 2. Parse the ask before you search

Write out the slots before the first query. If a slot is empty and matters, ask or state the assumption in the answer.

| Slot | Example (fasteners) |
|---|---|
| Object | 3/8 in. x 8 in. hot-dip galvanized steel hex bolt |
| Qualifier | packs of 10 or 25 |
| Sources | Home Depot, Lowes, Ace, plus your pick |
| Geography | Leander / Cedar Park, TX |
| Intent | buy locally today: availability, not price |
| Done when | named stores with stock status, or an honest "couldn't find" per store |

**Intent** and **Done when** are the rows that get skipped and cause wrong answers. Fill them in.

## 3. Search ladder, amended

The base ladder (web search, then web fetch, then the browser) is a COST ladder: how to get a page when the cheap way fails. It says nothing about coverage. Two amendments:

### 3a. Escalate on soft failure, not just hard failure
A **soft failure** is when the tool works perfectly and returns something that doesn't answer the question. It looks identical to success and is where almost every bad answer comes from. Escalate triggers:
- Results returned, none match the **Qualifier** (found singles, asked for 10-packs)
- Results returned, none match the **Geography** (national listing, asked local)
- Fewer than two independent sources agree on a load-bearing claim
- About to write any negative or absence claim
- **Done when** row not yet satisfied

### 3b. Cheapest escalation is a better query, not a bigger tool
Before climbing a rung, re-query the rung you're on:
- **Format:** `3/8 x 8`, `3/8-16 x 8`, `0.375 x 8`, `3/8in x 8in`
- **Vocabulary:** hex bolt / hex cap screw / machine bolt; HDG / hot-dip galvanized
- **Site-scoped:** `site:lowes.com "3/8" "8 in" galvanized hex bolt`. The general web index has the retailer's product page even when their own search won't return it. Direct fix for R1. Use every time an on-site search comes up empty.
- **Structured sources:** store locators, per-store inventory pages, distributor catalogs (Grainger, Fastenal, McMaster-Carr, Bolt Depot), spec standards (ASTM, ASME) to translate a colloquial description into the canonical part identity.

### 3c. The question's altitude sets the minimum rung
Cost-minimizing is right for reading an article, wrong for local availability. Per-store stock requires setting a store, which is interaction, which is the browser rung. If the question is local, the browser is not a last resort: it is the floor. Do not substitute a rung-1 answer for a rung-4 question.

## 4. Verify before you write
- **Two sources, or a hedge.** Any load-bearing claim gets a second source or an explicit confidence marker.
- **Re-read the original question.** Does your opening sentence answer THAT?
- **Hunt your own negatives.** For each "couldn't find", ask what you'd have to have missed, then spend one more query trying to find it.
- **Date it.** Prices and stock are perishable. Stamp when you checked.

## 5. Output contract

```
ANSWER: Confirmed at [stores with a matching row]. Not confirmed at [stores], call to check. [At the question's altitude.]

FINDINGS
| Source | What I found | Qualifier match | Where / stock | Price | Checked |
|--------|--------------|-----------------|---------------|-------|---------|

COULDN'T ESTABLISH
- [Source]: searched [terms], found [nothing / only X]. Their site search misses items, so it is worth a call to confirm. Store: [name, phone].

ASSUMPTIONS
- [anything filled in that the user didn't specify]
```

- Every named source gets a row, even "nothing found" (R5).
- **COULDN'T ESTABLISH is not optional and not a failure.** An answer with no uncertainty section usually hid its uncertainty.
- The ANSWER line begins with the word Confirmed. A qualifier does not rescue a banned opener: "Nobody I could verify" is still "Nobody". If you confirmed nothing, write "Confirmed at none of the [N] sources checked; not confirmed at [stores], call to check."
- The heading `COULDN'T ESTABLISH` appears verbatim whenever any named source lacks a confirmed row. The store phone number goes inside it, never in a trailing sentence.
- FINDINGS is the table above, one row per named source. A bullet list is not a table and does not count as rows; bullets go under the table if you need them.
- If you never reached the question's altitude, say that in the answer line.

## 6. Stopping criteria and budget
**Budget.** Per named source: at most two on-site queries and two site-scoped queries, then that source becomes a COULDN'T ESTABLISH row with its phone number. Per turn: at most 50 tool calls or about 20 minutes, whichever comes first. When either runs out, stop searching and write the answer with what is in hand. An unfinished row is honest; an hour-long turn is not.

Stop when **Done when** is satisfied, or named sources plus site-scoped fallbacks are exhausted. Do NOT stop because: the first plausible result appeared, a cheap rung returned something, or the formatting looks complete. A well-formatted confident answer is not evidence research was done.

## 7. Before you send
1. The ANSWER line begins with the word Confirmed and names stores; it does not start with "Nobody" or any universal negative.
2. The `COULDN'T ESTABLISH` heading is present if any named source lacks a confirmed row, with a phone number inside it.
3. Every row carries the date checked.

## Worked example: the Kelley bolt case (Sep 2026)
**Asked:** "Who carries 3/8 in. x 8 in. hot-dip galvanized hex bolts in packs of 10 or 25 in Leander or Cedar Park, TX, at local stores?"
**Bad run:** "The only true 10-pack is at Home Depot ($12.56). Nobody lists a 25-pack." Four failures: altitude (R4, answered price not local availability), universal negative (R2), dropped source (R5, Ace missing), soft failure uncaught (3a, Lowe's search returned singles, a Qualifier miss; a site-scoped re-query would have found the live listing).
**Good run:** a store-level table for Home Depot, Lowe's and Ace plus two or three fastener suppliers, each with qualifier match, store and stock, and the date checked, plus COULDN'T ESTABLISH for retailers whose sites came up empty after both on-site AND site-scoped search, with phone numbers.
