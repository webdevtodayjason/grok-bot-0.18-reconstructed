import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSandRootDir } from "./host-paths.js";
import {
  createTurnLocalMachineReader,
  isSandBoxSettingEnabled,
  isSandOverrideTruthy,
  readSandBoxSetting,
  resolveBrowserToolsEnabled,
  SAND_BROWSER_TOOLS_SETTING,
  SAND_LOCAL_MACHINE_SETTING,
  SAND_SHARED_ROOM_BOX_TOOLS_SETTING,
  SAND_TOOL_TRACE_SETTING,
} from "./sand-box-setting.js";
import {
  createSelfTalkCap,
  resolveSelfTalkCap,
  SAND_SELF_TALK_CAP_SETTING,
  SELF_TALK_CAP_NOTICE,
} from "./runner/self-talk-cap.js";
import { evidenceRegistry } from "./extensions/evidence/evidence-registry.js";
import { createSandExecutorSubagentConfig } from "./sand-multitask.js";
import { SubagentType, SubagentTypeCustom } from "../packages/proto/generated/agent/v1/subagents_pb.js";
import { createSandComputerUseSubagentConfig } from "./runner/tools/sand-computer-use-subagent.js";
import {
  BROWSER_USE_SUBAGENT_TYPE,
  createSandBrowserUseSubagentConfig,
} from "./runner/tools/sand-browser-use-subagent.js";
import { TranscriptMirrorOffloadPool } from "./agent-isolation/transcript-mirror-offload.js";
import type {
  CreateProductionRunnerRunStep,
  ProductionTurnHostDependencies,
  ProductionTurnHostToolProjections,
  ProductionTurnAutoReviewHostProjection,
  ProductionTurnCancelThisRun,
  ProductionTurnExternalAwaitInputs,
  ProductionTurnEmitUpdate,
  ProductionTurnToolInputs,
} from "./runner-production-bridge.js";
import {
  createProductionTurnToolInputs,
  createProductionTurnToolsetHost,
  type ProductionTurnToolsetHostInput,
} from "./runner-production-bridge.js";
import { NoopConversationActionReceiver } from "../packages/agent-core/conversation-actions/remote.js";
import {
  RequestContext,
  RequestContextEnv,
} from "../packages/proto/generated/agent/v1/request_context_exec_pb.js";
import {
  SummarizationHandler,
  type SummarizationPromptSession,
} from "../packages/agent-summarization/summarization-handler.js";
import { getAgentBlobStore } from "./runner/sand-agent-runner.js";
import type { AgentProfileForRunner } from "./runner/sand-agent-runner.js";
import type {
  AutomationRecord,
  AutomationReview,
  WorkflowRecord,
} from "./runner/tools/sand-state-tool.js";
import type {
  CloudAgentApi,
  CloudAgentToolContext,
  CloudAgentToolDeps,
} from "./cloud-agents/cloud-agent-tool.js";
import {
  SAND_EXTERNAL_READ_TOOL_DESCRIPTION,
  SAND_BOX_READ_TOOL_DESCRIPTION,
  SAND_READ_FORMATTING_OPTIONS,
  type TurnToolsetHostFactoryProvider,
} from "./runner/tools/turn-toolset.js";
import type {
  TurnAwaitToolFactoryInput,
  TurnBoxHelpToolFactoryInput,
  TurnBrowserToolFactoryInput,
  TurnCloudAgentToolFactoryInput,
  TurnFileTransferToolFactoryInput,
  TurnMcpManagementToolFactoryInput,
  TurnProblemReportToolFactoryInput,
  TurnSendEmailToolFactoryInput,
  TurnReadToolFactoryInput,
  TurnSubagentManagementToolFactoryInput,
  TurnWebFetchToolFactoryInput,
  TurnWebSearchToolFactoryInput,
} from "./runner/tools/turn-toolset.js";
import type {
  RemoteResource,
  ResourceAccessor,
} from "../packages/agent-exec/resource-provider.js";
import { subagentExecutorResource } from "../packages/agent-exec/subagent.js";
import { requestContextExecutorResource } from "../packages/agent-exec/request-context.js";
import { subagentRegistryResource } from "../packages/agent/tools/subagent-registry.js";
import { smartModeClassifierExecutorResource } from "../packages/agent-exec/smart-mode-classifier.js";
import { mcpExecutorResource, mcpStateExecutorResource } from "../packages/agent-exec/mcp.js";
import { shellStreamExecutorResource } from "../packages/agent-exec/shell-stream.js";
import { backgroundShellExecutorResource } from "../packages/agent-exec/background-shell.js";
import type { RemoteExecManager } from "../packages/agent-exec/remote.js";
import {
  SAND_BOX_AWAIT_SHELL_TOOL_NAME,
  SAND_BOX_READ_TOOL_NAME,
  SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
  SAND_EXTERNAL_READ_TOOL_NAME,
} from "./sand-activity.js";
import { connectorCardEmissionToMessage, type BoxHelpOutcome } from "./runner/tools/box-help-tool.js";
import { appendProblemReport } from "./extensions/feedback/problem-reports.js";
import { readAgentMailFor } from "./extensions/mail/agent-mail-store.js";
import { postMailSend, resolveRelaySend } from "./extensions/mail/relay-send-client.js";
import { createAgentPromptSession } from "./extensions/inference/extension.js";
import { CONNECTOR_MANIFESTS } from "../shared/channels.js";
import { parseStoredTrigger } from "./automations/automation-trigger.js";
import { listenerPlatformsInTrigger } from "./automations/listener-integrations.js";
import { resolveSharedRoomBoxToolsEnabled } from "./groups/xuser.js";
import { boxAgentWindowIndex, boxSupportsMultiWindow } from "./box/box-capabilities.js";
import { createAutoReviewGate } from "./runner/auto-review-gate.js";
import {
  sandAutoReviewApprovalExpiryPolicy,
  SandAutoReviewController,
} from "./runner/sand-auto-review.js";
import {
  createHostBrowserDriverDependencies,
  createHostComputerToolDependencies,
  createHostShellExecutor,
  type HostBrowserBoxOwner,
} from "./runner/host-computer-tool-dependencies.js";
import { hostname } from "node:os";
// CLOUD-BROWSER-1. The cloud leg of the four browser tools. Everything it needs -- the policy, the
// stored keys, the ledger, the register of open sessions -- lives under the sand root next door.
import {
  CLOUD_VIEW_IDLE_SECONDS,
  CloudBrowserService,
  type CloudBrowserPorts,
  type CloudBrowserVendor,
} from "./extensions/inference/cloud-browser/index.js";
import type { CloudBrowserSeam } from "./runner/tools/sand-browser-tools.js";
import {
  createRemoteBoxResourceAccessor,
  type RemoteBoxResourceHost,
} from "./runner/remote-box-resources.js";
import { createStreamAttempt } from "./runner/stream-attempt.js";
import {
  createTurnAgentRunStreamInput,
  createTurnAgentStreamStart,
  type TurnLocalResourceProjectionInput,
  type TurnMcpForTurn,
  type TurnMcpProjectionInput,
} from "./runner/turn-agent-composition.js";
import type { McpToolForMeta } from "./runner/tools/mcp-meta-tools.js";
import { wrapMcpExecutorForAudit } from "./runner/sand-action-audit.js";
import { boundedConnectorTag } from "../shared/observability/connector-auth-telemetry.js";
import { errorLogTag } from "../shared/errors.js";
import { SPOTLIGHT_TAG } from "../shared/sand-spotlight.js";
import {
  mcpErrorClassOf,
  reportMcpHostEdgeDegraded,
  takeMcpExecErrorClass,
} from "../shared/node/mcp/mcp-diagnostics.js";
import {
  createProductionTurnAgentOwner,
  createProductionTurnAgentRunInput,
  type ProductionTurnAgentOwnerInput,
} from "./runner/production-turn-agent-owner.js";
import {
  createProductionTurnRunShellHostInput,
} from "./runner/production-turn-run-shell-adapter.js";
import {
  createPromptCollectorGlue,
  type PromptCollectorHost,
} from "./runner/prompt-collector-glue.js";
import type { GeneratedTurnPromptOptions } from "./runner/prompt-collector-glue.js";
import { createRunnerPromptGlue } from "./runner/runner-prompt-glue.js";
import {
  createShellWatchGeneratedStateProjection,
  createShellWatchReadAccessor,
  type ShellTerminalWatchHost,
} from "./runner/shell-terminal-watch.js";
import { DEFAULT_SAND_SYSTEM_PROMPT } from "./runner/system-prompt.js";
import {
  createSystemPromptAssembly,
  type PromptSnapshotStore,
  type SystemPromptAssemblyDependencies,
} from "./runner/system-prompt-assembly.js";
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../packages/redaction/privacy-mode.js";
import { tryExtractSandAutoReviewClassifierConversationContext } from "../packages/agent/smart-mode-classifier-context.js";
import {
  buildSandAutomationWriteRiskTarget,
  reviewSandAutomationWrite,
} from "./runner/sand-automation-auto-review.js";
import {
  runSandAutoReviewClassifier,
} from "./runner/sand-auto-review-classifier-run.js";
import { SAND_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON } from "./runner/sand-automation-auto-review.js";
import { surfaceListenerConnectCards } from "./runner/tools/listener-connect-cards.js";
import {
  buildSandCloudAgentRiskTarget,
  buildSandCloudAgentLifecycleReviewTarget,
  buildSandCloudAgentReviewTarget,
  describeSandCloudAgentReviewImages,
  reviewSandCloudAgentAction,
  reviewSandCloudAgentLifecycleAction,
  SAND_CLOUD_AGENT_CLASSIFIER_ERROR_REASON,
} from "./runner/sand-cloud-agent-auto-review.js";
import type { Context } from "../packages/context/core.js";
import type {
  TurnShellAutoReviewInput,
  TurnToolsetHost,
  TurnToolsetTurnInput,
} from "./runner/tools/turn-toolset.js";
import type { TurnCheckpoint, TurnSettleHost } from "./runner/turn-settle.js";
import type { TextExecutor } from "./runner/sand-memory.js";
import type { RunnerPromptGlueOwner } from "./runner/runner-prompt-glue.js";
import type { TransferBox } from "./box/box-transfer.js";
import type { CapableBox } from "./box/box-capabilities.js";
import type { UserComputerHandle } from "./runner/tools/sand-file-transfer-tools.js";
import type { AgentProfilePromptSnapshot } from "./runner/sand-agent-profile-prompt.js";
import type {
  RunningSubagentInfo,
  SubagentManagementController,
} from "./runner/tools/sand-subagent-management-tools.js";
import type {
  SubagentSession,
  SubagentRunOptions,
} from "./runner/subagent-runtime.js";
import type {
  SubagentAdapterArgs,
} from "./runner/agent-adapters.js";
import type { CursorRule } from "../packages/proto/generated/agent/v1/cursor_rules_pb.js";

export const DEFAULT_SAND_MODEL = "gpt-5.5-high-fast";
export const SAND_SUMMARIZATION_MAX_PROMPT_CHARS = 2_800_000;

type DynamicApi = Record<string, any>;

export interface HostRunnerSession {
  readonly id: string;
  readonly dbPath: string;
  readonly agentStore?: DynamicApi;
  readonly memory?: unknown;
  readonly automations?: unknown;
  readonly workflows?: unknown;
  readonly channels?: unknown;
  readonly db?: unknown;
}

export interface HostRunnerHooks {
  readonly transport: {
    onUpdate(
      update: unknown,
      cancelThisRun?: ProductionTurnCancelThisRun,
    ): void;
    lastSentMessageId?(): string | undefined;
    lastReactionApplied?(): boolean;
  };
  /** Exact turn-scoped card emitter; omitted callers remain fail-closed. */
  readonly emitUpdate?: ProductionTurnEmitUpdate;
  readonly onRunLifecycle?: (event: unknown) => void;
  readonly agentProfileProvider?: () => AgentProfileForRunner | null;
  readonly ingestAttachment?: (sourcePath: string) => Promise<string>;
  readonly persistImage?: (...args: any[]) => unknown;
  readonly persistMediaBytes?: (
    filename: string,
    data: Uint8Array,
  ) => Promise<string | null>;
}

export interface HostRunnerOverrides {
  readonly groupMemberTurn?: boolean;
  readonly isSharedRoomTurn?: boolean;
  readonly systemPrompt?: unknown;
  readonly [key: string]: unknown;
}

export interface HostRunnerExtensions {
  api(id: string): DynamicApi;
}

/**
 * The per-turn resource owner is created only after the box has been made
 * ready.  The box owns the remote accessor; this boundary deliberately does
 * not cache it or manufacture a fallback accessor between turns.
 */
export interface ProductionBoxResourceOwner {
  ensureReady(
    context: unknown,
    agentId: string,
  ): Promise<{ readonly remoteAccessor?: unknown }>;
}

export type ProductionResourceAccessor = ResourceAccessor<RemoteExecManager>;

export function createPerTurnResourceAccessor(
  owner: ProductionBoxResourceOwner,
  agentId: string,
): (context: unknown) => Promise<ProductionResourceAccessor> {
  return async (context: unknown): Promise<ProductionResourceAccessor> => {
    const connection = await owner.ensureReady(context, agentId);
    const accessor = connection?.remoteAccessor;
    if (
      typeof accessor !== "object"
      || accessor == null
      || typeof (accessor as { readonly get?: unknown }).get !== "function"
    ) {
      throw new TypeError("production Agent resource accessor is not bound");
    }
    return accessor as ProductionResourceAccessor;
  };
}

export interface ProductionSessionBoundRunner {
  readonly subagents: {
    readonly sessions: Map<string, SubagentSession>;
    isRunning(agentId: string): boolean;
    dispatchBackgroundSubagent(input: Parameters<
      TurnLocalResourceProjectionInput["subagentDispatcher"]["dispatch"]
    >[0]): void;
  };
  readonly computerUse: {
    allocateWindow(agentId: string): unknown | null;
    freeWindow(agentId: string): void;
  } | undefined;
  run(prompt: string, options?: SubagentRunOptions): Promise<unknown>;
  interrupt(reason: string): unknown;
  getResolvedOutline(): Promise<readonly unknown[]>;
  getObservedToolCallCount(): number;
  getActivitySnapshot(): readonly string[];
  getTranscriptPath(): string | null;
  setAgentStore(agentStore: unknown, agentProfileProvider?: unknown): void;
  setMemoryStore(memoryStore: unknown): void;
  setUserMemory(userMemory: unknown): void;
  setProjectMemory(projectMemory: unknown): void;
  setMemorySnapshotStore(memorySnapshots: unknown): void;
  setProfilePromptSnapshotStore(profilePromptSnapshots: unknown): void;
  setEpisodeProgress(episodeProgress: unknown): void;
  setAutomationStore(automationStore: unknown): void;
  setWorkflowStore(workflowStore: unknown): void;
  setChannelStore(channelStore: unknown): void;
  setMcp(mcp: unknown): void;
  setMcpManagement(mcpManagement: unknown): void;
  setAttachmentIngestor(ingest: unknown): void;
  setImagePersister(persistImage: unknown): void;
  setMediaBytesPersister(persistMediaBytes: unknown): void;
}

export interface HostRunnerCompositionDependencies<Runner extends ProductionSessionBoundRunner = ProductionSessionBoundRunner> {
  readonly extensions: HostRunnerExtensions;
  readonly ctx: unknown;
  emitGatewayEvent(event: unknown): void;
  buildRunner(options: Record<string, unknown>): Runner;
  readonly createRunStep?: CreateProductionRunnerRunStep;
  createRequestContext?(options: {
    transcriptsDir: string;
    getUserTimeZone(): unknown;
    resolveTeamRules(): Promise<unknown>;
    getUserFullName(): Promise<unknown>;
  }): unknown;
  createTranscriptMirror?(options: {
    transcriptsDir: string;
    session: HostRunnerSession;
    pool: () => TranscriptMirrorOffloadPool;
    reportOutcome(report: unknown): void;
    isJournalEnabled(): Promise<boolean>;
  }): unknown;
  decorateActionAuditor?(
    actionAuditor: unknown,
    callbacks: {
      onBotBlock(hit: any, record: any): void;
      onSiteVisit(visit: any, record: any): void;
    }
  ): unknown;
  readonly mirrorPoolFactory?: () => TranscriptMirrorOffloadPool;
}

export interface RecoveredHostRunnerComposition<Runner extends ProductionSessionBoundRunner> {
  createRunner(session: HostRunnerSession, hooks: HostRunnerHooks): Runner;
  createGroupMemberRunner(
    session: HostRunnerSession,
    hooks: HostRunnerHooks,
    overrides: HostRunnerOverrides
  ): Runner;
  canAskLocalToolPermission(agentId: string): boolean;
  forgetLocalToolPermission(agentId: string): void;
  dispose(): Promise<void>;
}

function method(api: DynamicApi | undefined, name: string): ((...args: any[]) => any) | undefined {
  if (api == null) return undefined;
  const candidate = api[name];
  return typeof candidate === "function" ? candidate.bind(api) : undefined;
}

function asSandAutoReviewController(value: unknown): SandAutoReviewController | undefined {
  return value instanceof SandAutoReviewController ? value : undefined;
}

function asActionAuditor(
  value: unknown,
): NonNullable<ProductionTurnAutoReviewHostProjection["actionAuditor"]> | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const record = (value as Record<string, unknown>).record;
  if (typeof record !== "function") return undefined;
  return { record: entry => record.call(value, entry) };
}

function asLocalToolPermissionProjection(
  value: unknown,
): NonNullable<ProductionTurnAutoReviewHostProjection["localToolPermission"]> | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const awaitDesktopStandingDecision = candidate.awaitDesktopStandingDecision;
  const completeScope = candidate.completeScope;
  if (
    typeof awaitDesktopStandingDecision !== "function"
    || typeof completeScope !== "function"
  ) return undefined;
  return {
    awaitDesktopStandingDecision: args =>
      awaitDesktopStandingDecision.call(value, args),
    completeScope: scope => completeScope.call(value, scope),
  };
}

type ProductionClassifierStateHandler = Parameters<
  typeof tryExtractSandAutoReviewClassifierConversationContext
>[1];

function asProductionClassifierStateHandler(
  value: unknown,
): ProductionClassifierStateHandler | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const turns = candidate.turns;
  const rootPromptBuilder = candidate.rootPromptBuilder;
  if (
    !Array.isArray(turns)
    || typeof rootPromptBuilder !== "object"
    || rootPromptBuilder == null
    || typeof (rootPromptBuilder as Record<string, unknown>).getState !== "function"
  ) return undefined;
  return value as ProductionClassifierStateHandler;
}

export async function extractProductionTurnAutoReviewConversationContext(
  context: Context,
  stateHandler: unknown,
) {
  const candidate = asProductionClassifierStateHandler(stateHandler);
  if (candidate === undefined) return [];
  return [
    ...await tryExtractSandAutoReviewClassifierConversationContext(
      context,
      candidate,
    ),
  ];
}

function isAgentContext(value: unknown): value is Context {
  return typeof value === "object" && value != null
    && typeof (value as { with?: unknown }).with === "function"
    && typeof (value as { get?: unknown }).get === "function"
    && typeof (value as { withCancel?: unknown }).withCancel === "function";
}

interface PromptRequestContext {
  resolve(): {
    readonly osVersion?: string;
    readonly shell?: string;
    readonly timeZone?: string;
    readonly transcriptsFolder?: string;
    readonly userFullName?: string;
  };
  resolveRules(): Promise<CursorRule[] | undefined>;
}

function asTransferBox(value: unknown): TransferBox | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const downloadFile = candidate.downloadFile;
  const uploadFile = candidate.uploadFile;
  if (typeof downloadFile !== "function" || typeof uploadFile !== "function") return undefined;
  return {
    downloadFile: (context, agentId, path) =>
      downloadFile.call(value, context, agentId, path),
    uploadFile: (context, agentId, path, data) =>
      uploadFile.call(value, context, agentId, path, data),
  };
}

function asCapableTransferBox(value: unknown): TransferBox & CapableBox | undefined {
  const transfer = asTransferBox(value);
  if (transfer === undefined) return undefined;
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const capable: TransferBox & CapableBox = transfer;
  const getTerminalsFolder = candidate.getTerminalsFolder;
  if (typeof getTerminalsFolder === "function") {
    capable.getTerminalsFolder = () => getTerminalsFolder.call(value);
  }
  const isAvailable = candidate.isAvailable;
  if (typeof isAvailable === "function") {
    capable.isAvailable = () => isAvailable.call(value);
  }
  const isPreparing = candidate.isPreparing;
  if (typeof isPreparing === "function") {
    capable.isPreparing = (agentId) => isPreparing.call(value, agentId);
  }
  const getAgentWindowIndex = candidate.getAgentWindowIndex;
  if (typeof getAgentWindowIndex === "function") {
    capable.getAgentWindowIndex = agentId => getAgentWindowIndex.call(value, agentId);
  }
  return capable;
}

type RemoteBoxResourceOwner = RemoteBoxResourceHost["remoteBox"];

function asRemoteBoxResourceOwner(value: unknown): RemoteBoxResourceOwner | undefined {
  const capable = asCapableTransferBox(value);
  if (capable === undefined || typeof value !== "object" || value == null) return undefined;
  const ensureReady = (value as Record<string, unknown>).ensureReady;
  if (typeof ensureReady !== "function") return undefined;
  return {
    ...capable,
    ensureReady: (context, agentId) => ensureReady.call(value, context, agentId),
  };
}

function asProductionResourceAccessor(
  registry: ReturnType<typeof createRemoteBoxResourceAccessor>,
): ProductionResourceAccessor {
  return {
    get<Implementation>(
      resource: RemoteResource<Implementation, RemoteExecManager>,
    ): Implementation {
      const value = registry.get({
        symbol: resource.symbol,
        remoteImplementation: resource.remoteImplementation,
        registerControlledImplementation: () => {},
      });
      if (value === undefined) {
        const knownResources: ReadonlyArray<readonly [symbol, string]> = [
          [subagentExecutorResource.symbol, "subagentExecutorResource"],
          [requestContextExecutorResource.symbol, "requestContextExecutorResource"],
          [subagentRegistryResource.symbol, "subagentRegistryResource"],
          [smartModeClassifierExecutorResource.symbol, "smartModeClassifierExecutorResource"],
          [mcpExecutorResource.symbol, "mcpExecutorResource"],
          [mcpStateExecutorResource.symbol, "mcpStateExecutorResource"],
          [shellStreamExecutorResource.symbol, "shellStreamExecutorResource"],
          [backgroundShellExecutorResource.symbol, "backgroundShellExecutorResource"],
        ];
        const resourceName = knownResources.find(([known]) => known === resource.symbol)?.[1]
          ?? "unknownResource";
        const implementationSource = Function.prototype.toString.call(
          resource.remoteImplementation,
        );
        const requestedResourceProvenance = {
          resourceName,
          symbolDescription: resource.symbol.description ?? null,
          symbolRegistryKey: Symbol.keyFor(resource.symbol) ?? null,
          remoteImplementationName: resource.remoteImplementation.name || null,
          wireNames: Array.from(
            implementationSource.matchAll(/["']([A-Za-z][A-Za-z0-9]*)["']/g),
            match => match[1],
          ),
        } as const;
        const error = new TypeError(
          `production remote resource is not registered: ${JSON.stringify(requestedResourceProvenance)}`,
        );
        Object.defineProperties(error, {
          requestedResourceSymbol: { value: resource.symbol, enumerable: true },
          requestedResourceProvenance: {
            value: requestedResourceProvenance,
            enumerable: true,
          },
        });
        console.error("[sand-host] production resource lookup failed", error);
        throw error;
      }
      return value;
    },
  };
}

function asUserComputer(value: unknown): UserComputerHandle | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const box = asTransferBox(candidate.box);
  if (
    typeof candidate.id !== "string"
    || typeof candidate.label !== "string"
    || typeof candidate.connected !== "boolean"
    || box === undefined
  ) return undefined;
  return {
    id: candidate.id,
    label: candidate.label,
    connected: candidate.connected,
    box,
  };
}

function asPromptUserComputers(value: unknown): RunnerPromptGlueOwner["userComputers"] | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const resolve = candidate.resolve;
  const list = candidate.list;
  if (typeof resolve !== "function" || typeof list !== "function") return undefined;
  return {
    resolve: (computerId) => asUserComputer(resolve.call(value, computerId)),
    list: () => {
      const listed = list.call(value);
      if (!Array.isArray(listed)) return [];
      return listed.flatMap(computer => {
        const resolved = asUserComputer(computer);
        return resolved === undefined ? [] : [resolved];
      });
    },
  };
}

function isGeneratedSelectedVideo(
  value: unknown,
): value is NonNullable<GeneratedTurnPromptOptions["selectedVideos"]>[number] {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Record<string, unknown>;
  const dataOrBlobId = candidate.dataOrBlobId;
  return typeof candidate.uuid === "string"
    && typeof candidate.path === "string"
    && typeof candidate.mimeType === "string"
    && typeof candidate.filename === "string"
    && typeof candidate.materializeToFilesystem === "boolean"
    && typeof dataOrBlobId === "object"
    && dataOrBlobId != null
    && typeof (dataOrBlobId as Record<string, unknown>).case === "string";
}

function isAgentProfilePromptSnapshot(value: unknown): value is AgentProfilePromptSnapshot {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Record<string, unknown>;
  const systemIdentity = candidate.systemIdentity;
  const announcedIdentity = candidate.announcedIdentity;
  const identity = (entry: unknown): boolean =>
    typeof entry === "object"
    && entry != null
    && typeof (entry as Record<string, unknown>).name === "string"
    && typeof (entry as Record<string, unknown>).description === "string";
  return candidate.version === 1
    && typeof candidate.profileSection === "string"
    && identity(systemIdentity)
    && identity(announcedIdentity)
    && typeof candidate.compactionEpoch === "number";
}

function asPromptSnapshotStore(value: unknown): PromptSnapshotStore | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const getSnapshot = candidate.getAgentProfilePromptSnapshot;
  const setSnapshot = candidate.setAgentProfilePromptSnapshot;
  if (typeof getSnapshot !== "function" || typeof setSnapshot !== "function") return undefined;
  return {
    getAgentProfilePromptSnapshot: () => {
      const snapshot = getSnapshot.call(value);
      return isAgentProfilePromptSnapshot(snapshot) ? snapshot : undefined;
    },
    setAgentProfilePromptSnapshot: snapshot => {
      setSnapshot.call(value, snapshot);
    },
  };
}

/**
 * The one question the prompt trace has to answer is *which sections the assembled prompt
 * carries* -- that is what SP-1/SP-2 broke and what scripts/verify-toolset.mjs asserts. The
 * prompt itself is not written anywhere: it is 70k+ characters of the user's memory, agent
 * profile, routines and connector instructions, every agent on this box has Shell on the same
 * filesystem, and a dump of it would outlive both the run and the switch. So the trace records
 * the section markers and the length, under the same operator switch as the toolset line, in a
 * host-owned file (0600, beside the rest of the sand data rather than in agent-writable /tmp).
 * Returns its argument so it can wrap the generator in place.
 */
const SYSTEM_PROMPT_SECTION_MARKERS: Readonly<Record<string, string>> = {
  memory: "Memory: durable facts you have learned about the user",
  routines: "Routines (your scheduling/automation feature)",
  skills: "User-created skills live as files at",
  timeZone: "Your box and tools run on a UTC clock",
  browser: "You drive this box's browser at the page level with the browser_* tools",
  mcpCustomInstructions: "Custom instructions are configured for some connected tools",
  // SP-3. The spotlight gate is two halves that must flip together (fenced tool results, and the
  // prompt section that explains the fence), and only the fences were observable. This marker is
  // the prompt half: absent while sand_spotlight is off, present when it is on.
  spotlight: `Tool results are wrapped in <${SPOTLIGHT_TAG}`,
  // TOOLS-15. The prompt half of the local-machine withhold. The five host-machine tools and these
  // paragraphs have to move together: present while a computer answers on the local-exec bridge,
  // absent when none does, so the prompt never teaches a tool the toolset did not offer.
  localMachine: "Your box and the user's computer are separate machines",
};

/** `factLine` in sand-memory.ts renders every recalled memory as "- (learned YYYY-MM-DD) ...". */
const MEMORY_FACT_LINE_PREFIX = "- (learned ";

// Reports outlive their agents (91 of them on one box after a day of probes). Once per host life,
// on the first write, drop the ones whose agent directory is gone.
let sweptStaleReports = false;
function sweepStaleSystemPromptReports(root: string): void {
  try { for (const name of readdirSync(root)) { const m = /^sand-system-prompt-(.+)\.json$/.exec(name); const agentId = m?.[1]; if (agentId != null && !existsSync(join(root, "agents", agentId))) rmSync(join(root, name), { force: true }); } } catch {}
}
function dumpAssembledSystemPrompt(agentId: string, prompt: string): string {
  if (!isSandBoxSettingEnabled(SAND_TOOL_TRACE_SETTING)) return prompt;
  if (!sweptStaleReports) { sweptStaleReports = true; sweepStaleSystemPromptReports(getSandRootDir()); }
  try {
    writeFileSync(
      join(getSandRootDir(), `sand-system-prompt-${agentId}.json`),
      JSON.stringify({
        agentId,
        length: prompt.length,
        sections: Object.fromEntries(
          Object.entries(SYSTEM_PROMPT_SECTION_MARKERS)
            .map(([name, marker]) => [name, prompt.includes(marker)]),
        ),
        // The memory section is present whenever the agent has a memory folder, facts or not, so
        // sections.memory cannot say whether a remembered fact actually reached the model. Every
        // rendered fact is one `factLine` (sand-memory.ts), so counting those does. The prompt
        // itself is never written out: it carries the user's memory, and every agent on this box
        // shares a filesystem.
        memoryFacts: prompt.split(MEMORY_FACT_LINE_PREFIX).length - 1,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch { /* tracing must never break a turn */ }
  return prompt;
}

/**
 * SP-1. The prompt stores reach this module as `unknown` on the session object, and the
 * reconstruction resolved that by handing the system-prompt assembly `() => null` for every one
 * of them -- so the assembled prompt carried no memory, no routines, no skills and no channels
 * while the very same stores were passed to the gateway runner a few hundred lines below. A
 * store is accepted here only when it actually answers the methods the assembly calls; anything
 * else stays null, which keeps the section absent rather than throwing mid-prompt.
 */
function asStoreWithMethods<T>(value: unknown, methods: readonly string[]): T | null {
  if (typeof value !== "object" || value == null) return null;
  const candidate = value as Record<string, unknown>;
  for (const name of methods) {
    if (typeof candidate[name] !== "function") return null;
  }
  return value as T;
}

type PromptMemoryStore = ReturnType<SystemPromptAssemblyDependencies["memoryStore"]>;
type PromptMemorySnapshots = ReturnType<SystemPromptAssemblyDependencies["memorySnapshots"]>;
type PromptAutomationStore = ReturnType<SystemPromptAssemblyDependencies["automationStore"]>;
type PromptWorkflowStore = ReturnType<SystemPromptAssemblyDependencies["workflowStore"]>;
type PromptChannelStore = ReturnType<SystemPromptAssemblyDependencies["channelStore"]>;

function createTypedInferenceOwner(
  value: DynamicApi,
): ProductionTurnAgentOwnerInput["inference"] {
  const createSession = method(value, "createSession");
  const resolvePrivacyMode = method(value, "resolvePrivacyMode");
  if (createSession === undefined || resolvePrivacyMode === undefined) {
    throw new TypeError("production inference session/privacy owner is not bound");
  }
  const createSummarizationSession = method(value, "createSummarizationSession");
  return {
    createSession: (onRequestId, options) => createSession(onRequestId, options),
    resolvePrivacyMode: async (): Promise<PrivacyModeValue> => {
      const resolved = await resolvePrivacyMode();
      if (
        resolved === PrivacyMode.UNSPECIFIED
        || resolved === PrivacyMode.NO_STORAGE
        || resolved === PrivacyMode.NO_TRAINING
        || resolved === PrivacyMode.USAGE_DATA_TRAINING_ALLOWED
        || resolved === PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED
      ) return resolved;
      throw new TypeError("production inference returned an invalid privacy mode");
    },
    ...(createSummarizationSession === undefined
      ? {}
      : { createSummarizationSession: (onRequestId: (requestId: string) => void, options?: Readonly<Record<string, unknown>>) => createSummarizationSession(onRequestId, options) }),
  };
}

function createTextExecutor(executor: {
  appendMessages(...args: any[]): void;
  clearMessages(): void;
  getMessages(): readonly unknown[];
  getState(): unknown;
  stream(...args: any[]): unknown;
}): TextExecutor {
  return {
    appendMessages: messages => executor.appendMessages(messages),
    clearMessages: () => executor.clearMessages(),
    getMessages: () => executor.getMessages(),
    getState: () => executor.getState(),
    stream: (context, first, second, options) => {
      const result = executor.stream(context, first, second, options);
      if (typeof result !== "object" || result == null) {
        throw new TypeError("production prompt executor returned no stream");
      }
      const fullStream = (result as Record<string, unknown>).fullStream;
      if (
        typeof fullStream !== "object"
        || fullStream == null
        || typeof (fullStream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
      ) throw new TypeError("production prompt executor returned an invalid stream");
      return { fullStream: fullStream as AsyncIterable<{ readonly type: string; readonly textDelta?: string; readonly error?: unknown }> };
    },
  };
}

function toGeneratedTurnPromptOptions(
  options: {
    readonly selectedImages?: readonly unknown[];
    readonly selectedVideos?: readonly unknown[];
    readonly attachedFilePaths?: readonly string[];
    readonly attachedFileSizes?: ReadonlyMap<string, number>;
    readonly richText?: string;
    readonly replyContext?: unknown;
    readonly messageId?: string;
    readonly automationWake?: { readonly id: string };
    readonly isSilenceAllowed?: boolean;
    readonly appendReplyReminder?: boolean;
    readonly hidden?: boolean;
    readonly recentUserMessages?: readonly { readonly id: string; readonly text: string }[];
  },
): GeneratedTurnPromptOptions {
  const selectedImages = options.selectedImages?.flatMap(image => {
    if (typeof image !== "object" || image == null) return [];
    const record = image as Record<string, unknown>;
    const data = record.data;
    if (!(data instanceof Uint8Array)) return [];
    return [{
      data,
      ...(typeof record.path === "string" ? { path: record.path } : {}),
      ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
    }];
  });
  const selectedVideos = options.selectedVideos?.filter(isGeneratedSelectedVideo);
  return {
    ...(selectedImages === undefined ? {} : { selectedImages }),
    ...(selectedVideos === undefined ? {} : { selectedVideos }),
    ...(options.attachedFilePaths === undefined ? {} : { attachedFilePaths: options.attachedFilePaths }),
    ...(options.attachedFileSizes === undefined ? {} : { attachedFileSizes: options.attachedFileSizes }),
    ...(options.richText === undefined ? {} : { richText: options.richText }),
    ...(options.replyContext === undefined ? {} : { replyContext: options.replyContext }),
    ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
    ...(options.automationWake === undefined ? {} : { automationWake: options.automationWake }),
    ...(options.isSilenceAllowed === undefined ? {} : { isSilenceAllowed: options.isSilenceAllowed }),
    ...(options.appendReplyReminder === undefined ? {} : { appendReplyReminder: options.appendReplyReminder }),
    ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
    ...(options.recentUserMessages === undefined ? {} : { recentUserMessages: options.recentUserMessages }),
  };
}

function isPromptRequestContext(value: unknown): value is PromptRequestContext {
  return typeof value === "object" && value != null
    && typeof (value as { resolve?: unknown }).resolve === "function"
    && typeof (value as { resolveRules?: unknown }).resolveRules === "function";
}

function resolveRequestContextEnvironment(
  requestContext: unknown,
): {
  readonly timeZone?: string;
  readonly projectFolder?: string;
  readonly osVersion?: string;
} {
  if (
    typeof requestContext !== "object"
    || requestContext == null
    || typeof (requestContext as { readonly resolve?: unknown }).resolve !== "function"
  ) return {};
  const resolved = (requestContext as { resolve(): unknown }).resolve();
  if (typeof resolved !== "object" || resolved == null) return {};
  const candidate = resolved as Record<string, unknown>;
  const environment = typeof candidate.env === "object" && candidate.env != null
    ? candidate.env as Record<string, unknown>
    : candidate;
  return {
    ...(typeof (candidate.timeZone ?? environment.timeZone) === "string"
      ? { timeZone: (candidate.timeZone ?? environment.timeZone) as string }
      : {}),
    ...(typeof environment.projectFolder === "string"
      ? { projectFolder: environment.projectFolder }
      : {}),
    ...(typeof (candidate.osVersion ?? environment.osVersion) === "string"
      ? { osVersion: (candidate.osVersion ?? environment.osVersion) as string }
      : {}),
  };
}

function isCloudAgentApi(api: DynamicApi): api is CloudAgentApi {
  return ["launch", "list", "listModels", "get", "reply", "rename", "cancel", "setArchived", "delete", "listArtifacts", "getTranscriptDump"]
    .every(name => typeof api[name] === "function");
}

interface RunnerSubagentOwner {
  listRunningSubagents(): readonly RunningSubagentInfo[];
  getRunningSubagent(id: string): RunningSubagentInfo | null;
  steerSubagent(id: string, message: string): "steered" | "not-running" | string;
  abortSubagent(id: string): "aborted" | "not-running" | string;
}

interface RunnerCloudWatchOwner {
  isCloudWatchReady?(): boolean;
  watchCloudAgent(
    id: string,
    options?: { readonly quietOrigin?: string; readonly afterFollowup?: boolean },
  ): void;
}

function isRunnerSubagentOwner(value: unknown): value is RunnerSubagentOwner {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Record<string, unknown>;
  return [
    "listRunningSubagents",
    "getRunningSubagent",
    "steerSubagent",
    "abortSubagent",
  ].every(name => typeof candidate[name] === "function");
}

function createRunnerSubagentManagement(
  value: unknown,
): SubagentManagementController<unknown> | undefined {
  if (!isRunnerSubagentOwner(value)) return undefined;
  return {
    listRunningSubagents: () => value.listRunningSubagents(),
    getRunningSubagent: id => value.getRunningSubagent(id) ?? undefined,
    steerSubagent: (id, message) => value.steerSubagent(id, message),
    abortSubagent: id => value.abortSubagent(id),
  };
}

/** A missing handoff service must fail the tool, not report a handoff that never happened. */
function isBoxHelpOutcome(value: unknown): value is BoxHelpOutcome {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.requestId !== "string") return false;
  return candidate.kind === "started"
    || (candidate.kind === "already-pending"
      && typeof candidate.instruction === "string");
}

function createRunnerCloudWatch(
  value: unknown,
): CloudAgentToolDeps["watch"] | undefined {
  if (
    typeof value !== "object"
    || value == null
    || typeof (value as Record<string, unknown>).watchCloudAgent !== "function"
  ) return undefined;
  const owner = value as RunnerCloudWatchOwner;
  if (
    typeof owner.isCloudWatchReady === "function"
    && owner.isCloudWatchReady() !== true
  ) return undefined;
  return (id, options) => {
    const quietOrigin = typeof options.quietOrigin === "string"
      ? options.quietOrigin
      : undefined;
    owner.watchCloudAgent(id, {
      ...(quietOrigin === undefined ? {} : { quietOrigin }),
      ...(options.afterFollowup === undefined
        ? {}
        : { afterFollowup: options.afterFollowup }),
    });
  };
}

function requestIdForwarder(hooks: HostRunnerHooks, source: string) {
  return (requestId: string) => {
    hooks.transport.onUpdate({
      type: "request-id",
      requestId,
      source
    });
  };
}

/**
 * Composes each turn runner from extension-owned ports. The composition keeps
 * group-member turns intentionally narrower: they do not receive the private
 * transcript mirror, memory stores, image persistence, or local permission
 * approval surface.
 */
export function createHostRunnerComposition<Runner extends ProductionSessionBoundRunner>(
  deps: HostRunnerCompositionDependencies<Runner>
): RecoveredHostRunnerComposition<Runner> {
  const { extensions, ctx } = deps;
  const auth = extensions.api("auth");
  const localToolPermission = extensions.api("local-tool-permission");
  const localToolPermissionSurfaces = new Map<string, () => void>();
  const ownedRunners = new Set<Runner>();
  let mirrorOffloadPool: TranscriptMirrorOffloadPool | null = null;

  const getMirrorOffloadPool = () => {
    mirrorOffloadPool ??=
      deps.mirrorPoolFactory?.() ?? new TranscriptMirrorOffloadPool();
    return mirrorOffloadPool;
  };

  const resolveAgentDisplayName = (agentId: string): string | null => {
    const transcript = extensions.api("transcript");
    const roster = method(transcript, "listAgentsSync")?.() ?? [];
    return roster.find(
      (agent: any) => agent.id === agentId && agent.isGroup !== true
    )?.name ?? null;
  };

  function bindLocalPermissionSurface(
    session: HostRunnerSession,
    hooks: HostRunnerHooks,
    overrides: HostRunnerOverrides
  ): void {
    localToolPermissionSurfaces.get(session.id)?.();
    localToolPermissionSurfaces.delete(session.id);
    if (overrides.groupMemberTurn === true) return;

    const subscribe = method(localToolPermission, "subscribe");
    if (subscribe == null) return;
    const unsubscribe = subscribe((event: any) => {
      if (event?.request?.agentId !== session.id) return;

      if (event.type === "created") {
        hooks.transport.onUpdate({
          type: "send-message",
          message: {
            type: "local-tool-permission",
            ask: {
              requestId: event.request.id,
              action: event.request.action,
              target: event.request.target,
              status: "pending",
              ...(event.request.description === undefined
                ? {}
                : { description: event.request.description })
            }
          },
          timestampMs: Date.now()
        });
        return;
      }

      hooks.transport.onUpdate({
        type: "local-tool-permission-status",
        requestId: event.request.id,
        status: event.request.status === "pending"
          ? "expired"
          : event.request.status
      });
    });
    localToolPermissionSurfaces.set(session.id, unsubscribe);
  }

  function createRunner(
    session: HostRunnerSession,
    hooks: HostRunnerHooks,
    overrides: HostRunnerOverrides = {}
  ): Runner {
    const isSharedRoomTurn = overrides.isSharedRoomTurn === true;
    const localExec = extensions.api("local-exec");
    /**
     * TOOLS-15. Five of the tools the model was offered -- ExternalShell, ExternalRead,
     * AwaitExternalShell, CopyToBox, CopyFromBox -- reach the operator's own computer over the
     * local-exec bridge, and the bridge only carries a request when a provider has registered on
     * the gateway's local-exec stream and said hello. With nothing on the far end the model was
     * handed five tools that block until the response watchdog gives up, and taught in the prompt
     * to reach for them. The toolset and the prompt now ask the same question once per turn.
     *
     * The bridge's answer is a 30 s liveness window (SAND_LOCAL_EXEC_LIVENESS_WINDOW_MS), so it
     * means "a computer is answering right now", nothing more, and it is read per turn rather than
     * cached: a computer that connects mid-conversation is offered on the very next turn, and one
     * that drops out is withheld just as fast. That swing is accepted with its cost known. A
     * lapsed heartbeat swaps the base prompt between two variants about 1.5k chars apart and
     * changes the offered tool list mid-conversation, which re-primes the provider's prefix cache
     * and leaves earlier assistant tool calls in the history naming tools no longer offered. We
     * take that over the alternative, because the alternative is offering a tool that cannot work:
     * a dead ExternalShell costs a whole turn and a watchdog timeout, and a moving toolset is
     * already normal here (an MCP server coming or going does the same thing). If the flapping
     * ever shows up as real cost, the fix is a grace window on the withhold direction only.
     *
     * SAND_LOCAL_MACHINE pins the withheld world on a running box, which is the only way to
     * exercise that leg on a machine whose daemon is attached (scripts/verify-toolset.mjs runs it).
     *
     * TOOLS-18. "Once per turn" used to be a claim, not a mechanism: the toolset builder and the
     * prompt assembly each called this, and with a 30 s liveness window between them a lapsed
     * heartbeat split the turn -- a prompt teaching five tools the wire had already withheld. The
     * answer is now read once and held until this conversation's own run shell emits the next
     * "started" (see `noteRunLifecycleFor`), so every consumer in a turn gets the same value, and
     * the next turn still re-reads: a computer that connects mid-conversation is offered on the
     * turn after it connects.
     */
    const localMachineReader = createTurnLocalMachineReader({
      readOverride: () => readSandBoxSetting(SAND_LOCAL_MACHINE_SETTING),
      hasAnnouncedComputer: () => method(localExec, "hasLiveComputer")?.() ?? false,
      ownerConversationId: session.id,
    });
    const localMachine = () => localMachineReader.read();
    const localMachineConnected = (): boolean => localMachine().connected;
    /**
     * TOOLS-18. The turn boundary the held answer is dropped on. Both run paths (the runner's own
     * and the production run shell's) emit "started" through the caller's hook, so wrapping it here
     * is the one seam that sees every turn begin -- including a subagent's, which is why the
     * wrapper is made per run identity. A child runner is built from this same `runnerOptions` and
     * its run shell forwards here too, so one shared wrapper dropped the parent's held answer the
     * moment a Task dispatched: the parent's prompt was already frozen on the pre-dispatch answer
     * while its post-subagent tool builds took a fresh read. Only the conversation the reader
     * belongs to resets it; a nested or background subagent runs inside its parent's answer.
     */
    const noteRunLifecycleFor = (runConversationId: string) => (event: unknown): void => {
      if (typeof event === "object" && event !== null
        && (event as { readonly type?: unknown }).type === "started") {
        localMachineReader.beginTurn(runConversationId);
        // CLOUD-BROWSER-1. A new turn gets its cloud-session allowance back. Without this the
        // ceiling would be per host process rather than per turn, and an agent that browsed twice
        // this morning could never reach a cloud browser again until the box restarted.
        cloudBrowserService.beginTurn(runConversationId);
      }
      hooks.onRunLifecycle?.(event);
    };
    const noteRunLifecycle = noteRunLifecycleFor(session.id);
    /**
     * TOOLS-17. Whether a shared-room member keeps the box tools beside SendMessage, asked in one
     * place because two callers used to ask it differently: the runner honoured the kill switch and
     * the toolset host, the one that actually filters the tools, did not -- so the switch that is
     * supposed to strip a room back to text could only ever half apply. Both halves read the same
     * host setting per tool build, which is also the only way the text-only room can be driven on a
     * running box: the gate behind the kill switch cannot bootstrap without a Cursor login.
     */
    /**
     * BROWSER-1. Whether Titan holds his own four browser tools this turn. Read per tool build and
     * per prompt render from the host settings file, so an operator can take the browser away on a
     * live box without a recreate, and so the offered tools and the prompt paragraph that teaches
     * them are always the same answer. Default on: there is no Statsig gate behind these tools.
     */
    const browserToolsEnabled = (): boolean =>
      resolveBrowserToolsEnabled(readSandBoxSetting(SAND_BROWSER_TOOLS_SETTING));
    /**
     * CLOUD-BROWSER-1. The cloud leg of the same four browser tools, resolved live per turn beside
     * the switch above rather than captured once, so an operator can change which browser a
     * workspace uses on a running box without a recreate -- the policy file is re-read on every
     * routing decision, and the stored keys are re-read with it.
     *
     * The service is built once because it holds two pieces of live state a per-turn rebuild would
     * throw away: the register of open cloud sessions the console draws from, and the per-turn
     * session ceiling. Neither is a setting, and neither survives being reconstructed.
     *
     * `getBoxName` is the best name the box has for itself, and the ledger field is named after
     * what it holds rather than after what somebody hoped it held. A box does not know its
     * control-plane slug -- nothing pushes it in -- so this is a hostname, which inside a container
     * is a short docker id. The relay stamps the authoritative slug onto what it serves, because
     * the relay is the thing that knows which box belongs to whom.
     */
    const cloudBrowserService = new CloudBrowserService({
      rootDir: getSandRootDir(),
      fetch: ((input: string, init?: Record<string, unknown>) =>
        fetch(input, init as RequestInit)) as CloudBrowserPorts["fetch"],
      getBoxName: () => readSandBoxSetting("SAND_TENANT") ?? hostname(),
      getAgentId: () => session.id,
      /**
       * How long a held browser may sit unused before it is given back. It is a setting because it
       * is the one bound on what a forgotten cloud browser can cost, so an operator has to be able
       * to shorten it on a running box -- and because a gate that cannot shorten it cannot prove
       * the release path in less than four minutes. Read per call; anything outside 5..900 seconds
       * is ignored and the default stands.
       */
      get viewIdleMs(): number {
        const seconds = Number(readSandBoxSetting("SAND_CLOUD_BROWSER_IDLE_SECONDS"));
        return Number.isFinite(seconds) && seconds >= 5 && seconds <= 900
          ? Math.floor(seconds) * 1000
          : CLOUD_VIEW_IDLE_SECONDS * 1000;
      },
      // The gate's loopback endpoint (scripts/verify-browser-tools.mjs --cloud-shape). Read per
      // call so a gate can set it and clear it without a restart; the module refuses anything that
      // is not ws:// on 127.0.0.1, so this cannot become a way to point the browser somewhere else.
      getFakeEndpoint: () => readSandBoxSetting("SAND_CLOUD_BROWSER_LOOPBACK_CDP") ?? null,
    });
    // The orphan sweep, once. It asks each vendor what state an unfinished session is in before it
    // stops anything, and a host that starts with no keys stored finds nothing to ask about.
    void cloudBrowserService.sweep().catch((error: unknown) => {
      console.warn(`[sand][cloud-browser] the session sweep did not finish: ${error instanceof Error ? error.message : String(error)}`);
    });
    /**
     * The seam, added to a dependencies object built by somebody else's function. Spread rather
     * than passed through `createHostBrowserDriverDependencies` on purpose: that projection belongs
     * to the computer-tool file, `cloudBrowser` is optional on the dependency type, and a browser
     * built without it behaves exactly as it did before this wave.
     */
    const withCloudBrowser = <T extends object>(dependencies: T): T & { cloudBrowser: CloudBrowserSeam } => ({
      ...dependencies,
      cloudBrowser: {
        route: input => cloudBrowserService.route(input),
        shouldEscalate: verdicts => cloudBrowserService.shouldEscalate(verdicts),
        // The browser is held for the life of a PAGE, not of a tool call, which is what makes a
        // sign-up possible at all: the click after the open reaches the browser the open used.
        viewEngine: viewId => cloudBrowserService.viewEngine(viewId),
        hold: async input => await cloudBrowserService.hold({
          viewId: input.viewId,
          engine: input.engine as "box" | CloudBrowserVendor,
          reason: input.reason,
          url: input.url,
        }),
        releaseView: async viewId => { await cloudBrowserService.releaseView(viewId); },
      },
    });
    const sharedRoomBoxToolsEnabled = (): boolean =>
      !Boolean(method(experiments, "checkFeatureGate")?.(
        "sand_shared_room_box_tools_kill_switch"
      )) && resolveSharedRoomBoxToolsEnabled(
        readSandBoxSetting(SAND_SHARED_ROOM_BOX_TOOLS_SETTING)
      );
    const attachments = extensions.api("attachments");
    const memory = extensions.api("memory");
    const transcript = extensions.api("transcript");
    const experiments = extensions.api("experiments");
    const telemetry = extensions.api("telemetry");
    const analytics = telemetry.analytics as DynamicApi | undefined;
    const mcp = extensions.api("mcp");
    const sessionApi = extensions.api("session");
    const settings = extensions.api("settings");
    const cloudAgents = extensions.api("cloud-agents");
    const foreverBox = extensions.api("forever-box");
    const remoteBox = foreverBox.box as DynamicApi;
    const transcriptsDir = method(sessionApi, "transcriptsDir")?.() ??
      dirname(dirname(session.dbPath));

    const actionAuditor = deps.decorateActionAuditor?.(
      extensions.api("action-audit"),
      {
        onBotBlock(hit, record) {
          method(telemetry.brain ?? {}, "reportBotBlock")?.({
            conversationId: record.agentId,
            family: hit.family,
            confidence: hit.confidence,
            blockedHost: hit.blockedHost,
            blockedUrl: hit.blockedUrl
          });
          method(analytics ?? {}, "trackEvent")?.("sand.bot_block", {
            agent_id: record.agentId,
            family: hit.family,
            confidence: hit.confidence,
            blocked_host: hit.blockedHost,
            blocked_url: hit.blockedUrl
          });
        },
        onSiteVisit(visit, record) {
          method(analytics ?? {}, "trackEvent")?.("sand.site.visited", {
            agent_id: record.agentId,
            host: visit.host
          });
        }
      }
    ) ?? extensions.api("action-audit");

    const autoReview = method(
      extensions.api("auto-review"),
      "bindRunner"
    )?.({
      agentId: session.id,
      approvalsResolvable: overrides.groupMemberTurn !== true,
      onUpdate: (update: unknown) => hooks.transport.onUpdate(update)
    }) ?? {};

    const autoReviewController = asSandAutoReviewController(
      autoReview.autoReviewController,
    );

    const autoReviewGate = (() => {
      if (
        autoReviewController == null
        || autoReview.autoReviewModes == null
        || typeof autoReview.getAutoReviewModes !== "function"
      ) return undefined;
      const dependencies = {
        baseModes: autoReview.autoReviewModes,
        getModes: () => autoReview.getAutoReviewModes(),
        controller: () => autoReviewController,
        resolveBoxId: () => session.id,
        ...(typeof autoReview.getAutoReviewInstructions === "function"
          ? { getInstructions: () => autoReview.getAutoReviewInstructions() }
          : {}),
      };
      return createAutoReviewGate(dependencies);
    })();

    const persistImageForTurn = typeof hooks.persistImage === "function"
      ? async (bytes: Uint8Array, mimeType: string) => {
        const result = await hooks.persistImage?.(bytes, mimeType);
        if (
          typeof result === "object"
          && result != null
          && "fileUrl" in result
          && typeof result.fileUrl === "string"
        ) return { fileUrl: result.fileUrl };
        return undefined;
      }
      : undefined;

    const createTurnToolProjections =
      autoReviewGate == null
        ? undefined
        : (input: ProductionTurnToolInputs): ProductionTurnHostToolProjections => {
          const shell = createHostShellExecutor({
            resourceAccessor: input.resourceAccessor,
            assertNoPendingApproval: autoReviewGate.assertNoPendingApproval,
            auditShellCommand: command => {
              evidenceRegistry.noteReceipt(session.id, "shell");
              method(actionAuditor as DynamicApi, "record")?.({
                agentId: session.id,
                occurredAtMs: Date.now(),
                ...evidenceRegistry.receiptFields(session.id),
                action: {
                  kind: "shellCommand",
                  command,
                  shellKind: "foreground",
                  target: "box",
                },
              });
            },
          });
          const userAutoRunInstructions = autoReviewGate.userInstructions();
          const projectionAutoReviewModes = autoReviewGate.currentModes();
          const projection = {
            createComputerToolDependencies: () => createHostComputerToolDependencies({
              resourceAccessor: input.resourceAccessor,
              autoReview: {
                mode: projectionAutoReviewModes.computer,
                agentId: session.id,
                boxIdentity: {
                  boxId: session.id,
                  windowGeneration: `${autoReviewController?.hostGeneration ?? "host"}:${session.id}`,
                },
                ...(autoReviewController === undefined
                  ? {}
                  : { autoReviewController }),
                extractConversationContext:
                  extractProductionTurnAutoReviewConversationContext,
                getApprovalExpiryPolicy: () =>
                  sandAutoReviewApprovalExpiryPolicy("turn"),
                resolveDisplayNumber: async (context: unknown) => {
                  await method(remoteBox, "ensureReady")?.(context, session.id);
                  const windowIndex = boxAgentWindowIndex(remoteBox as any, session.id);
                  return windowIndex ?? (boxSupportsMultiWindow(remoteBox as any) ? undefined : 1);
                },
                ...(userAutoRunInstructions === undefined
                  ? {}
                  : { userAutoRunInstructions }),
              },
              ...(persistImageForTurn === undefined
                ? {}
                : { persistImage: persistImageForTurn }),
              isUnicodeTypingEnabled: () =>
                method(experiments, "isUnicodeTypingEnabled")?.() ?? false,
              onComputerAction: action => {
                deps.emitGatewayEvent({
                  channel: "computer-action",
                  payload: { agentId: session.id, ...action },
                });
              },
            }),
            createScreenshotToolDependencies: () => createHostComputerToolDependencies({
              resourceAccessor: input.resourceAccessor,
              ...(persistImageForTurn === undefined
                ? {}
                : { persistImage: persistImageForTurn }),
              isUnicodeTypingEnabled: () =>
                method(experiments, "isUnicodeTypingEnabled")?.() ?? false,
            }),
            createBrowserDriverDependencies: () => withCloudBrowser(createHostBrowserDriverDependencies({
              resourceAccessor: input.resourceAccessor,
              box: remoteBox as unknown as HostBrowserBoxOwner<unknown>,
              getBoxId: () => session.id,
              getDefaultViewId: () => session.id,
              executeShell: shell,
              autoReview: {
                mode: projectionAutoReviewModes.computer,
                agentId: session.id,
                boxIdentity: {
                  boxId: session.id,
                  windowGeneration: `${autoReviewController?.hostGeneration ?? "host"}:${session.id}`,
                },
                ...(autoReviewController === undefined
                  ? {}
                  : { autoReviewController }),
                extractConversationContext:
                  extractProductionTurnAutoReviewConversationContext,
                getApprovalExpiryPolicy: () =>
                  sandAutoReviewApprovalExpiryPolicy("turn"),
                resolveDisplayNumber: async (context: unknown) => {
                  await method(remoteBox, "ensureReady")?.(context, session.id);
                  const windowIndex = boxAgentWindowIndex(remoteBox as any, session.id);
                  return windowIndex ?? (boxSupportsMultiWindow(remoteBox as any) ? undefined : 1);
                },
                ...(userAutoRunInstructions === undefined
                  ? {}
                  : { userAutoRunInstructions }),
              },
              ...(persistImageForTurn === undefined
                ? {}
                : { getPersistImage: () => persistImageForTurn }),
            })),
            createBoxShellExecutor: () => shell,
          };
          return projection;
        };

    const createTurnWebAndAwaitProjections = (
      input: ProductionTurnToolInputs,
    ): ProductionTurnHostToolProjections => {
      const inference = extensions.api("inference");
      const webSearchService = method(inference, "createWebSearch")?.({
        modelId: process.env.SAND_AGENT_MODEL ?? DEFAULT_SAND_MODEL,
        onRequestId: requestIdForwarder(hooks, "web-search"),
      });
      const webFetchService = method(inference, "createWebFetch")?.({
        onRequestId: requestIdForwarder(hooks, "web-fetch"),
      });
      const contextEnvironment = webSearchService === undefined
        && webFetchService === undefined
        ? {}
        : resolveRequestContextEnvironment(requestContext);
      const conversationStartedDate = webSearchService === undefined
        ? undefined
        : method(
          input.stateHandler as DynamicApi,
          "getOrInitializeConversationStartedDate",
        )?.(contextEnvironment.timeZone);
      const projectFolder = contextEnvironment.projectFolder;
      const osPlatform = contextEnvironment.osVersion?.split(" ")[0];
      const webSearch = webSearchService === undefined
        ? undefined
        : {
            webSearchService,
            promptVersion: "latest",
            ...(typeof conversationStartedDate === "string"
              ? { conversationStartedDate }
              : {}),
            ...(projectFolder === undefined ? {} : { projectFolder }),
            ...(osPlatform === undefined ? {} : { osPlatform }),
            resourceAccessor: input.resourceAccessor,
          };
      const webFetch = webFetchService === undefined
        ? undefined
        : {
            webFetchService,
            promptVersion: "latest",
            ...(projectFolder === undefined ? {} : { projectFolder }),
            ...(osPlatform === undefined ? {} : { osPlatform }),
            resourceAccessor: input.resourceAccessor,
          };
      const getTerminalsFolder = method(remoteBox, "getTerminalsFolder");
      const externalAwait: ProductionTurnExternalAwaitInputs | undefined =
        getTerminalsFolder === undefined
          ? undefined
          : {
              resourceAccessor: input.resourceAccessor,
              options: {
                toolName: SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
                terminalsFolder: () => getTerminalsFolder() ?? "",
                enableSubagentAwaiting: false,
                defaultBlockUntilMs: 30_000,
                enableJobCompletionNotifications: true,
              },
            };
      return {
        ...(webSearch === undefined ? {} : { webSearch }),
        ...(webFetch === undefined ? {} : { webFetch }),
        ...(externalAwait === undefined ? {} : { externalAwait }),
      };
    };

    bindLocalPermissionSurface(session, hooks, overrides);

    let builtRunner: Runner | undefined;
    let transcriptMirrorForTurn: TurnSettleHost["transcriptMirror"] | undefined;

    const requestContext = isSharedRoomTurn
      ? {
          resolve: () => ({}),
          resolveRules: async () => []
        }
      : deps.createRequestContext?.({
          transcriptsDir,
          getUserTimeZone: () => method(settings, "getUserTimeZone")?.(),
          resolveTeamRules: async () =>
            await method(
              extensions.api("managed-setup"),
              "resolveTeamRules"
            )?.(),
          getUserFullName: async () =>
            await method(auth, "getUserFullName")?.()
        });

    const resolveCloudAgentTitle = async (_ctx: unknown, bcId: string) =>
      (await method(cloudAgents, "get")?.(bcId))?.name;
    const awaitCloudAgent = method(cloudAgents, "awaitCompletion");
    const sendToAgent = (
      toAgentId: string,
      text: string,
      images: unknown,
      priority: boolean,
    ) => method(transcript, "sendToAgent")?.(
      session.id,
      toAgentId,
      text,
      images,
      priority,
    );
    const agentManagement = {
      create: async (input: { name: string; description: string }) => {
        const result = await method(
          transcript,
          "createBackgroundAgent"
        )?.({
          name: input.name,
          description: input.description
        }, "user");
        const agent = result.agent;
        return {
          id: agent.id,
          name: agent.name,
          description: agent.description
        };
      },
      update: async (
        id: string,
        patch: { name?: string; description?: string }
      ) => {
        const current = (await method(transcript, "listAgents")?.())
          ?.find((agent: any) => agent.id === id);
        if (current == null || current.isGroup) return null;
        const summary = await method(transcript, "updateAgent")?.(id, {
          name: patch.name ?? current.name,
          description: patch.description ?? current.description
        });
        return summary == null
          ? null
          : {
              id: summary.id,
              name: summary.name,
              description: summary.description
            };
      }
    };
    const agentStateOwner = !isSharedRoomTurn
      ? method(memory, "createAgentState")?.({
          memory: session.memory,
          automations: session.automations,
          workflows: session.workflows,
          channels: session.channels,
          agentDir: dirname(session.dbPath),
          agentId: session.id,
          readBoxFile: (boxPath: string) =>
            method(remoteBox, "downloadFile")?.(ctx, session.id, boxPath),
          // STATE-1: AgentStateDeps requires these three and `method()` hides that from the type
          // checker, so an agent's update_state on its own profile died with "deps.readProfile is
          // not a function" and a settings write would have died the same way. They are the
          // session's own profile file and the transcript manager's two setting writers.
          readProfile: () => {
            const profile = method(sessionApi, "getAgentProfileText")?.(session.id);
            return profile == null
              ? null
              : {
                  name: String(profile.name ?? ""),
                  description: String(profile.description ?? ""),
                  ...(profile.title == null ? {} : { title: String(profile.title) })
                };
          },
          writeProfile: (profile: Record<string, string>) => {
            const write = method(sessionApi, "updateAgentProfile")?.(session.id, {
              name: String(profile.name ?? ""),
              description: String(profile.description ?? ""),
              ...(profile.title == null ? {} : { title: String(profile.title) })
            });
            if (write != null && typeof (write as Promise<unknown>).catch === "function") {
              void (write as Promise<unknown>).catch((error: unknown) =>
                console.warn(`[sand][state] profile write from update_state failed: ${String(error)}`)
              );
            }
          },
          writeSettings: (settings: Record<string, boolean>) => {
            if ("hiddenFromSidebar" in settings)
              method(transcript, "setAgentHiddenFromSidebar")?.(session.id, settings.hiddenFromSidebar);
            if ("notifyOnAgentUpdates" in settings)
              method(transcript, "setAgentNotifyOnUpdates")?.(session.id, settings.notifyOnAgentUpdates);
          }
        })
      : undefined;

    const productionContext = isAgentContext(ctx) ? ctx : undefined;
    const productionRequestContext = isPromptRequestContext(requestContext)
      ? requestContext
      : undefined;
    const readVideoAttachmentBytes = method(attachments, "readVideoBytes");
    const mcpCustomInstructions = method(mcp.mcp, "getCustomInstructions");
    /**
     * SP-2. `turn-run-shell` declares three setters for this state and calls them, but the
     * production run shell never supplies `discoverMcpTools`, so on this path the setters were
     * dead and the prompt glue was handed the constants `[]`, `new Map()` and `false`. The
     * production route discovers connectors inside the run-input projection instead
     * (`createTurnAgentRunInputProjection`), so the same three facts are recorded there, once
     * per turn, and read from here. Without this the model is never told which connectors are
     * connected, never sees their custom instructions, and is never told discovery failed.
     */
    let mcpConnectedServerNamesForTurn: readonly string[] = [];
    let mcpCustomInstructionsForTurn: ReadonlyMap<string, string> = new Map();
    let mcpDiscoveryUnavailableForTurn = false;
    let shellWatchWatermark:
      | { readonly turnCount: number; readonly boundaryRef: Uint8Array; readonly lastUserMessageId?: string; readonly hasUserTurn: boolean }
      | undefined;
    /**
     * SUB-1 / TOOLS-03. The prompt glue carries the runner identity the collector reads for
     * the "Your box" and "Browser" sections (`getRemoteBoxSection`, `getComputerSection`), and
     * it was built once with every flag false. A browserUse subagent was therefore handed the
     * chief's desktop prompt: no "Browser" section, no mention of its browser_* tools, and an
     * explicit ban on driving Chrome from Shell -- so it answered that its browser tools were
     * unavailable while holding all fifteen of them. One glue per identity, memoized like the
     * assembly below; the chief glue is unchanged for every other caller (file transfer, turn
     * actions, prompt state).
     */
    type PromptIdentity = {
      readonly isSubagentRunner: boolean;
      readonly isBoxScopedSubagent: boolean;
      readonly isComputerUseSubagent: boolean;
      readonly isBrowserUseSubagent: boolean;
    };
    const CHIEF_IDENTITY: PromptIdentity = {
      isSubagentRunner: false,
      isBoxScopedSubagent: false,
      isComputerUseSubagent: false,
      isBrowserUseSubagent: false,
    };
    const promptIdentityKey = (identity: PromptIdentity): string =>
      `${identity.isSubagentRunner}|${identity.isBoxScopedSubagent}|${identity.isComputerUseSubagent}|${identity.isBrowserUseSubagent}`;
    const promptGluesByIdentity = new Map<string, ReturnType<typeof createRunnerPromptGlue>>();
    const makePromptGlue = (identity: PromptIdentity) => {
      if (productionContext === undefined || productionRequestContext === undefined) return undefined;
      const key = promptIdentityKey(identity);
      const existing = promptGluesByIdentity.get(key);
      if (existing !== undefined) return existing;
      const built = (() => {
        const box = asTransferBox(localExec.box);
        const remoteBoxForPrompt = asCapableTransferBox(remoteBox);
        const userComputers = asPromptUserComputers(localExec.userComputers);
        if (box === undefined || remoteBoxForPrompt === undefined || userComputers === undefined) return undefined;
        const readVideoAttachment = readVideoAttachmentBytes === undefined
          ? undefined
          : async (path: string): Promise<Uint8Array | null> => {
              const value = await readVideoAttachmentBytes(path);
              return value instanceof Uint8Array ? value : null;
            };
        return createRunnerPromptGlue({
          ctx: productionContext,
          box,
          remoteBox: remoteBoxForPrompt,
          userComputers,
          remoteBoxHasDesktop: true,
          isLocalMachineConnected: () => localMachineConnected(),
          isSubagentRunner: identity.isSubagentRunner,
          isComputerUseSubagent: identity.isComputerUseSubagent,
          isBrowserUseSubagent: identity.isBrowserUseSubagent,
          requestContext: productionRequestContext,
          ...(typeof hooks.agentProfileProvider === "function"
            ? { agentProfileProvider: () => hooks.agentProfileProvider?.() ?? { name: "", description: "" } }
            : {}),
          ...(readVideoAttachment === undefined
            ? {}
            : { readVideoAttachmentBytes: readVideoAttachment }),
          isSpotlightEnabled: () => method(experiments, "isSpotlightEnabled")?.() ?? false,
          // BROWSER-1: the same reader the toolset gate uses, so the prompt never teaches a tool
          // the model was not handed (and never withholds the paragraph for a tool it was).
          isBrowserToolsEnabled: browserToolsEnabled,
          uploadAttachmentsIntoBox: async paths =>
            new Map(await method(attachments, "stageIntoBox")?.(session.id, paths) ?? []),
          getRemoteBoxAvailable: () => method(remoteBox, "isAvailable")?.() !== false,
          getConversationId: () => session.id,
          resolveBoxId: () => session.id,
          ...(mcpCustomInstructions === undefined
            ? {}
            : { mcp: { getCustomInstructions: async (_context: Context) => await mcpCustomInstructions() } }),
          mcpConnectedServerNamesForTurn: () => mcpConnectedServerNamesForTurn,
          mcpCustomInstructionsForTurn: () => mcpCustomInstructionsForTurn,
          isMcpDiscoveryUnavailableForTurn: () => mcpDiscoveryUnavailableForTurn,
          shellWatchHost: () => {
            const store = session.agentStore;
            if (
              store == null
              || typeof store.getConversationStateStructure !== "function"
              || typeof store.getBlobStore !== "function"
            ) throw new TypeError("production prompt state store is not bound");
            const blobStore = getAgentBlobStore(
              store as Parameters<typeof getAgentBlobStore>[0],
            );
            const generated = createShellWatchGeneratedStateProjection({
              getConversationState: () => store.getConversationStateStructure(),
              getBlobStore: () => blobStore,
            });
            const shellHost: ShellTerminalWatchHost<Context> = {
              ctx: productionContext,
              ...generated,
              getConversationId: () => session.id,
              ensureBoxReady: async (pollContext, agentId) => {
                const connection = await remoteBox.ensureReady(pollContext, agentId);
                return {
                  terminalsFolder: method(remoteBox, "getTerminalsFolder")?.() ?? "",
                  remoteAccessor: createShellWatchReadAccessor(connection.remoteAccessor),
                };
              },
              getConfirmedUserTurnWatermarkCache: () => shellWatchWatermark,
              setConfirmedUserTurnWatermarkCache: cache => {
                shellWatchWatermark = cache;
              },
            };
            return shellHost;
          },
        });
      })();
      if (built !== undefined) promptGluesByIdentity.set(key, built);
      return built;
    };
    const productionPromptGlue = makePromptGlue(CHIEF_IDENTITY);
    /**
     * Both providers were already written here, and the system-prompt assembly -- their ONLY
     * consumer -- was handed `() => []` instead. Every agent's prompt therefore stated the user had
     * no other agents and no groups, which silently disabled multi-agent addressing and group work
     * across the whole product. Hoisted so the assembly and the runner options share one
     * implementation rather than one real and one empty.
     */
    const agentDirectoryProvider = () => {
      const roster = method(transcript, "listAgentsSync")?.() ?? [];
      return roster
        .filter((agent: any) =>
          agent.id !== session.id &&
          !agent.isGroup &&
          agent.remoteRoom == null
        )
        .map((agent: any) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description
        }));
    };
    const agentGroupsProvider = () => {
      const roster = method(transcript, "listAgentsSync")?.() ?? [];
      const byId = new Map(roster.map((agent: any) => [agent.id, agent]));
      return roster
        .filter((agent: any) =>
          agent.isGroup && agent.memberIds.includes(session.id)
        )
        .map((group: any) => ({
          id: group.id,
          name: group.name,
          members: group.memberIds
            .filter((memberId: string) => memberId !== session.id)
            .map((memberId: string) => byId.get(memberId))
            .filter((member: any) => member != null)
            .map((member: any) => ({
              id: member.id,
              name: member.name,
              description: member.description
            }))
        }));
    };
    /**
     * COMPACT-1. Both call sites pinned this to 0, so every epoch comparison was
     * `0 === 0`: the frozen memory prompt and the agent-profile snapshot were reused for the
     * life of the conversation, including across a compaction that had just thrown their
     * context away. `summaryArchives.length` is the count turn-settle prints when it logs
     * "conversation compacted", so it is the epoch; it is read defensively (the state owner is
     * not bound before the first turn) and kept monotonic per session.
     */
    let observedCompactionEpoch = 0;
    let conversationStateForEpoch: (() => unknown) | undefined;
    /**
     * Refreshed at most once per run generation. The only way to read the archive count is
     * `getAgentConversationStateStructure`, which round-trips the WHOLE conversation through
     * protobuf on every call -- and this getter is now on the prompt-assembly path, which
     * renders more than once a turn, on an agent whose history is hundreds of thousands of
     * tokens. Once per run is enough: turn-settle is what appends a summary archive, so a
     * compaction is visible to the next turn's prompt either way.
     */
    let epochReadForGeneration = -1;
    const readCompactionEpoch = (): number => {
      const generation = (builtRunner as { currentRunGeneration?: number } | undefined)
        ?.currentRunGeneration ?? 0;
      if (generation === epochReadForGeneration) return observedCompactionEpoch;
      try {
        const state = conversationStateForEpoch?.() as
          | { readonly summaryArchives?: readonly unknown[] }
          | undefined;
        const count = state?.summaryArchives?.length;
        if (typeof count === "number" && count > observedCompactionEpoch) {
          observedCompactionEpoch = count;
        }
        epochReadForGeneration = generation;
      } catch { /* conversation state is not bound yet; keep the last epoch seen, retry next call */ }
      return observedCompactionEpoch;
    };
    /**
     * One assembly per runner identity. It used to be built once per session with
     * `isSubagentRunner: false` and `isBoxScopedSubagent: () => false`, and every run shell --
     * parent and subagent alike -- generated its prompt from that single object. So a
     * computerUse or browserUse subagent holding exactly three tools was still handed the
     * chief's prompt: CopyToBox / CopyFromBox, cloud agents, connectors, routines, the user's
     * memory, and the time-zone section `getTimeZoneSection` exists to suppress for a
     * box-scoped runner -- the same "the prompt promises tools that do not exist" failure this
     * wave fixes on the toolset side. The assembly is a closure over deps with no state of its
     * own, so one per identity is cheap; they are memoized so a run shell does not rebuild it
     * per turn.
     */
    const promptAssembliesByIdentity = new Map<
      string,
      ReturnType<typeof createSystemPromptAssembly>
    >();
    const createProductionSystemPromptAssembly = (identity: PromptIdentity) => {
      if (productionContext === undefined || productionRequestContext === undefined) {
        return undefined;
      }
      const key = promptIdentityKey(identity);
      const existing = promptAssembliesByIdentity.get(key);
      if (existing !== undefined) return existing;
      const identityGlue = makePromptGlue(identity);
      const built = createSystemPromptAssembly({
          basePrompt: typeof overrides.systemPrompt === "string"
            ? overrides.systemPrompt
            : DEFAULT_SAND_SYSTEM_PROMPT,
          isSubagentRunner: identity.isSubagentRunner,
          isSharedRoomRunner: isSharedRoomTurn,
          isSystemPromptOverridden: typeof overrides.systemPrompt === "string",
          agentProfileProvider: () => hooks.agentProfileProvider?.() ?? null,
          agentStore: () => {
            const store = session.agentStore;
            return store != null && typeof store.getMetadata === "function"
              ? { getMetadata: (key: string) => String(store.getMetadata(key)) }
              : null;
          },
          compactionEpoch: readCompactionEpoch,
          memoryStore: () =>
            asStoreWithMethods<PromptMemoryStore>(session.memory, ["recall", "getLocation"]),
          memorySnapshots: () =>
            asStoreWithMethods<PromptMemorySnapshots>(session.db, [
              "getMemoryPromptSnapshot",
              "setMemoryPromptSnapshot",
            ]),
          // SP-1 restores memory, routines, skills and channels -- NOT these two. `memory`
          // exposes MemoryService plus createAgentState (extensions/memory/extension.ts); there
          // is no createUserMemory / createProjectMemory anywhere in source, so the owners the
          // gateway runner is handed below are `undefined` and always have been. The two
          // classes that would serve them (UserMemoryStore / ProjectMemoryStore) are never
          // constructed and their `recall` signatures do not match what the assembly calls --
          // it passes {profileLimit, recentLimit} and reads `.injected`, they take
          // {profile, recent} and return a flat array -- so wiring them as-is would throw
          // inside prompt assembly. Left null deliberately: absent section, not a broken turn.
          userMemory: () => null,
          projectMemory: () => null,
          isBoxScopedSubagent: () => identity.isBoxScopedSubagent,
          requestContext: {
            resolve: () => {
              const resolved = productionRequestContext.resolve();
              return {
                timeZone: resolved.timeZone ?? "UTC",
                ...(typeof resolved.userFullName === "string"
                  ? { userFullName: resolved.userFullName }
                  : {}),
              };
            },
          },
          automationStore: () =>
            asStoreWithMethods<PromptAutomationStore>(session.automations, ["getLocation", "list"]),
          workflowStore: () =>
            asStoreWithMethods<PromptWorkflowStore>(session.workflows, ["getLocation"]),
          channelStore: () =>
            asStoreWithMethods<PromptChannelStore>(session.channels, [
              "getLocation",
              "listConnections",
            ]),
          connectorManifests: CONNECTOR_MANIFESTS,
          sendToAgentImpl: sendToAgent,
          agentManagement,
          agentDirectory: agentDirectoryProvider,
          agentGroups: agentGroupsProvider,
          agentsRootDir: () => dirname(dirname(session.dbPath)),
          isSpotlightEnabled: () => method(experiments, "isSpotlightEnabled")?.() ?? false,
          isMultitaskEnabled: () => method(experiments, "isMultitaskEnabled")?.() ?? false,
          mcpManagement: () => mcp.management,
          isMcpMultiAccountEnabled: () => method(experiments, "isMcpMultiAccountEnabled")?.() ?? false,
          // TOOLS-09: `experiments` exposes no isCloudAgentsDisabledByTeam, so this always
          // resolved false through the optional call. The cloud-agents service owns the answer.
          isCloudAgentsDisabledByTeam: () => method(cloudAgents, "isDisabledByTeamAdmin")?.() ?? false,
          isLocalMachineConnected: () => localMachineConnected(),
          mcpCustomInstructionsSection: () => identityGlue?.getMcpCustomInstructionsSection() ?? null,
          mcpDiscoveryStatusSection: () => identityGlue?.getMcpDiscoveryStatusSection() ?? null,
          remoteBoxSection: () => identityGlue?.getRemoteBoxSection() ?? "",
          computerSection: () => identityGlue?.getComputerSection() ?? null,
        });
      promptAssembliesByIdentity.set(key, built);
      return built;
    };
    const productionSystemPromptAssembly = createProductionSystemPromptAssembly(CHIEF_IDENTITY);

    const runnerOptions: Record<string, unknown> = {
      inference: extensions.api("inference").port,
      diskPressureReminder: foreverBox.diskPressureReminder,
      box: localExec.box,
      ctx,
      ...(awaitCloudAgent === undefined
        ? {}
        : {
            cloudAgentWatcher: {
              awaitCompletion: (
                id: string,
                options: { readonly waitForRestart: boolean },
              ) => awaitCloudAgent(id, options),
            },
          }),
      remoteBox,
      userComputers: localExec.userComputers,
      remoteBoxHasDesktop: true,
      boxHandoff: {
        requestHelp: (request: unknown) =>
          method(extensions.api("session"), "startHandoff")?.(request)
      },
      transport: hooks.transport,
      onRunLifecycle: noteRunLifecycle,
      isSharedRoomTurn,
      isSharedRoomBoxToolsEnabled: sharedRoomBoxToolsEnabled,
      getAgentId: () => session.id,
      agentProfileProvider: hooks.agentProfileProvider,
      connectorManifests: CONNECTOR_MANIFESTS,
      ingestAttachment: hooks.ingestAttachment,
      persistImage: hooks.persistImage,
      persistMediaBytes: hooks.persistMediaBytes,
      readVideoAttachmentBytes: method(attachments, "readVideoBytes"),
      readMediaDimensions: method(attachments, "readMediaDimensions"),
      requestContext,
      localToolPermission,
      ...autoReview,
      actionAuditor,
      webSearchService: method(
        extensions.api("inference"),
        "createWebSearch"
      )?.({
        modelId: process.env.SAND_AGENT_MODEL ?? DEFAULT_SAND_MODEL,
        onRequestId: requestIdForwarder(hooks, "web-search")
      }),
      webFetchService: method(
        extensions.api("inference"),
        "createWebFetch"
      )?.({
        onRequestId: requestIdForwarder(hooks, "web-fetch")
      }),
      onComputerAction: ({ agentId, action }: any) => {
        deps.emitGatewayEvent({
          channel: "computer-action",
          payload: { agentId, ...action }
        });
      },
      systemPrompt: overrides.systemPrompt,
      isMultitaskEnabled: () =>
        method(experiments, "isMultitaskEnabled")?.() ?? false,
      isSendMessageDeliveryOwedEnabled: () =>
        method(experiments, "isSendMessageDeliveryOwedEnabled")?.() ?? false,
      isDynamicToolsEnabled: () =>
        method(experiments, "isDynamicToolsEnabled")?.() ?? false,
      isBrowserUseSubagentEnabled: () =>
        method(experiments, "isBrowserUseSubagentEnabled")?.() ?? false,
      isSpotlightEnabled: () =>
        method(experiments, "isSpotlightEnabled")?.() ?? false,
      isMcpMultiAccountEnabled: () =>
        method(experiments, "isMcpMultiAccountEnabled")?.() ?? false,
      isUnicodeTypingEnabled: () =>
        method(experiments, "isUnicodeTypingEnabled")?.() ?? false,
      isListenerPlatformConnected: (platform: string) =>
        method(
          extensions.api("automations"),
          "isListenerPlatformConnected"
        )?.(platform) ?? false,
      resolveCloudAgentTitle,
      sendToAgent,
      agentDirectory: agentDirectoryProvider,
      agentGroups: agentGroupsProvider,
      agentManagement,
      agentsRootDir: () => dirname(dirname(session.dbPath))
    };

    runnerOptions.createPromptSession = (
      onRequestId: (requestId: string) => void,
      options?: Readonly<Record<string, unknown>>,
    ) => createAgentPromptSession(
      extensions.api("inference").port,
      onRequestId,
      options,
    );

    const baseProductionResourceAccessor = createPerTurnResourceAccessor(
      remoteBox as unknown as ProductionBoxResourceOwner,
      session.id,
    );
    const productionResourceAccessor = async (
      context: unknown,
    ): Promise<ProductionResourceAccessor> => {
      const owner = asRemoteBoxResourceOwner(remoteBox);
      const runner = builtRunner as {
        readonly computerUse?: RemoteBoxResourceHost["computerUse"];
        setRemoteBoxTerminalsFolder?(folder: string): void;
        probeNavigationAfterComputerUse?(
          context: Context,
          connection: { readonly remoteAccessor: unknown },
        ): void;
        auditShellCommand?(
          shellKind: string,
          command: string,
          target: "box" | "user_machine",
          attribution?: { readonly turnId?: string; readonly boxId?: string },
        ): void;
      } | undefined;
      if (
        owner === undefined
        || autoReviewGate === undefined
        || runner?.computerUse === undefined
        || typeof runner.setRemoteBoxTerminalsFolder !== "function"
        || typeof runner.probeNavigationAfterComputerUse !== "function"
        || typeof runner.auditShellCommand !== "function"
        || !isAgentContext(context)
) {
        return await baseProductionResourceAccessor(context);
      }
      const remoteAutoReviewGate = {
        assertNoPendingApproval: () => autoReviewGate.assertNoPendingApproval(),
        currentModes: () => ({ ...autoReviewGate.currentModes() }),
      };
      const accessor = createRemoteBoxResourceAccessor({
        remoteBox: owner,
        remoteBoxHasDesktop: true,
        resolveBoxId: () => session.id,
        getConversationId: () => session.id,
        setRemoteBoxTerminalsFolder: folder => runner.setRemoteBoxTerminalsFolder?.(folder),
        autoReviewGate: remoteAutoReviewGate,
        auditShellCommand: (_agentId, kind, command, _target, attribution) =>
          runner.auditShellCommand?.(kind, command, "box", attribution),
        computerUse: runner.computerUse,
        probeNavigationAfterComputerUse: (probeContext, connection) =>
          runner.probeNavigationAfterComputerUse?.(probeContext, connection),
        ...(autoReview.autoReviewClassifierExecutor === undefined
          ? {}
          : { autoReviewClassifierExecutor: autoReview.autoReviewClassifierExecutor }),
      });
      return asProductionResourceAccessor(accessor);
    };
    const localProductionResourceAccessor = createPerTurnResourceAccessor(
      localExec.box as ProductionBoxResourceOwner,
      session.id,
    );
    runnerOptions.createResourceAccessor = productionResourceAccessor;
    runnerOptions.createSummarizationHandler = (
      summarizationSession: SummarizationPromptSession,
      options?: { preserveLatestImage?: boolean },
    ) => new SummarizationHandler(summarizationSession, false, {
      enableReduceInputsRetry: true,
      maxPromptChars: SAND_SUMMARIZATION_MAX_PROMPT_CHARS,
      maxOutputTokens: 32_000,
      preserveLatestImage: options?.preserveLatestImage ?? false,
    });
    runnerOptions.createConversationActionReceiver = () =>
      new NoopConversationActionReceiver();
    // Dormant direct owner for the immutable retry/checkpoint boundary. The
    // current clean runner does not consume this until the real Agent stream
    // join is released; keeping the factory here makes the owner reachable
    // without invoking runStream or replacing the fail-closed runStep port.
    runnerOptions.createStreamAttempt = createStreamAttempt;
    // This is the exact generated redaction/RESUME projection used by the
    // immutable stream handoff. It remains a dormant typed option: the clean
    // runner does not call it until the real Agent stream join is promoted.
    runnerOptions.createTurnAgentRunStreamInput = createTurnAgentRunStreamInput;
    // Direct constructor-side stream owner. This remains dormant until a
    // dependency-closed built Agent is supplied by the real turn join.
    runnerOptions.createTurnAgentStreamStart = createTurnAgentStreamStart;

    // Host-owned production caller for the recovered constructor. The caller
    // supplies the typed per-turn prompt/action and summarization identities;
    // resource readiness and blob ownership remain fixed to this session.
    runnerOptions.createProductionTurnAgentOwner = (
      input: Omit<
        ProductionTurnAgentOwnerInput,
        "createResourceAccessor" | "blobStore"
      >,
    ) => {
      if (
        session.agentStore == null
        || typeof session.agentStore.getBlobStore !== "function"
      ) {
        throw new TypeError("production Agent blob store is not bound");
      }
      return createProductionTurnAgentOwner({
        ...input,
        createResourceAccessor: localProductionResourceAccessor,
        createRemoteBoxResourceAccessor: productionResourceAccessor,
        blobStore: getAgentBlobStore(
          session.agentStore as Parameters<typeof getAgentBlobStore>[0],
        ),
      });
    };
    runnerOptions.createProductionTurnAgentRunInput =
      createProductionTurnAgentRunInput;

    if (session.agentStore != null && typeof session.agentStore.getBlobStore === "function") {
      runnerOptions.blobStore = getAgentBlobStore(
        session.agentStore as unknown as Parameters<typeof getAgentBlobStore>[0],
      );
    }

    if (!isSharedRoomTurn) {
      transcriptMirrorForTurn = deps.createTranscriptMirror?.({
        transcriptsDir,
        session,
        pool: getMirrorOffloadPool,
        reportOutcome: report => {
          method(telemetry.brain ?? {}, "reportJournalOutcome")?.(report);
        },
        isJournalEnabled: async () =>
          await method(experiments, "checkGate")?.(
            "sand_new_transcript_journal"
          ) ?? false
      }) as TurnSettleHost["transcriptMirror"] | undefined;
      Object.assign(runnerOptions, {
        transcriptMirror: transcriptMirrorForTurn,
        mcp: mcp.mcp,
        mcpManagement: mcp.management,
        agentState: agentStateOwner,
        generateImageService: method(
          attachments,
          "createGenerateImageService"
        )?.({
          persistImage: hooks.persistImage,
          onRequestId: requestIdForwarder(hooks, "generate-image")
        }),
        generateImageResourceAccessor: method(
          attachments,
          "createGenerateImageResourceAccessor"
        )?.(dirname(session.dbPath)),
        getAgentDir: () => dirname(session.dbPath),
        uploadAttachmentsIntoBox: (hostPaths: readonly string[]) =>
          method(attachments, "stageIntoBox")?.(session.id, hostPaths),
        agentStore: session.agentStore,
        conversationSizeGuard: () =>
          sessionApi.store?.ensureConversationCapacityForTurn?.(session),
        memoryStore: session.memory,
        userMemory: method(memory, "createUserMemory")?.({
          agentId: session.id,
          resolveAgentName: resolveAgentDisplayName,
        }),
        projectMemory: method(memory, "createProjectMemory")?.({
          agentDir: dirname(session.dbPath),
          agentId: session.id,
          resolveAgentName: resolveAgentDisplayName,
        }),
        memorySnapshots: session.db,
        profilePromptSnapshots: session.db,
        episodeProgress: session.db,
        automationStore: session.automations,
        workflowStore: session.workflows,
        channelStore: session.channels
      });
    }

    const projectedLocalToolPermission = asLocalToolPermissionProjection(
      localToolPermission,
    );

    const hostDependencies = (): ProductionTurnHostDependencies => {
      const readMediaDimensions = method(attachments, "readMediaDimensions");
      const uploadFile = method(remoteBox, "uploadFile");
      const downloadFile = method(remoteBox, "downloadFile");
      const watchCloudAgent = createRunnerCloudWatch(builtRunner);
      const cloudAgent = (() => {
        const launchedIds = cloudAgents.launchedIds;
        if (
          !isCloudAgentApi(cloudAgents)
          || !(launchedIds instanceof Set)
          || uploadFile === undefined
        ) return undefined;
        const reviewAction: NonNullable<CloudAgentToolDeps["reviewAction"]> | undefined =
          productionContext === undefined || autoReviewGate === undefined
            ? undefined
            : async ({ args, toolCallId, images, signal }) => {
              const instructions = autoReviewGate.userInstructions();
              const reviewOptions = {
                mode: autoReviewGate.currentModes().cloudAgent,
                agentId: session.id,
                ...(autoReviewController === undefined
                  ? {}
                  : { autoReviewController }),
                ...(instructions === undefined
                  ? {}
                  : { userAutoRunInstructions: instructions }),
                getApprovalExpiryPolicy: () =>
                  sandAutoReviewApprovalExpiryPolicy("turn"),
              };
              const lifecycleTarget = buildSandCloudAgentLifecycleReviewTarget({
                action: args.action,
                ...(args.agent_id === undefined ? {} : { agent_id: args.agent_id }),
                ...(args.title === undefined ? {} : { title: args.title }),
              });
              if (lifecycleTarget !== undefined) {
                const result = await reviewSandCloudAgentLifecycleAction({
                  ctx: productionContext,
                  target: lifecycleTarget,
                  options: reviewOptions,
                  ...(signal === undefined ? {} : { signal }),
                });
                return { allowed: result.allowed, reason: result.reason ?? "" };
              }
              const target = buildSandCloudAgentReviewTarget(
                args,
                describeSandCloudAgentReviewImages(
                  images.map(image => image.path),
                  images,
                ),
              );
              if (target === undefined) return { allowed: true, reason: "" };
              const result = await reviewSandCloudAgentAction({
                ctx: productionContext,
                target,
                toolCallId,
                ...(signal === undefined ? {} : { signal }),
                options: {
                  ...reviewOptions,
                  classify: async (classifyContext, classifyTarget, mode, id) =>
                    await runSandAutoReviewClassifier({
                      ctx: classifyContext,
                      resourceAccessor: await productionResourceAccessor(classifyContext),
                      toolCallId: id,
                      mode,
                      buildTarget: () => buildSandCloudAgentRiskTarget({
                        target: classifyTarget,
                        ...(instructions === undefined
                          ? {}
                          : { userAutoRunInstructions: instructions }),
                      }),
                      loadConversationContext: async () =>
                        await extractProductionTurnAutoReviewConversationContext(
                          classifyContext,
                          agentStateOwner,
                        ),
                      errorReason: SAND_CLOUD_AGENT_CLASSIFIER_ERROR_REASON,
                    }),
                },
              });
              return { allowed: result.allowed, reason: result.reason ?? "" };
            };
        return {
          api: cloudAgents,
          launchedIds,
          agentDir: dirname(session.dbPath),
          ...(downloadFile === undefined
            ? {}
            : {
                readBoxFile: async (
                  cloudContext: CloudAgentToolContext,
                  boxPath: string,
                ) => await downloadFile(cloudContext, session.id, boxPath),
              }),
          writeBoxFile: async (
            cloudContext: CloudAgentToolContext,
            boxPath: string,
            data: Uint8Array,
          ) => await uploadFile(cloudContext, session.id, boxPath, data),
          ...(awaitCloudAgent === undefined
            ? {}
            : {
                cloudAgentWatcher: () => ({
                  awaitCompletion: (id: string, options: { waitForRestart: boolean }) =>
                    awaitCloudAgent(id, options),
                }),
              }
          ),
          ...(watchCloudAgent === undefined ? {} : { watch: watchCloudAgent }),
          ...(reviewAction === undefined ? {} : { reviewAction }),
        };
      })();

      const sendMessage = {
        getIngestAttachment: () => hooks.ingestAttachment,
        resolveCloudAgentTitle,
        ...(readMediaDimensions === undefined
          ? {}
          : { readMediaDimensions }),
        onSendMessage: (message: Record<string, unknown>, timestampMs: number) => {
          hooks.transport.onUpdate({
            type: "send-message",
            message: { ...message, type: String(message.type ?? "text") },
            timestampMs,
          });
          return hooks.transport.lastSentMessageId?.();
        },
      };
      const reaction = {
        react: (args: { messageAddress: string; emoji: string }) => {
          hooks.transport.onUpdate({ type: "react-to-message", ...args });
        },
      };
      const listenerPlatformConnected = method(
        extensions.api("automations"),
        "isListenerPlatformConnected",
      );
      const reviewAutomationWrite: NonNullable<
        ProductionTurnHostDependencies["state"]
      >["reviewAutomationWrite"] =
        productionContext === undefined || autoReviewGate === undefined
          ? undefined
          : async (review: AutomationReview, toolCallId?: string) => {
            if (toolCallId === undefined || toolCallId.length === 0) {
              return {
                allowed: false,
                reason: "Auto-review requires a tool call identity.",
              };
            }
            const trigger = parseStoredTrigger(review.spec.trigger);
            if (trigger === null) {
              return {
                allowed: false,
                reason: "This routine trigger could not be reviewed.",
              };
            }
            const target = {
              operation: review.operation,
              id: review.id ?? review.referencedWorkflows[0]?.id ?? "",
              spec: {
                name: review.spec.name,
                prompt: review.spec.prompt,
                trigger,
                isEnabled: review.spec.isEnabled ?? true,
              },
              referencedWorkflows: review.referencedWorkflows,
              ...(review.referencingRoutines === undefined
                ? {}
                : { referencingRoutines: review.referencingRoutines }),
            };
            const instructions = autoReviewGate.userInstructions();
            const result = await reviewSandAutomationWrite({
              ctx: productionContext,
              target,
              toolCallId,
              options: {
                mode: autoReviewGate.currentModes().automationWrite,
                agentId: session.id,
                ...(autoReviewController === undefined
                  ? {}
                  : { autoReviewController }),
                ...(instructions === undefined
                  ? {}
                  : { userAutoRunInstructions: instructions }),
                getApprovalExpiryPolicy: () =>
                  sandAutoReviewApprovalExpiryPolicy("turn"),
                classify: async (classifyContext, classifyTarget, mode, id) =>
                  await runSandAutoReviewClassifier({
                    ctx: classifyContext,
                    resourceAccessor: await productionResourceAccessor(classifyContext),
                    toolCallId: id,
                    mode,
                    buildTarget: () => buildSandAutomationWriteRiskTarget({
                      target: classifyTarget,
                      ...(instructions === undefined
                        ? {}
                        : { userAutoRunInstructions: instructions }),
                    }),
                    loadConversationContext: async () =>
                      await extractProductionTurnAutoReviewConversationContext(
                        classifyContext,
                        agentStateOwner,
                      ),
                    errorReason: SAND_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON,
                  }),
              },
            });
            return { allowed: result.allowed, reason: result.reason ?? "" };
          };
      const onListenerRoutineSaved: NonNullable<
        ProductionTurnHostDependencies["state"]
      >["onListenerRoutineSaved"] =
        listenerPlatformConnected === undefined
          ? undefined
          : async triggerValue => {
            const trigger = parseStoredTrigger(triggerValue);
            if (trigger === null) return undefined;
            return (await surfaceListenerConnectCards({
              trigger,
              platformsInTrigger: value => {
                const parsed = parseStoredTrigger(value);
                return parsed === null ? [] : listenerPlatformsInTrigger(parsed);
              },
              isListenerPlatformConnected: async platform =>
                Boolean(await listenerPlatformConnected(platform)),
              emit: card => {
                hooks.transport.onUpdate({
                  type: "send-message",
                  message: card,
                  timestampMs: Date.now(),
                });
              },
              displayName: platform => platform === "slack" ? "Slack" : "GitHub",
            })) ?? undefined;
          };
      const state = agentStateOwner === undefined
        ? undefined
        : {
            state: agentStateOwner,
            ...(session.automations != null
              && typeof (session.automations as { list?: unknown }).list === "function"
              ? {
                  automationStore: session.automations as {
                    list(): readonly AutomationRecord[];
                  },
                }
              : {}),
            ...(session.workflows != null
              && typeof (session.workflows as { list?: unknown }).list === "function"
              ? {
                  workflowStore: session.workflows as {
                    list(): readonly WorkflowRecord[];
                  },
                }
              : {}),
            parseTrigger: parseStoredTrigger,
            ...(reviewAutomationWrite === undefined ? {} : { reviewAutomationWrite }),
            ...(onListenerRoutineSaved === undefined ? {} : { onListenerRoutineSaved }),
          };

      const subagentManagement = createRunnerSubagentManagement(builtRunner);
      const projectedActionAuditor = asActionAuditor(actionAuditor);
      const autoReviewProjection: ProductionTurnAutoReviewHostProjection | undefined =
        autoReviewController === undefined || autoReviewGate === undefined
          ? undefined
          : {
              controller: autoReviewController,
              agentId: session.id,
              getModes: () => autoReviewGate.currentModes(),
              getInstructions: () => autoReviewGate.userInstructions(),
              getApprovalExpiryPolicy: () =>
                sandAutoReviewApprovalExpiryPolicy("turn"),
              requestContext: new RequestContext({
                env: new RequestContextEnv({
                  smartModeClassifierAutoModeEnabled: true,
                }),
              }),
              getShellApprovalState: surface =>
                autoReviewGate.shellApprovalState(surface),
              enforceModelFacingShellUiAutomationGuard:
                autoReviewGate.currentModes().hostShell === "enforce"
                || autoReviewGate.currentModes().computer === "enforce",
              ...(projectedActionAuditor === undefined
                ? {}
                : { actionAuditor: projectedActionAuditor }),
              ...(projectedLocalToolPermission === undefined
                ? {}
                : { localToolPermission: projectedLocalToolPermission }),
              ...(listenerPlatformConnected === undefined
                ? {}
                : {
                    isListenerPlatformConnected: async (platform: string) =>
                      Boolean(await listenerPlatformConnected(platform)),
                  }),
            };
      return {
        isMultitaskEnabled: () =>
          method(experiments, "isMultitaskEnabled")?.() ?? false,
        sendMessage,
        sendToAgent: {
          getSelfAgentId: () => session.id,
          sendToAgent: (
            targetId: string,
            text: string,
            images,
            priority,
          ) => sendToAgent(targetId, text, images, priority === true),
        },
        reaction,
        agentManagement,
        ...(state === undefined ? {} : { state }),
        ...(!isSharedRoomTurn && mcp.management != null
          && typeof mcp.management.listPlugins === "function"
          ? { mcpManagement: mcp.management }
          : {}),
        ...(cloudAgent === undefined ? {} : { cloudAgent }),
        ...(subagentManagement === undefined
          ? {}
          : { subagentManagement }),
        ...(autoReviewProjection === undefined
          ? {}
          : { autoReview: autoReviewProjection }),
      };
    };

    const createTurnToolsetFactoryProvider = (
      dependencies: ProductionTurnHostDependencies,
      turnInputs?: ProductionTurnToolInputs,
    ): TurnToolsetHostFactoryProvider => {
      const cloudAgent = dependencies.cloudAgent;
      const mcpManagement = dependencies.mcpManagement;
      const subagentManagement = dependencies.subagentManagement;
      const startHandoff = method(extensions.api("session"), "startHandoff");
      const provider: TurnToolsetHostFactoryProvider = {
      createSendMessageToolInputs: turn => {
        // LOOP-2: the send cap and the duplicate suppressor count per turn, and these inputs are
        // rebuilt every step, so the counting state has to come off the turn rather than the tool.
        const budget = turn.sendBudget === undefined
          ? {}
          : { turnSendBudget: turn.sendBudget };
        return {
          dependencies: turn.emitUpdate === undefined
            ? { ...dependencies.sendMessage, ...budget }
            : {
                ...dependencies.sendMessage,
                ...budget,
                onSendMessage: (message, timestampMs) => {
                  turn.emitUpdate?.({
                    type: "send-message",
                    message: { ...message, type: String(message.type ?? "text") },
                    timestampMs,
                    ...(turn.ackToken === undefined
                      ? {}
                      : { ackToken: turn.ackToken }),
                  });
                  return hooks.transport.lastSentMessageId?.();
                },
              },
        };
      },
      createSendToAgentToolInputs: () => ({
        dependencies: dependencies.sendToAgent,
      }),
      /**
       * Computer and Screenshot were the only host tools with no entry here, so every turn fell
       * through to `props.createComputerToolDependencies` -- which the Agent engine never sets. The
       * props a turn actually receives carry `resourceAccessor` and nothing else the projections
       * would have added, so `factories` came back without them and no turn was ever offered a way
       * to see or touch the desktop. A computerUse subagent was asked to drive a machine with no
       * hands: it answered in prose, reported done, and its parent dispatched it again.
       *
       * The accessor is all `createHostComputerToolDependencies` needs, and it is right there on
       * the props, so the dependencies are built per turn from it -- the same builder and the same
       * auto-review wiring the unreachable projection used.
       */
      createComputerToolInputs: (turn, _props) => {
        /**
         * `props.resourceAccessor` is the accessor for the USER'S OWN MACHINE -- the local exec
         * bridge, which has no computer-use handler at all. Driving the desktop needs the box, and
         * every other box-scoped tool here (BoxAwait, BoxRead) already reads
         * `turn.remoteBoxResourceAccessor`. Pointing the computer tools at the local bridge is why
         * they still could not touch the screen after being given a working engine adapter.
         */
        const accessor = turn.remoteBoxResourceAccessor;
        if (accessor === undefined) {
          throw new TypeError("remote box resource accessor is not bound");
        }
        const modes = autoReviewGate?.currentModes();
        const autoRunInstructions = autoReviewGate?.userInstructions();
        return {
          dependencies: createHostComputerToolDependencies({
            resourceAccessor: accessor as never,
            ...(modes === undefined ? {} : {
              autoReview: {
                mode: modes.computer,
                agentId: session.id,
                boxIdentity: {
                  boxId: session.id,
                  windowGeneration: `${autoReviewController?.hostGeneration ?? "host"}:${session.id}`,
                },
                ...(autoReviewController === undefined ? {} : { autoReviewController }),
                extractConversationContext:
                  extractProductionTurnAutoReviewConversationContext,
                getApprovalExpiryPolicy: () => sandAutoReviewApprovalExpiryPolicy("turn"),
                // Which screen this agent owns. Without it a click lands on the shared seat.
                resolveDisplayNumber: async (context: unknown) => {
                  await method(remoteBox, "ensureReady")?.(context, session.id);
                  const windowIndex = boxAgentWindowIndex(remoteBox as never, session.id);
                  return windowIndex ?? (boxSupportsMultiWindow(remoteBox as never) ? undefined : 1);
                },
                // userInstructions() is itself optional, so gating on the gate rather than the
                // value put an explicit `undefined` on an exactOptionalPropertyTypes property.
                ...(autoRunInstructions === undefined
                  ? {}
                  : { userAutoRunInstructions: autoRunInstructions }),
              },
            }),
            ...(persistImageForTurn === undefined ? {} : { persistImage: persistImageForTurn }),
            isUnicodeTypingEnabled: () =>
              method(experiments, "isUnicodeTypingEnabled")?.() ?? false,
            onComputerAction: action => {
              deps.emitGatewayEvent({
                channel: "computer-action",
                payload: { agentId: session.id, ...action },
              });
            },
          }),
        };
      },
      /**
       * SUB-1 / TOOLS-03, second half. Offering the browserUse subagent in Task's enum is not
       * enough: `turn-toolset` pushes the fifteen browser_* tools only when `factories.browser`
       * exists, and like Computer before it that factory had no entry here -- so the first live
       * browserUse dispatch came back "browserUse isn't available in its session" with a
       * two-tool set (Shell, Read). Same correction as the computer tool: the browser is the
       * box's, so it is built on the box accessor, not the user's machine.
       */
      createBrowserToolInputs: (turn, _props) => {
        const accessor = turn.remoteBoxResourceAccessor;
        if (accessor === undefined) {
          throw new TypeError("remote box resource accessor is not bound");
        }
        const modes = autoReviewGate?.currentModes();
        const autoRunInstructions = autoReviewGate?.userInstructions();
        return {
          dependencies: withCloudBrowser(createHostBrowserDriverDependencies({
            resourceAccessor: accessor as never,
            box: remoteBox as unknown as HostBrowserBoxOwner<unknown>,
            getBoxId: () => session.id,
            getDefaultViewId: () => session.id,
            executeShell: createHostShellExecutor({
              resourceAccessor: accessor as never,
              assertNoPendingApproval: () =>
                autoReviewGate?.assertNoPendingApproval(),
              auditShellCommand: command => {
                evidenceRegistry.noteReceipt(session.id, "shell");
                method(actionAuditor as DynamicApi, "record")?.({
                  agentId: session.id,
                  occurredAtMs: Date.now(),
                  ...evidenceRegistry.receiptFields(session.id),
                  action: {
                    kind: "shellCommand",
                    command,
                    shellKind: "foreground",
                    target: "box",
                  },
                });
              },
            }),
            ...(modes === undefined ? {} : {
              autoReview: {
                mode: modes.computer,
                agentId: session.id,
                boxIdentity: {
                  boxId: session.id,
                  windowGeneration: `${autoReviewController?.hostGeneration ?? "host"}:${session.id}`,
                },
                ...(autoReviewController === undefined ? {} : { autoReviewController }),
                extractConversationContext:
                  extractProductionTurnAutoReviewConversationContext,
                getApprovalExpiryPolicy: () => sandAutoReviewApprovalExpiryPolicy("turn"),
                resolveDisplayNumber: async (context: unknown) => {
                  await method(remoteBox, "ensureReady")?.(context, session.id);
                  const windowIndex = boxAgentWindowIndex(remoteBox as never, session.id);
                  return windowIndex ?? (boxSupportsMultiWindow(remoteBox as never) ? undefined : 1);
                },
                ...(autoRunInstructions === undefined
                  ? {}
                  : { userAutoRunInstructions: autoRunInstructions }),
              },
            }),
            ...(persistImageForTurn === undefined
              ? {}
              : { getPersistImage: () => persistImageForTurn }),
            /**
             * BROWSER-1. One `browser_navigation` row per page Titan opens, written straight from
             * the tool call. The polling probe that produces these rows for a subagent only runs
             * while a box-scoped subagent holds the screen, so without this a main-agent
             * browser_open left the ledger empty and the page visit had no receipt at all.
             */
            recordNavigation: ({ url, title }) => {
              evidenceRegistry.noteReceipt(session.id, "browser");
              method(actionAuditor as DynamicApi, "record")?.({
                agentId: session.id,
                occurredAtMs: Date.now(),
                ...evidenceRegistry.receiptFields(session.id),
                action: { kind: "browserNavigation", url, pageTitle: title },
              });
            },
          })) as unknown as TurnBrowserToolFactoryInput["dependencies"],
        };
      },
      createScreenshotToolInputs: (turn, _props) => {
        // Same correction as the computer tool: the screen lives on the box, not on the user's Mac.
        const accessor = turn.remoteBoxResourceAccessor;
        if (accessor === undefined) {
          throw new TypeError("remote box resource accessor is not bound");
        }
        // Screenshot deliberately carries no auto-review: looking at the screen changes nothing.
        return {
          dependencies: createHostComputerToolDependencies({
            resourceAccessor: accessor as never,
            ...(persistImageForTurn === undefined ? {} : { persistImage: persistImageForTurn }),
            isUnicodeTypingEnabled: () =>
              method(experiments, "isUnicodeTypingEnabled")?.() ?? false,
          }),
        };
      },
      /**
       * CopyToBox/CopyFromBox were built by the toolset and never registered, while the system
       * prompt promised them unconditionally -- so agents narrated transfers they had no tool for.
       * The controller comes from the prompt glue rather than a second copy, so the tools address
       * the same box and the same user-computer registry the prompt describes.
       */
      ...(productionPromptGlue === undefined
        ? {}
        : {
            createFileTransferToolInputs: (): TurnFileTransferToolFactoryInput => ({
              controller: productionPromptGlue.createFileTransferController(),
            }),
          }),
      /**
       * The tool, the handoff service and the resume path all existed; nothing joined them, so an
       * agent stuck on a login or captcha had no way to hand the desktop to a human. requestHelp is
       * the same session-extension entry the runner's own boxHandoff option calls. The send-message
       * carries the handoff so turn-runtime stamps the transcript entry with its request id -- that
       * stamp is what the hand-back resolves against.
       */
      ...(startHandoff === undefined
        ? {}
        : {
            createRequestBoxHelpToolInputs: (turn): TurnBoxHelpToolFactoryInput => ({
              dependencies: {
                getAgentId: () => session.id,
                // `turn.cancelThisRun` bottoms out at a no-op stub in the production run shell,
                // so the tool would tell the user their box was handed over and the run would carry
                // straight on. Interrupt the runner directly, the way the owner-level
                // cancelThisRun does.
                endTurn: () => {
                  const runner = builtRunner as { interrupt?: (value: string) => boolean } | undefined;
                  runner?.interrupt?.("handed the box to the user");
                },
                requestHelp: async request => {
                  const outcome = await startHandoff({
                    agentId: request.agentId,
                    instruction: request.instruction,
                    telemetry: request.telemetry,
                  });
                  if (!isBoxHelpOutcome(outcome)) {
                    throw new TypeError("box handoff service is not bound");
                  }
                  return outcome;
                },
                onSendMessage: (message, timestampMs, metadata) => {
                  const update = {
                    type: "send-message",
                    message,
                    timestampMs,
                    boxHandoff: {
                      requestId: metadata.requestId,
                      instruction: metadata.instruction,
                    },
                  };
                  if (turn.emitUpdate === undefined) {
                    hooks.transport.onUpdate(update);
                    return;
                  }
                  turn.emitUpdate({
                    ...update,
                    ...(turn.ackToken === undefined
                      ? {}
                      : { ackToken: turn.ackToken }),
                  });
                },
              },
            }),
          }),
      /**
       * FEEDBACK-1. The reporting tool's only dependency is a place to put the report, and that
       * place is a file in this box, not a network call. There is no `startHandoff`-style guard
       * above it because there is nothing to guard: no credential, no tenant, no egress. The
       * console reads the file, shows it to the operator, and is the only thing that ever sends.
       */
      createProblemReportToolInputs: (): TurnProblemReportToolFactoryInput => ({
        dependencies: {
          getAgentId: () => session.id,
          getAgentName: () => {
            const profile = method(sessionApi, "getAgentProfileText")?.(session.id);
            return profile == null ? undefined : String(profile.name ?? "") || undefined;
          },
          savePending: entry => appendProblemReport(getSandRootDir(), entry),
        },
      }),
      /**
       * MAIL-3. The send tool's dependencies, and what is deliberately not among them: a Resend
       * key, a From address, and any way to name either. The box says who it is with the bearer it
       * already presents to the relay for everything else, and the relay decides what the From is
       * from its own copy of the directory. `resolveRelaySend` reads both the relay's address and
       * that bearer out of SAND_HOST_BUNDLE_S3_BASE_URL, so a box with no relay in front of it
       * resolves nothing and buildTurnTools withholds the tool rather than offering one that can
       * only fail.
       */
      createSendEmailToolInputs: (): TurnSendEmailToolFactoryInput => ({
        dependencies: {
          getAgentId: () => session.id,
          readMail: agentId => readAgentMailFor(agentId, getSandRootDir()),
          resolveRelay: () => resolveRelaySend(),
          post: (target, body, timeoutMs) => postMailSend(target, body, timeoutMs),
        },
      }),
      createReactionToolInputs: turn => ({
        dependencies: turn.emitUpdate === undefined
          ? dependencies.reaction
          : {
              ...dependencies.reaction,
              react: args => turn.emitUpdate?.({ type: "react-to-message", ...args }),
            },
      }),
      createAgentManagementToolInputs: () => ({
        dependencies: dependencies.agentManagement,
      }),
      createBoxAwaitToolInputs: (turn, _props): TurnAwaitToolFactoryInput => ({
        resourceAccessor: (() => {
          if (turn.remoteBoxResourceAccessor === undefined) {
            throw new TypeError("remote box resource accessor is not bound");
          }
          return turn.remoteBoxResourceAccessor as unknown as TurnAwaitToolFactoryInput["resourceAccessor"];
        })(),
        options: {
          toolName: SAND_BOX_AWAIT_SHELL_TOOL_NAME,
          toolIdentifier: "BOX_AWAIT",
          terminalsFolder: () => method(remoteBox, "getTerminalsFolder")?.() ?? "",
          enableSubagentAwaiting: false,
          defaultBlockUntilMs: 30_000,
          enableJobCompletionNotifications: true,
        },
      }),
      createExternalReadToolInputs: (_turn, props): TurnReadToolFactoryInput => ({
        resourceAccessor: props.resourceAccessor as unknown as TurnReadToolFactoryInput["resourceAccessor"],
        formattingOptions: SAND_READ_FORMATTING_OPTIONS,
        promptVersion: "latest",
        options: {
          toolName: SAND_EXTERNAL_READ_TOOL_NAME,
          toolIdentifier: "EXTERNAL_READ",
          toolDescription: SAND_EXTERNAL_READ_TOOL_DESCRIPTION,
          // The immutable Mac and Windows carriers contain the lazy Piscina
          // producer but omit pdf-worker.{js,ts}. Leaving the extractor absent
          // preserves ordinary Read while making the unrecoverable PDF branch
          // fail closed in createReadTool.
        },
      }),
      createBoxReadToolInputs: (turn, _props): TurnReadToolFactoryInput => {
        if (turn.remoteBoxResourceAccessor === undefined) {
          throw new TypeError("remote box resource accessor is not bound");
        }
        return {
          resourceAccessor: turn.remoteBoxResourceAccessor as unknown as TurnReadToolFactoryInput["resourceAccessor"],
          formattingOptions: SAND_READ_FORMATTING_OPTIONS,
          promptVersion: "latest",
          options: {
            toolName: SAND_BOX_READ_TOOL_NAME,
            toolIdentifier: "READ",
            toolDescription: SAND_BOX_READ_TOOL_DESCRIPTION,
          },
        };
      },
      ...(turnInputs?.webSearch === undefined
        && method(extensions.api("inference"), "createWebSearch") === undefined
        ? {}
        : {
            createWebSearchToolInputs: (_turn, props): TurnWebSearchToolFactoryInput => {
              const webSearch = props.webSearch
                ?? turnInputs?.webSearch
                ?? createTurnWebAndAwaitProjections(props).webSearch;
              if (webSearch === undefined) throw new TypeError("web search service is not bound");
              return { dependencies: webSearch as unknown as TurnWebSearchToolFactoryInput["dependencies"] };
            },
          }),
      ...(turnInputs?.webFetch === undefined
        && method(extensions.api("inference"), "createWebFetch") === undefined
        ? {}
        : {
            createWebFetchToolInputs: (_turn, props): TurnWebFetchToolFactoryInput => {
              const webFetch = props.webFetch
                ?? turnInputs?.webFetch
                ?? createTurnWebAndAwaitProjections(props).webFetch;
              if (webFetch === undefined) throw new TypeError("web fetch service is not bound");
              return { dependencies: webFetch as unknown as TurnWebFetchToolFactoryInput["dependencies"] };
            },
          }),
      ...(turnInputs?.externalAwait === undefined
        && method(remoteBox, "getTerminalsFolder") === undefined
        ? {}
        : {
            createExternalAwaitToolInputs: (_turn, props): TurnAwaitToolFactoryInput => {
              const externalAwait = props.externalAwait
                ?? turnInputs?.externalAwait
                ?? createTurnWebAndAwaitProjections(props).externalAwait;
              if (externalAwait === undefined) throw new TypeError("external await service is not bound");
              return {
                resourceAccessor: externalAwait.resourceAccessor as unknown as TurnAwaitToolFactoryInput["resourceAccessor"],
                options: externalAwait.options,
                ...(externalAwait.promptVersion === undefined
                  ? {}
                  : { promptVersion: externalAwait.promptVersion }),
              };
            },
          }),
        /**
         * The scope trap this lane exists for: `subagentManagement` is a local inside
         * hostDependencies(), NOT a binding of this literal, and an earlier attempt to read it as
         * a bare identifier here shipped and threw "subagentManagement is not defined" on every
         * turn. It reaches this scope only as a field of the `dependencies` parameter, hoisted
         * above. turn-toolset's `props.hostDependencies` fallback does not cover this: those props
         * come from createTurnToolInputs, which the production run-shell path never uses -- so
         * without this entry an agent can dispatch a subagent and then never check, steer or stop
         * it.
         */
        ...(subagentManagement === undefined
          ? {}
          : {
              createSubagentManagementToolInputs: (): TurnSubagentManagementToolFactoryInput => ({
                controller: subagentManagement,
              }),
            }),
        ...(mcpManagement === undefined
          ? {}
          : {
              createMcpManagementToolInputs: (): TurnMcpManagementToolFactoryInput => ({
          management: mcpManagement,
          getRequestingAgentId: () => session.id,
          isAwaitingUserSelection: () => {
            const owner = builtRunner as { isRunAwaitingUserSelection?: () => boolean } | undefined;
            return owner?.isRunAwaitingUserSelection?.() === true;
          },
          isMultiAccountEnabled: () =>
            method(experiments, "isMcpMultiAccountEnabled")?.() ?? false,
          emitConnectorCard: emission => {
            hooks.transport.onUpdate({
              type: "send-message",
              message: connectorCardEmissionToMessage(emission),
              timestampMs: Date.now(),
            });
          },
              }),
            }),
        ...(!isSharedRoomTurn && cloudAgent !== undefined
          ? {
              createCloudAgentToolInputs: (): TurnCloudAgentToolFactoryInput => ({
                dependencies: {
                  api: cloudAgent.api,
                  launchedIds: cloudAgent.launchedIds,
                  agentDir: cloudAgent.agentDir,
                  writeBoxFile: cloudAgent.writeBoxFile,
                  ...(cloudAgent.readBoxFile === undefined
                    ? {}
                    : { readBoxFile: cloudAgent.readBoxFile }),
                  ...(cloudAgent.watch === undefined
                    ? {}
                    : { watch: cloudAgent.watch }),
                  ...(cloudAgent.reviewAction === undefined
                    ? {}
                    : { reviewAction: cloudAgent.reviewAction }),
                },
              }),
            }
          : {}
        ),
      };
      const state = dependencies.state;
      if (state === undefined) return provider;
      return {
        ...provider,
        createStateToolInputs: () => ({
          dependencies: state,
        }),
      };
    };

    const createTurnToolInputs = (input: ProductionTurnToolInputs) => {
      const dependencies = hostDependencies();
      const projected = createProductionTurnToolInputs(
        input,
        {
          ...(createTurnToolProjections?.(input) ?? {}),
          ...createTurnWebAndAwaitProjections(input),
          ...(hooks.emitUpdate === undefined
            ? {}
            : { emitUpdate: hooks.emitUpdate }),
        },
      );
      return {
        ...projected,
        hostDependencies: dependencies,
        turnToolsetFactoryProvider: createTurnToolsetFactoryProvider(
          dependencies,
          projected,
        ),
      };
    };

    const createProductionTurnSettleHost = (): TurnSettleHost => {
      const runner = builtRunner as {
        readonly isSubagentRunner?: boolean;
        getBlobStore?: () => unknown;
        getConversationStateStructure?: () => unknown;
        getLatestPromptMessages?: () => readonly unknown[];
        currentRunGeneration?: number;
        setAgentConversationStateStructure?: (structure: TurnCheckpoint) => void;
      } | undefined;
      const store = session.agentStore;
      if (
        store == null
        || typeof store.handleCheckpoint !== "function"
        || typeof store.getMetadata !== "function"
      ) throw new TypeError("production Agent checkpoint store is not bound");
      const generation = runner?.currentRunGeneration;
      return {
        isSubagentRunner: isSharedRoomTurn,
        ...(transcriptMirrorForTurn === undefined
          ? {}
          : { transcriptMirror: transcriptMirrorForTurn }),
        getTranscriptId: () => session.id,
        getBlobStore: () => runner?.getBlobStore?.() ?? getAgentBlobStore(
          store as Parameters<typeof getAgentBlobStore>[0],
        ),
        agentStore: () => ({
          handleCheckpoint: (context: unknown, checkpoint: unknown) =>
            store.handleCheckpoint(context, checkpoint),
          getMetadata: (key: string) => store.getMetadata(key),
        }),
        setLocalState: checkpoint => {
          if (typeof runner?.setAgentConversationStateStructure !== "function") {
            throw new TypeError("production Agent local checkpoint store is not bound");
          }
          runner.setAgentConversationStateStructure(checkpoint);
        },
        ownsRunner: () => true,
        isRunSuperseded: () =>
          generation !== undefined
          && runner?.currentRunGeneration !== undefined
          && runner.currentRunGeneration !== generation,
        latestPromptMessages: () => runner?.getLatestPromptMessages?.() ?? [],
        persistAnnouncedAgentProfile: (snapshots, snapshot, identity) => {
          const profilePromptSnapshotStore = asPromptSnapshotStore(snapshots);
          productionSystemPromptAssembly?.persistAnnouncedAgentProfile(
            profilePromptSnapshotStore,
            snapshot,
            identity,
          );
        },
      };
    };

    runnerOptions.createProductionTurnToolsetHost = (
      input: Omit<ProductionTurnToolsetHostInput, "factoryProvider">,
    ) => createProductionTurnToolsetHost({
      ...input,
      factoryProvider: createTurnToolsetFactoryProvider(
        hostDependencies(),
      ),
      ...(projectedLocalToolPermission === undefined
        ? {}
        : { localToolPermission: projectedLocalToolPermission }),
    });

    if (productionContext !== undefined && productionPromptGlue !== undefined) {
      const turnRequestContext = productionRequestContext;
      const turnAutoReviewGate = autoReviewGate;
      if (turnRequestContext === undefined || turnAutoReviewGate === undefined) {
        throw new TypeError("production turn context owners are not bound");
      }
      const autoReviewModes = autoReview.autoReviewModes ?? {
        hostShell: "off",
        boxShell: "off",
        mcp: "off",
        computer: "off",
        automationWrite: "off",
        cloudAgent: "off",
        subagentLaunch: "off",
      };
      // An empty list here is a Task tool that can only fail: the schema still advertises
      // generalPurpose (task-tool-schema.ts:101 falls back to it), while execution resolves
      // against THIS list and throws "No subagent types are available."
      // (task-subagent-preparation.ts:494). Offer what the local box can actually run.
      // SUB-1 / TOOLS-03: the third entry. Task's enum is built from THIS list, so with only two
      // rows the browserUse subagent was unreachable and its fifteen browser_* tools -- which
      // turn-toolset pushes only for isBrowserUseSubagent -- were dead code. The gate is the
      // same one the prompt glue reads, so the description the model is given and the types it
      // may actually dispatch move together.
      // Evaluated per turn, not once per session: the browserUse override is re-read from the
      // host settings file on every call, and both desktop rows are only real when the box is
      // up -- `buildTurnTools` gates the browser factory AND Shell/Read on the same
      // `getRemoteBoxAvailable`, so offering the type with the box down dispatches a subagent
      // with an empty toolset. Offered types and the tools that back them move together.
      const desktopSubagentsAvailable = (): boolean =>
        method(remoteBox, "isAvailable")?.() !== false;
      const buildSubagentConfigs = (): NonNullable<TurnToolsetTurnInput["subagentConfigs"]> => {
        const desktopAvailable = desktopSubagentsAvailable();
        const browserUseOffered = desktopAvailable
          && method(experiments, "isBrowserUseSubagentEnabled")?.() === true;
        return [
          {
            // The executor factory carries the right description and shape; the name is
            // generalPurpose so the schema default and the resolver's preferred lookup
            // (GENERAL_PURPOSE_SUBAGENT_TYPE) both land on it.
            ...createSandExecutorSubagentConfig(),
            subagent_type: new SubagentType({
              type: { case: "custom", value: new SubagentTypeCustom({ name: "generalPurpose" }) },
            }),
            permissionMode: 0,
          },
          ...(desktopAvailable
            ? [{
              ...createSandComputerUseSubagentConfig({ browserUseOffered }),
              subagent_type: new SubagentType({
                type: {
                  case: "custom" as const,
                  value: new SubagentTypeCustom({ name: "computerUse" }),
                },
              }),
              permissionMode: 0,
            }]
            : []),
          ...(browserUseOffered
            ? [{
              ...createSandBrowserUseSubagentConfig(),
              subagent_type: new SubagentType({
                type: {
                  case: "custom" as const,
                  value: new SubagentTypeCustom({ name: BROWSER_USE_SUBAGENT_TYPE }),
                },
              }),
              permissionMode: 0,
            }]
            : []),
        ];
      };
      const baseTurn: TurnToolsetTurnInput = {
        autoReviewModes,
        subagentConfigs: buildSubagentConfigs(),
      };
      const staticModelId = process.env.SAND_AGENT_MODEL ?? DEFAULT_SAND_MODEL;
      /**
       * These three flags were reconstructed as literal `false`, which made the desktop
       * unreachable by design: `turn-toolset` only pushes the Computer tool when
       * `isComputerUseSubagent` is true, so a real computerUse subagent was still built
       * without hands. The runner already carries the answer -- a child is built with
       * `isSubagent: true` and the dispatched `subagentType` -- so derive from that.
       */
      const normalizeSubagentKind = (value: string | undefined): string | undefined =>
        typeof value === "string" ? value.replace(/[-_ ]/g, "").toLowerCase() : undefined;
      /**
       * TOOLS-02. The two desktop flags below were derived correctly while this one stayed the
       * literal `false`, so a computerUse subagent was offered the chief's twelve tools -- the
       * user's own machine (ExternalShell/ExternalRead/AwaitShell), the web pair, CopyToBox /
       * CopyFromBox, CloudAgent and the MCP pair -- instead of the three its role has. A
       * desktop-scoped subagent lives inside the box: Shell, Read, Computer.
       */
      const isBoxScopedSubagentKind = (shellSubagentKind?: string): boolean => {
        const kind = normalizeSubagentKind(shellSubagentKind);
        return kind === "computeruse" || kind === "browseruse";
      };
      const lazyToolHost = (
        shellSubagentKind?: string,
        shellConversationId: string = session.id,
      ) => createProductionTurnToolsetHost({
        turn: baseTurn,
        factoryProvider: createTurnToolsetFactoryProvider(hostDependencies()),
        isSubagentRunner: shellSubagentKind !== undefined,
        isSharedRoomRunner: isSharedRoomTurn,
        isBoxScopedSubagent: isBoxScopedSubagentKind(shellSubagentKind),
        isComputerUseSubagent: normalizeSubagentKind(shellSubagentKind) === "computeruse",
        isBrowserUseSubagent: normalizeSubagentKind(shellSubagentKind) === "browseruse",
        isSystemPromptOverridden: typeof overrides.systemPrompt === "string",
        remoteBoxHasDesktop: true,
        // The identity the shell runs as. `withAttestedResult` and the local-tool scope both key
        // off it, so a subagent's tool results used to be attested against its parent.
        getConversationId: () => shellConversationId,
        getRemoteBoxAvailable: desktopSubagentsAvailable,
        // TOOLS-09: same non-existent experiments method as the prompt assembly's gate; the
        // team-admin policy lives on the cloud-agents service.
        cloudAgentsDisabledByTeam: () => method(cloudAgents, "isDisabledByTeamAdmin")?.() ?? false,
        // CLOUD-1: offered only when the operator turns cloud agents on (SAND_CLOUD_AGENTS in the host settings file).
        cloudAgentsAvailable: () => isSandOverrideTruthy(readSandBoxSetting("SAND_CLOUD_AGENTS")),
        // TOOLS-15: offered only while a computer is answering on the local-exec bridge, and
        // TOOLS-18: the same held answer the prompt assembly reads, so the two cannot disagree.
        localMachineConnected: () => localMachine().connected,
        localMachineSource: () => localMachine().source,
        spotlightEnabled: () => method(experiments, "isSpotlightEnabled")?.() ?? false,
        isDynamicToolsEnabled: () => method(experiments, "isDynamicToolsEnabled")?.() ?? false,
        isMultitaskEnabled: () => method(experiments, "isMultitaskEnabled")?.() ?? false,
        isSharedRoomBoxToolsEnabled: sharedRoomBoxToolsEnabled,
        isBrowserToolsEnabled: browserToolsEnabled,
        ...(projectedLocalToolPermission === undefined
          ? {}
          : { localToolPermission: projectedLocalToolPermission }),
      });
      const getProductionConversationState = () => {
        const runner = builtRunner as {
          getAgentConversationStateStructure?: () => unknown;
        } | undefined;
        if (typeof runner?.getAgentConversationStateStructure === "function") {
          return runner.getAgentConversationStateStructure();
        }
        const store = session.agentStore;
        if (store != null && typeof store.getConversationStateStructure === "function") {
          return store.getConversationStateStructure();
        }
        throw new TypeError("production Agent conversation state is not bound");
      };
      conversationStateForEpoch = getProductionConversationState;
      /**
       * One shell per runner identity. A child previously reused the parent's shell, so its turns
       * were built with the parent's toolHost -- which is why a real computerUse subagent still
       * came back without the Computer tool and answered in prose.
       */
      /**
       * `shellConversationId` is the identity the shell RUNS AS: `session.id` for the chief, and
       * the child's own agent id for a subagent. The audit/receipt lane needs it -- a connector
       * call made by a subagent used to be recorded against the parent, which both emptied the
       * child's ledger and let a parent reply that made no tool call of its own be stamped
       * `evidenced` off its child's receipt.
       */
      const makeRunShell = (shellSubagentKind?: string, shellConversationId: string = session.id) => {
      const runShellPromptAssembly = createProductionSystemPromptAssembly({
        isSubagentRunner: shellSubagentKind !== undefined,
        isBoxScopedSubagent: isBoxScopedSubagentKind(shellSubagentKind),
        isComputerUseSubagent: normalizeSubagentKind(shellSubagentKind) === "computeruse",
        isBrowserUseSubagent: normalizeSubagentKind(shellSubagentKind) === "browseruse",
      });
      // TOOLS-18. This shell's own turn boundary: it drops the held local-machine answer only when
      // the run that started is the one the reader belongs to.
      const noteShellRunLifecycle = noteRunLifecycleFor(shellConversationId);
      /**
       * TOOLS-01 / CP-01 / TOOLS-10. Connectors were discovered every turn and then dropped on
       * the floor: `mcpMeta` was never bound on this path, so `buildTurnTools` never offered
       * GetMcpTools / CallMcpTool and the model could not reach a single connector tool. This
       * holder is what closes the loop -- the same per-turn discovery that feeds the Agent
       * stream also feeds the meta pair's descriptors. It is declared per run shell (one per
       * runner identity, and a runner runs one turn at a time), so a parent and its subagents
       * never share it.
       */
      let turnMcpTools: readonly McpToolForMeta[] = [];
      const isMcpToolForMeta = (value: unknown): value is McpToolForMeta =>
        typeof value === "object" && value != null
        && typeof (value as { providerIdentifier?: unknown }).providerIdentifier === "string"
        && typeof (value as { toolName?: unknown }).toolName === "string";
      const recordDiscoveredMcpTools = (tools: readonly unknown[]): void => {
        turnMcpTools = tools.filter(isMcpToolForMeta);
        mcpConnectedServerNamesForTurn = [
          ...new Set(turnMcpTools.map(tool => tool.providerIdentifier)),
        ];
      };
      return createProductionTurnRunShellHostInput({
        createAgentOwnerInput: ({ requestId, runOptions, context, cancelThisRun, emitUpdate }) => {
          if (session.agentStore == null || typeof session.agentStore.getBlobStore !== "function") {
            throw new TypeError("production Agent blob store is not bound");
          }
          const liveAutoReviewModes = turnAutoReviewGate.currentModes();
          const autoReviewRequestContext = new RequestContext({
            env: new RequestContextEnv({
              smartModeClassifierAutoModeEnabled: true,
            }),
          });
          const autoReviewInstructions = turnAutoReviewGate.userInstructions();
          const createShellReview = (
            mode: TurnShellAutoReviewInput["mode"],
            surface: TurnShellAutoReviewInput["surface"],
            approvalSurface: "host_shell" | "box_shell",
          ): TurnShellAutoReviewInput | undefined => mode === "off"
            ? undefined
            : {
                mode,
                agentId: session.id,
                surface,
                requestContext: autoReviewRequestContext,
                ...(autoReviewController === undefined
                  ? {}
                  : { controller: autoReviewController }),
                getApprovalExpiryPolicy: () =>
                  sandAutoReviewApprovalExpiryPolicy("turn"),
                smartModeShellApprovalState:
                  turnAutoReviewGate.shellApprovalState(approvalSurface),
                ...(autoReviewInstructions === undefined
                  ? {}
                  : {
                      userAutoRunInstructions: {
                        allowInstructions: autoReviewInstructions.allowInstructions,
                        blockInstructions: autoReviewInstructions.blockInstructions,
                      },
                    }),
                enforceModelFacingShellUiAutomationGuard:
                  liveAutoReviewModes.hostShell === "enforce"
                  || liveAutoReviewModes.computer === "enforce",
              };
          const hostShellReview = createShellReview(
            liveAutoReviewModes.hostShell,
            "host_machine",
            "host_shell",
          );
          const boxShellReview = createShellReview(
            liveAutoReviewModes.boxShell,
            "isolated_box",
            "box_shell",
          );
          const turn: TurnToolsetTurnInput = {
            ...baseTurn,
            subagentConfigs: buildSubagentConfigs(),
            emitUpdate,
            cancelThisRun,
            ...(runOptions.ackToken === undefined
              ? {}
              : { ackToken: runOptions.ackToken }),
            ...(hostShellReview === undefined && boxShellReview === undefined
              ? {}
              : {
                  shellAutoReview: {
                    ...(hostShellReview === undefined
                      ? {}
                      : { host: hostShellReview }),
                    ...(boxShellReview === undefined
                      ? {}
                      : { box: boxShellReview }),
                  },
                }),
          };
          return {
            context,
            conversationId: session.id,
            requestId,
            inference: createTypedInferenceOwner(extensions.api("inference").port),
            onRequestId: requestIdForwarder(hooks, "agent"),
            isSubagentRunner: false,
            isSilenceAllowed: runOptions.isSilenceAllowed === true,
            ...(runOptions.ackToken === undefined
              ? {}
              : { ackToken: runOptions.ackToken }),
            canUseSelfSummary: () => true,
            cancelThisRun: reason => {
              const runner = builtRunner as { interrupt?: (value: string) => boolean } | undefined;
              runner?.interrupt?.(reason.reason);
            },
            createResourceAccessor: localProductionResourceAccessor,
            createRemoteBoxResourceAccessor: productionResourceAccessor,
            createTurnLocalResourceProjectionInput: baseAccessor => {
              const runner = builtRunner;
              if (runner === undefined) {
                throw new TypeError("production turn resource runner is not bound");
              }
              const projectedActionAuditor = asActionAuditor(actionAuditor);
              if (projectedActionAuditor === undefined) {
                throw new TypeError("production turn action auditor is not bound");
              }
              const mcpApi = mcp.mcp as DynamicApi | undefined;
              const mcpForTurn: TurnMcpProjectionInput | undefined =
                mcpApi == null
                  || typeof mcpApi.createExecutor !== "function"
                  || typeof mcpApi.createStateExecutor !== "function"
                  ? undefined
                  : {
                    mcpForTurn: {
                      // wrapMcpExecutorForAudit was written and then wired to nothing, so an
                      // MCP call left no receipt and no audit row; the evidence layer could
                      // never stamp a connector answer "evidenced". It belongs here, around
                      // the executor this turn actually runs.
                      createExecutor: (persistImage, spillLargeText, auditIdentity) =>
                        wrapMcpExecutorForAudit(
                          mcpApi.createExecutor(
                            persistImage,
                            spillLargeText,
                            auditIdentity,
                          ) as { execute(ctx: unknown, args: never, options?: unknown): Promise<never> },
                          {
                            agentId: shellConversationId,
                            auditor: projectedActionAuditor,
                            resolveTransport: async server =>
                              String(await mcpApi.resolveToolTransport?.(server) ?? "unknown"),
                          },
                        ) as unknown as ReturnType<TurnMcpForTurn["createExecutor"]>,
                      createStateExecutor: () =>
                        mcpApi.createStateExecutor() as ReturnType<
                          TurnMcpForTurn["createStateExecutor"]
                        >,
                      ...(typeof mcpApi.resolveNeedsAuthSlot === "function"
                        ? {
                          resolveNeedsAuthSlot: (providerIdentifier: string) =>
                            mcpApi.resolveNeedsAuthSlot(providerIdentifier) as Promise<
                              { readonly serverName: string; readonly serverId: string } | null
                            >,
                        }
                        : {}),
                    },
                    persistImage: persistImageForTurn,
                    textSpiller: undefined,
                    isSubagentRunner: shellSubagentKind !== undefined,
                    // Not a stub: the guard hands back an error class only when a call fails,
                    // and mcp-diagnostics is the existing sink for exactly that. A constant
                    // no-op here would throw away the one signal the guard produces.
                    beginObservation: ({ connector }) => errorClass => {
                      if (errorClass === undefined) return;
                      reportMcpHostEdgeDegraded(`mcp_exec:${connector}`, errorClass);
                    },
                    boundedConnectorTag,
                    mcpErrorClassOf,
                    takeMcpExecErrorClass,
                    emitConnectorCard: emission => {
                      hooks.transport.onUpdate({
                        type: "send-message",
                        message: connectorCardEmissionToMessage({
                          ...emission,
                          connector: emission.connector ?? "",
                        }),
                        timestampMs: Date.now(),
                      });
                    },
                    ...(runOptions.ackToken === undefined
                      ? {}
                      : { ackToken: runOptions.ackToken }),
                    cancelThisRun,
                    reportDiagnostic: event =>
                      reportMcpHostEdgeDegraded(event.kind, event.errorClass),
                    errorLogTag,
                    mcpMeta: {
                      getMcpTools: () => turnMcpTools,
                      callOptions: {},
                    },
                  };
              const createSubagentRunner = (
                agentId: string,
                args: SubagentAdapterArgs,
              ): SubagentSession => {
                const child = deps.buildRunner({
                  ...runnerOptions,
                  conversationId: agentId,
                  transcriptId: agentId,
                  isSubagent: true,
                  subagentType: args.subagentType,
                  initialState: {
                    turns: [],
                    summaryArchives: [],
                    turnTimings: [],
                  },
                  // The reconstruction never recovered the original turn engine's
                  // createRunStep, so a child stripped of the run shell has NO turn path at
                  // all: SandAgentRunner.run() hits `runStep == null` and returns undefined,
                  // which surfaces as "production subagent result is not bound". Give the
                  // child the same production run shell the parent runs on; its own
                  // conversationId/transcriptId keep its turns distinct.
                  productionTurnRunShell: makeRunShell(args.subagentType, agentId),
                  // TOOLS-18. The child inherits the parent's hooks through the spread above,
                  // and its "started" would otherwise arrive on the parent's turn boundary.
                  onRunLifecycle: noteRunLifecycleFor(agentId),
                });
                bindSessionOwnedRunner(child);
                ownedRunners.add(child);
                return {
                  run: async (prompt, options) => {
                    const result = await child.run(prompt, options);
                    if (typeof result !== "object" || result == null) {
                      throw new TypeError("production subagent result is not bound");
                    }
                    const text = Reflect.get(result, "text");
                    const aborted = Reflect.get(result, "aborted");
                    if (typeof text !== "string" || typeof aborted !== "boolean") {
                      throw new TypeError("production subagent result is not bound");
                    }
                    return { text, aborted };
                  },
                  interrupt: reason => {
                    child.interrupt(reason);
                  },
                  getResolvedOutline: () => child.getResolvedOutline(),
                  getObservedToolCallCount: () => child.getObservedToolCallCount(),
                  getActivitySnapshot: () => child.getActivitySnapshot(),
                  getTranscriptPath: () => child.getTranscriptPath(),
                };
              };
              const computerUse = runner.computerUse;
              return {
                subagentSessions: runner.subagents.sessions,
                createSubagentRunner,
                subagentDispatcher: {
                  isRunning: agentId => runner.subagents.isRunning(agentId),
                  allocateComputerUseWindow: agentId =>
                    computerUse?.allocateWindow(agentId) ?? null,
                  freeComputerUseWindow: agentId => {
                    computerUse?.freeWindow(agentId);
                  },
                  dispatch: input => runner.subagents.dispatchBackgroundSubagent(input),
                },
                requestContext: turnRequestContext,
                includeTranscripts: !isSharedRoomTurn,
                autoReviewEnforceEnabled: Object.values(autoReviewModes).includes("enforce"),
                ...(autoReview.autoReviewClassifierExecutor === undefined
                  ? {}
                  : { smartModeClassifierExecutor: autoReview.autoReviewClassifierExecutor }),
                shellStreamExecutor: baseAccessor.get(shellStreamExecutorResource),
                backgroundShellExecutor: baseAccessor.get(backgroundShellExecutorResource),
                autoReviewGate: {
                  assertNoPendingApproval: () => turnAutoReviewGate.assertNoPendingApproval(),
                },
                actionAuditor: projectedActionAuditor,
                // The runner identity, not the session's: this projection audits the shell's own
                // shell commands, subagent-action reviews and MCP calls.
                agentId: shellConversationId,
                /**
                 * TOOLS-01. Two things hang off this projection and neither existed on the
                 * production path: the MCP executor / state-executor resources CallMcpTool
                 * runs on, and the `mcpMeta` descriptors GetMcpTools reads. Without it
                 * `createTurnLocalResourceProjection` reported `mcpEntriesPending: true` and
                 * `buildTurnTools` withheld the pair, which is why fourteen live connector
                 * tools were invisible to the model.
                 */
                ...(mcpForTurn === undefined ? {} : { mcp: mcpForTurn }),
              };
            },
            blobStore: getAgentBlobStore(
              session.agentStore as Parameters<typeof getAgentBlobStore>[0],
            ),
            toolHost: lazyToolHost(shellSubagentKind, shellConversationId),
            turn,
            staticConfig: {
              modelId: staticModelId,
              agentTokenLimit: 200_000,
              conversationId: shellConversationId,
              // Built per run, so the streak is per turn and the cap is re-read every step: an
              // operator can raise it, or set it to 0, on a box that is already looping.
              selfTalkCap: createSelfTalkCap({
                readCap: () => resolveSelfTalkCap(readSandBoxSetting(SAND_SELF_TALK_CAP_SETTING)),
                onCapReached: verdict => {
                  console.warn(`[sand][turn] self-talk cap reached for ${shellConversationId}: ${verdict.steps} consecutive SendMessage-only steps (cap ${verdict.cap}, ${SAND_SELF_TALK_CAP_SETTING}); ending the turn`);
                  // The reason is what stops the work redrive from immediately buying another
                  // cap's worth of the same loop.
                  emitUpdate({ type: "notice", text: SELF_TALK_CAP_NOTICE, timestampMs: Date.now(), reason: "self-talk-cap" });
                },
              }),
              isBoxScopedSubagent: isBoxScopedSubagentKind(shellSubagentKind),
              isSubagentRunner: shellSubagentKind !== undefined,
              isSharedRoomRunner: isSharedRoomTurn,
              sandSendMessageDeliveryOwed: method(experiments, "isSendMessageDeliveryOwedEnabled")?.() ?? false,
              systemPromptGenerator: () => dumpAssembledSystemPrompt(
                shellConversationId,
                runShellPromptAssembly?.getSystemPrompt() ?? DEFAULT_SAND_SYSTEM_PROMPT,
              ),
            },
            emitUpdate,
            interactionObservers: {},
            diskPressureReminder: foreverBox.diskPressureReminder,
            ...(runShellPromptAssembly === undefined
              ? {}
              : (() => {
                  const profilePromptSnapshotStore = asPromptSnapshotStore(session.db);
                  return profilePromptSnapshotStore === undefined
                    ? {}
                    : { profilePromptSnapshotStore };
                })()),
            emittedConnectorCards: new Set(),
          } satisfies ProductionTurnAgentOwnerInput;
        },
        promptOptions: (_prompt, options) => toGeneratedTurnPromptOptions(options),
        assembleGeneratedTurnAction: productionPromptGlue.assembleGeneratedTurnAction,
        compactionEpoch: readCompactionEpoch,
        getConversationState: getProductionConversationState,
        ...(mcp.mcp != null && typeof mcp.mcp.getTools === "function"
          ? {
              mcp: {
                // The single per-turn discovery. Its result is what the Agent stream is given,
                // what the meta pair's descriptors are built from (TOOLS-01), and where the
                // connected-server names and custom instructions the prompt needs come from
                // (SP-2) -- one call, three consumers, instead of the three constants the
                // prompt glue used to be handed.
                getTools: async (runContext: Context) => {
                  let tools: readonly unknown[];
                  try {
                    tools = [...await mcp.mcp.getTools(runContext)];
                  } catch (error) {
                    turnMcpTools = [];
                    mcpConnectedServerNamesForTurn = [];
                    mcpDiscoveryUnavailableForTurn = true;
                    throw error;
                  }
                  mcpDiscoveryUnavailableForTurn = false;
                  recordDiscoveredMcpTools(tools);
                  try {
                    const instructions = await mcpCustomInstructions?.();
                    mcpCustomInstructionsForTurn = instructions instanceof Map
                      ? instructions
                      : new Map();
                  } catch {
                    mcpCustomInstructionsForTurn = new Map();
                  }
                  return tools;
                },
                refreshAccountConfig: () => mcp.mcp.refreshAccountConfig(),
              },
              onMcpDiscoveryFailed: () => {
                mcpDiscoveryUnavailableForTurn = true;
              },
            }
          : {}),
        createSession: owner => ({
          getModelId: () => owner.runContext.sessions.agent.getModelId(),
          getExecutor: () => createTextExecutor(owner.runContext.toolSession.getExecutor()),
        }),
        context: () => productionContext,
        createSettleHost: createProductionTurnSettleHost,
        profilePromptSnapshots: () => session.db,
        isSubagentRunner: false,
        subagents: { sessions: new Map() },
        getConversationId: () => session.id,
        runGeneration: () => (builtRunner as { currentRunGeneration?: number } | undefined)?.currentRunGeneration ?? 0,
        setActiveTurnRequestSource: () => {},
        beginAutoReviewUserMessageEpoch: () => {},
        setActiveRunInterrupted: () => {},
        setAwaitingUserSelection: () => {},
        isAwaitingUserSelection: () => false,
        emitRunLifecycle: noteShellRunLifecycle,
        emitUpdate: update => hooks.transport.onUpdate(update),
        ...(hooks.transport.lastReactionApplied === undefined
          ? {}
          : { lastReactionApplied: () => hooks.transport.lastReactionApplied?.() === true }),
        cancelThisRun: () => {},
      });
      };
      runnerOptions.productionTurnRunShell = makeRunShell();
    }

    if (deps.createRunStep != null && runnerOptions.productionTurnRunShell === undefined) {
      runnerOptions.runStep = deps.createRunStep({
        session,
        hooks,
        overrides,
        runnerOptions,
        createTurnToolInputs,
      });
    }

    function bindSessionOwnedRunner(runner: Runner): void {
      runner.setAgentStore(session.agentStore, hooks.agentProfileProvider);
      runner.setMemoryStore(session.memory);
      runner.setUserMemory(runnerOptions.userMemory);
      runner.setProjectMemory(runnerOptions.projectMemory);
      runner.setMemorySnapshotStore(session.db);
      runner.setProfilePromptSnapshotStore(session.db);
      runner.setEpisodeProgress(session.db);
      runner.setAutomationStore(session.automations);
      runner.setWorkflowStore(session.workflows);
      runner.setChannelStore(session.channels);
      runner.setMcp(mcp.mcp);
      runner.setMcpManagement(mcp.management);
      runner.setAttachmentIngestor(hooks.ingestAttachment);
      runner.setImagePersister(hooks.persistImage);
      runner.setMediaBytesPersister(hooks.persistMediaBytes);
    }

    const runner = deps.buildRunner(runnerOptions);
    bindSessionOwnedRunner(runner);
    ownedRunners.add(runner);
    builtRunner = runner;
    // Keep the owner-scoped activation anchor stable while retaining the
    // single real buildRunner call needed by post-construction projections.
    // return deps.buildRunner(runnerOptions);
    return runner;
  }

  return {
    createRunner: (session, hooks) => createRunner(session, hooks),
    createGroupMemberRunner: (session, hooks, groupOverrides) =>
      createRunner(session, hooks, {
        ...groupOverrides,
        groupMemberTurn: true
      }),
    canAskLocalToolPermission: agentId =>
      localToolPermissionSurfaces.has(agentId),
    forgetLocalToolPermission: agentId => {
      localToolPermissionSurfaces.get(agentId)?.();
      localToolPermissionSurfaces.delete(agentId);
      method(localToolPermission, "forgetAgent")?.(agentId);
    },
    dispose: async () => {
      for (const runner of ownedRunners) {
        const candidate = runner as {
          interrupt?(reason?: string): unknown;
          dispose?(): void | Promise<void>;
        };
        candidate.interrupt?.("host shutdown");
        await candidate.dispose?.();
      }
      ownedRunners.clear();
      for (const unsubscribe of localToolPermissionSurfaces.values()) {
        unsubscribe();
      }
      localToolPermissionSurfaces.clear();
      await mirrorOffloadPool?.closeAll();
      mirrorOffloadPool = null;
    }
  };
}
