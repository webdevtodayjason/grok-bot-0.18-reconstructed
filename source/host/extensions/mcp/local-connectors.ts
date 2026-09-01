import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AccountMcpServer } from "../../../shared/node/cursor-backend/account-mcp.js";

/**
 * Connectors reached this host exactly one way: the Cursor account's server list, fetched by
 * `fetchAccountMcpServers`. That makes every connector depend on a Cursor login, and it is why
 * clicking Authorize hands the operator to cursor.com.
 *
 * A stdio MCP server needs none of that. `tools-discovery` runs stdio servers inside the box
 * through `boxMcpExec`, with Cursor involved in nothing, and the MCP spec says stdio servers take
 * their credentials from the environment rather than doing OAuth. So a plain local file naming
 * those servers is enough to own connectors outright.
 *
 * Shape is the ordinary `mcp.json` every MCP client already understands:
 *
 *   { "mcpServers": { "github": { "command": "npx", "args": [...], "env": { "TOKEN": "..." } } } }
 */
export const LOCAL_CONNECTORS_FILENAME = "connectors.json";

type LocalServerConfig = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly disabled?: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const shape = record(value);
  if (shape == null) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(shape)) if (typeof entry === "string") result[key] = entry;
  return Object.keys(result).length === 0 ? undefined : result;
}

function parseServer(value: unknown): LocalServerConfig | null {
  const shape = record(value);
  if (shape == null || typeof shape.command !== "string" || shape.command.length === 0) return null;
  const args = Array.isArray(shape.args)
    ? shape.args.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    command: shape.command,
    ...(args === undefined || args.length === 0 ? {} : { args }),
    ...(stringMap(shape.env) === undefined ? {} : { env: stringMap(shape.env)! }),
    ...(typeof shape.cwd === "string" ? { cwd: shape.cwd } : {}),
    ...(shape.disabled === true ? { disabled: true } : {}),
  };
}

/** Reads the operator's local connector file. A missing or malformed file yields no servers. */
export function readLocalConnectorFile(rootDir: string): Record<string, LocalServerConfig> {
  let raw: string;
  try { raw = readFileSync(join(rootDir, LOCAL_CONNECTORS_FILENAME), "utf8"); }
  catch { return {}; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return {}; }
  const servers = record(record(parsed)?.mcpServers);
  if (servers == null) return {};
  const result: Record<string, LocalServerConfig> = {};
  for (const [name, value] of Object.entries(servers)) {
    const config = parseServer(value);
    if (config != null && config.disabled !== true) result[name] = config;
  }
  return result;
}

function asAccountServer(name: string, config: LocalServerConfig): AccountMcpServer {
  const { disabled: _disabled, ...serverConfig } = config;
  return {
    id: `local:${name}`,
    name,
    serverIdentifier: name,
    config: serverConfig,
    isTeamServer: false,
    disabledByTeamAdminPolicy: false,
  };
}

/**
 * Merges local servers over whatever the account returned. Local wins on name collision, and the
 * local list stands alone when the account is unreachable -- a connector the operator configured
 * on their own machine should not stop working because a remote login expired.
 */
export function mergeLocalConnectors(
  remote: { servers: AccountMcpServer[]; cacheScope: string; unresolvedServerIds?: string[]; unavailable?: true } | null,
  localServers: Record<string, LocalServerConfig>,
): { servers: AccountMcpServer[]; cacheScope: string; unresolvedServerIds?: string[]; unavailable?: true } | null {
  const local = Object.entries(localServers).map(([name, config]) => asAccountServer(name, config));
  if (local.length === 0) return remote;
  const claimed = new Set(local.map((server) => server.serverIdentifier));
  const kept = (remote?.servers ?? []).filter((server) => !claimed.has(server.serverIdentifier));
  return {
    servers: [...kept, ...local],
    cacheScope: remote?.cacheScope ?? "local",
    ...(remote?.unresolvedServerIds === undefined ? {} : { unresolvedServerIds: remote.unresolvedServerIds }),
  };
}
