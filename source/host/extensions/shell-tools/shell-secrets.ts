import {
  isConnectorEnvFieldName,
  readSecretsDocument,
  writeSecretsDocument,
} from "../mcp/connector-secrets.js";

/**
 * CONNECT-5. The other half of the connector credential plane: a credential that belongs to a
 * COMMAND the agent runs in its shell, not to an MCP server the host spawns.
 *
 * CodeRabbit ships no MCP server (docs/connectors/coderabbit.md): the integration is the `cr` CLI
 * run from the agent's shell with an Agentic API key, and the operator's own
 * `cli-anything-tinyfish` is the same shape -- a pip package that reads `TINYFISH_API_KEY` out of
 * the environment. Neither has a connectors.json entry to hang an empty env key on, so neither can
 * use the connector store's rule (an env key whose value is the empty string is a credential).
 *
 * This store is the same file, the same 0600 discipline and the same env-name guard, in its own
 * top-level section:
 *
 *   { "servers": { "<connector>": { "<ENV>": "<value>" } },   // connector-secrets.ts
 *     "shell":   { "<ENV>": "<value>" } }                     // here
 *
 * One file rather than two because there is exactly one secret file on this box to protect, and
 * because both writers go through `writeSecretsDocument`, which preserves the section it is not
 * writing. Values are merged into the environment of the box exec-daemon -- the process that
 * spawns every `/bin/sh -lc` the agent's shell tool runs -- through the box control plane, so
 * they reach the shell without ever being written into a file the agent's own tooling reads.
 *
 * Residual, stated rather than papered over: the agent's shell can read its own environment. That
 * is the point of this store -- the value has to be there for `cr review --api-key "$..."` to
 * work -- and it is the same custody the connector store already documents.
 */
export const SHELL_ENV_SECRETS_SECTION = "shell";

export type ShellEnvSecrets = Record<string, string>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The shell section. A missing or malformed file is "no secrets", never an error. */
export function readShellEnvSecrets(rootDir: string): ShellEnvSecrets {
  const section = asRecord(readSecretsDocument(rootDir)[SHELL_ENV_SECRETS_SECTION]);
  if (section == null) return {};
  const entries: ShellEnvSecrets = {};
  for (const [field, value] of Object.entries(section)) {
    if (typeof value === "string" && isConnectorEnvFieldName(field)) entries[field] = value;
  }
  return entries;
}

/** Field NAMES only. Nothing in this module ever returns a stored value to a caller. */
export function listShellEnvSecretFields(rootDir: string): string[] {
  return Object.keys(readShellEnvSecrets(rootDir)).sort();
}

/**
 * Stores one shell env value. Returns false when the field name is not an env name -- the same
 * guard the connector store uses, and for the same reason: the names it refuses (PATH,
 * NODE_OPTIONS, LD_*) are process control, not credentials, and this value is merged into the
 * environment of the process that spawns every shell the agent runs.
 */
export function writeShellEnvSecret(rootDir: string, field: string, value: string): boolean {
  if (!isConnectorEnvFieldName(field) || value.length === 0) return false;
  const shell = { ...readShellEnvSecrets(rootDir), [field]: value };
  writeSecretsDocument(rootDir, {
    ...readSecretsDocument(rootDir),
    [SHELL_ENV_SECRETS_SECTION]: shell,
  });
  return true;
}

/** Removes one field. False means there was nothing stored under that name. */
export function deleteShellEnvSecret(rootDir: string, field: string): boolean {
  const stored = readShellEnvSecrets(rootDir);
  if (!(field in stored)) return false;
  const { [field]: _removed, ...rest } = stored;
  writeSecretsDocument(rootDir, {
    ...readSecretsDocument(rootDir),
    [SHELL_ENV_SECRETS_SECTION]: rest,
  });
  return true;
}

export interface ShellSecretEnvironmentUpdate {
  readonly env: Record<string, string>;
  readonly replace: false;
}

/**
 * The environment update the box control plane applies to the exec-daemon, whose `#environment` is
 * what `spawn("/bin/sh", ["-lc", command], { env })` hands to every shell the agent runs.
 *
 * `replace` is false because the daemon's replace mode DELETES every variable the update does not
 * carry -- PATH and HOME included -- and this host does not know the box's environment. That is
 * also why a deleted field is pushed as the EMPTY STRING rather than removed: the control plane
 * can set, it cannot unset. An empty credential is exactly as unusable as an absent one, the
 * shell's own `${VAR:+...}` reports it unset, and a box restart drops it for real.
 */
export function buildShellSecretEnvironmentUpdate(
  rootDir: string,
  clearing: readonly string[] = [],
): ShellSecretEnvironmentUpdate {
  const env: Record<string, string> = {};
  for (const field of clearing) if (isConnectorEnvFieldName(field)) env[field] = "";
  for (const [field, value] of Object.entries(readShellEnvSecrets(rootDir))) env[field] = value;
  return { env, replace: false };
}
