/**
 * ONBOARD-1. The one tool Titan gets while he is running first-time setup.
 *
 * He asks five questions in plain words and saves each answer as it arrives, so the console's
 * progress strip fills in during the conversation rather than at the end -- and so a person who
 * closes the modal halfway keeps what they already told him.
 *
 * The tool is offered ONLY while the box's onboarding record says done:false. Once setup closes it
 * disappears from the toolset, so it costs a finished box nothing.
 *
 * It carries no per-turn dependencies: it reads and writes the box's own settings document. That
 * is why it is built straight inside `buildTurnTools` rather than arriving as a factory.
 */

import { z } from "zod";

import { boxOnboardingService } from "../../extensions/onboarding/onboarding-box-store.js";
import {
  ONBOARDING_ANSWER_KEYS,
  type OnboardingAnswerKey,
} from "../../extensions/onboarding/onboarding-state.js";
import { defineCommunicateTool } from "./communicate-tool.js";

export const SAND_SAVE_ONBOARDING_ANSWER_TOOL_NAME = "save_onboarding_answer";

export const saveOnboardingAnswerParameters = z.object({
  field: z
    .enum(ONBOARDING_ANSWER_KEYS as unknown as [OnboardingAnswerKey, ...OnboardingAnswerKey[]])
    .describe(
      "Which answer this is. name: what they want to be called. location: where they are, in their own words. timeZone: the IANA zone that follows from it, like America/Chicago — save this one too, it is what sets the box's clock. business: what kind of business they are in. ownsBusiness: yes or no. workingStyle: hands on, or hand things off.",
    ),
  value: z.string().trim().min(1).describe("What they said, in their words. One short line."),
});

export type SaveOnboardingAnswerArgs = z.infer<typeof saveOnboardingAnswerParameters>;

const DESCRIPTION = [
  "Save one answer from first-time setup so it is not lost if the person steps away.",
  "Call it right after they answer, before you ask the next question. Do not announce it and do not ask permission — just save and carry on.",
  "When they tell you where they are, save both `location` in their words and `timeZone` as the IANA name; the time zone is what sets this workspace's clock.",
].join(" ");

export function createSaveOnboardingAnswerTool() {
  return defineCommunicateTool({}, {
    id: "PLATFORM_ACTION",
    name: SAND_SAVE_ONBOARDING_ANSWER_TOOL_NAME,
    description: DESCRIPTION,
    parameters: saveOnboardingAnswerParameters,
    describeActivity: (args: SaveOnboardingAnswerArgs) => ({ detail: args.field }),
    execute: async (_ctx, args: SaveOnboardingAnswerArgs) => {
      const outcome = boxOnboardingService().saveAnswer(args);
      return outcome.ok ? outcome.detail : `Not saved — ${outcome.reason}`;
    },
  });
}
