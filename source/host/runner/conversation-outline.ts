import { createBoxSecretRedactor } from "../secret-redaction.js";
import {
  SAND_HIDDEN_PROMPT_MARKER,
  SAND_TRUSTED_AUTOMATION_PROMPT_MARKER,
} from "./sand-prompt-markers.js";

// PROXY-9. One redactor for the outline, made once and cached inside, so deriving an outline of a
// thousand items reads the two secret stores at most once every few seconds rather than per row.
let redactOutlineSecrets: (text: string) => string = createBoxSecretRedactor();
export function setOutlineRedactor(redact: (text: string) => string): void { redactOutlineSecrets = redact; }

export const SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME = "sendMessageToolCall";
export const MCP_TOOL_CALL_OUTLINE_NAME = "mcpToolCall";
export const MAX_TOOL_ACTIVITY_ARGS_CHARS = 20_000;

export type OutlineMessage =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "attachment"; readonly url: string; readonly alt?: string };

export type OutlineItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string; readonly hidden?: true }
  | { readonly kind: "assistant-text"; readonly id: string; readonly text: string }
  | { readonly kind: "thinking"; readonly id: string; readonly text: string; readonly durationMs: number | undefined }
  | { readonly kind: "send-message"; readonly id: string; readonly message: OutlineMessage }
  | {
    readonly kind: "tool-call";
    readonly id: string;
    readonly name: string;
    readonly status: "pending" | "failed" | "done";
    readonly summary: string | undefined;
    /** Shell only: bounded head of what the command returned, and its exit code. Additive; the
     * desktop renderer ignores both and keeps reading `summary`. */
    readonly output?: string;
    readonly exitCode?: number;
  };

interface ShellToolCallLike {
  readonly args?: { readonly command?: unknown };
  readonly result?: {
    readonly result?: {
      readonly case?: string;
      readonly value?: {
        readonly interleavedOutput?: unknown;
        readonly stdout?: unknown;
        readonly stderr?: unknown;
        readonly exitCode?: unknown;
        readonly error?: unknown;
        readonly reason?: unknown;
      };
    };
  };
}

export const MAX_OUTLINE_OUTPUT_CHARS = 600;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** What a shell row needs to be a receipt: the command it ran and the head of what came back.
 *
 * PROXY-9. THE REDACTION LIVES HERE, not at the callers. There are two ways a shell row reaches a
 * screen -- a standalone shellConversationTurn, and the ordinary agentConversationTurn -> toolCall
 * -> shellToolCall that every agent command takes -- and the first fix redacted only the first of
 * them, so a stored key echoed by an agent's own command went to the console in full, in `summary`
 * and again in `output`. This function is the one seam both paths pass through, so redacting in it
 * cannot be forgotten by a third caller.
 *
 * Redact BEFORE truncating: truncating first can cut a credential in half and leave a usable head
 * of it on the page with no token to say anything was taken out. */
export function shellOutline(shell: ShellToolCallLike): { summary: string | undefined; output: string | undefined; exitCode: number | undefined } {
  const command = redactOutlineSecrets(str(shell.args?.command).trim());
  const result = shell.result?.result;
  const value = result?.value;
  let output = value == null
    ? ""
    : str(value.interleavedOutput) || [str(value.stdout), str(value.stderr)].filter(Boolean).join("\n") || str(value.error) || str(value.reason);
  if (output.length === 0 && result?.case != null && result.case !== "success") output = result.case;
  output = redactOutlineSecrets(output);
  if (output.length > MAX_OUTLINE_OUTPUT_CHARS) output = `${output.slice(0, MAX_OUTLINE_OUTPUT_CHARS)}\n… (truncated)`;
  return {
    summary: command.length > 0 ? command : undefined,
    output: output.length > 0 ? output : undefined,
    exitCode: typeof value?.exitCode === "number" ? value.exitCode : undefined,
  };
}

interface JsonArguments {
  toJson(): unknown;
}

interface TaskToolCall {
  readonly args?: { readonly description?: string; readonly prompt?: string };
  readonly result?: {
    readonly result: { readonly case?: string; readonly value?: unknown };
  };
}

interface ComputerAction {
  readonly action: { readonly case?: string };
}

interface ComputerUseToolCall {
  readonly args?: { readonly actions?: readonly ComputerAction[] };
}

interface SendMessageToolCall {
  readonly args?: {
    readonly message?: {
      readonly case?: string;
      readonly value?: unknown;
    };
  };
}

export interface OutlineToolCall {
  readonly tool: {
    readonly case?: string;
    readonly value?: TaskToolCall | ComputerUseToolCall | SendMessageToolCall | {
      readonly args?: JsonArguments;
    };
  };
}

export type OutlineStep = {
  readonly message:
    | { readonly case: "assistantMessage"; readonly value: { readonly text: string } }
    | { readonly case: "thinkingMessage"; readonly value: { readonly text: string; readonly durationMs: number } }
    | { readonly case: "toolCall"; readonly value: OutlineToolCall };
};

export interface ConversationState {
  readonly turns: readonly {
    readonly turn:
      | {
        readonly case: "agentConversationTurn";
        readonly value: {
          readonly userMessage?: { readonly text?: string; readonly messageId?: string };
          readonly steps: readonly OutlineStep[];
        };
      }
      | {
        readonly case: "shellConversationTurn";
        readonly value: { readonly shellCommand?: { readonly command?: string } };
      };
  }[];
}

export interface OutlineTurn {
  readonly rawUserText: string;
  readonly userMessageId: string;
  readonly items: readonly OutlineItem[];
}

export function stripHiddenMarker(text: string): string {
  const withoutHidden = text.startsWith(SAND_HIDDEN_PROMPT_MARKER)
    ? text.slice(SAND_HIDDEN_PROMPT_MARKER.length)
    : text;
  return withoutHidden.startsWith(SAND_TRUSTED_AUTOMATION_PROMPT_MARKER)
    ? withoutHidden.slice(SAND_TRUSTED_AUTOMATION_PROMPT_MARKER.length)
    : withoutHidden;
}

export function getOutlineToolCallName(toolCall: OutlineToolCall): string {
  if (toolCall.tool.case === "taskToolCall") return "Task";
  if (toolCall.tool.case === "computerUseToolCall") {
    const value = toolCall.tool.value as ComputerUseToolCall | undefined;
    const actions = value?.args?.actions;
    if (actions?.length === 1 && actions[0]?.action.case === "screenshot") {
      return "Screenshot";
    }
  }
  return toolCall.tool.case ?? "Tool";
}

export function getTaskSummary(taskToolCall: TaskToolCall): string | undefined {
  const result = taskToolCall.result;
  if (result?.result.case === "error") {
    const value = result.result.value as { readonly error?: unknown } | undefined;
    if (typeof value?.error === "string") return value.error;
  }
  const description = taskToolCall.args?.description?.trim();
  if (description != null && description.length > 0) return description;
  const prompt = taskToolCall.args?.prompt?.trim();
  return prompt != null && prompt.length > 0 ? prompt : undefined;
}

export function getOutlineToolCallSummary(toolCall: OutlineToolCall): string | undefined {
  if (toolCall.tool.case === "taskToolCall") return getTaskSummary(toolCall.tool.value as TaskToolCall);
  if (toolCall.tool.case === "shellToolCall") return shellOutline(toolCall.tool.value as ShellToolCallLike).summary;
  return getToolCallActivityArgs(toolCall);
}

export function getToolCallActivityArgs(toolCall: OutlineToolCall): string | undefined {
  const tool = toolCall.tool.value;
  if (tool == null || !("args" in tool) || tool.args == null || !("toJson" in tool.args)) {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(tool.args.toJson());
  } catch {
    return undefined;
  }
  // PROXY-9. Every non-shell tool's arguments are serialized whole and drawn on the same page: an
  // MCP call carrying a token, a browser navigate with one in the query string. Same seam, same
  // rule, and before the truncation for the same reason as above.
  serialized = redactOutlineSecrets(serialized);
  if (["{}", '\"\"', "[]", "null"].includes(serialized)) return undefined;
  if (serialized.length <= MAX_TOOL_ACTIVITY_ARGS_CHARS) return serialized;
  const copiedPrefix = Buffer.from(
    serialized.slice(0, MAX_TOOL_ACTIVITY_ARGS_CHARS),
    "utf8",
  ).toString("utf8");
  return `${copiedPrefix}\n… (truncated)`;
}

export function isFailedTaskToolCall(toolCall: OutlineToolCall): boolean {
  if (toolCall.tool.case !== "taskToolCall") return false;
  return (toolCall.tool.value as TaskToolCall).result?.result.case === "error";
}

export function getOutlineToolCallStatus(
  event: string,
  toolCall: OutlineToolCall,
): "pending" | "failed" | "done" {
  if (event !== "toolCallCompleted") return "pending";
  return isFailedTaskToolCall(toolCall) ? "failed" : "done";
}

export function sendMessageFromToolCall(toolCall: SendMessageToolCall): OutlineMessage | null {
  const message = toolCall.args?.message;
  if (message == null) return null;
  if (message.case === "text") {
    const value = message.value as { readonly content?: unknown } | undefined;
    return typeof value?.content === "string" ? { type: "text", content: value.content } : null;
  }
  if (message.case === "attachment") {
    const value = message.value as { readonly url?: unknown; readonly alt?: unknown } | undefined;
    if (typeof value?.url !== "string") return null;
    return {
      type: "attachment",
      url: value.url,
      ...(typeof value.alt === "string" && value.alt.length > 0
        ? { alt: value.alt }
        : {}),
    };
  }
  return null;
}

export function stepToOutlineItem(step: OutlineStep, id: string): OutlineItem | null {
  switch (step.message.case) {
    case "assistantMessage":
      return step.message.value.text.length === 0
        ? null
        : { kind: "assistant-text", id, text: step.message.value.text };
    case "thinkingMessage": {
      const { text, durationMs } = step.message.value;
      return text.length === 0
        ? null
        : { kind: "thinking", id, text, durationMs: durationMs > 0 ? durationMs : undefined };
    }
    case "toolCall": {
      const toolCall = step.message.value;
      if (toolCall.tool.case === "sendMessageToolCall") {
        const message = sendMessageFromToolCall(toolCall.tool.value as SendMessageToolCall);
        return message == null ? null : { kind: "send-message", id, message };
      }
      const summary = getOutlineToolCallSummary(toolCall);
      const shell = toolCall.tool.case === "shellToolCall" ? shellOutline(toolCall.tool.value as ShellToolCallLike) : undefined;
      return {
        kind: "tool-call",
        id,
        name: getOutlineToolCallName(toolCall),
        status: getOutlineToolCallStatus("toolCallCompleted", toolCall),
        summary,
        ...(shell?.output != null ? { output: shell.output } : {}),
        ...(shell?.exitCode != null ? { exitCode: shell.exitCode } : {}),
      };
    }
    default:
      return null;
  }
}

export function deriveOutlineTurnsFromConversationState(state: ConversationState): OutlineTurn[] {
  const turns: OutlineTurn[] = [];
  state.turns.forEach((turn, turnIndex) => {
    if (turn.turn.case === "agentConversationTurn") {
      const agentTurn = turn.turn.value;
      const rawUserText = agentTurn.userMessage?.text ?? "";
      const userMessageId = agentTurn.userMessage?.messageId ?? "";
      const hidden = rawUserText.startsWith(SAND_HIDDEN_PROMPT_MARKER);
      const userText = stripHiddenMarker(rawUserText);
      const items: OutlineItem[] = [];
      if (userText.trim().length > 0) {
        items.push({
          kind: "user",
          id: `outline-user-${turnIndex}`,
          text: userText,
          ...(hidden ? { hidden: true } : {}),
        });
      }
      agentTurn.steps.forEach((step, stepIndex) => {
        const item = stepToOutlineItem(step, `outline-${turnIndex}-${stepIndex}`);
        if (item != null) items.push(item);
      });
      turns.push({ rawUserText, userMessageId, items });
    } else if (turn.turn.case === "shellConversationTurn") {
      // PROXY-9. The outline's shell rows carry the command the same way the action ledger does,
      // and they are read by the console, so the same redaction applies at the same moment. The
      // ledger's fix alone would leave the credential on a screen.
      const command = redactOutlineSecrets(turn.turn.value.shellCommand?.command ?? "");
      turns.push({
        rawUserText: "",
        userMessageId: "",
        items: [{
          kind: "tool-call",
          id: `outline-shell-${turnIndex}`,
          name: "shellToolCall",
          status: "done",
          summary: command.length > 0 ? command : undefined,
        }],
      });
    }
  });
  return turns;
}

export function deriveOutlineFromConversationState(state: ConversationState): OutlineItem[] {
  return deriveOutlineTurnsFromConversationState(state).flatMap((turn) => turn.items);
}
