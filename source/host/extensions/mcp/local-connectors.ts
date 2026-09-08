import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AccountMcpServer } from "../../../shared/node/cursor-backend/account-mcp.js";
import { isShellSecretConnector, SHELL_SECRET_CONNECTOR } from "../shell-tools/shell-secret-field.js";
import { isConnectorEnvFieldName } from "./connector-secrets.js";

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

/** A server the box spawns: a program, its arguments and its environment. */
export type LocalStdioServerConfig = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly disabled?: boolean;
};

/**
 * MARKET-6. A server the box CONNECTS to, with no local process at all.
 *
 * Measured on grok-bot-local-vm on 8 September 2026: the box's exec daemon takes
 * `{"type":"http","url":"…"}` through LoadMcpServers and answers `loadedServerNames`, and the
 * server reaches `connected` with its tools listed inside six seconds. With a header it does the
 * same in five, and the header value appears nowhere in `ps -eo args` inside the box.
 *
 * That is what makes this shape worth having. Every remote connector before it was `npx mcp-remote`
 * bridged, and the box expands `${VAR}` in a bridge's arguments before exec, so the credential
 * ended up in the argument list of three root processes an agent's own root shell can read. A
 * native remote has no bridge, no argument list, no npx cold start and no npm fetch at spawn -- and
 * a wrong key comes back as an immediate 401 instead of a sixty-second silence.
 */
export type LocalRemoteServerConfig = {
  readonly type: "http" | "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly disabled?: boolean;
};

export type LocalServerConfig = LocalStdioServerConfig | LocalRemoteServerConfig;

export function isRemoteLocalServer(config: LocalServerConfig): config is LocalRemoteServerConfig {
  return "url" in config;
}

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
  if (shape == null) return null;
  // MARKET-6. A url entry used to fall out here, and that single `return null` is why every
  // "remote" connector on this box was a bridged one: the operator's own connectors.json could
  // name an endpoint and the host would silently drop it.
  if (typeof shape.url === "string" && shape.url.length > 0) {
    const headers = stringMap(shape.headers);
    return {
      type: shape.type === "sse" ? "sse" : "http",
      url: shape.url,
      ...(headers === undefined ? {} : { headers }),
      ...(shape.disabled === true ? { disabled: true } : {}),
    };
  }
  if (typeof shape.command !== "string" || shape.command.length === 0) return null;
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
 * MARKET-6. A `${FIELD}` reference in a header value or a URL: the placeholder a remote entry
 * carries INSTEAD of a credential, so connectors.json holds the field's name and the 0600 store
 * holds its value. `asAccountServer` substitutes at push time, on the way to the box and nowhere
 * else.
 */
const CREDENTIAL_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g;

export function credentialPlaceholderNames(value: string): string[] {
  return [...value.matchAll(CREDENTIAL_PLACEHOLDER)].map((match) => match[1] as string);
}

/** Every placeholder a remote entry declares, across its url and its headers. */
export function remoteCredentialFieldNames(config: LocalRemoteServerConfig): string[] {
  return [...new Set([
    ...credentialPlaceholderNames(config.url),
    ...Object.values(config.headers ?? {}).flatMap(credentialPlaceholderNames),
  ])];
}

/**
 * MARKET-6. The URL rules, in one place, because an entry is arbitrary network reach FROM INSIDE
 * the customer's box, granted outside any turn.
 *
 * Loopback and link-local are refused outright and that is the load-bearing one: inside a box
 * 127.0.0.1 is the exec daemon on 1337 and 1338 and this host's own gateway on 1340, so a remote
 * entry pointed there with a header would be a credentialled request into the control plane.
 * A private LAN address is allowed -- an on-prem server on the operator's own network is a real
 * thing to connect to -- but only that may be plain http; anything routable must be https.
 *
 * A credential in the URL is refused rather than accepted, because a URL is not a secret on this
 * box: it is drawn on the plugin page, it goes into connectors.json in the clear, and it is in
 * every listing. `userinfo` was already refused; the query string was not, and that is where every
 * "just append ?api_key=" server puts it.
 */
const CREDENTIAL_QUERY_KEYS = new Set([
  "key", "api_key", "apikey", "token", "access_token", "auth", "auth_token",
  "secret", "password", "session", "sig", "signature",
]);

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^10\.|^192\.168\.|^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^127\./.test(host) || host === "::1" || host === "0.0.0.0") return true;
  return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function isLoopbackOrLinkLocal(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host)
    || host === "::1" || host === "0.0.0.0" || /^169\.254\./.test(host) || host.startsWith("fe80:");
}

export function localRemoteUrlRefusal(rawUrl: string): string | null {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return `"${rawUrl}" is not a web address. Paste the server's full endpoint, the way its own page writes it (for example https://example.com/mcp).`; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `A server address has to start with https. "${parsed.protocol.replace(":", "")}" is not something this box can connect to.`;
  }
  if (isLoopbackOrLinkLocal(parsed.hostname)) {
    return "That address points back at the box itself, where its own control ports live. Give the server's real address instead.";
  }
  if (parsed.protocol === "http:" && !isPrivateHostname(parsed.hostname)) {
    return "That address is plain http, so the key would cross the internet unencrypted. Use the https address; only a server on your own network may be plain http.";
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return "Take the sign-in out of the address. A web address is stored and shown in the clear here, so a key belongs in a header, where it is kept separately.";
  }
  for (const [key, value] of parsed.searchParams) {
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase()) && credentialPlaceholderNames(value).length === 0) {
      return `Take "${key}" out of the address. A web address is stored and shown in the clear here, so a key belongs in a header, where it is kept separately.`;
    }
  }
  return null;
}

/**
 * MARKET-6. A header that carries a key carries a PLACEHOLDER, never the key.
 *
 * connectors.json is a plain file the console lists, the agent can read and every backup copies.
 * The 0600 store beside it is the thing that is not. So a literal in `Authorization` would undo the
 * whole custody argument at the one door it is easiest to walk through, and it is refused with the
 * sentence that says what to write instead.
 *
 * A header that carries no key is left alone: a vendor's docs really do ask for `x-mcp-servers` or
 * an Accept header, and refusing those makes a documented server unaddable for nothing.
 */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|api[-_]?key|x-api-key|x-auth-token|x-access-token|x-[a-z0-9-]*-(key|token|secret))$/i;

export function remoteHeaderRefusal(headers: Readonly<Record<string, string>> | undefined): string | null {
  for (const [header, value] of Object.entries(headers ?? {})) {
    if (!CREDENTIAL_HEADER.test(header.trim())) continue;
    if (credentialPlaceholderNames(value).length > 0) continue;
    if (value.trim().length === 0) continue;
    return `Put the key for "${header}" in the masked box rather than in the header itself. Write the header as a name in braces, for example "\${SERVER_TOKEN}", and type the value once when it asks: the configuration file is listed, copied and backed up in the clear, and the box keeps the value somewhere it is not.`;
  }
  return null;
}

/**
 * MARKET-6. The whole validation table, in the one place every door goes through.
 *
 * It lives HERE, next to the write, because an entry is a program this box runs as root at every
 * reload -- outside any turn, with no one watching. Four separate callers used to make four
 * separate subsets of these checks, and the one that mattered (the reserved `shell` name) was made
 * in four places and drifted.
 */
export function localConnectorEntryRefusal(name: string, entry: LocalServerConfig): string | null {
  const nameRefusal = localConnectorNameRefusal(name);
  if (nameRefusal != null) return nameRefusal;
  const trimmed = name.trim();
  if (trimmed.length === 0) return "A connector needs a name.";
  if (RESERVED_ENTRY_NAMES.has(trimmed)) return `"${trimmed}" is a reserved name. Pick another one.`;
  if (/[/\\\0]/.test(trimmed)) return "A connector name cannot contain a slash or a null byte.";
  if (isRemoteLocalServer(entry)) return localRemoteUrlRefusal(entry.url) ?? remoteHeaderRefusal(entry.headers);
  if (entry.command.trim().length === 0) return "A connector that runs a program needs the program to run.";
  for (const field of Object.keys(entry.env ?? {})) {
    if (!isConnectorEnvFieldName(field)) {
      return `"${field}" is not a name this box will set for a connector. Names that control how a program loads (PATH, NODE_OPTIONS, LD_*) are refused because they run code rather than carry a credential.`;
    }
  }
  return null;
}

const RESERVED_ENTRY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Adds (or replaces) one connector entry. This is the host-side twin of the console's
 * `POST /connectors`: same file, same bytes, same 0600. The caller reloads the servers afterwards
 * -- writing the file is not what starts the process.
 *
 * MARKET-6: the ONE writer. Every door -- the console's Add, the console's Add your own, the
 * agent's AddMcpServer and the marketplace install -- lands here, so the validation table above
 * cannot be skipped by arriving through a different one.
 */
export function writeLocalConnectorEntry(
  rootDir: string,
  name: string,
  entry: LocalServerConfig,
): void {
  const refusal = localConnectorEntryRefusal(name, entry);
  if (refusal != null) throw new Error(refusal);
  const servers = readLocalConnectorDocument(rootDir);
  servers[name] = isRemoteLocalServer(entry)
    ? {
      type: entry.type,
      url: entry.url,
      ...(entry.headers === undefined ? {} : { headers: { ...entry.headers } }),
    }
    : {
      command: entry.command,
      ...(entry.args === undefined ? {} : { args: [...entry.args] }),
      ...(entry.env === undefined ? {} : { env: { ...entry.env } }),
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
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

/**
 * MARKET-6. Substitutes `${FIELD}` with the stored value, at push time and nowhere else.
 *
 * A placeholder with nothing stored behind it is left EXACTLY as written rather than replaced with
 * the empty string. An empty Authorization header reads to the far end as a malformed request and
 * comes back as some vendor's own 400; the untouched `${TOKEN}` comes back as a 401, which is what
 * connector-health turns into "It needs its key before it can connect".
 */
function substituteCredentials(value: string, stored: Readonly<Record<string, string>>): string {
  return value.replace(CREDENTIAL_PLACEHOLDER, (whole, field: string) => stored[field] ?? whole);
}

function asAccountServer(
  name: string,
  config: LocalServerConfig,
  id: string,
  injectedEnv?: Record<string, string>,
): AccountMcpServer {
  const stored = injectedEnv ?? {};
  let serverConfig: unknown;
  if (isRemoteLocalServer(config)) {
    const { disabled: _disabled, headers, url, ...rest } = config;
    // MARKET-6. The whole custody argument for a native remote lives on this line: the literal
    // goes into the config the host pushes over the control plane, and never into connectors.json,
    // never into an argument list, and never into a process any shell in the box can read.
    //
    // It has to happen here and cannot be left to the box: the remote load path expands its config
    // with a resolver that answers undefined for every name, so a `${TOKEN}` that reached the box
    // intact would resolve to nothing.
    serverConfig = {
      ...rest,
      url: substituteCredentials(url, stored),
      ...(headers === undefined ? {} : {
        headers: Object.fromEntries(Object.entries(headers).map(
          ([header, value]) => [header, substituteCredentials(value, stored)])),
      }),
    };
  } else {
    const { disabled: _disabled, ...rest } = config;
    // CP-10. The host-owned secret store is merged into the spawn spec HERE, on the way to the box,
    // so the value reaches the connector process without ever being written into connectors.json.
    const env = Object.keys(stored).length === 0 ? rest.env : { ...rest.env, ...stored };
    serverConfig = env === undefined ? rest : { ...rest, env };
  }
  return {
    id,
    name,
    serverIdentifier: name,
    config: serverConfig as AccountMcpServer["config"],
    isTeamServer: false,
    disabledByTeamAdminPolicy: false,
  };
}

/**
 * The names in connectors.json that are REMOTE entries of this box's own.
 *
 * The definition source needs this to tell them from the Cursor account's remote servers: a local
 * remote is dispatched to the box, which connects to it; an account remote was dispatched to
 * Cursor's Dashboard RPC, which answers nothing on any Titanium Bot box. Without the split, opening
 * `parseServer` to url entries would have sent every one of them to the dead backend.
 */
export function localRemoteConnectorNames(rootDir: string): string[] {
  return Object.entries(readLocalConnectorFile(rootDir))
    .flatMap(([name, config]) => isRemoteLocalServer(config) ? [name] : []);
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
