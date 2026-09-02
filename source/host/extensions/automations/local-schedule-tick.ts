import type { PollingPolicy } from "../../../internal/scheduling.js";

/**
 * Cron-triggered routines never fired on a self-hosted box. `shouldScheduleLocally` sends anything
 * `isServerSchedulable` to the cloud, and the cloud is Cursor's -- it polls due fires and tells the
 * box. Signed out there is no poller, so a routine's countdown ticked down in the UI and nothing
 * ever ran. Everything below the trigger was already local: the store derives `nextRunAt`, and the
 * manual "Test run" path fires a routine and records the run without a backend hop.
 *
 * So this is the missing half-hour of work, not a subsystem: a clock that notices a routine is due
 * and calls the fire path the Test-run button already uses.
 */
export interface LocalScheduleAutomation {
  readonly id: string;
  readonly isEnabled: boolean;
  readonly nextRunAt: number | null;
  readonly runs?: readonly { readonly startedAt?: number }[];
}

export interface LocalScheduleTickDeps {
  readonly polling: PollingPolicy;
  listAutomations(): Promise<readonly { readonly agentId: string; readonly automation: LocalScheduleAutomation }[]>;
  fire(agentId: string, automationId: string): Promise<unknown>;
  isReady(): boolean | Promise<boolean>;
  /** Firing into an agent mid-turn aborts its work; a busy agent's slot waits for a later tick. */
  isAgentBusy?(agentId: string): boolean;
  log(message: string): void;
  now?(): number;
}

/** Exported for tests: the whole decision, with no clock or I/O of its own. */
export function dueAutomations(
  entries: readonly { readonly agentId: string; readonly automation: LocalScheduleAutomation }[],
  nowMs: number,
  lastFired: ReadonlyMap<string, number>,
): { readonly agentId: string; readonly automationId: string; readonly slot: number }[] {
  const due: { agentId: string; automationId: string; slot: number }[] = [];
  for (const { agentId, automation } of entries) {
    const slot = automation.nextRunAt;
    if (!automation.isEnabled || slot == null || slot > nowMs) continue;
    // Fire a slot once. The in-memory mark covers this process; the run history covers a restart,
    // where re-firing every overdue routine at once would be the worst possible welcome back.
    if ((lastFired.get(`${agentId}:${automation.id}`) ?? 0) >= slot) continue;
    if ((automation.runs ?? []).some((run) => (run.startedAt ?? 0) >= slot)) continue;
    due.push({ agentId, automationId: automation.id, slot });
  }
  return due;
}

export function startLocalScheduleTick(deps: LocalScheduleTickDeps): { dispose(): void } {
  const lastFired = new Map<string, number>();
  const now = deps.now ?? (() => Date.now());
  let stopped = false;
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      // A routine that fires while the box is still coming up produces a run that fails for reasons
      // that have nothing to do with the routine, so wait for the runner rather than the clock.
      if (!(await deps.isReady())) return;
      const entries = await deps.listAutomations();
      for (const { agentId, automationId, slot } of dueAutomations(entries, now(), lastFired)) {
        // Not marked as fired: the slot stays due and is picked up once the agent is free.
        if (deps.isAgentBusy?.(agentId) === true) continue;
        lastFired.set(`${agentId}:${automationId}`, slot);
        try {
          await deps.fire(agentId, automationId);
          deps.log(`[automations] fired ${automationId} locally (due ${new Date(slot).toISOString()})`);
        } catch (error) {
          deps.log(`[automations] local fire failed for ${automationId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      deps.log(`[automations] local schedule tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
    }
  };

  const handle = deps.polling.start(async () => { await tick(); });
  return {
    dispose(): void {
      stopped = true;
      handle.dispose();
    },
  };
}
