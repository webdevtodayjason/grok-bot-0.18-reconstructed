// The Titan Job Bus store (docs/JOB-BUS.md sections 3, 4 and 5).
//
// Two files on the box data volume, both under `<sand-data>/job-bus/`: `jobs.json` holds every job
// and is rewritten wholesale through writeFileAtomic, `audit.jsonl` is append-only and never
// rewritten. The split is deliberate. jobs.json is a working set that has to stay small enough to
// read on every command, so terminal jobs age out at TERMINAL_JOB_CAP; the audit is the receipt
// that a job existed and moved, and nothing here ever truncates it.
//
// Everything a caller can get wrong answers with a GatewayCommandError carrying the HTTP status the
// contract names, so the relay passes 400/404/409/503 through unchanged.
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "../../../shared/node/atomic-write.js";
import { GatewayCommandError } from "../../gateway-command-error.js";

export const JOB_BUS_DIRNAME = "job-bus";
export const JOBS_FILENAME = "jobs.json";
export const JOB_AUDIT_FILENAME = "audit.jsonl";
/** How many finished jobs jobs.json keeps. The audit log keeps all of them, forever. */
export const TERMINAL_JOB_CAP = 500;
export const JOB_AUDIT_POLICY_VERSION = "v1";

export const SAND_JOB_BUS_ENABLED_SETTING = "SAND_JOB_BUS_ENABLED";
export const SAND_JOB_BUS_WORKERS_SETTING = "SAND_JOB_BUS_WORKERS";
export const SAND_JOB_BUS_TIMEOUT_MIN_SETTING = "SAND_JOB_BUS_TIMEOUT_MIN";
export const DEFAULT_JOB_BUS_TIMEOUT_MIN = 180;
export const DEFAULT_JOB_BUS_WORKERS: Readonly<Record<string, string>> = { "nextgen.chapter": "Scribe" };
export const DEFAULT_RULES_REF = "EXTERNAL-BOT-HANDOFF.md";

/** The allowlist. There is no `shell` type and never will be over this bus. */
export const ALLOWED_JOB_TYPES = ["health.ping", "nextgen.chapter"] as const;
export type JobType = (typeof ALLOWED_JOB_TYPES)[number];

export type JobStatus = "queued" | "running" | "needs_human" | "done" | "failed" | "cancelled";
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["done", "failed", "cancelled"];

/**
 * `queued -> needs_human` is not drawn in the contract's one-line status machine, but section 5.1
 * requires it: the worker resolves the worker agent BEFORE it moves the job to running, and a name
 * that resolves to nothing answers `needs_human {no_worker}` straight from the queue. The box gate
 * in section 9 drives exactly that path, so the edge belongs in the machine.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "needs_human", "cancelled"],
  running: ["done", "failed", "needs_human", "cancelled"],
  needs_human: ["cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export interface JobAttestation {
  readonly attempt_id: string;
  readonly receipts: readonly string[];
  readonly unsupported_claims: readonly string[];
}
export interface JobArtifact { readonly path: string; readonly sha256: string; readonly bytes: number }
export interface JobResult {
  readonly summary: string;
  readonly commits: readonly string[];
  readonly artifacts: readonly JobArtifact[];
  readonly attestation: JobAttestation;
}
export interface JobNeedsHuman { readonly reason: string; readonly detail: string }
/**
 * `baseline` is not in the contract's job record, and restart recovery (section 5.8) cannot be
 * written without it: after a host restart the only way to tell this attempt's reply from the rest
 * of the conversation is the send-message count taken when the job was dispatched.
 */
export interface JobWorkerRef { readonly agentId: string; readonly agentName: string; readonly baseline: number }
export interface JobEvent { readonly at: string; readonly status: JobStatus; readonly note: string }

export interface JobRecord {
  readonly id: string;
  readonly type: JobType;
  status: JobStatus;
  readonly idempotency_key: string;
  readonly payload: Record<string, unknown>;
  readonly policy: Record<string, boolean>;
  readonly callback_url: string | null;
  readonly submitter: string;
  readonly created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  worker: JobWorkerRef | null;
  events: JobEvent[];
  result: JobResult | null;
  error: string | null;
  needs_human: JobNeedsHuman | null;
}

export interface JobAuditRow {
  readonly at: string;
  readonly eventId: string;
  readonly event: JobStatus;
  readonly jobId: string;
  readonly type: JobType;
  readonly submitter: string;
  readonly policy_version: string;
  readonly worker: string | null;
  readonly ok: boolean;
  readonly receipts?: readonly string[];
  readonly unsupported_claims?: readonly string[];
}

export interface CreateJobRequest {
  readonly type?: unknown;
  readonly idempotency_key?: unknown;
  readonly payload?: unknown;
  readonly policy?: unknown;
  readonly callback_url?: unknown;
  readonly submitter?: unknown;
}

/** What a transition hands back: the job as it now stands, and the audit row it wrote. */
export interface JobTransition { readonly job: JobRecord; readonly eventId: string }

export interface JobPatch {
  readonly note?: string;
  readonly worker?: JobWorkerRef | null;
  readonly result?: JobResult | null;
  readonly error?: string | null;
  readonly needs_human?: JobNeedsHuman | null;
  readonly receipts?: readonly string[];
  readonly unsupported_claims?: readonly string[];
}

// ---- the switches ----------------------------------------------------------------------------
// Read through the caller's readSetting (readSandBoxSetting in the composition), so an operator can
// flip any of them on a running box: sand-host-settings.json is re-read per call, no restart.

export function isJobBusEnabled(readSetting: (name: string) => string | undefined): boolean {
  const raw = readSetting(SAND_JOB_BUS_ENABLED_SETTING);
  if (raw == null || raw.length === 0) return true; // default on
  return raw !== "0" && raw.toLowerCase() !== "false";
}

export function readJobBusWorkers(readSetting: (name: string) => string | undefined): Record<string, string> {
  const raw = readSetting(SAND_JOB_BUS_WORKERS_SETTING);
  const workers: Record<string, string> = { ...DEFAULT_JOB_BUS_WORKERS };
  if (raw == null || raw.length === 0) return workers;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return workers;
    for (const [type, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === "string" && name.trim().length > 0) workers[type] = name.trim();
    }
  } catch { /* a malformed override is no override, never a thrown command */ }
  return workers;
}

export function readJobBusTimeoutMin(readSetting: (name: string) => string | undefined): number {
  const parsed = Number(readSetting(SAND_JOB_BUS_TIMEOUT_MIN_SETTING));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JOB_BUS_TIMEOUT_MIN;
}

// ---- ids -------------------------------------------------------------------------------------

function defaultRandomHex(bytes: number): string { return randomBytes(bytes).toString("hex"); }

export function newJobId(nowMs: number, randomHex: (bytes: number) => string = defaultRandomHex): string {
  return `job_${nowMs.toString(36)}${randomHex(6)}`;
}

// ---- the secret detector ---------------------------------------------------------------------
// Fail closed, on the way in, before anything is stored or echoed back: a payload that even looks
// like it carries a credential is refused, and the answer never repeats the value.

const SECRET_KEY_PATTERN = /token|secret|password|passwd|cookie|api[_-]?key|authorization/i;
const SECRET_VALUE_PATTERN = /^(ghp_|github_pat_|gho_|xox[abp]-|sk-|AKIA)/;

/** The path of the first secret-looking key or value, or null. Never returns the value itself. */
export function findPayloadSecret(value: unknown, path = "payload"): string | null {
  if (typeof value === "string") return SECRET_VALUE_PATTERN.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findPayloadSecret(item, `${path}[${index}]`);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value == null) return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) return `${path}.${key}`;
    const found = findPayloadSecret(item, `${path}.${key}`);
    if (found != null) return found;
  }
  return null;
}

// ---- payload validation ----------------------------------------------------------------------

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type PayloadCheck =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string };

export function validateJobPayload(type: JobType, raw: unknown): PayloadCheck {
  const payload = typeof raw === "object" && raw != null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  if (type === "health.ping") return { ok: true, payload: {} };

  const courseSlug = payload.course_slug;
  if (typeof courseSlug !== "string" || courseSlug.trim().length === 0) {
    return { ok: false, detail: "course_slug must be a non-empty string" };
  }
  const chapter = payload.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) {
    return { ok: false, detail: "chapter must be a positive integer" };
  }
  const repo = payload.repo;
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
    return { ok: false, detail: "repo must be owner/name" };
  }
  const branch = payload.branch;
  if (typeof branch !== "string" || branch.trim().length === 0) {
    return { ok: false, detail: "branch must be a non-empty string" };
  }
  const rulesRef = payload.rules_ref;
  if (rulesRef !== undefined && (typeof rulesRef !== "string" || rulesRef.trim().length === 0)) {
    return { ok: false, detail: "rules_ref must be a non-empty string when it is given" };
  }
  return {
    ok: true,
    payload: {
      course_slug: courseSlug.trim(),
      chapter,
      repo,
      branch: branch.trim(),
      rules_ref: typeof rulesRef === "string" ? rulesRef.trim() : DEFAULT_RULES_REF,
    },
  };
}

function normalizePolicy(raw: unknown): Record<string, boolean> {
  const policy: Record<string, boolean> = { no_final_assessment: true, no_placeholder: true, require_attestation: true };
  if (typeof raw !== "object" || raw == null || Array.isArray(raw)) return policy;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") policy[key] = value;
  }
  return policy;
}

// ---- the store -------------------------------------------------------------------------------

export interface JobStoreDeps {
  /** The sand-data root; the bus owns `<rootDir>/job-bus/`. */
  readonly rootDir: string;
  readonly now?: () => number;
  readonly randomHex?: (bytes: number) => string;
  /** Called on every transition with {type:"job-bus", jobId, status}, so the console updates live. */
  readonly emit?: (event: { readonly type: "job-bus"; readonly jobId: string; readonly status: JobStatus }) => void;
}

export function createJobStore(deps: JobStoreDeps) {
  const now = deps.now ?? Date.now;
  const randomHex = deps.randomHex ?? defaultRandomHex;
  const directory = join(deps.rootDir, JOB_BUS_DIRNAME);
  const jobsPath = join(directory, JOBS_FILENAME);
  const auditPath = join(directory, JOB_AUDIT_FILENAME);

  let jobs: JobRecord[] = [];
  let loaded = false;
  // One write at a time. Two atomic writes racing would each rename a whole-file snapshot over the
  // other, so the loser's transition would vanish even though its audit row had landed.
  let writeTail: Promise<void> = Promise.resolve();

  const stamp = (): string => new Date(now()).toISOString();

  function isJobRecord(row: unknown): row is JobRecord {
    const record = row as { id?: unknown; type?: unknown; status?: unknown } | null;
    return typeof record?.id === "string"
      && typeof record.type === "string"
      && (ALLOWED_JOB_TYPES as readonly string[]).includes(record.type)
      && typeof record.status === "string";
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(jobsPath, "utf8"));
      const rows = Array.isArray(parsed) ? parsed : (parsed as { jobs?: unknown } | null)?.jobs;
      jobs = Array.isArray(rows) ? rows.filter(isJobRecord) : [];
    } catch { jobs = []; } // a missing or half-written file means "no jobs", never a thrown command
    loaded = true;
  }

  /** Terminal jobs age out oldest first; queued, running and needs_human jobs are never dropped. */
  function capped(): JobRecord[] {
    const terminal = jobs.filter((job) => TERMINAL_JOB_STATUSES.includes(job.status));
    if (terminal.length <= TERMINAL_JOB_CAP) return jobs;
    const keep = new Set(terminal.slice(terminal.length - TERMINAL_JOB_CAP).map((job) => job.id));
    return jobs.filter((job) => !TERMINAL_JOB_STATUSES.includes(job.status) || keep.has(job.id));
  }

  async function save(): Promise<void> {
    jobs = capped();
    const snapshot = JSON.stringify({ jobs }, null, 2);
    writeTail = writeTail
      .then(async () => {
        await mkdir(directory, { recursive: true });
        await writeFileAtomic(jobsPath, snapshot, { mode: 0o600 });
      })
      .catch(() => {});
    await writeTail;
  }

  async function appendAudit(row: JobAuditRow): Promise<void> {
    await mkdir(directory, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  function requireJob(id: string): JobRecord {
    const job = jobs.find((candidate) => candidate.id === id);
    if (job == null) throw new GatewayCommandError(404, { error: "job not found" });
    return job;
  }

  async function transition(id: string, next: JobStatus, patch: JobPatch = {}): Promise<JobTransition> {
    await ensureLoaded();
    const job = requireJob(id);
    if (!ALLOWED_TRANSITIONS[job.status].includes(next)) {
      throw new GatewayCommandError(409, { error: `job is already ${job.status}`, id, status: job.status });
    }
    const at = stamp();
    job.status = next;
    job.updated_at = at;
    if (next === "running") job.started_at = at;
    // needs_human stops the work as surely as done does, so it stamps a finish time too; a later
    // cancel from needs_human restamps it, which is the truth of when the job stopped moving.
    if (next !== "running" && next !== "queued") job.finished_at = at;
    if (patch.worker !== undefined) job.worker = patch.worker;
    if (patch.result !== undefined) job.result = patch.result;
    if (patch.error !== undefined) job.error = patch.error;
    if (patch.needs_human !== undefined) job.needs_human = patch.needs_human;
    job.events.push({ at, status: next, note: patch.note ?? "" });

    const eventId = randomHex(8);
    await appendAudit({
      at,
      eventId,
      event: next,
      jobId: job.id,
      type: job.type,
      submitter: job.submitter,
      policy_version: JOB_AUDIT_POLICY_VERSION,
      worker: job.worker?.agentName ?? null,
      ok: next !== "failed",
      ...(patch.receipts === undefined ? {} : { receipts: patch.receipts }),
      ...(patch.unsupported_claims === undefined ? {} : { unsupported_claims: patch.unsupported_claims }),
    });
    await save();
    deps.emit?.({ type: "job-bus", jobId: job.id, status: next });
    return { job, eventId };
  }

  return {
    directory,
    jobsPath,
    auditPath,
    load: ensureLoaded,

    async snapshot(): Promise<readonly JobRecord[]> { await ensureLoaded(); return jobs; },

    async get(id: string): Promise<JobRecord | null> {
      await ensureLoaded();
      return jobs.find((job) => job.id === id) ?? null;
    },

    /** Newest first, for the console's table. */
    async list(limit?: number): Promise<readonly JobRecord[]> {
      await ensureLoaded();
      const cap = Number.isFinite(limit) && Number(limit) > 0 ? Math.min(500, Math.floor(Number(limit))) : 100;
      return [...jobs].reverse().slice(0, cap);
    },

    async queueDepth(): Promise<number> {
      await ensureLoaded();
      return jobs.filter((job) => job.status === "queued").length;
    },

    /** Oldest queued first, which is the order the worker takes them in. */
    async queued(): Promise<readonly JobRecord[]> {
      await ensureLoaded();
      return jobs.filter((job) => job.status === "queued");
    },

    async running(): Promise<readonly JobRecord[]> {
      await ensureLoaded();
      return jobs.filter((job) => job.status === "running");
    },

    /**
     * Allowlist, idempotency key, secret detection, payload validation, in that order. Secrets are
     * checked before the payload is validated so a rejected credential can never be quoted back in
     * a validation detail.
     */
    async create(request: CreateJobRequest): Promise<{ readonly job: JobRecord; readonly created: boolean }> {
      await ensureLoaded();
      const type = request.type;
      if (typeof type !== "string" || !(ALLOWED_JOB_TYPES as readonly string[]).includes(type)) {
        throw new GatewayCommandError(400, { error: "unknown job type", allowed: [...ALLOWED_JOB_TYPES] });
      }
      const jobType = type as JobType;
      const key = request.idempotency_key;
      if (typeof key !== "string" || key.trim().length === 0) {
        throw new GatewayCommandError(400, { error: "idempotency key is required" });
      }
      const idempotencyKey = key.trim();
      if (findPayloadSecret(request.payload) != null) {
        throw new GatewayCommandError(400, { error: "secrets are not accepted in job payloads" });
      }
      const checked = validateJobPayload(jobType, request.payload);
      if (!checked.ok) throw new GatewayCommandError(400, { error: "invalid payload", detail: checked.detail });

      const existing = jobs.find((job) => job.type === jobType && job.idempotency_key === idempotencyKey);
      if (existing != null) return { job: existing, created: false };

      const at = stamp();
      const job: JobRecord = {
        id: newJobId(now(), randomHex),
        type: jobType,
        status: "queued",
        idempotency_key: idempotencyKey,
        payload: checked.payload,
        policy: normalizePolicy(request.policy),
        callback_url: typeof request.callback_url === "string" && request.callback_url.length > 0
          ? request.callback_url
          : null,
        submitter: typeof request.submitter === "string" && request.submitter.length > 0
          ? request.submitter
          : "unknown",
        created_at: at,
        updated_at: at,
        started_at: null,
        finished_at: null,
        worker: null,
        events: [{ at, status: "queued", note: "created" }],
        result: null,
        error: null,
        needs_human: null,
      };
      jobs.push(job);
      const eventId = randomHex(8);
      await appendAudit({
        at, eventId, event: "queued", jobId: job.id, type: job.type, submitter: job.submitter,
        policy_version: JOB_AUDIT_POLICY_VERSION, worker: null, ok: true,
      });
      await save();
      deps.emit?.({ type: "job-bus", jobId: job.id, status: "queued" });
      return { job, created: true };
    },

    transition,

    /** `queued` and `needs_human` cancel; terminal states refuse with 409; unknown ids are 404. */
    async cancel(id: string): Promise<JobTransition> {
      return await transition(id, "cancelled", { note: "cancelled by the submitter" });
    },

    /** Test seam: forget the in-memory copy so the next call re-reads jobs.json from disk. */
    reset(): void { jobs = []; loaded = false; },
  };
}

export type JobStore = ReturnType<typeof createJobStore>;

// ---- the host version ------------------------------------------------------------------------
// `GET /v1/health` answers with the package.json version. There is no version constant in this
// tree, so the nearest package.json above this module is the honest source: in development that is
// the repo root, in the shipped bundle it is the app root.

let cachedVersion: string | undefined;
export function hostPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  cachedVersion = "unknown";
  try {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 10; depth += 1) {
      try {
        const parsed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version?: unknown };
        if (typeof parsed.version === "string") { cachedVersion = parsed.version; break; }
      } catch { /* keep walking up */ }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch { /* an unreadable tree answers "unknown", never a thrown health check */ }
  return cachedVersion;
}
