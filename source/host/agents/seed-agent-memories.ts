/**
 * BOTS-4. Seeding an agent's own remembered facts, for the catalog's Add button.
 *
 * A community bot carries its operating rules as memories, and adding one has to put those rules
 * where the agent's own remembered facts live -- not in a document, not in a second copy of the
 * description. There was no write path for that: the host serves getAgentMemories,
 * deleteAgentMemory and clearAgentMemories, and the only thing that ever ADDS a memory is the
 * agent itself, mid-turn, through the extraction pass and the update_state tool.
 *
 * THE ONE RULE THIS FILE EXISTS FOR. sand-memory.ts caps a fact at MEMORY_MAX_CONTENT_LENGTH and
 * normalizeMemoryContent collapses whitespace and then SLICES, with no signal of any kind. Measured
 * on this Mac 2026-09-09 against the scraped pack: 85 of 444 memories are longer than the cap and
 * 63,035 of 190,747 characters would have been cut mid sentence, on exactly the persona and
 * job-boundary paragraphs that are the substance of a bot. So this path REFUSES a memory over the
 * cap and names it under `rejected` rather than writing a cut version. The cap itself is untouched:
 * it is read on every other write path in the product, including the agent's own remember tool, and
 * raising it to make a catalog fit would be a host-wide behaviour change nobody asked for. The
 * splitting into cap-sized facts happens in the catalog generator, before any of this runs.
 *
 * The plan/apply split is here so the refusal rules can be pinned without a filesystem: everything
 * that decides is in planAgentMemorySeed, and applyAgentMemorySeed is the part that writes.
 */
import { MEMORY_MAX_CONTENT_LENGTH, MEMORY_UI_LIMIT, memoryDedupeKey } from "../runner/sand-memory.js";

/** One call may not seed more than this. Everything past it is rejected by name, never dropped. */
export const SEED_AGENT_MEMORIES_MAX = 100;

export type SeedMemoryKind = "profile" | "log";

export interface SeedMemoryRecord {
  readonly content: string;
}

/** The slice of FileMemoryStore this path uses. */
export interface SeedMemoryStore {
  listMemories(limit?: number): readonly SeedMemoryRecord[];
  addMemory(
    content: string,
    createdAt: number,
    kind: SeedMemoryKind,
  ): SeedMemoryRecord | null;
}

export interface SeedMemoryRejection {
  readonly text: string;
  readonly why: string;
}

export interface SeedAgentMemoriesPlan {
  /** Normalised, deduped, under the cap, in the order given. */
  readonly write: readonly string[];
  /** Already held by the store, or repeated inside this call. */
  readonly duplicates: number;
  readonly rejected: readonly SeedMemoryRejection[];
}

export interface SeedAgentMemoriesResult {
  readonly added: readonly string[];
  readonly duplicates: number;
  readonly rejected: readonly SeedMemoryRejection[];
}

/**
 * Collapse whitespace and trim, and NOTHING ELSE. normalizeMemoryContent in sand-memory.ts does the
 * same two steps and then slices at the cap; the slice is the silent truncation this file refuses,
 * so it cannot be reused here.
 */
export function normalizeSeedMemory(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

/** Why one memory was refused, in words an operator reads on the panel card. */
function rejectionFor(text: string): string | null {
  if (text.length === 0) return "it is empty";
  if (text.length > MEMORY_MAX_CONTENT_LENGTH) {
    return `it is ${text.length} characters and a remembered fact stops at ${MEMORY_MAX_CONTENT_LENGTH}, so it was not shortened and not stored`;
  }
  return null;
}

/**
 * Decide, without writing. `existing` is what the store already holds.
 */
export function planAgentMemorySeed(
  existing: readonly SeedMemoryRecord[],
  memories: readonly unknown[],
): SeedAgentMemoriesPlan {
  const seen = new Set(
    existing.map((record) => memoryDedupeKey(String(record?.content ?? ""))),
  );
  const write: string[] = [];
  const rejected: SeedMemoryRejection[] = [];
  let duplicates = 0;
  let at = 0;
  for (const raw of memories) {
    at += 1;
    const text = normalizeSeedMemory(raw);
    if (at > SEED_AGENT_MEMORIES_MAX) {
      rejected.push({
        text,
        why: `this is fact ${at} and one setup seeds at most ${SEED_AGENT_MEMORIES_MAX}`,
      });
      continue;
    }
    const why = rejectionFor(text);
    if (why != null) {
      rejected.push({ text, why });
      continue;
    }
    const key = memoryDedupeKey(text);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    write.push(text);
  }
  return { write, duplicates, rejected };
}

export interface SeedAgentMemoriesDeps {
  readonly store: SeedMemoryStore;
  /**
   * The agent's frozen memory prompt. Without this the agent just seeded reads a stale snapshot
   * for the rest of the session and behaves as if it remembers nothing, which is exactly the bug
   * an operator would report as "Add did nothing".
   */
  readonly clearPromptSnapshot: () => unknown;
  readonly now?: () => number;
}

/**
 * Seed, then report what the store actually took. addMemory answers null on a fact the store
 * already holds, so that answer is counted as a duplicate rather than reported as an add.
 */
export async function applyAgentMemorySeed(
  deps: SeedAgentMemoriesDeps,
  args: { readonly memories: readonly unknown[]; readonly kind?: SeedMemoryKind },
): Promise<SeedAgentMemoriesResult> {
  const kind: SeedMemoryKind = args.kind === "profile" ? "profile" : "log";
  const now = deps.now ?? Date.now;
  // The whole list, so a fact the store already holds is never seeded a second time.
  const held = deps.store.listMemories(MEMORY_UI_LIMIT) ?? [];
  const plan = planAgentMemorySeed(held, args.memories ?? []);
  const added: string[] = [];
  let duplicates = plan.duplicates;
  for (const content of plan.write) {
    const record = deps.store.addMemory(content, now(), kind);
    if (record == null) duplicates += 1;
    else added.push(content);
  }
  if (added.length > 0) await deps.clearPromptSnapshot();
  return { added, duplicates, rejected: plan.rejected };
}
