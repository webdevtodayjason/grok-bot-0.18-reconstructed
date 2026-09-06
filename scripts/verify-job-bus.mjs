#!/usr/bin/env node
// verify-job-bus.mjs -- the Titan Job Bus box gate (docs/JOB-BUS.md §9, second bullet).
//
// It drives the PUBLIC surface, which is the whole point of the bus: everything below goes
// through `/v1` on a relay this script starts itself, with a random TITAN_JOB_TOKEN, exactly the
// way the Chief of Staff will reach it. Nothing here calls jobBus* on the gateway directly, so a
// command that works over the gateway and not through the relay's edge fails here rather than in
// production.
//
// The one thing that does go straight to the gateway is the worker mapping: the no_worker leg
// needs SAND_JOB_BUS_WORKERS to name an agent this box does not have, and that is a host setting,
// not a bus route. It is read first, overwritten, and put back in the finally, whatever happens.
//
// In order:
//   401       no bearer, and a wrong bearer, on /v1/health
//   health    200 with ok, queue_depth, version and the workers map
//   400       unknown type (with the allowlist), a secret-looking payload, a missing idempotency key
//   ping      health.ping 201 -> done inside 30 s, with a non-empty receipt list
//   idem      the same key again is the SAME job id
//   worker    nextgen.chapter against a worker name this box does not have -> needs_human no_worker
//   cancel    that job cancels, and cancelling a terminal job is 409
//   reads     artifacts of the done ping is 200, an unknown id is 404
//   audit     job-bus/audit.jsonl grew by exactly the five rows those transitions owe
//
// Run it through the box lock, like every other box gate:
//   bash scripts/on-box.sh node scripts/verify-job-bus.mjs
//
// Env: SAND_PROFILE_DIRS (required, the gateway token), SAND_GATEWAY_URL (default
// http://127.0.0.1:1340), SAND_BOX_CONTAINER (default grok-bot-local-vm), JOB_BUS_RELAY_PORT
// (default 7791).
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "verify-job-bus.mjs -- the Titan Job Bus gate (docs/JOB-BUS.md §9).",
    "",
    "  bash scripts/on-box.sh node scripts/verify-job-bus.mjs",
    "",
    "Starts its own relay on 127.0.0.1:7791 with a random TITAN_JOB_TOKEN and drives /v1 end to",
    "end: refusals, health, the allowlist, a health.ping to done with receipts, idempotency, a",
    "nextgen.chapter with no worker to needs_human, cancel and its 409, artifacts, 404, and the",
    "exact growth of job-bus/audit.jsonl. The relay is killed on the way out and the worker",
    "mapping this gate borrows is put back.",
    "",
    "Env: SAND_PROFILE_DIRS (required), SAND_GATEWAY_URL (default http://127.0.0.1:1340),",
    "     SAND_BOX_CONTAINER (default grok-bot-local-vm), JOB_BUS_RELAY_PORT (default 7791).",
  ].join("\n"));
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY = process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:1340";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const PORT = Number(process.env.JOB_BUS_RELAY_PORT ?? 7791);
const BASE = `http://127.0.0.1:${PORT}`;
const AUDIT = "/home/box/sand-data/job-bus/audit.jsonl";
// The bearer this run uses. Minted here, handed to the relay in its environment, and never
// written anywhere: it is not printed, not logged, and not put in a file.
const JOB_TOKEN = randomBytes(24).toString("hex");
// A worker name no box has. The no_worker leg has to be reached without deleting anybody's agent.
const ABSENT_WORKER = `no-such-worker-${randomBytes(4).toString("hex")}`;

const profileToken = () => {
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch { /* next */ }
  }
  throw new Error("no gateway token: set SAND_PROFILE_DIRS to the profile directory holding local-docker-vm.json");
};

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const step = (title) => console.log(`\n== ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (args) => new Promise((resolve) =>
  execFile("docker", args, { maxBuffer: 8 << 20 }, (error, out, err) =>
    resolve({ code: error?.code ?? 0, out: String(out), err: String(err) })));

// A gateway call with the box's own bearer. Only the worker mapping uses it.
const gw = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return text.length ? JSON.parse(text) : null; } catch { return text; }
};

// Every /v1 request in this file. `bearer` false sends none, a string sends that one, and the
// default sends the real token, so a refusal check cannot accidentally be a success check.
const v1 = async (route, { method = "GET", body, bearer = JOB_TOKEN, headers = {} } = {}) => {
  const res = await fetch(`${BASE}/v1${route}`, {
    method,
    headers: {
      ...(bearer === false ? {} : { authorization: `Bearer ${bearer}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text.length ? JSON.parse(text) : null; } catch { /* the text is the answer */ }
  return { status: res.status, body: parsed, text, headers: res.headers };
};

// The audit file is append-only, so its line count before and after is the transition count. A
// missing file is zero rows rather than an error: on a box that has never run a job it does not
// exist yet, and the growth is what this gate measures either way.
const auditRows = async () => {
  const r = await docker(["exec", BOX, "sh", "-c", `wc -l < ${AUDIT} 2>/dev/null || echo 0`]);
  const n = Number(String(r.out).trim());
  return Number.isFinite(n) ? n : 0;
};

// Read before anything is started, so a missing profile is one sentence rather than a stack trace
// over a relay that is already listening.
let GATEWAY_TOKEN;
try {
  GATEWAY_TOKEN = profileToken();
} catch (error) {
  console.log(`  FAIL  the gateway token is readable -- ${error.message}`);
  console.log("\n1 FAILED");
  process.exit(1);
}
let relay = null;
let workersBefore;
let workersTouched = false;

const stopRelay = () => {
  if (relay != null && relay.exitCode == null) { try { relay.kill("SIGTERM"); } catch { /* already gone */ } }
  relay = null;
};
// SIGTERM never reaches the finally (Node's default handler ends the process), and this gate runs
// under `timeout`, which sends exactly that. The child relay would outlive it and hold the port.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { stopRelay(); process.exit(143); });

try {
  step("the relay this gate starts");
  // Its own port, its own token, the box's gateway. SAND_PROFILE_DIRS is passed through so the
  // relay finds the gateway bearer the same way the production one does.
  relay = spawn(process.execPath, [path.join(repoRoot, "ui", "server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SAND_UI_PORT: String(PORT),
      SAND_UI_BIND_HOST: "127.0.0.1",
      SAND_PROFILE_DIRS: process.env.SAND_PROFILE_DIRS ?? "",
      TITAN_JOB_TOKEN: JOB_TOKEN,
      SAND_HOST_GATEWAY_URL: GATEWAY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let relayLog = "";
  relay.stdout.on("data", (chunk) => { relayLog += String(chunk); });
  relay.stderr.on("data", (chunk) => { relayLog += String(chunk); });
  relay.on("exit", (code) => { relayLog += `\n(the relay exited with ${code})`; });

  let up = false;
  for (let i = 0; i < 40 && relay.exitCode == null; i += 1) {
    const probe = await v1("/health", { bearer: false }).catch(() => null);
    // Any answer at all means the server is listening; which answer is the next check's business.
    if (probe != null) { up = true; break; }
    await sleep(500);
  }
  check(up, `the relay is listening on ${BASE}`, up ? "" : relayLog.slice(-400));
  if (!up) throw new Error("the relay never came up; nothing below could be measured");

  const auditBefore = await auditRows();
  console.log(`  INFO  ${AUDIT} holds ${auditBefore} row(s) before this run`);

  step("the door");
  const noBearer = await v1("/health", { bearer: false });
  check(noBearer.status === 401, "GET /v1/health with no bearer is 401", `HTTP ${noBearer.status} ${noBearer.text.slice(0, 120)}`);
  check(/Bearer/i.test(String(noBearer.headers.get("www-authenticate") ?? "")),
    "and it names the scheme in www-authenticate", noBearer.headers.get("www-authenticate") ?? "absent");
  const wrongBearer = await v1("/health", { bearer: `${JOB_TOKEN}0` });
  check(wrongBearer.status === 401, "a wrong bearer is 401 as well", `HTTP ${wrongBearer.status}`);
  const unknownPath = await v1("/nothing-here");
  check(unknownPath.status === 404, "an unknown /v1 path is 404", `HTTP ${unknownPath.status}`);
  const wrongMethod = await v1("/health", { method: "POST", body: {} });
  check(wrongMethod.status === 405, "the wrong method on a real route is 405", `HTTP ${wrongMethod.status}`);

  step("health");
  const health = await v1("/health");
  check(health.status === 200 && health.body?.ok === true, "GET /v1/health is 200 with ok:true", `HTTP ${health.status} ${health.text.slice(0, 160)}`);
  check(Number.isInteger(health.body?.queue_depth), "it reports an integer queue_depth", String(health.body?.queue_depth));
  check(typeof health.body?.version === "string" && health.body.version.length > 0, "and the package version", String(health.body?.version));
  check(health.body?.workers != null && typeof health.body.workers === "object", "and the worker map", JSON.stringify(health.body?.workers ?? null));

  step("what the allowlist refuses");
  const unknownType = await v1("/jobs", { method: "POST", body: { type: "shell", idempotency_key: `k-${randomBytes(3).toString("hex")}`, payload: {} } });
  check(unknownType.status === 400 && Array.isArray(unknownType.body?.allowed),
    "an unknown type is 400 and says what is allowed", `HTTP ${unknownType.status} ${JSON.stringify(unknownType.body?.allowed ?? unknownType.body)}`);
  check(!(unknownType.body?.allowed ?? []).includes("shell"), "and shell is not on that list");
  // A payload that carries something shaped like a credential is refused whole. Both halves of
  // the rule are checked: the KEY name here, the VALUE prefix below.
  const secretKey = await v1("/jobs", { method: "POST", body: { type: "health.ping", idempotency_key: `k-${randomBytes(3).toString("hex")}`, payload: { api_key: "anything" } } });
  check(secretKey.status === 400 && /secret/i.test(String(secretKey.body?.error ?? "")),
    "a payload key that looks like a credential is 400", `HTTP ${secretKey.status} ${JSON.stringify(secretKey.body)}`);
  const secretValue = await v1("/jobs", { method: "POST", body: { type: "health.ping", idempotency_key: `k-${randomBytes(3).toString("hex")}`, payload: { note: "ghp_0000000000000000000000000000000000" } } });
  check(secretValue.status === 400 && /secret/i.test(String(secretValue.body?.error ?? "")),
    "and so is a value that starts like one", `HTTP ${secretValue.status} ${JSON.stringify(secretValue.body)}`);
  const noKey = await v1("/jobs", { method: "POST", body: { type: "health.ping", payload: {} } });
  check(noKey.status === 400, "a create with no idempotency key is 400", `HTTP ${noKey.status} ${JSON.stringify(noKey.body)}`);

  step("health.ping end to end");
  const pingKey = `verify-job-bus-ping-${randomBytes(4).toString("hex")}`;
  const created = await v1("/jobs", {
    method: "POST",
    headers: { "idempotency-key": pingKey },
    body: { type: "health.ping", payload: {} },
  });
  check(created.status === 201 && typeof created.body?.id === "string",
    "POST /v1/jobs with the key in the header is 201 with an id", `HTTP ${created.status} ${created.text.slice(0, 160)}`);
  const pingId = created.body?.id;
  let ping = null;
  if (pingId) {
    // The host finishes health.ping in process, so 30 s is generous. Polling rather than sleeping
    // keeps a fast box fast and a busy one honest.
    for (let i = 0; i < 30; i += 1) {
      ping = await v1(`/jobs/${pingId}`);
      if (["done", "failed", "cancelled", "needs_human"].includes(ping.body?.status)) break;
      await sleep(1000);
    }
  }
  check(ping?.body?.status === "done", "it reaches done inside 30 s", `status ${ping?.body?.status ?? "unread"}`);
  check(ping?.body?.result?.summary === "pong", "with the pong summary the contract fixes", JSON.stringify(ping?.body?.result?.summary ?? null));
  const receipts = ping?.body?.result?.attestation?.receipts ?? [];
  check(Array.isArray(receipts) && receipts.length > 0, "and a non-empty receipt list", JSON.stringify(receipts));
  check((ping?.body?.result?.attestation?.unsupported_claims ?? ["missing"]).length === 0,
    "with no unsupported claims", JSON.stringify(ping?.body?.result?.attestation?.unsupported_claims ?? null));
  check(ping?.body?.submitter === "cos", "the relay labelled the submitter, not the caller", String(ping?.body?.submitter));

  // Same key, and the body carries it this time rather than the header: the contract says the
  // header wins when present and the body is read when it is not, so both spellings are one job.
  const duplicate = await v1("/jobs", { method: "POST", body: { type: "health.ping", idempotency_key: pingKey, payload: {} } });
  check(duplicate.status === 200 && duplicate.body?.id === pingId,
    "the same key again is 200 with the same job, from the body spelling", `HTTP ${duplicate.status} id ${duplicate.body?.id}`);

  step("a job with nobody to run it");
  workersBefore = await gw("getHostSettings").then((s) => {
    const nested = s?.settings;
    const source = nested != null && typeof nested === "object" && !Array.isArray(nested) ? nested : s;
    return source?.SAND_JOB_BUS_WORKERS;
  }).catch(() => undefined);
  await gw("setHostSettings", { SAND_JOB_BUS_WORKERS: JSON.stringify({ "nextgen.chapter": ABSENT_WORKER }) });
  workersTouched = true;
  const chapterKey = `verify-job-bus-chapter-${randomBytes(4).toString("hex")}`;
  const chapter = await v1("/jobs", {
    method: "POST",
    headers: { "idempotency-key": chapterKey },
    body: {
      type: "nextgen.chapter",
      payload: { course_slug: "verify-job-bus", chapter: 1, repo: "titanium/verify-job-bus", branch: "main" },
      policy: { no_final_assessment: true, no_placeholder: true, require_attestation: true },
    },
  });
  check(chapter.status === 201 && typeof chapter.body?.id === "string",
    "a valid nextgen.chapter is accepted", `HTTP ${chapter.status} ${chapter.text.slice(0, 160)}`);
  const chapterId = chapter.body?.id;
  let blocked = null;
  if (chapterId) {
    for (let i = 0; i < 30; i += 1) {
      blocked = await v1(`/jobs/${chapterId}`);
      if (blocked.body?.status !== "queued") break;
      await sleep(1000);
    }
  }
  check(blocked?.body?.status === "needs_human", "with no such agent on the box it stops on needs_human", `status ${blocked?.body?.status ?? "unread"}`);
  check(blocked?.body?.needs_human?.reason === "no_worker", "and the reason is no_worker", JSON.stringify(blocked?.body?.needs_human ?? null));

  step("cancel");
  const cancelled = chapterId ? await v1(`/jobs/${chapterId}/cancel`, { method: "POST", body: {} }) : { status: 0, body: null, text: "" };
  check(cancelled.status === 200 && cancelled.body?.status === "cancelled",
    "cancelling it answers 200 with cancelled", `HTTP ${cancelled.status} ${JSON.stringify(cancelled.body)}`);
  const again = chapterId ? await v1(`/jobs/${chapterId}/cancel`, { method: "POST", body: {} }) : { status: 0 };
  check(again.status === 409, "cancelling a terminal job is 409", `HTTP ${again.status}`);

  step("the reads");
  const artifacts = pingId ? await v1(`/jobs/${pingId}/artifacts`) : { status: 0, body: null };
  check(artifacts.status === 200 && artifacts.body?.id === pingId,
    "artifacts of the done ping is 200", `HTTP ${artifacts.status} ${JSON.stringify(artifacts.body ?? null).slice(0, 160)}`);
  check(Array.isArray(artifacts.body?.artifacts) && Array.isArray(artifacts.body?.commits),
    "with the two lists the contract names", JSON.stringify({ artifacts: artifacts.body?.artifacts, commits: artifacts.body?.commits }));
  const missing = await v1(`/jobs/job_${randomBytes(8).toString("hex")}`);
  check(missing.status === 404, "an unknown job id is 404", `HTTP ${missing.status}`);

  step("the audit file");
  const auditAfter = await auditRows();
  // Five transitions, and only five: the ping's queued and done, the chapter's queued and
  // needs_human, and the chapter's cancelled. A create the edge refused never became a job, so it
  // owes no row, and the duplicate key returned the first job rather than making a second.
  check(auditAfter - auditBefore === 5, "audit.jsonl grew by exactly the five rows those transitions owe",
    `${auditBefore} -> ${auditAfter} (${auditAfter - auditBefore})`);
  if (auditAfter - auditBefore !== 5) {
    const tail = await docker(["exec", BOX, "sh", "-c", `tail -n 8 ${AUDIT} 2>/dev/null | cut -c1-240`]);
    console.log(`  INFO  last rows:\n${tail.out.trim()}`);
  }
} catch (error) {
  check(false, "the gate ran to the end", String(error?.message ?? error));
} finally {
  // Put the box back before anything else: a borrowed worker mapping left behind would send every
  // real nextgen.chapter job to an agent that does not exist.
  if (workersTouched) {
    try {
      await gw("setHostSettings", workersBefore === undefined ? { SAND_JOB_BUS_WORKERS: "" } : { SAND_JOB_BUS_WORKERS: String(workersBefore) });
      console.log(`\n  INFO  SAND_JOB_BUS_WORKERS restored to ${workersBefore === undefined ? "empty (it held nothing)" : String(workersBefore)}`);
    } catch (error) {
      check(false, "the borrowed worker mapping was put back", String(error?.message ?? error));
    }
  }
  stopRelay();
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
