import { randomUUID } from "node:crypto";
export const SNAPSHOT_TIMEOUT_MS = 5_000;
export const MAX_DOMAIN_LENGTH = 64;
export interface HandoffRequest { agentId: string; instruction: string; telemetry?: { reason?: string; domain?: string; idpDomain?: string } }
export interface PendingHandoff { requestId: string; instruction: string; startedAt: number; snapshotDataUrl?: string; snapshotAt?: number }
/**
 * HANDBACK-1. What survives a host restart. Deliberately no picture: a screenshot is cheap to take
 * again and expensive to keep, and the person still owes the step either way.
 */
export interface PersistedHandoff { requestId: string; instruction: string; startedAt: number }
/**
 * HANDBACK-1. Two words, and only two. Everything the person can do to a hand-off resolves to one of
 * them, and the resume prompt is chosen from the resolution, never from a raw trigger string: the
 * pair used to disagree, so a skip resumed the agent with "the person handed the computer back".
 */
export type BoxHandoffResolution = "handed_back" | "dismissed";
export type HandoffTrigger = { resolution?: BoxHandoffResolution; trigger?: string } | string;
/** What a status read is allowed to carry. No image: this rides every heartbeat and every tick. */
export interface HandoffStatus { requestId: string; instruction: string; startedAt: number; snapshotAt?: number }
export interface BoxHandoffDeps {
  grabScreenshot?(agentId: string): Promise<string | Uint8Array | null>;
  prepare?(agentId: string, request: Record<string, unknown>): Promise<void>;
  onStarted?(event: { agentId: string; instruction: string }): void;
  onEnded?(event: { agentId: string; requestId: string; resolution: BoxHandoffResolution; trigger: string }): void | Promise<void>;
  onStatusChanged?(agentId: string): void;
  telemetry?: { reportBoxHelp(event: Record<string, unknown>): void; trackEvent(name: string, properties: Record<string, unknown>): void };
  report?(event: Record<string, unknown>): void;
  timeoutMs?: number;
  now?(): number;
  /** Read once, synchronously, in the constructor: `pendingHandoff` is read from a non-async status path. */
  loadPersisted?(): Record<string, PersistedHandoff>;
  savePersisted?(records: Record<string, PersistedHandoff>): void;
}
export function decideBoxHandBack(pending: PendingHandoff | undefined, trigger: HandoffTrigger): { kind: "none" } | { kind: "end"; requestId: string; resolution: BoxHandoffResolution; trigger: string } { if (pending == null) return { kind: "none" }; if (typeof trigger === "string") return { kind: "end", requestId: pending.requestId, resolution: trigger === "cancel" || trigger === "dismissed" ? "dismissed" : "handed_back", trigger }; return { kind: "end", requestId: pending.requestId, resolution: trigger.resolution ?? "handed_back", trigger: trigger.trigger ?? "unknown" }; }
/**
 * Read-side only. Rows written before HANDBACK-1 carry the old words, and rewriting them on disk
 * would be risk for no gain, so both the host and the console read them through this.
 */
export function aliasBoxResolution(raw: string | null | undefined): BoxHandoffResolution | null { if (raw === "handed_back" || raw === "completed") return "handed_back"; if (raw === "dismissed" || raw === "cancelled") return "dismissed"; return null; }
/** Strips the snapshot. Measured before this: a pending hand-off took the status payload from 284 B to 10 KB, and a real screenshot on that box is ~70 KB base64, pulled on every 15 s heartbeat. */
export function shapeHandoffForStatus(pending: PendingHandoff | null | undefined): HandoffStatus | null { if (pending == null) return null; return { requestId: pending.requestId, instruction: pending.instruction, startedAt: pending.startedAt, ...(pending.snapshotAt == null ? {} : { snapshotAt: pending.snapshotAt }) }; }
export class BoxHandoffService {
  private readonly pending = new Map<string, PendingHandoff>();
  constructor(readonly deps: BoxHandoffDeps) { this.seedFromPersisted(); }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private seedFromPersisted(): void {
    let records: Record<string, PersistedHandoff> | undefined;
    try { records = this.deps.loadPersisted?.(); } catch { return; }
    if (records == null || typeof records !== "object") return;
    for (const [agentId, record] of Object.entries(records)) {
      if (record == null || typeof record !== "object") continue;
      const { requestId, instruction, startedAt } = record as Partial<PersistedHandoff>;
      if (typeof requestId !== "string" || requestId.length === 0) continue;
      if (typeof instruction !== "string" || instruction.length === 0) continue;
      this.pending.set(agentId, { requestId, instruction, startedAt: typeof startedAt === "number" ? startedAt : this.now() });
    }
  }
  private persist(): void { try { this.deps.savePersisted?.(Object.fromEntries([...this.pending].map(([agentId, live]) => [agentId, { requestId: live.requestId, instruction: live.instruction, startedAt: live.startedAt }]))); } catch {} }
  get(agentId: string): PendingHandoff | null { return this.pending.get(agentId) ?? null; }
  forget(agentId: string): void { if (this.pending.delete(agentId)) this.persist(); }
  start(request: HandoffRequest): { kind: "started"; requestId: string } | { kind: "already-pending"; requestId: string; instruction: string } {
    const live = this.pending.get(request.agentId); if (live != null) return { kind: "already-pending", requestId: live.requestId, instruction: live.instruction };
    const requestId = randomUUID(); this.pending.set(request.agentId, { requestId, instruction: request.instruction, startedAt: this.now() }); this.persist(); this.deps.onStarted?.({ agentId: request.agentId, instruction: request.instruction }); this.deps.onStatusChanged?.(request.agentId); void this.captureSnapshot(request, requestId); return { kind: "started", requestId };
  }
  async end(agentId: string, trigger: HandoffTrigger): Promise<void> { const decision = decideBoxHandBack(this.pending.get(agentId), trigger); if (decision.kind === "none") return; this.pending.delete(agentId); this.persist(); await this.deps.onEnded?.({ agentId, requestId: decision.requestId, resolution: decision.resolution, trigger: decision.trigger }); this.deps.onStatusChanged?.(agentId); }
  private async captureSnapshot(request: HandoffRequest, requestId: string): Promise<void> { let captured = false, timer: NodeJS.Timeout | undefined; try { if (this.deps.prepare != null) await this.deps.prepare(request.agentId, request as unknown as Record<string, unknown>); const timeout = new Promise<null>((resolve) => { const handle=setTimeout(resolve, this.deps.timeoutMs ?? SNAPSHOT_TIMEOUT_MS) as unknown as NodeJS.Timeout;timer=handle;handle.unref(); }), screenshot = await Promise.race([this.deps.grabScreenshot?.(request.agentId) ?? Promise.resolve(null), timeout]); if (screenshot != null && screenshot.length > 0) { const live = this.pending.get(request.agentId); if (live?.requestId === requestId) { const encoded = typeof screenshot === "string" ? screenshot : Buffer.from(screenshot).toString("base64"); this.pending.set(request.agentId, { ...live, snapshotDataUrl: `data:image/webp;base64,${encoded}`, snapshotAt: this.now() }); captured = true; this.deps.onStatusChanged?.(request.agentId); } } } catch {} finally { if(timer!=null)clearTimeout(timer);const reason = request.telemetry?.reason, analyticsReason = reason === "auth" || reason === "captcha" || reason === "payment" ? reason : reason == null ? undefined : "other"; this.deps.telemetry?.reportBoxHelp({ conversationId: request.agentId, snapshotCaptured: captured, reason }); this.deps.telemetry?.trackEvent("sand.box_help", { agent_id: request.agentId, snapshot_captured: captured, ...(analyticsReason == null ? {} : { reason: analyticsReason }), ...(request.telemetry?.domain == null ? {} : { domain: request.telemetry.domain.slice(0, MAX_DOMAIN_LENGTH) }), ...(request.telemetry?.idpDomain == null ? {} : { idp_domain: request.telemetry.idpDomain.slice(0, MAX_DOMAIN_LENGTH) }) }); this.deps.report?.({ outcome: captured ? "ready" : "no_snapshot", agentId: request.agentId }); } }
}
