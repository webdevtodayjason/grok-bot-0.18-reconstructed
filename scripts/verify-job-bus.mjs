#!/usr/bin/env node
// verify-job-bus.mjs -- the Titan Job Bus box gate (docs/JOB-BUS.md §9, amended by §10.8).
//
// It drives the PUBLIC surface, which is the whole point of the bus: everything below goes
// through `/v1` on a relay this script starts itself, with a random TITAN_JOB_TOKEN, exactly the
// way the Chief of Staff will reach it. Nothing here calls jobBus* on the gateway directly, so a
// command that works over the gateway and not through the relay's edge fails here rather than in
// production.
//
// The one thing that does go straight to the gateway is the bus's own settings (§10.7): the
// disabled leg, the repos allowlist, the worker mapping and maxOpen are policy, not routes. They
// are read first, overwritten for the run, and put back in the finally, whatever happens.
//
// In order:
//   closed    an unconfigured relay answers 401, not 503, and never says which it is (§10.6)
//   door      no bearer, a wrong bearer, an unknown path, the wrong method
//   health    200 with ok, queue_depth, version, host_version and the workers map
//   scope     the job bearer opens nothing else: /api/listAgents, /, /vnc/1/, /box/surface
//   off       with `enabled` false a create is 503 "job bus is disabled" (§10.7)
//   refusals  unknown type, a secret-looking payload, no idempotency key, an unknown field, a
//             repo outside the allowlist (§10.1)
//   ping      health.ping 201 -> done inside 30 s, with a non-empty receipt list
//   idem      the same key again is the SAME job id
//   worker    nextgen.chapter against a worker name this box does not have -> needs_human no_worker
//   full      with maxOpen at 1 and that job still open, the next create is 429 queue full (§10.3)
//   cancel    that job cancels, and cancelling a terminal job is 409
//   clone     a dispatched job grows a per-job clone of the mapped agent, and ending the job takes
//             the clone away again (§10.2)
//   reads     artifacts of the done ping is 200, an unknown id is 404
//   audit     job-bus/audit.jsonl grew by exactly the rows those transitions owe, its rows carry
//             §10.5's fields, and every `prev` chains to the sha256 of the row before it
//
// Not here, deliberately: §10.8's "a 41-char sha in a fake result is never accepted". That is a
// unit test (`npm test`), because the public surface cannot hand the worker a forged reply -- only
// a model in the worker's own conversation can, and a gate that could fake one would be proving
// something about itself rather than about the bus.
//
// It cleans up after itself: the agent it creates for the clone leg is deleted, any per-job clone
// still standing at the end is deleted, the temporary profile the closed-door relay used is
// removed, both relays are killed, and the settings go back to whatever the box held.
//
// Run it through the box lock, like every other box gate:
//   bash scripts/on-box.sh node scripts/verify-job-bus.mjs
//
// Env: SAND_PROFILE_DIRS (required, the gateway token), SAND_GATEWAY_URL (default
// http://127.0.0.1:1340), SAND_BOX_CONTAINER (default grok-bot-local-vm), JOB_BUS_RELAY_PORT
// (default 7791; the closed-door relay takes the port after it).
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "verify-job-bus.mjs -- the Titan Job Bus gate (docs/JOB-BUS.md §9 and §10.8).",
    "",
    "  bash scripts/on-box.sh node scripts/verify-job-bus.mjs",
    "",
    "Starts two relays on 127.0.0.1: one with a random TITAN_JOB_TOKEN and one with none, and",
    "drives /v1 end to end: the uniform 401, the door, health, the bearer's scope, the disabled",
    "bus, the allowlist and the payload rules, a health.ping to done with receipts, idempotency,",
    "a nextgen.chapter with no worker to needs_human, queue full, cancel and its 409, the per-job",
    "clone appearing and going away, artifacts, 404, and the audit file's growth, fields and",
    "hash chain. Both relays are killed on the way out, the settings it borrowed are put back,",
    "and every agent it created or saw cloned is deleted.",
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
const CLOSED_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const CLOSED_BASE = `http://127.0.0.1:${CLOSED_PORT}`;
const AUDIT = "/home/box/sand-data/job-bus/audit.jsonl";
// The bearer this run uses. Minted here, handed to the relay in its environment, and never
// written anywhere: it is not printed, not logged, and not put in a file.
const JOB_TOKEN = randomBytes(24).toString("hex");
// A worker name no box has. The no_worker leg has to be reached without deleting anybody's agent.
const ABSENT_WORKER = `no-such-worker-${randomBytes(4).toString("hex")}`;
// The only repository this run allows, so "outside the allowlist" is a real refusal rather than a
// repository that happens not to exist.
const GATE_REPO = "titanium/verify-job-bus";
const OUTSIDE_REPO = "titanium/not-on-the-allowlist";

const profile = () => {
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try {
      const file = `${dir}/local-docker-vm.json`;
      return { dir, file, token: JSON.parse(readFileSync(file, "utf8")).token };
    } catch { /* next */ }
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
  execFile("docker", args, { maxBuffer: 32 << 20 }, (error, out, err) =>
    resolve({ code: error?.code ?? 0, out: String(out), err: String(err) })));

// A gateway call with the box's own bearer. Only the settings and the roster use it.
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
const v1 = async (route, { method = "GET", body, bearer = JOB_TOKEN, headers = {}, base = BASE } = {}) => {
  const res = await fetch(`${base}/v1${route}`, {
    method,
    headers: {
      ...(bearer === false ? {} : { authorization: `Bearer ${bearer}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text.length ? JSON.parse(text) : null; } catch { /* the text is the answer */ }
  return { status: res.status, body: parsed, text, headers: res.headers };
};

// Anything on the relay that is NOT /v1, reached with the job bearer. §10.8: the bus's key opens
// the bus and nothing else.
const offBus = (route) => fetch(`${BASE}${route}`, {
  headers: { authorization: `Bearer ${JOB_TOKEN}`, accept: "text/html" },
  redirect: "manual",
  signal: AbortSignal.timeout(20_000),
}).then((res) => ({ status: res.status, location: String(res.headers.get("location") ?? "") }))
  .catch((error) => ({ status: 0, location: String(error?.message ?? error) }));

// The audit file is append-only, so this reads the whole thing rather than counting lines: §10.5
// wants the chain verified, and that needs the bytes. A missing file is no rows rather than an
// error: on a box that has never run a job it does not exist yet.
const auditLines = async () => {
  const r = await docker(["exec", BOX, "sh", "-c", `cat ${AUDIT} 2>/dev/null || true`]);
  return String(r.out).split("\n").filter((line) => line.length > 0);
};

const until = async (fn, ms, every = 1000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = await fn().catch(() => null);
    if (answer != null) return answer;
    if (Date.now() > deadline) return null;
    await sleep(every);
  }
};

const roster = async () => ((await gw("listAgents").catch(() => [])) ?? []);

// Read before anything is started, so a missing profile is one sentence rather than a stack trace
// over a relay that is already listening.
let GATEWAY_TOKEN;
let PROFILE;
try {
  PROFILE = profile();
  GATEWAY_TOKEN = PROFILE.token;
} catch (error) {
  console.log(`  FAIL  the gateway token is readable -- ${error.message}`);
  console.log("\n1 FAILED");
  process.exit(1);
}

let relay = null;
let closedRelay = null;
let closedProfileDir = null;
let settingsBefore;
let settingsTouched = false;
let probeAgentId = null;
// Every agent on the box before this gate ran. Anything outside it at the end that this run put
// there is swept, so a clone left standing by a bug does not become permanent residue.
let agentsBefore = new Set();

const stopRelays = () => {
  for (const child of [relay, closedRelay]) {
    if (child != null && child.exitCode == null) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  }
  relay = null;
  closedRelay = null;
};
const dropClosedProfile = () => {
  if (closedProfileDir == null) return;
  try { rmSync(closedProfileDir, { recursive: true, force: true }); } catch { /* nothing to remove */ }
  closedProfileDir = null;
};
// SIGTERM never reaches the finally (Node's default handler ends the process), and this gate runs
// under `timeout`, which sends exactly that. The child relays would outlive it and hold the ports.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { stopRelays(); dropClosedProfile(); process.exit(143); });
}

// One relay, started the way the production one is: its own port, its own token (or none), and
// the box's gateway. SAND_PROFILE_DIRS is passed through so it finds the gateway bearer.
const startRelay = (port, { token, profileDirs }) => spawn(process.execPath, [path.join(repoRoot, "ui", "server.mjs")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    SAND_UI_PORT: String(port),
    SAND_UI_BIND_HOST: "127.0.0.1",
    SAND_PROFILE_DIRS: profileDirs,
    ...(token == null ? {} : { TITAN_JOB_TOKEN: token }),
    SAND_HOST_GATEWAY_URL: GATEWAY,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const waitForRelay = async (child, base, log) => {
  for (let i = 0; i < 40 && child.exitCode == null; i += 1) {
    // Any answer at all means the server is listening; which answer is the next check's business.
    const probe = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (probe != null) return true;
    await sleep(500);
  }
  console.log(`  INFO  ${base} never answered: ${log().slice(-400)}`);
  return false;
};

try {
  step("the two relays this gate starts");
  let relayLog = "";
  relay = startRelay(PORT, { token: JOB_TOKEN, profileDirs: process.env.SAND_PROFILE_DIRS ?? "" });
  relay.stdout.on("data", (chunk) => { relayLog += String(chunk); });
  relay.stderr.on("data", (chunk) => { relayLog += String(chunk); });
  relay.on("exit", (code) => { relayLog += `\n(the relay exited with ${code})`; });

  // The closed-door relay gets a profile of its own holding nothing but the gateway token, so
  // "unconfigured" means unconfigured: a job-bus.json the console wrote beside the real profile
  // would otherwise configure it and this leg would prove nothing.
  closedProfileDir = mkdtempSync(path.join(tmpdir(), "job-bus-gate-"));
  copyFileSync(PROFILE.file, path.join(closedProfileDir, "local-docker-vm.json"));
  let closedLog = "";
  closedRelay = startRelay(CLOSED_PORT, { token: null, profileDirs: closedProfileDir });
  closedRelay.stdout.on("data", (chunk) => { closedLog += String(chunk); });
  closedRelay.stderr.on("data", (chunk) => { closedLog += String(chunk); });
  closedRelay.on("exit", (code) => { closedLog += `\n(the closed relay exited with ${code})`; });

  const up = await waitForRelay(relay, BASE, () => relayLog);
  check(up, `the relay is listening on ${BASE}`, up ? "" : relayLog.slice(-400));
  if (!up) throw new Error("the relay never came up; nothing below could be measured");
  const closedUp = await waitForRelay(closedRelay, CLOSED_BASE, () => closedLog);
  check(closedUp, `the token-less relay is listening on ${CLOSED_BASE}`, closedUp ? "" : closedLog.slice(-400));

  const auditBefore = (await auditLines()).length;
  console.log(`  INFO  ${AUDIT} holds ${auditBefore} row(s) before this run`);
  agentsBefore = new Set((await roster()).map((agent) => agent.id));
  console.log(`  INFO  ${agentsBefore.size} agent(s) on the box before this run`);

  step("a bus with no token (§10.6)");
  if (closedUp) {
    // The whole point of the uniform answer: an unconfigured bus and a wrong key look identical
    // from outside, so nobody can probe a deployment to learn whether a token has been set yet.
    const closedNoBearer = await v1("/health", { bearer: false, base: CLOSED_BASE });
    check(closedNoBearer.status === 401,
      "an unconfigured relay answers 401, never 503, on /v1/health", `HTTP ${closedNoBearer.status} ${closedNoBearer.text.slice(0, 120)}`);
    const closedWrong = await v1("/health", { bearer: JOB_TOKEN, base: CLOSED_BASE });
    check(closedWrong.status === 401 && closedWrong.text === closedNoBearer.text,
      "and a bearer it has never seen gets the same 401 body, so the two cases are indistinguishable",
      `HTTP ${closedWrong.status} ${closedWrong.text.slice(0, 120)}`);
    check(!/not configured/i.test(closedNoBearer.text), "the closed door does not say the bus is unconfigured", closedNoBearer.text.slice(0, 120));
  } else {
    check(false, "the token-less relay could be reached at all", "skipping the §10.6 uniform-401 leg");
  }

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
  check(typeof health.body?.version === "string" && health.body.version.length > 0, "the job API version", String(health.body?.version));
  check(typeof health.body?.host_version === "string" && health.body.host_version.length > 0,
    "and the host's own version beside it (§10.6)", String(health.body?.host_version));
  check(health.body?.workers != null && typeof health.body.workers === "object", "and the worker map", JSON.stringify(health.body?.workers ?? null));

  step("what the job bearer does NOT open (§10.8)");
  // A key that opened the console would make every other rule on this page decorative.
  // 404 is NOT accepted here. All four of these routes exist on the relay (server.mjs answers
  // /api/*, /, /vnc/<n>/ and /box/surface), so a 404 does not mean "refused", it means the route
  // moved -- and a leg that reads a moved route as a pass would keep saying the bearer is contained
  // long after it stopped being asked. A refusal is 401, 403, or a redirect to the login.
  for (const route of ["/api/listAgents", "/", "/vnc/1/", "/box/surface"]) {
    const answer = await offBus(route);
    const refused = answer.status === 401 || answer.status === 403
      || (answer.status >= 300 && answer.status < 400 && /\/login/.test(answer.location));
    check(refused, `the job bearer is refused on ${route}`,
      answer.status === 404
        ? `HTTP 404: this route is not where the gate thinks it is, so this leg proved nothing`
        : `HTTP ${answer.status}${answer.location ? ` -> ${answer.location}` : ""}`);
  }

  step("the settings this run borrows (§10.7)");
  // §10.9: this gate's relay is started with TITAN_JOB_TOKEN, so the relay arms the bus on its own
  // start -- and that call is fired unawaited before `listen`, so it is still in flight when the
  // health probe above answers. Wait for it to land. Without this the "off until the operator turns
  // it on" leg below races it: both writes go to the same host and whichever lands last wins.
  let armLanded = false;
  for (let i = 0; i < 40 && !armLanded; i += 1) {
    armLanded = (await gw("jobBusGetSettings").catch(() => undefined))?.enabled === true;
    if (!armLanded) await sleep(250);
  }
  check(armLanded, "the relay's own start armed the bus before this gate touched the switch (§10.9)",
    "jobBusGetSettings never reported enabled:true within 10 s of the relay answering");
  settingsBefore = await gw("jobBusGetSettings").catch(() => undefined);
  check(settingsBefore != null, "the host answers jobBusGetSettings", JSON.stringify(settingsBefore ?? null));
  // 10.9: the read carries `integrity` beside the settings, and the write refuses a key it does not
  // own -- so what goes back at the end is the settings without it.
  if (settingsBefore != null) delete settingsBefore.integrity;
  check(settingsBefore?.integrity === undefined, "and it is written back without the read-only integrity block");
  // Off first, because "off until the operator turns it on" is the one default that decides
  // whether shipping this code opens a door by itself.
  await gw("jobBusSetSettings", { enabled: false });
  settingsTouched = true;
  const whileOff = await v1("/jobs", { method: "POST", body: { type: "health.ping", idempotency_key: `off-${randomBytes(3).toString("hex")}`, payload: {} } });
  check(whileOff.status === 503 && /disabled/i.test(String(whileOff.body?.error ?? "")),
    "with the bus off a create is 503 'job bus is disabled'", `HTTP ${whileOff.status} ${JSON.stringify(whileOff.body)}`);
  await gw("jobBusSetSettings", {
    enabled: true,
    workers: { "nextgen.chapter": ABSENT_WORKER },
    repos: [GATE_REPO],
    maxOpen: 20,
  });

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
  // §10.1: a field nobody named is a caller talking to a bus it does not understand, and it is
  // refused rather than ignored -- ignoring it is how a policy flag silently stops applying.
  const unknownField = await v1("/jobs", {
    method: "POST",
    body: {
      type: "nextgen.chapter", idempotency_key: `k-${randomBytes(3).toString("hex")}`,
      payload: { course_slug: "verify-job-bus", chapter: 1, repo: GATE_REPO, branch: "main", extra: "no" },
    },
  });
  check(unknownField.status === 400 && /unknown field/i.test(String(unknownField.body?.detail ?? unknownField.body?.error ?? "")),
    "an unknown field in the payload is 400 and names the field", `HTTP ${unknownField.status} ${JSON.stringify(unknownField.body)}`);
  // §10.1: the repos allowlist, which is the difference between a bus that writes to Jason's
  // course repository and one that writes wherever a caller points it.
  const outsideRepo = await v1("/jobs", {
    method: "POST",
    body: {
      type: "nextgen.chapter", idempotency_key: `k-${randomBytes(3).toString("hex")}`,
      payload: { course_slug: "verify-job-bus", chapter: 1, repo: OUTSIDE_REPO, branch: "main" },
    },
  });
  check(outsideRepo.status === 400, "a repo outside the allowlist is 400", `HTTP ${outsideRepo.status} ${JSON.stringify(outsideRepo.body)}`);

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
  const chapterKey = `verify-job-bus-chapter-${randomBytes(4).toString("hex")}`;
  const chapter = await v1("/jobs", {
    method: "POST",
    headers: { "idempotency-key": chapterKey },
    body: {
      type: "nextgen.chapter",
      payload: { course_slug: "verify-job-bus", chapter: 1, repo: GATE_REPO, branch: "main" },
      policy: { no_final_assessment: true, no_placeholder: true, require_attestation: true },
    },
  });
  check(chapter.status === 201 && typeof chapter.body?.id === "string",
    "a valid nextgen.chapter is accepted", `HTTP ${chapter.status} ${chapter.text.slice(0, 160)}`);
  const chapterId = chapter.body?.id;
  let blocked = null;
  if (chapterId) {
    // 10.9 gives a missing worker two bounded retries (5 s then 10 s) before it becomes needs_human,
    // because a roster that has not caught up is not a worker that is not there. That budget, plus
    // the five-second tick it lands on, fits inside this wait.
    for (let i = 0; i < 45; i += 1) {
      blocked = await v1(`/jobs/${chapterId}`);
      if (blocked.body?.status !== "queued") break;
      await sleep(1000);
    }
  }
  check(blocked?.body?.status === "needs_human", "with no such agent on the box it stops on needs_human", `status ${blocked?.body?.status ?? "unread"}`);
  check(blocked?.body?.needs_human?.reason === "no_worker", "and the reason is no_worker", JSON.stringify(blocked?.body?.needs_human ?? null));

  step("queue full (§10.3)");
  // needs_human is not terminal, so that job is still open. With maxOpen at one, the next create
  // has to be refused rather than queued behind it.
  await gw("jobBusSetSettings", { maxOpen: 1 });
  const overflow = await v1("/jobs", {
    method: "POST",
    headers: { "idempotency-key": `verify-job-bus-full-${randomBytes(4).toString("hex")}` },
    body: { type: "health.ping", payload: {} },
  });
  check(overflow.status === 429 && /queue full/i.test(String(overflow.body?.error ?? "")),
    "with one job open and maxOpen at 1 the next create is 429 queue full", `HTTP ${overflow.status} ${JSON.stringify(overflow.body)}`);
  await gw("jobBusSetSettings", { maxOpen: 20 });

  step("cancel");
  const cancelled = chapterId ? await v1(`/jobs/${chapterId}/cancel`, { method: "POST", body: {} }) : { status: 0, body: null, text: "" };
  check(cancelled.status === 200 && cancelled.body?.status === "cancelled",
    "cancelling it answers 200 with cancelled", `HTTP ${cancelled.status} ${JSON.stringify(cancelled.body)}`);
  const again = chapterId ? await v1(`/jobs/${chapterId}/cancel`, { method: "POST", body: {} }) : { status: 0 };
  check(again.status === 409, "cancelling a terminal job is 409", `HTTP ${again.status}`);

  step("the per-job clone (§10.2)");
  // The contract's central promise about the worker: the prompt never lands in the mapped agent's
  // own conversation, it lands in a clone that exists for one job and is deleted with it. That is
  // only observable against a real agent, so this leg makes one, watches the roster, and takes it
  // away again. The job is cancelled as soon as the clone is seen, so the turn it started is the
  // shortest one the box can be asked for.
  const probeName = `job-bus-gate-${randomBytes(4).toString("hex")}`;
  const madeProbe = await gw("createAgent", { name: probeName, description: "verify-job-bus clone probe" }).catch(() => null);
  probeAgentId = madeProbe?.agent?.id ?? madeProbe?.id ?? null;
  check(probeAgentId != null, "an agent could be created to be the worker", probeName);
  let cloneId = null;
  if (probeAgentId) {
    await gw("jobBusSetSettings", { workers: { "nextgen.chapter": probeAgentId } });
    const dispatch = await v1("/jobs", {
      method: "POST",
      headers: { "idempotency-key": `verify-job-bus-clone-${randomBytes(4).toString("hex")}` },
      body: {
        type: "nextgen.chapter",
        payload: { course_slug: "verify-job-bus", chapter: 1, repo: GATE_REPO, branch: "main" },
        policy: { no_final_assessment: true, no_placeholder: true, require_attestation: true },
      },
    });
    check(dispatch.status === 201, "a job for that agent is accepted", `HTTP ${dispatch.status} ${dispatch.text.slice(0, 160)}`);
    const dispatchedId = dispatch.body?.id;
    // The clone is a new agent that is neither the probe nor anything that was here before.
    const clone = await until(async () => {
      const rows = await roster();
      return rows.find((agent) => agent.id !== probeAgentId && !agentsBefore.has(agent.id)) ?? null;
    }, 60_000, 2000);
    cloneId = clone?.id ?? null;
    check(clone != null, "a per-job clone appears on the roster while the job runs", clone ? `${clone.name} (${clone.id})` : "no new agent inside 60 s");
    if (clone) {
      check(String(clone.name ?? "").includes(probeName) && /job/i.test(String(clone.name ?? "")),
        "and it is named for the agent it was cloned from and the job it belongs to", String(clone.name ?? ""));
      const onJob = dispatchedId ? await v1(`/jobs/${dispatchedId}`) : { body: null };
      check(onJob.body?.worker?.agentId === clone.id && onJob.body?.worker?.sourceAgentId === probeAgentId,
        "the job record names the clone as its worker and the mapped agent as its source",
        JSON.stringify(onJob.body?.worker ?? null));
    }
    if (dispatchedId) await v1(`/jobs/${dispatchedId}/cancel`, { method: "POST", body: {} }).catch(() => {});
    if (cloneId) {
      const gone = await until(async () => ((await roster()).some((agent) => agent.id === cloneId) ? null : true), 60_000, 2000);
      check(gone === true, "and the clone is gone once the job ends", gone === true ? "" : "the clone was still on the roster after 60 s");
      if (gone === true) cloneId = null;
    }
  }

  step("the reads");
  const artifacts = pingId ? await v1(`/jobs/${pingId}/artifacts`) : { status: 0, body: null };
  check(artifacts.status === 200 && artifacts.body?.id === pingId,
    "artifacts of the done ping is 200", `HTTP ${artifacts.status} ${JSON.stringify(artifacts.body ?? null).slice(0, 160)}`);
  check(Array.isArray(artifacts.body?.artifacts) && Array.isArray(artifacts.body?.commits),
    "with the two lists the contract names", JSON.stringify({ artifacts: artifacts.body?.artifacts, commits: artifacts.body?.commits }));
  const missing = await v1(`/jobs/job_${randomBytes(8).toString("hex")}`);
  check(missing.status === 404, "an unknown job id is 404", `HTTP ${missing.status}`);

  step("the audit file (§10.5)");
  const after = await auditLines();
  // The transitions this run owes: the ping's queued and done, the chapter's queued, needs_human
  // and cancelled, and, when the clone leg ran, that job's queued, running and its terminal row.
  // A create the edge refused never became a job, so it owes no row; the duplicate key returned
  // the first job rather than making a second; and the 429 was refused before a job existed.
  const expected = 5 + (probeAgentId ? 3 : 0);
  const grew = after.length - auditBefore;
  check(grew === expected, `audit.jsonl grew by exactly the ${expected} rows those transitions owe`,
    `${auditBefore} -> ${after.length} (${grew})`);
  if (grew !== expected) console.log(`  INFO  last rows:\n${after.slice(-8).map((l) => l.slice(0, 240)).join("\n")}`);

  const mine = after.slice(auditBefore);
  const fields = ["seq", "prev", "at", "event", "jobId", "type", "submitter", "submitter_id", "client", "payload_sha256", "policy_version", "ok", "eventId"];
  const parsed = mine.map((line) => { try { return JSON.parse(line); } catch { return null; } });
  const missingField = fields.find((field) => parsed.some((row) => row == null || !(field in row)));
  check(missingField === undefined, "every row this run wrote carries §10.5's fields",
    missingField === undefined ? `${mine.length} row(s)` : `no row field ${missingField}`);
  check(parsed.every((row) => row?.policy_version === "v1"), "and the policy version the contract fixes");

  // The chain: each row's `prev` is the sha256 of the bytes of the row before it, "" for the very
  // first row in the file. ONE convention, the store's own (`auditRowBytes` = the line without its
  // newline, job-store.ts). Accepting either reading is how a gate stops being a check: two hashing
  // conventions means a file the host could never have written still passes, so the wrong-newline
  // reading is only computed to say which mistake was made.
  const chainHolds = (withNewline) => {
    for (let i = 0; i < after.length; i += 1) {
      let row;
      try { row = JSON.parse(after[i]); } catch { return false; }
      const want = i === 0 ? "" : createHash("sha256").update(withNewline ? `${after[i - 1]}\n` : after[i - 1]).digest("hex");
      if (String(row.prev ?? "") !== want) return false;
    }
    return true;
  };
  const bare = after.length > 0 && chainHolds(false);
  const newline = after.length > 0 && chainHolds(true);
  check(bare, `the audit chain verifies over all ${after.length} row(s)`,
    bare ? "hashing each row's bytes, which is the store's convention"
      : newline ? "the rows chain over their bytes WITH the newline, which is not what the store writes"
        : "a prev does not match the row before it");
} catch (error) {
  check(false, "the gate ran to the end", String(error?.message ?? error));
} finally {
  // Put the box back before anything else. A borrowed worker mapping left behind would send every
  // real nextgen.chapter job to an agent that does not exist, and a borrowed repos allowlist would
  // refuse every real one.
  if (settingsTouched) {
    try {
      await gw("jobBusSetSettings", settingsBefore ?? {});
      console.log(`\n  INFO  the job bus settings were put back: ${JSON.stringify(settingsBefore ?? null)}`);
    } catch (error) {
      check(false, "the borrowed job bus settings were put back", String(error?.message ?? error));
    }
  }
  // Anything this run added to the roster goes, whether it is the probe or a clone the bus should
  // have deleted itself. A gate that leaves agents behind is a gate nobody can run twice.
  try {
    const leftovers = (await roster()).filter((agent) => !agentsBefore.has(agent.id));
    for (const agent of leftovers) {
      const why = agent.id === probeAgentId ? "the agent this gate created" : "a per-job clone the bus did not delete";
      await gw("deleteAgent", { id: agent.id }).then(
        () => console.log(`  INFO  swept ${agent.name} (${agent.id}): ${why}`),
        (error) => check(false, `${agent.name} (${agent.id}) could be swept`, String(error?.message ?? error)),
      );
    }
  } catch (error) {
    check(false, "the roster could be read for the sweep", String(error?.message ?? error));
  }
  stopRelays();
  dropClosedProfile();
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
