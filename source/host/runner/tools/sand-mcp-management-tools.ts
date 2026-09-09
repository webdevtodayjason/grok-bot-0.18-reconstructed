import { z } from "zod";
import { getDefaultMcpCustomInstruction } from "../../../shared/mcp-custom-instructions.js";
import {
  decodeMcpAccountLabelArgument,
  encodeMcpAccountLabelForListing,
  formatMcpAccountLabelForPrompt,
} from "../../../shared/mcp.js";
import { isMcpServerId } from "../../../shared/node/mcp/mcp-server-id.js";
import {
  credentialPlaceholderNames,
  localRemoteUrlRefusal,
} from "../../extensions/mcp/local-connectors.js";
import { defineCommunicateTool } from "./communicate-tool.js";
import {
  readMcpInstalledListing,
  resolveMcpServerRowByIdentifierOrLegacyId,
  resolveMcpServerRowsByIdentifierOrLegacyId,
} from "./mcp-server-resolution.js";

export interface McpInstalledServer {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly serverIdentifier: string;
  readonly name: string;
  readonly status: string;
  readonly accountKey: string;
  readonly transport: string;
  readonly toolCount: number;
  readonly disabledToolCount?: number;
  readonly pluginId?: string;
  readonly statusDetail?: string;
  readonly customInstructions: string;
  readonly isTeamServer?: boolean;
}

export interface McpPluginSummary {
  readonly pluginId: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  /** MARKET-1: "connector" (an entry in connectors.json) or "shell-tool" (a CLI in the box). */
  readonly kind?: string;
  readonly isInstalled: boolean;
  readonly installMode?: string;
  readonly connectorCount: number;
  readonly skills: readonly { readonly name: string; readonly description: string }[];
}

export interface McpPluginDetail extends McpPluginSummary {
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly isRequired: boolean;
    readonly isSecret: boolean;
    /** One line: what the value is and where it is minted. Never a value. */
    readonly hint?: string;
    /** Whether the HOST already holds a value for this field. Never the value itself. */
    readonly isStored?: boolean;
  }[];
  readonly servers: readonly McpInstalledServer[];
}

export type McpAuthenticationResult =
  | { readonly kind: "started"; readonly serverName: string }
  | { readonly kind: "already-authenticated"; readonly serverName: string }
  | { readonly kind: "not-configured"; readonly serverName: string }
  | { readonly kind: "not-supported"; readonly serverName: string; readonly message: string }
  | { readonly kind: "unreachable"; readonly serverName: string; readonly message: string };

export interface McpManagementDependencies {
  listPlugins(): Promise<readonly McpPluginSummary[]>;
  getPlugin(pluginId: string): Promise<McpPluginDetail | null>;
  /**
   * MARKET-1: answers what the install did. A connector entry is written and the fields the
   * operator must fill come back; a shell tool or the connector-editor card comes back `refused`
   * with the reason, because neither is installed by writing connectors.json.
   */
  install(args: { readonly id: string; readonly values?: Readonly<Record<string, string>> }): Promise<{
    readonly installed?: boolean;
    readonly refused?: string;
  } | void>;
  add(args: { readonly name: string; readonly configJson: string }): Promise<readonly McpInstalledServer[]>;
  /**
   * MARKET-6. Remove one connector THIS box owns, with the offer to clear the key it leaves behind.
   * Optional so a host that predates the one writer keeps working through `removeServer`; the real
   * host has it, and it is the only path that can clear a secret whose entry has already gone
   * (CONNECT-11).
   */
  removeConnector?(args: { readonly server: string; readonly clearSecrets: boolean }): Promise<{
    readonly removed: boolean;
    readonly cleared: readonly string[];
  }>;
  /** One server's tools, so a status read can say what the thing actually offers. Optional. */
  listServerTools?(serverId: string): Promise<readonly { readonly name: string; readonly description?: string; readonly enabled?: boolean }[]>;
  listInstalled(): Promise<readonly McpInstalledServer[]>;
  removeServer(serverId: string): Promise<{
    readonly removed: boolean;
    readonly reason?: string;
    readonly servers: readonly McpInstalledServer[];
  }>;
  uninstallPlugin(pluginId: string): Promise<{ readonly removed: boolean; readonly reason?: string }>;
  setInstructions(args: { readonly serverId: string; readonly instructions: string }): Promise<readonly McpInstalledServer[]>;
  restart(): Promise<readonly McpInstalledServer[]>;
  authenticate(serverId: string, accountKey: string, requestingAgentId: string | null, forceReauth: boolean): Promise<McpAuthenticationResult>;
  removeAccount(args: { readonly serverId: string; readonly accountKey: string }): Promise<readonly McpInstalledServer[]>;
  renameAccount(args: { readonly serverId: string; readonly accountKey: string; readonly newAccountKey: string }): Promise<readonly McpInstalledServer[]>;
}

export interface ConnectorCard {
  readonly connector: string;
  readonly serverId: string;
  readonly variant: "connect" | "connected";
}

export const searchPluginsParameters = z.object({
  query: z.string().trim().optional().describe(
    `Optional. What you're looking for, in natural language (e.g. "manage linear issues" or "write word documents") \u2014 results come back ranked by relevance. Omit to list the whole catalog.`,
  ),
});
export const getPluginParameters = z.object({
  plugin_id: z.string().trim().min(1).describe("The stable plugin id from SearchPlugins."),
});
export const installPluginParameters = z.object({
  plugin_id: z.string().trim().min(1).describe("The stable plugin id from SearchPlugins."),
  values: z.record(z.string(), z.string()).optional().describe(
    "Ignored on this box, and deliberately: a credential typed here would land in the transcript. The user stores every key themselves on the plugin's page in the Marketplace, so leave this out and tell them which field to fill.",
  ),
});
export const addMcpServerParameters = z.object({
  name: z.string().trim().min(1).describe('A short, unique name for the server, e.g. "superpowers".'),
  url: z.string().trim().min(1).optional().describe(
    "For a server the box connects to over the network: its MCP endpoint (https). Give this OR `command`, not both.",
  ),
  type: z.enum(["http", "sse"]).optional().describe(
    'Transport for a `url` server. Leave it out for the usual one (streamable HTTP); pass "sse" only when the server\'s own docs say SSE.',
  ),
  headers: z.record(z.string(), z.string()).optional().describe(
    'Optional HTTP headers for a `url` server. A header that carries a key must be written as a PLACEHOLDER naming the field, e.g. { "Authorization": "Bearer ${ACME_TOKEN}" } \u2014 never the key itself. The user types the value into a masked box and the box substitutes it when it connects.',
  ),
  command: z.string().trim().min(1).optional().describe(
    'For a server the box RUNS: the program, e.g. "npx". Give this OR `url`, not both.',
  ),
  args: z.array(z.string()).optional().describe(
    'Arguments for `command`, e.g. ["-y", "@acme/mcp-server@1.2.3"]. Pin the version.',
  ),
  env: z.array(z.string()).optional().describe(
    'Environment variable NAMES the program needs for its key, e.g. ["ACME_TOKEN"] \u2014 names only, never values. The user types each value into a masked box.',
  ),
});

export const PLUGIN_QUERY_MIN_TOKEN_LENGTH = 3;

export function tokenizePluginQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(
    (token) => token.length >= PLUGIN_QUERY_MIN_TOKEN_LENGTH,
  ))];
}

export function scorePluginForToken(plugin: McpPluginSummary, token: string): number {
  const name = plugin.name.toLowerCase();
  const displayName = plugin.displayName.toLowerCase();
  if (name === token || displayName === token) return 8;
  if (name.includes(token) || displayName.includes(token)) return 5;
  if (plugin.skills.some((skill) => skill.name.toLowerCase().includes(token))) return 3;
  if (plugin.category.toLowerCase().includes(token)) return 2;
  if (plugin.description.toLowerCase().includes(token)) return 1;
  return 0;
}

export function rankPluginsLexically<T extends McpPluginSummary>(plugins: readonly T[], query: string): T[] {
  const tokens = tokenizePluginQuery(query);
  const byName = (left: T, right: T): number => left.displayName.localeCompare(right.displayName);
  if (tokens.length === 0) return [...plugins].sort(byName);
  return plugins.map((plugin) => ({
    plugin,
    score: tokens.reduce((sum, token) => sum + scorePluginForToken(plugin, token), 0),
  })).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || byName(left.plugin, right.plugin))
    .map((entry) => entry.plugin);
}

/**
 * MARKET-6. The SAME rules the one writer holds, asked early so the model gets a sentence it can
 * act on instead of a refusal from three layers down. It is the writer's own function, imported
 * rather than restated, because this check drifting from the one that actually guards the file is
 * how the reserved-name rule ended up made in four places and enforced in three.
 *
 * What used to be here said the URL must be http(s) "because Grok Bot only connects remote http/sse
 * MCP servers over HTTP(S)" -- the retired product name, and the exact inverse of what is true on
 * this box, where every connector that works is a program the box runs.
 */
export function validateRemoteMcpUrl(rawUrl: string): string | null {
  return localRemoteUrlRefusal(rawUrl);
}

/**
 * MARKET-6. A credential the model typed is a credential in the transcript, so a header or an
 * environment value that is not a `${FIELD}` placeholder is refused with the one thing the model
 * should do instead: name the field and let the person put the value in the masked box.
 *
 * Headers that carry no key are left alone. A vendor's docs really do ask for
 * `x-mcp-servers: acme` or an Accept header, and refusing those would make a documented server
 * unaddable for no gain in custody.
 */
const AUTH_HEADER_PATTERN = /^(authorization|proxy-authorization|cookie|api[-_]?key|x-api-key|x-auth-token|x-access-token|x-[a-z0-9-]*-(key|token|secret))$/i;

export function credentialLiteralRefusal(
  name: string,
  headers: Readonly<Record<string, string>> | undefined,
  env: readonly string[] | undefined,
): string | null {
  for (const [header, value] of Object.entries(headers ?? {})) {
    if (!AUTH_HEADER_PATTERN.test(header.trim())) continue;
    if (credentialPlaceholderNames(value).length > 0) continue;
    const field = `${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_TOKEN`;
    return `Don't put the key in the "${header}" header. Add the server with "${header}": "${value.trim().split(/\s+/)[0] === "Bearer" ? "Bearer " : ""}\${${field}}" instead, then tell the user to type the value into the masked box on the ${name} page \u2014 a key you type here is stored in this conversation.`;
  }
  for (const field of env ?? []) {
    if (field.includes("=")) {
      // The name, never the pair. Quoting `field` back would put the value the model just typed
      // into the refusal, and a refusal is read by the model and kept in the transcript, so it
      // would land the key in the two places refusing it exists to keep it out of. The header
      // branch above has always been careful about this; this one was not.
      const named = field.split("=")[0];
      return `Send only the NAME of the environment variable. You sent "${named}" with its value attached; pass env: ["${named}"] and tell the user to type the value into the masked box on the ${name} page \u2014 a key you type here is stored in this conversation.`;
    }
  }
  return null;
}

/**
 * MARKET-6. Both shapes, because both work here. A `url` server is one the box connects to
 * itself; a `command` server is one it runs. Environment NAMES land with the value empty, which
 * is how this box marks "the operator still owes a key" and what makes the masked card offer it.
 */
export function buildServerConfigJson(args: {
  readonly url?: string | undefined;
  readonly type?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: readonly string[] | undefined;
}): string | null {
  if (args.url != null && args.url.length > 0) {
    return JSON.stringify({
      type: args.type === "sse" ? "sse" : "http",
      url: args.url,
      ...(args.headers != null && Object.keys(args.headers).length > 0 ? { headers: args.headers } : {}),
    });
  }
  if (args.command == null || args.command.length === 0) return null;
  return JSON.stringify({
    command: args.command,
    ...(args.args != null && args.args.length > 0 ? { args: [...args.args] } : {}),
    ...(args.env != null && args.env.length > 0
      ? { env: Object.fromEntries(args.env.map((field) => [field, ""])) }
      : {}),
  });
}

export function truncateOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function describeInstalled(server: McpInstalledServer): string {
  const parts = [
    `- ${server.serverIdentifier}: ${server.name} [${server.status}]`,
    `account=${encodeMcpAccountLabelForListing(server.accountKey)}`,
    `transport=${server.transport}`,
    server.disabledToolCount != null && server.disabledToolCount > 0
      ? `tools=${server.toolCount}/${server.toolCount + server.disabledToolCount} enabled`
      : `tools=${server.toolCount}`,
  ];
  if (server.pluginId != null) parts.push(`plugin=${server.pluginId} (remove via UninstallPlugin — removes the whole plugin)`);
  // MARKET-6. The host's own sentence first. The raw detail behind a failure is a Node stack with a
  // vendor's file paths in it, and reading that to a person is how a wrong key became "MCP error
  // -32000: Connection closed; stderr: ... at EventSource.failConnection_fn".
  const sentence = typeof server.statusSentence === "string" ? server.statusSentence : "";
  if (sentence.length > 0) parts.push(sentence);
  else if (server.statusDetail != null && server.statusDetail.length > 0) parts.push(`detail="${truncateOneLine(server.statusDetail, 200)}"`);
  if (server.customInstructions.length > 0 && server.customInstructions !== getDefaultMcpCustomInstruction(server.name)) {
    parts.push(`instructions="${truncateOneLine(server.customInstructions, 120)}"`);
  }
  return parts.join(" · ");
}

export function describeInstalledList(servers: readonly McpInstalledServer[]): string {
  return servers.length === 0
    ? "No MCP servers are installed."
    : [`${servers.length} installed MCP server(s):`, ...servers.map(describeInstalled)].join("\n");
}

function describePluginInstallState(plugin: McpPluginSummary): string {
  if (!plugin.isInstalled) return "installed=no";
  return plugin.installMode != null ? `installed=yes (${plugin.installMode})` : "installed=yes";
}

function describePluginIncludes(plugin: McpPluginSummary): string {
  const parts: string[] = [];
  if (plugin.connectorCount > 0) parts.push(`${plugin.connectorCount} connector${plugin.connectorCount === 1 ? "" : "s"}`);
  // MARKET-1: a shell tool adds a command-line program to the box rather than an MCP server, so
  // "no primitives" would be a plain untruth about CodeRabbit and the TinyFish CLI.
  if (plugin.kind === "shell-tool") parts.push("1 shell tool");
  if (plugin.skills.length > 0) parts.push(`${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : "no primitives";
}

export function describePluginSummary(plugin: McpPluginSummary): string {
  const result = [
    `- ${plugin.pluginId}: ${plugin.displayName} \u2014 ${plugin.description}`,
    `  (${[
      describePluginInstallState(plugin),
      `includes: ${describePluginIncludes(plugin)}`,
      `category=${plugin.category}`
    ].join("; ")})`,
  ];
  const guidance = getDefaultMcpCustomInstruction(plugin.displayName);
  if (guidance.length > 0) result.push(`  usage guidance: ${guidance}`);
  return result.join("\n");
}

export function describePluginDetail(detail: McpPluginDetail): string {
  const sections = [
    `${detail.pluginId}: ${detail.displayName} \u2014 ${detail.description}`,
    `${describePluginInstallState(detail)} \xB7 includes: ${describePluginIncludes(detail)} \xB7 category=${detail.category}`,
  ];
  if (detail.skills.length > 0) {
    sections.push(["Skills:", ...detail.skills.map((skill) =>
      `  - ${skill.name}${skill.description.length > 0 ? ` \u2014 ${truncateOneLine(skill.description, 140)}` : ""}`,
    )].join("\n"));
  }
  if (detail.fields.length > 0) {
    // MARKET-1. These are credential fields the OPERATOR fills on the plugin's page in the
    // Marketplace: a key typed into a conversation is in the transcript, the model's context and
    // whatever window that was compacted into, so the model never sets one. `stored` is the only
    // thing said about a value, and it is a boolean.
    sections.push(["Credential fields (the user fills these on the plugin's page; you cannot set a key):", ...detail.fields.map((field) => {
      const flags = [
        field.isRequired ? "required" : "optional",
        field.isStored === true ? "the host already holds a value" : "not stored yet",
      ];
      const hint = field.hint == null || field.hint.length === 0 ? "" : ` ${truncateOneLine(field.hint, 300)}`;
      return `  - ${field.key} (${flags.join(", ")})${hint}`;
    })].join("\n"));
  }
  if (detail.servers.length > 0) sections.push(["Its installed MCP server(s) — statuses live in GetMcpServerStatus:", ...detail.servers.map(describeInstalled)].join("\n"));
  if (detail.isInstalled && detail.installMode === "team-required") sections.push("Required by the user's team — it cannot be uninstalled.");
  return sections.join("\n");
}

export const CARD_SHOWN_NOTE = "Its connect card is now in the chat. Finish unrelated work, then end your turn — you're resumed automatically when the user authorizes. Don't send a link, another card, or reach the service another way meanwhile.";
export const MCP_AWAITING_SELECTION_MESSAGE = "You just sent a question widget, so this turn is waiting on the user's selection — their answer arrives as the next message. Don't install, uninstall, restart, or authenticate an MCP server in the same turn as the confirmation widget; wait for the user to confirm, then do it on your next turn.";

export function newNeedsAuthRows(before: readonly McpInstalledServer[], after: readonly McpInstalledServer[]): Array<{ id: string; name: string }> {
  const prior = new Set(before.map((server) => server.serverIdentifier));
  const rows = new Map<string, string>();
  for (const server of after) {
    if (!prior.has(server.serverIdentifier) && server.status === "needsAuth") rows.set(server.id, server.name);
  }
  return [...rows].map(([id, name]) => ({ id, name }));
}

export function emitAndDescribeAuthResult(
  result: McpAuthenticationResult,
  isForceReauth: boolean,
  serverId: string,
  emitConnectorCard?: (card: ConnectorCard) => void,
): string {
  switch (result.kind) {
    case "started":
      emitConnectorCard?.({ connector: result.serverName, serverId, variant: "connect" });
      return isForceReauth
        ? `Signed "${result.serverName}" out and started a fresh sign-in. ${CARD_SHOWN_NOTE}`
        : `Authentication started for "${result.serverName}". ${CARD_SHOWN_NOTE}`;
    case "already-authenticated":
      emitConnectorCard?.({ connector: result.serverName, serverId, variant: "connected" });
      return `"${result.serverName}" is already authenticated and connected; a confirmation card is now in the chat.`;
    case "not-configured": return `"${result.serverName}" is not installed, so there is nothing to authenticate. Install it first.`;
    case "not-supported": return `"${result.serverName}" does not support interactive authentication: ${result.message}`;
    case "unreachable": return `Sign-in for "${result.serverName}" never started. The server or its configuration failed the check: "${result.message}" \u2014 not a missing credential, so the user authenticating in Settings would hit the same error. Tell them what it reported instead of sending them to Settings.`;
  }
}

const serverIdParameters = z.object({ server_id: z.string().trim().min(1) });
const uninstallServerParameters = serverIdParameters.extend({
  clear_stored_values: z.boolean().optional().describe(
    "Also clear the key the user stored for this server. Ask them first; the default keeps it, so re-adding the server needs no fresh key.",
  ),
});
const statusParameters = z.object({ server_id: z.string().trim().optional() });
const instructionsParameters = serverIdParameters.extend({ instructions: z.string() });
const forceReauth = z.boolean().optional();
const authParameters = serverIdParameters.extend({ force_reauth: forceReauth });
const multiAuthParameters = authParameters.extend({ account_label: z.string().trim().min(1) });
const accountParameters = serverIdParameters.extend({ account_label: z.string().trim().min(1) });
const renameParameters = accountParameters.extend({ new_account_label: z.string().trim().min(1) });

function noInstalledServerMessage(token: string): string {
  return `No installed MCP server "${token}". Run GetMcpServerStatus to list every server with its identifier.`;
}

export function createMcpManagementTools(
  management: McpManagementDependencies,
  getRequestingAgentId?: () => string | undefined,
  isAwaitingUserSelection?: () => boolean,
  isMultiAccountEnabled?: () => boolean,
  emitConnectorCard?: (card: ConnectorCard) => void,
) {
  const multiAccount = isMultiAccountEnabled?.() === true;
  const guardMutation = <A>(execute: (ctx: unknown, args: A, deps: McpManagementDependencies & { toolCallId: string }) => Promise<string>) =>
    async (ctx: unknown, args: A, deps: McpManagementDependencies & { toolCallId: string }): Promise<string> =>
      isAwaitingUserSelection?.() === true ? MCP_AWAITING_SELECTION_MESSAGE : execute(ctx, args, deps);

  const resolveServerId = async (deps: McpManagementDependencies, token: string): Promise<string | null> => {
    const trimmed = token.trim();
    if (isMcpServerId(trimmed)) return trimmed;
    const listing = await readMcpInstalledListing(() => deps.listInstalled());
    return listing.kind === "unreadable" ? trimmed : resolveMcpServerRowByIdentifierOrLegacyId(listing.servers, trimmed)?.id ?? null;
  };

  const emitNeedsAuthCards = (before: readonly McpInstalledServer[], after: readonly McpInstalledServer[]): string | null => {
    const rows = newNeedsAuthRows(before, after);
    if (rows.length === 0 || emitConnectorCard == null) return null;
    for (const row of rows) emitConnectorCard({ connector: row.name, serverId: row.id, variant: "connect" });
    return rows.length === 1
      ? `"${rows[0]?.name ?? "Connector"}" needs authentication. ${CARD_SHOWN_NOTE}`
      : `${rows.map((row) => `"${row.name}"`).join(", ")} need authentication. ${CARD_SHOWN_NOTE}`;
  };

  const tools = [
    defineCommunicateTool(management, {
      id: "SEARCH_PLUGINS", name: "SearchPlugins", description: "Search the Marketplace — the plugins this box can install, and the ones it already has. A plugin is either a connector (an MCP server the box runs) or a shell tool (a CLI the box installs). Say what you're looking for in natural language; results come back ranked, each with its STABLE plugin id, its install state and what it includes. Use this to discover a capability (GitHub, Slack, Linear, web search, code review, …) or to check whether something is installed. Inspect one result with GetPlugin; connector runtime statuses (connected/needsAuth) live in GetMcpServerStatus. This is read-only and never needs the user's permission.", parameters: searchPluginsParameters,
      execute: async (_ctx, args: z.infer<typeof searchPluginsParameters>, deps) => {
        const query = (args.query ?? "").trim();
        const plugins = rankPluginsLexically(await deps.listPlugins(), query);
        if (plugins.length === 0) return query.length > 0 ? `No plugins in the Marketplace match "${query}".` : "The Marketplace catalog is empty.";
        return [`${plugins.length} plugin(s)${query.length > 0 ? ` matching "${query}" (best first)` : " available"}:`, ...plugins.map(describePluginSummary)].join("\n");
      },
    }),
    defineCommunicateTool(management, {
      id: "GET_PLUGIN", name: "GetPlugin", description: "Full detail for one Marketplace plugin by its STABLE plugin id (from SearchPlugins): what it includes, its install state, its credential fields with a line each on where the value is minted and whether the host already holds it, and the MCP server backing it. Read this before installing and before uninstalling (to know the full scope you must disclose). You cannot set a credential — the user fills these on the plugin's page in the Marketplace. Read-only.", parameters: getPluginParameters,
      execute: async (_ctx, args: z.infer<typeof getPluginParameters>, deps) => {
        const detail = await deps.getPlugin(args.plugin_id);
        return detail == null ? `No plugin with id "${args.plugin_id}".` : describePluginDetail(detail);
      },
    }),
    defineCommunicateTool(management, {
      id: "INSTALL_PLUGIN", name: "InstallPlugin", description: "Install a Marketplace plugin by its STABLE plugin id (from SearchPlugins) onto this box: for a connector it writes the entry and reloads the MCP servers. Only call this after the user has agreed — confirm with a question widget first, since installing changes their configuration. A plugin that is already installed is left exactly as it is: the answer says so and nothing is written, because the entry on the box may be one the user has since edited. You CANNOT set a credential — a key typed into a conversation ends up in the transcript, so the answer names the fields the user has to fill on the plugin's page in the Marketplace, and you tell them to go there. A shell-tool plugin installs from here too: its install command runs inside the box — the same one the plugin page's button runs — and it can take minutes. New tools become available to you on your next message.", parameters: installPluginParameters,
      execute: guardMutation(async (_ctx, args: z.infer<typeof installPluginParameters>, deps) => {
        const before = await deps.getPlugin(args.plugin_id);
        if (before == null) return `No plugin with id "${args.plugin_id}".`;
        const outcome = await deps.install({ id: args.plugin_id, ...(args.values == null ? {} : { values: args.values }) });
        const refused = outcome == null ? undefined : outcome.refused;
        if (refused != null) return [refused, describePluginDetail(before)].join("\n");
        const after = await deps.getPlugin(args.plugin_id);
        if (after == null || !after.isInstalled) return `The install request for "${before.displayName}" completed, but the plugin does not read as installed yet.`;
        const note = emitNeedsAuthCards(before.servers, after.servers);
        const unfilled = after.fields.filter((field) => field.isStored !== true).map((field) => field.key);
        const ask = unfilled.length === 0
          ? []
          : [`It cannot connect until the user stores ${unfilled.join(", ")} on its page in the Marketplace (Marketplace → Plugins → ${after.displayName} → Accounts). Tell them that in plain text; do not ask them for the value here.`];
        return [`Installed ${after.displayName} (plugin ${after.pluginId}).`, ...(note == null ? [] : [note]), ...ask, describePluginDetail(after)].join("\n");
      }),
    }),
    defineCommunicateTool(management, {
      id: "ADD_MCP_SERVER", name: "AddMcpServer", description: "Add an MCP server the Marketplace does not carry: use this when the user gives you a link or a config block for a server SearchPlugins does not know. Only call this after the user agrees, and confirm with a question widget first, since it changes their box and the server can reach external services on their behalf. Two shapes, and you pick one: a server this box CONNECTS to (`url`, plus `headers`), or a server this box RUNS (`command`, `args`, and `env` for the NAMES of any variables it needs). Both work here. NEVER put a key in a header value or an env value: write the header as \"Bearer ${THE_FIELD}\" and pass env as names only, then tell the user to type the value into the masked box on that server\'s page, because a key you type here is stored in this conversation. A server that can only be signed into through a browser cannot be added this way; say so and stop. Ask the user for the exact endpoint or command rather than guessing, and if you only have a link, open it first (WebFetch) to find the connection details. Newly added tools become available to you on your next message.", parameters: addMcpServerParameters,
      describeActivity: (args: z.infer<typeof addMcpServerParameters>) => ({ detail: args.name }),
      execute: guardMutation(async (_ctx, args: z.infer<typeof addMcpServerParameters>, deps) => {
        if (args.url != null && args.url.length > 0 && args.command != null && args.command.length > 0) {
          return "Give either `url` (a server the box connects to) or `command` (a server the box runs), not both. Ask the user which one their server's docs describe.";
        }
        if (args.url != null && args.url.length > 0) {
          const error = validateRemoteMcpUrl(args.url);
          if (error != null) return error;
        }
        const literal = credentialLiteralRefusal(args.name, args.headers, args.env);
        if (literal != null) return literal;
        const configJson = buildServerConfigJson(args);
        if (configJson == null) return "A server needs either its `url` or the `command` the box runs. Ask the user which their server's docs give.";
        const before = await deps.listInstalled();
        const servers = await deps.add({ name: args.name, configJson });
        const note = emitNeedsAuthCards(before, servers);
        // Every placeholder and every env name is a value the person still owes, and saying which
        // is the difference between "added" and a connector sitting at 401 with nobody told why.
        const owed = [
          ...Object.values(args.headers ?? {}).flatMap(credentialPlaceholderNames),
          ...(args.env ?? []),
        ];
        const ask = owed.length === 0
          ? []
          : [`It cannot connect until the user stores ${[...new Set(owed)].join(", ")} on its page in the Marketplace. Tell them that in plain text; do not ask them for the value here.`];
        return [`Added "${args.name}".`, ...(note == null ? [] : [note]), ...ask, describeInstalledList(servers)].join("\n");
      }),
    }),
    defineCommunicateTool(management, {
      id: "UNINSTALL_MCP_SERVER", name: "UninstallMcpServer", description: "Remove ONE custom MCP server, meaning a server added with AddMcpServer rather than one that came from a plugin, by its server identifier. This is destructive and deletes the server with all of its accounts, so confirm with the user via a question widget first. Ask them in the same breath whether to clear the key they stored for it: pass clear_stored_values true if they say yes, and leave it out to keep the key so re-adding needs no fresh one. A server the listing marks `plugin=<id>` came from a marketplace plugin, and removing it would uninstall that WHOLE plugin, which this tool refuses: use UninstallPlugin for those so the confirmation can disclose the full scope." + (multiAccount ? " To remove just one account and keep the server, use RemoveMcpAccount instead." : ""), parameters: uninstallServerParameters,
      execute: guardMutation(async (_ctx, args: z.infer<typeof uninstallServerParameters>, deps) => {
        const installed = await deps.listInstalled();
        const row = resolveMcpServerRowByIdentifierOrLegacyId(installed, args.server_id);
        if (row == null) return noInstalledServerMessage(args.server_id);
        if (row.pluginId != null) return `${row.name} was installed from marketplace plugin ${row.pluginId}; use UninstallPlugin.`;
        if (row.isTeamServer === true) return `${row.name} is provided by the user's team, so it can't be removed here.`;
        // MARKET-6. The one writer, when this host has it. Removing the entry and clearing the key
        // are two acts, and the second one used to be impossible once the first had happened: every
        // secret command started at the entry, so an uninstalled connector's key became unreachable
        // rather than merely kept (CONNECT-11).
        if (deps.removeConnector != null) {
          const outcome = await deps.removeConnector({
            server: row.serverIdentifier,
            clearSecrets: args.clear_stored_values === true,
          });
          const kept = args.clear_stored_values === true
            ? outcome.cleared.length === 0
              ? "There was no stored key to clear."
              : `Cleared its stored ${outcome.cleared.join(", ")}.`
            : "Its stored key was kept, so re-adding it needs no fresh one. Tell the user that, and that clearing it is a separate action on its page.";
          const status = outcome.removed
            ? `Removed MCP server ${row.name} (${row.serverIdentifier}).`
            : `The removal request for ${row.name} completed, but it still reads as installed.`;
          return [status, kept, describeInstalledList(await deps.listInstalled())].join("\n");
        }
        const result = await deps.removeServer(row.id);
        const status = result.removed ? `Removed MCP server ${row.name} (${row.serverIdentifier}).` : `The removal request for ${row.name} completed, but it still reads as installed.`;
        return [status, describeInstalledList(result.servers)].join("\n");
      }),
    }),
    defineCommunicateTool(management, {
      id: "UNINSTALL_PLUGIN", name: "UninstallPlugin", description: "Uninstall a Marketplace plugin by its STABLE plugin id (from SearchPlugins): it removes the connector's entry and reloads the MCP servers, so every tool that plugin provided goes away. Destructive — confirm with the user via a question widget first, and your confirmation must disclose that full scope (list what goes). Any credential the user stored for it is deliberately LEFT in place, so re-adding the plugin does not need a fresh key; tell them that, and that clearing it is a separate action on the plugin's page." + (multiAccount ? " This removes each of its servers with ALL of their accounts; to remove just one account from a server, use RemoveMcpAccount instead." : ""), parameters: getPluginParameters,
      execute: guardMutation(async (_ctx, args: z.infer<typeof getPluginParameters>, deps) => {
        const detail = await deps.getPlugin(args.plugin_id);
        if (detail == null) return `No plugin with id "${args.plugin_id}".`;
        if (!detail.isInstalled) return `${detail.displayName} is not installed — nothing to uninstall.`;
        if (detail.installMode === "team-required") return `${detail.displayName} is required by the user's team and cannot be uninstalled.`;
        const result = await deps.uninstallPlugin(args.plugin_id);
        if (result.removed) return `Uninstalled ${detail.displayName} (plugin ${detail.pluginId}).`;
        // The reason is the whole answer for a shell tool: it has no uninstall door on this host,
        // and "it still reads as installed" would leave the user waiting for a second attempt.
        return result.reason == null || result.reason.length === 0
          ? `The uninstall request for ${detail.displayName} completed, but it still reads as installed.`
          : `${detail.displayName} was not uninstalled: ${result.reason}`;
      }),
    }),
    defineCommunicateTool(management, {
      id: "GET_MCP_SERVER_STATUS", name: "GetMcpServerStatus", description: "The runtime status of the user's installed MCP servers (connected / needsAuth / error, per account). Pass server_id (the server identifier, NEVER a display name) for one server; omit it to list everything. Use this to see which connectors still need authentication, to find the identifier a lifecycle tool needs — the same one GetMcpTools and CallMcpTool address — or to check a connector after installing or authenticating. Read-only and never needs the user's permission.", parameters: statusParameters,
      execute: async (_ctx, args: z.infer<typeof statusParameters>, deps) => {
        const installed = await deps.listInstalled();
        const token = args.server_id?.trim();
        if (token == null || token.length === 0) return describeInstalledList(installed);
        const rows = resolveMcpServerRowsByIdentifierOrLegacyId(installed, token);
        if (rows.length === 0) return `No installed MCP server "${token}".`;
        // MARKET-6. One server asked about by name gets its TOOLS too. No new tool name is needed
        // for this: the model already comes here to check a connector after adding it, and "it says
        // connected" with no list is the answer that sent it round again through GetMcpTools.
        const first = rows[0];
        const listed = rows.length === 1 && first != null && deps.listServerTools != null
          ? await deps.listServerTools(first.id).catch(() => [])
          : [];
        const tools = listed.length === 0
          ? []
          : [`Tools: ${listed.map((tool) => tool.name + (tool.enabled === false ? " (disabled)" : "")).join(", ")}`];
        return [...rows.map(describeInstalled), ...tools].join("\n");
      },
    }),
    defineCommunicateTool(management, {
      id: "SET_MCP_INSTRUCTIONS", name: "SetMcpInstructions", description: `Set (or clear) an installed connector's custom instructions \u2014 the guidance you follow whenever you use that server (e.g. "Reply in threads on Slack"). Use this when the user tells you how they want a connector used, so the preference persists across turns. Pass an empty string to clear it and fall back to the connector's default. This changes a saved preference, not the connection (no OAuth needed); the current value shows in GetMcpServerStatus when it's been customized.`, parameters: instructionsParameters,
      execute: guardMutation(async (_ctx, args: z.infer<typeof instructionsParameters>, deps) => {
        const serverId = await resolveServerId(deps, args.server_id);
        if (serverId == null) return noInstalledServerMessage(args.server_id);
        const servers = await deps.setInstructions({ serverId, instructions: args.instructions });
        return [`${args.instructions.trim().length === 0 ? "Cleared" : "Updated"} custom instructions for MCP server ${args.server_id}.`, describeInstalledList(servers)].join("\n");
      }),
    }),
    defineCommunicateTool(management, {
      id: "RESTART_MCP_SERVERS", name: "RestartMcpServers", description: "Restart (reconnect) the installed MCP servers — useful when a server is stuck, errored, or you just finished authenticating one. Confirm with the user first if a server is mid-task.", parameters: z.object({}),
      execute: guardMutation(async (_ctx, _args: Record<string, never>, deps) => ["Restarted MCP servers.", describeInstalledList(await deps.restart())].join("\n")),
    }),
  ];

  const authenticate = (parameters: typeof authParameters | typeof multiAuthParameters) => defineCommunicateTool(management, {
    id: "AUTHENTICATE_MCP_SERVER", name: "AuthenticateMcpServer", description: "Authenticate an installed MCP server that needs it (status needsAuth, or a tool call failing with an auth error). This is the only way to start a connector's auth: its connect card is shown to the user automatically — never compose a card, paste an authorization link, or reach the same service another way while its authorization is pending. The user authorizes in place and you're resumed automatically, so finish unrelated work, then end your turn.", parameters,
    execute: guardMutation(async (_ctx, args: { server_id: string; account_label?: string; force_reauth?: boolean }, deps) => {
      const serverId = await resolveServerId(deps, args.server_id);
      if (serverId == null) return noInstalledServerMessage(args.server_id);
      const account = multiAccount ? decodeMcpAccountLabelArgument(args.account_label ?? "default") : "default";
      const result = await deps.authenticate(serverId, account, getRequestingAgentId?.() ?? null, args.force_reauth === true);
      return emitAndDescribeAuthResult(result, args.force_reauth === true, serverId, emitConnectorCard);
    }),
  });
  tools.push(authenticate(multiAccount ? multiAuthParameters : authParameters));

  if (multiAccount) {
    tools.push(
      defineCommunicateTool(management, {
        id: "REMOVE_MCP_ACCOUNT", name: "RemoveMcpAccount", description: "Remove ONE account from an MCP server: the account and its credential are deleted, while the server and its other accounts stay. This is destructive — confirm with the user via a question widget before calling it. To remove a whole custom server (every account), use UninstallMcpServer; to remove a server's whole plugin (every connector, skill, and account), use UninstallPlugin.", parameters: accountParameters,
        execute: guardMutation(async (_ctx, args: z.infer<typeof accountParameters>, deps) => {
          const serverId = await resolveServerId(deps, args.server_id);
          if (serverId == null) return noInstalledServerMessage(args.server_id);
          const accountKey = decodeMcpAccountLabelArgument(args.account_label);
          const servers = await deps.removeAccount({ serverId, accountKey });
          return [`Removed account "${formatMcpAccountLabelForPrompt(accountKey)}" from MCP server ${args.server_id}.`, describeInstalledList(servers)].join("\n");
        }),
      }),
      defineCommunicateTool(management, {
        id: "RENAME_MCP_ACCOUNT", name: "RenameMcpAccount", description: "Rename one of an MCP server's accounts (change its label). The account's server identifier changes with the label at the next listing, so after renaming, re-run GetMcpServerStatus (or GetMcpTools) before calling that account's tools again — stale identifiers fail cleanly. Confirm with a question widget first.", parameters: renameParameters,
        execute: guardMutation(async (_ctx, args: z.infer<typeof renameParameters>, deps) => {
          const serverId = await resolveServerId(deps, args.server_id);
          if (serverId == null) return noInstalledServerMessage(args.server_id);
          const accountKey = decodeMcpAccountLabelArgument(args.account_label);
          const newAccountKey = decodeMcpAccountLabelArgument(args.new_account_label);
          const servers = await deps.renameAccount({ serverId, accountKey, newAccountKey });
          return [`Renamed account "${formatMcpAccountLabelForPrompt(accountKey)}" to "${formatMcpAccountLabelForPrompt(newAccountKey)}" on MCP server ${args.server_id}.`, describeInstalledList(servers)].join("\n");
        }),
      }),
    );
  }
  return tools;
}
