import { isAgentDeleted } from "./session-paths.js";
import {
  SAND_DEFAULT_AGENT_NAME,
  SAND_FIRST_AGENT_AVATAR_SHAPE,
  SAND_FIRST_AGENT_NAME,
  SandAgentLimitError,
} from "../../../shared/agents/agents.js";
import { isSandGroupDir } from "../../groups/group-store.js";
import { resolveSandMaxAgents } from "../../sand-box-setting.js";
import { randomUUID } from "node:crypto";
import { isSandSubagentId } from "../../../shared/agents/subagents.js";
import { readdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { getSandProfilePath, writeSandProfileFile, type SandAgentProfile } from "../../agents/agent-profile.js";
import { getSandSettingsPath, writeSandSettingsFile } from "../../agents/settings-file.js";
import { SandAgentDb } from "./agent-db.js";
import { getAgentDbPath } from "./session-paths.js";
import { automationStoreForDbPath, channelStoreForDbPath, workflowStoreForDbPath } from "./session-store-factories.js";
import { writeLeadAgentId } from "../../runner/standing-persona.js";
import type { AgentWorkerPool } from "../../agent-isolation/agent-worker-pool.js";

export const DEFAULT_AGENT_AUTOMATIONS: readonly unknown[] = [];
export class SandAgentMissingError extends Error { constructor(agentId: string) { super(`Sand agent ${agentId} does not exist`); this.name = "SandAgentMissingError"; } }
// AGENTS-CAP-1. There used to be a second SandAgentLimitError declared right here, with its own
// message ("Agent limit of 50 reached"), while `isSandAgentLimitError` in shared/agents/agents.ts
// tested for the OTHER class's message ("50 is the maximum"). The two never matched, so the two
// callers that catch a limit -- `tryEnsureSession` and the post-delete fallback -- rethrew instead.
// One class now, imported from shared, carrying the ceiling that was actually in force.
export { SandAgentLimitError };

/** What one mint may ask of the cap. A group is not a bot, so it is minted exempt. */
export interface MintOptions { readonly isExemptFromAgentCap?: boolean }

export interface WorkerPool { closeAll(): Promise<void> }
export interface MaterializedSession {
  id: string;
  dbPath: string;
  db: SandAgentDb;
  agentStore: { resetFromDb?(ctx: unknown): Promise<void>; getFullConversation(ctx: unknown): Promise<unknown>; dispose(): Promise<void> };
  memory: unknown;
  automations: ReturnType<typeof automationStoreForDbPath>;
  workflows: ReturnType<typeof workflowStoreForDbPath>;
  channels: ReturnType<typeof channelStoreForDbPath>;
}
/**
 * SUBAGENT-1. What a subagent gets, and it is exactly a place to keep its conversation: a database,
 * a blob store composed over it, and a close. No profile, no settings, no automations, no memory.
 */
export interface SubagentStorage {
  readonly id: string;
  readonly dbPath: string;
  readonly db: SandAgentDb;
  readonly agentStore: MaterializedSession["agentStore"];
  close(): Promise<void>;
}
export interface MaterializationHost {
  ctx: unknown;
  rootDir: string;
  createBlobWorkerPool(): AgentWorkerPool;
  createAgentStore(args: { pool: AgentWorkerPool; agentId: string; dbPath: string; db: SandAgentDb }): MaterializedSession["agentStore"];
  createMemoryStore(agentDir: string): unknown;
  resolveUserTimeZone(): string | undefined;
  agentExists(agentId: string): boolean;
  getAgentDir(agentId: string): string;
  readActiveAgentId(): string | null;
  isVisibleAgent?(agentId: string): Promise<boolean>;
  runMaintenance?(session: MaterializedSession): Promise<void>;
  report?(event: Record<string, unknown>): void;
}

export class SandSessionMaterialization {
  private workerPool: AgentWorkerPool | null = null;
  private mintChain = Promise.resolve();
  constructor(readonly host: MaterializationHost) {}

  requireWorkerPool(): AgentWorkerPool { this.workerPool ??= this.host.createBlobWorkerPool(); return this.workerPool; }
  async closeWorkerPool(): Promise<void> { const pool = this.workerPool; if (pool == null) return; this.workerPool = null; await pool.closeAll(); }
  async listAgentRecordIds(): Promise<string[]> { try { return (await readdir(this.host.rootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !isSandSubagentId(entry.name) && !isAgentDeleted(this.host.rootDir, entry.name)).map((entry) => entry.name).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  async countOwnedAgents(): Promise<number> { return (await this.listAgentRecordIds()).length; }
  /**
   * AGENTS-CAP-1. What the cap counts: bots. A group lives in an agent directory like everything
   * else, but it is a room, not a bot, so a directory carrying a group config is skipped.
   */
  async countCapAgents(): Promise<number> {
    let count = 0;
    for (const agentId of await this.listAgentRecordIds()) {
      if (!isSandGroupDir(this.host.getAgentDir(agentId))) count += 1;
    }
    return count;
  }
  enqueueMint<T>(run: () => Promise<T>): Promise<T> { const next = this.mintChain.then(run, run); this.mintChain = next.then(() => {}, () => {}); return next; }

  async mintAgent<T>(mint: (agentId: string) => Promise<T>, options: MintOptions = {}): Promise<T> {
    return this.enqueueMint(async () => {
      if (options.isExemptFromAgentCap !== true && await this.isAgentCapReached()) throw new SandAgentLimitError(resolveSandMaxAgents());
      return this.runMint(randomUUID(), mint);
    });
  }
  private async runMint<T>(agentId: string, mint: (agentId: string) => Promise<T>): Promise<T> {
    try { return await mint(agentId); }
    catch (error) { try { await rm(this.host.getAgentDir(agentId), { recursive: true, force: true }); } catch (cleanupError) { this.host.report?.({ family: "materialize", kind: "mint_cleanup_failed", agentId, errorClass: cleanupError instanceof Error ? cleanupError.name : typeof cleanupError }); } throw error; }
  }
  async createSession(profile?: Partial<SandAgentProfile>, origin: "user" | "dev" = "user", purpose?: string, options: MintOptions = {}): Promise<MaterializedSession> { return this.mintAgent((agentId) => this.materializeSession(agentId, profile, origin, purpose), options); }
  /**
   * The one place a fresh box's first agent is born. ONBOARD-1: when there is nothing here yet,
   * that agent is Titan -- the person's AI lead -- rather than the anonymous "New Bot". The
   * profile is only supplied when the box is genuinely empty, so an existing agent is never
   * renamed and a second agent minted here still gets the default name.
   */
  async createFallbackSession(open: (agentId: string) => Promise<MaterializedSession>): Promise<MaterializedSession> {
    return this.enqueueMint(async () => {
      if (await this.isAgentCapReached()) {
        for (const agentId of await this.listAgentRecordIds()) { try { return await open(agentId); } catch (error) { this.host.report?.({ family: "materialize", kind: "fallback_adopt_failed", agentId, errorClass: error instanceof Error ? error.name : typeof error }); } }
        throw new SandAgentLimitError(resolveSandMaxAgents());
      }
      const isFirstAgent = (await this.countOwnedAgents()) === 0;
      const profile = isFirstAgent ? { name: SAND_FIRST_AGENT_NAME, avatarShape: SAND_FIRST_AGENT_AVATAR_SHAPE } : undefined;
      return this.runMint(randomUUID(), async (agentId) => {
        const session = await this.materializeSession(agentId, profile, "user");
        // PERSONA-1. This is the one moment the host KNOWS which agent is the workspace's lead,
        // so it is recorded here rather than guessed later. `writeLeadAgentId` keeps whatever is
        // already on disk, so a box repaired at host start is never overwritten.
        if (isFirstAgent) {
          try { writeLeadAgentId(agentId); }
          catch { /* no marker is a missing paragraph in one prompt, never a failed mint */ }
        }
        return session;
      });
    });
  }
  private compose(agentId: string, dbPath: string, db: SandAgentDb): MaterializedSession {
    return { id: agentId, dbPath, db, agentStore: this.host.createAgentStore({ pool: this.requireWorkerPool(), agentId, dbPath, db }), memory: this.host.createMemoryStore(dirname(dbPath)), automations: automationStoreForDbPath(dbPath, this.host.resolveUserTimeZone), workflows: workflowStoreForDbPath(dbPath, this.host.resolveUserTimeZone), channels: channelStoreForDbPath(dbPath) };
  }
  async materializeSession(agentId: string, profile?: Partial<SandAgentProfile>, origin: "user" | "dev" = "user", purpose?: string): Promise<MaterializedSession> {
    const dbPath = getAgentDbPath(this.host.rootDir, agentId), db = new SandAgentDb(dbPath);
    try {
      db.set("agentId", agentId); db.setAgentOrigin(origin); if (purpose != null) db.setAgentPurpose(purpose);
      writeSandProfileFile(getSandProfilePath(dirname(dbPath)), { name: profile?.name?.trim() || SAND_DEFAULT_AGENT_NAME, description: profile?.description?.trim() ?? "", title: profile?.title?.trim() ?? "", avatarShape: profile?.avatarShape?.trim() ?? "", avatarColor: profile?.avatarColor?.trim() ?? "" });
      writeSandSettingsFile(getSandSettingsPath(dirname(dbPath)), { notifyOnAgentUpdates: true });
      const session = this.compose(agentId, dbPath, db);
      for (const spec of DEFAULT_AGENT_AUTOMATIONS) session.automations.upsert(spec as never);
      return session;
    } catch (error) { db.close(); throw error; }
  }
  /**
   * SUBAGENT-1. A subagent's own storage, opened or created, and nothing a bot gets.
   *
   * The only creator of a store was `materializeSession`, and it also writes profile.json and
   * settings.json and seeds DEFAULT_AGENT_AUTOMATIONS -- the things that make a directory a bot. So
   * a background subagent, which runs real turns under its own id, had nowhere to put them: it was
   * bound to its PARENT's store, its turns settled against the parent's conversation, and its own
   * directory held an audit ledger and nothing else. This composes the store and stops.
   *
   * Giving a subagent a database does not make it a bot: `listAgentRecordIds` already skips every
   * sand-subagent- directory, so neither the roster nor the agent cap can see one.
   */
  async openSubagentStorage(agentId: string): Promise<SubagentStorage> {
    if (!isSandSubagentId(agentId)) throw new Error(`Not a subagent id: ${agentId}`);
    const dbPath = getAgentDbPath(this.host.rootDir, agentId), db = new SandAgentDb(dbPath);
    try {
      db.set("agentId", agentId);
      const agentStore = this.host.createAgentStore({ pool: this.requireWorkerPool(), agentId, dbPath, db });
      // A resumed subagent keeps the conversation it already had; a fresh one resets to empty.
      await agentStore.resetFromDb?.(this.host.ctx);
      let closed = false;
      // Checkpointed on close, because a subagent's store is read by people and tools after it has
      // stopped: a write-ahead log left beside it is invisible to a read-only reader.
      return { id: agentId, dbPath, db, agentStore, close: async () => { if (closed) return; closed = true; try { await agentStore.dispose(); } finally { db.close({ checkpoint: true }); } } };
    } catch (error) { db.close(); throw error; }
  }
  async openSession(agentId: string): Promise<MaterializedSession> {
    if (!this.host.agentExists(agentId)) throw new SandAgentMissingError(agentId);
    const dbPath = getAgentDbPath(this.host.rootDir, agentId), db = new SandAgentDb(dbPath);
    try {
      const profilePath = getSandProfilePath(dirname(dbPath));
      try { await stat(profilePath); } catch { writeSandProfileFile(profilePath, { name: db.get("name") || SAND_DEFAULT_AGENT_NAME, description: db.getSandProfile().description, title: "", avatarShape: "", avatarColor: "" }); }
      const session = this.compose(agentId, dbPath, db);
      await session.agentStore.resetFromDb?.(this.host.ctx);
      await this.host.runMaintenance?.(session);
      return session;
    } catch (error) { db.close(); throw error; }
  }
  async isAgentCapReached(): Promise<boolean> { const max = resolveSandMaxAgents(); if (await this.countCapAgents() < max) return false; await this.reclaimPrunedPlaceholders(); return await this.countCapAgents() >= max; }
  async isPrunedPlaceholder(agentId: string): Promise<boolean> { try { await stat(getAgentDbPath(this.host.rootDir, agentId)); } catch { return false; } if (agentId === this.host.readActiveAgentId()) return false; return this.host.isVisibleAgent != null ? !(await this.host.isVisibleAgent(agentId)) : false; }
  async reclaimPrunedPlaceholders(): Promise<void> { for (const agentId of await this.listAgentRecordIds()) { if (!await this.isPrunedPlaceholder(agentId)) continue; try { await rm(this.host.getAgentDir(agentId), { recursive: true, force: true }); } catch (error) { this.host.report?.({ family: "materialize", kind: "placeholder_reclaim_failed", agentId, errorClass: error instanceof Error ? error.name : typeof error }); } } }
}
