import { Buffer } from "node:buffer";
import { z } from "zod";
import { createHash } from "node:crypto";
import { buildHostShellArgs } from "../../box/box-shell-command.js";
import { navigationProbeCommand, normalizeNavigationUrl, parseNavigationProbeOutput } from "../sand-action-audit.js";
import { SAND_BOX_NO_MONITOR_AVAILABLE_MESSAGE } from "../../ports/box.js";
import { shellExecutorResource } from "../../../packages/agent-exec/shell.js";
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../packages/agent-exec/remote.js";
import type { Context as OperationContext } from "../../../packages/context/core.js";
import {
  runSandBrowserAutoReviewPreflight,
  SandBrowserAutoReviewBlockedError,
  type SandBrowserAutoReviewOptions,
} from "../sand-browser-auto-review.js";
import {
  SAND_BROWSER_DRIVER_BOX_DIR,
  SAND_BROWSER_DRIVER_BOX_PATH,
  SAND_BROWSER_DRIVER_SOURCE,
  SAND_BROWSER_RESULT_MARKER,
} from "./sand-browser-driver-source.js";

export const BOX_CDP_PORT_BASE = 9_222;
export const PENDING_SCREENSHOT_CAP = 32;

const pendingScreenshots = new Map<string, string>();

export function stashScreenshot(imageB64: string): string {
  const key = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (pendingScreenshots.size >= PENDING_SCREENSHOT_CAP) {
    const oldest = pendingScreenshots.keys().next().value;
    if (oldest !== undefined) pendingScreenshots.delete(oldest);
  }
  pendingScreenshots.set(key, imageB64);
  return key;
}

export interface BrowserEnvelope {
  readonly text: string;
  readonly imageKey?: string;
}

export function encodeEnvelope(envelope: BrowserEnvelope): string {
  return JSON.stringify(envelope);
}

export function decodeEnvelope(raw: string): BrowserEnvelope {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object"
      && parsed !== null
      && "text" in parsed
      && typeof parsed.text === "string"
    ) {
      return {
        text: parsed.text,
        ...(
          "imageKey" in parsed && typeof parsed.imageKey === "string"
            ? { imageKey: parsed.imageKey }
            : {}
        ),
      };
    }
  } catch {}
  return { text: raw };
}

export interface BrowserDriverResponse {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly summary?: string | undefined;
  readonly data?: string | undefined;
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly viewId?: string | undefined;
  readonly screenshot?: boolean | undefined;
  /**
   * BROWSER-1. The three fields the box driver's `open` answers with beside the old ones: the
   * page's readable words, and its two best-effort verdicts about why a page might be useless --
   * a sign-in form is in the way, or the site refused the visit with a check or a block page.
   * Every other op leaves all three absent, so nothing about the fifteen page-level tools moves.
   */
  readonly text?: string | undefined;
  readonly needsLogin?: boolean | undefined;
  readonly blocked?: boolean | undefined;
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(
  object: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = object[key];
  return typeof value === "boolean" ? value : undefined;
}

export function toDriverResponse(
  parsed: Record<string, unknown>,
): BrowserDriverResponse {
  return {
    ok: optionalBoolean(parsed, "ok") ?? false,
    ...(optionalString(parsed, "error") == null
      ? {}
      : { error: optionalString(parsed, "error") }),
    ...(optionalString(parsed, "summary") == null
      ? {}
      : { summary: optionalString(parsed, "summary") }),
    ...(optionalString(parsed, "data") == null
      ? {}
      : { data: optionalString(parsed, "data") }),
    ...(optionalString(parsed, "url") == null
      ? {}
      : { url: optionalString(parsed, "url") }),
    ...(optionalString(parsed, "title") == null
      ? {}
      : { title: optionalString(parsed, "title") }),
    ...(optionalString(parsed, "viewId") == null
      ? {}
      : { viewId: optionalString(parsed, "viewId") }),
    ...(optionalBoolean(parsed, "screenshot") == null
      ? {}
      : { screenshot: optionalBoolean(parsed, "screenshot") }),
    ...(optionalString(parsed, "text") == null
      ? {}
      : { text: optionalString(parsed, "text") }),
    ...(optionalBoolean(parsed, "needsLogin") == null
      ? {}
      : { needsLogin: optionalBoolean(parsed, "needsLogin") }),
    ...(optionalBoolean(parsed, "blocked") == null
      ? {}
      : { blocked: optionalBoolean(parsed, "blocked") }),
  };
}

export function parseDriverResponse(
  stdout: string,
): BrowserDriverResponse | undefined {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const markerIndex = line.indexOf(SAND_BROWSER_RESULT_MARKER);
    if (markerIndex < 0) continue;
    try {
      const parsed: unknown = JSON.parse(
        line.slice(markerIndex + SAND_BROWSER_RESULT_MARKER.length),
      );
      if (
        typeof parsed === "object"
        && parsed !== null
        && !Array.isArray(parsed)
      ) {
        return toDriverResponse(parsed as Record<string, unknown>);
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sanitizeForBoxPath(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return cleaned.length > 0 ? cleaned : `call-${Date.now()}`;
}

export class SandBrowserDriverError extends Error {
  override readonly name = "SandBrowserDriverError";
}

/**
 * BROWSER-1. What the model is told when the page is walled or refused, in the words it is meant
 * to pass on. The person never hears a tool name, so neither do these.
 */
export const SAND_BROWSER_NEEDS_LOGIN_NOTE =
  "This page wants a sign-in before it shows anything. Tell the person they can sign in on the computer's screen, and say you will pick the page back up once they have.";
export const SAND_BROWSER_BLOCKED_NOTE =
  "The site would not show this page: it answered with a security check or a refusal instead of the real content. Say so plainly and try another source.";

export interface BrowserDriverDependencies<Context> {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  getWindowIndex(context: Context): Promise<number | undefined>;
  getBoxId(): string;
  getDefaultViewId(): string;
  uploadFile(
    context: Context,
    boxId: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<void>;
  downloadFile(
    context: Context,
    boxId: string,
    path: string,
  ): Promise<Uint8Array>;
  executeShell(
    context: Context,
    input: {
      command: string;
      name: string;
      workingDirectory: string;
      toolCallId: string;
    },
  ): Promise<{
    readonly case: "success" | string;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  }>;
  getPersistImage?():
    | ((bytes: Uint8Array, mimeType: string) => Promise<unknown>)
    | undefined;
  /**
   * BROWSER-1. One `browser_navigation` row in the agent's audit ledger per page Titan opens,
   * with the page's url and title. The polling navigation probe only runs while a box-scoped
   * subagent holds the screen, so a main-agent tool call would otherwise leave no receipt at all.
   * Only a spec marked `recordsNavigation` calls it, and only after the driver said ok.
   */
  recordNavigation?(input: { readonly url: string; readonly title: string }): void;
  readonly autoReview?: SandBrowserAutoReviewOptions;
}

export interface BrowserDriverOutput {
  readonly text: string;
  readonly imageB64?: string;
  readonly isError?: boolean;
  /** BROWSER-1. Where the page ended up, for the audit row; absent when the op never navigated. */
  readonly url?: string;
  readonly title?: string;
  readonly needsLogin?: boolean;
  readonly blocked?: boolean;
}

export class SandBrowserDriver<Context = unknown> {
  #uploaded: Promise<void> | undefined;
  #windowIndex: Promise<number> | undefined;

  constructor(readonly dependencies: BrowserDriverDependencies<Context>) {}

  resolveWindowIndex(context: Context): Promise<number> {
    this.#windowIndex ??= this.dependencies.getWindowIndex(context)
      .then((index) => {
        if (index === undefined) {
          this.#windowIndex = undefined;
          throw new SandBrowserDriverError(
            "The box has not assigned this agent a browser window yet; try again in a moment.",
          );
        }
        return index;
      })
      .catch((error: unknown) => {
        this.#windowIndex = undefined;
        throw error instanceof SandBrowserDriverError
          ? error
          : new SandBrowserDriverError(
            `Could not resolve this agent's browser window: ${error instanceof Error ? error.message : String(error)}`,
          );
      });
    return this.#windowIndex;
  }

  ensureUploaded(context: Context): Promise<void> {
    this.#uploaded ??= this.dependencies.uploadFile(
      context,
      this.dependencies.getBoxId(),
      SAND_BROWSER_DRIVER_BOX_PATH,
      Buffer.from(SAND_BROWSER_DRIVER_SOURCE, "utf8"),
    ).catch((error: unknown) => {
      this.#uploaded = undefined;
      throw new SandBrowserDriverError(
        `Could not install the browser driver on the box: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.#uploaded;
  }

  async run(
    context: Context,
    input: {
      readonly op: string;
      readonly toolCallId: string;
      readonly args: Record<string, unknown>;
      readonly skipScreenshot?: boolean;
    },
  ): Promise<BrowserDriverOutput> {
    const [windowIndex] = await Promise.all([
      this.resolveWindowIndex(context),
      this.ensureUploaded(context),
    ]);

    const screenshotPath = input.skipScreenshot === true
      ? undefined
      : `${SAND_BROWSER_DRIVER_BOX_DIR}/shot-${sanitizeForBoxPath(input.toolCallId)}.png`;
    const requestedViewId = input.args.viewId;
    const request = {
      ...input.args,
      op: input.op,
      display: windowIndex,
      cdpPort: BOX_CDP_PORT_BASE + windowIndex,
      viewId: typeof requestedViewId === "string" && requestedViewId.length > 0
        ? requestedViewId
        : this.dependencies.getDefaultViewId(),
      ...(screenshotPath == null ? {} : { screenshotPath }),
    };
    const encoded = Buffer.from(
      JSON.stringify(request),
      "utf8",
    ).toString("base64");

    const shell = await this.dependencies.executeShell(context, {
      command: `node ${SAND_BROWSER_DRIVER_BOX_PATH} ${encoded}`,
      name: "node",
      workingDirectory: "/workspace",
      toolCallId: `sand-browser-${input.op}-${sanitizeForBoxPath(input.toolCallId)}`,
    });
    if (shell.case !== "success") {
      throw new SandBrowserDriverError(
        `Browser driver shell failed (${shell.case || "unknown"})`,
      );
    }

    const response = parseDriverResponse(shell.stdout ?? "");
    if (response === undefined) {
      const detail = [shell.stderr ?? "", shell.stdout ?? ""]
        .map((part) => part.trim().slice(-400))
        .filter((part) => part.length > 0)
        .join(" | ");
      throw new SandBrowserDriverError(
        `Browser driver produced no result (exit ${shell.exitCode ?? "unknown"})${detail.length > 0 ? `: ${detail}` : ""}`,
      );
    }
    if (!response.ok) {
      return {
        text: response.error ?? "The browser action failed.",
        isError: true,
      };
    }

    const parts = [response.summary ?? "Done."];
    if (response.url != null && response.url.length > 0) {
      parts.push(`Current page: ${response.title ?? ""} (${response.url})`);
    }
    if (response.data != null && response.data.length > 0) {
      parts.push(response.data);
    }
    // BROWSER-1. The page's words, then the two verdicts said the way Titan is expected to repeat
    // them: no tool name, no status code, just what happened and what the person can do about it.
    if (response.text != null && response.text.length > 0) {
      parts.push(response.text);
    }
    if (response.needsLogin === true) {
      parts.push(SAND_BROWSER_NEEDS_LOGIN_NOTE);
    }
    if (response.blocked === true) {
      parts.push(SAND_BROWSER_BLOCKED_NOTE);
    }

    const imageB64 = response.screenshot === true && screenshotPath != null
      ? await this.fetchScreenshot(context, screenshotPath)
      : undefined;
    return {
      text: parts.join("\n\n"),
      ...(imageB64 == null ? {} : { imageB64 }),
      ...(response.url == null ? {} : { url: response.url }),
      ...(response.title == null ? {} : { title: response.title }),
      ...(response.needsLogin == null ? {} : { needsLogin: response.needsLogin }),
      ...(response.blocked == null ? {} : { blocked: response.blocked }),
    };
  }

  async fetchScreenshot(
    context: Context,
    boxPath: string,
  ): Promise<string | undefined> {
    try {
      const bytes = await this.dependencies.downloadFile(
        context,
        this.dependencies.getBoxId(),
        boxPath,
      );
      if (bytes.length === 0) return undefined;
      const persistImage = this.dependencies.getPersistImage?.();
      if (persistImage != null) {
        await persistImage(bytes, "image/png").catch(() => null);
      }
      return Buffer.from(bytes).toString("base64");
    } catch {
      return undefined;
    }
  }
}

export interface BrowserReviewAction {
  readonly [key: string]: unknown;
  readonly op: string;
  readonly viewId: string;
  readonly url?: string | undefined;
  readonly ref?: string | undefined;
  readonly element?: string | undefined;
  readonly text?: string | undefined;
  readonly value?: string | undefined;
  readonly values?: readonly string[] | undefined;
  readonly key?: string | undefined;
  readonly cdpMethod?: string | undefined;
  readonly cdpParams?: string | undefined;
  readonly tabsAction?: string | undefined;
  readonly tabIndex?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly sourceRef?: string | undefined;
  readonly targetRef?: string | undefined;
  readonly targetX?: number | undefined;
  readonly targetY?: number | undefined;
  readonly newTab?: boolean | undefined;
  readonly submit?: boolean | undefined;
  readonly clear?: boolean | undefined;
  readonly doubleClick?: boolean | undefined;
  readonly button?: string | undefined;
  readonly modifiers?: readonly string[] | undefined;
}

const BROWSER_REVIEW_STATE_MARKER = "__SAND_BROWSER_VIEW_STATE__";

function resolveBrowserTargetPageUrl(
  probeStdout: string,
  stateJson: string,
  viewId: string,
): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(stateJson); } catch { parsed = undefined; }
  const fields = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const views = fields.views !== null && typeof fields.views === "object" && !Array.isArray(fields.views)
    ? fields.views as Record<string, unknown>
    : {};
  const urls = fields.urls !== null && typeof fields.urls === "object" && !Array.isArray(fields.urls)
    ? fields.urls as Record<string, unknown>
    : {};
  const targetId = views[viewId];
  if (typeof targetId === "string" && targetId.length > 0) {
    const target = parseNavigationProbeOutput(probeStdout).find(candidate => candidate.type === "page" && candidate.id === targetId);
    const url = typeof target?.url === "string" ? normalizeNavigationUrl(target.url) : undefined;
    if (url !== undefined) return url;
  }
  return typeof urls[viewId] === "string" ? normalizeNavigationUrl(urls[viewId] as string) : undefined;
}

async function captureBrowserReviewState(args: {
  readonly ctx: OperationContext;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly toolCallId: string;
  readonly resolveDisplayNumber: (ctx: OperationContext) => Promise<number | undefined>;
  readonly viewId?: string;
}): Promise<{ displayStateIdentity: string; targetPageUrl?: string }> {
  let displayNumber: number | undefined;
  try { displayNumber = await args.resolveDisplayNumber(args.ctx); } catch {
    throw new SandBrowserAutoReviewBlockedError("Browser Auto-review could not identify this agent's own display; retry once the box desktop is ready.");
  }
  if (displayNumber === undefined) throw new SandBrowserAutoReviewBlockedError(SAND_BOX_NO_MONITOR_AVAILABLE_MESSAGE);
  let result: any;
  try {
    result = await (args.resourceAccessor.get(shellExecutorResource) as { execute(ctx: OperationContext, args: unknown): Promise<any> }).execute(args.ctx, buildHostShellArgs({
      command: `${navigationProbeCommand(displayNumber)} && echo ${BROWSER_REVIEW_STATE_MARKER} && (cat ${SAND_BROWSER_DRIVER_BOX_DIR}/views-${displayNumber}.json 2>/dev/null || true)`,
      name: "curl",
      workingDirectory: "/workspace",
      toolCallId: `${args.toolCallId}:auto-review-state`,
    }));
  } catch (error) {
    // The message the model sees stays generic; the host log carries the cause, because this
    // preflight failed for a week with nothing to read (GAP-ANALYSIS SUB-1).
    console.warn(`[sand][browser-review] page-state capture threw: ${error instanceof Error ? error.message : String(error)}`);
    throw new SandBrowserAutoReviewBlockedError("Browser Auto-review could not capture the current page state.");
  }
  // This box's shell executor reports a non-zero exit as `failure` with the exit code, where
  // the upstream executor reported `success` with exitCode != 0. Before the driver has launched
  // Chrome for a fresh display the probe's curl exits 7, and that is the "chrome-unreachable"
  // state the review already knows how to handle, not a capture error.
  if (result?.result?.case === "failure" && typeof result.result.value?.exitCode === "number") {
    return { displayStateIdentity: "chrome-unreachable" };
  }
  if (result?.result?.case !== "success") {
    console.warn(`[sand][browser-review] page-state capture returned ${String(result?.result?.case ?? "no result")}: ${JSON.stringify(result?.result?.value ?? null).slice(0, 300)}`);
    throw new SandBrowserAutoReviewBlockedError("Browser Auto-review could not capture the current page state.");
  }
  if (result.result.value.exitCode !== 0) return { displayStateIdentity: "chrome-unreachable" };
  const stdout = result.result.value.stdout ?? "";
  const markerIndex = stdout.indexOf(BROWSER_REVIEW_STATE_MARKER);
  const probePart = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
  const statePart = markerIndex >= 0 ? stdout.slice(markerIndex + BROWSER_REVIEW_STATE_MARKER.length) : "";
  const targetPageUrl = args.viewId === undefined ? undefined : resolveBrowserTargetPageUrl(probePart, statePart.trim(), args.viewId);
  const pageIdentity = parseNavigationProbeOutput(probePart)
    .filter(target => target.type === "page" && typeof target.id === "string")
    .map(target => `${String(target.id)}\t${typeof target.url === "string" ? String(target.url).trim() : ""}`)
    .sort()
    .join("\n");
  return {
    displayStateIdentity: createHash("sha256").update(pageIdentity).digest("hex"),
    ...(targetPageUrl === undefined ? {} : { targetPageUrl }),
  };
}

export function toBrowserReviewAction(
  op: string,
  args: Record<string, unknown>,
  defaultViewId: string,
): BrowserReviewAction {
  const stringValue = (key: string): string | undefined =>
    typeof args[key] === "string" ? args[key] : undefined;
  const numberValue = (key: string): number | undefined =>
    typeof args[key] === "number" ? args[key] : undefined;
  const booleanValue = (key: string): boolean | undefined =>
    typeof args[key] === "boolean" ? args[key] : undefined;
  const stringArray = (key: string): string[] | undefined =>
    Array.isArray(args[key])
      ? args[key].filter((entry): entry is string => typeof entry === "string")
      : undefined;

  return {
    op,
    viewId: stringValue("viewId") ?? defaultViewId,
    ...(stringValue("url") == null ? {} : { url: stringValue("url") }),
    ...(stringValue("ref") == null ? {} : { ref: stringValue("ref") }),
    ...(stringValue("element") == null ? {} : { element: stringValue("element") }),
    ...(stringValue("text") == null ? {} : { text: stringValue("text") }),
    ...(stringValue("value") == null ? {} : { value: stringValue("value") }),
    ...(stringArray("values") == null ? {} : { values: stringArray("values") }),
    ...(stringValue("key") == null ? {} : { key: stringValue("key") }),
    ...(op !== "cdp" || stringValue("method") == null
      ? {}
      : { cdpMethod: stringValue("method") }),
    ...(op !== "cdp" || args.params === undefined
      ? {}
      : { cdpParams: JSON.stringify(args.params) }),
    ...(op !== "tabs" || stringValue("action") == null
      ? {}
      : { tabsAction: stringValue("action") }),
    ...(op !== "tabs" || numberValue("index") == null
      ? {}
      : { tabIndex: numberValue("index") }),
    ...(numberValue("x") == null ? {} : { x: numberValue("x") }),
    ...(numberValue("y") == null ? {} : { y: numberValue("y") }),
    ...(stringValue("sourceRef") == null
      ? {}
      : { sourceRef: stringValue("sourceRef") }),
    ...(stringValue("targetRef") == null
      ? {}
      : { targetRef: stringValue("targetRef") }),
    ...(numberValue("targetX") == null
      ? {}
      : { targetX: numberValue("targetX") }),
    ...(numberValue("targetY") == null
      ? {}
      : { targetY: numberValue("targetY") }),
    ...(booleanValue("newTab") == null
      ? {}
      : { newTab: booleanValue("newTab") }),
    ...(booleanValue("submit") == null
      ? {}
      : { submit: booleanValue("submit") }),
    ...(booleanValue("clear") == null
      ? {}
      : { clear: booleanValue("clear") }),
    ...(booleanValue("doubleClick") == null
      ? {}
      : { doubleClick: booleanValue("doubleClick") }),
    ...(stringValue("button") == null
      ? {}
      : { button: stringValue("button") }),
    ...(stringArray("modifiers") == null
      ? {}
      : { modifiers: stringArray("modifiers") }),
  };
}

export interface BrowserToolSchema {
  readonly required?: readonly string[];
  readonly enum?: Readonly<Record<string, readonly string[]>>;
}

export interface BrowserToolDefinition<Context> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly op: string;
  readonly schema: BrowserToolSchema;
  /** Model-facing argument schema (zod); see BROWSER_TOOL_PARAMETERS. */
  readonly parameters: z.ZodTypeAny;
  readonly canNavigate?: boolean;
  readonly skipScreenshot?: boolean;
  execute(
    context: Context,
    args: Record<string, unknown>,
    metadata: { readonly toolCallId: string; readonly stateHandler?: unknown; readonly workspacePaths?: readonly string[] },
  ): Promise<BrowserDriverOutput>;
  render(output: BrowserDriverOutput): {
    readonly kind: "text" | "image";
    readonly text: string;
    readonly imageB64?: string;
    readonly isError?: boolean;
  };
}

export interface BrowserToolSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly op: string;
  readonly schema?: BrowserToolSchema;
  /**
   * BROWSER-1. A spec may carry its own model-facing schema instead of borrowing the one keyed by
   * op. Titan's four tools share three ops with the fifteen (click, type, screenshot) but take
   * different arguments -- visible text or a CSS selector instead of a snapshot ref -- so the
   * op-keyed table cannot describe both.
   */
  readonly parameters?: z.ZodTypeAny;
  readonly canNavigate?: boolean;
  readonly skipScreenshot?: boolean;
  /** BROWSER-1: write one browser_navigation audit row after this tool succeeds. */
  readonly recordsNavigation?: boolean;
}

/**
 * SUB-1 / TOOLS-03. The specs below carried only a `schema` of required names, and nothing
 * turned that into a model-facing parameter schema. The OpenAI-compatible executor drops any
 * tool without `parameters` / `inputSchema` (openai-compatible-chat.ts, openAiCompatibleTools),
 * so a browserUse subagent that buildTurnTools had handed all fifteen browser tools reached the
 * wire holding Shell and Read alone, and truthfully reported its browser tools unavailable.
 * The Computer tool declares zod parameters; these do the same. Field names are the ones the
 * box driver reads (sand-browser-driver-source.ts); extras it ignores.
 */
const ref = z.string().describe("Element ref from the latest browser_snapshot, e.g. e12");
const button = z.enum(["left", "right", "middle"]).optional().describe("Mouse button; default left");
const modifiers = z.array(z.string()).optional().describe("Held modifier keys, e.g. [\"Shift\"]");
export const BROWSER_TOOL_PARAMETERS: Readonly<Record<string, z.ZodTypeAny>> = {
  navigate: z.object({ url: z.string().describe("Absolute URL to open"), newTab: z.boolean().optional().describe("Open in a new tab instead of reusing yours") }),
  snapshot: z.object({ interactive: z.boolean().optional().describe("Only interactive elements"), maxDepth: z.number().optional().describe("Maximum tree depth"), selector: z.string().optional().describe("CSS selector to scope the snapshot") }),
  click: z.object({ ref, button, modifiers, doubleClick: z.boolean().optional(), holdDurationMs: z.number().optional() }),
  mouse_click_xy: z.object({ x: z.number().describe("Viewport x in CSS pixels"), y: z.number().describe("Viewport y in CSS pixels"), button, modifiers }),
  type: z.object({ ref, text: z.string().describe("Text to type"), submit: z.boolean().optional().describe("Press Enter after typing"), slowly: z.boolean().optional().describe("Type character by character") }),
  fill: z.object({ ref, value: z.string().describe("Value to set") }),
  select_option: z.object({ ref, values: z.array(z.string()).describe("Option values or labels to select") }),
  press_key: z.object({ key: z.string().describe("Key name: Enter, Escape, Tab, ArrowDown, or a single character"), modifiers }),
  scroll: z.object({ ref: ref.optional().describe("Element to scroll into view; omit to scroll the page"), direction: z.enum(["up", "down", "left", "right"]).optional(), amount: z.number().optional().describe("Pixels to scroll"), deltaX: z.number().optional(), deltaY: z.number().optional() }),
  drag: z.object({ sourceRef: z.string().describe("Ref of the element to drag"), targetRef: z.string().optional().describe("Ref to drop onto"), targetX: z.number().optional(), targetY: z.number().optional(), offsetX: z.number().optional(), offsetY: z.number().optional(), durationMs: z.number().optional() }),
  get_bounding_box: z.object({ ref }),
  highlight: z.object({ ref, durationMs: z.number().optional() }),
  cdp: z.object({ method: z.string().describe("CDP method, e.g. Runtime.evaluate"), params: z.record(z.unknown()).optional().describe("Method parameters") }),
  tabs: z.object({ action: z.enum(["list", "new", "close", "select"]), index: z.number().optional().describe("Tab index for close/select") }),
  screenshot: z.object({ fullPage: z.boolean().optional().describe("Capture the full scrollable page") }),
};

const BROWSER_TOOL_SPECS: readonly BrowserToolSpec[] = [
  { id: "BROWSER_NAVIGATE", name: "browser_navigate", op: "navigate", description: "Navigate the box browser to a URL. By default reuses your tab; set newTab: true to open in a new tab. Returns the resulting page state with a screenshot.", schema: { required: ["url"] }, canNavigate: true },
  { id: "BROWSER_SNAPSHOT", name: "browser_snapshot", op: "snapshot", description: "Capture a structured snapshot of the current page with [ref=eN] handles for interactive elements. This is the source of truth for page structure; refs are tied to the latest snapshot for that tab. Better than a screenshot for deciding what to click or type." },
  { id: "BROWSER_CLICK", name: "browser_click", op: "click", description: "Click an element by ref from browser_snapshot. Scrolls the element into view first.", schema: { required: ["ref"] }, canNavigate: true },
  { id: "BROWSER_MOUSE_CLICK_XY", name: "browser_mouse_click_xy", op: "mouse_click_xy", description: "Click at viewport coordinates. Prefer browser_click with refs when possible.", schema: { required: ["x", "y"] }, canNavigate: true },
  { id: "BROWSER_TYPE", name: "browser_type", op: "type", description: "Type text into an input, textarea, or contenteditable element by ref.", schema: { required: ["ref", "text"] }, canNavigate: true },
  { id: "BROWSER_FILL", name: "browser_fill", op: "fill", description: "Set the value of an input, textarea, or contenteditable element by ref.", schema: { required: ["ref", "value"] } },
  { id: "BROWSER_SELECT_OPTION", name: "browser_select_option", op: "select_option", description: "Select one or more options in a select element by ref.", schema: { required: ["ref", "values"] } },
  { id: "BROWSER_PRESS_KEY", name: "browser_press_key", op: "press_key", description: "Press a key in the browser page, for example Enter, Escape, Tab, ArrowDown, or a single character.", schema: { required: ["key"] }, canNavigate: true },
  { id: "BROWSER_SCROLL", name: "browser_scroll", op: "scroll", description: "Scroll the page or scroll an element into view (pass its ref)." },
  { id: "BROWSER_DRAG", name: "browser_drag", op: "drag", description: "Drag an element by ref to another ref or viewport coordinates.", schema: { required: ["sourceRef"] } },
  { id: "BROWSER_GET_BOUNDING_BOX", name: "browser_get_bounding_box", op: "get_bounding_box", description: "Get the viewport bounding box for an element ref.", schema: { required: ["ref"] }, skipScreenshot: true },
  { id: "BROWSER_HIGHLIGHT", name: "browser_highlight", op: "highlight", description: "Highlight an element by ref in the browser page for visual grounding. The returned screenshot shows the highlight.", schema: { required: ["ref"] } },
  { id: "BROWSER_CDP", name: "browser_cdp", op: "cdp", description: "Send a Chrome DevTools Protocol command to the target browser tab. Do not use CDP Input.* methods; use dedicated browser tools for clicks, text input, key presses, scrolling, and drag-and-drop. Browser-wide, storage, cookie, cache, permission, and target-management commands are denied.", schema: { required: ["method"] }, canNavigate: true },
  { id: "BROWSER_TABS", name: "browser_tabs", op: "tabs", description: "List, create, close, or select a browser tab.", schema: { required: ["action"], enum: { action: ["list", "new", "close", "select"] } }, skipScreenshot: true },
  { id: "BROWSER_TAKE_SCREENSHOT", name: "browser_take_screenshot", op: "screenshot", description: "Take a screenshot of the current page. Usually redundant: every browser action already returns one. Use fullPage for the full scrollable page." },
];

function validateArguments(
  schema: BrowserToolSchema,
  args: Record<string, unknown>,
): void {
  for (const key of schema.required ?? []) {
    if (args[key] == null || args[key] === "") {
      throw new SandBrowserDriverError(`${key} is required`);
    }
  }
  for (const [key, values] of Object.entries(schema.enum ?? {})) {
    if (typeof args[key] !== "string" || !values.includes(args[key])) {
      throw new SandBrowserDriverError(
        `${key} must be one of ${values.join(", ")}`,
      );
    }
  }
}

export function createSandBrowserTools<Context>(
  dependencies: BrowserDriverDependencies<Context> & {
    readonly onPossibleNavigation?: (context: Context) => void;
  },
  // BROWSER-1. Defaults to the fifteen page-level tools the browserUse subagent holds; Titan's
  // four (sand-browser-direct-tools.ts) pass their own list and get the same driver, the same
  // auto-review preflight, and the same one-image result.
  specs: readonly BrowserToolSpec[] = BROWSER_TOOL_SPECS,
): BrowserToolDefinition<Context>[] {
  const driver = new SandBrowserDriver(dependencies);
  return specs.map((spec) => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    op: spec.op,
    schema: spec.schema ?? {},
    parameters: spec.parameters ?? BROWSER_TOOL_PARAMETERS[spec.op] ?? z.object({}),
    ...(spec.canNavigate === true ? { canNavigate: true } : {}),
    ...(spec.skipScreenshot === true ? { skipScreenshot: true } : {}),
    async execute(context, args, metadata) {
      try {
        validateArguments(spec.schema ?? {}, args);
        if (dependencies.autoReview !== undefined) {
          const exactAction = toBrowserReviewAction(spec.op, args, dependencies.getDefaultViewId());
          await runSandBrowserAutoReviewPreflight({
            ctx: context as unknown as OperationContext,
            resourceAccessor: dependencies.resourceAccessor as ResourceAccessor<RemoteExecManager>,
            options: {
              ...dependencies.autoReview,
              captureReviewState: (stateCtx, stateToolCallId) => captureBrowserReviewState({
                ctx: stateCtx,
                resourceAccessor: dependencies.resourceAccessor as ResourceAccessor<RemoteExecManager>,
                toolCallId: stateToolCallId,
                resolveDisplayNumber: dependencies.autoReview!.resolveDisplayNumber,
                ...(spec.op !== "tabs" && exactAction.viewId === undefined ? {} : { viewId: exactAction.viewId }),
              }),
            },
            exactAction,
            toolCallId: metadata.toolCallId,
            ...(metadata.stateHandler === undefined ? {} : { stateHandler: metadata.stateHandler }),
            ...(metadata.workspacePaths === undefined ? {} : { workspacePaths: metadata.workspacePaths }),
          });
        }
        const output = await driver.run(context, {
          op: spec.op,
          toolCallId: metadata.toolCallId,
          args,
          ...(spec.skipScreenshot === undefined
            ? {}
            : { skipScreenshot: spec.skipScreenshot }),
        });
        if (spec.canNavigate === true && output.isError !== true) {
          dependencies.onPossibleNavigation?.(context);
        }
        // BROWSER-1. The receipt for a page Titan opened himself. The driver's own url wins over
        // the one asked for, because a redirect is what the ledger should show.
        if (spec.recordsNavigation === true && output.isError !== true) {
          const visited = output.url ?? (typeof args.url === "string" ? args.url : undefined);
          if (visited != null && visited.length > 0) {
            dependencies.recordNavigation?.({ url: visited, title: output.title ?? "" });
          }
        }
        return output;
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
    render(output) {
      if (output.imageB64 != null && output.imageB64.length > 0) {
        const key = stashScreenshot(output.imageB64);
        const image = pendingScreenshots.get(key);
        pendingScreenshots.delete(key);
        return {
          kind: "image",
          text: output.text,
          ...(image == null ? {} : { imageB64: image }),
          ...(output.isError === true ? { isError: true } : {}),
        };
      }
      return {
        kind: "text",
        text: output.text,
        ...(output.isError === true ? { isError: true } : {}),
      };
    },
  }));
}
