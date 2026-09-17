import { askJev, noulConfidence, noulValue, type AskJevOptions, type JevReply } from "./client.js";
import { JUDGMENT_1_QUESTIONS } from "./questions.js";
import { recordJevDecision, type JevDecisionRow } from "./ledger.js";

/**
 * JEV-2, judgment 1: what did the person actually ask for.
 *
 * The Kelley failure was altitude before it was anything else: a local availability question came
 * back as one national price. This reads the request before the first step and writes the
 * constraints down where the model cannot skip them, and it never rewrites the person's words --
 * their text is untouched and this is appended after it as a host note.
 */

/** The one setting that says where this workspace sits, when its owner has set one. */
export const SAND_WORKSPACE_LOCATION_SETTING = "SAND_WORKSPACE_LOCATION";

const QUESTION_OPENERS = ["who", "what", "where", "which", "how", "is", "are", "can", "does", "do"];

/**
 * Cheap and deliberately so. Jev is not asked whether something is a question, because a request
 * that is not a question costs a call to find that out, and the whole judgement is advisory: the
 * cost of missing one phrasing is that a turn behaves exactly as it does today.
 */
export function readsAsQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith("?")) return true;
  const firstWord = trimmed.toLowerCase().split(/[^a-z']+/).find((word) => word.length > 0);
  return firstWord !== undefined && QUESTION_OPENERS.includes(firstWord);
}

/** The line each noul contributes, in the person's own terms rather than the question id. */
const NOUL_LINES: Readonly<Record<string, string>> = {
  names_stores: "the request names specific stores: respect them and report on every one",
  names_location: "the request names a place: answer for that place, not nationally",
  names_quantity: "the request states a quantity or pack size: every result has to match it or be marked unmatched",
  substitutes_ok: "the request allows a substitute size, finish or pack",
};

const SCOPE_LINES: Readonly<Record<string, string>> = {
  local_in_store: "the person wants to know which physical stores near them have it now",
  online_ship: "the person wants to know where it can be ordered and shipped",
  national_price: "the person wants to know what it costs in general",
  informational: "the person wants to understand the item, not to be told where to buy it",
  unclear: "the request does not say enough to tell what is wanted",
};

export interface JevConstraintsNote {
  readonly text: string;
  readonly lines: readonly string[];
  readonly decisions: readonly JevDecisionRow[];
}

/**
 * Renders the answer at the confidence it was given and never above it.
 *
 * Scope is stated only at 0.9 and above; anything less says so in words, because a scope this is
 * unsure of is exactly the guess that produced the original failure. A noul is a hard constraint at
 * 0.9 and above, hedged between 0.7 and 0.9, and dropped below 0.7. A false noul contributes
 * nothing: the absence of a constraint is not a constraint, and writing "no stores are named"
 * beside a confident line reads as an instruction rather than as silence.
 */
export function renderConstraintsNote(reply: JevReply): readonly string[] {
  const lines: string[] = [];
  const scope = reply.answers.scope;
  if (scope !== undefined && scope.type === "choice" && scope.confidence >= 0.9) {
    lines.push(SCOPE_LINES[scope.choice] ?? `the request is a ${scope.choice} question`);
  } else {
    lines.push("scope: not determined, do not assume");
  }
  for (const [question, sentence] of Object.entries(NOUL_LINES)) {
    const answer = reply.answers[question];
    if (answer === undefined || answer.type !== "noul") continue;
    if (!noulValue(answer.noul)) continue;
    const confidence = noulConfidence(answer.noul);
    if (confidence >= 0.9) lines.push(sentence);
    else if (confidence >= 0.7) lines.push(`likely: ${sentence}`);
  }
  return lines;
}

export function constraintsNoteText(lines: readonly string[]): string {
  return [
    "<system_reminder>",
    "What the person asked for, read before you start. These are constraints on the answer, not a rewrite of their words.",
    ...lines.map((line) => `- ${line}`),
    "</system_reminder>",
  ].join("\n");
}

export interface RequestInterpretationInput {
  readonly agentId: string;
  readonly turnId: string;
  readonly request: string;
  readonly workspaceLocation?: string;
}

/**
 * The whole judgement, start to finish. Returns `undefined` when there is nothing to say, which is
 * every failure and also a request that does not read as a question.
 */
export async function runRequestInterpretation(
  input: RequestInterpretationInput,
  options: AskJevOptions = {},
): Promise<JevConstraintsNote | undefined> {
  if (!readsAsQuestion(input.request)) return undefined;
  const state = input.workspaceLocation === undefined
    ? { request: input.request }
    : { request: input.request, workspace_location: input.workspaceLocation };
  const reply = await askJev(state, JUDGMENT_1_QUESTIONS, options);
  if (reply === undefined) return undefined;

  const lines = renderConstraintsNote(reply);
  const decisions: JevDecisionRow[] = [];
  for (const [question, answer] of Object.entries(reply.answers)) {
    const confidence = answer.type === "noul" ? noulConfidence(answer.noul) : answer.confidence;
    const value = answer.type === "noul" ? String(noulValue(answer.noul)) : answer.choice;
    const stated = answer.type === "noul"
      ? (noulValue(answer.noul) && confidence >= 0.7 ? (confidence >= 0.9 ? "stated" : "stated as likely") : "omitted")
      : (confidence >= 0.9 ? "stated" : "not determined");
    decisions.push(await recordJevDecision(input.agentId, {
      turnId: input.turnId,
      judgment: 1,
      question,
      answer: value,
      confidence,
      action: stated,
      model: reply.model,
      latencyMs: reply.latencyMs,
    }));
  }
  return { text: constraintsNoteText(lines), lines, decisions };
}
