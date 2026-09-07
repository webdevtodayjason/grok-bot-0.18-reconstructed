/**
 * ONBOARD-1. How Titan's first turn is started.
 *
 * The interview's instructions are a seed managed skill (seed-skills/onboarding/SKILL.md), baked
 * into the bundle by scripts/gen-seed-skills.mjs. The host already knows how to make an agent run
 * one: a prompt whose rich text is a single workflow-reference node. `expandWorkflowReferences`
 * inlines the skill's body into that turn, capped at WORKFLOW_INJECTED_BODY_LIMIT.
 *
 * This is the same mechanism teach-by-demonstration uses to dispatch its learning turn, which is
 * why it needs nothing new in sendPrompt, SendPromptOptions, or the runner: no new per-prompt
 * marker field, no system-prompt override. That last part matters -- a systemPrompt override sets
 * `isSystemPromptOverridden`, and the toolset withholds `update_state` when that flag is set, so
 * an override would silently remove the very tool Titan needs to remember the person afterwards.
 */

import { WORKFLOW_REFERENCE_NODE_TYPE } from "../../../shared/workflows.js";

/** The seed skill's id, which is its directory name under seed-skills/. */
export const SAND_ONBOARDING_SKILL_ID = "onboarding";
export const SAND_ONBOARDING_SKILL_LABEL = "First-time setup";

/**
 * What the person's transcript shows for the turn that starts setup. It is a real message rather
 * than a hidden one on purpose: the modal shows this conversation, and a first turn with nothing
 * above Titan's reply reads as though he started talking to himself.
 */
export const SAND_ONBOARDING_START_PROMPT = "Let's get set up.";

export function onboardingPromptRichText(): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: WORKFLOW_REFERENCE_NODE_TYPE,
            attrs: { id: SAND_ONBOARDING_SKILL_ID, label: SAND_ONBOARDING_SKILL_LABEL },
          },
        ],
      },
    ],
  });
}
