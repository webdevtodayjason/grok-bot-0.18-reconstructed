/**
 * MAIL-2 / PERSONA-1. The box's own copy of its agents' email addresses.
 *
 * The directory lives on the control plane and the routing lives on the relay; neither is
 * reachable from a prompt render, because `getSystemPrompt()` is synchronous. So the persona
 * cannot ask anybody what this agent's address is -- it has to read a file the box already holds.
 * The relay writes that file through the `setAgentMail` gateway command after each roster sweep,
 * and this module is both ends of it.
 *
 * Two rules the file's shape follows, both learned rather than designed:
 *
 *   - It is NOT a box secret. `SAND_`-prefixed keys are reserved in box-secrets.json, and
 *     `BoxSecretsApplier.applyPersisted` bails out silently on a reserved key, so parking mail
 *     state there would stop every real secret from being injected and the next `setBoxSecrets`
 *     would wipe it out again. Same reasoning as sand-host-settings.json, and the same remedy: a
 *     host-owned file next to the rest of the sand data that nothing else rewrites.
 *
 *   - The read is SYNCHRONOUS and cached against the file's nanosecond mtime and its size, in
 *     exactly the shape `readSandBoxSetting` uses (sand-box-setting.ts), because the prompt
 *     assembly calls it on every render. A stat per call is the cheap half of a read, and the
 *     nanosecond mtime is the key because rewriting one six-digit code keeps the file's length.
 *
 * Delivery never depends on this file. Only the sentence the agent says about itself does, so a
 * box on an older bundle that has no `setAgentMail` still receives mail; its lead agent just says
 * it has no address yet, which is true of everything that box can prove.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getSandRootDir } from "../../host-paths.js";

export const SAND_AGENT_MAIL_FILENAME = "agent-mail.json";

export interface AgentMailAddress {
  /** The six digits the control plane minted for this (tenant, agent) pair. Never reused. */
  readonly code: string;
  /** The whole address, so nothing downstream has to know how one is spelled. */
  readonly address: string;
}

export interface AgentMailFile {
  readonly domain: string;
  /** Whether a send route is wired yet. False means "you can receive, you cannot send". */
  readonly canSend: boolean;
  readonly updatedAt: number;
  readonly addresses: Readonly<Record<string, AgentMailAddress>>;
}

export interface AgentMailWriteEntry {
  readonly agentId: string;
  readonly code: string;
  readonly address: string;
}

export function getAgentMailPath(sandRoot: string = getSandRootDir()): string {
  return join(sandRoot, SAND_AGENT_MAIL_FILENAME);
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function parseAgentMail(raw: unknown): AgentMailFile | null {
  if (typeof raw !== "object" || raw == null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isNonEmptyString(record.domain)) return null;
  const addresses: Record<string, AgentMailAddress> = {};
  const source = record.addresses;
  if (typeof source === "object" && source != null && !Array.isArray(source)) {
    for (const [agentId, value] of Object.entries(source as Record<string, unknown>)) {
      if (typeof value !== "object" || value == null || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (!isNonEmptyString(entry.code) || !isNonEmptyString(entry.address)) continue;
      addresses[agentId] = { code: entry.code.trim(), address: entry.address.trim() };
    }
  }
  return {
    domain: record.domain.trim(),
    canSend: record.canSend === true,
    updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : 0,
    addresses,
  };
}

let cached: { path: string; mtime: string; size: number; value: AgentMailFile | null } | undefined;

/**
 * The whole file, or null when this box has never been told its domain. Never throws: a
 * half-written or unreadable file means "no address yet", never a thrown turn.
 */
export function readAgentMail(sandRoot: string = getSandRootDir()): AgentMailFile | null {
  const path = getAgentMailPath(sandRoot);
  let stamp: { mtime: string; size: number };
  try {
    const stats = statSync(path, { bigint: true });
    stamp = { mtime: stats.mtimeNs.toString(), size: Number(stats.size) };
  } catch {
    cached = undefined;
    return null;
  }
  if (
    cached != null
    && cached.path === path
    && cached.mtime === stamp.mtime
    && cached.size === stamp.size
  ) return cached.value;
  let value: AgentMailFile | null = null;
  try {
    value = parseAgentMail(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch { /* unreadable or half-written: no address, not a broken turn */ }
  cached = { path, ...stamp, value };
  return value;
}

/** This agent's own address, or null. The only reader the persona section needs. */
export function readAgentMailFor(
  agentId: string | null | undefined,
  sandRoot: string = getSandRootDir(),
): AgentMailAddress | null {
  if (!isNonEmptyString(agentId)) return null;
  return readAgentMail(sandRoot)?.addresses[agentId] ?? null;
}

/**
 * Written whole, temp-then-rename, 0600. The relay sends the tenant's entire directory on each
 * sweep, so a merge would keep an address for an agent that has since been retired.
 */
export function writeAgentMail(
  input: {
    readonly domain: unknown;
    readonly canSend?: unknown;
    readonly addresses?: unknown;
  },
  sandRoot: string = getSandRootDir(),
): { readonly written: number } {
  if (!isNonEmptyString(input.domain)) throw new Error("setAgentMail needs a domain");
  const entries: Record<string, AgentMailAddress> = {};
  const list = Array.isArray(input.addresses) ? input.addresses : [];
  for (const item of list as readonly unknown[]) {
    if (typeof item !== "object" || item == null || Array.isArray(item)) continue;
    const entry = item as Partial<AgentMailWriteEntry>;
    if (!isNonEmptyString(entry.agentId)) continue;
    if (!isNonEmptyString(entry.code) || !isNonEmptyString(entry.address)) continue;
    entries[entry.agentId.trim()] = { code: entry.code.trim(), address: entry.address.trim() };
  }
  const file: AgentMailFile = {
    domain: input.domain.trim(),
    canSend: input.canSend === true,
    updatedAt: Date.now(),
    addresses: entries,
  };
  const path = getAgentMailPath(sandRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  try { chmodSync(path, 0o600); } catch { /* a filesystem with no modes is not a failure */ }
  cached = undefined;
  return { written: Object.keys(entries).length };
}
