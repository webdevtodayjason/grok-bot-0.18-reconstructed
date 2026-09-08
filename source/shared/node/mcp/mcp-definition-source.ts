import { BUILTIN_MCP_SERVER_NAMES, getBuiltinMcpServers, resolveBoxComputerRuntime } from "./builtin-mcp.js"; import type { McpServerConfig } from "./mcp-display-runtime.js";
export interface McpRuntimeConfig { mcpServers: Record<string, McpServerConfig> }
export const EMPTY_MCP_CONFIG: McpRuntimeConfig = { mcpServers: {} };
export const backendEntryBelongsToRow = (entry: { rowServerIdentifier?: string }, rowIdentifier: string): boolean => entry.rowServerIdentifier === rowIdentifier;
export const displayRowOwnsIdentifier = (identifier: string, rowIdentifier: string, slots?: readonly { serverIdentifier?: string }[]): boolean => identifier === rowIdentifier || (slots?.some((slot) => slot.serverIdentifier === identifier) ?? false);
export class SandMcpDefinitionSource { private accountConfigPromise: Promise<McpRuntimeConfig | null>; private epoch = 0; private lastKnownConfig: McpRuntimeConfig | null = null; constructor(private readonly includeBuiltins: boolean, private readonly provider?: () => Promise<McpRuntimeConfig | null>) { this.accountConfigPromise = this.loadAccountConfig(); } private loadAccountConfig(): Promise<McpRuntimeConfig | null> { const epoch = ++this.epoch, promise = this.provider?.() ?? Promise.resolve(null); void promise.then((config) => { if (config != null && epoch === this.epoch) this.lastKnownConfig = config; }, () => undefined); return promise; } clearLastKnownAccountConfig(): void { this.epoch += 1; this.lastKnownConfig = null; this.accountConfigPromise = Promise.resolve(null); } adoptAccountConfig(config: McpRuntimeConfig | null): void { this.epoch += 1; this.lastKnownConfig = config; this.accountConfigPromise = Promise.resolve(config); } peekHttpServerNames(): string[] | undefined { const names = this.peekNames("url"); return names?.filter((name) => !this.boxRemoteNames().has(name)); } peekStdioServerNames(): string[] | undefined { const names = this.peekNames("command"); if (names === undefined) return undefined; const remote = this.peekNames("url") ?? []; return [...names, ...remote.filter((name) => this.boxRemoteNames().has(name))]; } private peekNames(kind: "url" | "command"): string[] | undefined { if (this.lastKnownConfig == null) return undefined; return Object.entries(this.lastKnownConfig.mcpServers).filter(([name, config]) => !BUILTIN_MCP_SERVER_NAMES.has(name) && kind in config).map(([name]) => name); } async getStdioServerConfigs(): Promise<Record<string, McpServerConfig & { command: string }>> { const result: Record<string, McpServerConfig & { command: string }> = {}; for (const [name, config] of Object.entries(await this.getUserServerConfigs())) if ("command" in config) result[name] = config; return result; }
  /**
   * MARKET-6. Which url servers this box connects to ITSELF, rather than handing to the Cursor
   * Dashboard RPC that answers nothing here.
   *
   * The host is the only thing that knows: connectors.json is its file, and by the time a config
   * reaches this class a local remote and an account remote are the same three keys. Without the
   * split, letting a url entry through the local parser would have routed every one of them at the
   * dead backend and left the operator with a connector that never says anything at all.
   */
  private boxRemoteNamesProvider: () => ReadonlySet<string> = () => new Set();
  setBoxRemoteNames(provider: () => ReadonlySet<string>): void { this.boxRemoteNamesProvider = provider; }
  /** Public because the manager's own url/command split has to ask the same question. */
  getBoxRemoteNames(): ReadonlySet<string> { return this.boxRemoteNames(); }
  private boxRemoteNames(): ReadonlySet<string> { try { return this.boxRemoteNamesProvider(); } catch { return new Set(); } }
  /** Everything the box runs or connects: a program to spawn, or a remote of this box's own. */
  async getBoxServerConfigs(): Promise<Record<string, McpServerConfig>> {
    const remote = this.boxRemoteNames(), result: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(await this.getUserServerConfigs())) {
      if ("command" in config || remote.has(name)) result[name] = config;
    }
    return result;
  }
  /** The url servers that are still the backend's. Empty on every box that has no Cursor account. */
  async getBackendHttpServerNames(): Promise<string[]> {
    const remote = this.boxRemoteNames();
    return Object.entries(await this.getUserServerConfigs())
      .filter(([name, config]) => "url" in config && !remote.has(name))
      .map(([name]) => name);
  }
  clearCache(): void { this.accountConfigPromise = this.loadAccountConfig(); } async ensureConfigLoaded(): Promise<void> { this.clearCache(); if (await this.accountConfigPromise.catch(() => null) != null) return; this.clearCache(); if (await this.accountConfigPromise.catch(() => null) == null && this.lastKnownConfig != null) this.accountConfigPromise = Promise.resolve(this.lastKnownConfig); } refreshInBackground(): void { const superseded = this.accountConfigPromise; void this.loadAccountConfig().then((config) => { if (config != null && this.accountConfigPromise === superseded) this.accountConfigPromise = Promise.resolve(config); }, () => undefined); } async getUserServerConfigs(): Promise<Record<string, McpServerConfig>> { const account = await this.accountConfigPromise ?? EMPTY_MCP_CONFIG, result: Record<string, McpServerConfig> = {}; for (const [name, config] of Object.entries(account.mcpServers)) if (!BUILTIN_MCP_SERVER_NAMES.has(name)) result[name] = config; return result; } async getServerUrlForIdentifier(identifier: string): Promise<string | undefined> { const account = await this.accountConfigPromise ?? this.lastKnownConfig; const server = account?.mcpServers[identifier]; return server != null && "url" in server ? server.url : undefined; } async getDefinitions() { const builtins = this.includeBuiltins ? getBuiltinMcpServers(resolveBoxComputerRuntime({ boxMcpActive: false })) : {}; const builtinDefinitions = Object.entries(builtins).map(([identifier, serverConfig]) => ({ identifier, serverConfig, source: "builtin" as const })); const users = await this.getUserServerConfigs(); return [...builtinDefinitions, ...Object.entries(users).filter(([identifier, config]) => !(identifier in builtins) && "url" in config).map(([identifier, serverConfig]) => ({ identifier, serverConfig, source: "account" as const }))]; } }
