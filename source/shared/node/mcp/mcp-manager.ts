import { isEffectivePluginInstalled } from "../../mcp.js";
import { mergeUnresolvedAccountServers } from "./account-display-cache.js";
import { BUILTIN_MCP_SERVER_NAMES } from "./builtin-mcp.js";
import { SandMcpAccountSlotLifecycle } from "./mcp-account-slot-lifecycle.js";
import { SandMcpAuthWatchLifecycle } from "./mcp-auth-watch-lifecycle.js";
import {
  AUTH_WATCH_POLL_INTERVAL_MS,
  AUTH_WATCH_POLL_TIMEOUT_MS,
  AUTH_WATCH_TIMEOUT_MS,
} from "./mcp-auth-watch.js";
import { SandMcpCatalogFlow } from "./mcp-catalog-flow.js";
import { SandMcpConfigError } from "./mcp-config-error.js";
import {
  backendEntryBelongsToRow,
  SandMcpDefinitionSource,
} from "./mcp-definition-source.js";
import {
  runtimeConfigFromDisplay,
  validateMarketplacePluginId,
} from "./mcp-display-runtime.js";
import { SandMcpInstructionsAndToggles } from "./mcp-instructions-and-toggles.js";
import { SandMcpListingSummaries } from "./mcp-listing-summaries.js";
import { validateMcpServerId } from "./mcp-server-id.js";
import { parseServerConfig, validateServerName } from "./mcp-validation.js";
import { reportMcpHostEdgeFailure } from "./mcp-diagnostics.js";
// CONNECT-2. How long a list call will wait for the box's answer about its stdio servers before
// it answers from the last known state instead. A connector stuck on its sign-in used to hold the
// list open for the box's whole connection timeout, and the console boots on this list.
const BOX_SERVER_LIST_BUDGET_MS = 500;
// What a server nobody has heard back from yet looks like: connecting, no tools, not an error.
// statusFromBoxListStatus turns "loading" into the "initializing" the console already draws.
const BOX_SERVER_CONNECTING: any = { status: "loading", toolCount: 0, tools: [] };
const EMPTY_SETTINGS: any = {
  scopeToAccount() {},
  migrateMcpCustomInstructionToServerId() {},
  getMcpCustomInstructions: () => ({}),
  getMcpCustomInstructionsByServerId: () => ({}),
  getMcpDisabledToolsByServerId: () => ({}),
  setMcpDisabledToolsByServerId() {},
  getRawMcpCustomInstruction: () => undefined,
  getRawMcpCustomInstructionByServerId: () => undefined,
  setMcpCustomInstructionByServerId() {},
  deleteMcpCustomInstructionByServerId() {},
};
export class SandMcpManager {
  private settingsStore: any;
  private boxRuntime: any;
  private readonly backendMcpExec: any;
  private readonly definitionSource: SandMcpDefinitionSource;
  private readonly accountWriter: any;
  private readonly effectivePluginsProvider: any;
  private readonly accountServersProvider: any;
  private readonly accountDisplayConfigProvider: any;
  private accountPromise: Promise<any> | undefined;
  private generation = 0;
  private lastDisplay: any = null;
  private lastState: any = null;
  private lastBackendTools: any[] = [];
  private lastScope: string | undefined;
  private readonly lastBoxServers = new Map<string, any>();
  private boxServersRead: Promise<void> | null = null;
  private boxServersUnreachable = false;
  private boxReadGeneration = 0;
  private readonly boxListBudgetMs: number;
  private readonly authWatches: SandMcpAuthWatchLifecycle;
  private readonly summaries: SandMcpListingSummaries;
  private readonly instructions: SandMcpInstructionsAndToggles;
  private readonly slots: SandMcpAccountSlotLifecycle;
  private readonly catalog: SandMcpCatalogFlow;
  constructor(private readonly options: any) {
    this.settingsStore = options.settingsStore ?? EMPTY_SETTINGS;
    this.boxRuntime = options.boxRuntime;
    this.backendMcpExec = options.backendMcpExec;
    this.accountWriter = options.accountMcpWriter;
    this.effectivePluginsProvider = options.effectivePluginsProvider;
    this.accountServersProvider = options.accountServersProvider;
    this.boxListBudgetMs =
      options.boxListBudgetMs ?? BOX_SERVER_LIST_BUDGET_MS;
    this.accountDisplayConfigProvider =
      options.accountServersProvider == null
        ? options.accountDisplayConfigProvider
        : () => this.loadAccountServers();
    this.definitionSource = new SandMcpDefinitionSource(
      options.includeBuiltins ?? true,
      options.accountServersProvider == null
        ? options.accountConfigProvider
        : async () => runtimeConfigFromDisplay(await this.loadAccountServers()),
    );
    this.authWatches = new SandMcpAuthWatchLifecycle({
      backendMcpExec: this.backendMcpExec,
      authWatchPollIntervalMs:
        options.authWatchPollIntervalMs ?? AUTH_WATCH_POLL_INTERVAL_MS,
      authWatchTimeoutMs: options.authWatchTimeoutMs ?? AUTH_WATCH_TIMEOUT_MS,
      authWatchPollTimeoutMs:
        options.authWatchPollTimeoutMs ?? AUTH_WATCH_POLL_TIMEOUT_MS,
      resolveDisplayServer: (id, opts) => this.resolveDisplayServer(id, opts),
      reload: () => this.reload(),
      onConnectorAuth: options.onConnectorAuth,
    });
    this.summaries = new SandMcpListingSummaries({
      settingsStore: () => this.settingsStore,
      isBoxExecWired: () => this.boxRuntime?.isBoxExecWired() === true,
    });
    this.instructions = new SandMcpInstructionsAndToggles({
      settingsStore: () => this.settingsStore,
      resolveDisplayServer: (id) => this.resolveDisplayServer(id),
      listServers: () => this.listServers(),
      lastAccountDisplayConfig: () => this.lastDisplay,
      getToolsRaw: async () => (await this.boxRuntime?.getToolsRaw()) ?? [],
    });
    this.catalog = new SandMcpCatalogFlow({
      getMachineId: options.getMachineId,
      listEffectivePlugins: () => this.listEffectivePlugins(),
      requireAccountWriter: () => this.requireAccountWriter(),
      reloadServers: () => this.reloadServers(),
    });
    this.slots = new SandMcpAccountSlotLifecycle({
      backendMcpExec: this.backendMcpExec,
      definitionSource: this.definitionSource,
      resolveDisplayServer: (id) => this.resolveDisplayServer(id),
      reloadServers: () => this.reloadServers(),
      clearPendingAuthWatch: (id, key) =>
        this.authWatches.clearPendingAuthWatchCancelled(id, key),
      notifyWatchCancelled: (watch) =>
        this.authWatches.notifyWatchCancelled(watch),
      lastAccountDisplayConfig: () => this.lastDisplay,
      setLastAccountDisplayConfig: (display) => {
        this.lastDisplay = display;
      },
      lastListedState: () => this.lastState,
      setLastListedState: (state) => {
        this.lastState = state;
      },
      invalidateToolsCache: () => this.boxRuntime?.invalidateToolsCache(),
      resetPushState: () => this.boxRuntime?.resetPushState(),
    });
  }
  private loadAccountServers(): Promise<any> {
    if (this.accountPromise != null) return this.accountPromise;
    const generation = ++this.generation,
      promise = (this.accountServersProvider?.() ?? Promise.resolve(null)).then(
        (display: any) => {
          const cached =
            display?.cacheScope !== undefined &&
            display.cacheScope === this.lastScope
              ? this.lastDisplay
              : null;
          if (generation !== this.generation) return cached;
          if (display == null) {
            this.definitionSource.clearLastKnownAccountConfig();
            return null;
          }
          if (
            display.cacheScope !== undefined &&
            display.cacheScope !== this.lastScope
          ) {
            if (this.lastScope !== undefined) {
              this.lastDisplay = this.lastState = null;
              this.authWatches.clearAllPendingAuthWatchesCancelled();
              this.boxRuntime?.invalidateToolsCache();
            }
            this.settingsStore.scopeToAccount(display.cacheScope);
            this.lastScope = display.cacheScope;
            this.options.onAccountScopeApplied?.();
            this.definitionSource.clearLastKnownAccountConfig();
            this.definitionSource.clearCache();
          }
          if (display.unavailable === true) {
            if (cached == null) this.accountPromise = undefined;
            return cached;
          }
          const resolved = mergeUnresolvedAccountServers(display, cached);
          this.lastDisplay = resolved;
          this.definitionSource.adoptAccountConfig(
            runtimeConfigFromDisplay(resolved),
          );
          this.instructions.migrateCustomInstructions(resolved.servers);
          return resolved;
        },
      );
    this.accountPromise = promise;
    const clear = () => {
      if (this.accountPromise === promise) this.accountPromise = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }
  setBoxRuntime(runtime: any): void {
    this.boxRuntime = runtime;
  }
  definitionSourceView() {
    return this.definitionSource;
  }
  lastAccountDisplayConfigView() {
    return this.lastDisplay;
  }
  settingsStoreView() {
    return this.settingsStore;
  }
  backendMcpExecView() {
    return this.backendMcpExec;
  }
  onDiscoveryFailedView() {
    return this.options.onDiscoveryFailed;
  }
  setSettingsStore(settings: any): void {
    this.settingsStore = settings;
  }
  setAuthCompletionObserver(observer: any): void {
    this.authWatches.setAuthCompletionObserver(observer);
  }
  async listServers() {
    const display = await this.accountDisplayConfigProvider?.();
    if (display != null) this.lastDisplay = display;
    const effectiveDisplay =
        display ??
        (this.accountServersProvider == null ? this.lastDisplay : null),
      runtime = await this.definitionSource.getUserServerConfigs(),
      rows =
        effectiveDisplay?.servers ??
        (this.accountServersProvider == null
          ? Object.entries(runtime).map(([serverIdentifier, config]) => ({
              id: "0",
              name: serverIdentifier,
              serverIdentifier,
              config,
              isTeamServer: false,
              disabledByTeamAdminPolicy: false,
            }))
          : []),
      visible = rows.filter(
        (server: any) =>
          server.serverIdentifier == null ||
          !BUILTIN_MCP_SERVER_NAMES.has(server.serverIdentifier),
      );
    this.instructions.migrateCustomInstructions(visible);
    // MARKET-6. The third place the url/command split is made, and the one that decides what this
    // listing asks. A remote connector of this box's OWN is answered for by the box, which is
    // connected to it; asking the Cursor backend about it throws on every Titanium Bot box, because
    // there is no account behind that RPC -- which is how one native remote made the whole listing
    // 500 rather than showing one broken row.
    const boxRemote = this.definitionSource.getBoxRemoteNames();
    const listable = (server: any) =>
      server.serverIdentifier != null && !server.disabledByTeamAdminPolicy;
    const isBoxRemote = (server: any) =>
      "url" in server.config && boxRemote.has(server.serverIdentifier);
    const http = visible.filter((server: any) =>
        listable(server) && "url" in server.config && !isBoxRemote(server)),
      stdio = visible.filter((server: any) =>
        listable(server) && ("command" in server.config || isBoxRemote(server))),
      backend = http.length
        ? await this.backendMcpExec.listTools(
            http.map((server: any) => server.serverIdentifier),
          )
        : [],
      boxByName = new Map<string, any>();
    const disabledByServer =
      this.settingsStore.getMcpDisabledToolsByServerId?.() ?? {};
    this.lastBackendTools = backend.flatMap((entry: any) => {
      const row = http.find((server: any) =>
        backendEntryBelongsToRow(entry, server.serverIdentifier),
      );
      if (row == null) return [];
      const disabled = disabledByServer[row.id] ?? [];
      return entry.tools.filter(
        (tool: any) => !disabled.includes(tool.toolName),
      );
    });
    let unavailable = false;
    if (this.boxRuntime?.isBoxExecWired()) {
      const identifiers = stdio.map((item: any) => item.serverIdentifier);
      await this.readBoxServersWithinBudget(identifiers);
      // A box we could not reach is reported as unreachable, remembered state and all: an entry
      // last seen connected says nothing about a box that is not answering now, and rendering it
      // would keep a dead box looking healthy with its old tool count.
      if (!this.boxServersUnreachable)
        for (const identifier of identifiers)
          boxByName.set(
            identifier,
            this.lastBoxServers.get(identifier) ?? BOX_SERVER_CONNECTING,
          );
      // A server that is no longer configured stops being remembered here, so a removal is gone
      // from the next list instead of surviving until the box is restarted.
      for (const identifier of [...this.lastBoxServers.keys()])
        if (!identifiers.includes(identifier))
          this.lastBoxServers.delete(identifier);
      unavailable = this.boxServersUnreachable;
    }
    const servers: any[] = [];
    for (const server of visible) {
      if (server.disabledByTeamAdminPolicy)
        servers.push(this.summaries.createAdminDisabledServerSummary(server));
      else if (!("url" in server.config) || isBoxRemote(server))
        servers.push(
          this.summaries.createBoxServerSummary(
            server,
            boxByName.get(server.serverIdentifier),
            unavailable,
          ),
        );
      else
        servers.push(
          ...this.summaries.createBackendServerSummaries(
            server,
            backend.filter((entry: any) =>
              backendEntryBelongsToRow(entry, server.serverIdentifier),
            ),
          ),
        );
    }
    return (this.lastState = { servers });
  }
  /**
   * CONNECT-2. The box read runs in the background and a list call waits for it only until the
   * budget runs out; a server that is still connecting is REPORTED as connecting, never awaited.
   * Once every requested server has a SETTLED state the wait is skipped entirely, so the steady
   * state costs nothing and one connector stuck on its sign-in cannot hold the console's boot.
   * "loading" is not a settled state: remembering it as known would skip the budget forever and
   * leave the list one answer behind, so a connector that has since connected never lands.
   */
  private async readBoxServersWithinBudget(
    identifiers: string[],
  ): Promise<void> {
    const read = this.startBoxServersRead(identifiers);
    if (
      this.boxListBudgetMs <= 0 ||
      identifiers.every((identifier) => {
        const known = this.lastBoxServers.get(identifier);
        return known != null && known.status !== "loading";
      })
    )
      return;
    let timer: any;
    await Promise.race([
      read,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.boxListBudgetMs);
      }),
    ]);
    clearTimeout(timer);
  }
  private startBoxServersRead(identifiers: string[]): Promise<void> {
    if (this.boxServersRead != null) return this.boxServersRead;
    const generation = this.boxReadGeneration;
    // kickOnly asks the box for the state it already has and starts the ones it does not, rather
    // than sitting on a connect. A reload bumps the generation, and a read from before it is
    // abandoned: its answer describes servers this manager no longer has.
    const read = (async () => {
      try {
        const servers = await this.boxRuntime.listBoxServers(identifiers, {
          kickOnly: true,
        });
        if (generation !== this.boxReadGeneration) return;
        for (const server of servers)
          this.lastBoxServers.set(server.serverIdentifier, server);
        this.boxServersUnreachable =
          identifiers.length > 0 && servers.length === 0;
      } catch (error) {
        reportMcpHostEdgeFailure("box-settings-list", error);
        if (generation === this.boxReadGeneration)
          this.boxServersUnreachable = true;
      } finally {
        if (generation === this.boxReadGeneration) this.boxServersRead = null;
      }
    })();
    this.boxServersRead = read;
    return read;
  }
  async listConnectedBackendTools() {
    await this.listServers();
    return [...this.lastBackendTools];
  }
  async addServer(request: any) {
    const name = this.validateInstallableName(request.name),
      config = parseServerConfig(request.configJson);
    await this.addServersToAccount({ [name]: config });
    return this.reloadServers();
  }
  getCatalog(token: any, options?: any) {
    return this.catalog.getCatalog(token, options);
  }
  resolvePluginLogo(url: string) {
    return this.catalog.resolvePluginLogo(url);
  }
  installEntry(request: any, token: any) {
    return this.catalog.installEntry(request, token);
  }
  updatePluginInstall(request: any, token: any) {
    return this.catalog.updatePluginInstall(request, token);
  }
  private validateInstallableName(name: string) {
    const validated = validateServerName(name);
    if (BUILTIN_MCP_SERVER_NAMES.has(validated))
      throw new SandMcpConfigError(
        `MCP server name "${validated}" is reserved for a built-in Grok Bot server.`,
      );
    return validated;
  }
  private requireAccountWriter() {
    if (this.accountWriter == null)
      throw new SandMcpConfigError(
        "Managing MCP servers requires a signed-in Cursor account.",
      );
    return this.accountWriter;
  }
  private async addServersToAccount(
    servers: Record<string, any>,
  ): Promise<void> {
    const writer = this.requireAccountWriter(),
      { config, serverIdsByName } = await writer.getConfigForEdit();
    await writer.setConfig(
      { mcpServers: { ...config.mcpServers, ...servers } },
      serverIdsByName,
    );
  }
  async removeServer(rawId: string) {
    const id = validateMcpServerId(rawId),
      row = await this.resolveDisplayServer(id);
    if (
      row?.pluginId != null &&
      !row.isTeamServer &&
      !row.managedByTeamPluginPolicy &&
      !row.isRequired
    )
      return this.uninstallPluginRows(row.pluginId, id);
    const writer = this.requireAccountWriter(),
      current = await writer.getConfigForEdit(),
      name = Object.entries(current.serverIdsByName).find(
        ([, value]: any) => value.toString() === id,
      )?.[0];
    if (name == null || !(name in current.config.mcpServers))
      return this.classifyRemoveOutcome(id, await this.listServers());
    const servers = { ...current.config.mcpServers };
    delete servers[name];
    const ids = { ...current.serverIdsByName };
    delete ids[name];
    await writer.setConfig({ mcpServers: servers }, ids);
    this.authWatches.clearPendingAuthWatchesForServer(id);
    const displayName = row?.name;
    const sameNameRows =
      this.lastDisplay?.servers.filter(
        (server: any) => server.name === displayName,
      ).length ?? 1;
    this.settingsStore.deleteMcpCustomInstructionByServerId({
      serverId: id,
      displayName: displayName ?? name,
      deleteLegacyName: displayName != null && sameNameRows <= 1,
    });
    this.instructions.deleteDisabledToolsForServer(id);
    return this.classifyRemoveOutcome(id, await this.reloadServers(id));
  }
  private classifyRemoveOutcome(id: string, state: any) {
    const remaining = state.servers.find((server: any) => server.id === id);
    return remaining == null
      ? { state, removed: true }
      : {
          state,
          removed: false,
          reason: remaining.isTeamServer ? "team-server" : "still-present",
        };
  }
  listEffectivePlugins() {
    return this.effectivePluginsProvider == null
      ? Promise.resolve([])
      : this.effectivePluginsProvider();
  }
  async uninstallPlugin(raw: string) {
    const id = validateMarketplacePluginId(raw),
      state = await this.performPluginUninstall(id);
    let gone = this.effectivePluginsProvider == null;
    if (!gone)
      try {
        gone = !(await this.effectivePluginsProvider()).some(
          (plugin: any) =>
            plugin.pluginId === id && isEffectivePluginInstalled(plugin),
        );
      } catch {}
    const rows = state.servers.filter((server: any) => server.pluginId === id);
    return gone && rows.length === 0
      ? { state, removed: true }
      : {
          state,
          removed: false,
          reason:
            !gone || rows.some((row: any) => !row.isTeamServer)
              ? "still-present"
              : "team-server",
        };
  }
  private async performPluginUninstall(id: string) {
    const writer = this.requireAccountWriter();
    let display =
      this.accountDisplayConfigProvider == null ? this.lastDisplay : null;
    if (display == null && this.accountDisplayConfigProvider != null) {
      try {
        display = await this.accountDisplayConfigProvider();
        if (display != null) this.lastDisplay = display;
      } catch {
        display = this.lastDisplay;
      }
    }
    let effective = null;
    if (this.effectivePluginsProvider != null) {
      try {
        effective = await this.effectivePluginsProvider();
      } catch {
        effective = null;
      }
    }
    if (display == null && effective == null)
      throw new SandMcpConfigError(
        "Couldn't verify this plugin's team policy right now, so nothing was uninstalled. Try again.",
      );
    const rows = (display?.servers ?? []).filter(
      (server: any) => server.pluginId === id,
    );
    if (
      rows.some((row: any) => row.isRequired) ||
      (effective ?? []).some(
        (plugin: any) =>
          plugin.pluginId === id && plugin.installMode === "team-required",
      )
    )
      throw new SandMcpConfigError(
        "This plugin is required by the user's team and can't be uninstalled.",
      );
    const attributedRows = rows.filter((row: any) => !row.isTeamServer);
    await writer.uninstallPlugin({ pluginId: BigInt(id) });
    for (const row of attributedRows) {
      this.authWatches.clearPendingAuthWatchesForServer(row.id);
      const sameNameRows =
        display?.servers.filter((server: any) => server.name === row.name)
          .length ?? 1;
      this.settingsStore.deleteMcpCustomInstructionByServerId({
        serverId: row.id,
        displayName: row.name,
        deleteLegacyName: sameNameRows <= 1,
      });
      this.instructions.deleteDisabledToolsForServer(row.id);
    }
    return this.reloadServers();
  }
  private async uninstallPluginRows(pluginId: string, serverId: string) {
    return this.classifyRemoveOutcome(
      serverId,
      await this.performPluginUninstall(pluginId),
    );
  }
  logoutAccount(...args: [string, string]) {
    return this.slots.logoutAccount(...args);
  }
  renameAccount(...args: [string, string, string]) {
    return this.slots.renameAccount(...args);
  }
  removeAccount(...args: [string, string]) {
    return this.slots.removeAccount(...args);
  }
  setServerCustomInstructions(args: any) {
    return this.instructions.setServerCustomInstructions(args);
  }
  listServerTools(id: string) {
    return this.instructions.listServerTools(id);
  }
  toggleMcpToolDisabled(args: any) {
    return this.instructions.toggleMcpToolDisabled(args);
  }
  getMcpCustomInstructions() {
    return this.instructions.getMcpCustomInstructions();
  }
  async reloadServers(removed?: string) {
    await this.reload();
    if (removed != null && this.lastDisplay != null)
      this.lastDisplay = {
        ...this.lastDisplay,
        servers: this.lastDisplay.servers.filter(
          (server: any) => server.id !== removed,
        ),
      };
    return this.listServers();
  }
  refreshAccountConfigInBackground(): void {
    this.generation += 1;
    this.accountPromise = undefined;
    this.definitionSource.refreshInBackground();
  }
  authenticateServer(...args: any[]) {
    return this.authWatches.authenticateServer(
      args[0],
      args[1],
      args[2],
      args[3],
      args[4],
    );
  }
  async resolveDisplayServer(
    raw: string,
    options?: { requireFreshRead: boolean },
  ) {
    const id = validateMcpServerId(raw);
    if (options?.requireFreshRead && this.accountServersProvider != null) {
      const display = await this.accountServersProvider();
      if (display == null || display.unavailable)
        throw new SandMcpConfigError("account display config unavailable");
      return display.servers.find((server: any) => server.id === id);
    }
    if (this.accountDisplayConfigProvider == null) {
      if (options?.requireFreshRead)
        throw new SandMcpConfigError("no account display config provider");
      return undefined;
    }
    let display = null;
    try {
      display = await this.accountDisplayConfigProvider();
    } catch (error) {
      if (options?.requireFreshRead) throw error;
    }
    if (display != null) this.lastDisplay = display;
    else if (options?.requireFreshRead)
      throw new SandMcpConfigError("account display config unavailable");
    if (options?.requireFreshRead && display?.unavailable === true)
      throw new SandMcpConfigError("account display config unavailable");
    return (
      display ?? (this.accountServersProvider == null ? this.lastDisplay : null)
    )?.servers.find((server: any) => server.id === id);
  }
  noteAuthCompletedElsewhere(id: string, key: string) {
    return this.authWatches.noteAuthCompletedElsewhere(id, key);
  }
  async dispose(): Promise<void> {
    this.authWatches.clearAllPendingAuthWatches();
  }
  async reload(): Promise<void> {
    this.generation += 1;
    this.accountPromise = undefined;
    // Let go of the connect that is still in flight: whatever it eventually says is about the
    // configuration this reload just replaced, and the next list starts its own read.
    this.boxReadGeneration += 1;
    this.boxServersRead = null;
    this.boxServersUnreachable = false;
    this.definitionSource.clearCache();
    this.boxRuntime?.invalidateToolsCache();
    this.boxRuntime?.resetPushState();
  }
}
