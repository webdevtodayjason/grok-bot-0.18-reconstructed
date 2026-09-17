import { runClaimCheck } from "./judgment-3.js";
import type { AskJevOptions } from "./client.js";
import type { JevTurn } from "./turn-state.js";

/**
 * JEV-2. The claim check as the send tool sees it: hand it what is about to be sent, get back a
 * refusal string or nothing.
 *
 * It returns a string rather than throwing because the send tool already has a refusal channel --
 * the send cap's -- and a refusal that travels the same way arrives as the same kind of tool error
 * the model already knows how to read, in the same place, with no new failure shape.
 */

/** The text of an outgoing message, whatever shape the tool was handed. */
export function outgoingText(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input == null) return "";
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.content === "string") return candidate.content;
  if (typeof candidate.text === "string") return candidate.text;
  return "";
}

/** The domains this turn actually retrieved, which is what "the sources you checked" means. */
export function sourcesChecked(jev: JevTurn): readonly string[] {
  return [...new Set(jev.evidence.map((item) => item.source))];
}

export function createOutgoingClaimCheck(
  jev: JevTurn,
  options: AskJevOptions = {},
): (input: unknown) => Promise<string | undefined> {
  return async (input: unknown) => {
    const message = outgoingText(input);
    if (message.length === 0) return undefined;
    const outcome = await runClaimCheck({
      agentId: jev.agentId,
      turnId: jev.turnId,
      message,
      evidence: jev.evidence,
      sourcesChecked: sourcesChecked(jev),
      sourcesNamedInRequest: jev.sourcesNamedInRequest,
      counter: jev.counter,
    }, options);
    jev.decisions.push(...outcome.decisions);
    return outcome.refusal;
  };
}
