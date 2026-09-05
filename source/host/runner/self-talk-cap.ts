import { SAND_SEND_MESSAGE_TOOL_NAME } from "./send-message-reminder-middleware.js";

/**
 * A cap on an agent that only talks to itself.
 *
 * Measured on the R750: with one model an agent emitted about fifty steps in ten minutes whose
 * only tool call was SendMessage ("Standing by", "Over and out"), each one a fresh model call
 * that changed nothing, until the container was restarted. There is no interrupt on the gateway
 * and the runner's step ceiling is five thousand, so nothing between the model and the wallet
 * could stop it.
 *
 * The rule is deliberately narrow so a real multi-message answer still gets through: only steps
 * whose sole tool calls are SendMessage count, any other tool call clears the streak, and a
 * result that carries something new clears it too. A legitimate answer ends on its own long
 * before the cap; a loop does not end at all.
 */

/** The name an operator writes into sand-host-settings.json (or the container env). */
export const SAND_SELF_TALK_CAP_SETTING = "SAND_SELF_TALK_CAP";

export const DEFAULT_SELF_TALK_CAP = 5;

export const SELF_TALK_CAP_NOTICE =
  "This turn was ended by the self-talk cap: the agent kept messaging with nothing new, no other tool ran and no new result came back.";

export interface SelfTalkStep {
  /** The tool names called in this model step, in order. Empty when the step called nothing. */
  readonly toolNames: readonly string[];
  /** The rendered text of this step's tool results, in order. */
  readonly resultTexts: readonly string[];
}

export interface SelfTalkVerdict {
  /** True once the streak has reached the cap and the turn must stop. */
  readonly ended: boolean;
  /** How long the current self-talk streak is, counting this step. */
  readonly steps: number;
  /** The cap in force for this step. Zero means the cap is off. */
  readonly cap: number;
}

export interface SelfTalkCap {
  noteStep(step: SelfTalkStep): SelfTalkVerdict;
}

/**
 * Zero (or a negative number) disables the cap outright, which is the escape hatch for an
 * operator who wants a long narrated run. Anything unparseable means the operator typed
 * something wrong, and silently running uncapped is the worse failure, so it falls back to the
 * default rather than to off.
 */
export function resolveSelfTalkCap(raw: string | undefined): number {
  if (raw == null) return DEFAULT_SELF_TALK_CAP;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_SELF_TALK_CAP;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SELF_TALK_CAP;
  return parsed <= 0 ? 0 : parsed;
}

/**
 * A step is self-talk when it spoke and did nothing else. A step with no tool call at all also
 * counts: on this runner that ends the turn anyway, so counting it can only make the streak end
 * sooner, never later.
 */
export function isSelfTalkStep(step: SelfTalkStep): boolean {
  return step.toolNames.every((name) => name === SAND_SEND_MESSAGE_TOOL_NAME);
}

/**
 * SendMessage hands back "Message sent to user. (id: ...)" and the id is fresh every time, so a
 * byte comparison would call every ack new information and the cap would never fire. The id
 * identifies the message; it tells the model nothing it did not already know.
 */
export function normalizeSelfTalkResult(text: string): string {
  return text.replace(/\(id:[^)]*\)/g, "(id)");
}

export function createSelfTalkCap(input: {
  /** Read live, per step, so an operator can change the cap on a running box. */
  readonly readCap: () => number;
  readonly onCapReached: (verdict: SelfTalkVerdict) => void;
}): SelfTalkCap {
  let steps = 0;
  let lastResults: string | undefined;
  let reported = false;
  return {
    noteStep(step) {
      const cap = input.readCap();
      if (cap <= 0) {
        steps = 0;
        lastResults = undefined;
        return { ended: false, steps: 0, cap: 0 };
      }
      if (!isSelfTalkStep(step)) {
        steps = 0;
        lastResults = undefined;
        return { ended: false, steps: 0, cap };
      }
      const results = step.resultTexts.map(normalizeSelfTalkResult).join(" ");
      steps = steps > 0 && results !== lastResults ? 1 : steps + 1;
      lastResults = results;
      const verdict = { ended: steps >= cap, steps, cap };
      if (verdict.ended && !reported) {
        reported = true;
        input.onCapReached(verdict);
      }
      return verdict;
    },
  };
}
