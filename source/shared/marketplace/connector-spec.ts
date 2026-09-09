/**
 * What a plugin's server IS, kept apart from how this box happens to run it.
 *
 * A catalog row declares a `ConnectorSpec`: either a program the box runs (`stdio`) or an endpoint
 * it talks to (`http`, `sse`). It never declares a bridge, a package version of a bridge, a header
 * file or an argv. `connectorEntryFromSpec` is the ONE function in this tree that knows the word
 * mcp-remote, so the day the host learns to speak a remote endpoint natively -- or the day the
 * bridge's header has to move off the command line -- exactly one function changes and no row does.
 *
 * WHY THAT MATTERS, measured on the R750 demo box: the box's exec daemon expands `${VAR}` from an
 * entry's own env map into `command`, `args`, `cwd` and `env` BEFORE it execs, so a bridged
 * `--header "Authorization:Bearer ${TINYFISH_API_KEY}"` puts the real key in ARGV, where
 * `ps -eo args` shows it to anything in the box -- including the agent's own shell, which is root.
 * That is the rung this module exists to climb off:
 *
 *   native              the daemon's own `{type, url, headers}` shape. No argv, no bridge process,
 *                       no npm fetch at spawn, and a fast honest 401 instead of a 60-second stall.
 *                       The host substitutes the header value at push time from the 0600 store.
 *   bridge-header-file  mcp-remote, with the header read from a 0600 file the host writes at push
 *                       time. `--header-file` is present in the 0.8.5 build the box already caches.
 *   bridge-argv         mcp-remote with the value on the command line. What every bridged entry on
 *                       a live box is today, and the reason for the other two. It stays the DEFAULT
 *                       here only so this module's arrival changes no entry on any box; the entries
 *                       that ship under it are the five that predate this wave.
 *
 * Nothing in this file is a credential, and nothing in it may become one: a header value is a
 * `${FIELD}` placeholder naming a field of the 0600 store, never a literal, and `refuseSpecSecrets`
 * is what makes that a rule rather than a habit.
 */

/** The transports a row may declare. `stdio` is a program; the other two are endpoints. */
export type ConnectorTransport = "stdio" | "http" | "sse";

/** A program the box runs. Every credential env value is the empty string (CONNECT-4). */
export interface StdioConnectorSpec {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * An endpoint the box talks to. Header values are `${FIELD}` placeholders and nothing else; `env`
 * names the fields those placeholders resolve against, each left empty, so the host's credential
 * rule sees them and the console draws a card.
 */
export interface RemoteConnectorSpec {
  readonly transport: "http" | "sse";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
}

export type ConnectorSpec = StdioConnectorSpec | RemoteConnectorSpec;

/** The connectors.json entry of a program: what `parseServer` accepts on every box today. */
export interface StdioConnectorEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The connectors.json entry of an endpoint, in the box daemon's own `remoteMcpServer` shape.
 *
 * No `env`. A remote entry has no process to give an environment to, and the fields it owes are
 * already named where they are used: a `${FIELD}` in a header value or in the url. The host reads
 * the credential names back out of exactly those placeholders, so carrying an env map beside them
 * would be a second copy of the same fact, and the two would eventually disagree.
 */
export interface RemoteConnectorEntry {
  readonly type: "http" | "sse";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type ConnectorEntry = StdioConnectorEntry | RemoteConnectorEntry;

export type RemoteConnectorMode = "bridge-argv" | "bridge-header-file" | "native";

/**
 * The rung this tree materialises a remote row on. Changing this constant migrates every remote row
 * at once and no row is edited, which is the whole reason it exists.
 *
 * `native`, since the spike answered on grok-bot-local-vm on 8 September 2026: the box's exec
 * daemon takes `{type, url, headers}` through LoadMcpServers and connects to the endpoint itself.
 * Measured there, a remote row reached `connected` with its tools listed 128 ms after its key was
 * stored, and the stored value appeared in none of the 186 process argument lists in that box. On
 * `bridge-argv` the same value was in three of them, because the daemon expands `${VAR}` into a
 * spawn's arguments before it execs and the agent's own shell in a box is root. There is no reason
 * left to run a bridge: it costs an npm fetch at spawn, a 60-second stall instead of a fast honest
 * 401, and the custody this wave is about.
 *
 * Entries already written on a live box are untouched by this and keep working; each one moves to
 * the native shape the next time it is written.
 */
export const DEFAULT_REMOTE_CONNECTOR_MODE: RemoteConnectorMode = "native";

/** The bridge, pinned. A bare `mcp-remote` resolves to whatever npm published this morning. */
export const MCP_REMOTE_PACKAGE = "mcp-remote@0.8.5";

/**
 * Where `bridge-header-file` writes a header file. NOT under sand-data on purpose: sand-data is
 * copied into the durable blob, and a secret file with a new name there would be a silent copy of
 * a credential into a store this wave does not own. /dev/shm is tmpfs, per box, gone on restart.
 */
export const MCP_REMOTE_HEADER_DIR = "/dev/shm/titanbot-mcp";

/** `${FIELD}` and nothing else. A header value is one placeholder, or a literal, and never both. */
const PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** `Bearer ${FIELD}` -- the one prefix a header value may carry, because every vendor wants it. */
const BEARER_PLACEHOLDER = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** The field a header value names, or null when it names none. */
export function headerPlaceholderField(value: string): string | null {
  return (PLACEHOLDER.exec(value)?.[1] ?? BEARER_PLACEHOLDER.exec(value)?.[1]) ?? null;
}

/**
 * Is this string shaped like a secret? The prefixes the services in this catalog actually mint,
 * each demanding a run of key-length characters after it, plus the two generic shapes: a long
 * unbroken base64-ish run, and an obvious assignment. Deliberately the same rule the catalog's own
 * "nothing in it is a credential" test applies, so a value that would fail that test cannot reach
 * a header either.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\b(?:xox[bpcdesar]|ghp|gho|ghu|ghs|ghr|github_pat|lin_api|ntn|pat|rk_live|sk|pk|re_|AKIA|AIza)[-_][A-Za-z0-9_-]{16,}/,
  /^[A-Za-z0-9+/_-]{40,}={0,2}$/,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
];
export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_SHAPES.some((shape) => shape.test(value));
}

export function isRemoteSpec(spec: ConnectorSpec): spec is RemoteConnectorSpec {
  return spec.transport !== "stdio";
}

export function isRemoteEntry(entry: ConnectorEntry): entry is RemoteConnectorEntry {
  return !("command" in entry);
}

/**
 * Is this URL safe to hand a box as an MCP endpoint?
 *
 * Three separate refusals, and each one has a reason on this machine:
 *   - http, or a loopback / private / link-local host: the gateway sits on 127.0.0.1:1340 and the
 *     exec daemons on 1337 and 1338 INSIDE the same box, so a "connector" pointed at localhost is a
 *     connector pointed at the control plane. An operator's own LAN service is the same class.
 *   - a credential in the userinfo or the query string: the URL is written to connectors.json in
 *     the clear and shows up in every status line, so a URL that is itself the key cannot be given
 *     the custody the store gives a header.
 *   - anything that is not a URL at all.
 */
/**
 * The hostname as an ADDRESS, not as the text somebody typed.
 *
 * Every address rule in this tree used to test the raw hostname against prefixes, and an IPv4
 * address wearing an IPv6 coat matches none of them. Measured against the live gateway on the R750
 * demo box on 2026-09-08: `https://[::ffff:127.0.0.1]:1341/mcp`, `https://[::]:1341/mcp` and
 * `https://[::ffff:169.254.169.254]/mcp` were all accepted with a secret header while plain
 * `https://127.0.0.1:1341/mcp` was refused, because Node's URL parser hands the tests
 * `::ffff:7f00:1`, `::` and `::ffff:a9fe:a9fe`. Same hole in all three validators, since all three
 * were written the same way.
 *
 * So: brackets and a zone id come off, a v4-mapped or v4-compatible address becomes its dotted
 * quad, and any other IPv6 literal becomes its full eight-group form so a prefix test means what it
 * says. Anything that is not an IP literal comes back as the lowercased name it was.
 */
const V6_LOOPBACK = "0:0:0:0:0:0:0:1";
const V6_UNSPECIFIED = "0:0:0:0:0:0:0:0";
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let text = host;
  // A trailing dotted quad (`::ffff:127.0.0.1`) is two hex groups written the other way.
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted != null) {
    const quad = (dotted[1] ?? "").split(".").map(Number);
    if (quad.length !== 4 || quad.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const high = (((quad[0] as number) << 8) | (quad[1] as number)).toString(16);
    const low = (((quad[2] as number) << 8) | (quad[3] as number)).toString(16);
    text = `${text.slice(0, dotted.index)}:${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = (halves[0] ?? "") === "" ? [] : (halves[0] as string).split(":");
  const tail = halves.length === 2 ? ((halves[1] ?? "") === "" ? [] : (halves[1] as string).split(":")) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail].map((group) => parseInt(group, 16));
  if (groups.length !== 8) return null;
  return groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff) ? null : groups;
}
export function normalizedHostname(hostname: string): string {
  const host = String(hostname ?? "").replace(/^\[|\]$/g, "").split("%")[0]?.toLowerCase() ?? "";
  const groups = ipv6Groups(host);
  if (groups == null) return host;
  const canonical = groups.map((group) => group.toString(16)).join(":");
  if (canonical === V6_LOOPBACK || canonical === V6_UNSPECIFIED) return canonical;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0);
  if (!mapped) return canonical;
  const high = groups[6] as number;
  const low = groups[7] as number;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

const CREDENTIAL_QUERY_KEYS = /^(?:api[-_]?key|key|token|access[-_]?token|auth|secret|password|pwd|sig|signature)$/i;
export function remoteMcpUrlProblem(where: string, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return `${where} has no URL`;
  let url: URL;
  try { url = new URL(raw); } catch { return `${where} has a URL that is not a URL ("${raw}")`; }
  if (url.protocol !== "https:") return `${where} must be https, not ${url.protocol.replace(":", "")}`;
  if (url.username.length > 0 || url.password.length > 0) {
    return `${where} carries a credential in the address itself; a key belongs in a header, where the store can hold it`;
  }
  for (const [key] of url.searchParams) {
    if (CREDENTIAL_QUERY_KEYS.test(key)) {
      return `${where} carries "${key}" in the query string; a key belongs in a header, where the store can hold it`;
    }
  }
  // Normalized first, then tested: `[::ffff:127.0.0.1]` is 127.0.0.1 and `[::]` is the box itself,
  // and the raw-text version of these tests said neither of them was.
  const host = normalizedHostname(url.hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host === V6_LOOPBACK || host === V6_UNSPECIFIED || host === "0.0.0.0") {
    return `${where} points inside the box (${url.hostname}); the gateway and the exec daemons live there`;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split(".").map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    const priv = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
    if (priv) return `${where} points at a private address (${url.hostname}); a plugin's endpoint has to be on the internet`;
  }
  // The canonical form prints every group in full, so these two are exactly fc00::/7 (unique local)
  // and fe80::/10 (link local) rather than whatever happens to start with the same two letters.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return `${where} points at a private address (${url.hostname}); a plugin's endpoint has to be on the internet`;
  }
  return null;
}

/**
 * A package argument with no version is a different program every morning. One rule, both package
 * managers: `npx -y name@version`, `uvx name==version`.
 */
export function unpinnedPackageArgument(command: string, args: readonly string[]): string | null {
  const runner = command.split("/").pop() ?? command;
  if (runner !== "npx" && runner !== "uvx" && runner !== "npm") return null;
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (runner === "uvx") return /(==|@)\S/.test(arg) ? null : arg;
    // npx: the first non-flag argument is the package. `@scope/name@version` keeps a leading @.
    const withoutScope = arg.startsWith("@") ? arg.slice(1) : arg;
    return withoutScope.includes("@") ? null : arg;
  }
  return null;
}

/** Every credential field a spec declares: the env keys it leaves empty. */
export function connectorSpecCredentialFields(spec: ConnectorSpec): readonly string[] {
  return Object.entries(spec.env).flatMap(([field, value]) => (value === "" ? [field] : []));
}

/**
 * A spec's problems, as sentences. Shared by the catalog's validator and by whatever validates an
 * operator's own "Add your own" submission, so a hand-typed server is held to the same rules a
 * shipped row is.
 */
export function connectorSpecProblems(where: string, spec: ConnectorSpec, allowedNonEmptyEnv: readonly string[] = []): string[] {
  const problems: string[] = [];
  for (const [field, value] of Object.entries(spec.env)) {
    if (value !== "" && !allowedNonEmptyEnv.includes(field)) {
      problems.push(`${where} gives env "${field}" a value; only a declared configuration key may carry one, because an empty value is how a credential field is recognised`);
    }
  }
  if (isRemoteSpec(spec)) {
    const urlProblem = remoteMcpUrlProblem(where, spec.url);
    if (urlProblem != null) problems.push(urlProblem);
    for (const [name, value] of Object.entries(spec.headers)) {
      if (name.trim().length === 0 || /[\s:]/.test(name)) problems.push(`${where} has a header name that is not a header name ("${name}")`);
      const field = headerPlaceholderField(value);
      if (field == null) {
        // A literal header is allowed only when it is plainly CONFIGURATION -- GitHub's
        // X-MCP-Toolsets and X-MCP-Readonly select which tools the server exposes and are no more
        // secret than the URL. What is refused is a literal that is shaped like a credential,
        // because that is a key in the repo and in connectors.json.
        if (looksLikeCredential(value)) {
          problems.push(`${where} sets header "${name}" to something shaped like a key; a credential belongs in the 0600 store behind a \${FIELD} placeholder`);
        }
      } else if (!Object.hasOwn(spec.env, field)) {
        problems.push(`${where} header "${name}" names \${${field}}, which the entry does not declare as a credential field`);
      }
    }
    return problems;
  }
  if (spec.command.trim().length === 0) problems.push(`${where} has no command`);
  const unpinned = unpinnedPackageArgument(spec.command, spec.args);
  if (unpinned != null) problems.push(`${where} runs "${unpinned}" with no version pinned`);
  for (const arg of spec.args) {
    const field = headerPlaceholderField(arg.includes(":") ? arg.slice(arg.indexOf(":") + 1) : arg);
    if (field != null && !Object.hasOwn(spec.env, field)) {
      problems.push(`${where} passes \${${field}}, which the entry does not declare as a credential field`);
    }
  }
  return problems;
}

export interface ConnectorEntryOptions {
  /** How a remote spec is materialised. Defaults to `DEFAULT_REMOTE_CONNECTOR_MODE`. */
  readonly remoteMode?: RemoteConnectorMode;
  /** The connectors.json key this entry takes. `bridge-header-file` needs it to name its file. */
  readonly connectorName?: string;
}

const transportFlag = (transport: "http" | "sse") => (transport === "sse" ? "sse-only" : "http-only");

/**
 * The connectors.json entry for a spec, on this box, today.
 *
 * A stdio spec is already an entry. A remote spec becomes whichever rung the mode names, and the
 * caller neither knows nor cares which: the row said "this is an https endpoint with an
 * Authorization header", and every word about npx, callback ports and `--transport http-only`
 * lives here.
 */
export function connectorEntryFromSpec(spec: ConnectorSpec, options: ConnectorEntryOptions = {}): ConnectorEntry {
  if (!isRemoteSpec(spec)) {
    return { command: spec.command, args: [...spec.args], env: { ...spec.env } };
  }
  const mode = options.remoteMode ?? DEFAULT_REMOTE_CONNECTOR_MODE;
  if (mode === "native") {
    return { type: spec.transport, url: spec.url, headers: { ...spec.headers } };
  }
  if (mode === "bridge-header-file") {
    const name = options.connectorName;
    if (name == null || name.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error("connectorEntryFromSpec needs a connectorName to write a header file against");
    }
    return {
      command: "npx",
      args: [
        "-y", MCP_REMOTE_PACKAGE, spec.url, "--transport", transportFlag(spec.transport),
        ...(Object.keys(spec.headers).length === 0 ? [] : ["--header-file", `${MCP_REMOTE_HEADER_DIR}/${name}`]),
      ],
      env: { ...spec.env },
    };
  }
  return {
    command: "npx",
    args: [
      "-y", MCP_REMOTE_PACKAGE, spec.url, "--transport", transportFlag(spec.transport),
      ...Object.entries(spec.headers).flatMap(([name, value]) => ["--header", `${name}:${value}`]),
    ],
    env: { ...spec.env },
  };
}

/**
 * The header lines `bridge-header-file` expects to find, given the values the store holds. The
 * host writes this; it is here because the file's FORMAT is the bridge's, and this module is where
 * the bridge lives. A field with nothing stored is left out rather than written empty: an empty
 * `Authorization:` header is a different failure from no header at all, and the second is honest.
 */
export function remoteHeaderFileLines(spec: RemoteConnectorSpec, values: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [name, placeholder] of Object.entries(spec.headers)) {
    const field = headerPlaceholderField(placeholder);
    if (field == null) continue;
    const value = values[field];
    if (value == null || value.length === 0) continue;
    lines.push(`${name}: ${placeholder.startsWith("Bearer ") ? `Bearer ${value}` : value}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
