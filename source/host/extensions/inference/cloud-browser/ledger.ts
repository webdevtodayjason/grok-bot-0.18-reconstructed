/**
 * CLOUD-BROWSER-1. The receipt for every cloud browser session, and the reason it counts BYTES.
 *
 * A minutes-only ledger under-reports a cloud browser by an order of magnitude, and the arithmetic
 * is not close. Browser Use is $0.02 per browser-hour with a residential proxy on by default at
 * $5/GB; Browserbase is $0.10-0.12 an hour with proxy at $10-12/GB. Ten minutes of browser time is
 * a third of a cent. The proxy traffic in those same ten minutes can be a dime -- thirty times
 * more. A ledger that counts only the cheap half is a ledger that says a session was free.
 *
 * So the row is:
 *
 *   { boxName, agentId, vendor, sessionId, startedAt, endedAt, minutes, proxyBytes|null,
 *     engine, reason, url }
 *
 * `boxName` IS NOT THE TENANT, and the field is named that way because it once claimed to be. A box
 * does not know its control-plane slug -- nothing pushes one in -- so the best name it has for
 * itself is its own hostname, which inside a container is the short docker id. Measured on the
 * R750's demo box on 2026-09-09: every row read `"tenant":"0e6e57702ef1"`, and the panel only read
 * "demo" because the relay stamped the slug it had resolved the container by onto what it served.
 * The file on disk is the artefact an operator opens for a billing dispute, so it says what it
 * knows -- which box -- and the relay's stamp stays the only thing that says whose box it is.
 *
 * `proxyBytes` is null on purpose where the vendor does not publish it. Browserbase's session
 * object carries it; Browser Use documents no per-browser traffic figure at all. Writing a zero
 * there would read as "this session used no proxy", which is false and expensive to believe, so the
 * field is honestly null and the admin view prints "not reported by this vendor" instead.
 *
 * WHERE, and the file is a contract. /home/box/sand-data/cloud-browser-ledger.jsonl, 0600, one JSON
 * object per line, no secrets in any field -- the session id is in it, the endpoint that carries
 * the session's credential is not. The relay reads that path through the docker socket and serves
 * it to the super admin's marketplace panel, which is item B's half of the same contract.
 *
 * LIFECYCLE, and none of this is optional:
 *
 *   - the row is appended BEFORE the connect, so a session that is opened and then orphaned by a
 *     crash can still be found and stopped;
 *   - the close is appended when the session stops, and a reader folds the two by session id;
 *   - a sweep at host start reads the vendor's own state for every row that never closed, and stops
 *     what is still running. It reads first: Browser Use's docs say plainly that closing the CDP
 *     connection does NOT stop the browser, only PATCH .../{id} {"action":"stop"} does, so an
 *     orphan is a browser billing by the hour until something asks the vendor to end it.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CloudBrowserVendor } from "./secrets.js";

export const CLOUD_BROWSER_LEDGER_FILENAME = "cloud-browser-ledger.jsonl";

export interface CloudBrowserLedgerRow {
  /** What the box calls itself. NOT the tenant: see the header. The relay names the tenant. */
  readonly boxName: string;
  readonly agentId: string;
  readonly vendor: CloudBrowserVendor;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly minutes: number | null;
  readonly proxyBytes: number | null;
  readonly engine: string;
  readonly reason: string;
  readonly url: string;
}

export function cloudBrowserLedgerPath(rootDir: string): string {
  return join(rootDir, CLOUD_BROWSER_LEDGER_FILENAME);
}

/** One line, appended, 0600 enforced rather than assumed the way the secret store enforces its own. */
function append(rootDir: string, row: Record<string, unknown>): void {
  const path = cloudBrowserLedgerPath(rootDir);
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
    // appendFileSync applies `mode` only when it CREATES the file, so a ledger left at 0644 by an
    // earlier build would stay world-readable inside the box while this header promised 0600.
    chmodSync(path, 0o600);
  } catch (error) {
    // A receipt we could not write must never take down the tool call it is a receipt for. It goes
    // to the host log, which is where an operator looks for the difference between "no sessions"
    // and "no ledger".
    console.warn(`[sand][cloud-browser] could not write the ledger row: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The row that goes down BEFORE the connect. Everything about the money is still unknown here. */
export function recordCloudSessionOpened(rootDir: string, row: {
  readonly boxName: string;
  readonly agentId: string;
  readonly vendor: CloudBrowserVendor;
  readonly sessionId: string;
  readonly reason: string;
  readonly url: string;
}): CloudBrowserLedgerRow {
  const open: CloudBrowserLedgerRow = {
    boxName: row.boxName,
    agentId: row.agentId,
    vendor: row.vendor,
    sessionId: row.sessionId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    minutes: null,
    proxyBytes: null,
    engine: row.vendor,
    reason: row.reason,
    url: row.url,
  };
  append(rootDir, { ...open, event: "opened" });
  return open;
}

/** The closing row. Minutes are measured here rather than asked of the vendor, so they always exist. */
export function recordCloudSessionClosed(rootDir: string, opened: CloudBrowserLedgerRow, close: {
  readonly proxyBytes?: number | null;
  readonly url?: string;
}): CloudBrowserLedgerRow {
  const endedAt = new Date();
  const started = Date.parse(opened.startedAt);
  const minutes = Number.isFinite(started)
    ? Math.round(((endedAt.getTime() - started) / 60_000) * 1000) / 1000
    : null;
  const closed: CloudBrowserLedgerRow = {
    ...opened,
    endedAt: endedAt.toISOString(),
    minutes,
    proxyBytes: typeof close.proxyBytes === "number" && Number.isFinite(close.proxyBytes) ? close.proxyBytes : null,
    ...(close.url == null ? {} : { url: close.url }),
  };
  append(rootDir, { ...closed, event: "closed" });
  return closed;
}

/**
 * The ledger, folded. Two lines per session (opened, then closed) collapse to one row, last write
 * winning, so a reader sees one row per session with the money on it -- and a session that never
 * closed stays visible with `endedAt: null`, which is the whole point of writing the first line.
 */
export function readCloudBrowserLedger(rootDir: string): CloudBrowserLedgerRow[] {
  let text = "";
  try {
    text = readFileSync(cloudBrowserLedgerPath(rootDir), "utf8");
  } catch {
    return [];
  }
  const bySession = new Map<string, CloudBrowserLedgerRow>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    if (sessionId.length === 0) continue;
    const { event: _event, tenant: writtenAsTenant, ...rest } = parsed;
    // Rows written before this field was named honestly carry the box's own name under `tenant`.
    // They are read, not rewritten: a ledger is a receipt, and rewriting one is the opposite of it.
    const row = rest.boxName === undefined && typeof writtenAsTenant === "string"
      ? { ...rest, boxName: writtenAsTenant }
      : rest;
    bySession.set(sessionId, row as unknown as CloudBrowserLedgerRow);
  }
  return [...bySession.values()];
}

/** Sessions this ledger believes are still open, oldest first. What the sweep asks the vendor about. */
export function openCloudSessions(rootDir: string): CloudBrowserLedgerRow[] {
  return readCloudBrowserLedger(rootDir)
    .filter((row) => row.endedAt == null)
    .sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
}

/** What the console's Computer card and the admin panel both count. One month, one box. */
export function summariseCloudBrowserLedger(rows: readonly CloudBrowserLedgerRow[], since?: Date): {
  readonly sessions: number;
  readonly minutes: number;
  readonly proxyBytes: number | null;
  readonly proxyReportedBy: readonly string[];
  readonly open: number;
} {
  const from = since?.getTime() ?? 0;
  const inWindow = rows.filter((row) => (Date.parse(String(row.startedAt)) || 0) >= from);
  let minutes = 0;
  let bytes = 0;
  let anyBytes = false;
  const reporters = new Set<string>();
  for (const row of inWindow) {
    if (typeof row.minutes === "number" && Number.isFinite(row.minutes)) minutes += row.minutes;
    if (typeof row.proxyBytes === "number" && Number.isFinite(row.proxyBytes)) {
      bytes += row.proxyBytes;
      anyBytes = true;
      reporters.add(row.vendor);
    }
  }
  return {
    sessions: inWindow.length,
    minutes: Math.round(minutes * 100) / 100,
    // Null rather than zero, for the same reason the row's own field is: nobody should read "no
    // proxy traffic" off a vendor that never told us any.
    proxyBytes: anyBytes ? bytes : null,
    proxyReportedBy: [...reporters].sort(),
    open: inWindow.filter((row) => row.endedAt == null).length,
  };
}

export interface CloudSweepVendorPort {
  /** The vendor's own word on whether this session is still running. */
  isRunning(sessionId: string): Promise<boolean>;
  stop(sessionId: string): Promise<void>;
}

/**
 * The orphan sweep, run once at host start.
 *
 * It READS before it stops, every time. A blind stop on a session id the vendor has already ended
 * is a wasted call at best and, on a vendor that reuses ids, somebody else's browser at worst --
 * and the whole rule this wave holds to is that no cloud call is retried without first asking the
 * vendor what state the thing is in.
 */
export async function sweepOpenCloudSessions(
  rootDir: string,
  ports: Partial<Record<CloudBrowserVendor, CloudSweepVendorPort>>,
): Promise<{ readonly checked: number; readonly stopped: number; readonly unreachable: number }> {
  const open = openCloudSessions(rootDir);
  let stopped = 0;
  let unreachable = 0;
  for (const row of open) {
    const port = ports[row.vendor];
    if (port == null) { unreachable += 1; continue; }
    try {
      if (await port.isRunning(row.sessionId)) {
        await port.stop(row.sessionId);
        stopped += 1;
      }
      recordCloudSessionClosed(rootDir, row, {});
    } catch (error) {
      unreachable += 1;
      console.warn(`[sand][cloud-browser] could not settle session ${row.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { checked: open.length, stopped, unreachable };
}
