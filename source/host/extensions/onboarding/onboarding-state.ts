/**
 * ONBOARD-1. First run, at the box level.
 *
 * When somebody opens a brand new box, Titan introduces himself and runs a short interview before
 * the console behaves like a console. The flag that decides whether that happens is a box-level
 * record inside the settings document (<sandRoot>/settings.json), read through the gateway command
 * `getOnboardingState` and written through `completeOnboarding`.
 *
 * THE MIGRATION RULE, written down once, here.
 *
 *   A box that has been used is never thrown into onboarding.
 *
 *   At the FIRST read -- and only when the settings document carries no onboarding record at all
 *   -- the box is marked done if either of these is true:
 *     (a) it holds more than one bot, or
 *     (b) any of its agents has a prompted conversation (a transcript entry the person sent).
 *   Those are the two signals the host already keeps: `countCapAgents` (agent directories that are
 *   not groups) and `getTranscriptEntries().some(isUserMessageEntry)`, the same predicate
 *   `kickstartAgent` uses to decide an agent has already been talked to.
 *
 *   Once a record EXISTS the rule never runs again. That matters: the moment the person answers
 *   Titan's first question they have a prompted conversation, and re-applying (b) would close
 *   onboarding underneath them. So the first read writes the record, and from then on the record
 *   alone decides.
 *
 * Measured on the Mac dev box (grok-bot-local-vm, 2026-09-07): 8 bots plus 1 group, no onboarding
 * record, so rule (a) marks it done on the first read and no modal ever opens there. Jason's own
 * instance is the same shape.
 *
 * This module is pure on purpose -- no fs, no settings store, no clock beyond what a caller hands
 * it -- so the rule can be tested as a table.
 */

/** The five questions, in the order Titan asks them. The console's progress strip reads this. */
export const ONBOARDING_FIELDS = [
  "name",
  "location",
  "business",
  "ownsBusiness",
  "workingStyle",
] as const;
export type OnboardingField = (typeof ONBOARDING_FIELDS)[number];

/**
 * `timeZone` is not one of the five questions -- it is what the host derives from "where are you"
 * and applies to the box -- but it is captured in the same record so the console can show it and
 * `completeOnboarding` can re-apply it through the settings service.
 */
export const ONBOARDING_ANSWER_KEYS = [...ONBOARDING_FIELDS, "timeZone"] as const;
export type OnboardingAnswerKey = (typeof ONBOARDING_ANSWER_KEYS)[number];

export type OnboardingAnswers = Partial<Record<OnboardingAnswerKey, string>>;

export interface SandOnboardingRecord {
  readonly done: boolean;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly answers: OnboardingAnswers;
  /** Why it is done, when the migration rule decided rather than a person. */
  readonly doneReason?: "completed" | "skipped" | "existing-box";
}

/** What the console reads. `remaining` keeps the progress strip honest with one source of truth. */
export interface OnboardingStateView extends SandOnboardingRecord {
  readonly fields: readonly OnboardingField[];
  readonly answered: readonly OnboardingField[];
  readonly remaining: readonly OnboardingField[];
  readonly maxAgents: number;
}

/** Longest answer we store. A person's name is short; a paste should not become box state. */
export const ONBOARDING_ANSWER_MAX_CHARS = 400;

export function isOnboardingAnswerKey(value: unknown): value is OnboardingAnswerKey {
  return typeof value === "string"
    && (ONBOARDING_ANSWER_KEYS as readonly string[]).includes(value);
}

/** Trim, cap, and refuse an empty answer. Returns undefined when there is nothing worth storing. */
export function normalizeOnboardingAnswer(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, ONBOARDING_ANSWER_MAX_CHARS).trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function normalizeOnboardingAnswers(value: unknown): OnboardingAnswers {
  const answers: OnboardingAnswers = {};
  if (typeof value !== "object" || value == null || Array.isArray(value)) return answers;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isOnboardingAnswerKey(key)) continue;
    const normalized = normalizeOnboardingAnswer(raw);
    if (normalized !== undefined) answers[key] = normalized;
  }
  return answers;
}

/** Parse whatever the settings document holds. Anything unrecognizable reads as "no record". */
export function parseOnboardingRecord(value: unknown): SandOnboardingRecord | undefined {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.done !== "boolean") return undefined;
  const reason = raw.doneReason;
  return {
    done: raw.done,
    ...(Number.isFinite(raw.startedAt) ? { startedAt: Number(raw.startedAt) } : {}),
    ...(Number.isFinite(raw.completedAt) ? { completedAt: Number(raw.completedAt) } : {}),
    answers: normalizeOnboardingAnswers(raw.answers),
    ...(reason === "completed" || reason === "skipped" || reason === "existing-box"
      ? { doneReason: reason }
      : {}),
  };
}

export interface BoxUseSignals {
  /** Bots on the box. Groups are not counted; `countCapAgents` is the host's own answer. */
  readonly agentCount: number;
  /** Any agent holding a transcript entry the person sent. */
  readonly hasPromptedConversation: boolean;
}

export interface ResolvedOnboardingState {
  readonly record: SandOnboardingRecord;
  /** True when the caller must write `record` back before answering. */
  readonly shouldPersist: boolean;
}

/**
 * The whole rule, in one function. `stored` is what the settings document holds (undefined when
 * the box has never been read), `signals` is what the box looks like right now, `now` is the
 * clock the caller supplies.
 */
export function resolveOnboardingState(args: {
  readonly stored: SandOnboardingRecord | undefined;
  readonly signals: BoxUseSignals;
  readonly now: number;
}): ResolvedOnboardingState {
  const { stored, signals, now } = args;
  // A record exists: it is the answer, full stop. Re-running the migration rule here would close
  // onboarding the moment the person answered Titan's first question.
  if (stored !== undefined) return { record: stored, shouldPersist: false };

  const isExistingBox = signals.agentCount > 1 || signals.hasPromptedConversation;
  return isExistingBox
    ? {
      record: { done: true, completedAt: now, answers: {}, doneReason: "existing-box" },
      shouldPersist: true,
    }
    : { record: { done: false, startedAt: now, answers: {} }, shouldPersist: true };
}

export function answeredFields(answers: OnboardingAnswers): readonly OnboardingField[] {
  return ONBOARDING_FIELDS.filter((field) => (answers[field] ?? "").length > 0);
}

export function viewOnboardingState(
  record: SandOnboardingRecord,
  maxAgents: number,
): OnboardingStateView {
  const answered = answeredFields(record.answers);
  return {
    ...record,
    fields: ONBOARDING_FIELDS,
    answered,
    remaining: ONBOARDING_FIELDS.filter((field) => !answered.includes(field)),
    maxAgents,
  };
}

/** Merge one saved answer into a record without disturbing anything else it carries. */
export function withOnboardingAnswer(
  record: SandOnboardingRecord,
  field: OnboardingAnswerKey,
  value: string,
): SandOnboardingRecord {
  return { ...record, answers: { ...record.answers, [field]: value } };
}

/** Close it. `skipped` is the "Skip for now" button; whatever was captured is kept. */
export function completedOnboardingRecord(args: {
  readonly record: SandOnboardingRecord;
  readonly answers?: OnboardingAnswers;
  readonly now: number;
  readonly reason: "completed" | "skipped";
}): SandOnboardingRecord {
  return {
    ...args.record,
    done: true,
    completedAt: args.now,
    doneReason: args.reason,
    answers: { ...args.record.answers, ...(args.answers ?? {}) },
  };
}
