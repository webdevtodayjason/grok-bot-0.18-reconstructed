/**
 * ONBOARD-1. The box's first-run service: one reader, one writer, one rule.
 *
 * The record lives in the settings document (<sandRoot>/settings.json) under `onboarding`, beside
 * everything else the box remembers. Two writers reach it:
 *   - this service, from the gateway commands `getOnboardingState` / `completeOnboarding`, and
 *   - the `save_onboarding_answer` turn tool, while Titan is running the interview.
 * Both go through `SandSettingsStore`, whose every write is a whole-document tmp-plus-rename, so
 * the file is never half-written; they are seconds apart in practice and never contend.
 *
 * The time zone is the one answer that changes more than the record. Titan's tool writes it into
 * `userTimeZone` as it arrives, so the very next turn already renders the person's clock; and
 * `completeOnboarding` re-applies it through the settings SERVICE, which is what fires the
 * userTimeZone listeners that re-anchor routines and workflows.
 */

import {
  completedOnboardingRecord,
  isOnboardingAnswerKey,
  normalizeOnboardingAnswer,
  normalizeOnboardingAnswers,
  parseOnboardingRecord,
  resolveOnboardingState,
  viewOnboardingState,
  withOnboardingAnswer,
  type OnboardingAnswerKey,
  type OnboardingAnswers,
  type OnboardingStateView,
  type SandOnboardingRecord,
} from "./onboarding-state.js";
import { readBoxUseSignals, type BoxUseProbe } from "./onboarding-probe.js";

export interface OnboardingRecordStore {
  read(): Record<string, unknown> | undefined;
  write(value: Record<string, unknown> | undefined): void;
}

export interface OnboardingServiceDeps {
  readonly store: OnboardingRecordStore;
  readonly probe: BoxUseProbe;
  /** How many bots this box holds, for the console's "n of 12" line. */
  readonly maxAgents: () => number;
  /** Applies an IANA zone to the box through the settings service, listeners and all. */
  readonly applyTimeZone?: (zone: string) => void;
  readonly isValidTimeZone?: (zone: string) => boolean;
  readonly now?: () => number;
}

/** What a save answers back to the model. Same shape update_state uses. */
export type OnboardingWriteResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly reason: string };

const toRecordValue = (record: SandOnboardingRecord): Record<string, unknown> => ({
  done: record.done,
  ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
  ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
  ...(record.doneReason === undefined ? {} : { doneReason: record.doneReason }),
  answers: { ...record.answers },
});

export class OnboardingService {
  constructor(private readonly deps: OnboardingServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private stored(): SandOnboardingRecord | undefined {
    return parseOnboardingRecord(this.deps.store.read());
  }

  private persist(record: SandOnboardingRecord): SandOnboardingRecord {
    this.deps.store.write(toRecordValue(record));
    return record;
  }

  /**
   * The gateway's `getOnboardingState`. On a box with no record it applies the migration rule
   * once and writes the answer, so the probe never runs twice.
   */
  async getState(): Promise<OnboardingStateView> {
    const stored = this.stored();
    if (stored !== undefined) return viewOnboardingState(stored, this.deps.maxAgents());
    const signals = await readBoxUseSignals(this.deps.probe);
    const resolved = resolveOnboardingState({ stored, signals, now: this.now() });
    const record = resolved.shouldPersist ? this.persist(resolved.record) : resolved.record;
    return viewOnboardingState(record, this.deps.maxAgents());
  }

  /** The record as it stands, with no migration and no write. Used by the turn tool. */
  currentRecord(): SandOnboardingRecord {
    return this.stored() ?? { done: false, answers: {} };
  }

  /**
   * One answer, as Titan captures it. Returns the same `{ok, detail}` / `{ok, reason}` shape the
   * state tool returns, because the runner reads `detail` on success and `reason` on failure and
   * a bare `{ok, message}` made every successful write report a TypeError.
   */
  saveAnswer(args: { readonly field: unknown; readonly value: unknown }): OnboardingWriteResult {
    const field = args.field;
    if (!isOnboardingAnswerKey(field)) {
      return { ok: false, reason: `"${String(field)}" is not one of the onboarding fields.` };
    }
    const value = normalizeOnboardingAnswer(args.value);
    if (value === undefined) return { ok: false, reason: "that answer was empty." };

    const record = this.currentRecord();
    if (record.done) return { ok: false, reason: "first-time setup is already finished." };

    const next = withOnboardingAnswer(
      record.startedAt === undefined ? { ...record, startedAt: this.now() } : record,
      field,
      value,
    );
    this.persist(next);
    if (field === "timeZone") this.applyTimeZone(value);
    return { ok: true, detail: `Saved ${field}.` };
  }

  private applyTimeZone(zone: string): void {
    if (this.deps.isValidTimeZone?.(zone) === false) return;
    this.deps.applyTimeZone?.(zone);
  }

  /**
   * The gateway's `completeOnboarding`. Both the finished interview and "Skip for now" land here;
   * whatever was captured is kept either way.
   */
  complete(args: { readonly answers?: unknown; readonly skipped?: unknown } = {}): OnboardingStateView {
    const answers: OnboardingAnswers = normalizeOnboardingAnswers(args.answers);
    const record = completedOnboardingRecord({
      record: this.currentRecord(),
      answers,
      now: this.now(),
      reason: args.skipped === true ? "skipped" : "completed",
    });
    this.persist(record);
    // Re-applied through the settings service so the userTimeZone listeners fire once, here, and
    // the routines and workflows the person now owns are anchored to their clock.
    const zone = record.answers.timeZone;
    if (zone !== undefined) this.applyTimeZone(zone);
    return viewOnboardingState(record, this.deps.maxAgents());
  }

  /**
   * Test hook. The live arm of scripts/verify-onboarding.mjs needs a scratch box to look fresh
   * again; the gateway only routes this when SAND_TEST_HOOKS=1, so a shipped box has no command
   * that can reopen somebody's first run.
   */
  reset(): OnboardingStateView {
    const record: SandOnboardingRecord = { done: false, startedAt: this.now(), answers: {} };
    this.persist(record);
    return viewOnboardingState(record, this.deps.maxAgents());
  }
}

export function createOnboardingService(deps: OnboardingServiceDeps): OnboardingService {
  return new OnboardingService(deps);
}

export type { OnboardingAnswerKey, OnboardingStateView, SandOnboardingRecord };
