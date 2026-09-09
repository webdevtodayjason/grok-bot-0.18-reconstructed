/**
 * CLOUD-BROWSER-1. Browser Use Cloud: one browser, a residential exit, a live view, a hard stop.
 *
 * What this vendor is for, in one sentence: it is the cheaper of the two per hour AND per gigabyte,
 * its proxy is residential and on by default, and its browser profiles persist across sessions, so
 * a marketing workspace's saved logins survive a box swap. That is why "auto" reaches for it first.
 *
 * THE STOP IS NOT OPTIONAL AND CLOSING THE SOCKET IS NOT THE STOP. Browser Use's own documentation
 * says it plainly: disconnecting from CDP does not end the browser. Only the stop action does. A
 * session nobody stopped is a browser billing by the hour with nothing driving it, so every exit
 * path from a tool call runs `stop`, including a thrown error, and the sweep at host start finishes
 * what a crash left behind.
 *
 * THE VERSION IS A DOCUMENTED CONTRADICTION, so it is handled in code rather than guessed at. Read
 * 2026-09-09: the quickstart writes the browser endpoints under /api/v4, while
 * docs.browser-use.com/cloud/api-reference gives the base URL as /api/v3 and every deep link into
 * /api-reference/browsers/* redirects to that index. So this asks v4 first and falls back to v3 on
 * a 404 OF THE COLLECTION -- a 404 there means no session was created, so the second ask is not a
 * retry of anything and cannot double-spend. Every other status is reported as it came back and
 * nothing is asked twice. The verification job (item B) carries this contradiction as a named fact
 * so the day the vendor settles it, the row says so instead of this code quietly working by luck.
 *
 * THE ENDPOINT IS NOT A WEBSOCKET URL, and that cost a real session to learn. Measured against the
 * live API 2026-09-09: `POST /api/v4/browsers` answered 201 and its `cdpUrl` is not `ws://`. The
 * vendor's own docs hand that string to Playwright's `connect_over_cdp`, which takes an http
 * endpoint and resolves `/json/version` itself. So the driver accepts both shapes; nothing here
 * inspects or rewrites the endpoint, it just carries it.
 *
 * PROFILES ARE AN API, not a dashboard-only affair: `POST /api/v4/profiles` with a name returns an
 * id, and that id goes on browser creation as a top-level `profileId` -- log in once, stop the
 * browser, and the next one starts signed in. That is the saved login that survives a box swap.
 * This adapter passes a `profileId` through; minting and naming one per client is the next slice.
 *
 * No key is ever read here from an environment variable or from argv. It arrives as an argument
 * from secrets.ts, which reads the 0600 store in this same process.
 */

export const BROWSER_USE_API_HOST = "https://api.browser-use.com";
export const BROWSER_USE_API_VERSIONS: readonly string[] = ["v4", "v3"];
export const BROWSER_USE_KEY_HEADER = "X-Browser-Use-API-Key";

/** Where the residential exit lands. US because that is where the customer's audience is. */
export const BROWSER_USE_PROXY_COUNTRY = "us";

export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface CloudSessionHandle {
  readonly vendor: "browser-use" | "browserbase";
  readonly sessionId: string;
  /** The websocket the box's driver attaches to. Carries the session's own credential. */
  readonly cdpUrl: string;
  /** A page a person can drive. Third party, so it is a link-out, never a thumbnail source. */
  readonly liveViewUrl: string | null;
}

export interface BrowserUseOptions {
  readonly apiKey: string;
  readonly fetch: FetchLike;
  /** A short vendor-side ceiling, so a leaked endpoint is dead in minutes rather than hours. */
  readonly timeoutSeconds?: number;
  /** A named profile, minted by hand in the vendor dashboard; the API to create one is undocumented. */
  readonly profileId?: string | undefined;
  readonly requestTimeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A vendor's own words, trimmed, with nothing of ours added and no key anywhere near it. */
async function readBody(response: { text(): Promise<string> }): Promise<Record<string, unknown>> {
  try { return asRecord(JSON.parse(await response.text())); } catch { return {}; }
}

async function call(options: BrowserUseOptions, version: string, path: string, init: {
  method: string;
  body?: Record<string, unknown>;
}): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 30_000);
  try {
    const response = await options.fetch(`${BROWSER_USE_API_HOST}/api/${version}${path}`, {
      method: init.method,
      headers: {
        [BROWSER_USE_KEY_HEADER]: options.apiKey,
        "content-type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    return { status: response.status, ok: response.ok, body: await readBody(response) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open one browser. The version fallback is the ONLY place anything is asked twice, and only on a
 * 404 of the collection, which means nothing was created.
 */
export async function openBrowserUseSession(options: BrowserUseOptions): Promise<CloudSessionHandle> {
  const body: Record<string, unknown> = {
    proxyCountryCode: BROWSER_USE_PROXY_COUNTRY,
    ...(options.timeoutSeconds == null ? {} : { timeoutSeconds: options.timeoutSeconds }),
    ...(options.profileId == null ? {} : { profileId: options.profileId }),
  };
  let last: { status: number; body: Record<string, unknown> } | null = null;
  for (const version of BROWSER_USE_API_VERSIONS) {
    const answer = await call(options, version, "/browsers", { method: "POST", body });
    if (answer.ok) {
      const id = String(answer.body.id ?? "");
      const cdpUrl = String(answer.body.cdpUrl ?? "");
      if (id.length === 0 || cdpUrl.length === 0) {
        throw new Error("the cloud browser opened but did not say how to reach it");
      }
      const liveUrl = typeof answer.body.liveUrl === "string" && answer.body.liveUrl.length > 0
        ? answer.body.liveUrl
        : null;
      return { vendor: "browser-use", sessionId: id, cdpUrl, liveViewUrl: liveUrl };
    }
    last = { status: answer.status, body: answer.body };
    // 404 on the collection: this version does not carry browsers. Anything else is the answer.
    if (answer.status !== 404) break;
  }
  throw new Error(`the cloud browser would not start (${last?.status ?? "no answer"})`);
}

/**
 * End it. The vendor's stop, not a closed socket -- see the header. `already` is not a failure: a
 * session the vendor has already ended is a session that is not costing anybody anything, which is
 * the only outcome this function is trying to reach.
 */
export async function stopBrowserUseSession(options: BrowserUseOptions, sessionId: string): Promise<boolean> {
  for (const version of BROWSER_USE_API_VERSIONS) {
    const answer = await call(options, version, `/browsers/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: { action: "stop" },
    });
    if (answer.ok || answer.status === 409 || answer.status === 410) return true;
    if (answer.status !== 404) return false;
  }
  // Every version answered 404. The session is not there, which is what stopped looks like.
  return true;
}

/** The vendor's own word on whether this session is still running. Asked BEFORE anything is stopped. */
export async function isBrowserUseSessionRunning(options: BrowserUseOptions, sessionId: string): Promise<boolean> {
  for (const version of BROWSER_USE_API_VERSIONS) {
    const answer = await call(options, version, `/browsers/${encodeURIComponent(sessionId)}`, { method: "GET" });
    if (answer.status === 404) continue;
    if (!answer.ok) return false;
    const status = String(answer.body.status ?? "").toLowerCase();
    return status.length === 0 || status === "running" || status === "active" || status === "started";
  }
  return false;
}

/**
 * Proxy traffic, which this vendor does not publish per browser. Null is the honest answer and the
 * admin view prints "not reported by this vendor" for it -- a zero would read as free, and at $5 a
 * gigabyte on a residential exit that is the most expensive wrong number in the ledger.
 */
export function browserUseProxyBytes(): number | null {
  return null;
}
