// The Titan Job Bus store (docs/JOB-BUS.md sections 3, 4, 5 and the hardening in 10.1, 10.3, 10.5).
//
// Two files on the box data volume, both under `<sand-data>/job-bus/`: `jobs.json` holds every job
// and is rewritten wholesale through writeFileAtomic, `audit.jsonl` is append-only and never
// rewritten. The split is deliberate. jobs.json is a working set that has to stay small enough to
// read on every command, so terminal jobs age out at TERMINAL_JOB_CAP; the audit is the receipt
// that a job existed and moved, and nothing here ever truncates it.
//
// Section 10 hardens three things this file owns. The payload is validated against fixed patterns
// and an allowlist BEFORE anything reads it, and an unknown field anywhere in the body is a refusal
// rather than a silent drop. The audit is a hash chain: every row carries the sha256 of the
// previous row's exact bytes, so a row cannot be edited or removed without breaking the chain from
// there on. And the idempotency keys of pruned jobs survive the cap in `retired`, so a replay after
// 500 terminal jobs still answers the same id instead of minting a second job for the same work.
//
// Section 10.9 adds the integrity half. Both files sit on the volume the worker's own shell can
// write, so the host holds the authoritative job state in MEMORY for its lifetime and treats
// jobs.json as its own cache: it is read back exactly once, at start, and only after it verifies.
// A jobs.json that fails, or an audit chain that does not verify, is moved aside as
// `jobs.json.quarantined-<timestamp>` and the bus stays off. What that does NOT close is a shell
// editing the files between reloads -- the host and the worker share the box's user -- and that
// residual is written down in the contract rather than dressed up as a defence.
//
// Everything a caller can get wrong answers with a GatewayCommandError carrying the HTTP status the
// contract names, so the relay passes 400/404/409/413/429/503 through unchanged.
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "../../../shared/node/atomic-write.js";
import { GatewayCommandError } from "../../gateway-command-error.js";
import { DEFAULT_JOB_BUS_SETTINGS, JOB_BUS_DIRNAME, type JobBusSettings } from "./job-settings.js";

export { JOB_BUS_DIRNAME };
export const JOBS_FILENAME = "jobs.json";
export const JOB_AUDIT_FILENAME = "audit.jsonl";
/** How many finished jobs jobs.json keeps. The audit log keeps all of them, forever. */
export const TERMINAL_JOB_CAP = 500;
/** How many pruned idempotency keys stay answerable (section 10.3). */
export const RETIRED_KEY_CAP = 5_000;
export const JOB_AUDIT_POLICY_VERSION = "v1";
/** Section 10.1: the create body is capped at 8 KB here, under the relay's own 64 KB cap. */
export const JOB_BODY_MAX_BYTES = 8 * 1024;
export const DEFAULT_RULES_REF = "EXTERNAL-BOT-HANDOFF.md";

/** The allowlist. There is no `shell` type and never will be over this bus. */
export const ALLOWED_JOB_TYPES = ["health.ping", "nextgen.chapter"] as const;
export type JobType = (typeof ALLOWED_JOB_TYPES)[number];

export type JobStatus = "queued" | "running" | "needs_human" | "done" | "failed" | "cancelled";
/** Section 10.3: needs_human is NOT terminal. It can be cancelled, and it times out. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["done", "failed", "cancelled"];

/**
 * `queued -> needs_human` is not drawn in the contract's one-line status machine, but section 5.1
 * requires it: the worker resolves the worker agent BEFORE it moves the job to running, and a name
 * that resolves to nothing answers `needs_human {no_worker}` straight from the queue. The box gate
 * in section 9 drives exactly that path, so the edge belongs in the machine.
 *
 * `needs_human -> failed` is section 10.3's other half: a job waiting on a person still times out.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "needs_human", "cancelled", "failed"],
  running: ["done", "failed", "needs_human", "cancelled"],
  needs_human: ["cancelled", "failed"],
  done: [],
  failed: [],
  cancelled: [],
};

/** One attestation as the job keeps it (section 10.4): the record, not a summary of it. */
export interface JobAttestationRecordCopy {
  readonly eventId: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly sha256: string;
  readonly bytes: number;
  readonly head: string;
}
export interface JobAttestation {
  readonly attempt_id: string;
  readonly receipts: readonly string[];
  readonly unsupported_claims: readonly string[];
  readonly records?: readonly JobAttestationRecordCopy[];
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
 * Section 10.2's worker record. `agentId` is the PER-JOB CLONE, `sourceAgentId` the mapped agent it
 * was cloned from; the two are never the same conversation. `baseline` is the clone's send-message
 * count at dispatch, which is the only way restart recovery can tell this attempt's reply from the
 * conversation the clone inherited. `dispatch_nonce` is written with `running` before the clone
 * exists, so a job that is dispatched twice is visible as two nonces on one job rather than as two
 * silent clones.
 */
export interface JobWorkerRef {
  readonly agentId: string;
  readonly sourceAgentId: string;
  readonly agentName: string;
  readonly baseline: number;
  readonly dispatch_nonce: string;
}
export interface JobEvent { readonly at: string; readonly status: JobStatus; readonly note: string }

export interface JobRecord {
  readonly id: string;
  readonly type: JobType;
  status: JobStatus;
  readonly idempotency_key: string;
  readonly payload: Record<string, unknown>;
  readonly policy: Record<string, boolean>;
  readonly callback_url: null;
  readonly submitter: string;
  /** Section 10.5: first 8 hex of sha256 of the presented bearer, resolved by the relay. */
  readonly submitter_id: string;
  /** Section 10.5: the address `clientOf(req)` resolved, passed by the relay. */
  readonly client: string;
  readonly payload_sha256: string;
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

/** Section 10.5. `prev` is the sha256 of the previous row's exact bytes, `""` for the first row. */
export interface JobAuditRow {
  readonly seq: number;
  readonly prev: string;
  readonly at: string;
  readonly event: JobStatus | "auth_locked" | "settings_diverged" | "store_quarantined" | "store_unwritable";
  readonly jobId: string;
  readonly type: JobType | "";
  readonly submitter: string;
  readonly submitter_id: string;
  readonly client: string;
  readonly idempotency_key: string;
  readonly payload_sha256: string;
  readonly policy_version: string;
  readonly worker: string | null;
  readonly attemptId?: string;
  readonly receipts?: readonly string[];
  readonly unsupported_claims?: readonly string[];
  readonly ok: boolean;
  readonly eventId: string;
}

export interface CreateJobRequest {
  readonly type?: unknown;
  readonly idempotency_key?: unknown;
  readonly payload?: unknown;
  readonly policy?: unknown;
  readonly callback_url?: unknown;
  readonly submitter?: unknown;
  readonly submitter_id?: unknown;
  readonly client?: unknown;
}

/** What a transition hands back: the job as it now stands, and the audit row it wrote. */
export interface JobTransition { readonly job: JobRecord; readonly eventId: string }

export interface JobPatch {
  readonly note?: string;
  readonly worker?: JobWorkerRef | null;
  readonly result?: JobResult | null;
  readonly error?: string | null;
  readonly needs_human?: JobNeedsHuman | null;
  readonly attemptId?: string;
  readonly receipts?: readonly string[];
  readonly unsupported_claims?: readonly string[];
}

// ---- ids -------------------------------------------------------------------------------------

function defaultRandomHex(bytes: number): string { return randomBytes(bytes).toString("hex"); }

export function newJobId(nowMs: number, randomHex: (bytes: number) => string = defaultRandomHex): string {
  return `job_${nowMs.toString(36)}${randomHex(6)}`;
}

function sha256(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

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

// ---- payload validation (section 10.1) --------------------------------------------------------
// Every field has a pattern, and the patterns are the reason the prompt can interpolate `repo`,
// `branch` and `chapter` into a shell instruction at all: nothing that reaches step 1 of section 6
// can carry a quote, a space, a newline or a `..`.

export const COURSE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
// Section 10.9: no field that reaches a command line may begin with `-`. The prompt hands `repo`,
// `branch` and `rules_ref` to git and to `wc -c`, and an argument starting with a dash is read as an
// option flag by every one of those, whatever quoting is around it. So the first character is a
// letter, a digit or a `.` in all three, and the dash is legal only after it.
export const REPO_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
export const BRANCH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$/;
export const RULES_REF_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,119}$/;
export const CHAPTER_MIN = 1;
export const CHAPTER_MAX = 200;

const CHAPTER_PAYLOAD_KEYS = ["course_slug", "chapter", "repo", "branch", "rules_ref"] as const;
const POLICY_KEYS = ["no_final_assessment", "no_placeholder", "require_attestation"] as const;
const CREATE_BODY_KEYS = [
  "type", "idempotency_key", "payload", "policy", "callback_url", "submitter", "submitter_id", "client",
] as const;

export type PayloadCheck =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string };

function asObject(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw != null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

export function validateJobPayload(type: JobType, raw: unknown, repos: readonly string[]): PayloadCheck {
  const payload = asObject(raw);
  if (type === "health.ping") {
    const extra = Object.keys(payload)[0];
    return extra === undefined ? { ok: true, payload: {} } : { ok: false, detail: `unknown field payload.${extra}` };
  }
  for (const key of Object.keys(payload)) {
    if (!(CHAPTER_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      return { ok: false, detail: `unknown field payload.${key}` };
    }
  }
  const courseSlug = payload.course_slug;
  if (typeof courseSlug !== "string" || !COURSE_SLUG_PATTERN.test(courseSlug)) {
    return { ok: false, detail: "course_slug must match ^[a-z0-9][a-z0-9-]{0,80}$" };
  }
  const chapter = payload.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter < CHAPTER_MIN || chapter > CHAPTER_MAX) {
    return { ok: false, detail: `chapter must be an integer ${CHAPTER_MIN}..${CHAPTER_MAX}` };
  }
  const repo = payload.repo;
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
    return { ok: false, detail: "repo must be owner/name, neither part starting with -" };
  }
  if (!repos.includes(repo)) {
    return { ok: false, detail: `repo ${repo} is not in the allowlist` };
  }
  const branch = payload.branch;
  if (typeof branch !== "string" || !BRANCH_PATTERN.test(branch) || branch.includes("..")) {
    return { ok: false, detail: "branch must match ^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$ and contain no .." };
  }
  const rulesRef = payload.rules_ref === undefined ? DEFAULT_RULES_REF : payload.rules_ref;
  if (
    typeof rulesRef !== "string"
    || !RULES_REF_PATTERN.test(rulesRef)
    || rulesRef.includes("..")
    || rulesRef.startsWith("/")
  ) {
    return { ok: false, detail: "rules_ref must match ^[A-Za-z0-9._][A-Za-z0-9._/-]{0,119}$, contain no .. and not start with /" };
  }
  return { ok: true, payload: { course_slug: courseSlug, chapter, repo, branch, rules_ref: rulesRef } };
}

/**
 * Policy is booleans and nothing else; an unknown key is a refusal, not a stored surprise.
 *
 * Section 10.9: `require_attestation:false` is the one flag that turns off both attestation layers,
 * and it used to be the bearer holder's to set. It is now the operator's: unless `allowUnattested`
 * is true in the bus's settings file, a body that carries it is refused, and the answer says so in
 * its own words rather than as another "unknown field".
 */
export function validateJobPolicy(
  raw: unknown,
  options: { readonly allowUnattested?: boolean } = {},
): { readonly ok: true; readonly policy: Record<string, boolean> } | { readonly ok: false; readonly detail: string; readonly attestationRequired?: true } {
  const policy: Record<string, boolean> = { no_final_assessment: true, no_placeholder: true, require_attestation: true };
  if (raw === undefined || raw === null) return { ok: true, policy };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, detail: "policy must be an object" };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(POLICY_KEYS as readonly string[]).includes(key)) return { ok: false, detail: `unknown field policy.${key}` };
    if (typeof value !== "boolean") return { ok: false, detail: `policy.${key} must be a boolean` };
    if (key === "require_attestation" && value === false && options.allowUnattested !== true) {
      return { ok: false, detail: "attestation is required", attestationRequired: true };
    }
    policy[key] = value;
  }
  return { ok: true, policy };
}

// ---- the audit chain (section 10.5) -----------------------------------------------------------

/** The bytes a row is hashed as: exactly the line the file carries, without its newline. */
export function auditRowBytes(row: JobAuditRow): string { return JSON.stringify(row); }

/**
 * Verifies a whole audit file: seq counts from 1 without a gap, and every `prev` is the sha256 of
 * the line before it. Exported because `scripts/verify-job-bus.mjs` checks the chain end to end
 * after its run, and because a chain nothing checks is a chain nobody notices breaking.
 */
export function verifyJobAuditChain(lines: readonly string[]): { readonly ok: boolean; readonly brokenAt: number | null } {
  let previous = "";
  let index = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    index += 1;
    let row: JobAuditRow;
    try { row = JSON.parse(line) as JobAuditRow; } catch { return { ok: false, brokenAt: index }; }
    if (row.seq !== index || row.prev !== previous) return { ok: false, brokenAt: index };
    previous = sha256(line);
  }
  return { ok: true, brokenAt: null };
}

// ---- the store -------------------------------------------------------------------------------

export interface JobStoreDeps {
  /** The sand-data root; the bus owns `<rootDir>/job-bus/`. */
  readonly rootDir: string;
  /** Section 10.7: the settings file, re-read on every use. */
  readonly readSettings?: () => JobBusSettings;
  readonly now?: () => number;
  readonly randomHex?: (bytes: number) => string;
  /** Called on every transition with {type:"job-bus", jobId, status}, so the console updates live. */
  readonly emit?: (event: { readonly type: "job-bus"; readonly jobId: string; readonly status: JobStatus }) => void;
}

interface RetiredKey { readonly id: string; readonly status: JobStatus; readonly created_at?: string }

/** What a quarantined file left behind: enough for the console card to say what happened. */
export interface JobStoreQuarantine {
  readonly file: string;
  readonly movedTo: string;
  readonly at: string;
  readonly detail: string;
}

export function createJobStore(deps: JobStoreDeps) {
  const now = deps.now ?? Date.now;
  const randomHex = deps.randomHex ?? defaultRandomHex;
  const readSettings = deps.readSettings ?? (() => DEFAULT_JOB_BUS_SETTINGS);
  const directory = join(deps.rootDir, JOB_BUS_DIRNAME);
  const jobsPath = join(directory, JOBS_FILENAME);
  const auditPath = join(directory, JOB_AUDIT_FILENAME);

  let jobs: JobRecord[] = [];
  let retired: Record<string, RetiredKey> = {};
  let loaded = false;
  let auditSeq = 0;
  let auditPrev = "";
  let auditLoaded = false;
  // The byte length audit.jsonl had after this host's last append. The chain proves that no row was
  // edited or removed, but it is self-referential: a whole file rewritten consistently still
  // verifies. This does not, because it is held in the host's memory and never on the volume the
  // worker can write. Section 10.9.
  let auditBytes = 0;
  const quarantines: JobStoreQuarantine[] = [];
  // One write at a time. Two atomic writes racing would each rename a whole-file snapshot over the
  // other, so the loser's transition would vanish even though its audit row had landed.
  let writeTail: Promise<void> = Promise.resolve();
  // The audit chain is a linked list: two appends in flight would both read the same `prev`.
  let auditTail: Promise<void> = Promise.resolve();

  const stamp = (): string => new Date(now()).toISOString();

  function isJobRecord(row: unknown): row is JobRecord {
    const record = row as { id?: unknown; type?: unknown; status?: unknown } | null;
    return typeof record?.id === "string"
      && typeof record.type === "string"
      && (ALLOWED_JOB_TYPES as readonly string[]).includes(record.type)
      && typeof record.status === "string";
  }

  /**
   * Section 10.9. jobs.json and audit.jsonl live on the box data volume, which is the filesystem the
   * worker agent's own shell runs on, so the host does not simply believe what it reads there. It
   * holds the authoritative job state in MEMORY for its lifetime and treats jobs.json as its own
   * cache; this is the one moment that cache is read back, and it is checked before it is believed.
   *
   * A jobs.json that is not a list of job records, or that carries a record whose payload no longer
   * hashes to its own `payload_sha256`, or an audit.jsonl whose chain does not verify, is moved
   * aside as `jobs.json.quarantined-<timestamp>`; the host starts with no jobs, writes a
   * `store_quarantined` audit row, and the bus stays DISABLED until an operator has looked.
   *
   * The residual is stated rather than papered over: the host and the worker share the box's user,
   * so a shell in the box can still edit both files BETWEEN reloads. This closes "the host believed
   * a file it never checked", not "the file cannot be touched".
   */
  async function quarantineFile(file: string, detail: string): Promise<JobStoreQuarantine> {
    const at = stamp();
    const movedTo = `${file}.quarantined-${at.replace(/[:.]/g, "-")}`;
    try { await rename(file, movedTo); }
    catch { /* a file that will not move is still not believed: nothing below reads it again */ }
    const record: JobStoreQuarantine = { file, movedTo, at, detail };
    quarantines.push(record);
    return record;
  }

  /** What a stored record has to still be. `payload_sha256` is the part a rewrite cannot fake. */
  function recordSetFault(rows: readonly unknown[]): string | null {
    for (const row of rows) {
      if (!isJobRecord(row)) return "jobs.json carries a row that is not a job record";
      const job = row as JobRecord;
      if (typeof job.payload_sha256 !== "string") return `job ${job.id} carries no payload hash`;
      // health.ping's payload is `{}` and hashes like any other, so every record is checkable.
      if (job.payload_sha256 !== sha256(JSON.stringify(job.payload ?? {}))) {
        return `job ${job.id} does not match its payload hash`;
      }
    }
    return null;
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    let raw: string;
    try { raw = await readFile(jobsPath, "utf8"); }
    catch { jobs = []; retired = {}; return; } // absent is a first start, not a tamper
    let fault: string | null = null;
    let rows: unknown[] = [];
    let stored: unknown;
    try {
      const parsed: unknown = JSON.parse(raw);
      const listed = Array.isArray(parsed) ? parsed : (parsed as { jobs?: unknown } | null)?.jobs;
      if (!Array.isArray(listed)) fault = "jobs.json is not a list of jobs";
      else rows = listed;
      stored = (parsed as { retired?: unknown } | null)?.retired;
    } catch { fault = "jobs.json is not JSON"; }
    fault ??= recordSetFault(rows);
    if (fault == null) {
      const chain = await verifyAuditFile();
      if (!chain.ok) fault = `the audit chain breaks at row ${chain.brokenAt ?? 0}`;
    }
    if (fault != null) {
      const record = await quarantineFile(jobsPath, fault);
      jobs = [];
      retired = {};
      await appendAudit({
        at: record.at, event: "store_quarantined", jobId: "", type: "", submitter: "",
        submitter_id: "", client: "", idempotency_key: "", payload_sha256: "",
        policy_version: JOB_AUDIT_POLICY_VERSION, worker: null,
        unsupported_claims: [`store:${fault}`], ok: false, eventId: randomHex(8),
      }).catch(() => undefined);
      return;
    }
    jobs = rows as JobRecord[];
    retired = typeof stored === "object" && stored != null && !Array.isArray(stored)
      ? stored as Record<string, RetiredKey>
      : {};
  }

  /** The chain head, read off the file once: the host restarts, the chain does not begin again. */
  async function ensureAuditLoaded(): Promise<void> {
    if (auditLoaded) return;
    auditLoaded = true;
    try {
      const text = await readFile(auditPath, "utf8");
      auditBytes = Buffer.byteLength(text, "utf8");
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      const last = lines.at(-1);
      if (last == null) return;
      auditSeq = lines.length;
      auditPrev = sha256(last);
    } catch { auditSeq = 0; auditPrev = ""; auditBytes = 0; }
  }

  /** The whole file, chained. The load check and the gate's `verifyAudit` both read it this way. */
  async function verifyAuditFile(): Promise<{ ok: boolean; brokenAt: number | null; rows: number }> {
    let lines: string[] = [];
    try { lines = (await readFile(auditPath, "utf8")).split("\n").filter((line) => line.trim().length > 0); }
    catch { lines = []; }
    return { ...verifyJobAuditChain(lines), rows: lines.length };
  }

  /**
   * Section 10.9's other half of the chain. `prev` proves no row was edited or deleted, but a file
   * rewritten whole -- rows and hashes together -- verifies perfectly, and that is exactly what a
   * shell in the box can do. So before extending the chain the host checks that the file is still
   * the one it has been extending: the byte length it left behind. A file that grew or shrank under
   * us is moved aside and a fresh chain begins with a `store_quarantined` row, so the break is IN
   * the log rather than only in the memory of a host that has since restarted.
   */
  async function ensureAuditIntact(): Promise<void> {
    await ensureAuditLoaded();
    if (auditSeq === 0) return;
    let size = -1;
    try { size = (await stat(auditPath)).size; } catch { size = -1; }
    if (size === auditBytes) return;
    const record = await quarantineFile(auditPath, `audit.jsonl changed under the host (${auditBytes} -> ${size} bytes)`);
    auditSeq = 0;
    auditPrev = "";
    auditBytes = 0;
    await writeChained({
      at: record.at, event: "store_quarantined", jobId: "", type: "", submitter: "", submitter_id: "",
      client: "", idempotency_key: "", payload_sha256: "", policy_version: JOB_AUDIT_POLICY_VERSION,
      worker: null, unsupported_claims: [`store:${record.detail}`], ok: false, eventId: randomHex(8),
    });
  }

  /** One row onto the end of the chain. Callers hold the tail, so this never runs twice at once. */
  async function writeChained(row: Omit<JobAuditRow, "seq" | "prev">): Promise<void> {
    const chained: JobAuditRow = { seq: auditSeq + 1, prev: auditPrev, ...row };
    const line = auditRowBytes(chained);
    await mkdir(directory, { recursive: true });
    await appendFile(auditPath, `${line}\n`, { mode: 0o600 });
    auditSeq = chained.seq;
    auditPrev = sha256(line);
    auditBytes += Buffer.byteLength(`${line}\n`, "utf8");
  }

  /**
   * Terminal jobs age out oldest first; queued, running and needs_human jobs are never dropped.
   * A pruned job leaves its idempotency key behind in `retired` (section 10.3), so a replay of a
   * key from six months ago still answers the id it answered then instead of starting the work
   * again.
   */
  function capped(): JobRecord[] {
    const terminal = jobs.filter((job) => TERMINAL_JOB_STATUSES.includes(job.status));
    if (terminal.length <= TERMINAL_JOB_CAP) return jobs;
    const keep = new Set(terminal.slice(terminal.length - TERMINAL_JOB_CAP).map((job) => job.id));
    const dropped = terminal.filter((job) => !keep.has(job.id));
    for (const job of dropped) retired[`${job.type} ${job.idempotency_key}`] = { id: job.id, status: job.status, created_at: job.created_at };
    const keys = Object.keys(retired);
    for (const key of keys.slice(0, Math.max(0, keys.length - RETIRED_KEY_CAP))) delete retired[key];
    return jobs.filter((job) => !TERMINAL_JOB_STATUSES.includes(job.status) || keep.has(job.id));
  }

  /**
   * Writes the cache. The error is NOT swallowed any more: a caller that believes it persisted a
   * dispatch when it did not is how a queued job gets dispatched twice, so the failure travels up
   * and the transition that asked for it fails. The tail itself is kept resolved either way, so one
   * unwritable moment does not wedge every later write behind a rejected promise.
   */
  async function save(): Promise<void> {
    jobs = capped();
    const snapshot = JSON.stringify({ jobs, retired }, null, 2);
    const write = writeTail.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFileAtomic(jobsPath, snapshot, { mode: 0o600 });
    });
    writeTail = write.catch(() => {});
    await write;
  }

  /** Appends one chained row. Serialised, because `prev` is read and written in the same step. */
  async function appendAudit(row: Omit<JobAuditRow, "seq" | "prev">): Promise<void> {
    const append = auditTail.then(async () => {
      await ensureAuditIntact();
      await writeChained(row);
    });
    auditTail = append.catch(() => {});
    await append;
  }

  /**
   * The cache write, with the failure recorded rather than swallowed. The in-memory state is the
   * authoritative one and has already moved, so this does not roll anything back; it writes a
   * `store_unwritable` row -- the receipt that the file on the volume is now behind what the host
   * holds -- and hands the caller a 503 so a create is answered honestly instead of as a 201 for a
   * job the box could not write down.
   */
  async function saveOrRecord(job: JobRecord | null, what: string): Promise<void> {
    try { await save(); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await appendAudit({
        at: stamp(), event: "store_unwritable", jobId: job?.id ?? "", type: job?.type ?? "",
        submitter: job?.submitter ?? "", submitter_id: job?.submitter_id ?? "", client: job?.client ?? "",
        idempotency_key: job?.idempotency_key ?? "", payload_sha256: job?.payload_sha256 ?? "",
        policy_version: JOB_AUDIT_POLICY_VERSION, worker: job?.worker?.agentName ?? null,
        unsupported_claims: [`store:${what}`], ok: false, eventId: randomHex(8),
      }).catch(() => undefined);
      throw new GatewayCommandError(503, { error: "the job store could not be written", detail });
    }
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
      event: next,
      jobId: job.id,
      type: job.type,
      submitter: job.submitter,
      submitter_id: job.submitter_id,
      client: job.client,
      idempotency_key: job.idempotency_key,
      payload_sha256: job.payload_sha256,
      policy_version: JOB_AUDIT_POLICY_VERSION,
      worker: job.worker?.agentName ?? null,
      ...(patch.attemptId === undefined ? {} : { attemptId: patch.attemptId }),
      ...(patch.receipts === undefined ? {} : { receipts: patch.receipts }),
      ...(patch.unsupported_claims === undefined ? {} : { unsupported_claims: patch.unsupported_claims }),
      ok: next !== "failed",
      eventId,
    });
    await saveOrRecord(job, `${job.id} could not be written as ${next}`);
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

    async needsHuman(): Promise<readonly JobRecord[]> {
      await ensureLoaded();
      return jobs.filter((job) => job.status === "needs_human");
    },

    /**
     * Section 10.1 and 10.3, in the order a hostile body has to fail in: size, unknown fields and
     * the type allowlist first, because they are cheap and they are what an attacker moves; then
     * the idempotency key; then the secret sweep, BEFORE the payload is validated, so a rejected
     * credential can never be quoted back inside a validation detail; then the payload patterns and
     * the repo allowlist; and only then the open-job count, so a full queue is the last thing a
     * well-formed job hits.
     */
    async create(request: CreateJobRequest): Promise<{ readonly job: JobRecord; readonly created: boolean }> {
      await ensureLoaded();
      const settings = readSettings();
      if (Buffer.byteLength(JSON.stringify(request ?? {}), "utf8") > JOB_BODY_MAX_BYTES) {
        throw new GatewayCommandError(413, { error: "job body too large", limit_bytes: JOB_BODY_MAX_BYTES });
      }
      for (const key of Object.keys(request ?? {})) {
        if (!(CREATE_BODY_KEYS as readonly string[]).includes(key)) {
          throw new GatewayCommandError(400, { error: "invalid payload", detail: `unknown field ${key}` });
        }
      }
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
      // Section 10.1: callbacks are not in v1, and a job that carries one must not look accepted.
      if (request.callback_url !== undefined && request.callback_url !== null) {
        throw new GatewayCommandError(400, { error: "callbacks are not in v1" });
      }
      if (findPayloadSecret(request.payload) != null) {
        throw new GatewayCommandError(400, { error: "secrets are not accepted in job payloads" });
      }
      const checked = validateJobPayload(jobType, request.payload, settings.repos);
      if (!checked.ok) throw new GatewayCommandError(400, { error: "invalid payload", detail: checked.detail });
      const policy = validateJobPolicy(request.policy, { allowUnattested: settings.allowUnattested });
      if (!policy.ok) {
        // Its own error, not "invalid payload": the body was well formed and the box said no.
        if (policy.attestationRequired === true) {
          throw new GatewayCommandError(400, { error: "attestation is required" });
        }
        throw new GatewayCommandError(400, { error: "invalid payload", detail: policy.detail });
      }

      const existing = jobs.find((job) => job.type === jobType && job.idempotency_key === idempotencyKey);
      if (existing != null) return { job: existing, created: false };
      const pruned = retired[`${jobType} ${idempotencyKey}`];
      if (pruned != null) {
        // The record itself aged out of jobs.json; the audit log still has every row of it. The
        // caller asked "did this key already run?", and the honest answer is the id and the status
        // it ended on, with the fields the store no longer holds left empty rather than invented.
        return {
          created: false,
          job: {
            id: pruned.id, type: jobType, status: pruned.status, idempotency_key: idempotencyKey,
            payload: {}, policy: policy.policy, callback_url: null, submitter: "", submitter_id: "",
            // `created_at` rides with the retired key rather than being blanked: the create answer
            // carries four fields and this is one of them, so a replay that answered "" told CoS the
            // job it already had was made at no time at all. A key retired before this field existed
            // still answers "", which is the one honest gap.
            client: "", payload_sha256: "", created_at: pruned.created_at ?? "", updated_at: "", started_at: null,
            finished_at: null, worker: null, events: [], result: null, error: null, needs_human: null,
          },
        };
      }
      const open = jobs.filter((job) => !TERMINAL_JOB_STATUSES.includes(job.status)).length;
      if (open >= settings.maxOpen) {
        throw new GatewayCommandError(429, { error: "queue full", open, max_open: settings.maxOpen });
      }

      const at = stamp();
      const job: JobRecord = {
        id: newJobId(now(), randomHex),
        type: jobType,
        status: "queued",
        idempotency_key: idempotencyKey,
        payload: checked.payload,
        policy: policy.policy,
        callback_url: null,
        submitter: typeof request.submitter === "string" && request.submitter.length > 0
          ? request.submitter
          : "unknown",
        submitter_id: typeof request.submitter_id === "string" ? request.submitter_id : "",
        client: typeof request.client === "string" ? request.client : "",
        payload_sha256: sha256(JSON.stringify(checked.payload)),
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
        at, event: "queued", jobId: job.id, type: job.type, submitter: job.submitter,
        submitter_id: job.submitter_id, client: job.client, idempotency_key: job.idempotency_key,
        payload_sha256: job.payload_sha256, policy_version: JOB_AUDIT_POLICY_VERSION, worker: null,
        ok: true, eventId,
      });
      await saveOrRecord(job, `${job.id} could not be written as queued`);
      deps.emit?.({ type: "job-bus", jobId: job.id, status: "queued" });
      return { job, created: true };
    },

    transition,

    /**
     * Section 10.3 writes `running` before the clone exists, so the clone's id lands here a moment
     * later. It is a correction to a row the audit already carries, not a transition, so it writes
     * jobs.json and no second audit row.
     */
    async setWorker(id: string, worker: JobWorkerRef): Promise<JobRecord> {
      await ensureLoaded();
      const job = requireJob(id);
      job.worker = worker;
      job.updated_at = stamp();
      await saveOrRecord(job, `${job.id} could not be written with its clone`);
      return job;
    },

    /** `queued` and `needs_human` cancel; terminal states refuse with 409; unknown ids are 404. */
    async cancel(id: string): Promise<JobTransition> {
      return await transition(id, "cancelled", { note: "cancelled by the submitter" });
    },

    /**
     * Section 10.5's out-of-band row: the relay's bearer lockout is not a job, but it belongs in
     * the same chain, because "who was locked out and when" is exactly the question this file
     * exists to answer.
     */
    async appendExternalAudit(row: {
      readonly event: "auth_locked" | "settings_diverged" | "store_quarantined";
      readonly client?: unknown;
      readonly ok?: unknown;
      /**
       * For `settings_diverged`: which guarded fields the settings file disagreed with. For
       * `store_quarantined` written from outside this store (the settings file): why it was moved.
       */
      readonly fields?: readonly string[];
    }): Promise<{ readonly eventId: string }> {
      const eventId = randomHex(8);
      await appendAudit({
        at: stamp(),
        event: row.event,
        jobId: "", type: "", submitter: "", submitter_id: "",
        client: typeof row.client === "string" ? row.client : "",
        idempotency_key: "", payload_sha256: "", policy_version: JOB_AUDIT_POLICY_VERSION,
        worker: null,
        // The field names ride in the row's own claims list: "these are the settings the file
        // asserted and the host would not take", which is exactly what this column means.
        ...(row.fields === undefined ? {} : { unsupported_claims: row.fields.map((field) => `settings:${field}`) }),
        ok: row.ok === true, eventId,
      });
      return { eventId };
    },

    /** Reads the whole audit file back and checks the chain. The box gate calls this after its run. */
    async verifyAudit(): Promise<{ readonly ok: boolean; readonly brokenAt: number | null; readonly rows: number }> {
      return await verifyAuditFile();
    },

    /**
     * Section 10.9. Whether this host trusted what it read at start. `ok:false` means a file was
     * moved aside, and the bus stays off until an operator has looked: the console card says so, and
     * `jobBusCreate` answers 503 rather than accepting work into a store that was tampered with.
     */
    async integrity(): Promise<{ readonly ok: boolean; readonly quarantined: readonly JobStoreQuarantine[]; readonly detail: string }> {
      await ensureLoaded();
      return {
        ok: quarantines.length === 0,
        quarantined: [...quarantines],
        detail: quarantines.map((entry) => entry.detail).join("; "),
      };
    },

    /** Test seam: forget the in-memory copy so the next call re-reads jobs.json from disk. */
    reset(): void {
      jobs = [];
      retired = {};
      loaded = false;
      auditLoaded = false;
      auditSeq = 0;
      auditPrev = "";
      auditBytes = 0;
      quarantines.length = 0;
    },
  };
}

export type JobStore = ReturnType<typeof createJobStore>;

// ---- the host version ------------------------------------------------------------------------
// `GET /v1/health` answers `version: "0.1.0"` -- the JOB API's version, section 10.6 -- and
// `host_version`, which is this bundle's. There is no version constant in this tree, so the nearest
// package.json above this module is the honest source: in development that is the repo root, in the
// shipped bundle it is the app root.

/** Section 10.6: the version of the job API, not of the host that serves it. */
export const JOB_BUS_API_VERSION = "0.1.0";

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
