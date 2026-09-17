import {
  SAND_HIDDEN_PROMPT_MARKER,
  SAND_TRUSTED_AUTOMATION_PROMPT_MARKER,
} from "../sand-prompt-markers.js";
import { evidenceRegistry, isWorkTool } from "../../extensions/evidence/evidence-registry.js";
import {
  SAND_BOX_AWAIT_SHELL_TOOL_NAME,
  SAND_BOX_READ_TOOL_NAME,
  SAND_BOX_SHELL_TOOL_NAME,
  SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
  SAND_EXTERNAL_READ_TOOL_NAME,
  SAND_EXTERNAL_SHELL_TOOL_NAME,
} from "../../sand-activity.js";
import { resolveSandExternalMachine } from "../../../shared/agents/agent-tool-names.js";
import { SAND_REACT_TO_MESSAGE_TOOL_NAME } from "./sand-reaction-tool.js";
import { SAND_UPDATE_STATE_TOOL_NAME } from "./sand-state-tool.js";
import { SAND_SEND_MESSAGE_TOOL_NAME } from "./send-message-tool.js";
import type { JevTurn } from "../../jev/turn-state.js";
import { collectJevEvidence, isJevWebToolName } from "../../jev/evidence.js";
import { createTaskTool } from "../../../packages/agent/tools/task.js";
import type { ToolSetHandle } from "../../../packages/agent/tools/core.js";
import { sandLocalToolScopeKey, sandTurnDirectionEpochKey } from "../../../shared/local-tool-permission-machinery.js";
import type { SandLocalToolAction } from "../../../shared/local-tool-permission.js";
import type { Context } from "../../../packages/context/core.js";
import type { ForwardedUpdate } from "../agent-adapters.js";
import {
  DynamicToolRegistry,
  resolveDynamicDispatchToolName,
} from "../../../packages/agent/tools/mcp/builtin-tools.js";
import {
  createCallMcpTool,
  type CreateCallMcpToolOptions,
} from "../../../packages/agent/tools/mcp/mcp.js";
import { createGetMcpToolsTool } from "../../../packages/agent/tools/mcp/get-mcp-tools.js";
import type { ProductionTurnToolInputs } from "../../runner-production-bridge.js";
import { SAND_BOX_WORKSPACE_ROOT } from "../../cloud-agents/cloud-agent-images.js";
import {
  sandToolCallExecutionTimeoutMs,
  wrapDynamicInvocationToolWithTimeout,
  type McpToolForMeta,
} from "./mcp-meta-tools.js";
import {
  isSandBoxSettingEnabled,
  resolveTurnToolBudget,
  SAND_TOOL_TRACE_SETTING,
} from "../../sand-box-setting.js";
// Re-exported so the per-turn budget resolution is reachable from the toolset bundle's tests.
export { resolveTurnToolBudget };
import { fencedToolSet } from "./sand-spotlight-tools.js";
import { isOnboardingActive } from "../../extensions/onboarding/onboarding-box-store.js";
import { createFinishOnboardingTool, createSaveOnboardingAnswerTool } from "./onboarding-answer-tool.js";
import {
  McpDescriptor,
  McpMetaToolOptions,
  McpToolDescriptor,
} from "../../../packages/proto/generated/agent/v1/mcp_pb.js";
import {
  createComputerTool,
  createScreenshotTool,
  describeOutcome,
  type ComputerToolDependencies,
} from "./sand-computer-tool.js";
import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/common.js";
import { defineCommunicateTool } from "./communicate-tool.js";
import { createImageResult, createStringResult } from "../../../packages/chat-inference/prompt-executor.js";
import { ToolCall } from "../../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  ComputerUseToolCall,
  ComputerUseError as ComputerUseErrorMessage,
  ComputerUseResult as ComputerUseResultMessage,
  ComputerUseSuccess as ComputerUseSuccessMessage,
} from "../../../packages/proto/generated/agent/v1/computer_use_tool_pb.js";
import {
  createSandBrowserTools,
  type BrowserDriverDependencies,
} from "./sand-browser-tools.js";
import { createSandDirectBrowserTools, DIRECT_BROWSER_TOOL_NAMES } from "./sand-browser-direct-tools.js";
import {
  createFileTransferTools,
  type FileTransferController,
} from "./sand-file-transfer-tools.js";
import {
  createRequestBoxHelpTool,
  type BoxHelpDependencies,
} from "./box-help-tool.js";
import {
  PROBLEM_REPORT_TOOL_HINT,
  PROBLEM_REPORT_TOOL_ID,
  createProblemReportTool,
  type ProblemReportDependencies,
} from "./problem-report-tool.js";
import {
  SEND_EMAIL_TOOL_HINT,
  SEND_EMAIL_TOOL_ID,
  createSendEmailTool,
  type SendEmailDependencies,
} from "./send-email-tool.js";
import {
  CODE_TASK_TOOL_HINT,
  CODE_TASK_TOOL_ID,
  createCodeTaskTool,
  type CodeTaskDependencies,
} from "./code-task-tool.js";
import {
  CATALOG_SEARCH_TOOL_HINT,
  CATALOG_SEARCH_TOOL_ID,
  CATALOG_SETUP_TOOL_HINT,
  CATALOG_SETUP_TOOL_ID,
  CATALOG_TEMPLATE_TOOL_HINT,
  CATALOG_TEMPLATE_TOOL_ID,
  createCatalogTools,
  type CatalogToolDependencies,
} from "./sand-catalog-tools.js";
import { readAgentMail } from "../../extensions/mail/agent-mail-store.js";
import { resolveRelaySend } from "../../extensions/mail/relay-send-client.js";
import { resolveRelayCode } from "../../extensions/code-sandbox/relay-code-client.js";
import {
  createGenerateImageTool,
  type GenerateImageToolDependencies,
} from "../../../packages/agent/tools/core/generate-image.js";
import {
  createWebSearchTool,
  type WebSearchToolDependencies,
} from "../../../packages/agent/tools/core/web-search.js";
import {
  createWebFetchTool,
  type WebFetchToolDependencies,
} from "../../../packages/agent/tools/core/web-fetch.js";
import { createToolCallExecutionTimeoutError } from "../../../packages/agent/tools/common.js";
import { serializeError as serializeGenericToolError } from "../../../packages/agent/tools/task-client.js";
import {
  createAwaitTool,
  type AwaitToolOptions,
  type AwaitToolResourceAccessor,
} from "../../../packages/agent/tools/core/await.js";
import {
  createSendMessageTool,
  type SendMessageDependencies,
  type TurnSendBudget,
} from "./send-message-tool.js";
import {
  createSendToAgentTool,
  createCreateAgentTool,
  createUpdateAgentTool,
  type AgentManagementDependencies,
  type SendToAgentDependencies,
} from "./sand-agent-management-tools.js";
import {
  createReactToMessageTool,
  type ReactToMessageDependencies,
} from "./sand-reaction-tool.js";
import {
  createSandStateTool,
  type SandStateDependencies,
} from "./sand-state-tool.js";
import {
  createSubagentManagementTools,
  type SubagentManagementController,
} from "./sand-subagent-management-tools.js";
import {
  createMcpManagementTools,
  type McpManagementDependencies,
} from "./sand-mcp-management-tools.js";
import {
  createCloudAgentTool,
  type CloudAgentToolDeps,
} from "../../cloud-agents/cloud-agent-tool.js";
import {
  createReadTool,
  type ReadFormattingOptions,
  type ReadResourceAccessor,
  type ReadToolOptions,
} from "../../../packages/agent/tools/core/read/read.js";
import {
  createShellTool,
  type ShellAutoRunInstructions,
  type ShellToolOptions,
  type ShellToolResourceAccessor,
} from "../../../packages/agent/tools/core/shell/create-shell-tool.js";
import { buildSandShellAutoReviewTargetEnrichment } from "../sand-shell-auto-review-enrichment.js";
import { createSandShellApprovalProvider } from "../sand-auto-review-tool-escalations.js";
import type {
  SandAutoReviewController,
  SandAutoReviewExpiryPolicy,
  SandAutoReviewMode,
} from "../sand-auto-review.js";
import type { RequestContext } from "../../../packages/proto/generated/agent/v1/request_context_exec_pb.js";
import { SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS } from "../sand-auto-review-classifier-run.js";
import {
  createSandMultitaskTodoTool,
} from "../../sand-multitask.js";

export const SAND_EXTERNAL_MACHINE = resolveSandExternalMachine()!;

export const SAND_EXTERNAL_READ_TOOL_DESCRIPTION =
  `Reads a file on ${SAND_EXTERNAL_MACHINE.label}, the same filesystem ${SAND_EXTERNAL_SHELL_TOOL_NAME} acts on. That machine is NOT your own computer: it is reached over a connection the user has to approve, so use ${SAND_BOX_READ_TOOL_NAME} for everything on your own box, including your own files under /home/box.

Text files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.`;
export const SAND_BOX_READ_TOOL_DESCRIPTION =
  `Reads a file on your own computer (the box), the same filesystem ${SAND_BOX_SHELL_TOOL_NAME} and CopyToBox act on. This is your default surface, including your own files under /home/box. Use ${SAND_EXTERNAL_READ_TOOL_NAME} only for files on ${SAND_EXTERNAL_MACHINE.label}.

Text files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.`;
export const SAND_COMPUTER_USE_BOX_READ_TOOL_DESCRIPTION =
  `Reads a file on the box, the same filesystem ${SAND_BOX_SHELL_TOOL_NAME} acts on.

Text files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.`;

export const SHARED_ROOM_TOOL_NAMES = new Set([
  SAND_SEND_MESSAGE_TOOL_NAME,
  SAND_BOX_SHELL_TOOL_NAME,
  SAND_BOX_READ_TOOL_NAME,
  SAND_BOX_AWAIT_SHELL_TOOL_NAME,
  "Screenshot",
]);
export const SHARED_ROOM_TEXT_ONLY_TOOL_NAMES = new Set([
  SAND_SEND_MESSAGE_TOOL_NAME,
]);
export const SAND_FORCED_STATIC_TOOL_NAMES = new Set([
  SAND_UPDATE_STATE_TOOL_NAME,
  SAND_REACT_TO_MESSAGE_TOOL_NAME,
]);

export const SAND_DYNAMIC_TOOL_HINTS: Readonly<Record<string, string>> = {
  CLOUD_AGENT: "Launch and manage cloud coding agents for repository work.",
  SEARCH_PLUGINS: "Search installable plugins/connectors when a task needs a service.",
  AUTHENTICATE_MCP_SERVER: "Start authentication for a connector that needs auth.",
  COPY_TO_BOX: "Copy a file from the user's computer onto your box.",
  COPY_FROM_BOX: "Copy a file from your box onto the user's computer.",
  REQUEST_BOX_HELP: "Hand your box's desktop to the user for a sign-in or manual step.",
  [PROBLEM_REPORT_TOOL_ID]: PROBLEM_REPORT_TOOL_HINT,
  [SEND_EMAIL_TOOL_ID]: SEND_EMAIL_TOOL_HINT,
  [CODE_TASK_TOOL_ID]: CODE_TASK_TOOL_HINT,
  [CATALOG_SEARCH_TOOL_ID]: CATALOG_SEARCH_TOOL_HINT,
  [CATALOG_TEMPLATE_TOOL_ID]: CATALOG_TEMPLATE_TOOL_HINT,
  [CATALOG_SETUP_TOOL_ID]: CATALOG_SETUP_TOOL_HINT,
  CHECK_SUBAGENT: "Inspect a running background subagent's status and recent actions.",
  MESSAGE_SUBAGENT: "Send a new instruction into a running background subagent.",
  STOP_SUBAGENT: "Abort a running background subagent.",
};

export const SAND_READ_FORMATTING_OPTIONS = {
  shouldUseFormatCodeblock: false,
  gpt5StyleLineNumbers: false,
  gpt5CodexCatN: false,
  enableLineNumbers: true,
} as const;

export interface ToolExecutionContext {
  readonly directionEpoch?: number;
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}

export interface ToolMetadata {
  readonly toolCallId: string;
  readonly stateHandler?: unknown;
  readonly workspacePaths?: readonly string[];
}

export interface TurnTool {
  readonly [key: string]: unknown;
  readonly name: string;
  readonly id?: string;
  readonly toolIdentifier?: string;
  readonly description?: string;
  readonly contextType?: {
    readonly type: "static" | "dynamic";
    readonly conciseStaticContext?: string;
  };
  readonly dynamicToolMetaRole?: "invocation" | string;
  execute(...args: readonly unknown[]): Promise<unknown>;
}

type TaskToolParameters = Parameters<typeof createTaskTool>;
type TaskToolConfigFactory = TaskToolParameters[1];
type TaskToolConfig = Awaited<ReturnType<TaskToolConfigFactory>>;
type TaskToolSurface = TurnTool & Record<string, unknown>;
type StreamingTurnTool = TurnTool & {
  execute(
    context: unknown,
    interactionHandler: unknown,
    argumentsStream: AsyncIterable<string>,
    metadata: unknown,
  ): Promise<unknown>;
};

export type TurnToolsetBuildProps = ProductionTurnToolInputs;

export interface TurnToolsetTurnInput {
  /** The exact owner-scoped update relay installed for this prepared turn. */
  readonly emitUpdate?: (update: ForwardedUpdate) => void;
  readonly remoteBoxResourceAccessor?: ProductionTurnToolInputs["resourceAccessor"];
  readonly subagentConfigs?: TaskToolParameters[4];
  readonly autoReviewModes: ToolFactoryContext["autoReviewModes"];
  readonly stateHandler?: unknown;
  readonly toolSession?: TaskToolConfig["promptSession"];
  readonly config?: TaskToolConfig["agentConfig"];
  readonly summarizationHandler?: TaskToolConfig["summarizationHandler"];
  readonly parentModelInfo?: TaskToolParameters[2];
  readonly subagentModels?: TaskToolParameters[5]["subagentModels"];
  readonly geminiVideoAttachedMediaUrlProvider?: unknown;
  readonly cancelThisRun?: (reason: {
    readonly intentional: boolean;
    readonly reason: string;
  }) => void;
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
  /** Per-turn MCP descriptors used by the generated discovery/call pair. */
  readonly mcpTools?: readonly McpToolForMeta[];
  /**
   * LOOP-2. The send cap and the duplicate suppressor count per turn, but the toolset is rebuilt
   * every step, so their state cannot live in the tool. It rides on the turn instead and reaches
   * SendMessage through the host's tool inputs.
   */
  readonly sendBudget?: TurnSendBudget;
  /**
   * TOOLS-33. The per-turn tool-call ceiling counts across a whole turn, and the toolset is rebuilt
   * every step for the same reason the send cap is, so the counter cannot be born in the build. It
   * rides on the turn beside the send cap; `buildTurnTools` makes a fresh one only for a caller
   * that wired none.
   */
  readonly toolBudget?: TurnToolBudgetCounter;
  /**
   * JEV-2. This turn's Jev state, present only when SAND_JEV is on for the box. It carries the
   * evidence the turn has retrieved so far, which is what the claim check judges a negative
   * against, so the search and fetch wrappers write into it as results come back.
   */
  readonly jev?: JevTurn;
  /** Optional live Shell Smart Mode identities, supplied per turn by the host. */
  readonly shellAutoReview?: {
    readonly host?: TurnShellAutoReviewInput;
    readonly box?: TurnShellAutoReviewInput;
  };
}

export interface TurnShellAutoReviewInput {
  readonly mode: SandAutoReviewMode;
  readonly agentId: string;
  readonly surface: "host_machine" | "isolated_box";
  readonly requestContext: Pick<RequestContext, "env">;
  readonly controller?: Pick<SandAutoReviewController, "requestApproval">;
  readonly getApprovalExpiryPolicy: () => SandAutoReviewExpiryPolicy;
  readonly smartModeShellApprovalState?: {
    readonly getIdentity: () => string | undefined;
    readonly markSideEffectStart: () => void;
  };
  readonly userAutoRunInstructions?: ShellAutoRunInstructions;
  readonly projectAutoRunInstructions?: ShellAutoRunInstructions;
  readonly enforceModelFacingShellUiAutomationGuard: boolean;
}

/**
 * Resolves the live shell review identities at the same lazy per-turn point as
 * the shell resource accessor.  Explicit turn values win; an incomplete host
 * projection produces no Smart Mode options rather than synthetic approval or
 * request-context bindings.
 */
export function resolveTurnShellAutoReviewInputs(
  turn: TurnToolsetTurnInput,
  props: TurnToolsetBuildProps,
): TurnToolsetTurnInput["shellAutoReview"] {
  if (turn.shellAutoReview !== undefined) return turn.shellAutoReview;
  const autoReview = props.hostDependencies?.autoReview;
  const requestContext = autoReview?.requestContext;
  const agentId = autoReview?.agentId;
  if (autoReview === undefined || requestContext === undefined || agentId === undefined) {
    return undefined;
  }
  const modes = autoReview.getModes();
  const instructions = autoReview.getInstructions();
  const makeReview = (
    mode: SandAutoReviewMode,
    surface: TurnShellAutoReviewInput["surface"],
    approvalSurface: "host_shell" | "box_shell",
  ): TurnShellAutoReviewInput | undefined => {
    if (mode === "off") return undefined;
    const approvalState = autoReview.getShellApprovalState?.(approvalSurface);
    return {
      mode,
      agentId,
      surface,
      requestContext,
      controller: autoReview.controller,
      getApprovalExpiryPolicy: autoReview.getApprovalExpiryPolicy,
      ...(approvalState === undefined
        ? {}
        : {
            smartModeShellApprovalState: approvalState,
          }),
      ...(instructions === undefined
        ? {}
        : {
            userAutoRunInstructions: {
              allowInstructions: instructions.allowInstructions,
              blockInstructions: instructions.blockInstructions,
            },
          }),
      enforceModelFacingShellUiAutomationGuard:
        autoReview.enforceModelFacingShellUiAutomationGuard
        ?? (modes.hostShell === "enforce" || modes.computer === "enforce"),
    };
  };
  const host = makeReview(modes.hostShell, "host_machine", "host_shell");
  const box = makeReview(modes.boxShell, "isolated_box", "box_shell");
  return host === undefined && box === undefined
    ? undefined
    : {
        ...(host === undefined ? {} : { host }),
        ...(box === undefined ? {} : { box }),
      };
}

/**
 * Projects the exact immutable Shell Smart Mode options without creating host
 * identities. The resource accessor and review values are both per-turn; when
 * either is absent, the caller leaves the Shell branch fail-closed.
 */
export function createTurnShellAutoReviewOptions(input: {
  readonly resourceAccessor: ShellToolResourceAccessor;
  readonly options: ShellToolOptions;
  readonly review?: TurnShellAutoReviewInput;
}): ShellToolOptions {
  const { review } = input;
  if (review === undefined) return input.options;
  return {
    ...input.options,
    requestContext: review.requestContext,
    smartModeClassifierMode: review.mode === "enforce",
    smartModeClassifierShadowMode: review.mode === "shadow",
    smartModeApprovalSurface: review.surface,
    ...(review.controller === undefined || review.mode !== "enforce"
      ? {}
      : {
          smartModeApprovalProvider: createSandShellApprovalProvider({
            controller: review.controller,
            agentId: review.agentId,
            surface: review.surface === "host_machine" ? "host_shell" : "box_shell",
            getExpiryPolicy: review.getApprovalExpiryPolicy,
          }),
        }),
    smartModeShellTargetEnrichmentProvider: (context, args) =>
      buildSandShellAutoReviewTargetEnrichment(context, {
        resourceAccessor: args.resourceAccessor,
        command: args.command,
        ...(args.workingDirectory === undefined
          ? {}
          : { workingDirectory: args.workingDirectory }),
        toolCallId: args.toolCallId,
      }),
    ...(review.smartModeShellApprovalState === undefined
      ? {}
      : { smartModeShellApprovalState: review.smartModeShellApprovalState }),
    ...(review.userAutoRunInstructions === undefined
      ? {}
      : { userAutoRunInstructions: review.userAutoRunInstructions }),
    ...(review.projectAutoRunInstructions === undefined
      ? {}
      : { projectAutoRunInstructions: review.projectAutoRunInstructions }),
    smartModeClassifierMaxAttempts: SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS,
    suppressSmartModeClassifierTelemetryIds: true,
    loadSmartModeWorkspacePermissionFiles: false,
    disableSmartModeAllowlistPrecheck: true,
    enforceModelFacingShellUiAutomationGuard:
      review.enforceModelFacingShellUiAutomationGuard,
  };
}

export interface LocalToolPermission {
  completeScope(scope: {
    agentId: string;
    toolCallId: string;
    directionEpoch?: number;
    action?: string;
  }): void;
}

export function withDynamicToolPlacement<T extends TurnTool>(tool: T): T {
  if (SAND_FORCED_STATIC_TOOL_NAMES.has(tool.name)) {
    return {
      ...tool,
      contextType: { type: "static" },
    };
  }
  if (tool.contextType !== undefined) return tool;
  if (tool.toolIdentifier === undefined) return tool;
  const hint = SAND_DYNAMIC_TOOL_HINTS[tool.toolIdentifier];
  if (hint === undefined) return tool;
  return {
    ...tool,
    contextType: {
      type: "dynamic",
      conciseStaticContext: hint,
    },
  };
}

export function withLocalToolScope<T extends TurnTool>(
  tool: T,
  agentId: string,
  permission: LocalToolPermission | undefined,
  action?: SandLocalToolAction,
): T {
  if (permission === undefined) return tool;
  return {
    ...tool,
    async execute(
      context: Context,
      interactionHandler: unknown,
      argsStream: AsyncIterable<string>,
      metadata: ToolMetadata,
    ) {
      const directionEpoch = context.get(sandTurnDirectionEpochKey);
      const scope = {
        agentId,
        toolCallId: metadata.toolCallId,
        ...(directionEpoch === undefined
          ? {}
          : { directionEpoch }),
        ...(action === undefined ? {} : { action }),
      };
      try {
        return await tool.execute(
          context.with(sandLocalToolScopeKey, scope),
          interactionHandler,
          argsStream,
          metadata,
        );
      } finally {
        permission.completeScope(scope);
      }
    },
  };
}

export function withRecordedToolCallNames<T extends TurnTool>(
  tool: T,
  record: (toolCallId: string, toolName: string) => void,
): T {
  return {
    ...tool,
    execute(...args: readonly unknown[]) {
      const metadata = args.at(-1);
      if (
        typeof metadata !== "object"
        || metadata === null
        || !("toolCallId" in metadata)
        || typeof metadata.toolCallId !== "string"
      ) throw new TypeError("tool call metadata is not bound");
      record(metadata.toolCallId, tool.name);
      return tool.execute(...args);
    },
  };
}

/** Result attestation: hash and head of what a work tool returned, keyed to the current attempt. */
export function withAttestedResult<T extends TurnTool>(tool: T, agentId: string): T {
  if (!isWorkTool(tool.name)) return tool;
  return {
    ...tool,
    async execute(...args: readonly unknown[]) {
      const metadata = args.at(-1) as { toolCallId?: unknown } | undefined;
      const toolCallId = typeof metadata?.toolCallId === "string" ? metadata.toolCallId : "";
      try {
        const result = await tool.execute(...args);
        evidenceRegistry.attest(agentId, { toolCallId, tool: tool.name, ok: true, result });
        return result;
      } catch (error) {
        evidenceRegistry.attest(agentId, { toolCallId, tool: tool.name, ok: false, result: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };
}

export function withToolTimeout<T extends TurnTool>(
  tool: T,
  timeoutMs: number,
  createTimeoutError: () => Error = () =>
    createToolCallExecutionTimeoutError({
      toolName: tool.name,
      executionTimeoutMs: timeoutMs,
    }),
): T {
  return {
    ...tool,
    async execute(...args: readonly unknown[]) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          tool.execute(...args),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(createTimeoutError()),
              timeoutMs,
            );
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}

/** The one piece of shared state for a single toolset build. It counts tool calls, not tools. */
export interface TurnToolBudgetCounter {
  calls: number;
  loggedFirstRefusal: boolean;
}

export function createTurnToolBudgetCounter(): TurnToolBudgetCounter {
  return { calls: 0, loggedFirstRefusal: false };
}

/** The exact words a refused call sends back, with the budget substituted for `budgetCalls`. */
export function turnToolBudgetRefusalText(budgetCalls: number): string {
  return `Tool budget for this turn is spent (${budgetCalls} calls). Stop calling tools and write your answer now with what you have; say plainly what you could not establish.`;
}

/**
 * TOOLS-33. Every tool an agent can call is rebuilt on every model step; this wraps one of them so
 * that, together with a `counter` that spans the whole turn, the toolset may make at most `budget`
 * calls before the host refuses the rest. The counter therefore cannot be created here or in
 * `buildTurnTools` -- both run per step -- and comes from the turn instead. The cap is per turn, for
 * every agent and every skill: it reads `budget` once and never looks at what skill is active, and a
 * subagent turn is its own turn with its own handoff and therefore its own `counter`.
 *
 * Calls `1..budget` run the inner tool unchanged. Call `budget+1` and every later call do NOT run
 * the inner tool at all. Instead they throw a plain error carrying the refuse text, which the
 * engine's error path turns into the tool's own error result -- its `serializeError` carrying the
 * text -- so the model reads a normal tool failure, and in that very result is told to write
 * its answer now. Throwing is what the other per-turn wrappers in this file do for their own failure
 * mode, so the refusal takes the exact same shape a real tool error does and carries this exact
 * text. The first refusal logs one line at info level naming the agent id and the budget, so an
 * operator reading the log can see the cap held; the `loggedFirstRefusal` flag on the shared counter
 * keeps every later refusal in the same turn quiet.
 */
export function withTurnToolBudget<T extends TurnTool>(
  tool: T,
  budget: number,
  counter: TurnToolBudgetCounter,
  options: { readonly agentId?: string; readonly log?: (agentId: string, budget: number) => void } = {},
): T {
  return {
    ...tool,
    async execute(...args: readonly unknown[]) {
      counter.calls += 1;
      if (counter.calls > budget) {
        if (!counter.loggedFirstRefusal) {
          counter.loggedFirstRefusal = true;
          const agentId = options.agentId ?? "agent";
          const log = options.log
            ?? ((id: string, amount: number) =>
              console.info(
                `[sand][turn-tool-budget] conversation ${id}: per-turn tool budget of ${amount} is spent, refusing further tool calls this turn`,
              ));
          log(agentId, budget);
        }
        throw new Error(turnToolBudgetRefusalText(budget));
      }
      return tool.execute(...args);
    },
  };
}

export interface ToolFactoryContext {
  readonly autoReviewModes: {
    readonly hostShell: string;
    readonly boxShell: string;
    readonly mcp: string;
    readonly computer: string;
    readonly automationWrite: string;
    readonly cloudAgent: string;
    readonly subagentLaunch: string;
  };
  readonly stateHandler?: unknown;
}

export interface TurnToolFactories {
  task?(): TurnTool;
  multitask?(): TurnTool;
  sendMessage?(): TurnTool;
  sendToAgent?(): TurnTool;
  reaction?(): TurnTool;
  createAgent?(): TurnTool;
  updateAgent?(): TurnTool;
  updateState?(): TurnTool;
  externalShell?(): TurnTool | undefined;
  externalRead?(): TurnTool;
  externalAwait?(): TurnTool;
  webSearch?(): TurnTool;
  webFetch?(): TurnTool;
  generateImage?(): TurnTool;
  cloudAgent?(): TurnTool;
  boxShell?(): TurnTool | undefined;
  boxRead?(): TurnTool;
  boxAwait?(): TurnTool;
  fileTransfer?(): readonly TurnTool[];
  computer?(): TurnTool;
  browser?(): readonly TurnTool[];
  /** BROWSER-1: the four tools the main agent holds (browser_open/click/type/screenshot). */
  browserDirect?(): readonly TurnTool[];
  screenshot?(): TurnTool;
  requestBoxHelp?(): TurnTool;
  /** FEEDBACK-1. Unguarded: every agent has it, subagents and desktop-less boxes included. */
  problemReport?(): TurnTool;
  /** MAIL-3. Guarded, unlike problemReport: see the push in buildTurnTools for the four facts. */
  sendEmail?(): TurnTool;
  /** CODE-1. Guarded on the relay resolving, and never offered to a subagent runner. */
  codeTask?(): TurnTool;
  mcpMeta?(dynamicToolRegistry?: DynamicToolRegistry): readonly TurnTool[];
  mcpManagement?(): readonly TurnTool[];
  /** TITAN-CATALOG-1. The bots half of the Marketplace: search it, read one, set one up. */
  catalog?(): readonly TurnTool[];
  subagentManagement?(): readonly TurnTool[];
}

export type TurnTaskToolParameters = Parameters<typeof createTaskTool>;

/**
 * Exact per-turn inputs required by the shipped Task constructor. Keeping
 * this contract concrete prevents the production path from supplying a
 * generic factory map or losing resource/state/session identity.
 */
export interface TurnTaskToolFactoryInput {
  readonly resourceAccessor: TurnTaskToolParameters[0];
  readonly getTaskToolConfig: TurnTaskToolParameters[1];
  readonly parentModelInfo: TurnTaskToolParameters[2];
  readonly stateHandler: TurnTaskToolParameters[3];
  readonly subagentConfigs: TurnTaskToolParameters[4];
  readonly options: TurnTaskToolParameters[5];
}

/** Exact two-argument owner used by the shipped Multitask TodoWrite tool. */
export interface TurnMultitaskToolFactoryInput {
  readonly resourceAccessor: Parameters<typeof createSandMultitaskTodoTool>[0];
  readonly stateHandler: Parameters<typeof createSandMultitaskTodoTool>[1];
}

export interface TurnMcpMetaToolFactoryInput {
  readonly resourceAccessor: TaskToolParameters[0];
  readonly getMcpTools: () => readonly McpToolForMeta[];
  readonly callOptions: Omit<
    CreateCallMcpToolOptions,
    "resourceAccessor" | "mcpMetaToolOptions" | "dynamicToolRegistry"
  >;
  readonly discoveryOptions?: {
    readonly projectDir?: string;
    readonly allowInteractiveMcpAuth?: boolean;
    readonly isMcpToolBlocked?: CreateCallMcpToolOptions["isMcpToolBlocked"];
  };
}

export interface TurnComputerToolFactoryInput {
  readonly dependencies: ComputerToolDependencies<unknown>;
}

export interface TurnBrowserToolFactoryInput {
  readonly dependencies: BrowserDriverDependencies<unknown>;
}

export interface TurnFileTransferToolFactoryInput {
  readonly controller: FileTransferController;
}

export interface TurnBoxHelpToolFactoryInput {
  readonly dependencies: BoxHelpDependencies<unknown>;
}

export interface TurnProblemReportToolFactoryInput {
  readonly dependencies: ProblemReportDependencies;
}

export interface TurnSendEmailToolFactoryInput {
  readonly dependencies: SendEmailDependencies;
}

export interface TurnCodeTaskToolFactoryInput {
  readonly dependencies: CodeTaskDependencies;
}

export interface TurnCatalogToolFactoryInput {
  readonly dependencies: CatalogToolDependencies;
}

export interface TurnGenerateImageToolFactoryInput {
  readonly dependencies: GenerateImageToolDependencies;
}

export interface TurnWebSearchToolFactoryInput {
  readonly dependencies: WebSearchToolDependencies;
}

export interface TurnWebFetchToolFactoryInput {
  readonly dependencies: WebFetchToolDependencies;
}

export interface TurnAwaitToolFactoryInput {
  readonly resourceAccessor: AwaitToolResourceAccessor;
  readonly options: AwaitToolOptions;
  readonly promptVersion?: string;
}

export interface TurnShellToolFactoryInput {
  /** Fresh per-turn accessor from which createShellTool resolves shellStreamExecutorResource. */
  readonly resourceAccessor: ShellToolResourceAccessor;
  readonly options?: ShellToolOptions;
}

export interface TurnReadToolFactoryInput {
  readonly resourceAccessor: ReadResourceAccessor;
  readonly formattingOptions: ReadFormattingOptions;
  readonly promptVersion?: string;
  readonly options?: ReadToolOptions;
}

export interface TurnSendMessageToolFactoryInput {
  readonly dependencies: SendMessageDependencies<Context>;
}

export interface TurnSendToAgentToolFactoryInput {
  readonly dependencies: SendToAgentDependencies<unknown>;
}

export interface TurnReactionToolFactoryInput {
  readonly dependencies: ReactToMessageDependencies;
}

export interface TurnAgentManagementToolFactoryInput {
  readonly dependencies: AgentManagementDependencies;
}

export interface TurnStateToolFactoryInput {
  readonly dependencies: SandStateDependencies;
}

export interface TurnSubagentManagementToolFactoryInput {
  readonly controller: SubagentManagementController<unknown>;
}

export interface TurnMcpManagementToolFactoryInput {
  readonly management: McpManagementDependencies;
  readonly getRequestingAgentId?: Parameters<typeof createMcpManagementTools>[1];
  readonly isAwaitingUserSelection?: Parameters<typeof createMcpManagementTools>[2];
  readonly isMultiAccountEnabled?: Parameters<typeof createMcpManagementTools>[3];
  readonly emitConnectorCard?: Parameters<typeof createMcpManagementTools>[4];
}

export interface TurnCloudAgentToolFactoryInput {
  readonly dependencies: CloudAgentToolDeps;
}

export interface TurnToolsetFactoryInputs {
  readonly task?: TurnTaskToolFactoryInput;
  readonly multitask?: TurnMultitaskToolFactoryInput;
  readonly mcpMeta?: TurnMcpMetaToolFactoryInput;
  readonly computer?: TurnComputerToolFactoryInput;
  readonly browser?: TurnBrowserToolFactoryInput;
  readonly screenshot?: TurnComputerToolFactoryInput;
  readonly fileTransfer?: TurnFileTransferToolFactoryInput;
  readonly requestBoxHelp?: TurnBoxHelpToolFactoryInput;
  readonly problemReport?: TurnProblemReportToolFactoryInput;
  readonly sendEmail?: TurnSendEmailToolFactoryInput;
  readonly codeTask?: TurnCodeTaskToolFactoryInput;
  readonly generateImage?: TurnGenerateImageToolFactoryInput;
  readonly webSearch?: TurnWebSearchToolFactoryInput;
  readonly webFetch?: TurnWebFetchToolFactoryInput;
  readonly externalAwait?: TurnAwaitToolFactoryInput;
  readonly boxAwait?: TurnAwaitToolFactoryInput;
  readonly externalShell?: TurnShellToolFactoryInput;
  readonly externalRead?: TurnReadToolFactoryInput;
  readonly boxShell?: TurnShellToolFactoryInput;
  readonly boxRead?: TurnReadToolFactoryInput;
  readonly sendMessage?: TurnSendMessageToolFactoryInput;
  readonly sendToAgent?: TurnSendToAgentToolFactoryInput;
  readonly reaction?: TurnReactionToolFactoryInput;
  readonly agentManagement?: TurnAgentManagementToolFactoryInput;
  readonly state?: TurnStateToolFactoryInput;
  readonly subagentManagement?: TurnSubagentManagementToolFactoryInput;
  readonly mcpManagement?: TurnMcpManagementToolFactoryInput;
  readonly catalog?: TurnCatalogToolFactoryInput;
  readonly cloudAgent?: TurnCloudAgentToolFactoryInput;
}

/** Host-facing per-turn projection; resource/session identities stay fresh. */
export interface TurnToolsetHostFactoryProvider {
  readonly createTaskToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnTaskToolFactoryInput;
  readonly createMultitaskToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnMultitaskToolFactoryInput;
  readonly createMcpMetaToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnMcpMetaToolFactoryInput;
  readonly createComputerToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnComputerToolFactoryInput;
  readonly createBrowserToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnBrowserToolFactoryInput;
  readonly createScreenshotToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnComputerToolFactoryInput;
  readonly createFileTransferToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnFileTransferToolFactoryInput;
  readonly createRequestBoxHelpToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnBoxHelpToolFactoryInput;
  readonly createProblemReportToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnProblemReportToolFactoryInput;
  readonly createSendEmailToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnSendEmailToolFactoryInput;
  readonly createCodeTaskToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnCodeTaskToolFactoryInput;
  readonly createGenerateImageToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnGenerateImageToolFactoryInput;
  readonly createWebSearchToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnWebSearchToolFactoryInput;
  readonly createWebFetchToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnWebFetchToolFactoryInput;
  readonly createExternalAwaitToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnAwaitToolFactoryInput;
  readonly createBoxAwaitToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnAwaitToolFactoryInput;
  readonly createExternalShellToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnShellToolFactoryInput | undefined;
  /** Read is source-closed for ordinary text/images; PDF extraction remains an explicit option. */
  readonly createExternalReadToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnReadToolFactoryInput | undefined;
  readonly createBoxShellToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnShellToolFactoryInput | undefined;
  readonly createBoxReadToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnReadToolFactoryInput | undefined;
  readonly createSendMessageToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnSendMessageToolFactoryInput;
  readonly createSendToAgentToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnSendToAgentToolFactoryInput;
  readonly createReactionToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnReactionToolFactoryInput;
  readonly createAgentManagementToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnAgentManagementToolFactoryInput;
  readonly createStateToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnStateToolFactoryInput;
  readonly createSubagentManagementToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnSubagentManagementToolFactoryInput;
  readonly createMcpManagementToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnMcpManagementToolFactoryInput;
  readonly createCatalogToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnCatalogToolFactoryInput;
  readonly createCloudAgentToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnCloudAgentToolFactoryInput;
}

function isTurnTool<T extends object>(value: T): value is T & TurnTool {
  return typeof Reflect.get(value, "name") === "string"
    && typeof Reflect.get(value, "execute") === "function";
}

function asTurnTool<T extends object>(value: T): T & TurnTool {
  if (!isTurnTool(value)) {
    throw new TypeError("turn tool factory returned an invalid tool");
  }
  /**
   * The host tools are plain objects and six of them (Computer, the browser pair, file transfer,
   * box help, MCP management, subagent management) never defined `serializeError`. That method is
   * called from `executeToolResultOrError`'s CATCH block, so a tool that threw for any reason had
   * its real failure replaced by `tool.serializeError is not a function` -- the reporting path
   * destroyed the very error it existed to report, and a computerUse subagent surfaced only as
   * status "error" with nothing to read. Keep a tool's own serializer when it has one; otherwise
   * preserve the message rather than crashing the turn.
   */
  if (typeof (value as { readonly serializeError?: unknown }).serializeError !== "function") {
    return Object.assign(value, { serializeError: serializeGenericToolError }) as T & TurnTool;
  }
  return value;
}

function asGeneratedMcpMetaToolOptions(
  tools: readonly McpToolForMeta[],
): McpMetaToolOptions {
  const descriptors = new Map<string, McpDescriptor>();
  for (const tool of tools) {
    let descriptor = descriptors.get(tool.providerIdentifier);
    if (descriptor === undefined) {
      descriptor = new McpDescriptor({
        serverIdentifier: tool.providerIdentifier,
        serverName: tool.providerIdentifier,
        ...(typeof tool.plugin === "string" ? { plugin: tool.plugin } : {}),
        ...(typeof tool.marketplace === "string"
          ? { marketplace: tool.marketplace }
          : {}),
        ...(tool.pluginId === undefined ? {} : { pluginDbId: tool.pluginId }),
        ...(tool.marketplaceId === undefined
          ? {}
          : { marketplaceId: tool.marketplaceId }),
      });
      descriptors.set(tool.providerIdentifier, descriptor);
    }
    descriptor.tools.push(new McpToolDescriptor({
      toolName: tool.toolName,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(typeof tool.inputSchema === "string"
        ? { inputSchemaJson: tool.inputSchema }
        : {}),
    }));
  }
  for (const descriptor of descriptors.values()) {
    descriptor.tools.sort((left, right) => left.toolName.localeCompare(right.toolName));
  }
  return new McpMetaToolOptions({
    enabled: true,
    mcpDescriptors: [...descriptors.values()],
  });
}

/** Creates the artifact-backed Task factory from exact constructor inputs. */
export function createTurnTaskToolFactory(
  input: TurnTaskToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createTaskTool(
    input.resourceAccessor,
    input.getTaskToolConfig,
    input.parentModelInfo,
    input.stateHandler,
    input.subagentConfigs,
    input.options,
  ));
}

/** Creates the exact shipped Multitask TodoWrite owner; plan synchronization
 * remains inside that owner and therefore retains its worker/error boundary. */
export function createTurnMultitaskToolFactory(
  input: TurnMultitaskToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createSandMultitaskTodoTool(
    input.resourceAccessor,
    input.stateHandler,
  ));
}

/**
 * Creates the artifact-backed MCP discovery/call pair. The descriptor getter
 * is evaluated for each tool build, and the dynamic registry is supplied by
 * buildTurnTools after its placement gate has run.
 */
export function createTurnMcpMetaToolFactory(
  input: TurnMcpMetaToolFactoryInput,
): (dynamicToolRegistry?: DynamicToolRegistry) => readonly TurnTool[] {
  return (dynamicToolRegistry) => {
    const mcpMetaToolOptions = asGeneratedMcpMetaToolOptions(input.getMcpTools());
    const discovery = createGetMcpToolsTool(mcpMetaToolOptions, {
      resourceAccessor: input.resourceAccessor,
      ...(input.discoveryOptions?.projectDir === undefined
        ? {}
        : { projectDir: input.discoveryOptions.projectDir }),
      ...(input.discoveryOptions?.allowInteractiveMcpAuth === undefined
        ? {}
        : { allowInteractiveMcpAuth: input.discoveryOptions.allowInteractiveMcpAuth }),
      ...(input.discoveryOptions?.isMcpToolBlocked === undefined
        ? {}
        : { isMcpToolBlocked: input.discoveryOptions.isMcpToolBlocked }),
      ...(dynamicToolRegistry === undefined ? {} : { dynamicToolRegistry }),
    });
    const call = createCallMcpTool({
      ...input.callOptions,
      resourceAccessor: input.resourceAccessor,
      mcpMetaToolOptions,
      ...(dynamicToolRegistry === undefined ? {} : { dynamicToolRegistry }),
    });
    return [asTurnTool(discovery), asTurnTool(call)];
  };
}

/**
 * `createComputerTool` / `createScreenshotTool` are INNER tools: `execute(raw, meta)` returning a
 * plain `{ result: { case, value } }`, with `render(result)`. The Agent engine speaks a different
 * contract entirely -- `execute(context, interactionHandler, argsStream, metadata)` returning a
 * protobuf, `render(ctx, result, props)`, and a `serializeError` producing a real
 * `agent.v1.ToolCall` carrier. The reconstruction kept the inner tools and lost the adapter
 * between them, so the tool parsed the *context object* as its arguments and every call died on
 * `action: received undefined`. That read like the model omitting a required field; in fact the
 * arguments never reached the tool. `createZodAgentTool` + `withSafeParsedArgs` is the same
 * bridge every engine-native tool (WebSearch, Task, Shell) is built on.
 */
function toComputerUseMessage(inner: unknown): ComputerUseResultMessage {
  const outcome = (inner as { readonly result?: { readonly case?: string; readonly value?: unknown } } | null)?.result;
  if (outcome?.case === "success") {
    const value = (outcome.value ?? {}) as { readonly screenshot?: string; readonly screenshotPath?: string; readonly log?: string; readonly actionCount?: number; readonly durationMs?: number };
    return new ComputerUseResultMessage({ result: { case: "success", value: new ComputerUseSuccessMessage({
      ...(value.screenshot == null ? {} : { screenshot: value.screenshot }),
      ...(value.screenshotPath == null ? {} : { screenshotPath: value.screenshotPath }),
      ...(value.log == null ? {} : { log: value.log }),
      // Carried through rather than dropped. Both fields exist on the message and defaulted to 0
      // because this adapter never copied them, which is what made a busy subagent look idle on
      // Jason's box (report 45); sand-computer-tool.ts carries the measurement.
      ...(value.actionCount == null ? {} : { actionCount: value.actionCount }),
      ...(value.durationMs == null ? {} : { durationMs: value.durationMs }),
    }) } });
  }
  const error = (outcome?.value as { readonly error?: string } | undefined)?.error;
  return new ComputerUseResultMessage({ result: { case: "error", value: new ComputerUseErrorMessage({
    error: error ?? "the computer action returned no result",
  }) } });
}

function computerUseCarrier(result: ComputerUseResultMessage): ToolCall {
  return new ToolCall({ tool: { case: "computerUseToolCall", value: new ComputerUseToolCall({ result }) } });
}

function adaptInnerComputerTool<T extends {
  readonly name: string;
  readonly id?: string;
  readonly parameters: Parameters<typeof withSafeParsedArgs>[0];
  execute(raw: unknown, meta: Record<string, unknown>): Promise<unknown>;
}>(tool: T, operation: "computer" | "screenshot"): TurnTool {
  return createZodAgentTool(tool.id ?? "OPENAI_COMPUTER_USE", {
    name: tool.name,
    descriptionGenerator: () => operation === "screenshot"
      ? "Capture your box's desktop and return the image, so you can see what is on screen before acting on it."
      : [
        "Drive your box's desktop: screenshot, click, move, drag, type, key, scroll, wait.",
        "Coordinates are screen pixels from the top-left of the desktop. Every call returns a fresh",
        "screenshot, so take one first and act on what you actually see rather than where you expect",
        "things to be. Chain follow-up actions with `then` when they depend on the same screen state.",
      ].join(" "),
    parameters: tool.parameters as never,
    execute: withSafeParsedArgs(
      tool.parameters,
      async (ctx, _interactionHandler, args, meta) => toComputerUseMessage(
        await tool.execute(args, { context: ctx, toolCallId: meta?.toolCallId ?? "" }),
      ),
      computerUseCarrier(new ComputerUseResultMessage()),
    ),
    /**
     * The executor walks `content` as an ARRAY of typed parts. Returning a bare string meant it
     * iterated the characters, found no `type: "text"` part, and dropped the whole result -- so a
     * screenshot the tool successfully captured never reached the model at all. Hand back real
     * parts, and carry the image when there is one.
     */
    render: (_ctx: unknown, result: ComputerUseResultMessage) => {
      const text = describeOutcome(result as never, operation);
      const outcome = (result as { readonly result?: { readonly case?: string; readonly value?: unknown } } | null)?.result;
      const screenshot = outcome?.case === "success"
        ? (outcome.value as { readonly screenshot?: string } | undefined)?.screenshot
        : undefined;
      return screenshot != null && screenshot.length > 0
        ? createImageResult(screenshot, "image/webp", text)
        : createStringResult(text);
    },
    serializeError: (error: unknown) => computerUseCarrier(new ComputerUseResultMessage({
      result: { case: "error", value: new ComputerUseErrorMessage({
        error: error instanceof Error ? error.message : String(error),
      }) },
    })),
  }) as unknown as TurnTool;
}

export function createTurnComputerToolFactory(
  input: TurnComputerToolFactoryInput,
): () => TurnTool {
  return () => adaptInnerComputerTool(createComputerTool(input.dependencies), "computer");
}

export function createTurnScreenshotToolFactory(
  input: TurnComputerToolFactoryInput,
): () => TurnTool {
  return () => adaptInnerComputerTool(createScreenshotTool(input.dependencies), "screenshot");
}

/**
 * SUB-1 / TOOLS-03. The browser tools kept Cursor's `execute(context, args, metadata)` order,
 * but this core calls a tool as `execute(ctx, interactionHandler, args, meta)` -- so the args
 * slot held the interaction handler, `metadata` held the model's arguments, and every call
 * failed with "url is required" while the model had sent the URL. The file-transfer tools
 * already go through `defineCommunicateTool`, which parses the arguments against the zod
 * schema and hands the driver a plain string result; the browser tools take the same road.
 * The model receives the driver's text (page snapshots, URLs, summaries) and, when the driver
 * captured one, the per-action screenshot as an image part (SUB-2).
 */
export function createTurnBrowserToolFactory(
  input: TurnBrowserToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createSandBrowserTools(input.dependencies).map((tool) => defineCommunicateTool({}, {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    execute: async (ctx, args: Record<string, unknown>, deps) => {
      const output = await tool.execute(ctx as never, args, { toolCallId: deps.toolCallId });
      if (output.isError === true) throw new Error(output.text);
      // BROWSER-1. The driver's own type travels with the bytes. This said "image/png" for every
      // shot, which was true while the only driver took PNGs and became a lie the moment Titan's
      // took a JPEG: a provider told png and handed jpeg bytes fails to decode, with nothing in
      // the message worth reading.
      return output.imageB64 != null && output.imageB64.length > 0
        ? { text: output.text, imageB64: output.imageB64, mimeType: output.mimeType ?? "image/png" }
        : output.text;
    },
  }) as unknown as TurnTool);
}

/**
 * BROWSER-1. The main agent's four browser tools, wrapped exactly like the fifteen: the model gets
 * the driver's text and, when the driver captured one, that action's single screenshot as an image
 * part. Same input as the browser factory, because it is the same driver on the same box.
 */
export function createTurnDirectBrowserToolFactory(
  input: TurnBrowserToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createSandDirectBrowserTools(input.dependencies).map((tool) => defineCommunicateTool({}, {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    execute: async (ctx, args: Record<string, unknown>, deps) => {
      const output = await tool.execute(ctx as never, args, { toolCallId: deps.toolCallId });
      if (output.isError === true) throw new Error(output.text);
      // BROWSER-1. The driver's own type travels with the bytes. This said "image/png" for every
      // shot, which was true while the only driver took PNGs and became a lie the moment Titan's
      // took a JPEG: a provider told png and handed jpeg bytes fails to decode, with nothing in
      // the message worth reading.
      return output.imageB64 != null && output.imageB64.length > 0
        ? { text: output.text, imageB64: output.imageB64, mimeType: output.mimeType ?? "image/png" }
        : output.text;
    },
  }) as unknown as TurnTool);
}

export function createTurnFileTransferToolFactory(
  input: TurnFileTransferToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createFileTransferTools(input.controller).map(asTurnTool);
}

export function createTurnBoxHelpToolFactory(
  input: TurnBoxHelpToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createRequestBoxHelpTool(input.dependencies));
}

export function createTurnProblemReportToolFactory(
  input: TurnProblemReportToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createProblemReportTool(input.dependencies));
}

export function createTurnSendEmailToolFactory(
  input: TurnSendEmailToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createSendEmailTool(input.dependencies));
}

export function createTurnCodeTaskToolFactory(
  input: TurnCodeTaskToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createCodeTaskTool(input.dependencies));
}

export function createTurnGenerateImageToolFactory(
  input: TurnGenerateImageToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createGenerateImageTool(input.dependencies));
}

export function createTurnWebSearchToolFactory(
  input: TurnWebSearchToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createWebSearchTool(input.dependencies));
}

export function createTurnWebFetchToolFactory(
  input: TurnWebFetchToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createWebFetchTool(input.dependencies));
}

export function createTurnAwaitToolFactory(
  input: TurnAwaitToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createAwaitTool(
    input.resourceAccessor,
    input.options,
    input.promptVersion,
  ));
}

export function createTurnShellToolFactory(
  input: TurnShellToolFactoryInput,
): () => TurnTool | undefined {
  return () => {
    const tool = createShellTool(input.resourceAccessor, input.options);
    return tool === undefined ? undefined : asTurnTool(tool);
  };
}

export function createTurnReadToolFactory(
  input: TurnReadToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createReadTool(
    input.resourceAccessor,
    input.formattingOptions,
    input.promptVersion,
    input.options,
  ));
}

export function createTurnSendMessageToolFactory(
  input: TurnSendMessageToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createSendMessageTool(input.dependencies));
}

export function createTurnSendToAgentToolFactory(
  input: TurnSendToAgentToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createSendToAgentTool(input.dependencies));
}

export function createTurnReactionToolFactory(
  input: TurnReactionToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createReactToMessageTool(input.dependencies));
}

export function createTurnCreateAgentToolFactory(
  input: TurnAgentManagementToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createCreateAgentTool(input.dependencies));
}

export function createTurnUpdateAgentToolFactory(
  input: TurnAgentManagementToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createUpdateAgentTool(input.dependencies));
}

export function createTurnStateToolFactory(
  input: TurnStateToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createSandStateTool(input.dependencies));
}

export function createTurnSubagentManagementToolFactory(
  input: TurnSubagentManagementToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createSubagentManagementTools(input.controller).map(asTurnTool);
}

export function createTurnMcpManagementToolFactory(
  input: TurnMcpManagementToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createMcpManagementTools(
    input.management,
    input.getRequestingAgentId,
    input.isAwaitingUserSelection,
    input.isMultiAccountEnabled,
    input.emitConnectorCard,
  ).map(asTurnTool);
}

export function createTurnCatalogToolFactory(
  input: TurnCatalogToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createCatalogTools(input.dependencies).map(asTurnTool);
}

export function createTurnCloudAgentToolFactory(
  input: TurnCloudAgentToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createCloudAgentTool(input.dependencies));
}

/**
 * Concrete producer for the currently closed turn-tool owners. Read's
 * ordinary text/image path is source-closed; PDF extraction remains an
 * explicit injected option. Shell uses the released shellStreamExecutorResource boundary;
 * Web, image, and await use their exact per-turn contracts above.
 * Multitask uses the source-closed UpdateTodos/plan-sync owner and remains
 * absent unless its exact per-turn resource/state inputs are supplied.
 */
export function createTurnToolsetFactories(
  input: TurnToolsetFactoryInputs,
): Pick<
  TurnToolFactories,
  "task" | "mcpMeta" | "computer" | "browser" | "browserDirect" | "screenshot"
  | "fileTransfer" | "requestBoxHelp" | "problemReport" | "sendEmail" | "codeTask" | "generateImage" | "webSearch" | "webFetch" | "externalAwait"
  | "boxAwait" | "externalShell" | "externalRead" | "boxShell" | "boxRead"
  | "sendMessage" | "sendToAgent" | "reaction" | "createAgent" | "updateAgent" | "updateState"
  | "subagentManagement"
  | "mcpManagement" | "catalog" | "cloudAgent"
> {
  return {
    ...(input.task === undefined
      ? {}
      : { task: createTurnTaskToolFactory(input.task) }),
    ...(input.multitask === undefined
      ? {}
      : { multitask: createTurnMultitaskToolFactory(input.multitask) }),
    ...(input.mcpMeta === undefined
      ? {}
      : { mcpMeta: createTurnMcpMetaToolFactory(input.mcpMeta) }),
    ...(input.computer === undefined
      ? {}
      : { computer: createTurnComputerToolFactory(input.computer) }),
    ...(input.browser === undefined
      ? {}
      : {
        browser: createTurnBrowserToolFactory(input.browser),
        // BROWSER-1. Both sets are built from the one browser input the host already supplies per
        // turn; which of them a runner is offered is decided by the predicates in buildTurnTools,
        // never by which factory exists.
        browserDirect: createTurnDirectBrowserToolFactory(input.browser),
      }),
    ...(input.screenshot === undefined
      ? {}
      : { screenshot: createTurnScreenshotToolFactory(input.screenshot) }),
    ...(input.fileTransfer === undefined
      ? {}
      : { fileTransfer: createTurnFileTransferToolFactory(input.fileTransfer) }),
    ...(input.requestBoxHelp === undefined
      ? {}
      : { requestBoxHelp: createTurnBoxHelpToolFactory(input.requestBoxHelp) }),
    ...(input.problemReport === undefined
      ? {}
      : { problemReport: createTurnProblemReportToolFactory(input.problemReport) }),
    ...(input.sendEmail === undefined
      ? {}
      : { sendEmail: createTurnSendEmailToolFactory(input.sendEmail) }),
    ...(input.codeTask === undefined
      ? {}
      : { codeTask: createTurnCodeTaskToolFactory(input.codeTask) }),
    ...(input.generateImage === undefined
      ? {}
      : { generateImage: createTurnGenerateImageToolFactory(input.generateImage) }),
    ...(input.webSearch === undefined
      ? {}
      : { webSearch: createTurnWebSearchToolFactory(input.webSearch) }),
    ...(input.webFetch === undefined
      ? {}
      : { webFetch: createTurnWebFetchToolFactory(input.webFetch) }),
    ...(input.externalAwait === undefined
      ? {}
      : { externalAwait: createTurnAwaitToolFactory(input.externalAwait) }),
    ...(input.boxAwait === undefined
      ? {}
      : { boxAwait: createTurnAwaitToolFactory(input.boxAwait) }),
    ...(input.externalShell === undefined
      ? {}
      : { externalShell: createTurnShellToolFactory(input.externalShell) }),
    ...(input.externalRead === undefined
      ? {}
      : { externalRead: createTurnReadToolFactory(input.externalRead) }),
    ...(input.boxShell === undefined
      ? {}
      : { boxShell: createTurnShellToolFactory(input.boxShell) }),
    ...(input.boxRead === undefined
      ? {}
      : { boxRead: createTurnReadToolFactory(input.boxRead) }),
    ...(input.sendMessage === undefined
      ? {}
      : { sendMessage: createTurnSendMessageToolFactory(input.sendMessage) }),
    ...(input.sendToAgent === undefined
      ? {}
      : { sendToAgent: createTurnSendToAgentToolFactory(input.sendToAgent) }),
    ...(input.reaction === undefined
      ? {}
      : { reaction: createTurnReactionToolFactory(input.reaction) }),
    ...(input.agentManagement === undefined
      ? {}
      : {
        createAgent: createTurnCreateAgentToolFactory(input.agentManagement),
        updateAgent: createTurnUpdateAgentToolFactory(input.agentManagement),
      }),
    ...(input.state === undefined
      ? {}
      : { updateState: createTurnStateToolFactory(input.state) }),
    ...(input.subagentManagement === undefined
      ? {}
      : {
        subagentManagement: createTurnSubagentManagementToolFactory(
          input.subagentManagement,
        ),
      }),
    ...(input.mcpManagement === undefined
      ? {}
      : {
        mcpManagement: createTurnMcpManagementToolFactory(input.mcpManagement),
      }),
    ...(input.catalog === undefined
      ? {}
      : { catalog: createTurnCatalogToolFactory(input.catalog) }),
    ...(input.cloudAgent === undefined
      ? {}
      : { cloudAgent: createTurnCloudAgentToolFactory(input.cloudAgent) }),
  };
}

export function createTurnToolsetFactoriesForTurn(
  provider: TurnToolsetHostFactoryProvider,
  turn: TurnToolsetTurnInput,
  props: TurnToolsetBuildProps,
): ReturnType<typeof createTurnToolsetFactories> {
  const externalShell = provider.createExternalShellToolInputs?.(turn, props);
  const externalRead = provider.createExternalReadToolInputs?.(turn, props);
  const boxShell = provider.createBoxShellToolInputs?.(turn, props);
  const boxRead = provider.createBoxReadToolInputs?.(turn, props);
  return createTurnToolsetFactories({
    ...(provider.createTaskToolInputs === undefined
      ? {}
      : { task: provider.createTaskToolInputs(turn, props) }),
    ...(provider.createMultitaskToolInputs === undefined
      ? {}
      : { multitask: provider.createMultitaskToolInputs(turn, props) }),
    ...(provider.createMcpMetaToolInputs === undefined
      ? {}
      : { mcpMeta: provider.createMcpMetaToolInputs(turn, props) }),
    ...(provider.createComputerToolInputs === undefined
      ? {}
      : { computer: provider.createComputerToolInputs(turn, props) }),
    ...(provider.createBrowserToolInputs === undefined
      ? {}
      : { browser: provider.createBrowserToolInputs(turn, props) }),
    ...(provider.createScreenshotToolInputs === undefined
      ? {}
      : { screenshot: provider.createScreenshotToolInputs(turn, props) }),
    ...(provider.createFileTransferToolInputs === undefined
      ? {}
      : { fileTransfer: provider.createFileTransferToolInputs(turn, props) }),
    ...(provider.createRequestBoxHelpToolInputs === undefined
      ? {}
      : { requestBoxHelp: provider.createRequestBoxHelpToolInputs(turn, props) }),
    ...(provider.createProblemReportToolInputs === undefined
      ? {}
      : { problemReport: provider.createProblemReportToolInputs(turn, props) }),
    ...(provider.createSendEmailToolInputs === undefined
      ? {}
      : { sendEmail: provider.createSendEmailToolInputs(turn, props) }),
    ...(provider.createCodeTaskToolInputs === undefined
      ? {}
      : { codeTask: provider.createCodeTaskToolInputs(turn, props) }),
    ...(provider.createGenerateImageToolInputs === undefined
      ? {}
      : { generateImage: provider.createGenerateImageToolInputs(turn, props) }),
    ...(provider.createWebSearchToolInputs === undefined
      ? {}
      : { webSearch: provider.createWebSearchToolInputs(turn, props) }),
    ...(provider.createWebFetchToolInputs === undefined
      ? {}
      : { webFetch: provider.createWebFetchToolInputs(turn, props) }),
    ...(provider.createExternalAwaitToolInputs === undefined
      ? {}
      : { externalAwait: provider.createExternalAwaitToolInputs(turn, props) }),
    ...(provider.createBoxAwaitToolInputs === undefined
      ? {}
      : { boxAwait: provider.createBoxAwaitToolInputs(turn, props) }),
    ...(provider.createExternalShellToolInputs === undefined
      ? {}
      : externalShell === undefined ? {} : { externalShell }),
    ...(provider.createExternalReadToolInputs === undefined
      ? {}
      : externalRead === undefined ? {} : { externalRead }),
    ...(provider.createBoxShellToolInputs === undefined
      ? {}
      : boxShell === undefined ? {} : { boxShell }),
    ...(provider.createBoxReadToolInputs === undefined
      ? {}
      : boxRead === undefined ? {} : { boxRead }),
    ...(provider.createSendMessageToolInputs === undefined
      ? {}
      : { sendMessage: provider.createSendMessageToolInputs(turn, props) }),
    ...(provider.createSendToAgentToolInputs === undefined
      ? {}
      : { sendToAgent: provider.createSendToAgentToolInputs(turn, props) }),
    ...(provider.createReactionToolInputs === undefined
      ? {}
      : { reaction: provider.createReactionToolInputs(turn, props) }),
    ...(provider.createAgentManagementToolInputs === undefined
      ? {}
      : { agentManagement: provider.createAgentManagementToolInputs(turn, props) }),
    ...(provider.createStateToolInputs === undefined
      ? {}
      : { state: provider.createStateToolInputs(turn, props) }),
    ...(provider.createSubagentManagementToolInputs === undefined
      ? {}
      : {
        subagentManagement: provider.createSubagentManagementToolInputs(
          turn,
          props,
        ),
      }),
    ...(provider.createMcpManagementToolInputs === undefined
      ? {}
      : {
        mcpManagement: provider.createMcpManagementToolInputs(turn, props),
      }),
    ...(provider.createCatalogToolInputs === undefined
      ? {}
      : {
        catalog: provider.createCatalogToolInputs(turn, props),
      }),
    ...(provider.createCloudAgentToolInputs === undefined
      ? {}
      : {
        cloudAgent: provider.createCloudAgentToolInputs(turn, props),
      }),
  });
}

export interface TurnToolsetHost {
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isBoxScopedSubagent: boolean;
  readonly isComputerUseSubagent: boolean;
  readonly isBrowserUseSubagent: boolean;
  readonly isSystemPromptOverridden: boolean;
  readonly remoteBoxHasDesktop: boolean;
  readonly localToolPermission?: LocalToolPermission;
  getConversationId(): string;
  getRemoteBoxAvailable(): boolean;
  cloudAgentsDisabledByTeam(): boolean;
  /** CLOUD-1: cloud agents are a Cursor product surface; on a self-hosted box the tool can only fail. Undefined means offered. */
  cloudAgentsAvailable?(): boolean;
  /**
   * TOOLS-15: whether a computer is connected over the local-exec bridge. The five host-machine
   * tools (ExternalShell, ExternalRead, AwaitExternalShell, CopyToBox, CopyFromBox) all travel
   * that one channel, so with nothing on the far end the model waits out a request nobody
   * answers. Undefined means offered.
   */
  localMachineConnected?(): boolean;
  /** TOOLS-15: "bridge" when the answer is the live local-exec liveness window, "setting" when an operator pinned it. */
  localMachineSource?(): "bridge" | "setting";
  spotlightEnabled(): boolean;
  /**
   * ONBOARD-1: whether this box is mid first-run setup, which is the only time
   * `save_onboarding_answer` and `finish_onboarding` are offered. Undefined reads the box's own
   * settings document.
   */
  isOnboardingActive?(): boolean;
  isDynamicToolsEnabled?(): boolean;
  isMultitaskEnabled?(): boolean;
  isSharedRoomBoxToolsEnabled?(): boolean;
  /**
   * BROWSER-1: whether the main agent is offered browser_open / browser_click / browser_type /
   * browser_screenshot. Default ON -- undefined means offered -- so only an operator writing
   * SAND_BROWSER_TOOLS=0 into the host settings file takes Titan's browser away.
   */
  isBrowserToolsEnabled?(): boolean;
  recordModelToolName?(toolCallId: string, name: string): void;
  toolExecutionTimeoutMs?(toolName: string): number;
  /**
   * Base per-turn provider.  It is projected with runtime props only by the
   * lazy toolsGenerator boundary; keeping it here avoids requiring a
   * ConversationStateHandle during Agent construction.
   */
  factoryProvider?: TurnToolsetHostFactoryProvider;
  factories: TurnToolFactories;
}

export type TurnToolsetInput = TurnToolsetTurnInput;

export function extractSandAutoReviewClassifierContext(
  messages: readonly { readonly role: string; readonly content: string }[],
): readonly { readonly role: string; readonly content: string }[] {
  return messages.filter((message) => {
    if (message.role !== "user") return true;
    if (
      message.content.startsWith(
        `${SAND_HIDDEN_PROMPT_MARKER}${SAND_TRUSTED_AUTOMATION_PROMPT_MARKER}`,
      )
    ) return true;
    return !message.content.startsWith(SAND_HIDDEN_PROMPT_MARKER);
  });
}

export function buildTurnTools(
  host: TurnToolsetHost,
  turn: TurnToolsetInput,
  props?: TurnToolsetBuildProps,
): ToolSetHandle {
  if (
    host.isSubagentRunner
    && (host.isComputerUseSubagent || host.isBrowserUseSubagent) === false
    && turn.subagentConfigs === undefined
  ) {
    return fencedToolSet([], host.spotlightEnabled());
  }

  const dynamicToolsEnabled =
    !host.isSubagentRunner
    && !host.isSharedRoomRunner
    && !host.isBoxScopedSubagent
    && host.isDynamicToolsEnabled?.() === true;
  const dynamicToolRegistry = dynamicToolsEnabled
    ? new DynamicToolRegistry()
    : undefined;
  const dynamicInvocationRegistry = dynamicToolRegistry === undefined
    ? undefined
    : {
      resolveToolName(rawArguments: string): string | undefined {
        return resolveDynamicDispatchToolName(rawArguments, dynamicToolRegistry);
      },
    };
  const tools: TurnTool[] = [];
  const factories = host.factories;

  if (
    !host.isSubagentRunner
    && !host.isSharedRoomRunner
    && turn.subagentConfigs != null
  ) {
    const tool = props === undefined
      ? factories.task?.()
      : createTurnTaskToolFactory({
        resourceAccessor: props.resourceAccessor as TaskToolParameters[0],
        getTaskToolConfig: async () => ({
          agentConfig: {
            ...props.config,
            toolsGenerator: () => fencedToolSet([], host.spotlightEnabled()),
          },
          promptSession: props.toolSession,
          summarizationHandler: props.summarizationHandler,
        }),
        parentModelInfo: props.parentModelInfo as TaskToolParameters[2],
        stateHandler: props.stateHandler as unknown as TaskToolParameters[3],
        subagentConfigs: turn.subagentConfigs,
        options: {
          readonlyShellEnabled: false,
          allowCustomModelId: false,
          includeExploreSubagent: false,
          subagentModels: props.subagentModels,
          requireServerSideSubagent: false,
          compareModelCosts: () => 0,
          isModelBlocked: () => false,
          isModelValid: () => true,
          useClientSideSubagent: true,
          enableExploreParentModelInheritance: true,
          enableJobCompletionNotifications: true,
          geminiVideoAttachedMediaUrlProvider: turn.geminiVideoAttachedMediaUrlProvider,
          enableAgentChatLinks: false,
          trustedVideoAttachmentRoots: host.remoteBoxHasDesktop
            ? [SAND_BOX_WORKSPACE_ROOT]
            : [],
        } as unknown as TaskToolParameters[5],
      })();
    if (tool !== undefined) tools.push(tool);
  }
  if (
    !host.isSubagentRunner
    && !host.isSystemPromptOverridden
    && host.isMultitaskEnabled?.() === true
  ) {
    const tool = factories.multitask?.();
    if (tool !== undefined) tools.push(tool);
  }
  if (!host.isSubagentRunner) {
    const sendMessage = factories.sendMessage?.();
    if (sendMessage !== undefined) tools.push(sendMessage);
    const sendToAgent = factories.sendToAgent?.();
    if (sendToAgent !== undefined) tools.push(sendToAgent);
    const reaction = factories.reaction?.();
    if (reaction !== undefined) tools.push(reaction);
    const createAgent = factories.createAgent?.();
    if (createAgent !== undefined) tools.push(createAgent);
    const updateAgent = factories.updateAgent?.();
    if (updateAgent !== undefined) tools.push(updateAgent);
    // TITAN-CATALOG-1. Deliberately in this block and not one of its own, because the brief asked
    // for "the same predicate the existing create-agent path uses" and this IS that predicate:
    // `!host.isSubagentRunner`, three lines up, is the only gate CreateAgent has ever had. There is
    // no per-agent "allowed to create agents" mark anywhere in this tree (grep for canCreateAgents,
    // allowCreateAgent, createAgentsAllowed: nothing), and createAgent is pushed here rather than
    // through the `scoped` helper below, so it carries no local-tool permission either. Gating the
    // catalog narrower than CreateAgent would mean a bot that may build a blank agent but may not
    // build a good one, which is the opposite of the point. `readLeadAgentId` exists and has only
    // ever driven a prompt paragraph; if lead-only is ever wanted it is its own item.
    const catalog = factories.catalog?.();
    if (catalog !== undefined) tools.push(...catalog);
    if (!host.isSystemPromptOverridden) {
      const updateState = factories.updateState?.();
      if (updateState !== undefined) tools.push(updateState);
    }
    // ONBOARD-1. Offered only while this box's first-run record says done:false, so they exist for
    // the length of one interview and then stop being built at all. `host.isOnboardingActive`
    // lets a test pin the answer; the default reads the box's settings document, the same way the
    // trace switch a few lines down reads the operator's.
    //
    // Two tools, and the second one is the interview's ending: nothing else on the box ever marks
    // the record done, so without `finish_onboarding` the only way out of the setup window was the
    // button that says the person skipped it.
    if ((host.isOnboardingActive ?? isOnboardingActive)()) {
      tools.push(asTurnTool(createSaveOnboardingAnswerTool()));
      tools.push(asTurnTool(createFinishOnboardingTool()));
    }
  }

  const agentId = host.getConversationId();
  const scoped = (
    tool: TurnTool | undefined,
    action?: SandLocalToolAction,
  ): TurnTool | undefined => tool == null
    ? undefined
    : withLocalToolScope(
      withRecordedToolCallNames(
        tool,
        (toolCallId, name) =>
          host.recordModelToolName?.(toolCallId, name),
      ),
      agentId,
      host.localToolPermission,
      action,
    );

  // Named here, reported on the trace line below: a tool the build could have offered and did
  // not, with the reason, so an operator reading "30 tools" can tell a withheld tool from a
  // missing one.
  const withheld: { readonly tool: string; readonly reason: string }[] = [];

  // TOOLS-15. ExternalShell, ExternalRead, AwaitExternalShell, CopyToBox and CopyFromBox all reach
  // the operator's own computer over the local-exec bridge, and every one of them blocks until a
  // registered provider answers. With no computer connected there is nothing on the far end, so
  // the model spent its turn waiting on a channel that never replies. An operator connects one by
  // running the local-exec provider (the desktop app's daemon) against this gateway's
  // /local-exec/requests stream and saying hello on it; until then these five stay out of the
  // toolset, and the prompt's two-machines paragraphs drop with them. The host resolves the fact,
  // so SAND_LOCAL_MACHINE can pin either world on a running box.
  const localMachineConnected = host.localMachineConnected?.() !== false;
  const withholdForNoLocalMachine = (...names: readonly string[]) => {
    for (const tool of names) withheld.push({ tool, reason: "no_local_machine" });
  };

  if (!host.isBoxScopedSubagent) {
    if (localMachineConnected) {
      const externalShell = scoped(factories.externalShell?.(), "run-command");
      if (externalShell !== undefined) tools.push(externalShell);
      const externalRead = scoped(factories.externalRead?.(), "read-file");
      if (externalRead !== undefined) tools.push(externalRead);
      const externalAwait = scoped(factories.externalAwait?.(), "read-file");
      if (externalAwait !== undefined) tools.push(externalAwait);
    } else {
      withholdForNoLocalMachine(
        SAND_EXTERNAL_SHELL_TOOL_NAME,
        SAND_EXTERNAL_READ_TOOL_NAME,
        SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
      );
    }
    const webSearch = factories.webSearch?.();
    if (webSearch !== undefined) tools.push(webSearch);
    const webFetch = factories.webFetch?.();
    if (webFetch !== undefined) tools.push(webFetch);
  }

  if (!host.isSubagentRunner) {
    const generateImage = factories.generateImage?.();
    if (generateImage !== undefined) tools.push(generateImage);
  }

  // CLOUD-1. CloudAgent declares no parameters and keeps Cursor's execute(ctx, args) order, so the
  // OpenAI-compatible executor dropped it from every request while the toolset counted it: 36
  // offered, 35 sent, for as long as the wire trace has existed. It manages Cursor cloud agents,
  // which this box cannot reach; withhold it unless the host says cloud agents are available.
  if (!host.isBoxScopedSubagent) {
    if (host.cloudAgentsDisabledByTeam()) withheld.push({ tool: "CloudAgent", reason: "disabled_by_team" });
    else if (host.cloudAgentsAvailable?.() === false) withheld.push({ tool: "CloudAgent", reason: "cloud_agents_unavailable" });
    else {
      const cloudAgent = factories.cloudAgent?.();
      if (cloudAgent !== undefined) tools.push(cloudAgent);
    }
  }

  if (host.getRemoteBoxAvailable()) {
    const boxShell = scoped(factories.boxShell?.());
    if (boxShell !== undefined) tools.push(boxShell);
    const boxRead = scoped(factories.boxRead?.());
    if (boxRead !== undefined) tools.push(boxRead);
    if (!host.isBoxScopedSubagent) {
      const boxAwait = scoped(factories.boxAwait?.());
      if (boxAwait !== undefined) tools.push(boxAwait);
      // Both transfers cross to the operator's computer, so they go with the other three.
      if (localMachineConnected) {
        const fileTransfer = factories.fileTransfer?.();
        if (fileTransfer !== undefined) tools.push(...fileTransfer.map((tool) => withLocalToolScope(tool, agentId, host.localToolPermission)));
      } else withholdForNoLocalMachine("CopyToBox", "CopyFromBox");
    }
  }

  if (
    host.isComputerUseSubagent
    && host.remoteBoxHasDesktop
    && host.getRemoteBoxAvailable()
  ) {
    const computer = factories.computer?.();
    if (computer !== undefined) tools.push(computer);
  }
  if (
    host.isBrowserUseSubagent
    && host.remoteBoxHasDesktop
    && host.getRemoteBoxAvailable()
  ) {
    const browser = factories.browser?.();
    if (browser !== undefined) tools.push(...browser);
  }
  /**
   * BROWSER-1. The same predicate that gives the main agent Screenshot and request_box_help, plus
   * the operator's kill switch. A subagent never gets these four: a computerUse subagent has the
   * Computer tool, a browserUse subagent has the fifteen page-level ones, and both would otherwise
   * be handed a second, overlapping way to drive the same tab.
   */
  {
    const browserDirectAllowed = !host.isSubagentRunner
      && host.remoteBoxHasDesktop
      && host.getRemoteBoxAvailable();
    if (browserDirectAllowed && host.isBrowserToolsEnabled?.() !== false) {
      const browserDirect = factories.browserDirect?.();
      if (browserDirect !== undefined) tools.push(...browserDirect);
    } else if (browserDirectAllowed) {
      // Withheld by the operator's switch, not by the shape of the turn. Named here with the
      // reason, because "the tool is absent" and "the tool was turned off" look identical to
      // someone reading a toolset line, and only one of them is a bug.
      for (const tool of DIRECT_BROWSER_TOOL_NAMES) withheld.push({ tool, reason: "browser_tools_off" });
    }
  }
  if (
    !host.isSubagentRunner
    && host.remoteBoxHasDesktop
    && host.getRemoteBoxAvailable()
  ) {
    const screenshot = factories.screenshot?.();
    if (screenshot !== undefined) tools.push(screenshot);
    const requestBoxHelp = factories.requestBoxHelp?.();
    if (requestBoxHelp !== undefined) tools.push(requestBoxHelp);
  }

  // FEEDBACK-1. Deliberately outside every predicate above. A fault in the product is not something
  // only an agent with a desktop can hit: a subagent whose shell refuses, a box-scoped runner whose
  // read is denied, a room member whose connector times out are all agents that have something
  // worth reporting, and each of them is exactly where "Titan tried to cover up failure" came from.
  // The tool writes into the box's own pending file and posts nothing, so there is no reach it
  // could have here that it does not have anywhere else.
  {
    const problemReport = factories.problemReport?.();
    if (problemReport !== undefined) tools.push(problemReport);
  }

  // MAIL-3. Unlike the row above, this one is GUARDED, and on four facts rather than a preference.
  //
  //   - `canSend` on this box's own copy of the address directory. It is one boolean per workspace,
  //     pushed by the relay's five-minute sweep, and standing-persona.ts already makes an agent say
  //     "I can send from that address" the moment it is true. Offering the tool on a box the relay
  //     still says false for would produce a bot that holds a capability its own words deny.
  //   - a row for THIS agent in that directory. A bot with no address has nothing to send from, and
  //     the relay would refuse it anyway; a tool that can only refuse is worse than no tool.
  //   - a relay parses out of the bundle base URL, and its token is not empty. On a non-tenant
  //     install that base is still the default S3 bucket, so this is also what keeps the tool off
  //     an ordinary desktop build entirely.
  //
  // The count matters as much as the correctness: the fleet is measured at 26 schemas and local
  // endpoints break above six, so gating here keeps every box that is not mail-enabled at exactly
  // the count it has today rather than growing a 27th schema by accident.
  //
  // It is deliberately absent from SHARED_ROOM_TOOL_NAMES, which is an allowlist: absence is the
  // whole change, and a cross-user room cannot send mail for free.
  //
  // A SUBAGENT never gets it, whatever the directory says, and that is its own guard rather than
  // part of the four. Mail goes out under the business's name, and the chip that says it went is
  // drawn in the conversation the person is watching -- which a subagent's run is not.
  //
  // MEASURED on grok-bot-local-vm 2026-09-09 18:26Z: a box-scoped computerUse subagent's trace line
  // carries conversationId `sand-subagent-<uuid>`, so on that path it would find no directory row
  // and be withheld anyway. This guard is for the other path: `getConversationId` in
  // host-runner-composition.ts is `() => shellConversationId`, whose default is the PARENT's
  // session id, so a call site that leaves it out hands a subagent the parent's identity and with
  // it the parent's address. The reason is its own word so an operator reading the trace can tell
  // this apart from a workspace whose sending is switched off.
  {
    const sendEmail = factories.sendEmail?.();
    if (sendEmail !== undefined) {
      if (host.isSubagentRunner) {
        withheld.push({ tool: "SendEmail", reason: "subagent_runner" });
      } else {
        const mail = readAgentMail();
        const relay = resolveRelaySend();
        const offered = mail?.canSend === true
          && mail.addresses[agentId] != null
          && relay !== undefined
          && relay.token.length > 0;
        if (offered) tools.push(sendEmail);
        else withheld.push({ tool: "SendEmail", reason: "mail_send_off" });
      }
    }
  }

  // CODE-1. The coding sandbox, and two guards rather than four.
  //
  // NO RELAY, NO TOOL. `resolveRelayCode` is mail's parse of SAND_HOST_BUNDLE_S3_BASE_URL: it answers
  // only on a box a relay serves its bundle to, because the relay is the process that holds the docker
  // socket and mints the per-task model key. On a customer's own install, or a loopback dev host with
  // no pin, it resolves nothing -- and the tool is WITHHELD rather than offered. An offered tool that
  // can only refuse teaches the model a capability the product does not have on that box, and the
  // model then promises it to a person. That is the same rule that keeps `repo` off the schema.
  //
  // A SUBAGENT never gets it. This guard is not about the chip, though the chip is a reason: it is
  // about the proto carrier. `sendFinalSummaryToolCall` is the case task-client.ts:62 scans a
  // subagent's own steps for, to pull out the subagent's final summary, so a code-task row inside a
  // subagent run could be read back as that subagent's summary. Withholding it there means the two
  // uses of the case can never share a conversation. The guard copies SendEmail's, including its own
  // word in the trace so an operator can tell this apart from a box with no relay.
  {
    const codeTask = factories.codeTask?.();
    if (codeTask !== undefined) {
      if (host.isSubagentRunner) {
        withheld.push({ tool: "CodeTask", reason: "subagent_runner" });
      } else if (resolveRelayCode() === undefined) {
        withheld.push({ tool: "CodeTask", reason: "no_relay" });
      } else {
        tools.push(codeTask);
      }
    }
  }

  // The immutable builder only offers the MCP discovery/call pair when the
  // live per-turn MCP projection exists, or dynamic mode owns the registry.
  // A supplied factory alone is not an MCP service and must remain dormant.
  if (
    !host.isBoxScopedSubagent
    && (props?.mcp !== undefined || dynamicToolRegistry !== undefined)
  ) {
    const mcpMeta = factories.mcpMeta?.(dynamicToolRegistry);
    if (mcpMeta !== undefined) tools.push(...mcpMeta);
  }
  if (!host.isSubagentRunner) {
    const mcpManagement = factories.mcpManagement?.();
    if (mcpManagement !== undefined) tools.push(...mcpManagement);
    if (turn.subagentConfigs != null) {
      const subagentManagement = factories.subagentManagement?.()
        ?? (props?.hostDependencies?.subagentManagement === undefined
          ? undefined
          : createTurnSubagentManagementToolFactory({
            controller: props.hostDependencies.subagentManagement,
          })());
      if (subagentManagement !== undefined) tools.push(...subagentManagement);
    }
  }

  const sharedRoomAllowed = host.isSharedRoomRunner
    ? host.isSharedRoomBoxToolsEnabled?.() === false
      ? SHARED_ROOM_TEXT_ONLY_TOOL_NAMES
      : SHARED_ROOM_TOOL_NAMES
    : undefined;
  const offered = sharedRoomAllowed == null
    ? tools
    : tools.filter((tool) => sharedRoomAllowed.has(tool.name));

  const placed = dynamicToolsEnabled
    ? offered.map(withDynamicToolPlacement)
    : offered;
  // TOOLS-33. One budget for this whole toolset, shared by every tool, so the cap counts tool calls
  // across the set rather than per tool. This function runs once per model STEP, not once per turn
  // (LOOP-2, turn-agent-composition.ts), so a counter created here resets several times inside one
  // turn and the cap never binds: a live box ran seventy-one calls against a ceiling of thirty and
  // refused nothing. The counter rides on the turn instead, exactly as the send cap does, and the
  // fresh one below is only for a caller that wired none. The budget is read here, and it never
  // depends on which skill is running.
  const turnToolBudget = resolveTurnToolBudget();
  const turnToolBudgetCounter = turn.toolBudget ?? createTurnToolBudgetCounter();
  const guarded = placed.map((tool) => {
    let inner: TurnTool;
    if (
      dynamicInvocationRegistry !== undefined
      && tool.dynamicToolMetaRole === "invocation"
    ) {
      inner = wrapDynamicInvocationToolWithTimeout(
        tool as StreamingTurnTool,
        dynamicInvocationRegistry,
        host.isComputerUseSubagent,
      ) as unknown as TurnTool;
    } else {
      const executionTimeoutMs = sandToolCallExecutionTimeoutMs(
        tool.name,
        host.isComputerUseSubagent,
      );
      inner = withToolTimeout(withAttestedResult(tool, host.getConversationId()), executionTimeoutMs, () =>
        createToolCallExecutionTimeoutError({
          toolName: tool.name,
          executionTimeoutMs,
        }));
    }
    // JEV-2. What this turn actually retrieved is what a negative claim gets judged against, so
    // every search and fetch result is kept, trimmed, with its domain. Off unless the box has the
    // flag, and a failure to read a result is simply evidence this turn does not have.
    if (turn.jev !== undefined && isJevWebToolName(tool.name)) {
      inner = collectJevEvidence(inner, turn.jev);
    }
    // TOOLS-33. SendMessage is how a turn talks, so it is neither counted nor refused. A turn that
    // spends its budget still has to deliver the answer the refusal just told it to write, and a
    // refused closing message is an answer nobody receives -- worse than a turn that ran long. It
    // is not unbounded either: the send cap already holds it to twenty a turn (LOOP-2), and it
    // keeps its timeout and attestation here like every other tool.
    if (tool.name === SAND_SEND_MESSAGE_TOOL_NAME) return inner;
    return withTurnToolBudget(inner, turnToolBudget, turnToolBudgetCounter, {
      agentId: host.getConversationId(),
    });
  });

  /**
   * The only place that knows what the model was actually offered. Before this, reading the
   * offered set meant taping the inference client and rebuilding the bundle
   * (docs/audit-wave3-wire.md), which is why "34 tools" was an inference rather than a
   * measurement. One line per build, off unless an operator turns it on.
   */
  if (isSandBoxSettingEnabled(SAND_TOOL_TRACE_SETTING)) {
    console.info(`[sand][toolset] ${JSON.stringify({
      conversationId: host.getConversationId(),
      isSubagentRunner: host.isSubagentRunner,
      isBoxScopedSubagent: host.isBoxScopedSubagent,
      isComputerUseSubagent: host.isComputerUseSubagent,
      isBrowserUseSubagent: host.isBrowserUseSubagent,
      isSharedRoomRunner: host.isSharedRoomRunner,
      // Which of the two room filters ran. Without it a room turn that came back with the box
      // tools is ambiguous: the switch may have been on, or it may never have reached the host.
      sharedRoomBoxTools: host.isSharedRoomRunner
        ? host.isSharedRoomBoxToolsEnabled?.() !== false
        : null,
      // BROWSER-1. Whether Titan's four browser tools were offered this build, so a trace that
      // came back without them says which of the two reasons it was: switched off, or no box.
      browserTools: host.isBrowserToolsEnabled?.() !== false,
      subagentTypes: (turn.subagentConfigs ?? []).map(subagentConfigName),
      count: guarded.length,
      tools: guarded.map(tool => tool.name),
      localMachineConnected,
      localMachineSource: host.localMachineSource?.() ?? "bridge",
      withheld,
    })}`);
  }

  return fencedToolSet(guarded, host.spotlightEnabled(), dynamicToolRegistry);
}

/** Reads the custom subagent name out of the generated SubagentType for the trace line. */
function subagentConfigName(config: unknown): string {
  const type = (config as { readonly subagent_type?: unknown } | null)?.subagent_type;
  const inner = (type as { readonly type?: { readonly value?: unknown } } | null)?.type?.value;
  const name = (inner as { readonly name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "unknown";
}
