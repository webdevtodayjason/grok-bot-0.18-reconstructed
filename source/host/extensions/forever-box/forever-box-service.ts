import { DeadlineExceededError, type DeadlinePolicy, type ExpiryPolicy, type PollingPolicy, type RetryPolicy } from "../../../internal/scheduling.js";
import { setTimeout as delay } from "node:timers/promises";
import { createContext, type Context } from "../../../packages/context/core.js";
import { isSandSubagentId } from "../../../shared/agents/subagents.js";
import { HostBox, type BoxStatus } from "./host-box.js";

export class SandForeverBoxError extends Error {}
export const RECREATE_UNAVAILABLE_MESSAGE = "Couldn't reach the service that updates this computer. It is unchanged. Try again in a moment; if it keeps failing, the backend may need to be updated.";
export const FOREVER_BOX_WINDOW_SWEEP_INTERVAL_MS = 60_000; export const FOREVER_BOX_WINDOW_SWEEP_START_ATTEMPTS = 6; export const FOREVER_BOX_WINDOW_SWEEP_RETRY_MS = 10_000;
export const FOREVER_BOX_MIGRATION_TTL_MS = 5 * 60_000; export const FOREVER_BOX_SCREENSHOT_TIMEOUT_MS = 5_000; export const FOREVER_BOX_RECREATE_FLUSH_WAIT_MS = 10_000; export const FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS = 24 * 60 * 60_000; export const FOREVER_BOX_IMAGE_CHECK_TIMEOUT_MS = 30_000;
export interface ForeverBoxOptions { box: HostBox; /** DISPLAY-3: true when the agent no longer exists (deleted or tombstoned); a window brought up for it is released at once. */ isAgentGone?: (agentId: string) => boolean; lifecycleClient: { recreateInBox(options: { preserveData: boolean; force?: boolean }): Promise<{ started: boolean; reason?: string }>; fetchImageUpdateAvailable(signal: AbortSignal): Promise<boolean | undefined> }; trays: { pushError(value: { agentId: string; title: string; detail: string }): void }; telemetry: { reportBoxRecreateDecided(value: Record<string, string>): void; reportBoxImageCheck(value: Record<string, unknown>): void }; imagePolling: PollingPolicy; imagePollingStartDelay: RetryPolicy; imageSeedRetry: RetryPolicy; imageCheckDeadline: DeadlinePolicy; migrationExpiry: ExpiryPolicy; screenshotDeadline: DeadlinePolicy; recreateFlushWaitDeadline: DeadlinePolicy; flushPendingUploads(): Promise<void>; autoUpdateEnabled: boolean; hostBundleAutoUpdateEnabled: boolean; isInBox(): boolean; log(message: string): void; captureScreenshot?(connection: Awaited<ReturnType<HostBox["ensureReady"]>>, signal: AbortSignal): Promise<Uint8Array | null>; ctx?: Context; now?: () => number }
export class ForeverBoxService {
  readonly box: HostBox; readonly isAutoUpdateEnabled: boolean; private readonly ctx: Context; private readonly listeners = new Set<(status: BoxStatus) => void>(); private readonly abort = new AbortController(); private readonly unsubscribeBox: () => void; private imagePolling: { dispose(): void } | undefined; private imagePollingStartDelay: { elapsed: Promise<void>; dispose(): void } | undefined; private migrationExpiry: { dispose(): void } | undefined; private isBusy = false; private updateInFlight = false; private updateFailureNotified = false; private imageRefreshInFlight = false; private migrating = false; private stopped = false; private readonly now: () => number; private readVisibleAgentIds: (() => Promise<Set<string>>) | undefined; private lastWindowSweepAt = Number.NEGATIVE_INFINITY;
  constructor(readonly options: ForeverBoxOptions) { this.box = options.box; this.ctx = options.ctx ?? createContext().withName("foreverBox"); this.now = options.now ?? (() => performance.now()); this.isAutoUpdateEnabled = options.autoUpdateEnabled; this.unsubscribeBox = this.box.subscribe((status) => this.emit(this.decorateStatus(status))); }
  start(): void { void this.seedImageUpdateAvailable(); void this.startImagePolling(); } subscribe(listener: (status: BoxStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); } setBusy(value: boolean): void { this.isBusy = value; }
  async getStatus(input: { id: string }): Promise<BoxStatus> { void this.reconcileWindows(); return this.decorateStatus(await this.box.getStatus(this.ctx, input.id)); }
  async ensure(input: { id: string }): Promise<BoxStatus> {
    // DISPLAY-4. A page that keeps polling a deleted agent's desktop must not cost a bring-up per
    // poll: each one took a free index, started a display for nobody, and the teardown that followed
    // stopped whichever live agent had inherited that index in between. Refuse before the box.
    if (this.options.isAgentGone?.(input.id) === true) throw new SandForeverBoxError(`agent ${input.id} no longer exists; nothing to bring up`);
    const status = await this.box.ensure(this.ctx, input.id);
    // DISPLAY-3. A page kept asking for a probe's desktop while the gate deleted it; the bring-up
    // outlived the delete and wrote an assignment nobody would release. Release it here instead.
    if (this.options.isAgentGone?.(input.id) === true) { await this.releaseAgent(input.id).catch(() => {}); throw new SandForeverBoxError(`agent ${input.id} was deleted while its desktop was starting`); }
    void this.reconcileWindows();
    void this.maybeAutoUpdate(input.id, status.imageUpdateAvailable); return this.decorateStatus(status);
  }
  private reconciling = false;
  /**
   * DISPLAY-5: the roster is the only thing that can say an agent holds no conversation, and it
   * starts after this service, so it hands its reader in here. The first sweep runs at that moment,
   * which is host start, before any page has asked for a desktop.
   */
  useRosterReader(readVisibleAgentIds: () => Promise<Set<string>>): Promise<void> { this.readVisibleAgentIds = readVisibleAgentIds; return this.sweepWindowsAtStart(); }
  private async sweepWindowsAtStart(): Promise<void> {
    for (let attempt = 1; attempt <= FOREVER_BOX_WINDOW_SWEEP_START_ATTEMPTS && !this.stopped; attempt += 1) {
      this.lastWindowSweepAt = Number.NEGATIVE_INFINITY;
      await this.reconcileWindows();
      if (this.lastWindowSweepAt !== Number.NEGATIVE_INFINITY) { void this.sweepAgainOnceStartSettles(); return; }
      try { await delay(FOREVER_BOX_WINDOW_SWEEP_RETRY_MS, undefined, { signal: this.abort.signal }); } catch { return; }
    }
  }
  /**
   * A bring-up already in flight when the first sweep ran leaves its seat behind it, and on an idle
   * box nothing would look again until someone opened a page. One more pass once boot has settled.
   */
  private async sweepAgainOnceStartSettles(): Promise<void> {
    try { await delay(FOREVER_BOX_WINDOW_SWEEP_INTERVAL_MS, undefined, { signal: this.abort.signal }); } catch { return; }
    if (this.stopped) return;
    this.lastWindowSweepAt = Number.NEGATIVE_INFINITY;
    await this.reconcileWindows();
  }
  /** Release every window whose agent is gone. Cheap: a map walk plus a stat per entry. */
  async reconcileWindows(): Promise<void> {
    if (this.reconciling) return; this.reconciling = true;
    try {
      if (this.options.isAgentGone != null) for (const agentId of this.box.listAssignedAgentIds()) { if (this.options.isAgentGone(agentId)) { console.log(`[sand][window] releasing the window of gone agent ${agentId}`); await this.releaseAgent(agentId).catch(() => {}); } }
      if (this.now() - this.lastWindowSweepAt < FOREVER_BOX_WINDOW_SWEEP_INTERVAL_MS) return;
      // Both sweeps below talk to the box, so they run on a leash rather than on every status poll.
      if (!await this.releaseWindowsWithoutConversation()) return;
      this.lastWindowSweepAt = this.now();
      for (const index of await this.box.sweepUnassignedWindows(this.ctx).catch(() => [] as number[])) console.log(`[sand][window] stopped :${index}: a live seat that no assignment held`);
    } finally { this.reconciling = false; }
  }
  /**
   * DISPLAY-5: an agent with no conversation is hidden from the roster but keeps its seat, and the
   * seat is an X server the box pays for at every boot. Release the window; the agent itself stays
   * on disk, exactly as the roster leaves it.
   */
  async releaseWindowsWithoutConversation(): Promise<boolean> {
    const readVisibleAgentIds = this.readVisibleAgentIds; if (readVisibleAgentIds == null || this.stopped) return true;
    try {
      await this.box.loadAssignments(this.ctx);
      const assigned = this.box.listAssignedAgentIds().filter((agentId) => !isSandSubagentId(agentId));
      if (assigned.length === 0) return true;
      const visible = await readVisibleAgentIds();
      for (const agentId of assigned) { if (visible.has(agentId)) continue; console.log(`[sand][window] releasing the window of ${agentId}: the roster shows no conversation for it`); await this.releaseAgent(agentId).catch(() => {}); }
      return true;
    } catch (error) { this.options.log(`window reconcile against the roster failed: ${String(error)}`); return false; }
  }
  reset(input: { id: string }): Promise<BoxStatus> { return this.recreate(input.id, { preserveData: false }); } update(input: { id: string; force?: boolean }): Promise<BoxStatus> { return this.recreate(input.id, { preserveData: true, ...(input.force === undefined ? {} : { force: input.force }) }); }
  /**
   * SHIP-2: the third image-update entry point, and the only one that used to reach a container
   * recreate while the host-bundle watch was armed. `maybeAutoUpdate` and `watchForImageUpdate`
   * both refuse when the bundle swap owns updates; this one had only the autoUpdateEnabled gate,
   * which answered "auto-update-disabled" while SAND_BOX_AUTO_UPDATE was 0 and stopped doing so
   * the moment that flag went to 1. A recreate here cuts every turn in flight, which is exactly
   * what the bundle swap exists to avoid, so it refuses for the same reason the other two do.
   */
  async autoUpdateNow(): Promise<{ started: boolean; reason?: string }> { if (!this.options.isInBox()) return { started: false, reason: "not-in-box" }; if (!this.options.autoUpdateEnabled) return { started: false, reason: "auto-update-disabled" }; if (this.options.hostBundleAutoUpdateEnabled) return { started: false, reason: "host-bundle-auto-update" }; if (this.isBusy) return { started: false, reason: "busy" }; if (this.updateInFlight) return { started: false, reason: "update-in-flight" }; this.updateInFlight = true; try { const imageCheck = await this.refreshImageUpdateAvailable("pre_hibernation", { coalesce: false }); if (imageCheck.outcome === "failed" || imageCheck.outcome === "timeout") return { started: false, reason: "staleness-check-failed" }; if (imageCheck.available !== true) return { started: false, reason: "no-update-required" }; this.options.telemetry.reportBoxRecreateDecided({ trigger: "hibernation_auto_update", mode: "pod_recreate", preserved: "true" }); try { const result = await this.requestRecreate({ preserveData: true }); if (result.started) this.updateFailureNotified = false; return result; } catch { return { started: false, reason: "recreate-unavailable" }; } } finally { this.updateInFlight = false; } }
  setMigrating(input: { migrating: boolean }): void { this.migrating = input.migrating; this.migrationExpiry?.dispose(); this.migrationExpiry = input.migrating ? this.options.migrationExpiry.arm("migration", () => { this.migrating = false; this.migrationExpiry = undefined; }) : undefined; }
  releaseAgent(agentId: string): Promise<void> { return this.box.releaseWindow(this.ctx, agentId); }
  async captureScreenshot(agentId: string): Promise<Uint8Array | null> { if (this.options.captureScreenshot == null) return null; try { return await this.options.screenshotDeadline.run(async () => this.options.captureScreenshot!(await this.box.ensureReady(this.ctx, agentId), this.abort.signal), this.abort.signal); } catch { return null; } }
  dispose(): void { if (this.stopped) return; this.stopped = true; this.abort.abort(); this.imagePollingStartDelay?.dispose(); this.imagePolling?.dispose(); this.migrationExpiry?.dispose(); this.unsubscribeBox(); this.listeners.clear(); }
  private decorateStatus(status: BoxStatus): BoxStatus { return this.migrating ? { ...status, vncUrl: null, pull: { percent: 0 } } : status; } private emit(status: BoxStatus): void { for (const listener of this.listeners) listener(status); }
  private async recreate(agentId: string, options: { preserveData: boolean; force?: boolean }): Promise<BoxStatus> { let result: { started: boolean; reason?: string }; try { result = await this.requestRecreate(options); } catch (error) { throw new SandForeverBoxError(RECREATE_UNAVAILABLE_MESSAGE, { cause: error }); } if (!result.started) throw new SandForeverBoxError(`Couldn't ${options.preserveData ? "update" : "reset"} the computer (${result.reason?.length ? result.reason : "the service declined the recreate"}). It is unchanged.`); this.updateFailureNotified = false; return this.decorateStatus({ agentId, state: "running", vncUrl: null, pull: { percent: 0 } }); }
  private async requestRecreate(options: { preserveData: boolean; force?: boolean }): Promise<{ started: boolean; reason?: string }> { try { await this.options.recreateFlushWaitDeadline.run(() => this.options.flushPendingUploads(), this.abort.signal); } catch (error) { if (this.abort.signal.aborted) throw error; this.options.log(`snapshot upload flush failed before box recreate: ${String(error)}`); } this.abort.signal.throwIfAborted(); return this.options.lifecycleClient.recreateInBox(options); }
  private async maybeAutoUpdate(agentId: string | undefined, available: boolean | undefined): Promise<void> { if (!this.options.autoUpdateEnabled || this.options.hostBundleAutoUpdateEnabled || available !== true || this.isBusy || this.updateInFlight) return; this.updateInFlight = true; this.options.telemetry.reportBoxRecreateDecided({ trigger: "auto_update", mode: "pod_recreate", preserved: "true" }); try { await this.recreate(agentId ?? "", { preserveData: true }); this.updateFailureNotified = false; } catch (error) { this.options.log(`image update failed; computer stays on its current image: ${String(error)}`); if (!this.updateFailureNotified && agentId != null) { this.updateFailureNotified = true; this.options.trays.pushError({ agentId, title: "Computer update failed", detail: `Couldn't move Grok Bot's computer to the latest image. It keeps working on its current image. Grok Bot will retry, or you can run "Update Grok Bot's Computer" from Settings > Updates.` }); } } finally { this.updateInFlight = false; } }
  async refreshImageUpdateAvailable(trigger: string, options = { coalesce: true }): Promise<{ outcome: string; available?: boolean }> { const startedAt = this.now(); if (!this.options.isInBox()) { this.reportImageCheck({ trigger, outcome: "skipped", durationMs: this.elapsedSince(startedAt), skipReason: "outside_box" }); return { outcome: "skipped" }; } if (options.coalesce && this.imageRefreshInFlight) return { outcome: "skipped" }; if (options.coalesce) this.imageRefreshInFlight = true; try { const available = await this.options.imageCheckDeadline.run((signal) => this.options.lifecycleClient.fetchImageUpdateAvailable(signal), this.abort.signal); this.box.recordImageUpdateAvailable(available); const outcome = available === undefined ? "unanswered" : "answered"; this.reportImageCheck({ trigger, outcome, durationMs: this.elapsedSince(startedAt) }); return { outcome, ...(available === undefined ? {} : { available }) }; } catch (error) { const outcome = this.abort.signal.aborted ? "skipped" : error instanceof DeadlineExceededError ? "timeout" : "failed"; this.reportImageCheck({ trigger, outcome, durationMs: this.elapsedSince(startedAt) }); return { outcome }; } finally { if (options.coalesce) this.imageRefreshInFlight = false; } }
  private async seedImageUpdateAvailable(): Promise<void> { if (!this.options.isInBox()) return; try { await this.options.imageSeedRetry.runWithRetry(async () => { if ((await this.refreshImageUpdateAvailable("seed")).outcome !== "answered") throw new SandForeverBoxError("image state unavailable"); }, this.abort.signal); } catch {} }
  private async startImagePolling(): Promise<void> { this.imagePollingStartDelay = this.options.imagePollingStartDelay.schedule(1, this.abort.signal); try { await this.imagePollingStartDelay.elapsed; } catch { return; } finally { this.imagePollingStartDelay?.dispose(); this.imagePollingStartDelay = undefined; } if (!this.stopped) this.imagePolling = this.options.imagePolling.start(() => this.watchForImageUpdate(), this.abort.signal); }
  private async watchForImageUpdate(): Promise<void> { await this.refreshImageUpdateAvailable("poll"); if (this.options.hostBundleAutoUpdateEnabled || !this.options.autoUpdateEnabled || this.isBusy || this.updateInFlight) return; try { if (!await this.box.isBoxRunning(this.ctx)) return; const agentId = (await this.box.listBoxes()).find((item) => item.running)?.agentId; await this.maybeAutoUpdate(agentId, this.box.getImageUpdateAvailable()); } catch (error) { this.options.log(`image update watch failed: ${String(error)}`); } }
  private reportImageCheck(report: Record<string, unknown>): void { this.options.telemetry.reportBoxImageCheck(report); } private elapsedSince(startedAt: number): number { return Math.max(0, Math.round(this.now() - startedAt)); }
}
