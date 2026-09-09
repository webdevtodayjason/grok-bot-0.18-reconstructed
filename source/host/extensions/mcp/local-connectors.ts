import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AccountMcpServer } from "../../../shared/node/cursor-backend/account-mcp.js";
import { looksLikeCredential, normalizedHostname } from "../../../shared/marketplace/connector-spec.js";
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
  /**
   * MARKET-15. The one way an address inside the box's own network is allowed, and it has to be
   * said on the entry.
   *
   * An MCP server on the operator's own LAN is a real thing to connect to, so this is how it is
   * asked for: deliberately, per entry, by somebody who already holds the box's gateway token.
   * Neither console door nor the agent's AddMcpServer has a field for it, because the addresses in
   * question are this box's own gateway on 1340, its exec daemons on 1337 and 1338, and the
   * machine's own services on the docker gateway. Loopback stays refused even with this set.
   */
  readonly allowPrivateNetwork?: boolean;
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
      ...(shape.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
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
 *
 * MARKET-15: so is the rest of the private space, and refusing loopback alone was never enough.
 * Measured from inside the R750 demo box on 2026-09-08: a POST to its own 192.168.48.6:1340 with
 * that box's gateway token answered the same bytes as 127.0.0.1:1340 did, its exec daemon on 1337
 * answered HTTP on the same address, and the docker default gateway 192.168.32.1:80 -- the
 * machine's own proxy -- answered too. A container reaches its own control plane and its host's
 * services by their ordinary private addresses. Other tenants' boxes did NOT answer, so isolation
 * held; the box's own control plane is what the old rule was handing out.
 *
 * An on-prem server on the operator's own LAN is still a real thing to connect to, and it is
 * reached by saying so on the entry (`allowPrivateNetwork`), which only somebody holding the box's
 * gateway token can set. That address may be plain http; anything routable must be https.
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

/**
 * MARKET-22. Both predicates read the NORMALIZED address, never the text that was typed.
 *
 * Measured through the demo box's own gateway on 2026-09-08: `https://[::ffff:127.0.0.1]:1341/mcp`,
 * `https://[::]:1341/mcp` and `https://[::ffff:169.254.169.254]/mcp` were all accepted with a secret
 * header while `https://127.0.0.1:1341/mcp` was refused, because a prefix test on the raw hostname
 * is handed `::ffff:7f00:1`, `::` and `::ffff:a9fe:a9fe`. `normalizedHostname` turns each of those
 * back into the address it is, so one rule covers every way of writing it.
 */
const V6_LOOPBACK = "0:0:0:0:0:0:0:1";
const V6_UNSPECIFIED = "0:0:0:0:0:0:0:0";

function isPrivateHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  if (isLoopbackOrLinkLocal(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (/^10\.|^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // 100.64/10 is the carrier-grade range every tailnet address is on, and 0.0.0.0/8 resolves to
  // this machine on Linux the same way 0.0.0.0 does.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || /^0\./.test(host)) return true;
  // Full-length groups, so these are exactly fc00::/7 and fe80::/10.
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

function isLoopbackOrLinkLocal(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host)
    || host === V6_LOOPBACK || host === V6_UNSPECIFIED || host === "0.0.0.0"
    || /^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

export function localRemoteUrlRefusal(
  rawUrl: string,
  options: { allowPrivateNetwork?: boolean } = {},
): string | null {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return `"${rawUrl}" is not a web address. Paste the server's full endpoint, the way its own page writes it (for example https://example.com/mcp).`; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `A server address has to start with https. "${parsed.protocol.replace(":", "")}" is not something this box can connect to.`;
  }
  if (isLoopbackOrLinkLocal(parsed.hostname)) {
    return "That address points back at the box itself, where its own control ports live. Give the server's real address instead.";
  }
  if (isPrivateHostname(parsed.hostname) && options.allowPrivateNetwork !== true) {
    return "That address is inside this box's own network, where its gateway and its tool daemons listen. Give the server's address on the internet instead.";
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
  if (isRemoteLocalServer(entry)) {
    return localRemoteUrlRefusal(entry.url, { allowPrivateNetwork: entry.allowPrivateNetwork === true })
      ?? remoteHeaderRefusal(entry.headers);
  }
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
      ...(entry.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
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

/**
 * MARKET-17. The argv leak, on the boxes that were already running.
 *
 * Moving this tree onto the native remote shape changed what a NEW entry is written as and nothing
 * else, so both R750 boxes kept the bridged entry they were given in July and kept putting the key
 * on a command line: measured read-only inside titanbot-box-wepegxhh3fpvr83bubvz5xm5 on 2026-09-08,
 * the stored TinyFish bearer was in three root process argument lists, readable by `ps -eo args`
 * from the agent's own root shell. The plugin page said nothing, because the entry looks fine and
 * works. An operator had no way to notice it and no lever to fix it.
 *
 * So the host rewrites them itself. A bridged remote
 * (`npx -y mcp-remote@x <url> [--transport t] [--header "N:V"]`) becomes the native
 * `{type, url, headers}` entry the same url and headers describe, and the next push carries the key
 * in the request the box makes rather than in a process's arguments.
 *
 * A header whose value is a LITERAL key is not carried across: it goes into the 0600 store through
 * `storeSecret` and is replaced by its `${FIELD}` placeholder. With no `storeSecret` the entry is
 * left exactly as it was and reported as skipped, because a migration that quietly copied a key
 * into a plaintext file would be a worse bug than the one it is closing.
 */
const BRIDGE_PACKAGE = /^(?:@[\w.-]+\/)?mcp-remote(?:@[\w.+-]+)?$/;

export interface BridgedRemoteEntry {
  readonly type: "http" | "sse";
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** The endpoint a bridged entry is really about, or null when the entry is not a bridge. */
export function bridgedRemoteEntry(config: LocalServerConfig): BridgedRemoteEntry | null {
  if (isRemoteLocalServer(config)) return null;
  const args = [...(config.args ?? [])];
  const at = args.findIndex((arg) => BRIDGE_PACKAGE.test(arg));
  if (at < 0) return null;
  let url: string | null = null;
  let type: "http" | "sse" = "http";
  const headers: Record<string, string> = {};
  for (let index = at + 1; index < args.length; index += 1) {
    const arg = args[index] as string;
    const [flag, inlineValue] = arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, null];
    if (flag === "--header") {
      const pair = inlineValue ?? args[index + 1] ?? "";
      if (inlineValue == null) index += 1;
      const colon = pair.indexOf(":");
      if (colon > 0) headers[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
      continue;
    }
    if (flag === "--transport") {
      const value = inlineValue ?? args[index + 1] ?? "";
      if (inlineValue == null) index += 1;
      if (value.startsWith("sse")) type = "sse";
      continue;
    }
    // Every other flag is the bridge's own plumbing -- its callback port, its debug switch -- and
    // has no meaning once there is no bridge.
    if (flag.startsWith("-")) {
      if (inlineValue == null && /^--(host|port|static-oauth-client-metadata|header-file)$/.test(flag)) index += 1;
      continue;
    }
    if (url == null) url = arg;
  }
  return url == null ? null : { type, url, headers };
}

/** The store field a hoisted literal is filed under: the connector, then what the header is for. */
function hoistedFieldName(connector: string, header: string): string {
  const vendor = connector.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "SERVER";
  const suffix = /^authorization$/i.test(header.trim())
    ? "TOKEN"
    : header.trim().replace(/^x[-_]/i, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "TOKEN";
  return `${vendor}_${suffix}`;
}

export function migrateBridgedRemoteEntries(
  rootDir: string,
  options: { storeSecret?: (connector: string, field: string, value: string) => boolean } = {},
): { migrated: string[]; skipped: Array<{ name: string; reason: string }> } {
  const document = readLocalConnectorDocument(rootDir);
  const migrated: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const [name, raw] of Object.entries(document)) {
    const config = parseServer(raw);
    if (config == null) continue;
    const bridged = bridgedRemoteEntry(config);
    if (bridged == null) continue;
    const headers: Record<string, string> = {};
    let blocked: string | null = null;
    for (const [header, value] of Object.entries(bridged.headers)) {
      if (credentialPlaceholderNames(value).length > 0 || !looksLikeCredential(value)) {
        headers[header] = value;
        continue;
      }
      const field = hoistedFieldName(name, header);
      const bearer = /^Bearer\s+/i.test(value);
      const stored = options.storeSecret?.(name, field, value.replace(/^Bearer\s+/i, ""));
      if (stored !== true) {
        blocked = `its "${header}" header carries the key itself and it could not be moved into the store`;
        break;
      }
      headers[header] = bearer ? `Bearer \${${field}}` : `\${${field}}`;
    }
    if (blocked != null) { skipped.push({ name, reason: blocked }); continue; }
    // A bridged entry on a private address ALREADY has that reach: it was written when the door
    // allowed it and it has been making those requests ever since. Migrating it is about where the
    // key lives, not about revoking reach nobody asked to revoke, so the entry carries the opt-in
    // explicitly rather than being refused by the new rule and left leaking on the bridge. A NEW
    // entry at the same address still meets the refusal, at every door.
    let privateAddress = false;
    try { privateAddress = isPrivateHostname(new URL(bridged.url).hostname); } catch { privateAddress = false; }
    const entry: LocalRemoteServerConfig = {
      type: bridged.type,
      url: bridged.url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(config.disabled === true ? { disabled: true } : {}),
      ...(privateAddress ? { allowPrivateNetwork: true } : {}),
    };
    const refusal = localConnectorEntryRefusal(name, entry);
    if (refusal != null) { skipped.push({ name, reason: refusal }); continue; }
    document[name] = {
      type: entry.type,
      url: entry.url,
      ...(entry.headers === undefined ? {} : { headers: { ...entry.headers } }),
      ...(entry.disabled === true ? { disabled: true } : {}),
      ...(entry.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    };
    migrated.push(name);
  }
  if (migrated.length > 0) writeLocalConnectorDocument(rootDir, document);
  return { migrated, skipped };
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
    const { disabled: _disabled, allowPrivateNetwork: _allowed, headers, url, ...rest } = config;
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
