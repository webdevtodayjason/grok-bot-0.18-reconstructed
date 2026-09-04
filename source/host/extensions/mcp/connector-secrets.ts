import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CP-10. A credential for a local stdio connector used to land in
 * `connector-secrets/<agentId>/<platform>.json` -- the chat-channel store, which no MCP code reads
 * and which sits in the agent's own data tree. Two failures in one: the connector never saw the
 * value, and the agent could read it back.
 *
 * This store is the other half. It is host-owned, lives beside `connectors.json` at the root of the
 * sand data directory (never under `agents/`), is written 0600, and holds ONLY connector process
 * environment: `{ "servers": { "<server name>": { "<ENV_NAME>": "<value>" } } }`. The value is
 * merged into that server's `env` when the stdio spawn spec is built (local-connectors.ts), so it
 * reaches the connector process and is never written into `connectors.json`.
 *
 * Residual, stated rather than papered over: the agent's shell runs as root in the same container,
 * so `/proc/<pid>/environ` of the connector process -- and this file -- are readable by a
 * determined agent. Custody is only really fixed by an unprivileged agent shell; that is not this
 * layer's job. What this layer does fix is the accidental path: no secret in a file the agent's
 * own tooling already reads, and no secret in the operator's connector config.
 */
export const CONNECTOR_ENV_SECRETS_FILENAME = "connector-env-secrets.json";

/** POSIX environment variable name. Anything else is rejected before it can reach a spawn spec. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * A POSIX env name is not enough. The field name is chosen by the MODEL (send-message-tool passes
 * `secret.field` through unchanged) and the only thing the human sees is a label the same model
 * wrote, so a request captioned "paste your API token" could otherwise put the pasted string into
 * NODE_OPTIONS or LD_PRELOAD on a connector this host spawns -- code execution wearing a
 * credential's clothes. On today's box that is not an escalation, because the agent's shell is
 * already root in the same container; it is exactly the hole that would reopen the moment the
 * unprivileged agent shell this module's header asks for lands. These names are process control,
 * not credentials, so no connector needs them from this path.
 */
const PROCESS_CONTROL_NAMES = new Set([
  "PATH", "NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "PYTHONPATH", "PYTHONSTARTUP",
  "PERL5OPT", "PERL5LIB", "RUBYOPT", "BASH_ENV", "ENV", "IFS", "SHELL",
]);
const PROCESS_CONTROL_PREFIXES = ["LD_", "DYLD_"];

export type ConnectorEnvSecrets = Record<string, Record<string, string>>;

export function isConnectorEnvFieldName(value: unknown): value is string {
  if (typeof value !== "string" || !ENV_NAME_PATTERN.test(value)) return false;
  const name = value.toUpperCase();
  if (PROCESS_CONTROL_NAMES.has(name) || name.endsWith("_PRELOAD")) return false;
  return !PROCESS_CONTROL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function secretsPath(rootDir: string): string {
  return join(rootDir, CONNECTOR_ENV_SECRETS_FILENAME);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The whole store. A missing or malformed file is "no secrets", never an error. */
export function readConnectorEnvSecrets(rootDir: string): ConnectorEnvSecrets {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(secretsPath(rootDir), "utf8")); }
  catch { return {}; }
  const servers = asRecord(asRecord(parsed)?.servers);
  if (servers == null) return {};
  const result: ConnectorEnvSecrets = {};
  for (const [server, fields] of Object.entries(servers)) {
    const shape = asRecord(fields);
    if (shape == null) continue;
    const entries: Record<string, string> = {};
    for (const [field, value] of Object.entries(shape)) {
      if (typeof value === "string" && isConnectorEnvFieldName(field)) entries[field] = value;
    }
    if (Object.keys(entries).length > 0) result[server] = entries;
  }
  return result;
}

/** Field NAMES only. Nothing in this module ever returns a stored value to a caller. */
export function listConnectorEnvSecretFields(rootDir: string, server: string): string[] {
  return Object.keys(readConnectorEnvSecrets(rootDir)[server] ?? {}).sort();
}

/**
 * This file is the ONLY copy of every local connector credential, so the write is atomic and the
 * mode is enforced rather than assumed. `writeFileSync` applies `mode` only when it CREATES the
 * file, so a store left at 0644 by an earlier build or an operator would have stayed world-readable
 * forever while the header promised 0600; and a truncating write that dies mid-flight leaves a
 * partial file that `readConnectorEnvSecrets` reads as "no secrets", silently restarting every
 * connector with no credentials. Temp file + rename + explicit chmod, the same shape
 * `SandConnectorSecretStore` already uses for the channel store.
 */
function writeStore(rootDir: string, store: ConnectorEnvSecrets): void {
  const path = secretsPath(rootDir), tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ servers: store }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
  try { chmodSync(path, 0o600); } catch { /* the rename already carried 0600 from the temp file */ }
}

/** Stores one connector env value. Returns false when the field name is not an env name. */
export function writeConnectorEnvSecret(
  rootDir: string,
  server: string,
  field: string,
  value: string,
): boolean {
  if (server.length === 0 || !isConnectorEnvFieldName(field) || value.length === 0) return false;
  const store = readConnectorEnvSecrets(rootDir);
  writeStore(rootDir, { ...store, [server]: { ...store[server], [field]: value } });
  return true;
}

/** Removes one field (or the server's whole entry when it was the last one). */
export function deleteConnectorEnvSecret(rootDir: string, server: string, field: string): boolean {
  const store = readConnectorEnvSecrets(rootDir);
  const fields = store[server];
  if (fields == null || !(field in fields)) return false;
  const { [field]: _removed, ...rest } = fields;
  const { [server]: _server, ...others } = store;
  writeStore(rootDir, Object.keys(rest).length === 0 ? others : { ...others, [server]: rest });
  return true;
}
