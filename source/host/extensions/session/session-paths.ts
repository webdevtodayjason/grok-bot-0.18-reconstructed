import { readFileSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { envWithSandBoxSettings, SAND_MAINTENANCE_SETTINGS } from "../../sand-box-setting.js";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getSandRootDir } from "../../host-paths.js";
import { assertValidSandAgentId, getSandAgentsRootDir } from "../../storage/agent-paths.js";
import { reportSessionDiagnostic } from "./session-diagnostics.js";

export const STORE_FILENAME = "store.db";
export const CONVERSATION_BLOBS_FILENAME = "conversation-blobs.db";
export const SAND_CONVERSATION_ROOT_SLOT_ID = new TextEncoder().encode("sand-live-conversation-root-v1__");
export const STALE_ROOT_CLEANUP_VERSION = 1;
export const ACTIVE_AGENT_FILENAME = "active-agent.json";
export const HIDDEN_ENTRY_REPAIR_VERSION = 1;
export const LEGACY_GROUP_MEMBERS_DIRNAME = "members";
export const CONNECTOR_SECRETS_DIRNAME = "connector-secrets";

let pinnedStaleRootGcEnabled = false;

export function pinStaleRootGc(enabled: boolean): void { pinnedStaleRootGcEnabled = enabled; }
export function isStaleRootGcEnabled(env: NodeJS.ProcessEnv = envWithSandBoxSettings(SAND_MAINTENANCE_SETTINGS)): boolean {
  const raw = env.SAND_STALE_ROOT_GC?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return pinnedStaleRootGcEnabled;
}
export function getSandTranscriptsDir(homeDir = homedir()): string { return join(getSandRootDir(homeDir), "agent-transcripts"); }
export function getAgentDbPath(rootDir: string, agentId: string): string { assertValidSandAgentId(agentId); return join(rootDir, agentId, STORE_FILENAME); }
export function getConnectorSecretsRoot(agentsRootDir = getSandAgentsRootDir()): string { return join(dirname(agentsRootDir), CONNECTOR_SECRETS_DIRNAME); }

function errorClass(error: unknown): string { return error instanceof Error ? error.name : typeof error; }
export async function statIfExists(path: string): Promise<Stats | undefined> {
  try { return await stat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") reportSessionDiagnostic({ family: "store_db", kind: "path_stat_failed", agentId: basename(dirname(path)), errorClass: errorClass(error) });
    return undefined;
  }
}

/**
 * PHANTOM-2 tombstones. deleteSession removes the directory, but a handle opened before the delete
 * (a clone being committed, a late ledger or checkpoint write, a per-agent command the dashboard
 * still holds an id for) writes the directory back, and the next roster build turns whatever it
 * finds into a "New Agent". A deleted id is recorded here; readers skip it, a resurrected directory
 * is swept on sight, and no database is opened for it again. Bounded to the newest entries.
 */
const DELETED_AGENTS_FILENAME = "deleted-agents.json";
const DELETED_AGENTS_MAX = 1000;
const deletedCache = new Map<string, { mtimeMs: number; ids: Set<string> }>();
export function getDeletedAgentsPath(rootDir: string): string { return join(rootDir, DELETED_AGENTS_FILENAME); }
export function readDeletedAgentIds(rootDir: string): Set<string> {
  const path = getDeletedAgentsPath(rootDir);
  let mtimeMs = -1;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return new Set(); }
  const cached = deletedCache.get(path);
  if (cached != null && cached.mtimeMs === mtimeMs) return cached.ids;
  let ids = new Set<string>();
  try { const parsed = JSON.parse(readFileSync(path, "utf8")); if (Array.isArray(parsed)) ids = new Set(parsed.filter((id): id is string => typeof id === "string")); } catch {}
  deletedCache.set(path, { mtimeMs, ids });
  return ids;
}
export function markAgentDeleted(rootDir: string, agentId: string): void {
  const path = getDeletedAgentsPath(rootDir);
  const ids = [...readDeletedAgentIds(rootDir)].filter((id) => id !== agentId);
  ids.push(agentId);
  const trimmed = ids.slice(-DELETED_AGENTS_MAX);
  try { writeFileSync(path, JSON.stringify(trimmed), { mode: 0o600 }); } catch {}
  deletedCache.delete(path);
}
export function isAgentDeleted(rootDir: string, agentId: string): boolean { return readDeletedAgentIds(rootDir).has(agentId); }
