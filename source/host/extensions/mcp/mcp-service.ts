import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import {
  createAccountMcpWriter,
  fetchAccountMcpServers,
  fetchEffectiveUserPlugins,
  type AccountMcpClient,
  type AccountMcpDependencies,
} from "../../../shared/node/cursor-backend/account-mcp.js";
import {
  createDashboardSandBackendMcpExec,
  type DashboardMcpExecClient,
} from "../../../shared/node/cursor-backend/backend-mcp-exec.js";
import {
  createSandCursorBackendClient,
  getSandInferenceBackendUrl,
} from "../../../shared/node/cursor-backend/cursor-inference.js";
import { SandMcpManager } from "../../../shared/node/mcp/mcp-manager.js";
import {
  createMcpToolsDiscovery,
  SandMcpExecutor,
} from "../../../shared/node/mcp/tools-discovery.js";
import type { CapableBox } from "../../box/box-capabilities.js";
import { createSandMcpStateExecutor } from "../../ports/mcp-state-executor.js";
import { createBoxSandMcpExec } from "./box-mcp-exec.js";
import { getSandRootDir } from "../../host-paths.js";
import {
  assignLocalConnectorIds,
  LOCAL_CONNECTORS_FILENAME,
  listRefusedLocalConnectors,
  localConnectorIdForName,
  mergeLocalConnectors,
  readLocalConnectorFile,
} from "./local-connectors.js";
import {
  getMarketplacePluginDetail,
  installMarketplacePlugin,
  listMarketplacePluginSummaries,
  uninstallMarketplacePlugin,
} from "./marketplace-plugins.js";
import {
  assertConnectorCredentialField,
  deleteConnectorEnvSecret,
  isConnectorEnvFieldName,
  listConnectorCredentialFields,
  listConnectorEnvSecretFields,
  readConnectorEnvSecrets,
  writeConnectorEnvSecret,
} from "./connector-secrets.js";

export interface McpServerSummary { id: string; name: string; serverIdentifier: string; accountKey: string; pluginId?: string | null; isTeamServer: boolean; status: string; statusDetail?: string; transport: string; toolCount: number; disabledToolCount?: number; customInstructions: string }
export interface CatalogField { key: string; label: string; hint: string; isRequired?: boolean; isSecret?: boolean }
export interface CatalogPlugin { id: string; name: string; displayName?: string; description?: string; category?: string; fields?: CatalogField[]; connectors?: unknown[]; skills?: Array<{ name: string; description?: string; sourceUrl?: string }> }
export interface EffectivePlugin { pluginId: string; installMode?: string; isEnabled: boolean; hasTeamConfiguredVariables?: boolean }
export interface ServerState { servers: McpServerSummary[] }
export interface PluginSkillsPort { sync(trigger: string): Promise<unknown[]>; status(): unknown; removeLiveReferences?(sourceUrls: readonly string[]): void }

export function toInstalledServer(summary: McpServerSummary): Record<string, unknown> { return { id: summary.id, name: summary.name, serverIdentifier: summary.serverIdentifier, accountKey: summary.accountKey, ...(summary.pluginId == null ? {} : { pluginId: summary.pluginId }), isTeamServer: summary.isTeamServer, status: summary.status, ...(summary.statusDetail == null ? {} : { statusDetail: summary.statusDetail }), transport: summary.transport, toolCount: summary.toolCount, ...(summary.disabledToolCount == null ? {} : { disabledToolCount: summary.disabledToolCount }), customInstructions: summary.customInstructions }; }
export function toInstalledServers(state: ServerState): Record<string, unknown>[] { return state.servers.map(toInstalledServer); }
export function toAuthResult(result: { status: string; serverName: string; authorizationUrl?: string; message?: string }): Record<string, unknown> { if (result.status === "started") return { kind: "started", authorizationUrl: result.authorizationUrl, serverName: result.serverName }; if (result.status === "already-authenticated") return { kind: "already-authenticated", serverName: result.serverName }; if (result.status === "not-configured") return { kind: "not-configured", serverName: result.serverName }; return { kind: result.status, message: result.message, serverName: result.serverName }; }

export interface CreateHostMcpOptions {
  accountConfigProvider?: () => Promise<unknown>;
  accountDisplayConfigProvider?: () => Promise<unknown>;
  accountServersProvider?: () => Promise<unknown>;
  accountMcpWriter?: unknown;
  backendMcpExec: unknown;
  settingsStore?: unknown;
  effectivePluginsProvider?: () => Promise<unknown>;
  boxMcpExec?: unknown;
  getMachineId: () => Promise<string>;
  onServersMutated?: () => void;
  onServerAuthenticated?: (completion: unknown) => void;
  onDiscoveryFailed?: (event: Record<string, unknown>) => void;
  onConnectorAuth?: (event: Record<string, unknown>) => void;
  log?: (message: string) => void;
}
interface McpManagerRuntime {
  listServers(): Promise<ServerState>;
  listConnectedBackendTools(): Promise<unknown[]>;
  getCatalog(getAccessToken: () => Promise<string | null>, options?: { forceRefresh?: boolean }): Promise<CatalogPlugin[]>;
  listEffectivePlugins(): Promise<EffectivePlugin[]>;
  uninstallPlugin(id: string): Promise<{ removed: boolean; reason?: string }>;
  setServerCustomInstructions(args: { serverId: string; instructions: string }): Promise<ServerState>;
  listServerTools(serverId: string): Promise<Array<{ name: string; title?: string; description?: string; isDisabled: boolean }>>;
  toggleMcpToolDisabled(args: { serverId: string; toolName: string }): Promise<Array<{ name: string; title?: string; description?: string; isDisabled: boolean }>>;
  installEntry(args: { entryId: string; values?: Record<string, string> }, getAccessToken: () => Promise<string | null>): Promise<ServerState>;
  addServer(args: { name: string; configJson: string }): Promise<ServerState>;
  removeServer(id: string): Promise<{ removed: boolean; reason?: string; state: ServerState }>;
  reloadServers(): Promise<ServerState>;
  authenticateServer(serverId: string, accountKey: string, requestingAgentId: string | null, forceReauth?: boolean): Promise<{ status: string; serverName: string; authorizationUrl?: string; message?: string }>;
  logoutAccount(serverId: string, accountKey: string): Promise<ServerState>;
  renameAccount(serverId: string, accountKey: string, newAccountKey: string): Promise<ServerState>;
  removeAccount(serverId: string, accountKey: string): Promise<ServerState>;
  getMcpCustomInstructions(): Promise<string>;
  refreshAccountConfigInBackground(): void;
  noteAuthCompletedElsewhere(serverId: string, accountKey: string): void;
  setAuthCompletionObserver(observer: (completion: unknown) => void): void;
  setSettingsStore(settings: unknown): void;
  setBoxRuntime(runtime: unknown): void;
  definitionSourceView(): unknown;
  lastAccountDisplayConfigView(): unknown;
  settingsStoreView(): unknown;
  dispose(): void | Promise<void>;
}
export function createHostMcp(deps: CreateHostMcpOptions): McpHostPort {
  const log = deps.log ?? ((message: string) => console.log(`[sand:mcp] ${message}`));
  const manager = new SandMcpManager({
    includeBuiltins: false,
    accountConfigProvider: deps.accountConfigProvider,
    accountDisplayConfigProvider: deps.accountDisplayConfigProvider,
    accountServersProvider: deps.accountServersProvider,
    accountMcpWriter: deps.accountMcpWriter,
    backendMcpExec: deps.backendMcpExec,
    settingsStore: deps.settingsStore,
    effectivePluginsProvider: deps.effectivePluginsProvider,
    onConnectorAuth: deps.onConnectorAuth,
    getMachineId: deps.getMachineId,
  }) as unknown as McpManagerRuntime;
  const discovery = createMcpToolsDiscovery({
    definitionSource: manager.definitionSourceView(),
    lastAccountDisplayConfig: () => manager.lastAccountDisplayConfigView(),
    settingsStore: () => manager.settingsStoreView(),
    backendMcpExec: deps.backendMcpExec,
  }, {
    ...(deps.boxMcpExec === undefined ? {} : { boxMcpExec: deps.boxMcpExec }),
    ...(deps.onDiscoveryFailed === undefined ? {} : { onDiscoveryFailed: deps.onDiscoveryFailed }),
    ...(deps.onConnectorAuth === undefined ? {} : { onConnectorAuth: deps.onConnectorAuth }),
  });
  manager.setBoxRuntime(discovery);
  if (deps.onServerAuthenticated != null) manager.setAuthCompletionObserver(deps.onServerAuthenticated);
  const mutate = async <T>(fn: () => Promise<T>): Promise<T> => { const result = await fn(); deps.onServersMutated?.(); return result; };
  // CP-05 wrapped `getCatalog` because it rethrows when the Cursor marketplace read fails, and on
  // this box it always fails: there is no usable Cursor account, so SearchPlugins could only ever
  // say "the plugin catalog is empty or unavailable right now". MARKET-1 removes the read instead
  // of softening it -- the plugin surface is the local Marketplace catalog (marketplace-plugins.ts,
  // source/shared/marketplace/catalog.ts), which is on the box and cannot be unreachable.
  const localConnectorRoot = () => getSandRootDir();
  const marketplaceReader = { rootDir: localConnectorRoot };
  /**
   * Accepts either the human connector name or the numeric id CP-07 mints for it. `caller` names
   * the command in the error, because three commands share this and being told to fix the
   * arguments of one you never called is its own small lie. `readOnly` keeps a membership question
   * (isLocalConnector) from minting and persisting ids as a side effect of asking.
   */
  const resolveLocalConnector = (server: unknown, caller: string, readOnly = false): { name: string; id: string } => {
    const wanted = typeof server === "string" ? server.trim() : typeof server === "number" ? String(server) : "";
    if (wanted.length === 0) throw new Error(`${caller} needs a server name or id`);
    const root = localConnectorRoot();
    const configured = readLocalConnectorFile(root);
    // `configured` is a plain object, so a membership test by truthiness answers yes for
    // "constructor", "toString" and every other Object.prototype key -- which then routed a
    // submitted secret at a connector that does not exist, with an undefined id.
    const ids = assignLocalConnectorIds(root, Object.keys(configured), { readOnly, log });
    const name = Object.hasOwn(configured, wanted)
      ? wanted
      : Object.keys(configured).find((candidate) => ids[candidate] === wanted);
    if (name == null) throw new Error(`no connector named or numbered "${wanted}" in ${LOCAL_CONNECTORS_FILENAME}`);
    const id = ids[name];
    if (id === undefined) throw new Error(`connector "${name}" has no id in ${LOCAL_CONNECTORS_FILENAME}`);
    return { name, id };
  };
  /**
   * CP-10. Stopping the server and letting the next discovery spawn it is what makes the injected
   * env actually take: `loadServers` carries removeMissing, so a push that omits the server stops
   * it, and the push that follows starts it from the freshly merged spawn spec.
   */
  const restartLocalConnector = async (name: string): Promise<boolean> => {
    const boxExec = deps.boxMcpExec as { loadServers(configJson: string): Promise<void> } | undefined;
    if (boxExec == null) return false;
    try {
      // Inside the try: the value is already on disk by the time this runs, so a reload failure is
      // "stored but not restarted", never a rejection that unwinds the caller's whole turn.
      await mutate(() => manager.reloadServers());
      const stdio = await (manager.definitionSourceView() as { getStdioServerConfigs(): Promise<Record<string, unknown>> }).getStdioServerConfigs();
      const { [name]: _stopped, ...others } = stdio;
      await boxExec.loadServers(JSON.stringify({ mcpServers: others }));
      discovery.resetPushState();
      await discovery.getTools({});
      return true;
      // Class only, never the message: the failing leg's argument is the merged connector config,
      // env and all, and an error that echoes its input would write the secret into a host log
      // that is neither 0600 nor unread.
    } catch (error) { log(`connector restart failed for ${name}: ${error instanceof Error ? error.name : typeof error}`); return false; }
  };
  const management = {
    // SECRET-2: a connectors.json entry this host refuses to run appears here with the reason,
    // rather than vanishing from the listing and leaving the operator to guess why their connector
    // never turned up. It carries no tools and can never connect: refused is its whole story.
    listInstalled: async () => [
      ...toInstalledServers(await manager.listServers()),
      ...listRefusedLocalConnectors(localConnectorRoot()).map(({ name, reason }) => ({
        id: String(localConnectorIdForName(name)), name, serverIdentifier: name, accountKey: null,
        isTeamServer: false, status: "refused", statusDetail: reason, transport: "stdio",
        toolCount: 0, customInstructions: null,
      })),
    ],
    // MARKET-1. The plugin surface is the local Marketplace catalog, not Cursor's marketplace:
    // `readCatalog` still exists for the Cursor-attributed servers below, but nothing the agent
    // searches, installs or uninstalls goes through it any more. See marketplace-plugins.ts.
    listPlugins: async () => listMarketplacePluginSummaries(marketplaceReader),
    listServerTools: async (serverId: string) => (await manager.listServerTools(serverId)).map((tool) => ({ ...tool, enabled: tool.isDisabled !== true })),
    /**
     * CP-08. The shared method is a pure toggle; the gateway command carries a desired state, so
     * the desired state is resolved here and the toggle fires only when it would change something.
     */
    setToolDisabled: async (args: { serverId: string; toolName: string; disabled?: boolean }) => {
      const before = await manager.listServerTools(args.serverId);
      const current = before.find((tool) => tool.name === args.toolName);
      if (current == null) throw new Error(`MCP server ${args.serverId} has no tool "${args.toolName}".`);
      const wanted = args.disabled === undefined ? current.isDisabled !== true : args.disabled === true;
      const after = wanted === (current.isDisabled === true)
        ? before
        : await mutate(() => manager.toggleMcpToolDisabled({ serverId: args.serverId, toolName: args.toolName }));
      return after.map((tool) => ({ ...tool, enabled: tool.isDisabled !== true }));
    },
    /** Does this name (or numeric id) belong to a local stdio connector on this box? */
    isLocalConnector: (server: unknown) => { try { resolveLocalConnector(server, "isLocalConnector", true); return true; } catch { return false; } },
    /**
     * CONNECT-4. `fields` is the union of what is stored and what the entry in connectors.json
     * leaves empty, because the card draws its "Enter securely" rows from exactly this list and
     * the host is the authority on which env keys are credentials.
     *
     * `stored` is the narrower answer to the other question the card asks: which of those names
     * does the 0600 store actually HOLD a value for. They were one list before the union landed,
     * and a card reading the union for both told the operator "the host holds a value" about a
     * freshly declared, empty credential field -- on the very card the TinyFish preset exists to
     * get a key into. Names only, from both: no value leaves this module.
     */
    listConnectorSecretFields: (server: unknown) => {
      const { name, id } = resolveLocalConnector(server, "listConnectorSecretFields");
      const root = localConnectorRoot();
      return { server: name, serverId: id, fields: listConnectorCredentialFields(root, name), stored: listConnectorEnvSecretFields(root, name) };
    },
    setConnectorSecret: async (args: { server: unknown; field: unknown; value: unknown }) => {
      const { name, id } = resolveLocalConnector(args.server, "setConnectorSecret");
      if (!isConnectorEnvFieldName(args.field)) throw new Error("setConnectorSecret needs an environment variable name as `field` (process-control names such as PATH, NODE_OPTIONS and LD_* are refused)");
      if (typeof args.value !== "string" || args.value.length === 0) throw new Error("setConnectorSecret needs a non-empty `value`");
      // CONNECT-4. A configuration key is not a credential. MCP_REMOTE_CONFIG_DIR -- a directory
      // path the operator wrote into the entry themselves -- was offered as "Enter securely" and
      // swallowed a pasted API key, leaving the connector with a config dir named after the key and
      // no credential at all. Only a field the entry leaves EMPTY (or one already stored) is one.
      assertConnectorCredentialField(localConnectorRoot(), name, args.field);
      if (!writeConnectorEnvSecret(localConnectorRoot(), name, args.field, args.value)) throw new Error("the connector secret store could not be written");
      const restarted = await restartLocalConnector(name);
      return { server: name, serverId: id, field: args.field, stored: true, restarted, fields: listConnectorCredentialFields(localConnectorRoot(), name) };
    },
    deleteConnectorSecret: async (args: { server: unknown; field: unknown }) => {
      const { name, id } = resolveLocalConnector(args.server, "deleteConnectorSecret");
      if (!isConnectorEnvFieldName(args.field)) throw new Error("deleteConnectorSecret needs an environment variable name as `field`");
      const removed = deleteConnectorEnvSecret(localConnectorRoot(), name, args.field);
      const restarted = removed ? await restartLocalConnector(name) : false;
      // Deleting is not gated by the rule: a stored field is a credential by definition, and a
      // value stored before the rule landed must stay removable. The field list is the union, so a
      // credential the entry still declares empty stays on the card with nothing stored behind it.
      // `stored` beside `fields` here for the same reason as the list command: after a delete the
      // field is still offered and nothing is held, and only the second list can say so. (The set
      // answer carries no such list: its `stored` is the boolean that says the write landed.)
      return { server: name, serverId: id, field: args.field, removed, restarted, fields: listConnectorCredentialFields(localConnectorRoot(), name), stored: listConnectorEnvSecretFields(localConnectorRoot(), name) };
    },
    getPlugin: async (pluginId: string) =>
      getMarketplacePluginDetail(marketplaceReader, pluginId, toInstalledServers(await manager.listServers())),
    /**
     * Removing the entry from connectors.json is the whole uninstall; the reload is what stops the
     * process. The 0600 secret store is left alone deliberately -- clearing a credential is its own
     * console action (`deleteConnectorSecret`), so an uninstall never silently destroys a key the
     * operator would have to mint again.
     */
    uninstallPlugin: async (pluginId: string) => {
      const outcome = uninstallMarketplacePlugin(marketplaceReader, pluginId);
      if (outcome == null) return { removed: false, reason: `no marketplace plugin "${pluginId}"` };
      if (outcome.removed) await mutate(() => manager.reloadServers());
      return { removed: outcome.removed, ...(outcome.reason == null ? {} : { reason: outcome.reason }), storedFields: outcome.storedFields };
    },
    setInstructions: async (args: { serverId: string; instructions: string }) => toInstalledServers(await mutate(() => manager.setServerCustomInstructions(args))),
    /**
     * `values` is accepted and ignored on purpose: a credential typed into a conversation is in the
     * transcript, the model's context and whatever window that was compacted into, so the model
     * cannot set a key here. The answer names the fields the operator has to fill on the plugin
     * page instead.
     */
    install: async (args: { id: string; values?: Record<string, string> }) => {
      const outcome = await installMarketplacePlugin(marketplaceReader, args.id);
      if (outcome == null) throw new Error(`no marketplace plugin "${args.id}"`);
      // Only a connector install changes what the box should be running. A shell tool installs a
      // program into the agent's shell and puts nothing in connectors.json, so reloading the MCP
      // servers after one would be a restart nothing asked for.
      if (outcome.kind === "connector" && outcome.installed && outcome.refused == null) {
        await mutate(() => manager.reloadServers());
      }
      return outcome;
    },
    add: async (args: { name: string; configJson: string }) => toInstalledServers(await mutate(() => manager.addServer(args))),
    removeServer: async (serverId: string) => { const result = await mutate(() => manager.removeServer(serverId)); return { removed: result.removed, ...(result.reason == null ? {} : { reason: result.reason }), servers: toInstalledServers(result.state) }; },
    restart: async () => toInstalledServers(await mutate(() => manager.reloadServers())),
    authenticate: async (serverId: string, accountKey: string, requestingAgentId?: string, forceReauth?: boolean) => { const result = toAuthResult(await manager.authenticateServer(serverId, accountKey, requestingAgentId ?? null, forceReauth)); if (result.kind === "started") deps.onServersMutated?.(); return result; },
    logoutAccount: async ({ serverId, accountKey }: { serverId: string; accountKey: string }) => toInstalledServers(await mutate(() => manager.logoutAccount(serverId, accountKey))),
    renameAccount: async ({ serverId, accountKey, newAccountKey }: { serverId: string; accountKey: string; newAccountKey: string }) => toInstalledServers(await mutate(() => manager.renameAccount(serverId, accountKey, newAccountKey))),
    removeAccount: async ({ serverId, accountKey }: { serverId: string; accountKey: string }) => toInstalledServers(await mutate(() => manager.removeAccount(serverId, accountKey)))
  };
  return {
    mcp: { getTools: (ctx: unknown) => discovery.getToolsForTurnStart(ctx), listTools: async (ctx: unknown) => { const connected = await manager.listConnectedBackendTools(), discovered = await discovery.getTools(ctx), byName = new Map<string, any>(); for (const tool of [...connected, ...discovered] as any[]) if (!byName.has(tool.name)) byName.set(tool.name, tool); return [...byName.values()]; }, createExecutor: (persistImage: unknown, spillLargeText: unknown, auditIdentity: unknown) => new SandMcpExecutor(discovery, persistImage, spillLargeText, auditIdentity), refreshAccountConfig: () => manager.refreshAccountConfigInBackground(), createStateExecutor: () => createSandMcpStateExecutor({ getTools: (ctx: unknown) => discovery.getTools(ctx) }), getCustomInstructions: () => manager.getMcpCustomInstructions(), resolveToolTransport: (id: string) => discovery.resolveProviderTransport(id), resolveNeedsAuthSlot: async (id: string) => { const summary = (await manager.listServers()).servers.find((server: McpServerSummary) => server.serverIdentifier === id && server.status === "needsAuth"); return summary == null ? null : { serverId: summary.id, serverName: summary.name }; } },
    management,
    setSettingsStore: (settings: unknown) => manager.setSettingsStore(settings),
    listBoxServers: (ids, options) => discovery.listBoxServers([...ids], options),
    noteAuthCompletedElsewhere: (serverId, accountKey) => manager.noteAuthCompletedElsewhere(serverId, accountKey),
    setBoxMcpExec: (exec: unknown) => discovery.setBoxMcpExec(exec),
    dispose: () => manager.dispose()
  };
}

export interface McpHostPort { dispose(): void | Promise<void>; listBoxServers(ids: readonly string[], options?: { kickOnly?: boolean }): Promise<Array<{ serverIdentifier: string; status: string; statusDetail?: string; toolCount: number }>>; noteAuthCompletedElsewhere(serverId: string, accountKey: string): void; setSettingsStore?(settings: unknown): void; setBoxMcpExec?(exec: unknown): void; mcp: unknown; management: unknown }
export interface McpHostServiceDeps {
  auth: {
    getAccessToken(args: { backendUrl: string }): Promise<string>;
    getMachineId(): Promise<string>;
  };
  foreverBox: { readonly box: CapableBox };
  settings: unknown;
  log(message: string): void;
  pluginSkills?: PluginSkillsPort;
  onDiscoveryFailed?: (event: Record<string, unknown>) => void;
  onConnectorAuth?: (event: Record<string, unknown>) => void;
}
export class McpHostService {
  readonly authCompletionListeners = new Set<(event: unknown) => void>();
  readonly serversUpdatedListeners = new Set<(event: { servers: unknown[] }) => void>();
  readonly statusFollowUps = new Map<string, Promise<void>>();
  private disposed = false;
  readonly hostMcp: McpHostPort;
  readonly api;
  constructor(readonly deps: McpHostServiceDeps) {
    const accountMcpDeps: AccountMcpDependencies = {
      getAccessToken: (options) => deps.auth.getAccessToken({ backendUrl: options?.backendUrl ?? getSandInferenceBackendUrl() }),
      getMachineId: deps.auth.getMachineId,
      getBackendUrl: getSandInferenceBackendUrl,
      createClient: (credentials) => createSandCursorBackendClient(DashboardService, {
        getAccessToken: (options) => credentials.getAccessToken({ backendUrl: options.backendUrl }),
        getMachineId: credentials.getMachineId,
      }) as unknown as AccountMcpClient,
    };
    const backendMcpExec = createDashboardSandBackendMcpExec({
      getAccessToken: accountMcpDeps.getAccessToken,
      getMachineId: accountMcpDeps.getMachineId,
      createClient: (credentials) => createSandCursorBackendClient(DashboardService, {
        getAccessToken: (options) => credentials.getAccessToken({ backendUrl: options.backendUrl }),
        getMachineId: credentials.getMachineId,
      }) as unknown as DashboardMcpExecClient,
    });
    this.hostMcp = createHostMcp({
      log: deps.log,
      onServerAuthenticated: (completion) => this.emitAuthCompletion(completion),
      onServersMutated: () => this.emitServersUpdated({ servers: [] }),
      getMachineId: deps.auth.getMachineId,
      // Connectors used to reach this host only through the Cursor account's server list, so every
      // connector depended on a Cursor login. Local stdio servers are merged over it here and stand
      // on their own when the account is unreachable -- a connector configured on this machine must
      // not stop working because a remote login expired.
      accountServersProvider: async () => {
        const root = getSandRootDir(), local = readLocalConnectorFile(root);
        return mergeLocalConnectors(
          await fetchAccountMcpServers(accountMcpDeps).catch(() => null),
          local,
          // CP-07 gives each local connector a stable numeric id; CP-10 merges the host-owned
          // secret store into its env on the way to the box.
          { ids: assignLocalConnectorIds(root, Object.keys(local), { log: deps.log }), secrets: readConnectorEnvSecrets(root) },
        );
      },
      accountMcpWriter: createAccountMcpWriter(accountMcpDeps),
      effectivePluginsProvider: () => fetchEffectiveUserPlugins(accountMcpDeps),
      backendMcpExec,
      boxMcpExec: createBoxSandMcpExec(deps.foreverBox.box),
      settingsStore: deps.settings,
      ...(deps.onDiscoveryFailed === undefined ? {} : { onDiscoveryFailed: deps.onDiscoveryFailed }),
      ...(deps.onConnectorAuth === undefined ? {} : { onConnectorAuth: deps.onConnectorAuth }),
    });
    this.api = { mcp: this.hostMcp.mcp, management: this.hostMcp.management,
      // The real code->token exchange was built and never exposed, so the gateway's
      // completeMcpOAuth could only return undefined and no connector OAuth could finish
      // outside Electron.
      completeOAuth: (args: { stateId: string; code: string }) => backendMcpExec.completeOAuth(args), listBoxServers: (ids: readonly string[]) => this.listBoxServers(ids), subscribeToAuthCompletion: (listener: (event: unknown) => void) => { this.authCompletionListeners.add(listener); return () => this.authCompletionListeners.delete(listener); }, noteAuthCompletedElsewhere: (serverId: string, accountKey: string) => this.hostMcp.noteAuthCompletedElsewhere(serverId, accountKey), subscribeToServersUpdated: (listener: (event: { servers: unknown[] }) => void) => { this.serversUpdatedListeners.add(listener); return () => this.serversUpdatedListeners.delete(listener); }, syncPluginSkills: async () => await deps.pluginSkills?.sync("desktop") ?? [], pluginSyncStatus: () => deps.pluginSkills?.status() ?? { authBlocked: [] } };
  }
  setSettingsStore(settings: unknown): void { this.hostMcp.setSettingsStore?.(settings); }
  setBoxMcpExec(exec: unknown): void { this.hostMcp.setBoxMcpExec?.(exec); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; this.authCompletionListeners.clear(); this.serversUpdatedListeners.clear(); this.statusFollowUps.clear(); await this.hostMcp.dispose(); }
  async listBoxServers(ids: readonly string[]) { const servers = await this.hostMcp.listBoxServers(ids, { kickOnly: true }); this.scheduleStatusFollowUps(servers); return servers.map(({ serverIdentifier, status, statusDetail, toolCount }) => ({ serverIdentifier, status, ...(statusDetail == null ? {} : { statusDetail }), toolCount })); }
  scheduleStatusFollowUps(servers: readonly { serverIdentifier: string; status: string }[]): void {
    if (this.disposed) return;
    for (const server of servers) {
      if (server.status !== "loading" && server.status !== "error" || this.statusFollowUps.has(server.serverIdentifier)) continue;
      const id = server.serverIdentifier, followUp = (async () => { try { const [updated] = await this.hostMcp.listBoxServers([id]); if (!this.disposed && updated != null) this.emitServersUpdated({ servers: [{ serverIdentifier: updated.serverIdentifier, status: updated.status, ...(updated.statusDetail == null ? {} : { statusDetail: updated.statusDetail }), toolCount: updated.toolCount }] }); } catch (error) { if (!this.disposed) this.deps.log(`[sand:mcp] box MCP status follow-up failed for ${id}: ${error instanceof Error ? error.message : String(error)}`); } finally { this.statusFollowUps.delete(id); } })();
      this.statusFollowUps.set(id, followUp);
    }
  }
  emitAuthCompletion(event: unknown): void { if (!this.disposed) for (const listener of this.authCompletionListeners) listener(event); }
  emitServersUpdated(event: { servers: unknown[] }): void { if (!this.disposed) for (const listener of this.serversUpdatedListeners) listener(event); }
}
export function createMcpService(deps: ConstructorParameters<typeof McpHostService>[0]): McpHostService { return new McpHostService(deps); }
