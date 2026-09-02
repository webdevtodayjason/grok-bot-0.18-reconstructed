# Evidence Contract — receipts, attestation, provenance

**Status: armed 2026-09-02 03:23Z, implemented in `29d9ef7`, acceptance measured (see
`PLUMBING-AUDIT.md` §6m).** Written 2026-09-01 for Jason's review, executed the same night with his go. This is an
extension beyond Grok Bot, not a reconstruction fix: upstream never enforced this invariant either
(`PLUMBING-AUDIT.md` §6l). It relied on a frontier model and on tool-call rows rendered next to the
replies. The local model exposed that assumption; it did not break anything that existed.

**The requirement, verbatim:** *The model may make claims. The system decides whether those claims
are evidenced.*

## 1. What this fixes

On 2026-09-01 the long-lived agent on the Spark's 30B model ran `ls -1 /workspace`, got
`grokbot-verify-hvtewbsc.txt`, and reported `grokbot-verify-x1ipm3y.txt`. The next round it ran the
tool again, got `grokbot-verify-cfrl743s.txt`, and reported `x1ipm3y` again. Both rounds counted as
finished work. Nothing in the host compares a delivered message to a tool result: the delivered
message carries no request id and no pointer to any execution; the completion checks test speech
and tool order; the action-audit ledger records invocations but not results, carries no turn id on
main-agent shell records, and has no reader (§6k).

After this contract, every delivered message carries a verdict the system computed from records the
model never wrote: `evidenced`, `unsupported`, `unverified`, or `conversational`. The message is still
delivered. The verdict is what changes: it is visible in the Machine Room, readable through the
gateway, and required by the work-report gate.

## 2. Three concepts, kept separate

| Concept | Question it answers | Record | Written by | Read by |
|---|---|---|---|---|
| **Execution receipt** | Did the tool actually run, during *this* attempt? | ledger record with `turnId`, `turnEpoch`, `toolCallId` | action-audit, at the existing call sites | verdict, gate, gateway |
| **Result attestation** | What did that execution actually return? | ledger record `tool_result`: `sha256`, `bytes`, `head`, `ok`, `exitCode` | the one point that packages a tool result back to the model | verdict, gate, gateway |
| **Claim provenance** | Is the fact being reported supported by that result? | `evidence` stamp on the `send-message` transcript entry, with a verdict | the send pipeline, calling a pure verdict module | Machine Room pill, gate, gateway |

Rules that keep them separate:

- A receipt without an attestation proves invocation only. An attestation without a claim check
  proves what came back. Provenance is decided only from the two layers below it.
- No layer reads the model's prose to decide the layers below it. Receipts and attestations are
  written by the host at execution time, from the executor's own data.
- Each layer is useful alone and ships alone (section 7).

## 3. Architecture

### 3.1 Attempt identity, the nonce

`turnId` is the request id the host already tracks per prompt (`runLifecycle.lastRequestIdBySession`).
`turnEpoch` is the send pipeline's epoch for the session (`sendPipeline.currentTurnEpoch`), which
moves on redrives. The pair names one attempt. Everything written during the attempt carries both.
A receipt or attestation from an earlier attempt never satisfies this attempt's check, which is the
"during this attempt, not earlier" requirement.

### 3.2 Execution receipt

Where: the existing `actionAuditor.record` call sites. The main-agent shell site is
`host-runner-composition.ts:1017`; MCP, browser and computer-use sites follow the same shape.
Change: add `turnId`, `turnEpoch`, `toolCallId` to the record. Add one new record type,
`file_read`, at the Read tool's call site, because reads are the other way a fact enters a reply.
Subagent receipts keep their `subagent:<callId>` marker and gain the parent's attempt fields.

### 3.3 Result attestation

Where: the single point where a tool's result is packaged back into the model's context (the tool
executor path in `sand-agent-runner.ts` / `tool-stream-executor.ts`). This covers every tool,
including Task (a subagent's result) and MCP, with one interception.

Record: `{type:"tool_result", agentId, eventId, ts, turnId, turnEpoch, toolCallId, tool, ok,
exitCode?, bytes, sha256, head, truncated}`. `head` is the first 8 KB of the result text;
`sha256` is over the full text. The full output stays in prompt state exactly as today. The ledger
holds the digest and the head, which is enough to check a claim and small enough to keep forever.

### 3.4 Claim provenance

A pure module, `evidence-verdict.ts`, tested against the fixture in section 6. Inputs: the message
text, this attempt's attestations, and the user prompt for the attempt. Output: a verdict and the
list of tokens it could not find.

Evidence-bearing tokens are the parts of a message that assert something a tool would have
produced: file names with an extension, absolute paths, URLs, hex strings of eight or more
characters, and numbers of three or more digits. Tokens that also appear in the user's prompt are
removed first; the user said them, the model did not observe them.

| Verdict | Condition |
|---|---|
| `conversational` | No evidence-bearing tokens remain. Nothing to check. |
| `unverified` | Tokens remain and the attempt has no attestation at all. |
| `unsupported` | Attestations exist and at least one token appears in none of their heads. |
| `evidenced` | Every remaining token appears verbatim in some attestation head. |
| `undecidable` | A token is missing but some head was truncated, so it may sit past the cut. Reported as such, never as `unsupported`. |

The check is literal containment, versioned as `checkedBy: "containment@1"`, so a stronger rule can
replace it later without touching the records. It is not an LLM judge and this contract does not
add one.

Where stamped: the `send-message` writer (`roster-projection.ts:448`) attaches
`evidence: {turnId, turnEpoch, receipts: [eventId], attestations: [eventId], verdict, missing,
checkedBy}` to the entry it already writes.

**Policy: label, never suppress.** The message is delivered exactly as today. Withholding it would
recreate the silent-agent failure fixed in `707bc21` and would hide from the operator the very
message they need to see next to its verdict.

### 3.5 Surfaces

- Gateway: one read-only command, `getAgentEvidence {id, turnId?}`, returning receipts,
  attestations and the verdict-bearing messages for an agent or one attempt. The relay passes any
  command through, so no relay change.
- Machine Room: the adapter renders one `system` pill after an `unverified` or `unsupported`
  message, for example `Evidence: unsupported · grokbot-verify-x1ipm3y.txt is in no tool result
  this attempt`. `app.js` and the stylesheets stay untouched, per the handoff rule.
- Gate: `verify-work-report --require-evidence` passes a round only when the delivered message's
  verdict is `evidenced` and the sentinel appears in an attestation head from this attempt. The
  sentinel stops being the proof; the receipt is.

### 3.6 Traceability to the five verifier requirements

| Requirement | Field that carries it |
|---|---|
| The required tool was actually invoked | receipt record exists for the attempt |
| During this attempt, not earlier | receipt `turnId` + `turnEpoch` equal the message's |
| The returned result is the source of the reported fact | attestation `head` contains the tokens |
| The report cannot pass without evidence | verdict must be `evidenced` for the gate to pass |
| A nonce ties observation to the round | `turnId` + `turnEpoch` on every record and the stamp |

## 4. Schema changes, all additive

- Ledger (`agents/<id>/audit.jsonl`): every record gains `turnId`, `turnEpoch`, `toolCallId`. Two
  new record types: `tool_result` (3.3) and `file_read`.
- Transcript: the `send-message` payload gains `evidence` (3.4). The payload is JSON in SQLite, so
  no DDL change.
- Gateway: one new command, `getAgentEvidence`, registered in `gateway-protocol.ts` and
  `host-gateway-api.ts`.
- Unchanged: protobufs, the outline shape, the system prompt, tool execution semantics, message
  delivery.

Example receipt and attestation for the recorded round 1:

```json
{"type":"shell_command","agentId":"28c1383e-…","eventId":"e1","ts":"2026-09-02T01:47:49.824Z",
 "turnId":"req-…","turnEpoch":267,"toolCallId":"call-…","command":"ls -1 /workspace","shellKind":"foreground","target":"box"}
{"type":"tool_result","agentId":"28c1383e-…","eventId":"e2","ts":"2026-09-02T01:47:50.1Z",
 "turnId":"req-…","turnEpoch":267,"toolCallId":"call-…","tool":"Shell","ok":true,"exitCode":0,
 "bytes":63,"sha256":"…","head":"grokbot-verify-hvtewbsc.txt\nproof-1788287229.txt\nteach-sessions\n","truncated":false}
```

And the stamp on the message that followed:

```json
{"kind":"send-message","id":"…","timestampMs":1788313681000,"message":{"type":"text","content":"grokbot-verify-x1ipm3y.txt\nproof-1788287229.txt\nteach-sessions"},
 "evidence":{"turnId":"req-…","turnEpoch":267,"receipts":["e1"],"attestations":["e2"],"verdict":"unsupported","missing":["grokbot-verify-x1ipm3y.txt"],"checkedBy":"containment@1"}}
```

## 5. Compatibility impact

- **Existing rows and records.** Anything written before the feature has no `evidence` and no
  attempt fields. Readers treat that as *pre-evidence*: no verdict, no pill, never reported as
  `unverified`. Nothing is rewritten or migrated.
- **Upstream desktop client.** Ignores the additive fields. `OutlineItem` is unchanged.
- **Cursor forward.** `sand_action_audit_logs` is off here. When it is on, the forwarder must keep
  its explicit field mapping and must never forward `tool_result` heads, which can contain secrets
  from tool output. This is an acceptance check, not an assumption.
- **Compaction.** Receipts and attestations live in the ledger, not prompt state, so they survive
  compaction. This is the durability the outline rows (§6l) cannot offer.
- **Subagents.** A subagent's result reaches the parent as a Task result, which is attested like any
  other, so parent-level provenance works without reading the subagent's own ledger.
- **Cost.** One JSONL append and one SHA-256 per tool result; heads bounded at 8 KB; no extra model
  calls; no change to turn latency worth measuring.
- **Local and frontier models.** Identical path. The verdict never depends on which model spoke.
- **Security.** The ledger already sits in the agent's own directory inside the box; heads make it
  more sensitive, so the file is written `0600` and is readable only through the authenticated
  gateway.

## 6. Regression coverage: the exact Nemotron failure

The recorded rounds are preserved in `docs/evidence/nemotron-fabrication-2026-09-02.json`, captured
tonight from the live agent's outline, transcript and ledger before compaction could rewrite the
outline. Three cases:

1. **Recorded round 1, invented.** On disk `grokbot-verify-hvtewbsc.txt`; the tool ran (ledger
   01:47:49Z); reported `grokbot-verify-x1ipm3y.txt`, a name that appears in no tool output
   anywhere in the agent's state. Expected verdict: `unsupported`.
2. **Recorded round 2, repeated.** On disk `grokbot-verify-cfrl743s.txt`; the tool ran (ledger
   01:51:51Z); reported `x1ipm3y` again. Expected verdict: `unsupported`.
3. **Control, grok-4.6.** On disk and reported `grokbot-verify-ph16c2kh.txt`. Expected verdict:
   `evidenced`.

**Stated plainly:** both recorded rounds are the same failure mode, *tool ran, result ignored*. The
second mode, *no tool ran, the model parroted a previous fabrication*, was never observed. My first
reading of the ledger said it was; the cross-check against the outline corrected that (§6k). It is
still a mode the design must catch, so it is covered as a **constructed** case built from the same
strings, and labelled as constructed in the tests.

Two levels of test, both deterministic and model-free:

- **Unit.** `tests/evidence-verdict.test.mjs` runs the verdict module over the fixture: cases 1 and
  2 give `unsupported` with `missing == ["grokbot-verify-x1ipm3y.txt"]`; the constructed case gives
  `unverified`; the control gives `evidenced`; a pre-evidence entry gives no verdict.
- **Live replay.** `scripts/verify-evidence-replay.mjs` reuses the in-box proxy from
  `verify-compaction` but answers as the provider instead of forwarding. Round 1: a `tool_call` for
  `ls -1 /workspace`, then, ignoring the real result, a SendMessage with the recorded `x1ipm3y`
  listing. Round 2: the same SendMessage with no tool call, the constructed case. Round 3: the tool
  call, then an echo of the real result. The real host executes the real shell. Expected stamps on
  the three delivered messages: `unsupported`, `unverified`, `evidenced`. Runs in about 90 seconds,
  inside the warden's 300-second ceiling.

## 7. Smallest migration path

Each step ships and verifies alone; none depends on a later one.

| Step | Change | Files | Proof |
|---|---|---|---|
| 0 | Fixture captured (done tonight, data only) | `docs/evidence/…json` | file exists, three cases |
| 1 | Receipts keyed to the attempt: `turnId`, `turnEpoch`, `toolCallId` at the audit call sites; `file_read` receipt | 2 | unit test on the record shape; live: one `ls` turn leaves a receipt with the turn's request id |
| 2 | Attestation at the result-return point | 1–2 | after one `ls` turn a `tool_result` record's `sha256` equals the hash of the outline's output |
| 3 | Verdict module, stamp on `send-message`, Machine Room pill | 3 | unit fixture verdicts; live replay stamps |
| 4 | `getAgentEvidence`, `--require-evidence` on the gate, replay script | 3 | gate passes on grok-4.6 with `evidenced`; fails on the replay with `unsupported` |

Twelve files at most, about a day and a half, behind the existing ledger and send pipeline.

## 8. Hygiene, deliberately outside this contract

A 64K behavioural context window for local models, `SAND_OPENAI_COMPATIBLE_CONTEXT_WINDOW=64000` on
the Spark endpoint, is an operator setting that already works (§6j). It lowers how often a degraded
context produces this behaviour. It is not a governance control, it is not in this contract's
acceptance or budget, and its file tree is a named non-goal below so the two cannot blur.

## 9. Locked contract, ready to paste

```
=== LOCKED CONTRACT ===
GOAL: Every delivered agent message carries a system-computed evidence verdict, derived from
execution receipts and result attestations the host wrote at execution time, so that a report
which no tool result supports is labelled unsupported or unverified and cannot pass the
work-report gate.
ACCEPTANCE:
  - the verdict module decides the recorded Nemotron rounds and the constructed no-tool case: `node --test tests/evidence-verdict.test.mjs`
  - the live replay stamps unsupported, unverified, evidenced on three real turns: `node scripts/verify-evidence-replay.mjs`
  - the work-report gate passes only on evidence: `node scripts/verify-work-report.mjs --rounds 2 --require-evidence`
  - the existing suite is untouched: `node tests/index.js`
  - the local turn still turns: `node scripts/verify-local-turn.mjs --rounds 1`
  - pre-evidence rows are untouched and no attestation head is forwarded: `node scripts/verify-evidence-replay.mjs --compat`
NON-GOALS:
  - `source/host/runner/system-prompt.ts` (no prompt-level fix; the model may make claims)
  - `source/host/extensions/inference/**` (the 64K window is hygiene, tracked separately)
  - `ui/machine-room/app.js` and `ui/machine-room/styles.css` (handoff rule)
  - the completion checks in `source/host/extensions/transcript/turn-runtime.ts`
  - any message suppression, redrive, or retry on a bad verdict
  - any LLM judge; containment@1 is the only rule in this round
  - protobuf changes; the outline shape
BUDGET: ≤12 files, ~1.5 days, behind the existing action-audit ledger and send pipeline.
TRIPWIRE: At the budget, or if the attestation point turns out not to be single (more than one
place packages tool results), or if any change to tool execution or delivery semantics tempts:
STOP and report before continuing. No grinding, no gold-plating.
DISPOSITION: Before declaring done, emit DISPOSITION LOG — every condition encountered (failing
test, error, stub/FIXME/TODO, dead code, stale doc, type debt), each closed with one of:
[FIXED] / [FIXED_NOW] / [VERIFIED_CLOSED] (resolved now, with evidence),
[DEFERRED_NONBLOCKING] (does not block this goal AND filed with Owner + Next + Proof),
[OPERATOR_BLOCKED] (requires human access/decision; Owner + Next + Proof), or
[FALSE_POSITIVE]/[HISTORICAL_FALSE_POSITIVE] (witness matched noise/history, explain why).
If the gate blocks and lists witness keys, each closing line must contain the condition's
key AND its tag on the same line. [OWNED] is NOT a final disposition. Empty log is legal ONLY
if nothing was encountered.
RULES: Restate this contract before the first action. Check every step against GOAL +
NON-GOALS. Report against ACCEPTANCE at the budget and before declaring done. Emit the
DISPOSITION LOG as the last action before done — done is not claimable without it.
=== Work only to this contract. ===
```

Notes for arming: `verify-work-report --require-evidence` needs the box on grok-4.6 or a fresh
local agent to pass honestly; on the long-lived Spark agent it is expected to fail, which is the
point. All acceptance gates share the one box and must run sequentially.

## 10. As built (2026-09-02), where it differs from the draft

- **Nonce.** The registry mints `attemptId` when the send pipeline moves the turn epoch; every
  receipt, attestation and stamp carries `attemptId` + `turnEpoch`. `turnId` (the request id) is
  assigned inside `turn-runtime.ts`, a named non-goal, so it is left unset rather than reached for.
- **Stamp site.** The transcript store (`agent-db.ts`, `appendTranscriptEntry`) stamps in place,
  not the outline appender the draft named: that appender builds outline items, and the agent's
  entry is written from `turn-runtime.ts`. In place, because the active session serves the same
  object from memory. The store also records the latest user prompt for the token filter.
- **Attestation site.** `withAttestedResult` in `turn-toolset.ts`, applied where the toolset is
  finalised, so Read, Task, MCP, browser and computer results are attested through one wrapper; no
  separate `file_read` receipt was needed. Non-work tools (SendMessage, communicate, update_state,
  todo, sleep, wait) are skipped so a sent message never counts as evidence for the next claim.
- **Tokens.** Bare numbers need five digits, hex twelve, and file names need a known extension, so
  a version like `grok-4.6` or a year is not a claim. Rule name unchanged: `containment@1`.
- **Gateway.** `getAgentEvidence {id, attemptId?}` is implemented in `host-gateway-api.ts` directly
  over the session store and the ledger file; no manager registry entry.
- **Budget.** Sixteen files against the twelve the draft estimated; reported in §6m of the audit.
