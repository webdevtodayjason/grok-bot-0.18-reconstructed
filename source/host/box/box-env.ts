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
export interface BoxEnvironmentApplyResult { applied: boolean; pendingWindows: string[] }
