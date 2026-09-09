// BOX-6b. Making the recovery that already existed actually run.
//
// MEASURED ON THE R750 2026-09-09, demo box titanbot-box-atonqjq7zx593jsacaccpfau: the demo
// tenant's Titan (c63fdce4-4fc0-4ea7-8a1b-93657df2c6c5) had failed every turn since 2026-09-07
// 23:00:44Z with "transcript checkpoint must recover before preparing", 18 times in the host log,
// and NOTHING ON DISK WAS DAMAGED. Both databases passed integrity_check, there was no quarantine
// anywhere under sand-data, and the whole transcript directory held one file: a 2-byte
// `<id>.journal-mode` marker. No conversation file, no pending write-ahead copy, no cursor.
//
// That marker pins a conversation to the journal forever (the router's selectRoute). The journal's
// prepare step refuses to run until a recovery has filled its in-memory maps, and a recovery is the
// only thing that writes the conversation file in the first place. Nothing on the turn path ever
// called it: the port the turn can see does not declare it, and the one branch that does recover
// runs only with journal persistence turned off, which production hardcodes on. So the first
// prepare of every host process threw and the agent was wedged for good.
//
// The repair here is therefore NOT the SQLite rebuild the gap row assumed. It is: try the recovery
// the code already has, and if that refuses, set the stale write-ahead copy and cursor aside (never
// delete them) and try once more. Rebuilding a file from a database that is fine would have shipped
// a fix for damage this agent does not have.
//
// TWO RULES. Never lose an entry that could have been kept -- the recovery runs BEFORE anything is
// set aside, because a valid pending write-ahead copy is exactly what it replays. And never remove
// the mode marker to "fix" it: that silently moves the conversation back to the old writer behind
// the operator's back.
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isMissingFile, TranscriptJournalCorruptionError, type TranscriptCheckpoint } from "./transcript-journal-codec.js";

export const TRANSCRIPT_REPAIR_MARKER_SUFFIX = ".journal-needs-repair.json";
export const TRANSCRIPTS_DIRNAME = "agent-transcripts";

/** The conversation is stuck and a person has to press Repair. */
export interface TranscriptRepairNeed {
  readonly reason: string;
  readonly at: string;
}

export interface TranscriptRepairReport {
  readonly conversationId: string;
  /** Entries in the conversation file before the repair. 0 when the file was never written. */
  readonly before: number;
  readonly after: number;
  /** Absolute paths of the files set aside. Empty is a normal outcome, not a failure. */
  readonly quarantined: readonly string[];
  readonly outcome: "recovered" | "already-healthy" | "needs-attention";
  readonly reason?: string;
}

/** The slice of the journal mirror a repair needs. Structural, so this module imports none of it. */
export interface TranscriptRepairTarget<Store> {
  jsonlPathFor(id: string): string;
  pendingPathFor(id: string): string;
  cursorPathFor(id: string): string;
  modePathFor(id: string): string;
  recover(ctx: unknown, id: string, checkpoint: TranscriptCheckpoint, store: Store): Promise<unknown>;
}

/**
 * True for the journal's own corruption error, at any depth of a cause chain. Checked by name
 * rather than by identity: the host bundle and the tests load this module through more than one
 * build, and an `instanceof` across two copies of the class is false for the same failure.
 */
export function isTranscriptJournalCorruptionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 8; depth += 1) {
    if (current instanceof Error && current.name === "TranscriptJournalCorruptionError") return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.trim().length > 0 ? text.trim() : "the recovery did not say why";
}

/** `<sand-data>/agents/<id>` -> `<sand-data>/agent-transcripts`. */
export function transcriptsDirForAgentDir(agentDir: string): string {
  return join(dirname(dirname(agentDir)), TRANSCRIPTS_DIRNAME);
}

export function transcriptRepairMarkerPath(transcriptsDir: string, conversationId: string): string {
  return join(transcriptsDir, conversationId, `${conversationId}${TRANSCRIPT_REPAIR_MARKER_SUFFIX}`);
}

export async function readTranscriptRepairNeed(transcriptsDir: string, conversationId: string): Promise<TranscriptRepairNeed | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(transcriptRepairMarkerPath(transcriptsDir, conversationId), "utf8"));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : "this conversation store needs repair";
    const at = typeof record.at === "string" ? record.at : new Date(0).toISOString();
    return { reason, at };
  } catch { return null; }
}

export async function writeTranscriptRepairNeed(transcriptsDir: string, conversationId: string, reason: string): Promise<TranscriptRepairNeed> {
  const need: TranscriptRepairNeed = { reason, at: new Date().toISOString() };
  const path = transcriptRepairMarkerPath(transcriptsDir, conversationId);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(need)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
  return need;
}

export async function clearTranscriptRepairNeed(transcriptsDir: string, conversationId: string): Promise<void> {
  try { await unlink(transcriptRepairMarkerPath(transcriptsDir, conversationId)); }
  catch (error) { if (!isMissingFile(error)) throw error; }
}

/** Lines in the conversation file. A file that was never written counts 0, which is not an error. */
export async function countTranscriptEntries(jsonlPath: string): Promise<number> {
  try { return (await readFile(jsonlPath, "utf8")).split("\n").filter((line) => line.trim().length > 0).length; }
  catch (error) { if (isMissingFile(error)) return 0; throw error; }
}

/** Same stamp shape the store's own quarantine uses, so an operator reads one convention. */
function quarantineName(path: string): string {
  return `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function setAside(path: string): Promise<string | null> {
  try { await stat(path); } catch (error) { if (isMissingFile(error)) return null; throw error; }
  const target = quarantineName(path);
  await rename(path, target);
  return target;
}

/**
 * The file half of the repair: the stale write-ahead copy and the cursor beside it, moved aside and
 * kept. Nothing here reads or writes the conversation file itself, so it can never lose an entry.
 */
export async function setAsideStaleJournalFiles(paths: { readonly pendingPath: string; readonly cursorPath: string }): Promise<string[]> {
  const moved: string[] = [];
  const pending = await setAside(paths.pendingPath);
  if (pending != null) {
    moved.push(pending);
    // The cursor only means anything alongside the write-ahead copy it was written with.
    const cursor = await setAside(paths.cursorPath);
    if (cursor != null) moved.push(cursor);
  }
  return moved;
}

/**
 * REINDEX in place, which is safe under a running host and fixes a damaged index without moving a
 * byte of content. Deliberately NOT the rebuild-and-swap recipe: swapping a rebuilt database under
 * a live host is what the operator runbook forbids, and it repairs damage this failure shape does
 * not have. Returns the databases that were unreadable and came back.
 *
 * The readable test comes first and decides everything. A REINDEX that succeeds on a database that
 * was never broken is not a repair, and counting it as one made the first run of this on the local
 * box report "recovered" for a store with nothing wrong with it. It also costs: the demo tenant's
 * conversation blobs are 157 MB, and rebuilding their indexes on every press of Repair would be a
 * long wait for nothing.
 */
async function reindexIfUnreadable(paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const [{ DatabaseSync }, { tryReindexSqliteDb }] = await Promise.all([
    import("node:sqlite"),
    import("../storage/sqlite-recovery.js"),
  ]);
  const repaired: string[] = [];
  for (const path of paths) {
    // Never open a path that is not there: opening one creates an empty database.
    try { await stat(path); } catch { continue; }
    let unreadable = false;
    let db: InstanceType<typeof DatabaseSync> | undefined;
    try { db = new DatabaseSync(path); db.prepare("PRAGMA schema_version").get(); }
    catch { unreadable = true; }
    finally { try { db?.close(); } catch {} }
    if (!unreadable) continue;
    try { if (tryReindexSqliteDb({ dbPath: path, busyTimeoutMs: 5_000 })) repaired.push(path); } catch {}
  }
  return repaired;
}

const say = (line: string, log?: ((line: string) => void) | undefined): void => {
  if (log != null) log(line);
  else console.log(line);
};

function summaryLine(report: TranscriptRepairReport): string {
  if (report.outcome === "needs-attention") {
    return `[sand][transcript] could not repair the conversation store for ${report.conversationId}: ${report.reason ?? "no reason given"}`;
  }
  const aside = report.quarantined.length === 0
    ? "nothing set aside"
    : `set aside ${report.quarantined.map((path) => basename(path)).join(", ")}`;
  const verb = report.outcome === "already-healthy" ? "nothing to repair in" : "repaired";
  return `[sand][transcript] ${verb} the conversation store for ${report.conversationId}: ${report.before} entries before, ${report.after} after, ${aside}`;
}

export interface TranscriptFileRepairOptions {
  readonly transcriptsDir: string;
  readonly conversationId: string;
  /** Agent databases to REINDEX when the store rather than the journal is the one refusing. */
  readonly sqlitePaths?: readonly string[] | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * The on-demand repair, behind the console's Repair control. It has no live conversation state to
 * rebuild from, so it does what can be done safely from outside a turn: set the stale write-ahead
 * copy and cursor aside, REINDEX the agent's databases, and clear the needs-repair latch so the
 * next message runs the recovery again. The counts are the conversation file's, before and after.
 */
export async function repairTranscriptFiles(options: TranscriptFileRepairOptions): Promise<TranscriptRepairReport> {
  const { transcriptsDir, conversationId } = options;
  const dir = join(transcriptsDir, conversationId);
  const jsonlPath = join(dir, `${conversationId}.jsonl`);
  const before = await countTranscriptEntries(jsonlPath);
  let report: TranscriptRepairReport;
  try {
    const quarantined = await setAsideStaleJournalFiles({
      pendingPath: join(dir, `${conversationId}.journal-pending.json`),
      cursorPath: join(dir, `${conversationId}.journal-cursor.json`),
    });
    const reindexed = await reindexIfUnreadable(options.sqlitePaths ?? []);
    const need = await readTranscriptRepairNeed(transcriptsDir, conversationId);
    await clearTranscriptRepairNeed(transcriptsDir, conversationId);
    const after = await countTranscriptEntries(jsonlPath);
    const changed = quarantined.length > 0 || reindexed.length > 0 || need != null;
    report = {
      conversationId, before, after, quarantined,
      outcome: changed ? "recovered" : "already-healthy",
      reason: changed
        ? "the stuck state was cleared; the next message rebuilds what is missing"
        : "this conversation store had nothing to repair",
    };
  } catch (error) {
    report = { conversationId, before, after: before, quarantined: [], outcome: "needs-attention", reason: messageOf(error) };
  }
  say(summaryLine(report), options.log);
  return report;
}

export interface TranscriptJournalRepairOptions<Store> {
  readonly target: TranscriptRepairTarget<Store>;
  readonly ctx: unknown;
  readonly conversationId: string;
  readonly checkpoint: TranscriptCheckpoint;
  readonly store: Store;
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * The in-turn repair. Runs the recovery the journal already has, which rebuilds the conversation
 * file from the checkpoint and the conversation blobs when the file is missing. If it refuses, the
 * stale write-ahead copy and cursor go aside and it is tried ONCE more. A second refusal latches the
 * needs-repair marker, and nothing tries again until a person presses Repair -- a recovery that
 * retries on its own failure spins for as long as the box is up.
 */
export async function repairTranscriptJournal<Store>(options: TranscriptJournalRepairOptions<Store>): Promise<TranscriptRepairReport> {
  const { target, ctx, conversationId, checkpoint, store } = options;
  const transcriptsDir = dirname(dirname(target.jsonlPathFor(conversationId)));
  const before = await countTranscriptEntries(target.jsonlPathFor(conversationId));

  const latched = await readTranscriptRepairNeed(transcriptsDir, conversationId);
  if (latched != null) {
    return { conversationId, before, after: before, quarantined: [], outcome: "needs-attention", reason: latched.reason };
  }

  const finish = async (quarantined: readonly string[]): Promise<TranscriptRepairReport> => {
    const after = await countTranscriptEntries(target.jsonlPathFor(conversationId));
    const report: TranscriptRepairReport = {
      conversationId, before, after, quarantined,
      outcome: quarantined.length === 0 && after === before && before > 0 ? "already-healthy" : "recovered",
    };
    say(summaryLine(report), options.log);
    return report;
  };

  const giveUp = async (error: unknown, quarantined: readonly string[]): Promise<TranscriptRepairReport> => {
    const reason = messageOf(error);
    await writeTranscriptRepairNeed(transcriptsDir, conversationId, reason);
    const report: TranscriptRepairReport = { conversationId, before, after: before, quarantined, outcome: "needs-attention", reason };
    say(summaryLine(report), options.log);
    return report;
  };

  try {
    await target.recover(ctx, conversationId, checkpoint, store);
    return await finish([]);
  } catch (first) {
    const quarantined = await setAsideStaleJournalFiles({
      pendingPath: target.pendingPathFor(conversationId),
      cursorPath: target.cursorPathFor(conversationId),
    }).catch(() => [] as string[]);

    // Nothing was in the way, so a second attempt would fail the same way for the same reason.
    if (quarantined.length === 0) return await giveUp(first, []);

    try {
      await target.recover(ctx, conversationId, checkpoint, store);
      return await finish(quarantined);
    } catch (second) {
      return await giveUp(second, quarantined);
    }
  }
}

/** The sentence a turn fails with once the repair has given up. Plain words, no class names. */
export function transcriptRepairRefusal(report: TranscriptRepairReport): TranscriptJournalCorruptionError {
  return new TranscriptJournalCorruptionError(
    `this conversation store needs repair: ${report.reason ?? "the recovery did not say why"}`,
  );
}
