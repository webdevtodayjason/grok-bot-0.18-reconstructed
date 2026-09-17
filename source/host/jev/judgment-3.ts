import { askJev, type AskJevOptions, type JevReply } from "./client.js";
import { JUDGMENT_3_QUESTIONS } from "./questions.js";
import { recordJevDecision, type JevDecisionRow } from "./ledger.js";

/**
 * JEV-2, judgment 3: the claim check, run on the message that is about to reach the person.
 *
 * The second half of the Kelley failure was "nobody lists a 25-pack", written off two searches.
 * Evidence from N stores can never support a claim about everyone, so a universal negative is sent
 * back to be scoped whatever the evidence says; that rule is code, not a threshold, because the
 * tuned set had Jev calling such a claim supported at 0.85.
 */

export const UNIVERSAL_NEGATIVE_FLOOR = 0.7;
export const SUPPORT_CONFIDENCE_FLOOR = 0.9;
export const MAX_REFUSALS_PER_TURN = 2;
export const EVIDENCE_CHARS = 1_200;

export const SCOPE_REFUSAL =
  "This claim says nobody or no store has it. Scope it to the sources you checked, for example 'Confirmed at none of the N sources checked', then send again.";
export const SOFTEN_REFUSAL =
  "Soften this claim or search the missing source, then send again.";

/**
 * The markers are the lead's list, matched on word boundaries so that "none" does not fire inside
 * "nonetheless". Extraction is code and not a judgement: Jev is asked about a claim, never asked to
 * find one, because finding one is a counting job and this model does not count.
 */
const NEGATIVE_MARKERS = [
  /\bnobody\b/i,
  /\bno one\b/i,
  /\bnone\b/i,
  /\bno store\b/i,
  /\bnot available\b/i,
  /\bdoes not carry\b/i,
  /\bdoesn't carry\b/i,
  /\bdoesn't sell\b/i,
  /\bdoes not sell\b/i,
  /\bnot sold\b/i,
];

export function carriesNegativeMarker(sentence: string): boolean {
  return NEGATIVE_MARKERS.some((marker) => marker.test(sentence));
}

/**
 * Sentences carrying a negative, plus the ANSWER line whatever it says, because the answer line is
 * the sentence the person reads first and the one the research skill shapes.
 */
export function extractClaims(message: string): readonly string[] {
  const claims: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    const claim = candidate.trim();
    if (claim.length === 0 || seen.has(claim)) return;
    seen.add(claim);
    claims.push(claim);
  };
  for (const line of message.split(/\r?\n/)) {
    if (/^\s*ANSWER\s*:/i.test(line)) add(line);
  }
  // Sentence-ish: a full stop, question mark or newline ends one. Bullets count as their own line.
  for (const sentence of message.split(/(?<=[.!?])\s+|\r?\n/)) {
    if (carriesNegativeMarker(sentence)) add(sentence.replace(/^\s*[-*]\s*/, ""));
  }
  return claims;
}

export interface JevEvidence {
  readonly source: string;
  readonly text: string;
}

/** Keeps the domain and trims the body, because Jev loses accuracy on distracting state. */
export function trimEvidence(evidence: JevEvidence): JevEvidence {
  const flat = evidence.text.replace(/\s+/g, " ").trim();
  return {
    source: evidence.source,
    text: flat.length > EVIDENCE_CHARS ? `${flat.slice(0, EVIDENCE_CHARS)} ...` : flat,
  };
}

export type JevClaimAction = "scope" | "soften" | "pass";

export interface JevClaimVerdict {
  readonly action: JevClaimAction;
  readonly refusal?: string;
  /** What the ledger records, and what the console chip says in plain words. */
  readonly question: string;
  readonly answer: string;
  readonly confidence: number;
}

/**
 * The code rule. Read it as: everyone-claims are always sent back, and everything else has to be
 * positively supported at high confidence to go out unchanged.
 */
export function judgeClaim(reply: JevReply): JevClaimVerdict {
  const universal = reply.answers.is_universal_negative;
  if (universal !== undefined && universal.type === "noul" && universal.noul >= UNIVERSAL_NEGATIVE_FLOOR) {
    return {
      action: "scope",
      refusal: SCOPE_REFUSAL,
      question: "is_universal_negative",
      answer: "true",
      confidence: universal.noul,
    };
  }
  const support = reply.answers.support;
  if (support !== undefined && support.type === "choice"
    && support.choice === "supports" && support.confidence >= SUPPORT_CONFIDENCE_FLOOR) {
    return { action: "pass", question: "support", answer: support.choice, confidence: support.confidence };
  }
  return {
    action: "soften",
    refusal: SOFTEN_REFUSAL,
    question: "support",
    answer: support !== undefined && support.type === "choice" ? support.choice : "no answer",
    confidence: support !== undefined && support.type === "choice" ? support.confidence : 0,
  };
}

/** Per-turn state: how many times this turn has already been sent back. */
export interface JevRefusalCounter {
  refusals: number;
}

export function createJevRefusalCounter(): JevRefusalCounter {
  return { refusals: 0 };
}

export interface ClaimCheckInput {
  readonly agentId: string;
  readonly turnId: string;
  readonly message: string;
  readonly evidence: readonly JevEvidence[];
  readonly sourcesChecked: readonly string[];
  readonly sourcesNamedInRequest: readonly string[];
  readonly counter: JevRefusalCounter;
}

export interface ClaimCheckOutcome {
  /** Set when the send must be refused; the text is what the model reads as the tool error. */
  readonly refusal?: string;
  readonly decisions: readonly JevDecisionRow[];
}

/**
 * Checks the claims in one outgoing message. Refuses at most twice per turn: after that the message
 * goes out as written and the ledger says it was allowed because the turn had spent its refusals,
 * because a model that cannot satisfy the judge on the third try is a model that will never send,
 * and silence is worse than a claim that is too strong.
 */
export async function runClaimCheck(
  input: ClaimCheckInput,
  options: AskJevOptions = {},
): Promise<ClaimCheckOutcome> {
  const claims = extractClaims(input.message);
  if (claims.length === 0) return { decisions: [] };

  const evidence = input.evidence.map(trimEvidence);
  const decisions: JevDecisionRow[] = [];
  for (const claim of claims) {
    const spent = input.counter.refusals >= MAX_REFUSALS_PER_TURN;
    const reply = await askJev({
      claim,
      evidence,
      sources_checked: input.sourcesChecked,
      sources_named_in_request: input.sourcesNamedInRequest,
    }, JUDGMENT_3_QUESTIONS, options);
    // Timeout, refusal or an answer we cannot read: the message goes through unchanged.
    if (reply === undefined) continue;

    const verdict = judgeClaim(reply);
    const action = verdict.action === "pass"
      ? "sent"
      : spent
        ? `${verdict.action} not enforced, the turn had spent its ${MAX_REFUSALS_PER_TURN} refusals`
        : `sent back to ${verdict.action}`;
    decisions.push(await recordJevDecision(input.agentId, {
      turnId: input.turnId,
      judgment: 3,
      question: verdict.question,
      answer: verdict.answer,
      confidence: verdict.confidence,
      action,
      model: reply.model,
      latencyMs: reply.latencyMs,
    }));
    if (verdict.action === "pass" || spent) continue;
    input.counter.refusals += 1;
    return { refusal: verdict.refusal, decisions };
  }
  return { decisions };
}
