import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveSandAgentDir } from "../storage/agent-paths.js";

/**
 * JEV-2. Every decision this judge takes is written down, so that "the bot refused to send that"
 * has an answer that is not a guess, and so a staff reader can mark one wrong.
 *
 * What is NOT written is the state: no request text, no evidence, no page content. The ledger is
 * the decision and its shape, because that is what an operator needs to audit a threshold, and
 * because a ledger that quietly accumulated customer text would be a second copy of the data this
 * feature already has to be careful about.
 */

export const JEV_LEDGER_FILENAME = "jev.jsonl";

/** The three bands every threshold in this feature is expressed in. */
export type JevBand = "below70" | "70to90" | "90plus";

export function jevBand(confidence: number): JevBand {
  if (confidence >= 0.9) return "90plus";
  if (confidence >= 0.7) return "70to90";
  return "below70";
}

export interface JevDecision {
  readonly turnId: string;
  readonly judgment: 1 | 3;
  readonly question: string;
  readonly answer: string;
  readonly confidence: number;
  readonly action: string;
  readonly model: string;
  readonly latencyMs: number;
}

export interface JevDecisionRow extends JevDecision {
  readonly id: string;
  readonly ts: string;
  readonly band: JevBand;
}

export function jevLedgerPath(agentId: string): string {
  return join(resolveSandAgentDir(agentId), JEV_LEDGER_FILENAME);
}

/**
 * PHANTOM-2, the same guard the evidence ledger carries: a deleted agent's directory is never
 * recreated by a write that arrives after the delete. Appending is best effort in every sense --
 * a ledger that threw would take the turn down with it, which is the opposite of the point.
 */
async function append(path: string, row: unknown): Promise<void> {
  try {
    const directory = dirname(path);
    if (!existsSync(directory)) return;
    await mkdir(directory, { recursive: true });
    await appendFile(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  } catch {}
}

/** Writes one decision and hands back the row, whose `id` is what a "wrong" marker points at. */
export async function recordJevDecision(
  agentId: string,
  decision: JevDecision,
  options: { readonly now?: () => Date; readonly id?: () => string } = {},
): Promise<JevDecisionRow> {
  const row: JevDecisionRow = {
    id: (options.id ?? randomUUID)(),
    ts: (options.now ?? (() => new Date()))().toISOString(),
    band: jevBand(decision.confidence),
    ...decision,
  };
  await append(jevLedgerPath(agentId), row);
  return row;
}

/**
 * The staff "this was wrong" control. It appends rather than rewriting the decision, so the
 * original judgement and the correction both survive and neither can be quietly edited into the
 * other. `by` is the account the relay authenticated, not anything the browser sent.
 */
export async function markJevDecisionWrong(
  agentId: string,
  decisionId: string,
  by: string,
  options: { readonly now?: () => Date } = {},
): Promise<{ readonly id: string; readonly wrong: true; readonly by: string; readonly ts: string }> {
  const marker = {
    id: decisionId,
    wrong: true as const,
    by,
    ts: (options.now ?? (() => new Date()))().toISOString(),
  };
  await append(jevLedgerPath(agentId), marker);
  return marker;
}

export async function readJevLedger(agentId: string): Promise<readonly unknown[]> {
  try {
    const text = await readFile(jevLedgerPath(agentId), "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0).map((line) => {
      try { return JSON.parse(line) as unknown; } catch { return undefined; }
    }).filter((row): row is unknown => row !== undefined);
  } catch {
    return [];
  }
}
