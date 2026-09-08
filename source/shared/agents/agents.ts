export const SAND_AGENT_PURPOSES = ["disk-saver", "plugin-auth"] as const;
export type SandAgentPurpose = (typeof SAND_AGENT_PURPOSES)[number];

export function isSandAgentPurpose(value: unknown): value is SandAgentPurpose {
  return (
    typeof value === "string" &&
    (SAND_AGENT_PURPOSES as readonly string[]).includes(value)
  );
}

const TEMPLATE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function sanitizeTemplateId(value: unknown): string | undefined {
  return typeof value === "string" && TEMPLATE_ID_PATTERN.test(value)
    ? value
    : undefined;
}

export interface SandAgentActivity {
  readonly kind?: string;
  readonly tool?: string;
  readonly detail?: string;
  readonly target?: string;
  readonly callId?: string;
}

export function areAgentActivitiesEqual(
  left: SandAgentActivity | null | undefined,
  right: SandAgentActivity | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.kind === right.kind &&
    left.tool === right.tool &&
    left.detail === right.detail &&
    left.target === right.target &&
    left.callId === right.callId
  );
}

export const SAND_DEFAULT_AGENT_NAME = "New Bot";
export const LEGACY_SAND_DEFAULT_AGENT_NAME = "New Agent";

export function isSandDefaultAgentName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed === SAND_DEFAULT_AGENT_NAME ||
    trimmed === LEGACY_SAND_DEFAULT_AGENT_NAME
  );
}

export const GROUP_MAX_MEMBERS = 6;

/**
 * AGENTS-CAP-1. A box holds a hundred bots, Titan and ninety-nine more (Jason, 2026-09-08 17:59:
 * "I need to open up the number of agents that we can have. Can you make it 100?"; it was
 * thirteen, the size of the mascot crew, which is a drawing decision and not a ceiling). An operator can move
 * the ceiling with SAND_MAX_AGENTS (sand-host-settings.json, or the container env); the host
 * reads it through `resolveSandMaxAgents` and hands the resolved number to the error below, so
 * the refusal always names the number actually in force.
 *
 * Groups are not bots and do not count: `SandSessionMaterialization.countCapAgents` skips any
 * agent directory carrying a group config, and a group is minted exempt from the check.
 */
export const SAND_DEFAULT_MAX_AGENTS = 100;
export const SAND_MAX_AGENTS_SETTING = "SAND_MAX_AGENTS";

/** A person reads this, so it is plain words and it names the thing they can do about it. */
export function sandAgentLimitMessage(max: number = SAND_DEFAULT_MAX_AGENTS): string {
  const others = Math.max(0, Math.trunc(max) - 1);
  return `This workspace holds Titan and ${others} more bots. Remove one to add another.`;
}
export const SAND_AGENT_LIMIT_MESSAGE = sandAgentLimitMessage();

export class SandAgentLimitError extends Error {
  constructor(max: number = SAND_DEFAULT_MAX_AGENTS) {
    super(sandAgentLimitMessage(max));
    this.name = "SandAgentLimitError";
  }
}

/**
 * Matched on the NAME, not on the message. It used to compare the message with
 * SAND_AGENT_LIMIT_MESSAGE while the error the host actually threw was a second class declared in
 * session-materialization.ts whose message read "Agent limit of 50 reached" -- so this answered
 * false for every real limit error, and `tryEnsureSession` rethrew the one condition it exists to
 * swallow. There is one class now, its message carries the resolved ceiling, and the test is the
 * name that class sets.
 */
export function isSandAgentLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "SandAgentLimitError";
}

/**
 * ONBOARD-1. A box's very first agent is Titan, the person's AI lead, not the anonymous
 * "New Bot". This applies ONLY where a fresh box seeds its first agent with no profile of its own
 * (`createFallbackSession`), so no agent that already exists is ever renamed.
 */
export const SAND_FIRST_AGENT_NAME = "Titan";
/** mascot-crew.js reads a stored face as `titan:<Name>`; index 0 of the crew is Titan's own. */
export const SAND_FIRST_AGENT_AVATAR_SHAPE = "titan:Titan";
