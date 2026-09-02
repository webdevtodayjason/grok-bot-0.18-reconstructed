// The evidence layer: execution receipts, result attestations, claim provenance (docs/EVIDENCE-CONTRACT.md).
//
// One attempt per agent at a time. The send pipeline opens it when the turn epoch moves; the audit
// sites stamp receipts with its id; every work tool's result is attested here at the moment it
// returns; the transcript store asks for a verdict when a text message is appended. Attestation
// lines go to the same per-agent ledger as receipts, written by this module directly so that a
// result head can never reach the Cursor forwarder.
// ponytail: module singleton keyed by agent id; make it per host if two hosts ever share a process.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { getSandAgentsRootDir } from "../../storage/agent-paths.js";
import { EVIDENCE_CHECKER, decideVerdict, type EvidenceVerdict } from "./evidence-verdict.js";

export const MAX_ATTESTATION_HEAD_CHARS = 8_000;

export interface Attestation {
  readonly eventId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly exitCode?: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly head: string;
  readonly truncated: boolean;
}

export interface Attempt {
  readonly attemptId: string;
  readonly turnEpoch: number;
  turnId?: string;
  readonly startedAtMs: number;
  readonly receipts: string[];
  readonly attestations: Attestation[];
}

export interface ReceiptFields {
  readonly attemptId?: string;
  readonly turnEpoch?: number;
  readonly turnId?: string;
}

export interface EvidenceStamp extends ReceiptFields {
  readonly receipts: number;
  readonly attestations: readonly string[];
  readonly verdict: EvidenceVerdict;
  readonly missing: readonly string[];
  readonly checkedBy: string;
}

const NON_WORK_TOOL = /send.?message|communicate|update.?state|todo|sleep|wait/i;
export const isWorkTool = (name: string): boolean => !NON_WORK_TOOL.test(name);

export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "";
  try { return JSON.stringify(result); } catch { return String(result); }
}

const userText = (content: unknown): string => typeof content === "string"
  ? content
  : Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "";

class EvidenceRegistry {
  private readonly attempts = new Map<string, Attempt>();
  private readonly lastPrompt = new Map<string, string>();
  private readonly writeTails = new Map<string, Promise<void>>();
  private ledgerPath = (agentId: string): string => join(getSandAgentsRootDir(), agentId, "audit.jsonl");

  configure(options: { readonly ledgerPath?: (agentId: string) => string }): void {
    if (options.ledgerPath) this.ledgerPath = options.ledgerPath;
  }

  beginAttempt(agentId: string, turnEpoch: number): Attempt {
    const attempt: Attempt = { attemptId: randomUUID(), turnEpoch, startedAtMs: Date.now(), receipts: [], attestations: [] };
    this.attempts.set(agentId, attempt);
    return attempt;
  }

  noteRequestId(agentId: string, turnId: string): void {
    const attempt = this.attempts.get(agentId);
    if (attempt) attempt.turnId = turnId;
  }

  notePrompt(agentId: string, text: string): void {
    this.lastPrompt.set(agentId, text);
  }

  current(agentId: string): Attempt | undefined {
    return this.attempts.get(agentId);
  }

  receiptFields(agentId: string): ReceiptFields {
    const attempt = this.attempts.get(agentId);
    if (!attempt) return {};
    return { attemptId: attempt.attemptId, turnEpoch: attempt.turnEpoch, ...(attempt.turnId ? { turnId: attempt.turnId } : {}) };
  }

  noteReceipt(agentId: string, label: string): void {
    this.attempts.get(agentId)?.receipts.push(label);
  }

  attest(agentId: string, input: { readonly toolCallId: string; readonly tool: string; readonly ok: boolean; readonly exitCode?: number; readonly result: unknown }): Attestation {
    const attempt = this.attempts.get(agentId);
    const text = resultText(input.result);
    const truncated = text.length > MAX_ATTESTATION_HEAD_CHARS;
    const attestation: Attestation = {
      eventId: randomUUID(),
      toolCallId: input.toolCallId,
      tool: input.tool,
      ok: input.ok,
      ...(input.exitCode == null ? {} : { exitCode: input.exitCode }),
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: createHash("sha256").update(text).digest("hex"),
      head: truncated ? text.slice(0, MAX_ATTESTATION_HEAD_CHARS) : text,
      truncated,
    };
    attempt?.attestations.push(attestation);
    const { head, ...rest } = attestation;
    this.append(agentId, `${JSON.stringify({ ts: new Date().toISOString(), agentId, ...this.receiptFields(agentId), type: "tool_result", ...rest, head })}\n`);
    return attestation;
  }

  stamp(agentId: string, text: string, timestampMs: number): EvidenceStamp | undefined {
    const attempt = this.attempts.get(agentId);
    if (!attempt || timestampMs + 1_000 < attempt.startedAtMs) return undefined;
    const decided = decideVerdict(text, this.lastPrompt.get(agentId) ?? "", attempt.attestations);
    return {
      ...this.receiptFields(agentId),
      receipts: attempt.receipts.length,
      attestations: attempt.attestations.map((attestation) => attestation.eventId),
      verdict: decided.verdict,
      missing: decided.missing,
      checkedBy: EVIDENCE_CHECKER,
    };
  }

  async readLedger(agentId: string): Promise<Record<string, unknown>[]> {
    try {
      const raw = await fs.readFile(this.ledgerPath(agentId), "utf8");
      return raw.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    } catch { return []; }
  }

  private append(agentId: string, line: string): void {
    const path = this.ledgerPath(agentId);
    const tail = (this.writeTails.get(agentId) ?? Promise.resolve())
      .then(async () => {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.appendFile(path, line, { encoding: "utf8", mode: 0o600 });
        await fs.chmod(path, 0o600).catch(() => {});
      })
      .catch(() => {});
    this.writeTails.set(agentId, tail);
  }
}

export const evidenceRegistry = new EvidenceRegistry();

/** Transcript store hook: remember the user's prompt, stamp the agent's text messages. */
export function withEvidence<T extends object>(agentId: string, entry: T): T {
  const e = entry as { kind?: string; role?: string; content?: unknown; message?: { type?: string; content?: unknown }; timestampMs?: number; evidence?: unknown };
  if (e.kind === "message" && e.role === "user") {
    evidenceRegistry.notePrompt(agentId, userText(e.content));
    return entry;
  }
  if (e.kind !== "send-message" || e.evidence != null || e.message?.type !== "text") return entry;
  const stamp = evidenceRegistry.stamp(agentId, String(e.message.content ?? ""), Number(e.timestampMs ?? Date.now()));
  // In place on purpose: the active session serves the same object from memory, and a copy would
  // leave the transcript command blind to what the store persisted.
  if (stamp != null) e.evidence = stamp;
  return entry;
}

/** Gateway read: receipts, attestations and stamped messages for an agent, optionally one attempt. */
export async function readAgentEvidence(agentId: string, options: { readonly attemptId?: string; readonly entries: readonly unknown[] }) {
  const records = await evidenceRegistry.readLedger(agentId);
  const wanted = (attemptId: unknown): boolean => options.attemptId == null || attemptId === options.attemptId;
  const messages = options.entries.flatMap((entry) => {
    const e = entry as { kind?: string; id?: string; timestampMs?: number; message?: { type?: string; content?: unknown }; evidence?: { attemptId?: string } };
    if (e?.kind !== "send-message" || e.evidence == null || !wanted(e.evidence.attemptId)) return [];
    return [{ id: e.id, timestampMs: e.timestampMs, text: e.message?.type === "text" ? e.message.content : undefined, evidence: e.evidence }];
  });
  return {
    agentId,
    attemptId: options.attemptId ?? null,
    receipts: records.filter((record) => record.type !== "tool_result" && wanted(record.attemptId)),
    attestations: records.filter((record) => record.type === "tool_result" && wanted(record.attemptId)),
    messages,
  };
}
