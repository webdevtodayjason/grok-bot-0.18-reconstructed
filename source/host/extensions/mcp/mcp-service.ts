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
  hasLocalConnectorEntry,
  isRemoteLocalServer,
  LOCAL_CONNECTORS_FILENAME,
  listRefusedLocalConnectors,
  localConnectorEntryRefusal,
  localConnectorIdForName,
  localRemoteConnectorNames,
  mergeLocalConnectors,
  migrateBridgedRemoteEntries,
  remoteCredentialFieldNames,
  readLocalConnectorFile,
  removeLocalConnectorEntry,
  writeLocalConnectorEntry,
  type LocalServerConfig,
} from "./local-connectors.js";
import { CONNECT_TIMEOUT_SENTENCE, describeConnectorHealth } from "./connector-health.js";
import { OAUTH_REMOTE_REFUSAL, probeRemoteMcpOAuth } from "./remote-oauth-probe.js";
import { isShellEnvSecretField } from "../shell-tools/shell-secret-field.js";
import { pushShellEnvSecretsToBox, writeShellEnvSecret } from "../shell-tools/shell-secrets.js";
import { createContext } from "../../../packages/context/core.js";
import {
  getMarketplacePluginDetail,
  installMarketplacePlugin,
  listMarketplacePluginSummaries,
  pluginCredentialConsumers,
  uninstallMarketplacePlugin,
} from "./marketplace-plugins.js";
import { findMarketplacePlugin } from "../../../shared/marketplace/catalog.js";
import {
  assertConnectorCredentialField,
  deleteConnectorEnvSecret,
  isConnectorEnvFieldName,
  listConnectorCredentialFields,
  listConnectorEnvSecretFields,
  listConnectorSecretServers,
  readConnectorEnvSecrets,
  writeConnectorEnvSecret,
} from "./connector-secrets.js";

/** The context the fan-out's shell push runs under, named the way the shell card's own push is. */
const PLUGIN_CREDENTIAL_SHELL_CONTEXT = createContext().withName("shellTools");

export interface McpServerSummary { id: string; name: string; serverIdentifier: string; accountKey: string; pluginId?: string | null; isTeamServer: boolean; status: string; statusDetail?: string; transport: string; toolCount: number; disabledToolCount?: number; customInstructions: string }
export interface CatalogField { key: string; label: string; hint: string; isRequired?: boolean; isSecret?: boolean }
export interface CatalogPlugin { id: string; name: string; displayName?: string; description?: string; category?: string; fields?: CatalogField[]; connectors?: unknown[]; skills?: Array<{ name: string; description?: string; sourceUrl?: string }> }
export interface EffectivePlugin { pluginId: string; installMode?: string; isEnabled: boolean; hasTeamConfiguredVariables?: boolean }
export interface ServerState { servers: McpServerSummary[] }
export interface PluginSkillsPort { sync(trigger: string): Promise<unknown[]>; status(): unknown; removeLiveReferences?(sourceUrls: readonly string[]): void }

/**
 * MARKET-6. One submitted shape to one entry, so that the console's Add your own, the agent's
 * AddMcpServer and a pasted vendor config block cannot disagree about what they built.
 *
 * A caller says either a link (url, optional headers) or a program (command, args, env NAMES). Env
 * names arrive as names and land with the value EMPTY, which is the whole of how a credential is
 * declared here: connectors.json says which key the value belongs under, and the 0600 store holds
 * the value. A caller that sends a value instead of a name is refused rather than obeyed.
 */
export function connectorEntryFromSpec(spec: {
  url?: unknown; type?: unknown; headers?: unknown;
  command?: unknown; args?: unknown; env?: unknown; allowPrivateNetwork?: unknown;
}): LocalServerConfig {
  const url = typeof spec.url === "string" ? spec.url.trim() : "";
  if (url.length > 0) {
    const headers: Record<string, string> = {};
    if (typeof spec.headers === "object" && spec.headers != null && !Array.isArray(spec.headers)) {
      for (const [header, value] of Object.entries(spec.headers as Record<string, unknown>)) {
        if (typeof value === "string") headers[header] = value;
      }
    }
    return {
      type: spec.type === "sse" ? "sse" : "http",
      url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      // MARKET-15. The private-network opt-in, carried only when it is stated. Neither console door
      // nor the agent's AddMcpServer has a field for it; it exists for an operator holding the
      // box's gateway token who really does have a server on their own LAN, and for the gate's
      // in-box stub.
      ...(spec.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    };
  }
  const command = typeof spec.command === "string" ? spec.command.trim() : "";
  if (command.length === 0) {
    throw new Error("A server is either a link (its web address) or a program (the command the box runs). Give one of the two.");
  }
  const args = Array.isArray(spec.args) ? spec.args.filter((entry): entry is string => typeof entry === "string") : [];
  const env: Record<string, string> = {};
  // CONNECT-4's own distinction, and the two shapes that say it. An ARRAY is names: each lands with
  // the value EMPTY, which is how this box marks a credential the operator still owes and what makes
  // the masked card offer it. A MAP is configuration the operator has already answered -- a
  // connector's own flag, a config directory -- and its values are kept, because refusing them would
  // make an entry like `MCP_REMOTE_CONFIG_DIR` unwritable through the only door there is.
  //
  // The model cannot use the map shape at all: AddMcpServer's schema takes an array, so a key typed
  // in a tool call cannot reach this. That is where the transcript hazard is, and that is where it
  // is refused.
  if (Array.isArray(spec.env)) {
    for (const field of spec.env) if (typeof field === "string" && field.length > 0) env[field] = "";
  } else if (typeof spec.env === "object" && spec.env != null) {
    for (const [field, value] of Object.entries(spec.env as Record<string, unknown>)) {
      env[field] = typeof value === "string" ? value : "";
    }
  }
  return {
    command,
    ...(args.length === 0 ? {} : { args }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
  };
}

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
  /**
   * MARKET-5. The other place one typed credential can have to land: the agent's own box shell.
   * The mcp extension cannot see the forever-box, so the two moves it needs -- the 0600 write and
   * the live push to every exec daemon -- are handed in rather than reached for.
   */
  shellSecretSink?: {
    write(field: string, value: string): boolean;
    push(): Promise<{ applied: boolean; pendingWindows: readonly string[] }>;
  };
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
/**
 * MARKET-17. The boxes that were already running, brought onto the shape with no argument list.
 *
 * A bundle swap changes what the NEXT entry is written as and rewrites nothing, so both R750 boxes
 * kept the bridged TinyFish entry they were given in July: measured on 2026-09-08, the stored
 * bearer was still in three root process argument lists inside each of them, readable with
 * `ps -eo args` from the agent's own root shell, and no surface anywhere said so.
 *
 * So the host fixes it, at start and again every time the server list is rebuilt. The second one
 * matters because connectors.json is edited under a running host -- by the console, by the agent
 * and by hand -- and an entry written by an older client would otherwise sit there until a restart.
 * When there is nothing to do it is a file read and nothing else.
 *
 * A failure here must never take the host down: the connectors it did not touch keep working
 * exactly as they did, and the log line is the only thing that changes.
 */
export function runBridgedConnectorMigration(rootDir: string, log: (message: string) => void): string[] {
  try {
    const migration = migrateBridgedRemoteEntries(rootDir, {
      storeSecret: (connector, field, value) => writeConnectorEnvSecret(rootDir, connector, field, value),
    });
    for (const name of migration.migrated) {
      log(`connector "${name}" moved off the mcp-remote bridge onto the box's own remote transport, so its key is no longer in a process argument list`);
    }
    for (const { name, reason } of migration.skipped) {
      log(`connector "${name}" is still bridged: ${reason}`);
    }
    return migration.migrated;
  } catch (error) {
    log(`bridged connector migration failed (${error instanceof Error ? error.name : typeof error})`);
    return [];
  }
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
  // MARKET-17. Bridged entries, rewritten at start; the server-list read below does it again. The
  // names come back because rewriting the file is only half of it -- see `cycleMigrated` below.
  const migratedAtStart = runBridgedConnectorMigration(localConnectorRoot(), log);
  /**
   * MARKET-6. Which url entries in connectors.json this box connects to ITSELF. Handed to the
   * definition source as a function rather than a list because connectors.json changes under a
   * running host every time somebody presses Add, and a snapshot taken at startup would route a
   * connector added five minutes later at the dead backend.
   */
  (manager.definitionSourceView() as { setBoxRemoteNames?(provider: () => ReadonlySet<string>): void })
    .setBoxRemoteNames?.(() => new Set(localRemoteConnectorNames(localConnectorRoot())));
  /**
   * MARKET-6. One row, plus the sentence the console prints instead of the box's raw detail.
   *
   * The "unstored credential" question is answered here rather than in connector-health, because it
   * is the only part of the mapping that needs the filesystem: a 401 from a connector whose key was
   * never typed means "add the key", and the same 401 from one whose key IS stored means the key is
   * wrong, and those two sentences send the operator to two different places.
   */
  const withStatusSentence = (row: Record<string, unknown>): Record<string, unknown> => {
    const name = typeof row.serverIdentifier === "string" ? row.serverIdentifier : "";
    let hasUnstoredCredential = false;
    let credentialFields: string[] = [];
    try {
      const root = localConnectorRoot();
      credentialFields = listConnectorCredentialFields(root, name);
      const stored = new Set(listConnectorEnvSecretFields(root, name));
      hasUnstoredCredential = credentialFields.some((field) => !stored.has(field));
    } catch { /* a connector with no local entry simply declares nothing. */ }
    const health = describeConnectorHealth({
      status: typeof row.status === "string" ? row.status : undefined,
      statusDetail: typeof row.statusDetail === "string" ? row.statusDetail : undefined,
      toolCount: typeof row.toolCount === "number" ? row.toolCount : undefined,
      hasUnstoredCredential,
      credentialFields,
    });
    return { ...row, statusSentence: health.sentence, statusState: health.state };
  };
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
   * CONNECT-11. The resolver for the SECRET commands, and only those.
   *
   * `resolveLocalConnector` above is the first line of list, set AND delete, and it throws the
   * moment the entry has left connectors.json -- which is exactly when a stale credential most
   * needs listing and clearing. Reproduced twice on the local box: uninstall a plugin, then try to
   * clear the key it left behind, and the host says there is no such connector.
   *
   * So this one falls back to the STORE's own key set when the entry is gone. Both of the strict
   * resolver's guards are kept, because both were bought with a bug: `Object.hasOwn` rather than a
   * truthiness test, so "constructor" and "toString" are not connectors; and the numeric-id mapping,
   * so a console that only ever learned an id can still name the thing it is clearing.
   *
   * `setConnectorSecret` deliberately keeps the STRICT resolver. Storing a value against a
   * connector that does not exist is the CONNECT-4 class of bug the strict resolver was added to
   * stop, and a delete has no such hazard.
   */
  const resolveConnectorForSecrets = (server: unknown, caller: string): { name: string; id: string; entryExists: boolean } => {
    try {
      const strict = resolveLocalConnector(server, caller, true);
      return { ...strict, entryExists: true };
    } catch (strictError) {
      const wanted = typeof server === "string" ? server.trim() : typeof server === "number" ? String(server) : "";
      if (wanted.length === 0) throw strictError;
      const root = localConnectorRoot();
      const orphans = listConnectorSecretServers(root);
      const ids = assignLocalConnectorIds(root, orphans, { readOnly: true, log });
      const name = orphans.includes(wanted) ? wanted : orphans.find((candidate) => ids[candidate] === wanted);
      if (name == null) throw strictError;
      return { name, id: ids[name] ?? String(localConnectorIdForName(name)), entryExists: false };
    }
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
      // MARKET-6: the BOX's list, not the stdio one. A restart built from the stdio list would push
      // a config with every remote connector missing, and `removeMissing` would stop all of them.
      const stdio = await (manager.definitionSourceView() as { getBoxServerConfigs(): Promise<Record<string, unknown>> }).getBoxServerConfigs();
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
  /**
   * MARKET-6. Stops one connector and leaves it stopped.
   *
   * `loadServers` carries removeMissing, so a push that omits a name is how a process on the box
   * dies. Unlike `restartLocalConnector` this deliberately does NOT reset the push state: the point
   * is that the thing stays down until somebody acts, rather than being spawned again by the next
   * discovery.
   *
   * It exists for one measured condition. A bridge that opened a browser sign-in nobody answered
   * sits there forever: one on the local box had been waiting nine hours and fifty-one minutes,
   * holding a loopback port and a Chrome window, with eighty abandoned verifier files beside it.
   * Nothing stopped it, because nothing was looking.
   */
  const stopLocalConnector = async (name: string): Promise<boolean> => {
    const boxExec = deps.boxMcpExec as { loadServers(configJson: string): Promise<void> } | undefined;
    if (boxExec == null) return false;
    try {
      const configs = await (manager.definitionSourceView() as { getBoxServerConfigs(): Promise<Record<string, unknown>> }).getBoxServerConfigs();
      const { [name]: _stopped, ...others } = configs;
      await boxExec.loadServers(JSON.stringify({ mcpServers: others }));
      return true;
      // Class only. The argument to the failing call is the merged config, credentials and all.
    } catch (error) { log(`connector stop failed for ${name}: ${error instanceof Error ? error.name : typeof error}`); return false; }
  };
  /**
   * MARKET-17, the half the first fix missed.
   *
   * Rewriting connectors.json does not stop the bridge it used to name. Measured on the R750 demo
   * box on 2026-09-08, minutes after the swap that landed the migration: the entry was the link
   * shape and `ps` still showed the same three `npx mcp-remote` processes, 29 hours old and
   * carrying the live bearer, because the box's daemon stops a server only when it LEAVES the list
   * it is pushed, not when that server's config changes underneath it.
   *
   * So each migrated connector is cycled: pushed absent, which stops it, then pushed back, which
   * starts it in the shape with no argument list. Not on the first tick -- the box may not be
   * answering yet at host start -- so it is tried a few times, spaced, and gives up quietly. The
   * timer is unref'd: a host with nothing else to do must still be able to exit.
   */
  const cycleMigrated = (names: readonly string[]): void => {
    if (names.length === 0) return;
    const attempts = [15_000, 45_000, 120_000];
    const pending = new Set(names);
    const tryOnce = (index: number): void => {
      const timer = setTimeout(() => {
        void (async () => {
          for (const name of [...pending]) {
            if (await restartLocalConnector(name)) {
              pending.delete(name);
              log(`connector "${name}" was restarted after its migration, so the bridge that held its key in argv is gone`);
            }
          }
          if (pending.size > 0 && index + 1 < attempts.length) tryOnce(index + 1);
          else if (pending.size > 0) log(`connector(s) ${[...pending].join(", ")} were migrated but could not be restarted; their old bridge process may still be running until this box restarts`);
        })();
      }, attempts[index]);
      timer.unref?.();
    };
    tryOnce(0);
  };
  cycleMigrated(migratedAtStart);

  const management = {
    // SECRET-2: a connectors.json entry this host refuses to run appears here with the reason,
    // rather than vanishing from the listing and leaving the operator to guess why their connector
    // never turned up. It carries no tools and can never connect: refused is its whole story.
    listInstalled: async () => [
      ...toInstalledServers(await manager.listServers()).map(withStatusSentence),
      ...listRefusedLocalConnectors(localConnectorRoot()).map(({ name, reason }) => ({
        id: String(localConnectorIdForName(name)), name, serverIdentifier: name, accountKey: null,
        isTeamServer: false, status: "refused", statusDetail: reason, transport: "stdio",
        toolCount: 0, customInstructions: null,
        statusSentence: describeConnectorHealth({ status: "refused", statusDetail: reason }).sentence,
        statusState: "refused-by-host",
      })),
    ],
    /**
     * MARKET-6. The one writer, reached from the console's Add and Add your own, from the agent's
     * AddMcpServer, and from the marketplace install. Every rule lives in
     * `localConnectorEntryRefusal` beside the write itself, so no door can arrive with its own
     * subset of them.
     *
     * A credential is NEVER a literal here. A remote entry carries `${FIELD}` in its header and a
     * stdio entry carries the field name with an empty value, which is how CONNECT-4 recognises a
     * credential and how the masked card knows what to offer. That is also why the model cannot
     * type one: a key in a tool call is a key in the transcript.
     */
    addLocalConnector: async (args: {
      name?: unknown; url?: unknown; type?: unknown; headers?: unknown;
      command?: unknown; args?: unknown; env?: unknown; replace?: unknown;
      allowPrivateNetwork?: unknown;
    }) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (name.length === 0) throw new Error("addLocalConnector needs a `name`");
      const root = localConnectorRoot();
      if (args.replace !== true && hasLocalConnectorEntry(root, name)) {
        throw new Error(`"${name}" is already there. Remove it first, or send replace: true to write over it.`);
      }
      const entry = connectorEntryFromSpec(args);
      const refusal = localConnectorEntryRefusal(name, entry);
      if (refusal != null) throw new Error(refusal);
      // MARKET-18. A remote server the operator gave no key for is asked, once, whether it wants a
      // browser sign-in -- because a box cannot do one, and being told that now is the difference
      // between one sentence and a connector that sits in "connecting" until somebody investigates.
      // Asked only in that case: agent.tinyfish.ai advertises OAuth metadata too and works fine
      // with a key. A network failure refuses nothing.
      if (isRemoteLocalServer(entry) && remoteCredentialFieldNames(entry).length === 0) {
        if (await probeRemoteMcpOAuth(entry.url) === true) throw new Error(OAUTH_REMOTE_REFUSAL);
      }
      writeLocalConnectorEntry(root, name, entry);
      const restarted = await restartLocalConnector(name);
      const { id } = resolveLocalConnector(name, "addLocalConnector");
      return {
        server: name, serverId: id, added: true, restarted,
        transport: isRemoteLocalServer(entry) ? entry.type : "stdio",
        fields: listConnectorCredentialFields(root, name),
        stored: listConnectorEnvSecretFields(root, name),
      };
    },
    /**
     * CONNECT-11. Removing the entry and clearing its key are two separate acts, and the second one
     * has to keep working after the first: the console offers "also clear the stored values", and
     * an agent's UninstallPlugin can now offer the same, because the clear no longer depends on the
     * entry still being there.
     */
    removeLocalConnector: async (args: { server?: unknown; clearSecrets?: unknown }) => {
      const { name, id } = resolveConnectorForSecrets(args.server, "removeLocalConnector");
      const root = localConnectorRoot();
      const removed = removeLocalConnectorEntry(root, name);
      const cleared: string[] = [];
      if (args.clearSecrets === true) {
        for (const field of listConnectorEnvSecretFields(root, name)) {
          if (deleteConnectorEnvSecret(root, name, field)) cleared.push(field);
        }
      }
      if (removed) await mutate(() => manager.reloadServers());
      return {
        server: name, serverId: id, removed, cleared,
        stored: listConnectorEnvSecretFields(root, name),
      };
    },
    /**
     * CONNECT-11. Credentials the store still holds for connectors connectors.json no longer names.
     * Nothing on this box could see these before: every listing started from the entry, so a key
     * outlived the thing it belonged to with no surface that would ever mention it again.
     */
    listConnectorSecretOrphans: () => {
      const root = localConnectorRoot();
      const configured = readLocalConnectorFile(root);
      return listConnectorSecretServers(root)
        .filter((server) => !Object.hasOwn(configured, server))
        .map((server) => ({ server, serverId: String(localConnectorIdForName(server)), stored: listConnectorEnvSecretFields(root, server) }));
    },
    /**
     * MARKET-5. One typed value, written once, fanned out to every consumer the plugin declares,
     * and one sentence back saying where it went.
     */
    setPluginCredential: async (args: { pluginId?: unknown; field?: unknown; value?: unknown }) => {
      const pluginId = typeof args.pluginId === "string" ? args.pluginId : "";
      const plugin = findMarketplacePlugin(pluginId);
      if (plugin == null) throw new Error(`no marketplace plugin "${pluginId}"`);
      const field = args.field;
      if (!isConnectorEnvFieldName(field)) throw new Error("setPluginCredential needs an environment variable name as `field` (process-control names such as PATH, NODE_OPTIONS and LD_* are refused)");
      if (typeof args.value !== "string" || args.value.length === 0) throw new Error("setPluginCredential needs a non-empty `value`");
      const consumers = pluginCredentialConsumers(plugin, field);
      if (consumers.length === 0) throw new Error(`"${plugin.name}" has nowhere to put ${field}: it declares no connector and no shell tool.`);
      const root = localConnectorRoot();
      const went: string[] = [];
      let restarted = false;
      let shell: { applied: boolean; pendingWindows: readonly string[] } | null = null;
      for (const consumer of consumers) {
        if (consumer.kind === "connector") {
          if (!writeConnectorEnvSecret(root, consumer.connector, consumer.env, args.value)) {
            throw new Error("the connector secret store could not be written");
          }
          went.push("the connector");
          restarted = await restartLocalConnector(consumer.connector) || restarted;
        } else {
          if (deps.shellSecretSink == null) throw new Error("this host has no shell to push a credential into");
          if (!deps.shellSecretSink.write(consumer.env, args.value)) {
            throw new Error("the shell secret store could not be written");
          }
          went.push("the agent's shell");
          shell = await deps.shellSecretSink.push();
        }
      }
      const where = went.length === 1 ? went[0] : `${went.slice(0, -1).join(", ")} and ${went[went.length - 1]}`;
      return {
        pluginId: plugin.id, field, stored: true, restarted,
        ...(shell == null ? {} : { applied: shell.applied, ...(shell.pendingWindows.length === 0 ? {} : { pendingWindows: [...shell.pendingWindows] }) }),
        // The one line the page prints under the single masked box.
        sentence: `Stored once. Used by ${where}.`,
        consumers: consumers.map((consumer) => consumer.kind === "connector"
          ? { kind: "connector", connector: consumer.connector, env: consumer.env }
          : { kind: "shell", env: consumer.env }),
      };
    },
    /**
     * One connector's live condition, in the words the person who added it would use, with its
     * tools when it has any.
     *
     * `stopIfStalled` is opt-in and the console asks for it: a connector sitting on a browser
     * sign-in nobody is going to answer is stopped rather than left holding a port, and the answer
     * says so in a sentence. It is not the default, because a person may be halfway through the
     * sign-in at the moment somebody else opens the page.
     */
    probeConnector: async (args: { server?: unknown; stopIfStalled?: unknown }) => {
      const { name, id } = resolveLocalConnector(args.server, "probeConnector");
      const rows = toInstalledServers(await manager.listServers());
      const row = rows.find((entry) => entry.serverIdentifier === name);
      const decorated = withStatusSentence(row ?? { serverIdentifier: name, status: "loading", toolCount: 0 });
      // The box's own answer first. `listServerTools` resolves a tool to a server through the
      // Cursor account's display rows, and this box has no account, so for a LOCAL connector it
      // answers an empty list however many tools the thing is offering. Measured on
      // grok-bot-local-vm: a connector reporting two tools listed none.
      const boxRows = await discovery.listBoxServers([name], { kickOnly: true }).catch(() => []);
      const boxTools = (boxRows.find((entry) => entry.serverIdentifier === name)?.tools ?? [])
        .map((tool) => ({ name: tool.toolName ?? tool.name, ...(tool.description == null ? {} : { description: tool.description }), enabled: true }));
      const tools = boxTools.length > 0
        ? boxTools
        : (row == null ? [] : await manager.listServerTools(String(row.id)).catch(() => []))
          .map((tool) => ({ name: tool.name, ...(tool.description == null ? {} : { description: tool.description }), enabled: tool.isDisabled !== true }));
      const stalled = decorated.statusState === "needs-browser-sign-in";
      const stopped = stalled && args.stopIfStalled === true ? await stopLocalConnector(name) : false;
      return {
        server: name, serverId: id,
        status: decorated.status,
        statusSentence: stopped
          ? `${String(decorated.statusSentence)} ${CONNECT_TIMEOUT_SENTENCE}`
          : decorated.statusSentence,
        statusState: decorated.statusState,
        stopped,
        toolCount: decorated.toolCount ?? tools.length,
        tools,
        ...(decorated.statusDetail == null ? {} : { statusDetail: decorated.statusDetail }),
      };
    },
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
    /**
     * MARKET-6. The agent's AddMcpServer, repointed.
     *
     * `manager.addServer` writes to the Cursor account's server list, which is the one place on
     * this box that does not exist: there is no usable Cursor account here, so the model could add
     * a server, be told it worked, and find nothing on the box afterwards. It lands in
     * connectors.json now, through the same validated write the console's Add uses, and the answer
     * is the box's own listing rather than an account's echo.
     */
    add: async (args: { name: string; configJson: string }) => {
      let spec: unknown;
      try { spec = JSON.parse(args.configJson); }
      catch { throw new Error("That configuration is not readable as JSON. Paste the server's own config block exactly as its docs give it."); }
      await management.addLocalConnector({ ...(spec as Record<string, unknown>), name: args.name });
      return management.listInstalled();
    },
    /** The agent's UninstallMcpServer, on the same writer, with CONNECT-11's clear offer. */
    removeConnector: async (args: { server: string; clearSecrets: boolean }) => {
      const outcome = await management.removeLocalConnector(args);
      return { removed: outcome.removed, cleared: outcome.cleared };
    },
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
        const root = getSandRootDir();
        // Before the list is read, not after: an entry still on the bridge would otherwise be
        // pushed to the box with its key on a command line one more time.
        runBridgedConnectorMigration(root, deps.log ?? ((message: string) => console.log(`[sand:mcp] ${message}`)));
        const local = readLocalConnectorFile(root);
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
      // MARKET-5. The shell half of the fan-out. Wired here rather than in production.ts because
      // this is the only place in the mcp extension that already holds the forever-box, and the
      // fan-out has to reach the SAME two writes the console's own shell card makes -- the 0600
      // store, then every exec daemon on the box, the per-window ones included.
      shellSecretSink: {
        write: (field: string, value: string) => isShellEnvSecretField(field)
          && writeShellEnvSecret(getSandRootDir(), field, value),
        push: () => pushShellEnvSecretsToBox(
          getSandRootDir(),
          deps.foreverBox.box as unknown as { applyEnvironment?: (ctx: unknown, update: unknown) => Promise<unknown> },
          PLUGIN_CREDENTIAL_SHELL_CONTEXT),
      },
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
