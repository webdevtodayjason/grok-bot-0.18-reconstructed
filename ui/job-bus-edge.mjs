// The job bus edge: token resolution, the rate limit and the create-call shaping.
//
// It lives beside the relay rather than inside it because these three are the parts with rules
// worth testing on their own, and because server.mjs is already long. Nothing here imports
// anything outside node builtins: the relay has no node_modules at all.
//
// The contract is docs/JOB-BUS.md sections 2 and 3. Every name here is from it.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// The first SAND_PROFILE_DIRS entry, which is the box's sand-data directory as the relay sees it
// (/profile in the compose file). Nothing else: the token file has one home so the console writes
// where the relay reads.
export function jobBusProfileDir(env = process.env) {
  const first = String(env.SAND_PROFILE_DIRS ?? "").split(":").map((dir) => dir.trim())
    .find((dir) => dir.length > 0);
  return first ?? null;
}

export function jobBusTokenFile(env = process.env) {
  const dir = jobBusProfileDir(env);
  return dir == null ? null : path.join(dir, "job-bus.json");
}

// TENANT-5. One relay serves every tenant, so a bus token has to be read out of the profile
// directory of the tenant it belongs to rather than out of this process's own environment. Same
// file, same shape, same 0600; the only difference is that the directory is named by the caller.
//
// TITAN_JOB_TOKEN is deliberately NOT consulted here. That variable is a fact about this
// deployment, which means the operator's own bus and nothing else: read for every tenant it would
// hand one environment value the run of every customer's box.
export function jobTokenInDir(profileDir) {
  const dir = String(profileDir ?? "").trim();
  if (dir.length === 0) return { token: "", source: null };
  try {
    const token = String(JSON.parse(readFileSync(path.join(dir, "job-bus.json"), "utf8"))?.token ?? "").trim();
    if (token.length > 0) return { token, source: "file" };
  } catch { /* absent or unreadable is simply unconfigured */ }
  return { token: "", source: null };
}

// Env first, then the file the console writes, then unconfigured -- which /v1 answers as the same
// 401 as a wrong token, because whether a bus exists here is not something a stranger gets to
// learn. Resolved on every request on purpose: generating a token in Settings has to work without
// restarting the relay, and one small readFileSync is cheaper than the fetch that follows.
export function resolveJobToken(env = process.env) {
  const fromEnv = String(env.TITAN_JOB_TOKEN ?? "").trim();
  if (fromEnv.length > 0) return { token: fromEnv, source: "env" };
  const file = jobBusTokenFile(env);
  if (file != null) {
    try {
      const token = String(JSON.parse(readFileSync(file, "utf8"))?.token ?? "").trim();
      if (token.length > 0) return { token, source: "file" };
    } catch { /* absent or unreadable is simply unconfigured */ }
  }
  return { token: "", source: null };
}

// 48 hex characters, shown once by the console.
export const newJobToken = () => randomBytes(24).toString("hex");

// Which bearer a create call arrived on, in a form the audit can keep. Eight hex of a sha256 is
// enough to tell one token's jobs from another's across a rotation, and short enough that the row
// is not a hash anyone can grind back into the token it names. docs/JOB-BUS.md 10.5.
export const jobSubmitterId = (token) =>
  createHash("sha256").update(String(token ?? ""), "utf8").digest("hex").slice(0, 8);

// Fixed windows, with the same bounded-map shape as the login throttle: the key comes from the
// caller, so an unbounded map would be a memory leak. The bus runs two of these -- 120 a minute
// keyed by client, and one global bucket of 600 -- so a fleet of addresses cannot spend the box's
// whole minute between them. docs/JOB-BUS.md 10.6.
export function createRateLimiter({ limit = 120, windowMs = 60_000, capacity = 4096 } = {}) {
  const seen = new Map();
  return {
    // 0 means the request is allowed; anything else is the seconds to wait.
    retryAfterSeconds(key, nowMs = Date.now()) {
      const state = seen.get(key);
      if (state == null || nowMs >= state.resetAt) {
        seen.set(key, { count: 1, resetAt: nowMs + windowMs });
        if (seen.size > capacity) {
          for (const [other, value] of seen) {
            if (value.resetAt <= nowMs) seen.delete(other);
            if (seen.size <= capacity) break;
          }
        }
        return 0;
      }
      state.count += 1;
      if (state.count > limit) return Math.max(1, Math.ceil((state.resetAt - nowMs) / 1000));
      return 0;
    },
    size() { return seen.size; },
  };
}

// What the relay guarantees about a create call, and no more: it is JSON, it names a type, and it
// carries an idempotency key. The allowlist, the payload shape and the secret sweep are the
// gateway's, because they are the same rules whether a job arrives over HTTP or from the console.
export function jobCreateArgs(raw, headerKey, { client = null, submitterId = null } = {}) {
  let parsed;
  try { parsed = JSON.parse(String(raw ?? "").trim().length > 0 ? raw : "{}"); }
  catch { return { error: "body must be JSON" }; }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "body must be a JSON object" };
  }
  const type = typeof parsed.type === "string" ? parsed.type.trim() : "";
  if (type.length === 0) return { error: "type is required" };
  // The header wins: a client that retries sets Idempotency-Key, and when the two disagree the
  // header is the one the transport layer above us was retrying on.
  const key = String(headerKey ?? "").trim().length > 0
    ? String(headerKey).trim()
    : (typeof parsed.idempotency_key === "string" ? parsed.idempotency_key.trim() : "");
  if (key.length === 0) return { error: "missing idempotency key" };
  return {
    args: {
      // The parsed body goes up WHOLE, unknown fields included. Reshaping it field by field is
      // what let a body carrying `priority` or a future policy-like flag answer 201 with the flag
      // silently dropped: section 10.1's "unknown field" refusal belongs to the gateway, and the
      // gateway can only refuse a key it was given. The fields below still win over anything
      // the body carried, so a caller cannot name its own submitter, client or audit id.
      ...parsed,
      type,
      idempotency_key: key,
      payload: parsed.payload ?? {},
      policy: parsed.policy ?? {},
      callback_url: parsed.callback_url ?? null,
      // The bearer's label. CoS never names itself, so a job cannot claim a different submitter.
      submitter: "cos",
      // Who actually presented a token, and from where. Both come from the request rather than the
      // body for the same reason `submitter` is fixed: a caller must not be able to write its own
      // audit row. docs/JOB-BUS.md 10.5.
      client,
      submitter_id: submitterId,
    },
  };
}

// GET /v1/health, POST /v1/jobs, GET|POST /v1/jobs/{id}[/cancel|/artifacts] and nothing else.
// Returns the gateway command and the method it needs, so the caller answers 404 and 405 without
// a second copy of the table.
export function routeJobBus(pathname) {
  const rest = pathname.replace(/^\/v1/, "").replace(/\/+$/, "") || "/";
  if (rest === "/health") return { method: "GET", command: "jobBusHealth" };
  if (rest === "/jobs") return { method: "POST", command: "jobBusCreate" };
  const job = /^\/jobs\/([^/]+)(?:\/(cancel|artifacts))?$/.exec(rest);
  if (job == null) return null;
  let id;
  try { id = decodeURIComponent(job[1]); } catch { id = job[1]; }
  if (job[2] === "cancel") return { method: "POST", command: "jobBusCancel", args: { id } };
  if (job[2] === "artifacts") return { method: "GET", command: "jobBusArtifacts", args: { id } };
  return { method: "GET", command: "jobBusGet", args: { id } };
}
