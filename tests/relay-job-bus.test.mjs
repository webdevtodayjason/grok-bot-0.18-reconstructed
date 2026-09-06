// The relay's job bus edge, exercised as HTTP rather than as helpers.
//
// /v1 is the only surface the Chief of Staff ever reaches, so what matters is not that the code
// compiles but that a real request with a real bearer lands on the right gateway command, and that
// every other request does not: no bearer, the wrong bearer, a console session, a job bearer aimed
// at /api. Those are answers a unit test on a pure function cannot give, so each test here starts a
// relay copy in a child process against a fake gateway of its own.
//
// The contract is docs/JOB-BUS.md sections 2 and 3.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFileSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY_TOKEN = "g".repeat(64);
const JOB_TOKEN = "j".repeat(48);
const PASSWORD = "a password no test types";

// A gateway that answers the five jobBus commands and records what it was asked. Its default is a
// health answer; a test replaces `reply` to shape the response it needs.
function fakeGateway() {
  const seen = [];
  let reply = () => ({ status: 200, body: { ok: true, queue_depth: 0, version: "0.18.0", workers: { "nextgen.chapter": "Scribe" } } });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const command = req.url.replace("/api/", "");
      let args; try { args = JSON.parse(raw || "{}"); } catch { args = null; }
      seen.push({ command, args, authorization: req.headers.authorization ?? null });
      const answer = reply(command, args) ?? { status: 200, body: {} };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  return {
    seen,
    answerWith(fn) { reply = fn; },
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    stop() { server.close(); },
  };
}

// A copy, never ui/ itself: the operator's own ui/auth.json would change which branch runs.
function relayCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-job-bus-"));
  for (const name of readdirSync(path.join(repoRoot, "ui")).filter((file) => file.endsWith(".mjs"))) {
    copyFileSync(path.join(repoRoot, "ui", name), path.join(dir, name));
  }
  return dir;
}

// There is no way to read back the port from SAND_UI_PORT=0 -- the relay prints the value it was
// given -- so the port is picked at random and retried, the way the other relay tests do it.
async function startRelay({ env = {}, withPassword = true } = {}) {
  const gateway = fakeGateway();
  const gatewayUrl = await gateway.start();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dir = relayCopy();
    const profile = mkdtempSync(path.join(tmpdir(), "job-bus-profile-"));
    if (withPassword) {
      const { newAuthRecord, writeAuthFile } = await import("../ui/auth.mjs");
      writeAuthFile(path.join(dir, "auth.json"), newAuthRecord(PASSWORD));
    }
    const port = 35000 + Math.floor(Math.random() * 8000);
    const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
      env: {
        ...process.env,
        SAND_UI_PORT: String(port),
        SAND_UI_BIND_HOST: "127.0.0.1",
        SAND_UI_TRUSTED_PROXIES: "",
        SAND_HOST_GATEWAY_TOKEN: GATEWAY_TOKEN,
        SAND_HOST_GATEWAY_URL: gatewayUrl,
        SAND_PROFILE_DIRS: profile,
        TITAN_JOB_TOKEN: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const listening = await new Promise((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("auth ")) resolve(true); });
      child.on("exit", () => resolve(false));
      setTimeout(() => resolve(false), 15_000).unref();
    });
    if (listening) {
      return {
        base: `http://127.0.0.1:${port}`, gateway, profile,
        tokenFile: path.join(profile, "job-bus.json"),
        stop() { child.kill("SIGKILL"); gateway.stop(); },
      };
    }
    child.kill("SIGKILL");
  }
  gateway.stop();
  throw new Error("the relay copy would not start on any of five ports");
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });
const postJob = (relay, body, headers = {}) => fetch(`${relay.base}/v1/jobs`, {
  method: "POST", headers: { "content-type": "application/json", ...bearer(JOB_TOKEN), ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

async function signIn(relay) {
  const response = await fetch(`${relay.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD, next: "/" }).toString(),
  });
  const cookie = /(?:^|,\s*)(gb_session=[^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(cookie, "the test could not sign in to the console");
  return cookie;
}

test("an unconfigured bus answers 401, the same answer a wrong token gets", async () => {
  // The old 503 said "job bus not configured", which told an unauthenticated stranger both that
  // this host runs a bus and that its token is unset right now. docs/JOB-BUS.md 10.6.
  const relay = await startRelay();
  try {
    for (const [method, route] of [["GET", "/v1/health"], ["POST", "/v1/jobs"], ["GET", "/v1/jobs/job_1"]]) {
      const response = await fetch(`${relay.base}${route}`, { method, headers: bearer(JOB_TOKEN) });
      assert.equal(response.status, 401, `${method} ${route}`);
      assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="titan-job-bus"');
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
    assert.deepEqual(relay.gateway.seen, [], "an unconfigured bus must not reach the gateway");
  } finally { relay.stop(); }
});

test("configured is visible on the console route and nowhere on /v1", async () => {
  const relay = await startRelay();
  try {
    const cookie = await signIn(relay);
    const unconfigured = await (await fetch(`${relay.base}/job-bus/status`, { headers: { cookie } })).json();
    assert.deepEqual([unconfigured.configured, unconfigured.source], [false, null]);
    writeFileSync(relay.tokenFile, JSON.stringify({ token: JOB_TOKEN }), { mode: 0o600 });
    const configured = await (await fetch(`${relay.base}/job-bus/status`, { headers: { cookie } })).json();
    assert.deepEqual([configured.configured, configured.source], [true, "file"]);
  } finally { relay.stop(); }
});

test("five refused bearers lock the address out, and the lockout is audited once", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await fetch(`${relay.base}/v1/health`, { headers: bearer("k".repeat(48)) });
      assert.equal(refused.status, 401, `attempt ${attempt}`);
    }
    // The right token now, and still refused: the lockout is on the address, not on the guess.
    const locked = await fetch(`${relay.base}/v1/health`, { headers: bearer(JOB_TOKEN) });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) > 0);

    // The audit row is fire and forget, so wait for it rather than assuming the order.
    let rows = [];
    for (let wait = 0; wait < 50 && rows.length === 0; wait += 1) {
      rows = relay.gateway.seen.filter((call) => call.command === "jobBusAudit");
      if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(rows.length, 1, "one row when the lockout begins, not one per refused request");
    assert.equal(rows[0].args.event, "auth_locked");
    assert.match(rows[0].args.client, /^(::ffff:)?127\.0\.0\.1$|^::1$/);
    assert.deepEqual(relay.gateway.seen.filter((call) => call.command !== "jobBusAudit"), [],
      "no refused request reaches a jobBus command");
  } finally { relay.stop(); }
});

test("the bearer is required on every /v1 route including health", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    const none = await fetch(`${relay.base}/v1/health`);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="titan-job-bus"');
    assert.deepEqual(await none.json(), { error: "unauthorized" });

    const wrong = await fetch(`${relay.base}/v1/health`, { headers: bearer("k".repeat(48)) });
    assert.equal(wrong.status, 401);
    // Same length as the real one, so this is the constant-time compare answering, not a length check.
    assert.deepEqual(await wrong.json(), { error: "unauthorized" });
    assert.deepEqual(relay.gateway.seen, [], "a refused request must not reach the gateway");

    const ok = await fetch(`${relay.base}/v1/health`, { headers: bearer(JOB_TOKEN) });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.workers["nextgen.chapter"], "Scribe");
    assert.equal(relay.gateway.seen.at(-1).command, "jobBusHealth");
    // The relay's own gateway token, never the job bearer.
    assert.equal(relay.gateway.seen.at(-1).authorization, `Bearer ${GATEWAY_TOKEN}`);
  } finally { relay.stop(); }
});

test("unknown /v1 paths are 404 and wrong methods are 405", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    const unknown = await fetch(`${relay.base}/v1/nope`, { headers: bearer(JOB_TOKEN) });
    assert.equal(unknown.status, 404);
    const root = await fetch(`${relay.base}/v1`, { headers: bearer(JOB_TOKEN) });
    assert.equal(root.status, 404);

    const wrongMethod = await fetch(`${relay.base}/v1/health`, { method: "POST", headers: bearer(JOB_TOKEN) });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
    const getJobs = await fetch(`${relay.base}/v1/jobs`, { headers: bearer(JOB_TOKEN) });
    assert.equal(getJobs.status, 405);
    assert.equal(getJobs.headers.get("allow"), "POST");
    assert.deepEqual(relay.gateway.seen, []);
  } finally { relay.stop(); }
});

test("a job body over 64 KB is refused before it is forwarded", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    const huge = JSON.stringify({ type: "nextgen.chapter", idempotency_key: "big", payload: { pad: "x".repeat(70 * 1024) } });
    const response = await postJob(relay, huge);
    assert.equal(response.status, 413);
    assert.deepEqual(relay.gateway.seen, []);
  } finally { relay.stop(); }
});

test("more than 120 requests a minute from one client is 429 with a retry-after", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    for (let i = 0; i < 120; i += 1) {
      const response = await fetch(`${relay.base}/v1/health`, { headers: bearer(JOB_TOKEN) });
      assert.equal(response.status, 200, `call ${i + 1} of the first 120 answered ${response.status}`);
    }
    const limited = await fetch(`${relay.base}/v1/health`, { headers: bearer(JOB_TOKEN) });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal(relay.gateway.seen.length, 120, "the 121st call must not reach the gateway");
  } finally { relay.stop(); }
});

test("600 requests a minute across every client is 429 too", async () => {
  // The per-client bucket alone is 120 an address, so a caller with a range of them buys as much
  // of the box as it has addresses. The global bucket is what bounds the sum. docs/JOB-BUS.md 10.6.
  // /v1/nope is used on purpose: the buckets are counted before the route is resolved, so this
  // spends the minute's allowance without 600 round trips to the gateway.
  const relay = await startRelay({
    env: { TITAN_JOB_TOKEN: JOB_TOKEN, SAND_UI_TRUSTED_PROXIES: "127.0.0.1/32" },
  });
  try {
    const call = (index) => fetch(`${relay.base}/v1/nope`, {
      headers: { ...bearer(JOB_TOKEN), "x-forwarded-for": `10.0.${Math.floor(index / 250)}.${index % 250}` },
    });
    for (let batch = 0; batch < 10; batch += 1) {
      const answers = await Promise.all(Array.from({ length: 60 }, (_, i) => call(batch * 60 + i)));
      for (const answer of answers) assert.equal(answer.status, 404, `batch ${batch}`);
    }
    // 600 distinct addresses, none of them near its own 120, and the 601st is still refused.
    const limited = await call(600);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.deepEqual(relay.gateway.seen, [], "none of this reaches the gateway");
  } finally { relay.stop(); }
});

test("the create call carries type, key, policy and submitter, and the header key wins", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    relay.gateway.answerWith((command, args) => ({ status: 200, body: { created: true, job: { id: "job_1", type: args.type, status: "queued", created_at: "2026-09-05T00:00:00.000Z", idempotency_key: args.idempotency_key, payload: args.payload, worker: { agentId: "a1" } } } }));
    const response = await postJob(relay, {
      type: "nextgen.chapter", idempotency_key: "from-body",
      payload: { course_slug: "c05", chapter: 2 }, policy: { require_attestation: true }, callback_url: null,
    }, { "idempotency-key": "from-header" });
    assert.equal(response.status, 201);
    const sent = relay.gateway.seen.at(-1);
    assert.equal(sent.command, "jobBusCreate");
    assert.equal(sent.args.idempotency_key, "from-header");
    assert.equal(sent.args.type, "nextgen.chapter");
    assert.equal(sent.args.submitter, "cos");
    assert.deepEqual(sent.args.payload, { course_slug: "c05", chapter: 2 });
    assert.deepEqual(sent.args.policy, { require_attestation: true });
    // Who presented a token and from where, both read off the request. docs/JOB-BUS.md 10.5.
    assert.match(sent.args.client, /^(::ffff:)?127\.0\.0\.1$|^::1$/);
    assert.equal(sent.args.submitter_id, createHash("sha256").update(JOB_TOKEN, "utf8").digest("hex").slice(0, 8));
    assert.match(sent.args.submitter_id, /^[0-9a-f]{8}$/);
    // Four fields, and no more: the payload and the worker's agent ids are not echoed back to
    // whoever posted the job. docs/JOB-BUS.md 10.6.
    assert.deepEqual(await response.json(),
      { id: "job_1", type: "nextgen.chapter", status: "queued", created_at: "2026-09-05T00:00:00.000Z" });

    // With no header the body's key is used.
    await postJob(relay, { type: "health.ping", idempotency_key: "from-body", payload: {} });
    assert.equal(relay.gateway.seen.at(-1).args.idempotency_key, "from-body");
  } finally { relay.stop(); }
});

test("an unknown field reaches the gateway, which is the only thing that can refuse it", async () => {
  // Section 10.1's "unknown field" refusal is the gateway's, and the gateway can only refuse a key
  // it was given. The relay used to rebuild the body field by field, so a body carrying `priority`
  // -- or any future policy-like flag -- was accepted 201 with the flag silently dropped, and the
  // caller believed it applied.
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    relay.gateway.answerWith(() => ({
      status: 400, body: { error: "invalid payload", detail: "unknown field priority" },
    }));
    const refused = await postJob(relay, {
      type: "health.ping", idempotency_key: "k1", payload: {}, priority: 9,
    });
    const sent = relay.gateway.seen.at(-1);
    assert.equal(sent.args.priority, 9, "the unknown field is forwarded, not dropped");
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: "invalid payload", detail: "unknown field priority" });

    // Forwarding the body whole must not let it name its own audit row: the relay's own fields win.
    relay.gateway.answerWith(() => ({ status: 200, body: { created: true, job: { id: "job_1", type: "health.ping", status: "queued", created_at: "2026-09-05T00:00:00.000Z" } } }));
    await postJob(relay, {
      type: "health.ping", idempotency_key: "k2", payload: {},
      submitter: "jason", submitter_id: "deadbeef", client: "10.0.0.1",
    });
    const forged = relay.gateway.seen.at(-1);
    assert.equal(forged.args.submitter, "cos");
    assert.equal(forged.args.submitter_id, createHash("sha256").update(JOB_TOKEN, "utf8").digest("hex").slice(0, 8));
    assert.match(forged.args.client, /^(::ffff:)?127\.0\.0\.1$|^::1$/);
  } finally { relay.stop(); }
});

test("created picks 201, an idempotent replay picks 200, and neither is guessed from a timestamp", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    const summary = { id: "job_1", type: "health.ping", status: "queued", created_at: "2026-09-05T00:00:00.000Z" };
    const job = { ...summary, payload: { note: "not for the create answer" }, events: [{ at: summary.created_at, status: "queued" }] };
    relay.gateway.answerWith(() => ({ status: 200, body: { created: true, job } }));
    const first = await postJob(relay, { type: "health.ping", idempotency_key: "ping-1", payload: {} });
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), summary);

    // Same job, an hour old, and still a 200 rather than a 201: only `created` decides.
    relay.gateway.answerWith(() => ({ status: 200, body: { created: false, job } }));
    const replay = await postJob(relay, { type: "health.ping", idempotency_key: "ping-1", payload: {} });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), summary);
  } finally { relay.stop(); }
});

test("a request the relay cannot shape is 400, and the gateway's own 400 passes through whole", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    assert.equal((await postJob(relay, "not json at all")).status, 400);
    assert.equal((await postJob(relay, { idempotency_key: "k" })).status, 400);
    assert.equal((await postJob(relay, { type: "health.ping", payload: {} })).status, 400);
    assert.deepEqual(relay.gateway.seen, [], "nothing shapeless reaches the gateway");

    // The allowlist, the payload rules and the secret sweep are the gateway's; its answer is what
    // CoS acts on, so the status and the body arrive unchanged.
    relay.gateway.answerWith(() => ({ status: 400, body: { error: "unknown job type", allowed: ["health.ping", "nextgen.chapter"] } }));
    const refused = await postJob(relay, { type: "shell", idempotency_key: "k1", payload: {} });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: "unknown job type", allowed: ["health.ping", "nextgen.chapter"] });

    relay.gateway.answerWith(() => ({ status: 409, body: { error: "already terminal" } }));
    const cancel = await fetch(`${relay.base}/v1/jobs/job_1/cancel`, { method: "POST", headers: bearer(JOB_TOKEN) });
    assert.equal(cancel.status, 409);
    assert.equal(relay.gateway.seen.at(-1).command, "jobBusCancel");
    assert.deepEqual(relay.gateway.seen.at(-1).args, { id: "job_1" });

    relay.gateway.answerWith(() => ({ status: 404, body: { error: "no such job" } }));
    const missing = await fetch(`${relay.base}/v1/jobs/job_9`, { headers: bearer(JOB_TOKEN) });
    assert.equal(missing.status, 404);
    assert.equal(relay.gateway.seen.at(-1).command, "jobBusGet");

    // The artifacts shape is the gateway's to build; the relay hands it back whole, github links
    // and all, rather than reshaping a body it does not own. docs/JOB-BUS.md 10.6.
    const shape = {
      id: "job_1", status: "done", pull_from: "github", repo: "webdevtodayjason/nextgen-training",
      branch: "main", commits: ["a".repeat(40)],
      artifacts: [{
        path: "notes/05/02-intro.md", bytes: 18000, sha256: "b".repeat(64),
        html_url: "https://github.com/webdevtodayjason/nextgen-training/blob/aaa/notes/05/02-intro.md",
        api_url: "https://api.github.com/repos/webdevtodayjason/nextgen-training/contents/notes/05/02-intro.md",
      }],
    };
    relay.gateway.answerWith(() => ({ status: 200, body: shape }));
    const artifacts = await fetch(`${relay.base}/v1/jobs/job_1/artifacts`, { headers: bearer(JOB_TOKEN) });
    assert.equal(artifacts.status, 200);
    assert.deepEqual(await artifacts.json(), shape);
    assert.equal(relay.gateway.seen.at(-1).command, "jobBusArtifacts");

    relay.gateway.answerWith(() => ({ status: 409, body: { error: "not done" } }));
    const early = await fetch(`${relay.base}/v1/jobs/job_1/artifacts`, { headers: bearer(JOB_TOKEN) });
    assert.equal(early.status, 409);
  } finally { relay.stop(); }
});

test("the job bearer opens nothing but /v1", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    const api = await fetch(`${relay.base}/api/listAgents`, {
      method: "POST", headers: { "content-type": "application/json", ...bearer(JOB_TOKEN) }, body: "{}",
    });
    assert.equal(api.status, 401);
    assert.equal(api.headers.get("x-relay-auth"), "required");

    const page = await fetch(`${relay.base}/`, { redirect: "manual", headers: { accept: "text/html", ...bearer(JOB_TOKEN) } });
    assert.equal(page.status, 302);
    assert.match(String(page.headers.get("location")), /^\/login/);
    assert.equal(page.headers.get("set-cookie"), null, "the job bearer must not mint a console session");

    const vnc = await fetch(`${relay.base}/vnc/1/vnc.html`, { headers: bearer(JOB_TOKEN) });
    assert.equal(vnc.status, 401);
    assert.equal(vnc.headers.get("x-relay-auth"), "required");
    // The desktop's own probe, which shells out on the box, refused the same way.
    const surface = await fetch(`${relay.base}/box/surface?app=browser`, { headers: bearer(JOB_TOKEN) });
    assert.equal(surface.status, 401);
    assert.equal(surface.headers.get("x-relay-auth"), "required");
    const status = await fetch(`${relay.base}/job-bus/status`, { headers: bearer(JOB_TOKEN) });
    assert.equal(status.status, 401);
    assert.deepEqual(relay.gateway.seen, []);
  } finally { relay.stop(); }
});

test("a console session opens the console but never /v1", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    const cookie = await signIn(relay);
    const console_ = await fetch(`${relay.base}/job-bus/status`, { headers: { cookie } });
    assert.equal(console_.status, 200);

    const v1 = await fetch(`${relay.base}/v1/health`, { headers: { cookie } });
    assert.equal(v1.status, 401);
    assert.equal(v1.headers.get("www-authenticate"), 'Bearer realm="titan-job-bus"');
  } finally { relay.stop(); }
});

test("the env token wins over the file, and the file works on its own", async () => {
  const fileToken = "f".repeat(48);
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    writeFileSync(relay.tokenFile, JSON.stringify({ token: fileToken }), { mode: 0o600 });
    assert.equal((await fetch(`${relay.base}/v1/health`, { headers: bearer(fileToken) })).status, 401);
    assert.equal((await fetch(`${relay.base}/v1/health`, { headers: bearer(JOB_TOKEN) })).status, 200);
  } finally { relay.stop(); }

  const fileOnly = await startRelay();
  try {
    // Written after the relay started: the file is read on every request, so a token generated in
    // the console works without a restart.
    writeFileSync(fileOnly.tokenFile, JSON.stringify({ token: fileToken }), { mode: 0o600 });
    assert.equal((await fetch(`${fileOnly.base}/v1/health`, { headers: bearer(fileToken) })).status, 200);
    assert.equal((await fetch(`${fileOnly.base}/v1/health`, { headers: bearer(JOB_TOKEN) })).status, 401);
  } finally { fileOnly.stop(); }
});

test("the console generates, sets and clears the token, and the bus follows immediately", async () => {
  const relay = await startRelay();
  try {
    const cookie = await signIn(relay);
    const json = (path_, init = {}) => fetch(`${relay.base}${path_}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

    const before = await (await json("/job-bus/status")).json();
    assert.equal(before.configured, false);
    assert.equal(before.source, null);
    assert.match(before.base_url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    const generated = await (await json("/job-bus/token/generate", { method: "POST" })).json();
    assert.match(generated.token, /^[0-9a-f]{48}$/);
    assert.equal(statSync(relay.tokenFile).mode & 0o777, 0o600);
    const after = await (await json("/job-bus/status")).json();
    assert.deepEqual([after.configured, after.source], [true, "file"]);
    assert.equal((await fetch(`${relay.base}/v1/health`, { headers: bearer(generated.token) })).status, 200);

    // A pasted token has to be long enough to be worth calling a bearer.
    assert.equal((await json("/job-bus/token", { method: "POST", body: JSON.stringify({ token: "short" }) })).status, 400);
    const pasted = "p".repeat(40);
    assert.equal((await json("/job-bus/token", { method: "POST", body: JSON.stringify({ token: pasted }) })).status, 200);
    assert.equal((await fetch(`${relay.base}/v1/health`, { headers: bearer(pasted) })).status, 200);
    assert.equal((await fetch(`${relay.base}/v1/health`, { headers: bearer(generated.token) })).status, 401);

    const cleared = await (await json("/job-bus/token/clear", { method: "POST" })).json();
    assert.equal(cleared.configured, false);
    assert.equal((await fetch(`${relay.base}/v1/health`, { headers: bearer(pasted) })).status, 401);
  } finally { relay.stop(); }
});

test("with TITAN_JOB_TOKEN in the environment the console refuses to write a file that would lose", async () => {
  const relay = await startRelay({ env: { TITAN_JOB_TOKEN: JOB_TOKEN } });
  try {
    const cookie = await signIn(relay);
    const json = (path_, init = {}) => fetch(`${relay.base}${path_}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

    const status = await (await json("/job-bus/status")).json();
    assert.deepEqual([status.configured, status.source], [true, "env"]);
    assert.equal((await json("/job-bus/token", { method: "POST", body: JSON.stringify({ token: "q".repeat(40) }) })).status, 409);
    assert.equal((await json("/job-bus/token/generate", { method: "POST" })).status, 409);
    assert.throws(() => statSync(relay.tokenFile), "no file may be written when the env wins");
  } finally { relay.stop(); }
});
