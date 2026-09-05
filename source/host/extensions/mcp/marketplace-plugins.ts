/**
 * The Marketplace catalog, seen as plugins by the host.
 *
 * `SearchPlugins`, `GetPlugin`, `InstallPlugin` and `UninstallPlugin` used to resolve against
 * Cursor's marketplace, which on this box always answers an empty list: there is no usable Cursor
 * account, `getCatalog` threw, and CP-05 turned the throw into "the plugin catalog is empty or
 * unavailable right now". A tool that can only say that is not a tool. These functions point the
 * same four commands at source/shared/marketplace/catalog.ts instead -- the one catalog the console
 * also reads, through `listMarketplace`.
 *
 * Installed state is read, never recorded: a connector plugin is installed when its name is in
 * connectors.json, and a credential field is "stored" when the 0600 secret store holds it. A shell
 * tool has no install record anywhere on this box, so the closest true signal is the same one the
 * console's Shell tools panel shows -- whether the host holds its key.
 *
 * No value from the secret store ever leaves this module. Only names, and only booleans about them.
 */
import {
  findMarketplacePlugin,
  marketplaceConnectorEntry,
  marketplaceCredentialFields,
  marketplaceShellToolId,
  searchMarketplacePlugins,
  type MarketplacePlugin,
} from "../../../shared/marketplace/catalog.js";
import { listShellEnvSecretFields } from "../shell-tools/shell-secrets.js";
import { listConnectorEnvSecretFields } from "./connector-secrets.js";
import {
  readLocalConnectorFile,
  removeLocalConnectorEntry,
  writeLocalConnectorEntry,
} from "./local-connectors.js";

export interface MarketplacePluginField {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly isRequired: boolean;
  readonly isSecret: boolean;
  readonly isStored: boolean;
}

export interface MarketplacePluginSummary {
  readonly pluginId: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly kind: string;
  readonly isInstalled: boolean;
  readonly installMode?: string;
  readonly connectorCount: number;
  readonly skills: readonly { readonly name: string; readonly description: string }[];
}

export interface MarketplacePluginDetail extends MarketplacePluginSummary {
  readonly fields: readonly MarketplacePluginField[];
  readonly servers: readonly Record<string, unknown>[];
}

/** What the host must be able to read to answer "is this installed, and is its key stored?". */
export interface MarketplaceInstallReader {
  /** The sand data root: connectors.json and the 0600 secret store both live there. */
  rootDir(): string;
}

function connectorInstalled(reader: MarketplaceInstallReader, plugin: MarketplacePlugin): boolean {
  const name = plugin.connectorName;
  if (name == null) return false;
  return Object.hasOwn(readLocalConnectorFile(reader.rootDir()), name);
}

function storedFieldsFor(reader: MarketplaceInstallReader, plugin: MarketplacePlugin): Set<string> {
  const root = reader.rootDir();
  return new Set(plugin.kind === "shell-tool"
    ? listShellEnvSecretFields(root)
    : plugin.connectorName == null ? [] : listConnectorEnvSecretFields(root, plugin.connectorName));
}

export function marketplacePluginIsInstalled(reader: MarketplaceInstallReader, plugin: MarketplacePlugin): boolean {
  if (plugin.opensEditor === true) return false;
  if (plugin.kind === "shell-tool") {
    const stored = storedFieldsFor(reader, plugin);
    return marketplaceCredentialFields(plugin).some((field) => stored.has(field));
  }
  return connectorInstalled(reader, plugin);
}

export function marketplacePluginFields(
  reader: MarketplaceInstallReader,
  plugin: MarketplacePlugin,
): MarketplacePluginField[] {
  const stored = storedFieldsFor(reader, plugin);
  return marketplaceCredentialFields(plugin).map((key) => ({
    key,
    // The environment variable name IS what the operator fills, so it is the honest label; the
    // sentence that says where the value is minted rides in `hint`, which the tool prints.
    label: key,
    hint: plugin.credentialHints[key] ?? "",
    isRequired: true,
    isSecret: true,
    isStored: stored.has(key),
  }));
}

export function marketplacePluginSummary(
  reader: MarketplaceInstallReader,
  plugin: MarketplacePlugin,
): MarketplacePluginSummary {
  const isInstalled = marketplacePluginIsInstalled(reader, plugin);
  return {
    pluginId: plugin.id,
    name: plugin.id,
    displayName: plugin.name,
    description: plugin.tagline,
    category: plugin.category,
    kind: plugin.kind,
    isInstalled,
    ...(isInstalled ? { installMode: "local" } : {}),
    connectorCount: plugin.kind === "connector" && plugin.install != null ? 1 : 0,
    skills: [],
  };
}

export function listMarketplacePluginSummaries(reader: MarketplaceInstallReader): MarketplacePluginSummary[] {
  return searchMarketplacePlugins("").map((plugin) => marketplacePluginSummary(reader, plugin));
}

export function getMarketplacePluginDetail(
  reader: MarketplaceInstallReader,
  pluginId: string,
  servers: readonly Record<string, unknown>[],
): MarketplacePluginDetail | null {
  const plugin = findMarketplacePlugin(pluginId);
  if (plugin == null) return null;
  const attributed = plugin.connectorName == null
    ? []
    : servers.filter((server) => server.serverIdentifier === plugin.connectorName);
  return {
    ...marketplacePluginSummary(reader, plugin),
    fields: marketplacePluginFields(reader, plugin),
    servers: attributed,
  };
}

export interface MarketplaceInstallOutcome {
  readonly pluginId: string;
  readonly kind: string;
  readonly installed: boolean;
  /** What the operator must still fill on the plugin page. The model cannot set a key. */
  readonly fields: readonly MarketplacePluginField[];
  /** Set when nothing was written and why. */
  readonly refused?: string;
}

/**
 * Writes the catalog entry through the host's own connectors.json door -- the same file, bytes and
 * 0600 the console's `POST /connectors` produces -- and answers with the credential fields still
 * empty. The caller reloads the servers; writing the file does not start the process.
 *
 * A shell-tool plugin is NOT installed from here: its install runs a command inside the box and
 * belongs to `installShellTool`, so this answers with the field to fill and says so.
 */
export function installMarketplacePlugin(
  reader: MarketplaceInstallReader,
  pluginId: string,
): MarketplaceInstallOutcome | null {
  const plugin = findMarketplacePlugin(pluginId);
  if (plugin == null) return null;
  if (plugin.opensEditor === true) {
    return {
      pluginId: plugin.id,
      kind: plugin.kind,
      installed: false,
      fields: [],
      refused: `"${plugin.name}" is the connector editor, not an entry: it has no command to install. Ask the operator for the server's command, arguments and environment variable names and use AddMcpServer.`,
    };
  }
  const shellToolId = marketplaceShellToolId(plugin);
  if (shellToolId != null) {
    return {
      pluginId: plugin.id,
      kind: plugin.kind,
      installed: marketplacePluginIsInstalled(reader, plugin),
      fields: marketplacePluginFields(reader, plugin),
      refused: `"${plugin.name}" is a shell tool: it is installed by running its install command inside the box (shell tool "${shellToolId}"), which the operator does from the Marketplace page. Nothing was written to connectors.json.`,
    };
  }
  const entry = marketplaceConnectorEntry(plugin);
  const name = plugin.connectorName;
  if (entry == null || name == null) return null;
  writeLocalConnectorEntry(reader.rootDir(), name, entry);
  return {
    pluginId: plugin.id,
    kind: plugin.kind,
    installed: true,
    fields: marketplacePluginFields(reader, plugin),
  };
}

export interface MarketplaceUninstallOutcome {
  readonly pluginId: string;
  readonly removed: boolean;
  readonly reason?: string;
  /** Credential names still in the store afterwards. The uninstall does not clear them. */
  readonly storedFields: readonly string[];
}

/** Removes the entry from connectors.json. The 0600 secret store is deliberately left alone. */
export function uninstallMarketplacePlugin(
  reader: MarketplaceInstallReader,
  pluginId: string,
): MarketplaceUninstallOutcome | null {
  const plugin = findMarketplacePlugin(pluginId);
  if (plugin == null) return null;
  const name = plugin.connectorName;
  if (name == null) {
    return {
      pluginId: plugin.id,
      removed: false,
      reason: `"${plugin.name}" has no connectors.json entry to remove.`,
      storedFields: [...storedFieldsFor(reader, plugin)],
    };
  }
  const removed = removeLocalConnectorEntry(reader.rootDir(), name);
  return {
    pluginId: plugin.id,
    removed,
    ...(removed ? {} : { reason: `"${plugin.name}" is not in connectors.json.` }),
    storedFields: [...storedFieldsFor(reader, plugin)],
  };
}
