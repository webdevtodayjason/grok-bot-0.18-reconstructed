import { managedSkillFilesMatch, readManagedSkillsCache, writeManagedSkillsCache, type ManagedSkill } from "./managed-skills-cache.js";
import { SEED_MANAGED_SKILLS } from "./seed-skills.gen.js";
import { fetchedManagedSkillToSandSkill, type FetchedManagedSkill } from "./sand-managed-skills.js";

export type ManagedSkillsRefreshTrigger = "startup" | "auth_change" | "on_demand";
export interface ManagedSkillsServiceOptions {
  getCacheDir(): string;
  fetch(): Promise<readonly FetchedManagedSkill[]>;
  report?(event: { extension: "managed_setup"; kind: "managed_skills"; errorClass: string }): void;
}
function errorClass(error: unknown): string { return error instanceof Error ? error.name || "Error" : typeof error; }

/**
 * Every cache write is seeds plus whatever came back from Cursor, fetched winning on an id
 * collision so a newer dashboard copy still replaces a seed. `materializeManagedSkillFiles`
 * deletes any skills/<id> the written list does not name, so the union is also what stops a
 * successful-but-empty fetch (which is what an unauthenticated box gets) from erasing the seeds.
 */
export function unionWithSeedSkills(fetched: readonly ManagedSkill[]): ManagedSkill[] {
  const byId = new Map<string, ManagedSkill>(SEED_MANAGED_SKILLS.map((skill) => [skill.id, skill]));
  for (const skill of fetched) byId.set(skill.id, skill);
  return [...byId.values()];
}

function sameSkill(a: ManagedSkill, b: ManagedSkill): boolean { return a.name === b.name && a.description === b.description && a.body === b.body; }
/**
 * The bundled copy is the truth for a seed id, so a row that no longer matches it is replaced.
 * Matching on the id alone meant an edited recipe never reached a box that already held the old
 * one, and a cache row somebody mangled stayed mangled across every restart with nothing said.
 * A fetched copy is not lost by this ONLY because the caller is `start()`, where the startup
 * refresh runs straight after the seed write and puts the dashboard's version back on top.
 * Anywhere else, use `withSeedSkillsAdded`: a mid-session call with no refresh behind it would
 * otherwise destroy the operator's dashboard copy in both cache.json and skills/<id>/SKILL.md.
 *
 * Returns the argument itself when every seed already matches, which is how the caller tells
 * "already right" from "rewrite" without comparing twice.
 */
export function withSeedSkillsRestored(cached: readonly ManagedSkill[]): readonly ManagedSkill[] {
  let changed = false;
  const restored = cached.map((skill) => { const seed = SEED_MANAGED_SKILLS.find((candidate) => candidate.id === skill.id); if (seed == null || sameSkill(skill, seed)) return skill; changed = true; return seed; });
  for (const seed of SEED_MANAGED_SKILLS) if (!restored.some((skill) => skill.id === seed.id)) { restored.push(seed); changed = true; }
  return changed ? restored : cached;
}

/**
 * The weaker half of the seed repair, for callers with no refresh behind them: a seed id the
 * cache does not list is added, and every row it does list is left exactly as it is. Same "return
 * the argument itself when nothing changed" contract as `withSeedSkillsRestored`.
 */
export function withSeedSkillsAdded(cached: readonly ManagedSkill[]): readonly ManagedSkill[] {
  const missing = SEED_MANAGED_SKILLS.filter((seed) => !cached.some((skill) => skill.id === seed.id));
  return missing.length === 0 ? cached : [...cached, ...missing];
}

export class SandManagedSkillsService {
  private isDisposed = false;
  private refreshPromise: Promise<void> | null = null;
  private pendingTrigger: ManagedSkillsRefreshTrigger | null = null;
  constructor(readonly options: ManagedSkillsServiceOptions) {}
  /**
   * Written whether or not the box is authenticated: the service only ever starts once an access
   * token exists (startManagedSkillsWhenAuthenticated), and this box never gets one, so a seed
   * write that waited for start() would never happen. Keeps whatever a fetch already cached, and
   * keeps its fetchedAt, which is what the workflow record reports as its creation time.
   *
   * "restore" is for start(), which refreshes straight afterwards, so a seed body written over a
   * fetched row is put back within the same startup. "top-up" is for every other caller: it adds a
   * missing seed and repairs a SKILL.md that disagrees with its own cache row, but never forces a
   * bundled body over a row the dashboard fetched. ensureSkill runs on the teach save path, where
   * a "restore" would throw the operator's dashboard recipe away and then run the bundled one.
   *
   * Both halves of the cache are checked by content, not by presence: cache.json, which is where
   * the invoked prompt reads the recipe from, and skills/<id>/SKILL.md, which is the path the
   * agent is handed and the only copy it can read for itself. Checking that the id was listed and
   * the file existed let a stale recipe, a mangled row and a rewritten file all survive every
   * restart with nothing in the log to say so.
   */
  ensureSeeds(mode: "restore" | "top-up" = "restore"): void {
    const cacheDir = this.options.getCacheDir();
    const cache = readManagedSkillsCache(cacheDir);
    const cached = cache?.skills ?? [];
    const skills = mode === "restore" ? withSeedSkillsRestored(cached) : withSeedSkillsAdded(cached);
    if (cache != null && skills === cache.skills && managedSkillFilesMatch(cacheDir, skills)) return;
    writeManagedSkillsCache(cacheDir, skills, cache == null ? undefined : () => cache.fetchedAt);
  }
  start(): void { this.ensureSeeds(); void this.refresh("startup"); }
  handleAuthChange(): void { void this.refresh("auth_change"); }
  async ensureSkill(id: string): Promise<boolean> { this.ensureSeeds("top-up"); if (readManagedSkillsCache(this.options.getCacheDir())?.skills.some((skill) => skill.id === id)) return true; await this.refresh("on_demand"); return readManagedSkillsCache(this.options.getCacheDir())?.skills.some((skill) => skill.id === id) === true; }
  dispose(): void { this.isDisposed = true; }
  async refresh(trigger: ManagedSkillsRefreshTrigger): Promise<void> { if (this.isDisposed) return; if (this.refreshPromise != null) { this.pendingTrigger = trigger; return await this.refreshPromise; } this.refreshPromise = this.runRefreshes(trigger); try { await this.refreshPromise; } finally { this.refreshPromise = null; } }
  private async runRefreshes(trigger: ManagedSkillsRefreshTrigger): Promise<void> {
    let nextTrigger: ManagedSkillsRefreshTrigger | null = trigger;
    while (nextTrigger != null && !this.isDisposed) { nextTrigger = null; try { const fetched = await this.options.fetch(); if (this.isDisposed) return; const skills: ManagedSkill[] = []; for (const skill of fetched) { const normalized = fetchedManagedSkillToSandSkill(skill); if (normalized != null) skills.push(normalized); } writeManagedSkillsCache(this.options.getCacheDir(), unionWithSeedSkills(skills)); } catch (error) { this.options.report?.({ extension: "managed_setup", kind: "managed_skills", errorClass: errorClass(error) }); } finally { nextTrigger = this.pendingTrigger; this.pendingTrigger = null; } }
  }
}
