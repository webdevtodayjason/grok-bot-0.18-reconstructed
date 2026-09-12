type Loose = Record<string, unknown>;

export type ModelTier = "talk" | "work";
export type WorkspaceModelPin = "auto" | "work" | "talk";

export interface ModelTierTurnContext {
  readonly thinkHarder?: boolean;
  readonly requestSource?: string;
  readonly isCodeSandboxTask?: boolean;
  readonly isCodingAgent?: boolean;
  readonly isComputerUseSubagent?: boolean;
  readonly heavyRoutine?: boolean;
}

const HEAVY_TOOL_NAMES = new Set([
  "shell", "externalshell", "write", "edit", "applypatch", "apply_patch",
  "computer", "code_task", "codesandbox", "code_sandbox",
]);

const record = (value: unknown): Loose | null =>
  typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Loose
    : null;

const normalizedToolName = (value: unknown): string =>
  String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "");

export function isHeavyModelTool(name: unknown): boolean {
  return HEAVY_TOOL_NAMES.has(normalizedToolName(name));
}

export function talkModelFor(workModel: string): string | null {
  const model = String(workModel ?? "").trim();
  if (!model.startsWith("plan-") || model.endsWith("-talk") || model.endsWith("-vision")) return null;
  return `${model}-talk`;
}

export function normalizeWorkspaceModelPin(value: unknown): WorkspaceModelPin {
  const pin = String(value ?? "").trim().toLowerCase();
  return pin === "work" || pin === "talk" ? pin : "auto";
}

function resultIsError(value: unknown): boolean {
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try { return resultIsError(JSON.parse(value)); } catch { return false; }
  }
  const held = record(value);
  if (held == null) return false;
  if (held.isError === true || held.error != null) return true;
  const provider = record(held.providerOptions);
  const cursor = record(provider?.cursor);
  const highLevel = record(cursor?.highLevelToolCallResult);
  if (highLevel?.isError === true) return true;
  const result = record(held.result);
  if (result?.isError === true || result?.case === "error") return true;
  return false;
}

function contentParts(content: unknown): readonly unknown[] {
  return Array.isArray(content) ? content : [content];
}

/** Mutable state belongs to one model session (one turn), never to the process. */
export class ModelTierTurnRouter {
  private upgraded = false;
  private consecutiveToolErrors = 0;
  private computerScreenshotRead = false;

  constructor(readonly context: ModelTierTurnContext = {}) {
    const source = String(context.requestSource ?? "").toLowerCase();
    this.upgraded = context.isCodeSandboxTask === true
      || context.isCodingAgent === true
      || context.heavyRoutine === true
      || /code[-_ ]?sandbox|coding[-_ ]?agent/.test(source);
  }

  observeToolCall(name: unknown): void {
    if (this.context.isComputerUseSubagent === true && normalizedToolName(name) === "screenshot") {
      this.computerScreenshotRead = true;
      return;
    }
    this.computerScreenshotRead = false;
    if (isHeavyModelTool(name)) this.upgraded = true;
  }

  observeMessages(messages: readonly unknown[]): void {
    // Only THIS turn counts: the messages after the last user message. A shell call three turns ago
    // must not make today's "say hello" a heavy turn. Measured on the demo box 2026-09-12: every turn
    // of a conversation that had once run a shell command routed to work, because the whole history
    // was scanned.
    let start = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = record(messages[index]);
      if (candidate != null && String(candidate.role ?? "").toLowerCase() === "user") { start = index + 1; break; }
    }
    for (const rawMessage of messages.slice(start)) {
      const message = record(rawMessage);
      if (message == null) continue;
      let sawToolResult = false;
      for (const rawPart of contentParts(message.content)) {
        const part = record(rawPart);
        if (part == null) continue;
        if (part.type === "tool-call") this.observeToolCall(part.toolName);
        if (part.type !== "tool-result") continue;
        sawToolResult = true;
        if (resultIsError(part) || resultIsError(part.result)) {
          this.consecutiveToolErrors += 1;
          if (this.consecutiveToolErrors >= 2) this.upgraded = true;
        } else {
          this.consecutiveToolErrors = 0;
        }
      }
      if (!sawToolResult && resultIsError(message)) {
        this.consecutiveToolErrors += 1;
        if (this.consecutiveToolErrors >= 2) this.upgraded = true;
      }
    }
  }

  choose(args: {
    readonly workModel: string;
    readonly talkAvailable: boolean;
    readonly workspacePin?: unknown;
  }): { readonly tier: ModelTier; readonly model: string; readonly reason: string } {
    const talkModel = talkModelFor(args.workModel);
    const hasTalk = args.talkAvailable && talkModel != null;
    const workspacePin = normalizeWorkspaceModelPin(args.workspacePin);
    if (workspacePin === "work") return { tier: "work", model: args.workModel, reason: "workspace-pin" };
    if (workspacePin === "talk" && hasTalk) return { tier: "talk", model: talkModel, reason: "workspace-pin" };
    if (workspacePin === "talk") return { tier: "work", model: args.workModel, reason: "single-tier" };
    if (this.context.thinkHarder === true) return { tier: "work", model: args.workModel, reason: "conversation-pin" };
    if (this.upgraded) return { tier: "work", model: args.workModel, reason: "heavy-turn" };
    if (this.context.isComputerUseSubagent === true && this.computerScreenshotRead && hasTalk) {
      this.computerScreenshotRead = false;
      return { tier: "talk", model: talkModel, reason: "screenshot-read" };
    }
    if (this.context.isComputerUseSubagent === true) return { tier: "work", model: args.workModel, reason: "computer-planning" };
    if (hasTalk) return { tier: "talk", model: talkModel, reason: "automatic" };
    return { tier: "work", model: args.workModel, reason: "single-tier" };
  }
}
