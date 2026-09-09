/**
 * CLOUD-BROWSER-1. Browserbase: the second engine, and a credential-only row.
 *
 * Read 2026-09-09 against docs.browserbase.com/reference/api/create-a-session, which is the page
 * this adapter is written from field by field:
 *
 *   POST /v1/sessions        header X-BB-API-Key, body { projectId, browserSettings, proxies,
 *                            timeout, keepAlive }. The answer carries `id`, `status`, `connectUrl`
 *                            (the websocket) and `proxyBytes` (an integer, "Bytes used via the
 *                            Proxy", and required in the response schema).
 *   GET  /v1/sessions/{id}   the same object, which is where the FINAL proxyBytes is read from --
 *                            the number on the create answer is zero, because nothing has browsed
 *                            yet, and writing that into the ledger would report every session as
 *                            having used no proxy at all.
 *   GET  /v1/sessions/{id}/debug   `debuggerFullscreenUrl`, the page a person can drive.
 *   POST /v1/sessions/{id}   { projectId, status: "REQUEST_RELEASE" } is the stop.
 *
 * WHY IT IS CREDENTIAL-ONLY. Browserbase has no honest MCP connector to hang a key on: its MCP repo
 * is archived and its MCP key travels as a URL query parameter the door refuses. So its catalog row
 * carries a masked credential field and no connector at all, and its key lands in the cloudBrowser
 * section next door. We do NOT invent a connectors.json entry so there is somewhere to put the key:
 * that ships a connector which can only ever fail, which is the live CONNECT-13 defect.
 *
 * CONTEXTS ARE THE SAVED LOGINS. `browserSettings.context = { id, persist: true }` is what makes a
 * signed-in session survive into the next one, which is the whole reason a marketing workspace
 * would choose this engine over the box's Chrome for a site it has to stay signed in to.
 */

import type { CloudSessionHandle, FetchLike } from "./browser-use.js";

export const BROWSERBASE_API_HOST = "https://api.browserbase.com";
export const BROWSERBASE_KEY_HEADER = "X-BB-API-Key";
/** Their own word for "end this session", from the update-session reference. */
export const BROWSERBASE_RELEASE_STATUS = "REQUEST_RELEASE";

export interface BrowserbaseOptions {
  readonly apiKey: string;
  readonly projectId: string;
  readonly fetch: FetchLike;
  /** Seconds. The vendor's floor is 60 and its ceiling is 21600; a leaked endpoint should die fast. */
  readonly timeoutSeconds?: number;
  /** A context id, when this workspace keeps saved logins for the site being opened. */
  readonly contextId?: string | undefined;
  readonly requestTimeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function call(options: BrowserbaseOptions, path: string, init: {
  method: string;
  body?: Record<string, unknown>;
}): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 30_000);
  try {
    const response = await options.fetch(`${BROWSERBASE_API_HOST}${path}`, {
      method: init.method,
      headers: {
        [BROWSERBASE_KEY_HEADER]: options.apiKey,
        "content-type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    let body: Record<string, unknown> = {};
    try { body = asRecord(JSON.parse(await response.text())); } catch { body = {}; }
    return { status: response.status, ok: response.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Open one session, with the residential proxy on and, when this workspace has one, its context. */
export async function openBrowserbaseSession(options: BrowserbaseOptions): Promise<CloudSessionHandle> {
  const timeout = options.timeoutSeconds ?? 300;
  const answer = await call(options, "/v1/sessions", {
    method: "POST",
    body: {
      projectId: options.projectId,
      // `true` is the documented shorthand for the default proxy. An array is for per-domain
      // routing, which nothing here needs and which would be a second thing to keep in step.
      proxies: true,
      // The vendor's own floor is 60 seconds; anything under it is refused at the door.
      timeout: Math.max(60, Math.min(21_600, Math.round(timeout))),
      ...(options.contextId == null ? {} : {
        browserSettings: { context: { id: options.contextId, persist: true } },
      }),
    },
  });
  if (!answer.ok) throw new Error(`the cloud browser would not start (${answer.status})`);
  const id = String(answer.body.id ?? "");
  const connectUrl = String(answer.body.connectUrl ?? "");
  if (id.length === 0 || connectUrl.length === 0) {
    throw new Error("the cloud browser opened but did not say how to reach it");
  }
  const liveViewUrl = await readBrowserbaseLiveView(options, id);
  return { vendor: "browserbase", sessionId: id, cdpUrl: connectUrl, liveViewUrl };
}

/**
 * The page a person can drive. A separate call because the create answer does not carry it, and a
 * failure here is not a failed session: a live view we could not fetch costs the hand-off card its
 * link and costs the reading nothing at all.
 */
export async function readBrowserbaseLiveView(options: BrowserbaseOptions, sessionId: string): Promise<string | null> {
  try {
    const answer = await call(options, `/v1/sessions/${encodeURIComponent(sessionId)}/debug`, { method: "GET" });
    if (!answer.ok) return null;
    const full = answer.body.debuggerFullscreenUrl;
    if (typeof full === "string" && full.length > 0) return full;
    const plain = answer.body.debuggerUrl;
    return typeof plain === "string" && plain.length > 0 ? plain : null;
  } catch {
    return null;
  }
}

export interface BrowserbaseSessionState {
  readonly status: string;
  readonly running: boolean;
  readonly proxyBytes: number | null;
}

/** The session object, read back. This is where the ledger's proxy figure comes from. */
export async function readBrowserbaseSession(options: BrowserbaseOptions, sessionId: string): Promise<BrowserbaseSessionState> {
  const answer = await call(options, `/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" });
  if (!answer.ok) return { status: answer.status === 404 ? "GONE" : "UNKNOWN", running: false, proxyBytes: null };
  const status = String(answer.body.status ?? "UNKNOWN").toUpperCase();
  const bytes = Number(answer.body.proxyBytes);
  return {
    status,
    running: status === "RUNNING" || status === "PENDING",
    proxyBytes: Number.isFinite(bytes) ? bytes : null,
  };
}

/** Ask the vendor to end it. A session already gone answers as stopped, which it is. */
export async function stopBrowserbaseSession(options: BrowserbaseOptions, sessionId: string): Promise<boolean> {
  const answer = await call(options, `/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    body: { projectId: options.projectId, status: BROWSERBASE_RELEASE_STATUS },
  });
  return answer.ok || answer.status === 404 || answer.status === 409;
}
