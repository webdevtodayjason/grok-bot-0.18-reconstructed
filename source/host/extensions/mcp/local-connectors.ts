import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AccountMcpServer } from "../../../shared/node/cursor-backend/account-mcp.js";
import { isShellSecretConnector, SHELL_SECRET_CONNECTOR } from "../shell-tools/shell-secret-field.js";

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

/**
 * CP-07. Local connectors used to be given the id `local:<name>`, and every id-keyed operation in
 * the MCP layer runs its argument through `validateMcpServerId`, whose pattern is /^[1-9]\d*$/.
 * So SetMcpInstructions, the per-tool toggles and authenticate rejected exactly the connectors that
 * actually work on this box. The fix is a real numeric id, minted once per server NAME and
 * persisted beside connectors.json so it survives a host restart -- `serverIdentifier` stays the
 * human name, which is what discovery, routing and the Connectors cards key on.
 *
 * The floor keeps these clear of the account-server ids the Cursor backend hands out (small
 * int32s), and the whole range stays inside int32 so `parseInt32McpServerId` accepts it.
 */
export const LOCAL_CONNECTOR_IDS_FILENAME = "connectors.ids.json";
export const LOCAL_CONNECTOR_ID_FLOOR = 1_000_000;
/** `parseInt32McpServerId` is the far end of every id-keyed call, so ids stay inside int32. */
const LOCAL_CONNECTOR_ID_CEILING = 2_147_483_647;

/**
 * The id is a function of the NAME, not of the name's position in a sorted list. That matters
 * because the persisted map is best-effort: an unwritable data dir means every boot re-mints from
 * an empty map, and a counter handed out in sorted order would then give "localfiles" a different
 * id the moment a connector sorting before it appeared. `mcpDisabledToolsByServerId` and
 * `mcpCustomInstructionsByServerId` are keyed by exactly this id, so a renumber silently moves one
 * connector's disabled tools and custom instruction onto another. FNV-1a over the name cannot do
 * that: the file only records what was minted (and resolves the rare collision).
 */
export function localConnectorIdForName(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193) >>> 0;
  }
  return LOCAL_CONNECTOR_ID_FLOOR + (hash % (LOCAL_CONNECTOR_ID_CEILING - LOCAL_CONNECTOR_ID_FLOOR));
}

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

/**
 * The raw `mcpServers` map, unparsed and unfiltered -- what a WRITE has to start from.
 *
 * `readLocalConnectorFile` below normalises: it drops a disabled entry and rebuilds every config
 * from the fields it knows. Writing that back would silently delete a disabled connector and any
 * field a future MCP client adds, so an edit reads here instead and touches exactly one key.
 */
function readLocalConnectorDocument(rootDir: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(rootDir, LOCAL_CONNECTORS_FILENAME), "utf8")); }
  catch { return {}; }
  return record(record(parsed)?.mcpServers) ?? {};
}

/**
 * Writes the map back in the SAME bytes the relay's `POST /connectors` produces --
 * `JSON.stringify({ mcpServers }, null, 2)` at 0600 -- because both doors edit one file and the
 * connector gate asserts the file is byte-identical after an install is undone. A different
 * indent, a trailing newline or a second top-level key here would make an undo look like an edit.
 */
function writeLocalConnectorDocument(rootDir: string, mcpServers: Record<string, unknown>): void {
  writeFileSync(
    join(rootDir, LOCAL_CONNECTORS_FILENAME),
    JSON.stringify({ mcpServers }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * SECRET-2. `shell` is not a connector name on this box: it is the reserved destination a
 * secret-request card names to mean "the agent's own box shell environment", and `routeSecret`
 * returns on it before the connector branch is ever reached. A local stdio connector under that
 * name could therefore never be given a credential from a card, and the operator would be left
 * with a connector whose key form silently writes somewhere else. So the name is refused at the
 * door -- both doors -- rather than accepted and quietly bypassed. Case-insensitive, because
 * that is how the route matches it.
 */
export function localConnectorNameRefusal(name: string): string | null {
  return isShellSecretConnector(name)
    ? `"${name}" is reserved: a secret card's connector "${SHELL_SECRET_CONNECTOR}" means the agent's own box shell environment, so a connector under that name could never be given a credential. Rename it (for example "${name.trim().toLowerCase()}-mcp") and add it again.`
    : null;
}

/** The names in connectors.json this host refuses to run, with the reason each one is refused. */
export function listRefusedLocalConnectors(rootDir: string): Array<{ name: string; reason: string }> {
  const refused: Array<{ name: string; reason: string }> = [];
  for (const name of Object.keys(readLocalConnectorDocument(rootDir))) {
    const reason = localConnectorNameRefusal(name);
    if (reason != null) refused.push({ name, reason });
  }
  return refused;
}

/**
 * Adds (or replaces) one connector entry. This is the host-side twin of the console's
 * `POST /connectors`: same file, same bytes, same 0600. The caller reloads the servers afterwards
 * -- writing the file is not what starts the process.
 */
export function writeLocalConnectorEntry(
  rootDir: string,
  name: string,
  entry: { command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> },
): void {
  const refusal = localConnectorNameRefusal(name);
  if (refusal != null) throw new Error(refusal);
  const servers = readLocalConnectorDocument(rootDir);
  servers[name] = {
    command: entry.command,
    ...(entry.args === undefined ? {} : { args: [...entry.args] }),
    ...(entry.env === undefined ? {} : { env: { ...entry.env } }),
  };
  writeLocalConnectorDocument(rootDir, servers);
}

/**
 * Is there an entry under this name at all? Asked of the RAW document rather than of
 * `readLocalConnectorFile` below, which drops a `disabled: true` entry -- a caller that could not
 * see a disabled entry would answer "not installed" about one and then overwrite the operator's
 * own edit, which is precisely what this question exists to prevent.
 */
export function hasLocalConnectorEntry(rootDir: string, name: string): boolean {
  return Object.hasOwn(readLocalConnectorDocument(rootDir), name);
}

/** Removes one connector entry. Answers whether it was there; the secret store is untouched. */
export function removeLocalConnectorEntry(rootDir: string, name: string): boolean {
  const servers = readLocalConnectorDocument(rootDir);
  if (!Object.hasOwn(servers, name)) return false;
  delete servers[name];
  writeLocalConnectorDocument(rootDir, servers);
  return true;
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
    // SECRET-2: a reserved name never runs, however it got into the file. It is not dropped
    // silently -- `listRefusedLocalConnectors` is what the installed listing reports it from.
    if (localConnectorNameRefusal(name) != null) continue;
    const config = parseServer(value);
    if (config != null && config.disabled !== true) result[name] = config;
  }
  return result;
}

/** The persisted name -> id map. A missing or malformed file mints everything fresh. */
export function readLocalConnectorIds(rootDir: string): Record<string, number> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(rootDir, LOCAL_CONNECTOR_IDS_FILENAME), "utf8")); }
  catch { return {}; }
  const ids = record(record(parsed)?.ids);
  if (ids == null) return {};
  const result: Record<string, number> = {};
  for (const [name, value] of Object.entries(ids)) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= LOCAL_CONNECTOR_ID_FLOOR) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Ids for every named server, minting (and persisting) one for any name that has none. Ids are
 * never reused or renumbered, so removing a connector and adding it back gets its old id.
 *
 * `readOnly` answers "what id would this name have?" without touching the disk -- a membership
 * question from the secret sink must not mint and persist as a side effect.
 */
export function assignLocalConnectorIds(
  rootDir: string,
  names: readonly string[],
  options?: { readOnly?: boolean; log?: (message: string) => void },
): Record<string, string> {
  const known = readLocalConnectorIds(rootDir);
  const taken = new Set(Object.values(known));
  let minted = false;
  for (const name of [...names].sort()) {
    if (known[name] !== undefined) continue;
    let id = localConnectorIdForName(name);
    // Two names hashing to the same id is a one-in-two-billion event, but it must resolve
    // deterministically rather than hand two connectors one identity.
    while (taken.has(id)) id = id >= LOCAL_CONNECTOR_ID_CEILING - 1 ? LOCAL_CONNECTOR_ID_FLOOR : id + 1;
    known[name] = id;
    taken.add(id);
    minted = true;
  }
  if (minted && options?.readOnly !== true) {
    try {
      writeFileSync(
        join(rootDir, LOCAL_CONNECTOR_IDS_FILENAME),
        JSON.stringify({ ids: known }, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      // An unwritable data dir must not take the connectors down, but it must not be invisible
      // either: nothing else in the system would ever report it.
      options?.log?.(`local connector ids could not be persisted (${error instanceof Error ? error.name : typeof error}); ids are derived from the connector name, so they stay stable anyway`);
    }
  }
  return Object.fromEntries(Object.entries(known).map(([name, id]) => [name, String(id)]));
}

function asAccountServer(
  name: string,
  config: LocalServerConfig,
  id: string,
  injectedEnv?: Record<string, string>,
): AccountMcpServer {
  const { disabled: _disabled, ...rest } = config;
  // CP-10. The host-owned secret store is merged into the spawn spec HERE, on the way to the box,
  // so the value reaches the connector process without ever being written into connectors.json.
  const env = injectedEnv === undefined || Object.keys(injectedEnv).length === 0
    ? rest.env
    : { ...rest.env, ...injectedEnv };
  const serverConfig = env === undefined ? rest : { ...rest, env };
  return {
    id,
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
  options?: { ids?: Record<string, string>; secrets?: Record<string, Record<string, string>> },
): { servers: AccountMcpServer[]; cacheScope: string; unresolvedServerIds?: string[]; unavailable?: true } | null {
  const local = Object.entries(localServers).map(([name, config]) =>
    asAccountServer(name, config, options?.ids?.[name] ?? `local:${name}`, options?.secrets?.[name]));
  if (local.length === 0) return remote;
  const claimed = new Set(local.map((server) => server.serverIdentifier));
  const kept = (remote?.servers ?? []).filter((server) => !claimed.has(server.serverIdentifier));
  return {
    servers: [...kept, ...local],
    cacheScope: remote?.cacheScope ?? "local",
    ...(remote?.unresolvedServerIds === undefined ? {} : { unresolvedServerIds: remote.unresolvedServerIds }),
  };
}
