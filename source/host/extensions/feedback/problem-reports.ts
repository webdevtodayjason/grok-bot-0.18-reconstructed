import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * FEEDBACK-1. The pending-report file: the ONE genuinely new mechanism in this wave, and it exists
 * for exactly one reason -- Titan's constraint that a report never goes around the operator.
 *
 * The topology, rather than a check, is what keeps the operator in front. The agent's tool posts
 * nothing anywhere: it writes a pending report HERE and returns a sentence. The console, which is
 * already authenticated as the tenant, draws it and is the only thing that POSTs to the control
 * plane. Three guarantees fall out of that for free:
 *
 *   - No control-plane credential ever sits inside a customer's container. Both cp doors are fatal
 *     there: CP_RELAY_TOKEN reads every tenant's gateway token and derived session key, and
 *     CP_ADMIN_TOKEN deletes services.
 *   - A box cannot file as another tenant, because it never names one. The relay stamps the slug
 *     from its own registry and ignores anything in the body.
 *   - "The operator saw it before it left" is true by construction rather than by review.
 *
 * The file sits under the sand-data root on purpose. The Read tool refuses that whole root
 * (TOOLS-READ-2), so one agent's quoted tool output does not become another agent's context by way
 * of a file it could read back. It is NOT a secret store: nothing in a report is a credential, and
 * the console redacts token-shaped runs before the card is drawn. 0600 all the same, because a
 * report quotes tool output and tool output is not always as harmless as the model thought.
 *
 * Capped at 50 with the oldest dropped: a box whose operator never opens the console must not grow
 * this file without bound, and a report nobody read in fifty faults is not the one that matters.
 */
export const PROBLEM_REPORTS_FILE_NAME = "problem-reports.json";
export const PROBLEM_REPORT_STORE_CAP = 50;

export type ProblemReportTier = "critical" | "quality" | "observation";

export interface ProblemReportTool {
  readonly name: string;
  readonly status: string;
  readonly error?: string;
}

/** ProblemReport v1, as the tool mints it. `workspace` is filled by the relay and by nothing else. */
export interface ProblemReportPayload {
  readonly version: 1;
  readonly tier: ProblemReportTier;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly string[];
  readonly tools: readonly ProblemReportTool[];
  readonly at: string;
}

export interface PendingProblemReport {
  readonly id: string;
  readonly at: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly report: ProblemReportPayload;
}

export function problemReportsPath(rootDir: string): string {
  return join(rootDir, PROBLEM_REPORTS_FILE_NAME);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function parseTier(value: unknown): ProblemReportTier {
  return value === "critical" || value === "quality" || value === "observation" ? value : "observation";
}

function parseReport(value: unknown): ProblemReportPayload | null {
  const record = asRecord(value);
  if (record == null) return null;
  const title = str(record.title).trim();
  if (title.length === 0) return null;
  return {
    version: 1,
    tier: parseTier(record.tier),
    category: str(record.category).trim(),
    title,
    description: str(record.description),
    steps: Array.isArray(record.steps) ? record.steps.map(str).filter((step) => step.length > 0) : [],
    tools: Array.isArray(record.tools)
      ? record.tools.flatMap((entry) => {
        const tool = asRecord(entry);
        if (tool == null) return [];
        const name = str(tool.name).trim();
        if (name.length === 0) return [];
        const error = str(tool.error);
        return [{ name, status: str(tool.status) || "failed", ...(error.length > 0 ? { error } : {}) }];
      })
      : [],
    at: str(record.at),
  };
}

function parseEntry(value: unknown): PendingProblemReport | null {
  const record = asRecord(value);
  if (record == null) return null;
  const id = str(record.id).trim();
  const report = parseReport(record.report);
  if (id.length === 0 || report == null) return null;
  const agentName = str(record.agentName).trim();
  return {
    id,
    at: str(record.at) || report.at,
    agentId: str(record.agentId),
    ...(agentName.length > 0 ? { agentName } : {}),
    report,
  };
}

/** A missing or malformed file is "nothing pending", never an error. */
export function readProblemReports(rootDir: string): PendingProblemReport[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(problemReportsPath(rootDir), "utf8")); }
  catch { return []; }
  const document = asRecord(parsed);
  const rows = document == null ? null : document.reports;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => { const entry = parseEntry(row); return entry == null ? [] : [entry]; });
}

function writeProblemReports(rootDir: string, reports: readonly PendingProblemReport[]): void {
  const path = problemReportsPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, reports }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* the rename already carried 0600 from the temp file */ }
}

/**
 * Adds one pending report and returns it. The id is minted here rather than by the caller, so the
 * console has something stable to resolve against even when two agents report in the same second.
 */
export function appendProblemReport(
  rootDir: string,
  entry: { readonly agentId: string; readonly agentName?: string; readonly report: ProblemReportPayload },
  options: { readonly now?: () => number; readonly id?: string } = {},
): PendingProblemReport {
  const at = new Date((options.now ?? Date.now)()).toISOString();
  const id = options.id ?? `pr-${at.replace(/[^0-9]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
  const agentName = (entry.agentName ?? "").trim();
  const pending: PendingProblemReport = {
    id,
    at,
    agentId: entry.agentId,
    ...(agentName.length > 0 ? { agentName } : {}),
    report: { ...entry.report, at: entry.report.at || at },
  };
  const kept = [...readProblemReports(rootDir), pending].slice(-PROBLEM_REPORT_STORE_CAP);
  writeProblemReports(rootDir, kept);
  return pending;
}

/**
 * Removes one pending report, whatever the operator decided. `sent` and `dropped` land in the same
 * place here on purpose: this file is the box's queue of what the operator has not seen yet, and
 * once they have seen it the box has no further part in it. What happened to a sent report is the
 * control plane's record, not the box's.
 */
export function resolveProblemReport(rootDir: string, id: string): boolean {
  const reports = readProblemReports(rootDir);
  const kept = reports.filter((entry) => entry.id !== id);
  if (kept.length === reports.length) return false;
  writeProblemReports(rootDir, kept);
  return true;
}
