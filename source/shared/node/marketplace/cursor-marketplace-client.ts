import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { createCursorChecksum, getSandInferenceBackendUrl } from "../cursor-backend/cursor-inference.js";
import { getSandBackendClientHeaders } from "../sand-client-metadata.js";
import { getSandBackendMode, SandBackendDisabledError } from "../backend-mode.js";

export const CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS = 12_000;
export interface MarketplaceHeader { set(name: string, value: string): void }
export interface MarketplaceRequest { readonly header: MarketplaceHeader }
export type MarketplaceNext<Request extends MarketplaceRequest, Response> = (request: Request) => Promise<Response>;

export async function bestEffortToken(getAccessToken: () => Promise<string | null | undefined>): Promise<string | undefined> {
  try { const token = await getAccessToken(); return token != null && token.length > 0 ? token : undefined; } catch { return undefined; }
}

/**
 * CURSOR-3. The second transport, and the one that was still dialling.
 *
 * Measured on grok-bot-local-vm 2026-09-08 with api2.cursor.sh pointed at 127.0.0.1 in the box's
 * /etc/hosts and a listener on 443: every host boot opened a TLS connection and sent a ClientHello
 * with sni=api2.cursor.sh, and nothing appeared in the host log for it. The caller is
 * `teamRules.start()` at managed-setup start, which runs before anything asks whether this box has
 * a backend, and its only error path is a telemetry report that mode none has already switched off.
 * So "0 lines mentioning cursor in the host log" was true and the box was dialling anyway.
 *
 * The refusal belongs here rather than at the three call sites because this transport is shared by
 * managed skills, the plugin marketplace and team rules, and all three already treat a throw as
 * "the backend did not answer". It is thrown before `next`, so no socket is opened.
 */
export function createMarketplaceInterceptor<Request extends MarketplaceRequest, Response>(
  getAccessToken: () => Promise<string | null | undefined>,
  getMachineId?: () => Promise<string>,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly uuid?: () => string;
    /** Injected by the tests; production asks `getSandBackendMode()`. */
    readonly isBackendOurs?: () => boolean;
  } = {},
) {
  const isBackendOurs = options.isBackendOurs ?? (() => getSandBackendMode() === "ours");
  return (next: MarketplaceNext<Request, Response>): MarketplaceNext<Request, Response> => async (request) => {
    if (!isBackendOurs()) throw new SandBackendDisabledError("The managed-setup backend");
    try { if (getMachineId != null) request.header.set("x-cursor-checksum", createCursorChecksum(await getMachineId())); } catch {}
    for (const [name, value] of Object.entries(getSandBackendClientHeaders(options.env))) request.header.set(name, value);
    request.header.set("x-ghost-mode", "true");
    request.header.set("x-request-id", options.uuid?.() ?? globalThis.crypto.randomUUID());
    const token = await bestEffortToken(getAccessToken); if (token != null) request.header.set("authorization", `Bearer ${token}`);
    return await next(request);
  };
}

export function createDashboardClient(
  getAccessToken: () => Promise<string | null | undefined>,
  getMachineId?: () => Promise<string>,
) {
  const transport = createConnectTransport({
    baseUrl: getSandInferenceBackendUrl(),
    httpVersion: "1.1",
    interceptors: [createMarketplaceInterceptor(getAccessToken, getMachineId) as Interceptor]
  });
  return createClient(DashboardService, transport);
}
