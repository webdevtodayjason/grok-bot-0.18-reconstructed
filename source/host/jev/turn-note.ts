import { isJevEnabled, readSandBoxSetting } from "../sand-box-setting.js";
import { SAND_WORKSPACE_LOCATION_SETTING, runRequestInterpretation } from "./judgment-1.js";
import { adoptOrStartJevTurn } from "./turn-state.js";
import type { AskJevOptions } from "./client.js";

/**
 * JEV-2. The judgment 1 entry point, called once per turn from the prompt assembly.
 *
 * It starts the turn's state whether or not the request reads as a question, because the claim
 * check needs somewhere to collect evidence even on a turn that judgment 1 sits out. The flag is
 * read here, per turn, which is what makes it a kill switch rather than a deploy.
 */
export async function buildJevTurnNote(
  agentId: string,
  request: string,
  messageId: string | undefined,
  options: AskJevOptions = {},
): Promise<string | undefined> {
  // SOURCES-1b. The turn's state is started whatever the flag says, because the sources record is
  // collected on every box and has nowhere else to live. Only the JUDGE is gated: with the flag
  // off this returns here, having made no request and written no decision.
  const turn = adoptOrStartJevTurn(agentId, messageId);
  if (!turn.judge) return undefined;
  const workspaceLocation = readSandBoxSetting(SAND_WORKSPACE_LOCATION_SETTING);
  const note = await runRequestInterpretation({
    agentId,
    turnId: turn.turnId,
    request,
    ...(workspaceLocation === undefined ? {} : { workspaceLocation }),
  }, options);
  if (note !== undefined) turn.decisions.push(...note.decisions);
  return note?.text;
}
