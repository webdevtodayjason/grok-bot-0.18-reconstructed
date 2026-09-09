/**
 * CLOUD-BROWSER-1. Where a cloud browser's key lives, and why it is not in either store we had.
 *
 * Browser Use already has a catalog row with an MCP connector, so its key already lands in
 * `servers["browser-use"].BROWSER_USE_API_KEY` through the existing setConnectorSecret path. There
 * is nothing new to build for it and this module reads it from exactly there.
 *
 * Browserbase has no honest connector to hang a credential on: its MCP repo is archived, its MCP
 * key travels as a URL query parameter that the door refuses, and `assertConnectorCredentialField`
 * refuses any field no connectors.json entry declares empty. Inventing a connectors.json entry so
 * there is somewhere to put the key would ship a connector that can only ever fail, which is the
 * live CONNECT-13 defect, so we do not do that.
 *
 * The obvious escape is the WRONG escape. shell-secrets.ts's own header states what its section is
 * for: values merged into the environment of the box exec-daemon, the process that spawns every
 * /bin/sh the agent's shell tool runs, and it states the residual out loud -- the agent's shell can
 * read its own environment. That is correct for a credential the agent is MEANT to use from its
 * shell (`cr review --api-key "$..."`). It is exactly wrong for a cloud browser key, which no agent
 * ever types and which buys whoever holds it a browser on somebody else's bill.
 *
 * So: a THIRD top-level section in the same file, written through the same primitive.
 *
 *   { "servers":      { "<connector>": { "<ENV>": "<value>" } },   // connector-secrets.ts
 *     "shell":        { "<ENV>": "<value>" },                      // shell-secrets.ts
 *     "cloudBrowser": { "<ENV>": "<value>" } }                     // here
 *
 * Same file, same 0600, same temp-file-plus-rename, same env-name guard, and `writeSecretsDocument`
 * preserves the sections it is not writing so none of the three can drop another. The difference
 * that matters is the destination: this section is read in the HOST process, by the two vendor
 * adapters next door, and is merged into no child environment ever. There is a test that asserts
 * exactly that against buildShellSecretEnvironmentUpdate, because the whole value of a third
 * section is the promise that it never becomes the second one.
 *
 * On listing versus reading: everything a gateway command or a console can reach returns NAMES.
 * `readCloudBrowserKey` is the one reader that returns a value, it is called by the vendor adapters
 * in this same directory and by nothing else, and its answer never leaves this process.
 */

import {
  isConnectorEnvFieldName,
  readConnectorEnvSecrets,
  readSecretsDocument,
  writeSecretsDocument,
} from "../../mcp/connector-secrets.js";

export const CLOUD_BROWSER_SECRETS_SECTION = "cloudBrowser";

/** The two engines this wave ships. `box` is not an engine here: it is the absence of one. */
export type CloudBrowserVendor = "browser-use" | "browserbase";

/** Browser Use's key already has a home: its own connector's env, through setConnectorSecret. */
export const BROWSER_USE_CONNECTOR_NAME = "browser-use";
export const BROWSER_USE_KEY_FIELD = "BROWSER_USE_API_KEY";

/**
 * Browserbase's two fields. The project id is not a secret and the key is, and they are kept
 * together anyway: a key with no project id opens nothing, so splitting them across two stores
 * would only mean two places to look when a session will not start.
 */
export const BROWSERBASE_KEY_FIELD = "BROWSERBASE_API_KEY";
export const BROWSERBASE_PROJECT_FIELD = "BROWSERBASE_PROJECT_ID";

/** Every field name this section is allowed to hold, so a typo cannot become a stored orphan. */
export const CLOUD_BROWSER_FIELDS: readonly string[] = [
  BROWSER_USE_KEY_FIELD,
  BROWSERBASE_KEY_FIELD,
  BROWSERBASE_PROJECT_FIELD,
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The section, parsed. A missing or malformed file is "no secrets", never an error. */
function readSection(rootDir: string): Record<string, string> {
  const section = asRecord(readSecretsDocument(rootDir)[CLOUD_BROWSER_SECRETS_SECTION]);
  if (section == null) return {};
  const entries: Record<string, string> = {};
  for (const [field, value] of Object.entries(section)) {
    if (typeof value === "string" && value.length > 0 && isConnectorEnvFieldName(field)) entries[field] = value;
  }
  return entries;
}

/** Field NAMES only. This is what a gateway command and the console are allowed to see. */
export function listCloudBrowserSecretFields(rootDir: string): string[] {
  return Object.keys(readSection(rootDir)).sort();
}

/**
 * Stores one value. Returns false when the field is not one this section holds -- the allowlist is
 * closed rather than open, because there is no reason for a cloud-browser field nobody named and
 * every reason not to let a typed field name decide what a file at 0600 carries.
 */
export function writeCloudBrowserSecret(rootDir: string, field: string, value: string): boolean {
  if (!CLOUD_BROWSER_FIELDS.includes(field) || !isConnectorEnvFieldName(field) || value.length === 0) return false;
  const section = { ...readSection(rootDir), [field]: value };
  writeSecretsDocument(rootDir, {
    ...readSecretsDocument(rootDir),
    [CLOUD_BROWSER_SECRETS_SECTION]: section,
  });
  return true;
}

/** Removes one field. False means there was nothing stored under that name. */
export function deleteCloudBrowserSecret(rootDir: string, field: string): boolean {
  const stored = readSection(rootDir);
  if (!(field in stored)) return false;
  const { [field]: _removed, ...rest } = stored;
  writeSecretsDocument(rootDir, {
    ...readSecretsDocument(rootDir),
    [CLOUD_BROWSER_SECRETS_SECTION]: rest,
  });
  return true;
}

/**
 * The one reader that returns a value, called by the two vendor adapters in this directory.
 *
 * Browser Use is read from its CONNECTOR's env first, because that is where setConnectorSecret
 * already puts it and a second copy would be a second thing to rotate. The cloudBrowser section is
 * the fallback for an install that stored it here instead.
 */
export function readCloudBrowserKey(rootDir: string, vendor: CloudBrowserVendor): string | null {
  const section = readSection(rootDir);
  if (vendor === "browser-use") {
    const fromConnector = readConnectorEnvSecrets(rootDir)[BROWSER_USE_CONNECTOR_NAME]?.[BROWSER_USE_KEY_FIELD];
    if (typeof fromConnector === "string" && fromConnector.length > 0) return fromConnector;
    return section[BROWSER_USE_KEY_FIELD] ?? null;
  }
  return section[BROWSERBASE_KEY_FIELD] ?? null;
}

/** Browserbase will not open a session without one, and it is not a credential. */
export function readBrowserbaseProjectId(rootDir: string): string | null {
  return readSection(rootDir)[BROWSERBASE_PROJECT_FIELD] ?? null;
}

/**
 * Which engines could actually run right now, by name, with no value anywhere in the answer. The
 * router asks this before it routes, so a workspace pinned to an engine whose key was never stored
 * falls back to the box instead of failing a tool call with a vendor's 401.
 */
export function storedCloudBrowserVendors(rootDir: string): CloudBrowserVendor[] {
  const vendors: CloudBrowserVendor[] = [];
  if (readCloudBrowserKey(rootDir, "browser-use") != null) vendors.push("browser-use");
  if (readCloudBrowserKey(rootDir, "browserbase") != null && readBrowserbaseProjectId(rootDir) != null) {
    vendors.push("browserbase");
  }
  return vendors;
}
