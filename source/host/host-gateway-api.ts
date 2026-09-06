
import { Value, type JsonValue } from "@bufbuild/protobuf";
import { createContext } from "../packages/context/core.js";
import { shellExecutorResource } from "../packages/agent-exec/shell.js";
import { buildHostShellArgs } from "./box/box-shell-command.js";
import { getSandRootDir } from "./host-paths.js";
import { isConnectorEnvFieldName } from "./extensions/mcp/connector-secrets.js";
import {
  MARKETPLACE_CATALOG,
  findMarketplaceBot,
  findMarketplacePlugin,
} from "../shared/marketplace/catalog.js";
import {
  SHELL_TOOLS,
  SHELL_TOOL_FIELDS,
  findShellTool,
} from "./extensions/shell-tools/shell-tool-catalog.js";
import {
  deleteShellEnvSecret,
  listShellEnvSecretFields,
  pushShellEnvSecretsToBox,
  readShellEnvSecrets,
  writeShellEnvSecret,
} from "./extensions/shell-tools/shell-secrets.js";
import {
  isShellEnvSecretField,
  shellEnvSecretFieldRefusal,
} from "./extensions/shell-tools/shell-secret-field.js";
import {
  fetchShellToolSkill,
  probeShellToolBinary,
  readShellSecretProbe,
  runShellToolInstall,
  shellSecretProbeCommand,
} from "./extensions/shell-tools/shell-tools-service.js";
import { setHostRoutedToolExecutor } from "./extensions/inference/provider-session.js";
import { evidenceRegistry, readAgentEvidence } from "./extensions/evidence/evidence-registry.js";
import { GatewayCommandError } from "./gateway-command-error.js";
import {
  JOB_BUS_API_VERSION,
  createJobStore,
  hostPackageVersion,
  type JobRecord,
} from "./extensions/job-bus/job-store.js";
import { createJobSettingsStore } from "./extensions/job-bus/job-settings.js";
import { createGitHubClient } from "./extensions/job-bus/github-client.js";
import { agentConnectorIds, createJobWorker } from "./extensions/job-bus/job-worker.js";
import {
  parseCoordinatorAgentThreadRequest,
  parseCoordinatorTranscriptWindowRequest,
} from "../shared/rpc/coordinator.js";

export const HOST_CAPABILITIES = [
  "orderedReplicasV1",
  "sendAcceptanceV1"
] as const;
export const CREATE_AGENT_NONCE_LEDGER_CAP = 64;
export const DISABLE_SEND_ACCEPT_RETURN_ENV = "SAND_DISABLE_SEND_ACCEPT_RETURN";

/** The awaiting-response tab the job bus owns; `box`, `auto-review` and `turn-question` are the others. */
export const JOB_BUS_AWAITING_TAB_ID = "job-bus";

const SAND_AGENT_PURPOSES = new Set(["disk-saver", "plugin-auth"]);
const TEMPLATE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

type DynamicMethod = (...args: any[]) => any;
export type DynamicGatewayApi = Record<string, any>;

export interface HostGatewayDependencies {
  readonly extensions: {
    api(id: string): DynamicGatewayApi;
  };
  readonly hostEvents: {
    emit(event: unknown): unknown;
  };
  readonly rosterBookkeeping?: {
    readonly latestActiveAgentId: string | null;
  };
  decorateForeverBoxStatus(status: any): any;
  getHealth(): { readonly isBusy: boolean };
  kickstartIfPending(agentId: string): Promise<boolean>;
  requestDiskSaverAudit(agentId: string): Promise<boolean>;
  releaseAgentBox(agentId: string): Promise<void>;
  handleDesktopMcpAuthCompletion(completion: unknown): Promise<void>;
  forgetLocalToolPermission(agentId: string): void;
  readonly now?: () => number;
}

/**
 * Tool arguments reach the routed path as plain JSON: the console posts them, and the model's
 * own tool call is parsed out of a stream. The HTTP branch of the executor turns whatever it is
 * handed back into JSON, but the box branch serializes it as a protobuf map<string, Value>, where
 * a plain object is "google.protobuf.Value must have a value" and every stdio connector on the
 * box is unreachable. Marshal once here, where the JSON enters the host, as the agent package
 * already does when it builds an McpArgs for the same executor.
 */
function toValueArgs(args: unknown): Record<string, Value> {
  if (args == null || typeof args !== "object") return {};
  const values: Record<string, Value> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined) continue;
    values[key] = value instanceof Value ? value : Value.fromJson(value as JsonValue);
  }
  return values;
}

function isSandAgentPurpose(value: unknown): value is string {
  return typeof value === "string" && SAND_AGENT_PURPOSES.has(value);
}

function sanitizeTemplateId(value: unknown): string | undefined {
  return typeof value === "string" && TEMPLATE_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function method(api: DynamicGatewayApi, name: string): DynamicMethod {
  const candidate = api[name];
  if (typeof candidate !== "function") {
    throw new Error(`host extension method is unavailable: ${name}`);
  }
  return candidate.bind(api);
}

/**
 * Restores the shipped gateway method table. Each method delegates to the
 * extension that owned the behavior in the artifact; the host layer retains
 * cross-cutting nonce dedupe, telemetry, cleanup, feature gates, and status
 * decoration.
 */
export function createHostGatewayApi(
  deps: HostGatewayDependencies
): Record<string, DynamicMethod> {
  const manager = deps.extensions.api("transcript");
  const attachments = deps.extensions.api("attachments");
  const automations = deps.extensions.api("automations");
  const managedSetup = deps.extensions.api("managed-setup");
  const settings = deps.extensions.api("settings");
  const localToolPermission = deps.extensions.api("local-tool-permission");
  const telemetry = deps.extensions.api("telemetry");
  const sharing = deps.extensions.api("cross-user-sharing");
  const now = deps.now ?? Date.now;
  const createAgentMintsByNonce = new Map<string, Promise<any>>();

  // JOBBUS. The Titan Job Bus (docs/JOB-BUS.md). Same root the connector and shell-tool stores use,
  // so `<sand-data>/job-bus/` lands on the box data volume with the rest of the host's state. The
  // store owns `emit`, not the worker, so EVERY transition reaches the console's SSE stream by
  // construction, including a cancel that arrives through the gateway while the loop is asleep.
  // The loop starts here because this table is built exactly once, when the gateway comes up.
  // The settings file sits on the box data volume, which is the filesystem the worker's own shell
  // runs on, and nothing signs it. The store therefore holds the host's copy of the four fields
  // that widen the bus and refuses a file that tries to widen them; a divergence is a row in the
  // same hash chain as everything else, because "the policy file changed under us" is exactly the
  // question that chain exists to answer. docs/JOB-BUS.md 10.5 and 10.7.
  const jobSettings = createJobSettingsStore(getSandRootDir(), {
    onDivergence: (fields) => {
      void jobStore.appendExternalAudit({ event: "settings_diverged", fields, ok: false })
        .catch(() => undefined);
    },
    // Section 10.9: a settings.json that is there but cannot be believed is moved aside at start and
    // the host runs on the defaults, which is the bus OFF. The row says so in the same hash chain.
    onQuarantine: (quarantine) => {
      void jobStore.appendExternalAudit({
        event: "store_quarantined", client: quarantine.movedTo, ok: false,
        fields: [quarantine.detail],
      }).catch(() => undefined);
    },
  });
  const jobStore = createJobStore({
    rootDir: getSandRootDir(),
    readSettings: () => jobSettings.read(),
    now,
    emit: (event) => { deps.hostEvents.emit(event); },
  });
  /**
   * Section 10.2's per-job clone has to be deleted the same way `deleteAgent` deletes one, or it
   * leaves a box lease, a schedule and a local-tool permission behind on every job. This is that
   * teardown, lifted out so the command and the bus cannot drift apart.
   */
  const removeAgentCompletely = async (agentId: string): Promise<unknown> => {
    await method(sharing, "noteAgentDeleted")(agentId);
    const result = await method(manager, "deleteAgent")(agentId);
    method(deps.extensions.api("session"), "forgetHandoff")(agentId);
    await method(automations, "deleteAgentSchedules")(agentId).catch(() => undefined);
    await deps.releaseAgentBox(agentId);
    deps.hostEvents.emit({ kind: "notification-agent-forgotten", agentId });
    deps.forgetLocalToolPermission(agentId);
    return result;
  };
  const jobWorker = createJobWorker({
    store: jobStore,
    listAgents: () => method(manager, "listAgentsSync")(),
    sendPrompt: (prompt, agentId) => method(manager, "sendPrompt")(prompt, { agentId }),
    readEntries: async (agentId) =>
      await (manager as any).sessionStore?.getAgentTranscriptEntries?.(agentId) ?? [],
    readEvidence: (agentId, options) => readAgentEvidence(agentId, options),
    now,
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }),
    readSettings: () => jobSettings.read(),
    writeSettings: (partial) => jobSettings.write(partial),
    cloneAgent: async (sourceAgentId) => {
      const clone = await method(manager, "cloneAgent")(sourceAgentId);
      return String(clone?.id ?? clone?.agent?.id ?? "");
    },
    renameAgent: async (agentId, name) => {
      const summary = method(manager, "listAgentsSync")().find((agent: any) => agent?.id === agentId);
      return await method(manager, "updateAgent")(agentId, {
        name,
        description: typeof summary?.description === "string" ? summary.description : "",
      });
    },
    deleteAgent: (agentId) => removeAgentCompletely(agentId),
    // A per-agent connector is a channel connection; stripping one is the same disconnect the
    // console's own Channels card does. `agentConnectorIds` reads the clone's channel directory as
    // well as the credentialed list, because a clone carries no connector SECRETS. Section 10.9 is
    // honest about the rest: `cloneAgentDir` copies no channels directory either, so this list is
    // EMPTY for every clone this tree can make, the strip loop does not run in production and its
    // fail-closed branch is not reachable. Isolation rests on the clone having neither; this is the
    // check for the day a clone does inherit a channel, not a defence that runs today.
    listAgentConnectors: (agentId) => agentConnectorIds((manager as any).sessionStore, agentId),
    disconnectAgentConnector: (agentId, connectorId) =>
      (manager as any).sessionStore?.disconnectChannel?.(agentId, connectorId),
    // Section 10.9: the clone inherits the template's automation configs, so they go before the
    // prompt does. Same failure mode as a connector that will not strip: the job stops.
    listAgentAutomations: async (agentId) =>
      ((await method(manager, "getAgentAutomations")(agentId)) ?? [])
        .map((automation: any) => String(automation?.id ?? ""))
        .filter((id: string) => id.length > 0),
    deleteAgentAutomation: (agentId, automationId) =>
      method(manager, "deleteAgentAutomation")(agentId, automationId),
    // Section 10.4: the box's own GitHub credential, read host-side, never handed to the worker.
    github: () => createGitHubClient({ token: readShellEnvSecrets(getSandRootDir()).GITHUB_TOKEN ?? null }),
    markUnread: (agentId) => { method(manager, "setAgentUnread")(agentId, true, now()); },
    // ATTN-1's needs-you signal, on its own awaiting tab so a box hand-off or an approval badge
    // already on the row keeps it.
    raiseNeedsYou: (agentId, reason) => {
      void (manager as any).sessionStore?.setAwaitingUserResponseForTab?.(
        agentId,
        JOB_BUS_AWAITING_TAB_ID,
        { tabId: JOB_BUS_AWAITING_TAB_ID, reason, since: now() },
      );
    },
  });
  jobWorker.start();
  /**
   * Section 10.9. Two ways the bus is off: the operator has not turned it on, and the host did not
   * trust a file it read at start. The second answers with the same 503 -- the caller's next move is
   * the same either way -- and names what was quarantined so the console and the audit agree.
   */
  const jobBusIntegrity = async (): Promise<{ ok: boolean; detail: string; quarantined: readonly unknown[] }> => {
    const store = await jobStore.integrity();
    const settings = jobSettings.quarantined();
    const quarantined = [...store.quarantined, ...(settings == null ? [] : [settings])];
    return {
      ok: quarantined.length === 0,
      detail: quarantined.map((entry: any) => String(entry?.detail ?? "")).filter((line: string) => line.length > 0).join("; "),
      quarantined,
    };
  };
  const requireJobBusEnabled = async (): Promise<void> => {
    const integrity = await jobBusIntegrity();
    if (!integrity.ok) {
      throw new GatewayCommandError(503, { error: "job bus is disabled", detail: integrity.detail });
    }
    if (!jobSettings.read().enabled) {
      throw new GatewayCommandError(503, { error: "job bus is disabled" });
    }
  };
  const requireJob = async (args: any): Promise<JobRecord> => {
    const job = await jobStore.get(String(args?.id ?? ""));
    if (job == null) throw new GatewayCommandError(404, { error: "job not found" });
    return job;
  };

  // CONNECT-5. The shell-tool plane. `getSandRootDir()` is the same root the connector store uses;
  // the box is read lazily because the forever-box extension starts after this table is built.
  const shellCtx = createContext().withName("shellTools");
  const shellRoot = () => getSandRootDir();
  const shellSecretsSnapshot = () => {
    const stored = listShellEnvSecretFields(shellRoot());
    return { fields: [...new Set([...SHELL_TOOL_FIELDS, ...stored])].sort(), stored };
  };
  /**
   * The values only reach the agent's shell once they are in the box exec-daemon's environment --
   * that daemon is what spawns `/bin/sh -lc` for the shell tool. A box that is not up yet is not a
   * failure: HostBox.ensureReady re-pushes the store on the next bring-up, which is before any
   * shell can run. The boolean says which of the two happened, so the console never claims the
   * live box has a value it does not.
   */
  const pushShellSecretsToBox = async (clearing: readonly string[] = []): Promise<boolean> => {
    try {
      return await pushShellEnvSecretsToBox(shellRoot(), deps.extensions.api("forever-box").box, shellCtx, clearing);
    } catch {
      return false;
    }
  };
  /**
   * SECRET-1. The WRITE rule, shared with the secret-request card's "shell" route so an agent
   * asking for a variable inline and an operator typing one in the console are held to one rule.
   */
  const requireShellField = (field: unknown, command: string): string => {
    if (!isShellEnvSecretField(field)) {
      throw new Error(`${command} refused this field. ${shellEnvSecretFieldRefusal(field)}`);
    }
    return field;
  };
  /**
   * Reading, probing and DELETING stay on the looser connector rule. A stricter write rule must
   * never strand a value a laxer past wrote: whatever the store holds has to remain removable.
   */
  const requireStoredShellField = (field: unknown, command: string): string => {
    if (!isConnectorEnvFieldName(field)) {
      throw new Error(`${command} needs an environment variable name as \`field\` (process-control names such as PATH, NODE_OPTIONS and LD_* are refused)`);
    }
    return field;
  };
  const requireShellTool = (id: unknown) => {
    const entry = findShellTool(id);
    if (entry == null) throw new Error(`no shell tool "${String(id)}"; this box knows ${SHELL_TOOLS.map((tool) => tool.id).join(", ")}`);
    return entry;
  };

  const markActive = (reason: "user_action" | "app_open") => {
    method(telemetry.analytics, "markActive")(reason);
  };

  const mintAgent = async (args: any) => {
    const result = await method(manager, "createAgent")(
      {
        name: args.name,
        description: args.description,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.avatarShape === undefined
          ? {}
          : { avatarShape: args.avatarShape }),
        ...(args.avatarColor === undefined
          ? {}
          : { avatarColor: args.avatarColor })
      },
      args.origin,
      {
        isIntroductionSuppressed: args.isIntroductionSuppressed ?? false,
        isKickstartRequested: args.isKickstartRequested ?? false,
        ...(isSandAgentPurpose(args.purpose)
          ? { purpose: args.purpose }
          : {})
      }
    );
    markActive("user_action");
    const templateId = sanitizeTemplateId(args.templateId);
    method(telemetry.analytics, "trackEvent")("sand.agent.created", {
      agent_id: result.agent.id,
      origin: args.origin ?? "user",
      ...(templateId === undefined ? {} : { template_id: templateId })
    });
    return result;
  };

  const openAgent = async (
    args: any,
    operation: "switchAgent" | "openAgentWindowed" | "openAgentTail"
  ) => {
    markActive("app_open");
    method(telemetry, "noteSandModelExperimentActive")();
    const wasActive = method(manager, "getActiveAgentId")() === args.id;
    const startedAt = now();
    const result = operation === "switchAgent"
      ? await method(manager, operation)(args.id)
      : await method(manager, operation)(args.id, args.limit);
    const entries = operation === "switchAgent" ? result : result.entries;
    method(telemetry.logs, "reportAgentOpen")({
      conversationId: args.id,
      durationMs: now() - startedAt,
      entryCount: entries.length,
      wasActive
    });
    void deps.kickstartIfPending(args.id);
    return result;
  };

  const markSharingAction = async (name: string, args: any) => {
    markActive("user_action");
    return await method(sharing, name)(args);
  };

  const listRoutedMcpTools = async () => {
    const extension = deps.extensions.api("mcp");
    const mcp = extension.mcp;
    const tools = await method(mcp, "listTools")({});
    return tools.map((tool: any) => ({
      name: tool.name,
      providerIdentifier: tool.providerIdentifier,
      toolName: tool.toolName,
      ...(tool.description == null ? {} : { description: tool.description }),
      ...(tool.inputSchema == null ? {} : { inputSchema: typeof tool.inputSchema.toJson === "function" ? tool.inputSchema.toJson() : tool.inputSchema }),
    }));
  };
  const executeRoutedMcpTool = async (args: any) => {
    const mcp = deps.extensions.api("mcp").mcp;
    const executor = method(mcp, "createExecutor")(undefined, undefined, { agentId: args.agentId });
    return await method(executor, "execute")({}, {
      name: args.toolName,
      toolName: args.name,
      providerIdentifier: args.providerIdentifier,
      args: toValueArgs(args.args),
      toolCallId: args.toolCallId,
    });
  };

  // The routed providers had no way to run a tool the model picked. executeRoutedMcpTool
  // is exactly that capability and it already lives here, so hand it to them. Registered
  // where it is defined rather than rebuilt inside the inference extension, which does not
  // receive the mcp extension in its context.
  setHostRoutedToolExecutor(async (tool: any, args: unknown, toolCallId: string) =>
    await executeRoutedMcpTool({
      providerIdentifier: tool?.providerIdentifier,
      name: tool?.name,
      toolName: tool?.toolName,
      args,
      toolCallId,
    }));

  return {
    getTranscript: () => method(manager, "ensureLoaded")(),
    getAgentTranscript: (args: any) =>
      method(manager, "getAgentTranscript")(args.id),
    getAgentTranscriptPage: (args: any) =>
      method(manager, "getAgentTranscriptPage")(args.id, args),
    getAgentTranscriptWindow: (args: unknown) => {
      const request = parseCoordinatorTranscriptWindowRequest(args);
      if (request == null) throw new Error("Malformed getAgentTranscriptWindow request");
      return method(manager, "getAgentTranscriptWindow")(request.id, args);
    },
    getAgentTranscriptTail: (args: any) =>
      method(manager, "getAgentTranscriptTail")(args.id, args),
    getAgentThread: (args: unknown) => {
      const request = parseCoordinatorAgentThreadRequest(args);
      if (request == null) throw new Error("Malformed getAgentThread request");
      return method(manager, "getAgentThread")(request.id, request.rootId);
    },

    sendPrompt: async (args: any) => {
      const agentId =
        (typeof args.agentId === "string" && args.agentId.length > 0
          ? args.agentId
          : undefined) ??
        method(manager, "getActiveAgentId")() ??
        deps.rosterBookkeeping?.latestActiveAgentId ??
        "unknown";
      method(telemetry, "reportMessageSent")({
        ...args,
        agentId,
        isGroupRoom: method(manager, "listAgentsSync")()
          .find((agent: any) => agent.id === agentId)?.isGroup === true
      });
      await method(manager, "sendPrompt")(args.prompt, {
        agentId: args.agentId,
        directAddressedAcceptance: args.directAddressedAcceptance,
        attachmentPaths: args.attachmentPaths ?? [],
        attachmentNames: args.attachmentNames ?? [],
        richText: args.richText,
        replyToId: args.replyToId,
        clientNonce: args.clientNonce,
        isFork: args.isFork,
        traceparent: args.traceparent,
        enterEpochMs: args.enterEpochMs,
        composedAtMs: args.composedAtMs,
        awaitTurn: process.env[DISABLE_SEND_ACCEPT_RETURN_ENV] === "1"
      });
      return { accepted: true };
    },
    promptAcceptanceStatus: (args: any) =>
      method(manager, "promptAcceptanceStatus")(args),
    respondToWidget: (args: any) => {
      markActive("user_action");
      method(telemetry.analytics, "trackEvent")("sand.widget.responded", {
        agent_id: args.agentId
      });
      return method(manager, "respondToWidget")(
        args.entryId,
        args.value,
        args.agentId
      );
    },
    resolveAutoReviewApproval: (args: any) => {
      markActive("user_action");
      return method(
        deps.extensions.api("auto-review"),
        "resolveApproval"
      )(args);
    },
    resolveLocalToolPermission: async (args: any) => {
      markActive("user_action");
      await method(localToolPermission, "resolveAsk")(args);
    },
    dismissWidget: (args: any) => {
      markActive("user_action");
      method(telemetry.analytics, "trackEvent")("sand.widget.dismissed", {
        agent_id: args.agentId
      });
      return method(manager, "dismissWidget")(args);
    },
    submitSecret: (args: any) =>
      method(manager, "submitSecret")(
        args.entryId,
        args.value,
        args.agentId
      ),
    reactToMessage: (args: any) => {
      markActive("user_action");
      method(telemetry.analytics, "trackEvent")("sand.reaction.added", {
        agent_id: args.agentId
      });
      return method(manager, "reactToMessage")(
        args.entryId,
        args.emoji,
        args.agentId
      );
    },
    appendConnectorCard: (args: any) =>
      method(manager, "appendConnectorCard")(args),

    listAgents: () => method(manager, "listAgents")(),
    countAgents: () => method(manager, "countAgentsOnDisk")(),
    searchAgents: async (args: any) =>
      await method(deps.extensions.api("content-search"), "isEnabled")()
        ? method(manager, "searchAgents")(args.query, args.limit)
        : [],
    searchMedia: async (args: any) =>
      await method(deps.extensions.api("content-search"), "isEnabled")()
        ? method(manager, "searchMedia")(args.query, args.limit)
        : [],
    createAgent: (args: any) => {
      const nonce = args.clientNonce;
      if (nonce == null || nonce.length === 0) return mintAgent(args);
      const pending = createAgentMintsByNonce.get(nonce);
      if (pending != null) return pending;

      const minted = mintAgent(args);
      createAgentMintsByNonce.set(nonce, minted);
      void minted.catch(() => createAgentMintsByNonce.delete(nonce));
      for (const oldest of createAgentMintsByNonce.keys()) {
        if (createAgentMintsByNonce.size <= CREATE_AGENT_NONCE_LEDGER_CAP) break;
        createAgentMintsByNonce.delete(oldest);
      }
      return minted;
    },
    kickstartAgent: async (args: any) => ({
      isIntroductionInFlight: await deps.kickstartIfPending(args.id)
    }),
    requestDiskSaverAudit: async (args: any) => ({
      isAuditInFlight: await deps.requestDiskSaverAudit(args.id)
    }),
    createGroup: (args: any) => method(manager, "createGroup")({
      name: args.name,
      description: args.description,
      memberIds: args.memberAgentIds
    }),
    setGroupMembers: (args: any) =>
      method(manager, "setGroupMembers")(args.id, args.memberAgentIds),
    updateAgent: (args: any) =>
      method(manager, "updateAgent")(args.id, args.profile),
    deleteAgent: async (args: any) => await removeAgentCompletely(args.id),
    deleteAgents: async (args: any) => {
      for (const id of args.ids) {
        await method(sharing, "noteAgentDeleted")(id);
      }
      const result = await method(manager, "deleteAgents")(args.ids);
      for (const id of args.ids) {
        method(deps.extensions.api("session"), "forgetHandoff")(id);
        await method(automations, "deleteAgentSchedules")(id).catch(
          () => undefined
        );
        await deps.releaseAgentBox(id);
        deps.hostEvents.emit({
          kind: "notification-agent-forgotten",
          agentId: id
        });
        deps.forgetLocalToolPermission(id);
      }
      return result;
    },
    duplicateAgent: (args: any) => method(manager, "cloneAgent")(args.id),
    setAgentUnread: (args: any) =>
      method(manager, "setAgentUnread")(args.id, args.isUnread, args.atMs),
    // Was `async () => undefined`: the command existed, the protocol and coordinator both routed to
    // it, and it did nothing -- any UI bound to it looked like it worked. It is still referenced by
    // gateway-protocol.ts and shared/rpc/coordinator.ts, so it is aliased onto the real control
    // rather than removed.
    setAgentNotificationsEnabled: (args: any) =>
      method(manager, "setAgentNotifyOnUpdates")(args.id, args.isEnabled),
    setAgentNotifyOnUpdates: (args: any) =>
      method(manager, "setAgentNotifyOnUpdates")(args.id, args.isEnabled),
    setAgentHiddenFromSidebar: (args: any) =>
      method(manager, "setAgentHiddenFromSidebar")(args.id, args.isHidden),
    openAgent: (args: any) => openAgent(args, "switchAgent"),
    openAgentWindowed: (args: any) => openAgent(args, "openAgentWindowed"),
    openAgentTail: (args: any) => openAgent(args, "openAgentTail"),
    setWindowFocused: (args: any) =>
      method(manager, "setWindowFocused")(args.isFocused),

    getAgentMemories: (args: any) =>
      method(manager, "getAgentMemories")(args.id),
    deleteAgentMemory: (args: any) =>
      method(manager, "deleteAgentMemory")(args.id, args.memoryId),
    clearAgentMemories: (args: any) =>
      method(manager, "clearAgentMemories")(args.id),
    getAgentAutomations: (args: any) =>
      method(manager, "getAgentAutomations")(args.id),
    listAllAutomations: () => method(manager, "listAllAutomations")(),
    isAgentNetworkEnabled: () =>
      method(deps.extensions.api("experiments"), "isAgentNetworkEnabled")(),
    isGlobalSearchEnabled: () =>
      method(deps.extensions.api("content-search"), "isEnabled")(),
    isEgressTunnelAvailable: async () =>
      process.env.SAND_EGRESS_TUNNEL_ENABLED === "1",

    getSharingState: () => method(sharing, "getSharingState")(),
    createRoomFromAgent: (args: any) =>
      markSharingAction("createRoomFromAgent", args),
    createRoomInvite: (args: any) =>
      markSharingAction("createRoomInvite", args),
    joinSharedRoom: (args: any) => markSharingAction("joinSharedRoom", args),
    respondToRoomJoinRequest: (args: any) =>
      markSharingAction("respondToRoomJoinRequest", args),
    createSharedRoom: (args: any) =>
      markSharingAction("createSharedRoom", args),
    addOwnAgentToSharedRoom: (args: any) =>
      markSharingAction("addOwnAgentToSharedRoom", args),
    removeOwnAgentFromSharedRoom: (args: any) =>
      markSharingAction("removeOwnAgentFromSharedRoom", args),
    setSharedRoomTyping: (args: any) =>
      method(sharing, "setSharedRoomTyping")(args),
    leaveSharedRoom: (args: any) => markSharingAction("leaveSharedRoom", args),

    setAgentAutomationEnabled: (args: any) =>
      method(manager, "setAgentAutomationEnabled")(
        args.id,
        args.automationId,
        args.isEnabled
      ),
    createAgentAutomation: async (args: any) => {
      markActive("user_action");
      const countBefore = (await method(manager, "getAgentAutomations")(
        args.id
      )).length;
      const created = await method(manager, "createAgentAutomation")(
        args.id,
        args.spec
      );
      if (created.length > countBefore) {
        method(telemetry.analytics, "trackEvent")("sand.automation.created", {
          agent_id: args.id,
          trigger_type: args.spec.trigger.type,
          source: "automations_ui"
        });
      }
      return created;
    },
    updateAgentAutomation: (args: any) =>
      method(manager, "updateAgentAutomation")(
        args.id,
        args.automationId,
        args.spec
      ),
    deleteAgentAutomation: (args: any) =>
      method(manager, "deleteAgentAutomation")(args.id, args.automationId),
    runAgentAutomationNow: (args: any) => {
      markActive("user_action");
      return method(manager, "runAgentAutomationNow")(
        args.id,
        args.automationId
      );
    },
    broadcastToAgents: async (args: any) => {
      markActive("user_action");
      const result = await method(manager, "broadcastToAgents")(
        args.targets,
        args.message
      );
      method(telemetry.analytics, "trackEvent")("sand.broadcast.sent", {
        total: result.total,
        scheduled: result.scheduled,
        targets: args.targets === "all" ? "all" : "subset"
      });
      return result;
    },

    getAgentWorkflows: (args: any) =>
      method(manager, "getAgentWorkflows")(args.id),
    createAgentWorkflow: async (args: any) => {
      const isAutomation = args.spec.trigger != null;
      if (isAutomation) markActive("user_action");
      const countBefore = isAutomation
        ? (await method(manager, "getAgentAutomations")(args.id)).length
        : 0;
      const workflows = await method(manager, "createAgentWorkflow")(
        args.id,
        args.spec
      );
      if (isAutomation) {
        const countAfter = (await method(manager, "getAgentAutomations")(
          args.id
        )).length;
        if (countAfter > countBefore) {
          method(telemetry.analytics, "trackEvent")(
            "sand.automation.created",
            {
              agent_id: args.id,
              trigger_type: "cron",
              source: "workflow_ui"
            }
          );
        }
      }
      return workflows;
    },
    updateAgentWorkflow: (args: any) =>
      method(manager, "updateAgentWorkflow")(
        args.id,
        args.workflowId,
        args.spec
      ),
    setAgentWorkflowEnabled: (args: any) =>
      method(manager, "setAgentWorkflowEnabled")(
        args.id,
        args.workflowId,
        args.isEnabled
      ),
    // ownerAgentId null makes the skill global; a non-empty string gives it to that agent.
    setAgentWorkflowOwner: (args: any) =>
      method(manager, "setAgentWorkflowOwner")(
        args.id,
        args.workflowId,
        typeof args.ownerAgentId === "string" && args.ownerAgentId.trim().length > 0
          ? args.ownerAgentId.trim()
          : null
      ),
    deleteAgentWorkflow: (args: any) =>
      method(manager, "deleteAgentWorkflow")(args.id, args.workflowId),
    runAgentWorkflowNow: (args: any) =>
      method(manager, "runAgentWorkflowNow")(args.id, args.workflowId),
    importAgentWorkflowText: (args: any) =>
      method(manager, "importAgentWorkflowMarkdown")(
        args.id,
        args.markdown,
        args.name
      ),
    importAgentWorkflowUrl: (args: any) =>
      method(manager, "importAgentWorkflowUrl")(args.id, args.url, args.name),
    portAgentLocalSkills: (args: any) =>
      method(manager, "portAgentLocalSkills")(args.id),
    getConversationOutline: (args: any) =>
      method(manager, "getConversationOutline")(args.id),
    getAgentEvidence: async (args: any) =>
      readAgentEvidence(String(args.id), {
        ...(args.attemptId == null ? {} : { attemptId: String(args.attemptId) }),
        entries: await (manager as any).sessionStore?.getAgentTranscriptEntries?.(String(args.id)) ?? [],
      }),
    // AUDIT-1. The per-agent action ledger (agents/<id>/audit.jsonl) had no read surface: written
    // on every tool action, forwarded only behind a gate this box never gets, readable by nobody.
    // Newest first, paged by `before` (an eventId from a previous page), bodies never larger than
    // the stored head. Rows are what the evidence layer attested plus the shell/MCP receipts.
    getAgentActionAudit: async (args: any) => {
      const id = String(args.id ?? "");
      if (id.length === 0) return { rows: [], nextBefore: null };
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
      const rows = (await evidenceRegistry.readLedger(id)).reverse();
      const start = args.before == null ? 0 : Math.max(0, rows.findIndex((row) => row.eventId === String(args.before)) + 1);
      const page = rows.slice(start, start + limit);
      const last = page.at(-1);
      return { rows: page, nextBefore: start + limit < rows.length && last != null ? String(last.eventId ?? "") || null : null };
    },

    skillsCatalog: () => method(managedSetup, "skillsCatalog")(),
    syncPluginSkills: () =>
      method(deps.extensions.api("mcp"), "syncPluginSkills")(),
    getPluginSyncStatus: () =>
      method(deps.extensions.api("mcp"), "pluginSyncStatus")(),
    getSkillPublishTargets: () =>
      method(deps.extensions.api("mcp").skillPublish, "listTargets")(),
    publishSkill: (args: any) =>
      method(deps.extensions.api("mcp").skillPublish, "publish")(args),
    resyncPublishedSkill: (args: any) =>
      method(deps.extensions.api("mcp").skillPublish, "resync")(args),
    unpublishSkill: (args: any) =>
      method(deps.extensions.api("mcp").skillPublish, "unpublish")(args),

    getAgentChannels: (args: any) =>
      method(automations, "getAgentChannels")(args.id),
    // CP-12. Same guard as its pair below: the id, the platform and the token were read straight
    // off the body, so a call with no id reached storeConnectorCredential(undefined, ...) and only
    // failed safe by accident, deep inside the store, with nothing said about why.
    connectChannel: async (args: any) => {
      const agentId = typeof args?.id === "string" ? args.id.trim() : "";
      const platform = typeof args?.platform === "string" ? args.platform.trim() : "";
      if (agentId.length === 0) throw new TypeError("connectChannel needs the agent id");
      if (platform.length === 0) throw new TypeError("connectChannel needs a platform");
      if (typeof args?.token !== "string" || args.token.length === 0) {
        throw new TypeError("connectChannel needs a token");
      }
      method(manager, "connectChannel")(agentId, platform, args.token);
      return method(automations, "getAgentChannels")(agentId);
    },
    // CP-12. `disconnectChannel` is per-agent, but the id was read straight off the body: a call
    // with no `id` disconnected against `undefined`, which reads to a caller as an account-wide
    // disconnect nobody asked for. The id is now required, and so is the platform.
    disconnectChannel: async (args: any) => {
      const agentId = typeof args?.id === "string" ? args.id.trim() : "";
      if (agentId.length === 0) throw new TypeError("disconnectChannel needs the agent id");
      const platform = typeof args?.platform === "string" ? args.platform.trim() : "";
      if (platform.length === 0) throw new TypeError("disconnectChannel needs a platform");
      // Trimmed on the way in, like the id: " slack" and "slack" are one platform to a user and
      // must not be two folders to the store.
      method(manager, "disconnectChannel")(agentId, platform);
      return method(automations, "getAgentChannels")(agentId);
    },
    refreshChannel: (args: any) =>
      method(automations, "getAgentChannels")(args.id),
    getListenerIntegrations: () =>
      method(automations, "getListenerIntegrations")(),
    getListenerConnectUrl: async (args: any) => ({
      url: await method(automations, "getListenerConnectUrl")(args.platform)
    }),
    getSubagents: (args: any) => method(manager, "getSubagents")(args.id),
    getAsyncTasks: (args: any) => method(manager, "getAsyncTasks")(args.id),
    setAgentAvatarBytes: (args: any) =>
      method(manager, "setAgentAvatarBytes")(
        args.id,
        args.pngBase64 == null
          ? null
          : Uint8Array.from(Buffer.from(args.pngBase64, "base64"))
      ),
    getAgentAvatar: (args: any) => method(manager, "getAgentAvatar")(args.id),

    getForeverBoxStatus: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "getStatus")(args)
      ),
    getCloudAgentInfo: (args: any) =>
      method(deps.extensions.api("cloud-agents"), "getInfo")(
        args.bcId,
        args.includeFiles
      ),
    // DISPLAY-1: a call with no id once parked a window under the key "undefined" for good.
    ensureForeverBox: async (args: any) =>
      (typeof args?.id !== "string" || args.id.length === 0 ? Promise.reject(new Error("ensureForeverBox requires an agent id"))
      // DISPLAY-2: a page that still held a deleted agent's id kept asking for its desktop, and every ask allocated a fresh window with a token nobody would ever release.
      : (manager as any).sessionStore?.agentExists?.(args.id) === false ? Promise.reject(new Error(`ensureForeverBox: unknown agent ${args.id}`)) :
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "ensure")(args)
      )),
    resetForeverBox: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "reset")(args)
      ),
    updateForeverBox: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "update")(args)
      ),
    autoUpdateBoxNow: () =>
      method(deps.extensions.api("forever-box"), "autoUpdateNow")(),
    snapshotBoxStoreNow: (args: any) =>
      method(deps.extensions.api("box-store-sync"), "snapshotBoxStoreNow")(
        args
      ),
    getBoxStoreStatus: () =>
      method(deps.extensions.api("box-store-sync"), "getBoxStoreStatus")(),
    clearBoxStoreNow: () =>
      method(deps.extensions.api("box-store-sync"), "clearBoxStoreNow")(),
    updateHostNow: (args: any) =>
      method(deps.extensions.api("host-upgrade"), "updateHostNow")(args),
    getHostStatus: async () => ({
      ...method(deps.extensions.api("host-upgrade"), "getVersionState")(),
      isBusy: deps.getHealth().isBusy,
      capabilities: HOST_CAPABILITIES
    }),
    setBoxMigrating: async (args: any) => {
      method(deps.extensions.api("forever-box"), "setMigrating")({
        migrating: args.migrating === true
      });
      return { ok: true };
    },
    prepareBoxForRecreate: async () => {
      await method(automations, "suspendWakes")();
      return await method(manager, "quiesceForRecreate")();
    },
    resumeBoxAfterRecreate: async (args: any) => {
      method(automations, "resumeWakes")();
      await method(sharing, "resumeAfterRecreate")();
      return await method(manager, "resumeAfterRecreate")(
        args.agentIds ?? [],
        args.pendingWakes
      );
    },
    handBackForeverBox: (args: any) =>
      method(deps.extensions.api("session"), "endHandoff")(
        args.id,
        args.trigger ?? "button"
      ),

    startTeachRecording: (args: any) =>
      method(deps.extensions.api("teach-recording"), "start")(args),
    // {agentId, save, note}. The note is the operator's own sentence from the Learn dialog, and it
    // has to arrive here rather than as a later message: the host dispatches the learning turn from
    // inside this call, so anything sent afterwards reaches the agent after it has already started.
    stopTeachRecording: (args: any) =>
      method(deps.extensions.api("teach-recording"), "stop")(args),
    getTeachRecordingStatus: () =>
      method(deps.extensions.api("teach-recording"), "getStatus")(),
    getTrays: () => method(deps.extensions.api("trays"), "list")(),
    dismissTray: (args: any) =>
      method(deps.extensions.api("trays"), "dismiss")(args),
    clearTrays: () => method(deps.extensions.api("trays"), "clearAll")(),

    uploadAttachment: (args: any) => method(attachments, "upload")(args),
    readAttachmentImage: (args: any) => method(attachments, "readImage")(args),
    readAttachmentText: (args: any) => method(attachments, "readText")(args),
    readAttachmentChunk: (args: any) => method(attachments, "readChunk")(args),
    getHostSettings: () => method(settings, "getHostSettings")(),
    setHostSettings: (args: any) => {
      const result = method(settings, "setHostSettings")(args);
      if (args.localToolPermission !== undefined) {
        method(localToolPermission, "notePermissionChanged")();
      }
      if (args.webauthnProxyEnabled !== undefined) {
        method(deps.extensions.api("webauthn-proxy"), "applyEnablement")(
          args.webauthnProxyEnabled
        );
      }
      return result;
    },

    refreshMcp: async ({ completion, routedAction, routedArgs }: any) => {
      if (routedAction === "list-tools") return await listRoutedMcpTools();
      if (routedAction === "execute-tool") return await executeRoutedMcpTool(routedArgs);
      if (completion != null) {
        await deps.handleDesktopMcpAuthCompletion(completion);
        return;
      }
      await method(deps.extensions.api("mcp").management, "restart")();
    },
    listRoutedMcpTools,
    executeRoutedMcpTool,
    listBoxMcpServers: async ({ serverIdentifiers }: any) => {
      const servers = await method(
        deps.extensions.api("mcp"),
        "listBoxServers"
      )(serverIdentifiers);
      return {
        servers: servers.map((server: any) => ({
          serverIdentifier: server.serverIdentifier,
          status: server.status,
          ...(server.statusDetail == null
            ? {}
            : { statusDetail: server.statusDetail }),
          toolCount: server.toolCount
        }))
      };
    },
    // Wave D1 connector plane. Every one of these forwards to a method the Electron IPC already
    // called; only the gateway lacked a door. CP-07's numeric ids are what make the id-keyed ones
    // work for the connectors that actually run on this box.
    listInstalledMcpServers: async () =>
      // Ids are numbers on the wire (the dashboard and its fixtures key on that); the store keeps strings.
      ((await method(deps.extensions.api("mcp").management, "listInstalled")()) ?? []).map((row: any) =>
        row != null && typeof row === "object" && typeof row.id === "string" && /^[1-9]\d*$/.test(row.id) ? { ...row, id: Number(row.id) } : row),
    listMcpPlugins: () => method(deps.extensions.api("mcp").management, "listPlugins")(),
    getMcpPlugin: (args: any) =>
      method(deps.extensions.api("mcp").management, "getPlugin")(
        typeof args?.id === "string" ? args.id : args?.pluginId
      ),
    listMcpServerTools: (args: any) => {
      const serverId = args?.serverId ?? args?.id;
      if (typeof serverId !== "string" && typeof serverId !== "number") {
        throw new TypeError("listMcpServerTools needs serverId");
      }
      return method(deps.extensions.api("mcp").management, "listServerTools")(String(serverId));
    },
    toggleMcpToolDisabled: (args: any) => {
      const serverId = args?.serverId ?? args?.id;
      if (typeof serverId !== "string" && typeof serverId !== "number") {
        throw new TypeError("toggleMcpToolDisabled needs serverId");
      }
      if (typeof args?.toolName !== "string" || args.toolName.length === 0) {
        throw new TypeError("toggleMcpToolDisabled needs toolName");
      }
      return method(deps.extensions.api("mcp").management, "setToolDisabled")({
        serverId: String(serverId),
        toolName: args.toolName,
        ...(args.disabled === undefined ? {} : { disabled: args.disabled === true })
      });
    },
    listConnectorSecretFields: (args: any) =>
      method(deps.extensions.api("mcp").management, "listConnectorSecretFields")(
        args?.server ?? args?.serverId
      ),
    setConnectorSecret: (args: any) =>
      method(deps.extensions.api("mcp").management, "setConnectorSecret")({
        server: args?.server ?? args?.serverId,
        field: args?.field,
        value: args?.value
      }),
    deleteConnectorSecret: (args: any) =>
      method(deps.extensions.api("mcp").management, "deleteConnectorSecret")({
        server: args?.server ?? args?.serverId,
        field: args?.field
      }),

    // ------------------------------------------------------------------ MARKET-1, the catalog
    // The Marketplace catalog is bundled into this host, so these two are pure reads with no box,
    // no network and no account behind them: the console draws its Plugins and Bots tabs from
    // exactly the data the agent's SearchPlugins resolves against. Nothing here is per-install
    // state -- "installed", "needs auth" and "ready" come from the connector commands above.
    listMarketplace: () => MARKETPLACE_CATALOG,
    getMarketplaceItem: (args: any) => {
      const kind = typeof args?.kind === "string" ? args.kind : "";
      const id = args?.id;
      if (kind === "plugin") {
        const plugin = findMarketplacePlugin(id);
        if (plugin == null) throw new Error(`no marketplace plugin "${String(id)}"`);
        return plugin;
      }
      if (kind === "bot") {
        const bot = findMarketplaceBot(id);
        if (bot == null) throw new Error(`no marketplace bot "${String(id)}"`);
        return bot;
      }
      throw new TypeError(`getMarketplaceItem needs kind "plugin" or "bot", not "${kind}"`);
    },

    // --------------------------------------------------------------- JOBBUS, the Titan Job Bus
    // The whole of the relay's /v1 surface (docs/JOB-BUS.md section 3). Every refusal is a
    // GatewayCommandError carrying its own status and body, so the relay passes 400/404/409/503
    // through with the shape the contract prints instead of flattening them into a 500.
    // Section 10.6: `version` is the JOB API's version and is a constant, `host_version` is this
    // bundle's. They were one field, which meant a CoS pinned to the API was reading the host's
    // release number and would have broken on an unrelated host upgrade.
    // Section 10.2 stores an agent ID in `workers`; section 3 renders this map with the worker's
    // NAME ({"nextgen.chapter":"Scribe"}). Health resolves the stored value back through the roster
    // so both hold: the id is this box's internal handle, and the name is what CoS was told to
    // expect. A value that names no agent here is already a name and is passed through.
    jobBusHealth: async () => {
      const roster = method(manager, "listAgentsSync")();
      const workers = Object.fromEntries(
        Object.entries(jobSettings.read().workers).map(([type, worker]) => {
          const agent = roster.find((candidate: any) => candidate?.id === worker);
          return [type, typeof agent?.name === "string" && agent.name.length > 0 ? agent.name : worker];
        }),
      );
      const integrity = await jobBusIntegrity();
      return {
        ok: true,
        queue_depth: await jobStore.queueDepth(),
        version: JOB_BUS_API_VERSION,
        host_version: hostPackageVersion(),
        workers,
        // Additive to section 10.6's shape: CoS learns from health, not from a refused create, that
        // this box quarantined a file and is therefore answering 503 to everything.
        integrity: { ok: integrity.ok, detail: integrity.detail },
      };
    },
    // `created` says 201 or 200 to the relay; the job itself is the body either way. Every field is
    // forwarded verbatim, unknown ones included, because section 10.1's refusal of an unknown field
    // is the store's to make: dropping it here would answer 201 to a body the bus never read.
    jobBusCreate: async (args: any) => {
      await requireJobBusEnabled();
      const created = await jobStore.create({ ...(args ?? {}) });
      // A new job should not wait up to a poll interval to start moving.
      if (created.created) void jobWorker.tick().catch(() => {});
      return created;
    },
    jobBusGet: async (args: any) => await requireJob(args),
    jobBusCancel: async (args: any) => {
      await requireJob(args);
      const job = await jobWorker.cancel(String(args?.id ?? ""));
      return { id: job.id, status: job.status };
    },
    jobBusArtifacts: async (args: any) => {
      const job = await requireJob(args);
      if (job.status !== "done") {
        throw new GatewayCommandError(409, { error: `job is ${job.status}, not done`, id: job.id, status: job.status });
      }
      const repo = typeof job.payload.repo === "string" ? job.payload.repo : null;
      const commits = job.result?.commits ?? [];
      // Section 10.6: no signed URLs in v1. The two links are where the file IS, at the commit the
      // job attested, so CoS pulls it with its own GitHub credential rather than one this bus mints.
      const ref = commits[commits.length - 1] ?? null;
      const link = (path: string, kind: "html" | "api"): string | null => {
        if (repo == null || ref == null) return null;
        const encoded = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
        return kind === "html"
          ? `https://github.com/${repo}/blob/${ref}/${encoded}`
          : `https://api.github.com/repos/${repo}/contents/${encoded}?ref=${ref}`;
      };
      return {
        id: job.id,
        status: job.status,
        pull_from: repo == null ? null : "github",
        repo,
        branch: typeof job.payload.branch === "string" ? job.payload.branch : null,
        commits,
        artifacts: (job.result?.artifacts ?? []).map((artifact) => ({
          path: artifact.path,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          html_url: link(artifact.path, "html"),
          api_url: link(artifact.path, "api"),
        })),
      };
    },
    jobBusList: async (args: any) => ({ jobs: await jobStore.list(args?.limit) }),
    // Section 10.5. The relay's bearer lockout is not a job, but "who was locked out, from where,
    // and when" belongs in the same hash chain as everything else this bus did.
    jobBusAudit: async (args: any) => {
      if (args?.event !== "auth_locked") {
        throw new GatewayCommandError(400, { error: "jobBusAudit only writes auth_locked rows" });
      }
      return await jobStore.appendExternalAudit({ event: "auth_locked", client: args?.client, ok: args?.ok });
    },
    // Section 10.7. The bus reads its own settings file, not sand-host-settings.json, and the file
    // is re-read on every use so an edit lands without a restart.
    // The card draws the settings and, beside them, whether the host trusted the files it read.
    // `jobBusSetSettings` refuses unknown keys, so this extra field is read-only by construction.
    jobBusGetSettings: async () => ({ ...jobSettings.read(), integrity: await jobBusIntegrity() }),
    jobBusSetSettings: async (args: any) => await jobSettings.write(args ?? {}),

    // ---------------------------------------------------------------- CONNECT-5, shell tools
    // A shell tool is a CLI the agent runs itself, with its credential in the environment.
    // CodeRabbit has no MCP server to hang a credential on (docs/connectors/coderabbit.md) and the
    // operator's cli-anything-tinyfish is the same shape, so this is the connector credential card
    // one layer down: same 0600 store file, same env-name guard, a different destination.
    // MARKET-1: `installed` and `stored` are two different facts and both are answered here.
    // `installed` is `command -v <binary>` in the box's own shell -- nothing records a shell-tool
    // install, so the shell is the only authority -- and `stored` is whether the 0600 store holds
    // the key. A key with no program is a command that does not exist; a program with no key is a
    // tool the operator would otherwise be told to install twice.
    listShellTools: async () => {
      const stored = new Set(listShellEnvSecretFields(shellRoot()));
      return Promise.all(SHELL_TOOLS.map(async (tool) => ({
        id: tool.id,
        name: tool.name,
        field: tool.field,
        install: tool.install,
        usage: tool.usage,
        credentialNote: tool.credentialNote,
        ...(tool.skillUrl == null ? {} : { skillUrl: tool.skillUrl }),
        installed: await probeShellToolBinary(tool),
        stored: stored.has(tool.field)
      })));
    },
    // Names only, from both lists, for the same reason listConnectorSecretFields answers two:
    // `fields` is what a value may be stored under, `stored` is what the 0600 store holds.
    listShellSecretFields: () => shellSecretsSnapshot(),
    setShellSecret: async (args: any) => {
      const field = requireShellField(args?.field, "setShellSecret");
      if (typeof args?.value !== "string" || args.value.length === 0) {
        throw new Error("setShellSecret needs a non-empty `value`");
      }
      if (!writeShellEnvSecret(shellRoot(), field, args.value)) {
        throw new Error("the shell secret store could not be written");
      }
      // `stored` is the boolean that says the write landed, as it is on setConnectorSecret; the
      // delete answer below is the one that carries the store's name list.
      return { field, stored: true, applied: await pushShellSecretsToBox(), fields: shellSecretsSnapshot().fields };
    },
    deleteShellSecret: async (args: any) => {
      const field = requireStoredShellField(args?.field, "deleteShellSecret");
      const removed = deleteShellEnvSecret(shellRoot(), field);
      // The box control plane can set but not unset, so a delete pushes the empty string: the
      // shell's own `${VAR:+...}` reads that as unset, and the next box restart drops it for real.
      return { field, removed, applied: removed ? await pushShellSecretsToBox([field]) : false, ...shellSecretsSnapshot() };
    },
    /**
     * Does the BOX have this credential? Asked of the box's own shell -- the exec-daemon that
     * spawns every `/bin/sh -lc` the agent's shell tool runs -- so the answer is about the process
     * that will actually run `cr`, not about the host's store. The command prints a marker; the
     * value is never in the command, never in the output, and never in this answer.
     */
    probeShellSecret: async (args: any) => {
      const field = requireStoredShellField(args?.field, "probeShellSecret");
      const box = deps.extensions.api("forever-box").box;
      if (box == null || typeof box.mcpResourceAccessor !== "function") {
        throw new Error("this box exposes no shell to probe");
      }
      const accessor = await box.mcpResourceAccessor(shellCtx);
      const answer = await accessor.get(shellExecutorResource).execute(shellCtx, buildHostShellArgs({
        command: shellSecretProbeCommand(field),
        name: "sh",
        workingDirectory: "/workspace",
        toolCallId: "sand-shell-secret-probe"
      }));
      const result = answer.result;
      if (result.case !== "success") throw new Error(`the box shell did not answer (${result.case})`);
      return { field, state: readShellSecretProbe(result.value.stdout) };
    },
    installShellTool: async (args: any) => {
      const entry = requireShellTool(args?.id);
      const result = await runShellToolInstall(entry, { rootDir: shellRoot() });
      // `agentId` is the contract's optional second half: install the tool AND teach the agent the
      // tool's own published skill, so one click leaves an agent that can use what was installed.
      // A skill that could not be fetched does not turn a successful install into a failed command
      // -- the install happened, and `taught` is how the answer says the second half did not.
      let taught = false;
      if (result.ok && entry.skillUrl != null && typeof args?.agentId === "string" && args.agentId.length > 0) {
        try {
          await method(manager, "importAgentWorkflowMarkdown")(args.agentId, await fetchShellToolSkill(entry), entry.name);
          taught = true;
        } catch { taught = false; }
      }
      return { ...result, taught };
    },
    teachShellTool: async (args: any) => {
      const entry = requireShellTool(args?.id);
      if (typeof args?.agentId !== "string" || args.agentId.length === 0) {
        throw new Error("teachShellTool needs an `agentId`; a skill is imported for one agent");
      }
      // The host fetches, not the console: raw.githubusercontent.com answers no browser
      // cross-origin, and importAgentWorkflowText is the command that takes markdown.
      const markdown = await fetchShellToolSkill(entry);
      const workflows = await method(manager, "importAgentWorkflowMarkdown")(args.agentId, markdown, entry.name);
      return { id: entry.id, agentId: args.agentId, name: entry.name, workflows };
    },
    completeMcpOAuth: async (args: any) => {
      const stateId = typeof args?.stateId === "string" ? args.stateId : "";
      const code = typeof args?.code === "string" ? args.code : args?.authorizationCode;
      if (stateId.length === 0 || typeof code !== "string" || code.length === 0) {
        throw new TypeError("completeMcpOAuth needs stateId and code");
      }
      await method(deps.extensions.api("mcp"), "completeOAuth")({ stateId, code });
      return undefined;
    },
    requestWebAuthnCeremony: (args: any) =>
      method(deps.extensions.api("webauthn-proxy"), "requestCeremony")(args),
    setBoxSecrets: ({ secrets }: any) =>
      method(deps.extensions.api("secrets"), "set")({ secrets }),
    getBoxSecretsStatus: () =>
      method(deps.extensions.api("secrets"), "getStatus")()
  };
}
