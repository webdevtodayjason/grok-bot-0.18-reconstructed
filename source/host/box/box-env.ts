import type { Context } from "../../packages/context/core.js";

export interface BoxEnvironmentUpdate { env: Readonly<Record<string, string>>; replace: boolean }
export interface BoxEnvironmentControlClient { updateEnvironmentVariables(ctx: Context, request: { env: Record<string, string>; replace: boolean }): Promise<unknown> }
export async function applyBoxEnvironmentViaTransport<Transport>(ctx: Context, transport: Transport, update: BoxEnvironmentUpdate, createClient: (transport: Transport) => BoxEnvironmentControlClient): Promise<void> { const control = createClient(transport); await control.updateEnvironmentVariables(ctx, { env: { ...update.env }, replace: update.replace }); }
/**
 * ENV-1. What an environment push actually reached. The box has more than one exec daemon: the
 * primary one, and one per open desktop window, each holding its own environment. `applied` is
 * every one of them taking the update; `pendingWindows` names the windows that did not, so a
 * caller can say "stored, and this window's shell does not have it" instead of claiming a custody
 * it does not hold.
 */
export interface BoxEnvironmentApplyResult { applied: boolean; pendingWindows: string[]; pendingWindowIndexes: number[] }
/**
 * ENV-1. The box knows a window by its DISPLAY INDEX and by nothing else. On the shared desktop
 * every window is opened under the shared box id, so the loopback box's own map key names the
 * BOX, not the agent sitting in the seat -- `grok-bot-local-vm#4` told the model nothing it could
 * act on. The index is the honest thing the transport holds, and the layer that owns
 * index -> agent (SharedDesktopSandBox) relabels on the way out.
 */
export function formatPendingWindowLabel(windowIndex: number): string { return `display :${windowIndex}`; }
/** Rewrites `pendingWindows` from the indexes the transport reported, leaving every other field alone. */
export function relabelPendingWindows<T>(result: T, label: (windowIndex: number) => string): T {
  if (typeof result !== "object" || result == null) return result;
  const indexes = Reflect.get(result, "pendingWindowIndexes");
  if (!Array.isArray(indexes)) return result;
  const named = indexes.filter((index): index is number => typeof index === "number").map(label);
  return { ...(result as object), pendingWindows: named } as T;
}
