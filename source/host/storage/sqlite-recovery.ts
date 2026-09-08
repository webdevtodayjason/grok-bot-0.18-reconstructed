import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DB_SIDECAR_SUFFIXES } from "./store-db.js";
export function removeSqliteSidecars(dbPath: string): void { for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) try { rmSync(`${dbPath}${suffix}`, { force: true, recursive: true }); } catch {} }
export function removePathWithRetries(options: { path: string; attempts?: number | undefined; retryDelayMs?: number | undefined; recursive?: boolean | undefined }): void { const attempts = Math.max(1, options.attempts ?? 1); let failure: unknown; for (let attempt = 0; attempt < attempts; attempt += 1) { try { rmSync(options.path, { force: true, recursive: options.recursive === true }); failure = undefined; break; } catch (error) { failure = error; if (attempt < attempts - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.retryDelayMs ?? 50); } } if (failure != null) throw failure; }
export function removeSqliteDb(options: { dbPath: string; attempts?: number | undefined; retryDelayMs?: number | undefined }): void { removePathWithRetries({ path: options.dbPath, attempts: options.attempts, retryDelayMs: options.retryDelayMs }); for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) removePathWithRetries({ path: `${options.dbPath}${suffix}`, attempts: options.attempts, retryDelayMs: options.retryDelayMs, recursive: true }); }
export function quarantineCorruptSqliteDb(options: { dbPath: string; quarantinePath?: string; preserveSourceOnCopyFailure?: boolean; removeAttempts?: number | undefined; removeRetryDelayMs?: number | undefined }): { quarantinePath: string | null; copied: boolean; renameErrorCode: string | null } { const stamp = new Date().toISOString().replace(/[:.]/g, "-"), quarantinePath = options.quarantinePath ?? `${options.dbPath}.corrupt-${stamp}`; try { rmSync(quarantinePath, { force: true }); removeSqliteSidecars(quarantinePath); } catch {} try { renameSync(options.dbPath, quarantinePath); } catch (error) { const renameErrorCode = String((error as { code?: unknown }).code ?? "error"); let copied = false; try { copyFileSync(options.dbPath, quarantinePath); copied = true; for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) if (existsSync(`${options.dbPath}${suffix}`)) try { copyFileSync(`${options.dbPath}${suffix}`, `${quarantinePath}${suffix}`); } catch {} } catch { if (options.preserveSourceOnCopyFailure === true) return { quarantinePath: options.dbPath, copied: false, renameErrorCode }; } removeSqliteDb({ dbPath: options.dbPath, attempts: options.removeAttempts, retryDelayMs: options.removeRetryDelayMs }); return { quarantinePath: copied ? quarantinePath : null, copied, renameErrorCode }; } for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) try { const sidecar = `${options.dbPath}${suffix}`; if (existsSync(sidecar)) renameSync(sidecar, `${quarantinePath}${suffix}`); } catch { rmSync(`${options.dbPath}${suffix}`, { force: true }); } return { quarantinePath, copied: false, renameErrorCode: null }; }
export function openSqliteForSalvage(options: { dbPath: string; busyTimeoutMs?: number }): DatabaseSync | undefined { if (!existsSync(options.dbPath)) return undefined; const open = () => { const db = new DatabaseSync(options.dbPath); try { if (options.busyTimeoutMs != null) db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`); db.prepare("PRAGMA schema_version").get(); return db; } catch (error) { try { db.close(); } catch {} throw error; } }; try { return open(); } catch { removeSqliteSidecars(options.dbPath); try { return open(); } catch { try { return new DatabaseSync(options.dbPath); } catch { return undefined; } } } }
export function copySalvageableSqliteRows(source: { prepare(sql: string): { iterate(): Iterator<unknown> } }, selectSql: string, insert: { run(...params: unknown[]): unknown }, toParams: (row: unknown) => unknown[]): number { let iterator: Iterator<unknown>; try { iterator = source.prepare(selectSql).iterate(); } catch { return 0; } let copied = 0; try { for (;;) { let next: IteratorResult<unknown>; try { next = iterator.next(); } catch { break; } if (next.done) break; try { insert.run(...toParams(next.value)); copied += 1; } catch {} } } finally { try { iterator.return?.(); } catch {} } return copied; }

// BOX-6. Two repairs that come before salvaging rows one at a time.
//
// Measured on the R750: Jason's Scribe agent had ONE bad btree page ("Tree 3 page 4241:
// btreeInitPage() returns error code 11") in an otherwise intact file. The row-by-row salvage walks
// the table with a cursor and stops at the first page it cannot read, which is why an earlier
// recovery of a 2,940-row file kept 5 rows. REINDEX rebuilds a damaged index in place and costs
// nothing when it works; `.recover` reads the file page by page and rebuilds the content it can
// find, which is the difference between 5 rows and all of today's.
export function tryReindexSqliteDb(options: { dbPath: string; busyTimeoutMs?: number }): boolean {
  if (!existsSync(options.dbPath)) return false;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(options.dbPath);
    if (options.busyTimeoutMs != null) db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
    db.exec("REINDEX");
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    return row?.integrity_check === "ok";
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

// `sqlite3 <source> .recover` piped into a fresh database. Returns the path it wrote, or null when
// the sqlite3 CLI is not on this box or the recovery produced nothing usable. The box installs
// sqlite3 from its own entrypoint, so this is present on a healthy box and absent on one whose
// apt-get failed -- which must degrade to the old salvage rather than fail the boot.
export function recoverSqliteDbWithCli(options: { sourcePath: string; destPath: string }): string | null {
  if (!existsSync(options.sourcePath)) return null;
  const sqlPath = `${options.destPath}.recover-sql`;
  let sqlFd: number | undefined;
  try {
    rmSync(options.destPath, { force: true });
    rmSync(sqlPath, { force: true });
    sqlFd = openSync(sqlPath, "w");
    const dump = spawnSync("sqlite3", [options.sourcePath, ".recover"], { stdio: ["ignore", sqlFd, "ignore"] });
    closeSync(sqlFd);
    sqlFd = undefined;
    if (dump.error != null) return null;
    if (statSync(sqlPath).size === 0) return null;
    const load = spawnSync("sqlite3", [options.destPath], { stdio: [openSync(sqlPath, "r"), "ignore", "ignore"] });
    if (load.error != null || !existsSync(options.destPath)) return null;
    return options.destPath;
  } catch {
    return null;
  } finally {
    if (sqlFd != null) try { closeSync(sqlFd); } catch {}
    try { rmSync(sqlPath, { force: true }); } catch {}
  }
}
