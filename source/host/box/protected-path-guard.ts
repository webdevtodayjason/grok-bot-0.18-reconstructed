import { isAbsolute, resolve } from "node:path";
import { isPathWithin, realpathNearestExisting } from "../../shared/node/paths.js";
export class SandProtectedPathError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "SandProtectedPathError"; } }
/**
 * TOOLS-READ-2, TOOLS-READ-1. Titan reported the old wording as a product fault twice: it read
 * "Path is inside a protected host-only store and was refused" while the Shell tool opened the
 * same file a second later, so the agent had every reason to call it a bug and file it.
 *
 * The asymmetry is real and it stays, because the two tools are not the same kind of thing. Read
 * pulls a file INTO the model's context, where it is replayed to a provider and kept in a
 * transcript; the shell runs a command whose output the agent already chose to look at. This fence
 * is a CONTEXT boundary, not a custody boundary, and while every exec daemon in the box runs as
 * uid 0 nothing on the shell side would be more than theatre: a command-text filter is walked
 * around with base64, a copy or a symlink. docs/CUSTODY.md carries the decision, and CUSTODY-1 is
 * the real fix -- an unprivileged uid, not a deny list.
 *
 * So the wording is the fix: it names the boundary, says what actually lives behind it, and points
 * the agent somewhere it can read. It is deliberately true of the WHOLE store rather than of
 * secrets alone. The fence is the entire sand-data root, which holds transcripts, skills, gate
 * records and agent stores as well as credentials, so a message promising "this path holds
 * secrets" would be false most of the times it fires.
 *
 * BASELINE-1: ONE SUBTREE IS READABLE, and it is readable because the product tells the agent to
 * read it. MEASURED ON THE R750 DEMO BOX 2026-09-15: a bot asked a research question reached for
 * `/home/box/agent-data/managed-skills/skills/research/SKILL.md` one minute into the turn, was
 * refused by this fence, and answered without the recipe. Every managed seed is advertised at a
 * path this fence refused: the `<available_skills>` catalog hands over exactly those paths
 * (KB-1f, agent-skills-resolver.ts) and the standing persona instructs the agent to open the
 * handbook index at one (KB-1). Eleven skills named to the model, none of them openable.
 *
 * So `readableRoots` carves that one subtree back out. It is the materialized SKILL.md files and
 * nothing else: `managed-skills/cache.json` stays fenced, and so does every other thing under the
 * root. The carve-out is safe in the terms this fence is written in, because it is a CONTEXT
 * boundary and a seed skill exists to enter the model's context. It holds no credential, and the
 * host writes it from the bundle rather than from anything a customer typed.
 */
export function refusalMessage(path: string): string {
  return "That path is inside this workspace's host-owned store, which holds its saved credentials, "
    + "its agent records and its settings, so Read will not open it. Your own files are under "
    + `/home/box. This is a boundary, not a fault: ${path}`;
}
export async function assertPathOutsideProtectedRoots(protectedRoots: readonly string[], candidatePath: string, baseDir: string, readableRoots: readonly string[] = []): Promise<void> {
  if (protectedRoots.length === 0) return;
  const resolved = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(baseDir, candidatePath);
  const within = (path: string, roots: readonly string[]): boolean =>
    roots.some((root) => isPathWithin(root, path, { isInclusive: true }));
  // THE CARVE-OUT IS DECIDED ON THE REALPATH, NOT ON THE SPELLING, and that is the whole of its
  // safety. Deciding on the literal path would let a symlink planted inside the readable subtree
  // read anything the fence exists to keep out of the model's context: the agent's shell runs as
  // uid 0 in the box, so it can make one, and `skills/x/SKILL.md -> ../../connector-env-secrets.json`
  // would then pass. Resolving first costs one extra realpath on a Read and closes that road, while
  // still letting `/home/box/agent-data/...` through, because that alias resolves INTO the readable
  // subtree rather than merely being spelled like it.
  //
  // It is checked before the protected roots because a readable path is inside one by construction.
  const realResolved = await realpathNearestExisting(resolved);
  if (readableRoots.length > 0) {
    const realReadable = await Promise.all(readableRoots.map((root) => realpathNearestExisting(root)));
    if (within(realResolved, realReadable)) return;
  }
  for (const root of protectedRoots) if (isPathWithin(root, resolved, { isInclusive: true })) throw new SandProtectedPathError(refusalMessage(candidatePath));
  for (const root of protectedRoots) { const realRoot = await realpathNearestExisting(root); if (isPathWithin(realRoot, realResolved, { isInclusive: true })) throw new SandProtectedPathError(refusalMessage(candidatePath)); }
}
