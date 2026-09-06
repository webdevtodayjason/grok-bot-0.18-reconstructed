// The Titan Job Bus worker loop (docs/JOB-BUS.md sections 5 and 6).
//
// One in-host loop, started with the gateway, oldest queued job first, one running job per worker
// agent. It never reads the model's prose to decide anything: a reply is a result only because it
// carries the fenced block the prompt asked for, and a claim in that block is supported only
// because the string appears in an attestation head the evidence layer wrote at execution time
// (docs/EVIDENCE-CONTRACT.md section 3.3). The model never decides its own verdict.
//
// Every piece of I/O arrives through the deps object so the unit tests drive the whole state
// machine with fakes and the composition in host-gateway-api.ts wires the real ones.
import {
  isJobBusEnabled,
  readJobBusTimeoutMin,
  readJobBusWorkers,
  type JobArtifact,
  type JobRecord,
  type JobResult,
  type JobStore,
} from "./job-store.js";

/** How often the loop looks at the transcript for a reply. Section 5.4 fixes this at five seconds. */
export const JOB_POLL_INTERVAL_MS = 5_000;

export interface JobWorkerAgent {
  readonly id: string;
  readonly name: string;
  readonly isGroup?: boolean;
  readonly isRunning?: boolean;
}

/** The subset of an evidence attestation this module checks claims against. */
export interface JobAttestationRecord {
  readonly eventId?: unknown;
  readonly tool?: unknown;
  readonly head?: unknown;
}

export interface JobWorkerDeps {
  readonly store: JobStore;
  readonly listAgents: () => readonly JobWorkerAgent[];
  readonly sendPrompt: (prompt: string, agentId: string) => Promise<unknown> | unknown;
  readonly readEntries: (agentId: string) => Promise<readonly unknown[]>;
  readonly readEvidence: (
    agentId: string,
    options: { readonly attemptId?: string; readonly entries: readonly unknown[] },
  ) => Promise<{ readonly attestations?: readonly JobAttestationRecord[] }>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly readSetting: (name: string) => string | undefined;
  /**
   * Section 5.5: a blocked job marks the agent unread so the console's attention signal fires.
   * Optional because the store and the loop are useful without it, and because ATTN-1 owns the
   * needs-you mechanism this hangs off.
   */
  readonly markUnread?: (agentId: string) => void;
}

// ---- the prompt (section 6, binding) ----------------------------------------------------------

/**
 * Pure, so the exact words the worker agent receives are a unit test and not a runtime surprise.
 * The two fenced blocks at the end are the whole protocol: the loop reads nothing else.
 */
export function buildChapterPrompt(job: JobRecord): string {
  const payload = job.payload;
  const courseSlug = String(payload.course_slug ?? "");
  const chapter = String(payload.chapter ?? "");
  const repo = String(payload.repo ?? "");
  const branch = String(payload.branch ?? "");
  const rulesRef = String(payload.rules_ref ?? "");
  const noFinalAssessment = job.policy.no_final_assessment === true;
  const noPlaceholder = job.policy.no_placeholder === true;
  const finalAssessmentLine = noFinalAssessment ? " Do not touch final-assessment material." : "";
  return [
    `Titan Job Bus job ${job.id} (type nextgen.chapter), submitted by the Chief of Staff.`,
    "",
    `Payload: course_slug=${courseSlug} chapter=${chapter} repo=${repo} branch=${branch} rules_ref=${rulesRef}`,
    `Policy: no_final_assessment=${noFinalAssessment} no_placeholder=${noPlaceholder}`,
    "",
    "Do this in your sandbox, in /workspace:",
    `1. Clone or update https://github.com/${repo} on branch ${branch}. Use the credential already on this`,
    "   machine. If git or gh cannot authenticate, stop and answer with the blocked block below with reason",
    "   github_auth. Never ask the submitter for a token and never accept one.",
    `2. Read ${rulesRef} at the repository root and follow it. Use scripts/capture-cues.py for captions`,
    "   (it has the 3-tier fallback). If the LMS needs a login you do not have, stop and answer blocked with",
    "   reason lms_login.",
    `3. Write the full notes body and the lesson JSON for chapter ${chapter}. Never write PLACEHOLDER_LOAD_FROM_DISK`,
    `   or any placeholder.${finalAssessmentLine}`,
    `4. Commit and push to ${branch}. Then run \`git log -1 --format=%H\`, \`wc -c\` and \`sha256sum\` on each file you`,
    "   wrote, in this turn, and report only what those commands printed. The bus checks every commit sha and",
    "   every artifact path against the receipts of tools you ran this turn; a fact without a receipt fails the job.",
    "5. Answer with exactly one of these fenced blocks and nothing after it:",
    "",
    "```titan-job-result",
    '{"summary":"<one line>","commits":["<full sha>"],"artifacts":[{"path":"<repo-relative path>","bytes":<n>,"sha256":"<hex>"}]}',
    "```",
    "",
    "```titan-job-blocked",
    '{"reason":"lms_login|github_auth|approval|other","detail":"<what a human must do>"}',
    "```",
  ].join("\n");
}

export function buildCancelPrompt(job: JobRecord): string {
  return `Titan Job Bus job ${job.id} was cancelled. Stop work on it now. Do not commit and do not push.`;
}

// ---- reading the reply -------------------------------------------------------------------------

export type JobBlock =
  | { readonly kind: "result"; readonly summary: string; readonly commits: readonly string[]; readonly artifacts: readonly JobArtifact[] }
  | { readonly kind: "blocked"; readonly reason: string; readonly detail: string };

const BLOCK_PATTERN = /```titan-job-(result|blocked)[^\S\n]*\n([\s\S]*?)```/g;

const BLOCKED_REASONS = new Set(["lms_login", "github_auth", "approval", "no_worker", "other"]);

/** The first titan-job-result or titan-job-blocked block in a reply, or null. */
export function parseJobBlock(text: string): JobBlock | null {
  BLOCK_PATTERN.lastIndex = 0;
  for (const match of String(text ?? "").matchAll(BLOCK_PATTERN)) {
    const kind = match[1];
    const raw = match[2];
    if (kind == null || raw == null) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) continue;
    const body = parsed as Record<string, unknown>;
    if (kind === "blocked") {
      const reason = typeof body.reason === "string" && BLOCKED_REASONS.has(body.reason) ? body.reason : "other";
      return { kind: "blocked", reason, detail: typeof body.detail === "string" ? body.detail : "" };
    }
    return {
      kind: "result",
      summary: typeof body.summary === "string" ? body.summary : "",
      commits: Array.isArray(body.commits) ? body.commits.filter((sha): sha is string => typeof sha === "string") : [],
      artifacts: Array.isArray(body.artifacts) ? body.artifacts.flatMap(readArtifact) : [],
    };
  }
  return null;
}

function readArtifact(raw: unknown): JobArtifact[] {
  if (typeof raw !== "object" || raw == null || Array.isArray(raw)) return [];
  const artifact = raw as Record<string, unknown>;
  if (typeof artifact.path !== "string" || artifact.path.length === 0) return [];
  return [{
    path: artifact.path,
    sha256: typeof artifact.sha256 === "string" ? artifact.sha256 : "",
    bytes: typeof artifact.bytes === "number" && Number.isFinite(artifact.bytes) ? artifact.bytes : 0,
  }];
}

/** A delivered reply: a send-message transcript entry with its evidence stamp. */
interface ReplyEntry {
  readonly text: string;
  readonly attemptId: string | undefined;
  readonly verdict: string | undefined;
}

function readSendMessages(entries: readonly unknown[]): ReplyEntry[] {
  return entries.flatMap((entry) => {
    const node = entry as {
      kind?: unknown;
      message?: { type?: unknown; content?: unknown };
      evidence?: { attemptId?: unknown; verdict?: unknown };
    } | null;
    if (node?.kind !== "send-message") return [];
    const content = node.message?.content;
    return [{
      text: typeof content === "string" ? content : "",
      attemptId: typeof node.evidence?.attemptId === "string" ? node.evidence.attemptId : undefined,
      verdict: typeof node.evidence?.verdict === "string" ? node.evidence.verdict : undefined,
    }];
  });
}

// ---- attestation (section 5.6) -----------------------------------------------------------------

/**
 * The receipt kind is read off the tool name, not off anything the model said. MCP is the fallback
 * because an MCP tool's name is whatever the server called it.
 */
export function receiptKind(tool: unknown): string {
  const name = typeof tool === "string" ? tool : "";
  if (/shell|bash|exec|terminal|command/i.test(name)) return "shell";
  if (/browser/i.test(name)) return "browser";
  if (/computer/i.test(name)) return "computer";
  if (/read|file|grep|glob/i.test(name)) return "read";
  return "mcp";
}

export interface AttestationCheck {
  readonly receipts: readonly string[];
  readonly unsupported_claims: readonly string[];
}

/**
 * A claim holds when its string is literally in some attestation head from this attempt. A commit
 * matches on its first seven characters, which is the shortest sha `git log` is ever asked for; an
 * artifact matches on its whole path.
 */
export function checkClaims(args: {
  readonly commits: readonly string[];
  readonly artifacts: readonly JobArtifact[];
  readonly verdict: string | undefined;
  readonly attestations: readonly JobAttestationRecord[];
}): AttestationCheck {
  const heads = args.attestations.map((record) => (typeof record.head === "string" ? record.head : ""));
  const seenIn = (needle: string): boolean =>
    needle.length > 0 && heads.some((head) => head.includes(needle));
  const unsupported: string[] = [];
  if (args.verdict !== "evidenced") unsupported.push("summary");
  for (const sha of args.commits) {
    if (!seenIn(sha.slice(0, 7))) unsupported.push(`commit:${sha}`);
  }
  for (const artifact of args.artifacts) {
    if (!seenIn(artifact.path)) unsupported.push(`artifact:${artifact.path}`);
  }
  return {
    receipts: args.attestations.map((record) => `${receiptKind(record.tool)}:${String(record.eventId ?? "")}`),
    unsupported_claims: unsupported,
  };
}

// ---- the loop ----------------------------------------------------------------------------------

export function createJobWorker(deps: JobWorkerDeps) {
  const store = deps.store;
  let running = false;
  let stopped = false;
  let loop: Promise<void> | null = null;

  function resolveWorkerAgent(job: JobRecord): JobWorkerAgent | null {
    const name = readJobBusWorkers(deps.readSetting)[job.type];
    if (name == null) return null;
    return deps.listAgents().find((agent) => agent.name === name && agent.isGroup !== true) ?? null;
  }

  function workerNameFor(job: JobRecord): string {
    return readJobBusWorkers(deps.readSetting)[job.type] ?? "";
  }

  /** health.ping never leaves the host: its receipt is the audit row of its own running transition. */
  async function runHealthPing(job: JobRecord): Promise<void> {
    const started = await store.transition(job.id, "running", { note: "health.ping runs in the host" });
    const result: JobResult = {
      summary: "pong",
      commits: [],
      artifacts: [],
      attestation: { attempt_id: job.id, receipts: [`jobbus:${started.eventId}`], unsupported_claims: [] },
    };
    await store.transition(job.id, "done", {
      note: "pong",
      result,
      receipts: result.attestation.receipts,
      unsupported_claims: [],
    });
  }

  async function dispatchChapter(job: JobRecord): Promise<void> {
    const agent = resolveWorkerAgent(job);
    if (agent == null) {
      await store.transition(job.id, "needs_human", {
        note: "no worker agent",
        needs_human: { reason: "no_worker", detail: `no agent named ${workerNameFor(job)} is on this box` },
      });
      return;
    }
    // Mid-turn is not a failure: the job stays queued and the next tick tries again.
    if (agent.isRunning === true) return;
    const baseline = readSendMessages(await deps.readEntries(agent.id)).length;
    const started = await store.transition(job.id, "running", {
      note: `dispatched to ${agent.name}`,
      worker: { agentId: agent.id, agentName: agent.name, baseline },
    });
    await deps.sendPrompt(buildChapterPrompt(started.job), agent.id);
  }

  /** Reads this attempt's attestations and answers done or failed. Never asks the model. */
  async function attest(job: JobRecord, agentId: string, reply: ReplyEntry, block: Extract<JobBlock, { kind: "result" }>): Promise<void> {
    const evidence = await deps.readEvidence(agentId, {
      ...(reply.attemptId === undefined ? {} : { attemptId: reply.attemptId }),
      entries: await deps.readEntries(agentId),
    });
    const checked = checkClaims({
      commits: block.commits,
      artifacts: block.artifacts,
      verdict: reply.verdict,
      attestations: evidence.attestations ?? [],
    });
    const result: JobResult = {
      summary: block.summary,
      commits: block.commits,
      artifacts: block.artifacts,
      attestation: {
        attempt_id: reply.attemptId ?? job.id,
        receipts: checked.receipts,
        unsupported_claims: checked.unsupported_claims,
      },
    };
    const holds = checked.unsupported_claims.length === 0 || job.policy.require_attestation === false;
    // The result rides along on a failure too, so CoS can see exactly which claims went unsupported.
    await store.transition(job.id, holds ? "done" : "failed", {
      note: holds ? "attested" : "attestation did not hold",
      result,
      receipts: checked.receipts,
      unsupported_claims: checked.unsupported_claims,
      ...(holds ? {} : { error: "attestation did not hold" }),
    });
  }

  /** One look at a running job: a result block, a blocked block, or the clock. */
  async function advance(job: JobRecord, options: { readonly onRestart?: boolean } = {}): Promise<void> {
    const worker = job.worker;
    if (worker == null) {
      await store.transition(job.id, "failed", { note: "no worker recorded", error: "no worker recorded" });
      return;
    }
    const entries = await deps.readEntries(worker.agentId);
    const replies = readSendMessages(entries).slice(worker.baseline);
    for (const reply of replies) {
      const block = parseJobBlock(reply.text);
      if (block == null) continue;
      if (block.kind === "blocked") {
        await store.transition(job.id, "needs_human", {
          note: block.reason,
          needs_human: { reason: block.reason, detail: block.detail },
        });
        deps.markUnread?.(worker.agentId);
        return;
      }
      await attest(job, worker.agentId, reply, block);
      return;
    }
    if (options.onRestart === true) {
      await store.transition(job.id, "failed", { note: "host restarted mid-job", error: "host restarted mid-job" });
      return;
    }
    const startedAtMs = job.started_at == null ? deps.now() : Date.parse(job.started_at);
    const deadlineMs = startedAtMs + readJobBusTimeoutMin(deps.readSetting) * 60_000;
    if (Number.isFinite(startedAtMs) && deps.now() >= deadlineMs) {
      await store.transition(job.id, "failed", { note: "timed out", error: "timed out" });
    }
  }

  /**
   * Section 5.8. A job left running when the host died is re-attested from the transcript if its
   * reply is there, and failed honestly if it is not. It never sits running forever.
   */
  async function recover(): Promise<void> {
    for (const job of [...await store.running()]) {
      await advance(job, { onRestart: true });
    }
  }

  /** One pass of the loop: move running jobs on, then start what the queue allows. */
  async function tick(): Promise<void> {
    if (!isJobBusEnabled(deps.readSetting)) return;
    for (const job of [...await store.running()]) await advance(job);
    const busyAgents = new Set((await store.running()).flatMap((job) => (job.worker == null ? [] : [job.worker.agentId])));
    for (const job of [...await store.queued()]) {
      if (job.type === "health.ping") { await runHealthPing(job); continue; }
      const agent = resolveWorkerAgent(job);
      // One running job per worker agent: a second job for the same agent waits its turn.
      if (agent != null && busyAgents.has(agent.id)) continue;
      await dispatchChapter(job);
      if (agent != null) busyAgents.add(agent.id);
    }
  }

  /**
   * Cancel is the worker's, not the store's, because a running job also owes its agent one prompt
   * telling it to stop. The state change lands first, so the answer is the same whether or not the
   * agent is reachable.
   */
  async function cancel(id: string): Promise<JobRecord> {
    const before = await store.get(id);
    const wasRunning = before?.status === "running";
    const agentId = before?.worker?.agentId;
    const cancelled = await store.cancel(id);
    if (wasRunning && agentId != null) {
      try { await deps.sendPrompt(buildCancelPrompt(cancelled.job), agentId); }
      catch { /* the job is cancelled either way; an unreachable agent does not un-cancel it */ }
    }
    return cancelled.job;
  }

  return {
    tick,
    recover,
    cancel,
    isRunning: (): boolean => running,
    start(): void {
      if (running) return;
      running = true;
      stopped = false;
      loop = (async () => {
        await recover().catch(() => {});
        while (!stopped) {
          await tick().catch(() => {});
          await deps.sleep(JOB_POLL_INTERVAL_MS);
        }
      })();
    },
    async stop(): Promise<void> {
      stopped = true;
      running = false;
      await loop?.catch(() => {});
      loop = null;
    },
  };
}

export type JobWorker = ReturnType<typeof createJobWorker>;
