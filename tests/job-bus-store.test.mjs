// JOBBUS. The Titan Job Bus store (docs/JOB-BUS.md sections 3, 4, 5 and the first gate in 9):
// the allowlist, idempotency, payload validation, the secret detector, the status machine, the
// append-only audit, and the 500-terminal-job cap on jobs.json.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-store-"));
  const output = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const storeModule = await loadModule("source/host/extensions/job-bus/job-store.ts");
const { createJobStore, findPayloadSecret, newJobId, validateJobPayload, TERMINAL_JOB_CAP } = storeModule.module;

async function withStore(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-root-"));
  const emitted = [];
  let clock = 1_760_000_000_000;
  let counter = 0;
  const store = createJobStore({
    rootDir: root,
    now: () => (clock += 1_000),
    randomHex: (bytes) => String(counter += 1).padStart(bytes * 2, "0"),
    emit: (event) => emitted.push(event),
    ...options,
  });
  try { await run({ store, root, emitted }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function auditRows(root) {
  const raw = await readFile(path.join(root, "job-bus", "audit.jsonl"), "utf8");
  return raw.trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

const chapterPayload = { course_slug: "c05", chapter: 2, repo: "webdevtodayjason/nextgen", branch: "main" };

test("only the allowlist is accepted, and the refusal names what is", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.create({ type: "shell", idempotency_key: "k1", payload: {} }),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.body.error, "unknown job type");
        assert.deepEqual(error.body.allowed, ["health.ping", "nextgen.chapter"]);
        return true;
      },
    );
  });
});

test("a create with no idempotency key is refused", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.create({ type: "health.ping", payload: {} }),
      (error) => error.status === 400 && error.body.error === "idempotency key is required",
    );
  });
});

test("the same type and idempotency key give back the same job, not a second one", async () => {
  await withStore(async ({ store }) => {
    const first = await store.create({ type: "health.ping", idempotency_key: "health-1", payload: {}, submitter: "cos" });
    const second = await store.create({ type: "health.ping", idempotency_key: "health-1", payload: {}, submitter: "cos" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.equal((await store.snapshot()).length, 1);
  });
});

test("a job id is job_ plus base36 time plus twelve hex", async () => {
  assert.match(newJobId(1_760_000_000_000, (bytes) => "a".repeat(bytes * 2)), /^job_[0-9a-z]+[0-9a-f]{12}$/);
  assert.equal(newJobId(1_760_000_000_000, (bytes) => "a".repeat(bytes * 2)).endsWith("aaaaaaaaaaaa"), true);
});

test("a secret-looking key or value is refused before the payload is even validated", async () => {
  assert.equal(findPayloadSecret({ api_key: "x" }), "payload.api_key");
  assert.equal(findPayloadSecret({ nested: { authorization: "x" } }), "payload.nested.authorization");
  assert.equal(findPayloadSecret({ note: "ghp_abcdefghijklmnop" }), "payload.note");
  assert.equal(findPayloadSecret({ note: "AKIAIOSFODNN7EXAMPLE" }), "payload.note");
  assert.equal(findPayloadSecret({ list: ["ok", "xoxb-1-2"] }), "payload.list[1]");
  assert.equal(findPayloadSecret({ course_slug: "c05" }), null);
  await withStore(async ({ store }) => {
    await assert.rejects(
      // Invalid payload AND a secret: the secret wins, so the refusal never quotes the value back.
      store.create({ type: "nextgen.chapter", idempotency_key: "k1", payload: { github_token: "ghp_x" } }),
      (error) => error.status === 400 && error.body.error === "secrets are not accepted in job payloads",
    );
  });
});

test("nextgen.chapter validates its payload and defaults rules_ref", async () => {
  assert.equal(validateJobPayload("nextgen.chapter", { ...chapterPayload, chapter: 0 }).detail, "chapter must be a positive integer");
  assert.equal(validateJobPayload("nextgen.chapter", { ...chapterPayload, chapter: 1.5 }).detail, "chapter must be a positive integer");
  assert.equal(validateJobPayload("nextgen.chapter", { ...chapterPayload, repo: "nextgen" }).detail, "repo must be owner/name");
  assert.equal(validateJobPayload("nextgen.chapter", { ...chapterPayload, branch: " " }).detail, "branch must be a non-empty string");
  assert.equal(validateJobPayload("nextgen.chapter", { ...chapterPayload, course_slug: "" }).detail, "course_slug must be a non-empty string");
  const good = validateJobPayload("nextgen.chapter", chapterPayload);
  assert.equal(good.ok, true);
  assert.equal(good.payload.rules_ref, "EXTERNAL-BOT-HANDOFF.md");
  // health.ping takes no payload at all.
  assert.deepEqual(validateJobPayload("health.ping", { anything: 1 }).payload, {});

  await withStore(async ({ store }) => {
    await assert.rejects(
      store.create({ type: "nextgen.chapter", idempotency_key: "k1", payload: { ...chapterPayload, chapter: -1 } }),
      (error) => error.status === 400 && error.body.error === "invalid payload" && error.body.detail === "chapter must be a positive integer",
    );
  });
});

test("policy defaults to the three the contract prints, and an explicit false is kept", async () => {
  await withStore(async ({ store }) => {
    const plain = await store.create({ type: "nextgen.chapter", idempotency_key: "k1", payload: chapterPayload });
    assert.deepEqual(plain.job.policy, { no_final_assessment: true, no_placeholder: true, require_attestation: true });
    const relaxed = await store.create({
      type: "nextgen.chapter", idempotency_key: "k2", payload: chapterPayload, policy: { require_attestation: false },
    });
    assert.equal(relaxed.job.policy.require_attestation, false);
  });
});

test("the status machine allows the contract's edges and refuses the rest", async () => {
  await withStore(async ({ store }) => {
    const { job } = await store.create({ type: "nextgen.chapter", idempotency_key: "k1", payload: chapterPayload, submitter: "cos" });
    await store.transition(job.id, "running", { worker: { agentId: "a1", agentName: "Scribe", baseline: 0 } });
    assert.equal((await store.get(job.id)).started_at != null, true);
    await store.transition(job.id, "done", { result: null });
    // Terminal states refuse, with the 409 the contract names.
    await assert.rejects(store.cancel(job.id), (error) => error.status === 409 && error.body.status === "done");
    // A queued job cancels, and so does one waiting on a human.
    const queued = await store.create({ type: "nextgen.chapter", idempotency_key: "k2", payload: chapterPayload });
    assert.equal((await store.cancel(queued.job.id)).job.status, "cancelled");
    const blocked = await store.create({ type: "nextgen.chapter", idempotency_key: "k3", payload: chapterPayload });
    await store.transition(blocked.job.id, "needs_human", { needs_human: { reason: "github_auth", detail: "log in" } });
    assert.equal((await store.cancel(blocked.job.id)).job.status, "cancelled");
    // An unknown id is a 404, never a 500.
    await assert.rejects(store.cancel("job_nope"), (error) => error.status === 404 && error.body.error === "job not found");
  });
});

test("every transition appends one audit row and emits one job-bus event", async () => {
  await withStore(async ({ store, root, emitted }) => {
    const { job } = await store.create({ type: "health.ping", idempotency_key: "health-1", payload: {}, submitter: "cos" });
    await store.transition(job.id, "running", { worker: { agentId: "a1", agentName: "Scribe", baseline: 3 } });
    await store.transition(job.id, "failed", { error: "timed out", receipts: ["shell:e1"], unsupported_claims: ["summary"] });

    const rows = await auditRows(root);
    assert.deepEqual(rows.map((row) => row.event), ["queued", "running", "failed"]);
    for (const row of rows) {
      assert.equal(row.jobId, job.id);
      assert.equal(row.type, "health.ping");
      assert.equal(row.submitter, "cos");
      assert.equal(row.policy_version, "v1");
      assert.equal(typeof row.at, "string");
      assert.equal(typeof row.eventId, "string");
      assert.equal("ok" in row, true);
    }
    assert.equal(rows[1].worker, "Scribe");
    assert.equal(rows[0].ok, true);
    assert.equal(rows[2].ok, false);
    assert.deepEqual(rows[2].receipts, ["shell:e1"]);
    assert.deepEqual(rows[2].unsupported_claims, ["summary"]);
    // Receipts are only carried where a transition had them.
    assert.equal("receipts" in rows[1], false);

    assert.deepEqual(emitted, [
      { type: "job-bus", jobId: job.id, status: "queued" },
      { type: "job-bus", jobId: job.id, status: "running" },
      { type: "job-bus", jobId: job.id, status: "failed" },
    ]);
    // The audit is append-only: a refused transition writes nothing.
    await assert.rejects(store.transition(job.id, "done", {}));
    assert.equal((await auditRows(root)).length, 3);
  });
});

test("jobs.json keeps the newest 500 terminal jobs and never drops a live one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-cap-"));
  try {
    const seeded = [];
    for (let index = 0; index < TERMINAL_JOB_CAP + 5; index += 1) {
      seeded.push({
        id: `job_terminal_${index}`, type: "health.ping", status: "done", idempotency_key: `t${index}`,
        payload: {}, policy: {}, callback_url: null, submitter: "cos",
        created_at: "2026-09-05T00:00:00.000Z", updated_at: "2026-09-05T00:00:00.000Z",
        started_at: null, finished_at: null, worker: null, events: [], result: null, error: null, needs_human: null,
      });
    }
    seeded.push({ ...seeded[0], id: "job_live", status: "queued", idempotency_key: "live" });
    await mkdir(path.join(root, "job-bus"), { recursive: true });
    await writeFile(path.join(root, "job-bus", "jobs.json"), JSON.stringify({ jobs: seeded }));

    const store = createJobStore({ rootDir: root });
    // Any write re-applies the cap.
    await store.create({ type: "health.ping", idempotency_key: "fresh", payload: {} });
    const kept = await store.snapshot();
    const terminal = kept.filter((job) => job.status === "done");
    assert.equal(terminal.length, TERMINAL_JOB_CAP);
    // The oldest five aged out; the newest terminal job and both live jobs stayed.
    assert.equal(terminal.some((job) => job.id === "job_terminal_0"), false);
    assert.equal(terminal.some((job) => job.id === `job_terminal_${TERMINAL_JOB_CAP + 4}`), true);
    assert.equal(kept.some((job) => job.id === "job_live"), true);
    assert.equal(kept.filter((job) => job.status === "queued").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the store survives a restart, and list answers newest first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-job-bus-reload-"));
  try {
    const first = createJobStore({ rootDir: root });
    const one = await first.create({ type: "health.ping", idempotency_key: "k1", payload: {} });
    const two = await first.create({ type: "nextgen.chapter", idempotency_key: "k2", payload: chapterPayload });
    const reopened = createJobStore({ rootDir: root });
    const listed = await reopened.list();
    assert.deepEqual(listed.map((job) => job.id), [two.job.id, one.job.id]);
    assert.equal((await reopened.list(1)).length, 1);
    assert.equal(await reopened.queueDepth(), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.after(async () => { await storeModule.dispose(); });
