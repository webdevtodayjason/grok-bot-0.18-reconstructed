import { randomUUID } from "node:crypto";
import { createJevRefusalCounter, type JevEvidence, type JevRefusalCounter } from "./judgment-3.js";
import type { JevDecisionRow } from "./ledger.js";

/**
 * JEV-2. One turn's Jev state: the id both judgements stamp their ledger lines with, the evidence
 * the turn actually retrieved, and how many times the turn has been sent back.
 *
 * It is keyed by agent in a module-level map rather than threaded through the five signatures
 * between the prompt assembly and the toolset, because the two halves of this feature are built in
 * places that do not see each other. That is sound for exactly one reason, and it is worth stating:
 * an agent runs one turn at a time, so "the current turn for this agent" is unambiguous. If that
 * ever stops being true, this map is the thing that breaks, and the fix is to thread a turn id from
 * turn-run-shell.ts through prepareTurn and the toolset handoff.
 *
 * ponytail: a Map keyed by agent, cleared when the turn starts; a per-turn context object if turns
 * ever overlap.
 */

export interface JevTurn {
  readonly agentId: string;
  readonly turnId: string;
  /** Appended to by the search and fetch wrappers as the turn retrieves things. */
  readonly evidence: JevEvidence[];
  readonly counter: JevRefusalCounter;
  /** What this turn's judge decided, in order, so the console can say it in one quiet line. */
  readonly decisions: JevDecisionRow[];
  /** The sources the request named, filled by judgment 1 when it read them out of the request. */
  sourcesNamedInRequest: readonly string[];
  /**
   * True while this state was created by the toolset rather than by the prompt assembly. The two
   * halves are built in either order depending on the path, so the half that runs second adopts a
   * provisional state instead of replacing it; without this, one half would collect evidence into
   * an object the other half had already thrown away.
   */
  provisional: boolean;
}

const turnsByAgent = new Map<string, JevTurn>();

/** Starts a turn, discarding whatever the previous one retrieved. */
export function startJevTurn(agentId: string, turnId?: string, provisional = false): JevTurn {
  const turn: JevTurn = {
    agentId,
    turnId: turnId ?? randomUUID(),
    evidence: [],
    counter: createJevRefusalCounter(),
    decisions: [],
    sourcesNamedInRequest: [],
    provisional,
  };
  turnsByAgent.set(agentId, turn);
  return turn;
}

/**
 * What the prompt assembly calls at the top of a turn. A state the toolset put there moments ago
 * for this same turn is taken over rather than replaced, so both halves share one object and one
 * id; anything else is a previous turn and is replaced outright, because a new turn must never
 * inherit the last one's evidence or its spent refusals.
 */
export function adoptOrStartJevTurn(agentId: string, turnId?: string): JevTurn {
  const existing = turnsByAgent.get(agentId);
  if (existing !== undefined && existing.provisional) {
    existing.provisional = false;
    existing.counter.refusals = 0;
    existing.evidence.length = 0;
    existing.decisions.length = 0;
    return existing;
  }
  return startJevTurn(agentId, turnId);
}

export function currentJevTurn(agentId: string): JevTurn | undefined {
  return turnsByAgent.get(agentId);
}

/** Called when an agent is deleted, so a tombstoned agent leaves nothing behind in memory. */
export function forgetJevTurn(agentId: string): void {
  turnsByAgent.delete(agentId);
}

/** Only a test needs this. */
export function forgetAllJevTurns(): void {
  turnsByAgent.clear();
}
