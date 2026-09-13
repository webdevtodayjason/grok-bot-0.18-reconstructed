import { AgentSkill } from "../../packages/proto/generated/agent/v1/agent_skills_pb.js";
import { agentSkillsFromWorkflows, type WorkflowRecord } from "../../shared/workflow-model.js";
import { toModelVisiblePath } from "../host-paths.js";

/**
 * KB-1f. The producer the `<available_skills>` catalog was always missing.
 *
 * `SandRequestContextExecutor` has taken a `resolveAgentSkills` callback since the reconstruction
 * and nothing ever passed one, so `agentSkills` arrived empty on every turn, the catalog section
 * never rendered, and no installed skill's NAME or DESCRIPTION reached any prompt. A seeded pack
 * (KB-1's handbook, BOTS-4's bot packs) therefore existed on disk and was invisible unless the
 * standing persona spelled out its path -- which is why that one sentence in standing-persona.ts
 * was load-bearing, and why it cost 699 characters to name a single file.
 *
 * Two rules this module exists to keep:
 *
 * NAME AND DESCRIPTION ONLY, NEVER THE BODY. `AgentSkill` carries a `content` field and nothing in
 * the prompt path or the Read tool reads it, so it stays empty here on purpose. The catalog is a
 * one-line-per-skill index; the body is fetched by reading the path, or inlined by the invoking
 * turn through `injectedWorkflowBody`. Putting a body in the catalog would move a 12,000-character
 * handbook pack onto every turn of every agent forever.
 *
 * THE PATH HAS TO BE THE ONE THE MODEL CAN OPEN. On a box the store's own `filePath` is under
 * /home/box/sand-data, and the path the model is given everywhere else -- the persona's handbook
 * sentence, the workflows location, the profile files -- is the /home/box/agent-data alias. A
 * catalog naming the raw path would hand the model 40 file names and no way to read any of them,
 * so every row goes through `toModelVisiblePath` the same way.
 */

/**
 * How many skills the catalog may name. The token budget in skill-catalog-budget.ts shortens or
 * drops descriptions once the section passes 2% of the context window, so this cap is not there to
 * save bytes: it is there so a box whose library has grown to hundreds of rows still hands the
 * model a list it can read, with the product's own managed packs at the top of it.
 * `limitSurfacedWorkflows` orders managed and plugin skills before a user's own, so the cap takes
 * the tail of the user's library and never a seeded pack.
 */
export const AGENT_SKILL_CATALOG_LIMIT = 40;

/** The shape `FileWorkflowStore` already has; duck-typed so the host can pass its session store. */
export interface AgentSkillCatalogStore {
  list(): readonly WorkflowRecord[];
}

export interface AgentSkillCatalogRow {
  readonly fullPath: string;
  readonly description: string;
}

export interface AgentSkillCatalog {
  /** The rows the prompt gets, capped and de-duplicated by path. */
  readonly rows: readonly AgentSkillCatalogRow[];
  /** How many the store offered before the cap, so a caller can say what was left out. */
  readonly offeredCount: number;
}

/**
 * The rows for one agent's installed skills. A workflow with a trigger is a routine and not a
 * skill, one switched off for this agent is not offered, and one with no file on disk has no path
 * to hand over; `agentSkillsFromWorkflows` is where all three of those rules already live.
 */
export function agentSkillCatalog(
  workflows: readonly WorkflowRecord[],
  limit: number = AGENT_SKILL_CATALOG_LIMIT,
): AgentSkillCatalog {
  const offered = agentSkillsFromWorkflows(workflows);
  const seen = new Set<string>();
  const rows: AgentSkillCatalogRow[] = [];
  for (const skill of offered) {
    const fullPath = toModelVisiblePath(skill.fullPath);
    if (fullPath.length === 0 || seen.has(fullPath)) continue;
    seen.add(fullPath);
    if (rows.length >= limit) continue;
    rows.push({ fullPath, description: skill.description });
  }
  return { rows, offeredCount: seen.size };
}

export function agentSkillCatalogRowsToProto(
  rows: readonly AgentSkillCatalogRow[],
): AgentSkill[] {
  return rows.map((row) => new AgentSkill({ fullPath: row.fullPath, description: row.description }));
}

export interface AgentSkillsResolverInput {
  /** Absent on a runner with no workflow store: the catalog is then empty and renders nothing. */
  readonly store?: AgentSkillCatalogStore | undefined;
  readonly limit?: number | undefined;
  /** Where a dropped-skills notice goes. Defaults to the host's console. */
  readonly reportCapped?: (offeredCount: number, limit: number) => void;
}

/**
 * The callback `createTurnLocalResourceProjection` wants. It is called once per request-context
 * execution, so it reads the store each time rather than freezing a list at turn start: a skill
 * imported mid-conversation is then offered on the next turn without a restart. The store's own
 * stat-keyed parse caches are what keep that from being a directory walk every time.
 *
 * It never throws. An unreadable library is a missing prompt section, not a failed turn, and the
 * request context is marked complete either way: `agentSkillsInfoComplete` staying unset is what
 * keeps the runner from treating a box with no skills as a context it has to resolve again.
 */
export function createAgentSkillsResolver(input: AgentSkillsResolverInput): () => AgentSkill[] {
  const limit = input.limit ?? AGENT_SKILL_CATALOG_LIMIT;
  let reportedCount = 0;
  const reportCapped = input.reportCapped ?? ((offeredCount: number, cap: number) => {
    console.warn(`[sand][skills] ${offeredCount} skills are offered to this agent and the prompt catalog names ${cap}; the rest are reachable by path but not listed`);
  });
  return () => {
    const store = input.store;
    if (store === undefined) return [];
    let catalog: AgentSkillCatalog;
    try {
      catalog = agentSkillCatalog(store.list(), limit);
    } catch (error) {
      console.warn(`[sand][skills] the skill catalog could not be read for this turn: ${String(error)}`);
      return [];
    }
    // Once per new count, not once per turn: the line is for an operator watching a box grow past
    // the cap, and a warning on every turn of every agent is noise nobody reads.
    if (catalog.offeredCount > limit && catalog.offeredCount !== reportedCount) {
      reportedCount = catalog.offeredCount;
      reportCapped(catalog.offeredCount, limit);
    }
    return agentSkillCatalogRowsToProto(catalog.rows);
  };
}
