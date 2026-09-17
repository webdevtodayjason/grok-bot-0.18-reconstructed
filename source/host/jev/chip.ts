import { currentJevTurn } from "./turn-state.js";
import type { JevDecisionRow } from "./ledger.js";

/**
 * JEV-2. What the console says about a judged message: one quiet sentence and the decision it is
 * about, stamped onto the transcript entry the same way the evidence verdict is.
 *
 * Plain words, no prefix, no condition name and no percentage sign standing on its own, because a
 * prefixed line under a reply reads as an error to the person whose business this is
 * (host-notes-read-as-errors). "Judged" is the strongest word here on purpose.
 */

export interface JevChip {
  readonly text: string;
  readonly decisionId: string;
}

const SCOPE_WORDS: Readonly<Record<string, string>> = {
  local_in_store: "local stock question",
  online_ship: "online ordering question",
  national_price: "general price question",
  informational: "question about the item itself",
  unclear: "question this could not place",
};

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** The claim that was sent back matters more than the reading of the request, so it wins. */
export function describeJevDecisions(decisions: readonly JevDecisionRow[]): JevChip | undefined {
  const sentBack = [...decisions].reverse().find((row) => row.judgment === 3 && row.action.startsWith("sent back to "));
  if (sentBack !== undefined) {
    const how = sentBack.action === "sent back to scope" ? "be scoped" : "be softened";
    return { text: `Claim sent back to ${how}`, decisionId: sentBack.id };
  }
  const scope = decisions.find((row) => row.judgment === 1 && row.question === "scope" && row.action === "stated");
  if (scope !== undefined) {
    const words = SCOPE_WORDS[scope.answer] ?? "question";
    return { text: `Judged: ${words}, ${percent(scope.confidence)}`, decisionId: scope.id };
  }
  const unread = decisions.find((row) => row.judgment === 1 && row.question === "scope");
  if (unread !== undefined) {
    return { text: "Judged: scope not determined", decisionId: unread.id };
  }
  return undefined;
}

/**
 * Transcript store hook, beside `withEvidence`. Stamps in place for the same reason that one does:
 * the live session serves this object from memory, so a copy would leave the console blind.
 */
export function withJevChip<T extends object>(agentId: string, entry: T): T {
  const e = entry as { kind?: string; message?: { type?: string }; jev?: unknown };
  if (e.kind !== "send-message" || e.jev != null || e.message?.type !== "text") return entry;
  const turn = currentJevTurn(agentId);
  if (turn === undefined || turn.decisions.length === 0) return entry;
  const chip = describeJevDecisions(turn.decisions);
  if (chip !== undefined) e.jev = chip;
  return entry;
}
