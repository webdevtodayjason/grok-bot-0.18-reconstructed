// UX-ERR-1. A turn that ends in an error must say so on the conversation.
//
// Jason, 2026-09-07 08:04: "I said something to Titan and it popped up like he was talking, then it
// went away. I don't see any errors." That is what a failed run looked like: the message marked
// accepted, no reply, no chip, no note, and the only record of it in the host log on a machine he
// was not reading. The tray error existed and the console does not show it; the transcript entry
// this file builds is the thing a person actually sees.
//
// TWO RULES ABOUT THE COPY, and they are the whole reason this is a module rather than a string at
// the call site. First, plain words: the person reading it is being told their assistant did not
// answer, and `ERR_SQLITE_ERROR` or a class name tells them nothing they can act on. Second, no
// stack: whatever the provider or the store said goes to the log, and the line on the page carries
// only the cause in a sentence and the two things worth doing next.
import {
  isContextOverflowDeadEnd,
  isConversationTooLargeRefusal,
  isFirstTokenStallError,
  isProviderCapacityError,
  isRetryableProviderError,
  isTransientStreamError,
} from "../../runner/transient-stream-error.js";
import { isSqliteCorruptError } from "../../storage/sqlite-busy.js";
// findBackendConnectError rather than connectCodeOf: the code lives in turn-runtime.ts, which
// imports this file, and a cycle between the two would be a fragile way to answer the same
// question. "The error came back from the backend" is what both are really asking.
import { findBackendConnectError } from "./agent-run-error.js";

export const TURN_FAILED_ENTRY_KIND = "turn-failed";

// One clause each, lower case, no full stop: they are dropped into the sentence below.
export function plainWordsForTurnFailure(error: unknown): string {
  // BOX-6 first, because it is the failure this row was written about and it is the one an
  // operator can actually fix. The gap row names this wording.
  if (isSqliteCorruptError(error)) return "the conversation store needs repair";
  if (isProviderCapacityError(error)) return "the model is busy right now";
  if (isFirstTokenStallError(error)) return "the model went quiet before it said anything";
  if (isContextOverflowDeadEnd(error) || isConversationTooLargeRefusal(error)) {
    return "this conversation got too long for the model";
  }
  if (isTransientStreamError(error)) return "the connection to the model dropped part way through";
  if (isRetryableProviderError(error)) return "the model did not answer";
  if (findBackendConnectError(error) != null) return "the model refused the request";
  return "something went wrong on the way to an answer";
}

export function turnFailedText(agentName: string | undefined, error: unknown): string {
  const who = (agentName ?? "").trim().length > 0 ? agentName!.trim() : "This agent";
  return `${who} could not answer this one: ${plainWordsForTurnFailure(error)}. Try again, or open the host log.`;
}

export interface TurnFailedEntryInput {
  readonly agentName?: string | undefined;
  readonly error: unknown;
  readonly turnId?: string | undefined;
  readonly timestampMs?: number | undefined;
  readonly id?: string | undefined;
}

export function buildTurnFailedEntry(input: TurnFailedEntryInput): Record<string, unknown> & { id: string; kind: string } {
  return {
    kind: TURN_FAILED_ENTRY_KIND,
    id: input.id ?? `turn-failed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    text: turnFailedText(input.agentName, input.error),
    cause: plainWordsForTurnFailure(input.error),
    ...(input.turnId != null ? { turnId: input.turnId } : {}),
    timestampMs: input.timestampMs ?? Date.now(),
  };
}
