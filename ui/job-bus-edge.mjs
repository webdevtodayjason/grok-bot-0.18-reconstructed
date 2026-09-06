// The job bus edge: token resolution, the rate limit and the create-call shaping.
//
// It lives beside the relay rather than inside it because these three are the parts with rules
// worth testing on their own, and because server.mjs is already long. Nothing here imports
// anything outside node builtins: the relay has no node_modules at all.
//
// The contract is docs/JOB-BUS.md sections 2 and 3. Every name here is from it.
import { randomBytes } from "node:crypto";
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

// Env first, then the file the console writes, then unconfigured -- which is a 503 rather than an
// open door. Resolved on every request on purpose: generating a token in Settings has to work
// without restarting the relay, and one small readFileSync is cheaper than the fetch that follows.
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

// 120 requests a minute per client, in fixed windows, with the same bounded-map shape as the
// login throttle: the key comes from the caller, so an unbounded map would be a memory leak.
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
export function jobCreateArgs(raw, headerKey) {
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
      type,
      idempotency_key: key,
      payload: parsed.payload ?? {},
      policy: parsed.policy ?? {},
      callback_url: parsed.callback_url ?? null,
      // The bearer's label. CoS never names itself, so a job cannot claim a different submitter.
      submitter: "cos",
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
