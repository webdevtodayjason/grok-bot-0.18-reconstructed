/**
 * ONBOARD-1. The two tools Titan gets while he is running first-time setup.
 *
 * `save_onboarding_answer`: he asks five questions in plain words and saves each answer as it
 * arrives, so the console's progress strip fills in during the conversation rather than at the end
 * -- and so a person who closes the modal halfway keeps what they already told him.
 *
 * `finish_onboarding`: the interview's ENDING. Without it the only way out of the modal was the
 * button that says "Skip for now", so a person who answered all five questions and sat through the
 * walkthrough was told they had skipped it, and a person who closed the tab instead came back to
 * the whole first run again on the next load. The record is what closes the dialog -- the console
 * polls `getOnboardingState` while the modal is up and closes on `done:true` -- so the box has to
 * be told, and Titan is the only one who knows when he has finished talking.
 *
 * Both are offered ONLY while the box's onboarding record says done:false. Once setup closes they
 * disappear from the toolset, so they cost a finished box nothing.
 *
 * They carry no per-turn dependencies: they read and write the box's own settings document. That
 * is why they are built straight inside `buildTurnTools` rather than arriving as factories.
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

export const SAND_FINISH_ONBOARDING_TOOL_NAME = "finish_onboarding";

/** No arguments. The record already holds every answer; this only says the conversation is over. */
export const finishOnboardingParameters = z.object({});

const FINISH_DESCRIPTION = [
  "Close first-time setup. This is how it ends.",
  "Call it once, after you have shown them what you can do and asked what they want handled first — that is the last thing setup does.",
  "The setup window on their screen closes when you call it, and the two of you carry on in the normal chat.",
  "Do not call it while you are still asking the five questions, and do not announce it or ask permission — just call it and keep talking.",
].join(" ");

export function createFinishOnboardingTool() {
  return defineCommunicateTool({}, {
    id: "PLATFORM_ACTION",
    name: SAND_FINISH_ONBOARDING_TOOL_NAME,
    description: FINISH_DESCRIPTION,
    parameters: finishOnboardingParameters,
    describeActivity: () => ({ detail: "first-time setup" }),
    // The same call "Skip for now" makes, with `skipped` left off: whatever was captured is kept,
    // and the record says the person finished rather than dismissed it. `complete` is idempotent,
    // so a second call on a box that is already done is harmless.
    execute: async () => {
      const view = boxOnboardingService().complete({});
      return `First-time setup is closed, with ${view.answered.length} of ${view.fields.length} answers kept.`;
    },
  });
}
