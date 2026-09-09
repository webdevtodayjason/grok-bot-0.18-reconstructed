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
 */
export function refusalMessage(path: string): string {
  return "That path is inside this workspace's host-owned store, which holds its saved credentials, "
    + "its agent records and its settings, so Read will not open it. Your own files are under "
    + `/home/box. This is a boundary, not a fault: ${path}`;
}
export async function assertPathOutsideProtectedRoots(protectedRoots: readonly string[], candidatePath: string, baseDir: string): Promise<void> { if (protectedRoots.length === 0) return; const resolved = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(baseDir, candidatePath); for (const root of protectedRoots) if (isPathWithin(root, resolved, { isInclusive: true })) throw new SandProtectedPathError(refusalMessage(candidatePath)); const realResolved = await realpathNearestExisting(resolved); for (const root of protectedRoots) { const realRoot = await realpathNearestExisting(root); if (isPathWithin(realRoot, realResolved, { isInclusive: true })) throw new SandProtectedPathError(refusalMessage(candidatePath)); } }
