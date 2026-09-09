/**
 * CLOUD-BROWSER-1. The cloud leg of Titan's four browser tools, assembled.
 *
 * Marketing is why this exists. A social sign-up from a datacentre address is refused before the
 * form is read; a login that does not survive a box swap has to be done again every week; and a
 * step only a person can do -- a phone code, an identity check, a captcha nobody may bypass -- has
 * to reach that person inside the same session or the work is lost. A residential exit, persistent
 * profiles and a live view are the three things the box's own Chrome cannot offer, and all three
 * are what a cloud browser is.
 *
 * WHAT THIS IS NOT. It is not a fifth tool, and there is no new tool name anywhere in this wave.
 * browser_open, browser_click, browser_type and browser_screenshot keep their specs, their
 * descriptions and their predicate. The cloud is a branch inside SandBrowserDriver.run(), which is
 * the single place a browser action reaches a page -- so assertBrowsableUrl, the auto-review
 * preflight, recordNavigation and the one-image render are all inherited rather than re-earned, and
 * turn-toolset.ts is not opened. The predicate is deliberately NOT widened either: the cloud is a
 * routing choice on a box that already has a desktop, not a way to hand browser tools to a box with
 * none. That keeps the gate's desktop-invariant leg meaningful.
 *
 * And the cloud browser is driven by the SAME DRIVER. runtime/browser-driver/ grew a wss:// leg and
 * an attach-by-URL entry point, and nothing else changed: the same page-text extractor, the same
 * JPEG-at-1280 pipeline, the same needsLogin / blocked / emptyShell verdicts, the same single marked
 * result line. The result shape is identical by construction rather than because two
 * implementations were kept in step -- and, critically, `checkPublicWebUrl` still runs on the cloud
 * path, so the name-resolving second guard that refuses a public host landing on a private address
 * is still there. A host-side re-implementation would have dropped it silently. This is why we did
 * not write one.
 */

import {
  openBrowserUseSession,
  stopBrowserUseSession,
  isBrowserUseSessionRunning,
  browserUseProxyBytes,
  type CloudSessionHandle,
  type FetchLike,
} from "./browser-use.js";
import {
  openBrowserbaseSession,
  readBrowserbaseSession,
  stopBrowserbaseSession,
} from "./browserbase.js";
import {
  recordCloudSessionClosed,
  recordCloudSessionOpened,
  readCloudBrowserLedger,
  summariseCloudBrowserLedger,
  sweepOpenCloudSessions,
  type CloudBrowserLedgerRow,
} from "./ledger.js";
import {
  cloudBrowserLiveSessions,
  CloudBrowserLiveRegister,
  type CloudBrowserLiveSession,
} from "./live-view.js";
import {
  readCloudBrowserPolicy,
  routeCloudBrowser,
  shouldEscalateOnVerdicts,
  writeCloudBrowserPolicy,
  type CloudBrowserPolicy,
  type CloudRoute,
} from "./policy.js";
import {
  readBrowserbaseProjectId,
  readCloudBrowserKey,
  storedCloudBrowserVendors,
  type CloudBrowserVendor,
} from "./secrets.js";

export type { CloudSessionHandle, FetchLike } from "./browser-use.js";
export type { CloudBrowserLedgerRow } from "./ledger.js";
export type { CloudBrowserLiveSession } from "./live-view.js";
export { CloudBrowserLiveRegister, cloudBrowserLiveSessions } from "./live-view.js";
export type { CloudBrowserPolicy, CloudRoute } from "./policy.js";
export type { CloudBrowserVendor } from "./secrets.js";
export {
  CLOUD_BROWSER_LEDGER_FILENAME,
  cloudBrowserLedgerPath,
  openCloudSessions,
  readCloudBrowserLedger,
  summariseCloudBrowserLedger,
} from "./ledger.js";
export {
  CLOUD_BROWSER_POLICY_FILENAME,
  DEFAULT_CLOUD_BROWSER_POLICY,
  readCloudBrowserPolicy,
  routeCloudBrowser,
  shouldEscalateOnVerdicts,
  writeCloudBrowserPolicy,
} from "./policy.js";
export {
  BROWSERBASE_KEY_FIELD,
  BROWSERBASE_PROJECT_FIELD,
  BROWSER_USE_KEY_FIELD,
  CLOUD_BROWSER_FIELDS,
  CLOUD_BROWSER_SECRETS_SECTION,
  deleteCloudBrowserSecret,
  listCloudBrowserSecretFields,
  storedCloudBrowserVendors,
  writeCloudBrowserSecret,
} from "./secrets.js";

/**
 * A cloud session is minted with a SHORT vendor-side ceiling on purpose. The endpoint carries the
 * session's own credential, it travels through one file the host writes and unlinks, and the only
 * real answer to "what if that leaks" is that the thing it opens stops existing quickly. Five
 * minutes covers a page load, a click, a type and a picture with room to spare.
 */
export const CLOUD_SESSION_TIMEOUT_SECONDS = 300;

/**
 * CLOUD-BROWSER-2's real cause, and the constant that answers it.
 *
 * A cloud session used to be minted and stopped inside ONE tool call. Measured on the R750's demo
 * box on 2026-09-09: two sessions for the same Instagram profile, 5.4 s and 8.1 s apart, two
 * separate browsers, neither continued. Nothing a marketing team actually needs -- a sign-up, a
 * login, a code typed into a second page -- can happen that way, because the click after the open
 * lands in a different browser on a different page.
 *
 * So a browser is now held for the life of the PAGE, not the call, and this is how long it may sit
 * with nothing pointed at it before it is given back. Deliberately under the vendor's own ceiling
 * above: the vendor stops the session at five minutes whatever we do, so an idle timer longer than
 * that would only ever hand a dead endpoint to the next click.
 */
export const CLOUD_VIEW_IDLE_SECONDS = 240;

export interface CloudBrowserPorts {
  /** The sand root. The secret store, the policy and the ledger all live under it. */
  readonly rootDir: string;
  readonly fetch: FetchLike;
  /**
   * What this box calls itself, for the ledger row. NOT the tenant, and it is named that way
   * because the field used to claim to be one: a box holds no control-plane slug, so this is a
   * hostname, which inside a container is a short docker id. The relay stamps the real tenant onto
   * what it serves, because the relay is the thing that knows whose box it is.
   */
  getBoxName(): string;
  /** Whose turn this is. The live-view register and the per-turn ceiling are both keyed on it. */
  getAgentId(): string;
  /** How long a held browser may sit unused. Defaults to CLOUD_VIEW_IDLE_SECONDS; the tests shorten it. */
  readonly viewIdleMs?: number;
  /**
   * THE GATE'S OWN ENDPOINT, and the reason it is production code rather than a test double.
   *
   * The claim this wave has to prove on a real box is that a page read through the cloud path comes
   * back in the same shape as a page read through the box path. Proving it against a real vendor
   * costs money on every gate run, and a gate nobody can afford to run is a gate nobody runs. So an
   * operator may name a LOOPBACK debugger endpoint here and the router will hand the driver that
   * instead of minting a vendor session: the whole cloud path runs -- the request file, the
   * attach-by-URL, the same page reader, the same verdicts, the same ledger row -- against the
   * box's own Chrome.
   *
   * Guarded hard, because "point the cloud browser anywhere" is a hole. Only ws:// on 127.0.0.1 is
   * accepted; a wss:// or a public host here is refused and the route falls back to the box.
   */
  getFakeEndpoint?(): string | null;
}

/**
 * The loopback-only guard for the gate's endpoint. Exported because it is a rule, and a rule that
 * lives only inside the branch that applies it is a rule nobody can check.
 */
export function isLoopbackDebuggerEndpoint(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) return false;
  try {
    const parsed = new URL(raw);
    // ws:// or http:// -- the driver resolves an http endpoint through /json/version the same way
    // it resolves a loopback port, and a box's own Chrome answers on both. wss:// and https:// are
    // refused here on purpose: this setting exists to point at THIS box, and anything encrypted is
    // by definition somewhere else.
    if (parsed.protocol !== "ws:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export interface CloudSessionLease {
  readonly handle: CloudSessionHandle;
  readonly route: CloudRoute;
  /** Stop the vendor's browser and close the ledger row. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * The whole cloud leg as one object, so the seam in sand-browser-tools.ts is a handful of lines
 * rather than a second copy of this file's judgement.
 */
/** One page, and the browser that is holding it. `lease` is null when that browser is the box's own. */
interface HeldCloudView {
  engine: "box" | CloudBrowserVendor;
  lease: CloudSessionLease | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class CloudBrowserService {
  #ports: CloudBrowserPorts;
  #live: CloudBrowserLiveRegister;
  #sessionsThisTurn = new Map<string, number>();
  /**
   * Which browser holds which page. This map is the whole of the fix for a cloud session that could
   * not survive its own tool call: a click carries no address, so without a note of what opened the
   * page the router would decide from nothing and send the click to the box.
   */
  #views = new Map<string, HeldCloudView>();

  constructor(ports: CloudBrowserPorts, live: CloudBrowserLiveRegister = cloudBrowserLiveSessions) {
    this.#ports = ports;
    // The process-wide register by default, so the gateway command that answers the console is
    // reading the same open sessions this service is writing. A test passes its own.
    this.#live = live;
  }

  get live(): CloudBrowserLiveRegister {
    return this.#live;
  }

  policy(): CloudBrowserPolicy {
    return readCloudBrowserPolicy(this.#ports.rootDir);
  }

  setPolicy(patch: Partial<CloudBrowserPolicy>): CloudBrowserPolicy {
    return writeCloudBrowserPolicy(this.#ports.rootDir, patch);
  }

  /** Which engines could run right now, by name. No value ever appears in this answer. */
  availableVendors(): CloudBrowserVendor[] {
    // With the gate's loopback endpoint set, both engines can run without a key, because neither
    // will be dialled. Without it, an engine is available only when its key is actually stored.
    if (isLoopbackDebuggerEndpoint(this.#ports.getFakeEndpoint?.() ?? null)) return ["browser-use", "browserbase"];
    return storedCloudBrowserVendors(this.#ports.rootDir);
  }

  /**
   * A new turn resets the per-turn ceiling. Called where the runner already notices a turn start.
   *
   * It deliberately does NOT give the held browsers back. A hand-off card ends the bot's turn on
   * purpose -- that is the mechanism -- and the person then does the thing only they can do (a
   * code, a captcha, an identity check) in that browser's live view. Closing on the next turn start
   * would throw away the session in the exact moment the wave exists for. The idle timer is what
   * bounds the money instead, and it is shorter than the vendor's own ceiling.
   */
  beginTurn(agentId: string): void {
    this.#sessionsThisTurn.delete(agentId);
  }

  /** Which browser is holding this page, or undefined when nothing has opened it yet. */
  viewEngine(viewId: string): "box" | CloudBrowserVendor | undefined {
    return this.#views.get(viewId)?.engine;
  }

  /**
   * Take, or keep, the browser that holds this page.
   *
   * Called on EVERY browser action, box included, so the box is recorded as the holder too: a page
   * opened in the box must keep being clicked in the box, and a map that only knew about cloud
   * pages could not say that. A cloud engine answers with the endpoint the driver attaches to; the
   * box answers with nothing, which is how the caller knows to use the display and the local port.
   */
  async hold(input: {
    readonly viewId: string;
    readonly engine: "box" | CloudBrowserVendor;
    readonly reason: string;
    readonly url: string;
    readonly contextId?: string | undefined;
    readonly profileId?: string | undefined;
  }): Promise<{ readonly cdpUrl: string; readonly sessionId: string } | null> {
    const existing = this.#views.get(input.viewId);
    if (existing !== undefined && existing.engine === input.engine) {
      this.#armIdle(input.viewId);
      return existing.lease === null
        ? null
        : { cdpUrl: existing.lease.handle.cdpUrl, sessionId: existing.lease.handle.sessionId };
    }
    // The page is moving to the other engine -- an address given to a page already open elsewhere,
    // or the one escalation a box answer is allowed. Give the old browser back before taking a new
    // one, so a switch never leaves two browsers billing for one page.
    if (existing !== undefined) await this.releaseView(input.viewId);
    if (input.engine === "box") {
      this.#views.set(input.viewId, { engine: "box", lease: null, timer: null });
      this.#armIdle(input.viewId);
      return null;
    }
    const lease = await this.open({
      vendor: input.engine,
      route: { engine: input.engine, reason: input.reason },
      url: input.url,
      ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    });
    this.#views.set(input.viewId, { engine: input.engine, lease, timer: null });
    this.#armIdle(input.viewId);
    return { cdpUrl: lease.handle.cdpUrl, sessionId: lease.handle.sessionId };
  }

  /** Give this page's browser back. Stops a cloud session; a box page is simply forgotten. */
  async releaseView(viewId: string): Promise<void> {
    const held = this.#views.get(viewId);
    if (held === undefined) return;
    this.#views.delete(viewId);
    if (held.timer !== null) clearTimeout(held.timer);
    if (held.lease !== null) await held.lease.close();
  }

  #armIdle(viewId: string): void {
    const held = this.#views.get(viewId);
    if (held === undefined) return;
    if (held.timer !== null) clearTimeout(held.timer);
    const timer = setTimeout(() => {
      void this.releaseView(viewId).catch(() => undefined);
    }, this.#ports.viewIdleMs ?? CLOUD_VIEW_IDLE_SECONDS * 1000);
    // A pending idle timer is not a reason for this process to stay alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    held.timer = timer;
  }

  /**
   * Which browser opens this page. Pure: everything it reads was read before it was called, so the
   * decision the box makes is the decision the tests make.
   */
  route(input: { readonly url?: string | undefined; readonly escalating?: boolean }): CloudRoute {
    const agentId = this.#ports.getAgentId();
    return routeCloudBrowser({
      policy: this.policy(),
      available: this.availableVendors(),
      sessionsThisTurn: this.#sessionsThisTurn.get(agentId) ?? 0,
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.escalating === undefined ? {} : { escalating: input.escalating }),
    });
  }

  /** Is this answer worth one cloud session? Exactly three verdicts, and no others. */
  shouldEscalate(verdicts: {
    readonly needsLogin?: boolean | undefined;
    readonly blocked?: boolean | undefined;
    readonly emptyShell?: boolean | undefined;
  }): boolean {
    return shouldEscalateOnVerdicts(verdicts);
  }

  /**
   * Open one session, and write the ledger row BEFORE the connect.
   *
   * The order is the point. A row that goes down after a successful connect cannot describe the
   * session that never got that far -- which is exactly the session that is still running on
   * somebody's bill with nothing pointed at it. The sweep at host start reads these rows.
   */
  async open(input: {
    readonly vendor: CloudBrowserVendor;
    readonly route: CloudRoute;
    readonly url: string;
    readonly contextId?: string | undefined;
    readonly profileId?: string | undefined;
  }): Promise<CloudSessionLease> {
    const agentId = this.#ports.getAgentId();
    const handle = await this.#openVendor(input.vendor, input.contextId, input.profileId);
    const row = recordCloudSessionOpened(this.#ports.rootDir, {
      boxName: this.#ports.getBoxName(),
      agentId,
      vendor: input.vendor,
      sessionId: handle.sessionId,
      reason: input.route.reason,
      url: input.url,
    });
    this.#sessionsThisTurn.set(agentId, (this.#sessionsThisTurn.get(agentId) ?? 0) + 1);
    const session: CloudBrowserLiveSession = {
      agentId,
      vendor: input.vendor,
      sessionId: handle.sessionId,
      liveViewUrl: handle.liveViewUrl,
      startedAt: row.startedAt,
      url: input.url,
    };
    this.#live.add(session);

    let closed = false;
    return {
      handle,
      route: input.route,
      close: async () => {
        if (closed) return;
        closed = true;
        this.#live.remove(handle.sessionId);
        await this.#closeVendor(input.vendor, handle.sessionId, row);
      },
    };
  }

  async #openVendor(
    vendor: CloudBrowserVendor,
    contextId: string | undefined,
    profileId: string | undefined,
  ): Promise<CloudSessionHandle> {
    // The gate's loopback endpoint, checked before any key is read, so a box running the gate never
    // dials a vendor and never spends anything. A value that is not loopback ws:// is ignored
    // outright rather than trusted, and the vendor path below runs as normal.
    const fake = this.#ports.getFakeEndpoint?.() ?? null;
    if (isLoopbackDebuggerEndpoint(fake)) {
      return {
        vendor,
        sessionId: `local-${Date.now().toString(36)}`,
        cdpUrl: String(fake),
        liveViewUrl: null,
      };
    }
    const apiKey = readCloudBrowserKey(this.#ports.rootDir, vendor);
    if (apiKey == null) throw new Error("no key is stored for that cloud browser");
    if (vendor === "browser-use") {
      return await openBrowserUseSession({
        apiKey,
        fetch: this.#ports.fetch,
        timeoutSeconds: CLOUD_SESSION_TIMEOUT_SECONDS,
        ...(profileId === undefined ? {} : { profileId }),
      });
    }
    const projectId = readBrowserbaseProjectId(this.#ports.rootDir);
    if (projectId == null) throw new Error("that cloud browser has no project to open a session in");
    return await openBrowserbaseSession({
      apiKey,
      projectId,
      fetch: this.#ports.fetch,
      timeoutSeconds: CLOUD_SESSION_TIMEOUT_SECONDS,
      ...(contextId === undefined ? {} : { contextId }),
    });
  }

  /**
   * Stop, then close the row. The proxy figure is read from the vendor first where the vendor
   * publishes one, because it is only true after the browsing has happened -- the number on the
   * create answer is zero and writing that would report every session as free.
   */
  async #closeVendor(vendor: CloudBrowserVendor, sessionId: string, row: CloudBrowserLedgerRow): Promise<void> {
    // A session that was never minted at a vendor has nothing to stop, and asking the vendor to
    // stop an id it never issued is exactly the blind call this wave's rules forbid.
    if (sessionId.startsWith("local-")) {
      recordCloudSessionClosed(this.#ports.rootDir, row, { proxyBytes: null });
      return;
    }
    const apiKey = readCloudBrowserKey(this.#ports.rootDir, vendor);
    let proxyBytes: number | null = null;
    try {
      if (apiKey != null && vendor === "browserbase") {
        const projectId = readBrowserbaseProjectId(this.#ports.rootDir) ?? "";
        const options = { apiKey, projectId, fetch: this.#ports.fetch };
        const state = await readBrowserbaseSession(options, sessionId);
        proxyBytes = state.proxyBytes;
        await stopBrowserbaseSession(options, sessionId);
      } else if (apiKey != null) {
        proxyBytes = browserUseProxyBytes();
        await stopBrowserUseSession({ apiKey, fetch: this.#ports.fetch }, sessionId);
      }
    } catch (error) {
      // A stop that failed is the one thing an operator must be able to find, because it is the one
      // that costs money. It goes to the host log AND stays visible in the ledger, because the row
      // below still closes and the sweep still reads the vendor at the next host start.
      console.warn(`[sand][cloud-browser] could not stop session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    recordCloudSessionClosed(this.#ports.rootDir, row, { proxyBytes });
  }

  /** The ledger, folded, and the month's totals. What the console's Computer card counts. */
  usage(since?: Date): ReturnType<typeof summariseCloudBrowserLedger> {
    return summariseCloudBrowserLedger(readCloudBrowserLedger(this.#ports.rootDir), since);
  }

  /**
   * The orphan sweep, run once at host start. It asks the vendor what state each unfinished session
   * is in BEFORE it stops anything -- no cloud call in this wave is retried without that read.
   */
  async sweep(): Promise<{ readonly checked: number; readonly stopped: number; readonly unreachable: number }> {
    const rootDir = this.#ports.rootDir;
    const fetchLike = this.#ports.fetch;
    const browserUseKey = readCloudBrowserKey(rootDir, "browser-use");
    const browserbaseKey = readCloudBrowserKey(rootDir, "browserbase");
    const projectId = readBrowserbaseProjectId(rootDir);
    return await sweepOpenCloudSessions(rootDir, {
      ...(browserUseKey == null ? {} : {
        "browser-use": {
          isRunning: (sessionId: string) => isBrowserUseSessionRunning({ apiKey: browserUseKey, fetch: fetchLike }, sessionId),
          stop: async (sessionId: string) => { await stopBrowserUseSession({ apiKey: browserUseKey, fetch: fetchLike }, sessionId); },
        },
      }),
      ...(browserbaseKey == null || projectId == null ? {} : {
        browserbase: {
          isRunning: async (sessionId: string) =>
            (await readBrowserbaseSession({ apiKey: browserbaseKey, projectId, fetch: fetchLike }, sessionId)).running,
          stop: async (sessionId: string) => {
            await stopBrowserbaseSession({ apiKey: browserbaseKey, projectId, fetch: fetchLike }, sessionId);
          },
        },
      }),
    });
  }
}
