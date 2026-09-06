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
 * connectors.json, and a shell-tool plugin when the box's own shell can find its program
 * (`command -v <binary>`, the probe beside `runShellToolInstall`). A credential field is "stored"
 * when the 0600 secret store holds it, and that is a SEPARATE question -- a stored key with no
 * program installed is a command the agent would report as available and then fail to run, and a
 * program installed with no key is a tool the operator would be told to install twice.
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
import { findShellTool, type ShellToolEntry } from "../shell-tools/shell-tool-catalog.js";
import { listShellEnvSecretFields } from "../shell-tools/shell-secrets.js";
import { probeShellToolBinary, runShellToolInstall } from "../shell-tools/shell-tools-service.js";
import { listConnectorEnvSecretFields } from "./connector-secrets.js";
import {
  hasLocalConnectorEntry,
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
  /**
   * Ask the box's shell whether a tool's program is there. Defaults to the real probe; a test
   * overrides it so a machine that happens to have `cr` on its PATH does not decide the assertion.
   */
  probeShellTool?(entry: ShellToolEntry): Promise<boolean>;
}

function connectorInstalled(reader: MarketplaceInstallReader, plugin: MarketplacePlugin): boolean {
  const name = plugin.connectorName;
  if (name == null) return false;
  return hasLocalConnectorEntry(reader.rootDir(), name);
}

function storedFieldsFor(reader: MarketplaceInstallReader, plugin: MarketplacePlugin): Set<string> {
  const root = reader.rootDir();
  return new Set(plugin.kind === "shell-tool"
    ? listShellEnvSecretFields(root)
    : plugin.connectorName == null ? [] : listConnectorEnvSecretFields(root, plugin.connectorName));
}

function shellToolEntryFor(plugin: MarketplacePlugin): ShellToolEntry | null {
  const id = marketplaceShellToolId(plugin);
  return id == null ? null : findShellTool(id) ?? null;
}

/**
 * Whether the box can actually run this shell tool's program. NOT whether its key is stored: the
 * key's truth stays in the field's `isStored`, where it answers the question it is about.
 */
async function shellToolInstalled(reader: MarketplaceInstallReader, plugin: MarketplacePlugin): Promise<boolean> {
  const entry = shellToolEntryFor(plugin);
  if (entry == null) return false;
  return reader.probeShellTool == null ? probeShellToolBinary(entry) : reader.probeShellTool(entry);
}

export async function marketplacePluginIsInstalled(
  reader: MarketplaceInstallReader,
  plugin: MarketplacePlugin,
): Promise<boolean> {
  if (plugin.opensEditor === true) return false;
  if (plugin.kind === "shell-tool") return shellToolInstalled(reader, plugin);
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

export async function marketplacePluginSummary(
  reader: MarketplaceInstallReader,
  plugin: MarketplacePlugin,
): Promise<MarketplacePluginSummary> {
  const isInstalled = await marketplacePluginIsInstalled(reader, plugin);
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

export async function listMarketplacePluginSummaries(
  reader: MarketplaceInstallReader,
): Promise<MarketplacePluginSummary[]> {
  return Promise.all(searchMarketplacePlugins("").map((plugin) => marketplacePluginSummary(reader, plugin)));
}

export async function getMarketplacePluginDetail(
  reader: MarketplaceInstallReader,
  pluginId: string,
  servers: readonly Record<string, unknown>[],
): Promise<MarketplacePluginDetail | null> {
  const plugin = findMarketplacePlugin(pluginId);
  if (plugin == null) return null;
  const attributed = plugin.connectorName == null
    ? []
    : servers.filter((server) => server.serverIdentifier === plugin.connectorName);
  return {
    ...await marketplacePluginSummary(reader, plugin),
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
  /** Set when this call changed nothing on the box, and why. */
  readonly refused?: string;
}

/**
 * Writes the catalog entry through the host's own connectors.json door -- the same file, bytes and
 * 0600 the console's `POST /connectors` produces -- and answers with the credential fields still
 * empty. The caller reloads the servers; writing the file does not start the process.
 *
 * A shell-tool plugin goes through `runShellToolInstall`, the SAME door the console's "Install in
 * the box" button uses, rather than being refused: refusing meant two of the catalog's nine plugins
 * could not be installed by the agent at all, which is not the credential exception -- a key is
 * still the operator's to type, and that is what the fields in the answer are for.
 *
 * An entry already in connectors.json is never rewritten. The catalog is not the authority on an
 * entry the operator has since edited (different arguments, extra env names, `disabled: true`), and
 * a silent overwrite would revert those and orphan the secrets stored against the dropped names.
 */
export async function installMarketplacePlugin(
  reader: MarketplaceInstallReader,
  pluginId: string,
): Promise<MarketplaceInstallOutcome | null> {
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
  const shellEntry = shellToolEntryFor(plugin);
  if (shellEntry != null) return installShellToolPlugin(reader, plugin, shellEntry);
  const entry = marketplaceConnectorEntry(plugin);
  const name = plugin.connectorName;
  if (entry == null || name == null) return null;
  if (connectorInstalled(reader, plugin)) {
    return {
      pluginId: plugin.id,
      kind: plugin.kind,
      installed: true,
      fields: marketplacePluginFields(reader, plugin),
      refused: `"${plugin.name}" is already installed: "${name}" is in connectors.json and nothing was written. If its entry differs from the catalog's, that is the operator's edit and it is theirs to change in the connector editor (Marketplace \u2192 Plugins \u2192 ${plugin.name}).`,
    };
  }
  writeLocalConnectorEntry(reader.rootDir(), name, entry);
  return {
    pluginId: plugin.id,
    kind: plugin.kind,
    installed: true,
    fields: marketplacePluginFields(reader, plugin),
  };
}

/**
 * Runs the shell tool's install command inside the box, capped by `runShellToolInstall`'s own
 * timeout, and re-probes rather than trusting the exit code: an installer that exits 0 without
 * putting its program on PATH has not installed anything. The installer's output tail rides in the
 * refusal on failure -- it is already stripped of every stored value by `redactShellSecretValues`.
 */
async function installShellToolPlugin(
  reader: MarketplaceInstallReader,
  plugin: MarketplacePlugin,
  entry: ShellToolEntry,
): Promise<MarketplaceInstallOutcome> {
  const answer = (installed: boolean, refused?: string): MarketplaceInstallOutcome => ({
    pluginId: plugin.id,
    kind: plugin.kind,
    installed,
    fields: marketplacePluginFields(reader, plugin),
    ...(refused == null ? {} : { refused }),
  });
  if (await shellToolInstalled(reader, plugin)) {
    return answer(true, `"${plugin.name}" is already installed: the box's shell finds \`${entry.binary}\`, so nothing was run.`);
  }
  const result = await runShellToolInstall(entry, { rootDir: reader.rootDir() });
  if (await shellToolInstalled(reader, plugin)) return answer(true);
  const why = result.timedOut
    ? "it was still running after five minutes and was killed"
    : `it exited ${result.exitCode == null ? "without a status" : String(result.exitCode)}`;
  return answer(false, `"${plugin.name}" was not installed: \`${result.command}\` ran in the box and ${why}, and the shell still cannot find \`${entry.binary}\`. The tail of its output was:\n${result.output}`);
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
    const shell = shellToolEntryFor(plugin);
    return {
      pluginId: plugin.id,
      removed: false,
      reason: shell == null
        ? `"${plugin.name}" has no connectors.json entry to remove.`
        : `"${plugin.name}" is a shell tool: it put \`${shell.binary}\` in the box and there is no uninstall for that on this host. Tell the operator to remove the program themselves; its stored key is cleared separately, on the plugin's page.`,
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
